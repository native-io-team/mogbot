//! The worker: takes the next batch from the inbox (one conversation per turn), runs turns until the queue is empty, and the guards that make a panicking worker say so.

use super::*;

/// What a turn is handed: its batch of messages, composed.
pub(super) struct Batch {
    pub(super) prompt: String,
    pub(super) routine: bool,
    /// A turn picked back up after it was cut off: which pick-up (0: not one).
    pub(super) resume: u8,
    /// The first message's text: what a bound agent's copy is named after.
    pub(super) request: String,
    /// What the user said in the turn's messages (empty when none was the
    /// user's): what the labels-only guard reads.
    pub(super) user_said: String,
    /// Asked in a room: the prompt is the room's, written as the turn starts.
    pub(super) room: Option<RoomBatch>,
    /// The conversation it answers in, when its messages said.
    pub(super) conversation: Option<String>,
}

/// Take everything queued as the next turn, or `None` when the queue was
/// emptied meanwhile (a Stop). The turn's mark is written *before* the
/// batch leaves the queue (and `inbox.json`), so there is no moment when a
/// quit would leave neither: the next launch always says the turn didn't
/// finish.
pub(super) fn take_batch(agent_id: &str) -> Option<Batch> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    if runtime.queue.is_empty() {
        return None;
    }
    // Under the lock, like the inbox write below, so the two land in order
    // and name the same messages.
    // One conversation per turn: what was said in a room is answered there,
    // and never folded into a turn answering the agent's own chat (or
    // another room). The rest waits for the next turn, in order.
    let take = same_place_prefix(&runtime.queue);
    let took: Vec<Inbound> = runtime.queue.iter().take(take).cloned().collect();
    write_mark(
        agent_id,
        TurnMark {
            batch: took.iter().map(|m| m.id.clone()).collect(),
            resumes: took.iter().map(|m| m.resume).max().unwrap_or(0),
            took,
            ..TurnMark::default()
        },
    );
    let batch: Vec<Inbound> = runtime.queue.drain(..take).collect();
    save_inbox(agent_id, &runtime.queue);
    runtime.batch_ids = batch.iter().map(|m| m.id.clone()).collect();
    runtime.conversation = batch.first().and_then(|m| m.conversation.clone());
    runtime.room = batch.first().and_then(|m| m.room.clone()).map(|mut room| {
        // The deepest hop the turn answers, like an agent's request.
        room.hop = batch
            .iter()
            .filter_map(|m| m.room.as_ref().map(|r| r.hop))
            .max()
            .unwrap_or(room.hop);
        room
    });
    let routine = batch.iter().all(|m| m.routine);
    let resume = batch.iter().map(|m| m.resume).max().unwrap_or(0);
    // Its cost is a routine's only if nothing else was in it, nor in the
    // interrupted turn it replaces (whose cost carries over in `turn_usage`).
    runtime.turn_mixed |= !routine;
    // The user's own words in it: carried over from an interrupted turn.
    let users = batch.iter().any(|m| {
        matches!(m.from, From::User)
            && m.room.is_none()
            && (m.ticket.is_none() || m.ticket.as_deref().is_some_and(approved_ticket))
            && (!m.routine || m.ticket.as_deref().is_some_and(approved_ticket))
            && !m.outside
            && m.resume == 0
    });
    runtime.user_asked = users || (runtime.interrupted.is_some() && runtime.user_asked);
    let mut words: Vec<String> = batch
        .iter()
        .filter(|m| {
            matches!(m.from, From::User)
                && m.room.is_none()
                && m.ticket.is_none()
                && !m.routine
                && !m.outside
                && m.resume == 0
        })
        .map(|m| m.text.clone())
        .collect();
    if batch
        .iter()
        .any(|m| matches!(m.from, From::Agent { .. }) && !m.outside)
    {
        if let Some(relayed) = RELAYED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(agent_id)
        {
            words.push(relayed);
        }
    }
    runtime.user_text = words.join("\n");
    // Outside text taints the turn, and the turn that *replaces* it (an
    // interruption carries its prompt over). Never the next turn after one
    // that finished: a worker runs turns back to back while its queue isn't
    // empty, and the user's own "Use it" queued behind a "When…" turn was
    // sealed as outside text (`fromOutside` on its cards).
    runtime.outside =
        batch.iter().any(|m| m.outside) || (runtime.outside && runtime.interrupted.is_some());
    runtime.typed = typed_of(&batch, runtime.outside);
    // Whether the turn answering a Slack ask read outside text (`slack::decide`).
    // Which turn took it, too, so its reply is that turn's and no other's.
    super::slack::note_batch(
        agent_id,
        &runtime.batch_ids,
        runtime.outside,
        runtime.interrupted.is_some(),
        store::now_ms(),
    );
    let request = batch.first().map(|m| m.text.clone()).unwrap_or_default();
    let user_said = batch
        .iter()
        .filter(|m| matches!(m.from, From::User) && m.room.is_none())
        .map(|m| m.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    // The turn inherits the deepest hop it is answering; a user message
    // in the batch resets the chain.
    // An app note, like the user, starts the chain over: it owes no agent.
    runtime.noted = batch.iter().any(|m| matches!(m.from, From::App))
        || (runtime.interrupted.is_some() && runtime.noted);
    runtime.agent_in = batch.iter().any(|m| matches!(m.from, From::Agent { .. }))
        || (runtime.interrupted.is_some() && runtime.agent_in);
    runtime.answers_only = batch.iter().all(|m| {
        matches!(m.from, From::Agent { .. })
            && m.reply
            && m.room.is_none()
            && m.ticket.is_none()
            && !m.outside
    }) && (runtime.interrupted.is_none() || runtime.answers_only);
    runtime.origin = if batch.iter().any(|m| m.from.here()) {
        None
    } else {
        batch.iter().rev().find_map(|m| match &m.from {
            From::Agent { sender, .. } => Some(sender.id.clone()),
            From::User | From::App => None,
        })
    };
    runtime.hop = if batch.iter().any(|m| m.from.here()) {
        0
    } else {
        batch
            .iter()
            .filter_map(|m| match &m.from {
                From::Agent { hop, .. } => Some(*hop),
                From::User | From::App => None,
            })
            .max()
            .unwrap_or(0)
    };
    // A room's hand-offs are agents bringing each other in: a turn there
    // starts as far along the chain as the room's hop, so a `message_agent`
    // from it can't begin a fresh 6-hop chain of its own.
    if let Some(room) = &runtime.room {
        runtime.hop = runtime.hop.max(room.hop);
    }
    // An interrupted turn's debts carry over to the turn that replaces it.
    // An answer to a request this agent made on someone else's behalf owes
    // them the outcome (see [`ONWARD`]), so it goes back up the chain.
    let mut onward: HashMap<String, Vec<AgentRef>> = HashMap::new();
    for m in &batch {
        let From::Agent { sender, .. } = &m.from else {
            continue;
        };
        let to = if m.reply {
            let up = onward_for(agent_id, &sender.id);
            onward.insert(sender.id.clone(), up.clone());
            up
        } else {
            vec![sender.clone()]
        };
        for to in to {
            if to.id != agent_id && !runtime.owed.iter().any(|a| a.id == to.id) {
                runtime.owed.push(to);
            }
        }
    }
    // So do its scheduled runs: settled when this turn ends.
    runtime
        .tickets
        .extend(batch.iter().filter_map(|m| m.ticket.clone()));
    runtime.turn_gen = runtime.turn_gen.wrapping_add(1);
    runtime.waits = 0;
    runtime.cancel = Some(Arc::new(Notify::new()));
    runtime.interrupt = false;
    let asked: Vec<(super::rooms::Asker, String)> = batch
        .iter()
        .filter_map(|m| m.room.as_ref().map(|r| (r.asker.clone(), m.text.clone())))
        .collect();
    // A room's asks are never the user's own words in the agent's chat: what
    // the turn was asked is kept quoted, under who asked it.
    let prompt = match runtime.room {
        Some(_) => super::rooms::asks(&asked),
        None => compose(&batch, &onward),
    };
    runtime.prompt = Some(prompt.clone());
    // What an interrupted turn left is told only to a turn in the same place;
    // otherwise it waits for one (or goes when the agent is idle again).
    let place = place_of(runtime.room.as_ref(), runtime.conversation.as_deref());
    let preamble = if runtime.interrupted.is_some() && runtime.interrupted_in == place {
        runtime.interrupted_in = None;
        runtime.interrupted.take().unwrap_or_default()
    } else {
        String::new()
    };
    // The labels-only note belongs to the agent's own chat, where it was earned.
    let nudge = if runtime.room.is_none() {
        // And the Chief's notes about a level the user plainly wants changed (`level_hint`).
        runtime.nudge.take().unwrap_or_default() + &super::level_hint::take(agent_id)
    } else {
        String::new()
    };
    let room = runtime.room.clone();
    let conversation = runtime.conversation.clone();
    // Disk low: every turn opens with it, wherever it answers (`disk`).
    let disk = super::disk::turn_note();
    // A conversation with a page: one line, so the turn keeps it current (`page`).
    let page = if room.is_none() {
        super::page::turn_note(
            agent_id,
            conversation
                .as_deref()
                .unwrap_or(super::conversations::FIRST),
        )
    } else {
        String::new()
    };
    let prompt = format!("{nudge}{disk}{page}{preamble}{prompt}");
    Some(Batch {
        prompt,
        routine,
        resume,
        request,
        user_said,
        conversation,
        room: room.map(|room| RoomBatch {
            room,
            preamble,
            asked,
        }),
    })
}

