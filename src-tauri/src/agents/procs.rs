//! A turn's whole process tree: `claude` and everything it started.
//!
//! Killing only `claude` leaves what its Bash tool ran (`npm run dev`, a test
//! watcher, a long build) running as an orphan that holds its port and CPU.
//! So a turn's `claude` leads its own process group, and stopping a turn
//! signals that group *and* every descendant found by walking the tree first:
//! a child that called `setsid` (a backgrounded shell often does) has left the
//! group but is still a descendant until its parent dies, which is why the
//! walk comes before any signal.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Turns in flight: agent id → its `claude` pid (also its process group).
static LIVE: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long a tree gets to exit on SIGTERM before SIGKILL.
const GRACE: Duration = Duration::from_millis(1500);

/// Make a spawned `claude` the leader of a new process group.
pub fn own_group(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(not(unix))]
    let _ = cmd;
}

pub fn register(agent_id: &str, pid: u32) {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), pid);
}

pub fn unregister(agent_id: &str) {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

/// Every turn's tree, stopped. For the app's exit, which can't wait on tokio.
/// Returns how many turns were running.
pub fn kill_all_sync() -> usize {
    let pids: Vec<u32> = LIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .map(|(_, pid)| pid)
        .collect();
    let mut trees: Vec<u32> = Vec::new();
    for pid in &pids {
        trees.extend(tree(*pid));
    }
    signal_all(&pids, &trees);
    pids.len()
}

/// Stop one tree: SIGTERM, then SIGKILL whatever is left after a grace period.
/// Blocking (it waits); call it from `spawn_blocking`.
pub fn kill_tree_sync(root: u32) {
    let members = tree(root);
    signal_all(&[root], &members);
}

/// Stop one tree except the subtrees under `spare` (dev servers someone is
/// looking at, `dev_servers`). The group isn't signalled, since the spared
/// processes are still in it: everything else is signalled by pid.
/// Blocking; call it from `spawn_blocking`.
pub fn kill_tree_sparing_sync(root: u32, spare: &[u32]) {
    if spare.is_empty() {
        return kill_tree_sync(root);
    }
    let spared: HashSet<u32> = spare.iter().flat_map(|s| tree(*s)).collect();
    let members: Vec<u32> = tree(root)
        .into_iter()
        .filter(|pid| *pid != root && !spared.contains(pid))
        .collect();
    send(&[], &members, Signal::Term);
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline && members.iter().any(|pid| alive(*pid)) {
        std::thread::sleep(Duration::from_millis(50));
    }
    let left: Vec<u32> = members.into_iter().filter(|pid| alive(*pid)).collect();
    send(&[], &left, Signal::Kill);
    kill_one(root, Signal::Kill);
}

fn signal_all(groups: &[u32], members: &[u32]) {
    send(groups, members, Signal::Term);
    // A group leader is our own child: it stays a zombie until tokio reaps
    // it, so only the rest of the tree is watched.
    let watched: Vec<u32> = members
        .iter()
        .copied()
        .filter(|pid| !groups.contains(pid))
        .collect();
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline && watched.iter().any(|pid| alive(*pid)) {
        std::thread::sleep(Duration::from_millis(50));
    }
    // Then SIGKILL for whatever is left, and always for the leaders: Claude
    // Code doesn't reliably exit on SIGTERM (observed: still running, its
    // children already gone), and a leader's liveness can't be read here.
    // By pid too, for a leader that never got its own group (a turn left
    // over from a build before groups).
    let left: Vec<u32> = watched.into_iter().filter(|pid| alive(*pid)).collect();
    send(groups, &left, Signal::Kill);
    for leader in groups {
        kill_one(*leader, Signal::Kill);
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn send(groups: &[u32], members: &[u32], signal: Signal) {
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    for group in groups {
        // SAFETY: plain syscalls on pids we spawned (or their descendants);
        // a stale pid only yields ESRCH.
        unsafe { libc::killpg(*group as libc::pid_t, sig) };
    }
    for pid in members {
        unsafe { libc::kill(*pid as libc::pid_t, sig) };
    }
}

#[cfg(not(unix))]
fn send(_groups: &[u32], members: &[u32], _signal: Signal) {
    for pid in members {
        let mut cmd = crate::utils::create_command("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        let _ = cmd.spawn().and_then(|mut c| c.wait());
    }
}

#[cfg(unix)]
fn kill_one(pid: u32, signal: Signal) {
    send(&[], &[pid], signal);
}

#[cfg(not(unix))]
fn kill_one(_pid: u32, _signal: Signal) {}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

/// `root` and all its descendants, from one `ps` snapshot.
pub fn tree(root: u32) -> Vec<u32> {
    let mut members = vec![root];
    let Some(table) = process_table() else {
        return members;
    };
    let mut seen: HashSet<u32> = members.iter().copied().collect();
    let mut i = 0;
    while i < members.len() {
        let parent = members[i];
        for (pid, ppid) in &table {
            if *ppid == parent && seen.insert(*pid) {
                members.push(*pid);
            }
        }
        i += 1;
    }
    members
}

/// (pid, ppid) for every process.
#[cfg(unix)]
fn process_table() -> Option<Vec<(u32, u32)>> {
    let mut ps = crate::utils::create_command("ps");
    ps.args(["-axo", "pid=,ppid="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Sync on purpose: this runs at exit, where there is no runtime to await on.
    #[allow(clippy::disallowed_methods)]
    let out = ps.output().ok()?;
    Some(parse_table(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(unix))]
fn process_table() -> Option<Vec<(u32, u32)>> {
    None
}

fn parse_table(raw: &str) -> Vec<(u32, u32)> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect()
}

/// The engine process running this agent's turn, if one is.
pub fn pid_of(agent_id: &str) -> Option<u32> {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .copied()
}

/// One process, as `ps` shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    /// Percent of one core (`ps`'s recent average).
    pub cpu: f32,
    /// Exited, not yet reaped.
    pub zombie: bool,
    /// Its command line. Matched against, never shown or kept.
    pub command: String,
}

/// Every process, from one `ps` snapshot. Blocking; call it from
/// `spawn_blocking`.
#[cfg(unix)]
pub fn snapshot() -> Option<Vec<ProcRow>> {
    let mut ps = crate::utils::create_command("ps");
    ps.args(["-axww", "-o", "pid=,ppid=,pcpu=,stat=,command="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[allow(clippy::disallowed_methods)]
    let out = ps.output().ok()?;
    Some(parse_rows(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(unix))]
pub fn snapshot() -> Option<Vec<ProcRow>> {
    None
}

pub fn parse_rows(raw: &str) -> Vec<ProcRow> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let cpu = parts.next()?.replace(',', ".").parse().ok()?;
            let stat = parts.next()?;
            let command = parts.collect::<Vec<_>>().join(" ");
            Some(ProcRow {
                pid,
                ppid,
                cpu,
                zombie: stat.contains('Z'),
                command,
            })
        })
        .collect()
}

/// Everything under `root` in a snapshot, not `root` itself.
pub fn descendants(rows: &[ProcRow], root: u32) -> Vec<&ProcRow> {
    let mut out: Vec<&ProcRow> = Vec::new();
    let mut parents = vec![root];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    while let Some(parent) = parents.pop() {
        for row in rows.iter().filter(|r| r.ppid == parent) {
            if seen.insert(row.pid) {
                out.push(row);
                parents.push(row.pid);
            }
        }
    }
    out
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_rows_with_cpu_state_and_command() {
        let rows = parse_rows(
            "  10  1  0.0 Ss  claude --print
  11 10 87.5 R+ /bin/zsh -c npm test
 12 11 0,0 Z (node)
bad
",
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].cpu, 87.5);
        assert_eq!(rows[1].command, "/bin/zsh -c npm test");
        assert!(rows[2].zombie && !rows[1].zombie);
        let under: Vec<u32> = descendants(&rows, 10).iter().map(|r| r.pid).collect();
        assert_eq!(under, [11, 12]);
    }

    #[test]
    fn parses_ps_output() {
        assert_eq!(
            parse_table("  1     0\n 42  1\nbad line\n"),
            vec![(1, 0), (42, 1)]
        );
    }

    #[test]
    fn kills_a_backgrounded_grandchild_too() {
        // sh → (setsid-like) background sleep; the sleep must die with the tree.
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sleep 300 & echo $!; wait"])
            .stdout(std::process::Stdio::piped());
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd.spawn().unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.take().unwrap()),
            &mut line,
        )
        .unwrap();
        let sleeper: u32 = line.trim().parse().unwrap();
        assert!(alive(sleeper));
        kill_tree_sync(child.id());
        let _ = child.wait();
        // Reaped by init/launchd shortly after it dies.
        let deadline = Instant::now() + Duration::from_secs(3);
        while alive(sleeper) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(sleeper), "the grandchild outlived Stop");
    }
}
