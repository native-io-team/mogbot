//! Codex as an engine: what every Codex turn shares (models, config,
//! capabilities, activity labels), and the `codex exec --json` fallback for a
//! Codex without a usable app-server (turns normally run through
//! [`super::codex_app`]). Its JSONL maps onto the same [`Step`]s Claude
//! Code's stream gives, so the chat, the activity line, usage and failures
//! are the same.
//!
//! Verified against Codex 0.166 driven by a scripted Responses endpoint
//! (`testdata/codex-exec.jsonl` is its real output), and signed out against
//! OpenAI's own:
//!
//! - Events: `thread.started {thread_id}`, `turn.started`, `item.started` /
//!   `item.completed` (`agent_message`, `command_execution`, `mcp_tool_call`,
//!   `file_change`, `web_search`, `todo_list`, `error`), `turn.completed
//!   {usage}`, `turn.failed {error}`, and `error {message}` while it retries.
//! - No text deltas: an `agent_message` only arrives complete, even when the
//!   model streamed it, so a Codex reply appears whole (no draft).
//! - `exec` forces the approval policy to "never" whatever is configured: no
//!   approval reaches a client or a `PermissionRequest` hook, and hooks set
//!   with `-c` aren't trusted (and so don't run) without a bypass flag we
//!   don't use. So commands run in Codex's `workspace-write` sandbox (the
//!   agent's folder and the user's projects, no network) and anything beyond
//!   it fails inside the turn rather than asking. Ship Studio's own cards
//!   (push, delete an agent) still appear: they're our tools.
//! - An MCP tool needs approval by default, which "never" refuses, so our
//!   server is set to `default_tools_approval_mode = "approve"`. The user's
//!   own Codex MCP servers keep their defaults: their write tools are refused.
//! - `developer_instructions` is fixed when a session starts (a resume keeps
//!   the first one), but the project doc is re-read every turn, and when it
//!   changed Codex hands over the new one. So the agent's CLAUDE.md is its
//!   project doc (`project_doc_fallback_filenames`), and memory edits reach
//!   the next turn, as with Claude Code.

use serde_json::Value;
use std::path::{Path, PathBuf};

use super::capabilities::{self, Capabilities, Server};
use super::engine::{Engine, ModelChoice};
use super::store::Agent;
use super::stream::Step;
use super::usage::UsageTotals;

/// Codex's own folder: `$CODEX_HOME`, else `~/.codex`.
pub fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".codex")),
    }
}

/// The models Codex lists for this account, from its own cache, in its own
/// order. Empty before Codex has fetched them (it does on first use).
pub fn models() -> Vec<ModelChoice> {
    codex_home()
        .and_then(|home| std::fs::read_to_string(home.join("models_cache.json")).ok())
        .map(|raw| models_from(&raw))
        .unwrap_or_default()
}

fn models_from(raw: &str) -> Vec<ModelChoice> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut listed: Vec<(i64, ModelChoice)> = value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug")?.as_str()?;
            // It becomes an argument: a plain model name or nothing.
            let plain = !slug.starts_with('-')
                && slug
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
            plain.then(|| {
                let label = m
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(slug);
                let priority = m
                    .get("priority")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX);
                (
                    priority,
                    ModelChoice {
                        value: slug.to_string(),
                        label: label.to_string(),
                    },
                )
            })
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    listed.into_iter().map(|(_, m)| m).collect()
}

/// The sandbox's network switch. Off for every Codex turn, on the command
/// line and again on the app-server's thread (see [`super::codex_app`]).
pub(super) const NO_NETWORK: &str = "sandbox_workspace_write.network_access";

