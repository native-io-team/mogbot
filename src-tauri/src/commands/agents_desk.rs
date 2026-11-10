//! Desk-only views for people who want to see under the hood: a step's exact
//! command, what a turn was told, every routine at once, and the logs.
//!
//! None of these is reachable from the phone or Remote Access: the companion
//! server and the MCP servers call `agents::*` directly and expose none of
//! them, and what they return (an exact command, a briefing) is redacted
//! before it is kept and again as it is read.

use tauri::{AppHandle, Emitter};

use crate::agents::{self, briefing, routines_bulk, store, work};
use crate::errors::CommandError;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(agents::err_other)?
}

/// The exact command (or tool input) behind one step of a kept timeline,
/// redacted and scrubbed. `step` is its index among all the turn's steps.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_step_exact(
    agent_id: String,
    message_id: String,
    step: u32,
) -> Result<Option<String>, CommandError> {
    blocking(move || {
        store::agent_home(&agent_id)?;
        Ok(work::detail::step_exact(&agent_id, &message_id, step))
    })
    .await
}

/// What a turn was told: the briefing kept for the turn that ended on
/// `message_id`, or, without one, the newest any turn was given.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_turn_briefing(
    agent_id: String,
    message_id: Option<String>,
) -> Result<Option<briefing::Briefing>, CommandError> {
    blocking(move || {
        store::agent_home(&agent_id)?;
        Ok(match message_id {
            Some(id) => work::detail::briefing_of(&agent_id, &id)
                .and_then(|key| briefing::read(&agent_id, &key)),
            None => briefing::latest(&agent_id),
        })
    })
    .await
}

/// Pause every running routine on every agent ("Pause all routines").
/// Returns how many it paused.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_routines_pause_all(app: AppHandle) -> Result<usize, CommandError> {
    let n = blocking(|| Ok(routines_bulk::pause_all())).await?;
    let _ = app.emit(agents::runner::EVENT_REGISTRY, ());
    Ok(n)
}

/// Resume only the routines "Pause all routines" paused: never one the user
/// paused by hand, an admin paused, or an import paused for review.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_routines_resume_all(app: AppHandle) -> Result<usize, CommandError> {
    let n = blocking(|| Ok(routines_bulk::resume_all())).await?;
    let _ = app.emit(agents::runner::EVENT_REGISTRY, ());
    Ok(n)
}

/// Open the app's log folder in Finder ("Open logs").
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_logs() -> Result<String, CommandError> {
    let dir = crate::brand::logs_dir();
    std::fs::create_dir_all(&dir).map_err(agents::err_other)?;
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let opener = "xdg-open";
    crate::utils::create_command(opener)
        .arg(&dir)
        .spawn()
        .map_err(agents::err_other)?;
    Ok(dir.to_string_lossy().to_string())
}
