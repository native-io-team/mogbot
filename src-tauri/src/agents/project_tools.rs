//! What the Projects side does, from chat: install a project's packages,
//! start, stop and read its dev server, commit, branch and open a pull
//! request. With `sessions.rs` (sessions, screenshots, push, hosting) this is
//! how an agent runs a project without the user ever opening the workspace.
//!
//! Every tool runs what the UI runs, never a copy of it:
//!
//! - **Consent** is the dev-server consent (`commands/projects/dev_consent.rs`):
//!   the same fingerprint, the same store. A project whose own commands
//!   aren't approved gets a card in the agent's chat (and on the phone) listing
//!   what would run; Allow approves exactly what was shown
//!   (`approve_dev_server`), as the Preview's "Start dev server" does. No tool
//!   call is behind the card, so it can't be always-allowed.
//! - **Installs** use `plan_package_install`, which only runs lifecycle
//!   scripts once the project is approved, and `mark_install_scripts_ran`.
//! - **The dev server** belongs to the window (`useDevServer`), so starting,
//!   stopping and reading it is a request to the window that owns the project
//!   (`agents://dev-server`, answered by `agents_dev_server_done`), handled by
//!   `useAgentDevServerControl`: `startServerForProject` in the background,
//!   then the preview proxy the workspace would start, so screenshots, the
//!   desk's Preview and the phone's Watch live all find it
//!   (`proxy::dev_server_port_for`). The window never moves.
//! - **Git** is `commit_changes`, `list_branches`, `switch_branch` (with
//!   auto-stash, as the branch menu does) and `create_branch`; a pull request
//!   is `create_pull_request` after a card, because it pushes and publishes.
//!
//! A bound agent with a live copy of the project works on the copy: its dev
//! server, its packages. It doesn't commit, branch or open pull requests
//! there; its card's Keep and ⋯ do that.
//!
//! Every call answers within `CALL_BUDGET`, under the engines' 300s cap on an
//! MCP call: an install or a cold start still going says so, keeps going in
//! the background, and the next call picks it up.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use super::mcp::Answer;
use super::store;
use crate::commands::projects::{ConsentState, DevServerConsent};
use crate::remote_access::shots::Device;
use crate::remote_access::tools::{self as shared, AgentsCall, AGENTS_CALL};

pub struct Tool {
    pub name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

fn project_prop() -> Value {
    json!({ "type": "string", "description": "Project name or path from project_list." })
}

fn only_project() -> Value {
    json!({ "type": "object", "properties": { "project": project_prop() }, "required": ["project"] })
}

pub const TOOLS: &[Tool] = &[
    Tool {
        name: "preview_start",
        description: "Start a project's preview in the background and screenshot it: installs its packages first when they're missing (the user approves the project's own commands on a card once), never moves the user's window. Use it whenever the user wants to see a project, or a screenshot says the preview isn't running. Call again if it says it's still installing or starting.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "project": project_prop(),
                    "page": { "type": "string", "description": "A path within the site, like /pricing. Default /." },
                    "device": { "type": "string", "enum": ["desktop", "phone", "both"], "description": "Default desktop." }
                },
                "required": ["project"]
            })
        },
    },
    Tool {
        name: "preview_stop",
        description: "Stop a project's dev server, or restart it (restart: true) after changing its config or packages.",
        schema: || {
            json!({
                "type": "object",
                "properties": { "project": project_prop(), "restart": { "type": "boolean" } },
                "required": ["project"]
            })
        },
    },
    Tool {
        name: "preview_logs",
        description: "A project's dev server: whether it's running, its port, and the last lines it printed. Read it when the preview fails or shows an error.",
        schema: only_project,
    },
    Tool {
        name: "project_install",
        description: "Install a project's packages (npm, pnpm, yarn or bun, whichever it uses), the Install button. Do it yourself when a preview or build fails on a missing package; never ask the user to. Restarts a running dev server after.",
        schema: only_project,
    },
    Tool {
        name: "git_commit",
        description: "Commit everything changed in a project with a message, locally. Pushing is push.",
        schema: || {
            json!({
                "type": "object",
                "properties": { "project": project_prop(), "message": { "type": "string" } },
                "required": ["project", "message"]
            })
        },
    },
    Tool {
        name: "git_branch",
        description: "A project's branches: list them, switch (uncommitted changes are stashed and come back when you return), or create one from a base and switch to it.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "project": project_prop(),
                    "action": { "type": "string", "enum": ["list", "switch", "create"] },
                    "name": { "type": "string", "description": "The branch to switch to or create." },
                    "from": { "type": "string", "description": "create: the base. Default the current branch." }
                },
                "required": ["project", "action"]
            })
        },
    },
    Tool {
        name: "pull_request",
        description: "Open a pull request on GitHub for the project's current branch (it's pushed first). The user approves a card first. Only when they asked; commit first with git_commit.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "project": project_prop(),
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "base": { "type": "string", "description": "The branch it merges into. Default the project's base branch." }
                },
                "required": ["project", "title"]
            })
        },
    },
];

