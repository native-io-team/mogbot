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
//!   leave it alone, and the workspace's force remove asks first, naming the
//!   agent.
//! - **Branch**: `<agent-slug>/<task-slug>-<id>`, from the agent's name and
//!   the first words of the request. Everything that commits, keeps or
//!   tidies up checks the copy is still on that branch first, and touches
//!   nothing when it isn't (an agent that ran `git checkout` would otherwise
//!   have its work committed onto the user's own branch).
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
//!   user's commits; the project's checks still run on a pull request), with
//!   the `Made-With` trailer when attribution is on. Never staged: Ship
//!   Studio's own `.shipstudio/`, `node_modules`, `.env*` files, files over
//!   [`MAX_COMMIT_BYTES`], and files whose new lines look like a credential.
//!   They stay in the copy, and the card lists them as not included. Nothing
//!   is committed while a file still has conflict markers in it.
//! - **Keep**: only into the branch the copy was made from, unless the user
//!   confirms another one by name. The project's branch is merged into the
//!   copy first, so any conflict happens in the copy, never in the user's
//!   folder; then the project fast-forwards to it. A conflict is left in the
//!   copy for the workspace's conflict UI (or the agent) to resolve.
//! - **Cleanup** (an agent deleted, a copy no agent holds at launch) commits
//!   what's left first, and keeps the copy when anything still couldn't be
//!   saved: only Discard throws work away.
//!
//! Projects that aren't git repositories (or have no commit yet), and agents
//! set to work directly in the project, run in the project as before.
//!
//! Codex: its sandbox keeps every `.git` folder read-only, writable roots or
//! not (checked with `codex sandbox -P :workspace` on Codex 0.166: a commit in
//! a copy fails on `<project>/.git/worktrees/<copy>/index.lock`, and adding
//! the project's `.git` to `writable_roots` doesn't change that). So a Codex
//! agent can't commit in its copy itself; it doesn't need to, since the turn's
//! end commits for it, and the prompt says so.

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
/// Files bigger than this are never committed for the agent.
pub const MAX_COMMIT_BYTES: u64 = 5 * 1024 * 1024;

/// What every refusal says when the copy has been moved off its own branch.
pub const OFF_BRANCH: &str = "The copy isn't on its own branch any more — open it to check.";
/// …and when its latest work isn't on any branch at all.
pub const OFF_BRANCH_LOST: &str = "The copy isn't on its own branch any more, and its latest work isn't on any branch — open it to check. It was kept, so nothing is lost.";

const GIT_TIMEOUT_SECS: u64 = 60;
/// Checking out a big project (or its LFS files) can take minutes.
const WORKTREE_ADD_TIMEOUT_SECS: u64 = 300;
/// Cloning dependencies: thousands of files, still bounded.
const CLONE_TIMEOUT_SECS: u64 = 180;
/// The message of what cleanup commits before it removes a copy.
const LEFT_IN_COPY: &str = "Work left in the copy";

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
    /// The last Keep that couldn't go through (`conflict`, `markers` or
    /// `otherBranch`), so every card (the Mac's, the phone's) shows what's in
    /// the way however often it re-renders. Cleared by the next turn or Keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stuck: Option<Kept>,
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

/// Why a file changed in the copy isn't in what Keep brings over.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LeftOutWhy {
    /// A `.env*` file, or new lines shaped like a credential.
    Secrets,
    /// `node_modules`.
    Dependencies,
    /// Over [`MAX_COMMIT_BYTES`].
    TooLarge,
    /// git ignores it (a `.env` the agent edited): it never leaves the copy.
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeftOut {
    pub path: String,
    pub why: LeftOutWhy,
}

/// The card's line for what isn't included, or `None` when everything is.
/// `"Not included: .env.local (looks like secrets) · changed .env — not included (git ignores it)"`.
pub fn left_out_line(items: &[LeftOut]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let skipped: Vec<String> = items
        .iter()
        .filter(|l| l.why != LeftOutWhy::Ignored)
        .take(5)
        .map(|l| {
            let why = match l.why {
                LeftOutWhy::Secrets => "looks like secrets",
                LeftOutWhy::Dependencies => "dependencies",
                LeftOutWhy::TooLarge => "over 5 MB",
                LeftOutWhy::Ignored => unreachable!(),
            };
            format!("{} ({why})", l.path)
        })
        .collect();
    if !skipped.is_empty() {
        parts.push(format!("Not included: {}", skipped.join(", ")));
    }
    let ignored: Vec<&str> = items
        .iter()
        .filter(|l| l.why == LeftOutWhy::Ignored)
        .take(5)
        .map(|l| l.path.as_str())
        .collect();
    if !ignored.is_empty() {
        parts.push(format!(
            "changed {} — not included (git ignores it)",
            ignored.join(", ")
        ));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// What "Keep changes" did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Kept {
    /// In the project's `branch` now; the copy is gone.
    #[serde(rename_all = "camelCase")]
    Kept {
        files: u32,
        branch: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        left_out: Vec<LeftOut>,
    },
    /// The copy had nothing the project doesn't; it is gone.
    #[serde(rename_all = "camelCase")]
    Nothing {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        left_out: Vec<LeftOut>,
    },
    /// Some changes overlap with edits made in the project since; the copy
    /// is mid-merge, with these files to choose in.
    Conflict { files: Vec<String> },
    /// These files still have conflict markers in them: nothing was kept.
    Markers { files: Vec<String> },
    /// The project is on `current`, not the branch the copy was made from
    /// (`base`; `None` when it was made from no branch). Nothing was kept:
    /// keeping into `current` needs the user to confirm it by name.
    #[serde(rename_all = "camelCase")]
    OtherBranch {
        current: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
}

/* ---------------------------------------------------------------- git */

async fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output, CommandError> {
    git_for(dir, args, GIT_TIMEOUT_SECS).await
}

async fn git_for(
    dir: &Path,
    args: &[&str],
    secs: u64,
) -> Result<std::process::Output, CommandError> {
    let mut cmd = crate::utils::git_command_in(dir)?;
    cmd.env("GIT_OPTIONAL_LOCKS", "0").args(args);
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "git (agent copy)",
        secs,
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

fn process_error(args: &[&str], out: &std::process::Output) -> CommandError {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    CommandError::Process {
        cmd: format!("git {}", args.join(" ")),
        exit_code: out.status.code().unwrap_or(-1),
        stderr: if stderr.is_empty() { stdout } else { stderr },
    }
}

async fn run(dir: &Path, args: &[&str]) -> Result<String, CommandError> {
    let out = git(dir, args).await?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    Err(process_error(args, &out))
}

fn lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The first line git said, for a sentence that quotes it.
fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_start_matches("fatal: ")
        .trim_start_matches("error: ")
        .to_string()
}

/// Files git still lists as unmerged.
async fn unmerged(dir: &Path) -> Vec<String> {
    read(dir, &["diff", "--name-only", "--diff-filter=U"])
        .await
        .map(|s| lines(&s))
        .unwrap_or_default()
}

/// Whether the copy's HEAD is still its own branch.
async fn on_own_branch(dir: &Path, branch: &str) -> bool {
    read(dir, &["symbolic-ref", "-q", "HEAD"])
        .await
        .is_some_and(|head| head == format!("refs/heads/{branch}"))
}

/// HEAD is detached at a commit no branch, tag or remote holds: removing the
/// folder would leave that work reachable only from a reflog that goes too.
async fn head_unreachable(dir: &Path) -> bool {
    if read(dir, &["symbolic-ref", "-q", "HEAD"]).await.is_some() {
        return false;
    }
    let Some(head) = read(dir, &["rev-parse", "-q", "--verify", "HEAD"]).await else {
        return false;
    };
    read(
        dir,
        &[
            "for-each-ref",
            "--count=1",
            "--contains",
            &head,
            "refs/heads",
            "refs/tags",
            "refs/remotes",
        ],
    )
    .await
    .is_none_or(|s| s.is_empty())
}

/// What the project is in the middle of, in words, if anything.
async fn in_progress(dir: &Path) -> Option<&'static str> {
    for (file, what) in [
        ("MERGE_HEAD", "a merge"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
    ] {
        let Some(path) = read(dir, &["rev-parse", "--git-path", file]).await else {
            continue;
        };
        let path = PathBuf::from(path);
        let path = if path.is_absolute() {
            path
        } else {
            dir.join(path)
        };
        if path.exists() {
            return Some(what);
        }
    }
    None
}

/* ------------------------------------------------------- what's committed */

/// Part of `node_modules`.
fn is_dependency(path: &str) -> bool {
    path.trim_end_matches('/')
        .split('/')
        .any(|part| part == "node_modules")
}

/// A `.env*` file (or folder), except the examples people commit on purpose.
pub(crate) fn is_env_file(path: &str) -> bool {
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path);
    name.starts_with(".env")
        && ![".example", ".sample", ".template"]
            .iter()
            .any(|s| name.ends_with(s))
}

/// A conflict marker line: `<<<<<<< ours` or `>>>>>>> theirs`. A bare
/// `=======` alone isn't counted: it underlines Markdown headings, and the
/// two markers around it are what a half-finished merge always leaves.
fn is_marker(line: &str) -> bool {
    ["<<<<<<<", ">>>>>>>"].iter().any(|m| {
        line.strip_prefix(m)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
    })
}

/// `NAME=value` with a secret-sounding uppercase name and a literal,
/// token-shaped value (not a reference like `process.env.X` or `$X`).
fn secret_assignment(line: &str) -> bool {
    let Some((name, value)) = line.split_once('=') else {
        return false;
    };
    let name = name.split_whitespace().last().unwrap_or("");
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        || !["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD"]
            .iter()
            .any(|w| name.contains(w))
    {
        return false;
    }
    let value = value
        .trim()
        .trim_end_matches([';', ','])
        .trim()
        .trim_matches(['"', '\'', '`']);
    value.len() >= 12
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_+/=".contains(c))
        && value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic())
}

