//! Between and after turns: tidying a long conversation, usage, room and follow-up bookkeeping, answers owed to delegators, and the changed-files card.

use super::*;

/// Whether anything is queued for the agent.
pub(super) fn has_queue(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| !r.queue.is_empty())
}

/// After a turn: tidy the conversation if its reading says so and nothing
/// needs the agent first (`tidy::between_turns`).
pub(super) async fn maybe_tidy(app: &AppHandle, agent_id: &str, finished: bool) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let Ok(agent) = store::get(agent_id) else {
        return;
    };
    if !super::tidy::due(agent.context.as_ref()) {
        return;
    }
    let moment = super::tidy::Moment {
        finished,
        queued: has_queue(agent_id),
        waiting_on_user: store::pending_approvals(agent_id).map_or(true, |p| !p.is_empty()),
        driven: driven(agent_id),
        outside: from_outside(agent_id),
        in_users_folder: agent.project.is_some() && super::task::active(&agent).is_none(),
    };
    if !super::tidy::between_turns(moment) {
        return;
    }
    tidy(app, agent_id, &agent).await;
    // Its cost is the agent's, never a routine's.
    let _ = take_turn_usage(agent_id);
    set_status(app, agent_id, Status::idle());
}

/// Tidy the agent's conversation: memory first, then the engine compacts, or
/// (when it can't) the next message starts fresh. Either way one quiet line.
pub(super) async fn tidy(app: &AppHandle, agent_id: &str, agent: &store::Agent) {
    use super::tidy::{QuietTurn, Way};
    let Some(binary) = super::engine::binary(agent.engine).await else {
        return;
    };
    let way = super::tidy::way(Driver::pick(agent.engine, &binary).await);
    let Ok(home) = store::agent_home(agent_id) else {
        return;
    };
    let claude_md = home.join("CLAUDE.md").to_string_lossy().into_owned();
    tracing::info!("[Agents] tidying {agent_id}'s conversation ({way:?})");
    let working = |activity: &str| Status {
        state: "working",
        activity: Some(activity.to_string()),
        since: Some(store::now_ms()),
        work: None,
        room: None,
    };
    set_status(app, agent_id, working(super::tidy::ACTIVITY));
    let memory = {
        let _quiet = QuietTurn::begin(agent_id, false);
        let prompt = super::tidy::memory_prompt(&claude_md, way == Way::Fresh);
        run_on_accounts(app, agent_id, &prompt, false, 0).await
    };
    clear_mark(agent_id);
    if !matches!(memory, Ok(Ended::Finished)) {
        tracing::warn!(
            "[Agents] {agent_id}'s memory update before a tidy didn't finish; left as it was"
        );
        return;
    }
    // What arrived meanwhile goes first; the next turn's end tries again.
    if has_queue(agent_id) || QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let mut fresh = way == Way::Fresh;
    if !fresh {
        set_status(app, agent_id, working(super::tidy::ACTIVITY));
        let quiet = QuietTurn::begin(agent_id, true);
        let prompt = match agent.engine {
            Engine::Claude => super::tidy::claude_compact_prompt(),
            // Codex is asked with `thread/compact/start`, not a prompt;
            // OpenCode tidies by starting fresh (`tidy::way`).
            Engine::Codex | Engine::OpenCode => String::new(),
        };
        let result = run_on_accounts(app, agent_id, &prompt, false, 0).await;
        let compacted = quiet.compacted();
        drop(quiet);
        clear_mark(agent_id);
        if matches!(result, Ok(Ended::Stopped(_) | Ended::Interrupted)) {
            return;
        }
        if !compacted {
            tracing::warn!(
                "[Agents] {agent_id}'s engine didn't compact ({result:?}); starting fresh instead"
            );
            fresh = true;
        }
    }
    if fresh {
        match begin_fresh_as(agent_id, super::tidy::LINE, true) {
            Ok((_, line)) => {
                let _ = announce(app, line, false);
            }
            Err(e) => tracing::info!("[Agents] {agent_id} not started fresh after its tidy: {e}"),
        }
        return;
    }
    // The reading was the conversation before it was summarised.
    store::update(agent_id, |a| a.context = None).or_log("an agent's cleared context reading");
    let _ = app.emit(EVENT_REGISTRY, ());
    let _ = record(
        app,
        new_message(agent_id, MessageKind::Note, super::tidy::LINE),
    );
}

