//! The policy against an in-memory Keychain with fault injection. A new
//! [`Vault`] over the same store is a new launch.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    /// Made by `security add-generic-password` (or an older build).
    Cli,
    /// Made through the framework by this app.
    Framework,
}

#[derive(Debug, Clone)]
struct Item {
    value: Vec<u8>,
    comment: Option<String>,
    kind: Kind,
}

/// What the fake should do wrong.
#[derive(Default)]
struct Faults {
    /// Fail every framework_put after this many succeed (a crash or refusal
    /// between steps).
    put_ok_budget: Option<usize>,
    /// framework_get of a v2 name returns these bytes instead.
    corrupt_v2_read: Option<Vec<u8>>,
    /// Every call errors: a locked keychain / a refused prompt.
    all_fail: bool,
    cli_get_fails: bool,
    framework_get_fails: bool,
}

#[derive(Default)]
struct Fake {
    items: Mutex<HashMap<ItemKey, Item>>,
    faults: Mutex<Faults>,
    puts: AtomicUsize,
    /// Every `security -w` call, by service.
    cli_gets: Mutex<Vec<String>>,
    /// framework_get calls on items the framework didn't make (would prompt).
    prompts: AtomicUsize,
}

impl Fake {
    fn legacy(&self, service: &str, account: &str, value: &str) {
        self.items.lock().unwrap().insert(
            (service.into(), account.into()),
            Item {
                value: value.as_bytes().to_vec(),
                comment: None,
                kind: Kind::Cli,
            },
        );
    }
    fn get(&self, service: &str, account: &str) -> Option<Item> {
        self.items
            .lock()
            .unwrap()
            .get(&(service.to_string(), account.to_string()))
            .cloned()
    }
    fn value(&self, service: &str, account: &str) -> Option<String> {
        self.get(service, account)
            .map(|i| String::from_utf8(i.value).unwrap())
    }
    fn comment(&self, service: &str, account: &str) -> Option<String> {
        self.get(service, account).and_then(|i| i.comment)
    }
    fn fail(&self) -> Result<(), String> {
        if self.faults.lock().unwrap().all_fail {
            Err("errSecInteractionNotAllowed".into())
        } else {
            Ok(())
        }
    }
}

impl Store for Arc<Fake> {
    fn find(&self, service: &str, account: &str) -> Result<Option<Attrs>, String> {
        self.fail()?;
        Ok(self
            .get(service, account)
            .map(|i| Attrs { comment: i.comment }))
    }
    fn framework_get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        self.fail()?;
        if self.faults.lock().unwrap().framework_get_fails {
            return Err("errSecUserCanceled".into());
        }
        let item = self.get(service, account);
        if item.as_ref().is_some_and(|i| i.kind == Kind::Cli) {
            self.prompts.fetch_add(1, Ordering::SeqCst);
        }
        if service.ends_with(V2_SUFFIX) {
            if let Some(bad) = self.faults.lock().unwrap().corrupt_v2_read.clone() {
                return Ok(item.map(|_| bad));
            }
        }
        Ok(item.map(|i| i.value))
    }
    fn framework_put(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
        comment: &str,
    ) -> Result<(), String> {
        self.fail()?;
        let n = self.puts.fetch_add(1, Ordering::SeqCst);
        if let Some(budget) = self.faults.lock().unwrap().put_ok_budget {
            if n >= budget {
                return Err("crashed".into());
            }
        }
        self.items.lock().unwrap().insert(
            (service.into(), account.into()),
            Item {
                value: value.to_vec(),
                comment: Some(comment.into()),
                kind: Kind::Framework,
            },
        );
        Ok(())
    }
    fn framework_delete(&self, service: &str, account: &str) -> Result<(), String> {
        self.fail()?;
        self.items
            .lock()
            .unwrap()
            .remove(&(service.to_string(), account.to_string()));
        Ok(())
    }
    fn cli_get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        self.fail()?;
        self.cli_gets.lock().unwrap().push(service.to_string());
        if self.faults.lock().unwrap().cli_get_fails {
            return Err("security exited 51".into());
        }
        let item = self.get(service, account);
        if item.as_ref().is_some_and(|i| i.kind == Kind::Framework) {
            // `security -w` on an app-owned item is exactly the prompt the
            // whole design avoids.
            self.prompts.fetch_add(1, Ordering::SeqCst);
        }
        Ok(item.map(|i| String::from_utf8_lossy(&i.value).trim().to_string()))
    }
    fn cli_put(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.fail()?;
        self.legacy(service, account, value);
        Ok(())
    }
    fn cli_delete(&self, service: &str, account: &str) -> Result<(), String> {
        self.fail()?;
        self.items
            .lock()
            .unwrap()
            .remove(&(service.to_string(), account.to_string()));
        Ok(())
    }
}

