//! "Watch live" from the phone: a read-only view of a card's running dev
//! server, over the user's own tailnet.
//!
//! - **Tailnet only.** The listener binds loopback; `tailscale serve` (never
//!   Funnel) publishes it at `https://<mac>.ts.net:<WATCH_TAILNET_PORT>`. A
//!   request that isn't from loopback, or that Tailscale marks as a Funnel
//!   request, is refused.
//! - **Authenticated like the companion.** The phone asks for a link over its
//!   paired, authenticated socket (`agents.watchLive`). The link carries a
//!   one-time ticket (256 bits, kept only as a hash, valid a minute) bound to
//!   that device and that dev server's port. Opening it trades the ticket for
//!   an HttpOnly session cookie (30 minutes); every request re-checks that the
//!   device is still paired, so removing the phone on the Mac ends it.
//! - **Read-only.** Only GET and HEAD go through. Forms that post, and
//!   WebSockets (so no live reload), are refused; the phone reloads instead.
//! - **Nothing added.** Responses are passed through as the dev server sent
//!   them: no script injection, our cookie and Tailscale's headers stripped
//!   on the way in.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use super::pairing::{constant_time_eq, hash_token};
use super::server::Body;
use super::{Companion, TAILNET_HTTPS_PORT};

/// The tailnet HTTPS port Watch live is served on: the companion's plus one.
/// Never a port Funnel can open (443, 8443, 10000).
pub const WATCH_TAILNET_PORT: u16 = TAILNET_HTTPS_PORT + 1;
/// Ports Tailscale Funnel can publish to the internet.
pub const FUNNEL_PORTS: [u16; 3] = [443, 8443, 10000];
/// How long a link may wait to be opened.
pub const TICKET_TTL_MS: u64 = 60_000;
/// How long a phone may watch on one link.
pub const SESSION_TTL_MS: u64 = 30 * 60_000;

/// `/__<slug>-watch/<ticket>`.
pub fn ticket_prefix() -> String {
    format!("/__{}/", crate::brand::scoped("watch"))
}

/// The session cookie's name: `<slug>_watch`.
pub fn cookie_name() -> String {
    format!("{}_watch", crate::brand::SLUG)
}

#[derive(Debug, Clone, PartialEq)]
struct Grant {
    hash: String,
    device_id: String,
    /// The folder whose dev server this is: the port is only good while the
    /// app still serves that folder on it.
    path: String,
    port: u16,
    expires_at: u64,
}

/// Tickets and sessions, by hash. The secrets themselves are never kept.
#[derive(Default)]
pub struct Watch {
    tickets: Mutex<Vec<Grant>>,
    sessions: Mutex<Vec<Grant>>,
}

fn find(list: &[Grant], secret: &str) -> Option<usize> {
    let hash = hash_token(secret);
    let mut found = None;
    for (i, g) in list.iter().enumerate() {
        if constant_time_eq(g.hash.as_bytes(), hash.as_bytes()) {
            found = Some(i);
        }
    }
    found
}

impl Watch {
    /// A one-time ticket for `device_id` to watch `path`'s server on `port`.
    pub fn mint(&self, device_id: &str, path: &str, port: u16, now: u64) -> (String, u64) {
        let secret = crate::agents::broker::new_secret();
        let expires_at = now + TICKET_TTL_MS;
        let mut t = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        t.retain(|g| g.expires_at > now);
        t.push(Grant {
            hash: hash_token(&secret),
            device_id: device_id.to_string(),
            path: path.to_string(),
            port,
            expires_at,
        });
        (secret, expires_at)
    }

    /// Spend a ticket: a new session secret, or nothing (unknown, used, expired).
    fn redeem(&self, ticket: &str, now: u64) -> Option<(String, Grant)> {
        let grant = {
            let mut t = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
            let i = find(&t, ticket)?;
            let g = t.remove(i);
            (g.expires_at > now).then_some(g)?
        };
        let secret = crate::agents::broker::new_secret();
        let session = Grant {
            hash: hash_token(&secret),
            expires_at: now + SESSION_TTL_MS,
            ..grant
        };
        let mut s = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        s.retain(|g| g.expires_at > now);
        s.push(session.clone());
        Some((secret, session))
    }

    fn session(&self, secret: &str, now: u64) -> Option<Grant> {
        let s = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let i = find(&s, secret)?;
        let g = s[i].clone();
        (g.expires_at > now).then_some(g)
    }

    /// A removed phone's tickets and sessions go at once.
    pub fn forget_device(&self, device_id: &str) {
        self.tickets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|g| g.device_id != device_id);
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|g| g.device_id != device_id);
    }
}

