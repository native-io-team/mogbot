//! Persona review 2026-11-09: "Save my limits" holds routines, one warning
//! per window, and a lone account out until a reset is waited for.

use super::*;
use chrono::{TimeZone, Utc};

const H: i64 = HOUR_MS;

/// Thu 5 Nov 2026, 08:00 UTC.
fn now() -> i64 {
    Utc.with_ymd_and_hms(2026, 11, 5, 8, 0, 0)
        .unwrap()
        .timestamp_millis()
}

fn w(kind: &str, used: f64, resets_in: i64) -> QuotaWindow {
    QuotaWindow {
        kind: kind.into(),
        used_percent: Some(used),
        resets_at: Some(now() + resets_in),
        window_minutes: None,
        limited: false,
        observed_at: now() - 60_000,
    }
}

fn seat(id: &str, windows: Vec<QuotaWindow>) -> Seat {
    Seat {
        id: id.into(),
        name: id.into(),
        signed_in: Some(true),
        out: None,
        windows,
    }
}

#[test]
fn save_holds_a_routine_only_while_every_account_is_nearly_out() {
    let hot = seat(
        "personal",
        vec![w("five_hour", 93.0, 2 * H), w("seven_day", 40.0, 80 * H)],
    );
    // One account, past 90% of its 5-hour limit: held until that resets.
    let h = hold(std::slice::from_ref(&hot), None, true, now()).unwrap();
    assert_eq!(h.until, now() + 2 * H);
    assert_eq!(h.account, "personal");
    assert!(
        matches!(h.why, Why::Near { ref kind, used, .. } if kind == "five_hour" && used == 93.0)
    );
    // Not in Save: a nearly-out account still runs.
    assert_eq!(hold(std::slice::from_ref(&hot), None, false, now()), None);
    // Another account with room: the turn would run there, so no hold.
    let roomy = seat("work", vec![w("five_hour", 20.0, 3 * H)]);
    assert_eq!(hold(&[hot.clone(), roomy.clone()], None, true, now()), None);
    // ...unless the agent is set to the nearly-out one.
    assert!(hold(&[hot.clone(), roomy.clone()], Some("personal"), true, now()).is_some());
    // A signed-out account isn't one it could run on.
    let mut off = roomy.clone();
    off.signed_in = Some(false);
    assert!(hold(&[hot.clone(), off], None, true, now()).is_some());
    // No reading: room as far as anyone knows, never held.
    assert_eq!(
        hold(&[hot.clone(), seat("new", vec![])], None, true, now()),
        None
    );
    // Both limits nearly out: it waits for the later reset (both must lift).
    let both = seat(
        "p",
        vec![w("five_hour", 95.0, 2 * H), w("seven_day", 91.0, 50 * H)],
    );
    assert_eq!(
        hold(&[both], None, true, now()).unwrap().until,
        now() + 50 * H
    );
    // Two nearly-out accounts: the first back decides.
    let other = seat("w", vec![w("seven_day", 99.0, 30 * H)]);
    let h = hold(&[hot, other], None, true, now()).unwrap();
    assert_eq!((h.until, h.account.as_str()), (now() + 2 * H, "personal"));
    // A per-model limit (Opus) doesn't hold anything.
    let opus = seat("o", vec![w("seven_day_opus", 99.0, 30 * H)]);
    assert_eq!(hold(&[opus], None, true, now()), None);
}

/// The Adversary: a lone account out until a known reset waits for it in
/// any mode, instead of a refused try per due routine.
#[test]
fn an_account_out_until_a_known_reset_holds_in_any_mode() {
    let mut out = seat("only", vec![]);
    out.out = Some(Some(now() + 70 * H));
    let h = hold(std::slice::from_ref(&out), None, false, now()).unwrap();
    assert_eq!((h.until, h.why.clone()), (now() + 70 * H, Why::Out));
    // Out with no reset known: tried, it may be back.
    out.out = Some(None);
    assert_eq!(hold(std::slice::from_ref(&out), None, false, now()), None);
    // A reset already past: not out.
    out.out = Some(Some(now() - 1));
    assert_eq!(hold(std::slice::from_ref(&out), None, true, now()), None);
}

