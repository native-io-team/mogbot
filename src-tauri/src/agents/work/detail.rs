//! What a turn's steps ran, exactly, and the briefing it was given: kept
//! beside its timeline for the desk only.
//!
//! A step's label is safe by construction ("Ran git push"); a senior engineer
//! still wants the command itself. It is kept here, never on the timeline, so
//! nothing that carries a timeline (the status, the phone, a notification)
//! ever carries it. Only the desk's "Show exact command" reads it, through
//! `agents_step_exact`.
//!
//! Every command is passed through the Keychain redaction and [`scrub`] line
//! by line before it is written, and through the redaction again as it is
//! read (a secret saved after the turn is blanked too), then clipped to
//! [`EXACT_CHARS`].
//!
//! On disk: `<home>/turn-detail/<message-id>.json`, one per kept timeline,
//! and pruned with them.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::store;
use super::{clip, path_for, safe_id, scrub};

/// Longest exact command kept, in characters.
pub const EXACT_CHARS: usize = 4_000;

/// What a turn kept beside its timeline.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    /// Each step's exact command, by its index among all the turn's steps.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exacts: BTreeMap<u32, String>,
    /// The key of the briefing it was given (`agents::briefing`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub briefing: Option<String>,
}

impl Kept {
    fn is_empty(&self) -> bool {
        self.exacts.is_empty() && self.briefing.is_none()
    }
}

/// What a call ran, raw, as the engine sent it: a shell command as its
/// command line, anything else as the tool's name and its input.
pub fn exact_of(name: &str, input: Option<&Value>) -> Option<String> {
    let input = input?;
    let command = match input.get("command") {
        Some(Value::String(c)) => Some(c.trim().to_string()),
        // Codex's command arrays: `["bash", "-lc", "npm test"]`.
        Some(Value::Array(parts)) => {
            let words: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
            (words.len() == parts.len()).then(|| words.join(" "))
        }
        _ => None,
    };
    if let Some(command) = command.filter(|c| !c.is_empty()) {
        return Some(command);
    }
    let shown = serde_json::to_string_pretty(input).ok()?;
    let shown = shown.trim();
    if shown.is_empty() || shown == "{}" || shown == "null" {
        return Some(name.to_string());
    }
    Some(format!("{name} {shown}"))
}

/// A raw exact command made safe to keep and show: every known secret
/// replaced, then anything shaped like a credential blanked line by line
/// ([`scrub`]), then clipped. `None` when nothing is left.
pub fn exact(raw: &str) -> Option<String> {
    let redacted = super::super::secrets::redact(raw);
    let scrubbed: Vec<String> = redacted.lines().map(scrub).collect();
    let text = clip(scrubbed.join("\n").trim(), EXACT_CHARS);
    (!text.is_empty()).then_some(text)
}

fn dir(agent_id: &str) -> Option<std::path::PathBuf> {
    Some(store::agent_home(agent_id).ok()?.join("turn-detail"))
}

fn file(agent_id: &str, message_id: &str) -> Option<std::path::PathBuf> {
    safe_id(message_id).then_some(())?;
    Some(dir(agent_id)?.join(format!("{message_id}.json")))
}

/// Keep what the turn that ended on `message_id` ran and was told.
pub fn save(agent_id: &str, message_id: &str, kept: &Kept) {
    if kept.is_empty() || store::is_gone(agent_id) {
        return;
    }
    let Some(path) = file(agent_id, message_id) else {
        return;
    };
    let Ok(mut value) = serde_json::to_value(kept) else {
        return;
    };
    super::super::secrets::redact_value(&mut value);
    let Ok(raw) = serde_json::to_vec(&value) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = store::write_atomic(&path, &raw) {
        tracing::warn!("[Agents] couldn't keep a turn's exact commands: {e}");
    }
}

/// What the turn that ended on `message_id` kept, if anything.
pub fn load(agent_id: &str, message_id: &str) -> Option<Kept> {
    let raw = std::fs::read(file(agent_id, message_id)?).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// One step's exact command, redacted again as it is read.
pub fn step_exact(agent_id: &str, message_id: &str, step: u32) -> Option<String> {
    let kept = load(agent_id, message_id)?;
    let text = kept.exacts.get(&step)?;
    exact(text)
}

/// The briefing key the turn that ended on `message_id` was given.
pub fn briefing_of(agent_id: &str, message_id: &str) -> Option<String> {
    load(agent_id, message_id)?.briefing
}

/// Drop what no kept timeline needs any more, and the briefings nothing
/// points at.
pub fn prune(agent_id: &str) {
    let Some(dir) = dir(agent_id) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut used = HashSet::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let kept_turn = path_for(agent_id, id).is_some_and(|p| p.is_file());
        if !kept_turn {
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        if let Some(key) = load(agent_id, id).and_then(|k| k.briefing) {
            used.insert(key);
        }
    }
    super::super::briefing::prune(agent_id, &used);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_shell_call_keeps_its_command_line() {
        let input =
            json!({ "command": "  npm test -- --watch=false ", "description": "Run tests" });
        assert_eq!(
            exact_of("Bash", Some(&input)).as_deref(),
            Some("npm test -- --watch=false")
        );
        let codex = json!({ "command": ["bash", "-lc", "cargo test"] });
        assert_eq!(
            exact_of("Bash", Some(&codex)).as_deref(),
            Some("bash -lc cargo test")
        );
    }

    #[test]
    fn another_tool_keeps_its_name_and_input() {
        let input = json!({ "file_path": "/p/src/App.tsx" });
        let shown = exact_of("Read", Some(&input)).unwrap();
        assert!(shown.starts_with("Read {"), "{shown}");
        assert!(shown.contains("/p/src/App.tsx"));
        assert_eq!(
            exact_of("TodoWrite", Some(&json!({}))).as_deref(),
            Some("TodoWrite")
        );
        assert_eq!(exact_of("Bash", None), None);
    }

    #[test]
    fn credentials_are_blanked_before_they_are_kept() {
        let raw = "curl -H \"Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123\" https://api.example.com\nexport API_KEY=hunter2hunter2";
        let kept = exact(raw).unwrap();
        assert!(
            !kept.contains("sk-live-abcdefghijklmnopqrstuvwxyz0123"),
            "{kept}"
        );
        assert!(!kept.contains("hunter2hunter2"), "{kept}");
        assert!(kept.contains("curl"));
        assert!(kept.contains('\n'), "lines stay lines: {kept}");
    }

    #[test]
    fn a_known_secret_is_redacted_by_name() {
        crate::agents::secrets::remember_external("zq9-known-value-77", "secret:TEST_DETAIL");
        let kept = exact("echo zq9-known-value-77").unwrap();
        assert!(!kept.contains("zq9-known-value-77"), "{kept}");
    }

    #[test]
    fn a_long_command_is_clipped() {
        let raw = "echo ".to_string() + &"a ".repeat(5_000);
        assert!(exact(&raw).unwrap().chars().count() <= EXACT_CHARS);
        assert_eq!(exact("   "), None);
    }
}
