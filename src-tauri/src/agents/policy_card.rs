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
//! - **Nothing that strands work.** A change that would leave an open copy's
//!   work or the project an agent is set to work in out of reach is refused
//!   up front, with the step to take first (`policy::blocker`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

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
}

/// This Mac's switches that chat can change through the same card.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacChange {
    /// "Fix stopped previews" (`agents_fix_previews`, `preview_fix`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_previews: Option<bool>,
}

/// The switches' plain words on the card.
const FIX_ON: &str = "Agents fix their own stopped previews without being asked";
const FIX_OFF: &str = "Agents no longer fix stopped previews on their own: the preview offers to ask them";

/// The card (or the line) for "Fix stopped previews", or why not. Only an
/// admin proposes it: it is the whole Mac's, not one agent's.
pub fn mac_proposal(
    admin: bool,
    fix_previews: bool,
    now_on: bool,
    why: Option<String>,
    version: u64,
) -> Result<Proposal, String> {
    if !admin {
        return Err("Only an admin (the Chief of Staff) can propose this Mac's settings. Ask it with message_agent.".into());
    }
    if fix_previews == now_on {
        return Err("That's already how it is: nothing would change.".into());
    }
    Ok(Proposal {
        targets: Vec::new(),
        change: Change::default(),
        version,
        groups: vec![Group {
            who: "This Mac".into(),
            agent_ids: Vec::new(),
            changes: vec![if fix_previews { FIX_ON } else { FIX_OFF }.to_string()],
        }],
        why: why
            .map(|w| w.trim().chars().take(200).collect())
            .filter(|w: &String| !w.is_empty()),
        has_rules: false,
        mac: Some(MacChange {
            fix_previews: Some(fix_previews),
        }),
    })
}

/// A Mac switch that only has agents do less on their own applies without a card.
pub fn mac_lowers(m: &MacChange) -> bool {
    m.fix_previews == Some(false)
}

fn fix_previews_on() -> bool {
    crate::commands::setup::read_app_state()
        .agents_fix_previews
        .unwrap_or(true)
}

