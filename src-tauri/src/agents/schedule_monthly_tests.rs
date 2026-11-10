//! Monthly routines (`Repeat::Monthly`): the words that make one, when each
//! next runs across month lengths, leap years and DST, and what it's called.
//!
//! The clock is the schedule tests' own: US Eastern for 2026 by hand, "now"
//! Tue 3 Nov 2026 15:00 (two days after the clocks went back).

use super::tests::{at, now, show, Eastern};
use super::*;
use chrono::FixedOffset;

fn monthly(when: &str) -> (Repeat, i64) {
    match parse(when, &Eastern, now()) {
        Ok((Some(r @ Repeat::Monthly { .. }), next)) => (r, next),
        other => panic!("{when:?} should be monthly: {other:?}"),
    }
}

/// The first run and the ones after it, each from the last (no backfill).
fn runs(when: &str, from: i64, n: usize) -> Vec<String> {
    let (repeat, first) = match parse(when, &Eastern, from) {
        Ok((Some(r), next)) => (r, next),
        other => panic!("{when:?}: {other:?}"),
    };
    let mut out = vec![show(first)];
    let mut due = first;
    for _ in 1..n {
        due = advance(&Eastern, &repeat, due, due).unwrap();
        out.push(show(due));
    }
    out
}

fn refused(when: &str) -> String {
    match parse(when, &Eastern, now()) {
        Err(why) => plain_reason(&why),
        Ok(r) => panic!("{when:?} should be refused, read as {r:?}"),
    }
}

#[test]
fn on_a_date_every_month() {
    assert_eq!(
        runs("every month on the 1st at 09:00", now(), 3),
        [
            "Tue 2026-12-01 09:00 -05:00",
            "Fri 2027-01-01 09:00 -05:00",
            "Mon 2027-02-01 09:00 -05:00"
        ]
    );
    // Later this month when its day is still to come.
    assert_eq!(
        runs("every month on the 20th at 9am", now(), 1),
        ["Fri 2026-11-20 09:00 -05:00"]
    );
}

/// The decision: a date a month doesn't have runs on its last day (never
/// skipped, never spilling into the next month), and the month after is
/// back on the date asked for.
#[test]
fn the_31st_runs_on_the_last_day_of_a_shorter_month() {
    assert_eq!(
        runs("every month on the 31st at 09:00", now(), 6),
        [
            "Mon 2026-11-30 09:00 -05:00",
            "Thu 2026-12-31 09:00 -05:00",
            "Sun 2027-01-31 09:00 -05:00",
            "Sun 2027-02-28 09:00 -05:00",
            "Wed 2027-03-31 09:00 -05:00",
            "Fri 2027-04-30 09:00 -05:00"
        ]
    );
    assert_eq!(
        runs(
            "every month on the 30th at 09:00",
            at(2027, 1, 31, 12, 0),
            2
        ),
        ["Sun 2027-02-28 09:00 -05:00", "Tue 2027-03-30 09:00 -05:00"]
    );
}

#[test]
fn the_29th_of_february_only_in_a_leap_year() {
    let utc = FixedOffset::east_opt(0).unwrap();
    let on = MonthDay::Date { day: 29 };
    let ms = |y, m, d| resolve(&utc, NaiveDate::from_ymd_opt(y, m, d).unwrap(), 0, 0).unwrap();
    let day = |t: i64| {
        utc.timestamp_millis_opt(t)
            .unwrap()
            .format("%Y-%m-%d %H:%M")
            .to_string()
    };
    let next = |after| next_monthly(&utc, 1, &on, 9, 0, None, after).unwrap();
    assert_eq!(day(next(ms(2027, 2, 1))), "2027-02-28 09:00");
    assert_eq!(day(next(ms(2028, 2, 1))), "2028-02-29 09:00");
    assert_eq!(day(next(next(ms(2028, 2, 1)))), "2028-03-29 09:00");
    // 2100 isn't a leap year.
    assert_eq!(day(next(ms(2100, 2, 1))), "2100-02-28 09:00");
    // And a yearly one on 29 Feb keeps to February.
    let yearly = next_monthly(&utc, 12, &on, 9, 0, Some(2028 * 12 + 1), ms(2028, 3, 1)).unwrap();
    assert_eq!(day(yearly), "2029-02-28 09:00");
}

