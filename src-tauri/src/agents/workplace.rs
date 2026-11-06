//! Where an agent's turn is working: the codebase its calls touch.
//!
//! When an agent works in a folder that is a git repository — by its own
//! commands (`cd ~/Desktop/Projects/site && npm run build`), by reading or
//! editing files there, through a project session, or because it is bound to
//! a project — that folder is the project it is working in. The turn's live
//! status carries it (`TurnWork::project`), so the Projects sidebar (desk) and
//! the Projects tab (phone) show the agent at work there, with the step it's
//! on.
//!
//! **Found, then registered.** A repository outside the projects folder that
//! the app doesn't know yet is registered as an external project (the same
//! registry "Add local folder" writes, through the same checks:
//! `ensure_external_project_registered` refuses anything that doesn't look
//! like a project), and pinned to the top of the sidebar the first time it is
//! found. Only the first time: [`FOUND`] remembers what was pinned, so a
//! project the user unpinned stays unpinned.
//!
//! **Never a guess.** Only a folder with a `.git` *directory* counts, found by
//! walking up from a path a call actually named. A `.git` file (a submodule or
//! someone's own worktree) stops the walk rather than skipping past it to a
//! parent repository. The home folder and anything above it, a projects root
//! itself, the app's own data (agents' homes) and task copies (`.worktrees/`,
//! whose project the turn already knows) never count.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::work::Action;

/// Emitted when a turn finds a project it is working in that the app just
/// registered or pinned: the sidebar and the project list re-read.
pub const EVENT_FOUND: &str = "agents://project-found";

/// The project each agent's turn in progress works in, by agent id.
static WORKING: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn working() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    WORKING.lock().unwrap_or_else(|e| e.into_inner())
}

/// A turn starts: it works in its bound project (or its copy's project), or
/// nowhere yet.
pub fn begin(agent_id: &str, bound: Option<&Path>) {
    let mut map = working();
    match bound {
        Some(p) => map.insert(agent_id.to_string(), p.to_string_lossy().into_owned()),
        None => map.remove(agent_id),
    };
}

/// The project the agent's turn in progress works in, if any.
pub fn working_in(agent_id: &str) -> Option<String> {
    working().get(agent_id).cloned()
}

pub fn forget_agent(agent_id: &str) {
    working().remove(agent_id);
}

/// What a call names that could be in a codebase: files it edits or reads,
/// folders it searches, and the folders its command line changes into or
/// points git at (`cd`, `pushd`, `git -C`, `--prefix`/`--cwd`/`--dir`).
pub fn named_paths(action: &Action) -> Vec<String> {
    let mut out: Vec<String> = action.files.iter().chain(&action.paths).cloned().collect();
    if let Some(command) = &action.command {
        for words in super::go_hard::commands(command) {
            let words: Vec<&str> = words.iter().map(String::as_str).collect();
            for (i, w) in words.iter().enumerate() {
                let next = words.get(i + 1).copied();
                let takes = match *w {
                    "cd" | "pushd" => i == 0 || words[..i].iter().all(|p| p.contains('=')),
                    "-C" => words.first() == Some(&"git"),
                    "--prefix" | "--cwd" | "--dir" => true,
                    _ => false,
                };
                if takes {
                    if let Some(n) = next.filter(|n| !n.starts_with('-')) {
                        out.push(n.to_string());
                    }
                }
                for flag in ["--prefix=", "--cwd=", "--dir="] {
                    if let Some(v) = w.strip_prefix(flag) {
                        out.push(v.to_string());
                    }
                }
            }
        }
    }
    out
}

/// What can't be a project the agent works in.
pub struct Exclusions {
    pub home: PathBuf,
    /// Projects roots themselves (their direct children are projects).
    pub roots: Vec<PathBuf>,
    /// The app's own data: agents' homes, bridge config.
    pub app_data: Vec<PathBuf>,
}

impl Exclusions {
    fn current() -> Option<Exclusions> {
        let home = dirs::home_dir()?;
        let mut app_data = vec![crate::brand::app_support_dir()];
        if let Ok(root) = super::store::agents_root() {
            app_data.push(root);
        }
        Some(Exclusions {
            home,
            roots: crate::utils::allowed_project_roots(),
            app_data,
        })
    }
}

/// `~/x` and `$HOME/x` against the home; a relative path against `cwd`.
/// Anything with another variable in it is not a path we can read.
fn absolute(raw: &str, cwd: &Path, home: &Path) -> Option<PathBuf> {
    let raw = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    if raw.is_empty() {
        return None;
    }
    let home_s = home.to_string_lossy();
    let raw = raw
        .replacen("${HOME}", &home_s, 1)
        .replacen("$HOME", &home_s, 1);
    if raw.contains('$') || raw.contains('*') {
        return None;
    }
    let p = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if raw.starts_with('~') {
        return None;
    } else if raw.starts_with('/') {
        PathBuf::from(&raw)
    } else {
        cwd.join(&raw)
    };
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    Some(out)
}

