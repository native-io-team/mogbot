//! The tools every agent gets, served from the agent bridge's loopback server
//! at `/mcp/<token>/agents/<agent-id>`.
//!
//! The agent id in the path is who is calling — it's how `message_agent`
//! knows the sender and how management tools know whether the caller is the
//! Chief of Staff. The path is only known to the Claude Code process Ship
//! Studio spawned for that agent (it's passed inline via `--mcp-config` and
//! never written to disk), and the bridge's random token guards the prefix.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::engine::Engine;
use super::files;
use super::permissions;
use super::results;
use super::runner::{self, From};
use super::schedule;
use super::store::{self, AgentRef, Approval, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/// How long a call to `approve` holds Claude Code before answering.
///
/// Claude Code abandons a permission prompt at 300s no matter what
/// MCP_TOOL_TIMEOUT says (observed: two cards left unanswered were both given
/// up on at exactly 300s, and the agent reported the commands as timed out).
/// So we answer first, at 240s, with "paused for the user" — and the card stays
/// live. A late Allow grants exactly that call and wakes the agent.
pub const APPROVAL_WAIT_SECS: u64 = 240;

/// The wait, shortened in debug builds by `SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS`
/// so the end-to-end suite (examples/agents_e2e/main.rs) can reach the late-Allow
/// path without sitting out four minutes.
pub(super) fn approval_wait() -> Duration {
    let override_secs = cfg!(debug_assertions)
        .then(|| std::env::var("SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS").ok())
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s < APPROVAL_WAIT_SECS);
    Duration::from_secs(override_secs.unwrap_or(APPROVAL_WAIT_SECS))
}

/// One-time grants from late Allows: (agent id, tool, input). The next
/// matching `approve` call from that agent is allowed without a card.
static GRANTS: LazyLock<Mutex<Vec<(String, String, Value)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

pub fn grant_once(agent_id: &str, tool: &str, input: &Value) {
    GRANTS.lock().unwrap_or_else(|e| e.into_inner()).push((
        agent_id.to_string(),
        tool.to_string(),
        input.clone(),
    ));
}

fn take_grant(agent_id: &str, tool: &str, input: &Value) -> bool {
    let mut grants = GRANTS.lock().unwrap_or_else(|e| e.into_inner());
    match grants
        .iter()
        .position(|(a, t, i)| a == agent_id && t == tool && i == input)
    {
        Some(index) => {
            grants.remove(index);
            true
        }
        None => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Answer {
    Allowed,
    /// With what the user said, if they said why.
    Denied(Option<String>),
    /// The user hasn't answered within the wait. The card stays live.
    NotYet,
}

static PENDING_APPROVALS: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Wait for the answer to a card someone else put up (`decisions.rs`).
pub(super) fn register_waiter(request_id: &str) -> oneshot::Receiver<bool> {
    let (tx, rx) = oneshot::channel();
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.to_string(), tx);
    rx
}

pub(super) fn drop_waiter(request_id: &str) {
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id);
}

pub fn answer_approval(request_id: &str, allow: bool) -> bool {
    let sender = PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id);
    match sender {
        Some(tx) => tx.send(allow).is_ok(),
        None => false,
    }
}

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

struct Tool {
    name: &'static str,
    description: &'static str,
    main_only: bool,
    schema: fn() -> Value,
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "list_agents",
        description: "List every agent: name, role, whether it's busy right now. Use it to decide who should handle something.",
        main_only: false,
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Tool {
        name: "message_agent",
        description: "Hand another agent work, or answer one. Asynchronous: it returns once delivered; they work in their own conversation and their answer comes back to you as a new message. Brief them in a few lines: they don't see your conversation with the user.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "description": "The agent's name (or id)." },
                "message": { "type": "string" }
            },
            "required": ["agent", "message"]
        }),
    },
    Tool {
        name: "create_agent",
        description: "Create a new agent with a standing responsibility. It appears in the user's sidebar immediately. Optionally hand it a first task. With `template`, it starts from one of the ready-made agents: its role, briefing and colour, which `role` and `color` override and `instructions` adds to.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Short, human: \"Finance\", \"Acme Site\", \"Hiring\"." },
                "template": { "type": "string", "enum": super::templates::ids(), "description": "Optional: a ready-made agent to start from." },
                "role": { "type": "string", "description": "One line: what this agent is responsible for. Required unless you use a template." },
                "instructions": { "type": "string", "description": "A briefing, as if for a new hire: context, standing rules, who's who, where things live. Required unless you use a template; with one, what you know about the user, added to its briefing." },
                "color": { "type": "string", "enum": store::COLORS },
                "project": { "type": "string", "description": "Optional: bind it to one of the user's projects (name or path from project_list), so its own turns run inside that project. Usually unnecessary: any agent can work on any project through sessions." },
                "engine": { "type": "string", "enum": ["claude", "codex"], "description": "Optional: what it runs on. `claude` (Claude Code) or `codex` (Codex, on the user's ChatGPT plan). Left out, it goes on the user's default engine and model for new agents (Settings → Agents), or on whichever engine is set up when that one isn't. Only when the user asks for it; it must be installed and signed in." },
                "first_task": { "type": "string", "description": "Optional message to start it on right away." }
            },
            "required": ["name"]
        }),
    },
    Tool {
        name: "update_agent",
        description: "Change an agent's name, role, instructions, project or engine. Instructions replace the old ones; its memory is kept. `project` takes a name or path from project_list, or \"none\" to unbind it. `engine` (`claude` or `codex`) switches what it runs on from its next turn: a new session, handed the recent conversation.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string" },
                "name": { "type": "string" },
                "role": { "type": "string" },
                "instructions": { "type": "string" },
                "project": { "type": "string" },
                "engine": { "type": "string", "enum": ["claude", "codex"] }
            },
            "required": ["agent"]
        }),
    },
    Tool {
        name: "delete_agent",
        description: "Delete an agent, its memory and its conversation. The user is asked to confirm in the chat first.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": { "agent": { "type": "string" } },
            "required": ["agent"]
        }),
    },
    Tool {
        name: "share_file",
        description: "Hand the user a file you made (a report, CSV, image, PDF, zip): it appears in this chat as a file card they can open, and images show inline. Use it instead of pasting a file's contents. The file must be in your own folder or one of the user's projects; folders aren't accepted, so zip one first. Up to 25 MB.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute, ~/…, or relative to your folder." },
                "caption": { "type": "string", "description": "Optional: one short line about what it is, shown with the file." }
            },
            "required": ["path"]
        }),
    },
    Tool {
        name: "share_result",
        description: "Hand back a finished piece of work as ONE result card at the end of your reply: a title, a short summary, the files you made (documents, CSVs, screenshots), the links you produced or relied on, what you checked, and what you did NOT verify. Call it once, when the work is done, instead of listing deliverables in prose. Be honest: list only checks you actually ran in `checked`, and put anything you assumed, couldn't test or couldn't reach in `not_verified` (the user sees it prominently). Files must exist in your own folder or one of the user's projects; they're copied into the chat. When the user asks for changes to a result, revise it: call this again with `revises` (the result's id) and `changes` (one line on what changed), and the same card becomes the next version. A second call in the same turn replaces the first.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "A few words naming what you made (\"Q3 invoice summary\")." },
                "summary": { "type": "string", "description": "Two or three sentences: what it is and what it's for." },
                "items": {
                    "type": "array",
                    "description": "What the result is made of, most important first. Each has a `path` (a file: absolute, ~/…, or relative to your folder) or a `url` (http/https), an optional short `label`, and for screenshots an optional `role` of \"before\" or \"after\".",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "url": { "type": "string" },
                            "label": { "type": "string" },
                            "role": { "type": "string", "enum": ["before", "after"] }
                        }
                    }
                },
                "checked": { "type": "array", "items": { "type": "string" }, "description": "Checks you actually ran, one short line each." },
                "not_verified": { "type": "array", "items": { "type": "string" }, "description": "What you didn't or couldn't verify, one short line each. Leave nothing out to look better." },
                "revises": { "type": "string", "description": "The id of a result you're revising (given when the user asks for changes)." },
                "changes": { "type": "string", "description": "When revising: one line on what changed since the last version." }
            },
            "required": ["title", "summary"]
        }),
    },
    Tool {
        name: "schedule_check_in",
        description: "Have the app wake you later with a note to yourself: use it whenever you tell the user you'll check back, follow up or remind them, so that actually happens. Once (\"tomorrow at 9:00\", \"in 2 hours\", \"friday 14:30\") or as a routine (\"every weekday at 9:00\", \"every monday at 8am\", \"every 2 hours\"), in the user's local time. It only fires while the app is open; the answer says exactly when and what happens if it's closed. Tell the user that time.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "when": { "type": "string", "description": "When, in plain words. See the description for shapes that work." },
                "note": { "type": "string", "description": "What to do when it fires, written to your future self: specific enough to act on with no other context." },
                "agent": { "type": "string", "description": "Chief of Staff only: schedule it for another agent (name or id). Omit to schedule for yourself." }
            },
            "required": ["when", "note"]
        }),
    },
    Tool {
        name: "list_check_ins",
        description: "Your scheduled check-ins and routines, with ids and next times.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "description": "Chief of Staff only: another agent's." }
            }
        }),
    },
    Tool {
        name: "cancel_check_in",
        description: "Cancel a scheduled check-in or routine by id (from list_check_ins).",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "agent": { "type": "string", "description": "Chief of Staff only: another agent's." }
            },
            "required": ["id"]
        }),
    },
    Tool {
        name: "watch_for",
        description: "Start work when something happens, instead of at a time: a \"When…\" routine. The app checks every few minutes from this Mac (no webhooks) and wakes you with what's new, once per item; its first check only notes what's already there. Sources: github_mentions (someone @mentions the user on GitHub; uses the gh CLI, free), github_assigned (an issue or pull request is assigned to them; gh, free), new_file (a file appears in `folder`; free), linear_assigned (a Linear issue is assigned to them; through the Linear app set up in Claude Code), custom (anything else, in `check`, like \"a new email from dana@acme.com\", through the one app named in `app`: its name as set up in Claude Code, the middle part of its tools' names, e.g. `gmail` for mcp__gmail__search; claude.ai connectors can't be used). linear_assigned and custom cost a short Claude Code call per check (at least 15 minutes apart, at most 24 a day), read-only and sealed to that app; the user is asked to allow one before it's set up. It only runs while the app is open. Cancel with cancel_check_in; list_check_ins shows it.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "source": { "type": "string", "enum": ["github_mentions", "github_assigned", "new_file", "linear_assigned", "custom"] },
                "folder": { "type": "string", "description": "new_file: the folder's full path (~/ is fine)." },
                "check": { "type": "string", "description": "custom: what to look out for, in plain words." },
                "app": { "type": "string", "description": "custom: the app to check through, by its name in Claude Code." },
                "every_minutes": { "type": "integer", "description": "How often to check. Default 10 (30 for linear_assigned and custom). At least 1 for new_file, 5 for GitHub, 15 for app checks." },
                "note": { "type": "string", "description": "What to do when it happens, written to your future self: specific enough to act on with no other context." },
                "agent": { "type": "string", "description": "Chief of Staff only: set it for another agent (name or id)." }
            },
            "required": ["source", "note"]
        }),
    },
    Tool {
        name: "request_secret",
        description: "Ask the user for a password, API key, token or login through a secure card in this chat. They type it into a masked field; it goes into the macOS Keychain for you alone, and you get an environment variable and a reference, never the value. Always use this for credentials: never ask the user to paste one in chat. It returns at once: stop and tell the user in one line what it's for; you'll be woken when they save or decline it.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Short snake_case name, e.g. stripe_key. It becomes the variable: $STRIPE_KEY." },
                "purpose": { "type": "string", "description": "What you'll use it for, in one line. Shown to the user on the card." },
                "kind": { "type": "string", "enum": ["password", "api_key", "token", "other"] },
                "fields": { "type": "array", "items": { "type": "string" }, "description": "Optional: labels for a login with several parts, e.g. [\"Username\", \"Password\"]. Each becomes $NAME_USERNAME, $NAME_PASSWORD." }
            },
            "required": ["name", "purpose", "kind"]
        }),
    },
    Tool {
        name: "approve",
        description: "Internal: Claude Code asks this before a tool call that needs the user's permission.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" }
            },
            "required": ["tool_name", "input"]
        }),
    },
];

