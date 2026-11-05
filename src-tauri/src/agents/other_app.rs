//! A one-time, read-only import of the team someone ran in the app this one
//! grew out of ([`OTHER_APP_NAME`]), when it is installed on this Mac.
//!
//! Both apps keep agents in the same layout (`store`), so this is a copy, not
//! a translation: each agent's registry entry, its home (CLAUDE.md with its
//! instructions and memory, `messages.jsonl`, `approvals.jsonl`,
//! `attachments/` and anything else it kept there) comes across as it was.
//! The other app's Chief of Staff merges into ours by the same rules as
//! `import.rs`: ours keeps its name, role, avatar and engine; theirs brings
//! its instructions (under `### From <app>`), its memory (under
//! `### Imported from <app>`), its conversation (merged in time order), its
//! files, its routines and its "Always allow" rules.
//!
//! **Read-only.** Nothing of the other app's is written, moved or deleted:
//! its folder is only ever read (`read_dir`, `read_to_string`, `fs::copy`
//! from it). The tests hash the whole source tree before and after.
//!
//! What doesn't come across, on purpose:
//! - **Saved secrets.** Their values are in the other app's Keychain items
//!   (`ship-studio-agent-<id>`). Reading those would raise a Keychain prompt
//!   per item, owned by the other app, and copy credentials the user never
//!   chose to give this one. They're named in the preview and in the agent's
//!   chat; the agent asks again (`request_secret`) when it next needs one.
//! - **Sessions.** A Claude Code session is tied to the folder it ran in, and
//!   a Codex thread would be shared by both apps. Imported agents start a new
//!   one and get the recent conversation handed over (`new_engine`).
//! - **A turn in flight** (`turn.json`, `inbox.json`): it belongs to the
//!   other app's process.
//! - **Waiting approval cards** are expired: what asked is in the other app.
//!   A secure input card stays open, since saving it here works.
//!
//! Routines arrive **paused**, so a routine doesn't run in both apps while
//! both are open. Idempotent: a ledger (`agents/imports.json`) records each
//! source id it brought over, so importing again skips them.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::store::{self, Agent, ApprovalStatus};
use crate::errors::CommandError;

/// The other app, by name. The one compat source for it in the UI: the
/// frontend mirrors it as `OTHER_APP_NAME` in `src/lib/agents.ts`. Its data
/// locations are [`source_roots`].
pub const OTHER_APP_NAME: &str = "Ship Studio";
/// The ledger key prefix for agents brought over from it.
const LEDGER_SOURCE: &str = "ship-studio";
const LEDGER_FILE: &str = "imports.json";

/// Files in a home that belong to a turn the other app has in flight.
const IN_FLIGHT: &[&str] = &["turn.json", "inbox.json"];
const LOG: &str = "messages.jsonl";
const ANSWERS: &str = "approvals.jsonl";
const CLAUDE_MD: &str = "CLAUDE.md";

/* ------------------------------------------------------------- finding */

/// Where the other app keeps its agents: under its projects folder (its own
/// `app_state.json` says which; read, never written), else the default one.
pub fn source_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = crate::utils::ship_studio_projects_root() {
        roots.push(root.join(".shipstudio").join("agents"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("ShipStudio").join(".shipstudio").join("agents"));
    }
    let ours = store::agents_root().ok();
    roots.dedup();
    roots.retain(|r| Some(r) != ours.as_ref());
    roots
}

/// The first of [`source_roots`] that has a registry.
pub fn find_source() -> Option<PathBuf> {
    source_roots()
        .into_iter()
        .find(|r| r.join("agents.json").is_file())
}

/// One entry of the other app's registry: an agent this build can read, or
/// one it can't (a newer build's), kept so it can be reported.
enum Entry {
    Agent(Box<Agent>),
    Unreadable { name: String, why: String },
}

fn read_source(root: &Path) -> Result<Vec<Entry>, CommandError> {
    let raw = std::fs::read_to_string(root.join("agents.json")).map_err(super::err_io)?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| {
        super::err_other(format!(
            "{OTHER_APP_NAME}'s agents list isn't readable: {e}"
        ))
    })?;
    let entries = value
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(entries
        .into_iter()
        .map(|e| match serde_json::from_value::<Agent>(e.clone()) {
            Ok(agent) => Entry::Agent(Box::new(agent)),
            Err(err) => Entry::Unreadable {
                name: e
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("An agent")
                    .to_string(),
                why: format!(
                    "a newer {OTHER_APP_NAME} saved it in a way this build can't read ({err})."
                ),
            },
        })
        .collect())
}

/// A source id as a path segment: only ids our store would accept.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/* -------------------------------------------------------------- ledger */

