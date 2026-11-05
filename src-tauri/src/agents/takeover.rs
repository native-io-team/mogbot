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
//!   so it can't race a turn starting; hand-back releases it only once the
//!   terminal's process tree is gone. The terminal runs the engine's own
//!   interactive CLI resumed on the agent's session, with the command line a
//!   turn gets minus what only a headless turn needs (`claude::
//!   interactive_args`, `codex::interactive_args`), in the turn's working
//!   directory with the turn's environment, so its tools, folders and
//!   identity are the ones the agent works with.
//! - **Handed back** with the button, or by the terminal exiting. A note in
//!   the chat says how long ("You took over for 6 min"), and the next turn
//!   continues the same session, told first that the user worked in it
//!   (`prompts::handed_back`), so it knows what was done there.
//!
//! The PTY is spawned here, in Rust: its MCP URL carries the bridge token
//! and its environment the agent's secrets, and neither enters the webview.
//! It is kept out of the project's session list (no project in its
//! metadata), so remote access and other agents can't type into it.
//!
//! Nothing here is persisted: quitting kills every PTY, and what waited in
//! the queue is sent at the next launch like any interrupted queue.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::engine::Engine;
use super::runner::{self, Claim};
use super::store::{self, MessageKind};
use crate::commands::pty_session;
use crate::errors::CommandError;

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
}

struct Driving {
    view: View,
    pid: u32,
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
    pub url: &'a str,
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
            ctx.url,
            ctx.system_prompt,
            &ctx.layout.add_dirs,
        ),
        Engine::Codex => super::codex::interactive_args(
            ctx.model,
            ctx.session,
            ctx.url,
            &ctx.layout.add_dirs,
            &cwd,
        ),
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
    // `runner::strip_session_env`: inherited, they make Claude Code a nested
    // session that is never written to disk.
    let env_remove = ctx
        .inherited
        .iter()
        .filter(|k| is_session_var(k))
        .cloned()
        .collect();
    Spawn {
        args,
        cwd,
        env,
        env_remove,
    }
}

fn is_session_var(key: &str) -> bool {
    key == "CLAUDECODE"
        || key == "CLAUDE_PID"
        || key == "CLAUDE_EFFORT"
        || key.starts_with("CLAUDE_CODE_")
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

/// The note hand-back leaves in the chat.
pub fn took_line(ms: i64) -> String {
    format!("You took over for {}", took(ms))
}

fn refused(name: &str, claim: Claim) -> CommandError {
    match claim {
        Claim::Busy => CommandError::expected(format!(
            "{name} is working. Stop it and take over, or wait until it's done."
        )),
        Claim::Driven => CommandError::expected(format!("You're already driving {name}.")),
    }
}

/// Pause the agent and open its session in a terminal. Idempotent: an
/// agent already being driven gives the take-over in progress.
pub async fn begin(
    app: &AppHandle,
    agent_id: &str,
    cols: u16,
    rows: u16,
) -> Result<View, CommandError> {
    if let Some(view) = view(agent_id) {
        return Ok(view);
    }
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
    if let Err(claim) = runner::claim_for_takeover(agent_id) {
        if claim == Claim::Driven {
            if let Some(view) = view(agent_id) {
                return Ok(view);
            }
        }
        return Err(refused(&agent.name, claim));
    }
    match open(app, &agent, &session, &binary, cols, rows).await {
        Ok(view) => {
            let _ = app.emit(runner::EVENT_REGISTRY, ());
            Ok(view)
        }
        Err(e) => {
            // Nothing was started: the agent carries on as it was.
            runner::release_takeover(app, agent_id, None);
            Err(e)
        }
    }
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
    let (port, token) = crate::agent_bridge::start_global_agent_bridge(app.clone())
        .await
        .map_err(super::err_other)?;
    // No `?turn=`: the approval tool is only for a headless turn. Here the
    // CLI asks in the terminal, and anything that asks the broker is refused.
    let url = format!("http://127.0.0.1:{port}/mcp/{token}/agents/{}", agent.id);
    let secrets = super::secrets::env_for(agent);
    let mut system_prompt = runner::system_prompt_for(agent, &home, &layout);
    let have = super::secrets::prompt_section(agent, &secrets);
    if !have.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&have);
    }
    let spawn = spawn_for(&Context {
        engine: agent.engine,
        model: agent.model.as_deref(),
        session,
        url: &url,
        system_prompt: &system_prompt,
        layout: &layout,
        path: crate::utils::get_extended_path(),
        secrets,
        inherited: std::env::vars_os()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect(),
    });
    let pty = uuid::Uuid::new_v4().to_string();
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
    let view = View {
        since: store::now_ms(),
        pty_session: pty.clone(),
        project: agent.project.clone(),
        cli: match agent.engine {
            Engine::Claude => "claude-code",
            Engine::Codex => "codex",
        },
    };
    driving().insert(
        agent.id.clone(),
        Driving {
            view: view.clone(),
            pid: opened.pid,
        },
    );
    tracing::info!(agent = %agent.id, pid = opened.pid, "[Agents] taken over in a terminal");
    watch(app.clone(), agent.id.clone(), pty);
    Ok(view)
}

