//! A living page per conversation (`page`): one page pinned above the chat
//! that the agent, and the routines that run in that conversation, keep up
//! to date. A job-search tracker, a project's status board, a reading list,
//! a running budget: long-running work gets one place to look instead of a
//! trail of point-in-time messages.
//!
//! - **Blocks, nothing new to draw.** A page's content is the blocks
//!   contract (`blocks.rs`, `packages/companion-protocol/src/blocks.ts`):
//!   facts, tables, checklists, steps, metrics, charts, links, callouts and
//!   code, each checked by `blocks::parse` exactly as `show` checks them, so
//!   the desk and the phone already draw it. Each block carries an `id` the
//!   agent picks, and an update sets or removes blocks by id. Nothing on a
//!   page answers: choices, comparisons and forms are `show`'s (a page is
//!   read, not replied to), and images are `share_result`'s.
//! - **Every version kept.** An update that changes something becomes the
//!   next version; the one before is kept with what changed (blocks added,
//!   changed, removed, a new title, the agent's one-line note), up to
//!   [`MAX_HISTORY`] versions. An update that changes nothing makes none.
//! - **Beside the chat log, never in it.** `<home>/pages/<conversation>.json`,
//!   one file per conversation. `messages.jsonl` is untouched; the step in
//!   "What it did" (`work.rs`) is the trace in the chat.
//! - **The user's to unpin.** A new page is pinned; the user can unpin it
//!   (desk or phone). Updates carry on and keep it unpinned: the user's
//!   choice stands until they pin it again.
//! - **Safety as for blocks, plus secrets.** Size caps, no HTML, http(s)
//!   links with no credentials (`blocks::parse`), and nothing that looks
//!   like a key, a token, a password or a stored secret anywhere on it
//!   (`connector::looks_like_secret`, `secrets::redact`). A turn answering
//!   outside text may update the page only through a card (`mcp::page`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;

use super::store;
use crate::errors::CommandError;

pub const TOOL: &str = "page";

/// Emitted with `{ agentId, conversation }` whenever a page changes (an
/// update or a pin), so the desk reads it again.
pub const EVENT: &str = "agents://page";

/// The file format. A newer one is left alone (read as no page).
pub const FORMAT: u32 = 1;
/// Most blocks on one page.
pub const MAX_BLOCKS: usize = 12;
/// The whole page, as stored (one version).
pub const MAX_BYTES: usize = 96_000;
/// Versions kept, newest last. Older ones are dropped, oldest first.
pub const MAX_HISTORY: usize = 30;
pub const MAX_TITLE: usize = 80;
pub const MAX_NOTE: usize = 200;
pub const MAX_ID: usize = 40;

/// Kinds a page can't hold, and why.
const NOT_ON_A_PAGE: &[(&str, &str)] = &[
    ("choices", "a page is read, not answered: ask with `show`"),
    (
        "comparison",
        "a page is read, not answered: ask with `show`",
    ),
    ("form", "a page is read, not answered: ask with `show`"),
    ("image", "images go in `show` or `share_result`"),
];

pub const DESCRIPTION: &str = "This conversation's living page: one page pinned above the chat that you keep up to date, for work that goes on (a job-search tracker, a project status board, a reading list, a running budget). Make one when the user asks to track something over time, or when what they're tracking is better kept current than re-posted; then update it whenever something on it changes, in this conversation and in its routines, instead of re-posting the whole thing. The content is blocks, exactly as `show` takes them (chart, table, metrics, facts, checklist, steps, links, callout, code; no choices, comparison, form or image), each with an `id` you choose (\"applications\", \"next-steps\"). An update sets the blocks you give by id (an existing id is replaced, a new one is added at the end) and removes the ids in `remove`; `replace: true` makes the blocks you give the whole page. A new page needs a `title`. `note` is one line on what changed (\"Moved Acme to interviewing\"): the user sees it in the page's history. Every version is kept, so update freely. Call it with nothing else to read the page as it is (its blocks and ids) before changing it. Plain text only: no HTML, no markdown in blocks, no passwords, keys or tokens. After an update, say in one line what changed, or nothing if the user didn't ask: the page shows it.";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "The page's title (needed for a new page; give it to rename)." },
            "blocks": {
                "type": "array",
                "description": "Blocks to set, each with `id` (lower-case letters, digits, - or _) and `kind` plus that kind's fields, as for `show`.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "kind": { "type": "string", "enum": ["chart", "table", "metrics", "facts", "checklist", "steps", "links", "callout", "code"] },
                        "title": { "type": "string" },
                        "summary": { "type": "string" }
                    },
                    "required": ["id", "kind"]
                }
            },
            "remove": { "type": "array", "items": { "type": "string" }, "description": "Ids of blocks to take off the page." },
            "replace": { "type": "boolean", "description": "true: the blocks given become the whole page, in that order." },
            "note": { "type": "string", "description": "One line on what changed, for the page's history." }
        }
    })
}

