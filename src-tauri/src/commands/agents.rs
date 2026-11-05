//! Tauri commands for the Agents view. The logic lives in `crate::agents`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agents::{
    self, apps, attachments, engine, files, import, mcp, memory, notify, paste, project, prompts,
    runner, schedule, search, secrets, store, usage,
};
use crate::errors::CommandError;
use engine::Engine;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    #[serde(flatten)]
    pub agent: store::Agent,
    pub status: runner::Status,
    /// The agent's home, which attachment paths are relative to.
    pub home: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsOverview {
    pub agents: Vec<AgentView>,
    /// Whether Claude Code is installed. Kept for the companion protocol,
    /// which reads it; whether a given agent can be sent a message is its own
    /// engine's `engines` entry (installed and signed in).
    pub engine_ready: bool,
    /// Every engine an agent can run on: whether it's here and signed in,
    /// and the models it offers.
    pub engines: Vec<engine::EngineInfo>,
}

/// Store work (file reads and writes) on a blocking thread, off the async
/// workers every other command and turn share.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(agents::err_other)?
}

fn emit_registry(app: &AppHandle) {
    let _ = app.emit(runner::EVENT_REGISTRY, ());
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_overview(app: AppHandle) -> Result<AgentsOverview, CommandError> {
    agents::ensure_main()?;
    attachments::grant_asset_scope(&app);
    let engines = engine::overview().await;
    let engine_ready = engines
        .iter()
        .any(|e| e.id == Engine::Claude && e.installed);
    if let Err(e) = put_chief_on_a_ready_engine(&engines) {
        tracing::warn!(error = %e, "couldn't move the Chief of Staff onto a ready engine");
    }
    let agents = store::list()?
        .into_iter()
        .map(|agent| {
            Ok(AgentView {
                status: runner::status_with_work(&agent.id),
                home: store::agent_home(&agent.id)?.display().to_string(),
                agent,
            })
        })
        .collect::<Result<_, CommandError>>()?;
    Ok(AgentsOverview {
        agents,
        engine_ready,
        engines,
    })
}

/// A Chief of Staff that has never run, on an engine that isn't here, goes
/// onto one that is: someone with only Codex would otherwise meet a Chief that
/// can't answer. One that has run keeps its engine (and its conversation); its
/// chat offers to set that engine up instead.
fn put_chief_on_a_ready_engine(engines: &[engine::EngineInfo]) -> Result<(), CommandError> {
    let Some(chief) = store::list()?.into_iter().find(|a| a.is_main) else {
        return Ok(());
    };
    let has_run = chief.session_id.is_some() || chief.new_engine;
    let ready = |id: Engine| engines.iter().any(|e| e.id == id && e.ready());
    let target = engine::default_for(engines);
    if has_run || ready(chief.engine) || !ready(target) || target == chief.engine {
        return Ok(());
    }
    store::update(&chief.id, |a| {
        a.switch_engine(target);
        // Nothing to carry over: it has never had a conversation.
        a.new_engine = false;
    })?;
    Ok(())
}

/// The agents that work in a project, read straight from the registry: no
/// Chief of Staff created, no engine probed. A project window's sidebar lists
/// the ones bound to its folder without starting everything Agents mode needs.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_with_projects() -> Result<Vec<AgentView>, CommandError> {
    blocking(|| {
        store::list()?
            .into_iter()
            .filter(|a| a.project.is_some())
            .map(|agent| {
                Ok(AgentView {
                    status: runner::status_with_work(&agent.id),
                    home: store::agent_home(&agent.id)?.display().to_string(),
                    agent,
                })
            })
            .collect()
    })
    .await
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_messages(
    agent_id: String,
    limit: Option<usize>,
    before: Option<String>,
    through: Option<String>,
) -> Result<Vec<store::AgentMessage>, CommandError> {
    const MAX: usize = 5000;
    blocking(move || {
        let mut page = store::messages_page(
            &agent_id,
            limit.unwrap_or(400).min(MAX),
            before.as_deref(),
            through.as_deref().map(|id| (id, MAX)),
        )?;
        // What each turn did, read after the log's lock is let go.
        crate::agents::work::apply(&agent_id, &mut page);
        Ok(page)
    })
    .await
}

#[tauri::command]
#[tracing::instrument(skip(app, text, attachments))]
pub async fn agents_send(
    app: AppHandle,
    agent_id: String,
    text: String,
    attachments: Option<Vec<attachments::OutgoingAttachment>>,
    mentions: Option<Vec<String>>,
    client_id: Option<String>,
) -> Result<store::AgentMessage, CommandError> {
    let text = text.trim().to_string();
    let incoming = attachments.unwrap_or_default();
    if text.is_empty() && incoming.is_empty() {
        return Err(agents::err_invalid("text", "Type a message first."));
    }
    let recipient = store::get(&agent_id)?;
    let home = store::agent_home(&agent_id)?;
    let mut message = runner::new_message(&agent_id, store::MessageKind::User, text.clone());
    // A phone's send id, echoed so its optimistic bubble reconciles by id.
    message.client_id = client_id.filter(|c| !c.is_empty());
    // Only real agents, other than the recipient, once each; anything else is dropped.
    for id in mentions.unwrap_or_default() {
        if id == agent_id || message.mentions.iter().any(|m| m.id == id) {
            continue;
        }
        if let Ok(peer) = store::get(&id) {
            message.mentions.push(store::AgentRef {
                id: peer.id,
                name: peer.name,
            });
        }
    }
    let id = message.id.clone();
    message.attachments =
        tokio::task::spawn_blocking(move || attachments::save(&home, &id, incoming))
            .await
            .map_err(agents::err_other)??;
    // The log keeps what the user typed; the agent also gets where the files are.
    let block = attachments::prompt_block(&store::agent_home(&agent_id)?, &message.attachments);
    let names: Vec<String> = message.mentions.iter().map(|m| m.name.clone()).collect();
    let prompt = [text, prompts::mentions(&names, recipient.is_main), block]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let message = runner::record(&app, message)?;
    runner::enqueue(&app, &agent_id, prompt, runner::From::User);
    agents::tray::mark_used(&app);
    Ok(message)
}

/// Name, type and size for files about to be attached, refusing folders and
/// anything over the limit before the user gets as far as sending. Images the
/// user picked or dropped become loadable, so the composer can show them.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_inspect_files(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<attachments::FileInfo>, CommandError> {
    use tauri::Manager;
    let files = attachments::inspect(&paths)?;
    for file in files.iter().filter(|f| f.mime.starts_with("image/")) {
        let _ = app.asset_protocol_scope().allow_file(&file.path);
    }
    Ok(files)
}

