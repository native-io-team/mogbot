//! A cheap check after each turn in the agent's own chat for the replies
//! that give up instead of doing: "I have no Slack tool", "Julian would need
//! to say yes to that", or the app's plumbing (`message_agent`) in words
//! meant for the user. The prompt already rules these out (`prompts::AGENCY`,
//! "Plumbing stays out of the chat"); this catches the ones that get through.
//!
//! What it does is deliberately small: the agent's next turn in its chat
//! starts with a hidden note from the app (like `share_text`'s), naming what
//! it said and what to do instead. Nothing is shown to the user, nothing is
//! re-run on its own, and a reply that does the work and mentions a tool in
//! passing costs at most one line of reminder.
//!
//! Observed (2026-11-06, an agent at Go hard): "I also can't post in
//! #agents-errors from here, since I have no Slack tool, and a Slack post
//! goes out under the user's name. Julian would need to say yes to that.
//! Until then, I'd send Nate the note through `message_agent`…"
//!
//! **Needless asks** ([`needless_asks`]), only at "Go hard" and "Full send":
//! a question for an OK the level already gives ("Want me to…?", "Should I
//! file…?", "Do you want me to keep going, or would you rather send them
//! yourself?"). A question about the floor (money, credentials, deleting for
//! good, production or main, exact text the user wants to see) is left alone.
//! Observed (2026-11-06, the Chief at Full send): of 26 questions in a
//! morning, about 20 asked for something the level covered, several after
//! the user had already said "fix all", "you own it" or "STOP ASKING".

use super::independence::Level;
use super::store::{AgentMessage, MessageKind};

/// One way of giving up, and what to do instead.
struct Pattern {
    /// Matched against the lowercased reply, all of `all` in order.
    all: &'static [&'static str],
    fix: &'static str,
}

const NO_TOOL: &str = "\"No tool for it\" is never the answer: go down the access chain (a connection, the command on this Mac, the agents' browser, then the user's own Chrome where they're signed in), and report a block only after the browser route actually failed.";
const ASKS_FIRST: &str = "Don't stop for an OK in chat: do the send, and the app raises the one card for the user itself (at Full send it just goes). Never decline it ahead of time.";
const PLUMBING: &str = "Never name the app's tools or plumbing to the user (`message_agent`, `share_result`, `request_login`, `mcp__…`): say what you did in plain words.";

