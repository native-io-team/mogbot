//! The server end to end on loopback: pair over HTTP with a click to Allow,
//! then chat with the stub agent over a real WebSocket, resume by cursor,
//! and get refused the ways a phone can be.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::companion::testkit::{Stub, AGENT};
use crate::companion::wire::{BuildKind, DevicePlatform, PairDevice};
use crate::companion::{now_ms, Companion};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start(c: Arc<Companion>) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(super::serve(c, listener, rx));
    // Held for the life of the test process: dropping it would stop the server.
    std::mem::forget(tx);
    port
}

/// A socket with nothing said on it yet.
async fn connect_raw(port: u16) -> Ws {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/v1/ws"))
        .await
        .unwrap();
    ws
}

const CHALLENGE: &str = "c2lnbiBtZSBwbGVhc2UsIGEgcGhvbmUgY2hvc2UgbWU";

fn challenge() -> Value {
    json!({ "t": "challenge", "protocol": { "min": 2, "max": 2 }, "challenge": CHALLENGE })
}

/// The phone's first move: a challenge, and the Mac's signed identity back.
async fn prove(ws: &mut Ws) -> Value {
    send(ws, challenge()).await;
    let identity = next(ws).await;
    assert_eq!(identity["t"], "identity", "{identity}");
    identity
}

/// A socket the Mac has proved itself on, ready for a hello.
async fn connect(port: u16) -> Ws {
    let mut ws = connect_raw(port).await;
    prove(&mut ws).await;
    ws
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string())).await.unwrap();
}

/// The next JSON frame (skipping WebSocket control frames).
async fn next(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5 s");
        match msg {
            Some(Ok(Message::Text(t))) => return serde_json::from_str(&t).unwrap(),
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return json!({ "t": "closed" }),
            _ => continue,
        }
    }
}

fn hello(token: &str, resume: Option<Value>) -> Value {
    let mut h = json!({
        "t": "hello",
        "protocol": { "min": 2, "max": 2 },
        "token": token,
        "app": { "version": "1.0.0", "runtimeVersion": "1" },
        "foreground": true
    });
    if let Some(r) = resume {
        h["resume"] = r;
    }
    h
}

/// Hello, then everything up to `sync.caughtUp`. Returns the welcome, the
/// catch-up events, and the cursor caught up to.
async fn open(port: u16, token: &str, resume: Option<Value>) -> (Ws, Value, Vec<Value>, Value) {
    let mut ws = connect(port).await;
    send(&mut ws, hello(token, resume)).await;
    let welcome = next(&mut ws).await;
    assert_eq!(welcome["t"], "welcome", "{welcome}");
    let mut events = Vec::new();
    loop {
        let f = next(&mut ws).await;
        assert_eq!(f["t"], "evt", "{f}");
        if f["event"]["type"] == "sync.caughtUp" {
            return (ws, welcome, events, f["event"]["cursor"].clone());
        }
        events.push(f);
    }
}

/// Send a request and collect the events that arrive before its response.
async fn call(ws: &mut Ws, id: u64, method: &str, params: Value) -> (Vec<Value>, Value) {
    send(
        ws,
        json!({ "t": "req", "id": id, "method": method, "params": params }),
    )
    .await;
    let mut events = Vec::new();
    loop {
        let f = next(ws).await;
        match f["t"].as_str() {
            Some("res") if f["id"] == id => return (events, f),
            Some("evt") => events.push(f),
            Some("closed") => panic!("closed while waiting for {method}"),
            _ => {}
        }
    }
}

fn types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| e["event"]["type"].as_str().unwrap_or("").to_string())
        .collect()
}

fn phone() -> PairDevice {
    PairDevice {
        name: "Test Phone".into(),
        platform: DevicePlatform::Ios,
        model: Some("iPhone 16".into()),
        app_version: "1.0.0".into(),
        build: BuildKind::Official,
    }
}

fn pair_body(code: &str) -> Value {
    json!({
        "code": code,
        "device": { "name": "Test Phone", "platform": "ios", "model": "iPhone 16", "appVersion": "1.0.0", "build": "official" },
        "protocol": { "min": 2, "max": 2 },
        "publicKey": "pk",
        "challenge": CHALLENGE
    })
}

