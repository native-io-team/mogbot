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

// Lock order: see `store_lock.rs`. The registry lock is innermost.

use crate::errors::CommandError;

/// The avatar palette. Keys, not colours: the frontend maps each to a token,
/// so a theme change never leaves stale hex in someone's registry.
pub const COLORS: &[&str] = &[
    "white", "brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink", "gray",
];
/// The key an agent's look from before keys was saved under (a shape, a
/// face and a finish). Read and dropped (`Registry::from_value`); an older
/// phone may still send it to `agents.create` / `agents.update`, where it is
/// accepted and ignored.
pub const OLD_LOOK: &str = "avatar";

/// The legacy face index (`shape`), from before avatars were a shape and a
/// face. Still written, so an older build reads the registry; nothing draws it.
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
    /// The old avatar colour key, kept beside its key's colourway (nearest)
    /// for clients that only read this.
    pub color: String,
    /// Its key (docs/design/agent-keys.md, `keys`): a colourway, a legend
    /// and the keyboard key it's bound to. Filled in on read for an agent
    /// saved before keys (`keys::fill`), so never absent once loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colorway: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_key: Option<String>,
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
    /// "Runs on": the one account of its engine its turns run on
    /// (`wallet::for_agent`), never another. `None` (the default): any
    /// account, in the wallet's order, carrying on with the next when one
    /// runs out. Cleared when it moves engine or the account is removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Explicit model override (`--model` / `-m`), one its engine offers;
    /// `None` uses the engine's own default.
    #[serde(default)]
    pub model: Option<String>,
    /// How hard its conversation turns think: one of [`EFFORTS`], passed as
    /// Claude Code's `--effort` or Codex's reasoning effort. `None` is the
    /// engine's own default. Routines don't take it: they mostly check, and
    /// run on a cheaper model that may not offer the same levels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// It moved to another engine and hasn't had a turn there yet: the next
    /// turn starts a new session and is handed the recent conversation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub new_engine: bool,
    /// Every account of its engine is out, and its turns carry on with the
    /// other engine meanwhile (`crossover`): which, and its conversation
    /// there. Its own `session_id` stays as it was, for when it goes back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away: Option<super::crossover::Away>,
    /// How full its current conversation is, as its engine last reported it.
    /// `None` when the engine doesn't say, or since a fresh start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<super::context::ContextFill>,
    /// No OS notifications for this agent. Unread and the Dock badge still count it.
    #[serde(default)]
    pub muted: bool,
    /// "Save new skills": Automatically / Ask me (the default) / Off
    /// (`agents/skills_learn.rs`). Absent in registries from before it.
    #[serde(
        default,
        skip_serializing_if = "super::skills_learn::Learning::is_default"
    )]
    pub learn_skills: super::skills_learn::Learning,
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
    /// Its conversations' engine sessions (`conversations`): which one the
    /// session fields above belong to, and the others', parked until a turn
    /// in that conversation loads them.
    #[serde(
        default,
        skip_serializing_if = "super::conversations::Sessions::is_empty"
    )]
    pub conversations: super::conversations::Sessions,
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
        self.account = None;
        self.model = None;
        self.routine_model = None;
        self.session_id = None;
        self.new_engine = true;
        self.capabilities = None;
        self.context = None;
        // Carrying on elsewhere was for the engine it's leaving.
        self.away = None;
        // So were its other conversations' sessions.
        super::conversations::engine_switched(self);
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
            super::conversations::forget_readings(self);
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
        // Carrying on with the other engine starts fresh there too.
        if let Some(away) = self.away.as_mut() {
            away.session_id = None;
            away.fresh = true;
        }
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
    /// "Change this agent's settings?" (`propose_settings_change`,
    /// `agents/policy_card.rs`): who, what, before and after in plain words.
    /// Nothing changes until the user allows it; the card's own text
    /// (`summary`, `detail`) says the same for clients that don't know it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<super::policy_card::Proposal>,
    /// "Do these under your name?" (`ask_plan`, `agents/plan_grant.rs`): the
    /// actions, numbered. Allow makes one grant that covers each of them;
    /// the card's own text (`summary`, `detail`) lists them too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<super::plan_grant::Plan>,
    /// "<source> sent what it knows" (`agents/handoff.rs`): an outside
    /// assistant's handover over `ask_chief`, collected into one card. Its
    /// parts are `detail`; Allow ("Save to memory") gives them to the Chief
    /// as a turn the user authorised, Deny ("Ignore") saves nothing. Older
    /// clients show a plain Allow / Deny over the same summary and detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<super::handoff::Handoff>,
    /// "OK to go on?" between two steps of a routine
    /// (`agents/routine_steps.rs`): which routine, what's done, what's next.
    /// Go ahead (Allow) runs the next step; Stop here (Deny) ends the run.
    /// Older clients show a plain Allow / Deny over the same summary and detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<super::routine_steps::Gate>,
    /// "<Agent> needs you in its browser: <reason>" (`ask_user_to_step_in`,
    /// `agents/step_in.rs`): Step in (desk only) brings the agent's tab
    /// forward for the user, Hand back answers it; Deny is Not now. Older
    /// clients show the same title and detail with a plain Allow / Deny,
    /// and an Allow is refused with "Step in on your Mac".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_in: Option<super::step_in::StepIn>,
    /// "All your Claude Code accounts are out until 4:00 PM. Carry on with
    /// Codex until then?" (`agents/crossover.rs`): Always (Allow + always),
    /// Just this time (Allow), Wait (Deny). Older clients show a plain
    /// Allow / Deny over the same title and summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crossover: Option<super::crossover::Ask>,
    /// "Run turns on “Personal” first?" (`use_account` from a turn that
    /// isn't the user's own message): nothing waits on it, it stays until
    /// answered, and Allow makes the switch (`usage_tools::answer_switch`).
    /// Older clients show a plain Allow / Deny over the same title and detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_switch: Option<super::usage_tools::AccountSwitch>,
    /// "Reply in Slack?" (`agents/slack.rs`): the exact words, and the
    /// thread they go to. Nothing waits on it; Allow posts it as the user.
    /// Older clients show a plain Allow / Deny over the same summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack_reply: Option<super::slack::ReplyCard>,
    /// "Save “Export invoices” as a skill?" (`save_skill`,
    /// `agents/skills_learn.rs`): the skill exactly as it would be saved.
    /// Nothing waits on it; Save (Allow) writes it, Not now (Deny) doesn't.
    /// Older clients show a plain Allow / Deny over the same summary and detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<super::skills_learn::SkillCard>,
    /// How risky Allow is, decided here from the classifiers the levels use
    /// (`mcp::risk_of`: `go_hard::floor` for a tool call). Only `Low` may be
    /// answered in place on the phone's list or from a Lock Screen
    /// notification; `High` (deleting outside the work folders, pushing,
    /// publishing, sending, money, credentials, `sudo`, system files) opens
    /// in full and is marked as dangerous, and absent (unclassified, or a
    /// card from before this was recorded) opens in full too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<Risk>,
}

