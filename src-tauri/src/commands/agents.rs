//! Tauri commands for the Agents view. The logic lives in `crate::agents`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agents::{
    self, apps, attachments, engine, files, import, mcp, memory, notify, paste, project, prompts,
    runner, schedule, search, secrets, store, takeover, templates, usage,
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
    /// The user is driving its session in a terminal; omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover: Option<takeover::View>,
    /// Its own independence level (`policy`); omitted when it's the team's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub independence: Option<agents::independence::Level>,
    /// The account its last turn ran on, as it is shown; only while its
    /// engine has more than one (with one, there is nothing to tell apart).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ran_on: Option<RanOn>,
}

/// Which account a turn ran on (`wallet::last_on`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RanOn {
    pub id: String,
    pub name: String,
}

/// The account `agent`'s last turn ran on, when its engine has 2+ accounts.
pub(crate) fn ran_on(agent: &store::Agent, counts: &[(Engine, usize)]) -> Option<RanOn> {
    let many = counts.iter().any(|(e, n)| *e == agent.engine && *n > 1);
    if !many {
        return None;
    }
    agents::wallet::last_on(&agent.id, agent.engine).map(|a| RanOn {
        id: a.id,
        name: a.name,
    })
}

/// How many accounts each engine has.
pub(crate) fn account_counts() -> Vec<(Engine, usize)> {
    let all = agents::wallet::list();
    Engine::ALL
        .iter()
        .map(|e| (*e, all.iter().filter(|a| a.engine == *e).count()))
        .collect()
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
    /// What a new agent starts on when nobody picked (Settings → Agents).
    pub defaults: agents::defaults::View,
    /// How much agents do on their own (Settings → Agents, onboarding).
    pub independence: agents::independence::Level,
    /// Whether "bring your agents from another assistant?" was answered.
    pub import_choice: agents::import_choice::Choice,
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
    let policy = agents::policy::load();
    let counts = account_counts();
    let agents = store::list()?
        .into_iter()
        .map(|agent| {
            Ok(AgentView {
                ran_on: ran_on(&agent, &counts),
                independence: agents::policy::own_independence(&policy, &agent.id),
                takeover: takeover::view(&agent.id),
                status: runner::status_with_work(&agent.id),
                home: store::agent_home(&agent.id)?.display().to_string(),
                agent,
            })
        })
        .collect::<Result<_, CommandError>>()?;
    let defaults = agents::defaults::view_of(&agents::defaults::saved(), &engines);
    Ok(AgentsOverview {
        agents,
        engine_ready,
        engines,
        defaults,
        independence: agents::independence::level(),
        import_choice: agents::import_choice::choice(),
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
        let policy = agents::policy::load();
        store::list()?
            .into_iter()
            // Bound to a project, or with a turn working in one now
            // (`agents::workplace`): the sidebar shows it there.
            .filter(|a| {
                a.project.is_some() || crate::agents::workplace::working_in(&a.id).is_some()
            })
            .map(|agent| {
                Ok(AgentView {
                    ran_on: None,
                    independence: agents::policy::own_independence(&policy, &agent.id),
                    takeover: takeover::view(&agent.id),
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
    lazy_work: Option<bool>,
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
        // A login card's sign-in under way, as it is now.
        crate::agents::logins::apply(&mut page);
        // A step-in the user is in right now.
        crate::agents::step_in::apply(&mut page);
        // Every card in plain words; an admin's batch as it is now.
        crate::agents::admin::apply(&mut page);
        // A remembered rule's line: still in force, or undone.
        crate::agents::remember::apply(&agent_id, &mut page);
        // Timelines as their folded lines only: the steps come one turn at
        // a time when one is opened (`agents_turn_work`).
        if lazy_work.unwrap_or(false) {
            crate::agents::work::omit_steps(&mut page);
        }
        Ok(page)
    })
    .await
}

/// What the turn that ended on `message_id` did, steps and all: a "What it
/// did" opened under a line its page sent without them (`lazy_work`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_turn_work(
    agent_id: String,
    message_id: String,
) -> Result<Option<crate::agents::work::TurnWork>, CommandError> {
    blocking(move || {
        // Validates the id before it becomes a path.
        store::agent_home(&agent_id)?;
        Ok(crate::agents::work::load(&agent_id, &message_id))
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
    revises: Option<String>,
) -> Result<store::AgentMessage, CommandError> {
    send_as(
        app,
        agent_id,
        text,
        attachments,
        mentions,
        client_id,
        revises,
        true,
    )
    .await
}

/// [`agents_send`]. `typed`: the user typed it in this chat (the desk's or
/// the phone's composer), so the turn carries their words
/// (`runner::enqueue_user`); a message the app writes for them from a
/// button ("Say hi", "what the agents are missing") doesn't.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_as(
    app: AppHandle,
    agent_id: String,
    text: String,
    attachments: Option<Vec<attachments::OutgoingAttachment>>,
    mentions: Option<Vec<String>>,
    client_id: Option<String>,
    revises: Option<String>,
    typed: bool,
) -> Result<store::AgentMessage, CommandError> {
    let text = text.trim().to_string();
    let said = text.clone();
    let incoming = attachments.unwrap_or_default();
    if text.is_empty() && incoming.is_empty() {
        return Err(agents::err_invalid("text", "Type a message first."));
    }
    let recipient = store::get(&agent_id)?;
    let says_yes = agents::typed_answer::approves(&text);
    let home = store::agent_home(&agent_id)?;
    let mut message = runner::new_message(&agent_id, store::MessageKind::User, text.clone());
    // "Ask for changes": pinned to the result as the log has it, never as
    // the client named it, and refused if it isn't in this conversation.
    if let Some(id) = revises.filter(|r| !r.trim().is_empty()) {
        let log_of = agent_id.clone();
        let log = tokio::task::spawn_blocking(move || store::messages(&log_of, usize::MAX))
            .await
            .map_err(agents::err_other)??;
        message.revises = Some(agents::results::reference(&log, id.trim()).ok_or_else(|| {
            agents::err_invalid(
                "revises",
                "That result isn't in this conversation any more.",
            )
        })?);
    }
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
    let revising = message
        .revises
        .as_ref()
        .map(agents::results::revising_prompt)
        .unwrap_or_default();
    // The user messaged an imported agent themselves: they've met. The
    // Chief is told where setting up the team stands.
    if !recipient.is_main {
        if let Ok(true) = agents::team_setup::mark_greeted(&agent_id) {
            agents::team_setup::emit(&app);
        }
    }
    let setup = if recipient.is_main {
        agents::team_setup::chief_context().unwrap_or_default()
    } else {
        String::new()
    };
    let prompt = [
        revising,
        text,
        prompts::mentions(&names, recipient.is_main),
        setup,
        block,
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let typed_yes =
        typed && says_yes && message.attachments.is_empty() && message.revises.is_none();
    let message = runner::record(&app, message)?;
    // "Approve it", typed by the user into a chat with one open card: that
    // card is allowed as their answer (`typed_answer`). Only this, the user's
    // own send, gets here.
    if typed_yes {
        let open = store::pending_approvals(&agent_id).unwrap_or_default();
        // No card to answer: the yes may be to a plan the agent's last reply
        // listed, which `ask_plan` then grants without a card (`plan_grant`).
        if open.is_empty() {
            let log_of = agent_id.clone();
            if let Ok(Ok(log)) =
                tokio::task::spawn_blocking(move || store::messages(&log_of, 40)).await
            {
                if let Some(reply) = agents::plan_grant::last_reply(&log) {
                    agents::plan_grant::note_chat_yes(&agent_id, &reply, store::now_ms());
                }
            }
        }
        if let Some(card) = agents::typed_answer::the_card(&open) {
            let request_id = card.request_id.clone();
            match answer_card(&app, &agent_id, &request_id, true, None, None, None) {
                Ok(()) => {
                    let _ = runner::record(
                        &app,
                        runner::new_message(
                            &agent_id,
                            store::MessageKind::Note,
                            agents::typed_answer::LINE,
                        ),
                    );
                }
                Err(e) => {
                    tracing::warn!(agent = %agent_id, %request_id, error = %e, "[Agents] a typed yes couldn't answer the card")
                }
            }
        }
    }
    // Fed up with being asked, or with not being asked: a note for the
    // Chief's next turn (`level_hint`), at most once a day per agent.
    if typed {
        agents::level_hint::on_user_message(&recipient, &said, store::now_ms());
    }
    let typed = typed.then_some(said);
    runner::enqueue_user(&app, &agent_id, &message.id, prompt, typed);
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
/// or with `reveal`, show it in Finder. The same allowlist as a path in prose
/// decides: an agent can share a `.command` file, and clicking its card must
/// not run it — anything off the list is only shown in Finder.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_attachment(
    agent_id: String,
    path: String,
    reveal: Option<bool>,
) -> Result<files::PathAction, CommandError> {
    let home = store::agent_home(&agent_id)?;
    let full = attachments::resolve(&home, &path)?;
    let (full, action) = files::local_path(
        &full.display().to_string(),
        &home,
        std::slice::from_ref(&home),
        reveal.unwrap_or(false),
    )?;
    files::perform(&full, action)?;
    Ok(action)
}

/// Everything shared in one conversation, both ways, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_files(agent_id: String) -> Result<Vec<files::SharedFile>, CommandError> {
    tokio::task::spawn_blocking(move || files::list(&agent_id))
        .await
        .map_err(agents::err_other)?
}

/// A path an agent wrote in its reply, clicked: a document, image or text file
/// opens in its default app; anything else is only shown in Finder; a path
/// outside the agent's folder, the user's projects and its copy is refused. Returns
/// what was done, so the UI can say "Shown in Finder".
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_path(
    agent_id: String,
    path: String,
    reveal: Option<bool>,
) -> Result<files::PathAction, CommandError> {
    let home = store::agent_home(&agent_id)?;
    // Its home, the user's projects, and its own copy of its project.
    let mut roots = vec![home.clone()];
    if let Ok(projects) = crate::commands::projects::list_projects().await {
        roots.extend(
            projects
                .into_iter()
                .map(|p| std::path::PathBuf::from(p.path)),
        );
    }
    if let Some(copy) = store::get(&agent_id).ok().and_then(|a| a.copy) {
        roots.push(std::path::PathBuf::from(copy.path));
    }
    let (full, action) = files::local_path(&path, &home, &roots, reveal.unwrap_or(false))?;
    files::perform(&full, action)?;
    Ok(action)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    pub name: String,
    pub shape: Option<u8>,
    /// Its shape and face; omitted, the clients derive one from its id.
    #[serde(default)]
    pub avatar: Option<store::AgentLook>,
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
    /// The ready-made agent it started from (`agents::templates`). The
    /// caller sends the instructions it showed; this only marks the agent.
    #[serde(default)]
    pub template: Option<String>,
    /// Routines to set up with it ("Describe the agent you want" drafts
    /// them; the user keeps the ones they ticked).
    #[serde(default)]
    pub routines: Vec<agents::draft::NewRoutine>,
}

/// "Describe the agent you want": a draft to check, nothing created
/// (`agents/draft.rs`).
#[tauri::command]
#[tracing::instrument(skip(description))]
pub async fn agents_draft(description: String) -> Result<agents::draft::Draft, CommandError> {
    agents::draft::draft(&description).await
}

#[tauri::command]
#[tracing::instrument(skip(app, input))]
pub async fn agents_create(
    app: AppHandle,
    input: CreateAgentInput,
) -> Result<store::Agent, CommandError> {
    // Checked whichever way it was chosen: an agent is never put on an
    // engine that can't run its first message.
    // Whatever wasn't given comes from the user's defaults for new agents
    // (Settings → Agents): an empty model is a choice (the engine's own),
    // a missing one isn't.
    let defaults = match (&input.engine, &input.model) {
        (Some(_), Some(_)) => None,
        _ => Some(agents::defaults::view().await),
    };
    let engine = match (input.engine.as_deref(), &defaults) {
        (Some(e), _) => Engine::parse(e)?,
        (None, Some(d)) => d.starts_on,
        (None, None) => Engine::default(),
    };
    engine::require_ready(engine).await?;
    let model = match (input.model.as_deref(), &defaults) {
        (Some(m), _) => engine::normalize_model(engine, m)?,
        (None, Some(d)) => d.model_for(engine),
        (None, None) => None,
    };
    let project = match input.project.as_deref() {
        Some(p) => project::resolve(p).await?.map(|p| p.path),
        None => None,
    };
    let template = match input.template.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(id) => Some(
            templates::find(id)
                .ok_or_else(|| {
                    agents::err_invalid("template", "That ready-made agent doesn't exist.")
                })?
                .id
                .clone(),
        ),
    };
    let agent = store::create(store::NewAgent {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        shape: input.shape,
        avatar: input.avatar,
        color: input.color,
        is_main: false,
    })?;
    let agent = if model.is_some()
        || project.is_some()
        || template.is_some()
        || engine != Engine::default()
    {
        store::update(&agent.id, |a| {
            a.engine = engine;
            a.model = model;
            a.project = project;
            a.template = template;
        })?
    } else {
        agent
    };
    if !input.routines.is_empty() {
        agents::draft::add_routines(&app, &agent.id, &input.routines);
    }
    let agent = store::get(&agent.id).unwrap_or(agent);
    emit_registry(&app);
    Ok(agent)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentInput {
    pub name: Option<String>,
    pub shape: Option<u8>,
    /// Its shape and face; keys this build doesn't draw are ignored.
    #[serde(default)]
    pub avatar: Option<store::AgentLook>,
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
    /// How hard its conversation turns think: `low`, `medium` or `high`;
    /// an empty string goes back to the engine's default.
    #[serde(default)]
    pub effort: Option<String>,
    /// A project path from `list_projects`; an empty string unbinds it.
    pub project: Option<String>,
    /// "Work directly in the project" instead of in a copy of it.
    #[serde(default)]
    pub work_directly: Option<bool>,
    /// "Runs on": one of its engine's accounts (`wallet`), or an empty
    /// string for any account.
    #[serde(default)]
    pub account: Option<String>,
}

#[tauri::command]
#[tracing::instrument(skip(app, input), fields(agent = %agent_id))]
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
    let avatar = input.avatar.and_then(store::AgentLook::normalized);
    let role = input.role.clone();
    let current = store::get(&agent_id)?;
    let engine = match input.engine.as_deref().map(Engine::parse).transpose()? {
        Some(engine) if engine != current.engine => {
            // The terminal is in this engine's session; switching would
            // leave it, and the agent, in two conversations. Checked again,
            // atomically, by `update_settings` below.
            if runner::driven(&agent_id) {
                return Err(runner::driven_refusal(&current.name));
            }
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
    let effort = input
        .effort
        .as_deref()
        .map(store::normalize_effort)
        .transpose()?;
    let project = match input.project.as_deref() {
        Some(p) => Some(project::resolve(p).await?.map(|p| p.path)),
        None => None,
    };
    // An account of the engine it will be on; refused, never guessed at.
    let account = match input.account.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some(id) => {
            let on = engine.unwrap_or(current.engine);
            if !agents::wallet::has(on, id) {
                return Err(agents::err_invalid(
                    "account",
                    format!("That isn't one of the {} accounts here.", on.label()),
                ));
            }
            Some(Some(id.to_string()))
        }
    };
    // A copy open with unkept work stays tied to the project it was made of.
    if let Some(p) = &project {
        agents::task::refuse_rebind(&current, p.as_deref())?;
    }
    // A new engine, or a new folder to work in, would leave the session the
    // user may be driving.
    // Working directly or in a copy moves its folder too.
    let moves_session = engine.is_some()
        || project
            .as_ref()
            .is_some_and(|p: &Option<String>| *p != current.project)
        || input
            .work_directly
            .is_some_and(|d| d != current.work_directly);
    let updated = runner::update_settings(&agent_id, moves_session, |a| {
        if let Some(n) = name {
            a.name = n;
        }
        if let Some(c) = color {
            a.color = c;
        }
        if let Some(s) = shape {
            a.shape = s;
        }
        if let Some(look) = avatar {
            a.avatar = Some(look);
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
        if let Some(e) = effort {
            a.effort = e;
        }
        if let Some(p) = project {
            a.project = p;
        }
        if let Some(direct) = input.work_directly {
            a.work_directly = direct;
        }
        // After the engine: a move clears the account, then this sets it.
        if let Some(account) = account.clone() {
            a.account = account;
        }
    })?;
    // "Work directly" is how it works in its project, in its settings now
    // (`policy`); the field above is the mirror the copy code reads.
    if let Some(direct) = input.work_directly {
        let id = agent_id.clone();
        blocking(move || agents::policy::set_direct(&id, direct)).await?;
    }
    // The name and role are written into CLAUDE.md's heading, so any change
    // to them (or the instructions) rewrites it — memory is preserved.
    if input.instructions.is_some() || input.name.is_some() || input.role.is_some() {
        let instructions = match input.instructions {
            Some(i) => i,
            None => store::read_instructions(&agent_id)?,
        };
        store::write_instructions(&store::agent_home(&agent_id)?, &updated, &instructions)?;
    }
    if let Some(line) = settings_line(&current, &updated, engine.is_some()) {
        let _ = runner::record(
            &app,
            runner::new_message(&agent_id, store::MessageKind::Note, line),
        );
    }
    if let Some(line) = account_line(&current, &updated) {
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

/// The one quiet line in its chat when what its next message runs on
/// changed: the engine, the model or the effort. `None` when none did.
pub(crate) fn settings_line(
    before: &store::Agent,
    after: &store::Agent,
    moved: bool,
) -> Option<String> {
    let changed = moved || before.model != after.model || before.effort != after.effort;
    if !changed {
        return None;
    }
    let model = match after.model.as_deref() {
        Some(m) => model_label(after.engine, m),
        None if moved => String::new(),
        None => format!("{}'s default model", after.engine.label()),
    };
    let effort = match after.effort.as_deref() {
        Some(e) => Some(effort_label(e)),
        // Said only when it is what changed.
        None if before.effort.is_some() => Some("default effort".to_string()),
        None => None,
    };
    let parts: Vec<String> = [Some(model), effort]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    let what = parts.join(" · ");
    Some(if moved {
        if what.is_empty() {
            format!("Runs on {} from its next message", after.engine.label())
        } else {
            format!(
                "Runs on {} · {what} from its next message",
                after.engine.label()
            )
        }
    } else {
        format!("Now on {what} from its next message")
    })
}

/// The one quiet line when what account it runs on changed: "Runs only on
/// Work from its next message." / "Runs on any account from its next
/// message." `None` when it didn't, or only because it moved engine.
pub(crate) fn account_line(before: &store::Agent, after: &store::Agent) -> Option<String> {
    if before.account == after.account || (before.engine != after.engine && after.account.is_none())
    {
        return None;
    }
    Some(match &after.account {
        Some(id) => {
            let name = agents::wallet::of(after.engine)
                .into_iter()
                .find(|a| &a.id == id)
                .map(|a| agents::wallet::labelled(a, true).name)
                .unwrap_or_else(|| "one account".to_string());
            format!(
                "Runs only on {} from its next message",
                agents::wallet::line_name(&name)
            )
        }
        None => "Runs on any account from its next message".to_string(),
    })
}

/// A model by the name its engine lists it under: Claude Code's aliases
/// capitalised ("Opus"), Codex's from its own list, else the id as given.
fn model_label(engine: Engine, model: &str) -> String {
    match engine {
        Engine::Claude => {
            let mut c = model.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        }
        Engine::Codex => agents::codex::models()
            .into_iter()
            .find(|m| m.value == model)
            .map(|m| m.label)
            .unwrap_or_else(|| model.to_string()),
    }
}

fn effort_label(effort: &str) -> String {
    match effort {
        "low" => "Low".into(),
        "medium" => "Medium".into(),
        "high" => "High".into(),
        other => other.to_string(),
    }
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
    // Stopped, the take-over ended (its terminal gone from the copy), then
    // deleted.
    let removed = takeover::delete_agent(&app, &agent_id).await?;
    // Its copy's folder goes once pending work is committed on its branch;
    // a branch with work on it stays.
    if let Some(copy) = removed.copy {
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
    let stopped = runner::stop(&app, &agent_id);
    // The Chief's Stop (here and on the phone) also stops an import it's
    // running; only the import's own messages go, never the user's.
    let import = store::get(&agent_id).is_ok_and(|a| a.is_main) && agents::connector::stop(&app);
    Ok(stopped || import)
}

/// Step into the agent's own session in a terminal: the agent pauses (no
/// turn starts; what arrives waits) until it's handed back. Refused while a
/// turn is in the session; `stop_first` stops that turn (as Stop does,
/// dropping what was queued) and takes over once it has ended.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_take_over(
    app: AppHandle,
    agent_id: String,
    cols: u16,
    rows: u16,
    stop_first: Option<bool>,
) -> Result<takeover::View, CommandError> {
    if stop_first.unwrap_or(false) && takeover::view(&agent_id).is_none() {
        runner::stop(&app, &agent_id);
        // The turn's process tree gets ~1.5s to go, then its exit is waited
        // on for at most 10s (`runner::finish`); wait that out.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while runner::in_turn(&agent_id) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    takeover::begin(&app, &agent_id, cols, rows).await
}

/// Give the session back: the terminal's process ends, the agent resumes,
/// and its next turn continues the same session. Without `force`, refused
/// (`busy`) while the terminal is printing, so the UI can ask first.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_hand_back(
    app: AppHandle,
    agent_id: String,
    force: Option<bool>,
) -> Result<takeover::HandBack, CommandError> {
    Ok(takeover::hand_back(&app, &agent_id, force.unwrap_or(false)).await)
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

/// "Stop this step": end the command the agent is running and let its turn
/// carry on (the engine sees the command end). Says what it did.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_stop_step(agent_id: String) -> Result<String, CommandError> {
    blocking(move || agents::work::stop_step(&agent_id).map_err(CommandError::expected)).await
}

/// "Check on it": what the app can see of the turn right now, in one line
/// (the engine's process, its command's, the CPU, the last progress).
/// Never interrupts the turn.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_check_on(agent_id: String) -> Result<String, CommandError> {
    blocking(move || Ok(agents::work::check_on(&agent_id))).await
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
#[tracing::instrument(skip(app, note))]
pub async fn agents_answer_approval(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    allow: bool,
    always: Option<bool>,
    note: Option<String>,
    choice: Option<usize>,
) -> Result<(), CommandError> {
    // A login card answered with plain Allow / Deny (a phone from before
    // login cards): Allow starts its first way in on this Mac.
    let login = {
        let (a, r) = (agent_id.clone(), request_id.clone());
        blocking(move || Ok(store::find_approval(&a, &r)?.filter(|c| c.login.is_some()))).await?
    };
    // "Bring your Chrome window to the front": Check again or Not now.
    let front = {
        let (a, r) = (agent_id.clone(), request_id.clone());
        blocking(move || Ok(store::find_approval(&a, &r)?.filter(|c| c.front.is_some()))).await?
    };
    if front.is_some() {
        return agents::browser_profiles::answer(&app, &agent_id, &request_id, allow).await;
    }
    // "Needs you in its browser": Not now from anywhere; Step in only from
    // the desk's own button (`agents_step_in`), never a plain Allow.
    let step_in = {
        let (a, r) = (agent_id.clone(), request_id.clone());
        blocking(move || Ok(agents::step_in::is_step_in(&a, &r))).await?
    };
    if step_in {
        if allow {
            return Err(CommandError::expected(agents::step_in::ON_YOUR_MAC));
        }
        return agents::step_in::decline(&app, &agent_id, &request_id).await;
    }
    if login.is_some() {
        return if allow {
            agents::logins::allow_from_old_client(&app, &agent_id, &request_id).await
        } else {
            let note = note
                .map(|n| n.trim().chars().take(MAX_DENY_NOTE).collect::<String>())
                .filter(|n| !n.is_empty());
            blocking(move || agents::logins::decline(&app, &agent_id, &request_id, note.as_deref()))
                .await
        };
    }
    blocking(move || answer_card(&app, &agent_id, &request_id, allow, always, note, choice)).await
}

/* --------------------------------------------------------------- step in */

/// Step into an agent's browser for its card: the tab's window comes
/// forward on this Mac and the agent can't use that tab until Hand back.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_step_in(
    app: AppHandle,
    agent_id: String,
    request_id: String,
) -> Result<(), CommandError> {
    agents::step_in::step_in(&app, &agent_id, &request_id).await
}

/// Bring the tab the user stepped into forward again.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_step_in_show(agent_id: String) -> Result<(), CommandError> {
    agents::step_in::show(&agent_id).await
}

/// Hand the agent its browser back: it's woken with where the page is now.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_step_in_hand_back(
    app: AppHandle,
    agent_id: String,
    request_id: String,
) -> Result<(), CommandError> {
    agents::step_in::hand_back(
        &app,
        &agent_id,
        &request_id,
        crate::agent_browser::step_in::How::HandedBack,
    )
    .await
}

/* ---------------------------------------------------------------- logins */

/// Start one of a login card's ways in, on this Mac (`agents/logins.rs`).
/// Returns at once; the card follows the sign-in.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_login_start(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    option_id: String,
    from_phone: Option<bool>,
    on_phone: Option<bool>,
) -> Result<(), CommandError> {
    agents::logins::start(
        &app,
        &agent_id,
        &request_id,
        &option_id,
        origin(from_phone, on_phone),
    )
    .await
}

fn origin(from_phone: Option<bool>, on_phone: Option<bool>) -> agents::logins::Origin {
    match (from_phone.unwrap_or(false), on_phone.unwrap_or(false)) {
        (_, true) => agents::logins::Origin::phone(true),
        (true, false) => agents::logins::Origin::phone(false),
        _ => agents::logins::Origin::DESK,
    }
}

/// Stop a sign-in under way; the card stays.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_login_cancel(
    app: AppHandle,
    agent_id: String,
    request_id: String,
) -> Result<(), CommandError> {
    agents::logins::cancel(&app, &agent_id, &request_id)
}

/// Decline a login card.
#[tauri::command]
#[tracing::instrument(skip(app, note))]
pub async fn agents_login_decline(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    note: Option<String>,
) -> Result<(), CommandError> {
    let note = note
        .map(|n| n.trim().chars().take(MAX_DENY_NOTE).collect::<String>())
        .filter(|n| !n.is_empty());
    blocking(move || agents::logins::decline(&app, &agent_id, &request_id, note.as_deref())).await
}

/// A login card's API key, from its masked field into the Keychain.
#[tauri::command]
#[tracing::instrument(skip(app, value))]
pub async fn agents_login_save_key(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    value: String,
) -> Result<secrets::Secret, CommandError> {
    blocking(move || agents::logins::save_key(&app, &agent_id, &request_id, &value)).await
}

/// "What your team needs": every login card waiting, one row per service
/// (and those answered since `since`, for the progress line).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_logins_team(
    since: Option<i64>,
) -> Result<agents::logins::TeamLogins, CommandError> {
    blocking(move || Ok(agents::logins::team(since))).await
}

/// Connect one row for every agent on it (but those in `skip`).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_logins_connect(
    app: AppHandle,
    key: String,
    option_id: String,
    skip: Option<Vec<String>>,
    from_phone: Option<bool>,
    on_phone: Option<bool>,
) -> Result<(), CommandError> {
    agents::logins::connect_need(
        &app,
        &key,
        &option_id,
        &skip.unwrap_or_default(),
        origin(from_phone, on_phone),
    )
    .await
}

