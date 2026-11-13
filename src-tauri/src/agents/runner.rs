//! Running agents: one Claude Code turn at a time per agent, many agents at once.
//!
//! Each agent has an inbox. Sending (from the user or another agent) appends
//! to it; if the agent is idle a worker starts and drains it — everything that
//! queued up while a turn ran becomes the next turn, so a burst of messages is
//! one coherent reply instead of five. A turn is a single
//! `claude --print --resume <session>` process: no long-lived process per
//! agent, so twenty idle agents cost nothing.
//!
//! What the user sees is built from the stream as it happens: each text block
//! the model writes streams in as a draft (see [`super::stream`]) and becomes
//! a chat message under the same id when it completes; tool calls only ever
//! update the "working" line under the agent's name.
//!
//! The parts, in the order a message travels through them:
//!
//! - `state`: where a message came from, the inbox, the status shown and
//!   each agent's runtime under one lock
//! - `inbox`: every way a message reaches an agent, and the seal on its
//!   memory while it answers outside text
//! - `now`: questions about the turn in flight (whom it answers, its hop,
//!   whether it is busy)
//! - `drain`: the worker, which takes batches and runs turns until the
//!   queue is empty
//! - `slots`: waiting for a free slot or memory, and the waiting-on-a-card guard
//! - `prompt`: what a turn is told
//! - `accounts`: which account and engine it runs on, failing over between them
//! - `turn`: one turn on one account, its stream turned into chat and timeline
//! - `record`: recording and announcing what the user sees
//! - `after_turn`: bookkeeping between and after turns
//! - `control`: take over, stop, start fresh, interrupt
//! - `mark`, `recovery`, `recap`, `panic`: a turn on disk, and picking
//!   up after a restart, a lost conversation or a panic
//! - `session_env`: the inherited Claude Code session variables, stripped

use crate::agents::store::OrLog;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::codex_app::Out;
use super::driver::{Conversation, Driver, TurnSpec};
use super::engine::Engine;
use super::notify;
use super::procs;
use super::prompts;
use super::store::{self, AgentMessage, AgentRef, MessageKind};
use super::stream::{self, Drafts, Step};
use crate::errors::CommandError;

// Each part sees everything here (`use super::*`) and is re-exported whole,
// so `runner::x` paths stay as they were; its `super::x` paths reach
// `agents::x` through this import.
use super::{
    account_reach, admin, agency, apps, attachments, blocks, briefing, broker, browser,
    browser_gate, capabilities, capacity, chrome_health, claude, codex, codex_app, connections,
    connector, context, conversations, crossover, declined, dev_servers, disk, e2e_alias, engine,
    err_io, err_other, expiry, exposure, failure, follow_up, full_send, independence, is_disk_full,
    level_hint, local_links, mcp, narration, opencode, page, policy, preview_test, project, quiet,
    quota, reach, results, rewind, rooms, runs, schedule, secrets, share_text, skills_learn, slack,
    starters, survive, takeover, task, tidy, transcript, turn_end, usage, usage_plan, wallet, work,
    workplace, DISK_FULL_LINE,
};

mod state;
pub use state::*;

mod inbox;
pub use inbox::*;

mod now;
pub use now::*;

mod drain;
use drain::*;

mod slots;
pub use slots::*;

mod prompt;
pub use prompt::*;

mod accounts;
pub use accounts::*;

mod turn;
use turn::*;

mod record;
pub use record::*;

mod after_turn;
use after_turn::*;

mod control;
pub use control::*;

mod mark;
pub(in crate::agents) use mark::*;

mod recovery;
pub use recovery::*;

mod recap;
pub(in crate::agents) use recap::*;

mod panic;
use panic::*;

mod session_env;
pub use session_env::*;

pub const EVENT_MESSAGE: &str = "agents://message";
pub const EVENT_STATUS: &str = "agents://status";
pub const EVENT_REGISTRY: &str = "agents://registry";
/// An agent's list of conversations changed (one named, one started); the agent's id.
pub const EVENT_CONVERSATIONS: &str = "agents://conversations";
/// A reply being written: `{agentId, id, text}`, the text so far. The message
/// that completes it arrives on [`EVENT_MESSAGE`] with the same id.
pub const EVENT_DRAFT: &str = "agents://draft";
/// An engine reported how much of the plan is left (`super::quota`).
pub const EVENT_QUOTA: &str = "agents://quota";
/// The usage mode or the list of ideas for leftover usage changed (`agents::usage_plan`).
pub const EVENT_USAGE_PLAN: &str = "agents://usage-plan";

/// How often a growing draft is sent to the UI: smooth to the eye, and a
/// burst of tiny deltas costs one event rather than dozens.
const DRAFT_EVERY: std::time::Duration = std::time::Duration::from_millis(40);

