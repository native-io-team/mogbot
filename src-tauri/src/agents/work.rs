//! What a turn did: the "Worked 6 min · 23 steps · edited 2 files" line
//! under a reply, and the steps behind it.
//!
//! Every step is something the engine's own output said it did — a tool call
//! (Claude Code's `tool_use`, a Codex item), an approval card, a screenshot —
//! labelled in plain words ("Read Hero.tsx", "Ran npm test", "Messaged Acme
//! Site"). Nothing is inferred: a turn with no steps has no timeline.
//!
//! **Outcomes are observed, not assumed.** A call is a request; what became
//! of it arrives later (Claude Code's `tool_result` by `tool_use_id`, a Codex
//! item's completion by its id, the user's answer on a card). A call the user
//! declined reads "Asked to run npm test — you declined"; one that failed
//! reads "Tried to edit App.tsx". "Edited n files" counts only edits that
//! came back successful.
//!
//! While the turn runs the steps ride on its status (the newest
//! [`LIVE_STEPS`] of them), so the working line can open into them. When it
//! ends they are written to `<home>/turns/<message-id>.json`, keyed by the
//! last thing the turn said (its reply, its error, or "Stopped"), and that
//! message is sent again carrying them. The chat log itself is never touched:
//! `messages.jsonl` stays append-only and readable by builds that predate
//! this, which simply show no timeline. Only the newest [`KEEP_TURNS`]
//! timelines are kept per agent (older than [`KEEP_DAYS`] days, only the
//! newest [`KEEP_RECENT`]).
//!
//! **Safe by construction.** A label never carries a tool's raw input: a
//! command is only its program and subcommand ("Ran git push", never its
//! arguments), a web page only its host, a file only its name, someone else's
//! MCP tool only a verb and the service ("Searched Google Drive"). Then, as
//! defence in depth, every label goes through the Keychain redaction and
//! [`scrub`] (which blanks anything shaped like a credential) and only then
//! is clipped to [`LABEL_CHARS`], so a cut can never leave half a token.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::attachments::Attachment;
pub use super::describe::Slow;
use super::store::{self, AgentMessage, ApprovalStatus, MessageKind};

/// Steps kept per turn (the newest); the count still says how many there were.
pub const MAX_STEPS: usize = 60;
/// Steps carried live on the status, which is sent on every step.
pub const LIVE_STEPS: usize = 12;
/// Longest label kept, in characters.
pub const LABEL_CHARS: usize = 100;
/// File names kept per turn.
pub const MAX_FILES: usize = 30;
/// A finished command keeps what it printed last when it ran this long (or failed).
pub const KEEP_OUTPUT_AFTER_MS: i64 = 20_000;
/// Timelines kept per agent, newest first.
pub const KEEP_TURNS: usize = 500;
/// Timelines always kept, however old: the chat's first pages never lose theirs.
pub const KEEP_RECENT: usize = 100;
/// Beyond [`KEEP_RECENT`], a timeline older than this is dropped.
pub const KEEP_DAYS: u64 = 90;

/// What kind of thing a step was, for its icon. Unknown kinds (a newer
/// build's) read as `Tool`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Read,
    Edit,
    Search,
    Web,
    Command,
    Message,
    Approval,
    Screenshot,
    Plan,
    Delegate,
    Project,
    #[serde(other)]
    Tool,
}

/// What became of a step that didn't simply go through. A step without one
/// either went through or hasn't come back yet.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepOutcome {
    /// The user said no (on its card, or on the call itself).
    Declined,
    /// It came back with an error.
    Failed,
}

/// One step, as stored and shown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkStep {
    /// When it was seen, ms since the epoch.
    pub at: i64,
    pub kind: StepKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<StepOutcome>,
    /// A screenshot this step produced (an attachment of a `session` line).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<Attachment>,
    /// When what it ran came back, ms since the epoch. Absent while it runs,
    /// for a step with nothing to come back, and in older timelines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// What a test run printed it came to ("42 passed, 3 failed"), only as
    /// counts the runner printed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The last lines a long or failed command printed, cleaned
    /// ([`output::tail`]). Kept on the stored timeline only, never live.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output: Vec<String>,
}

impl WorkStep {
    /// The parts every step has filled in by its caller; the rest empty.
    pub(crate) fn blank() -> Self {
        WorkStep {
            at: 0,
            kind: StepKind::Tool,
            label: String::new(),
            outcome: None,
            image: None,
            ended_at: None,
            summary: None,
            output: Vec::new(),
        }
    }
}

/// The call running right now, as the working line and the open timeline
/// show it: in plain words, with when it started (for its live timer), and
/// what it printed so far where the engine streams that. Live only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveCall {
    pub kind: StepKind,
    /// Its working-line words ("Running the Cypress tests").
    pub label: String,
    pub started_at: i64,
    /// A tool known to take a while: "This usually takes a few minutes".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slow: Option<Slow>,
    /// Its newest lines of output so far, cleaned ([`output`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output: Vec<String>,
    /// The engine streams this call's output as it runs. When false, the
    /// output appears only once it finishes.
    pub streams: bool,
    /// Its process was seen using the CPU at the last look (`None`: not
    /// looked at, or not found).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy: Option<bool>,
    /// "Stop this step" can find its process.
    pub can_stop: bool,
}

/// A turn's timeline. Live (on the status) while it runs, `endedAt` once over.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnWork {
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Every step seen, including any no longer kept in `steps`.
    pub step_count: u32,
    /// The newest steps, oldest first.
    pub steps: Vec<WorkStep>,
    /// Files it edited successfully, distinct. Not carried live.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// How many distinct files it edited, including any not kept in `files`.
    #[serde(default)]
    pub file_count: u32,
    /// Live only: the working-line words of the newest step while that call
    /// is still running, so a client can tell the working line *is* that
    /// step (and show it once, not twice). Absent once it came back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doing: Option<String>,
    /// Live only: the call running now, in full (see [`LiveCall`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<LiveCall>,
    /// Live only: the last sign of life the turn gave (any engine output,
    /// a line its command printed, its command using the CPU).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sign_at: Option<i64>,
    /// Live only, and only once it has gone quiet for too long ([`stalled`]):
    /// when the last sign of progress was. "No progress for 5 min".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_since: Option<i64>,
}