/// "Not needed": put a login card away without waking the agent.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_login_dismiss(
    app: AppHandle,
    agent_id: String,
    request_id: String,
) -> Result<(), CommandError> {
    blocking(move || agents::logins::dismiss(&app, &agent_id, &request_id)).await
}

/// "Not needed" on a login card: the service it asks for, declined for the
/// whole team and remembered (`agents/declined.rs`).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_login_not_needed(
    app: AppHandle,
    agent_id: String,
    request_id: String,
) -> Result<agents::declined::Receipt, CommandError> {
    blocking(move || agents::declined::decline_card(&app, &agent_id, &request_id)).await
}

/// "Not needed" on rows of "What your team needs" (`keys`), or "Skip the
/// rest" (`keys` absent: every row still waiting).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_logins_not_needed(
    app: AppHandle,
    keys: Option<Vec<String>>,
) -> Result<agents::declined::Receipt, CommandError> {
    blocking(move || {
        let services = agents::declined::rows(keys.as_deref());
        agents::declined::decline(&app, &services)
    })
    .await
}

/// Undo a decline, or "Turn back on" from Settings: returns how many cards
/// came back (only right after the decline).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_logins_undecline(
    app: AppHandle,
    keys: Vec<String>,
) -> Result<usize, CommandError> {
    blocking(move || agents::declined::undo(&app, &keys)).await
}