#[test]
fn on_the_last_day() {
    assert_eq!(
        runs("on the last day of every month at 17:00", now(), 4),
        [
            "Mon 2026-11-30 17:00 -05:00",
            "Thu 2026-12-31 17:00 -05:00",
            "Sun 2027-01-31 17:00 -05:00",
            "Sun 2027-02-28 17:00 -05:00"
        ]
    );
    assert_eq!(
        monthly("at the end of the month at 17:00").0,
        monthly("every month on the last day at 17:00").0
    );
}

#[test]
fn on_the_nth_or_last_weekday() {
    assert_eq!(
        runs("every last friday of the month at 16:00", now(), 4),
        [
            "Fri 2026-11-27 16:00 -05:00",
            "Fri 2026-12-25 16:00 -05:00",
            "Fri 2027-01-29 16:00 -05:00",
            "Fri 2027-02-26 16:00 -05:00"
        ]
    );
    // The first Monday of November went yesterday.
    assert_eq!(
        runs("every month on the first monday at 9:00", now(), 3),
        [
            "Mon 2026-12-07 09:00 -05:00",
            "Mon 2027-01-04 09:00 -05:00",
            "Mon 2027-02-01 09:00 -05:00"
        ]
    );
    assert_eq!(
        runs("every month on the 2nd tuesday at 9am", now(), 1),
        ["Tue 2026-11-10 09:00 -05:00"]
    );
    // The fourth exists in every month; February 2027 starts on a Monday.
    assert_eq!(
        runs(
            "every month on the fourth sunday at 10:00",
            at(2027, 2, 1, 0, 0),
            1
        ),
        ["Sun 2027-02-28 10:00 -05:00"]
    );
}

#[test]
fn every_few_months_keeps_to_the_same_months() {
    // From the next one: November's 15th is still to come.
    assert_eq!(
        runs("every 3 months on the 15th at 09:00", now(), 3),
        [
            "Sun 2026-11-15 09:00 -05:00",
            "Mon 2027-02-15 09:00 -05:00",
            "Sat 2027-05-15 09:00 -05:00"
        ]
    );
    // Quarterly is the calendar's quarters.
    assert_eq!(
        runs("quarterly on the 1st at 09:00", now(), 3),
        [
            "Fri 2027-01-01 09:00 -05:00",
            "Thu 2027-04-01 09:00 -05:00",
            "Thu 2027-07-01 09:00 -05:00"
        ]
    );
    assert_eq!(
        monthly("every quarter on the 1st at 9:00").0,
        monthly("quarterly on the 1st at 09:00").0
    );
    // "starting": its first run is in that month, even with one in step sooner.
    assert_eq!(
        runs(
            "every 2 months on the 20th at 9:00 starting january",
            now(),
            2
        ),
        ["Wed 2027-01-20 09:00 -05:00", "Sat 2027-03-20 09:00 -05:00"]
    );
    assert_eq!(
        runs(
            "every 3 months on the 15th starting in january at 09:00",
            now(),
            2
        ),
        ["Fri 2027-01-15 09:00 -05:00", "Thu 2027-04-15 09:00 -05:00"]
    );
    // This month, when it's this month.
    assert_eq!(
        runs(
            "every 3 months on the 15th at 09:00 starting november",
            now(),
            1
        ),
        ["Sun 2026-11-15 09:00 -05:00"]
    );
    assert_eq!(
        runs("every other month on the 1st at 9:00", now(), 2),
        ["Tue 2026-12-01 09:00 -05:00", "Mon 2027-02-01 09:00 -05:00"]
    );
    assert_eq!(
        runs(
            "every 12 months on the 3rd at 9:00 starting march",
            now(),
            2
        ),
        ["Wed 2027-03-03 09:00 -05:00", "Fri 2028-03-03 09:00 -05:00"]
    );
    // Named months, as `describe` writes them.
    assert_eq!(
        runs(
            "every 3 months on the 15th at 09:00 (feb, may, aug and nov)",
            now(),
            1
        ),
        ["Sun 2026-11-15 09:00 -05:00"]
    );
    assert_eq!(
        runs(
            "quarterly on the 1st of jan, apr, jul and oct at 9:00",
            now(),
            1
        ),
        ["Fri 2027-01-01 09:00 -05:00"]
    );
}

#[test]
fn many_ways_to_say_the_same_one() {
    let want = Repeat::Monthly {
        months: 1,
        on: MonthDay::Date { day: 1 },
        hour: 9,
        minute: 0,
        from: None,
    };
    for when in [
        "every month on the 1st at 09:00",
        "on the 1st of every month at 09:00",
        "monthly on day 1 at 09:00",
        "monthly on the first at 9am",
        "every month at 9:00 on the 1st",
        "the 1st of each month at 9:00",
        "every month on the first day at 09:00",
        "once a month on the 1st at 9:00",
        "Every Month On The 1st At 9:00.",
        "every month on the 1st 9am",
    ] {
        assert_eq!(monthly(when).0, want, "{when}");
    }
    assert_eq!(
        monthly("every first monday of the month at 9:00").0,
        monthly("on the first monday of every month at 09:00").0
    );
}

