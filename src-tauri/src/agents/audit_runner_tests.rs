//! Reliability audit (the "silent bot" class): runner internals. A child of
//! `runner`, so it reaches its private items. Each test was first written to
//! show a bug, and now holds its fix.

use super::*;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str) -> store::Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn user(text: &str) -> Inbound {
    Inbound {
        id: String::new(),
        text: text.into(),
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
    }
}

fn from_chief(text: &str, reply: bool) -> Inbound {
    Inbound {
        id: String::new(),
        text: text.into(),
        from: From::Agent {
            sender: AgentRef {
                id: "chief".into(),
                name: "Chief".into(),
            },
            hop: 1,
        },
        reply,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
    }
}

/// #2: what the last run left is noted at launch, before any turn can start.
/// A turn started in this run (its mark and queue written after that) is
/// never treated as a leftover, and a message left waiting is queued once,
/// still on disk, ahead of anything sent since.
#[test]
fn recovery_only_touches_what_the_last_run_left() {
    scratch(|| {
        *LEFTOVERS.lock().unwrap() = None;
        let old = agent("Old");
        let live = agent("Live");
        // The last run: mid-turn, a message waiting behind it.
        write_mark(&old.id, TurnMark::default());
        save_inbox(&old.id, &[user("and also the footer")].into());
        prepare_recovery();
        assert!(awaiting_recovery(&old.id));
        assert!(!awaiting_recovery(&live.id));
        {
            let rt = RUNTIMES.lock().unwrap();
            let r = rt.get(&old.id).unwrap();
            assert_eq!(r.queue.len(), 1, "back on the queue, once");
            assert!(!r.running, "held until recovery has dealt with it");
        }
        assert_eq!(
            take_inbox(&old.id).len(),
            1,
            "still on disk should the app close again"
        );
        // This run: a live turn starts for another agent.
        write_mark(
            &live.id,
            TurnMark {
                pid: Some(std::process::id()),
                session: "--resume 1111-2222".into(),
                project: None,
                tree: None,
                batch: Vec::new(),
            },
        );
        // A second prepare (recover_after_restart's own) changes nothing.
        prepare_recovery();
        assert!(
            !awaiting_recovery(&live.id),
            "a live turn is never a leftover"
        );
        recovered(&old.id);
        assert!(!awaiting_recovery(&old.id));
        RUNTIMES.lock().unwrap().remove(&old.id);
        *LEFTOVERS.lock().unwrap() = None;
    });
}

/// #3: the turn's mark is on disk before its batch leaves the queue, so a
/// quit at any point after leaves a trace the next launch reports.
#[test]
fn a_quit_after_dequeue_still_leaves_the_turns_mark() {
    scratch(|| {
        let a = agent("Gap");
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(a.id.clone()).or_default();
            r.running = true;
            r.queue.push_back(user("deploy the site"));
            save_inbox(&a.id, &r.queue);
        }
        let batch = take_batch(&a.id).expect("a batch");
        assert_eq!(batch.prompt, "deploy the site");
        // ...the app dies here, during turn_start():
        assert!(take_inbox(&a.id).is_empty());
        assert!(
            read_mark(&a.id).is_some(),
            "the next launch says it didn't finish"
        );
        // An emptied queue takes nothing and leaves no mark.
        clear_mark(&a.id);
        assert!(take_batch(&a.id).is_none());
        assert!(read_mark(&a.id).is_none());
        RUNTIMES.lock().unwrap().remove(&a.id);
    });
}

/// #4/#5: Stop drops what's queued, but says what it dropped: each agent
/// that asked (once, not for its own replies) is owed word, and each
/// scheduled run is settled.
#[test]
fn stop_names_who_is_owed_word_for_what_it_dropped() {
    scratch(|| {
        let id = "stop1";
        std::fs::create_dir_all(store::agent_home(id).unwrap()).unwrap();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.into()).or_default();
            r.running = true;
            r.cancel = Some(Arc::new(Notify::new()));
            r.queue
                .push_back(from_chief("Chief asks: reconcile March", false));
            r.queue.push_back(from_chief("and April", false));
            r.queue
                .push_back(from_chief("here's what you asked for", true));
            let mut routine = user("[Scheduled check-in] daily summary");
            routine.routine = true;
            routine.ticket = Some("t-1".into());
            r.queue.push_back(routine);
        }
        let (stopped, dropped) = stop_queue(id, false);
        assert!(stopped);
        assert!(RUNTIMES.lock().unwrap().get(id).unwrap().queue.is_empty());
        let (askers, tickets) = dropped_debts(&dropped);
        assert_eq!(askers.len(), 1, "the Chief, once");
        assert_eq!(askers[0].0.id, "chief");
        assert_eq!(tickets, vec!["t-1".to_string()]);
        RUNTIMES.lock().unwrap().remove(id);
    });
}

