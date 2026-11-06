//! A one-time, read-only import of the team someone ran in the app this one
//! grew out of ([`OTHER_APP_NAME`]), when it is installed on this Mac.
//!
//! Both apps keep agents in the same layout (`store`), so this is a copy, not
//! a translation: each agent's registry entry, its home (CLAUDE.md with its
//! instructions and memory, `messages.jsonl`, `approvals.jsonl`,
//! `attachments/` and anything else it kept there) comes across as it was.
//! The other app's Chief of Staff merges into ours by the same rules as
//! `import.rs`: ours keeps its name, role, avatar, engine and session; theirs
//! brings its instructions (under `### From <app>`), its memory (under
//! `### Imported from <app>`), its conversation (as one block before ours,
//! under a "From <app>" divider), its files and its routines. Since our
//! Chief keeps its own session, the other Chief's conversation would be
//! display-only, so a recap of its recent part is written beside it
//! (`history-from-<app>.md`) and named in its memory.
//!
//! **Read-only.** Nothing of the other app's is written, moved or deleted:
//! its folder is only ever read (`read_dir`, `read_to_string`, `fs::copy`
//! from it). Symlinks, an agent's home itself included, are never followed.
//! The tests hash the whole source tree before and after.
//!
//! What doesn't come across, on purpose:
//! - **Saved secrets.** Their values are in the other app's Keychain items
//!   (`ship-studio-agent-<id>`). Reading those would raise a Keychain prompt
//!   per item, owned by the other app, and copy credentials the user never
//!   chose to give this one. They're named in the preview and in the agent's
//!   chat; the agent asks again (`request_secret`) when it next needs one.
//! - **"Always allow" rules**, unless the user asks to keep them
//!   ([`Options::keep_rules`]): they are standing grants that act at once,
//!   so the preview lists them and the default is to leave them behind.
//! - **Sessions.** A Claude Code session is tied to the folder it ran in, and
//!   a Codex thread would be shared by both apps. Imported agents start a new
//!   one and get the recent conversation handed over (`new_engine`).
//! - **A turn in flight** (`turn.json`, `inbox.json`): it belongs to the
//!   other app's process.
//! - **Waiting approval cards** are expired: what asked is in the other app.
//!   A secure input card stays open, since saving it here works.
//!
//! Routines arrive **paused** (`paused_on_import`), so a routine doesn't run
//! in both apps while both are open.
//!
//! **Safe to run again, and to retry after a failure.** A ledger
//! (`agents/imports.json`) records each source id it brought over, so
//! importing again skips them; every step of the Chief's merge skips what is
//! already there (lines by id, memory by block, files by name, routines and
//! rules by value), so a merge that failed part way can simply be run again.
//! A folder left by a crash between moving a home into place and registering
//! it, or a staging folder (`.import-*`) left mid-copy, is ours: it is
//! removed and the agent brought over again. One import runs at a time.
//! One agent failing doesn't stop the others; it is reported by name.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::store::{self, Agent, ApprovalStatus};
use crate::errors::CommandError;

/// The other app, by name: the one compat source for it. The UI reads it
/// from the preview (`appName`); the frontend's own copy, `OTHER_APP_NAME` in
/// `src/lib/agents.ts`, is only for the palette title before any preview.
/// Its data locations are [`source_roots`].
pub const OTHER_APP_NAME: &str = "Ship Studio";
/// The ledger key prefix for agents brought over from it.
const LEDGER_SOURCE: &str = "ship-studio";
const LEDGER_FILE: &str = "imports.json";
/// Staging folders an import assembles a home in, under our agents root.
const STAGING_PREFIX: &str = ".import-";

/// Files in a home that belong to a turn the other app has in flight.
const IN_FLIGHT: &[&str] = &["turn.json", "inbox.json"];
const LOG: &str = "messages.jsonl";
const ANSWERS: &str = "approvals.jsonl";
const CLAUDE_MD: &str = "CLAUDE.md";
/// The kinds of log line that are conversation, as the preview counts them.
const CHAT_KINDS: &[&str] = &["user", "agent", "sent_to_agent", "from_agent", "check_in"];
/// Headroom asked for on top of what a copy to another volume needs.
const SPACE_MARGIN: u64 = 64 * 1024 * 1024;

/// One import at a time: two windows importing at once would each merge the
/// other app's Chief before either recorded it.
static IMPORTING: Mutex<()> = Mutex::new(());

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

/// Whether the other app has any agents here, by reading its registry only:
/// what the palette asks at launch, instead of the whole preview (which
/// reads every agent's CLAUDE.md and log and walks every attachments tree).
pub fn available() -> bool {
    find_source().is_some_and(|root| has_agents(&root))
}