/// Every app the user chose not to connect (Settings → Agents).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_logins_declined() -> Result<Vec<agents::logins::ReachDeclined>, CommandError> {
    blocking(|| Ok(agents::logins::reach_declined())).await
}

/// "Open again": the sign-in page a waiting card opened, on this Mac.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_login_reopen(
    app: AppHandle,
    agent_id: String,
    request_id: String,
) -> Result<(), CommandError> {
    agents::logins::reopen(&app, &agent_id, &request_id)
}

/// The user is back in the app: claude.ai connectors waiting on a card
/// are checked now rather than at their next 20-second tick.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_logins_recheck() -> Result<(), CommandError> {
    agents::logins::recheck();
    Ok(())
}

/// What one agent can reach: its connections, browser and secrets.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_reach(agent_id: String) -> Result<agents::logins::Reach, CommandError> {
    blocking(move || Ok(agents::logins::reach(&store::get(&agent_id)?))).await
}

/// Take one thing away from what an agent can reach.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_reach_remove(
    app: AppHandle,
    agent_id: String,
    removal: agents::logins::Removal,
) -> Result<agents::logins::Reach, CommandError> {
    let reach = blocking(move || agents::logins::remove(&agent_id, &removal)).await?;
    emit_registry(&app);
    Ok(reach)
}

