//! `method` → command function.
//!
//! The router owns what is the phone's alone: parameter parsing, Remote
//! Access's text refusals, the idempotent send, the rate limit and the audit
//! line. Everything else is the [`Backend`], whose desktop implementation
//! calls the same command functions the Agents view does, so the phone gets
//! the desk's emits, badge refresh and "Always allow" covering pass for free.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::wire::{MacStatus, ProtocolCode, WireError};
use super::{actor_for, now_ms, Companion};
use crate::errors::CommandError;

/// What this Mac serves. `welcome.methods` lists exactly these, so the app
/// hides everything else.
pub const METHODS: &[&str] = &[
    "system.status",
    "devices.self",
    "devices.unpairSelf",
    "devices.setPush",
    "agents.overview",
    "agents.messages",
    "agents.workSteps",
    "agents.send",
    "agents.stop",
    "agents.interrupt",
    "agents.stopStep",
    "agents.checkOn",
    "agents.answerApproval",
    "agents.saveSecret",
    "agents.loginStart",
    "agents.loginCancel",
    "agents.loginDecline",
    "agents.loginSaveKey",
    "agents.reach",
    "agents.policy",
    "agents.skills",
    "agents.skillEdit",
    "agents.skillRemove",
    "agents.onItsOwn",
    "agents.onItsOwnTeam",
    "agents.onItsOwnNarrow",
    "agents.loginsTeam",
    "agents.loginsConnect",
    "agents.loginDismiss",
    "agents.loginNotNeeded",
    "agents.loginsNotNeeded",
    "agents.loginsUndecline",
    "agents.loginsRecheck",
    "agents.loginPhoneBegin",
    "agents.loginPhoneFinish",
    "agents.apps",
    "agents.appsConnect",
    "agents.appsPhoneBegin",
    "agents.appsCancel",
    "agents.appsSetGrants",
    "agents.appsRemove",
    "agents.signinBegin",
    "agents.signinFrame",
    "agents.signinInput",
    "agents.signinDone",
    "agents.signinStop",
    "agents.signinFallback",
    "agents.stepInBegin",
    "agents.focus",
    "agents.markUnread",
    "agents.startFresh",
    "agents.conversations",
    "agents.conversationNew",
    "agents.conversationSelect",
    "agents.conversationRename",
    "agents.conversationRewind",
    "agents.conversationFork",
    "agents.conversationRoutine",
    "agents.page",
    "agents.pageVersion",
    "agents.pagePin",
    "agents.create",
    "agents.draft",
    "agents.templates",
    "agents.update",
    "agents.setDefaults",
    "agents.setIndependence",
    "agents.setImportChoice",
    "agents.setAdmin",
    "agents.setAgentIndependence",
    "agents.revokePermission",
    "agents.instructions",
    "agents.memory",
    "agents.memoryChange",
    "agents.memorySuggest",
    "agents.usage",
    "agents.quota",
    "agents.accounts",
    "agents.accounts.use",
    "agents.accounts.reorder",
    "agents.usagePlan",
    "agents.usage.setMode",
    "agents.spare.add",
    "agents.spare.spendNow",
    "agents.quietHours",
    "agents.setQuietHours",
    "agents.morningBrief",
    "agents.setMorningBrief",
    "agents.changeDiff",
    "agents.keepCopy",
    "agents.discardCopy",
    "agents.watchLive",
    "agents.files",
    "agents.fetchPath",
    "agents.search",
    "agents.schedule.preview",
    "agents.schedule.create",
    "agents.schedule.update",
    "agents.schedule.pause",
    "agents.schedule.cancel",
    "agents.schedule.runNow",
    "agents.watch.options",
    "agents.watch.create",
    "agents.watch.update",
    "agents.watch.checkNow",
    "rooms.list",
    "rooms.messages",
    "rooms.send",
    "rooms.focus",
    "projects.list",
    "sessions.read",
    "sessions.send",
    "sessions.key",
    "sessions.start",
    "preview.screenshot",
    "agents.import.status",
    "agents.import.start",
    "agents.import.stop",
    "agents.import.review",
    "agents.import.exportPrompt",
    "agents.import.exportPreview",
    "agents.import.exportReview",
    "agents.teamSetup",
    "agents.teamSetup.step",
    "agents.teamSetup.routine",
    "agents.teamSetup.hello",
    "agents.teamSetup.missing",
    "agents.teamSetup.dismiss",
    "agents.teamSetup.later",
    "agents.teamSetup.check",
];

/// `READ_ONLY_METHODS` in methods.ts (the served subset): not audited.
pub const READ_ONLY_METHODS: &[&str] = &[
    "system.status",
    "devices.self",
    "agents.overview",
    "agents.messages",
    "agents.conversations",
    "agents.page",
    "agents.pageVersion",
    "agents.workSteps",
    "agents.instructions",
    "agents.memory",
    "agents.reach",
    "agents.policy",
    "agents.skills",
    "agents.onItsOwn",
    "agents.onItsOwnTeam",
    "agents.loginsTeam",
    "agents.apps",
    "agents.usage",
    "agents.quota",
    "agents.accounts",
    "agents.usagePlan",
    "agents.quietHours",
    "agents.morningBrief",
    "agents.import.status",
    "agents.import.exportPrompt",
    "agents.import.exportPreview",
    "agents.teamSetup",
    "agents.templates",
    "agents.changeDiff",
    "agents.files",
    "agents.search",
    "agents.schedule.preview",
    "agents.watch.options",
    "rooms.list",
    "rooms.messages",
    "projects.list",
    "sessions.read",
];

/// Signing in on the Mac from the phone (`agents/phone_signin.rs`): never
/// audited by the router. Frames and inputs aren't audited at all (what's
/// typed is a password); the session writes its own line, the domain and
/// how it ended.
pub const SELF_AUDITED_METHODS: &[&str] = &[
    "agents.stepInBegin",
    "agents.signinBegin",
    "agents.signinFrame",
    "agents.signinInput",
    "agents.signinDone",
    "agents.signinStop",
    "agents.signinFallback",
];

/// How long a `clientId` is remembered.
const SEND_MEMORY_MS: u64 = 24 * 60 * 60 * 1000;
const SEND_MEMORY_MAX: usize = 10_000;
const MESSAGES_DEFAULT: usize = 400;
const MESSAGES_MAX: usize = 1_000;

/// A staged upload handed to `agents_send` as a file on disk, so the desk's
/// own `attachments::save` copies it in.
#[derive(Debug, Clone, PartialEq)]
pub struct Staged {
    pub name: String,
    pub path: std::path::PathBuf,
}

/// What `agents.send` carries besides the text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SendExtras {
    pub mentions: Vec<String>,
    pub attachments: Vec<Staged>,
    pub client_id: Option<String>,
    /// "Ask for changes": the result this message asks to revise.
    pub revises: Option<String>,
    /// The conversation it was sent in; `None` from an older phone (the one
    /// the user is in).
    pub conversation: Option<String>,
}

/// What `rooms.send` carries besides the room and the text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RoomSend {
    /// Agent ids the user @mentioned.
    pub mentions: Vec<String>,
    /// `@everyone`: every member answers.
    pub everyone: bool,
    pub client_id: Option<String>,
}

/// The schedule commands, one variant each.
#[derive(Debug, Clone, PartialEq)]
pub enum ScheduleOp {
    Preview {
        when: String,
    },
    Create {
        agent_id: String,
        when: String,
        note: String,
        /// Steps after the first, from a Mac listing `MAC_FEATURE_STEPS`.
        then: Option<Vec<crate::agents::routine_steps::Step>>,
    },
    Update {
        agent_id: String,
        id: String,
        when: String,
        note: String,
        /// `None` keeps its steps as they are.
        then: Option<Vec<crate::agents::routine_steps::Step>>,
    },
    Pause {
        agent_id: String,
        id: String,
        paused: bool,
    },
    Cancel {
        agent_id: String,
        id: String,
    },
    RunNow {
        agent_id: String,
        id: String,
    },
    /// What the "When…" composer may offer for this agent (`watch_options`).
    WatchOptions {
        agent_id: String,
    },
    /// Add a "When…" routine (`agents_watch_create`).
    WatchCreate {
        agent_id: String,
        source: crate::agents::watch::Source,
        every_minutes: u32,
        note: String,
    },
    /// Change one (`agents_watch_update`).
    WatchUpdate {
        agent_id: String,
        id: String,
        source: crate::agents::watch::Source,
        every_minutes: u32,
        note: String,
    },
    /// Check one now (`agents_watch_check_now`).
    WatchCheckNow {
        agent_id: String,
        id: String,
    },
}

impl ScheduleOp {
    /// The routine it acts on, when it names one.
    pub fn target(&self) -> Option<(&str, &str)> {
        match self {
            ScheduleOp::Update { agent_id, id, .. }
            | ScheduleOp::Pause { agent_id, id, .. }
            | ScheduleOp::Cancel { agent_id, id }
            | ScheduleOp::RunNow { agent_id, id }
            | ScheduleOp::WatchUpdate { agent_id, id, .. }
            | ScheduleOp::WatchCheckNow { agent_id, id } => Some((agent_id, id)),
            ScheduleOp::Preview { .. }
            | ScheduleOp::Create { .. }
            | ScheduleOp::WatchOptions { .. }
            | ScheduleOp::WatchCreate { .. } => None,
        }
    }
}

/// What the phone may change about an agent: the row's own toggles, its
/// instructions (the agent sheet shows them, so it can correct them), and
/// how it looks (`color`, from a Mac that lists
/// [`MAC_FEATURE_LOOKS`](super::wire::MAC_FEATURE_LOOKS), and its key). Its
/// name, role, model and project stay the desk's.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentToggles {
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    pub instructions: Option<String>,
    /// A look from before keys (a shape and a face), as an older phone
    /// sends it: accepted and ignored, since nothing draws it now.
    #[serde(default, rename = "avatar")]
    pub old_look: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    pub color: Option<String>,
    /// Its key, from a phone that saw
    /// [`MAC_FEATURE_AGENT_KEYS`](super::wire::MAC_FEATURE_AGENT_KEYS).
    #[serde(default)]
    pub colorway: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default, rename = "boundKey")]
    pub bound_key: Option<String>,
    /// `claude` or `codex`, from a Mac that lists
    /// [`MAC_FEATURE_ENGINE`](super::wire::MAC_FEATURE_ENGINE). The desk's own
    /// `agents_update` checks it is ready and starts a new session that
    /// carries the conversation over as a recap.
    #[serde(default)]
    pub engine: Option<String>,
    /// One of that engine's models; empty is the engine's own default.
    #[serde(default)]
    pub model: Option<String>,
    /// `low`, `medium` or `high`; empty is the engine's own default. From a
    /// Mac that lists [`MAC_FEATURE_EFFORT`](super::wire::MAC_FEATURE_EFFORT).
    #[serde(default)]
    pub effort: Option<String>,
    /// "Runs on": one of its engine's accounts, or empty for any account.
    /// From a Mac that serves `agents.accounts.use`.
    #[serde(default)]
    pub account: Option<String>,
    /// "Save new skills": `auto`, `ask` or `off`. From a Mac that
    /// serves `agents.skills`.
    #[serde(default, rename = "learnSkills")]
    pub learn_skills: Option<crate::agents::skills_learn::Learning>,
}

/// Instructions are a brief, not a document: the phone's editor stops here.
const MAX_INSTRUCTIONS: usize = 20_000;

/// What the phone may set on a new agent: what it should do, its name and
/// its colour, and optionally the ready-made agent it starts from (whose
/// briefing then becomes its instructions). Everything else is the desk's
/// create path's own default: the engine the desk would pick, the engine's
/// own model, no project, and no instructions beyond the role or template
/// (the agent sheet edits those afterwards).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneNewAgent {
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub color: Option<String>,
    /// A look from before keys, as an older phone sends it: accepted and
    /// ignored, since nothing draws it now.
    #[serde(default, rename = "avatar")]
    pub old_look: Option<serde::de::IgnoredAny>,
    /// Its key, as the phone's preview showed it (`MAC_FEATURE_AGENT_KEYS`).
    #[serde(default)]
    pub colorway: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub bound_key: Option<String>,
    /// An id from `agents.templates`.
    #[serde(default)]
    pub template: Option<String>,
    /// Its briefing, as reviewed after `agents.draft` (a Mac listing
    /// `MAC_FEATURE_DRAFT`). With a template too, this wins.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Routines to set up with it, the ones the user kept from a draft.
    #[serde(default)]
    pub routines: Vec<crate::agents::draft::NewRoutine>,
    /// The draft's welcome, first tasks and the apps its job needs
    /// (`agents::starters`).
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub starters: Vec<crate::agents::starters::Idea>,
    #[serde(default)]
    pub apps: Vec<String>,
}

