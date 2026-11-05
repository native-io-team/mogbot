//! Result cards (`share_result`): what an agent hands back at the end of a
//! piece of work, gathered into one card instead of scattered through prose.
//!
//! - **Only what exists.** Files must be real files in the agent's own folder
//!   or one of the user's projects (`files::shareable`), and are *copied* into
//!   `<home>/attachments/<message id>/`, like `share_file`, so the card keeps
//!   working after the original moves. Links must be plain http(s) links the
//!   agent wrote. "What I checked" and "What I didn't verify" are the agent's
//!   own words; nothing here ever fills them in.
//! - **Too much is refused, never trimmed.** A cut "not verified" list would
//!   hide exactly what the user needs to see, so an over-long field is an
//!   error the agent fixes, not something we shorten.
//! - **One card per turn, at the end.** A call stages the card; the turn's end
//!   records it (`runner`), after the reply, so the reply ends on it and the
//!   "what it did" line hangs under it. A second call in the same turn
//!   replaces the first. When the turn also changed a project, the card rides
//!   on that turn's change card instead of standing beside it: one card.
//!   Outside a headless turn (a take-over's terminal) nothing would ever
//!   record a staged card, so it goes into the chat at once instead.
//! - **Revisions, not copies.** "Ask for changes" sends a message carrying
//!   `revises` (`ResultRef`); the next result in reply keeps the card's id as
//!   version n+1 and must say what changed. The earlier version stays in the
//!   log (append-only); the UI shows only the newest version in full.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use super::attachments::{self, Attachment, OutgoingAttachment};
use super::store::{AgentMessage, MessageKind};

pub const MAX_TITLE: usize = 120;
pub const MAX_SUMMARY: usize = 2_000;
/// One line of "checked" / "not verified", a label, or "changes".
pub const MAX_LINE: usize = 300;
/// Lines in "checked", and in "not verified", each.
pub const MAX_LINES: usize = 12;
/// Files and links together. Files are also held to `attachments::MAX_FILES`.
pub const MAX_ITEMS: usize = 12;
pub const MAX_URL: usize = 2_048;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShotRole {
    Before,
    After,
}

/// One thing the result is made of.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResultItem {
    /// A file the agent made, copied into the message's attachments (it is
    /// also on `AgentMessage.attachments`, so the Files list and older
    /// clients see it).
    File {
        file: Attachment,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        /// A screenshot from before or after the change.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<ShotRole>,
    },
    /// A link the agent produced or used (a page it published, a source).
    Link {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultCard {
    /// The same across versions of one result.
    pub id: String,
    pub version: u32,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<ResultItem>,
    /// What the agent says it checked, in its words.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checked: Vec<String>,
    /// What the agent says it did not verify, in its words.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_verified: Vec<String>,
    /// From version 2 on: what changed since the version before, in its words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<String>,
    /// The user's project the work is in (its path, resolved from the name the
    /// agent gave against the real project list): the card offers Preview,
    /// which opens it when the user chooses. Never guessed from the files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// "Test it": what the agent found clicking through the site in the
    /// preview beside the chat (`preview_test`). The steps and the console
    /// errors are the app's own observations; the outcome, summary and what's
    /// broken are the agent's words. A later revision starts without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<super::preview_test::TestReport>,
}

/// On a user message: the result it asks to change, as it stood when asked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultRef {
    pub id: String,
    pub version: u32,
    pub title: String,
}

// ============================================================================
// The call's arguments
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
pub enum DraftItem {
    File {
        path: String,
        label: Option<String>,
        role: Option<ShotRole>,
    },
    Link {
        url: String,
        label: Option<String>,
    },
}

/// `share_result`'s arguments, checked, before any file is touched.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub title: String,
    pub summary: String,
    pub items: Vec<DraftItem>,
    pub checked: Vec<String>,
    pub not_verified: Vec<String>,
    pub revises: Option<String>,
    pub changes: Option<String>,
    /// As the agent named it; the caller resolves it to a path before `prepare`.
    pub project: Option<String>,
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

fn string(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
        Some(_) => Err(format!("`{key}` must be text.")),
    }
}

