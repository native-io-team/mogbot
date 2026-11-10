//! When a worker panics mid-turn: reset it, say so, and pick the turn up or let its delegators know.

use super::*;

/// [`after_panic`], from the guard's task: if it panics again, at least
/// the new worker it claimed is released, so the next message starts one.
pub(super) fn after_panic_or_release(app: &AppHandle, agent_id: &str, reset: PanicReset) {
    let restart = reset.restart;
    let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        after_panic(app, agent_id, reset)
    }));
    if handled.is_err() && restart {
        if let Some(r) = RUNTIMES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(agent_id)
        {
            r.running = false;
        }
    }
}

/// Reset a worker that panicked: in memory only (no I/O), so it is safe
/// to call while unwinding. The queue's file is brought in line by
/// [`after_panic`].
pub(super) fn reset_after_panic(agent_id: &str, progressed: bool) -> PanicReset {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    runtime.queued = false;
    runtime.cancel = None;
    runtime.interrupt = false;
    runtime.interrupted = None;
    runtime.interrupted_in = None;
    let hop = std::mem::take(&mut runtime.hop);
    runtime.origin = None;
    runtime.prompt = None;
    runtime.waits = 0;
    runtime.turn_usage = super::usage::UsageTotals::default();
    runtime.turn_mixed = false;
    runtime.outside = false;
    runtime.typed = None;
    runtime.user_asked = false;
    runtime.noted = false;
    runtime.agent_in = false;
    runtime.user_text.clear();
    // What is recorded from now on is the agent's own, not the dead turn's room's.
    let room = runtime.room.take().map(|r| r.room_id);
    runtime.status = Some(Status::idle());
    // Messages that arrived during the dead turn are newer than what killed
    // it: a new worker sends them (or the hand-back does, while someone
    // drives it). If it died before taking anything, they are what killed
    // it, and are dropped (the error line says to resend; agents that asked
    // are told).
    let keep = progressed && !runtime.queue.is_empty();
    let dropped = if keep {
        Vec::new()
    } else {
        runtime.queue.drain(..).collect()
    };
    let restart = keep && !runtime.driven;
    runtime.running = restart;
    PanicReset {
        owed: std::mem::take(&mut runtime.owed),
        tickets: std::mem::take(&mut runtime.tickets),
        restart,
        hop,
        dropped,
        room,
    }
}

/// A turn panicked: handled like a turn a crash cut off, after unwinding is
/// over. Its mark is still there, so what it had done is kept (the reply it
/// was writing, its changes, its timeline) and it is picked up once in the
/// same conversation, exactly as a launch picks up a turn the app quit
/// during ([`plan_recovery_for`]). Panicking again (or one that can't be
/// picked up) ends on an Interrupted line with Continue. A worker with no
/// turn in flight (it died before taking its messages, or after its turn
/// ended) gets the plain failed-turn line, and what is still queued a new
/// worker.
pub(super) fn after_panic(app: &AppHandle, agent_id: &str, reset: PanicReset) {
    let driven = {
        let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let empty = VecDeque::new();
        let queue = runtimes.get(agent_id).map_or(&empty, |r| &r.queue);
        save_inbox(agent_id, queue);
        runtimes.get(agent_id).is_some_and(|r| r.driven)
    };
    set_status(app, agent_id, Status::idle());
    // Working out the pick-up reads files; should that panic too, the turn
    // just gets the plain line.
    let planned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        plan_after_panic(agent_id, driven, |e, s| {
            super::transcript::resumable(agent_id, e, s)
        })
    }))
    .unwrap_or_else(|_| {
        tracing::error!("[Agents] picking up {agent_id}'s panicked turn panicked too");
        None
    });
    let Some(planned) = planned else {
        clear_mark(agent_id);
        return failed_after_panic(app, agent_id, reset);
    };
    // Nothing else starts a turn in that conversation while the leftover
    // process is stopped and the lines are written: the worker is claimed
    // now, and started once that is done.
    let claimed = reset.restart || claim_idle_worker(agent_id);
    let app = app.clone();
    let agent_id = agent_id.to_string();
    tauri::async_runtime::spawn(async move {
        use futures_util::FutureExt;
        let done =
            std::panic::AssertUnwindSafe(pick_up_after_panic(&app, &agent_id, planned, reset))
                .catch_unwind()
                .await;
        if done.is_err() {
            tracing::error!("[Agents] picking up {agent_id}'s panicked turn panicked too");
        }
        if claimed {
            start_worker(&app, &agent_id);
        } else {
            kick(&app, &agent_id);
        }
    });
}

/// A panicked turn's recovery, worked out: [`plan_recovery_for`] on its
/// mark (read and removed; a pick-up queued first), and its engine process
/// if it is still this run's. `None` without a mark.
pub(super) fn plan_after_panic(
    agent_id: &str,
    driven: bool,
    session_on_disk: impl Fn(Engine, &str) -> bool,
) -> Option<(Recovery, Option<u32>)> {
    let mark = read_mark(agent_id)?;
    // Only a process this run spawned for this agent (pids get reused).
    let pid = mark.pid.filter(|pid| procs::pid_of(agent_id) == Some(*pid));
    let plan = plan_recovery_for(agent_id, &[], driven, session_on_disk, Cause::Panic);
    plan.pickup.is_some().then_some((plan, pid))
}

