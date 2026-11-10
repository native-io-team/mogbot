//! The sealed check of [`super::watch_seal`], on Codex: how a "When…"
//! routine or a morning-brief check runs for someone with Codex and no
//! Claude Code.
//!
//! The seal, every part of it set on the command line (`codex exec`):
//!
//! - **None of the user's setup.** `--ignore-user-config` (their
//!   config.toml: its MCP servers, providers, hooks, profiles and features
//!   don't load), `--ignore-rules` (no execpolicy rules), `--ephemeral` (no
//!   session saved), `project_doc_max_bytes=0` (no AGENTS.md from the
//!   folder) and no skill list. `--strict-config`: an override this Codex
//!   doesn't know stops the check instead of being skipped, so a renamed
//!   setting can't quietly leave a door open.
//! - **No shell, no files, no web.** The shell tools are off
//!   (`--disable shell_tool`, `unified_exec`), as are images, web search,
//!   subagents, browsers, computer use, apps, plugins, goals and hooks.
//!   What's left is the MCP resource tools (which reach only our server, and
//!   the relay refuses them) and `apply_patch`, which the read-only sandbox
//!   refuses. The sandbox is `read-only` with no network for commands, and
//!   the approval policy `never`: anything that needs asking is refused.
//! - **One connection, reads only.** The one server is our relay
//!   (`conn_relay`, a check's own secret in an environment variable, never
//!   argv). Codex runs an MCP tool under `never` only when the server marks
//!   it read-only, and the relay lists only the read tools
//!   (`watch_seal::READ_VERBS`), marked so, and refuses any other call.
//!   A server from the user's own Codex or Claude Code config is never used
//!   here: Codex would need its config (and any secret in it) on argv.
//! - **Checked afterwards too.** Any step in Codex's answer that isn't a
//!   message, reasoning or a call to our server fails the check, and
//!   nothing it said is used ([`parse_result`]).
//!
//! Verified on Codex 0.166 against a scripted model (docs/agents.md, "When…
//! routines"): a read tool ran; a write tool, the shell (`exec_command`,
//! with or without asking to escalate), `apply_patch`, `view_image`,
//! `web_search`, `spawn_agent` and `request_user_input` were each refused;
//! the user's config.toml server, folder AGENTS.md and skills didn't load.
//! What still loads: `$CODEX_HOME/AGENTS.md` (the user's own global
//! instructions; Codex has no switch for it), which gives the check no
//! tool. Not verified with a real account's model or a real app.

use serde_json::Value;
use std::path::Path;

use super::usage::UsageTotals;

/// The first Codex this seal was verified on. Older ones don't get a check.
pub const SINCE: (u64, u64) = (0, 166);

/// The environment variable holding the check's relay secret.
pub const TOKEN_ENV: &str = "SHIPSTUDIO_AGENTS_CHECK_TOKEN";

/// Codex features turned off for a check: every built-in that could reach
/// a file, a command, the web or another agent.
pub const FEATURES_OFF: [&str; 19] = [
    "shell_tool",
    "unified_exec",
    "view_image",
    "image_generation",
    "multi_agent",
    "apps",
    "plugins",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "in_app_browser",
    "goals",
    "hooks",
    "memories",
    "skill_search",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "sleep_tool",
    "workspace_dependencies",
];

/// Whether a connection's server key can name a server in a `-c` path as
/// it is: letters, digits and `_` (`connections::server_key_for` makes
/// them so). Anything else isn't run.
pub fn key_is_plain(server_key: &str) -> bool {
    !server_key.is_empty()
        && server_key.len() <= 64
        && server_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Every argument the check's `codex` gets. The prompt goes on stdin.
/// `server_key` (plain: [`key_is_plain`]) and `relay_url` name the one
/// connection; its secret is in [`TOKEN_ENV`]. `model`: a small one when
/// Codex lists one ([`small_model`]).
pub fn args(server_key: &str, relay_url: &str, model: Option<&str>) -> Vec<String> {
    let toml = super::codex::toml;
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--strict-config",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
    ]
    .map(String::from)
    .to_vec();
    for feature in FEATURES_OFF {
        args.extend(["--disable".into(), feature.to_string()]);
    }
    let server = format!(
        "mcp_servers.{}={{url={},bearer_token_env_var={},startup_timeout_sec=30,tool_timeout_sec=120}}",
        server_key,
        toml(relay_url),
        toml(TOKEN_ENV),
    );
    let config = [
        "approval_policy=\"never\"".to_string(),
        "web_search=\"disabled\"".to_string(),
        "project_doc_max_bytes=0".to_string(),
        "skills.include_instructions=false".to_string(),
        "skills.bundled.enabled=false".to_string(),
        "model_reasoning_effort=\"low\"".to_string(),
        format!(
            "developer_instructions={}",
            toml(super::watch_seal::SYSTEM_PROMPT)
        ),
        server,
    ];
    for value in config.into_iter().chain(super::codex::extra_config()) {
        args.extend(["-c".into(), value]);
    }
    if let Some(model) = model {
        args.extend(["-m".into(), model.to_string()]);
    }
    args.push("-".into());
    args
}

