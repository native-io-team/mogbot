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
    host_name_for(crate::brand::IDENTIFIER)
}

/// The host's name under the app's previous identifier (`brand.json`
/// `previous.identifier`), whose manifest an install removes.
pub fn previous_host_name() -> Option<String> {
    crate::brand::previous::IDENTIFIER
        .map(host_name_for)
        .filter(|old| *old != host_name())
}

fn host_name_for(identifier: &str) -> String {
    let base: String = identifier
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
    remove_previous_host(user_data_dir);
    Ok(path)
}

/// Remove the host manifest (the switch turned off for good).
pub fn remove_host(user_data_dir: &Path) {
    let _ = std::fs::remove_file(host_manifest_path(user_data_dir));
    remove_previous_host(user_data_dir);
}

/// The manifest under the app's previous name: it names a binary that no
/// longer answers to that name, and only ever ours.
fn remove_previous_host(user_data_dir: &Path) {
    if let Some(old) = previous_host_name() {
        let _ = std::fs::remove_file(
            user_data_dir
                .join("NativeMessagingHosts")
                .join(format!("{old}.json")),
        );
    }
}

/// The app's binary, as the host manifest names it.
pub fn this_exe() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
}

/* ------------------------------------------------- where the host runs from */

/// Folders macOS guards with a "would like to access" prompt (TCC). A host
/// Chrome starts from one of these runs with Chrome as the responsible app
/// and waits, silently, on a prompt nobody sees (observed in the end-to-end
/// check): the extension stays on "connecting" for good. A development
/// build lives in a checkout, usually under one of them (the owner's is
/// under `~/Desktop`). Relative to the home folder.
pub const GUARDED_HOME_FOLDERS: [&str; 4] = [
    "Desktop",
    "Documents",
    "Downloads",
    "Library/Mobile Documents",
];

/// `exe` sits where Chrome can't start it without a prompt: under one of
/// [`GUARDED_HOME_FOLDERS`] of `home`. Pure.
pub fn guarded(exe: &Path, home: &Path) -> bool {
    GUARDED_HOME_FOLDERS
        .iter()
        .any(|f| exe.starts_with(home.join(f)))
}

/// Where the copy of the binary Chrome starts lives when it can't start the
/// app's own ([`guarded`]): the app's data folder, which no prompt guards.
pub fn host_copy_dir() -> PathBuf {
    crate::brand::app_support_dir().join("chrome-host")
}

/// `exe` is an app bundle's own binary (`….app/Contents/MacOS/…`). A signed
/// bundle's binary is never copied out of it: its signature seals the
/// bundle, and a copy carries the download's quarantine with it, so the copy
/// might not run at all. Pure.
pub fn in_app_bundle(exe: &Path) -> bool {
    let parts: Vec<&str> = exe
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    parts
        .windows(3)
        .any(|w| w[0].ends_with(".app") && w[1] == "Contents" && w[2] == "MacOS")
}

/// The binary the host manifest names for `exe`: `exe` itself, or its copy
/// in `copy_dir` when `exe` is a bare binary (a development build) in a
/// guarded folder. Pure.
pub fn host_exe_for(exe: &Path, home: Option<&Path>, copy_dir: &Path) -> PathBuf {
    match (home, exe.file_name()) {
        (Some(home), Some(name)) if guarded(exe, home) && !in_app_bundle(exe) => {
            copy_dir.join(name)
        }
        _ => exe.to_path_buf(),
    }
}

/// The binary Chrome is told to start, for this app's `exe`.
pub fn host_exe(exe: &Path) -> PathBuf {
    host_exe_for(exe, dirs::home_dir().as_deref(), &host_copy_dir())
}

/// What a copy was made from: the source's path, size and modified time.
fn stamp_of(src: &Path) -> Option<String> {
    let m = std::fs::metadata(src).ok()?;
    let modified = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{}\n{}\n{}", src.display(), m.len(), modified))
}

fn stamp_path(dest: &Path) -> PathBuf {
    dest.with_extension("source")
}

/// The copy at `dest` is of `src` as it is now.
pub fn copy_current(src: &Path, dest: &Path) -> bool {
    dest.is_file()
        && stamp_of(src)
            .is_some_and(|s| std::fs::read_to_string(stamp_path(dest)).is_ok_and(|have| have == s))
}

