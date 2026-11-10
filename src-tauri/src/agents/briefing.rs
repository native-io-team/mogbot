//! "What it was told": the briefing a turn was given, read-only, for the desk.
//!
//! Every turn starts with a system prompt the app writes (`runner::
//! system_prompt_for` and what's appended to it: secrets it has, access, the
//! outside-text note) on top of the agent's own CLAUDE.md. Only the CLAUDE.md
//! is the user's to edit; the rest was invisible, so "why did it do that"
//! meant reading Rust. This keeps the text each turn was given, split into
//! its `## ` sections, so the desk can show it.
//!
//! **Kept once, by content.** A briefing barely changes between turns (it is
//! written to stay put, for the engine's cache), so it is stored by a hash of
//! its text: `<home>/briefings/<key>.json`, plus `latest` naming the newest.
//! A turn's timeline points at its key (`work::detail`). Briefings nothing
//! points at are dropped when timelines are pruned.
//!
//! **Redacted.** Every section passes the Keychain redaction as it is kept
//! and again as it is read. Never sent to the phone: only the desk's
//! `agents_turn_briefing` reads it.

use crate::agents::store::OrLog;
use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::secrets;
use super::store;

/// Longest section kept, in characters (a bound agent's CLAUDE.md is the
/// longest; it is already clipped at 40 000 when the prompt is built).
pub const SECTION_CHARS: usize = 60_000;

/// One `## ` section of a briefing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// Its heading, without the `## `; the opening lines are "Who it is".
    pub title: String,
    pub body: String,
}

/// What a turn was told.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Briefing {
    /// When a turn was first given it, ms since the epoch.
    pub at: i64,
    /// The app's part: the system prompt, in its sections, in order.
    pub sections: Vec<Section>,
    /// The agent's own instructions and memory (its CLAUDE.md) as the engine
    /// read them that turn, when they aren't already a section above (a
    /// bound agent's are carried in the prompt itself).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

/// The title of the lines before the first heading.
pub const OPENING: &str = "Who it is";

/// A system prompt split at its `## ` headings. A `### ` heading stays inside
/// its section. Empty sections are dropped. Pure.
pub fn sections(prompt: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    let mut title = OPENING.to_string();
    let mut body: Vec<&str> = Vec::new();
    let flush = |title: &str, body: &mut Vec<&str>, out: &mut Vec<Section>| {
        let text = body.join("\n").trim().to_string();
        body.clear();
        if !text.is_empty() {
            out.push(Section {
                title: title.to_string(),
                body: clip(&text),
            });
        }
    };
    for line in prompt.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            flush(&title, &mut body, &mut out);
            title = heading.trim().to_string();
        } else {
            body.push(line);
        }
    }
    flush(&title, &mut body, &mut out);
    out
}

fn clip(text: &str) -> String {
    if text.chars().count() <= SECTION_CHARS {
        return text.to_string();
    }
    let kept: String = text.chars().take(SECTION_CHARS).collect();
    format!("{kept}\n…")
}

/// The key a briefing is kept under: the start of its text's SHA-256. Pure.
pub fn key_of(prompt: &str, instructions: Option<&str>) -> String {
    let mut hash = Sha256::new();
    hash.update(prompt.as_bytes());
    hash.update([0]);
    hash.update(instructions.unwrap_or("").as_bytes());
    hash.finalize()[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn dir(agent_id: &str) -> Option<PathBuf> {
    Some(store::agent_home(agent_id).ok()?.join("briefings"))
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// Keep the briefing a turn is about to be given, and say it is the newest.
/// Returns its key, for the turn's timeline.
pub fn keep(agent_id: &str, prompt: &str, instructions: Option<&str>, now: i64) -> Option<String> {
    if store::is_gone(agent_id) {
        return None;
    }
    let dir = dir(agent_id)?;
    let key = key_of(prompt, instructions);
    let path = dir.join(format!("{key}.json"));
    if !path.is_file() {
        let briefing = Briefing {
            at: now,
            sections: sections(prompt),
            instructions: instructions
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| clip(t)),
        };
        let mut value = serde_json::to_value(&briefing).ok()?;
        secrets::redact_value(&mut value);
        let raw = serde_json::to_vec(&value).ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        if let Err(e) = store::write_atomic(&path, &raw) {
            tracing::warn!("[Agents] couldn't keep a turn's briefing: {e}");
            return None;
        }
    }
    store::write_atomic(&dir.join("latest"), key.as_bytes()).or_log("the latest briefing key");
    Some(key)
}

/// The briefing kept under `key`, redacted again as it is read.
pub fn read(agent_id: &str, key: &str) -> Option<Briefing> {
    if !valid_key(key) {
        return None;
    }
    let raw = std::fs::read(dir(agent_id)?.join(format!("{key}.json"))).ok()?;
    let mut value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    secrets::redact_value(&mut value);
    serde_json::from_value(value).ok()
}

/// The newest briefing any of its turns was given.
pub fn latest(agent_id: &str) -> Option<Briefing> {
    let key = std::fs::read_to_string(dir(agent_id)?.join("latest")).ok()?;
    read(agent_id, key.trim())
}

/// Drop every briefing but the newest and those in `used`.
pub fn prune(agent_id: &str, used: &HashSet<String>) {
    let Some(dir) = dir(agent_id) else {
        return;
    };
    let latest = std::fs::read_to_string(dir.join("latest")).unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(key) = name.strip_suffix(".json") else {
            continue;
        };
        if key != latest.trim() && !used.contains(key) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_splits_at_its_level_two_headings() {
        let prompt = "You are Scout, one of the user's agents.\n\n## How you talk\n\nPlainly.\n\n### Detail\n\nStill talking.\n\n## Work\n\nDo it.\n\n## Empty\n\n";
        let got = sections(prompt);
        let titles: Vec<&str> = got.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, [OPENING, "How you talk", "Work"]);
        assert!(got[1].body.contains("### Detail"));
        assert_eq!(got[2].body, "Do it.");
    }

    #[test]
    fn a_prompt_with_no_heading_is_one_section() {
        let got = sections("Just one line.");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, OPENING);
    }

    #[test]
    fn the_same_text_has_the_same_key_and_another_another() {
        let a = key_of("## A\n\nx", Some("mine"));
        assert_eq!(a, key_of("## A\n\nx", Some("mine")));
        assert_ne!(a, key_of("## A\n\nx", Some("theirs")));
        assert_ne!(a, key_of("## A\n\ny", Some("mine")));
        assert!(valid_key(&a));
        assert!(!valid_key("../etc"));
    }

    #[test]
    fn a_huge_section_is_clipped() {
        let prompt = format!("## Big\n\n{}", "a".repeat(SECTION_CHARS + 10));
        let got = sections(&prompt);
        assert!(got[0].body.chars().count() <= SECTION_CHARS + 2);
    }
}
