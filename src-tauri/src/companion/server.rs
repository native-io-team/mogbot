//! The companion's HTTP server: `POST /v1/pair`, the WebSocket at `/v1/ws`,
//! and files (`PUT /v1/blobs`, `GET /v1/blobs/:id`,
//! `GET /v1/agents/:id/attachments/*`), which stay off the socket so a 25 MB
//! upload never holds up a message.
//!
//! It binds loopback only. In P1 the one way in from the phone is
//! `tailscale serve`, which terminates TLS with the tailnet's own
//! certificate and proxies here; nothing listens on a public interface.
//!
//! On a socket the Mac proves itself first: the phone's first frame is a
//! challenge with no secret in it, the Mac answers with its signed identity
//! and the hosts it serves on (`identity.rs`), and only then does the phone
//! send its device token (`hello.token`), never in a URL. The token is
//! re-checked on every frame after it, so revoking a phone on the Mac closes
//! its sockets at once.

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::hub::{Drafts, HubItem, Resume};
use super::limits;
use super::pairing::{self, Claim, Decision};
use super::router::{self, Caller};
use super::wire::{
    self, ClientFrame, Event, IdentityRequest, IdentityResponse, Negotiation, PairRefusal,
    PairRequest, PairResponse, RefusedReason, ResumeMode, RouteKind, ServerFrame, ServerInfo,
    WireError,
};
use super::{actor_for, now_ms, Auth, Companion, DeviceRecord};

pub(crate) type Body = BoxBody<Bytes, hyper::Error>;

/// The largest frame either way, and the largest pair request.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_PAIR_BODY: usize = 16 * 1024;
/// The whole pair request body must arrive this quickly.
pub const PAIR_BODY_TIMEOUT: Duration = Duration::from_secs(10);
/// The phone must say hello this quickly after the upgrade.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Headers must arrive this quickly, on every request of a connection.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// The Mac's heartbeat (`HEARTBEAT_MS` in frames.ts).
pub const HEARTBEAT: Duration = Duration::from_secs(15);
const DRAFT_TICK: Duration = Duration::from_millis(50);

/// Serve until `shutdown` fires. Connections pass the [`limits::Gate`]:
/// at most [`limits::MAX_CONNECTIONS`] open, of which only
/// [`limits::MAX_UNAUTHENTICATED`] may be strangers (the oldest is evicted to
/// make room, a socket that authenticated never is). Each gets a 10 s header
/// timeout, and the failed-connection counts are written once a minute.
pub async fn serve(c: Arc<Companion>, listener: TcpListener, mut shutdown: oneshot::Receiver<()>) {
    let gate = Arc::new(limits::Gate::default());
    let mut flush = tokio::time::interval(Duration::from_secs(60));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let Some(ticket) = gate.admit() else {
                    tracing::debug!("[Companion] at the connection cap; closing one from {}", peer);
                    drop(stream);
                    continue;
                };
                let c = c.clone();
                // Shared with an upgraded socket, which outlives the HTTP
                // connection future: the place is free only when both are done.
                let ticket = Arc::new(ticket);
                tokio::spawn(async move {
                    let held = ticket.clone();
                    let service = service_fn(move |req| {
                        let (c, held) = (c.clone(), held.clone());
                        async move { Ok::<_, hyper::Error>(handle(c, req, Some(peer), Some(held)).await) }
                    });
                    let conn = http1::Builder::new()
                        .timer(hyper_util::rt::TokioTimer::new())
                        .header_read_timeout(HEADER_TIMEOUT)
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades();
                    tokio::select! {
                        done = conn => if let Err(e) = done {
                            tracing::debug!("[Companion] connection error: {}", e);
                        },
                        _ = ticket.evicted() => tracing::debug!("[Companion] evicted a connection that never authenticated"),
                    }
                    drop(ticket);
                });
            }
            _ = flush.tick() => c.flush_refusals(),
            _ = &mut shutdown => break,
        }
    }
}

pub(crate) fn body(data: impl Into<Bytes>) -> Body {
    Full::new(data.into())
        .map_err(|never| match never {})
        .boxed()
}

pub(crate) fn status_only(status: StatusCode) -> Response<Body> {
    let mut res = Response::new(body(Bytes::new()));
    *res.status_mut() = status;
    res
}

pub(crate) fn json_response(value: &impl serde::Serialize) -> Response<Body> {
    let mut res = Response::new(body(serde_json::to_vec(value).unwrap_or_default()));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    res
}

/// Where a request came from, as far as the server can tell.
#[derive(Default)]
pub struct Peer {
    /// `limits::source_of`: the per-source key.
    pub source: String,
    /// `Tailscale-User-Login`, when `tailscale serve` set it.
    pub login: Option<String>,
    /// The connection's place at the [`limits::Gate`], held by an upgraded
    /// socket for as long as it is open.
    pub conn: Option<Arc<limits::Ticket>>,
    /// A socket's place under [`limits::MAX_PREHELLO_PER_SOURCE`], given back
    /// once its `hello` checks out.
    pub prehello: Option<limits::Slot>,
}

impl Peer {
    /// It proved who it is: its gate place is safe from eviction.
    fn authenticated(&self) {
        if let Some(t) = &self.conn {
            t.authenticated();
        }
    }

    /// Resolves if the gate evicts this connection (never, without one).
    async fn evicted(&self) {
        match &self.conn {
            Some(t) => t.evicted().await,
            None => std::future::pending().await,
        }
    }
}

