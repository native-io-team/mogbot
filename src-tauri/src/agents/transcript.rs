//! Keeping an agent's engine conversation resumable, whatever happens to the
//! engine's own copy of it.
//!
//! Claude Code keeps a conversation at `<config>/projects/<cwd folder>/<id>.jsonl`
//! and `--resume <id>` looks for it under the folder of the directory it runs
//! in, in the config folder it runs with. Codex keeps
//! `<home>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`. Any of these can
//! leave a turn with no conversation to resume: the transcript deleted from
//! under us (observed on 2026-11-06: `~/.claude/projects` itself recreated
//! that morning, 62 "is gone" restarts that day, none of the 62 lost
//! transcripts anywhere on disk, no account switch and no change of folder),
//! another account's folder (`wallet`), or another working folder (a bound
//! agent's copy of its project, `task`).
//!
//! So after every turn the app keeps its own copy of the agent's current
//! transcript in the agent's home ([`back_up`]), and before a resume it puts
//! the most complete copy it has where the engine will look ([`ensure`]).
//! Transcripts only grow (a compaction appends its summary), so the longest
//! copy is the most complete one; the newest breaks a tie.

use std::path::{Path, PathBuf};

use super::engine::Engine;
use super::wallet::{self, copy_dir, copy_replacing, modified, valid_session};

/// The folder in an agent's home that holds its copy.
pub const DIR: &str = ".session";

/// Claude Code's name for a working directory's folder under `projects/`:
/// every character but an ASCII letter or digit becomes `-` (observed on
/// 2.1.319: `/Library/Application Support/X` files under
/// `-Library-Application-Support-X`). Longer names Claude Code shortens its
/// own way, which isn't guessed at: `None`.
pub fn claude_folder(cwd: &Path) -> Option<String> {
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let name: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    (!name.is_empty() && name.len() <= 200).then_some(name)
}

fn len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// The most complete of `found`: the longest, then the newest.
fn best(found: &[PathBuf]) -> Option<&PathBuf> {
    found.iter().max_by_key(|p| (len(p), modified(p)))
}

/// Every `<root>/projects/*/<session>.jsonl`.
fn claude_copies(roots: &[PathBuf], session: &str) -> Vec<PathBuf> {
    let name = format!("{session}.jsonl");
    let mut out = Vec::new();
    for root in roots {
        for dir in std::fs::read_dir(root.join("projects"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let file = dir.path().join(&name);
            if file.is_file() {
                out.push(file);
            }
        }
    }
    out
}

/// Every Codex rollout for `thread` under `<root>/sessions`, with its path
/// relative to `sessions`.
fn codex_copies(roots: &[PathBuf], thread: &str) -> Vec<(PathBuf, PathBuf)> {
    let suffix = format!("-{thread}.jsonl");
    let mut out = Vec::new();
    for root in roots {
        let sessions = root.join("sessions");
        let mut dirs = vec![(sessions.clone(), 0)];
        while let Some((dir, depth)) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() && depth < 4 {
                    dirs.push((path, depth + 1));
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                {
                    if let Ok(rel) = path.strip_prefix(&sessions) {
                        out.push((path.clone(), rel.to_path_buf()));
                    }
                }
            }
        }
    }
    out
}

/// Every file under `dir`, `depth` folders deep at most.
fn files_under(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() && depth > 0 {
            out.extend(files_under(&path, depth - 1));
        } else if path.is_file() {
            out.push(path);
        }
    }
    out
}

