//! Carry on with the other engine when every account of an agent's own is
//! out of usage: Claude Code to Codex, and back again.
//!
//! The wallet (`agents::wallet`) moves a turn between accounts of the *same*
//! engine. When every account an agent may use is out, this module decides
//! whether its turns carry on with the other engine, if that one is signed
//! in and has room:
//!
//! - **The user's choice, per engine** ([`Mode`], `crossover.json` beside the
//!   wallet): Ask first (the default), Carry on, or Wait for the reset. Ask
//!   first puts one card in the agent's chat the first time it would happen
//!   ("All your Claude Code accounts are out until 4:00 PM. Carry on with
//!   Codex until then?"): **Always** sets Carry on, **Just this time** covers
//!   this outage only (until its own engine has room again), **Wait** leaves
//!   the turn on its usage-limit line. One card per engine at a time.
//! - **Never for an agent set to one account** ("Runs on"), never for the
//!   app's own tidy turn, and never silently: the chat gets one quiet line,
//!   "Carried on with Codex (Claude Code is out until 4:00 PM).", plus what
//!   doesn't come along (Claude in Chrome, claude.ai connectors).
//! - **The conversation.** Engines can't open each other's sessions, so the
//!   first turn on the other engine starts a new one there with the app's
//!   own recap: the visible conversation, what is still open, and the same
//!   instructions and memory (the agent's CLAUDE.md is Codex's project doc,
//!   and `AGENTS.md` in its home is a link to it, [`sync_instructions`]). The
//!   agent's own session is kept as it was ([`Away`] holds the other one), so
//!   when its engine has room again the next turn resumes it, told what was
//!   said meanwhile ([`back_header`]), with one line, "Back on Claude Code".
//! - **Never twice.** A try that already ran a tool before its accounts ran
//!   out doesn't carry on in a fresh session: it could do the work again
//!   ([`held_line`]); the next message does.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::engine::Engine;
use crate::errors::CommandError;

/// What happens when every account of an engine is out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Ask once, with a card, the first time it would happen.
    #[default]
    Ask,
    /// Carry on with the other engine until this one has room again.
    Carry,
    /// Wait for the reset.
    Wait,
}

impl Mode {
    pub fn parse(value: &str) -> Result<Mode, CommandError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ask" => Ok(Mode::Ask),
            "carry" | "carry_on" => Ok(Mode::Carry),
            "wait" => Ok(Mode::Wait),
            _ => Err(CommandError::expected(
                "Choose ask, carry or wait.".to_string(),
            )),
        }
    }
}

/// The other engine. OpenCode has no plan to run out of, so it has none
/// (itself): carrying on is only between Claude Code and Codex.
pub fn other(engine: Engine) -> Engine {
    match engine {
        Engine::Claude => Engine::Codex,
        Engine::Codex => Engine::Claude,
        Engine::OpenCode => Engine::OpenCode,
    }
}

fn word(engine: Engine) -> &'static str {
    engine.word()
}

/* -------------------------------------------------------------- the agent */

/// On an agent: its turns carry on with another engine while every account
/// of its own is out. Its own session (`Agent::session_id`) is left as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Away {
    /// The engine its turns run on meanwhile.
    pub engine: Engine,
    /// Its conversation there, once that engine said it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// When it moved (the return recap starts here), epoch ms.
    pub since: i64,
    /// When its own engine said it is back, if it said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    /// Started fresh there: the next turn gets no recap.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fresh: bool,
}

/// The engine and session a turn of `agent` on `on` resumes.
pub fn session_on(agent: &super::store::Agent, on: Engine) -> Option<String> {
    if on == agent.engine {
        return agent.session_id.clone();
    }
    agent
        .away
        .as_ref()
        .filter(|a| a.engine == on)
        .and_then(|a| a.session_id.clone())
}

