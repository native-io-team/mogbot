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

/// The hidden note for the agent's next turn, when its replies this turn
/// gave up (see the module docs). `None` when they didn't.
pub fn lazy_reply_note(replies: &[AgentMessage]) -> Option<String> {
    let mut said: Vec<String> = Vec::new();
    let mut fixes: Vec<&str> = Vec::new();
    for m in replies
        .iter()
        .filter(|m| m.kind == MessageKind::Agent && m.room.is_none())
    {
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
        let note = lazy_reply_note(&[observed]).expect("flagged");
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
            assert_eq!(lazy_reply_note(&[reply(text)]), None, "{text}");
        }
        // The user's own words, or another agent's, aren't the agent's reply.
        let mut user = reply("I have no Slack tool, can you help?");
        user.kind = MessageKind::User;
        assert_eq!(lazy_reply_note(&[user]), None);
    }

    #[test]
    fn plumbing_alone_is_a_one_line_reminder() {
        let note = lazy_reply_note(&[reply("I'll use share_result for the report.")]).unwrap();
        assert!(note.contains("share_result"));
        assert!(!note.contains("access chain"));
    }
}