/// Answer the desk prompt as soon as it shows.
fn desk(c: &Arc<Companion>, allow: bool) {
    let c = c.clone();
    tokio::spawn(async move {
        for _ in 0..200 {
            if let Some(r) = c.pairing.view(now_ms()).request {
                let decision = if allow {
                    crate::companion::pairing::Decision::Allow { replace: vec![] }
                } else {
                    crate::companion::pairing::Decision::Deny
                };
                c.pairing.decide(&r.id, decision);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
}

async fn post_pair(port: u16, body: &Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/pair"))
        .json(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn pair_chat_resume_and_audit_end_to_end() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;

    // ---- Pair: the code, then Allow at the desk.
    let (code, _) = c.pairing.start(now_ms());
    let wrong = post_pair(port, &pair_body("AAAAAAAAAAAAAAAAAAAAAAAAAA")).await;
    assert_eq!(wrong.status(), 404, "a wrong code gets a bare 404");
    desk(&c, true);
    let paired: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(paired["ok"], true, "{paired}");
    assert_eq!(paired["serverId"], c.registry.server_id());
    let token = paired["token"].as_str().unwrap().to_string();
    let device_id = paired["deviceId"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    let used: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(used["ok"], false, "single use: {used}");

    // ---- First connect: no cursor, so a snapshot.
    let (mut ws, welcome, catch_up, cursor0) = open(port, &token, None).await;
    assert_eq!(welcome["resume"], "snapshot");
    assert_eq!(welcome["deviceId"], device_id.as_str());
    assert_eq!(welcome["protocol"], 2);
    assert!(welcome["methods"]
        .as_array()
        .unwrap()
        .contains(&json!("agents.send")));
    assert_eq!(types(&catch_up), ["sync.snapshot"]);
    let snapshot = &catch_up[0]["event"];
    assert_eq!(snapshot["overview"]["agents"][0]["id"], AGENT);
    assert!(snapshot["overview"]["agents"][0].get("usage").is_none());
    assert_eq!(snapshot["status"]["name"], "Julian’s MacBook Pro");
    // P2: the projects and their agent tabs, waiting-on-you first.
    assert_eq!(snapshot["projects"][0]["name"], "site");
    assert_eq!(
        snapshot["projects"][0]["sessions"][0]["state"],
        "needs_decision"
    );
    assert_eq!(
        snapshot["projects"][0]["sessions"][0]["question"]["options"][0],
        json!({ "key": "1", "label": "Yes", "highlighted": false })
    );
    assert_eq!(cursor0["epoch"], "epoch-test");
    assert!(c.is_connected(&device_id));

    // ---- Send: the turn's events arrive before the response.
    let (events, res) = call(
        &mut ws,
        1,
        "agents.send",
        json!({ "agentId": AGENT, "text": "hi", "clientId": "c1" }),
    )
    .await;
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["result"]["id"], "u1");
    assert_eq!(
        types(&events),
        [
            "agents.message",
            "agents.status",
            "agents.draft",
            "agents.message",
            "agents.status"
        ]
    );
    let seqs: Vec<u64> = events.iter().filter_map(|e| e["seq"].as_u64()).collect();
    assert_eq!(seqs.len(), 4, "drafts carry no seq");
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    assert_eq!(events[2]["event"]["from"], 0);
    assert_eq!(events[2]["event"]["text"], "Hel");

    // ---- The same clientId again: the original message, not a second send.
    let (events, res) = call(
        &mut ws,
        2,
        "agents.send",
        json!({ "agentId": AGENT, "text": "hi", "clientId": "c1" }),
    )
    .await;
    assert_eq!(res["result"]["id"], "u1");
    assert!(events.is_empty());
    assert_eq!(stub.sends.load(std::sync::atomic::Ordering::SeqCst), 1);

    // ---- Remote Access's text rules.
    let (_, res) = call(
        &mut ws,
        3,
        "agents.send",
        json!({ "agentId": AGENT, "text": "! rm -rf ~", "clientId": "c2" }),
    )
    .await;
    assert_eq!(res["ok"], false);
    assert_eq!(res["error"]["type"], "Protocol");
    assert_eq!(res["error"]["code"], "refused");
    let (_, res) = call(
        &mut ws,
        4,
        "agents.send",
        json!({ "agentId": AGENT, "text": "/permissions", "clientId": "c3" }),
    )
    .await;
    assert_eq!(res["error"]["code"], "refused");

    // ---- Paging, with the read cursor.
    let (_, res) = call(
        &mut ws,
        5,
        "agents.messages",
        json!({ "agentId": AGENT, "limit": 5 }),
    )
    .await;
    let page = &res["result"];
    assert_eq!(page["messages"].as_array().unwrap().len(), 5);
    assert_eq!(page["more"], true);
    assert_eq!(page["asOf"]["seq"], 4);
    let oldest = page["messages"][0]["id"].clone();
    let (_, res) = call(
        &mut ws,
        6,
        "agents.messages",
        json!({ "agentId": AGENT, "limit": 2, "before": oldest }),
    )
    .await;
    assert_eq!(res["result"]["messages"].as_array().unwrap().len(), 2);

    // ---- Approval, focus, an unknown method, a malformed request.
    let (_, res) = call(
        &mut ws,
        7,
        "agents.answerApproval",
        json!({ "agentId": AGENT, "requestId": "q1", "allow": false, "note": "use pnpm" }),
    )
    .await;
    assert_eq!(
        res,
        json!({ "t": "res", "id": 7, "ok": true, "result": null })
    );
    assert_eq!(
        stub.answers.lock().unwrap()[0].note.as_deref(),
        Some("use pnpm")
    );
    let (_, res) = call(&mut ws, 8, "agents.focus", json!({ "agentId": AGENT })).await;
    assert_eq!(res["ok"], true);
    let label = stub.focus.lock().unwrap()[0].0.clone();
    assert!(label.starts_with(&format!("companion:{device_id}:")));
    assert!(c.label_on_screen(&label), "foreground and connected");
    let (_, res) = call(&mut ws, 9, "agents.delete", json!({ "agentId": AGENT })).await;
    assert_eq!(res["error"]["code"], "unknown_method");
    let (_, res) = call(&mut ws, 10, "agents.stop", json!({})).await;
    assert_eq!(res["error"]["code"], "bad_params");

    // ---- Presence: backgrounded, the chat no longer counts as on screen.
    send(&mut ws, json!({ "t": "presence", "foreground": false })).await;
    send(&mut ws, json!({ "t": "ping" })).await;
    assert_eq!(next(&mut ws).await, json!({ "t": "pong" }));
    assert!(!c.label_on_screen(&label));

    // ---- Disconnect clears this socket's focus.
    ws.close(None).await.unwrap();
    for _ in 0..100 {
        if stub
            .focus
            .lock()
            .unwrap()
            .last()
            .is_some_and(|f| f.1.is_none())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(stub.focus.lock().unwrap().last().unwrap(), &(label, None));

    // ---- Resume from before the turn: replay, latest status only, no drafts.
    let (_ws, welcome, replay, cursor) = open(port, &token, Some(cursor0.clone())).await;
    assert_eq!(welcome["resume"], "replay");
    assert_eq!(
        types(&replay),
        ["agents.message", "agents.message", "agents.status"]
    );
    assert_eq!(replay[2]["event"]["status"]["state"], "idle");
    assert_eq!(cursor["seq"], 4);

    // ---- A cursor from another run gets a snapshot.
    let (_ws2, welcome, _, _) = open(port, &token, Some(json!({ "epoch": "old", "seq": 2 }))).await;
    assert_eq!(welcome["resume"], "snapshot");

    // ---- Audit: actions and pairing named for the phone; reads left out.
    let audit = stub.audited();
    let tools: Vec<&str> = audit
        .iter()
        .filter(|a| a.0 == "Phone · Test Phone")
        .map(|a| a.1.as_str())
        .collect();
    for expected in [
        "pair_request",
        "paired",
        "connected",
        "agents.send",
        "agents.answerApproval",
        "agents.focus",
    ] {
        assert!(
            tools.contains(&expected),
            "{expected} missing from {tools:?}"
        );
    }
    assert!(!tools.contains(&"agents.messages"), "reads aren't audited");
    let sent: Vec<_> = audit.iter().filter(|a| a.1 == "agents.send").collect();
    assert_eq!(sent.len(), 4);
    assert!(sent[0].3 && sent[0].2 == "hi");
    let refused = sent.iter().find(|a| !a.3).unwrap();
    assert!(refused.2.contains("refused"), "{refused:?}");
    assert!(audit
        .iter()
        .any(|a| a.1 == "agents.answerApproval" && a.2 == "deny with note: use pnpm"));
    assert!(audit.iter().all(|a| !a.2.contains(&token)), "never a token");
}

#[tokio::test]
async fn a_revoked_phone_is_closed_at_once_and_told_so() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let (mut ws, ..) = open(port, &token, None).await;
    c.revoke(&record.id).unwrap();
    let f = next(&mut ws).await;
    assert_eq!(f["t"], "refused");
    assert_eq!(f["reason"], "revoked");
    // And it stays out.
    let mut ws = connect(port).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["reason"], "revoked");
    assert!(stub
        .audited()
        .iter()
        .any(|a| a.1 == "revoked" && a.0 == "Phone · Test Phone"));
}

#[tokio::test]
async fn unknown_tokens_and_old_versions_are_refused() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();

    let mut ws = connect(port).await;
    send(&mut ws, hello(&"0".repeat(64), None)).await;
    assert_eq!(next(&mut ws).await["reason"], "unauthorized");

    // Versions are settled by the challenge, before anything else.
    let mut ws = connect_raw(port).await;
    let mut ch = challenge();
    ch["protocol"] = json!({ "min": 3, "max": 4 });
    send(&mut ws, ch).await;
    let f = next(&mut ws).await;
    assert_eq!(f["reason"], "update_mac");
    assert_eq!(
        f["message"],
        format!("Update {} on Julian’s MacBook Pro.", crate::brand::NAME)
    );

    let mut ws = connect_raw(port).await;
    let mut ch = challenge();
    ch["protocol"] = json!({ "min": 0, "max": 0 });
    send(&mut ws, ch).await;
    assert_eq!(next(&mut ws).await["reason"], "update_app");

    // An app from protocol 1 sends its token first: told to update, and the
    // token isn't so much as looked at.
    let mut ws = connect_raw(port).await;
    let mut h = hello(&token, None);
    h["protocol"] = json!({ "min": 1, "max": 1 });
    send(&mut ws, h).await;
    assert_eq!(next(&mut ws).await["reason"], "update_app");

    // Not a challenge first: closed without a word.
    let mut ws = connect_raw(port).await;
    send(&mut ws, json!({ "t": "ping" })).await;
    assert_eq!(next(&mut ws).await["t"], "closed");
    // Nor a hello after the proof.
    let mut ws = connect(port).await;
    send(&mut ws, json!({ "t": "ping" })).await;
    assert_eq!(next(&mut ws).await["t"], "closed");
}

#[tokio::test]
async fn a_denied_phone_gets_no_token() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (code, _) = c.pairing.start(now_ms());
    desk(&c, false);
    let res: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        res,
        json!({ "ok": false, "reason": "denied", "message": "The Mac said no." })
    );
    assert!(c.registry.devices().is_empty());
    assert!(stub.audited().iter().any(|a| a.1 == "pair_denied" && !a.3));
}

#[tokio::test]
async fn an_old_app_is_told_to_update_before_its_code_is_spent() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (code, _) = c.pairing.start(now_ms());
    let mut body = pair_body(&code);
    body["protocol"] = json!({ "min": 0, "max": 0 });
    let res: Value = post_pair(port, &body).await.json().await.unwrap();
    assert_eq!(res["reason"], "update_app");
    assert!(c.pairing.view(now_ms()).active, "the code is still good");
}

