use super::*;
use crate::agents::schedule::CheckIn;
use crate::agents::store::Agent;

fn routine(then: Vec<Step>) -> CheckIn {
    CheckIn {
        id: "r1".into(),
        note: "Draft the weekly report from this week's notes".into(),
        repeat: Some(crate::agents::schedule::Repeat::Days {
            days: vec![5],
            hour: 16,
            minute: 0,
        }),
        next_at: 0,
        created_at: 0,
        paused: false,
        paused_on_import: false,
        runs: Vec::new(),
        retry: None,
        watch: None,
        usage: Default::default(),
        follow_up: false,
        then,
        waiting: None,
        extra: Default::default(),
    }
}

fn step(text: &str, ask_first: bool) -> Step {
    Step {
        text: text.into(),
        ask_first,
    }
}

fn post() -> Vec<Step> {
    vec![step("Post it to #team on Slack", true)]
}

#[test]
fn steps_are_trimmed_capped_and_clean() {
    let ok = check(&[step("  Post it  ", true), step("   ", false)]).unwrap();
    assert_eq!(ok, vec![step("Post it", true)]);
    let five: Vec<Step> = (0..5).map(|i| step(&format!("s{i}"), false)).collect();
    assert!(check(&five).unwrap_err().contains("at most 5 steps"));
    assert!(check(&[step(&"x".repeat(MAX_STEP_CHARS + 1), false)]).is_err());
    assert!(check(&[step("post\u{1b}[2J", false)]).is_err());
}

#[test]
fn the_note_is_step_one_and_then_follows() {
    let c = routine(vec![step("Check it", false), step("Post it", true)]);
    assert_eq!(total(&c), 3);
    assert_eq!(step_text(&c, 1), Some(c.note.as_str()));
    assert_eq!(step_text(&c, 2), Some("Check it"));
    assert_eq!(step_text(&c, 3), Some("Post it"));
    assert_eq!(step_text(&c, 4), None);
    assert_eq!(step_text(&c, 0), None);
    assert_eq!(next(&c, 1), Next::Run(2));
    assert_eq!(next(&c, 2), Next::Ask(3));
    assert_eq!(next(&c, 3), Next::Done);
    assert_eq!(next(&routine(Vec::new()), 1), Next::Done);
}

#[test]
fn step_one_is_told_to_stop_before_step_two() {
    let c = routine(post());
    let ctx = first_step_context(&c);
    assert!(ctx.contains("step 1 of 2"));
    assert!(ctx.contains("Post it to #team on Slack"));
    assert!(ctx.contains("waits for the user's OK"));
    assert!(ctx.contains("don't do step 2"));
    assert!(first_step_context(&routine(Vec::new())).is_empty());
}

#[test]
fn an_approved_step_may_use_the_yes_and_nothing_wider() {
    let c = routine(post());
    let p = step_prompt(&c, 2, true, "Fri 16:05");
    assert!(p.contains("step 2 of 2"));
    assert!(p.contains("OK'd just now"));
    assert!(p.contains("ask_plan"));
    assert!(p.contains("Anything else still asks"));
    let unasked = step_prompt(&routine(vec![step("Tidy the notes", false)]), 2, false, "x");
    assert!(!unasked.contains("ask_plan"));
}

#[test]
fn the_card_shows_what_was_made_and_exactly_what_comes_next() {
    let c = routine(post());
    let a = card(&c, 1, "Weekly report\n- shipped X", 42);
    assert_eq!(a.title, "OK to go on?");
    assert_eq!(a.detail, "Weekly report\n- shipped X");
    let summary = a.summary.clone().unwrap();
    assert!(summary.contains("step 1 of 2 is done"));
    assert!(summary.ends_with("Post it to #team on Slack"));
    let g = a.gate.clone().unwrap();
    assert_eq!((g.done, g.total, g.run_at), (1, 2, 42));
    assert_eq!(g.next, "Post it to #team on Slack");
    // No tool call: only the user answers it.
    assert!(a.tool.is_none() && a.input.is_none() && a.always.is_none());
    let (kind, _) = crate::agents::admin::classify_in(&a, false, None);
    assert_eq!(kind, crate::agents::admin::Kind::Yours);
    // What Go ahead says yes to names the place and the words.
    let yes = approved_text(&a);
    assert!(yes.contains("#team") && yes.contains("shipped X"));
    let long = card(&c, 1, &"y".repeat(MAX_DRAFT_CHARS + 50), 1);
    assert_eq!(long.detail.chars().count(), MAX_DRAFT_CHARS);
    assert!(card(&c, 1, "  ", 1).detail.contains("no reply"));
}

#[test]
fn the_card_never_expires_on_its_own() {
    let a = card(&routine(post()), 1, "draft", 1);
    for moment in [
        crate::agents::expiry::Moment::Launch,
        crate::agents::expiry::Moment::Tick,
    ] {
        assert_eq!(
            crate::agents::expiry::verdict(&a, 7 * 24 * 3_600_000, false, moment),
            None
        );
    }
}