/// Where something was said, as one key: a room, one of the agent's own
/// conversations other than the first, or `None` for the first (and an
/// inbox from before conversations, which is where it was said).
pub(super) fn place_of(
    room: Option<&super::rooms::RoomRef>,
    conversation: Option<&str>,
) -> Option<String> {
    match (room, conversation) {
        (Some(r), _) => Some(r.room_id.clone()),
        (None, Some(c)) if c != super::conversations::FIRST => Some(format!("conversation:{c}")),
        _ => None,
    }
}

/// How many of the queue's first messages were said in the same place (one
/// of the agent's own conversations, or one room): what one turn takes.
pub(super) fn same_place_prefix(queue: &VecDeque<Inbound>) -> usize {
    let place = |m: &Inbound| place_of(m.room.as_ref(), m.conversation.as_deref());
    let Some(first) = queue.front().map(place) else {
        return 0;
    };
    queue.iter().take_while(|m| place(m) == first).count()
}

/// A turn asked in a room: its prompt is written when it starts, from the
/// room as it is then (`rooms::prompt`), not when it was queued.
pub(super) struct RoomBatch {
    pub(super) room: super::rooms::RoomRef,
    /// What an interrupted turn left for this one to be told first.
    pub(super) preamble: String,
    /// Who asked and what they said, in order.
    pub(super) asked: Vec<(super::rooms::Asker, String)>,
}