/* ------------------------------------------------------------ the types */

/// What changed from the version before.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retitled: bool,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.changed.is_empty()
            && self.removed.is_empty()
            && !self.retitled
    }
}

/// One version of the page, as kept.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: u32,
    /// When it was made, ms.
    pub at: i64,
    pub title: String,
    /// Blocks as `blocks::parse` filled them in, each with its `id`.
    pub items: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub changes: Changes,
    /// Made by a routine's turn, not one the user started.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_routine: bool,
    /// That routine's name, when the turn ran exactly one (`Update::routine`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine: Option<String>,
}

/// `<home>/pages/<conversation>.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageFile {
    pub v: u32,
    pub conversation: String,
    pub pinned: bool,
    /// Oldest first; the last is the page as it is.
    pub versions: Vec<Version>,
}

impl PageFile {
    pub fn current(&self) -> Option<&Version> {
        self.versions.last()
    }
}

/// An older version, or the current one, as the clients draw it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub version: u32,
    pub at: i64,
    pub title: String,
    /// A block set (`v`, `items`) as `readBlocks` takes it.
    pub blocks: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub changes: Changes,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub by_routine: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routine: Option<String>,
}

/// One line of the history list: no blocks.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub version: u32,
    pub at: i64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub changes: Changes,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub by_routine: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routine: Option<String>,
}

/// `agents_page` / `agents.page`: the page as it is, and its history.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    pub agent_id: String,
    pub conversation: String,
    pub pinned: bool,
    #[serde(flatten)]
    pub current: VersionView,
    /// Every kept version, newest first, the current one included.
    pub history: Vec<HistoryEntry>,
}

pub fn view_of(v: &Version) -> VersionView {
    VersionView {
        version: v.version,
        at: v.at,
        title: v.title.clone(),
        blocks: json!({ "v": super::blocks::VERSION, "items": v.items }),
        note: v.note.clone(),
        changes: v.changes.clone(),
        by_routine: v.by_routine,
        routine: v.routine.clone(),
    }
}

pub fn view(agent_id: &str, file: &PageFile) -> Option<PageView> {
    let current = file.current()?;
    Some(PageView {
        agent_id: agent_id.to_string(),
        conversation: file.conversation.clone(),
        pinned: file.pinned,
        current: view_of(current),
        history: file
            .versions
            .iter()
            .rev()
            .map(|v| HistoryEntry {
                version: v.version,
                at: v.at,
                title: v.title.clone(),
                note: v.note.clone(),
                changes: v.changes.clone(),
                by_routine: v.by_routine,
                routine: v.routine.clone(),
            })
            .collect(),
    })
}

/* ------------------------------------------------------------ an update */

/// What a `page` call asked for, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct Update {
    pub title: Option<String>,
    /// Checked blocks, each with its `id`, in the order given.
    pub set: Vec<Value>,
    pub remove: Vec<String>,
    pub replace: bool,
    pub note: Option<String>,
    /// The routine whose turn makes this change, named so the page's history
    /// says which (`runner::routine_running`). Set by the app, never by the
    /// agent's call.
    pub routine: Option<String>,
}

impl Update {
    /// Nothing asked: the call reads the page.
    pub fn is_read(&self) -> bool {
        self.title.is_none() && self.set.is_empty() && self.remove.is_empty() && !self.replace
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Every string in a value.
fn strings<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s),
        Value::Array(items) => items.iter().for_each(|i| strings(i, out)),
        Value::Object(map) => map.values().for_each(|i| strings(i, out)),
        _ => {}
    }
}

/// Why `v` can't go on a page because of what it holds: a credential's
/// shape, or a value the user stored as a secret.
fn secret_in(v: &Value) -> Option<&'static str> {
    let mut all = Vec::new();
    strings(v, &mut all);
    all.into_iter().find_map(|s| {
        super::connector::looks_like_secret(s).or_else(|| {
            matches!(super::secrets::redact(s), std::borrow::Cow::Owned(_))
                .then_some("one of the user's stored secrets")
        })
    })
}