const S: &str = "mogbot-account-w1";
const K: &str = "vercel_token";

fn launch(fake: &Arc<Fake>, mode: Mode) -> Vault<Arc<Fake>> {
    Vault::new(fake.clone(), mode)
}

fn v2s() -> String {
    v2(S)
}

#[test]
fn a_legacy_item_is_copied_verified_and_kept_until_a_later_launch() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok-123");

    // Launch 1: read moves it, and the original stays.
    let one = launch(&fake, Mode::Owned);
    assert_eq!(one.read(S, K), Read::Found("tok-123".into()));
    assert_eq!(fake.value(&v2s(), K).as_deref(), Some("tok-123"));
    assert_eq!(fake.comment(&v2s(), K).as_deref(), Some(MOVED));
    assert_eq!(
        fake.value(S, K).as_deref(),
        Some("tok-123"),
        "kept this launch"
    );
    // Reading again this launch still never deletes it (and is cached).
    assert_eq!(one.read(S, K), Read::Found("tok-123".into()));
    assert!(fake.get(S, K).is_some());

    // Launch 2: the copy reads back, the values match: the original goes.
    let two = launch(&fake, Mode::Owned);
    assert_eq!(two.read(S, K), Read::Found("tok-123".into()));
    assert!(fake.get(S, K).is_none(), "removed in a later launch");
    assert_eq!(fake.value(&v2s(), K).as_deref(), Some("tok-123"));
    assert_eq!(fake.prompts.load(Ordering::SeqCst), 0);
}

#[test]
fn a_crash_after_the_copy_is_written_loses_nothing() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok-123");
    // The pending copy is written, then everything stops.
    fake.faults.lock().unwrap().put_ok_budget = Some(1);
    let one = launch(&fake, Mode::Owned);
    assert_eq!(one.read(S, K), Read::Found("tok-123".into()));
    assert_eq!(fake.comment(&v2s(), K).as_deref(), Some(PENDING));
    assert_eq!(fake.value(S, K).as_deref(), Some("tok-123"));

    // Next launch: the pending copy doesn't outrank the original; the move
    // is finished, and the original still survives this launch.
    fake.faults.lock().unwrap().put_ok_budget = None;
    let two = launch(&fake, Mode::Owned);
    assert_eq!(two.read(S, K), Read::Found("tok-123".into()));
    assert_eq!(fake.comment(&v2s(), K).as_deref(), Some(MOVED));
    assert!(
        fake.get(S, K).is_some(),
        "the launch that verified it keeps it"
    );

    let three = launch(&fake, Mode::Owned);
    assert_eq!(three.read(S, K), Read::Found("tok-123".into()));
    assert!(fake.get(S, K).is_none());
}

#[test]
fn every_failure_while_moving_leaves_the_original() {
    for budget in [0, 1] {
        let fake = Arc::new(Fake::default());
        fake.legacy(S, K, "tok-123");
        fake.faults.lock().unwrap().put_ok_budget = Some(budget);
        for _ in 0..3 {
            let l = launch(&fake, Mode::Owned);
            assert_eq!(l.read(S, K), Read::Found("tok-123".into()));
            assert_eq!(fake.value(S, K).as_deref(), Some("tok-123"));
        }
    }
}

