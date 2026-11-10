//! Several conversations with one agent, sharing its memory.
//!
//! An agent used to have exactly one conversation: one engine session and
//! one chat, with Start fresh drawing a divider across it. Now it has a list
//! of them. Each has its own engine session and its own chat; its
//! instructions and `## Memory` (its CLAUDE.md, read by every turn) are the
//! agent's, so whatever it remembers in one it knows in all of them.
//!
//! - **The chat log stays one file.** Every line in `messages.jsonl` says
//!   which conversation it was said in (`AgentMessage::conversation`); a
//!   conversation's chat is its lines (`store::conversation_page`). A line
//!   written before there were several says nothing and is the first
//!   conversation's, so the existing chat *is* the first conversation and
//!   nothing moves: no migration step, nothing to lose, and an older build
//!   still reads the whole log (all conversations, interleaved). Cards,
//!   answers and search keep working on the one log as they did.
//! - **Sessions.** The agent's own session fields (`session_id`,
//!   `new_engine`, `context`, the session it has on another engine while
//!   `away`) belong to one conversation, the *loaded* one
//!   ([`Sessions::loaded`]); the others' are parked beside them
//!   ([`Parked`]). A turn for another conversation swaps them ([`swap`]) in
//!   one registry write, between turns, by the agent's own worker. Everything
//!   that already reads those fields (resume, crossover, take over, tidy,
//!   the context meter, what outside text it read, which is kept per
//!   session) then works per conversation without knowing there are several.
//! - **One turn at a time per agent**, as before. Two turns at once would
//!   share the agent's home and CLAUDE.md (both writing memory), its open
//!   project copy, its turn mark and inbox, its approval broker slot and a
//!   take-over: none of them per conversation. Engines would allow two
//!   sessions at once; this app's agent would not stay one agent. What
//!   arrives for another conversation waits in the queue, is never batched
//!   with what was said in a different one (`runner::same_place_prefix`),
//!   and runs in its own conversation's session when its turn comes.
//! - **Where a line goes.** The user's own messages go where they were sent
//!   (the conversation on screen). A line the app or the turn records
//!   without saying goes to the loaded conversation, which is the turn's
//!   while a turn runs ([`stamped`]). An answer another agent sends back
//!   goes to the conversation that asked it ([`note_asked`]); a routine
//!   runs in the conversation it was set up in (`CheckIn::conversation`).
//! - **The list.** `<home>/conversations.json`: titles, when each started and
//!   last moved, a preview line, and which one the user is in (`current`).
//!   Absent, the list is the first conversation alone, titled from the
//!   first thing the user said in it. A title comes from the first message
//!   of a conversation until the user renames it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::store::{self, Agent, AgentMessage, MessageKind};
use crate::errors::CommandError;

/// The first conversation's id: the chat every agent already had.
pub const FIRST: &str = "first";
/// Longest title, in characters (auto or typed).
pub const TITLE_CHARS: usize = 60;
/// Most conversations kept per agent. Past it, creating one is refused
/// with a line saying so; nothing is ever dropped to make room.
pub const MAX_CONVERSATIONS: usize = 200;

/// The engine sessions of an agent's conversations, on the agent's registry
/// entry so a swap is one atomic write.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sessions {
    /// The conversation the agent's own session fields belong to. `None`:
    /// the first one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loaded: Option<String>,
    /// The other conversations' sessions, until a turn loads one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parked: Vec<Parked>,
}

impl Sessions {
    pub fn is_empty(&self) -> bool {
        self.loaded.is_none() && self.parked.is_empty()
    }
}

/// A conversation's session while another one is loaded.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Parked {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Its next turn starts a session on a new engine and is handed a recap.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub new_engine: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<super::context::ContextFill>,
    /// Its session on the engine the agent is carrying on with (`away`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_session: Option<String>,
}

impl Parked {
    fn is_blank(&self) -> bool {
        self.session_id.is_none()
            && !self.new_engine
            && self.context.is_none()
            && self.away_session.is_none()
    }
}