fn capped(value: Option<String>, key: &str, max: usize) -> Result<Option<String>, String> {
    match value {
        Some(v) if chars(&v) > max => Err(format!(
            "`{key}` is {} characters; keep it under {max}. Nothing was shared.",
            chars(&v)
        )),
        other => Ok(other),
    }
}

/// A list of lines. Blank lines are dropped; too many, or one too long, is
/// refused rather than cut.
fn lines(args: &Value, key: &str) -> Result<Vec<String>, String> {
    let single;
    let raw: &[Value] = match args.get(key) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        // One line written as text rather than a list of one.
        Some(v @ Value::String(_)) => {
            single = [v.clone()];
            &single
        }
        Some(_) => return Err(format!("`{key}` must be a list of short lines.")),
    };
    let mut out = Vec::new();
    for entry in raw {
        let Value::String(s) = entry else {
            return Err(format!("`{key}` must be a list of short lines."));
        };
        let line = s.trim();
        if line.is_empty() {
            continue;
        }
        if chars(line) > MAX_LINE {
            return Err(format!(
                "A line in `{key}` is {} characters; keep each under {MAX_LINE}. Nothing was shared.",
                chars(line)
            ));
        }
        out.push(line.to_string());
    }
    if out.len() > MAX_LINES {
        return Err(format!(
            "`{key}` has {} lines; keep it to {MAX_LINES} at most. Nothing was shared.",
            out.len()
        ));
    }
    Ok(out)
}

/// A link the card may show: http or https, no sign-in details in it.
pub fn check_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if chars(raw) > MAX_URL {
        return Err(format!("A link is longer than {MAX_URL} characters."));
    }
    let url = url::Url::parse(raw).map_err(|_| format!("{raw} isn't a link."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "Only http and https links can go on a result ({raw}). Share a file with `path` instead."
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave sign-in details out of links.".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("{raw} isn't a link."));
    }
    Ok(url.to_string())
}

fn item(entry: &Value) -> Result<DraftItem, String> {
    if !entry.is_object() {
        return Err("Each item is an object with a `path` or a `url`.".into());
    }
    let label = capped(string(entry, "label")?, "label", MAX_LINE)?;
    let role = match string(entry, "role")?.as_deref() {
        None => None,
        Some("before") => Some(ShotRole::Before),
        Some("after") => Some(ShotRole::After),
        Some(other) => {
            return Err(format!(
                "`role` is \"before\" or \"after\" (a screenshot), not \"{other}\"."
            ))
        }
    };
    match (string(entry, "path")?, string(entry, "url")?) {
        (Some(path), None) => Ok(DraftItem::File { path, label, role }),
        (None, Some(url)) => {
            if role.is_some() {
                return Err("`role` is for screenshot files, not links.".into());
            }
            Ok(DraftItem::Link {
                url: check_url(&url)?,
                label,
            })
        }
        (Some(_), Some(_)) => Err("An item has a `path` or a `url`, not both.".into()),
        (None, None) => Err("Each item needs a `path` (a file) or a `url` (a link).".into()),
    }
}

/// Check everything that can be checked without the disk.
pub fn parse(args: &Value) -> Result<Draft, String> {
    let title = capped(string(args, "title")?, "title", MAX_TITLE)?
        .ok_or("`title` is required: a few words naming what you made.")?;
    let summary = capped(string(args, "summary")?, "summary", MAX_SUMMARY)?
        .ok_or("`summary` is required: two or three sentences on what it is.")?;
    let items = match args.get("items") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list.iter().map(item).collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("`items` must be a list.".into()),
    };
    if items.len() > MAX_ITEMS {
        return Err(format!(
            "{} items is too many for one result; keep it to {MAX_ITEMS} (zip files together if you need to).",
            items.len()
        ));
    }
    let files = items
        .iter()
        .filter(|i| matches!(i, DraftItem::File { .. }))
        .count();
    if files > attachments::MAX_FILES {
        return Err(format!(
            "{files} files is too many for one result; keep it to {} (zip the rest).",
            attachments::MAX_FILES
        ));
    }
    Ok(Draft {
        title,
        summary,
        items,
        checked: lines(args, "checked")?,
        not_verified: lines(args, "not_verified")?,
        revises: capped(string(args, "revises")?, "revises", 64)?,
        changes: capped(string(args, "changes")?, "changes", MAX_LINE)?,
        project: capped(string(args, "project")?, "project", 1_024)?,
    })
}

