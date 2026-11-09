//! The link end to end on a real Unix socket: the app's side
//! ([`start_at`], `link`), the host's side (`host::connect`, `host::relay`)
//! and a scripted extension standing in for Chrome.

use super::protocol::*;
use super::*;
use crate::agents::store::Agent;
use serde_json::{json, Value};

use std::os::unix::net::UnixStream;
use std::time::Duration;

fn agent() -> Agent {
    serde_json::from_value(json!({
        "id": "ops", "name": "Ops", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap()
}

fn origin() -> String {
    format!("chrome-extension://{}/", auth::DEV_EXTENSION_ID)
}

fn send(s: &mut UnixStream, v: &Value) {
    frame::write(s, &serde_json::to_vec(v).unwrap(), frame::MAX_FROM_CHROME).unwrap();
}

fn recv(s: &mut UnixStream) -> Value {
    serde_json::from_slice(&frame::read(s, frame::MAX_FROM_CHROME).unwrap()).unwrap()
}

fn hello(profile: &str, v: u32) -> Value {
    json!({ "t": "hello", "v": v, "extension_version": "0.1.0", "profile_id": profile, "profile_label": "Work" })
}

/// A started link in a temp folder, with its registry.
async fn started() -> (tempfile::TempDir, Running, Arc<link::Registry>) {
    let dir = tempfile::tempdir().unwrap();
    let reg = link::Registry::new();
    let running = start_at(dir.path(), reg.clone()).await.unwrap();
    (dir, running, reg)
}

/// Wait (briefly) for the registry to hold `n` connections.
async fn wait_for(reg: &link::Registry, n: usize) {
    for _ in 0..100 {
        if reg.conns().len() == n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("expected {n} connections, have {}", reg.conns().len());
}

#[test]
fn a_turn_gets_it_only_when_everything_says_yes() {
    let a = agent();
    assert!(allowed(true, true, true, &a, false));
    assert!(!allowed(false, true, true, &a, false), "switch off");
    assert!(
        !allowed(true, false, true, &a, false),
        "no Chrome answering"
    );
    assert!(
        !allowed(true, true, false, &a, false),
        "its settings say no"
    );
    assert!(!allowed(true, true, true, &a, true), "outside text");
    let mut off = agent();
    off.reach.browser_off = true;
    assert!(
        !allowed(true, true, true, &off, false),
        "its browser is off"
    );
    // Any engine: Codex too.
    let mut codex = agent();
    codex.engine = crate::agents::engine::Engine::Codex;
    assert!(allowed(true, true, true, &codex, false));
}

#[test]
fn versions_compare_by_number() {
    assert!(older("0.1.0", "0.2.0"));
    assert!(older("0.9.0", "0.10.0"));
    assert!(!older("1.0.0", "1.0.0"));
    assert!(!older("1.1", "1.0.9"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_and_extension_reach_the_app_and_calls_are_answered() {
    let (dir, running, reg) = started().await;
    let path = dir.path().to_path_buf();
    let o = origin();
    // The host's handshake, then the extension's hello through it.
    let mut s = tokio::task::spawn_blocking(move || host::connect(&path, &o).unwrap())
        .await
        .unwrap();
    send(&mut s, &hello("p-1", PROTOCOL));
    let mut ext = s.try_clone().unwrap();
    let welcome = tokio::task::spawn_blocking(move || recv(&mut ext))
        .await
        .unwrap();
    assert_eq!(welcome["t"], "welcome");
    assert_eq!(welcome["v"], PROTOCOL);
    wait_for(&reg, 1).await;
    let conn = reg.conns().pop().unwrap();
    assert_eq!(conn.profile_id, "p-1");
    assert_eq!(conn.profile_label, "Work");

    // The extension answers one request.
    let mut ext = s.try_clone().unwrap();
    let answering = std::thread::spawn(move || {
        let req = recv(&mut ext);
        assert_eq!(req["t"], "req");
        assert_eq!(req["op"]["kind"], "tabs_list");
        send(
            &mut ext,
            &json!({ "t": "res", "id": req["id"], "ok": true, "result": [
                { "tab_id": 7, "window_id": 1, "url": "https://example.com/", "title": "Example", "active": true, "status": "complete", "agent": "ops" }
            ] }),
        );
        // And refuses the next.
        let req = recv(&mut ext);
        send(
            &mut ext,
            &json!({ "t": "res", "id": req["id"], "ok": false, "error": { "code": "not_owned", "message": "not yours" } }),
        );
    });
    let c = conn.clone();
    let got = tokio::task::spawn_blocking(move || c.call(Op::TabsList, Duration::from_secs(5)))
        .await
        .unwrap()
        .unwrap();
    let tabs: Vec<TabInfo> = serde_json::from_value(got).unwrap();
    assert_eq!(tabs[0].tab_id, 7);
    let c = conn.clone();
    let refused = tokio::task::spawn_blocking(move || {
        c.call(
            Op::TabClose {
                agent: "ops".into(),
                tab_id: 9,
            },
            Duration::from_secs(5),
        )
    })
    .await
    .unwrap()
    .unwrap_err();
    assert!(matches!(refused, link::CallError::Ext(ref e) if e.code == ErrorCode::NotOwned));
    assert!(refused.line().contains("isn't one you opened"));
    answering.join().unwrap();

    // Chrome goes away: the connection does, and a call hears so at once.
    drop(s);
    wait_for(&reg, 0).await;
    assert_eq!(
        conn.call(Op::Ping, Duration::from_secs(1)).unwrap_err(),
        link::CallError::Gone
    );
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_closing_the_link_says_why_then_ends_the_socket() {
    let (dir, running, reg) = started().await;
    let path = dir.path().to_path_buf();
    let mut s = tokio::task::spawn_blocking(move || host::connect(&path, &origin()).unwrap())
        .await
        .unwrap();
    send(&mut s, &hello("p-1", PROTOCOL));
    let _ = recv(&mut s);
    wait_for(&reg, 1).await;
    running.stop(&reg, "quit");
    let (bye, end) = tokio::task::spawn_blocking(move || {
        let bye = recv(&mut s);
        (bye, frame::read(&mut s, 100))
    })
    .await
    .unwrap();
    assert_eq!(bye, json!({ "t": "bye", "reason": "quit" }));
    // The host's read ends, so the host exits and Chrome's port closes.
    assert!(matches!(end, Err(frame::FrameError::Closed)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_nobody_answers_times_out() {
    let (dir, running, reg) = started().await;
    let path = dir.path().to_path_buf();
    let o = origin();
    let mut s = tokio::task::spawn_blocking(move || host::connect(&path, &o).unwrap())
        .await
        .unwrap();
    send(&mut s, &hello("p-1", PROTOCOL));
    let _ = recv(&mut s);
    wait_for(&reg, 1).await;
    let conn = reg.conns().pop().unwrap();
    let e = tokio::task::spawn_blocking(move || conn.call(Op::Ping, Duration::from_millis(200)))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(e, link::CallError::Timeout);
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_without_the_token_is_refused_and_learns_nothing() {
    let (dir, running, reg) = started().await;
    let sock = auth::socket_path(dir.path());
    let refused = tokio::task::spawn_blocking(move || {
        let s = UnixStream::connect(sock).unwrap();
        host::handshake(s, &auth::random_hex(32), &origin()).err()
    })
    .await
    .unwrap();
    // The app proved itself with the real token; the host, holding another,
    // can't check that proof, so it refuses the app.
    assert_eq!(refused, Some("refused"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(reg.conns().is_empty());
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_refuses_a_host_that_cant_prove_the_token() {
    let (dir, running, reg) = started().await;
    let sock = auth::socket_path(dir.path());
    let answer = tokio::task::spawn_blocking(move || {
        let mut s = UnixStream::connect(sock).unwrap();
        send(
            &mut s,
            &json!({ "t": "host_hello", "v": PROTOCOL, "origin": origin(), "host_nonce": auth::nonce() }),
        );
        let challenge = recv(&mut s);
        assert_eq!(challenge["t"], "app_challenge");
        send(&mut s, &json!({ "t": "host_proof", "proof": "00".repeat(32) }));
        recv(&mut s)
    })
    .await
    .unwrap();
    assert_eq!(answer, json!({ "t": "refused", "reason": "proof" }));
    assert!(reg.conns().is_empty());
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_extension_or_an_old_protocol_is_refused() {
    let (dir, running, reg) = started().await;
    for (origin, v, reason) in [
        (
            "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/".to_string(),
            PROTOCOL,
            "origin",
        ),
        (origin(), 0, "version"),
    ] {
        let sock = auth::socket_path(dir.path());
        let answer = tokio::task::spawn_blocking(move || {
            let mut s = UnixStream::connect(sock).unwrap();
            send(
                &mut s,
                &json!({ "t": "host_hello", "v": v, "origin": origin, "host_nonce": auth::nonce() }),
            );
            recv(&mut s)
        })
        .await
        .unwrap();
        assert_eq!(answer, json!({ "t": "refused", "reason": reason }));
    }
    // An extension too new for this build hears why, and isn't kept.
    let path = dir.path().to_path_buf();
    let mut s = tokio::task::spawn_blocking(move || host::connect(&path, &origin()).unwrap())
        .await
        .unwrap();
    send(&mut s, &hello("p-1", PROTOCOL + 1));
    let bye = tokio::task::spawn_blocking(move || recv(&mut s))
        .await
        .unwrap();
    assert_eq!(bye, json!({ "t": "bye", "reason": "version" }));
    assert!(reg.conns().is_empty());
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_profile_reconnecting_replaces_the_old_link() {
    let (dir, running, reg) = started().await;
    let mut first = {
        let path = dir.path().to_path_buf();
        tokio::task::spawn_blocking(move || host::connect(&path, &origin()).unwrap())
            .await
            .unwrap()
    };
    send(&mut first, &hello("p-1", PROTOCOL));
    let _ = recv(&mut first);
    wait_for(&reg, 1).await;
    let old = reg.conns().pop().unwrap();
    let mut second = {
        let path = dir.path().to_path_buf();
        tokio::task::spawn_blocking(move || host::connect(&path, &origin()).unwrap())
            .await
            .unwrap()
    };
    send(&mut second, &hello("p-1", PROTOCOL));
    let _ = recv(&mut second);
    // A second profile alongside.
    let mut other = {
        let path = dir.path().to_path_buf();
        tokio::task::spawn_blocking(move || host::connect(&path, &origin()).unwrap())
            .await
            .unwrap()
    };
    send(&mut other, &hello("p-2", PROTOCOL));
    let _ = recv(&mut other);
    wait_for(&reg, 2).await;
    assert!(old.is_closed());
    let bye = tokio::task::spawn_blocking(move || recv(&mut first))
        .await
        .unwrap();
    assert_eq!(bye, json!({ "t": "bye", "reason": "replaced" }));
    let ids: Vec<String> = reg.conns().iter().map(|c| c.profile_id.clone()).collect();
    assert_eq!(ids, vec!["p-2".to_string(), "p-1".to_string()]);
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_socket_isnt_taken_over_and_a_stale_one_is() {
    let (dir, running, reg) = started().await;
    let e = link::bind(dir.path()).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::AddrInUse);
    running.stop(&reg, "test");
    // A socket file left by a crashed run: replaced.
    let stale = std::os::unix::net::UnixListener::bind(auth::socket_path(dir.path())).unwrap();
    drop(stale);
    let (_l, p) = link::bind(dir.path()).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn the_host_relays_both_ways_unchanged_and_tells_chrome_when_the_app_is_away() {
    // App away: one frame telling the extension, then nothing.
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        host::connect(dir.path(), &origin()).unwrap_err(),
        "app_not_running"
    );
    let mut out = Vec::new();
    // `run` reads the real link folder; here only the message is checked.
    let body = serde_json::to_vec(&ToExtension::Unavailable {
        reason: "app_not_running".into(),
    })
    .unwrap();
    frame::write(&mut out, &body, frame::MAX_TO_CHROME).unwrap();
    let back: Value =
        serde_json::from_slice(&frame::read(&mut out.as_slice(), 100).unwrap()).unwrap();
    assert_eq!(
        back,
        json!({ "t": "unavailable", "reason": "app_not_running" })
    );

    // Relay: Chrome's frames reach the app, the app's reach Chrome.
    let (app_side, host_side) = UnixStream::pair().unwrap();
    // Chrome's side: a pipe it writes two frames into, closed once the app
    // has answered (Chrome closing stdin is what ends a host).
    let (mut chrome_in, mut host_stdin) = UnixStream::pair().unwrap();
    std::io::Write::write_all(&mut chrome_in, &frame::encode(b"{\"a\":1}")).unwrap();
    std::io::Write::write_all(&mut chrome_in, &frame::encode(b"{\"b\":2}")).unwrap();
    let mut app = app_side.try_clone().unwrap();
    let app_thread = std::thread::spawn(move || {
        let a = frame::read(&mut app, 100).unwrap();
        let b = frame::read(&mut app, 100).unwrap();
        frame::write(&mut app, b"{\"c\":3}", 100).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        drop(chrome_in);
        (a, b)
    });
    let mut to_chrome = Vec::new();
    host::relay(host_side, &mut host_stdin, &mut to_chrome, false).unwrap();
    let (a, b) = app_thread.join().unwrap();
    assert_eq!(a, b"{\"a\":1}");
    assert_eq!(b, b"{\"b\":2}");
    assert_eq!(
        frame::read(&mut to_chrome.as_slice(), 100).unwrap(),
        b"{\"c\":3}"
    );
    drop(app_side);

    // The host refuses to start for anyone but the extension.
    assert_eq!(host::run(&["dashbot".into()]), 1);
    assert_eq!(
        host::run(&[
            "dashbot".into(),
            "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/".into()
        ]),
        1
    );
}

#[test]
fn messages_have_the_shapes_the_extension_sends() {
    // Exactly what chrome-extension/extension/src/protocol.js writes.
    let ev: FromExtension = serde_json::from_value(json!({
        "t": "event", "event": { "kind": "tab_closed", "tab_id": 3, "agent": "ops" }
    }))
    .unwrap();
    assert_eq!(
        ev,
        FromExtension::Event {
            event: ExtEvent::TabClosed {
                tab_id: 3,
                agent: "ops".into()
            }
        }
    );
    let unknown: FromExtension = serde_json::from_value(json!({
        "t": "res", "id": 1, "ok": false, "error": { "code": "something_new", "message": "?" }
    }))
    .unwrap();
    let FromExtension::Res { error: Some(e), .. } = unknown else {
        panic!()
    };
    assert_eq!(e.code, ErrorCode::Unknown);
    let req = serde_json::to_value(ToExtension::Req {
        id: 4,
        op: Op::Cdp {
            agent: "ops".into(),
            tab_id: 3,
            method: "DOM.getBoxModel".into(),
            params: json!({ "backendNodeId": 9 }),
        },
    })
    .unwrap();
    assert_eq!(
        req,
        json!({ "t": "req", "id": 4, "op": { "kind": "cdp", "agent": "ops", "tab_id": 3, "method": "DOM.getBoxModel", "params": { "backendNodeId": 9 } } })
    );
    assert_eq!(
        serde_json::to_value(ToExtension::Req {
            id: 1,
            op: Op::TabsList
        })
        .unwrap(),
        json!({ "t": "req", "id": 1, "op": { "kind": "tabs_list" } })
    );
    assert_eq!(Op::Release { agent: "a".into() }.agent(), Some("a"));
    assert_eq!(Op::Ping.agent(), None);
}

#[test]
fn the_extensions_copy_of_the_protocol_matches() {
    let js = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../chrome-extension/extension/src/protocol.js"),
    )
    .unwrap();
    assert!(
        js.contains(&format!("export const PROTOCOL = {PROTOCOL};")),
        "protocol.js names another version"
    );
    for kind in [
        "ping",
        "tabs_list",
        "tabs_open",
        "tab_get",
        "tab_close",
        "tab_focus",
        "release",
        "cdp",
    ] {
        assert!(
            js.contains(&format!("'{kind}'")),
            "protocol.js doesn't handle {kind}"
        );
    }
    for code in [
        "bad_request",
        "not_owned",
        "no_tab",
        "not_allowed",
        "attach_failed",
        "cdp",
        "protected",
        "internal",
    ] {
        assert!(
            js.contains(&format!("'{code}'")),
            "protocol.js doesn't send {code}"
        );
    }
}
