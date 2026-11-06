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
//! - [`settings`]: the Settings → Agents switch (on by default).
//! - [`viewer`]: the prototype's loopback stand-in for the phone (the demo).
//!
//! Design, measurements and the security model: docs/internal/agent-browser.md.

pub mod axtree;
pub mod cdp;
pub mod chrome;
pub mod keys;
pub mod macos;
pub mod plain;
pub mod refusal;
pub mod service;
pub mod settings;
pub mod signin;
pub mod tools;
pub mod viewer;

/// This build has the agents' browser (the `agent-browser` feature, on by
/// default) on a system it runs on.
pub const COMPILED: bool = cfg!(feature = "agent-browser") && cfg!(target_os = "macos");

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
        settings::enabled() && chrome::find_chrome().is_some()
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
