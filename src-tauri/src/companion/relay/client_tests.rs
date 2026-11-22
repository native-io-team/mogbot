//! The relay link end to end: a fake relay on loopback (the wire of
//! docs/relay.md, "Mac ↔ relay" and "Phone ↔ relay"), the real Mac code, and
//! a phone made of the same crypto the app uses.

use super::*;
use base64::Engine;
use ring::signature::{UnparsedPublicKey, ED25519};
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use super::super::super::identity::fingerprint_of;
use super::super::super::now_ms;
use super::super::super::testkit::Stub;
use super::super::super::wire::{BuildKind, DevicePlatform, PairDevice, RouteKind};
use super::super::crypto::MacChannel;
use super::super::{RelayState, SECRET_HEADER};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const WAIT: Duration = Duration::from_secs(5);

// ---- A fake relay ---------------------------------------------------------------

#[derive(Default)]
struct Shared {
    mac: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    phones: Mutex<HashMap<u32, mpsc::UnboundedSender<Message>>>,
    next: AtomicU32,
    /// When set, pings go unanswered: a path that went quiet.
    mute: std::sync::atomic::AtomicBool,
    /// Offer the resumable framing at login (docs/relay.md, "Resuming").
    resume: std::sync::atomic::AtomicBool,
    /// Taking frames from the Mac and saying nothing back: a path gone dead.
    deaf: std::sync::atomic::AtomicBool,
    /// Drops the Mac's connection without a close frame.
    cut: tokio::sync::Notify,
    /// Acks arrive late, as over a real uplink: the Mac's send buffer and the
    /// path hold megabytes the relay hasn't seen yet (macOS autotunes a
    /// socket's send buffer up to 4 MB).
    slow_acks: std::sync::atomic::AtomicBool,
    /// Per channel, the resumable counters and what the Mac hasn't acked.
    chans: Mutex<HashMap<u32, Chan>>,
}

#[derive(Default)]
struct Chan {
    /// The last sequence given to a phone→Mac frame, and taken from the Mac.
    tx: u32,
    rx: u32,
    held: Vec<(u32, Vec<u8>)>,
}

fn seq_bytes(ch: u32, seq: u32, payload: &[u8]) -> Vec<u8> {
    let mut f = ch.to_be_bytes().to_vec();
    f.extend_from_slice(&seq.to_be_bytes());
    f.extend_from_slice(payload);
    f
}

struct Fake {
    port: u16,
    shared: Arc<Shared>,
    /// Every text frame the Mac sent after `ready`, but pings.
    said: mpsc::UnboundedReceiver<Value>,
}

impl Fake {
    fn base(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }

    fn to_mac(&self, v: Value) {
        let mac = self.shared.mac.lock().unwrap().clone().expect("a Mac");
        mac.send(Message::Text(v.to_string())).unwrap();
    }

    /// The next thing the Mac said with this `t`, skipping others.
    async fn heard(&mut self, t: &str) -> Value {
        tokio::time::timeout(WAIT, async {
            loop {
                let v = self.said.recv().await.expect("the relay is up");
                if v["t"] == t {
                    return v;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the Mac never said {t}"))
    }
}

/// A relay that accepts a Mac whose signature checks out, answering `ready`
/// with `account`.
async fn fake_relay(account: Value) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared = Arc::new(Shared::default());
    let (said_tx, said) = mpsc::unbounded_channel();
    let s = shared.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(relay_conn(
                stream,
                s.clone(),
                said_tx.clone(),
                account.clone(),
            ));
        }
    });
    Fake { port, shared, said }
}