#[test]
fn what_cant_be_a_monthly_routine_says_why() {
    for (when, says) in [
        ("every month at 9:00", "Say which day of the month"),
        ("every month on the 5th friday at 9:00", "fifth Friday"),
        ("every month on the friday at 9:00", "Say which Friday"),
        ("every month on the 32nd at 9:00", "at most 31 days"),
        ("every month on the 1st", "time of day"),
        (
            "every 13 months on the 1st at 9:00",
            "every 12 months at most",
        ),
        ("every month on the last weekday at 9:00", "working day"),
        ("every month on the 1st and 15th at 9:00", "two routines"),
        ("every month on the 1st at 9:00 please", "\"please\""),
        (
            "every 3 months on the 1st at 9:00 (jan, mar)",
            "aren't 3 months apart",
        ),
        ("every year on march 3 at 9:00", "every 12 months"),
        ("annually on the 3rd at 9:00", "every 12 months"),
    ] {
        let why = refused(when);
        assert!(why.contains(says), "{when}: {why}");
    }
    // A one-off a few months off is still not a routine (nor readable yet).
    assert!(parse("in 3 months", &Eastern, now()).is_err());
}

#[test]
fn dst_keeps_the_wall_clock() {
    // 02:30 doesn't exist on 8 Mar 2026: it runs at 03:30, then back to 02:30.
    assert_eq!(
        runs("every month on the 8th at 02:30", at(2026, 2, 10, 12, 0), 3),
        [
            "Sun 2026-03-08 03:30 -04:00",
            "Wed 2026-04-08 02:30 -04:00",
            "Fri 2026-05-08 02:30 -04:00"
        ]
    );
    // 01:30 happens twice on 1 Nov 2026: the first.
    assert_eq!(
        runs("every month on the 1st at 01:30", at(2026, 10, 5, 12, 0), 2),
        ["Sun 2026-11-01 01:30 -04:00", "Tue 2026-12-01 01:30 -05:00"]
    );
    // 09:00 either side of the change.
    assert_eq!(
        runs(
            "every month on the 15th at 09:00",
            at(2026, 10, 1, 12, 0),
            2
        ),
        ["Thu 2026-10-15 09:00 -04:00", "Sun 2026-11-15 09:00 -05:00"]
    );
    assert_eq!(
        runs(
            "every month on the last sunday at 9:00",
            at(2026, 2, 1, 0, 0),
            2
        ),
        ["Sun 2026-02-22 09:00 -05:00", "Sun 2026-03-29 09:00 -04:00"]
    );
}

/// A week, or months, away is one late run when the app reopens, never one
/// per month it missed.
#[test]
fn a_missed_monthly_runs_once_and_doesnt_backfill() {
    let check_in: CheckIn = serde_json::from_value(serde_json::json!({
        "id": "m1", "note": "Budget summary", "createdAt": 0,
        "nextAt": at(2026, 9, 1, 9, 0),
        "repeat": { "kind": "monthly", "on": { "day": 1 }, "hour": 9, "minute": 0 }
    }))
    .unwrap();
    match due(&Eastern, &check_in, now()) {
        Some(Due::Fire {
            late: true,
            next: Some(next),
        }) => assert_eq!(show(next), "Tue 2026-12-01 09:00 -05:00"),
        other => panic!("{other:?}"),
    }
    // On time, it's not late, and the next is next month's.
    match due(&Eastern, &check_in, at(2026, 9, 1, 9, 0)) {
        Some(Due::Fire {
            late: false,
            next: Some(next),
        }) => assert_eq!(show(next), "Thu 2026-10-01 09:00 -04:00"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn stored_as_the_phone_reads_it() {
    let (repeat, _) = monthly("every 3 months on the 15th at 09:00 starting january");
    assert_eq!(
        serde_json::to_value(&repeat).unwrap(),
        serde_json::json!({
            "kind": "monthly", "months": 3, "on": { "day": 15 },
            "hour": 9, "minute": 0, "from": 2027 * 12
        })
    );
    let (repeat, _) = monthly("every month on the last friday at 16:00");
    let json = serde_json::to_value(&repeat).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "kind": "monthly", "months": 1, "on": { "nth": -1, "weekday": 5 },
            "hour": 16, "minute": 0
        })
    );
    // `months` may be left out, and reads as every month.
    let read: Repeat = serde_json::from_value(serde_json::json!({
        "kind": "monthly", "on": { "nth": -1, "weekday": 5 }, "hour": 16, "minute": 0
    }))
    .unwrap();
    assert_eq!(read, repeat);
}

