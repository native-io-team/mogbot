//! OpenCode through `opencode acp`: one process per turn, spoken to over the
//! Agent Client Protocol (JSON-RPC on stdin/stdout), like Codex's
//! app-server. Verified against OpenCode 1.18.29 with its free "OpenCode
//! Zen" models (`testdata/opencode-acp.jsonl` is its real output):
//!
//! - `initialize` → `session/new {cwd, mcpServers}` (or `session/load
//!   {sessionId, …}`, which first replays the whole conversation as
//!   `session/update`s, so nothing before its answer is this turn's) →
//!   `session/prompt`, answered with `{stopReason, usage}` when the turn ends.
//! - Our MCP servers go in `session/new` with their `Authorization` header:
//!   the turn's bridge secret travels over stdin, never argv or a file.
//! - Everything else is the inline config in `OPENCODE_CONFIG_CONTENT`
//!   ([`config`]), which outranks the user's own config files. Project
//!   config (`opencode.json`, `.opencode/agent/*.md` in the folder it works
//!   in) is switched off with `OPENCODE_DISABLE_PROJECT_CONFIG`: checked on
//!   1.18.29, a project's `.opencode/agent/build.md` saying `bash: allow`
//!   otherwise let commands run without asking. Instructions are handed over
//!   explicitly instead ([`instruction_files`]).
//! - Permissions are "ask" for everything that acts ([`permissions`]); each
//!   ask arrives as `session/request_permission` and is answered with
//!   `once` or `reject` (never `always`, which OpenCode would remember).
//!   Writes into `.git` / `.shipstudio` are denied by the config itself
//!   (checked: `**/.git/**` refuses a write there without asking).
//! - A reject ends OpenCode's loop with nothing said, and carries no message
//!   (ACP has no field for one), so what the agent should be told goes as the
//!   next `session/prompt` once the turn ends ([`Conversation`]'s notes).
//!   OpenCode also rejects every other ask still open in the session: those
//!   are answered without a card ([`Gate`]).
//! - `session/cancel` ends the turn as `stopReason: cancelled`.
//! - Usage: the prompt's answer carries the turn's tokens; `usage_update`
//!   says how full the context is (`used` / `size`). OpenCode's `cost` is
//!   its own estimate from list prices, so it isn't kept.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::codex_app::Out;
use super::engine::ModelChoice;
use super::mcp::{self, Decision};
use super::stream::Step;
use super::usage::UsageTotals;

/// Request ids for the turn's own requests; follow-up prompts count up from
/// [`PROMPT`].
const INITIALIZE: u64 = 1;
const SESSION: u64 = 2;
const PROMPT: u64 = 3;

/// At most this many follow-up prompts carry the app's notes in one turn.
const MAX_FOLLOW_UPS: u64 = 4;

/// The turn's process: everything else is in the environment and over stdin.
pub fn args() -> Vec<String> {
    vec!["acp".to_string()]
}

/* ---------------------------------------------------------- the config */

/// Every permission OpenCode knows (1.18.29), and ours for each. Reading
/// and searching where it works go through, as for Claude Code; anything
/// that acts asks us; a sub-agent (`task`) is off, since its asks run in a
/// session of their own; a form question (`question`) and the repeated-call
/// guard (`doom_loop`) are refused: questions go in the chat.
pub fn permissions(servers: &[String]) -> Value {
    let mut p = serde_json::Map::new();
    p.insert("*".into(), json!("ask"));
    for allowed in [
        "read",
        "glob",
        "grep",
        "list",
        "lsp",
        "todoread",
        "todowrite",
        "skill",
    ] {
        p.insert(allowed.into(), json!("allow"));
    }
    let mut edit = serde_json::Map::new();
    edit.insert("*".into(), json!("ask"));
    for dir in super::reach::PROTECTED_DIRS {
        edit.insert(format!("**/{dir}"), json!("deny"));
        edit.insert(format!("**/{dir}/**"), json!("deny"));
    }
    p.insert("edit".into(), Value::Object(edit));
    for asked in [
        "bash",
        "webfetch",
        "websearch",
        "codesearch",
        "external_directory",
    ] {
        p.insert(asked.into(), json!("ask"));
    }
    for refused in ["task", "question", "doom_loop"] {
        p.insert(refused.into(), json!("deny"));
    }
    // The app's own tools, and the servers it gives the turn (each decides
    // its own calls: the relay's grant and card, the browsers' gate), never
    // asked twice: as Claude Code's `--allowedTools mcp__app` and Codex's
    // `default_tools_approval_mode = "approve"`.
    for server in
        std::iter::once(super::prompts::SERVER_KEY).chain(servers.iter().map(String::as_str))
    {
        p.insert(format!("{server}_*"), json!("allow"));
    }
    Value::Object(p)
}