async fn relay_conn(
    stream: tokio::net::TcpStream,
    shared: Arc<Shared>,
    said: mpsc::UnboundedSender<Value>,
    account: Value,
) {
    let path = Arc::new(Mutex::new(String::new()));
    let p = path.clone();
    let callback = move |req: &Request, res: Response| {
        *p.lock().unwrap() = req.uri().path().to_string();
        Ok(res)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    let path = path.lock().unwrap().clone();
    if let Some(fp) = path.strip_prefix("/v1/mac/") {
        relay_mac(ws, fp.to_string(), shared, said, account).await;
    } else if path.starts_with("/v1/phone/") {
        relay_phone(ws, shared).await;
    }
}

async fn relay_mac(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    fingerprint: String,
    shared: Arc<Shared>,
    said: mpsc::UnboundedSender<Value>,
    account: Value,
) {
    let (mut tx, mut rx) = ws.split();
    let nonce = B64.encode([5u8; 32]);
    tx.send(Message::Text(
        json!({ "t": "challenge", "nonce": nonce }).to_string(),
    ))
    .await
    .unwrap();
    let Some(Ok(Message::Text(auth))) = rx.next().await else {
        return;
    };
    let auth: Value = serde_json::from_str(&auth).unwrap();
    let key = B64.decode(auth["publicKey"].as_str().unwrap()).unwrap();
    let sig = B64.decode(auth["signature"].as_str().unwrap()).unwrap();
    let message = crypto::login_message(&nonce, &fingerprint);
    let ok = auth["t"] == "auth"
        && auth["v"] == 1
        && fingerprint_of(&key) == fingerprint
        && UnparsedPublicKey::new(&ED25519, &key)
            .verify(message.as_bytes(), &sig)
            .is_ok();
    if !ok {
        let _ = tx
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::from(4401),
                reason: "unauthorized".into(),
            })))
            .await;
        return;
    }
    let resumable = auth["resume"] == 1 && shared.resume.load(Ordering::SeqCst);
    let ready = if resumable {
        json!({ "t": "ready", "account": account, "resume": true })
    } else {
        json!({ "t": "ready", "account": account })
    };
    tx.send(Message::Text(ready.to_string())).await.unwrap();
    let (mac_tx, mut mac_rx) = mpsc::unbounded_channel::<Message>();
    *shared.mac.lock().unwrap() = Some(mac_tx.clone());
    tokio::spawn(async move {
        while let Some(m) = mac_rx.recv().await {
            if tx.send(m).await.is_err() {
                break;
            }
        }
    });
    loop {
        let msg = tokio::select! {
            m = rx.next() => match m { Some(Ok(m)) => m, _ => break },
            _ = shared.cut.notified() => break,
        };
        if resumable && shared.deaf.load(Ordering::SeqCst) {
            // Nothing this Mac says gets anywhere, and it hears nothing.
            continue;
        }
        match msg {
            Message::Text(t) if resumable && t.contains("\"resume\"") => {
                let v: Value = serde_json::from_str(&t).unwrap();
                let mine: HashMap<u32, u32> = v["chs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| {
                        (
                            e["ch"].as_u64().unwrap() as u32,
                            e["rx"].as_u64().unwrap() as u32,
                        )
                    })
                    .collect();
                let mut chans = shared.chans.lock().unwrap();
                let mut answer = vec![];
                let mut replay = vec![];
                for (ch, c) in chans.iter_mut() {
                    let Some(macrx) = mine.get(ch) else { continue };
                    c.held.retain(|(s, _)| s > macrx);
                    answer.push(json!({ "ch": ch, "rx": c.rx }));
                    replay.extend(c.held.iter().map(|(_, f)| f.clone()));
                }
                let _ = mac_tx.send(Message::Text(
                    json!({ "t": "resumed", "chs": answer }).to_string(),
                ));
                for f in replay {
                    let _ = mac_tx.send(Message::Binary(f));
                }
            }
            Message::Text(t) if resumable && t.contains("\"ack\"") => {
                let v: Value = serde_json::from_str(&t).unwrap();
                let ch = v["ch"].as_u64().unwrap() as u32;
                let seq = v["seq"].as_u64().unwrap() as u32;
                if let Some(c) = shared.chans.lock().unwrap().get_mut(&ch) {
                    c.held.retain(|(s, _)| *s > seq);
                }
            }
            Message::Binary(data) if resumable => {
                let ch = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                let seq = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
                let mut chans = shared.chans.lock().unwrap();
                let Some(c) = chans.get_mut(&ch) else {
                    continue;
                };
                if seq <= c.rx {
                    continue;
                }
                assert_eq!(seq, c.rx + 1, "the Mac left a hole");
                c.rx = seq;
                if let Some(phone) = shared.phones.lock().unwrap().get(&ch) {
                    let _ = phone.send(Message::Binary(data[8..].to_vec()));
                }
                if seq % 8 == 0 {
                    let ack =
                        Message::Text(json!({ "t": "ack", "ch": ch, "seq": seq }).to_string());
                    if shared.slow_acks.load(Ordering::SeqCst) {
                        let late = mac_tx.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            let _ = late.send(ack);
                        });
                    } else {
                        let _ = mac_tx.send(ack);
                    }
                }
            }
            Message::Text(t) if t == "ping" => {
                if !shared.mute.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = mac_tx.send(Message::Text("pong".into()));
                }
            }
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["t"] == "close" {
                    let ch = v["ch"].as_u64().unwrap() as u32;
                    if let Some(phone) = shared.phones.lock().unwrap().remove(&ch) {
                        let _ = phone.send(Message::Close(Some(CloseFrame {
                            code: CloseCode::Normal,
                            reason: "closed".into(),
                        })));
                    }
                }
                let _ = said.send(v);
            }
            Message::Binary(data) => {
                let ch = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                if let Some(phone) = shared.phones.lock().unwrap().get(&ch) {
                    let _ = phone.send(Message::Binary(data[4..].to_vec()));
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    *shared.mac.lock().unwrap() = None;
}

async fn relay_phone(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    shared: Arc<Shared>,
) {
    let (mut tx, mut rx) = ws.split();
    let Some(mac) = shared.mac.lock().unwrap().clone() else {
        let _ = tx
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::from(4404),
                reason: "mac_offline".into(),
            })))
            .await;
        return;
    };
    let ch = shared.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (phone_tx, mut phone_rx) = mpsc::unbounded_channel::<Message>();
    shared.phones.lock().unwrap().insert(ch, phone_tx);
    if shared.resume.load(Ordering::SeqCst) {
        shared.chans.lock().unwrap().insert(ch, Chan::default());
    }
    mac.send(Message::Text(json!({ "t": "open", "ch": ch }).to_string()))
        .unwrap();
    tokio::spawn(async move {
        while let Some(m) = phone_rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if tx.send(m).await.is_err() || close {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = rx.next().await {
        match msg {
            Message::Binary(data) if shared.resume.load(Ordering::SeqCst) => {
                let framed = {
                    let mut chans = shared.chans.lock().unwrap();
                    let c = chans.entry(ch).or_default();
                    c.tx += 1;
                    let framed = seq_bytes(ch, c.tx, &data);
                    c.held.push((c.tx, framed.clone()));
                    framed
                };
                // To whoever is the Mac now; held until it acks either way.
                let now = shared.mac.lock().unwrap().clone();
                if let Some(now) = now {
                    let _ = now.send(Message::Binary(framed));
                }
            }
            Message::Binary(data) => {
                let mut framed = ch.to_be_bytes().to_vec();
                framed.extend_from_slice(&data);
                let _ = mac.send(Message::Binary(framed));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    // Gone from its own side: the Mac is told (unless the Mac closed it).
    if shared.phones.lock().unwrap().remove(&ch).is_some() {
        let _ = mac.send(Message::Text(json!({ "t": "close", "ch": ch }).to_string()));
    }
}

// ---- A phone on the relay ---------------------------------------------------------

type PhoneWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Phone {
    ws: PhoneWs,
    keys: MacChannel,
}

impl Phone {
    /// Through the relay to the Mac, with the end-to-end handshake done
    /// against the pinned fingerprint.
    async fn connect(url: &str, pinned: &str) -> Phone {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let secret = crypto::fresh_secret().unwrap();
        ws.send(Message::Binary(crypto::phone::hello(&secret).into_bytes()))
            .await
            .unwrap();
        let answer = loop {
            match tokio::time::timeout(WAIT, ws.next()).await.unwrap() {
                Some(Ok(Message::Binary(b))) => break b,
                Some(Ok(_)) => continue,
                other => panic!("no answer to the hello: {other:?}"),
            }
        };
        let keys = crypto::phone::finish(&secret, &answer, pinned).expect("the Mac's own key");
        Phone { ws, keys }
    }

    async fn send(&mut self, v: Value) {
        let sealed = self.keys.outgoing.seal(v.to_string().as_bytes()).unwrap();
        self.ws.send(Message::Binary(sealed)).await.unwrap();
    }

    /// The next frame from the Mac, or `{"t":"closed"}`.
    async fn next(&mut self) -> Value {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next())
                .await
                .expect("a frame within 5 s")
            {
                Some(Ok(Message::Binary(b))) => {
                    let plain = self.keys.incoming.open(&b).expect("a frame that opens");
                    return serde_json::from_slice(&plain).unwrap();
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    return json!({ "t": "closed" })
                }
                Some(Ok(_)) => continue,
            }
        }
    }

    /// The next frame with this `t` (skipping events and others).
    async fn next_of(&mut self, t: &str) -> Value {
        loop {
            let f = self.next().await;
            if f["t"] == t {
                return f;
            }
            assert_ne!(f["t"], "closed", "closed while waiting for {t}");
        }
    }
}

fn challenge() -> Value {
    json!({
        "t": "challenge",
        "protocol": { "min": 2, "max": 2 },
        "challenge": "c2lnbiBtZSBwbGVhc2UsIGEgcGhvbmUgY2hvc2UgbWU"
    })
}

fn hello(token: &str) -> Value {
    json!({
        "t": "hello",
        "protocol": { "min": 2, "max": 2 },
        "token": token,
        "app": { "version": "1.0.0", "runtimeVersion": "1" },
        "foreground": true
    })
}

fn device() -> PairDevice {
    PairDevice {
        name: "Test Phone".into(),
        platform: DevicePlatform::Ios,
        model: Some("iPhone 16".into()),
        app_version: "1.0.0".into(),
        build: BuildKind::Official,
    }
}

/// The loopback companion server, as the app runs it.
async fn loopback(c: Arc<Companion>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(super::super::super::server::serve(c, listener, rx));
    std::mem::forget(tx);
    port
}

async fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !ok() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn http_body(f: &Value) -> Value {
    serde_json::from_slice(&B64.decode(f["body"].as_str().unwrap_or("")).unwrap()).unwrap()
}

// ---- The tests ------------------------------------------------------------------

#[tokio::test]
async fn a_phone_reaches_the_mac_through_the_relay_end_to_end() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    // Paired over Tailscale by a tailnet user: over the relay there's no
    // login to match, and the token alone is enough.
    let (record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;

    let mut relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));

    // Signed in, with the account the relay named.
    until("the link", || link.status().state == RelayState::Connected).await;
    let status = link.status();
    assert_eq!(status.account.as_ref().unwrap().id, "user_1");
    assert_eq!(
        status.account.as_ref().unwrap().email.as_deref(),
        Some("j@x.com")
    );
    let route = link.route().unwrap();
    assert_eq!(route.kind, RouteKind::Relay);
    assert_eq!(
        route.url,
        format!("{}/v1/phone/{fingerprint}", relay.base())
    );
    assert_eq!(link.host().as_deref(), Some("127.0.0.1"));

    // A phone: the end-to-end handshake, then the companion protocol.
    let mut phone = Phone::connect(&route.url, &fingerprint).await;
    phone.send(challenge()).await;
    let identity = phone.next().await;
    assert_eq!(identity["t"], "identity", "{identity}");
    phone.send(hello(&token)).await;
    let welcome = phone.next().await;
    assert_eq!(welcome["t"], "welcome", "{welcome}");
    assert_eq!(welcome["deviceId"], record.id.as_str());
    // Welcomed: the Mac tells the relay, which then never evicts this
    // channel to make room for strangers (CTO review 2026-11-14).
    let authed = relay.heard("authed").await;
    assert!(authed["ch"].as_u64().is_some(), "{authed}");
    until("the phone connected", || c.is_connected(&record.id)).await;
    assert_eq!(
        c.registry.get(&record.id).unwrap().last_route,
        Some(RouteKind::Relay)
    );

    // One request.
    phone
        .send(json!({ "t": "req", "id": 7, "method": "rooms.list", "params": {} }))
        .await;
    let res = loop {
        let f = phone.next_of("res").await;
        if f["id"] == 7 {
            break f;
        }
    };
    assert_eq!(res["ok"], true, "{res}");

    // HTTP over the same channel: the Mac's identity, signed.
    let ask = json!({ "protocol": { "min": 2, "max": 2 }, "challenge": challenge()["challenge"] });
    phone
        .send(json!({
            "t": "http", "id": 1, "method": "POST", "path": "/v1/identity",
            "headers": { "content-type": "application/json" },
            "body": B64.encode(ask.to_string()),
        }))
        .await;
    let res = phone.next_of("httpRes").await;
    assert_eq!(res["id"], 1);
    assert_eq!(res["status"], 200, "{res}");
    let body = http_body(&res);
    assert_eq!(body["ok"], true, "{body}");
    assert_eq!(
        body["identity"]["publicKey"],
        c.registry.identity().unwrap().public_key()
    );

    // A file request is checked by its token alone (no tailnet login over
    // the relay): past authorization to "no such file", never a 401.
    phone
        .send(json!({
            "t": "http", "id": 2, "method": "GET", "path": "/v1/blobs/blob_missing",
            "headers": { "authorization": format!("Bearer {token}") },
        }))
        .await;
    let res = phone.next_of("httpRes").await;
    assert_eq!(res["id"], 2);
    assert_eq!(res["status"], 404, "{res}");
    // Without the token it is refused, relay or not.
    phone
        .send(json!({ "t": "http", "id": 3, "method": "GET", "path": "/v1/blobs/blob_missing" }))
        .await;
    assert_eq!(phone.next_of("httpRes").await["status"], 401);
    // A phone can't set the relay's secret itself, nor reach the socket by HTTP.
    phone
        .send(json!({
            "t": "http", "id": 4, "method": "GET", "path": "/v1/ws",
            "headers": { SECRET_HEADER.as_str(): "guess" },
        }))
        .await;
    assert_eq!(phone.next_of("httpRes").await["status"], 404);

    // The phone goes: the relay tells the Mac, and its socket handler ends.
    phone.ws.close(None).await.unwrap();
    until("the phone gone", || !c.is_connected(&record.id)).await;

    // The Mac ends a channel: a phone it refuses is closed at the relay too.
    let mut stranger = Phone::connect(&route.url, &fingerprint).await;
    stranger.send(challenge()).await;
    assert_eq!(stranger.next().await["t"], "identity");
    stranger.send(hello("not-a-token")).await;
    let refused = stranger.next().await;
    assert_eq!(refused["t"], "refused", "{refused}");
    let closed = relay.heard("close").await;
    assert!(closed["ch"].as_u64().is_some());
    assert_eq!(stranger.next().await["t"], "closed");

    // Sign in: the code goes on the socket, the page to open comes back.
    let page = link.link_start().await.unwrap();
    let sent = relay.heard("linkStart").await;
    let code = sent["code"].as_str().unwrap();
    // `<fingerprint>.<32 random bytes>`, as the relay's /v1/link reads it.
    let (fp, secret) = code.split_once('.').unwrap();
    assert_eq!(fp, fingerprint);
    assert_eq!(B64.decode(secret).unwrap().len(), 32);
    assert_eq!(
        page,
        format!("http://127.0.0.1:{}/link?code={code}", relay.port)
    );

    // The relay says the account changed, then that it's gone.
    relay.to_mac(json!({ "t": "account", "account": { "id": "user_2", "email": "k@x.com" } }));
    until("the new account", || {
        link.status().account.is_some_and(|a| a.id == "user_2")
    })
    .await;
    relay.to_mac(json!({ "t": "account", "account": null }));
    until("no account", || link.status().account.is_none()).await;
    assert!(link.route().is_none(), "no account, no relay route");
    assert_eq!(link.status().state, RelayState::Connected);

    // Sign out.
    relay.to_mac(json!({ "t": "account", "account": { "id": "user_2", "email": "k@x.com" } }));
    until("signed in again", || link.status().account.is_some()).await;
    link.unlink().await.unwrap();
    relay.heard("unlink").await;
    assert!(link.status().account.is_none());

    // Delete the account: refused when not signed in, then the relay's
    // answer settles it either way.
    assert!(link.delete_account().await.is_err(), "not signed in");
    relay.to_mac(json!({ "t": "account", "account": { "id": "user_2", "email": "k@x.com" } }));
    until("signed in to delete", || link.status().account.is_some()).await;
    let failing = {
        let link = link.clone();
        tokio::spawn(async move { link.delete_account().await })
    };
    relay.heard("deleteAccount").await;
    relay.to_mac(json!({ "t": "accountDeleted", "ok": false, "error": "clerk_failed" }));
    assert!(failing.await.unwrap().is_err());
    assert!(
        link.status().account.is_some(),
        "a failed delete keeps the account"
    );
    let deleting = {
        let link = link.clone();
        tokio::spawn(async move { link.delete_account().await })
    };
    relay.heard("deleteAccount").await;
    relay.to_mac(json!({ "t": "accountDeleted", "ok": true }));
    deleting.await.unwrap().unwrap();
    assert!(link.status().account.is_none());

    // Off.
    stop_tx.send(()).unwrap();
    until("off", || {
        link.status() == super::super::RelayStatus::default()
    })
    .await;
}

#[tokio::test]
async fn a_mac_with_no_account_is_up_but_offers_no_route() {
    let (c, _stub) = Stub::companion();
    let relay = fake_relay(Value::Null).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: None,
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    assert!(link.status().account.is_none());
    assert!(link.route().is_none());
    // Its host is still signed: a phone that reaches it hears 4402 from the
    // relay, not "this isn't your Mac".
    assert!(link.host().is_some());
    stop_tx.send(()).unwrap();
}

#[test]
fn backoff_is_jittered_within_half_to_all() {
    for _ in 0..100 {
        let d = jitter(Duration::from_secs(8));
        assert!(
            d >= Duration::from_secs(4) && d <= Duration::from_secs(8),
            "{d:?}"
        );
    }
    assert!(PING_EVERY < DEAD_AFTER);
}

#[tokio::test]
async fn a_stranger_who_only_shakes_hands_is_closed_once_idle() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let port = loopback(c.clone()).await;
    let mut relay = fake_relay(json!({ "id": "user_1", "email": null })).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.route().is_some()).await;
    let url = link.route().unwrap().url;

    // The handshake, one quick HTTP answer, then nothing: the Mac lets the
    // relay slot go instead of holding it for whoever opened it.
    let mut stranger = Phone::connect(&url, &fingerprint).await;
    stranger
        .send(json!({ "t": "http", "id": 1, "method": "GET", "path": "/v1/nope" }))
        .await;
    assert_eq!(stranger.next_of("httpRes").await["status"], 404);
    let closed = relay.heard("close").await;
    assert!(closed["ch"].as_u64().is_some());
    assert_eq!(stranger.next().await["t"], "closed");
    stop_tx.send(()).unwrap();
}

