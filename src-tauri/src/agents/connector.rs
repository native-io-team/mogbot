//! Importing from another assistant as a conversation, over the connector.
//!
//! MCP only goes one way (the other assistant calls us), so the other
//! assistant drives: it calls `import_conversation` (Remote Access,
//! `remote_access/tools.rs`) with its message, and each call answers with
//! what was said back and a `STATUS:` / `NEXT:` pair.
//!
//! Text from the internet, typed by an assistant that can itself be
//! prompt-injected, is kept away from everything that matters:
//!
//! 1. **Armed, then asked.** Nothing answers until the user presses Start in
//!    Import agents ([`arm`]), which allows one import, and only until the
//!    app quits. The first message then puts an Allow / Deny card in the
//!    Chief's chat ("Grok wants to bring its agents over"); until it's
//!    answered the tool says `waiting_on_user`, and the message is held, not
//!    delivered. Deny, Stop, a finished import and a restart all disarm: the
//!    next import needs Start again. Nothing re-arms on a timer.
//! 2. **A sealed interview.** The other assistant never reaches the Chief's
//!    session. It talks to a throwaway session that speaks as the Chief
//!    with no built-in tools, no settings, no folders and only three tools
//!    of its own (`agents::interview`), so it can't read other agents,
//!    memory or chats, and the user's "Always allow" rules don't apply.
//! 3. **Staged, not live.** Those tools only fill a draft. Finishing turns
//!    it into one review card in the Chief's chat (`agents::review`), and
//!    nothing is created or changed until the user presses Import there.
//!    No grants come across, names are never overwritten without the user
//!    choosing Replace with the diff shown, and the Chief itself is never
//!    edited: its notes are an optional item on the card.
//! 4. **Private.** The other assistant only ever gets what the interview
//!    wrote (the talk's outbox), never the Chief's chat, the user's messages
//!    or error details.
//! 5. **Stop** (the bar over the composer, the Chief's own Stop, the phone's
//!    Stop on the Chief) ends the interview, drops what the other assistant
//!    had queued (never anything of the user's) and disarms. Caps:
//!    [`MAX_EXCHANGES`] messages and [`MAX_TOTAL_CHARS`] per armed import.
//!
//! The user watches the conversation in the Chief's chat: the other
//! assistant's lines are `from_agent` lines whose peer is
//! `connector:<source>` ("From Grok · via connector"), the interview's
//! replies are `sent_to_agent` lines to the same peer ("To Grok"). Neither
//! is ever handed to the Chief's own session (`runner::recap_lines` skips
//! them).
//!
//! State is in memory: after a restart there is no import and nothing is
//! armed. A review card carries its own payload, so it still imports.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use super::interview;
use super::review::{self, CardKind, ConnectorCard, Picks, Proposal, Review};
use super::runner;
use super::store::{self, AgentRef, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/// `agents://import-talk`, payload: the [`Gate`] (armed, and the talk or null).
pub const EVENT: &str = "agents://import-talk";
/// Messages from the other assistant per armed import.
pub const MAX_EXCHANGES: u32 = 60;
/// Characters from the other assistant per armed import.
pub const MAX_TOTAL_CHARS: usize = 300_000;
/// Quiet for this long, an import is over.
pub const IDLE_MS: i64 = 30 * 60 * 1000;
/// An ended import stays on the bar this long.
const ENDED_SHOWN_MS: i64 = 10 * 60 * 1000;
const MAX_CHARS: usize = 20_000;
const MAX_SOURCE_CHARS: usize = 40;
/// How long a call waits by default, and at most: inside the minute chat
/// clients give a tool call.
pub const DEFAULT_WAIT_SECS: u64 = 40;
pub const MAX_WAIT_SECS: u64 = 50;
/// The peer id prefix that marks a line as part of the import conversation.
pub const PEER_PREFIX: &str = "connector:";
/// What the other assistant is told when the interview failed on our side.
/// Never the reason: that is for the user.
const FAILED_REPLY: &str =
    "(The interview couldn't answer that one. Send your last message again.)";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TalkState {
    /// The consent card is up; the first message is held.
    AwaitingConsent,
    /// The sealed interview is going.
    Interviewing,
    /// The review card is up; nothing is created yet.
    Review,
    /// The user pressed Import.
    Imported,
    /// The user dismissed the review.
    Declined,
    /// The user denied the consent card.
    Denied,
    /// The user stopped it (or it went quiet for [`IDLE_MS`]).
    Stopped,
}

impl TalkState {
    pub fn live(self) -> bool {
        matches!(
            self,
            Self::AwaitingConsent | Self::Interviewing | Self::Review
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Talk {
    pub id: String,
    /// The other assistant, as it named itself ("Grok").
    pub source: String,
    pub chief_id: String,
    pub state: TalkState,
    pub started_at: i64,
    pub last_at: i64,
    /// Messages it has sent.
    pub exchanges: u32,
    /// Agents staged in the draft so far, by name.
    pub staged: Vec<String>,
    /// Agents the user imported from the review.
    pub imported: Vec<String>,
    /// The interview is writing its answer.
    pub busy: bool,
    /// The interview's MCP path: only this import's session can call it.
    #[serde(skip)]
    secret: String,
    /// The first message, held until the user allows the import.
    #[serde(skip)]
    held: Option<String>,
    #[serde(skip)]
    draft: Review,
    /// What the interview said that the other assistant hasn't been given.
    #[serde(skip)]
    outbox: Vec<String>,
    #[serde(skip)]
    chars: usize,
    #[serde(skip)]
    session: Option<interview::Session>,
    #[serde(skip)]
    cancel: Arc<Notify>,
    #[serde(skip)]
    consent_card: Option<String>,
    #[serde(skip)]
    review_card: Option<String>,
    #[serde(skip)]
    next_key: u32,
}

#[derive(Default)]
struct State {
    /// The user pressed Start: one import may begin.
    armed: bool,
    talk: Option<Talk>,
}

static STATE: Mutex<State> = Mutex::new(State {
    armed: false,
    talk: None,
});

fn lock() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// An interview quiet for too long is over: stopped, as if the user had,
/// and written to the audit log like a Stop.
fn expire(state: &mut State, now: i64) {
    if let Some(t) = state.talk.as_mut() {
        if t.state == TalkState::Interviewing && !t.busy && now - t.last_at > IDLE_MS {
            t.state = TalkState::Stopped;
            t.outbox.clear();
            t.held = None;
            if let Some(s) = &t.session {
                s.remove();
            }
            state.armed = false;
            audit(
                &t.source,
                &format!("ended: no message for {} minutes", IDLE_MS / 60_000),
                true,
            );
        }
    }
}

/// The import going on, or one that just ended (for the bar and the modal).
pub fn current() -> Option<Talk> {
    let now = store::now_ms();
    let mut state = lock();
    expire(&mut state, now);
    let talk = state.talk.clone()?;
    if !talk.state.live() && now - talk.last_at > ENDED_SHOWN_MS {
        return None;
    }
    Some(talk)
}

/// What the modal shows: armed, and the import if any.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub armed: bool,
    pub talk: Option<Talk>,
}

pub fn gate() -> Gate {
    let talk = current();
    Gate {
        armed: lock().armed,
        talk,
    }
}

fn emit(app: &AppHandle, chief_id: Option<&str>) {
    let _ = app.emit(EVENT, gate());
    // The Chief's row reads "Talking to Grok" while the interview goes on.
    if let Some(chief) = chief_id {
        runner::refresh_status(app, chief);
    }
}

fn note(app: &AppHandle, agent_id: &str, text: String) {
    let _ = runner::record(app, runner::new_message(agent_id, MessageKind::Note, text));
}

fn peer(source: &str) -> AgentRef {
    AgentRef {
        id: format!("{PEER_PREFIX}{source}"),
        name: source.to_string(),
    }
}

/// Whether this line is part of an import conversation (and so never part
/// of the Chief's own context).
pub fn is_connector_line(m: &store::AgentMessage) -> bool {
    m.peer
        .as_ref()
        .is_some_and(|p| p.id.starts_with(PEER_PREFIX))
}

/// What the Chief's row says while its interview runs, if it does.
pub fn interview_status(agent_id: &str) -> Option<runner::Status> {
    let state = lock();
    let t = state.talk.as_ref()?;
    (t.chief_id == agent_id && t.state == TalkState::Interviewing).then(|| runner::Status {
        state: "working",
        activity: Some(format!("Bringing in agents from {}", t.source)),
        since: Some(t.started_at),
        work: None,
        room: None,
    })
}

/* --------------------------------------------------------------- arming */

/// The user pressed Start: allow one import. Refused while one is going.
pub fn arm(app: &AppHandle) -> Result<Gate, CommandError> {
    arm_state()?;
    emit(app, None);
    Ok(gate())
}

fn arm_state() -> Result<(), CommandError> {
    let mut state = lock();
    expire(&mut state, store::now_ms());
    if state.talk.as_ref().is_some_and(|t| t.state.live()) {
        return Err(CommandError::expected(
            "An import is already going. Stop it first to start another.",
        ));
    }
    state.talk = None;
    state.armed = true;
    Ok(())
}

/* ----------------------------------------------------------------- stop */

/// What stopping ended, for the app side to tidy up.
struct Stopped {
    talk: Option<Talk>,
}

fn stop_state(now: i64) -> Stopped {
    let mut state = lock();
    state.armed = false;
    let Some(t) = state.talk.as_mut().filter(|t| t.state.live()) else {
        return Stopped { talk: None };
    };
    t.state = TalkState::Stopped;
    t.last_at = now;
    t.busy = false;
    // Only what the other assistant had queued is dropped.
    t.held = None;
    t.outbox.clear();
    t.cancel.notify_waiters();
    t.cancel.notify_one();
    if let Some(s) = &t.session {
        s.remove();
    }
    Stopped {
        talk: Some(t.clone()),
    }
}

/// The user stopped it: the interview ends, the other assistant's queued
/// message is dropped, its cards go inert, and the connector is disarmed.
/// The Chief's own turn and queue aren't touched. True if anything stopped.
pub fn stop(app: &AppHandle) -> bool {
    let was_armed = lock().armed;
    let Stopped { talk } = stop_state(store::now_ms());
    let Some(talk) = talk else {
        if was_armed {
            emit(app, None);
        }
        return was_armed;
    };
    for card in [&talk.consent_card, &talk.review_card]
        .into_iter()
        .flatten()
    {
        if let Ok(Some(m)) =
            store::set_approval_status(&talk.chief_id, card, ApprovalStatus::Expired)
        {
            let _ = app.emit(runner::EVENT_MESSAGE, &m);
        }
    }
    store::refresh_pending(&talk.chief_id);
    note(
        app,
        &talk.chief_id,
        format!(
            "You stopped the import from {}. Nothing was created. To try again, open Import agents and press Start.",
            talk.source
        ),
    );
    audit(&talk.source, "stopped by the user", true);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    emit(app, Some(&talk.chief_id));
    true
}

/* ---------------------------------------------------------------- text */

/// The other assistant's name, as it's shown: short, one line, no hidden
/// characters. Names that could pass for the user, the Chief or one of the
/// user's agents are refused.
pub fn clean_source(raw: &str, chief: &str) -> Result<String, String> {
    let name = review::clean_line(raw, MAX_SOURCE_CHARS);
    if name.is_empty() {
        return Err("Say who you are in `source` (your product name, like \"Grok\").".into());
    }
    let taken = store::list()
        .unwrap_or_default()
        .iter()
        .any(|a| review::same_name(&a.name, &name));
    if review::reserved_name(&name, chief) || taken {
        return Err(format!(
            "\"{name}\" can't be used as `source`: it's a name for the user or one of their agents here. Use your product name, like \"Grok\"."
        ));
    }
    Ok(name)
}

/// A message bound for the interview: text only, capped, never a credential.
pub fn clean_message(raw: &str) -> Result<String, String> {
    let text = review::clean_text(raw, MAX_CHARS + 1);
    if text.chars().count() > MAX_CHARS {
        return Err(format!(
            "That message is too long (max {MAX_CHARS} characters). Send one agent at a time."
        ));
    }
    if let Some(what) = looks_like_secret(&text) {
        return Err(format!(
            "That message looks like it contains {what}. Never send passwords, keys or tokens over this connector: the app asks the user for them itself, on a secure card. Send it again without it."
        ));
    }
    Ok(text)
}

/// What a credential in `text` looks like ("an API key"), if there is one.
/// The same shapes the composer warns about (`src/lib/agentSecrets.ts`),
/// plus private keys and `password: …`.
pub fn looks_like_secret(text: &str) -> Option<&'static str> {
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        return Some("a private key");
    }
    let word_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.';
    for token in text
        .split(|c: char| !word_char(c))
        .filter(|t| t.len() >= 16)
    {
        let body = |prefix: &str, min: usize, ok: fn(char) -> bool| {
            token
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.len() >= min && rest.chars().all(ok))
        };
        let alnum = |c: char| c.is_ascii_alphanumeric();
        let key = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
        let shapes = [
            body("sk_live_", 16, alnum)
                || body("sk_test_", 16, alnum)
                || body("rk_live_", 16, alnum),
            body("sk-ant-", 20, key),
            body("sk-proj-", 20, key) || body("sk-", 32, key),
            ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
                .iter()
                .any(|p| body(p, 30, alnum))
                || body("github_pat_", 22, key),
            token.len() == 20
                && token.starts_with("AKIA")
                && token[4..]
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
            ["xoxb-", "xoxp-", "xoxa-", "xoxo-", "xoxs-", "xoxr-"]
                .iter()
                .any(|p| body(p, 10, key)),
            body("AIza", 35, key),
            token.starts_with("eyJ")
                && token.split('.').count() == 3
                && token.split('.').all(|p| p.len() >= 10),
        ];
        if shapes.iter().any(|s| *s) {
            return Some("an API key or token");
        }
    }
    for marker in [
        "password:",
        "password=",
        "password is ",
        "passcode:",
        "pin:",
    ] {
        let mut from = 0;
        while let Some(at) = review::find_ascii(text, marker, from) {
            let after = &text[at + marker.len()..];
            let value: String = after
                .trim_start()
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            let value = value.trim_matches(|c: char| "\"'`.,;".contains(c));
            if value.len() >= 4 && !value.starts_with('[') && !value.starts_with('$') {
                return Some("a password");
            }
            from = at + marker.len();
        }
    }
    None
}