async fn handle(
    c: Arc<Companion>,
    req: Request<Incoming>,
    addr: Option<std::net::SocketAddr>,
    conn: Option<Arc<limits::Ticket>>,
) -> Response<Body> {
    // A web page can reach a loopback port too: refuse anything a browser
    // sent (an Origin that isn't this server) and any Host that isn't the
    // tailnet name or loopback (DNS rebinding), before anything else.
    if !limits::host_allowed(req.headers()) || !limits::origin_allowed(req.headers()) {
        return status_only(StatusCode::FORBIDDEN);
    }
    let mut peer = Peer {
        source: limits::source_of(addr, req.headers()),
        login: limits::tailnet_login(req.headers()),
        conn,
        prehello: None,
    };
    let Some(slot) = c.sources.try_take(&peer.source, limits::MAX_PER_SOURCE) else {
        return status_only(StatusCode::TOO_MANY_REQUESTS);
    };
    let path = req.uri().path().to_string();
    match (req.method(), path.as_str()) {
        (&Method::POST, "/v1/identity") => identity(c, req).await,
        (&Method::POST, "/v1/pair") => pair(c, req, &peer).await,
        (&Method::GET, "/v1/ws") => {
            // Strangers' sockets are cheap to open and held for the hello
            // timeout: a few per source, so one can't hold them all.
            let Some(prehello) = c
                .prehello
                .try_take(&peer.source, limits::MAX_PREHELLO_PER_SOURCE)
            else {
                return status_only(StatusCode::TOO_MANY_REQUESTS);
            };
            peer.prehello = Some(prehello);
            upgrade(c, req, peer, slot)
        }
        (&Method::PUT, "/v1/blobs") => super::files::upload(c, req).await,
        (&Method::GET | &Method::HEAD, p)
            if p.starts_with("/v1/blobs/") || p.starts_with("/v1/agents/") =>
        {
            super::files::download(c, req).await
        }
        // Anything else, including a wrong path: a bare 404 says nothing.
        _ => status_only(StatusCode::NOT_FOUND),
    }
}

// ============================================================================
// Pairing
// ============================================================================

/// A small JSON body, or the response that says why not. JSON only: a
/// browser can POST `text/plain` anywhere without asking, but not
/// `application/json`.
async fn json_body<T: serde::de::DeserializeOwned>(
    req: Request<Incoming>,
) -> Result<T, Response<Body>> {
    let json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Err(status_only(StatusCode::UNSUPPORTED_MEDIA_TYPE));
    }
    let read = Limited::new(req.into_body(), MAX_PAIR_BODY).collect();
    let collected = match tokio::time::timeout(PAIR_BODY_TIMEOUT, read).await {
        Err(_) => return Err(status_only(StatusCode::REQUEST_TIMEOUT)),
        Ok(Err(_)) => return Err(status_only(StatusCode::PAYLOAD_TOO_LARGE)),
        Ok(Ok(collected)) => collected,
    };
    serde_json::from_slice::<T>(&collected.to_bytes())
        .map_err(|_| status_only(StatusCode::BAD_REQUEST))
}

/// The hosts this Mac serves itself on, as it signs them.
fn serve_hosts(c: &Companion) -> Vec<String> {
    c.backend.serve_hosts()
}

const KEY_UNAVAILABLE: &str = "Your Mac can't read its identity key from the Keychain right now. Unlock your Mac, then try again.";

/// `POST /v1/identity`: who this Mac is, signed over the phone's challenge,
/// before the phone sends a pairing code.
async fn identity(c: Arc<Companion>, req: Request<Incoming>) -> Response<Body> {
    let request = match json_body::<IdentityRequest>(req).await {
        Ok(r) => r,
        Err(res) => return res,
    };
    let refused = |reason, message: String| {
        json_response(&IdentityResponse::Refused {
            ok: false,
            reason,
            message,
        })
    };
    let protocol = match wire::negotiate(request.protocol, wire::SUPPORTED) {
        Negotiation::Ok(v) => v,
        Negotiation::UpdateApp => {
            return refused(
                RefusedReason::UpdateApp,
                "Update this app to pair with this Mac.".into(),
            )
        }
        Negotiation::UpdateMac => {
            return refused(
                RefusedReason::UpdateMac,
                format!(
                    "Update {} on {} to pair.",
                    crate::brand::NAME,
                    c.backend.server_name()
                ),
            )
        }
    };
    let Some(key) = c.registry.identity() else {
        return refused(RefusedReason::Unavailable, KEY_UNAVAILABLE.into());
    };
    let server_id = c.registry.server_id();
    let hosts = serve_hosts(&c);
    let Some(proof) = key.prove_mac(&request.challenge, &server_id, &hosts) else {
        return status_only(StatusCode::BAD_REQUEST);
    };
    // A phone asks this just before it sends the code: the panel can say a
    // device got through, once per code (`note_reached`).
    if c.pairing.note_reached(now_ms()) {
        c.backend.changed();
    }
    json_response(&IdentityResponse::Proven {
        ok: true,
        protocol,
        server_id,
        hosts,
        identity: proof,
    })
}

