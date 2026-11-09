//! One answer per card.
//!
//! A card can be answered from several places at once: the desk and the
//! phone, a typed "approve it" and a tap, an admin agent and the user, a
//! sign-in finishing as the user declines. Each path used to check "still
//! pending?" and then act, so two answers landing together could both act:
//! a Slack reply posted twice, a plan granted after a Deny, Always applied
//! after Deny, a turn run again twice.
//!
//! Every answer now starts with [`claim`]: one compare-and-set, under one
//! lock, on the card's request id. It wins only when nobody else holds the
//! card *and* the card is still pending on disk; the winner holds the
//! [`Claim`] while it does what the answer means and writes it, so exactly
//! one answer's side effects run. A loser is told "Already answered:
//! <the winning answer>." and does nothing. A winner whose answer is refused
//! (a key that has to be typed, a switch to an account that's gone) drops
//! the claim without writing, and the card stays open for another answer.
//!
//! Answers the app gives on the user's behalf (a raised level, a rule from
//! chat, a "When…" put-away) use [`try_claim`] and skip a card someone is
//! answering. Expiry never closes a card being answered
//! (`store::expire_card`).
//!
//! Keyed by request id alone: a session's question shown in several chats is
//! one card with one answer (`decisions`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::store::{self, Approval, ApprovalStatus};
use crate::errors::CommandError;

/// Request id → the answer being given, while it is.
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn in_flight_map() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner())
}

/// The right to answer one card. Dropped, the card is free again: answered
/// (the store says so from then on) or, when the answer was refused, open.
#[derive(Debug)]
pub struct Claim {
    request_id: String,
}

impl Claim {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        in_flight_map().remove(&self.request_id);
    }
}

/// What a loser is told, with the answer that won.
pub fn already(word: &str) -> CommandError {
    CommandError::expected(format!("Already answered: {word}."))
}

/// The answer a closed card carries, in a word or two.
pub fn answered_word(a: &Approval) -> String {
    if let Some(choice) = a.choice.as_deref().filter(|c| !c.trim().is_empty()) {
        return choice.to_string();
    }
    match a.status {
        ApprovalStatus::Allowed if a.always_allowed => "Always allowed".into(),
        ApprovalStatus::Allowed => "Allowed".into(),
        ApprovalStatus::Denied => match a.note.as_deref().filter(|n| !n.trim().is_empty()) {
            Some(n) => format!("Denied (\"{n}\")"),
            None => "Denied".into(),
        },
        ApprovalStatus::Expired => "Closed".into(),
        ApprovalStatus::Pending => "Answering".into(),
    }
}

/// The word for an answer being given: Allow, Deny, Always, or the option.
pub fn said(allow: bool, always: bool, choice: Option<&str>) -> String {
    match (choice, allow, always) {
        (Some(c), _, _) if !c.trim().is_empty() => c.to_string(),
        (_, true, true) => "Always allowed".into(),
        (_, true, false) => "Allowed".into(),
        (_, false, _) => "Denied".into(),
    }
}

/// Take the card `request_id` in `agent_id`'s chat to answer it with
/// `said`. Exactly one of any number of racing callers gets the claim; the
/// others get [`already`] with the winning answer. A card that isn't there
/// is left to the caller to say so (each path words it its own way).
pub fn claim(agent_id: &str, request_id: &str, said: &str) -> Result<Claim, CommandError> {
    {
        let mut map = in_flight_map();
        if let Some(word) = map.get(request_id) {
            return Err(already(word));
        }
        map.insert(request_id.to_string(), said.to_string());
    }
    // Ours now: nobody else can write an answer through here until it drops.
    let claim = Claim {
        request_id: request_id.to_string(),
    };
    if let Some(card) = store::find_approval(agent_id, request_id)? {
        if card.status != ApprovalStatus::Pending {
            return Err(already(&answered_word(&card)));
        }
    }
    Ok(claim)
}

/// [`claim`] for an answer the app gives on the user's behalf: `None` when
/// the user (or anything else) is answering it or already has.
pub fn try_claim(agent_id: &str, request_id: &str, said: &str) -> Option<Claim> {
    claim(agent_id, request_id, said).ok()
}

/// Whether someone is answering this card right now.
pub fn in_flight(request_id: &str) -> bool {
    in_flight_map().contains_key(request_id)
}

/// The store wrote nothing for an answer that held the claim: something
/// that isn't an answer (expiry is held off; a card set aside by its own
/// flow) closed it first. The card as it reads now says what.
pub fn lost(agent_id: &str, request_id: &str) -> CommandError {
    match store::find_approval(agent_id, request_id) {
        Ok(Some(card)) => already(&answered_word(&card)),
        _ => CommandError::expected("That request no longer exists."),
    }
}

#[cfg(test)]
#[path = "answer_gate_tests.rs"]
mod tests;
