//! Adversarial runner tests from the review of the reliability fixes
//! (child of runner.rs). Each repro now holds its fix.
use super::*;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

async fn inner_that_panics() {
    tokio::task::yield_now().await;
    panic!("bug deep in run_turn");
}

/// A panic inside an async task, after an await, in a nested future:
/// DrainGuard's Drop does see `thread::panicking()`.
#[test]
fn guard_fires_for_a_panic_inside_a_tokio_task() {
    scratch(|| {
        let id = "rv-panic".to_string();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.status = Some(Status::working("x".into()));
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let id2 = id.clone();
        let res = rt.block_on(async move {
            tokio::spawn(async move {
                let _g = DrainGuard {
                    app: None,
                    agent_id: id2,
                    armed: true,
                    progressed: true,
                };
                tokio::task::yield_now().await;
                inner_that_panics().await;
            })
            .await
        });
        assert!(res.unwrap_err().is_panic());
        assert!(
            !RUNTIMES.lock().unwrap().get(&id).unwrap().running,
            "reset by the guard"
        );
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// Abort (runtime shutdown / JoinHandle::abort) is not a panic: guard stays quiet.
#[test]
fn guard_ignores_task_abort() {
    scratch(|| {
        let id = "rv-abort".to_string();
        RUNTIMES
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_default()
            .running = true;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let id2 = id.clone();
        rt.block_on(async move {
            let h = tokio::spawn(async move {
                let _g = DrainGuard {
                    app: None,
                    agent_id: id2,
                    armed: true,
                    progressed: true,
                };
                std::future::pending::<()>().await;
            });
            tokio::task::yield_now().await;
            h.abort();
            let _ = h.await;
        });
        assert!(
            RUNTIMES.lock().unwrap().get(&id).unwrap().running,
            "abort must not reset"
        );
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// #2: the panicked turn's hop is carried past the reset, so word to its
/// delegators still respects the cap: a turn at MAX_HOPS sends nothing.
#[test]
fn panic_reset_keeps_the_hop_for_telling_delegators() {
    scratch(|| {
        let id = "rv-hop".to_string();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.hop = MAX_HOPS;
            r.owed = vec![AgentRef {
                id: "chief".into(),
                name: "Chief".into(),
            }];
        }
        let reset = reset_after_panic(&id, true);
        assert_eq!(reset.owed.len(), 1);
        assert_eq!(current_hop(&id), 0, "the runtime itself is reset");
        assert_eq!(reset.hop, MAX_HOPS, "but the turn's hop is kept");
        assert_eq!(reply_hop(reset.hop), None, "at the cap: not sent");
        assert_eq!(reply_hop(2), Some(3));
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// #2: the same on the Stop-after-interrupt path.
#[test]
fn finish_if_idle_keeps_the_hop_for_telling_delegators() {
    scratch(|| {
        let id = "rv-hop2".to_string();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.hop = MAX_HOPS;
            r.owed = vec![AgentRef {
                id: "chief".into(),
                name: "Chief".into(),
            }];
        }
        let idle = finish_if_idle(&id).unwrap();
        assert_eq!(idle.owed.len(), 1);
        assert_eq!(current_hop(&id), 0);
        assert_eq!(reply_hop(idle.hop), None, "at the cap: not sent");
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

fn chief_asks(text: &str) -> Inbound {
    Inbound {
        id: store::new_id(),
        text: text.into(),
        from: From::Agent {
            sender: AgentRef {
                id: "chief".into(),
                name: "Chief".into(),
            },
            hop: 2,
        },
        reply: false,
        routine: false,
        ticket: None,
        room: None,
    }
}

fn user_says(text: &str) -> Inbound {
    Inbound {
        id: store::new_id(),
        text: text.into(),
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
    }
}

/// #1: a turn's panic is caught and handled as a failed turn; and when that
/// handling panics too, the guard (firing while unwinding) only resets the
/// agent in memory, so the second panic ends the task, not the app.
#[test]
fn a_panic_in_the_panic_handling_does_not_abort() {
    use futures_util::FutureExt;
    scratch(|| {
        let id = "rv-double".to_string();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.hop = 3;
            r.status = Some(Status::working("x".into()));
            r.owed = vec![AgentRef {
                id: "chief".into(),
                name: "Chief".into(),
            }];
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let id2 = id.clone();
        let handled = Arc::new(Mutex::new(None::<(usize, u8)>));
        let seen = handled.clone();
        let res = rt.block_on(async move {
            tokio::spawn(async move {
                let mut guard = DrainGuard {
                    app: None,
                    agent_id: id2,
                    armed: true,
                    progressed: false,
                };
                let run = async {
                    tokio::task::yield_now().await;
                    panic!("bug deep in run_turn");
                };
                let panicked = std::panic::AssertUnwindSafe(run)
                    .catch_unwind()
                    .await
                    .is_err();
                assert!(panicked, "caught, not unwound through the task");
                end_drain(&mut guard, panicked, |reset| {
                    *seen.lock().unwrap() = Some((reset.owed.len(), reset.hop));
                    // Now the handling panics: the guard is still armed.
                    panic!("bug in after_panic");
                });
            })
            .await
        });
        assert!(
            res.unwrap_err().is_panic(),
            "the task ended; the process did not abort"
        );
        assert_eq!(
            *handled.lock().unwrap(),
            Some((1, 3)),
            "the handler had what it owed, and the hop"
        );
        let rt = RUNTIMES.lock().unwrap();
        let r = rt.get(&id).unwrap();
        assert!(!r.running, "reset by the guard after the second panic");
        assert_eq!(r.status.as_ref().unwrap().state, "idle");
        drop(rt);
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// #1: a panic caught and handled leaves the guard disarmed: its drop
/// changes nothing (here, a new worker the handler claimed stays claimed).
#[test]
fn a_handled_panic_disarms_the_guard() {
    scratch(|| {
        let id = "rv-handled".to_string();
        RUNTIMES
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_default()
            .running = true;
        let mut guard = DrainGuard {
            app: None,
            agent_id: id.clone(),
            armed: true,
            progressed: true,
        };
        end_drain(&mut guard, true, |_| {
            RUNTIMES
                .lock()
                .unwrap()
                .get_mut("rv-handled")
                .unwrap()
                .running = true;
        });
        assert!(!guard.armed);
        drop(guard);
        assert!(RUNTIMES.lock().unwrap().get(&id).unwrap().running);
        // No panic at all: disarmed, and nothing reset.
        let mut guard = DrainGuard {
            app: None,
            agent_id: id.clone(),
            armed: true,
            progressed: true,
        };
        end_drain(&mut guard, false, |_| panic!("not called"));
        assert!(!guard.armed);
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// #9: a worker that panics before taking its first batch drops what was
/// queued, and hands it back so the agents that asked are told.
#[test]
fn a_panic_before_the_first_batch_names_who_asked() {
    scratch(|| {
        let id = "rv-early".to_string();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.queue.push_back(chief_asks("reconcile March"));
            r.queue.push_back(user_says("and you?"));
        }
        let reset = reset_after_panic(&id, false);
        assert!(!reset.restart);
        assert_eq!(reset.dropped.len(), 2);
        let (askers, _) = dropped_debts(&reset.dropped);
        assert_eq!(askers.len(), 1);
        assert_eq!(askers[0].0.id, "chief");
        assert_eq!(
            askers[0].1, 2,
            "told at the asker's own hop (plus one when sent)"
        );
        assert!(RUNTIMES.lock().unwrap().get(&id).unwrap().queue.is_empty());
        // After progress, what's queued is newer: kept, nobody to tell.
        RUNTIMES
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .queue
            .push_back(chief_asks("April"));
        let reset = reset_after_panic(&id, true);
        assert!(reset.restart && reset.dropped.is_empty());
        RUNTIMES.lock().unwrap().remove(&id);
    });
}

/// #3: however recovery ends (here, a panic part-way), the gate opens:
/// leftovers are cleared and a turn waiting on them goes ahead.
#[test]
fn a_recovery_that_panics_still_lets_turns_go() {
    scratch(|| {
        *LEFTOVERS.lock().unwrap() = Some(HashMap::from([
            ("rv-left-a".to_string(), Vec::new()),
            ("rv-left-b".to_string(), Vec::new()),
        ]));
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let waiter = tokio::spawn(async { wait_for_recovery("rv-left-b").await });
            tokio::task::yield_now().await;
            let recovery = tokio::spawn(async {
                let _gate = RecoveryGate;
                recovered("rv-left-a");
                tokio::task::yield_now().await;
                panic!("bug while recovering rv-left-b");
            });
            assert!(recovery.await.unwrap_err().is_panic());
            tokio::time::timeout(Duration::from_secs(5), waiter)
                .await
                .expect("the waiting turn was let go")
                .unwrap();
        });
        assert!(!awaiting_recovery("rv-left-b"));
        *LEFTOVERS.lock().unwrap() = None;
    });
}

/// #7: while a delete waits for the dying turn, nothing new is queued, so no
/// turn starts on an agent about to go; a failed delete takes messages again.
#[test]
fn a_deleting_agent_takes_no_new_messages() {
    scratch(|| {
        let id = "rv-del".to_string();
        std::fs::create_dir_all(store::agent_home(&id).unwrap()).unwrap();
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.entry(id.clone()).or_default();
            r.running = true;
            r.cancel = Some(Arc::new(Notify::new()));
            r.queue.push_back(user_says("first"));
        }
        let (stopped, dropped) = stop_queue(&id, true);
        assert!(stopped && dropped.len() == 1);
        {
            let mut rt = RUNTIMES.lock().unwrap();
            let r = rt.get_mut(&id).unwrap();
            r.running = false; // the dying turn ended
            let refused = r.admit(chief_asks("one more thing"));
            assert!(
                refused.is_err(),
                "refused, and handed back to tell its sender"
            );
            assert!(
                r.queue.is_empty() && !r.running,
                "no worker for a doomed agent"
            );
        }
        undelete(&id);
        assert!(matches!(
            RUNTIMES
                .lock()
                .unwrap()
                .get_mut(&id)
                .unwrap()
                .admit(user_says("hi")),
            Ok(true)
        ));
        // Never seen before (no runtime yet): still closed by the delete.
        let (_, _) = stop_queue("rv-del-new", true);
        assert!(RUNTIMES
            .lock()
            .unwrap()
            .get_mut("rv-del-new")
            .unwrap()
            .admit(user_says("x"))
            .is_err());
        RUNTIMES.lock().unwrap().remove(&id);
        RUNTIMES.lock().unwrap().remove("rv-del-new");
    });
}

/// #8: the app closing between a turn's mark and its dequeue leaves both;
/// recovery then sends the messages again and does not also say the turn
/// didn't finish (whose Retry would send them a second time).
#[test]
fn a_turn_that_never_took_its_messages_is_resent_not_retried() {
    scratch(|| {
        *LEFTOVERS.lock().unwrap() = None;
        let a = store::create(store::NewAgent {
            name: "Mark".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        // The last run: queued, marked, and gone before the dequeue.
        let waiting = [user_says("deploy the site"), user_says("and the blog")];
        save_inbox(&a.id, &waiting.iter().cloned().collect());
        write_mark(
            &a.id,
            TurnMark {
                batch: waiting.iter().map(|m| m.id.clone()).collect(),
                ..TurnMark::default()
            },
        );
        prepare_recovery();
        let found = LEFTOVERS
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .get(&a.id)
            .cloned()
            .unwrap();
        let mark = read_mark(&a.id).unwrap();
        assert!(never_taken(&mark, &found), "no 'didn't finish, Retry' line");
        assert_eq!(
            still_queued(&a.id, &found).len(),
            2,
            "both said to be sent again"
        );
        // A mark from a turn that did take its messages (or an older one).
        assert!(!never_taken(
            &TurnMark {
                batch: vec!["gone".into()],
                ..TurnMark::default()
            },
            &found
        ));
        assert!(!never_taken(&TurnMark::default(), &found));
        // Stop while the turns wait for recovery: the dropped aren't "sent again".
        let (_, dropped) = stop_queue(&a.id, false);
        assert_eq!(dropped.len(), 2);
        assert!(still_queued(&a.id, &found).is_empty());
        clear_mark(&a.id);
        RUNTIMES.lock().unwrap().remove(&a.id);
        *LEFTOVERS.lock().unwrap() = None;
    });
}

/// #8: an inbox written before messages had ids gets them on the way back,
/// so recovery can still tell which are queued.
#[test]
fn an_old_inbox_gets_ids_when_read_back() {
    scratch(|| {
        *LEFTOVERS.lock().unwrap() = None;
        let a = store::create(store::NewAgent {
            name: "Old".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let path = store::agent_home(&a.id).unwrap().join("inbox.json");
        std::fs::write(&path, r#"[{"text":"hello","from":"User"}]"#).unwrap();
        prepare_recovery();
        let found = LEFTOVERS
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .get(&a.id)
            .cloned()
            .unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found[0].id.is_empty());
        assert_eq!(still_queued(&a.id, &found).len(), 1);
        RUNTIMES.lock().unwrap().remove(&a.id);
        *LEFTOVERS.lock().unwrap() = None;
    });
}
