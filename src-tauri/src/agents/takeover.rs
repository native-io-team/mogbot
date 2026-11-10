//! Take over: the user steps into an agent's own session and drives it by
//! hand, in a terminal, then hands it back.
//!
//! - **Paused, not stopped.** While someone is driving, no turn starts
//!   (`runner::claim_for_takeover`): messages from the user, other agents and
//!   one-time check-ins wait in the agent's queue; a routine's run is skipped
//!   with a note in the chat (`schedule`). A turn already running means the
//!   session is in use, so the take-over is refused and the UI offers Stop
//!   and take over, or waiting.
//! - **One process per session.** The claim is made under the inbox lock,
//!   so it can't race a turn starting, a change of engine or project
//!   (`runner::update_settings`), or a delete ([`delete_agent`]); hand-back
//!   releases it only once the terminal's process tree is gone. The terminal
//!   runs the engine's own interactive CLI resumed on the agent's session,
//!   with the command line a turn gets minus what only a headless turn needs
//!   (`claude::interactive_args`, `codex::interactive_args`), in the turn's
//!   working directory with the turn's environment, so its tools, folders
//!   and identity are the ones the agent works with.
//! - **Handed back** with the button (which asks first while the terminal is
//!   printing), or by the terminal exiting. A note in the chat says how long
//!   ("You handed Finance back after 6 min"); if the session's transcript grew, the next
//!   turn is told first that the user worked in it (`prompts::handed_back`).
//!   A terminal that closed by itself within seconds, or failing, leaves its
//!   last lines in the chat instead, so the reason isn't lost.
//!
//! The PTY is spawned here, in Rust: its MCP URL carries the bridge token
//! and its environment the agent's secrets, and neither enters the webview.
//! It is kept out of the project's session list (no project in its
//! metadata), so remote access and other agents can't type into it, and its
//! id ([`PTY_PREFIX`]) keeps a tab from ever respawning it or saving it.
//!
//! What survives a quit or crash is one mark, `<home>/takeover.json` (the
//! CLI's pid and session): the next launch stops that CLI if it outlived the
//! app ([`recover_after_restart`]) and says so in the chat.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::engine::Engine;
use super::runner::{self, Claim};
use super::store::{self, MessageKind};
use crate::commands::pty_session;
use crate::errors::CommandError;

/// Every take-over terminal's PTY id starts with this.
pub const PTY_PREFIX: &str = "takeover-";

/// A PTY session id that belongs to a take-over.
pub fn is_takeover_pty(id: &str) -> bool {
    id.starts_with(PTY_PREFIX)
}

/// What the UI is told about a take-over in progress (`AgentView.takeover`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// When it began (epoch ms).
    pub since: i64,
    /// The backend PTY session the terminal shows.
    pub pty_session: String,
    /// A bound agent's project: the terminal is a tab in its workspace.
    /// Otherwise the chat shows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The workspace's id for the CLI, for the tab that shows it.
    pub cli: &'static str,
    /// Claude Code hasn't recorded this folder as trusted, so it will ask
    /// first; omitted otherwise.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub trust_prompt: bool,
}

struct Driving {
    view: View,
    pid: u32,
    /// The agent's session id: what identifies its CLI on a command line.
    session: String,
    engine: Engine,
    /// The session's transcript size when the terminal opened.
    transcript: Option<u64>,
    /// The terminal's bridge secret, revoked when this goes (hand-back).
    _access: super::broker::Access,
    /// Claude Code's config file holding it, removed with it.
    _mcp_config: Option<super::reach::ConfigFile>,
    /// The account it runs on, held: removing it waits for the hand-back.
    _account: super::wallet::InUse,
}

static DRIVING: LazyLock<Mutex<HashMap<String, Driving>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn driving() -> std::sync::MutexGuard<'static, HashMap<String, Driving>> {
    DRIVING.lock().unwrap_or_else(|e| e.into_inner())
}

/// The take-over in progress for this agent, if any.
pub fn view(agent_id: &str) -> Option<View> {
    driving().get(agent_id).map(|d| d.view.clone())
}

/// The take-overs running in `project`'s workspace: (PTY id, CLI id). A
/// project's restored tabs get these and nothing else of a take-over's.
pub fn live_tabs_for(project: &str) -> Vec<(String, &'static str)> {
    let want = same_path_key(project);
    driving()
        .values()
        .filter(|d| {
            d.view
                .project
                .as_deref()
                .is_some_and(|p| same_path_key(p) == want)
        })
        .map(|d| (d.view.pty_session.clone(), d.view.cli))
        .collect()
}

fn same_path_key(path: &str) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// A process to run in the terminal.
#[derive(Debug, Clone, PartialEq)]
pub struct Spawn {
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub env_remove: Vec<String>,
}

/// What a turn's process gets that the terminal must get too.
pub struct Context<'a> {
    pub engine: Engine,
    pub model: Option<&'a str>,
    pub session: &'a str,
    /// The agents endpoint (names no one; Codex reads the secret from env).
    pub url: &'a str,
    /// Claude Code: the path of the 0600 config file with the secret.
    pub mcp_config: &'a str,
    /// The terminal's bridge secret, for Codex's environment.
    pub secret: &'a str,
    /// Codex with permission profiles: folders kept read-only.
    pub protected: Option<&'a [PathBuf]>,
    /// Codex: its connection and browser servers, as a turn's `-c` values
    /// (`connections::TurnAccess::codex_config`). Claude Code's are in its
    /// config file.
    pub codex_servers: &'a [String],
    /// With the secrets section, as a turn's.
    pub system_prompt: &'a str,
    pub layout: &'a super::project::Layout,
    pub path: String,
    pub secrets: Vec<(String, String)>,
    /// The app's own environment's names (`std::env::vars`).
    pub inherited: Vec<String>,
}

