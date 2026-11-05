//! Persistence for Agents: the registry of agents and each agent's chat log.
//!
//! Layout, under this app's own support folder ([`crate::brand::app_support_dir`]),
//! never the shared `~/ShipStudio` that Ship Studio keeps its agents in:
//!
//! ```text
//! agents/
//!   agents.json              the registry (every agent's identity and state)
//!   <agent-id>/              the agent's home: its working directory
//!     CLAUDE.md              instructions + memory; Claude Code loads it every turn
//!     messages.jsonl         the conversation as the user sees it (append-only)
//!     approvals.jsonl        how its approval cards were answered
//!     turn.json, inbox.json  a turn in flight and what's queued behind it
//!     turns/<message-id>.json  what the turn ending on that message did (`work`)
//! ```
//!
//! The chat log is ours, not Claude Code's session file. It records exactly
//! what the user was shown — their messages, the agent's replies, the lines
//! where agents talked to each other, approval cards — so the UI never has to
//! reconstruct a conversation from a tool transcript it doesn't own.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use crate::errors::CommandError;

/// The avatar palette. Keys, not colours: the frontend maps each to a token,
/// so a theme change never leaves stale hex in someone's registry.
pub const COLORS: &[&str] = &[
    "white", "brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink", "gray",
];
/// Number of avatar shapes the frontend draws (indices `0..SHAPE_COUNT`).
pub const SHAPE_COUNT: u8 = 14;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// One line saying what this agent is for. Shown to other agents in
    /// `list_agents`, so the Chief of Staff can route work by it.
    #[serde(default)]
    pub role: String,
    pub shape: u8,
    pub color: String,
    /// The Chief of Staff: exactly one, created on first open, can't be deleted.
    #[serde(default)]
    pub is_main: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub hidden: bool,
    /// Claude Code session this agent resumes. `None` until its first turn.
    #[serde(default)]
    pub session_id: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub last_activity_at: i64,
    /// First line of the latest message, for the sidebar row.
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub unread: u32,
    /// Approval cards still waiting on the user. Kept here so the sidebar can
    /// say "Needs your OK" without reading every chat log.
    #[serde(default)]
    pub pending_approvals: u32,
    /// What its turns run on: Claude Code (the default) or Codex.
    #[serde(default)]
    pub engine: super::engine::Engine,
    /// Explicit model override (`--model` / `-m`), one its engine offers;
    /// `None` uses the engine's own default.
    #[serde(default)]
    pub model: Option<String>,
    /// It moved to another engine and hasn't had a turn there yet: the next
    /// turn starts a new session and is handed the recent conversation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub new_engine: bool,
    /// How full its current conversation is, as its engine last reported it.
    /// `None` when the engine doesn't say, or since a fresh start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<super::context::ContextFill>,
    /// No OS notifications for this agent. Unread and the Dock badge still count it.
    #[serde(default)]
    pub muted: bool,
    /// Check-ins and routines this agent is woken by (see `schedule`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub check_ins: Vec<super::schedule::CheckIn>,
    /// Tokens and cost of its turns, as Claude Code reported them.
    #[serde(default)]
    pub usage: super::usage::AgentUsage,
    /// "Always allow" rules: calls matching one skip the approval card.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<super::permissions::Rule>,
    /// The newest line in its chat is a failed turn: what kind. Cleared by
    /// anything said after it, so the sidebar can show a failure where it
    /// happened without reading the log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<super::failure::Failure>,
    /// The Ship Studio project this agent works in (its path, as `list_projects`
    /// gives it). A bound agent's turns run there, so the project's own
    /// CLAUDE.md and settings load; `None` runs in its home, as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Its open copy of that project (a git worktree on its own branch),
    /// where its turns run until the user keeps or discards the changes
    /// (see `task`). `None` when it has none open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<super::task::TaskCopy>,
    /// "Work directly in the project": no copy; its turns edit the user's
    /// own folder, as before copies existed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub work_directly: bool,
    /// What its last turn could use, as Claude Code itself listed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<super::capabilities::Capabilities>,
    /// What its routines run on: `None` is automatic (on Claude Code, Haiku
    /// while the agent itself is on the default model; otherwise its own
    /// model), `"same"` is always its own model, or one of its engine's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_model: Option<String>,
    /// Secrets it asked for and the user saved: names and references only.
    /// The values are in the Keychain (see `secrets`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<super::secrets::Secret>,
    /// The ready-made agent it was made from (`templates`), for its chat's
    /// first-open buttons. Its instructions are its own from then on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Browser access and the Claude Code apps it's kept from ("What it can
    /// reach"). Connections it may use are granted in `connections.json`.
    #[serde(default, skip_serializing_if = "AgentReach::is_empty")]
    pub reach: AgentReach,
    /// Fields a newer Ship Studio wrote that this build doesn't know: kept
    /// and written back as they were, so running an older build never
    /// strips what a newer one saved.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// What an agent may reach beyond its connections.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentReach {
    /// The user took its browser away: its Claude Code turns run `--no-chrome`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub browser_off: bool,
    /// Sites it was given the browser for on a login card (shown, and told
    /// to the agent; Claude in Chrome itself isn't limited by them).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub browser_sites: Vec<String>,
    /// Claude Code apps (by name there) kept from this agent's turns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_apps: Vec<String>,
}

impl AgentReach {
    pub fn is_empty(&self) -> bool {
        !self.browser_off && self.browser_sites.is_empty() && self.blocked_apps.is_empty()
    }
}

impl Agent {
    /// Move it to another engine from its next turn. A session can't cross
    /// engines, and neither can a model.
    pub fn switch_engine(&mut self, engine: super::engine::Engine) {
        if engine == self.engine {
            return;
        }
        self.engine = engine;
        self.model = None;
        self.routine_model = None;
        self.session_id = None;
        self.new_engine = true;
        self.capabilities = None;
        self.context = None;
    }

    /// Whether its next turn would continue a conversation: there is one to
    /// leave, or one it would be handed the recap of.
    pub fn has_conversation(&self) -> bool {
        self.session_id.is_some() || self.new_engine
    }

    /// Change the model its turns run on. A reading taken on another model
    /// is against that model's window, so it goes with the change.
    pub fn set_model(&mut self, model: Option<String>) {
        if self.model != model {
            self.context = None;
        }
        self.model = model;
    }

