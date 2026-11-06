//! Codex through `codex app-server`: one app-server per turn, spoken to over
//! JSON-RPC on stdin/stdout, so a Codex agent gets what `codex exec` can't
//! give it: replies that stream as drafts, cards for its own commands, and an
//! interrupt that ends the turn cleanly. `exec` stays as the fallback for a
//! Codex whose app-server lacks any of this ([`available`]).
//!
//! Verified against Codex 0.166 driven by a scripted Responses endpoint
//! (`testdata/codex-app-server.jsonl` is its real output):
//!
//! - `initialize` → `initialized` → `thread/start` (or `thread/resume`, which
//!   picks a thread up from another process, or fails "no rollout found") →
//!   `turn/start`. Notifications carry the thread id; a sub-agent's run in
//!   its own thread, and stay internal like Claude Code's.
//! - `item/started agentMessage` → `item/agentMessage/delta`… →
//!   `item/completed agentMessage` (the whole text): a draft, then the reply
//!   in its place.
//! - With `approvalPolicy: on-request` in `workspace-write`, sandboxed
//!   commands run without asking and one that needs more (the model asks to
//!   escalate) arrives as `item/commandExecution/requestApproval`. A write
//!   tool on the user's own MCP servers arrives as `mcpServer/elicitation/
//!   request` with `_meta.codex_approval_kind = "mcp_tool_call"`. Both become
//!   the same cards Claude Code's calls get, with "Always allow" and late
//!   Allow. A decline has no message, so a note (or "not yet") goes ahead of
//!   it as `turn/steer`, which the model reads with the declined call's result.
//! - `turn/interrupt` ends the turn as `turn/completed {status: interrupted}`.
//! - Usage arrives as `thread/tokenUsage/updated`, once per model request;
//!   `last` is that request's.
//! - The plan's limits: `account/rateLimits/read` is asked once per turn and
//!   `account/rateLimits/updated` arrives unprompted (`super::quota`). The
//!   read's shape is from 0.166's schema; with no signed-in account here it
//!   was only seen failing ("authentication required"), which is ignored.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;
use tauri::AppHandle;

use super::mcp::{self, Decision};
use super::stream::Step;
use super::usage::UsageTotals;

/// Request ids for the turn's own requests. Steers use string ids.
const INITIALIZE: u64 = 1;
const START: u64 = 2;
const TURN: u64 = 3;
const INTERRUPT: u64 = 4;
/// `account/rateLimits/read`: the plan's windows, as Codex reports them
/// (`super::quota`). Refused for authentication (an API-key login) clears
/// the reading; any other error (an older Codex) is ignored.
const RATE_LIMITS: u64 = 5;

/// Every method this needs from the installed Codex, by the schema file
/// that has to list it.
const NEEDED: &[(&str, &[&str])] = &[
    (
        "ClientRequest.json",
        &[
            "thread/start",
            "thread/resume",
            "turn/start",
            "turn/steer",
            "turn/interrupt",
        ],
    ),
    (
        "ServerRequest.json",
        &[
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "mcpServer/elicitation/request",
        ],
    ),
    (
        "ServerNotification.json",
        &[
            "item/agentMessage/delta",
            "item/started",
            "item/completed",
            "turn/completed",
            "thread/tokenUsage/updated",
        ],
    ),
];

/// Whether this Codex's app-server speaks everything a turn needs: its own
/// schema (`codex app-server generate-json-schema`, ~0.1s) lists every
/// method. An answer is kept per binary until it changes (an update); a
/// check that couldn't run (it timed out, didn't start, or was killed) is not
/// an answer, so it says no for now and is asked again next time.
/// Debug builds can force `exec` with `SHIPSTUDIO_AGENTS_CODEX_EXEC=1`, so
/// the e2e suite still covers the fallback.
pub async fn available(binary: &Path) -> bool {
    /// Binary -> (its mtime when asked, whether it has an app-server).
    type Seen = HashMap<PathBuf, (Option<SystemTime>, bool)>;
    static CACHE: LazyLock<Mutex<Seen>> = LazyLock::new(Default::default);
    if cfg!(debug_assertions) && std::env::var("SHIPSTUDIO_AGENTS_CODEX_EXEC").is_ok() {
        return false;
    }
    let stamp = std::fs::metadata(binary).and_then(|m| m.modified()).ok();
    if let Some((at, yes)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(binary) {
        if *at == stamp {
            return *yes;
        }
    }
    let Some(yes) = schema_lists_everything(binary).await else {
        tracing::warn!("[Agents] Couldn't read Codex's app-server schema; asking again next turn");
        return false;
    };
    if !yes {
        tracing::info!(
            "[Agents] This Codex has no usable app-server; Codex agents run on `codex exec`"
        );
    }
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(binary.to_path_buf(), (stamp, yes));
    yes
}

/// What the binary's own schema says, or None when it couldn't be read.
async fn schema_lists_everything(binary: &Path) -> Option<bool> {
    let out = std::env::temp_dir().join(format!(
        "{}-codex-schema-{}-{}",
        crate::brand::SLUG,
        std::process::id(),
        super::store::new_id()
    ));
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["app-server", "generate-json-schema", "--out"])
        .arg(&out)
        .env("PATH", crate::utils::get_extended_path());
    let ran = crate::external_command::run_with_timeout(cmd, "codex app-server schema", 15).await;
    let yes = NEEDED.iter().all(|(file, methods)| {
        std::fs::read_to_string(out.join(file))
            .is_ok_and(|schema| methods.iter().all(|m| schema.contains(&format!("\"{m}\""))))
    });
    let _ = std::fs::remove_dir_all(&out);
    match ran {
        // An older Codex without the subcommand exits non-zero: an answer.
        Ok(o) if o.status.code().is_some() => Some(o.status.success() && yes),
        // Timed out, failed to start, or killed: says nothing about this Codex.
        _ => None,
    }
}

/// The command line: `app-server` with the same overrides `exec` gets.
/// Everything per thread (sandbox, approvals, model, instructions) goes in
/// `thread/start` instead.
pub fn args(url: &str, writable: &[String], protected: Option<&[PathBuf]>) -> Vec<String> {
    let mut args = vec!["app-server".to_string()];
    for value in super::codex::shared_config(url, writable, protected) {
        args.extend(["-c".into(), value]);
    }
    args
}