fn plain_line(s: &str, max: usize, what: &str) -> Result<String, String> {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > max {
        return Err(format!(
            "`{what}` is over {max} characters: say it in fewer words."
        ));
    }
    if super::blocks::looks_like_html(&s) {
        return Err(format!("`{what}` is plain text: no HTML."));
    }
    if let Some(what_it_is) = super::connector::looks_like_secret(&s) {
        return Err(format!(
            "`{what}` looks like it holds {what_it_is}. Never put secrets on a page."
        ));
    }
    Ok(s)
}

/// Check a `page` call's arguments. Each block goes through `blocks::parse`
/// alone, so a page block is exactly a `show` block plus its `id`.
pub fn parse(args: &Value) -> Result<Update, String> {
    let text = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let title = text("title")
        .map(|t| plain_line(t, MAX_TITLE, "title"))
        .transpose()?;
    let note = text("note")
        .map(|t| plain_line(t, MAX_NOTE, "note"))
        .transpose()?;
    let replace = args.get("replace").and_then(Value::as_bool) == Some(true);
    let raw: Vec<Value> = match args.get("blocks") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(list)) => list.clone(),
        // Some engines send a nested array as a JSON string.
        Some(Value::String(s)) if s.trim().is_empty() => vec![],
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(list)) => list,
            _ => return Err("`blocks` must be a list of objects.".into()),
        },
        Some(_) => return Err("`blocks` must be a list of objects.".into()),
    };
    if raw.len() > MAX_BLOCKS {
        return Err(format!(
            "{} blocks is more than a page holds: at most {MAX_BLOCKS}. Keep the ones that matter, or put the detail in a file.",
            raw.len()
        ));
    }
    let mut set = Vec::with_capacity(raw.len());
    let mut seen: Vec<String> = vec![];
    for (i, value) in raw.into_iter().enumerate() {
        let Value::Object(mut fields) = value else {
            return Err(format!(
                "blocks[{i}] must be an object with `id` and `kind`."
            ));
        };
        let id = match fields.remove("id") {
            Some(Value::String(s)) => s.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        if !valid_id(&id) {
            return Err(format!(
                "blocks[{i}] needs an `id`: lower-case letters, digits, - or _, at most {MAX_ID} characters (\"applications\", \"next-steps\")."
            ));
        }
        if seen.contains(&id) {
            return Err(format!("blocks[{i}]: the id \"{id}\" is given twice."));
        }
        let kind = fields
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some((_, why)) = NOT_ON_A_PAGE.iter().find(|(k, _)| *k == kind.as_str()) {
            return Err(format!("blocks[{i}] ({kind}) can't go on a page: {why}."));
        }
        let parsed = super::blocks::parse(&json!({ "blocks": [Value::Object(fields)] }))
            .map_err(|e| e.replacen("blocks[0]", &format!("blocks[{i}]"), 1))?;
        let Some(block) = parsed.items.into_iter().next() else {
            return Err(format!("blocks[{i}] is empty."));
        };
        let mut value = serde_json::to_value(&block).map_err(|e| e.to_string())?;
        if let Some(what) = secret_in(&value) {
            return Err(format!(
                "blocks[{i}] ({kind}) looks like it holds {what}. Never put secrets on a page: keys and passwords stay in the Keychain (request_secret)."
            ));
        }
        if let Value::Object(map) = &mut value {
            map.insert("id".into(), Value::String(id.clone()));
        }
        seen.push(id);
        set.push(value);
    }
    let remove: Vec<String> = match args.get("remove") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        Some(_) => return Err("`remove` is a list of block ids.".into()),
    };
    if let Some(both) = remove.iter().find(|r| seen.contains(r)) {
        return Err(format!(
            "\"{both}\" is both set and removed: give it in one of `blocks` or `remove`."
        ));
    }
    if replace && set.is_empty() {
        return Err("`replace: true` needs the blocks that make the whole page.".into());
    }
    Ok(Update {
        title,
        set,
        remove,
        replace,
        note,
        routine: None,
    })
}

fn id_of(block: &Value) -> &str {
    block.get("id").and_then(Value::as_str).unwrap_or("")
}

