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
    let seen = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a read inside a write hung");
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
    let err = late
        .expect("a writer waited on a wedged lock for ever")
        .unwrap_err();
    assert_eq!(err.to_string(), lock::BUSY);
    // Released, the next write goes through.
    assert_eq!(
        update(&agent.id, |a| a.role = "Now".into()).unwrap().role,
        "Now"
    );
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

/// Hold the registry lock on another thread until the returned sender
/// fires (or 10 s pass), with writers giving up after 200 ms.
fn wedge(id: &str) -> (std::thread::JoinHandle<()>, mpsc::Sender<()>) {
    lock::set_wait_for_tests(Some(Duration::from_millis(200)));
    let (inside_tx, inside_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let id = id.to_string();
    let held = std::thread::spawn(move || {
        let _ = update(&id, |_| {
            let _ = inside_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
        });
    });
    inside_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    (held, release_tx)
}

/// Run `f` on a thread and wait at most 3 s for it.
fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(3))
        .expect("waited on a wedged registry lock for ever")
}

/// Deleting moved the agent's folder to the trash while holding the
/// registry lock. The move happens outside it now; one that can't get the
/// lock is told "busy" in bounded time and leaves the folder where it was.
#[test]
fn a_delete_that_cant_get_the_lock_leaves_the_folder_in_place() {
    let _serial = tests_lock();
    let (dir, agent) = scratch();
    let home = dir.path().join(&agent.id);
    assert!(home.join("CLAUDE.md").exists());
    let (held, release) = wedge(&agent.id);
    let id = agent.id.clone();
    let err = within(move || soft_delete(&id, None)).unwrap_err();
    let _ = release.send(());
    held.join().unwrap();
    lock::set_wait_for_tests(None);
    assert_eq!(err.to_string(), lock::BUSY);
    assert!(
        home.join("CLAUDE.md").exists(),
        "the folder went to the trash"
    );
    assert!(!dir.path().join(TRASH_DIR).join(&agent.id).exists());
    assert!(trashed().is_empty());
    assert_eq!(get(&agent.id).unwrap().id, agent.id);
    // Released, the delete and the restore go through, folder and all.
    soft_delete(&agent.id, None).unwrap();
    assert!(!home.exists());
    assert!(dir
        .path()
        .join(TRASH_DIR)
        .join(&agent.id)
        .join("CLAUDE.md")
        .exists());
    assert_eq!(trashed().len(), 1);
    restore(&agent.id).unwrap();
    assert!(home.join("CLAUDE.md").exists());
    assert!(trashed().is_empty());
    set_root_for_tests(None);
}

/// The same for a restore: busy, and the folder stays in the trash.
#[test]
fn a_restore_that_cant_get_the_lock_leaves_the_folder_in_the_trash() {
    let _serial = tests_lock();
    let (dir, agent) = scratch();
    let other = create(NewAgent {
        name: "Holder".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    soft_delete(&agent.id, None).unwrap();
    let kept = dir.path().join(TRASH_DIR).join(&agent.id);
    assert!(kept.exists());
    let (held, release) = wedge(&other.id);
    let id = agent.id.clone();
    let err = within(move || restore(&id)).unwrap_err();
    let _ = release.send(());
    held.join().unwrap();
    lock::set_wait_for_tests(None);
    assert_eq!(err.to_string(), lock::BUSY);
    assert!(kept.join("CLAUDE.md").exists(), "the folder left the trash");
    assert!(!dir.path().join(&agent.id).exists());
    assert_eq!(trashed().len(), 1);
    set_root_for_tests(None);
}

/// Creating made the folder and wrote CLAUDE.md under the lock. Both happen
/// before it now; a create that can't get the lock is busy in bounded time
/// and leaves no folder behind.
#[test]
fn a_create_that_cant_get_the_lock_leaves_no_folder() {
    let _serial = tests_lock();
    let (dir, agent) = scratch();
    let late = || NewAgent {
        name: "Late".into(),
        role: "Arrives late".into(),
        instructions: "Hi.".into(),
        shape: None,
        color: None,
        is_main: false,
    };
    let (held, release) = wedge(&agent.id);
    let err = within(move || create(late())).unwrap_err();
    let _ = release.send(());
    held.join().unwrap();
    lock::set_wait_for_tests(None);
    assert_eq!(err.to_string(), lock::BUSY);
    let folders: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(folders, vec![agent.id.clone()], "a stray folder was left");
    // Released, it goes through with its CLAUDE.md written.
    let made = create(late()).unwrap();
    let md = std::fs::read_to_string(dir.path().join(&made.id).join("CLAUDE.md")).unwrap();
    assert!(
        md.starts_with("# Late\n\nArrives late\n\n## Instructions\n\nHi."),
        "{md}"
    );
    set_root_for_tests(None);
}

/// A trash entry for an agent that's on the team (a restore whose list
/// update failed) is dropped by the sweep, never purged: purging would
/// forget a live agent's secrets.
#[test]
fn the_trash_sweep_never_purges_an_agent_on_the_team() {
    let _serial = tests_lock();
    let (_dir, agent) = scratch();
    write_trash(&[Deleted {
        agent: serde_json::to_value(&agent).unwrap(),
        deleted_at: 0,
        deleted_by: None,
    }])
    .unwrap();
    assert!(take_expired(now_ms()).is_empty(), "a live agent was purged");
    assert!(trashed().is_empty());
    assert!(get(&agent.id).is_ok());
    set_root_for_tests(None);
}