/// The turn's inline config (`OPENCODE_CONFIG_CONTENT`). No secret in it:
/// the servers' headers go over stdin in `session/new`.
pub fn config(model: Option<&str>, instructions: &[PathBuf], servers: &[String]) -> String {
    let permission = permissions(servers);
    let mut config = json!({
        "$schema": "https://opencode.ai/config.json",
        "share": "disabled",
        "autoupdate": false,
        "default_agent": "build",
        "instructions": instructions.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        "permission": permission,
        // The user's own `build` agent can't loosen it either; nor their
        // `mode.build`, which OpenCode folds into the agent after every
        // config file, this one included.
        "agent": { "build": { "permission": permission } },
        "mode": { "build": { "permission": permission } },
        // No language servers and no formatters, whatever the user's own
        // config turns on: both run the project's own code (an ESLint
        // config, a Prettier plugin) on a file read or an approved edit,
        // with no card for running it. Claude Code and Codex run neither.
        "lsp": false,
        "formatter": false,
        // Our tools can wait on a card: past our own wait, so we answer first.
        "experimental": { "mcp_timeout": (mcp::APPROVAL_WAIT_SECS + 60) * 1000 },
    });
    if let Some(model) = model {
        config["model"] = json!(model);
    }
    config.to_string()
}

/// The environment a turn's `opencode` gets on top of the app's own.
pub fn env(config: String) -> Vec<(&'static str, String)> {
    vec![
        ("OPENCODE_CONFIG_CONTENT", config),
        // A project's own config could loosen permissions (see the module).
        ("OPENCODE_DISABLE_PROJECT_CONFIG", "1".into()),
        ("OPENCODE_DISABLE_AUTOUPDATE", "1".into()),
        ("OPENCODE_DISABLE_SHARE", "1".into()),
    ]
}

/// Variables taken out of a turn's environment: `OPENCODE_PERMISSION` is
/// merged over every config, the inline one included (checked in 1.18.29's
/// `Config.loadInstanceState`), so one set in the app's environment would
/// answer asks before they reach the broker.
pub const ENV_REMOVED: &[&str] = &["OPENCODE_PERMISSION"];

/// What it is told, as files OpenCode reads into its instructions: the
/// turn's system prompt (a 0600 file of the turn's), then the folder's own
/// `AGENTS.md`, else its `CLAUDE.md` (an unbound agent's home: its own
/// instructions and memory), which project config being off would skip.
pub fn instruction_files(prompt_file: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut files = vec![prompt_file.to_path_buf()];
    if let Some(own) = ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .map(|name| cwd.join(name))
        .find(|p| p.is_file())
    {
        files.push(own);
    }
    files
}

/* ------------------------------------------------------------- models */

/// One model OpenCode can run, as it lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    /// `provider/model`, what its config's `model` takes.
    pub id: String,
    pub name: String,
    /// Served from this Mac (Ollama, LM Studio, llama.cpp…): its address is
    /// a loopback one, in OpenCode's catalogue or the user's config.
    pub local: bool,
}

static MODELS: LazyLock<Mutex<Option<(Vec<Model>, Instant)>>> = LazyLock::new(Default::default);

/// The models from the last look (see [`refresh`]); empty before one.
pub fn listed() -> Vec<Model> {
    MODELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|(m, _)| m.clone())
        .unwrap_or_default()
}

/// The picker's choices: each model by its own name and provider, and a
/// local one said to be on this Mac.
pub fn models() -> Vec<ModelChoice> {
    listed()
        .into_iter()
        .map(|m| ModelChoice {
            label: label(&m),
            value: m.id,
        })
        .collect()
}

fn label(m: &Model) -> String {
    let provider = m.id.split_once('/').map(|(p, _)| p).unwrap_or("");
    if m.local {
        format!("{} · on this Mac", m.name)
    } else if provider.is_empty() {
        m.name.clone()
    } else {
        format!("{} · {provider}", m.name)
    }
}

/// Whether `model` (`provider/model`) is served from this Mac. Unknown, or
/// no model chosen (OpenCode's own default), is not.
pub fn is_local(model: Option<&str>) -> bool {
    let Some(model) = model else { return false };
    listed().iter().any(|m| m.id == model && m.local)
}