fn apply_mac(m: &MacChange) -> Result<(), String> {
    if let Some(on) = m.fix_previews {
        crate::commands::settings::set_agents_fix_previews(on).map_err(|e| e.to_string())?;
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
                    "independence": { "type": "string", "enum": ["often", "judgement", "go_hard", "full_send", "team"], "description": "How much it does on its own, for the agents named (each may have its own; \"team\" puts one back on the team's level). Name the agent for one (\"put Social Posts on Full send\": agents [\"Social Posts\"]), \"team\" for everyone's default. full_send (\"Full send — let it rip\"): when the user says \"go full send\", \"let it rip\" or \"stop asking me\". Raising needs the user's card; lowering (\"make Finance check with me often\": often) applies at once." },
                    "admin": { "type": "boolean", "description": "Admins may propose changes for other agents." },
                    "fix_previews": { "type": "boolean", "description": "This Mac's \"Fix stopped previews\" switch, on its own (no agents): agents fix a preview that stopped by itself. Off applies at once." },
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

pub const DESCRIPTION: &str = "Propose a change to what an agent may do (projects and how it works in them, folders on this Mac, apps, the user's browser, independence, admin, rules), to the team's defaults, or to this Mac's “Fix stopped previews” switch. Use it whenever the user says an agent should or shouldn't be able to do something, or asks to reset settings or make one agent like another. The user gets a card showing the change in plain words and applies it with Allow; nothing changes before. It returns at once: say in one line what you proposed and stop; you're told when they answer. Never tell the user to go to Settings.";

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
    let has_rules = !change.add_rules.is_empty();
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
    if let Some(fix) = changes.get("fix_previews").and_then(Value::as_bool) {
        let others = changes
            .as_object()
            .is_some_and(|o| o.keys().any(|k| k != "fix_previews"));
        if others || !strings(args.get("agents")).is_empty() {
            return error("Propose this Mac's \"Fix stopped previews\" on its own, with no agents, then any agent's change.");
        }
        return match mac_proposal(
            policy::is_admin(caller),
            fix,
            fix_previews_on(),
            why,
            policy::load().version,
        ) {
            Ok(p) => offer(app, caller, p, &store::list().unwrap_or_default()),
            Err(e) => error(e),
        };
    }
    let change = match parse_change(args.get("changes").unwrap_or(&Value::Null)).await {
        Ok(c) => c,
        Err(e) => return error(e),
    };
    let targets = match parse_targets(caller, &strings(args.get("agents"))) {
        Ok(t) => t,
        Err(e) => return error(e),
    };
    let agents = store::list().unwrap_or_default();
    let proposal = match build(
        caller,
        policy::is_admin(caller),
        targets,
        change,
        why,
        &policy::load(),
        &agents,
        super::independence::level(),
    ) {
        Ok(p) => p,
        Err(e) => return error(e),
    };
    offer(app, caller, proposal, &agents)
}

/// Only stricter: applied now, with a line in the chat. Anything else: the card.
fn offer(app: &AppHandle, caller: &Agent, proposal: Proposal, agents: &[Agent]) -> Value {
    // A card is for giving agents more room, never for taking it away.
    let lowers = match &proposal.mac {
        Some(m) => mac_lowers(m),
        None => lowers_proposal(
            &proposal,
            &policy::load(),
            agents,
            super::independence::level(),
        ),
    };
    if lowers {
        return match apply_proposal(&proposal) {
            Ok(()) => {
                let lines = summary(&proposal.groups);
                let _ = runner::record(
                    app,
                    runner::new_message(
                        &caller.id,
                        MessageKind::Note,
                        format!("Settings changed: {}", lines.replace('\n', " ")),
                    ),
                );
                note_targets(app, &caller.id, &proposal);
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
    if before.team != after.team || new_level.rank() > level.rank() {
        return false;
    }
    let mut lowered = new_level.rank() < level.rank();
    for a in agents {
        let b = policy::resolve(before, a, level);
        let mut x = policy::resolve(after, a, new_level);
        if b == x {
            continue;
        }
        if x.independence.rank() > b.independence.rank() {
            return false;
        }
        lowered |= x.independence.rank() < b.independence.rank();
        x.independence = b.independence;
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
            runner::From::User,
        );
        return Ok(());
    }
    let applied = apply_proposal(p);
    match applied {
        Ok(()) => {
            let updated =
                store::set_approval_status(agent_id, request_id, ApprovalStatus::Allowed)?;
            finish(app, agent_id, updated);
            note_targets(app, agent_id, p);
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
                runner::From::User,
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
                runner::From::User,
            );
            Ok(())
        }
    }
}

/// Apply what a card showed, or say why it can't be any more.
pub fn apply_proposal(p: &Proposal) -> Result<(), String> {
    if let Some(m) = &p.mac {
        return apply_mac(m);
    }
    let level = super::independence::level();
    let agents = store::list().unwrap_or_default();
    let mut new_level = level;
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
        *saved = after;
        new_level = l;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    if new_level != level {
        super::independence::set_level(new_level, store::now_ms()).map_err(|e| e.to_string())?;
        policy::sync();
    }
    Ok(())
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

/// A quiet line in each changed agent's own chat (the proposer's has the card).
fn note_targets(app: &AppHandle, proposer: &str, p: &Proposal) {
    let by = store::get(proposer).ok().map(|a| AgentRef {
        id: a.id.clone(),
        name: a.name.clone(),
    });
    for g in &p.groups {
        for id in &g.agent_ids {
            if id == proposer {
                continue;
            }
            let mut line = runner::new_message(
                id,
                MessageKind::Note,
                format!("Settings changed: {}", g.changes.join(" · ")),
            );
            line.peer = by.clone();
            let _ = runner::record(app, line);
        }
    }
}

#[cfg(test)]
#[path = "agent_level_tests.rs"]
mod agent_level_tests;