/// The tools that change the folder or GitHub, refused in a turn answering
/// outside text (a "When…" routine's items): that text didn't come from the
/// user. `preview_start` may install, so it counts.
const CHANGES: &[&str] = &[
    "preview_start",
    "project_install",
    "git_commit",
    "git_branch",
    "pull_request",
];

pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

pub fn definitions() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect()
}

fn text(s: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": s.into() }] })
}

fn error(s: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&s.into())
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

// ============================================================================
// Which folder
// ============================================================================

/// The folder a call works on.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    /// Where things run: the project, or the agent's copy of it.
    pub path: String,
    /// The user's own project.
    pub project: String,
    pub copy: bool,
}

impl Target {
    fn name(&self) -> &str {
        shared::project_name(&self.project)
    }
}

fn same_place(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
        || matches!((dunce::canonicalize(a), dunce::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// `project` as the caller works on it: its own live copy when it has one of
/// that project, otherwise the project.
pub fn target_for(project: &str, copy: Option<&super::task::TaskCopy>) -> Target {
    match copy {
        Some(c) if same_place(&c.project, project) => Target {
            path: c.path.clone(),
            project: project.to_string(),
            copy: true,
        },
        _ => Target {
            path: project.to_string(),
            project: project.to_string(),
            copy: false,
        },
    }
}

// ============================================================================
// Calls
// ============================================================================

/// How long one call may take, under the engines' 300s cap on a tool call
/// (Claude Code's `MCP_TOOL_TIMEOUT`, Codex's `tool_timeout_sec`).
const CALL_BUDGET: Duration = Duration::from_secs(250);

pub async fn call(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    tool: &Tool,
    args: &Value,
) -> Value {
    let deadline = Instant::now() + CALL_BUDGET;
    let projects = crate::commands::projects::list_projects()
        .await
        .map(|list| list.into_iter().map(|p| p.path).collect::<Vec<_>>())
        .unwrap_or_default();
    let project = match shared::resolve_project(&projects, arg(args, "project")) {
        Ok(p) => p,
        Err(e) => return error(e),
    };
    let t = target_for(&project, caller.copy.as_ref());
    let reads_only = tool.name == "git_branch" && arg(args, "action") == Some("list");
    let changes = CHANGES.contains(&tool.name) && !reads_only;
    if changes
        && super::runner::from_outside(&caller.id)
        && super::broker::is_live(&caller.id, turn)
    {
        return error("Not while answering what a “When…” routine found: that text came from outside this app. Tell the user what you'd do instead.");
    }
    // Its settings (`policy`). Its own copy is its own to change.
    if !t.copy {
        let policy = super::policy::effective(caller);
        let as_tool = if reads_only { "git_status" } else { tool.name };
        if let Some(refusal) =
            super::policy::session_refusal(&policy, caller, as_tool, Some(&t.project))
        {
            return error(refusal);
        }
    }
    let result = match tool.name {
        "preview_start" => preview_start(app, caller, &t, args, deadline).await,
        "preview_stop" => preview_stop(app, caller, &t, args, deadline).await,
        "preview_logs" => preview_logs(app, &t).await,
        "project_install" => project_install(app, caller, &t, deadline).await,
        "git_commit" => git_commit(&t, args).await,
        "git_branch" => git_branch(&t, args).await,
        "pull_request" => pull_request(app, caller, &t, args).await,
        _ => error("Unknown tool"),
    };
    if tool.name != "preview_logs" && !reads_only {
        let ok = result.get("isError").and_then(Value::as_bool) != Some(true);
        let detail = match (arg(args, "message"), arg(args, "title"), arg(args, "name")) {
            (Some(m), _, _) | (_, Some(m), _) | (_, _, Some(m)) => crate::remote_access::preview(m),
            _ => String::new(),
        };
        crate::remote_access::audit_as(Some(&caller.name), tool.name, Some(&t.path), detail, ok);
    }
    result
}

// ============================================================================
// Consent: the project's own commands, approved on a card
// ============================================================================

/// What the card shows, in the order the Preview's prompt lists it
/// (`consentLines` in lib/devServerConsent.ts): (title, summary, detail).
pub fn consent_card(name: &str, consent: &DevServerConsent) -> (String, String, String) {
    let s = &consent.surface;
    let mut lines: Vec<String> = Vec::new();
    if let Some(c) = &s.custom_command {
        lines.push(format!("dev command: {c}"));
    }
    lines.extend(s.scripts.iter().map(|(k, v)| format!("{k}: {v}")));
    if let Some(ws) = &s.workspace_scripts {
        let prefix = s
            .workspace_subpath
            .as_deref()
            .map(|p| format!("{p} › "))
            .unwrap_or_default();
        lines.extend(ws.iter().map(|(k, v)| format!("{prefix}{k}: {v}")));
    }
    for (dir, scripts) in &s.workspaces {
        lines.extend(scripts.iter().map(|(k, v)| format!("{dir} › {k}: {v}")));
    }
    const SHOWN: usize = 20;
    let more = lines.len().saturating_sub(SHOWN);
    lines.truncate(SHOWN);
    let mut detail = if lines.is_empty() {
        "This project defines no scripts.".to_string()
    } else {
        format!("Commands that can run:\n{}", lines.join("\n"))
    };
    if more > 0 {
        detail.push_str(&format!("\n… and {more} more"));
    }
    if !s.files.is_empty() {
        let files: Vec<&str> = s.files.keys().map(String::as_str).collect();
        detail.push_str(&format!(
            "\n\nAlso part of what you're approving: {}",
            files.join(", ")
        ));
    }
    if consent.install_scripts_pending {
        detail.push_str(
            "\n\nIts packages were installed without their install scripts; those run first.",
        );
    }
    let (title, summary) = match consent.state {
        ConsentState::Changed => (
            format!("{name} changed. Run its commands?"),
            "Its commands or config changed since you last allowed them. Allowing runs them on this Mac to install its packages and start its preview.".to_string(),
        ),
        _ => (
            format!("Run {name}'s own commands?"),
            format!("Installing {name}'s packages and starting its preview runs commands the project itself defines, on this Mac. Only allow projects you trust."),
        ),
    };
    (title, summary, detail)
}

/// The project's own commands are approved, asking the user on a card if
/// they aren't yet. `Err` is the tool's answer.
async fn ensure_consent(app: &AppHandle, caller: &store::Agent, t: &Target) -> Result<(), Value> {
    let consent = crate::commands::projects::get_dev_server_consent(t.path.clone())
        .await
        .map_err(|e| error(e.to_string()))?;
    if consent.state == ConsentState::Approved {
        return Ok(());
    }
    let (title, summary, detail) = consent_card(t.name(), &consent);
    let answer = super::mcp::ask_user_with_summary(app, caller, title, summary, detail).await;
    match answer {
        Answer::Allowed => {}
        Answer::Denied(note) => {
            let said = note
                .map(|n| format!(", and told you: \"{n}\""))
                .unwrap_or_default();
            return Err(error(format!(
                "The user said no to running {}'s own commands{said}, so nothing was installed or started. Don't try again unless they ask.",
                t.name()
            )));
        }
        Answer::NotYet => {
            return Err(error(format!(
                "The user hasn't answered the card about running {}'s commands, so nothing was installed or started. Tell them in one line it's waiting for their Allow, then stop.",
                t.name()
            )))
        }
    }
    // Exactly what the card showed, or nothing (`approve_at`).
    crate::commands::projects::approve_dev_server(t.path.clone(), consent.fingerprint)
        .await
        .map_err(|e| error(e.to_string()))
}

// ============================================================================
// Installing
// ============================================================================

type InstallResult = Option<Result<String, String>>;

/// Installs running in the background, by folder. A call that runs out of
/// time leaves its install here; the next call waits on the same one.
static INSTALLS: LazyLock<Mutex<HashMap<String, watch::Receiver<InstallResult>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn package_manager(detected: &str) -> &'static str {
    match detected.trim() {
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "bun" => "bun",
        _ => "npm",
    }
}

/// The last `max` non-empty lines of a command's output, colours stripped.
pub fn tail(output: &str, max: usize) -> String {
    let clean = crate::commands::mcp::strip_ansi(output);
    let lines: Vec<&str> = clean
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(max)..].join("\n")
}

async fn run_install(
    path: String,
    pm: &'static str,
    args: Vec<String>,
    scripts: bool,
) -> Result<String, String> {
    let bin = crate::commands::claude::find_binary_by_name(pm)
        .ok_or_else(|| format!("{pm} isn't installed on this Mac."))?;
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(&args)
        .current_dir(&path)
        .env("PATH", crate::utils::get_extended_path())
        .envs(crate::commands::accounts::get_env_vars_for_project(
            std::path::Path::new(&path),
        ))
        .env("CI", "1")
        .stdin(std::process::Stdio::null());
    let label = format!("{pm} {}", args.join(" "));
    let output = crate::external_command::run_with_timeout(cmd, label.clone(), 900)
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let all = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Err(format!("`{label}` failed:\n{}", tail(&all, 15)));
    }
    if scripts {
        let _ = crate::commands::projects::mark_install_scripts_ran(path).await;
    }
    Ok(label)
}