pub fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": crate::brand::scoped("agents"), "version": env!("CARGO_PKG_VERSION") },
        "instructions": format!("{}: the user's projects, which you work on through their sessions (project_* and session_* tools), other agents you can message, and (for the Chief of Staff) creating and managing agents.", crate::brand::NAME)
    })
}

/// The names of the tools this caller is served, as `tools/list` gives them.
pub(super) fn tool_names(caller: &store::Agent) -> Vec<String> {
    tools_list(caller)["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["name"].as_str().map(String::from))
        .collect()
}

fn tools_list(caller: &store::Agent) -> Value {
    let mut tools: Vec<Value> = TOOLS
        .iter()
        .filter(|t| !t.main_only || caller.is_main)
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect();
    // Every agent works on projects the same way.
    tools.extend(super::sessions::definitions());
    json!({ "tools": tools })
}

/// `turn` is the id on the caller's URL (`broker::open_turn`): the approval
/// broker needs it, and `share_result` uses it to tell a headless turn (stage
/// for the turn's end) from a take-over's terminal (record now).
pub async fn handle_rpc(
    app: &AppHandle,
    agent_id: &str,
    turn: Option<u64>,
    message: &Value,
) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params");
    let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let fail = |code: i64, msg: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } });

    let caller = match store::get(agent_id) {
        Ok(agent) => agent,
        Err(_) => return fail(-32001, "This agent no longer exists."),
    };
    match method {
        "initialize" => ok(initialize_result(params)),
        "ping" => ok(json!({})),
        "tools/list" => ok(tools_list(&caller)),
        "tools/call" => {
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Some(tool) = super::sessions::find(name) {
                return ok(super::sessions::call(app, &caller, tool, &args).await);
            }
            let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
                return fail(-32602, &format!("Unknown tool: {name}"));
            };
            if tool.main_only && !caller.is_main {
                return ok(error(
                    "Only the Chief of Staff can do that. Ask it with message_agent.",
                ));
            }
            if name == "approve" {
                return ok(approve(app, &caller, turn, &args).await);
            }
            // A turn answering a "When…" routine's items (outside text)
            // needs the user's OK to change the team or set up a routine.
            // `delete_agent` asks anyway; `watch_for` asks in `check_ins`,
            // with what the routine costs on the same card.
            if needs_card_in_routine_turn(name)
                && name != "delete_agent"
                && name != "watch_for"
                && runner::from_outside(&caller.id)
                && super::broker::is_live(&caller.id, turn)
            {
                // A call that would fail anyway fails before asking.
                if name == "create_agent" {
                    if let Err(e) = create_args(&args) {
                        return ok(error(e));
                    }
                }
                let (title, detail) = outside_card(name, &args);
                let answer = ask_user(app, &caller, title, detail, None).await;
                if let Some(refused) = refused_reply(&answer, "do it") {
                    return ok(error(refused));
                }
            }
            ok(call(app, &caller, turn, name, &args).await)
        }
        _ => fail(-32601, &format!("Method not found: {method}")),
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

async fn call(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    name: &str,
    args: &Value,
) -> Value {
    match name {
        "list_agents" => list_agents(caller),
        "message_agent" => message_agent(app, caller, args),
        "share_file" => share_file(app, caller, args).await,
        "share_result" => share_result(app, caller, turn, args).await,
        "create_agent" => create_agent(app, caller, args).await,
        "update_agent" => update_agent(app, caller, args).await,
        "delete_agent" => delete_agent(app, caller, args).await,
        "schedule_check_in" | "list_check_ins" | "cancel_check_in" | "watch_for" => {
            check_ins(app, caller, turn, name, args).await
        }
        "request_secret" => request_secret(app, caller, args),
        _ => error("Unknown tool"),
    }
}

/// The tools a turn answering outside text (a "When…" routine's items)
/// can't use without the user's OK: they change the team, or set up work
/// that runs later on its own.
pub fn needs_card_in_routine_turn(tool: &str) -> bool {
    matches!(
        tool,
        "create_agent" | "update_agent" | "delete_agent" | "watch_for" | "schedule_check_in"
    )
}