/// A line that looks like it holds a credential: a value saved in the
/// Keychain, a token with a known prefix (the timeline scrubber's list), a
/// private key, or a secret-named variable set to a literal.
fn looks_like_secret(line: &str) -> bool {
    if line.contains("PRIVATE KEY-----") {
        return true;
    }
    if matches!(super::secrets::redact(line), std::borrow::Cow::Owned(_)) {
        return true;
    }
    let token = line
        .split(|c: char| c.is_whitespace() || "\"'`=:,;()[]{}<>".contains(c))
        .any(|word| {
            word.len() >= 20
                && super::work::SECRET_PREFIXES
                    .iter()
                    .any(|p| word.starts_with(p))
                && word
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
        });
    token || secret_assignment(line)
}

/// Files whose added lines (in a `git diff -U0`) pass `test`, in diff order.
fn files_where(diff: &str, test: impl Fn(&str) -> bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut path: Option<String> = None;
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            path = None;
            in_hunk = false;
            continue;
        }
        if !in_hunk {
            if let Some(p) = line.strip_prefix("+++ ") {
                let p = p.trim_end_matches('\t').trim_matches('"');
                path = (p != "/dev/null").then(|| p.strip_prefix("b/").unwrap_or(p).to_string());
            } else if line.starts_with("@@") {
                in_hunk = true;
            }
            continue;
        }
        if line.starts_with("@@") {
            continue;
        }
        if let (Some(added), Some(p)) = (line.strip_prefix('+'), &path) {
            if !out.contains(p) && test(added) {
                out.push(p.clone());
            }
        }
    }
    out
}

/// The `-U0` diff git would show for `args`, paths unquoted.
async fn added_diff(dir: &Path, args: &[&str]) -> String {
    let mut all = vec![
        "-c",
        "core.quotePath=false",
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
    ];
    all.extend_from_slice(args);
    read(dir, &all).await.unwrap_or_default()
}

/// What a commit of the copy's pending work found.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Saved {
    /// A commit was made.
    pub committed: bool,
    /// Files still unmerged: nothing was committed.
    pub conflicts: Vec<String>,
    /// Files with conflict markers in them: nothing was committed.
    pub markers: Vec<String>,
}

impl Saved {
    fn blocked(&self) -> bool {
        !self.conflicts.is_empty() || !self.markers.is_empty()
    }
}

/// Commit what's uncommitted in the copy, on its own `branch` only (refused,
/// touching nothing, when HEAD is anywhere else). Nothing while conflicts
/// are unresolved or a file has conflict markers: staging would record them
/// as the answer. `.shipstudio/`, dependencies, `.env*`, big files and
/// credential-shaped lines are never staged (see [`left_out`]). `made_with`
/// is the agent's engine, for the `Made-With` trailer when attribution is on.
pub async fn commit_pending(
    dir: &Path,
    branch: &str,
    message: &str,
    made_with: Option<&str>,
) -> Result<Saved, CommandError> {
    if !on_own_branch(dir, branch).await {
        return Err(CommandError::expected(OFF_BRANCH));
    }
    let conflicts = unmerged(dir).await;
    if !conflicts.is_empty() {
        return Ok(Saved {
            conflicts,
            ..Saved::default()
        });
    }
    let owned = dir.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        crate::commands::git::ensure_shipstudio_excluded(&owned)
    })
    .await;
    run(
        dir,
        &[
            "add",
            "-A",
            "--",
            ".",
            ":(exclude,glob)**/node_modules",
            ":(exclude,glob)**/node_modules/**",
        ],
    )
    .await?;
    // `.shipstudio/` stays out by git's own exclude (untracked) or
    // skip-worktree (tracked; see `copy_local_files`): naming it here would
    // make `git add` fail on an ignored path. What else mustn't be committed
    // goes back out of the index (a path-limited
    // reset, so a merge in progress stays in progress).
    let staged = read(
        dir,
        &[
            "-c",
            "core.quotePath=false",
            "diff",
            "--cached",
            "--name-only",
            "--no-renames",
            "--diff-filter=AM",
        ],
    )
    .await
    .map(|s| lines(&s))
    .unwrap_or_default();
    let diff = added_diff(dir, &["--cached"]).await;
    let mut unstage: Vec<String> = staged
        .iter()
        .filter(|p| {
            is_env_file(p)
                || std::fs::metadata(dir.join(p)).is_ok_and(|m| m.len() > MAX_COMMIT_BYTES)
        })
        .cloned()
        .collect();
    for p in files_where(&diff, looks_like_secret) {
        if !unstage.contains(&p) {
            unstage.push(p);
        }
    }
    if !unstage.is_empty() {
        let mut args = vec!["reset", "-q", "--"];
        args.extend(unstage.iter().map(String::as_str));
        run(dir, &args).await?;
    }
    let markers: Vec<String> = files_where(&diff, is_marker)
        .into_iter()
        .filter(|p| !unstage.contains(p))
        .collect();
    if !markers.is_empty() {
        return Ok(Saved {
            markers,
            ..Saved::default()
        });
    }
    let nothing = git(dir, &["diff", "--cached", "--quiet"]).await?;
    let merging = read(dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .await
        .is_some();
    if nothing.status.success() && !merging {
        return Ok(Saved::default());
    }
    // `git interpret-trailers`: local and instant, so it runs right here.
    let message = crate::commands::team::with_trailers(dir, message, made_with);
    run(dir, &["commit", "--no-verify", "-q", "-m", &message]).await?;
    Ok(Saved {
        committed: true,
        ..Saved::default()
    })
}

/// What's in the copy that a commit leaves out: whatever `git status` still
/// lists after [`commit_pending`] (each for the reason it was left out), and
/// root `.env*` files git ignores that differ from the project's own.
pub async fn left_out(copy: &TaskCopy) -> Vec<LeftOut> {
    let dir = Path::new(&copy.path);
    let mut out: Vec<LeftOut> = Vec::new();
    // Dependencies by folder (listing their files would be thousands), the
    // rest file by file.
    for deps in dependency_dirs(dir) {
        let Ok(rel) = deps.strip_prefix(dir) else {
            continue;
        };
        if !ignored(dir, rel).await {
            out.push(LeftOut {
                path: rel.to_string_lossy().to_string(),
                why: LeftOutWhy::Dependencies,
            });
        }
    }
    let status = read(
        dir,
        &[
            "-c",
            "core.quotePath=false",
            "status",
            "--porcelain",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--",
            ".",
            ":(exclude,glob)**/node_modules",
            ":(exclude,glob)**/node_modules/**",
        ],
    )
    .await
    .unwrap_or_default();
    for entry in status.split('\0') {
        let Some(path) = porcelain_path(entry) else {
            continue;
        };
        if path == ".shipstudio" || path.starts_with(".shipstudio/") {
            continue;
        }
        let why = if is_dependency(path) {
            // A tracked file under `node_modules`, edited: never staged either.
            LeftOutWhy::Dependencies
        } else if is_env_file(path) {
            LeftOutWhy::Secrets
        } else if std::fs::metadata(dir.join(path)).is_ok_and(|m| m.len() > MAX_COMMIT_BYTES) {
            LeftOutWhy::TooLarge
        } else {
            LeftOutWhy::Secrets
        };
        out.push(LeftOut {
            path: path.trim_end_matches('/').to_string(),
            why,
        });
    }
    let project = Path::new(&copy.project);
    let envs: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_file())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with(".env"))
                .collect()
        })
        .unwrap_or_default();
    for name in envs {
        if out.iter().any(|l| l.path == name) || !ignored(dir, Path::new(&name)).await {
            continue;
        }
        if std::fs::read(dir.join(&name)).ok() != std::fs::read(project.join(&name)).ok() {
            out.push(LeftOut {
                path: name,
                why: LeftOutWhy::Ignored,
            });
        }
    }
    out
}