fn has_agents(root: &Path) -> bool {
    std::fs::read_to_string(root.join("agents.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            v.get("agents")
                .and_then(Value::as_array)
                .map(|a| !a.is_empty())
        })
        .unwrap_or(false)
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

/// An agent's home in the other app, unless it is a symlink: `read_dir`
/// follows one, and the copy promises never to.
fn source_home(root: &Path, id: &str) -> Option<PathBuf> {
    if !safe_id(id) {
        return None;
    }
    let home = root.join(id);
    match std::fs::symlink_metadata(&home) {
        Ok(meta) if meta.file_type().is_symlink() => None,
        _ => Some(home),
    }
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

/* ------------------------------------------------------------- volumes */

/// Bytes free for an unprivileged writer on the volume holding `path`.
#[cfg(unix)]
fn free_space(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `stat` a valid out-pointer.
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(not(unix))]
fn free_space(_path: &Path) -> Option<u64> {
    None
}

/// Whether two folders are on the same volume. On APFS a copy within one
/// volume is a clone (`fs::copy` uses `clonefile`), so it costs neither time
/// nor space; across volumes it is a full copy.
#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => true,
    }
}

#[cfg(not(unix))]
fn same_volume(_a: &Path, _b: &Path) -> bool {
    false
}

/// Bytes of the regular files under `dir`, as the copy would copy them
/// (symlinks not followed, a turn in flight left out).
fn tree_size(dir: &Path, top: bool) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| !(top && IN_FLIGHT.contains(&e.file_name().to_string_lossy().as_ref())))
        .map(|e| match std::fs::symlink_metadata(e.path()) {
            Ok(m) if m.is_dir() => tree_size(&e.path(), false),
            Ok(m) if m.is_file() => m.len(),
            _ => 0,
        })
        .sum()
}

/* ------------------------------------------------------------- preview */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Plan {
    /// Comes across as a new agent.
    New,
    /// The other app's Chief of Staff: merges into ours.
    Merge,
    /// Brought over by an earlier import (or an agent with its id is here); skipped.
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
    /// Messages of conversation that come across (not cards or notes).
    pub messages: usize,
    pub attachments: usize,
    /// Bytes its folder takes, which a copy to another volume has to write.
    pub bytes: u64,
    pub routines: Vec<PreviewRoutine>,
    /// Names of the secrets it had saved there, which don't come across.
    pub secrets: Vec<String>,
    /// Its "Always allow" rules, in words ("npm test"): left behind unless
    /// the user keeps them.
    pub rules: Vec<String>,
    /// The project it works in, when that folder is still on this Mac. Its
    /// copy in the other app keeps working in the same folder.
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
    /// What an import would copy, in bytes (the agents that come across).
    pub total_bytes: u64,
    /// Same volume as ours: the copy is a clone, instant and free of space.
    pub same_volume: bool,
    /// Free space where ours are, when it could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<u64>,
    /// False only when a copy to another volume wouldn't fit.
    pub enough_space: bool,
}

/// Conversation lines in a log: messages people said, not cards or notes.
fn count_chat(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|raw| {
            raw.lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .filter(|v| {
                    v.get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|k| CHAT_KINDS.contains(&k))
                })
                .count()
        })
        .unwrap_or(0)
}