/// The conversation the agent's session fields belong to.
pub fn loaded(agent: &Agent) -> &str {
    agent.conversations.loaded.as_deref().unwrap_or(FIRST)
}

/// The conversation a line was said in.
pub fn of(message: &AgentMessage) -> &str {
    message.conversation.as_deref().unwrap_or(FIRST)
}

/// Load conversation `to`'s session into the agent's own fields, parking
/// the one that was there. Returns whether anything changed. Only the
/// agent's worker calls it, between turns (`runner`), or a take-over that
/// holds the agent (no turn can start).
pub fn swap(agent: &mut Agent, to: &str) -> bool {
    let from = loaded(agent).to_string();
    if from == to {
        return false;
    }
    let leaving = Parked {
        id: from.clone(),
        session_id: agent.session_id.take(),
        new_engine: std::mem::take(&mut agent.new_engine),
        context: agent.context.take(),
        away_session: agent.away.as_ref().and_then(|a| a.session_id.clone()),
    };
    agent.conversations.parked.retain(|p| p.id != from);
    if !leaving.is_blank() {
        agent.conversations.parked.push(leaving);
    }
    let coming = agent
        .conversations
        .parked
        .iter()
        .position(|p| p.id == to)
        .map(|i| agent.conversations.parked.remove(i))
        .unwrap_or_default();
    agent.session_id = coming.session_id;
    agent.new_engine = coming.new_engine;
    agent.context = coming.context;
    if let Some(away) = agent.away.as_mut() {
        away.session_id = coming.away_session;
        away.fresh = false;
    }
    agent.conversations.loaded = (to != FIRST).then(|| to.to_string());
    true
}

/// It moved engine: no conversation's session crosses with it. One that had
/// a session is handed a recap of its own chat on its next turn, as the
/// loaded one is (`Agent::switch_engine`).
pub fn engine_switched(agent: &mut Agent) {
    for parked in &mut agent.conversations.parked {
        let had = parked.session_id.is_some() || parked.new_engine;
        parked.session_id = None;
        parked.away_session = None;
        parked.context = None;
        parked.new_engine = had;
    }
    agent.conversations.parked.retain(|p| !p.is_blank());
}

/// Its model changed: a reading against the old model's window is no
/// reading (`Agent::set_model`), in any conversation.
pub fn forget_readings(agent: &mut Agent) {
    for parked in &mut agent.conversations.parked {
        parked.context = None;
    }
    agent.conversations.parked.retain(|p| !p.is_blank());
}

/// `message` with the conversation it belongs to when it doesn't say: the
/// one its agent's engine has loaded, which is the turn's while one runs.
/// An agent that is gone keeps it unsaid (the first conversation's).
pub fn stamped(message: &AgentMessage) -> AgentMessage {
    let mut message = message.clone();
    if message.conversation.is_none() {
        if let Ok(agent) = store::get(&message.agent_id) {
            message.conversation = Some(loaded(&agent).to_string());
        }
    }
    message
}

/* ------------------------------------------------------- the list itself */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// From its first message until the user renames it; empty before that.
    #[serde(default)]
    pub title: String,
    /// The user named it: its first message no longer does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named: bool,
    pub created_at: i64,
    #[serde(default)]
    pub last_activity_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct List {
    /// Where the user is: what a chat opens on, and where a message sent
    /// without naming one goes (an older phone's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<String>,
    #[serde(default)]
    items: Vec<Conversation>,
    /// Routine id → the conversation it was set up in (and runs in). A
    /// routine not here is the first conversation's.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    routines: HashMap<String, String>,
    /// Kept as written by a newer build.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

/// One conversation as the switcher shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub id: String,
    pub title: String,
    pub named: bool,
    pub created_at: i64,
    pub last_activity_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// The one the user is in.
    pub current: bool,
    /// Its session is the agent's loaded one: the turn in progress, if any, is its.
    pub loaded: bool,
    /// Cards in it waiting on the user.
    pub waiting: u32,
    /// How full it is, as its engine last said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<super::context::ContextFill>,
}