/// The card for one of those, in a turn answering outside text.
fn outside_card(tool: &str, args: &Value) -> (String, String) {
    let why = "This turn is working on a “When…” routine's items, which came from outside, so it asks first.";
    let who = arg(args, "agent")
        .or(arg(args, "name"))
        .unwrap_or("an agent");
    let title = match tool {
        "create_agent" => format!("Create {who}"),
        "update_agent" => format!("Change {who}"),
        "schedule_check_in" => format!(
            "Set up a routine: {}",
            short_line(arg(args, "when").unwrap_or("at a time"))
        ),
        _ => "Go ahead".to_string(),
    };
    let what = match tool {
        "schedule_check_in" => arg(args, "note").map(short_line),
        "update_agent" => {
            arg(args, "instructions").map(|i| format!("New instructions: {}", short_line(i)))
        }
        "create_agent" => {
            // The card is the user's only look at what it would make, so a
            // template's role stands in for one not given, and what is added
            // to its briefing is shown.
            let template = arg(args, "template").and_then(super::templates::find);
            let role = arg(args, "role").or(template.map(|t| t.role.as_str()));
            let lines: Vec<String> = [
                template.map(|t| format!("From the ready-made {}", t.title)),
                role.map(short_line),
                arg(args, "instructions").map(|i| match template {
                    Some(_) => format!("Added to its briefing: {}", short_line(i)),
                    None => format!("Instructions: {}", short_line(i)),
                }),
            ]
            .into_iter()
            .flatten()
            .collect();
            (!lines.is_empty()).then(|| lines.join("\n"))
        }
        _ => None,
    };
    let detail = match what {
        Some(w) => format!("{w}\n\n{why}"),
        None => why.to_string(),
    };
    (title, detail)
}

fn short_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= 200 {
        line
    } else {
        line.chars().take(199).collect::<String>() + "…"
    }
}

/// The card for a "When…" routine an agent wants: what it waits for, how
/// often, and for a model check what that costs, from what checks on this
/// Mac have measured (never estimated from nothing).
pub fn watch_card(
    agent: &str,
    source: &super::watch::Source,
    every: u32,
    note: &str,
    measured: Option<&super::usage::UsageTotals>,
    on_plan: bool,
) -> (String, String) {
    use super::watch::{describe, Source, DEFAULT_MAX_CHECKS_PER_DAY};
    let app = match source {
        Source::LinearAssigned => "Linear".to_string(),
        Source::Custom { app, .. } => app.clone(),
        _ => String::new(),
    };
    let when = format!("When {}, {}", describe(source), short_line(note));
    if !source.uses_model() {
        return (
            format!("Let {agent} set up a “When…” routine?"),
            format!("{when}.\n\nChecked every {every} min from this Mac; checks are free."),
        );
    }
    let per_day = (24 * 60 / every.max(1)).min(DEFAULT_MAX_CHECKS_PER_DAY);
    let cost = match measured.filter(|m| m.checks > 0) {
        Some(m) => {
            let n = f64::from(m.checks);
            let tokens =
                (m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens)
                    as f64
                    / n;
            if m.priced_checks == m.checks && !on_plan {
                let each = m.cost_usd / n;
                format!(
                    "Checks on this Mac this week averaged {} at API prices each, so up to about {} a day.",
                    usd(each),
                    usd(each * f64::from(per_day))
                )
            } else {
                format!(
                    "Checks on this Mac this week averaged {} tokens each, so up to about {} tokens a day.",
                    compact(tokens),
                    compact(tokens * f64::from(per_day))
                )
            }
        }
        None => {
            "No check has been measured on this Mac yet, so what one costs isn't known.".to_string()
        }
    };
    (
        format!("Let {agent} check {app} every {every} min?"),
        format!(
            "{when}.\n\nEach check is one short Claude Code call on Haiku that can only read {app}: up to {per_day} a day. {cost}"
        ),
    )
}

fn usd(v: f64) -> String {
    if v < 0.01 {
        "<$0.01".to_string()
    } else {
        format!("${v:.2}")
    }
}

fn compact(n: f64) -> String {
    if n < 1000.0 {
        format!("{}", n.round() as u64)
    } else if n < 1_000_000.0 {
        format!("{}k", (n / 1000.0).round() as u64)
    } else {
        format!("{:.1}M", n / 1_000_000.0)
    }
}

/// What model checks have measured this week, over every agent's routines.
fn measured_checks() -> Option<super::usage::UsageTotals> {
    let today = super::usage::today();
    let mut total = super::usage::UsageTotals::default();
    for agent in store::list().ok()? {
        for c in agent.check_ins.iter().filter(|c| c.watch.is_some()) {
            let week = c.usage.summary(today).week;
            total.checks += week.checks;
            total.priced_checks += week.priced_checks;
            total.cost_usd += week.cost_usd;
            total.input_tokens += week.input_tokens;
            total.output_tokens += week.output_tokens;
            total.cache_read_tokens += week.cache_read_tokens;
            total.cache_write_tokens += week.cache_write_tokens;
        }
    }
    (total.checks > 0).then_some(total)
}

/// Claude has reported a plan (Pro or Max): its prices aren't the bill.
fn on_claude_plan() -> bool {
    super::quota::shown(&super::quota::load(), store::now_ms())
        .iter()
        .any(|q| q.engine == super::engine::Engine::Claude)
}

/// The schedule tools. An agent manages its own; the Chief of Staff may also
/// manage another agent's by naming it.
async fn check_ins(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    name: &str,
    args: &Value,
) -> Value {
    let target = match arg(args, "agent") {
        None => caller.clone(),
        Some(t) => match store::find(t) {
            Ok(Some(a)) if a.id == caller.id || caller.is_main => a,
            Ok(Some(_)) => {
                return error("You can only schedule your own check-ins. Ask the Chief of Staff.")
            }
            _ => return error(format!("There's no agent called {t}.")),
        },
    };
    let whose = |summary: String| {
        if target.id == caller.id {
            summary
        } else {
            format!("For {}: {summary}", target.name)
        }
    };
    let result = match name {
        "schedule_check_in" => schedule::create(
            &target.id,
            arg(args, "when").unwrap_or(""),
            arg(args, "note").unwrap_or(""),
        )
        .map(|c| {
            created_routine_line(app, &target.id, &c.check_in);
            whose(c.summary)
        }),
        "watch_for" => {
            let source = match watch_source(args) {
                Ok(s) => s,
                Err(e) => return error(e.to_string()),
            };
            let every = args.get("every_minutes").and_then(Value::as_u64).map_or(
                if source.uses_model() {
                    super::watch::DEFAULT_MODEL_EVERY_MINUTES
                } else {
                    super::watch::DEFAULT_EVERY_MINUTES
                },
                |m| m.min(u64::from(u32::MAX)) as u32,
            );
            let note = arg(args, "note").unwrap_or("");
            // Refuse what won't validate before asking anyone about it.
            if let Err(e) = super::watch::validate(source.clone(), every) {
                return error(e.into_error().to_string());
            }
            // A model check spends the user's usage every time it runs, and
            // outside text mustn't set up work on its own: the user says yes.
            let outside =
                runner::from_outside(&caller.id) && super::broker::is_live(&caller.id, turn);
            if source.uses_model() || outside {
                let (title, mut detail) = watch_card(
                    &target.name,
                    &source,
                    every,
                    note,
                    measured_checks().as_ref(),
                    on_claude_plan(),
                );
                if outside {
                    detail.push_str("\n\nThis turn is working on a “When…” routine's items, which came from outside, so it asks first.");
                }
                let answer = ask_user(app, caller, title, detail, None).await;
                if let Some(refused) = refused_reply(&answer, "set it up") {
                    return error(refused);
                }
            }
            super::watch::create(&target.id, source, every, note).map(|c| {
                created_routine_line(app, &target.id, &c.check_in);
                whose(c.summary)
            })
        }
        "cancel_check_in" => schedule::cancel(&target.id, arg(args, "id").unwrap_or(""))
            .map(|c| whose(format!("Cancelled: {}", c.note))),
        _ => return text(whose(schedule::list_text(&target))),
    };
    match result {
        Ok(summary) => {
            let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
            text(summary)
        }
        Err(e) => error(e.to_string()),
    }
}

/// A line in the chat whenever an agent sets up a routine, so none is ever
/// created out of sight.
pub fn created_routine_line(app: &AppHandle, agent_id: &str, c: &schedule::CheckIn) {
    let text = routine_line_text(c);
    let _ = runner::record(app, runner::new_message(agent_id, MessageKind::Note, text));
}

pub fn routine_line_text(c: &schedule::CheckIn) -> String {
    match &c.watch {
        Some(w) => format!(
            "Set up a “When…” routine: when {}, {} · {}",
            super::watch::describe(&w.source),
            short_line(&c.note),
            super::watch::cost_words(w)
        ),
        None => format!("Set up a routine: {}", short_line(&c.note)),
    }
}

