//! Durable turns (child of runner.rs): a turn the app or its engine cut off
//! keeps what it had done, and is picked up once in the same conversation.
use super::*;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    *LEFTOVERS.lock().unwrap() = None;
    f();
    *LEFTOVERS.lock().unwrap() = None;
    store::set_root_for_tests(None);
}

fn agent(name: &str) -> store::Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn says(text: &str, from: From) -> Inbound {
    Inbound {
        id: store::new_id(),
        text: text.into(),
        from,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
        resume: 0,
        typed: None,
        conversation: None,
    }
}

fn user(text: &str) -> Inbound {
    says(text, From::User)
}

const SESSION: &str = "0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e";

/// A turn as the runner starts one: queued, taken, its process spawned in
/// `SESSION`. What the app leaves behind when it goes mid-turn.
fn start_turn(agent_id: &str, messages: Vec<Inbound>) -> Batch {
    {
        let mut runtimes = RUNTIMES.lock().unwrap();
        let r = runtimes.entry(agent_id.to_string()).or_default();
        r.queue.extend(messages);
        r.running = true;
    }
    let batch = take_batch(agent_id).expect("a batch");
    update_mark(agent_id, |m| {
        m.pid = Some(424242);
        m.session = SESSION.into();
        m.session_id = Some(SESSION.into());
    });
    batch
}

fn forget(agent_id: &str) {
    clear_mark(agent_id);
    RUNTIMES.lock().unwrap().remove(agent_id);
    super::super::work::forget_agent(agent_id);
}

fn queue_of(agent_id: &str) -> Vec<Inbound> {
    RUNTIMES
        .lock()
        .unwrap()
        .get(agent_id)
        .map(|r| r.queue.iter().cloned().collect())
        .unwrap_or_default()
}

fn on_disk(_: Engine, _: &str) -> bool {
    true
}

fn not_on_disk(_: Engine, _: &str) -> bool {
    false
}

#[test]
fn a_tidy_cut_off_by_a_restart_is_dropped_quietly() {
    scratch(|| {
        let a = agent("Tidy");
        // The tidy's process spawns with no turn's mark before it.
        write_mark(
            &a.id,
            TurnMark {
                pid: Some(424242),
                session: SESSION.into(),
                session_id: Some(SESSION.into()),
                quiet: true,
                ..TurnMark::default()
            },
        );
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, None, "no line, no carry on");
        assert!(plan.partial.is_none());
        assert!(queue_of(&a.id).is_empty(), "nothing queued");
        assert!(read_mark(&a.id).is_none(), "the mark is dealt with");
        forget(&a.id);
    });
}

#[test]
fn a_cut_off_turn_is_detected_and_picked_up_once_in_the_same_session() {
    scratch(|| {
        let a = agent("Ada");
        start_turn(&a.id, vec![user("Migrate the blog")]);
        // The app is gone: the next launch finds the mark.
        let mark = read_mark(&a.id).unwrap();
        assert_eq!(mark.session_id.as_deref(), Some(SESSION));
        assert_eq!(mark.took.len(), 1, "what it took is in the mark");
        assert_eq!(mark.resumes, 0);
        RUNTIMES.lock().unwrap().remove(&a.id);

        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Resume));
        assert!(read_mark(&a.id).is_none(), "the mark is dealt with");
        // Its session is the agent's, so the pick-up resumes it.
        assert_eq!(
            store::get(&a.id).unwrap().session_id.as_deref(),
            Some(SESSION)
        );
        let queued = queue_of(&a.id);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].resume, 1);
        assert!(queued[0]
            .text
            .starts_with("[The app restarted while you were working"));
        assert!(queued[0].text.contains("don't redo finished steps"));

        // The pick-up runs: told only to carry on (the ask is already in
        // the conversation), and its mark says it is the one pick-up.
        let batch = take_batch(&a.id).unwrap();
        assert_eq!(batch.resume, 1);
        assert_eq!(batch.prompt, prompts::carry_on("The app restarted"));
        assert!(!batch.prompt.contains("Migrate the blog"));
        assert_eq!(read_mark(&a.id).unwrap().resumes, 1);
        update_mark(&a.id, |m| m.session_id = Some(SESSION.into()));
        RUNTIMES.lock().unwrap().remove(&a.id);

        // Cut off again: not picked up a second time. Continue instead.
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Continue(RESTART_LINE)));
        assert!(queue_of(&a.id).is_empty(), "nothing queued by itself");
        forget(&a.id);
    });
}

