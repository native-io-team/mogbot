//! The user's controls over an agent's turns: take over and hand back, stop (and what that drops), start fresh, interrupt.

use super::*;

/// Pause the agent for the user to drive its session (see `takeover`).
pub fn claim_for_takeover(agent_id: &str) -> Result<(), Claim> {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .claim()
}

/// Whether the user is driving this agent's session.
pub fn driven(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.driven)
}

/// The session is the agent's again: what waited runs now, its turn told
/// `told` first. Only once the terminal's process is gone (`takeover`).
/// `drop_queue`: the agent is being deleted, so what waited goes too.
pub fn release_takeover(app: &AppHandle, agent_id: &str, told: Option<String>, drop_queue: bool) {
    let start = {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        match runtimes.get_mut(agent_id) {
            Some(r) => {
                let had = !r.queue.is_empty();
                let start = r.release(told, drop_queue);
                if drop_queue && had {
                    save_inbox(agent_id, &r.queue);
                }
                start
            }
            None => false,
        }
    };
    if start {
        start_worker(app, agent_id);
    }
}

/// The refusal for a change that would move the agent out of the session
/// the user is driving (its engine, or its project's folder).
pub fn driven_refusal(name: &str) -> CommandError {
    CommandError::expected(format!(
        "You're driving {name} in a terminal. Hand it back first, then change what it runs on or where it works."
    ))
}

/// Change an agent's settings, for the editor and the Chief's
/// `update_agent` alike. `moves_session` (a new engine or project) is
/// refused while the user drives it, and checked under the inbox lock a
/// take-over is claimed under, so the two can't interleave. An engine
/// switch also drops a preamble left for the old conversation.
pub fn update_settings<F: FnOnce(&mut store::Agent)>(
    agent_id: &str,
    moves_session: bool,
    change: F,
) -> Result<store::Agent, CommandError> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    if moves_session && runtimes.get(agent_id).is_some_and(|r| r.driven) {
        return Err(driven_refusal(&store::get(agent_id)?.name));
    }
    let mut switched = false;
    let updated = store::update(agent_id, |a| {
        let before = a.engine;
        change(a);
        switched = a.engine != before;
    })?;
    if switched {
        if let Some(r) = runtimes.get_mut(agent_id) {
            r.interrupted = None;
            r.interrupted_in = None;
        }
    }
    Ok(updated)
}

/// Stop the turn in progress and drop anything queued behind it. Nothing
/// dropped goes unanswered: another agent's request is told it was stopped
/// before it started, and a scheduled run settles as stopped.
pub fn stop(app: &AppHandle, agent_id: &str) -> bool {
    let (stopped, dropped) = stop_queue(agent_id, false);
    tell_dropped(app, agent_id, dropped, Dropped::Stopped);
    // Its cards are withdrawn: they wait through a turn ending or a restart
    // (`expiry::verdict`), but never past the user's Stop.
    super::expiry::sweep_agent(app, agent_id, super::expiry::Moment::Stopped);
    stopped
}

/// Stop only what this agent was doing for a room: what was asked of it
/// there and hasn't started is dropped, and a turn answering there is
/// stopped. Anything said to it elsewhere stays queued and runs next.
pub fn stop_in_room(agent_id: &str, room_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    let here = |m: &Inbound| m.room.as_ref().is_some_and(|r| r.room_id == room_id);
    let before = runtime.queue.len();
    runtime.queue.retain(|m| !here(m));
    let dropped = runtime.queue.len() < before;
    if dropped {
        save_inbox(agent_id, &runtime.queue);
    }
    let running_here = runtime.room.as_ref().is_some_and(|r| r.room_id == room_id);
    if running_here {
        if let Some(cancel) = &runtime.cancel {
            update_mark(agent_id, |m| m.stopped = true);
            runtime.interrupt = false;
            cancel.notify_one();
            return true;
        }
    }
    dropped
}

/// [`stop`] for an agent about to be deleted: from now on nothing more is
/// queued for it (`admit` refuses), so no turn starts while the delete waits
/// for the dying one. [`undelete`] if the delete then fails.
pub fn stop_for_delete(app: &AppHandle, agent_id: &str) -> bool {
    let (stopped, dropped) = stop_queue(agent_id, true);
    tell_dropped(app, agent_id, dropped, Dropped::Stopped);
    stopped
}