/// Hand back when the terminal's process exits on its own (`/exit`, a
/// crash, the workspace tab's ×).
fn watch(app: AppHandle, agent_id: String, pty: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let current = driving()
                .get(&agent_id)
                .is_some_and(|d| d.view.pty_session == pty);
            if !current {
                return;
            }
            let alive = pty_session::session_snapshot(&pty).is_some_and(|s| s.alive);
            if !alive {
                finish(&app, &agent_id, Some(&pty), true).await;
                return;
            }
        }
    });
}

/// Hand the session back to the agent: the terminal's process ends, the
/// agent resumes. False when nobody was driving it.
pub async fn hand_back(app: &AppHandle, agent_id: &str) -> bool {
    finish(app, agent_id, None, true).await
}

/// End a take-over without a note or a next turn: the agent is being deleted.
pub async fn abandon(app: &AppHandle, agent_id: &str) {
    finish(app, agent_id, None, false).await;
}

async fn finish(app: &AppHandle, agent_id: &str, pty: Option<&str>, resume: bool) -> bool {
    let driving = {
        let mut all = driving();
        match all.get(agent_id) {
            Some(d) if pty.is_none_or(|p| p == d.view.pty_session) => all.remove(agent_id),
            _ => None,
        }
    };
    let Some(Driving { view, pid }) = driving else {
        return false;
    };
    stop_terminal(&view.pty_session, pid).await;
    if let Some(project) = &view.project {
        // The workspace tab that showed it goes, as its × would.
        let payload = serde_json::json!({ "projectPath": project, "sessionId": view.pty_session });
        let window = crate::remote_access::tools::window_for(project);
        let _ = app.emit_to(&window, "remote-close-agent", payload);
    }
    if resume {
        let ms = store::now_ms() - view.since;
        let line = runner::new_message(agent_id, MessageKind::Note, took_line(ms));
        let _ = runner::record(app, line);
        runner::release_takeover(app, agent_id, Some(super::prompts::handed_back(&took(ms))));
    } else {
        runner::release_takeover(app, agent_id, None);
    }
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    tracing::info!(agent = %agent_id, "[Agents] handed back");
    true
}

/// End the terminal's process and everything it started, and wait until
/// it's gone: only then may a turn use the session again.
async fn stop_terminal(pty: &str, pid: u32) {
    let alive = || pty_session::session_snapshot(pty).is_some_and(|s| s.alive);
    if alive() {
        // Ctrl-C twice is how both CLIs quit, saving the conversation as
        // they go; the tree is stopped after a moment either way.
        let _ = pty_session::pty_session_write(pty.to_string(), vec![3]);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = pty_session::pty_session_write(pty.to_string(), vec![3]);
        wait_until(Duration::from_secs(2), || !alive()).await;
    }
    if pid != 0 {
        let _ = tokio::task::spawn_blocking(move || super::procs::kill_tree_sync(pid)).await;
    }
    wait_until(Duration::from_secs(3), || !alive()).await;
    // Releases the pseudo-terminal; a no-op for one already gone.
    let _ = pty_session::pty_session_kill(pty.to_string());
}

async fn wait_until(limit: Duration, done: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + limit;
    while !done() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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
            url: "http://127.0.0.1:9/mcp/t/agents/a1",
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
                "http://127.0.0.1:9/mcp/t/agents/a1",
                "you are Finance",
                &l.add_dirs
            )
        );
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
    fn a_bound_agent_is_driven_in_its_project_and_codex_resumes_its_thread() {
        let l = layout(Some("/u/ShipStudio/acme"));
        let claude = spawn_for(&ctx(Engine::Claude, &l, vec![]));
        assert_eq!(claude.cwd, "/u/ShipStudio/acme");

        let codex = spawn_for(&ctx(Engine::Codex, &l, vec![]));
        assert_eq!(codex.args[0], "resume");
        assert_eq!(codex.args.last().map(String::as_str), Some("sess-1"));
        assert!(codex.args.windows(2).any(|w| w == ["-C", "/u/ShipStudio/acme"]));
        assert!(codex.args.windows(2).any(|w| w == ["-m", "m1"]));
        // A turn's sandbox and our server, and asking rather than refusing.
        for want in [
            "sandbox_mode=\"workspace-write\"",
            "approval_policy=\"on-request\"",
            "sandbox_workspace_write.network_access=false",
        ] {
            assert!(codex.args.windows(2).any(|w| w[0] == "-c" && w[1] == want), "{want}");
        }
        assert!(codex
            .args
            .iter()
            .any(|a| a.starts_with("mcp_servers.") && a.contains("/mcp/t/agents/a1")));
        // Not the headless fallback.
        assert!(!codex.args.contains(&"exec".to_string()));
        assert!(!codex.args.contains(&"approval_policy=\"never\"".to_string()));
    }

    #[test]
    fn how_long_reads_plainly() {
        assert_eq!(took_line(20_000), "You took over for less than a minute");
        assert_eq!(took_line(6 * 60_000 + 59_000), "You took over for 6 min");
        assert_eq!(took(60 * 60_000), "1 h");
        assert_eq!(took(65 * 60_000), "1 h 5 min");
        assert_eq!(took(-5), "less than a minute");
    }
}