/// `file` with `update` applied, or why not. `None` when nothing changes.
/// Pure: the caller writes it.
pub fn apply(
    file: Option<&PageFile>,
    conversation: &str,
    update: &Update,
    now: i64,
    by_routine: bool,
) -> Result<Option<PageFile>, String> {
    let current = file.and_then(PageFile::current);
    let Some(current) = current else {
        // A new page.
        let Some(title) = update.title.clone() else {
            return Err("A new page needs a `title`.".into());
        };
        if update.set.is_empty() {
            return Err("A new page needs at least one block.".into());
        }
        if !update.remove.is_empty() {
            return Err("There's no page yet, so nothing to remove.".into());
        }
        let items = update.set.clone();
        check_size(&title, &items)?;
        return Ok(Some(PageFile {
            v: FORMAT,
            conversation: conversation.to_string(),
            pinned: true,
            versions: vec![Version {
                version: 1,
                at: now,
                title,
                changes: Changes {
                    added: items.iter().map(|b| id_of(b).to_string()).collect(),
                    ..Changes::default()
                },
                items,
                note: update.note.clone(),
                routine: update.routine.clone().filter(|_| by_routine),
                by_routine,
            }],
        }));
    };
    let file = file.expect("a current version has a file");
    let unknown: Vec<&str> = update
        .remove
        .iter()
        .filter(|r| !current.items.iter().any(|b| id_of(b) == r.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        let ids: Vec<&str> = current.items.iter().map(id_of).collect();
        return Err(format!(
            "No block {} on the page. Its blocks: {}.",
            unknown
                .iter()
                .map(|u| format!("\"{u}\""))
                .collect::<Vec<_>>()
                .join(", "),
            ids.join(", ")
        ));
    }
    let items: Vec<Value> = if update.replace {
        update.set.clone()
    } else {
        let mut items: Vec<Value> = current
            .items
            .iter()
            .filter(|b| !update.remove.iter().any(|r| r == id_of(b)))
            .map(|b| {
                update
                    .set
                    .iter()
                    .find(|n| id_of(n) == id_of(b))
                    .cloned()
                    .unwrap_or_else(|| b.clone())
            })
            .collect();
        for block in &update.set {
            if !items.iter().any(|b| id_of(b) == id_of(block)) {
                items.push(block.clone());
            }
        }
        items
    };
    if items.is_empty() {
        return Err("That would leave the page empty. A page keeps at least one block (the user can unpin it).".into());
    }
    if items.len() > MAX_BLOCKS {
        return Err(format!(
            "That makes {} blocks: a page holds at most {MAX_BLOCKS}. Remove some, or merge them.",
            items.len()
        ));
    }
    let title = update
        .title
        .clone()
        .unwrap_or_else(|| current.title.clone());
    check_size(&title, &items)?;
    let changes = diff(current, &title, &items);
    if changes.is_empty() {
        return Ok(None);
    }
    let mut next = file.clone();
    next.v = FORMAT;
    next.versions.push(Version {
        version: current.version + 1,
        at: now,
        title,
        items,
        note: update.note.clone(),
        changes,
        routine: update.routine.clone().filter(|_| by_routine),
        by_routine,
    });
    if next.versions.len() > MAX_HISTORY {
        let extra = next.versions.len() - MAX_HISTORY;
        next.versions.drain(..extra);
    }
    Ok(Some(next))
}

fn check_size(title: &str, items: &[Value]) -> Result<(), String> {
    let size = serde_json::to_string(&json!({ "title": title, "items": items }))
        .map(|s| s.len())
        .unwrap_or(0);
    if size > MAX_BYTES {
        return Err(format!(
            "The page would be {} KB: at most {} KB. Show fewer rows or points, or keep the full data in a file.",
            size / 1000,
            MAX_BYTES / 1000
        ));
    }
    Ok(())
}

/// What changed from `before` to (`title`, `items`), by block id.
pub fn diff(before: &Version, title: &str, items: &[Value]) -> Changes {
    let old = |id: &str| before.items.iter().find(|b| id_of(b) == id);
    let mut changes = Changes {
        retitled: before.title != title,
        ..Changes::default()
    };
    for block in items {
        match old(id_of(block)) {
            None => changes.added.push(id_of(block).to_string()),
            Some(was) if was != block => changes.changed.push(id_of(block).to_string()),
            Some(_) => {}
        }
    }
    for block in &before.items {
        if !items.iter().any(|b| id_of(b) == id_of(block)) {
            changes.removed.push(id_of(block).to_string());
        }
    }
    // Only the order changed: still a change, said as the blocks that moved.
    if changes.is_empty() {
        let was: Vec<&str> = before.items.iter().map(id_of).collect();
        let now: Vec<&str> = items.iter().map(id_of).collect();
        if was != now {
            changes.changed = now
                .iter()
                .zip(was.iter())
                .filter(|(a, b)| a != b)
                .map(|(a, _)| a.to_string())
                .collect();
        }
    }
    changes
}

/// The page as the agent reads it: title, version, and each block with its id.
pub fn for_agent(file: Option<&PageFile>) -> String {
    let Some(current) = file.and_then(PageFile::current) else {
        return "This conversation has no page yet. Make one with a `title` and blocks, each with an `id`.".into();
    };
    let pinned = file.is_some_and(|f| f.pinned);
    let body = serde_json::to_string(&json!({
        "title": current.title,
        "version": current.version,
        "blocks": current.items,
    }))
    .unwrap_or_default();
    format!(
        "The page as it is (v{}{}): {body}",
        current.version,
        if pinned { "" } else { ", unpinned by the user" }
    )
}

/// What the agent is told after an update.
pub fn receipt(file: &PageFile, changed: bool) -> String {
    let Some(current) = file.current() else {
        return String::new();
    };
    let mut s = if !changed {
        format!(
            "Nothing changed: the page is already like that (v{}).",
            current.version
        )
    } else if current.version == 1 {
        format!(
            "Made the page \"{}\" (v1), pinned above this conversation. Keep it current with `page` when something on it changes.",
            current.title
        )
    } else {
        format!(
            "Updated the page to v{}: {}. The user sees the change on the page; don't repeat it in prose.",
            current.version,
            change_words(&current.changes)
        )
    };
    if !file.pinned {
        s.push_str(" The user unpinned it, so it isn't above the chat; it's kept current all the same, and they can pin it back.");
    }
    s
}

/// "added applications; changed next-steps; removed old; renamed".
pub fn change_words(c: &Changes) -> String {
    let mut parts = vec![];
    let ids = |l: &[String]| l.join(", ");
    if !c.added.is_empty() {
        parts.push(format!("added {}", ids(&c.added)));
    }
    if !c.changed.is_empty() {
        parts.push(format!("changed {}", ids(&c.changed)));
    }
    if !c.removed.is_empty() {
        parts.push(format!("removed {}", ids(&c.removed)));
    }
    if c.retitled {
        parts.push("renamed it".into());
    }
    if parts.is_empty() {
        "no change".into()
    } else {
        parts.join("; ")
    }
}

/// What a card asks before a turn answering outside text changes the page.
pub fn card(before: Option<&PageFile>, after: &PageFile) -> (String, String) {
    let current = after.current().expect("an applied page has a version");
    let title = if before.and_then(PageFile::current).is_some() {
        "Update this conversation's page?".to_string()
    } else {
        "Pin a page to this conversation?".to_string()
    };
    let mut detail = format!(
        "\"{}\", v{}: {}.",
        current.title,
        current.version,
        change_words(&current.changes)
    );
    if let Some(note) = &current.note {
        detail.push_str(&format!(" It says: \"{note}\"."));
    }
    detail.push_str(" It's answering something it read outside the app, so it asks first.");
    (title, detail)
}

/* ------------------------------------------------------------- storage */

static LOCK: Mutex<()> = Mutex::new(());

/// Conversation ids come back from the clients and become file names.
fn valid_conversation(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn path(agent_id: &str, conversation: &str) -> Result<std::path::PathBuf, CommandError> {
    if !valid_conversation(conversation) {
        return Err(super::err_invalid(
            "conversation",
            "not a valid conversation id",
        ));
    }
    Ok(store::agent_home(agent_id)?
        .join("pages")
        .join(format!("{conversation}.json")))
}

fn read_unlocked(agent_id: &str, conversation: &str) -> Result<Option<PageFile>, CommandError> {
    let path = path(agent_id, conversation)?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str::<PageFile>(&raw)
            .ok()
            .filter(|f| f.v <= FORMAT && !f.versions.is_empty())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(super::err_io(e.to_string())),
    }
}

fn write_unlocked(agent_id: &str, file: &PageFile) -> Result<(), CommandError> {
    let path = path(agent_id, &file.conversation)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| super::err_other(e.to_string()))?;
    store::write_atomic(&path, &bytes)
}