    /// Its next turn starts a new conversation on the same engine, with its
    /// instructions and memory (CLAUDE.md) and nothing else: no recap. The
    /// chat log is the user's and stays as it is.
    pub fn start_fresh(&mut self) {
        self.session_id = None;
        self.new_engine = false;
        self.context = None;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// The user wrote this.
    User,
    /// This agent said this to the user.
    Agent,
    /// This agent sent `text` to `peer` (rendered as "Messaged <peer>").
    SentToAgent,
    /// `peer` sent `text` to this agent (rendered as "Message from <peer>").
    FromAgent,
    /// A permission request the user answers inline.
    Approval,
    /// Something went wrong running the agent — shown, never hidden.
    Error,
    /// A scheduled check-in or routine fired; `text` is the note it left.
    CheckIn,
    /// A quiet line about something Ship Studio did on the agent's behalf
    /// ("npm test · always allowed", "Interrupted").
    /// With `peer`, the line names that agent ("Created Finance").
    Note,
    /// Files a project-bound agent's turn changed in its project (`changes`).
    Changes,
    /// The agent worked in a project's session (`session`): started one,
    /// sent it a message, its reply, or a preview screenshot.
    Session,
}

impl MessageKind {
    /// The kinds that are news for the user when they arrive off screen: they
    /// count as unread, and they are what the notifications slice raises a
    /// macOS notification for. A fired check-in is one — the user (or the
    /// agent, on their behalf) asked for it to happen at that time.
    pub fn wants_user(self) -> bool {
        matches!(
            self,
            Self::Agent | Self::Approval | Self::Error | Self::CheckIn
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Allowed,
    Denied,
    /// Nobody answered in time, or the app restarted while it waited.
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub request_id: String,
    /// What the agent wants to do, in a few words ("Run a command").
    pub title: String,
    /// The exact thing it will do (the command, the file, the URL).
    pub detail: String,
    /// A plain-English sentence the card leads with, when `detail` is raw
    /// (a push: branch, remote, commit ids). Present, the card shows this
    /// and keeps `detail` behind "Details".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub status: ApprovalStatus,
    /// The Claude Code tool and input this card is about. Present for
    /// permission prompts, which stay answerable after the agent stopped
    /// waiting (Claude Code abandons a prompt at 300s): a late Allow grants
    /// exactly this call and wakes the agent. Absent for Ship Studio's own
    /// confirmations (delete an agent), which only mean something while asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    /// What "Always allow" would cover, when the card may offer it. Only
    /// permission prompts get one; Ship Studio's own confirmations never do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always: Option<super::permissions::Scope>,
    /// Allowed by an "Always allow" rule (chosen on this card, or added on
    /// another card and covering this one), not just once.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub always_allowed: bool,
    /// What the user said when they declined, handed to the agent with the No.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// A question a project session is waiting on (a folder-trust dialog, a
    /// permission prompt, a menu), answered with keys sent to that session.
    /// The same card can sit in more than one chat (`agents/decisions.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<super::decisions::SessionPrompt>,
    /// The option the user picked on a `prompt` card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    /// A secure input card (`request_secret`): what it asks for. Saving it
    /// sends the value to the Keychain, never into this log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<super::secrets::Request>,
    /// One of the import connector's cards (`agents/review.rs`): another
    /// assistant asking to start an import, or the agents it proposed,
    /// staged for the user to review. Nothing is created until they answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<super::review::ConnectorCard>,
    /// A login card (`request_login`, `agents/logins.rs`): which app, what
    /// it may do, and the ways in. No credential is ever on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<super::logins::LoginRequest>,
    /// Closed by the app rather than answered (status `expired`), with the
    /// line saying why: a request from work that was replaced, such as the
    /// check-in after an import that "Setting up your team" took over
    /// (`agents/team_setup.rs`). Nothing it asked for ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_aside: Option<String>,
    /// Whether the turn that raised this permission card was answering
    /// outside text. Absent on cards from before it was recorded, which are
    /// treated as if it was (`mcp::sweep_auto_allowed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_outside: Option<bool>,
    /// "Bring your work Chrome window to the front" (`browser_profiles`):
    /// answered with Check again or Not now, never a login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub front: Option<super::browser_profiles::Front>,
    /// Closed by the app because nobody answered (`agents/expiry.rs`): the
    /// agent moved on, the wait ran out, or a sign-in became "Maybe later".
    /// Status is `expired`; the card reads as a one-line receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry: Option<super::expiry::Expiry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub agent_id: String,
    pub ts: i64,
    pub kind: MessageKind,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    /// Files sent with a user message. Absent in logs written before attachments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<super::attachments::Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_in: Option<super::schedule::CheckInMark>,
    /// A reply cut off by Stop (or a turn that died mid-sentence): what had
    /// streamed by then, kept rather than thrown away.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
    /// Agents the user @mentioned in this message, as they were named then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<AgentRef>,
    /// On an `error` line: what kind of failure, for the remedy it offers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<super::failure::Failure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<super::project::ChangeSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<super::sessions::SessionMark>,
    /// On a user message sent from a phone: its send's `clientId`, so the
    /// phone swaps its optimistic bubble by id. Absent everywhere else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// What the turn that ended on this message did (`agents::work`). Never in
    /// `messages.jsonl`: it is kept beside it, in `turns/<id>.json`, and added on read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<super::work::TurnWork>,
    /// On a `note`: the conversation started fresh here (memory kept), drawn
    /// as a divider. Older builds show it as the plain note it also is.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fresh: bool,
    /// A result card (`share_result`, `agents/results.rs`): on an `agent`
    /// message of its own, or on the turn's `changes` card when the turn
    /// also changed a project. Older builds show the text and attachments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<super::results::ResultCard>,
    /// On a user message: "Ask for changes" on this result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revises: Option<super::results::ResultRef>,
    /// On a `note`: a take-over's terminal closed by itself, early or
    /// failing, with its last lines after a blank line. Not a turn's
    /// failure: quiet, no Retry. (Older builds wrote it as an `error`.)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub takeover: bool,
    /// Said in a room (`agents::rooms`), not in this agent's own chat: the
    /// room's id. On an agent's line it is also copied into the room's log;
    /// the agent's own chat folds it into one "In <room>" line. On a line
    /// that only the room has (the user's message, a room note) `agent_id`
    /// is empty. Older builds show it in the agent's chat as ordinary lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    /// On an admin's `agent` message (`bring_to_user`, `agents/admin.rs`):
    /// other agents' requests only the user can decide, each answerable in
    /// place with Allow / Deny (the answer goes to that agent's card). Older
    /// builds show the text alone; the cards are still in each agent's chat.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decide: Vec<super::admin::DecideItem>,
}

/// `agents.json`. Read and written losslessly: an entry this build can't
/// read (a newer build's, or a bad hand edit) is hidden but written back
/// untouched, and so are top-level keys it doesn't know. An older build must
/// never delete an agent a newer one saved.
#[derive(Debug, Default)]
struct Registry {
    agents: Vec<Agent>,
    unreadable: Vec<serde_json::Value>,
    extra: serde_json::Map<String, serde_json::Value>,
}

impl Registry {
    /// `None` when the JSON isn't a registry at all.
    fn from_value(value: serde_json::Value) -> Option<Registry> {
        let serde_json::Value::Object(mut extra) = value else {
            return None;
        };
        let entries = match extra.remove("agents") {
            None => Vec::new(),
            Some(serde_json::Value::Array(entries)) => entries,
            Some(_) => return None,
        };
        let mut registry = Registry {
            extra,
            ..Registry::default()
        };
        for entry in entries {
            match serde_json::from_value::<Agent>(entry.clone()) {
                Ok(agent) => registry.agents.push(agent),
                Err(e) => {
                    tracing::warn!("[Agents] keeping an agent entry this build can't read: {e}");
                    registry.unreadable.push(entry);
                }
            }
        }
        Some(registry)
    }

    fn to_value(&self) -> Result<serde_json::Value, CommandError> {
        let mut entries = Vec::with_capacity(self.agents.len() + self.unreadable.len());
        for agent in &self.agents {
            entries.push(serde_json::to_value(agent).map_err(|e| super::err_other(e.to_string()))?);
        }
        entries.extend(self.unreadable.iter().cloned());
        let mut out = self.extra.clone();
        out.insert("agents".into(), serde_json::Value::Array(entries));
        Ok(serde_json::Value::Object(out))
    }
}

/// One lock around every registry read-modify-write. The registry is small
/// and written rarely; serialising access is simpler than being clever.
static REGISTRY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Test hook: point the store somewhere disposable.
static ROOT_OVERRIDE: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// The store has process-wide state; tests touching it run one at a time.
#[cfg(test)]
pub fn tests_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
pub fn set_root_for_tests(path: Option<PathBuf>) {
    *ROOT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = path;
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn agents_root() -> Result<PathBuf, CommandError> {
    if let Some(root) = ROOT_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok(root);
    }
    // Our own app-support folder, never the shared `~/ShipStudio/.shipstudio`:
    // Ship Studio keeps its agents there, and the two apps' agents are not
    // the same team.
    Ok(crate::brand::app_support_dir().join("agents"))
}

pub fn agent_home(id: &str) -> Result<PathBuf, CommandError> {
    validate_id(id)?;
    Ok(agents_root()?.join(id))
}

/// Ids are generated by us (hex), but they arrive back from the frontend and
/// from MCP calls, and they become path segments.
fn validate_id(id: &str) -> Result<(), CommandError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(super::err_invalid("agentId", "not a valid agent id"));
    }
    Ok(())
}

fn registry_path() -> Result<PathBuf, CommandError> {
    Ok(agents_root()?.join("agents.json"))
}

fn read_registry() -> Result<Registry, CommandError> {
    let path = registry_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    match serde_json::from_str(&raw) {
        Ok(value) => match Registry::from_value(value) {
            Some(registry) => Ok(registry),
            None => recover_registry(&path, "not an agents registry"),
        },
        Err(e) => recover_registry(&path, &e.to_string()),
    }
}

/// The registry isn't JSON (a crash or a full disk mid-write, or a bad hand
/// edit). Load the copy kept beside it on every write, rather than every
/// agent vanishing. (Valid JSON with an entry this build can't read is not
/// damage: see [`Registry`].) The damaged file is kept aside first, because
/// the recovered one replaces it.
fn recover_registry(path: &Path, why: &str) -> Result<Registry, CommandError> {
    let Some(recovered) = std::fs::read_to_string(path.with_extension("json.bak"))
        .ok()
        .and_then(|b| serde_json::from_str(&b).ok())
        .and_then(Registry::from_value)
    else {
        return Err(super::err_other(format!(
            "The agents registry at {} is unreadable: {why}",
            path.display()
        )));
    };
    let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
    std::fs::copy(path, &aside).map_err(|e| super::err_io(e.to_string()))?;
    tracing::error!(
        "[Agents] registry unreadable ({why}); recovered {} agents, damaged copy kept at {}",
        recovered.agents.len(),
        aside.display()
    );
    write_registry(&recovered)?;
    Ok(recovered)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    write_private(&tmp, bytes).map_err(|e| super::err_io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| super::err_io(e.to_string()))
}

/* ------------------------------------------------------- permissions */

// An agent's folder holds its instructions, its memory, what it was told and
// what it said: the owner's alone. Folders 0700, files 0600, on every write
// we make, and fixed at startup for anything an older build (or the agent's
// own CLI, which writes CLAUDE.md with the default umask) left wider.

/// Create `dir` (and parents) and make it owner-only.
pub(crate) fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write `bytes` to `path` as an owner-only file (0600 whatever it was).
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    restrict_file(path)
}

/// 0600 an existing file (`mode` on open applies only when it's created).
pub(crate) fn restrict_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)?.permissions().mode();
        if mode & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o700))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// At startup: the agents folder and every agent's folder 0700, every file
/// in them (two levels: `agents.json`, `<id>/CLAUDE.md`, `<id>/messages.jsonl`
/// …) owner-only. Deeper folders are unreachable once these are 0700.
pub fn harden_permissions() {
    let Ok(root) = agents_root() else { return };
    harden_tree(&root, 2);
}

fn harden_tree(dir: &Path, depth: usize) {
    if !dir.is_dir() {
        return;
    }
    let _ = ensure_private_dir(dir);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth > 1 {
            harden_tree(&entry.path(), depth - 1);
        } else if kind.is_file() {
            let _ = restrict_file(&entry.path());
        }
    }
}

/// Written twice: the copy is what [`recover_registry`] falls back on if the
/// main file is ever torn.
fn write_registry(registry: &Registry) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(&registry.to_value()?)
        .map_err(|e| super::err_other(e.to_string()))?;
    let path = registry_path()?;
    write_atomic(&path, &json)?;
    if let Err(e) = write_atomic(&path.with_extension("json.bak"), &json) {
        tracing::warn!("[Agents] registry backup not written: {e}");
    }
    Ok(())
}

/// The colour an agent created as the registry's `index`-th entry gets: the
/// one it asked for if it's in the palette, otherwise the next spread colour.
/// The paste preview calls this too, so its badges are the ones import makes.
pub fn color_for(requested: Option<&str>, index: usize) -> String {
    match requested {
        Some(c) if COLORS.contains(&c) => c.to_string(),
        // Spread new agents across the palette instead of making them all purple.
        _ => COLORS[(index * 7 + 3) % COLORS.len()].to_string(),
    }
}

pub fn list() -> Result<Vec<Agent>, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(read_registry()?.agents)
}

pub fn get(id: &str) -> Result<Agent, CommandError> {
    list()?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))
}

/// Find an agent the way another agent names it: by id, or by name ignoring case.
pub fn find(name_or_id: &str) -> Result<Option<Agent>, CommandError> {
    let needle = name_or_id.trim();
    let agents = list()?;
    if let Some(found) = agents.iter().find(|a| a.id == needle) {
        return Ok(Some(found.clone()));
    }
    Ok(agents
        .into_iter()
        .find(|a| a.name.eq_ignore_ascii_case(needle)))
}

/// Read-modify-write one agent under the registry lock.
pub fn update<F: FnOnce(&mut Agent)>(id: &str, change: F) -> Result<Agent, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    let agent = registry
        .agents
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))?;
    change(agent);
    let updated = agent.clone();
    write_registry(&registry)?;
    Ok(updated)
}

pub struct NewAgent {
    pub name: String,
    pub role: String,
    pub instructions: String,
    pub shape: Option<u8>,
    pub color: Option<String>,
    pub is_main: bool,
}

/// A character that starts a new line where a model reads text, though it
/// isn't a control character: Unicode's line and paragraph separators
/// (Zl, Zp).
pub fn breaks_line(c: char) -> bool {
    matches!(c, '\u{2028}' | '\u{2029}')
}

pub fn validate_name(name: &str) -> Result<String, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(super::err_invalid("name", "Give the agent a name."));
    }
    if name.chars().count() > 40 {
        return Err(super::err_invalid(
            "name",
            "Keep the name under 40 characters.",
        ));
    }
    if name.chars().any(|c| c.is_control() || breaks_line(c)) {
        return Err(super::err_invalid("name", "Keep the name on one line."));
    }
    // "@everyone" in a room means every member (`agents::rooms`).
    if name.eq_ignore_ascii_case("everyone") {
        return Err(super::err_invalid(
            "name",
            "\"Everyone\" means every member of a room. Pick another name.",
        ));
    }
    Ok(name.to_string())
}