/// Open an attachment in its default app (a PDF in Preview, a CSV in Numbers),
/// or with `reveal`, show it in Finder.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_attachment(
    agent_id: String,
    path: String,
    reveal: Option<bool>,
) -> Result<(), CommandError> {
    let full = attachments::resolve(&store::agent_home(&agent_id)?, &path)?;
    let action = if reveal.unwrap_or(false) {
        files::PathAction::Reveal
    } else {
        files::PathAction::Open
    };
    files::perform(&full, action)
}

/// Everything shared in one conversation, both ways, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_files(agent_id: String) -> Result<Vec<files::SharedFile>, CommandError> {
    tokio::task::spawn_blocking(move || files::list(&agent_id))
        .await
        .map_err(agents::err_other)?
}

/// A path an agent wrote in its reply, clicked: a document opens in its
/// default app; folders, apps and scripts are only shown in Finder. Returns
/// what was done, so the UI can say "Shown in Finder".
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_path(
    agent_id: String,
    path: String,
    reveal: Option<bool>,
) -> Result<files::PathAction, CommandError> {
    let home = store::agent_home(&agent_id)?;
    let (full, action) = files::local_path(&path, &home, reveal.unwrap_or(false))?;
    files::perform(&full, action)?;
    Ok(action)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    pub name: String,
    pub shape: Option<u8>,
    pub color: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub instructions: String,
    /// `claude` (the default) or `codex`.
    #[serde(default)]
    pub engine: Option<String>,
    /// One of the engine's models; omitted or empty uses its default.
    #[serde(default)]
    pub model: Option<String>,
    /// A project path from `list_projects`; omitted or empty leaves it unbound.
    #[serde(default)]
    pub project: Option<String>,
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_create(
    app: AppHandle,
    input: CreateAgentInput,
) -> Result<store::Agent, CommandError> {
    // Checked whichever way it was chosen: an agent is never put on an
    // engine that can't run its first message.
    let engine = match input.engine.as_deref() {
        Some(e) => Engine::parse(e)?,
        None => Engine::default(),
    };
    engine::require_ready(engine).await?;
    let model = input
        .model
        .as_deref()
        .map(|m| engine::normalize_model(engine, m))
        .transpose()?
        .flatten();
    let project = match input.project.as_deref() {
        Some(p) => project::resolve(p).await?.map(|p| p.path),
        None => None,
    };
    let agent = store::create(store::NewAgent {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        shape: input.shape,
        color: input.color,
        is_main: false,
    })?;
    let agent = if model.is_some() || project.is_some() || engine != Engine::default() {
        store::update(&agent.id, |a| {
            a.engine = engine;
            a.model = model;
            a.project = project;
        })?
    } else {
        agent
    };
    emit_registry(&app);
    Ok(agent)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentInput {
    pub name: Option<String>,
    pub shape: Option<u8>,
    pub color: Option<String>,
    pub role: Option<String>,
    pub instructions: Option<String>,
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    /// `claude` or `codex`: from its next turn, in a new session handed the
    /// recent conversation. The model goes back to the engine's default
    /// unless one is given with it.
    pub engine: Option<String>,
    /// One of its engine's models; an empty string goes back to the default.
    pub model: Option<String>,
    /// What its routines run on: `""` automatic, `"same"`, or a model alias.
    pub routine_model: Option<String>,
    /// A project path from `list_projects`; an empty string unbinds it.
    pub project: Option<String>,
    /// "Work directly in the project" instead of in a copy of it.
    #[serde(default)]
    pub work_directly: Option<bool>,
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_update(
    app: AppHandle,
    agent_id: String,
    input: UpdateAgentInput,
) -> Result<store::Agent, CommandError> {
    let name = input
        .name
        .as_deref()
        .map(store::validate_name)
        .transpose()?;
    if let Some(name) = &name {
        if let Some(other) = store::find(name)? {
            if other.id != agent_id {
                return Err(agents::err_invalid(
                    "name",
                    format!("There's already an agent called {name}."),
                ));
            }
        }
    }
    let color = input.color.filter(|c| store::COLORS.contains(&c.as_str()));
    let shape = input.shape.filter(|s| *s < store::SHAPE_COUNT);
    let role = input.role.clone();
    let current = store::get(&agent_id)?;
    let engine = match input.engine.as_deref().map(Engine::parse).transpose()? {
        Some(engine) if engine != current.engine => {
            engine::require_ready(engine).await?;
            Some(engine)
        }
        _ => None,
    };
    let model = input
        .model
        .as_deref()
        .map(|m| engine::normalize_model(engine.unwrap_or(current.engine), m))
        .transpose()?;
    let routine_model = input
        .routine_model
        .as_deref()
        .map(|m| store::normalize_routine_model(engine.unwrap_or(current.engine), m))
        .transpose()?;
    let project = match input.project.as_deref() {
        Some(p) => Some(project::resolve(p).await?.map(|p| p.path)),
        None => None,
    };
    if let Some(p) = &project {
        agents::task::refuse_rebind(&current, p.as_deref())?;
    }
    let updated = store::update(&agent_id, |a| {
        if let Some(n) = name {
            a.name = n;
        }
        if let Some(c) = color {
            a.color = c;
        }
        if let Some(s) = shape {
            a.shape = s;
        }
        if let Some(r) = role {
            a.role = r.trim().to_string();
        }
        if let Some(p) = input.pinned {
            a.pinned = p;
        }
        if let Some(h) = input.hidden {
            a.hidden = h;
        }
        if let Some(m) = input.muted {
            a.muted = m;
        }
        if let Some(engine) = engine {
            a.switch_engine(engine);
        }
        if let Some(m) = model {
            a.set_model(m);
        }
        if let Some(m) = routine_model {
            a.routine_model = m;
        }
        if let Some(p) = project {
            a.project = p;
        }
        if let Some(direct) = input.work_directly {
            a.work_directly = direct;
        }
    })?;
    // The name and role are written into CLAUDE.md's heading, so any change
    // to them (or the instructions) rewrites it — memory is preserved.
    if input.instructions.is_some() || input.name.is_some() || input.role.is_some() {
        let instructions = match input.instructions {
            Some(i) => i,
            None => store::read_instructions(&agent_id)?,
        };
        store::write_instructions(&store::agent_home(&agent_id)?, &updated, &instructions)?;
    }
    if let Some(engine) = engine {
        let line = format!("Runs on {} from its next message", engine.label());
        let _ = runner::record(
            &app,
            runner::new_message(&agent_id, store::MessageKind::Note, line),
        );
    }
    emit_registry(&app);
    // Hiding an agent takes its unread out of the badge, as it does the sidebar's.
    if input.hidden.is_some() {
        notify::refresh_badge(&app);
    }
    Ok(updated)
}

/// One file of a change card, as the diff modal shows it: this turn's change
/// only, between the snapshots the card recorded. The project and snapshots
/// come from the stored card, never from the caller.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_change_diff(
    agent_id: String,
    message_id: String,
    path: String,
) -> Result<crate::types::FileDiff, CommandError> {
    let id = agent_id.clone();
    let summary = blocking(move || store::messages(&id, usize::MAX))
        .await?
        .into_iter()
        .find(|m| m.id == message_id)
        .and_then(|m| m.changes)
        .ok_or_else(|| CommandError::expected("That change card no longer exists."))?;
    if !summary.files.iter().any(|f| f.path == path) {
        return Err(agents::err_invalid("path", "not a file in this change"));
    }
    let dir = crate::utils::validate_project_path(&summary.project)?;
    project::file_diff(&dir, &summary.from, &summary.to, &path).await
}

/// "Keep changes": the agent's copy of its project merged into the branch it
/// was made from. An overlap stops in the copy (`conflict`), never in the
/// user's folder; a project now on another branch answers `otherBranch`, and
/// keeping there takes `into` naming that branch. `copy_id` names the card's
/// copy, so a stale card can't keep a newer one.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_copy_keep(
    app: AppHandle,
    agent_id: String,
    copy_id: Option<String>,
    into: Option<String>,
) -> Result<agents::task::Kept, CommandError> {
    agents::task::keep(&app, &agent_id, copy_id.as_deref(), into.as_deref()).await
}

/// "Discard": the agent's copy of its project and everything in it.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_copy_discard(
    app: AppHandle,
    agent_id: String,
    copy_id: Option<String>,
) -> Result<(), CommandError> {
    agents::task::discard(&app, &agent_id, copy_id.as_deref()).await
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_instructions(agent_id: String) -> Result<String, CommandError> {
    store::read_instructions(&agent_id)
}

/// The agent's `## Memory`, as entries (`agents/memory.rs`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_memory(agent_id: String) -> Result<memory::View, CommandError> {
    blocking(move || memory::read(&agent_id)).await
}

