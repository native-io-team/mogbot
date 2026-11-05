//! A copy of the project per task, for agents bound to a project.
//!
//! A bound agent's work happens in its own git worktree on its own branch,
//! never in the user's working copy, so two agents (or an agent and the user)
//! can't trample each other. The words the user sees are "a copy of the
//! project", "Keep changes", "Discard": git stays underneath.
//!
//! - **When**: the first turn of a bound agent that has no open copy makes
//!   one, before the turn starts (the turn's working directory is fixed when
//!   its process spawns, so it can't be made lazily on the first edit). The
//!   copy stays open across turns, so "now make it smaller" lands in the same
//!   copy, until the user keeps or discards it. A turn that made a copy and
//!   changed nothing removes it again, so a question costs nothing.
//! - **Where**: `<projects root>/.worktrees/<project folder>/<agent>-<task>`,
//!   the folder Ship Studio's own worktrees use: inside the projects root (so
//!   the workspace can open it for a preview) but dot-prefixed (so no
//!   dashboard lists it). Never inside the project tree. Locked with
//!   [`LOCK_MARK`], so `git worktree prune` and Ship Studio's plain remove
//!   leave it alone.
//! - **Branch**: `<agent-slug>/<task-slug>-<id>`, from the agent's name and
//!   the first words of the request.
//! - **Dependencies**: every untracked `node_modules` near the project's root
//!   is cloned in with APFS copy-on-write (`cp -c`), which costs no disk until
//!   something writes to it (measured: a 317 MB, 31k-entry pnpm tree in 4.7s
//!   and no change in free space). Where cloning isn't possible nothing is
//!   copied, and the agent is told dependencies aren't installed.
//! - **Limits**: at most [`MAX_COPIES_PER_PROJECT`] open copies per project,
//!   and none is made with less than [`MIN_FREE_BYTES`] free. Both refuse the
//!   turn with a sentence saying what to do; nothing falls back to the
//!   user's working copy silently.
//! - **Commits**: what a turn leaves uncommitted is committed on the copy's
//!   branch when the turn ends (`--no-verify`: these are bookkeeping, not the
//!   user's commits; the project's checks still run on a pull request).
//! - **Keep**: the project's current branch is merged into the copy first, so
//!   any conflict happens in the copy, never in the user's folder; then the
//!   project fast-forwards to it. A conflict is left in the copy for the
//!   workspace's conflict UI (or the agent) to resolve.
//!
//! Projects that aren't git repositories (or have no commit yet), and agents
//! set to work directly in the project, run in the project as before.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::AppHandle;

use super::store;
use crate::errors::CommandError;

/// How many agents may each have an open copy of one project.
pub const MAX_COPIES_PER_PROJECT: usize = 4;
/// Free space below which no copy is made.
pub const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Starts the lock reason of every copy we make; the rest is the agent's id.
pub const LOCK_MARK: &str = "agent-copy:";

const GIT_TIMEOUT_SECS: u64 = 60;
/// Cloning dependencies: thousands of files, still bounded.
const CLONE_TIMEOUT_SECS: u64 = 180;

/// A bound agent's open copy of its project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCopy {
    pub id: String,
    /// The user's own project folder, as the agent is bound to it.
    pub project: String,
    /// The copy (a linked git worktree).
    pub path: String,
    pub branch: String,
    /// The commit the copy started from.
    pub base: String,
    /// The branch the project had checked out when the copy was made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    pub created_at: i64,
    /// Whether the project's dependencies were cloned in.
    #[serde(default)]
    pub deps: bool,
}

/// What a change card says about the copy it describes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopyRef {
    pub id: String,
    pub path: String,
    pub branch: String,
}

impl From<&TaskCopy> for CopyRef {
    fn from(c: &TaskCopy) -> Self {
        CopyRef {
            id: c.id.clone(),
            path: c.path.clone(),
            branch: c.branch.clone(),
        }
    }
}

/// What "Keep changes" did.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Kept {
    /// In the project now; the copy is gone.
    Kept { files: u32 },
    /// The copy had nothing the project doesn't; it is gone.
    Nothing,
    /// Some changes overlap with edits made in the project since; the copy
    /// is mid-merge, with these files to choose in.
    Conflict { files: Vec<String> },
}

/* ---------------------------------------------------------------- git */

async fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output, CommandError> {
    let mut cmd = crate::utils::git_command_in(dir)?;
    cmd.env("GIT_OPTIONAL_LOCKS", "0").args(args);
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "git (agent copy)",
        GIT_TIMEOUT_SECS,
    )
    .await
}

/// Stdout of a command that succeeded, trimmed; `None` otherwise.
async fn read(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git(dir, args).await.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn run(dir: &Path, args: &[&str]) -> Result<String, CommandError> {
    let out = git(dir, args).await?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Err(CommandError::Process {
        cmd: format!("git {}", args.join(" ")),
        exit_code: out.status.code().unwrap_or(-1),
        stderr: if stderr.is_empty() { stdout } else { stderr },
    })
}

fn lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Files git still lists as unmerged.
async fn unmerged(dir: &Path) -> Vec<String> {
    read(dir, &["diff", "--name-only", "--diff-filter=U"])
        .await
        .map(|s| lines(&s))
        .unwrap_or_default()
}

/* -------------------------------------------------------------- names */

/// Lowercase ascii words of `text`, at most `words` of them, joined by `-`.
pub fn slug(text: &str, words: usize) -> String {
    let lowered = text.to_lowercase();
    let picked: Vec<&str> = lowered
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(words)
        .collect();
    let mut out = picked.join("-");
    out.truncate(32);
    out.trim_end_matches('-').to_string()
}

/// The branch and folder for a new copy: `<agent>/<task>-<id>`, and the
/// same with `-` for the folder. `taken` says a plain branch is already
/// called `<agent>`, which would make `<agent>/…` an invalid ref.
pub fn names(agent_name: &str, request: &str, id: &str, taken: bool) -> (String, String) {
    let agent = Some(slug(agent_name, 4))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "agent".into());
    let task = Some(slug(request, 4))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "task".into());
    let short: String = id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(4)
        .collect();
    let task = format!("{task}-{short}");
    let branch = if taken {
        format!("{agent}-{task}")
    } else {
        format!("{agent}/{task}")
    };
    (branch, format!("{agent}-{task}"))
}