/* ----------------------------------------------- what it does on its own */

/// "What can this agent do without asking me?" (`agents/on_its_own.rs`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_on_its_own(
    agent_id: String,
) -> Result<agents::on_its_own::OnItsOwn, CommandError> {
    blocking(move || Ok(agents::on_its_own::view(&store::get(&agent_id)?))).await
}

/// The same for the whole team: its level, the rules every agent shares,
/// and each agent in a line.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_on_its_own_team() -> Result<agents::on_its_own::TeamOnItsOwn, CommandError> {
    blocking(agents::on_its_own::team_view).await
}

/// Take one thing away, in one tap: only what the view offers, so nothing
/// here widens. Applied at once, with a line in the agent's chat.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_on_its_own_narrow(
    app: AppHandle,
    agent_id: String,
    narrow: agents::on_its_own::Narrow,
) -> Result<agents::on_its_own::OnItsOwn, CommandError> {
    let id = agent_id.clone();
    let (line, rule) = blocking(move || {
        let line = agents::on_its_own::narrow(&id, &narrow)?;
        let rule = match narrow {
            agents::on_its_own::Narrow::Rule { rule_id } => Some(rule_id),
            _ => None,
        };
        Ok((line, rule))
    })
    .await?;
    // A remembered rule's chat line says "Undone" wherever it's shown.
    if let Some(rule_id) = rule {
        let _ = agents::remember::forget_and_show(&app, &agent_id, &rule_id);
    }
    let _ = runner::record_own(
        &app,
        runner::new_message(&agent_id, store::MessageKind::Note, line),
    );
    emit_registry(&app);
    blocking(move || Ok(agents::on_its_own::view(&store::get(&agent_id)?))).await
}

/* --------------------------------------------------------- what it can do */

/// "What it can do": one agent's settings in plain words (`agents/policy.rs`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_policy(agent_id: String) -> Result<agents::policy::AgentView, CommandError> {
    blocking(move || {
        let agent = store::get(&agent_id)?;
        Ok(agents::policy::agent_view(
            &agents::policy::load(),
            &agent,
            agents::independence::level(),
        ))
    })
    .await
}

/// The team's defaults, the presets, and who has settings of its own.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_policy_team() -> Result<agents::policy::TeamView, CommandError> {
    blocking(move || {
        Ok(agents::policy::team_view(
            &agents::policy::load(),
            &store::list()?,
            agents::independence::level(),
        ))
    })
    .await
}

/// The user changing settings themselves on the desk: applied at once, with
/// a line in that agent's chat. Folders are checked here as on a card.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_policy_set(
    app: AppHandle,
    target: agents::policy::Target,
    mut change: agents::policy::Change,
) -> Result<(), CommandError> {
    for f in &mut change.add_folders {
        f.path = agents::policy::clean_folder(&f.path).map_err(CommandError::expected)?;
    }
    if change.is_empty() {
        return Ok(());
    }
    let level_changed = change.independence.is_some()
        || change.preset.is_some()
        || change.like.is_some()
        || change.same_as_team;
    let app2 = app.clone();
    blocking(move || {
        let agents = store::list()?;
        let before = agents::policy::load();
        let level = agents::independence::level();
        agents::policy::set(&target, &change, &agents)?;
        let after = agents::policy::load();
        let new_level = agents::independence::level();
        let groups = agents::policy_card::groups(&before, &after, &agents, level, new_level);
        // One note in the Chief's chat for a team-wide change; a line for
        // each agent whose own settings changed.
        for (id, line) in agents::policy_card::notes_for(
            &before,
            &after,
            &groups,
            &agents,
            None,
            "Settings changed by you: ",
        ) {
            let _ = runner::record(
                &app2,
                runner::new_message(&id, store::MessageKind::Note, line),
            );
        }
        Ok(())
    })
    .await?;
    // A level raised: open cards it now answers are answered, with a receipt.
    if level_changed {
        let app = app.clone();
        let _ = blocking(move || Ok(agents::mcp::sweep_auto_allowed(&app))).await;
    }
    emit_registry(&app);
    let _ = app.emit(agents::policy_card::EVENT, ());
    Ok(())
}

/// Every connection on this Mac, with who may use it. Never a token.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_connections() -> Result<Vec<agents::connections::Connection>, CommandError> {
    blocking(agents::connections::list).await
}

/// Disconnect for every agent, deleting its Keychain item.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_connection_delete(
    app: AppHandle,
    connection_id: String,
) -> Result<(), CommandError> {
    blocking(move || agents::connections::delete(&connection_id)).await?;
    emit_registry(&app);
    Ok(())
}

