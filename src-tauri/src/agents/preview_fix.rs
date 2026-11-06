//! A preview that stopped by itself goes back to the agent that owns it.
//!
//! The window's dev-server owner (`useDevServer`) sees the exit: its code and
//! what the server printed. It reports it here (`agents_dev_server_exited`)
//! with the agent whose preview pane shows that folder, if one does. Then:
//!
//! - **Whose it is.** The agent whose pane shows the folder, else the agent
//!   that last ran `preview_start` on it while that agent is working or the
//!   folder is its own copy. Nobody else: a server the user runs in the
//!   workspace stays the workspace's, and the pane keeps today's line.
//! - **One wake, then ask.** The owner is told, as a note from the app, with
//!   the reason and the last [`LOG_LINES`] lines, and woken if idle. At most
//!   one automatic wake per folder per [`WAKE_GAP_MS`]; inside that, or with
//!   the setting off, the pane offers "Ask <agent> to fix it" instead.
//! - **No loop.** Every fix (woken or asked) counts. A server that stops again
//!   after [`MAX_FIXES`] fixes isn't handed back again: the user gets one plain
//!   line in the agent's chat, and nothing more until a fix holds for
//!   [`HELD_MS`] or they ask again themselves.
//!
//! The pane reads where it stands from [`View`] (`agents://preview-fix`).

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::{project, runner, store};

pub const EVENT: &str = "agents://preview-fix";
/// At most one automatic wake per folder this often.
pub const WAKE_GAP_MS: i64 = 10 * 60_000;
/// Fixes after which a server that stops again goes to the user, not the agent.
pub const MAX_FIXES: u8 = 2;
/// A server that ran this long since it last stopped (or was last fixed) was
/// fixed: the count starts over.
pub const HELD_MS: i64 = 30 * 60_000;
/// How much of the server's output goes with the note.
pub const LOG_LINES: usize = 60;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// The owner was told and is (about to be) on it.
    Fixing,
    /// Nobody was woken: the user can ask.
    Ask,
    /// It kept stopping after [`MAX_FIXES`] fixes; the user was told.
    GaveUp,
}

/// What the pane shows for a stopped preview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub path: String,
    pub agent_id: String,
    pub agent_name: String,
    pub phase: Phase,
    /// Why it stopped, in a few words ("its port is already in use").
    pub reason: String,
    /// When the phase began.
    pub at: i64,
}

/// What happened to one folder's server so far.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ledger {
    /// The last automatic wake.
    pub last_wake: Option<i64>,
    /// Fixes since the count last started over.
    pub fixes: u8,
    /// The last fix, woken or asked.
    pub last_fix: Option<i64>,
    /// The last exit.
    pub last_exit: Option<i64>,
    /// The user was told it keeps stopping.
    pub gave_up: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Tell the owner and wake it.
    Wake,
    /// Wake nobody; the pane offers to ask.
    Ask,
    /// Tell the user, once.
    GiveUp,
    /// Already told the user; nothing more.
    Quiet,
}

/// What to do about one exit. Mutates the ledger as the decision implies.
pub fn on_exit(l: &mut Ledger, now: i64, auto: bool) -> Decision {
    let since = l.last_exit.max(l.last_fix);
    l.last_exit = Some(now);
    if since.is_some_and(|t| now - t > HELD_MS) {
        l.fixes = 0;
        l.gave_up = false;
    }
    if l.gave_up {
        return Decision::Quiet;
    }
    if l.fixes >= MAX_FIXES {
        l.gave_up = true;
        return Decision::GiveUp;
    }
    if !auto || l.last_wake.is_some_and(|t| now - t < WAKE_GAP_MS) {
        return Decision::Ask;
    }
    l.last_wake = Some(now);
    l.fixes += 1;
    l.last_fix = Some(now);
    Decision::Wake
}

/// The user pressed "Ask <agent> to fix it": a fix like any other, which
/// also lets a server they gave up on be handed back.
pub fn on_ask(l: &mut Ledger, now: i64) {
    l.gave_up = false;
    l.fixes = l.fixes.saturating_add(1);
    l.last_fix = Some(now);
}

/// Why it stopped, from what it printed first and its exit code second.
pub fn exit_reason(code: Option<i64>, output: &str) -> String {
    let low = output.to_lowercase();
    let port_taken = low.contains("eaddrinuse")
        || low.contains("address already in use")
        || (low.contains("port ") && (low.contains("is in use") || low.contains("already in use")));
    if port_taken {
        return "its port is already in use".into();
    }
    if low.contains("cannot find module")
        || low.contains("module not found")
        || low.contains("err_module_not_found")
    {
        return "a module it imports can't be found".into();
    }
    if low.contains("failed to compile")
        || low.contains("syntaxerror")
        || low.contains("error ts")
        || low.contains("build failed")
        || low.contains("compiled with errors")
        || low.contains("[plugin:vite")
    {
        return "a compile error".into();
    }
    match code {
        Some(137) | Some(-9) | Some(9) => "it was killed".into(),
        Some(143) | Some(-15) | Some(15) => "something outside the app stopped it".into(),
        Some(0) => "it exited on its own".into(),
        Some(n) => format!("it crashed (exit code {n})"),
        None => "it exited".into(),
    }
}