/// The terminal's process: the engine's interactive CLI on the agent's
/// session, as `runner::run_turn` would have run its turn.
pub fn spawn_for(ctx: &Context) -> Spawn {
    let cwd = ctx.layout.cwd.to_string_lossy().into_owned();
    let args = match ctx.engine {
        Engine::Claude => super::claude::interactive_args(
            ctx.model,
            ctx.session,
            ctx.mcp_config,
            ctx.system_prompt,
            &ctx.layout.add_dirs,
        ),
        Engine::Codex => {
            let mut args = super::codex::interactive_args(
                ctx.model,
                ctx.session,
                ctx.url,
                &super::prompts::for_codex_exec(ctx.system_prompt),
                &ctx.layout.add_dirs,
                ctx.protected,
                &cwd,
            );
            // Its apps and browsers, as a turn has them: with the other
            // overrides, ahead of `-C <cwd> <thread>`.
            let at = args.iter().position(|a| a == "-C").unwrap_or(args.len());
            let servers = ctx
                .codex_servers
                .iter()
                .flat_map(|c| ["-c".to_string(), c.clone()]);
            args.splice(at..at, servers);
            args
        }
    };
    let mut env = BTreeMap::new();
    env.insert("PATH".to_string(), ctx.path.clone());
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    // As a turn: an MCP call (our cards) may wait on a person.
    env.insert(
        "MCP_TOOL_TIMEOUT".to_string(),
        ((super::mcp::APPROVAL_WAIT_SECS + 60) * 1000).to_string(),
    );
    env.extend(ctx.secrets.iter().cloned());
    if ctx.engine == Engine::Codex {
        env.insert(super::reach::TOKEN_ENV.to_string(), ctx.secret.to_string());
    }
    Spawn {
        args,
        cwd,
        env,
        // The same list `runner::strip_session_env` removes from a turn.
        env_remove: runner::session_vars(ctx.inherited.iter().cloned()),
    }
}

/// "6 min", "less than a minute", "1 h 5 min".
pub fn took(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    match minutes {
        0 => "less than a minute".to_string(),
        m if m < 60 => format!("{m} min"),
        m if m % 60 == 0 => format!("{} h", m / 60),
        m => format!("{} h {} min", m / 60, m % 60),
    }
}

/// The note hand-back leaves in the chat: "You handed Finance back after 6 min".
pub fn took_line(name: &str, ms: i64) -> String {
    format!("You handed {name} back after {}", took(ms))
}

/// A terminal that closed by itself this soon didn't get used: it was
/// refused (the trust question answered No, a flag, a crash).
const EARLY_EXIT_MS: i64 = 10_000;

/// Whether the terminal's end needs explaining rather than a hand-back note:
/// it closed by itself within seconds, or failing.
pub fn ended_early(by_itself: bool, ms: i64, exit_code: Option<i32>) -> bool {
    by_itself && (ms < EARLY_EXIT_MS || exit_code.is_some_and(|c| c != 0))
}

/// The line an early exit records: a quiet note, not an error. The agent
/// didn't fail, so nothing offers a Retry, alerts, marks it failed, or has
/// peers and the phone say it "didn't finish". Redacted: it quotes a screen.
pub fn early_exit_message(agent_id: &str, text: &str) -> store::AgentMessage {
    let mut line = runner::new_message(
        agent_id,
        MessageKind::Note,
        super::secrets::redact(text).into_owned(),
    );
    line.takeover = true;
    line
}

/// The chat's note for a terminal that ended early, with what it
/// last showed.
pub fn early_exit_line(
    engine: Engine,
    name: &str,
    ms: i64,
    exit_code: Option<i32>,
    tail: &[String],
) -> String {
    let secs = ms.max(0) / 1000;
    let when = if ms < 60_000 {
        match secs {
            0 | 1 => "after a second".to_string(),
            s => format!("after {s} seconds"),
        }
    } else {
        format!("after {}", took(ms))
    };
    // Whether it failed decides that this note is written (`ended_early`);
    // the code itself is the engine's business, never the user's.
    let _ = exit_code;
    let mut line = format!(
        "{} closed {when}, so you're back in the chat and {name} carries on from here.",
        engine.label()
    );
    if tail.is_empty() {
        line.push_str(" It printed nothing.");
    } else {
        // After a blank line, verbatim: the chat shows it as the screen.
        line.push_str(" The last thing it showed:\n\n");
        line.push_str(&tail.join("\n"));
    }
    line
}

/// How many of the terminal's last lines an early exit quotes.
const EXIT_TAIL_LINES: usize = 12;

fn refused(name: &str, claim: Claim) -> CommandError {
    match claim {
        Claim::Busy => CommandError::expected(format!(
            "{name} is working. Stop it and take over, or wait until it's done."
        )),
        Claim::Driven => CommandError::expected(format!("You're already driving {name}.")),
    }
}