/// The `--model` values offered: Claude Code's own aliases, which always
/// resolve to the current model of that family. `None` is Claude Code's default.
pub const MODELS: [&str; 3] = ["opus", "sonnet", "haiku"];

/// The cheap model a Claude Code agent's routines fall back to (see
/// [`Agent::routine_model`]). Codex has no such fallback: which of its models
/// is cheaper isn't something Codex says, so a Codex agent's routines run on
/// its own model unless the user picks one.
pub const ROUTINE_MODEL: &str = "haiku";

impl Agent {
    /// The model for a turn woken by one of its routines. A routine fires
    /// again and again, usually hours after the last turn (so nothing is
    /// cached either way), and is mostly checking: a Claude Code agent on the
    /// default model runs them on Haiku unless the user chose otherwise.
    pub fn routine_model(&self) -> Option<&str> {
        match self.routine_model.as_deref() {
            None if self.engine == super::engine::Engine::Claude => {
                Some(self.model.as_deref().unwrap_or(ROUTINE_MODEL))
            }
            None | Some("same") => self.model.as_deref(),
            Some(m) => Some(m),
        }
    }
}

/// A routine model setting from the UI: `""` automatic, `"same"`, or one of
/// the engine's own models.
pub fn normalize_routine_model(
    engine: super::engine::Engine,
    model: &str,
) -> Result<Option<String>, CommandError> {
    match model.trim() {
        "same" => Ok(Some("same".to_string())),
        other => super::engine::normalize_model(engine, other),
    }
}

/// A `--model` value: empty means Claude Code's default; anything else must
/// be one of [`MODELS`]. It becomes a CLI argument, so nothing else gets through.
pub fn normalize_model(model: &str) -> Result<Option<String>, CommandError> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if !MODELS.contains(&model) {
        return Err(super::err_invalid(
            "model",
            "Pick Opus, Sonnet, Haiku or Engine's default (no model).",
        ));
    }
    Ok(Some(model.to_string()))
}

pub fn create(new: NewAgent) -> Result<Agent, CommandError> {
    let name = validate_name(&new.name)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    if registry
        .agents
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&name))
    {
        return Err(super::err_invalid(
            "name",
            format!("There's already an agent called {name}."),
        ));
    }
    if new.is_main && registry.agents.iter().any(|a| a.is_main) {
        return Err(CommandError::expected("There's already a Chief of Staff."));
    }
    let index = registry.agents.len();
    let color = color_for(new.color.as_deref(), index);
    let shape = new
        .shape
        .filter(|s| *s < SHAPE_COUNT)
        .unwrap_or((index as u8 * 5 + 1) % SHAPE_COUNT);
    let now = now_ms();
    let agent = Agent {
        id: new_id(),
        name,
        role: new.role.trim().to_string(),
        shape,
        color,
        is_main: new.is_main,
        // The one agent you're told to talk to stays put at the top; unpinnable.
        pinned: new.is_main,
        hidden: false,
        session_id: None,
        created_at: now,
        last_activity_at: now,
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
    let home = agents_root()?.join(&agent.id);
    ensure_private_dir(&home).map_err(|e| super::err_io(e.to_string()))?;
    write_instructions(&home, &agent, &new.instructions)?;
    registry.agents.push(agent.clone());
    write_registry(&registry)?;
    Ok(agent)
}

/// Writes the app itself has made to each CLAUDE.md (instructions, memory),
/// so a turn's `runner::MemorySeal` can tell the user's edits from the turn's.
static CLAUDE_MD_WRITES: LazyLock<Mutex<HashMap<PathBuf, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn note_claude_md_write(path: &Path) {
    *CLAUDE_MD_WRITES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(path.to_path_buf())
        .or_default() += 1;
}

pub fn claude_md_writes(path: &Path) -> u64 {
    CLAUDE_MD_WRITES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .copied()
        .unwrap_or(0)
}

/// Put a CLAUDE.md back as it was.
pub fn restore_claude_md(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    write_atomic(path, bytes)
}

/// CLAUDE.md is the agent's own file: instructions on top, a memory section it
/// maintains below. Rewriting instructions keeps whatever it has remembered.
pub fn write_instructions(
    home: &Path,
    agent: &Agent,
    instructions: &str,
) -> Result<(), CommandError> {
    let path = home.join("CLAUDE.md");
    let existing = std::fs::read_to_string(&path).ok();
    let memory = existing
        .as_deref()
        .and_then(|existing| {
            super::memory::section_start(existing).map(|i| existing[i..].to_string())
        })
        .unwrap_or_else(|| format!("{}\n\n{}\n", super::memory::HEADING, super::memory::INTRO));
    // An imported agent's "Where you are now" is the app's, not part of its
    // instructions: it stays above them, as it was.
    let arrival = existing
        .as_deref()
        .and_then(super::arrival::section_text)
        .unwrap_or_default();
    let role = if agent.role.is_empty() {
        String::new()
    } else {
        format!("{}\n\n", agent.role)
    };
    let body = instructions.trim();
    let instructions = if body.is_empty() {
        String::new()
    } else {
        format!("## Instructions\n\n{body}\n\n")
    };
    let content = format!("# {}\n\n{role}{arrival}{instructions}{memory}", agent.name);
    note_claude_md_write(&path);
    write_atomic(&path, content.as_bytes())
}

pub fn read_instructions(id: &str) -> Result<String, CommandError> {
    let path = agent_home(id)?.join("CLAUDE.md");
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    Ok(instructions_of(&raw))
}

/// The `## Instructions` section of a CLAUDE.md, as [`write_instructions`] lays it out.
pub fn instructions_of(raw: &str) -> String {
    let start = raw
        .find("## Instructions")
        .map(|i| i + "## Instructions".len());
    let Some(start) = start else {
        return String::new();
    };
    let end = super::memory::section_start(raw)
        .filter(|&i| i >= start)
        .unwrap_or(raw.len());
    raw[start..end].trim().to_string()
}

/// Add an agent brought over whole from another app (`other_app`): its id,
/// avatar and settings as they were there. Refused if the id or the name is
/// already taken, or it would be a second Chief of Staff. Its home must
/// already be in place.
pub fn insert_imported(mut agent: Agent) -> Result<Agent, CommandError> {
    validate_id(&agent.id)?;
    agent.name = validate_name(&agent.name)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    if registry.agents.iter().any(|a| a.id == agent.id) {
        return Err(CommandError::expected("That agent is already here."));
    }
    if registry
        .agents
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&agent.name))
    {
        return Err(super::err_invalid(
            "name",
            format!("There's already an agent called {}.", agent.name),
        ));
    }
    if agent.is_main {
        return Err(CommandError::expected("There's already a Chief of Staff."));
    }
    registry.agents.push(agent.clone());
    write_registry(&registry)?;
    Ok(agent)
}

/// Write a small file beside the registry, atomically (the import ledger).
pub(crate) fn write_beside(name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    write_atomic(&agents_root()?.join(name), bytes)
}

pub fn delete(id: &str) -> Result<Agent, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    let index = registry
        .agents
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))?;
    if registry.agents[index].is_main {
        return Err(CommandError::expected(
            "The Chief of Staff can't be deleted.",
        ));
    }
    let removed = registry.agents.remove(index);
    write_registry(&registry)?;
    // It leaves its rooms; the rooms stay, with what it said in them.
    super::rooms::forget_agent(&removed.id);
    super::secrets::forget_all(&removed);
    super::connections::forget_agent(&removed.id);
    super::work::forget_agent(&removed.id);
    if let Ok(log) = log_path(&removed.id) {
        forget_pending(&log);
    }
    // The home goes with it: its memory and chat are the agent (and the
    // timelines kept under its replies, in `turns/`).
    let home = agents_root()?.join(&removed.id);
    if home.exists() {
        let _ = crate::utils::remove_dir_all_robust(&home);
    }
    Ok(removed)
}

/* ------------------------------------------------------ recently deleted */

/// Where a soft-deleted agent waits to be restored or purged: its home is
/// moved under here and its registry entry is kept, whole, in [`TRASH_FILE`].
pub const TRASH_DIR: &str = "recently-deleted";
pub const TRASH_FILE: &str = "recently-deleted.json";

/// One agent in "Recently deleted": its registry entry exactly as it was
/// (unknown fields and all), when, and who deleted it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub agent: serde_json::Value,
    pub deleted_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_by: Option<AgentRef>,
}

impl Deleted {
    pub fn id(&self) -> &str {
        self.agent.get("id").and_then(|v| v.as_str()).unwrap_or("")
    }
    pub fn name(&self) -> &str {
        self.agent
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    }
}

pub fn trashed() -> Vec<Deleted> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_trash()
}

fn read_trash() -> Vec<Deleted> {
    agents_root()
        .ok()
        .and_then(|r| std::fs::read(r.join(TRASH_FILE)).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_trash(items: &[Deleted]) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(items).map_err(super::err_other)?;
    write_atomic(&agents_root()?.join(TRASH_FILE), &json)
}

/// Take an agent out of the team without destroying anything: its entry and
/// its home (memory, chat, timelines) are kept for [`restore`]. Its secrets,
/// connections and copy stay where they are until it's purged. The Chief of
/// Staff can't be deleted.
pub fn soft_delete(id: &str, by: Option<AgentRef>) -> Result<Agent, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    let index = registry
        .agents
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))?;
    if registry.agents[index].is_main {
        return Err(CommandError::expected(
            "The Chief of Staff can't be deleted.",
        ));
    }
    let root = agents_root()?;
    let trash = root.join(TRASH_DIR);
    std::fs::create_dir_all(&trash).map_err(|e| super::err_io(e.to_string()))?;
    let home = root.join(id);
    let kept = trash.join(id);
    if kept.exists() {
        let _ = crate::utils::remove_dir_all_robust(&kept);
    }
    if home.exists() {
        std::fs::rename(&home, &kept).map_err(|e| super::err_io(e.to_string()))?;
    }
    let removed = registry.agents.remove(index);
    let entry = serde_json::to_value(&removed).map_err(super::err_other)?;
    let mut items = read_trash();
    items.retain(|d| d.id() != id);
    items.push(Deleted {
        agent: entry,
        deleted_at: now_ms(),
        deleted_by: by,
    });
    if let Err(e) = write_trash(&items) {
        // Never lose it: put the home back and leave the registry alone.
        let _ = std::fs::rename(&kept, &home);
        return Err(e);
    }
    write_registry(&registry)?;
    if let Ok(log) = log_path(id) {
        forget_pending(&log);
    }
    Ok(removed)
}