/// `Approval::risk`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    High,
}

/// Where a message came in from, when not this app (`AgentMessage::via`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Via {
    /// `slack`.
    pub source: String,
    /// "#launch", "your own DM".
    pub place: String,
    /// Someone other than the user wrote it: their name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
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
    /// On an `agent` reply: its links to servers on this Mac, taken out of
    /// the text (`agents/local_links.rs`). Older builds show the text alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_links: Vec<super::local_links::LocalLink>,
    /// Blocks (`show`, `agents/blocks.rs`): charts, tables, choices, a form…
    /// checked when the agent posted them. Kept as JSON, so a block a newer
    /// build wrote never makes this message unreadable here; the clients
    /// read it (`readBlocks`) and fall back to `text`, which carries every
    /// block's plain-text summary. Older builds show the text alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<serde_json::Value>,
    /// On a `note`: "Remembered: Lead Gen can always …", a rule the agent
    /// recorded from what the user said (`remember_permission`), with Undo
    /// while it is in force. Older builds show the note alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remembered: Option<super::remember::Remembered>,
    /// Came in from outside the app: a Slack message (`agents/slack.rs`),
    /// shown with "From Slack · #launch". On the user's own message it is
    /// theirs, written in Slack; on a note, someone else's (`from`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Via>,
    /// On a `note`: the one fix it names, as a button ("Set up Your
    /// Chrome", `chrome_health`). Older builds show the note alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<NoteFix>,
    /// Which of the agent's conversations it was said in (`conversations`).
    /// Absent on lines written before there were several: the first one's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
}

/// A fix a note offers, as a button that opens where it's done.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoteFix {
    /// Settings → Chrome: set it up.
    UserChrome,
    /// Settings → Chrome, when it's on but not connected:
    /// the button says to check it, not to set it up again.
    UserChromeCheck,
    /// Settings → Agents → Disk space, with Free up space.
    Disk,
}

/// `agents.json`. Read and written losslessly: an entry this build can't
/// read (a newer build's, or a bad hand edit) is hidden but written back
/// untouched, and so are top-level keys it doesn't know. An older build must
/// never delete an agent a newer one saved.
#[derive(Debug, Default, Clone)]
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
                Ok(mut agent) => {
                    // A look from before keys (a shape, a face, a finish):
                    // nothing draws it any more, so it isn't kept or served.
                    // Dropped on the next save; an older build that reads
                    // the registry derives one from the id, as it always did.
                    agent.extra.remove(OLD_LOOK);
                    registry.agents.push(agent)
                }
                Err(e) => {
                    tracing::warn!("[Agents] keeping an agent entry this build can't read: {e}");
                    registry.unreadable.push(entry);
                }
            }
        }
        // Agents saved before keys get one; written back on the next save.
        super::keys::fill(&mut registry.agents);
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

/// One lock around every registry read-modify-write; reads don't take it.
/// Its rules (innermost, no re-entry, nobody waits forever) are in
/// `store_lock.rs`.
#[path = "store_lock.rs"]
pub(crate) mod lock;

