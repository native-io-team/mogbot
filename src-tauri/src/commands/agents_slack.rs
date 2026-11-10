//! Settings → Apps → Slack: connect with the user's own Slack app's token,
//! choose who answers, where it listens and the trigger word
//! (`agents::slack`). The token goes from the masked field straight to the
//! Keychain; nothing here ever returns it.

use tauri::{AppHandle, Emitter};

use crate::agents::{self, slack, slack_api};
use crate::errors::CommandError;

fn changed(app: &AppHandle) {
    let _ = app.emit(slack::EVENT, ());
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(agents::err_other)
}

fn api() -> Result<slack_api::HttpApi, CommandError> {
    slack::token()
        .map(slack_api::HttpApi::new)
        .ok_or_else(|| CommandError::expected("Connect Slack first."))
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_slack_status() -> Result<slack::Status, CommandError> {
    blocking(slack::status).await
}

/// Check the pasted User OAuth Token with Slack, then keep it in the Keychain.
#[tauri::command]
#[tracing::instrument(skip(app, token))]
pub async fn agents_slack_connect(
    app: AppHandle,
    token: String,
) -> Result<slack::Status, CommandError> {
    slack::check_token_shape(&token).map_err(CommandError::expected)?;
    let api = slack_api::HttpApi::new(token.trim().to_string());
    let status = slack::connect_with(&api, &token, agents::store::now_ms()).await?;
    changed(&app);
    Ok(status)
}

/// Every conversation the user is in, for the picker.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_slack_conversations() -> Result<Vec<slack::Conversation>, CommandError> {
    let api = api()?;
    slack::list_conversations(&api).await
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_slack_update(
    app: AppHandle,
    patch: slack::Patch,
) -> Result<slack::Status, CommandError> {
    let status = blocking(move || slack::update(patch)).await??;
    changed(&app);
    Ok(status)
}

/// Read Slack now rather than at the next tick.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_slack_check_now(app: AppHandle) -> Result<slack::Status, CommandError> {
    slack::check(&app, true).await;
    blocking(slack::status).await
}

/// Sign the token out at Slack (best effort, a few seconds at most), then
/// forget it here whatever Slack said; the answer's line says which.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_slack_disconnect(app: AppHandle) -> Result<slack::Status, CommandError> {
    let api = blocking(slack::token).await?.map(slack_api::HttpApi::new);
    let status = slack::disconnect_with(
        api.as_ref().map(|a| a as &dyn slack_api::Api),
        slack::REVOKE_WAIT,
    )
    .await?;
    changed(&app);
    Ok(status)
}
