//! Is it alive, or stuck? The signs a running turn gives, kept quietly and
//! shown only on demand ("Last activity 4s ago · using the CPU"), and the
//! check that turns the working line into "No progress for 5 min" once there
//! have been none for too long.
//!
//! A sign of **life** is anything the engine wrote, heartbeats included. A
//! sign of **progress** is engine output other than a heartbeat (Claude
//! Code's `tool_progress` says only that a tool is still running), a line
//! the running command printed, or that command using the CPU. Only
//! progress holds off "No progress". A command whose process was seen and
//! is then gone, while the engine never says it came back, is a hung turn:
//! the runner ends it with a line saying so ("Nothing goes silent").

use super::{with_live, StepKind, LIVE};
use crate::agents::procs::ProcRow;

/// No progress for this long: the working line says so.
pub const STALL_MS: i64 = 3 * 60 * 1000;
/// The same, for a tool known to take a while (tests, builds, installs).
pub const STALL_SLOW_MS: i64 = 6 * 60 * 1000;
/// A command's process gone this long, its call never back: the turn is hung.
pub const GONE_MS: i64 = 2 * 60 * 1000;
/// CPU (percent of one core) that counts as using it.
const BUSY_CPU: f32 = 1.0;

/// Whether a turn whose last progress was at `last_progress` has stalled.
pub fn stalled(now: i64, last_progress: i64, slow: bool) -> bool {
    let limit = if slow { STALL_SLOW_MS } else { STALL_MS };
    now.saturating_sub(last_progress) >= limit
}

/// What finds a command's process in the process table: the start of its
/// first line, up to the first character a shell would rewrite (quotes, `$`,
/// backslashes). Claude Code and Codex both run the command through a shell
/// whose arguments carry it as written. `None` when too little is left to
/// match on safely.
pub fn needle(command: &str) -> Option<String> {
    let line = command.lines().map(str::trim).find(|l| !l.is_empty())?;
    let head: String = line
        .chars()
        .take_while(|c| !"'\"$`\\\n".contains(*c))
        .take(40)
        .collect();
    let head = head.trim_end().to_string();
    (head.chars().count() >= 6).then_some(head)
}

/// The processes running a step: `root`'s descendants whose command line
/// holds `needle`, and theirs.
pub fn step_procs<'a>(rows: &'a [ProcRow], root: u32, needle: &str) -> Vec<&'a ProcRow> {
    let under = crate::agents::procs::descendants(rows, root);
    let mut out: Vec<&ProcRow> = Vec::new();
    for row in &under {
        if row.command.contains(needle) && !out.iter().any(|r| r.pid == row.pid) {
            out.push(row);
            for child in crate::agents::procs::descendants(rows, row.pid) {
                if !out.iter().any(|r| r.pid == child.pid) {
                    out.push(child);
                }
            }
        }
    }
    out
}

/// The outermost of a step's processes: stopping each one's tree stops the step.
pub fn step_roots<'a>(procs: &[&'a ProcRow]) -> Vec<&'a ProcRow> {
    procs
        .iter()
        .filter(|p| !procs.iter().any(|q| q.pid == p.ppid))
        .copied()
        .collect()
}

/// The engine said something. `progress` is false for a heartbeat.
pub fn on_sign(agent_id: &str, now: i64, progress: bool) {
    with_live(agent_id, |live| {
        live.last_sign = live.last_sign.max(now);
        if progress {
            live.last_progress = live.last_progress.max(now);
            if live.quiet_since.take().is_some() {
                live.dirty = true;
            }
        }
    });
}

/// Whether this turn's engine streams command output as it runs.
pub fn set_streams(agent_id: &str, streams: bool) {
    with_live(agent_id, |live| live.streams = streams);
}

/// More of what the running command printed (Codex's `outputDelta`).
pub fn on_output(agent_id: &str, call_id: &str, delta: &str, now: i64) {
    with_live(agent_id, |live| {
        let Some(current) = live.current.as_mut().filter(|c| c.id == call_id) else {
            return;
        };
        current.output.push(delta);
        current.gone_since = None;
        live.last_sign = live.last_sign.max(now);
        live.last_progress = live.last_progress.max(now);
        live.quiet_since = None;
        live.dirty = true;
    });
}