/// Pause the agent and open its session in a terminal. Idempotent: an
/// agent already being driven gives the take-over in progress, including
/// while another call is still opening it (a double click).
pub async fn begin(
    app: &AppHandle,
    agent_id: &str,
    cols: u16,
    rows: u16,
    conversation: Option<&str>,
) -> Result<View, CommandError> {
    if let Some(view) = view(agent_id) {
        return Ok(view);
    }
    let name = store::get(agent_id)?.name;
    if let Err(claim) = runner::claim_for_takeover(agent_id) {
        if claim == Claim::Driven {
            // Another call is opening it: that one's view is this one's.
            wait_until(Duration::from_secs(20), || {
                view(agent_id).is_some() || !runner::driven(agent_id)
            })
            .await;
            if let Some(view) = view(agent_id) {
                return Ok(view);
            }
        }
        return Err(refused(&name, claim));
    }
    // The conversation on screen is the one driven: its session is loaded
    // while the claim keeps every turn out (`conversations::swap`).
    if let Some(c) = conversation.filter(|c| super::conversations::exists(agent_id, c)) {
        let _ = store::update(agent_id, |a| {
            super::conversations::swap(a, c);
        });
    }
    // Read under the claim: an engine or project change is refused from
    // here on (`runner::update_settings`), so this is what it stays.
    match claimed(app, agent_id, cols, rows).await {
        Ok(view) => {
            // Deleted while it opened: it ends here, not as a ghost.
            if store::get(agent_id).is_err() {
                abandon(app, agent_id).await;
                return Err(CommandError::expected("That agent no longer exists."));
            }
            let _ = app.emit(runner::EVENT_REGISTRY, ());
            Ok(view)
        }
        Err(e) => {
            // Nothing was started: the agent carries on as it was.
            runner::release_takeover(app, agent_id, None, false);
            Err(e)
        }
    }
}

async fn claimed(
    app: &AppHandle,
    agent_id: &str,
    cols: u16,
    rows: u16,
) -> Result<View, CommandError> {
    let agent = store::get(agent_id)?;
    let Some(session) = agent.session_id.clone().filter(|s| !s.is_empty()) else {
        return Err(CommandError::expected(format!(
            "{} hasn't started a conversation yet, so there's nothing to take over. Send it a message first.",
            agent.name
        )));
    };
    let binary = super::engine::binary(agent.engine).await.ok_or_else(|| {
        CommandError::expected(format!(
            "{} isn't installed, or the app can't find it.",
            agent.engine.label()
        ))
    })?;
    open(app, &agent, &session, &binary, cols, rows).await
}