/// Add, edit or delete one memory entry; the rest of CLAUDE.md is untouched.
#[tauri::command]
#[tracing::instrument(skip(change))]
pub async fn agents_memory_change(
    agent_id: String,
    change: memory::Change,
) -> Result<memory::View, CommandError> {
    blocking(move || memory::change(&agent_id, &change)).await
}

/// "Remember this": a message as one line worth keeping, for the user to edit.
#[tauri::command]
#[tracing::instrument(skip(text))]
pub async fn agents_memory_suggest(text: String) -> Result<String, CommandError> {
    Ok(memory::suggest(&text).await)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_delete(app: AppHandle, agent_id: String) -> Result<(), CommandError> {
    runner::stop(&agent_id);
    let copy = store::get(&agent_id).ok().and_then(|a| a.copy);
    store::delete(&agent_id)?;
    // Its copy's folder goes; a branch with work on it stays.
    if let Some(copy) = copy {
        tauri::async_runtime::spawn(agents::task::abandon(copy));
    }
    emit_registry(&app);
    notify::refresh_badge(&app);
    Ok(())
}

/// How many agents are mid-turn: an update waits for them before restarting.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_busy() -> Result<usize, CommandError> {
    Ok(runner::busy_count())
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_stop(app: AppHandle, agent_id: String) -> Result<bool, CommandError> {
    let stopped = runner::stop(&agent_id);
    // The Chief's Stop (here and on the phone) also stops an import it's
    // running; only the import's own messages go, never the user's.
    let import = store::get(&agent_id).is_ok_and(|a| a.is_main) && agents::connector::stop(&app);
    Ok(stopped || import)
}

/// Start the agent's next message in a new conversation: its instructions
/// and memory carry over, the session doesn't, and the chat stays with a
/// divider. Refused while it's working.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_start_fresh(
    app: AppHandle,
    agent_id: String,
) -> Result<store::Agent, CommandError> {
    let app2 = app.clone();
    let agent = blocking(move || runner::start_fresh(&app2, &agent_id)).await?;
    emit_registry(&app);
    Ok(agent)
}