/// Ask the installed OpenCode for its models, at most once a minute: `opencode
/// models --verbose` (what it can run, with each one's address) and `opencode
/// debug config` (the user's providers, whose own `baseURL` says where a
/// custom one is). Project config is off for both, as for a turn.
pub async fn refresh(binary: &Path) -> Vec<Model> {
    if let Some((models, at)) = MODELS.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < Duration::from_secs(60) && !models.is_empty() {
            return models.clone();
        }
    }
    let run = |args: &'static [&'static str]| {
        let mut cmd = tokio::process::Command::new(binary);
        cmd.args(args)
            .env("PATH", crate::utils::get_extended_path())
            .env("OPENCODE_DISABLE_PROJECT_CONFIG", "1")
            .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
            .stdin(std::process::Stdio::null());
        if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }
        crate::external_command::run_with_timeout(cmd, "opencode", 30)
    };
    let (listed, config) = tokio::join!(run(&["models", "--verbose"]), run(&["debug", "config"]));
    let text = |out: Result<std::process::Output, _>| {
        out.ok()
            .filter(|o: &std::process::Output| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let Some(listed) = text(listed) else {
        return self::listed();
    };
    let config = text(config).unwrap_or_default();
    let models = parse_models(&listed, &config);
    *MODELS.lock().unwrap_or_else(|e| e.into_inner()) = Some((models.clone(), Instant::now()));
    models
}

/// `opencode models --verbose`: each model's `provider/model` line, then
/// its JSON. A model is local when its own address, or its provider's
/// `baseURL` in the resolved config, is a loopback one.
pub fn parse_models(listed: &str, config: &str) -> Vec<Model> {
    let config: Value = serde_json::from_str(config).unwrap_or(Value::Null);
    let provider_url = |provider: &str| {
        config
            .pointer(&format!("/provider/{provider}/options/baseURL"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let mut out: Vec<Model> = Vec::new();
    let mut id: Option<String> = None;
    let mut body = String::new();
    let flush = |id: &mut Option<String>, body: &mut String, out: &mut Vec<Model>| {
        if let Some(id) = id.take() {
            let info: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let provider = id.split_once('/').map(|(p, _)| p).unwrap_or("");
            let address = info
                .pointer("/api/url")
                .and_then(Value::as_str)
                .filter(|u| !u.is_empty())
                .map(str::to_string)
                .or_else(|| provider_url(provider));
            let name = info
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    id.split_once('/')
                        .map(|(_, m)| m)
                        .unwrap_or(&id)
                        .to_string()
                });
            if valid_id(&id) && !out.iter().any(|m| m.id == id) {
                out.push(Model {
                    local: address.as_deref().is_some_and(is_loopback_url),
                    name,
                    id,
                });
            }
        }
        body.clear();
    };
    for line in listed.lines() {
        let starts_entry = !line.is_empty()
            && !line.starts_with(char::is_whitespace)
            && !line.starts_with('{')
            && !line.starts_with('}');
        if starts_entry {
            flush(&mut id, &mut body, &mut out);
            id = Some(line.trim().to_string());
        } else if id.is_some() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut id, &mut body, &mut out);
    out
}

/// `provider/model`, nothing that could be read as anything else.
fn valid_id(id: &str) -> bool {
    let Some((provider, model)) = id.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !model.is_empty()
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@+".contains(c))
}

/// Whether a URL's host is this Mac.
pub fn is_loopback_url(address: &str) -> bool {
    let Ok(url) = url::Url::parse(address) else {
        return false;
    };
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/* --------------------------------------------------- where it may write */

/// Where the turn may write without asking (its working folder and the ones
/// it was given, as Claude Code's `acceptEdits` and `--add-dir`), and what
/// stays read-only inside them (its settings', and its own instructions in
/// a turn answering outside text).
#[derive(Debug, Clone, Default)]
pub struct Scope {
    pub writable: Vec<PathBuf>,
    pub read_only: Vec<PathBuf>,
}

/// What an edit's path is, for [`Scope`].
#[derive(Debug, Clone, PartialEq)]
enum Place {
    /// Inside a writable folder: goes through, as `acceptEdits` does.
    Ours,
    /// `.git` / `.shipstudio`, or kept read-only: refused, with why.
    Kept(String),
    /// Anywhere else: asked like Claude Code's edit outside its folders.
    Elsewhere,
}

impl Scope {
    /// Where an edit lands, judged on the path as written *and* on where it
    /// really goes: a symlink in a writable folder (a repo's `notes.md`
    /// pointing at `~/.zshrc`, or `hooks` at `.git/hooks`) is wherever it
    /// points. A path that can't be followed (a dangling link, which a write
    /// would create at its target) is never "ours": it asks.
    fn place(&self, path: &str) -> Place {
        let lexical = normalize(Path::new(path));
        let real = resolved(&lexical);
        let seen: Vec<&Path> = std::iter::once(lexical.as_path())
            .chain(real.as_deref())
            .collect();
        if seen.iter().any(|p| {
            p.components().any(|c| {
                super::reach::PROTECTED_DIRS
                    .iter()
                    .any(|d| c.as_os_str() == *d)
            })
        }) {
            return Place::Kept(format!(
                "{} is kept read-only for agents (git's and the app's own folders).",
                lexical.display()
            ));
        }
        let read_only = roots(&self.read_only);
        if seen
            .iter()
            .any(|p| read_only.iter().any(|r| p.starts_with(r)))
        {
            return Place::Kept(format!(
                "{} is read-only for this agent in this turn.",
                lexical.display()
            ));
        }
        let writable = roots(&self.writable);
        let inside = |p: &Path| writable.iter().any(|w| p.starts_with(w));
        match &real {
            Some(real) if inside(&lexical) && inside(real) => Place::Ours,
            _ => Place::Elsewhere,
        }
    }
}

/// Each folder as written and as it really is (`/var` is `/private/var`).
fn roots(list: &[PathBuf]) -> Vec<PathBuf> {
    list.iter()
        .flat_map(|r| {
            let r = normalize(r);
            let real = resolved(&r);
            std::iter::once(r).chain(real)
        })
        .collect()
}

/// `path` with every symlink on the way followed: its deepest part that
/// exists, canonicalized, then the rest (not there yet) as written. `None`
/// when a part is there but can't be followed (a dangling or looping link).
fn resolved(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut real) => {
                for part in rest.iter().rev() {
                    real.push(part);
                }
                return Some(real);
            }
            // There, but not followable: a link to nowhere.
            Err(_) if existing.symlink_metadata().is_ok() => return None,
            Err(_) => {}
        }
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?.to_path_buf();
    }
}