/// Where a confirmed session is kept: the agent's own, or its away one.
pub fn save_session(agent: &mut super::store::Agent, on: Engine, session: String) {
    if on == agent.engine {
        agent.session_id = Some(session);
        agent.new_engine = false;
    } else if let Some(away) = agent.away.as_mut().filter(|a| a.engine == on) {
        away.session_id = Some(session);
        away.fresh = false;
    }
}

/// A session the engine couldn't find, dropped from where it was kept.
pub fn drop_session(agent: &mut super::store::Agent, on: Engine) {
    if on == agent.engine {
        agent.session_id = None;
        agent.context = None;
    } else if let Some(away) = agent.away.as_mut().filter(|a| a.engine == on) {
        away.session_id = None;
    }
}

/// What a turn on `on` sees of `agent`: for its own engine, itself; for the
/// other, the same agent as it would be there (no session of its own engine,
/// no model or effort of it, no account pin, which can't cross anyway).
pub fn as_on(mut agent: super::store::Agent, on: Engine) -> super::store::Agent {
    if on == agent.engine {
        return agent;
    }
    agent.session_id = session_on(&agent, on);
    agent.engine = on;
    agent.account = None;
    agent.model = None;
    agent.routine_model = None;
    agent.effort = None;
    agent.new_engine = false;
    agent.context = None;
    agent
}

/* ------------------------------------------------------------- deciding */

/// Everything a route depends on, read by the caller.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Situation {
    /// Set to run on one account ("Runs on").
    pub pinned: bool,
    /// The app's own turn (`tidy`).
    pub quiet: bool,
    /// Carrying on with the other engine already.
    pub away: bool,
    /// One of its own engine's accounts it may use is signed in and not out.
    pub home_room: bool,
    /// The other engine is signed in on an account that isn't out.
    pub other_room: bool,
    pub mode: Mode,
    /// "Just this time", for the outage in progress.
    pub once: bool,
    /// A card asking already is open, for this engine.
    pub asking: bool,
    /// This turn already did part of its work (a tool ran), or it is a
    /// pick-up of a turn cut off: a new session could do it again.
    pub acted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Its own engine, as always.
    Home,
    /// Its own engine has room again: back to it, with a recap.
    Return,
    /// On the other engine.
    Carry,
    /// Ask first, with a card. `resume`: answering yes runs the turn again.
    Ask { resume: bool },
    /// Every account is out and it doesn't carry on: the usage-limit line.
    Wait,
    /// It would carry on, but part of the work already ran: stop on
    /// [`held_line`], and the next message carries on.
    Held,
}

/// Before a turn: which engine it starts on. A turn starts on its own
/// engine unless that has no room and it is already away, or carrying on
/// was chosen; asking waits for the turn to fail (it may have room after all).
pub fn before_turn(s: Situation) -> Route {
    if s.pinned || s.quiet {
        return if s.away { Route::Return } else { Route::Home };
    }
    if s.home_room {
        return if s.away { Route::Return } else { Route::Home };
    }
    if !s.other_room {
        // Neither has room: its own engine's words say when it's back.
        return if s.away { Route::Return } else { Route::Home };
    }
    if s.away {
        return Route::Carry;
    }
    if !s.acted && (s.mode == Mode::Carry || s.once) {
        return Route::Carry;
    }
    Route::Home
}

/// A turn on its own engine just ended with every account out.
pub fn after_out(s: Situation) -> Route {
    if s.pinned || s.quiet || !s.other_room || s.home_room {
        return Route::Wait;
    }
    let carry = s.mode == Mode::Carry || s.once;
    match (carry, s.mode, s.acted) {
        (true, _, false) => Route::Carry,
        (true, _, true) => Route::Held,
        (false, Mode::Wait, _) => Route::Wait,
        (false, _, _) if s.asking => Route::Wait,
        (false, _, acted) => Route::Ask { resume: !acted },
    }
}

