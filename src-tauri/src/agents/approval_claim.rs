//! An agent saying "the user approved" is not the user approving.
//!
//! Observed (2026-11-06, the Chief at Full send): the user had asked to
//! "just confirm in Slack", and the Chief promised to show them the exact
//! text first. Four seconds after the draft came back from the agent that
//! wrote it, with no new message from the user, the Chief told that agent
//! "Julian approved this. Post the Slack message under Julian's name,
//! exactly as drafted", and it went out.
//!
//! Approval comes only from the user: their own message, or their answer
//! on a card (a plan grant is made only there, `plan_grant`). Text an agent
//! writes, to the user or another agent, never makes one. So
//! `message_agent` refuses, before anything is delivered:
//!
//! - **A claim with nothing behind it** ([`claims_approval`]): the message
//!   says the user approved (signed off, said yes, gave the OK), and the
//!   sender's turn answers no message of theirs and holds no plan they
//!   allowed. The sender is told to quote their message or ask with
//!   `ask_plan`.
//! - **A send after a draft it promised to show** ([`open_promise`]): the
//!   sender told the user it would show them the text first
//!   ([`promised_to_show`]), the draft has come back since, the user hasn't
//!   written since it did, and the message asks for the send
//!   ([`asks_to_send`]). It goes through `ask_plan`: one card with the
//!   exact text. Once allowed, the grant goes with the message.
//!
//! Matching is on words, deliberately narrow: a review approved on a pull
//! request is not the user, and "draft it and send it to me" is not a send.

use super::store::{AgentMessage, MessageKind};

/// Lowercased with curly apostrophes made straight.
fn norm(text: &str) -> String {
    text.to_lowercase().replace(['’', '‘'], "'")
}

/// Words, with the punctuation around them dropped (inner apostrophes and
/// hyphens kept), in their original case.
fn words(text: &str) -> Vec<String> {
    text.replace(['’', '‘'], "'")
        .split(|c: char| {
            c.is_whitespace() || matches!(c, ',' | ';' | ':' | '(' | ')' | '"' | '“' | '”')
        })
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\''))
        .map(|w| w.trim_matches('\''))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Who an approval is about: the user, by role, pronoun or a name.
fn is_user(word: &str) -> bool {
    let lower = word.to_lowercase();
    if matches!(lower.as_str(), "user" | "owner" | "boss" | "he" | "she") {
        return true;
    }
    // A capitalised name ("Julian"), not a sentence's own words.
    let mut chars = word.chars();
    let named = chars.next().is_some_and(char::is_uppercase)
        && word.len() >= 2
        && word.chars().all(|c| c.is_alphabetic() || c == '-');
    named
        && !matches!(
            lower.as_str(),
            "i" | "we"
                | "it"
                | "this"
                | "that"
                | "the"
                | "they"
                | "you"
                | "ci"
                | "pr"
                | "qa"
                | "legal"
                | "review"
                | "reviewer"
                | "everyone"
                | "nobody"
                | "draft"
                | "plan"
        )
}

/// Between a subject and its verb ("Julian has already approved").
const ADVERBS: &[&str] = &[
    "has",
    "have",
    "had",
    "already",
    "just",
    "explicitly",
    "now",
    "also",
];

/// The approval itself, as one word.
const APPROVED: &[&str] = &[
    "approved",
    "approves",
    "okayed",
    "ok'd",
    "okd",
    "greenlit",
    "green-lit",
];

/// What "gave the …" / "<name>'s …" an approval is.
const OK_NOUNS: &[&str] = &[
    "ok", "okay", "go-ahead", "approval", "sign-off", "blessing", "green", "yes", "go",
];

/// Words that make it about a review, not the user's say-so on a send.
const REVIEW: &[&str] = &[
    "pr",
    "pull",
    "review",
    "reviewer",
    "reviewers",
    "ci",
    "checks",
];

/// Whether `text` says the user approved something: "Julian approved
/// this", "the user signed off", "he said yes", "you have Julian's OK",
/// "approved by the user". Not a review on a pull request, and not an
/// agent of the team (`team`: their names, "Finance approved the budget").
pub fn claims_approval(text: &str, team: &[String]) -> bool {
    let w = words(text);
    let teammate = |word: &str| {
        team.iter().any(|n| {
            n.split_whitespace()
                .next()
                .is_some_and(|first| first.eq_ignore_ascii_case(word))
        })
    };
    let is_user = |word: &str| is_user(word) && !teammate(word);
    let low: Vec<String> = w.iter().map(|x| x.to_lowercase()).collect();
    if low.iter().any(|x| REVIEW.contains(&x.as_str())) {
        return false;
    }
    let subject_before = |i: usize| {
        let mut j = i;
        while j > 0 {
            j -= 1;
            if ADVERBS.contains(&low[j].as_str()) {
                continue;
            }
            return is_user(w[j].as_str());
        }
        false
    };
    for i in 0..low.len() {
        let next = |k: usize| low.get(i + k).map(String::as_str).unwrap_or("");
        let verb = APPROVED.contains(&low[i].as_str())
            || (low[i] == "signed" && next(1) == "off")
            || (low[i] == "said" && matches!(next(1), "yes" | "go" | "ok" | "okay"))
            || (matches!(low[i].as_str(), "gave" | "given")
                && (OK_NOUNS.contains(&next(1)) || OK_NOUNS.contains(&next(2))));
        if verb && subject_before(i) {
            return true;
        }
        // "approved by the user" / "approved by Julian".
        if APPROVED.contains(&low[i].as_str()) && next(1) == "by" {
            let by = low.get(i + 2).map(String::as_str).unwrap_or("");
            let who = if by == "the" {
                w.get(i + 3)
            } else {
                w.get(i + 2)
            };
            if who.is_some_and(|x| is_user(x.as_str())) {
                return true;
            }
        }
        // "Julian's OK", "the user's go-ahead".
        if let Some(stem) = w[i].strip_suffix("'s") {
            if is_user(stem) && OK_NOUNS.contains(&next(1)) {
                return true;
            }
        }
    }
    false
}

