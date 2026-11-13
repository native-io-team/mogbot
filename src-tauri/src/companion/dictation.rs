//! `dictation.transcribe`: the phone's dictation written out again on this
//! computer (`crate::voice`: Whisper, then the names pass), as the desk's
//! own is (`commands/dictation.rs`). The phone uploads the session's 16 kHz
//! WAV as a blob; the router reads it, consumes it at once (the audio is
//! never kept) and hands the samples to the backend, which adds the names
//! and the conversation the desk would add.
//!
//! What's pure is here: the names (agents, and projects as they're said
//! aloud) and the context (the conversation's last few lines), the same
//! shapes as the desk's `dictationVocabulary` and `dictationContext`
//! (`src/lib/dictation.ts`).

use serde::Serialize;

/// At most this many lines of the conversation go to the names pass.
pub const CONTEXT_LINES: usize = 8;
/// And at most this many characters of them.
pub const CONTEXT_MAX: usize = 2_000;

/// What `dictation.transcribe` answers. `text: null` means "keep what you
/// have": no model yet (`preparing`, and its one-time download has been
/// started), too little sound, or Whisper failed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcribed {
    pub text: Option<String>,
    /// Whisper's own words, before the names pass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// The names pass ran and changed something.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tidied: Option<bool>,
    /// The speech model is still being fetched (once): nothing this time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preparing: Option<bool>,
}

impl Transcribed {
    pub fn preparing() -> Self {
        Self {
            preparing: Some(true),
            ..Self::default()
        }
    }

    pub fn from_improved(improved: Option<crate::voice::Improved>) -> Self {
        match improved {
            Some(i) => Self {
                text: Some(i.text),
                raw: Some(i.raw),
                tidied: Some(i.tidied),
                preparing: None,
            },
            None => Self::default(),
        }
    }
}

/// Names worth recognising: agents, and projects as they're said aloud
/// ("acme-marketing" → "acme marketing"), each once. The desk's
/// `dictationVocabulary`; `clean_contextual_strings` trims and caps it.
pub fn vocabulary(
    agents: impl IntoIterator<Item = String>,
    projects: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let spoken = projects.into_iter().map(|name| {
        name.split(|c| c == '-' || c == '_' || c == '.')
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string()
    });
    let mut out: Vec<String> = Vec::new();
    for name in agents.into_iter().chain(spoken) {
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// The conversation's last few lines, oldest first, as "Me: …" /
/// "<Agent>: …", whitespace folded, at most [`CONTEXT_LINES`] and
/// [`CONTEXT_MAX`] characters (the desk's `dictationContext`). `lines` is
/// (who, text), oldest first. `None` when there's nothing to say.
pub fn context(lines: &[(String, String)]) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut size = 0;
    for (who, text) in lines.iter().rev() {
        if out.len() >= CONTEXT_LINES {
            break;
        }
        let said = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if said.is_empty() {
            continue;
        }
        let line = format!("{who}: {said}");
        let n = line.chars().count();
        if size + n > CONTEXT_MAX {
            break;
        }
        size += n;
        out.push(line);
    }
    if out.is_empty() {
        return None;
    }
    out.reverse();
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn names_are_agents_then_projects_as_said_once_each() {
        assert_eq!(
            vocabulary(
                s(&["Priya", "Chief of Staff"]),
                s(&["acme-marketing", "my_site.v2", "Priya"])
            ),
            s(&["Priya", "Chief of Staff", "acme marketing", "my site v2"])
        );
    }

    #[test]
    fn context_keeps_the_last_eight_lines_oldest_first() {
        let lines: Vec<(String, String)> = (0..12)
            .map(|i| ("Me".to_string(), format!("line {i}")))
            .chain([("Priya".to_string(), "  ".to_string())])
            .collect();
        let said = context(&lines).unwrap();
        assert_eq!(said.lines().count(), 8);
        assert!(said.starts_with("Me: line 4"));
        assert!(said.ends_with("Me: line 11"));
    }

    #[test]
    fn context_folds_whitespace_and_stays_under_its_cap() {
        let long = "word ".repeat(600);
        let lines = vec![
            ("Me".to_string(), "Ask   Priya\nabout it".to_string()),
            ("Priya".to_string(), long),
        ];
        // The newest line alone is past the cap: nothing older is reached.
        assert_eq!(context(&lines), None);
        let lines = vec![
            ("Me".to_string(), "Ask   Priya\nabout it".to_string()),
            ("Priya".to_string(), "On it.".to_string()),
        ];
        assert_eq!(
            context(&lines).as_deref(),
            Some("Me: Ask Priya about it\nPriya: On it.")
        );
        assert_eq!(context(&[]), None);
    }

    #[test]
    fn nothing_better_says_keep_what_you_have() {
        let none = serde_json::to_value(Transcribed::from_improved(None)).unwrap();
        assert_eq!(none, serde_json::json!({ "text": null }));
        let preparing = serde_json::to_value(Transcribed::preparing()).unwrap();
        assert_eq!(
            preparing,
            serde_json::json!({ "text": null, "preparing": true })
        );
    }
}