#[cfg(test)]
#[path = "store_lock_tests.rs"]
mod lock_tests;

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

/// A unit test without a scratch root reads the real app's folder; it
/// must never write there. Always true outside tests.
pub fn may_write_root() -> bool {
    !cfg!(test)
        || ROOT_OVERRIDE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
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

/// What identifies one version of `agents.json` on disk. Every write here is
/// an atomic rename, so a new version is a new inode and mtime; a hand edit or
/// another app's write changes the stamp too.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    modified: Option<std::time::SystemTime>,
    len: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileStamp {
    fn of(path: &Path) -> Option<FileStamp> {
        let meta = std::fs::metadata(path).ok()?;
        Some(FileStamp {
            modified: meta.modified().ok(),
            len: meta.len(),
            #[cfg(unix)]
            inode: std::os::unix::fs::MetadataExt::ino(&meta),
        })
    }
}

/// The parsed registry, kept while the file is the version it was parsed
/// from. `list()`/`get()` run on every status event, approval, routine tick
/// and overview (dozens of times a second while agents work), and each one
/// used to read and parse the whole pretty-printed file.
static REGISTRY_CACHE: LazyLock<Mutex<Option<(PathBuf, FileStamp, Registry)>>> =
    LazyLock::new(|| Mutex::new(None));

/// The registry, recovering a damaged file. Call with [`lock`] held.
fn read_registry() -> Result<Registry, CommandError> {
    debug_assert!(
        lock::held_here(),
        "recovery rewrites agents.json: hold the lock"
    );
    if let Some(registry) = read_registry_unlocked()? {
        return Ok(registry);
    }
    // Damaged: recovery rewrites the file, so this read is not cached.
    parse_registry(&registry_path()?)
}

fn parse_registry(path: &Path) -> Result<Registry, CommandError> {
    let path = path.to_path_buf();
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
        return rebuild_registry(path, why);
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

/// No `.bak` either: put back every agent whose folder still says who it is
/// ([`rebuild::from_homes`]), with the damaged file copied aside first and a
/// line in the Chief's chat. With no folder to go on it stays an error, and
/// nothing is written: an empty list must never replace one it couldn't read.
fn rebuild_registry(path: &Path, why: &str) -> Result<Registry, CommandError> {
    let unreadable = || {
        super::err_other(format!(
            "Your agents list ({}) is damaged and has no backup, so nothing was changed. Move it aside to start a new list; the app's log has the detail ({why}).",
            path.display()
        ))
    };
    let root = path.parent().ok_or_else(unreadable)?;
    let rebuilt = rebuild::from_homes(root);
    if rebuilt.agents.is_empty() {
        // No line queued: with no Chief to post it to, it would pile up on
        // every read. The error itself is what the app shows.
        tracing::error!("[Agents] registry unreadable ({why}), no backup and no agent folders");
        return Err(unreadable());
    }
    let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
    std::fs::copy(path, &aside).map_err(|e| super::err_io(e.to_string()))?;
    tracing::error!(
        "[Agents] registry unreadable ({why}) with no backup; rebuilt {} agents from their folders, damaged copy kept at {}",
        rebuilt.agents.len(),
        aside.display()
    );
    write_registry(&rebuilt)?;
    let kept = aside
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    super::survive::say(rebuild::line(rebuilt.agents.len(), &kept));
    Ok(rebuilt)
}

#[path = "store_rebuild.rs"]
mod rebuild;

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    // A name of its own per write: with one shared `<name>.tmp`, two writers
    // truncated and renamed each other's file, so a half-written one could
    // land in place and the other write failed. And nothing left behind when
    // the write fails (a full disk): a stray copy only fills it further.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), new_id()));
    let tmp = PathBuf::from(tmp);
    let written = write_private(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| super::err_io(e.to_string()))
}

#[cfg(test)]
#[path = "store_write_tests.rs"]
mod write_tests;

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
    *REGISTRY_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    write_atomic(&path, &json)?;
    if let Err(e) = write_atomic(&path.with_extension("json.bak"), &json) {
        tracing::warn!("[Agents] registry backup not written: {e}");
    }
    // What the user took away, beside each agent, for a rebuild to restore.
    if let Some(root) = path.parent() {
        limits::write_changed(root, &registry.agents);
    }
    Ok(())
}

#[path = "store_limits.rs"]
mod limits;

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

/// Every agent. Never waits on a writer: the file is only ever replaced
/// whole, so the cache or one read of it is a consistent version. Only a
/// file that needs recovering (which rewrites it) goes through the lock.
pub fn list() -> Result<Vec<Agent>, CommandError> {
    if let Some(registry) = read_registry_unlocked()? {
        return Ok(registry.agents);
    }
    let _guard = lock::take()?;
    Ok(read_registry()?.agents)
}

