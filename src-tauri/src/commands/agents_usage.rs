//! Settings → Agents → Usage, What's in flight's spare-capacity line and the
//! phone's read-only view: the capacity inventory (`agents::inventory`), the
//! usage mode and the spare-capacity list (`agents::usage_plan`).

use tauri::{AppHandle, Emitter};

use crate::agents::{self, inventory::Inventory, runner, usage_plan};
use crate::errors::CommandError;

fn changed(app: &AppHandle) {
    let _ = app.emit(runner::EVENT_USAGE_PLAN, ());
}

/// Every engine and account with what each last reported, other compute on
/// this Mac, spare windows, estimates from past runs, and the list.
///
/// Someone is looking: every account is read again without a turn
/// (`usage_read`), unless that ran in the last two minutes. That happens
/// behind this answer, which is what is known now; a change arrives as
/// `agents://quota`.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_usage_overview(app: AppHandle) -> Result<Inventory, CommandError> {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        agents::usage_read::refresh_if_stale(&handle).await;
    });
    Ok(agents::inventory::read().await)
}

/// The user's own choice, in Settings: no card (the card is for an agent
/// asking).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_usage_mode(app: AppHandle, mode: String) -> Result<(), CommandError> {
    let mode = usage_plan::Mode::parse(&mode)?;
    tokio::task::spawn_blocking(move || usage_plan::set_mode(mode, agents::store::now_ms()))
        .await
        .map_err(agents::err_other)??;
    changed(&app);
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(app, text))]
pub async fn agents_spare_add(
    app: AppHandle,
    text: String,
    agent_id: Option<String>,
) -> Result<usage_plan::SpareItem, CommandError> {
    let item = tokio::task::spawn_blocking(move || {
        if let Some(id) = &agent_id {
            agents::store::get(id)?;
        }
        usage_plan::add_item(&text, agent_id, "you", agents::store::now_ms())
    })
    .await
    .map_err(agents::err_other)??;
    changed(&app);
    Ok(item)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_spare_remove(app: AppHandle, id: String) -> Result<(), CommandError> {
    tokio::task::spawn_blocking(move || {
        usage_plan::settle_item(&id, true, agents::store::now_ms())
    })
    .await
    .map_err(agents::err_other)??;
    changed(&app);
    Ok(())
}
