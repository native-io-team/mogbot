//! Cross-process claims on a scheduled slot.
//!
//! The scheduler's state is shared with Ship Studio (see `state.rs`), but
//! `last_run_at` is only written when a run ends. Two schedulers looking at
//! the same due slot during that window would both start it. A claim closes
//! the window: before a scheduled run starts, the scheduler atomically creates
//! `workflow-claims/<workflow>-<slot>.claim` next to the state file
//! (`O_CREAT | O_EXCL`), and whoever loses the create leaves that slot alone.
//!
//! A slot is the moment the trigger became due (`due_at`), which both apps
//! compute identically from the shared `last_run_at` and the workflow file's
//! mtime, so the same occurrence gets the same name in both.
//!
//! Claims are not removed when the run ends: by then `last_run_at` has moved
//! and the slot is no longer due, and keeping the file means a scheduler that
//! read the state a moment before the write still loses the claim. A claim
//! older than [`STALE_AFTER_MS`] belongs to a run that crashed or was killed
//! with its app, and may be taken over; claims older than [`PRUNE_AFTER_MS`]
//! are swept.
//!
//! Ship Studio doesn't create or honour claims. Between it and this app the
//! shared `last_run_at` is what prevents a double run, which leaves a residual
//! race: a slot Ship Studio is running can still be started here before its run
//! finishes and records itself.

use crate::errors::CommandError;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// How long a claim stands before someone else may take the slot. Comfortably
/// past a run's own timeout (`RUN_TIMEOUT_SECS`, ten minutes), so a live run
/// is never second-guessed.
pub const STALE_AFTER_MS: i64 = 30 * 60_000;

/// Claims older than this are deleted on the next sweep.
pub const PRUNE_AFTER_MS: i64 = 7 * 86_400_000;

/// Where claims live: beside the shared state file.
fn claims_dir() -> Result<PathBuf, CommandError> {
    let state = super::state_path()?;
    let parent = state
        .parent()
        .ok_or_else(|| CommandError::expected("The workflows state file has no folder"))?;
    Ok(parent.join("workflow-claims"))
}

/// The claim file's name for one occurrence of one workflow. The workflow id
/// is a project path plus a slug, so it is hashed into something a filesystem
/// accepts.
fn claim_file_name(workflow_id: &str, slot_ms: i64) -> String {
    let digest = Sha256::digest(workflow_id.as_bytes());
    format!("{}-{slot_ms}.claim", &hex::encode(digest)[..16])
}

/// Try to take the slot. `Ok(true)` means it is ours to run.
pub fn try_claim(workflow_id: &str, slot_ms: i64, now: i64) -> Result<bool, CommandError> {
    try_claim_in(&claims_dir()?, workflow_id, slot_ms, now)
}

fn try_claim_in(
    dir: &Path,
    workflow_id: &str,
    slot_ms: i64,
    now: i64,
) -> Result<bool, CommandError> {
    std::fs::create_dir_all(dir).map_err(|e| {
        crate::utils::classify_fs_error("create the workflow claims folder", dir, &e)
    })?;
    let path = dir.join(claim_file_name(workflow_id, slot_ms));

    if create_claim(&path, workflow_id, now)? {
        return Ok(true);
    }
    // Someone holds it. Take it over only if it has gone stale, and only
    // through another exclusive create, so two schedulers both seeing it stale
    // can't both win.
    if !is_stale(&path, now) {
        return Ok(false);
    }
    tracing::warn!(path = %path.display(), "taking over a stale workflow claim");
    let _ = std::fs::remove_file(&path);
    create_claim(&path, workflow_id, now)
}

fn create_claim(path: &Path, workflow_id: &str, now: i64) -> Result<bool, CommandError> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            let body = serde_json::json!({
                "workflowId": workflow_id,
                "claimedAt": now,
                "app": crate::brand::SLUG,
                "pid": std::process::id(),
            });
            let _ = file.write_all(body.to_string().as_bytes());
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(crate::utils::classify_fs_error(
            "claim a scheduled workflow run",
            path,
            &e,
        )),
    }
}

/// The time a claim was made: what it says, falling back to its mtime when
/// the body is unreadable (a crash between create and write).
fn claimed_at(path: &Path) -> Option<i64> {
    let from_body = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("claimedAt").and_then(|t| t.as_i64()));
    from_body.or_else(|| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
    })
}

fn is_stale(path: &Path, now: i64) -> bool {
    // A claim whose age can't be read at all is treated as stale: one that
    // could never expire would block that slot forever.
    claimed_at(path).is_none_or(|at| now - at > STALE_AFTER_MS)
}

/// Delete claims old enough that their slots can't be due again.
pub fn prune(now: i64) {
    let Ok(dir) = claims_dir() else { return };
    prune_in(&dir, now);
}

fn prune_in(dir: &Path, now: i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("claim") {
            continue;
        }
        if claimed_at(&path).is_none_or(|at| now - at > PRUNE_AFTER_MS) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_claimant_wins_a_slot() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000;
        assert!(try_claim_in(dir.path(), "/p::audit", 42, now).unwrap());
        assert!(!try_claim_in(dir.path(), "/p::audit", 42, now + 1_000).unwrap());
    }

    #[test]
    fn a_different_slot_or_workflow_is_a_different_claim() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000;
        assert!(try_claim_in(dir.path(), "/p::audit", 42, now).unwrap());
        assert!(try_claim_in(dir.path(), "/p::audit", 43, now).unwrap());
        assert!(try_claim_in(dir.path(), "/p::other", 42, now).unwrap());
    }

    #[test]
    fn a_stale_claim_can_be_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000;
        assert!(try_claim_in(dir.path(), "/p::audit", 42, now).unwrap());
        let later = now + STALE_AFTER_MS + 1;
        assert!(try_claim_in(dir.path(), "/p::audit", 42, later).unwrap());
        // And the takeover is itself a claim.
        assert!(!try_claim_in(dir.path(), "/p::audit", 42, later + 1).unwrap());
    }

    #[test]
    fn prune_removes_only_old_claims() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000;
        assert!(try_claim_in(dir.path(), "/p::old", 1, now - PRUNE_AFTER_MS - 1).unwrap());
        assert!(try_claim_in(dir.path(), "/p::new", 2, now).unwrap());
        prune_in(dir.path(), now);
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(left.len(), 1);
        assert!(left[0].file_name().to_string_lossy().ends_with("-2.claim"));
    }
}