/// `watch_for`'s source, from its flat arguments.
fn watch_source(args: &Value) -> Result<super::watch::Source, crate::errors::CommandError> {
    use super::watch::Source;
    match arg(args, "source").unwrap_or("") {
        "github_mentions" => Ok(Source::GithubMentions),
        "github_assigned" => Ok(Source::GithubAssigned),
        "linear_assigned" => Ok(Source::LinearAssigned),
        "new_file" => Ok(Source::NewFile {
            folder: arg(args, "folder").unwrap_or("").to_string(),
        }),
        "custom" => Ok(Source::Custom {
            check: arg(args, "check").unwrap_or("").to_string(),
            app: arg(args, "app").unwrap_or("").to_string(),
        }),
        other => Err(super::err_invalid(
            "source",
            format!("There's no source called {other:?}. Use github_mentions, github_assigned, new_file, linear_assigned or custom."),
        )),
    }
}

fn list_agents(caller: &store::Agent) -> Value {
    let Ok(agents) = store::list() else {
        return error("Couldn't read the agents list.");
    };
    let lines: Vec<String> = agents
        .iter()
        .map(|a| {
            let me = if a.id == caller.id { " (you)" } else { "" };
            let chief = if a.is_main { " [Chief of Staff]" } else { "" };
            let status = runner::status_of(&a.id);
            let project = a
                .project
                .as_deref()
                .map(|p| format!(" (works in {p})"))
                .unwrap_or_default();
            let busy = match status.state {
                _ if runner::driven(&a.id) => {
                    " — the user is working in its session directly; messages wait until they hand it back"
                }
                "working" => " — busy",
                "waiting" => " — waiting on the user",
                _ => "",
            };
            format!(
                "- {}{me}{chief}{project}{busy}: {}",
                a.name,
                if a.role.is_empty() {
                    "(no role set)"
                } else {
                    &a.role
                }
            )
        })
        .collect();
    text(lines.join("\n"))
}

fn peer(agent: &store::Agent) -> AgentRef {
    AgentRef {
        id: agent.id.clone(),
        name: agent.name.clone(),
    }
}

fn message_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let (Some(target_name), Some(body)) = (arg(args, "agent"), arg(args, "message")) else {
        return error("Both `agent` and `message` are required.");
    };
    let target = match store::find(target_name) {
        Ok(Some(t)) => t,
        _ => {
            return error(format!(
                "There's no agent called {target_name}. list_agents shows who exists."
            ))
        }
    };
    if target.id == caller.id {
        return error("That's you.");
    }
    let Some(hop) = runner::next_hop(&caller.id) else {
        return error("Not sent: this chain of agent-to-agent messages is too long. Tell the user where things stand instead.");
    };
    // Answering a request the target sent: settles it (see runner::settle).
    let answer = runner::settle(&caller.id, &target.id);
    let mut sent = runner::new_message(&caller.id, MessageKind::SentToAgent, body);
    sent.peer = Some(peer(&target));
    let _ = runner::record(app, sent);
    let mut received = runner::new_message(&target.id, MessageKind::FromAgent, body);
    received.peer = Some(peer(caller));
    let _ = runner::record(app, received);
    if answer {
        runner::enqueue_reply(app, &target.id, body.to_string(), peer(caller), hop);
        return text(format!("Delivered to {}.", target.name));
    }
    runner::enqueue(
        app,
        &target.id,
        body.to_string(),
        From::Agent {
            sender: peer(caller),
            hop,
        },
    );
    text(format!(
        "Delivered to {}. Their answer comes back to you as a new message when they're done; don't wait for it.",
        target.name
    ))
}

/// Copy a file the agent made into its chat as a message from it. Only files
/// in its own home or one of the user's projects (see `files::shareable`).
/// Where an agent may hand files from: its own home, and the user's projects.
async fn share_roots(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut roots = vec![home.to_path_buf()];
    if let Ok(projects) = crate::commands::projects::list_projects().await {
        roots.extend(
            projects
                .into_iter()
                .map(|p| std::path::PathBuf::from(p.path)),
        );
    }
    roots
}

async fn share_file(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Ok(home) = store::agent_home(&caller.id) else {
        return error("Couldn't find your folder.");
    };
    let roots = share_roots(&home).await;
    let source = match files::shareable(arg(args, "path").unwrap_or(""), &home, &roots) {
        Ok(source) => source,
        Err(e) => return error(e),
    };
    let mut message = runner::new_message(
        &caller.id,
        MessageKind::Agent,
        arg(args, "caption").unwrap_or(""),
    );
    let id = message.id.clone();
    let saved = tokio::task::spawn_blocking(move || files::share(&home, &id, &source)).await;
    match saved {
        Ok(Ok(attachment)) => {
            let name = attachment.name.clone();
            message.attachments = vec![attachment];
            if let Err(e) = runner::record(app, message) {
                return error(e.to_string());
            }
            text(format!(
                "Shared {name}. The user sees it in the chat as a file they can open; don't paste its contents as well."
            ))
        }
        Ok(Err(e)) => error(e.to_string()),
        Err(e) => error(e.to_string()),
    }
}

/// The result card (`agents/results.rs`). Everything is checked and every
/// file copied before anything is kept. Inside a live headless turn the card
/// is staged and recorded when the turn ends, so the reply ends on it. With
/// no such turn (a take-over's terminal: its URL has no `?turn=`, and nothing
/// will ever `take` a staged card) it goes into the chat now, and the agent
/// is told so: staging there would lose it.
async fn share_result(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    args: &Value,
) -> Value {
    let draft = match results::parse(args) {
        Ok(draft) => draft,
        Err(e) => return error(e),
    };
    let Ok(home) = store::agent_home(&caller.id) else {
        return error("Couldn't find your folder.");
    };
    let roots = share_roots(&home).await;
    let agent_id = caller.id.clone();
    let built =
        tokio::task::spawn_blocking(move || results::prepare(&agent_id, &home, &roots, draft))
            .await;
    let message = match built {
        Ok(Ok(message)) => message,
        Ok(Err(e)) => return error(e),
        Err(e) => return error(e.to_string()),
    };
    let Some(card) = message.result.clone() else {
        return error("Nothing was shared.");
    };
    match results::delivery(super::broker::is_live(&caller.id, turn)) {
        results::Delivery::AtTurnEnd => {
            let replaced = results::stage(message);
            text(results::staged_reply(&card, replaced))
        }
        results::Delivery::Now => {
            let copies = message.clone();
            match super::runner::record(app, message) {
                Ok(_) => text(results::recorded_reply(&card)),
                Err(e) => {
                    results::remove_files(&copies);
                    error(format!(
                        "Couldn't save the result to the chat ({e}). Nothing was shared."
                    ))
                }
            }
        }
    }
}

/// A quiet line in a chat about something the Chief did, naming `peer` so the
/// UI can turn its name into a link. Nothing it does to the team is invisible.
fn audit_note(agent_id: &str, text: String, peer: Option<AgentRef>) -> store::AgentMessage {
    let mut note = runner::new_message(agent_id, MessageKind::Note, text);
    note.peer = peer;
    note
}

/// The lines a create leaves: in the Chief's chat, and the new agent's first.
fn create_notes(caller: &store::Agent, agent: &store::Agent) -> Vec<store::AgentMessage> {
    vec![
        audit_note(
            &caller.id,
            created_line(&agent.name, &agent.role, agent.project.as_deref()),
            Some(peer(agent)),
        ),
        audit_note(
            &agent.id,
            format!("Created by {}", caller.name),
            Some(peer(caller)),
        ),
    ]
}

/// The lines an update leaves, in the Chief's chat and the target's. None
/// when nothing actually changed.
fn update_notes(
    caller: &store::Agent,
    before: &store::Agent,
    after: &store::Agent,
    fields: &[&str],
) -> Vec<store::AgentMessage> {
    if before.name == after.name && fields.is_empty() {
        return Vec::new();
    }
    let (chief, target) = updated_lines(&before.name, &after.name, fields, &caller.name);
    let mut notes = vec![audit_note(&caller.id, chief, Some(peer(after)))];
    if after.id != caller.id {
        notes.push(audit_note(&after.id, target, Some(peer(caller))));
    }
    notes
}

/// "Created Finance · Invoices and the books · works in acme".
pub(crate) fn created_line(name: &str, role: &str, project: Option<&str>) -> String {
    let mut line = format!("Created {name}");
    if !role.is_empty() {
        line.push_str(&format!(" · {role}"));
    }
    if let Some(p) = project {
        line.push_str(&format!(" · works in {}", super::project::folder_name(p)));
    }
    line
}