fn agent_with(c: CheckIn) -> Agent {
    let mut a: Agent = serde_json::from_value(serde_json::json!({
        "id": "a1", "name": "Reports", "role": "", "shape": 0, "color": "blue", "createdAt": 0
    }))
    .unwrap();
    a.check_ins = vec![c];
    a
}

#[test]
fn answering_checks_the_card_is_still_the_one_waiting() {
    let mut c = routine(post());
    let a = card(&c, 1, "draft", 7);
    // Not waiting (answered elsewhere, or superseded): refused.
    let err = decide(&agent_with(c.clone()), &a, true).unwrap_err();
    assert!(err.to_string().contains("moved on"));
    c.waiting = Some(Waiting {
        run_at: 7,
        step: 2,
        request_id: a.request_id.clone(),
        asked_at: 8,
    });
    match decide(&agent_with(c.clone()), &a, true).unwrap() {
        Answer::Go(_, n, at) => assert_eq!((n, at), (2, 7)),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        decide(&agent_with(c.clone()), &a, false).unwrap(),
        Answer::Stop("r1".into(), 7, 1)
    );
    // Its next step was edited while the card waited: not run blind.
    c.then = vec![step("Email it to the board", true)];
    assert!(decide(&agent_with(c), &a, true)
        .unwrap_err()
        .to_string()
        .contains("changed"));
}

#[test]
fn the_newest_reply_since_the_step_is_what_it_produced() {
    let msg = |ts: i64, kind: MessageKind, text: &str| {
        let mut m = crate::agents::runner::new_message("a1", kind, text);
        m.ts = ts;
        m
    };
    let log = vec![
        msg(1, MessageKind::Agent, "last week's"),
        msg(10, MessageKind::CheckIn, "fired"),
        msg(11, MessageKind::Agent, "This week's report"),
        msg(12, MessageKind::Note, "a note"),
    ];
    assert_eq!(produced(&log, 10), "This week's report");
    assert_eq!(produced(&log, 20), "");
}

#[test]
fn a_routine_in_steps_round_trips_and_an_old_one_stays_as_it_was() {
    let mut c = routine(post());
    c.waiting = Some(Waiting {
        run_at: 1,
        step: 2,
        request_id: "q".into(),
        asked_at: 2,
    });
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v["then"][0]["askFirst"], true);
    assert_eq!(v["waiting"]["step"], 2);
    let back: CheckIn = serde_json::from_value(v).unwrap();
    assert_eq!(back, c);
    let plain = serde_json::to_value(routine(Vec::new())).unwrap();
    assert!(plain.get("then").is_none() && plain.get("waiting").is_none());
}

#[test]
fn routine_names_are_short() {
    assert_eq!(routine_name("Weekly report\nwith more"), "Weekly report…");
    assert_eq!(routine_name("Weekly report"), "Weekly report");
    assert!(routine_name(&"z".repeat(80)).ends_with('…'));
}

/// Go ahead on a card and the routine's next run closing that card race
/// for the same waiting run: exactly one of them takes it, and a Go ahead
/// that lost (a stale card) starts nothing.
#[test]
fn go_ahead_and_the_next_run_never_both_take_the_waiting_run() {
    use std::sync::{Arc, Barrier};
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let setup = |name: &str| {
        let agent = store::create(store::NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            avatar: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let mut c = routine(post());
        let a = card(&c, 1, "draft", 7);
        c.waiting = Some(Waiting {
            run_at: 7,
            step: 2,
            request_id: a.request_id.clone(),
            asked_at: 8,
        });
        store::update(&agent.id, |x| x.check_ins = vec![c]).unwrap();
        (agent.id, a)
    };
    for round in 0..40 {
        let (id, a) = setup(&format!("Reporter {round}"));
        let gate = Arc::new(Barrier::new(2));
        let go = {
            let (gate, id, a) = (gate.clone(), id.clone(), a.clone());
            std::thread::spawn(move || {
                gate.wait();
                matches!(settle(&id, &a, true), Ok(Answer::Go(..)))
            })
        };
        let next_run = {
            let (gate, id) = (gate.clone(), id.clone());
            std::thread::spawn(move || {
                gate.wait();
                close_waiting(&id, "r1").is_some()
            })
        };
        let (went, closed) = (go.join().unwrap(), next_run.join().unwrap());
        assert!(went ^ closed, "round {round}: went {went}, closed {closed}");
        assert!(store::get(&id).unwrap().check_ins[0].waiting.is_none());
        // Whoever lost, a second Go ahead on the same card starts nothing.
        assert!(settle(&id, &a, true).is_err());
    }
    // The next run first: the stale card's Go ahead is refused.
    let (id, a) = setup("Late reader");
    assert!(close_waiting(&id, "r1").is_some());
    let err = settle(&id, &a, true).unwrap_err();
    assert!(err.to_string().contains("moved on"), "{err}");
    let runs = &store::get(&id).unwrap().check_ins[0].runs;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].outcome, runs::Outcome::Declined);
    store::set_root_for_tests(None);
}