/// A TOML value for `-c`: JSON's string and array syntax is TOML's too.
pub(super) fn toml<T: serde::Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Extra `-c` overrides, one per line, in debug builds only: how the e2e
/// suite points Codex at a scripted model when no account is signed in.
fn extra_config() -> Vec<String> {
    if !cfg!(debug_assertions) {
        return Vec::new();
    }
    std::env::var("SHIPSTUDIO_AGENTS_CODEX_CONFIG")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// Codex is pointed at the e2e suite's scripted model, which needs no sign-in.
pub(super) fn scripted() -> bool {
    !extra_config().is_empty()
}

/// The permissions profile every Codex turn runs under, when this Codex has
/// profiles ([`profiles_supported`]).
pub(super) const PROFILE: &str = "shipstudio_agent";

/// Where a turn's commands may write, as `-c` overrides.
///
/// With permission profiles (Codex 0.166+): the built-in `:workspace` (the
/// cwd and temp folders), the writable folders added as workspace roots, no
/// network, and every existing `.git` / `.shipstudio` folder inside them
/// read-only (`reach::protected_paths`). Verified on 0.166 with
/// `codex sandbox -P`: a write into a nested project's `.git` or
/// `.shipstudio` is refused while the project itself stays writable, and
/// `thread/start` reports the profile as active. Codex takes a glob only to
/// deny reading, so the folders are listed by path.
///
/// Without them (an older Codex), the legacy `workspace-write` roots, which
/// only keep a root's own top-level `.git` read-only.
fn sandbox_config(writable: &[String], protected: Option<&[PathBuf]>) -> Vec<String> {
    let Some(protected) = protected else {
        return vec![
            format!("sandbox_workspace_write.writable_roots={}", toml(writable)),
            format!("{NO_NETWORK}=false"),
        ];
    };
    let roots: Vec<String> = writable
        .iter()
        .map(|w| format!("{}=true", toml(w)))
        .collect();
    let read_only: Vec<String> = protected
        .iter()
        .map(|p| format!("{}=\"read\"", toml(&p.to_string_lossy())))
        .collect();
    vec![
        format!(
            "permissions.{PROFILE}={{extends=\":workspace\",network={{enabled=false}},workspace_roots={{{}}},filesystem={{{}}}}}",
            roots.join(","),
            read_only.join(","),
        ),
        format!("default_permissions={}", toml(PROFILE)),
    ]
}

/// The `-c` overrides every Codex turn gets, whichever way it runs: where
/// commands may write and what they may not ([`sandbox_config`]), no
/// network for them (set here, so a `network_access = true` in the user's
/// own config.toml can't widen it; checked against Codex 0.166 with `codex
/// sandbox`), our MCP server (its tools pre-approved: they put up their own
/// cards; its secret read from [`super::reach::TOKEN_ENV`], never written
/// here), CLAUDE.md as the project doc, and Ship Studio's preview server
/// disabled when it's registered. Then the e2e suite's own, in debug builds.
pub(super) fn shared_config(
    url: &str,
    writable: &[String],
    protected: Option<&[PathBuf]>,
) -> Vec<String> {
    let server = format!(
        "mcp_servers.{}={{url={},bearer_token_env_var={},tool_timeout_sec={},default_tools_approval_mode=\"approve\"}}",
        super::prompts::SERVER_KEY,
        toml(url),
        toml(super::reach::TOKEN_ENV),
        super::mcp::APPROVAL_WAIT_SECS + 60,
    );
    sandbox_config(writable, protected)
        .into_iter()
        .chain([
            server,
            "project_doc_fallback_filenames=[\"CLAUDE.md\"]".to_string(),
        ])
        // Ship Studio's preview server, off for this turn when it's registered:
        // an agent here drives our preview, never theirs.
        .chain(crate::preview_isolation::codex_override(None, None))
        .chain(extra_config())
        .collect()
}

/// Every argument a turn's `codex exec` gets, for a Codex without
/// `app-server` (see [`super::codex_app::available`]). The prompt goes on
/// stdin (`-`).
pub fn args(
    model: Option<&str>,
    session: Option<&str>,
    url: &str,
    developer_instructions: &str,
    writable: &[String],
    protected: Option<&[PathBuf]>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if session.is_some() {
        args.push("resume".into());
    }
    args.extend(["--json".into(), "--skip-git-repo-check".into()]);
    let config = sandbox_mode(protected).into_iter().chain([
        "approval_policy=\"never\"".to_string(),
        format!("developer_instructions={}", toml(developer_instructions)),
    ]);
    for value in config.chain(shared_config(url, writable, protected)) {
        args.extend(["-c".into(), value]);
    }
    if let Some(model) = model {
        args.extend(["-m".into(), model.to_string()]);
    }
    if let Some(id) = session {
        args.push(id.to_string());
    }
    args.push("-".into());
    args
}

/// The command line for the user taking over a Codex agent's thread
/// (`takeover`): Codex's own interactive `codex resume <thread>`, with the
/// overrides every turn gets (where it may write, no network, our MCP
/// server, CLAUDE.md as the project doc) and the app-server turn's sandbox
/// and approval policy, so it asks the person at the keyboard whatever a
/// turn would have put on a card. The agent's identity (and the secrets
/// section) goes in as `developer_instructions`, as a `codex exec` turn
/// passes it on every invocation: a thread `exec` made doesn't keep it, and
/// one app-server made is given the same text again. Checked against
/// `codex resume --help` on 0.166.
pub fn interactive_args(
    model: Option<&str>,
    thread: &str,
    url: &str,
    developer_instructions: &str,
    writable: &[String],
    protected: Option<&[PathBuf]>,
    cwd: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["resume".into()];
    let config = sandbox_mode(protected).into_iter().chain([
        "approval_policy=\"on-request\"".to_string(),
        format!("developer_instructions={}", toml(developer_instructions)),
    ]);
    for value in config.chain(shared_config(url, writable, protected)) {
        args.extend(["-c".into(), value]);
    }
    if let Some(model) = model {
        args.extend(["-m".into(), model.to_string()]);
    }
    args.extend(["-C".into(), cwd.to_string()]);
    args.push(thread.to_string());
    args
}

/// `sandbox_mode`, which Codex refuses alongside `default_permissions`: only
/// without a profile.
fn sandbox_mode(protected: Option<&[PathBuf]>) -> Option<String> {
    protected
        .is_none()
        .then(|| "sandbox_mode=\"workspace-write\"".to_string())
}

/// The first Codex its permission profiles were verified on.
const PROFILES_SINCE: (u64, u64) = (0, 166);

/// Whether this Codex has permission profiles: its `--version` is
/// [`PROFILES_SINCE`] or later. Kept per binary until it changes (an
/// update); a version that can't be read counts as no.
pub async fn profiles_supported(binary: &Path) -> bool {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    use std::time::SystemTime;
    type Seen = HashMap<PathBuf, (Option<SystemTime>, bool)>;
    static CACHE: LazyLock<Mutex<Seen>> = LazyLock::new(Default::default);
    let stamp = std::fs::metadata(binary).and_then(|m| m.modified()).ok();
    if let Some((at, yes)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(binary) {
        if *at == stamp {
            return *yes;
        }
    }
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("--version")
        .env("PATH", crate::utils::get_extended_path());
    let Ok(out) = crate::external_command::run_with_timeout(cmd, "codex --version", 10).await
    else {
        return false;
    };
    let yes = version_at_least(&String::from_utf8_lossy(&out.stdout), PROFILES_SINCE);
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(binary.to_path_buf(), (stamp, yes));
    yes
}

/// `codex-cli 0.166.0` against (major, minor).
fn version_at_least(text: &str, (major, minor): (u64, u64)) -> bool {
    let Some(version) = text
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
    else {
        return false;
    };
    let mut parts = version.split('.').map(|p| {
        p.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u64>()
            .ok()
    });
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(a), Some(b)) => (a, b) >= (major, minor),
        _ => false,
    }
}

