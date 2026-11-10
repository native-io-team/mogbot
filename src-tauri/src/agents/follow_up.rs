//! Promises kept: a reply that says "I'll run it next" and then stops gets
//! run, by the app, as a follow-up.
//!
//! Observed (2026-11-07/08): agents ended replies with "I'll check Slack for
//! that thread next" or "I'll run the audit now" and the turn ended there.
//! Nothing woke them again until the user wrote, so a Slack check promised
//! one day hadn't started the next. The prompt already says to do the work
//! rather than announce it; this is the mechanism for when that slips.
//!
//! After a turn in the agent's own chat finishes ([`after_turn`]), its last
//! reply is read:
//!
//! - **An unkept promise** ([`promise`]): the reply ends with an explicit
//!   first-person commitment to act now or next ("I'll check…", "Let me
//!   run…", "Next I'll…"), and no tool call came after it. Not a question,
//!   not conditional on someone else ("once you send it", "when Finance
//!   replies"), not for a stated later time (that's `schedule_check_in`'s),
//!   not a report-back promise ("I'll let you know").
//! - **A "can't" the app knows is wrong** ([`cant_reach`] checked against
//!   `team_reach`): "I can't read Gmail" while this agent, or another on the
//!   team, has a way in.
//!
//! Either becomes one **follow-up**: a one-time check-in a minute out,
//! marked `follow_up`, so it shows under "Scheduled next" in What's in
//! flight and fires through the scheduler like any other (retries, quiet
//! hours, the take-over rule). Its wake quotes the reply and says to do it
//! now, or answer `[nothing new]` when it's done or no longer wanted.
//!
//! **Bounded.** Only after a turn that answered the user or an agent's reply
//! in the agent's own chat: never a routine's, a check-in's or a follow-up's
//! own turn (no loops), never a room, never outside text, never a turn that
//! answered another agent's request (its answer goes back to them). Never
//! when the turn handed work to another agent or scheduled its own check-in
//! (it's waiting on those). At most one waiting per agent, and
//! [`MAX_PER_DAY`] a day. The user writing first folds it into their turn
//! instead ([`fold_into_user_turn`]). With "Save my limits" nothing runs on
//! its own: the agent's next turn is told instead, and a quiet line says so.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::agency::sentences;
use super::logins::Service;
use super::schedule::CheckIn;
use super::store::{self, AgentMessage, MessageKind};

/// How long after the turn the follow-up fires: the next tick or two.
pub const DELAY_MS: i64 = 60_000;
/// Follow-ups one agent can get in a day.
pub const MAX_PER_DAY: usize = 3;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['’', '‘'], "'")
}

/// Commitments, as the sentence says them (lowercased, straight quotes).
const COMMITS: &[&str] = &[
    "i'll ",
    "i will ",
    "i'm going to ",
    "i am going to ",
    "let me ",
    "i'm about to ",
    "next up: ",
];

/// Words between the commitment and its verb ("I'll go ahead and run…").
const FILLER: &[&str] = &[
    "now",
    "next",
    "then",
    "also",
    "just",
    "go",
    "ahead",
    "and",
    "quickly",
    "first",
    "right",
    "immediately",
    "straight",
    "away",
    "actually",
    "properly",
    "kick",
    "off",
    "start",
];

/// Verbs of work the agent can do itself, now.
const ACTIONS: &[&str] = &[
    "check",
    "run",
    "rerun",
    "re-run",
    "look",
    "pull",
    "do",
    "draft",
    "fix",
    "review",
    "open",
    "read",
    "search",
    "build",
    "test",
    "try",
    "retry",
    "dig",
    "grab",
    "write",
    "update",
    "ask",
    "message",
    "scan",
    "sweep",
    "handle",
    "take",
    "finish",
    "continue",
    "investigate",
    "verify",
    "go",
    "compile",
    "prepare",
    "put",
    "find",
    "fetch",
    "restart",
    "sort",
    "clean",
    "triage",
    "summarize",
    "summarise",
    "confirm",
    "reach",
    "ping",
    "contact",
    "post",
    "send",
    "file",
    "create",
    "add",
    "make",
    "set",
    "get",
    "audit",
    "work",
    "start",
    "kick",
    "dive",
    "chase",
    "rebuild",
    "deploy",
    "push",
    "merge",
    "publish",
    "redo",
    "move",
];