/// What the runner does with one message from the app-server.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Step(Step),
    /// Write this to the app-server.
    Send(Value),
    /// A reply started streaming.
    DraftOpen,
    DraftDelta(String),
    /// Codex wants the user's OK: answered off the read loop ([`answer`]).
    Ask(Box<Ask>),
    /// The turn is over: close stdin, and the app-server exits.
    Close,
}

/// A request from Codex that waits on the user (or that we refuse).
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    /// The JSON-RPC id to answer.
    id: Value,
    thread_id: String,
    turn_id: String,
    /// The call as Claude Code would name it, so cards, "Always allow" and
    /// late Allow work unchanged.
    call: Option<(String, Value)>,
    /// A card for something that isn't a tool call (title, detail).
    card: Option<(String, String)>,
    /// Codex's own reason, when it gave one.
    why: Option<String>,
    allow: Value,
    deny: Value,
    /// Refused without asking: what the agent is told instead.
    refuse: Option<String>,
}

/// One turn's conversation with the app-server.
#[derive(Debug)]
pub struct Conversation {
    start: Value,
    prompt: String,
    /// The reasoning effort for `turn/start` ([`Conversation::with_effort`]).
    effort: Option<String>,
    thread: Option<String>,
    turn: Option<String>,
    /// The agent message that's streaming.
    reply: Option<String>,
    /// Paths each file change touches, by item id (its approval names none).
    file_changes: HashMap<String, Vec<String>>,
    /// MCP calls in progress: (server, tool, arguments).
    mcp_calls: Vec<(String, String, Value)>,
    usage: UsageTotals,
    /// The model the thread runs on, as `thread/start` / `thread/resume` said.
    model: Option<String>,
    over: bool,
    /// Compact the thread (`thread/compact/start`) instead of a turn (`tidy`).
    compact: bool,
}

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

impl Conversation {
    /// A conversation for one turn, and its first message. `session` is the
    /// thread to resume. `profile`: the command line set a permissions
    /// profile (`codex::sandbox_config`), which a thread's own `sandbox`
    /// would replace, so the thread names none.
    pub fn new(
        session: Option<&str>,
        cwd: &Path,
        model: Option<&str>,
        developer_instructions: &str,
        prompt: &str,
        profile: bool,
    ) -> (Self, Value) {
        let mut params = json!({
            "cwd": cwd.to_string_lossy(),
            "approvalPolicy": "on-request",
            "developerInstructions": developer_instructions,
        });
        if !profile {
            params["sandbox"] = json!("workspace-write");
            // Also on the command line; here too so the thread's own policy
            // says it (thread/start echoes the policy it applied).
            params["config"] = json!({ super::codex::NO_NETWORK: false });
        }
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        let start = match session {
            Some(id) => {
                params["threadId"] = json!(id);
                request(START, "thread/resume", params)
            }
            None => request(START, "thread/start", params),
        };
        let first = request(
            INITIALIZE,
            "initialize",
            json!({
                "clientInfo": { "name": crate::brand::SLUG, "title": crate::brand::NAME, "version": env!("CARGO_PKG_VERSION") },
                "capabilities": null,
            }),
        );
        let conversation = Self {
            start,
            prompt: prompt.to_string(),
            effort: None,
            thread: None,
            turn: None,
            reply: None,
            file_changes: HashMap::new(),
            mcp_calls: Vec::new(),
            usage: UsageTotals::default(),
            model: None,
            over: false,
            compact: false,
        };
        (conversation, first)
    }

    /// This conversation compacts its thread rather than taking a turn: it
    /// ends when Codex reports the compaction (`tidy`). Schema of 0.166:
    /// `thread/compact/start {threadId}`, then a `contextCompaction` item
    /// (and the older `thread/compacted` notification).
    pub fn compacting(mut self) -> Self {
        self.compact = true;
        self
    }

    /// The agent's effort level (`store::EFFORTS`), on `turn/start`'s
    /// `effort`. Schema of 0.166: "Override the reasoning effort for this
    /// turn and subsequent turns", a level the model advertises; none sent
    /// leaves the thread's own. Anything but the three levels is dropped.
    pub fn with_effort(mut self, effort: Option<&str>) -> Self {
        self.effort = effort
            .filter(|e| super::store::EFFORTS.contains(e))
            .map(str::to_string);
        self
    }

    /// The turn in progress, to interrupt.
    pub fn interrupt(&self) -> Option<Value> {
        let (thread, turn) = (self.thread.as_ref()?, self.turn.as_ref()?);
        (!self.over).then(|| {
            request(
                INTERRUPT,
                "turn/interrupt",
                json!({ "threadId": thread, "turnId": turn }),
            )
        })
    }

    pub fn over(&self) -> bool {
        self.over
    }

    fn end(&mut self, steps: impl IntoIterator<Item = Step>) -> Vec<Out> {
        self.over = true;
        steps
            .into_iter()
            .map(Out::Step)
            .chain([Out::Step(Step::Done), Out::Close])
            .collect()
    }

    /// Codex compacted the thread: the end of a compaction, or its own mid-turn.
    fn compacted(&mut self) -> Vec<Out> {
        if self.over {
            return Vec::new();
        }
        if self.compact {
            return self.end([Step::Compacted]);
        }
        vec![Out::Step(Step::Compacted)]
    }

    pub fn on_message(&mut self, msg: &Value) -> Vec<Out> {
        let method = msg.get("method").and_then(Value::as_str);
        match (method, msg.get("id")) {
            (Some(method), Some(id)) => self.on_request(method, id.clone(), &msg["params"]),
            (Some(method), None) => self.on_notification(method, &msg["params"]),
            (None, Some(id)) => self.on_response(id, msg),
            _ => Vec::new(),
        }
    }