/* ------------------------------------------------------------- disk */

/// Free bytes on the volume holding `path` (or its nearest existing parent).
pub fn free_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid NUL-terminated path; `stat` is a valid out-pointer.
        if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        // The field types differ between platforms; on some the casts are no-ops.
        #[allow(clippy::unnecessary_cast)]
        let free = (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64);
        Some(free)
    }
    #[cfg(not(unix))]
    {
        let _ = probe;
        None
    }
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1024f64.powi(3))
}

/// Untracked `node_modules` folders within three levels of the project root
/// (a monorepo's packages have their own), never looking inside one.
fn dependency_dirs(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "node_modules" {
                out.push(entry.path());
            } else if depth > 0 && !name.starts_with('.') {
                walk(&entry.path(), depth - 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 3, &mut out);
    out
}

/// Whether git ignores `rel` in `dir`. Only ignored files are ever brought
/// into a copy: anything else would become a "change" there, and Keep would
/// commit it into the project (a `.env` nobody meant to commit).
async fn ignored(dir: &Path, rel: &Path) -> bool {
    let rel = rel.to_string_lossy();
    git(dir, &["check-ignore", "-q", "--", &rel])
        .await
        .is_ok_and(|o| o.status.success())
}

/// Clone the project's dependencies into the copy, copy-on-write. True when
/// at least one folder was cloned. Never a full copy: where `cp -c` can't
/// clone, the partial result is removed and nothing is copied.
async fn clone_dependencies(anchor: &Path, dest: &Path) -> bool {
    let mut cloned = false;
    for source in dependency_dirs(anchor) {
        let Ok(rel) = source.strip_prefix(anchor) else {
            continue;
        };
        if !ignored(anchor, rel).await {
            continue;
        }
        let target = dest.join(rel);
        // Only beside folders the checkout produced; never over anything.
        if target.exists() || !target.parent().is_some_and(Path::is_dir) {
            continue;
        }
        let mut cmd = tokio::process::Command::new("/bin/cp");
        cmd.arg("-c").arg("-R").arg(&source).arg(&target);
        match crate::external_command::run_with_timeout(
            cmd,
            "cp -c (agent copy)",
            CLONE_TIMEOUT_SECS,
        )
        .await
        {
            Ok(out) if out.status.success() => cloned = true,
            _ => {
                tracing::info!(
                    "[Agents] couldn't clone {} copy-on-write; leaving dependencies out of the copy",
                    rel.display()
                );
                let _ = std::fs::remove_dir_all(&target);
                return cloned;
            }
        }
    }
    cloned
}

/// What the project needs but git doesn't carry: its `.shipstudio/` dev
/// server settings on a port of the copy's own (the seeding Ship Studio's
/// own worktrees use), and the root `.env*` files and Claude Code's local
/// settings, when git ignores them.
async fn copy_local_files(anchor: &Path, dest: &Path) {
    let (a, d) = (anchor.to_path_buf(), dest.to_path_buf());
    let _ = tokio::task::spawn_blocking(move || {
        crate::commands::git::ensure_shipstudio_excluded(&d);
        crate::commands::git::seed_worktree(&a, &d, false);
    })
    .await;
    let mut wanted: Vec<PathBuf> = std::fs::read_dir(anchor)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(".env"))
                .filter(|e| e.path().is_file())
                .map(|e| PathBuf::from(e.file_name()))
                .collect()
        })
        .unwrap_or_default();
    wanted.push(PathBuf::from(".claude/settings.local.json"));
    for rel in wanted {
        let (source, target) = (anchor.join(&rel), dest.join(&rel));
        if !source.is_file() || target.exists() || !ignored(anchor, &rel).await {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::copy(source, target);
    }
}

/* ------------------------------------------------------------- create */

/// Make a copy of `project` under `root/.worktrees/`. `None` when the
/// project isn't a git repository with a commit to start from.
pub async fn create(
    project: &Path,
    root: &Path,
    agent_id: &str,
    agent_name: &str,
    request: &str,
) -> Result<Option<TaskCopy>, CommandError> {
    let Some(base) = read(project, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).await else {
        return Ok(None);
    };
    let anchor = match read(project, &["worktree", "list", "--porcelain"]).await {
        Some(list) => crate::commands::git::parse_worktree_porcelain(&list)
            .first()
            .map(|w| PathBuf::from(&w.path))
            .unwrap_or_else(|| project.to_path_buf()),
        None => return Ok(None),
    };
    let base_branch = read(project, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .filter(|b| !b.is_empty());
    let id = store::new_id();
    let agent_slug = Some(slug(agent_name, 4))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "agent".into());
    let taken = read(
        project,
        &[
            "show-ref",
            "--verify",
            "-q",
            &format!("refs/heads/{agent_slug}"),
        ],
    )
    .await
    .is_some();
    let (branch, folder) = names(agent_name, request, &id, taken);
    let family = anchor
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());
    let container = root.join(".worktrees").join(&family);
    let dest = container.join(crate::commands::git::sanitize_worktree_folder(&folder));
    if dest.exists() {
        return Err(CommandError::expected(format!(
            "A folder is already where the copy would go ({}).",
            dest.display()
        )));
    }
    std::fs::create_dir_all(&container).map_err(|e| CommandError::Io {
        message: format!("Couldn't make a folder for the copy: {e}"),
    })?;
    let dest_str = dest.to_string_lossy().to_string();
    let reason = format!("{LOCK_MARK}{agent_id}");
    run(
        project,
        &[
            "worktree", "add", "--lock", "--reason", &reason, "-b", &branch, &dest_str, &base,
        ],
    )
    .await?;
    copy_local_files(&anchor, &dest).await;
    let deps = clone_dependencies(&anchor, &dest).await;
    crate::cache::GIT_CACHE.invalidate(&project.to_string_lossy());
    Ok(Some(TaskCopy {
        id,
        project: project.to_string_lossy().to_string(),
        path: dest_str,
        branch,
        base,
        base_branch,
        created_at: store::now_ms(),
        deps,
    }))
}