/// In the sentence: it waits on someone or something else, a later time,
/// or it only promises to report.
const NOT_NOW: &[&str] = &[
    "?",
    "once you",
    "when you",
    "if you",
    "after you",
    "as soon as",
    "once they",
    "when they",
    "if they",
    "once it",
    "when it",
    "once that",
    "replies",
    "responds",
    "hear back",
    "gets back",
    "comes back",
    "when that",
    "once i hear",
    "when i hear",
    "until",
    "unless",
    "if needed",
    "if anything",
    "if that",
    "tomorrow",
    "tonight",
    "later",
    "this afternoon",
    "this evening",
    "next week",
    "in the morning",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "minutes",
    "hours",
    "every ",
    "let you know",
    "report back",
    "get back to you",
    "keep you posted",
    "keep you updated",
    "update you",
    "circle back",
    "follow up",
    "won't",
    "will not",
    "not ",
    "remember",
    "keep an eye",
    "wait",
    "stand by",
    "hold off",
    "leave it",
    "stop",
    // An offer waiting on the user's go-ahead. Observed (2026-11-08): "Say
    // the word and I'll run it next." became a follow-up, and the agent ran
    // a check nobody had said yes to.
    "say the word",
    "your word",
    "your go",
    "your ok",
    "you'd like",
    "you want",
    "want me to",
    "happy to",
    "say so",
    "say yes",
    "give me the",
    "if so",
];

/// The sentence of `text` that promises work it then didn't start, from the
/// reply's last two sentences (see the module docs). `None` when there's no
/// such promise. Pure.
pub fn promise(text: &str) -> Option<String> {
    let all = sentences(text);
    let tail = &all[all.len().saturating_sub(2)..];
    tail.iter()
        .rev()
        .find(|s| commits(&norm(s)))
        .map(|s| s.chars().take(200).collect())
}

fn commits(lower: &str) -> bool {
    // "at 9", "at 14:30", "at noon": a stated time is a check-in's job.
    let timed = lower.match_indices(" at ").any(|(i, _)| {
        lower[i + 4..].starts_with(|c: char| c.is_ascii_digit())
            || lower[i + 4..].starts_with("noon")
    });
    if timed || NOT_NOW.iter().any(|w| lower.contains(w)) {
        return false;
    }
    COMMITS.iter().any(|c| {
        let mut from = 0;
        while let Some(at) = lower[from..].find(c) {
            let start = from + at;
            from = start + c.len();
            // At a word's start: "i'll", not "nil'll".
            let ok_before = start == 0
                || lower[..start]
                    .chars()
                    .last()
                    .is_some_and(|ch| !ch.is_alphanumeric() && ch != '\'');
            if !ok_before {
                continue;
            }
            let words: Vec<&str> = lower[from..]
                .split(|ch: char| !(ch.is_alphanumeric() || ch == '-'))
                .filter(|w| !w.is_empty())
                .take(5)
                .collect();
            // "I'll go ahead and run…", "Let me now check…": the first word
            // that isn't filler is the verb, and it's work.
            let verb = words
                .iter()
                .find(|w| ACTIONS.contains(*w) || !FILLER.contains(*w));
            if verb.is_some_and(|v| ACTIONS.contains(v)) {
                return true;
            }
        }
        false
    })
}

/// "Can't" in the first person or the team's.
const CANT: &[&str] = &[
    "i can't",
    "i cannot",
    "i can not",
    "i'm unable",
    "i am unable",
    "i'm not able",
    "i am not able",
    "i don't have access",
    "i do not have access",
    "i have no access",
    "i have no way",
    "i don't have a way",
    "i don't have any way",
    "we can't",
    "we cannot",
    "we don't have access",
    "the team can't",
    "nobody on the team can",
    "no one on the team can",
    "none of us can",
    "i'm not connected",
    "i am not connected",
    "isn't connected",
    "is not connected",
    "not connected here",
];

/// What a "can't" is about: reading or getting at something, not sending.
const REACH_VERBS: &[&str] = &[
    "read",
    "access",
    "see",
    "check",
    "open",
    "reach",
    "search",
    "get into",
    "get to",
    "look",
    "pull",
    "view",
    "use",
    "connect",
    "into",
    "connected",
];

/// Reported speech: the sentence passes on another agent's finding.
/// Observed: an agent passed on the Chief's report that a third agent
/// couldn't read a chat app because the user's Chrome wasn't connected; it
/// was sent back to check, and told the user its own correct line was wrong.
const REPORTED: &[&str] = &[
    " reports that",
    " reported that",
    " told me",
    "according to ",
];