async fn open(
    app: &AppHandle,
    agent: &store::Agent,
    session: &str,
    binary: &std::path::Path,
    cols: u16,
    rows: u16,
) -> Result<View, CommandError> {
    let home = store::agent_home(&agent.id)?;
    let layout = super::project::layout(agent, &home, runner::work_dirs());
    if let Some(project) = &layout.project {
        if !project.is_dir() {
            return Err(CommandError::expected(format!(
                "{} works in {}, which isn't there any more.",
                agent.name,
                project.display()
            )));
        }
    }
    // With a copy open the terminal runs in it, as a turn would; a copy
    // whose folder went is no place to resume the conversation.
    if let Some(copy) = &layout.copy {
        if !layout.cwd.is_dir() {
            return Err(CommandError::expected(format!(
                "{}'s copy of {} isn't there any more.",
                agent.name,
                super::project::folder_name(&copy.project)
            )));
        }
    }
    let (port, _) = crate::agent_bridge::start_global_agent_bridge(app.clone())
        .await
        .map_err(super::err_other)?;
    // A secret with no turn: the approval tool is only for a headless turn.
    // Here the CLI asks in the terminal, and anything that asks the broker is
    // refused. It's revoked when the terminal is handed back.
    let access = super::broker::grant(&agent.id, None);
    let url = super::reach::agent_url(port);
    // Its connection servers too, on either engine, so taking over doesn't
    // lose the apps it was granted. Blocks and `--no-chrome` aren't applied
    // here: the person at the keyboard answers every prompt themselves.
    let reach = super::connections::for_turn(agent, port, false).await;
    let codex_servers = match agent.engine {
        Engine::Codex => reach.codex_config(),
        Engine::Claude => Vec::new(),
    };
    let mcp_config = match agent.engine {
        Engine::Claude => Some(super::reach::write_config(
            &super::reach::claude_config_with(
                &url,
                access.secret(),
                reach.claude_servers(access.secret()),
            ),
        )?),
        Engine::Codex => None,
    };
    let mcp_config_arg = mcp_config
        .as_ref()
        .map(super::reach::ConfigFile::arg)
        .unwrap_or_default();
    let protected = (agent.engine == Engine::Codex
        && super::codex::profiles_supported(binary).await)
        .then(|| {
            let mut roots: Vec<PathBuf> = layout.add_dirs.iter().map(PathBuf::from).collect();
            roots.push(layout.cwd.clone());
            super::reach::protected_paths(&roots)
        });
    let secrets = super::secrets::env_for(agent);
    let mut system_prompt = runner::system_prompt_for(agent, &home, &layout);
    let have = super::secrets::prompt_section(agent, &secrets);
    if !have.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&have);
    }
    if !reach.prompt.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&reach.prompt);
    }
    // The terminal drives the session on the account its turns last ran on.
    // Held while the terminal is open: removing the account waits for it.
    let (account, held) = {
        let first = super::wallet::last_account(agent.engine, &agent.id);
        match super::wallet::hold(&first, &agent.id) {
            Some(held) => (first, held),
            // Removed just now: the account it falls back to.
            None => {
                let next = super::wallet::last_account(agent.engine, &agent.id);
                let held = super::wallet::hold(&next, &agent.id).ok_or_else(|| {
                    CommandError::expected("Its account was just removed. Try again.")
                })?;
                (next, held)
            }
        }
    };
    super::wallet::prepare(&account);
    super::transcript::ensure(&account, &layout.cwd, &home, session);
    let account_env = super::wallet::env_for(&account);
    let spawn = spawn_for(&Context {
        engine: agent.engine,
        model: agent.model.as_deref(),
        session,
        url: &url,
        mcp_config: &mcp_config_arg,
        secret: access.secret(),
        protected: protected.as_deref(),
        codex_servers: &codex_servers,
        system_prompt: &system_prompt,
        layout: &layout,
        path: crate::utils::get_extended_path(),
        // The agent's secrets, and the account it last ran on (never named
        // in the prompt: it isn't the agent's to use).
        secrets: secrets.into_iter().chain(account_env).collect(),
        inherited: std::env::vars_os()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect(),
    });
    // Read-only: Claude Code's own answer to its trust question. Never
    // written here; the person at the keyboard answers it.
    let trust_prompt = agent.engine == Engine::Claude
        && !super::wallet::claude_config_for(&account)
            .is_some_and(|config| super::decisions::trusted(&config, &layout.cwd));
    let transcript = transcript_len(agent.engine, session);
    let pty = format!("{PTY_PREFIX}{}", uuid::Uuid::new_v4());
    let opened = pty_session::open_session(
        app.clone(),
        pty_session::OpenSpec {
            session_id: pty.clone(),
            command: binary.to_string_lossy().into_owned(),
            args: spawn.args,
            cwd: Some(spawn.cwd),
            env: spawn.env,
            env_remove: spawn.env_remove,
            cols,
            rows,
            // Not a project tab as far as remote access and other agents'
            // session tools are concerned: only the user types here.
            project_path: None,
            agent_id: None,
            account_env: false,
        },
    )
    .await?;
    write_mark(
        &agent.id,
        &Mark {
            pid: opened.pid,
            session: session.to_string(),
        },
    );
    let view = View {
        since: store::now_ms(),
        pty_session: pty.clone(),
        project: agent.project.clone(),
        cli: match agent.engine {
            Engine::Claude => "claude-code",
            Engine::Codex => "codex",
        },
        trust_prompt,
    };
    driving().insert(
        agent.id.clone(),
        Driving {
            view: view.clone(),
            pid: opened.pid,
            session: session.to_string(),
            engine: agent.engine,
            transcript,
            _access: access,
            _mcp_config: mcp_config,
            _account: held,
        },
    );
    tracing::info!(agent = %agent.id, pid = opened.pid, "[Agents] taken over in a terminal");
    watch(app.clone(), agent.id.clone(), pty, opened.pid);
    Ok(view)
}

/// Whether the take-over's own process is still running in `pty`. A
/// session under that id with another pid isn't it.
fn ours_alive(pty: &str, pid: u32) -> bool {
    pty_session::session_snapshot(pty).is_some_and(|s| s.alive && s.pid == pid)
}

/// Hand back when the terminal's process exits on its own (`/exit`, a
/// crash, the workspace tab's ×).
fn watch(app: AppHandle, agent_id: String, pty: String, pid: u32) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let current = driving()
                .get(&agent_id)
                .is_some_and(|d| d.view.pty_session == pty);
            if !current {
                return;
            }
            if !ours_alive(&pty, pid) {
                finish(&app, &agent_id, Some(&pty), End::Exited).await;
                return;
            }
        }
    });
}

/// How `hand_back` went.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HandBack {
    HandedBack,
    /// Nobody was driving it.
    NotDriving,
    /// The terminal printed something within the last moment: it is likely
    /// mid-response. Not handed back; ask, then pass `force`.
    Busy,
}

/// Output this recent means the CLI is in the middle of something.
const BUSY_WITHIN_MS: u64 = 2_000;

/// Whether a terminal that last printed at `last_output_ms` is busy at `now_ms`.
pub fn mid_output(last_output_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last_output_ms) < BUSY_WITHIN_MS
}

/// Hand the session back to the agent: the terminal's process ends, the
/// agent resumes. Unless `force`, refused while the terminal is printing.
pub async fn hand_back(app: &AppHandle, agent_id: &str, force: bool) -> HandBack {
    let Some((pty, pid)) = driving()
        .get(agent_id)
        .map(|d| (d.view.pty_session.clone(), d.pid))
    else {
        return HandBack::NotDriving;
    };
    if !force {
        let now = store::now_ms().max(0) as u64;
        let busy = pty_session::session_snapshot(&pty)
            .is_some_and(|s| s.alive && s.pid == pid && mid_output(s.last_output_ms, now));
        if busy {
            return HandBack::Busy;
        }
    }
    if finish(app, agent_id, None, End::HandBack).await {
        HandBack::HandedBack
    } else {
        HandBack::NotDriving
    }
}

/// End a take-over without a note or a next turn, dropping what waited:
/// the agent is being deleted.
pub async fn abandon(app: &AppHandle, agent_id: &str) {
    finish(app, agent_id, None, End::Abandon).await;
}

