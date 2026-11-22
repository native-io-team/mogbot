//! The user's messages into the turn in progress. A message typed in the
//! agent's own chat while it works used to wait for the whole turn to end;
//! where the engine takes input mid-turn, it is handed to the turn instead
//! and read at the engine's next step, the way Claude Code's own terminal
//! does:
//!
//! - Claude Code (`--input-format stream-json`): a `user` line on stdin with
//!   our id as its `uuid`; `command_lifecycle` then says `queued`, `started`
//!   (read, at the next tool boundary) and `completed`. One that lands after
//!   the turn's `result` runs as a second turn in the same process.
//! - Codex app-server: `turn/steer`, read with its next step.
//! - OpenCode: no way in; messages queue for the next turn as before.
//!
//! The message is still queued too, so nothing is lost when the turn is cut
//! off before reading it: what the engine read is taken out of the queue
//! when the turn ends ([`close`]), what it didn't stays for the next turn.
//! Only the user's own typed message, in the conversation the turn is in,
//! into a turn that answers the user (no room, no outside text, not the
//! app's tidy) is handed over; anything else queues.

use super::*;

/// A message handed to the turn in progress: its queue id, what the engine
/// is sent and what the user typed.
#[derive(Debug, Clone)]
pub(super) struct Handed {
    pub(super) id: String,
    pub(super) text: String,
    typed: Option<String>,
}

/// The turn's way in, on its agent's runtime (under the runtime lock, so a
/// message is either handed over or queued for the next turn, never lost
/// between the two as the turn ends).
pub(super) struct Slot {
    tx: tokio::sync::mpsc::UnboundedSender<Handed>,
    /// Handed to the engine, not read yet.
    handed: Vec<Handed>,
    /// Read by the engine: part of this turn.
    heard: Vec<String>,
}

/// Open the way in for the turn in progress, when it answers the user in
/// their own chat. `None` (and the queue as before) otherwise.
pub(super) fn open(agent_id: &str) -> Option<tokio::sync::mpsc::UnboundedReceiver<Handed>> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let runtime = runtimes.get_mut(agent_id)?;
    if !takes_mid_turn(runtime) {
        return None;
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    runtime.steer = Some(Slot {
        tx,
        handed: Vec::new(),
        heard: Vec::new(),
    });
    Some(rx)
}

/// A turn the user's next message can go into: it answers them, in their
/// own chat, with no outside text in it.
fn takes_mid_turn(runtime: &Runtime) -> bool {
    runtime.running
        && !runtime.driven
        && runtime.user_asked
        && !runtime.outside
        && runtime.room.is_none()
}

/// Called by `push` under the runtime lock, before it queues `inbound`:
/// hand it to the turn in progress too when it can take it. It is queued
/// either way; true when it was handed over.
pub(super) fn offer(runtime: &mut Runtime, inbound: &Inbound) -> bool {
    let plain = matches!(inbound.from, From::User)
        && inbound.typed.is_some()
        && !inbound.routine
        && !inbound.outside
        && inbound.room.is_none()
        && inbound.ticket.is_none()
        && inbound.resume == 0
        && !inbound.id.is_empty();
    if !plain || !takes_mid_turn(runtime) || inbound.conversation != runtime.conversation {
        return false;
    }
    let Some(slot) = runtime.steer.as_mut() else {
        return false;
    };
    if slot.handed.iter().any(|h| h.id == inbound.id) || slot.heard.contains(&inbound.id) {
        return true;
    }
    let handed = Handed {
        id: inbound.id.clone(),
        text: inbound.text.clone(),
        typed: inbound.typed.clone(),
    };
    if slot.tx.send(handed.clone()).is_err() {
        return false;
    }
    slot.handed.push(handed);
    true
}

/// The engine couldn't take it after all (its turn hadn't started, or was
/// ending): it stays queued for the next turn.
pub(super) fn not_taken(agent_id: &str, id: &str) {
    if let Some(slot) = slot_of(
        &mut RUNTIMES.lock().unwrap_or_else(|e| e.into_inner()),
        agent_id,
    ) {
        slot.handed.retain(|h| h.id != id);
    }
}