    fn on_response(&mut self, id: &Value, msg: &Value) -> Vec<Out> {
        let Some(id) = id.as_u64() else {
            // A steer that came too late for its turn: nothing to do.
            return Vec::new();
        };
        if let Some(message) = str_at(msg, "/error/message") {
            return match id {
                INITIALIZE | START | TURN => self.end([Step::Failed(message.to_string())]),
                // Refused for authentication (an API-key login): there is no
                // plan to read, so any reading kept from another login goes.
                // Any other refusal (an older Codex) says nothing either way.
                RATE_LIMITS if message.to_lowercase().contains("authentication") => {
                    vec![Out::Step(Step::Quota(super::quota::none(
                        super::engine::Engine::Codex,
                    )))]
                }
                _ => Vec::new(),
            };
        }
        match id {
            INITIALIZE => vec![
                Out::Send(json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })),
                Out::Send(self.start.clone()),
                Out::Send(request(
                    RATE_LIMITS,
                    "account/rateLimits/read",
                    json!({ "excludeResetCreditDetails": true }),
                )),
            ],
            RATE_LIMITS => {
                super::quota::from_codex(&msg["result"]["rateLimits"], super::store::now_ms())
                    .map(|q| Out::Step(Step::Quota(q)))
                    .into_iter()
                    .collect()
            }
            START => {
                let Some(thread) = str_at(msg, "/result/thread/id") else {
                    return self.end([Step::Failed("Codex started no conversation.".into())]);
                };
                self.thread = Some(thread.to_string());
                self.model = str_at(msg, "/result/model").map(str::to_string);
                if self.compact {
                    return vec![
                        Out::Step(Step::Session(thread.to_string())),
                        Out::Send(request(
                            TURN,
                            "thread/compact/start",
                            json!({ "threadId": thread }),
                        )),
                    ];
                }
                let mut turn = json!({
                    "threadId": thread,
                    "input": [{ "type": "text", "text": self.prompt }],
                });
                if let Some(effort) = &self.effort {
                    turn["effort"] = json!(effort);
                }
                vec![
                    Out::Step(Step::Session(thread.to_string())),
                    Out::Send(request(TURN, "turn/start", turn)),
                ]
            }
            TURN => {
                if let Some(turn) = str_at(msg, "/result/turn/id") {
                    self.turn = Some(turn.to_string());
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// Ours, not a sub-agent's (those run in threads of their own).
    fn ours(&self, params: &Value) -> bool {
        self.thread.is_some() && str_at(params, "/threadId") == self.thread.as_deref()
    }

    fn on_notification(&mut self, method: &str, params: &Value) -> Vec<Out> {
        // The account's, not a thread's: it names no thread.
        if method == "account/rateLimits/updated" {
            return super::quota::from_codex(&params["rateLimits"], super::store::now_ms())
                .map(|q| Out::Step(Step::Quota(q)))
                .into_iter()
                .collect();
        }
        if !self.ours(params) {
            return Vec::new();
        }
        match method {
            "item/started" => {
                let item = &params["item"];
                match item.get("type").and_then(Value::as_str) {
                    Some("agentMessage") => {
                        self.reply = item.get("id").and_then(Value::as_str).map(String::from);
                        vec![Out::DraftOpen]
                    }
                    Some(kind) => {
                        if kind == "fileChange" {
                            let paths = item["changes"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|c| c.get("path")?.as_str().map(String::from))
                                .collect();
                            if let Some(id) = item.get("id").and_then(Value::as_str) {
                                self.file_changes.insert(id.to_string(), paths);
                            }
                        }
                        if kind == "mcpToolCall" {
                            if let (Some(server), Some(tool)) =
                                (str_at(item, "/server"), str_at(item, "/tool"))
                            {
                                self.mcp_calls.push((
                                    server.to_string(),
                                    tool.to_string(),
                                    item["arguments"].clone(),
                                ));
                            }
                        }
                        activity(item)
                            .map(|a| vec![Out::Step(Step::Action(a))])
                            .unwrap_or_default()
                    }
                    None => Vec::new(),
                }
            }
            // What a running command printed, as it prints it: the live
            // step's "Show output".
            "item/commandExecution/outputDelta" => {
                match (str_at(params, "/itemId"), str_at(params, "/delta")) {
                    (Some(id), Some(delta)) if !delta.is_empty() => {
                        vec![Out::Step(Step::Output {
                            id: id.to_string(),
                            text: delta.to_string(),
                        })]
                    }
                    _ => Vec::new(),
                }
            }
            "item/agentMessage/delta" => match str_at(params, "/delta") {
                Some(delta) if str_at(params, "/itemId") == self.reply.as_deref() => {
                    vec![Out::DraftDelta(delta.to_string())]
                }
                _ => Vec::new(),
            },
            "item/completed" => {
                let item = &params["item"];
                match item.get("type").and_then(Value::as_str) {
                    Some("agentMessage") => {
                        self.reply = None;
                        let text = str_at(item, "/text").unwrap_or("").trim().to_string();
                        vec![Out::Step(Step::Reply(text))]
                    }
                    Some("contextCompaction") => self.compacted(),
                    Some("mcpToolCall") => {
                        let server = str_at(item, "/server");
                        let tool = str_at(item, "/tool");
                        if let Some(i) = self.mcp_calls.iter().position(|(s, t, _)| {
                            Some(s.as_str()) == server && Some(t.as_str()) == tool
                        }) {
                            self.mcp_calls.remove(i);
                        }
                        result_of(item)
                    }
                    _ => result_of(item),
                }
            }
            "thread/compacted" => self.compacted(),
            "thread/tokenUsage/updated" => {
                let last = &params["tokenUsage"]["last"];
                let n = |k: &str| last.get(k).and_then(Value::as_u64).unwrap_or(0);
                // Codex's input count includes what was read from cache; ours doesn't.
                let cached = n("cachedInputTokens");
                self.usage.input_tokens = self
                    .usage
                    .input_tokens
                    .saturating_add(n("inputTokens").saturating_sub(cached));
                self.usage.output_tokens =
                    self.usage.output_tokens.saturating_add(n("outputTokens"));
                self.usage.cache_read_tokens = self.usage.cache_read_tokens.saturating_add(cached);
                self.usage.cache_write_tokens = self
                    .usage
                    .cache_write_tokens
                    .saturating_add(n("cacheWriteInputTokens"));
                super::context::from_codex_app(
                    params,
                    self.model.as_deref(),
                    super::store::now_ms(),
                )
                .map(|fill| Out::Step(Step::Context(fill)))
                .into_iter()
                .collect()
            }
            "error" => {
                let message = str_at(params, "/error/message").unwrap_or("").to_string();
                let mut out = Vec::new();
                if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    out.push(Out::Step(Step::Activity("Reconnecting to Codex".into())));
                }
                if !message.is_empty() {
                    out.push(Out::Step(Step::Detail(message)));
                }
                out
            }
            "turn/completed" => {
                let turn = &params["turn"];
                if self.turn.is_some() && str_at(turn, "/id") != self.turn.as_deref() {
                    return Vec::new();
                }
                // A ChatGPT plan reports no price: tokens only, never an estimate.
                let usage = UsageTotals {
                    turns: 1,
                    ..self.usage.clone()
                };
                match str_at(turn, "/status") {
                    Some("failed") => {
                        let message = str_at(turn, "/error/message")
                            .unwrap_or("Codex stopped with an error it didn't describe.");
                        self.end([Step::Usage(usage), Step::Failed(message.to_string())])
                    }
                    _ => self.end([Step::Usage(usage)]),
                }
            }
            _ => Vec::new(),
        }
    }

    fn on_request(&mut self, method: &str, id: Value, params: &Value) -> Vec<Out> {
        let thread_id = str_at(params, "/threadId").unwrap_or("").to_string();
        let turn_id = str_at(params, "/turnId").unwrap_or("").to_string();
        let why = str_at(params, "/reason").map(String::from);
        let decision = |d: &str| json!({ "decision": d });
        let ask = |call, card, allow, deny, refuse| {
            Out::Ask(Box::new(Ask {
                id: id.clone(),
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                call,
                card,
                why: why.clone(),
                allow,
                deny,
                refuse,
            }))
        };
        match method {
            "item/commandExecution/requestApproval" => {
                let command = str_at(params, "/command").unwrap_or("");
                let call = (
                    "Bash".to_string(),
                    json!({ "command": super::codex::unwrap_shell(command) }),
                );
                vec![ask(
                    Some(call),
                    None,
                    decision("accept"),
                    decision("decline"),
                    None,
                )]
            }
            "item/fileChange/requestApproval" => {
                let paths = str_at(params, "/itemId")
                    .and_then(|item| self.file_changes.get(item))
                    .cloned()
                    .unwrap_or_default();
                let path = paths
                    .first()
                    .map(String::as_str)
                    .or_else(|| str_at(params, "/grantRoot"))
                    .unwrap_or("");
                let call = ("Edit".to_string(), json!({ "file_path": path }));
                vec![ask(
                    Some(call),
                    None,
                    decision("accept"),
                    decision("decline"),
                    None,
                )]
            }
            "mcpServer/elicitation/request" => {
                let action = |a: &str| json!({ "action": a, "content": null, "_meta": null });
                let message = str_at(params, "/message").unwrap_or("").to_string();
                let server = str_at(params, "/serverName").unwrap_or("").to_string();
                if str_at(params, "/_meta/codex_approval_kind") != Some("mcp_tool_call") {
                    let refuse = format!(
                        "[Note from the app: the {server} connector asked for something this chat can't show: \"{message}\". Tell the user in one line what it needs; they can set it up in Codex.]"
                    );
                    return vec![ask(
                        None,
                        None,
                        action("decline"),
                        action("decline"),
                        Some(refuse),
                    )];
                }
                let input = params
                    .pointer("/_meta/tool_params")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let tool = self
                    .mcp_calls
                    .iter()
                    .find(|(s, _, args)| s == &server && args == &input)
                    .or_else(|| self.mcp_calls.iter().rev().find(|(s, _, _)| s == &server))
                    .map(|(_, t, _)| t.clone())
                    .or_else(|| quoted(&message))
                    .unwrap_or_else(|| "tool".into());
                let call = (format!("mcp__{server}__{tool}"), input);
                vec![ask(
                    Some(call),
                    None,
                    action("accept"),
                    action("decline"),
                    None,
                )]
            }
            "item/permissions/requestApproval" => {
                let requested = &params["permissions"];
                let mut lines = Vec::new();
                if requested
                    .pointer("/network/enabled")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    lines.push("Use the network".to_string());
                }
                for (key, label) in [("write", "Write to"), ("read", "Read")] {
                    let paths: Vec<&str> = requested
                        .pointer(&format!("/fileSystem/{key}"))
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    if !paths.is_empty() {
                        lines.push(format!("{label} {}", paths.join(", ")));
                    }
                }
                let mut granted = json!({});
                for key in ["network", "fileSystem"] {
                    if !requested[key].is_null() {
                        granted[key] = requested[key].clone();
                    }
                }
                let card = ("Allow more access".to_string(), lines.join("\n"));
                vec![ask(
                    None,
                    Some(card),
                    json!({ "permissions": granted, "scope": "turn" }),
                    json!({ "permissions": {}, "scope": "turn" }),
                    None,
                )]
            }
            "item/tool/requestUserInput" => {
                let questions: Vec<String> = params["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| q.get("question")?.as_str().map(String::from))
                    .collect();
                let refuse = format!(
                    "[Note from the app: questions can't be shown as a form in this chat. Ask the user in your reply, in plain words, and stop there: {}]",
                    questions.join(" / ")
                );
                let none = json!({ "answers": {} });
                vec![ask(None, None, none.clone(), none, Some(refuse))]
            }
            // Anything else (sign-in refreshes, client-side tools) isn't ours to answer.
            _ => vec![Out::Send(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("This app doesn't handle {method}") },
            }))],
        }
    }
}