/// Where an install stands when the call has to answer.
enum Installed {
    /// Nothing to install, or done (with the command that ran).
    Ready(Option<String>),
    StillRunning,
    Failed(String),
}

/// Install `t`'s packages when they're missing (or always, `force`), with
/// the project's consent already given. Waits until `deadline`.
async fn install(t: &Target, force: bool, deadline: Instant) -> Installed {
    let running = INSTALLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&t.path)
        .cloned();
    let rx = match running {
        Some(rx) => rx,
        None => {
            if !force {
                match crate::commands::projects::check_dependencies_installed(t.path.clone()).await
                {
                    Ok(d) if d.installed => return Installed::Ready(None),
                    Ok(_) => {}
                    Err(e) => return Installed::Failed(e.to_string()),
                }
            }
            let pm = package_manager(
                &crate::commands::github::detect_package_manager(t.path.clone())
                    .await
                    .unwrap_or_default(),
            );
            let plan =
                match crate::commands::projects::plan_package_install(t.path.clone(), pm.into())
                    .await
                {
                    Ok(p) => p,
                    Err(e) => return Installed::Failed(e.to_string()),
                };
            let (tx, rx) = watch::channel(None);
            INSTALLS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(t.path.clone(), rx.clone());
            let path = t.path.clone();
            tauri::async_runtime::spawn(async move {
                let result = run_install(path, pm, plan.args, plan.runs_scripts).await;
                let _ = tx.send(Some(result));
            });
            rx
        }
    };
    let mut rx = rx;
    let done = tokio::time::timeout_at(deadline, rx.wait_for(Option::is_some)).await;
    let result = match done {
        Ok(Ok(r)) => r.clone(),
        Ok(Err(_)) => Some(Err("The install stopped without saying how it went.".into())),
        Err(_) => None,
    };
    let Some(result) = result else {
        return Installed::StillRunning;
    };
    INSTALLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&t.path);
    match result {
        Ok(label) => Installed::Ready(Some(label)),
        Err(e) => Installed::Failed(e),
    }
}