pub(crate) fn answer_card(
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
    // One answer per card (`answer_gate`): the desk, the phone, a typed yes
    // and an admin agent racing on this card, exactly one gets past here;
    // the others are told what it answered, and nothing of theirs runs.
    let _claim = agents::answer_gate::claim(
        agent_id,
        request_id,
        &agents::answer_gate::said(allow, always == Some(true), None),
    )?;
    let approval = store::find_approval(agent_id, request_id)?
        .ok_or_else(|| CommandError::expected("That request no longer exists."))?;
    if approval.status != store::ApprovalStatus::Pending {
        return Err(agents::answer_gate::lost(agent_id, request_id));
    }
    // "Needs you in its browser": Step in is the desk's button and Not now
    // its own answer (`agents_answer_approval`), never a plain Allow here
    // (a typed yes, an older path): that closed the card with no hold and
    // never woke the agent.
    if approval.step_in.is_some() {
        return Err(CommandError::expected(agents::step_in::ON_YOUR_MAC));
    }
    // The import connector's own cards: consent, and the staged agents.
    if approval.connector.is_some() {
        return agents::connector::answer_card(app, agent_id, &approval, allow, note);
    }
    // A session's question: keys to the session, and every chat holding the
    // card is answered with it.
    if approval.prompt.is_some() {
        return agents::decisions::answer(app, &approval, allow, choice);
    }
    // "Change this agent's settings?": Allow applies it, here and only here.
    if approval.settings.is_some() {
        return agents::policy_card::answer_card(app, agent_id, &approval, allow, note);
    }
    // "<source> sent what it knows": Save to memory gives it to the Chief as
    // a turn the user authorised; Ignore runs nothing (`handoff`).
    if approval.handoff.is_some() {
        return agents::handoff::answer_card(app, agent_id, &approval, allow);
    }
    // "OK to go on?" between a routine's steps: Go ahead runs the next one
    // as the user's yes to what the card showed; Stop here ends the run.
    if approval.gate.is_some() {
        return agents::routine_steps::answer_card(app, agent_id, &approval, allow);
    }
    // "Carry on with Codex until then?": Always, Just this time or Wait.
    if approval.crossover.is_some() {
        return runner::answer_crossover(app, agent_id, &approval, allow, always == Some(true));
    }
    // "Run turns on “Personal” first?": Allow makes the switch.
    if approval.account_switch.is_some() {
        return agents::usage_tools::answer_switch(app, agent_id, &approval, allow);
    }
    // "Reply in Slack?": Allow posts the exact words shown, as the user.
    if approval.slack_reply.is_some() {
        return agents::slack::answer_card(app, agent_id, &approval, allow);
    }
    if let Some(request) = &approval.secret {
        if allow {
            return Err(CommandError::expected(
                "Type it into the card and choose Save.",
            ));
        }
        return decline_secret(app, agent_id, request_id, request, note.as_deref());
    }
    let scope = if allow && always == Some(true) {
        Some(approval.always.clone().ok_or_else(|| {
            CommandError::expected("This one can't be always allowed. Allow it once instead.")
        })?)
    } else {
        None
    };
    // Write the decision first: only the answer that closed the card grants
    // a plan, keeps a rule or wakes the waiter (and the waiter's own cleanup
    // can't overwrite it).
    let updated = if let Some(scope) = &scope {
        store::allow_always(agent_id, request_id, scope)?
    } else if let Some(note) = &note {
        store::deny_with_note(agent_id, request_id, note)?
    } else {
        store::set_approval_status(agent_id, request_id, status)?
    };
    let Some(message) = updated else {
        return Err(agents::answer_gate::lost(agent_id, request_id));
    };
    let _ = app.emit(runner::EVENT_MESSAGE, &message);
    let rule = match scope {
        Some(_) => Some(mcp::always_allow(agent_id, &approval)?),
        None => None,
    };
    // "Do these under your name?": Allow is the user's OK for each listed
    // action, here and only here (`plan_grant`).
    if let (true, Some(plan)) = (allow, &approval.plan) {
        agents::plan_grant::grant(agent_id, plan, store::now_ms());
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
            // Someone answering it has it.
            let Some(_covered) = agents::answer_gate::try_claim(agent_id, &id, "Always allowed")
            else {
                continue;
            };
            let Some(message) = store::allow_always(agent_id, &id, &scope)? else {
                continue;
            };
            let _ = app.emit(runner::EVENT_MESSAGE, &message);
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
                runner::From::App,
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
            runner::From::App,
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
            runner::From::App,
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

/// A "Deny with note…" is a steer, not an essay.
const MAX_DENY_NOTE: usize = 500;

/// Take back an "Always allow" rule: matching calls ask again. Also the
/// Undo on a "Remembered: …" line, whose rule may be the team's
/// (`agents::remember`); that line then reads as undone, desk and phone.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_revoke_permission(
    app: AppHandle,
    agent_id: String,
    rule_id: String,
) -> Result<(), CommandError> {
    let handle = app.clone();
    blocking(move || agents::remember::forget_and_show(&handle, &agent_id, &rule_id)).await?;
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

/// Tokens and cost for one agent: this week and all time, and each routine's week.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_usage(agent_id: String) -> Result<usage::UsageSummary, CommandError> {
    Ok(usage::summarize(&store::get(&agent_id)?, usage::today()))
}

/// How much of each engine's plan is used, as the engine last reported it.
/// Empty when no engine has said (an API-key login, or no turn yet).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_quota() -> Result<Vec<agents::quota::Quota>, CommandError> {
    tokio::task::spawn_blocking(|| agents::quota::shown(&agents::quota::load(), store::now_ms()))
        .await
        .map_err(agents::err_other)
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
#[tracing::instrument(skip(app, picks))]
pub async fn agents_import_review_apply(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    picks: agents::review::Picks,
) -> Result<agents::review::Applied, CommandError> {
    blocking(move || agents::connector::apply_review(&app, &agent_id, &request_id, &picks)).await
}

/// The user answered the plan's playback: nothing to add (`addition` empty:
/// the review comes up), or what's missing, which goes back to the sealed
/// interview to fold in before the plan is played back again.
#[tauri::command]
#[tracing::instrument(skip(app, addition))]
pub async fn agents_import_playback_answer(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    addition: Option<String>,
) -> Result<(), CommandError> {
    blocking(move || {
        // One answer per card (`answer_gate`), as on every other card.
        let _claim = agents::answer_gate::claim(&agent_id, &request_id, "Answered")?;
        agents::connector::answer_playback(&app, &agent_id, &request_id, addition)
    })
    .await
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

/// What the user sends their old assistant for a reply that covers
/// everything (`import_export::PROMPT`): the path that needs no remote access.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_export_prompt() -> Result<String, CommandError> {
    Ok(agents::import_export::PROMPT.to_string())
}

/// What a pasted reply holds, what's still missing and the follow-up that
/// asks for it. Read only.
#[tauri::command]
#[tracing::instrument(skip(text))]
pub async fn agents_import_text_preview(
    text: String,
) -> Result<agents::import_export::Preview, CommandError> {
    blocking(move || {
        Ok(agents::import_export::preview(
            &agents::import_export::read_text(&text),
        ))
    })
    .await
}

/// Put a pasted reply up as one review card in the Chief's chat. Nothing is
/// created until the user presses Import there.
#[tauri::command]
#[tracing::instrument(skip(app, text))]
pub async fn agents_import_text_review(
    app: AppHandle,
    text: String,
) -> Result<agents::import_export::Posted, CommandError> {
    blocking(move || agents::import_export::post(&app, &agents::import_export::read_text(&text)))
        .await
}

/// What an export file or folder the user picked holds. Read only: only
/// text files, never credential files (`import_formats`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_file_preview(
    path: String,
) -> Result<agents::import_export::Preview, CommandError> {
    blocking(move || {
        Ok(agents::import_export::preview(
            &agents::import_export::read_path(std::path::Path::new(&path)),
        ))
    })
    .await
}

/// Put an export file or folder up as one review card in the Chief's chat,
/// read again now (never the preview's copy).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_import_file_review(
    app: AppHandle,
    path: String,
) -> Result<agents::import_export::Posted, CommandError> {
    blocking(move || {
        agents::import_export::post(
            &app,
            &agents::import_export::read_path(std::path::Path::new(&path)),
        )
    })
    .await
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
    then: Option<Vec<agents::routine_steps::Step>>,
) -> Result<schedule::CheckIn, CommandError> {
    let created =
        schedule::create_with_steps(&agent_id, &when, &note, then.as_deref().unwrap_or(&[]))?;
    agents::mcp::created_routine_line(&app, &agent_id, &created.check_in);
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
    then: Option<Vec<agents::routine_steps::Step>>,
) -> Result<schedule::CheckIn, CommandError> {
    let edited = schedule::edit_with_steps(&agent_id, &id, &when, &note, then.as_deref())?;
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

/// Add a "When…" routine: `source` is `watch::Source` (`{ kind, folder?, check?, app? }`).
#[tauri::command]
#[tracing::instrument(skip(app, note))]
pub async fn agents_watch_create(
    app: AppHandle,
    agent_id: String,
    source: agents::watch::Source,
    every_minutes: u32,
    note: String,
) -> Result<schedule::CheckIn, CommandError> {
    let created = agents::watch::create(&agent_id, source, every_minutes, &note)?;
    agents::mcp::created_routine_line(&app, &agent_id, &created.check_in);
    emit_registry(&app);
    Ok(created.check_in)
}

/// Change what a "When…" routine waits for, how often it checks, and what it does.
#[tauri::command]
#[tracing::instrument(skip(app, note))]
pub async fn agents_watch_update(
    app: AppHandle,
    agent_id: String,
    id: String,
    source: agents::watch::Source,
    every_minutes: u32,
    note: String,
) -> Result<schedule::CheckIn, CommandError> {
    let edited = agents::watch::edit(&agent_id, &id, source, every_minutes, &note)?;
    emit_registry(&app);
    Ok(edited)
}

/// Check a "When…" routine now; the agent is woken only if something's new.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_watch_check_now(
    app: AppHandle,
    agent_id: String,
    id: String,
) -> Result<agents::watch::CheckOutcome, CommandError> {
    agents::watch::check_now(&app, &agent_id, &id).await
}

/// Claude Code's own MCP servers, as Claude Code lists them.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_apps_list() -> Result<apps::Apps, CommandError> {
    apps::list().await
}

/// "Apps your agents can use": the apps we sign in to ourselves, the
/// connections made, and any sign-in under way (`agents/app_connect.rs`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_app_connections() -> Result<agents::app_connect::Overview, CommandError> {
    blocking(agents::app_connect::overview).await
}