/// The tool name in Codex's "…run tool \"send_email\"?".
fn quoted(message: &str) -> Option<String> {
    let start = message.find('"')? + 1;
    let len = message[start..].find('"')?;
    Some(message[start..start + len].to_string())
}

/// An app-server item as the `exec` item it corresponds to, labelled the
/// same way on the activity line and in the timeline.
fn activity(item: &Value) -> Option<super::work::Action> {
    match item.get("type")?.as_str()? {
        "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "plan" => {
            super::codex::action(&as_exec(item))
        }
        _ => None,
    }
}

/// An app-server item in `exec`'s shape (`commandExecution` →
/// `command_execution`); an `exec` item as it is.
pub(super) fn as_exec(item: &Value) -> Value {
    let kind = match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => "command_execution",
        Some("fileChange") => "file_change",
        Some("mcpToolCall") => "mcp_tool_call",
        Some("webSearch") => "web_search",
        Some("plan") => "todo_list",
        _ => return item.clone(),
    };
    let mut item = item.clone();
    item["type"] = json!(kind);
    item
}

/// What became of a completed item, for its timeline step.
fn result_of(item: &Value) -> Vec<Out> {
    let tool_item = matches!(
        item.get("type").and_then(Value::as_str),
        Some("commandExecution" | "fileChange" | "mcpToolCall" | "webSearch")
    );
    if !tool_item {
        return Vec::new();
    }
    super::codex::result(item)
        .map(|r| vec![Out::Step(Step::Result(r))])
        .unwrap_or_default()
}