/// The queue is empty: the worker is done. Decided under the same lock
/// `push` checks `running` under, so a message pushed now either is seen
/// here or starts a new worker. Returns what an interrupted turn that was
/// never replaced (the queue was stopped) still owes, to settle.
pub(super) fn finish_if_idle(agent_id: &str) -> Option<Idle> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    if !runtime.queue.is_empty() {
        return None;
    }
    runtime.running = false;
    runtime.queued = false;
    runtime.cancel = None;
    runtime.room = None;
    let hop = std::mem::take(&mut runtime.hop);
    runtime.origin = None;
    runtime.prompt = None;
    runtime.interrupted = None;
    runtime.interrupted_in = None;
    runtime.turn_usage = super::usage::UsageTotals::default();
    runtime.turn_mixed = false;
    runtime.outside = false;
    runtime.typed = None;
    runtime.user_asked = false;
    runtime.noted = false;
    runtime.agent_in = false;
    runtime.user_text.clear();
    Some(Idle {
        owed: std::mem::take(&mut runtime.owed),
        tickets: std::mem::take(&mut runtime.tickets),
        hop,
    })
}

/// What a worker going idle still owes (see [`finish_if_idle`]).
pub(super) struct Idle {
    pub(super) owed: Vec<AgentRef>,
    pub(super) tickets: Vec<String>,
    /// The hop of the last turn, from before the reset: word sent for it
    /// travels one further, and not past [`MAX_HOPS`].
    pub(super) hop: u8,
}