/// A tool call, as the parsers describe it.
#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    /// The engine's id for the call: a call reported twice is one step, and
    /// its result finds it by this.
    pub id: Option<String>,
    pub kind: StepKind,
    /// What it did, for the timeline ("Read Hero.tsx").
    pub label: String,
    /// What it's doing, for the working line ("Reading Hero.tsx").
    pub doing: String,
    /// What it was going to do, for when it didn't ("edit Hero.tsx", as in
    /// "Tried to edit Hero.tsx").
    pub ask: String,
    /// Full paths it edits, counted once the edit comes back successful.
    pub files: Vec<String>,
    /// The project a project-scoped call names, so its screenshot finds it.
    pub project: Option<String>,
    /// A tool known to take a while ([`super::describe`]).
    pub slow: Option<Slow>,
    /// The command line itself, for finding its process ("Stop this step",
    /// the CPU check). Held in memory while it runs; never shown or kept.
    pub command: Option<String>,
}

/// What became of a call, as the engine reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Failed,
    Declined,
}

/// A call's result, matched to its step by id.
#[derive(Debug, Clone, PartialEq)]
pub struct CallResult {
    pub id: String,
    pub outcome: Outcome,
    /// What it printed, where the engine says (a command's output).
    pub output: Option<String>,
}

/// A `tool_result` block's text: a string, or text blocks.
fn result_text(block: &Value) -> Option<String> {
    match block.get("content")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let text: Vec<&str> = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            (!text.is_empty()).then(|| text.join("\n"))
        }
        _ => None,
    }
}

// ============================================================================
// Describing tool calls
// ============================================================================

/// The tool calls in one line of Claude Code's stream-json (an `assistant`
/// event), in order. Sub-agent calls count: they are work done for this turn.
pub fn claude_actions(value: &Value) -> Vec<Action> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|b| {
            let name = b.get("name")?.as_str()?;
            let mut action = describe_tool(name, b.get("input"))?;
            action.id = b.get("id").and_then(Value::as_str).map(String::from);
            Some(action)
        })
        .collect()
}

/// What came back for the calls in one line of Claude Code's stream-json (a
/// `user` event carrying `tool_result` blocks).
pub fn claude_results(value: &Value) -> Vec<CallResult> {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return Vec::new();
    }
    // Claude Code says how each call's permission was decided beside it.
    let rejected: HashSet<&str> = value
        .get("tool_result_meta")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| {
            matches!(
                m.pointer("/permission_decision/decision")
                    .and_then(Value::as_str),
                Some("reject" | "deny" | "denied" | "rejected")
            )
        })
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .collect();
    value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|b| {
            let id = b.get("tool_use_id")?.as_str()?;
            let outcome = if rejected.contains(id) {
                Outcome::Declined
            } else if b.get("is_error").and_then(Value::as_bool) == Some(true) {
                Outcome::Failed
            } else {
                Outcome::Done
            };
            Some(CallResult {
                id: id.to_string(),
                outcome,
                output: result_text(b),
            })
        })
        .collect()
}

fn file_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// `"a long query"` in curly quotes: scrubbed first, then cut to fit, so a
/// cut never leaves part of a token behind.
fn quoted(text: &str) -> String {
    format!("“{}”", clip(&scrub(text.trim()), 60))
}

/// Built-in tools that are the engine's own bookkeeping, not work: no step.
const HIDDEN: [&str; 12] = [
    "ToolSearch",
    "Skill",
    "BashOutput",
    "KillShell",
    "KillBash",
    "ExitPlanMode",
    "EnterPlanMode",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
    "TodoRead",
    "SlashCommand",
    "Monitor",
];

/// One Claude Code tool call (or the Claude-shaped equivalent of a Codex
/// item) in plain words. `None` for a call with no name, and for the
/// engine's own bookkeeping ([`HIDDEN`]), which isn't work done.
pub fn describe_tool(name: &str, input: Option<&Value>) -> Option<Action> {
    if name.is_empty() || HIDDEN.contains(&name) {
        return None;
    }
    let field = |k: &str| {
        input
            .and_then(|i| i.get(k))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let ours = format!("mcp__{}__", super::prompts::SERVER_KEY);
    if let Some(tool) = name.strip_prefix(&ours) {
        return ours_tool(tool, &field);
    }
    if let Some(rest) = name.strip_prefix("mcp__") {
        let (server, tool) = rest.split_once("__").unwrap_or(("", rest));
        return Some(other_mcp(server, tool, &field));
    }
    Some(match name {
        "Read" | "NotebookRead" => match field("file_path").or_else(|| field("notebook_path")) {
            Some(path) => {
                let f = file_name(&path);
                act(
                    StepKind::Read,
                    format!("Read {f}"),
                    format!("Reading {f}"),
                    format!("read {f}"),
                )
            }
            None => act(
                StepKind::Read,
                "Read a file",
                "Reading a file",
                "read a file",
            ),
        },
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let path = field("file_path").or_else(|| field("notebook_path"));
            let (past, bare) = if name == "Write" {
                ("Wrote", "write")
            } else {
                ("Edited", "edit")
            };
            let mut a = match &path {
                Some(path) => {
                    let f = file_name(path);
                    act(
                        StepKind::Edit,
                        format!("{past} {f}"),
                        format!("Editing {f}"),
                        format!("{bare} {f}"),
                    )
                }
                None => act(
                    StepKind::Edit,
                    format!("{past} a file"),
                    "Editing a file",
                    format!("{bare} a file"),
                ),
            };
            a.files.extend(path);
            a
        }
        "Bash" => {
            let command = field("command");
            let described = command
                .as_deref()
                .and_then(|c| super::describe::describe(c, 0));
            let mut a = match described {
                Some(phrase) => {
                    let mut a = act(StepKind::Command, phrase.done, phrase.doing, phrase.ask);
                    a.slow = phrase.slow;
                    a
                }
                None => act(
                    StepKind::Command,
                    "Ran a command",
                    "Running a command",
                    "run a command",
                ),
            };
            a.command = command;
            a
        }
        "Grep" => match field("pattern") {
            Some(p) => {
                let q = quoted(&p);
                act(
                    StepKind::Search,
                    format!("Searched for {q}"),
                    format!("Searching for {q}"),
                    format!("search for {q}"),
                )
            }
            None => act(
                StepKind::Search,
                "Searched the files",
                "Searching the files",
                "search the files",
            ),
        },
        "Glob" | "LS" => act(
            StepKind::Search,
            "Looked through the files",
            "Looking through the files",
            "look through the files",
        ),
        "WebSearch" => match field("query") {
            Some(q) => {
                let q = quoted(&q);
                act(
                    StepKind::Web,
                    format!("Searched the web for {q}"),
                    format!("Searching the web for {q}"),
                    format!("search the web for {q}"),
                )
            }
            None => act(
                StepKind::Web,
                "Searched the web",
                "Searching the web",
                "search the web",
            ),
        },
        "WebFetch" => browsed(field("url").as_deref()),
        "Task" | "Agent" => match field("description") {
            Some(d) => {
                let d = clip(&scrub(&d), 60);
                act(
                    StepKind::Delegate,
                    format!("Worked on a sub-task: {d}"),
                    "Working on a sub-task",
                    format!("work on a sub-task: {d}"),
                )
            }
            None => act(
                StepKind::Delegate,
                "Worked on a sub-task",
                "Working on a sub-task",
                "work on a sub-task",
            ),
        },
        "TodoWrite" => act(
            StepKind::Plan,
            "Updated its plan",
            "Planning",
            "update its plan",
        ),
        "AskUserQuestion" => act(
            StepKind::Message,
            "Asked you a question",
            "Asking you a question",
            "ask you a question",
        ),
        _ => act(StepKind::Tool, "Used a tool", "Using a tool", "use a tool"),
    })
}