/// `/bin/zsh -lc 'npm test'` → `npm test`: the command, as the agent wrote it.
pub(super) fn unwrap_shell(command: &str) -> &str {
    let inner = command
        .split_once(" -lc ")
        .or_else(|| command.split_once(" -c "))
        .filter(|(shell, _)| shell.starts_with('/') && !shell.contains(' '))
        .map_or(command, |(_, rest)| rest);
    inner
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .unwrap_or(inner)
}

/// What a Codex item is doing, as a timeline step: the item as the Claude
/// Code tool call it corresponds to, labelled the same way.
pub(super) fn action(item: &Value) -> Option<super::work::Action> {
    let field = |k: &str| item.get(k).cloned().unwrap_or(Value::Null);
    let (name, input) = match item.get("type")?.as_str()? {
        "command_execution" => (
            "Bash".to_string(),
            serde_json::json!({ "command": unwrap_shell(item.get("command")?.as_str()?) }),
        ),
        "file_change" => (
            "Edit".to_string(),
            serde_json::json!({ "file_path": item.pointer("/changes/0/path").cloned().unwrap_or(Value::Null) }),
        ),
        "mcp_tool_call" => (
            format!(
                "mcp__{}__{}",
                item.get("server")?.as_str()?,
                item.get("tool")?.as_str()?
            ),
            field("arguments"),
        ),
        "web_search" => (
            "WebSearch".to_string(),
            serde_json::json!({ "query": field("query") }),
        ),
        "todo_list" => ("TodoWrite".to_string(), Value::Null),
        _ => return None,
    };
    let mut action = super::work::describe_tool(&name, Some(&input))?;
    action.id = item.get("id").and_then(Value::as_str).map(String::from);
    // One change can touch several files; every one of them counts.
    if let Some(changes) = item.get("changes").and_then(Value::as_array) {
        action.files = changes
            .iter()
            .filter_map(|c| c.get("path")?.as_str().map(String::from))
            .collect();
    }
    Some(action)
}