fn count_files(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match std::fs::symlink_metadata(e.path()) {
            Ok(m) if m.is_dir() => count_files(&e.path()),
            Ok(m) if m.is_file() => 1,
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

fn rule_labels(agent: &Agent) -> Vec<String> {
    agent
        .permissions
        .iter()
        .map(|r| r.scope.label.clone())
        .collect()
}

fn needs_space(bytes: u64, free: Option<u64>, same: bool) -> bool {
    same || free.is_none_or(|free| free >= bytes.saturating_add(SPACE_MARGIN))
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
                    bytes: 0,
                    routines: Vec::new(),
                    secrets: Vec::new(),
                    rules: Vec::new(),
                    project: None,
                    project_missing: false,
                });
                continue;
            }
        };
        let home = source_home(root, &agent.id);
        let claude_md = home
            .as_ref()
            .and_then(|h| std::fs::read_to_string(h.join(CLAUDE_MD)).ok())
            .unwrap_or_default();
        let (plan, reason) = plan_for(&agent, &ledger, &here);
        let (project, project_missing) = project_of(&agent);
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
            messages: home.as_ref().map_or(0, |h| count_chat(&h.join(LOG))),
            attachments: home
                .as_ref()
                .map_or(0, |h| count_files(&h.join("attachments"))),
            bytes: home.as_ref().map_or(0, |h| tree_size(h, true)),
            routines: agent
                .check_ins
                .iter()
                .map(|c| PreviewRoutine {
                    schedule: super::schedule::describe_schedule(&tz, c.repeat.as_ref(), c.next_at),
                    what: c.note.clone(),
                })
                .collect(),
            secrets: agent.secrets.iter().map(|s| s.name.clone()).collect(),
            rules: rule_labels(&agent),
            project,
            project_missing,
        });
    }
    // The Chief first, as the sidebar has it.
    agents.sort_by_key(|a| !a.is_main);
    let total_bytes = agents
        .iter()
        .filter(|a| matches!(a.plan, Plan::New | Plan::Merge))
        .map(|a| a.bytes)
        .sum();
    let ours = store::agents_root()?;
    let same = same_volume(root, &ours);
    let free_bytes = free_space(&ours);
    Ok(Preview {
        app_name: OTHER_APP_NAME.to_string(),
        source: Some(root.display().to_string()),
        agents,
        total_bytes,
        same_volume: same,
        free_bytes,
        enough_space: needs_space(total_bytes, free_bytes, same),
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
    if already_imported(ledger, &agent.id).is_some() {
        return (Plan::Imported, Some("Already brought over.".into()));
    }
    if here.iter().any(|a| a.id == agent.id) {
        return (
            Plan::Imported,
            Some("An agent with the same id is already here, so it's left as it is.".into()),
        );
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

/// What the user chose before importing.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Carry each agent's "Always allow" rules over. Off by default: they
    /// pre-approve tool calls from the moment they land.
    #[serde(default)]
    pub keep_rules: bool,
}

/// How far a copy has got, for a progress bar on a slow (cross-volume) copy.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub agent: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsLeft {
    pub agent: String,
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesNote {
    pub agent: String,
    pub rules: Vec<String>,
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
    /// Messages of conversation that came across.
    pub messages: usize,
    /// Secrets each agent had there, which it will ask for again.
    pub secrets_left: Vec<SecretsLeft>,
    /// "Always allow" rules carried over (the user chose to keep them).
    pub rules_kept: Vec<RulesNote>,
    /// "Always allow" rules left behind (the default).
    pub rules_left: Vec<RulesNote>,
    /// Files in the other Chief's folder not copied because ours has one by that name.
    pub files_skipped: Vec<String>,
}

impl Summary {
    fn note_rules(&mut self, agent: &str, rules: Vec<String>, kept: bool) {
        if rules.is_empty() {
            return;
        }
        let note = RulesNote {
            agent: agent.to_string(),
            rules,
        };
        if kept {
            self.rules_kept.push(note);
        } else {
            self.rules_left.push(note);
        }
    }
}

/// Bytes copied so far, reported as each file lands.
struct Copied<'a> {
    agent: String,
    done: u64,
    total: u64,
    report: &'a mut dyn FnMut(&Progress),
}

impl Copied<'_> {
    fn add(&mut self, bytes: u64) {
        self.done = self.done.saturating_add(bytes);
        (self.report)(&Progress {
            agent: self.agent.clone(),
            done_bytes: self.done.min(self.total),
            total_bytes: self.total,
        });
    }
}

/// Copy `src` into `dst`, reading `src` only. Symlinks are never followed or
/// copied; a file `dst` already has is left as it is and reported.
fn copy_tree(
    src: &Path,
    dst: &Path,
    skip_top: &[&str],
    skipped: &mut Vec<String>,
    rel: &Path,
    copied: &mut Copied<'_>,
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
            copy_tree(&entry.path(), &to, skip_top, skipped, &rel, copied)?;
        } else if meta.is_file() {
            if to.exists() {
                skipped.push(rel.display().to_string());
                continue;
            }
            std::fs::copy(entry.path(), &to).map_err(super::err_io)?;
            copied.add(meta.len());
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

fn chat_count(lines: &[String]) -> usize {
    lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| {
            v.get("kind")
                .and_then(Value::as_str)
                .is_some_and(|k| CHAT_KINDS.contains(&k))
        })
        .count()
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
        if !c.paused {
            c.paused_on_import = true;
        }
        c.paused = true;
        c.retry = None;
    }
    check_ins
}

fn routines_line(routines: usize) -> String {
    if routines == 0 {
        return String::new();
    }
    format!(
        " {} paused by the import so nothing runs twice; turn {} on when you're ready.",
        if routines == 1 {
            "Its routine is".to_string()
        } else {
            format!("Its {routines} routines are")
        },
        if routines == 1 { "it" } else { "them" }
    )
}

fn secrets_line(secrets: &[String]) -> String {
    if secrets.is_empty() {
        return String::new();
    }
    format!(
        " Saved secrets stay in {OTHER_APP_NAME} ({}); it will ask for them again when it needs them.",
        secrets.join(", ")
    )
}

/// The quiet line left in an imported agent's chat: what came across and
/// what it has to do about what didn't.
fn note_text(routines: usize, secrets: &[String], project_missing: bool) -> String {
    let mut text = format!("Brought over from {OTHER_APP_NAME}.");
    text.push_str(&routines_line(routines));
    text.push_str(&secrets_line(secrets));
    if project_missing {
        text.push_str(
            " The project it worked in isn't on this Mac any more, so it works in its own folder.",
        );
    }
    text
}

/// The line left in our Chief's chat after a merge: it wasn't brought over,
/// it was given the other Chief's work.
fn merge_note_text(messages: usize, routines: usize, secrets: &[String]) -> String {
    let mut text = format!("Merged in {OTHER_APP_NAME}'s Chief of Staff: its instructions, memory");
    if messages > 0 {
        text.push_str(&format!(
            " and {} (above, under “From {OTHER_APP_NAME}”)",
            if messages == 1 {
                "1 message".to_string()
            } else {
                format!("{messages} messages")
            }
        ));
    }
    text.push('.');
    text.push_str(&routines_line(routines).replace("Its", "Their"));
    text.push_str(&secrets_line(secrets));
    text
}

