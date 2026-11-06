//! Progress narration goes in the timeline, not the chat.
//!
//! An agent working through something visual writes "Starting the previews…",
//! "Let me check they rendered…", "Screenshots are done" as it goes: four
//! messages that each buzz a phone and say nothing the working line doesn't.
//! So within a turn, a short line the agent writes and then goes on working
//! is folded into that turn's "what it did" timeline as a note, and the chat
//! keeps the turn's final reply and its cards.
//!
//! - **Held, then decided.** A short reply is held rather than recorded.
//!   When the turn does more work (a tool call) or writes again, the held
//!   line was narration: it becomes a note step and its streamed draft is
//!   withdrawn. When the turn ends with it still held, it was the final word,
//!   and it goes into the chat as the reply. Nothing is ever lost: every
//!   folded line is in the timeline, in the agent's words.
//! - **Only what can't matter on its own.** A question, a list, code, a link
//!   or anything long is never folded: it might be the thing the user needs,
//!   so it is recorded as it always was.

/// Longest line that can be folded, in characters.
pub const MAX_CHARS: usize = 240;

/// Whether a reply could be mid-turn narration (decided by what follows).
pub fn foldable(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > MAX_CHARS {
        return false;
    }
    // Two paragraphs, a list, code, a link, a table: content, not narration.
    if t.contains("\n\n")
        || t.contains("```")
        || t.contains('`')
        || t.contains("](")
        || t.contains("http://")
        || t.contains("https://")
        || t.contains('|')
        || t.lines().count() > 2
        || t.lines().any(|l| {
            let l = l.trim_start();
            l.starts_with("- ") || l.starts_with("* ") || l.starts_with("1.")
        })
    {
        return false;
    }
    // A question is for the user, and a blocker must be read.
    if t.contains('?') {
        return false;
    }
    let lower = t.to_lowercase();
    const MUST_READ: [&str; 8] = [
        "waiting on you",
        "allow it",
        "on the card",
        "couldn't",
        "can't",
        "failed",
        "error",
        "blocked",
    ];
    !MUST_READ.iter().any(|w| lower.contains(w))
}

/// The note's label in the timeline: the line itself, on one line.
pub fn note_label(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The reply a turn is holding back to see what follows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    /// The streamed draft's id, when there was one (withdrawn on fold).
    pub draft_id: Option<String>,
    pub text: String,
}

/// What became of a held line.
#[derive(Debug, Clone, PartialEq)]
pub enum Fate {
    /// More work followed: a note in the timeline.
    Fold(Held),
    /// The turn ended on it: the reply.
    Keep(Held),
}

/// One turn's held line.
#[derive(Debug, Default)]
pub struct Narration {
    held: Option<Held>,
    /// The newest line folded, in case the turn says nothing else at all.
    last_folded: Option<String>,
}

impl Narration {
    /// A reply arrived. Returns the earlier held line's fate (folded: it was
    /// followed by more writing) and whether this one is held now; when not
    /// held, the caller records it as it always did.
    pub fn reply(&mut self, draft_id: Option<String>, text: &str) -> (Option<Fate>, bool) {
        let before = self.fold();
        if foldable(text) {
            self.held = Some(Held {
                draft_id,
                text: text.to_string(),
            });
            (before, true)
        } else {
            (before, false)
        }
    }

    /// The turn did more work: a held line was narration.
    pub fn work(&mut self) -> Option<Fate> {
        self.fold()
    }

    fn fold(&mut self) -> Option<Fate> {
        let held = self.held.take()?;
        self.last_folded = Some(held.text.clone());
        Some(Fate::Fold(held))
    }

    /// The turn is over: a held line is its final word. `said` is whether
    /// the turn recorded any reply; when it recorded none, its last folded
    /// line is the reply after all, so the turn never ends in silence.
    pub fn end(&mut self, said: bool) -> Option<Fate> {
        if let Some(held) = self.held.take() {
            return Some(Fate::Keep(held));
        }
        if said {
            return None;
        }
        self.last_folded.take().map(|text| {
            Fate::Keep(Held {
                draft_id: None,
                text,
            })
        })
    }

    pub fn holding(&self) -> bool {
        self.held.is_some()
    }
}

#[cfg(test)]
#[path = "narration_tests.rs"]
mod tests;