/// What became of a completed Codex item, by its id. `exec` says
/// `completed` / `failed` / `declined`; the app server says the same in
/// camelCase. A command that ran but exited non-zero failed.
pub(super) fn result(item: &Value) -> Option<super::work::CallResult> {
    use super::work::Outcome;
    let id = item.get("id")?.as_str()?;
    let outcome = match item.get("status").and_then(Value::as_str)? {
        "declined" | "denied" | "rejected" => Outcome::Declined,
        "failed" | "error" => Outcome::Failed,
        "completed" => {
            let exit = item
                .get("exit_code")
                .or_else(|| item.get("exitCode"))
                .and_then(Value::as_i64);
            if exit.is_some_and(|code| code != 0) {
                Outcome::Failed
            } else {
                Outcome::Done
            }
        }
        _ => return None,
    };
    let output = item
        .get("aggregatedOutput")
        .or_else(|| item.get("aggregated_output"))
        .and_then(Value::as_str)
        .map(String::from);
    Some(super::work::CallResult {
        id: id.to_string(),
        outcome,
        output,
    })
}

fn usage(value: &Value) -> Option<UsageTotals> {
    let usage = value.get("usage")?.as_object()?;
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    // Codex's input count includes what was read from cache; ours doesn't.
    let cached = n("cached_input_tokens");
    Some(UsageTotals {
        turns: 1,
        input_tokens: n("input_tokens").saturating_sub(cached),
        output_tokens: n("output_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: n("cache_write_input_tokens"),
        // A ChatGPT plan reports no price: tokens only, never an estimate.
        cost_usd: 0.0,
        priced_turns: 0,
        duration_ms: 0,
        ..Default::default()
    })
}

/// One line of `codex exec --json`, as turn steps.
pub fn steps(value: &Value) -> Vec<Step> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let text = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    match kind {
        "thread.started" => text("/thread_id").map(Step::Session).into_iter().collect(),
        "item.started" | "item.completed" => {
            let Some(item) = value.get("item") else {
                return Vec::new();
            };
            let item_type = item.get("type").and_then(Value::as_str);
            if kind == "item.completed" && item_type == Some("agent_message") {
                return text("/item/text").map(Step::Reply).into_iter().collect();
            }
            let mut out = Vec::new();
            // A file change only arrives complete; everything else says so as it starts.
            if kind == "item.started" || item_type == Some("file_change") {
                out.extend(action(item).map(Step::Action));
            }
            if kind == "item.completed" {
                out.extend(result(item).map(Step::Result));
            }
            out
        }
        "turn.completed" => usage(value)
            .map(Step::Usage)
            .into_iter()
            .chain([Step::Done])
            .collect(),
        "turn.failed" => {
            vec![
                Step::Failed(text("/error/message").unwrap_or_else(|| {
                    "Codex stopped with an error it didn't describe.".to_string()
                })),
                Step::Done,
            ]
        }
        // Retries say "Reconnecting... 2/5 (…)" and then carry on, or fail the turn.
        "error" => {
            let Some(message) = text("/message") else {
                return Vec::new();
            };
            let mut out = Vec::new();
            if let Some(rest) = message.strip_prefix("Reconnecting...") {
                let attempt = rest.split_whitespace().next().unwrap_or("");
                out.push(Step::Activity(
                    format!("Reconnecting to Codex {attempt}")
                        .trim()
                        .to_string(),
                ));
            }
            out.push(Step::Detail(message));
            out
        }
        _ => Vec::new(),
    }
}