/* -------------------------------------------------------------- commit */

/// Commit what's uncommitted in the copy. Nothing while conflicts are
/// unresolved: staging would record the conflict markers as the answer.
pub async fn commit_pending(dir: &Path, message: &str) -> Result<bool, CommandError> {
    if !unmerged(dir).await.is_empty() {
        return Ok(false);
    }
    let owned = dir.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        crate::commands::git::ensure_shipstudio_excluded(&owned)
    })
    .await;
    run(dir, &["add", "-A", "."]).await?;
    let staged = git(dir, &["diff", "--cached", "--quiet"]).await?;
    let merging = read(dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .await
        .is_some();
    if staged.status.success() && !merging {
        return Ok(false);
    }
    run(dir, &["commit", "--no-verify", "-q", "-m", message]).await?;
    Ok(true)
}

/// The words of a bookkeeping commit: who, and roughly what.
async fn commit_message(dir: &Path, agent_name: &str) -> String {
    let names = read(dir, &["status", "--porcelain"])
        .await
        .map(|s| lines(&s))
        .unwrap_or_default();
    match names.as_slice() {
        [one] => {
            let path = one.get(3..).unwrap_or(one).trim_matches('"');
            format!("{agent_name}: update {}", super::project::folder_name(path))
        }
        many => format!("{agent_name}: update {} files", many.len()),
    }
}

/// The copy's tree as of its first commit: what "everything in the copy"
/// is measured from.
pub async fn base_tree(copy: &TaskCopy) -> Option<String> {
    read(
        Path::new(&copy.path),
        &["rev-parse", &format!("{}^{{tree}}", copy.base)],
    )
    .await
}

/* -------------------------------------------------------- keep/discard */

/// Remove the copy's folder. The branch goes too when `branch` says so:
/// `Force` always (Discard), `IfMerged` only when it holds nothing the
/// project lacks (cleanup that must never lose work).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Branch {
    Force,
    IfMerged,
}

pub async fn remove(copy: &TaskCopy, branch: Branch) -> Result<(), CommandError> {
    let project = Path::new(&copy.project);
    let anchor = if project.is_dir() {
        project.to_path_buf()
    } else {
        PathBuf::from(&copy.path)
    };
    if Path::new(&copy.path).exists() {
        if let Err(e) = run(
            &anchor,
            &["worktree", "remove", "--force", "--force", &copy.path],
        )
        .await
        {
            // A folder git no longer knows: remove it ourselves, then prune.
            tracing::info!("[Agents] git couldn't remove a copy: {e}");
            let _ = std::fs::remove_dir_all(&copy.path);
        }
    }
    let _ = git(&anchor, &["worktree", "prune"]).await;
    let flag = match branch {
        Branch::Force => "-D",
        Branch::IfMerged => "-d",
    };
    if project.is_dir() {
        let _ = git(project, &["branch", flag, &copy.branch]).await;
    }
    crate::cache::GIT_CACHE.invalidate(&copy.project);
    Ok(())
}

