//! Dev servers an agent's turn started and left running.
//!
//! An agent previewing its work runs `npm run dev &` (or two, before and
//! after). When the turn ends those servers would run on, holding ports and
//! CPU, until the Mac restarts. So when a turn ends, what it left listening
//! is found and either stopped at once or kept while someone looks at it:
//!
//! - **Found by ancestry, never by guess.** A server counts as the turn's
//!   when it was seen under the turn's engine process while the turn ran, or
//!   is still in the engine's process group. A server the user started in a
//!   terminal, or the one the preview pane started, is never the turn's.
//! - **Kept while it's looked at.** A server is kept when the preview pane
//!   beside the chat shows its folder, a phone is watching it live, or the
//!   turn just showed it (a card naming its project, a link to its port), so
//!   the user has time to open it. It is stopped once nobody has looked at
//!   it for [`IDLE_MS`].
//! - **Stopped whole.** The server's own tree, from the top process that was
//!   the turn's, the same way a stopped turn's tree is (`procs`). Before a
//!   stop the process must still be the one recorded (pid and command), so a
//!   reused pid is never signalled.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use super::procs::{self, ProcRow};

/// A server nobody has looked at for this long is stopped.
pub const IDLE_MS: i64 = 10 * 60_000;
/// How often kept servers are looked at.
const SWEEP_SECS: u64 = 60;
/// A phone request this recent counts as watching.
const WATCHED_MS: i64 = 2 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Server {
    pub agent_id: String,
    /// The top process of the server's tree that was the turn's.
    pub root: u32,
    /// Its command line when found: a pid showing another is someone else's.
    pub command: String,
    pub port: u16,
    /// The listening process's working folder.
    pub cwd: String,
    pub last_watched: i64,
}

/// What a turn showed the user: ports it linked to, folders its card named.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shown {
    pub ports: HashSet<u16>,
    pub paths: Vec<String>,
}

#[derive(Default)]
struct State {
    /// Per agent: processes seen under its turn's engine, pid → command.
    seen: HashMap<String, HashMap<u32, String>>,
    shown: HashMap<String, Shown>,
    servers: Vec<Server>,
    /// Port → when a phone last asked it for something.
    watched: HashMap<u16, i64>,
    sweeping: bool,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A turn starts: nothing seen or shown yet.
pub fn begin(agent_id: &str) {
    let mut s = state();
    s.seen.remove(agent_id);
    s.shown.remove(agent_id);
}

/// Note what runs under the turn's engine right now.
pub fn note_tree(agent_id: &str, rows: &[ProcRow], engine_pid: u32) {
    let found: Vec<(u32, String)> = procs::descendants(rows, engine_pid)
        .into_iter()
        .filter(|r| !r.zombie)
        .map(|r| (r.pid, r.command.clone()))
        .collect();
    if found.is_empty() {
        return;
    }
    state()
        .seen
        .entry(agent_id.to_string())
        .or_default()
        .extend(found);
}

/// The turn linked the user to `port` (a reply's local link).
pub fn note_shown_port(agent_id: &str, port: u16) {
    state()
        .shown
        .entry(agent_id.to_string())
        .or_default()
        .ports
        .insert(port);
}

/// The turn's card named `path` (its project, or the agent's copy of it).
pub fn note_shown_path(agent_id: &str, path: &str) {
    state()
        .shown
        .entry(agent_id.to_string())
        .or_default()
        .paths
        .push(path.to_string());
}

/// A phone's Watch live asked `port` for a page.
pub fn note_watched(port: u16) {
    state().watched.insert(port, super::store::now_ms());
}

/// The folder a kept server on `port` runs in.
pub fn path_on(port: u16) -> Option<String> {
    state()
        .servers
        .iter()
        .find(|s| s.port == port)
        .map(|s| s.cwd.clone())
}

fn inside(cwd: &str, root: &str) -> bool {
    let (cwd, root) = (cwd.trim_end_matches('/'), root.trim_end_matches('/'));
    cwd == root || cwd.starts_with(&format!("{root}/"))
}

/// A kept server on `port` runs in `path` (Watch live checks this, as it does
/// a preview's own server).
pub fn serves(path: &str, port: u16) -> bool {
    state()
        .servers
        .iter()
        .any(|s| s.port == port && inside(&s.cwd, path))
}

/// Something is running from `dir` or around it: a kept server's folder is
/// inside it (or it inside that folder), or the preview pane shows it. Disk
/// tidying leaves such a folder's dependencies alone.
pub fn in_use(dir: &std::path::Path) -> bool {
    let dir = dir.to_string_lossy();
    let near = |p: &str| inside(p, &dir) || inside(&dir, p);
    state().servers.iter().any(|s| near(&s.cwd))
        || super::preview_test::pane_paths().iter().any(|p| near(p))
}

#[cfg(test)]
pub(crate) fn keep_for_test(server: Server) {
    state().servers.push(server);
}

#[cfg(test)]
pub(crate) fn forget_for_test(agent_id: &str) {
    state().servers.retain(|s| s.agent_id != agent_id);
}

// ============================================================================
// The rules, pure
// ============================================================================

/// Whether a server is being looked at now.
pub fn is_watched(server: &Server, pane_paths: &[String], phone_at: Option<i64>, now: i64) -> bool {
    pane_paths.iter().any(|p| inside(&server.cwd, p))
        || phone_at.is_some_and(|at| now - at < WATCHED_MS)
}

/// At the turn's end: keep a server the user is looking at or was just shown.
pub fn keep_at_turn_end(server: &Server, shown: &Shown, watched: bool) -> bool {
    watched
        || shown.ports.contains(&server.port)
        || shown.paths.iter().any(|p| inside(&server.cwd, p))
}

/// A kept server nobody has looked at for [`IDLE_MS`] is due to stop.
pub fn idle_due(last_watched: i64, now: i64) -> bool {
    now - last_watched >= IDLE_MS
}

/// `lsof -F pn` output: (pid, port) for each listening socket.
pub fn parse_listeners(raw: &str) -> Vec<(u32, u16)> {
    let mut out = Vec::new();
    let mut pid = None;
    for line in raw.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.trim().parse().ok();
        } else if let (Some(n), Some(pid)) = (line.strip_prefix('n'), pid) {
            let port = n.rsplit(':').next().and_then(|p| p.trim().parse().ok());
            if let Some(port) = port {
                if !out.contains(&(pid, port)) {
                    out.push((pid, port));
                }
            }
        }
    }
    out
}