/// What an update changed, for the Chief's chat ("Updated Acme Site's role and
/// instructions") and the target's ("Role and instructions updated by Chief
/// of Staff"). A rename leads, since the old name is the one to recognise.
pub(crate) fn updated_lines(
    old_name: &str,
    new_name: &str,
    fields: &[&str],
    by: &str,
) -> (String, String) {
    let list = match fields {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    let renamed = old_name != new_name;
    let chief = match (renamed, list.is_empty()) {
        (true, true) => format!("Renamed {old_name} to {new_name}"),
        (true, false) => format!("Renamed {old_name} to {new_name} and updated its {list}"),
        (false, _) => format!("Updated {new_name}'s {list}"),
    };
    let mut target = match (renamed, list.is_empty()) {
        (true, true) => format!("Renamed from {old_name} by {by}"),
        (true, false) => format!("Renamed from {old_name}, and {list} updated, by {by}"),
        (false, _) => format!("{list} updated by {by}"),
    };
    if let Some(first) = target.get(..1) {
        target = first.to_uppercase() + &target[1..];
    }
    (chief, target)
}

/// What `create_agent` makes, before anything is created: a template brings
/// its role, briefing and colour; without one, `role` and `instructions` are
/// required (an agent with no briefing is a blank that looks finished).
struct CreateArgs {
    template: Option<&'static super::templates::Template>,
    role: String,
    instructions: String,
    color: Option<String>,
}

fn create_args(args: &Value) -> Result<CreateArgs, String> {
    let template = match arg(args, "template") {
        Some(id) => Some(super::templates::find(id).ok_or_else(|| {
            format!(
                "There's no ready-made agent called {id}. The ones there are: {}.",
                super::templates::ids().join(", ")
            )
        })?),
        None => None,
    };
    Ok(match template {
        Some(t) => CreateArgs {
            template,
            role: arg(args, "role").unwrap_or(&t.role).to_string(),
            instructions: t.instructions_with(arg(args, "instructions")),
            color: Some(arg(args, "color").unwrap_or(&t.color).to_string()),
        },
        None => {
            let missing: Vec<&str> = ["role", "instructions"]
                .into_iter()
                .filter(|k| arg(args, k).is_none())
                .collect();
            if !missing.is_empty() {
                return Err(format!(
                    "Without a `template`, `{}` {} required. Or start from one of the ready-made agents: {}.",
                    missing.join("` and `"),
                    if missing.len() == 1 { "is" } else { "are" },
                    super::templates::ids().join(", ")
                ));
            }
            CreateArgs {
                template,
                role: arg(args, "role").unwrap_or("").to_string(),
                instructions: arg(args, "instructions").unwrap_or("").to_string(),
                color: arg(args, "color").map(str::to_string),
            }
        }
    })
}

async fn create_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Some(name) = arg(args, "name") else {
        return error("`name` is required.");
    };
    let CreateArgs {
        template,
        role,
        instructions,
        color,
    } = match create_args(args) {
        Ok(c) => c,
        Err(e) => return error(e),
    };
    let project = match arg(args, "project") {
        Some(q) => match super::project::resolve(q).await {
            Ok(p) => p,
            Err(e) => return error(e.to_string()),
        },
        None => None,
    };
    // Unpicked: the user's default (Settings → Agents) when it can run here,
    // else one that can (Codex, when that's all there is), on the model the
    // user chose for that engine.
    let defaults = super::defaults::view().await;
    let engine = match arg(args, "engine").map(Engine::parse) {
        Some(Ok(engine)) => match super::engine::require_ready(engine).await {
            Ok(()) => engine,
            Err(e) => return error(e.to_string()),
        },
        Some(Err(e)) => return error(e.to_string()),
        None => defaults.starts_on,
    };
    let model = defaults.model_for(engine);
    let created = store::create(store::NewAgent {
        name: name.to_string(),
        role,
        instructions,
        shape: None,
        color,
        is_main: false,
    });
    let plain = project.is_none() && engine == Engine::default() && model.is_none();
    let created = created.and_then(|agent| match (plain, template) {
        (true, None) => Ok(agent),
        _ => store::update(&agent.id, |a| {
            a.project = project.as_ref().map(|p| p.path.clone());
            a.engine = engine;
            a.model = model;
            a.template = template.map(|t| t.id.clone());
        }),
    });
    match created {
        Ok(agent) => {
            let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
            for note in create_notes(caller, &agent) {
                let _ = runner::record(app, note);
            }
            let mut started = String::new();
            let first_task = arg(args, "first_task");
            // The first task is a request like `message_agent`'s: it travels one
            // hop past the caller's turn, so creating an agent can't start a
            // fresh chain (nor one past the cap).
            let hop = runner::next_hop(&caller.id);
            if first_task.is_some() && hop.is_none() {
                started = ", but didn't start it on its first task: this chain of agent-to-agent messages is too long. Tell the user where things stand instead".to_string();
            }
            if let (Some(task), Some(hop)) = (first_task, hop) {
                let mut sent = runner::new_message(&caller.id, MessageKind::SentToAgent, task);
                sent.peer = Some(peer(&agent));
                let _ = runner::record(app, sent);
                let mut received = runner::new_message(&agent.id, MessageKind::FromAgent, task);
                received.peer = Some(peer(caller));
                let _ = runner::record(app, received);
                runner::enqueue(
                    app,
                    &agent.id,
                    task.to_string(),
                    From::Agent {
                        sender: peer(caller),
                        hop,
                    },
                );
                started =
                    " and started it on its first task; its answer comes back to you".to_string();
            }
            text(format!(
                "Created {}{started}. It's in the user's sidebar now.",
                agent.name
            ))
        }
        Err(e) => error(e.to_string()),
    }
}

async fn update_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Some(target) = arg(args, "agent") else {
        return error("`agent` is required.");
    };
    let agent = match store::find(target) {
        Ok(Some(a)) => a,
        _ => return error(format!("There's no agent called {target}.")),
    };
    let new_name = match arg(args, "name").map(store::validate_name) {
        Some(Ok(n)) => Some(n),
        Some(Err(e)) => return error(e.to_string()),
        None => None,
    };
    if let Some(n) = &new_name {
        if matches!(store::find(n), Ok(Some(other)) if other.id != agent.id) {
            return error(format!("There's already an agent called {n}."));
        }
    }
    let project = match arg(args, "project") {
        Some(q) => match super::project::resolve(q).await {
            Ok(p) => Some(p.map(|p| p.path)),
            Err(e) => return error(e.to_string()),
        },
        None => None,
    };
    let engine = match arg(args, "engine").map(Engine::parse) {
        Some(Ok(engine)) if engine != agent.engine => {
            match super::engine::require_ready(engine).await {
                Ok(()) => Some(engine),
                Err(e) => return error(e.to_string()),
            }
        }
        Some(Err(e)) => return error(e.to_string()),
        _ => None,
    };
    let role = arg(args, "role").map(str::to_string);
    let mut fields = Vec::new();
    if role.as_deref().is_some_and(|r| r != agent.role) {
        fields.push("role");
    }
    if arg(args, "instructions").is_some() {
        fields.push("instructions");
    }
    if project.as_ref().is_some_and(|p| *p != agent.project) {
        fields.push("project");
    }
    if let Some(p) = &project {
        if let Err(e) = super::task::refuse_rebind(&agent, p.as_deref()) {
            return error(e.to_string());
        }
    }
    if engine.is_some() {
        fields.push("engine");
    }
    // The same guard as the editor's: not out of a session the user drives.
    let moves_session = engine.is_some() || fields.contains(&"project");
    let updated = runner::update_settings(&agent.id, moves_session, |a| {
        if let Some(n) = new_name {
            a.name = n;
        }
        if let Some(r) = role {
            a.role = r;
        }
        if let Some(p) = project {
            a.project = p;
        }
        if let Some(engine) = engine {
            a.switch_engine(engine);
        }
    });
    let updated = match updated {
        Ok(a) => a,
        Err(e) => return error(e.to_string()),
    };
    let instructions = match arg(args, "instructions") {
        Some(i) => i.to_string(),
        None => store::read_instructions(&agent.id).unwrap_or_default(),
    };
    if let Ok(home) = store::agent_home(&agent.id) {
        if let Err(e) = store::write_instructions(&home, &updated, &instructions) {
            return error(e.to_string());
        }
    }
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    for note in update_notes(caller, &agent, &updated, &fields) {
        let _ = runner::record(app, note);
    }
    text(format!("Updated {}.", updated.name))
}