#[tokio::test]
async fn unpairing_from_the_phone_answers_then_closes() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let (mut ws, ..) = open(port, &token, None).await;
    send(
        &mut ws,
        json!({ "t": "req", "id": 1, "method": "devices.unpairSelf", "params": {} }),
    )
    .await;
    assert_eq!(
        next(&mut ws).await,
        json!({ "t": "res", "id": 1, "ok": true, "result": null })
    );
    assert_eq!(next(&mut ws).await["t"], "closed");
    assert!(c.registry.get(&record.id).is_none());
}

#[tokio::test]
async fn sockets_per_device_are_capped() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let mut held = Vec::new();
    for _ in 0..crate::companion::MAX_SOCKETS_PER_DEVICE {
        held.push(open(port, &token, None).await.0);
    }
    let mut ws = connect(port).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["reason"], "too_many_connections");
}

// ============================================================================
// Files over HTTP (P2)
// ============================================================================

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 40, 90]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn put_blob(
    port: u16,
    token: Option<&str>,
    name: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> reqwest::Response {
    let mut req = reqwest::Client::new()
        .put(format!("http://127.0.0.1:{port}/v1/blobs"))
        .header("X-Name", urlencoding::encode(name).into_owned())
        .header("Content-Type", mime)
        .body(bytes);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.unwrap()
}

async fn get(port: u16, token: Option<&str>, path: &str) -> reqwest::Response {
    let mut req = reqwest::Client::new().get(format!("http://127.0.0.1:{port}{path}"));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.unwrap()
}

fn other_phone() -> PairDevice {
    PairDevice {
        name: "Other Phone".into(),
        ..phone()
    }
}

#[tokio::test]
async fn upload_send_and_download_a_photo_end_to_end() {
    let (c, _stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();

    // Upload: a BlobRef with the cleaned name and the declared type.
    let res = put_blob(
        port,
        Some(&token),
        "my photo.png",
        "image/png",
        png(800, 400),
    )
    .await;
    assert_eq!(res.status(), 200);
    let blob: Value = res.json().await.unwrap();
    assert_eq!(blob["name"], "my photo.png");
    assert_eq!(blob["mime"], "image/png");
    let blob_id = blob["blobId"].as_str().unwrap().to_string();

    // Send it, with no text: files alone are a message, as on the desk.
    let (mut ws, ..) = open(port, &token, None).await;
    let (events, res) = call(
        &mut ws,
        1,
        "agents.send",
        json!({ "agentId": AGENT, "text": "", "clientId": "c-photo", "attachments": [{ "blobId": blob_id }] }),
    )
    .await;
    assert_eq!(res["ok"], true, "{res}");
    let message = &res["result"];
    assert_eq!(message["clientId"], "c-photo");
    let attachment = &message["attachments"][0];
    assert_eq!(attachment["name"], "my photo.png");
    let mine = events
        .iter()
        .find(|e| {
            e["event"]["type"] == "agents.message" && e["event"]["message"]["id"] == message["id"]
        })
        .expect("the user message is journaled");
    assert_eq!(mine["event"]["message"]["clientId"], "c-photo");
    // The staged blob was consumed by the send.
    assert_eq!(
        get(port, Some(&token), &format!("/v1/blobs/{blob_id}"))
            .await
            .status(),
        404
    );

    // Download it whole, as a thumbnail, and in part.
    let path = attachment["path"].as_str().unwrap();
    let route = format!(
        "/v1/agents/{AGENT}/{}",
        path.split('/')
            .map(|s| urlencoding::encode(s).into_owned())
            .collect::<Vec<_>>()
            .join("/")
    );
    let whole = get(port, Some(&token), &route).await;
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.headers()["content-type"], "image/png");
    assert_eq!(whole.headers()["accept-ranges"], "bytes");
    assert!(whole.headers()["cache-control"]
        .to_str()
        .unwrap()
        .starts_with("private"));
    // Phone builds before the protocol fix doubled the `attachments/`
    // segment; those still get the file rather than a 404 (an empty box).
    let doubled = route.replacen("/attachments/", "/attachments/attachments/", 1);
    assert_eq!(get(port, Some(&token), &doubled).await.status(), 200);
    let thumb = get(port, Some(&token), &format!("{route}?w=200")).await;
    assert_eq!(thumb.status(), 200);
    assert_eq!(thumb.headers()["content-type"], "image/jpeg");
    let img = image::load_from_memory(&thumb.bytes().await.unwrap()).unwrap();
    assert_eq!((img.width(), img.height()), (200, 100));
    let part = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}{route}"))
        .bearer_auth(&token)
        .header("Range", "bytes=0-7")
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(
        part.bytes().await.unwrap().as_ref(),
        &png(1, 1)[..8],
        "the PNG signature"
    );

    // Nothing outside the agent's attachments.
    for bad in [
        format!("/v1/agents/{AGENT}/attachments/..%2F..%2Fsecret"),
        format!("/v1/agents/{AGENT}/attachments/../registry.json"),
        format!("/v1/agents/{AGENT}/attachments/"),
    ] {
        assert_eq!(get(port, Some(&token), &bad).await.status(), 404, "{bad}");
    }
}