/// Stop the turn in progress so the messages queued behind it run now. The
/// next turn is told what it was doing when it was cut off.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_interrupt(agent_id: String) -> Result<bool, CommandError> {
    Ok(runner::interrupt(&agent_id))
}

/// `always`: allow, and keep allowing what the card offered to (its stored
/// scope, never one the caller supplies).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_answer_approval(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    allow: bool,
    always: Option<bool>,
    note: Option<String>,
    choice: Option<usize>,
) -> Result<(), CommandError> {
    blocking(move || answer_card(&app, &agent_id, &request_id, allow, always, note, choice)).await
}

fn answer_card(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    allow: bool,
    always: Option<bool>,
    note: Option<String>,
    choice: Option<usize>,
) -> Result<(), CommandError> {
    let note = note
        .map(|n| n.trim().chars().take(MAX_DENY_NOTE).collect::<String>())
        .filter(|n| !allow && !n.is_empty());
    let status = if allow {
        store::ApprovalStatus::Allowed
    } else {
        store::ApprovalStatus::Denied
    };
    let approval = store::find_approval(agent_id, request_id)?
        .ok_or_else(|| CommandError::expected("That request no longer exists."))?;
    if approval.status != store::ApprovalStatus::Pending {
        return Err(CommandError::expected("That request was already answered."));
    }
    // The import connector's own cards: consent, and the staged agents.
    if approval.connector.is_some() {
        return agents::connector::answer_card(app, agent_id, &approval, allow);
    }
    // A session's question: keys to the session, and every chat holding the
    // card is answered with it.
    if approval.prompt.is_some() {
        return agents::decisions::answer(app, &approval, allow, choice);
    }
    if let Some(request) = &approval.secret {
        if allow {
            return Err(CommandError::expected(
                "Type it into the card and choose Save.",
            ));
        }
        return decline_secret(app, agent_id, request_id, request, note.as_deref());
    }
    let rule = if allow && always == Some(true) {
        Some(mcp::always_allow(agent_id, &approval)?)
    } else {
        None
    };
    // Write the decision before waking the waiter, so the card can't be
    // overwritten by the waiter's own cleanup.
    let updated = if let Some(scope) = &rule {
        store::allow_always(agent_id, request_id, scope)?
    } else if let Some(note) = &note {
        store::deny_with_note(agent_id, request_id, note)?
    } else {
        store::set_approval_status(agent_id, request_id, status)?
    };
    if let Some(message) = updated {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    emit_registry(app);
    notify::refresh_badge(app);
    wake(app, agent_id, &approval, allow, note.as_deref())?;

    // The new rule answers the other open cards it covers, the same way.
    if let Some(scope) = rule {
        let open = store::pending_approvals(agent_id)?;
        for id in mcp::covered_by(&scope, &open, request_id) {
            let Some(card) = open.iter().find(|a| a.request_id == id) else {
                continue;
            };
            if let Some(message) = store::allow_always(agent_id, &id, &scope)? {
                let _ = app.emit(runner::EVENT_MESSAGE, &message);
            }
            if let Err(e) = wake(app, agent_id, card, true, None) {
                tracing::warn!(request_id = %id, error = %e, "covered card could not wake its agent");
            }
        }
        emit_registry(app);
        notify::refresh_badge(app);
    }
    Ok(())
}

/// Hand an answer to whoever is waiting on the card. Nobody is waiting on it
/// (the agent paused, or the app restarted): a late Allow grants that exact
/// call and wakes the agent; a late No with a note hands the agent the note.
fn wake(
    app: &AppHandle,
    agent_id: &str,
    approval: &store::Approval,
    allow: bool,
    note: Option<&str>,
) -> Result<(), CommandError> {
    if !mcp::answer_approval(&approval.request_id, allow) {
        mcp::answer_late(app, agent_id, approval, allow)?;
        if let Some(note) = note {
            runner::enqueue(
                app,
                agent_id,
                format!(
                    "[The user declined what you asked for earlier: {} — {}. They said: \"{note}\". Do that instead.]",
                    approval.title, approval.detail
                ),
                runner::From::User,
            );
        }
    }
    Ok(())
}

/// Decline a secure input card: nothing is stored, and the agent is woken
/// with a plain refusal, since nobody is waiting on the card.
fn decline_secret(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    request: &secrets::Request,
    note: Option<&str>,
) -> Result<(), CommandError> {
    let updated = match note {
        Some(note) => store::deny_with_note(agent_id, request_id, note)?,
        None => store::set_approval_status(agent_id, request_id, store::ApprovalStatus::Denied)?,
    };
    if let Some(message) = updated {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    store::refresh_pending(agent_id);
    emit_registry(app);
    notify::refresh_badge(app);
    // An imported agent's login card: declining doesn't wake it either.
    if !request.quiet {
        runner::enqueue(
            app,
            agent_id,
            secrets::denied_prompt(request, note),
            runner::From::User,
        );
    }
    Ok(())
}

/// Save a secure input card. The values go from here to the Keychain and are
/// never written anywhere else; the agent is woken with the variable's name.
#[tauri::command]
#[tracing::instrument(skip(app, values))]
pub async fn agents_save_secret(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    values: Vec<String>,
) -> Result<secrets::Secret, CommandError> {
    let (secret, card) = {
        let (agent_id, request_id) = (agent_id.clone(), request_id.clone());
        blocking(move || secrets::save(&agent_id, &request_id, &values)).await?
    };
    // A login asked for on an imported agent's behalf doesn't wake it: its
    // instructions came from another assistant, so it starts when the user
    // first messages it, not unattended with the new secret in hand.
    let quiet = card
        .as_ref()
        .and_then(|m| m.approval.as_ref())
        .and_then(|a| a.secret.as_ref())
        .is_some_and(|r| r.quiet);
    if let Some(message) = card {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    emit_registry(&app);
    notify::refresh_badge(&app);
    if quiet {
        let _ = runner::record(
            &app,
            runner::new_message(
                &agent_id,
                store::MessageKind::Note,
                format!("Saved {}. It's used from your first message.", secret.name),
            ),
        );
    } else {
        runner::enqueue(
            &app,
            &agent_id,
            secrets::saved_prompt(&secret),
            runner::From::User,
        );
    }
    Ok(secret)
}

/// Store something the user pasted in the composer, for this agent, without a
/// card. The composer then sends the variable's name instead of the value.
#[tauri::command]
#[tracing::instrument(skip(app, value))]
pub async fn agents_add_secret(
    app: AppHandle,
    agent_id: String,
    name: String,
    kind: String,
    value: String,
) -> Result<secrets::Secret, CommandError> {
    let secret = blocking(move || secrets::add(&agent_id, &name, &kind, &value)).await?;
    emit_registry(&app);
    Ok(secret)
}

/// Delete a secret from the Keychain and from the agent.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_revoke_secret(
    app: AppHandle,
    agent_id: String,
    secret_id: String,
) -> Result<(), CommandError> {
    blocking(move || secrets::revoke(&agent_id, &secret_id)).await?;
    emit_registry(&app);
    Ok(())
}

/// A "Deny with note…" is a steer, not an essay.
const MAX_DENY_NOTE: usize = 500;

/// Take back an "Always allow" rule: matching calls ask again.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_revoke_permission(
    app: AppHandle,
    agent_id: String,
    rule_id: String,
) -> Result<(), CommandError> {
    store::update(&agent_id, |a| a.permissions.retain(|r| r.id != rule_id))?;
    emit_registry(&app);
    Ok(())
}

/// The agent this window shows (`None` once it leaves Agents mode). While the
/// window has focus, that agent's messages don't count as unread and don't
/// notify; opening it clears what had piled up.
#[tauri::command]
#[tracing::instrument(skip(app, window))]
pub async fn agents_focus(
    app: AppHandle,
    window: tauri::WebviewWindow,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    focus_as(&app, window.label(), agent_id)
}

/// [`agents_focus`] for any surface with a label: a window, or a phone's
/// socket (`companion:<device>:<socket>`, see `crate::companion`).
pub(crate) fn focus_as(
    app: &AppHandle,
    label: &str,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    notify::set_showing(label, agent_id.clone());
    if let Some(id) = agent_id {
        let before = store::get(&id)?;
        if before.unread > 0 {
            store::update(&id, |a| a.unread = 0)?;
            emit_registry(app);
            notify::refresh_badge(app);
        }
    }
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_mark_unread(app: AppHandle, agent_id: String) -> Result<(), CommandError> {
    store::update(&agent_id, |a| a.unread = a.unread.max(1))?;
    notify::refresh_badge(&app);
    Ok(())
}

/// Every agent's conversation, searched: all words must match, newest first.
#[tauri::command]
#[tracing::instrument(skip(query))]
pub async fn agents_search(query: String) -> Result<Vec<search::SearchHit>, CommandError> {
    tokio::task::spawn_blocking(move || search::search(&query))
        .await
        .map_err(agents::err_other)?
}

/// Tokens and cost for one agent: this week and all time.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_usage(agent_id: String) -> Result<usage::UsageSummary, CommandError> {
    Ok(store::get(&agent_id)?.usage.summary(usage::today()))
}

/// What the user sends their other assistant to start an import: one line
/// asking it to talk to the Chief of Staff over the connector.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_prompt() -> Result<String, CommandError> {
    let chief = store::list()?
        .into_iter()
        .find(|a| a.is_main)
        .map(|a| a.name)
        .unwrap_or_else(|| "Chief of Staff".into());
    Ok(import::import_prompt(&chief))
}

