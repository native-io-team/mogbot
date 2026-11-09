//! Cards expire. An Allow / Deny card, a sign-in or a secure input never sits
//! in a chat asking forever:
//!
//! - **Its turn ended** (the engine stopped waiting on it, or the app
//!   restarted): it closes at once as "Expired — the agent moved on".
//! - **It still blocks a live turn**: the wait runs out (`mcp::approval_wait`,
//!   capped by what the engine will hold a tool call for) and the call is
//!   denied with [`TOLD`]; the card becomes a one-line receipt.
//! - **Sign-ins and secure input** don't block a turn, so they close after
//!   [`CARD_EXPIRY_SECS`] as "Maybe later", and are never raised again on
//!   their own.
//!
//! An expired ask isn't raised again in the same task (until the user next
//! writes to that agent): keyed by what it asks for ([`key_for`]).
//! Expired cards are `expired`, so no badge, bar or sidebar counts them.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::store::{self, AgentMessage, Approval};

/// How long a card may wait for an answer. A card blocking a turn is also
/// bounded by the engine (Claude Code gives up on a tool call at 300s, so
/// its wait is `mcp::APPROVAL_WAIT_SECS`); anything still open past this is
/// closed by the sweep.
pub const CARD_EXPIRY_SECS: u64 = 600;

/// How often the sweep looks.
pub const SWEEP_EVERY_SECS: u64 = 60;

/// Why a card closed without an answer. Its status is `expired`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Expiry {
    /// Its turn ended, or the app restarted: nothing waits on it any more.
    MovedOn,
    /// The wait ran out while the turn was still blocked on it.
    NoAnswer,
    /// A sign-in or secure input nobody answered.
    MaybeLater,
}

/// What the agent is told when its card expired, or when it asks again for
/// something that already expired in this task.
pub const TOLD: &str = "No answer — ask again later if it still matters. The request expired and nothing was done. Don't retry it, don't work around it, and don't ask for it again in this task. Carry on without it; if you can't, say what's left in one line and stop.";

/// What an agent is told when it asks again for a sign-in or secure input
/// that became "Maybe later" in this task.
pub fn told_maybe_later(what: &str) -> String {
    format!("You already asked for {what} and the user didn't answer, so it's \"Maybe later\". Don't ask again in this task. Carry on without it; if you can't, say what's left in one line and stop.")
}

/* ------------------------------------------------------------- the dedupe */

static EXPIRED: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// What a card asks for, kind and target: the same ask gets the same key
/// however its wording around it varies.
pub fn key_for(a: &Approval) -> String {
    if let Some(s) = &a.secret {
        return secret_key(&s.name);
    }
    if let Some(l) = &a.login {
        return login_key(&l.service, &l.title);
    }
    if let Some(p) = &a.prompt {
        return format!("prompt:{}:{}", p.session_id, p.question);
    }
    match (&a.tool, &a.input) {
        (Some(tool), Some(input)) => tool_key(tool, input),
        _ => ask_key(&a.title, &a.detail),
    }
}

pub fn tool_key(tool: &str, input: &serde_json::Value) -> String {
    format!(
        "tool:{tool}:{}",
        super::mcp::describe_request(tool, input).1
    )
}

pub fn ask_key(title: &str, detail: &str) -> String {
    format!("ask:{title}\n{detail}")
}

pub fn secret_key(name: &str) -> String {
    format!("secret:{name}")
}

pub fn login_key(service: &str, title: &str) -> String {
    format!("login:{service}:{title}")
}

/// Remember that this ask expired unanswered in the agent's current task.
pub fn remember(agent_id: &str, key: String) {
    EXPIRED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .insert(key);
}

/// Whether this ask already expired unanswered in the agent's current task.
pub fn already_expired(agent_id: &str, key: &str) -> bool {
    EXPIRED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|keys| keys.contains(key))
}

/// The user wrote to the agent: a new task, so it may ask again.
pub fn new_task(agent_id: &str) {
    EXPIRED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

/* -------------------------------------------------------------- the rules */

/// When the sweep looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moment {
    /// The app just started: nothing that asked is still running.
    Launch,
    /// The agent's turn just ended.
    TurnEnded,
    /// The periodic look.
    Tick,
}

