//! Claude Code's own MCP servers, as the apps dialog and "When…" routines
//! see them.
//!
//! Apps we sign in to ourselves (Linear, Notion, Figma, Stripe, Vercel,
//! Sentry) are connections (`agents/app_connect.rs`, `connections.rs`), for
//! every engine. What's here is what Claude Code itself brings into its
//! turns: servers the user set up in Claude Code, and claude.ai's
//! connectors. Nothing is stored by this app; this module only asks Claude
//! Code:
//!
//! - **List**: `claude mcp list` (it health-checks each server, so the status
//!   is Claude Code's own), plus a read-only look at Claude Code's config for
//!   which of those are user-scope, the only ones the dialog will remove.
//! - **Remove**: `claude mcp remove --scope user <name>`.
//!
//! Adding a server to Claude Code from here (`claude mcp add`, then `/mcp`
//! in a raw `claude` terminal to sign in) is gone: it showed Claude Code's
//! folder-trust prompt, left the user in a CLI, and reached Claude Code
//! agents only.
//!
//! Each call runs with the same stripped session environment as a turn
//! (`runner::strip_session_env`), so what's listed is what agents get.

use serde::Serialize;
use std::path::PathBuf;

use crate::commands::mcp::{
    classify_mcp_failure, drop_stale_git_bash_path, mcp_server_not_found, parse_status_text,
    strip_ansi,
};
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;

/// `claude mcp list` connects to every server to report its health.
const LIST_TIMEOUT_SECS: u64 = 60;
const CHANGE_TIMEOUT_SECS: u64 = 30;

/// An app's name as people say it: the catalogue's title when it's one we
/// know, else its config id in words ("google-drive" → "Google Drive"),
/// never the raw lower-case id. Mirrors `appTitle` in `src/lib/agentApps.ts`.
pub fn display_name(server: &str) -> String {
    if let Some(s) = super::logins::SERVICES
        .iter()
        .find(|s| s.id.eq_ignore_ascii_case(server))
    {
        return s.title.to_string();
    }
    let name = server.strip_prefix("claude.ai ").unwrap_or(server);
    name.split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// In Claude Code's user config: every agent gets it; removable here.
    User,
    /// One of the user's claude.ai connectors; managed on claude.ai.
    ClaudeAi,
    /// Project/local scope or a plugin: listed, but managed where it was set up.
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    /// The server's URL, or the command for a local one.
    pub target: String,
    /// `connected`, `needs_auth`, `error` or `unknown`, as Claude Code reported it.
    pub status: String,
    pub source: Source,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Apps {
    pub connected: Vec<App>,
}

/// One line of `claude mcp list`:
/// `<name>: <url or command> [(HTTP)] - <mark> <status>`. A claude.ai
/// connector's name has spaces in it ("claude.ai Google Drive").
fn parse_line(line: &str) -> Option<(String, String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with("Checking") || line.starts_with("No MCP") {
        return None;
    }
    let (name, rest) = line.split_once(": ")?;
    let (target, status) = match rest.rsplit_once(" - ") {
        Some((t, s)) => (t, parse_status_text(s)),
        None => (rest, "unknown".to_string()),
    };
    let target = target
        .trim()
        .trim_end_matches("(HTTP)")
        .trim_end_matches("(SSE)")
        .trim();
    Some((name.trim().to_string(), target.to_string(), status))
}

pub fn parse_list(output: &str, user_names: &[String]) -> Vec<App> {
    strip_ansi(output)
        .lines()
        .filter_map(parse_line)
        .map(|(name, target, status)| {
            let source = if user_names.contains(&name) {
                Source::User
            } else if name.starts_with("claude.ai ") {
                Source::ClaudeAi
            } else {
                Source::Other
            };
            App {
                name,
                target,
                status,
                source,
            }
        })
        .collect()
}

/// Claude Code's own config file: `$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json`.
pub(super) fn claude_config_path() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join(".claude.json")),
        _ => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// Names of the user-scope servers, read (never written) from Claude Code's config.
pub fn user_scope_names(config: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(config)
        .ok()
        .and_then(|v| v.get("mcpServers")?.as_object().cloned())
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default()
}

fn read_user_scope_names() -> Vec<String> {
    claude_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|text| user_scope_names(&text))
        .unwrap_or_default()
}