/// Answer one of Codex's requests: the same decision a Claude Code call gets
/// (one-time grant, "Always allow" rule, or a card), as Codex's reply, and a
/// steer telling the model why when the answer is no.
/// `turn` is our id for the turn (`broker::open_turn`): like a Claude Code
/// request, one from a turn that has ended, or asked twice, gets no card.
pub async fn answer(app: &AppHandle, agent_id: &str, turn: u64, ask: Ask) -> Vec<Value> {
    let reply = |result: &Value| json!({ "jsonrpc": "2.0", "id": ask.id, "result": result });
    let steer = |text: String| {
        json!({
            "jsonrpc": "2.0",
            "id": format!("steer-{}", super::store::new_id()),
            "method": "turn/steer",
            "params": {
                "threadId": ask.thread_id,
                "expectedTurnId": ask.turn_id,
                "input": [{ "type": "text", "text": text }],
            },
        })
    };
    // The steer goes first: it is queued on the turn while the request is
    // still open, so the model reads it with the declined call's result
    // rather than racing it (verified: sent after, it can miss the turn).
    let refused = |message: String| {
        vec![
            steer(format!("[Note from the app: {message}]")),
            reply(&ask.deny),
        ]
    };
    if let Some(note) = &ask.refuse {
        return vec![steer(note.clone()), reply(&ask.deny)];
    }
    // JSON-RPC ids restart with each app-server, so they're named per turn.
    let request_id = format!("codex-{turn}-{}", ask.id);
    let admission = super::broker::admit(agent_id, Some(turn), Some(&request_id));
    if admission != super::broker::Admission::Live {
        tracing::warn!(agent = %agent_id, turn, %request_id, ?admission, "[Agents] Codex approval request refused without asking");
        return refused(super::broker::refusal(admission).to_string());
    }
    let Ok(agent) = super::store::get(agent_id) else {
        return vec![reply(&ask.deny)];
    };
    if let Some((tool, input)) = &ask.call {
        return match mcp::decide(app, &agent, tool, input, ask.why.as_deref()).await {
            Decision::Allow => vec![reply(&ask.allow)],
            Decision::Deny(message) => refused(message),
        };
    }
    let (title, mut detail) = ask.card.clone().unwrap_or_default();
    if let Some(why) = ask.why.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        detail = format!("{detail}\n\n{why}");
    }
    match mcp::ask_user(app, &agent, title, detail.trim().to_string(), None).await {
        mcp::Answer::Allowed => vec![reply(&ask.allow)],
        mcp::Answer::Denied(note) => refused(mcp::denied(note)),
        // Unanswered: the card expired (`agents/expiry.rs`).
        mcp::Answer::NotYet => refused(super::expiry::TOLD.to_string()),
    }
}

/// Stand-in Codex binaries for tests that need [`available`] to answer.
#[cfg(test)]
pub(crate) mod fake {
    use std::path::{Path, PathBuf};

    pub enum Kind {
        /// Its schema lists every method a turn needs.
        AppServer,
        /// No `app-server` subcommand: exits 2, as an old Codex does.
        ExecOnly,
        /// The first check is killed mid-run; later ones are `AppServer`.
        BreaksOnce,
    }

