//! The agents' browser: the user's installed Google Chrome, started by the
//! app on a profile of its own ("Agents", in the app's data folder) and
//! driven over a CDP pipe, so agents on Claude Code and Codex alike get a
//! real browser, and the person can watch and drive it from the phone.
//!
//! - [`chrome`]: finding Chrome and the exact command lines (held by tests):
//!   `--remote-debugging-pipe`, never a port, never an automation-masking
//!   switch. That is a decision, not an oversight: a fixed port lets any
//!   process on the Mac drive the browser and read its cookies, and the
//!   masking switch disguises an automated browser as a person
//!   (docs/internal/agent-browser.md, "Where the line is").
//! - [`cdp`]: CDP over the pipe. [`service`]: the running Chrome, a window
//!   per tab, owners, frames. [`axtree`]: the page as agents read it, with
//!   refs. [`keys`]: the keys anyone may press.
//! - [`tools`]: the `browser` MCP server on the agent bridge.
//! - [`signin`]: a sign-in window (phone or desk); [`refusal`] spots a site
//!   refusing it; [`plain`] and [`macos`]: the plain-window fallback.
//! - [`live`]: the chat's live preview of an agent's page (slow, small, leased).
//! - [`settings`]: the Settings → Agents switch (on by default).
//! - [`viewer`]: the prototype's loopback stand-in for the phone (the demo).
//!
//! Design, measurements and the security model: docs/internal/agent-browser.md.

pub mod axtree;
pub mod cdp;
pub mod chrome;
pub mod keys;
pub mod live;
pub mod macos;
pub mod plain;
pub mod refusal;
pub mod service;
pub mod settings;
pub mod signin;
pub mod tools;
/// A loopback input server for the demo only: never compiled into the app.
#[cfg(any(test, feature = "browser-demo"))]
pub mod viewer;

/// This build has the agents' browser on a system it runs on. An opt-out
/// (`no-agent-browser`), not a default feature: `tauri dev` drops cargo's
/// default features, which built the owner's app without it (Cargo.toml).
pub const COMPILED: bool = !cfg!(feature = "no-agent-browser") && cfg!(target_os = "macos");

/// Every agent's browser call while the profile is open in a plain window.
pub const BUSY_PLAIN: &str = "The user is signing in to a site in a plain Chrome window on this Mac, so the agents' browser is closed for a few minutes. Carry on with what doesn't need it, or try again shortly.";

/// The agents' browser can be offered now: switched on and Chrome is here.
pub fn available() -> bool {
    #[cfg(test)]
    {
        true
    }
    #[cfg(not(test))]
    {
        unavailable_reason().is_none()
    }
}

/// Why the agents' browser can't be offered on this Mac right now, in a
/// line for the log; `None` when it can.
pub fn unavailable_reason() -> Option<&'static str> {
    reason_for(
        COMPILED,
        settings::load().enabled,
        chrome::find_chrome().is_some(),
    )
}

/// [`unavailable_reason`], pure.
pub fn reason_for(compiled: bool, switched_on: bool, chrome: bool) -> Option<&'static str> {
    if !compiled {
        return Some(
            "this build has no agents' browser (built with `no-agent-browser`, or not macOS)",
        );
    }
    if !switched_on {
        return Some("switched off in Settings → Agents → Agents' browser");
    }
    if !chrome {
        return Some("Google Chrome isn't in /Applications or ~/Applications");
    }
    None
}

/// Log why a turn goes without the agents' browser, at info, once per
/// change of reason (every turn asks).
pub fn log_unavailable(agent_id: &str, why: &str) {
    use std::sync::Mutex;
    static LAST: Mutex<Option<(String, String)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let now = (agent_id.to_string(), why.to_string());
    if last.as_ref() != Some(&now) {
        tracing::info!(
            agent = agent_id,
            why,
            "[AgentBrowser] not offered to this turn"
        );
        *last = Some(now);
    }
}

/// What Settings → Agents shows.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub compiled: bool,
    pub enabled: bool,
    pub chrome_installed: bool,
    pub running: bool,
    /// For the plain-window sign-in from the phone.
    pub permissions: macos::Permissions,
}

pub fn status() -> Status {
    Status {
        compiled: COMPILED,
        enabled: settings::load().enabled,
        chrome_installed: chrome::find_chrome().is_some(),
        running: service::running().is_some(),
        permissions: macos::permissions(),
    }
}

/// The switch: off closes the agents' Chrome.
pub fn set_enabled(on: bool) -> Result<Status, crate::errors::CommandError> {
    settings::set_enabled(on)?;
    if !on {
        service::shutdown();
    }
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built without cargo's default features (as `tauri dev` builds), the
    /// agents' browser is still in: only `no-agent-browser` takes it out.
    #[test]
    #[cfg(all(target_os = "macos", not(feature = "no-agent-browser")))]
    fn every_build_has_it_unless_opted_out() {
        assert!(COMPILED);
    }

    #[test]
    fn says_why_it_cant_be_offered() {
        assert_eq!(reason_for(true, true, true), None);
        assert!(reason_for(false, true, true)
            .unwrap()
            .contains("this build"));
        assert!(reason_for(true, false, true).unwrap().contains("Settings"));
        assert!(reason_for(true, true, false).unwrap().contains("Chrome"));
    }
}