/// The delete [`stop_for_delete`] was for didn't happen: take messages again.
pub fn undelete(agent_id: &str) {
    if let Some(r) = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(agent_id)
    {
        r.deleting = false;
    }
}

/// [`stop`]'s part under the lock: what it dropped, and whether a turn (or
/// a wait for a slot) was told to stop. `deleting` also closes the queue.
pub(super) fn stop_queue(agent_id: &str, deleting: bool) -> (bool, Vec<Inbound>) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    if deleting {
        runtimes.entry(agent_id.to_string()).or_default().deleting = true;
    }
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return (false, Vec::new());
    };
    let dropped: Vec<Inbound> = runtime.queue.drain(..).collect();
    save_inbox(agent_id, &runtime.queue);
    runtime.interrupt = false;
    let stopped = match &runtime.cancel {
        Some(cancel) => {
            // Should the app go before the turn ends: never picked up.
            update_mark(agent_id, |m| m.stopped = true);
            cancel.notify_one();
            true
        }
        None => false,
    };
    (stopped, dropped)
}

/// Who is owed word about messages a Stop dropped before they started:
/// each agent that asked (once each, not for its own replies), and each
/// scheduled run.
pub(super) fn dropped_debts(dropped: &[Inbound]) -> (Vec<(AgentRef, u8)>, Vec<String>) {
    let mut askers: Vec<(AgentRef, u8)> = Vec::new();
    for m in dropped {
        if let (From::Agent { sender, hop }, false) = (&m.from, m.reply) {
            if !askers.iter().any(|(a, _)| a.id == sender.id) {
                askers.push((sender.clone(), *hop));
            }
        }
    }
    let tickets = dropped.iter().filter_map(|m| m.ticket.clone()).collect();
    (askers, tickets)
}

/// The rooms `dropped` asked in, each once, in order.
pub(super) fn rooms_asking(dropped: &[Inbound]) -> Vec<String> {
    let mut rooms: Vec<String> = Vec::new();
    for m in dropped {
        if let Some(r) = &m.room {
            if !rooms.contains(&r.room_id) {
                rooms.push(r.room_id.clone());
            }
        }
    }
    rooms
}

/// The room's line for an ask of `name` that was dropped before it started.
pub(super) fn dropped_in_room_line(name: &str, why: Dropped) -> String {
    match why {
        Dropped::Stopped => format!("{name} was stopped before answering."),
        Dropped::Deleting => format!("{name} is being deleted, so it won't answer."),
        Dropped::Failed => {
            format!("{name} couldn't start on this: something went wrong running it.")
        }
    }
}

/// Why messages left the queue without a turn taking them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Dropped {
    /// The user stopped the agent.
    Stopped,
    /// The agent is being deleted.
    Deleting,
    /// Its worker died (a panic) before taking them.
    Failed,
}

pub(super) fn tell_dropped(app: &AppHandle, agent_id: &str, dropped: Vec<Inbound>, why: Dropped) {
    // A room that asked hears it won't be answered, once per room.
    let rooms = rooms_asking(&dropped);
    if !rooms.is_empty() {
        let name = store::get(agent_id).map(|a| a.name).unwrap_or_default();
        let text = dropped_in_room_line(&name, why);
        for room in rooms {
            super::rooms::say(app, &room, text.clone());
        }
    }
    let (askers, tickets) = dropped_debts(&dropped);
    if !tickets.is_empty() {
        // A failure settles as the turn's error line says (retried or reported).
        let settle_as = (why != Dropped::Failed).then_some("Stopped");
        super::runs::turn_ended(app, agent_id, &tickets, settle_as, None);
    }
    if askers.is_empty() {
        return;
    }
    let Ok(me) = store::get(agent_id) else { return };
    let text = match why {
        Dropped::Stopped => format!("{} was stopped before it started on your request.", me.name),
        Dropped::Deleting => format!(
            "{} is being deleted, so it won't take your request.",
            me.name
        ),
        Dropped::Failed => format!(
            "{} couldn't start on your request: something went wrong running it.",
            me.name
        ),
    };
    let sender = AgentRef {
        id: me.id.clone(),
        name: me.name.clone(),
    };
    for (to, hop) in askers {
        give_answer(app, &to, &sender, text.clone(), hop, false);
    }
}