/* ---------------------------------------------------------------- disk */

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct File {
    /// By home engine (`claude`, `codex`).
    #[serde(default)]
    modes: BTreeMap<String, Mode>,
    /// "Just this time": granted at, for the outage in progress. Gone once
    /// that engine has room again.
    #[serde(default)]
    once: BTreeMap<String, i64>,
    /// The card asking, by home engine.
    #[serde(default)]
    asking: BTreeMap<String, Asking>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asking {
    pub agent_id: String,
    pub request_id: String,
    pub at: i64,
}

/// A "just this time" never outlives a week, whatever happens.
const ONCE_MAX_MS: i64 = 7 * 24 * 60 * 60 * 1000;

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join("crossover.json"))
}

fn read() -> File {
    path()
        .ok()
        .and_then(|p| {
            super::survive::read_kept(&p, "Your choices about carrying on with the other engine")
        })
        .unwrap_or_default()
}

fn change<T>(f: impl FnOnce(&mut File) -> T) -> Result<T, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read();
    let out = f(&mut file);
    let json = serde_json::to_vec_pretty(&file).map_err(super::err_other)?;
    super::store::write_atomic(&path()?, &json)?;
    Ok(out)
}

fn snapshot() -> File {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read()
}

pub fn mode(home: Engine) -> Mode {
    snapshot()
        .modes
        .get(word(home))
        .copied()
        .unwrap_or_default()
}

pub fn set_mode(home: Engine, mode: Mode) -> Result<(), CommandError> {
    change(|f| {
        f.modes.insert(word(home).to_string(), mode);
        // A standing answer replaces this outage's.
        f.once.remove(word(home));
    })
}

/// "Just this time" is in force for `home`'s outage.
pub fn once(home: Engine, now: i64) -> bool {
    snapshot()
        .once
        .get(word(home))
        .is_some_and(|&at| now - at < ONCE_MAX_MS)
}

pub fn grant_once(home: Engine, now: i64) -> Result<(), CommandError> {
    change(|f| {
        f.once.insert(word(home).to_string(), now);
    })
}

/// `home` has room again: this outage's "just this time" is over.
pub fn outage_over(home: Engine) {
    if snapshot().once.contains_key(word(home)) {
        let _ = change(|f| {
            f.once.remove(word(home));
        });
    }
}

pub fn asking(home: Engine) -> Option<Asking> {
    snapshot().asking.get(word(home)).cloned()
}

pub fn set_asking(home: Engine, asking: Asking) -> Result<(), CommandError> {
    change(|f| {
        f.asking.insert(word(home).to_string(), asking);
    })
}

/// The card was answered (or closed): no longer asking.
pub fn clear_asking(request_id: &str) {
    let open = snapshot()
        .asking
        .values()
        .any(|a| a.request_id == request_id);
    if open {
        let _ = change(|f| f.asking.retain(|_, a| a.request_id != request_id));
    }
}

/// Whether the card asking for `home` is still open in its chat.
pub fn still_asking(home: Engine) -> bool {
    let Some(a) = asking(home) else {
        return false;
    };
    let open = super::store::find_approval(&a.agent_id, &a.request_id)
        .ok()
        .flatten()
        .is_some_and(|c| c.status == super::store::ApprovalStatus::Pending);
    if !open {
        clear_asking(&a.request_id);
    }
    open
}

/* ------------------------------------------------------------- the card */

/// On an [`Approval`](super::store::Approval): "Carry on with Codex until
/// then?". Allow + always is **Always**, Allow is **Just this time**, Deny is
/// **Wait**. Older clients show a plain Allow / Deny: Just this time / Wait.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    /// The engine that is out.
    pub from: Engine,
    /// The one it would carry on with.
    pub to: Engine,
    /// When the first of `from`'s accounts said it is back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    /// Yes runs the turn again there. False when part of it already ran.
    pub resume: bool,
}

/// "until 4:00 PM", "until tomorrow at 10:00 AM".
fn until_phrase<Tz: chrono::TimeZone>(tz: &Tz, at: i64, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let phrase = super::failure::clock_phrase(tz, at, now);
    format!("until {}", phrase.strip_prefix("at ").unwrap_or(&phrase))
}

