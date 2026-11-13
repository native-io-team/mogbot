//! Picking up after the app restarts: what the last run left mid-turn or queued, and what becomes of it.

use super::*;

pub(super) fn take_inbox(agent_id: &str) -> Vec<Inbound> {
    let Ok(path) = store::agent_home(agent_id).map(|h| h.join("inbox.json")) else {
        return Vec::new();
    };
    // Damaged, it's set aside and the Chief told, rather than the messages
    // waiting in it vanishing with nothing said.
    let queued =
        super::survive::read_kept(&path, "Messages waiting for an agent").unwrap_or_default();
    let _ = std::fs::remove_file(path);
    queued
}

/// The note saying which waiting messages were sent again after a restart.
pub(super) fn resent_note(queued: &[Inbound]) -> String {
    let quoted: Vec<String> = queued
        .iter()
        .map(|m| {
            let first = m.text.lines().map(str::trim).find(|l| !l.is_empty());
            let mut line: String = first.unwrap_or("").chars().take(60).collect();
            if first.is_some_and(|l| l.chars().count() > 60) {
                line.push('…');
            }
            match &m.from {
                From::User | From::App => format!("“{line}”"),
                From::Agent { sender, .. } => format!("{}'s “{line}”", sender.name),
            }
        })
        .collect();
    let what = match queued.len() {
        1 => "the message".to_string(),
        n => format!("{n} messages"),
    };
    format!(
        "Sent {what} still waiting when the app closed: {}",
        quoted.join(", ")
    )
}

/// What the last run left behind, taken at launch before any turn can start:
/// the agents whose turn it cut off (a `turn.json`) or who had messages
/// waiting (an `inbox.json`), with those messages. `None` until taken.
pub(super) type Leftovers = HashMap<String, Vec<Inbound>>;
pub(super) static LEFTOVERS: LazyLock<Mutex<Option<Leftovers>>> =
    LazyLock::new(|| Mutex::new(None));
/// Woken each time one agent's leftovers have been dealt with.
pub(super) static RECOVERED: LazyLock<Notify> = LazyLock::new(Notify::new);

/// At launch, synchronously, before anything can start a turn: note which
/// agents the last run left mid-turn or with messages waiting. Their
/// waiting messages go back on their queues (and stay on disk), and their
/// turns hold until [`recover_after_restart`] has dealt with each, so
/// recovery never mistakes a turn started in this run for a leftover, and
/// never sends a message twice. Taken once; a second call does nothing.
pub fn prepare_recovery() {
    let mut leftovers = LEFTOVERS.lock().unwrap_or_else(|e| e.into_inner());
    if leftovers.is_some() {
        return;
    }
    let mut found = HashMap::new();
    for agent in store::list().unwrap_or_default() {
        let marked = mark_path(&agent.id).is_some_and(|p| p.exists())
            || super::takeover::left_over(&agent.id);
        let mut queued = take_inbox(&agent.id);
        for message in queued.iter_mut().filter(|m| m.id.is_empty()) {
            message.id = store::new_id();
        }
        if !marked && queued.is_empty() {
            continue;
        }
        if !queued.is_empty() {
            let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
            let runtime = runtimes.entry(agent.id.clone()).or_default();
            for (i, message) in queued.iter().enumerate() {
                runtime.queue.insert(i, message.clone());
            }
            // Still on disk, should the app close again before they're sent.
            save_inbox(&agent.id, &runtime.queue);
        }
        found.insert(agent.id, queued);
    }
    *leftovers = Some(found);
}

/// Whether `agent_id` still has leftovers from the last run to deal with.
pub(super) fn awaiting_recovery(agent_id: &str) -> bool {
    LEFTOVERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|l| l.contains_key(agent_id))
}

/// Hold a turn until the last run's leftovers for this agent are dealt with.
pub(super) async fn wait_for_recovery(agent_id: &str) {
    loop {
        let woken = RECOVERED.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        if !awaiting_recovery(agent_id) {
            return;
        }
        woken.await;
    }
}

/// This agent's leftovers are dealt with: its turns may start.
pub(super) fn recovered(agent_id: &str) {
    if let Some(l) = LEFTOVERS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        l.remove(agent_id);
    }
    RECOVERED.notify_waiters();
}

/// How long recovering one agent may take, and all of them: past either,
/// turns go ahead without it rather than wait on it forever.
pub(super) const RECOVER_ONE_BOUND: Duration = Duration::from_secs(45);
pub(super) const RECOVERY_BOUND: Duration = Duration::from_secs(150);

/// Holds turns back while recovery runs, and lets every one of them go
/// however recovery ends: finished, timed out, or panicked. Only a lock and
/// a wake-up in its drop, so it is safe while unwinding.
pub(super) struct RecoveryGate;