#[test]
fn a_turn_under_take_over_or_stopped_is_never_picked_up() {
    scratch(|| {
        let a = agent("Bea");
        start_turn(&a.id, vec![user("Draft the email")]);
        RUNTIMES.lock().unwrap().remove(&a.id);
        // The user was driving it by hand when the app went.
        let plan = plan_recovery(&a.id, &[], true, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Continue(RESTART_LINE)));
        assert!(queue_of(&a.id).is_empty());

        // The user pressed Stop, and the app went before the turn ended.
        start_turn(&a.id, vec![user("Draft the email")]);
        let (stopped, _) = stop_queue(&a.id, false);
        assert!(stopped);
        assert!(read_mark(&a.id).unwrap().stopped, "the mark says so");
        RUNTIMES.lock().unwrap().remove(&a.id);
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Stopped));
        assert!(queue_of(&a.id).is_empty());
        forget(&a.id);
    });
}

#[test]
fn without_its_conversation_on_disk_nothing_starts_from_scratch() {
    scratch(|| {
        let a = agent("Cy");
        start_turn(&a.id, vec![user("Rename the files")]);
        RUNTIMES.lock().unwrap().remove(&a.id);
        let plan = plan_recovery(&a.id, &[], false, not_on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Continue(SESSION_GONE_LINE)));
        assert!(queue_of(&a.id).is_empty());

        // Nor when the agent has moved to another conversation since.
        start_turn(&a.id, vec![user("Rename the files")]);
        store::update(&a.id, |x| {
            x.session_id = Some("ffffffff-0000-0000-0000-000000000000".into())
        })
        .unwrap();
        RUNTIMES.lock().unwrap().remove(&a.id);
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Continue(SESSION_GONE_LINE)));

        // Nor a turn with no session recorded at all.
        start_turn(&a.id, vec![user("Rename the files")]);
        update_mark(&a.id, |m| m.session_id = None);
        RUNTIMES.lock().unwrap().remove(&a.id);
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Continue(SESSION_GONE_LINE)));
        forget(&a.id);
    });
}

#[test]
fn a_room_turn_is_left_for_continue() {
    scratch(|| {
        let a = agent("Dot");
        let mut asked = user("What's the plan?");
        asked.room = Some(super::super::rooms::RoomRef {
            room_id: "room-1".into(),
            hop: 0,
            asker: super::super::rooms::Asker::User,
        });
        // Taken directly: a room's prompt is built when the turn starts.
        start_turn(&a.id, vec![asked]);
        RUNTIMES.lock().unwrap().remove(&a.id);
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        assert_eq!(plan.pickup, Some(Pickup::Continue(RESTART_LINE)));
        assert!(queue_of(&a.id).is_empty());
        forget(&a.id);
    });
}

#[test]
fn a_picked_up_delegation_still_answers_whoever_asked() {
    scratch(|| {
        let a = agent("Eve");
        let chief = AgentRef {
            id: "chief".into(),
            name: "Chief".into(),
        };
        let mut asked = says(
            "Summarise the report",
            From::Agent {
                sender: chief.clone(),
                hop: 1,
            },
        );
        asked.ticket = Some("run-1".into());
        asked.outside = true;
        start_turn(&a.id, vec![asked]);
        RUNTIMES.lock().unwrap().remove(&a.id);
        plan_recovery(&a.id, &[], false, on_disk);
        let queued = queue_of(&a.id);
        assert!(matches!(&queued[0].from, From::Agent { sender, .. } if sender.id == "chief"));
        assert!(queued[0].outside, "a sealed turn stays sealed");
        assert_eq!(queued[0].ticket, None, "the restart closed its run");
        let batch = take_batch(&a.id).unwrap();
        // Said as the app's note, not as a message from the Chief.
        assert_eq!(batch.prompt, prompts::carry_on("The app restarted"));
        assert!(
            owes(&a.id, "chief"),
            "its reply still goes back to the Chief"
        );
        forget(&a.id);
    });
}