/// Before resuming `session` in `cwd` with the config folder `target`: put
/// the most complete copy among `roots` (every account folder of the
/// engine) and the agent's own copy in `home` where the engine looks for
/// it. True when one was copied there. Nothing found anywhere is not an
/// error: the engine then says it has no such session, and the runner
/// starts a new one with the recent conversation.
pub fn ensure_in(
    engine: Engine,
    roots: &[PathBuf],
    target: &Path,
    cwd: &Path,
    home: &Path,
    session: &str,
) -> std::io::Result<bool> {
    if !valid_session(session) {
        return Ok(false);
    }
    let own = home.join(DIR);
    match engine {
        // Its sessions are in its own database, which the app doesn't copy.
        Engine::OpenCode => Ok(false),
        Engine::Claude => {
            let Some(folder) = claude_folder(cwd) else {
                // A folder name not known: the account carry still applies.
                return wallet::carry_claude(roots, target, session);
            };
            let dest_dir = target.join("projects").join(folder);
            let dest = dest_dir.join(format!("{session}.jsonl"));
            let mut found = claude_copies(roots, session);
            let kept = own.join(format!("{session}.jsonl"));
            if kept.is_file() {
                found.push(kept);
            }
            let Some(source) = best(&found).cloned() else {
                return Ok(false);
            };
            if source == dest || (dest.is_file() && len(&dest) >= len(&source)) {
                return Ok(false);
            }
            super::store::ensure_private_dir(&dest_dir)?;
            copy_replacing(&source, &dest)?;
            // Sub-agent transcripts and saved tool output live beside it.
            if let Some(side) = source.parent().map(|p| p.join(session)) {
                let to = dest_dir.join(session);
                if side.is_dir() && side != to {
                    copy_dir(&side, &to)?;
                }
            }
            Ok(true)
        }
        Engine::Codex => {
            let mut found = codex_copies(roots, session);
            found.extend(codex_copies(&[own.join("codex")], session));
            let Some((source, rel)) = found
                .iter()
                .max_by_key(|(p, _)| (len(p), modified(p)))
                .cloned()
            else {
                return Ok(false);
            };
            let dest = target.join("sessions").join(&rel);
            if source == dest || (dest.is_file() && len(&dest) >= len(&source)) {
                return Ok(false);
            }
            // Codex finds a thread by its file anywhere under `sessions`: a
            // longer copy elsewhere in the target replaces nothing, so the
            // stale one there goes.
            for (path, _) in codex_copies(&[target.to_path_buf()], session) {
                if path != dest {
                    let _ = std::fs::remove_file(path);
                }
            }
            if let Some(dir) = dest.parent() {
                super::store::ensure_private_dir(dir)?;
            }
            copy_replacing(&source, &dest)?;
            Ok(true)
        }
    }
}