/// `ps -o pid=,pgid=` output: pids whose group is `pgid`.
pub fn parse_group(raw: &str, pgid: u32) -> Vec<u32> {
    raw.lines()
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            let group: u32 = parts.next()?.parse().ok()?;
            (group == pgid && pid != pgid).then_some(pid)
        })
        .collect()
}

/// The top of `pid`'s chain that is still the turn's (`ours`).
pub fn root_of(rows: &[ProcRow], pid: u32, ours: &HashSet<u32>) -> u32 {
    let mut at = pid;
    let mut guard = 0;
    while let Some(row) = rows.iter().find(|r| r.pid == at) {
        if !ours.contains(&row.ppid) || guard > 64 {
            break;
        }
        at = row.ppid;
        guard += 1;
    }
    at
}

// ============================================================================
// At a turn's end
// ============================================================================

#[cfg(unix)]
async fn group_members(pgid: u32) -> Vec<u32> {
    let mut cmd = tokio::process::Command::new("ps");
    cmd.args(["-axo", "pid=,pgid="]);
    match crate::external_command::run_with_timeout(cmd, "ps groups", 5).await {
        Ok(out) => parse_group(&String::from_utf8_lossy(&out.stdout), pgid),
        Err(_) => Vec::new(),
    }
}

#[cfg(unix)]
async fn listening(pids: &[u32]) -> Vec<(u32, u16)> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut cmd = tokio::process::Command::new("lsof");
    cmd.args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", &list, "-Fpn"]);
    // lsof exits 1 when nothing matched; its output is still what it found.
    match crate::external_command::run_with_timeout(cmd, "lsof listeners", 5).await {
        Ok(out) => parse_listeners(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => Vec::new(),
    }
}