/// What a Codex agent can use: our own tools as served to it, Codex's
/// built-in shell, file edits and web search (seen in what it sends its
/// model), and the user's Codex MCP servers as `codex mcp list` reports them.
/// `asks`: the turn runs on app-server, where going past the sandbox asks.
pub async fn capabilities(caller: &Agent, binary: &Path, now: i64, asks: bool) -> Capabilities {
    let ours: Vec<String> = super::mcp::tool_names(caller)
        .into_iter()
        .map(|name| format!("mcp__{}__{name}", super::prompts::SERVER_KEY))
        .collect();
    let mut tools: Vec<&str> = ours.iter().map(String::as_str).collect();
    tools.extend(["Bash", "Edit", "WebSearch"]);
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["mcp", "list", "--json"])
        .env("PATH", crate::utils::get_extended_path());
    let servers = crate::external_command::run_with_timeout(cmd, "codex mcp list", 15)
        .await
        .ok()
        .map(|out| servers_from(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default();
    let mut lines = capabilities::lines(Engine::Codex, &tools, &servers);
    if asks {
        for line in &mut lines {
            line.detail = line.detail.replace(
                SANDBOX_LINE,
                "with no network for commands unless you allow it",
            );
        }
    }
    Capabilities {
        seen_at: now,
        lines,
    }
}

/// How the capability line ends for the sandbox (see `capabilities::lines`).
const SANDBOX_LINE: &str = "with no network for commands";

/// `codex mcp list --json`: enabled servers; one it says isn't logged in needs sign-in.
fn servers_from(raw: &str) -> Vec<Server> {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    list.iter()
        .filter(|s| s.get("enabled").and_then(Value::as_bool) != Some(false))
        .filter_map(|s| {
            Some(Server {
                name: s.get("name")?.as_str()?.to_string(),
                connected: s.get("auth_status").and_then(Value::as_str) != Some("not_logged_in"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("testdata/codex-exec.jsonl");

    fn all_steps(sample: &str) -> Vec<Step> {
        sample
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .flat_map(|v| steps(&v))
            .collect()
    }

    #[test]
    fn a_real_codex_turn_maps_onto_the_same_steps() {
        let steps = all_steps(SAMPLE);
        assert!(matches!(&steps[0], Step::Session(id) if id.starts_with("01a1a8a4")));
        let activities: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                Step::Action(a) => Some(a.doing.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(activities, ["Writing note.txt", "Checking on the team"]);
        let replies: Vec<&Step> = steps
            .iter()
            .filter(|s| matches!(s, Step::Reply(_)))
            .collect();
        assert!(matches!(replies.as_slice(), [Step::Reply(t)] if t == "All done."));
        let usage = steps.iter().find_map(|s| match s {
            Step::Usage(u) => Some(u.clone()),
            _ => None,
        });
        let usage = usage.unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens
            ),
            (600, 3000, 102)
        );
        assert_eq!(usage.priced_turns, 0, "a plan reports no price");
        assert!(matches!(steps.last(), Some(Step::Done)));
        // The model-metadata warning is an item, not something the agent said.
        assert!(!steps
            .iter()
            .any(|s| matches!(s, Step::Reply(t) if t.contains("metadata"))));
    }

    #[test]
    fn a_failed_turn_keeps_codexs_own_words() {
        let usage_limit = r#"{"type":"error","message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM."}
{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM."}}"#;
        let steps = all_steps(usage_limit);
        assert!(matches!(&steps[1], Step::Failed(t) if t.contains("try again at 7:18 PM")));
        assert!(matches!(steps.last(), Some(Step::Done)));
        let retrying = r#"{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}"#;
        let steps = all_steps(retrying);
        assert!(matches!(&steps[0], Step::Activity(a) if a == "Reconnecting to Codex 2/5"));
        assert!(matches!(&steps[1], Step::Detail(d) if d.contains("401 Unauthorized")));
    }

    #[test]
    fn the_command_line_runs_sandboxed_with_our_server_approved() {
        let agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "Finance", "shape": 0, "color": "red", "createdAt": 0,
            "engine": "codex", "model": "gpt-5.5"
        }))
        .unwrap();
        let roots = vec!["/h/a".to_string(), "/u/Ship \"Studio\"".to_string()];
        let fresh = args(
            agent.model.as_deref(),
            None,
            "http://127.0.0.1:9/mcp/agent",
            "Be \"brief\".\nOk",
            &roots,
            None,
        );
        assert_eq!(&fresh[..3], ["exec", "--json", "--skip-git-repo-check"]);
        let config: Vec<&str> = fresh
            .windows(2)
            .filter(|w| w[0] == "-c")
            .map(|w| w[1].as_str())
            .collect();
        assert!(config.contains(&"sandbox_mode=\"workspace-write\""));
        assert!(config
            .contains(&r#"sandbox_workspace_write.writable_roots=["/h/a","/u/Ship \"Studio\""]"#));
        // Commands get no network whatever the user's config.toml says.
        assert!(config.contains(&"sandbox_workspace_write.network_access=false"));
        assert!(config.contains(&r#"mcp_servers.shipstudio_agents={url="http://127.0.0.1:9/mcp/agent",bearer_token_env_var="SHIPSTUDIO_AGENTS_BRIDGE_TOKEN",tool_timeout_sec=300,default_tools_approval_mode="approve"}"#));
        assert!(config.contains(&r#"developer_instructions="Be \"brief\".\nOk""#));
        assert!(fresh.windows(2).any(|w| w[0] == "-m" && w[1] == "gpt-5.5"));
        assert_eq!(fresh.last().unwrap(), "-");
        let resumed = args(
            agent.model.as_deref(),
            Some("01a1"),
            "http://x",
            "",
            &roots,
            None,
        );
        assert_eq!(&resumed[..2], ["exec", "resume"]);
        assert_eq!(&resumed[resumed.len() - 2..], ["01a1", "-"]);
    }

    #[test]
    fn with_profiles_git_and_shipstudio_folders_are_kept_read_only() {
        let roots = vec!["/u/ShipStudio".to_string(), "/h/a".to_string()];
        let protected = vec![
            PathBuf::from("/u/ShipStudio/site/.git"),
            PathBuf::from("/u/ShipStudio/site/.shipstudio"),
        ];
        let line = args(None, None, "http://x", "", &roots, Some(&protected));
        let config: Vec<&str> = line
            .windows(2)
            .filter(|w| w[0] == "-c")
            .map(|w| w[1].as_str())
            .collect();
        // Codex refuses `sandbox_mode` or `[sandbox_workspace_write]` next to a profile.
        assert!(!config.iter().any(|c| c.starts_with("sandbox_")));
        assert!(config.contains(&r#"default_permissions="shipstudio_agent""#));
        assert!(config.contains(
            &r#"permissions.shipstudio_agent={extends=":workspace",network={enabled=false},workspace_roots={"/u/ShipStudio"=true,"/h/a"=true},filesystem={"/u/ShipStudio/site/.git"="read","/u/ShipStudio/site/.shipstudio"="read"}}"#
        ));
        // The bridge secret is never on the command line.
        assert!(!line.iter().any(|a| a.contains("Bearer")));
    }

    #[test]
    fn codex_versions_are_compared_by_major_and_minor() {
        assert!(version_at_least("codex-cli 0.166.0", (0, 166)));
        assert!(version_at_least("codex-cli 0.170.2\n", (0, 166)));
        assert!(version_at_least("codex-cli 1.0.0", (0, 166)));
        assert!(!version_at_least("codex-cli 0.165.9", (0, 166)));
        assert!(!version_at_least("codex-cli", (0, 166)));
        assert!(!version_at_least("", (0, 166)));
    }

    #[test]
    fn models_are_codexs_listed_ones_in_its_order() {
        let raw = r#"{"models":[
            {"slug":"gpt-b","display_name":"GPT-B","visibility":"list","priority":7},
            {"slug":"hidden","display_name":"Hidden","visibility":"hide","priority":1},
            {"slug":"gpt-a","display_name":"GPT-A","visibility":"list","priority":2},
            {"slug":"--evil","display_name":"Evil","visibility":"list","priority":0}
        ]}"#;
        let values: Vec<String> = models_from(raw).into_iter().map(|m| m.value).collect();
        assert_eq!(values, ["gpt-a", "gpt-b"]);
        assert!(models_from("not json").is_empty());
    }

    #[test]
    fn mcp_servers_are_read_from_codexs_list() {
        let raw = r#"[{"name":"Sanity","enabled":true,"auth_status":"bearer_token"},
            {"name":"linear","enabled":true,"auth_status":"not_logged_in"},
            {"name":"off","enabled":false,"auth_status":"unknown"}]"#;
        let servers = servers_from(raw);
        assert_eq!(servers.len(), 2);
        assert!(servers[0].connected && !servers[1].connected);
    }

    #[test]
    fn the_sandbox_line_is_the_one_capabilities_writes() {
        let lines = capabilities::lines(Engine::Codex, &["Bash"], &[]);
        assert!(lines.iter().any(|l| l.detail.contains(SANDBOX_LINE)));
    }

    #[test]
    fn shell_wrappers_are_peeled_off() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'npm test'"), "npm test");
        assert_eq!(unwrap_shell("/bin/bash -c ls"), "ls");
        assert_eq!(unwrap_shell("git status"), "git status");
    }
}
