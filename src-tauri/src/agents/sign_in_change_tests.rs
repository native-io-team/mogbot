use super::*;

const H: i64 = 60 * 60 * 1000;
const D: i64 = 24 * H;
/// A Monday, 16:00 UTC.
const MON_4PM: i64 = 1_793_116_800_000 + 16 * H;
/// A Saturday, 10:00 UTC, after it.
const SAT_10AM: i64 = MON_4PM + 4 * D + 18 * H;
const NOW: i64 = MON_4PM + 9 * D;

fn id(org: &str, email: &str) -> Identity {
    Identity {
        email: Some(email.into()),
        plan: Some("Max".into()),
        org: Some(format!("claude-org:{org}")),
        org_name: None,
    }
}

fn weekly(at: i64, resets_at: i64) -> Sample {
    Sample {
        kind: "seven_day".into(),
        resets_at: Some(resets_at),
        used: 20.0,
        tokens: 0,
        at,
    }
}

#[test]
fn schedules_are_compared_within_the_week() {
    assert!(same_schedule(MON_4PM, MON_4PM + 7 * D));
    assert!(same_schedule(MON_4PM, MON_4PM + 7 * D + 30 * 60 * 1000));
    assert!(!same_schedule(MON_4PM, SAT_10AM));
    // Either side of the week's edge.
    assert!(same_schedule(
        WEEK_MS - 10 * 60 * 1000,
        WEEK_MS + 10 * 60 * 1000
    ));
}

#[test]
fn a_new_identity_is_kept_and_an_old_reading_is_never_credited_to_it() {
    let mut h = Vec::new();
    assert!(note(
        &mut h,
        &id("work", "work@example.com"),
        Some((MON_4PM, NOW - H)),
        NOW
    ));
    assert_eq!(h.len(), 1);
    // The reading predates the first sight of this sign-in: not its own.
    assert_eq!(h[0].weekly_reset, None);
    assert!(note(
        &mut h,
        &id("work", "work@example.com"),
        Some((MON_4PM, NOW + H)),
        NOW + H
    ));
    assert_eq!(h[0].weekly_reset, Some(MON_4PM));
    // Nothing new, within the hour: nothing written.
    assert!(!note(
        &mut h,
        &id("work", "work@example.com"),
        Some((MON_4PM, NOW + H)),
        NOW + H + 60_000
    ));

    // Switched: a second record; the stored reading of the old one isn't the new one's.
    assert!(note(
        &mut h,
        &id("me", "me@example.com"),
        Some((MON_4PM, NOW + H)),
        NOW + 2 * H
    ));
    assert_eq!(h.len(), 2);
    assert_eq!(h[1].email.as_deref(), Some("me@example.com"));
    assert_eq!(h[1].weekly_reset, None);
}

#[test]
fn nothing_recorded_about_who_records_nothing() {
    let mut h = Vec::new();
    assert!(!note(
        &mut h,
        &Identity::default(),
        Some((MON_4PM, NOW)),
        NOW
    ));
    assert!(h.is_empty());
}

#[test]
fn a_switch_is_told_once_with_what_was_recorded() {
    let mut h = Vec::new();
    note(&mut h, &id("work", "work@example.com"), None, NOW - 3 * D);
    note(
        &mut h,
        &id("work", "work@example.com"),
        Some((MON_4PM, NOW - 2 * D)),
        NOW - 2 * D,
    );
    note(&mut h, &id("me", "me@example.com"), None, NOW);
    let me = Connected {
        who: Some("claude-org:me".into()),
        weekly_reset: Some(SAT_10AM),
    };
    let n = notice(Engine::Claude, &h, &[], std::slice::from_ref(&me), &[]).expect("told");
    assert_eq!(n.now_email.as_deref(), Some("me@example.com"));
    assert_eq!(n.before_email.as_deref(), Some("work@example.com"));
    assert_eq!(n.before_weekly_reset, Some(MON_4PM));
    assert!(!n.by_reset);
    assert!(!n.key.contains("org"), "the key carries no account id");

    // Answered: not again.
    assert_eq!(
        notice(Engine::Claude, &h, &[], &[me.clone()], &[n.key.clone()]),
        None
    );
    // The previous account added back: nothing to say.
    let work = Connected {
        who: Some("claude-org:work".into()),
        weekly_reset: None,
    };
    assert_eq!(
        notice(Engine::Claude, &h, &[], &[me.clone(), work], &[]),
        None
    );
    // An added account nobody has identified, on the old account's reset, may be it.
    let unknown = Connected {
        who: None,
        weekly_reset: Some(MON_4PM + 7 * D),
    };
    assert_eq!(notice(Engine::Claude, &h, &[], &[me, unknown], &[]), None);
}

#[test]
fn before_any_history_a_weekly_reset_that_moved_says_so_without_a_name() {
    // The owner's case: This Mac reset Mondays 4 PM, then Saturdays 10 AM.
    let samples = vec![
        weekly(NOW - 8 * D, MON_4PM),
        weekly(NOW - 5 * D, MON_4PM + 7 * D),
        weekly(NOW - 2 * D, SAT_10AM + 7 * D),
        weekly(NOW - D, SAT_10AM + 7 * D),
    ];
    assert_eq!(
        moved_schedule(&samples),
        Some((MON_4PM + 7 * D, NOW - 2 * D, SAT_10AM + 7 * D))
    );
    let mut h = Vec::new();
    note(&mut h, &id("me", "me@example.com"), None, NOW);
    // "Personal Account": the same account as This Mac now, on Saturdays.
    let personal = Connected {
        who: Some("claude-org:me".into()),
        weekly_reset: Some(SAT_10AM),
    };
    let n = notice(Engine::Claude, &h, &samples, &[personal.clone()], &[]).expect("told");
    assert!(n.by_reset);
    assert_eq!(n.before_email, None, "no name was recorded, none is said");
    assert_eq!(n.before_weekly_reset, Some(MON_4PM + 7 * D));
    assert_eq!(n.now_weekly_reset, Some(SAT_10AM + 7 * D));
    assert_eq!(n.at, NOW - 2 * D);

    // The Monday account added: it's connected.
    let monday = Connected {
        who: Some("claude-org:work".into()),
        weekly_reset: Some(MON_4PM),
    };
    assert_eq!(
        notice(Engine::Claude, &h, &samples, &[personal, monday], &[]),
        None
    );
}

#[test]
fn a_reset_that_never_moved_says_nothing() {
    let samples = vec![
        weekly(NOW - 8 * D, MON_4PM),
        weekly(NOW - D, MON_4PM + 7 * D + 5 * 60 * 1000),
    ];
    assert_eq!(moved_schedule(&samples), None);
    let mut h = Vec::new();
    note(&mut h, &id("me", "me@example.com"), None, NOW);
    assert_eq!(notice(Engine::Claude, &h, &samples, &[], &[]), None);
    // Nor with no identity on record.
    assert_eq!(notice(Engine::Claude, &[], &samples, &[], &[]), None);
}