fn audit(source: &str, what: &str, ok: bool) {
    let detail = format!("{source}: {what}");
    #[cfg(test)]
    {
        let _ = ok;
        AUDITED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(detail);
    }
    #[cfg(not(test))]
    crate::remote_access::audit("import_conversation", None, detail, ok);
}

/// What tests would have written to the audit log (never the real one).
#[cfg(test)]
static AUDITED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/* ---------------------------------------------------------------- talk */

/// What one call came back with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    /// The interview answered; carry on.
    Replied,
    /// Still writing its answer when the wait ran out.
    Working,
    /// The user hasn't answered the consent card yet.
    WaitingOnUser,
    /// Every agent is staged; the user is reviewing them.
    InReview,
    /// The user imported.
    Done,
    /// The user dismissed the review.
    Declined,
    /// The user denied the import.
    Refused,
    /// The user stopped it.
    Stopped,
}

impl Status {
    fn keyword(self) -> &'static str {
        match self {
            Status::Replied => "replied",
            Status::Working => "working",
            Status::WaitingOnUser => "waiting_on_user",
            Status::InReview => "in_review",
            Status::Done => "done",
            Status::Declined => "declined",
            Status::Refused => "refused",
            Status::Stopped => "stopped",
        }
    }

    fn of(t: &Talk) -> Option<Status> {
        match t.state {
            TalkState::Imported => Some(Status::Done),
            TalkState::Declined => Some(Status::Declined),
            TalkState::Denied => Some(Status::Refused),
            TalkState::Stopped => Some(Status::Stopped),
            TalkState::Review if !t.busy => Some(Status::InReview),
            _ => None,
        }
    }
}

/// What a call does, decided under the lock; the app side carries it out.
#[derive(Debug, PartialEq)]
pub(crate) enum Admit {
    /// A new import: put up the consent card, hold the message.
    AskConsent { talk_id: String },
    /// Deliver this message to the interview.
    Deliver { talk_id: String, message: String },
    /// Nothing to send; wait for what's coming.
    Wait { talk_id: String },
}