#[tokio::test]
async fn file_routes_need_a_live_token_and_keep_devices_apart() {
    let (c, _stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let (_, other, _) = c
        .registry
        .add(&other_phone(), String::new(), 1, &[], None)
        .unwrap();

    assert_eq!(
        put_blob(port, None, "a.txt", "text/plain", b"x".to_vec())
            .await
            .status(),
        401
    );
    assert_eq!(
        put_blob(
            port,
            Some(&"0".repeat(64)),
            "a.txt",
            "text/plain",
            b"x".to_vec()
        )
        .await
        .status(),
        401
    );
    let blob: Value = put_blob(port, Some(&token), "a.txt", "text/plain", b"hello".to_vec())
        .await
        .json()
        .await
        .unwrap();
    let blob_path = format!("/v1/blobs/{}", blob["blobId"].as_str().unwrap());
    assert_eq!(get(port, None, &blob_path).await.status(), 401);
    assert_eq!(
        get(port, Some(&other), &blob_path).await.status(),
        404,
        "another phone's blob"
    );

    // Another phone can't send it either.
    let (mut ws, ..) = open(port, &other, None).await;
    let (_, res) = call(
        &mut ws,
        1,
        "agents.send",
        json!({ "agentId": AGENT, "text": "hi", "clientId": "c1", "attachments": [{ "blobId": blob["blobId"] }] }),
    )
    .await;
    assert_eq!(res["ok"], false);

    // Revoked: the token stops working for files too.
    c.revoke(&record.id).unwrap();
    assert_eq!(get(port, Some(&token), &blob_path).await.status(), 401);
    assert_eq!(
        put_blob(port, Some(&token), "a.txt", "text/plain", b"x".to_vec())
            .await
            .status(),
        401
    );
}

#[tokio::test]
async fn uploads_over_the_desks_limit_are_refused() {
    use crate::agents::attachments::MAX_FILE_BYTES;
    let (c, _stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let res = put_blob(
        port,
        Some(&token),
        "big.bin",
        "application/octet-stream",
        vec![0u8; MAX_FILE_BYTES as usize + 1],
    )
    .await;
    assert_eq!(res.status(), 413);
    // Exactly the limit is fine.
    let res = put_blob(
        port,
        Some(&token),
        "big.bin",
        "application/octet-stream",
        vec![0u8; MAX_FILE_BYTES as usize],
    )
    .await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn an_oversized_chunked_upload_is_read_out_and_answered_413() {
    use crate::agents::attachments::MAX_FILE_BYTES;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (c, _stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "PUT /v1/blobs HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nX-Name: big.bin\r\nTransfer-Encoding: chunked\r\n\r\n"
    );
    s.write_all(head.as_bytes()).await.unwrap();
    let chunk = vec![0u8; 1024 * 1024];
    let chunks = MAX_FILE_BYTES as usize / chunk.len() + 1;
    for _ in 0..chunks {
        s.write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
            .await
            .unwrap();
        s.write_all(&chunk).await.unwrap();
        s.write_all(b"\r\n").await.unwrap();
    }
    s.write_all(b"0\r\n\r\n").await.unwrap();
    let mut buf = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut buf))
        .await
        .unwrap()
        .unwrap();
    let line = String::from_utf8_lossy(&buf[..n]);
    assert!(line.starts_with("HTTP/1.1 413"), "{line}");
}

#[tokio::test]
async fn a_running_turns_steps_go_only_to_phones_that_show_them() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let (mut old, ..) = open(port, &token, None).await;
    let mut ws = connect(port).await;
    let mut h = hello(&token, None);
    h["features"] = json!(["work.live"]);
    send(&mut ws, h).await;
    loop {
        let f = next(&mut ws).await;
        if f["event"]["type"] == "sync.caughtUp" {
            break;
        }
    }
    let status = serde_json::to_value(crate::agents::runner::Status {
        state: "working",
        activity: Some("Running npm test".into()),
        since: Some(1),
        work: Some(crate::companion::testkit::live_work()),
        room: None,
    })
    .unwrap();
    c.hub.publish(crate::companion::wire::Event::Status {
        agent_id: AGENT.into(),
        status,
    });
    let seen = next(&mut ws).await;
    assert_eq!(seen["event"]["status"]["work"]["stepCount"], 3, "{seen}");
    let without = next(&mut old).await;
    assert_eq!(without["event"]["type"], "agents.status");
    assert!(
        without["event"]["status"].get("work").is_none(),
        "{without}"
    );
    assert_eq!(without["event"]["status"]["activity"], "Running npm test");
    // The overview never carries them: they'd go out on every registry change.
    let overview = crate::companion::testkit::overview();
    assert!(overview["agents"][0]["status"].get("work").is_none());
}