/// The room's line for a member's turn there that was cut off for a message
/// in its own chat: the ask isn't answered, and the room is told so.
pub(super) fn interrupted_in_room_line(agent_id: &str) -> String {
    let name = store::get(agent_id).map(|a| a.name).unwrap_or_default();
    format!("{name} was interrupted for a message in its own chat, so it didn't answer here.")
}

/// The room's line for a member whose turn there panicked.
pub(super) fn panicked_in_room_line(agent_id: &str) -> String {
    let name = store::get(agent_id)
        .map(|a| a.name)
        .unwrap_or_else(|_| "a member".into());
    format!("Something went wrong running {name}, so it didn't answer here.")
}

/// The turn's room is over: what is recorded from now on is the agent's own.
pub(super) fn clear_room(agent_id: &str) {
    if let Some(r) = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(agent_id)
    {
        r.room = None;
    }
}

/// What the turn (and any it replaced) cost, and whether anything but a
/// routine was in it; reset for the next.
pub(super) fn take_turn_usage(agent_id: &str) -> (super::usage::UsageTotals, bool) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes
        .get_mut(agent_id)
        .map(|r| {
            (
                std::mem::take(&mut r.turn_usage),
                std::mem::take(&mut r.turn_mixed),
            )
        })
        .unwrap_or_default()
}

pub(super) fn add_turn_usage(agent_id: &str, turn: &super::usage::UsageTotals) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = runtimes.get_mut(agent_id) {
        r.turn_usage.add(turn);
    }
}

/// Tell one agent that delegated to `agent_id` that it couldn't finish.
/// `hop` is the turn's, read before its runtime was reset.
pub(super) fn tell_couldnt_finish(
    app: &AppHandle,
    agent_id: &str,
    to: &AgentRef,
    why: &str,
    hop: u8,
) {
    let Ok(me) = store::get(agent_id) else { return };
    let text = format!("{} couldn't finish: {why}", me.name);
    let sender = AgentRef {
        id: me.id.clone(),
        name: me.name.clone(),
    };
    give_answer(app, to, &sender, text, hop, false);
}

/// The user asked for text and the turn that just finished sent only files
/// with short labels: its next turn in this chat is told so, quietly
/// (`share_text`). Nothing is shown to the user.
/// The same for a reply that gave up instead of doing ("I have no Slack
/// tool", "they'd need to say yes", plumbing in the user's words): its next
/// turn is told what to do instead (`agency`).
/// Whether the turn that began at `since` put something in front of the
/// user other than notes: a reply, a result or change card, a card to
/// answer, an error, a message it sent.
pub(super) fn showed_since(agent_id: &str, since: i64) -> bool {
    store::messages(agent_id, 40)
        .unwrap_or_default()
        .iter()
        .any(|m| m.ts >= since && shows_user(m.kind))
}

pub(super) fn shows_user(kind: MessageKind) -> bool {
    !matches!(
        kind,
        MessageKind::User | MessageKind::Note | MessageKind::FromAgent
    )
}

pub(super) fn leave_labels_only_note(agent_id: &str, user_said: &str, since: i64) {
    let replies: Vec<AgentMessage> = store::messages(agent_id, 40)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.ts >= since)
        .collect();
    set_labels_only_note(agent_id, user_said, &replies);
}

pub(super) fn set_labels_only_note(agent_id: &str, user_said: &str, replies: &[AgentMessage]) {
    let labels = (!user_said.trim().is_empty())
        .then(|| super::share_text::labels_only_note(user_said, replies))
        .flatten();
    // The level this turn ran at: a turn answering outside text is capped,
    // and asks by design.
    let level = store::get(agent_id)
        .map(|a| super::policy::independence_for(&a, from_outside(agent_id)))
        .unwrap_or_default();
    let lazy = super::agency::lazy_reply_note(replies, level);
    let note: String = labels.into_iter().chain(lazy).collect();
    if note.is_empty() {
        return;
    }
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes.entry(agent_id.to_string()).or_default().nudge = Some(note);
}

