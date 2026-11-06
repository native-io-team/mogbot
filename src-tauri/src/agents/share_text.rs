//! Text sent with a shared file (`share_file`), and the guard for the turn
//! that was asked for text but sent only labelled files.
//!
//! A real case: asked for "full text then image, post by post", an agent sent
//! six images each with a caption like "1 of 6 · Fri 10am" and then said the
//! posts had gone out exactly as written. `caption` was described as one short
//! line, so it used it as one, and believed each item was complete. Now the
//! tool takes the item's whole `text`, and a turn that still sends only short
//! labels when the user asked for text leaves its next turn a quiet note.

use super::store::{AgentMessage, MessageKind};

/// A file message's text: the label first (when there is one), then the full
/// text. Either alone is used as it is; a label the text already contains
/// isn't said twice.
pub fn message_text(caption: &str, text: &str) -> String {
    let caption = caption.trim();
    let text = text.trim();
    match (caption.is_empty(), text.is_empty()) {
        (true, true) => String::new(),
        (false, true) => caption.to_string(),
        (true, false) => text.to_string(),
        (false, false) if text.contains(caption) => text.to_string(),
        (false, false) => format!("{caption}\n\n{text}"),
    }
}

/// Under this many characters a file's text is a label, not the text.
pub const LABEL_CHARS: usize = 40;

/// Words that mean the user asked for the text itself.
const ASKED_FOR_TEXT: &[&str] = &[
    "text", "texts", "copy", "caption", "captions", "full", "wording", "words",
];

/// Whether the user's words ask for text (whole words, any case).
pub fn asks_for_text(user_said: &str) -> bool {
    user_said
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| ASKED_FOR_TEXT.contains(&w.to_lowercase().as_str()))
}

/// The note for the agent's next turn, when the user asked for text and the
/// turn's reply (`replies`: what the agent said in it) shared files with
/// short labels only.
///
/// Only the messages that carry files are judged: a wrap-up ("That's all six
/// posts, each exactly as written…") is about the items, not their text, and
/// any message of 160 characters or more used to switch the check off.
pub fn labels_only_note(user_said: &str, replies: &[AgentMessage]) -> Option<String> {
    if !asks_for_text(user_said) {
        return None;
    }
    let files: Vec<&AgentMessage> = replies
        .iter()
        .filter(|m| m.kind == MessageKind::Agent && !m.attachments.is_empty())
        .collect();
    if files.is_empty() {
        return None;
    }
    let len = |m: &AgentMessage| m.text.trim().chars().count();
    if files.iter().any(|m| len(m) >= LABEL_CHARS) {
        return None;
    }
    Some(LABELS_ONLY_NOTE.to_string())
}

pub const LABELS_ONLY_NOTE: &str = "[A note from the app, not the user: your last reply sent images or files with short labels only; the user asked for the full text. Re-read what you actually sent above. If the text is missing, send each item again with `share_file`, its full text in `text` and the file in `path`, and don't say it was already sent.]\n\n";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::attachments::Attachment;

    fn reply(text: &str, file: bool) -> AgentMessage {
        let mut m = crate::agents::runner::new_message("a1", MessageKind::Agent, text);
        if file {
            m.attachments = vec![Attachment {
                name: "post-1.png".into(),
                path: "attachments/m1/post-1.png".into(),
                mime: "image/png".into(),
                size: 10,
            }];
        }
        m
    }

    #[test]
    fn the_full_text_follows_the_label() {
        let copy = "Fresh sourdough, out of the oven at 7.\n\n**Come early** - it goes fast.";
        assert_eq!(
            message_text("1 of 6 · Fri 10am", copy),
            format!("1 of 6 · Fri 10am\n\n{copy}")
        );
        assert_eq!(message_text("", copy), copy);
        assert_eq!(message_text("1 of 6", ""), "1 of 6");
        assert_eq!(message_text("  ", " "), "");
        // A label the text already opens with isn't said twice.
        assert_eq!(message_text("Post 1", "Post 1\n\nHello"), "Post 1\n\nHello");
    }

    #[test]
    fn the_text_is_what_the_message_stores_and_shows() {
        // `share_file` records exactly this as the message's `text`, the field
        // both the desk and the phone render above the file.
        let copy = "Line one\nLine two\n\n- a point";
        let m = reply(&message_text("2 of 6", copy), true);
        assert_eq!(m.text, "2 of 6\n\nLine one\nLine two\n\n- a point");
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["text"], m.text);
        assert_eq!(json["attachments"][0]["name"], "post-1.png");
    }

    #[test]
    fn asking_for_text_is_whole_words_in_any_case() {
        assert!(asks_for_text("FULL TEXT THEN IMAGE POST BY POST"));
        assert!(asks_for_text("Where da text"));
        assert!(asks_for_text("send the copy for each"));
        assert!(asks_for_text("captions please"));
        assert!(!asks_for_text("send me the images"));
        assert!(!asks_for_text("context and textures")); // not whole words
    }

    #[test]
    fn labels_only_after_asking_for_text_leaves_a_note() {
        let replies = vec![
            reply("1 of 6 · Fri 10am", true),
            reply("2 of 6 · Sat 9am", true),
            reply(
                "That's all six scheduled posts, each exactly as set to go out",
                false,
            ),
        ];
        assert_eq!(
            labels_only_note("FULL TEXT THEN IMAGE POST BY POST", &replies).as_deref(),
            Some(LABELS_ONLY_NOTE)
        );
        assert_eq!(
            labels_only_note("Where da text", &replies[..2]).as_deref(),
            Some(LABELS_ONLY_NOTE)
        );
    }

    #[test]
    fn a_long_wrap_up_no_longer_switches_the_check_off() {
        // Only the messages with files are judged: a 160+ character wrap-up
        // said nothing of the items' text.
        let replies = vec![
            reply("1 of 6 · Fri 10am", true),
            reply("2 of 6 · Sat 9am", true),
            reply(
                &"That's all six scheduled posts, each exactly as set to go out. ".repeat(3),
                false,
            ),
        ];
        assert!(replies[2].text.chars().count() >= 160);
        assert_eq!(
            labels_only_note("full text then image", &replies).as_deref(),
            Some(LABELS_ONLY_NOTE)
        );
    }

    #[test]
    fn no_note_when_the_text_was_sent_or_not_asked_for() {
        let labels = vec![reply("1 of 6", true)];
        // Not asked for text.
        assert_eq!(labels_only_note("send the images", &labels), None);
        // The file carried its text.
        let full = vec![reply(
            &message_text(
                "1 of 6",
                "Fresh sourdough at 7, come early, it goes fast every day.",
            ),
            true,
        )];
        assert_eq!(labels_only_note("full text please", &full), None);
        // No file at all.
        assert_eq!(labels_only_note("full text", &[reply("ok", false)]), None);
        // What the user said isn't the agent's.
        let mut user = reply("1 of 6", true);
        user.kind = MessageKind::User;
        assert_eq!(labels_only_note("full text", &[user]), None);
    }
}