/// What to do with one request.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// A good ticket: set this session cookie and go to `/`.
    Redeem {
        cookie: String,
    },
    /// Pass it to the dev server on `port`, while it still serves `path`.
    Forward {
        port: u16,
        path: String,
    },
    Refuse(StatusCode, &'static str),
}

pub const NOT_TAILNET: &str = "Only reachable from your own tailnet.";
pub const READ_ONLY: &str = "Read-only from the phone: nothing can be sent from here.";
pub const NO_SOCKETS: &str = "Live reload isn't available from the phone. Reload to see changes.";
pub const EXPIRED: &str = "This link has expired. Tap Watch live on the phone again.";
pub const SIGNED_OUT: &str = "Open this from Watch live on your paired phone.";

/// The value of our cookie in a Cookie header, if present.
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim().to_string())
}

/// Decide one request. `alive` says whether a device is still paired.
pub fn decide(
    watch: &Watch,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    peer_loopback: bool,
    alive: impl Fn(&str) -> bool,
    now: u64,
) -> Verdict {
    if !peer_loopback || headers.contains_key("tailscale-funnel-request") {
        return Verdict::Refuse(StatusCode::FORBIDDEN, NOT_TAILNET);
    }
    if method != Method::GET && method != Method::HEAD {
        return Verdict::Refuse(StatusCode::METHOD_NOT_ALLOWED, READ_ONLY);
    }
    if headers.contains_key(header::UPGRADE) {
        return Verdict::Refuse(StatusCode::FORBIDDEN, NO_SOCKETS);
    }
    if let Some(ticket) = path.strip_prefix(&ticket_prefix()) {
        let ticket = ticket.split(['?', '/']).next().unwrap_or("");
        return match watch.redeem(ticket, now) {
            Some((cookie, grant)) if alive(&grant.device_id) => Verdict::Redeem { cookie },
            _ => Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED),
        };
    }
    let Some(secret) = cookie_value(headers, &cookie_name()) else {
        return Verdict::Refuse(StatusCode::UNAUTHORIZED, SIGNED_OUT);
    };
    match watch.session(&secret, now) {
        Some(g) if alive(&g.device_id) => Verdict::Forward {
            port: g.port,
            path: g.path,
        },
        Some(_) => {
            // Its phone was removed: nothing it held is good any more.
            Verdict::Refuse(StatusCode::UNAUTHORIZED, SIGNED_OUT)
        }
        None => Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED),
    }
}

/// The headers sent on to the dev server: Host its own, our cookie and
/// Tailscale's identity headers removed.
pub fn forward_headers(incoming: &HeaderMap, port: u16) -> HeaderMap {
    let ours = cookie_name();
    let mut out = HeaderMap::new();
    for (name, value) in incoming {
        let n = name.as_str();
        if n == "host" || n == "cookie" || n.starts_with("tailscale-") {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    let kept: Vec<String> = incoming
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .filter(|pair| {
            !pair.is_empty() && pair.split_once('=').map(|(k, _)| k) != Some(ours.as_str())
        })
        .map(str::to_string)
        .collect();
    if !kept.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&kept.join("; ")) {
            out.insert(header::COOKIE, v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&format!("localhost:{port}")) {
        out.insert(header::HOST, v);
    }
    out
}

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(
            Full::new(Bytes::from(crate::computer::localize(text).into_owned()))
                .map_err(|n| match n {})
                .boxed(),
        )
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new()).map_err(|n| match n {}).boxed()))
}

async fn connect(port: u16) -> std::io::Result<TcpStream> {
    match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => Ok(s),
        Err(_) => TcpStream::connect(("::1", port)).await,
    }
}

async fn forward(req: Request<Incoming>, port: u16) -> Response<Body> {
    let Ok(stream) = connect(port).await else {
        return plain(
            StatusCode::BAD_GATEWAY,
            "The site isn't running on the Mac any more.",
        );
    };
    let Ok((mut sender, conn)) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    else {
        return plain(
            StatusCode::BAD_GATEWAY,
            "The site on the Mac didn't answer.",
        );
    };
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let (parts, body) = req.into_parts();
    let mut out = Request::builder().method(parts.method).uri(
        parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/".into()),
    );
    if let Some(h) = out.headers_mut() {
        *h = forward_headers(&parts.headers, port);
    }
    let Ok(out) = out.body(body) else {
        return plain(
            StatusCode::BAD_REQUEST,
            "That request couldn't be passed on.",
        );
    };
    match sender.send_request(out).await {
        Ok(resp) => resp.map(|b| b.boxed()),
        Err(_) => plain(
            StatusCode::BAD_GATEWAY,
            "The site on the Mac didn't answer.",
        ),
    }
}