#[test]
fn the_reply_so_far_and_the_timeline_are_saved_as_the_turn_goes() {
    scratch(|| {
        let a = agent("Fay");
        start_turn(&a.id, vec![user("Write the post")]);
        super::super::work::begin(&a.id, 1_000);
        super::super::work::on_step(
            &a.id,
            super::super::work::StepKind::Project,
            "Opened the blog",
            1_100,
        );
        save_progress(&a.id, Some(("draft-1", "Here is the first half of")));
        let mark = read_mark(&a.id).unwrap();
        let progress = mark.progress.clone().unwrap();
        assert_eq!(
            progress.draft,
            Some((
                "draft-1".to_string(),
                "Here is the first half of".to_string()
            ))
        );
        assert_eq!(progress.work.as_ref().unwrap().step_count, 1);
        // Saving again never loses what else the mark holds.
        assert_eq!(mark.session_id.as_deref(), Some(SESSION));
        assert_eq!(mark.took.len(), 1);

        // At the next launch: the partial reply is kept under its own id,
        // marked cut off, and the timeline comes with the recovery line.
        RUNTIMES.lock().unwrap().remove(&a.id);
        super::super::work::forget_agent(&a.id);
        let plan = plan_recovery(&a.id, &[], false, on_disk);
        let reply = plan.partial.unwrap();
        assert_eq!(reply.id, "draft-1");
        assert!(reply.stopped);
        assert_eq!(reply.kind, MessageKind::Agent);
        assert_eq!(reply.text, "Here is the first half of");
        assert_eq!(plan.work.unwrap().step_count, 1);

        // A draft already recorded whole isn't recorded twice.
        let mut whole = new_message(&a.id, MessageKind::Agent, "Here is the first half of it.");
        whole.id = "draft-2".into();
        store::append_message(&whole).unwrap();
        let draft = ("draft-2".to_string(), "Here is".to_string());
        assert!(partial_reply(&a.id, Some(&draft)).is_none());
        forget(&a.id);
    });
}

#[test]
fn a_turn_that_never_took_its_messages_has_nothing_to_pick_up() {
    scratch(|| {
        let a = agent("Gus");
        let waiting = [user("deploy the site")];
        write_mark(
            &a.id,
            TurnMark {
                batch: waiting.iter().map(|m| m.id.clone()).collect(),
                session_id: Some(SESSION.into()),
                ..TurnMark::default()
            },
        );
        let plan = plan_recovery(&a.id, &waiting, false, on_disk);
        assert_eq!(plan.pickup, None);
        assert!(queue_of(&a.id).is_empty());
        forget(&a.id);
    });
}

#[test]
fn an_engine_that_dies_is_picked_up_once_and_only_when_it_can_be() {
    use super::super::failure::FailureKind;
    assert_eq!(next_pickup(0), Some(1));
    assert_eq!(next_pickup(MAX_RESUMES), None);
    // A conversation the engine confirmed, ended for no reason it named.
    assert!(died_mid_turn(true, FailureKind::Other));
    // Never one that didn't start, nor one that needs the user.
    assert!(!died_mid_turn(false, FailureKind::Other));
    assert!(!died_mid_turn(true, FailureKind::SignedOut));
    assert!(!died_mid_turn(true, FailureKind::UsageLimit));
    let line = died_again_line(Engine::Claude, "Killed: 9\nmore");
    assert!(line.starts_with("Interrupted: Claude Code stopped unexpectedly again (Killed: 9)"));
    assert!(line.contains("Continue"));
    // Cut off and not picked up: said as interrupted, once.
    set_cut_off("ghost");
    assert!(take_cut_off("ghost"));
    assert!(!take_cut_off("ghost"));
}

#[test]
fn a_session_is_found_only_where_the_engine_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let roots = vec![root.clone()];
    assert!(!super::super::wallet::session_in(
        &roots,
        Engine::Claude,
        SESSION
    ));
    std::fs::create_dir_all(root.join("projects/-Users-fixture-agent")).unwrap();
    std::fs::write(
        root.join(format!("projects/-Users-fixture-agent/{SESSION}.jsonl")),
        "{}",
    )
    .unwrap();
    assert!(super::super::wallet::session_in(
        &roots,
        Engine::Claude,
        SESSION
    ));
    // Not something that only looks like a path.
    assert!(!super::super::wallet::session_in(
        &roots,
        Engine::Claude,
        "../x"
    ));

    assert!(!super::super::wallet::session_in(
        &roots,
        Engine::Codex,
        SESSION
    ));
    std::fs::create_dir_all(root.join("sessions/2026/11/05")).unwrap();
    std::fs::write(
        root.join(format!(
            "sessions/2026/11/05/rollout-2026-11-05T10-00-00-{SESSION}.jsonl"
        )),
        "{}",
    )
    .unwrap();
    assert!(super::super::wallet::session_in(
        &roots,
        Engine::Codex,
        SESSION
    ));
}