/// What a `.git` entry in a folder is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitEntry {
    None,
    Dir,
    /// A submodule or a linked worktree: not a repository of its own here.
    File,
}

fn git_entry(dir: &Path) -> GitEntry {
    match std::fs::symlink_metadata(dir.join(".git")) {
        Ok(m) if m.is_dir() => GitEntry::Dir,
        Ok(_) => GitEntry::File,
        Err(_) => GitEntry::None,
    }
}

/// The repository `path` is in: the nearest folder at or above it with a
/// `.git` directory, below the home folder's level. Pure apart from `probe`.
pub fn repo_root(
    path: &Path,
    ex: &Exclusions,
    probe: &dyn Fn(&Path) -> GitEntry,
) -> Option<PathBuf> {
    if ex.app_data.iter().any(|d| path.starts_with(d)) {
        return None;
    }
    if path.components().any(|c| c.as_os_str() == ".worktrees") {
        return None;
    }
    for dir in path.ancestors() {
        // The home folder and above, and a projects root, are never one.
        if dir == ex.home || ex.home.starts_with(dir) || ex.roots.iter().any(|r| r == dir) {
            return None;
        }
        match probe(dir) {
            GitEntry::Dir => return Some(dir.to_path_buf()),
            GitEntry::File => return None,
            GitEntry::None => {}
        }
    }
    None
}

/// The project a call works in, from the paths it names.
pub fn project_of(
    action: &Action,
    cwd: &Path,
    ex: &Exclusions,
    probe: &dyn Fn(&Path) -> GitEntry,
) -> Option<PathBuf> {
    named_paths(action)
        .iter()
        .filter_map(|raw| absolute(raw, cwd, &ex.home))
        .find_map(|p| repo_root(&p, ex, probe))
}

/// A call the turn made: if it works in a codebase, that is where the turn
/// works now. A new one is registered and pinned in the background.
pub fn note(app: &AppHandle, agent_id: &str, cwd: &Path, action: &Action) {
    if let Some(named) = action.project.clone() {
        // A project tool: the project is already one of the user's; only its
        // name needs reading as a path.
        let app = app.clone();
        let id = agent_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Ok(Some(p)) = super::project::resolve(&named).await {
                set(&app, &id, PathBuf::from(p.path));
            }
        });
        return;
    }
    let Some(ex) = Exclusions::current() else {
        return;
    };
    if let Some(root) = project_of(action, cwd, &ex, &git_entry) {
        set(app, agent_id, root);
    }
}

fn set(app: &AppHandle, agent_id: &str, root: PathBuf) {
    let path = root.to_string_lossy().into_owned();
    {
        let mut map = working();
        if map.get(agent_id) == Some(&path) {
            return;
        }
        map.insert(agent_id.to_string(), path.clone());
    }
    super::runner::refresh_status(app, agent_id);
    let app = app.clone();
    let agent_id = agent_id.to_string();
    tauri::async_runtime::spawn(async move {
        adopt(&app, &agent_id, &path).await;
    });
}

/* ------------------------------------------------------------ registering */

/// Projects found and pinned once, so an unpinned one stays unpinned.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    #[serde(default)]
    pinned: Vec<String>,
}

static FOUND: Mutex<()> = Mutex::new(());

fn found_path() -> Option<PathBuf> {
    super::store::agents_root()
        .ok()
        .map(|r| r.join("found-projects.json"))
}

/// Whether `path` is pinned for the first time (and remember it either way).
fn first_pin(path: &str) -> bool {
    let _guard = FOUND.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = found_path() else {
        return false;
    };
    let mut found: Found = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if found.pinned.iter().any(|p| p == path) {
        return false;
    }
    found.pinned.push(path.to_string());
    match serde_json::to_vec_pretty(&found) {
        Ok(json) => super::store::write_atomic(&file, &json).is_ok(),
        Err(_) => false,
    }
}