/// The card's title.
pub fn card_title<Tz: chrono::TimeZone>(ask: &Ask, accounts: usize, tz: &Tz, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let from = ask.from.label();
    let to = ask.to.label();
    let who = if accounts <= 1 {
        format!("Your {from} account is")
    } else {
        format!("All your {from} accounts are")
    };
    match ask.until.filter(|&t| t > now) {
        Some(at) => format!(
            "{who} out {}. Carry on with {to} until then?",
            until_phrase(tz, at, now)
        ),
        None => format!("{who} out of usage. Carry on with {to} until it's back?"),
    }
}

/// What the card says under its title.
pub fn card_detail(ask: &Ask, agent: &str, reach: Option<&str>) -> String {
    let (from, to) = (ask.from.label(), ask.to.label());
    let mut out = format!(
        "{to} can't open {from}'s conversation, so {agent} starts there from your chat and its memory. When {from} has room again, {agent} goes back to it and is told what happened meanwhile."
    );
    if let Some(reach) = reach {
        out.push(' ');
        out.push_str(reach);
    }
    if !ask.resume {
        out.push_str(&format!(
            " Part of this request had already run on {from}, so it isn't started again: check what was done, then send what's left."
        ));
    }
    out.push_str(&format!(
        " Always: whenever every {from} account is out. Change it in Settings → Agents → Usage."
    ));
    out
}

/// The card, ready to post.
pub fn card<Tz: chrono::TimeZone>(
    ask: Ask,
    agent: &str,
    accounts: usize,
    reach: Option<&str>,
    tz: &Tz,
    now: i64,
) -> super::store::Approval
where
    Tz::Offset: std::fmt::Display,
{
    let title = card_title(&ask, accounts, tz, now);
    let detail = card_detail(&ask, agent, reach);
    let mut approval = super::mcp::new_card(super::store::new_id(), title, detail.clone(), None);
    approval.summary = Some(detail);
    approval.detail = String::new();
    approval.crossover = Some(ask);
    approval
}

/// What answering the card decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Always,
    JustThisTime,
    Wait,
}

pub fn answer_of(allow: bool, always: bool) -> Answer {
    match (allow, always) {
        (true, true) => Answer::Always,
        (true, false) => Answer::JustThisTime,
        (false, _) => Answer::Wait,
    }
}

pub fn answer_word(answer: Answer) -> &'static str {
    match answer {
        Answer::Always => "Always",
        Answer::JustThisTime => "Just this time",
        Answer::Wait => "Wait",
    }
}

/// An answer that closed the card.
#[derive(Debug, Clone)]
pub struct Settled {
    /// The card as answered, for the chat.
    pub message: super::store::AgentMessage,
    /// Run the turn again on the other engine.
    pub resume: bool,
}

/// Answer the card: close it first, and only the answer that closed it sets
/// anything. Two answers at once (the desk and the phone, a typed yes and a
/// tap) used to both set the choice and both run the turn again.
pub fn settle(
    agent_id: &str,
    approval: &super::store::Approval,
    allow: bool,
    always: bool,
    now: i64,
) -> Result<Settled, CommandError> {
    let Some(ask) = approval.crossover.clone() else {
        return Err(CommandError::expected(
            "That isn't a card about carrying on.",
        ));
    };
    let answer = answer_of(allow, always);
    let status = if allow {
        super::store::ApprovalStatus::Allowed
    } else {
        super::store::ApprovalStatus::Denied
    };
    let message =
        super::store::answer_prompt(agent_id, &approval.request_id, status, answer_word(answer))?
            .ok_or_else(|| super::answer_gate::lost(agent_id, &approval.request_id))?;
    clear_asking(&approval.request_id);
    match answer {
        Answer::Always => set_mode(ask.from, Mode::Carry)?,
        Answer::JustThisTime => grant_once(ask.from, now)?,
        Answer::Wait => {}
    }
    Ok(Settled {
        message,
        resume: allow && ask.resume,
    })
}

