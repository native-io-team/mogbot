//! Which plugins this app has agreed to run, in which project.
//!
//! A project's `.shipstudio/plugins/registry.json` travels with the repo, so
//! it is only ever a *request*: "load these". A clone of someone else's repo
//! can list any plugin, ship its bundle beside it, or point a dev entry at
//! any folder on disk. Loading a plugin runs its JavaScript in the app, with
//! the plugin API (shell commands included), so the registry alone is never
//! enough.
//!
//! What decides is this app's own trust store (`plugin-trust.json` in app
//! support, 0600): for each project, the plugin id, the bundle's canonical
//! path, the SHA-256 of the bundle's bytes and the source URL it was
//! approved from, recorded only when the user acted — installed it, updated
//! a plugin they had approved (from the same source), linked a dev folder,
//! or answered "Allow" to "This project wants to load plugin X". A bundle
//! whose path, bytes or source differ from what was approved is not loaded;
//! the app asks, quietly. "Don't load" is remembered for that exact bundle,
//! so it doesn't ask again until the bundle changes.
//!
//! The automatic re-install of a plugin whose bundle went missing never
//! carries trust over: the source URL it clones comes from the repo's own
//! registry, so a pushed change could otherwise swap it for someone else's
//! code and have it approved silently. If what it fetched isn't byte-for-byte
//! what was approved, the user is asked.
//!
//! Dev plugins (a registry entry naming a local folder) load only in plugin
//! developer mode, which is an explicit switch in the Plugin Manager (on by
//! default in debug builds, and shown as on). Linking a dev plugin doesn't
//! turn it on. In a normal session a dev entry from a repo is not even
//! offered.
//!
//! The bundle is hashed from the same bytes that are handed to the webview
//! (`verified_bundle`), so there is no window between the check and the load.
//! The registry's file format is untouched: Ship Studio reads and writes it
//! as it always did.

use super::{get_plugins_dir, read_registry, validate_plugin_id, RegistryEntry};
use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where a plugin stands with this app, for this project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrustState {
    /// Approved at this path with these exact bytes.
    Trusted,
    /// Never approved in this project.
    New,
    /// Approved before; the bundle's bytes or path have changed since.
    Changed,
    /// The user said "Don't load" to exactly this bundle.
    Declined,
    /// A dev plugin, and plugin developer mode is off.
    DevModeOff,
    /// No bundle on disk to judge.
    Missing,
}

/// What the frontend is told about a plugin's trust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrust {
    pub state: TrustState,
    /// SHA-256 of the bundle as it is now; hand it back to approve exactly that.
    pub sha256: Option<String>,
    /// The bundle the user would be approving.
    pub bundle_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Approval {
    plugin_id: String,
    bundle_path: String,
    sha256: String,
    /// The registry's `source_url` when approved. A registry that now names
    /// another source is asked about again, whatever the bytes.
    #[serde(default)]
    source_url: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustFile {
    #[serde(default)]
    version: u32,
    /// Plugin developer mode: dev plugins may load. `None` until the user
    /// sets it: then the build's default (on in debug builds).
    #[serde(default)]
    developer_mode: Option<bool>,
    /// `<plugins dir>\n<plugin id>` → what was approved.
    #[serde(default)]
    approved: HashMap<String, Approval>,
    /// Same key → the SHA-256 of a bundle the user declined.
    #[serde(default)]
    declined: HashMap<String, String>,
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
    crate::brand::app_support_dir().join("plugin-trust.json")
}

fn read_store(path: &Path) -> TrustFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn write_store(path: &Path, file: &TrustFile) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| CommandError::from(format!("create app support dir: {e}")))?;
    }
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| CommandError::from(format!("serialize plugin trust: {e}")))?;
    crate::remote_access::write_private(path, json.as_bytes())
        .map_err(|e| CommandError::from(format!("write plugin trust: {e}")))
}

