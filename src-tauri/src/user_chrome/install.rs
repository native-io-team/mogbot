//! Putting the pieces where Chrome looks for them, and reading back whether
//! they're there. Nothing here runs until the user turns "Your Chrome" on.
//!
//! - **The native host's manifest**: `<Chrome's user data>/NativeMessagingHosts/<name>.json`,
//!   naming this app's binary and only the app's extension ids. Chrome's
//!   per-user location on macOS is the default profile root's
//!   `NativeMessagingHosts` folder; a Chrome run with `--user-data-dir`
//!   looks in that folder's own (which is how the end-to-end check stays off
//!   the user's real Chrome).
//! - **The extension**: copied from the app's bundle to the app's data folder
//!   (a stable path for Chrome's "Load unpacked", which an app update would
//!   otherwise move from under it). Once the Web Store listing exists
//!   (`brand.json` `chromeExtension.webStoreId`), an External Extensions
//!   file makes Chrome offer it on its next start ("Enable" in Chrome), and
//!   the unpacked path is only for development.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::auth;

/// The native host's name: reverse-DNS from the app's identifier, which is
/// what Chrome allows (lowercase letters, digits, dots, underscores).
pub fn host_name() -> String {
    let base: String = crate::brand::IDENTIFIER
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{base}.chrome_link")
}

/// Google Chrome's own user data folder (the user's real profiles).
pub fn chrome_user_data_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library/Application Support/Google/Chrome"))
}

pub fn host_manifest_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir
        .join("NativeMessagingHosts")
        .join(format!("{}.json", host_name()))
}

/// The host manifest naming `exe` (the app's own binary, run in host mode).
pub fn host_manifest(exe: &Path) -> Value {
    json!({
        "name": host_name(),
        "description": format!("{}: lets your agents use this Chrome, through the app on this Mac", crate::brand::NAME),
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": auth::origins(),
    })
}

/// Whether the host is set up for `exe`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostState {
    Missing,
    /// There, but naming another binary (the app moved) or other ids.
    Stale,
    Current,
}

pub fn host_state(user_data_dir: &Path, exe: &Path) -> HostState {
    let Ok(raw) = std::fs::read(host_manifest_path(user_data_dir)) else {
        return HostState::Missing;
    };
    match serde_json::from_slice::<Value>(&raw) {
        Ok(v) if v == host_manifest(exe) => HostState::Current,
        _ => HostState::Stale,
    }
}

/// Write the host manifest for `exe` into `user_data_dir`'s folder.
pub fn install_host(user_data_dir: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    let path = host_manifest_path(user_data_dir);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec_pretty(&host_manifest(exe))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Remove the host manifest (the switch turned off for good).
pub fn remove_host(user_data_dir: &Path) {
    let _ = std::fs::remove_file(host_manifest_path(user_data_dir));
}

/// The app's binary, as the host manifest names it.
pub fn this_exe() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
}

/* --------------------------------------------------------- extension */

static RESOURCES: OnceLock<PathBuf> = OnceLock::new();

/// The app's bundled resources folder, set once at launch.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCES.set(dir);
}

/// Where the extension's files are shipped: the bundle's resources, or this
/// checkout's `chrome-extension/extension` in a development build.
pub fn extension_source() -> Option<PathBuf> {
    if let Some(r) = RESOURCES.get() {
        let p = r.join("chrome-extension");
        if p.join("manifest.json").is_file() {
            return Some(p);
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../chrome-extension/extension");
    dev.join("manifest.json")
        .is_file()
        .then(|| dev.canonicalize().unwrap_or(dev))
}

/// Where the extension is staged for "Load unpacked": the app's data folder.
pub fn staged_extension_dir() -> PathBuf {
    crate::brand::app_support_dir().join("chrome-extension")
}

/// The extension's version from its manifest.
pub fn extension_version(dir: &Path) -> Option<String> {
    let raw = std::fs::read(dir.join("manifest.json")).ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    v["version"].as_str().map(str::to_string)
}

/// Copy the extension from `src` to `dest`, replacing what was there.
/// Only the files an extension is made of are copied.
pub fn stage_extension(src: &Path, dest: &Path) -> std::io::Result<()> {
    let tmp = dest.with_extension("staging");
    let _ = std::fs::remove_dir_all(&tmp);
    copy_tree(src, &tmp)?;
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest)
}

fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s.starts_with('.') {
            continue;
        }
        let from = entry.path();
        let to = dest.join(&name);
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else if kind.is_file() {
            let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("");
            if matches!(ext, "js" | "json" | "html" | "css" | "png" | "svg") {
                std::fs::copy(&from, &to)?;
            }
        }
    }
    Ok(())
}

/// The extension's id from a manifest's `key` (Chrome's rule: SHA-256 of
/// the public key, first 32 hex digits, each mapped 0-f → a-p).
pub fn id_from_key(key_b64: &str) -> Option<String> {
    use base64::Engine as _;
    use sha2::Digest as _;
    let der = base64::engine::general_purpose::STANDARD
        .decode(key_b64.trim())
        .ok()?;
    let digest = sha2::Sha256::digest(der);
    Some(
        hex::encode(digest)
            .chars()
            .take(32)
            .map(|c| (b'a' + c.to_digit(16).unwrap_or(0) as u8) as char)
            .collect(),
    )
}

/* ----------------------------------------- Web Store, External Extensions */

/// Chrome's update URL for Web Store extensions.
pub const WEB_STORE_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";

/// The Web Store listing, once there is one.
pub fn web_store_url() -> Option<String> {
    crate::brand::chrome::WEB_STORE_ID
        .map(|id| format!("https://chromewebstore.google.com/detail/{id}"))
}

pub fn external_extension_path(user_data_dir: &Path, id: &str) -> PathBuf {
    user_data_dir
        .join("External Extensions")
        .join(format!("{id}.json"))
}

/// Ask Chrome to offer the Web Store extension on its next start (Chrome
/// shows "New extension added" and the user presses Enable). Only for a
/// Web Store id: Chrome on macOS ignores External Extensions that point
/// anywhere else.
pub fn write_external_extension(user_data_dir: &Path, id: &str) -> std::io::Result<PathBuf> {
    let path = external_extension_path(user_data_dir, id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({ "external_update_url": WEB_STORE_UPDATE_URL }))?,
    )?;
    Ok(path)
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
