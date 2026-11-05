//! Which plugins this app will run, decided here rather than by the project.
//!
//! A project's `.shipstudio/plugins/registry.json` (and the plugin folders
//! beside it) is shared with Ship Studio and travels with the repo: a clone,
//! a pull or another app can put a plugin there. Running whatever it lists
//! would hand arbitrary JavaScript — with `shell.exec` and the project's
//! files — to anyone who can write to the repo. So the registry says what a
//! project *wants*; this store says what the user *allowed*.
//!
//! - The store lives in the app's own support folder (`plugin_trust.json`,
//!   0600), never in the project. An entry is a plugin id, the folder it
//!   loads from, and the SHA-256 of what runs (its `plugin.json` and
//!   `dist/index.js`). It is written only when the user allows that plugin
//!   (the trust prompt, or installing / updating / linking it themselves).
//! - A plugin that isn't in the store, or whose files no longer hash to what
//!   was allowed, is not loaded: the bundle is refused here, in Rust, so the
//!   webview never receives it. The UI asks once, quietly.
//! - A dev-linked plugin (`is_dev`: a local folder outside the project) loads
//!   only while plugin developer mode is on in Settings, allowed or not.
//!
//! The registry's own format is untouched, so Ship Studio reads and writes it
//! as before.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{now_ms, RegistryEntry};
use crate::errors::CommandError;

/// The store's file name in the app support folder.
const STORE_FILE: &str = "plugin_trust.json";

/// Prefix of the error a refused bundle carries. The frontend never asks for
/// an unapproved bundle, so this only shows when something did anyway.
pub(crate) const NOT_ALLOWED: &str = "Plugin not allowed";