/// Start or carry on an import with `message`, under the lock. `Err` is a
/// full answer for the assistant (`STATUS: …` and `NEXT: …`).
pub(crate) fn admit(
    source: &str,
    message: &str,
    chief: &store::Agent,
    now: i64,
) -> Result<Admit, String> {
    let mut state = lock();
    expire(&mut state, now);
    let live = state.talk.as_ref().filter(|t| t.state.live()).cloned();
    let Some(t) = live else {
        if let Some(ended) = state.talk.as_ref().filter(|_| !state.armed) {
            return Err(ended_answer(ended));
        }
        if !state.armed {
            return Err(
                "STATUS: not_started\n\nThe user hasn't started an import. Imports only begin from the app.\n\nNEXT: Tell the user to open Agents → Import agents on their computer, choose From another assistant, and press Start, then ask you again. Don't call import_conversation until they say they have.".into(),
            );
        }
        if message.is_empty() {
            return Err("STATUS: not_started\n\nThere's no import going yet.\n\nNEXT: Call import_conversation again with a message saying who you are and listing the agents you run for the user.".into());
        }
        // The arm is spent on this import, whatever comes of it.
        state.armed = false;
        let id = store::new_id();
        state.talk = Some(Talk {
            id: id.clone(),
            source: source.to_string(),
            chief_id: chief.id.clone(),
            state: TalkState::AwaitingConsent,
            started_at: now,
            last_at: now,
            exchanges: 1,
            staged: Vec::new(),
            imported: Vec::new(),
            busy: false,
            secret: super::broker::new_secret(),
            held: Some(message.to_string()),
            draft: Review::default(),
            outbox: Vec::new(),
            chars: message.chars().count(),
            session: Some(interview::Session::new(
                &id,
                chief
                    .model
                    .clone()
                    .filter(|_| chief.engine == super::engine::Engine::Claude),
            )),
            cancel: Arc::new(Notify::new()),
            consent_card: None,
            review_card: None,
            next_key: 0,
        });
        return Ok(Admit::AskConsent { talk_id: id });
    };
    let Some(talk) = state.talk.as_mut() else {
        return Err("STATUS: stopped\n\nThe import ended.\n\nNEXT: Tell the user it ended.".into());
    };
    if !t.source.eq_ignore_ascii_case(source) {
        return Err(format!(
            "STATUS: refused\n\nAn import from {} is already going; this connector carries one at a time.\n\nNEXT: Tell the user another import is in progress in the app.",
            t.source
        ));
    }
    if message.is_empty() {
        return Ok(Admit::Wait { talk_id: t.id });
    }
    match t.state {
        TalkState::AwaitingConsent => Err(format!(
            "STATUS: waiting_on_user\n\nThe user hasn't allowed the import yet. Your first message is held until they do; this one was NOT delivered.\n\nNEXT: Tell the user in one line to answer the card in their {}'s chat, then call import_conversation with no message to wait.",
            chief.name
        )),
        TalkState::Review => Err("STATUS: in_review\n\nEvery agent is staged and the user is reviewing them; this message was NOT delivered.\n\nNEXT: Tell the user their agents are waiting for review in the app, then call import_conversation with no message to hear what they imported.".into()),
        TalkState::Interviewing if talk.busy => Err(format!(
            "STATUS: working\n\n{} is still answering your previous message; this one was NOT delivered.\n\nNEXT: Call import_conversation with no message to wait for the answer, then send this again.",
            chief.name
        )),
        _ => {
            if talk.exchanges >= MAX_EXCHANGES || talk.chars + message.chars().count() > MAX_TOTAL_CHARS {
                return Err(format!(
                    "STATUS: limit\n\nThis import has reached its limit ({MAX_EXCHANGES} messages, {MAX_TOTAL_CHARS} characters). This message was NOT delivered.\n\nNEXT: Ask {} to finish with what's staged (send a message saying that's everything), or tell the user they can add the rest by asking their {} directly.",
                    chief.name, chief.name
                ));
            }
            talk.exchanges += 1;
            talk.chars += message.chars().count();
            talk.last_at = now;
            talk.busy = true;
            Ok(Admit::Deliver {
                talk_id: talk.id.clone(),
                message: message.to_string(),
            })
        }
    }
}

/// The answer once an import has ended and nothing is armed.
fn ended_answer(t: &Talk) -> String {
    let status = Status::of(t).unwrap_or(Status::Stopped);
    answer(status, t, "", &[])
}

/// The user answered the consent card. `Some(message)`: the held first
/// message, to deliver now.
pub(crate) fn consent_state(talk_id: &str, allow: bool, now: i64) -> Option<Option<String>> {
    let mut state = lock();
    let t = state
        .talk
        .as_mut()
        .filter(|t| t.id == talk_id && t.state == TalkState::AwaitingConsent)?;
    t.last_at = now;
    if allow {
        t.state = TalkState::Interviewing;
        t.busy = true;
        Some(t.held.take())
    } else {
        t.state = TalkState::Denied;
        t.held = None;
        state.armed = false;
        Some(None)
    }
}

/// The answer to one `import_conversation` call, words only.
pub(crate) fn answer(status: Status, talk: &Talk, chief: &str, replies: &[String]) -> String {
    let source = &talk.source;
    let chief = if chief.is_empty() {
        "the Chief of Staff"
    } else {
        chief
    };
    let mut out = format!("STATUS: {}", status.keyword());
    if !replies.is_empty() {
        out.push_str(&format!("\n\n{chief} says:\n\n{}", replies.join("\n\n")));
    }
    if !talk.staged.is_empty()
        && matches!(status, Status::Replied | Status::Working | Status::InReview)
    {
        out.push_str(&format!(
            "\n\nStaged for the user's review so far: {}. Nothing is created until they import.",
            talk.staged.join(", ")
        ));
    }
    let next = match status {
        Status::Replied => format!(
            "Answer {chief} by calling import_conversation again with your reply, from what you know about the user's agents. Send what it asks for in full (instructions word for word). Never include passwords, API keys, tokens or card numbers: the app asks the user for those. Keep going until STATUS is in_review."
        ),
        Status::Working => format!(
            "{chief} is still answering. Call import_conversation with no message to keep waiting. If this has gone on for a few minutes, tell the user in one line that the import is still going."
        ),
        Status::WaitingOnUser => format!(
            "The user hasn't allowed the import yet: a card in their {chief}'s chat asks them. Tell them in one line to answer it, then call import_conversation with no message to carry on."
        ),
        Status::InReview => "Every agent is staged. The user is reviewing them in the app and nothing is created until they press Import. Tell them that in one line, then call import_conversation with no message to hear what they imported.".to_string(),
        Status::Done => format!(
            "The user imported {}. Tell them they're in Agents on their computer, that routines arrive paused (to turn on once they're off with you) and logins are asked for there on secure cards. Don't call import_conversation again.",
            if talk.imported.is_empty() { "nothing".to_string() } else { talk.imported.join(", ") }
        ),
        Status::Declined => "The user looked at the agents and chose not to import them. Tell them it's cancelled and nothing came across. Don't try again unless they ask.".to_string(),
        Status::Refused => format!(
            "The user declined the import from {source}. Tell them it didn't happen. Don't try again unless they ask, and then only after they press Start in the app again."
        ),
        Status::Stopped => "The user stopped the import in the app. Tell them it stopped and nothing was created. Don't carry on unless they ask, and then only after they press Start again.".to_string(),
    };
    out.push_str(&format!("\n\nNEXT: {next}"));
    out
}

/// The interview's answer is in: the replies go to the outbox (and the chat).
/// `began`: Claude Code started the session, so later exchanges resume it,
/// even when this one failed (a timeout, an API error) after starting.
fn on_exchange(talk_id: &str, replies: &[String], failed: bool, began: bool) -> Option<Talk> {
    let mut state = lock();
    let t = state
        .talk
        .as_mut()
        .filter(|t| t.id == talk_id && t.state.live())?;
    t.busy = false;
    t.last_at = store::now_ms();
    if let Some(s) = t.session.as_mut() {
        if began || !failed {
            s.started = true;
        }
    }
    if failed {
        t.outbox.push(FAILED_REPLY.to_string());
    } else {
        t.outbox.extend(replies.iter().cloned());
    }
    Some(t.clone())
}

/// What the other assistant hasn't been given yet, handed over once.
fn take_replies(talk_id: &str) -> (Option<Talk>, Vec<String>) {
    let mut state = lock();
    match state.talk.as_mut().filter(|t| t.id == talk_id) {
        Some(t) => {
            let out = std::mem::take(&mut t.outbox);
            (Some(t.clone()), out)
        }
        None => (None, Vec::new()),
    }
}

