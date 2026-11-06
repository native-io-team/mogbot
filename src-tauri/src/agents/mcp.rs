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
    /// The user hasn't answered within the wait: the card expired
    /// (`agents/expiry.rs`), or the same ask already had in this task.
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

/// Whether a call is still parked on this card (`agents/expiry.rs`).
pub(super) fn is_waited_on(request_id: &str) -> bool {
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(request_id)
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
        name: "read_agent",
        description: "Read another agent without waking it: its role, instructions and memory, routines, logins and the requests waiting on the user. Use it to find out what an agent does or needs instead of messaging it to ask.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "description": "The agent's name (or id)." }
            },
            "required": ["agent"]
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
        description: "Change an agent's name, role, instructions, project, engine or look. Instructions replace the old ones; its memory is kept. `project` takes a name or path from project_list, or \"none\" to unbind it. `engine` (`claude` or `codex`) switches what it runs on from its next turn: a new session, handed the recent conversation. `shape`, `face` and `color` change how it looks (\"give Hiring a hexagon with a curious face\"); give only what changes. A look applies at once, with no card: it isn't a setting.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string" },
                "name": { "type": "string" },
                "role": { "type": "string" },
                "instructions": { "type": "string" },
                "project": { "type": "string" },
                "engine": { "type": "string", "enum": ["claude", "codex"] },
                "shape": { "type": "string", "enum": store::AVATAR_SHAPES },
                "face": { "type": "string", "enum": store::AVATAR_FACES },
                "color": { "type": "string", "enum": store::COLORS }
            },
            "required": ["agent"]
        }),
    },
    Tool {
        name: "delete_agent",
        description: "Admin: delete another agent. It leaves the team at once and waits in Recently deleted for 30 days with its memory and conversation, where the user can restore it.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": { "agent": { "type": "string" } },
            "required": ["agent"]
        }),
    },
    Tool {
        name: "share_file",
        description: "Hand the user a file you made (a report, CSV, image, PDF, zip): it appears in this chat as one message, your `text` above a file card they can open (images show inline). Use it instead of pasting a file's contents. When the user wants text and a file together (a post's copy and its image), call it once per item with that item's full text in `text`; a short `caption` alone is only a label, not the text. The file must be in your own folder or one of the user's projects; folders aren't accepted, so zip one first. Up to 25 MB.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute, ~/…, or relative to your folder." },
                "text": { "type": "string", "description": "The message to show with the file, above it: can be the full text the user asked for (e.g. a post's whole copy), several lines, markdown allowed." },
                "caption": { "type": "string", "description": "Optional: a short label (\"1 of 6 · Fri 10am\"), shown first. Not a place for the text itself: use `text`." }
            },
            "required": ["path"]
        }),
    },
    Tool {
        name: "share_result",
        description: "Hand back a finished piece of work as ONE result card at the end of your reply: a title, a short summary, the files you made (documents, CSVs, screenshots), the links you produced or relied on, what you checked, and what you did NOT verify. Call it when the work is done, instead of listing deliverables in prose (for visual work, also once at the first visible milestone with `checkpoint: true`). Be honest: list only checks you actually ran in `checked`, and put anything you assumed, couldn't test or couldn't reach in `not_verified` (the user sees it prominently). Files must exist in your own folder or one of the user's projects; they're copied into the chat. When the user asks for changes to a result, revise it: call this again with `revises` (the result's id) and `changes` (one line on what changed), and the same card becomes the next version. A second call in the same turn replaces the first.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "A few words naming what you made (\"Q3 invoice summary\")." },
                "summary": { "type": "string", "description": "Two or three sentences: what it is and what it's for." },
                "items": {
                    "type": "array",
                    "description": "What the result is made of, most important first. Each has a `path` (a file: absolute, ~/…, or relative to your folder) or a `url` (http/https), an optional short `label` (the caption), and for screenshots a `role` of \"before\" or \"after\" and the `page` it shows (\"Home\", \"Pricing\"). Before/after shots of several pages make ONE card with a compare per page: never send them as separate messages or files.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "url": { "type": "string" },
                            "label": { "type": "string" },
                            "role": { "type": "string", "enum": ["before", "after"] },
                            "page": { "type": "string", "description": "With `role`: the page or screen the shot is of." }
                        }
                    }
                },
                "checked": { "type": "array", "items": { "type": "string" }, "description": "Checks you actually ran, one short line each." },
                "not_verified": { "type": "array", "items": { "type": "string" }, "description": "What you didn't or couldn't verify, one short line each. Leave nothing out to look better." },
                "revises": { "type": "string", "description": "The id of a result you're revising (given when the user asks for changes)." },
                "changes": { "type": "string", "description": "When revising: one line on what changed since the last version." },
                "project": { "type": "string", "description": "When the work is a site or app in one of the user's projects: its name (from project_list). The card gets Preview (beside the chat), Watch live (phone) and Test it, so don't call project_open yourself." },
                "checkpoint": { "type": "boolean", "description": "true at a milestone partway through visual work (the first change you can see): the card shows in the chat NOW, marked partway, while you keep working. Your final share_result in the same turn becomes its next version." }
            },
            "required": ["title", "summary"]
        }),
    },
    Tool {
        name: "schedule_check_in",
        description: "Have the app wake you later with a note to yourself: use it whenever you tell the user you'll check back, follow up or remind them, so that actually happens. Once (\"tomorrow at 9:00\", \"in 2 hours\", \"friday 14:30\") or as a routine (\"every weekday at 9:00\", \"every monday at 8am\", \"every 2 hours\"), in the user's local time. It only fires while the app is open; the answer says exactly when and what happens if it's closed. Tell the user that time. To the user these are routines (a one-time one is \"scheduled\"): never say \"check-in\" or a tool's name.",
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
        description: "Ask the user for an API key or token made for programs (a Stripe restricted key, an X API token) through a secure card in this chat. They type it into a masked field; it goes into the macOS Keychain for you alone, and you get an environment variable and a reference, never the value. For an account (email, Slack, LinkedIn, X, GitHub, Linear…) use request_login instead; never ask for a password, here or in chat. It returns at once: stop and tell the user in one line what it's for; you'll be woken when they save or decline it.",
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
        name: "request_login",
        description: "Get access to an app or account you're blocked on for the user's task (Gmail, Google Calendar, Slack, LinkedIn, X, GitHub, Linear, Notion, Figma…). Try first: your own tools for it, then the user's signed-in browser (mcp__claude-in-chrome__*) if you have it. This checks the same on the Mac before asking: it may answer that you can reach it already (and how), that the user already answered, or that someone else's card for it is waiting and you're on it. Only otherwise does one card appear in this chat, on their phone too, with a sign-in button (the app's own sign-in; for a site in their Chrome they can do it from the phone, \"Sign in from here\"; you never see a password). Use it, with signed_out: true, when a page in their browser asks for a sign-in or a password: never tell the user to go to their computer or to finish in a tab you left open. Never ask for a password or a login in chat, never up front, one at a time. When a card was raised, stop and tell the user in one line what it's for; you're woken when they answer.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "service": { "type": "string", "description": "The app or site, e.g. gmail, google_calendar, slack, linkedin, x, github, linear, notion, figma, stripe, vercel; or its name if it's something else." },
                "account_hint": { "type": "string", "description": "Optional: which account, when it matters (\"work Gmail\", \"sam@acme.com\")." },
                "scopes": { "type": "array", "items": { "type": "string" }, "description": "What you need: [\"read\"], or also [\"send\"], [\"post\"], [\"write\"]. Ask for the least that does the job." },
                "why": { "type": "string", "description": "What you'll use it for, in one line. Shown on the card." },
                "signed_out": { "type": "boolean", "description": "true when you opened it in the user's browser and the page asked you to sign in." }
            },
            "required": ["service", "why"]
        }),
    },
    Tool {
        name: super::policy_card::TOOL,
        description: super::policy_card::DESCRIPTION,
        main_only: false,
        schema: super::policy_card::schema,
    },
    Tool {
        name: "remember_browser_account",
        description: "After you checked, on the page itself, which account one of your sites is signed in as in the user's Chrome: remember which Chrome profile (browser) that was, so next time starts there. Only for your own sites; never a guess.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "site": { "type": "string", "description": "The site, as you were given it (e.g. www.figma.com)." },
                "browser": { "type": "string", "description": "The browser's name from list_connected_browsers (e.g. \"Browser 1\")." },
                "account": { "type": "string", "description": "The account the page showed (an email or a username)." }
            },
            "required": ["site", "browser"]
        }),
    },
    Tool {
        name: "ask_bring_browser_to_front",
        description: "The account a task needs isn't in any connected Chrome profile you've looked in, and no other profile is connected: ask the user, once, to bring the right Chrome window to the front. One plain card (Check again / Not now), never a login. If another profile is connected that you haven't looked in, it says so instead. When a card was raised, stop; you're woken when they answer.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "site": { "type": "string", "description": "The site, as you were given it." },
                "account": { "type": "string", "description": "The account you need (\"sam@work.example\"), when you know it." },
                "looked_in": { "type": "array", "items": { "type": "string" }, "description": "The browsers you already opened it in and found the wrong account." }
            },
            "required": ["site"]
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
        "instructions": "The app you live in, on the user's Mac: the user's projects, which you work on through their sessions (project_* and session_* tools), other agents you can message, and (for the Chief of Staff) creating and managing agents. Call it \"the app\"."
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