#[test]
fn a_channel_holds_at_most_its_byte_budget() {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(CHANNEL_QUEUE);
    let queued = Arc::new(AtomicUsize::new(0));
    let o = Open::new(1, tx, 1, queued.clone());
    let piece = channel::MAX_PAYLOAD;
    let fits = channel::MAX_QUEUED_BYTES / piece;
    for _ in 0..fits {
        assert!(o.offer(vec![0; piece]));
    }
    assert!(!o.offer(vec![0; piece]), "over the budget: stuck");
    assert_eq!(queued.load(Ordering::SeqCst), fits * piece);
    drop(rx);
    assert!(!o.offer(vec![0; 1]), "nobody reading");
    assert_eq!(queued.load(Ordering::SeqCst), fits * piece);
}

#[tokio::test]
async fn a_link_the_path_silently_killed_is_made_again_within_seconds() {
    // 2026-11-18: a bare client's socket was cut on a heartbeat with no close
    // frame, and the Mac only found out a heartbeat later. A relay that stops
    // answering must be given up on after DEAD_AFTER, and the Mac signs in again.
    let (c, _stub) = Stub::companion();
    let relay = fake_relay(json!({ "id": "user_1", "email": null })).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: None,
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    // The relay's side goes quiet: nothing is answered or forwarded any more.
    relay
        .shared
        .mute
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let unmute = relay.shared.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(900)).await;
        unmute
            .mute
            .store(false, std::sync::atomic::Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    // Detected (down) and signed in again (up) well inside a few seconds.
    let mut was_down = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let up = link.status().state == RelayState::Connected;
            if !up {
                was_down = true;
            }
            if was_down && up {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the Mac never came back");
    assert!(started.elapsed() < Duration::from_secs(5));
    stop_tx.send(()).unwrap();
}

/// 2026-11-18: the link to the relay died silently every few minutes and each
/// time every phone was cut off. With the resumable framing the phone's socket
/// and its keys carry on: what the Mac said into the dead socket is sent again.
#[tokio::test]
async fn a_dead_link_is_resumed_without_the_phone_noticing() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    relay.shared.resume.store(true, Ordering::SeqCst);
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.route().is_some()).await;
    let url = link.route().unwrap().url;

    let mut phone = Phone::connect(&url, &fingerprint).await;
    phone.send(challenge()).await;
    assert_eq!(phone.next().await["t"], "identity");
    phone.send(hello(&token)).await;
    assert_eq!(phone.next().await["t"], "welcome");

    let ask = |id: u64| json!({ "t": "req", "id": id, "method": "rooms.list", "params": {} });
    phone.send(ask(1)).await;
    assert_eq!(phone.next_of("res").await["id"], 1);

    // The path goes dead: the Mac's frames vanish and nothing answers.
    relay.shared.deaf.store(true, Ordering::SeqCst);
    phone.send(ask(2)).await; // the Mac answers into the void
    until("the Mac to give the link up", || {
        link.status().state != RelayState::Connected
    })
    .await;
    relay.shared.deaf.store(false, Ordering::SeqCst);
    until("the link again", || {
        link.status().state == RelayState::Connected
    })
    .await;

    // The same phone socket, the same keys: the lost answer arrives, and a
    // new request is answered in step.
    let lost = phone.next_of("res").await;
    assert_eq!(lost["id"], 2, "{lost}");
    phone.send(ask(3)).await;
    assert_eq!(phone.next_of("res").await["id"], 3);
    stop_tx.send(()).unwrap();
}