/// The turn ended normally: find what it left listening, and stop what
/// nobody is looking at. Returns the roots of the servers kept, which a
/// caller about to stop the engine's tree must spare. (A stopped turn's
/// whole tree is already gone.)
#[cfg(unix)]
pub async fn turn_ended(agent_id: &str, engine_pid: Option<u32>) -> Vec<u32> {
    let (seen, shown) = {
        let mut s = state();
        (
            s.seen.remove(agent_id).unwrap_or_default(),
            s.shown.remove(agent_id).unwrap_or_default(),
        )
    };
    let Some(rows) = tokio::task::spawn_blocking(procs::snapshot)
        .await
        .ok()
        .flatten()
    else {
        return Vec::new();
    };
    // Still the same process (pid and command) as when it was seen.
    let mut ours: HashSet<u32> = seen
        .iter()
        .filter(|(pid, cmd)| rows.iter().any(|r| r.pid == **pid && &r.command == *cmd))
        .map(|(pid, _)| *pid)
        .collect();
    if let Some(pgid) = engine_pid {
        ours.extend(group_members(pgid).await);
    }
    // Their children too (a server forked after the last look).
    let roots: Vec<u32> = ours.iter().copied().collect();
    for root in roots {
        ours.extend(procs::descendants(&rows, root).iter().map(|r| r.pid));
    }
    let pids: Vec<u32> = ours.iter().copied().collect();
    let found = listening(&pids).await;
    if found.is_empty() {
        return Vec::new();
    }
    let now = super::store::now_ms();
    let panes = super::preview_test::pane_paths();
    let mut stop_now = Vec::new();
    let mut kept = Vec::new();
    for (pid, port) in found {
        let Some(cwd) = super::local_links::cwd_of(pid).await else {
            continue;
        };
        let root = root_of(&rows, pid, &ours);
        let command = rows
            .iter()
            .find(|r| r.pid == root)
            .map(|r| r.command.clone())
            .unwrap_or_default();
        let server = Server {
            agent_id: agent_id.to_string(),
            root,
            command,
            port,
            cwd,
            last_watched: now,
        };
        let phone = state().watched.get(&port).copied();
        let watched = is_watched(&server, &panes, phone, now);
        if keep_at_turn_end(&server, &shown, watched) {
            tracing::info!(
                "[Agents] {agent_id} left a dev server on port {port}; kept while it's looked at"
            );
            kept.push(server.root);
            let mut s = state();
            s.servers.retain(|k| k.port != port);
            s.servers.push(server);
        } else {
            stop_now.push(server);
        }
    }
    for server in stop_now {
        tracing::info!(
            "[Agents] Stopping the dev server {} left on port {}",
            server.agent_id,
            server.port
        );
        // Under a live engine, its tree stop takes these with it.
        if engine_pid.is_none_or(|e| {
            !procs::descendants(&rows, e)
                .iter()
                .any(|r| r.pid == server.root)
        }) {
            stop(server).await;
        }
    }
    sweep_soon();
    kept
}

#[cfg(not(unix))]
pub async fn turn_ended(_agent_id: &str, _engine_pid: Option<u32>) -> Vec<u32> {
    Vec::new()
}

/// Stop a server's tree, if its root is still the process recorded.
async fn stop(server: Server) {
    let _ = tokio::task::spawn_blocking(move || {
        let same = procs::snapshot().is_some_and(|rows| {
            rows.iter()
                .any(|r| r.pid == server.root && r.command == server.command)
        });
        if same {
            procs::kill_tree_sync(server.root);
        }
    })
    .await;
}

/// Start the sweep that stops idle servers, once.
fn sweep_soon() {
    {
        let mut s = state();
        if s.sweeping || s.servers.is_empty() {
            return;
        }
        s.sweeping = true;
    }
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SWEEP_SECS)).await;
            let rows = tokio::task::spawn_blocking(procs::snapshot)
                .await
                .ok()
                .flatten();
            let now = super::store::now_ms();
            let panes = super::preview_test::pane_paths();
            let due: Vec<Server> = {
                let mut s = state();
                let watched = s.watched.clone();
                let mut due = Vec::new();
                s.servers.retain_mut(|server| {
                    let alive = rows.as_ref().is_none_or(|rows| {
                        rows.iter()
                            .any(|r| r.pid == server.root && r.command == server.command)
                    });
                    if !alive {
                        return false;
                    }
                    if is_watched(server, &panes, watched.get(&server.port).copied(), now) {
                        server.last_watched = now;
                    }
                    if idle_due(server.last_watched, now) {
                        due.push(server.clone());
                        return false;
                    }
                    true
                });
                if s.servers.is_empty() {
                    s.sweeping = false;
                }
                due
            };
            for server in due {
                tracing::info!(
                    "[Agents] Stopping the idle dev server {} left on port {}",
                    server.agent_id,
                    server.port
                );
                stop(server).await;
            }
            if !state().sweeping {
                break;
            }
        }
    });
}

/// The app is quitting: every kept server goes with it. Blocking.
pub fn stop_all_sync() {
    let servers: Vec<Server> = std::mem::take(&mut state().servers);
    for server in servers {
        procs::kill_tree_sync(server.root);
    }
}

#[cfg(test)]
#[path = "dev_servers_tests.rs"]
mod tests;
