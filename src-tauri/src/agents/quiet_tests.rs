//! Quiet hours (child of quiet.rs): the window, who it holds, what fires
//! anyway, and the one notification at the end. Fictional team.

use super::*;
use chrono::{FixedOffset, NaiveDate};

fn utc() -> FixedOffset {
    FixedOffset::east_opt(0).unwrap()
}

fn at(h: u32, m: u32) -> i64 {
    NaiveDate::from_ymd_opt(2026, 11, 8)
        .unwrap()
        .and_hms_opt(h, m, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis()
}

fn night() -> Window {
    parse("22:00", "7am").unwrap()
}

#[test]
fn a_window_past_midnight_holds_the_small_hours_and_ends_at_its_end() {
    let w = night();
    assert_eq!(w.label(), "22:00–07:00");
    // The observed post: a sweep at 06:33.
    assert!(w.contains(&utc(), at(6, 33)));
    assert!(w.contains(&utc(), at(23, 10)));
    assert!(!w.contains(&utc(), at(7, 0)));
    assert!(!w.contains(&utc(), at(12, 0)));
    assert_eq!(w.ends_after(&utc(), at(6, 33)), Some(at(7, 0)));
    assert_eq!(w.ends_after(&utc(), at(12, 0)), None);
    let day = parse("13:00", "14:30").unwrap();
    assert!(day.contains(&utc(), at(13, 59)) && !day.contains(&utc(), at(14, 30)));
    assert!(parse("7am", "07:00").is_err());
    assert!(parse("late", "7").is_err());
}

#[test]
fn the_user_writing_means_they_are_up() {
    let w = night();
    let now = at(6, 33);
    assert!(holds(Some(&w), &utc(), now, 0));
    assert!(
        !holds(Some(&w), &utc(), now, now - 10 * 60_000),
        "wrote ten minutes ago"
    );
    assert!(holds(Some(&w), &utc(), now, now - AWAKE_MS));
    assert!(!holds(None, &utc(), now, 0));
    assert!(!holds(Some(&w), &utc(), at(9, 0), 0));
}

fn check_in(repeat: Option<Repeat>) -> CheckIn {
    serde_json::from_value(serde_json::json!({
        "id": "c1", "note": "Sweep the team", "nextAt": 0, "createdAt": 0
    }))
    .map(|mut c: CheckIn| {
        c.repeat = repeat;
        c
    })
    .unwrap()
}

#[test]
fn only_a_routine_set_for_a_time_inside_the_window_fires_in_it() {
    let w = night();
    let six = Repeat::Days {
        days: (0..7).collect(),
        hour: 6,
        minute: 0,
    };
    let nine = Repeat::Days {
        days: (0..7).collect(),
        hour: 9,
        minute: 0,
    };
    assert!(fires_anyway(&check_in(Some(six)), &w));
    assert!(!fires_anyway(&check_in(Some(nine)), &w));
    assert!(
        !fires_anyway(&check_in(Some(Repeat::Every { minutes: 60 })), &w),
        "a sweep waits"
    );
    assert!(
        !fires_anyway(&check_in(None), &w),
        "a one-time check-in waits"
    );
}

#[test]
fn what_was_held_ends_as_one_notification() {
    let h = |id: &str, title: &str| Held {
        agent_id: id.into(),
        title: title.into(),
        body: format!("{title} says hi"),
    };
    assert_eq!(summary(&[]), None);
    assert_eq!(summary(&[h("f", "Finance")]), Some(h("f", "Finance")));
    let two = summary(&[h("f", "Finance"), h("i", "Inbox")]).unwrap();
    assert_eq!(two.body, "Inbox and Finance posted");
    assert_eq!(two.agent_id, "i", "it opens the latest");
    let four = summary(&[h("a", "A"), h("b", "B"), h("c", "C"), h("d", "D")]).unwrap();
    assert_eq!(four.body, "D, C and 2 more posted");
}

#[test]
fn the_tool_sets_and_turns_off_and_never_for_outside_text() {
    let _serial = crate::agents::store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    crate::agents::store::set_root_for_tests(Some(root.path().to_path_buf()));
    std::fs::create_dir_all(crate::agents::store::agents_root().unwrap()).unwrap();
    let args = serde_json::json!({ "from": "10pm", "to": "7am" });
    assert!(call(&args, true, 1).is_err());
    assert_eq!(get(), None);
    let said = call(&args, false, 1).unwrap();
    assert!(said.contains("22:00–07:00"), "{said}");
    assert_eq!(get(), Some(night()));
    call(&serde_json::json!({ "off": true }), false, 2).unwrap();
    assert_eq!(get(), None);
    assert!(call(&serde_json::json!({ "from": "x" }), false, 3).is_err());
    crate::agents::store::set_root_for_tests(None);
}

#[test]
fn memory_with_quiet_hours_the_app_lacks_gets_a_hint() {
    let memory = "## Memory\n\n- Quiet hours 22:00-07:00: no posts.";
    assert!(memory_hint(memory, None).is_some());
    assert!(memory_hint(memory, Some(&night())).is_none());
    assert!(memory_hint("## Memory\n\n- Likes short replies.", None).is_none());
}

/// The observed case end to end in the scheduler: an hourly sweep due at
/// 06:33 waits while quiet hours hold, a 06:00 morning brief the user set
/// fires, and once they end the sweep fires once, saying why it's late.
#[test]
fn the_scheduler_holds_a_sweep_and_lets_a_chosen_time_through() {
    let mut sweep = check_in(Some(Repeat::Every { minutes: 60 }));
    sweep.next_at = at(6, 33);
    let mut brief = check_in(Some(Repeat::Days {
        days: (0..7).collect(),
        hour: 6,
        minute: 0,
    }));
    brief.id = "c2".into();
    brief.note = "Morning brief".into();
    brief.next_at = at(6, 0);
    let mut agent: crate::agents::store::Agent = serde_json::from_value(serde_json::json!({
        "id": "m", "name": "Chief of Staff", "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap();
    agent.check_ins = vec![sweep.clone()];
    let w = night();
    let now = at(6, 34);
    let held = |c: &CheckIn| waits(c, Some(&w), holds(Some(&w), &utc(), now, 0));
    assert!(
        schedule::plan_with(&utc(), std::slice::from_ref(&agent), now, &held)
            .fire
            .is_none()
    );
    agent.check_ins.push(brief);
    let fire = schedule::plan_with(&utc(), std::slice::from_ref(&agent), now, &held)
        .fire
        .unwrap();
    assert_eq!(fire.check_in.id, "c2", "the brief the user set for 06:00");
    // 07:05: over. The sweep runs once, late, because of quiet hours.
    agent.check_ins.retain(|c| c.id == "c1");
    let later = at(7, 5);
    let open = |c: &CheckIn| waits(c, Some(&w), holds(Some(&w), &utc(), later, 0));
    let mut fire = schedule::plan_with(&utc(), std::slice::from_ref(&agent), later, &open)
        .fire
        .unwrap();
    assert!(fire.late);
    fire.waited = w.contains(&utc(), fire.check_in.next_at);
    let p = schedule::wake_prompt(&utc(), &fire, later);
    assert!(
        p.contains("inside the user's quiet hours, so it waited"),
        "{p}"
    );
    assert!(!p.contains("wasn't running"), "{p}");
}
