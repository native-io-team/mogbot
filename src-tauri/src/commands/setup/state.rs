//! # App State Persistence
//!
//! Functions for reading/writing the persisted AppState (setup_complete, default_agent, etc.)

use super::{
    is_force_onboarding_mode, is_mock_mode, read_app_state, update_app_state,
    FORCE_ONBOARDING_COMPLETED,
};
use crate::errors::CommandError;
use std::time::{SystemTime, UNIX_EPOCH};

/// Get the app state file path
pub(crate) fn get_app_state_path() -> std::path::PathBuf {
    crate::brand::app_support_dir().join("app_state.json")
}

/// Mark setup as complete (persists to disk)
#[tauri::command]
#[tracing::instrument]
pub async fn mark_setup_complete() -> Result<(), CommandError> {
    // Force onboarding / mock mode: don't persist to disk
    if is_force_onboarding_mode() {
        if let Ok(mut completed) = FORCE_ONBOARDING_COMPLETED.lock() {
            *completed = true;
        }
        tracing::info!("Force onboarding mode: skipping setup complete persistence");
        return Ok(());
    }
    if is_mock_mode() {
        tracing::info!("Mock mode: skipping setup complete persistence");
        return Ok(());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Read existing state to preserve other fields (e.g., compact_mode)
    update_app_state(|state| {
        state.setup_complete = true;
        state.setup_completed_at = Some(timestamp);
    })?;
    tracing::info!("Setup marked as complete");
    Ok(())
}

/// Directory the guided onboarding agent runs in: the projects root
/// (~/ShipStudio by default), created if missing — NOT the user's home.
/// An agent scanning $HOME trips macOS TCC permission prompts (Photos,
/// Desktop, Documents) attributed to Ship Studio, and the pending dialog
/// freezes the scan mid-syscall, which reads as "the agent is stuck"
/// (found in fresh-VM testing).
#[tauri::command]
#[tracing::instrument]
pub async fn ensure_agent_workdir() -> Result<String, CommandError> {
    match crate::utils::projects_root() {
        Ok(root) => match std::fs::create_dir_all(&root) {
            Ok(()) => return Ok(root.to_string_lossy().to_string()),
            Err(e) => tracing::warn!("Failed to create {}: {e}", root.display()),
        },
        Err(e) => tracing::warn!("Failed to resolve projects root: {e}"),
    }
    // Never fall through to $HOME: the agent scanning the home folder trips
    // macOS TCC permission prompts (Photos/Desktop/Documents) that freeze the
    // scanning syscall. The OS temp dir is outside every protected folder.
    Ok(std::env::temp_dir().to_string_lossy().to_string())
}

/// Get the default agent ID from persisted AppState.
/// Returns None if not set (frontend should fall back to Claude Code).
#[tauri::command]
#[tracing::instrument]
pub async fn get_default_agent_id() -> Option<String> {
    read_app_state().default_agent_id
}

/// Set the default agent ID. Persists to AppState and updates in-memory cache.
#[tauri::command]
#[tracing::instrument]
pub async fn set_default_agent_id(agent_id: String) -> Result<(), CommandError> {
    update_app_state(|state| state.default_agent_id = Some(agent_id.clone()))?;
    crate::agent::set_default_agent_cached(&agent_id);
    tracing::info!("Default agent set to: {}", agent_id);
    Ok(())
}