/// "What should it do?" is one line, as the desk's field is.
const MAX_ROLE: usize = 500;
/// `store::validate_name`'s limit, checked here too so the refusal is the phone's.
const MAX_NAME: usize = 40;

/// The desk's editor starts a new agent on the first colour nobody wears
/// yet, leaving white and gray for the user to pick (`freeColor` in
/// AgentEditorModal.tsx). Purple when every colour is taken.
pub fn free_color(taken: &[String]) -> &'static str {
    crate::agents::store::COLORS
        .iter()
        .copied()
        .find(|c| *c != "white" && *c != "gray" && !taken.iter().any(|t| t == c))
        .unwrap_or("purple")
}

/// `agents.templates`: each ready-made agent as the phone's New agent sheet
/// offers it.
fn templates_for_phone() -> Value {
    Value::Array(
        crate::agents::templates::all()
            .iter()
            .map(|t| {
                serde_json::json!({
                    "id": t.id,
                    "title": t.title,
                    "name": t.name,
                    "role": t.role,
                    "color": t.color,
                    "needs": t.needs,
                })
            })
            .collect(),
    )
}

/// A name and a role, checked and tidied: one line each, no control
/// characters, within the desk's limits, and a colour the desk draws.
fn check_new_agent(input: PhoneNewAgent) -> Result<PhoneNewAgent, WireError> {
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    if input
        .name
        .chars()
        .chain(input.role.chars())
        .any(|c| c.is_control() && !c.is_whitespace())
    {
        return Err(WireError::protocol(
            ProtocolCode::Refused,
            "A name or role can't contain control characters.",
        ));
    }
    let name = one_line(&input.name);
    let role = one_line(&input.role);
    if name.is_empty() {
        return Err(bad_params("Give the agent a name."));
    }
    if name.chars().count() > MAX_NAME {
        return Err(bad_params(format!(
            "Keep the name under {MAX_NAME} characters."
        )));
    }
    if role.chars().count() > MAX_ROLE {
        return Err(bad_params(format!(
            "Say what it should do in under {MAX_ROLE} characters. The rest can go in its instructions."
        )));
    }
    let color = match input.color.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(c) if crate::agents::store::COLORS.contains(&c) => Some(c.to_string()),
        Some(c) => return Err(bad_params(format!("{c} isn't one of the agent colours."))),
    };
    let template = match input.template.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(id) => match crate::agents::templates::find(id) {
            Some(t) => Some(t.id.clone()),
            None => {
                return Err(bad_params(format!(
                    "{id} isn't one of the ready-made agents."
                )))
            }
        },
    };
    let instructions = match input.instructions.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(text) => {
            refuse_unsafe_text(text, "Its instructions")?;
            if text.chars().count() > MAX_INSTRUCTIONS {
                return Err(bad_params(format!(
                    "Keep its instructions under {MAX_INSTRUCTIONS} characters."
                )));
            }
            Some(text.to_string())
        }
    };
    if input.routines.len() > crate::agents::draft::MAX_ROUTINES {
        return Err(bad_params(format!(
            "At most {} routines with a new agent.",
            crate::agents::draft::MAX_ROUTINES
        )));
    }
    // A routine's words are prompts sent later with nobody watching.
    for r in &input.routines {
        refuse_unsafe_text(&r.note, "A routine's note")?;
        for step in &r.then {
            refuse_unsafe_text(&step.text, "A routine's step")?;
        }
    }
    // A starter is sent as the user's message when tapped.
    use crate::agents::starters::{MAX_IDEAS, MAX_WELCOME};
    if input.starters.len() > MAX_IDEAS || input.apps.len() > crate::agents::draft::MAX_APPS {
        return Err(bad_params("Too many first tasks or apps for a new agent."));
    }
    for text in input
        .welcome
        .iter()
        .chain(input.starters.iter().map(|s| &s.text))
    {
        refuse_unsafe_text(text, "Its first words")?;
        if text.chars().count() > MAX_WELCOME {
            return Err(bad_params("Keep its first words short."));
        }
    }
    Ok(PhoneNewAgent {
        name,
        role,
        color,
        old_look: None,
        colorway: input.colorway,
        icon: input.icon,
        bound_key: input.bound_key,
        template,
        instructions,
        routines: input.routines,
        welcome: input.welcome,
        starters: input.starters,
        apps: input.apps,
    })
}

/// A look the phone sent: keys this Mac draws, or a refusal naming them.
/// Import without Remote access from the phone (`agents::import_export`):
/// the message to send, what a pasted reply holds, and the review card.
#[derive(Debug, Clone, PartialEq)]
pub enum ImportExportAction {
    Prompt,
    Preview(String),
    Review(String),
}

