use super::*;
use crate::agents::engine::Engine;
use crate::agents::store::{self, MessageKind, NewAgent};

fn with_root<F: FnOnce(&Path)>(f: F) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    // Lines an earlier test left queued aren't this test's.
    said("couldn't be read");
    f(dir.path());
    store::set_root_for_tests(None);
}

/// Files in `dir` whose name starts with `prefix`.
fn kept(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(prefix))
        })
        .collect()
}

/// Lines queued for the Chief that mention `needle` (other tests queue too).
fn said(needle: &str) -> Vec<String> {
    let all = take_pending();
    let (mine, others): (Vec<_>, Vec<_>) = all.into_iter().partition(|l| l.contains(needle));
    for l in others {
        say(l);
    }
    mine
}

/* ------------------------------------------------------------ loops */

#[test]
fn a_panicking_tick_is_caught_and_the_loop_goes_on() {
    let mut ran = Vec::new();
    for n in 0..3 {
        let out = tick_blocking("test_loop_sync", || {
            if n == 1 {
                panic!("tick {n} broke");
            }
            n
        });
        if let Some(n) = out {
            ran.push(n);
        }
    }
    assert_eq!(ran, [0, 2]);
}

#[tokio::test]
async fn a_panicking_async_tick_is_caught_and_the_loop_goes_on() {
    let mut ran = Vec::new();
    for n in 0..3 {
        let out = tick("test_loop_async", async move {
            tokio::task::yield_now().await;
            if n == 1 {
                panic!("tick {n} broke");
            }
            n
        })
        .await;
        if let Some(n) = out {
            ran.push(n);
        }
    }
    assert_eq!(ran, [0, 2]);
}

#[test]
fn a_fault_is_mentioned_once_then_not_again_for_a_while() {
    let now = 1_800_000_000_000;
    let payload: Box<dyn Any + Send> = Box::new("boom");
    fault("schedule_test_once", payload.as_ref(), now);
    fault("schedule_test_once", payload.as_ref(), now + 60_000);
    assert_eq!(said("A background check hit a fault").len(), 1);
    fault("schedule_test_once", payload.as_ref(), now + SAY_AGAIN_MS);
    assert_eq!(said("A background check hit a fault").len(), 1);
}

#[test]
fn panic_text_reads_both_kinds_of_message() {
    let a: Box<dyn Any + Send> = Box::new("plain");
    let b: Box<dyn Any + Send> = Box::new(String::from("formatted 7"));
    let c: Box<dyn Any + Send> = Box::new(7_u8);
    assert_eq!(panic_text(a.as_ref()), "plain");
    assert_eq!(panic_text(b.as_ref()), "formatted 7");
    assert_eq!(panic_text(c.as_ref()), "a panic with no message");
}

/* ------------------------------------------------------ saved files */