/// [`read_registry`] without writing anything: `None` when the file is
/// damaged and needs [`recover_registry`], which only a lock holder may run.
fn read_registry_unlocked() -> Result<Option<Registry>, CommandError> {
    let path = registry_path()?;
    // Stamped *before* reading: a write that lands in between leaves the
    // cached copy with an older stamp, so the next read parses again.
    let stamp = FileStamp::of(&path);
    if let Some(stamp) = &stamp {
        let cache = REGISTRY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_path, cached_stamp, registry)) = cache.as_ref() {
            if *cached_path == path && cached_stamp == stamp {
                return Ok(Some(registry.clone()));
            }
        }
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Some(Registry::default())),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    let Some(registry) = serde_json::from_str(&raw)
        .ok()
        .and_then(Registry::from_value)
    else {
        return Ok(None);
    };
    if let Some(stamp) = stamp {
        if FileStamp::of(&path).as_ref() == Some(&stamp) {
            *REGISTRY_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((path, stamp, registry.clone()));
        }
    }
    Ok(Some(registry))
}

pub fn get(id: &str) -> Result<Agent, CommandError> {
    list()?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))
}

/// Find an agent the way another agent names it: by id, or by name ignoring case.
/// A name is only ever a name here: creating, renaming and importing check
/// it, so "Chief" and "Chief of Staff" stay names anyone can have.
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

/// [`find`] for an agent being addressed (a message, a read of its notes):
/// the Chief can be renamed ("Dash"), and notes and memories written before
/// that still say "Chief of Staff", so its old names keep reaching it while
/// no agent has that exact name. Nothing else (create, rename, import,
/// admin actions) goes by an old name.
pub fn find_addressed(name_or_id: &str) -> Result<Option<Agent>, CommandError> {
    if let Some(found) = find(name_or_id)? {
        return Ok(Some(found));
    }
    if !chief_alias(name_or_id) {
        return Ok(None);
    }
    Ok(list()?.into_iter().find(|a| a.is_main))
}

/// Names that always mean the Chief, whatever it is called now.
fn chief_alias(name: &str) -> bool {
    let n = name
        .trim()
        .trim_start_matches("the ")
        .trim_start_matches("The ");
    ["chief", "chief of staff", "the chief"]
        .iter()
        .any(|alias| n.eq_ignore_ascii_case(alias))
}

/// Read-modify-write one agent under the registry lock.
pub fn update<F: FnOnce(&mut Agent)>(id: &str, change: F) -> Result<Agent, CommandError> {
    let _guard = lock::take()?;
    let mut registry = read_registry()?;
    let agent = registry
        .agents
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))?;
    let before = agent.clone();
    change(agent);
    let updated = agent.clone();
    // A change that changed nothing (a When… check reserving a free source,
    // a count already right) leaves the file alone: each write is the whole
    // registry, twice (it and its backup).
    if updated != before {
        write_registry(&registry)?;
    }
    Ok(updated)
}

/// A best-effort write (the caller carries on whether it landed or not),
/// with a trace when it didn't: `store::update(..).or_log("its unread
/// count")`. The log names what the write was for and where it was made,
/// never what it held; the error is the store's own (a path, "busy").
pub trait OrLog<T> {
    fn or_log(self, what: &str) -> Option<T>;
}

impl<T, E: std::fmt::Display> OrLog<T> for Result<T, E> {
    #[track_caller]
    fn or_log(self, what: &str) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                let at = std::panic::Location::caller();
                tracing::warn!("[Agents] couldn't save {what} ({at}): {e}");
                None
            }
        }
    }
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

/// The effort levels offered, on either engine: Claude Code's `--effort`
/// takes them (it also has `xhigh` and `max`), and so does Codex's reasoning
/// effort (`model_reasoning_effort`, the app-server's `effort` on
/// `turn/start`; some models also offer `minimal` or `xhigh`). Only the
/// three both say, so a level survives a move between engines.
pub const EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// An effort setting from the UI: empty is the engine's default; anything
/// else must be one of [`EFFORTS`]. It becomes an argument, so nothing else
/// gets through.
pub fn normalize_effort(effort: &str) -> Result<Option<String>, CommandError> {
    let effort = effort.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return Ok(None);
    }
    if !EFFORTS.contains(&effort.as_str()) {
        return Err(super::err_invalid(
            "effort",
            "Pick Low, Medium, High or Default.",
        ));
    }
    Ok(Some(effort))
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
            "Pick Smartest (Opus), Balanced (Sonnet), Fastest (Haiku) or Default.",
        ));
    }
    Ok(Some(model.to_string()))
}

/// Add an agent. Its home and CLAUDE.md are made first, outside the
/// registry lock (`store_lock`: folder I/O never runs under it): its id is
/// new, so nothing reaches that folder until the registry names it. If the
/// agent can't be added after all (a name taken meanwhile), the folder goes.
pub fn create(new: NewAgent) -> Result<Agent, CommandError> {
    let name = validate_name(&new.name)?;
    let role = new.role.trim().to_string();
    // Refused before any folder is made when it's already clear.
    if list()?.iter().any(|a| a.name.eq_ignore_ascii_case(&name)) {
        return Err(super::err_invalid(
            "name",
            format!("There's already an agent called {name}."),
        ));
    }
    let id = new_id();
    let home = agents_root()?.join(&id);
    let made = ensure_private_dir(&home)
        .map_err(|e| super::err_io(e.to_string()))
        .and_then(|()| write_instructions_for(&home, &name, &role, &new.instructions))
        .and_then(|()| register_new(id, name, new));
    if made.is_err() {
        if let Err(e) = crate::utils::remove_dir_all_robust(&home) {
            tracing::warn!(
                "[Agents] couldn't tidy away a new agent's folder that wasn't used: {e}"
            );
        }
    }
    made
}

