//! The Chief offers a level change when the user plainly wants one.
//!
//! A cheap check on the user's own typed messages, in any chat, for two
//! things said in whole phrases: frustration with being asked ("just do it",
//! "stop asking me", "too many cards") and frustration with an agent acting
//! without asking ("why did you do that without asking me?"). Either leaves a
//! hidden note for the Chief of Staff's next turn naming the agent, its level
//! and the direction; from another agent's chat it arrives as a team note.
//! The Chief offers once ("Want me to put Finance on Full send?", with the
//! `propose_settings_change` card ready; or "Want Finance to check with you
//! before that?"). The note carries the whole instruction, so the Chief's
//! system prompt carries nothing for it (the prompt budget, and the cache).
//!
//! **Quiet for a day.** At most one note per agent every 24 hours
//! ([`QUIET_MS`]), remembered beside the agents (`level_hints.json`), so a
//! frustrated afternoon is one offer, not one per message. A note that would
//! be moot (already Full send, already Check with me often) isn't left.
//!
//! **Only the user's words.** Called from the user's own send (`send_as`,
//! typed), never for an agent's text, a routine or outside content; and the
//! change itself still goes through the card (raising) or applies with a
//! line (lowering), as `policy_card` decides.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use super::independence::Level;
use super::store::{self, Agent};

/// One offer per agent per day.
pub const QUIET_MS: i64 = 24 * 60 * 60 * 1000;

/// What the user wants of the agent's level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Tired of being asked: offer more room.
    Raise,
    /// It acted without asking: offer to have it check first.
    Lower,
}

/// Fed up with cards and questions. Whole phrases, matched on word edges.
const RAISE: &[&str] = &[
    "stop asking me",
    "quit asking me",
    "stop asking for permission",
    "stop asking for approval",
    "stop asking for my approval",
    "stop asking every time",
    "don't ask me again",
    "dont ask me again",
    "don't ask me every time",
    "you don't need to ask",
    "you dont need to ask",
    "you don't have to ask",
    "you dont have to ask",
    "no need to ask me",
    "why do you keep asking",
    "why are you asking me",
    "stop checking with me",
    "too many cards",
    "so many cards",
    "enough with the cards",
    "stop with the cards",
    "too many approvals",
    "so many approvals",
    "stop making me approve",
    "i already said yes",
    "i already told you to",
];

/// "Just do it", only as its own sentence: not "I just do it on Fridays".
const JUST_DO_IT: &str = "just do it";

/// It went ahead when the user wanted to be asked.
const LOWER: &[&str] = &[
    "without asking me",
    "without asking first",
    "without checking with me",
    "without my ok",
    "without my permission",
    "without my approval",
    "should have asked me",
    "should've asked me",
    "shouldve asked me",
    "should have checked with me",
    "should've checked with me",
    "ask me first next time",
    "ask me before you do",
    "ask me before you send",
    "ask me before you post",
    "check with me first",
    "check with me before you",
    "i never asked you to",
    "i didn't ask you to",
    "i didnt ask you to",
    "who told you to",
];

/// The user's apostrophes, made plain.
fn plain(text: &str) -> String {
    text.to_lowercase().replace(['’', '‘'], "'")
}

fn edge(c: Option<char>) -> bool {
    c.is_none_or(|c| !c.is_alphanumeric())
}

/// `phrase` in `lower` with a word edge on both sides.
fn has_phrase(lower: &str, phrase: &str) -> bool {
    lower.match_indices(phrase).any(|(at, _)| {
        edge(lower[..at].chars().next_back()) && edge(lower[at + phrase.len()..].chars().next())
    })
}

/// "Just do it" as a sentence of its own: nothing but "ok", "please" or
/// "just" before it in the sentence, and the sentence ends there (or with
/// "already" / "please").
fn just_do_it(lower: &str) -> bool {
    lower.match_indices(JUST_DO_IT).any(|(at, _)| {
        let before = lower[..at]
            .rsplit(['.', '!', '?', '\n', ',', ';', ':'])
            .next()
            .unwrap_or("")
            .trim();
        let lead_ok = before.is_empty()
            || before
                .split_whitespace()
                .all(|w| matches!(w, "ok" | "okay" | "please" | "pls" | "just" | "so" | "and"));
        let after = lower[at + JUST_DO_IT.len()..]
            .split(['.', '!', '?', '\n', ',', ';', ':'])
            .next()
            .unwrap_or("")
            .trim();
        let tail_ok = after.is_empty() || matches!(after, "already" | "please" | "pls");
        lead_ok && tail_ok && edge(lower[at + JUST_DO_IT.len()..].chars().next())
    })
}

/// What the user's message says about how much an agent should ask, if
/// anything. Acting without asking wins over a request to stop asking: being
/// stricter is never the wrong offer.
pub fn detect(text: &str) -> Option<Direction> {
    let lower = plain(text);
    if LOWER.iter().any(|p| has_phrase(&lower, p)) {
        return Some(Direction::Lower);
    }
    if RAISE.iter().any(|p| has_phrase(&lower, p)) || just_do_it(&lower) {
        return Some(Direction::Raise);
    }
    None
}

