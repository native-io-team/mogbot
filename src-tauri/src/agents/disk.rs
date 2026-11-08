//! Disk hygiene: agents never fill the Mac without anyone noticing.
//!
//! Observed (2026-11-07): an agent's dependency sweep cloned ~40 repos into
//! its home and ran `npm ci` in many copies at once. Its home reached 39 GB,
//! the Mac fell to 1–2 GB free overnight, and nothing warned the user.
//!
//! - **Awareness.** Free space on the volume holding the user's home is read
//!   (one `statvfs`, every [`EVERY`] while the app is open, and fresh for
//!   every turn and approval). Below [`LOW_BYTES`] each turn opens with a
//!   note from the app ([`turn_note`]) and the Chief's chat gets one quiet
//!   line. Below [`FLOOR_BYTES`], package installs and clones by agents ask
//!   on a card at every level ([`floor_asks`], wired in `mcp::decide_inner`)
//!   and the user gets one notification. Each is said once per crossing,
//!   again only after space came back ([`REARM_BYTES`] above the line).
//! - **Cleanup by default.** When an agent goes idle its home's regenerable
//!   folders ([`REGENERABLE`]: `node_modules`, `.next`, `.turbo`, `target`)
//!   untouched for [`PRUNE_AFTER`] ([`PRUNE_AFTER_LOW`] while disk is low)
//!   are removed ([`after_idle`]). Only inside the agent's own home, never a
//!   project, a copy of one, or the user's folders.
//! - **Settings → Agents** shows each home over [`LARGE_BYTES`] with "Free up
//!   space" ([`overview`], [`free_up`]), regenerable folders only.
//!
//! A folder is removed only when all of these hold ([`candidates`],
//! [`safe_in_git`]): its name is regenerable and the file that regenerates it
//! sits beside it (`package.json` for `node_modules`, `Cargo.toml` for
//! `target`…); it is a real folder, not a symlink, and holds no `.git`; it is
//! inside the agent's home; it was found without entering a `.git` folder
//! or following a link; and, inside a git working copy, git ignores it and
//! tracks nothing in it, so removing it changes nothing git would call a
//! change. Reports, `.git` folders and unpushed commits are never touched.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};
use tauri::AppHandle;

use super::store;

const GB: u64 = 1_000_000_000;
/// Below this, agents are told to clean up and the Chief's chat says so.
pub const LOW_BYTES: u64 = 15 * GB;
/// Below this, installs and clones ask on a card and the user is notified.
pub const FLOOR_BYTES: u64 = 5 * GB;
/// A line said for a crossing is said again only once space is back this far above it.
pub const REARM_BYTES: u64 = 2 * GB;
/// An agent home this big shows in Settings → Agents.
pub const LARGE_BYTES: u64 = GB;
/// How often free space is read while the app is open.
pub const EVERY: Duration = Duration::from_secs(2 * 60);
/// A regenerable folder untouched this long is pruned when its agent goes idle.
pub const PRUNE_AFTER: Duration = Duration::from_secs(6 * 60 * 60);
/// The same while disk is low.
pub const PRUNE_AFTER_LOW: Duration = Duration::from_secs(60 * 60);
/// How deep a home is searched for regenerable folders.
const MAX_DEPTH: usize = 8;
/// Entries looked at per search, so a huge home can't stall the app.
const MAX_ENTRIES: usize = 200_000;
const GIT_TIMEOUT_SECS: u64 = 15;

/// Folder names that a project's own tools rebuild, and the file beside one
/// that says so.
pub const REGENERABLE: &[(&str, &[&str])] = &[
    ("node_modules", &["package.json"]),
    (
        ".next",
        &[
            "package.json",
            "next.config.js",
            "next.config.mjs",
            "next.config.ts",
        ],
    ),
    (".turbo", &["package.json", "turbo.json"]),
    ("target", &["Cargo.toml"]),
];

/* ------------------------------------------------------------ levels */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Fine,
    Low,
    Floor,
}