async fn delete_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Some(target) = arg(args, "agent") else {
        return error("`agent` is required.");
    };
    let agent = match store::find(target) {
        Ok(Some(a)) => a,
        _ => return error(format!("There's no agent called {target}.")),
    };
    if agent.is_main {
        return error("The Chief of Staff can't be deleted.");
    }
    let answer = ask_user(
        app,
        caller,
        format!("Delete {}", agent.name),
        "Its memory and conversation are deleted too. This can't be undone.".to_string(),
        None,
    )
    .await;
    if let Some(refused) = refused_reply(&answer, "delete it") {
        return error(refused);
    }
    match super::takeover::delete_agent(app, &agent.id).await {
        Ok(removed) => {
            // Its copy's folder goes (pending work committed first); a
            // branch with work on it stays. The copy as it was at delete,
            // not before the question.
            if let Some(copy) = removed.copy {
                tauri::async_runtime::spawn(super::task::abandon(copy));
            }
            let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
            // No link: there's nothing left to open.
            let line = audit_note(&caller.id, format!("Deleted {}", agent.name), None);
            let _ = runner::record(app, line);
            text(format!("Deleted {}.", agent.name))
        }
        Err(e) => error(e.to_string()),
    }
}

/// A secure input card. Nothing waits on it: saving or declining wakes the
/// agent (see `commands::agents::agents_save_secret`), so a card answered
/// tomorrow works as well as one answered now.
fn request_secret(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    request_secret_as(app, caller, args, false)
}

/// A secure input card for an agent the import connector brought in: saving
/// or declining it doesn't wake the agent (`secrets::Request::quiet`).
pub(crate) fn request_secret_quiet(app: &AppHandle, agent: &store::Agent, args: &Value) -> Value {
    request_secret_as(app, agent, args, true)
}

fn request_secret_as(app: &AppHandle, caller: &store::Agent, args: &Value, quiet: bool) -> Value {
    let labels: Vec<String> = args
        .get("fields")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut request = match super::secrets::build_request(
        caller,
        arg(args, "name").unwrap_or(""),
        arg(args, "purpose").unwrap_or(""),
        arg(args, "kind").unwrap_or(""),
        &labels,
    ) {
        Ok(r) => r,
        Err(e) => return error(e.to_string()),
    };
    request.quiet = quiet;
    let open = store::pending_approvals(&caller.id).unwrap_or_default();
    if open
        .iter()
        .any(|a| a.secret.as_ref().is_some_and(|s| s.name == request.name))
    {
        return text(format!(
            "You already asked for {}; the card is still waiting in this chat. Stop here.",
            request.name
        ));
    }
    let mut approval = new_card(
        store::new_id(),
        format!("Secure input · {}", request.name),
        request.purpose.clone(),
        None,
    );
    let reply = super::secrets::asked_reply(&request);
    approval.secret = Some(request);
    let mut card = runner::new_message(&caller.id, MessageKind::Approval, "");
    card.approval = Some(approval);
    if let Err(e) = runner::record(app, card) {
        return error(e.to_string());
    }
    store::refresh_pending(&caller.id);
    super::notify::refresh_badge(app);
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    text(reply)
}

/// Put an Allow / Deny card in the caller's chat and wait for the answer.
///
/// `call` is the Claude Code tool call the card is about, if any. Those cards
/// outlive the wait (see APPROVAL_WAIT_SECS); cards without one expire with it.
pub(super) async fn ask_user(
    app: &AppHandle,
    caller: &store::Agent,
    title: String,
    detail: String,
    call: Option<(&str, &Value)>,
) -> Answer {
    ask(app, caller, title, None, detail, call).await
}

/// `ask_user` for a card whose detail is raw (a push): it leads with `summary`
/// and keeps the detail behind Details. Never tied to a tool call.
pub(super) async fn ask_user_with_summary(
    app: &AppHandle,
    caller: &store::Agent,
    title: String,
    summary: String,
    detail: String,
) -> Answer {
    ask(app, caller, title, Some(summary), detail, None).await
}

async fn ask(
    app: &AppHandle,
    caller: &store::Agent,
    title: String,
    summary: Option<String>,
    detail: String,
    call: Option<(&str, &Value)>,
) -> Answer {
    let request_id = store::new_id();
    let (tx, rx) = oneshot::channel();
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), tx);

    let mut card = runner::new_message(&caller.id, MessageKind::Approval, "");
    let mut approval = new_card(request_id.clone(), title, detail, call);
    approval.summary = summary;
    card.approval = Some(approval);
    let _ = runner::record(app, card);
    store::refresh_pending(&caller.id);
    super::notify::refresh_badge(app);
    // "Waiting for your OK" until this card and any other open one are answered.
    let wait = runner::begin_wait(app, &caller.id);

    let waited = tokio::time::timeout(approval_wait(), rx)
        .await
        .ok()
        .map(Result::ok);
    // The command wrote the decision (and any note) before waking us.
    let answer = read_wait(waited, || {
        store::find_approval(&caller.id, &request_id)
            .ok()
            .flatten()
            .and_then(|a| a.note)
    });
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);

    // An answered card was already written by the command. An unanswered one
    // stays pending if a late answer can still act on it, else it expires.
    if answer == Answer::NotYet && call.is_none() {
        if let Ok(Some(updated)) =
            store::set_approval_status(&caller.id, &request_id, ApprovalStatus::Expired)
        {
            let _ = tauri::Emitter::emit(app, runner::EVENT_MESSAGE, &updated);
        }
    }
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    // Back to work, unless another card is still open, or the turn already
    // ended under this one (Stop, or the user interrupted it).
    drop(wait);
    answer
}

/// What a wait on a card came to: `None` when the wait ran out, `Some(None)`
/// when nobody will answer it any more. Neither is the user's answer.
pub(super) fn read_wait(
    waited: Option<Option<bool>>,
    note: impl FnOnce() -> Option<String>,
) -> Answer {
    match waited {
        Some(Some(true)) => Answer::Allowed,
        Some(Some(false)) => Answer::Denied(note()),
        Some(None) | None => Answer::NotYet,
    }
}

/// The tool's reply when a confirmation didn't come back as Allow: the
/// user's No, or (never dressed up as a No) a card that expired unanswered.
pub(super) fn refused_reply(answer: &Answer, what: &str) -> Option<String> {
    match answer {
        Answer::Allowed => None,
        Answer::Denied(None) => Some(format!("The user said no. Don't {what}.")),
        Answer::Denied(Some(note)) => Some(format!(
            "The user said no, and told you: \"{note}\". Don't {what}."
        )),
        Answer::NotYet => Some(format!(
            "The user didn't answer in time, so the request expired; nothing was done. Don't {what} now. Tell them in one line, and ask again when they're back."
        )),
    }
}

/// The card for a request. Only a Claude Code tool call can be always
/// allowed: Ship Studio's own confirmations (delete an agent) never offer it.
pub(super) fn new_card(
    request_id: String,
    title: String,
    detail: String,
    call: Option<(&str, &Value)>,
) -> Approval {
    Approval {
        request_id,
        title,
        detail,
        status: ApprovalStatus::Pending,
        tool: call.map(|(tool, _)| tool.to_string()),
        input: call.map(|(_, input)| input.clone()),
        always: call.and_then(|(tool, input)| permissions::suggest(tool, input)),
        always_allowed: false,
        summary: None,
        note: None,
        prompt: None,
        choice: None,
        secret: None,
        connector: None,
    }
}

/// The user chose "Always allow" on a card: keep its scope as a rule, and
/// return it so the other cards it covers can be answered too.
pub fn always_allow(
    agent_id: &str,
    approval: &Approval,
) -> Result<permissions::Scope, CommandError> {
    let Some(scope) = approval.always.clone() else {
        return Err(CommandError::expected(
            "This one can't be always allowed. Allow it once instead.",
        ));
    };
    store::update(agent_id, |a| {
        if !a.permissions.iter().any(|r| r.scope == scope) {
            a.permissions.push(permissions::Rule {
                id: store::new_id(),
                scope: scope.clone(),
                created_at: store::now_ms(),
                extra: Default::default(),
            });
        }
    })?;
    Ok(scope)
}

/// The other open cards a new rule covers: they'd go through without asking
/// now, so they shouldn't sit there asking.
pub fn covered_by(scope: &permissions::Scope, open: &[Approval], except: &str) -> Vec<String> {
    open.iter()
        .filter(|a| a.request_id != except && a.status == ApprovalStatus::Pending)
        .filter(|a| match (&a.tool, &a.input) {
            (Some(tool), Some(input)) => scope.matches(tool, input),
            _ => false,
        })
        .map(|a| a.request_id.clone())
        .collect()
}

/// What an automatically allowed call is, in one line: the command or the
/// address when there is one, else what the tool does.
fn one_line(tool: &str, input: &Value) -> String {
    let (title, detail) = describe_request(tool, input);
    let line = match tool {
        "Bash" | "WebFetch" | "WebSearch" => detail.lines().next().unwrap_or("").trim().to_string(),
        _ => String::new(),
    };
    let line = if line.is_empty() { title } else { line };
    if line.chars().count() > 120 {
        line.chars().take(120).collect::<String>() + "…"
    } else {
        line
    }
}