/// Whether an import over the connector may begin, and the one in progress
/// (or just ended), for the modal and the bar above the Chief's composer.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_talk() -> Result<agents::connector::Gate, CommandError> {
    Ok(agents::connector::gate())
}

/// The user pressed Start: one import over the connector may begin (it
/// still asks on a card in the Chief's chat first).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_import_talk_arm(
    app: AppHandle,
) -> Result<agents::connector::Gate, CommandError> {
    agents::connector::arm(&app)
}

/// Stop the import: the interview ends, the other assistant's queued
/// message is dropped, and nothing more is accepted until Start again.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_import_talk_stop(app: AppHandle) -> Result<bool, CommandError> {
    Ok(agents::connector::stop(&app))
}

/// Import what the user kept on a review card (`agents::review`).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_import_review_apply(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    picks: agents::review::Picks,
) -> Result<agents::review::Applied, CommandError> {
    blocking(move || agents::connector::apply_review(&app, &agent_id, &request_id, &picks)).await
}

/// A review card as it should show now: each clash read again against the
/// agents here (a card restored after a restart, or one an agent changed under).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_review_current(
    agent_id: String,
    request_id: String,
) -> Result<agents::review::Review, CommandError> {
    blocking(move || agents::review::current(&agent_id, &request_id)).await
}