fn ledger_key(source_id: &str) -> String {
    format!("{LEDGER_SOURCE}:{source_id}")
}

fn read_ledger() -> serde_json::Map<String, Value> {
    store::agents_root()
        .ok()
        .and_then(|r| std::fs::read_to_string(r.join(LEDGER_FILE)).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("imported").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

/// The agent here a source id became, if it's still here.
fn already_imported(ledger: &serde_json::Map<String, Value>, source_id: &str) -> Option<Agent> {
    let ours = ledger
        .get(&ledger_key(source_id))?
        .get("agentId")?
        .as_str()?;
    store::get(ours).ok()
}

fn record(source_id: &str, agent_id: &str) -> Result<(), CommandError> {
    let mut ledger = read_ledger();
    ledger.insert(
        ledger_key(source_id),
        serde_json::json!({ "agentId": agent_id, "importedAt": store::now_ms() }),
    );
    let json = serde_json::to_vec_pretty(&serde_json::json!({ "imported": ledger }))
        .map_err(super::err_other)?;
    store::write_beside(LEDGER_FILE, &json)
}

/* ------------------------------------------------------------- preview */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Plan {
    /// Comes across as a new agent.
    New,
    /// The other app's Chief of Staff: merges into ours.
    Merge,
    /// Brought over by an earlier import; skipped.
    Imported,
    /// Can't come across; `reason` says why.
    Skip,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRoutine {
    /// "every weekday at 09:00", in this app's words.
    pub schedule: String,
    pub what: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAgent {
    pub source_id: String,
    pub name: String,
    pub role: String,
    pub color: String,
    pub is_main: bool,
    pub plan: Plan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub instructions: String,
    /// Its memory entries, as the Memory tab lists them.
    pub memory: Vec<String>,
    /// Lines of conversation that come across.
    pub messages: usize,
    pub attachments: usize,
    pub routines: Vec<PreviewRoutine>,
    /// Names of the secrets it had saved there, which don't come across.
    pub secrets: Vec<String>,
    /// The project it works in, when that folder is still on this Mac.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// It was bound to a project folder that isn't there any more.
    pub project_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub app_name: String,
    /// The folder it reads from, for the record ("found in …").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub agents: Vec<PreviewAgent>,
}

fn count_lines(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|raw| raw.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

fn count_files(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => count_files(&e.path()),
            Ok(t) if t.is_file() => 1,
            _ => 0,
        })
        .sum()
}

fn project_of(agent: &Agent) -> (Option<String>, bool) {
    match &agent.project {
        Some(p) if Path::new(p).is_dir() => (Some(p.clone()), false),
        Some(_) => (None, true),
        None => (None, false),
    }
}

/// What importing from `root` would do, agent by agent.
pub fn preview_from(root: &Path) -> Result<Preview, CommandError> {
    let ledger = read_ledger();
    let here = store::list()?;
    let tz = chrono::Local;
    let mut agents = Vec::new();
    for entry in read_source(root)? {
        let agent = match entry {
            Entry::Agent(a) => *a,
            Entry::Unreadable { name, why } => {
                agents.push(PreviewAgent {
                    source_id: String::new(),
                    name,
                    role: String::new(),
                    color: "gray".into(),
                    is_main: false,
                    plan: Plan::Skip,
                    reason: Some(format!("It can't come across: {why}")),
                    instructions: String::new(),
                    memory: Vec::new(),
                    messages: 0,
                    attachments: 0,
                    routines: Vec::new(),
                    secrets: Vec::new(),
                    project: None,
                    project_missing: false,
                });
                continue;
            }
        };
        let home = root.join(&agent.id);
        let claude_md = if safe_id(&agent.id) {
            std::fs::read_to_string(home.join(CLAUDE_MD)).unwrap_or_default()
        } else {
            String::new()
        };
        let (plan, reason) = plan_for(&agent, &ledger, &here);
        let (project, project_missing) = project_of(&agent);
        let safe = safe_id(&agent.id);
        agents.push(PreviewAgent {
            source_id: agent.id.clone(),
            name: agent.name.clone(),
            role: agent.role.clone(),
            color: store::color_for(Some(&agent.color), 0),
            is_main: agent.is_main,
            plan,
            reason,
            instructions: store::instructions_of(&claude_md),
            memory: super::memory::entries(&claude_md)
                .into_iter()
                .map(|e| e.text)
                .collect(),
            messages: if safe {
                count_lines(&home.join(LOG))
            } else {
                0
            },
            attachments: if safe {
                count_files(&home.join("attachments"))
            } else {
                0
            },
            routines: agent
                .check_ins
                .iter()
                .map(|c| PreviewRoutine {
                    schedule: super::schedule::describe_schedule(&tz, c.repeat.as_ref(), c.next_at),
                    what: c.note.clone(),
                })
                .collect(),
            secrets: agent.secrets.iter().map(|s| s.name.clone()).collect(),
            project,
            project_missing,
        });
    }
    // The Chief first, as the sidebar has it.
    agents.sort_by_key(|a| !a.is_main);
    Ok(Preview {
        app_name: OTHER_APP_NAME.to_string(),
        source: Some(root.display().to_string()),
        agents,
    })
}

fn plan_for(
    agent: &Agent,
    ledger: &serde_json::Map<String, Value>,
    here: &[Agent],
) -> (Plan, Option<String>) {
    if !safe_id(&agent.id) {
        return (
            Plan::Skip,
            Some("Its folder name isn't one this app can use.".into()),
        );
    }
    if already_imported(ledger, &agent.id).is_some() || here.iter().any(|a| a.id == agent.id) {
        return (Plan::Imported, Some("Already brought over.".into()));
    }
    if agent.is_main {
        return (Plan::Merge, None);
    }
    if store::validate_name(&agent.name).is_err() {
        return (
            Plan::Skip,
            Some("Its name isn't one this app accepts.".into()),
        );
    }
    if here
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(agent.name.trim()))
    {
        return (
            Plan::Skip,
            Some(format!(
                "You already have an agent called {} here. Rename one, then import again.",
                agent.name.trim()
            )),
        );
    }
    (Plan::New, None)
}

/// The preview from wherever the other app's agents are; `None` when it has none.
pub fn preview() -> Result<Option<Preview>, CommandError> {
    match find_source() {
        Some(root) => {
            let preview = preview_from(&root)?;
            Ok((!preview.agents.is_empty()).then_some(preview))
        }
        None => Ok(None),
    }
}

/* -------------------------------------------------------------- import */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsLeft {
    pub agent: String,
    pub secrets: Vec<String>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// The same shape the other import paths report, so the done state is shared.
    #[serde(flatten)]
    pub base: super::import::ImportSummary,
    pub app_name: String,
    /// Brought over by an earlier import, so left alone.
    pub already: Vec<String>,
    /// Routines that came across, paused.
    pub routines_paused: usize,
    pub messages: usize,
    /// Secrets each agent had there, which it will ask for again.
    pub secrets_left: Vec<SecretsLeft>,
    /// Files in the other Chief's folder not copied because ours has one by that name.
    pub files_skipped: Vec<String>,
}

/// Copy `src` into `dst`, reading `src` only. Symlinks are never followed or
/// copied; a file `dst` already has is left as it is and reported.
fn copy_tree(
    src: &Path,
    dst: &Path,
    skip_top: &[&str],
    skipped: &mut Vec<String>,
    rel: &Path,
) -> Result<(), CommandError> {
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(super::err_io(e)),
    };
    std::fs::create_dir_all(dst).map_err(super::err_io)?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if rel.as_os_str().is_empty() && skip_top.contains(&name_str.as_ref()) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let to = dst.join(&name);
        let rel = rel.join(&name);
        if meta.is_dir() {
            copy_tree(&entry.path(), &to, skip_top, skipped, &rel)?;
        } else if meta.is_file() {
            if to.exists() {
                skipped.push(rel.display().to_string());
                continue;
            }
            std::fs::copy(entry.path(), &to).map_err(super::err_io)?;
        }
    }
    Ok(())
}