/// Something shown live changed since this was last asked: send the status.
pub fn take_dirty(agent_id: &str) -> bool {
    with_live(agent_id, |live| std::mem::take(&mut live.dirty)).unwrap_or(false)
}

/// The running command's needle, for "Stop this step".
pub fn step_needle(agent_id: &str) -> Option<String> {
    with_live(agent_id, |live| {
        live.current
            .as_ref()
            .filter(|c| c.kind == Some(StepKind::Command))
            .and_then(|c| c.needle.clone())
    })
    .flatten()
}

/// What one look at the turn found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pulse {
    /// Something shown changed: send the status.
    pub changed: bool,
    /// The command it was running has ended, but the engine never said so.
    pub hung: bool,
}

/// One look at the turn: its command's process (when `rows` has the table
/// and `root` the engine's pid), then whether it has gone quiet.
pub fn pulse(agent_id: &str, now: i64, rows: Option<&[ProcRow]>, root: Option<u32>) -> Pulse {
    with_live(agent_id, |live| {
        let mut out = Pulse::default();
        let mut slow = false;
        if let Some(current) = live.current.as_mut() {
            slow = current.slow.is_some();
            if let (Some(needle), Some(rows), Some(root)) = (current.needle.as_deref(), rows, root)
            {
                let alive: Vec<&ProcRow> = step_procs(rows, root, needle)
                    .into_iter()
                    .filter(|p| !p.zombie)
                    .collect();
                let busy = if alive.is_empty() {
                    if current.seen_proc {
                        current.gone_since.get_or_insert(now);
                    }
                    None
                } else {
                    current.seen_proc = true;
                    current.gone_since = None;
                    Some(alive.iter().any(|p| p.cpu >= BUSY_CPU))
                };
                if busy != current.busy {
                    current.busy = busy;
                    out.changed = true;
                }
                if busy == Some(true) {
                    live.last_sign = live.last_sign.max(now);
                    live.last_progress = live.last_progress.max(now);
                    if live.quiet_since.take().is_some() {
                        out.changed = true;
                    }
                }
                out.hung = current.gone_since.is_some_and(|gone| {
                    now.saturating_sub(gone) >= GONE_MS && live.last_progress <= gone
                });
            }
        }
        if live.quiet_since.is_none() && stalled(now, live.last_progress, slow) {
            live.quiet_since = Some(live.last_progress);
            out.changed = true;
        }
        out
    })
    .unwrap_or_default()
}

/// "4s", "3 min", "1 h 5 min".
pub fn ago(ms: i64) -> String {
    let s = (ms.max(0) / 1000).max(1);
    if s < 60 {
        return format!("{s}s");
    }
    let min = s / 60;
    if min < 60 {
        return format!("{min} min");
    }
    match min % 60 {
        0 => format!("{} h", min / 60),
        rest => format!("{} h {rest} min", min / 60),
    }
}