/// A "can't" about the browser itself ("Chrome isn't connected", "signed out
/// in the agents' browser"): the app knows only that a browser is switched
/// on for the agent, not that it's connected or signed in, so its browser
/// ways don't contradict it.
pub fn about_the_browser(sentence: &str) -> bool {
    let lower = norm(sentence);
    ["chrome", "browser", "extension"]
        .iter()
        .any(|w| lower.contains(w))
}

/// The sentences of `text` that say this agent (or the team) can't reach a
/// service the app knows by name, with that service. Pure.
pub fn cant_reach(text: &str) -> Vec<(String, &'static Service)> {
    sentences(text)
        .into_iter()
        .filter_map(|s| {
            let lower = norm(&s);
            let cant = CANT.iter().any(|c| lower.contains(c));
            let reach = REACH_VERBS.iter().any(|v| lower.contains(v));
            if !cant || !reach || lower.contains("without") || lower.contains('?') {
                return None;
            }
            // Passing on what someone else found isn't this agent's claim.
            if REPORTED.iter().any(|r| lower.contains(r)) {
                return None;
            }
            let service = super::logins::match_service(&s)?;
            Some((s.chars().take(200).collect(), service))
        })
        .collect()
}

/* --------------------------------------------------------- the decision */

/// What a finished turn left, as far as the decision needs.
#[derive(Debug, Default, Clone)]
pub struct Turn<'a> {
    /// Its last line in the chat, when that is a reply.
    pub last_reply: Option<&'a str>,
    /// A tool call came after that reply was written.
    pub acted_after: bool,
    /// It handed work to another agent (`message_agent`) or scheduled its
    /// own check-in: it's waiting on those.
    pub waiting: bool,
    /// A card it raised is still waiting on the user.
    pub card_open: bool,
}

/// What the app does about a turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Nothing,
    /// One follow-up, with the note it carries (what What's in flight shows).
    FollowUp(String),
}

