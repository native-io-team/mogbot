//! The registry lock's rules, each held by a test that hung before it
//! (child of store.rs; see `store_lock.rs`). Every wait here is bounded, so
//! a regression fails the test instead of hanging the suite.
use super::*;
use std::sync::mpsc;
use std::time::Duration;

fn scratch() -> (tempfile::TempDir, Agent) {
    let dir = tempfile::tempdir().unwrap();
    set_root_for_tests(Some(dir.path().to_path_buf()));
    let agent = create(NewAgent {
        name: "Locky".into(),
        role: "Holds things".into(),
        instructions: "Be brief.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    (dir, agent)
}

/// The phone's overview read `list()` while a writer held the registry
/// lock, and waited behind it for as long as the writer took: every
/// companion request, the watch tick and the inventory queued on one lock.
/// Reads no longer take it.
#[test]
fn a_read_never_waits_on_a_writer() {
    let _serial = tests_lock();
    let (_dir, agent) = scratch();
    let (inside_tx, inside_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let id = agent.id.clone();
    let writer = std::thread::spawn(move || {
        update(&id, |a| {
            a.role = "Changed".into();
            let _ = inside_tx.send(());
            // Held as long as the test says: a writer stuck on a slow disk.
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
        })
    });
    inside_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (read_tx, read_rx) = mpsc::channel();
    let id = agent.id.clone();
    std::thread::spawn(move || {
        let _ = read_tx.send((list().map(|l| l.len()), get(&id).map(|a| a.role)));
    });
    let read = read_rx.recv_timeout(Duration::from_secs(2));
    let _ = release_tx.send(());
    let (count, role) = read.expect("list() waited on the registry lock");
    assert_eq!(count.unwrap(), 1);
    // The version before the write: the file is replaced whole, or not yet.
    assert_eq!(role.unwrap(), "Holds things");
    assert_eq!(writer.join().unwrap().unwrap().role, "Changed");
    assert_eq!(get(&agent.id).unwrap().role, "Changed");
    set_root_for_tests(None);
}

/// A store write from inside an `update` closure took the same
/// `std::sync::Mutex` twice on one thread and waited on itself for ever.
/// It is refused with an error now, and the outer write still lands.
#[test]
fn re_entering_the_registry_lock_is_refused_not_a_hang() {
    let _serial = tests_lock();
    let (_dir, agent) = scratch();
    let (tx, rx) = mpsc::channel();
    let id = agent.id.clone();
    std::thread::spawn(move || {
        let mut inner = None;
        let outer = update(&id, |a| {
            inner = Some(update(&id, |b| b.role = "Inner".into()).map(|_| ()));
            a.role = "Outer".into();
        });
        let _ = tx.send((outer.map(|a| a.role), inner));
    });
    let (outer, inner) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a re-entrant update deadlocked");
    assert_eq!(outer.unwrap(), "Outer");
    let err = inner.unwrap().unwrap_err();
    assert!(err.to_string().contains("busy"), "{err}");
    // Reads inside a write are fine: they don't take the lock.
    let (tx, rx) = mpsc::channel();
    let id = agent.id.clone();
    std::thread::spawn(move || {
        let mut seen = None;
        let _ = update(&id, |_| seen = Some(get(&id).map(|a| a.name)));
        let _ = tx.send(seen);
    });
    let seen = rx.recv_timeout(Duration::from_secs(5)).expect("a read inside a write hung");
    assert_eq!(seen.unwrap().unwrap(), "Locky");
    set_root_for_tests(None);
}

/// A writer behind one that never lets go gives up with "busy" instead of
/// joining it for ever (what left every companion request unanswered).
#[test]
fn a_writer_gives_up_on_a_wedged_lock() {
    let _serial = tests_lock();
    let (_dir, agent) = scratch();
    lock::set_wait_for_tests(Some(Duration::from_millis(200)));
    let (inside_tx, inside_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let id = agent.id.clone();
    let wedged = std::thread::spawn(move || {
        update(&id, |_| {
            let _ = inside_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
        })
    });
    inside_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (tx, rx) = mpsc::channel();
    let id = agent.id.clone();
    std::thread::spawn(move || {
        let _ = tx.send(update(&id, |a| a.role = "Late".into()).map(|_| ()));
    });
    let late = rx.recv_timeout(Duration::from_secs(3));
    let _ = release_tx.send(());
    wedged.join().unwrap().unwrap();
    lock::set_wait_for_tests(None);
    let err = late.expect("a writer waited on a wedged lock for ever").unwrap_err();
    assert_eq!(err.to_string(), lock::BUSY);
    // Released, the next write goes through.
    assert_eq!(update(&agent.id, |a| a.role = "Now".into()).unwrap().role, "Now");
    set_root_for_tests(None);
}

/// Two locks taken in opposite orders: a policy change reading the agents
/// list under the policy lock, while a delete held the registry lock and
/// waited for the policy lock to forget the agent's policy. Each waited on
/// the other for ever. The delete now forgets after releasing the registry,
/// and the read doesn't take it.
#[test]
fn a_delete_and_a_policy_change_never_wait_on_each_other() {
    let _serial = tests_lock();
    let (_dir, agent) = scratch();
    let (inside_tx, inside_rx) = mpsc::channel::<()>();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let policy = std::thread::spawn(move || {
        super::super::policy::modify(|_| {
            let _ = inside_tx.send(());
            let _ = go_rx.recv_timeout(Duration::from_secs(10));
            Ok(list().map(|l| l.len()).unwrap_or(99))
        })
    });
    inside_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (tx, rx) = mpsc::channel();
    let id = agent.id.clone();
    std::thread::spawn(move || {
        let _ = tx.send(delete(&id).map(|a| a.id));
    });
    // Let the delete reach the policy lock before the policy side reads.
    std::thread::sleep(Duration::from_millis(200));
    let _ = go_tx.send(());
    let deleted = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the delete and the policy change deadlocked");
    assert_eq!(deleted.unwrap(), agent.id);
    let seen = policy.join().unwrap().unwrap();
    assert!(seen <= 1, "{seen}");
    assert!(list().unwrap().is_empty());
    set_root_for_tests(None);
}
