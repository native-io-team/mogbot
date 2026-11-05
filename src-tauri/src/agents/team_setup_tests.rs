use super::*;
use serde_json::json;

use crate::agents::review::{self, CardKind, ConnectorCard, Pick, Picks, Review};

fn root() -> (std::sync::MutexGuard<'static, ()>, tempfile::TempDir) {
    let serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    (serial, dir)
}

fn agent(name: &str) -> store::Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: format!("{name}'s work"),
        instructions: format!("{name} does things."),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn line(agent_id: &str, ts: i64, value: serde_json::Value) -> AgentMessage {
    let mut v = value;
    v["id"] = json!(store::new_id());
    v["agentId"] = json!(agent_id);
    v["ts"] = json!(ts);
    serde_json::from_value(v).unwrap()
}

fn say(agent_id: &str, ts: i64, value: serde_json::Value) {
    store::append_message(&line(agent_id, ts, value)).unwrap();
}

fn tool_card(id: &str, command: &str) -> serde_json::Value {
    json!({
        "kind": "approval",
        "approval": {
            "requestId": id, "title": "Run a command", "detail": command, "status": "pending",
            "tool": "Bash", "input": { "command": command }
        }
    })
}

fn login_card(id: &str, name: &str) -> serde_json::Value {
    json!({
        "kind": "approval",
        "approval": {
            "requestId": id, "title": format!("Secure input · {name}"), "detail": "", "status": "pending",
            "secret": { "name": name, "purpose": "Its bank", "kind": "password",
                        "fields": [{ "label": "Password", "env": "BANK" }],
                        "reference": "ref", "quiet": true }
        }
    })
}

fn paused_routine(agent_id: &str) {
    store::update(agent_id, |a| {
        a.check_ins.push(
            serde_json::from_value(json!({
                "id": "r1", "note": "Check for new invoices", "nextAt": store::now_ms() + 3_600_000,
                "createdAt": store::now_ms(), "paused": true, "pausedOnImport": true,
                "repeat": { "kind": "days", "days": [1, 2, 3, 4, 5], "hour": 9, "minute": 0 }
            }))
            .unwrap(),
        )
    })
    .unwrap();
}

fn arrived(agent: &store::Agent, gaps: &[&str]) -> Arrived {
    Arrived {
        agent_id: agent.id.clone(),
        gaps: gaps.iter().map(|g| g.to_string()).collect(),
    }
}

fn step_of(view: &SetupView, id: StepId) -> &StepView {
    view.steps.iter().find(|s| s.id == id).unwrap()
}