/// Conflict markers added by the copy's branch since `target`: what a fast-
/// forward would bring into the project.
async fn markers_since(dir: &Path, target: &str, branch: &str) -> Vec<String> {
    let range = format!("{target}...{branch}");
    files_where(&added_diff(dir, &[&range]).await, is_marker)
}

/// The path in one `git status --porcelain -z` entry ("XY path"). Never cut
/// inside a character: an entry that isn't that shape is skipped.
fn porcelain_path(entry: &str) -> Option<&str> {
    entry.get(3..).filter(|p| !p.is_empty())
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
/// settings, when git ignores them. A tracked `.shipstudio/project.json` is
/// marked skip-worktree in the copy, so its new port never shows up as a
/// change for Keep to carry into the project.
async fn copy_local_files(anchor: &Path, dest: &Path) {
    let (a, d) = (anchor.to_path_buf(), dest.to_path_buf());
    let _ = tokio::task::spawn_blocking(move || {
        crate::commands::git::ensure_shipstudio_excluded(&d);
        crate::commands::git::seed_worktree(&a, &d, false);
    })
    .await;
    let seeded = ".shipstudio/project.json";
    if read(dest, &["ls-files", "--error-unmatch", "--", seeded])
        .await
        .is_some()
    {
        let _ = git(dest, &["update-index", "--skip-worktree", "--", seeded]).await;
    }
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
    let args = [
        "worktree", "add", "--lock", "--reason", &reason, "-b", &branch, &dest_str, &base,
    ];
    let added = git_for(project, &args, WORKTREE_ADD_TIMEOUT_SECS).await;
    let failed = match &added {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(process_error(&args, out)),
        Err(e) => Some(e.clone()),
    };
    if let Some(e) = failed {
        // A checkout cut short leaves a half-made copy behind: nothing in it
        // is anyone's work yet (the branch is new), so it goes again.
        let _ = git(
            project,
            &["worktree", "remove", "--force", "--force", &dest_str],
        )
        .await;
        let _ = std::fs::remove_dir_all(&dest);
        let _ = git(project, &["worktree", "prune"]).await;
        let _ = git(project, &["branch", "-D", &branch]).await;
        return Err(e);
    }
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
        stuck: None,
    }))
}

/* -------------------------------------------------------------- commit */

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

/// How a copy is removed, and what happens to its branch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Branch {
    /// Discard: the folder and the branch, whatever is in them (but never a
    /// detached HEAD whose commits nothing else holds).
    Force,
    /// After Keep: the work is in the project; the branch goes if merged.
    Kept,
    /// Cleanup that must never lose work: what's pending is committed first,
    /// the copy is kept when anything still couldn't be, and the branch goes
    /// only when it holds nothing the project lacks.
    IfMerged,
}

pub async fn remove(copy: &TaskCopy, branch: Branch) -> Result<(), CommandError> {
    let project = Path::new(&copy.project);
    let dir = Path::new(&copy.path);
    let anchor = if project.is_dir() {
        project.to_path_buf()
    } else {
        dir.to_path_buf()
    };
    if dir.is_dir() {
        if !on_own_branch(dir, &copy.branch).await {
            if head_unreachable(dir).await {
                return Err(CommandError::expected(OFF_BRANCH_LOST));
            }
            if branch != Branch::Force {
                return Err(CommandError::expected(OFF_BRANCH));
            }
        } else if branch == Branch::IfMerged {
            let saved = commit_pending(dir, &copy.branch, LEFT_IN_COPY, None).await?;
            if saved.blocked() {
                return Err(CommandError::expected(
                    "The copy is in the middle of choosing between changes, so it was kept.",
                ));
            }
            let unsaved: Vec<String> = left_out(copy)
                .await
                .into_iter()
                .filter(|l| l.why != LeftOutWhy::Dependencies)
                .map(|l| l.path)
                .collect();
            if !unsaved.is_empty() {
                return Err(CommandError::expected(format!(
                    "The copy has changes that can't be saved on its branch ({}), so it was kept.",
                    unsaved.join(", ")
                )));
            }
        }
        // Everything worth keeping is on a branch by now (or Discard said to
        // throw it away): twice, because the copy is locked.
        let removed = git(
            &anchor,
            &["worktree", "remove", "--force", "--force", &copy.path],
        )
        .await;
        if !removed.as_ref().is_ok_and(|o| o.status.success()) {
            tracing::info!("[Agents] git couldn't remove a copy: {removed:?}");
            if branch != Branch::Force {
                return Err(CommandError::expected(
                    "The copy couldn't be removed, so it was kept.",
                ));
            }
            // Discard of a folder git no longer knows: remove it ourselves.
            let _ = std::fs::remove_dir_all(&copy.path);
        }
    }
    let _ = git(&anchor, &["worktree", "prune"]).await;
    let flag = match branch {
        Branch::Force => "-D",
        Branch::Kept | Branch::IfMerged => "-d",
    };
    if project.is_dir() {
        let _ = git(project, &["branch", flag, &copy.branch]).await;
    }
    crate::cache::GIT_CACHE.invalidate(&copy.project);
    Ok(())
}

/// Merge the copy into the project's current branch: the branch it was made
/// from, or `into` when the user confirmed another one by name.
pub async fn keep_copy(
    copy: &TaskCopy,
    agent_name: &str,
    made_with: Option<&str>,
    into: Option<&str>,
) -> Result<Kept, CommandError> {
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
    if !on_own_branch(dir, &copy.branch).await {
        return Err(CommandError::expected(OFF_BRANCH));
    }
    if let Some(what) = in_progress(project).await {
        return Err(CommandError::expected(format!(
            "{name} is in the middle of {what}. Finish it or call it off in {name}, then Keep again."
        )));
    }
    let message = commit_message(dir, agent_name).await;
    let saved = commit_pending(dir, &copy.branch, &message, made_with).await?;
    if !saved.conflicts.is_empty() {
        return Ok(Kept::Conflict {
            files: saved.conflicts,
        });
    }
    if !saved.markers.is_empty() {
        return Ok(Kept::Markers {
            files: saved.markers,
        });
    }
    let Some(target) = read(project, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .filter(|b| !b.is_empty())
    else {
        return Err(CommandError::expected(format!(
            "{name} isn't on a branch right now (it's looking at an older version), so there's nowhere to put these changes. Switch {name} back to a branch, then Keep again."
        )));
    };
    let left_out = left_out(copy).await;
    let ahead = read(
        project,
        &["rev-list", "--count", &format!("{target}..{}", copy.branch)],
    )
    .await
    .and_then(|n| n.parse::<u32>().ok())
    .unwrap_or(0);
    if ahead == 0 {
        remove(copy, Branch::Force).await?;
        return Ok(Kept::Nothing { left_out });
    }
    // Made from another branch: merging this one in would carry everything
    // on the copy's branch since they parted into it. Only when asked by name.
    if copy.base_branch.as_deref() != Some(target.as_str()) && into != Some(target.as_str()) {
        return Ok(Kept::OtherBranch {
            current: target,
            base: copy.base_branch.clone(),
        });
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
        return Err(CommandError::expected(format!(
            "The latest {target} couldn't be brought into the copy ({}). Nothing in {name} changed.",
            first_line(&merged.stderr)
        )));
    }
    let markers = markers_since(dir, &target, &copy.branch).await;
    if !markers.is_empty() {
        return Ok(Kept::Markers { files: markers });
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
        if !touched.is_empty() && stderr.contains("untracked working tree files") {
            return Err(CommandError::expected(format!(
                "{name} has files of its own, not yet saved in git, where these changes add files ({}). Move or rename them in {name}, then Keep again.",
                touched.join(", ")
            )));
        }
        if !touched.is_empty() {
            return Err(CommandError::expected(format!(
                "{name} has unsaved edits to files these changes touch ({}). Save or undo them in {name}, then Keep again.",
                touched.join(", ")
            )));
        }
        return Err(CommandError::expected(format!(
            "{name} couldn't take these changes ({}). Nothing in {name} changed.",
            first_line(&ff.stderr)
        )));
    }
    crate::cache::GIT_CACHE.invalidate(&copy.project);
    if let Err(e) = remove(copy, Branch::Kept).await {
        // The changes are in; a copy left behind is tidied by the next sweep.
        tracing::warn!("[Agents] kept a copy but couldn't remove it: {e}");
    }
    Ok(Kept::Kept {
        files,
        branch: target,
        left_out,
    })
}

/* ------------------------------------------------------ the agent side */

/// One lock per repository: making, keeping and discarding copies of the
/// same repository happen one at a time, whichever of its folders (the main
/// checkout or one of its worktrees) an agent is bound to.
static LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The repository `project` belongs to: its common git dir, canonical.
async fn repo_key(project: &str) -> String {
    let dir = Path::new(project);
    let canon = |p: &Path| {
        dunce::canonicalize(p)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string_lossy().to_string())
    };
    match read(dir, &["rev-parse", "--git-common-dir"]).await {
        Some(common) if !common.is_empty() => {
            let common = PathBuf::from(common);
            canon(&if common.is_absolute() {
                common
            } else {
                dir.join(common)
            })
        }
        _ => canon(dir),
    }
}