/// Everything the list commands answer with.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversations {
    pub agent_id: String,
    pub current: String,
    /// Newest activity first.
    pub items: Vec<ConversationView>,
    /// Routine id → the conversation it runs in, for routines not in the
    /// first one.
    pub routines: HashMap<String, String>,
}

/// The list's own lock: reads and writes of every agent's list, never held
/// across the registry's or a log's.
static LOCK: Mutex<()> = Mutex::new(());

fn path(agent_id: &str) -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agent_home(agent_id)?.join("conversations.json"))
}

fn read_raw(agent_id: &str) -> Result<Option<List>, CommandError> {
    let path = path(agent_id)?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(super::err_io(e.to_string())),
    }
}

fn write(agent_id: &str, list: &List) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec_pretty(list).map_err(|e| super::err_other(e.to_string()))?;
    store::write_atomic(&path(agent_id)?, &bytes)
}

/// The list, with the first conversation always in it: made up from the
/// agent and its log when there is no file yet (or it is unreadable).
fn read(agent: &Agent) -> Result<List, CommandError> {
    let mut list = read_raw(&agent.id)?.unwrap_or_default();
    if !list.items.iter().any(|c| c.id == FIRST) {
        list.items.insert(
            0,
            Conversation {
                id: FIRST.to_string(),
                title: first_title(&agent.id),
                named: false,
                created_at: agent.created_at,
                last_activity_at: agent.last_activity_at,
                preview: agent.preview.clone(),
            },
        );
    }
    Ok(list)
}

/// The first thing the user said in the first conversation, as a title.
fn first_title(agent_id: &str) -> String {
    let Ok(home) = store::agent_home(agent_id) else {
        return String::new();
    };
    let Ok(raw) = std::fs::read_to_string(home.join("messages.jsonl")) else {
        return String::new();
    };
    raw.lines()
        .filter(|l| l.contains("\"user\""))
        .filter_map(|l| serde_json::from_str::<AgentMessage>(l).ok())
        .find(|m| m.kind == MessageKind::User && of(m) == FIRST && !m.text.trim().is_empty())
        .map(|m| title_from(&m.text))
        .unwrap_or_default()
}

/// A title from what the user said: its first line, without Markdown
/// quoting, clipped at a word to [`TITLE_CHARS`].
pub fn title_from(text: &str) -> String {
    // What they wrote, not what they quoted (`> …`), unless a quote is all there is.
    let own = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('>'));
    let line = own.unwrap_or_else(|| {
        text.lines()
            .map(|l| l.trim_start_matches('>').trim())
            .find(|l| !l.is_empty())
            .unwrap_or("")
    });
    let line: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TITLE_CHARS {
        return line;
    }
    let cut: String = line.chars().take(TITLE_CHARS - 1).collect();
    let cut = match cut.rfind(' ') {
        Some(at) if at > TITLE_CHARS / 2 => cut[..at].to_string(),
        _ => cut,
    };
    format!("{}…", cut.trim_end())
}

fn current_of(list: &List) -> String {
    list.current
        .clone()
        .filter(|c| list.items.iter().any(|i| &i.id == c))
        .unwrap_or_else(|| FIRST.to_string())
}

/// The agent's conversations, newest activity first.
pub fn list(agent_id: &str) -> Result<Conversations, CommandError> {
    let agent = store::get(agent_id)?;
    let list = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read(&agent)?
    };
    let mut waiting: HashMap<String, u32> = HashMap::new();
    for card in store::pending_card_messages(agent_id).unwrap_or_default() {
        *waiting.entry(of(&card).to_string()).or_default() += 1;
    }
    Ok(view(&agent, &list, &waiting))
}