async fn pair(c: Arc<Companion>, req: Request<Incoming>, peer: &Peer) -> Response<Body> {
    let request = match json_body::<PairRequest>(req).await {
        Ok(r) => r,
        Err(res) => return res,
    };
    // Versions first: an out-of-date app learns that, and the code survives
    // to be used once it has updated.
    match wire::negotiate(request.protocol, wire::SUPPORTED) {
        Negotiation::Ok(_) => {}
        Negotiation::UpdateApp => {
            return json_response(&PairResponse::refused(
                PairRefusal::UpdateApp,
                "Update this app to pair with this Mac.",
            ))
        }
        Negotiation::UpdateMac => {
            return json_response(&PairResponse::refused(
                PairRefusal::UpdateMac,
                format!(
                    "Update {} on {} to pair.",
                    crate::brand::NAME,
                    c.backend.server_name()
                ),
            ))
        }
    }
    // Nothing to sign, or a key that won't survive a restart: refuse before
    // the code is used, so it still works once that's sorted.
    if !request
        .challenge
        .as_deref()
        .is_some_and(super::identity::is_usable_challenge)
    {
        return status_only(StatusCode::BAD_REQUEST);
    }
    if !c.registry.identity_is_durable() {
        return json_response(&PairResponse::refused(
            PairRefusal::Denied,
            "This Mac can't keep its identity key in the Keychain, so it can't pair a phone safely. Check Keychain Access on the Mac.",
        ));
    }
    let device = super::clean_pair_device(&request.device);
    let actor = actor_for(&device.name);
    let rx = match c.pairing.claim(
        &request.code,
        device.clone(),
        request.public_key.clone(),
        &peer.source,
        peer.login.clone(),
        now_ms(),
    ) {
        Claim::NoMatch => {
            tokio::time::sleep(pairing::WRONG_CODE_DELAY).await;
            return status_only(StatusCode::NOT_FOUND);
        }
        Claim::Expired => {
            return json_response(&PairResponse::refused(
                PairRefusal::Expired,
                "That code expired. Show a new one on the Mac.",
            ))
        }
        Claim::Used => {
            return json_response(&PairResponse::refused(
                PairRefusal::Used,
                "That code was already used. Show a new one on the Mac.",
            ))
        }
        Claim::Waiting(rx) => rx,
    };
    // It knew a live code: no flood of strangers evicts it while the desk decides.
    peer.authenticated();
    c.backend
        .audit(&actor, "pair_request", device_line(&device), true);
    c.backend.changed();

    let decision = tokio::time::timeout(pairing::DECISION_TIMEOUT, rx).await;
    let response = match decision {
        Ok(Ok(Decision::Allow { replace })) => match c.registry.add(
            &device,
            request.public_key,
            now_ms() as i64,
            &replace,
            peer.login.clone(),
        ) {
            Ok((record, token, replaced)) => {
                for id in replaced {
                    // Revoked as the desk asked: its files and push go too.
                    c.blobs.forget_device(&id);
                    c.hub.signal(HubItem::Revoked { device_id: id });
                }
                let server_id = c.registry.server_id();
                let hosts = serve_hosts(&c);
                let proof = c.registry.identity().and_then(|k| {
                    k.prove_pair(request.challenge.as_deref(), &server_id, &hosts, &record.id)
                });
                match proof {
                    Some(identity) => {
                        c.backend
                            .audit(&actor, "paired", device_line(&device), true);
                        PairResponse::Allowed {
                            ok: true,
                            device_id: record.id,
                            token,
                            server_id,
                            server_public_key: String::new(),
                            hosts,
                            identity,
                        }
                    }
                    // The key went away in between: an answer the phone
                    // can't check is no pairing, so the device goes too.
                    None => {
                        let _ = c.registry.revoke(&record.id);
                        PairResponse::refused(PairRefusal::Denied, KEY_UNAVAILABLE)
                    }
                }
            }
            Err(e) => {
                tracing::error!("[Companion] Could not save a paired device: {}", e);
                PairResponse::refused(
                    PairRefusal::Denied,
                    "The Mac couldn't save this phone. Try again.",
                )
            }
        },
        Ok(_) => {
            c.backend
                .audit(&actor, "pair_denied", device_line(&device), false);
            PairResponse::refused(PairRefusal::Denied, "The Mac said no.")
        }
        Err(_) => {
            c.pairing.abandon();
            c.backend
                .audit(&actor, "pair_timeout", device_line(&device), false);
            PairResponse::refused(
                PairRefusal::Timeout,
                "Nobody answered on the Mac. Try again from the Mac.",
            )
        }
    };
    c.pairing.abandon();
    c.backend.changed();
    json_response(&response)
}

fn device_line(d: &wire::PairDevice) -> String {
    let model = d.model.as_deref().unwrap_or("unknown model");
    format!("{model}, app {}", d.app_version)
}

// ============================================================================
// The WebSocket
// ============================================================================

fn upgrade(
    c: Arc<Companion>,
    mut req: Request<Incoming>,
    peer: Peer,
    slot: limits::Slot,
) -> Response<Body> {
    let headers = req.headers();
    let is_ws = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY).cloned() else {
        return status_only(StatusCode::BAD_REQUEST);
    };
    if !is_ws {
        return status_only(StatusCode::BAD_REQUEST);
    }
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    let on_upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                let config = WebSocketConfig {
                    max_message_size: Some(MAX_FRAME_BYTES),
                    max_frame_size: Some(MAX_FRAME_BYTES),
                    ..Default::default()
                };
                let ws = WebSocketStream::from_raw_socket(
                    TokioIo::new(upgraded),
                    Role::Server,
                    Some(config),
                )
                .await;
                serve_socket_as(c, ws, peer).await;
                // The socket counted against its source while it was open.
                drop(slot);
            }
            Err(e) => tracing::debug!("[Companion] upgrade failed: {}", e),
        }
    });
    let mut res = status_only(StatusCode::SWITCHING_PROTOCOLS);
    let h = res.headers_mut();
    h.insert(
        header::UPGRADE,
        header::HeaderValue::from_static("websocket"),
    );
    h.insert(
        header::CONNECTION,
        header::HeaderValue::from_static("Upgrade"),
    );
    if let Ok(v) = header::HeaderValue::from_str(&accept) {
        h.insert(header::SEC_WEBSOCKET_ACCEPT, v);
    }
    res
}

