//! Whether the user has decided about bringing agents over from another
//! assistant: asked once, at the end of onboarding ("Bring your agents, or
//! start fresh?"), or — for an install from before that question existed —
//! by one card at the top of the Chief's chat (desk) and the phone's home.
//!
//! Once it's decided (an import finished, or "No thanks, start fresh"),
//! import moves to the background: ⌘K, the Chief, Settings → Agents and the
//! phone's ⋯ menu. Saved beside the agents (`import-choice.json`), so the
//! desk and the phone read the same answer; a missing or unreadable file is
//! "undecided".

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Choice {
    #[default]
    Undecided,
    /// An import brought something across.
    Imported,
    /// "No thanks, start fresh".
    Declined,
    /// The user went past the card: they spoke to the Chief without
    /// answering it. It settles the question as Declined does (the card at
    /// the top of the chat and the phone's stop asking), without putting
    /// "no" in their mouth. Observed: a new user who typed a task instead
    /// left the card pinned above the greeting for good, and the phone offer
    /// waiting on it never came.
    Skipped,
}

impl Choice {
    pub fn parse(value: &str) -> Result<Choice, CommandError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "undecided" => Ok(Choice::Undecided),
            "imported" => Ok(Choice::Imported),
            "declined" => Ok(Choice::Declined),
            "skipped" => Ok(Choice::Skipped),
            _ => Err(super::err_invalid(
                "choice",
                "Pick imported, declined or undecided.",
            )),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default, deserialize_with = "lenient")]
    choice: Choice,
    #[serde(default)]
    set_at: i64,
}

/// A value this build doesn't know reads as undecided rather than failing.
fn lenient<'de, D>(deserializer: D) -> Result<Choice, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join("import-choice.json"))
}

fn read() -> Choice {
    path()
        .ok()
        .and_then(|p| {
            super::survive::read_kept::<Saved>(
                &p,
                "Your answer to \"bring your agents or start fresh\"",
            )
        })
        .map(|s| s.choice)
        .unwrap_or_default()
}

fn write(choice: Choice, now: i64) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(&Saved {
        choice,
        set_at: now,
    })
    .map_err(super::err_other)?;
    super::store::write_atomic(&path()?, &json)
}

/// The user's answer (undecided when never given).
pub fn choice() -> Choice {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read()
}

pub fn set(choice: Choice, now: i64) -> Result<(), CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write(choice, now)
}

/// The user spoke to the Chief with the question still open: it counts as
/// gone past. Whether that changed anything (so the UI is told once).
pub fn skip_if_undecided(now: i64) -> bool {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if read() != Choice::Undecided {
        return false;
    }
    match write(Choice::Skipped, now) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("could not record the import choice: {e}");
            false
        }
    }
}

/// An import that brought something across answers the question for good.
/// "Declined" turns into "imported" too: they changed their mind and did it.
pub fn record_import(now: i64) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if read() == Choice::Imported {
        return;
    }
    if let Err(e) = write(Choice::Imported, now) {
        tracing::warn!("could not record the import choice: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choices_are_plain_words_and_unknown_ones_read_as_undecided() {
        assert_eq!(serde_json::to_value(Choice::Declined).unwrap(), "declined");
        assert_eq!(serde_json::to_value(Choice::Skipped).unwrap(), "skipped");
        assert_eq!(Choice::parse("Imported").unwrap(), Choice::Imported);
        assert!(Choice::parse("maybe").is_err());
        let saved: Saved = serde_json::from_str(r#"{"choice":"later"}"#).unwrap();
        assert_eq!(saved.choice, Choice::Undecided);
        let saved: Saved = serde_json::from_str("{}").unwrap();
        assert_eq!(saved.choice, Choice::Undecided);
    }

    #[test]
    fn the_choice_is_saved_beside_the_agents_and_an_import_settles_it() {
        let _serial = super::super::store::tests_lock();
        let root = tempfile::tempdir().unwrap();
        super::super::store::set_root_for_tests(Some(root.path().to_path_buf()));
        assert_eq!(choice(), Choice::Undecided);
        set(Choice::Declined, 5).unwrap();
        assert_eq!(choice(), Choice::Declined);
        record_import(6);
        assert_eq!(choice(), Choice::Imported);
        // Going past it settles only an open question, never an answer.
        assert!(!skip_if_undecided(7));
        assert_eq!(choice(), Choice::Imported);
        std::fs::remove_file(root.path().join("import-choice.json")).unwrap();
        assert!(skip_if_undecided(8));
        assert_eq!(choice(), Choice::Skipped);
        assert!(!skip_if_undecided(9));
        record_import(10);
        assert_eq!(choice(), Choice::Imported);
        std::fs::write(root.path().join("import-choice.json"), "not json").unwrap();
        assert_eq!(choice(), Choice::Undecided);
        super::super::store::set_root_for_tests(None);
    }
}