/// What happens to one pending card. `age_ms` is how long it has been up,
/// `waited_on` whether a tool call is still blocked on it.
pub fn verdict(a: &Approval, age_ms: i64, waited_on: bool, moment: Moment) -> Option<Expiry> {
    let overdue = age_ms >= (CARD_EXPIRY_SECS as i64) * 1000;
    // An import's own cards carry everything they show, and only exist
    // because the user started the import: they stay until answered.
    if a.connector.is_some() {
        return None;
    }
    // "Change these settings?" waits for the user: nothing blocks on it
    // (`propose_settings_change` returns at once), and Allow checks the
    // settings didn't change since (`policy_card::apply_proposal`).
    if a.settings.is_some() {
        return None;
    }
    // An outside assistant's handover carries everything it shows and
    // nothing waits on it (`agents/handoff.rs`): it stays until answered.
    if a.handoff.is_some() {
        return None;
    }
    // A routine's "OK to go on?" waits for the user however long they take:
    // nothing blocks on it, and its routine's next run closes it
    // (`agents/routine_steps.rs`).
    if a.gate.is_some() {
        return None;
    }
    // "Carry on with Codex until then?" is about the next turns, not a live
    // one: it stays until answered, or until the engine has room again
    // (`agents/crossover.rs`).
    if a.crossover.is_some() {
        return None;
    }
    // "Run turns on “Personal” first?": nothing waits on it, and the user
    // asked for the switch, so it stays until answered (`usage_tools`).
    if a.account_switch.is_some() {
        return None;
    }
    // "Reply in Slack?": nothing waits on it; it stays until answered.
    if a.slack_reply.is_some() {
        return None;
    }
    if let Some(s) = &a.secret {
        // An import's old-style secure input (before sign-in cards, which
        // replaced it): nothing raises these any more and nothing waits on
        // them, so they close at once instead of counting as "needs your OK".
        if s.quiet {
            return Some(Expiry::MaybeLater);
        }
        // Nobody waits on a secure input: saving it later still works, until it's overdue.
        return overdue.then_some(Expiry::MaybeLater);
    }
    // A step-in the user is in right now ends by hand-back or its own limit
    // (`agents/step_in.rs`), never by the sweep.
    if a.step_in.is_some() && crate::agent_browser::step_in::held_for(&a.request_id).is_some() {
        return None;
    }
    if a.login.is_some() || a.front.is_some() || a.step_in.is_some() {
        return (overdue || moment == Moment::Launch).then_some(Expiry::MaybeLater);
    }
    if a.prompt.is_some() {
        // A project session's question: the session may still be asking,
        // and can always be answered in its own tab.
        return match moment {
            Moment::Launch => Some(Expiry::MovedOn),
            _ => overdue.then_some(Expiry::NoAnswer),
        };
    }
    // A card a tool call (or the app's own confirmation) blocks on.
    match moment {
        Moment::Launch | Moment::TurnEnded => Some(Expiry::MovedOn),
        Moment::Tick if !waited_on => Some(Expiry::MovedOn),
        Moment::Tick => overdue.then_some(Expiry::NoAnswer),
    }
}

/// Close what [`verdict`] says to in one agent's chat; returns every copy
/// changed (a session's question is closed in each chat holding it).
pub fn sweep_store(
    agent_id: &str,
    moment: Moment,
    now: i64,
    waited_on: &dyn Fn(&str) -> bool,
) -> Vec<AgentMessage> {
    let Ok(open) = store::pending_card_messages(agent_id) else {
        return Vec::new();
    };
    let mut changed = Vec::new();
    for m in open {
        let Some(a) = m.approval.as_ref() else {
            continue;
        };
        let Some(expiry) = verdict(a, now - m.ts, waited_on(&a.request_id), moment) else {
            continue;
        };
        remember(agent_id, key_for(a));
        let chats = match &a.prompt {
            Some(p) if !p.chats.is_empty() => p.chats.clone(),
            _ => vec![agent_id.to_string()],
        };
        for chat in chats {
            if let Ok(Some(updated)) = store::expire_card(&chat, &a.request_id, expiry) {
                changed.push(updated);
            }
        }
    }
    changed
}

/// [`sweep_store`], told to the app: the cards redraw and the badges recount.
pub fn sweep_agent(app: &AppHandle, agent_id: &str, moment: Moment) {
    let changed = sweep_store(agent_id, moment, store::now_ms(), &|id| {
        super::mcp::is_waited_on(id)
    });
    if moment == Moment::Launch {
        // A count left by an older build is recounted from the log.
        store::refresh_pending(agent_id);
    }
    if changed.is_empty() {
        return;
    }
    if moment == Moment::TurnEnded {
        // A tool call still parked on one of them is let go: its card is closed.
        for m in &changed {
            if let Some(a) = &m.approval {
                super::mcp::drop_waiter(&a.request_id);
            }
        }
    }
    for m in &changed {
        store::refresh_pending(&m.agent_id);
        let _ = app.emit(super::runner::EVENT_MESSAGE, m);
    }
    let _ = app.emit(super::runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
}

/// Every agent's chat.
pub fn sweep_all(app: &AppHandle, moment: Moment) {
    let Ok(agents) = store::list() else { return };
    for agent in agents {
        sweep_agent(app, &agent.id, moment);
    }
    if moment == Moment::Launch {
        let _ = app.emit(super::runner::EVENT_REGISTRY, ());
        super::notify::refresh_badge(app);
    }
}

/// Look again every [`SWEEP_EVERY_SECS`], for as long as the app runs.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SWEEP_EVERY_SECS)).await;
            let app = app.clone();
            let _ =
                tauri::async_runtime::spawn_blocking(move || sweep_all(&app, Moment::Tick)).await;
        }
    });
}

#[cfg(test)]
#[path = "expiry_tests.rs"]
mod tests;
