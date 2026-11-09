//! What the user took away from an agent, kept beside it in its folder, so
//! a rebuild of `agents.json` from the folders (`store_rebuild.rs`) gives it
//! back: apps kept from its turns, muted, its browser off, admin off, and the
//! one account it runs on ("Runs only on Work").
//!
//! `<home>/.agent-limits.json` (0600) is written whenever these change (on
//! the registry write that changes them). A folder is anyone's to write, so
//! the file can only ever narrow: each field restores only its narrow side
//! (a `false` or an empty list is ignored, never applied as "on"), and a
//! file that isn't one is ignored whole. Independence lives in the policy
//! file and routines aren't rebuilt, so neither is here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

use super::Agent;

pub(super) const FILE: &str = ".agent-limits.json";

/// Kept short: these are names of apps, not prose.
const MAX_APPS: usize = 200;
const MAX_APP_LEN: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Limits {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_apps: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub browser_off: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub admin_off: bool,
    /// The one account it runs on, with the engine it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runs_on: Option<RunsOn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct RunsOn {
    pub engine: super::super::engine::Engine,
    pub account: String,
}

impl Limits {
    pub fn of(agent: &Agent) -> Self {
        Self {
            blocked_apps: agent.reach.blocked_apps.clone(),
            muted: agent.muted,
            browser_off: agent.reach.browser_off,
            admin_off: !super::super::admin::is_admin(agent),
            runs_on: agent.account.clone().map(|account| RunsOn {
                engine: agent.engine,
                account,
            }),
        }
    }

    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// The last limits written for each file, so an ordinary registry write
/// (unread, last activity) touches no folder.
static WRITTEN: LazyLock<Mutex<HashMap<PathBuf, Limits>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// After a registry write: each agent's file brought up to date where its
/// limits changed. Only into a folder that exists; never fails the write.
pub(super) fn write_changed(root: &Path, agents: &[Agent]) {
    let mut written = WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    for agent in agents {
        if super::validate_id(&agent.id).is_err() {
            continue;
        }
        let home = root.join(&agent.id);
        if !home.is_dir() {
            continue;
        }
        let path = home.join(FILE);
        let limits = Limits::of(agent);
        if written.get(&path) == Some(&limits) {
            continue;
        }
        let result = if limits.is_empty() {
            match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            }
        } else {
            serde_json::to_vec_pretty(&limits)
                .map_err(std::io::Error::other)
                .and_then(|json| super::write_private(&path, &json))
        };
        match result {
            Ok(()) => {
                written.insert(path, limits);
            }
            Err(e) => tracing::warn!("[Agents] limits for {} not kept: {e}", agent.id),
        }
    }
}

/// What a folder's file says, when it is one.
pub(super) fn read(home: &Path) -> Option<Limits> {
    let bytes = std::fs::read(home.join(FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A rebuilt agent narrowed by its folder's file: only ever less room.
pub(super) fn restore(agent: &mut Agent, limits: &Limits) {
    for app in limits.blocked_apps.iter().take(MAX_APPS) {
        let app = app.trim();
        if app.is_empty() || app.len() > MAX_APP_LEN || app.chars().any(char::is_control) {
            continue;
        }
        if !agent.reach.blocked_apps.iter().any(|a| a == app) {
            agent.reach.blocked_apps.push(app.to_string());
        }
    }
    if limits.muted {
        agent.muted = true;
    }
    if limits.browser_off {
        agent.reach.browser_off = true;
    }
    if limits.admin_off {
        agent.extra.insert(
            super::super::admin::ADMIN_KEY.to_string(),
            serde_json::Value::Bool(false),
        );
    }
    // Pinned to one account of the engine it rebuilt on, when it has none:
    // an account of another engine would mean nothing to it.
    if let Some(pin) = &limits.runs_on {
        let account = pin.account.trim();
        if agent.account.is_none()
            && pin.engine == agent.engine
            && !account.is_empty()
            && account.len() <= MAX_APP_LEN
            && !account.chars().any(char::is_control)
        {
            agent.account = Some(account.to_string());
        }
    }
}