#[tokio::test]
async fn a_relay_that_doesnt_offer_resume_gets_the_old_framing() {
    // The fake says `ready` with no `resume`: the Mac must send and take
    // 4-byte-header frames, which the end-to-end test above already shows.
    // What this holds is that it didn't keep channels across a link.
    let (c, _stub) = Stub::companion();
    let relay = fake_relay(json!({ "id": "user_1", "email": null })).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: None,
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    assert!(!relay.shared.resume.load(Ordering::SeqCst));
    stop_tx.send(()).unwrap();
}

// ---- Sessions: a phone's socket dies and it comes back (docs/relay.md) ----------

/// A phone that keeps a session: protocol frames are numbered both ways.
struct SessionPhone {
    ws: PhoneWs,
    keys: MacChannel,
    sid: String,
    tx: u64,
    rx: u64,
    resumed: bool,
}

impl SessionPhone {
    /// Connects, offering sessions; with `back` = (sid, rx, k, key) it asks for that one.
    async fn connect(url: &str, pinned: &str, back: Option<(&str, u64, u64, [u8; 32])>) -> Self {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let secret = crypto::fresh_secret().unwrap();
        let hello = crypto::phone::hello_session(
            &secret,
            back.as_ref().map(|(s, rx, k, key)| (*s, *rx, *k, key)),
        );
        ws.send(Message::Binary(hello.into_bytes())).await.unwrap();
        let answer = loop {
            match tokio::time::timeout(WAIT, ws.next()).await.unwrap() {
                Some(Ok(Message::Binary(b))) => break b,
                Some(Ok(_)) => continue,
                other => panic!("no answer to the hello: {other:?}"),
            }
        };
        let keys = crypto::phone::finish(&secret, &answer, pinned).expect("the Mac's own key");
        assert!(keys.sessions, "the Mac offers sessions");
        let mut p = SessionPhone {
            ws,
            keys,
            sid: String::new(),
            tx: 0,
            rx: back.as_ref().map_or(0, |b| b.1),
            resumed: false,
        };
        let sess = p.raw().await;
        assert_eq!(sess["t"], "sess", "{sess}");
        p.sid = sess["sid"].as_str().unwrap().to_string();
        p.resumed = sess["resumed"] == true;
        if p.resumed {
            // What the Mac took is what it needn't be sent again.
            // The phone's own frames the Mac took: what it sends next follows them.
            p.tx = sess["rx"].as_u64().unwrap();
        }
        p
    }