#[test]
fn a_copy_that_reads_back_different_is_discarded_and_the_original_kept() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok-123");
    fake.faults.lock().unwrap().corrupt_v2_read = Some(b"garbage".to_vec());
    let one = launch(&fake, Mode::Owned);
    assert_eq!(one.read(S, K), Read::Found("tok-123".into()));
    assert!(fake.get(&v2s(), K).is_none(), "the bad copy is removed");
    assert_eq!(fake.value(S, K).as_deref(), Some("tok-123"));

    fake.faults.lock().unwrap().corrupt_v2_read = None;
    let two = launch(&fake, Mode::Owned);
    assert_eq!(two.read(S, K), Read::Found("tok-123".into()));
    assert!(
        fake.get(S, K).is_some(),
        "moved now, kept until the next launch"
    );
}

#[test]
fn a_legacy_item_that_differs_from_the_moved_copy_is_kept() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok-123");
    launch(&fake, Mode::Owned).read(S, K);
    // An older build (or a dev build) wrote a new value the old way since.
    fake.legacy(S, K, "tok-456");
    let two = launch(&fake, Mode::Owned);
    assert_eq!(two.read(S, K), Read::Found("tok-123".into()));
    assert_eq!(
        fake.value(S, K).as_deref(),
        Some("tok-456"),
        "values differ: kept"
    );
}

#[test]
fn a_write_goes_to_a_verified_copy_and_the_superseded_original_goes_later() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "old");
    let one = launch(&fake, Mode::Owned);
    one.write(S, K, "new").unwrap();
    assert_eq!(fake.comment(&v2s(), K).as_deref(), Some(WRITTEN));
    assert_eq!(one.read(S, K), Read::Found("new".into()));
    assert_eq!(fake.value(S, K).as_deref(), Some("old"), "kept this launch");

    let two = launch(&fake, Mode::Owned);
    assert_eq!(two.read(S, K), Read::Found("new".into()));
    assert!(
        fake.get(S, K).is_none(),
        "superseded, and the new one proved readable"
    );
}

#[test]
fn a_failed_write_reports_and_keeps_the_previous_value() {
    let fake = Arc::new(Fake::default());
    let one = launch(&fake, Mode::Owned);
    one.write(S, K, "first").unwrap();
    fake.faults.lock().unwrap().corrupt_v2_read = Some(b"x".to_vec());
    assert!(one.write(S, K, "second").is_err());
    fake.faults.lock().unwrap().corrupt_v2_read = None;
    // The pending copy of "second" was discarded; nothing claims "second".
    assert_ne!(one.read(S, K), Read::Found("second".into()));
}

#[test]
fn non_printable_legacy_values_are_left_alone() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "caf\u{e9}");
    for _ in 0..3 {
        let l = launch(&fake, Mode::Owned);
        assert_eq!(l.read(S, K), Read::Found("caf\u{e9}".into()));
    }
    assert!(fake.get(&v2s(), K).is_none(), "never moved");
    assert!(fake.get(S, K).is_some(), "never deleted");
}

#[test]
fn development_builds_never_create_move_or_delete() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok-123");
    for _ in 0..3 {
        let l = launch(&fake, Mode::Legacy);
        assert_eq!(l.read(S, K), Read::Found("tok-123".into()));
    }
    assert!(fake.get(&v2s(), K).is_none());
    assert_eq!(fake.value(S, K).as_deref(), Some("tok-123"));

    let l = launch(&fake, Mode::Legacy);
    l.write(S, "other", "v").unwrap();
    assert_eq!(fake.get(S, "other").unwrap().kind, Kind::Cli);
    assert_eq!(fake.prompts.load(Ordering::SeqCst), 0);
}