/// What the turn run again after a yes is told (it is never shown).
pub fn resume_prompt(from: Engine) -> String {
    format!(
        "[Your last turn stopped before it started because every {} account was out of usage. Carry on with what the user asked last, above.]",
        from.label()
    )
}

/* ------------------------------------------------------------- the lines */

/// "Carried on with Codex (Claude Code is out until 4:00 PM)."
pub fn carried_line<Tz: chrono::TimeZone>(
    from: Engine,
    to: Engine,
    until: Option<i64>,
    reach: Option<&str>,
    tz: &Tz,
    now: i64,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let why = match until.filter(|&t| t > now) {
        Some(at) => format!("{} is out {}", from.label(), until_phrase(tz, at, now)),
        None => format!("{} is out of usage", from.label()),
    };
    let mut line = format!("Carried on with {} ({why}).", to.label());
    if let Some(reach) = reach {
        line.push(' ');
        line.push_str(reach);
    }
    line
}

/// "Back on Claude Code: it has room again."
pub fn back_line(home: Engine) -> String {
    format!("Back on {}: it has room again.", home.label())
}

/// A try that already did part of the work, when its accounts ran out.
pub fn held_line(from: Engine, to: Engine) -> String {
    format!(
        "Every {from} account is out of usage. This didn't carry on with {to}: part of it had already run, and {to} can't pick up {from}'s conversation, so starting again could do it twice. Check what was done, then send what's left: it runs on {to}.",
        from = from.label(),
        to = to.label()
    )
}

/// What doesn't come along to the other engine, when the agent would have
/// had it: Claude in Chrome and claude.ai connectors are Claude Code's own.
/// `user_chrome`: the turn has the user's Chrome through the app's own
/// extension; `connections`: it has connections made here.
pub fn reach_line(
    to: Engine,
    lost_chrome: bool,
    connectors: &[String],
    user_chrome: bool,
    connections: bool,
) -> Option<String> {
    if to != Engine::Codex || (!lost_chrome && connectors.is_empty()) {
        return None;
    }
    let mut lost: Vec<String> = Vec::new();
    if lost_chrome {
        lost.push("Claude in Chrome".to_string());
    }
    match connectors.len() {
        0 => {}
        1 => lost.push(format!("the claude.ai connector {}", connectors[0])),
        _ => lost.push(format!("the claude.ai connectors ({})", list(connectors))),
    }
    let lost = list(&lost);
    let has = match (user_chrome, connections) {
        (true, true) => {
            "it uses your Chrome through the app's own extension, and your connections here"
        }
        (true, false) => "it uses your Chrome through the app's own extension",
        (false, true) => "it uses your connections here",
        (false, false) => "it goes without them until Claude Code is back",
    };
    Some(format!("{lost} stay with Claude Code; on Codex {has}."))
}

