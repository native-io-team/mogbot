//! Settings → Agents → "Agents' browser": one switch, on unless the user
//! turned it off. Off, no turn gets the `browser` server, login cards don't
//! offer it, and a running agents' Chrome is closed.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const FILE: &str = "agent-browser.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default = "on")]
    pub enabled: bool,
}

fn on() -> bool {
    true
}

impl Default for Stored {
    fn default() -> Self {
        Stored { enabled: true }
    }
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    crate::agents::store::agents_root()
        .ok()
        .map(|r| r.join(FILE))
}

pub fn load() -> Stored {
    path()
        .and_then(|p| crate::agents::survive::read_kept(&p, "The agents' own browser setting"))
        .unwrap_or_default()
}

pub fn set_enabled(enabled: bool) -> Result<Stored, crate::errors::CommandError> {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Stored { enabled };
    let p = path().ok_or_else(|| crate::errors::CommandError::expected("No app data folder."))?;
    let bytes = serde_json::to_vec_pretty(&s).map_err(crate::agents::err_other)?;
    crate::agents::store::write_atomic(&p, &bytes)?;
    Ok(s)
}

/// The switch, and this build has the agents' browser at all.
pub fn enabled() -> bool {
    super::COMPILED && load().enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_by_default_and_when_the_file_says_nothing() {
        assert!(Stored::default().enabled);
        let s: Stored = serde_json::from_str("{}").unwrap();
        assert!(s.enabled);
        let s: Stored = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!s.enabled);
    }
}
