//! Settings → Accounts & usage, What's in flight's spare-capacity line and the
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
pub async fn agents_usage_overview(
    app: AppHandle,
    look: Option<bool>,
) -> Result<Inventory, CommandError> {
    // `look: false`: a glance (the sidebar's account row), not someone
    // looking; what is known, with no read of its own.
    if look != Some(false) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            agents::usage_read::refresh_if_stale(&handle).await;
        });
    }
    Ok(agents::inventory::read().await)
}

/// The user answered "This Mac's Claude Code is now signed in as …" ("Add
/// it" or "Not now"): it isn't said again.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_usage_sign_in_seen(app: AppHandle, key: String) -> Result<(), CommandError> {
    tokio::task::spawn_blocking(move || usage_plan::sign_in_told(&key))
        .await
        .map_err(agents::err_other)?;
    changed(&app);
    Ok(())
}

/// What a just-signed-in account turned out to be.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountCheck {
    /// The id of an account earlier in the list that this one is the same
    /// account as, by the engines' own records (`inventory::same_as`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_as: Option<String>,
}

/// The twin of `id` among an inventory's accounts, by its `same_as` name.
pub fn twin_of(inv: &Inventory, engine: agents::engine::Engine, id: &str) -> AccountCheck {
    let of = |a: &&agents::inventory::AccountLine| a.engine == engine;
    let same_as = inv
        .accounts
        .iter()
        .filter(of)
        .find(|a| a.id == id)
        .and_then(|line| line.same_as.as_ref())
        .and_then(|name| {
            inv.accounts
                .iter()
                .filter(of)
                .find(|a| &a.name == name && a.id != id)
                .map(|a| a.id.clone())
        });
    AccountCheck { same_as }
}

/// Right after an account is signed in: read it once, and say whether it's
/// an account already in the list, so a duplicate is said at once rather
/// than found later in Usage.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_usage_check_account(
    app: AppHandle,
    engine: String,
    id: String,
) -> Result<AccountCheck, CommandError> {
    let engine = agents::engine::Engine::parse(&engine)?;
    if agents::usage_read::check_one(engine, &id).await {
        let _ = app.emit(runner::EVENT_QUOTA, ());
    }
    let inv = agents::inventory::read().await;
    Ok(twin_of(&inv, engine, &id))
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

/// The Usage view's "Give agents something to do": the Chief starts the
/// spare-capacity list now on a window near its reset with room left.
/// Answers the line to show.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_spare_spend_now(app: AppHandle) -> Result<String, CommandError> {
    let line = agents::usage_tools::spend_now(&app).await?;
    changed(&app);
    Ok(line)
}

/// Settings → Accounts & usage, "When every account of an engine is out":
/// each engine's choice (`agents::crossover`) and the agents carrying on
/// with the other engine right now.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_crossover() -> Result<agents::crossover::View, CommandError> {
    tokio::task::spawn_blocking(|| {
        let all = agents::store::list().unwrap_or_default();
        agents::crossover::view(&all)
    })
    .await
    .map_err(agents::err_other)
}

/// Ask first, carry on with the other engine, or wait for the reset, when
/// every account of `engine` is out.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_crossover(
    app: AppHandle,
    engine: String,
    mode: String,
) -> Result<agents::crossover::View, CommandError> {
    let engine = agents::engine::Engine::parse(&engine)?;
    let mode = agents::crossover::Mode::parse(&mode)?;
    let view = tokio::task::spawn_blocking(move || {
        agents::crossover::set_mode(engine, mode)?;
        let all = agents::store::list().unwrap_or_default();
        Ok::<_, CommandError>(agents::crossover::view(&all))
    })
    .await
    .map_err(agents::err_other)??;
    changed(&app);
    Ok(view)
}