fn list(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} and {}", items[0], items[1]),
        n => format!("{}, and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

/// The recap's opening for the first turn on the other engine.
pub fn carry_header(from: Engine, to: Engine) -> String {
    format!(
        "[This conversation started on {from}. Every {from} account is out of usage, so it continues here on {to}, which can't open that session. This is the recent conversation from your own chat, newest last: what \"You\" said, you said, and you know it. Your instructions and memory are the same as before (CLAUDE.md in your home), and memory you save goes there as always. Pick up from here without mentioning the move unless asked; never ask the user to repeat or paste anything in it. search_my_chat finds anything older.]",
        from = from.label(),
        to = to.label()
    )
}

/// The recap's opening for the first turn back on its own engine.
pub fn back_header(home: Engine, was_on: Engine) -> String {
    format!(
        "[While every {home} account was out of usage, this conversation went on with {was} (so your session here missed it). This is what was said meanwhile, newest last: what \"You\" said there, you said, and you know it. Your memory (CLAUDE.md) is current, including anything saved meanwhile. Pick up from here without mentioning the move unless asked.]",
        home = home.label(),
        was = was_on.label()
    )
}

/* --------------------------------------------- instructions and memory */

/// The group memory found in a separate AGENTS.md is kept under.
pub const FOLDED_GROUP: &str = "Saved on Codex";

/// One set of instructions and memory for both engines, in the agent's home:
/// CLAUDE.md is the file (Codex reads it as its project doc, and every
/// memory tool writes it); `AGENTS.md` beside it is a link to it, so Codex
/// never finds a doc of its own first. An `AGENTS.md` that is a file of its
/// own (Codex wrote one) has whatever CLAUDE.md doesn't already say folded
/// into the memory, under [`FOLDED_GROUP`], before it becomes the link.
/// True when anything was folded in.
pub fn sync_instructions(home: &Path) -> bool {
    let claude = home.join("CLAUDE.md");
    let agents = home.join("AGENTS.md");
    if !claude.is_file() {
        return false;
    }
    let mut folded = false;
    match agents.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            if std::fs::read_link(&agents).is_ok_and(|to| to == Path::new("CLAUDE.md")) {
                return false;
            }
            let _ = std::fs::remove_file(&agents);
        }
        // Another name for some other file (a hard link to `~/.ssh/…`), or
        // far bigger than any memory: never read into memory, just replaced.
        Ok(meta) if meta.is_file() && !foldable(&meta) => {
            tracing::warn!(
                "[Agents] AGENTS.md wasn't a note of the agent's own; replaced, not kept"
            );
            let _ = std::fs::remove_file(&agents);
        }
        Ok(meta) if meta.is_file() => {
            let theirs = std::fs::read_to_string(&agents).unwrap_or_default();
            match fold_into(&claude, &theirs) {
                Ok(n) => folded = n > 0,
                Err(e) => {
                    // Kept as it is rather than lost: tried again next time.
                    tracing::warn!("[Agents] couldn't keep memory from AGENTS.md: {e}");
                    return false;
                }
            }
            let _ = std::fs::remove_file(&agents);
        }
        Ok(_) => return false,
        Err(_) => {}
    }
    #[cfg(unix)]
    if let Err(e) = std::os::unix::fs::symlink("CLAUDE.md", &agents) {
        tracing::warn!("[Agents] couldn't link AGENTS.md to CLAUDE.md: {e}");
    }
    folded
}

/// The most of a separate AGENTS.md read into memory.
const MAX_FOLD_BYTES: u64 = 64 * 1024;

/// A file of the agent's own: one name only (not a hard link to something
/// elsewhere) and no bigger than a memory could be.
fn foldable(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return false;
        }
    }
    meta.len() <= MAX_FOLD_BYTES
}

/// What `AGENTS.md` in a home is, for a turn answering outside text to have
/// it put back as it was (`runner::MemorySeal`): Codex has no rule against
/// writing it, and a file there is Codex's project doc and folded into
/// memory ([`sync_instructions`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentsDoc {
    Absent,
    Link(PathBuf),
    File(Vec<u8>),
    /// A folder, or unreadable: left as it is.
    Other,
}

pub fn agents_doc(home: &Path) -> AgentsDoc {
    let path = home.join("AGENTS.md");
    match path.symlink_metadata() {
        Err(_) => AgentsDoc::Absent,
        Ok(m) if m.file_type().is_symlink() => std::fs::read_link(&path)
            .map(AgentsDoc::Link)
            .unwrap_or(AgentsDoc::Other),
        Ok(m) if m.is_file() => std::fs::read(&path)
            .map(AgentsDoc::File)
            .unwrap_or(AgentsDoc::Other),
        Ok(_) => AgentsDoc::Other,
    }
}

