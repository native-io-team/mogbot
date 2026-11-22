//! One phone on the relay: the end-to-end handshake, then its frames.
//!
//! The first payload is the phone's hello; the Mac answers in plaintext and
//! every payload after is sealed. A sealed plaintext is either HTTP (`http`,
//! `httpBody`; see `http.rs`) or a companion protocol frame, which goes to
//! `server::serve_socket_as` in-process, exactly as a Tailscale socket's
//! would, through [`Adapter`]. The handler is started by the first protocol
//! frame, so a channel used only for HTTP (pairing) isn't closed by the
//! socket's hello timeout.

use futures_util::{Sink, Stream};
use serde_json::Value;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_util::sync::PollSender;

use super::super::server::{self, Peer};
use super::super::Companion;
use super::crypto::{self, MacChannel};
use super::http::{Http, HttpBody, HttpRequest};
use super::session::{self, Session, Taken};

/// The phone has this long to send its hello once the relay opened the channel.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Messages queued between the channel and the socket handler, each way.
const QUEUE: usize = 64;
/// The relay drops a payload past this (docs/relay.md, just under 1 MiB).
pub const MAX_PAYLOAD: usize = 1024 * 1024 - 64;
/// Bytes from the phone waiting for this channel to take them. Past it the
/// channel is closed as stuck (`client`), so a phone that sends faster than
/// it's served holds at most this much of the Mac's memory, not its queue's
/// 256 payloads of 256 KiB each.
pub const MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;
/// A channel that never became an authenticated socket (HTTP only, or
/// nothing at all after the handshake) closes after this long with no
/// request in flight and nothing either way, so strangers who know the
/// fingerprint can't sit on the relay's few phone slots for this Mac. The
/// phone's HTTP uses one channel per request and closes it when answered.
const IDLE: Duration = if cfg!(test) {
    Duration::from_millis(600)
} else {
    Duration::from_secs(30)
};

/// What the relay link hands one channel: the phone's payloads, with the
/// bytes still queued counted (see [`MAX_QUEUED_BYTES`]).
pub struct Inbound {
    rx: mpsc::Receiver<Vec<u8>>,
    queued: Arc<AtomicUsize>,
}

impl Inbound {
    pub fn new(rx: mpsc::Receiver<Vec<u8>>, queued: Arc<AtomicUsize>) -> Self {
        Inbound { rx, queued }
    }

    async fn recv(&mut self) -> Option<Vec<u8>> {
        let payload = self.rx.recv().await?;
        self.queued.fetch_sub(payload.len(), Ordering::SeqCst);
        Some(payload)
    }
}

/// What a channel sends the relay.
#[derive(Debug)]
pub enum Out {
    /// A payload for this channel's phone.
    Payload(u32, Vec<u8>),
    /// The channel ended on the Mac's side.
    Ended(u32, u64),
    /// The phone on this channel proved its token (its Welcome went out):
    /// the relay keeps it when strangers fill the Mac's phone slots.
    Authed(u32, u64),
}

/// A frame the socket handler sends is the Welcome: the phone proved its
/// device token. Serialized with its tag first (`ServerFrame`).
fn is_welcome(text: &str) -> bool {
    text.starts_with(r#"{"t":"welcome""#)
}

/// The socket handler's WebSocket: protocol frames in from the phone, its
/// messages out to be sealed.
pub struct Adapter {
    rx: mpsc::Receiver<Message>,
    tx: PollSender<Message>,
}

impl Stream for Adapter {
    type Item = Result<Message, tungstenite::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|m| m.map(Ok))
    }
}

impl Sink<Message> for Adapter {
    type Error = tokio_util::sync::PollSendError<Message>;
    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.tx.poll_reserve(cx)
    }
    fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        self.tx.send_item(item)
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        self.tx.close();
        Poll::Ready(Ok(()))
    }
}

/// Seal and queue one plaintext for the phone. False: the channel is done.
async fn seal_out(keys: &mut MacChannel, ch: u32, out: &mpsc::Sender<Out>, plain: &[u8]) -> bool {
    let Some(sealed) = keys.outgoing.seal(plain) else {
        return false;
    };
    if sealed.len() + 4 > MAX_PAYLOAD {
        // The relay would close the phone's socket for this (1009), and the
        // phone would ask for the same thing again: never sent. Frames are
        // fitted before this (`fit`), so this is the last guard.
        tracing::warn!(
            bytes = sealed.len(),
            "[Relay] a frame for the phone is over the relay's payload limit and was not sent"
        );
        return true;
    }
    out.send(Out::Payload(ch, sealed)).await.is_ok()
}

/// Serve one channel until either side ends it. `generation` tells this
/// channel apart from a later one the relay gives the same number.
pub async fn run(
    c: Arc<Companion>,
    ch: u32,
    generation: u64,
    port: Option<u16>,
    mut inbound: Inbound,
    out: mpsc::Sender<Out>,
) {
    serve(&c, ch, generation, port, &mut inbound, &out).await;
    let _ = out.send(Out::Ended(ch, generation)).await;
}

