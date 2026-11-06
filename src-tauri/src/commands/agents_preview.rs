//! Preview and "Test it" from a chat card (`agents/preview_test.rs`).

use tauri::{AppHandle, Emitter};

use crate::agents::preview_test::{self, PreviewTarget, Run};
use crate::agents::{self, runner, store};
use crate::errors::CommandError;
use crate::utils::validate_project_path;

/// The port saved in a folder's `.shipstudio/project.json`, if any.
fn saved_port(path: &str) -> Option<u16> {
    let raw = std::fs::read_to_string(
        std::path::Path::new(path)
            .join(".shipstudio")
            .join("project.json"),
    )
    .ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("dev_server_port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
}

pub(crate) async fn target_for(
    agent_id: &str,
    message_id: &str,
    link: Option<usize>,
) -> Result<PreviewTarget, CommandError> {
    let agent = store::get(agent_id)?;
    let (log_of, wanted) = (agent_id.to_string(), message_id.to_string());
    let message = tokio::task::spawn_blocking(move || {
        store::messages(&log_of, usize::MAX)
            .map(|log| log.into_iter().rev().find(|m| m.id == wanted))
    })
    .await
    .map_err(agents::err_other)??
    .ok_or_else(|| CommandError::expected("That card isn't in this conversation any more."))?;
    let projects: Vec<String> = crate::commands::projects::list_projects()
        .await?
        .into_iter()
        .map(|p| p.path)
        .collect();
    preview_test::resolve_at(
        &agent,
        &message,
        link,
        &projects,
        crate::proxy::dev_server_port_for,
        saved_port,
    )
    .map_err(CommandError::expected)
}

/// What a card's Preview opens: the folder (the agent's copy, or the
/// project), its port, and whether a server is already up for it. With
/// `link`, one of the message's local links instead (`agents/local_links.rs`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_preview_target(
    agent_id: String,
    message_id: String,
    link: Option<usize>,
) -> Result<PreviewTarget, CommandError> {
    target_for(&agent_id, &message_id, link).await
}

/// The pane is (or stops being) live in this window for `path`: the agent
/// bridge routes that folder's preview tools here while it is.
#[tauri::command]
#[tracing::instrument(skip(window))]
pub async fn agents_preview_attach(
    window: tauri::Window,
    path: String,
    attached: bool,
) -> Result<(), CommandError> {
    let validated = validate_project_path(&path)?;
    let path = validated.to_string_lossy().to_string();
    preview_test::attach_pane(&path, window.label(), attached);
    Ok(())
}

/// "Test it": open a run for the card, then ask the agent, in the chat, to
/// click through the site in the pane the user is watching.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_preview_test_start(
    app: AppHandle,
    agent_id: String,
    message_id: String,
) -> Result<Run, CommandError> {
    let target = target_for(&agent_id, &message_id, None).await?;
    if preview_test::pane_window(&target.path).is_none() {
        return Err(CommandError::expected(
            "Open the preview first: the test runs in it, where you can watch.",
        ));
    }
    let run = preview_test::open(&target, store::now_ms()).map_err(CommandError::expected)?;
    let message = runner::new_message(
        &agent_id,
        store::MessageKind::User,
        "Test it in the preview",
    );
    if let Err(e) = runner::record(&app, message) {
        preview_test::stop(&app, &agent_id);
        return Err(e);
    }
    runner::enqueue(
        &app,
        &agent_id,
        preview_test::test_prompt(&run),
        runner::From::User,
    );
    let _ = app.emit(preview_test::EVENT_TEST, &run);
    Ok(run)
}

/// The agent's run as it stands (a pane opened mid-test catches up).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_preview_test_state(agent_id: String) -> Result<Option<Run>, CommandError> {
    Ok(preview_test::run_of(&agent_id))
}

/// Stop the agent's run: its test tools refuse from here on.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_preview_test_stop(
    app: AppHandle,
    agent_id: String,
) -> Result<bool, CommandError> {
    Ok(preview_test::stop(&app, &agent_id))
}

/// The window's answer to an agent's request about a dev server
/// (`agents/project_tools.rs`, `agents://dev-server`). False when nobody is
/// waiting any more (the call gave up).
#[tauri::command]
#[tracing::instrument(skip(report))]
pub async fn agents_dev_server_done(
    request_id: String,
    report: agents::project_tools::Report,
) -> Result<bool, CommandError> {
    Ok(agents::project_tools::answer(&request_id, report))
}
