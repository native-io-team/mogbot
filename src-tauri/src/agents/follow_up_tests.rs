//! Follow-ups (child of follow_up.rs): which endings are promises, which
//! "can't"s are checked, and the bounds. Fictional team and wording.

use super::*;

#[test]
fn an_explicit_promise_to_act_now_is_found() {
    for text in [
        "Found the two invoices. I'll check Slack for the launch thread next.",
        "The build is green. Next I'll run the audit on the staging site.",
        "Got it. Let me pull the latest numbers from the sheet.",
        "Drafts are in your folder. I'm going to review them against the brief now.",
        "Thanks. I’ll go ahead and fix the broken links.",
        "On it: I'll go through the open tickets.",
    ] {
        assert!(promise(text).is_some(), "{text}");
    }
    assert_eq!(
        promise("Found it. I'll check Slack for the launch thread next.").as_deref(),
        Some("I'll check Slack for the launch thread next.")
    );
}

#[test]
fn questions_waits_later_times_and_report_backs_are_not_promises() {
    for text in [
        "Want me to check Slack next?",
        "I'll check Slack once you've shared the channel.",
        "When Finance replies I'll update the sheet.",
        "I'll run the audit tomorrow at 9.",
        "I'll check back at 14:30.",
        "I'll let you know when it's done.",
        "I'll keep an eye on it.",
        "I won't send anything until you say so.",
        "Let me know which one you want.",
        "I'll be here if you need anything.",
        "I'll remember that for next time.",
        // An earlier promise the reply then moved past isn't its ending.
        "I'll check the logs. They show a timeout in the importer. The fix is in the PR, and the tests pass. Nothing else is open.",
        "Done: the report is in your folder.",
        // Offers waiting on the user's go-ahead (observed 2026-11-08).
        "The fix is committed locally. Say the word and I'll run it next.",
        "I'll deploy it with your OK.",
        "Happy to, I'll run the sweep whenever you want.",
        "If you'd like, I'll draft the reply.",
        "I'll check the other inbox if so.",
    ] {
        assert_eq!(promise(text), None, "{text}");
    }
}

#[test]
fn a_cant_about_a_known_service_is_found_and_others_are_not() {
    let found = cant_reach("Sorry, I can't read your Gmail from here. Everything else is done.");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].1.id, "gmail");
    assert!(found[0].0.contains("can't read your Gmail"));
    assert_eq!(
        cant_reach("I don’t have access to Slack in this session.")[0]
            .1
            .id,
        "slack"
    );
    for text in [
        "Gmail is quiet today: nothing new.",
        "I can't send that email without your OK.",
        "Can you check your Gmail?",
        "You can't read Gmail from the phone app.",
        "I can't find the invoice in the folder.",
    ] {
        assert!(cant_reach(text).is_empty(), "{text}");
    }
}

#[test]
fn a_cant_passed_on_from_another_agent_is_not_this_agents_claim() {
    for text in [
        "The Chief also reports that the scout couldn't read Slack because your Chrome isn't connected.",
        "Ledger told me it can't access Gmail today.",
        "According to the Chief, we can't read Slack yet.",
    ] {
        assert!(cant_reach(text).is_empty(), "{text}");
    }
    // Its own claim still counts.
    assert_eq!(
        cant_reach("I can't read Slack: your Chrome isn't connected.").len(),
        1
    );
}

#[test]
fn a_cant_about_the_browser_is_not_contradicted_by_a_browser_being_on() {
    assert!(about_the_browser(
        "I can't read Slack: your Chrome isn't connected."
    ));
    assert!(about_the_browser(
        "I can't open Slack in the agents' browser, it's signed out."
    ));
    assert!(!about_the_browser(
        "I don't have access to Slack in this session."
    ));
    let way = |f: super::super::team_reach::Facts| {
        super::super::team_reach::ways(
            &f,
            super::super::team_reach::service_named("slack").unwrap(),
        )
    };
    let ways = way(super::super::team_reach::Facts {
        chrome: true,
        agents_browser: true,
        ..Default::default()
    });
    assert_eq!(ways.len(), 2);
    assert!(ways
        .iter()
        .all(|w| super::super::team_reach::is_browser_way(w)));
    let connected = way(super::super::team_reach::Facts {
        connections: vec!["Slack (acme)".into()],
        ..Default::default()
    });
    assert!(!super::super::team_reach::is_browser_way(&connected[0]));
}