/// #5: a scheduled run's ticket rides on the wake, survives an interrupt
/// (carried to the replacing turn), and is handed back once by id: never
/// matched by prompt text, which an interrupt truncates.
#[test]
fn scheduled_runs_settle_by_ticket_across_an_interrupt() {
    scratch(|| {
        let a = agent("Routine");
        let mut wake = user(&format!(
            "[Scheduled check-in] {}",
            "Summarise. ".repeat(100)
        ));
        wake.routine = true;
        wake.ticket = Some("t-9".into());
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(a.id.clone()).or_default();
            r.running = true;
            r.queue.push_back(wake);
        }
        take_batch(&a.id).unwrap();
        // Interrupted for a newer message: the next batch carries the ticket.
        RUNTIMES
            .lock()
            .unwrap()
            .get_mut(&a.id)
            .unwrap()
            .queue
            .push_back(user("what's up?"));
        take_batch(&a.id).unwrap();
        assert_eq!(take_tickets(&a.id), vec!["t-9".to_string()]);
        assert!(take_tickets(&a.id).is_empty(), "settled once");
        clear_mark(&a.id);
        RUNTIMES.lock().unwrap().remove(&a.id);
    });
}

/// #1: a worker that panics mid-turn no longer wedges the agent: running,
/// queued, cancel and the status are reset, and what it owed is handed back.
#[test]
fn a_panicking_turn_resets_the_agent() {
    scratch(|| {
        let id = "panic1".to_string();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.queued = true;
            r.cancel = Some(Arc::new(Notify::new()));
            r.status = Some(Status::working("Editing App.tsx".into()));
            r.owed = vec![AgentRef {
                id: "chief".into(),
                name: "Chief".into(),
            }];
            r.tickets = vec!["t-2".into()];
        }
        let worker = {
            let id = id.clone();
            std::thread::spawn(move || {
                let _guard = DrainGuard {
                    app: None,
                    agent_id: id,
                    armed: true,
                    progressed: true,
                };
                panic!("a bug in the turn path");
            })
        };
        assert!(worker.join().is_err());
        let rt = RUNTIMES.lock().unwrap();
        let r = rt.get(&id).unwrap();
        assert!(!r.running && !r.queued && r.cancel.is_none());
        assert_eq!(r.status.as_ref().unwrap().state, "idle");
        assert!(
            r.owed.is_empty() && r.tickets.is_empty(),
            "handed back, not lost"
        );
        drop(rt);
        // With messages that arrived meanwhile, a new worker is claimed for them.
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.get_mut(&id).unwrap();
            r.running = true;
            r.queue.push_back(user("still there?"));
        }
        let reset = reset_after_panic(&id, true);
        assert!(reset.restart);
        assert!(RUNTIMES.lock().unwrap().get(&id).unwrap().running);
        // Died before taking anything: what's queued is what killed it.
        let reset = reset_after_panic(&id, false);
        assert!(!reset.restart);
        let rt = RUNTIMES.lock().unwrap();
        assert!(!rt.get(&id).unwrap().running && rt.get(&id).unwrap().queue.is_empty());
        drop(rt);
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// #9: two cards open at once; answering one leaves "waiting"; only the
/// last brings it back to work, and an old turn's card changes nothing.
#[test]
fn waiting_lasts_until_every_open_card_is_answered() {
    let id = "waits1";
    let set_waiting = || {
        RUNTIMES
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .status = Some(Status {
            state: "waiting",
            activity: None,
            since: None,
            work: None,
            room: None,
        });
    };
    let turn = open_wait(id);
    assert_eq!(open_wait(id), turn);
    set_waiting();
    assert!(!close_wait(id, turn), "the other card is still open");
    assert!(close_wait(id, turn), "the last one: back to work");
    // A card from a turn that's over.
    let old = open_wait(id);
    {
        let mut rt = RUNTIMES.lock().unwrap();
        let r = rt.get_mut(id).unwrap();
        r.turn_gen += 1;
        r.waits = 0;
    }
    let _new = open_wait(id);
    set_waiting();
    assert!(!close_wait(id, old), "not the new turn's card");
    RUNTIMES.lock().unwrap().remove(id);
}

/// #11: a turn quiet for ten minutes with no tool call open says it may be
/// stuck; a long tool call (a build) is not silence.
#[test]
fn a_quiet_turn_says_it_may_be_stuck() {
    let t0 = 1_000_000;
    assert_eq!(quiet_line("Claude Code", t0, t0 + 9 * 60_000, false), None);
    let line = quiet_line("Claude Code", t0, t0 + 12 * 60_000, false).unwrap();
    assert!(
        line.contains("No word from Claude Code for 12 min"),
        "{line}"
    );
    assert!(line.contains("may be stuck"));
    assert_eq!(quiet_line("Claude Code", t0, t0 + 40 * 60_000, true), None);
}

/// #15: the worker's "nothing left" is decided under the lock `push` checks
/// `running` under: a message queued before it is seen, after it starts anew.
#[test]
fn going_idle_and_pushing_never_strand_a_message() {
    let id = "idle1";
    {
        let mut rt = RUNTIMES.lock().unwrap();
        let r = rt.entry(id.into()).or_default();
        r.running = true;
        r.queue.push_back(user("one more"));
    }
    assert!(
        finish_if_idle(id).is_none(),
        "work left: the worker carries on"
    );
    assert!(RUNTIMES.lock().unwrap().get(id).unwrap().running);
    RUNTIMES.lock().unwrap().get_mut(id).unwrap().queue.clear();
    assert!(finish_if_idle(id).is_some());
    assert!(!RUNTIMES.lock().unwrap().get(id).unwrap().running);
    RUNTIMES.lock().unwrap().remove(id);
}

/// An interrupted routine turn's cost carries over to the turn that replaces
/// it, so the routine is charged all of it; a person's message anywhere in
/// that chain means it isn't a routine's cost at all.
#[test]
fn an_interrupted_routines_cost_carries_over_and_a_person_unmakes_it() {
    scratch(|| {
        let a = agent("Pat");
        let routine = || {
            let mut wake = user("[Scheduled check-in you set: brief]");
            wake.routine = true;
            wake.ticket = Some("t-1".into());
            wake
        };
        let cost = |usd: f64| super::super::usage::UsageTotals {
            turns: 1,
            priced_turns: 1,
            cost_usd: usd,
            ..Default::default()
        };
        let push = |m: Inbound| {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(a.id.clone()).or_default();
            r.running = true;
            r.queue.push_back(m);
        };
        // Interrupted part-way, then replaced by another routine firing.
        push(routine());
        take_batch(&a.id).unwrap();
        add_turn_usage(&a.id, &cost(0.25));
        push(routine());
        take_batch(&a.id).unwrap();
        add_turn_usage(&a.id, &cost(0.5));
        let (spent, mixed) = take_turn_usage(&a.id);
        assert!(!mixed);
        assert_eq!(spent.turns, 2);
        assert!((spent.cost_usd - 0.75).abs() < 1e-9);
        // Settled: the next turn starts from nothing.
        assert_eq!(take_turn_usage(&a.id).0.turns, 0);

        // A routine interrupted by a person's message: nobody's routine.
        push(routine());
        take_batch(&a.id).unwrap();
        add_turn_usage(&a.id, &cost(0.25));
        push(user("what's up?"));
        take_batch(&a.id).unwrap();
        let (_, mixed) = take_turn_usage(&a.id);
        assert!(mixed);
        assert!(!take_turn_usage(&a.id).1, "reset once settled");
        clear_mark(&a.id);
        RUNTIMES.lock().unwrap().remove(&a.id);
    });
}