fn view(agent: &Agent, list: &List, waiting: &HashMap<String, u32>) -> Conversations {
    let current = current_of(list);
    let on = loaded(agent).to_string();
    let mut items: Vec<ConversationView> = list
        .items
        .iter()
        .map(|c| ConversationView {
            id: c.id.clone(),
            title: c.title.clone(),
            named: c.named,
            created_at: c.created_at,
            last_activity_at: c.last_activity_at.max(c.created_at),
            preview: c.preview.clone(),
            current: c.id == current,
            loaded: c.id == on,
            waiting: waiting.get(&c.id).copied().unwrap_or(0),
            context: if c.id == on {
                agent.context.clone()
            } else {
                agent
                    .conversations
                    .parked
                    .iter()
                    .find(|p| p.id == c.id)
                    .and_then(|p| p.context.clone())
            },
        })
        .collect();
    items.sort_by(|a, b| {
        (b.last_activity_at, b.created_at).cmp(&(a.last_activity_at, a.created_at))
    });
    let routines = list
        .routines
        .iter()
        .filter(|(id, c)| {
            c.as_str() != FIRST
                && agent.check_ins.iter().any(|r| &r.id == *id)
                && list.items.iter().any(|i| &i.id == *c)
        })
        .map(|(id, c)| (id.clone(), c.clone()))
        .collect();
    Conversations {
        agent_id: agent.id.clone(),
        current,
        items,
        routines,
    }
}

/// Where the user is in this agent's chat.
pub fn current(agent_id: &str) -> String {
    let Ok(agent) = store::get(agent_id) else {
        return FIRST.to_string();
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(&agent)
        .map(|l| current_of(&l))
        .unwrap_or_else(|_| FIRST.to_string())
}

/// Whether the agent has a conversation with this id.
pub fn exists(agent_id: &str, id: &str) -> bool {
    if id == FIRST {
        return true;
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_raw(agent_id)
        .ok()
        .flatten()
        .is_some_and(|l| l.items.iter().any(|c| c.id == id))
}

/// "New conversation": a new one the user is now in. When the one they are
/// in has nothing said in it yet, that one is it (two empty ones help no
/// one). Never touches a session or a turn in progress: its first message
/// starts its session when its turn comes, with the agent's instructions
/// and memory and nothing else.
pub fn create(agent_id: &str) -> Result<Conversations, CommandError> {
    let agent = store::get(agent_id)?;
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = read(&agent)?;
        let current = current_of(&list);
        let empty = list
            .items
            .iter()
            .find(|c| c.id == current)
            .is_some_and(|c| c.id != FIRST && c.title.is_empty() && c.preview.is_none());
        if !empty {
            if list.items.len() >= MAX_CONVERSATIONS {
                return Err(CommandError::expected(format!(
                    "{} already has {MAX_CONVERSATIONS} conversations. Carry on in one of them.",
                    agent.name
                )));
            }
            let now = store::now_ms();
            let id = format!("c{}", store::new_id());
            list.items.push(Conversation {
                id: id.clone(),
                title: String::new(),
                named: false,
                created_at: now,
                last_activity_at: now,
                preview: None,
            });
            list.current = Some(id);
            write(agent_id, &list)?;
        }
    }
    list(agent_id)
}

/// The user opened one of the agent's conversations.
pub fn select(agent_id: &str, id: &str) -> Result<Conversations, CommandError> {
    let agent = store::get(agent_id)?;
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = read(&agent)?;
        if !list.items.iter().any(|c| c.id == id) {
            return Err(CommandError::expected(
                "That conversation isn't there any more.",
            ));
        }
        if list.current.as_deref() != Some(id) {
            list.current = Some(id.to_string());
            write(agent_id, &list)?;
        }
    }
    list(agent_id)
}

