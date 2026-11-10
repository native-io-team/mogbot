//! Waiting: the guard that shows an agent waiting on a card or a question, and a turn waiting for a free slot or for memory before it starts.

use super::*;

/// A card the turn in progress is waiting on: the status says "Needs your
/// OK" until this and every other open card of the same turn is answered
/// (two at once: parallel tool calls, or a session question and a
/// permission card). Dropped when the wait ends.
pub struct WaitGuard {
    pub(super) app: AppHandle,
    pub(super) agent_id: String,
    pub(super) turn: u64,
    pub(super) since: Option<i64>,
}

/// Put the agent in "waiting" for a card, counted (see [`WaitGuard`]).
pub fn begin_wait(app: &AppHandle, agent_id: &str) -> WaitGuard {
    let before = status_of(agent_id);
    let turn = open_wait(agent_id);
    set_status(
        app,
        agent_id,
        Status {
            state: "waiting",
            activity: Some("Waiting for your OK".into()),
            since: before.since,
            work: None,
            room: None,
        },
    );
    WaitGuard {
        app: app.clone(),
        agent_id: agent_id.to_string(),
        turn,
        since: before.since,
    }
}

/// Count one more open card for the turn in progress; returns that turn.
pub(super) fn open_wait(agent_id: &str) -> u64 {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    runtime.waits = runtime.waits.saturating_add(1);
    runtime.turn_gen
}

/// One of `turn`'s cards is settled. True when it was the last one and the
/// status still says "waiting": back to work. A card from a turn that has
/// since ended (or been replaced) changes nothing.
pub(super) fn close_wait(agent_id: &str, turn: u64) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    if runtime.turn_gen != turn {
        return false;
    }
    runtime.waits = runtime.waits.saturating_sub(1);
    runtime.waits == 0
        && runtime
            .status
            .as_ref()
            .is_some_and(|s| s.state == "waiting")
}

impl Drop for WaitGuard {
    fn drop(&mut self) {
        // Back to work, unless another card is still open, or the turn already
        // ended under the card (Stop, or the user interrupted it): then it
        // isn't ours to change.
        if close_wait(&self.agent_id, self.turn) {
            set_status(
                &self.app,
                &self.agent_id,
                Status {
                    state: "working",
                    activity: None,
                    since: self.since,
                    work: None,
                    room: None,
                },
            );
        }
    }
}

/// A free turn slot, waiting (and saying so) while every slot is taken.
/// `None` when the wait ended because the queue was stopped and emptied.
pub(super) async fn wait_for_slot(app: &AppHandle, agent_id: &str) -> Option<OwnedSemaphorePermit> {
    if !wait_for_memory(app, agent_id).await {
        return None;
    }
    if let Ok(permit) = SLOTS.clone().try_acquire_owned() {
        return Some(permit);
    }
    // Stop wakes this; a fresh one per wait, so nothing stale reaches the turn.
    let wake = Arc::new(Notify::new());
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        runtimes.entry(agent_id.to_string()).or_default().cancel = Some(wake.clone());
    }
    let busy = max_turns();
    set_status(
        app,
        agent_id,
        Status {
            state: "working",
            activity: Some(format!(
                "Waiting for a free slot ({busy} agents already working)"
            )),
            since: None,
            work: None,
            room: None,
        },
    );
    loop {
        tokio::select! {
            permit = SLOTS.clone().acquire_owned() => return permit.ok(),
            _ = wake.notified() => {
                let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
                let runtime = runtimes.entry(agent_id.to_string()).or_default();
                // Interrupting a turn that hasn't started means nothing.
                runtime.interrupt = false;
                if runtime.queue.is_empty() {
                    return None;
                }
            }
        }
    }
}

/// On a small machine, wait while free memory is short and other turns are
/// running (`capacity::room_now`), saying so. False if the wait ended
/// because the queue was stopped and emptied.
pub(super) async fn wait_for_memory(app: &AppHandle, agent_id: &str) -> bool {
    let running = || max_turns().saturating_sub(SLOTS.available_permits());
    if super::capacity::room_now(running()) {
        return true;
    }
    let wake = Arc::new(Notify::new());
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .cancel = Some(wake.clone());
    loop {
        let working = running();
        set_status(
            app,
            agent_id,
            Status {
                state: "working",
                activity: Some(format!(
                    "Waiting for free memory ({working} {} already working)",
                    if working == 1 { "agent" } else { "agents" }
                )),
                since: None,
                work: None,
                room: None,
            },
        );
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = wake.notified() => {
                let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
                let runtime = runtimes.entry(agent_id.to_string()).or_default();
                runtime.interrupt = false;
                if runtime.queue.is_empty() {
                    return false;
                }
            }
        }
        if super::capacity::room_now(running()) {
            return true;
        }
    }
}