fn act(
    kind: StepKind,
    label: impl Into<String>,
    doing: impl Into<String>,
    ask: impl Into<String>,
) -> Action {
    Action {
        id: None,
        kind,
        label: label.into(),
        doing: doing.into(),
        ask: ask.into(),
        files: Vec::new(),
        project: None,
        slow: None,
        command: None,
    }
}

/// A web page, by its host only: "Browsed acme.com". The path and query are
/// where tokens live, and they aren't what the user needs to know.
fn browsed(url: Option<&str>) -> Action {
    let host = url
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_string())
        })
        .filter(|h| !h.is_empty());
    match host {
        Some(h) => act(
            StepKind::Web,
            format!("Browsed {h}"),
            format!("Reading {h}"),
            format!("open {h}"),
        ),
        None => act(
            StepKind::Web,
            "Browsed a web page",
            "Reading a web page",
            "open a web page",
        ),
    }
}

/// Our own tools (the agent bridge), each in past-tense words.
fn ours_tool(tool: &str, field: &dyn Fn(&str) -> Option<String>) -> Option<Action> {
    let named = |k: &str, or: &str| field(k).unwrap_or_else(|| or.to_string());
    let project = field("project");
    let p = project
        .as_deref()
        .map(file_name)
        .unwrap_or("a project")
        .to_string();
    let mut a = match tool {
        // The permission prompt tool: its card is the step.
        "approve" => return None,
        "message_agent" => {
            let n = named("agent", "an agent");
            act(
                StepKind::Message,
                format!("Messaged {n}"),
                format!("Messaging {n}"),
                format!("message {n}"),
            )
        }
        "create_agent" => {
            let n = named("name", "an agent");
            act(
                StepKind::Delegate,
                format!("Created {n}"),
                format!("Creating {n}"),
                format!("create {n}"),
            )
        }
        "update_agent" => {
            let n = named("agent", "an agent");
            act(
                StepKind::Delegate,
                format!("Updated {n}"),
                format!("Updating {n}"),
                format!("update {n}"),
            )
        }
        "delete_agent" => {
            let n = named("agent", "an agent");
            act(
                StepKind::Delegate,
                format!("Deleted {n}"),
                format!("Deleting {n}"),
                format!("delete {n}"),
            )
        }
        "create_room" => {
            let n = named("name", "a room");
            act(
                StepKind::Delegate,
                format!("Made the room {n}"),
                format!("Making the room {n}"),
                format!("make the room {n}"),
            )
        }
        "add_to_room" | "remove_from_room" => {
            let (n, r) = (named("agent", "an agent"), named("room", "a room"));
            let (done, doing, to) = if tool == "add_to_room" {
                ("Added", "Adding", "add")
            } else {
                ("Took", "Taking", "take")
            };
            let tail = if tool == "add_to_room" {
                format!("to {r}")
            } else {
                format!("out of {r}")
            };
            act(
                StepKind::Delegate,
                format!("{done} {n} {tail}"),
                format!("{doing} {n} {tail}"),
                format!("{to} {n} {tail}"),
            )
        }
        "list_agents" => act(
            StepKind::Message,
            "Checked on the team",
            "Checking on the team",
            "check on the team",
        ),
        // Real chats showed a run of "Used a tool" after "Checked on the
        // team": the Chief reading each agent's chat in turn.
        "read_agent" => {
            let n = named("agent", "an agent");
            act(
                StepKind::Read,
                format!("Caught up on {n}'s chat"),
                format!("Catching up on {n}'s chat"),
                format!("catch up on {n}'s chat"),
            )
        }
        "team_requests" => act(
            StepKind::Message,
            "Looked at what the team is asking for",
            "Looking at what the team is asking for",
            "look at what the team is asking for",
        ),
        "answer_request" => {
            let n = named("agent", "an agent");
            act(
                StepKind::Message,
                format!("Answered a request from {n}"),
                format!("Answering a request from {n}"),
                format!("answer a request from {n}"),
            )
        }
        "bring_to_user" => act(
            StepKind::Message,
            "Brought a request to you",
            "Bringing a request to you",
            "bring a request to you",
        ),
        "pause_agent" | "resume_agent" => {
            let n = named("agent", "an agent");
            let (done, doing, to) = if tool == "pause_agent" {
                ("Paused", "Pausing", "pause")
            } else {
                ("Resumed", "Resuming", "resume")
            };
            act(
                StepKind::Delegate,
                format!("{done} {n}"),
                format!("{doing} {n}"),
                format!("{to} {n}"),
            )
        }
        "request_login" => act(
            StepKind::Message,
            "Asked you to sign in",
            "Asking you to sign in",
            "ask you to sign in",
        ),
        "remember_browser_account" => act(
            StepKind::Web,
            "Noted which account the browser uses",
            "Noting which account the browser uses",
            "note which account the browser uses",
        ),
        "ask_bring_browser_to_front" => act(
            StepKind::Web,
            "Asked to bring the browser to the front",
            "Asking to bring the browser to the front",
            "bring the browser to the front",
        ),
        "share_file" => act(
            StepKind::Message,
            "Shared a file",
            "Sharing a file",
            "share a file",
        ),
        "share_result" => act(
            StepKind::Message,
            "Put together its result",
            "Putting together its result",
            "put together its result",
        ),
        "schedule_check_in" => act(
            StepKind::Plan,
            "Scheduled a routine",
            "Scheduling a routine",
            "schedule a routine",
        ),
        "list_check_ins" => act(
            StepKind::Plan,
            "Looked at its routines",
            "Looking at its routines",
            "look at its routines",
        ),
        "watch_for" => act(
            StepKind::Plan,
            "Set up a When… routine",
            "Setting up a When… routine",
            "set up a When… routine",
        ),
        "cancel_check_in" => act(
            StepKind::Plan,
            "Cancelled a routine",
            "Cancelling a routine",
            "cancel a routine",
        ),
        "request_secret" => act(
            StepKind::Message,
            "Asked you for a password or key",
            "Asking you for a password or key",
            "ask you for a password or key",
        ),
        "project_list" => act(
            StepKind::Project,
            "Looked at your projects",
            "Looking at your projects",
            "look at your projects",
        ),
        "project_create" => {
            let n = named("name", "a project");
            act(
                StepKind::Project,
                format!("Created the project {n}"),
                format!("Creating {n}"),
                format!("create the project {n}"),
            )
        }
        "project_open" => act(
            StepKind::Project,
            format!("Opened {p}"),
            format!("Opening {p}"),
            format!("open {p}"),
        ),
        "session_message" | "session_start" => act(
            StepKind::Project,
            format!("Worked in {p}"),
            format!("Working in {p}"),
            format!("work in {p}"),
        ),
        "session_wait" | "session_progress" | "session_read" => act(
            StepKind::Project,
            format!("Followed {p}"),
            format!("Following {p}"),
            format!("follow {p}"),
        ),
        "session_key" => act(
            StepKind::Project,
            format!("Pressed a key in {p}"),
            format!("Pressing a key in {p}"),
            format!("press a key in {p}"),
        ),
        "session_close" => act(
            StepKind::Project,
            format!("Closed a session in {p}"),
            format!("Closing a session in {p}"),
            format!("close a session in {p}"),
        ),
        "preview_screenshot" => act(
            StepKind::Screenshot,
            format!("Took a screenshot of {p}"),
            format!("Looking at {p}"),
            format!("take a screenshot of {p}"),
        ),
        "git_status" => act(
            StepKind::Project,
            format!("Checked {p}'s changes"),
            format!("Checking {p}'s changes"),
            format!("check {p}'s changes"),
        ),
        "push" => act(
            StepKind::Project,
            format!("Pushed {p}"),
            format!("Pushing {p}"),
            format!("push {p}"),
        ),
        "deploy_status" => act(
            StepKind::Project,
            format!("Checked {p}'s deploy"),
            format!("Checking {p}'s deploy"),
            format!("check {p}'s deploy"),
        ),
        _ => act(StepKind::Tool, "Used a tool", "Using a tool", "use a tool"),
    };
    a.project = project;
    Some(a)
}