impl Drop for RecoveryGate {
    fn drop(&mut self) {
        if let Some(l) = LEFTOVERS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            l.clear();
        }
        RECOVERED.notify_waiters();
    }
}

/// At launch: a turn the last run left mid-flight is over. Its Claude Code
/// process can outlive the app (a quit doesn't run our cleanup), and would
/// keep writing the same session as the next turn, so it is stopped; and the
/// chat says the turn ended, instead of a message sitting there unanswered.
/// Only what [`prepare_recovery`] found is touched: nothing this run started.
pub async fn recover_after_restart(app: &AppHandle) {
    use futures_util::FutureExt;
    prepare_recovery();
    let found: Vec<(String, Vec<Inbound>)> = LEFTOVERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let gate = RecoveryGate;
    let each = async {
        for (agent_id, queued) in &found {
            let one =
                std::panic::AssertUnwindSafe(recover_one(app, agent_id, queued)).catch_unwind();
            match tokio::time::timeout(RECOVER_ONE_BOUND, one).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => tracing::error!("[Agents] recovering {agent_id} panicked"),
                Err(_) => tracing::warn!("[Agents] recovering {agent_id} timed out"),
            }
            recovered(agent_id);
            // Nothing has asked it to run since launch: send what was waiting.
            kick(app, agent_id);
        }
    };
    if tokio::time::timeout(RECOVERY_BOUND, each).await.is_err() {
        tracing::warn!("[Agents] recovery timed out; letting the remaining agents go");
    }
    // Whatever wasn't reached goes ahead now.
    drop(gate);
    for (agent_id, _) in &found {
        kick(app, agent_id);
    }
    // Copies whose folder went, or that no agent holds any more. After the
    // agents, so no turn waits behind every project's `git worktree` calls.
    super::task::sweep().await;
    sweep_attachments();
}

/// Folders copied for a result card that was staged when the app went
/// (staging is in memory). Two minutes' grace: a send racing this sweep
/// has its files copied before its message is written.
pub(super) fn sweep_attachments() {
    let Ok(agents) = store::list() else { return };
    let older_than = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    for agent in &agents {
        let Ok(home) = store::agent_home(&agent.id) else {
            continue;
        };
        if let Ok(log) = std::fs::read_to_string(home.join("messages.jsonl")) {
            let removed = super::attachments::sweep_unreferenced(&home, &log, older_than);
            if removed > 0 {
                tracing::info!(
                    "[Agents] removed {removed} unreferenced attachment folder(s) for {}",
                    agent.id
                );
            }
        }
    }
}

/// Start a worker for an agent with messages queued and none running.
pub(super) fn kick(app: &AppHandle, agent_id: &str) {
    let start = {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        runtimes.get_mut(agent_id).is_some_and(|r| {
            // Nobody driving it by hand either (`takeover`).
            let idle_with_work = !r.running && !r.driven && !r.queue.is_empty();
            if idle_with_work {
                r.running = true;
            }
            idle_with_work
        })
    };
    if start {
        let app = app.clone();
        let agent_id = agent_id.to_string();
        tauri::async_runtime::spawn(async move { drain(app, agent_id).await });
    }
}

/// One agent the last run left mid-turn, or with messages waiting.
pub(super) async fn recover_one(app: &AppHandle, agent_id: &str, found: &[Inbound]) {
    // Was the user driving it by hand? Read before the take-over's own
    // recovery below closes it: a turn is never picked up under them.
    let driven = super::takeover::left_over(agent_id);
    // A take-over's terminal the last run left behind, first: it is in the
    // session the queue below resumes.
    if let Ok(agent) = store::get(agent_id) {
        super::takeover::recover_after_restart(app, &agent).await;
    }
    // The cut-off turn's process, if it outlived the app: stopped before
    // anything carries on in its conversation.
    if let Some(mark) = mark_path(agent_id)
        .filter(|p| p.exists())
        .and_then(|_| read_mark(agent_id))
    {
        if let (Some(pid), false) = (mark.pid, mark.session.is_empty()) {
            stop_orphan(pid, &mark.session).await;
        }
    }
    let plan = plan_recovery(agent_id, found, driven, |e, s| {
        super::transcript::resumable(agent_id, e, s)
    });
    // Same order as a turn that ends: what it had said, its changes, then
    // the line that says what became of it (under which its timeline hangs).
    if let Some(reply) = plan.partial {
        let _ = record(app, reply);
    }
    if let Some((project, tree)) = plan.changes {
        record_changes(app, agent_id, project.into(), tree, None).await;
    }
    let line = recovery_line(agent_id, plan.pickup.as_ref(), Cause::Restart);
    if let Some(Ok(line)) = line.map(|l| record(app, l)) {
        if let Some(work) = plan.work {
            super::work::keep_under(app, &line, work, store::now_ms());
        }
    }
    // What was queued behind it was never started: it runs now, once (it is
    // already back on the queue), and the chat says which messages were sent
    // again: only those still queued, not any a Stop has dropped meanwhile.
    // A pick-up that never got to start goes again as a pick-up: its line.
    if plan.resent.iter().any(|m| m.resume > 0) {
        let _ = record(
            app,
            new_message(agent_id, MessageKind::Note, Cause::Restart.picked_up_line()),
        );
    }
    let resent: Vec<Inbound> = still_queued(agent_id, &plan.resent)
        .into_iter()
        .chain(still_queued(agent_id, found))
        .filter(|m| m.resume == 0)
        .collect();
    if !resent.is_empty() {
        let _ = record(
            app,
            new_message(agent_id, MessageKind::Note, resent_note(&resent)),
        );
    }
}