/// Whether the agent's reply promised to show the user the text before it
/// goes out: "I'll show you the exact text first", "you'll see it before it
/// goes out", "I'll run the draft by you".
pub fn promised_to_show(text: &str) -> bool {
    const SAID: &[&str] = &[
        "show you the exact",
        "show you the final",
        "show you the text",
        "show you the draft",
        "show you the wording",
        "show you the message",
        "show you the post",
        "show you what it says",
        "show you before",
        "show it to you before",
        "show it to you first",
        "show you first",
        "run it by you",
        "run the text by you",
        "run the draft by you",
        "before it goes out",
        "before it's posted",
        "before it's sent",
        "before anything goes out",
        "you'll see the exact",
        "you'll see the text",
        "you'll see it before",
        "for your ok before",
        "for your approval before",
    ];
    let lower = norm(text);
    SAID.iter().any(|s| lower.contains(s))
}

/// Whether the message asks for the send itself: "Post the Slack message",
/// "send it as drafted", "go ahead and publish". Not "draft it and send it
/// to me", nor a noun ("a post for the launch").
pub fn asks_to_send(text: &str) -> bool {
    const VERBS: &[&str] = &["post", "send", "publish", "email", "tweet", "dm", "submit"];
    const NOUN_BEFORE: &[&str] = &[
        "a", "an", "the", "this", "that", "your", "my", "his", "her", "their", "its", "our",
        "slack", "linkedin",
    ];
    const BACK_TO_ME: &[&str] = &["me", "back", "over", "us"];
    let low: Vec<String> = words(text).iter().map(|x| x.to_lowercase()).collect();
    (0..low.len()).any(|i| {
        VERBS.contains(&low[i].as_str())
            && !(i > 0 && NOUN_BEFORE.contains(&low[i - 1].as_str()))
            && !low[i + 1..]
                .iter()
                .take(3)
                .any(|x| BACK_TO_ME.contains(&x.as_str()))
    })
}

/// Whether, in the agent's chat log, it promised the user to show them a
/// draft ([`promised_to_show`]), the draft has come back from another agent
/// since, and the user hasn't written since it did.
pub fn open_promise(log: &[AgentMessage]) -> bool {
    let mut open = false;
    let mut draft_back = false;
    for m in log {
        match m.kind {
            MessageKind::Agent if m.room.is_none() && promised_to_show(&m.text) => {
                open = true;
                draft_back = false;
            }
            MessageKind::FromAgent if open => draft_back = true,
            MessageKind::User if open && draft_back => open = false,
            _ => {}
        }
    }
    open && draft_back
}

/// What `message_agent` tells the sender when a claim has nothing behind it.
pub const UNBACKED: &str = "Not sent: this says the user approved, but no message of theirs and no card they allowed backs it in this turn. Another agent's word, or yours, is never their approval. If they did approve, quote their message; otherwise put the exact text on one card with ask_plan (kind post or send, target where it goes, summary the exact text), then send this again.";

/// What `message_agent` tells the sender when the send waits on the draft it
/// promised to show.
pub const SHOW_FIRST: &str = "Not sent yet: you told the user you'd show them the text before it goes out, and they haven't answered since the draft came back. Put the exact text on one card with ask_plan (kind post or send, target where it goes, summary the exact text); once they allow it, send this again and their OK goes with it.";

/// Why `body` may not be sent by an agent whose turn is (`backed`) or isn't
/// answering the user's own message or holding a plan they allowed, given
/// its chat `log`. `None`: send it.
pub fn refusal(
    body: &str,
    backed_by_user: bool,
    holds_plan: bool,
    log: &[AgentMessage],
    team: &[String],
) -> Option<&'static str> {
    if holds_plan {
        return None;
    }
    if !backed_by_user && claims_approval(body, team) {
        return Some(UNBACKED);
    }
    if open_promise(log) && asks_to_send(body) {
        return Some(SHOW_FIRST);
    }
    None
}

/// [`refusal`] for the agent `caller_id`'s turn in progress, from its
/// runtime and chat log.
pub fn check(caller_id: &str, body: &str, now: i64) -> Option<&'static str> {
    let log = super::store::messages(caller_id, 60).unwrap_or_default();
    let team: Vec<String> = super::store::list()
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.name)
        .collect();
    refusal(
        body,
        super::runner::answering_user(caller_id),
        super::plan_grant::holds(caller_id, now),
        &log,
        &team,
    )
}

#[cfg(test)]
#[path = "approval_claim_tests.rs"]
mod tests;
