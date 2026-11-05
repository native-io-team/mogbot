//! Tauri commands for rooms in Agents: group conversations with 2–6
//! agents. The logic lives in `crate::agents::rooms`.

use tauri::{AppHandle, Emitter};

use crate::agents::{self, notify, rooms, runner, store};
use crate::errors::CommandError;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(agents::err_other)?
}

fn changed(app: &AppHandle) {
    let _ = app.emit(rooms::EVENT_ROOMS, ());
}

/// Every room, with what is happening in it now.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_rooms() -> Result<Vec<rooms::RoomView>, CommandError> {
    blocking(rooms::views).await
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_room_create(
    app: AppHandle,
    name: Option<String>,
    members: Vec<String>,
) -> Result<rooms::RoomView, CommandError> {
    let room = blocking(move || rooms::create(name.as_deref(), &members)).await?;
    changed(&app);
    Ok(rooms::view(room))
}

/// Rename, change members or the lead, mute or unmute.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_room_update(
    app: AppHandle,
    room_id: String,
    change: rooms::RoomChange,
) -> Result<rooms::RoomView, CommandError> {
    let room = blocking(move || rooms::change(&room_id, change)).await?;
    changed(&app);
    Ok(rooms::view(room))
}

/// Delete a room and its thread. Its agents stay, with their memory and chats.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_room_delete(app: AppHandle, room_id: String) -> Result<(), CommandError> {
    blocking(move || rooms::delete(&room_id).map(|_| ())).await?;
    changed(&app);
    Ok(())
}

/// A page of the room's thread, oldest first.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_room_messages(
    room_id: String,
    limit: Option<usize>,
    before: Option<String>,
) -> Result<Vec<store::AgentMessage>, CommandError> {
    blocking(move || {
        rooms::messages_page(&room_id, limit.unwrap_or(150).min(2000), before.as_deref())
    })
    .await
}

/// Say something in a room: to the agents in `mentions`, everyone, or the
/// room's lead. Refused (nothing recorded) when that's nobody.
#[tauri::command]
#[tracing::instrument(skip(app, text))]
pub async fn agents_room_send(
    app: AppHandle,
    room_id: String,
    text: String,
    mentions: Option<Vec<String>>,
    everyone: Option<bool>,
    client_id: Option<String>,
) -> Result<rooms::Sent, CommandError> {
    let app2 = app.clone();
    blocking(move || {
        rooms::send(
            &app2,
            &room_id,
            &text,
            &mentions.unwrap_or_default(),
            everyone.unwrap_or(false),
            client_id,
        )
    })
    .await
}

/// The room this window shows (`None`: none). While it is in front, the
/// room's lines don't count as unread; opening it clears what piled up.
#[tauri::command]
#[tracing::instrument(skip(app, window))]
pub async fn agents_room_focus(
    app: AppHandle,
    window: tauri::WebviewWindow,
    room_id: Option<String>,
) -> Result<(), CommandError> {
    focus_room_as(&app, window.label(), room_id)
}

/// [`agents_room_focus`] for any surface with a label (a phone's socket too).
pub(crate) fn focus_room_as(
    app: &AppHandle,
    label: &str,
    room_id: Option<String>,
) -> Result<(), CommandError> {
    notify::set_showing(label, room_id.as_ref().map(|id| format!("room:{id}")));
    if let Some(id) = room_id {
        if rooms::get(&id)?.unread > 0 {
            rooms::mark_read(&id)?;
            changed(app);
        }
    }
    Ok(())
}

/// Stop what the room's members are doing for this room. What was said to
/// them elsewhere is left queued.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_room_stop(app: AppHandle, room_id: String) -> Result<usize, CommandError> {
    let room = rooms::get(&room_id)?;
    let stopped = room
        .members
        .iter()
        .filter(|member| runner::stop_in_room(member, &room_id))
        .count();
    changed(&app);
    Ok(stopped)
}
