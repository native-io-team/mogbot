//! "Change this agent's settings?": the card behind `propose_settings_change`.
//!
//! Any agent may propose a change to what it may do; an admin
//! (`policy::is_admin`, the Chief by default) may propose one for other
//! agents and for the team's defaults. Only the user applies it: the tool
//! puts a card in the proposer's chat with the change in plain words, one
//! group of sentences per set of agents it changes the same way ("Hiring:
//! Can now work in Client Site (its own copy). Can no longer use your
//! browser."), and returns at once. Allow applies it (`answer_card`, from
//! the desk or the phone); Deny applies nothing. Either wakes the proposer.
//!
//! - **Outside text never proposes.** A turn answering a "When…" routine's
//!   items, or anything carrying their taint, is refused before a card.
//! - **What was shown is what's applied.** The card keeps the policy's
//!   version; if anything changed since (the desk, another card), Allow
//!   applies nothing and says to ask again.
//! - **This Mac's switches** ("Fix stopped previews", "Keep this Mac
//!   awake", "Keep running when closed", "Open at login", "Your Chrome") ride the same card
//!   ([`MacChange`]): on is a card, off applies with a line.
//! - **An app already connected here** ("let Outreach use Linear") is given,
//!   narrowed or taken away on the same card ([`GrantChange`]): giving one
//!   or widening it is a card; taking it away or down to read applies with a
//!   line. No sign-in happens here, and no token is seen.
//! - **Nothing that strands work.** A change that would leave an open copy's
//!   work or the project an agent is set to work in out of reach is refused
//!   up front, with the step to take first (`policy::blocker`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::connections::{self, Access, Connection};
use super::independence::Level;
use super::policy::{self, AppsMode, Change, Elsewhere, Folder, How, Preset, Saved, Scope, Target};
use super::runner;
use super::store::{self, Agent, AgentRef, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/// Agents changed the same way, and how, in plain sentences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// "Hiring", "Hiring and Sales", "Everyone else", "Team defaults".
    pub who: String,
    #[serde(default)]
    pub agent_ids: Vec<String>,
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub targets: Vec<Target>,
    pub change: Change,
    /// The policy's version when this was proposed.
    pub version: u64,
    pub groups: Vec<Group>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// Some of it is a rule: words the agent is given, not something the app stops.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_rules: bool,
    /// A switch for this whole Mac rather than an agent's settings
    /// (Settings → Agents → On this Mac). Then `targets` and `change` are
    /// empty and the policy isn't touched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<MacChange>,
    /// Apps already connected here, given to or taken from the agents named.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<GrantChange>,
}

/// This Mac's switches that chat can change through the same card. Each is
/// "agents keep going / do more" when on, so off never needs the card.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacChange {
    /// "Fix stopped previews" (`agents_fix_previews`, `preview_fix`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_previews: Option<bool>,
    /// "Keep this Mac awake" (`remote_access::power`, the `caffeinate` assertion).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_awake: Option<bool>,
    /// "Keep running when closed".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_running: Option<bool>,
    /// "Open at login" (a LaunchAgent: system persistence, so on is a card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_at_login: Option<bool>,
    /// "Your Chrome" (`user_chrome`): agents may drive the user's own,
    /// signed-in Chrome through the app's extension, on any engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub your_chrome: Option<bool>,
}

/// The tool's names for them, in [`MacChange`]'s order.
pub const MAC_KEYS: [&str; 5] = [
    "fix_previews",
    "keep_awake",
    "keep_running",
    "open_at_login",
    "your_chrome",
];

/// How this Mac's switches are now, read back from each thing itself.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MacNow {
    pub fix_previews: bool,
    pub keep_awake: bool,
    pub keep_running: bool,
    pub open_at_login: bool,
    pub your_chrome: bool,
    /// macOS, where the last three exist.
    pub stay_on_supported: bool,
    /// Where the Your Chrome link runs (macOS).
    pub your_chrome_supported: bool,
    /// False in a dev build: there is no app bundle to reopen.
    pub open_at_login_available: bool,
}

/// The switches' plain words on the card: (on, off).
const FIX: (&str, &str) = (
    "Agents fix their own stopped previews without being asked",
    "Agents no longer fix stopped previews on their own: the preview offers to ask them",
);
const AWAKE: (&str, &str) = (
    "This Mac stays awake while the app is open, so agents keep going",
    "This Mac may sleep again: agents pause while it sleeps",
);
const RUNNING: (&str, &str) = (
    "Closing the window keeps agents going; ⌘Q still quits",
    "Closing the window no longer keeps agents going",
);
const LOGIN: (&str, &str) = (
    "The app reopens at login, so agents carry on after a restart",
    "The app no longer reopens at login",
);
const CHROME: (&str, &str) = (
    "Agents may use your own Chrome, signed in as you, through the app's extension (each send still asks)",
    "Agents no longer use your own Chrome",
);

impl MacChange {
    fn from_args(c: &Value) -> Self {
        let b = |k: &str| c.get(k).and_then(Value::as_bool);
        MacChange {
            fix_previews: b("fix_previews"),
            keep_awake: b("keep_awake"),
            keep_running: b("keep_running"),
            open_at_login: b("open_at_login"),
            your_chrome: b("your_chrome"),
        }
    }

    fn is_empty(&self) -> bool {
        *self == MacChange::default()
    }
}

