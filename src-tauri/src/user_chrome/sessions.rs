//! Your Chrome outside Agents: the project tabs this app starts, and plain
//! Terminal sessions on any Claude account, get the same `user_chrome` tools
//! the agents have, through the same link and the same extension. Claude in
//! Chrome pairs only with the claude.ai account signed in to Chrome; this
//! needs no account at all.
//!
//! - **A project tab** (Claude Code or Codex, started by the app): its own
//!   secret, minted when the tab spawns ([`spawn_args`]), named in a 0600
//!   `--mcp-config` file (Claude Code) or an environment variable named by
//!   `bearer_token_env_var` (Codex), never on the command line. Its tabs go
//!   in a tab group named for the project.
//! - **Terminal** (any `claude`, on any account): a stdio launcher, the
//!   app's own binary run as `<binary> mcp user-chrome` (`launcher`),
//!   registered once at user scope. It reads the bridge's port and the
//!   Terminal secret from [`endpoint_path`] on every request, so it keeps
//!   working across app restarts, and says plainly when the app is closed.
//!   Inside a project tab the launcher uses that tab's secret instead
//!   ([`TOKEN_ENV`]), so the two never show as two callers.
//!
//! Every caller here is the user at a keyboard, not an agent: what it
//! sends, posts, pays, deletes or shares still asks on a card, in the Chief
//! of Staff's chat (and on the phone), at the team's independence capped at
//! "Bold" (`browser_gate::gate_session`). Looking and acting otherwise is
//! free, as for agents.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::agents::store::Agent;

/// The environment variable a session's secret reaches its engine (and a
/// launcher started inside it) through.
pub const TOKEN_ENV: &str = "USER_CHROME_MCP_TOKEN";

/// Where a caller's tabs come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// A Claude Code or Codex tab in a project, started by this app.
    ProjectTab,
    /// A `claude` in the user's own Terminal, through the launcher.
    Terminal,
}

/// A caller that isn't an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// Its tabs' owner in the extension: never an agent's id.
    pub id: String,
    /// Its tab group's name.
    pub label: String,
    pub kind: Kind,
}

/// The Terminal caller's id.
pub const TERMINAL_ID: &str = "session-terminal";

#[derive(Default)]
struct Secrets {
    /// Secret → caller.
    by_secret: HashMap<String, Session>,
    /// A project tab's pty id → its secret, so a respawned tab keeps its tabs.
    by_tab: HashMap<String, String>,
    terminal: Option<String>,
}

static SECRETS: LazyLock<Mutex<Secrets>> = LazyLock::new(Default::default);
/// Each project tab's Claude Code config file, removed when replaced (and
/// any left by a crash, at launch: `agents::reach::sweep`).
static CONFIGS: LazyLock<Mutex<HashMap<String, crate::agents::reach::ConfigFile>>> =
    LazyLock::new(Default::default);

fn secrets() -> std::sync::MutexGuard<'static, Secrets> {
    SECRETS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Who `secret` is, if it's a live session's.
pub fn caller(secret: &str) -> Option<Session> {
    if secret.len() != 64 {
        return None;
    }
    secrets().by_secret.get(secret).cloned()
}

/// A project tab's secret (the same one for the life of the tab's id).
pub fn for_project_tab(pty_id: &str, project_path: Option<&Path>) -> String {
    let mut s = secrets();
    if let Some(secret) = s.by_tab.get(pty_id) {
        return secret.clone();
    }
    let secret = super::auth::random_hex(32);
    let session = Session {
        id: tab_id(pty_id),
        label: project_label(project_path),
        kind: Kind::ProjectTab,
    };
    s.by_secret.insert(secret.clone(), session);
    s.by_tab.insert(pty_id.to_string(), secret.clone());
    secret
}

/// The Terminal secret: one per run of the app.
pub fn terminal_secret() -> String {
    let mut s = secrets();
    if let Some(t) = &s.terminal {
        return t.clone();
    }
    let secret = super::auth::random_hex(32);
    s.by_secret.insert(
        secret.clone(),
        Session {
            id: TERMINAL_ID.into(),
            label: "Terminal".into(),
            kind: Kind::Terminal,
        },
    );
    s.terminal = Some(secret.clone());
    secret
}

/// A project tab's owner id: from its pty id, never the project's path.
pub fn tab_id(pty_id: &str) -> String {
    use sha2::Digest as _;
    let h = hex::encode(sha2::Sha256::digest(pty_id.as_bytes()));
    format!("session-{}", &h[..12])
}

/// The tab group's name for a project: its folder's name.
pub fn project_label(project_path: Option<&Path>) -> String {
    project_path
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Project".into())
}

/// The caller as the tools and the gate see one: an agent that is never
/// stored, with nothing of its own (its level is the team's, capped by
/// `gate_session`). Its id is never an agent's.
pub fn agent_of(session: &Session) -> Agent {
    // Every other field has a default; these four are required.
    serde_json::from_value(json!({
        "id": session.id,
        "name": session.label,
        "shape": 0,
        "color": "gray",
        "createdAt": 0,
    }))
    .unwrap_or_else(|_| unreachable!("a fixed agent shape always parses"))
}

/* ---------------------------------------------------- project tabs */