// ============================================================================
// Versions
// ============================================================================

/// The newest version of result `id` in a conversation.
pub fn latest(log: &[AgentMessage], id: &str) -> Option<ResultCard> {
    log.iter()
        .filter_map(|m| m.result.as_ref())
        .filter(|r| r.id == id)
        .max_by_key(|r| r.version)
        .cloned()
}

/// Which result a new one revises, as (id, its newest version).
///
/// `explicit` (the agent named it) must be a result in this conversation.
/// Without it, only the user's latest message counts: if that is an "Ask for
/// changes" and no result has been shared since, this revises it. Anything
/// the user said after an ask is a new request, so an old ask can never
/// capture a later, unrelated result.
pub fn revision_target(
    log: &[AgentMessage],
    explicit: Option<&str>,
) -> Result<Option<ResultCard>, String> {
    if let Some(id) = explicit {
        return latest(log, id).map(Some).ok_or_else(|| {
            format!("There's no result {id} in this conversation to revise. Leave `revises` out to share a new one.")
        });
    }
    for message in log.iter().rev() {
        if message.result.is_some() {
            return Ok(None);
        }
        if message.kind == MessageKind::User {
            return Ok(message
                .revises
                .as_ref()
                .and_then(|asked| latest(log, &asked.id)));
        }
    }
    Ok(None)
}

/// What the user's "Ask for changes" pins to their message, from the log
/// (never from what the client claims the title is).
pub fn reference(log: &[AgentMessage], id: &str) -> Option<ResultRef> {
    latest(log, id).map(|r| ResultRef {
        id: r.id,
        version: r.version,
        title: r.title,
    })
}

/// The card, with the files already copied in (`saved`, in the order the
/// file items came).
pub fn build(
    draft: Draft,
    revising: Option<&ResultCard>,
    saved: Vec<Attachment>,
    new_id: impl FnOnce() -> String,
) -> ResultCard {
    let mut saved = saved.into_iter();
    let items = draft
        .items
        .into_iter()
        .filter_map(|item| match item {
            DraftItem::File { label, role, .. } => saved.next().map(|file| {
                // A before/after only means something on a picture.
                let role = role.filter(|_| file.mime.starts_with("image/"));
                ResultItem::File { file, label, role }
            }),
            DraftItem::Link { url, label } => Some(ResultItem::Link { url, label }),
        })
        .collect();
    let (id, version, changes) = match revising {
        Some(before) => (before.id.clone(), before.version + 1, draft.changes),
        None => (new_id(), 1, None),
    };
    // A revision of a site is still that site, unless it names another.
    let project = draft
        .project
        .or_else(|| revising.and_then(|before| before.project.clone()));
    ResultCard {
        id,
        version,
        title: draft.title,
        summary: draft.summary,
        items,
        checked: draft.checked,
        not_verified: draft.not_verified,
        changes,
        project,
        test: None,
    }
}

/// Resolve and copy the draft's files: every one must exist and be shareable,
/// or nothing is copied.
pub fn save_files(
    draft: &Draft,
    home: &Path,
    roots: &[PathBuf],
    message_id: &str,
) -> Result<Vec<Attachment>, String> {
    let mut outgoing = Vec::new();
    for item in &draft.items {
        let DraftItem::File { path, role, .. } = item else {
            continue;
        };
        let real = super::files::shareable(path, home, roots)?;
        let name = real
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        if role.is_some() && !attachments::mime_for(&name).starts_with("image/") {
            return Err(format!(
                "{name} isn't a picture: `role` (before / after) is for screenshots."
            ));
        }
        outgoing.push(OutgoingAttachment {
            name,
            path: Some(real.display().to_string()),
            data: None,
        });
    }
    attachments::save(home, message_id, outgoing).map_err(|e| e.to_string())
}