/// The scheduled runs the agent's current turn answers.
pub(super) fn turn_tickets(agent_id: &str) -> Vec<String> {
    let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes
        .get(agent_id)
        .map(|r| r.tickets.clone())
        .unwrap_or_default()
}

pub(super) fn take_tickets(agent_id: &str) -> Vec<String> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes
        .get_mut(agent_id)
        .map(|r| std::mem::take(&mut r.tickets))
        .unwrap_or_default()
}

/// The words for an agent that delegated to a turn that was stopped.
pub(super) fn stopped_reason(note: Option<&str>) -> String {
    match note {
        None => "it was stopped before it finished.".to_string(),
        Some(TIMEOUT_NOTE) => "it ran out of time (3 hours) before it finished.".to_string(),
        Some(note) => note.to_string(),
    }
}

/// The last resort for a worker that died mid-turn. A panic in a turn is
/// caught in [`drain`] and handled as a failed turn ([`after_panic`]); this
/// fires only if that handling panics too (or the guard is used bare). It
/// runs while unwinding, where a second panic aborts the whole app, so it
/// only resets the agent's in-memory state (one lock, field writes) and
/// leaves everything else (status, chat line, delegators, scheduled runs,
/// the restart) to a task spawned for it.
pub(super) struct DrainGuard {
    pub(super) app: Option<AppHandle>,
    pub(super) agent_id: String,
    pub(super) armed: bool,
    /// A batch was taken off the queue since this worker started: anything
    /// queued now is newer, so a fresh worker is worth starting for it.
    pub(super) progressed: bool,
}

pub(super) const PANIC_LINE: &str =
    "Something went wrong running this agent, so that turn didn't finish. Send your message again.";

impl Drop for DrainGuard {
    fn drop(&mut self) {
        // A worker dropped without panicking is the runtime shutting down
        // (the app quitting): its mark stays for the next launch to report.
        if !self.armed || !std::thread::panicking() || QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let reset = reset_after_panic(&self.agent_id, self.progressed);
        if let Some(app) = self.app.clone() {
            let agent_id = self.agent_id.clone();
            tauri::async_runtime::spawn(
                async move { after_panic_or_release(&app, &agent_id, reset) },
            );
        }
    }
}

/// What a panicked worker left, after its runtime was reset.
pub(super) struct PanicReset {
    pub(super) owed: Vec<AgentRef>,
    pub(super) tickets: Vec<String>,
    /// Messages are still queued and a new worker was claimed for them.
    pub(super) restart: bool,
    /// The dead turn's hop, from before the reset: word to its delegators
    /// travels one further, and not past [`MAX_HOPS`].
    pub(super) hop: u8,
    /// Queued messages dropped with it (it died before taking them), whose
    /// senders are told.
    pub(super) dropped: Vec<Inbound>,
    /// The room the dead turn was answering in: it hears the ask won't be.
    pub(super) room: Option<String>,
}