/// A small model from Codex's own list (`models_cache.json`), in its own
/// order: the first listed one it describes as fast, efficient or
/// affordable, or named mini. `None`: Codex's default, at low effort.
pub fn small_model(cache: &str) -> Option<String> {
    let value: Value = serde_json::from_str(cache).ok()?;
    let mut listed: Vec<(i64, String)> = value
        .get("models")?
        .as_array()?
        .iter()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug")?.as_str()?;
            let plain = !slug.starts_with('-')
                && slug
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
            let about = m
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let small = slug.contains("mini")
                || ["fast", "efficient", "affordable", "cheap"]
                    .iter()
                    .any(|w| about.contains(w));
            let priority = m
                .get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            (plain && small).then(|| (priority, slug.to_string()))
        })
        .collect();
    listed.sort_by_key(|(p, _)| *p);
    listed.into_iter().next().map(|(_, slug)| slug)
}

/// [`small_model`] from this Mac's Codex.
pub fn small_model_here() -> Option<String> {
    super::codex::codex_home()
        .and_then(|home| std::fs::read_to_string(home.join("models_cache.json")).ok())
        .and_then(|raw| small_model(&raw))
}

/// Whether this Codex is one the seal was verified on ([`SINCE`] or later).
pub async fn can_seal(binary: &Path) -> bool {
    super::codex::version_is_at_least(binary, SINCE).await
}

/// `codex exec --json`'s answer: the last message, or why not. `server_key`
/// is the one server it may call. Anything else it did (a command, a file
/// change, a web search, another server) fails the check outright.
pub fn parse_result(
    stdout: &str,
    server_key: &str,
) -> (Result<String, String>, Option<UsageTotals>) {
    let mut reply: Option<String> = None;
    let mut usage: Option<UsageTotals> = None;
    let mut failed: Option<String> = None;
    let mut stray: Option<String> = None;
    let mut read_any = false;
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        read_any = true;
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "item.started" | "item.updated" | "item.completed" => {
                let item = event.get("item").cloned().unwrap_or(Value::Null);
                match item.get("type").and_then(Value::as_str).unwrap_or("") {
                    "agent_message" => {
                        if event["type"] == "item.completed" {
                            reply = item.get("text").and_then(Value::as_str).map(str::to_string);
                        }
                    }
                    "reasoning" | "error" => {}
                    "mcp_tool_call"
                        if item.get("server").and_then(Value::as_str) == Some(server_key) => {}
                    other => {
                        stray.get_or_insert_with(|| other.to_string());
                    }
                }
            }
            "turn.completed" => usage = super::codex::usage(&event),
            "turn.failed" => {
                failed = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(Some(String::new()));
            }
            _ => {}
        }
    }
    if let Some(kind) = stray {
        tracing::warn!(step = %kind, "[Agents] A sealed Codex check did something it may not");
        return (
            Err("Codex did something this check doesn't allow, so its answer wasn't used.".into()),
            usage,
        );
    }
    if let Some(why) = failed {
        let why = why.trim();
        return (
            Err(if why.is_empty() {
                "Codex couldn't run the check.".to_string()
            } else {
                why.chars().take(200).collect()
            }),
            usage,
        );
    }
    match reply {
        Some(text) => (Ok(text), usage),
        None if read_any => (Err("Codex finished without an answer.".into()), usage),
        None => (Err("Codex's answer couldn't be read.".into()), None),
    }
}

#[cfg(test)]
#[path = "watch_seal_codex_tests.rs"]
mod tests;