/// Connect an app in this Mac's browser, for exactly the agents ticked.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_app_connect(
    app: AppHandle,
    service: String,
    grants: Vec<agents::app_connect::GrantInput>,
    again: Option<String>,
) -> Result<(), CommandError> {
    agents::app_connect::start(&app, &service, &grants, again.as_deref()).await
}

/// Stop a sign-in the apps dialog started.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_app_connect_cancel(
    app: AppHandle,
    service: String,
) -> Result<(), CommandError> {
    agents::app_connect::cancel(&app, &service)
}

/// "Open again" in the apps dialog.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_app_connect_reopen(
    app: AppHandle,
    service: String,
) -> Result<(), CommandError> {
    agents::app_connect::reopen(&app, &service)
}

/// Exactly these agents may use a connection, each as ticked.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_connection_set_grants(
    connection_id: String,
    grants: Vec<agents::app_connect::GrantInput>,
) -> Result<agents::connections::Connection, CommandError> {
    blocking(move || agents::app_connect::set_grants(&connection_id, &grants)).await
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

/// Change the defaults for new agents; a field left out stays as it is, an
/// empty model is the engine's own. Refused, and nothing saved, for an engine
/// that isn't installed and signed in or a model its engine doesn't offer.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_defaults(
    app: AppHandle,
    change: agents::defaults::Change,
) -> Result<agents::defaults::View, CommandError> {
    let view = agents::defaults::set(change).await?;
    // The overview carries it: the desk's editor and the phone pick it up.
    emit_registry(&app);
    Ok(view)
}

/// The user's own switch (the agent editor, the phone): "Admin — can manage
/// and approve for other agents". No agent tool reaches it. Takes effect from
/// the agent's next call; its chat gets a line saying so.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_admin(
    app: AppHandle,
    agent_id: String,
    admin: bool,
) -> Result<store::Agent, CommandError> {
    let agent = blocking(move || {
        let agent = agents::admin::set_admin(&agent_id, admin)?;
        let line = if admin {
            "You made this agent an admin: it can manage the other agents and answer their local requests"
        } else {
            "Admin turned off: it no longer manages or answers for other agents"
        };
        let _ = store::append_message(&runner::new_message(
            &agent.id,
            store::MessageKind::Note,
            line,
        ));
        Ok(agent)
    })
    .await?;
    emit_registry(&app);
    Ok(agent)
}

/// Settings → Agents → Admin activity: what admins did, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_admin_activity(
    limit: Option<usize>,
) -> Result<Vec<agents::admin::Activity>, CommandError> {
    blocking(move || Ok(agents::admin::activity(limit.unwrap_or(100).min(500)))).await
}

/// Settings → Agents → Recently deleted: agents an admin deleted, restorable
/// for 30 days. Ones past that are purged here.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_recently_deleted() -> Result<Vec<agents::admin::DeletedView>, CommandError> {
    blocking(|| {
        agents::admin::purge_expired();
        Ok(agents::admin::recently_deleted())
    })
    .await
}

/// Bring a deleted agent back, as it was.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_restore(
    app: AppHandle,
    agent_id: String,
) -> Result<store::Agent, CommandError> {
    let agent = blocking(move || {
        let agent = store::restore(&agent_id)?;
        runner::undelete(&agent.id);
        store::refresh_pending(&agent.id);
        let _ = store::append_message(&runner::new_message(
            &agent.id,
            store::MessageKind::Note,
            "Restored from Recently deleted",
        ));
        Ok(agent)
    })
    .await?;
    emit_registry(&app);
    Ok(agent)
}

/// How much agents do on their own.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_independence() -> Result<agents::independence::Level, CommandError> {
    blocking(|| Ok(agents::independence::level())).await
}

/// The user's own choice (onboarding, Settings, ⌘K, the phone): no card.
/// It changes what agents are told on their next turn, never what asks.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_independence(
    app: AppHandle,
    level: String,
) -> Result<agents::independence::Level, CommandError> {
    let level = agents::independence::Level::parse(&level)?;
    blocking(move || agents::independence::set_level(level, store::now_ms())).await?;
    // Open cards the new level answers are answered now, with a receipt.
    {
        let app = app.clone();
        let _ = blocking(move || Ok(agents::mcp::sweep_auto_allowed(&app))).await;
    }
    // The overview carries it: Settings and the phone pick it up.
    emit_registry(&app);
    Ok(level)
}

/// The answer to "bring your agents from another assistant, or start
/// fresh?" (onboarding's last step, the Chief's one-time card, the phone).
/// The overview carries it, so the desk and the phone agree.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_import_choice(
    app: AppHandle,
    choice: String,
) -> Result<agents::import_choice::Choice, CommandError> {
    let choice = agents::import_choice::Choice::parse(&choice)?;
    blocking(move || agents::import_choice::set(choice, store::now_ms())).await?;
    emit_registry(&app);
    Ok(choice)
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

/// Settings → Agents, "Disk space": free space and every large agent home (`agents::disk`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_disk_overview() -> Result<agents::disk::Overview, CommandError> {
    blocking(|| Ok(agents::disk::overview())).await
}

/// Settings → Agents → Notifications, "Quiet hours": the team's window, or
/// `None` when off (`agents::quiet`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_quiet_hours() -> Result<Option<agents::quiet::Window>, CommandError> {
    blocking(|| Ok(agents::quiet::get())).await
}

/// Set (or with `None`, turn off) quiet hours from Settings or the phone:
/// the user's own choice, applied at once. They only hold things back.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_set_quiet_hours(
    app: AppHandle,
    window: Option<agents::quiet::Window>,
) -> Result<Option<agents::quiet::Window>, CommandError> {
    let saved = set_quiet_hours(window)?;
    let _ = app.emit(agents::quiet::EVENT, ());
    Ok(saved)
}

/// The one write behind Settings and the phone.
pub(crate) fn set_quiet_hours(
    window: Option<agents::quiet::Window>,
) -> Result<Option<agents::quiet::Window>, CommandError> {
    let window = window
        .map(agents::quiet::checked)
        .transpose()
        .map_err(CommandError::expected)?;
    agents::quiet::set(window, store::now_ms())?;
    tracing::info!(
        on = window.is_some(),
        "[Agents] quiet hours set from settings"
    );
    Ok(window)
}

/// "Free up space": an agent home's dependency and build folders, regenerable ones only.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_disk_free_up(agent_id: String) -> Result<agents::disk::Freed, CommandError> {
    let id = agent_id.clone();
    blocking(move || agents::store::get(&id).map(|_| ())).await?;
    Ok(agents::disk::free_up(&agent_id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_quiet_line_says_what_the_next_message_runs_on() {
        let base: store::Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "A", "shape": 0, "color": "blue", "createdAt": 0
        }))
        .unwrap();
        let with = |f: &dyn Fn(&mut store::Agent)| {
            let mut a = base.clone();
            f(&mut a);
            a
        };
        assert_eq!(settings_line(&base, &base, false), None);
        let opus_high = with(&|a| {
            a.model = Some("opus".into());
            a.effort = Some("high".into());
        });
        assert_eq!(
            settings_line(&base, &opus_high, false).as_deref(),
            Some("Now on Opus · High from its next message")
        );
        let back = with(&|a| a.model = Some("opus".into()));
        assert_eq!(
            settings_line(&opus_high, &back, false).as_deref(),
            Some("Now on Opus · default effort from its next message")
        );
        let default_low = with(&|a| a.effort = Some("low".into()));
        assert_eq!(
            settings_line(&base, &default_low, false).as_deref(),
            Some("Now on Claude Code's default model · Low from its next message")
        );
        let codex = with(&|a| a.engine = Engine::Codex);
        assert_eq!(
            settings_line(&base, &codex, true).as_deref(),
            Some("Runs on Codex from its next message")
        );
    }

    #[test]
    fn runs_on_says_one_quiet_line_and_an_agent_shows_the_account_it_ran_on() {
        with_chief(|_| {
            let work = agents::wallet::add(Engine::Claude, "Work").unwrap();
            let base: store::Agent = serde_json::from_value(serde_json::json!({
                "id": "a", "name": "A", "shape": 0, "color": "blue", "createdAt": 0
            }))
            .unwrap();
            let mut pinned = base.clone();
            pinned.account = Some(work.id.clone());
            assert_eq!(
                account_line(&base, &pinned).as_deref(),
                Some("Runs only on Work from its next message")
            );
            assert_eq!(
                account_line(&pinned, &base).as_deref(),
                Some("Runs on any account from its next message")
            );
            assert_eq!(account_line(&base, &base), None);
            // Moving engine clears it, and the engine's own line says enough.
            let mut moved = pinned.clone();
            moved.switch_engine(Engine::Codex);
            assert_eq!(moved.account, None);
            assert_eq!(account_line(&pinned, &moved), None);

            // The chip: only once its engine has more than one account.
            assert_eq!(ran_on(&base, &[(Engine::Claude, 1)]), None);
            let counts = account_counts();
            assert_eq!(ran_on(&base, &counts), None, "nothing recorded yet");
            agents::wallet::ran_on("a", &work);
            assert_eq!(
                ran_on(&base, &counts),
                Some(RanOn {
                    id: work.id.clone(),
                    name: "Work".into()
                })
            );
            assert_eq!(
                crate::agents::runner::pinned_out_line("Riley", "Work"),
                "Riley runs only on Work, which is out of usage. To carry on with another account, set Runs on to Any account in its … menu."
            );
        });
    }

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