pub fn level_for(free: Option<u64>) -> Level {
    match free {
        Some(f) if f < FLOOR_BYTES => Level::Floor,
        Some(f) if f < LOW_BYTES => Level::Low,
        _ => Level::Fine,
    }
}

/// `12 GB`, `3.4 GB`: decimal gigabytes, as Finder counts them.
pub fn gb(bytes: u64) -> String {
    let g = bytes as f64 / GB as f64;
    if g >= 10.0 {
        format!("{g:.0} GB")
    } else if g >= 0.1 {
        format!("{g:.1} GB")
    } else {
        format!("{} MB", bytes / 1_000_000)
    }
}

/// Bytes free on the volume holding the user's home (where agent homes,
/// projects and package caches live). `None` when it can't be read.
pub fn free_now() -> Option<u64> {
    if let Some(pretend) = *PRETEND.lock().unwrap_or_else(|e| e.into_inner()) {
        return pretend;
    }
    // Tests never depend on this Mac's own disk.
    #[cfg(test)]
    {
        None
    }
    #[cfg(not(test))]
    {
        super::task::free_bytes(&dirs::home_dir()?)
    }
}

/// A reading [`free_now`] answers instead of the disk's, for the whole
/// process; `None` puts the disk back. Only the end-to-end suite sets it
/// (`examples/agents_e2e`), to see a low disk without filling one; nothing
/// in the app calls it.
static PRETEND: Mutex<Option<Option<u64>>> = Mutex::new(None);

#[doc(hidden)]
pub fn pretend_free(reading: Option<Option<u64>>) {
    *PRETEND.lock().unwrap_or_else(|e| e.into_inner()) = reading;
}

pub fn level_now() -> Level {
    level_for(free_now())
}

/// What opens a turn while disk is low; empty otherwise. In the turn's
/// prompt, never the system prompt, so the engine's cache holds.
pub fn turn_note() -> String {
    note_for(free_now())
}

fn note_for(free: Option<u64>) -> String {
    let Some(free) = free else {
        return String::new();
    };
    let ask = match level_for(Some(free)) {
        Level::Fine => return String::new(),
        Level::Low => "",
        Level::Floor => " Installing packages and cloning now ask the user on a card.",
    };
    format!(
        "[A note from the app, not the user: this Mac's disk is low: {} free.{ask} Clean up \
before installing or cloning: delete node_modules and build folders in copies you're done \
with; keep reports and unpushed commits. Mention it only if it stops your work.]\n\n",
        gb(free)
    )
}

/// Whether a command line installs packages or clones a repository: what
/// fills a disk fastest.
pub fn fetches(command: &str) -> bool {
    use super::go_hard::{base, commands, unwrapped};
    commands(command).iter().any(|words| {
        let words: Vec<&str> = words.iter().map(String::as_str).collect();
        let words = unwrapped(&words);
        let Some((prog, args)) = words.split_first() else {
            return false;
        };
        let prog = base(prog);
        // The first word that isn't an option (or an option's value).
        let valued: &[&str] = match prog {
            "git" => &["-C", "-c", "--git-dir", "--work-tree"],
            "pnpm" => &["--filter", "-F", "-C", "--dir", "-w"],
            "npm" => &["--prefix", "-w", "--workspace"],
            "yarn" => &["--cwd"],
            "cargo" => &["-Z", "--config"],
            _ => &[],
        };
        let mut sub = None;
        let mut rest = args.iter().copied();
        while let Some(a) = rest.next() {
            if valued.contains(&a) {
                rest.next();
            } else if !a.starts_with('-') && !a.starts_with('+') {
                sub = Some(a);
                break;
            }
        }
        let after = |s: &str| {
            args.iter()
                .skip_while(|a| **a != s)
                .skip(1)
                .find(|a| !a.starts_with('-'))
                .copied()
        };
        match prog {
            "npm" | "cnpm" => matches!(
                sub,
                Some("install" | "i" | "in" | "ci" | "add" | "update" | "up" | "isntall")
            ),
            "pnpm" => matches!(
                sub,
                Some("install" | "i" | "add" | "update" | "up" | "fetch")
            ),
            "yarn" => sub.is_none() || matches!(sub, Some("install" | "add" | "upgrade")),
            "bun" => matches!(sub, Some("install" | "i" | "add")),
            "pip" | "pip3" => matches!(sub, Some("install" | "download")),
            "python" | "python3" => {
                args.windows(2).any(|w| w == ["-m", "pip"]) && args.contains(&"install")
            }
            "uv" => match sub {
                Some("sync" | "add") => true,
                Some("pip") => after("pip") == Some("install"),
                _ => false,
            },
            "poetry" => matches!(sub, Some("install" | "add")),
            "cargo" => matches!(
                sub,
                Some("build" | "b" | "install" | "fetch" | "test" | "t" | "run" | "r" | "check")
            ),
            "go" => {
                matches!(sub, Some("get" | "install" | "build")) || after("mod") == Some("download")
            }
            "brew" => matches!(sub, Some("install" | "reinstall" | "upgrade")),
            "git" => sub == Some("clone"),
            "gh" => sub == Some("repo") && after("repo") == Some("clone"),
            _ => false,
        }
    })
}