/// Values no writer here makes (a hand-edited file, a newer build) never
/// panic or stall a tick.
#[test]
fn odd_values_on_disk_never_panic() {
    for (months, on) in [
        (0, MonthDay::Date { day: 0 }),
        (1, MonthDay::Date { day: 99 }),
        (200, MonthDay::Date { day: -7 }),
        (1, MonthDay::Weekday { nth: 0, weekday: 9 }),
        (
            5,
            MonthDay::Weekday {
                nth: 7,
                weekday: 255,
            },
        ),
    ] {
        let repeat = Repeat::Monthly {
            months,
            on,
            hour: 9,
            minute: 0,
            from: Some(-40),
        };
        let next = advance(&Eastern, &repeat, now(), now()).unwrap();
        assert!(next > now(), "{repeat:?}");
        let _ = describe(&repeat);
    }
}

#[test]
fn what_its_called() {
    // A Mac set to a 24-hour clock (`clock`); 12-hour reads back the same way.
    crate::agents::clock::test_hour24(true);
    let m = |months, on, from| Repeat::Monthly {
        months,
        on,
        hour: 9,
        minute: 0,
        from,
    };
    let cases = [
        (
            m(1, MonthDay::Date { day: 1 }, None),
            "every month on the 1st at 09:00",
        ),
        (
            m(1, MonthDay::Date { day: -1 }, None),
            "every month on the last day at 09:00",
        ),
        (
            m(
                1,
                MonthDay::Weekday {
                    nth: -1,
                    weekday: 5,
                },
                None,
            ),
            "every month on the last Friday at 09:00",
        ),
        (
            m(1, MonthDay::Weekday { nth: 2, weekday: 2 }, None),
            "every month on the second Tuesday at 09:00",
        ),
        (
            m(3, MonthDay::Date { day: 15 }, Some(2027 * 12)),
            "every 3 months on the 15th at 09:00 (Jan, Apr, Jul and Oct)",
        ),
        (
            m(3, MonthDay::Date { day: 15 }, Some(2026 * 12 + 10)),
            "every 3 months on the 15th at 09:00 (Feb, May, Aug and Nov)",
        ),
        (
            m(12, MonthDay::Date { day: 3 }, Some(2027 * 12 + 2)),
            "every 12 months on the 3rd at 09:00 (Mar)",
        ),
        (
            m(5, MonthDay::Date { day: 22 }, Some(2026 * 12 + 10)),
            "every 5 months on the 22nd at 09:00, from Nov 2026",
        ),
    ];
    for (repeat, words) in &cases {
        assert_eq!(describe(repeat), *words);
        // And what it's called reads back as the same routine.
        let (again, _) = monthly(&describe(repeat));
        assert_eq!(describe(&again), *words, "{words}");
    }
    for (n, s) in [
        (1, "1st"),
        (2, "2nd"),
        (3, "3rd"),
        (4, "4th"),
        (11, "11th"),
        (12, "12th"),
        (13, "13th"),
        (21, "21st"),
        (22, "22nd"),
        (23, "23rd"),
        (31, "31st"),
    ] {
        assert_eq!(ordinal_text(n), s);
    }
}

#[test]
fn the_tool_says_the_first_run_and_the_months() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let agent = store::create(store::NewAgent {
        name: "Finance".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let made = create_in(
        &Eastern,
        &agent.id,
        "quarterly on the 1st at 9:00",
        "Budget summary",
        now(),
    )
    .unwrap();
    assert!(
        made.summary
            .contains("Routine set: every 3 months on the 1st at 9:00 AM (Jan, Apr, Jul and Oct)")
            && made.summary.contains("First run Fri 1 Jan 2027, 9:00 AM"),
        "{}",
        made.summary
    );
    // The same one twice is a duplicate, however it's worded.
    assert!(matches!(
        create_in(
            &Eastern,
            &agent.id,
            "every 3 months on the 1st at 09:00 starting january",
            "Budget summary",
            now(),
        ),
        Err(Refused::Duplicate)
    ));
    store::set_root_for_tests(None);
}