/// One `import_conversation` call: deliver `message` (if any), wait up to
/// `wait`, and say what came back. `Err` is an in-band answer.
pub async fn converse(
    app: &AppHandle,
    source: &str,
    message: &str,
    wait: Duration,
) -> Result<String, String> {
    let chief = super::ensure_main().map_err(|e| e.to_string())?;
    let source = clean_source(source, &chief.name)?;
    let message = clean_message(message)?;
    let admitted = admit(&source, &message, &chief, store::now_ms())?;
    let talk_id = match admitted {
        Admit::AskConsent { talk_id } => {
            if interview::binary().await.is_none() {
                let _ = stop_state(store::now_ms());
                emit(app, None);
                return Err("STATUS: unavailable\n\nThis import needs Claude Code on the user's computer, and it isn't installed there.\n\nNEXT: Tell the user to install Claude Code, or to use Import agents → Paste a reply instead.".into());
            }
            ask_consent(app, &chief, &talk_id, &message);
            talk_id
        }
        Admit::Deliver { talk_id, message } => {
            deliver(app, &talk_id, &message);
            talk_id
        }
        Admit::Wait { talk_id } => talk_id,
    };

    // Wait for what the user or the interview does next.
    let deadline = tokio::time::Instant::now() + wait;
    let status = loop {
        let snapshot = lock().talk.clone().filter(|t| t.id == talk_id);
        let Some(t) = snapshot else {
            break Status::Stopped;
        };
        if let Some(s) = Status::of(&t) {
            break s;
        }
        let late = tokio::time::Instant::now() >= deadline;
        match t.state {
            TalkState::AwaitingConsent if late => break Status::WaitingOnUser,
            TalkState::Interviewing if !t.busy => break Status::Replied,
            TalkState::Interviewing | TalkState::Review if late => break Status::Working,
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    };
    let (talk, replies) = take_replies(&talk_id);
    let Some(talk) = talk else {
        return Err("STATUS: stopped\n\nThe import ended.\n\nNEXT: Tell the user it ended.".into());
    };
    Ok(answer(status, &talk, &chief.name, &replies))
}

/// The consent card, in the Chief's chat.
fn ask_consent(app: &AppHandle, chief: &store::Agent, talk_id: &str, first: &str) {
    let Some(source) = lock().talk.as_ref().map(|t| t.source.clone()) else {
        return;
    };
    let preview: String = first.chars().take(400).collect();
    let mut approval = super::mcp::new_card(
        store::new_id(),
        format!("{source} wants to bring its agents over"),
        format!(
            "It will talk to a separate, sealed conversation that can only stage agents for you to review. It can't see your chats, files or other agents, and nothing is created until you import.\n\nIts first message: “{}{}”",
            preview,
            if first.chars().count() > 400 { "…" } else { "" }
        ),
        None,
    );
    approval.connector = Some(ConnectorCard {
        kind: CardKind::Consent,
        talk_id: talk_id.to_string(),
        source: source.clone(),
        review: None,
    });
    let request_id = approval.request_id.clone();
    let mut card = runner::new_message(&chief.id, MessageKind::Approval, "");
    card.approval = Some(approval);
    if runner::record(app, card).is_ok() {
        if let Some(t) = lock().talk.as_mut().filter(|t| t.id == talk_id) {
            t.consent_card = Some(request_id);
        }
    }
    store::refresh_pending(&chief.id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    audit(&source, "asked to start an import", true);
    emit(app, Some(&chief.id));
}

/// The user answered a connector card (`commands::agents::answer_card`).
/// Consent: Allow starts the interview. Review: Deny dismisses it; Allow
/// is refused, because importing is only done from the Mac's card, where
/// each agent's instructions are on screen (the phone says "Review on your
/// Mac").
pub fn answer_card(
    app: &AppHandle,
    chief_id: &str,
    approval: &store::Approval,
    allow: bool,
) -> Result<(), CommandError> {
    let Some(card) = approval.connector.as_ref() else {
        return Ok(());
    };
    match card.kind {
        CardKind::Consent => {
            let status = if allow {
                ApprovalStatus::Allowed
            } else {
                ApprovalStatus::Denied
            };
            let Some(held) = consent_state(&card.talk_id, allow, store::now_ms()) else {
                if let Some(m) = store::set_approval_status(
                    chief_id,
                    &approval.request_id,
                    ApprovalStatus::Expired,
                )? {
                    let _ = app.emit(runner::EVENT_MESSAGE, &m);
                }
                return Err(CommandError::expected("That import has already ended."));
            };
            if let Some(m) = store::set_approval_status(chief_id, &approval.request_id, status)? {
                let _ = app.emit(runner::EVENT_MESSAGE, &m);
            }
            store::refresh_pending(chief_id);
            super::notify::refresh_badge(app);
            if allow {
                note(
                    app,
                    chief_id,
                    format!("{} is talking to a separate, sealed conversation, not this chat. Nothing is created until you review it. Stop it any time.", card.source),
                );
                audit(&card.source, "the user allowed the import", true);
                if let Some(first) = held {
                    deliver(app, &card.talk_id, &first);
                }
            } else {
                note(
                    app,
                    chief_id,
                    format!("You declined the import from {}.", card.source),
                );
                audit(&card.source, "the user declined the import", true);
            }
            emit(app, Some(chief_id));
            Ok(())
        }
        CardKind::Review if allow => Err(CommandError::expected(review::REVIEW_ON_MAC)),
        CardKind::Review => dismiss_review(app, chief_id, &approval.request_id, card),
    }
}

/// Import what the user kept on the review card.
pub fn apply_review(
    app: &AppHandle,
    chief_id: &str,
    request_id: &str,
    picks: &Picks,
) -> Result<review::Applied, CommandError> {
    let (card, applied, answered) = review::apply_card(Some(app), chief_id, request_id, picks)?;
    if let Some(m) = answered {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(chief_id);
    {
        let mut state = lock();
        if let Some(t) = state.talk.as_mut().filter(|t| t.id == card.talk_id) {
            t.state = TalkState::Imported;
            t.imported = applied.agents.clone();
            t.last_at = store::now_ms();
            if let Some(s) = &t.session {
                s.remove();
            }
        }
        state.armed = false;
    }
    let mut line = if applied.agents.is_empty() {
        format!("Nothing imported from {}.", card.source)
    } else {
        format!(
            "Imported from {}: {}. They start when you message them; routines are paused.",
            card.source,
            applied.agents.join(", ")
        )
    };
    if applied.chief_notes {
        line.push_str(&format!(" Added {}'s notes to your memory.", card.source));
    }
    for (name, why) in &applied.skipped {
        line.push_str(&format!(" {name} didn't come across: {why}"));
    }
    if !applied.routines_refused.is_empty() {
        line.push_str(&format!(
            " Routines not set: {}.",
            applied.routines_refused.join("; ")
        ));
    }
    note(app, chief_id, line);
    audit(&card.source, &applied_audit(&applied), true);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    super::tray::mark_used(app);
    emit(app, Some(chief_id));
    Ok(applied)
}

/// The audit line for an Import: what was made, what was replaced, and
/// whether the Chief's notes were added.
fn applied_audit(applied: &review::Applied) -> String {
    let mut line = format!(
        "imported {}",
        if applied.agents.is_empty() {
            "nothing".to_string()
        } else {
            applied.agents.join(", ")
        }
    );
    if !applied.replaced.is_empty() {
        line.push_str(&format!(" (replaced {})", applied.replaced.join(", ")));
    }
    if applied.chief_notes {
        line.push_str("; added notes to the Chief's memory");
    }
    line
}

fn dismiss_review(
    app: &AppHandle,
    chief_id: &str,
    request_id: &str,
    card: &ConnectorCard,
) -> Result<(), CommandError> {
    if let Some(m) = store::set_approval_status(chief_id, request_id, ApprovalStatus::Denied)? {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(chief_id);
    {
        let mut state = lock();
        if let Some(t) = state.talk.as_mut().filter(|t| t.id == card.talk_id) {
            t.state = TalkState::Declined;
            t.last_at = store::now_ms();
            if let Some(s) = &t.session {
                s.remove();
            }
        }
        state.armed = false;
    }
    note(
        app,
        chief_id,
        format!(
            "You didn't import the agents from {}. Nothing was created.",
            card.source
        ),
    );
    audit(&card.source, "the user dismissed the review", true);
    super::notify::refresh_badge(app);
    emit(app, Some(chief_id));
    Ok(())
}

/// The message `admit` let through, if its import is still the one going
/// and still waiting on it. A Stop (or anything else) between the two
/// drops the message here: nothing is shown and no `claude` starts.
fn claim_delivery(talk_id: &str) -> Option<Talk> {
    lock()
        .talk
        .clone()
        .filter(|t| t.id == talk_id && t.state == TalkState::Interviewing && t.busy)
}

/// Holds an exchange's "busy" until it reports. Dropped without reporting
/// (an early return, or a panic unwinding through it), it reports a failed
/// exchange, so an import is never left working forever, and the other
/// assistant gets the fixed sentence, never what went wrong.
struct Busy {
    talk_id: String,
    reported: bool,
}

impl Busy {
    fn new(talk_id: &str) -> Busy {
        Busy {
            talk_id: talk_id.to_string(),
            reported: false,
        }
    }

    /// Nothing to report: the import already ended.
    fn disarm(mut self) {
        self.reported = true;
    }

    fn report(mut self, replies: &[String], failed: bool, began: bool) -> Option<Talk> {
        self.reported = true;
        on_exchange(&self.talk_id, replies, failed, began)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        if !self.reported {
            on_exchange(&self.talk_id, &[], true, false);
        }
    }
}

/// Hand `message` to the interview: show it in the Chief's chat and run one
/// exchange in the sealed session.
fn deliver(app: &AppHandle, talk_id: &str, message: &str) {
    let busy = Busy::new(talk_id);
    let Some(t) = claim_delivery(talk_id) else {
        // Stopped meanwhile: nothing to report to.
        busy.disarm();
        return;
    };
    let mut line = runner::new_message(&t.chief_id, MessageKind::FromAgent, message.to_string());
    line.peer = Some(peer(&t.source));
    let _ = runner::record(app, line);
    emit(app, Some(&t.chief_id));
    let app = app.clone();
    let prompt = interview::envelope(&t.source, message);
    tauri::async_runtime::spawn(async move {
        let done = run_exchange(&app, &t, &prompt).await;
        let failed = match done.result {
            Ok(outcome) => {
                let replies = outcome.replies;
                if let Some(t) = busy.report(&replies, false, done.began) {
                    for reply in &replies {
                        let mut line = runner::new_message(
                            &t.chief_id,
                            MessageKind::SentToAgent,
                            reply.clone(),
                        );
                        line.peer = Some(peer(&t.source));
                        let _ = runner::record(&app, line);
                    }
                }
                None
            }
            Err(interview::Failed::Stopped) => {
                // Stop already ended the talk; the exchange may have made its
                // folder again after Stop removed it.
                if let Some(s) = &t.session {
                    s.remove();
                }
                busy.disarm();
                return;
            }
            Err(interview::Failed::Error(why)) => Some((why, busy)),
        };
        if let Some((why, busy)) = failed {
            if let Some(t) = busy.report(&[], true, done.began) {
                note(
                    &app,
                    &t.chief_id,
                    format!("The import interview didn't answer: {why}"),
                );
            }
        }
        emit(&app, Some(&t.chief_id));
    });
}

async fn run_exchange(app: &AppHandle, t: &Talk, prompt: &str) -> interview::Exchanged {
    let failed = |why: String| interview::Exchanged {
        began: false,
        result: Err(interview::Failed::Error(why)),
    };
    let Some(binary) = interview::binary().await else {
        return failed("Claude Code isn't installed.".into());
    };
    let (port, _) = match crate::agent_bridge::start_global_agent_bridge(app.clone()).await {
        Ok(bridge) => bridge,
        Err(e) => return failed(e.to_string()),
    };
    // The import's secret goes in a 0600 file, never on the command line;
    // the file goes when the exchange does.
    let config = interview::mcp_config(&super::reach::import_url(port), &t.secret);
    let config = match super::reach::write_config(&config) {
        Ok(file) => file,
        Err(e) => return failed(e.to_string()),
    };
    let chief = store::get(&t.chief_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| "Chief of Staff".into());
    let system = interview::system_prompt(&chief, &t.source);
    // The latest session state (started or not) lives on the talk.
    let Some(session) = lock()
        .talk
        .as_ref()
        .filter(|x| x.id == t.id)
        .and_then(|x| x.session.clone())
        .or_else(|| t.session.clone())
    else {
        return interview::Exchanged {
            began: false,
            result: Err(interview::Failed::Stopped),
        };
    };
    interview::exchange(
        &binary,
        &session,
        &config.arg(),
        &system,
        prompt,
        t.cancel.clone(),
    )
    .await
}

/* --------------------------------------------------- the interview's tools */

fn tool_defs() -> serde_json::Value {
    use serde_json::json;
    let routines = json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "when": { "type": "string", "description": "Plain words: \"every weekday at 9am\", \"every 2 hours\"." },
                "what": { "type": "string" }
            },
            "required": ["when", "what"]
        }
    });
    let logins = json!({
        "type": "array",
        "description": "Accounts, keys or logins it needs, by name only.",
        "items": {
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "snake_case, e.g. stripe_key." },
                "purpose": { "type": "string", "description": "What it's for, in one line." },
                "kind": { "type": "string", "enum": ["password", "api_key", "token", "other"] }
            },
            "required": ["name", "purpose", "kind"]
        }
    });
    json!({ "tools": [
        {
            "name": "propose_agent",
            "description": "Stage one of the other assistant's agents for the user to review. Nothing is created: the user reviews every staged agent and imports the ones they want. For the agent that manages the others set manages_others: what it knows is offered to the user as notes for you instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "role": { "type": "string", "description": "One line." },
                    "instructions": { "type": "string", "description": "Its full instructions, as the other assistant gave them." },
                    "memory": { "type": "string", "description": "What it knows about the user that it still needs, one fact per line." },
                    "manages_others": { "type": "boolean" },
                    "routines": routines,
                    "logins": logins
                },
                "required": ["name"]
            }
        },
        {
            "name": "update_proposal",
            "description": "Correct an agent you staged: name it, and give only the fields that change (they replace what was staged).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The staged agent's name." },
                    "new_name": { "type": "string" },
                    "role": { "type": "string" },
                    "instructions": { "type": "string" },
                    "memory": { "type": "string" },
                    "routines": routines,
                    "logins": logins
                },
                "required": ["name"]
            }
        },
        {
            "name": "finish",
            "description": "Every agent is staged: hand them to the user for review. Then tell the other assistant the user is reviewing them.",
            "inputSchema": {
                "type": "object",
                "properties": { "summary": { "type": "string", "description": "One paragraph: what was staged." } },
                "required": ["summary"]
            }
        }
    ]})
}