/// `..` and `.` taken out without touching the disk (the path may not exist).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/* -------------------------------------------------------- the tool calls */

/// An OpenCode tool call as the Claude Code call it corresponds to, so the
/// timeline, cards, "Always allow" and the independence levels read it the
/// same way. `servers`: the MCP servers it has, to split `server_tool`.
pub fn as_claude(name: &str, input: &Value, servers: &[String]) -> (String, Value) {
    let field = |k: &str| input.get(k).cloned().unwrap_or(Value::Null);
    let path = || {
        input
            .get("filePath")
            .or_else(|| input.get("filepath"))
            .or_else(|| input.get("path"))
            .cloned()
            .unwrap_or(Value::Null)
    };
    match name {
        "bash" => ("Bash".into(), json!({ "command": field("command") })),
        "read" => ("Read".into(), json!({ "file_path": path() })),
        "write" => ("Write".into(), json!({ "file_path": path() })),
        "edit" | "multiedit" | "patch" | "apply_patch" => {
            ("Edit".into(), json!({ "file_path": path() }))
        }
        "glob" => ("Glob".into(), json!({ "pattern": field("pattern") })),
        "grep" => ("Grep".into(), json!({ "pattern": field("pattern") })),
        "list" => ("LS".into(), json!({ "path": path() })),
        "webfetch" => ("WebFetch".into(), json!({ "url": field("url") })),
        "websearch" | "codesearch" => ("WebSearch".into(), json!({ "query": field("query") })),
        "todowrite" => ("TodoWrite".into(), Value::Null),
        "todoread" => ("TodoRead".into(), Value::Null),
        "task" => (
            "Task".into(),
            json!({ "description": field("description") }),
        ),
        "skill" => ("Skill".into(), json!({ "skill": field("name") })),
        _ => match split_mcp(name, servers) {
            Some((server, tool)) => (format!("mcp__{server}__{tool}"), input.clone()),
            None => (name.to_string(), input.clone()),
        },
    }
}

/// `server_tool` → (`server`, `tool`): the longest server it has whose name
/// prefixes it, so a server with `_` in its name splits right.
fn split_mcp<'a>(name: &'a str, servers: &[String]) -> Option<(&'a str, &'a str)> {
    let mut known: Vec<&str> = servers.iter().map(String::as_str).collect();
    known.push(super::prompts::SERVER_KEY);
    known.sort_by_key(|s| std::cmp::Reverse(s.len()));
    known.into_iter().find_map(|server| {
        let rest = name.strip_prefix(server)?.strip_prefix('_')?;
        (!rest.is_empty()).then(|| (&name[..server.len()], rest))
    })
}

/* ------------------------------------------------------------ the asks */

/// A permission OpenCode asks for, as the decision it needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    /// The JSON-RPC id to answer.
    id: Value,
    what: Asked,
}

#[derive(Debug, Clone, PartialEq)]
enum Asked {
    /// Through without a card (an edit where it may write).
    Allow,
    /// Refused without a card; what the agent is told.
    Refuse(String),
    /// The same decision a Claude Code call gets (`mcp::decide`).
    Decide { tool: String, input: Value },
}

/// One turn's asks, answered one at a time: a reject makes OpenCode refuse
/// every other ask open in the session, so those get no card.
#[derive(Debug, Default)]
pub struct Gate {
    order: tokio::sync::Mutex<()>,
    state: Mutex<GateState>,
}

#[derive(Debug, Default)]
struct GateState {
    /// The round (prompt) a reject ended, and what the agent is to be told.
    rejected_round: Option<u64>,
    notes: Vec<String>,
}

impl Gate {
    fn rejected(&self, round: u64) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .rejected_round
            == Some(round)
    }

    fn reject(&self, round: u64, note: String) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.rejected_round = Some(round);
        if !note.is_empty() && !state.notes.contains(&note) {
            state.notes.push(note);
        }
    }

    fn take_notes(&self) -> Vec<String> {
        std::mem::take(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()).notes)
    }
}

