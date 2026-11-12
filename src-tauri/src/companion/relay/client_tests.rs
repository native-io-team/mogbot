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
    tx.send(Message::Text(
        json!({ "t": "ready", "account": account }).to_string(),
    ))
    .await
    .unwrap();
    let (mac_tx, mut mac_rx) = mpsc::unbounded_channel::<Message>();
    *shared.mac.lock().unwrap() = Some(mac_tx.clone());
    tokio::spawn(async move {
        while let Some(m) = mac_rx.recv().await {
            if tx.send(m).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = rx.next().await {
        match msg {
            Message::Text(t) if t == "ping" => {
                let _ = mac_tx.send(Message::Text("pong".into()));
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
    assert!(link.status().account.is_some(), "a failed delete keeps the account");
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
    let o = Open {
        tx,
        generation: 1,
        queued: queued.clone(),
    };
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