const PATTERNS: &[Pattern] = &[
    Pattern {
        all: &["i have no ", " tool"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["i don't have a ", " tool"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["i don’t have a ", " tool"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["no ", " tool available"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["without a ", " tool"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["can't ", " from here"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["can’t ", " from here"],
        fix: NO_TOOL,
    },
    Pattern {
        all: &["would need to say yes"],
        fix: ASKS_FIRST,
    },
    Pattern {
        all: &["need to say yes to that"],
        fix: ASKS_FIRST,
    },
    Pattern {
        all: &["would need to approve"],
        fix: ASKS_FIRST,
    },
    Pattern {
        all: &["would need your ok"],
        fix: ASKS_FIRST,
    },
    Pattern {
        all: &["would need your approval"],
        fix: ASKS_FIRST,
    },
    Pattern {
        all: &["message_agent"],
        fix: PLUMBING,
    },
    Pattern {
        all: &["share_result"],
        fix: PLUMBING,
    },
    Pattern {
        all: &["share_file"],
        fix: PLUMBING,
    },
    Pattern {
        all: &["request_login"],
        fix: PLUMBING,
    },
    Pattern {
        all: &["list_agents"],
        fix: PLUMBING,
    },
    Pattern {
        all: &["search_my_chat"],
        fix: PLUMBING,
    },
    Pattern {
        all: &["mcp__"],
        fix: PLUMBING,
    },
];

fn matches(lower: &str, all: &[&str]) -> bool {
    let mut from = 0;
    for part in all {
        match lower[from..].find(part) {
            Some(at) => from += at + part.len(),
            None => return false,
        }
    }
    true
}

/// The sentence of `text` holding byte `at` of its lowercase copy, trimmed.
fn sentence_at(text: &str, needle: &str) -> Option<String> {
    let lower = text.to_lowercase();
    // Lowercasing can change byte lengths; fall back to the whole line then.
    let at = lower.find(needle)?;
    if lower.len() != text.len() {
        return text
            .lines()
            .find(|l| l.to_lowercase().contains(needle))
            .map(|l| l.trim().chars().take(200).collect());
    }
    let start = text[..at].rfind(['.', '!', '?', '\n']).map_or(0, |i| i + 1);
    let end = text[at..]
        .find(['.', '!', '?', '\n'])
        .map_or(text.len(), |i| at + i + 1);
    Some(text[start..end].trim().chars().take(200).collect())
}

const NEEDLESS_ASK: &str = "Your level covers this, so don't ask: do it, then say in a line what you did. A choice (which draft, which way) is yours: pick by your judgement and what they like, and say what you chose. Ask only for spending money, credentials, deleting what can't come back, production or the main branch, or what the user said needs their word, and then once. A yes they already gave (\"fix all\", \"you own it\", \"do it\") covers the steps it takes.";

/// Asking for an OK, or handing the work back, in so many words.
const ASKS: &[&str] = &[
    "want me to",
    "should i ",
    "shall i ",
    "would you like me",
    "would you rather",
    "do you want me",
    "do you want to send",
    "ok to ",
    "okay to ",
    "is it ok",
    "if you're ok with",
    "which do you want",
    "which one?",
    "which of these",
    "which would you",
    "do you prefer",
    "would you prefer",
    "your call",
    "up to you",
    "your decision",
    "you decide",
    "you pick",
    "pick one",
    "let me know which",
    "tell me which",
    "tell me whether",
    "or leave that to you",
    "or leave it to you",
    "or will you",
    "say when to",
    "if you say so",
    "until you say so",
    "without your yes",
    "without your ok",
    "without your word",
];

/// The floor, and the user's own exact-text rule: asking about these is right.
const FLOOR: &[&str] = &[
    "pay",
    "spend",
    "charge",
    "invoice",
    "refund",
    "purchase",
    "buy ",
    "$",
    "€",
    "£",
    "password",
    "credential",
    "token",
    "api key",
    "keychain",
    "sign in",
    "log in",
    "login",
    "2fa",
    "for good",
    "permanently",
    "can't be undone",
    "can't come back",
    "production",
    "main branch",
    "to main",
    "into main",
    "merge",
    "exact text",
    "word for word",
    "wording",
];

/// The sentences of `text` (split on `.`, `!`, `?` and newlines, keeping the
/// mark), trimmed.
pub(super) fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c != '\n' {
            cur.push(c);
        }
        if matches!(c, '.' | '!' | '?' | '\n') {
            let s = cur.trim();
            if !s.is_empty() {
                out.push(s.to_string());
            }
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// "I'll pick one" is the agent deciding, not handing the choice back.
fn own_choice(lower: &str, ask: &str) -> bool {
    ask == "pick one"
        && [
            "i'll pick one",
            "i will pick one",
            "i'd pick one",
            "i pick one",
            "i'll just pick one",
        ]
        .iter()
        .any(|own| lower.contains(own))
}

/// The sentences of `text` that ask for an OK the level already gives, or
/// hand the work back (see the module docs). The floor counts in the
/// sentence or the one before it ("Here's the exact text. Send it?").
pub fn needless_asks(text: &str) -> Vec<String> {
    let all: Vec<String> = sentences(text);
    let low: Vec<String> = all
        .iter()
        .map(|s| s.to_lowercase().replace(['’', '‘'], "'"))
        .collect();
    let floor = |s: &str| FLOOR.iter().any(|f| s.contains(f));
    all.iter()
        .enumerate()
        .filter(|(i, _)| {
            let lower = &low[*i];
            let asks = ASKS
                .iter()
                .any(|a| lower.contains(a) && !own_choice(lower, a))
                || (lower.ends_with('?') && lower.contains("yourself"));
            asks && !floor(lower) && !(*i > 0 && floor(&low[i - 1]))
        })
        .map(|(_, s)| s.chars().take(200).collect())
        .collect()
}

/// The hidden note for the agent's next turn, when its replies this turn
/// gave up (see the module docs), at the level the turn ran at. `None` when
/// they didn't.
pub fn lazy_reply_note(replies: &[AgentMessage], level: Level) -> Option<String> {
    let mut said: Vec<String> = Vec::new();
    let mut fixes: Vec<&str> = Vec::new();
    for m in replies
        .iter()
        .filter(|m| m.kind == MessageKind::Agent && m.room.is_none())
    {
        if level.goes_hard() {
            for s in needless_asks(&m.text) {
                if !said.contains(&s) {
                    said.push(s);
                }
                if !fixes.contains(&NEEDLESS_ASK) {
                    fixes.push(NEEDLESS_ASK);
                }
            }
        }
        let lower = m.text.to_lowercase();
        for p in PATTERNS {
            if matches(&lower, p.all) {
                if let Some(line) = sentence_at(&m.text, p.all[0]) {
                    if !said.contains(&line) {
                        said.push(line);
                    }
                }
                if !fixes.contains(&p.fix) {
                    fixes.push(p.fix);
                }
            }
        }
    }
    if fixes.is_empty() {
        return None;
    }
    let quoted: Vec<String> = said.iter().take(3).map(|s| format!("\"{s}\"")).collect();
    Some(format!(
        "[A note from the app, not the user: your last reply said {}. {} If that work is still wanted, do it now instead of explaining why you didn't. Don't mention this note.]\n\n",
        quoted.join(" and "),
        fixes.join(" ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::runner::new_message;

    fn reply(text: &str) -> AgentMessage {
        new_message("a1", MessageKind::Agent, text)
    }

    /// The reply the owner called lazy, run through the post-turn check.
    #[test]
    fn the_observed_lazy_reply_gets_a_nudge_for_each_failure() {
        let observed = reply("Done with the build notes. I also can't post in #agents-errors from here, since I have no Slack tool, and a Slack post goes out under the user's name. Julian would need to say yes to that. Until then, I'd send Nate the note through `message_agent`.");
        let note = lazy_reply_note(&[observed], Level::GoHard).expect("flagged");
        assert!(note.starts_with("[A note from the app, not the user:"));
        assert!(note.contains("I have no Slack tool"));
        assert!(note.contains("access chain"));
        assert!(note.contains("the app raises the one card"));
        assert!(note.contains("Never name the app's tools"));
        assert!(note.ends_with("]\n\n"));
    }

    #[test]
    fn replies_that_do_the_work_pass() {
        for text in [
            "Posted it to #agents-errors as you, in Slack: https://example.slack.com/archives/C1/p2",
            "The tool tip on the button now says Save.",
            "I'm in Gmail as julian@example.com; the draft is ready to send on the card.",
        ] {
            assert_eq!(lazy_reply_note(&[reply(text)], Level::FullSend), None, "{text}");
        }
        // The user's own words, or another agent's, aren't the agent's reply.
        let mut user = reply("I have no Slack tool, can you help?");
        user.kind = MessageKind::User;
        assert_eq!(lazy_reply_note(&[user], Level::FullSend), None);
    }

    #[test]
    fn plumbing_alone_is_a_one_line_reminder() {
        let note = lazy_reply_note(
            &[reply("I'll use share_result for the report.")],
            Level::Judgement,
        )
        .unwrap();
        assert!(note.contains("share_result"));
        assert!(!note.contains("access chain"));
    }

    /// The shapes of the Chief's needless questions at Full send (names
    /// made up): each is caught, at "Go hard" and "Full send" only.
    #[test]
    fn needless_asks_are_nudged_when_the_level_covers_them() {
        for text in [
            "Found the cause. Do you want me to check out the branch locally and test it there?",
            "It's fixed on the branch. Want me to tell Sam it's fixed in #errors, or leave that to you?",
            "Both bugs are filed. Should I file the two new ones as issues too?",
            "OK to say \"Ohio bookkeeping\" publicly?",
            "Two options: I can draft a short correction, or you can leave it. Tell me which.",
            "Do you want me to keep going one at a time, or would you rather send the six yourself?",
            "The other app is still running. Do you want me to tell you how, or will you quit it yourself?",
            "The Social team can swap those in if you're OK with it.",
            "I'm not taking it on without your word.",
            "Three drafts are below. Which of these do you want to go with?",
            "Keep the lesson with the warning, or drop it? Your call.",
            "Do you prefer the dark image or the light one?",
            // The "Agent sweep" check-in, handing reversible choices back.
            "Both fixes are ready; which goes first is your call.",
            "Pick one, my recommendation is the shorter subject line.",
            "Rename it now or after the review: up to you.",
        ] {
            let note = lazy_reply_note(&[reply(text)], Level::FullSend)
                .unwrap_or_else(|| panic!("flagged at Full send: {text}"));
            assert!(note.contains("Your level covers this"), "{text}");
            assert!(lazy_reply_note(&[reply(text)], Level::GoHard).is_some());
            // Lower levels ask by design.
            assert_eq!(lazy_reply_note(&[reply(text)], Level::Judgement), None, "{text}");
            assert_eq!(lazy_reply_note(&[reply(text)], Level::Often), None, "{text}");
        }
    }

    /// Asking about the floor, or the exact text the user wants to see, is right.
    #[test]
    fn floor_questions_are_left_alone() {
        for text in [
            "OK to redeploy production now?",
            "Should I merge it into main?",
            "Do you want me to pay the $40 invoice?",
            "Should I sign in with the work account? It needs your password.",
            "Want me to delete the backups for good?",
            "Here's the exact text. Should I send it as is?",
            "Sent it to Sam at 10:02. Nothing else is waiting on you.",
            "Did the image land the way you wanted?",
            "Two subject lines were close; I'll pick one and say which.",
        ] {
            assert_eq!(
                lazy_reply_note(&[reply(text)], Level::FullSend),
                None,
                "{text}"
            );
        }
    }
}