/// Serialises read-modify-write of the store across commands.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Where a plugin stands with this app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PluginTrust {
    /// Allowed, and its files are exactly what was allowed.
    Trusted,
    /// Never allowed in this app (a clone, Ship Studio, another machine).
    #[default]
    Unknown,
    /// Allowed once, but its files have changed since.
    Changed,
    /// A dev-linked plugin while plugin developer mode is off.
    DevModeOff,
    /// Its files can't be read, so there is nothing to allow.
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct TrustedPlugin {
    plugin_id: String,
    /// The folder it loads from, canonicalised.
    path: String,
    sha256: String,
    approved_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustStore {
    #[serde(default)]
    plugins: Vec<TrustedPlugin>,
}

/// What a plugin's folder holds that decides what runs, read once so the
/// bytes that are hashed are the bytes that are returned.
pub(crate) struct PluginFiles {
    pub(crate) bundle: String,
    pub(crate) sha256: String,
}

fn store_path() -> PathBuf {
    crate::brand::app_support_dir().join(STORE_FILE)
}

/// The folder an entry loads from: its linked folder, or its folder under
/// the project's plugins dir.
pub(crate) fn entry_dir(
    project_path: &str,
    entry: &RegistryEntry,
) -> Result<PathBuf, CommandError> {
    if entry.is_dev {
        Ok(PathBuf::from(&entry.local_path))
    } else {
        super::validate_plugin_id(&entry.plugin_id)?;
        Ok(super::get_plugins_dir(project_path)?.join(&entry.plugin_id))
    }
}

fn path_key(dir: &Path) -> String {
    fs::canonicalize(dir)
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// SHA-256 over the manifest and the bundle, each length-prefixed so moving
/// bytes from one file to the other changes the digest.
fn digest(manifest: &[u8], bundle: &[u8]) -> String {
    let mut hasher = Sha256::new();
    for (name, bytes) in [("plugin.json", manifest), ("dist/index.js", bundle)] {
        hasher.update(name.as_bytes());
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    hex::encode(hasher.finalize())
}

/// Read a plugin's manifest and bundle and hash them. `None` when either is
/// missing or unreadable.
pub(crate) fn read_files(dir: &Path) -> Option<PluginFiles> {
    let manifest = fs::read(dir.join("plugin.json")).ok()?;
    let bundle = fs::read(dir.join("dist").join("index.js")).ok()?;
    let sha256 = digest(&manifest, &bundle);
    let bundle = String::from_utf8(bundle).ok()?;
    Some(PluginFiles { bundle, sha256 })
}

fn load_store(path: &Path) -> TrustStore {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the store owner-only, atomically (a temp file renamed over it).
fn save_store(path: &Path, store: &TrustStore) -> Result<(), CommandError> {
    let dir = path
        .parent()
        .ok_or_else(|| CommandError::from("No app support folder"))?;
    fs::create_dir_all(dir).map_err(|e| CommandError::Io {
        message: format!("Couldn't create the app support folder: {e}"),
    })?;
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| CommandError::from(format!("Couldn't save plugin approvals: {e}")))?;
    let tmp = dir.join(format!(".{STORE_FILE}.{}", std::process::id()));
    write_private(&tmp, json.as_bytes()).map_err(|e| CommandError::Io {
        message: format!("Couldn't save plugin approvals: {e}"),
    })?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        CommandError::Io {
            message: format!("Couldn't save plugin approvals: {e}"),
        }
    })
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// The decision itself, with every input given: unit-testable without the
/// app's own store or settings.
fn evaluate(
    store: &TrustStore,
    plugin_id: &str,
    dir: &Path,
    is_dev: bool,
    dev_mode: bool,
    sha256: Option<&str>,
) -> PluginTrust {
    if is_dev && !dev_mode {
        return PluginTrust::DevModeOff;
    }
    let Some(sha256) = sha256 else {
        return PluginTrust::Missing;
    };
    let key = path_key(dir);
    let mut known = store
        .plugins
        .iter()
        .filter(|t| t.plugin_id == plugin_id && t.path == key)
        .peekable();
    if known.peek().is_none() {
        return PluginTrust::Unknown;
    }
    if known.any(|t| t.sha256 == sha256) {
        PluginTrust::Trusted
    } else {
        PluginTrust::Changed
    }
}

fn record_in(
    store_file: &Path,
    plugin_id: &str,
    dir: &Path,
    sha256: &str,
) -> Result<(), CommandError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(store_file);
    let key = path_key(dir);
    // One approval per (id, folder): a new version replaces the old one.
    store
        .plugins
        .retain(|t| !(t.plugin_id == plugin_id && t.path == key));
    store.plugins.push(TrustedPlugin {
        plugin_id: plugin_id.to_string(),
        path: key,
        sha256: sha256.to_string(),
        approved_at: now_ms(),
    });
    save_store(store_file, &store)
}

fn forget_in(store_file: &Path, plugin_id: &str, dir: &Path) -> Result<(), CommandError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(store_file);
    let key = path_key(dir);
    let before = store.plugins.len();
    store
        .plugins
        .retain(|t| !(t.plugin_id == plugin_id && t.path == key));
    if store.plugins.len() == before {
        return Ok(());
    }
    save_store(store_file, &store)
}

fn dev_mode() -> bool {
    crate::commands::setup::read_app_state()
        .plugin_dev_mode
        .unwrap_or(false)
}

/// Where this plugin stands, and the digest of its files right now.
pub(crate) fn status(plugin_id: &str, dir: &Path, is_dev: bool) -> (PluginTrust, Option<String>) {
    let sha256 = read_files(dir).map(|f| f.sha256);
    let store = load_store(&store_path());
    (
        evaluate(
            &store,
            plugin_id,
            dir,
            is_dev,
            dev_mode(),
            sha256.as_deref(),
        ),
        sha256,
    )
}

/// Allow this plugin's files as they are now (the user installed, updated or
/// linked it). Returns the digest recorded.
pub(crate) fn record_current(plugin_id: &str, dir: &Path) -> Result<String, CommandError> {
    let files = read_files(dir).ok_or_else(|| {
        CommandError::expected(format!("Plugin files not found in {}", dir.display()))
    })?;
    record_in(&store_path(), plugin_id, dir, &files.sha256)?;
    Ok(files.sha256)
}

/// Allow exactly the files the user was shown. Refused when they changed in
/// between, so an approval never covers code nobody was asked about.
pub(crate) fn approve(plugin_id: &str, dir: &Path, shown_sha256: &str) -> Result<(), CommandError> {
    approve_in(&store_path(), plugin_id, dir, shown_sha256)
}