/// After a turn: keep the agent's own copy of `session` from `roots` in
/// `home`, and only that one (an earlier conversation's copy goes).
pub fn back_up_in(
    engine: Engine,
    roots: &[PathBuf],
    home: &Path,
    session: &str,
) -> std::io::Result<bool> {
    if !valid_session(session) {
        return Ok(false);
    }
    let own = home.join(DIR);
    match engine {
        // Its sessions are in its own database, which the app doesn't copy.
        Engine::OpenCode => Ok(false),
        Engine::Claude => {
            let found = claude_copies(roots, session);
            let Some(source) = best(&found) else {
                return Ok(false);
            };
            let name = format!("{session}.jsonl");
            let dest = own.join(&name);
            super::store::ensure_private_dir(&own)?;
            for entry in std::fs::read_dir(&own).into_iter().flatten().flatten() {
                if entry.file_name().to_string_lossy() != name && entry.path().is_file() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
            if dest.is_file() && len(&dest) == len(source) && modified(&dest) >= modified(source) {
                return Ok(false);
            }
            // Never replaced by a shorter copy (one the engine recreated
            // after its own was deleted): the longer one is the conversation.
            if len(&dest) > len(source) {
                return Ok(false);
            }
            copy_replacing(source, &dest)?;
            Ok(true)
        }
        Engine::Codex => {
            let found = codex_copies(roots, session);
            let Some((source, rel)) = found
                .iter()
                .max_by_key(|(p, _)| (len(p), modified(p)))
                .cloned()
            else {
                return Ok(false);
            };
            let base = own.join("codex");
            let dest = base.join("sessions").join(&rel);
            for path in files_under(&base.join("sessions"), 5) {
                if path != dest {
                    let _ = std::fs::remove_file(path);
                }
            }
            if len(&dest) > len(&source)
                || (dest.is_file()
                    && len(&dest) == len(&source)
                    && modified(&dest) >= modified(&source))
            {
                return Ok(false);
            }
            if let Some(dir) = dest.parent() {
                super::store::ensure_private_dir(dir)?;
            }
            copy_replacing(&source, &dest)?;
            Ok(true)
        }
    }
}

/// Whether the agent's own copy of `session` is in `home`.
pub fn kept_in(engine: Engine, home: &Path, session: &str) -> bool {
    if !valid_session(session) {
        return false;
    }
    let own = home.join(DIR);
    match engine {
        Engine::Claude => own.join(format!("{session}.jsonl")).is_file(),
        Engine::Codex => !codex_copies(&[own.join("codex")], session).is_empty(),
        Engine::OpenCode => false,
    }
}

/// Whether a turn can pick `session` up: the engine has it in one of its
/// account folders, or the app kept a copy it puts back first.
pub fn resumable(agent_id: &str, engine: Engine, session: &str) -> bool {
    wallet::session_on_disk(engine, session)
        || super::store::agent_home(agent_id).is_ok_and(|home| kept_in(engine, &home, session))
}

/// [`ensure_in`] for a turn on `account`.
pub fn ensure(account: &wallet::Account, cwd: &Path, home: &Path, session: &str) -> bool {
    let roots = wallet::engine_folders(account.engine);
    ensure_in(
        account.engine,
        &roots,
        &wallet::folder(account),
        cwd,
        home,
        session,
    )
    .unwrap_or_else(|e| {
        tracing::warn!("[Agents] couldn't put a conversation back where its engine looks: {e}");
        false
    })
}

/// [`back_up_in`] for a turn that ran on `account`.
pub fn back_up(account: &wallet::Account, home: &Path, session: &str) {
    let roots = vec![wallet::folder(account)];
    if let Err(e) = back_up_in(account.engine, &roots, home, session) {
        tracing::warn!("[Agents] couldn't keep a copy of a conversation: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "85100e7a-050c-4811-a26e-55203a85d28b";

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn claude_folder_names_follow_claude_code() {
        assert_eq!(
            claude_folder(Path::new(
                "/nowhere/Library/Application Support/Dash.bot/agents/a1"
            ))
            .as_deref(),
            Some("-nowhere-Library-Application-Support-Dash-bot-agents-a1")
        );
        assert_eq!(
            claude_folder(Path::new(&format!("/{}", "a".repeat(300)))),
            None
        );
    }

    #[test]
    fn a_deleted_claude_transcript_comes_back_from_the_agents_own_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, home, cwd) = (
            dir.path().join("mac"),
            dir.path().join("home"),
            dir.path().join("cwd"),
        );
        std::fs::create_dir_all(&cwd).unwrap();
        let folder = claude_folder(&cwd).unwrap();
        let live = mac
            .join("projects")
            .join(&folder)
            .join(format!("{SID}.jsonl"));
        write(&live, "one\ntwo\n");
        let roots = [mac.clone()];
        assert!(back_up_in(Engine::Claude, &roots, &home, SID).unwrap());
        // Nothing new: nothing copied again.
        assert!(!back_up_in(Engine::Claude, &roots, &home, SID).unwrap());

        // The engine's whole projects folder goes (as observed).
        std::fs::remove_dir_all(mac.join("projects")).unwrap();
        assert!(ensure_in(Engine::Claude, &roots, &mac, &cwd, &home, SID).unwrap());
        assert_eq!(std::fs::read_to_string(&live).unwrap(), "one\ntwo\n");
        // Already there: nothing to do.
        assert!(!ensure_in(Engine::Claude, &roots, &mac, &cwd, &home, SID).unwrap());
    }

    #[test]
    fn a_new_working_folder_gets_the_conversation_too() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, home) = (dir.path().join("mac"), dir.path().join("home"));
        let (first, copy) = (dir.path().join("project"), dir.path().join("copy-2"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&copy).unwrap();
        let old = mac
            .join("projects")
            .join(claude_folder(&first).unwrap())
            .join(format!("{SID}.jsonl"));
        write(&old, "a\nb\n");
        write(
            &old.parent().unwrap().join(SID).join("subagents/x.jsonl"),
            "x",
        );
        let roots = [mac.clone()];
        assert!(ensure_in(Engine::Claude, &roots, &mac, &copy, &home, SID).unwrap());
        let moved = mac.join("projects").join(claude_folder(&copy).unwrap());
        assert_eq!(
            std::fs::read_to_string(moved.join(format!("{SID}.jsonl"))).unwrap(),
            "a\nb\n"
        );
        assert!(moved.join(SID).join("subagents/x.jsonl").is_file());
    }

    #[test]
    fn another_account_folder_gets_the_longest_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, work, home, cwd) = (
            dir.path().join("mac"),
            dir.path().join("work"),
            dir.path().join("home"),
            dir.path().join("cwd"),
        );
        std::fs::create_dir_all(&cwd).unwrap();
        let folder = claude_folder(&cwd).unwrap();
        let at = |root: &Path| {
            root.join("projects")
                .join(&folder)
                .join(format!("{SID}.jsonl"))
        };
        write(&at(&mac), "a\nb\nc\n");
        // A shorter copy the engine recreated there doesn't win.
        write(&at(&work), "c\n");
        let roots = [mac.clone(), work.clone()];
        assert!(ensure_in(Engine::Claude, &roots, &work, &cwd, &home, SID).unwrap());
        assert_eq!(std::fs::read_to_string(at(&work)).unwrap(), "a\nb\nc\n");
        // The backup keeps the longer one, too.
        back_up_in(Engine::Claude, &[mac.clone()], &home, SID).unwrap();
        write(&at(&mac), "c\n");
        back_up_in(Engine::Claude, &[mac.clone()], &home, SID).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join(DIR).join(format!("{SID}.jsonl"))).unwrap(),
            "a\nb\nc\n"
        );
    }

    #[test]
    fn only_the_current_conversation_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, home) = (dir.path().join("mac"), dir.path().join("home"));
        let other = "00000000-1111-2222-3333-444444444444";
        write(
            &mac.join("projects/f").join(format!("{other}.jsonl")),
            "old",
        );
        write(&mac.join("projects/f").join(format!("{SID}.jsonl")), "new");
        let roots = [mac.clone()];
        back_up_in(Engine::Claude, &roots, &home, other).unwrap();
        back_up_in(Engine::Claude, &roots, &home, SID).unwrap();
        let kept: Vec<String> = std::fs::read_dir(home.join(DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept, vec![format!("{SID}.jsonl")]);
        // Nothing that isn't a session id is looked for.
        assert!(!back_up_in(Engine::Claude, &roots, &home, "../x").unwrap());
    }

    #[test]
    fn a_deleted_codex_rollout_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let (codex, home, cwd) = (
            dir.path().join("codex"),
            dir.path().join("home"),
            dir.path().join("cwd"),
        );
        let thread = "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b";
        let rel = format!("2026/11/06/rollout-2026-11-06T10-00-00-{thread}.jsonl");
        write(&codex.join("sessions").join(&rel), "r1\nr2\n");
        let roots = [codex.clone()];
        assert!(back_up_in(Engine::Codex, &roots, &home, thread).unwrap());
        assert!(kept_in(Engine::Codex, &home, thread));
        std::fs::remove_dir_all(codex.join("sessions")).unwrap();
        assert!(ensure_in(Engine::Codex, &roots, &codex, &cwd, &home, thread).unwrap());
        assert_eq!(
            std::fs::read_to_string(codex.join("sessions").join(&rel)).unwrap(),
            "r1\nr2\n"
        );
    }
}