/// The line that says what became of a cut-off turn.
pub(super) fn recovery_line(
    agent_id: &str,
    pickup: Option<&Pickup>,
    cause: Cause,
) -> Option<AgentMessage> {
    match pickup? {
        // Carries on by itself: a quiet line, and the turn is queued first.
        Pickup::Resume => Some(new_message(
            agent_id,
            MessageKind::Note,
            cause.picked_up_line(),
        )),
        // The user stopped it as the app went: it ended, as they asked.
        Pickup::Stopped => Some(new_message(agent_id, MessageKind::Note, "Stopped")),
        // Not picked up by itself: Continue (never Retry: it may have done
        // half its work, and sending the request again could redo it).
        Pickup::Continue(text) => {
            let mut line = new_message(agent_id, MessageKind::Error, *text);
            line.failure = Some(super::failure::Failure::INTERRUPTED);
            Some(line)
        }
    }
}

/// Whether a cut-off turn is picked up by itself. Never when the user
/// stopped it or was driving it by hand, never in a room (its asks are
/// quoted fresh each turn), never twice, and never without its conversation
/// on disk: a blank session would see only the chat and could redo the work.
pub(super) fn pickup_after(
    mark: &TurnMark,
    driven: bool,
    session_found: bool,
    cause: Cause,
) -> Pickup {
    if mark.stopped {
        Pickup::Stopped
    } else if driven || mark.took.iter().any(|m| m.room.is_some()) {
        Pickup::Continue(cause.interrupted_line())
    } else if next_pickup_of(mark).is_none() {
        Pickup::Continue(cause.interrupted_line())
    } else if !session_found {
        Pickup::Continue(SESSION_GONE_LINE)
    } else {
        Pickup::Resume
    }
}

pub(super) fn plan_recovery(
    agent_id: &str,
    found: &[Inbound],
    driven: bool,
    session_on_disk: impl Fn(Engine, &str) -> bool,
) -> Recovery {
    plan_recovery_for(agent_id, found, driven, session_on_disk, Cause::Restart)
}

pub(super) fn plan_recovery_for(
    agent_id: &str,
    found: &[Inbound],
    driven: bool,
    session_on_disk: impl Fn(Engine, &str) -> bool,
    cause: Cause,
) -> Recovery {
    let Some(path) = mark_path(agent_id).filter(|p| p.exists()) else {
        return Recovery::default();
    };
    let mark = read_mark(agent_id).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    // A tidy the app was running: dropped (its process was already stopped).
    if mark.quiet {
        return Recovery::default();
    }
    let mut plan = Recovery {
        changes: mark.project.clone().zip(mark.tree.clone()),
        ..Recovery::default()
    };
    // One that never took them (the app went between its mark and the
    // dequeue) has nothing to pick up: its messages are sent again.
    if never_taken(&mark, found) {
        return plan;
    }
    // One that took them and went before its engine started: they're sent
    // again as they were, ahead of anything queued behind. Observed: a bound
    // agent's copy takes seconds to make, a relaunch in between left a mark
    // with no conversation, and the chat said it couldn't find one. Only
    // after a clean quit: a crash or panic while getting ready may be the
    // turn's own doing, and sending it again could crash again.
    if cause == Cause::Restart && mark.quit && never_spawned(&mark) {
        let again: Vec<Inbound> = mark
            .took
            .iter()
            .map(|m| Inbound {
                id: store::new_id(),
                ..m.clone()
            })
            .collect();
        requeue_first(agent_id, again.clone());
        plan.resent = again;
        return plan;
    }
    let progress = mark.progress.clone().unwrap_or_default();
    plan.partial = partial_reply(agent_id, progress.draft.as_ref());
    plan.work = progress.work;
    let agent = store::get(agent_id).ok();
    // Carrying on with the other engine (`crossover`): its turns, and so
    // the conversation cut off, are that engine's.
    let engine = agent
        .as_ref()
        .map(|a| a.away.as_ref().map_or(a.engine, |w| w.engine))
        .unwrap_or_default();
    // The conversation it was in, still the agent's (not started fresh
    // since), and really on disk.
    let session = mark.session_id.as_deref().filter(|sid| {
        agent.as_ref().is_some_and(|a| {
            super::crossover::session_on(a, engine)
                .as_deref()
                .is_none_or(|own| own == *sid)
        }) && session_on_disk(engine, sid)
    });
    let pickup = pickup_after(&mark, driven, session.is_some(), cause);
    if let (Pickup::Resume, Some(sid)) = (&pickup, session) {
        // Claude Code's first turn may have gone before it said its session.
        let sid = sid.to_string();
        store::update(agent_id, |a| {
            if super::crossover::session_on(a, engine).is_none() {
                super::crossover::save_session(a, engine, sid);
            }
        })
        .or_log("an agent's engine session");
        let resume = next_pickup_of(&mark).unwrap_or(MAX_RESUMES);
        requeue_first(
            agent_id,
            resume_inbounds(&mark.took, resume, prompts::carry_on(cause.why())),
        );
    }
    plan.pickup = Some(pickup);
    plan
}