/// Bring a soft-deleted agent back as it was. Its name is kept unless another
/// agent took it meanwhile, in which case " (restored)" is added.
pub fn restore(id: &str) -> Result<Agent, CommandError> {
    validate_id(id)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut items = read_trash();
    let index = items
        .iter()
        .position(|d| d.id() == id)
        .ok_or_else(|| CommandError::expected("That agent isn't in Recently deleted any more."))?;
    let mut agent: Agent = serde_json::from_value(items[index].agent.clone())
        .map_err(|e| super::err_other(e.to_string()))?;
    let mut registry = read_registry()?;
    if registry.agents.iter().any(|a| a.id == id) {
        return Err(CommandError::expected("That agent is already on the team."));
    }
    if registry
        .agents
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&agent.name))
    {
        agent.name = format!("{} (restored)", agent.name);
    }
    let root = agents_root()?;
    let kept = root.join(TRASH_DIR).join(id);
    let home = root.join(id);
    if kept.exists() && !home.exists() {
        std::fs::rename(&kept, &home).map_err(|e| super::err_io(e.to_string()))?;
    }
    registry.agents.push(agent.clone());
    write_registry(&registry)?;
    items.remove(index);
    write_trash(&items)?;
    Ok(agent)
}

/// How long a soft-deleted agent can be restored.
pub const TRASH_DAYS: i64 = 30;

/// The trash entries older than [`TRASH_DAYS`], taken out of the list (their
/// folders are removed); the caller forgets what else they held.
pub fn take_expired(now: i64) -> Vec<Agent> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let items = read_trash();
    let cutoff = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
    let (old, keep): (Vec<_>, Vec<_>) = items.into_iter().partition(|d| d.deleted_at < cutoff);
    if old.is_empty() || write_trash(&keep).is_err() {
        return Vec::new();
    }
    let root = agents_root().ok();
    old.into_iter()
        .filter_map(|d| {
            if let (Some(root), Ok(())) = (&root, validate_id(d.id())) {
                let _ = crate::utils::remove_dir_all_robust(&root.join(TRASH_DIR).join(d.id()));
            }
            serde_json::from_value(d.agent).ok()
        })
        .collect()
}

/* ------------------------------------------------------------- chat log */

fn log_path(agent_id: &str) -> Result<PathBuf, CommandError> {
    Ok(agent_home(agent_id)?.join("messages.jsonl"))
}

/// How approval cards were answered, one line per answer, beside the log
/// (`approvals.jsonl`). The log itself is only ever appended to: answering a
/// card used to rewrite every message the agent had, under a lock every
/// other agent's appends waited on.
fn answers_path(agent_id: &str) -> Result<PathBuf, CommandError> {
    Ok(agent_home(agent_id)?.join("approvals.jsonl"))
}

/// One agent's log lock. Appends from concurrent turns of the *same* agent
/// must not interleave; different agents never wait on each other.
fn log_lock(agent_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .clone()
}

/// An answer to an approval card, applied over the card when the log is read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    request_id: String,
    status: ApprovalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    always: Option<super::permissions::Scope>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    always_allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_aside: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expiry: Option<super::expiry::Expiry>,
}

impl Answer {
    fn apply(&self, approval: &mut Approval) {
        approval.status = self.status;
        if self.always.is_some() {
            approval.always = self.always.clone();
        }
        approval.always_allowed |= self.always_allowed;
        approval.note = self.note.clone();
        if self.choice.is_some() {
            approval.choice = self.choice.clone();
        }
        if self.set_aside.is_some() {
            approval.set_aside = self.set_aside.clone();
        }
        if self.expiry.is_some() {
            approval.expiry = self.expiry;
        }
    }
}

/// Append one JSON line, never fused onto a torn last line.
pub(crate) fn append_line<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    // Every line goes through redaction: a secret's value never lands on disk.
    let mut value = serde_json::to_value(value).map_err(|e| super::err_other(e.to_string()))?;
    super::secrets::redact_value(&mut value);
    let mut line = serde_json::to_string(&value).map_err(|e| super::err_other(e.to_string()))?;
    line.push('\n');
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| super::err_io(e.to_string()))?;
    // A crash mid-append leaves a last line with no newline. Appending straight
    // after it would fuse this line into that broken one and lose it too.
    if !ends_with_newline(&mut file) {
        line.insert(0, '\n');
    }
    file.write_all(line.as_bytes())
        .map_err(|e| super::err_io(e.to_string()))
}

pub fn append_message(message: &AgentMessage) -> Result<(), CommandError> {
    let lock = log_lock(&message.agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    ensure_home(&message.agent_id)?;
    let log = log_path(&message.agent_id)?;
    let before = pending_stamp(&message.agent_id)?;
    append_line(&log, message)?;
    if message.approval.is_some() {
        // A new card: read back from the log (redacted, answers applied) next time.
        forget_pending(&log);
    } else {
        // Nothing for the cache, but the log grew by this line: still current.
        restamp_pending(&message.agent_id, before);
    }
    Ok(())
}

/// The agent's folder, which a write to its log never brings back: an agent
/// deleted while its turn was still finishing stays deleted (its chat was
/// the user's to delete). A registered agent whose folder went missing gets
/// it back.
fn ensure_home(agent_id: &str) -> Result<(), CommandError> {
    let home = agent_home(agent_id)?;
    if home.is_dir() {
        return Ok(());
    }
    if get(agent_id).is_err() {
        return Err(CommandError::expected("That agent no longer exists."));
    }
    ensure_private_dir(&home).map_err(|e| super::err_io(e.to_string()))
}

/// Whether the agent is gone: not in the registry, and no folder.
pub fn is_gone(agent_id: &str) -> bool {
    agent_home(agent_id).is_ok_and(|h| !h.is_dir()) && get(agent_id).is_err()
}

/* ------------------------------------------------- pending approvals cache */

/// Each agent's pending cards, as last read from its log, with the sizes of
/// the log and `approvals.jsonl` they were read at. Cards are only added by
/// appends and answered by answer lines, both written here under the log
/// lock, so the cache follows them; anything else that changes either file
/// changes its size, and the next read starts over. Keyed by the log's path.
struct PendingCache {
    stamp: (u64, u64),
    cards: Vec<AgentMessage>,
}

static PENDING: LazyLock<Mutex<HashMap<PathBuf, PendingCache>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// The sizes of the agent's log and answers, as they are now.
fn pending_stamp(agent_id: &str) -> Result<(u64, u64), CommandError> {
    Ok((
        file_len(&log_path(agent_id)?),
        file_len(&answers_path(agent_id)?),
    ))
}

fn forget_pending(log: &Path) {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(log);
}

/// After a write of our own that changed no card: the cache, if it was
/// current at `before`, is current now.
fn restamp_pending(agent_id: &str, before: (u64, u64)) {
    let (Ok(log), Ok(now)) = (log_path(agent_id), pending_stamp(agent_id)) else {
        return;
    };
    let mut cache = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    match cache.get_mut(&log) {
        Some(entry) if entry.stamp == before => entry.stamp = now,
        Some(_) => {
            cache.remove(&log);
        }
        None => {}
    }
}

/// The agent's pending cards, answers applied; from the cache while the
/// files are as it read them. Call with the log lock held.
fn pending_cards(agent_id: &str) -> Result<Vec<AgentMessage>, CommandError> {
    let log = log_path(agent_id)?;
    // Sized before reading: a write in between makes the next read start over.
    let stamp = pending_stamp(agent_id)?;
    if let Some(entry) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).get(&log) {
        if entry.stamp == stamp {
            return Ok(entry.cards.clone());
        }
    }
    let cards: Vec<AgentMessage> = cards(agent_id, None)?
        .into_iter()
        .filter(|m| {
            m.approval
                .as_ref()
                .is_some_and(|a| a.status == ApprovalStatus::Pending)
        })
        .collect();
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).insert(
        log,
        PendingCache {
            stamp,
            cards: cards.clone(),
        },
    );
    Ok(cards)
}

/// Put another conversation's lines (already JSON, one message each) in
/// front of this agent's log as one block, after `divider` (a note line
/// saying where they came from), and its card answers into `approvals.jsonl`.
/// The one place a log is rewritten rather than appended to: an import
/// bringing a whole earlier conversation, which appended would read as if it
/// all happened after this one, and which interleaved by time would
/// alternate two unrelated conversations line by line.
///
/// Idempotent: a line whose `id` is already in the log is left out, an
/// answer line already in `approvals.jsonl` isn't added again, and with
/// nothing new the divider isn't written either. Returns how many lines
/// were added. Written atomically.
pub fn prepend_log_block(
    agent_id: &str,
    divider: Option<String>,
    lines: Vec<String>,
    answers: Vec<String>,
) -> Result<usize, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path(agent_id)?;
    forget_pending(&path);
    let existing = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(super::err_io(e)),
    };
    let id_of = |l: &str| {
        serde_json::from_str::<serde_json::Value>(l)
            .ok()
            .and_then(|v| {
                v.get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
    };
    let mut have: std::collections::HashSet<String> = existing.lines().filter_map(id_of).collect();
    let fresh: Vec<String> = lines
        .into_iter()
        .map(|l| l.trim_end_matches(['\r', '\n']).to_string())
        .filter(|l| !l.trim().is_empty())
        .filter(|l| match id_of(l) {
            Some(id) => have.insert(id),
            None => !existing.lines().any(|e| e == l),
        })
        .collect();
    if !fresh.is_empty() {
        let mut out = String::with_capacity(existing.len());
        if let Some(divider) = divider {
            out.push_str(divider.trim_end_matches(['\r', '\n']));
            out.push('\n');
        }
        for line in &fresh {
            out.push_str(line);
            out.push('\n');
        }
        for line in existing.lines().filter(|l| !l.trim().is_empty()) {
            out.push_str(line);
            out.push('\n');
        }
        write_atomic(&path, out.as_bytes())?;
    }
    if !answers.is_empty() {
        let answers_path = answers_path(agent_id)?;
        let mut raw = std::fs::read_to_string(&answers_path).unwrap_or_default();
        let before: std::collections::HashSet<String> = raw.lines().map(str::to_string).collect();
        let len = raw.len();
        if !raw.is_empty() && !raw.ends_with('\n') {
            raw.push('\n');
        }
        for line in answers
            .iter()
            .map(|l| l.trim_end_matches(['\r', '\n']))
            .filter(|l| !l.trim().is_empty() && !before.contains(*l))
        {
            raw.push_str(line);
            raw.push('\n');
        }
        if raw.len() != len {
            write_atomic(&answers_path, raw.as_bytes())?;
        }
    }
    Ok(fresh.len())
}

/// True for an empty file, or one whose last byte is a newline.
fn ends_with_newline(file: &mut std::fs::File) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    if file.seek(SeekFrom::End(-1)).is_err() {
        return true;
    }
    let mut last = [0u8; 1];
    file.read_exact(&mut last).is_err() || last[0] == b'\n'
}

fn read_text(path: &Path) -> Result<String, CommandError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(super::err_io(e.to_string())),
    }
}