/// What the user sends their other assistant to get its agents back as JSON
/// they can paste here: the import path that needs no remote access.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_paste_prompt() -> Result<String, CommandError> {
    Ok(paste::PASTE_PROMPT.to_string())
}

/// What importing a pasted reply would do: its agents, and what's wrong with it.
#[tauri::command]
#[tracing::instrument(skip(text))]
pub async fn agents_import_paste_preview(text: String) -> Result<paste::Preview, CommandError> {
    tokio::task::spawn_blocking(move || paste::preview(&text))
        .await
        .map_err(agents::err_other)?
}

/// Import a pasted reply through the same merge as the `import_agents` tool.
/// Any problem in the paste refuses the whole import (a Validation error).
#[tauri::command]
#[tracing::instrument(skip(app, text))]
pub async fn agents_import_paste(
    app: AppHandle,
    text: String,
) -> Result<import::ImportSummary, CommandError> {
    tokio::task::spawn_blocking(move || {
        let (agents, source) = paste::for_import(&text)?;
        import::import_and_notify(&app, agents, &source)
    })
    .await
    .map_err(agents::err_other)?
}

/// The other app's agents on this Mac, and what importing them would do;
/// `None` when it isn't here or has none. Reads only.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_other_app_preview() -> Result<Option<agents::other_app::Preview>, CommandError>
{
    tokio::task::spawn_blocking(agents::other_app::preview)
        .await
        .map_err(agents::err_other)?
}