/// A log line as it should read here: the other Chief's id becomes ours
/// wherever it's named, and the line belongs to `owner`. A line that isn't
/// JSON is kept exactly as it was (the store skips it on read, as before).
fn rewrite_line(line: &str, owner: &str, from_chief: &str, to_chief: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        return line.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return line.to_string();
    };
    obj.insert("agentId".into(), Value::String(owner.to_string()));
    let swap = |v: &mut Value| {
        if v.get("id").and_then(Value::as_str) == Some(from_chief) {
            v["id"] = Value::String(to_chief.to_string());
        }
    };
    if let Some(peer) = obj.get_mut("peer") {
        swap(peer);
    }
    if let Some(Value::Array(mentions)) = obj.get_mut("mentions") {
        mentions.iter_mut().for_each(swap);
    }
    serde_json::to_string(&value).unwrap_or_else(|_| line.to_string())
}

fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|raw| {
            raw.lines()
                .filter(|l| !l.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Request ids of the cards in these lines that were pending when written.
fn card_ids(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            v.get("approval")?
                .get("requestId")?
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

/// Expire the cards that came across still waiting, except secure input
/// cards: what asked is in the other app, but saving a secret here works.
fn expire_cards(agent_id: &str, from: &[String]) {
    if let Ok(pending) = store::pending_approvals(agent_id) {
        for card in pending
            .into_iter()
            .filter(|c| c.secret.is_none() && from.contains(&c.request_id))
        {
            let _ = store::set_approval_status(agent_id, &card.request_id, ApprovalStatus::Expired);
        }
    }
    store::refresh_pending(agent_id);
}

fn paused(mut check_ins: Vec<super::schedule::CheckIn>) -> Vec<super::schedule::CheckIn> {
    for c in &mut check_ins {
        c.paused = true;
        c.retry = None;
    }
    check_ins
}

/// The quiet line left in an imported agent's chat: what came across and
/// what it has to do about what didn't.
fn note_text(routines: usize, secrets: &[String], project_missing: bool) -> String {
    let mut text = format!("Brought over from {OTHER_APP_NAME}.");
    if routines > 0 {
        text.push_str(&format!(
            " {} paused here so nothing runs twice; turn {} on when you're ready.",
            if routines == 1 {
                "Its routine is".to_string()
            } else {
                format!("Its {routines} routines are")
            },
            if routines == 1 { "it" } else { "them" }
        ));
    }
    if !secrets.is_empty() {
        text.push_str(&format!(
            " Saved secrets stay in {OTHER_APP_NAME} ({}); it will ask for them again when it needs them.",
            secrets.join(", ")
        ));
    }
    if project_missing {
        text.push_str(
            " The project it worked in isn't on this Mac any more, so it works in its own folder.",
        );
    }
    text
}

fn leave_note(agent_id: &str, text: String) -> Result<(), CommandError> {
    let message: store::AgentMessage = serde_json::from_value(serde_json::json!({
        "id": store::new_id(),
        "agentId": agent_id,
        "ts": store::now_ms(),
        "kind": "note",
        "text": text,
    }))
    .map_err(super::err_other)?;
    store::append_message(&message)
}

/// The agent as it lives here: the same identity and settings, nothing that
/// belonged to the other app's running process or Keychain.
fn adopt(mut agent: Agent) -> Agent {
    let (project, _) = project_of(&agent);
    agent.name = agent.name.trim().to_string();
    agent.color = store::color_for(Some(&agent.color), 0);
    if agent.shape >= store::SHAPE_COUNT {
        agent.shape %= store::SHAPE_COUNT;
    }
    agent.is_main = false;
    agent.session_id = None;
    // It starts a fresh session here and is handed the recent conversation.
    agent.new_engine = true;
    agent.unread = 0;
    agent.pending_approvals = 0;
    agent.failure = None;
    agent.capabilities = None;
    agent.secrets = Vec::new();
    agent.project = project;
    agent.check_ins = paused(std::mem::take(&mut agent.check_ins));
    agent
}

fn import_agent(
    root: &Path,
    source: Agent,
    from_chief: &str,
    to_chief: &str,
    summary: &mut Summary,
) -> Result<(), CommandError> {
    let src_home = root.join(&source.id);
    let ours = store::agents_root()?;
    let dest = ours.join(&source.id);
    if dest.exists() {
        summary.base.skipped.push((
            source.name.clone(),
            "A folder for it is already here from an earlier attempt.".into(),
        ));
        return Ok(());
    }
    let secrets: Vec<String> = source.secrets.iter().map(|s| s.name.clone()).collect();
    let (_, project_missing) = project_of(&source);
    let agent = adopt(source.clone());
    let routines = agent.check_ins.len();

    // Assemble the home aside, then move it into place in one step.
    let staging = ours.join(format!(".import-{}", store::new_id()));
    let staged = (|| -> Result<Vec<String>, CommandError> {
        let mut ignored = Vec::new();
        let mut skip = IN_FLIGHT.to_vec();
        skip.push(LOG);
        copy_tree(&src_home, &staging, &skip, &mut ignored, Path::new(""))?;
        let lines: Vec<String> = read_lines(&src_home.join(LOG))
            .iter()
            .map(|l| rewrite_line(l, &agent.id, from_chief, to_chief))
            .collect();
        let mut log = lines.join("\n");
        if !log.is_empty() {
            log.push('\n');
        }
        std::fs::write(staging.join(LOG), log).map_err(super::err_io)?;
        Ok(lines)
    })();
    let lines = match staged {
        Ok(lines) => lines,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    std::fs::rename(&staging, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        super::err_io(e)
    })?;
    if let Err(e) = store::insert_imported(agent.clone()) {
        let _ = std::fs::remove_dir_all(&dest);
        summary
            .base
            .skipped
            .push((agent.name.clone(), e.to_string()));
        return Ok(());
    }
    expire_cards(&agent.id, &card_ids(&lines));
    leave_note(&agent.id, note_text(routines, &secrets, project_missing))?;
    record(&source.id, &agent.id)?;
    summary.messages += lines.len();
    summary.routines_paused += routines;
    if !secrets.is_empty() {
        summary.secrets_left.push(SecretsLeft {
            agent: agent.name.clone(),
            secrets,
        });
    }
    summary.base.created.push(agent.name);
    Ok(())
}

fn merge_chief(root: &Path, source: Agent, summary: &mut Summary) -> Result<(), CommandError> {
    let chief = super::ensure_main()?;
    let src_home = root.join(&source.id);
    let raw = std::fs::read_to_string(src_home.join(CLAUDE_MD)).unwrap_or_default();

    // Instructions: only what the user wrote. The Chief's own defaults are
    // ours already, and something already merged isn't merged twice.
    let theirs = store::instructions_of(&raw);
    let base = store::read_instructions(&chief.id).unwrap_or_default();
    if !theirs.is_empty()
        && theirs.trim() != super::prompts::CHIEF_INSTRUCTIONS.trim()
        && !base.contains(theirs.trim())
    {
        let merged = format!("{base}\n\n### From {OTHER_APP_NAME}\n\n{}", theirs.trim());
        store::write_instructions(&store::agent_home(&chief.id)?, &chief, &merged)?;
    }

    // Memory: its whole section as written, headings and all, minus the preamble.
    if let Some(start) = super::memory::section_start(&raw) {
        let section =
            raw[start + super::memory::HEADING.len()..].replacen(super::memory::INTRO, "", 1);
        super::import::add_memory(&chief.id, section.trim(), OTHER_APP_NAME)?;
    }

    // Conversation and files.
    let lines: Vec<String> = read_lines(&src_home.join(LOG))
        .iter()
        .map(|l| rewrite_line(l, &chief.id, &source.id, &chief.id))
        .collect();
    let answers = read_lines(&src_home.join(ANSWERS));
    store::merge_log_lines(&chief.id, lines.clone(), answers)?;
    let mut skip = IN_FLIGHT.to_vec();
    skip.extend([LOG, ANSWERS, CLAUDE_MD]);
    copy_tree(
        &src_home,
        &store::agent_home(&chief.id)?,
        &skip,
        &mut summary.files_skipped,
        Path::new(""),
    )?;

    // Routines (paused) and "Always allow" rules, without doubling any.
    let incoming = paused(source.check_ins.clone());
    let mut added = 0;
    store::update(&chief.id, |a| {
        for c in incoming {
            let dup = a
                .check_ins
                .iter()
                .any(|e| e.note == c.note && e.repeat == c.repeat || e.id == c.id);
            if !dup {
                a.check_ins.push(c);
                added += 1;
            }
        }
        for rule in &source.permissions {
            if !a.permissions.iter().any(|r| r.scope == rule.scope) {
                a.permissions.push(rule.clone());
            }
        }
    })?;

    let secrets: Vec<String> = source.secrets.iter().map(|s| s.name.clone()).collect();
    expire_cards(&chief.id, &card_ids(&lines));
    leave_note(&chief.id, note_text(added, &secrets, false))?;
    record(&source.id, &chief.id)?;
    summary.messages += lines.len();
    summary.routines_paused += added;
    if !secrets.is_empty() {
        summary.secrets_left.push(SecretsLeft {
            agent: chief.name.clone(),
            secrets,
        });
    }
    summary.base.updated.push(chief.name);
    Ok(())
}

/// Bring over everything [`preview_from`] says can come across. Never writes
/// under `root`.
pub fn import_from(root: &Path) -> Result<Summary, CommandError> {
    let mut summary = Summary {
        app_name: OTHER_APP_NAME.to_string(),
        ..Summary::default()
    };
    let entries = read_source(root)?;
    let ledger = read_ledger();
    let here = store::list()?;
    let chief = super::ensure_main()?;
    let from_chief = entries
        .iter()
        .find_map(|e| match e {
            Entry::Agent(a) if a.is_main => Some(a.id.clone()),
            _ => None,
        })
        .unwrap_or_default();
    // The Chief first, so the others' lines can name ours.
    let mut agents = Vec::new();
    for entry in entries {
        match entry {
            Entry::Agent(a) => agents.push(*a),
            Entry::Unreadable { name, why } => summary.base.skipped.push((name, why)),
        }
    }
    agents.sort_by_key(|a| !a.is_main);
    for agent in agents {
        let (plan, reason) = plan_for(&agent, &ledger, &here);
        match plan {
            Plan::Merge => merge_chief(root, agent, &mut summary)?,
            Plan::New => import_agent(root, agent, &from_chief, &chief.id, &mut summary)?,
            Plan::Imported => summary.already.push(agent.name),
            Plan::Skip => summary
                .base
                .skipped
                .push((agent.name, reason.unwrap_or_default())),
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;

    /// Every file under `dir`, by relative path, with its content's hash.
    fn snapshot(dir: &Path) -> BTreeMap<String, String> {
        fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                let rel = p.strip_prefix(base).unwrap().display().to_string();
                if p.is_dir() {
                    out.insert(format!("{rel}/"), String::new());
                    walk(base, &p, out);
                } else {
                    let hash = Sha256::digest(std::fs::read(&p).unwrap());
                    out.insert(rel, format!("{hash:x}"));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, dir, &mut out);
        out
    }

    fn line(id: &str, agent: &str, ts: i64, kind: &str, text: &str, extra: Value) -> String {
        let mut v =
            serde_json::json!({"id": id, "agentId": agent, "ts": ts, "kind": kind, "text": text});
        if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
            o.extend(e);
        }
        serde_json::to_string(&v).unwrap()
    }

    /// A fake copy of the other app's agents folder: its Chief, Finance (with
    /// a routine, a secret, an attachment, a pending card, a turn in flight),
    /// Travel (same name as one already here), and an entry from a newer build.
    fn fake_source(root: &Path) {
        let ss_chief = "c0ffee00000000000000000000000001";
        let finance = "f1a4ce00000000000000000000000002";
        let travel = "77a7e100000000000000000000000003";
        let registry = serde_json::json!({ "agents": [
            { "id": ss_chief, "name": "Chief of Staff", "role": "Runs the team", "shape": 5,
              "color": "white", "isMain": true, "pinned": true, "createdAt": 1,
              "sessionId": "ss-session-chief",
              "checkIns": [{ "id": "ci-chief", "note": "Morning brief.",
                "repeat": { "kind": "days", "days": [0, 1, 2, 3, 4, 5, 6], "hour": 7, "minute": 30 }, "nextAt": 4_000_000_000_000i64,
                "createdAt": 1 }],
              "permissions": [{ "id": "p1", "kind": "command", "value": "npm test", "label": "npm test",
                "createdAt": 1 }] },
            { "id": finance, "name": "Finance", "role": "Handles money", "shape": 3,
              "color": "green", "createdAt": 2, "engine": "codex", "model": "gpt-5",
              "sessionId": "ss-session-fin", "unread": 4, "pendingApprovals": 1,
              "project": root.display().to_string(),
              "checkIns": [{ "id": "ci-fin", "note": "Check invoices.",
                "repeat": { "kind": "every", "minutes": 120 }, "nextAt": 4_000_000_000_000i64,
                "createdAt": 2 }],
              "secrets": [{ "id": "s1", "name": "Stripe key", "purpose": "Charges",
                "kind": "api_key", "fields": [{ "label": "Key", "env": "STRIPE_KEY" }],
                "reference": "secret:finance/stripe_key", "createdAt": 3 }],
              "futureField": { "kept": true } },
            { "id": travel, "name": "Travel", "shape": 1, "color": "blue", "createdAt": 3 },
            { "id": "badbad", "name": "Newer", "shape": "not-a-number", "color": "red", "createdAt": 4 }
        ]});
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join("agents.json"), registry.to_string()).unwrap();

        let chief_home = root.join(ss_chief);
        std::fs::create_dir_all(chief_home.join("attachments/m-chief")).unwrap();
        std::fs::write(
            chief_home.join("CLAUDE.md"),
            format!(
                "# Chief of Staff\n\nRuns the team\n\n## Instructions\n\nAlways answer in French.\n\n## Memory\n\n{}\n\n- Lives in Lisbon\n- Has two cats\n",
                super::super::memory::INTRO
            ),
        )
        .unwrap();
        std::fs::write(
            chief_home.join("messages.jsonl"),
            [
                line(
                    "m-chief",
                    ss_chief,
                    100,
                    "user",
                    "Hi chief",
                    serde_json::json!({}),
                ),
                line(
                    "m-chief-2",
                    ss_chief,
                    300,
                    "sent_to_agent",
                    "Do the books",
                    serde_json::json!({"peer": {"id": finance, "name": "Finance"}}),
                ),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        std::fs::write(chief_home.join("attachments/m-chief/photo.png"), b"png").unwrap();
        std::fs::write(chief_home.join("notes.md"), "chief notes").unwrap();

        let fin = root.join(finance);
        std::fs::create_dir_all(fin.join("attachments/m1")).unwrap();
        std::fs::write(
            fin.join("CLAUDE.md"),
            "# Finance\n\nHandles money\n\n## Instructions\n\nLog every expense.\n\n## Memory\n\n- Accountant is Sam\n",
        )
        .unwrap();
        std::fs::write(
            fin.join("messages.jsonl"),
            [
                line(
                    "m1",
                    finance,
                    200,
                    "from_agent",
                    "Do the books",
                    serde_json::json!({"peer": {"id": ss_chief, "name": "Chief of Staff"}}),
                ),
                line(
                    "m2",
                    finance,
                    250,
                    "approval",
                    "",
                    serde_json::json!({"approval": {
                    "requestId": "r1", "title": "Run a command", "detail": "rm -rf build",
                    "status": "pending", "tool": "Bash", "input": {"command": "rm -rf build"}}}),
                ),
                line(
                    "m3",
                    finance,
                    260,
                    "approval",
                    "",
                    serde_json::json!({"approval": {
                    "requestId": "r2", "title": "Bank login", "detail": "", "status": "pending",
                    "secret": {"name": "Bank", "purpose": "Statements", "kind": "password",
                        "fields": [{"label": "Password", "env": "BANK_PASSWORD"}],
                        "reference": "secret:finance/bank"}}}),
                ),
                "not json at all".to_string(),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        std::fs::write(fin.join("attachments/m1/receipt.pdf"), b"%PDF").unwrap();
        std::fs::write(fin.join("turn.json"), "{}").unwrap();
        std::fs::write(fin.join("inbox.json"), "[]").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", fin.join("linked")).unwrap();

        let tr = root.join(travel);
        std::fs::create_dir_all(&tr).unwrap();
        std::fs::write(tr.join("CLAUDE.md"), "# Travel\n").unwrap();
    }

    const FINANCE: &str = "f1a4ce00000000000000000000000002";

    #[test]
    fn imports_a_team_without_touching_the_source_and_only_once() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other/.shipstudio/agents");
        fake_source(&source);
        store::set_root_for_tests(Some(dir.path().join("ours")));
        // Travel already exists here, made by hand.
        store::create(store::NewAgent {
            name: "travel".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let before = snapshot(&source);

        // The preview says what will happen, agent by agent, without writing.
        let preview = preview_from(&source).unwrap();
        let plans: Vec<(&str, Plan)> = preview
            .agents
            .iter()
            .map(|a| (a.name.as_str(), a.plan))
            .collect();
        assert_eq!(
            plans,
            [
                ("Chief of Staff", Plan::Merge),
                ("Finance", Plan::New),
                ("Travel", Plan::Skip),
                ("Newer", Plan::Skip),
            ]
        );
        let fin = &preview.agents[1];
        assert_eq!(fin.messages, 4);
        assert_eq!(fin.attachments, 1);
        assert_eq!(fin.secrets, ["Stripe key"]);
        assert_eq!(fin.memory, ["Accountant is Sam"]);
        assert_eq!(fin.instructions, "Log every expense.");
        assert_eq!(fin.routines[0].schedule, "every 2 hours");
        assert_eq!(snapshot(&source), before);

        let summary = import_from(&source).unwrap();
        assert_eq!(summary.base.created, ["Finance"]);
        assert_eq!(summary.base.updated, ["Chief of Staff"]);
        assert_eq!(summary.base.skipped.len(), 2, "{:?}", summary.base.skipped);
        assert_eq!(summary.routines_paused, 2);
        assert_eq!(summary.secrets_left[0].secrets, ["Stripe key"]);

        // Finance: same id, settings and history; nothing of the other app's process.
        let agent = store::get(FINANCE).unwrap();
        assert_eq!(agent.name, "Finance");
        assert_eq!(agent.color, "green");
        assert_eq!(agent.shape, 3);
        assert_eq!(agent.model.as_deref(), Some("gpt-5"));
        assert_eq!(agent.project.as_deref(), Some(source.to_str().unwrap()));
        assert_eq!(agent.session_id, None);
        assert!(agent.new_engine);
        assert_eq!(agent.unread, 0);
        assert!(agent.secrets.is_empty());
        assert!(agent.check_ins[0].paused);
        assert!(agent.extra.contains_key("futureField"));
        let home = store::agent_home(FINANCE).unwrap();
        assert!(home.join("attachments/m1/receipt.pdf").is_file());
        assert!(!home.join("turn.json").exists());
        assert!(!home.join("inbox.json").exists());
        assert!(!home.join("linked").exists());
        let md = std::fs::read_to_string(home.join("CLAUDE.md")).unwrap();
        assert!(md.contains("Accountant is Sam"));

        let log = store::messages(FINANCE, 100).unwrap();
        let chief = super::super::ensure_main().unwrap();
        assert_eq!(
            log[0].peer.as_ref().unwrap().id,
            chief.id,
            "the Chief is ours now"
        );
        let card = |id: &str| {
            log.iter()
                .find_map(|m| m.approval.as_ref().filter(|a| a.request_id == id))
                .unwrap()
                .status
        };
        assert_eq!(card("r1"), ApprovalStatus::Expired);
        assert_eq!(
            card("r2"),
            ApprovalStatus::Pending,
            "a secret card can still be saved here"
        );
        assert_eq!(store::get(FINANCE).unwrap().pending_approvals, 1);
        let note = log.last().unwrap();
        assert_eq!(note.kind, store::MessageKind::Note);
        assert!(note.text.contains("Stripe key"), "{}", note.text);
        assert!(note.text.contains("paused"), "{}", note.text);

        // The Chief merged: ours keeps its name, gains their words, memory, chat, files.
        let instructions = store::read_instructions(&chief.id).unwrap();
        assert!(instructions.contains(&format!("### From {OTHER_APP_NAME}")));
        assert!(instructions.contains("Always answer in French."));
        let memory = super::super::memory::read(&chief.id).unwrap();
        assert!(memory.entries.iter().any(|e| e.text == "Lives in Lisbon"
            && e.group.as_deref() == Some(&format!("Imported from {OTHER_APP_NAME}"))));
        assert!(!memory
            .entries
            .iter()
            .any(|e| e.text.contains(super::super::memory::INTRO) && e.group.is_some()));
        let chief_log = store::messages(&chief.id, 100).unwrap();
        assert!(chief_log
            .iter()
            .any(|m| m.id == "m-chief" && m.agent_id == chief.id));
        let chief_home = store::agent_home(&chief.id).unwrap();
        assert!(chief_home.join("attachments/m-chief/photo.png").is_file());
        assert!(chief_home.join("notes.md").is_file());
        let chief = store::get(&chief.id).unwrap();
        assert_eq!(chief.name, "Chief of Staff");
        assert_eq!(chief.check_ins.len(), 1);
        assert!(chief.check_ins[0].paused);
        assert_eq!(chief.permissions.len(), 1);

        // Nothing of the source changed.
        assert_eq!(snapshot(&source), before);

        // Again: nothing doubles.
        let agents_before = store::list().unwrap().len();
        let chief_lines = store::messages(&chief.id, 1000).unwrap().len();
        let again = import_from(&source).unwrap();
        assert!(again.base.created.is_empty() && again.base.updated.is_empty());
        assert_eq!(again.already.len(), 2, "{:?}", again.already);
        assert_eq!(store::list().unwrap().len(), agents_before);
        assert_eq!(store::messages(&chief.id, 1000).unwrap().len(), chief_lines);
        let instructions = store::read_instructions(&chief.id).unwrap();
        assert_eq!(instructions.matches("Always answer in French.").count(), 1);
        let preview = preview_from(&source).unwrap();
        assert!(preview.agents[..2].iter().all(|a| a.plan == Plan::Imported));
        assert_eq!(snapshot(&source), before);

        store::set_root_for_tests(None);
    }

    #[test]
    fn a_merged_conversation_reads_in_time_order() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let chief = super::super::ensure_main().unwrap();
        for (id, ts) in [("ours-1", 150), ("ours-2", 400)] {
            let m: store::AgentMessage =
                serde_json::from_str(&line(id, &chief.id, ts, "user", id, serde_json::json!({})))
                    .unwrap();
            store::append_message(&m).unwrap();
        }
        let theirs = vec![
            line(
                "theirs-1",
                &chief.id,
                100,
                "user",
                "a",
                serde_json::json!({}),
            ),
            line(
                "theirs-2",
                &chief.id,
                300,
                "agent",
                "b",
                serde_json::json!({}),
            ),
        ];
        store::merge_log_lines(&chief.id, theirs, Vec::new()).unwrap();
        let ids: Vec<String> = store::messages(&chief.id, 10)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["theirs-1", "ours-1", "theirs-2", "ours-2"]);
        store::set_root_for_tests(None);
    }

    #[test]
    fn nothing_to_import_when_the_other_app_has_no_registry() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_source(dir.path()).is_err());
        assert!(!source_roots().is_empty() || dirs::home_dir().is_none());
    }
}