/// Below the floor, a call that installs or clones asks on a card at every
/// level (`mcp::decide_inner`), and no standing rule answers it.
pub fn floor_asks(tool: &str, input: &serde_json::Value) -> bool {
    floor_asks_at(free_now(), tool, input)
}

fn floor_asks_at(free: Option<u64>, tool: &str, input: &serde_json::Value) -> bool {
    tool == "Bash"
        && level_for(free) == Level::Floor
        && input
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(fetches)
}

/// The line a card held for the floor carries.
pub fn card_line() -> String {
    card_line_for(free_now())
}

fn card_line_for(free: Option<u64>) -> String {
    format!(
        "This Mac has {} free, under the {} floor, so installs and clones ask first.",
        free.map(gb).unwrap_or_else(|| "little space".to_string()),
        gb(FLOOR_BYTES)
    )
}

/* -------------------------------------------------------- crossings */

/// What has been said for the current dip.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Said {
    pub low: bool,
    pub floor: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Crossing {
    Low,
    Floor,
}

/// A new reading: what to say now, if anything. Once per crossing; again
/// only after space came back [`REARM_BYTES`] above the line.
pub fn step(said: &mut Said, free: u64) -> Option<Crossing> {
    if free >= LOW_BYTES + REARM_BYTES {
        *said = Said::default();
    } else if free >= FLOOR_BYTES + REARM_BYTES {
        said.floor = false;
    }
    if free < FLOOR_BYTES && !said.floor {
        said.floor = true;
        said.low = true;
        return Some(Crossing::Floor);
    }
    if free < LOW_BYTES && !said.low {
        said.low = true;
        return Some(Crossing::Low);
    }
    None
}

pub fn chief_line(c: Crossing, free: u64) -> String {
    match c {
        Crossing::Low => format!(
            "This Mac is low on disk space: {} free. Agents are told to clean up before installing anything.",
            gb(free)
        ),
        Crossing::Floor => format!(
            "This Mac is nearly out of disk space: {} free. Agents now ask before installing packages or cloning. Settings → Agents shows the largest agent folders, with Free up space.",
            gb(free)
        ),
    }
}

static SAID: Mutex<Said> = Mutex::new(Said {
    low: false,
    floor: false,
});

/// Read free space and say what a crossing needs: a quiet line in the
/// Chief's chat, and at the floor one notification.
fn check(app: &AppHandle) {
    let Some(free) = free_now() else { return };
    let crossing = step(&mut SAID.lock().unwrap_or_else(|e| e.into_inner()), free);
    let Some(crossing) = crossing else { return };
    tracing::warn!("[Agents] disk {crossing:?}: {} free", gb(free));
    let Some(chief) = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main))
    else {
        return;
    };
    let line = chief_line(crossing, free);
    let _ = super::runner::record(
        app,
        super::runner::new_message(&chief.id, store::MessageKind::Note, line.clone()),
    );
    if crossing == Crossing::Floor {
        super::notify::alert_user(app, &chief.id, &line);
    }
}