fn approve_in(
    store_file: &Path,
    plugin_id: &str,
    dir: &Path,
    shown_sha256: &str,
) -> Result<(), CommandError> {
    let files = read_files(dir).ok_or_else(|| {
        CommandError::expected(format!("Plugin files not found in {}", dir.display()))
    })?;
    if files.sha256 != shown_sha256 {
        return Err(CommandError::expected(
            "This plugin's files changed while you were deciding. Nothing was allowed; review it again.",
        ));
    }
    record_in(store_file, plugin_id, dir, &files.sha256)
}

/// Drop an approval (the plugin was uninstalled or unlinked).
pub(crate) fn forget(plugin_id: &str, dir: &Path) {
    if let Err(e) = forget_in(&store_path(), plugin_id, dir) {
        tracing::warn!(plugin = %plugin_id, "Couldn't drop a plugin approval: {e}");
    }
}

fn refusal(plugin_id: &str, trust: PluginTrust) -> CommandError {
    let why = match trust {
        PluginTrust::Unknown => "you haven't allowed it in this app yet",
        PluginTrust::Changed => "its files changed since you allowed it",
        PluginTrust::DevModeOff => "it's a dev plugin and plugin developer mode is off",
        PluginTrust::Missing => "its files are missing",
        PluginTrust::Trusted => "it isn't allowed",
    };
    CommandError::expected(format!("{NOT_ALLOWED}: '{plugin_id}' — {why}."))
}

/// The bundle, only if this exact code is allowed. The digest is taken from
/// the bytes returned, so nothing can be swapped in between check and load.
pub(crate) fn trusted_bundle(
    plugin_id: &str,
    dir: &Path,
    is_dev: bool,
) -> Result<String, CommandError> {
    trusted_bundle_in(&store_path(), plugin_id, dir, is_dev, dev_mode())
}

fn trusted_bundle_in(
    store_file: &Path,
    plugin_id: &str,
    dir: &Path,
    is_dev: bool,
    dev_mode: bool,
) -> Result<String, CommandError> {
    if is_dev && !dev_mode {
        return Err(refusal(plugin_id, PluginTrust::DevModeOff));
    }
    let bundle_path = dir.join("dist").join("index.js");
    // Byte-identical to the old message: usePlugins' self-heal matches on it.
    if !bundle_path.exists() {
        return Err(CommandError::expected(format!(
            "Plugin bundle not found: {}",
            bundle_path.display()
        )));
    }
    let files = read_files(dir).ok_or_else(|| refusal(plugin_id, PluginTrust::Missing))?;
    let store = load_store(store_file);
    match evaluate(
        &store,
        plugin_id,
        dir,
        is_dev,
        dev_mode,
        Some(&files.sha256),
    ) {
        PluginTrust::Trusted => Ok(files.bundle),
        other => Err(refusal(plugin_id, other)),
    }
}