/// Someone else's MCP tool: a plain verb and the service, never the tool's
/// id or its arguments. "Searched Google Drive", "Browsed acme.com".
fn other_mcp(server: &str, tool: &str, field: &dyn Fn(&str) -> Option<String>) -> Action {
    let service = match super::mcp::service_name(server) {
        s if s.is_empty() => "a connected app".to_string(),
        s => s,
    };
    let words = super::mcp::split_words(tool);
    let has = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
    let lower = server.to_ascii_lowercase();
    let browser = ["chrome", "browser", "playwright", "puppeteer"]
        .iter()
        .any(|b| lower.contains(b));
    if browser {
        if has(&["navigate", "goto", "open", "visit"]) {
            return match field("url") {
                Some(url) => browsed(Some(&url)),
                None => act(
                    StepKind::Web,
                    format!("Opened a page in {service}"),
                    format!("Opening a page in {service}"),
                    format!("open a page in {service}"),
                ),
            };
        }
        if has(&["screenshot", "snapshot"]) {
            return act(
                StepKind::Screenshot,
                format!("Took a screenshot in {service}"),
                format!("Looking at a page in {service}"),
                format!("take a screenshot in {service}"),
            );
        }
        if has(&["read", "get", "find", "text", "console", "network"]) {
            return act(
                StepKind::Web,
                format!("Read a page in {service}"),
                format!("Reading a page in {service}"),
                format!("read a page in {service}"),
            );
        }
        return act(
            StepKind::Web,
            format!("Worked in {service}"),
            format!("Working in {service}"),
            format!("work in {service}"),
        );
    }
    let first = words.first().map(String::as_str).unwrap_or("");
    let (label, doing, ask) = match first {
        "search" | "query" | "find" | "lookup" => ("Searched", "Searching", "search"),
        "list" | "get" | "read" | "fetch" | "view" | "retrieve" | "download" | "describe"
        | "show" | "export" => ("Looked in", "Looking in", "look in"),
        "send" | "reply" | "post" | "comment" | "share" | "publish" => {
            ("Sent from", "Sending from", "send from")
        }
        "create" | "add" | "new" | "insert" | "upload" | "write" | "update" | "edit" | "patch"
        | "set" | "move" | "rename" | "delete" | "remove" | "archive" | "cancel" | "deploy" => {
            ("Made changes in", "Making changes in", "make changes in")
        }
        _ => ("Used", "Using", "use"),
    };
    act(
        StepKind::Tool,
        format!("{label} {service}"),
        format!("{doing} {service}"),
        format!("{ask} {service}"),
    )
}

/// Shell words that only set up the command after them.
const WRAPPERS: [&str; 8] = [
    "sudo",
    "env",
    "time",
    "nohup",
    "command",
    "exec",
    "nice",
    "caffeinate",
];
/// Words that don't do anything on their own: the next command is the one.
const SETUP: [&str; 9] = [
    "cd", "export", "set", "source", ".", "pushd", "popd", "true", "unset",
];
/// Shell words that lead into the command that runs: `do gh pr view`.
const SHELL_LEADS: [&str; 4] = ["do", "then", "else", "!"];
/// Shell words that start or end a block rather than run anything.
const SHELL_CONTROL: [&str; 11] = [
    "for", "while", "until", "if", "elif", "case", "select", "done", "fi", "esac", "[",
];
/// Programs whose first argument says what they do ("git push", "npm test").
const WITH_SUBCOMMANDS: [&str; 34] = [
    "git",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "npx",
    "bunx",
    "cargo",
    "go",
    "docker",
    "kubectl",
    "gh",
    "brew",
    "pip",
    "pip3",
    "uv",
    "poetry",
    "make",
    "aws",
    "gcloud",
    "az",
    "vercel",
    "netlify",
    "wrangler",
    "deno",
    "rails",
    "bundle",
    "dotnet",
    "flutter",
    "expo",
    "terraform",
    "supabase",
    "firebase",
    "prisma",
];