fn gmail() -> &'static Service {
    super::super::team_reach::service_named("gmail").unwrap()
}

#[test]
fn the_decision_runs_a_promise_only_when_nothing_followed_and_nothing_waits() {
    let reply = "Got it. I'll check Slack for the launch thread next.";
    let turn = Turn {
        last_reply: Some(reply),
        ..Default::default()
    };
    assert_eq!(
        decide(&turn, &[]),
        Decision::FollowUp("Said it would: “I'll check Slack for the launch thread next.”".into())
    );
    for t in [
        Turn {
            acted_after: true,
            ..turn.clone()
        },
        Turn {
            waiting: true,
            ..turn.clone()
        },
        Turn {
            card_open: true,
            ..turn.clone()
        },
        Turn {
            last_reply: None,
            ..turn.clone()
        },
    ] {
        assert_eq!(decide(&t, &[]), Decision::Nothing, "{t:?}");
    }
}

#[test]
fn a_contradicted_cant_is_followed_up_with_who_can() {
    let turn = Turn {
        last_reply: Some("I can't read Gmail, sorry."),
        acted_after: true,
        ..Default::default()
    };
    let c: Vec<Contradicted> = vec![(
        "I can't read Gmail, sorry.".into(),
        gmail(),
        vec!["Inbox: the Gmail connector in its engine (as of its last turn)".into()],
    )];
    let Decision::FollowUp(note) = decide(&turn, &c) else {
        panic!("not followed up");
    };
    assert!(note.contains("Inbox: the Gmail connector"), "{note}");
    // Nobody can: a plain "can't" stands.
    assert_eq!(decide(&turn, &[]), Decision::Nothing);
}

fn check_in(follow_up: bool) -> CheckIn {
    let mut c: CheckIn = serde_json::from_value(serde_json::json!({
        "id": "f1", "note": "n", "nextAt": 0, "createdAt": 0
    }))
    .unwrap();
    c.follow_up = follow_up;
    c
}

#[test]
fn one_waiting_and_a_few_a_day_at_most() {
    let now = 10 * DAY_MS;
    assert!(room_for_one(&[], &[], now));
    assert!(room_for_one(&[check_in(false)], &[], now));
    assert!(
        !room_for_one(&[check_in(true)], &[], now),
        "one already waits"
    );
    let today = vec![now - 1000; MAX_PER_DAY];
    assert!(!room_for_one(&[], &today, now));
    let yesterday = vec![now - DAY_MS - 1; MAX_PER_DAY];
    assert!(room_for_one(&[], &yesterday, now));
}

#[test]
fn a_follow_ups_wake_quotes_the_reply_and_allows_nothing_new() {
    use chrono::FixedOffset;
    let mut c = check_in(true);
    c.note = promise_note("I'll check Slack next.");
    let firing = super::super::schedule::Firing {
        agent_id: "a".into(),
        check_in: c,
        late: false,
        next: None,
        also: Vec::new(),
        manual: false,
        retry: None,
        waited: false,
    };
    let p = super::super::schedule::wake_prompt(&FixedOffset::east_opt(0).unwrap(), &firing, 0);
    assert!(p.starts_with("[A follow-up the app recorded"), "{p}");
    assert!(p.contains("“I'll check Slack next.”"), "{p}");
    assert!(p.contains(super::super::schedule::NOTHING_NEW));
    assert!(!p.contains("you set"), "{p}");
}

#[test]
fn the_user_writing_first_folds_it_into_their_turn() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let agent = store::create(store::NewAgent {
        name: "Inbox".into(),
        role: "Mail".into(),
        instructions: "Reads the inbox.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    record(&agent.id, &promise_note("I'll check Slack next."), 1).unwrap();
    // A second can't be added while one waits.
    record(&agent.id, "another", 2).unwrap();
    assert_eq!(store::get(&agent.id).unwrap().check_ins.len(), 1);
    let note = fold_into_user_turn(&agent.id).unwrap();
    assert!(note.contains("I'll check Slack next."), "{note}");
    assert!(store::get(&agent.id).unwrap().check_ins.is_empty());
    assert_eq!(fold_into_user_turn(&agent.id), None);
    store::set_root_for_tests(None);
}
