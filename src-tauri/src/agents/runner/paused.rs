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

/// Agents whose held list changed but couldn't be written: tried again on the
/// next touch, and the words stay in memory meanwhile.
static UNSAVED: Mutex<Vec<String>> = Mutex::new(Vec::new());

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
    with_held_saved(agent_id, f).0
}

/// [`with_held`], and whether what changed reached the disk (true when
/// nothing changed or the agent has no home to write in).
fn with_held_saved<T>(agent_id: &str, f: impl FnOnce(&mut Vec<Inbound>) -> T) -> (T, bool) {
    let mut g = HELD.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let list = map.entry(agent_id.to_string()).or_insert_with(|| {
        // Held across a restart: read back the first time.
        path(agent_id)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|raw| serde_json::from_slice::<Vec<Inbound>>(&raw).ok())
            .unwrap_or_default()
    });
    let before = list.len();
    let out = f(list);
    // Written only when it changed: a read (or a removal that found nothing)
    // costs no disk.
    let mut unsaved = UNSAVED.lock().unwrap_or_else(|e| e.into_inner());
    let retry = unsaved.iter().any(|a| a == agent_id);
    let changed = list.len() != before || retry;
    let mut saved = true;
    if let Some(p) = path(agent_id).filter(|_| changed) {
        if list.is_empty() {
            saved = !p.exists() || std::fs::remove_file(p).is_ok();
        } else {
            saved = serde_json::to_value(&*list)
                .and_then(|mut v| {
                    super::secrets::redact_value(&mut v);
                    serde_json::to_vec(&v)
                })
                .map(|json| store::write_atomic(&p, &json).is_ok())
                .unwrap_or(false);
        }
    }
    unsaved.retain(|a| a != agent_id);
    if !saved {
        unsaved.push(agent_id.to_string());
    }
    (out, saved)
}

/// Whether `m` goes on to the queue. A paused agent holds or refuses what it
/// mustn't run; an agent not paused (or one that can't be read) runs all.
pub(super) fn gate(app: &AppHandle, agent_id: &str, m: Inbound) -> Option<Inbound> {
    let paused = store::get(agent_id).is_ok_and(|a| a.paused);
    match decide(agent_id, paused, m) {
        Decision::Queue(m) => Some(m),
        Decision::Held => None,
        Decision::Refused(m) => {
            tracing::info!(
                agent = agent_id,
                "[Agents] a routine firing for a paused agent is refused"
            );
            super::control::tell_dropped(app, agent_id, vec![m], Dropped::Stopped);
            None
        }
    }
}

pub(super) enum Decision {
    Queue(Inbound),
    Held,
    Refused(Inbound),
}

/// [`gate`] without the app: holds what a paused agent mustn't run.
pub(super) fn decide(agent_id: &str, paused: bool, m: Inbound) -> Decision {
    if !paused {
        return Decision::Queue(m);
    }
    match fate(&m) {
        Fate::Run => Decision::Queue(m),
        Fate::Hold => {
            tracing::info!(
                agent = agent_id,
                "[Agents] a message for a paused agent is held until Resume"
            );
            with_held(agent_id, |held| held.push(m));
            Decision::Held
        }
        Fate::Refuse => Decision::Refused(m),
    }
}

/// Pause, for what already waited in the queue (not yet started): everything
/// the user or another agent said is kept, in order, to run on Resume; a
/// routine or "When…" firing is refused. Returns (kept, refused). Pure.
pub(super) fn split_queue(queue: Vec<Inbound>) -> (Vec<Inbound>, Vec<Inbound>) {
    queue.into_iter().partition(|m| !m.routine)
}

/// Keep `kept` for Resume, after anything already held.
/// False when they could not be written to disk. They stay held in memory
/// (Resume runs them, the write is tried again on the next touch), and the
/// caller keeps the queue's own copy on disk, so nothing is lost either way.
/// Not deduplicated by id: a Resume that is releasing a message while a Pause
/// holds it again leaves two copies, and `release_with` forgets only one.
pub(super) fn hold_all(agent_id: &str, kept: Vec<Inbound>) -> bool {
    if kept.is_empty() {
        return true;
    }
    let (_, saved) = with_held_saved(agent_id, |held| held.extend(kept));
    if !saved {
        tracing::error!(agent = agent_id, "[Agents] held messages could not be saved yet");
    }
    saved
}