#[test]
fn an_import_wakes_nobody_and_its_agents_stay_quiet_until_the_user_says_hi() {
    let (_serial, _dir) = root();
    let chief = crate::agents::ensure_main().unwrap();
    let proposals = ["Bookkeeper", "Errands"]
        .iter()
        .enumerate()
        .map(|(i, name)| {
            review::proposal(
                format!("p{i}"),
                &json!({
                    "name": name, "role": "Work", "instructions": "Do it.",
                    "routines": [{ "when": "whenever it feels right", "what": "tidy up" }]
                }),
                &chief.name,
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let card = ConnectorCard {
        kind: CardKind::Review,
        talk_id: "t".into(),
        source: "Grok".into(),
        review: Some(Review {
            proposals,
            ..Default::default()
        }),
        playback: None,
    };
    let picks = Picks {
        agents: ["p0", "p1"]
            .iter()
            .map(|k| Pick {
                key: k.to_string(),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let applied = review::apply(None, &chief, &card, &picks).unwrap();
    assert_eq!(applied.made.len(), 2);
    // What the playback said it couldn't read comes along as a gap.
    assert!(applied.made[0]
        .gaps
        .iter()
        .any(|g| g.contains("whenever it feels right")));
    start("Grok", applied.made.clone()).unwrap().unwrap();
    for made in &applied.made {
        assert!(is_quiet(&made.agent_id));
        // Nothing queued, nothing running: the import woke nobody.
        assert!(!crate::agents::runner::in_turn(&made.agent_id));
        assert!(!store::agent_home(&made.agent_id)
            .unwrap()
            .join("inbox.json")
            .exists());
    }
    let first = &applied.made[0].agent_id;
    assert!(mark_greeted(first).unwrap());
    assert!(!mark_greeted(first).unwrap(), "once");
    assert!(!is_quiet(first));
    assert!(is_quiet(&applied.made[1].agent_id));
    // Put away, the setup no longer keeps anyone quiet.
    dismiss().unwrap();
    assert!(!is_quiet(&applied.made[1].agent_id));
    store::set_root_for_tests(None);
}

#[test]
fn a_turn_hands_work_to_a_few_agents_and_only_one_quiet_one() {
    let caller = format!("caller-{}", store::new_id());
    for i in 0..MAX_FAN_OUT {
        admit(&caller, 7, &format!("a{i}"), "A", false).unwrap();
    }
    // Messaging one it already messaged doesn't count again.
    admit(&caller, 7, "a0", "A", false).unwrap();
    let refused = admit(&caller, 7, "a-next", "Next", false).unwrap_err();
    assert!(refused.contains("read_agent"), "{refused}");
    // A new turn starts counting again.
    admit(&caller, 8, "q1", "Bookkeeper", true).unwrap();
    let quiet = admit(&caller, 8, "q2", "Errands", true).unwrap_err();
    assert!(
        quiet.contains("Errands") && quiet.contains("says hi"),
        "{quiet}"
    );
    admit(&caller, 8, "awake", "Site", false).unwrap();
    // Sixteen at once, as the Chief once did, reach at most the cap.
    let chief = format!("chief-{}", store::new_id());
    let sent = (0..16)
        .filter(|i| admit(&chief, 1, &format!("imported{i}"), "X", true).is_ok())
        .count();
    assert_eq!(sent, MAX_QUIET_PER_TURN);
}

#[test]
fn the_checklist_follows_the_store_and_what_the_user_chose() {
    let (_serial, _dir) = root();
    crate::agents::ensure_main().unwrap();
    let finance = agent("Bookkeeper");
    let car = agent("Studio");
    say(&finance.id, 1, login_card("l1", "bank"));
    paused_routine(&finance.id);
    start(
        "Grok",
        vec![
            arrived(&finance, &["Nothing on a schedule"]),
            arrived(&car, &[]),
        ],
    )
    .unwrap();

    let v = view().unwrap();
    let order: Vec<StepId> = v.steps.iter().map(|s| s.id).collect();
    assert_eq!(order, StepId::ORDER.to_vec());
    assert_eq!((v.done, v.total, v.current), (0, 4, Some(StepId::Logins)));
    assert_eq!(step_of(&v, StepId::Logins).logins[0].name, "bank");
    let r = &step_of(&v, StepId::Routines).routines[0];
    assert!(!r.on && r.what == "Check for new invoices" && !r.when.is_empty());
    assert_eq!(
        step_of(&v, StepId::Missing).gaps[0].agent_name,
        "Bookkeeper"
    );
    assert_eq!(step_of(&v, StepId::Hello).agents.len(), 2);

    // Skipped, the next step is the one the card opens on.
    set_step(StepId::Logins, StepState::Skipped).unwrap();
    let v = view().unwrap();
    assert_eq!((v.done, v.current), (1, Some(StepId::Routines)));
    // The login saved in Bookkeeper's own chat ticks it off here.
    store::set_approval_status(&finance.id, "l1", ApprovalStatus::Allowed).unwrap();
    assert_eq!(
        step_of(&view().unwrap(), StepId::Logins).state,
        StepState::Done
    );

    // Switched on from the card, the routine stays listed, now on.
    set_routine(&finance.id, "r1", true).unwrap();
    let v = view().unwrap();
    assert!(step_of(&v, StepId::Routines).routines[0].on);
    assert!(!store::get(&finance.id).unwrap().check_ins[0].paused);
    assert!(set_routine("someone-else", "r1", true).is_err());
    set_step(StepId::Routines, StepState::Done).unwrap();
    set_step(StepId::Missing, StepState::Done).unwrap();
    let v = view().unwrap();
    assert_eq!(
        (v.done, v.current, v.complete),
        (3, Some(StepId::Hello), false)
    );

    // Saying hi to everyone finishes it, and nobody is quiet any more.
    mark_greeted(&finance.id).unwrap();
    assert!(is_quiet(&car.id));
    mark_greeted(&car.id).unwrap();
    let v = view().unwrap();
    assert!(v.complete && v.current.is_none());
    assert!(load().unwrap().finished_at.is_some());
    // Reopening a step brings it back.
    set_step(StepId::Missing, StepState::Open).unwrap();
    let v = view().unwrap();
    assert_eq!(v.current, Some(StepId::Missing));
    assert!(missing_text(&v).unwrap().contains("Nothing on a schedule"));
    assert!(chief_context().unwrap().contains("read_agent"));
    store::set_root_for_tests(None);
}

#[test]
fn a_second_import_joins_the_same_checklist() {
    let (_serial, _dir) = root();
    let a = agent("A");
    let b = agent("B");
    // Still something open on the first (its gap), so it's still going.
    let first = start("Grok", vec![arrived(&a, &["y"])]).unwrap().unwrap();
    set_step(StepId::Hello, StepState::Skipped).unwrap();
    let second = start("Grok", vec![arrived(&b, &["x"])]).unwrap().unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.agents, vec![a.id.clone(), b.id.clone()]);
    // The card stays where it was first posted in the Chief's chat.
    assert_eq!(second.posted_at, first.posted_at);
    assert_eq!(view().unwrap().posted_at, first.started_at);
    // Someone new reopens Say hi.
    assert!(!second.steps.contains_key(&StepId::Hello));
    // One that was finished is done with: the next import starts its own.
    for step in StepId::ORDER {
        set_step(step, StepState::Skipped).unwrap();
    }
    assert!(view().unwrap().complete);
    let c = agent("C");
    let third = start("Grok", vec![arrived(&c, &[])]).unwrap().unwrap();
    assert_ne!(third.id, first.id);
    assert_eq!(third.agents, vec![c.id.clone()]);
    store::set_root_for_tests(None);
}

#[test]
fn read_agent_reads_without_waking() {
    let (_serial, _dir) = root();
    let finance = agent("Bookkeeper");
    say(&finance.id, 1, login_card("l1", "bank"));
    say(&finance.id, 2, tool_card("t1", "ls /workspace/finance"));
    paused_routine(&finance.id);
    start("Grok", vec![arrived(&finance, &["Tell me when to run"])]).unwrap();
    let text = read_agent_text(&store::get(&finance.id).unwrap());
    for needed in [
        "hasn't started here yet",
        "Check for new invoices (paused)",
        "waiting for (the user adds them from the card): bank",
        "Run a command: ls /workspace/finance",
        "Tell me when to run",
        "Bookkeeper does things.",
    ] {
        assert!(text.contains(needed), "missing {needed:?} in\n{text}");
    }
    assert!(!crate::agents::runner::in_turn(&finance.id));
    store::set_root_for_tests(None);
}

/// Today's team, as an older build left it: imported, then woken all at
/// once by the Chief, each with a request open from that.
#[test]
fn the_upgrade_folds_an_older_import_in_and_sets_aside_the_fan_out_once() {
    let (_serial, _dir) = root();
    let chief = crate::agents::ensure_main().unwrap();
    let now = store::now_ms();
    let old_note = |agent_id: &str, ts: i64| {
        say(
            agent_id,
            ts,
            json!({ "kind": "note", "text": "Imported from Grok Bot. It starts when you message it; its routines are paused." }),
        )
    };
    let from_chief = json!({
        "kind": "from_agent", "text": "Reply with everything waiting on Robin.",
        "peer": { "id": chief.id, "name": chief.name }
    });
    // The review card the import came from, with a routine it couldn't read.
    let p = review::proposal(
        "p0".into(),
        &json!({ "name": "Bookkeeper", "role": "Books", "instructions": "Pay.",
                 "routines": [{ "when": "now and then", "what": "check the ledger" }] }),
        &chief.name,
    )
    .unwrap();
    say(
        &chief.id,
        now - 10_000,
        json!({ "kind": "approval", "approval": {
            "requestId": "rev", "title": "Bring in agents", "detail": "", "status": "allowed",
            "connector": { "kind": "review", "talkId": "t", "source": "Grok Bot",
                           "review": { "proposals": [p] } } } }),
    );

    let finance = agent("Bookkeeper");
    say(&finance.id, now - 9_000, login_card("l1", "bank"));
    old_note(&finance.id, now - 9_000);
    say(&finance.id, now - 8_000, from_chief.clone());
    say(
        &finance.id,
        now - 7_900,
        tool_card("fan", "ls /workspace/finance"),
    );
    // Something the user asked for themselves afterwards stays theirs.
    say(
        &finance.id,
        now - 5_000,
        json!({ "kind": "user", "text": "Pay the rent" }),
    );
    say(
        &finance.id,
        now - 4_900,
        tool_card("mine", "curl https://bank.example"),
    );
    paused_routine(&finance.id);

    let car = agent("Studio");
    old_note(&car.id, now - 9_000);
    say(&car.id, now - 8_000, from_chief);
    say(
        &car.id,
        now - 7_000,
        tool_card("car-fan", "ls /workspace/car"),
    );

    // A long-standing agent nobody imported is left alone.
    let mine = agent("Mine");
    say(&mine.id, now - 7_000, tool_card("keep", "ls"));

    let done = upgrade(&chief).unwrap().unwrap();
    assert_eq!(done.agents, 2);
    // The card sits under the upgrade's line ("below"), where it was posted.
    let chief_log = store::messages(&chief.id, usize::MAX).unwrap();
    let line = chief_log.iter().rev().find(|m| m.text == UPGRADE_LINE).unwrap();
    assert_eq!(view_any().unwrap().posted_at, line.ts);
    let mut set: Vec<&str> = done.set_aside.iter().map(|(_, id)| id.as_str()).collect();
    set.sort();
    assert_eq!(set, vec!["car-fan", "fan"]);

    let card = |agent_id: &str, id: &str| store::find_approval(agent_id, id).unwrap().unwrap();
    let aside = card(&finance.id, "fan");
    assert_eq!(aside.status, ApprovalStatus::Expired);
    assert_eq!(
        aside.set_aside.as_deref(),
        Some(set_aside_line(&chief.name).as_str())
    );
    assert_eq!(card(&finance.id, "mine").status, ApprovalStatus::Pending);
    assert_eq!(card(&finance.id, "l1").status, ApprovalStatus::Pending);
    assert_eq!(card(&mine.id, "keep").status, ApprovalStatus::Pending);
    // The counts the sidebar reads follow.
    assert_eq!(store::get(&finance.id).unwrap().pending_approvals, 2);
    assert_eq!(store::get(&car.id).unwrap().pending_approvals, 0);

    // Each chat it touched says so in a line, and so does the Chief's.
    let last = |id: &str| store::messages(id, 1).unwrap().pop().unwrap();
    assert!(last(&car.id).text.starts_with("Set aside a request"));
    assert!(last(&chief.id).text.contains("in one place now"));

    // The checklist: logins, the paused routine, the gap, then hello.
    let v = view().unwrap();
    assert_eq!(v.set_aside, 2);
    assert_eq!(v.source, "Grok Bot");
    assert_eq!(step_of(&v, StepId::Logins).logins.len(), 1);
    assert_eq!(step_of(&v, StepId::Routines).routines.len(), 1);
    assert!(step_of(&v, StepId::Missing).gaps[0].lines[0].contains("now and then"));
    // Bookkeeper was messaged by the user after the import: met. Studio wasn't.
    assert!(!is_quiet(&finance.id));
    assert!(is_quiet(&car.id));

    // Never twice, even once the user has put it away.
    dismiss().unwrap();
    assert!(upgrade(&chief).unwrap().is_none());
    store::set_root_for_tests(None);
}

#[test]
fn the_upgrade_does_nothing_without_an_import() {
    let (_serial, _dir) = root();
    let chief = crate::agents::ensure_main().unwrap();
    let a = agent("Mine");
    say(&a.id, store::now_ms(), tool_card("x", "ls"));
    assert!(upgrade(&chief).unwrap().is_none());
    assert!(load().is_none());
    assert!(view().is_none());
    store::set_root_for_tests(None);
}

#[test]
fn a_setup_kept_by_an_earlier_build_keeps_the_place_it_was_posted() {
    let (_serial, _dir) = root();
    let chief = crate::agents::ensure_main().unwrap();
    let a = agent("Bookkeeper");
    let now = store::now_ms();
    // Upgraded by a build that pinned the card at the foot: no `postedAt`.
    say(&chief.id, now - 60_000, json!({ "kind": "note", "text": UPGRADE_LINE }));
    say(&chief.id, now - 1_000, json!({ "kind": "user", "text": "Morning" }));
    let kept = TeamSetup {
        id: "old".into(),
        source: "Grok Bot".into(),
        started_at: now - 3_600_000,
        agents: vec![a.id.clone()],
        upgraded: true,
        ..TeamSetup::default()
    };
    save(&kept).unwrap();
    assert!(!std::fs::read_to_string(path().unwrap()).unwrap().contains("postedAt"));
    // Under the upgrade's line, not under "Morning"; and written down once.
    assert_eq!(view().unwrap().posted_at, now - 60_000);
    assert_eq!(load().unwrap().posted_at, Some(now - 60_000));

    // One from an import: at the import.
    save(&TeamSetup { upgraded: false, posted_at: None, ..kept }).unwrap();
    assert_eq!(view().unwrap().posted_at, now - 3_600_000);
    store::set_root_for_tests(None);
}
