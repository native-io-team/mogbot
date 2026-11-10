use super::*;
use crate::agents::forecast::Pace;

const NOW: i64 = 1_793_998_000_000;
const H: i64 = 60 * 60 * 1000;

fn w(kind: &str, used: f64, resets_in: i64) -> QuotaWindow {
    QuotaWindow {
        kind: kind.into(),
        used_percent: Some(used),
        resets_at: Some(NOW + resets_in),
        window_minutes: None,
        limited: used >= 100.0,
        observed_at: NOW - 60_000,
    }
}

fn acct(engine: Engine, id: &str, windows: Vec<QuotaWindow>) -> AccountLine {
    AccountLine {
        engine,
        id: id.into(),
        name: id.into(),
        this_mac: id == "default",
        signed_in: true,
        out: false,
        out_until: None,
        next: false,
        plan: None,
        windows,
        learned: Vec::new(),
        pace: Vec::new(),
        check: None,
        same_as: None,
        maybe_same_as: None,
        org_name: None,
        spent: Vec::new(),
        changes: Vec::new(),
    }
}

fn pace(kind: &str, reaches_in: i64, resets_in: i64, readings: u32) -> Pace {
    Pace {
        estimate: true,
        kind: kind.into(),
        resets_at: NOW + resets_in,
        reaches_at: NOW + reaches_in,
        readings,
        span_minutes: 90,
    }
}

#[test]
fn room_is_only_what_a_reading_said() {
    let calm = acct(
        Engine::Claude,
        "a",
        vec![w("five_hour", 30.0, H), w("seven_day", 60.0, 50 * H)],
    );
    assert_eq!(room(&calm), Some(40.0), "the tightest window");
    let unread = acct(Engine::Claude, "b", vec![]);
    assert_eq!(room(&unread), None, "no reading is not room");
    let mut out = calm.clone();
    out.out = true;
    assert_eq!(room(&out), Some(0.0));
    let used_up = acct(Engine::Claude, "c", vec![w("five_hour", 100.0, H)]);
    assert_eq!(room(&used_up), Some(0.0));
    let mut signed_out = calm.clone();
    signed_out.signed_in = false;
    assert_eq!(room(&signed_out), None);
    // A per-model window alone isn't a plan window: not read.
    let opus_only = acct(Engine::Claude, "d", vec![w("seven_day_opus", 10.0, 50 * H)]);
    assert_eq!(room(&opus_only), None);
}

#[test]
fn totals_count_every_account_and_name_the_soonest_reset() {
    let mut codex = acct(Engine::Codex, "plus", vec![w("primary", 92.0, 2 * H)]);
    codex.windows[0].window_minutes = Some(300);
    let accounts = vec![
        acct(
            Engine::Claude,
            "default",
            vec![w("five_hour", 38.0, 3 * H), w("seven_day", 61.0, 72 * H)],
        ),
        acct(
            Engine::Claude,
            "work",
            vec![w("five_hour", 100.0, H), w("seven_day", 40.0, 30 * H)],
        ),
        acct(Engine::Claude, "personal", vec![]),
        codex,
    ];
    let t = totals(&accounts, NOW);
    assert_eq!(t.accounts, 4);
    assert_eq!((t.read, t.room), (3, 2));
    assert_eq!(t.engines[0].engine, Engine::Claude);
    assert_eq!(
        (t.engines[0].accounts, t.engines[0].read, t.engines[0].room),
        (3, 2, 1)
    );
    assert_eq!((t.engines[1].accounts, t.engines[1].room), (1, 1));
    let session = &t.windows[0];
    assert_eq!(session.family, Family::Session);
    assert_eq!((session.room, session.read), (2, 3));
    let soonest = session.soonest_reset.as_ref().unwrap();
    assert_eq!((soonest.account_id.as_str(), soonest.at), ("work", NOW + H));
    let weekly = &t.windows[1];
    assert_eq!((weekly.room, weekly.read), (2, 2));
    // Work is the one without room; it's back when its 5-hour resets.
    let back = t.next_room.as_ref().unwrap();
    assert_eq!((back.account_id.as_str(), back.at), ("work", NOW + H));
    assert!(t.run_out.is_empty(), "no pace, no estimate");
}

#[test]
fn nothing_listed_is_nothing_said() {
    let t = totals(&[], NOW);
    assert_eq!((t.accounts, t.read, t.room), (0, 0, 0));
    assert!(t.windows.is_empty() && t.next_room.is_none() && t.run_out.is_empty());
    let json = serde_json::to_value(&t).unwrap();
    assert!(json.get("nextRoom").is_none() && json.get("runOut").is_none());
}

fn paced(id: &str, reaches_in: i64, resets_in: i64) -> AccountLine {
    let mut a = acct(Engine::Claude, id, vec![w("five_hour", 70.0, resets_in)]);
    a.pace = vec![pace("five_hour", reaches_in, resets_in, 6)];
    a
}

#[test]
fn an_engine_runs_out_everywhere_only_when_every_account_says_so() {
    // Both run out before either resets: the later one is when Claude is out.
    let both = [paced("a", H, 4 * H), paced("b", 2 * H, 3 * H)];
    let t = totals(&both, NOW);
    let r = &t.run_out[0];
    assert!(r.estimate);
    assert_eq!((r.engine, r.reaches_at), (Engine::Claude, NOW + 2 * H));
    assert_eq!((r.readings, r.accounts), (12, 2));

    // A is back (resets) before B runs out: never all out at once.
    let staggered = [paced("a", H, 90 * 60_000), paced("b", 2 * H, 3 * H)];
    assert!(totals(&staggered, NOW).run_out.is_empty());

    // B's use is flat (no pace): it has room at this pace.
    let flat = [
        paced("a", H, 4 * H),
        acct(Engine::Claude, "b", vec![w("five_hour", 10.0, 3 * H)]),
    ];
    assert!(totals(&flat, NOW).run_out.is_empty());

    // B was never read: no claim about every account.
    let unseen = [paced("a", H, 4 * H), acct(Engine::Claude, "b", vec![])];
    assert!(totals(&unseen, NOW).run_out.is_empty());

    // One account: its own pace line says it.
    assert!(totals(&[paced("a", H, 4 * H)], NOW).run_out.is_empty());
}

#[test]
fn an_account_already_out_counts_while_it_stays_out() {
    let mut out = acct(Engine::Claude, "work", vec![w("five_hour", 100.0, 5 * H)]);
    out.out = true;
    out.out_until = Some(NOW + 5 * H);
    let t = totals(&[paced("a", 2 * H, 4 * H), out.clone()], NOW);
    assert_eq!(t.run_out[0].reaches_at, NOW + 2 * H);
    assert_eq!(t.run_out[0].accounts, 1);
    // Back before the other runs out: no estimate.
    out.out_until = Some(NOW + H);
    out.windows[0].resets_at = Some(NOW + H);
    assert!(totals(&[paced("a", 2 * H, 4 * H), out], NOW)
        .run_out
        .is_empty());
}

#[test]
fn every_account_out_has_no_run_out_but_says_who_is_back_first() {
    let mut a = acct(Engine::Claude, "a", vec![w("five_hour", 100.0, 3 * H)]);
    a.out = true;
    a.out_until = Some(NOW + 3 * H);
    let b = acct(Engine::Claude, "b", vec![w("five_hour", 100.0, H)]);
    let t = totals(&[a, b], NOW);
    assert_eq!(t.room, 0);
    assert!(t.run_out.is_empty(), "already out: nothing to forecast");
    assert_eq!(t.next_room.as_ref().unwrap().account_id, "b");
}