/// What "Check on it" found, in one line. `engine_alive` is whether the
/// engine's process is still there; `procs` the running command's, when it
/// has one and it was looked for.
pub fn check_line(engine: &str, now: i64, engine_alive: bool, live: Option<CheckView>) -> String {
    let Some(view) = live else {
        return "It isn't working on anything right now.".into();
    };
    if !engine_alive {
        return format!("{engine} isn't running any more. The turn will end in a moment.");
    }
    let since = ago(now - view.last_progress);
    let Some(step) = view.step else {
        return format!("{engine} is running. Its last progress was {since} ago.");
    };
    let doing = lower_first(&step.doing);
    if !step.command {
        return format!(
            "{engine} is running and still {doing}. Its last progress was {since} ago."
        );
    }
    match step.procs {
        Some(Procs { alive: true, busy: true }) => {
            format!("Still going: {doing} is using the CPU right now.")
        }
        Some(Procs { alive: true, busy: false }) => format!(
            "Its command is still running but isn't using the CPU, and its last progress was {since} ago. It may be waiting on something, like a server or the network."
        ),
        Some(Procs { alive: false, .. }) if step.seen_proc => format!(
            "Its command has ended, but {engine} hasn't moved on yet."
        ),
        _ => format!(
            "{engine} is running, but this step's process couldn't be found to check. Its last progress was {since} ago."
        ),
    }
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => c.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// What [`check_line`] reads about a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckView {
    pub last_progress: i64,
    pub step: Option<CheckStep>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckStep {
    pub doing: String,
    pub command: bool,
    pub seen_proc: bool,
    /// Its processes as found now, when they were looked for.
    pub procs: Option<Procs>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Procs {
    pub alive: bool,
    pub busy: bool,
}

/// The turn as "Check on it" sees it, looking its command up in `rows`.
pub fn check_view(
    agent_id: &str,
    rows: Option<&[ProcRow]>,
    root: Option<u32>,
) -> Option<CheckView> {
    with_live(agent_id, |live| CheckView {
        last_progress: live.last_progress,
        step: live.current.as_ref().map(|c| {
            let procs = match (c.needle.as_deref(), rows, root) {
                (Some(needle), Some(rows), Some(root)) => {
                    let found: Vec<&ProcRow> = step_procs(rows, root, needle)
                        .into_iter()
                        .filter(|p| !p.zombie)
                        .collect();
                    Some(Procs {
                        alive: !found.is_empty(),
                        busy: found.iter().any(|p| p.cpu >= BUSY_CPU),
                    })
                }
                _ => None,
            };
            CheckStep {
                doing: c.doing.clone(),
                command: c.kind == Some(StepKind::Command),
                seen_proc: c.seen_proc,
                procs,
            }
        }),
    })
}

/// "Check on it": a look at the turn now, in one line. It never interrupts
/// the turn: the engine can't be asked mid-call, so this is what the app
/// itself can see (the engine's process, its command's, their CPU, the last
/// progress). Blocking (`ps`).
pub fn check_on(agent_id: &str) -> String {
    let engine = crate::agents::store::get(agent_id)
        .map(|a| a.engine.label())
        .unwrap_or("The engine");
    let root = crate::agents::procs::pid_of(agent_id);
    let rows = crate::agents::procs::snapshot();
    let engine_alive = match (root, rows.as_deref()) {
        (Some(pid), Some(rows)) => rows.iter().any(|r| r.pid == pid && !r.zombie),
        // Nothing to look at: don't claim it's gone.
        (Some(_), None) => true,
        (None, _) => false,
    };
    let view = check_view(agent_id, rows.as_deref(), root);
    let now = crate::agents::store::now_ms();
    if view.is_some() {
        on_check(agent_id);
    }
    check_line(engine, now, engine_alive && view.is_some(), view)
}

fn on_check(agent_id: &str) {
    with_live(agent_id, |live| live.dirty = true);
}

/// "Stop this step": end the command the turn is running (its process and
/// everything under it). The engine sees the command end and carries on,
/// so the turn isn't stopped. Blocking. Says what it did.
pub fn stop_step(agent_id: &str) -> Result<String, String> {
    let needle = step_needle(agent_id).ok_or("It isn't running a command right now.")?;
    let root =
        crate::agents::procs::pid_of(agent_id).ok_or("It isn't running a command right now.")?;
    let rows =
        crate::agents::procs::snapshot().ok_or("Couldn't look at what's running on this Mac.")?;
    let procs = step_procs(&rows, root, &needle);
    let roots: Vec<u32> = step_roots(&procs).iter().map(|r| r.pid).collect();
    if roots.is_empty() {
        return Err("Couldn't find that step's process. Stop the whole turn instead.".into());
    }
    for pid in roots {
        crate::agents::procs::kill_tree_sync(pid);
    }
    Ok("Stopped that step. It carries on from there.".into())
}

/// Whether the agent has a turn being tracked here at all.
pub fn tracking(agent_id: &str) -> bool {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(agent_id)
}

#[cfg(test)]
#[path = "liveness_tests.rs"]
mod tests;