/// Messages read from the end of the log backwards, oldest first, until
/// `enough` is satisfied by what has been read or the log runs out. Opening a
/// long chat, or paging back through it, costs what it shows, not the whole
/// history. A torn line is skipped. Answers are not applied here.
pub(crate) fn read_back(
    path: &Path,
    mut enough: impl FnMut(&[AgentMessage]) -> bool,
) -> Result<Vec<AgentMessage>, CommandError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    let mut start = file
        .metadata()
        .map_err(|e| super::err_io(e.to_string()))?
        .len();
    let mut chunk_len: u64 = 64 * 1024;
    // Bytes before the first newline read so far: a line cut by the chunk edge.
    let mut carry: Vec<u8> = Vec::new();
    let mut read: Vec<AgentMessage> = Vec::new();
    while start > 0 {
        let from = start.saturating_sub(chunk_len);
        let mut buf = vec![0u8; (start - from) as usize];
        file.seek(SeekFrom::Start(from))
            .and_then(|_| file.read_exact(&mut buf))
            .map_err(|e| super::err_io(e.to_string()))?;
        buf.extend_from_slice(&carry);
        start = from;
        // Unless this reaches the file's start, its first line may be cut.
        let whole_from = if start == 0 {
            0
        } else {
            match buf.iter().position(|b| *b == b'\n') {
                Some(at) => at + 1,
                None => {
                    carry = buf;
                    chunk_len = chunk_len.saturating_mul(2);
                    continue;
                }
            }
        };
        carry = buf[..whole_from].to_vec();
        let text = String::from_utf8_lossy(&buf[whole_from..]);
        let mut older: Vec<AgentMessage> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        older.append(&mut read);
        read = older;
        if enough(&read) {
            break;
        }
        chunk_len = chunk_len.saturating_mul(2);
    }
    Ok(read)
}

fn read_answers(agent_id: &str) -> Result<HashMap<String, Answer>, CommandError> {
    Ok(read_text(&answers_path(agent_id)?)?
        .lines()
        .filter_map(|l| serde_json::from_str::<Answer>(l).ok())
        .map(|a| (a.request_id.clone(), a))
        .collect())
}

/// Parse log lines (a torn one is skipped rather than failing the chat) and
/// apply the answers given since each card was written.
fn parse_log<'a>(
    agent_id: &str,
    lines: impl Iterator<Item = &'a str>,
) -> Result<Vec<AgentMessage>, CommandError> {
    let mut log: Vec<AgentMessage> = lines.filter_map(|l| serde_json::from_str(l).ok()).collect();
    apply_answers(agent_id, &mut log)?;
    Ok(log)
}

/// Apply `approvals.jsonl` over the cards among `log`.
pub(crate) fn apply_answers(agent_id: &str, log: &mut [AgentMessage]) -> Result<(), CommandError> {
    if log.iter().any(|m| m.approval.is_some()) {
        let answers = read_answers(agent_id)?;
        for approval in log.iter_mut().filter_map(|m| m.approval.as_mut()) {
            if let Some(answer) = answers.get(&approval.request_id) {
                answer.apply(approval);
            }
        }
    }
    Ok(())
}

/// The approval cards in an agent's log, answers applied. Only lines that
/// can be cards are parsed.
fn cards(agent_id: &str, request_id: Option<&str>) -> Result<Vec<AgentMessage>, CommandError> {
    let raw = read_text(&log_path(agent_id)?)?;
    let lines = raw
        .lines()
        .filter(|l| l.contains("\"requestId\"") && request_id.is_none_or(|id| l.contains(id)));
    Ok(parse_log(agent_id, lines)?
        .into_iter()
        .filter(|m| {
            m.approval
                .as_ref()
                .is_some_and(|a| request_id.is_none_or(|id| a.request_id == id))
        })
        .collect())
}

/// The newest `limit` messages, oldest first.
pub fn messages(agent_id: &str, limit: usize) -> Result<Vec<AgentMessage>, CommandError> {
    messages_page(agent_id, limit, None, None)
}

/// A page of the log, oldest first: the `limit` messages before the one with
/// id `before` (all of them if it's absent), reaching further back to include
/// `through` when that is older, but never more than `cap` in all. A `before`
/// that isn't in the log yields nothing rather than a page from elsewhere.
/// Read from the log's end, only as far back as the page needs.
pub fn messages_page(
    agent_id: &str,
    limit: usize,
    before: Option<&str>,
    through: Option<(&str, usize)>,
) -> Result<Vec<AgentMessage>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path(agent_id)?;
    let end_of = |read: &[AgentMessage]| match before {
        Some(id) => read.iter().position(|m| m.id == id),
        None => Some(read.len()),
    };
    let mut all = if limit == usize::MAX {
        let raw = read_text(&path)?;
        raw.lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    } else {
        read_back(&path, |read| {
            let Some(end) = end_of(read) else {
                return false;
            };
            // A `through` further back than the cap still caps the page at
            // `cap`, but only once it's known to be there: read back to it.
            end >= limit && through.is_none_or(|(id, _)| read[..end].iter().any(|m| m.id == id))
        })?
    };
    let end = end_of(&all).unwrap_or(0);
    let mut start = end.saturating_sub(limit);
    if let Some((id, cap)) = through {
        if let Some(at) = all[..start].iter().position(|m| m.id == id) {
            start = at.max(end.saturating_sub(cap));
        }
    }
    all.truncate(end);
    let mut page = all.split_off(start);
    apply_answers(agent_id, &mut page)?;
    Ok(page)
}

/// Set an approval's outcome.
pub fn set_approval_status(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(agent_id, request_id, status, None, None, None)
}

/// Answer a session-prompt card with the option the user picked.
pub fn answer_prompt(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
    choice: &str,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(agent_id, request_id, status, None, None, Some(choice))
}

/// Decline a pending card with what the user said, which the agent is handed too.
pub fn deny_with_note(
    agent_id: &str,
    request_id: &str,
    note: &str,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(
        agent_id,
        request_id,
        ApprovalStatus::Denied,
        None,
        Some(note),
        None,
    )
}

/// Allow a pending card under an "Always allow" rule, so it says so and
/// names the rule (which may be broader than what the card itself offered).
pub fn allow_always(
    agent_id: &str,
    request_id: &str,
    rule: &super::permissions::Scope,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(
        agent_id,
        request_id,
        ApprovalStatus::Allowed,
        Some(rule),
        None,
        None,
    )
}

/// Answer a card once: an answer line is appended, the log isn't touched.
/// Returns the card as it now reads, or `None` if it was already answered.
fn resolve_approval(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
    rule: Option<&super::permissions::Scope>,
    note: Option<&str>,
    choice: Option<&str>,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval_as(agent_id, request_id, status, rule, note, choice, None, None)
}

/// Close a pending card nobody answered (`agents/expiry.rs`), saying how.
pub fn expire_card(
    agent_id: &str,
    request_id: &str,
    expiry: super::expiry::Expiry,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval_as(
        agent_id,
        request_id,
        ApprovalStatus::Expired,
        None,
        None,
        None,
        None,
        Some(expiry),
    )
}

/// Close a pending card without an answer from the user, saying why
/// (`Approval::set_aside`). It reads as expired to anything that doesn't
/// know the field, so nothing it asked for can run from it.
pub fn set_aside(
    agent_id: &str,
    request_id: &str,
    why: &str,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval_as(
        agent_id,
        request_id,
        ApprovalStatus::Expired,
        None,
        None,
        None,
        Some(why),
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_approval_as(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
    rule: Option<&super::permissions::Scope>,
    note: Option<&str>,
    choice: Option<&str>,
    set_aside: Option<&str>,
    expiry: Option<super::expiry::Expiry>,
) -> Result<Option<AgentMessage>, CommandError> {
    let lock = log_lock(agent_id);
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = pending_cards(agent_id)?;
    let before = pending_stamp(agent_id)?;
    let mut changed = None;
    if let Some(message) = all.iter_mut().find(|m| {
        m.approval
            .as_ref()
            .is_some_and(|a| a.request_id == request_id && a.status == ApprovalStatus::Pending)
    }) {
        let answer = Answer {
            request_id: request_id.to_string(),
            status,
            always: rule.cloned(),
            always_allowed: rule.is_some(),
            note: note.map(str::to_string),
            choice: choice.map(str::to_string),
            set_aside: set_aside.map(str::to_string),
            expiry,
        };
        append_line(&answers_path(agent_id)?, &answer)?;
        if let Some(approval) = message.approval.as_mut() {
            answer.apply(approval);
        }
        changed = Some(message.clone());
    }
    let pending = count_pending(&all);
    if changed.is_some() {
        // The cache follows the answer it just wrote.
        let log = log_path(agent_id)?;
        let now = pending_stamp(agent_id)?;
        let mut cache = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        match cache.get_mut(&log) {
            Some(entry) if entry.stamp == before => {
                entry.stamp = now;
                entry.cards = all
                    .iter()
                    .filter(|m| {
                        m.approval
                            .as_ref()
                            .is_some_and(|a| a.status == ApprovalStatus::Pending)
                    })
                    .cloned()
                    .collect();
            }
            _ => {
                cache.remove(&log);
            }
        }
    }
    drop(guard);
    let _ = update(agent_id, |a| a.pending_approvals = pending);
    if changed.is_some() {
        // The turn that raised it, if it's still running, says what the answer was.
        super::work::on_answer(agent_id, request_id, status);
    }
    Ok(changed)
}

fn count_pending(log: &[AgentMessage]) -> u32 {
    log.iter()
        .filter(|m| {
            m.approval
                .as_ref()
                .is_some_and(|a| a.status == ApprovalStatus::Pending)
        })
        .count() as u32
}

/// Recount an agent's pending cards (after one is added).
pub fn refresh_pending(agent_id: &str) {
    let pending = {
        let lock = log_lock(agent_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        pending_cards(agent_id)
            .map(|log| count_pending(&log))
            .unwrap_or(0)
    };
    let _ = update(agent_id, |a| a.pending_approvals = pending);
}

/// Mark a pending card expired, with a line saying why (a secret card
/// moved onto a login card).
pub fn expire_with_note(
    agent_id: &str,
    request_id: &str,
    note: &str,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(
        agent_id,
        request_id,
        ApprovalStatus::Expired,
        None,
        Some(note),
        None,
    )
}

/// Every login card in an agent's log, answered or not, oldest first.
pub fn login_cards(agent_id: &str) -> Vec<AgentMessage> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    cards(agent_id, None)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.approval.as_ref().is_some_and(|a| a.login.is_some()))
        .collect()
}

/// The card with this request id, as it reads now (answers applied).
pub fn card(agent_id: &str, request_id: &str) -> Option<AgentMessage> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(open) = pending_cards(agent_id).ok()?.into_iter().find(|m| {
        m.approval
            .as_ref()
            .is_some_and(|a| a.request_id == request_id)
    }) {
        return Some(open);
    }
    cards(agent_id, Some(request_id)).ok()?.into_iter().next()
}