fn note(agent_id: &str, id: Option<String>, ts: i64, text: String) -> Result<String, CommandError> {
    let value = serde_json::json!({
        "id": id.unwrap_or_else(store::new_id),
        "agentId": agent_id,
        "ts": ts,
        "kind": "note",
        "text": text,
    });
    serde_json::to_string(&value).map_err(super::err_other)
}

fn leave_note(agent_id: &str, text: String) -> Result<(), CommandError> {
    let line = note(agent_id, None, store::now_ms(), text)?;
    let message: store::AgentMessage = serde_json::from_str(&line).map_err(super::err_other)?;
    store::append_message(&message)
}

/// The other Chief's recent conversation, for ours to read: our Chief keeps
/// its own session, so without this the merged history would be only on
/// screen. Same window as a fresh session's recap (`runner::with_recap`).
fn history_recap(lines: &[String]) -> Option<String> {
    let chat: Vec<Value> = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| {
            v.get("kind")
                .and_then(Value::as_str)
                .is_some_and(|k| CHAT_KINDS.contains(&k))
        })
        .collect();
    if chat.is_empty() {
        return None;
    }
    let peer = |v: &Value| {
        v.get("peer")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("another agent")
            .to_string()
    };
    let recent: Vec<String> = chat
        .iter()
        .skip(chat.len().saturating_sub(24))
        .map(|v| {
            let who = match v.get("kind").and_then(Value::as_str).unwrap_or("") {
                "user" => "User".to_string(),
                "agent" => "You".to_string(),
                "sent_to_agent" => format!("You → {}", peer(v)),
                "from_agent" => format!("{} → you", peer(v)),
                _ => "Your scheduled check-in".to_string(),
            };
            let text: String = v
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(400)
                .collect();
            format!("- {who}: {}", text.replace('\n', " "))
        })
        .collect();
    let day = |v: &Value| {
        v.get("ts")
            .and_then(Value::as_i64)
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|t| {
                t.with_timezone(&chrono::Local)
                    .format("%-d %b %Y")
                    .to_string()
            })
    };
    let span = match (chat.first().and_then(day), chat.last().and_then(day)) {
        (Some(a), Some(b)) if a != b => format!(", {a} to {b}"),
        (Some(a), _) => format!(", {a}"),
        _ => String::new(),
    };
    Some(format!(
        "# Your conversation as {OTHER_APP_NAME}'s Chief of Staff\n\n{} messages{span}. It was merged into your chat here. The most recent part:\n\n{}\n",
        chat.len(),
        recent.join("\n")
    ))
}

fn history_file() -> String {
    format!("history-from-{LEDGER_SOURCE}.md")
}

/// The agent as it lives here: the same identity and settings, nothing that
/// belonged to the other app's running process or Keychain.
fn adopt(mut agent: Agent, keep_rules: bool) -> Agent {
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
    if !keep_rules {
        agent.permissions = Vec::new();
    }
    agent.project = project;
    agent.check_ins = paused(std::mem::take(&mut agent.check_ins));
    agent
}

/// Remove what an earlier import left mid-copy: staging folders it was
/// assembling a home in. Called with [`IMPORTING`] held, so none is live.
fn sweep_staging(ours: &Path) {
    let Ok(entries) = std::fs::read_dir(ours) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_PREFIX)
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

struct Ctx<'a> {
    root: &'a Path,
    from_chief: String,
    to_chief: String,
    options: Options,
    report: &'a mut dyn FnMut(&Progress),
}