/// The card (or the line) for this Mac's switches, or why not. Only an
/// admin proposes them: they are the whole Mac's, not one agent's. Only
/// what differs from now is kept.
pub fn mac_proposal(
    admin: bool,
    want: &MacChange,
    now: &MacNow,
    why: Option<String>,
    version: u64,
) -> Result<Proposal, String> {
    if !admin {
        return Err("Only an admin (the Chief of Staff) can propose this Mac's settings. Ask it with message_agent.".into());
    }
    let stay_on =
        want.keep_awake.is_some() || want.keep_running.is_some() || want.open_at_login.is_some();
    if stay_on && !now.stay_on_supported {
        return Err("Keeping agents going (awake, running when closed, open at login) is only offered on macOS.".into());
    }
    if want.your_chrome.is_some() && !now.your_chrome_supported {
        return Err("Your Chrome is only offered on macOS. Nothing changed.".into());
    }
    if want.open_at_login == Some(true) && !now.open_at_login_available {
        return Err("Open at login isn't available in this build: there is no app to reopen. Nothing changed.".into());
    }
    let mut kept = MacChange::default();
    let mut lines = Vec::new();
    for (wanted, is_now, words, slot) in [
        (
            want.fix_previews,
            now.fix_previews,
            FIX,
            &mut kept.fix_previews,
        ),
        (want.keep_awake, now.keep_awake, AWAKE, &mut kept.keep_awake),
        (
            want.keep_running,
            now.keep_running,
            RUNNING,
            &mut kept.keep_running,
        ),
        (
            want.open_at_login,
            now.open_at_login,
            LOGIN,
            &mut kept.open_at_login,
        ),
        (
            want.your_chrome,
            now.your_chrome,
            CHROME,
            &mut kept.your_chrome,
        ),
    ] {
        if let Some(on) = wanted.filter(|on| *on != is_now) {
            *slot = Some(on);
            lines.push(if on { words.0 } else { words.1 }.to_string());
        }
    }
    if lines.is_empty() {
        return Err("That's already how it is: nothing would change.".into());
    }
    Ok(Proposal {
        targets: Vec::new(),
        change: Change::default(),
        version,
        groups: vec![Group {
            who: "This Mac".into(),
            agent_ids: Vec::new(),
            changes: lines,
        }],
        why: clean_why(why),
        has_rules: false,
        mac: Some(kept),
        grants: Vec::new(),
    })
}

fn clean_why(why: Option<String>) -> Option<String> {
    why.map(|w| w.trim().chars().take(200).collect())
        .filter(|w: &String| !w.is_empty())
}

/// A Mac switch that only has agents do less on their own applies without
/// a card: every switch it sets goes off.
pub fn mac_lowers(m: &MacChange) -> bool {
    !m.is_empty()
        && [
            m.fix_previews,
            m.keep_awake,
            m.keep_running,
            m.open_at_login,
            m.your_chrome,
        ]
        .iter()
        .all(|v| *v != Some(true))
}

fn mac_now() -> MacNow {
    let stay = crate::commands::remote_access::stay_on_now();
    MacNow {
        fix_previews: crate::commands::setup::read_app_state()
            .agents_fix_previews
            .unwrap_or(true),
        keep_awake: stay.keep_awake,
        keep_running: stay.keep_running,
        open_at_login: stay.open_at_login,
        your_chrome: crate::user_chrome::settings::enabled(),
        stay_on_supported: stay.supported,
        your_chrome_supported: crate::user_chrome::SUPPORTED,
        open_at_login_available: stay.open_at_login_available,
    }
}

fn apply_mac(m: &MacChange) -> Result<(), String> {
    if let Some(on) = m.fix_previews {
        crate::commands::settings::set_agents_fix_previews(on).map_err(|e| e.to_string())?;
    }
    if m.keep_awake.is_some() || m.keep_running.is_some() || m.open_at_login.is_some() {
        crate::commands::remote_access::write_stay_on(
            m.keep_awake,
            m.keep_running,
            m.open_at_login,
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(on) = m.your_chrome {
        crate::user_chrome::settings::set_enabled(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// After a Mac change applied: the menu bar, quick entry and Settings show it.
fn synced_mac(app: &AppHandle, p: &Proposal) {
    if let Some(m) = &p.mac {
        if m.keep_awake.is_some() || m.keep_running.is_some() || m.open_at_login.is_some() {
            crate::commands::remote_access::sync_stay_on(app, m.keep_running.is_some());
        }
        // Saved by `apply_mac`; this starts or stops the link to match.
        if let Some(on) = m.your_chrome {
            tracing::info!(on, "[Agents] Your Chrome switched from chat");
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::user_chrome::set_enabled(on).await {
                    tracing::warn!("[Agents] Your Chrome didn't follow its switch: {e}");
                }
            });
        }
    }
}

/* ------------------------------------------------- apps already connected */

/// One agent's access to one connection, as the card shows and applies it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrantChange {
    pub agent_id: String,
    pub connection_id: String,
    /// What it has now; Allow applies nothing if that moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Access>,
    /// What it has after; `None` takes it away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<Access>,
    /// "Can use Linear (sam@acme.com), read only".
    pub line: String,
}

impl GrantChange {
    /// Taking away, or down to read: less room, so no card.
    pub fn lowers(&self) -> bool {
        match (self.before, self.access) {
            (_, None) => true,
            (Some(Access::Full), Some(Access::Read)) => true,
            _ => false,
        }
    }
}

/// What `changes.connections` asks for: (app, account, access) to give and
/// (app, account) to take away.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrantAsk {
    pub give: Vec<(String, Option<String>, Access)>,
    pub take: Vec<(String, Option<String>)>,
}

impl GrantAsk {
    pub fn parse(v: Option<&Value>) -> Result<Self, String> {
        let Some(v) = v else {
            return Ok(Self::default());
        };
        let item = |x: &Value| -> Result<(String, Option<String>, Option<String>), String> {
            let app = x
                .get("app")
                .and_then(Value::as_str)
                .or_else(|| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Each app in `connections` needs `app`, e.g. \"Linear\".")?;
            let s = |k: &str| {
                x.get(k)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            Ok((app.to_string(), s("account"), s("access")))
        };
        let mut out = Self::default();
        for x in v
            .get("give")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (app, account, access) = item(x)?;
            let access = match access.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None | Some("read") => Access::Read,
                Some("full") | Some("send") | Some("write") => Access::Full,
                Some(other) => return Err(format!("`access` can't be \"{other}\": read or full.")),
            };
            out.give.push((app, account, access));
        }
        for x in v
            .get("take")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (app, account, _) = item(x)?;
            out.take.push((app, account));
        }
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self.give.is_empty() && self.take.is_empty()
    }
}

fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The one connection here for `app` (its service id or title, however
/// spelled) and, when given, `account`. Pure, for tests.
pub fn find_connection<'a>(
    list: &'a [Connection],
    app: &str,
    account: Option<&str>,
) -> Result<&'a Connection, String> {
    let want = squash(app);
    let of_app: Vec<&Connection> = list
        .iter()
        .filter(|c| squash(&c.service) == want || squash(&c.title) == want)
        .collect();
    if of_app.is_empty() {
        return Err(format!("{app} isn't connected on this Mac yet, so there's nothing to give. The agent that needs it asks with request_login, which offers the sign-in."));
    }
    let picked: Vec<&Connection> = match account {
        Some(a) => of_app
            .iter()
            .copied()
            .filter(|c| c.account.to_lowercase().contains(&a.to_lowercase()))
            .collect(),
        None => of_app.clone(),
    };
    match picked.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "There's no {} account matching \"{}\": {}.",
            of_app[0].title,
            account.unwrap_or_default(),
            of_app
                .iter()
                .map(|c| c.account.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
        many => Err(format!(
            "There are {} {} accounts here ({}): say which with `account`.",
            many.len(),
            many[0].title,
            many.iter()
                .map(|c| c.account.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// The changes `ask` makes for each agent in `targets`, leaving out any
/// that would change nothing. `allowed(agent_id, connection)`: whether its
/// settings (after this card's own change) let it use that app at all, so a
/// grant its settings would hide isn't offered. Pure, for tests.
pub fn grant_changes(
    targets: &[Target],
    ask: &GrantAsk,
    list: &[Connection],
    allowed: impl Fn(&str, &Connection) -> bool,
    names: impl Fn(&str) -> String,
) -> Result<Vec<GrantChange>, String> {
    let mut out: Vec<GrantChange> = Vec::new();
    for t in targets {
        let Target::Agent { agent_id } = t else {
            return Err("Apps are given agent by agent: name the agents in `agents`.".into());
        };
        let wanted = ask
            .give
            .iter()
            .map(|(app, acct, a)| (app, acct, Some(*a)))
            .chain(ask.take.iter().map(|(app, acct)| (app, acct, None)));
        for (app, account, access) in wanted {
            let c = find_connection(list, app, account.as_deref())?;
            if access.is_some() && !allowed(agent_id, c) {
                return Err(format!(
                    "{}'s settings keep it from {}: add `apps: {{\"add\": [\"{}\"]}}` to this same change.",
                    names(agent_id),
                    c.title,
                    c.title
                ));
            }
            let before = c
                .grants
                .iter()
                .find(|g| g.agent_id == *agent_id)
                .map(|g| g.access);
            if before == access
                || out
                    .iter()
                    .any(|g| g.agent_id == *agent_id && g.connection_id == c.id)
            {
                continue;
            }
            let what = format!("{} ({})", c.title, c.account);
            let line = match (before, access) {
                (_, None) => format!("Can no longer use {what}"),
                (Some(Access::Full), Some(Access::Read)) => format!("{what}: read only now"),
                (Some(_), Some(Access::Full)) => {
                    format!("{what}: can now ask to send or change things too")
                }
                (None, Some(Access::Read)) => format!("Can use {what}, read only"),
                (_, Some(Access::Full)) | (_, Some(Access::Read)) => {
                    format!("Can use {what}, and asks you before it sends or changes anything")
                }
            };
            out.push(GrantChange {
                agent_id: agent_id.clone(),
                connection_id: c.id.clone(),
                before,
                access,
                line,
            });
        }
    }
    Ok(out)
}

/// The grants' lines, into the card's groups: an agent's own group when it
/// has one, else a new one.
pub fn add_grant_lines(
    groups: &mut Vec<Group>,
    grants: &[GrantChange],
    names: impl Fn(&str) -> String,
) {
    for g in grants {
        match groups
            .iter_mut()
            .find(|x| x.agent_ids.len() == 1 && x.agent_ids[0] == g.agent_id)
        {
            Some(x) => x.changes.push(g.line.clone()),
            None => groups.push(Group {
                who: names(&g.agent_id),
                agent_ids: vec![g.agent_id.clone()],
                changes: vec![g.line.clone()],
            }),
        }
    }
}

fn apply_grants(grants: &[GrantChange]) -> Result<(), String> {
    // What the card showed, all of it, before anything is written.
    let list = connections::list().map_err(|e| e.to_string())?;
    for g in grants {
        let c = list
            .iter()
            .find(|c| c.id == g.connection_id)
            .ok_or("That app was disconnected after this was proposed.")?;
        if c.grants
            .iter()
            .find(|x| x.agent_id == g.agent_id)
            .map(|x| x.access)
            != g.before
        {
            return Err("Its access to that app changed after this was proposed.".into());
        }
    }
    for g in grants {
        connections::set_access(&g.connection_id, &g.agent_id, g.before, g.access)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub const TOOL: &str = "propose_settings_change";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "agents": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Who it's for: agent names, \"team\" for the team's defaults, or \"everyone\" (the team's defaults, and every agent's own setting for what changes goes). Left out: yourself. Only admins may name others."
            },
            "changes": {
                "type": "object",
                "description": "Only what changes. A base first (preset, like, or same_as_team), then any field on top.",
                "properties": {
                    "preset": { "type": "string", "enum": ["trusted", "balanced", "locked"], "description": "trusted (\"I trust my agents\"), balanced (the default) or locked (\"Locked down\")." },
                    "like": { "type": "string", "description": "Make it like this other agent (name)." },
                    "same_as_team": { "type": "boolean", "description": "Drop its own settings and use the team's." },
                    "projects": {
                        "type": "object",
                        "properties": {
                            "scope": { "type": "string", "enum": ["all", "listed", "none"] },
                            "add": { "type": "array", "items": { "type": "string" }, "description": "Project names (from project_list) it may work in." },
                            "remove": { "type": "array", "items": { "type": "string" } },
                            "how": { "type": "string", "enum": ["read_only", "copy", "direct"], "description": "In the project it's set to work in: read only, its own copy (the default), or directly in the user's folder." },
                            "elsewhere": { "type": "string", "enum": ["read", "change"], "description": "In its other projects: read only, or change directly." }
                        }
                    },
                    "folders": {
                        "type": "object",
                        "properties": {
                            "add": { "type": "array", "items": { "type": "object", "properties": { "path": { "type": "string" }, "write": { "type": "boolean" } }, "required": ["path"] }, "description": "Folders on this Mac (~/… is fine). write: may change files there too." },
                            "remove": { "type": "array", "items": { "type": "string" } }
                        }
                    },
                    "apps": {
                        "type": "object",
                        "properties": {
                            "mode": { "type": "string", "enum": ["all", "only", "none"] },
                            "add": { "type": "array", "items": { "type": "string" }, "description": "App names (Gmail, Linear…)." },
                            "remove": { "type": "array", "items": { "type": "string" } }
                        }
                    },
                    "browser": { "type": "boolean", "description": "May use the user's signed-in browser." },
                    "independence": { "type": "string", "enum": ["careful", "steady", "bold", "unleashed", "often", "judgement", "go_hard", "full_send", "team"], "description": "How much it does on its own, for the agents named (each may have its own; \"team\" puts one back on the team's level). Shown to the user as a slider: Careful, Steady, Bold, Unleashed (often, judgement, go_hard, full_send are the same stops); say those names, and read the old ones they may type (\"check with me often\", \"good judgement\", \"go hard\", \"full send\") as the same levels. Name the agent for one (\"put Social Posts on Unleashed\": agents [\"Social Posts\"]), \"team\" for everyone's default. full_send when the user says \"unleashed\", \"go full send\", \"let it rip\" or \"stop asking me\". Raising needs the user's card; lowering (\"make Finance careful\": often) applies at once." },
                    "admin": { "type": "boolean", "description": "Admins may propose changes for other agents." },
                    "outward_text_needs_ok": { "type": "boolean", "description": "Nothing goes out under the user's name (message, post, comment, email, issue, pull request) until they OK its exact text on a card, at every level including Unleashed. On when the user says \"nothing goes out unless I approve the exact text\" or \"word for word\": the app enforces it, unlike a rule. On applies at once." },
                    "fix_previews": { "type": "boolean", "description": "This Mac's \"Fix stopped previews\" switch: agents fix a preview that stopped by itself." },
                    "keep_awake": { "type": "boolean", "description": "This Mac's \"Keep this Mac awake\": agents pause while it sleeps (\"keep going overnight\")." },
                    "keep_running": { "type": "boolean", "description": "This Mac's \"Keep running when closed\": closing the window keeps agents going." },
                    "open_at_login": { "type": "boolean", "description": "This Mac's \"Open at login\": the app reopens after a restart." },
                    "your_chrome": { "type": "boolean", "description": "This Mac's \"Your Chrome\": agents may use the user's own signed-in Chrome through the app's extension, on any engine (\"let agents use my Chrome\")." },
                    "connections": {
                        "type": "object",
                        "description": "Apps already connected on this Mac, for the agents named (\"let Outreach use Linear\"). Not a sign-in: an app not connected yet is the agent's request_login. Giving or widening is a card; taking away or down to read applies at once.",
                        "properties": {
                            "give": { "type": "array", "items": { "type": "object", "properties": { "app": { "type": "string" }, "account": { "type": "string", "description": "Which one, when there are several." }, "access": { "type": "string", "enum": ["read", "full"], "description": "read (the default), or full: may also send and change, asking on a card each time." } }, "required": ["app"] } },
                            "take": { "type": "array", "items": { "type": "object", "properties": { "app": { "type": "string" }, "account": { "type": "string" } }, "required": ["app"] } }
                        }
                    },
                    "rules": {
                        "type": "object",
                        "properties": {
                            "add": { "type": "array", "items": { "type": "string" }, "description": "Plain rules, e.g. \"Never email clients\"." },
                            "remove": { "type": "array", "items": { "type": "string" } }
                        }
                    }
                }
            },
            "why": { "type": "string", "description": "One line: what the user asked for." }
        },
        "required": ["changes"]
    })
}

pub const DESCRIPTION: &str = "Propose a change to what an agent may do (projects and how it works in them, folders on this Mac, apps, an app already connected here, the user's browser, independence, admin, rules, whether sends wait for the exact text's OK), to the team's defaults, or to this Mac's switches (“Fix stopped previews”, keep awake, keep running when closed, open at login, Your Chrome; on their own, with no agents; off applies at once). Use it whenever the user says an agent should or shouldn't be able to do something, or asks to reset settings or make one agent like another. The user gets a card showing the change in plain words and applies it with Allow; nothing changes before. It returns at once: say in one line what you proposed and stop; you're told when they answer. Never tell the user to go to Settings.";

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn enum_of<T: serde::de::DeserializeOwned>(
    v: Option<&Value>,
    field: &str,
) -> Result<Option<T>, String> {
    match v.and_then(Value::as_str) {
        None => Ok(None),
        Some(s) => serde_json::from_value(Value::String(s.trim().to_ascii_lowercase()))
            .map(Some)
            .map_err(|_| format!("`{field}` can't be \"{s}\".")),
    }
}

fn expand(raw: &str) -> String {
    let raw = raw.trim();
    match (raw.strip_prefix('~'), dirs::home_dir()) {
        (Some(rest), Some(home)) => home
            .join(rest.trim_start_matches('/'))
            .to_string_lossy()
            .trim_end_matches('/')
            .to_string(),
        _ => raw.trim_end_matches('/').to_string(),
    }
}

/// The tool's `changes` as a [`Change`], names resolved: projects through
/// `project_list`'s names, agents through the registry, folders checked.
pub async fn parse_change(c: &Value) -> Result<Change, String> {
    let mut out = Change {
        preset: match c.get("preset").and_then(Value::as_str) {
            None => None,
            Some(p) => Some(Preset::parse(p).ok_or_else(|| {
                format!("There's no preset called {p}: trusted, balanced or locked.")
            })?),
        },
        same_as_team: c
            .get("same_as_team")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        browser: c.get("browser").and_then(Value::as_bool),
        admin: c.get("admin").and_then(Value::as_bool),
        outward_text_needs_ok: c.get("outward_text_needs_ok").and_then(Value::as_bool),
        independence: c
            .get("independence")
            .and_then(Value::as_str)
            .map(str::to_string),
        ..Default::default()
    };
    if let Some(i) = &out.independence {
        if !i.trim().eq_ignore_ascii_case("team") {
            Level::parse(i).map_err(|e| e.to_string())?;
        }
    }
    if let Some(like) = c.get("like").and_then(Value::as_str) {
        let a = store::find(like)
            .ok()
            .flatten()
            .ok_or_else(|| format!("There's no agent called {like}."))?;
        out.like = Some(a.id);
    }
    if let Some(p) = c.get("projects") {
        out.scope = enum_of::<Scope>(p.get("scope"), "projects.scope")?;
        out.how = enum_of::<How>(p.get("how"), "projects.how")?;
        out.elsewhere = enum_of::<Elsewhere>(p.get("elsewhere"), "projects.elsewhere")?;
        for (key, into) in [
            ("add", &mut out.add_projects),
            ("remove", &mut out.remove_projects),
        ] {
            for name in strings(p.get(key)) {
                let found = super::project::resolve(&name)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("`projects.{key}` needs a project, not \"{name}\"."))?;
                into.push(found.path.trim_end_matches('/').to_string());
            }
        }
    }
    if let Some(f) = c.get("folders") {
        for item in f.get("add").and_then(Value::as_array).into_iter().flatten() {
            let raw = item
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
                .unwrap_or("");
            out.add_folders.push(Folder {
                path: policy::clean_folder(raw)?,
                write: item.get("write").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        out.remove_folders = strings(f.get("remove")).iter().map(|s| expand(s)).collect();
    }
    if let Some(a) = c.get("apps") {
        out.apps = enum_of::<AppsMode>(a.get("mode"), "apps.mode")?;
        out.add_apps = strings(a.get("add"));
        out.remove_apps = strings(a.get("remove"));
    }
    if let Some(r) = c.get("rules") {
        out.add_rules = strings(r.get("add"));
        out.remove_rules = strings(r.get("remove"));
    }
    if out.is_empty() {
        return Err("`changes` is empty: say what should change.".into());
    }
    Ok(out)
}

/// Who `names` are, for `caller`. Empty is the caller itself.
pub fn parse_targets(caller: &Agent, names: &[String]) -> Result<Vec<Target>, String> {
    if names.is_empty() {
        return Ok(vec![Target::Agent {
            agent_id: caller.id.clone(),
        }]);
    }
    let mut out = Vec::new();
    for n in names {
        let t = match n.to_ascii_lowercase().as_str() {
            "team" | "team defaults" | "the team" => Target::Team { everyone: false },
            "everyone" | "all" | "all agents" | "everybody" => Target::Team { everyone: true },
            _ => {
                let a = store::find(n)
                    .ok()
                    .flatten()
                    .ok_or_else(|| format!("There's no agent called {n}."))?;
                Target::Agent { agent_id: a.id }
            }
        };
        if !out.contains(&t) {
            out.push(t);
        }
    }
    if out.iter().any(|t| matches!(t, Target::Team { .. })) && out.len() > 1 {
        return Err("Propose the team's change on its own, then each agent's.".into());
    }
    Ok(out)
}

/// May `caller` propose this? Admins: anything. Others: only themselves,
/// and never their own admin role.
pub fn may_propose(
    caller: &Agent,
    admin: bool,
    targets: &[Target],
    change: &Change,
) -> Result<(), String> {
    if admin {
        return Ok(());
    }
    let only_self = targets
        .iter()
        .all(|t| matches!(t, Target::Agent { agent_id } if *agent_id == caller.id));
    if !only_self {
        return Err("Only an admin (the Chief of Staff) can propose changes for other agents or the team. Ask it with message_agent, or tell the user it's the Chief's to propose.".into());
    }
    if change.admin.is_some() {
        return Err("Only an admin can propose who's an admin.".into());
    }
    Ok(())
}

/// The policy after `targets` get `change`, and the team's new level if any.
pub fn simulate(
    saved: &Saved,
    targets: &[Target],
    change: &Change,
    level: Level,
) -> Result<(Saved, Level), String> {
    let mut after = saved.clone();
    let mut new_level = level;
    for t in targets {
        if let Some(l) = policy::apply(&mut after, t, change, new_level)? {
            new_level = l;
        }
    }
    Ok((after, new_level))
}

fn names(list: &[&Agent]) -> String {
    let n: Vec<String> = list.iter().map(|a| a.name.clone()).collect();
    match n.len() {
        0 => String::new(),
        1 => n[0].clone(),
        2 => format!("{} and {}", n[0], n[1]),
        3 => format!("{}, {} and {}", n[0], n[1], n[2]),
        k => format!("{}, {} and {} others", n[0], n[1], k - 2),
    }
}

/// Plain-word groups: each set of agents changed the same way.
pub fn groups(
    before: &Saved,
    after: &Saved,
    agents: &[Agent],
    before_level: Level,
    after_level: Level,
) -> Vec<Group> {
    let mut out: Vec<(Vec<String>, Vec<&Agent>)> = Vec::new();
    for a in agents {
        let b = policy::resolve(before, a, before_level);
        let x = policy::resolve(after, a, after_level);
        let d = policy::diff(&b, &x, a.project.as_deref());
        if d.is_empty() {
            continue;
        }
        match out.iter_mut().find(|(lines, _)| *lines == d) {
            Some((_, who)) => who.push(a),
            None => out.push((d, vec![a])),
        }
    }
    let everyone = agents.len() > 1 && out.len() == 1 && out[0].1.len() == agents.len();
    out.into_iter()
        .map(|(changes, who)| Group {
            who: if everyone {
                "Everyone".to_string()
            } else {
                names(&who)
            },
            agent_ids: who.iter().map(|a| a.id.clone()).collect(),
            changes,
        })
        .collect()
}

pub fn title(targets: &[Target], agents: &[Agent]) -> String {
    match targets {
        [Target::Team { everyone: true }] => "Change everyone's settings?".to_string(),
        [Target::Team { .. }] => "Change the team's settings?".to_string(),
        [Target::Agent { agent_id }] => {
            let name = agents
                .iter()
                .find(|a| a.id == *agent_id)
                .map(|a| a.name.clone())
                .unwrap_or_else(|| "this agent".into());
            format!("Change {name}'s settings?")
        }
        many => format!("Change {} agents' settings?", many.len()),
    }
}

/// The card's own words, for any client: one line per group.
pub fn summary(groups: &[Group]) -> String {
    groups
        .iter()
        .map(|g| format!("{}: {}.", g.who, g.changes.join(". ")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Build the proposal, or say why not. Pure, for tests: no card, no write.
#[allow(clippy::too_many_arguments)]
pub fn build(
    caller: &Agent,
    admin: bool,
    targets: Vec<Target>,
    change: Change,
    why: Option<String>,
    saved: &Saved,
    agents: &[Agent],
    level: Level,
) -> Result<Proposal, String> {
    may_propose(caller, admin, &targets, &change)?;
    let (after, new_level) = simulate(saved, &targets, &change, level)?;
    for a in agents {
        let x = policy::resolve(&after, a, new_level);
        let b = policy::resolve(saved, a, level);
        if b != x {
            if let Some(why) = policy::blocker(a, &x) {
                return Err(why);
            }
        }
    }
    let mut gs = groups(saved, &after, agents, level, new_level);
    // The team's own defaults, when they change and no agent shows it (or
    // nobody inherits them).
    if targets.iter().any(|t| matches!(t, Target::Team { .. })) {
        let blank = policy::Overrides::default();
        let b = policy::resolve_with(&saved.team, &blank, false, level);
        let x = policy::resolve_with(&after.team, &blank, false, new_level);
        let d = policy::diff(&b, &x, None);
        if !d.is_empty() && gs.iter().all(|g| g.changes != d) {
            gs.insert(
                0,
                Group {
                    who: "Team defaults".into(),
                    agent_ids: Vec::new(),
                    changes: d,
                },
            );
        }
    }
    if gs.is_empty() {
        return Err("That's already how it is: nothing would change.".into());
    }
    // The exact-text rule is enforced (`outward`), so it isn't "only words".
    let has_rules = change
        .add_rules
        .iter()
        .any(|r| !policy::states_exact_text(r));
    Ok(Proposal {
        targets,
        change,
        version: saved.version,
        groups: gs,
        why: why
            .map(|w| w.trim().chars().take(200).collect())
            .filter(|w: &String| !w.is_empty()),
        has_rules,
        mac: None,
        grants: Vec::new(),
    })
}

/// A turn answering outside text (a "When…" routine's items, or anything
/// carrying their taint) never proposes: text from outside can't widen what
/// an agent may do, not even as a card.
pub fn outside_refusal(outside: bool) -> Option<&'static str> {
    outside.then_some("Not while answering what a “When…” routine found: that text came from outside this app, so it can't change what agents may do. Tell the user instead.")
}

/// The tool: a card in the caller's chat, nothing applied.
pub async fn propose(app: &AppHandle, caller: &Agent, turn: Option<u64>, args: &Value) -> Value {
    if let Some(refused) = outside_refusal(
        runner::from_outside(&caller.id) && super::broker::is_live(&caller.id, turn),
    ) {
        return error(refused);
    }
    let why = args.get("why").and_then(Value::as_str).map(str::to_string);
    let changes = args.get("changes").unwrap_or(&Value::Null);
    let mac = MacChange::from_args(changes);
    if !mac.is_empty() {
        let others = changes
            .as_object()
            .is_some_and(|o| o.keys().any(|k| !MAC_KEYS.contains(&k.as_str())));
        if others || !strings(args.get("agents")).is_empty() {
            return error("Propose this Mac's switches on their own, with no agents, then any agent's change.");
        }
        return match mac_proposal(
            policy::is_admin(caller),
            &mac,
            &mac_now(),
            why,
            policy::load().version,
        ) {
            Ok(p) => offer(app, caller, p, &store::list().unwrap_or_default()),
            Err(e) => error(e),
        };
    }
    let ask = match GrantAsk::parse(changes.get("connections")) {
        Ok(a) => a,
        Err(e) => return error(e),
    };
    let only_grants = !ask.is_empty()
        && changes
            .as_object()
            .is_some_and(|o| o.keys().all(|k| k == "connections"));
    let change = if only_grants {
        Change::default()
    } else {
        match parse_change(changes).await {
            Ok(c) => c,
            Err(e) => return error(e),
        }
    };
    let targets = match parse_targets(caller, &strings(args.get("agents"))) {
        Ok(t) => t,
        Err(e) => return error(e),
    };
    let agents = store::list().unwrap_or_default();
    let admin = policy::is_admin(caller);
    let saved = policy::load();
    let level = super::independence::level();
    let mut proposal = if only_grants {
        if let Err(e) = may_propose(caller, admin, &targets, &change) {
            return error(e);
        }
        Proposal {
            targets: targets.clone(),
            change,
            version: saved.version,
            groups: Vec::new(),
            why: clean_why(why),
            has_rules: false,
            mac: None,
            grants: Vec::new(),
        }
    } else {
        match build(
            caller,
            admin,
            targets.clone(),
            change,
            why,
            &saved,
            &agents,
            level,
        ) {
            Ok(p) => p,
            Err(e) => return error(e),
        }
    };
    if !ask.is_empty() {
        let after = match simulate(&saved, &targets, &proposal.change, level) {
            Ok((after, _)) => after,
            Err(e) => return error(e),
        };
        let name_of = |id: &str| {
            agents
                .iter()
                .find(|a| a.id == id)
                .map(|a| a.name.clone())
                .unwrap_or_else(|| "This agent".into())
        };
        let list = connections::list().unwrap_or_default();
        let grants = match grant_changes(
            &targets,
            &ask,
            &list,
            |id, c| policy::connection_allowed_in(&after, id, &c.service, &c.title),
            name_of,
        ) {
            Ok(g) => g,
            Err(e) => return error(e),
        };
        if grants.is_empty() && proposal.groups.is_empty() {
            return error("That's already how it is: nothing would change.");
        }
        add_grant_lines(&mut proposal.groups, &grants, name_of);
        proposal.grants = grants;
    }
    offer(app, caller, proposal, &agents)
}

/// Whether the card can be skipped: it only has agents do less on their own.
pub fn proposal_lowers(p: &Proposal, saved: &Saved, agents: &[Agent], level: Level) -> bool {
    if let Some(m) = &p.mac {
        return mac_lowers(m);
    }
    let grants_lower = p.grants.iter().all(GrantChange::lowers);
    if p.change.is_empty() {
        return !p.grants.is_empty() && grants_lower;
    }
    grants_lower && lowers_proposal(p, saved, agents, level)
}

/// Only stricter: applied now, with a line in the chat. Anything else: the card.
fn offer(app: &AppHandle, caller: &Agent, proposal: Proposal, agents: &[Agent]) -> Value {
    // A card is for giving agents more room, never for taking it away.
    let lowers = proposal_lowers(
        &proposal,
        &policy::load(),
        agents,
        super::independence::level(),
    );
    if lowers {
        return match apply_proposal(&proposal) {
            Ok(applied) => {
                synced_mac(app, &proposal);
                let lines = summary(&proposal.groups);
                let _ = runner::record(
                    app,
                    runner::new_message(
                        &caller.id,
                        MessageKind::Note,
                        format!("Settings changed: {}", lines.replace('\n', " ")),
                    ),
                );
                note_targets(app, &caller.id, &proposal, applied.as_ref());
                note_grants(app, &caller.id, &proposal);
                let _ = app.emit(runner::EVENT_REGISTRY, ());
                let _ = app.emit(EVENT, ());
                text(format!(
                    "Done, without a card: it only has agents do less on their own.\n{lines}\nIt applies from each agent's next turn. Say in one line what changed."
                ))
            }
            Err(e) => error(e),
        };
    }
    let mut approval = super::mcp::new_card(
        store::new_id(),
        if proposal.mac.is_some() {
            "Change this Mac's settings?".to_string()
        } else {
            title(&proposal.targets, agents)
        },
        detail(&proposal),
        None,
    );
    approval.summary = Some(summary(&proposal.groups));
    let lines = summary(&proposal.groups);
    approval.settings = Some(proposal);
    let mut card = runner::new_message(&caller.id, MessageKind::Approval, "");
    card.approval = Some(approval);
    if let Err(e) = runner::record(app, card) {
        return error(e.to_string());
    }
    store::refresh_pending(&caller.id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    text(format!(
        "A card is in this chat for the user to allow:\n{lines}\nNothing has changed yet. Say in one line what you proposed and stop; you'll be told when they answer."
    ))
}

/// Whether `p` only lowers independence: every agent it changes differs in
/// its level alone, and that level goes down; the team's other defaults stay
/// and its level doesn't go up. Anything else (raising one agent, putting one
/// back on a higher team level, any other setting) waits for the card.
pub fn lowers_proposal(p: &Proposal, saved: &Saved, agents: &[Agent], level: Level) -> bool {
    let Ok((after, new_level)) = simulate(saved, &p.targets, &p.change, level) else {
        return false;
    };
    lowers_only(saved, &after, agents, level, new_level)
}

pub fn lowers_only(
    before: &Saved,
    after: &Saved,
    agents: &[Agent],
    level: Level,
    new_level: Level,
) -> bool {
    // Turning the exact-text rule on only has agents do less on their own;
    // turning it off never applies without the card.
    let (bt, at) = (
        before.team.outward_text_needs_ok,
        after.team.outward_text_needs_ok,
    );
    if bt && !at {
        return false;
    }
    let team_rest = policy::Team {
        outward_text_needs_ok: bt,
        ..after.team.clone()
    };
    if before.team != team_rest || new_level.rank() > level.rank() {
        return false;
    }
    let mut lowered = new_level.rank() < level.rank() || (!bt && at);
    for a in agents {
        let b = policy::resolve(before, a, level);
        let mut x = policy::resolve(after, a, new_level);
        if b == x {
            continue;
        }
        if x.independence.rank() > b.independence.rank()
            || (b.outward_text_needs_ok && !x.outward_text_needs_ok)
        {
            return false;
        }
        lowered |= x.independence.rank() < b.independence.rank()
            || (!b.outward_text_needs_ok && x.outward_text_needs_ok);
        x.independence = b.independence;
        x.outward_text_needs_ok = b.outward_text_needs_ok;
        x.own = b.own.clone();
        if b != x {
            return false;
        }
    }
    lowered
}

fn detail(p: &Proposal) -> String {
    let mut out = summary(&p.groups);
    if let Some(why) = &p.why {
        out.push_str(&format!("\n\nWhy: {why}"));
    }
    if p.has_rules {
        out.push_str(
            "\n\nRules are instructions the agent is given; the app doesn't stop it breaking one.",
        );
    }
    out
}

/// The user's answer on the card. Allow applies it, if nothing changed
/// since it was proposed.
pub fn answer_card(
    app: &AppHandle,
    agent_id: &str,
    approval: &store::Approval,
    allow: bool,
    note: Option<String>,
) -> Result<(), CommandError> {
    let Some(p) = &approval.settings else {
        return Err(CommandError::expected("That isn't a settings card."));
    };
    let request_id = &approval.request_id;
    if !allow {
        let updated = match &note {
            Some(n) => store::deny_with_note(agent_id, request_id, n)?,
            None => store::set_approval_status(agent_id, request_id, ApprovalStatus::Denied)?,
        };
        finish(app, agent_id, updated);
        let said = note
            .as_deref()
            .map(|n| format!(" They said: \"{n}\"."))
            .unwrap_or_default();
        runner::enqueue(
            app,
            agent_id,
            format!("[The user declined the settings change you proposed ({}). Nothing changed.{said} Don't propose it again unless they ask.]", summary(&p.groups).replace('\n', " ")),
            runner::From::App,
        );
        return Ok(());
    }
    let applied = apply_proposal(p);
    match applied {
        Ok(changed) => {
            let updated =
                store::set_approval_status(agent_id, request_id, ApprovalStatus::Allowed)?;
            synced_mac(app, p);
            finish(app, agent_id, updated);
            note_targets(app, agent_id, p, changed.as_ref());
            note_grants(app, agent_id, p);
            // A level raised: open cards it now answers are answered.
            if p.change.independence.is_some() || p.change.preset.is_some() {
                super::mcp::sweep_auto_allowed(app);
            }
            runner::enqueue(
                app,
                agent_id,
                format!(
                    "[The user allowed the settings change you proposed. It applies from each agent's next turn: {}]",
                    summary(&p.groups).replace('\n', " ")
                ),
                runner::From::App,
            );
            Ok(())
        }
        Err(why) => {
            let updated = store::set_aside(agent_id, request_id, &why)?;
            finish(app, agent_id, updated);
            runner::enqueue(
                app,
                agent_id,
                format!("[The user allowed your settings change, but it couldn't be applied: {why} Nothing changed. Propose it again if it's still wanted.]"),
                runner::From::App,
            );
            Ok(())
        }
    }
}

/// Apply what a card showed, or say why it can't be any more. The policy
/// before and after, for who is told ([`notes_for`]); `None` for this Mac's
/// switches.
pub fn apply_proposal(p: &Proposal) -> Result<Option<(Saved, Saved)>, String> {
    if let Some(m) = &p.mac {
        return apply_mac(m).map(|()| None);
    }
    if p.change.is_empty() {
        return apply_grants(&p.grants).map(|()| None);
    }
    let level = super::independence::level();
    let agents = store::list().unwrap_or_default();
    let mut new_level = level;
    let mut changed = None;
    policy::modify(|saved| {
        if saved.version != p.version {
            return Err("The settings changed after this was proposed.".to_string());
        }
        let (after, l) = simulate(saved, &p.targets, &p.change, level)?;
        for a in &agents {
            let x = policy::resolve(&after, a, l);
            if policy::resolve(saved, a, level) != x {
                if let Some(why) = policy::blocker(a, &x) {
                    return Err(why);
                }
            }
        }
        changed = Some((saved.clone(), after.clone()));
        *saved = after;
        new_level = l;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    if new_level != level {
        super::independence::set_level(new_level, store::now_ms()).map_err(|e| e.to_string())?;
        policy::sync();
    }
    apply_grants(&p.grants)?;
    Ok(changed)
}

fn finish(app: &AppHandle, agent_id: &str, updated: Option<store::AgentMessage>) {
    if let Some(m) = updated {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(agent_id);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    let _ = app.emit(super::policy_card::EVENT, ());
    super::notify::refresh_badge(app);
}

/// Fired when any policy changes.
pub const EVENT: &str = "agents://policy";

/// Who is told about an applied change, and the line each gets: one note in
/// the Chief's chat for anything team-wide, and a quiet line for each agent
/// whose *own* settings changed (named on the card, or an own setting the
/// change reset). A team rule or a team default is the Chief's note only:
/// once, a team change put the same "Settings changed: New rule…" in every
/// agent's chat in the same minute. `skip`: whose chat already shows it
/// (the proposer's card or note). Pure, for tests.
pub fn notes_for(
    before: &Saved,
    after: &Saved,
    groups: &[Group],
    agents: &[Agent],
    skip: Option<&str>,
    prefix: &str,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut team_wide = groups.iter().any(|g| g.agent_ids.is_empty());
    for g in groups {
        for id in &g.agent_ids {
            if before.agents.get(id) == after.agents.get(id) {
                // Changed only through the team's defaults.
                team_wide = true;
                continue;
            }
            if Some(id.as_str()) == skip || out.iter().any(|(x, _)| x == id) {
                continue;
            }
            out.push((id.clone(), format!("{prefix}{}", g.changes.join(" · "))));
        }
    }
    if team_wide {
        if let Some(chief) = agents.iter().find(|a| a.is_main) {
            if Some(chief.id.as_str()) != skip {
                let line = format!("{prefix}{}", summary(groups).replace('\n', " "));
                out.retain(|(id, _)| *id != chief.id);
                out.insert(0, (chief.id.clone(), line));
            }
        }
    }
    out
}

/// A quiet line in each agent's chat whose app access changed (the
/// proposer's chat has the card or note already).
fn note_grants(app: &AppHandle, proposer: &str, p: &Proposal) {
    let by = store::get(proposer).ok().map(|a| AgentRef {
        id: a.id.clone(),
        name: a.name.clone(),
    });
    let mut done: Vec<&str> = Vec::new();
    for g in &p.grants {
        if g.agent_id == proposer || done.contains(&g.agent_id.as_str()) {
            continue;
        }
        done.push(&g.agent_id);
        let lines: Vec<&str> = p
            .grants
            .iter()
            .filter(|x| x.agent_id == g.agent_id)
            .map(|x| x.line.as_str())
            .collect();
        let mut line = runner::new_message(
            &g.agent_id,
            MessageKind::Note,
            format!("Settings changed: {}", lines.join(" · ")),
        );
        line.peer = by.clone();
        let _ = runner::record(app, line);
    }
}

/// The notes for a change a card applied (the proposer's chat has the card).
fn note_targets(app: &AppHandle, proposer: &str, p: &Proposal, applied: Option<&(Saved, Saved)>) {
    let Some((before, after)) = applied else {
        return;
    };
    let by = store::get(proposer).ok().map(|a| AgentRef {
        id: a.id.clone(),
        name: a.name.clone(),
    });
    let agents = store::list().unwrap_or_default();
    // App lines are told by `note_grants`, once.
    let groups: Vec<Group> = p
        .groups
        .iter()
        .map(|g| Group {
            changes: g
                .changes
                .iter()
                .filter(|c| !p.grants.iter().any(|x| x.line == **c))
                .cloned()
                .collect(),
            ..g.clone()
        })
        .filter(|g| !g.changes.is_empty())
        .collect();
    for (id, text) in notes_for(
        before,
        after,
        &groups,
        &agents,
        Some(proposer),
        "Settings changed: ",
    ) {
        let mut line = runner::new_message(&id, MessageKind::Note, text);
        line.peer = by.clone();
        let _ = runner::record(app, line);
    }
}

#[cfg(test)]
#[path = "agent_level_tests.rs"]
mod agent_level_tests;

#[cfg(test)]
#[path = "settings_chat_tests.rs"]
mod settings_chat_tests;