/// Whether the other app has agents on this Mac, from its registry alone:
/// what the palette asks at launch (the preview reads every agent's folder).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_other_app_exists() -> Result<bool, CommandError> {
    tokio::task::spawn_blocking(agents::other_app::available)
        .await
        .map_err(agents::err_other)
}

/// How far an import's copy has got: `{agent, doneBytes, totalBytes}`.
pub const EVENT_IMPORT_PROGRESS: &str = "agents://import-progress";

/// Copy the other app's team in (`agents::other_app`). Never writes to its
/// folder. Whatever came across is announced however the import ended, so
/// the sidebar and an open chat never miss agents made before a failure.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_other_app_import(
    app: AppHandle,
    options: Option<agents::other_app::Options>,
) -> Result<agents::other_app::Summary, CommandError> {
    let progress_app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let root = agents::other_app::find_source().ok_or_else(|| {
            CommandError::expected(format!(
                "There are no {} agents on this Mac to import.",
                agents::other_app::OTHER_APP_NAME
            ))
        })?;
        // A bar is only worth drawing every so often, not per file.
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let mut report = |p: &agents::other_app::Progress| {
            if last.elapsed() >= std::time::Duration::from_millis(100)
                || p.done_bytes >= p.total_bytes
            {
                last = std::time::Instant::now();
                let _ = progress_app.emit(EVENT_IMPORT_PROGRESS, p);
            }
        };
        agents::other_app::import_from(&root, options.unwrap_or_default(), &mut report)
    })
    .await
    .map_err(agents::err_other);
    let _ = app.emit(agents::runner::EVENT_REGISTRY, ());
    agents::tray::mark_used(&app);
    result?
}

/// What a `when` phrase means, as the user types it in the schedule popover:
/// the resolved first time and, for a routine, how it repeats (structured, so
/// the UI words it the same way it words the list). A parse error comes
/// back as a Validation error with the shapes that work.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    pub next_at: i64,
    pub repeat: Option<schedule::Repeat>,
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_schedule_preview(when: String) -> Result<SchedulePreview, CommandError> {
    let (repeat, next_at) = schedule::parse(&when, &chrono::Local, store::now_ms())
        .map_err(|e| agents::err_invalid("when", e))?;
    Ok(SchedulePreview { next_at, repeat })
}

#[tauri::command]
#[tracing::instrument(skip(app, note))]
pub async fn agents_schedule_create(
    app: AppHandle,
    agent_id: String,
    when: String,
    note: String,
) -> Result<schedule::CheckIn, CommandError> {
    let created = schedule::create(&agent_id, &when, &note)?;
    emit_registry(&app);
    Ok(created.check_in)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_schedule_cancel(
    app: AppHandle,
    agent_id: String,
    id: String,
) -> Result<(), CommandError> {
    schedule::cancel(&agent_id, &id)?;
    emit_registry(&app);
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_schedule_pause(
    app: AppHandle,
    agent_id: String,
    id: String,
    paused: bool,
) -> Result<(), CommandError> {
    schedule::set_paused(&agent_id, &id, paused)?;
    emit_registry(&app);
    Ok(())
}

/// Change a check-in's when and what in place (same id, same paused state).
#[tauri::command]
#[tracing::instrument(skip(app, note))]
pub async fn agents_schedule_update(
    app: AppHandle,
    agent_id: String,
    id: String,
    when: String,
    note: String,
) -> Result<schedule::CheckIn, CommandError> {
    let edited = schedule::edit(&agent_id, &id, &when, &note)?;
    emit_registry(&app);
    Ok(edited)
}

/// Fire a check-in now as a normal wake; its next time doesn't move.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_schedule_run_now(
    app: AppHandle,
    agent_id: String,
    id: String,
) -> Result<(), CommandError> {
    schedule::run_now(&app, &agent_id, &id)
}

/// The apps agents can use: Claude Code's MCP servers, and a short list to add.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_apps_list() -> Result<apps::Apps, CommandError> {
    apps::list().await
}

/// Add one of the suggested apps for every agent (Claude Code user scope).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_apps_add(server_name: String) -> Result<(), CommandError> {
    apps::add(&server_name).await
}

/// Remove a user-scope app from Claude Code.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_apps_remove(name: String) -> Result<(), CommandError> {
    apps::remove(&name).await
}

// ---------------------------------------------------------------------------
// Menu bar, quit guard and quick entry (agents::tray, agents::quick_entry)
// ---------------------------------------------------------------------------

/// What quitting now would interrupt: the quit dialog's question.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_quit_check() -> Result<agents::tray::QuitCheck, CommandError> {
    blocking(|| Ok(agents::tray::quit_check(&agents::tray::snapshot()))).await
}