async fn lock(project: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let key = repo_key(project).await;
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

/// Changing an agent's project while it has a copy open would strand that
/// copy's work: the user keeps or discards it first.
pub fn refuse_rebind(agent: &store::Agent, project: Option<&str>) -> Result<(), CommandError> {
    let Some(copy) = &agent.copy else {
        return Ok(());
    };
    if project == agent.project.as_deref() {
        return Ok(());
    }
    Err(CommandError::expected(format!(
        "{} has a copy of {} open with changes that haven't been kept. Keep or discard them first, then change its project.",
        agent.name,
        super::project::folder_name(&copy.project)
    )))
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
        let there = Path::new(&copy.path).is_dir();
        if copy.project == project && there {
            return Ok(Some((copy, false)));
        }
        if there {
            // Bound elsewhere since, with the old copy still open: never
            // lose or strand its work over it. The card can still keep it.
            return Err(CommandError::expected(format!(
                "{} still has a copy of {} open with changes that haven't been kept. Keep or discard them, then send this again.",
                agent.name,
                super::project::folder_name(&copy.project)
            )));
        }
        // The folder went: its branch stays when it has work on it.
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
/// for everything in the copy so far (what Keep would bring over), with what
/// isn't included and anything that stopped the commit.
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
    let agent = store::get(agent_id).ok();
    let name = agent.as_ref().map(|a| a.name.clone()).unwrap_or_default();
    let label = agent.as_ref().map(|a| a.engine.label());
    let message = commit_message(dir, &name).await;
    let mut warning = None;
    let clean = match commit_pending(dir, &copy.branch, &message, label).await {
        Ok(saved) if !saved.markers.is_empty() => {
            warning = Some(markers_line(&saved.markers));
            false
        }
        Ok(saved) => saved.conflicts.is_empty(),
        Err(e) => {
            tracing::warn!("[Agents] couldn't commit in {agent_id}'s copy: {e}");
            if !on_own_branch(dir, &copy.branch).await {
                warning = Some(OFF_BRANCH.to_string());
            }
            false
        }
    };
    let base = base_tree(copy).await?;
    // Committed cleanly: the card is the branch, which is what Keep brings.
    let committed = match clean {
        true => match read(dir, &["rev-parse", "HEAD^{tree}"]).await {
            Some(to) => super::project::summary_to(dir, &base, &to).await,
            None => None,
        },
        false => None,
    };
    let mut summary = match committed {
        Some(s) => s,
        None => super::project::summary(dir, &base).await?,
    };
    summary.project = copy.project.clone();
    summary.copy = Some(CopyRef::from(copy));
    if clean {
        summary.left_out = left_out(copy).await;
    }
    summary.warning = warning;
    // The turn may have sorted out what stopped the last Keep: ask again.
    let _ = store::update(agent_id, |a| {
        if let Some(c) = a.copy.as_mut().filter(|c| c.id == copy.id) {
            c.stuck = None;
        }
    });
    Some(summary)
}

/// The sentence for files that still have conflict markers in them.
pub fn markers_line(files: &[String]) -> String {
    format!(
        "Some files still have conflict markers in them ({}), so nothing was saved. Finish choosing in the copy first.",
        files.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
    )
}

/// A copy this turn made and left exactly as it started goes again.
pub async fn drop_if_unused(app: &AppHandle, agent_id: &str, copy: &TaskCopy) {
    if dropped_if_unused(agent_id, copy).await {
        let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    }
}

async fn dropped_if_unused(agent_id: &str, copy: &TaskCopy) -> bool {
    let dir = Path::new(&copy.path);
    if !on_own_branch(dir, &copy.branch).await {
        return false;
    }
    let (Some(now), Some(base)) = (super::project::snapshot(dir).await, base_tree(copy).await)
    else {
        return false;
    };
    let head = read(dir, &["rev-parse", "HEAD"]).await;
    if now != base || head.as_deref() != Some(copy.base.as_str()) {
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

/// Keep and Discard wait while the agent works. Asked again under the
/// project lock: a turn claims the agent (`in_turn`) before it prepares its
/// copy, so a Keep that got the lock first finishes before the turn reads
/// the copy, and one that got it second sees the turn and stops.
fn refuse_while_working(agent: &store::Agent) -> Result<(), CommandError> {
    if super::runner::in_turn(&agent.id) {
        return Err(CommandError::expected(format!(
            "{} is still working on it. Try again when it's finished.",
            agent.name
        )));
    }
    // A take-over's terminal runs in the copy: it can't go from under it.
    if super::runner::driven(&agent.id) {
        return Err(CommandError::expected(format!(
            "You're driving {} in a terminal, in this copy. Hand it back first.",
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

/// The chat's note for what Keep did, or `None` when nothing happened.
pub fn kept_note(kept: &Kept, project: &str, agent_name: &str) -> Option<String> {
    let with = |line: String, left: &[LeftOut]| match left_out_line(left) {
        Some(more) => format!("{line} · {more}"),
        None => line,
    };
    match kept {
        Kept::Kept {
            files,
            branch,
            left_out,
        } => {
            let what = match files {
                1 => "1 file".to_string(),
                n => format!("{n} files"),
            };
            Some(with(
                format!("Kept the changes in {project} ({branch}) · {what}"),
                left_out,
            ))
        }
        Kept::Nothing { left_out } => Some(with(
            format!("Nothing to keep: {project} already has these changes"),
            left_out,
        )),
        Kept::Conflict { .. } => Some(format!(
            "Some of these changes overlap with edits made in {project} since. Open the copy to choose which to keep, or ask {agent_name} to sort it out."
        )),
        Kept::Markers { files } => Some(markers_line(files)),
        Kept::OtherBranch { .. } => None,
    }
}

/// "Keep changes": into the branch the copy was made from, or `into` when
/// the user confirmed the project's current branch by name.
pub async fn keep(
    app: &AppHandle,
    agent_id: &str,
    copy_id: Option<&str>,
    into: Option<&str>,
) -> Result<Kept, CommandError> {
    let agent = store::get(agent_id)?;
    refuse_while_working(&agent)?;
    let copy = open_copy(&agent, copy_id)?;
    let _guard = lock(&copy.project).await;
    let agent = store::get(agent_id)?;
    refuse_while_working(&agent)?;
    let copy = open_copy(&agent, copy_id)?;
    let name = super::project::folder_name(&copy.project).to_string();
    let kept = keep_copy(&copy, &agent.name, Some(agent.engine.label()), into).await?;
    if let Some(text) = kept_note(&kept, &name, &agent.name) {
        note(app, agent_id, text);
    }
    let stuck = match &kept {
        Kept::Kept { .. } | Kept::Nothing { .. } => None,
        blocked => Some(blocked.clone()),
    };
    store::update(agent_id, |a| match &stuck {
        None => a.copy = None,
        Some(_) => {
            if let Some(c) = a.copy.as_mut().filter(|c| c.id == copy.id) {
                c.stuck = stuck.clone();
            }
        }
    })?;
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
    let agent = store::get(agent_id)?;
    refuse_while_working(&agent)?;
    let copy = open_copy(&agent, copy_id)?;
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

/// The agent is being deleted (or holds the copy no more): what's pending
/// is committed, then the folder goes, unless something couldn't be saved;
/// the branch goes only if the project already has everything on it.
pub async fn abandon(copy: TaskCopy) {
    let _guard = lock(&copy.project).await;
    if let Err(e) = remove(&copy, Branch::IfMerged).await {
        tracing::warn!("[Agents] kept a copy no agent holds ({}): {e}", copy.path);
    }
}

/// The agent holding the copy at `path`, if one does: `(id, name, project)`.
pub fn holder_of(path: &str) -> Option<(String, String, String)> {
    store::list().ok()?.into_iter().find_map(|a| {
        let copy = a.copy.as_ref()?;
        same_path(&copy.path, path).then(|| (a.id.clone(), a.name.clone(), copy.project.clone()))
    })
}

/// The workspace removed an agent's copy (confirmed by name): the agent no
/// longer holds it. Its branch stays, as the workspace's remove promises.
pub fn forget(agent_id: &str, path: &str) {
    let _ = store::update(agent_id, |a| {
        if a.copy.as_ref().is_some_and(|c| same_path(&c.path, path)) {
            a.copy = None;
        }
    });
}

/// At launch: forget copies whose folder is gone, and tidy copies of ours no
/// agent holds any more (an agent deleted while the app was closing): their
/// pending work is committed first, and a copy is kept whenever something
/// couldn't be. Branches with work on them are kept.
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
                stuck: None,
            };
            if orphan.branch.is_empty() {
                continue;
            }
            tracing::info!("[Agents] tidying a copy no agent holds: {}", wt.path);
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

    #[test]
    fn porcelain_paths_with_multibyte_names_never_panic() {
        assert_eq!(porcelain_path("?? 日本語.md"), Some("日本語.md"));
        assert_eq!(porcelain_path(" M ⌘ notes 🙂.txt"), Some("⌘ notes 🙂.txt"));
        // Not "XY path": a bare name (a rename's source) cut at byte 3.
        assert_eq!(porcelain_path("a日本語.md"), None);
        assert_eq!(porcelain_path("a⌘b"), None);
        assert_eq!(porcelain_path("a🙂"), None);
        assert_eq!(porcelain_path("?? "), None);
        assert_eq!(porcelain_path(""), None);
    }

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

    fn try_sh(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap()
            .status
            .success()
    }

    /// A project with one commit, its projects root beside it, and git's
    /// identity set for the commits the copy makes.
    fn project_named(name: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ShipStudio");
        let repo = root.join(name);
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

    fn project() -> (tempfile::TempDir, PathBuf, PathBuf) {
        project_named("acme-site")
    }

    async fn copy_of(repo: &Path, root: &Path, agent: &str, ask: &str) -> TaskCopy {
        create(repo, root, &format!("id-{agent}"), agent, ask)
            .await
            .unwrap()
            .expect("a git project gets a copy")
    }

    /// The copy's pending work, committed as a turn's end would.
    async fn save(copy: &TaskCopy) -> Saved {
        commit_pending(Path::new(&copy.path), &copy.branch, "agent", None)
            .await
            .unwrap()
    }

    async fn keep_it(copy: &TaskCopy) -> Result<Kept, CommandError> {
        keep_copy(copy, "Acme Site", None, None).await
    }

    fn read_file(path: impl AsRef<Path>) -> String {
        std::fs::read_to_string(path).unwrap()
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

    #[test]
    fn conflict_markers_and_credentials_are_recognised_in_added_lines_only() {
        let diff = "diff --git a/style.css b/style.css\n--- a/style.css\n+++ b/style.css\n@@ -1 +1,5 @@\n-h1 { color: red; }\n+<<<<<<< HEAD\n+h1 { color: blue; }\n+=======\n+h1 { color: green; }\n+>>>>>>> main\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -0,0 +1,2 @@\n+Title\n+=======\ndiff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-<<<<<<< old\n";
        assert_eq!(files_where(diff, is_marker), vec!["style.css"]);
        assert!(!is_marker("<<<<<<<<< not one"));
        assert!(is_marker(">>>>>>>"));

        assert!(looks_like_secret(
            "STRIPE_SECRET_KEY=sk_live_51HabcdefGHIJKLmnop"
        ));
        assert!(looks_like_secret(
            "const key = \"ghp_abcdefghijklmnopqrstuvwxyz0123\";"
        ));
        assert!(looks_like_secret("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(looks_like_secret(
            "export OPENAI_API_KEY=abc123def456ghi789"
        ));
        // Code that merely names a secret, or reads one, is not one.
        assert!(!looks_like_secret("type Props = { password: string };"));
        assert!(!looks_like_secret("const apiKey = process.env.API_KEY;"));
        assert!(!looks_like_secret("API_KEY=${API_KEY}"));
        assert!(!looks_like_secret(
            "integrity sha512-Abc123def456ghi789jkl012mno345pqr678stu901vwx234yz=="
        ));
    }

    /// What stopped the last Keep is kept on the copy itself, so every card
    /// (and the phone, after any re-render) shows it from the agent's state.
    #[test]
    fn a_stuck_keep_survives_the_registry_round_trip() {
        let copy = TaskCopy {
            id: "c".into(),
            project: "/p/acme".into(),
            path: "/p/.worktrees/acme/x".into(),
            branch: "acme/x".into(),
            base: "abc".into(),
            base_branch: Some("main".into()),
            created_at: 0,
            deps: false,
            stuck: Some(Kept::OtherBranch {
                current: "feature".into(),
                base: Some("main".into()),
            }),
        };
        let json = serde_json::to_value(&copy).unwrap();
        assert_eq!(
            json["stuck"],
            serde_json::json!({ "outcome": "otherBranch", "current": "feature", "base": "main" })
        );
        assert_eq!(serde_json::from_value::<TaskCopy>(json).unwrap(), copy);
        let markers = Kept::Markers {
            files: vec!["a.css".into()],
        };
        let back: Kept = serde_json::from_value(serde_json::to_value(&markers).unwrap()).unwrap();
        assert_eq!(back, markers);
    }

    #[test]
    fn the_left_out_line_says_why_in_plain_words() {
        let items = vec![
            LeftOut {
                path: ".env.local".into(),
                why: LeftOutWhy::Secrets,
            },
            LeftOut {
                path: "node_modules".into(),
                why: LeftOutWhy::Dependencies,
            },
            LeftOut {
                path: ".env".into(),
                why: LeftOutWhy::Ignored,
            },
        ];
        assert_eq!(
            left_out_line(&items).unwrap(),
            "Not included: .env.local (looks like secrets), node_modules (dependencies) · changed .env — not included (git ignores it)"
        );
        assert!(left_out_line(&[]).is_none());
        assert!(is_env_file("app/.env.production"));
        assert!(!is_env_file(".env.example"));
        assert!(is_dependency("packages/web/node_modules/"));
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
            read_file(path.join("style.css")),
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
        assert!(save(&copy).await.committed);
        assert_eq!(read_file(repo.join("index.html")), "<h1>Hello</h1>\n");
        assert!(super::super::project::summary(&repo, &start)
            .await
            .is_none());
        // Nothing left to commit: no empty commit. The copied-in .env and
        // dependencies were never anything to report.
        assert!(!save(&copy).await.committed);
        assert!(left_out(&copy).await.is_empty());
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

        let kept = keep_it(&copy).await.unwrap();
        assert_eq!(
            kept,
            Kept::Kept {
                files: 2,
                branch: "main".into(),
                left_out: Vec::new()
            }
        );
        assert_eq!(
            kept_note(&kept, "acme-site", "Acme Site").unwrap(),
            "Kept the changes in acme-site (main) · 2 files"
        );
        assert_eq!(
            read_file(repo.join("index.html")),
            "<h1 class=blue>Hello</h1>\n"
        );
        assert_eq!(read_file(repo.join("style.css")), "h1 { color: green; }\n");
        assert_eq!(read_file(repo.join("notes.txt")), "draft\n");
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

        let kept = keep_it(&copy).await.unwrap();
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
        assert!(!save(&copy).await.committed);
        // Asked again before it's resolved: the same answer.
        assert!(matches!(
            keep_it(&copy).await.unwrap(),
            Kept::Conflict { .. }
        ));

        // Resolved in the copy (as the conflict UI or the agent would), then kept.
        std::fs::write(path.join("style.css"), "h1 { color: teal; }\n").unwrap();
        sh(&path, &["add", "style.css"]);
        let kept = keep_it(&copy).await.unwrap();
        assert!(matches!(kept, Kept::Kept { .. }), "{kept:?}");
        assert_eq!(read_file(repo.join("style.css")), "h1 { color: teal; }\n");
    }

    #[tokio::test]
    async fn unsaved_edits_to_the_same_file_are_never_overwritten() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "blue").await;
        std::fs::write(Path::new(&copy.path).join("style.css"), "blue\n").unwrap();
        std::fs::write(repo.join("style.css"), "the user's unsaved edit\n").unwrap();
        let err = keep_it(&copy).await.unwrap_err().to_string();
        assert!(
            err.contains("unsaved edits") && err.contains("style.css"),
            "{err}"
        );
        assert_eq!(
            read_file(repo.join("style.css")),
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
        save(&copy).await;
        remove(&copy, Branch::Force).await.unwrap();
        assert!(!Path::new(&copy.path).exists());
        assert!(sh(&repo, &["branch", "--list", &copy.branch]).is_empty());
        assert_eq!(read_file(repo.join("index.html")), "<h1>Hello</h1>\n");
    }

    #[tokio::test]
    async fn cleanup_never_deletes_a_branch_with_work_on_it() {
        let (_dir, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme Site", "keep me").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "work\n").unwrap();
        save(&copy).await;
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
        assert_eq!(
            keep_it(&copy).await.unwrap(),
            Kept::Nothing {
                left_out: Vec::new()
            }
        );
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
            read_file(Path::new(&a.path).join("index.html")),
            "<h1>From A</h1>\n"
        );
        // The first kept wins cleanly; the second overlaps, in its own copy.
        assert!(matches!(
            keep_copy(&a, "Acme Site", None, None).await.unwrap(),
            Kept::Kept { .. }
        ));
        assert!(matches!(
            keep_copy(&b, "Copywriter", None, None).await.unwrap(),
            Kept::Conflict { .. }
        ));
        assert_eq!(read_file(repo.join("index.html")), "<h1>From A</h1>\n");
        assert!(!repo.join("about.html").exists());
    }

    fn bound_agent(name: &str, project: &Path) -> store::Agent {
        let agent = store::create(store::NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            avatar: None,
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
        assert!(card.left_out.is_empty() && card.warning.is_none());
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
        assert_eq!(read_file(repo.join("index.html")), "<h1>Hello</h1>\n");

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

    /* ------------------------------------------- regressions (data safety) */

    /// Made from main; the user switched the project to feature since. Keep
    /// asks, naming both, and only a confirmation naming feature keeps there.
    #[tokio::test]
    async fn keep_onto_a_different_branch_asks_first_and_carries_nothing_until_confirmed() {
        let (_d, root, repo) = project();
        sh(&repo, &["checkout", "-qb", "feature"]);
        std::fs::write(repo.join("feature.txt"), "f\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "feature work"]);
        sh(&repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("main-only.txt"), "main secret wip\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "main-only commit"]);
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "blue\n").unwrap();
        save(&copy).await;
        sh(&repo, &["checkout", "-q", "feature"]);
        let feature_tip = sh(&repo, &["rev-parse", "feature"]);

        let kept = keep_it(&copy).await.unwrap();
        assert_eq!(
            kept,
            Kept::OtherBranch {
                current: "feature".into(),
                base: Some("main".into())
            }
        );
        assert!(!repo.join("main-only.txt").exists());
        assert_eq!(sh(&repo, &["rev-parse", "feature"]), feature_tip);
        assert!(Path::new(&copy.path).is_dir());
        // A confirmation for some other branch is no confirmation.
        assert!(matches!(
            keep_copy(&copy, "Acme", None, Some("main")).await.unwrap(),
            Kept::OtherBranch { .. }
        ));
        assert_eq!(sh(&repo, &["rev-parse", "feature"]), feature_tip);

        let kept = keep_copy(&copy, "Acme", None, Some("feature"))
            .await
            .unwrap();
        assert!(
            matches!(&kept, Kept::Kept { branch, .. } if branch == "feature"),
            "{kept:?}"
        );
        assert_eq!(read_file(repo.join("index.html")), "blue\n");
    }

    /// Uncommitted user changes in other files (staged, unstaged, untracked)
    /// survive Keep.
    #[tokio::test]
    async fn keep_with_a_dirty_project_leaves_the_users_other_files_alone() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "blue\n").unwrap();
        std::fs::write(repo.join("style.css"), "staged edit\n").unwrap();
        sh(&repo, &["add", "style.css"]);
        std::fs::write(repo.join("style.css"), "staged edit then unstaged\n").unwrap();
        std::fs::write(repo.join("scratch.txt"), "untracked\n").unwrap();
        keep_it(&copy).await.unwrap();
        assert_eq!(
            read_file(repo.join("style.css")),
            "staged edit then unstaged\n"
        );
        assert_eq!(read_file(repo.join("scratch.txt")), "untracked\n");
        assert_eq!(sh(&repo, &["diff", "--cached", "--name-only"]), "style.css");
    }

    /// The user has an untracked file where the copy adds one: refused, in
    /// words that say what's actually in the way.
    #[tokio::test]
    async fn an_untracked_collision_is_refused_and_named_correctly() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "about page").await;
        std::fs::write(Path::new(&copy.path).join("about.html"), "agent\n").unwrap();
        std::fs::write(repo.join("about.html"), "the user's own untracked draft\n").unwrap();
        let err = keep_it(&copy).await.unwrap_err().to_string();
        assert!(
            err.contains("files of its own, not yet saved in git") && err.contains("about.html"),
            "{err}"
        );
        assert!(!err.contains("unsaved edits"), "{err}");
        assert_eq!(
            read_file(repo.join("about.html")),
            "the user's own untracked draft\n"
        );
        assert!(Path::new(&copy.path).is_dir());
    }

    /// A tracked `.shipstudio/project.json`: the copy's own port never
    /// becomes a change Keep carries into the project.
    #[tokio::test]
    async fn a_tracked_shipstudio_file_is_never_rewritten_by_keep() {
        let (_d, root, repo) = project();
        std::fs::create_dir_all(repo.join(".shipstudio")).unwrap();
        std::fs::write(
            repo.join(".shipstudio/project.json"),
            "{\"schema_version\":4,\"dev_port\":3000,\"custom_dev_command\":\"pnpm dev\"}\n",
        )
        .unwrap();
        sh(&repo, &["add", "-f", ".shipstudio/project.json"]);
        sh(&repo, &["commit", "-qm", "track ss"]);
        let before = read_file(repo.join(".shipstudio/project.json"));
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        let path = PathBuf::from(&copy.path);
        assert_ne!(
            read_file(path.join(".shipstudio/project.json")),
            before,
            "the copy has a port of its own"
        );
        std::fs::write(path.join("index.html"), "blue\n").unwrap();
        save(&copy).await;
        let committed = sh(&path, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(committed, "index.html");
        let kept = keep_it(&copy).await.unwrap();
        assert!(matches!(kept, Kept::Kept { files: 1, .. }), "{kept:?}");
        assert_eq!(read_file(repo.join(".shipstudio/project.json")), before);
    }

    /// The agent "resolves" a conflict by staging everything, markers and
    /// all: nothing is committed or kept, and the card says why.
    #[tokio::test]
    async fn conflict_markers_are_never_committed_or_kept() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "red to blue").await;
        let path = PathBuf::from(&copy.path);
        std::fs::write(path.join("style.css"), "h1 { color: blue; }\n").unwrap();
        std::fs::write(repo.join("style.css"), "h1 { color: green; }\n").unwrap();
        sh(&repo, &["commit", "-qam", "user"]);
        let users_head = sh(&repo, &["rev-parse", "HEAD"]);
        assert!(matches!(
            keep_it(&copy).await.unwrap(),
            Kept::Conflict { .. }
        ));
        sh(&path, &["add", "-A"]);
        let copy_head = sh(&path, &["rev-parse", "HEAD"]);
        let kept = keep_it(&copy).await.unwrap();
        assert_eq!(
            kept,
            Kept::Markers {
                files: vec!["style.css".into()]
            }
        );
        assert!(kept_note(&kept, "acme-site", "Acme")
            .unwrap()
            .contains("conflict markers in them (style.css)"));
        assert_eq!(sh(&path, &["rev-parse", "HEAD"]), copy_head, "no commit");
        assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), users_head);
        assert_eq!(read_file(repo.join("style.css")), "h1 { color: green; }\n");

        // Committed by the agent itself: still caught before the project moves.
        sh(&path, &["commit", "-qm", "resolved (not really)"]);
        assert!(matches!(
            keep_it(&copy).await.unwrap(),
            Kept::Markers { .. }
        ));
        assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), users_head);
        assert!(!read_file(repo.join("style.css")).contains("<<<<<<<"));
    }

    /// The agent checks out the user's `release` branch in its copy: the
    /// end-of-turn commit, Keep and cleanup all refuse and touch nothing.
    #[tokio::test]
    async fn a_copy_moved_to_another_branch_is_never_committed_kept_or_tidied() {
        let (_d, root, repo) = project();
        sh(&repo, &["branch", "release"]);
        let release = sh(&repo, &["rev-parse", "release"]);
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        let path = PathBuf::from(&copy.path);
        sh(&path, &["checkout", "-q", "release"]);
        std::fs::write(path.join("index.html"), "hotfix by agent\n").unwrap();

        let err = commit_pending(&path, &copy.branch, "Acme: update index.html", None)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(err, OFF_BRANCH);
        assert_eq!(sh(&repo, &["rev-parse", "release"]), release);
        assert_eq!(keep_it(&copy).await.unwrap_err().to_string(), OFF_BRANCH);
        assert_eq!(
            remove(&copy, Branch::IfMerged)
                .await
                .unwrap_err()
                .to_string(),
            OFF_BRANCH
        );
        assert!(!dropped_if_unused("nobody", &copy).await);
        assert_eq!(read_file(path.join("index.html")), "hotfix by agent\n");
        assert_eq!(sh(&repo, &["rev-parse", "release"]), release);
    }

    /// Detached, with commits nothing else holds: even Discard keeps it.
    #[tokio::test]
    async fn a_detached_copy_with_unreachable_work_is_never_force_removed() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        let path = PathBuf::from(&copy.path);
        sh(&path, &["checkout", "-q", "--detach"]);
        std::fs::write(path.join("index.html"), "detached work\n").unwrap();
        sh(&path, &["commit", "-qam", "detached work"]);
        let lost = sh(&path, &["rev-parse", "HEAD"]);
        assert_eq!(
            remove(&copy, Branch::Force).await.unwrap_err().to_string(),
            OFF_BRANCH_LOST
        );
        assert!(path.is_dir());
        assert_eq!(sh(&path, &["rev-parse", "HEAD"]), lost);
        assert_eq!(read_file(path.join("index.html")), "detached work\n");
    }

    /// Cleanup (agent deleted, launch sweep) with uncommitted work: the work
    /// is committed to the copy's branch before the folder goes.
    #[tokio::test]
    async fn cleanup_commits_uncommitted_work_before_removing_the_folder() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "wip").await;
        let path = PathBuf::from(&copy.path);
        std::fs::write(path.join("index.html"), "precious uncommitted\n").unwrap();
        std::fs::write(path.join("new.txt"), "precious untracked\n").unwrap();
        remove(&copy, Branch::IfMerged).await.unwrap();
        assert_eq!(
            sh(&repo, &["show", &format!("{}:index.html", copy.branch)]),
            "precious uncommitted"
        );
        assert_eq!(
            sh(&repo, &["show", &format!("{}:new.txt", copy.branch)]),
            "precious untracked"
        );
    }

    /// …and when something can't be committed (a secret), the copy stays.
    #[tokio::test]
    async fn cleanup_keeps_a_copy_holding_work_that_cant_be_committed() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "keys").await;
        let path = PathBuf::from(&copy.path);
        std::fs::write(
            path.join(".env.local"),
            "STRIPE_KEY=sk_live_abcdefghijklmnop123\n",
        )
        .unwrap();
        let err = remove(&copy, Branch::IfMerged)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(".env.local") && err.contains("kept"), "{err}");
        assert!(path.join(".env.local").is_file());
        assert!(!sh(&repo, &["branch", "--list", &copy.branch]).is_empty());
    }

    /// Rebinding an agent while its copy is open: refused up front, and a
    /// turn bound elsewhere never wipes or strands the old copy.
    #[tokio::test]
    async fn rebinding_never_wipes_or_strands_an_open_copy() {
        let (_d, root, repo) = project();
        let (_d2, _root2, other) = project_named("other");
        let home = tempfile::tempdir().unwrap();
        let _serial = store::tests_lock();
        store::set_root_for_tests(Some(home.path().to_path_buf()));
        let agent = bound_agent("Acme", &repo);
        let (copy, _) = prepare_in(&agent.id, "blue", &root, |_| {})
            .await
            .unwrap()
            .unwrap();
        let path = PathBuf::from(&copy.path);
        std::fs::write(path.join("index.html"), "committed work\n").unwrap();
        save(&copy).await;
        std::fs::write(path.join("style.css"), "uncommitted work\n").unwrap();

        let held = store::get(&agent.id).unwrap();
        let other_path = other.to_string_lossy().to_string();
        let err = refuse_rebind(&held, Some(&other_path))
            .unwrap_err()
            .to_string();
        assert!(err.contains("Keep or discard them first"), "{err}");
        assert!(refuse_rebind(&held, held.project.as_deref()).is_ok());

        // Bound elsewhere anyway (an older build, a hand-edited registry).
        store::update(&agent.id, |a| a.project = Some(other_path.clone())).unwrap();
        let err = prepare_in(&agent.id, "next", &root, |_| {})
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("still has a copy of acme-site open"), "{err}");
        assert_eq!(read_file(path.join("style.css")), "uncommitted work\n");
        assert_eq!(
            store::get(&agent.id).unwrap().copy.map(|c| c.id),
            Some(copy.id.clone())
        );
        store::set_root_for_tests(None);
    }

    /// A tag named like the branch the project is on.
    #[tokio::test]
    async fn a_tag_named_like_the_current_branch_doesnt_confuse_keep() {
        let (_d, root, repo) = project();
        sh(&repo, &["tag", "main", "HEAD"]);
        std::fs::write(repo.join("style.css"), "user moved on\n").unwrap();
        sh(&repo, &["commit", "-qam", "user"]);
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "blue\n").unwrap();
        std::fs::write(repo.join("notes.md"), "n\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "user again"]);
        let kept = keep_it(&copy).await.unwrap();
        assert!(matches!(kept, Kept::Kept { .. }), "{kept:?}");
        assert_eq!(read_file(repo.join("index.html")), "blue\n");
        assert_eq!(read_file(repo.join("notes.md")), "n\n");
    }

    fn diverged() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (d, root, repo) = project();
        sh(&repo, &["checkout", "-qb", "side"]);
        std::fs::write(repo.join("style.css"), "side\n").unwrap();
        sh(&repo, &["commit", "-qam", "side"]);
        sh(&repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("style.css"), "main\n").unwrap();
        sh(&repo, &["commit", "-qam", "main"]);
        (d, root, repo)
    }

    /// The project is mid-merge: refused in a sentence, nothing touched.
    #[tokio::test]
    async fn keep_while_the_project_is_mid_merge_is_refused_in_words() {
        let (_d, root, repo) = diverged();
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "blue\n").unwrap();
        assert!(!try_sh(&repo, &["merge", "side"]));
        let before = read_file(repo.join("style.css"));
        let err = keep_it(&copy).await.unwrap_err().to_string();
        assert_eq!(
            err,
            "acme-site is in the middle of a merge. Finish it or call it off in acme-site, then Keep again."
        );
        assert_eq!(read_file(repo.join("style.css")), before);
        assert!(repo.join(".git/MERGE_HEAD").exists());
        assert!(Path::new(&copy.path).is_dir());
    }

    #[tokio::test]
    async fn keep_while_the_project_is_mid_cherry_pick_is_refused_in_words() {
        let (_d, root, repo) = diverged();
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "blue\n").unwrap();
        assert!(!try_sh(&repo, &["cherry-pick", "side"]));
        let err = keep_it(&copy).await.unwrap_err().to_string();
        assert!(err.contains("in the middle of a cherry-pick"), "{err}");
        assert!(repo.join(".git/CHERRY_PICK_HEAD").exists());
    }

    /// The agent edits an ignored `.env` in the copy: Keep says so, rather
    /// than "already has these changes" alone.
    #[tokio::test]
    async fn edits_to_ignored_files_are_reported_as_not_included() {
        let (_d, root, repo) = project();
        std::fs::write(repo.join(".env"), "A=1\n").unwrap();
        let copy = copy_of(&repo, &root, "Acme", "add stripe key").await;
        std::fs::write(Path::new(&copy.path).join(".env"), "A=1\nSTRIPE=sk_live\n").unwrap();
        let kept = keep_it(&copy).await.unwrap();
        assert_eq!(
            kept,
            Kept::Nothing {
                left_out: vec![LeftOut {
                    path: ".env".into(),
                    why: LeftOutWhy::Ignored
                }]
            }
        );
        assert_eq!(
            kept_note(&kept, "acme-site", "Acme").unwrap(),
            "Nothing to keep: acme-site already has these changes · changed .env — not included (git ignores it)"
        );
        assert_eq!(read_file(repo.join(".env")), "A=1\n");
    }

    /// No `.gitignore`: the agent's `node_modules`, a `.env.local`, a file
    /// with a live key in it and a big file are never committed, and the
    /// card lists each with why.
    #[tokio::test]
    async fn secrets_dependencies_and_big_files_are_never_auto_committed() {
        let (_d, root, repo) = project();
        std::fs::remove_file(repo.join(".gitignore")).unwrap();
        sh(&repo, &["commit", "-qam", "no ignore"]);
        let home = tempfile::tempdir().unwrap();
        let _serial = store::tests_lock();
        store::set_root_for_tests(Some(home.path().to_path_buf()));
        let agent = bound_agent("Acme", &repo);
        let (copy, _) = prepare_in(&agent.id, "install", &root, |_| {})
            .await
            .unwrap()
            .unwrap();
        let p = PathBuf::from(&copy.path);
        let from = super::super::project::snapshot(&p).await.unwrap();
        std::fs::create_dir_all(p.join("node_modules/x")).unwrap();
        std::fs::write(p.join("node_modules/x/i.js"), "x\n").unwrap();
        std::fs::write(p.join(".env.local"), "OPENAI_API_KEY=sk-abc\n").unwrap();
        std::fs::write(
            p.join("config.js"),
            "export const stripe = \"sk_live_51Habcdefghijklmnopqrst\";\n",
        )
        .unwrap();
        std::fs::write(
            p.join("video.mp4"),
            vec![0u8; (MAX_COMMIT_BYTES + 1) as usize],
        )
        .unwrap();
        std::fs::write(p.join("index.html"), "blue\n").unwrap();
        std::fs::write(p.join(".env.example"), "OPENAI_API_KEY=\n").unwrap();

        let card = record_turn(&agent.id, &copy, &from).await.unwrap();
        let mut committed = lines(&sh(&p, &["show", "--name-only", "--format=", "HEAD"]));
        committed.sort();
        assert_eq!(committed, vec![".env.example", "index.html"]);
        assert_eq!(card.file_count, 2, "the card is what Keep brings");
        let mut left: Vec<(String, LeftOutWhy)> = card
            .left_out
            .iter()
            .map(|l| (l.path.clone(), l.why))
            .collect();
        left.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            left,
            vec![
                (".env.local".into(), LeftOutWhy::Secrets),
                ("config.js".into(), LeftOutWhy::Secrets),
                ("node_modules".into(), LeftOutWhy::Dependencies),
                ("video.mp4".into(), LeftOutWhy::TooLarge),
            ]
        );
        assert!(left_out_line(&card.left_out)
            .unwrap()
            .contains(".env.local (looks like secrets)"));
        store::set_root_for_tests(None);
    }

    /// With attribution on, the copy's commits carry the agent's trailer
    /// (the engine's name, never the app's); with it off, none.
    #[tokio::test]
    async fn auto_commits_carry_the_made_with_trailer_when_attribution_is_on() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        let path = PathBuf::from(&copy.path);
        {
            let _on = crate::commands::team::test_attribution(true);
            std::fs::write(path.join("index.html"), "blue\n").unwrap();
            commit_pending(
                &path,
                &copy.branch,
                "Acme: update index.html",
                Some("Claude Code"),
            )
            .await
            .unwrap();
        }
        let body = sh(&path, &["log", "-1", "--format=%B"]);
        assert!(body.contains("Made-With: Claude Code"), "{body}");
        assert!(!body.contains(crate::brand::NAME), "{body}");
        {
            let _off = crate::commands::team::test_attribution(false);
            std::fs::write(path.join("index.html"), "bluer\n").unwrap();
            commit_pending(&path, &copy.branch, "again", Some("Claude Code"))
                .await
                .unwrap();
        }
        assert!(!sh(&path, &["log", "-1", "--format=%B"]).contains("Made-With"));
    }

    /// Two folders of one repository share one lock.
    #[tokio::test]
    async fn the_lock_is_per_repository_not_per_folder() {
        let (_d, root, repo) = project();
        let copy = copy_of(&repo, &root, "Acme", "x").await;
        assert_eq!(
            repo_key(&repo.to_string_lossy()).await,
            repo_key(&copy.path).await
        );
        let (_d2, _r2, other) = project_named("other");
        assert_ne!(
            repo_key(&repo.to_string_lossy()).await,
            repo_key(&other.to_string_lossy()).await
        );
    }

    #[tokio::test]
    async fn unicode_and_spaces_in_names_work() {
        let (_d, root, repo) = project_named("Café Site (v2)");
        let copy = copy_of(&repo, &root, "Ågent Ünï", "Fix the ünïcode  header").await;
        std::fs::write(Path::new(&copy.path).join("index.html"), "x\n").unwrap();
        let kept = keep_copy(&copy, "Ågent Ünï", None, None).await.unwrap();
        assert!(matches!(kept, Kept::Kept { .. }), "{kept:?}");
    }

    /// Made while the project was detached: Keep refuses, the copy stays.
    #[tokio::test]
    async fn a_copy_of_a_detached_project_is_kept_until_theres_a_branch() {
        let (_d, root, repo) = project();
        let head = sh(&repo, &["rev-parse", "HEAD"]);
        sh(&repo, &["checkout", "-q", "--detach", &head]);
        let copy = copy_of(&repo, &root, "Acme", "blue").await;
        assert_eq!(copy.base_branch, None);
        std::fs::write(Path::new(&copy.path).join("index.html"), "x\n").unwrap();
        assert!(keep_it(&copy).await.is_err());
        assert!(Path::new(&copy.path).is_dir());
        // On a branch again: made from no branch, so it asks before keeping.
        sh(&repo, &["checkout", "-q", "main"]);
        assert_eq!(
            keep_it(&copy).await.unwrap(),
            Kept::OtherBranch {
                current: "main".into(),
                base: None
            }
        );
    }

    /// The launch sweep leaves the user's own worktrees alone, and tidies a
    /// copy no agent holds only after committing its work.
    #[tokio::test]
    async fn the_sweep_never_loses_an_orphaned_copys_work() {
        let (_d, root, repo) = project();
        let home = tempfile::tempdir().unwrap();
        let _serial = store::tests_lock();
        store::set_root_for_tests(Some(home.path().to_path_buf()));
        bound_agent("Acme", &repo);
        let user_wt = root.join(".worktrees/acme-site/feature-x");
        sh(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature-x",
                user_wt.to_str().unwrap(),
            ],
        );
        std::fs::write(user_wt.join("index.html"), "user's dirty\n").unwrap();
        let user_locked = root.join(".worktrees/acme-site/locked-y");
        sh(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "--lock",
                "--reason",
                "on usb",
                "-b",
                "locked-y",
                user_locked.to_str().unwrap(),
            ],
        );
        let orphan = copy_of(&repo, &root, "Acme", "orphan").await;
        std::fs::write(
            Path::new(&orphan.path).join("index.html"),
            "uncommitted orphan work\n",
        )
        .unwrap();
        sweep().await;
        assert_eq!(read_file(user_wt.join("index.html")), "user's dirty\n");
        assert!(user_locked.is_dir());
        assert_eq!(
            sh(&repo, &["show", &format!("{}:index.html", orphan.branch)]),
            "uncommitted orphan work"
        );
        store::set_root_for_tests(None);
    }
}