/* ------------------------------------------------------- usage wallets */

/// Tell every window the accounts changed (Settings, the phone).
const EVENT_ACCOUNTS: &str = "agents-accounts-changed";

/// Every engine's accounts, in priority order, with whether each is signed
/// in and the last usage limit a turn on it hit (`agents::wallet`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_accounts() -> Result<Vec<agents::wallet::AccountView>, CommandError> {
    Ok(agents::wallet::views().await)
}

/// Add an account for an engine. It isn't signed in yet: Settings runs the
/// sign-in into its own folder next (`claude_connect_start` /
/// `workspace_connect_start` with this id).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_account_add(
    app: AppHandle,
    engine: String,
    name: String,
) -> Result<agents::wallet::Account, CommandError> {
    let engine = Engine::parse(&engine)?;
    let account = tokio::task::spawn_blocking(move || agents::wallet::add(engine, &name))
        .await
        .map_err(agents::err_other)??;
    let _ = app.emit(EVENT_ACCOUNTS, ());
    Ok(account)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_account_rename(
    app: AppHandle,
    engine: String,
    id: String,
    name: String,
) -> Result<agents::wallet::Account, CommandError> {
    let engine = Engine::parse(&engine)?;
    let account = agents::wallet::rename(engine, &id, &name)?;
    let _ = app.emit(EVENT_ACCOUNTS, ());
    Ok(account)
}

/// Put an engine's accounts in this order (first is tried first).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_account_reorder(
    app: AppHandle,
    engine: String,
    ids: Vec<String>,
) -> Result<Vec<agents::wallet::Account>, CommandError> {
    let engine = Engine::parse(&engine)?;
    let accounts = agents::wallet::reorder(engine, &ids)?;
    let _ = app.emit(EVENT_ACCOUNTS, ());
    Ok(accounts)
}

/// What removing an account did, for the UI: `waiting` is the line saying
/// it goes when the turns running on it end ("Removing after Finance's turn
/// ends."); absent when it went at once.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRemoval {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
}

/// Remove an added account and its sign-in from this Mac. A turn running on
/// it finishes first: the account leaves the list now, and its folder and
/// sign-in go when that turn ends (`wallet::remove`).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_account_remove(
    app: AppHandle,
    engine: String,
    id: String,
) -> Result<AccountRemoval, CommandError> {
    let engine = Engine::parse(&engine)?;
    let gone = id.clone();
    let removed = {
        let id = id.clone();
        tokio::task::spawn_blocking(move || agents::wallet::remove(engine, &id))
            .await
            .map_err(agents::err_other)??
    };
    let waiting = match removed {
        agents::wallet::Removed::Now => None,
        agents::wallet::Removed::After(agent_ids) => {
            let names: Vec<String> = agent_ids
                .iter()
                .map(|a| {
                    store::get(a)
                        .map(|a| a.name)
                        .unwrap_or_else(|_| "an agent".into())
                })
                .collect();
            let finisher = app.clone();
            tauri::async_runtime::spawn(async move {
                agents::wallet::wait_unused(engine, &id).await;
                let done =
                    tokio::task::spawn_blocking(move || agents::wallet::finish_remove(engine, &id))
                        .await;
                if let Err(e) = done {
                    tracing::warn!("[Agents] finishing an account's removal failed: {e}");
                }
                let _ = finisher.emit(EVENT_ACCOUNTS, ());
            });
            Some(agents::wallet::removing_after_line(&names))
        }
    };
    // An agent set to run on it runs on any account again.
    for agent in store::list()?
        .into_iter()
        .filter(|a| a.engine == engine && a.account.as_deref() == Some(gone.as_str()))
    {
        let _ = store::update(&agent.id, |a| a.account = None);
        let _ = runner::record(
            &app,
            runner::new_message(
                &agent.id,
                store::MessageKind::Note,
                "Runs on any account from its next message: the one it was set to was removed"
                    .to_string(),
            ),
        );
    }
    emit_registry(&app);
    let _ = app.emit(EVENT_ACCOUNTS, ());
    Ok(AccountRemoval { waiting })
}

/// "Use this one now": the account goes first in its engine's order, so
/// every turn that starts from now on tries it first (`wallet::use_first`).
/// A turn already running finishes on its account; an agent set to run on
/// one account stays on it. Refused for an account that isn't signed in:
/// turns would pass over it, which isn't what was asked.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_account_use(
    app: AppHandle,
    engine: String,
    id: String,
) -> Result<Vec<agents::wallet::AccountView>, CommandError> {
    let engine = Engine::parse(&engine)?;
    let account = agents::wallet::of(engine)
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That account isn't in the list any more."))?;
    if !agents::wallet::signed_in(&account).await {
        return Err(CommandError::expected(format!(
            "Sign {} in first.",
            agents::wallet::line_name(&agents::wallet::labelled(account, false).name)
        )));
    }
    let to = id.clone();
    tokio::task::spawn_blocking(move || agents::wallet::use_first(engine, &to))
        .await
        .map_err(agents::err_other)??;
    tracing::info!(engine = engine.label(), account = %id, "[Agents] account put first");
    let _ = app.emit(EVENT_ACCOUNTS, ());
    // The usage view's "used next" moves with it, at once.
    let _ = app.emit(runner::EVENT_USAGE_PLAN, ());
    Ok(agents::wallet::views().await)
}

/* ------------------------------------------------- setting up your team */

/// "Setting up your team" after an import (`agents::team_setup`): the
/// checklist as the card shows it, or `None` when there's none to show.
/// `any` includes one the user put away (its `dismissed` says so), for ⌘K
/// and What's in flight to offer it again.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_team_setup(
    any: Option<bool>,
) -> Result<Option<agents::team_setup::SetupView>, CommandError> {
    blocking(move || {
        Ok(if any.unwrap_or(false) {
            agents::team_setup::view_any()
        } else {
            agents::team_setup::view()
        })
    })
    .await
}

/// Bring back a checklist the user put away.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_reopen(app: AppHandle) -> Result<(), CommandError> {
    blocking(agents::team_setup::reopen).await?;
    agents::team_setup::emit(&app);
    Ok(())
}

/// Mark a step done or skipped, or open it again.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_step(
    app: AppHandle,
    step: agents::team_setup::StepId,
    state: agents::team_setup::StepState,
) -> Result<(), CommandError> {
    blocking(move || agents::team_setup::set_step(step, state)).await?;
    agents::team_setup::emit(&app);
    Ok(())
}

/// Switch one of an imported agent's routines on or off from the card.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_routine(
    app: AppHandle,
    agent_id: String,
    check_in_id: String,
    on: bool,
) -> Result<(), CommandError> {
    blocking(move || agents::team_setup::set_routine(&agent_id, &check_in_id, on)).await?;
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    agents::team_setup::emit(&app);
    Ok(())
}

/// "Say hi": the user's hello to one imported agent, which wakes it. One at
/// a time: while another is still replying to its hello, this waits.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_hello(
    app: AppHandle,
    agent_id: String,
) -> Result<store::AgentMessage, CommandError> {
    let agent = store::get(&agent_id)?;
    let setup = agents::team_setup::load()
        .filter(|s| s.agents.contains(&agent_id))
        .ok_or_else(|| CommandError::expected("That agent isn't part of this setup."))?;
    if let Some(busy) = setup
        .agents
        .iter()
        .filter(|id| **id != agent_id && setup.greeted.contains(id))
        .filter(|id| runner::is_working(id))
        .find_map(|id| store::get(id).ok())
    {
        return Err(CommandError::expected(format!(
            "{} is still replying. Say hi to {} once it's done.",
            busy.name, agent.name
        )));
    }
    let text = agents::team_setup::hello_text(&agent.name);
    let sent = send_as(app.clone(), agent_id, text, None, None, None, None, false).await?;
    agents::team_setup::emit(&app);
    Ok(sent)
}

/// Hand everything the agents said they're missing to the Chief in one
/// message (the user's, shown in its chat), and tick the step.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_missing(
    app: AppHandle,
) -> Result<store::AgentMessage, CommandError> {
    let view = blocking(|| {
        agents::team_setup::view()
            .ok_or_else(|| CommandError::expected("There's nothing to set up."))
    })
    .await?;
    let text = agents::team_setup::missing_text(&view)
        .ok_or_else(|| CommandError::expected("Nobody said they're missing anything."))?;
    let chief = blocking(agents::ensure_main).await?;
    let sent = send_as(app.clone(), chief.id, text, None, None, None, None, false).await?;
    blocking(|| {
        agents::team_setup::set_step(
            agents::team_setup::StepId::Missing,
            agents::team_setup::StepState::Done,
        )
    })
    .await?;
    agents::team_setup::emit(&app);
    Ok(sent)
}

