//! The self-heal on a real Unix socket in a scratch folder: a token, a
//! socket or a host manifest changed under the app is put back, and a Chrome
//! already linked stays linked.

use super::heal::{self, Fix};
use super::protocol::*;
use super::*;
use serde_json::{json, Value};
use std::os::unix::net::UnixStream;
use std::time::Duration;

fn origin() -> String {
    format!("chrome-extension://{}/", auth::DEV_EXTENSION_ID)
}

fn send(s: &mut UnixStream, v: &Value) {
    frame::write(s, &serde_json::to_vec(v).unwrap(), frame::MAX_FROM_CHROME).unwrap();
}

fn recv(s: &mut UnixStream) -> Value {
    serde_json::from_slice(&frame::read(s, frame::MAX_FROM_CHROME).unwrap()).unwrap()
}

async fn started() -> (tempfile::TempDir, Running, Arc<link::Registry>) {
    let dir = tempfile::tempdir().unwrap();
    let reg = link::Registry::new();
    let running = start_at(dir.path(), reg.clone()).await.unwrap();
    (dir, running, reg)
}

async fn host_gets_through(dir: &Path) -> bool {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || host::connect(&dir, &origin()).is_ok())
        .await
        .unwrap()
}

/// A scripted extension linked through a real host handshake.
async fn linked(dir: &Path, reg: &link::Registry) -> UnixStream {
    let (path, o) = (dir.to_path_buf(), origin());
    let mut s = tokio::task::spawn_blocking(move || host::connect(&path, &o).unwrap())
        .await
        .unwrap();
    send(
        &mut s,
        &json!({ "t": "hello", "v": PROTOCOL, "extension_version": "0.1.0", "profile_id": "p-1", "profile_label": "Work" }),
    );
    let mut r = s.try_clone().unwrap();
    let welcome = tokio::task::spawn_blocking(move || recv(&mut r))
        .await
        .unwrap();
    assert_eq!(welcome["t"], "welcome");
    for _ in 0..100 {
        if reg.conns().len() == 1 {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never linked");
}

#[test]
fn only_release_builds_heal() {
    // The tests are a debug build: it must never take the installed app's link back.
    assert_eq!(heal::HEALS, !cfg!(debug_assertions));
    assert_eq!(heal::HEAL_EVERY, Duration::from_secs(60));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_healthy_link_is_left_alone() {
    let (dir, mut running, reg) = started().await;
    let token = auth::read_token(dir.path()).unwrap();
    assert!(running.token_ok(dir.path()) && running.socket_ok());
    let fixed = heal::heal_link(dir.path(), &mut running, reg.clone()).unwrap();
    assert!(fixed.is_empty());
    assert_eq!(auth::read_token(dir.path()).unwrap(), token);
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_rewritten_by_another_copy_is_put_back() {
    let (dir, mut running, reg) = started().await;
    let ours = auth::read_token(dir.path()).unwrap();
    // Another copy wrote its own token: every new host is locked out.
    auth::fresh_token(dir.path()).unwrap();
    assert!(!running.token_ok(dir.path()));
    assert!(!host_gets_through(dir.path()).await);

    let fixed = heal::heal_link(dir.path(), &mut running, reg.clone()).unwrap();
    assert_eq!(fixed, vec![Fix::Token]);
    assert_eq!(auth::read_token(dir.path()).unwrap(), ours);
    assert!(host_gets_through(dir.path()).await);
    // A token file anyone could read isn't the app's: rewritten too.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        auth::token_path(dir.path()),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(
        heal::heal_link(dir.path(), &mut running, reg.clone()).unwrap(),
        vec![Fix::Token]
    );
    assert!(host_gets_through(dir.path()).await);
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_socket_is_bound_again_and_the_linked_chrome_stays() {
    let (dir, mut running, reg) = started().await;
    let token = auth::read_token(dir.path()).unwrap();
    let chrome = linked(dir.path(), &reg).await;
    // Something removed the socket file: no new host reaches this copy.
    std::fs::remove_file(auth::socket_path(dir.path())).unwrap();
    assert!(!running.socket_ok());
    assert!(!host_gets_through(dir.path()).await);

    let fixed = heal::heal_link(dir.path(), &mut running, reg.clone()).unwrap();
    assert_eq!(fixed, vec![Fix::Socket]);
    assert!(running.socket_ok());
    assert_eq!(auth::read_token(dir.path()).unwrap(), token, "same token");
    assert!(host_gets_through(dir.path()).await);
    // The Chrome linked before the fix still answers.
    assert_eq!(reg.conns().len(), 1);
    let conn = reg.conns().pop().unwrap();
    let mut r = chrome.try_clone().unwrap();
    let answering = std::thread::spawn(move || {
        let req = recv(&mut r);
        send(
            &mut r,
            &json!({ "t": "res", "id": req["id"], "ok": true, "result": [] }),
        );
    });
    tokio::task::spawn_blocking(move || conn.call(Op::TabsList, Duration::from_secs(5)))
        .await
        .unwrap()
        .unwrap();
    answering.join().unwrap();
    let _ = chrome.shutdown(std::net::Shutdown::Both);
    running.stop(&reg, "test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_socket_another_copy_put_in_its_place_is_taken_back() {
    let (dir, mut running, reg) = started().await;
    // Another copy removed ours and listens in its place, with its own token.
    std::fs::remove_file(auth::socket_path(dir.path())).unwrap();
    let other_reg = link::Registry::new();
    let other = start_at(dir.path(), other_reg.clone()).await.unwrap();
    assert!(!running.socket_ok() && !running.token_ok(dir.path()));

    let fixed = heal::heal_link(dir.path(), &mut running, reg.clone()).unwrap();
    assert_eq!(fixed, vec![Fix::Socket, Fix::Token]);
    assert!(running.socket_ok() && running.token_ok(dir.path()));
    // New hosts reach this copy, not the other.
    let s = linked(dir.path(), &reg).await;
    assert!(other_reg.conns().is_empty());
    let _ = s.shutdown(std::net::Shutdown::Both);
    other.task.abort();
    running.stop(&reg, "test");
}

#[test]
fn a_host_manifest_naming_another_binary_is_rewritten() {
    let udd = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let exe = bin.path().join("app");
    std::fs::write(&exe, b"binary").unwrap();
    let other = bin.path().join("dev-copy");
    std::fs::write(&other, b"other").unwrap();

    // Missing: written.
    assert!(heal::heal_manifest_at(udd.path(), &exe).unwrap());
    assert_eq!(
        install::host_state_for_app(udd.path(), &exe),
        install::HostState::Current
    );
    // Current: left alone.
    assert!(!heal::heal_manifest_at(udd.path(), &exe).unwrap());
    // Another copy pointed it at itself: put back.
    install::install_host(udd.path(), &other).unwrap();
    assert_eq!(
        install::host_state_for_app(udd.path(), &exe),
        install::HostState::Stale
    );
    assert!(heal::heal_manifest_at(udd.path(), &exe).unwrap());
    assert_eq!(
        install::host_state_for_app(udd.path(), &exe),
        install::HostState::Current
    );
}