/// What a project tab is spawned with, added to the CLI's own arguments
/// and environment.
#[derive(Debug, Default, PartialEq)]
pub struct Spawn {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// The arguments and environment that give a tab of `cli` ("claude-code",
/// "codex"; any other: just the environment, for a launcher started inside
/// it) the user's Chrome at `url` with `secret`. `config_path`: where the
/// Claude Code config was written. Pure.
pub fn spawn_for(cli: &str, url: &str, secret: &str, config_path: Option<&str>) -> Spawn {
    let key = super::tools::SERVER_KEY;
    let env = vec![(TOKEN_ENV.to_string(), secret.to_string())];
    let args = match (cli, config_path) {
        ("claude-code", Some(path)) => vec!["--mcp-config".into(), path.to_string()],
        ("codex", _) => vec![
            "-c".into(),
            format!("mcp_servers.{key}.url={}", toml_string(url)),
            "-c".into(),
            format!(
                "mcp_servers.{key}.bearer_token_env_var={}",
                toml_string(TOKEN_ENV)
            ),
        ],
        _ => Vec::new(),
    };
    Spawn { args, env }
}

/// Put a tab's extra arguments into its argv. Claude Code's `--mcp-config`
/// takes every value up to the next flag, so its pair goes right before the
/// first flag there is (after a Windows `cmd.exe /C <binary>` prefix), or
/// last when there's none: never in front of the opening prompt. Anything
/// else goes first, like the preview's own flags. Pure.
pub fn place(args: &mut Vec<String>, cli: Option<&str>, extra: Vec<String>) {
    if extra.is_empty() {
        return;
    }
    if cli != Some("claude-code") {
        crate::preview_isolation::insert_front(args, extra);
        return;
    }
    let start = if args.first().is_some_and(|a| a.eq_ignore_ascii_case("/C")) && args.len() >= 2 {
        2
    } else {
        0
    };
    match (start..args.len()).find(|&i| args[i].starts_with('-')) {
        Some(at) => {
            args.splice(at..at, extra);
        }
        None => args.extend(extra),
    }
}

/// Claude Code's `--mcp-config` contents for a tab: the one server, its URL
/// and the secret as a header. Pure.
pub fn claude_config(url: &str, secret: &str) -> String {
    json!({
        "mcpServers": {
            super::tools::SERVER_KEY: {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {secret}") },
            }
        }
    })
    .to_string()
}

fn toml_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// [`spawn_for`] for a tab the app is about to spawn: only while Your
/// Chrome is on (a tab started while it's off gets nothing, rather than a
/// server that fails), with the bridge listening.
pub async fn spawn_args(
    app: &tauri::AppHandle,
    pty_id: &str,
    cli: Option<&str>,
    project_path: Option<&Path>,
) -> Spawn {
    if !super::SUPPORTED || !super::settings::enabled() {
        return Spawn::default();
    }
    let port = match crate::agent_bridge::start_global_agent_bridge(app.clone()).await {
        Ok((port, _)) => port,
        Err(e) => {
            tracing::warn!(error = %e, "[UserChrome] no bridge for a project tab's Chrome");
            return Spawn::default();
        }
    };
    let url = super::tools::url(port);
    let secret = for_project_tab(pty_id, project_path);
    let cli = cli.unwrap_or("");
    let mut config_path = None;
    if cli == "claude-code" {
        match crate::agents::reach::write_config(&claude_config(&url, &secret)) {
            Ok(file) => {
                config_path = Some(file.arg());
                CONFIGS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(pty_id.to_string(), file);
            }
            Err(e) => {
                tracing::warn!(error = %e, "[UserChrome] couldn't write a project tab's MCP config")
            }
        }
    }
    spawn_for(cli, &url, &secret, config_path.as_deref())
}

/* --------------------------------------------------------- Terminal */

/// Where the launcher finds the bridge and the Terminal secret: the
/// installed app's file, or a debug build's own beside it (a dev copy must
/// never answer the user's Terminal sessions).
pub fn endpoint_path() -> PathBuf {
    endpoint_path_for(&crate::brand::app_support_dir(), cfg!(debug_assertions))
}

/// [`endpoint_path`], pure.
pub fn endpoint_path_for(app_support: &Path, debug: bool) -> PathBuf {
    let name = if debug {
        "user-chrome-mcp-dev.json"
    } else {
        "user-chrome-mcp.json"
    };
    app_support.join(name)
}

/// What [`endpoint_path`] holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// Write the endpoint (0600, atomically). Called once the bridge listens.
pub fn write_endpoint_at(path: &Path, endpoint: &Endpoint) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(serde_json::to_string(endpoint)?.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// The endpoint at `path`, if it's there, the user's own and private.
pub fn read_endpoint_at(path: &Path) -> Option<Endpoint> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(path).ok()?;
        // SAFETY: getuid has no preconditions.
        if m.mode() & 0o077 != 0 || m.uid() != unsafe { libc::getuid() } {
            return None;
        }
    }
    let e: Endpoint = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (e.port != 0 && e.token.len() == 64).then_some(e)
}

/// Publish the bridge's port and the Terminal secret for the launcher.
pub fn publish(port: u16) {
    let endpoint = Endpoint {
        port,
        token: terminal_secret(),
    };
    if let Err(e) = write_endpoint_at(&endpoint_path(), &endpoint) {
        tracing::warn!(error = %e, "[UserChrome] couldn't write the Terminal launcher's endpoint");
    }
}

/// The app is quitting: Terminal sessions hear it's closed, not a refusal.
pub fn unpublish() {
    let _ = std::fs::remove_file(endpoint_path());
}

/// The command that registers the launcher for every Claude account, at
/// user scope, for this binary.
pub fn register_command(exe: &Path) -> String {
    format!(
        "claude mcp add --scope user {} -- {} mcp user-chrome",
        super::tools::SERVER_KEY,
        shell_quote(&exe.to_string_lossy())
    )
}

fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