/// Claim a worker for an agent with messages queued and none running
/// (what [`kick`] does, without starting it yet).
pub(super) fn claim_idle_worker(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes.get_mut(agent_id).is_some_and(|r| {
        let idle_with_work = !r.running && !r.driven && !r.queue.is_empty();
        if idle_with_work {
            r.running = true;
        }
        idle_with_work
    })
}

/// Lines and debts of a panicked turn that had a mark, in the order a turn
/// that ends leaves them: what it had said, its changes, the line saying
/// what became of it (its timeline under that). Picked up, its delegators
/// and scheduled runs carry over to the turn that carries it on; otherwise
/// they hear it didn't finish.
pub(super) async fn pick_up_after_panic(
    app: &AppHandle,
    agent_id: &str,
    (plan, pid): (Recovery, Option<u32>),
    reset: PanicReset,
) {
    // Its process group may outlive it (the engine's own children): stopped
    // before anything carries on in its conversation.
    if let Some(pid) = pid {
        let _ = tokio::task::spawn_blocking(move || procs::kill_tree_sync(pid)).await;
        procs::unregister(agent_id);
    }
    if let Some(reply) = plan.partial {
        // The reply it was writing may be what panicked: kept if it can be.
        let kept = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| record(app, reply)));
        if kept.is_err() {
            tracing::error!("[Agents] {agent_id}'s cut-off reply couldn't be kept");
        }
    }
    if let Some((project, tree)) = plan.changes {
        record_changes(app, agent_id, project.into(), tree, None).await;
    }
    if let Some(line) = recovery_line(agent_id, plan.pickup.as_ref(), Cause::Panic) {
        let _ = record(app, line);
    }
    super::work::finish(app, agent_id, store::now_ms());
    settle_after_panic(app, agent_id, plan.pickup.as_ref(), reset);
}

/// Who a panicked turn owed, and the scheduled runs it answered: carried
/// over to the turn that picks it up (its messages name the same askers),
/// or told it didn't finish.
pub(super) fn settle_after_panic(
    app: &AppHandle,
    agent_id: &str,
    pickup: Option<&Pickup>,
    reset: PanicReset,
) {
    if pickup == Some(&Pickup::Resume) {
        carry_over(agent_id, reset.owed, reset.tickets);
        tell_dropped(app, agent_id, reset.dropped, Dropped::Failed);
        return;
    }
    let (why, settle_as) = match pickup {
        Some(Pickup::Stopped) => ("it was stopped before it finished.", Some("Stopped")),
        _ => ("something went wrong running it.", None),
    };
    if let Some(room) = &reset.room {
        super::rooms::say(app, room, panicked_in_room_line(agent_id));
    }
    for to in &reset.owed {
        tell_couldnt_finish(app, agent_id, to, why, reset.hop);
    }
    if !reset.tickets.is_empty() {
        super::runs::turn_ended(app, agent_id, &reset.tickets, settle_as, None);
    }
    tell_dropped(app, agent_id, reset.dropped, Dropped::Failed);
}

/// Put a cut-off turn's debts and scheduled runs back on its agent, for the
/// turn that picks it up to settle.
pub(super) fn carry_over(agent_id: &str, owed: Vec<AgentRef>, tickets: Vec<String>) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    for to in owed {
        if !runtime.owed.iter().any(|a| a.id == to.id) {
            runtime.owed.push(to);
        }
    }
    for ticket in tickets {
        if !runtime.tickets.contains(&ticket) {
            runtime.tickets.push(ticket);
        }
    }
}

/// A worker that panicked with no turn in flight: handled like any failed
/// turn. The chat says it didn't finish, delegators and scheduled runs hear
/// so, and what is still queued gets a new worker.
pub(super) fn failed_after_panic(app: &AppHandle, agent_id: &str, reset: PanicReset) {
    let mut line = new_message(agent_id, MessageKind::Error, PANIC_LINE);
    line.failure = Some(super::failure::Failure::OTHER);
    let _ = record(app, line);
    super::work::finish(app, agent_id, store::now_ms());
    // A room it was answering in is told, so the ask doesn't just vanish.
    if let Some(room) = &reset.room {
        super::rooms::say(app, room, panicked_in_room_line(agent_id));
    }
    for to in &reset.owed {
        tell_couldnt_finish(
            app,
            agent_id,
            to,
            "something went wrong running it.",
            reset.hop,
        );
    }
    if !reset.tickets.is_empty() {
        super::runs::turn_ended(app, agent_id, &reset.tickets, None, None);
    }
    tell_dropped(app, agent_id, reset.dropped, Dropped::Failed);
    if reset.restart {
        start_worker(app, agent_id);
    }
}

/// How a worker's run ended, once [`drain`] has caught any panic in it:
/// `panicked` is handled by `cleanup` (normally [`after_panic`]). The guard
/// stays armed while it runs, so a panic in the handling itself still
/// resets the agent, without aborting the app.
pub(super) fn end_drain(guard: &mut DrainGuard, panicked: bool, cleanup: impl FnOnce(PanicReset)) {
    if !panicked || QUITTING.load(Ordering::SeqCst) {
        guard.armed = false;
        return;
    }
    tracing::error!("[Agents] {}'s turn panicked; resetting it", guard.agent_id);
    let reset = reset_after_panic(&guard.agent_id, guard.progressed);
    cleanup(reset);
    guard.armed = false;
}