/// Delete an agent, for the editor and the Chief's `delete_agent` alike:
/// its turn is stopped first (its queue cleared), then a take-over ended,
/// so nothing can start a turn for it on the way out; a take-over that
/// finished opening meanwhile is ended after (see [`begin`]).
pub async fn delete_agent(app: &AppHandle, agent_id: &str) -> Result<store::Agent, CommandError> {
    // Refused before anything is stopped.
    if store::get(agent_id).is_ok_and(|a| a.is_main) {
        return Err(CommandError::expected(
            "The Chief of Staff can't be deleted.",
        ));
    }
    // Closes its queue too: nothing sent to it while the delete waits below
    // starts a turn (whoever sent it is told it won't be done).
    runner::stop_for_delete(app, agent_id);
    abandon(app, agent_id).await;
    // What its dying turn records lands before its folder goes (and a line
    // recorded after that is refused: `store::append_message`).
    runner::wait_until_idle(agent_id, Duration::from_secs(3)).await;
    let removed = match store::delete(agent_id) {
        Ok(removed) => removed,
        Err(e) => {
            runner::undelete(agent_id);
            return Err(e);
        }
    };
    abandon(app, agent_id).await;
    runner::forget(agent_id);
    // Its windows in the agents' browser close with it.
    let id = agent_id.to_string();
    let _ =
        tokio::task::spawn_blocking(move || crate::agent_browser::tools::close_agent(&id)).await;
    super::wallet::forget_agent(agent_id);
    Ok(removed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum End {
    /// The button.
    HandBack,
    /// The terminal's process ended by itself.
    Exited,
    /// The agent is being deleted.
    Abandon,
}

async fn finish(app: &AppHandle, agent_id: &str, pty: Option<&str>, end: End) -> bool {
    let driving = {
        let mut all = driving();
        match all.get(agent_id) {
            Some(d) if pty.is_none_or(|p| p == d.view.pty_session) => all.remove(agent_id),
            _ => None,
        }
    };
    let Some(d) = driving else {
        return false;
    };
    let ms = store::now_ms() - d.view.since;
    // What it last showed, and how it ended, before the PTY is released.
    if end == End::Exited {
        wait_until(Duration::from_millis(500), || {
            pty_session::session_snapshot(&d.view.pty_session)
                .is_none_or(|s| s.pid != d.pid || s.exit_code.is_some())
        })
        .await;
    }
    let last = pty_session::session_snapshot(&d.view.pty_session).filter(|s| s.pid == d.pid);
    stop_terminal(&d).await;
    clear_mark(agent_id);
    if let Some(project) = &d.view.project {
        // The workspace tab that showed it goes, as its × would.
        let payload =
            serde_json::json!({ "projectPath": project, "sessionId": d.view.pty_session });
        let window = crate::remote_access::tools::window_for(project);
        let _ = app.emit_to(&window, "remote-close-agent", payload);
    }
    match end {
        End::Abandon => runner::release_takeover(app, agent_id, None, true),
        _ => {
            let exit_code = last.as_ref().and_then(|s| s.exit_code);
            let told = if ended_early(end == End::Exited, ms, exit_code) {
                let name = store::get(agent_id).map(|a| a.name).unwrap_or_default();
                let tail = last
                    .as_ref()
                    .map(|s| {
                        crate::remote_access::screen::render_tail(
                            &s.bytes,
                            s.rows,
                            s.cols,
                            EXIT_TAIL_LINES,
                        )
                    })
                    .unwrap_or_default();
                let text = early_exit_line(d.engine, &name, ms, exit_code, &tail);
                let _ = runner::record(app, early_exit_message(agent_id, &text));
                None
            } else {
                let name = store::get(agent_id).map(|a| a.name).unwrap_or_default();
                let line = runner::new_message(agent_id, MessageKind::Note, took_line(&name, ms));
                let _ = runner::record(app, line);
                // Told only if the conversation has something new in it.
                grew(d.transcript, transcript_len(d.engine, &d.session))
                    .then(|| super::prompts::handed_back(&took(ms)))
            };
            runner::release_takeover(app, agent_id, told, false);
        }
    }
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    tracing::info!(agent = %agent_id, ?end, "[Agents] handed back");
    true
}

/// End the terminal's process and everything it started, and wait until
/// it's gone: only then may a turn use the session again.
async fn stop_terminal(d: &Driving) {
    let pty = d.view.pty_session.as_str();
    let alive = || ours_alive(pty, d.pid);
    if alive() {
        // Ctrl-C is how both CLIs quit, saving the conversation as they go.
        // Claude Code's first clears what's typed and its second only arms
        // "press again to exit", hence three, unhurried.
        for _ in 0..3 {
            if !alive() {
                break;
            }
            let _ = pty_session::pty_session_write(pty.to_string(), vec![3]);
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        wait_until(Duration::from_secs(5), || !alive()).await;
    }
    // Only a process that is still this take-over's CLI (its session on the
    // command line) is killed: a pid that already exited may be reused.
    if alive() {
        runner::stop_orphan(d.pid, &d.session).await;
        wait_until(Duration::from_secs(3), || !alive()).await;
    }
    // Releases the pseudo-terminal (hanging up anything left in it); a
    // no-op for one already gone. Never a session someone else opened.
    if pty_session::session_snapshot(pty).is_none_or(|s| s.pid == d.pid) {
        let _ = pty_session::pty_session_kill(pty.to_string());
    }
}

async fn wait_until(limit: Duration, done: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + limit;
    while !done() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ============================================================================
// Whether the session has anything new
// ============================================================================

/// The transcript grew while the user drove (or appeared): there is
/// something in the conversation for the next turn to be told about.
pub fn grew(before: Option<u64>, after: Option<u64>) -> bool {
    after > before
}

/// The size of the session's transcript on disk, as its engine writes it.
fn transcript_len(engine: Engine, session: &str) -> Option<u64> {
    // In every account's folder of the engine (`agents::wallet`), summed:
    // the session is on whichever one it ran on.
    super::wallet::engine_folders(engine)
        .iter()
        .filter_map(|root| match engine {
            Engine::Claude => claude_transcript_len(root, session),
            Engine::Codex => codex_transcript_len(root, session),
        })
        .reduce(|a, b| a + b)
}

/// `<config>/projects/<folder>/<session>.jsonl`, in whichever folder
/// Claude Code filed it under.
fn claude_transcript_len(config: &Path, session: &str) -> Option<u64> {
    let name = format!("{session}.jsonl");
    std::fs::read_dir(config.join("projects"))
        .ok()?
        .flatten()
        .filter_map(|dir| std::fs::metadata(dir.path().join(&name)).ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .reduce(|a, b| a + b)
}

/// `<codex home>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`.
fn codex_transcript_len(home: &Path, thread: &str) -> Option<u64> {
    let suffix = format!("-{thread}.jsonl");
    let mut total = None;
    let mut dirs = vec![(home.join("sessions"), 0)];
    while let Some((dir, depth)) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() && depth < 3 {
                dirs.push((path, depth + 1));
            } else if meta.is_file()
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().ends_with(&suffix))
            {
                total = Some(total.unwrap_or(0) + meta.len());
            }
        }
    }
    total
}

// ============================================================================
// The mark a take-over leaves on disk
// ============================================================================

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Mark {
    pid: u32,
    session: String,
}

fn mark_path(agent_id: &str) -> Option<PathBuf> {
    store::agent_home(agent_id)
        .ok()
        .map(|h| h.join("takeover.json"))
}

fn write_mark(agent_id: &str, mark: &Mark) {
    if let (Some(path), Ok(json)) = (mark_path(agent_id), serde_json::to_vec(mark)) {
        let _ = std::fs::write(path, json);
    }
}

fn read_mark(agent_id: &str) -> Option<Mark> {
    let raw = std::fs::read_to_string(mark_path(agent_id)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn clear_mark(agent_id: &str) {
    if let Some(path) = mark_path(agent_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// The note a take-over the app closed during leaves at the next launch.
pub fn closed_line(name: &str) -> String {
    format!("The app closed while you were driving {name} in a terminal, so you're back in the chat. {name} carries on from here.")
}

/// At launch: a take-over the last run never handed back. Its CLI can
/// outlive the app and would write the same session as the next turn, so it
/// is stopped (only while it is still that CLI: `runner::stop_orphan`).
/// Whether the last run left a take-over's mark for this agent.
pub fn left_over(agent_id: &str) -> bool {
    mark_path(agent_id).is_some_and(|p| p.exists())
}

pub async fn recover_after_restart(app: &AppHandle, agent: &store::Agent) {
    let Some(path) = mark_path(&agent.id).filter(|p| p.exists()) else {
        return;
    };
    let mark = read_mark(&agent.id);
    if let Some(mark) = &mark {
        if mark.pid != 0 && !mark.session.is_empty() {
            runner::stop_orphan(mark.pid, &mark.session).await;
        }
    }
    let _ = std::fs::remove_file(path);
    let line = runner::new_message(&agent.id, MessageKind::Note, closed_line(&agent.name));
    let _ = runner::record(app, line);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn layout(project: Option<&str>) -> super::super::project::Layout {
        super::super::project::Layout {
            cwd: PathBuf::from(project.unwrap_or("/u/agents/a1")),
            add_dirs: vec!["/u/agents/a1".into(), "/u/ShipStudio".into()],
            project: project.map(PathBuf::from),
            copy: None,
        }
    }

    fn ctx<'a>(
        engine: Engine,
        layout: &'a super::super::project::Layout,
        inherited: Vec<String>,
    ) -> Context<'a> {
        Context {
            engine,
            model: Some("m1"),
            session: "sess-1",
            url: "http://127.0.0.1:9/mcp/agent",
            mcp_config: "/s/agent-bridge/mcp-a1.json",
            secret: "s3cret",
            protected: None,
            codex_servers: &[],
            system_prompt: "you are Finance",
            layout,
            path: "/opt/bin:/usr/bin".into(),
            secrets: vec![("STRIPE_KEY".into(), "sk_x".into())],
            inherited,
        }
    }

    #[test]
    fn claude_resumes_the_agents_session_in_its_working_dir_with_its_environment() {
        let l = layout(None);
        let s = spawn_for(&ctx(
            Engine::Claude,
            &l,
            vec![
                "HOME".into(),
                "CLAUDECODE".into(),
                "CLAUDE_CODE_ENTRYPOINT".into(),
                "CLAUDE_PID".into(),
            ],
        ));
        assert_eq!(
            s.args,
            super::super::claude::interactive_args(
                Some("m1"),
                "sess-1",
                "/s/agent-bridge/mcp-a1.json",
                "you are Finance",
                &l.add_dirs
            )
        );
        // Claude reads its secret from the config file, not the environment.
        assert!(!s.env.contains_key(super::super::reach::TOKEN_ENV));
        assert!(!s.args.iter().any(|a| a.contains("s3cret")));
        assert!(s.args.windows(2).any(|w| w == ["--resume", "sess-1"]));
        assert!(!s.args.contains(&"--print".to_string()));
        assert_eq!(s.cwd, "/u/agents/a1");
        assert_eq!(s.env["PATH"], "/opt/bin:/usr/bin");
        assert_eq!(s.env["STRIPE_KEY"], "sk_x");
        assert_eq!(
            s.env["MCP_TOOL_TIMEOUT"],
            ((super::super::mcp::APPROVAL_WAIT_SECS + 60) * 1000).to_string()
        );
        // The nested-session variables a turn strips, and nothing else.
        assert_eq!(
            s.env_remove,
            vec!["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID"]
        );
    }

    #[test]
    fn with_a_copy_open_the_terminal_runs_in_the_copy_as_a_turn_would() {
        let mut agent: store::Agent = serde_json::from_value(serde_json::json!({
            "id": "a1", "name": "Acme", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        agent.project = Some("/u/ShipStudio/acme".into());
        agent.copy = Some(super::super::task::TaskCopy {
            id: "c".into(),
            project: "/u/ShipStudio/acme".into(),
            path: "/u/ShipStudio/.worktrees/acme/acme-blue-c".into(),
            branch: "acme/blue-c".into(),
            base: "abc".into(),
            base_branch: Some("main".into()),
            created_at: 0,
            deps: false,
            stuck: None,
        });
        let l = super::super::project::layout(
            &agent,
            Path::new("/u/agents/a1"),
            vec!["/u/ShipStudio/acme".into()],
        );
        let claude = spawn_for(&ctx(Engine::Claude, &l, vec![]));
        assert_eq!(claude.cwd, "/u/ShipStudio/.worktrees/acme/acme-blue-c");
        let codex = spawn_for(&ctx(Engine::Codex, &l, vec![]));
        assert!(codex
            .args
            .windows(2)
            .any(|w| w == ["-C", "/u/ShipStudio/.worktrees/acme/acme-blue-c"]));

        // Working directly, it's the project again.
        agent.work_directly = true;
        let l = super::super::project::layout(&agent, Path::new("/u/agents/a1"), vec![]);
        assert_eq!(
            spawn_for(&ctx(Engine::Claude, &l, vec![])).cwd,
            "/u/ShipStudio/acme"
        );
    }

    #[test]
    fn a_bound_agent_is_driven_in_its_project_and_codex_resumes_its_thread() {
        let l = layout(Some("/u/ShipStudio/acme"));
        let claude = spawn_for(&ctx(Engine::Claude, &l, vec![]));
        assert_eq!(claude.cwd, "/u/ShipStudio/acme");

        let codex = spawn_for(&ctx(Engine::Codex, &l, vec![]));
        assert_eq!(codex.args[0], "resume");
        assert_eq!(codex.args.last().map(String::as_str), Some("sess-1"));
        assert!(codex
            .args
            .windows(2)
            .any(|w| w == ["-C", "/u/ShipStudio/acme"]));
        assert!(codex.args.windows(2).any(|w| w == ["-m", "m1"]));
        // A turn's sandbox and our server, and asking rather than refusing.
        for want in [
            "sandbox_mode=\"workspace-write\"",
            "approval_policy=\"on-request\"",
            "sandbox_workspace_write.network_access=false",
        ] {
            assert!(
                codex.args.windows(2).any(|w| w[0] == "-c" && w[1] == want),
                "{want}"
            );
        }
        assert!(codex
            .args
            .iter()
            .any(|a| a.starts_with("mcp_servers.") && a.contains("/mcp/agent")));
        // The secret is in the terminal's environment, never its arguments.
        assert_eq!(codex.env[super::super::reach::TOKEN_ENV], "s3cret");
        assert!(!codex.args.iter().any(|a| a.contains("s3cret")));
        // Its identity and secrets section, as a `codex exec` turn is given them.
        let identity = format!(
            "developer_instructions={}",
            super::super::codex::toml(&super::super::prompts::for_codex_exec("you are Finance"))
        );
        assert!(codex
            .args
            .windows(2)
            .any(|w| w[0] == "-c" && w[1] == identity));
        // Not the headless fallback.
        assert!(!codex.args.contains(&"exec".to_string()));
        assert!(!codex
            .args
            .contains(&"approval_policy=\"never\"".to_string()));
    }

    /// A Claude Code take-over keeps the apps it was granted (its config
    /// file); a Codex one gets the same servers as `-c` values, ahead of the
    /// working folder and the thread, and never a token.
    #[test]
    fn a_codex_take_over_keeps_its_connection_servers() {
        use crate::agents::connections::{TurnAccess, TurnServer};
        let reach = TurnAccess {
            servers: vec![TurnServer {
                key: "linear".into(),
                url: "http://127.0.0.1:9/mcp/conn/linear".into(),
            }],
            ..Default::default()
        };
        let servers = reach.codex_config();
        let l = layout(None);
        let mut c = ctx(Engine::Codex, &l, vec![]);
        c.codex_servers = &servers;
        let codex = spawn_for(&c);
        let at = codex
            .args
            .iter()
            .position(|a| a.starts_with("mcp_servers.linear="))
            .expect("its connection server");
        assert_eq!(codex.args[at - 1], "-c");
        assert!(codex.args[at].contains("bearer_token_env_var"));
        assert!(at < codex.args.iter().position(|a| a == "-C").unwrap());
        assert_eq!(codex.args.last().map(String::as_str), Some("sess-1"));
        assert!(!codex.args.iter().any(|a| a.contains("s3cret")));
    }

    #[test]
    fn a_take_overs_terminal_is_known_by_its_id() {
        assert!(is_takeover_pty(&format!("{PTY_PREFIX}1b2c")));
        assert!(!is_takeover_pty("1b2c-takeover-"));
        assert!(!is_takeover_pty("3f0e9a1c-0000-4000-8000-000000000000"));
    }

    #[test]
    fn a_terminal_that_closes_by_itself_early_or_failing_is_explained() {
        // The trust question answered No: gone within a second.
        assert!(ended_early(true, 900, Some(0)));
        // Failing, however long it ran.
        assert!(ended_early(true, 30 * 60_000, Some(1)));
        // `/exit` after real work is an ordinary hand-back.
        assert!(!ended_early(true, 6 * 60_000, Some(0)));
        assert!(!ended_early(true, 6 * 60_000, None));
        // The button is never "early": the user ended it.
        assert!(!ended_early(false, 500, Some(1)));

        let tail = vec![
            "Do you trust the files in this folder?".to_string(),
            "> 2. No, exit".to_string(),
        ];
        let line = early_exit_line(Engine::Claude, "Finance", 3_400, Some(1), &tail);
        assert!(
            line.starts_with("Claude Code closed after 3 seconds, so you're back in the chat and Finance carries on from here."),
            "{line}"
        );
        assert!(
            line.ends_with(
                " The last thing it showed:\n\nDo you trust the files in this folder?\n> 2. No, exit"
            ),
            "{line}"
        );
        let recorded = early_exit_message("a1", &line);
        assert_eq!(
            recorded.kind,
            MessageKind::Note,
            "quiet: not the agent failing"
        );
        assert!(recorded.takeover);
        assert!(!recorded.kind.wants_user(), "no alert, no unread");
        assert!(
            runner::preview_for(&recorded).is_none(),
            "no sidebar preview"
        );
        let quiet = early_exit_line(Engine::Codex, "Ops", 400, Some(0), &[]);
        assert_eq!(
            quiet,
            "Codex closed after a second, so you're back in the chat and Ops carries on from here. It printed nothing."
        );
    }

    #[test]
    fn hand_back_asks_while_the_terminal_is_printing() {
        assert!(mid_output(10_000, 11_500));
        assert!(!mid_output(10_000, 12_000));
        // A clock that went backwards isn't "busy forever".
        assert!(mid_output(10_000, 9_000));
    }

    #[test]
    fn the_next_turn_is_told_only_when_the_conversation_grew() {
        assert!(grew(Some(100), Some(250)));
        assert!(grew(None, Some(10)), "written for the first time");
        assert!(
            !grew(Some(100), Some(100)),
            "opened and closed, nothing said"
        );
        assert!(!grew(None, None));
        assert!(!grew(Some(100), None));
    }

    #[test]
    fn transcripts_are_found_wherever_each_engine_files_them() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("claude");
        let filed = claude.join("projects").join("-u-agents-a1");
        std::fs::create_dir_all(&filed).unwrap();
        assert_eq!(claude_transcript_len(&claude, "sess-1"), None);
        std::fs::write(filed.join("sess-1.jsonl"), b"0123456789").unwrap();
        std::fs::write(filed.join("sess-2.jsonl"), b"xx").unwrap();
        assert_eq!(claude_transcript_len(&claude, "sess-1"), Some(10));

        let codex = dir.path().join("codex");
        let day = codex.join("sessions").join("2026").join("11").join("04");
        std::fs::create_dir_all(&day).unwrap();
        assert_eq!(codex_transcript_len(&codex, "01a1"), None);
        std::fs::write(day.join("rollout-2026-11-04T17-55-30-01a1.jsonl"), b"abcd").unwrap();
        std::fs::write(day.join("rollout-2026-11-04T17-55-30-99ff.jsonl"), b"zz").unwrap();
        assert_eq!(codex_transcript_len(&codex, "01a1"), Some(4));
    }

    #[test]
    fn a_take_over_leaves_one_mark_until_it_ends() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        std::fs::create_dir_all(store::agent_home("a1").unwrap()).unwrap();
        let mark = Mark {
            pid: 4242,
            session: "sess-1".into(),
        };
        write_mark("a1", &mark);
        assert_eq!(read_mark("a1"), Some(mark));
        clear_mark("a1");
        assert_eq!(read_mark("a1"), None);
        store::set_root_for_tests(None);
        assert_eq!(
            closed_line("Finance"),
            "The app closed while you were driving Finance in a terminal, so you're back in the chat. Finance carries on from here."
        );
    }

    #[test]
    fn how_long_reads_plainly() {
        assert_eq!(
            took_line("Finance", 20_000),
            "You handed Finance back after less than a minute"
        );
        assert_eq!(
            took_line("Finance", 6 * 60_000 + 59_000),
            "You handed Finance back after 6 min"
        );
        assert_eq!(took(60 * 60_000), "1 h");
        assert_eq!(took(65 * 60_000), "1 h 5 min");
        assert_eq!(took(-5), "less than a minute");
    }
}
