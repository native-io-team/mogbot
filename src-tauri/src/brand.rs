//! # Brand
//!
//! The app's name and identity, generated at build time from the repo-root
//! `brand.json` (see `build.rs`). Nothing else in the crate hardcodes them.
//!
//! Two kinds of names exist in this codebase and they must not be confused:
//!
//! - **Ours** (this module): the app-support and log folders, keychain
//!   service prefixes, the deep-link scheme, MCP server names, the funnel
//!   mount path, temp-dir names. Every one of them derives from the brand so
//!   this app and Ship Studio can run side by side without touching each
//!   other's state.
//! - **Shared compat names**, deliberately *not* here: the `~/ShipStudio`
//!   projects folder, the in-project `.shipstudio/` format, and the plugin
//!   ABI (`__SHIPSTUDIO_*`, `@shipstudio/plugin-sdk`). Those let the two apps
//!   open each other's projects and run each other's plugins.
//!
//! A link that is `null` in brand.json is `None` here, and the feature that
//! would use it is off.

use std::path::PathBuf;

include!(concat!(env!("OUT_DIR"), "/brand_gen.rs"));

/// The per-user application-support folder this app owns
/// (`~/Library/Application Support/<appDirName>` on macOS).
pub fn app_support_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    let base = dirs::home_dir().map(|h| h.join("Library/Application Support").join(APP_DIR_NAME));
    #[cfg(target_os = "windows")]
    let base = dirs::data_local_dir().map(|d| d.join(APP_DIR_NAME));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = dirs::data_local_dir().map(|d| d.join(SLUG));
    base.unwrap_or_else(|| std::env::temp_dir().join(format!("{SLUG}-app-support")))
}

/// The folder this app's log files go to (`~/Library/Logs/<appDirName>` on macOS).
pub fn logs_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    let base = dirs::home_dir().map(|h| h.join("Library/Logs").join(APP_DIR_NAME));
    #[cfg(target_os = "windows")]
    let base = dirs::data_local_dir().map(|d| d.join(APP_DIR_NAME).join("logs"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = dirs::data_local_dir().map(|d| d.join(SLUG).join("logs"));
    base.unwrap_or_else(|| std::env::temp_dir().join(format!("{SLUG}-logs")))
}

/// The rolling log file prefix (`dashbot.log.2026-11-04`).
pub fn log_file_prefix() -> String {
    format!("{SLUG}.log")
}

/// The prefix of every keychain service this app writes
/// (`dashbot-account-<id>`, `dashbot-agent-<id>`).
pub fn keychain_prefix(kind: &str) -> String {
    format!("{SLUG}-{kind}-")
}

/// `~/.<slug>`: per-user dot folder for things that live outside app support
/// (per-workspace agent config homes).
pub fn dot_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(format!(".{SLUG}")))
}

/// A name for something of ours in a shared namespace — a temp dir, an MCP
/// server, a skill folder: `<slug>-<what>`.
pub fn scoped(what: &str) -> String {
    format!("{SLUG}-{what}")
}

/// The name the preview bridge is registered under in the user's agent
/// configs (`dashbot-preview`). Mirrored by `PREVIEW_MCP_SERVER_NAME` in
/// `src/lib/agentBridge.ts`.
pub fn preview_mcp_name() -> String {
    scoped("preview")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_not_ship_studio() {
        // The whole point of this module: nothing app-level collides with an
        // installed Ship Studio.
        for value in [
            NAME,
            SLUG,
            IDENTIFIER,
            URL_SCHEME,
            APP_DIR_NAME,
            COMPANION_SCHEME,
        ] {
            let lower = value.to_ascii_lowercase().replace([' ', '-', '_', '.'], "");
            assert!(!lower.contains("shipstudio"), "{value}");
        }
        assert_ne!(COMPANION_TAILNET_PORT, 47443, "Ship Studio's tailnet port");
        let dir = app_support_dir();
        assert!(
            !dir.to_string_lossy().contains("ShipStudio"),
            "{}",
            dir.display()
        );
        assert!(!logs_dir().to_string_lossy().contains("ShipStudio"));
    }

    #[test]
    fn the_phone_builds_against_the_same_pairing_scheme_and_port() {
        // The phone reads these from companion-protocol's generated copy of
        // brand.json; a stale copy means the phone can't open our QR codes.
        let gen = include_str!("../../packages/companion-protocol/src/brand.gen.ts");
        assert!(
            gen.contains(&format!("PAIRING_SCHEME = \"{COMPANION_SCHEME}\"")),
            "brand.gen.ts is stale: run node scripts/check-brand.mjs --write"
        );
        assert!(
            gen.contains(&format!("TAILNET_HTTPS_PORT = {COMPANION_TAILNET_PORT};")),
            "brand.gen.ts is stale: run node scripts/check-brand.mjs --write"
        );
    }

    #[test]
    fn scoped_names() {
        assert_eq!(scoped("preview"), format!("{SLUG}-preview"));
        assert_eq!(keychain_prefix("account"), format!("{SLUG}-account-"));
    }
}