/// First agent (other than `asker`) that holds a request from `asker`: read
/// from disk, so it also finds one after a restart, before any runtime exists.
pub(super) fn holder_of_ask_from(asker: &str) -> Option<String> {
    store::list().unwrap_or_default().into_iter().find_map(|a| {
        (a.paused
            && a.id != asker
            && held_any(&a.id, |m| {
                !m.reply && matches!(&m.from, From::Agent { sender, .. } if sender.id == asker)
            }))
        .then_some(a.id)
    })
}

/// Forget these ids, once their other copy is safely written.
pub(super) fn forget(agent_id: &str, ids: &[String]) {
    with_held(agent_id, |held| held.retain(|h| h.id.is_empty() || !ids.contains(&h.id)));
}

/// Everything held, taken out for good (the agent is being deleted).
pub(super) fn take_all(agent_id: &str) -> Vec<Inbound> {
    with_held(agent_id, std::mem::take)
}

/// What is held for one room, taken out (the room was stopped).
pub(super) fn take_for_room(agent_id: &str, room_id: &str) -> Vec<Inbound> {
    with_held(agent_id, |held| {
        let (here, rest): (Vec<_>, Vec<_>) = held
            .drain(..)
            .partition(|m| m.room.as_ref().is_some_and(|r| r.room_id == room_id));
        *held = rest;
        here
    })
}

/// The engine read this message after the pause kept it: it is part of the
/// turn now, so it must not run again on Resume.
pub(super) fn drop_held(agent_id: &str, id: &str) {
    with_held(agent_id, |held| held.retain(|h| h.id != id));
}

/// A copy of everything held.
pub(super) fn held_all(agent_id: &str) -> Vec<Inbound> {
    with_held(agent_id, |held| held.clone())
}

/// Ids waiting for Resume.
pub(super) fn held_ids(agent_id: &str) -> Vec<String> {
    with_held(agent_id, |held| held.iter().map(|m| m.id.clone()).collect())
}

/// Whether something this agent holds satisfies `f`.
pub(super) fn held_any(agent_id: &str, f: impl Fn(&Inbound) -> bool) -> bool {
    with_held(agent_id, |held| held.iter().any(&f))
}

/// How many messages wait for this agent's Resume.
pub fn held_count(agent_id: &str) -> usize {
    with_held(agent_id, |held| held.len())
}

/// Resume: what was held runs now, in the order it came.
pub fn release(app: &AppHandle, agent_id: &str) {
    // Still paused (an unpause that didn't save): nothing is released, so
    // `gate` can't hold it again.
    if store::get(agent_id).is_ok_and(|a| a.paused) {
        tracing::warn!(agent = agent_id, "[Agents] Resume left the agent paused: nothing released");
        return;
    }
    release_with(agent_id, |m| push(app, agent_id, m));
}

/// Requeue first, then forget: a crash in between repeats a message (its
/// inbox copy is dropped at launch when it is also held, or run once when
/// the agent is no longer paused), never loses one. A message a requeue held
/// again (the agent was paused again meanwhile) has two copies now: one is
/// forgotten, one stays held.
pub(super) fn release_with(agent_id: &str, mut requeue: impl FnMut(Inbound)) {
    let held = with_held(agent_id, |held| held.clone());
    let mut ids: Vec<String> = Vec::new();
    for m in held {
        // Two copies of one id (see `hold_all`) run once.
        if m.id.is_empty() || !ids.contains(&m.id) {
            ids.push(m.id.clone());
            requeue(m);
        }
    }
    with_held(agent_id, |held| {
        for id in ids.iter().filter(|id| !id.is_empty()) {
            if let Some(at) = held.iter().position(|h| &h.id == id) {
                held.remove(at);
            }
        }
    });
}

#[cfg(test)]
#[path = "paused_tests.rs"]
mod tests;
