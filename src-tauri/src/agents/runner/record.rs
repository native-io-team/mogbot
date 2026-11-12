//! Recording what the user sees: status, chat lines (in a room's thread while a turn answers there), drafts, notifications and the sidebar row.

use super::*;

pub fn set_status(app: &AppHandle, agent_id: &str, mut status: Status) {
    if let Some(activity) = status.activity.as_mut() {
        *activity = super::secrets::redact(activity).into_owned();
    }
    status.work = None;
    let moved = {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = runtimes.entry(agent_id.to_string()).or_default();
        let before = runtime.status.as_ref().map_or("idle", |s| s.state);
        runtime.status = Some(status.clone());
        before != status.state
    };
    with_work(agent_id, &mut status);
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        agent_id: &'a str,
        status: &'a Status,
    }
    let status = shown(agent_id, status);
    let _ = app.emit(
        EVENT_STATUS,
        Payload {
            agent_id,
            status: &status,
        },
    );
    // The Dock badge reads the state too: a failed turn needs you only once
    // it's idle, which is after its error line was recorded.
    if moved {
        notify::refresh_badge(app);
    }
}

/// Which room a line recorded without one belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Tag {
    /// Only a turn says this kind of line ([`said_in_turn`]): the room its
    /// turn in progress answers in, if any.
    ByKind,
    /// The turn itself recorded it (its stop, its failure): that turn's room.
    Turn,
    /// Not the turn's: the agent's own chat, whatever it is busy with.
    Own,
}

/// Said by a turn answering in a room: the line belongs to that room's thread.
pub(super) fn tag_room(message: &mut AgentMessage, tag: Tag) {
    let turns = match tag {
        Tag::ByKind => said_in_turn(message.kind),
        Tag::Turn => true,
        Tag::Own => false,
    };
    if message.room.is_none() && turns {
        message.room = turn_room(&message.agent_id).map(|r| r.room_id);
    }
}

/// Persist a message, update the agent's sidebar row, and tell the UI.
pub fn record(app: &AppHandle, message: AgentMessage) -> Result<AgentMessage, CommandError> {
    // The user wrote: a new task, in which an ask that expired may be raised again.
    if message.kind == MessageKind::User && !message.agent_id.is_empty() {
        super::expiry::new_task(&message.agent_id);
        // Its first-open starters go once the user says anything.
        let cleared = super::starters::clear(&message.agent_id);
        // Speaking to the Chief with "Already have agents…?" still open goes
        // past it (`import_choice::Choice::Skipped`).
        let skipped = super::store::get(&message.agent_id).is_ok_and(|a| a.is_main)
            && crate::agents::import_choice::skip_if_undecided(super::store::now_ms());
        if cleared || skipped {
            let _ = tauri::Emitter::emit(app, EVENT_REGISTRY, ());
        }
    }
    record_as(app, message, true, Tag::ByKind)
}

/// [`record`] for a line the turn in progress leaves itself (a note, its
/// error): while it answers in a room, the line is that room's.
pub fn record_in_turn(
    app: &AppHandle,
    message: AgentMessage,
) -> Result<AgentMessage, CommandError> {
    record_as(app, message, true, Tag::Turn)
}

/// [`record`] for a card that isn't the turn's (an import's consent or
/// review): it stays in the agent's own chat even while it answers in a room.
pub fn record_own(app: &AppHandle, message: AgentMessage) -> Result<AgentMessage, CommandError> {
    record_as(app, message, true, Tag::Own)
}

/// `record` without the OS notification: the same card shown in a second
/// chat, which was already announced once. That chat's agent may be busy
/// in a room of its own; the copy is still its own chat's.
pub fn record_quietly(
    app: &AppHandle,
    message: AgentMessage,
) -> Result<AgentMessage, CommandError> {
    record_as(app, message, false, Tag::Own)
}