/// The conversation's page file, if it has one.
pub fn read(agent_id: &str, conversation: &str) -> Result<Option<PageFile>, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_unlocked(agent_id, conversation)
}

/// The page as the clients draw it.
pub fn get(agent_id: &str, conversation: &str) -> Result<Option<PageView>, CommandError> {
    Ok(read(agent_id, conversation)?.and_then(|f| view(agent_id, &f)))
}

/// One kept version, or why not.
pub fn version(
    agent_id: &str,
    conversation: &str,
    version: u32,
) -> Result<Option<VersionView>, CommandError> {
    Ok(read(agent_id, conversation)?.and_then(|f| {
        f.versions
            .iter()
            .find(|v| v.version == version)
            .map(view_of)
    }))
}

/// Apply an update and keep it. `Ok(None)`: nothing changed.
pub fn update(
    agent_id: &str,
    conversation: &str,
    update: &Update,
    by_routine: bool,
) -> Result<(PageFile, bool), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = read_unlocked(agent_id, conversation).map_err(|e| e.to_string())?;
    match apply(
        before.as_ref(),
        conversation,
        update,
        store::now_ms(),
        by_routine,
    )? {
        Some(next) => {
            write_unlocked(agent_id, &next).map_err(|e| e.to_string())?;
            Ok((next, true))
        }
        None => Ok((before.expect("no change means a page"), false)),
    }
}

