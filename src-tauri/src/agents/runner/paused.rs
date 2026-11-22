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
    // A room ask another member brought in with an @mention is typed by no
    // one at this agent's door: it is another agent's.
    if m.room
        .as_ref()
        .is_some_and(|r| matches!(r.asker, super::super::rooms::Asker::Agent { .. }))
    {
        return Fate::Hold;
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
        // A damaged file is set aside (and the Chief told), never read as
        // empty and written over: it carries the user's words.
        path(agent_id)
            .and_then(|p| {
                super::survive::read_kept::<Vec<Inbound>>(&p, "Messages held for a paused agent")
            })
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
        Decision::Held => {
            after_hold(app, agent_id);
            None
        }
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
/// One already held (same id: a Resume whose queue write failed kept its held
/// copy) is not held twice.
pub(super) fn hold_all(agent_id: &str, kept: Vec<Inbound>) -> bool {
    if kept.is_empty() {
        return true;
    }
    let (_, saved) = with_held_saved(agent_id, |held| {
        for m in kept {
            if m.id.is_empty() || !held.iter().any(|h| h.id == m.id) {
                held.push(m);
            }
        }
    });
    if !saved {
        tracing::error!(
            agent = agent_id,
            "[Agents] held messages could not be saved yet"
        );
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
    with_held(agent_id, |held| {
        held.retain(|h| h.id.is_empty() || !ids.contains(&h.id))
    });
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

/// Resume: what was held runs now, in the order it came. One step under the
/// runtime lock (where a pause drains the queue too): paused is read again,
/// the held messages are appended to the queue (the same message twice is
/// once), the queue is saved, and only then is the held list cleared. Two
/// Resumes at once therefore can't run a message twice: the second finds
/// nothing held. The conversation a message goes to is worked out before the
/// lock, and the worker starts after it.
pub fn release(app: &AppHandle, agent_id: &str) {
    if release_step(agent_id) {
        start_worker(app, agent_id);
    }
}

/// After a message was held: the agent may have been resumed in the moment
/// between the decision and the hold, so look again and release if so. Still
/// paused, nothing is released.
pub(super) fn after_hold(app: &AppHandle, agent_id: &str) {
    release(app, agent_id);
}

/// [`release`] without the worker: whether one must start.
pub(super) fn release_step(agent_id: &str) -> bool {
    let mut start = false;
    let mut settled = false;
    for _ in 0..3 {
        let fill = conversations_of_held(agent_id);
        let (started, again) = {
            let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
            let paused = store::get(agent_id).is_ok_and(|a| a.paused);
            release_locked(&mut runtimes, agent_id, paused, &fill)
        };
        start |= started;
        if !again {
            settled = true;
            break;
        }
    }
    if !settled {
        tracing::warn!(
            agent = agent_id,
            "resume: some held messages still lack a conversation after three rounds; they stay held"
        );
    }
    start
}

/// The conversation each held message would have been given at the door.
fn conversations_of_held(agent_id: &str) -> HashMap<String, String> {
    held_all(agent_id)
        .into_iter()
        .filter(|m| m.room.is_none() && m.conversation.is_none())
        .map(|m| {
            let c = conversation_for(agent_id, &m);
            (m.id, c)
        })
        .collect()
}

/// [`release`]'s step under the lock, without the app: (a worker must
/// start, some held message still lacks its conversation: go round again).
/// Still paused (an unpause that didn't save): nothing is released, so the
/// gate can't hold it again.
pub(super) fn release_locked(
    runtimes: &mut HashMap<String, Runtime>,
    agent_id: &str,
    paused: bool,
    conversations: &HashMap<String, String>,
) -> (bool, bool) {
    if paused {
        tracing::warn!(
            agent = agent_id,
            "[Agents] Resume left the agent paused: nothing released"
        );
        return (false, false);
    }
    let mut again = false;
    let mut batch = Vec::new();
    for mut m in held_all(agent_id) {
        if m.room.is_none() && m.conversation.is_none() {
            match conversations.get(&m.id) {
                Some(c) => m.conversation = Some(c.clone()),
                None => {
                    again = true;
                    continue;
                }
            }
        }
        batch.push(m);
    }
    if batch.is_empty() {
        return (false, again);
    }
    let runtime = runtimes.entry(agent_id.to_string()).or_default();
    let mut started = false;
    for m in &batch {
        // Err: the agent is being deleted; the delete took (or will take) these.
        if let Ok(true) = runtime.admit(m.clone()) {
            started = true;
        }
    }
    if !save_inbox_ok(agent_id, &runtime.queue) {
        tracing::error!(
            agent = agent_id,
            "[Agents] a Resume couldn't save the queue: still held"
        );
        return (started, false);
    }
    let ids: Vec<String> = batch.iter().map(|m| m.id.clone()).collect();
    forget(agent_id, &ids);
    (started, again)
}

#[cfg(test)]
#[path = "paused_tests.rs"]
mod tests;