#[test]
fn development_builds_say_an_app_owned_secret_is_unreadable_not_missing() {
    let fake = Arc::new(Fake::default());
    launch(&fake, Mode::Owned).write(S, K, "tok").unwrap();
    let dev = launch(&fake, Mode::Legacy);
    assert!(matches!(dev.read(S, K), Read::Error(_)));
    assert_eq!(
        fake.prompts.load(Ordering::SeqCst),
        0,
        "and never asks for it"
    );
}

#[test]
fn reads_are_cached_for_the_launch() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok");
    let l = launch(&fake, Mode::Legacy);
    for _ in 0..5 {
        assert_eq!(l.read(S, K), Read::Found("tok".into()));
    }
    assert_eq!(fake.cli_gets.lock().unwrap().len(), 1);
}

#[test]
fn errors_are_not_absence() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok");
    fake.faults.lock().unwrap().all_fail = true;
    let l = launch(&fake, Mode::Owned);
    assert!(matches!(l.read(S, K), Read::Error(_)));
    assert!(matches!(
        launch(&fake, Mode::Legacy).read(S, K),
        Read::Error(_)
    ));

    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "tok");
    fake.faults.lock().unwrap().cli_get_fails = true;
    assert!(matches!(
        launch(&fake, Mode::Owned).read(S, K),
        Read::Error(_)
    ));

    let fake = Arc::new(Fake::default());
    launch(&fake, Mode::Owned).write(S, K, "tok").unwrap();
    fake.faults.lock().unwrap().framework_get_fails = true;
    assert!(matches!(
        launch(&fake, Mode::Owned).read(S, K),
        Read::Error(_)
    ));

    let fake = Arc::new(Fake::default());
    assert_eq!(launch(&fake, Mode::Owned).read(S, K), Read::NotFound);
    assert_eq!(launch(&fake, Mode::Legacy).read(S, K), Read::NotFound);
}

#[test]
fn an_app_owned_item_is_never_read_with_security() {
    let fake = Arc::new(Fake::default());
    let one = launch(&fake, Mode::Owned);
    one.write(S, K, "pkcs8-b64").unwrap();
    for _ in 0..2 {
        assert_eq!(
            launch(&fake, Mode::Owned).read(S, K),
            Read::Found("pkcs8-b64".into())
        );
    }
    assert!(fake.cli_gets.lock().unwrap().is_empty());
    assert_eq!(fake.prompts.load(Ordering::SeqCst), 0);
}

#[test]
fn v1_items_under_the_legacy_name_are_read_through_the_framework() {
    let fake = Arc::new(Fake::default());
    fake.items.lock().unwrap().insert(
        (S.into(), K.into()),
        Item {
            value: b"tok".to_vec(),
            comment: Some(V1_MARK.into()),
            kind: Kind::Framework,
        },
    );
    assert_eq!(
        launch(&fake, Mode::Owned).read(S, K),
        Read::Found("tok".into())
    );
    assert_eq!(
        launch(&fake, Mode::Owned).read(S, K),
        Read::Found("tok".into())
    );
    assert!(
        fake.get(S, K).is_none(),
        "moved, then cleaned in the later launch"
    );
    assert!(fake.cli_gets.lock().unwrap().is_empty());
    // A dev build can't read one without a prompt: an error, not absence.
    let fake2 = Arc::new(Fake::default());
    fake2.items.lock().unwrap().insert(
        (S.into(), K.into()),
        Item {
            value: b"tok".to_vec(),
            comment: Some(V1_MARK.into()),
            kind: Kind::Framework,
        },
    );
    assert!(matches!(
        launch(&fake2, Mode::Legacy).read(S, K),
        Read::Error(_)
    ));
    assert_eq!(fake2.prompts.load(Ordering::SeqCst), 0);
}