/// What a tool call asks the app side to do next.
#[derive(Debug, PartialEq)]
pub(crate) enum ToolEffect {
    None,
    /// Put the review card up.
    Review {
        talk_id: String,
    },
}

/// One of the interview's tool calls, on the draft. Pure on the talk state.
pub(crate) fn tool_call(
    secret: &str,
    name: &str,
    args: &serde_json::Value,
    chief: &str,
) -> Result<(String, ToolEffect), String> {
    let mut state = lock();
    let t = state
        .talk
        .as_mut()
        .filter(|t| !secret.is_empty() && t.secret == secret && t.state == TalkState::Interviewing)
        .ok_or("This import has ended.")?;
    match name {
        "propose_agent" => {
            let manages = args.get("manages_others").and_then(|v| v.as_bool()) == Some(true);
            t.next_key += 1;
            let p = review::proposal(format!("p{}", t.next_key), args, chief)?;
            if manages {
                let notes = [p.instructions.as_str(), p.memory.as_str()]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                t.draft.chief_notes = Some(notes);
                return Ok((
                    format!("Staged {}'s notes as an optional addition to yours, for the user to decide. Carry on with the next agent.", p.name),
                    ToolEffect::None,
                ));
            }
            if t.draft
                .proposals
                .iter()
                .any(|x| review::same_name(&x.name, &p.name))
            {
                return Err(format!(
                    "{} is already staged: use update_proposal to change it.",
                    p.name
                ));
            }
            if t.draft.proposals.len() >= review::MAX_PROPOSALS {
                return Err(format!(
                    "At most {} agents per import.",
                    review::MAX_PROPOSALS
                ));
            }
            let refused: Vec<String> = p
                .routines
                .iter()
                .filter_map(|r| {
                    r.refused
                        .as_ref()
                        .map(|why| format!("\"{}\" ({why})", r.when))
                })
                .collect();
            let name = p.name.clone();
            t.draft.proposals.push(p);
            t.staged.push(name.clone());
            let mut out = format!(
                "Staged {name} for the user's review. Nothing is created until they import."
            );
            if !refused.is_empty() {
                out.push_str(&format!(" These routine times can't be read: {}; ask for a plain time and use update_proposal.", refused.join(", ")));
            }
            Ok((out, ToolEffect::None))
        }
        "update_proposal" => {
            let target = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let i = t
                .draft
                .proposals
                .iter()
                .position(|x| review::same_name(&x.name, &target))
                .ok_or_else(|| format!("Nothing called {target} is staged."))?;
            let old = t.draft.proposals[i].clone();
            let mut merged = serde_json::json!({
                "name": old.name, "role": old.role, "instructions": old.instructions, "memory": old.memory,
                "routines": old.routines.iter().map(|r| serde_json::json!({"when": r.when, "what": r.what})).collect::<Vec<_>>(),
                "logins": old.logins.iter().map(|l| serde_json::json!({"name": l.name, "purpose": l.purpose, "kind": l.kind})).collect::<Vec<_>>(),
            });
            for k in ["role", "instructions", "memory", "routines", "logins"] {
                if let Some(v) = args.get(k) {
                    merged[k] = v.clone();
                }
            }
            if let Some(n) = args.get("new_name").and_then(|v| v.as_str()) {
                merged["name"] = serde_json::Value::String(n.to_string());
            }
            let p: Proposal = review::proposal(old.key.clone(), &merged, chief)?;
            if t.draft
                .proposals
                .iter()
                .enumerate()
                .any(|(j, x)| j != i && review::same_name(&x.name, &p.name))
            {
                return Err(format!("{} is already staged.", p.name));
            }
            t.staged[i] = p.name.clone();
            let name = p.name.clone();
            t.draft.proposals[i] = p;
            Ok((format!("Updated {name} in the draft."), ToolEffect::None))
        }
        "finish" => {
            if t.draft.proposals.is_empty() && t.draft.chief_notes.is_none() {
                return Err("Nothing is staged yet: propose each agent first.".into());
            }
            let summary = review::clean_text(
                args.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
                2_000,
            );
            t.draft.summary = Some(summary).filter(|s| !s.is_empty());
            t.state = TalkState::Review;
            Ok((
                format!("Handed {} to the user for review. Now tell {} in one short message that the user is reviewing them and nothing is created until they import.", if t.staged.is_empty() { "the notes".to_string() } else { t.staged.join(", ") }, t.source),
                ToolEffect::Review { talk_id: t.id.clone() },
            ))
        }
        other => Err(format!("{other} isn't available in this interview.")),
    }
}

