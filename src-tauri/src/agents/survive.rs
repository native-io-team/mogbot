//! Keeping the app's long-running loops and saved files alive through faults.
//!
//! **Loops.** The routine, "When…", Slack, usage and workflow loops each run
//! for the life of the app in one task. A panic inside one tick used to end
//! that task, and with it the loop: routines stopped firing with nothing said
//! anywhere. [`tick`] / [`tick_blocking`] run one tick under `catch_unwind`;
//! a panic is logged, the loop goes on to its next tick, and the Chief's chat
//! gets one quiet line (at most once per [`SAY_AGAIN_MS`] per loop).
//!
//! **Saved files.** A settings file that isn't JSON any more (a crash or a
//! full disk mid-write, a bad hand edit) used to read as "nothing saved", and
//! the next change wrote the empty default over it: the user's accounts or
//! Slack set-up gone for good. [`read_kept`] sets the damaged file aside
//! (`<name>.corrupt-<ms>`) before the default is used, and says so in the
//! Chief's chat.
//!
//! Lines are queued here and posted by [`flush`], which the loops call each
//! tick: a file can be found damaged long before there's an app handle (or a
//! Chief) to tell.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use futures_util::FutureExt;
use serde::de::DeserializeOwned;
use tauri::AppHandle;

use super::store;

/// How long before the same loop's fault is mentioned again.
pub const SAY_AGAIN_MS: i64 = 6 * 60 * 60 * 1000;

/// Lines waiting for the Chief's chat.
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// When each loop's fault was last mentioned.
static SAID: LazyLock<Mutex<HashMap<&'static str, i64>>> = LazyLock::new(Default::default);

/// What a panic said, for the log.
pub fn panic_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic with no message".to_string())
}

/// Queue a line for the Chief's chat.
pub fn say(line: impl Into<String>) {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(line.into());
}

/// The lines waiting, taken (tests and [`flush`]).
pub fn take_pending() -> Vec<String> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Post what's waiting into the Chief's chat. With no Chief yet (the
/// registry itself unreadable), the lines wait for the next flush.
pub fn flush(app: &AppHandle) {
    let lines = take_pending();
    if lines.is_empty() {
        return;
    }
    let chief = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main));
    let Some(chief) = chief else {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        let later = std::mem::take(&mut *pending);
        *pending = lines;
        pending.extend(later);
        return;
    };
    for line in lines {
        let message = super::runner::new_message(&chief.id, store::MessageKind::Note, line);
        if let Err(e) = super::runner::record(app, message) {
            tracing::warn!("[Agents] couldn't post a line to the Chief: {e}");
        }
    }
}

/// The user-facing name of a loop.
fn loop_words(name: &'static str) -> &'static str {
    match name {
        "schedule" => "Routines",
        "watch" => "\"When…\" routines",
        "slack" => "Slack",
        "usage_read" => "Reading your plans' usage",
        "workflows" => "Workflows",
        _ => "A background check",
    }
}

/// A loop's tick panicked: log it and, unless said recently, queue a line.
fn fault(name: &'static str, payload: &(dyn Any + Send), now: i64) {
    let text = panic_text(payload);
    tracing::error!("[Agents] the {name} loop panicked ({text}); carrying on at its next tick");
    let mut said = SAID.lock().unwrap_or_else(|e| e.into_inner());
    if said.get(name).is_some_and(|&at| now - at < SAY_AGAIN_MS) {
        return;
    }
    said.insert(name, now);
    drop(said);
    say(format!(
        "{} hit a fault and started again. If it keeps happening, the app's log has the detail.",
        loop_words(name)
    ));
}

/// Run one tick of a loop; a panic is caught, logged and mentioned, and
/// `None` comes back so the loop goes on.
pub async fn tick<F: Future>(name: &'static str, fut: F) -> Option<F::Output> {
    match std::panic::AssertUnwindSafe(fut).catch_unwind().await {
        Ok(out) => Some(out),
        Err(payload) => {
            fault(name, payload.as_ref(), store::now_ms());
            None
        }
    }
}

/// [`tick`] for a synchronous tick.
pub fn tick_blocking<T>(name: &'static str, f: impl FnOnce() -> T) -> Option<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(out) => Some(out),
        Err(payload) => {
            fault(name, payload.as_ref(), store::now_ms());
            None
        }
    }
}

/* ------------------------------------------------------- saved files */

/// Where a damaged `path` is set aside.
fn aside_path(path: &Path, now: i64) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    path.with_file_name(format!("{name}.corrupt-{now}"))
}

/// Read a saved JSON file. Missing or unreadable from disk: `None` (an I/O
/// error leaves the file where it is). Not readable as `T`: the file is set
/// aside as `<name>.corrupt-<ms>` before `None` comes back, so whatever is
/// written next can't overwrite it, and the Chief's chat is told, naming
/// `what` ("Your accounts list").
pub fn read_kept<T: DeserializeOwned>(path: &Path, what: &str) -> Option<T> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!("[Agents] {} unreadable ({e})", path.display());
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(e) => {
            set_aside_if_still(path, &bytes, what, &e.to_string());
            None
        }
    }
}

/// [`set_aside`], only while `path` still holds the `damaged` bytes read.
///
/// Two readers of one damaged file (most of these files are read without a
/// lock) used to race: the first set it aside, the default was written
/// back in its place, and the second, still holding the damaged bytes it
/// had read, then moved that *good* new file aside too; or, the file being
/// gone already, said "couldn't be read" a second time. Whoever finds the
/// file no longer the damaged one leaves it, and says nothing.
fn set_aside_if_still(path: &Path, damaged: &[u8], what: &str, why: &str) {
    // One check-and-move at a time in this process.
    static ONE: Mutex<()> = Mutex::new(());
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    match std::fs::read(path) {
        Ok(now) if now == damaged => set_aside(path, what, why),
        _ => {}
    }
}

/// Move a damaged file aside and say so.
pub fn set_aside(path: &Path, what: &str, why: &str) {
    let aside = aside_path(path, store::now_ms());
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    match std::fs::rename(path, &aside) {
        Ok(()) => {
            tracing::error!(
                "[Agents] {} unreadable ({why}); kept aside at {}",
                path.display(),
                aside.display()
            );
            let kept = aside
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            say(format!(
                "{what} couldn't be read, so it starts fresh. The damaged copy is kept beside it as {kept}."
            ));
        }
        // Already gone: whoever moved it said so.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            // Not moved: nothing was lost, but the next write will replace it.
            tracing::error!("[Agents] {file} unreadable ({why}) and couldn't be set aside ({e})");
            say(format!("{what} couldn't be read, so it starts fresh."));
        }
    }
}

#[cfg(test)]
#[path = "survive_tests.rs"]
mod tests;