/// [`router::dispatch`], with a panic answered as an error: a request whose
/// handler panicked used to get no answer at all, and the phone waited on it.
pub(crate) async fn dispatch_caught(
    c: &Companion,
    caller: &Caller,
    method: &str,
    params: Value,
) -> Result<Value, WireError> {
    caught(method, router::dispatch(c, caller, method, params)).await
}

/// The longest a phone request is worked on before it is answered as busy.
/// Under the phone's own 30 s (`transport.ts`), so it hears why rather than
/// timing out on a silent socket.
pub(crate) const REQUEST_DEADLINE: Duration = Duration::from_secs(20);

/// What the phone shows when its Mac couldn't answer in time.
pub(crate) const BUSY: &str =
    "Your Mac is busy and couldn't answer that in time. Try again in a moment.";

/// A request's answer within [`REQUEST_DEADLINE`], or an error saying the
/// Mac is busy. Handlers call the agents store and the disk synchronously,
/// so the work runs on the blocking pool: one stuck on a lock or a slow
/// disk holds a thread of its own, never one of the few async workers every
/// socket (and every other request) needs to be answered at all.
pub(crate) async fn dispatch_bounded(
    c: Arc<Companion>,
    caller: Caller,
    method: String,
    params: Value,
) -> Result<Value, WireError> {
    let name = method.clone();
    bounded(&name, REQUEST_DEADLINE, async move {
        dispatch_caught(&c, &caller, &method, params).await
    })
    .await
}

/// Run `answer` off the async workers and give up waiting on it after
/// `deadline`. Past the deadline it carries on (a send the phone retries by
/// clientId is better done once than cut in half) and its answer is
/// dropped; if the caller itself is dropped (a revoke aborts the socket's
/// requests) it stops at its next await, as it did on the async workers.
pub(crate) async fn bounded<T>(
    method: &str,
    deadline: Duration,
    answer: impl std::future::Future<Output = Result<T, WireError>> + Send + 'static,
) -> Result<T, WireError>
where
    T: Send + 'static,
{
    bounded_in(&IN_FLIGHT, method, deadline, answer).await
}

/// How many phone requests may hold a blocking thread at once, across
/// every socket, counting ones past their deadline that are still running.
/// Past it a request is answered as busy at once: a paired device sending
/// request after request that sticks (on a lock, a slow disk) would
/// otherwise take every thread of the blocking pool the whole app shares,
/// one per request, and keep them past its deadline.
pub(crate) const MAX_IN_FLIGHT: usize = 48;

static IN_FLIGHT: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT)));

/// [`bounded`], against `slots`: a slot is held until the work itself ends.
pub(crate) async fn bounded_in<T>(
    slots: &Arc<tokio::sync::Semaphore>,
    method: &str,
    deadline: Duration,
    answer: impl std::future::Future<Output = Result<T, WireError>> + Send + 'static,
) -> Result<T, WireError>
where
    T: Send + 'static,
{
    let Ok(slot) = slots.clone().try_acquire_owned() else {
        tracing::warn!("[Companion] {method} refused: {MAX_IN_FLIGHT} requests already running");
        return Err(WireError::Command(crate::errors::CommandError::expected(
            BUSY,
        )));
    };
    /// Sends "stop" when dropped while armed.
    struct Abort(Option<oneshot::Sender<()>>);
    impl Drop for Abort {
        fn drop(&mut self) {
            if let Some(stop) = self.0.take() {
                let _ = stop.send(());
            }
        }
    }
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let mut abort = Abort(Some(stop_tx));
    let handle = tokio::runtime::Handle::current();
    let work = tokio::task::spawn_blocking(move || {
        // Given back when this thread is done, deadline or not.
        let _slot = slot;
        handle.block_on(async move {
            tokio::pin!(answer);
            tokio::select! {
                done = &mut answer => Some(done),
                stop = stop_rx => match stop {
                    Ok(()) => None,
                    // No one is waiting any more: finish anyway.
                    Err(_) => Some(answer.await),
                },
            }
        })
    });
    let waited = tokio::time::timeout(deadline, work).await;
    // Answered or timed out: never "stop" it from here.
    drop(abort.0.take());
    match waited {
        Ok(Ok(Some(answer))) => answer,
        // Stopped only when this was dropped, so never seen here.
        Ok(Ok(None)) => Err(WireError::Command(crate::errors::CommandError::expected(
            "This Mac stopped answering that.",
        ))),
        Ok(Err(e)) => {
            tracing::error!("[Companion] {method} didn't finish: {e}");
            Err(WireError::Command(crate::errors::CommandError::expected(
                "This Mac hit a fault answering that. Try again.",
            )))
        }
        Err(_) => {
            tracing::error!(
                "[Companion] {method} took longer than {:?}; answered as busy",
                deadline
            );
            Err(WireError::Command(crate::errors::CommandError::expected(
                BUSY,
            )))
        }
    }
}

/// The longest each part of a connect-time snapshot (overview, Mac status,
/// projects) is waited on. The parts run side by side, so the snapshot is
/// sent within this; the phone answers no ping meanwhile, and a socket that
/// says nothing past its probe is taken as gone.
pub(crate) const SNAPSHOT_DEADLINE: Duration = Duration::from_secs(6);