/// For the capabilities a running plugin calls (`shell.exec`, `fs.*`): only
/// an allowed plugin gets them.
pub(crate) fn require_trusted(
    plugin_id: &str,
    dir: &Path,
    is_dev: bool,
) -> Result<(), CommandError> {
    match status(plugin_id, dir, is_dev).0 {
        PluginTrust::Trusted => Ok(()),
        other => Err(refusal(plugin_id, other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(dir: &Path, bundle: &str) {
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::write(dir.join("plugin.json"), r#"{"id":"p","name":"P"}"#).unwrap();
        fs::write(dir.join("dist").join("index.js"), bundle).unwrap();
    }

    fn sha(dir: &Path) -> String {
        read_files(dir).unwrap().sha256
    }

    #[test]
    fn an_unknown_plugin_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("p");
        plugin(&dir, "export default {}");
        let err = trusted_bundle_in(&store, "p", &dir, false, false).unwrap_err();
        assert!(err.to_string().contains(NOT_ALLOWED), "{err}");
        assert!(err.to_string().contains("haven't allowed"), "{err}");
    }

    #[test]
    fn an_approved_plugin_loads_its_exact_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("p");
        plugin(&dir, "export default { ok: 1 }");
        record_in(&store, "p", &dir, &sha(&dir)).unwrap();
        assert_eq!(
            trusted_bundle_in(&store, "p", &dir, false, false).unwrap(),
            "export default { ok: 1 }"
        );
    }

    #[test]
    fn a_changed_bundle_or_manifest_is_refused_until_approved_again() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("p");
        plugin(&dir, "export default {}");
        record_in(&store, "p", &dir, &sha(&dir)).unwrap();

        fs::write(dir.join("dist").join("index.js"), "evil()").unwrap();
        let err = trusted_bundle_in(&store, "p", &dir, false, false).unwrap_err();
        assert!(err.to_string().contains("changed"), "{err}");
        assert_eq!(
            evaluate(
                &load_store(&store),
                "p",
                &dir,
                false,
                false,
                Some(&sha(&dir))
            ),
            PluginTrust::Changed
        );

        // Re-approving the new files replaces the old approval.
        record_in(&store, "p", &dir, &sha(&dir)).unwrap();
        assert!(trusted_bundle_in(&store, "p", &dir, false, false).is_ok());
        assert_eq!(load_store(&store).plugins.len(), 1);

        // The manifest counts too: it declares what the plugin may run.
        fs::write(
            dir.join("plugin.json"),
            r#"{"id":"p","name":"P","required_commands":["rm"]}"#,
        )
        .unwrap();
        assert!(trusted_bundle_in(&store, "p", &dir, false, false).is_err());
    }

    #[test]
    fn an_approval_covers_only_the_files_the_user_was_shown() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("p");
        plugin(&dir, "shown()");
        let shown = sha(&dir);
        // Swapped between the prompt and the click: nothing is allowed.
        fs::write(dir.join("dist").join("index.js"), "swapped()").unwrap();
        let err = approve_in(&store, "p", &dir, &shown).unwrap_err();
        assert!(
            err.to_string().contains("changed while you were deciding"),
            "{err}"
        );
        assert!(trusted_bundle_in(&store, "p", &dir, false, false).is_err());
        // The files as shown now: allowed.
        approve_in(&store, "p", &dir, &sha(&dir)).unwrap();
        assert_eq!(
            trusted_bundle_in(&store, "p", &dir, false, false).unwrap(),
            "swapped()"
        );
    }

    #[test]
    fn an_approval_is_for_one_folder_and_one_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        plugin(&a, "same");
        plugin(&b, "same");
        record_in(&store, "p", &a, &sha(&a)).unwrap();
        // Same code, other project: still asks.
        assert!(trusted_bundle_in(&store, "p", &b, false, false).is_err());
        // Same folder, other id: still asks.
        assert!(trusted_bundle_in(&store, "q", &a, false, false).is_err());
    }

    #[test]
    fn a_dev_plugin_loads_only_in_dev_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("dev");
        plugin(&dir, "dev()");
        record_in(&store, "p", &dir, &sha(&dir)).unwrap();
        let err = trusted_bundle_in(&store, "p", &dir, true, false).unwrap_err();
        assert!(err.to_string().contains("developer mode"), "{err}");
        assert!(trusted_bundle_in(&store, "p", &dir, true, true).is_ok());
        // Dev mode doesn't excuse an unapproved one.
        let other = tmp.path().join("other");
        plugin(&other, "x");
        assert!(trusted_bundle_in(&store, "p", &other, true, true).is_err());
    }

    #[test]
    fn a_missing_bundle_keeps_the_self_heal_message() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("p");
        fs::create_dir_all(&dir).unwrap();
        let err = trusted_bundle_in(&store, "p", &dir, false, false).unwrap_err();
        assert!(err.to_string().contains("Plugin bundle not found"), "{err}");
    }

    #[test]
    fn forgetting_drops_only_that_approval() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        plugin(&a, "a");
        plugin(&b, "b");
        record_in(&store, "p", &a, &sha(&a)).unwrap();
        record_in(&store, "p", &b, &sha(&b)).unwrap();
        forget_in(&store, "p", &a).unwrap();
        assert!(trusted_bundle_in(&store, "p", &a, false, false).is_err());
        assert!(trusted_bundle_in(&store, "p", &b, false, false).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        let dir = tmp.path().join("p");
        plugin(&dir, "x");
        record_in(&store, "p", &dir, &sha(&dir)).unwrap();
        let mode = fs::metadata(&store).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_corrupt_store_trusts_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store.json");
        fs::write(&store, "{not json").unwrap();
        let dir = tmp.path().join("p");
        plugin(&dir, "x");
        assert!(trusted_bundle_in(&store, "p", &dir, false, false).is_err());
    }
}