/// The user answered a card nobody is waiting on any more. Allow grants that
/// exact call once and wakes the agent to finish; Deny just records it.
pub fn answer_late(
    app: &AppHandle,
    agent_id: &str,
    approval: &Approval,
    allow: bool,
) -> Result<(), CommandError> {
    let (Some(tool), Some(input)) = (&approval.tool, &approval.input) else {
        return Err(CommandError::expected(
            "That request isn't waiting any more. Ask the agent to try again.",
        ));
    };
    if !allow {
        return Ok(());
    }
    grant_once(agent_id, tool, input);
    runner::enqueue(
        app,
        agent_id,
        format!(
            "[The user has now approved this, which you asked for earlier: {} — {}. It will go through without asking if you run it exactly as before. Carry on with what you were doing.]",
            approval.title, approval.detail
        ),
        runner::From::User,
    );
    Ok(())
}

/// Turn a pending tool call into words a person can approve.
pub fn describe_request(tool: &str, input: &Value) -> (String, String) {
    let field = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match tool {
        "Bash" => ("Run a command".into(), field("command")),
        "Write" => ("Create a file".into(), field("file_path")),
        "Edit" | "MultiEdit" => ("Edit a file".into(), field("file_path")),
        "Read" => ("Read a file outside its folders".into(), field("file_path")),
        "WebFetch" => ("Open a web page".into(), field("url")),
        "WebSearch" => ("Search the web".into(), field("query")),
        other => {
            let mut detail = serde_json::to_string_pretty(input).unwrap_or_default();
            if detail.chars().count() > 600 {
                detail = detail.chars().take(600).collect::<String>() + "…";
            }
            (mcp_title(other), detail)
        }
    }
}

/// `mcp__gmail__send_email` → "Send an email · Gmail": a verb phrase from the
/// tool's name, with the server it belongs to as context. Anything that isn't
/// an MCP tool name keeps its own name after "Use".
fn mcp_title(tool: &str) -> String {
    let Some((server, name)) = tool.strip_prefix("mcp__").and_then(|t| t.split_once("__")) else {
        return format!("Use {tool}");
    };
    let words = split_words(name);
    let Some((verb, object)) = words.split_first() else {
        return format!("Use {tool}");
    };
    let mut phrase = capitalize(verb);
    if !object.is_empty() {
        let last = object.last().map(String::as_str).unwrap_or("");
        // "Send an email", "Create a draft"; but "List messages", "Get status".
        let countable = !last.ends_with('s')
            && ![
                "content",
                "data",
                "info",
                "information",
                "metadata",
                "text",
                "code",
                "status",
            ]
            .contains(&last);
        if countable {
            let vowel = object[0].starts_with(['a', 'e', 'i', 'o', 'u']);
            phrase.push_str(if vowel { " an" } else { " a" });
        }
        phrase.push(' ');
        phrase.push_str(&object.join(" "));
    }
    format!("{phrase} · {}", service_name(server))
}