/// The state a phone that can't replay starts from, each part within
/// `deadline`. A part that's slow (the agents list busy, a probe that hangs)
/// degrades the snapshot rather than silencing the socket: the overview and
/// projects go as `null`, which the phone reads as "keep what you have", and
/// the status as the last one this Mac sent, else one that says only what
/// is known without asking. A status worked out late is still published as
/// `system.status`, so the phone is told when it's ready.
pub(crate) async fn snapshot(
    c: &Arc<Companion>,
    cursor: wire::Cursor,
    deadline: Duration,
) -> Event {
    let overview = {
        let c = c.clone();
        bounded("sync.snapshot overview", deadline, async move {
            c.backend.overview().await.map_err(WireError::Command)
        })
    };
    let projects = {
        let c = c.clone();
        bounded("sync.snapshot projects", deadline, async move {
            c.backend.projects().await.map_err(WireError::Command)
        })
    };
    let status = snapshot_status(c, deadline);
    let (overview, status, projects) = tokio::join!(overview, status, projects);
    let overview = overview.unwrap_or_else(|e| {
        tracing::warn!(
            "[Companion] snapshot sent without the overview: {}",
            e.summary()
        );
        Value::Null
    });
    let projects = match projects {
        Ok(list @ Value::Array(_)) => list,
        Ok(_) => Value::Null,
        Err(e) => {
            tracing::warn!(
                "[Companion] snapshot sent without projects: {}",
                e.summary()
            );
            Value::Null
        }
    };
    Event::Snapshot {
        cursor,
        overview,
        status,
        projects,
    }
}

/// The Mac status for a snapshot within `deadline`. Past it the work goes
/// on, and when it ends it is remembered and published like any change.
async fn snapshot_status(c: &Arc<Companion>, deadline: Duration) -> wire::MacStatus {
    let (tx, rx) = oneshot::channel::<wire::MacStatus>();
    let worker = c.clone();
    let handle = tokio::runtime::Handle::current();
    // On the blocking pool, as requests are: a probe that blocks its thread
    // holds one of its own, never an async worker.
    tokio::task::spawn_blocking(move || {
        handle.block_on(async move {
            let status = worker.backend.mac_status().await;
            if let Err(status) = tx.send(status) {
                // The snapshot went without it: tell the phones now.
                tracing::info!("[Companion] the late Mac status arrived; publishing it");
                if worker.remember_status(&status) {
                    worker.hub.publish(Event::System { status });
                }
            }
        })
    });
    match tokio::time::timeout(deadline, rx).await {
        Ok(Ok(status)) => {
            c.remember_status(&status);
            status
        }
        _ => {
            tracing::warn!(
                "[Companion] the Mac status took longer than {:?}; the snapshot carries the last one known",
                deadline
            );
            c.last_status().unwrap_or_else(|| wire::MacStatus {
                name: c.backend.server_name(),
                app_version: c.backend.app_version(),
                power: wire::PowerInfo {
                    keep_awake: false,
                    lid_closed_mode: wire::Known::Unknown,
                    on_battery: wire::Known::Unknown,
                    battery_percent: None,
                },
                claude: wire::ClaudeInfo {
                    installed: false,
                    signed_in: wire::Known::Unknown,
                    version: None,
                },
                routes: Vec::new(),
            })
        }
    }
}

/// A request's answer, or an error answer if working it out panicked.
pub(crate) async fn caught(
    method: &str,
    answer: impl std::future::Future<Output = Result<Value, WireError>>,
) -> Result<Value, WireError> {
    use futures_util::FutureExt;
    match std::panic::AssertUnwindSafe(answer).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            tracing::error!(
                "[Companion] {method} panicked: {}",
                crate::agents::survive::panic_text(payload.as_ref())
            );
            Err(WireError::Command(crate::errors::CommandError::expected(
                "This Mac hit a fault answering that. Try again.",
            )))
        }
    }
}

async fn send<S>(ws: &mut S, frame: &ServerFrame) -> bool
where
    S: SinkExt<Message> + Unpin,
{
    match serde_json::to_string(frame) {
        Ok(text) => ws.send(Message::Text(text)).await.is_ok(),
        Err(_) => false,
    }
}

async fn refuse<S>(ws: &mut S, reason: RefusedReason, message: impl Into<String>)
where
    S: SinkExt<Message> + Unpin,
{
    let _ = send(
        ws,
        &ServerFrame::Refused {
            reason,
            message: message.into(),
        },
    )
    .await;
    let _ = ws.send(Message::Close(None)).await;
}

/// One phone connection, from hello to close. Generic over the stream so the
/// tests can drive it without TLS or a proxy in between.
pub async fn serve_socket<S>(c: Arc<Companion>, ws: S)
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    serve_socket_as(c, ws, Peer::default()).await
}