pub fn find_approval(agent_id: &str, request_id: &str) -> Result<Option<Approval>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(open) = pending_cards(agent_id)?
        .into_iter()
        .filter_map(|m| m.approval)
        .find(|a| a.request_id == request_id)
    {
        return Ok(Some(open));
    }
    Ok(cards(agent_id, Some(request_id))?
        .into_iter()
        .find_map(|m| m.approval))
}

/// The messages holding cards still waiting on an answer, oldest first.
pub fn pending_card_messages(agent_id: &str) -> Result<Vec<AgentMessage>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    pending_cards(agent_id)
}

/// The cards still waiting on an answer, oldest first.
pub fn pending_approvals(agent_id: &str) -> Result<Vec<Approval>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    Ok(pending_cards(agent_id)?
        .into_iter()
        .filter_map(|m| m.approval)
        .collect())
}

/// On startup nothing is waiting on an approval any more: the process that
/// asked is gone. Leftovers close as "the agent moved on" (sign-ins as
/// "Maybe later"), so no card offers a button that can't do anything and
/// nothing keeps asking (`agents/expiry.rs`). A secure input still young can
/// be saved later; an import's own cards carry everything they show.
pub fn expire_stale_approvals() {
    let Ok(agents) = list() else { return };
    for agent in agents {
        super::expiry::sweep_store(&agent.id, super::expiry::Moment::Launch, now_ms(), &|_| {
            false
        });
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn agent_folders_and_files_are_owner_only_and_fixed_when_wider() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("agents");
        let home = root.join("a1");
        // What we write is private from the start.
        write_atomic(&root.join("agents.json"), b"{}").unwrap();
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&root.join("agents.json")), 0o600);
        append_line(&home.join("messages.jsonl"), &serde_json::json!({"x": 1})).unwrap();
        assert_eq!(mode(&home), 0o700);
        assert_eq!(mode(&home.join("messages.jsonl")), 0o600);
        // What an older build (or the CLI) left wider is fixed.
        std::fs::write(home.join("CLAUDE.md"), "# a").unwrap();
        std::fs::set_permissions(
            home.join("CLAUDE.md"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        harden_tree(&root, 2);
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&home), 0o700);
        assert_eq!(mode(&home.join("CLAUDE.md")), 0o600);
        // An owner-executable file keeps its x bit; only group/other go.
        std::fs::write(home.join("run.sh"), "#!/bin/sh").unwrap();
        std::fs::set_permissions(home.join("run.sh"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        harden_tree(&root, 2);
        assert_eq!(mode(&home.join("run.sh")), 0o700);
    }

    use super::*;

    #[test]
    fn routines_run_on_haiku_only_while_the_agent_is_on_the_default_model() {
        let agent = |model: Option<&str>, routine: Option<&str>| -> Agent {
            let mut a: Agent = serde_json::from_value(serde_json::json!({
                "id": "a", "name": "A", "shape": 0, "color": "red", "createdAt": 0
            }))
            .unwrap();
            a.model = model.map(str::to_string);
            a.routine_model = routine.map(str::to_string);
            a
        };
        assert_eq!(agent(None, None).routine_model(), Some("haiku"));
        assert_eq!(agent(Some("opus"), None).routine_model(), Some("opus"));
        assert_eq!(agent(None, Some("same")).routine_model(), None);
        assert_eq!(
            agent(Some("opus"), Some("same")).routine_model(),
            Some("opus")
        );
        assert_eq!(
            agent(Some("opus"), Some("sonnet")).routine_model(),
            Some("sonnet")
        );
        let claude = super::super::engine::Engine::Claude;
        assert_eq!(normalize_routine_model(claude, "").unwrap(), None);
        assert_eq!(
            normalize_routine_model(claude, "same").unwrap().as_deref(),
            Some("same")
        );
        assert!(normalize_routine_model(claude, "--danger").is_err());
        assert!(normalize_routine_model(super::super::engine::Engine::Codex, "haiku").is_err());
    }

    #[test]
    fn a_codex_agents_routines_never_run_on_haiku() {
        let mut a: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "A", "shape": 0, "color": "red", "createdAt": 0, "engine": "codex"
        }))
        .unwrap();
        assert_eq!(a.routine_model(), None);
        a.model = Some("gpt-5.5".into());
        assert_eq!(a.routine_model(), Some("gpt-5.5"));
        a.routine_model = Some("gpt-5.6-luna".into());
        assert_eq!(a.routine_model(), Some("gpt-5.6-luna"));
        a.switch_engine(super::super::engine::Engine::Claude);
        assert_eq!(a.routine_model, None);
        assert_eq!(a.routine_model(), Some("haiku"));
    }

    fn with_root<F: FnOnce()>(f: F) {
        let _serial = tests_lock();
        let dir = tempfile::tempdir().unwrap();
        set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        set_root_for_tests(None);
    }

    fn new(name: &str) -> NewAgent {
        NewAgent {
            name: name.into(),
            role: "Does things".into(),
            instructions: "Be brief.".into(),
            shape: None,
            color: None,
            is_main: false,
        }
    }

    #[test]
    fn pages_back_through_the_log() {
        with_root(|| {
            let a = create(new("Pager")).unwrap();
            for i in 0..10 {
                append_message(&AgentMessage {
                    id: format!("m{i}"),
                    agent_id: a.id.clone(),
                    ts: i,
                    // Session lines page like any other line.
                    kind: if i % 3 == 0 {
                        MessageKind::Session
                    } else {
                        MessageKind::User
                    },
                    text: format!("line {i}"),
                    peer: None,
                    approval: None,
                    attachments: Vec::new(),
                    check_in: None,
                    stopped: false,
                    mentions: Vec::new(),
                    failure: None,
                    changes: None,
                    session: (i % 3 == 0).then(|| crate::agents::sessions::SessionMark {
                        project: "/p".into(),
                        event: crate::agents::sessions::SessionEvent::Sent,
                        session_id: Some("s1".into()),
                        tab: Some(1),
                        cli: Some("claude".into()),
                    }),
                    client_id: None,
                    work: None,
                    fresh: false,
                    result: None,
                    revises: None,
                    takeover: false,
                    room: None,
                    decide: Vec::new(),
                })
                .unwrap();
            }
            let ids = |v: Vec<AgentMessage>| v.into_iter().map(|m| m.id).collect::<Vec<_>>();
            assert_eq!(ids(messages(&a.id, 3).unwrap()), ["m7", "m8", "m9"]);
            assert_eq!(
                ids(messages_page(&a.id, 3, Some("m7"), None).unwrap()),
                ["m4", "m5", "m6"]
            );
            assert_eq!(
                ids(messages_page(&a.id, 2, Some("m1"), None).unwrap()),
                ["m0"]
            );
            // A search hit further back: everything from it to the cursor.
            assert_eq!(
                ids(messages_page(&a.id, 2, Some("m7"), Some(("m2", 100))).unwrap()),
                ["m2", "m3", "m4", "m5", "m6"]
            );
            // A hit inside the page changes nothing; the cap still holds.
            assert_eq!(
                ids(messages_page(&a.id, 3, Some("m7"), Some(("m5", 100))).unwrap()),
                ["m4", "m5", "m6"]
            );
            assert_eq!(
                ids(messages_page(&a.id, 2, None, Some(("m0", 4))).unwrap()),
                ["m6", "m7", "m8", "m9"]
            );
            assert!(messages_page(&a.id, 3, Some("gone"), None)
                .unwrap()
                .is_empty());
        });
    }

    #[test]
    fn pages_read_from_the_end_carry_their_answers() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            // Long enough to span several read chunks; every 50th line a card.
            let filler = "x".repeat(300);
            for i in 0..2000 {
                let mut line = note(&a.id, &format!("{i} {filler}"));
                line.id = format!("m{i}");
                if i % 50 == 0 {
                    line.kind = MessageKind::Approval;
                    line.approval = Some(Approval {
                        request_id: format!("r{i}"),
                        title: "Run a command".into(),
                        detail: "ls".into(),
                        status: ApprovalStatus::Pending,
                        tool: None,
                        input: None,
                        always: None,
                        always_allowed: false,
                        summary: None,
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
                    });
                }
                append_message(&line).unwrap();
            }
            set_approval_status(&a.id, "r100", ApprovalStatus::Allowed)
                .unwrap()
                .unwrap();
            deny_with_note(&a.id, "r150", "use the staging bucket")
                .unwrap()
                .unwrap();
            set_approval_status(&a.id, "r1950", ApprovalStatus::Denied)
                .unwrap()
                .unwrap();

            let full = messages(&a.id, usize::MAX).unwrap();
            assert_eq!(full.len(), 2000);
            let ids = |v: &[AgentMessage]| v.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
            let status = |v: &[AgentMessage], rid: &str| {
                v.iter()
                    .filter_map(|m| m.approval.as_ref())
                    .find(|c| c.request_id == rid)
                    .map(|c| (c.status, c.note.clone()))
            };

            // The newest page: the answer is applied.
            let newest = messages(&a.id, 60).unwrap();
            assert_eq!(ids(&newest), ids(&full[1940..]));
            assert_eq!(
                status(&newest, "r1950"),
                Some((ApprovalStatus::Denied, None))
            );

            // Paged far back from the end: same lines a full read gives, answers applied.
            let page = messages_page(&a.id, 80, Some("m180"), None).unwrap();
            assert_eq!(ids(&page), ids(&full[100..180]));
            assert_eq!(status(&page, "r100"), Some((ApprovalStatus::Allowed, None)));
            assert_eq!(
                status(&page, "r150"),
                Some((
                    ApprovalStatus::Denied,
                    Some("use the staging bucket".into())
                ))
            );
            assert_eq!(status(&page, "r50"), None);
            assert_eq!(
                page.iter().find(|m| m.id == "m100"),
                full.iter().find(|m| m.id == "m100")
            );

            // Reaching back to a search hit, capped.
            let reach = messages_page(&a.id, 10, Some("m1990"), Some(("m150", 5000))).unwrap();
            assert_eq!(ids(&reach), ids(&full[150..1990]));
            assert_eq!(
                status(&reach, "r150"),
                Some((
                    ApprovalStatus::Denied,
                    Some("use the staging bucket".into())
                ))
            );
            let capped = messages_page(&a.id, 10, Some("m1990"), Some(("m150", 300))).unwrap();
            assert_eq!(ids(&capped), ids(&full[1690..1990]));
        });
    }

    #[test]
    fn creates_lists_and_finds_by_name_case_insensitively() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            assert_eq!(list().unwrap().len(), 1);
            assert_eq!(find("finance").unwrap().unwrap().id, a.id);
            assert_eq!(find(&a.id).unwrap().unwrap().name, "Finance");
            assert!(find("Nobody").unwrap().is_none());
        });
    }

    #[test]
    fn refuses_duplicate_names_and_a_second_main() {
        with_root(|| {
            create(new("Finance")).unwrap();
            assert!(create(new("FINANCE")).is_err());
            let mut main = new("Chief of Staff");
            main.is_main = true;
            create(main).unwrap();
            let mut again = new("Other Chief");
            again.is_main = true;
            assert!(create(again).is_err());
        });
    }

    #[test]
    fn the_main_agent_cannot_be_deleted() {
        with_root(|| {
            let mut main = new("Chief of Staff");
            main.is_main = true;
            let chief = create(main).unwrap();
            assert!(delete(&chief.id).is_err());
            let other = create(new("Finance")).unwrap();
            delete(&other.id).unwrap();
            assert!(!agents_root().unwrap().join(&other.id).exists());
        });
    }

    #[test]
    fn rewriting_instructions_keeps_memory() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            let home = agent_home(&a.id).unwrap();
            let path = home.join("CLAUDE.md");
            let with_memory =
                std::fs::read_to_string(&path).unwrap() + "- Julian's accountant is Sam.\n";
            std::fs::write(&path, with_memory).unwrap();
            write_instructions(&home, &a, "New rules.").unwrap();
            let after = std::fs::read_to_string(&path).unwrap();
            assert!(after.contains("New rules."));
            assert!(!after.contains("Be brief."));
            assert!(after.contains("Julian's accountant is Sam."));
            assert_eq!(read_instructions(&a.id).unwrap(), "New rules.");
        });
    }

    #[test]
    fn a_fresh_start_leaves_the_conversation_and_keeps_the_rest() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            assert!(
                !a.has_conversation(),
                "nothing to leave before its first turn"
            );
            let fill = super::super::context::ContextFill {
                used: 9,
                window: 10,
                at: 1,
                model: None,
            };
            let before = update(&a.id, |a| {
                a.session_id = Some("s1".into());
                a.context = Some(fill.clone());
                a.model = Some("opus".into());
            })
            .unwrap();
            assert!(before.has_conversation());
            let home = agent_home(&a.id).unwrap();
            let claude_md = std::fs::read_to_string(home.join("CLAUDE.md")).unwrap();

            let after = update(&a.id, Agent::start_fresh).unwrap();
            assert_eq!(
                (after.session_id.clone(), after.context.clone()),
                (None, None)
            );
            assert!(!after.new_engine, "a fresh start is handed no recap");
            assert_eq!(after.model.as_deref(), Some("opus"));
            assert_eq!(after.engine, before.engine);
            assert_eq!(
                std::fs::read_to_string(home.join("CLAUDE.md")).unwrap(),
                claude_md,
                "instructions and memory are untouched"
            );
            assert!(!after.has_conversation());

            // After an engine switch it skips the recap the switch would hand over.
            let mut switched = after.clone();
            switched.context = Some(fill);
            switched.switch_engine(super::super::engine::Engine::Codex);
            assert!(switched.context.is_none() && switched.has_conversation());
            switched.start_fresh();
            assert!(!switched.has_conversation());

            // A new model has a different window: the old reading goes.
            let mut a = before.clone();
            a.set_model(Some("opus".into()));
            assert!(a.context.is_some(), "the same model keeps it");
            a.set_model(Some("haiku".into()));
            assert!(a.context.is_none());
        });
    }

    #[test]
    fn approvals_resolve_once_and_stale_ones_expire() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            let pending = |rid: &str| AgentMessage {
                id: new_id(),
                agent_id: a.id.clone(),
                ts: now_ms(),
                kind: MessageKind::Approval,
                text: String::new(),
                peer: None,
                approval: Some(Approval {
                    request_id: rid.into(),
                    title: "Run a command".into(),
                    detail: "ls".into(),
                    status: ApprovalStatus::Pending,
                    tool: None,
                    input: None,
                    always: None,
                    always_allowed: false,
                    summary: None,
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
                }),
                attachments: Vec::new(),
                check_in: None,
                stopped: false,
                mentions: Vec::new(),
                failure: None,
                changes: None,
                session: None,
                client_id: None,
                work: None,
                fresh: false,
                result: None,
                revises: None,
                takeover: false,
                room: None,
                decide: Vec::new(),
            };
            append_message(&pending("r1")).unwrap();
            append_message(&pending("r2")).unwrap();
            assert!(set_approval_status(&a.id, "r1", ApprovalStatus::Allowed)
                .unwrap()
                .is_some());
            // A second answer to the same card changes nothing.
            assert!(set_approval_status(&a.id, "r1", ApprovalStatus::Denied)
                .unwrap()
                .is_none());
            expire_stale_approvals();
            let log = messages(&a.id, 10).unwrap();
            assert_eq!(
                log[0].approval.as_ref().unwrap().status,
                ApprovalStatus::Allowed
            );
            assert_eq!(
                log[1].approval.as_ref().unwrap().status,
                ApprovalStatus::Expired
            );
        });
    }

    fn note(agent_id: &str, text: &str) -> AgentMessage {
        AgentMessage {
            id: new_id(),
            agent_id: agent_id.into(),
            ts: now_ms(),
            kind: MessageKind::Note,
            text: text.into(),
            peer: None,
            approval: None,
            attachments: Vec::new(),
            check_in: None,
            stopped: false,
            mentions: Vec::new(),
            changes: None,
            failure: None,
            session: None,
            client_id: None,
            work: None,
            fresh: false,
            result: None,
            revises: None,
            takeover: false,
            room: None,
            decide: Vec::new(),
        }
    }

    #[test]
    fn a_torn_last_line_doesnt_swallow_the_next_message() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            append_message(&note(&a.id, "one")).unwrap();
            let path = log_path(&a.id).unwrap();
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(br#"{"id":"torn","kind":"us"#).unwrap();
            append_message(&note(&a.id, "two")).unwrap();
            let texts: Vec<String> = messages(&a.id, 10)
                .unwrap()
                .into_iter()
                .map(|m| m.text)
                .collect();
            assert_eq!(texts, ["one", "two"]);
        });
    }

    #[test]
    fn answering_a_card_appends_and_never_rewrites_the_log() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            append_message(&note(&a.id, "before")).unwrap();
            let mut card = note(&a.id, "");
            card.kind = MessageKind::Approval;
            card.approval = Some(Approval {
                request_id: "r9".into(),
                title: "Run a command".into(),
                detail: "ls".into(),
                status: ApprovalStatus::Pending,
                tool: Some("Bash".into()),
                input: None,
                always: None,
                always_allowed: false,
                summary: None,
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
            });
            append_message(&card).unwrap();
            let raw = std::fs::read(log_path(&a.id).unwrap()).unwrap();
            let answered = deny_with_note(&a.id, "r9", "not now").unwrap().unwrap();
            assert_eq!(
                answered.approval.as_ref().unwrap().status,
                ApprovalStatus::Denied
            );
            assert_eq!(std::fs::read(log_path(&a.id).unwrap()).unwrap(), raw);
            let found = find_approval(&a.id, "r9").unwrap().unwrap();
            assert_eq!(found.note.as_deref(), Some("not now"));
            assert!(pending_approvals(&a.id).unwrap().is_empty());
            assert_eq!(get(&a.id).unwrap().pending_approvals, 0);
            let shown = messages(&a.id, 1).unwrap();
            assert_eq!(
                shown[0].approval.as_ref().unwrap().status,
                ApprovalStatus::Denied
            );
        });
    }

    #[test]
    fn a_long_log_is_read_from_its_end() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            // Long enough to span several read chunks.
            let filler = "x".repeat(3000);
            for i in 0..400 {
                append_message(&note(&a.id, &format!("{i} {filler}"))).unwrap();
            }
            let last: Vec<String> = messages(&a.id, 3)
                .unwrap()
                .into_iter()
                .map(|m| m.text.split(' ').next().unwrap().to_string())
                .collect();
            assert_eq!(last, ["397", "398", "399"]);
            assert_eq!(messages(&a.id, 1000).unwrap().len(), 400);
            assert_eq!(messages(&a.id, usize::MAX).unwrap().len(), 400);
        });
    }

    /* ---------------------------------------------- backwards compatibility */

    // Data users already have on disk must load in every future release.
    // The fixtures are frozen: never edit them to make a test pass; add new
    // ones for new formats.
    const COMPAT_REGISTRY: &str = include_str!("testdata/compat/agents.json");
    const COMPAT_LOG: &str = include_str!("testdata/compat/messages.jsonl");
    const CHIEF: &str = "c0ffee00-0000-4000-8000-000000000001";

    /// Every key of `old` is in `new` with a value that covers it (an
    /// absent key may come back as its default; a null may be left out).
    fn covers(new: Option<&serde_json::Value>, old: &serde_json::Value) -> bool {
        use serde_json::Value;
        match (new, old) {
            (None, Value::Null) => true,
            (Some(Value::Object(n)), Value::Object(o)) => {
                o.iter().all(|(k, v)| covers(n.get(k), v))
            }
            (Some(Value::Array(n)), Value::Array(o)) => {
                n.len() == o.len() && n.iter().zip(o).all(|(n, o)| covers(Some(n), o))
            }
            (Some(n), o) => n == o,
            (None, _) => false,
        }
    }

    fn registry_on_disk() -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(registry_path().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn registries_from_every_release_load_and_survive_a_write() {
        with_root(|| {
            std::fs::create_dir_all(agents_root().unwrap()).unwrap();
            std::fs::write(registry_path().unwrap(), COMPAT_REGISTRY).unwrap();
            let agents = list().unwrap();
            let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
            assert_eq!(names, ["Chief of Staff", "Builder", "Finance", "Scout"]);
            let chief = &agents[0];
            assert!(chief.is_main && chief.pinned);
            assert_eq!(chief.check_ins.len(), 3);
            assert_eq!(chief.permissions.len(), 4);
            assert_eq!(chief.usage.all_time.turns, 41);
            assert_eq!(chief.usage.days.len(), 1);
            assert_eq!(chief.model.as_deref(), Some("opus"));
            assert!(chief.failure.as_ref().unwrap().resets_at.is_some());
            assert_eq!(
                agents[1].project.as_deref(),
                Some("/Users/someone/ShipStudio/site")
            );
            // The oldest shape: only the original fields.
            let scout = &agents[3];
            assert!(scout.role.is_empty() && !scout.pinned && scout.check_ins.is_empty());

            // A write (any update) keeps everything that was there.
            update(&agents[3].id, |a| a.unread = 1).unwrap();
            let old: serde_json::Value = serde_json::from_str(COMPAT_REGISTRY).unwrap();
            let mut new = registry_on_disk();
            new["agents"][3]["unread"] = serde_json::json!(0);
            assert!(covers(Some(&new), &old), "a write dropped data:\n{new:#}");
        });
    }

    #[test]
    fn an_older_build_keeps_what_a_newer_one_wrote() {
        with_root(|| {
            let mut future: serde_json::Value = serde_json::from_str(COMPAT_REGISTRY).unwrap();
            future["formatVersion"] = serde_json::json!(9);
            future["agents"][0]["voice"] = serde_json::json!({ "name": "Ava", "speed": 1.1 });
            future["agents"][0]["checkIns"][0]["quietHours"] = serde_json::json!([22, 7]);
            future["agents"][0]["permissions"][0]["expiresAt"] =
                serde_json::json!(1799999999999i64);
            // A whole entry this build can't read (a repeat it has no word for).
            let mut newer = future["agents"][3].clone();
            newer["id"] = serde_json::json!("c0ffee00-0000-4000-8000-000000000005");
            newer["name"] = serde_json::json!("Monthly");
            newer["checkIns"] = serde_json::json!([{ "id": "x", "note": "n", "repeat": { "kind": "monthly", "day": 1 }, "nextAt": 1, "createdAt": 1 }]);
            future["agents"].as_array_mut().unwrap().push(newer);
            std::fs::create_dir_all(agents_root().unwrap()).unwrap();
            std::fs::write(registry_path().unwrap(), future.to_string()).unwrap();

            assert_eq!(list().unwrap().len(), 4, "the unreadable entry is hidden");
            update(CHIEF, |a| a.unread = 7).unwrap();
            let chief = get(CHIEF).unwrap();
            assert_eq!(chief.extra["voice"]["name"], "Ava");
            let mut on_disk = registry_on_disk();
            on_disk["agents"][0]["unread"] = future["agents"][0]["unread"].clone();
            assert!(
                covers(Some(&on_disk), &future),
                "a write dropped newer data:\n{on_disk:#}"
            );
            // Nothing was treated as damage.
            let aside = std::fs::read_dir(agents_root().unwrap())
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
            assert!(!aside);
        });
    }

    /// Every kind of chat line, so a new kind can't ship without a fixture:
    /// this match stops compiling until it is listed (and added to the log).
    fn fixture_line_for(kind: MessageKind) -> &'static str {
        match kind {
            MessageKind::User => "m01",
            MessageKind::SentToAgent => "m02",
            MessageKind::FromAgent => "m03",
            MessageKind::Agent => "m04",
            MessageKind::Approval => "m05",
            MessageKind::Note => "m09",
            MessageKind::CheckIn => "m13",
            MessageKind::Changes => "m14",
            MessageKind::Error => "m16",
            MessageKind::Session => "s01",
        }
    }

    #[test]
    fn chat_logs_from_every_release_load_in_full() {
        with_root(|| {
            std::fs::create_dir_all(agents_root().unwrap()).unwrap();
            std::fs::write(registry_path().unwrap(), COMPAT_REGISTRY).unwrap();
            let home = agent_home(CHIEF).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            // Plus lines a newer build might write: a kind and a field this one doesn't know.
            let future_kind = r#"{"id":"m21","agentId":"c0ffee00-0000-4000-8000-000000000001","ts":1762200000021,"kind":"voice_memo","text":"hi"}"#;
            let future_field = r#"{"id":"m22","agentId":"c0ffee00-0000-4000-8000-000000000001","ts":1762200000022,"kind":"agent","text":"ok","reactions":["👍"]}"#;
            let raw = format!("{COMPAT_LOG}{future_kind}\n{future_field}\n");
            std::fs::write(home.join("messages.jsonl"), &raw).unwrap();

            let log = messages(CHIEF, usize::MAX).unwrap();
            let ids: Vec<&str> = log.iter().map(|m| m.id.as_str()).collect();
            let expected: Vec<String> = (1..=20)
                .map(|n| format!("m{n:02}"))
                .chain((1..=4).map(|n| format!("s{n:02}")))
                .chain((1..=4).map(|n| format!("p{n:02}")))
                .chain((1..=3).map(|n| format!("r{n:02}")))
                .chain(["o01".into()])
                .chain(["m22".into()])
                .collect();
            assert_eq!(ids, expected, "a line was dropped");
            for kind in [
                MessageKind::User,
                MessageKind::Agent,
                MessageKind::SentToAgent,
                MessageKind::FromAgent,
                MessageKind::Approval,
                MessageKind::Error,
                MessageKind::CheckIn,
                MessageKind::Note,
                MessageKind::Changes,
                MessageKind::Session,
            ] {
                let id = fixture_line_for(kind);
                assert!(log.iter().any(|m| m.id == id && m.kind == kind), "{kind:?}");
            }
            let status = |rid: &str| {
                log.iter()
                    .filter_map(|m| m.approval.as_ref())
                    .find(|a| a.request_id == rid)
                    .unwrap()
                    .status
            };
            assert_eq!(status("req-pending"), ApprovalStatus::Pending);
            assert_eq!(status("req-allowed"), ApprovalStatus::Allowed);
            assert_eq!(status("req-denied"), ApprovalStatus::Denied);
            assert_eq!(status("req-expired"), ApprovalStatus::Expired);
            let by_id = |id: &str| log.iter().find(|m| m.id == id).unwrap();
            assert_eq!(by_id("m01").attachments.len(), 1);
            assert_eq!(by_id("m01").mentions.len(), 1);
            assert_eq!(by_id("m04").attachments[0].name, "october.csv");
            assert!(by_id("m11").stopped);
            assert!(by_id("m13").check_in.as_ref().unwrap().late);
            assert_eq!(by_id("m14").changes.as_ref().unwrap().files.len(), 3);
            assert!(by_id("m15").changes.as_ref().unwrap().branch.is_none());
            assert!(by_id("m16").failure.as_ref().unwrap().resets_at.is_some());
            assert!(by_id("m18").failure.is_none());
            use super::super::sessions::SessionEvent;
            let event = |id: &str| by_id(id).session.as_ref().unwrap().event;
            assert_eq!(event("s01"), SessionEvent::Started);
            assert_eq!(event("s02"), SessionEvent::Sent);
            assert_eq!(event("s03"), SessionEvent::Reply);
            assert_eq!(event("s04"), SessionEvent::Screenshot);
            assert_eq!(by_id("s01").session.as_ref().unwrap().tab, Some(1));
            assert_eq!(by_id("s04").attachments.len(), 1);
            // Secure input cards (`request_secret`) and a session's question.
            let card = |id: &str| by_id(id).approval.as_ref().unwrap();
            let saved = card("p01").secret.as_ref().unwrap();
            assert_eq!(saved.fields[0].env, "STRIPE");
            assert_eq!(card("p02").secret.as_ref().unwrap().fields.len(), 2);
            assert_eq!(
                card("p02").note.as_deref(),
                Some("Use the CSV export instead")
            );
            let trust = card("p03").prompt.as_ref().unwrap();
            assert_eq!(trust.kind, super::super::decisions::PromptKind::Trust);
            assert_eq!(trust.chats.len(), 2);
            assert_eq!(card("p03").choice.as_deref(), Some("Yes, proceed"));
            assert_eq!(status("req-prompt-expired"), ApprovalStatus::Expired);
            assert_eq!(card("p04").prompt.as_ref().unwrap().options.len(), 3);
            // Result cards (`share_result`) and "Ask for changes".
            use super::super::results::{ResultItem, ShotRole};
            let first = by_id("r01").result.as_ref().unwrap();
            assert_eq!((first.version, first.items.len()), (1, 2));
            assert!(matches!(first.items[1], ResultItem::Link { .. }));
            assert_eq!(first.not_verified.len(), 1);
            assert_eq!(by_id("r02").revises.as_ref().unwrap().id, "res-oct");
            let second = by_id("r03").result.as_ref().unwrap();
            assert_eq!(by_id("r03").kind, MessageKind::Changes);
            assert_eq!(
                second.changes.as_deref(),
                Some("EUR invoices use the October 31 rate")
            );
            assert!(matches!(
                second.items[0],
                ResultItem::File {
                    role: Some(ShotRole::After),
                    ..
                }
            ));
            // A line said in a room keeps the room it was said in.
            assert_eq!(
                by_id("o01").room.as_deref(),
                Some("f00dface000040008000000000000001")
            );
            assert_eq!(messages(CHIEF, 3).unwrap().len(), 3);

            // Answering a card and appending leave every existing line as it was.
            set_approval_status(CHIEF, "req-pending", ApprovalStatus::Allowed)
                .unwrap()
                .unwrap();
            append_message(&note(CHIEF, "after")).unwrap();
            let now = std::fs::read_to_string(home.join("messages.jsonl")).unwrap();
            assert!(now.starts_with(&raw), "the log was rewritten");
            assert_eq!(get(CHIEF).unwrap().pending_approvals, 0);
        });
    }

    #[test]
    fn a_torn_registry_comes_back_from_its_copy_and_is_kept_aside() {
        with_root(|| {
            create(new("Finance")).unwrap();
            create(new("Travel")).unwrap();
            let path = registry_path().unwrap();
            let raw = std::fs::read(&path).unwrap();
            std::fs::write(&path, &raw[..raw.len() / 2]).unwrap();
            assert_eq!(list().unwrap().len(), 2);
            let aside = std::fs::read_dir(agents_root().unwrap())
                .unwrap()
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("agents.json.corrupt-")
                })
                .count();
            assert_eq!(aside, 1);
            // Repaired on disk: the next read neither recovers nor copies again.
            assert_eq!(list().unwrap().len(), 2);
        });
    }

    #[test]
    fn one_bad_entry_doesnt_hide_the_rest() {
        with_root(|| {
            create(new("Finance")).unwrap();
            create(new("Travel")).unwrap();
            let path = registry_path().unwrap();
            let mut value: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            value["agents"][0]["shape"] = serde_json::json!("not a number");
            std::fs::write(&path, value.to_string()).unwrap();
            std::fs::remove_file(path.with_extension("json.bak")).unwrap();
            let names: Vec<String> = list().unwrap().into_iter().map(|a| a.name).collect();
            assert_eq!(names, ["Travel"]);
        });
    }

    #[test]
    fn an_unrecoverable_registry_is_an_error_not_an_empty_list() {
        with_root(|| {
            create(new("Finance")).unwrap();
            let path = registry_path().unwrap();
            std::fs::write(&path, b"{\"agents\": [").unwrap();
            std::fs::remove_file(path.with_extension("json.bak")).unwrap();
            assert!(list().is_err());
            assert!(
                create(new("Travel")).is_err(),
                "must not overwrite what it couldn't read"
            );
        });
    }

    #[test]
    fn models_are_the_cli_aliases_only() {
        assert_eq!(normalize_model(" ").unwrap(), None);
        assert_eq!(normalize_model(" opus ").unwrap().as_deref(), Some("opus"));
        assert!(normalize_model("haiku").is_ok());
        assert!(normalize_model("gpt-5").is_err());
        assert!(normalize_model("--dangerously-skip-permissions").is_err());
        assert!(normalize_model("opus; rm -rf").is_err());
    }

    #[test]
    fn rejects_path_like_ids() {
        assert!(agent_home("../etc").is_err());
        assert!(agent_home("").is_err());
    }
}