/// Merge the copy into the project's current branch.
pub async fn keep_copy(copy: &TaskCopy, agent_name: &str) -> Result<Kept, CommandError> {
    let project = Path::new(&copy.project);
    let dir = Path::new(&copy.path);
    let name = super::project::folder_name(&copy.project).to_string();
    if !project.is_dir() {
        return Err(CommandError::expected(format!(
            "{} isn't there any more, so there's nowhere to keep these changes.",
            copy.project
        )));
    }
    if !dir.is_dir() {
        return Err(CommandError::expected(
            "The copy isn't there any more, so there's nothing left to keep.",
        ));
    }
    let message = commit_message(dir, agent_name).await;
    commit_pending(dir, &message).await?;
    let still = unmerged(dir).await;
    if !still.is_empty() {
        return Ok(Kept::Conflict { files: still });
    }
    let Some(target) = read(project, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .filter(|b| !b.is_empty())
    else {
        return Err(CommandError::expected(format!(
            "{name} isn't on a branch right now (it's looking at an older version), so there's nowhere to put these changes. Switch {name} back to a branch, then Keep again."
        )));
    };
    let ahead = read(
        project,
        &["rev-list", "--count", &format!("{target}..{}", copy.branch)],
    )
    .await
    .and_then(|n| n.parse::<u32>().ok())
    .unwrap_or(0);
    if ahead == 0 {
        remove(copy, Branch::Force).await?;
        return Ok(Kept::Nothing);
    }
    // Bring the copy up to date with the project first: an overlap stops
    // here, in the copy, and the user's folder is never left mid-merge.
    let merge_message = format!("Bring in the latest {target}");
    let merged = git(
        dir,
        &[
            "merge",
            "--no-verify",
            "--no-edit",
            "-m",
            &merge_message,
            &target,
        ],
    )
    .await?;
    if !merged.status.success() {
        let files = unmerged(dir).await;
        if !files.is_empty() {
            return Ok(Kept::Conflict { files });
        }
        let _ = git(dir, &["merge", "--abort"]).await;
        return Err(CommandError::Process {
            cmd: format!("git merge {target}"),
            exit_code: merged.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&merged.stderr).trim().to_string(),
        });
    }
    let files = read(
        project,
        &[
            "diff",
            "--name-only",
            &format!("{target}...{}", copy.branch),
        ],
    )
    .await
    .map(|s| lines(&s).len() as u32)
    .unwrap_or(0);
    let ff = git(project, &["merge", "--ff-only", "-q", &copy.branch]).await?;
    if !ff.status.success() {
        let stderr = String::from_utf8_lossy(&ff.stderr).to_string();
        let touched: Vec<String> = stderr
            .lines()
            .filter(|l| l.starts_with('\t'))
            .map(|l| l.trim().to_string())
            .take(5)
            .collect();
        if !touched.is_empty() {
            return Err(CommandError::expected(format!(
                "{name} has unsaved edits to files these changes touch ({}). Save or undo them in {name}, then Keep again.",
                touched.join(", ")
            )));
        }
        return Err(CommandError::Process {
            cmd: format!("git merge --ff-only {}", copy.branch),
            exit_code: ff.status.code().unwrap_or(-1),
            stderr: stderr.trim().to_string(),
        });
    }
    crate::cache::GIT_CACHE.invalidate(&copy.project);
    remove(copy, Branch::IfMerged).await?;
    Ok(Kept::Kept { files })
}

/* ------------------------------------------------------ the agent side */

/// One lock per project: making, keeping and discarding copies of the same
/// repository happen one at a time.
static LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn lock(project: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let key = dunce::canonicalize(project)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| project.to_string());
    let lock = LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key)
        .or_default()
        .clone();
    lock.lock_owned().await
}

/// The copy an agent's turns run in right now, if any.
pub fn active(agent: &store::Agent) -> Option<&TaskCopy> {
    let copy = agent.copy.as_ref()?;
    (!agent.work_directly && agent.project.as_deref() == Some(copy.project.as_str()))
        .then_some(copy)
}

/// Before a bound agent's turn: its open copy, or a new one. `Ok(None)` runs
/// the turn as before (unbound, opted out, not a git project). `true` with
/// the copy says this turn made it.
pub async fn prepare(
    app: &AppHandle,
    agent_id: &str,
    request: &str,
) -> Result<Option<(TaskCopy, bool)>, CommandError> {
    if store::get(agent_id)?.project.is_none() {
        return Ok(None);
    }
    let root = crate::utils::projects_root().map_err(super::err_other)?;
    let prepared = prepare_in(agent_id, request, &root, |activity| {
        super::runner::set_status(app, agent_id, super::runner::Status::working(activity));
    })
    .await?;
    if prepared.as_ref().is_some_and(|(_, made)| *made) {
        let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    }
    Ok(prepared)
}

/// [`prepare`], with copies made under `root`. `making` hears what to show
/// while a copy is being made.
pub async fn prepare_in(
    agent_id: &str,
    request: &str,
    root: &Path,
    making: impl FnOnce(String),
) -> Result<Option<(TaskCopy, bool)>, CommandError> {
    let agent = store::get(agent_id)?;
    let Some(project) = agent.project.clone() else {
        return Ok(None);
    };
    if agent.work_directly || !Path::new(&project).is_dir() {
        return Ok(None);
    }
    let _guard = lock(&project).await;
    let agent = store::get(agent_id)?;
    if let Some(copy) = agent.copy.clone() {
        if copy.project == project && Path::new(&copy.path).is_dir() {
            return Ok(Some((copy, false)));
        }
        // Bound elsewhere since, or the folder went: never lose work over it.
        let _ = remove(&copy, Branch::IfMerged).await;
        store::update(agent_id, |a| a.copy = None)?;
    }
    let open = store::list()?
        .iter()
        .filter(|a| a.copy.as_ref().is_some_and(|c| c.project == project))
        .count();
    let name = super::project::folder_name(&project).to_string();
    if open >= MAX_COPIES_PER_PROJECT {
        return Err(CommandError::expected(format!(
            "{open} agents already have a copy of {name} open. Keep or discard one of their changes, then send this again."
        )));
    }
    if let Some(free) = free_bytes(root).filter(|f| *f < MIN_FREE_BYTES) {
        return Err(CommandError::expected(format!(
            "There isn't enough free disk space for a copy of {name} ({} free; a copy needs at least {}). Free some space, or set {} to work directly in the project.",
            gb(free),
            gb(MIN_FREE_BYTES),
            agent.name
        )));
    }
    making(format!("Making a copy of {name}"));
    let request = super::secrets::redact(request).into_owned();
    let Some(copy) = create(Path::new(&project), root, agent_id, &agent.name, &request).await?
    else {
        return Ok(None);
    };
    store::update(agent_id, |a| a.copy = Some(copy.clone()))?;
    Ok(Some((copy, true)))
}