/// Serve one request. A device counts as paired while the registry has it.
pub async fn handle(c: Arc<Companion>, peer: SocketAddr, req: Request<Incoming>) -> Response<Body> {
    let verdict = decide(
        &c.watch,
        req.method(),
        req.uri().path(),
        req.headers(),
        peer.ip().is_loopback(),
        |d| c.registry.get(d).is_some(),
        super::now_ms(),
    );
    match verdict {
        Verdict::Refuse(status, text) => plain(status, text),
        Verdict::Redeem { cookie } => Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, "/")
            .header(
                header::SET_COOKIE,
                format!(
                    "{}={cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
                    cookie_name(),
                    SESSION_TTL_MS / 1000
                ),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .body(Full::new(Bytes::new()).map_err(|n| match n {}).boxed())
            .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't open it.")),
        // The port alone isn't the card's site: once the app stops serving
        // that folder there, whatever binds the port next isn't shown.
        Verdict::Forward { port, path }
            if crate::proxy::dev_server_port_for(&path) == Some(port)
                || crate::agents::dev_servers::serves(&path, port) =>
        {
            crate::agents::dev_servers::note_watched(port);
            forward(req, port).await
        }
        Verdict::Forward { .. } => plain(
            StatusCode::BAD_GATEWAY,
            "The site isn't running on the Mac any more.",
        ),
    }
}

/// Serve until `shutdown` fires.
pub async fn serve(c: Arc<Companion>, listener: TcpListener, mut shutdown: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let c = c.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let c = c.clone();
                        async move { Ok::<_, std::convert::Infallible>(handle(c, peer, req).await) }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
            _ = &mut shutdown => break,
        }
    }
}