#[test]
fn legacy_delete_never_removes_an_app_owned_item() {
    let fake = Arc::new(Fake::default());
    let l = launch(&fake, Mode::Owned);
    // A v2-marked item under a legacy name (shouldn't exist; must survive).
    fake.items.lock().unwrap().insert(
        (S.into(), K.into()),
        Item {
            value: b"x".to_vec(),
            comment: Some(WRITTEN.into()),
            kind: Kind::Framework,
        },
    );
    assert!(l.legacy_delete(S, K).is_err());
    assert!(fake.get(S, K).is_some());
}

#[test]
fn delete_removes_both_kinds() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "old");
    let l = launch(&fake, Mode::Owned);
    l.write(S, K, "new").unwrap();
    l.delete(S, K).unwrap();
    assert!(fake.get(S, K).is_none());
    assert!(fake.get(&v2s(), K).is_none());
    assert_eq!(l.read(S, K), Read::NotFound, "and the cache forgot it");
}

#[test]
fn concurrent_reads_and_writes_never_lose_the_new_value() {
    let fake = Arc::new(Fake::default());
    fake.legacy(S, K, "old");
    let vault = Arc::new(launch(&fake, Mode::Owned));
    let mut handles = vec![];
    for i in 0..8 {
        let v = vault.clone();
        handles.push(std::thread::spawn(move || {
            if i == 3 {
                v.write(S, K, "new").unwrap();
            } else {
                let _ = v.read(S, K);
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(vault.read(S, K), Read::Found("new".into()));
    assert_eq!(fake.value(&v2s(), K).as_deref(), Some("new"));
    assert_eq!(
        launch(&fake, Mode::Owned).read(S, K),
        Read::Found("new".into())
    );
}

#[test]
fn the_suffix_cannot_collide_with_a_legacy_service() {
    // Every id that names a service is alphanumeric and `-`.
    assert!(crate::commands::accounts::validate_account_id("w1#v2").is_err());
    assert!(!uuid::Uuid::new_v4().simple().to_string().contains('#'));
}

/* ---------------------------------------------------- carried over a rename */

const NEW: &str = "newbrand-account-w1";
const OLD: &str = "oldbrand-account-w1";

#[test]
fn the_previous_name_is_the_same_service_under_the_old_slug() {
    assert_eq!(
        previous_service_for("newbrand-account-w1", "newbrand", Some("oldbrand")).as_deref(),
        Some("oldbrand-account-w1")
    );
    assert_eq!(
        previous_service_for("newbrand-slack", "newbrand", Some("oldbrand")).as_deref(),
        Some("oldbrand-slack")
    );
    // Not ours, no previous name, or a previous name that is the current one.
    assert_eq!(
        previous_service_for("shipstudio-x", "newbrand", Some("oldbrand")),
        None
    );
    assert_eq!(
        previous_service_for("newbrandx-y", "newbrand", Some("oldbrand")),
        None
    );
    assert_eq!(previous_service_for("newbrand-x", "newbrand", None), None);
    assert_eq!(
        previous_service_for("newbrand-x", "newbrand", Some("newbrand")),
        None
    );
    // The live brand: every service of ours maps to one under the old slug.
    if let Some(old) = crate::brand::previous::SLUG {
        let s = format!("{}identity", crate::brand::keychain_prefix("companion"));
        assert_eq!(
            previous_service(&s),
            Some(format!("{old}-companion-identity"))
        );
    }
}

#[test]
fn a_secret_under_the_old_name_is_copied_verified_and_the_old_kept_until_a_later_launch() {
    for mode in [Mode::Legacy, Mode::Owned] {
        let fake = Arc::new(Fake::default());
        fake.legacy(OLD, K, "tok-123");

        let one = launch(&fake, mode);
        assert_eq!(
            one.read_carrying(NEW, K, Some(OLD)),
            Read::Found("tok-123".into())
        );
        let copied = match mode {
            Mode::Legacy => fake.value(NEW, K),
            Mode::Owned => fake.value(&v2(NEW), K),
        };
        assert_eq!(copied.as_deref(), Some("tok-123"), "{mode:?}");
        assert_eq!(
            fake.value(OLD, K).as_deref(),
            Some("tok-123"),
            "kept this launch"
        );
        // Read again this launch: still kept.
        assert_eq!(
            one.read_carrying(NEW, K, Some(OLD)),
            Read::Found("tok-123".into())
        );
        assert!(fake.get(OLD, K).is_some());

        // A later launch reads the new one and the old goes.
        let two = launch(&fake, mode);
        assert_eq!(
            two.read_carrying(NEW, K, Some(OLD)),
            Read::Found("tok-123".into())
        );
        assert!(
            fake.get(OLD, K).is_none(),
            "{mode:?}: removed in a later launch"
        );
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn an_old_secret_that_cant_be_read_is_kept_and_never_reads_as_absent() {
    let fake = Arc::new(Fake::default());
    fake.legacy(OLD, K, "tok-123");
    fake.faults.lock().unwrap().cli_get_fails = true;
    let one = launch(&fake, Mode::Legacy);
    assert!(matches!(
        one.read_carrying(NEW, K, Some(OLD)),
        Read::Error(_)
    ));
    assert_eq!(fake.value(OLD, K).as_deref(), Some("tok-123"));
    assert!(fake.get(NEW, K).is_none());

    // The prompt is allowed next time: carried over then.
    fake.faults.lock().unwrap().cli_get_fails = false;
    let two = launch(&fake, Mode::Legacy);
    assert_eq!(
        two.read_carrying(NEW, K, Some(OLD)),
        Read::Found("tok-123".into())
    );
    assert_eq!(fake.value(NEW, K).as_deref(), Some("tok-123"));
}

#[test]
fn a_copy_that_fails_still_answers_with_the_old_value_and_keeps_it() {
    let fake = Arc::new(Fake::default());
    fake.legacy(OLD, K, "tok-123");
    fake.faults.lock().unwrap().put_ok_budget = Some(0);
    let one = launch(&fake, Mode::Owned);
    assert_eq!(
        one.read_carrying(NEW, K, Some(OLD)),
        Read::Found("tok-123".into())
    );
    assert_eq!(fake.value(OLD, K).as_deref(), Some("tok-123"));
    assert!(fake.get(&v2(NEW), K).is_none());
}

#[test]
fn the_new_name_wins_and_nothing_is_copied_over_it() {
    let fake = Arc::new(Fake::default());
    fake.legacy(OLD, K, "stale");
    fake.legacy(NEW, K, "fresh");
    let one = launch(&fake, Mode::Legacy);
    assert_eq!(
        one.read_carrying(NEW, K, Some(OLD)),
        Read::Found("fresh".into())
    );
    assert_eq!(fake.value(NEW, K).as_deref(), Some("fresh"));
    // Not copied this launch, so the stale old copy is cleaned at once.
    assert!(fake.get(OLD, K).is_none());
}

#[test]
fn deleting_a_secret_removes_its_old_name_too() {
    let fake = Arc::new(Fake::default());
    fake.legacy(OLD, K, "tok-123");
    let one = launch(&fake, Mode::Legacy);
    assert_eq!(
        one.read_carrying(NEW, K, Some(OLD)),
        Read::Found("tok-123".into())
    );
    one.delete_carrying(NEW, K, Some(OLD)).unwrap();
    assert!(fake.get(OLD, K).is_none());
    assert!(fake.get(NEW, K).is_none());
    let two = launch(&fake, Mode::Legacy);
    assert_eq!(two.read_carrying(NEW, K, Some(OLD)), Read::NotFound);
}

#[test]
fn nothing_under_either_name_is_not_found() {
    let fake = Arc::new(Fake::default());
    let one = launch(&fake, Mode::Owned);
    assert_eq!(one.read_carrying(NEW, K, Some(OLD)), Read::NotFound);
    assert_eq!(one.read_carrying(NEW, K, None), Read::NotFound);
}