/// The user named a conversation. Empty gives it back to its first message.
pub fn rename(agent_id: &str, id: &str, title: &str) -> Result<Conversations, CommandError> {
    let agent = store::get(agent_id)?;
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() > TITLE_CHARS {
        return Err(super::err_invalid(
            "title",
            format!("Keep it to {TITLE_CHARS} characters."),
        ));
    }
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = read(&agent)?;
        let Some(item) = list.items.iter_mut().find(|c| c.id == id) else {
            return Err(CommandError::expected(
                "That conversation isn't there any more.",
            ));
        };
        if title.is_empty() {
            item.named = false;
            item.title = if id == FIRST {
                first_title(agent_id)
            } else {
                String::new()
            };
        } else {
            item.named = true;
            item.title = title;
        }
        write(agent_id, &list)?;
    }
    list(agent_id)
}

/// A line was recorded: its conversation moved. The first thing the user
/// says in one names it, until they rename it. Returns whether the list
/// changed in a way the switcher shows (a title).
pub fn touch(message: &AgentMessage, preview: Option<&str>) -> bool {
    if message.agent_id.is_empty() || message.room.is_some() {
        return false;
    }
    let Ok(agent) = store::get(&message.agent_id) else {
        return false;
    };
    let id = of(message).to_string();
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut list) = read(&agent) else {
        return false;
    };
    let Some(item) = list.items.iter_mut().find(|c| c.id == id) else {
        return false;
    };
    item.last_activity_at = item.last_activity_at.max(message.ts);
    if let Some(p) = preview {
        item.preview = Some(p.to_string());
    }
    let mut titled = false;
    if message.kind == MessageKind::User && !item.named && item.title.is_empty() {
        item.title = title_from(&message.text);
        titled = !item.title.is_empty();
    }
    let _ = write(&message.agent_id, &list);
    titled
}

/// A routine was just set up for the agent: it belongs to the conversation
/// its turn is in when one is running (the agent set it up there), else the
/// one the user is in (they set it up from that chat).
pub fn note_routine(agent_id: &str, routine_id: &str) {
    let Ok(agent) = store::get(agent_id) else {
        return;
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut list) = read(&agent) else {
        return;
    };
    let id = if super::runner::in_turn(agent_id) {
        loaded(&agent).to_string()
    } else {
        current_of(&list)
    };
    // Nothing to write while there is only the first conversation.
    if id == FIRST && read_raw(agent_id).ok().flatten().is_none() {
        return;
    }
    list.routines
        .retain(|r, _| agent.check_ins.iter().any(|c| &c.id == r));
    list.routines.insert(routine_id.to_string(), id);
    let _ = write(agent_id, &list);
}

/// The conversation a routine runs in: the one it was set up in, while
/// that is still there; otherwise the first.
pub fn routine_in(agent_id: &str, routine_id: &str) -> String {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_raw(agent_id)
        .ok()
        .flatten()
        .and_then(|l| {
            let c = l.routines.get(routine_id)?.clone();
            l.items.iter().any(|i| i.id == c).then_some(c)
        })
        .unwrap_or_else(|| FIRST.to_string())
}

/* ---------------------------------------------- answers to where they were asked */

/// (asker, helper) → the asker's conversation that asked the helper.
static ASKED: LazyLock<Mutex<HashMap<(String, String), String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `asker` sent `helper` a request: its answer belongs in the conversation
/// the asker's turn is in now.
pub fn note_asked(asker: &str, helper: &str) {
    let Ok(agent) = store::get(asker) else {
        return;
    };
    let mut asked = ASKED.lock().unwrap_or_else(|e| e.into_inner());
    if asked.len() > 1000 {
        asked.clear();
    }
    asked.insert(
        (asker.to_string(), helper.to_string()),
        loaded(&agent).to_string(),
    );
}

/// The conversation of `asker`'s that asked `helper` something, if it did
/// since the app started. `None`: wherever the asker is now.
pub fn asked_in(asker: &str, helper: &str) -> Option<String> {
    ASKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(asker.to_string(), helper.to_string()))
        .cloned()
}

#[cfg(test)]
#[path = "conversations_tests.rs"]
mod tests;