/// Rooms go only to phones that said they show them; the methods work for
/// any phone, route as the desk does, and retry by clientId.
#[tokio::test]
async fn rooms_reach_only_phones_that_show_them() {
    use crate::companion::testkit::ROOM;
    use crate::companion::wire::Event;
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let (mut old, welcome, ..) = open(port, &token, None).await;
    assert!(
        welcome["features"]
            .as_array()
            .unwrap()
            .contains(&json!("rooms")),
        "{welcome}"
    );
    assert!(welcome["methods"]
        .as_array()
        .unwrap()
        .contains(&json!("rooms.send")));
    let mut ws = connect(port).await;
    let mut h = hello(&token, None);
    h["features"] = json!(["work.live", "rooms"]);
    send(&mut ws, h).await;
    loop {
        let f = next(&mut ws).await;
        if f["event"]["type"] == "sync.caughtUp" {
            break;
        }
    }

    // The list, and a page of the thread with its user line (no agent).
    let (_, list) = call(&mut ws, 1, "rooms.list", json!({})).await;
    assert_eq!(list["result"][0]["id"], ROOM, "{list}");
    assert_eq!(list["result"][0]["turnCap"], 8);
    let (_, page) = call(
        &mut ws,
        2,
        "rooms.messages",
        json!({ "roomId": ROOM, "limit": 2 }),
    )
    .await;
    assert_eq!(page["result"]["more"], true, "{page}");
    assert_eq!(page["result"]["messages"][1]["id"], "rm5");
    assert_eq!(page["result"]["messages"][1]["agentId"], "");

    // Nobody named and no lead: refused, nothing said.
    let (_, who) = call(
        &mut ws,
        3,
        "rooms.send",
        json!({ "roomId": ROOM, "text": "Status?", "clientId": "rc0" }),
    )
    .await;
    assert_eq!(who["ok"], false, "{who}");
    assert!(
        who["error"].to_string().contains("Who should answer"),
        "{who}"
    );

    // @everyone: both asked; the room's own line is an event for this phone only.
    let params = json!({ "roomId": ROOM, "text": "Status?", "clientId": "rc1", "everyone": true });
    let (events, sent) = call(&mut ws, 4, "rooms.send", params.clone()).await;
    assert_eq!(
        sent["result"]["asked"].as_array().unwrap().len(),
        2,
        "{sent}"
    );
    assert!(
        events.iter().any(|e| e["event"]["message"]["room"] == ROOM),
        "{events:?}"
    );
    let (_, again) = call(&mut ws, 5, "rooms.send", params).await;
    assert_eq!(
        again["result"]["message"]["id"],
        sent["result"]["message"]["id"]
    );
    assert_eq!(
        stub.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "retried once"
    );

    // A rooms event and a member's room line: the old phone gets only the line.
    c.hub.publish(Event::Rooms { rooms: json!([]) });
    c.hub.publish(Event::Message {
        message: json!({ "id": "rm9", "agentId": AGENT, "room": ROOM, "ts": 1, "kind": "agent", "text": "Done" }),
    });
    let first = next(&mut old).await;
    assert_eq!(
        first["event"]["message"]["id"], "rm9",
        "the user's room line and rooms.changed skipped: {first}"
    );
    let r = next(&mut ws).await;
    assert_eq!(r["event"]["type"], "rooms.changed", "{r}");

    // Focus is the socket's, as "room:<id>".
    let (_, focused) = call(&mut ws, 6, "rooms.focus", json!({ "roomId": ROOM })).await;
    assert_eq!(focused["ok"], true);
    assert!(stub
        .focus
        .lock()
        .unwrap()
        .iter()
        .any(|(_, id)| id.as_deref() == Some("room:r1")));
}