/// After a turn in a copy that changed it: commit what it left, and the card
/// for everything in the copy so far (what Keep would bring over).
pub async fn record_turn(
    agent_id: &str,
    copy: &TaskCopy,
    from: &str,
) -> Option<super::project::ChangeSummary> {
    let dir = Path::new(&copy.path);
    let now = super::project::snapshot(dir).await?;
    if now == from {
        return None;
    }
    let name = store::get(agent_id).map(|a| a.name).unwrap_or_default();
    let message = commit_message(dir, &name).await;
    if let Err(e) = commit_pending(dir, &message).await {
        tracing::warn!("[Agents] couldn't commit in {agent_id}'s copy: {e}");
    }
    let base = base_tree(copy).await?;
    let mut summary = super::project::summary(dir, &base).await?;
    summary.project = copy.project.clone();
    summary.copy = Some(CopyRef::from(copy));
    Some(summary)
}

/// A copy this turn made and left exactly as it started goes again.
pub async fn drop_if_unused(app: &AppHandle, agent_id: &str, copy: &TaskCopy) {
    if dropped_if_unused(agent_id, copy).await {
        let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    }
}

async fn dropped_if_unused(agent_id: &str, copy: &TaskCopy) -> bool {
    let dir = Path::new(&copy.path);
    let (Some(now), Some(base)) = (super::project::snapshot(dir).await, base_tree(copy).await)
    else {
        return false;
    };
    if now != base {
        return false;
    }
    let _guard = lock(&copy.project).await;
    if remove(copy, Branch::Force).await.is_err() {
        return false;
    }
    let _ = store::update(agent_id, |a| {
        if a.copy.as_ref().is_some_and(|c| c.id == copy.id) {
            a.copy = None;
        }
    });
    true
}

fn refuse_while_working(agent: &store::Agent) -> Result<(), CommandError> {
    if super::runner::in_turn(&agent.id) {
        return Err(CommandError::expected(format!(
            "{} is still working on it. Try again when it's finished.",
            agent.name
        )));
    }
    Ok(())
}

fn open_copy(agent: &store::Agent, copy_id: Option<&str>) -> Result<TaskCopy, CommandError> {
    agent
        .copy
        .clone()
        .filter(|c| copy_id.is_none_or(|id| c.id == id))
        .ok_or_else(|| CommandError::expected("Those changes were already kept or discarded."))
}

fn note(app: &AppHandle, agent_id: &str, text: String) {
    let line = super::runner::new_message(agent_id, store::MessageKind::Note, text);
    let _ = super::runner::record(app, line);
}

/// "Keep changes": into the project's current branch.
pub async fn keep(
    app: &AppHandle,
    agent_id: &str,
    copy_id: Option<&str>,
) -> Result<Kept, CommandError> {
    let agent = store::get(agent_id)?;
    refuse_while_working(&agent)?;
    let copy = open_copy(&agent, copy_id)?;
    let _guard = lock(&copy.project).await;
    let name = super::project::folder_name(&copy.project).to_string();
    let kept = keep_copy(&copy, &agent.name).await?;
    match &kept {
        Kept::Kept { files } => {
            let what = match files {
                1 => "1 file".to_string(),
                n => format!("{n} files"),
            };
            note(app, agent_id, format!("Kept the changes in {name} · {what}"));
        }
        Kept::Nothing => note(
            app,
            agent_id,
            format!("Nothing to keep: {name} already has these changes"),
        ),
        Kept::Conflict { .. } => note(
            app,
            agent_id,
            format!(
                "Some of these changes overlap with edits made in {name} since. Open the copy to choose which to keep, or ask {} to sort it out.",
                agent.name
            ),
        ),
    }
    if !matches!(kept, Kept::Conflict { .. }) {
        store::update(agent_id, |a| a.copy = None)?;
    }
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    Ok(kept)
}

/// "Discard": the copy and its branch, gone.
pub async fn discard(
    app: &AppHandle,
    agent_id: &str,
    copy_id: Option<&str>,
) -> Result<(), CommandError> {
    let agent = store::get(agent_id)?;
    refuse_while_working(&agent)?;
    let copy = open_copy(&agent, copy_id)?;
    let _guard = lock(&copy.project).await;
    remove(&copy, Branch::Force).await?;
    store::update(agent_id, |a| a.copy = None)?;
    note(
        app,
        agent_id,
        format!(
            "Discarded the copy of {}",
            super::project::folder_name(&copy.project)
        ),
    );
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    Ok(())
}

/// The agent is being deleted: its copy's folder goes, and its branch only
/// if the project already has everything on it.
pub async fn abandon(copy: TaskCopy) {
    let _guard = lock(&copy.project).await;
    let _ = remove(&copy, Branch::IfMerged).await;
}