/// A command line as its program and subcommand only: `git clone https://…`
/// → "git clone", `mysql -u root -p…` → "mysql", `cd x && npm test -- a` →
/// "npm test". Arguments are where credentials live, and a person reading
/// the timeline doesn't need them. `None` when no program is plain enough
/// to show.
pub fn command_words(command: &str) -> Option<String> {
    // Every line: a loop's body is often on the lines after its header.
    let segments = command
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .flat_map(|l| l.split(['&', '|', ';']))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    for segment in segments {
        let mut words = segment
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| "'\"()`{}".contains(c)))
            .filter(|w| !w.is_empty());
        let Some(program) = words.by_ref().find(|w| {
            !WRAPPERS.contains(w)
                && !SHELL_LEADS.contains(w)
                && !w.starts_with('-')
                && !is_assignment(w)
                && !redirect_leftover(w)
        }) else {
            continue;
        };
        let program = file_name(program);
        // A loop or test header ("for f in …", "if [ … ]") or its closing
        // word is not what ran: real timelines read "Ran for".
        if SETUP.contains(&program) || SHELL_CONTROL.contains(&program) {
            continue;
        }
        let plain = program.chars().count() <= 32
            && program
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric())
            && program
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
            && !looks_like_token(program);
        if !plain {
            return None;
        }
        let mut out = program.to_string();
        if WITH_SUBCOMMANDS.contains(&program) {
            if let Some(sub) = words.next().filter(|w| plain_subcommand(w)) {
                out.push(' ');
                out.push_str(sub);
                // "npm run build": the script is what it ran.
                let runs_scripts = matches!(program, "npm" | "pnpm" | "yarn" | "bun");
                if runs_scripts && sub == "run" {
                    if let Some(script) = words.next().filter(|w| plain_subcommand(w)) {
                        out.push(' ');
                        out.push_str(script);
                    }
                }
            }
        }
        return Some(out);
    }
    None
}

/// What splitting on `&` leaves of a redirect: the `2>` and `1` of `2>&1`.
fn redirect_leftover(word: &str) -> bool {
    word.chars().all(|c| c.is_ascii_digit() || "<>".contains(c))
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// A subcommand-shaped word: short, lower-case, no paths, values or flags.
fn plain_subcommand(word: &str) -> bool {
    (1..=24).contains(&word.len())
        && word.starts_with(|c: char| c.is_ascii_lowercase())
        && word
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ":_-".contains(c))
}

/// At most `max` characters, an ellipsis if anything was cut.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

// ============================================================================
// Scrubbing
// ============================================================================

const SECRET_WORDS: [&str; 10] = [
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "pass",
    "pwd",
    "auth",
    "credential",
    "session",
];

/// Query and header names that carry a credential without saying so.
const SECRET_NAMES: [&str; 6] = [
    "sig",
    "signature",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "code",
];

pub(crate) const SECRET_PREFIXES: [&str; 12] = [
    "sk-",
    "sk_",
    "pk_live",
    "rk_live",
    "ghp_",
    "gho_",
    "ghs_",
    "ghu_",
    "github_pat_",
    "xox",
    "glpat-",
    "AKIA",
];

/// Characters a word is wrapped in, which aren't part of it.
const WRAPPING: &str = "\"'`,;()[]{}“”‘’<>";

fn secretish_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let lower = lower.trim_start_matches('-');
    !lower.is_empty()
        && (SECRET_WORDS.iter().any(|w| lower.contains(w)) || SECRET_NAMES.contains(&lower))
}

/// Long, mixed letters and digits, not a path or a file name: a token.
pub(super) fn looks_like_token(word: &str) -> bool {
    let w = word.trim_matches(|c: char| WRAPPING.contains(c));
    if SECRET_PREFIXES.iter().any(|p| w.starts_with(p)) && w.len() >= 12 {
        return true;
    }
    if w.starts_with("eyJ") && w.len() >= 24 {
        return true; // a JWT
    }
    // Base64 can hold `/` (an AWS secret does); a path starts with one.
    w.len() >= 32
        && !w.starts_with(['/', '.', '~'])
        && !w.contains("://")
        && !w.contains('.')
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_+=/".contains(c))
}

/// Flags whose value is the next word, or glued on (`-phunter2`).
fn value_flag(lower: &str) -> bool {
    matches!(lower, "-u" | "--user" | "-p" | "-a" | "--pass")
        || (lower.starts_with("--") && secretish_name(lower) && !lower.contains('='))
}

/// Blank the value of every `name=value` / `name: value` pair in a word whose
/// name sounds secret (`?api_key=…`, `&sig=…`, `"password":"…"`,
/// `X-Api-Key:…`). Returns the word and whether the value is the next word
/// (`Authorization:` then `Bearer x`).
fn scrub_pairs(word: &str) -> (String, bool) {
    let chars: Vec<char> = word.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut value_next = false;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        if c != '=' && c != ':' {
            i += 1;
            continue;
        }
        // `://` is a scheme, never a pair.
        if c == ':' && chars.get(i + 1) == Some(&'/') {
            i += 1;
            continue;
        }
        let mut start = i;
        let name_end = if start > 0 && chars[start - 1] == '"' {
            start - 1
        } else {
            start
        };
        start = name_end;
        while start > 0
            && (chars[start - 1].is_ascii_alphanumeric() || "_-.".contains(chars[start - 1]))
        {
            start -= 1;
        }
        let name: String = chars[start..name_end].iter().collect();
        i += 1;
        if !secretish_name(&name) {
            continue;
        }
        if chars.get(i) == Some(&'"') {
            out.push('"');
            i += 1;
        }
        let from = i;
        while i < chars.len() && !"&#,;}\"' ".contains(chars[i]) {
            i += 1;
        }
        let value: String = chars[from..i].iter().collect();
        if value.is_empty()
            || matches!(
                value.to_ascii_lowercase().as_str(),
                "bearer" | "basic" | "token"
            )
        {
            value_next = true;
        }
        if !value.is_empty() {
            out.push('…');
        }
    }
    (out, value_next)
}