/// A turn that panics mid-way is picked up like one a crash cut off: its
/// mark (still on disk) gives the same pick-up, once, in the same session,
/// told what happened. Panicking again ends on Interrupted with Continue.
#[test]
fn a_panicked_turn_is_picked_up_once_then_interrupted() {
    scratch(|| {
        let a = agent("Ada");
        start_turn(&a.id, vec![user("Write the ⌘K docs 🙂")]);
        save_progress(&a.id, Some(("draft-p", "Here is 日本語 so far")));
        // The worker panics: its runtime is reset (in memory), then handled.
        let reset = reset_after_panic(&a.id, true);
        assert!(!reset.restart, "nothing else was queued");

        let (plan, pid) = plan_after_panic(&a.id, false, on_disk).expect("a pick-up");
        assert_eq!(pid, None, "424242 isn't a process this run spawned");
        assert_eq!(plan.pickup, Some(Pickup::Resume));
        assert!(read_mark(&a.id).is_none(), "the mark is dealt with");
        let partial = plan.partial.expect("the reply it was writing is kept");
        assert_eq!(partial.text, "Here is 日本語 so far");
        assert!(partial.stopped);
        let line = recovery_line(&a.id, plan.pickup.as_ref(), Cause::Panic).unwrap();
        assert_eq!(line.text, PANIC_PICKED_UP_LINE);
        assert_eq!(line.kind, MessageKind::Note);

        let queued = queue_of(&a.id);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].resume, 1);
        assert_eq!(
            queued[0].text,
            prompts::carry_on("Something went wrong in the app")
        );
        assert!(
            claim_idle_worker(&a.id),
            "a worker is claimed for the pick-up"
        );
        assert!(!claim_idle_worker(&a.id), "only one");

        // The pick-up runs, and panics again: not picked up a second time.
        take_batch(&a.id).unwrap();
        update_mark(&a.id, |m| m.session_id = Some(SESSION.into()));
        reset_after_panic(&a.id, true);
        let (plan, _) = plan_after_panic(&a.id, false, on_disk).unwrap();
        assert_eq!(plan.pickup, Some(Pickup::Continue(PANIC_INTERRUPTED_LINE)));
        assert!(queue_of(&a.id).is_empty(), "nothing queued by itself");
        let line = recovery_line(&a.id, plan.pickup.as_ref(), Cause::Panic).unwrap();
        assert_eq!(line.kind, MessageKind::Error);
        assert_eq!(
            line.failure,
            Some(super::super::failure::Failure::INTERRUPTED)
        );
        forget(&a.id);
    });
}

/// Without a turn in flight (it panicked before taking anything, or after
/// its turn ended) there is nothing to pick up: the plain failed line.
#[test]
fn a_panic_with_no_turn_in_flight_has_nothing_to_pick_up() {
    scratch(|| {
        let a = agent("Ada");
        assert!(plan_after_panic(&a.id, false, on_disk).is_none());
        forget(&a.id);
    });
}

/// Driven by hand: never picked up by itself.
#[test]
fn a_panicked_turn_under_a_takeover_is_left_for_continue() {
    scratch(|| {
        let a = agent("Ada");
        start_turn(&a.id, vec![user("go")]);
        reset_after_panic(&a.id, true);
        let (plan, _) = plan_after_panic(&a.id, true, on_disk).unwrap();
        assert_eq!(plan.pickup, Some(Pickup::Continue(PANIC_INTERRUPTED_LINE)));
        assert!(queue_of(&a.id).is_empty());
        forget(&a.id);
    });
}

/// Picked up, its delegators and scheduled runs carry over (once each) to
/// the turn that carries it on, rather than being told it failed.
#[test]
fn a_picked_up_panic_carries_its_debts_over() {
    scratch(|| {
        let id = "carry";
        let chief = AgentRef {
            id: "chief".into(),
            name: "Chief".into(),
        };
        RUNTIMES
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .owed
            .push(chief.clone());
        carry_over(id, vec![chief.clone()], vec!["t-1".into()]);
        carry_over(id, vec![chief], vec!["t-1".into()]);
        let rt = RUNTIMES.lock().unwrap();
        let r = rt.get(id).unwrap();
        assert_eq!(r.owed.len(), 1);
        assert_eq!(r.tickets, vec!["t-1".to_string()]);
        drop(rt);
        RUNTIMES.lock().unwrap().remove(id);
    });
}