fn still_installing(t: &Target, tool: &str) -> Value {
    text(format!(
        "STATUS: installing. {}'s packages are still installing in the background. NEXT: call {tool} again with the same project to keep waiting; don't start another install.",
        t.name()
    ))
}

fn install_failed(t: &Target, why: &str) -> Value {
    error(format!(
        "Installing {}'s packages failed:\n{why}\n\nNEXT: fix what it reports (a version conflict, a missing tool, a typo in package.json; in a session with session_message if the user works there), then call project_install again. Tell the user only if it needs them (a login, a paid package).",
        t.name()
    ))
}

async fn project_install(
    app: &AppHandle,
    caller: &store::Agent,
    t: &Target,
    deadline: Instant,
) -> Value {
    if let Err(answer) = ensure_consent(app, caller, t).await {
        return answer;
    }
    match install(t, true, deadline).await {
        Installed::StillRunning => still_installing(t, "project_install"),
        Installed::Failed(why) => install_failed(t, &why),
        Installed::Ready(label) => {
            let ran = label.map(|l| format!(" (`{l}`)")).unwrap_or_default();
            let mut said = format!("Installed {}'s packages{ran}.", t.name());
            if crate::proxy::dev_server_port_for(&t.path).is_some() {
                match restart(app, t, deadline).await {
                    Ok(_) => said.push_str(" Its dev server was restarted to pick them up."),
                    Err(e) => {
                        said.push_str(&format!(" Restarting its dev server didn't work: {e}"))
                    }
                }
            }
            text(said)
        }
    }
}