fn outcome(option: &str) -> Value {
    json!({ "outcome": { "outcome": "selected", "optionId": option } })
}

/// Answer one of OpenCode's asks: `once` or `reject`, never `always`.
/// `turn` is our id for the turn (`broker::open_turn`): like a Claude Code
/// request, one from a turn that has ended, or asked twice, gets no card.
pub async fn answer(
    app: &AppHandle,
    agent_id: &str,
    turn: u64,
    round: u64,
    ask: Ask,
    gate: Arc<Gate>,
) -> Vec<Value> {
    let reply = |option: &str| json!({ "jsonrpc": "2.0", "id": ask.id, "result": outcome(option) });
    let _one_at_a_time = gate.order.lock().await;
    // An earlier reject in this round refused this one already.
    if gate.rejected(round) {
        return vec![reply("reject")];
    }
    let refuse = |note: String| {
        gate.reject(round, format!("[Note from the app: {note}]"));
        vec![reply("reject")]
    };
    let (tool, input) = match ask.what {
        Asked::Allow => return vec![reply("once")],
        Asked::Refuse(why) => return refuse(why),
        Asked::Decide { tool, input } => (tool, input),
    };
    // JSON-RPC ids restart with each process, so they're named per turn.
    let request_id = format!("opencode-{turn}-{}", ask.id);
    let admission = super::broker::admit(agent_id, Some(turn), Some(&request_id));
    if admission != super::broker::Admission::Live {
        tracing::warn!(agent = %agent_id, turn, %request_id, ?admission, "[Agents] OpenCode permission request refused without asking");
        return refuse(super::broker::refusal(admission).to_string());
    }
    let Ok(agent) = super::store::get(agent_id) else {
        return vec![reply("reject")];
    };
    match mcp::decide(app, &agent, &tool, &input, None).await {
        Decision::Allow => vec![reply("once")],
        Decision::Deny(message) => refuse(format!(
            "{} was not run. {message}",
            super::work::describe_tool(&tool, Some(&input))
                .map(|a| format!("\"{}\"", a.label))
                .unwrap_or_else(|| tool.clone())
        )),
    }
}

/* ------------------------------------------------------ the conversation */

/// One turn's conversation with `opencode acp`.
#[derive(Debug)]
pub struct Conversation {
    session_request: Value,
    resuming: bool,
    prompt: String,
    session: Option<String>,
    /// Our latest `session/prompt` id; follow-ups count up from [`PROMPT`].
    prompt_id: u64,
    scope: Scope,
    /// The MCP servers it has besides ours, to read `server_tool` names.
    servers: Vec<String>,
    /// Each call's tool name, from its first `tool_call` (asks don't say).
    calls: HashMap<String, String>,
    /// Calls on the timeline, and how much of each one's output was sent on.
    announced: HashMap<String, usize>,
    /// Calls announced since [`Conversation::take_calls`], as Claude Code's.
    fresh_calls: Vec<(String, Value)>,
    /// The reply streaming: its message id and its text so far.
    reply: Option<(String, String)>,
    usage: UsageTotals,
    model: Option<String>,
    gate: Arc<Gate>,
    over: bool,
    cancelled: bool,
}

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// One MCP server for `session/new`: its address and the turn's secret.
pub struct McpServer {
    pub name: String,
    pub url: String,
}