/// Copy `src` to `dest` unless the copy is already of `src` as it is now.
/// A temporary file renamed over, so a host Chrome starts mid-copy is the
/// old binary or the new one, never half. On APFS the copy is a clone: no
/// time and no space, even at a development build's size.
pub fn refresh_copy(src: &Path, dest: &Path) -> std::io::Result<()> {
    if copy_current(src, dest) {
        return Ok(());
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = dest.with_extension("copying");
    let _ = std::fs::remove_file(&tmp);
    std::fs::copy(src, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, dest)?;
    if let Some(s) = stamp_of(src) {
        std::fs::write(stamp_path(dest), s)?;
    }
    Ok(())
}

/// The host is set up for the app's `exe`: the manifest names the binary
/// Chrome will start ([`host_exe`]), and that binary is there and current.
pub fn host_state_for_app(user_data_dir: &Path, exe: &Path) -> HostState {
    host_state_with(user_data_dir, exe, &host_exe(exe))
}

/// [`host_state_for_app`] with the binary Chrome starts given.
pub fn host_state_with(user_data_dir: &Path, exe: &Path, target: &Path) -> HostState {
    match host_state(user_data_dir, target) {
        HostState::Current if target != exe && !copy_current(exe, target) => HostState::Stale,
        s => s,
    }
}

/// Make sure Chrome can start the host for the app's `exe`: the copy (when
/// it's needed) and the manifest naming it.
pub fn prepare_host(user_data_dir: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    prepare_host_with(user_data_dir, exe, &host_exe(exe))
}

/// [`prepare_host`] with the binary Chrome starts given.
pub fn prepare_host_with(
    user_data_dir: &Path,
    exe: &Path,
    target: &Path,
) -> std::io::Result<PathBuf> {
    if target != exe {
        refresh_copy(exe, target)?;
    }
    if host_state(user_data_dir, target) != HostState::Current {
        install_host(user_data_dir, target)?;
    }
    Ok(target.to_path_buf())
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

/// The files an extension is made of (what staging copies).
fn staged_kind(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    matches!(ext, "js" | "json" | "html" | "css" | "png" | "svg")
}

/// A fingerprint of the files [`stage_extension`] copies from `dir`, by path
/// and content: the staged copy is refreshed whenever the shipped extension
/// changes, not only its version (a development build changes files without
/// bumping it, and the old check left Chrome loading yesterday's). `None`
/// when there's no extension there.
pub fn extension_fingerprint(dir: &Path) -> Option<String> {
    use sha2::Digest as _;
    fn walk(dir: &Path, rel: &str, files: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let rel = format!("{rel}/{name}");
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(&path, &rel, files)?;
            } else if kind.is_file() && staged_kind(&path) {
                files.push((rel, path));
            }
        }
        Ok(())
    }
    if !dir.join("manifest.json").is_file() {
        return None;
    }
    let mut files = Vec::new();
    walk(dir, "", &mut files).ok()?;
    files.sort();
    let mut h = sha2::Sha256::new();
    for (rel, path) in files {
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(std::fs::read(path).ok()?);
        h.update([0]);
    }
    Some(hex::encode(h.finalize()))
}

/// The staged copy at `dest` isn't `src`'s files as they are now.
pub fn needs_staging(src: &Path, dest: &Path) -> bool {
    match extension_fingerprint(src) {
        Some(want) => extension_fingerprint(dest).as_deref() != Some(want.as_str()),
        None => false,
    }
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
        } else if kind.is_file() && staged_kind(&from) {
            std::fs::copy(&from, &to)?;
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

/// AppleScript that opens Chrome's extensions page (Developer mode, Load
/// unpacked) in a new tab. `open -a "Google Chrome" chrome://extensions/`
/// doesn't: Chrome won't open its own pages from a launch argument. Asking
/// Chrome for a tab with that URL does (checked by the owner).
pub const OPEN_EXTENSIONS_SCRIPT: &str = r#"tell application "Google Chrome"
    activate
    if (count of windows) is 0 then
        make new window
        set URL of active tab of front window to "chrome://extensions/"
    else
        tell front window to make new tab with properties {URL:"chrome://extensions/"}
    end if
end tell"#;

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