/// The note the owner is woken with.
pub fn fix_prompt(name: &str, copy: bool, reason: &str, tail: &str) -> String {
    let whose = if copy {
        format!("your copy of {name}")
    } else {
        name.to_string()
    };
    let printed = if tail.trim().is_empty() {
        "It printed nothing in this app's session; preview_logs may show more.".to_string()
    } else {
        // Never let what it printed close the fence.
        format!("Its last lines:\n```\n{}\n```", tail.replace("```", "'''"))
    };
    format!(
        "[From the app, not the user] Your preview for {whose} stopped: {reason}. Fix it and restart it with preview_start (project \"{name}\"). If it's already running again, say so in one line and stop. Don't ask the user; once it's running, tell them in one line what was wrong.\n\n{printed}"
    )
}

/// The one line the user gets when it keeps stopping.
pub fn gave_up_line(agent: &str, name: &str, reason: &str) -> String {
    format!(
        "The preview for {name} keeps stopping ({reason}). {agent} tried {MAX_FIXES} fixes and it still won't stay up, so it's waiting for you: ask {agent} again, or open it in the workspace to see why."
    )
}

// ============================================================================
// Who owns a folder's preview
// ============================================================================

#[derive(Default)]
struct Entry {
    /// The agent that last ran `preview_start` on it.
    starter: Option<String>,
    ledger: Ledger,
    view: Option<View>,
    reason: String,
    tail: String,
}

static ENTRIES: LazyLock<Mutex<HashMap<String, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn entries() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    ENTRIES.lock().unwrap_or_else(|e| e.into_inner())
}

fn key(path: &str) -> String {
    dunce::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.trim_end_matches('/').to_string())
}

/// `preview_start` ran on `path` for `agent_id`.
pub fn claim(path: &str, agent_id: &str) {
    entries().entry(key(path)).or_default().starter = Some(agent_id.to_string());
}

/// Who the exit goes to: the pane's agent, else the agent that started it
/// while it's working or the folder is its copy.
pub fn owner_of(
    pane_agent: Option<&str>,
    starter: Option<&str>,
    starter_working: bool,
    starter_copy_is_path: bool,
) -> Option<String> {
    if let Some(a) = pane_agent.filter(|a| !a.is_empty()) {
        return Some(a.to_string());
    }
    starter
        .filter(|_| starter_working || starter_copy_is_path)
        .map(str::to_string)
}

/// Where the pane stands for `path`, if an agent owns its stopped server.
pub fn view(path: &str) -> Option<View> {
    entries().get(&key(path)).and_then(|e| e.view.clone())
}

fn copy_is(agent: &store::Agent, path: &str) -> bool {
    agent
        .copy
        .as_ref()
        .is_some_and(|c| key(&c.path) == key(path))
}

/// The agent a stopped preview goes to, as far as the note needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    pub id: String,
    pub name: String,
    /// The project name its `preview_start` takes.
    pub project: String,
    /// The folder is its own copy of that project.
    pub copy: bool,
}

impl Owner {
    fn of(agent: &store::Agent, path: &str) -> Self {
        let (project, copy) = match agent.copy.as_ref().filter(|_| copy_is(agent, path)) {
            Some(c) => (project::folder_name(&c.project).to_string(), true),
            None => (project::folder_name(path).to_string(), false),
        };
        Owner {
            id: agent.id.clone(),
            name: agent.name.clone(),
            project,
            copy,
        }
    }
}

/// What an exit (or an ask) does outside this module.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Queue `prompt` for the agent, as a note from the app; it wakes if idle.
    Wake {
        agent_id: String,
        prompt: String,
    },
    /// One line in the agent's chat, for the user.
    Tell {
        agent_id: String,
        line: String,
    },
    Nothing,
}

