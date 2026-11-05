//! How much the user's agents do on their own: one choice for the whole team,
//! asked once in onboarding and kept in Settings → Agents (and the phone).
//!
//! **Levels.** `Often` ("Check with me often"): plans are confirmed before a
//! change with several steps. `Judgement` ("Use good judgement", the
//! default): finish the job, and only ask for what's really the user's to
//! decide or do. `GoHard` ("Go hard — get it done"): finish what you're
//! asked, and before asking the user to do anything, check that they haven't
//! already asked for it and that every way you have of doing it yourself has
//! been tried.
//!
//! **What it changes.** The level is one short, app-owned section of every
//! agent's system prompt ([`prompt_section`]), built from code each turn, so
//! existing and imported agents get it on their next turn and nothing in
//! their own CLAUDE.md is touched. It changes only when the user changes the
//! level, never per turn, so the engine's prompt cache holds. It also decides
//! which *local* cards are answered for the user (`agents::autoallow`):
//! "Use good judgement" answers reads, "Go hard" reads and local work in the
//! home. Every card that asks before spending, sending, publishing, pushing,
//! sharing, deleting the user's files or touching credentials appears at
//! every level.
//! The browser (`browser_gate`): above "Check with me often", looking around
//! and clicks that don't send go through without a card; sending asks.
//!
//! **Outside text never goes hard.** A turn answering outside text (a
//! "When…" routine's items, or anything that carried their taint through
//! `message_agent` or a room) runs at most at `Judgement` ([`for_turn`]):
//! text from outside never gets "carry on without asking" or a write without
//! a card, yet unattended routines still finish their work; the approval
//! wall and the taint gate anything consequential.
//!
//! Saved beside the agents (`independence.json`); a missing or unreadable
//! file is the default.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Often,
    #[default]
    Judgement,
    GoHard,
}

impl Level {
    pub fn parse(value: &str) -> Result<Level, CommandError> {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str()
        {
            "often" | "check_with_me_often" => Ok(Level::Often),
            "judgement" | "judgment" | "use_good_judgement" => Ok(Level::Judgement),
            "go_hard" => Ok(Level::GoHard),
            _ => Err(super::err_invalid(
                "level",
                "Pick often (Check with me often), judgement (Use good judgement) or go_hard (Go hard).",
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Level::Often => "Check with me often",
            Level::Judgement => "Use good judgement",
            Level::GoHard => "Go hard — get it done",
        }
    }

    /// The level in a receipt line ("Allowed automatically — Go hard").
    pub fn short(self) -> &'static str {
        match self {
            Level::Often => "Check with me often",
            Level::Judgement => "Use good judgement",
            Level::GoHard => "Go hard",
        }
    }
}

const HEADING: &str = "## How much to do on your own";

/// Said at every level: the level is about how the agent works, never about
/// what needs the user's OK.
const WALL: &str = "Approvals don't change with this: anything that needs the user's OK still asks through a card in this chat.";

const OFTEN: &str = "The user chose \"Check with me often\". Before a change with several steps, \
or anything that's hard to undo, say your plan in a few lines and wait for their go-ahead. \
Answering, reading and looking things up don't need it. If you can't finish, say exactly what's left and why.";

const JUDGEMENT: &str = "The user chose \"Use good judgement\". Do what you're asked through to the end. \
Before asking the user to do something, check whether you can do it yourself with your tools, their \
connected apps and the files and CLIs on this Mac, and if you can, do it. Ask when a choice is really \
theirs, or a step needs their money, their identity, or sending or publishing as them. If you can't \
finish, say exactly what's left and why.";

const GO_HARD: &str = "The user chose \"Go hard — get it done\". Finish what you're asked. Before asking \
the user to do anything, check: did they already ask you to do it, and have you actually tried every way \
you have (your tools, their connected apps, their signed-in browser if allowed, the files and CLIs on this \
Mac)? Only stop for things that need their money, their identity, sending or publishing as them, or \
deleting their data: ask once, clearly, then carry on with everything else. Never end a turn with the task \
silently unfinished; say exactly what's left and why.";

/// The section for `level`. Short and fixed per level, so the prompt (and
/// its cache) only changes when the user changes the level.
pub fn prompt_section(level: Level) -> String {
    let body = match level {
        Level::Often => OFTEN,
        Level::Judgement => JUDGEMENT,
        Level::GoHard => GO_HARD,
    };
    format!("{HEADING}\n\n{body} {WALL}")
}

/// The level a turn runs at: the user's, but never "Go hard" when it answers
/// outside text. Unattended routines still do their work at "Use good
/// judgement" (a plan-and-wait level would leave them unfinished); the
/// approval wall and the outside-text taint gate everything consequential.
pub fn for_turn(chosen: Level, outside: bool) -> Level {
    if outside && chosen == Level::GoHard {
        Level::Judgement
    } else {
        chosen
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default, deserialize_with = "lenient_level")]
    level: Level,
    #[serde(default)]
    set_at: i64,
}