/// [`serve_socket`], knowing who connected.
pub async fn serve_socket_as<S>(c: Arc<Companion>, mut ws: S, mut peer: Peer)
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    // Everything before the token checks out can be evicted by the gate.
    let shaken = tokio::select! {
        done = handshake(&c, &mut ws, &peer) => done,
        _ = peer.evicted() => None,
    };
    let Some((record, protocol, hello)) = shaken else {
        let _ = ws.send(Message::Close(None)).await;
        return;
    };
    peer.authenticated();
    drop(peer.prehello.take());
    let actor = actor_for(&record.name);
    let Some(conn) = c.open_conn(&record.id, hello.foreground) else {
        return refuse(
            &mut ws,
            RefusedReason::TooManyConnections,
            "Too many connections from this phone. Close the app and try again.",
        )
        .await;
    };
    let caller = Caller {
        device_id: record.id.clone(),
        device_name: record.name.clone(),
        label: Companion::label(&record.id, conn),
        // The listener is loopback-only and published solely by `tailscale
        // serve` (TLS at the tailnet edge): the only way in. A LAN listener
        // would set its own kind here.
        route: RouteKind::Tailscale,
        shows: wire::Shows::from_hello(&hello.features),
    };
    c.registry
        .touch(&record.id, now_ms() as i64, RouteKind::Tailscale, true);
    c.backend.audit(
        &actor,
        "connected",
        format!("app {}", crate::remote_access::preview(&hello.app.version)),
        true,
    );
    c.backend.changed();

    // Why phones drop, findable afterwards: each socket's life and how it
    // ended, with what the phone saw end the ones before (`hello.trail`).
    let trail = trail_line(&hello.trail);
    tracing::info!(
        device = %record.id,
        foreground = hello.foreground,
        resumed = hello.resume.is_some(),
        trail = %trail,
        "[Companion] phone connected"
    );
    let opened = Instant::now();
    let ended = connected(&c, &mut ws, &caller, protocol, &hello, caller.shows).await;
    tracing::info!(
        device = %record.id,
        ?ended,
        secs = opened.elapsed().as_secs(),
        "[Companion] phone socket closed"
    );

    c.close_conn(conn);
    let _ = c.backend.focus(&caller.label, None).await;
    c.registry
        .touch(&record.id, now_ms() as i64, RouteKind::Tailscale, true);
    c.backend.changed();
}

/// Whether a token refused for its tailnet user is told so
/// ([`RefusedReason::OtherAccount`]) rather than `Unauthorized`: the app
/// knows the word, and the request named a person at all.
fn other_account_refusal(hello: &wire::HelloFrame, login: Option<&str>) -> bool {
    login.is_some_and(|l| !l.trim().is_empty())
        && hello
            .features
            .iter()
            .any(|f| f == wire::FEATURE_OTHER_ACCOUNT)
}

/// The next text frame as a client frame, or `None` if none came in time
/// (or it wasn't one).
async fn read_frame<S>(ws: &mut S) -> Option<ClientFrame>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let text = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            match ws.next().await? {
                Ok(Message::Text(text)) => return Some(text),
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()??;
    serde_json::from_str::<ClientFrame>(&text).ok()
}

/// Up to an authenticated hello: the phone's challenge, this Mac's signed
/// identity, then the token. `None` once the socket was refused or dropped.
async fn handshake<S>(
    c: &Arc<Companion>,
    ws: &mut S,
    peer: &Peer,
) -> Option<(DeviceRecord, u32, wire::HelloFrame)>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    let (range, challenge) = match read_frame(ws).await? {
        ClientFrame::Challenge {
            protocol,
            challenge,
        } => (protocol, challenge),
        // An app from before the Mac proved itself first sends its token
        // straight away. It's not read: the app is told to update.
        ClientFrame::Hello(h) => {
            if wire::negotiate(h.protocol, wire::SUPPORTED) == Negotiation::UpdateApp {
                refuse(
                    ws,
                    RefusedReason::UpdateApp,
                    "Update this app to connect to this Mac.",
                )
                .await;
            }
            return None;
        }
        _ => return None,
    };
    let protocol = match wire::negotiate(range, wire::SUPPORTED) {
        Negotiation::Ok(v) => v,
        Negotiation::UpdateApp => {
            refuse(
                ws,
                RefusedReason::UpdateApp,
                "Update this app to connect to this Mac.",
            )
            .await;
            return None;
        }
        Negotiation::UpdateMac => {
            let name = c.backend.server_name();
            refuse(
                ws,
                RefusedReason::UpdateMac,
                format!("Update {} on {name}.", crate::brand::NAME),
            )
            .await;
            return None;
        }
    };
    let Some(key) = c.registry.identity() else {
        refuse(ws, RefusedReason::Unavailable, KEY_UNAVAILABLE).await;
        return None;
    };
    let server_id = c.registry.server_id();
    let hosts = serve_hosts(c);
    let proof = key.prove_mac(&challenge, &server_id, &hosts)?;
    let identity = ServerFrame::Identity {
        protocol,
        server_id,
        hosts,
        identity: proof,
    };
    if !send(ws, &identity).await {
        return None;
    }
    let ClientFrame::Hello(hello) = read_frame(ws).await? else {
        return None;
    };
    let source = if peer.source.is_empty() {
        "unknown"
    } else {
        peer.source.as_str()
    };
    let record = match c.registry.authenticate(&hello.token) {
        Auth::Device(d) if d.login_matches(peer.login.as_deref()) => d,
        Auth::Device(d) => {
            c.note_refused(
                source,
                &format!(
                    "{}'s token came without the tailnet user who paired it",
                    d.name
                ),
            );
            // Still a refusal. Said as what it is only to a phone that
            // came as some other person on the tailnet (Tailscale on it
            // switched accounts), and knows the word: a request naming
            // nobody (a tagged node, a local process) learns nothing more.
            if other_account_refusal(&hello, peer.login.as_deref()) {
                refuse(
                    ws,
                    RefusedReason::OtherAccount,
                    "Tailscale on this phone is signed in to another account than the one it was paired on.",
                )
                .await;
            } else {
                refuse(
                    ws,
                    RefusedReason::Unauthorized,
                    "This phone isn't paired with this Mac.",
                )
                .await;
            }
            return None;
        }
        Auth::Revoked => {
            c.note_refused(source, "a removed phone tried to connect");
            refuse(ws, RefusedReason::Revoked, "This Mac removed this phone.").await;
            return None;
        }
        Auth::Unknown => {
            c.note_refused(source, "an unknown device tried to connect");
            refuse(
                ws,
                RefusedReason::Unauthorized,
                "This phone isn't paired with this Mac.",
            )
            .await;
            return None;
        }
    };
    Some((record, protocol, hello))
}