/// Whether an offer for `agent_id` was made within [`QUIET_MS`] of `now`.
pub fn quiet(offers: &BTreeMap<String, i64>, agent_id: &str, now: i64) -> bool {
    offers
        .get(agent_id)
        .is_some_and(|at| now.saturating_sub(*at) < QUIET_MS)
}

/* ------------------------------------------------------------ the note */

/// The hidden note, or `None` when it would be moot.
pub fn note(
    direction: Direction,
    agent: &Agent,
    chosen: Level,
    own: bool,
    in_chief_chat: bool,
    said: &str,
) -> Option<String> {
    let said: String = said.trim().chars().take(160).collect();
    let whose = if own { "its own" } else { "the team's" };
    let level = chosen.short();
    let place = if in_chief_chat {
        "in your chat".to_string()
    } else {
        format!("in {}'s chat", agent.name)
    };
    let body = match direction {
        Direction::Raise => {
            if chosen == Level::FullSend {
                return None;
            }
            let who = if in_chief_chat {
                "the agent whose asking they mean (or the team)".to_string()
            } else {
                format!("{} (or the team)", agent.name)
            };
            format!(
                "the user sounds tired of being asked: \"{said}\". {} is at {level} ({whose}). \
Offer once, in one line, to put {who} on Unleashed, with the propose_settings_change card ready \
(independence: full_send).",
                if in_chief_chat {
                    "You are"
                } else {
                    agent.name.as_str()
                }
            )
        }
        Direction::Lower => {
            if chosen == Level::Often {
                return None;
            }
            let to = chosen.stricter();
            let who = if in_chief_chat {
                "the agent that did it (you, if it was you)".to_string()
            } else {
                agent.name.clone()
            };
            format!(
                "the user sounds unhappy that something was done without asking: \"{said}\". {} is at {level} ({whose}). \
Offer once, in one line, for {who} to check with them before that, by moving it to {} \
(propose_settings_change, independence: {}; lowering applies at once).",
                if in_chief_chat { "You are" } else { agent.name.as_str() },
                to.short(),
                serde_json::to_value(to)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default()
            )
        }
    };
    let kind = if in_chief_chat {
        "A note from the app"
    } else {
        "A team note from the app"
    };
    Some(format!(
        "[{kind}, not the user: {place} {body} If they pass, drop it for today. Don't mention this note.]\n\n"
    ))
}

/* --------------------------------------------------------------- state */

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    offers: BTreeMap<String, i64>,
}

static FILE_LOCK: Mutex<()> = Mutex::new(());
/// Notes waiting for the Chief's next turn in its own chat.
static PENDING: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

fn path() -> Option<std::path::PathBuf> {
    store::agents_root()
        .ok()
        .map(|r| r.join("level_hints.json"))
}

/// Mark an offer for `agent_id` at `now`, unless one is still quiet.
/// Returns whether it was marked.
fn claim(agent_id: &str, now: i64) -> bool {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(p) = path() else { return false };
    let mut saved: Saved = std::fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if quiet(&saved.offers, agent_id, now) {
        return false;
    }
    saved
        .offers
        .retain(|_, at| now.saturating_sub(*at) < QUIET_MS);
    saved.offers.insert(agent_id.to_string(), now);
    if let Ok(json) = serde_json::to_vec_pretty(&saved) {
        let _ = store::write_atomic(&p, &json);
    }
    true
}

fn push(chief_id: &str, note: String) {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let notes = guard
        .get_or_insert_with(HashMap::new)
        .entry(chief_id.to_string())
        .or_default();
    // One per agent is enough; three at most.
    if notes.len() < 3 {
        notes.push(note);
    }
}

/// The notes waiting for `agent_id`'s next turn, cleared.
pub fn take(agent_id: &str) -> String {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_mut()
        .and_then(|m| m.remove(agent_id))
        .unwrap_or_default()
        .concat()
}