/// "Setting up your team" from the phone (`agents::team_setup`): the same
/// commands the desk's card calls.
#[derive(Debug, Clone, PartialEq)]
pub enum TeamSetupAction {
    /// The checklist (`any` brings back one put away).
    Get {
        any: bool,
    },
    Step {
        step: crate::agents::team_setup::StepId,
        state: crate::agents::team_setup::StepState,
    },
    Routine {
        agent_id: String,
        check_in_id: String,
        on: bool,
    },
    /// "Say hi": the user's hello, which wakes that one agent.
    Hello {
        agent_id: String,
    },
    /// Everything they said they're missing, to the Chief in one message.
    Missing,
    Dismiss,
    /// A row nothing reached: `connect` (one sign-in card, its way in
    /// started on the Mac) or `not_needed`.
    Later {
        key: String,
        connect: bool,
        on_phone: bool,
    },
    /// Check again what the team can already reach.
    Check,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalAnswer {
    pub agent_id: String,
    pub request_id: String,
    pub allow: bool,
    pub always: Option<bool>,
    pub note: Option<String>,
    /// On a session's question: the option picked, by index.
    pub choice: Option<usize>,
}

/// A memory entry is a line worth keeping, not a document.
const MAX_MEMORY_CHARS: usize = 2_000;
/// "Remember this" summarises one message; longer is cut, as on the desk.
const MAX_SUGGEST_CHARS: usize = 20_000;
/// A secret's parts: a username and password is the most a card asks for.
const MAX_SECRET_FIELDS: usize = 8;
const MAX_SECRET_CHARS: usize = 8_192;

/// Everything outside the companion it needs: the agents, the Mac, the
/// audit log and the Phone panel. The desktop implementation is in
/// `desktop.rs`; tests use a stub agent.
#[async_trait]
pub trait Backend: Send + Sync + 'static {
    /// The host names `tailscale serve` publishes this Mac on, as
    /// `identity::host_of` reads them: what the Mac signs before a phone
    /// sends anything secret, so the phone can tell it reached the Mac
    /// itself and not something relaying it.
    fn serve_hosts(&self) -> Vec<String>;
    async fn overview(&self) -> Result<Value, CommandError>;
    /// A page of messages, oldest first, ending just before `before` (or at
    /// the newest). The flag: older ones exist.
    async fn messages(
        &self,
        agent_id: &str,
        limit: usize,
        before: Option<&str>,
        conversation: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError>;
    /// `agents_conversations`: the agent's conversations and which one the
    /// user is in.
    async fn conversations(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_conversation_new`, `_select` and `_rename`: the list after.
    async fn conversation_new(&self, agent_id: &str) -> Result<Value, CommandError>;
    async fn conversation_select(&self, agent_id: &str, id: &str) -> Result<Value, CommandError>;
    async fn conversation_rename(
        &self,
        agent_id: &str,
        id: &str,
        title: String,
    ) -> Result<Value, CommandError>;
    /// `agents_conversation_rewind` / `_fork`: gone back to just before the
    /// user's message, in place or as a new conversation; the list after.
    async fn conversation_rewind(
        &self,
        agent_id: &str,
        id: &str,
        message_id: &str,
    ) -> Result<Value, CommandError>;
    async fn conversation_fork(
        &self,
        agent_id: &str,
        id: &str,
        message_id: &str,
    ) -> Result<Value, CommandError>;
    /// `agents_conversation_routine`: a routine moved to another
    /// conversation; the list after.
    async fn conversation_routine(
        &self,
        agent_id: &str,
        routine_id: &str,
        id: &str,
    ) -> Result<Value, CommandError>;
    /// `agents_page`: the conversation's living page (`agents/page.rs`),
    /// or null. `None` is the conversation the user is in.
    async fn page(&self, agent_id: &str, conversation: Option<&str>)
        -> Result<Value, CommandError>;
    /// `agents_page_version`: one kept version, or null.
    async fn page_version(
        &self,
        agent_id: &str,
        conversation: Option<&str>,
        version: u32,
    ) -> Result<Value, CommandError>;
    /// `agents_page_pin`: pinned above the chat, or not; the page after.
    async fn page_pin(
        &self,
        agent_id: &str,
        conversation: Option<&str>,
        pinned: bool,
    ) -> Result<Value, CommandError>;
    async fn send(
        &self,
        agent_id: &str,
        text: String,
        extras: SendExtras,
    ) -> Result<Value, CommandError>;
    async fn stop(&self, agent_id: &str) -> Result<bool, CommandError>;
    async fn interrupt(&self, agent_id: &str) -> Result<bool, CommandError>;
    /// "Stop this step" (`agents_stop_step`): what it did, in words.
    async fn stop_step(&self, agent_id: &str) -> Result<String, CommandError>;
    /// "Check on it" (`agents_check_on`): what the Mac sees, in one line.
    async fn check_on(&self, agent_id: &str) -> Result<String, CommandError>;
    async fn answer_approval(&self, answer: ApprovalAnswer) -> Result<(), CommandError>;
    /// `agents_focus` for a socket instead of a window.
    async fn focus(&self, label: &str, agent_id: Option<String>) -> Result<(), CommandError>;
    async fn mark_unread(&self, agent_id: &str) -> Result<(), CommandError>;
    /// `agents_start_fresh`: a new conversation, memory kept. Returns the
    /// stored agent.
    async fn start_fresh(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_create` with what the phone may set, on the engine the desk
    /// would pick (`engine::default_for`) and a free colour when none was
    /// picked. Returns the stored agent.
    async fn create_agent(&self, input: PhoneNewAgent) -> Result<Value, CommandError>;
    /// `agents_draft`: "Describe the agent you want", drafted for review.
    /// Nothing is created.
    async fn draft_agent(&self, description: String) -> Result<Value, CommandError>;
    /// `agents_update` with only the toggles set; returns the stored agent.
    async fn update_agent(
        &self,
        agent_id: &str,
        toggles: AgentToggles,
    ) -> Result<Value, CommandError>;
    /// `agents_save_secret`: a secure input card's values into the Keychain.
    /// Returns the saved `AgentSecret` (never a value).
    async fn save_secret(
        &self,
        agent_id: &str,
        request_id: &str,
        values: Vec<String>,
    ) -> Result<Value, CommandError>;
    /// `agents_memory`: the agent's memory entries.
    async fn memory(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_memory_change`: add, edit or delete one entry.
    async fn memory_change(&self, agent_id: &str, change: Value) -> Result<Value, CommandError>;
    /// `agents_memory_suggest`: a message as one line worth keeping.
    async fn memory_suggest(&self, text: String) -> Result<String, CommandError>;
    /// `agents_instructions`: the agent's brief, as the Edit agent sheet shows it.
    async fn instructions(&self, agent_id: &str) -> Result<String, CommandError>;
    /// `agents_usage`: this week and all time.
    async fn usage(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_set_defaults`: what new agents start on (Settings → Agents).
    /// Checked as the desk checks it: a ready engine, a model it offers.
    async fn set_defaults(
        &self,
        change: crate::agents::defaults::Change,
    ) -> Result<Value, CommandError>;
    /// `agents_set_independence`: how much agents do on their own. Changes
    /// what they're told, never what asks for the user's OK.
    async fn set_independence(
        &self,
        level: crate::agents::independence::Level,
    ) -> Result<Value, CommandError>;
    /// `agents_set_import_choice`: "bring your agents, or start fresh?"
    /// answered from the phone (its home card). Additive: newer Macs only.
    async fn set_import_choice(
        &self,
        choice: crate::agents::import_choice::Choice,
    ) -> Result<Value, CommandError>;
    /// `agents_set_admin`: the user's own switch, "Admin — can manage and
    /// approve for other agents". Answers `{ agentId, admin }`.
    async fn set_admin(&self, agent_id: &str, admin: bool) -> Result<Value, CommandError>;
    /// `agents_policy_set` for one agent's level: its own, or `None` for
    /// the team's. The user choosing it, so it applies at once (a raise from
    /// chat needs a card; this isn't chat). Answers `{ agentId, level }`.
    async fn set_agent_independence(
        &self,
        agent_id: &str,
        level: Option<crate::agents::independence::Level>,
    ) -> Result<Value, CommandError>;
    /// `agents_quota`: each engine's plan, as it last reported it.
    async fn quota(&self) -> Result<Value, CommandError>;
    /// `agents_accounts`: each engine's usage accounts, read-only.
    async fn accounts(&self) -> Result<Value, CommandError>;
    /// `agents_account_use`: "Use this one now", the account first in its
    /// engine's order. Answers the accounts as `agents.accounts` does.
    /// Never a token: the phone only ever names an account by its id.
    async fn account_use(&self, engine: &str, id: &str) -> Result<Value, CommandError>;
    /// `agents_account_reorder`: an engine's accounts in this order.
    /// Answers the accounts as `agents.accounts` does.
    async fn account_reorder(&self, engine: &str, ids: Vec<String>) -> Result<Value, CommandError>;
    /// `agents_usage_overview`: the capacity inventory, read-only.
    async fn usage_plan(&self) -> Result<Value, CommandError>;
    /// `agents_set_usage_mode`: the user chose a usage mode (no card: their
    /// own choice, as in Settings). Answers the inventory.
    async fn usage_set_mode(&self, mode: &str) -> Result<Value, CommandError>;
    /// `agents_spare_add`: something for the list of ideas for leftover usage, by "you".
    /// Answers the inventory.
    async fn spare_add(&self, text: &str, agent_id: Option<&str>) -> Result<Value, CommandError>;
    /// `agents_spare_spend_now`: "Give agents something to do". Answers `{ line }`.
    async fn spare_spend_now(&self) -> Result<Value, CommandError>;
    /// `agents_quiet_hours`: the team's quiet hours, `{ window }` (null when off).
    async fn quiet_hours(&self) -> Result<Value, CommandError>;
    /// `agents_set_quiet_hours`: set them, or `None` for off. They only
    /// hold things back, so the user's choice applies at once. Answers as
    /// `quiet_hours`.
    async fn set_quiet_hours(
        &self,
        window: Option<crate::agents::quiet::Window>,
    ) -> Result<Value, CommandError>;
    /// `agents_morning_brief`: on or off, its time (minutes after midnight),
    /// `always`, the user's checks, and when one was last posted.
    async fn morning_brief(&self) -> Result<Value, CommandError>;
    /// `agents_set_morning_brief`: on or off, its time and `always`. The
    /// checks stay as they are (they're set on the Mac or from chat).
    /// Answers as `morning_brief`.
    async fn set_morning_brief(
        &self,
        on: bool,
        at: u32,
        always: bool,
    ) -> Result<Value, CommandError>;
    /// An import from another assistant, as the phone follows it: whether
    /// this Mac's Remote access is on and has been reached, whether an import
    /// may begin, the one going on, and the message to send. Never the link:
    /// it's a key, and only the Mac copies it (`remote_access` "Security").
    async fn import_status(&self) -> Result<Value, CommandError>;
    /// Start: one import may begin (`connector::arm`). It still asks on a
    /// card in the Chief's chat first.
    async fn import_start(&self) -> Result<Value, CommandError>;
    /// Stop the import (`connector::stop`).
    async fn import_stop(&self) -> Result<Value, CommandError>;
    /// `Prompt`: the message (text); `Preview`: what a reply holds;
    /// `Review`: its review card in the Chief's chat (`{chiefId, requestId, agents}`).
    async fn import_export(&self, action: ImportExportAction) -> Result<Value, CommandError>;
    /// Import from a review card, from the phone: the kept agents come in as
    /// new agents (a taken name as a copy), never replacing one here, and the
    /// Chief's notes (what the other assistant told it, by area) only when
    /// `notes`. Replace stays on the Mac, where its diff and consequences are
    /// on screen.
    async fn import_review(
        &self,
        agent_id: &str,
        request_id: &str,
        keys: Vec<String>,
        notes: bool,
    ) -> Result<Value, CommandError>;
    /// "Setting up your team": `agents_team_setup*`. `Get` answers the
    /// checklist or `null`; `Hello` and `Missing` the message they sent;
    /// the rest `null`.
    async fn team_setup(&self, action: TeamSetupAction) -> Result<Value, CommandError>;
    /// `agents_revoke_permission`: an "Always allow" rule taken back.
    async fn revoke_permission(&self, agent_id: &str, rule_id: &str) -> Result<(), CommandError>;
    /// `agents_login_start`: one of a login card's ways in, started on this
    /// Mac (its browser opens here; the token is made and kept here). The
    /// card follows it on both devices.
    async fn login_start(
        &self,
        agent_id: &str,
        request_id: &str,
        option_id: &str,
        on_phone: bool,
    ) -> Result<(), CommandError>;
    /// `login_relay::begin`: a phone sign-in sheet's URL, the PKCE verifier
    /// and `state` kept on this Mac, bound to `device_id`.
    async fn login_phone_begin(
        &self,
        device_id: &str,
        target: crate::agents::login_relay::Target,
        option_id: &str,
    ) -> Result<Value, CommandError>;
    /// `login_relay::finish`: the sheet's one-time code, from the device
    /// that started it, exchanged and kept here.
    async fn login_phone_finish(
        &self,
        device_id: &str,
        flow_id: &str,
        callback: &str,
    ) -> Result<(), CommandError>;
    /// Signing in on this Mac's Chrome from the phone
    /// (`agents/phone_signin.rs`), for the paired device calling.
    async fn phone_signin(
        &self,
        device_id: &str,
        device_name: &str,
        op: crate::agents::phone_signin::Op,
    ) -> Result<Value, CommandError>;
    /// `agents_login_cancel`: stop a sign-in under way.
    async fn login_cancel(&self, agent_id: &str, request_id: &str) -> Result<(), CommandError>;
    /// `agents_login_decline`.
    async fn login_decline(
        &self,
        agent_id: &str,
        request_id: &str,
        note: Option<String>,
    ) -> Result<(), CommandError>;
    /// `agents_login_save_key`: a login card's API key into the Keychain.
    async fn login_save_key(
        &self,
        agent_id: &str,
        request_id: &str,
        value: String,
    ) -> Result<Value, CommandError>;
    /// `agents_reach`: what an agent can reach. Read-only on the phone.
    async fn reach(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_policy`: "What it can do". Read-only on the phone; changed in chat.
    async fn policy(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_skills`: "Skills" and its setting.
    async fn skills(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_skill_edit`: the user's edit of one skill.
    async fn skill_edit(&self, agent_id: &str, edit: SkillEdit) -> Result<Value, CommandError>;
    /// `agents_skill_remove`: one skill removed.
    async fn skill_remove(&self, agent_id: &str, slug: &str) -> Result<(), CommandError>;
    /// `agents_on_its_own`: what it may do without asking, in plain words.
    async fn on_its_own(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_on_its_own_team`: the same for the team.
    async fn on_its_own_team(&self) -> Result<Value, CommandError>;
    /// `agents_on_its_own_narrow`: take one thing away (never gives).
    async fn on_its_own_narrow(&self, agent_id: &str, narrow: Value)
        -> Result<Value, CommandError>;
    /// `agents_logins_team`: "What your team needs", one row per service.
    async fn logins_team(&self, since: Option<i64>) -> Result<Value, CommandError>;
    /// `agents_logins_connect`: one row's way in, for every agent on it but `skip`.
    async fn logins_connect(
        &self,
        key: &str,
        option_id: &str,
        skip: Vec<String>,
        on_phone: bool,
    ) -> Result<(), CommandError>;
    /// `agents_login_dismiss`: put one agent's card away.
    async fn login_dismiss(&self, agent_id: &str, request_id: &str) -> Result<(), CommandError>;
    /// `agents_login_not_needed`: the card's service, declined for the team
    /// and remembered. The receipt (`keys`, `line`, `closed`).
    async fn login_not_needed(
        &self,
        agent_id: &str,
        request_id: &str,
    ) -> Result<Value, CommandError>;
    /// `agents_logins_not_needed`: rows of "What your team needs", or every
    /// row still waiting ("Skip the rest") when `keys` is `None`.
    async fn logins_not_needed(&self, keys: Option<Vec<String>>) -> Result<Value, CommandError>;
    /// `agents_logins_undecline`: Undo, or turn back on. How many cards came back.
    async fn logins_undecline(&self, keys: Vec<String>) -> Result<Value, CommandError>;
    /// `agents_logins_recheck`: the user is back; check claude.ai connectors now.
    async fn logins_recheck(&self) -> Result<(), CommandError>;
    /// "Apps your agents can use" (`agents_app_connections`), as the phone
    /// sees it (`app_connect::phone_overview`): no token, no Mac-only page.
    async fn apps(&self) -> Result<Value, CommandError>;
    /// `agents_app_connect`: sign in to one of our apps in this Mac's
    /// browser, for exactly the agents ticked.
    async fn apps_connect(
        &self,
        service: &str,
        grants: Vec<crate::agents::app_connect::GrantInput>,
        again: Option<String>,
    ) -> Result<(), CommandError>;
    /// `app_connect::phone_begin`: the same sign-in in the phone's sheet;
    /// the verifier and `state` kept here, bound to `device_id`. Finished
    /// by `agents.loginPhoneFinish`.
    async fn apps_phone_begin(
        &self,
        device_id: &str,
        service: &str,
        grants: Vec<crate::agents::app_connect::GrantInput>,
        again: Option<String>,
    ) -> Result<Value, CommandError>;
    /// `agents_app_connect_cancel`: Stop.
    async fn apps_cancel(&self, service: &str) -> Result<(), CommandError>;
    /// `agents_connection_set_grants`: exactly these agents, each as ticked.
    /// The user's own answer, as on the desk, so it can narrow or widen.
    async fn apps_set_grants(
        &self,
        connection_id: &str,
        grants: Vec<crate::agents::app_connect::GrantInput>,
    ) -> Result<Value, CommandError>;
    /// `agents_connection_delete`: the connection and its Keychain token.
    async fn apps_remove(&self, connection_id: &str) -> Result<(), CommandError>;
    /// `agents_turn_work`: what the turn ending on `message_id` did, steps
    /// and all (a `TurnWork`), or null when nothing was kept.
    async fn turn_work(&self, agent_id: &str, message_id: &str) -> Result<Value, CommandError>;
    /// `agents_change_diff`: one file of a change card.
    async fn change_diff(
        &self,
        agent_id: &str,
        message_id: &str,
        path: &str,
    ) -> Result<Value, CommandError>;
    /// `agents_copy_keep`: the agent's copy of its project, kept. Returns
    /// `Kept` (`{outcome: kept|nothing|conflict}`).
    /// `into` names the project's current branch when the user confirmed
    /// keeping there after an `otherBranch` answer.
    async fn keep_copy(
        &self,
        agent_id: &str,
        copy_id: &str,
        into: Option<&str>,
    ) -> Result<Value, CommandError>;
    /// `agents_copy_discard`: the agent's copy of its project, discarded.
    async fn discard_copy(&self, agent_id: &str, copy_id: &str) -> Result<(), CommandError>;
    /// `agents_files`: everything shared in one conversation, newest first.
    async fn files(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// A path from an agent's reply, resolved as `share_file` resolves it
    /// (its home and the user's projects; folders refused).
    async fn shareable_path(
        &self,
        agent_id: &str,
        path: &str,
    ) -> Result<std::path::PathBuf, CommandError>;
    async fn search(&self, query: String) -> Result<Value, CommandError>;
    async fn schedule(&self, op: ScheduleOp) -> Result<Value, CommandError>;
    /// `agents_rooms`: every room, with what is happening in it now.
    async fn rooms(&self) -> Result<Value, CommandError>;
    /// A page of a room's thread, oldest first, ending just before `before`.
    /// The flag: older lines exist.
    async fn room_messages(
        &self,
        room_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError>;
    /// `agents_room_send`: returns `{message, asked}`.
    async fn room_send(
        &self,
        room_id: &str,
        text: String,
        send: RoomSend,
    ) -> Result<Value, CommandError>;
    /// `agents_room_focus` for a socket instead of a window.
    async fn room_focus(&self, label: &str, room_id: Option<String>) -> Result<(), CommandError>;
    /// Every project as `ProjectSummary[]`.
    async fn projects(&self) -> Result<Value, CommandError>;
    /// One agent tab's screen as a `SessionScreen`.
    async fn session_screen(&self, session_id: &str) -> Result<Value, CommandError>;
    /// Type cleaned `text` into an agent tab of `project` (the given one, or
    /// the live one that printed last) and press Enter, with Remote
    /// Access's refusals. Returns the tab's session id.
    async fn session_send(
        &self,
        project: &str,
        session_id: Option<&str>,
        text: &str,
    ) -> Result<String, CommandError>;
    /// Press `key` (already one `key_bytes` knows) in an agent tab.
    async fn session_key(&self, session_id: &str, key: &str) -> Result<(), CommandError>;
    /// Open a new agent tab in `project` that starts on cleaned `prompt`
    /// (Remote Access's `start_agent`). Returns its session id once the tab exists.
    async fn session_start(&self, project: &str, prompt: &str) -> Result<String, CommandError>;
    /// The project's live preview as a JPEG, captured for the phone alone.
    async fn preview_screenshot(&self, project: &str, phone: bool)
        -> Result<Vec<u8>, CommandError>;
    /// "Watch live": the port of the running dev server a card previews
    /// (`preview_test::resolve`), refused when nothing is serving it.
    async fn watch_port(
        &self,
        agent_id: &str,
        message_id: &str,
        link: Option<usize>,
    ) -> Result<(String, u16), CommandError>;
    /// Publish the watch proxy on the tailnet (lazily, once): its base URL.
    async fn watch_publish(&self) -> Result<String, CommandError>;
    /// An attachment's file: `attachments::resolve` under the agent's home.
    fn attachment_file(
        &self,
        agent_id: &str,
        rel: &str,
    ) -> Result<std::path::PathBuf, CommandError>;
    async fn mac_status(&self) -> MacStatus;
    fn server_name(&self) -> String;
    fn app_version(&self) -> String;
    fn audit(&self, actor: &str, tool: &str, detail: String, ok: bool);
    /// Something the Phone panel shows changed (a pair request, a connect).
    fn changed(&self);
}

/// `clientId` → the message that send produced, for 24 hours. Concurrent
/// retries wait on the first; a failed send isn't remembered, so it can be
/// tried again.
#[derive(Default)]
pub struct SendCache {
    map: Mutex<HashMap<String, Sent>>,
}

/// When a `clientId` was first seen, and its send's result once it has one.
type Sent = (u64, Arc<tokio::sync::OnceCell<Value>>);

impl SendCache {
    pub async fn once<F, Fut>(&self, key: String, now: u64, send: F) -> Result<Value, WireError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value, WireError>>,
    {
        let cell = {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            map.retain(|_, (at, _)| now.saturating_sub(*at) < SEND_MEMORY_MS);
            if map.len() >= SEND_MEMORY_MAX {
                if let Some(oldest) = map
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone())
                {
                    map.remove(&oldest);
                }
            }
            map.entry(key)
                .or_insert_with(|| (now, Arc::new(tokio::sync::OnceCell::new())))
                .1
                .clone()
        };
        cell.get_or_try_init(send).await.cloned()
    }
}

/// Who is calling: one socket of one paired device.
#[derive(Debug, Clone)]
pub struct Caller {
    pub device_id: String,
    pub device_name: String,
    /// `notify::set_showing`'s key for this socket.
    pub label: String,
    /// How this socket reached the Mac. Today always `Tailscale`: the
    /// listener is loopback-only and `tailscale serve` is the one way in.
    /// It is a label, not a check. What keeps a secret from going to the
    /// wrong server is the phone's: it sends one only on a socket whose
    /// `welcome` was signed by the identity key it pinned at pairing.
    pub route: super::wire::RouteKind,
    /// What its app said it shows (`hello.features`).
    pub shows: super::wire::Shows,
}

/// Remote Access's refusals for text that becomes an agent's words later
/// (its instructions, a routine's note): no control characters but newline
/// and tab, no leading `!` (Claude Code's shell mode) and no `/` command
/// outside the allowlist. Refused rather than cleaned, so what's saved is
/// what the person wrote. Empty text is left to the caller.
fn refuse_unsafe_text(text: &str, what: &str) -> Result<(), WireError> {
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
    {
        return Err(WireError::protocol(
            ProtocolCode::Refused,
            format!("{what} can't contain control characters."),
        ));
    }
    if text.trim().is_empty() {
        return Ok(());
    }
    crate::remote_access::tools::check_message_kind(text)
        .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))
}

fn bad_params(e: impl std::fmt::Display) -> WireError {
    WireError::protocol(ProtocolCode::BadParams, e.to_string())
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, WireError> {
    // `{}` and an absent params object are the same thing.
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params).map_err(bad_params)
}

/// `devices.setPush`: a token, or `null` to stop.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPushParams {
    token: Option<String>,
    #[serde(default)]
    environment: Option<super::push::PushEnvironment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentParam {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillParams {
    agent_id: String,
    slug: String,
}

/// One skill as the phone's editor sends it back.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SkillEdit {
    pub slug: String,
    pub name: String,
    pub when: String,
    pub steps: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillEditParams {
    agent_id: String,
    #[serde(flatten)]
    edit: SkillEdit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrowParams {
    agent_id: String,
    narrow: Value,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TeamSetupGetParams {
    #[serde(default)]
    any: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSetupStepParams {
    step: crate::agents::team_setup::StepId,
    state: crate::agents::team_setup::StepState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSetupLaterParams {
    key: String,
    action: String,
    #[serde(default)]
    on_phone: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSetupRoutineParams {
    agent_id: String,
    check_in_id: String,
    on: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportTextParams {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportReviewParams {
    agent_id: String,
    request_id: String,
    keys: Vec<String>,
    /// Also add what the other assistant told the Chief (its notes, by
    /// area), as the Mac's card offers. Off unless the phone says so.
    #[serde(default)]
    notes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesParams {
    agent_id: String,
    limit: Option<usize>,
    before: Option<String>,
    /// `"summary"`: timelines without their steps (`stepsOmitted`), read
    /// with `agents.workSteps` as one opens. An older Mac ignores it and
    /// sends them inline, as it does for a phone that doesn't ask.
    work: Option<String>,
    /// One of the agent's conversations; absent (an older phone): all of them.
    #[serde(default)]
    conversation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationParams {
    agent_id: String,
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRenameParams {
    agent_id: String,
    conversation_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageParams {
    agent_id: String,
    /// Absent: the conversation the user is in.
    #[serde(default)]
    conversation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageVersionParams {
    agent_id: String,
    #[serde(default)]
    conversation_id: Option<String>,
    version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PagePinParams {
    agent_id: String,
    #[serde(default)]
    conversation_id: Option<String>,
    pinned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationMessageParams {
    agent_id: String,
    conversation_id: String,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRoutineParams {
    agent_id: String,
    routine_id: String,
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkStepsParams {
    agent_id: String,
    message_id: String,
}

#[derive(Deserialize)]
struct BlobParam {
    #[serde(rename = "blobId")]
    blob_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathParams {
    agent_id: String,
    path: String,
}

#[derive(Deserialize)]
struct QueryParams {
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftParams {
    description: String,
}

#[derive(Deserialize)]
struct WhenParams {
    when: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleParams {
    agent_id: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    when: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    then: Option<Vec<crate::agents::routine_steps::Step>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchRoutineParams {
    agent_id: String,
    #[serde(default)]
    id: String,
    source: crate::agents::watch::Source,
    every_minutes: u32,
    #[serde(default)]
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateParams {
    input: PhoneNewAgent,
    #[serde(default)]
    client_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    agent_id: String,
    input: AgentToggles,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSendParams {
    project: String,
    session_id: Option<String>,
    text: String,
    client_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginParams {
    agent_id: String,
    request_id: String,
    #[serde(default)]
    option_id: String,
    #[serde(default)]
    note: Option<String>,
    /// The sign-in is on the phone (claude.ai there, a device code), so the
    /// Mac doesn't open its own browser. Older phones omit it.
    #[serde(default)]
    on_phone: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneBeginParams {
    option_id: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    /// A team row instead of one card.
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    skip: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigninBeginParams {
    agent_id: String,
    request_id: String,
    /// "agents_browser" / "chrome": the phone asked for that way.
    #[serde(default)]
    way: Option<crate::agents::phone_signin::Via>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepInBeginParams {
    agent_id: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigninParams {
    session_id: String,
    #[serde(default)]
    anyway: bool,
    /// `agents.signinFrame`: the picture the phone has.
    #[serde(default)]
    after: Option<u64>,
}

/// `Debug` is `Input`'s: never what was typed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigninInputParams {
    session_id: String,
    input: crate::agents::phone_signin::Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneFinishParams {
    flow_id: String,
    /// The redirect the sign-in sheet came back with. Never logged.
    callback_url: String,
}

/// The most agents one connection's grants can name: more than any team.
const MAX_GRANTS: usize = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppsConnectParams {
    service: String,
    #[serde(default)]
    grants: Vec<crate::agents::app_connect::GrantInput>,
    /// The connection to sign in again (it needs it).
    #[serde(default)]
    again: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppsServiceParams {
    service: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppsGrantsParams {
    connection_id: String,
    grants: Vec<crate::agents::app_connect::GrantInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppsConnectionParams {
    connection_id: String,
}

fn checked_connect(p: &AppsConnectParams) -> Result<(), WireError> {
    if p.service.is_empty() || p.service.len() > 100 {
        return Err(bad_params("Which app?"));
    }
    if p.grants.len() > MAX_GRANTS
        || p.again
            .as_ref()
            .is_some_and(|a| a.is_empty() || a.len() > 200)
    {
        return Err(bad_params("Which agents, and which connection?"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamParams {
    #[serde(default)]
    since: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclineParams {
    #[serde(default)]
    keys: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamConnectParams {
    key: String,
    option_id: String,
    #[serde(default)]
    skip: Vec<String>,
    #[serde(default)]
    on_phone: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginKeyParams {
    agent_id: String,
    request_id: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleParams {
    agent_id: String,
    rule_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffParams {
    agent_id: String,
    message_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchParams {
    agent_id: String,
    message_id: String,
    /// One of the message's local links (`watch.links`), not the card.
    #[serde(default)]
    link: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyParams {
    agent_id: String,
    copy_id: String,
    /// Keep: the branch the user confirmed, after `otherBranch`.
    #[serde(default)]
    into: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStartParams {
    project: String,
    prompt: String,
    client_id: String,
}

#[derive(Deserialize)]
struct ScreenshotParams {
    project: String,
    device: ScreenshotDevice,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScreenshotDevice {
    Desktop,
    Phone,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionKeyParams {
    session_id: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    agent_id: String,
    text: String,
    client_id: String,
    #[serde(default)]
    attachments: Vec<BlobParam>,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    revises: Option<String>,
    #[serde(default)]
    conversation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomMessagesParams {
    room_id: String,
    limit: Option<usize>,
    before: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomSendParams {
    room_id: String,
    text: String,
    client_id: String,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    everyone: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomFocusParams {
    room_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalParams {
    agent_id: String,
    request_id: String,
    allow: bool,
    always: Option<bool>,
    note: Option<String>,
    choice: Option<usize>,
}

/// "rex (read), chief (full)", or "nobody yet": who an apps change names.
fn grants_audit(params: &Value) -> String {
    let named: Vec<String> = params
        .get("grants")
        .and_then(Value::as_array)
        .map(|g| {
            g.iter()
                .take(20)
                .map(|g| {
                    format!(
                        "{} ({})",
                        g.get("agentId").and_then(Value::as_str).unwrap_or(""),
                        g.get("access").and_then(Value::as_str).unwrap_or("")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if named.is_empty() {
        "nobody yet".into()
    } else {
        named.join(", ")
    }
}

/// Never echoed: a parse error could quote a value, so a malformed request
/// gets a fixed sentence instead (see `"agents.saveSecret"`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretParams {
    agent_id: String,
    request_id: String,
    values: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryChangeParams {
    agent_id: String,
    change: Value,
}

#[derive(Deserialize)]
struct TextParam {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusParams {
    agent_id: Option<String>,
}

/// What the audit log records about a call: a preview of anything typed.
pub fn audit_detail(method: &str, params: &Value) -> String {
    let field = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("");
    let preview = crate::remote_access::preview;
    match method {
        "agents.send" | "sessions.send" => preview(field("text")),
        "rooms.send" => preview(&format!("in a room: {}", field("text"))),
        "rooms.focus" => field("roomId").to_string(),
        "sessions.key" => format!("pressed {}", field("key")),
        "agents.memorySuggest" => format!(
            "suggest a memory from {} chars",
            field("text").chars().count()
        ),
        "agents.update" => {
            let input = params.get("input").cloned().unwrap_or(Value::Null);
            let flag = |k: &str, on: &str, off: &str| match input.get(k).and_then(Value::as_bool) {
                Some(true) => Some(on.to_string()),
                Some(false) => Some(off.to_string()),
                None => None,
            };
            [
                flag("pinned", "pin", "unpin"),
                flag("muted", "mute", "unmute"),
                flag("hidden", "hide", "unhide"),
                input
                    .get("instructions")
                    .and_then(Value::as_str)
                    .map(|i| format!("edit instructions ({} chars)", i.chars().count())),
                input
                    .get("engine")
                    .and_then(Value::as_str)
                    .map(|e| format!("engine {e}")),
                input
                    .get("model")
                    .and_then(Value::as_str)
                    .map(|m| format!("model {}", if m.is_empty() { "default" } else { m })),
                input
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(|e| format!("effort {}", if e.is_empty() { "default" } else { e })),
                input
                    .get("account")
                    .and_then(Value::as_str)
                    .map(|a| format!("runs on {}", if a.is_empty() { "any account" } else { a })),
            ]
            .into_iter()
            .flatten()
            .chain(std::iter::once(field("agentId").to_string()))
            .collect::<Vec<_>>()
            .join(" ")
        }
        "agents.create" => {
            let input = params.get("input").cloned().unwrap_or(Value::Null);
            let text = |k: &str| {
                input
                    .get(k)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string()
            };
            match text("role").as_str() {
                "" => preview(&format!("create {}", text("name"))),
                role => preview(&format!("create {} — {role}", text("name"))),
            }
        }
        "agents.answerApproval" => {
            let allow = params
                .get("allow")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let always = params
                .get("always")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let note = field("note").trim();
            if let Some(choice) = params.get("choice").and_then(Value::as_u64) {
                return format!("picked option {}", choice + 1);
            }
            match (allow, always, note.is_empty()) {
                (true, true, _) => "always allow".into(),
                (true, false, _) => "allow".into(),
                (false, _, true) => "deny".into(),
                (false, _, false) => preview(&format!("deny with note: {note}")),
            }
        }
        // Names the card, never a value: `values` is not read here.
        "agents.saveSecret" => format!("saved a secret for {}", field("agentId")),
        "agents.loginStart" => format!(
            "started signing in ({}) for {}",
            field("optionId"),
            field("agentId")
        ),
        "agents.loginCancel" => format!("stopped signing in for {}", field("agentId")),
        "agents.loginsConnect" => format!(
            "connected {} ({}) for the team",
            field("key"),
            field("optionId")
        ),
        "agents.loginDismiss" => format!("not needed: a login for {}", field("agentId")),
        "agents.loginNotNeeded" => {
            format!("chose not to connect an app {} asked for", field("agentId"))
        }
        "agents.loginsNotNeeded" => match params.get("keys").and_then(Value::as_array) {
            Some(keys) => format!(
                "chose not to connect {}",
                keys.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => "skipped the rest of the team's logins".into(),
        },
        "agents.loginsUndecline" => "turned a declined app back on".into(),
        "agents.loginDecline" => format!("declined a login for {}", field("agentId")),
        // Never the sign-in's URL or its code: only that it happened.
        "agents.loginPhoneBegin" => format!(
            "started signing in on the phone ({}) for {}",
            field("optionId"),
            if field("key").is_empty() {
                field("agentId")
            } else {
                field("key")
            }
        ),
        "agents.loginPhoneFinish" => "finished signing in on the phone".into(),
        "agents.appsConnect" => format!(
            "connected {} on the Mac for {}",
            field("service"),
            grants_audit(params)
        ),
        "agents.appsPhoneBegin" => format!(
            "started signing in to {} on the phone for {}",
            field("service"),
            grants_audit(params)
        ),
        "agents.appsCancel" => format!("stopped signing in to {}", field("service")),
        "agents.appsSetGrants" => format!(
            "who can use {}: {}",
            field("connectionId"),
            grants_audit(params)
        ),
        "agents.appsRemove" => format!("removed the connection {}", field("connectionId")),
        // Never read: what's typed there is a password.
        m if SELF_AUDITED_METHODS.contains(&m) => "phone sign-in".into(),
        // Never the value.
        "agents.loginSaveKey" => format!("saved a key for {}", field("agentId")),
        "agents.memoryChange" => {
            let change = params.get("change").cloned().unwrap_or(Value::Null);
            let text = change.get("text").and_then(Value::as_str).unwrap_or("");
            match change.get("op").and_then(Value::as_str).unwrap_or("") {
                "add" => preview(&format!("remember: {text}")),
                "edit" => preview(&format!("edit memory: {text}")),
                "delete" => format!(
                    "forget memory entry {}",
                    change
                        .get("index")
                        .map(Value::to_string)
                        .unwrap_or_default()
                ),
                other => format!("memory {other}"),
            }
        }
        "devices.unpairSelf" => "forgot this Mac".into(),
        "devices.setPush" => match params.get("token").and_then(Value::as_str) {
            Some(_) => "push token set".into(),
            None => "push token cleared".into(),
        },
        "agents.fetchPath" => preview(field("path")),
        "agents.revokePermission" => format!("revoke {} {}", field("ruleId"), field("agentId")),
        "agents.skillEdit" => format!("edit skill {} of {}", field("slug"), field("agentId")),
        "agents.skillRemove" => format!("remove skill {} of {}", field("slug"), field("agentId")),
        "agents.onItsOwnNarrow" => format!(
            "take back {} {}",
            params
                .get("narrow")
                .and_then(|n| n.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("?"),
            field("agentId")
        ),
        "agents.teamSetup.step" => format!("setup: {} {}", field("step"), field("state")),
        "agents.teamSetup.later" => format!("setup: {} {}", field("action"), field("key")),
        "agents.teamSetup.check" => "setup: check what the team can reach".into(),
        "agents.teamSetup.routine" => {
            let on = params.get("on").and_then(Value::as_bool) == Some(true);
            format!(
                "setup: switch {} {} {}",
                if on { "on" } else { "off" },
                field("checkInId"),
                field("agentId")
            )
        }
        "agents.teamSetup.hello" => format!("setup: said hi to {}", field("agentId")),
        "agents.teamSetup.missing" => "setup: asked the Chief about what's missing".into(),
        "agents.teamSetup.dismiss" => "setup: put away".into(),
        "sessions.start" => preview(&format!("{} — {}", field("project"), field("prompt"))),
        "preview.screenshot" => format!("{} {}", field("project"), field("device")),
        "agents.schedule.create" | "agents.schedule.update" => {
            preview(&format!("{} — {}", field("when"), field("note")))
        }
        "agents.draft" => preview(&format!("draft: {}", field("description"))),
        "agents.schedule.pause" => {
            let paused = params.get("paused").and_then(Value::as_bool) == Some(true);
            format!(
                "{} {}",
                if paused { "pause" } else { "resume" },
                field("id")
            )
        }
        "agents.schedule.cancel" | "agents.schedule.runNow" => field("id").to_string(),
        "agents.watch.create" | "agents.watch.update" => {
            let kind = params
                .get("source")
                .and_then(|s| s.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            preview(&format!("when {kind} — {}", field("note")))
        }
        "agents.watch.checkNow" => format!("check now {}", field("id")),
        "agents.conversationRoutine" => {
            format!("move {} to {}", field("routineId"), field("conversationId"))
        }
        "agents.pagePin" => {
            let pinned = params.get("pinned").and_then(Value::as_bool) == Some(true);
            format!(
                "{} the page of {}",
                if pinned { "pinned" } else { "unpinned" },
                match field("conversationId") {
                    "" => "the current conversation",
                    c => c,
                }
            )
        }
        "agents.setDefaults" => {
            let said: Vec<String> = [
                ("engine", "engine"),
                ("claudeModel", "Claude Code model"),
                ("codexModel", "Codex model"),
            ]
            .into_iter()
            .filter(|(key, _)| params.get(*key).is_some())
            .map(|(key, name)| match field(key) {
                "" => format!("{name} default"),
                value => format!("{name} {}", preview(value)),
            })
            .collect();
            format!("new agents: {}", said.join(", "))
        }
        "agents.setIndependence" => format!("independence: {}", preview(field("level"))),
        "agents.setQuietHours" => match params.get("window").filter(|w| !w.is_null()) {
            Some(w) => format!(
                "quiet hours: {}",
                serde_json::from_value::<crate::agents::quiet::Window>(w.clone())
                    .map(|w| w.label())
                    .unwrap_or_else(|_| "?".into())
            ),
            None => "quiet hours: off".to_string(),
        },
        "agents.setMorningBrief" => match params.get("on").and_then(Value::as_bool) {
            Some(true) => format!(
                "morning brief: {}{}",
                crate::agents::brief::clock_label(
                    params.get("at").and_then(Value::as_u64).unwrap_or(0) as u32
                ),
                if params.get("always").and_then(Value::as_bool) == Some(true) {
                    ", every day"
                } else {
                    ""
                }
            ),
            _ => "morning brief: off".to_string(),
        },
        "agents.setImportChoice" => format!("import: {}", preview(field("choice"))),
        "agents.setAgentIndependence" => format!(
            "{} independence: {}",
            field("agentId"),
            preview(field("level"))
        ),
        "agents.accounts.use" => format!(
            "use {} account {} first",
            preview(field("engine")),
            preview(field("id"))
        ),
        "agents.usage.setMode" => format!("usage mode: {}", preview(field("mode"))),
        "agents.spare.add" => format!("ideas for leftover usage: add {}", preview(field("text"))),
        "agents.spare.spendNow" => "ideas for leftover usage: start now".to_string(),
        "agents.accounts.reorder" => format!(
            "{} accounts in order: {}",
            preview(field("engine")),
            preview(
                &params
                    .get("ids")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default()
            )
        ),
        "agents.setAdmin" => format!(
            "{} admin {}",
            field("agentId"),
            if params.get("admin").and_then(Value::as_bool) == Some(true) {
                "on"
            } else {
                "off"
            }
        ),
        _ => field("agentId").to_string(),
    }
}

/// A phone sign-in request, parsed. A refusal says what's wrong with it,
/// never what was typed.
fn signin_op(method: &str, params: Value) -> Result<crate::agents::phone_signin::Op, WireError> {
    use crate::agents::phone_signin::Op;
    let id = |s: &str| -> Result<(), WireError> {
        if s.is_empty() || s.len() > 100 {
            return Err(bad_params("Which sign-in?"));
        }
        Ok(())
    };
    Ok(match method {
        "agents.signinBegin" => {
            let p: SigninBeginParams = parse(params)?;
            id(&p.agent_id)?;
            id(&p.request_id)?;
            Op::Begin {
                agent_id: p.agent_id,
                request_id: p.request_id,
                way: p.way,
            }
        }
        "agents.stepInBegin" => {
            let p: StepInBeginParams = parse(params)?;
            id(&p.agent_id)?;
            id(&p.request_id)?;
            Op::StepIn {
                agent_id: p.agent_id,
                request_id: p.request_id,
            }
        }
        "agents.signinInput" => {
            let p: SigninInputParams =
                parse(params).map_err(|_| bad_params("That isn't something the page can take."))?;
            id(&p.session_id)?;
            Op::Input {
                session_id: p.session_id,
                input: p.input,
            }
        }
        _ => {
            let p: SigninParams = parse(params)?;
            id(&p.session_id)?;
            match method {
                "agents.signinFrame" => Op::Frame {
                    session_id: p.session_id,
                    after: p.after,
                },
                "agents.signinFallback" => Op::Fallback {
                    session_id: p.session_id,
                },
                "agents.signinDone" => Op::Done {
                    session_id: p.session_id,
                    anyway: p.anyway,
                },
                _ => Op::Stop {
                    session_id: p.session_id,
                },
            }
        }
    })
}

/// Run one request, with the rate limit and the audit line around it.
pub async fn dispatch(
    c: &Companion,
    caller: &Caller,
    method: &str,
    params: Value,
) -> Result<Value, WireError> {
    if !METHODS.contains(&method) {
        return Err(WireError::protocol(
            ProtocolCode::UnknownMethod,
            format!("This Mac doesn't know {method}."),
        ));
    }
    if !c.allow_request(&caller.device_id, now_ms()) {
        return Err(WireError::protocol(
            ProtocolCode::RateLimited,
            "Too many requests. Try again in a minute.",
        ));
    }
    let detail = audit_detail(method, &params);
    let result = run(c, caller, method, params).await;
    if !READ_ONLY_METHODS.contains(&method) && !SELF_AUDITED_METHODS.contains(&method) {
        let (detail, ok) = match &result {
            Ok(_) => (detail, true),
            Err(e) => (
                crate::remote_access::preview(&format!("{detail} — refused: {}", e.summary())),
                false,
            ),
        };
        c.backend
            .audit(&actor_for(&caller.device_name), method, detail, ok);
    }
    result
}

async fn run(
    c: &Companion,
    caller: &Caller,
    method: &str,
    params: Value,
) -> Result<Value, WireError> {
    let b = &c.backend;
    match method {
        "system.status" => Ok(to_value(&refresh_status(c).await)),
        "devices.self" => c
            .registry
            .get(&caller.device_id)
            .map(|d| to_value(&d.view(true)))
            .ok_or_else(|| CommandError::expected("This phone isn't paired any more.").into()),
        "devices.unpairSelf" => {
            let gone = c.registry.revoke(&caller.device_id)?;
            if let Some(d) = &gone {
                c.forget_push_later(d);
                b.changed();
            }
            Ok(Value::Null)
        }
        "devices.setPush" => {
            let p: SetPushParams = parse(params)?;
            let status = super::push::set_push(
                c,
                &caller.device_id,
                p.token,
                p.environment.unwrap_or_default(),
            )
            .await?;
            Ok(json!({ "status": status }))
        }
        "agents.overview" => Ok(b.overview().await?),
        "agents.messages" => {
            let p: MessagesParams = parse(params)?;
            // Read the cursor first: anything changed after it reaches the
            // phone as an event with a higher seq, which the merge keeps.
            let as_of = c.hub.cursor();
            let limit = p.limit.unwrap_or(MESSAGES_DEFAULT).clamp(1, MESSAGES_MAX);
            let (mut messages, more) = b
                .messages(
                    &p.agent_id,
                    limit,
                    p.before.as_deref(),
                    p.conversation.as_deref(),
                )
                .await?;
            if p.work.as_deref() == Some("summary") {
                crate::agents::work::omit_steps_json(&mut messages);
            }
            Ok(json!({ "messages": messages, "asOf": as_of, "more": more }))
        }
        "agents.workSteps" => {
            let p: WorkStepsParams = parse(params)?;
            let work = b.turn_work(&p.agent_id, &p.message_id).await?;
            Ok(json!({ "work": work }))
        }
        "agents.send" => {
            let p: SendParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:{client_id}", caller.device_id);
            let device = caller.device_id.clone();
            c.sends
                .once(key, now_ms(), || async move {
                    let blob_ids: Vec<String> =
                        p.attachments.into_iter().map(|a| a.blob_id).collect();
                    let attachments = staged(c, &device, &blob_ids)?;
                    // Files alone are a message, as on the desk; any text
                    // still gets Remote Access's refusals.
                    let text = if attachments.is_empty() || !p.text.trim().is_empty() {
                        crate::remote_access::tools::clean_agent_text(&p.text, "message")
                            .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?
                    } else {
                        String::new()
                    };
                    let extras = SendExtras {
                        mentions: p.mentions,
                        attachments,
                        client_id: Some(client_id),
                        revises: p.revises.filter(|r| !r.trim().is_empty()),
                        conversation: p.conversation.filter(|c| !c.trim().is_empty()),
                    };
                    let sent = b.send(&p.agent_id, text, extras).await?;
                    c.blobs.consume(&blob_ids);
                    Ok(sent)
                })
                .await
        }
        "rooms.list" => Ok(b.rooms().await?),
        "rooms.messages" => {
            let p: RoomMessagesParams = parse(params)?;
            let as_of = c.hub.cursor();
            let limit = p.limit.unwrap_or(MESSAGES_DEFAULT).clamp(1, MESSAGES_MAX);
            let (messages, more) = b
                .room_messages(&p.room_id, limit, p.before.as_deref())
                .await?;
            Ok(json!({ "messages": messages, "asOf": as_of, "more": more }))
        }
        "rooms.send" => {
            let p: RoomSendParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:room:{client_id}", caller.device_id);
            c.sends
                .once(key, now_ms(), || async move {
                    // The same refusals as a message to one agent.
                    let text = crate::remote_access::tools::clean_agent_text(&p.text, "message")
                        .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?;
                    let send = RoomSend {
                        mentions: p.mentions,
                        everyone: p.everyone,
                        client_id: Some(client_id),
                    };
                    Ok(b.room_send(&p.room_id, text, send).await?)
                })
                .await
        }
        "rooms.focus" => {
            let p: RoomFocusParams = parse(params)?;
            b.room_focus(&caller.label, p.room_id).await?;
            Ok(Value::Null)
        }
        "agents.stop" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::Bool(b.stop(&p.agent_id).await?))
        }
        "agents.interrupt" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::Bool(b.interrupt(&p.agent_id).await?))
        }
        "agents.stopStep" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::String(b.stop_step(&p.agent_id).await?))
        }
        "agents.checkOn" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::String(b.check_on(&p.agent_id).await?))
        }
        "agents.answerApproval" => {
            let p: ApprovalParams = parse(params)?;
            b.answer_approval(ApprovalAnswer {
                agent_id: p.agent_id,
                request_id: p.request_id,
                allow: p.allow,
                always: p.always,
                note: p.note,
                choice: p.choice,
            })
            .await?;
            Ok(Value::Null)
        }
        "agents.saveSecret" => {
            // No route check here: every socket reaches this server the same
            // way, so one could never fail. The phone's pinned-identity check
            // (docs/mobile.md, "Pairing") is what keeps secrets on this Mac.
            let p: SecretParams = parse(params).map_err(|_| {
                bad_params("A secret needs agentId, requestId and one value per field.")
            })?;
            if p.values.is_empty()
                || p.values.len() > MAX_SECRET_FIELDS
                || p.values
                    .iter()
                    .any(|v| v.chars().count() > MAX_SECRET_CHARS)
            {
                return Err(bad_params(
                    "That doesn't look like a secret this card asked for.",
                ));
            }
            Ok(b.save_secret(&p.agent_id, &p.request_id, p.values).await?)
        }
        "agents.memory" => {
            let p: AgentParam = parse(params)?;
            Ok(b.memory(&p.agent_id).await?)
        }
        "agents.memoryChange" => {
            let p: MemoryChangeParams = parse(params)?;
            let text = p.change.get("text").and_then(Value::as_str).unwrap_or("");
            if text.chars().count() > MAX_MEMORY_CHARS {
                return Err(bad_params(format!(
                    "A memory can be up to {MAX_MEMORY_CHARS} characters."
                )));
            }
            if text.chars().any(|c| c.is_control() && c != '\n') {
                return Err(WireError::protocol(
                    ProtocolCode::Refused,
                    "A memory can't contain control characters.",
                ));
            }
            Ok(b.memory_change(&p.agent_id, p.change).await?)
        }
        "agents.memorySuggest" => {
            let p: TextParam = parse(params)?;
            // Each one starts a model process: a few at once, whoever asks.
            let Some(_slot) = c
                .suggests
                .try_take("all", super::limits::MAX_SUGGESTS_AT_ONCE)
            else {
                return Err(WireError::protocol(
                    ProtocolCode::RateLimited,
                    "Your Mac is already suggesting a memory. Try again in a moment.",
                ));
            };
            let text: String = p.text.chars().take(MAX_SUGGEST_CHARS).collect();
            Ok(Value::String(b.memory_suggest(text).await?))
        }
        "agents.focus" => {
            let p: FocusParams = parse(params)?;
            c.set_showing(&caller.label, p.agent_id.clone());
            b.focus(&caller.label, p.agent_id).await?;
            Ok(Value::Null)
        }
        "agents.markUnread" => {
            let p: AgentParam = parse(params)?;
            b.mark_unread(&p.agent_id).await?;
            Ok(Value::Null)
        }
        "agents.conversations" => {
            let p: AgentParam = parse(params)?;
            Ok(b.conversations(&p.agent_id).await?)
        }
        "agents.conversationNew" => {
            let p: AgentParam = parse(params)?;
            Ok(b.conversation_new(&p.agent_id).await?)
        }
        "agents.conversationSelect" => {
            let p: ConversationParams = parse(params)?;
            Ok(b.conversation_select(&p.agent_id, &p.conversation_id)
                .await?)
        }
        "agents.conversationRename" => {
            let p: ConversationRenameParams = parse(params)?;
            if p.title.chars().count() > crate::agents::conversations::TITLE_CHARS {
                return Err(bad_params("title is too long."));
            }
            Ok(
                b.conversation_rename(&p.agent_id, &p.conversation_id, p.title)
                    .await?,
            )
        }
        "agents.page" => {
            let p: PageParams = parse(params)?;
            Ok(b.page(&p.agent_id, p.conversation_id.as_deref()).await?)
        }
        "agents.pageVersion" => {
            let p: PageVersionParams = parse(params)?;
            Ok(
                b.page_version(&p.agent_id, p.conversation_id.as_deref(), p.version)
                    .await?,
            )
        }
        "agents.pagePin" => {
            let p: PagePinParams = parse(params)?;
            Ok(
                b.page_pin(&p.agent_id, p.conversation_id.as_deref(), p.pinned)
                    .await?,
            )
        }
        "agents.conversationRewind" => {
            let p: ConversationMessageParams = parse(params)?;
            Ok(
                b.conversation_rewind(&p.agent_id, &p.conversation_id, &p.message_id)
                    .await?,
            )
        }
        "agents.conversationFork" => {
            let p: ConversationMessageParams = parse(params)?;
            Ok(
                b.conversation_fork(&p.agent_id, &p.conversation_id, &p.message_id)
                    .await?,
            )
        }
        "agents.conversationRoutine" => {
            let p: ConversationRoutineParams = parse(params)?;
            Ok(
                b.conversation_routine(&p.agent_id, &p.routine_id, &p.conversation_id)
                    .await?,
            )
        }
        "agents.startFresh" => {
            let p: AgentParam = parse(params)?;
            // A `StoredAgent`, without lifetime usage, as `agents.update` returns.
            let mut stored = b.start_fresh(&p.agent_id).await?;
            if let Some(fields) = stored.as_object_mut() {
                fields.remove("usage");
            }
            Ok(stored)
        }
        "agents.create" => {
            let p: CreateParams = parse(params).map_err(|_| {
                bad_params(
                    "From the phone, a new agent takes a name, what it should do, a colour and a ready-made agent to start from.",
                )
            })?;
            let input = check_new_agent(p.input)?;
            let device = caller.device_id.clone();
            let create = || async move {
                // Counted here, so a retry answered from the cache isn't a second agent.
                if !c.allow_create(&device, now_ms()) {
                    return Err(WireError::protocol(
                        ProtocolCode::RateLimited,
                        format!(
                            "That's {} new agents in a minute, the most a phone can make. Try again in a minute.",
                            super::MAX_AGENTS_CREATED_PER_MINUTE
                        ),
                    ));
                }
                // A `StoredAgent`, without lifetime usage, as `agents.update` returns.
                let mut stored = b.create_agent(input).await?;
                if let Some(fields) = stored.as_object_mut() {
                    fields.remove("usage");
                }
                Ok(stored)
            };
            match p.client_id.map(|id| id.trim().to_string()) {
                None => create().await,
                Some(id) if id.is_empty() || id.len() > 128 => {
                    Err(bad_params("clientId is at most 128 characters."))
                }
                // A retry after a dropped socket gets the agent the first one
                // made, not a second (or "There's already an agent called …").
                Some(id) => {
                    c.sends
                        .once(
                            format!("{}:create:{id}", caller.device_id),
                            now_ms(),
                            create,
                        )
                        .await
                }
            }
        }
        "agents.update" => {
            let p: UpdateParams = parse(params).map_err(|_| {
                bad_params(
                    "Only pin, mute, hide, the instructions, how it looks, and its engine, model and effort can be changed from the phone.",
                )
            })?;
            if p.input == AgentToggles::default() {
                return Err(bad_params("Nothing to change."));
            }
            if p.input
                .instructions
                .as_ref()
                .is_some_and(|i| i.chars().count() > MAX_INSTRUCTIONS)
            {
                return Err(bad_params(format!(
                    "Instructions can be up to {MAX_INSTRUCTIONS} characters."
                )));
            }
            if let Some(i) = &p.input.instructions {
                refuse_unsafe_text(i, "Instructions")?;
            }
            if let Some(c) = p.input.color.as_deref().map(str::trim) {
                if !crate::agents::store::COLORS.contains(&c) {
                    return Err(bad_params(format!("{c} isn't one of the agent colours.")));
                }
            }
            // `StoredAgent` doesn't carry lifetime usage, as the overview doesn't.
            let mut stored = b.update_agent(&p.agent_id, p.input).await?;
            if let Some(fields) = stored.as_object_mut() {
                fields.remove("usage");
            }
            Ok(stored)
        }
        "agents.files" => {
            let p: AgentParam = parse(params)?;
            Ok(b.files(&p.agent_id).await?)
        }
        "agents.instructions" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::String(b.instructions(&p.agent_id).await?))
        }
        "agents.usage" => {
            let p: AgentParam = parse(params)?;
            Ok(b.usage(&p.agent_id).await?)
        }
        "agents.quota" => Ok(b.quota().await?),
        "agents.setDefaults" => {
            let change: crate::agents::defaults::Change = parse(params).map_err(|_| {
                bad_params(
                    "New agents' defaults take an engine (claude or codex), claudeModel and codexModel.",
                )
            })?;
            if change.is_empty() {
                return Err(bad_params("Nothing to change."));
            }
            Ok(b.set_defaults(change).await?)
        }
        "agents.setIndependence" => {
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .and_then(|l| crate::agents::independence::Level::parse(l).ok())
                .ok_or_else(|| {
                    bad_params(
                        "How independent agents are takes a level: often, judgement, go_hard or full_send.",
                    )
                })?;
            Ok(b.set_independence(level).await?)
        }
        "agents.setImportChoice" => {
            let choice = params
                .get("choice")
                .and_then(Value::as_str)
                .and_then(|c| crate::agents::import_choice::Choice::parse(c).ok())
                .ok_or_else(|| {
                    bad_params("The import choice is imported, declined or undecided.")
                })?;
            Ok(b.set_import_choice(choice).await?)
        }
        "agents.setAdmin" => {
            let agent_id = params.get("agentId").and_then(Value::as_str).unwrap_or("");
            let admin = params.get("admin").and_then(Value::as_bool);
            let Some(admin) = admin.filter(|_| !agent_id.is_empty()) else {
                return Err(bad_params(
                    "Admin takes an agentId and admin: true or false.",
                ));
            };
            Ok(b.set_admin(agent_id, admin).await?)
        }
        "agents.setAgentIndependence" => {
            let agent_id = params.get("agentId").and_then(Value::as_str).unwrap_or("");
            let level = match params.get("level").and_then(Value::as_str) {
                Some("team") => Some(None),
                Some(l) => crate::agents::independence::Level::parse(l).ok().map(Some),
                None => None,
            };
            let Some(level) = level.filter(|_| !agent_id.is_empty()) else {
                return Err(bad_params(
                    "An agent's independence takes an agentId and a level: team, often, judgement, go_hard or full_send.",
                ));
            };
            Ok(b.set_agent_independence(agent_id, level).await?)
        }
        "agents.accounts" => Ok(b.accounts().await?),
        "agents.accounts.use" => {
            let engine = params.get("engine").and_then(Value::as_str).unwrap_or("");
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            if !matches!(engine, "claude" | "codex") || id.is_empty() || id.len() > 64 {
                return Err(bad_params(
                    "Using an account takes an engine (claude or codex) and the account's id.",
                ));
            }
            Ok(b.account_use(engine, id).await?)
        }
        "agents.accounts.reorder" => {
            let engine = params.get("engine").and_then(Value::as_str).unwrap_or("");
            let ids: Option<Vec<String>> = params
                .get("ids")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty() && a.len() <= 32)
                .and_then(|a| {
                    a.iter()
                        .map(|v| v.as_str().filter(|s| s.len() <= 64).map(str::to_string))
                        .collect()
                });
            let Some(ids) = ids.filter(|_| matches!(engine, "claude" | "codex")) else {
                return Err(bad_params(
                    "Reordering takes an engine (claude or codex) and every account id, in order.",
                ));
            };
            Ok(b.account_reorder(engine, ids).await?)
        }
        "agents.usagePlan" => Ok(b.usage_plan().await?),
        "agents.usage.setMode" => {
            let mode = params.get("mode").and_then(Value::as_str).unwrap_or("");
            if !matches!(mode, "normal" | "save" | "use_it_all") {
                return Err(bad_params(
                    "The usage mode is normal, save (Save my limits) or use_it_all (Use it all before the refill).",
                ));
            }
            Ok(b.usage_set_mode(mode).await?)
        }
        "agents.spare.add" => {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let agent = params
                .get("agentId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if text.is_empty() || text.chars().count() > 600 || agent.is_some_and(|a| a.len() > 64)
            {
                return Err(bad_params(
                    "Adding to the list of ideas for leftover usage takes the text (at most 600 characters) and optionally an agentId.",
                ));
            }
            Ok(b.spare_add(text, agent).await?)
        }
        "agents.spare.spendNow" => Ok(b.spare_spend_now().await?),
        "agents.quietHours" => Ok(b.quiet_hours().await?),
        "agents.setQuietHours" => {
            let window = match params.get("window") {
                None | Some(Value::Null) => None,
                Some(w) => Some(
                    serde_json::from_value::<crate::agents::quiet::Window>(w.clone())
                        .ok()
                        .and_then(|w| crate::agents::quiet::checked(w).ok())
                        .ok_or_else(|| {
                            bad_params(
                                "Quiet hours take a window {start, end} in minutes after midnight, different times, or null for off.",
                            )
                        })?,
                ),
            };
            Ok(b.set_quiet_hours(window).await?)
        }
        "agents.morningBrief" => Ok(b.morning_brief().await?),
        "agents.setMorningBrief" => {
            let on = params.get("on").and_then(Value::as_bool);
            let at = params
                .get("at")
                .and_then(Value::as_u64)
                .filter(|m| *m < 24 * 60);
            let always = params
                .get("always")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (Some(on), Some(at)) = (on, at) else {
                return Err(bad_params(
                    "The morning brief takes `on` (true or false) and `at`, minutes after midnight (0 to 1439).",
                ));
            };
            Ok(b.set_morning_brief(on, at as u32, always).await?)
        }
        "agents.import.status" => Ok(b.import_status().await?),
        "agents.import.start" => Ok(b.import_start().await?),
        "agents.import.stop" => Ok(b.import_stop().await?),
        "agents.import.exportPrompt" => Ok(b.import_export(ImportExportAction::Prompt).await?),
        "agents.import.exportPreview" | "agents.import.exportReview" => {
            let p: ImportTextParams = parse(params)?;
            if p.text.trim().is_empty() {
                return Err(bad_params("Paste the reply first."));
            }
            let action = if method == "agents.import.exportPreview" {
                ImportExportAction::Preview(p.text)
            } else {
                ImportExportAction::Review(p.text)
            };
            Ok(b.import_export(action).await?)
        }
        "agents.import.review" => {
            let p: ImportReviewParams = parse(params)?;
            if p.keys.len() > crate::agents::review::MAX_PROPOSALS {
                return Err(bad_params("That's more agents than one import holds."));
            }
            Ok(b.import_review(&p.agent_id, &p.request_id, p.keys, p.notes)
                .await?)
        }
        "agents.teamSetup" => {
            let p: TeamSetupGetParams = if params.is_null() {
                TeamSetupGetParams::default()
            } else {
                parse(params)?
            };
            Ok(b.team_setup(TeamSetupAction::Get { any: p.any }).await?)
        }
        "agents.teamSetup.step" => {
            let p: TeamSetupStepParams = parse(params).map_err(|_| {
                bad_params("A step is logins, routines, missing or hello; its state open, done or skipped.")
            })?;
            Ok(b.team_setup(TeamSetupAction::Step {
                step: p.step,
                state: p.state,
            })
            .await?)
        }
        "agents.teamSetup.routine" => {
            let p: TeamSetupRoutineParams = parse(params)?;
            Ok(b.team_setup(TeamSetupAction::Routine {
                agent_id: p.agent_id,
                check_in_id: p.check_in_id,
                on: p.on,
            })
            .await?)
        }
        "agents.teamSetup.hello" => {
            let p: AgentParam = parse(params)?;
            Ok(b.team_setup(TeamSetupAction::Hello {
                agent_id: p.agent_id,
            })
            .await?)
        }
        "agents.teamSetup.missing" => Ok(b.team_setup(TeamSetupAction::Missing).await?),
        "agents.teamSetup.dismiss" => Ok(b.team_setup(TeamSetupAction::Dismiss).await?),
        "agents.teamSetup.later" => {
            let p: TeamSetupLaterParams = parse(params)?;
            let connect = match p.action.as_str() {
                "connect" => true,
                "not_needed" => false,
                _ => return Err(bad_params("action is connect or not_needed.")),
            };
            Ok(b.team_setup(TeamSetupAction::Later {
                key: p.key,
                connect,
                on_phone: p.on_phone,
            })
            .await?)
        }
        "agents.teamSetup.check" => Ok(b.team_setup(TeamSetupAction::Check).await?),
        // The ready-made agents, without their briefings: the phone shows
        // the choice, the Mac fills the instructions in on create.
        "agents.templates" => Ok(templates_for_phone()),
        "agents.loginStart" => {
            let p: LoginParams = parse(params)?;
            if p.option_id.is_empty() || p.option_id.len() > 200 {
                return Err(bad_params(
                    "Which way in? optionId is one of the card's options.",
                ));
            }
            b.login_start(&p.agent_id, &p.request_id, &p.option_id, p.on_phone)
                .await?;
            Ok(Value::Null)
        }
        "agents.loginPhoneBegin" => {
            let p: PhoneBeginParams = parse(params)?;
            if p.option_id.is_empty() || p.option_id.len() > 200 || p.skip.len() > 200 {
                return Err(bad_params("Which card, and which way in?"));
            }
            let target = match (p.agent_id, p.request_id, p.key) {
                (Some(agent_id), Some(request_id), None) => {
                    crate::agents::login_relay::Target::Card {
                        agent_id,
                        request_id,
                    }
                }
                (None, None, Some(key)) if !key.is_empty() => {
                    crate::agents::login_relay::Target::Team { key, skip: p.skip }
                }
                _ => {
                    return Err(bad_params(
                        "Name one card (agentId, requestId) or one row (key).",
                    ))
                }
            };
            Ok(b.login_phone_begin(&caller.device_id, target, &p.option_id)
                .await?)
        }
        "agents.loginPhoneFinish" => {
            let p: PhoneFinishParams = parse(params)
                .map_err(|_| bad_params("A sign-in's answer needs flowId and callbackUrl."))?;
            if p.flow_id.is_empty() || p.flow_id.len() > 100 || p.callback_url.len() > 8192 {
                return Err(bad_params("That isn't a sign-in's answer."));
            }
            b.login_phone_finish(&caller.device_id, &p.flow_id, &p.callback_url)
                .await?;
            Ok(Value::Null)
        }
        m if SELF_AUDITED_METHODS.contains(&m) => {
            let op = signin_op(m, params)?;
            Ok(b.phone_signin(&caller.device_id, &caller.device_name, op)
                .await?)
        }
        "agents.loginCancel" => {
            let p: LoginParams = parse(params)?;
            b.login_cancel(&p.agent_id, &p.request_id).await?;
            Ok(Value::Null)
        }
        "agents.loginDecline" => {
            let p: LoginParams = parse(params)?;
            let note = p.note.map(|n| n.chars().take(500).collect::<String>());
            b.login_decline(&p.agent_id, &p.request_id, note).await?;
            Ok(Value::Null)
        }
        "agents.loginSaveKey" => {
            // As saveSecret: the phone's pinned-identity check keeps it on this Mac.
            let p: LoginKeyParams = parse(params)
                .map_err(|_| bad_params("A key needs agentId, requestId and value."))?;
            if p.value.trim().is_empty() || p.value.chars().count() > MAX_SECRET_CHARS {
                return Err(bad_params(
                    "That doesn't look like a key this card asked for.",
                ));
            }
            Ok(b.login_save_key(&p.agent_id, &p.request_id, p.value)
                .await?)
        }
        "agents.reach" => {
            let p: AgentParam = parse(params)?;
            Ok(b.reach(&p.agent_id).await?)
        }
        "agents.apps" => Ok(b.apps().await?),
        "agents.appsConnect" => {
            let p: AppsConnectParams = parse(params)?;
            checked_connect(&p)?;
            b.apps_connect(&p.service, p.grants, p.again).await?;
            Ok(Value::Null)
        }
        "agents.appsPhoneBegin" => {
            let p: AppsConnectParams = parse(params)?;
            checked_connect(&p)?;
            Ok(
                b.apps_phone_begin(&caller.device_id, &p.service, p.grants, p.again)
                    .await?,
            )
        }
        "agents.appsCancel" => {
            let p: AppsServiceParams = parse(params)?;
            if p.service.is_empty() || p.service.len() > 100 {
                return Err(bad_params("Which app?"));
            }
            b.apps_cancel(&p.service).await?;
            Ok(Value::Null)
        }
        "agents.appsSetGrants" => {
            let p: AppsGrantsParams = parse(params)?;
            if p.connection_id.is_empty()
                || p.connection_id.len() > 200
                || p.grants.len() > MAX_GRANTS
            {
                return Err(bad_params("Which connection, and which agents?"));
            }
            Ok(b.apps_set_grants(&p.connection_id, p.grants).await?)
        }
        "agents.appsRemove" => {
            let p: AppsConnectionParams = parse(params)?;
            if p.connection_id.is_empty() || p.connection_id.len() > 200 {
                return Err(bad_params("Which connection?"));
            }
            b.apps_remove(&p.connection_id).await?;
            Ok(Value::Null)
        }
        "agents.policy" => {
            let p: AgentParam = parse(params)?;
            Ok(b.policy(&p.agent_id).await?)
        }
        "agents.skills" => {
            let p: AgentParam = parse(params)?;
            Ok(b.skills(&p.agent_id).await?)
        }
        "agents.skillEdit" => {
            let p: SkillEditParams = parse(params)?;
            if !crate::agents::skills_learn::valid_slug(&p.edit.slug)
                || p.edit.steps.chars().count() > crate::agents::skills_learn::STEPS_CHARS * 2
            {
                return Err(bad_params("Which skill?"));
            }
            Ok(b.skill_edit(&p.agent_id, p.edit).await?)
        }
        "agents.skillRemove" => {
            let p: SkillParams = parse(params)?;
            if !crate::agents::skills_learn::valid_slug(&p.slug) {
                return Err(bad_params("Which skill?"));
            }
            b.skill_remove(&p.agent_id, &p.slug).await?;
            Ok(Value::Null)
        }
        "agents.onItsOwn" => {
            let p: AgentParam = parse(params)?;
            Ok(b.on_its_own(&p.agent_id).await?)
        }
        "agents.onItsOwnTeam" => Ok(b.on_its_own_team().await?),
        "agents.onItsOwnNarrow" => {
            let p: NarrowParams = parse(params)?;
            // Only the shapes the Mac knows: anything else (a "give") is refused here.
            serde_json::from_value::<crate::agents::on_its_own::Narrow>(p.narrow.clone())
                .map_err(|_| bad_params("That isn't something that can be taken away."))?;
            Ok(b.on_its_own_narrow(&p.agent_id, p.narrow).await?)
        }
        "agents.loginsTeam" => {
            let p: TeamParams = parse(params)?;
            Ok(b.logins_team(p.since).await?)
        }
        "agents.loginsConnect" => {
            let p: TeamConnectParams = parse(params)?;
            if p.key.is_empty() || p.option_id.is_empty() || p.skip.len() > 200 {
                return Err(bad_params("Which row, and which way in?"));
            }
            b.logins_connect(&p.key, &p.option_id, p.skip, p.on_phone)
                .await?;
            Ok(Value::Null)
        }
        "agents.loginDismiss" => {
            let p: LoginParams = parse(params)?;
            b.login_dismiss(&p.agent_id, &p.request_id).await?;
            Ok(Value::Null)
        }
        "agents.loginNotNeeded" => {
            let p: LoginParams = parse(params)?;
            Ok(b.login_not_needed(&p.agent_id, &p.request_id).await?)
        }
        "agents.loginsNotNeeded" => {
            let p: DeclineParams = parse(params)?;
            if p.keys
                .as_ref()
                .is_some_and(|k| k.is_empty() || k.len() > 200)
            {
                return Err(bad_params("Which rows?"));
            }
            Ok(b.logins_not_needed(p.keys).await?)
        }
        "agents.loginsUndecline" => {
            let p: DeclineParams = parse(params)?;
            let keys = p.keys.unwrap_or_default();
            if keys.is_empty() || keys.len() > 200 {
                return Err(bad_params("Which apps?"));
            }
            Ok(b.logins_undecline(keys).await?)
        }
        "agents.loginsRecheck" => {
            b.logins_recheck().await?;
            Ok(Value::Null)
        }
        "agents.revokePermission" => {
            let p: RuleParams = parse(params)?;
            b.revoke_permission(&p.agent_id, &p.rule_id).await?;
            Ok(Value::Null)
        }
        "agents.changeDiff" => {
            let p: DiffParams = parse(params)?;
            Ok(b.change_diff(&p.agent_id, &p.message_id, &p.path).await?)
        }
        "agents.keepCopy" => {
            let p: CopyParams = parse(params)?;
            Ok(b.keep_copy(&p.agent_id, &p.copy_id, p.into.as_deref())
                .await?)
        }
        "agents.discardCopy" => {
            let p: CopyParams = parse(params)?;
            b.discard_copy(&p.agent_id, &p.copy_id).await?;
            Ok(Value::Null)
        }
        "agents.watchLive" => {
            let p: WatchParams = parse(params)?;
            let (path, port) = b.watch_port(&p.agent_id, &p.message_id, p.link).await?;
            let base = b.watch_publish().await?;
            let (ticket, expires_at) = c.watch.mint(&caller.device_id, &path, port, now_ms());
            Ok(json!({
                "url": format!(
                    "{}{}{ticket}",
                    base.trim_end_matches('/'),
                    super::watch::ticket_prefix()
                ),
                "expiresAt": expires_at,
            }))
        }
        "agents.fetchPath" => {
            let p: PathParams = parse(params)?;
            let source = b.shareable_path(&p.agent_id, &p.path).await?;
            let blob = c.blobs.produce(&caller.device_id, &source, now_ms())?;
            Ok(to_value(&blob.as_ref()))
        }
        "agents.draft" => {
            let p: DraftParams = parse(params)?;
            refuse_unsafe_text(&p.description, "A description")?;
            if p.description.chars().count() > crate::agents::draft::MAX_DESCRIPTION {
                return Err(bad_params(format!(
                    "Keep the description under {} characters.",
                    crate::agents::draft::MAX_DESCRIPTION
                )));
            }
            // A draft spends the user's plan: counted as a new agent is.
            if !c.allow_create(&caller.device_id, now_ms()) {
                return Err(WireError::protocol(
                    ProtocolCode::RateLimited,
                    "That's a lot of drafts in a minute. Try again in a minute.",
                ));
            }
            Ok(b.draft_agent(p.description).await?)
        }
        "agents.search" => {
            let p: QueryParams = parse(params)?;
            Ok(super::wire::search_for_app(
                b.search(p.query).await?,
                caller.shows,
            ))
        }
        "agents.schedule.preview" => {
            let p: WhenParams = parse(params)?;
            Ok(b.schedule(ScheduleOp::Preview { when: p.when }).await?)
        }
        "agents.schedule.create"
        | "agents.schedule.update"
        | "agents.schedule.pause"
        | "agents.schedule.cancel"
        | "agents.schedule.runNow" => {
            let p: ScheduleParams = parse(params)?;
            let needs_id = method != "agents.schedule.create";
            if needs_id && p.id.trim().is_empty() {
                return Err(bad_params("id is required."));
            }
            // The note is the prompt the routine sends later, with nobody
            // watching: the same rules as a message typed now.
            refuse_unsafe_text(&p.note, "A routine's note")?;
            for step in p.then.iter().flatten() {
                refuse_unsafe_text(&step.text, "A routine's step")?;
            }
            let op = match method {
                "agents.schedule.create" => ScheduleOp::Create {
                    agent_id: p.agent_id,
                    when: p.when,
                    note: p.note,
                    then: p.then,
                },
                "agents.schedule.update" => ScheduleOp::Update {
                    agent_id: p.agent_id,
                    id: p.id,
                    when: p.when,
                    note: p.note,
                    then: p.then,
                },
                "agents.schedule.pause" => ScheduleOp::Pause {
                    agent_id: p.agent_id,
                    id: p.id,
                    paused: p.paused,
                },
                "agents.schedule.cancel" => ScheduleOp::Cancel {
                    agent_id: p.agent_id,
                    id: p.id,
                },
                _ => ScheduleOp::RunNow {
                    agent_id: p.agent_id,
                    id: p.id,
                },
            };
            Ok(b.schedule(op).await?)
        }
        "agents.watch.options" => {
            let p: ScheduleParams = parse(params)?;
            Ok(b.schedule(ScheduleOp::WatchOptions {
                agent_id: p.agent_id,
            })
            .await?)
        }
        "agents.watch.create" | "agents.watch.update" => {
            let p: WatchRoutineParams = parse(params)?;
            let update = method == "agents.watch.update";
            if update && p.id.trim().is_empty() {
                return Err(bad_params("id is required."));
            }
            // What to do, and a check in the user's own words, are prompts
            // the routine sends later with nobody watching: the same rules as
            // a message typed now.
            refuse_unsafe_text(&p.note, "A routine's note")?;
            if let crate::agents::watch::Source::Custom { check, .. } = &p.source {
                refuse_unsafe_text(check.as_str(), "What a routine looks out for")?;
            }
            let op = if update {
                ScheduleOp::WatchUpdate {
                    agent_id: p.agent_id,
                    id: p.id,
                    source: p.source,
                    every_minutes: p.every_minutes,
                    note: p.note,
                }
            } else {
                ScheduleOp::WatchCreate {
                    agent_id: p.agent_id,
                    source: p.source,
                    every_minutes: p.every_minutes,
                    note: p.note,
                }
            };
            Ok(b.schedule(op).await?)
        }
        "agents.watch.checkNow" => {
            let p: ScheduleParams = parse(params)?;
            if p.id.trim().is_empty() {
                return Err(bad_params("id is required."));
            }
            Ok(b.schedule(ScheduleOp::WatchCheckNow {
                agent_id: p.agent_id,
                id: p.id,
            })
            .await?)
        }
        "projects.list" => Ok(b.projects().await?),
        "sessions.read" => {
            let p: SessionParams = parse(params)?;
            Ok(b.session_screen(&p.session_id).await?)
        }
        "sessions.send" => {
            let p: SessionSendParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:session:{client_id}", caller.device_id);
            c.sends
                .once(key, now_ms(), || async move {
                    let text = crate::remote_access::tools::clean_agent_text(&p.text, "message")
                        .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?;
                    let session_id = b
                        .session_send(&p.project, p.session_id.as_deref(), &text)
                        .await?;
                    Ok(json!({ "sessionId": session_id }))
                })
                .await
        }
        "sessions.key" => {
            let p: SessionKeyParams = parse(params)?;
            if crate::remote_access::tools::key_bytes(&p.key).is_none() {
                return Err(WireError::protocol(
                    ProtocolCode::Refused,
                    format!("\"{}\" isn't a key the phone can press.", p.key),
                ));
            }
            b.session_key(&p.session_id, &p.key).await?;
            Ok(Value::Null)
        }
        "sessions.start" => {
            let p: SessionStartParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:start:{client_id}", caller.device_id);
            c.sends
                .once(key, now_ms(), || async move {
                    let prompt = crate::remote_access::tools::clean_agent_text(&p.prompt, "prompt")
                        .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?;
                    let session_id = b.session_start(&p.project, &prompt).await?;
                    Ok(json!({ "sessionId": session_id }))
                })
                .await
        }
        "preview.screenshot" => {
            let p: ScreenshotParams = parse(params)?;
            let phone = matches!(p.device, ScreenshotDevice::Phone);
            let jpeg = b.preview_screenshot(&p.project, phone).await?;
            let name = format!(
                "{}-{}.jpg",
                crate::remote_access::tools::project_name(&p.project),
                if phone { "phone" } else { "desktop" }
            );
            let blob = c.blobs.put(
                &caller.device_id,
                &name,
                Some("image/jpeg"),
                &jpeg,
                now_ms(),
            )?;
            Ok(to_value(&blob.as_ref()))
        }
        _ => Err(WireError::protocol(
            ProtocolCode::UnknownMethod,
            format!("This Mac doesn't know {method}."),
        )),
    }
}

/// The staged uploads a send names, as files `attachments::save` can copy.
/// Every id must be this device's and still staged.
fn staged(c: &Companion, device_id: &str, ids: &[String]) -> Result<Vec<Staged>, WireError> {
    use crate::agents::attachments::MAX_FILES;
    if ids.len() > MAX_FILES {
        return Err(CommandError::expected(format!(
            "You can attach up to {MAX_FILES} files at a time."
        ))
        .into());
    }
    ids.iter()
        .map(|id| {
            c.blobs
                .get(device_id, id, now_ms())
                .map(|blob| Staged {
                    name: blob.name,
                    path: blob.path,
                })
                .ok_or_else(|| {
                    CommandError::expected(
                        "A file you attached didn't reach the Mac, or waited over an hour. Attach it again.",
                    )
                    .into()
                })
        })
        .collect()
}

/// The Mac's status now, journaled when it changed so phones that weren't
/// asking hear about it too.
pub async fn refresh_status(c: &Companion) -> MacStatus {
    let status = c.backend.mac_status().await;
    if c.remember_status(&status) {
        c.hub.publish(super::wire::Event::System {
            status: status.clone(),
        });
    }
    status
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

#[cfg(test)]
#[path = "router_tests.rs"]
mod tests;