/// Put `AGENTS.md` back as `before` if it changed. Returns whether it did.
pub fn put_back_agents_md(home: &Path, before: &AgentsDoc) -> bool {
    let now = agents_doc(home);
    if &now == before || *before == AgentsDoc::Other {
        return false;
    }
    let path = home.join("AGENTS.md");
    match now {
        AgentsDoc::Absent => {}
        AgentsDoc::Other => {
            if path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
        _ => {
            let _ = std::fs::remove_file(&path);
        }
    }
    let restored = match before {
        AgentsDoc::Absent | AgentsDoc::Other => Ok(()),
        #[cfg(unix)]
        AgentsDoc::Link(to) => std::os::unix::fs::symlink(to, &path),
        #[cfg(not(unix))]
        AgentsDoc::Link(_) => Ok(()),
        AgentsDoc::File(bytes) => std::fs::write(&path, bytes),
    };
    if let Err(e) = restored {
        tracing::warn!("[Agents] couldn't put AGENTS.md back: {e}");
    }
    true
}

/// Add each line of `theirs` that CLAUDE.md doesn't already have to its
/// memory. Returns how many were added.
fn fold_into(claude: &Path, theirs: &str) -> Result<usize, CommandError> {
    let mut raw = std::fs::read_to_string(claude).map_err(super::err_io)?;
    let new = new_lines(&raw, theirs);
    if new.is_empty() {
        return Ok(0);
    }
    let mut added = 0;
    for text in &new {
        let change = super::memory::Change::Add {
            text: text.clone(),
            group: Some(FOLDED_GROUP.to_string()),
            after: None,
            before: None,
            raw: None,
        };
        if let Ok((next, _)) = super::memory::apply(&raw, &change) {
            raw = next;
            added += 1;
        }
    }
    super::store::write_atomic(claude, raw.as_bytes())?;
    Ok(added)
}

/// The lines worth keeping from `theirs`: not headings, not blank, not
/// already said in `ours` (compared without list markers and case).
pub fn new_lines(ours: &str, theirs: &str) -> Vec<String> {
    let norm = |l: &str| {
        l.trim()
            .trim_start_matches(['-', '*', '+'])
            .trim()
            .to_lowercase()
    };
    let have: std::collections::HashSet<String> = ours.lines().map(norm).collect();
    let mut seen = std::collections::HashSet::new();
    theirs
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| !have.contains(&norm(l)) && seen.insert(norm(l)))
        .map(|l| {
            l.trim_start_matches(['-', '*', '+'])
                .trim()
                .chars()
                .take(1900)
                .collect()
        })
        .filter(|l: &String| !l.is_empty())
        .collect()
}

/* ------------------------------------------------------------ the views */

/// Settings → Agents → Usage, and the Chief's `usage_overview`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub claude: Mode,
    pub codex: Mode,
    /// Agents carrying on with another engine right now.
    pub away: Vec<AwayView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayView {
    pub agent_id: String,
    pub name: String,
    /// Its own engine, which is out.
    pub home: Engine,
    pub on: Engine,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

pub fn view(agents: &[super::store::Agent]) -> View {
    View {
        claude: mode(Engine::Claude),
        codex: mode(Engine::Codex),
        away: view_away(agents),
    }
}

/// The agents carrying on with another engine right now.
pub fn view_away(agents: &[super::store::Agent]) -> Vec<AwayView> {
    agents
        .iter()
        .filter_map(|a| {
            let away = a.away.as_ref()?;
            Some(AwayView {
                agent_id: a.id.clone(),
                name: a.name.clone(),
                home: a.engine,
                on: away.engine,
                until: away.until,
            })
        })
        .collect()
}

/// One line for the Chief's usage overview, when anything is set or away.
pub fn overview_line(v: &View) -> Option<String> {
    let said = |m: Mode, home: Engine| match m {
        Mode::Ask => format!("ask first before carrying on with {}", other(home).label()),
        Mode::Carry => format!("carry on with {}", other(home).label()),
        Mode::Wait => "wait for the reset".to_string(),
    };
    let mut out = format!(
        "When every Claude Code account is out: {}. When every Codex account is out: {}.",
        said(v.claude, Engine::Claude),
        said(v.codex, Engine::Codex)
    );
    for a in &v.away {
        out.push_str(&format!(
            " {} is carrying on with {} while {} is out.",
            a.name,
            a.on.label(),
            a.home.label()
        ));
    }
    Some(out)
}

#[cfg(test)]
#[path = "crossover_tests.rs"]
mod tests;