/// The whole call after parsing: which result it revises (from the log),
/// the rule that a revision says what changed, the files copied in, and the
/// `agent` message the card will be. Nothing is staged here.
pub fn prepare(
    agent_id: &str,
    home: &Path,
    roots: &[PathBuf],
    draft: Draft,
) -> Result<AgentMessage, String> {
    let log = super::store::messages(agent_id, usize::MAX).map_err(|e| e.to_string())?;
    let revising = revision_target(&log, draft.revises.as_deref())?;
    if let (Some(before), None) = (&revising, &draft.changes) {
        return Err(format!(
            "This revises \"{}\" (version {}): say in `changes`, in one line, what you changed since then. Nothing was shared.",
            before.title, before.version
        ));
    }
    let mut message =
        super::runner::new_message(agent_id, MessageKind::Agent, draft.summary.clone());
    let saved = save_files(&draft, home, roots, &message.id)?;
    message.attachments = saved.clone();
    message.result = Some(build(draft, revising.as_ref(), saved, super::store::new_id));
    Ok(message)
}

// ============================================================================
// Staged until the turn ends
// ============================================================================

/// One staged result per agent: the `agent` message it will be.
static STAGED: LazyLock<Mutex<HashMap<String, AgentMessage>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Delete a card's copied files (`attachments/<message id>/`).
pub fn remove_files(message: &AgentMessage) {
    if message.attachments.is_empty() {
        return;
    }
    if let Ok(home) = super::store::agent_home(&message.agent_id) {
        let _ = std::fs::remove_dir_all(home.join("attachments").join(&message.id));
    }
}

/// Where a card goes when `share_result` is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// A live headless turn: staged, recorded when the turn ends.
    AtTurnEnd,
    /// No live turn (a take-over's terminal): recorded at once, since
    /// nothing would ever take a staged card and the next turn discards it.
    Now,
}

pub fn delivery(in_live_turn: bool) -> Delivery {
    if in_live_turn {
        Delivery::AtTurnEnd
    } else {
        Delivery::Now
    }
}

/// Stage a result for the end of the turn. True when it replaced one.
pub fn stage(message: AgentMessage) -> bool {
    let old = STAGED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(message.agent_id.clone(), message);
    if let Some(old) = &old {
        remove_files(old);
    }
    old.is_some()
}

/// The turn is ending: its result, if it shared one.
pub fn take(agent_id: &str) -> Option<AgentMessage> {
    STAGED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
}

/// A new turn starts clean: anything left from one that never reached its
/// end (it can't happen today, but a leftover must never land on the next).
pub fn discard(agent_id: &str) {
    if let Some(old) = take(agent_id) {
        remove_files(&old);
    }
}

/// The turn also changed a project: its result rides on the change card,
/// under the staged message's id (its copied files are filed under it), so
/// the chat shows one card.
pub fn ride_on(mut changes: AgentMessage, staged: AgentMessage) -> AgentMessage {
    changes.id = staged.id;
    changes.attachments = staged.attachments;
    changes.result = staged.result;
    changes
}

/// What the agent is told the card is.
pub fn staged_reply(card: &ResultCard, replaced: bool) -> String {
    let version = if card.version > 1 {
        format!(" as version {} of the same card", card.version)
    } else {
        String::new()
    };
    let replaced = if replaced {
        " It replaces the result you shared earlier in this turn."
    } else {
        ""
    };
    format!(
        "Saved \"{}\"{version}. It appears as one card at the end of your reply, with Open and Ask for changes; don't repeat its contents, just say a line about it.{replaced}",
        card.title
    )
}

/// What the agent is told when the card went into the chat at once.
pub fn recorded_reply(card: &ResultCard) -> String {
    let version = if card.version > 1 {
        format!(" as version {} of the same card", card.version)
    } else {
        String::new()
    };
    format!(
        "Shared \"{}\"{version}. It is in the chat now, as its own card with Open and Ask for changes; don't repeat its contents. Calling this again adds another card rather than replacing this one.",
        card.title
    )
}

/// The prompt line ahead of an "Ask for changes" message.
pub fn revising_prompt(r: &ResultRef) -> String {
    format!(
        "The user is asking for changes to your result \"{}\" (version {}). Make them, then call share_result again with revises: \"{}\" and, in `changes`, one line on what you changed, so the same card updates to version {}.",
        r.title,
        r.version,
        r.id,
        r.version + 1
    )
}

#[cfg(test)]
mod tests;