/// Known tickets, for tests only.
#[cfg(test)]
fn ticket_count(w: &Watch) -> usize {
    w.tickets.lock().unwrap().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(
                header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    fn get(w: &Watch, path: &str, headers: &HeaderMap, now: u64) -> Verdict {
        decide(w, &Method::GET, path, headers, true, |_| true, now)
    }

    fn open(w: &Watch, device: &str, port: u16) -> String {
        let (ticket, _) = w.mint(device, "/p", port, 1_000);
        match get(w, &format!("{}{ticket}", ticket_prefix()), &h(&[]), 1_001) {
            Verdict::Redeem { cookie } => cookie,
            other => panic!("expected a redeem, got {other:?}"),
        }
    }

    fn with_cookie(secret: &str) -> HeaderMap {
        h(&[("cookie", &format!("theme=dark; {}={secret}", cookie_name()))])
    }

    #[test]
    fn the_watch_port_is_never_one_funnel_can_open() {
        assert!(!FUNNEL_PORTS.contains(&WATCH_TAILNET_PORT));
        assert_ne!(WATCH_TAILNET_PORT, TAILNET_HTTPS_PORT);
    }

    #[test]
    fn a_ticket_opens_once_then_the_cookie_reaches_its_port() {
        let w = Watch::default();
        let (ticket, expires) = w.mint("phone-1", "/p", 4123, 1_000);
        assert_eq!(expires, 1_000 + TICKET_TTL_MS);
        assert_eq!(ticket.len(), 64);
        let path = format!("{}{ticket}", ticket_prefix());
        let Verdict::Redeem { cookie } = get(&w, &path, &h(&[]), 1_001) else {
            panic!("first open redeems");
        };
        // Spent: the same link again is refused.
        assert_eq!(
            get(&w, &path, &h(&[]), 1_002),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED)
        );
        assert_eq!(
            get(&w, "/pricing", &with_cookie(&cookie), 2_000),
            Verdict::Forward {
                port: 4123,
                path: "/p".into()
            }
        );
        // Only hashes are kept.
        assert!(w.sessions.lock().unwrap().iter().all(|g| g.hash != cookie));
        assert_eq!(ticket_count(&w), 0);
    }

    #[test]
    fn a_ticket_or_session_past_its_time_is_refused() {
        let w = Watch::default();
        let (ticket, _) = w.mint("phone-1", "/p", 4123, 1_000);
        let late = 1_000 + TICKET_TTL_MS;
        assert_eq!(
            get(&w, &format!("{}{ticket}", ticket_prefix()), &h(&[]), late),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED)
        );
        let cookie = open(&w, "phone-1", 4123);
        assert_eq!(
            get(&w, "/", &with_cookie(&cookie), 1_001 + SESSION_TTL_MS),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED)
        );
    }

    #[test]
    fn a_removed_phone_can_neither_open_nor_keep_watching() {
        let w = Watch::default();
        let cookie = open(&w, "phone-1", 4123);
        let gone = |_: &str| false;
        assert_eq!(
            decide(
                &w,
                &Method::GET,
                "/",
                &with_cookie(&cookie),
                true,
                gone,
                2_000
            ),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, SIGNED_OUT)
        );
        let (ticket, _) = w.mint("phone-1", "/p", 4123, 1_000);
        assert_eq!(
            decide(
                &w,
                &Method::GET,
                &format!("{}{ticket}", ticket_prefix()),
                &h(&[]),
                true,
                gone,
                1_001
            ),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED)
        );
        w.forget_device("phone-1");
        assert_eq!(
            get(&w, "/", &with_cookie(&cookie), 2_000),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED)
        );
    }

    #[test]
    fn each_cookie_reaches_only_the_port_it_was_given() {
        let w = Watch::default();
        let a = open(&w, "phone-1", 4123);
        let b = open(&w, "phone-2", 4555);
        assert_eq!(
            get(&w, "/", &with_cookie(&a), 2_000),
            Verdict::Forward {
                port: 4123,
                path: "/p".into()
            }
        );
        assert_eq!(
            get(&w, "/", &with_cookie(&b), 2_000),
            Verdict::Forward {
                port: 4555,
                path: "/p".into()
            }
        );
        assert_eq!(
            get(&w, "/", &with_cookie("not-a-session"), 2_000),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, EXPIRED)
        );
        assert_eq!(
            get(&w, "/", &h(&[]), 2_000),
            Verdict::Refuse(StatusCode::UNAUTHORIZED, SIGNED_OUT)
        );
    }

    #[test]
    fn never_public_and_only_through_tailscale_serve() {
        let w = Watch::default();
        let cookie = open(&w, "phone-1", 4123);
        let mut funnel = with_cookie(&cookie);
        funnel.insert("tailscale-funnel-request", HeaderValue::from_static("?1"));
        assert_eq!(
            get(&w, "/", &funnel, 2_000),
            Verdict::Refuse(StatusCode::FORBIDDEN, NOT_TAILNET)
        );
        assert_eq!(
            decide(
                &w,
                &Method::GET,
                "/",
                &with_cookie(&cookie),
                false,
                |_| true,
                2_000
            ),
            Verdict::Refuse(StatusCode::FORBIDDEN, NOT_TAILNET)
        );
    }

    #[test]
    fn read_only_nothing_is_sent_and_no_sockets() {
        let w = Watch::default();
        let cookie = open(&w, "phone-1", 4123);
        for m in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
            assert_eq!(
                decide(
                    &w,
                    &m,
                    "/api/signup",
                    &with_cookie(&cookie),
                    true,
                    |_| true,
                    2_000
                ),
                Verdict::Refuse(StatusCode::METHOD_NOT_ALLOWED, READ_ONLY),
                "{m}"
            );
        }
        assert_eq!(
            decide(
                &w,
                &Method::HEAD,
                "/",
                &with_cookie(&cookie),
                true,
                |_| true,
                2_000
            ),
            Verdict::Forward {
                port: 4123,
                path: "/p".into()
            }
        );
        let mut ws = with_cookie(&cookie);
        ws.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        assert_eq!(
            get(&w, "/_next/webpack-hmr", &ws, 2_000),
            Verdict::Refuse(StatusCode::FORBIDDEN, NO_SOCKETS)
        );
    }

    #[test]
    fn our_cookie_and_tailscales_headers_never_reach_the_dev_server() {
        let incoming = h(&[
            ("host", "mac.example.ts.net:47464"),
            (
                "cookie",
                &format!("theme=dark; {}=s3cret; cart=2", cookie_name()),
            ),
            ("tailscale-user-login", "someone@example.com"),
            ("tailscale-user-name", "Someone"),
            ("accept", "text/html"),
        ]);
        let out = forward_headers(&incoming, 4123);
        assert_eq!(out.get(header::HOST).unwrap(), "localhost:4123");
        assert_eq!(out.get(header::COOKIE).unwrap(), "theme=dark; cart=2");
        assert!(out.keys().all(|k| !k.as_str().starts_with("tailscale-")));
        assert_eq!(out.get(header::ACCEPT).unwrap(), "text/html");
        let only_ours = h(&[("cookie", &format!("{}=s3cret", cookie_name()))]);
        assert!(forward_headers(&only_ours, 1).get(header::COOKIE).is_none());
    }

    #[test]
    fn a_cookie_named_like_ours_but_longer_is_not_ours() {
        let headers = h(&[("cookie", &format!("{}x=1", cookie_name()))]);
        assert_eq!(cookie_value(&headers, &cookie_name()), None);
    }
}