impl Conversation {
    /// A conversation for one turn, and its first message. `session` is the
    /// conversation to pick up. `secret` is the turn's bridge secret, the
    /// header every server in `servers` gets.
    pub fn new(
        session: Option<&str>,
        cwd: &Path,
        prompt: &str,
        servers: &[McpServer],
        secret: &str,
        scope: Scope,
    ) -> (Self, Value) {
        let mcp: Vec<Value> = servers
            .iter()
            .map(|s| {
                json!({
                    "type": "http",
                    "name": s.name,
                    "url": s.url,
                    "headers": [{ "name": "Authorization", "value": format!("Bearer {secret}") }],
                })
            })
            .collect();
        let mut params = json!({ "cwd": cwd.to_string_lossy(), "mcpServers": mcp });
        let session_request = match session {
            Some(id) => {
                params["sessionId"] = json!(id);
                request(SESSION, "session/load", params)
            }
            None => request(SESSION, "session/new", params),
        };
        let first = request(
            INITIALIZE,
            "initialize",
            json!({
                "protocolVersion": 1,
                // We write no files for it and run no terminals: its own tools do.
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": crate::brand::SLUG, "title": crate::brand::NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
        );
        let conversation = Self {
            session_request,
            resuming: session.is_some(),
            prompt: prompt.to_string(),
            session: session.map(str::to_string),
            prompt_id: 0,
            scope,
            servers: servers.iter().map(|s| s.name.clone()).collect(),
            calls: HashMap::new(),
            announced: HashMap::new(),
            fresh_calls: Vec::new(),
            reply: None,
            usage: UsageTotals::default(),
            model: None,
            gate: Arc::new(Gate::default()),
            over: false,
            cancelled: false,
        };
        (conversation, first)
    }

    /// The asks' shared state, for [`answer`].
    pub fn gate(&self) -> Arc<Gate> {
        self.gate.clone()
    }

    /// The prompt round in progress (an ask belongs to it).
    pub fn round(&self) -> u64 {
        self.prompt_id
    }

    /// Stop the turn: `session/cancel`, answered by the prompt ending.
    pub fn interrupt(&mut self) -> Option<Value> {
        let session = self.session.clone()?;
        if self.over || self.prompt_id == 0 {
            return None;
        }
        self.cancelled = true;
        Some(
            json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } }),
        )
    }

    pub fn over(&self) -> bool {
        self.over
    }

    /// The calls announced since last asked (`exposure` reads them).
    pub fn take_calls(&mut self) -> Vec<(String, Value)> {
        std::mem::take(&mut self.fresh_calls)
    }

    fn end(&mut self, steps: impl IntoIterator<Item = Step>) -> Vec<Out> {
        self.over = true;
        let mut out = self.finish_reply();
        out.extend(steps.into_iter().map(Out::Step));
        out.extend([Out::Step(Step::Done), Out::Close]);
        out
    }

    /// The reply that was streaming, complete.
    fn finish_reply(&mut self) -> Vec<Out> {
        match self.reply.take() {
            Some((_, text)) => vec![Out::Step(Step::Reply(text.trim().to_string()))],
            None => Vec::new(),
        }
    }

    fn prompt(&mut self, text: &str) -> Out {
        self.prompt_id = if self.prompt_id == 0 {
            PROMPT
        } else {
            self.prompt_id + 1
        };
        Out::Send(request(
            self.prompt_id,
            "session/prompt",
            json!({
                "sessionId": self.session,
                "prompt": [{ "type": "text", "text": text }],
            }),
        ))
    }

    pub fn on_message(&mut self, msg: &Value) -> Vec<Out> {
        let method = msg.get("method").and_then(Value::as_str);
        match (method, msg.get("id")) {
            (Some(method), Some(id)) => self.on_request(method, id.clone(), &msg["params"]),
            (Some("session/update"), None) => self.on_update(&msg["params"]),
            (None, Some(id)) => self.on_response(id, msg),
            _ => Vec::new(),
        }
    }

    fn on_response(&mut self, id: &Value, msg: &Value) -> Vec<Out> {
        let Some(id) = id.as_u64() else {
            return Vec::new();
        };
        if let Some(message) = str_at(msg, "/error/message") {
            return match id {
                // A conversation it can't load: said the way the runner
                // knows, so a lost one is replaced once.
                SESSION if self.resuming => self.end([Step::Failed(format!(
                    "Session not found: OpenCode couldn't load it ({message})."
                ))]),
                INITIALIZE | SESSION => self.end([Step::Failed(message.to_string())]),
                id if id == self.prompt_id => self.end([Step::Failed(message.to_string())]),
                _ => Vec::new(),
            };
        }
        match id {
            INITIALIZE => vec![Out::Send(self.session_request.clone())],
            SESSION => {
                let result = &msg["result"];
                if let Some(id) = str_at(result, "/sessionId") {
                    self.session = Some(id.to_string());
                }
                let Some(session) = self.session.clone() else {
                    return self.end([Step::Failed("OpenCode started no conversation.".into())]);
                };
                self.model = result
                    .get("configOptions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|o| o.get("id").and_then(Value::as_str) == Some("model"))
                    .and_then(|o| o.get("currentValue")?.as_str().map(str::to_string));
                let prompt = self.prompt.clone();
                let mut out = vec![Out::Step(Step::Session(session))];
                out.extend(self.model.clone().map(|m| Out::Step(Step::Model(m))));
                out.push(self.prompt(&prompt));
                out
            }
            id if id == self.prompt_id => self.on_prompt_end(&msg["result"]),
            _ => Vec::new(),
        }
    }

    /// A prompt round ended: its tokens count, and the app's notes (what a
    /// rejected call was told) go as the next round, else the turn is over.
    fn on_prompt_end(&mut self, result: &Value) -> Vec<Out> {
        let usage = &result["usage"];
        let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        // Its input count leaves out what was read from cache, as ours does.
        self.usage.input_tokens = self.usage.input_tokens.saturating_add(n("inputTokens"));
        self.usage.output_tokens = self
            .usage
            .output_tokens
            .saturating_add(n("outputTokens").saturating_add(n("thoughtTokens")));
        self.usage.cache_read_tokens = self
            .usage
            .cache_read_tokens
            .saturating_add(n("cachedReadTokens"));
        self.usage.cache_write_tokens = self
            .usage
            .cache_write_tokens
            .saturating_add(n("cachedWriteTokens"));
        let mut out = self.finish_reply();
        let stop = str_at(result, "/stopReason").unwrap_or("end_turn");
        let notes = self.gate.take_notes();
        let follow_up = !self.cancelled
            && stop != "cancelled"
            && !notes.is_empty()
            && self.prompt_id < PROMPT + MAX_FOLLOW_UPS;
        if follow_up {
            out.push(self.prompt(&notes.join("\n")));
            return out;
        }
        // Tokens only: OpenCode's price is its estimate, not a bill.
        let usage = UsageTotals {
            turns: 1,
            ..self.usage.clone()
        };
        let mut steps = vec![Step::Usage(usage)];
        match stop {
            "refusal" => steps.push(Step::Failed(
                "The model refused to carry on with this.".into(),
            )),
            "max_tokens" => steps.push(Step::Detail(
                "OpenCode stopped: the model's reply hit its length limit.".into(),
            )),
            _ => {}
        }
        out.extend(self.end(steps));
        out
    }

    fn on_update(&mut self, params: &Value) -> Vec<Out> {
        // Until the session is ours, updates are a loaded conversation's
        // history, replayed: never this turn's.
        if self.prompt_id == 0 || str_at(params, "/sessionId") != self.session.as_deref() {
            return Vec::new();
        }
        let update = &params["update"];
        match str_at(update, "/sessionUpdate") {
            Some("agent_message_chunk") => {
                let Some(text) = str_at(update, "/content/text") else {
                    return Vec::new();
                };
                let id = str_at(update, "/messageId").unwrap_or("").to_string();
                let mut out = Vec::new();
                if self.reply.as_ref().is_some_and(|(open, _)| *open != id) {
                    out.extend(self.finish_reply());
                }
                if self.reply.is_none() {
                    self.reply = Some((id, String::new()));
                    out.push(Out::DraftOpen);
                }
                if let Some((_, so_far)) = self.reply.as_mut() {
                    so_far.push_str(text);
                }
                out.push(Out::DraftDelta(text.to_string()));
                out
            }
            Some("tool_call") | Some("tool_call_update") => self.on_tool(update),
            Some("usage_update") => {
                let used = update.get("used").and_then(Value::as_u64).unwrap_or(0);
                let size = update.get("size").and_then(Value::as_u64).unwrap_or(0);
                if used == 0 || size == 0 {
                    return Vec::new();
                }
                super::context::ContextFill::new(
                    used,
                    size,
                    super::store::now_ms(),
                    self.model.clone(),
                )
                .map(|fill| vec![Out::Step(Step::Context(fill))])
                .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }

    fn on_tool(&mut self, update: &Value) -> Vec<Out> {
        let Some(id) = str_at(update, "/toolCallId").map(str::to_string) else {
            return Vec::new();
        };
        // Its first word names the tool; later ones are what it's doing.
        if str_at(update, "/sessionUpdate") == Some("tool_call") {
            if let Some(name) = str_at(update, "/title") {
                self.calls
                    .entry(id.clone())
                    .or_insert_with(|| name.to_string());
            }
        }
        let Some(name) = self.calls.get(&id).cloned() else {
            return Vec::new();
        };
        let input = update.get("rawInput").cloned().unwrap_or(Value::Null);
        let status = str_at(update, "/status");
        // Its input is whole once it runs: the pending `tool_call` carries
        // none, or only its folder (`bash` says `cwd` before `command`).
        let running = str_at(update, "/sessionUpdate") == Some("tool_call_update")
            && matches!(status, Some("in_progress" | "completed" | "failed"));
        let mut out = Vec::new();
        // A reply before a tool call is a message of its own.
        if self.reply.is_some() {
            out.extend(self.finish_reply());
        }
        if !self.announced.contains_key(&id) && running {
            let (tool, input) = as_claude(&name, &input, &self.servers);
            self.fresh_calls.push((tool.clone(), input.clone()));
            if let Some(mut action) = super::work::describe_tool(&tool, Some(&input)) {
                action.id = Some(id.clone());
                action.exact = Some(format!("{tool} {input}"));
                if tool == "Bash" {
                    action.command = input
                        .get("command")
                        .and_then(Value::as_str)
                        .map(String::from);
                }
                out.push(Out::Step(Step::Action(action)));
            }
            self.announced.insert(id.clone(), 0);
        }
        let text = output_text(update);
        if status == Some("in_progress") {
            if let (Some(text), Some(sent)) = (text.as_deref(), self.announced.get_mut(&id)) {
                // Each update carries all of it so far: only what's new goes on.
                if text.len() > *sent && text.is_char_boundary(*sent) {
                    out.push(Out::Step(Step::Output {
                        id: id.clone(),
                        text: text[*sent..].to_string(),
                    }));
                    *sent = text.len();
                }
            }
        }
        if matches!(status, Some("completed" | "failed")) && self.announced.contains_key(&id) {
            use super::work::Outcome;
            let rejected = text
                .as_deref()
                .is_some_and(|t| t.contains("rejected permission") || t.contains("user rejected"));
            let exit = update
                .pointer("/rawOutput/metadata/exit")
                .and_then(Value::as_i64);
            let outcome = match status {
                Some("failed") if rejected => Outcome::Declined,
                Some("failed") => Outcome::Failed,
                _ if exit.is_some_and(|c| c != 0) => Outcome::Failed,
                _ => Outcome::Done,
            };
            out.push(Out::Step(Step::Result(super::work::CallResult {
                id: id.clone(),
                outcome,
                output: str_at(update, "/rawOutput/output")
                    .map(String::from)
                    .or(text),
            })));
        }
        out
    }

    fn on_request(&mut self, method: &str, id: Value, params: &Value) -> Vec<Out> {
        match method {
            "session/request_permission" => {
                let call = str_at(params, "/toolCall/toolCallId").unwrap_or("");
                let input = params
                    .pointer("/toolCall/rawInput")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let name = self.calls.get(call).cloned();
                let kind = str_at(params, "/toolCall/kind").unwrap_or("");
                let what = self.classify(name.as_deref(), kind, &input);
                vec![Out::AskOpenCode(Box::new(Ask { id, what }))]
            }
            // Anything else (writing a file for it, a terminal) is its own
            // tools' to do, never ours.
            _ => vec![Out::Send(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("This app doesn't handle {method}") },
            }))],
        }
    }

    /// What one ask is, and how it's decided. OpenCode's ask names its
    /// permission only through what it carries: a command (`bash`), a diff
    /// (`edit`), a folder outside its own (`external_directory`), a URL
    /// (`webfetch`), a query (`websearch`); else the call's own tool.
    fn classify(&self, name: Option<&str>, kind: &str, input: &Value) -> Asked {
        let field = |k: &str| input.get(k).and_then(Value::as_str);
        if let Some(command) = field("command").filter(|_| kind == "execute") {
            return Asked::Decide {
                tool: "Bash".into(),
                input: json!({ "command": command }),
            };
        }
        if field("parentDir").is_some() {
            // Outside its working folder: a folder it may write is its own;
            // anywhere else is a read the rules decide (the edit asks again).
            let path = field("filepath").or(field("parentDir")).unwrap_or("");
            return match self.scope.place(path) {
                Place::Ours | Place::Kept(_) => Asked::Allow,
                Place::Elsewhere => Asked::Decide {
                    tool: "Read".into(),
                    input: json!({ "file_path": path }),
                },
            };
        }
        if kind == "edit" || field("diff").is_some() {
            let path = field("filepath").or(field("filePath")).unwrap_or("");
            return match self.scope.place(path) {
                Place::Ours => Asked::Allow,
                Place::Kept(why) => Asked::Refuse(why),
                Place::Elsewhere => Asked::Decide {
                    tool: if name == Some("write") {
                        "Write"
                    } else {
                        "Edit"
                    }
                    .into(),
                    input: json!({ "file_path": path }),
                },
            };
        }
        if let Some(name) = name {
            let (tool, input) = as_claude(name, input, &self.servers);
            return Asked::Decide { tool, input };
        }
        if let Some(url) = field("url") {
            return Asked::Decide {
                tool: "WebFetch".into(),
                input: json!({ "url": url }),
            };
        }
        if let Some(query) = field("query") {
            return Asked::Decide {
                tool: "WebSearch".into(),
                input: json!({ "query": query }),
            };
        }
        Asked::Refuse("OpenCode asked for something this app can't show; it wasn't allowed.".into())
    }
}