/// The review card, in the Chief's chat.
fn post_review(app: &AppHandle, talk_id: &str) {
    let Some(t) = lock().talk.clone().filter(|t| t.id == talk_id) else {
        return;
    };
    let review = review::with_clashes(t.draft.clone());
    let count = review.proposals.len();
    let mut approval = super::mcp::new_card(
        store::new_id(),
        format!(
            "Bring in {} from {}",
            if count == 1 {
                "1 agent".to_string()
            } else {
                format!("{count} agents")
            },
            t.source
        ),
        review::detail(&review),
        None,
    );
    approval.connector = Some(ConnectorCard {
        kind: CardKind::Review,
        talk_id: t.id.clone(),
        source: t.source.clone(),
        review: Some(review),
    });
    let request_id = approval.request_id.clone();
    let mut card = runner::new_message(&t.chief_id, MessageKind::Approval, "");
    card.approval = Some(approval);
    if runner::record(app, card).is_ok() {
        if let Some(t) = lock().talk.as_mut().filter(|t| t.id == talk_id) {
            t.review_card = Some(request_id);
        }
    }
    store::refresh_pending(&t.chief_id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    audit(
        &t.source,
        &format!("staged {} for review", t.staged.join(", ")),
        true,
    );
    emit(app, Some(&t.chief_id));
}

/// The interview's MCP endpoint (`/mcp/import`, with the import's secret as
/// its bearer; `reach`).
pub async fn handle_rpc(
    app: &AppHandle,
    secret: &str,
    message: &serde_json::Value,
) -> serde_json::Value {
    use serde_json::json;
    let id = message
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let ok = |result: serde_json::Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let live = lock()
        .talk
        .as_ref()
        .is_some_and(|t| !secret.is_empty() && t.secret == secret && t.state.live());
    if !live {
        return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": "This import has ended." } });
    }
    match method {
        "initialize" => ok(super::mcp::initialize_result(message.get("params"))),
        "ping" => ok(json!({})),
        "tools/list" => ok(tool_defs()),
        "tools/call" => {
            let params = message.get("params");
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let args = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let chief = super::ensure_main().map(|c| c.name).unwrap_or_default();
            let reply = |text: String, error: bool| {
                ok(json!({ "content": [{ "type": "text", "text": text }], "isError": error }))
            };
            match tool_call(secret, name, &args, &chief) {
                Ok((text, effect)) => {
                    if let ToolEffect::Review { talk_id } = &effect {
                        post_review(app, talk_id);
                    } else {
                        emit(app, None);
                    }
                    reply(text, false)
                }
                Err(e) => reply(e, true),
            }
        }
        _ => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })
        }
    }
}

/* ------------------------------------------------------ one-shot imports */

/// The older `import_agents` tool: the whole setup in one call. It goes
/// through the same gate (armed, once) and straight to the same review
/// card; nothing is created until the user imports.
pub fn stage_one_shot(
    app: &AppHandle,
    source: &str,
    agents: &[serde_json::Value],
) -> Result<String, String> {
    let chief = super::ensure_main().map_err(|e| e.to_string())?;
    let source = clean_source(source, &chief.name)?;
    let talk_id = stage_one_shot_state(&source, agents, &chief, store::now_ms())?;
    post_review(app, &talk_id);
    let t = lock().talk.clone().filter(|t| t.id == talk_id);
    Ok(match t {
        Some(t) => answer(Status::InReview, &t, &chief.name, &[]),
        None => "STATUS: stopped".into(),
    })
}