// ============================================================================
// The dev server: the window's, asked for
// ============================================================================

/// The window's dev servers: started, stopped and read here
/// (`hooks/useAgentDevServerControl.ts`).
pub const EVENT_DEV_SERVER: &str = "agents://dev-server";

/// The window's answer (`agents_dev_server_done`).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    /// `not-running`, `starting`, `ready` or `stopped` (it exited by itself).
    pub status: String,
    pub port: Option<u16>,
    pub project_type: Option<String>,
    /// A native mobile project: no web preview.
    pub mobile: bool,
    pub needs_install: bool,
    pub consent_pending: bool,
    /// The last of what it printed.
    pub output: String,
    pub error: Option<String>,
}

static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<Report>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The window answered request `id`.
pub fn answer(id: &str, report: Report) -> bool {
    let tx = PENDING.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    tx.is_some_and(|tx| tx.send(report).is_ok())
}

/// How long the window gets to answer. A start resolves once the process is
/// spawned, not once the site answers, so this covers type detection.
const WINDOW_WAIT: Duration = Duration::from_secs(60);

async fn ask_window(app: &AppHandle, t: &Target, action: &str) -> Result<Report, String> {
    let id = store::new_id();
    let (tx, rx) = oneshot::channel();
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), tx);
    let port = crate::commands::projects::get_dev_server_port(t.path.clone())
        .await
        .ok()
        .flatten();
    let sent = app.emit_to(
        shared::window_for(&t.project).as_str(),
        EVENT_DEV_SERVER,
        json!({
            "requestId": id,
            "projectPath": t.path,
            "name": t.name(),
            "action": action,
            "port": port,
        }),
    );
    let answer = match sent {
        Ok(()) => tokio::time::timeout(WINDOW_WAIT, rx)
            .await
            .ok()
            .and_then(Result::ok),
        Err(_) => None,
    };
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    let report = answer.ok_or_else(|| {
        "The app's window didn't answer, so the dev server wasn't reached. The app may be closed to the menu bar; ask the user to open it.".to_string()
    })?;
    match &report.error {
        Some(e) => Err(e.clone()),
        None => Ok(report),
    }
}

async fn listening(port: u16) -> bool {
    let url = format!("http://localhost:{port}");
    tokio::task::spawn_blocking(move || crate::commands::ide::dev_server_listening(&url))
        .await
        .unwrap_or(false)
}

/// Why a started server isn't a preview, or `None` when it is one.
pub fn not_a_preview(name: &str, r: &Report) -> Option<String> {
    if r.consent_pending {
        return Some(format!(
            "{name}'s commands are waiting for the user's approval in the app."
        ));
    }
    if r.needs_install {
        return Some(format!("{name}'s packages aren't installed."));
    }
    if r.mobile {
        return Some(format!("{name} is a native mobile app, which has no web preview. It runs in the iOS simulator from the project's workspace on the Mac."));
    }
    if r.port.is_none() || r.status == "not-running" {
        return Some(format!("{name} has no dev server to start (no dev script, custom dev command or index.html), so it has no web preview."));
    }
    None
}

/// Where a start stands when the call has to answer.
enum Started {
    Up(u16),
    StillStarting,
    Failed(String),
}