/// An MCP server's name as a person would say it: `claude_ai_Gmail` →
/// "Gmail", `claude_ai_Google_Drive` → "Google Drive", `github` → "GitHub".
pub(super) fn service_name(server: &str) -> String {
    // Claude.ai connectors arrive as `claude_ai_Gmail`.
    let server = server.strip_prefix("claude_ai_").unwrap_or(server);
    match server.to_ascii_lowercase().as_str() {
        "github" => "GitHub".to_string(),
        "claude-in-chrome" | "claude_in_chrome" | "chrome" => "Chrome".to_string(),
        _ => split_words(server)
            .iter()
            .map(|w| capitalize(w))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// `send_email`, `send-email` and `sendEmail` → ["send", "email"].
pub(super) fn split_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for c in name.chars() {
        if c == '_' || c == '-' || c == ' ' || c == '.' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else if c.is_uppercase() && current.chars().last().is_some_and(|p| p.is_lowercase()) {
            words.push(std::mem::take(&mut current));
            current.extend(c.to_lowercase());
        } else {
            current.extend(c.to_lowercase());
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// What became of a tool call that needed the user's OK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Decision {
    Allow,
    /// Refused, with what to tell the agent.
    Deny(String),
}

/// Decide a tool call the engine wants the user's OK for: a one-time grant
/// from a late Allow, a standing "Always allow" rule, or else a card. Shared
/// by Claude Code's permission prompt tool and Codex's approval requests.
/// `why` is the engine's own reason, when it gave one, shown on the card.
pub(super) async fn decide(
    app: &AppHandle,
    caller: &store::Agent,
    tool: &str,
    input: &Value,
    why: Option<&str>,
) -> Decision {
    if take_grant(&caller.id, tool, input) {
        return Decision::Allow;
    }
    if permissions::matching(&caller.permissions, tool, input).is_some() {
        // Nothing happens invisibly: each one leaves a quiet line in the chat.
        let line = format!(
            "Allowed automatically: {} · Always allowed",
            one_line(tool, input)
        );
        let _ = runner::record_in_turn(
            app,
            runner::new_message(&caller.id, MessageKind::Note, line),
        );
        return Decision::Allow;
    }
    let (title, mut detail) = describe_request(tool, input);
    if let Some(why) = why.map(str::trim).filter(|w| !w.is_empty()) {
        detail = format!("{detail}\n\n{why}");
    }
    match ask_user(app, caller, title, detail, Some((tool, input))).await {
        Answer::Allowed => Decision::Allow,
        Answer::Denied(note) => Decision::Deny(denied(note)),
        Answer::NotYet => Decision::Deny(NOT_YET.to_string()),
    }
}

/// What the agent is told when the user said no.
pub(super) fn denied(note: Option<String>) -> String {
    match note {
        None => "The user said no to this. Don't retry it; tell them what you were trying to do, or find another way.".to_string(),
        Some(note) => format!("The user said no to this, and told you: \"{note}\". Don't retry it; do what they said instead."),
    }
}

/// What the agent is told when the card is still waiting.
pub(super) const NOT_YET: &str = "The user hasn't answered yet; they may be away. Don't retry and don't work around it. Stop here and tell them in one short line what you need approved and why. The request stays in their chat: if they allow it later, you'll be woken up to finish, and that exact call will go through.";

async fn approve(app: &AppHandle, caller: &store::Agent, turn: Option<u64>, args: &Value) -> Value {
    let tool = args
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("a tool");
    let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
    let request_id = args.get("tool_use_id").and_then(Value::as_str);
    // Fail closed before anything else: no card for a turn that isn't running.
    let admission = super::broker::admit(&caller.id, turn, request_id);
    if admission != super::broker::Admission::Live {
        tracing::warn!(agent = %caller.id, ?turn, ?request_id, ?admission, "[Agents] approval request refused without asking");
        return text(
            json!({ "behavior": "deny", "message": super::broker::refusal(admission) }).to_string(),
        );
    }
    let answer = match decide(app, caller, tool, &input, None).await {
        Decision::Allow => json!({ "behavior": "allow", "updatedInput": input }),
        Decision::Deny(message) => {
            // The user said no: the call's step says so (an unanswered card
            // isn't a no, and its call comes back as an error instead).
            if message != NOT_YET {
                if let Some(call) = request_id {
                    super::work::on_declined(&caller.id, call);
                }
            }
            json!({ "behavior": "deny", "message": message })
        }
    };
    text(answer.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(id: &str, name: &str) -> store::Agent {
        serde_json::from_value(json!({
            "id": id, "name": name, "role": "Invoices and the books",
            "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap()
    }

    #[test]
    fn chief_actions_leave_linked_notes_in_both_chats() {
        let chief = named("chief", "Chief of Staff");
        let finance = named("fin", "Finance");
        let notes = create_notes(&chief, &finance);
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|n| n.kind == MessageKind::Note));
        assert_eq!(notes[0].agent_id, "chief");
        assert_eq!(notes[0].text, "Created Finance · Invoices and the books");
        assert_eq!(notes[0].peer.as_ref().unwrap().id, "fin");
        assert_eq!(notes[1].agent_id, "fin");
        assert_eq!(notes[1].text, "Created by Chief of Staff");
        assert_eq!(notes[1].peer.as_ref().unwrap().id, "chief");

        let notes = update_notes(&chief, &finance, &finance, &["instructions"]);
        assert_eq!(
            notes
                .iter()
                .map(|n| (n.agent_id.as_str(), n.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("chief", "Updated Finance's instructions"),
                ("fin", "Instructions updated by Chief of Staff")
            ]
        );
        // Nothing changed: nothing said. The Chief updating itself: one line.
        assert!(update_notes(&chief, &finance, &finance, &[]).is_empty());
        assert_eq!(update_notes(&chief, &chief, &chief, &["role"]).len(), 1);
    }

    #[test]
    fn audit_lines_say_what_the_chief_did() {
        assert_eq!(
            created_line("Finance", "Invoices and the books", None),
            "Created Finance · Invoices and the books"
        );
        assert_eq!(
            created_line("Acme Site", "", Some("/u/ShipStudio/acme/")),
            "Created Acme Site · works in acme"
        );
        let by = "Chief of Staff";
        assert_eq!(
            updated_lines("Acme Site", "Acme Site", &["instructions"], by),
            (
                "Updated Acme Site's instructions".into(),
                "Instructions updated by Chief of Staff".into()
            )
        );
        assert_eq!(
            updated_lines("Acme", "Acme", &["role", "instructions", "project"], by).0,
            "Updated Acme's role, instructions and project"
        );
        assert_eq!(
            updated_lines("Finance", "Books", &[], by),
            (
                "Renamed Finance to Books".into(),
                "Renamed from Finance by Chief of Staff".into()
            )
        );
        assert_eq!(
            updated_lines("Finance", "Books", &["role"], by).0,
            "Renamed Finance to Books and updated its role"
        );
    }

    #[test]
    fn a_late_allow_grants_exactly_one_identical_call() {
        let input = json!({ "command": "git commit -m x" });
        grant_once("agent-a", "Bash", &input);
        // Another agent, another tool or another input doesn't match.
        assert!(!take_grant("agent-b", "Bash", &input));
        assert!(!take_grant("agent-a", "Write", &input));
        assert!(!take_grant(
            "agent-a",
            "Bash",
            &json!({ "command": "git push" })
        ));
        assert!(take_grant("agent-a", "Bash", &input));
        // Once.
        assert!(!take_grant("agent-a", "Bash", &input));
    }

    #[test]
    fn a_new_rule_covers_other_open_cards_it_matches() {
        let card = |id: &str, cmd: &str| {
            new_card(
                id.into(),
                "Run a command".into(),
                cmd.into(),
                Some(("Bash", &json!({ "command": cmd }))),
            )
        };
        let open = vec![
            card("a", "npm test"),
            card("b", "npm test -- --watch"),
            card("c", "npm test && rm -rf build"),
            card("d", "git push"),
            new_card("e".into(), "Delete agent".into(), "Finance".into(), None),
        ];
        let scope = open[0].always.clone().unwrap();
        assert_eq!(covered_by(&scope, &open, "a"), vec!["b".to_string()]);
    }

    #[test]
    fn only_tool_calls_can_be_always_allowed() {
        let input = json!({ "command": "npm test" });
        let card = new_card("r".into(), "t".into(), "d".into(), Some(("Bash", &input)));
        assert_eq!(card.always.map(|s| s.value).as_deref(), Some("npm test"));
        // Ship Studio's own confirmation (delete an agent) has no call.
        let confirm = new_card("r".into(), "Delete Finance".into(), "d".into(), None);
        assert!(confirm.always.is_none());
        assert!(always_allow("agent-a", &confirm).is_err());
    }

    #[test]
    fn auto_allowed_lines_name_the_call() {
        assert_eq!(
            one_line("Bash", &json!({ "command": "npm test\nmore" })),
            "npm test"
        );
        assert_eq!(
            one_line("mcp__gmail__send_email", &json!({ "to": "x" })),
            "Send an email · Gmail"
        );
    }

    #[test]
    fn commands_are_described_by_the_command_itself() {
        let (title, detail) =
            describe_request("Bash", &json!({ "command": "git push origin main" }));
        assert_eq!(title, "Run a command");
        assert_eq!(detail, "git push origin main");
    }

    #[test]
    fn mcp_tools_get_a_readable_name() {
        let title = |tool: &str| describe_request(tool, &json!({ "to": "x" })).0;
        assert_eq!(title("mcp__gmail__send_email"), "Send an email · Gmail");
        assert_eq!(
            title("mcp__claude_ai_Gmail__create_draft"),
            "Create a draft · Gmail"
        );
        assert_eq!(
            title("mcp__github__list_pull_requests"),
            "List pull requests · GitHub"
        );
        assert_eq!(
            title("mcp__google-drive__getFileContent"),
            "Get file content · Google Drive"
        );
        assert_eq!(title("mcp__linear__search"), "Search · Linear");
        assert_eq!(title("SomethingElse"), "Use SomethingElse");
    }

    #[test]
    fn management_tools_are_hidden_from_regular_agents() {
        let agent = store::Agent {
            id: "a".into(),
            name: "Finance".into(),
            role: String::new(),
            shape: 0,
            color: "red".into(),
            is_main: false,
            pinned: false,
            hidden: false,
            session_id: None,
            created_at: 0,
            last_activity_at: 0,
            preview: None,
            unread: 0,
            pending_approvals: 0,
            engine: Default::default(),
            model: None,
            new_engine: false,
            context: None,
            routine_model: None,
            template: None,
            muted: false,
            check_ins: Vec::new(),
            usage: Default::default(),
            permissions: Vec::new(),
            failure: None,
            project: None,
            copy: None,
            work_directly: false,
            capabilities: None,
            secrets: Vec::new(),
            extra: Default::default(),
        };
        let names: Vec<String> = tools_list(&agent)["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"message_agent".to_string()));
        assert!(names.contains(&"share_file".to_string()));
        assert!(names.contains(&"share_result".to_string()));
        assert!(!names.contains(&"create_agent".to_string()));
        assert!(!names.contains(&"delete_agent".to_string()));
    }

    #[test]
    fn create_agent_without_a_template_needs_a_role_and_instructions() {
        let err = |args: Value| create_args(&args).err().unwrap();
        let both = err(json!({ "name": "Finance" }));
        assert!(
            both.contains("`role` and `instructions` are required"),
            "{both}"
        );
        let one = err(json!({ "name": "Finance", "role": "Invoices", "instructions": "  " }));
        assert!(one.contains("`instructions` is required"), "{one}");
        assert!(err(json!({ "name": "X", "template": "nope" })).contains("no ready-made agent"));
        let made = create_args(
            &json!({ "name": "F", "role": "Invoices", "instructions": "Pay on time." }),
        )
        .unwrap();
        assert_eq!(
            (made.role.as_str(), made.instructions.as_str()),
            ("Invoices", "Pay on time.")
        );
        assert!(made.template.is_none() && made.color.is_none());
        // A template alone is enough.
        let research = super::super::templates::find("research").unwrap();
        let made = create_args(&json!({ "name": "R", "template": "research" })).unwrap();
        assert_eq!(made.role, research.role);
        assert_eq!(made.instructions, research.instructions());
        assert_eq!(made.color.as_deref(), Some(research.color.as_str()));
    }

    #[test]
    fn the_outside_card_for_a_template_shows_its_role_and_what_is_added() {
        let research = super::super::templates::find("research").unwrap();
        let (title, detail) = outside_card(
            "create_agent",
            &json!({ "name": "Research", "template": "research", "instructions": "Works in climate policy." }),
        );
        assert_eq!(title, "Create Research");
        assert!(
            detail.starts_with(&format!(
                "From the ready-made {}\n{}\nAdded to its briefing: Works in climate policy.\n\n",
                research.title, research.role
            )),
            "{detail}"
        );
        // A role given wins over the template's.
        let (_, detail) = outside_card(
            "create_agent",
            &json!({ "name": "R", "template": "research", "role": "Climate papers" }),
        );
        assert!(detail.contains("\nClimate papers\n") && !detail.contains(&research.role));
        // Without a template, the briefing is what's shown.
        let (_, detail) = outside_card(
            "create_agent",
            &json!({ "name": "F", "role": "Invoices", "instructions": "Pay on time." }),
        );
        assert!(
            detail.starts_with("Invoices\nInstructions: Pay on time.\n\n"),
            "{detail}"
        );
    }

    #[test]
    fn the_chief_can_create_from_a_ready_made_agent() {
        let tool = TOOLS.iter().find(|t| t.name == "create_agent").unwrap();
        let schema = (tool.schema)();
        // A name is all it must give: a template brings the role and briefing.
        assert_eq!(schema["required"], json!(["name"]));
        let offered: Vec<&str> = schema["properties"]["template"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(offered, super::super::templates::ids());
    }
}