/// At launch: forget copies whose folder is gone, and remove copies of ours
/// no agent holds any more (an agent deleted while the app was closing).
/// Branches with work on them are kept.
pub async fn sweep() {
    let Ok(agents) = store::list() else { return };
    let mut projects: Vec<String> = Vec::new();
    for agent in &agents {
        if let Some(copy) = &agent.copy {
            if !Path::new(&copy.path).is_dir() {
                let _ = store::update(&agent.id, |a| a.copy = None);
                let _ = git(Path::new(&copy.project), &["worktree", "prune"]).await;
            }
            projects.push(copy.project.clone());
        }
        if let Some(p) = &agent.project {
            projects.push(p.clone());
        }
    }
    projects.sort();
    projects.dedup();
    let held: Vec<String> = agents
        .iter()
        .filter_map(|a| a.copy.as_ref().map(|c| c.path.clone()))
        .collect();
    for project in projects {
        let dir = Path::new(&project);
        let Some(list) = read(dir, &["worktree", "list", "--porcelain"]).await else {
            continue;
        };
        for wt in crate::commands::git::parse_worktree_porcelain(&list) {
            let ours = wt
                .locked
                .as_deref()
                .is_some_and(|r| r.starts_with(LOCK_MARK));
            if !ours || held.iter().any(|h| same_path(h, &wt.path)) {
                continue;
            }
            let orphan = TaskCopy {
                id: String::new(),
                project: project.clone(),
                path: wt.path.clone(),
                branch: wt.branch.clone().unwrap_or_default(),
                base: String::new(),
                base_branch: None,
                created_at: 0,
                deps: false,
            };
            if orphan.branch.is_empty() {
                continue;
            }
            tracing::info!("[Agents] removing a copy no agent holds: {}", wt.path);
            abandon(orphan).await;
        }
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let canon = |p: &str| dunce::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    canon(a) == canon(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A project with one commit, its projects root beside it, and git's
    /// identity set for the commits the copy makes.
    fn project() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ShipStudio");
        let repo = root.join("acme-site");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("index.html"), "<h1>Hello</h1>\n").unwrap();
        std::fs::write(repo.join("style.css"), "h1 { color: red; }\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\n.env\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "init"]);
        (dir, root, repo)
    }

    async fn copy_of(repo: &Path, root: &Path, agent: &str, ask: &str) -> TaskCopy {
        create(repo, root, &format!("id-{agent}"), agent, ask)
            .await
            .unwrap()
            .expect("a git project gets a copy")
    }

    #[test]
    fn names_are_slugs_of_the_agent_and_the_request() {
        let (branch, folder) = names("Acme Site", "Make the pricing table blue!", "3f2a9c", false);
        assert_eq!(branch, "acme-site/make-the-pricing-table-3f2a");
        assert_eq!(folder, "acme-site-make-the-pricing-table-3f2a");
        let (branch, _) = names("Acme Site", "fix", "3f2a9c", true);
        assert_eq!(branch, "acme-site-fix-3f2a");
        let (branch, _) = names("✨", "¿?", "ab", false);
        assert_eq!(branch, "agent/task-ab");
        assert!(slug(&"word ".repeat(40), 40).len() <= 32);
    }

    #[test]
    fn finds_dependency_folders_without_looking_inside_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("node_modules/a/node_modules")).unwrap();
        std::fs::create_dir_all(root.join("packages/web/node_modules")).unwrap();
        std::fs::create_dir_all(root.join(".git/node_modules")).unwrap();
        let mut found: Vec<String> = dependency_dirs(root)
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().to_string())
            .collect();
        found.sort();
        assert_eq!(found, vec!["node_modules", "packages/web/node_modules"]);
    }

    #[test]
    fn free_space_is_read_from_the_volume() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(&dir.path().join("not/yet/made")).unwrap() > 0);
    }

    #[tokio::test]
    async fn a_copy_is_isolated_from_the_project_and_outside_it() {
        let (_dir, root, repo) = project();
        std::fs::write(repo.join(".env"), "SECRET=1\n").unwrap();
        std::fs::create_dir_all(repo.join("node_modules/lib")).unwrap();
        std::fs::write(repo.join("node_modules/lib/index.js"), "x\n").unwrap();
        // The user's own unsaved edit stays theirs.
        std::fs::write(repo.join("style.css"), "h1 { color: green; }\n").unwrap();

        let copy = copy_of(&repo, &root, "Acme Site", "Make the header blue").await;
        let path = PathBuf::from(&copy.path);
        assert!(path.starts_with(root.join(".worktrees/acme-site")));
        assert!(!path.starts_with(&repo));
        assert_eq!(copy.base_branch.as_deref(), Some("main"));
        assert!(copy.branch.starts_with("acme-site/make-the-header-blue-"));
        assert_eq!(
            std::fs::read_to_string(path.join("style.css")).unwrap(),
            "h1 { color: red; }\n",
            "the copy starts from the last commit, not the user's unsaved edit"
        );
        assert!(path.join(".env").is_file(), ".env files come along");
        assert!(path.join("node_modules/lib/index.js").is_file());
        assert!(copy.deps);
        // Locked as ours.
        let list = sh(&repo, &["worktree", "list", "--porcelain"]);
        assert!(list.contains(&format!("locked {LOCK_MARK}id-Acme Site")));

        // The agent's edit stays in the copy.
        std::fs::write(path.join("index.html"), "<h1 class=blue>Hello</h1>\n").unwrap();
        let start = super::super::project::snapshot(&repo).await.unwrap();
        assert!(commit_pending(&path, "Acme Site: update index.html")
            .await
            .unwrap());
        assert_eq!(
            std::fs::read_to_string(repo.join("index.html")).unwrap(),
            "<h1>Hello</h1>\n"
        );
        assert!(super::super::project::summary(&repo, &start)
            .await
            .is_none());
        // Nothing left to commit: no empty commit.
        assert!(!commit_pending(&path, "again").await.unwrap());
    }

    #[tokio::test]
    async fn keep_brings_the_changes_into_the_current_branch_and_cleans_up() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "blue header").await;
        let path = PathBuf::from(&copy.path);
        std::fs::write(path.join("index.html"), "<h1 class=blue>Hello</h1>\n").unwrap();
        std::fs::write(path.join("new.css"), ".blue {}\n").unwrap();
        // The user carries on in their own folder meanwhile, in another file,
        // and has an unsaved edit elsewhere.
        std::fs::write(repo.join("style.css"), "h1 { color: green; }\n").unwrap();
        sh(&repo, &["commit", "-qam", "user's own"]);
        std::fs::write(repo.join("notes.txt"), "draft\n").unwrap();

        let kept = keep_copy(&copy, "Acme Site").await.unwrap();
        assert_eq!(kept, Kept::Kept { files: 2 });
        assert_eq!(
            std::fs::read_to_string(repo.join("index.html")).unwrap(),
            "<h1 class=blue>Hello</h1>\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("style.css")).unwrap(),
            "h1 { color: green; }\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("notes.txt")).unwrap(),
            "draft\n"
        );
        assert!(!path.exists(), "the copy is gone");
        assert!(sh(&repo, &["branch", "--list", &copy.branch]).is_empty());
        assert_eq!(sh(&repo, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert!(!sh(&repo, &["worktree", "list"]).contains(".worktrees"));
    }

    #[tokio::test]
    async fn an_overlap_stops_in_the_copy_never_in_the_users_folder() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "red to blue").await;
        let path = PathBuf::from(&copy.path);
        std::fs::write(path.join("style.css"), "h1 { color: blue; }\n").unwrap();
        std::fs::write(repo.join("style.css"), "h1 { color: green; }\n").unwrap();
        sh(&repo, &["commit", "-qam", "user's own"]);
        let users_head = sh(&repo, &["rev-parse", "HEAD"]);

        let kept = keep_copy(&copy, "Acme Site").await.unwrap();
        assert_eq!(
            kept,
            Kept::Conflict {
                files: vec!["style.css".into()]
            }
        );
        // The user's folder is untouched: same commit, no merge in progress.
        assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), users_head);
        assert!(sh(&repo, &["status", "--porcelain"]).is_empty());
        assert!(path.is_dir(), "the copy stays, to be resolved");
        // A turn ending now must not commit the conflict markers.
        assert!(!commit_pending(&path, "x").await.unwrap());
        // Asked again before it's resolved: the same answer.
        assert!(matches!(
            keep_copy(&copy, "Acme Site").await.unwrap(),
            Kept::Conflict { .. }
        ));

        // Resolved in the copy (as the conflict UI or the agent would), then kept.
        std::fs::write(path.join("style.css"), "h1 { color: teal; }\n").unwrap();
        sh(&path, &["add", "style.css"]);
        let kept = keep_copy(&copy, "Acme Site").await.unwrap();
        assert!(matches!(kept, Kept::Kept { .. }), "{kept:?}");
        assert_eq!(
            std::fs::read_to_string(repo.join("style.css")).unwrap(),
            "h1 { color: teal; }\n"
        );
    }

    #[tokio::test]
    async fn unsaved_edits_to_the_same_file_are_never_overwritten() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "blue").await;
        std::fs::write(Path::new(&copy.path).join("style.css"), "blue\n").unwrap();
        std::fs::write(repo.join("style.css"), "the user's unsaved edit\n").unwrap();
        let err = keep_copy(&copy, "Acme Site").await.unwrap_err().to_string();
        assert!(
            err.contains("unsaved edits") && err.contains("style.css"),
            "{err}"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("style.css")).unwrap(),
            "the user's unsaved edit\n"
        );
        assert!(
            Path::new(&copy.path).is_dir(),
            "nothing lost: the copy stays"
        );
    }

    #[tokio::test]
    async fn discard_removes_the_copy_and_its_branch() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "experiment").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "nope\n").unwrap();
        commit_pending(Path::new(&copy.path), "x").await.unwrap();
        remove(&copy, Branch::Force).await.unwrap();
        assert!(!Path::new(&copy.path).exists());
        assert!(sh(&repo, &["branch", "--list", &copy.branch]).is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.join("index.html")).unwrap(),
            "<h1>Hello</h1>\n"
        );
    }

    #[tokio::test]
    async fn cleanup_never_deletes_a_branch_with_work_on_it() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "keep me").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "work\n").unwrap();
        commit_pending(Path::new(&copy.path), "work").await.unwrap();
        remove(&copy, Branch::IfMerged).await.unwrap();
        assert!(!Path::new(&copy.path).exists());
        assert_eq!(
            sh(&repo, &["branch", "--list", &copy.branch])
                .trim_start_matches("* ")
                .trim(),
            copy.branch
        );

        // A copy with nothing on it loses its branch too.
        let empty = copy_of(&repo, &root, "Acme Site", "nothing").await;
        remove(&empty, Branch::IfMerged).await.unwrap();
        assert!(sh(&repo, &["branch", "--list", &empty.branch]).is_empty());
    }

    #[tokio::test]
    async fn keeping_a_copy_with_nothing_new_just_removes_it() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "look around").await;
        assert_eq!(keep_copy(&copy, "Acme Site").await.unwrap(), Kept::Nothing);
        assert!(!Path::new(&copy.path).exists());
    }

    #[tokio::test]
    async fn two_agents_work_on_one_project_without_trampling() {
        let (_dir, root, repo) = project();
        let (a, b) = tokio::join!(
            copy_of(&repo, &root, "Acme Site", "header"),
            copy_of(&repo, &root, "Copywriter", "header")
        );
        assert_ne!(a.path, b.path);
        assert_ne!(a.branch, b.branch);
        // Both edit the same file, differently.
        std::fs::write(Path::new(&a.path).join("index.html"), "<h1>From A</h1>\n").unwrap();
        std::fs::write(Path::new(&b.path).join("index.html"), "<h1>From B</h1>\n").unwrap();
        std::fs::write(Path::new(&b.path).join("about.html"), "about\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&a.path).join("index.html")).unwrap(),
            "<h1>From A</h1>\n"
        );
        // The first kept wins cleanly; the second overlaps, in its own copy.
        assert!(matches!(
            keep_copy(&a, "Acme Site").await.unwrap(),
            Kept::Kept { .. }
        ));
        assert!(matches!(
            keep_copy(&b, "Copywriter").await.unwrap(),
            Kept::Conflict { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(repo.join("index.html")).unwrap(),
            "<h1>From A</h1>\n"
        );
        assert!(!repo.join("about.html").exists());
    }

    fn bound_agent(name: &str, project: &Path) -> store::Agent {
        let agent = store::create(store::NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let path = project.to_string_lossy().to_string();
        store::update(&agent.id, |a| a.project = Some(path)).unwrap()
    }

    #[tokio::test]
    async fn a_bound_agent_keeps_one_copy_across_turns_and_a_question_costs_nothing() {
        let (_dir, root, repo) = project();
        let home = tempfile::tempdir().unwrap();
        let _serial = store::tests_lock();
        store::set_root_for_tests(Some(home.path().to_path_buf()));

        let site = bound_agent("Acme Site", &repo);
        let mut said = Vec::new();
        let (copy, made) = prepare_in(&site.id, "Make the header blue", &root, |a| said.push(a))
            .await
            .unwrap()
            .unwrap();
        assert!(made);
        assert_eq!(said, vec!["Making a copy of acme-site".to_string()]);
        let agent = store::get(&site.id).unwrap();
        assert_eq!(agent.copy.as_ref(), Some(&copy));
        let layout = super::super::project::layout(&agent, home.path(), Vec::new());
        assert_eq!(layout.cwd, PathBuf::from(&copy.path));
        assert_eq!(layout.project, Some(repo.clone()));

        // A turn edits the copy: its card covers the copy and names the project.
        let from = super::super::project::snapshot(Path::new(&copy.path))
            .await
            .unwrap();
        std::fs::write(Path::new(&copy.path).join("index.html"), "<h1>Blue</h1>\n").unwrap();
        let card = record_turn(&site.id, &copy, &from).await.unwrap();
        assert_eq!(card.project, repo.to_string_lossy());
        assert_eq!(card.copy, Some(CopyRef::from(&copy)));
        assert_eq!(card.file_count, 1);
        assert!(!dropped_if_unused(&site.id, &copy).await, "it has changes");

        // The next turn reuses it, and its card is cumulative.
        let (again, made) = prepare_in(&site.id, "smaller", &root, |_| {})
            .await
            .unwrap()
            .unwrap();
        assert!(!made);
        assert_eq!(again.id, copy.id);
        let from = super::super::project::snapshot(Path::new(&copy.path))
            .await
            .unwrap();
        assert!(
            record_turn(&site.id, &copy, &from).await.is_none(),
            "nothing changed this turn"
        );
        std::fs::write(Path::new(&copy.path).join("about.html"), "about\n").unwrap();
        assert_eq!(
            record_turn(&site.id, &copy, &from)
                .await
                .unwrap()
                .file_count,
            2
        );
        // The user's folder never saw any of it.
        assert_eq!(
            std::fs::read_to_string(repo.join("index.html")).unwrap(),
            "<h1>Hello</h1>\n"
        );

        // Another agent asks a question: its copy is made, then dropped.
        let other = bound_agent("Copywriter", &repo);
        let (asked, _) = prepare_in(&other.id, "what's on the page?", &root, |_| {})
            .await
            .unwrap()
            .unwrap();
        assert!(dropped_if_unused(&other.id, &asked).await);
        assert!(!Path::new(&asked.path).exists());
        assert!(store::get(&other.id).unwrap().copy.is_none());

        // Working directly: no copy, as before.
        store::update(&other.id, |a| a.work_directly = true).unwrap();
        assert!(prepare_in(&other.id, "x", &root, |_| {})
            .await
            .unwrap()
            .is_none());
        let direct = store::get(&other.id).unwrap();
        assert_eq!(
            super::super::project::layout(&direct, home.path(), Vec::new()).cwd,
            repo
        );
        // An unbound agent: none either.
        store::update(&other.id, |a| {
            a.work_directly = false;
            a.project = None;
        })
        .unwrap();
        assert!(prepare_in(&other.id, "x", &root, |_| {})
            .await
            .unwrap()
            .is_none());

        store::set_root_for_tests(None);
    }

    #[tokio::test]
    async fn copies_per_project_are_limited_and_the_refusal_says_what_to_do() {
        let (_dir, root, repo) = project();
        let home = tempfile::tempdir().unwrap();
        let _serial = store::tests_lock();
        store::set_root_for_tests(Some(home.path().to_path_buf()));
        for n in 0..MAX_COPIES_PER_PROJECT {
            let a = bound_agent(&format!("Agent {n}"), &repo);
            prepare_in(&a.id, "work", &root, |_| {})
                .await
                .unwrap()
                .unwrap();
        }
        let late = bound_agent("Late", &repo);
        let err = prepare_in(&late.id, "work", &root, |_| {})
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("4 agents already have a copy of acme-site open"),
            "{err}"
        );
        assert!(store::get(&late.id).unwrap().copy.is_none());
        store::set_root_for_tests(None);
    }

    #[tokio::test]
    async fn projects_without_git_or_without_a_commit_get_no_copy() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(create(&plain, dir.path(), "a", "A", "x")
            .await
            .unwrap()
            .is_none());
        let fresh = dir.path().join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        sh(&fresh, &["init", "-q"]);
        assert!(create(&fresh, dir.path(), "a", "A", "x")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_plain_branch_named_after_the_agent_doesnt_block_its_copies() {
        let (_dir, root, repo) = project();
        sh(&repo, &["branch", "acme-site"]);
        let copy = copy_of(&repo, &root, "Acme Site", "x").await;
        assert!(copy.branch.starts_with("acme-site-x-"));
    }
}
