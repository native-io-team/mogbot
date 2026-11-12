//! The Mac's one WebSocket to the relay (docs/relay.md, "Mac ↔ relay").
//!
//! While the phone server is on: sign in (the relay's challenge, signed with
//! the identity key), then carry every phone's channel over the one socket.
//! A dropped link comes back with a capped, jittered backoff; a ping goes
//! every 30 s and 75 s of silence counts as dead; after the Mac wakes the
//! link is made again at once, since the old socket is almost always gone.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::super::Companion;
use super::channel::{self, Out};
use super::{crypto, mac_url, parse_account, Account, Command, Link};

/// A ping this often keeps the link (and the relay's view of it) alive.
pub const PING_EVERY: Duration = Duration::from_secs(30);
/// Nothing at all from the relay for this long: the link is dead.
pub const DEAD_AFTER: Duration = Duration::from_secs(75);
/// Connecting and each step of signing in must take no longer than this.
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
/// The backoff between attempts, doubling from the first to the last.
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// How often the wall clock is compared with the monotonic one, and how far
/// apart they must drift to mean the Mac slept.
const WAKE_TICK: Duration = Duration::from_secs(5);
const WOKE_AFTER: Duration = Duration::from_secs(15);
/// Phones at once (the relay allows 8; a few to spare for ones closing).
const MAX_CHANNELS: usize = 16;
/// Payloads queued for one channel before it's taken as stuck and closed.
const CHANNEL_QUEUE: usize = 256;
/// The largest message from the relay (a phone payload is at most 256 KiB).
const MAX_MESSAGE: usize = 1024 * 1024;

/// Where to sign in and what to serve HTTP from.
#[derive(Debug, Clone)]
pub struct Config {
    /// `wss://host` (or a local `ws://`).
    pub base: String,
    /// The loopback companion server, for HTTP over a channel. `None`: HTTP
    /// requests get a 404 (tests that don't start a server).
    pub port: Option<u16>,
}

/// Why a session ended.
#[derive(Debug, PartialEq, Eq)]
enum Ended {
    /// Asked to stop.
    Stopped,
    /// It had signed in, so the next attempt starts from the shortest wait.
    WasUp,
    /// It never got as far as ready.
    Failed,
    /// The Mac woke: reconnect now.
    Woke,
}

/// Keep the link to `cfg.base` until `stop` fires.
pub async fn run(c: Arc<Companion>, cfg: Config, link: Arc<Link>, mut stop: oneshot::Receiver<()>) {
    let mut backoff = BACKOFF_MIN;
    link.set_running();
    changed(&c);
    loop {
        let ended = session(&c, &cfg, &link, &mut stop).await;
        if ended == Ended::Stopped {
            link.set_off();
            changed(&c);
            return;
        }
        if link.set_down() {
            tracing::info!(?ended, "[Relay] link down");
            changed(&c);
        }
        let wait = match ended {
            Ended::Stopped => return,
            Ended::Woke => Duration::ZERO,
            Ended::WasUp => {
                backoff = BACKOFF_MIN;
                jitter(backoff)
            }
            Ended::Failed => {
                let wait = jitter(backoff);
                backoff = (backoff * 2).min(BACKOFF_MAX);
                wait
            }
        };
        if wait.is_zero() {
            continue;
        }
        tokio::select! {
            _ = &mut stop => {
                link.set_off();
                changed(&c);
                return;
            }
            woke = sleep_or_wake(wait) => if woke {
                tracing::info!("[Relay] Mac woke; reconnecting now");
                backoff = BACKOFF_MIN;
            },
        }
    }
}

/// Between half and all of `d`, so many Macs dropped at once don't come
/// back in step.
fn jitter(d: Duration) -> Duration {
    let mut b = [0u8; 4];
    let r = if getrandom::getrandom(&mut b).is_ok() {
        u32::from_le_bytes(b)
    } else {
        u32::MAX / 2
    };
    let ms = d.as_millis() as u64;
    Duration::from_millis(ms / 2 + (r as u64 % (ms / 2 + 1)))
}

/// Sleep `d`, or less if the Mac wakes meanwhile (true).
async fn sleep_or_wake(d: Duration) -> bool {
    let until = Instant::now() + d;
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        if woke_during(left.min(WAKE_TICK)).await {
            return true;
        }
    }
}

/// Sleep `d` and say whether the wall clock moved far more than that (the
/// monotonic clock stops while the Mac sleeps).
async fn woke_during(d: Duration) -> bool {
    let before = SystemTime::now();
    tokio::time::sleep(d).await;
    let wall = SystemTime::now().duration_since(before).unwrap_or_default();
    wall >= d + WOKE_AFTER
}