/// Put the checklist away; ⌘K and What's in flight bring it back.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_dismiss(app: AppHandle) -> Result<(), CommandError> {
    blocking(agents::team_setup::dismiss).await?;
    agents::team_setup::emit(&app);
    Ok(())
}

/* ------------------------------------------- your browser, reach check */

/// "Let agents use your browser": the guided card, checked now (Claude
/// Code's sign-in, the extension, whether a browser answers). Opens nothing.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_browser_status() -> Result<agents::browser::BrowserStatus, CommandError> {
    Ok(agents::browser::status().await)
}

/// Switch the team's browser on: only once a browser answers.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_browser_enable(
    app: AppHandle,
) -> Result<agents::browser::BrowserStatus, CommandError> {
    let st = agents::browser::enable(&app).await?;
    // Now that it's on, the checklist's rows can be checked in the browser too.
    agents::access_check::spawn(&app);
    Ok(st)
}

/// The phone signing in through this Mac's Chrome right now, for the desk's
/// bar (`agents/phone_signin.rs`). `None`: nothing is.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_phone_signin_status(
) -> Result<Option<agents::phone_signin::Banner>, CommandError> {
    Ok(agents::phone_signin::banner())
}

/// The desk's Stop: the phone's sign-in ends and its tab closes.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_phone_signin_stop(app: AppHandle) -> Result<(), CommandError> {
    agents::phone_signin::stop_from_desk(&app).await;
    Ok(())
}

/// Settings → Agents → "Agents' browser": the switch, whether Chrome is
/// here and running, and the two permissions the plain-window sign-in from
/// the phone needs (`agent_browser`).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_agent_browser_status() -> Result<crate::agent_browser::Status, CommandError> {
    tokio::task::spawn_blocking(crate::agent_browser::status)
        .await
        .map_err(agents::err_other)
}

/// Settings → Agents → "Your Chrome": the switch, the host, the extension
/// and the connected profiles, read back from the Mac.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_user_chrome_status() -> Result<crate::user_chrome::Status, CommandError> {
    tokio::task::spawn_blocking(crate::user_chrome::status)
        .await
        .map_err(agents::err_other)
}

/// Turn "Your Chrome" on (listen, set up the host, stage the extension) or
/// off (stop listening; every connected Chrome hears so).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_user_chrome_set_enabled(
    on: bool,
) -> Result<crate::user_chrome::Status, CommandError> {
    crate::user_chrome::set_enabled(on).await
}

/// Show the extension's folder in Finder, for Chrome's "Load unpacked".
#[tauri::command]
#[tracing::instrument]
pub async fn agents_user_chrome_show_extension() -> Result<(), CommandError> {
    let dir = crate::user_chrome::install::staged_extension_dir();
    if !dir.join("manifest.json").is_file() {
        return Err(CommandError::expected(
            "The extension's files aren't set up yet. Turn Your Chrome on first.",
        ));
    }
    let mut cmd = tokio::process::Command::new("open");
    cmd.arg("-R").arg(dir.join("manifest.json"));
    crate::external_command::run_with_timeout(cmd, "open -R", 10)
        .await
        .map(|_| ())
}

/// Open Chrome's extensions page (where Developer mode and Load unpacked are).
#[tauri::command]
#[tracing::instrument]
pub async fn agents_user_chrome_open_extensions_page() -> Result<(), CommandError> {
    // `open` hands chrome:// URLs to Chrome as a launch argument, which it
    // ignores for its own pages; asking Chrome for a new tab works.
    let mut cmd = tokio::process::Command::new("osascript");
    cmd.arg("-e")
        .arg(crate::user_chrome::install::OPEN_EXTENSIONS_SCRIPT);
    if crate::external_command::run_with_timeout(cmd, "open chrome://extensions", 15)
        .await
        .is_ok()
    {
        return Ok(());
    }
    let mut cmd = tokio::process::Command::new("open");
    cmd.args(["-a", "Google Chrome", "chrome://extensions/"]);
    crate::external_command::run_with_timeout(cmd, "open chrome://extensions", 10)
        .await
        .map(|_| ())
}

/// Once the Web Store listing exists: ask Chrome to offer it (External
/// Extensions, "Enable" on Chrome's next start) and open its page.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_user_chrome_add_from_store() -> Result<(), CommandError> {
    let (Some(id), Some(url)) = (
        crate::brand::chrome::WEB_STORE_ID,
        crate::user_chrome::install::web_store_url(),
    ) else {
        return Err(CommandError::expected(
            "The extension isn't on the Chrome Web Store yet: add it with Load unpacked.",
        ));
    };
    if let Some(udd) = crate::user_chrome::install::chrome_user_data_dir() {
        crate::user_chrome::install::write_external_extension(&udd, id)
            .map_err(agents::err_other)?;
    }
    let mut cmd = tokio::process::Command::new("open");
    cmd.arg(&url);
    crate::external_command::run_with_timeout(cmd, "open the Web Store", 10)
        .await
        .map(|_| ())
}

/// The switch. Off closes the agents' Chrome.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_agent_browser_set_enabled(
    on: bool,
) -> Result<crate::agent_browser::Status, CommandError> {
    tokio::task::spawn_blocking(move || crate::agent_browser::set_enabled(on))
        .await
        .map_err(agents::err_other)?
}

/// "Watch its browser" under a working agent: its current page in the
/// agents' browser comes on screen and in front (`show`), or goes back to
/// its corner. Only that agent's own tab; nothing is started.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_show_agent_browser(agent_id: String, show: bool) -> Result<(), CommandError> {
    tokio::task::spawn_blocking(move || {
        crate::agent_browser::service::show_agent(&agent_id, show).map_err(CommandError::expected)
    })
    .await
    .map_err(agents::err_other)?
}

/// The live preview under a working agent (`agent_browser::live`): the next
/// frame of its current page after `after`, waiting up to a moment for one.
/// `large` is the pane beside the chat. `None` when it has no page open or
/// nothing new came. Each ask renews the watch; asking stops when the chat
/// isn't on screen, and the screencast stops with it.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_browser_live_frame(
    agent_id: String,
    after: u64,
    large: bool,
) -> Result<Option<crate::agent_browser::live::LiveFrame>, CommandError> {
    use crate::agent_browser::live;
    tokio::task::spawn_blocking(move || {
        live::frame(
            &agent_id,
            after,
            if large { live::LARGE } else { live::THUMB },
        )
    })
    .await
    .map_err(agents::err_other)
}

/// The preview went off screen: stop its screencast now, not at the lease's end.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_browser_live_stop(agent_id: String, large: bool) -> Result<(), CommandError> {
    use crate::agent_browser::live;
    tokio::task::spawn_blocking(move || {
        live::stop(&agent_id, if large { live::LARGE } else { live::THUMB })
    })
    .await
    .map_err(agents::err_other)
}

/// The guided permission card: ask macOS for Screen Recording (its own
/// prompt, once) and open System Settings at the pane for `which`
/// ("screen_recording" or "accessibility"). Only those two panes open.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_agent_browser_permission(
    which: String,
) -> Result<crate::agent_browser::Status, CommandError> {
    use crate::agent_browser::macos;
    let pane = match which.as_str() {
        "screen_recording" => {
            let _ = tokio::task::spawn_blocking(macos::request_screen_recording).await;
            macos::SCREEN_RECORDING_PANE
        }
        "accessibility" => macos::ACCESSIBILITY_PANE,
        _ => {
            return Err(CommandError::expected(
                "That isn't one of the two permissions.",
            ))
        }
    };
    tauri_plugin_opener::open_url(pane, None::<&str>)
        .map_err(|_| CommandError::expected("Couldn't open System Settings."))?;
    Ok(crate::agent_browser::status())
}

/// Open the extension's install page in this Mac's browser. Only the
/// setup's own URL: nothing from the webview is opened.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_browser_open_install() -> Result<(), CommandError> {
    tauri_plugin_opener::open_url(agents::browser::INSTALL_URL, None::<&str>)
        .map_err(|_| CommandError::expected("Couldn't open this Mac's browser."))
}

/// "Checking what your team can already reach": run it now. Returns how
/// many services it reached; progress arrives on the checklist.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_access_check(app: AppHandle) -> Result<usize, CommandError> {
    agents::access_check::run(&app).await
}

/// A row nothing reached: "connect" (one sign-in card, started now) or
/// "not_needed". Returns the card raised, for showing it in place.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_team_setup_later(
    app: AppHandle,
    key: String,
    action: String,
    from_phone: Option<bool>,
    on_phone: Option<bool>,
) -> Result<Option<agents::access_check::Raised>, CommandError> {
    match action.as_str() {
        "connect" => {
            let (agent_id, request_id) =
                agents::access_check::connect(&app, &key, origin(from_phone, on_phone)).await?;
            Ok(Some(agents::access_check::Raised {
                agent_id,
                request_id,
            }))
        }
        "not_needed" => {
            blocking(move || agents::access_check::not_needed(&app, &key)).await?;
            Ok(None)
        }
        _ => Err(agents::err_invalid("action", "connect or not_needed")),
    }
}