/// `claude <args>` as an agent turn would run it: same binary, same PATH,
/// none of a parent Claude Code session's variables, from the agents folder.
fn claude(args: &[&str]) -> Result<tokio::process::Command, CommandError> {
    let binary = crate::commands::claude::find_validated_binary("claude", "--version")
        .ok_or_else(|| {
            CommandError::expected(
                "Claude Code isn't installed, or the app can't find it. Install it from Settings → Agents.",
            )
        })?;
    let mut cmd = crate::utils::create_command(&binary);
    cmd.args(args)
        .env("PATH", crate::utils::get_extended_path());
    if let Some(home) = dirs::home_dir() {
        cmd.env("HOME", home);
    }
    super::runner::strip_session_env(&mut cmd);
    drop_stale_git_bash_path(&mut cmd);
    // Local-scope servers are keyed by folder; agents run under this one.
    if let Ok(root) = super::store::agents_root() {
        if root.is_dir() {
            cmd.current_dir(root);
        }
    }
    Ok(tokio::process::Command::from(cmd))
}

fn failure_details(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        stderr.into_owned()
    }
}

pub async fn list() -> Result<Apps, CommandError> {
    let output = run_with_timeout(
        claude(&["mcp", "list"])?,
        "claude mcp list",
        LIST_TIMEOUT_SECS,
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let details = failure_details(&output);
        if !details.to_ascii_lowercase().contains("no mcp servers") {
            return Err(classify_mcp_failure("list Claude Code's apps", &details));
        }
    }
    Ok(Apps {
        connected: parse_list(&stdout, &read_user_scope_names()),
    })
}

/// Remove a user-scope server. Others are managed where they were set up.
pub async fn remove(name: &str) -> Result<(), CommandError> {
    if !read_user_scope_names().iter().any(|n| n == name) {
        return Err(CommandError::expected(format!(
            "{name} isn't in your Claude Code user settings, so it's managed where it was set up."
        )));
    }
    let cmd = claude(&["mcp", "remove", "--scope", "user", name])?;
    let output = run_with_timeout(cmd, "claude mcp remove", CHANGE_TIMEOUT_SECS).await?;
    if output.status.success() {
        return Ok(());
    }
    let details = failure_details(&output);
    if mcp_server_not_found(&details) {
        return Ok(());
    }
    Err(classify_mcp_failure("remove the app", &details))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_is_named_the_way_people_say_it() {
        assert_eq!(display_name("figma"), "Figma");
        assert_eq!(display_name("gmail"), "Gmail");
        assert_eq!(display_name("google_calendar"), "Google Calendar");
        assert_eq!(display_name("google-drive"), "Google Drive");
        assert_eq!(display_name("claude.ai Google Calendar"), "Google Calendar");
    }

    /// Captured from Claude Code 2.1.318 (URLs shortened).
    const LIST: &str = "Checking MCP server health…\n\n\
        claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - \u{2714} Connected\n\
        Sanity: https://mcp.sanity.io (HTTP) - \u{2714} Connected\n\
        webflow: https://mcp.webflow.com/mcp (HTTP) - ! Needs authentication\n\
        figma: https://mcp.figma.com/mcp (HTTP) - \u{2714} Connected\n\
        playwright: npx @playwright/mcp@latest - \u{2717} Failed to connect\n";

    fn apps() -> Vec<App> {
        parse_list(LIST, &["Sanity".into(), "webflow".into(), "figma".into()])
    }

    #[test]
    fn reads_every_server_with_its_status_and_where_it_lives() {
        let apps = apps();
        let row = |name: &str| apps.iter().find(|a| a.name == name).unwrap().clone();
        assert_eq!(apps.len(), 5);
        assert_eq!(row("claude.ai Google Drive").source, Source::ClaudeAi);
        assert_eq!(row("claude.ai Google Drive").status, "connected");
        assert_eq!(row("Sanity").target, "https://mcp.sanity.io");
        assert_eq!(row("Sanity").source, Source::User);
        assert_eq!(row("webflow").status, "needs_auth");
        assert_eq!(row("playwright").status, "error");
        assert_eq!(row("playwright").target, "npx @playwright/mcp@latest");
        assert_eq!(row("playwright").source, Source::Other);
        assert!(parse_list(
            "No MCP servers configured. Use `claude mcp add` to add a server.",
            &[]
        )
        .is_empty());
    }

    #[test]
    fn user_scope_is_read_from_the_top_level_servers_only() {
        let config = r#"{"mcpServers":{"figma":{"type":"http"}},"projects":{"/x":{"mcpServers":{"playwright":{}}}}}"#;
        assert_eq!(user_scope_names(config), vec!["figma".to_string()]);
        assert!(user_scope_names("not json").is_empty());
        assert!(user_scope_names("{}").is_empty());
    }
}
