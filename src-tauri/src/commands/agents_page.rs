//! A conversation's living page (`agents/page.rs`): read it, read one of its
//! kept versions, pin or unpin it. The agent writes it (the `page` tool);
//! the user only reads it and decides whether it sits above the chat. The
//! phone reaches the same three through the companion server
//! (`agents.page`, `agents.pageVersion`, `agents.pagePin`).

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::agents::{self, conversations, page};
use crate::errors::CommandError;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(agents::err_other)?
}

/// The conversation named, or the one the user is in.
fn which(agent_id: &str, conversation: Option<String>) -> String {
    conversation
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| conversations::current(agent_id))
}

/// The conversation's page and its history; `None` when it has none.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_page(
    agent_id: String,
    conversation: Option<String>,
) -> Result<Option<page::PageView>, CommandError> {
    blocking(move || {
        let conversation = which(&agent_id, conversation);
        page::get(&agent_id, &conversation)
    })
    .await
}

/// One kept version of the page, for reading only; `None` once it is no
/// longer kept.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_page_version(
    agent_id: String,
    conversation: Option<String>,
    version: u32,
) -> Result<Option<page::VersionView>, CommandError> {
    blocking(move || {
        let conversation = which(&agent_id, conversation);
        page::version(&agent_id, &conversation, version)
    })
    .await
}

/// Pin the page above the chat, or unpin it. The agent keeps it current
/// either way.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_page_pin(
    app: AppHandle,
    agent_id: String,
    conversation: Option<String>,
    pinned: bool,
) -> Result<Option<page::PageView>, CommandError> {
    let id = agent_id.clone();
    let (view, conversation) = blocking(move || {
        let at = which(&id, conversation);
        Ok((page::set_pinned(&id, &at, pinned)?, at))
    })
    .await?;
    if view.is_some() {
        let _ = app.emit(
            page::EVENT,
            json!({ "agentId": agent_id, "conversation": conversation }),
        );
    }
    Ok(view)
}