/// Agents messaging agents can ping-pong forever. A chain started by the user
/// may run this many agent-to-agent hops before `message_agent` refuses.
pub const MAX_HOPS: u8 = 6;

/// A turn that runs this long is stopped. Long enough to babysit a CI run.
const TURN_TIMEOUT_SECS: u64 = 3 * 60 * 60;
/// The chat's line for a turn stopped by [`TURN_TIMEOUT_SECS`].
const TIMEOUT_NOTE: &str = "Stopped after 3 hours. Send a message to pick it back up.";
/// What the line says between calls, once the one it named came back.
const THINKING: &str = "Thinking";
/// A command's process ended but the engine never moved on (`work::pulse`).
const HUNG_NOTE: &str = "Stopped: the command it was running had ended, but it never moved on. Send a message to pick it back up.";
/// Its engine no longer had the conversation, so the turn started a new one
/// with a recap of the chat (its memory is in its instructions either way).
const FRESH_SESSION_NOTE: &str = "Its earlier conversation couldn't be found, so it started a new one with a recap of this chat.";
/// How often a running turn is looked at for signs of life (`work::pulse`).
const PULSE_EVERY: Duration = Duration::from_secs(15);
/// How often what a running command printed is sent on, at most.
const PEEK_EVERY: Duration = Duration::from_secs(1);
/// With no tool call open, this long without a word from the CLI and the
/// working line says it may be stuck (see [`quiet_line`]).
const QUIET_MS: i64 = 10 * 60 * 1000;

/// After `claude` closes its output, how long it gets to exit (and its
/// stderr to close) before it is stopped: a CLI that hangs on the way out
/// must not wedge the agent, with every later message queued behind it.
const EXIT_BOUND: Duration = Duration::from_secs(10);

/// Turns that may run at once. A Chief fanning work out to ten agents would
/// otherwise start ten `claude` processes together, burn the usage limit and
/// come back as ten failures; the rest wait their turn, and say so. Scaled to
/// this machine's memory (`agents::capacity`), fixed for the app's life.
fn max_turns() -> usize {
    static MAX: LazyLock<usize> = LazyLock::new(super::capacity::max_turns);
    *MAX
}

static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(max_turns())));

/// Set when the app is exiting: turns being torn down must not record their
/// end, so the marks they leave say "Ship Studio closed" at the next launch.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The app is exiting (`RunEvent::Exit`): stop every running turn's whole
/// process tree, so no `claude` keeps editing a project after Ship Studio is
/// gone. Their `turn.json` marks stay, and the next launch records each one
/// as interrupted (see [`recover_after_restart`]); queued messages are
/// already on disk. Returns how many turns were stopped.
pub fn shutdown_sync() -> usize {
    QUITTING.store(true, Ordering::SeqCst);
    mark_quitting();
    super::dev_servers::stop_all_sync();
    procs::kill_all_sync()
}

/// Every turn in flight is cut off by a clean quit, not by anything it did:
/// its mark says so, so the next launch picks it up (`next_pickup_of`).
fn mark_quitting() {
    let running: Vec<String> = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(_, r)| r.running)
        .map(|(id, _)| id.clone())
        .collect();
    for agent_id in running {
        update_mark(&agent_id, |m| m.quit = true);
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "audit_runner_tests.rs"]
mod audit_runner_tests;

#[cfg(test)]
#[path = "review_runner_tests.rs"]
mod review_runner_tests;

#[cfg(test)]
#[path = "rooms_runner_tests.rs"]
mod rooms_runner_tests;

#[cfg(test)]
#[path = "resume_runner_tests.rs"]
mod resume_runner_tests;

#[cfg(test)]
#[path = "share_text_runner_tests.rs"]
mod share_text_runner_tests;

#[cfg(test)]
#[path = "prompt_budget_tests.rs"]
mod prompt_budget_tests;

#[cfg(test)]
#[path = "remember_runner_tests.rs"]
mod remember_runner_tests;

#[cfg(test)]
#[path = "handoff_runner_tests.rs"]
mod handoff_runner_tests;

#[cfg(test)]
#[path = "outside_runner_tests.rs"]
mod outside_runner_tests;

#[cfg(test)]
#[path = "relay_runner_tests.rs"]
mod relay_runner_tests;

#[cfg(test)]
#[path = "app_note_runner_tests.rs"]
mod app_note_runner_tests;

#[cfg(test)]
#[path = "breaks_runner_tests.rs"]
mod breaks_runner_tests;

#[cfg(test)]
#[path = "conversations_runner_tests.rs"]
mod conversations_runner_tests;