/// A level this build doesn't know (a newer app's, a hand edit) reads as
/// the default rather than failing.
fn lenient_level<'de, D>(deserializer: D) -> Result<Level, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join("independence.json"))
}

/// The user's level (the default when never set).
pub fn level() -> Level {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
        .map(|s| s.level)
        .unwrap_or_default()
}

pub fn set_level(level: Level, now: i64) -> Result<(), CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let json =
        serde_json::to_vec_pretty(&Saved { level, set_at: now }).map_err(super::err_other)?;
    super::store::write_atomic(&path()?, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_level_has_its_own_short_fixed_section() {
        let sections: Vec<String> = [Level::Often, Level::Judgement, Level::GoHard]
            .into_iter()
            .map(prompt_section)
            .collect();
        for s in &sections {
            assert!(s.starts_with(HEADING));
            assert!(s.ends_with(WALL), "every level says approvals don't change");
            // Short enough to sit in every prompt without weighing on it.
            assert!(s.chars().count() < 900, "{}", s.chars().count());
            // Nothing that changes per turn: the cache holds.
            assert!(!s.chars().any(|c| c.is_ascii_digit()));
        }
        assert_eq!(sections.len(), 3);
        assert_ne!(sections[0], sections[1]);
        assert_ne!(sections[1], sections[2]);
        assert_eq!(prompt_section(Level::GoHard), prompt_section(Level::GoHard));

        let often = &sections[0];
        assert!(often.contains("wait for their go-ahead"));
        let go_hard = &sections[2];
        assert!(go_hard.contains("did they already ask you to do it"));
        assert!(go_hard.contains("tried every way you have"));
        assert!(go_hard.contains("their money, their identity, sending or publishing as them"));
        assert!(go_hard.contains("deleting their data"));
        assert!(go_hard.contains("Never end a turn with the task silently unfinished"));
        assert!(!go_hard.contains("wait for their go-ahead"));
    }

    #[test]
    fn outside_text_never_goes_hard() {
        assert_eq!(for_turn(Level::GoHard, true), Level::Judgement);
        assert_eq!(for_turn(Level::Judgement, true), Level::Judgement);
        assert_eq!(for_turn(Level::Often, true), Level::Often);
        for chosen in [Level::Often, Level::Judgement, Level::GoHard] {
            assert_eq!(for_turn(chosen, false), chosen);
        }
    }

    #[test]
    fn levels_are_plain_words_and_unknown_ones_read_as_the_default() {
        assert_eq!(serde_json::to_value(Level::GoHard).unwrap(), "go_hard");
        assert_eq!(Level::parse("Go hard").unwrap(), Level::GoHard);
        assert_eq!(Level::parse("judgment").unwrap(), Level::Judgement);
        assert_eq!(Level::parse("often").unwrap(), Level::Often);
        assert!(Level::parse("yolo").is_err());
        let saved: Saved = serde_json::from_str(r#"{"level":"reckless"}"#).unwrap();
        assert_eq!(saved.level, Level::Judgement);
        let saved: Saved = serde_json::from_str("{}").unwrap();
        assert_eq!(saved.level, Level::Judgement);
    }

    #[test]
    fn the_level_is_saved_beside_the_agents_and_defaults_when_missing() {
        let _serial = super::super::store::tests_lock();
        let root = tempfile::tempdir().unwrap();
        super::super::store::set_root_for_tests(Some(root.path().to_path_buf()));
        assert_eq!(level(), Level::Judgement);
        set_level(Level::GoHard, 5).unwrap();
        assert_eq!(level(), Level::GoHard);
        std::fs::write(root.path().join("independence.json"), "not json").unwrap();
        assert_eq!(level(), Level::Judgement);
        super::super::store::set_root_for_tests(None);
    }
}