// ============================================================================
// Hardening (security audit of the companion, Nov 2026)
// ============================================================================

use base64::Engine as _;
use ring::signature::{UnparsedPublicKey, ED25519};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .unwrap()
}

/// The proof verifies, by the key the pairing link fingerprints.
fn verifies(c: &Companion, proof: &Value, message: &str) -> bool {
    let key = b64(proof["publicKey"].as_str().unwrap());
    let sig = b64(proof["signature"].as_str().unwrap());
    crate::companion::identity::fingerprint_of(&key) == c.registry.identity().unwrap().fingerprint()
        && UnparsedPublicKey::new(&ED25519, key)
            .verify(message.as_bytes(), &sig)
            .is_ok()
}

fn hosts(v: &Value) -> Vec<String> {
    serde_json::from_value(v["hosts"].clone()).unwrap()
}

#[tokio::test]
async fn the_mac_proves_itself_before_any_secret_is_sent() {
    use crate::companion::identity::{mac_message, pair_message};
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let server_id = c.registry.server_id();

    // Before pairing: who it is, and where it serves, signed over the challenge.
    let res: Value = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/identity"))
        .json(&json!({ "protocol": { "min": 2, "max": 2 }, "challenge": CHALLENGE }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(
        hosts(&res),
        vec![crate::companion::testkit::HOST.to_string()]
    );
    assert!(verifies(
        &c,
        &res["identity"],
        &mac_message(CHALLENGE, &server_id, &hosts(&res))
    ));

    // No code was out: nothing for the panel to say.
    assert_eq!(c.pairing.view(now_ms()).reached_at, None);

    // The pairing answer signs the hosts and the device it made.
    let (code, _) = c.pairing.start(now_ms());
    // With a code out, the panel hears that a device reached this Mac.
    let again = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/identity"))
        .json(&json!({ "protocol": { "min": 2, "max": 2 }, "challenge": CHALLENGE }))
        .send()
        .await
        .unwrap();
    assert!(again.status().is_success());
    assert!(c.pairing.view(now_ms()).reached_at.is_some());
    desk(&c, true);
    let paired: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(paired["ok"], true, "{paired}");
    let device_id = paired["deviceId"].as_str().unwrap();
    assert!(verifies(
        &c,
        &paired["identity"],
        &pair_message(CHALLENGE, &server_id, &hosts(&paired), device_id)
    ));
    assert!(!verifies(
        &c,
        &paired["identity"],
        &pair_message(CHALLENGE, &server_id, &hosts(&paired), "dev_other")
    ));

    // On a socket: the proof comes before the token, and isn't a pairing proof.
    let mut ws = connect_raw(port).await;
    let identity = prove(&mut ws).await;
    assert_eq!(identity["serverId"], server_id.as_str());
    assert_eq!(identity["protocol"], 2);
    assert!(verifies(
        &c,
        &identity["identity"],
        &mac_message(CHALLENGE, &server_id, &hosts(&identity))
    ));
    assert!(!verifies(
        &c,
        &identity["identity"],
        &pair_message(CHALLENGE, &server_id, &hosts(&identity), device_id)
    ));
    send(&mut ws, hello(paired["token"].as_str().unwrap(), None)).await;
    let welcome = next(&mut ws).await;
    assert_eq!(welcome["t"], "welcome");
    assert!(welcome.get("identity").is_none(), "proved once, first");

    // A challenge that isn't one gets no signature, and no socket.
    let mut ws = connect_raw(port).await;
    let mut ch = challenge();
    ch["challenge"] = json!("short");
    send(&mut ws, ch).await;
    assert_eq!(next(&mut ws).await["t"], "closed");
}

/// The relay attack: someone with their own `*.ts.net` name passes the
/// phone's frames to the real Mac and back. Every signature is real, but it
/// names the Mac's own host, never the relay's, so a phone that checks the
/// host it reached sends the relay nothing.
#[tokio::test]
async fn a_relay_on_another_host_cant_pass_the_macs_proof_off_as_its_own() {
    use crate::companion::identity::mac_message;
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let server_id = c.registry.server_id();
    let mut ws = connect_raw(port).await;
    let relayed = prove(&mut ws).await;
    let relay_host = "attacker.tail9.ts.net".to_string();
    // What the phone checks: the pinned key signed this, for the host it reached.
    let phone_accepts = |reached: &str| {
        hosts(&relayed).iter().any(|h| h == reached)
            && verifies(
                &c,
                &relayed["identity"],
                &mac_message(CHALLENGE, &server_id, &hosts(&relayed)),
            )
    };
    assert!(phone_accepts(crate::companion::testkit::HOST));
    assert!(!phone_accepts(&relay_host));
    // And the relay can't swap its own host in without breaking the signature.
    assert!(!verifies(
        &c,
        &relayed["identity"],
        &mac_message(CHALLENGE, &server_id, &[relay_host])
    ));
}

#[tokio::test]
async fn a_mac_that_cant_read_its_key_says_so_and_offers_no_pairing() {
    let keys = Arc::new(crate::companion::keystore::Memory::default());
    keys.fail_load
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let dir = tempfile::tempdir().unwrap();
    let registry =
        crate::companion::Registry::load_with(dir.path().join("companion.json"), Box::new(keys));
    let (c, _) = Stub::companion_with(registry, "epoch-test");
    let port = start(c.clone()).await;
    let mut ws = connect_raw(port).await;
    send(&mut ws, challenge()).await;
    let f = next(&mut ws).await;
    assert_eq!(f["reason"], "unavailable", "{f}");
    let (code, _) = c.pairing.start(now_ms());
    let res: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(res["ok"], false, "{res}");
    assert!(c.pairing.view(now_ms()).active, "the code survives");
}

#[tokio::test]
async fn strangers_cant_hold_every_socket_from_one_source() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    // Sockets that never say a word, all from one tailnet user.
    let mut held = Vec::new();
    let open_as = |login: &'static str| async move {
        let mut req =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                format!("ws://127.0.0.1:{port}/v1/ws"),
            )
            .unwrap();
        req.headers_mut()
            .insert("Tailscale-User-Login", login.parse().unwrap());
        tokio_tungstenite::connect_async(req).await
    };
    for _ in 0..crate::companion::limits::MAX_PREHELLO_PER_SOURCE {
        held.push(open_as("mallory@example.com").await.unwrap().0);
    }
    assert!(
        open_as("mallory@example.com").await.is_err(),
        "one more from the same source is turned away"
    );
    // The paired phone, from its own user, still gets in.
    let (_, token, _) = c
        .registry
        .add(
            &phone(),
            String::new(),
            1,
            &[],
            Some("julian@example.com".into()),
        )
        .unwrap();
    let (mut ws, _) = open_as("julian@example.com").await.unwrap();
    prove(&mut ws).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["t"], "welcome");
    // A socket that authenticated gives its stranger's place back.
    assert_eq!(c.prehello.in_flight("user:julian@example.com"), 0);
}

