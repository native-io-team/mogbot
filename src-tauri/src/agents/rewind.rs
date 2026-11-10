//! Recovering from a wrong turn without losing the work: on one of the
//! user's messages, **Edit and resend**, **Fork from here** and **Rewind to
//! here** (docs/agents.md, "Rewind, fork and edit").
//!
//! - **The log is never rewritten.** A rewind folds the lines from that
//!   message on (`conversations::Rewind`, in `conversations.json`): the chat
//!   shows them under "Rewound", collapsed; a recap leaves them out. A fork
//!   is a new conversation whose history is the ids of the lines it was made
//!   with (`conversations::Conversation::inherited`), read from the one log
//!   like its own; nothing is copied.
//! - **Where the engine picks up.** Every turn notes the point its
//!   conversation stood at before it ([`Point`], `turn_points.jsonl`): on
//!   Claude Code a session and its last entry; a turn that started a new
//!   session with nothing handed to it, [`Branch::Blank`]; anything else
//!   (a recap, another engine), [`Branch::Recap`]. Going back to before a
//!   message is then exactly that point: Claude Code resumes the session
//!   at that entry as a new one (`--resume <s> --resume-session-at <entry>
//!   --fork-session`, verified on 2.1.322: the original transcript is left
//!   as it was), a blank point starts blank, and the rest start a new
//!   session handed a recap of what is left of the chat, which the chat
//!   says in its one line. The branch waits in `branches.json` until the
//!   conversation has a session again.
//! - **What isn't undone.** Files an agent changed and anything it sent
//!   stay as they are; the confirm and the line say so. A project-bound
//!   agent's copy keeps its changes too (its changes card's Discard drops
//!   them).
//! - **Never while a turn runs**, nor while the user drives the session
//!   (take over): the session the turn is writing is the one being cut.
//! - **Outside text stays marked.** A fork of a session that read outside
//!   content carries it, so the turn that starts it is marked as having
//!   read it ([`carries_outside`], `exposure`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use super::conversations::{self, Conversations};
use super::engine::Engine;
use super::store::{self, AgentMessage, MessageKind};
use crate::errors::CommandError;

/// Where a conversation's engine picks up from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Branch {
    /// Claude Code: a new session forked from `session` at entry `at`.
    Fork { session: String, at: String },
    /// Codex app-server: a new thread forked from `thread` through its turn
    /// `turn` (`thread/fork` with `lastTurnId`, inclusive; schema of 0.166).
    CodexFork { thread: String, turn: String },
    /// A new session with nothing before it (the agent's instructions and
    /// memory only).
    Blank,
    /// A new session handed a recap of what is left of the chat.
    Recap,
}

/// Where a conversation stood before one turn: what that turn answered
/// (`messages`, the user's lines among them) and its branch point.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub ts: i64,
    pub messages: Vec<String>,
    pub before: Branch,
}

/// A branch waiting for its conversation's next turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pending {
    pub branch: Branch,
    /// The session it comes from had read outside content.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exposed: bool,
}

const POINTS: &str = "turn_points.jsonl";
const BRANCHES: &str = "branches.json";
/// Points kept per agent; past half again as many, the oldest go. A rewind
/// further back than that picks up from a recap.
pub const MAX_POINTS: usize = 400;

/// One writer at a time for both files, never held across another lock.
static LOCK: Mutex<()> = Mutex::new(());

fn home(agent_id: &str) -> Option<std::path::PathBuf> {
    store::agent_home(agent_id).ok().filter(|h| h.is_dir())
}

/* ------------------------------------------------------------- points */

/// A turn is starting: the conversation stood at `before`. Only turns that
/// answer something are noted; the app's own (a tidy) aren't.
pub fn note_turn(agent_id: &str, messages: &[String], before: Branch) {
    if messages.is_empty() {
        return;
    }
    let Some(home) = home(agent_id) else { return };
    let point = Point {
        ts: store::now_ms(),
        messages: messages.to_vec(),
        before,
    };
    let Ok(line) = serde_json::to_string(&point) else {
        return;
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = home.join(POINTS);
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let count = raw.lines().count();
    // One line a turn: appended, and the file rewritten only to trim it.
    let written = if count < MAX_POINTS + MAX_POINTS / 2 && (raw.is_empty() || raw.ends_with('\n'))
    {
        append_private(&path, format!("{line}\n").as_bytes())
    } else {
        let mut lines: Vec<&str> = raw.lines().collect();
        lines.push(&line);
        if lines.len() > MAX_POINTS + MAX_POINTS / 2 {
            lines.drain(..lines.len() - MAX_POINTS);
        }
        let body = lines.join("\n") + "\n";
        store::write_private(&path, body.as_bytes())
    };
    if let Err(e) = written {
        tracing::warn!("[Agents] couldn't note where a turn started: {e}");
    }
}

/// Add `bytes` to the end of an owner-only file, creating it 0600.
fn append_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    store::restrict_file(path)
}