/// The turn in progress may leave a follow-up (`follow_up`): it answered
/// the user or an agent's reply in its own chat, not a scheduled run (a
/// routine, a check-in, a follow-up: no loops), a room, outside text, or
/// another agent's request (its answer goes back to them).
pub(super) fn follow_up_eligible(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| {
            r.tickets.is_empty() && !r.outside && r.room.is_none() && r.owed.is_empty()
        })
}

/// Add a hidden note for the agent's next turn in its own chat, after any
/// already waiting.
pub(super) fn add_nudge(agent_id: &str, note: &str) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let r = runtimes.entry(agent_id.to_string()).or_default();
    r.nudge = Some(r.nudge.take().unwrap_or_default() + note);
}

pub(super) fn take_owed(agent_id: &str) -> Vec<AgentRef> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes
        .get_mut(agent_id)
        .map(|r| std::mem::take(&mut r.owed))
        .unwrap_or_default()
}

/// A turn that answered other agents' requests is over: what it said (or why
/// it couldn't finish) goes back to each of them, so delegated work always
/// reports back and the agent never has to spend a tool call on it.
pub(super) fn return_results(app: &AppHandle, agent_id: &str, since: i64, error: Option<String>) {
    let owed = take_owed(agent_id);
    if owed.is_empty() {
        return;
    }
    let hop = current_hop(agent_id);
    // A turn answering outside text passes the taint to whoever it answers.
    let outside = from_outside(agent_id);
    let Ok(me) = store::get(agent_id) else { return };
    let said: Vec<String> = store::messages(agent_id, 40)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.kind == MessageKind::Agent && m.ts >= since && !m.text.trim().is_empty())
        .map(|m| m.text)
        .collect();
    let text = match (error, said.is_empty()) {
        (Some(e), _) => format!("{} couldn't finish: {e}", me.name),
        (None, true) => format!("{} finished without saying anything.", me.name),
        (None, false) => said.join(
            "

",
        ),
    };
    let sender = AgentRef {
        id: me.id.clone(),
        name: me.name.clone(),
    };
    for to in owed {
        give_answer(app, &to, &sender, text.clone(), hop, outside);
    }
}

/// For a bound agent whose project is a git repository: where it works (its
/// copy, or the project itself) and a snapshot of that working tree, taken
/// before the turn starts.
pub(super) async fn turn_start(agent_id: &str) -> Option<(std::path::PathBuf, String)> {
    let agent = store::get(agent_id).ok()?;
    let dir = match super::task::active(&agent) {
        Some(copy) => std::path::PathBuf::from(&copy.path),
        None => std::path::PathBuf::from(agent.project?),
    };
    let tree = super::project::snapshot(&dir).await?;
    Some((dir, tree))
}

/// After the turn: if it changed files in the project, one card saying which.
/// Runs however the turn ended; edits made before a Stop are still made.
///
/// `result`: the turn's staged result card. It rides on the change card (with
/// the staged message's id, which its copied files are filed under) and
/// `None` comes back; with no change card it comes back to be recorded alone.
pub(super) async fn record_changes(
    app: &AppHandle,
    agent_id: &str,
    project: std::path::PathBuf,
    from: String,
    result: Option<AgentMessage>,
) -> Option<AgentMessage> {
    // In a copy, the card lists everything in the copy so far.
    let copy = store::get(agent_id)
        .ok()
        .and_then(|a| a.copy)
        .filter(|c| std::path::Path::new(&c.path) == project);
    let summary = match &copy {
        Some(copy) => super::task::record_turn(agent_id, copy, &from).await,
        None => super::project::summary(&project, &from).await,
    };
    let Some(summary) = summary else {
        return result;
    };
    let files = match summary.file_count {
        1 => "1 file".to_string(),
        n => format!("{n} files"),
    };
    let name = super::project::folder_name(&summary.project);
    let text = match copy {
        Some(_) => format!("Changed {files} in a copy of {name}"),
        None => format!("Changed {files} in {name}"),
    };
    let mut message = new_message(agent_id, MessageKind::Changes, text);
    message.changes = Some(summary);
    if let Some(card) = result {
        message = super::results::ride_on(message, card);
    }
    let _ = record(app, message);
    None
}