#[tokio::test]
async fn a_token_from_a_users_phone_needs_that_user_every_time() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(
            &phone(),
            String::new(),
            1,
            &[],
            Some("julian@example.com".into()),
        )
        .unwrap();
    // No login header at all (a tagged node holding a stolen token).
    let mut ws = connect(port).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["reason"], "unauthorized");
    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/blobs/x"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn pairing_takes_json_only_and_browsers_are_refused() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (code, _) = c.pairing.start(now_ms());
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/v1/pair");
    // A web page's no-cors POST.
    let res = client
        .post(&url)
        .header("Content-Type", "text/plain")
        .body(pair_body(&code).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 415);
    // A page from another origin, even with the right type.
    let res = client
        .post(&url)
        .header("Origin", "https://evil.example")
        .json(&pair_body(&code))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    // DNS rebinding: the page's own name pointed at 127.0.0.1.
    let res = client
        .post(&url)
        .header("Host", format!("attacker.example:{port}"))
        .json(&pair_body(&code))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    assert!(
        c.pairing.view(now_ms()).active,
        "none of that touched the code"
    );

    // A browser's WebSocket carries its page's Origin: refused at the upgrade.
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        format!("ws://127.0.0.1:{port}/v1/ws"),
    )
    .unwrap();
    req.headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(req).await.is_err());
    // The app's own (React Native sends the server's own origin) is fine.
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        format!("ws://127.0.0.1:{port}/v1/ws"),
    )
    .unwrap();
    req.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{port}").parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    prove(&mut ws).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["t"], "welcome");
}

#[tokio::test]
async fn bad_hellos_cost_one_audit_line_a_minute_not_one_each() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    for _ in 0..200 {
        let mut ws = connect(port).await;
        send(&mut ws, hello(&"0".repeat(64), None)).await;
        assert_eq!(next(&mut ws).await["reason"], "unauthorized");
    }
    let refused = stub.audited().iter().filter(|a| a.1 == "refused").count();
    assert_eq!(refused, 1, "the rest are counted, then written as one line");
    c.refusals.flush(now_ms() + 61_000).iter().for_each(|l| {
        assert!(l.starts_with("199 more failed connections"), "{l}");
    });
}

#[tokio::test]
async fn a_stalled_pair_body_is_dropped_after_its_timeout() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    s.write_all(
        format!(
            "POST /v1/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 16000\r\n\r\n{{"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let started = std::time::Instant::now();
    let mut buf = vec![0u8; 512];
    let n = tokio::time::timeout(
        super::PAIR_BODY_TIMEOUT + Duration::from_secs(5),
        s.read(&mut buf),
    )
    .await
    .expect("answered, not held open")
    .unwrap();
    assert!(started.elapsed() >= super::PAIR_BODY_TIMEOUT - Duration::from_millis(500));
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 408"));
}

#[tokio::test]
async fn connections_are_capped_overall_and_per_source() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    // One source holding requests open (a body that never finishes).
    let mut held = Vec::new();
    for _ in 0..crate::companion::limits::MAX_PER_SOURCE {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        s.write_all(format!("POST /v1/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 100.64.0.9\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{{").as_bytes()).await.unwrap();
        held.push(s);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let busy = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/pair"))
        .header("X-Forwarded-For", "100.64.0.9")
        .json(&pair_body("X"))
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), 429, "that source is at its cap");
    let other = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/pair"))
        .header("X-Forwarded-For", "100.64.0.10")
        .json(&pair_body("X"))
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 404, "another source still gets in");
    drop(held);

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Strangers past their share: the oldest is closed to make room, and
    // the newcomer (maybe the paired phone) is served.
    let mut idle = Vec::new();
    for _ in 0..crate::companion::limits::MAX_UNAUTHENTICATED {
        idle.push(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap(),
        );
        // In order, so "oldest" means the first.
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let ok = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/pair"))
        .json(&pair_body("X"))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 404, "the newcomer is answered");
    let mut buf = [0u8; 16];
    let n = tokio::time::timeout(Duration::from_secs(2), idle[0].read(&mut buf))
        .await
        .expect("the oldest stranger is closed")
        .unwrap_or(0);
    assert_eq!(n, 0);
}