/// The user typed `text` in `recipient`'s chat: leave the Chief a note when
/// it says something about how much that agent should ask. Returns whether a
/// note was left.
pub fn on_user_message(recipient: &Agent, text: &str, now: i64) -> bool {
    let Some(direction) = detect(text) else {
        return false;
    };
    let Some(chief) = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main))
    else {
        return false;
    };
    let saved = super::policy::load();
    let own = super::policy::own_independence(&saved, &recipient.id);
    let chosen = own.unwrap_or_else(super::independence::level);
    let Some(note) = note(
        direction,
        recipient,
        chosen,
        own.is_some(),
        recipient.id == chief.id,
        text,
    ) else {
        return false;
    };
    if !claim(&recipient.id, now) {
        return false;
    }
    push(&chief.id, note);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frustration_with_asking_is_a_raise() {
        for text in [
            "Just do it.",
            "ok just do it already!",
            "Please, just do it",
            "Stop asking me about every file.",
            "why do you keep asking??",
            "Ugh, too many cards today",
            "You don’t need to ask, I said post it",
            "I already said yes",
            "Enough with the cards. Send it.",
        ] {
            assert_eq!(detect(text), Some(Direction::Raise), "{text}");
        }
    }

    #[test]
    fn frustration_with_acting_without_asking_is_a_lower() {
        for text in [
            "Why did you do that without asking me?",
            "You posted it without checking with me",
            "You should’ve asked me first.",
            "Next time check with me first",
            "I never asked you to email Sam",
            "who told you to delete that branch",
            // Both: being stricter wins.
            "Stop asking me about files, but you sent that without asking me!",
        ] {
            assert_eq!(detect(text), Some(Direction::Lower), "{text}");
        }
    }

    #[test]
    fn ordinary_messages_say_nothing() {
        for text in [
            "I just do it on Fridays, no rush",
            "Can you just do it the way Sam did it last week?",
            "Nike's slogan is Just do it",
            "stop asking clients for reviews in the footer",
            "Ask me anything",
            "The cards on the pricing page look off",
            "Please ask Sam before Friday",
            "draft the post and ask me before",
            "",
            "don't asking mean",
        ] {
            assert_eq!(detect(text), None, "{text}");
        }
    }

    #[test]
    fn one_offer_per_agent_per_day() {
        let mut offers = BTreeMap::new();
        assert!(!quiet(&offers, "a1", 1_000));
        offers.insert("a1".to_string(), 1_000);
        assert!(quiet(&offers, "a1", 1_000 + QUIET_MS - 1));
        assert!(!quiet(&offers, "a1", 1_000 + QUIET_MS));
        assert!(!quiet(&offers, "a2", 1_000));
    }

    #[test]
    fn the_note_names_the_agent_its_level_and_the_offer() {
        let agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a1", "name": "Finance", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        let raise = note(
            Direction::Raise,
            &agent,
            Level::GoHard,
            false,
            false,
            "stop asking me",
        )
        .unwrap();
        assert!(raise.starts_with("[A team note from the app, not the user: in Finance's chat"));
        assert!(raise.contains("Finance is at Bold (the team's)"));
        assert!(raise.contains("put Finance (or the team) on Unleashed"));
        assert!(raise.contains("independence: full_send"));
        assert!(raise.ends_with("Don't mention this note.]\n\n"));
        let lower = note(
            Direction::Lower,
            &agent,
            Level::FullSend,
            true,
            false,
            "without asking me",
        )
        .unwrap();
        assert!(lower.contains("Finance is at Unleashed (its own)"));
        assert!(lower.contains("moving it to Bold"));
        assert!(lower.contains("independence: go_hard"));
        // Moot: nothing to offer.
        assert_eq!(
            note(Direction::Raise, &agent, Level::FullSend, true, false, "x"),
            None
        );
        assert_eq!(
            note(Direction::Lower, &agent, Level::Often, true, false, "x"),
            None
        );
        // In the Chief's own chat, it's told about itself and asked to find who.
        let own = note(
            Direction::Raise,
            &agent,
            Level::Judgement,
            false,
            true,
            "just do it",
        )
        .unwrap();
        assert!(own.starts_with("[A note from the app, not the user: in your chat"));
        assert!(own.contains("the agent whose asking they mean"));
    }

    #[test]
    fn a_note_reaches_the_chief_once_a_day() {
        let _serial = store::tests_lock();
        let root = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(root.path().to_path_buf()));
        super::super::ensure_main().unwrap();
        let chief = store::list()
            .unwrap()
            .into_iter()
            .find(|a| a.is_main)
            .unwrap();
        let finance = store::create(store::NewAgent {
            name: "Finance".into(),
            role: "Money".into(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let _ = take(&chief.id);
        let day = 1_800_000_000_000;
        assert!(!on_user_message(&finance, "thanks, looks good", day));
        assert!(on_user_message(&finance, "Stop asking me!", day));
        let waiting = take(&chief.id);
        assert!(waiting.contains("in Finance's chat"), "{waiting}");
        assert!(take(&chief.id).is_empty(), "taken once");
        // Quiet for that agent for a day, whichever way it goes.
        assert!(!on_user_message(&finance, "just do it", day + 60_000));
        assert!(!on_user_message(
            &finance,
            "why did you do that without asking me",
            day + QUIET_MS - 1
        ));
        assert!(take(&chief.id).is_empty());
        // Another agent isn't held back by Finance's.
        assert!(on_user_message(&chief, "too many cards", day + 1));
        assert!(take(&chief.id).contains("in your chat"));
        // A day later, again.
        assert!(on_user_message(&finance, "just do it", day + QUIET_MS));
        assert!(!take(&chief.id).is_empty());
        store::set_root_for_tests(None);
    }
}