    /// The next sealed plaintext, as it is on the wire.
    async fn raw(&mut self) -> Value {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next())
                .await
                .expect("a frame within 5 s")
            {
                Some(Ok(Message::Binary(b))) => {
                    let plain = self.keys.incoming.open(&b).expect("a frame that opens");
                    return serde_json::from_slice(&plain).unwrap();
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    return json!({ "t": "closed" })
                }
                Some(Ok(_)) => continue,
            }
        }
    }

    /// The next numbered protocol frame, unwrapped; repeats are dropped as the app does.
    async fn next(&mut self) -> Value {
        loop {
            let f = self.raw().await;
            if f["t"] == "q" {
                let n = f["n"].as_u64().unwrap();
                if n <= self.rx {
                    continue;
                }
                assert_eq!(n, self.rx + 1, "no holes");
                self.rx = n;
                return serde_json::from_str(f["d"].as_str().unwrap()).unwrap();
            }
            assert_ne!(f["t"], "closed", "closed while waiting");
        }
    }

    async fn send(&mut self, v: Value) {
        self.tx += 1;
        let q = json!({ "t": "q", "n": self.tx, "a": self.rx, "d": v.to_string() });
        let sealed = self.keys.outgoing.seal(q.to_string().as_bytes()).unwrap();
        self.ws.send(Message::Binary(sealed)).await.unwrap();
    }
}

impl SessionPhone {
    /// The standalone ack, as the app sends one after taking some frames.
    async fn ack(&mut self) {
        let a = json!({ "t": "a", "a": self.rx });
        let sealed = self.keys.outgoing.seal(a.to_string().as_bytes()).unwrap();
        self.ws.send(Message::Binary(sealed)).await.unwrap();
    }
}

/// A burst of more than 256 frames toward a phone that acks only after a
/// round trip (here, 250 ms of nothing, then every 8): the Mac waits for the
/// acks instead of ending the session ("a phone is too far behind"), and
/// every answer arrives once, in order, on the same session.
#[tokio::test]
async fn a_long_burst_waits_for_acks_instead_of_ending_the_session() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    let url = link.route().unwrap().url;

    let mut phone = SessionPhone::connect(&url, &fingerprint, None).await;
    phone.send(challenge()).await;
    assert_eq!(phone.next().await["t"], "identity");
    phone.send(hello(&token)).await;
    assert_eq!(phone.next().await["t"], "welcome");

    const N: u64 = 300;
    for id in 1..=N {
        phone
            .send(json!({ "t": "req", "id": id, "method": "rooms.list", "params": {} }))
            .await;
    }
    let mut answered: Vec<u64> = Vec::new();
    let mut take = |f: &Value, answered: &mut Vec<u64>| {
        if f["t"] == "res" {
            answered.push(f["id"].as_u64().unwrap());
        }
    };
    // Reading, but not acking: the round trip hasn't happened yet.
    let began = std::time::Instant::now();
    while began.elapsed() < Duration::from_millis(250) {
        if let Ok(f) = tokio::time::timeout(Duration::from_millis(50), phone.next()).await {
            take(&f, &mut answered);
        }
    }
    // Now the acks come, every 8 frames taken.
    let mut sent_ack = phone.rx;
    phone.ack().await;
    while (answered.len() as u64) < N {
        let f = phone.next().await;
        take(&f, &mut answered);
        if phone.rx >= sent_ack + 8 {
            sent_ack = phone.rx;
            phone.ack().await;
        }
    }
    let mut sorted = answered.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len() as u64, N, "every answer once");
    // Still the one session: a request is answered on it.
    phone
        .send(json!({ "t": "req", "id": 1000, "method": "rooms.list", "params": {} }))
        .await;
    let mut ok = false;
    for _ in 0..8 {
        let f = phone.next().await;
        if f["t"] == "res" && f["id"] == 1000 {
            ok = true;
            break;
        }
    }
    assert!(ok, "the session lived through the burst");
}

#[tokio::test]
async fn a_phone_that_lost_its_socket_picks_its_session_back_up() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    let url = link.route().unwrap().url;

    // A session: challenge, hello and welcome, all numbered.
    let mut phone = SessionPhone::connect(&url, &fingerprint, None).await;
    assert!(!phone.resumed);
    phone.send(challenge()).await;
    assert_eq!(phone.next().await["t"], "identity");
    phone.send(hello(&token)).await;
    assert_eq!(phone.next().await["t"], "welcome");

    // A request goes out, and the socket dies before the answer is read.
    phone
        .send(json!({ "t": "req", "id": 7, "method": "rooms.list", "params": {} }))
        .await;
    let (sid, key, rx) = (phone.sid.clone(), phone.keys.resume, phone.rx);
    drop(phone.ws);

    // The new socket proves the session and is handed what it hadn't taken,
    // under its own keys: a nonce is never reused.
    let mut back = SessionPhone::connect(&url, &fingerprint, Some((&sid, rx, 1, key))).await;
    assert!(back.resumed, "the same session");
    assert_eq!(back.sid, sid);
    let mut got = None;
    for _ in 0..8 {
        let f = back.next().await;
        if f["t"] == "res" && f["id"] == 7 {
            got = Some(f);
            break;
        }
    }
    let res = got.expect("the answer the first socket never read");
    assert_eq!(res["ok"], true, "{res}");

    // And it carries on: no new hello, the handler never noticed.
    back.send(json!({ "t": "req", "id": 8, "method": "rooms.list", "params": {} }))
        .await;
    let mut ok = false;
    for _ in 0..8 {
        let f = back.next().await;
        if f["t"] == "res" && f["id"] == 8 {
            ok = f["ok"] == true;
            break;
        }
    }
    assert!(ok, "a request after resuming is answered");

    // A hello replayed by the relay (same counter) is no session: a new one starts.
    let replay =
        SessionPhone::connect(&url, &fingerprint, Some((&sid, 0, 1, back.keys.resume))).await;
    assert!(!replay.resumed);
    assert_ne!(replay.sid, sid);
    // A proof from the wrong key is the same.
    let forged =
        SessionPhone::connect(&url, &fingerprint, Some((&back.sid, 0, 9, [0u8; 32]))).await;
    assert!(!forged.resumed);
    // Neither attempt moved the live session: it is still connected and answers.
    back.send(json!({ "t": "req", "id": 9, "method": "rooms.list", "params": {} }))
        .await;
    let mut still = false;
    for _ in 0..8 {
        let f = back.next().await;
        if f["t"] == "res" && f["id"] == 9 {
            still = f["ok"] == true;
            break;
        }
    }
    assert!(still, "a forged proof leaves the live session alone");
}