#[test]
fn a_hold_is_said_once_in_plain_words() {
    let near = Hold {
        until: now() + 2 * H,
        account: "Personal".into(),
        why: Why::Near {
            kind: "five_hour".into(),
            window_minutes: None,
            used: 93.0,
        },
    };
    let line = held_line(
        Engine::Claude,
        "Check the inbox\nand file it",
        &near,
        &Utc,
        now(),
    );
    assert_eq!(
        line,
        "Holding “Check the inbox…” until 10:00 AM, when Personal’s 5-hour limit resets: it has 7% left, and Save my limits keeps routines for after the reset. Run now still runs it."
    );
    assert_eq!(
        held_detail(&near, &Utc, now()),
        "Waiting for the 5-hour limit to reset at 10:00 AM: 7% left, Save my limits."
    );
    let out = Hold {
        until: now() + 26 * H,
        account: "Personal".into(),
        why: Why::Out,
    };
    let line = held_line(Engine::Claude, "Inbox", &out, &Utc, now());
    assert!(
        line.starts_with("Holding “Inbox” until Claude Code is back tomorrow at 10:00 AM"),
        "{line}"
    );
    assert!(line.contains("would only be refused"));
    assert_eq!(held_key("a", "c1", 5), "a:c1:5");
}

#[test]
fn the_warning_comes_at_ninety_percent_or_from_a_pace_that_runs_out_early() {
    let s = seat(
        "p",
        vec![w("five_hour", 91.0, 2 * H), w("seven_day", 30.0, 80 * H)],
    );
    let got = warning(&s, &[], now()).unwrap();
    assert_eq!(got.kind, "five_hour");
    assert_eq!(got.warn, Warn::Near { used: 91.0 });
    // Out already: nothing (the chat says it).
    let mut out = s.clone();
    out.out = Some(Some(now() + H));
    assert_eq!(warning(&out, &[], now()), None);
    // Plenty left, no pace: nothing.
    let calm = seat("p", vec![w("five_hour", 40.0, 2 * H)]);
    assert_eq!(warning(&calm, &[], now()), None);
    // A pace that crosses 100% well before the reset: an estimate, warned.
    let reset = now() + 4 * H;
    let samples: Vec<Sample> = (0..4)
        .map(|i| Sample {
            kind: "five_hour".into(),
            resets_at: Some(reset),
            used: 40.0 + 10.0 * i as f64,
            tokens: 0,
            at: now() - (3 - i) * 20 * 60_000,
        })
        .collect();
    let mut rising = seat("p", vec![w("five_hour", 70.0, 4 * H)]);
    rising.windows[0].observed_at = now();
    let got = warning(&rising, &samples, now()).unwrap();
    let Warn::Pace { reaches_at, .. } = got.warn else {
        panic!("{got:?}");
    };
    assert!(reaches_at + PACE_EARLY_MS <= reset);
}

#[test]
fn a_window_is_warned_about_once_even_if_its_reset_drifts() {
    let a = warn_key(Engine::Claude, "default", "five_hour", 1_000_000_000);
    assert_eq!(a, "claude:default:five_hour:1000000000");
    let drifted = warn_key(
        Engine::Claude,
        "default",
        "five_hour",
        1_000_000_000 + 60_000,
    );
    assert!(same_instance(&a, &drifted));
    let next = warn_key(
        Engine::Claude,
        "default",
        "five_hour",
        1_000_000_000 + 5 * H,
    );
    assert!(!same_instance(&a, &next));
    let weekly = warn_key(Engine::Claude, "default", "seven_day", 1_000_000_000);
    assert!(!same_instance(&a, &weekly));
}

#[test]
fn the_warning_says_what_is_left_when_it_resets_and_what_save_does() {
    let near = Warning {
        kind: "five_hour".into(),
        window_minutes: None,
        resets_at: now() + 2 * H,
        warn: Warn::Near { used: 92.0 },
    };
    assert_eq!(
        warn_text(Engine::Claude, "Personal", &near, Mode::Normal, &Utc, now()),
        "Claude Code “Personal” has 8% of its 5-hour limit left; it resets at 10:00 AM. Switch to Save my limits in Usage to hold routines until then."
    );
    assert!(
        warn_text(Engine::Claude, "Personal", &near, Mode::Save, &Utc, now())
            .ends_with("Save my limits holds routines until it has room.")
    );
    let pace = Warning {
        kind: "seven_day".into(),
        window_minutes: None,
        resets_at: now() + 50 * H,
        warn: Warn::Pace {
            reaches_at: now() + 26 * H,
            readings: 6,
        },
    };
    let said = warn_text(Engine::Codex, "Work", &pace, Mode::Normal, &Utc, now());
    assert!(said.starts_with("At the recent pace, Codex “Work” runs out of its weekly limit tomorrow around 10:00 AM, before it resets Sat at 10:00 AM (an estimate from 6 readings)."), "{said}");
}