/// Pin or unpin. The page after; `None` when there is none.
pub fn set_pinned(
    agent_id: &str,
    conversation: &str,
    pinned: bool,
) -> Result<Option<PageView>, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut file) = read_unlocked(agent_id, conversation)? else {
        return Ok(None);
    };
    if file.pinned != pinned {
        file.pinned = pinned;
        write_unlocked(agent_id, &file)?;
    }
    Ok(view(agent_id, &file))
}

/* --------------------------------------------------------- rewind, fork */

/// A rewind leaves the page as it is: the page isn't part of the chat it
/// folds. What the rewind's line says about it, or nothing without one.
pub fn rewind_clause(agent_id: &str, conversation: &str) -> Option<String> {
    let file = read(agent_id, conversation).ok()??;
    let current = file.current()?;
    Some(format!(
        "The page \u{201c}{}\u{201d} stays as it is (v{}); it isn't rewound.",
        current.title, current.version
    ))
}

/// The page as it was at `at` (ms): the kept versions made before then,
/// the newest of them current. Pure.
pub fn as_of(file: &PageFile, to: &str, at: i64) -> Option<PageFile> {
    // Made before `at`. With none (no page yet, or the versions from then
    // have dropped out of the kept history), no page rather than a wrong one.
    let versions: Vec<Version> = file
        .versions
        .iter()
        .filter(|v| v.at < at)
        .cloned()
        .collect();
    if versions.is_empty() {
        return None;
    }
    Some(PageFile {
        v: FORMAT,
        conversation: to.to_string(),
        pinned: file.pinned,
        versions,
    })
}

/// A fork starts with `from`'s page as it was at `at`, or with none if
/// there wasn't one then. The version it starts on, if any.
pub fn fork(
    agent_id: &str,
    from: &str,
    to: &str,
    at: i64,
) -> Result<Option<(String, u32)>, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = read_unlocked(agent_id, from)? else {
        return Ok(None);
    };
    let Some(copy) = as_of(&file, to, at) else {
        return Ok(None);
    };
    write_unlocked(agent_id, &copy)?;
    Ok(copy.current().map(|v| (v.title.clone(), v.version)))
}

/// One line at the top of a turn in a conversation with a page, so the
/// agent knows it is there to keep current. Empty without one.
pub fn turn_note(agent_id: &str, conversation: &str) -> String {
    let Ok(Some(file)) = read(agent_id, conversation) else {
        return String::new();
    };
    let Some(current) = file.current() else {
        return String::new();
    };
    let mut ids: Vec<&str> = current.items.iter().map(id_of).collect();
    let more = ids.len().saturating_sub(8);
    ids.truncate(8);
    format!(
        "[A note from the app, not the user: this conversation has a page, \"{}\" (v{}; blocks {}{}). If this turn changes something on it, update it with `page`.]\n\n",
        current.title,
        current.version,
        ids.join(", "),
        if more > 0 { format!(" and {more} more") } else { String::new() }
    )
}

#[cfg(test)]
#[path = "page_tests.rs"]
mod tests;