#[tokio::test]
async fn a_phone_without_sessions_gets_the_old_channel() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    let mut phone = Phone::connect(&link.route().unwrap().url, &fingerprint).await;
    assert!(!phone.keys.sessions);
    phone.send(challenge()).await;
    // Unnumbered, as before.
    assert_eq!(phone.next().await["t"], "identity");
}

// ---- The real worker -----------------------------------------------------------
//
// The same Mac code and the same phone, against the actual relay Worker
// (`services/relay`) running under `wrangler dev` (accounts off). The Mac
// reaches it through a small TCP proxy that can kill the Mac's connection the
// way a path does. Not part of the normal run:
//
//   (cd services/relay && npx wrangler dev --local --port 8799)
//   RELAY_LIVE=ws://127.0.0.1:8799 cargo test --lib relay::client_tests::live_ \
//       -- --ignored --test-threads=1 --nocapture

#[derive(Clone, Copy, PartialEq)]
enum Kill {
    /// An orderly TCP close (FIN), no WebSocket close frame.
    Fin,
    /// A reset (RST): what a dead path or a killed process leaves.
    Rst,
}

struct Proxy {
    port: u16,
    refuse: Arc<std::sync::atomic::AtomicBool>,
    kill: tokio::sync::broadcast::Sender<Kill>,
}

impl Proxy {
    async fn start(upstream: String) -> Proxy {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let refuse = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (kill, _) = tokio::sync::broadcast::channel::<Kill>(4);
        let (r, k) = (refuse.clone(), kill.clone());
        #[allow(deprecated)]
        tokio::spawn(async move {
            while let Ok((mut down, _)) = listener.accept().await {
                if r.load(Ordering::SeqCst) {
                    drop(down);
                    continue;
                }
                let Ok(mut up) = tokio::net::TcpStream::connect(&upstream).await else {
                    continue;
                };
                let mut killed = k.subscribe();
                tokio::spawn(async move {
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut down, &mut up) => {}
                        how = killed.recv() => {
                            if how == Ok(Kill::Rst) {
                                let _ = down.set_linger(Some(Duration::ZERO));
                                let _ = up.set_linger(Some(Duration::ZERO));
                            }
                        }
                    }
                });
            }
        });
        Proxy { port, refuse, kill }
    }
}

impl Phone {
    /// The next frame within `d`; `None` on silence, `{"t":"closed"}` if the socket went.
    async fn next_for(&mut self, d: Duration) -> Option<Value> {
        loop {
            match tokio::time::timeout(d, self.ws.next()).await {
                Err(_) => return None,
                Ok(Some(Ok(Message::Binary(b)))) => {
                    let plain = self.keys.incoming.open(&b).expect("a frame that opens");
                    return Some(serde_json::from_slice(&plain).unwrap());
                }
                Ok(Some(Ok(Message::Close(f)))) => {
                    println!("  phone socket closed by the relay: {f:?}");
                    return Some(json!({ "t": "closed" }));
                }
                Ok(None) | Ok(Some(Err(_))) => return Some(json!({ "t": "closed" })),
                Ok(Some(Ok(_))) => continue,
            }
        }
    }

    async fn res(&mut self, id: u64, d: Duration) -> Value {
        loop {
            let f = self
                .next_for(d)
                .await
                .unwrap_or_else(|| panic!("no answer {id} within {d:?}"));
            assert_ne!(
                f["t"], "closed",
                "the phone's socket closed waiting for {id}"
            );
            if f["t"] == "res" && f["id"] == id {
                return f;
            }
        }
    }
}