/// The quit dialog's "Keep running in background".
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_keep_running_in_background(app: AppHandle) -> Result<(), CommandError> {
    crate::commands::window::hide_all_to_background(&app).await
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_desktop_settings() -> Result<agents::quick_entry::Settings, CommandError> {
    blocking(|| Ok(agents::quick_entry::settings())).await
}

/// Change the menu-bar icon, quick entry, or its shortcut; `None` leaves one
/// as it is. A shortcut that conflicts, or that macOS refuses, is not saved.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_desktop_settings(
    app: AppHandle,
    menu_bar_icon: Option<bool>,
    quick_entry: Option<bool>,
    shortcut: Option<String>,
) -> Result<agents::quick_entry::Settings, CommandError> {
    use crate::commands::setup::update_app_state;
    let shortcut = match shortcut {
        Some(text) => {
            let parsed = agents::quick_entry::Accelerator::parse(&text)
                .ok_or_else(|| agents::err_invalid("shortcut", "not a shortcut"))?;
            if let Some(why) = parsed.conflict() {
                return Err(CommandError::expected(why));
            }
            Some(parsed.canonical())
        }
        None => None,
    };
    let before = update_app_state(|s| {
        let before = (s.quick_entry, s.quick_entry_shortcut.clone());
        if menu_bar_icon.is_some() {
            s.menu_bar_icon = menu_bar_icon;
        }
        if quick_entry.is_some() {
            s.quick_entry = quick_entry;
        }
        if shortcut.is_some() {
            s.quick_entry_shortcut = shortcut;
        }
        before
    })?;
    agents::tray::sync(&app);
    if let Err(e) = agents::quick_entry::apply(&app) {
        // Put back what worked, so a refused shortcut never leaves none at all.
        update_app_state(|s| (s.quick_entry, s.quick_entry_shortcut) = before)?;
        let _ = agents::quick_entry::apply(&app);
        return Err(e);
    }
    Ok(agents::quick_entry::settings())
}

/// Esc, or after a send: close the composer and hand focus back.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn quick_entry_hide(app: AppHandle) -> Result<(), CommandError> {
    agents::quick_entry::hide(&app);
    Ok(())
}

/// A message was sent: focus goes back to the app it came from while the
/// confirmation stays up for a moment.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn quick_entry_sent(app: AppHandle) -> Result<(), CommandError> {
    agents::quick_entry::sent(&app);
    Ok(())
}

/// The confirmation's "Open chat": close the composer and open the agent in Ship Studio.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn quick_entry_open_chat(app: AppHandle, agent_id: String) -> Result<(), CommandError> {
    store::get(&agent_id)?;
    if let Some(w) = tauri::Manager::get_webview_window(&app, agents::quick_entry::LABEL) {
        let _ = w.hide();
    }
    notify::open_agent(&app, &agent_id);
    Ok(())
}

/// "Attach screenshot": the PNG's path, or `None` when the user pressed Esc.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn quick_entry_capture(app: AppHandle) -> Result<Option<String>, CommandError> {
    agents::quick_entry::capture(&app).await
}

/// The composer grows with its text; the window follows.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn quick_entry_resize(app: AppHandle, height: f64) -> Result<(), CommandError> {
    agents::quick_entry::resize(&app, height);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engines(claude: bool, codex: bool) -> Vec<engine::EngineInfo> {
        [(Engine::Claude, claude), (Engine::Codex, codex)]
            .into_iter()
            .map(|(id, ready)| engine::EngineInfo {
                id,
                label: "",
                installed: ready,
                signed_in: ready,
                asks: true,
                models: Vec::new(),
            })
            .collect()
    }

    /// Run with a fresh registry holding a new Chief of Staff.
    fn with_chief<T>(f: impl FnOnce(&str) -> T) -> T {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let chief = agents::ensure_main().unwrap();
        let out = f(&chief.id);
        store::set_root_for_tests(None);
        out
    }

    #[test]
    fn a_chief_that_never_ran_moves_onto_the_engine_that_is_here() {
        with_chief(|id| {
            put_chief_on_a_ready_engine(&engines(false, true)).unwrap();
            let chief = store::get(id).unwrap();
            assert_eq!(chief.engine, Engine::Codex);
            assert!(
                !chief.new_engine,
                "nothing to carry over from a chat that never ran"
            );
        });
    }

    #[test]
    fn a_chief_stays_put_when_its_engine_is_ready_or_nothing_is() {
        with_chief(|id| {
            put_chief_on_a_ready_engine(&engines(true, true)).unwrap();
            assert_eq!(store::get(id).unwrap().engine, Engine::Claude);
            put_chief_on_a_ready_engine(&engines(false, false)).unwrap();
            assert_eq!(store::get(id).unwrap().engine, Engine::Claude);
        });
    }

    #[test]
    fn a_chief_with_a_conversation_keeps_its_engine() {
        with_chief(|id| {
            store::update(id, |a| a.session_id = Some("s1".into())).unwrap();
            put_chief_on_a_ready_engine(&engines(false, true)).unwrap();
            assert_eq!(store::get(id).unwrap().engine, Engine::Claude);
        });
    }
}