/// The reply that was streaming when the turn was cut off, as a message
/// under the draft's own id (so it takes the place of what was on screen),
/// marked cut off. Nothing when it was already recorded whole.
pub(super) fn partial_reply(
    agent_id: &str,
    draft: Option<&(String, String)>,
) -> Option<AgentMessage> {
    let (id, text) = draft.filter(|(_, t)| !t.trim().is_empty())?;
    let recent = store::messages(agent_id, 50).unwrap_or_default();
    if recent.iter().any(|m| &m.id == id) {
        return None;
    }
    let mut message = new_message(agent_id, MessageKind::Agent, text.clone());
    message.id = id.clone();
    message.stopped = true;
    Some(message)
}

/// The messages that carry a cut-off turn on: the same askers, in the same
/// order (so delegators are still answered and a "When…" turn stays sealed),
/// with the pick-up note said once in place of what they asked, which is
/// already in the conversation. Scheduled runs aren't carried: the restart
/// closed them (`runs::after_restart`).
pub(super) fn resume_inbounds(took: &[Inbound], resume: u8, note: String) -> Vec<Inbound> {
    let mut out: Vec<Inbound> = took
        .iter()
        .map(|m| Inbound {
            id: store::new_id(),
            text: String::new(),
            ticket: None,
            resume,
            ..m.clone()
        })
        .collect();
    if out.is_empty() {
        out.push(Inbound {
            id: store::new_id(),
            text: String::new(),
            from: From::App,
            reply: false,
            routine: false,
            ticket: None,
            room: None,
            outside: false,
            resume,
            typed: None,
            conversation: None,
        });
    }
    out[0].text = note;
    out
}

/// Put messages at the front of the agent's queue (and on disk).
pub(super) fn requeue_first(agent_id: &str, messages: Vec<Inbound>) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    for (i, message) in messages.into_iter().enumerate() {
        runtime.queue.insert(i, message);
    }
    save_inbox(agent_id, &runtime.queue);
}

/// The cut-off turn never took its messages: every one it marked as its
/// batch was still in the inbox at launch. False for a mark without a batch
/// (written by an older version, or never got that far): say it didn't finish.
pub(super) fn never_taken(mark: &TurnMark, found: &[Inbound]) -> bool {
    !mark.batch.is_empty()
        && mark
            .batch
            .iter()
            .all(|id| found.iter().any(|m| !m.id.is_empty() && &m.id == id))
}

/// Of the messages recovery found, those still on the agent's queue.
pub(super) fn still_queued(agent_id: &str, found: &[Inbound]) -> Vec<Inbound> {
    let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(queue) = runtimes.get(agent_id).map(|r| &r.queue) else {
        return Vec::new();
    };
    found
        .iter()
        .filter(|m| queue.iter().any(|q| q.id == m.id))
        .cloned()
        .collect()
}

/// Stop `pid` only if it is still that turn's process: pids get reused, and
/// the session id on its command line is what identifies it.
pub(in crate::agents) async fn stop_orphan(pid: u32, session: &str) {
    if cfg!(windows) {
        return;
    }
    let mut ps = tokio::process::Command::new("ps");
    ps.args(["-o", "command=", "-p", &pid.to_string()]);
    let ours = crate::external_command::run_with_timeout(ps, "ps", 5)
        .await
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(session));
    if ours {
        tracing::warn!("[Agents] stopping turn {pid} left over from the last run");
        let _ = tokio::task::spawn_blocking(move || procs::kill_tree_sync(pid)).await;
    }
}