#[test]
fn a_truncated_file_is_set_aside_once_and_said() {
    with_root(|root| {
        let path = root.join("thing.json");
        std::fs::write(&path, br#"{"a": [1, 2"#).unwrap();
        let read: Option<serde_json::Value> = read_kept(&path, "The test thing");
        assert!(read.is_none());
        assert!(!path.exists());
        let aside = kept(root, "thing.json.corrupt-");
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(&aside[0]).unwrap(), br#"{"a": [1, 2"#);
        assert_eq!(said("The test thing couldn't be read").len(), 1);
        // Gone now, so the next read is just "nothing saved": no second copy.
        let again: Option<serde_json::Value> = read_kept(&path, "The test thing");
        assert!(again.is_none());
        assert_eq!(kept(root, "thing.json.corrupt-").len(), 1);
        assert!(said("The test thing").is_empty());
    });
}

#[test]
fn a_good_or_missing_file_is_left_alone() {
    with_root(|root| {
        let path = root.join("fine.json");
        let missing: Option<serde_json::Value> = read_kept(&path, "Fine");
        assert!(missing.is_none());
        std::fs::write(&path, br#"{"a": 1}"#).unwrap();
        let read: Option<serde_json::Value> = read_kept(&path, "Fine");
        assert_eq!(read.unwrap()["a"], 1);
        assert!(kept(root, "fine.json.corrupt-").is_empty());
        assert!(said("Fine couldn't").is_empty());
    });
}

#[test]
fn a_damaged_wallet_isnt_overwritten_by_the_next_change() {
    with_root(|root| {
        std::fs::write(root.join("wallet.json"), b"{\"accounts\": [{\"id\": \"wo").unwrap();
        assert!(crate::agents::wallet::list()
            .iter()
            .all(|a| a.name != "Work"));
        crate::agents::wallet::add(Engine::Claude, "Personal").unwrap();
        let aside = kept(root, "wallet.json.corrupt-");
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(&aside[0]).unwrap(),
            b"{\"accounts\": [{\"id\": \"wo"
        );
        assert_eq!(said("Your accounts list couldn't be read").len(), 1);
    });
}

#[test]
fn damaged_slack_quiet_hours_and_quota_files_load_as_empty_and_are_kept() {
    with_root(|root| {
        for f in ["slack.json", "quiet-hours.json", "quota.json"] {
            std::fs::write(root.join(f), b"\x00\x01 not json").unwrap();
        }
        assert!(!crate::agents::slack::load().enabled);
        assert!(crate::agents::quiet::get().is_none());
        assert!(crate::agents::quota::load().is_empty());
        for f in ["slack.json", "quiet-hours.json", "quota.json"] {
            assert_eq!(kept(root, &format!("{f}.corrupt-")).len(), 1, "{f}");
        }
        // Each named once (other tests' lines may be queued beside them).
        for what in [
            "Your Slack set-up",
            "Your quiet hours",
            "The saved plan-usage readings",
        ] {
            assert_eq!(said(&format!("{what} couldn't be read")).len(), 1, "{what}");
        }
    });
}

#[test]
fn an_empty_file_counts_as_damaged_too() {
    with_root(|root| {
        std::fs::write(root.join("connections.json"), b"").unwrap();
        assert!(crate::agents::connections::list().unwrap().is_empty());
        assert_eq!(kept(root, "connections.json.corrupt-").len(), 1);
        assert_eq!(said("connected apps").len(), 1);
    });
}

#[test]
fn a_panic_while_changing_settings_doesnt_lock_them_for_good() {
    with_root(|_| {
        let caught = std::panic::catch_unwind(|| {
            let _ = crate::agents::slack::change(|_| -> () { panic!("mid-change") });
        });
        assert!(caught.is_err());
        // The lock was poisoned; reading and changing still work.
        let _ = crate::agents::slack::load();
        crate::agents::slack::change(|s| s.enabled = true).unwrap();
        assert!(crate::agents::slack::load().enabled);
    });
}

/* ------------------------------------------------------------- logs */

#[test]
fn a_log_torn_inside_a_character_still_opens() {
    with_root(|_| {
        let a = store::create(NewAgent {
            name: "Finance".into(),
            role: "Does things".into(),
            instructions: "Be brief.".into(),
            shape: None,
            avatar: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let note = |t: &str| crate::agents::runner::new_message(&a.id, MessageKind::Note, t);
        store::append_message(&note("one 🎉")).unwrap();
        let log = store::agent_home(&a.id).unwrap().join("messages.jsonl");
        // A crash mid-append, two bytes into a four-byte emoji.
        let mut raw = std::fs::read(&log).unwrap();
        raw.extend_from_slice(b"{\"id\":\"torn\",\"text\":\"\xF0\x9F");
        std::fs::write(&log, raw).unwrap();
        store::append_message(&note("two")).unwrap();
        let all: Vec<String> = store::messages(&a.id, usize::MAX)
            .unwrap()
            .into_iter()
            .map(|m| m.text)
            .collect();
        assert!(
            all.ends_with(&["one 🎉".to_string(), "two".to_string()]),
            "{all:?}"
        );
        let page: Vec<String> = store::messages(&a.id, 10)
            .unwrap()
            .into_iter()
            .map(|m| m.text)
            .collect();
        assert!(
            page.ends_with(&["one 🎉".to_string(), "two".to_string()]),
            "{page:?}"
        );
    });
}
