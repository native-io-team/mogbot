//! Settings → Agents → "Your Chrome": one switch, **off** until the user
//! turns it on. Off, the link isn't listening, no turn gets the
//! `user_chrome` server, and the gate refuses any call that arrives anyway.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const FILE: &str = "user-chrome.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub enabled: bool,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    crate::agents::store::agents_root()
        .ok()
        .map(|r| r.join(FILE))
}

pub fn load() -> Stored {
    path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
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

/// The switch, on a system the link runs on.
pub fn enabled() -> bool {
    super::SUPPORTED && load().enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_by_default_and_when_the_file_says_nothing() {
        assert!(!Stored::default().enabled);
        let s: Stored = serde_json::from_str("{}").unwrap();
        assert!(!s.enabled);
        let s: Stored = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(s.enabled);
    }
}