/// [`create`]'s registry half, under the lock: nothing but the registry.
fn register_new(id: String, name: String, new: NewAgent) -> Result<Agent, CommandError> {
    let _guard = lock::take()?;
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
    // Its colour as before (one asked for, else spread across the palette,
    // which import previews predict), and its key's colourway the nearest.
    let mut color = color_for(new.color.as_deref(), index);
    let mut colorway = super::keys::colorway_for_color(&color);
    // Its icon from its name and role, now, and (unless a colour was asked
    // for) a colourway no one on the team wears with that icon, so two
    // agents never get the same key.
    let icon = super::keys::icon_for(&name, new.role.trim(), new.is_main);
    if new.color.is_none() {
        let worn: Vec<(&str, &str)> = registry
            .agents
            .iter()
            .filter_map(|a| Some((a.colorway.as_deref()?, a.icon.as_deref()?)))
            .collect();
        let distinct = super::keys::distinct_colorway(&colorway, &icon, worn.iter().copied());
        if distinct != colorway {
            color = super::keys::legacy_color_for(&distinct);
            colorway = distinct;
        }
    }
    let shape = new
        .shape
        .filter(|s| *s < SHAPE_COUNT)
        .unwrap_or(((index * 5 + 1) % SHAPE_COUNT as usize) as u8);
    let now = now_ms();
    let agent = Agent {
        id,
        name,
        role: new.role.trim().to_string(),
        shape,
        color,
        colorway: Some(colorway),
        icon: Some(icon),
        bound_key: None,
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
        effort: None,
        new_engine: false,
        away: None,
        context: None,
        routine_model: None,
        learn_skills: Default::default(),
        account: None,
        template: None,
        reach: Default::default(),
        conversations: Default::default(),
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
    registry.agents.push(agent);
    // Its icon and key, or a free key when its own is taken by now.
    super::keys::fill(&mut registry.agents);
    let agent = registry.agents.last().cloned().expect("just pushed");
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
    write_instructions_for(home, &agent.name, &agent.role, instructions)
}

/// [`write_instructions`] by the two things it says about the agent.
fn write_instructions_for(
    home: &Path,
    name: &str,
    role: &str,
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
    let role = if role.is_empty() {
        String::new()
    } else {
        format!("{role}\n\n")
    };
    let body = instructions.trim();
    let instructions = if body.is_empty() {
        String::new()
    } else {
        format!("## Instructions\n\n{body}\n\n")
    };
    let content = format!("# {name}\n\n{role}{arrival}{instructions}{memory}");
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
    let _guard = lock::take()?;
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
    registry.agents.push(agent);
    // Its icon and key, or a free key when its own is taken by now.
    super::keys::fill(&mut registry.agents);
    let agent = registry.agents.last().cloned().expect("just pushed");
    write_registry(&registry)?;
    Ok(agent)
}

/// Write a small file beside the registry, atomically (the import ledger).
pub(crate) fn write_beside(name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    write_atomic(&agents_root()?.join(name), bytes)
}

pub fn delete(id: &str) -> Result<Agent, CommandError> {
    let removed = {
        let _guard = lock::take()?;
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
        removed
    };
    // Everything below takes other locks, the Keychain and the disk: never
    // under the registry lock (`store_lock.rs`). Policy's lock is taken
    // before the registry's when it writes a fresh file, so forgetting a
    // policy under the registry lock could wait on each other for ever.
    // It leaves its rooms; the rooms stay, with what it said in them.
    super::rooms::forget_agent(&removed.id);
    super::secrets::forget_all(&removed);
    super::connections::forget_agent(&removed.id);
    super::policy::forget(&removed.id);
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

/// Read without the lock: the file is only ever replaced whole.
pub fn trashed() -> Vec<Deleted> {
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
///
/// Its folder moves to the trash before the registry lock is taken, and
/// back if the registry can't be changed after all (`store_lock`: folder
/// I/O never runs under it). Nothing can restore it meanwhile: it isn't in
/// the trash list until the lock is held.
pub fn soft_delete(id: &str, by: Option<AgentRef>) -> Result<Agent, CommandError> {
    validate_id(id)?;
    // Refused before anything moves when it's already clear.
    if get(id)?.is_main {
        return Err(CommandError::expected(
            "The Chief of Staff can't be deleted.",
        ));
    }
    let root = agents_root()?;
    let trash = root.join(TRASH_DIR);
    std::fs::create_dir_all(&trash).map_err(|e| super::err_io(e.to_string()))?;
    let home = root.join(id);
    let kept = trash.join(id);
    let moved = if home.exists() {
        if kept.exists() {
            if let Err(e) = crate::utils::remove_dir_all_robust(&kept) {
                tracing::warn!(
                    "[Agents] couldn't clear an old trash folder before deleting {id}: {e}"
                );
            }
        }
        std::fs::rename(&home, &kept).map_err(|e| super::err_io(e.to_string()))?;
        true
    } else {
        false
    };
    let removed = soft_delete_entry(id, by);
    if removed.is_err() && moved {
        // Never lose it: the registry still names it, so its home goes back.
        if let Err(e) = std::fs::rename(&kept, &home) {
            tracing::error!(
                "[Agents] deleting {id} failed and its folder couldn't be put back from the trash: {e}"
            );
        }
    }
    let removed = removed?;
    if let Ok(log) = log_path(id) {
        forget_pending(&log);
    }
    Ok(removed)
}

/// [`soft_delete`]'s list half, under the lock: the trash list, then the registry.
fn soft_delete_entry(id: &str, by: Option<AgentRef>) -> Result<Agent, CommandError> {
    let _guard = lock::take()?;
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
    let entry = serde_json::to_value(&removed).map_err(super::err_other)?;
    let before = read_trash();
    let mut items = before.clone();
    items.retain(|d| d.id() != id);
    items.push(Deleted {
        agent: entry,
        deleted_at: now_ms(),
        deleted_by: by,
    });
    write_trash(&items)?;
    if let Err(e) = write_registry(&registry) {
        // Still on the team: it mustn't be in Recently deleted too.
        if let Err(undo) = write_trash(&before) {
            tracing::error!(
                "[Agents] deleting {id} failed and Recently deleted couldn't be put back: {undo}"
            );
        }
        return Err(e);
    }
    Ok(removed)
}

/// Bring a soft-deleted agent back as it was. Its name is kept unless another
/// agent took it meanwhile, in which case " (restored)" is added.
///
/// Its folder comes back from the trash before the registry lock is taken,
/// and goes back there if the registry can't be changed after all.
pub fn restore(id: &str) -> Result<Agent, CommandError> {
    validate_id(id)?;
    // Refused before anything moves when it's already clear.
    if !read_trash().iter().any(|d| d.id() == id) {
        return Err(CommandError::expected(
            "That agent isn't in Recently deleted any more.",
        ));
    }
    if list()?.iter().any(|a| a.id == id) {
        return Err(CommandError::expected("That agent is already on the team."));
    }
    let root = agents_root()?;
    let kept = root.join(TRASH_DIR).join(id);
    let home = root.join(id);
    let moved = if kept.exists() && !home.exists() {
        std::fs::rename(&kept, &home).map_err(|e| super::err_io(e.to_string()))?;
        true
    } else {
        false
    };
    let restored = restore_entry(id);
    if restored.is_err() && moved {
        if let Err(e) = std::fs::rename(&home, &kept) {
            tracing::error!(
                "[Agents] restoring {id} failed and its folder couldn't go back to the trash: {e}"
            );
        }
    }
    restored
}

/// [`restore`]'s list half, under the lock: the registry, then the trash list.
fn restore_entry(id: &str) -> Result<Agent, CommandError> {
    let _guard = lock::take()?;
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
    registry.agents.push(agent);
    // Its icon and key, or a free key when its own is taken by now.
    super::keys::fill(&mut registry.agents);
    let agent = registry.agents.last().cloned().expect("just pushed");
    write_registry(&registry)?;
    items.remove(index);
    if let Err(e) = write_trash(&items) {
        // Back on the team; Recently deleted still lists it, and restoring
        // it again says it's already here. Logged rather than undone.
        tracing::warn!("[Agents] restored {id}, but Recently deleted couldn't be updated: {e}");
    }
    Ok(agent)
}

/// How long a soft-deleted agent can be restored.
pub const TRASH_DAYS: i64 = 30;

/// The trash entries older than [`TRASH_DAYS`], taken out of the list (their
/// folders are removed); the caller forgets what else they held.
pub fn take_expired(now: i64) -> Vec<Agent> {
    let old = {
        // Busy: the next sweep takes them.
        let Ok(_guard) = lock::take() else {
            return Vec::new();
        };
        let items = read_trash();
        let cutoff = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
        // An entry for an agent that is on the team (a restore whose list
        // update failed) is only dropped: purging it would forget a live
        // agent's secrets and remove nothing of its own.
        let on_team: Vec<String> = match read_registry() {
            Ok(r) => r.agents.into_iter().map(|a| a.id).collect(),
            Err(e) => {
                tracing::warn!(
                    "[Agents] trash sweep skipped: the agents list couldn't be read: {e}"
                );
                return Vec::new();
            }
        };
        let (old, keep): (Vec<_>, Vec<_>) = items.into_iter().partition(|d| d.deleted_at < cutoff);
        if old.is_empty() {
            return Vec::new();
        }
        if let Err(e) = write_trash(&keep) {
            tracing::warn!("[Agents] trash sweep couldn't update Recently deleted: {e}");
            return Vec::new();
        }
        old.into_iter()
            .filter(|d| !on_team.iter().any(|id| id == d.id()))
            .collect::<Vec<_>>()
    };
    // Out of the list, so no one restores them: their folders go unlocked.
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

/// The app's own lines and cards name this build's computer (`computer`):
/// copy across the app says "this Mac", which on a PC reads "this PC". Only
/// what the app wrote: never the user's or an agent's words, nor a card's
/// exact tool call (`input`, and `detail` when it is that call). A no-op on a Mac.
pub fn localized(message: AgentMessage) -> AgentMessage {
    if crate::computer::NOUN == "Mac"
        || !matches!(
            message.kind,
            MessageKind::Note | MessageKind::Error | MessageKind::Approval
        )
    {
        return message;
    }
    let mut message = message;
    message.text = crate::computer::localize(&message.text).into_owned();
    if let Some(approval) = message.approval.take() {
        let skip: &[&str] = if approval.tool.is_some() {
            &["input", "detail", "tool"]
        } else {
            &["input", "tool"]
        };
        let localized = serde_json::to_value(&approval).ok().and_then(|mut v| {
            crate::computer::localize_json(&mut v, skip);
            serde_json::from_value(v).ok()
        });
        message.approval = Some(localized.unwrap_or(approval));
    }
    message
}

pub fn append_message(message: &AgentMessage) -> Result<(), CommandError> {
    // The app's own lines name this build's computer, whichever path wrote
    // them (`localized`; `runner::record` localizes before it announces).
    let localized_copy;
    let message = if crate::computer::NOUN != "Mac" {
        localized_copy = localized(message.clone());
        &localized_copy
    } else {
        message
    };
    // A line that doesn't say which conversation it was said in is the
    // conversation its agent's engine has loaded (`conversations::stamped`).
    // Read before the log's lock: the registry has a lock of its own.
    let stamped;
    let message = if message.conversation.is_none() && !message.agent_id.is_empty() {
        stamped = super::conversations::stamped(message);
        &stamped
    } else {
        message
    };
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

/// A log's text. Invalid UTF-8 (a crash mid-append, cut inside an emoji) is
/// replaced rather than failing the read: a torn last line used to make the
/// whole chat unreadable, where the parser skips just that line.
pub(crate) fn read_text(path: &Path) -> Result<String, CommandError> {
    match std::fs::read(path) {
        Ok(raw) => Ok(match String::from_utf8(raw) {
            Ok(text) => text,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        }),
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

/// A log's lines from its end backwards, newest first, read in growing
/// chunks only as far back as they are asked for. Lines come back raw: the
/// caller parses only those it keeps.
struct BackLines {
    file: Option<std::fs::File>,
    /// Where the bytes not yet read end (they start at 0).
    pos: u64,
    /// Read but not yet handed out: whole lines, and a cut one at the front.
    buf: Vec<u8>,
    chunk: u64,
}

impl BackLines {
    fn open(path: &Path) -> Result<Self, CommandError> {
        let file = match std::fs::File::open(path) {
            Ok(f) => Some(f),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(super::err_io(e.to_string())),
        };
        let pos = match &file {
            Some(f) => f
                .metadata()
                .map_err(|e| super::err_io(e.to_string()))?
                .len(),
            None => 0,
        };
        Ok(Self {
            file,
            pos,
            buf: Vec::new(),
            chunk: 64 * 1024,
        })
    }

    /// The next line back, raw, or `None` at the log's start. Empty lines
    /// are skipped.
    fn next_line(&mut self) -> Result<Option<Vec<u8>>, CommandError> {
        use std::io::{Read, Seek, SeekFrom};
        loop {
            while matches!(self.buf.last(), Some(b'\n' | b'\r')) {
                self.buf.pop();
            }
            if let Some(at) = self.buf.iter().rposition(|b| *b == b'\n') {
                let line = self.buf.split_off(at + 1);
                self.buf.truncate(at);
                return Ok(Some(line));
            }
            if self.pos == 0 {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(std::mem::take(&mut self.buf)));
            }
            let Some(file) = self.file.as_mut() else {
                return Ok(None);
            };
            let from = self.pos.saturating_sub(self.chunk);
            let mut more = vec![0u8; (self.pos - from) as usize];
            file.seek(SeekFrom::Start(from))
                .and_then(|_| file.read_exact(&mut more))
                .map_err(|e| super::err_io(e.to_string()))?;
            more.extend_from_slice(&self.buf);
            self.buf = more;
            self.pos = from;
            self.chunk = self.chunk.saturating_mul(2).min(4 * 1024 * 1024);
        }
    }
}

/// A raw log line as a message; invalid UTF-8 is replaced, as `read_text` does.
fn parse_line(line: &[u8]) -> serde_json::Result<AgentMessage> {
    serde_json::from_str(&String::from_utf8_lossy(line))
}

/// What a raw log line holds if it could be the message `id`: its
/// `"id":"…"`. Cheap, so lines newer than a page are never parsed; a hit is
/// confirmed by parsing (a peer or a result card has an id too).
fn id_needle(id: &str) -> String {
    format!("\"id\":{}", serde_json::to_string(id).unwrap_or_default())
}

/// [`messages_page`]'s read, for any log of messages (an agent's, a room's):
/// the `limit` messages before `before` (from the end if absent), reaching
/// back to `through` when that is older, at most `cap` in all. Read from the
/// end; lines after `before` are scanned, never parsed, and only the page is.
/// A `before` that isn't a message in the log yields nothing.
pub(crate) fn page_back(
    path: &Path,
    limit: usize,
    before: Option<&str>,
    through: Option<(&str, usize)>,
) -> Result<Vec<AgentMessage>, CommandError> {
    page_back_where(path, limit, before, through, &|_| true)
}

/// [`page_back`] counting only the lines `keep` takes (one conversation's).
fn page_back_where(
    path: &Path,
    limit: usize,
    before: Option<&str>,
    through: Option<(&str, usize)>,
    keep: &dyn Fn(&AgentMessage) -> bool,
) -> Result<Vec<AgentMessage>, CommandError> {
    let mut lines = BackLines::open(path)?;
    if let Some(id) = before {
        let needle = id_needle(id);
        loop {
            let Some(line) = lines.next_line()? else {
                return Ok(Vec::new());
            };
            let line = String::from_utf8_lossy(&line);
            if line.contains(needle.as_str())
                && serde_json::from_str::<AgentMessage>(&line).is_ok_and(|m| m.id == id)
            {
                break;
            }
        }
    }
    // Newest first while reading.
    let mut page: Vec<AgentMessage> = Vec::new();
    while page.len() < limit {
        let Some(line) = lines.next_line()? else {
            break;
        };
        if let Ok(m) = parse_line(&line) {
            if keep(&m) {
                page.push(m);
            }
        }
    }
    if let Some((id, cap)) = through {
        if page.len() == limit && !page.iter().any(|m| m.id == id) {
            let mut further: Vec<AgentMessage> = Vec::new();
            let mut found = false;
            while let Some(line) = lines.next_line()? {
                let Ok(m) = parse_line(&line) else {
                    continue;
                };
                if !keep(&m) {
                    continue;
                }
                let hit = m.id == id;
                further.push(m);
                if hit {
                    found = true;
                    break;
                }
            }
            if found {
                page.extend(further);
                page.truncate(cap);
            }
        }
    }
    page.reverse();
    Ok(page)
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
    let mut page = if limit == usize::MAX {
        let raw = read_text(&path)?;
        let all: Vec<AgentMessage> = raw
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let end = match before {
            Some(id) => all.iter().position(|m| m.id == id).unwrap_or(0),
            None => all.len(),
        };
        let mut all = all;
        all.truncate(end);
        all
    } else {
        page_back(&path, limit, before, through)?
    };
    apply_answers(agent_id, &mut page)?;
    Ok(page)
}

/// [`messages_page`] for one of the agent's conversations
/// (`conversations::of`): only its lines, paged the same way. A fork's
/// history (lines of the conversation it came from) comes before its own,
/// by id; lines it rewound past are in it too (the chat folds them).
pub fn conversation_page(
    agent_id: &str,
    conversation: &str,
    limit: usize,
    before: Option<&str>,
    through: Option<(&str, usize)>,
) -> Result<Vec<AgentMessage>, CommandError> {
    // Read before the log's lock: the list's is never held across it.
    let inherited = super::conversations::page_spec(agent_id, conversation).inherited;
    let keep =
        |m: &AgentMessage| super::conversations::of(m) == conversation || inherited.contains(&m.id);
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path(agent_id)?;
    let mut page = if limit == usize::MAX {
        let raw = read_text(&path)?;
        let mut all: Vec<AgentMessage> = raw
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let end = match before {
            Some(id) => all.iter().position(|m| m.id == id).unwrap_or(0),
            None => all.len(),
        };
        all.truncate(end);
        all.retain(keep);
        all
    } else {
        page_back_where(&path, limit, before, through, &keep)?
    };
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
/// One being answered right now is left to that answer (`answer_gate`).
pub fn expire_card(
    agent_id: &str,
    request_id: &str,
    expiry: super::expiry::Expiry,
) -> Result<Option<AgentMessage>, CommandError> {
    if super::answer_gate::in_flight(request_id) {
        return Ok(None);
    }
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

/// Cards that wait on the user. A "Save … as a skill?" card is an offer that
/// says "Nothing waits on it", so it never makes an agent "Needs your OK",
/// the Dock badge or the phone's Catch up count (`skills_learn`).
fn count_pending(log: &[AgentMessage]) -> u32 {
    log.iter()
        .filter(|m| {
            m.approval
                .as_ref()
                .is_some_and(|a| a.status == ApprovalStatus::Pending && a.skill.is_none())
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
        let changed =
            super::expiry::sweep_store(&agent.id, super::expiry::Moment::Launch, now_ms(), &|_| {
                false
            });
        if !changed.is_empty() {
            refresh_pending(&agent.id);
        }
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