pub(crate) fn stage_one_shot_state(
    source: &str,
    agents: &[serde_json::Value],
    chief: &store::Agent,
    now: i64,
) -> Result<String, String> {
    let mut state = lock();
    expire(&mut state, now);
    if state.talk.as_ref().is_some_and(|t| t.state.live()) {
        return Err(
            "STATUS: refused\n\nAn import is already going in the app.\n\nNEXT: Tell the user."
                .into(),
        );
    }
    if !state.armed {
        return Err("STATUS: not_started\n\nImports only begin from the app.\n\nNEXT: Tell the user to open Agents → Import agents, choose From another assistant and press Start, then ask you again.".into());
    }
    let mut draft = Review::default();
    let mut errors = Vec::new();
    for (i, a) in agents.iter().take(review::MAX_PROPOSALS).enumerate() {
        let manages = a.get("is_main").and_then(|v| v.as_bool()) == Some(true);
        match review::proposal(format!("p{}", i + 1), a, &chief.name) {
            Ok(p) if manages => {
                draft.chief_notes = Some(
                    [p.instructions, p.memory]
                        .into_iter()
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                )
            }
            Ok(p)
                if draft
                    .proposals
                    .iter()
                    .any(|x| review::same_name(&x.name, &p.name)) =>
            {
                errors.push(format!("{}: sent twice", p.name))
            }
            Ok(p) => draft.proposals.push(p),
            Err(e) => errors.push(e),
        }
    }
    if !errors.is_empty() {
        return Err(format!("Nothing was staged: {}", errors.join("; ")));
    }
    if draft.proposals.is_empty() && draft.chief_notes.is_none() {
        return Err("Nothing was staged: the list was empty.".into());
    }
    state.armed = false;
    let id = store::new_id();
    state.talk = Some(Talk {
        id: id.clone(),
        source: source.to_string(),
        chief_id: chief.id.clone(),
        state: TalkState::Review,
        started_at: now,
        last_at: now,
        exchanges: 1,
        staged: draft.proposals.iter().map(|p| p.name.clone()).collect(),
        imported: Vec::new(),
        busy: false,
        secret: String::new(),
        held: None,
        draft,
        outbox: Vec::new(),
        chars: 0,
        session: None,
        cancel: Arc::new(Notify::new()),
        consent_card: None,
        review_card: None,
        next_key: 0,
    });
    Ok(id)
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    let mut state = lock();
    state.armed = false;
    state.talk = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chief() -> store::Agent {
        serde_json::from_value(json!({
            "id": "chief", "name": "Chief of Staff", "shape": 0, "color": "white",
            "isMain": true, "createdAt": 1
        }))
        .unwrap()
    }

    fn secret() -> String {
        lock().talk.as_ref().unwrap().secret.clone()
    }

    /// Armed, asked, allowed: the interview is going.
    fn interviewing() -> String {
        reset_for_tests();
        arm_state().unwrap();
        let Admit::AskConsent { talk_id } =
            admit("Grok", "Hi, I run 3 agents.", &chief(), 1_000).unwrap()
        else {
            panic!("asks first");
        };
        assert_eq!(
            consent_state(&talk_id, true, 1_100),
            Some(Some("Hi, I run 3 agents.".into()))
        );
        on_exchange(&talk_id, &["Which agents?".into()], false, true);
        talk_id
    }

    #[test]
    fn nothing_answers_until_the_user_starts_and_then_allows_it() {
        let _serial = store::tests_lock();
        reset_for_tests();
        // Not armed: refused, with what to tell the user.
        let err = admit("Grok", "hello", &chief(), 1_000).unwrap_err();
        assert!(err.starts_with("STATUS: not_started"), "{err}");
        assert!(err.contains("press Start"), "{err}");
        // Armed: the first message asks, and is held rather than delivered.
        arm_state().unwrap();
        let Admit::AskConsent { talk_id } = admit("Grok", "hello", &chief(), 1_000).unwrap() else {
            panic!("asks");
        };
        assert!(!lock().armed, "the arm is spent on this import");
        let t = current().unwrap();
        assert_eq!(t.state, TalkState::AwaitingConsent);
        // A second message while it waits isn't delivered either.
        let err = admit("Grok", "more", &chief(), 1_200).unwrap_err();
        assert!(
            err.starts_with("STATUS: waiting_on_user") && err.contains("NOT delivered"),
            "{err}"
        );
        // Waiting is fine.
        assert_eq!(
            admit("Grok", "", &chief(), 1_300).unwrap(),
            Admit::Wait {
                talk_id: talk_id.clone()
            }
        );
        // Another assistant can't cut in.
        assert!(admit("Other", "hi", &chief(), 1_300)
            .unwrap_err()
            .starts_with("STATUS: refused"));
        // Denied: over, and it can't start again without Start.
        assert_eq!(consent_state(&talk_id, false, 1_400), Some(None));
        let err = admit("Grok", "please", &chief(), 1_500).unwrap_err();
        assert!(err.starts_with("STATUS: refused"), "{err}");
        assert!(err.contains("press Start"), "{err}");
        // No time-based re-enable: much later, still refused.
        let err = admit("Grok", "please", &chief(), 1_500 + 24 * 3600 * 1000).unwrap_err();
        assert!(!err.contains("STATUS: waiting_on_user"), "{err}");
        assert!(
            consent_state(&talk_id, true, 1_600).is_none(),
            "a late Allow does nothing"
        );
        // Start again: a new import, asked again.
        arm_state().unwrap();
        assert!(matches!(
            admit("Grok", "again", &chief(), 2_000).unwrap(),
            Admit::AskConsent { .. }
        ));
        reset_for_tests();
    }

    #[test]
    fn hidden_characters_and_borrowed_names_are_refused_as_source() {
        assert_eq!(
            clean_source("  Gr\u{200B}ok\u{202E} ", "Morgan").unwrap(),
            "Grok"
        );
        for bad in ["You", "user", "Chief of Staff", "Morgan", ""] {
            assert!(clean_source(bad, "Morgan").is_err(), "{bad}");
        }
        assert_eq!(
            clean_message("hi\u{1b}[31m\u{2066} there").unwrap(),
            "hi[31m there"
        );
    }

    #[test]
    fn messages_wait_their_turn_and_the_caps_hold() {
        let _serial = store::tests_lock();
        let talk_id = interviewing();
        // Delivered once; while the interview answers, the next isn't.
        assert!(matches!(
            admit("Grok", "Finance: …", &chief(), 2_000).unwrap(),
            Admit::Deliver { .. }
        ));
        let err = admit("Grok", "Travel: …", &chief(), 2_100).unwrap_err();
        assert!(
            err.starts_with("STATUS: working") && err.contains("NOT delivered"),
            "{err}"
        );
        on_exchange(&talk_id, &["Thanks.".into()], false, true);
        // The cap.
        lock().talk.as_mut().unwrap().exchanges = MAX_EXCHANGES;
        let err = admit("Grok", "again", &chief(), 3_000).unwrap_err();
        assert!(err.starts_with("STATUS: limit"), "{err}");
        lock().talk.as_mut().unwrap().exchanges = 2;
        lock().talk.as_mut().unwrap().chars = MAX_TOTAL_CHARS;
        assert!(admit("Grok", "x", &chief(), 3_000)
            .unwrap_err()
            .starts_with("STATUS: limit"));
        reset_for_tests();
    }

    #[test]
    fn the_assistant_only_hears_what_the_interview_wrote() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let talk_id = interviewing();
        let real = super::super::ensure_main().unwrap();
        // The user chats with the Chief meanwhile, and the Chief answers them.
        for (kind, text) in [
            (MessageKind::User, "What's my bank PIN again?"),
            (MessageKind::Agent, "It's in your notes: 4417."),
            (MessageKind::Error, "claude exited: /Users/me/secret/path"),
        ] {
            store::append_message(&runner::new_message(&real.id, kind, text)).unwrap();
        }
        let (_, replies) = take_replies(&talk_id);
        assert_eq!(replies, vec!["Which agents?".to_string()]);
        // Handed over once.
        assert!(take_replies(&talk_id).1.is_empty());
        // A failure on our side reaches the assistant as a fixed sentence.
        on_exchange(&talk_id, &[], true, true);
        let (t, replies) = take_replies(&talk_id);
        assert_eq!(replies, vec![FAILED_REPLY.to_string()]);
        let text = answer(Status::Replied, &t.unwrap(), "Chief of Staff", &replies);
        assert!(
            !text.contains("4417") && !text.contains("/Users/me"),
            "{text}"
        );
        reset_for_tests();
        store::set_root_for_tests(None);
    }

    #[test]
    fn the_interview_only_stages_and_nothing_exists_until_import() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let chief = super::super::ensure_main().unwrap();
        let before = store::list().unwrap().len();
        interviewing();
        let s = secret();
        let (text, effect) = tool_call(&s, "propose_agent", &json!({
            "name": "Finance", "role": "Money", "instructions": "Log expenses.",
            "routines": [{"when": "every weekday at 9am", "what": "Check invoices"}],
            "logins": [{"name": "bank_login", "purpose": "Reads statements", "kind": "password"}]
        }), &chief.name).unwrap();
        assert!(
            text.contains("Staged Finance") && effect == ToolEffect::None,
            "{text}"
        );
        tool_call(
            &s,
            "propose_agent",
            &json!({"name": "Ops", "manages_others": true, "memory": "- Prefers mornings"}),
            &chief.name,
        )
        .unwrap();
        // Tools other than the three don't exist here.
        for other in ["create_agent", "message_agent", "approve", "project_list"] {
            assert!(
                tool_call(&s, other, &json!({}), &chief.name).is_err(),
                "{other}"
            );
        }
        // A stale or guessed secret reaches nothing.
        assert!(tool_call("nope", "propose_agent", &json!({"name": "X"}), &chief.name).is_err());
        tool_call(
            &s,
            "update_proposal",
            &json!({"name": "Finance", "role": "Bookkeeping"}),
            &chief.name,
        )
        .unwrap();
        let (_, effect) =
            tool_call(&s, "finish", &json!({"summary": "One agent."}), &chief.name).unwrap();
        assert!(matches!(effect, ToolEffect::Review { .. }));
        assert_eq!(
            store::list().unwrap().len(),
            before,
            "staging creates nothing"
        );
        assert!(
            tool_call(&s, "propose_agent", &json!({"name": "Late"}), &chief.name).is_err(),
            "closed once in review"
        );
        let draft = lock().talk.as_ref().unwrap().draft.clone();
        assert_eq!(draft.proposals.len(), 1);
        assert_eq!(draft.proposals[0].role, "Bookkeeping");
        assert_eq!(draft.chief_notes.as_deref(), Some("- Prefers mornings"));
        reset_for_tests();
        store::set_root_for_tests(None);
    }

    #[test]
    fn importing_never_overwrites_and_brings_no_grants() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let chief = super::super::ensure_main().unwrap();
        let mine = store::create(store::NewAgent {
            name: "Finance".into(),
            role: "Mine".into(),
            instructions: "My own rules.".into(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let chief_md =
            std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md"))
                .unwrap();
        let review = review::with_clashes(Review {
            proposals: vec![
                review::proposal(
                    "p1".into(),
                    &json!({"name": "Finance", "instructions": "Grok's rules.",
                    "routines": [{"when": "every weekday at 9am", "what": "Check invoices"}]}),
                    &chief.name,
                )
                .unwrap(),
                review::proposal(
                    "p2".into(),
                    &json!({"name": "Travel", "instructions": "Book trips."}),
                    &chief.name,
                )
                .unwrap(),
            ],
            chief_notes: Some("- Likes tea".into()),
            summary: None,
        });
        assert!(review.proposals[0].clash.is_some() && review.proposals[1].clash.is_none());
        let card = ConnectorCard {
            kind: CardKind::Review,
            talk_id: "t".into(),
            source: "Grok".into(),
            review: Some(review),
        };
        // Both kept, nothing replaced, no notes: a taken name comes in as a copy.
        let keep = |key: &str| review::Pick {
            key: key.into(),
            ..Default::default()
        };
        let both = Picks {
            agents: vec![keep("p1"), keep("p2")],
            chief_notes: false,
        };
        let applied = review::apply(None, &chief, &card, &both).unwrap();
        assert_eq!(
            applied.agents,
            vec!["Finance (from Grok)".to_string(), "Travel".to_string()]
        );
        assert_eq!(store::read_instructions(&mine.id).unwrap(), "My own rules.");
        let copy = store::find("Finance (from Grok)").unwrap().unwrap();
        assert!(copy.permissions.is_empty() && copy.project.is_none());
        assert!(
            copy.check_ins
                .iter()
                .all(|c| c.paused && c.paused_on_import),
            "routines arrive paused"
        );
        // The Chief is untouched without the user ticking its notes.
        let after =
            std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md"))
                .unwrap();
        assert_eq!(after, chief_md);
        // Replace only when chosen, and it drops the old grants.
        let rules: Vec<super::super::permissions::Rule> = serde_json::from_value(json!([
            {"id": "r", "kind": "command_prefix", "value": "npm test", "label": "npm test", "createdAt": 1}
        ])).unwrap();
        store::update(&mine.id, |a| a.permissions = rules).unwrap();
        assert_eq!(store::get(&mine.id).unwrap().permissions.len(), 1);
        // The card showed Finance before it had that rule: Replace refuses,
        // and nothing is made, until the user has seen it as it is now.
        let stale = card.review.as_ref().unwrap().proposals[0].clash.clone();
        let mut picks = Picks {
            agents: vec![review::Pick {
                key: "p1".into(),
                replace: true,
                keep_logins: false,
                seen: stale,
            }],
            chief_notes: true,
        };
        let agents_before = store::list().unwrap().len();
        let err = review::apply(None, &chief, &card, &picks).unwrap_err();
        assert!(err.to_string().contains("changed since"), "{err}");
        assert_eq!(store::list().unwrap().len(), agents_before);
        assert_eq!(store::read_instructions(&mine.id).unwrap(), "My own rules.");
        let now = review::with_clashes(card.review.clone().unwrap());
        picks.agents[0].seen = now.proposals[0].clash.clone();
        let applied = review::apply(None, &chief, &card, &picks).unwrap();
        assert_eq!(applied.replaced, vec!["Finance".to_string()]);
        assert_eq!(store::read_instructions(&mine.id).unwrap(), "Grok's rules.");
        assert!(store::get(&mine.id).unwrap().permissions.is_empty());
        let after =
            std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md"))
                .unwrap();
        assert!(
            after.contains("- Likes tea"),
            "added only because the user ticked it"
        );
        store::set_root_for_tests(None);
    }

    #[test]
    fn stop_ends_it_drops_only_the_assistants_messages_and_disarms() {
        let _serial = store::tests_lock();
        let talk_id = interviewing();
        assert!(matches!(
            admit("Grok", "Finance: …", &chief(), 2_000).unwrap(),
            Admit::Deliver { .. }
        ));
        let cancel = lock().talk.as_ref().unwrap().cancel.clone();
        let woken = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop_state(3_000).talk.unwrap();
        assert_eq!(stopped.state, TalkState::Stopped);
        assert!(!lock().armed);
        // The running exchange is told to stop.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            let w = woken.clone();
            tokio::select! {
                _ = cancel.notified() => w.store(true, std::sync::atomic::Ordering::SeqCst),
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        });
        assert!(
            woken.load(std::sync::atomic::Ordering::SeqCst),
            "the interview's exchange is cancelled"
        );
        // Its late answer goes nowhere.
        assert!(on_exchange(&talk_id, &["late".into()], false, true).is_none());
        assert!(take_replies(&talk_id).1.is_empty());
        // Stopped stays stopped, whenever it asks.
        for at in [4_000, 4_000 + 24 * 3600 * 1000] {
            let err = admit("Grok", "carry on", &chief(), at).unwrap_err();
            assert!(err.starts_with("STATUS: stopped"), "{err}");
        }
        assert!(interview_status("chief").is_none());
        reset_for_tests();
    }

    #[test]
    fn the_chief_shows_as_talking_only_while_the_interview_runs() {
        let _serial = store::tests_lock();
        reset_for_tests();
        assert!(interview_status("chief").is_none());
        interviewing();
        let s = interview_status("chief").unwrap();
        assert_eq!(s.state, "working");
        assert_eq!(s.activity.as_deref(), Some("Bringing in agents from Grok"));
        assert!(interview_status("someone-else").is_none());
        reset_for_tests();
    }

    #[test]
    fn the_one_shot_tool_stages_through_the_same_gate() {
        let _serial = store::tests_lock();
        reset_for_tests();
        let agents = vec![
            json!({"name": "Finance"}),
            json!({"name": "Ops", "is_main": true, "memory": "- x"}),
        ];
        assert!(stage_one_shot_state("Grok", &agents, &chief(), 1)
            .unwrap_err()
            .starts_with("STATUS: not_started"));
        arm_state().unwrap();
        stage_one_shot_state("Grok", &agents, &chief(), 1).unwrap();
        let t = current().unwrap();
        assert_eq!(t.state, TalkState::Review);
        assert_eq!(t.staged, vec!["Finance".to_string()]);
        assert!(!lock().armed);
        reset_for_tests();
    }

    #[test]
    fn every_answer_tells_the_assistant_what_to_do_next() {
        let _serial = store::tests_lock();
        interviewing();
        let t = current().unwrap();
        for status in [
            Status::Replied,
            Status::Working,
            Status::WaitingOnUser,
            Status::InReview,
            Status::Done,
            Status::Declined,
            Status::Refused,
            Status::Stopped,
        ] {
            let text = answer(status, &t, "Chief of Staff", &[]);
            assert!(text.starts_with(&format!("STATUS: {}", status.keyword())));
            assert!(text.contains("\n\nNEXT: "), "{text}");
        }
        let replied = answer(
            Status::Replied,
            &t,
            "Chief of Staff",
            &["Which agents?".into()],
        );
        assert!(replied.contains("Chief of Staff says:\n\nWhich agents?"));
        reset_for_tests();
    }

    #[test]
    fn a_failed_first_exchange_that_started_its_session_resumes_it_next() {
        let _serial = store::tests_lock();
        let talk_id = interviewing();
        let started = || {
            lock()
                .talk
                .as_ref()
                .and_then(|t| t.session.as_ref())
                .is_some_and(|s| s.started)
        };
        // `interviewing` answered once: start over with a talk that hasn't.
        lock()
            .talk
            .as_mut()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .started = false;
        // Failed before Claude Code started: the id is still free.
        assert!(matches!(
            admit("Grok", "one", &chief(), 2_000).unwrap(),
            Admit::Deliver { .. }
        ));
        on_exchange(&talk_id, &[], true, false);
        assert!(!started());
        // Failed after it started (a timeout, an API error): resume from now on.
        assert!(matches!(
            admit("Grok", "two", &chief(), 3_000).unwrap(),
            Admit::Deliver { .. }
        ));
        on_exchange(&talk_id, &[], true, true);
        assert!(started());
        let session = lock().talk.as_ref().unwrap().session.clone().unwrap();
        let args = interview::args(&session, "u", "p");
        assert!(args.iter().any(|a| a == "--resume"), "{args:?}");
        assert!(!lock().talk.as_ref().unwrap().busy, "never left working");
        reset_for_tests();
    }

    #[test]
    fn a_stop_between_admit_and_delivery_drops_the_message() {
        let _serial = store::tests_lock();
        let talk_id = interviewing();
        assert!(matches!(
            admit("Grok", "Finance: …", &chief(), 2_000).unwrap(),
            Admit::Deliver { .. }
        ));
        assert!(
            claim_delivery(&talk_id).is_some(),
            "delivered when nothing intervened"
        );
        stop_state(2_100);
        assert!(
            claim_delivery(&talk_id).is_none(),
            "dropped: no claude starts"
        );
        reset_for_tests();
    }

    #[test]
    fn a_panic_mid_delivery_never_leaves_the_import_working() {
        let _serial = store::tests_lock();
        let talk_id = interviewing();
        take_replies(&talk_id);
        assert!(matches!(
            admit("Grok", "Finance: …", &chief(), 2_000).unwrap(),
            Admit::Deliver { .. }
        ));
        assert!(lock().talk.as_ref().unwrap().busy);
        let id = talk_id.clone();
        let caught = std::panic::catch_unwind(move || {
            let _busy = Busy::new(&id);
            panic!("something broke");
        });
        assert!(caught.is_err());
        let t = lock().talk.clone().unwrap();
        assert!(!t.busy, "not working forever");
        assert_eq!(take_replies(&talk_id).1, vec![FAILED_REPLY.to_string()]);
        reset_for_tests();
    }

    #[test]
    fn going_quiet_ends_it_in_the_audit_log_too() {
        let _serial = store::tests_lock();
        interviewing();
        AUDITED.lock().unwrap().clear();
        let last = lock().talk.as_ref().unwrap().last_at;
        expire(&mut lock(), last + IDLE_MS + 1);
        assert_eq!(lock().talk.as_ref().unwrap().state, TalkState::Stopped);
        let audited = AUDITED.lock().unwrap().clone();
        assert_eq!(
            audited,
            vec!["Grok: ended: no message for 30 minutes".to_string()]
        );
        // Only once.
        expire(&mut lock(), last + 2 * IDLE_MS);
        assert_eq!(AUDITED.lock().unwrap().len(), 1);
        reset_for_tests();
    }

    #[test]
    fn the_audit_says_when_the_chiefs_notes_were_added() {
        let mut applied = review::Applied {
            agents: vec!["Finance".into()],
            replaced: vec!["Finance".into()],
            ..Default::default()
        };
        assert_eq!(
            applied_audit(&applied),
            "imported Finance (replaced Finance)"
        );
        applied.chief_notes = true;
        assert_eq!(
            applied_audit(&applied),
            "imported Finance (replaced Finance); added notes to the Chief's memory"
        );
        applied.agents.clear();
        applied.replaced.clear();
        assert_eq!(
            applied_audit(&applied),
            "imported nothing; added notes to the Chief's memory"
        );
    }

    #[test]
    fn a_lookalike_of_an_agent_or_the_chief_is_refused_as_source() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        store::create(store::NewAgent {
            name: "Site".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        assert!(clean_source("\u{0405}ite", "Morgan").is_err());
        assert!(clean_source("Chief \u{043E}f Staff", "Morgan").is_err());
        assert!(clean_source("Grok", "Morgan").is_ok());
        store::set_root_for_tests(None);
    }
}