pub(super) fn record_as(
    app: &AppHandle,
    message: AgentMessage,
    alert: bool,
    tag: Tag,
) -> Result<AgentMessage, CommandError> {
    let mut message = store::localized(super::secrets::redact_message(message));
    tag_room(&mut message, tag);
    // Which conversation it was said in, so the UI that's told places it
    // where the log does (`conversations::stamped`).
    if message.conversation.is_none() && !message.agent_id.is_empty() {
        message = super::conversations::stamped(&message);
    }
    if let Err(e) = store::append_message(&message) {
        // A deleted agent's dying turn: nothing to show, nowhere to show it.
        if !store::is_gone(&message.agent_id) {
            unsaved(app, &message, &e);
        }
        return Err(e);
    }
    // A step of the turn's timeline (an approval card, a screenshot), or the
    // line it will hang under. A card's copy in a second chat is not its step.
    if alert {
        super::work::on_message(&message);
    }
    announce(app, message, alert)
}

/// The rest of `record`, for a message already in the log: the sidebar row,
/// the UI, and a notification if it wants the user.
pub(super) fn announce(
    app: &AppHandle,
    message: AgentMessage,
    alert: bool,
) -> Result<AgentMessage, CommandError> {
    if message.room.is_some() {
        return announce_in_room(app, message, alert);
    }
    // Anything the agent says (or a check-in firing) while it isn't on screen
    // notifies. Approvals aren't unread: they're counted as pending until answered.
    let wants_user = message.kind.wants_user() && !notify::on_screen(app, &message.agent_id);
    let counts_as_unread = wants_user && message.kind != MessageKind::Approval;
    let preview = preview_for(&message);
    // Its conversation moved (and is named by the first thing said in it).
    if super::conversations::touch(&message, preview.as_deref()) {
        let _ = app.emit(EVENT_CONVERSATIONS, &message.agent_id);
    }
    let ts = message.ts;
    let updated = store::update(&message.agent_id, |agent| {
        agent.last_activity_at = ts;
        if let Some(p) = preview {
            agent.preview = Some(p);
        }
        if counts_as_unread {
            agent.unread = agent.unread.saturating_add(1);
        }
        match message.kind {
            MessageKind::Error => {
                agent.failure = Some(
                    message
                        .failure
                        .clone()
                        .unwrap_or(super::failure::Failure::OTHER),
                )
            }
            // A note, a change card or a session line says nothing after the failure.
            MessageKind::Note | MessageKind::Changes | MessageKind::Session => {}
            _ => agent.failure = None,
        }
    });
    let _ = app.emit(EVENT_MESSAGE, &message);
    let _ = app.emit(EVENT_REGISTRY, ());
    if wants_user {
        if let (Ok(agent), true) = (&updated, alert) {
            notify::message_recorded(app, agent, &message, in_turn(&message.agent_id));
        }
        notify::refresh_badge(app);
    }
    Ok(message)
}

/// What only a turn says (or leaves, like its approval cards and change
/// cards): while that turn answers in a room, these are the room's. Never
/// the user's own lines, another agent's request, a check-in firing, or a
/// note or error, which the app also records for its own reasons (an
/// engine changed, a secret saved, a routine skipped) while the agent is
/// busy in a room; the turn's own notes go through [`record_in_turn`].
pub(super) fn said_in_turn(kind: MessageKind) -> bool {
    matches!(
        kind,
        MessageKind::Agent
            | MessageKind::SentToAgent
            | MessageKind::Approval
            | MessageKind::Changes
            | MessageKind::Session
    )
}

/// `announce` for a line said in a room: copied into the room's thread,
/// whose row (not the agent's) gets the preview and the unread count. The
/// agent's row still carries a failure (its turn didn't finish), and an
/// approval still notifies, since the agent is blocked on it either way.
pub(super) fn announce_in_room(
    app: &AppHandle,
    message: AgentMessage,
    alert: bool,
) -> Result<AgentMessage, CommandError> {
    let room = message.room.clone().unwrap_or_default();
    let room_on_screen = notify::on_screen(app, &format!("room:{room}"));
    super::rooms::mirror(app, &message, room_on_screen);
    let failure = match message.kind {
        MessageKind::Error => Some(Some(
            message
                .failure
                .clone()
                .unwrap_or(super::failure::Failure::OTHER),
        )),
        MessageKind::Agent => Some(None),
        _ => None,
    };
    let updated = match failure {
        Some(failure) => store::update(&message.agent_id, |agent| agent.failure = failure),
        None => store::get(&message.agent_id),
    };
    let _ = app.emit(EVENT_MESSAGE, &message);
    let _ = app.emit(EVENT_REGISTRY, ());
    let wants_user = message.kind == MessageKind::Approval
        && !room_on_screen
        && !notify::on_screen(app, &message.agent_id);
    if wants_user {
        if let (Ok(agent), true) = (&updated, alert) {
            notify::message_recorded(app, agent, &message, in_turn(&message.agent_id));
        }
        notify::refresh_badge(app);
    }
    Ok(message)
}

