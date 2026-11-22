//! A paused agent (`Agent::paused`, set from its ⋯ menu or by an admin) takes
//! only the user's own words (and the app's own notes). What other agents
//! send it is held, in memory and on disk (`<home>/held.json`), and runs when
//! it is resumed ([`release`]); a routine or "When…" firing is refused, not
//! queued (the routines are switched off, and a late one must not run). The
//! gate is in [`gate`], called by `push`, the one way a message reaches a turn.

use super::*;

use std::collections::HashMap;
use std::sync::Mutex;

static HELD: Mutex<Option<HashMap<String, Vec<Inbound>>>> = Mutex::new(None);

/// What a paused agent does with a message. Pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Fate {
    /// The user's own words, or an app note: runs now.
    Run,
    /// Another agent's, or outside text: waits for Resume.
    Hold,
    /// A routine or "When…" firing: refused.
    Refuse,
}

pub(super) fn fate(m: &Inbound) -> Fate {
    if m.routine {
        return Fate::Refuse;
    }
    match (&m.from, m.outside) {
        (From::User | From::App, false) => Fate::Run,
        _ => Fate::Hold,
    }
}

fn path(agent_id: &str) -> Option<std::path::PathBuf> {
    store::agent_home(agent_id)
        .ok()
        .map(|h| h.join("held.json"))
}

fn with_held<T>(agent_id: &str, f: impl FnOnce(&mut Vec<Inbound>) -> T) -> T {
    let mut g = HELD.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let list = map.entry(agent_id.to_string()).or_insert_with(|| {
        // Held across a restart: read back the first time.
        path(agent_id)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|raw| serde_json::from_slice::<Vec<Inbound>>(&raw).ok())
            .unwrap_or_default()
    });
    let out = f(list);
    if let Some(p) = path(agent_id) {
        if list.is_empty() {
            let _ = std::fs::remove_file(p);
        } else if let Ok(json) = serde_json::to_value(&*list).and_then(|mut v| {
            super::secrets::redact_value(&mut v);
            serde_json::to_vec(&v)
        }) {
            let _ = store::write_atomic(&p, &json);
        }
    }
    out
}

/// Whether `m` goes on to the queue. A paused agent holds or refuses what it
/// mustn't run; an agent not paused (or one that can't be read) runs all.
pub(super) fn gate(app: &AppHandle, agent_id: &str, m: Inbound) -> Option<Inbound> {
    if !store::get(agent_id).is_ok_and(|a| a.paused) {
        return Some(m);
    }
    match fate(&m) {
        Fate::Run => Some(m),
        Fate::Hold => {
            tracing::info!(
                agent = agent_id,
                "[Agents] a message for a paused agent is held until Resume"
            );
            with_held(agent_id, |held| held.push(m));
            None
        }
        Fate::Refuse => {
            tracing::info!(
                agent = agent_id,
                "[Agents] a routine firing for a paused agent is refused"
            );
            super::control::tell_dropped(app, agent_id, vec![m], Dropped::Stopped);
            None
        }
    }
}

/// Pause, for what already waited in the queue (not yet started): everything
/// the user or another agent said is kept, in order, to run on Resume; a
/// routine or "When…" firing is refused. Returns (kept, refused). Pure.
pub(super) fn split_queue(queue: Vec<Inbound>) -> (Vec<Inbound>, Vec<Inbound>) {
    queue.into_iter().partition(|m| !m.routine)
}

/// Keep `kept` for Resume, after anything already held.
pub(super) fn hold_all(agent_id: &str, kept: Vec<Inbound>) {
    if !kept.is_empty() {
        with_held(agent_id, |held| held.extend(kept));
    }
}

/// How many messages wait for this agent's Resume.
pub fn held_count(agent_id: &str) -> usize {
    with_held(agent_id, |held| held.len())
}

/// Resume: what was held runs now, in the order it came.
pub fn release(app: &AppHandle, agent_id: &str) {
    let held = with_held(agent_id, std::mem::take);
    for m in held {
        push(app, agent_id, m);
    }
}

#[cfg(test)]
#[path = "paused_tests.rs"]
mod tests;