async fn serve(
    c: &Arc<Companion>,
    ch: u32,
    generation: u64,
    port: Option<u16>,
    inbound: &mut Inbound,
    out: &mpsc::Sender<Out>,
) {
    let started = std::time::Instant::now();
    let Ok(Some(hello)) = tokio::time::timeout(HELLO_TIMEOUT, inbound.recv()).await else {
        // Info: phones report "connect-timeout via relay" for a minute or
        // more at a time; this says whether their hello ever reached here.
        tracing::info!(
            ch,
            ms = started.elapsed().as_millis() as u64,
            "[Relay] a phone's channel opened but no hello came"
        );
        return;
    };
    tracing::info!(
        ch,
        ms = started.elapsed().as_millis() as u64,
        "[Relay] a phone's hello arrived"
    );
    let Some(identity) = c.registry.identity() else {
        tracing::warn!("[Relay] no identity key to answer a phone with");
        return;
    };
    let Some(secret) = crypto::fresh_secret() else {
        return;
    };
    let Some((answer, mut keys)) = crypto::mac_answer(&identity, secret, &hello) else {
        tracing::debug!("[Relay] a channel opened with something that isn't a hello");
        return;
    };
    // A phone coming back to a session it had: its handler and what it was
    // owed are taken over before the answer goes, so a frame can't be lost
    // between its old socket and this one.
    let proof = keys.proof.clone();
    let back = match (&proof, keys.sessions) {
        (Some(proof), true) => session::claim(&keys.phone_e, proof).await,
        _ => None,
    };
    if out.send(Out::Payload(ch, answer)).await.is_err() {
        return;
    }

    let (plain_tx, mut plain_rx) = mpsc::channel::<String>(QUEUE);
    let mut http = port.map(|p| Http::new(p, ch, plain_tx.clone()));
    // The socket handler, once a protocol frame arrives (or already running,
    // for a session coming back).
    let mut to_handler: Option<mpsc::Sender<Message>> = None;
    let (from_tx, mut from_handler) = mpsc::channel::<Message>(QUEUE);
    let mut from_tx = Some(from_tx);
    let mut authed = false;
    let mut sess: Option<Session> = None;
    let mut replay: Vec<String> = Vec::new();
    let mut resumed = false;
    if let (Some(back), Some(proof)) = (back, &proof) {
        let mut session = back.session;
        session.rekey(keys.resume, proof.k);
        replay = session.replay(proof.rx);
        to_handler = back.to_handler;
        from_handler = back.from_handler;
        from_tx = None;
        authed = back.authed;
        resumed = true;
        sess = Some(session);
    } else if keys.sessions {
        sess = Session::new(keys.resume);
    }
    let mut yield_rx = sess.as_ref().map(|s| session::go_live(s));
    if let Some(s) = &sess {
        if !seal_out(&mut keys, ch, out, s.sess(resumed).as_bytes()).await {
            session::forget(&s.sid);
            return;
        }
        for frame in &replay {
            if !seal_out(&mut keys, ch, out, frame.as_bytes()).await {
                session::forget(&s.sid);
                return;
            }
        }
        if resumed && authed && out.send(Out::Authed(ch, generation)).await.is_err() {
            session::forget(&s.sid);
            return;
        }
        if resumed {
            tracing::info!(
                ch,
                replayed = replay.len(),
                "[Relay] a phone came back to its session"
            );
        }
    }
    let mut heard = Instant::now();
    let mut idle_check = tokio::time::interval(IDLE / 3);
    // A handler frame taken while the session had room for it only in part
    // (the byte cap): it waits for acks, never dropped, never reordered.
    let mut held: Option<String> = None;

    let end = 'serve: loop {
        // The handler is only listened to while the phone has room for more:
        // a long replay waits for acks (a round trip) instead of overrunning
        // the unacked limit and ending the session. Without a session
        // (an older phone) there is no limit to wait on.
        if let Some(text) = held.take() {
            let Some(s) = sess.as_mut() else { continue };
            match s.wrap(&text) {
                Some(framed) => {
                    if !seal_out(&mut keys, ch, out, framed.as_bytes()).await {
                        break 'serve End::Done;
                    }
                }
                None if s.has_unacked() => held = Some(text),
                None => {
                    tracing::warn!(
                        "[Relay] a frame over the session's byte limit; ending its session"
                    );
                    break 'serve End::Done;
                }
            }
        }
        let room = held.is_none() && sess.as_ref().map_or(true, Session::has_room);
        tokio::select! {
            _ = idle_check.tick() => {
                let busy = http.as_mut().map_or(0, Http::in_flight) > 0;
                if to_handler.is_none() && !busy && heard.elapsed() >= IDLE {
                    tracing::debug!("[Relay] a channel with nothing going on closed");
                    break 'serve End::Done;
                }
                // Waiting on acks from a phone that has said nothing: gone.
                if !room && heard.elapsed() >= IDLE {
                    tracing::warn!("[Relay] a phone stopped acking; ending its session");
                    break 'serve End::Done;
                }
            }
            // The same phone is back on a new socket already: this one is dead.
            Some(()) = async {
                match yield_rx.as_mut() {
                    Some(r) => r.recv().await,
                    None => std::future::pending().await,
                }
            } => break 'serve End::Park,
            payload = inbound.recv() => {
                // None: the relay closed it, or the link went.
                let Some(payload) = payload else { break 'serve End::Park };
                heard = Instant::now();
                let Some(plain) = keys.incoming.open(&payload) else {
                    tracing::debug!("[Relay] a payload didn't open; closing the channel");
                    break 'serve End::Done;
                };
                let Ok(text) = String::from_utf8(plain) else { break 'serve End::Done };
                let kind = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.get("t").and_then(Value::as_str).map(str::to_string));
                match kind.as_deref() {
                    Some("http") => {
                        let (Some(http), Ok(req)) = (http.as_mut(), serde_json::from_str::<HttpRequest>(&text)) else { continue };
                        if let Some(answer) = http.start(req) {
                            if !seal_out(&mut keys, ch, out, answer.as_bytes()).await {
                                break 'serve End::Done;
                            }
                        }
                    }
                    Some("httpBody") => {
                        let (Some(http), Ok(piece)) = (http.as_mut(), serde_json::from_str::<HttpBody>(&text)) else { continue };
                        http.body(piece).await;
                    }
                    _ => {
                        // On a session the protocol frames are numbered.
                        let text = match sess.as_mut() {
                            None => text,
                            Some(s) => match s.take(&text) {
                                Taken::Frame(d, due) => {
                                    if due && !seal_out(&mut keys, ch, out, s.ack().as_bytes()).await {
                                        break 'serve End::Done;
                                    }
                                    d
                                }
                                Taken::Nothing => continue,
                                Taken::Broken => {
                                    tracing::debug!("[Relay] a session frame was out of order; closing");
                                    break 'serve End::Done;
                                }
                            },
                        };
                        if to_handler.is_none() {
                            let Some(tx) = from_tx.take() else { break 'serve End::Done };
                            let (in_tx, in_rx) = mpsc::channel::<Message>(QUEUE);
                            let adapter = Adapter { rx: in_rx, tx: PollSender::new(tx) };
                            let peer = Peer {
                                source: format!("relay:{ch}"),
                                relay: true,
                                ..Peer::default()
                            };
                            tokio::spawn(server::serve_socket_as(c.clone(), adapter, peer));
                            to_handler = Some(in_tx);
                        }
                        let Some(tx) = &to_handler else { break 'serve End::Done };
                        if tx.send(Message::Text(text)).await.is_err() {
                            // The handler has finished with this phone.
                            break 'serve End::Done;
                        }
                    }
                }
            }
            msg = from_handler.recv(), if room => match msg {
                Some(Message::Text(text)) => {
                    // Over the relay's limit, a frame is trimmed first (`fit`).
                    let Some(text) = super::fit::fit(text) else { continue };
                    let welcome = !authed && is_welcome(&text);
                    let framed = match sess.as_mut() {
                        None => text,
                        Some(s) => match s.wrap(&text) {
                            Some(f) => f,
                            // Over the byte limit with frames unacked: wait for acks.
                            None if s.has_unacked() => {
                                held = Some(text);
                                continue;
                            }
                            None => {
                                tracing::warn!("[Relay] a frame over the session's byte limit; ending its session");
                                break 'serve End::Done;
                            }
                        },
                    };
                    if !seal_out(&mut keys, ch, out, framed.as_bytes()).await {
                        break 'serve End::Done;
                    }
                    if welcome {
                        authed = true;
                        if out.send(Out::Authed(ch, generation)).await.is_err() {
                            break 'serve End::Done;
                        }
                    }
                }
                Some(Message::Close(_)) | None => break 'serve End::Done,
                // A WebSocket ping is for proxies on a socket's path; the
                // relay link has its own keep-alive.
                Some(_) => {}
            },
            Some(text) = plain_rx.recv() => {
                heard = Instant::now();
                if !seal_out(&mut keys, ch, out, text.as_bytes()).await {
                    break 'serve End::Done;
                }
            }
        }
    };

    // The phone's socket went, not the phone: keep its handler for it.
    match sess {
        Some(s) if matches!(end, End::Park) && to_handler.is_some() => {
            session::park(s, to_handler, from_handler, authed);
        }
        Some(s) => session::forget(&s.sid),
        None => {}
    }
}

/// How a channel's loop ended.
enum End {
    /// Over: close the handler.
    Done,
    /// The socket went; the session may come back.
    Park,
}