/// The engine read it: it is part of this turn. The turn now answers what
/// the user typed last, so the words a setting from chat is checked against
/// (`remember`) are theirs.
pub(super) fn heard(agent_id: &str, id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    let Some(slot) = runtime.steer.as_mut() else {
        return false;
    };
    let Some(at) = slot.handed.iter().position(|h| h.id == id) else {
        return false;
    };
    let handed = slot.handed.remove(at);
    slot.heard.push(handed.id.clone());
    // A pause that came before this read kept the message to run on Resume:
    // the engine has it now, so it is not kept too.
    super::paused::drop_held(agent_id, &handed.id);
    if let Some(typed) = handed.typed {
        runtime.typed = Some(match runtime.typed.take() {
            Some(before) => format!("{before}\n{typed}"),
            None => typed,
        });
    }
    runtime.user_text = if runtime.user_text.is_empty() {
        handed.text
    } else {
        format!("{}\n{}", runtime.user_text, handed.text)
    };
    runtime.batch_ids.push(handed.id);
    true
}

/// At the turn's `result`: true when nothing handed over is still unread, and
/// the way in is closed (so the engine can be let go). False while one is:
/// the engine answers it next, in the same process.
pub(super) fn close_if_idle(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return true;
    };
    match &runtime.steer {
        Some(slot) if !slot.handed.is_empty() => false,
        Some(_) => {
            finish(agent_id, runtime);
            true
        }
        None => true,
    }
}

/// The turn is over: close the way in, and take what the engine read out of
/// the queue. What it never read stays queued for the next turn.
pub(super) fn close(agent_id: &str) {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(runtime) = runtimes.get_mut(agent_id) {
        finish(agent_id, runtime);
    }
}

fn finish(agent_id: &str, runtime: &mut Runtime) {
    let Some(slot) = runtime.steer.take() else {
        return;
    };
    if slot.heard.is_empty() {
        return;
    }
    runtime.queue.retain(|m| !slot.heard.contains(&m.id));
    save_inbox(agent_id, &runtime.queue);
}

/// What the engine has already read in the turn in progress.
pub(super) fn heard_ids(runtime: &Runtime) -> Vec<String> {
    runtime
        .steer
        .as_ref()
        .map(|s| s.heard.clone())
        .unwrap_or_default()
}

/// What the status shows (`TurnWork::handed`, `heard`).
pub(super) fn seen(agent_id: &str) -> (Vec<String>, Vec<String>) {
    let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    match runtimes.get(agent_id).and_then(|r| r.steer.as_ref()) {
        Some(slot) => (
            slot.handed.iter().map(|h| h.id.clone()).collect(),
            slot.heard.clone(),
        ),
        None => (Vec::new(), Vec::new()),
    }
}

fn slot_of<'a>(runtimes: &'a mut HashMap<String, Runtime>, agent_id: &str) -> Option<&'a mut Slot> {
    runtimes.get_mut(agent_id)?.steer.as_mut()
}

/// Claude Code's `command_lifecycle` event: the id of one of ours it has
/// now read (`started`), else `None`.
pub(super) fn claude_read(value: &serde_json::Value) -> Option<&str> {
    if value.get("type").and_then(|t| t.as_str()) != Some("command_lifecycle") {
        return None;
    }
    if value.get("state").and_then(|s| s.as_str()) != Some("started") {
        return None;
    }
    value.get("command_uuid").and_then(|u| u.as_str())
}

/// One user message on Claude Code's stdin (`--input-format stream-json`),
/// with our id so its lifecycle names it. The first prompt has none.
pub(super) fn claude_line(text: &str, id: Option<&str>) -> String {
    let mut line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    });
    if let Some(id) = id {
        line["uuid"] = serde_json::Value::String(id.to_string());
    }
    line.to_string()
}

#[cfg(test)]
#[path = "steer_tests.rs"]
mod tests;