/// A label with anything shaped like a credential blanked to `…`: values of
/// secret-sounding variables, flags, headers, query and JSON fields; bearer
/// headers; URL user info; long tokens. Errs towards blanking: a label is for
/// reading, not rerunning.
pub fn scrub(label: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut blank_next = false;
    for word in label.split(' ') {
        if word.is_empty() {
            out.push(String::new());
            continue;
        }
        let bare = word.trim_matches(|c: char| WRAPPING.contains(c));
        let lower = bare.to_ascii_lowercase();
        if blank_next {
            // `Authorization: Bearer x`: the scheme stays, the credential goes.
            if matches!(lower.as_str(), "bearer" | "basic" | "token") {
                out.push(word.to_string());
                continue;
            }
            blank_next = false;
            out.push("…".into());
            continue;
        }
        if matches!(lower.as_str(), "bearer" | "basic") || value_flag(&lower) {
            out.push(word.to_string());
            blank_next = true;
            continue;
        }
        // `-phunter2`, `-ahunter2`: a password glued to its flag.
        if (lower.starts_with("-p") || lower.starts_with("-a"))
            && !lower.starts_with("--")
            && lower.len() > 2
        {
            out.push(format!("{}…", &word[..word.find('-').unwrap_or(0) + 2]));
            continue;
        }
        // A name that says the next word is a secret: `aws_secret_access_key x`, `X-Api-Key: x`.
        let named = lower.trim_end_matches(':');
        if (named.len() < lower.len() || named.contains(['_', '-']))
            && secretish_name(named)
            && !named.contains(['=', '/', ':'])
        {
            out.push(word.to_string());
            blank_next = true;
            continue;
        }
        // https://user:pass@host, https://token@host
        if let Some((from, to)) = word.find("://").and_then(|s| {
            let rest = &word[s + 3..];
            let end = rest.find('/').unwrap_or(rest.len());
            let at = rest[..end].rfind('@')?;
            Some((s + 3, s + 3 + at))
        }) {
            let (rest, next) = scrub_pairs(&word[to..]);
            out.push(format!("{}…{rest}", &word[..from]));
            blank_next = next;
            continue;
        }
        if looks_like_token(word) {
            out.push("…".into());
            continue;
        }
        let (scrubbed, next) = scrub_pairs(word);
        blank_next = next;
        out.push(scrubbed);
    }
    out.join(" ")
}

/// Everything a label goes through before it is shown or kept: the
/// Keychain's values, then [`scrub`], and only then the length limit.
fn clean(label: &str) -> String {
    let redacted = super::secrets::redact(label);
    clip(&scrub(&redacted), LABEL_CHARS)
}

// ============================================================================
// The turn in progress
// ============================================================================

/// A call the turn made, until its result is in.
#[derive(Default)]
struct Call {
    /// Its step's index among all the turn's steps.
    step: u32,
    kind: Option<StepKind>,
    ask: String,
    /// Paths it edits, counted when it comes back successful.
    files: Vec<String>,
    project: Option<String>,
    slow: Option<Slow>,
    /// Its outcome is known.
    settled: bool,
}

/// The call running now, while it runs.
#[derive(Debug, Default)]
struct Running {
    id: String,
    kind: Option<StepKind>,
    doing: String,
    started_at: i64,
    slow: Option<Slow>,
    /// What finds its process in the process table ([`needle`]).
    needle: Option<String>,
    output: output::Buffer,
    /// Its process was found at least once: if it then goes, it has ended.
    seen_proc: bool,
    /// When its process was first found gone while the call hadn't come back.
    gone_since: Option<i64>,
    busy: Option<bool>,
}

#[derive(Default)]
struct Live {
    work: TurnWork,
    calls: HashMap<String, Call>,
    /// Approval cards the turn raised, by request id: their step and title.
    cards: HashMap<String, (u32, String)>,
    files: HashSet<String>,
    /// The newest message the turn left that a timeline can hang under.
    anchor: Option<AgentMessage>,
    /// The newest step's call, while it's still running.
    running: Option<String>,
    doing: Option<String>,
    /// Cards this turn the user answered Deny on, not yet matched to the
    /// refused call they explain. A call refused with none (the card went
    /// unanswered, or a rule said no) never says "you declined".
    declined_by_you: u32,
    /// That call in full, for the working line ([`LiveCall`]).
    current: Option<Running>,
    /// The engine streams command output as it runs (Codex's app server).
    streams: bool,
    /// The last sign of life: any engine output, including heartbeats.
    last_sign: i64,
    /// The last sign of progress: engine output other than a heartbeat, a
    /// line the command printed, the command using the CPU.
    last_progress: i64,
    /// Set once it has made no progress for too long ([`stalled`]).
    quiet_since: Option<i64>,
    /// Something shown live changed since the status was last sent.
    dirty: bool,
}

impl Live {
    fn push(&mut self, step: WorkStep) -> u32 {
        let n = self.work.step_count;
        self.work.step_count = self.work.step_count.saturating_add(1);
        self.work.steps.push(step);
        if self.work.steps.len() > MAX_STEPS {
            let over = self.work.steps.len() - MAX_STEPS;
            self.work.steps.drain(..over);
        }
        n
    }

    /// The step at absolute index `n`, if it's still kept.
    fn step_mut(&mut self, n: u32) -> Option<&mut WorkStep> {
        let first = self.work.step_count as usize - self.work.steps.len();
        let at = (n as usize).checked_sub(first)?;
        self.work.steps.get_mut(at)
    }

    fn count_files(&mut self, paths: Vec<String>) {
        for path in paths {
            if self.files.insert(path.clone()) {
                self.work.file_count = self.work.file_count.saturating_add(1);
                if self.work.files.len() < MAX_FILES {
                    self.work.files.push(clean(file_name(&path)));
                }
            }
        }
    }

    fn action(&mut self, action: Action, now: i64) {
        let label = clean(&action.label);
        let doing = clean(&action.doing);
        let Some(id) = action.id else {
            // Nothing can come back for a call without an id, so its edits
            // are never counted: only an observed success is.
            self.push(WorkStep {
                at: now,
                kind: action.kind,
                label,
                outcome: None,
                image: None,
                ..WorkStep::blank()
            });
            self.running = None;
            self.doing = None;
            self.current = None;
            return;
        };
        // The same call reported again (Codex says so as it starts and as it
        // ends): one step, with the better description.
        if let Some(call) = self.calls.get_mut(&id) {
            if call.settled {
                return;
            }
            call.ask = action.ask;
            if !action.files.is_empty() {
                call.files = action.files;
            }
            let n = call.step;
            if let Some(step) = self.step_mut(n) {
                step.label = label;
            }
            return;
        }
        let n = self.push(WorkStep {
            at: now,
            kind: action.kind,
            label,
            outcome: None,
            image: None,
            ..WorkStep::blank()
        });
        self.calls.insert(
            id.clone(),
            Call {
                step: n,
                kind: Some(action.kind),
                ask: action.ask,
                files: action.files,
                project: action.project,
                slow: action.slow,
                settled: false,
            },
        );
        self.current = Some(Running {
            id: id.clone(),
            kind: Some(action.kind),
            doing: doing.clone(),
            started_at: now,
            slow: action.slow,
            needle: action.command.as_deref().and_then(needle),
            ..Running::default()
        });
        self.running = Some(id);
        self.doing = Some(doing);
    }

    /// A call's result is in. Only the first word on a call counts: a call
    /// the user declined stays declined when its error comes back.
    fn result(&mut self, result: CallResult) {
        self.result_at(result, store::now_ms());
    }