/// A tool update's text: its content blocks, joined.
fn output_text(update: &Value) -> Option<String> {
    let parts: Vec<&str> = update
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(|c| c.pointer("/content/text").and_then(Value::as_str))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/* ------------------------------------------------------- capabilities */

/// What an OpenCode agent can use: our own tools, the servers the turn is
/// given, and OpenCode's built-in shell, file edits, web fetch and search.
/// The user's own OpenCode MCP servers aren't listed (it has no listing that
/// says which are connected without starting them).
pub fn capabilities(
    caller: &super::store::Agent,
    now: i64,
    given: &[String],
) -> super::capabilities::Capabilities {
    let ours: Vec<String> = mcp::tool_names(caller)
        .into_iter()
        .map(|name| format!("mcp__{}__{name}", super::prompts::SERVER_KEY))
        .collect();
    let mut tools: Vec<&str> = ours.iter().map(String::as_str).collect();
    tools.extend(["Bash", "Edit", "WebFetch", "WebSearch"]);
    let servers: Vec<super::capabilities::Server> = given
        .iter()
        .map(|name| super::capabilities::Server {
            name: name.clone(),
            connected: true,
        })
        .collect();
    super::capabilities::Capabilities {
        seen_at: now,
        lines: super::capabilities::lines(super::engine::Engine::OpenCode, &tools, &servers),
    }
}

#[cfg(test)]
#[path = "opencode_tests.rs"]
mod tests;