/// The desk and the phones hear the routes changed.
fn changed(c: &Arc<Companion>) {
    c.backend.changed();
    let c = c.clone();
    tokio::spawn(async move {
        super::super::router::refresh_status(&c).await;
    });
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The next text message, within the step timeout.
async fn next_text(ws: &mut Ws) -> Option<String> {
    tokio::time::timeout(STEP_TIMEOUT, async {
        loop {
            match ws.next().await? {
                Ok(Message::Text(t)) => return Some(t),
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()?
}

/// Connect and sign in. `None` for anything short of `ready`; with it, the
/// account the relay has this Mac's key linked to.
async fn sign_in(c: &Companion, base: &str) -> Option<(Ws, String, Option<Account>)> {
    let Some(identity) = c.registry.identity() else {
        tracing::warn!("[Relay] no identity key yet (Keychain locked?); trying again later");
        return None;
    };
    let fingerprint = identity.fingerprint();
    let url = mac_url(base, &fingerprint);
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE),
        max_frame_size: Some(MAX_MESSAGE),
        ..Default::default()
    };
    let connect = tokio_tungstenite::connect_async_with_config(&url, Some(config), false);
    let (mut ws, _) = match tokio::time::timeout(STEP_TIMEOUT, connect).await {
        Ok(Ok(ok)) => ok,
        Ok(Err(e)) => {
            tracing::debug!("[Relay] couldn't connect: {e}");
            return None;
        }
        Err(_) => {
            tracing::debug!("[Relay] connecting timed out");
            return None;
        }
    };
    let challenge: Value = serde_json::from_str(&next_text(&mut ws).await?).ok()?;
    if challenge["t"] != "challenge" {
        return None;
    }
    let auth = crypto::login_auth(&identity, challenge["nonce"].as_str()?)?;
    ws.send(Message::Text(auth)).await.ok()?;
    let ready: Value = serde_json::from_str(&next_text(&mut ws).await?).ok()?;
    if ready["t"] != "ready" {
        tracing::warn!("[Relay] the relay didn't accept this Mac's sign-in");
        return None;
    }
    let account = parse_account(&ready["account"]);
    Some((ws, fingerprint, account))
}

struct Open {
    tx: mpsc::Sender<Vec<u8>>,
    generation: u64,
    /// Bytes queued for the channel and not yet taken.
    queued: Arc<AtomicUsize>,
}

impl Open {
    /// Queue one payload for the channel; false when it's stuck (its queue
    /// full, or [`channel::MAX_QUEUED_BYTES`] already waiting).
    fn offer(&self, payload: Vec<u8>) -> bool {
        let n = payload.len();
        let before = self.queued.fetch_add(n, Ordering::SeqCst);
        if before + n > channel::MAX_QUEUED_BYTES || self.tx.try_send(payload).is_err() {
            self.queued.fetch_sub(n, Ordering::SeqCst);
            return false;
        }
        true
    }
}

async fn session(
    c: &Arc<Companion>,
    cfg: &Config,
    link: &Arc<Link>,
    stop: &mut oneshot::Receiver<()>,
) -> Ended {
    let signed_in = tokio::select! {
        s = sign_in(c, &cfg.base) => s,
        _ = &mut *stop => return Ended::Stopped,
    };
    let Some((mut ws, fingerprint, account)) = signed_in else {
        return Ended::Failed;
    };
    let (cmd_tx, mut commands) = mpsc::channel::<Command>(8);
    let linked = account.is_some();
    if link.set_up(&cfg.base, &fingerprint, account, cmd_tx) {
        tracing::info!(linked, "[Relay] link up");
        changed(c);
    }

    let (out_tx, mut out_rx) = mpsc::channel::<Out>(CHANNEL_QUEUE);
    let mut open: HashMap<u32, Open> = HashMap::new();
    let mut generation = 0u64;
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let mut wake = tokio::time::interval(WAKE_TICK);
    wake.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut wall = SystemTime::now();

    let ended = loop {
        tokio::select! {
            _ = &mut *stop => {
                let _ = ws.send(Message::Close(None)).await;
                break Ended::Stopped;
            }
            incoming = ws.next() => {
                last_heard = Instant::now();
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if text == "pong" || text == "ping" {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                        if v["t"] == "account" {
                            let account = parse_account(&v["account"]);
                            let linked = account.is_some();
                            if link.set_account(account) {
                                tracing::info!(linked, "[Relay] the account changed");
                                changed(c);
                            }
                            continue;
                        }
                        let Some(ch) = v["ch"].as_u64().and_then(|n| u32::try_from(n).ok()) else { continue };
                        match v["t"].as_str() {
                            Some("open") => {
                                if open.len() >= MAX_CHANNELS {
                                    let _ = ws.send(close_text(ch)).await;
                                    continue;
                                }
                                generation += 1;
                                let (tx, rx) = mpsc::channel::<Vec<u8>>(CHANNEL_QUEUE);
                                let queued = Arc::new(AtomicUsize::new(0));
                                let inbound = channel::Inbound::new(rx, queued.clone());
                                // A number reused: the old one is gone.
                                open.insert(ch, Open { tx, generation, queued });
                                tokio::spawn(channel::run(c.clone(), ch, generation, cfg.port, inbound, out_tx.clone()));
                            }
                            Some("close") => {
                                open.remove(&ch);
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if data.len() < 4 {
                            continue;
                        }
                        let ch = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                        let Some(o) = open.get(&ch) else { continue };
                        if !o.offer(data[4..].to_vec()) {
                            // A phone sending faster than its channel is served.
                            open.remove(&ch);
                            let _ = ws.send(close_text(ch)).await;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        tracing::info!(?frame, "[Relay] the relay closed the link");
                        break Ended::WasUp;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        tracing::debug!("[Relay] link error: {e}");
                        break Ended::WasUp;
                    }
                    None => break Ended::WasUp,
                }
            }
            Some(out) = out_rx.recv() => match out {
                Out::Payload(ch, payload) => {
                    if !open.contains_key(&ch) {
                        continue;
                    }
                    let mut data = Vec::with_capacity(payload.len() + 4);
                    data.extend_from_slice(&ch.to_be_bytes());
                    data.extend_from_slice(&payload);
                    if ws.send(Message::Binary(data)).await.is_err() {
                        break Ended::WasUp;
                    }
                }
                Out::Ended(ch, generation) => {
                    // Still open on the relay's side: close the phone's socket.
                    if open.get(&ch).is_some_and(|o| o.generation == generation) {
                        open.remove(&ch);
                        if ws.send(close_text(ch)).await.is_err() {
                            break Ended::WasUp;
                        }
                    }
                }
            },
            Some(cmd) = commands.recv() => {
                let (frame, ack, unlink) = match cmd {
                    Command::LinkStart(code, ack) => (json!({ "t": "linkStart", "code": code }), ack, false),
                    Command::Unlink(ack) => (json!({ "t": "unlink" }), ack, true),
                };
                let sent = ws.send(Message::Text(frame.to_string())).await.is_ok();
                if sent && unlink && link.set_account(None) {
                    // Gone at the relay with this frame: the desk says so now.
                    changed(c);
                }
                let _ = ack.send(sent);
                if !sent {
                    break Ended::WasUp;
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() >= DEAD_AFTER {
                    tracing::info!("[Relay] nothing from the relay for {:?}; reconnecting", DEAD_AFTER);
                    break Ended::WasUp;
                }
                if ws.send(Message::Text("ping".into())).await.is_err() {
                    break Ended::WasUp;
                }
            }
            _ = wake.tick() => {
                let now = SystemTime::now();
                let gap = now.duration_since(wall).unwrap_or_default();
                wall = now;
                if gap >= WAKE_TICK + WOKE_AFTER {
                    break Ended::Woke;
                }
                if last_heard.elapsed() >= DEAD_AFTER {
                    break Ended::WasUp;
                }
            }
        }
    };
    // Every channel's sender goes with the map: their tasks end, and each
    // socket handler sees its phone go.
    drop(open);
    ended
}

fn close_text(ch: u32) -> Message {
    Message::Text(json!({ "t": "close", "ch": ch }).to_string())
}

// ---- The app's link -----------------------------------------------------------

static RUNNING: LazyLock<Mutex<Option<oneshot::Sender<()>>>> = LazyLock::new(|| Mutex::new(None));

/// Start the app's link (idempotent) while the phone server is on at
/// `port`. Does nothing when this build has no relay.
pub fn start(c: Arc<Companion>, port: u16) {
    let Some(base) = super::relay_url() else {
        return;
    };
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if running.as_ref().is_some_and(|tx| !tx.is_closed()) {
        return;
    }
    let (tx, rx) = oneshot::channel();
    *running = Some(tx);
    tracing::info!(relay = %base, "[Relay] starting the link");
    let cfg = Config {
        base,
        port: Some(port),
    };
    tauri::async_runtime::spawn(run(c, cfg, super::LINK.clone(), rx));
}

/// Stop the app's link: the phone server went off.
pub fn stop() {
    let running = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(tx) = running {
        let _ = tx.send(());
    }
    super::LINK.set_off();
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