/// Record an exit of `path`'s server for `owner` and say what follows.
pub fn record_exit(
    path: &str,
    owner: &Owner,
    exit_code: Option<i64>,
    output: &str,
    now: i64,
    auto: bool,
) -> (View, Effect) {
    let tail = super::project_tools::tail(output, LOG_LINES);
    let reason = exit_reason(exit_code, &tail);
    let mut all = entries();
    let e = all.entry(key(path)).or_default();
    let d = on_exit(&mut e.ledger, now, auto);
    e.reason = reason.clone();
    e.tail = tail.clone();
    let phase = match d {
        Decision::Wake => Phase::Fixing,
        Decision::Ask => Phase::Ask,
        Decision::GiveUp | Decision::Quiet => Phase::GaveUp,
    };
    let view = View {
        path: path.to_string(),
        agent_id: owner.id.clone(),
        agent_name: owner.name.clone(),
        phase,
        reason: reason.clone(),
        at: now,
    };
    e.view = Some(view.clone());
    let effect = match d {
        Decision::Wake => Effect::Wake {
            agent_id: owner.id.clone(),
            prompt: fix_prompt(&owner.project, owner.copy, &reason, &tail),
        },
        Decision::GiveUp => Effect::Tell {
            agent_id: owner.id.clone(),
            line: gave_up_line(&owner.name, &owner.project, &reason),
        },
        Decision::Ask | Decision::Quiet => Effect::Nothing,
    };
    (view, effect)
}

/// The user asked `owner` to fix `path`'s stopped server.
pub fn record_ask(path: &str, owner: &Owner, now: i64) -> Result<(View, Effect), String> {
    let mut all = entries();
    let e = all
        .get_mut(&key(path))
        .filter(|e| e.view.is_some())
        .ok_or_else(|| "That preview isn't stopped any more.".to_string())?;
    on_ask(&mut e.ledger, now);
    let view = View {
        path: path.to_string(),
        agent_id: owner.id.clone(),
        agent_name: owner.name.clone(),
        phase: Phase::Fixing,
        reason: e.reason.clone(),
        at: now,
    };
    e.view = Some(view.clone());
    let prompt = fix_prompt(&owner.project, owner.copy, &e.reason, &e.tail);
    Ok((
        view,
        Effect::Wake {
            agent_id: owner.id.clone(),
            prompt,
        },
    ))
}

/// The server is up again: nothing to show (the count stays, see [`HELD_MS`]).
pub fn running_again(path: &str) {
    if let Some(e) = entries().get_mut(&key(path)) {
        e.view = None;
    }
}

fn auto_fix_on() -> bool {
    crate::commands::setup::read_app_state()
        .agents_fix_previews
        .unwrap_or(true)
}

fn apply(app: &AppHandle, view: &View, effect: Effect) {
    match effect {
        Effect::Wake { agent_id, prompt } => {
            runner::enqueue(app, &agent_id, prompt, runner::From::User)
        }
        Effect::Tell { agent_id, line } => {
            let _ = runner::record(
                app,
                runner::new_message(&agent_id, store::MessageKind::Error, line),
            );
        }
        Effect::Nothing => {}
    }
    let _ = app.emit(EVENT, view);
}

/// A server stopped without anyone in the app asking it to. `None` when no
/// agent owns it (the pane keeps today's line).
pub fn exited(
    app: &AppHandle,
    path: &str,
    exit_code: Option<i64>,
    output: &str,
    pane_agent: Option<&str>,
) -> Option<View> {
    let starter = entries().get(&key(path)).and_then(|e| e.starter.clone());
    let starter_agent = starter.as_deref().and_then(|id| store::get(id).ok());
    let owner_id = owner_of(
        pane_agent,
        starter.as_deref(),
        starter
            .as_deref()
            .is_some_and(|id| runner::status_of(id).state != "idle"),
        starter_agent.as_ref().is_some_and(|a| copy_is(a, path)),
    )?;
    let owner = Owner::of(&store::get(&owner_id).ok()?, path);
    let (view, effect) = record_exit(
        path,
        &owner,
        exit_code,
        output,
        store::now_ms(),
        auto_fix_on(),
    );
    tracing::info!(path, phase = ?view.phase, agent = %owner.id, "[preview_fix] dev server stopped");
    apply(app, &view, effect);
    Some(view)
}

/// "Ask <agent> to fix it": the user's own message in the chat, then the
/// same note an automatic wake carries.
pub fn ask(app: &AppHandle, agent_id: &str, path: &str) -> Result<View, String> {
    let agent = store::get(agent_id).map_err(|e| e.to_string())?;
    let owner = Owner::of(&agent, path);
    let (view, effect) = record_ask(path, &owner, store::now_ms())?;
    let said = runner::new_message(
        &owner.id,
        store::MessageKind::User,
        format!("Fix the preview for {}", owner.project),
    );
    runner::record(app, said).map_err(|e| e.to_string())?;
    apply(app, &view, effect);
    Ok(view)
}

#[cfg(test)]
#[path = "preview_fix_tests.rs"]
mod tests;