/// Start `t`'s dev server through the window and wait until it answers.
async fn start(app: &AppHandle, t: &Target, deadline: Instant) -> Started {
    let report = match ask_window(app, t, "start").await {
        Ok(r) => r,
        Err(e) => return Started::Failed(e),
    };
    if let Some(why) = not_a_preview(t.name(), &report) {
        return Started::Failed(why);
    }
    let Some(port) = report.port else {
        return Started::Failed(format!("{} didn't say which port it runs on.", t.name()));
    };
    let mut checked = Instant::now();
    loop {
        if listening(port).await {
            return Started::Up(port);
        }
        if Instant::now() >= deadline {
            return Started::StillStarting;
        }
        // It may have exited (a missing package, a syntax error): look.
        if checked.elapsed() >= Duration::from_secs(5) {
            checked = Instant::now();
            if let Ok(r) = ask_window(app, t, "status").await {
                if r.status == "stopped" || r.status == "not-running" {
                    return Started::Failed(format!(
                        "{}'s dev server stopped before it answered. Its last lines:\n{}",
                        t.name(),
                        tail(&r.output, 25)
                    ));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn restart(app: &AppHandle, t: &Target, deadline: Instant) -> Result<u16, String> {
    ask_window(app, t, "stop").await?;
    match start(app, t, deadline).await {
        Started::Up(port) => Ok(port),
        Started::StillStarting => Err("it's still starting".into()),
        Started::Failed(e) => Err(e),
    }
}

fn devices(arg: Option<&str>) -> Vec<Device> {
    match arg {
        Some("phone") | Some("mobile") => vec![Device::Phone],
        Some("both") => vec![Device::Desktop, Device::Phone],
        _ => vec![Device::Desktop],
    }
}

/// Screenshots of the running site, kept in the agent's chat and folder:
/// (image blocks for the agent, where each was kept).
async fn screenshots(
    app: &AppHandle,
    caller: &store::Agent,
    t: &Target,
    page: Option<&str>,
    device: Option<&str>,
) -> Result<(Vec<Value>, Vec<String>), String> {
    use base64::Engine;
    let mut blocks = Vec::new();
    let mut kept = Vec::new();
    for d in devices(device) {
        // Inside an agent's call, a capture never opens the project in the
        // window; it answers that the preview isn't running instead.
        let shot = AGENTS_CALL
            .scope(
                AgentsCall::default(),
                shared::capture_encoded(app, &t.path, d, false, page),
            )
            .await?;
        if let Some(path) =
            super::sessions::keep_screenshot(app, caller, &t.project, d.label(), &shot.full)
        {
            kept.push(path);
        }
        blocks.push(json!({
            "type": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(&shot.preview),
            "mimeType": "image/jpeg",
        }));
    }
    Ok((blocks, kept))
}

/// What comes after a preview is up: the result card, with the screenshot.
pub fn next_after_preview(name: &str, copy: bool, kept: &[String]) -> String {
    let shot = match kept {
        [] => String::new(),
        [one] => format!(" with the screenshot `{one}` as a file"),
        many => format!(" with the screenshots {} as files", many.join(", ")),
    };
    if copy {
        format!("NEXT: Tell the user in a sentence or two, with the screenshot. Your copy's card offers Preview and Keep; to hand it back as a result, share_result naming project \"{name}\"{shot}.")
    } else {
        format!("NEXT: Hand it back with share_result naming project \"{name}\"{shot}: its card has Preview on the Mac and Watch live on the phone. Say in a sentence or two what they're looking at.")
    }
}

async fn preview_start(
    app: &AppHandle,
    caller: &store::Agent,
    t: &Target,
    args: &Value,
    deadline: Instant,
) -> Value {
    let page = match arg(args, "page").map(shared::check_page) {
        Some(Err(e)) => return error(e),
        Some(Ok(p)) => Some(p),
        None => None,
    };
    let mut done = Vec::new();
    // Its preview from here on: if the server stops by itself, it hears (`preview_fix`).
    super::preview_fix::claim(&t.path, &caller.id);
    // Already up: nothing to approve, install or start.
    let port = match shared::running_dev_server(&t.path).await {
        Some(port) => port,
        None => {
            if let Err(answer) = ensure_consent(app, caller, t).await {
                return answer;
            }
            match install(t, false, deadline).await {
                Installed::StillRunning => return still_installing(t, "preview_start"),
                Installed::Failed(why) => return install_failed(t, &why),
                Installed::Ready(Some(label)) => {
                    done.push(format!("Installed its packages (`{label}`)."))
                }
                Installed::Ready(None) => {}
            }
            match start(app, t, deadline).await {
                Started::Up(port) => {
                    done.push("Started its dev server in the background; the user's window didn't move.".to_string());
                    port
                }
                Started::StillStarting => {
                    return text(format!(
                        "STATUS: starting. {}'s dev server is still starting (a first start can take a minute or two). NEXT: call preview_start again with the same project.",
                        t.name()
                    ))
                }
                Started::Failed(why) => {
                    return error(format!(
                        "{why}\n\nNEXT: if it's a missing package, call project_install, then preview_start again. If it's an error in the code, fix it (or have its session fix it), then preview_start again. preview_logs shows what it printed."
                    ))
                }
            }
        }
    };
    let whose = if t.copy {
        format!("Your copy of {}", t.name())
    } else {
        t.name().to_string()
    };
    super::preview_fix::running_again(&t.path);
    let mut lines = done;
    lines.insert(0, format!("{whose} is running at http://localhost:{port}."));
    let mut content = Vec::new();
    match screenshots(app, caller, t, page, arg(args, "device")).await {
        Ok((blocks, kept)) => {
            content.extend(blocks);
            if !kept.is_empty() {
                lines.push(format!(
                    "The screenshot is in this chat for the user too, and kept in your folder: {}.",
                    kept.join(", ")
                ));
            }
            lines.push(next_after_preview(t.name(), t.copy, &kept));
        }
        Err(e) => {
            lines.push(format!("The screenshot didn't work: {e}"));
            lines.push(next_after_preview(t.name(), t.copy, &[]));
        }
    }
    content.push(json!({ "type": "text", "text": lines.join("\n") }));
    json!({ "content": content })
}

async fn preview_stop(
    app: &AppHandle,
    caller: &store::Agent,
    t: &Target,
    args: &Value,
    deadline: Instant,
) -> Value {
    if args.get("restart").and_then(Value::as_bool) == Some(true) {
        if let Err(e) = ask_window(app, t, "stop").await {
            return error(e);
        }
        return preview_start(app, caller, t, &json!({}), deadline).await;
    }
    match ask_window(app, t, "stop").await {
        Ok(_) => text(format!("Stopped {}'s dev server.", t.name())),
        Err(e) => error(e),
    }
}

async fn preview_logs(app: &AppHandle, t: &Target) -> Value {
    let r = match ask_window(app, t, "status").await {
        Ok(r) => r,
        Err(e) => return error(e),
    };
    let state = match r.status.as_str() {
        "ready" => "running",
        "starting" => "starting",
        "stopped" => "stopped by itself (it exited)",
        _ => "not running",
    };
    let port = r
        .port
        .filter(|_| r.status == "ready" || r.status == "starting")
        .map(|p| format!(" on port {p}"))
        .unwrap_or_default();
    let printed = tail(&r.output, 40);
    let printed = if printed.is_empty() {
        "It hasn't printed anything in this app's session.".to_string()
    } else {
        format!("Its last lines:\n{printed}")
    };
    text(format!(
        "{}'s dev server: {state}{port}.\n{printed}",
        t.name()
    ))
}

// ============================================================================
// Git
// ============================================================================

const COPY_GIT: &str = "You work in your own copy: it's committed for you at the end of each turn, and the user keeps, reviews or discards it (or opens a pull request) from its card. Don't commit, branch or open pull requests in it.";

async fn git_commit(t: &Target, args: &Value) -> Value {
    if t.copy {
        return error(COPY_GIT);
    }
    let Some(message) = arg(args, "message") else {
        return error("Give the commit a message that says what changed.");
    };
    match crate::commands::git::commit_changes(t.path.clone(), message.to_string()).await {
        Ok(true) => {
            let sha = shared::git(&t.path, &["rev-parse", "--short", "HEAD"])
                .await
                .map(|s| format!(" ({})", s.trim()))
                .unwrap_or_default();
            text(format!(
                "Committed everything in {}{sha}: “{message}”. Nothing was pushed; push does that, when the user asks.",
                t.name()
            ))
        }
        Ok(false) => text(format!("Nothing to commit in {}: no changes.", t.name())),
        Err(e) => error(format!("The commit failed: {e}")),
    }
}

async fn git_branch(t: &Target, args: &Value) -> Value {
    let action = arg(args, "action").unwrap_or("list");
    if t.copy && action != "list" {
        return error(COPY_GIT);
    }
    match action {
        "list" => match crate::commands::git::list_branches(t.path.clone()).await {
            Ok(branches) => {
                let lines: Vec<String> = branches
                    .iter()
                    .filter(|b| !b.is_remote)
                    .map(|b| {
                        let mut l = b.name.clone();
                        if b.is_current {
                            l.push_str(" (current)");
                        }
                        if !b.pushed {
                            l.push_str(" · not on GitHub");
                        }
                        l
                    })
                    .collect();
                text(format!(
                    "{}'s branches:\n{}",
                    t.name(),
                    shared::cap_lines(&lines.join("\n"), 40)
                ))
            }
            Err(e) => error(e.to_string()),
        },
        "switch" => {
            let Some(name) = arg(args, "name") else {
                return error("Name the branch to switch to.");
            };
            match crate::commands::git::switch_branch(t.path.clone(), name.to_string(), true).await
            {
                Ok(r) if r.success => {
                    let mut said = format!("{} is on {name} now.", t.name());
                    if r.stashed_changes {
                        said.push_str(" Its uncommitted changes were put aside and come back when you switch back.");
                    }
                    if r.stash_applied {
                        said.push_str(
                            " Changes put aside on this branch earlier were brought back.",
                        );
                    }
                    text(said)
                }
                Ok(r) => error(
                    r.error
                        .unwrap_or_else(|| "The switch didn't go through.".into()),
                ),
                Err(e) => error(e.to_string()),
            }
        }
        "create" => {
            let Some(name) = arg(args, "name") else {
                return error("Name the new branch.");
            };
            let from = match arg(args, "from") {
                Some(f) => f.to_string(),
                None => match shared::git(&t.path, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
                    Ok(b) => b.trim().to_string(),
                    Err(e) => return error(e),
                },
            };
            match crate::commands::git::create_branch(
                t.path.clone(),
                name.to_string(),
                from.clone(),
            )
            .await
            {
                Ok(()) => text(format!("Created {name} from {from} in {}.", t.name())),
                Err(e) => error(e.to_string()),
            }
        }
        other => error(format!(
            "action must be list, switch or create, not \"{other}\"."
        )),
    }
}

/// The card's sentence: what is pushed and where it is opened.
pub fn pull_request_summary(repo: &str, branch: &str, base: &str, title: &str) -> String {
    format!("Pushes {branch} to {repo} and opens a pull request into {base}: “{title}”. People with access to the repository can see it.")
}

async fn pull_request(app: &AppHandle, caller: &store::Agent, t: &Target, args: &Value) -> Value {
    if t.copy {
        return error(COPY_GIT);
    }
    let Some(title) = arg(args, "title") else {
        return error("Give the pull request a title.");
    };
    let body = arg(args, "body").map(str::to_string);
    let branch = match shared::git(&t.path, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Ok(b) => b.trim().to_string(),
        Err(e) => return error(e),
    };
    let remote = match shared::git(&t.path, &["remote", "get-url", "origin"]).await {
        Ok(url) if !url.trim().is_empty() => super::sessions::display_remote(&url),
        _ => return error(format!("{} isn't on GitHub yet (no origin), so there's nowhere to open a pull request. The user connects it from the project's Push button.", t.name())),
    };
    let status = shared::git(&t.path, &["status", "--short"])
        .await
        .unwrap_or_default();
    if !status.trim().is_empty() {
        return error("It has uncommitted changes, which wouldn't be in the pull request. Commit them first with git_commit, then call pull_request again.");
    }
    let base = match arg(args, "base") {
        Some(b) => b.to_string(),
        None => crate::commands::git::get_default_base_branch(t.path.clone())
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "main".into()),
    };
    if base == branch {
        return error(format!("{} is on {base}, the branch it would merge into. Create a branch for the work first (git_branch).", t.name()));
    }
    let repo = super::sessions::repo_name(&remote);
    let summary = pull_request_summary(&repo, &branch, &base, title);
    let detail = format!(
        "Branch {branch} → {base} on {remote}\n\nTitle: {title}{}",
        body.as_deref()
            .map(|b| format!("\n\n{b}"))
            .unwrap_or_default()
    );
    let answer = super::mcp::ask_user_with_summary(
        app,
        caller,
        format!("Open a pull request in {}", t.name()),
        summary,
        detail,
    )
    .await;
    if let Some(refused) = super::mcp::refused_reply(&answer, "open it") {
        return error(refused);
    }
    match crate::commands::pull_requests::create_pull_request(
        app.clone(),
        t.path.clone(),
        title.to_string(),
        body,
        Some(caller.name.clone()),
        base.clone(),
    )
    .await
    {
        Ok(url) => text(format!(
            "Opened the pull request: {}\nNEXT: Tell the user in one line, with the link.",
            url.trim()
        )),
        Err(e) => error(format!("The pull request wasn't opened: {e}")),
    }
}

#[cfg(test)]
#[path = "project_tools_tests.rs"]
mod tests;