    fn result_at(&mut self, result: CallResult, now: i64) {
        let mut running = None;
        if self.running.as_deref() == Some(result.id.as_str()) {
            self.running = None;
            self.doing = None;
            running = self.current.take();
        }
        let Some(call) = self.calls.get_mut(&result.id) else {
            return;
        };
        if call.settled {
            return;
        }
        call.settled = true;
        let (n, ask, kind, slow) = (call.step, call.ask.clone(), call.kind, call.slow);
        let files = std::mem::take(&mut call.files);
        // When it came back, what a test run came to, and what a long or
        // failed command printed last.
        let text = result
            .output
            .clone()
            .or_else(|| running.as_ref().map(|r| r.output.text().to_string()))
            .unwrap_or_default();
        if let Some(step) = self.step_mut(n) {
            step.ended_at = Some(now.max(step.at));
            if kind == Some(StepKind::Command) {
                if slow == Some(Slow::Tests) {
                    step.summary = output::test_summary(&text).map(|s| clean(&s));
                }
                let long = now - step.at >= KEEP_OUTPUT_AFTER_MS;
                if long || result.outcome == Outcome::Failed {
                    step.output = output::tail(&text, output::TAIL_LINES);
                }
            }
        }
        let (outcome, label) = match result.outcome {
            Outcome::Done => {
                self.count_files(files);
                return;
            }
            Outcome::Failed => (StepOutcome::Failed, format!("Tried to {ask}")),
            Outcome::Declined if self.declined_by_you > 0 => {
                self.declined_by_you -= 1;
                (
                    StepOutcome::Declined,
                    format!("Asked to {ask} — you declined"),
                )
            }
            // Real timelines said "you declined" beside a card nobody had
            // answered ("Asked for your OK", then set aside or timed out).
            Outcome::Declined => (
                StepOutcome::Declined,
                format!("Asked to {ask} — it wasn't allowed"),
            ),
        };
        let label = clean(&label);
        if let Some(step) = self.step_mut(n) {
            step.outcome = Some(outcome);
            step.label = label;
        }
    }

    /// The user answered a card this turn raised.
    fn answer(&mut self, request_id: &str, status: ApprovalStatus) {
        let Some((n, title)) = self.cards.get(request_id).cloned() else {
            return;
        };
        let (label, outcome) = match status {
            ApprovalStatus::Allowed => (format!("You allowed: {title}"), None),
            ApprovalStatus::Denied => {
                self.declined_by_you = self.declined_by_you.saturating_add(1);
                (
                    format!("You declined: {title}"),
                    Some(StepOutcome::Declined),
                )
            }
            ApprovalStatus::Pending | ApprovalStatus::Expired => return,
        };
        let label = clean(&label);
        if let Some(step) = self.step_mut(n) {
            step.label = label;
            step.outcome = outcome;
        }
    }

    /// A message the turn recorded.
    fn message(&mut self, message: &AgentMessage) {
        match message.kind {
            // What the turn said. Notes are never an anchor here: they're
            // other people's lines (an audit note, an engine switch, an
            // auto-allow) or a divider; "Stopped" anchors through `anchor_on`.
            MessageKind::Agent | MessageKind::Error => {
                self.anchor = Some(message.clone());
            }
            // A change card carrying the turn's result card is the result:
            // the turn ends on it, so its timeline hangs under it.
            MessageKind::Changes if message.result.is_some() => {
                self.anchor = Some(message.clone());
            }
            MessageKind::Approval => {
                if let Some(approval) = &message.approval {
                    let title = approval.title.clone();
                    let n = self.push(WorkStep {
                        at: message.ts,
                        kind: StepKind::Approval,
                        label: clean(&format!("Asked for your OK: {title}")),
                        outcome: None,
                        image: None,
                        ..WorkStep::blank()
                    });
                    self.cards.insert(approval.request_id.clone(), (n, title));
                    self.running = None;
                    self.doing = None;
                    self.current = None;
                }
            }
            MessageKind::Session => self.screenshot(message),
            _ => {}
        }
    }

    /// A screenshot line: its picture goes on the screenshot call that took
    /// it — the oldest one still running for that project — and nowhere else.
    /// One that no call explains (it came with a session's reply) is a step.
    fn screenshot(&mut self, message: &AgentMessage) {
        let Some(mark) = message
            .session
            .as_ref()
            .filter(|s| s.event == super::sessions::SessionEvent::Screenshot)
        else {
            return;
        };
        let Some(image) = message.attachments.first() else {
            return;
        };
        let project = file_name(&mark.project).to_string();
        let mut taking: Vec<u32> = self
            .calls
            .values()
            .filter(|c| {
                !c.settled
                    && c.kind == Some(StepKind::Screenshot)
                    && c.project.as_deref().map(file_name) == Some(project.as_str())
            })
            .map(|c| c.step)
            .collect();
        taking.sort_unstable();
        if !taking.is_empty() {
            // The first picture a call took is its step's; another size from
            // the same call is in the chat, not a step of its own.
            if let Some(n) = taking
                .iter()
                .copied()
                .find(|&n| self.step_mut(n).is_some_and(|s| s.image.is_none()))
            {
                if let Some(step) = self.step_mut(n) {
                    step.image = Some(image.clone());
                }
            }
            return;
        }
        self.push(WorkStep {
            at: message.ts,
            kind: StepKind::Screenshot,
            label: clean(&format!("Took a screenshot of {project}")),
            outcome: None,
            image: Some(image.clone()),
            ..WorkStep::blank()
        });
    }
}

static LIVE: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_live<T>(agent_id: &str, f: impl FnOnce(&mut Live) -> T) -> Option<T> {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(agent_id)
        .map(f)
}

/// A turn starts: a fresh timeline.
pub fn begin(agent_id: &str, now: i64) {
    let live = Live {
        work: TurnWork {
            started_at: now,
            ..TurnWork::default()
        },
        last_sign: now,
        last_progress: now,
        ..Live::default()
    };
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), live);
}

/// A tool call the turn made. Its working-line words are returned.
pub fn on_action(agent_id: &str, action: Action, now: i64) -> String {
    let doing = clean(&action.doing);
    with_live(agent_id, |live| live.action(action, now));
    doing
}

/// A step the app took for the turn itself ("Started a copy of acme-site").
pub fn on_step(agent_id: &str, kind: StepKind, label: &str, now: i64) {
    let label = clean(label);
    with_live(agent_id, |live| {
        live.push(WorkStep {
            at: now,
            kind,
            label,
            outcome: None,
            image: None,
            ..WorkStep::blank()
        });
    });
}

/// What came back for a call the turn made.
pub fn on_result(agent_id: &str, result: CallResult) {
    with_live(agent_id, |live| live.result(result));
}