#[tokio::test]
async fn somebody_elses_wrong_codes_never_burn_the_real_one() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (code, _) = c.pairing.start(now_ms());
    let client = reqwest::Client::new();
    let wrong = (0..8).map(|_| {
        client
            .post(format!("http://127.0.0.1:{port}/v1/pair"))
            .header("X-Forwarded-For", "100.64.0.66")
            .json(&pair_body("AAAAAAAAAAAAAAAAAAAAAAAAAA"))
            .send()
    });
    for res in futures_util::future::join_all(wrong).await {
        assert_eq!(res.unwrap().status(), 404);
    }
    desk(&c, true);
    let paired: Value = client
        .post(format!("http://127.0.0.1:{port}/v1/pair"))
        .header("X-Forwarded-For", "100.64.0.2")
        .json(&pair_body(&code))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(paired["ok"], true, "{paired}");
}

#[tokio::test]
async fn uploads_hold_their_room_first_and_http_counts_against_the_limit() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let big = vec![7u8; 4 * 1024 * 1024];
    let all = (0..40).map(|_| {
        put_blob(
            port,
            Some(&token),
            "a.bin",
            "application/octet-stream",
            big.clone(),
        )
    });
    let results = futures_util::future::join_all(all).await;
    let staged = results.iter().filter(|r| r.status() == 200).count();
    assert!(staged <= crate::companion::blobs::MAX_BLOBS_PER_DEVICE);
    assert!(results
        .iter()
        .all(|r| r.status() == 200 || r.status() == 429));
    assert!(staged >= 1);

    // Every route shares the per-minute budget the socket has.
    let mut limited = 0;
    for _ in 0..(crate::companion::MAX_REQUESTS_PER_MINUTE + 20) {
        if get(port, Some(&token), "/v1/blobs/blob_nope")
            .await
            .status()
            == 429
        {
            limited += 1;
        }
    }
    assert!(limited >= 20, "{limited}");
}

#[tokio::test]
async fn revoking_mid_upload_stops_it_and_leaves_nothing() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    s.write_all(format!("PUT /v1/blobs HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: text/plain\r\nX-Name: a.txt\r\nContent-Length: 2000\r\n\r\n").as_bytes()).await.unwrap();
    s.write_all(&[b'x'; 1000]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    c.revoke(&record.id).unwrap();
    s.write_all(&[b'x'; 1000]).await.unwrap();
    let mut buf = vec![0u8; 512];
    let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 401"));
    assert!(c.blobs.get(&record.id, "anything", now_ms()).is_none());
    let left = std::fs::read_dir(c.blobs.dir())
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(left, 0, "no partial file left behind");
}

#[tokio::test]
async fn a_revoke_cancels_the_requests_its_socket_had_running() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    let (mut ws, ..) = open(port, &token, None).await;
    send(
        &mut ws,
        json!({ "t": "req", "id": 1, "method": "agents.memorySuggest", "params": { "text": "slow" } }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    c.revoke(&record.id).unwrap();
    assert_eq!(next(&mut ws).await["reason"], "revoked");
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(
        stub.slow_done.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "aborted, not finished after the phone was removed"
    );

    // An ordinary close lets running work finish (a retried send by
    // clientId is better done once than cut in half).
    let (_, token, _) = c
        .registry
        .add(&other_phone(), String::new(), 1, &[], None)
        .unwrap();
    let (mut ws, ..) = open(port, &token, None).await;
    send(
        &mut ws,
        json!({ "t": "req", "id": 1, "method": "agents.memorySuggest", "params": { "text": "slow" } }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(ws);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(stub.slow_done.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn thumbnails_refuse_a_decompression_bomb_and_cache_the_rest() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(&phone(), String::new(), 1, &[], None)
        .unwrap();
    // 8000 x 6000 = 48 MP: a small file that says it is huge.
    let bomb = {
        let img = image::GrayImage::new(8000, 6000);
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    };
    assert!(bomb.len() < 2 * 1024 * 1024);
    let blob: Value = put_blob(port, Some(&token), "bomb.png", "image/png", bomb)
        .await
        .json()
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let res = get(
        port,
        Some(&token),
        &format!("/v1/blobs/{}?w=16", blob["blobId"].as_str().unwrap()),
    )
    .await;
    assert_eq!(res.status(), 422);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "refused from its header, not decoded"
    );

    let ok: Value = put_blob(port, Some(&token), "ok.png", "image/png", png(800, 400))
        .await
        .json()
        .await
        .unwrap();
    let path = format!("/v1/blobs/{}?w=100", ok["blobId"].as_str().unwrap());
    let first = get(port, Some(&token), &path).await.bytes().await.unwrap();
    let again = get(port, Some(&token), &path).await.bytes().await.unwrap();
    assert_eq!(first, again);
    assert!(image::load_from_memory(&first).unwrap().width() <= 100);
}

#[tokio::test]
async fn a_token_used_by_another_tailnet_user_is_refused() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c
        .registry
        .add(
            &phone(),
            String::new(),
            1,
            &[],
            Some("julian@example.com".into()),
        )
        .unwrap();
    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/blobs/x"))
        .bearer_auth(&token)
        .header("Tailscale-User-Login", "mallory@example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        format!("ws://127.0.0.1:{port}/v1/ws"),
    )
    .unwrap();
    req.headers_mut().insert(
        "Tailscale-User-Login",
        "mallory@example.com".parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    prove(&mut ws).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["reason"], "unauthorized");
    // The same user is let in.
    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/blobs/x"))
        .bearer_auth(&token)
        .header("Tailscale-User-Login", "julian@example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