/// A "can't" and who can, for [`decide`]: (the sentence, the service, the
/// ways the app knows: "Inbox: the Gmail connector…").
pub type Contradicted = (String, &'static Service, Vec<String>);

/// The note for a promise: what What's in flight shows under the agent.
pub fn promise_note(said: &str) -> String {
    format!("Said it would: “{said}”")
}

/// The note for a "can't" the app knows is wrong.
pub fn cant_note(said: &str, ways: &[String]) -> String {
    format!(
        "Said “{said}”, but the app knows a way in: {}",
        ways.join("; ")
    )
}

/// Pure: what to do about `turn`, given what the app knows contradicts.
pub fn decide(turn: &Turn, contradicted: &[Contradicted]) -> Decision {
    let Some(reply) = turn.last_reply else {
        return Decision::Nothing;
    };
    if let Some((said, _, ways)) = contradicted.first() {
        return Decision::FollowUp(cant_note(said, ways));
    }
    if turn.acted_after || turn.waiting || turn.card_open {
        return Decision::Nothing;
    }
    promise(reply).map_or(Decision::Nothing, |s| Decision::FollowUp(promise_note(&s)))
}

/// Whether another follow-up may be recorded for an agent with these
/// check-ins, given its follow-ups' times so far. Pure.
pub fn room_for_one(check_ins: &[CheckIn], recent: &[i64], now: i64) -> bool {
    !check_ins.iter().any(|c| c.follow_up)
        && recent.iter().filter(|t| now - **t < DAY_MS).count() < MAX_PER_DAY
}

/* ------------------------------------------------------------ the app */

/// Follow-ups recorded per agent this run, for [`MAX_PER_DAY`].
static RECENT: LazyLock<Mutex<HashMap<String, Vec<i64>>>> = LazyLock::new(Default::default);

/// The quiet line when "Save my limits" keeps it from running on its own.
pub fn saved_line(note: &str) -> String {
    format!("{note} · not started, to save your limits; it's picked up when you next write")
}

/// The hidden note a later turn gets for a follow-up it didn't run.
pub fn nudge(note: &str) -> String {
    format!("[A note from the app, not the user: {note}. If that's still wanted, do it as part of this turn. Don't mention this note.]\n\n")
}

/// After a finished turn in the agent's own chat. `eligible`: the turn
/// answered the user or an agent's reply (not a routine, check-in,
/// follow-up, request, room or outside text). Returns the hidden note the
/// next turn should get instead, when it can't run on its own.
pub fn after_turn(app: &AppHandle, agent_id: &str, since: i64, eligible: bool) -> Option<String> {
    if !eligible {
        return None;
    }
    let agent = store::get(agent_id).ok()?;
    let log: Vec<AgentMessage> = store::messages(agent_id, 40)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.ts >= since && m.room.is_none())
        .collect();
    let last = log.last().filter(|m| m.kind == MessageKind::Agent)?;
    let acted_after = super::work::load(agent_id, &last.id).is_some_and(|w| {
        w.steps.iter().any(|s| {
            s.at > last.ts
                && !matches!(
                    s.kind,
                    super::work::StepKind::Note | super::work::StepKind::Project
                )
        })
    });
    let waiting = log.iter().any(|m| m.kind == MessageKind::SentToAgent)
        || agent
            .check_ins
            .iter()
            .any(|c| c.created_at >= since && !c.follow_up);
    let card_open = agent.pending_approvals > 0;
    let contradicted: Vec<Contradicted> = cant_reach(&last.text)
        .into_iter()
        .filter_map(|(said, service)| {
            let browser = about_the_browser(&said);
            let rows = super::team_reach::team(&agent, service);
            let ways: Vec<String> = rows
                .iter()
                .map(|(name, w)| {
                    let w: Vec<String> = w
                        .iter()
                        .filter(|w| !(browser && super::team_reach::is_browser_way(w)))
                        .cloned()
                        .collect();
                    (name, w)
                })
                .filter(|(_, w)| !w.is_empty())
                .map(|(name, w)| {
                    if *name == agent.name {
                        format!("you: {}", w.join(", "))
                    } else {
                        format!("{name}: {}", w.join(", "))
                    }
                })
                .collect();
            (!ways.is_empty()).then_some((said, service, ways))
        })
        .collect();
    let turn = Turn {
        last_reply: Some(&last.text),
        acted_after,
        waiting,
        card_open,
    };
    let Decision::FollowUp(note) = decide(&turn, &contradicted) else {
        return None;
    };
    let now = store::now_ms();
    let recent = RECENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .cloned()
        .unwrap_or_default();
    if !room_for_one(&agent.check_ins, &recent, now) {
        return None;
    }
    if super::usage_plan::mode().0 == super::usage_plan::Mode::Save {
        let line = super::runner::new_message(agent_id, MessageKind::Note, saved_line(&note));
        let _ = super::runner::record(app, line);
        return Some(nudge(&note));
    }
    record(agent_id, &note, now).ok()?;
    RECENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .push(now);
    tracing::info!(agent = %agent_id, "[Agents] follow-up recorded");
    let _ = app.emit(super::runner::EVENT_REGISTRY, ());
    None
}

/// Add the follow-up check-in.
fn record(agent_id: &str, note: &str, now: i64) -> Result<(), crate::errors::CommandError> {
    let check_in = CheckIn {
        id: store::new_id()[..8].to_string(),
        note: note.to_string(),
        repeat: None,
        next_at: now + DELAY_MS,
        created_at: now,
        paused: false,
        paused_on_import: false,
        runs: Vec::new(),
        retry: None,
        watch: None,
        usage: Default::default(),
        follow_up: true,
        then: Vec::new(),
        waiting: None,
        model: None,
        extra: Default::default(),
    };
    store::update(agent_id, |a| {
        if !a.check_ins.iter().any(|c| c.follow_up) {
            a.check_ins.push(check_in);
        }
    })
    .map(|_| ())
}

/// The user wrote before a follow-up fired: it goes into their turn as a
/// hidden note instead of running on its own afterwards. Returns the note.
pub fn fold_into_user_turn(agent_id: &str) -> Option<String> {
    let mut notes = Vec::new();
    let _ = store::update(agent_id, |a| {
        a.check_ins.retain(|c| {
            if c.follow_up && c.runs.is_empty() && c.retry.is_none() {
                notes.push(c.note.clone());
                false
            } else {
                true
            }
        });
    });
    (!notes.is_empty()).then(|| notes.iter().map(|n| nudge(n)).collect())
}

#[cfg(test)]
#[path = "follow_up_tests.rs"]
mod tests;