#[derive(Debug)]
enum Ended {
    Closed,
    Revoked,
    Unpaired,
    Lagged,
    Shutdown,
    SendFailed,
    /// A newer socket from the same phone took its place.
    Replaced,
}

/// The zone `chrono::Local` (the schedule grammar's) reads times in. chrono
/// honours `TZ` first, so a `TZ` that names a zone is the answer, and one
/// that doesn't (a POSIX rule) is no answer at all rather than a wrong one.
fn local_time_zone() -> Option<String> {
    match std::env::var("TZ") {
        Ok(tz) if !tz.trim().is_empty() => {
            // ":America/New_York", or a path into the zone database.
            let tz = tz.trim().trim_start_matches(':');
            let tz = tz.rsplit("zoneinfo/").next().unwrap_or(tz);
            (!tz.starts_with('/') && (tz.contains('/') || tz == "UTC")).then(|| tz.to_string())
        }
        _ => iana_time_zone::get_timezone().ok(),
    }
}

async fn connected<S>(
    c: &Arc<Companion>,
    ws: &mut S,
    caller: &Caller,
    protocol: u32,
    hello: &wire::HelloFrame,
    shows: wire::Shows,
) -> Ended
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    let (mut rx, plan) = c.hub.resume(hello.resume.as_ref());
    let server_id = c.registry.server_id();
    let welcome = ServerFrame::Welcome {
        protocol,
        server: ServerInfo {
            id: server_id,
            name: c.backend.server_name(),
            app_version: c.backend.app_version(),
        },
        device_id: caller.device_id.clone(),
        resume: match plan {
            Resume::Replay { .. } => ResumeMode::Replay,
            Resume::Snapshot { .. } => ResumeMode::Snapshot,
        },
        methods: router::METHODS.to_vec(),
        features: wire::MAC_FEATURES.to_vec(),
        time_zone: local_time_zone(),
    };
    if !send(ws, &welcome).await {
        return Ended::SendFailed;
    }
    let caught_up = match plan {
        Resume::Replay { events, cursor } => {
            for (seq, event) in events {
                let Some(event) = wire::for_app(event, shows) else {
                    continue;
                };
                if !send(
                    ws,
                    &ServerFrame::Evt {
                        seq: Some(seq),
                        event,
                    },
                )
                .await
                {
                    return Ended::SendFailed;
                }
            }
            cursor
        }
        Resume::Snapshot { cursor } => {
            let snapshot = snapshot(c, cursor.clone(), SNAPSHOT_DEADLINE).await;
            if !send(
                ws,
                &ServerFrame::Evt {
                    seq: None,
                    event: snapshot,
                },
            )
            .await
            {
                return Ended::SendFailed;
            }
            cursor
        }
    };
    if !send(
        ws,
        &event_frame(None, Event::CaughtUp { cursor: caught_up }),
    )
    .await
    {
        return Ended::SendFailed;
    }

    let mut drafts = Drafts::default();
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<(u64, Result<Value, wire::WireError>)>();
    // This socket's requests still running. A revoke (or unpair) aborts them
    // with the socket; any other close lets them finish, since a send the
    // phone will retry by clientId is better done once than cut in half.
    let mut work = JoinSet::new();
    let ended = serve_frames(
        c,
        ws,
        caller,
        shows,
        &mut rx,
        &mut drafts,
        &done_tx,
        &mut done_rx,
        &mut work,
    )
    .await;
    match ended {
        Ended::Revoked | Ended::Unpaired => work.abort_all(),
        _ => work.detach_all(),
    }
    ended
}