/// Drain the agent's queue, one turn at a time, until it is empty. A panic
/// anywhere in it is caught and handled as a failed turn, never left as an
/// agent "working" forever with every later message queued behind nothing.
pub(super) async fn drain(app: AppHandle, agent_id: String) {
    use futures_util::FutureExt;
    let mut guard = DrainGuard {
        app: Some(app.clone()),
        agent_id: agent_id.clone(),
        armed: true,
        progressed: false,
    };
    let run = drain_turns(&app, &agent_id, &mut guard.progressed);
    let panicked = std::panic::AssertUnwindSafe(run)
        .catch_unwind()
        .await
        .is_err();
    end_drain(&mut guard, panicked, |reset| {
        after_panic(&app, &agent_id, reset)
    });
}

pub(super) async fn drain_turns(app: &AppHandle, agent_id: &str, progressed: &mut bool) {
    let app = app.clone();
    let agent_id = agent_id.to_string();
    // What the last run left for this agent is dealt with first.
    wait_for_recovery(&agent_id).await;
    loop {
        if let Some(idle) = finish_if_idle(&agent_id) {
            set_status(&app, &agent_id, Status::idle());
            // Stale dependency and build folders in its home go (`disk`).
            super::disk::after_idle(&agent_id);
            // An interrupted turn whose replacement never ran (stopped).
            for to in &idle.owed {
                tell_couldnt_finish(
                    &app,
                    &agent_id,
                    to,
                    "it was stopped before it finished.",
                    idle.hop,
                );
            }
            if !idle.tickets.is_empty() {
                super::runs::turn_ended(&app, &agent_id, &idle.tickets, Some("Stopped"), None);
            }
            return;
        }
        set_queued(&agent_id, true);
        let permit = wait_for_slot(&app, &agent_id).await;
        set_queued(&agent_id, false);
        // No slot: the wait was stopped. Whatever arrived since is decided again.
        let Some(_permit) = permit else { continue };
        let Some(batch) = take_batch(&agent_id) else {
            continue;
        };
        *progressed = true;
        let Batch {
            prompt,
            routine,
            resume,
            request,
            user_said,
            room,
            conversation,
        } = batch;
        // Its conversation's session, loaded before anything reads the
        // agent's session for this turn (`conversations::swap`).
        if let Some(to) = conversation.as_deref() {
            load_conversation(&app, &agent_id, to);
        }
        let room_ref = room.as_ref().map(|r| r.room.clone());
        let prompt = match room {
            // A room deleted while this waited: nothing to answer, nowhere to say it.
            Some(r) => match super::rooms::prompt(&agent_id, &r.room, &r.asked) {
                Some(text) => format!("{}{text}", r.preamble),
                None => {
                    clear_mark(&agent_id);
                    clear_room(&agent_id);
                    continue;
                }
            },
            None => prompt,
        };
        // A bound agent works in its own copy of its project (`task`): the
        // open one, or one made now. Refused (too many copies, no disk) is
        // the turn's failure; it never falls back to the user's folder.
        let prepared = super::task::prepare(&app, &agent_id, &request).await;
        let made = match &prepared {
            Ok(Some((copy, true))) => Some(copy.clone()),
            _ => None,
        };
        // Where it works, as it stood before the turn touched it. On disk
        // too, so a turn cut short by a quit still gets its card.
        let start = match &prepared {
            Ok(_) => turn_start(&agent_id).await,
            Err(_) => None,
        };
        if let Some((project, tree)) = &start {
            update_mark(&agent_id, |m| {
                m.project = Some(project.to_string_lossy().into_owned());
                m.tree = Some(tree.clone());
            });
        }
        let since = store::now_ms();
        super::work::begin(&agent_id, since);
        // A bound agent works in its project (its copy is the project's).
        let current = store::get(&agent_id).ok();
        let bound = current.as_ref().and_then(|a| a.project.clone());
        super::workplace::begin(&agent_id, bound.as_deref().map(std::path::Path::new));
        // What its conversation read outside stays with that conversation.
        let resumes = current.as_ref().and_then(|a| a.session_id.as_deref());
        // Outside text it was asked to answer (a "When…" routine's items,
        // someone else's Slack message) is read just as surely as a web page,
        // and stays in this conversation after the capped turn ends.
        // A fork of a session that read outside content carries it (`rewind`).
        let forked_outside = current.as_ref().is_some_and(|a| {
            super::rewind::carries_outside(
                &agent_id,
                super::conversations::loaded(a),
                resumes.is_some(),
            )
        });
        super::exposure::begin_turn(
            &agent_id,
            resumes,
            batch_outside(&agent_id) || forked_outside,
        );
        super::full_send::begin(&agent_id);
        super::results::discard(&agent_id);
        super::dev_servers::begin(&agent_id);
        if let Some(copy) = &made {
            let label = format!(
                "Started a copy of {}",
                super::project::folder_name(&copy.project)
            );
            super::work::on_step(&agent_id, super::work::StepKind::Project, &label, since);
        }
        let result = match prepared {
            Ok(_) => run_on_accounts(&app, &agent_id, &prompt, routine, resume).await,
            Err(e) => Err(e),
        };
        // An engine that died is picked up inside (`run_on_accounts`); one
        // that died again is a failure like any other, said as interrupted.
        let result = result.and_then(|ended| match ended {
            Ended::Died(text) => Err(CommandError::expected(text)),
            ended => Ok(ended),
        });
        if QUITTING.load(Ordering::SeqCst) {
            // The app is going: the mark stays, for the next launch to report.
            return;
        }
        clear_mark(&agent_id);
        // Nothing waits on its cards now: they close, rather than ask on.
        super::expiry::sweep_agent(&app, &agent_id, super::expiry::Moment::TurnEnded);
        // What the turn changed goes before its failure, so a failed turn still
        // ends on its error line (Retry and the sidebar's failure read the newest line).
        // Then its result card, if it shared one: on the change card when
        // there is one (one card, not two), otherwise as its own message.
        let mut shared = super::results::take(&agent_id);
        if let Some((project, from)) = start {
            shared = record_changes(&app, &agent_id, project, from, shared).await;
        }
        if let Some(mut card) = shared {
            card.ts = store::now_ms();
            let _ = record(&app, card);
        }
        // What "Full send" sent without asking, in one plain line.
        if let Some(line) = super::full_send::take_summary(&agent_id) {
            let _ = record_in_turn(&app, new_message(&agent_id, MessageKind::Note, line));
        }
        // A "Test it" run closes with its turn (a line if it never reported).
        super::preview_test::turn_ended(&app, &agent_id, since);
        // A copy made for a turn that changed nothing (a question) goes again.
        if let Some(copy) = &made {
            super::task::drop_if_unused(&app, &agent_id, copy).await;
        }
        // A turn that finished without a word (or left helpers behind) ends
        // on one line saying so, its timeline under it: never silence.
        let left = super::turn_end::take(&agent_id);
        if let (Some(left), Ok(Ended::Finished)) = (left, &result) {
            if let Some(line) = super::turn_end::closing_line(left, showed_since(&agent_id, since))
            {
                if let Ok(line) =
                    record_in_turn(&app, new_message(&agent_id, MessageKind::Note, line))
                {
                    super::work::anchor_on(&line);
                }
            }
        }
        // The error line (below) is the last thing a failed turn leaves, so
        // its timeline hangs under that; anything else's is settled now.
        if result.is_ok() {
            super::work::finish(&app, &agent_id, store::now_ms());
        }
        // How the scheduled runs it answered settle: `None` reads the turn's
        // own last line (an error, or not).
        let mut settle_as: Option<&str> = None;
        let finished = matches!(result, Ok(Ended::Finished));
        match result {
            // Made an error above.
            Ok(Ended::Died(_)) => {}
            Ok(Ended::Interrupted) => {
                // Its debts and scheduled runs carry over to the next turn.
                if let Some(room) = &room_ref {
                    super::rooms::turn_ended(&app, &agent_id, room, since, false, false);
                }
                clear_room(&agent_id);
                notify::turn_ended(&app, &agent_id);
                continue;
            }
            Ok(Ended::Stopped(note)) => {
                // Whoever delegated this hears it was stopped, rather than nothing.
                return_results(&app, &agent_id, since, Some(stopped_reason(note)));
                settle_as = Some(note.unwrap_or("Stopped"));
            }
            Ok(Ended::Finished) => {
                if room_ref.is_none() {
                    // Read before `return_results` takes what it owes.
                    let eligible = follow_up_eligible(&agent_id);
                    leave_labels_only_note(&agent_id, &user_said, since);
                    // "I'll run it next" and nothing ran: a follow-up (`follow_up`).
                    if let Some(note) =
                        super::follow_up::after_turn(&app, &agent_id, since, eligible)
                    {
                        add_nudge(&agent_id, &note);
                    }
                }
                return_results(&app, &agent_id, since, None)
            }
            Err(err) => {
                let engine = store::get(&agent_id).map(|a| a.engine).unwrap_or_default();
                // Cut off and not picked up: Continue, not Retry. Every
                // account of its engine out: the wallet's own line.
                let (text, failure) = match super::wallet::take_all_out(&agent_id) {
                    _ if take_cut_off(&agent_id) => {
                        (err.to_string(), super::failure::Failure::INTERRUPTED)
                    }
                    Some((line, resets_at)) => (
                        line,
                        super::failure::Failure {
                            kind: super::failure::FailureKind::UsageLimit,
                            resets_at,
                        },
                    ),
                    None => super::failure::describe_now(engine, &err.to_string()),
                };
                // Signed out: the plan reading kept belonged to a login that isn't here.
                if failure.kind == super::failure::FailureKind::SignedOut {
                    if let Some(from) = super::wallet::reading_from(engine) {
                        super::usage_plan::forget_reading(engine, &from);
                    }
                }
                if failure.kind == super::failure::FailureKind::SignedOut
                    && super::quota::clear(engine, store::now_ms())
                {
                    let _ = app.emit(EVENT_QUOTA, ());
                }
                let mut line = new_message(&agent_id, MessageKind::Error, text.clone());
                line.failure = Some(failure);
                // Nothing goes silent: a line the disk couldn't take is still
                // said, as an alert (desk and phone), with the disk as the why.
                if let Err(e) = record_in_turn(&app, line) {
                    let why = if super::is_disk_full(&e.to_string()) {
                        super::DISK_FULL_LINE.to_string()
                    } else {
                        text.clone()
                    };
                    notify::alert_user(&app, &agent_id, &why);
                }
                super::work::finish(&app, &agent_id, store::now_ms());
                return_results(&app, &agent_id, since, Some(text));
            }
        }
        // A scheduled run that failed is retried, or reported (`agents::runs`);
        // a turn that finished having only run routines is charged to them.
        let (spent, mixed) = take_turn_usage(&agent_id);
        let spent = (finished && !mixed).then_some(spent);
        let tickets = take_tickets(&agent_id);
        if !tickets.is_empty() {
            super::runs::turn_ended(&app, &agent_id, &tickets, settle_as, spent.as_ref());
        }
        // A room hears who the reply brought in next (its @mentions).
        if let Some(room) = &room_ref {
            let outside = from_outside(&agent_id);
            super::rooms::turn_ended(&app, &agent_id, room, since, finished, outside);
        }
        clear_room(&agent_id);
        notify::turn_ended(&app, &agent_id);
        // A long conversation is tidied now, between turns (`tidy`).
        maybe_tidy(&app, &agent_id, finished).await;
    }
}