/// After a Stop: wait (at most `bound`) for the agent's worker to finish,
/// so what the dying turn records lands before, say, its folder is deleted.
pub async fn wait_until_idle(agent_id: &str, bound: Duration) -> bool {
    let until = tokio::time::Instant::now() + bound;
    loop {
        if !is_working(agent_id) {
            return true;
        }
        if tokio::time::Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The agent is gone: so is what the runner kept for it.
pub fn forget(agent_id: &str) {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

/// The divider a fresh start leaves in the chat.
pub const FRESH_LINE: &str = "Started fresh · memory kept";

/// Start the agent's next turn in a new conversation on the same engine,
/// with its instructions and memory and no recap (`Agent::start_fresh`). The
/// chat stays, with a divider where the new conversation begins.
pub fn start_fresh(app: &AppHandle, agent_id: &str) -> Result<store::Agent, CommandError> {
    let (agent, line) = begin_fresh(agent_id)?;
    announce(app, line, false)?;
    Ok(agent)
}

/// `start_fresh` up to telling the UI: the refusals, the reset and the
/// divider in the log, all while no turn can start. The inbox lock is held
/// from the busy check to the divider, so a message sent meanwhile either
/// started first (and this is refused) or starts after, in the new
/// conversation: never a turn that read the old session and writes it back
/// under a divider saying it's gone. Two at once record one divider.
pub(super) fn begin_fresh(agent_id: &str) -> Result<(store::Agent, AgentMessage), CommandError> {
    begin_fresh_as(agent_id, FRESH_LINE, false)
}

/// [`begin_fresh`] with its divider's words. `worker`: asked by the agent's
/// own worker between turns (a tidy, `tidy`), which is the turn "running":
/// refused instead when anything is queued for it.
pub(super) fn begin_fresh_as(
    agent_id: &str,
    text: &str,
    worker: bool,
) -> Result<(store::Agent, AgentMessage), CommandError> {
    // Read before the inbox lock, which every agent's status waits on. A
    // card is only ever raised by a running turn, which the busy check
    // below refuses, so nothing can slip in between.
    let name = store::get(agent_id)?.name;
    let waiting_on_you = !store::pending_approvals(agent_id)?.is_empty();
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let mine = runtimes.get(agent_id);
    if mine.is_some_and(|r| r.driven) {
        return Err(CommandError::expected(format!(
            "You're driving {name} in a terminal. Hand it back first, then start fresh."
        )));
    }
    // A running or waiting turn is in the old conversation, and would record
    // it again when its session is confirmed.
    let busy = if worker {
        mine.is_some_and(|r| !r.queue.is_empty())
    } else {
        mine.is_some_and(|r| r.running || r.queued)
    };
    if busy {
        return Err(CommandError::expected(format!(
            "{name} is working. Start fresh once it's done, or stop it first."
        )));
    }
    // A card still waiting belongs to a turn in the old conversation.
    if waiting_on_you {
        return Err(CommandError::expected(format!(
            "{name} is waiting on your answer to a request. Answer it first, then start fresh."
        )));
    }
    // Another agent working on its request answers into the conversation
    // that asked: starting fresh now, the answer would arrive out of nowhere.
    if let Some(peer) = owes_reply(&runtimes, agent_id) {
        let peer = store::get(&peer).map_or_else(|_| "Another agent".to_string(), |p| p.name);
        return Err(CommandError::expected(format!(
            "{peer} is still working on something {name} asked for. Start fresh once it has answered."
        )));
    }
    let mut had = true;
    let agent = store::update(agent_id, |a| {
        had = a.has_conversation();
        if had {
            a.start_fresh();
        }
    })?;
    if !had {
        return Err(CommandError::expected(format!(
            "{name}'s next message already starts a new conversation."
        )));
    }
    // Whatever the next turn was to be told first (an interruption, a
    // hand-back) was about the conversation just left.
    if let Some(r) = runtimes.get_mut(agent_id) {
        r.interrupted = None;
        r.interrupted_in = None;
        r.nudge = None;
    }
    // Nor does what it read outside.
    super::exposure::forget(agent_id);
    let mut line = new_message(agent_id, MessageKind::Note, text);
    line.fresh = true;
    store::append_message(&line)?;
    drop(runtimes);
    Ok((agent, line))
}

/// Another agent with a request from `agent_id` it hasn't answered yet:
/// working on it (owed), or not started on it (queued).
pub(super) fn owes_reply(runtimes: &HashMap<String, Runtime>, agent_id: &str) -> Option<String> {
    runtimes.iter().find_map(|(id, r)| {
        let asked = r.owed.iter().any(|a| a.id == agent_id)
            || r.queue.iter().any(|m| {
                !m.reply && matches!(&m.from, From::Agent { sender, .. } if sender.id == agent_id)
            });
        (id != agent_id && asked).then(|| id.clone())
    })
}

/// Stop the turn in progress so what's queued in the agent's own chat runs
/// now, as the next turn: it is moved ahead of anything waiting for a room,
/// so the message the user interrupted for is the one answered. That turn
/// is told what it was doing when it was cut off, if it was doing it in the
/// same chat. Nothing queued there, nothing to interrupt for: false.
pub fn interrupt(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    if !runtime.running || !put_first(&mut runtime.queue, None) {
        return false;
    }
    let Some(cancel) = runtime.cancel.clone() else {
        return false;
    };
    save_inbox(agent_id, &runtime.queue);
    runtime.interrupt = true;
    cancel.notify_one();
    true
}

/// The app's own quiet turn (a memory tidy, a compaction) gives way: it is
/// cut off as an interruption, which a quiet turn takes without a line, and
/// the tidy tries again after the next turn. False when the turn in progress
/// isn't the app's own: that one is the user's work, and isn't cut off.
pub fn give_way_if_quiet(agent_id: &str) -> bool {
    if !super::tidy::is_quiet(agent_id) {
        return false;
    }
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    let Some(cancel) = runtime.cancel.clone().filter(|_| runtime.running) else {
        return false;
    };
    runtime.interrupt = true;
    cancel.notify_one();
    true
}

/// Whether the agent is only tidying between turns: its own quiet turn, or
/// the moment between the tidy's two steps (its status still says so).
pub fn only_tidying(agent_id: &str) -> bool {
    if super::tidy::is_quiet(agent_id) {
        return true;
    }
    let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes.get(agent_id).is_some_and(|r| {
        r.running
            && r.status
                .as_ref()
                .and_then(|s| s.activity.as_deref())
                .is_some_and(|a| a == super::tidy::ACTIVITY)
    })
}

/// Keep or Discard while the agent only tidies: the tidy gives way and this
/// waits (at most `bound`) for the turn to end. True once nothing runs.
pub async fn clear_tidy(agent_id: &str, bound: Duration) -> bool {
    let until = tokio::time::Instant::now() + bound;
    loop {
        if !in_turn(agent_id) {
            return true;
        }
        if !only_tidying(agent_id) || tokio::time::Instant::now() >= until {
            return false;
        }
        give_way_if_quiet(agent_id);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Move what was said in `place` (a room's id, or `None` for the agent's own
/// chat) ahead of the rest, each side keeping its order. False when nothing
/// queued was said there.
pub(super) fn put_first(queue: &mut VecDeque<Inbound>, place: Option<&str>) -> bool {
    let here = |m: &Inbound| m.room.as_ref().map(|r| r.room_id.as_str()) == place;
    if !queue.iter().any(here) {
        return false;
    }
    let (mut first, rest): (VecDeque<Inbound>, VecDeque<Inbound>) =
        std::mem::take(queue).into_iter().partition(here);
    first.extend(rest);
    *queue = first;
    true
}

/// Called when a turn's cancel fired: whether it was an interruption, and if
/// so, leave the next turn its preamble.
pub(super) fn take_interrupt(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    if !std::mem::take(&mut runtime.interrupt) {
        return false;
    }
    let activity = runtime.status.as_ref().and_then(|s| s.activity.clone());
    let was = runtime.prompt.as_deref().unwrap_or("");
    // A room turn's prompt is what it was asked there, quoted under the
    // app's headers (`rooms::asks`): its note says so, and never that the
    // user sent it.
    runtime.interrupted = Some(match runtime.room {
        Some(_) => prompts::interrupted_in_room(was, activity.as_deref()),
        None => prompts::interrupted(was, activity.as_deref()),
    });
    runtime.interrupted_in = place_of(runtime.room.as_ref(), runtime.conversation.as_deref());
    true
}

/// An interruption that came after the turn's reply was complete: nothing
/// was cut off, so the next turn isn't told it was.
pub(super) fn forget_interrupt(agent_id: &str) {
    if let Some(r) = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(agent_id)
    {
        r.interrupt = false;
    }
}

/// Forget what [`take_interrupt`] left for the next turn.
pub(super) fn clear_interrupted(agent_id: &str) {
    if let Some(r) = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(agent_id)
    {
        r.interrupted = None;
        r.interrupted_in = None;
    }
}