async fn live_until(what: &str, d: Duration, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + d;
    while !ok() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// One drop of the Mac's connection to the Worker, `gap` long, killed `how`.
/// `survives`: the phone's socket and keys carry on (the gap is inside the
/// Worker's 30 s grace). Otherwise the phone is let go and a fresh hello works.
async fn live_case(
    name: &str,
    how: Kill,
    gap: Duration,
    survives: bool,
    relinks_between: Option<(f32, f32)>,
) {
    let worker = std::env::var("RELAY_LIVE").expect("RELAY_LIVE=ws://127.0.0.1:8799");
    let t0 = Instant::now();
    let say = |s: &str| println!("{:7.2}s  [{name}] {s}", t0.elapsed().as_secs_f32());
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let upstream = worker.trim_start_matches("ws://").to_string();
    let proxy = Proxy::start(upstream).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: format!("ws://127.0.0.1:{}", proxy.port),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    live_until("the link", Duration::from_secs(10), || {
        link.status().state == RelayState::Connected
    })
    .await;
    say("Mac linked to the real Worker (resumable framing negotiated by the client)");

    let url = format!("{worker}/v1/phone/{fingerprint}");
    let hello_in = |url: String, fp: String, token: String| async move {
        let mut phone = Phone::connect(&url, &fp).await;
        phone.send(challenge()).await;
        assert_eq!(phone.next().await["t"], "identity");
        phone.send(hello(&token)).await;
        assert_eq!(phone.next().await["t"], "welcome");
        phone
    };
    let mut phone = hello_in(url.clone(), fingerprint.clone(), token.clone()).await;
    let ask = |id: u64| json!({ "t": "req", "id": id, "method": "rooms.list", "params": {} });
    phone.send(ask(1)).await;
    assert_eq!(phone.res(1, Duration::from_secs(5)).await["ok"], true);
    say("phone welcomed, request 1 answered");

    let was_up = link.status().state;
    assert_eq!(was_up, RelayState::Connected);
    say(&format!(
        "KILL the Mac's connection ({}), refusing it for {:?}",
        if how == Kill::Rst {
            "RST, no close frame"
        } else {
            "FIN, no close frame"
        },
        gap
    ));
    let cutter = {
        let p = (proxy.refuse.clone(), proxy.kill.clone());
        tokio::spawn(async move {
            p.0.store(true, Ordering::SeqCst);
            let _ = p.1.send(how);
            tokio::time::sleep(gap).await;
            p.0.store(false, Ordering::SeqCst);
        })
    };
    live_until("the Mac to notice", Duration::from_secs(5), || {
        link.status().state != RelayState::Connected
    })
    .await;
    say("Mac noticed: link down");
    phone.send(ask(2)).await; // sent while the Mac is away
    say("phone sent request 2 while the Mac is away");
    cutter.await.unwrap();
    say("connections allowed again");
    live_until("the link again", Duration::from_secs(20), || {
        link.status().state == RelayState::Connected
    })
    .await;
    say("Mac linked again");
    if let Some((lo, hi)) = relinks_between {
        let at = t0.elapsed().as_secs_f32();
        assert!(
            (lo..=hi).contains(&at),
            "relinked at {at:.1}s, outside {lo}-{hi}s: the case did not hit its window"
        );
    }

    if survives {
        let r = phone.res(2, Duration::from_secs(15)).await;
        assert_eq!(r["ok"], true, "{r}");
        say("request 2 (sent during the gap) answered on the SAME phone socket and keys");
        phone.send(ask(3)).await;
        assert_eq!(phone.res(3, Duration::from_secs(5)).await["ok"], true);
        say("request 3 answered; no new hello was needed");
        // Exactly once: nothing else arrives for 2 s.
        while let Some(f) = phone.next_for(Duration::from_secs(2)).await {
            assert_ne!(f["t"], "closed", "the phone's socket closed after the drop");
            assert!(
                !(f["t"] == "res" && (f["id"] == 1 || f["id"] == 2 || f["id"] == 3)),
                "a duplicate answer: {f}"
            );
        }
        say("no duplicate or extra answers");
    } else {
        let f = phone
            .next_for(Duration::from_secs(10))
            .await
            .expect("the phone should be told the channel is gone");
        assert_eq!(f["t"], "closed", "{f}");
        say("the old phone socket was closed by the Worker (past the grace)");
        let mut again = hello_in(url, fingerprint, token).await;
        again.send(ask(4)).await;
        assert_eq!(again.res(4, Duration::from_secs(5)).await["ok"], true);
        say("a fresh hello worked and request 4 was answered: clean re-hello, no hang");
    }
    stop_tx.send(()).unwrap();
    drop(proxy);
    say("PASS");
}

#[tokio::test]
#[ignore = "needs wrangler dev; see the comment above"]
async fn live_a_short_drop_with_a_tcp_close_resumes() {
    live_case("fin-5s", Kill::Fin, Duration::from_secs(5), true, None).await;
}

#[tokio::test]
#[ignore = "needs wrangler dev; see the comment above"]
async fn live_an_abrupt_reset_resumes() {
    live_case("rst-5s", Kill::Rst, Duration::from_secs(5), true, None).await;
}

#[tokio::test]
#[ignore = "needs wrangler dev; see the comment above"]
async fn live_a_gap_past_the_grace_re_hellos_cleanly() {
    live_case("rst-35s", Kill::Rst, Duration::from_secs(35), false, None).await;
}

/// The Mac is back after the Worker let the channel go (30 s) but before the
/// app lets it go itself (40 s): it still holds the channel, sends `resume`,
/// the Worker names nothing, and the phone is told and says hello again.
#[tokio::test]
#[ignore = "needs wrangler dev; see the comment above"]
async fn live_a_gap_between_the_graces_is_noticed_and_re_hellos() {
    live_case(
        "rst-32s",
        Kill::Rst,
        Duration::from_secs(32),
        false,
        Some((31.0, 39.0)),
    )
    .await;
}

/// An App Store 1.0.1 phone (the plain hello, no sessions, unnumbered frames,
/// a raw `ping` to the relay every 25 s, a `ping` frame and a read every 15 s)
/// kept for 130 s against the real Worker and this Mac's client: its channel
/// must stay open past the Worker's 60 s Mac-quiet rule and every timer.
#[tokio::test]
#[ignore = "needs the Worker under `wrangler dev` (RELAY_LIVE)"]
async fn live_an_old_phone_holds_its_channel_for_two_minutes() {
    let worker = std::env::var("RELAY_LIVE").expect("RELAY_LIVE=ws://127.0.0.1:8799");
    let t0 = Instant::now();
    let say = |s: &str| println!("{:7.2}s  [old phone] {s}", t0.elapsed().as_secs_f32());
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_r, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    tokio::spawn(run(
        c.clone(),
        Config {
            base: worker.clone(),
            port: Some(port),
        },
        link.clone(),
        stop_rx,
    ));
    live_until("the link", Duration::from_secs(10), || {
        link.status().state == RelayState::Connected
    })
    .await;
    let url = format!("{worker}/v1/phone/{fingerprint}");
    let mut phone = Phone::connect(&url, &fingerprint).await;
    assert!(!phone.keys.sessions, "the plain hello gets the old channel");
    phone.send(challenge()).await;
    assert_eq!(phone.next().await["t"], "identity");
    phone.send(hello(&token)).await;
    assert_eq!(phone.next().await["t"], "welcome");
    say("welcomed");
    let mut id = 0u64;
    let mut next_raw = Instant::now() + Duration::from_secs(25);
    let mut next_app = Instant::now() + Duration::from_secs(15);
    while t0.elapsed() < Duration::from_secs(130) {
        if let Some(f) = phone.next_for(Duration::from_millis(500)).await {
            assert_ne!(f["t"], "closed", "closed at {:?}", t0.elapsed());
        }
        if Instant::now() >= next_raw {
            phone.ws.send(Message::Text("ping".into())).await.unwrap();
            next_raw += Duration::from_secs(25);
        }
        if Instant::now() >= next_app {
            id += 1;
            phone.send(json!({ "t": "ping" })).await;
            phone
                .send(json!({ "t": "req", "id": id, "method": "rooms.list", "params": {} }))
                .await;
            assert_eq!(phone.res(id, Duration::from_secs(5)).await["ok"], true);
            say(&format!("read {id} answered"));
            next_app += Duration::from_secs(15);
        }
    }
    say("still open after 130 s");
}

/// Serves a linked Mac for an outside client (the old phone's own JS under
/// Node, `relay-probe/old-phone`): writes what it pins to `$SERVE_FILE`,
/// then keeps the link up for `$SERVE_SECS`. `RELAY_LIVE=ws://127.0.0.1:8799`.
#[tokio::test]
#[ignore = "needs a wrangler dev Worker and an outside client"]
async fn live_serve_for_an_outside_phone() {
    let worker = std::env::var("RELAY_LIVE").expect("RELAY_LIVE=ws://127.0.0.1:8799");
    let file = std::env::var("SERVE_FILE").expect("SERVE_FILE");
    let secs: u64 = std::env::var("SERVE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(150);
    let (c, stub) = Stub::companion();
    *stub.hosts.lock().unwrap() = vec!["127.0.0.1".into()];
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_r, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    tokio::spawn(run(
        c.clone(),
        Config {
            base: worker.clone(),
            port: Some(port),
        },
        link.clone(),
        stop_rx,
    ));
    live_until("the link", Duration::from_secs(10), || {
        link.status().state == RelayState::Connected
    })
    .await;
    let facts = json!({
        "fingerprint": fingerprint,
        "serverId": c.registry.server_id(),
        "token": token,
        "url": format!("{worker}/v1/phone/{fingerprint}"),
    });
    std::fs::write(&file, facts.to_string()).unwrap();
    println!("serving {secs} s");
    tokio::time::sleep(Duration::from_secs(secs)).await;
}

/// A video an agent sent, fetched over the relay while the relay's acks lag
/// (Julian's wife's phone, 20 Nov: no MP4 would open over the relay). The
/// Mac used to close the channel once 4 MB sat unacked; now it waits for the
/// acks, and the whole file arrives.
#[tokio::test]
async fn a_file_bigger_than_the_unacked_budget_arrives_whole_when_acks_lag() {
    let (sent, got) = fetch_over_relay(6 * 1024 * 1024).await;
    assert_eq!(got.len(), sent.len());
    assert!(got == sent, "the bytes arrived changed");
}

/// Past the 25 MB attachment cap a whole file is streamed from disk, not
/// refused (413): a 60 MB video opened nowhere.
#[tokio::test]
async fn a_video_past_the_attachment_cap_is_streamed_whole() {
    let (sent, got) = fetch_over_relay(30 * 1024 * 1024).await;
    assert_eq!(got.len(), sent.len());
    assert!(got == sent, "the bytes arrived changed");
}

/// Serves an MP4 of `size` bytes from the stub agent and GETs it over a
/// resumable relay whose acks lag: what was sent, and what arrived.
async fn fetch_over_relay(size: u32) -> (Vec<u8>, Vec<u8>) {
    let (c, stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let dir = stub.home.path().join("attachments").join("v1");
    std::fs::create_dir_all(&dir).unwrap();
    let video: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    std::fs::write(dir.join("clip.mp4"), &video).unwrap();
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    relay.shared.resume.store(true, Ordering::SeqCst);
    relay.shared.slow_acks.store(true, Ordering::SeqCst);
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.route().is_some()).await;
    let url = link.route().unwrap().url;

    // As the phone fetches a file over the relay: a channel of its own, the
    // handshake, one GET.
    let mut phone = Phone::connect(&url, &fingerprint).await;
    phone
        .send(json!({
            "t": "http", "id": 1, "method": "GET",
            "path": "/v1/agents/a1/attachments/attachments/v1/clip.mp4",
            "headers": { "authorization": format!("Bearer {token}") },
        }))
        .await;
    let first = phone.next_of("httpRes").await;
    assert_eq!(first["status"], 200, "{first}");
    let mut got = B64.decode(first["body"].as_str().unwrap_or("")).unwrap();
    let mut more = first["more"] == true;
    while more {
        let f = phone.next().await;
        assert_ne!(
            f["t"],
            "closed",
            "the channel closed after {} bytes",
            got.len()
        );
        if f["t"] != "httpBody" {
            continue;
        }
        got.extend(B64.decode(f["body"].as_str().unwrap_or("")).unwrap());
        more = f["more"] == true;
    }
    (video, got)
}

#[tokio::test]
async fn a_chat_past_the_payload_limit_read_over_the_relay_is_trimmed_and_the_channel_stays_up() {
    // 2026-11-20: a phone whose latest 100 messages came to 270-299 KB was
    // closed by the relay with 1009 on every read, and asked again at once.
    let (c, stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    {
        let mut all = stub.messages.lock().unwrap();
        all.clear();
        for i in 0..100 {
            all.push(
                serde_json::from_value(json!({
                    "id": format!("m{i:03}"), "agentId": crate::companion::testkit::AGENT,
                    "ts": 1_762_290_000_000_i64 + i * 1000, "kind": "agent",
                    "text": "x".repeat(channel::MAX_PAYLOAD * 3 / 2 / 100),
                }))
                .unwrap(),
            );
        }
    }
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    let link = Arc::new(Link::default());
    let (stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.status().state == RelayState::Connected).await;
    let route = link.route().unwrap();
    let mut phone = Phone::connect(&route.url, &fingerprint).await;
    phone.send(challenge()).await;
    assert_eq!(phone.next().await["t"], "identity");
    phone.send(hello(&token)).await;
    assert_eq!(phone.next_of("welcome").await["t"], "welcome");
    phone
        .send(json!({ "t": "req", "id": 5, "method": "agents.messages",
            "params": { "agentId": crate::companion::testkit::AGENT, "limit": 100 } }))
        .await;
    let res = loop {
        let f = phone.next_of("res").await;
        if f["id"] == 5 {
            break f;
        }
    };
    assert_eq!(res["ok"], true, "{res}");
    assert!(
        res.to_string().len() + 64 < channel::MAX_PAYLOAD,
        "{} bytes",
        res.to_string().len()
    );
    let list = res["result"]["messages"].as_array().unwrap();
    assert!(!list.is_empty() && list.len() < 100, "{}", list.len());
    assert_eq!(list.last().unwrap()["id"], "m099");
    assert_eq!(res["result"]["more"], true);
    // Still connected: the next read is answered.
    phone
        .send(json!({ "t": "req", "id": 6, "method": "rooms.list", "params": {} }))
        .await;
    let again = loop {
        let f = phone.next_of("res").await;
        if f["id"] == 6 {
            break f;
        }
    };
    assert_eq!(again["ok"], true);
    stop_tx.send(()).unwrap();
}

/// A photo from the phone's library over the relay (Julian, 20 Nov: pictures
/// he sent never reached the Mac): a 6 MB PUT in 128 KiB pieces, all sent at
/// once as the phone does, comes back as a staged blob of the same size.
#[tokio::test]
async fn a_photo_uploaded_over_the_relay_arrives_whole() {
    let (c, _stub) = Stub::companion();
    let fingerprint = c.registry.identity().unwrap().fingerprint();
    let (_record, token, _) = c
        .registry
        .add(
            &device(),
            String::new(),
            now_ms() as i64,
            &[],
            Some("j@x.com".into()),
        )
        .unwrap();
    let port = loopback(c.clone()).await;
    let relay = fake_relay(json!({ "id": "user_1", "email": "j@x.com" })).await;
    relay.shared.resume.store(true, Ordering::SeqCst);
    let link = Arc::new(Link::default());
    let (_stop_tx, stop_rx) = oneshot::channel();
    let cfg = Config {
        base: relay.base(),
        port: Some(port),
    };
    tokio::spawn(run(c.clone(), cfg, link.clone(), stop_rx));
    until("the link", || link.route().is_some()).await;
    let url = link.route().unwrap().url;

    let photo: Vec<u8> = (0..6 * 1024 * 1024u32).map(|i| (i % 253) as u8).collect();
    let mut phone = Phone::connect(&url, &fingerprint).await;
    let pieces: Vec<&[u8]> = photo.chunks(128 * 1024).collect();
    let last = pieces.len() - 1;
    phone
        .send(json!({
            "t": "http", "id": 1, "method": "PUT", "path": "/v1/blobs",
            "headers": {
                "authorization": format!("Bearer {token}"),
                "content-type": "image/jpeg",
                "x-name": "IMG_0001.jpg",
            },
            "body": B64.encode(pieces[0]),
            "more": true,
        }))
        .await;
    for (i, p) in pieces.iter().enumerate().skip(1) {
        phone
            .send(json!({ "t": "httpBody", "id": 1, "body": B64.encode(p), "more": i < last }))
            .await;
    }
    let res = tokio::time::timeout(Duration::from_secs(30), phone.next_of("httpRes"))
        .await
        .expect("an answer to the upload");
    assert_eq!(res["status"], 200, "{res}");
    let blob = http_body(&res);
    assert_eq!(blob["size"], photo.len() as u64, "{blob}");
    assert_eq!(blob["name"], "IMG_0001.jpg");
}