/// On open and every [`EVERY`] while the app is open.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let a = app.clone();
            let _ = tokio::task::spawn_blocking(move || check(&a)).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/* ------------------------------------------------------------ prune */

fn regenerates(name: &str, parent: &Path) -> bool {
    REGENERABLE
        .iter()
        .find(|(n, _)| *n == name)
        .is_some_and(|(_, markers)| markers.iter().any(|m| parent.join(m).is_file()))
}

/// Regenerable folders under `home`, untouched for `older_than` as of `now`.
/// Never enters `.git`, a symlink or another regenerable folder.
pub fn candidates(home: &Path, older_than: Duration, now: SystemTime) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = 0usize;
    let mut stack = vec![(home.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return out;
            }
            // Not followed: a link's type is the link's.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" {
                continue;
            }
            let path = entry.path();
            if REGENERABLE.iter().any(|(n, _)| *n == name) {
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| now.duration_since(m).ok())
                    .is_some_and(|age| age >= older_than);
                if old && regenerates(&name, &dir) && !path.join(".git").exists() {
                    out.push(path);
                }
                continue;
            }
            if depth + 1 < MAX_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }
    out.sort();
    out
}

/// The working copy `p` is in, below `home`: the nearest ancestor with `.git`.
fn repo_of(p: &Path, home: &Path) -> Option<PathBuf> {
    p.parent()?
        .ancestors()
        .take_while(|a| a.starts_with(home))
        .find(|a| a.join(".git").exists())
        .map(Path::to_path_buf)
}

async fn git_ok(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = crate::utils::git_command_in(dir).ok()?;
    cmd.env("GIT_OPTIONAL_LOCKS", "0").args(args);
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "git (disk tidy)",
        GIT_TIMEOUT_SECS,
    )
    .await
    .ok()
}

/// Inside a git working copy, removing `dir` changes nothing git sees: git
/// ignores it and tracks nothing in it. Outside one, true. Any doubt (git
/// missing, an error, a timeout) is false.
pub async fn safe_in_git(dir: &Path, home: &Path) -> bool {
    let Some(repo) = repo_of(dir, home) else {
        return true;
    };
    let Ok(rel) = dir.strip_prefix(&repo) else {
        return false;
    };
    let rel = rel.to_string_lossy().to_string();
    let ignored = git_ok(&repo, &["check-ignore", "-q", "--", &rel])
        .await
        .is_some_and(|o| o.status.success());
    if !ignored {
        return false;
    }
    git_ok(&repo, &["ls-files", "-z", "--", &rel])
        .await
        .is_some_and(|o| o.status.success() && o.stdout.is_empty())
}

/// Bytes a folder takes on disk, without following links.
pub fn size_of(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        total = total.saturating_add(on_disk(&meta));
        if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&p) {
                stack.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }
    total
}

#[cfg(unix)]
fn on_disk(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn on_disk(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

/// What a prune did.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Freed {
    pub bytes: u64,
    pub removed: usize,
    /// Regenerable by name, but kept: git tracks or doesn't ignore it.
    pub kept: usize,
    /// The agent had started working, so nothing (more) was removed.
    pub busy: bool,
}

/// Remove `home`'s regenerable folders untouched for `older_than`.
/// `busy` is asked before each removal: a turn that starts meanwhile stops it.
pub async fn prune(home: &Path, older_than: Duration, busy: impl Fn() -> bool) -> Freed {
    let mut freed = Freed::default();
    let Ok(home) = home.canonicalize() else {
        return freed;
    };
    let h = home.clone();
    let found = tokio::task::spawn_blocking(move || candidates(&h, older_than, SystemTime::now()))
        .await
        .unwrap_or_default();
    for dir in found {
        if busy() {
            freed.busy = true;
            break;
        }
        // Still a real folder inside the home, with nothing above it a link.
        let real = dir.canonicalize().ok();
        let is_dir = std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir());
        if real.as_deref() != Some(dir.as_path())
            || !is_dir
            || !dir.starts_with(&home)
            || dir == home
        {
            continue;
        }
        if !safe_in_git(&dir, &home).await {
            freed.kept += 1;
            continue;
        }
        let d = dir.clone();
        let result = tokio::task::spawn_blocking(move || {
            let bytes = size_of(&d);
            std::fs::remove_dir_all(&d).map(|_| bytes)
        })
        .await;
        match result {
            Ok(Ok(bytes)) => {
                freed.bytes += bytes;
                freed.removed += 1;
            }
            _ => tracing::info!("[Agents] couldn't remove {}", dir.display()),
        }
    }
    freed
}

static PRUNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// One prune per agent at a time; `None` when one is already running.
async fn prune_agent(agent_id: &str, older_than: Duration) -> Option<Freed> {
    let home = store::agent_home(agent_id).ok()?;
    if !PRUNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string())
    {
        return None;
    }
    let id = agent_id.to_string();
    let freed = prune(&home, older_than, || super::runner::is_working(&id)).await;
    PRUNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
    forget_sizes();
    Some(freed)
}

/// The agent went idle: prune its home's stale regenerable folders.
pub fn after_idle(agent_id: &str) {
    let id = agent_id.to_string();
    tauri::async_runtime::spawn(async move {
        let after = if level_now() == Level::Fine {
            PRUNE_AFTER
        } else {
            PRUNE_AFTER_LOW
        };
        if let Some(f) = prune_agent(&id, after).await.filter(|f| f.removed > 0) {
            tracing::info!(
                "[Agents] freed {} in {id}'s home ({} folders)",
                gb(f.bytes),
                f.removed
            );
        }
    });
}

/* --------------------------------------------------------- settings */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeSize {
    pub agent_id: String,
    pub name: String,
    pub bytes: u64,
    /// In folders named and placed as regenerable (what Free up space may remove).
    pub regenerable_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub free_bytes: Option<u64>,
    pub level: Level,
    pub low_bytes: u64,
    pub floor_bytes: u64,
    /// Homes of at least [`LARGE_BYTES`], largest first.
    pub homes: Vec<HomeSize>,
}

/// A home's size, and how much of it is regenerable.
pub fn measure(home: &Path) -> (u64, u64) {
    let regen: u64 = candidates(home, Duration::ZERO, SystemTime::now())
        .iter()
        .map(|d| size_of(d))
        .sum();
    (size_of(home), regen)
}

const SIZES_FRESH_FOR: Duration = Duration::from_secs(5 * 60);
static SIZES: Mutex<Option<(std::time::Instant, Vec<HomeSize>)>> = Mutex::new(None);

fn forget_sizes() {
    *SIZES.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Settings → Agents: free space, and every large agent home. Blocking.
pub fn overview() -> Overview {
    let cached = SIZES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(at, _)| at.elapsed() < SIZES_FRESH_FOR)
        .map(|(_, h)| h.clone());
    let homes = cached.unwrap_or_else(|| {
        let mut homes: Vec<HomeSize> = store::list()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|a| {
                let home = store::agent_home(&a.id).ok()?;
                let (bytes, regenerable_bytes) = measure(&home);
                (bytes >= LARGE_BYTES).then_some(HomeSize {
                    agent_id: a.id,
                    name: a.name,
                    bytes,
                    regenerable_bytes,
                })
            })
            .collect();
        homes.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        *SIZES.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((std::time::Instant::now(), homes.clone()));
        homes
    });
    let free_bytes = free_now();
    Overview {
        free_bytes,
        level: level_for(free_bytes),
        low_bytes: LOW_BYTES,
        floor_bytes: FLOOR_BYTES,
        homes,
    }
}

/// "Free up space": every regenerable folder in the agent's home, whatever
/// its age, unless the agent is working.
pub async fn free_up(agent_id: &str) -> Freed {
    if super::runner::is_working(agent_id) {
        return Freed {
            busy: true,
            ..Freed::default()
        };
    }
    prune_agent(agent_id, Duration::ZERO)
        .await
        .unwrap_or(Freed {
            busy: true,
            ..Freed::default()
        })
}

#[cfg(test)]
#[path = "disk_tests.rs"]
mod tests;