/// Make the project one the app lists (registered when it's outside the
/// projects folder) and, the first time, pin it to the top of the sidebar.
async fn adopt(app: &AppHandle, agent_id: &str, path: &str) {
    let registered = crate::commands::external_projects::ensure_external_project_registered(
        app.clone(),
        path.to_string(),
    )
    .await;
    let newly = match registered {
        Ok(newly) => newly,
        Err(e) => {
            tracing::info!(path, error = %e, "agent's folder not registered as a project");
            return;
        }
    };
    let pinned = first_pin(path) && crate::commands::projects::pin_to_top(path).unwrap_or(false);
    if newly || pinned {
        tracing::info!(path, newly, pinned, "agent working in a project");
        let _ = app.emit(
            EVENT_FOUND,
            serde_json::json!({ "path": path, "agentId": agent_id }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex() -> Exclusions {
        Exclusions {
            home: PathBuf::from("/Users/sam"),
            roots: vec![PathBuf::from("/Users/sam/ShipStudio")],
            app_data: vec![
                PathBuf::from("/Users/sam/Library/Application Support/Dashbot"),
                PathBuf::from("/Users/sam/ShipStudio/.shipstudio/agents"),
            ],
        }
    }

    /// A fictional disk: these folders hold a `.git` directory, these a file.
    fn disk(
        dirs: &'static [&'static str],
        files: &'static [&'static str],
    ) -> impl Fn(&Path) -> GitEntry {
        move |p: &Path| {
            let s = p.to_string_lossy();
            if dirs.contains(&s.as_ref()) {
                GitEntry::Dir
            } else if files.contains(&s.as_ref()) {
                GitEntry::File
            } else {
                GitEntry::None
            }
        }
    }

    fn bash(command: &str) -> Action {
        super::super::work::describe_tool("Bash", Some(&serde_json::json!({ "command": command })))
            .unwrap()
    }

    fn tool(name: &str, input: serde_json::Value) -> Action {
        super::super::work::describe_tool(name, Some(&input)).unwrap()
    }

    const REPOS: &[&str] = &[
        "/Users/sam/Desktop/Projects/lumen-site",
        "/Users/sam/ShipStudio/acme-marketing",
        "/Users/sam",
        "/Users/sam/ShipStudio",
    ];

    #[test]
    fn a_cd_into_a_repository_is_working_in_it() {
        let cwd = Path::new("/Users/sam/ShipStudio/.shipstudio/agents/a1");
        let probe = disk(REPOS, &[]);
        for command in [
            "cd ~/Desktop/Projects/lumen-site && npm run build",
            "cd /Users/sam/Desktop/Projects/lumen-site/src; ls",
            "git -C ~/Desktop/Projects/lumen-site status",
            "npm --prefix ~/Desktop/Projects/lumen-site test",
            "pnpm --dir=$HOME/Desktop/Projects/lumen-site build",
            "bash -c \"cd ~/Desktop/Projects/lumen-site && pnpm dev\"",
        ] {
            assert_eq!(
                project_of(&bash(command), cwd, &ex(), &probe),
                Some(PathBuf::from("/Users/sam/Desktop/Projects/lumen-site")),
                "{command}"
            );
        }
        // Commands that name no folder work nowhere in particular.
        assert_eq!(project_of(&bash("npm run build"), cwd, &ex(), &probe), None);
        assert_eq!(project_of(&bash("echo cd ~/x"), cwd, &ex(), &probe), None);
    }

    #[test]
    fn reads_edits_and_searches_find_their_repository() {
        let cwd = Path::new("/tmp");
        let probe = disk(REPOS, &[]);
        let want = Some(PathBuf::from("/Users/sam/ShipStudio/acme-marketing"));
        for action in [
            tool(
                "Read",
                serde_json::json!({ "file_path": "/Users/sam/ShipStudio/acme-marketing/src/App.tsx" }),
            ),
            tool(
                "Edit",
                serde_json::json!({ "file_path": "/Users/sam/ShipStudio/acme-marketing/new/deep/file.ts" }),
            ),
            tool(
                "Grep",
                serde_json::json!({ "pattern": "hero", "path": "/Users/sam/ShipStudio/acme-marketing" }),
            ),
        ] {
            assert_eq!(
                project_of(&action, cwd, &ex(), &probe),
                want,
                "{}",
                action.label
            );
        }
    }

    #[test]
    fn the_home_roots_app_data_copies_and_submodules_never_count() {
        let cwd = Path::new("/tmp");
        // The home folder and the projects root have a .git: neither is a project.
        let probe = disk(
            REPOS,
            &["/Users/sam/Desktop/Projects/lumen-site/vendor/lib"],
        );
        let none = |p: &str| repo_root(Path::new(p), &ex(), &probe);
        assert_eq!(none("/Users/sam/notes.txt"), None);
        assert_eq!(none("/Users/sam/Documents/thing"), None);
        assert_eq!(none("/Users/sam/ShipStudio/loose-file.md"), None);
        assert_eq!(
            none("/Users/sam/ShipStudio/.shipstudio/agents/a1/CLAUDE.md"),
            None
        );
        assert_eq!(
            none("/Users/sam/ShipStudio/.worktrees/acme-marketing-fix/src/a.ts"),
            None
        );
        // A .git file stops the walk: never the parent repository by mistake.
        assert_eq!(
            none("/Users/sam/Desktop/Projects/lumen-site/vendor/lib/x.c"),
            None
        );
        assert_eq!(none("/"), None);
        // Variables we can't read are not paths.
        assert_eq!(
            project_of(&bash("cd $PROJECT && make"), cwd, &ex(), &probe),
            None
        );
    }

    #[test]
    fn a_turn_works_in_its_bound_project_until_it_moves() {
        let id = format!("workplace-{}", super::super::store::new_id());
        assert_eq!(working_in(&id), None);
        begin(&id, Some(Path::new("/Users/sam/ShipStudio/acme-marketing")));
        assert_eq!(
            working_in(&id).as_deref(),
            Some("/Users/sam/ShipStudio/acme-marketing")
        );
        begin(&id, None);
        assert_eq!(working_in(&id), None);
        forget_agent(&id);
    }
}