/// The user said no to a call, before it ran (the permission prompt).
pub fn on_declined(agent_id: &str, call_id: &str) {
    on_result(
        agent_id,
        CallResult {
            id: call_id.to_string(),
            outcome: Outcome::Declined,
            output: None,
        },
    );
}

/// A card was answered (in any chat; only the turn that raised it has its step).
pub fn on_answer(agent_id: &str, request_id: &str, status: ApprovalStatus) {
    with_live(agent_id, |live| live.answer(request_id, status));
}

/// A message the turn recorded (called for every message; ignored between turns).
pub fn on_message(message: &AgentMessage) {
    with_live(&message.agent_id, |live| live.message(message));
}

/// The turn's own closing line that isn't a reply or an error ("Stopped"):
/// its timeline hangs under that.
pub fn anchor_on(message: &AgentMessage) {
    with_live(&message.agent_id, |live| {
        live.anchor = Some(message.clone())
    });
}

/// The timeline so far, for the status: the newest [`LIVE_STEPS`] steps and
/// counts only, since it is sent on every step.
pub fn live(agent_id: &str) -> Option<TurnWork> {
    with_live(agent_id, |live| {
        let kept = &live.work.steps;
        let from = kept.len().saturating_sub(LIVE_STEPS);
        let streams = live.streams;
        TurnWork {
            started_at: live.work.started_at,
            ended_at: None,
            step_count: live.work.step_count,
            // What a step printed rides on the finished timeline, not on
            // every status.
            steps: kept[from..]
                .iter()
                .map(|s| WorkStep {
                    output: Vec::new(),
                    ..s.clone()
                })
                .collect(),
            files: Vec::new(),
            file_count: live.work.file_count,
            doing: live.running.as_ref().and(live.doing.clone()),
            current: live.current.as_ref().map(|r| {
                let command = r.kind == Some(StepKind::Command);
                LiveCall {
                    kind: r.kind.unwrap_or(StepKind::Tool),
                    label: r.doing.clone(),
                    started_at: r.started_at,
                    slow: r.slow,
                    output: if command {
                        r.output.lines()
                    } else {
                        Vec::new()
                    },
                    streams: streams && command,
                    busy: r.busy,
                    can_stop: command && r.needle.is_some(),
                }
            }),
            last_sign_at: Some(live.last_sign),
            quiet_since: live.quiet_since,
        }
    })
    .filter(|w| w.step_count > 0 || w.current.is_some() || w.quiet_since.is_some())
}

/// The agent is gone: so is any timeline it was keeping.
pub fn forget_agent(agent_id: &str) {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

/// The turn is over: keep its timeline under the last message it left, and
/// send that message again carrying it. A turn without steps keeps nothing.
pub fn finish(app: &AppHandle, agent_id: &str, now: i64) {
    let Some(live) = LIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
    else {
        return;
    };
    let Some((message, work)) = settle(live, now) else {
        return;
    };
    if let Err(e) = save(agent_id, &message.id, &work) {
        tracing::warn!("[Agents] couldn't keep the timeline for {agent_id}: {e}");
        return;
    }
    prune(agent_id);
    let mut message = message;
    message.work = Some(work);
    let _ = app.emit(super::runner::EVENT_MESSAGE, &message);
}

fn settle(live: Live, now: i64) -> Option<(AgentMessage, TurnWork)> {
    if live.work.step_count == 0 {
        return None;
    }
    let mut work = live.work;
    work.ended_at = Some(now.max(work.started_at));
    work.doing = None;
    work.current = None;
    work.last_sign_at = None;
    work.quiet_since = None;
    Some((live.anchor?, work))
}

// ============================================================================
// On disk: <home>/turns/<message-id>.json
// ============================================================================

fn safe_id(message_id: &str) -> bool {
    !message_id.is_empty()
        && message_id.len() <= 64
        && message_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn turns_dir(agent_id: &str) -> Option<std::path::PathBuf> {
    Some(store::agent_home(agent_id).ok()?.join("turns"))
}

fn path_for(agent_id: &str, message_id: &str) -> Option<std::path::PathBuf> {
    if !safe_id(message_id) {
        return None;
    }
    Some(turns_dir(agent_id)?.join(format!("{message_id}.json")))
}

fn save(agent_id: &str, message_id: &str, work: &TurnWork) -> Result<(), String> {
    // Never brings a deleted agent's folder back (see `store::append_message`).
    if store::is_gone(agent_id) {
        return Err("the agent no longer exists".into());
    }
    let path = path_for(agent_id, message_id).ok_or("not a message id")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut value = serde_json::to_value(work).map_err(|e| e.to_string())?;
    super::secrets::redact_value(&mut value);
    let raw = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Keep the newest [`KEEP_TURNS`] timelines, and of those past the newest
/// [`KEEP_RECENT`], none older than [`KEEP_DAYS`] days. The replies stay in
/// the chat; only what they did is forgotten.
fn prune(agent_id: &str) {
    prune_at(agent_id, std::time::SystemTime::now());
}

fn prune_at(agent_id: &str, now: std::time::SystemTime) {
    let Some(dir) = turns_dir(agent_id) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut kept: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if kept.len() <= KEEP_RECENT {
        return;
    }
    kept.sort_by(|a, b| b.0.cmp(&a.0));
    let max_age = std::time::Duration::from_secs(KEEP_DAYS * 24 * 60 * 60);
    for (i, (modified, path)) in kept.iter().enumerate() {
        let old = now.duration_since(*modified).is_ok_and(|age| age > max_age);
        if i >= KEEP_TURNS || (i >= KEEP_RECENT && old) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The timeline kept under this message, if any.
pub fn load(agent_id: &str, message_id: &str) -> Option<TurnWork> {
    let raw = std::fs::read(path_for(agent_id, message_id)?).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Give each message in a chat page the timeline kept under it. For the
/// paged chat reads only (search and summaries never need it), and never
/// under the log's lock: one listing of `turns/`, then a read per hit.
pub fn apply(agent_id: &str, page: &mut [AgentMessage]) {
    let Some(dir) = turns_dir(agent_id) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let kept: HashSet<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            name.strip_suffix(".json").map(str::to_string)
        })
        .collect();
    if kept.is_empty() {
        return;
    }
    for message in page.iter_mut().filter(|m| {
        matches!(
            m.kind,
            MessageKind::Agent | MessageKind::Error | MessageKind::Note
        ) && !m.fresh
            && kept.contains(&m.id)
    }) {
        if let Some(work) = load(agent_id, &message.id) {
            message.work = Some(work);
        }
    }
}

mod liveness;
pub mod output;
pub use liveness::*;

#[cfg(test)]
mod tests;