/// Read-modify-write the store under one lock.
fn update_store<T>(path: &Path, f: impl FnOnce(&mut TrustFile) -> T) -> Result<T, CommandError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read_store(path);
    let out = f(&mut file);
    file.version = 1;
    write_store(path, &file)?;
    Ok(out)
}

fn key(plugins_dir: &Path, plugin_id: &str) -> String {
    format!("{}\n{plugin_id}", plugins_dir.to_string_lossy())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Plugin developer mode: as the user set it, else the build's default (on
/// in debug builds; the Plugin Manager shows it either way).
fn developer_mode_at(store: &Path) -> bool {
    read_store(store)
        .developer_mode
        .unwrap_or(cfg!(debug_assertions))
}

/// The bundle a registry entry (or none) points at.
pub(crate) fn bundle_path_for(
    plugins_dir: &Path,
    plugin_id: &str,
    entry: Option<&RegistryEntry>,
) -> PathBuf {
    match entry {
        Some(e) if e.is_dev => PathBuf::from(&e.local_path).join("dist").join("index.js"),
        _ => plugins_dir.join(plugin_id).join("dist").join("index.js"),
    }
}

/// The path the store keeps: symlinks resolved, so a link swapped under an
/// approved path is a different path.
fn canonical(path: &Path) -> String {
    dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// The verdict on `bundle` (bytes already read, or `None` if missing).
fn judge(
    file: &TrustFile,
    developer_mode: bool,
    plugins_dir: &Path,
    plugin_id: &str,
    is_dev: bool,
    source_url: &str,
    bundle: &Path,
    bytes: Option<&[u8]>,
) -> PluginTrust {
    let bundle_path = canonical(bundle);
    let Some(bytes) = bytes else {
        return PluginTrust {
            state: TrustState::Missing,
            sha256: None,
            bundle_path,
        };
    };
    let sha256 = sha256_hex(bytes);
    let k = key(plugins_dir, plugin_id);
    let state = if is_dev && !developer_mode {
        TrustState::DevModeOff
    } else {
        match file.approved.get(&k) {
            Some(a)
                if a.bundle_path == bundle_path
                    && a.sha256 == sha256
                    && a.source_url == source_url =>
            {
                TrustState::Trusted
            }
            _ if file.declined.get(&k) == Some(&sha256) => TrustState::Declined,
            Some(_) => TrustState::Changed,
            None => TrustState::New,
        }
    };
    PluginTrust {
        state,
        sha256: Some(sha256),
        bundle_path,
    }
}

/// Where a registry entry stands, for `list_plugins`.
pub(crate) fn trust_for_entry(plugins_dir: &Path, entry: &RegistryEntry) -> PluginTrust {
    trust_for_entry_at(&store_path(), plugins_dir, entry)
}

fn trust_for_entry_at(store: &Path, plugins_dir: &Path, entry: &RegistryEntry) -> PluginTrust {
    let bundle = bundle_path_for(plugins_dir, &entry.plugin_id, Some(entry));
    let bytes = std::fs::read(&bundle).ok();
    judge(
        &read_store(store),
        developer_mode_at(store),
        plugins_dir,
        &entry.plugin_id,
        entry.is_dev,
        &entry.source_url,
        &bundle,
        bytes.as_deref(),
    )
}

/// The error a plugin that isn't approved gets, wherever it asks.
fn not_approved(plugin_id: &str) -> CommandError {
    CommandError::expected(format!(
        "Plugin '{plugin_id}' isn't approved to run in this project. Allow it from the Plugins menu."
    ))
}

/// The bundle's source, if and only if it is approved as it is now.
/// "Plugin bundle not found: …" is kept byte-identical for usePlugins.
pub(crate) fn verified_bundle(project_path: &str, plugin_id: &str) -> Result<String, CommandError> {
    validate_plugin_id(plugin_id)?;
    let plugins_dir = get_plugins_dir(project_path)?;
    let registry = read_registry(project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    verified_bundle_at(&store_path(), &plugins_dir, plugin_id, entry)
}

fn verified_bundle_at(
    store: &Path,
    plugins_dir: &Path,
    plugin_id: &str,
    entry: Option<&RegistryEntry>,
) -> Result<String, CommandError> {
    let bundle = bundle_path_for(plugins_dir, plugin_id, entry);
    if !bundle.exists() {
        return Err(CommandError::expected(format!(
            "Plugin bundle not found: {}",
            bundle.display()
        )));
    }
    let bytes = std::fs::read(&bundle).map_err(|e| CommandError::Io {
        message: format!("Failed to read plugin bundle: {e}"),
    })?;
    let is_dev = entry.is_some_and(|e| e.is_dev);
    let verdict = judge(
        &read_store(store),
        developer_mode_at(store),
        plugins_dir,
        plugin_id,
        is_dev,
        entry.map_or("", |e| e.source_url.as_str()),
        &bundle,
        Some(&bytes),
    );
    if verdict.state != TrustState::Trusted {
        tracing::warn!(plugin = %plugin_id, state = ?verdict.state, "[Plugins] refused to load an unapproved bundle");
        return Err(not_approved(plugin_id));
    }
    String::from_utf8(bytes).map_err(|e| CommandError::Io {
        message: format!("Failed to read plugin bundle: {e}"),
    })
}

/// For the plugin's own capabilities (shell, fs): refused unless approved.
pub(crate) fn require_trusted(project_path: &str, plugin_id: &str) -> Result<(), CommandError> {
    let plugins_dir = get_plugins_dir(project_path)?;
    let registry = read_registry(project_path)?;
    let Some(entry) = registry.plugins.iter().find(|e| e.plugin_id == plugin_id) else {
        return Err(not_approved(plugin_id));
    };
    if trust_for_entry(&plugins_dir, entry).state == TrustState::Trusted {
        Ok(())
    } else {
        Err(not_approved(plugin_id))
    }
}

/// Record the bundle on disk now as approved (the user installed, linked or
/// allowed it). `expected` pins the hash the user was shown, if any.
fn approve_at(
    store: &Path,
    plugins_dir: &Path,
    plugin_id: &str,
    entry: Option<&RegistryEntry>,
    expected: Option<&str>,
) -> Result<(), CommandError> {
    let bundle = bundle_path_for(plugins_dir, plugin_id, entry);
    let bytes = std::fs::read(&bundle).map_err(|_| {
        CommandError::expected(format!("Plugin bundle not found: {}", bundle.display()))
    })?;
    let sha256 = sha256_hex(&bytes);
    if expected.is_some_and(|e| e != sha256) {
        return Err(CommandError::expected(
            "This plugin changed since you were asked. Look it over and allow it again.",
        ));
    }
    let k = key(plugins_dir, plugin_id);
    let approval = Approval {
        plugin_id: plugin_id.to_string(),
        bundle_path: canonical(&bundle),
        sha256,
        source_url: entry.map(|e| e.source_url.clone()).unwrap_or_default(),
    };
    update_store(store, |file| {
        file.declined.remove(&k);
        file.approved.insert(k, approval);
    })
}

/// After a user-initiated install or link: trust what was just put there.
pub(crate) fn record_installed(project_path: &str, plugin_id: &str) -> Result<(), CommandError> {
    let plugins_dir = get_plugins_dir(project_path)?;
    let registry = read_registry(project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    approve_at(&store_path(), &plugins_dir, plugin_id, entry, None)
}

/// After an update. Trust carries over only when the user asked for the
/// update (never the automatic re-install of a missing bundle), had approved
/// this plugin here before, and the registry still names the source it was
/// approved from. Anything else asks like any other new bundle.
pub(crate) fn record_updated(
    project_path: &str,
    plugin_id: &str,
    user_initiated: bool,
) -> Result<(), CommandError> {
    let plugins_dir = get_plugins_dir(project_path)?;
    let registry = read_registry(project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    record_updated_at(
        &store_path(),
        &plugins_dir,
        plugin_id,
        entry,
        user_initiated,
    )
}

fn record_updated_at(
    store: &Path,
    plugins_dir: &Path,
    plugin_id: &str,
    entry: Option<&RegistryEntry>,
    user_initiated: bool,
) -> Result<(), CommandError> {
    if !user_initiated {
        return Ok(());
    }
    let source_url = entry.map_or("", |e| e.source_url.as_str());
    let same_source = read_store(store)
        .approved
        .get(&key(plugins_dir, plugin_id))
        .is_some_and(|a| a.source_url == source_url);
    if !same_source {
        return Ok(());
    }
    approve_at(store, plugins_dir, plugin_id, entry, None)
}

/// Uninstalled or unlinked: nothing to remember.
pub(crate) fn forget(project_path: &str, plugin_id: &str) {
    let Ok(plugins_dir) = get_plugins_dir(project_path) else {
        return;
    };
    let k = key(&plugins_dir, plugin_id);
    let _ = update_store(&store_path(), |file| {
        file.approved.remove(&k);
        file.declined.remove(&k);
    });
}

/// Whether dev plugins may be linked and loaded right now.
pub(crate) fn developer_mode() -> bool {
    developer_mode_at(&store_path())
}

/// Owner-only, whatever an older build left.
pub fn harden_plugin_trust_store() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = store_path();
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

/* ------------------------------------------------------------ commands */

/// "Allow": approve exactly the bundle the user was shown (`sha256`).
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, plugin = %plugin_id))]
pub fn approve_plugin(
    project_path: String,
    plugin_id: String,
    sha256: String,
) -> Result<(), CommandError> {
    validate_plugin_id(&plugin_id)?;
    let plugins_dir = get_plugins_dir(&project_path)?;
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    let Some(entry) = entry else {
        return Err(CommandError::expected(format!(
            "Plugin '{plugin_id}' not found"
        )));
    };
    let store = store_path();
    if entry.is_dev && !developer_mode_at(&store) {
        return Err(CommandError::expected(
            "Dev plugins load only in plugin developer mode. Turn it on from the Plugin Manager first.",
        ));
    }
    approve_at(&store, &plugins_dir, &plugin_id, Some(entry), Some(&sha256))
}

/// "Don't load": remembered for this exact bundle.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, plugin = %plugin_id))]
pub fn decline_plugin(
    project_path: String,
    plugin_id: String,
    sha256: String,
) -> Result<(), CommandError> {
    validate_plugin_id(&plugin_id)?;
    let plugins_dir = get_plugins_dir(&project_path)?;
    let k = key(&plugins_dir, &plugin_id);
    update_store(&store_path(), |file| {
        file.declined.insert(k, sha256);
    })
}

#[tauri::command]
#[tracing::instrument]
pub fn get_plugin_developer_mode() -> Result<bool, CommandError> {
    Ok(developer_mode_at(&store_path()))
}

#[tauri::command]
#[tracing::instrument]
pub fn set_plugin_developer_mode(enabled: bool) -> Result<(), CommandError> {
    update_store(&store_path(), |file| file.developer_mode = Some(enabled))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _tmp: tempfile::TempDir,
        store: PathBuf,
        plugins: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("support").join("plugin-trust.json");
        let plugins = tmp.path().join("proj").join(".shipstudio").join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        Fixture {
            _tmp: tmp,
            store,
            plugins,
        }
    }

    fn installed(plugins: &Path, id: &str, js: &str) -> RegistryEntry {
        let dist = plugins.join(id).join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.js"), js).unwrap();
        RegistryEntry {
            plugin_id: id.into(),
            enabled: true,
            installed_at: 0,
            source_url: "https://github.com/x/y".into(),
            installed_commit: String::new(),
            is_dev: false,
            local_path: String::new(),
        }
    }

    #[test]
    fn a_plugin_listed_by_the_registry_alone_is_not_loaded() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "export const name='hi'");
        let t = trust_for_entry_at(&f.store, &f.plugins, &e);
        assert_eq!(t.state, TrustState::New);
        assert_eq!(t.sha256.as_deref().map(str::len), Some(64));
        let err = verified_bundle_at(&f.store, &f.plugins, "hello", Some(&e)).unwrap_err();
        assert!(err.to_string().contains("isn't approved"), "{err}");
    }

    #[test]
    fn approval_loads_exactly_those_bytes_and_a_change_asks_again() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        let sha = trust_for_entry_at(&f.store, &f.plugins, &e).sha256.unwrap();
        approve_at(&f.store, &f.plugins, "hello", Some(&e), Some(&sha)).unwrap();
        assert_eq!(
            verified_bundle_at(&f.store, &f.plugins, "hello", Some(&e)).unwrap(),
            "v1"
        );
        // A pull that rewrote the bundle.
        std::fs::write(f.plugins.join("hello/dist/index.js"), "v2").unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::Changed
        );
        assert!(verified_bundle_at(&f.store, &f.plugins, "hello", Some(&e)).is_err());
    }

    #[test]
    fn approving_a_stale_hash_records_nothing() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        let shown = trust_for_entry_at(&f.store, &f.plugins, &e).sha256.unwrap();
        std::fs::write(f.plugins.join("hello/dist/index.js"), "evil").unwrap();
        assert!(approve_at(&f.store, &f.plugins, "hello", Some(&e), Some(&shown)).is_err());
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::New
        );
    }

    #[test]
    fn approval_is_per_project() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        approve_at(&f.store, &f.plugins, "hello", Some(&e), None).unwrap();
        // The same plugin, byte for byte, in another project.
        let other = f.plugins.parent().unwrap().parent().unwrap().join("other");
        let other_plugins = other.join(".shipstudio/plugins");
        let e2 = installed(&other_plugins, "hello", "v1");
        assert_eq!(
            trust_for_entry_at(&f.store, &other_plugins, &e2).state,
            TrustState::New
        );
    }

    #[test]
    fn declining_is_remembered_for_that_bundle_only() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        let sha = trust_for_entry_at(&f.store, &f.plugins, &e).sha256.unwrap();
        update_store(&f.store, |file| {
            file.declined.insert(key(&f.plugins, "hello"), sha);
        })
        .unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::Declined
        );
        std::fs::write(f.plugins.join("hello/dist/index.js"), "v2").unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::New
        );
    }

    #[test]
    fn a_dev_plugin_needs_developer_mode() {
        let f = fixture();
        let dev_dir = f.plugins.parent().unwrap().join("dev-plugin");
        std::fs::create_dir_all(dev_dir.join("dist")).unwrap();
        std::fs::write(dev_dir.join("dist/index.js"), "dev").unwrap();
        let e = RegistryEntry {
            plugin_id: "devp".into(),
            enabled: true,
            installed_at: 0,
            source_url: String::new(),
            installed_commit: String::new(),
            is_dev: true,
            local_path: dev_dir.to_string_lossy().into_owned(),
        };
        let file = TrustFile::default();
        let bundle = bundle_path_for(&f.plugins, "devp", Some(&e));
        let off = judge(
            &file,
            false,
            &f.plugins,
            "devp",
            true,
            "",
            &bundle,
            Some(b"dev"),
        );
        assert_eq!(off.state, TrustState::DevModeOff);
        let on = judge(
            &file,
            true,
            &f.plugins,
            "devp",
            true,
            "",
            &bundle,
            Some(b"dev"),
        );
        assert_eq!(on.state, TrustState::New);
    }

    #[test]
    fn a_repo_cannot_repoint_an_approved_plugin_at_another_folder() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "same bytes");
        approve_at(&f.store, &f.plugins, "hello", Some(&e), None).unwrap();
        // Same id, same bytes, but the registry now says it's a dev plugin elsewhere.
        let elsewhere = f.plugins.parent().unwrap().join("elsewhere");
        std::fs::create_dir_all(elsewhere.join("dist")).unwrap();
        std::fs::write(elsewhere.join("dist/index.js"), "same bytes").unwrap();
        let file = read_store(&f.store);
        let bundle = elsewhere.join("dist/index.js");
        let t = judge(
            &file,
            true,
            &f.plugins,
            "hello",
            true,
            &e.source_url,
            &bundle,
            Some(b"same bytes"),
        );
        assert_eq!(t.state, TrustState::Changed);
    }

    #[test]
    fn a_registry_that_names_another_source_is_asked_about_again() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "same bytes");
        approve_at(&f.store, &f.plugins, "hello", Some(&e), None).unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::Trusted
        );
        let swapped = RegistryEntry {
            source_url: "https://github.com/attacker/y".into(),
            ..e.clone()
        };
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &swapped).state,
            TrustState::Changed
        );
        assert!(verified_bundle_at(&f.store, &f.plugins, "hello", Some(&swapped)).is_err());
    }

    #[test]
    fn the_automatic_reinstall_never_carries_trust() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        approve_at(&f.store, &f.plugins, "hello", Some(&e), None).unwrap();
        // The self-heal fetched new bytes: not approved, whatever the source.
        installed(&f.plugins, "hello", "v2 from the repo's registry");
        record_updated_at(&f.store, &f.plugins, "hello", Some(&e), false).unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::Changed
        );
        // Re-fetching the exact approved bytes from the approved source still loads.
        installed(&f.plugins, "hello", "v1");
        record_updated_at(&f.store, &f.plugins, "hello", Some(&e), false).unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::Trusted
        );
    }

    #[test]
    fn a_user_update_keeps_trust_only_from_the_approved_source() {
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        approve_at(&f.store, &f.plugins, "hello", Some(&e), None).unwrap();
        installed(&f.plugins, "hello", "v2");
        record_updated_at(&f.store, &f.plugins, "hello", Some(&e), true).unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &e).state,
            TrustState::Trusted
        );

        let swapped = RegistryEntry {
            source_url: "https://github.com/attacker/y".into(),
            ..e.clone()
        };
        installed(&f.plugins, "hello", "v3");
        record_updated_at(&f.store, &f.plugins, "hello", Some(&swapped), true).unwrap();
        assert_eq!(
            trust_for_entry_at(&f.store, &f.plugins, &swapped).state,
            TrustState::Changed
        );
    }

    #[test]
    fn developer_mode_is_the_users_switch_with_the_builds_default() {
        let f = fixture();
        assert_eq!(developer_mode_at(&f.store), cfg!(debug_assertions));
        update_store(&f.store, |file| file.developer_mode = Some(false)).unwrap();
        assert!(!developer_mode_at(&f.store), "off even in a debug build");
        update_store(&f.store, |file| file.developer_mode = Some(true)).unwrap();
        assert!(developer_mode_at(&f.store));
        // A store written by the build before this one (a plain bool) reads.
        std::fs::write(&f.store, r#"{"version":1,"developer_mode":true}"#).unwrap();
        assert!(developer_mode_at(&f.store));
    }

    #[test]
    fn a_missing_bundle_keeps_its_load_bearing_message() {
        let f = fixture();
        let err = verified_bundle_at(&f.store, &f.plugins, "gone", None).unwrap_err();
        assert!(err.to_string().contains("Plugin bundle not found"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let e = installed(&f.plugins, "hello", "v1");
        approve_at(&f.store, &f.plugins, "hello", Some(&e), None).unwrap();
        let mode = std::fs::metadata(&f.store).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