/// The log couldn't be written (disk full, permissions). The user's own
/// message fails its send and they see why. Anything else (a reply mid-turn)
/// is still shown, since losing it on restart beats never seeing it, and the
/// chat says so, at most once a minute per agent.
pub(super) fn unsaved(app: &AppHandle, message: &AgentMessage, error: &CommandError) {
    static WARNED: LazyLock<Mutex<HashMap<String, std::time::Instant>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    tracing::error!(
        "[Agents] couldn't save a message for {}: {error}",
        message.agent_id
    );
    if message.kind == MessageKind::User {
        return;
    }
    let _ = app.emit(EVENT_MESSAGE, message);
    let now = std::time::Instant::now();
    let mut warned = WARNED.lock().unwrap_or_else(|e| e.into_inner());
    if warned
        .get(&message.agent_id)
        .is_some_and(|t| now.duration_since(*t).as_secs() < 60)
    {
        return;
    }
    warned.insert(message.agent_id.clone(), now);
    let warning = new_message(
        &message.agent_id,
        MessageKind::Error,
        "Couldn't save this conversation to disk, so what's shown here will be gone after the app restarts. Check that the disk isn't full.",
    );
    let _ = app.emit(EVENT_MESSAGE, &warning);
}

pub(crate) fn preview_for(message: &AgentMessage) -> Option<String> {
    let line = |s: &str| {
        s.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(140).collect())
    };
    match message.kind {
        MessageKind::User | MessageKind::Agent if message.text.trim().is_empty() => {
            let verb = if message.kind == MessageKind::User {
                "Sent"
            } else {
                "Shared"
            };
            match message.attachments.len() {
                0 => None,
                1 => Some(format!("{verb} {}", message.attachments[0].name)),
                n => Some(format!("{verb} {n} files")),
            }
        }
        MessageKind::User | MessageKind::Agent | MessageKind::Error => line(&message.text),
        MessageKind::SentToAgent => message
            .peer
            .as_ref()
            .map(|p| format!("Messaged {}", p.name)),
        MessageKind::FromAgent => message
            .peer
            .as_ref()
            .map(|p| format!("Message from {}", p.name)),
        MessageKind::Approval => message
            .approval
            .as_ref()
            .map(|a| format!("Needs your OK: {}", a.title)),
        // A repeating one is a routine; only a one-time one is "Scheduled".
        MessageKind::CheckIn => Some(
            if message.check_in.as_ref().is_some_and(|c| c.repeats) {
                "Routine"
            } else {
                "Scheduled"
            }
            .to_string(),
        ),
        MessageKind::Note | MessageKind::Changes | MessageKind::Session => None,
    }
}

pub(super) fn emit_draft(app: &AppHandle, agent_id: &str, id: &str, text: &str) {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        agent_id: &'a str,
        id: &'a str,
        text: &'a str,
    }
    let text = &super::secrets::redact(text);
    let _ = app.emit(EVENT_DRAFT, Payload { agent_id, id, text });
}

pub fn new_message(agent_id: &str, kind: MessageKind, text: impl Into<String>) -> AgentMessage {
    AgentMessage {
        id: store::new_id(),
        agent_id: agent_id.to_string(),
        ts: store::now_ms(),
        kind,
        text: text.into(),
        peer: None,
        approval: None,
        attachments: Vec::new(),
        check_in: None,
        stopped: false,
        mentions: Vec::new(),
        failure: None,
        changes: None,
        session: None,
        client_id: None,
        work: None,
        fresh: false,
        result: None,
        revises: None,
        takeover: false,
        room: None,
        decide: Vec::new(),
        local_links: Vec::new(),
        blocks: None,
        remembered: None,
        via: None,
        fix: None,
        conversation: None,
    }
}