#[allow(clippy::too_many_arguments)]
async fn serve_frames<S>(
    c: &Arc<Companion>,
    ws: &mut S,
    caller: &Caller,
    shows: wire::Shows,
    rx: &mut broadcast::Receiver<HubItem>,
    drafts: &mut Drafts,
    done_tx: &mpsc::UnboundedSender<(u64, Result<Value, wire::WireError>)>,
    done_rx: &mut mpsc::UnboundedReceiver<(u64, Result<Value, wire::WireError>)>,
    work: &mut JoinSet<()>,
) -> Ended
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    let mut heartbeat =
        tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut draft_tick = tokio::time::interval(DRAFT_TICK);
    draft_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ended::Closed,
                };
                // The token is re-checked on every frame.
                if c.registry.get(&caller.device_id).is_none() {
                    refuse(ws, RefusedReason::Revoked, "This Mac removed this phone.").await;
                    return Ended::Revoked;
                }
                c.registry.touch(&caller.device_id, now_ms() as i64, RouteKind::Tailscale, false);
                let frame = match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(f) => f,
                    Err(e) => {
                        // A request we can't read still gets an answer, by id.
                        if let Some(id) = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("id")?.as_u64()) {
                            let err = wire::WireError::protocol(wire::ProtocolCode::BadParams, e.to_string());
                            if !send(ws, &ServerFrame::response(id, Err(err))).await {
                                return Ended::SendFailed;
                            }
                        }
                        continue;
                    }
                };
                match frame {
                    ClientFrame::Req { id, method, params } if method == "devices.unpairSelf" => {
                        // Answered before the socket closes, so the phone
                        // hears "done" rather than "removed".
                        let result = dispatch_bounded(c.clone(), caller.clone(), method, params).await;
                        let _ = send(ws, &ServerFrame::response(id, result)).await;
                        let _ = ws.send(Message::Close(None)).await;
                        c.hub.signal(HubItem::Revoked { device_id: caller.device_id.clone() });
                        return Ended::Unpaired;
                    }
                    ClientFrame::Req { id, method, params } => {
                        let (c, caller, done) = (c.clone(), caller.clone(), done_tx.clone());
                        work.spawn(async move {
                            let result = dispatch_bounded(c, caller, method, params).await;
                            let _ = done.send((id, result));
                        });
                    }
                    ClientFrame::Presence { foreground } => {
                        c.set_foreground(conn_of(&caller.label), foreground);
                    }
                    ClientFrame::Ping => {
                        if !send(ws, &ServerFrame::Pong).await {
                            return Ended::SendFailed;
                        }
                    }
                    ClientFrame::Hello(_) | ClientFrame::Challenge { .. } => {}
                }
            }
            item = rx.recv() => {
                match item {
                    Ok(item) => {
                        if let Some(ended) = forward(ws, c, drafts, caller, item, shows).await {
                            return ended;
                        }
                    }
                    // Fell behind the channel: close, and the phone resumes
                    // by cursor from the journal with nothing lost.
                    Err(broadcast::error::RecvError::Lagged(_)) => return Ended::Lagged,
                    Err(broadcast::error::RecvError::Closed) => return Ended::Shutdown,
                }
            }
            // Reap finished tasks so the set doesn't grow over a long session.
            Some(_) = work.join_next(), if !work.is_empty() => {}
            Some((id, result)) = done_rx.recv() => {
                // Events the request caused go out before its response.
                while let Ok(item) = rx.try_recv() {
                    if let Some(ended) = forward(ws, c, drafts, caller, item, shows).await {
                        return ended;
                    }
                }
                if !send(ws, &ServerFrame::response(id, result)).await {
                    return Ended::SendFailed;
                }
            }
            // Armed only while a draft is held back: an idle socket used to
            // wake 20 times a second to flush nothing.
            _ = draft_tick.tick(), if drafts.has_pending() => {
                for event in drafts.flush(Instant::now()) {
                    if !send(ws, &event_frame(None, event)).await {
                        return Ended::SendFailed;
                    }
                }
            }
            _ = heartbeat.tick() => {
                // A WebSocket ping keeps proxies and NATs from idling the
                // link out; the unprompted `pong` frame is what the phone's
                // JS can see, so it knows the Mac is still there.
                if ws.send(Message::Ping(Vec::new())).await.is_err() || !send(ws, &ServerFrame::Pong).await {
                    return Ended::SendFailed;
                }
            }
        }
    }
}

fn conn_of(label: &str) -> u64 {
    label
        .rsplit(':')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// The close every phone hears as the app quits: "going away", so it waits.
fn app_closing_frame() -> Message {
    use tokio_tungstenite::tungstenite::protocol::frame::{coding::CloseCode, CloseFrame};
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(super::hub::CLOSE_APP_CLOSING),
        reason: "app closing".into(),
    }))
}

fn event_frame(seq: Option<u64>, event: Event) -> ServerFrame {
    ServerFrame::Evt { seq, event }
}

/// Send one hub item to this socket. `Some` ends the connection.
async fn forward<S>(
    ws: &mut S,
    c: &Companion,
    drafts: &mut Drafts,
    caller: &Caller,
    item: HubItem,
    shows: wire::Shows,
) -> Option<Ended>
where
    S: SinkExt<Message> + Unpin,
{
    let frame = match item {
        HubItem::Journaled { seq, event } => {
            if let Event::Message { message } = &event {
                if let Some(id) = message.get("id").and_then(Value::as_str) {
                    drafts.finished(id);
                }
            }
            let event = wire::for_app(event, shows)?;
            event_frame(Some(seq), event)
        }
        HubItem::Draft { agent_id, id, text } => {
            let event = drafts.offer(agent_id, id, text, Instant::now())?;
            event_frame(None, event)
        }
        // An older app doesn't know the Mac decides (it posts cards itself),
        // and the chat in front already shows what the alert would say.
        HubItem::Alert { alert } => {
            if !shows.alerts || c.in_front_of(&caller.label, &alert.agent_id) {
                return None;
            }
            event_frame(None, Event::Alert { alert })
        }
        HubItem::Revoked { device_id } if device_id == caller.device_id => {
            refuse(ws, RefusedReason::Revoked, "This Mac removed this phone.").await;
            return Some(Ended::Revoked);
        }
        HubItem::Revoked { .. } => return None,
        // The same phone came back on a newer socket: this one is spent.
        HubItem::Replaced { conn } if conn == conn_of(&caller.label) => {
            let _ = ws.send(Message::Close(None)).await;
            return Some(Ended::Replaced);
        }
        HubItem::Replaced { .. } => return None,
        HubItem::Shutdown => {
            let _ = ws.send(Message::Close(None)).await;
            return Some(Ended::Shutdown);
        }
        HubItem::AppClosing => {
            let _ = ws.send(app_closing_frame()).await;
            return Some(Ended::Shutdown);
        }
    };
    (!send(ws, &frame).await).then_some(Ended::SendFailed)
}

#[cfg(test)]
pub(crate) mod tests;

/// `hello.trail` as one log line: "-63s silent via tailscale; -2s welcome …",
/// times relative to now, at most 20 entries of 80 characters each.
fn trail_line(trail: &[wire::TrailEntry]) -> String {
    let now = now_ms() as i64;
    trail
        .iter()
        .rev()
        .take(20)
        .rev()
        .map(|e| {
            let what: String = e
                .what
                .chars()
                .filter(|c| !c.is_control())
                .take(80)
                .collect();
            format!("-{}s {}", (now - e.at).max(0) / 1000, what)
        })
        .collect::<Vec<_>>()
        .join("; ")
}