fn points(agent_id: &str) -> Vec<Point> {
    let Some(home) = home(agent_id) else {
        return Vec::new();
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::read_to_string(home.join(POINTS))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// The branch point just before `message`: the latest turn that answered
/// it, when that turn started with it; anything else (it was batched
/// behind an earlier message, no turn noted it) picks up from a recap.
/// A Claude Code point is only exact on Claude Code. Pure.
pub fn plan(points: &[Point], message: &str, engine: Engine) -> Branch {
    let Some(point) = points
        .iter()
        .rev()
        .find(|p| p.messages.iter().any(|m| m == message))
    else {
        return Branch::Recap;
    };
    if point.messages.first().map(String::as_str) != Some(message) {
        return Branch::Recap;
    }
    match &point.before {
        Branch::Fork { .. } if engine != Engine::Claude => Branch::Recap,
        Branch::CodexFork { .. } if engine != Engine::Codex => Branch::Recap,
        b => b.clone(),
    }
}

/// The point a turn starts from, as [`note_turn`] keeps it. `resumed_at`:
/// the last entry of the Claude Code session it resumes, or the last turn
/// of the Codex thread ([`codex_last_turn`]). `recap`: it was handed one (a
/// new engine, a lost session, a fork that fell back).
pub fn start_point(
    engine: Engine,
    resuming: bool,
    session: &str,
    resumed_at: Option<String>,
    pending: Option<&Branch>,
    recap: bool,
) -> Branch {
    if resuming {
        return match (engine, resumed_at) {
            (Engine::Claude, Some(at)) => Branch::Fork {
                session: session.to_string(),
                at,
            },
            (Engine::Codex, Some(turn)) => Branch::CodexFork {
                thread: session.to_string(),
                turn,
            },
            _ => Branch::Recap,
        };
    }
    match pending {
        Some(b) if !recap || *b == Branch::Recap => b.clone(),
        _ if recap => Branch::Recap,
        _ => Branch::Blank,
    }
}

/* -------------------------------------------------- Codex's turn ids */

const CODEX_TURNS: &str = "codex_turns.json";
/// Threads whose last turn is kept, per agent.
const MAX_CODEX_THREADS: usize = 200;

#[derive(Debug, Default, Serialize, Deserialize)]
struct CodexTurns {
    /// Thread id → (its last turn's id, when).
    #[serde(default)]
    last: HashMap<String, (String, i64)>,
}

/// A Codex app-server turn `turn` ran in `thread`: what a fork of that
/// thread through it names.
pub fn note_codex_turn(agent_id: &str, thread: &str, turn: &str) {
    let Some(home) = home(agent_id) else { return };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = home.join(CODEX_TURNS);
    let mut all: CodexTurns = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    all.last
        .insert(thread.to_string(), (turn.to_string(), store::now_ms()));
    while all.last.len() > MAX_CODEX_THREADS {
        let Some(oldest) = all
            .last
            .iter()
            .min_by_key(|(id, (_, at))| (*at, (*id).clone()))
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        all.last.remove(&oldest);
    }
    if let Ok(body) = serde_json::to_vec(&all) {
        if let Err(e) = store::write_private(&path, &body) {
            tracing::warn!("[Agents] couldn't keep a Codex turn's id: {e}");
        }
    }
}

/// The last turn the app saw in Codex thread `thread`.
pub fn codex_last_turn(agent_id: &str, thread: &str) -> Option<String> {
    let home = home(agent_id)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let all: CodexTurns =
        serde_json::from_str(&std::fs::read_to_string(home.join(CODEX_TURNS)).ok()?).ok()?;
    all.last.get(thread).map(|(turn, _)| turn.clone())
}

/* ----------------------------------------------------------- branches */

fn read_branches(home: &std::path::Path) -> HashMap<String, Pending> {
    std::fs::read_to_string(home.join(BRANCHES))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_branches(home: &std::path::Path, all: &HashMap<String, Pending>) {
    let path = home.join(BRANCHES);
    if all.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Ok(body) = serde_json::to_vec_pretty(all) {
        if let Err(e) = store::write_private(&path, &body) {
            tracing::warn!("[Agents] couldn't keep where a conversation picks up: {e}");
        }
    }
}

fn set_pending(agent_id: &str, conversation: &str, pending: Pending) {
    let Some(home) = home(agent_id) else { return };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_branches(&home);
    all.insert(conversation.to_string(), pending);
    write_branches(&home, &all);
}

/// The branch the conversation's next turn starts from. Once it has a
/// session again (`has_session`) the branch was taken: forgotten.
pub fn pending(agent_id: &str, conversation: &str, has_session: bool) -> Option<Pending> {
    let home = home(agent_id)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_branches(&home);
    if has_session {
        if all.remove(conversation).is_some() {
            write_branches(&home, &all);
        }
        return None;
    }
    all.get(conversation).cloned()
}

/// The engine refused to go back to the exact point (a Claude Code without
/// `--resume-session-at`, a Codex that won't fork the thread): the
/// conversation picks up from a recap instead, from this turn on.
pub fn fell_back(agent_id: &str, conversation: &str) {
    let exposed = pending(agent_id, conversation, false).is_some_and(|p| p.exposed);
    set_pending(
        agent_id,
        conversation,
        Pending {
            branch: Branch::Recap,
            exposed,
        },
    );
}

/// Whether the conversation's next turn starts from a session that had
/// read outside content.
pub fn carries_outside(agent_id: &str, conversation: &str, has_session: bool) -> bool {
    !has_session && pending(agent_id, conversation, false).is_some_and(|p| p.exposed)
}

/* ------------------------------------------------------------ actions */

fn refuse_while_busy(agent_id: &str, name: &str, what: &str) -> Result<(), CommandError> {
    if super::runner::in_turn(agent_id) {
        return Err(CommandError::expected(format!(
            "{name} is working. Wait for it to finish, or Stop it, then {what}."
        )));
    }
    if super::takeover::view(agent_id).is_some() {
        return Err(CommandError::expected(format!(
            "You're driving {name}'s session. Hand it back first, then {what}."
        )));
    }
    Ok(())
}

/// The conversation's lines as the chat shows them, without the ones a
/// rewind folded.
fn visible(agent_id: &str, conversation: &str) -> Result<Vec<AgentMessage>, CommandError> {
    let rewound = conversations::page_spec(agent_id, conversation).rewound;
    let mut page = store::conversation_page(agent_id, conversation, usize::MAX, None, None)?;
    page.retain(|m| !rewound.contains(&m.id));
    Ok(page)
}

/// Where `message` is in `lines`, as a user's message.
fn find_user(lines: &[AgentMessage], message: &str) -> Result<usize, CommandError> {
    let Some(i) = lines.iter().position(|m| m.id == message) else {
        return Err(CommandError::expected(
            "That message isn't in this conversation any more.",
        ));
    };
    if lines[i].kind != MessageKind::User {
        return Err(CommandError::expected(
            "Only your own messages can be gone back to.",
        ));
    }
    Ok(i)
}

/// A message as the line quotes it: its first line, at most 40 characters.
pub fn quote(text: &str) -> String {
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('>'))
        .unwrap_or("");
    let mut out: String = first.chars().take(40).collect();
    if first.chars().count() > 40 {
        out = out.trim_end().to_string();
        out.push('…');
    }
    out
}

/// What isn't undone, said the same way everywhere.
pub const NOT_UNDONE: &str = "Files it changed and anything it sent since aren't undone.";

/// The clause a recap adds: the engine can't go back to that exact point.
pub const RECAP_CLAUSE: &str =
    "It picks up from a recap of the chat, since its session can't go back to that exact point.";

/// The quiet line a rewind leaves where the conversation carries on.
pub fn rewind_line(quoted: &str, folded: usize, branch: &Branch) -> String {
    let what = match folded {
        0 => "It is".to_string(),
        1 => "It and the message after it are".to_string(),
        n => format!("It and the {n} messages after it are"),
    };
    let mut line =
        format!("Went back to before “{quoted}”. {what} folded above, not deleted. {NOT_UNDONE}");
    if *branch == Branch::Recap {
        line.push(' ');
        line.push_str(RECAP_CLAUSE);
    }
    line
}

/// The quiet line a fork starts with.
pub fn fork_line(title: &str, quoted: &str, branch: &Branch) -> String {
    let from = if title.is_empty() {
        "this conversation".to_string()
    } else {
        format!("“{title}”")
    };
    let mut line =
        format!("Forked from {from} before “{quoted}”. That one is unchanged. {NOT_UNDONE}");
    if *branch == Branch::Recap {
        line.push(' ');
        line.push_str(RECAP_CLAUSE);
    }
    line
}

fn note(agent_id: &str, conversation: &str, text: String) -> AgentMessage {
    let mut m = super::runner::new_message(agent_id, MessageKind::Note, text);
    m.conversation = Some(conversation.to_string());
    m
}

/// What a rewind or fork did: the list after, and the line to record.
#[derive(Debug)]
pub struct Done {
    pub conversations: Conversations,
    pub line: AgentMessage,
}

/// "Rewind to here" (and the first half of Edit and resend): conversation
/// `conversation` carries on from just before the user's `message`. The
/// lines from it on are folded, the conversation's session goes, and its
/// next turn starts from the branch point before that message.
pub fn rewind(agent_id: &str, conversation: &str, message: &str) -> Result<Done, CommandError> {
    let agent = store::get(agent_id)?;
    refuse_while_busy(agent_id, &agent.name, "go back")?;
    let lines = visible(agent_id, conversation)?;
    let at = find_user(&lines, message)?;
    let quoted = quote(&lines[at].text);
    let ids: Vec<String> = lines[at..].iter().map(|m| m.id.clone()).collect();
    let branch = plan(&points(agent_id), message, agent.engine);
    let exposed = super::exposure::read_outside(agent_id);
    let folded = ids.len() - 1;
    conversations::add_rewind(agent_id, conversation, message, ids)?;
    store::update(agent_id, |a| conversations::forget_session(a, conversation))?;
    set_pending(
        agent_id,
        conversation,
        Pending {
            branch: branch.clone(),
            exposed,
        },
    );
    tracing::info!(
        agent = agent_id,
        conversation,
        ?branch,
        "[Agents] rewound a conversation"
    );
    // The user's own message is folded too, but it's the one they chose:
    // the count is of what came after it.
    let mut said = rewind_line(&quoted, folded, &branch);
    // The page isn't part of the chat a rewind folds (`page::rewind_clause`).
    if let Some(page) = super::page::rewind_clause(agent_id, conversation) {
        said.push(' ');
        said.push_str(&page);
    }
    let line = note(agent_id, conversation, said);
    Ok(Done {
        conversations: conversations::list(agent_id)?,
        line,
    })
}

/// "Fork from here": a new conversation, which the user is now in, whose
/// history is `conversation`'s lines before the user's `message`. The
/// original is left exactly as it is. Allowed while a turn runs: nothing
/// of the running conversation changes.
pub fn fork(agent_id: &str, conversation: &str, message: &str) -> Result<Done, CommandError> {
    let agent = store::get(agent_id)?;
    let lines = visible(agent_id, conversation)?;
    let at = find_user(&lines, message)?;
    let quoted = quote(&lines[at].text);
    let inherited: Vec<String> = lines[..at].iter().map(|m| m.id.clone()).collect();
    let branch = plan(&points(agent_id), message, agent.engine);
    let exposed = super::exposure::read_outside(agent_id);
    let title = conversations::title_of(agent_id, conversation);
    let id = conversations::add_fork(agent_id, conversation, message, inherited)?;
    set_pending(
        agent_id,
        &id,
        Pending {
            branch: branch.clone(),
            exposed,
        },
    );
    tracing::info!(agent = agent_id, from = conversation, to = %id, ?branch, "[Agents] forked a conversation");
    // The fork starts with the page as it was before that message, or none.
    let mut said = fork_line(&title, &quoted, &branch);
    match super::page::fork(agent_id, conversation, &id, lines[at].ts) {
        Ok(Some((page, version))) => said.push_str(&format!(
            " It starts with the page \u{201c}{page}\u{201d} as it was then (v{version})."
        )),
        Ok(None) => {}
        Err(e) => tracing::warn!(
            agent = agent_id,
            "[Agents] a fork's page wasn't copied: {e}"
        ),
    }
    let line = note(agent_id, &id, said);
    Ok(Done {
        conversations: conversations::list(agent_id)?,
        line,
    })
}

/// The recap header a rewound or forked conversation's first turn gets
/// when its engine can't go back to the exact point.
pub const RECAP_HEADER: &str = "[The user went back to an earlier point in this conversation (a rewind or a fork), and your working session couldn't go back with them. This is the conversation as it now stands, newest last: what \"You\" said, you said. Anything after this point that you may remember did not happen in this conversation; files you changed and anything you sent are as they are now. Never ask the user to repeat anything in it.]";

#[cfg(test)]
#[path = "rewind_tests.rs"]
mod tests;