    /// A new folder in `dir`, for one stand-in each.
    pub fn folder(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A `codex` shell script in `dir` that answers `app-server
    /// generate-json-schema --out <dir>` the way `kind` says.
    pub fn codex(dir: &Path, kind: Kind) -> PathBuf {
        let mut schema = String::new();
        for (file, methods) in super::NEEDED {
            let listed: Vec<String> = methods.iter().map(|m| format!("\\\"{m}\\\"")).collect();
            schema.push_str(&format!(
                "printf '%s' \"{}\" > \"$4/{file}\"\n",
                listed.join(",")
            ));
        }
        let marker = dir.join("broke-once");
        let body = match kind {
            Kind::ExecOnly => {
                "echo \"error: unrecognized subcommand 'app-server'\" >&2\nexit 2\n".to_string()
            }
            Kind::AppServer => format!("mkdir -p \"$4\"\n{schema}"),
            Kind::BreaksOnce => format!(
                "if [ ! -e '{m}' ]; then : > '{m}'; kill -9 $$; fi\nmkdir -p \"$4\"\n{schema}",
                m = marker.display()
            ),
        };
        let path = dir.join("codex");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("testdata/codex-app-server.jsonl");

    fn conversation(session: Option<&str>) -> (Conversation, Value) {
        Conversation::new(
            session,
            Path::new("/h/a"),
            Some("gpt-5.5"),
            "Be brief.",
            "run it",
            false,
        )
    }

    /// Feed a recorded app-server transcript through, as the runner does.
    fn replay(sample: &str) -> Vec<Out> {
        let (mut c, _) = conversation(None);
        sample
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .flat_map(|v| c.on_message(&v))
            .collect()
    }

    #[test]
    fn our_server_is_passed_with_its_secret_left_to_the_environment() {
        // The secret names the agent and the turn (`broker::grant`); the
        // command line only names the variable it's in.
        let args = args("http://127.0.0.1:9/mcp/agent", &[], None);
        assert!(args.iter().any(|a| a.starts_with("mcp_servers.")
            && a.contains(r#"url="http://127.0.0.1:9/mcp/agent""#)
            && a.contains(r#"bearer_token_env_var="SHIPSTUDIO_AGENTS_BRIDGE_TOKEN""#)));
        assert!(args
            .windows(2)
            .any(|w| w == ["-c", "sandbox_workspace_write.network_access=false"]));
    }

    #[test]
    fn a_compaction_resumes_the_thread_compacts_it_and_ends_when_codex_says_so() {
        let (c, _) = Conversation::new(Some("t1"), Path::new("/h/a"), None, "x", "", true);
        let mut c = c.compacting();
        c.on_message(&json!({ "id": 1, "result": {} }));
        assert_eq!(c.start["method"], "thread/resume");
        let out = c.on_message(&json!({ "id": 2, "result": { "thread": { "id": "t1" } } }));
        let Out::Send(compact) = &out[1] else {
            panic!()
        };
        assert_eq!(compact["method"], "thread/compact/start");
        assert_eq!(compact["params"], json!({ "threadId": "t1" }));
        // Another thread's compaction is not ours.
        let other = json!({ "method": "item/completed", "params": { "threadId": "sub",
            "item": { "type": "contextCompaction", "id": "i0" } } });
        assert!(c.on_message(&other).is_empty());
        let done = json!({ "method": "item/completed", "params": { "threadId": "t1",
            "item": { "type": "contextCompaction", "id": "i1" } } });
        let out = c.on_message(&done);
        assert_eq!(
            out,
            vec![
                Out::Step(Step::Compacted),
                Out::Step(Step::Done),
                Out::Close
            ]
        );
        assert!(c.over());
        // The older notification after it changes nothing.
        let late =
            json!({ "method": "thread/compacted", "params": { "threadId": "t1", "turnId": "u" } });
        assert!(c.on_message(&late).is_empty());
    }

    #[test]
    fn codexs_own_compaction_mid_turn_does_not_end_the_turn() {
        let (mut c, _) = conversation(None);
        c.on_message(&json!({ "id": 1, "result": {} }));
        c.on_message(&json!({ "id": 2, "result": { "thread": { "id": "t1" } } }));
        let out = c.on_message(&json!({ "method": "thread/compacted",
            "params": { "threadId": "t1", "turnId": "u1" } }));
        assert_eq!(out, vec![Out::Step(Step::Compacted)]);
        assert!(!c.over());
    }

    #[test]
    fn the_agents_effort_rides_on_turn_start() {
        let turn_of = |c: Conversation| {
            let mut c = c;
            c.on_message(&json!({ "id": 1, "result": {} }));
            let out = c.on_message(&json!({ "id": 2, "result": { "thread": { "id": "t1" } } }));
            let Out::Send(turn) = &out[1] else { panic!() };
            turn.clone()
        };
        let (c, _) = conversation(None);
        assert!(turn_of(c).pointer("/params/effort").is_none());
        let (c, _) = conversation(None);
        assert_eq!(turn_of(c.with_effort(Some("high")))["params"]["effort"], "high");
        let (c, _) = conversation(None);
        assert!(turn_of(c.with_effort(Some("--x")))
            .pointer("/params/effort")
            .is_none());
    }

    #[test]
    fn a_profiled_thread_names_no_sandbox_of_its_own() {
        let (mut c, _) = Conversation::new(None, Path::new("/h/a"), None, "x", "go", true);
        c.on_message(&json!({ "id": 1, "result": {} }));
        let start = c.start.clone();
        assert!(start["params"].get("sandbox").is_none());
        assert!(start["params"].get("config").is_none());
        assert_eq!(start["params"]["approvalPolicy"], "on-request");
    }

    #[test]
    fn the_handshake_starts_a_thread_then_the_turn() {
        let (mut c, first) = conversation(None);
        assert_eq!(first["method"], "initialize");
        let out = c.on_message(&json!({ "id": 1, "result": {} }));
        assert!(matches!(&out[0], Out::Send(v) if v["method"] == "initialized"));
        let Out::Send(start) = &out[1] else { panic!() };
        assert_eq!(start["method"], "thread/start");
        assert_eq!(start["params"]["approvalPolicy"], "on-request");
        assert_eq!(start["params"]["sandbox"], "workspace-write");
        assert_eq!(
            start["params"]["config"]["sandbox_workspace_write.network_access"],
            false
        );
        assert_eq!(start["params"]["model"], "gpt-5.5");
        assert_eq!(start["params"]["developerInstructions"], "Be brief.");
        let out = c.on_message(&json!({ "id": 2, "result": { "thread": { "id": "t1" } } }));
        assert_eq!(out[0], Out::Step(Step::Session("t1".into())));
        let Out::Send(turn) = &out[1] else { panic!() };
        assert_eq!(turn["params"]["input"][0]["text"], "run it");
        assert!(c.interrupt().is_none(), "no turn id yet");
        c.on_message(&json!({ "id": 3, "result": { "turn": { "id": "u1" } } }));
        let interrupt = c.interrupt().unwrap();
        assert_eq!(
            interrupt["params"],
            json!({ "threadId": "t1", "turnId": "u1" })
        );

        let (_, _) = conversation(Some("t9"));
        let (mut resumed, _) = conversation(Some("t9"));
        let out = resumed.on_message(&json!({ "id": 1, "result": {} }));
        let Out::Send(start) = &out[1] else { panic!() };
        assert_eq!(start["method"], "thread/resume");
        assert_eq!(start["params"]["threadId"], "t9");
        assert_eq!(
            start["params"]["config"]["sandbox_workspace_write.network_access"],
            false
        );
    }

    #[test]
    fn the_plans_limits_are_asked_once_and_read_whenever_they_come() {
        let (mut c, _) = conversation(None);
        let out = c.on_message(&json!({ "id": 1, "result": {} }));
        assert!(matches!(&out[2], Out::Send(v) if v["method"] == "account/rateLimits/read"));
        // Signed in with an API key (seen live on 0.166): refused, and the turn goes on.
        // That says there is no plan here: a reading kept from another login is cleared.
        let refused = c.on_message(&json!({ "id": RATE_LIMITS, "error": { "code": -32600, "message": "codex account authentication required to read rate limits" } }));
        assert!(
            matches!(&refused[..], [Out::Step(Step::Quota(q))] if q.engine == super::super::engine::Engine::Codex && q.windows.is_empty())
        );
        assert!(!c.over());
        // Any other refusal (an older Codex without the method) says nothing.
        let older = c.on_message(&json!({ "id": RATE_LIMITS, "error": { "code": -32601, "message": "method not found" } }));
        assert!(older.is_empty());
        // The read's answer and the unprompted update, neither naming a thread.
        let snap = json!({ "primary": { "usedPercent": 91, "windowDurationMins": 300, "resetsAt": 1793880000 }, "secondary": null });
        let read = c.on_message(&json!({ "id": RATE_LIMITS, "result": { "rateLimits": snap } }));
        assert!(
            matches!(&read[..], [Out::Step(Step::Quota(q))] if q.windows[0].used_percent == Some(91.0))
        );
        let update = c.on_message(
            &json!({ "method": "account/rateLimits/updated", "params": { "rateLimits": snap } }),
        );
        assert!(matches!(&update[..], [Out::Step(Step::Quota(_))]));
        // The real all-null update from a scripted run says nothing.
        let samples = replay(include_str!("testdata/codex-app-server.jsonl"));
        assert!(!samples
            .iter()
            .any(|o| matches!(o, Out::Step(Step::Quota(_)))));
    }

    #[test]
    fn a_vanished_thread_fails_in_codexs_words() {
        let (mut c, _) = conversation(Some("gone"));
        let out = c.on_message(&json!({ "id": 2, "error": { "code": -32600, "message": "no rollout found for thread id gone" } }));
        assert_eq!(
            out,
            [
                Out::Step(Step::Failed("no rollout found for thread id gone".into())),
                Out::Step(Step::Done),
                Out::Close
            ]
        );
    }

    #[test]
    fn a_real_turn_streams_asks_and_replies() {
        let out = replay(SAMPLE);
        let deltas: String = out
            .iter()
            .filter_map(|o| match o {
                Out::DraftDelta(d) => Some(d.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, "Ran it.");
        assert!(out.contains(&Out::DraftOpen));
        assert!(out.contains(&Out::Step(Step::Reply("Ran it.".into()))));
        assert!(out.iter().any(
            |o| matches!(o, Out::Step(Step::Action(a)) if a.label == "Wrote ss-probe-esc.txt")
        ));
        let asks: Vec<&Ask> = out
            .iter()
            .filter_map(|o| match o {
                Out::Ask(a) => Some(a.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(asks.len(), 1);
        let (tool, input) = asks[0].call.clone().unwrap();
        assert_eq!(tool, "Bash");
        assert_eq!(input["command"], "echo esc-ok > /tmp/ss-probe-esc.txt");
        assert_eq!(asks[0].why.as_deref(), Some("Write outside the sandbox?"));
        assert_eq!(asks[0].allow, json!({ "decision": "accept" }));
        assert_eq!(asks[0].deny, json!({ "decision": "decline" }));
        let usage = out.iter().find_map(|o| match o {
            Out::Step(Step::Usage(u)) => Some(u.clone()),
            _ => None,
        });
        let usage = usage.unwrap();
        // Two model requests of 1000 in (800 cached) and 20 out.
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens,
                usage.turns
            ),
            (400, 1600, 40, 1)
        );
        assert_eq!(&out[out.len() - 2..], [Out::Step(Step::Done), Out::Close]);
        // The prompt the user sent is never shown back as a reply.
        assert!(!out.contains(&Out::Step(Step::Reply("run it".into()))));
    }

    fn started(c: &mut Conversation) {
        c.on_message(&json!({ "id": 2, "result": { "thread": { "id": "t1" } } }));
        c.on_message(&json!({ "id": 3, "result": { "turn": { "id": "u1" } } }));
    }

    #[test]
    fn a_user_mcp_tool_asks_as_the_tool_it_is() {
        let (mut c, _) = conversation(None);
        started(&mut c);
        c.on_message(&json!({ "method": "item/started", "params": { "threadId": "t1", "item": {
            "type": "mcpToolCall", "id": "c1", "server": "gmail", "tool": "send_email", "arguments": { "to": "a@b.c" } } } }));
        let out = c.on_message(&json!({ "method": "mcpServer/elicitation/request", "id": 0, "params": {
            "threadId": "t1", "turnId": "u1", "serverName": "gmail", "mode": "form",
            "_meta": { "codex_approval_kind": "mcp_tool_call", "tool_params": { "to": "a@b.c" } },
            "message": "Allow the gmail MCP server to run tool \"send_email\"?", "requestedSchema": {} } }));
        let Out::Ask(ask) = &out[0] else { panic!() };
        assert_eq!(
            ask.call,
            Some(("mcp__gmail__send_email".into(), json!({ "to": "a@b.c" })))
        );
        assert_eq!(ask.allow["action"], "accept");
        assert_eq!(ask.deny["action"], "decline");
        // Any other elicitation is declined, and the agent told why.
        let out = c.on_message(
            &json!({ "method": "mcpServer/elicitation/request", "id": 1, "params": {
            "threadId": "t1", "turnId": "u1", "serverName": "gmail", "mode": "url", "_meta": null,
            "message": "Sign in", "url": "https://x", "elicitationId": "e" } }),
        );
        let Out::Ask(ask) = &out[0] else { panic!() };
        assert!(ask.call.is_none() && ask.refuse.as_deref().is_some_and(|r| r.contains("Sign in")));
    }

    /// Codex's requests reach `mcp::decide` as the same calls Claude Code
    /// makes, so the independence level answers them the same way.
    #[test]
    fn codex_requests_are_classified_like_claude_code_calls() {
        use super::super::autoallow::{classify, Class, Ctx};
        let own = "/Users/fictional/Library/Application Support/App/agents/a1";
        let ctx = Ctx {
            home: "/Users/fictional".into(),
            own_home: own.into(),
            cwd: own.into(),
            scratch: vec![own.into()],
            app_data: vec!["/Users/fictional/Library/Application Support/App".into()],
            ..Default::default()
        };
        let (mut c, _) = conversation(None);
        started(&mut c);
        let mut id = 10;
        let mut ask_for = |command: &str| {
            id += 1;
            let out = c.on_message(
                &json!({ "method": "item/commandExecution/requestApproval", "id": id, "params": {
                "threadId": "t1", "turnId": "u1", "itemId": "x", "command": command } }),
            );
            let Out::Ask(ask) = &out[0] else { panic!() };
            let (tool, input) = ask.call.clone().unwrap();
            classify(&tool, &input, &ctx)
        };
        for (command, claude, expected) in [
            (
                "/bin/zsh -lc 'ls -la ~/SomeFolder'",
                "ls -la ~/SomeFolder",
                Class::Read,
            ),
            (
                "/bin/zsh -lc 'mkdir -p ~/Projects/x'",
                "mkdir -p ~/Projects/x",
                Class::Change,
            ),
            (
                "/bin/zsh -lc 'git push origin main'",
                "git push origin main",
                Class::Ask,
            ),
            (
                "/bin/zsh -lc 'rm -rf ~/Documents'",
                "rm -rf ~/Documents",
                Class::Ask,
            ),
        ] {
            let claude = classify("Bash", &json!({ "command": claude }), &ctx);
            assert_eq!(claude, expected, "{command}");
            assert_eq!(ask_for(command), expected, "{command}");
        }
        // A file change names its path, judged like an Edit.
        c.on_message(&json!({ "method": "item/started", "params": { "threadId": "t1", "item": {
            "type": "fileChange", "id": "f9", "changes": [{ "path": "/Users/fictional/Documents/a.md", "kind": "add", "diff": "" }], "status": "inProgress" } } }));
        let out = c.on_message(
            &json!({ "method": "item/fileChange/requestApproval", "id": 99, "params": {
            "threadId": "t1", "turnId": "u1", "itemId": "f9", "startedAtMs": 0 } }),
        );
        let Out::Ask(ask) = &out[0] else { panic!() };
        let (tool, input) = ask.call.clone().unwrap();
        assert_eq!(classify(&tool, &input, &ctx), Class::Change);
    }

    #[test]
    fn file_changes_and_extra_access_get_cards() {
        let (mut c, _) = conversation(None);
        started(&mut c);
        c.on_message(&json!({ "method": "item/started", "params": { "threadId": "t1", "item": {
            "type": "fileChange", "id": "f1", "changes": [{ "path": "/etc/hosts", "kind": "update", "diff": "" }], "status": "inProgress" } } }));
        let out = c.on_message(
            &json!({ "method": "item/fileChange/requestApproval", "id": 5, "params": {
            "threadId": "t1", "turnId": "u1", "itemId": "f1", "startedAtMs": 0 } }),
        );
        let Out::Ask(ask) = &out[0] else { panic!() };
        assert_eq!(
            ask.call,
            Some(("Edit".into(), json!({ "file_path": "/etc/hosts" })))
        );
        let out = c.on_message(&json!({ "method": "item/permissions/requestApproval", "id": 6, "params": {
            "threadId": "t1", "turnId": "u1", "itemId": "x", "environmentId": null, "startedAtMs": 0, "cwd": "/h/a",
            "reason": "to install packages",
            "permissions": { "network": { "enabled": true }, "fileSystem": null } } }));
        let Out::Ask(ask) = &out[0] else { panic!() };
        assert!(ask.call.is_none());
        assert_eq!(ask.card.as_ref().unwrap().1, "Use the network");
        assert_eq!(
            ask.allow,
            json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
        );
    }

    #[test]
    fn requests_we_dont_handle_are_refused_not_left_hanging() {
        let (mut c, _) = conversation(None);
        let out = c.on_message(
            &json!({ "method": "account/chatgptAuthTokens/refresh", "id": 9, "params": {} }),
        );
        assert!(matches!(&out[0], Out::Send(v) if v["id"] == 9 && v["error"]["code"] == -32601));
    }

    #[test]
    fn sub_agents_stay_internal_and_failures_keep_codexs_words() {
        let (mut c, _) = conversation(None);
        started(&mut c);
        let sub = c.on_message(&json!({ "method": "item/completed", "params": { "threadId": "sub", "item": { "type": "agentMessage", "id": "m", "text": "internal" } } }));
        assert!(sub.is_empty());
        let retry = c.on_message(&json!({ "method": "error", "params": { "threadId": "t1", "turnId": "u1", "willRetry": true,
            "error": { "message": "Reconnecting... 2/5 (401)" } } }));
        assert_eq!(
            retry[0],
            Out::Step(Step::Activity("Reconnecting to Codex".into()))
        );
        let out = c.on_message(&json!({ "method": "turn/completed", "params": { "threadId": "t1", "turn": {
            "id": "u1", "status": "failed", "error": { "message": "You've hit your usage limit. Try again at 7:18 PM." } } } }));
        assert!(out.contains(&Out::Step(Step::Failed(
            "You've hit your usage limit. Try again at 7:18 PM.".into()
        ))));
        assert!(c.over() && c.interrupt().is_none());
    }

    #[test]
    fn the_tool_name_is_read_from_codexs_question() {
        assert_eq!(
            quoted("Allow the x MCP server to run tool \"send_email\"?").as_deref(),
            Some("send_email")
        );
        assert_eq!(quoted("no quotes"), None);
    }

    #[tokio::test]
    async fn the_app_server_is_used_only_when_its_schema_lists_every_method() {
        let dir = tempfile::tempdir().unwrap();
        let yes = fake::codex(&fake::folder(dir.path(), "a"), fake::Kind::AppServer);
        assert!(available(&yes).await);
        let no = fake::codex(&fake::folder(dir.path(), "b"), fake::Kind::ExecOnly);
        assert!(!available(&no).await);
        // An old Codex's answer is kept: asking again gives the same.
        assert!(!available(&no).await);
    }

    #[tokio::test]
    async fn a_check_that_broke_is_not_kept_as_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let codex = fake::codex(dir.path(), fake::Kind::BreaksOnce);
        assert!(!available(&codex).await, "nothing known yet, so no");
        assert!(available(&codex).await, "asked again rather than cached");
    }
}