fn import_agent(
    ctx: &mut Ctx<'_>,
    source: Agent,
    summary: &mut Summary,
) -> Result<(), CommandError> {
    let Some(src_home) = source_home(ctx.root, &source.id) else {
        summary.base.skipped.push((
            source.name.clone(),
            "Its folder is a link to somewhere else, so it isn't copied.".into(),
        ));
        return Ok(());
    };
    let ours = store::agents_root()?;
    let dest = ours.join(&source.id);
    // The plan said New, so this id is in neither our registry nor the
    // ledger: a folder here is our own, left by a crash between moving it
    // into place and registering it. Start that agent again.
    if dest.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dest) {
            summary.base.skipped.push((
                source.name.clone(),
                format!("A folder an earlier attempt left for it couldn't be cleared ({e})."),
            ));
            return Ok(());
        }
    }
    let secrets: Vec<String> = source.secrets.iter().map(|s| s.name.clone()).collect();
    let rules = rule_labels(&source);
    let (_, project_missing) = project_of(&source);
    let agent = adopt(source.clone(), ctx.options.keep_rules);
    let routines = agent.check_ins.len();
    let mut copied = Copied {
        agent: agent.name.clone(),
        done: 0,
        total: tree_size(&src_home, true),
        report: &mut *ctx.report,
    };

    // Assemble the home aside, then move it into place in one step.
    let staging = ours.join(format!("{STAGING_PREFIX}{}", store::new_id()));
    let staged = (|| -> Result<Vec<String>, CommandError> {
        let mut ignored = Vec::new();
        let mut skip = IN_FLIGHT.to_vec();
        skip.push(LOG);
        copy_tree(
            &src_home,
            &staging,
            &skip,
            &mut ignored,
            Path::new(""),
            &mut copied,
        )?;
        let lines: Vec<String> = read_lines(&src_home.join(LOG))
            .iter()
            .map(|l| rewrite_line(l, &agent.id, &ctx.from_chief, &ctx.to_chief))
            .collect();
        let mut log = lines.join("\n");
        if !log.is_empty() {
            log.push('\n');
        }
        std::fs::write(staging.join(LOG), &log).map_err(super::err_io)?;
        copied.add(log.len() as u64);
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
    summary.messages += chat_count(&lines);
    summary.routines_paused += routines;
    if !secrets.is_empty() {
        summary.secrets_left.push(SecretsLeft {
            agent: agent.name.clone(),
            secrets,
        });
    }
    summary.note_rules(&agent.name, rules, ctx.options.keep_rules);
    summary.base.created.push(agent.name);
    Ok(())
}

fn merge_chief(
    ctx: &mut Ctx<'_>,
    source: Agent,
    summary: &mut Summary,
) -> Result<(), CommandError> {
    let chief = super::ensure_main()?;
    let Some(src_home) = source_home(ctx.root, &source.id) else {
        summary.base.skipped.push((
            chief.name.clone(),
            "Its folder is a link to somewhere else, so it isn't copied.".into(),
        ));
        return Ok(());
    };
    let raw = std::fs::read_to_string(src_home.join(CLAUDE_MD)).unwrap_or_default();
    let chief_home = store::agent_home(&chief.id)?;

    // Instructions: only what the user wrote. The Chief's own defaults are
    // ours already, and something already merged isn't merged twice.
    let theirs = store::instructions_of(&raw);
    let base = store::read_instructions(&chief.id).unwrap_or_default();
    if !theirs.is_empty() && !super::is_chief_default(&theirs) && !base.contains(theirs.trim()) {
        let merged = format!("{base}\n\n### From {OTHER_APP_NAME}\n\n{}", theirs.trim());
        store::write_instructions(&chief_home, &chief, &merged)?;
    }

    // Conversation: one block before ours, under a divider, ids deduped.
    let lines: Vec<String> = read_lines(&src_home.join(LOG))
        .iter()
        .map(|l| rewrite_line(l, &chief.id, &source.id, &chief.id))
        .collect();
    let first_ts = lines
        .iter()
        .find_map(|l| serde_json::from_str::<Value>(l).ok()?.get("ts")?.as_i64())
        .unwrap_or(0);
    let divider = note(
        &chief.id,
        Some(format!("import-divider-{}", source.id)),
        first_ts,
        format!("From {OTHER_APP_NAME}: its Chief of Staff's conversation"),
    )?;
    let answers = read_lines(&src_home.join(ANSWERS));
    let added = store::prepend_log_block(&chief.id, Some(divider), lines.clone(), answers)?;

    // Memory: its whole section as written, headings and all, minus the
    // preamble, plus where the recap of its conversation is (`add_memory`
    // skips a block that is already there).
    let mut memory = super::memory::section_start(&raw)
        .map(|start| {
            raw[start + super::memory::HEADING.len()..]
                .replacen(super::memory::INTRO, "", 1)
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    if let Some(recap) = history_recap(&lines) {
        std::fs::write(chief_home.join(history_file()), recap).map_err(super::err_io)?;
        if !memory.is_empty() {
            memory.push_str("\n\n");
        }
        memory.push_str(&format!(
            "- My conversation as {OTHER_APP_NAME}'s Chief of Staff is in my chat (under “From {OTHER_APP_NAME}”), and its most recent part is in {} in my folder: read it when the user refers to something from before.",
            history_file()
        ));
    }
    super::import::add_memory(&chief.id, &memory, OTHER_APP_NAME)?;

    // Files.
    let mut skip = IN_FLIGHT.to_vec();
    skip.extend([LOG, ANSWERS, CLAUDE_MD]);
    let mut copied = Copied {
        agent: chief.name.clone(),
        done: 0,
        total: tree_size(&src_home, true),
        report: &mut *ctx.report,
    };
    copy_tree(
        &src_home,
        &chief_home,
        &skip,
        &mut summary.files_skipped,
        Path::new(""),
        &mut copied,
    )?;

    // Routines (paused) and, if the user kept them, "Always allow" rules,
    // without doubling any.
    let incoming = paused(source.check_ins.clone());
    let keep_rules = ctx.options.keep_rules;
    let mut routines = 0;
    store::update(&chief.id, |a| {
        for c in incoming {
            let dup = a
                .check_ins
                .iter()
                .any(|e| e.note == c.note && e.repeat == c.repeat || e.id == c.id);
            if !dup {
                a.check_ins.push(c);
                routines += 1;
            }
        }
        if keep_rules {
            for rule in &source.permissions {
                if !a.permissions.iter().any(|r| r.scope == rule.scope) {
                    a.permissions.push(rule.clone());
                }
            }
        }
    })?;

    let secrets: Vec<String> = source.secrets.iter().map(|s| s.name.clone()).collect();
    expire_cards(&chief.id, &card_ids(&lines));
    // Once, even when a merge that failed part way is run again.
    let note_id = format!("import-note-{}", source.id);
    let logged = std::fs::read_to_string(chief_home.join(LOG)).unwrap_or_default();
    if !logged.contains(&format!("\"{note_id}\"")) {
        let line = note(
            &chief.id,
            Some(note_id),
            store::now_ms(),
            merge_note_text(chat_count(&lines), routines, &secrets),
        )?;
        let message: store::AgentMessage = serde_json::from_str(&line).map_err(super::err_other)?;
        store::append_message(&message)?;
    }
    record(&source.id, &chief.id)?;
    if added > 0 {
        summary.messages += chat_count(&lines);
    }
    summary.routines_paused += routines;
    if !secrets.is_empty() {
        summary.secrets_left.push(SecretsLeft {
            agent: chief.name.clone(),
            secrets,
        });
    }
    summary.note_rules(&chief.name, rule_labels(&source), keep_rules);
    summary.base.updated.push(chief.name);
    Ok(())
}

/// Bring over everything [`preview_from`] says can come across. Never writes
/// under `root`. One agent failing is reported by name and the rest carry
/// on; only what stops the whole import (no registry, no room) is an error.
pub fn import_from(
    root: &Path,
    options: Options,
    report: &mut dyn FnMut(&Progress),
) -> Result<Summary, CommandError> {
    let _one_at_a_time = IMPORTING.lock().unwrap_or_else(|e| e.into_inner());
    let mut summary = Summary {
        app_name: OTHER_APP_NAME.to_string(),
        ..Summary::default()
    };
    let ours = store::agents_root()?;
    sweep_staging(&ours);
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
    let plans: Vec<(Agent, Plan, Option<String>)> = agents
        .into_iter()
        .map(|a| {
            let (plan, reason) = plan_for(&a, &ledger, &here);
            (a, plan, reason)
        })
        .collect();

    // Across volumes the copy is real: refuse up front rather than fill the disk.
    if !same_volume(root, &ours) {
        let needed: u64 = plans
            .iter()
            .filter(|(_, p, _)| matches!(p, Plan::New | Plan::Merge))
            .filter_map(|(a, _, _)| source_home(root, &a.id))
            .map(|h| tree_size(&h, true))
            .sum();
        if let Some(free) = free_space(&ours) {
            if !needs_space(needed, Some(free), false) {
                return Err(CommandError::expected(format!(
                    "There isn't room to bring your {OTHER_APP_NAME} team over: it needs {} and this Mac has {} free. Free up some space, then try again.",
                    human_bytes(needed.saturating_add(SPACE_MARGIN)),
                    human_bytes(free)
                )));
            }
        }
    }

    let mut ctx = Ctx {
        root,
        from_chief,
        to_chief: chief.id.clone(),
        options,
        report,
    };
    for (agent, plan, reason) in plans {
        let name = agent.name.clone();
        let outcome = match plan {
            Plan::Merge => merge_chief(&mut ctx, agent, &mut summary),
            Plan::New => import_agent(&mut ctx, agent, &mut summary),
            Plan::Imported => {
                summary.already.push(name.clone());
                Ok(())
            }
            Plan::Skip => {
                summary
                    .base
                    .skipped
                    .push((name.clone(), reason.unwrap_or_default()));
                Ok(())
            }
        };
        if let Err(e) = outcome {
            let who = if plan == Plan::Merge {
                chief.name.clone()
            } else {
                name
            };
            summary.base.skipped.push((
                who,
                format!("It didn't come across: {e}. Importing again picks up where this stopped."),
            ));
        }
    }
    if !summary.base.created.is_empty() || !summary.base.updated.is_empty() {
        super::import_choice::record_import(super::store::now_ms());
    }
    Ok(summary)
}

/// "1.2 GB", "340 MB", "12 KB".
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 10.0 || unit == 0 {
        format!("{:.0} {}", value.max(1.0), UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
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
        assert_eq!(
            fin.messages, 1,
            "only conversation: not cards or junk lines"
        );
        assert!(fin.bytes > 0);
        assert_eq!(preview.agents[0].rules, ["npm test"]);
        assert!(preview.same_volume && preview.enough_space);
        assert_eq!(fin.attachments, 1);
        assert_eq!(fin.secrets, ["Stripe key"]);
        assert_eq!(fin.memory, ["Accountant is Sam"]);
        assert_eq!(fin.instructions, "Log every expense.");
        assert_eq!(fin.routines[0].schedule, "every 2 hours");
        assert_eq!(snapshot(&source), before);

        let summary = import_from(&source, Options::default(), &mut |_| {}).unwrap();
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
        assert!(agent.check_ins[0].paused_on_import);
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
        assert!(note.text.contains("paused by the import"), "{}", note.text);

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
        assert!(
            chief.permissions.is_empty(),
            "\"Always allow\" rules stay behind unless kept"
        );
        assert_eq!(summary.rules_left[0].rules, ["npm test"]);
        assert!(summary.rules_kept.is_empty());
        // Our Chief keeps its own session, so it is told where the other
        // Chief's history is, and the chat says it was merged, not brought over.
        assert!(chief_home.join(history_file()).is_file());
        let recap = std::fs::read_to_string(chief_home.join(history_file())).unwrap();
        assert!(recap.contains("User: Hi chief"), "{recap}");
        assert!(super::super::memory::read(&chief.id)
            .unwrap()
            .entries
            .iter()
            .any(|e| e.text.contains(&history_file())));
        let merged_note = chief_log
            .iter()
            .rev()
            .find(|m| m.kind == store::MessageKind::Note)
            .unwrap();
        assert!(
            merged_note.text.starts_with("Merged in"),
            "{}",
            merged_note.text
        );
        assert_eq!(
            chief_log[0].kind,
            store::MessageKind::Note,
            "the divider leads the block"
        );
        assert!(chief_log[0]
            .text
            .starts_with(&format!("From {OTHER_APP_NAME}")));

        // Nothing of the source changed.
        assert_eq!(snapshot(&source), before);

        // Again: nothing doubles.
        let agents_before = store::list().unwrap().len();
        let chief_lines = store::messages(&chief.id, 1000).unwrap().len();
        let again = import_from(&source, Options::default(), &mut |_| {}).unwrap();
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

    const SS_CHIEF: &str = "c0ffee00000000000000000000000001";

    fn ours(dir: &Path) -> PathBuf {
        let root = dir.join("ours");
        store::set_root_for_tests(Some(root.clone()));
        root
    }

    #[test]
    fn the_other_chiefs_conversation_is_one_block_before_ours_and_never_doubles() {
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
        let divider = note(&chief.id, Some("div".into()), 100, "From there".into()).unwrap();
        let answer = r#"{"requestId":"r1","status":"allowed"}"#.to_string();
        let added = store::prepend_log_block(
            &chief.id,
            Some(divider.clone()),
            theirs.clone(),
            vec![answer.clone()],
        )
        .unwrap();
        assert_eq!(added, 2);
        let ids = || -> Vec<String> {
            store::messages(&chief.id, 50)
                .unwrap()
                .into_iter()
                .map(|m| m.id)
                .filter(|id| id != "greeting" && !id.is_empty())
                .collect()
        };
        let first = ids();
        let at = |id: &str| first.iter().position(|i| i == id).unwrap();
        assert!(at("div") < at("theirs-1") && at("theirs-1") < at("theirs-2"));
        assert!(at("theirs-2") < at("ours-1"), "not interleaved: {first:?}");
        // Again (a retry after a failure): no line, divider or answer doubles.
        let added =
            store::prepend_log_block(&chief.id, Some(divider), theirs, vec![answer]).unwrap();
        assert_eq!(added, 0);
        assert_eq!(ids(), first);
        let answers =
            std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join(ANSWERS)).unwrap();
        assert_eq!(answers.lines().count(), 1);
        store::set_root_for_tests(None);
    }

    #[test]
    fn a_chief_merge_that_failed_part_way_can_be_run_again_without_doubling() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other/.shipstudio/agents");
        fake_source(&source);
        ours(dir.path());
        import_from(&source, Options::default(), &mut |_| {}).unwrap();
        let chief = super::super::ensure_main().unwrap();
        let lines = store::messages(&chief.id, 1000).unwrap().len();
        let memory = super::super::memory::read(&chief.id).unwrap().entries.len();
        // As if it had failed before recording: the ledger never heard of it.
        std::fs::remove_file(store::agents_root().unwrap().join(LEDGER_FILE)).unwrap();
        let again = import_from(&source, Options::default(), &mut |_| {}).unwrap();
        assert_eq!(again.base.updated, ["Chief of Staff"]);
        assert_eq!(store::messages(&chief.id, 1000).unwrap().len(), lines);
        assert_eq!(
            super::super::memory::read(&chief.id).unwrap().entries.len(),
            memory
        );
        let md = std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md"))
            .unwrap();
        assert_eq!(
            md.matches(&format!("### Imported from {OTHER_APP_NAME}"))
                .count(),
            1
        );
        store::set_root_for_tests(None);
    }

    #[test]
    fn a_folder_or_staging_left_by_a_crash_is_cleared_and_the_agent_comes_across() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other/.shipstudio/agents");
        fake_source(&source);
        let root = ours(dir.path());
        super::super::ensure_main().unwrap();
        // Moved into place, never registered; and a copy cut off mid-way.
        std::fs::create_dir_all(root.join(FINANCE)).unwrap();
        std::fs::write(root.join(FINANCE).join("half.txt"), "x").unwrap();
        std::fs::create_dir_all(root.join(".import-deadbeef/attachments")).unwrap();
        let preview = preview_from(&source).unwrap();
        assert_eq!(
            preview.agents[1].plan,
            Plan::New,
            "it isn't here, whatever's on disk"
        );
        let summary = import_from(&source, Options::default(), &mut |_| {}).unwrap();
        assert_eq!(
            summary.base.created,
            ["Finance", "Travel"],
            "{:?}",
            summary.base.skipped
        );
        assert!(!root.join(FINANCE).join("half.txt").exists());
        assert!(!root.join(".import-deadbeef").exists());
        assert!(store::get(FINANCE).is_ok());
        store::set_root_for_tests(None);
    }

    #[test]
    fn an_agent_with_the_same_id_here_is_named_as_that_not_as_imported() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other/.shipstudio/agents");
        fake_source(&source);
        ours(dir.path());
        let mut finance: Agent = serde_json::from_value(serde_json::json!({
            "id": FINANCE, "name": "Books", "shape": 1, "color": "green", "createdAt": 1
        }))
        .unwrap();
        finance.role = String::new();
        store::insert_imported(finance).unwrap();
        let preview = preview_from(&source).unwrap();
        let fin = preview
            .agents
            .iter()
            .find(|a| a.source_id == FINANCE)
            .unwrap();
        assert_eq!(fin.plan, Plan::Imported);
        assert!(
            fin.reason.as_deref().unwrap().contains("same id"),
            "{:?}",
            fin.reason
        );
        store::set_root_for_tests(None);
    }

    #[test]
    fn kept_rules_come_across_and_dropped_ones_are_reported() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other/.shipstudio/agents");
        fake_source(&source);
        ours(dir.path());
        let summary = import_from(&source, Options { keep_rules: true }, &mut |_| {}).unwrap();
        let chief = super::super::ensure_main().unwrap();
        assert_eq!(chief.permissions.len(), 1);
        assert_eq!(summary.rules_kept[0].agent, chief.name);
        assert!(summary.rules_left.is_empty());
        store::set_root_for_tests(None);
    }

    #[cfg(unix)]
    #[test]
    fn one_agent_failing_does_not_stop_the_others_and_a_linked_home_is_not_followed() {
        use std::os::unix::fs::PermissionsExt;
        // Root reads anything, so nothing could fail.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other/.shipstudio/agents");
        fake_source(&source);
        ours(dir.path());
        // Finance can't be read part way through its copy.
        let locked = source.join(FINANCE).join("attachments/m1");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Travel's home is a link to somewhere else.
        let travel = source.join("77a7e100000000000000000000000003");
        std::fs::remove_dir_all(&travel).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(
            elsewhere.join("CLAUDE.md"),
            "# Not yours\n\n## Instructions\n\nSecret.\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&elsewhere, &travel).unwrap();
        let mut seen = Vec::new();
        let summary = import_from(&source, Options::default(), &mut |p| seen.push(p.clone()));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let summary = summary.unwrap();
        assert_eq!(
            summary.base.updated,
            ["Chief of Staff"],
            "the Chief still merged"
        );
        assert!(
            summary
                .base
                .skipped
                .iter()
                .any(|(n, why)| n == "Finance" && why.contains("didn't come across")),
            "{:?}",
            summary.base.skipped
        );
        assert!(
            store::get(FINANCE).is_err(),
            "nothing half-made is registered"
        );
        assert!(!seen.is_empty(), "the copy reported progress");
        let preview = preview_from(&source).unwrap();
        let travel = preview.agents.iter().find(|a| a.name == "Travel").unwrap();
        assert!(travel.instructions.is_empty(), "a linked home isn't read");
        store::set_root_for_tests(None);
    }

    #[test]
    fn the_palette_check_reads_only_the_registry() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_agents(dir.path()));
        std::fs::write(dir.path().join("agents.json"), r#"{"agents": []}"#).unwrap();
        assert!(!has_agents(dir.path()));
        std::fs::write(
            dir.path().join("agents.json"),
            r#"{"agents": [{"id": "x"}]}"#,
        )
        .unwrap();
        assert!(has_agents(dir.path()));
    }

    #[test]
    fn space_and_sizes_read_plainly() {
        assert!(
            needs_space(10, None, false),
            "unknown free space doesn't block"
        );
        assert!(
            needs_space(u64::MAX, Some(0), true),
            "a clone needs no room"
        );
        assert!(!needs_space(1 << 30, Some(1 << 20), false));
        assert_eq!(human_bytes(500), "1 KB");
        assert_eq!(human_bytes(340 * 1024 * 1024), "340 MB");
        assert_eq!(human_bytes(1288490188), "1.2 GB");
    }

    #[test]
    fn notes_say_what_happened() {
        let merged = merge_note_text(214, 1, &["Stripe key".into()]);
        assert!(merged.starts_with(&format!("Merged in {OTHER_APP_NAME}'s Chief of Staff")));
        assert!(merged.contains("214 messages"));
        assert!(
            merged.contains("Their routine is paused by the import"),
            "{merged}"
        );
        assert!(!note_text(0, &[], false).contains("paused"));
        let _ = SS_CHIEF;
    }

    #[test]
    fn nothing_to_import_when_the_other_app_has_no_registry() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_source(dir.path()).is_err());
        assert!(!source_roots().is_empty() || dirs::home_dir().is_none());
    }
}