/// Whether `caller` is served `tool`. Admin tools (reading another agent,
/// deleting one) follow the user's Admin switch, and are off in a turn
/// answering outside text (`admin::admin_now`); the rest are the Chief's.
fn serves(tool: &Tool, caller: &store::Agent) -> bool {
    match tool.name {
        "delete_agent" => super::admin::admin_now(caller),
        "read_agent" => caller.is_main || super::admin::admin_now(caller),
        _ => !tool.main_only || caller.is_main,
    }
}

/// `tools/list` as `caller` is served it, for the copy scan (`brand_copy_tests`).
#[cfg(test)]
pub(super) fn tools_list_for_tests(caller: &store::Agent) -> Value {
    tools_list(caller)
}

fn tools_list(caller: &store::Agent) -> Value {
    let mut tools: Vec<Value> = TOOLS
        .iter()
        .filter(|t| serves(t, caller))
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect();
    tools.extend(
        super::usage_tools::TOOLS
            .iter()
            .filter(|t| !t.main_only || caller.is_main)
            .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() })),
    );
    // Rooms are the Chief's to make and change, like agents.
    if caller.is_main {
        tools.extend(
            super::room_tools::TOOLS
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() })),
        );
    }
    if super::admin::admin_now(caller) {
        tools.extend(
            super::admin::TOOLS
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() })),
        );
    }
    // Every agent works on projects the same way.
    tools.extend(super::sessions::definitions());
    // "Test it": only while the user's run is open (`preview_test`).
    tools.extend(super::preview_test::definitions(&caller.id));
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
            // The user's own local preview, after they pressed Test it: no
            // card (local work), and nothing but that page.
            if let Some(tool) = super::preview_test::find(name) {
                return ok(super::preview_test::call(app, &caller, turn, tool, &args).await);
            }
            if let Some(tool) = super::usage_tools::find(name) {
                return ok(usage_tool(app, &caller, turn, tool, &args).await);
            }
            // Chief-only, and a card first in a turn answering outside text
            // (`room_tools::gate`), after the call is checked in full.
            if let Some(tool) = super::room_tools::find(name) {
                return ok(super::room_tools::call(app, &caller, turn, tool, &args).await);
            }
            // Admin only, checked again on every call (`admin::call`).
            if let Some(tool) = super::admin::find(name) {
                return ok(super::admin::call(app, &caller, tool, &args).await);
            }
            let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
                return fail(-32602, &format!("Unknown tool: {name}"));
            };
            if (name == "delete_agent" || name == "read_agent") && !serves(tool, &caller) {
                return ok(error(
                    super::admin::refusal(&caller).unwrap_or("Only an admin can do that."),
                ));
            }
            if tool.main_only && !caller.is_main && name != "read_agent" && name != "delete_agent" {
                return ok(error(
                    "Only the Chief of Staff can do that. Ask it with message_agent.",
                ));
            }
            // Only the user makes an agent an admin.
            if (name == "create_agent" || name == "update_agent")
                && super::admin::tries_to_grant(&args)
            {
                return ok(error(super::admin::ONLY_THE_USER_GRANTS));
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

/// The usage tools (`usage_tools`). Read-only ones answer anyone; a turn
/// answering outside text can't add work or run a routine, and a mode
/// change is always the user's, on a card.
async fn usage_tool(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    tool: &super::usage_tools::Def,
    args: &Value,
) -> Value {
    use super::usage_tools as u;
    if tool.main_only && !caller.is_main {
        return error("Only the Chief of Staff can do that. Ask it with message_agent.");
    }
    let outside = runner::from_outside(&caller.id) && super::broker::is_live(&caller.id, turn);
    match tool.name {
        "usage_overview" => u::overview().await,
        "forecast_usage" => u::forecast(args).await,
        "add_spare_work" | "finish_spare_work" | "run_routine_now" if outside => error(
            "Not while answering what a “When…” routine found: that text came from outside this app. Tell the user instead.",
        ),
        "add_spare_work" => u::add(caller, args),
        "finish_spare_work" => u::finish(args),
        "run_routine_now" => u::run_routine(app, args),
        "set_usage_mode" => {
            let mode = match super::usage_plan::Mode::parse(arg(args, "mode").unwrap_or("")) {
                Ok(m) => m,
                Err(e) => return error(e.to_string()),
            };
            let (title, detail) = u::mode_card(mode);
            let answer = ask_user(app, caller, title, detail, None).await;
            if let Some(refused) = refused_reply(&answer, "change it") {
                return error(refused);
            }
            u::set_mode(app, mode)
        }
        _ => error("Unknown tool"),
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
        "read_agent" => read_agent(args),
        "share_file" => share_file(app, caller, args).await,
        "share_result" => share_result(app, caller, turn, args).await,
        "create_agent" => create_agent(app, caller, args).await,
        "update_agent" => update_agent(app, caller, args).await,
        "delete_agent" => delete_agent(app, caller, args).await,
        "schedule_check_in" | "list_check_ins" | "cancel_check_in" | "watch_for" => {
            check_ins(app, caller, turn, name, args).await
        }
        "request_secret" => request_secret(app, caller, args),
        "request_login" => request_login(app, caller, args).await,
        "remember_browser_account" => {
            match super::browser_profiles::remember(caller, args, runner::from_outside(&caller.id))
            {
                Ok(t) => text(t),
                Err(e) => error(e),
            }
        }
        "ask_bring_browser_to_front" => {
            let outside = runner::from_outside(&caller.id);
            match super::browser_profiles::bring_to_front(app, caller, args, outside).await {
                Ok(t) => text(t),
                Err(e) => error(e),
            }
        }
        super::policy_card::TOOL => super::policy_card::propose(app, caller, turn, args).await,
        _ => error("Unknown tool"),
    }
}

/// The tools a turn answering outside text (a "When…" routine's items)
/// can't use without the user's OK: they change the team, or set up work
/// that runs later on its own.
pub fn needs_card_in_routine_turn(tool: &str) -> bool {
    matches!(
        tool,
        "create_agent"
            | "update_agent"
            | "delete_agent"
            | "watch_for"
            | "schedule_check_in"
            | "create_room"
            | "add_to_room"
            | "remove_from_room"
    )
}

/// Why a card is asked for while an agent answers what a "When…" routine
/// found: in the user's words, no "turn" or "outside text".
pub(super) const OUTSIDE_WHY: &str = "It’s working on something a “When…” routine found, which came from outside this app, so it asks you first.";

/// The card for one of those, in a turn answering outside text.
fn outside_card(tool: &str, args: &Value) -> (String, String) {
    let why = OUTSIDE_WHY;
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
        Source::Custom { app, .. } => super::apps::display_name(app),
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
            "{when}.\n\nEach check uses a little of your Claude usage and can only read {app}: up to {per_day} a day. {cost}"
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
    let target =
        match arg(args, "agent") {
            None => caller.clone(),
            Some(t) => match store::find(t) {
                Ok(Some(a)) if a.id == caller.id || super::admin::admin_now(caller) => a,
                Ok(Some(_)) => return error(
                    "You can only change your own routines. Ask an admin, like the Chief of Staff.",
                ),
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
                    detail.push_str("\n\n");
                    detail.push_str(OUTSIDE_WHY);
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
            "Set up a “When…” routine for when {}: {} · {}",
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

/// `read_agent`: what an agent knows and waits on, without starting a turn.
fn read_agent(args: &Value) -> Value {
    let Some(name) = arg(args, "agent") else {
        return error("`agent` is required.");
    };
    match store::find(name) {
        Ok(Some(agent)) => text(super::team_setup::read_agent_text(&agent)),
        _ => error(format!(
            "There's no agent called {name}. list_agents shows who exists."
        )),
    }
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
    // Handing out work is capped per reply, and an agent that just came in
    // with an import stays quiet until the user says hi. An answer to an
    // agent that asked isn't new work.
    if !runner::owes(&caller.id, &target.id) {
        if let Err(why) = super::team_setup::admit(
            &caller.id,
            runner::turn_number(&caller.id),
            &target.id,
            &target.name,
            super::team_setup::is_quiet(&target.id),
        ) {
            return error(why);
        }
    }
    // Answering a request the target sent: settles it (see runner::settle).
    let answer = runner::settle(&caller.id, &target.id);
    let mut sent = runner::new_message(&caller.id, MessageKind::SentToAgent, body);
    sent.peer = Some(peer(&target));
    let _ = runner::record(app, sent);
    let mut received = runner::new_message(&target.id, MessageKind::FromAgent, body);
    received.peer = Some(peer(caller));
    let _ = runner::record(app, received);
    // Sent from a turn answering outside text: the taint goes with it, so
    // the recipient can't be talked into what the sender couldn't do.
    let outside = runner::from_outside(&caller.id);
    if answer {
        runner::enqueue_reply_from(
            app,
            &target.id,
            body.to_string(),
            peer(caller),
            hop,
            outside,
        );
        return text(format!("Delivered to {}.", target.name));
    }
    runner::enqueue_request(
        app,
        &target.id,
        body.to_string(),
        peer(caller),
        hop,
        outside,
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
    let caption = arg(args, "caption").unwrap_or("");
    let body = arg(args, "text").unwrap_or("");
    let shown = super::share_text::message_text(caption, body);
    // Tell the agent what the user actually got, so a bare label is never
    // mistaken for the text it was asked for.
    let with = if !body.trim().is_empty() {
        "with your text above it".to_string()
    } else if shown.is_empty() {
        "with no text".to_string()
    } else {
        format!("with only the label \"{shown}\" (no other text; if the user asked for the text, send it in `text`)")
    };
    let mut message = runner::new_message(&caller.id, MessageKind::Agent, shown);
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
                "Shared {name}, {with}. The user sees it in the chat as a file they can open; don't paste its contents as well."
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
    let mut draft = match results::parse(args) {
        Ok(draft) => draft,
        Err(e) => return error(e),
    };
    let Ok(home) = store::agent_home(&caller.id) else {
        return error("Couldn't find your folder.");
    };
    let roots = share_roots(&home).await;
    // A named project must be a real one: its card's Preview opens it.
    if let Some(wanted) = draft.project.take() {
        let projects: Vec<String> = roots[1..]
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let found = match crate::remote_access::tools::resolve_project(&projects, Some(&wanted)) {
            Ok(path) => Some(path),
            // A site the agent built in a folder of its own: the app lists
            // it as a project, where it can, rather than refusing the card.
            Err(_) => super::project::ensure_listed(app, &caller.id, &wanted).await,
        };
        match found {
            Some(path) => {
                super::dev_servers::note_shown_path(&caller.id, &path);
                if let Some(copy) = caller.copy.as_ref().filter(|c| c.project == path) {
                    super::dev_servers::note_shown_path(&caller.id, &copy.path);
                }
                draft.project = Some(path);
            }
            None => {
                return error(format!(
                    "There's no project called \"{wanted}\" (project_list has their names). Nothing was shared."
                ))
            }
        }
    }
    let live = super::broker::is_live(&caller.id, turn);
    if live {
        results::continue_checkpoint(&mut draft, results::checkpoint_of(&caller.id));
    }
    let delivery = results::delivery(live, draft.checkpoint);
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
    match delivery {
        results::Delivery::AtTurnEnd => {
            let replaced = results::stage(message);
            text(results::staged_reply(&card, replaced))
        }
        results::Delivery::Now | results::Delivery::Checkpoint => {
            let copies = message.clone();
            let recorded = if delivery == results::Delivery::Checkpoint {
                super::runner::record_in_turn(app, message)
            } else {
                super::runner::record(app, message)
            };
            match recorded {
                Ok(_) if delivery == results::Delivery::Checkpoint => {
                    results::note_checkpoint(&caller.id, &card.id);
                    text(results::checkpoint_reply(&card))
                }
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

/// The lines a create leaves: in the Chief's chat, and the new agent's first,
/// which says the engine it started on (`on`, see `View::started_on`): the
/// header's badge leaves Claude Code unsaid, and a fallback needs its reason.
fn create_notes(caller: &store::Agent, agent: &store::Agent, on: &str) -> Vec<store::AgentMessage> {
    vec![
        audit_note(
            &caller.id,
            created_line(&agent.name, &agent.role, agent.project.as_deref()),
            Some(peer(agent)),
        ),
        audit_note(
            &agent.id,
            format!("Created by {} {on}", caller.name),
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
    let picked = arg(args, "engine").is_some();
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
        avatar: None,
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
            let on = defaults.started_on(agent.engine, picked);
            for note in create_notes(caller, &agent, &on) {
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
                "Created {} {on}{started}. It's in the user's sidebar now.",
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
    let look = match look_args(&agent, args) {
        Ok(l) => l,
        Err(e) => return error(e),
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
        if let Some(avatar) = look.avatar.clone() {
            a.avatar = Some(avatar);
        }
        if let Some(c) = look.color.clone() {
            a.color = c;
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
    match look.line() {
        Some(line) => text(format!("Updated {}: {line}.", updated.name)),
        None => text(format!("Updated {}.", updated.name)),
    }
}

/// What `update_agent`'s `shape` / `face` / `color` change for this agent:
/// only what differs from what it wears now; the rest of its look stays.
/// Looks aren't settings, so this applies without a card.
#[derive(Debug, Default, PartialEq)]
pub(super) struct LookUpdate {
    /// Its whole new look, when the shape or face changes.
    pub avatar: Option<store::AgentLook>,
    pub color: Option<String>,
    shape_changed: bool,
    face_changed: bool,
}

impl LookUpdate {
    /// "now a hexagon with a curious face, in blue", for the tool's reply.
    pub fn line(&self) -> Option<String> {
        let a = self.avatar.as_ref();
        let desc = store::AgentLook::describe(
            a.filter(|_| self.shape_changed).map(|l| l.shape.as_str()),
            a.filter(|_| self.face_changed).map(|l| l.face.as_str()),
        );
        let what = match (self.shape_changed, desc.is_empty()) {
            (_, true) => String::new(),
            (false, false) => format!("now has {desc}"),
            (true, false) => format!("now {desc}"),
        };
        match (what.is_empty(), &self.color) {
            (false, Some(c)) => Some(format!("{what}, in {c}")),
            (false, None) => Some(what),
            (true, Some(c)) => Some(format!("now {c}")),
            (true, None) => None,
        }
    }
}

pub(super) fn look_args(agent: &store::Agent, args: &Value) -> Result<LookUpdate, String> {
    let key = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
    };
    let (shape, face, color) = (key("shape"), key("face"), key("color"));
    let now = store::AgentLook::of(agent);
    let mut out = LookUpdate::default();
    if shape.is_some() || face.is_some() {
        let next = store::AgentLook::checked(
            shape.as_deref().unwrap_or(&now.shape),
            face.as_deref().unwrap_or(&now.face),
        )?;
        out.shape_changed = next.shape != now.shape;
        out.face_changed = next.face != now.face;
        if out.shape_changed || out.face_changed {
            out.avatar = Some(next);
        }
    }
    if let Some(c) = color {
        if !store::COLORS.contains(&c.as_str()) {
            return Err(format!(
                "There's no colour called \"{c}\": {}.",
                store::COLORS.join(", ")
            ));
        }
        if c != agent.color {
            out.color = Some(c);
        }
    }
    Ok(out)
}

/// An admin's delete is a soft one: the agent leaves the team and waits in
/// Recently deleted for 30 days, restorable by the user (`admin::soft_delete`).
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
    match super::admin::soft_delete(app, caller, &agent).await {
        Ok(()) => text(format!(
            "Deleted {}. It's in Recently deleted for {} days: the user can restore it from Settings → Agents.",
            agent.name,
            store::TRASH_DAYS
        )),
        Err(e) => error(e.to_string()),
    }
}

/// A login card (`agents/logins.rs`). Nothing waits on it: connecting or
/// declining wakes the agent.
/// The access chain first (`access_chain`): a card only when nothing on
/// this Mac reaches it and nobody asked already.
async fn request_login(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let ask = super::logins::Ask::from_args(args);
    let tried = super::access_chain::Tried::from_args(args);
    let outside = runner::from_outside(&caller.id);
    match super::access_chain::request(app, caller, &ask, &tried, outside).await {
        Ok(reply) => text(reply),
        Err(e) => error(e.to_string()),
    }
}

/// A secure input card. Nothing waits on it: saving or declining wakes the
/// agent (see `commands::agents::agents_save_secret`), so a card answered
/// tomorrow works as well as one answered now.
fn request_secret(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    request_secret_as(app, caller, args, false)
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
    // Asked already in this task and nobody answered: not again.
    if super::expiry::already_expired(&caller.id, &super::expiry::secret_key(&request.name)) {
        return text(super::expiry::told_maybe_later(&request.name));
    }
    // An app the user chose not to connect isn't asked for by another door.
    if let Some(refused) =
        super::declined::refusal_for_text(&format!("{} {}", request.name, request.purpose))
    {
        return text(refused);
    }
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
    // The same ask expired unanswered earlier in this task: not raised again.
    let key = match call {
        Some((tool, input)) => super::expiry::tool_key(tool, input),
        None => super::expiry::ask_key(&title, &detail),
    };
    if super::expiry::already_expired(&caller.id, &key) {
        return Answer::NotYet;
    }
    let request_id = store::new_id();
    let (tx, rx) = oneshot::channel();
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), tx);

    let mut card = runner::new_message(&caller.id, MessageKind::Approval, "");
    let mut approval = new_card(request_id.clone(), title, detail, call);
    // `new_card` gave a tool call its plain line; a caller's own wins.
    if summary.is_some() {
        approval.summary = summary;
    }
    if call.is_some() {
        approval.from_outside =
            Some(runner::from_outside(&caller.id) || super::exposure::read_outside(&caller.id));
    }
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
    // An answered card was already written by the command. An unanswered
    // one expires now, into a one-line receipt, and isn't asked again in
    // this task (`agents/expiry.rs`). Closed before the waiter goes, so the
    // sweep never reads it as abandoned.
    if answer == Answer::NotYet {
        super::expiry::remember(&caller.id, key);
        if let Ok(Some(updated)) =
            store::expire_card(&caller.id, &request_id, super::expiry::Expiry::NoAnswer)
        {
            let _ = tauri::Emitter::emit(app, runner::EVENT_MESSAGE, &updated);
        }
        store::refresh_pending(&caller.id);
    }
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);
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
        Answer::NotYet => Some(format!("Don't {what} now. {}", super::expiry::TOLD)),
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
        // What it does and why, in words; the raw call goes behind Details.
        summary: call.and_then(|(tool, input)| super::admin::summary_for(tool, input, None)),
        note: None,
        prompt: None,
        choice: None,
        secret: None,
        connector: None,
        login: None,
        set_aside: None,
        expiry: None,
        from_outside: None,
        front: None,
        settings: None,
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
pub(super) fn mcp_title(tool: &str) -> String {
    let Some((server, name)) = tool.strip_prefix("mcp__").and_then(|t| t.split_once("__")) else {
        return format!("Use {tool}");
    };
    if let Some(title) = browser_tool_title(server, name) {
        return format!("{title} · {}", service_name(server));
    }
    // "tabs_context_mcp", "javascript_tool": the server's own suffix and the
    // word "tool" aren't words anyone says.
    let words: Vec<String> = split_words(name)
        .into_iter()
        .filter(|w| w != "mcp" && w != "tool")
        .collect();
    let Some((verb, object)) = words.split_first() else {
        return format!("Use {tool}");
    };
    // Not every tool's name starts with a verb ("tabs_context"): those read
    // "Use tabs context", never "Tabs a context".
    if !object.is_empty() && !TOOL_VERBS.contains(&verb.as_str()) {
        return format!("Use {} · {}", words.join(" "), service_name(server));
    }
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

/// Verbs an MCP tool's name usually starts with. A name that starts with
/// anything else is a noun phrase, said as "Use …".
const TOOL_VERBS: [&str; 44] = [
    "add", "append", "archive", "ask", "cancel", "check", "click", "close", "comment", "create",
    "delete", "download", "draft", "edit", "fetch", "fill", "find", "get", "invite", "label",
    "list", "load", "mark", "merge", "move", "open", "post", "publish", "query", "read", "remove",
    "reply", "run", "save", "schedule", "search", "send", "set", "share", "start", "stop",
    "submit", "update", "upload",
];

/// The browser extension's tools, in what they do to the page. Its names are
/// nouns ("computer", "javascript_tool", "tabs_context_mcp"), which the verb
/// rule turned into "Javascript a tool" and "Tabs a context".
fn browser_tool_title(server: &str, name: &str) -> Option<&'static str> {
    // The agents' browser (`agent_browser::tools`).
    if server == crate::agent_browser::tools::SERVER_KEY {
        return Some(match name {
            "open" => "Open a page in the agents' browser",
            "navigate" => "Go to a page in the agents' browser",
            "read_page" | "find" | "get_text" => "Read the page",
            "screenshot" => "Look at the page",
            "click" => "Click on the page",
            "type" => "Type on the page",
            "press" => "Press a key on the page",
            "scroll" => "Scroll the page",
            "wait_for" => "Wait for the page",
            "tabs" => "See its browser tabs",
            "close_tab" => "Close a tab",
            _ => return None,
        });
    }
    if !matches!(
        server.to_ascii_lowercase().as_str(),
        "claude-in-chrome" | "claude_in_chrome" | "chrome"
    ) {
        return None;
    }
    Some(match name {
        "computer" => "Click and type in the browser",
        "navigate" => "Open a page",
        "javascript_tool" => "Run a script on the page",
        "tabs_context_mcp" | "tabs_context" => "See its browser tabs",
        "tabs_create_mcp" | "tabs_create" => "Open a tab",
        "read_page" | "get_page_text" => "Read the page",
        "find" => "Find something on the page",
        "form_input" => "Fill in a form",
        "read_console_messages" => "Read the page's console",
        "read_network_requests" => "Read the page's network requests",
        "upload_image" => "Upload an image",
        "resize_window" => "Resize the browser window",
        "gif_creator" => "Record the screen",
        _ => return None,
    })
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

/// Whether a standing "Always allow" rule the user chose covers this call.
/// With a one-time grant from a late Allow, the only way past a card: no
/// setting (the independence level included) opens another.
fn always_allowed(caller: &store::Agent, tool: &str, input: &Value) -> bool {
    permissions::matching(&caller.permissions, tool, input).is_some()
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
    let decision = decide_inner(app, caller, tool, input, why).await;
    // Where its browser is now, for the next card's "on <site>, as …".
    if decision == Decision::Allow {
        super::browser::note_opened(&caller.id, tool, input);
        // Outside content it is about to read: the rest of the turn asks.
        super::exposure::note(&caller.id, tool, input);
    }
    // The connection relay lets an allowed call through once, so it doesn't
    // ask again (`conn_relay`).
    if decision == Decision::Allow && super::connections::is_connection_tool(tool) {
        super::connections::note_cleared(&caller.id, tool);
    }
    // The same for the agents' browser server.
    if decision == Decision::Allow && tool.starts_with(super::browser_gate::AGENTS_SERVER) {
        crate::agent_browser::tools::note_cleared(&caller.id, tool);
    }
    decision
}

/// A step in the agents' browser the browser gate said asks: a standing
/// "Always allow" rule answers it, else a card in the agents' browser's
/// words. Never the independence level: the gate already applied it.
async fn agents_browser_card(
    app: &AppHandle,
    caller: &store::Agent,
    tool: &str,
    input: &Value,
) -> Decision {
    if always_allowed(caller, tool, input) {
        let line = format!("{} · always allowed", one_line(tool, input));
        let _ = runner::record_in_turn(
            app,
            runner::new_message(&caller.id, MessageKind::Note, line),
        );
        return Decision::Allow;
    }
    let page = super::browser_gate::page_of(&super::browser_gate::agents_key(&caller.id));
    let (title, said) = super::browser_gate::describe_agents(tool, input, &page);
    let (_, detail) = describe_request(tool, input);
    let summary = Some(said).filter(|s| !s.trim().is_empty());
    match ask(app, caller, title, summary, detail, Some((tool, input))).await {
        Answer::Allowed => Decision::Allow,
        Answer::Denied(note) => Decision::Deny(denied(note)),
        Answer::NotYet => Decision::Deny(NOT_YET.to_string()),
    }
}

/// A call to the agents' browser server the engine didn't ask about (its
/// tools pre-approved, or an engine with no approval channel): decided
/// here, the same way. `Err` is what the agent is told.
pub(crate) async fn decide_agents_browser(
    app: &AppHandle,
    agent_id: &str,
    tool: &str,
    input: &Value,
) -> Result<(), String> {
    let caller = store::get(agent_id).map_err(|e| e.to_string())?;
    if take_grant(&caller.id, tool, input) {
        return Ok(());
    }
    match agents_browser_card(app, &caller, tool, input).await {
        Decision::Allow => Ok(()),
        Decision::Deny(why) => Err(why),
    }
}

/// A connection call the engine didn't ask about (`conn_relay`): the same
/// decision, made here. `Err` is what the agent is told.
pub(crate) async fn decide_relayed(
    app: &AppHandle,
    agent_id: &str,
    tool: &str,
    input: &Value,
) -> Result<(), String> {
    let caller = store::get(agent_id).map_err(|e| e.to_string())?;
    match decide_inner(app, &caller, tool, input, None).await {
        Decision::Allow => Ok(()),
        Decision::Deny(why) => Err(why),
    }
}

async fn decide_inner(
    app: &AppHandle,
    caller: &store::Agent,
    tool: &str,
    input: &Value,
    why: Option<&str>,
) -> Decision {
    if take_grant(&caller.id, tool, input) {
        return Decision::Allow;
    }
    // What the agent's settings allow (`policy`): a project or folder it
    // may not use, an app or the browser it was kept from, is refused
    // without a card; reading where it may read needs none.
    let eff = super::policy::effective(caller);
    match super::policy::verdict(&eff, caller, &super::policy::Places::current(), tool, input) {
        Some(super::policy::Verdict::Allow) => return Decision::Allow,
        Some(super::policy::Verdict::Deny(why)) => return Decision::Deny(why),
        None => {}
    }
    // A connection the user granted on a login card: reads go through
    // (except in a turn answering outside text), a read-only grant refuses
    // the rest (`connections::gate`).
    let outside = runner::from_outside(&caller.id);
    match super::connections::gate(&caller.id, tool, outside) {
        super::connections::Gate::Allow => return Decision::Allow,
        super::connections::Gate::Refuse(why) => return Decision::Deny(why),
        super::connections::Gate::Ask => {}
    }
    // The user's browser: reads on the sites it was given go through; any
    // other site, and every click, keystroke or form, asks (`browser::gate`).
    let browser_asks = match super::browser::gate(caller, tool, input, outside) {
        super::browser::Gate::Allow => return Decision::Allow,
        super::browser::Gate::Refuse(why) => return Decision::Deny(why),
        super::browser::Gate::Ask => true,
        super::browser::Gate::NotBrowser => false,
    };
    // The agents' browser has its own card words ("in the agents' browser").
    if tool.starts_with(super::browser_gate::AGENTS_SERVER) {
        return agents_browser_card(app, caller, tool, input).await;
    }
    if always_allowed(caller, tool, input) {
        // Nothing happens invisibly: each one leaves a quiet line in the chat.
        let line = format!("{} · always allowed", one_line(tool, input));
        let _ = runner::record_in_turn(
            app,
            runner::new_message(&caller.id, MessageKind::Note, line),
        );
        return Decision::Allow;
    }
    // Local work the user's independence level answers for them
    // (`autoallow`): a quiet line in the timeline, never invisible. Not a
    // browser step the browser gate said asks (a send, a payment, a script
    // that posts): "Go hard" still asks for those. In a turn that read
    // outside content, sending to the network or running a package new to
    // the project asks (`exposure`).
    let guarded = browser_asks
        || super::exposure::read_outside(&caller.id)
            && super::autoallow::Ctx::for_agent(caller)
                .is_none_or(|ctx| super::autoallow::after_outside_asks(tool, input, &ctx));
    if let Some(level) = auto_allowed(caller, tool, input, outside).filter(|_| !guarded) {
        super::work::on_step(
            &caller.id,
            super::work::StepKind::Approval,
            &auto_line(level, tool, input),
            store::now_ms(),
        );
        return Decision::Allow;
    }
    let (title, mut detail) = describe_request(tool, input);
    let why = why.map(str::trim).filter(|w| !w.is_empty());
    if let Some(why) = why {
        detail = format!("{detail}\n\n{why}");
    }
    // A browser card says what it would do in plain words ("Click “Send” on
    // mail.google.com"), where and as whom; the raw call stays behind Details.
    // Everything else leads with a plain what-and-why line.
    let (title, summary) = if tool.starts_with(super::browser_gate::SERVER) {
        let page = super::browser_gate::page_of(&caller.id);
        let (title, said) = super::browser_gate::describe(tool, input, &page);
        let mut summary = said;
        if let Some((_, where_)) = super::browser::card(&caller.id, tool, input) {
            summary = [summary, where_]
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
        }
        (title, Some(summary).filter(|s| !s.is_empty()))
    } else {
        (title, super::admin::summary_for(tool, input, why))
    };
    match ask(app, caller, title, summary, detail, Some((tool, input))).await {
        Answer::Allowed => {
            // A new package it installs asks once per project (`installs`).
            super::installs::remember_allowed(caller, tool, input);
            Decision::Allow
        }
        Answer::Denied(note) => Decision::Deny(denied(note)),
        Answer::NotYet => Decision::Deny(NOT_YET.to_string()),
    }
}

/// The level that answers this call without a card, if the user's does.
fn auto_allowed(
    caller: &store::Agent,
    tool: &str,
    input: &Value,
    outside: bool,
) -> Option<super::independence::Level> {
    // Its own level when its settings give it one (`policy`).
    let chosen = super::policy::chosen_level(caller);
    let ctx = super::autoallow::Ctx::for_agent(caller)?;
    super::autoallow::auto(chosen, outside, tool, input, &ctx)
        .map(|_| receipt_level(chosen, outside))
}

/// The level a receipt names: "Go hard" answers at its own level even for a
/// turn answering outside text (`go_hard`); the others as the turn runs.
fn receipt_level(chosen: super::independence::Level, outside: bool) -> super::independence::Level {
    if chosen == super::independence::Level::GoHard {
        chosen
    } else {
        super::independence::for_turn(chosen, outside)
    }
}

/// "Allowed automatically — Go hard · ls -la ~/Notes".
fn auto_line(level: super::independence::Level, tool: &str, input: &Value) -> String {
    format!(
        "Allowed automatically — {} · {}",
        level.short(),
        one_line(tool, input)
    )
}

/// When the user changes the level: first every card nothing waits on any
/// more closes (its turn ended: "Expired — the agent moved on", and an
/// overdue sign-in or secure input "Maybe later"; `expiry`), then each open
/// permission card the new level answers is allowed with a receipt line in
/// its chat and its waiting call goes through. Returns how many it allowed.
pub fn sweep_auto_allowed(app: &AppHandle) -> usize {
    super::expiry::sweep_all(app, super::expiry::Moment::Tick);
    let Ok(agents) = store::list() else {
        return 0;
    };
    let mut answered = 0;
    for agent in agents {
        // Each agent at its own level (`policy`): the team's unless it has one.
        let chosen = super::policy::chosen_level(&agent);
        if chosen == super::independence::Level::Often {
            continue;
        }
        let Ok(open) = store::pending_approvals(&agent.id) else {
            continue;
        };
        let Some(ctx) = super::autoallow::Ctx::for_agent(&agent) else {
            continue;
        };
        let browser_ok = |tool: &str, input: &Value, outside: bool| {
            super::browser::gate(&agent, tool, input, outside) == super::browser::Gate::Allow
        };
        let mut here = 0;
        for card in open {
            // Its turn ended between the expiry pass and here: the next
            // sweep closes it.
            if !is_waited_on(&card.request_id) {
                continue;
            }
            let Some(inside) = sweepable(chosen, &card, &ctx, &browser_ok) else {
                continue;
            };
            let (Some(tool), Some(input)) = (&card.tool, &card.input) else {
                continue;
            };
            let level = receipt_level(chosen, !inside);
            let Ok(Some(updated)) =
                store::set_approval_status(&agent.id, &card.request_id, ApprovalStatus::Allowed)
            else {
                continue;
            };
            answer_approval(&card.request_id, true);
            let _ = tauri::Emitter::emit(app, runner::EVENT_MESSAGE, &updated);
            let _ = runner::record(
                app,
                runner::new_message(&agent.id, MessageKind::Note, auto_line(level, tool, input)),
            );
            here += 1;
        }
        if here > 0 {
            store::refresh_pending(&agent.id);
        }
        answered += here;
    }
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    answered
}

/// Whether an open card is one the sweep answers: `Some(inside)` (whether
/// its turn was known not to answer outside text) when the level allows it:
/// local work and reads (`autoallow`), or a browser step the browser gate
/// lets through (`browser_ok(tool, input, outside)`). Login, secret,
/// session-question and import cards are never answered.
fn sweepable(
    chosen: super::independence::Level,
    card: &Approval,
    ctx: &super::autoallow::Ctx,
    browser_ok: &dyn Fn(&str, &Value, bool) -> bool,
) -> Option<bool> {
    let (Some(tool), Some(input)) = (&card.tool, &card.input) else {
        return None;
    };
    if chosen == super::independence::Level::Often
        || card.status != ApprovalStatus::Pending
        || card.login.is_some()
        || card.secret.is_some()
        || card.prompt.is_some()
        || card.connector.is_some()
    {
        return None;
    }
    let inside = card.from_outside == Some(false);
    if tool.starts_with(super::browser_gate::SERVER) {
        return browser_ok(tool, input, !inside).then_some(inside);
    }
    super::autoallow::auto(chosen, !inside, tool, input, ctx).map(|_| inside)
}

/// What the agent is told when the user said no.
pub(super) fn denied(note: Option<String>) -> String {
    match note {
        None => "The user said no to this. Don't retry it; tell them what you were trying to do, or find another way.".to_string(),
        Some(note) => format!("The user said no to this, and told you: \"{note}\". Don't retry it; do what they said instead."),
    }
}

/// What the agent is told when the card is still waiting.
pub(super) const NOT_YET: &str = super::expiry::TOLD;

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
        let notes = create_notes(&chief, &finance, "on Claude Code — Codex isn't signed in");
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|n| n.kind == MessageKind::Note));
        assert_eq!(notes[0].agent_id, "chief");
        assert_eq!(notes[0].text, "Created Finance · Invoices and the books");
        assert_eq!(notes[0].peer.as_ref().unwrap().id, "fin");
        assert_eq!(notes[1].agent_id, "fin");
        assert_eq!(
            notes[1].text,
            "Created by Chief of Staff on Claude Code — Codex isn't signed in"
        );
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

    /// "Go hard" changes what agents are told, never the wall: a call that
    /// spends, sends, publishes, pushes or deletes still gets a card, and
    /// the only ways past one are the user's own grant or Always-allow rule.
    #[test]
    fn spend_and_send_cards_still_appear_at_go_hard() {
        use super::super::independence::{self, Level};
        let _serial = store::tests_lock();
        let root = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(root.path().to_path_buf()));
        independence::set_level(Level::GoHard, 1).unwrap();
        assert_eq!(independence::level(), Level::GoHard);
        let agent = named("fin-gohard", "Finance");
        let calls = [
            (
                "mcp__gmail__send_email",
                json!({ "to": "sam@example.test", "body": "Hi" }),
            ),
            ("mcp__stripe__create_payment", json!({ "amount": 4900 })),
            (
                "mcp__slack__post_message",
                json!({ "channel": "#general", "text": "Done" }),
            ),
            ("Bash", json!({ "command": "git push origin main" })),
            ("Bash", json!({ "command": "rm -rf ~/Documents/old" })),
            ("Bash", json!({ "command": "gh pr review 248 --approve" })),
        ];
        for (tool, input) in &calls {
            assert!(!take_grant(&agent.id, tool, input), "{tool}");
            assert!(
                !always_allowed(&agent, tool, input),
                "{tool} goes to a card"
            );
            for outside in [false, true] {
                assert_eq!(
                    auto_allowed(&agent, tool, input, outside),
                    None,
                    "{tool} goes to a card at Go hard"
                );
            }
        }
        // Local work goes through at Go hard, with its receipt words.
        let ls = json!({ "command": "ls -la ~/FictionalFolder" });
        assert_eq!(
            auto_allowed(&agent, "Bash", &ls, false),
            Some(Level::GoHard)
        );
        // Outside text keeps Go hard for reading and local work (`go_hard`);
        // only network writes and fetched packages ask there.
        assert_eq!(auto_allowed(&agent, "Bash", &ls, true), Some(Level::GoHard));
        let mkdir = json!({ "command": "mkdir -p ~/FictionalProjects/new-site" });
        assert_eq!(
            auto_allowed(&agent, "Bash", &mkdir, false),
            Some(Level::GoHard)
        );
        assert_eq!(
            auto_allowed(&agent, "Bash", &mkdir, true),
            Some(Level::GoHard)
        );
        let fetched = json!({ "command": "npx some-fictional-package" });
        assert_eq!(auto_allowed(&agent, "Bash", &fetched, true), None);
        assert!(auto_line(Level::GoHard, "Bash", &mkdir)
            .starts_with("Allowed automatically — Go hard · mkdir -p"));
        independence::set_level(Level::Often, 2).unwrap();
        assert_eq!(auto_allowed(&agent, "Bash", &ls, false), None);
        store::set_root_for_tests(None);
    }

    #[test]
    fn the_sweep_answers_only_what_the_level_would_and_never_logins() {
        use super::super::autoallow::Ctx;
        use super::super::independence::Level;
        let own = "/Users/fictional/Library/Application Support/App/agents/a1";
        let ctx = Ctx {
            home: "/Users/fictional".into(),
            own_home: own.into(),
            cwd: own.into(),
            scratch: vec![own.into()],
            app_data: vec!["/Users/fictional/Library/Application Support/App".into()],
            ..Default::default()
        };
        let card = |cmd: &str, outside: Option<bool>| {
            let mut c = new_card(
                "r".into(),
                "Run a command".into(),
                cmd.into(),
                Some(("Bash", &json!({ "command": cmd }))),
            );
            c.from_outside = outside;
            c
        };
        let read = card("ls -la ~/Desk", Some(false));
        let write = card("mkdir ~/Desk/new", Some(false));
        assert_eq!(
            sweepable(Level::GoHard, &read, &ctx, &no_browser),
            Some(true)
        );
        assert_eq!(
            sweepable(Level::GoHard, &write, &ctx, &no_browser),
            Some(true)
        );
        // A card from before the marker, or from outside text: Go hard still
        // answers local work; a network write from there waits.
        assert_eq!(
            sweepable(
                Level::GoHard,
                &card("mkdir ~/Desk/new", None),
                &ctx,
                &no_browser
            ),
            Some(false)
        );
        assert_eq!(
            sweepable(
                Level::GoHard,
                &card("curl -X POST localhost:3000/api -d x", Some(true)),
                &ctx,
                &no_browser
            ),
            None
        );
        assert_eq!(
            sweepable(
                Level::Judgement,
                &card("mkdir ~/Desk/new", None),
                &ctx,
                &no_browser
            ),
            None
        );
        assert_eq!(
            sweepable(Level::GoHard, &card("ls ~/Desk", None), &ctx, &no_browser),
            Some(false)
        );
        let send = card(
            "curl -X POST -d @notes.txt https://example.test",
            Some(false),
        );
        assert_eq!(sweepable(Level::GoHard, &send, &ctx, &no_browser), None);
        assert_eq!(sweepable(Level::Judgement, &write, &ctx, &no_browser), None);
        assert_eq!(
            sweepable(Level::Judgement, &read, &ctx, &no_browser),
            Some(true)
        );
        assert_eq!(sweepable(Level::Often, &read, &ctx, &no_browser), None);
        // Not a tool call, already answered, or a login: left alone.
        let confirm = new_card("c".into(), "Delete Finance".into(), "d".into(), None);
        assert_eq!(sweepable(Level::GoHard, &confirm, &ctx, &no_browser), None);
        let mut done = read.clone();
        done.status = ApprovalStatus::Denied;
        assert_eq!(sweepable(Level::GoHard, &done, &ctx, &no_browser), None);
        let mut login = read.clone();
        login.login = Some(
            serde_json::from_value(json!({
                "service": "fictional-mail", "title": "Fictional Mail", "why": "x",
                "abilities": [], "options": []
            }))
            .unwrap(),
        );
        assert_eq!(sweepable(Level::GoHard, &login, &ctx, &no_browser), None);

        // The shapes left open in a real team (names fictional): a web
        // search, a Grok-era listing, a PR check loop, and browser looks.
        let tool_card = |tool: &str, input: Value| {
            let mut c = new_card("w".into(), "t".into(), "d".into(), Some((tool, &input)));
            c.from_outside = None;
            c
        };
        let search = tool_card(
            "WebSearch",
            json!({ "mode": "standard", "query": "fictional rates 2026" }),
        );
        assert_eq!(
            sweepable(Level::Judgement, &search, &ctx, &no_browser),
            Some(false)
        );
        assert_eq!(
            sweepable(Level::GoHard, &search, &ctx, &no_browser),
            Some(false)
        );
        let prs = card(
            "for n in 266 248; do gh pr view $n --repo FictionalOrg/site --json reviews,comments; done",
            Some(false),
        );
        assert_eq!(
            sweepable(Level::GoHard, &prs, &ctx, &no_browser),
            Some(true)
        );
        let approve = card("gh pr review 248 --approve", Some(false));
        assert_eq!(sweepable(Level::GoHard, &approve, &ctx, &no_browser), None);
        let look = tool_card(
            "mcp__claude-in-chrome__computer",
            json!({ "action": "screenshot", "tabId": 1 }),
        );
        let looks = |_: &str, i: &Value, _: bool| i["action"] == "screenshot";
        assert_eq!(sweepable(Level::GoHard, &look, &ctx, &looks), Some(false));
        assert_eq!(sweepable(Level::GoHard, &look, &ctx, &no_browser), None);
        assert_eq!(sweepable(Level::Often, &look, &ctx, &looks), None);
    }

    fn no_browser(_: &str, _: &Value, _: bool) -> bool {
        false
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
        // Real cards read "Javascript a tool · Chrome" and "Tabs a context
        // mcp · Chrome".
        assert_eq!(
            title("mcp__claude-in-chrome__javascript_tool"),
            "Run a script on the page · Chrome"
        );
        assert_eq!(
            title("mcp__claude-in-chrome__tabs_context_mcp"),
            "See its browser tabs · Chrome"
        );
        assert_eq!(
            title("mcp__claude-in-chrome__navigate"),
            "Open a page · Chrome"
        );
        // A noun-first name elsewhere is "Use …", never a made-up verb.
        assert_eq!(
            title("mcp__acme__ticket_history"),
            "Use ticket history · Acme"
        );
        assert_eq!(title("mcp__acme__render_tool"), "Render · Acme");
    }

    #[test]
    fn management_tools_are_hidden_from_regular_agents() {
        let agent = store::Agent {
            id: "a".into(),
            name: "Finance".into(),
            role: String::new(),
            shape: 0,
            avatar: None,
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
            reach: Default::default(),
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
