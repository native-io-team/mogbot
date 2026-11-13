//! One turn on one account: the engine process, its stream turned into the chat and the timeline, and how it ends.

use super::*;

/// Wait for `claude` to exit, at most [`EXIT_BOUND`] (a moment, once its
/// result is in and only background work could be keeping it); then stop
/// its tree.
/// A dev server someone is looking at is spared (`dev_servers`), when the
/// turn ended normally (`settle`). Returns whether that was decided here.
pub(super) async fn finish(
    child: &mut tokio::process::Child,
    pid: Option<u32>,
    done: bool,
    agent_id: &str,
    settle: bool,
) -> (std::io::Result<std::process::ExitStatus>, bool) {
    let bound = if done {
        Duration::from_secs(2)
    } else {
        EXIT_BOUND
    };
    if let Ok(status) = tokio::time::timeout(bound, child.wait()).await {
        return (status, false);
    }
    tracing::info!(
        "[Agents] Claude Code is still running after its turn; stopping it and what it started"
    );
    let spare = if settle {
        super::dev_servers::turn_ended(agent_id, pid).await
    } else {
        Vec::new()
    };
    if let Some(pid) = pid {
        let _ =
            tokio::task::spawn_blocking(move || procs::kill_tree_sparing_sync(pid, &spare)).await;
    }
    let _ = child.start_kill();
    (child.wait().await, settle)
}

/// Note what runs under the engine now, for `dev_servers` at the turn's end.
pub(super) async fn note_engine_tree(agent_id: &str, pid: u32) {
    if let Ok(Some(rows)) = tokio::task::spawn_blocking(procs::snapshot).await {
        super::dev_servers::note_tree(agent_id, &rows, pid);
    }
}

/// A reply, as the chat keeps it: its links to this Mac taken out of the
/// text (`local_links`), under its draft's id so it takes the draft's place.
pub(super) async fn record_reply(
    app: &AppHandle,
    agent_id: &str,
    draft_id: Option<String>,
    text: String,
) {
    let mut message = new_message(agent_id, MessageKind::Agent, text);
    if let Some(id) = draft_id {
        message.id = id;
    }
    let message = super::local_links::apply(message).await;
    for link in message.local_links.iter().filter(|l| l.path.is_some()) {
        super::dev_servers::note_shown_port(agent_id, link.port);
    }
    record_off(app, message).await;
}

/// What became of a held line (`narration`): a note in the timeline, its
/// draft withdrawn; or the reply.
pub(super) async fn settle_narration(
    app: &AppHandle,
    agent_id: &str,
    fate: Option<super::narration::Fate>,
    said_anything: &mut bool,
) {
    use super::narration::Fate;
    match fate {
        None => {}
        Some(Fate::Fold(held)) => {
            super::work::on_step(
                agent_id,
                super::work::StepKind::Note,
                &super::narration::note_label(&held.text),
                store::now_ms(),
            );
            if let Some(id) = &held.draft_id {
                emit_draft(app, agent_id, id, "");
            }
        }
        Some(Fate::Keep(held)) => {
            *said_anything = true;
            record_reply(app, agent_id, held.draft_id, held.text).await;
        }
    }
}

/// Write to an app-server turn's stdin; `None` closes it.
pub(super) fn send(
    writer: &Option<tokio::sync::mpsc::UnboundedSender<Option<String>>>,
    msg: Option<serde_json::Value>,
) {
    if let Some(tx) = writer {
        let _ = tx.send(msg.map(|m| m.to_string()));
    }
}

/// [`record`] on a blocking thread: it writes the log and the registry.
pub(super) async fn record_off(app: &AppHandle, message: AgentMessage) {
    let app = app.clone();
    let _ = tokio::task::spawn_blocking(move || record(&app, message)).await;
}

/// Where a turn's time went, logged once per turn (target `agents::timing`):
/// our preparation before the spawn, the engine's start-up until it names
/// its session, the first streamed word, its result, and the wait for it to
/// exit. `cli_ms` is the CLI's own `duration_ms` (Claude Code only), so
/// overhead can be told apart.
pub(super) struct Timing {
    began: std::time::Instant,
    spawned: std::time::Instant,
    boot: Option<std::time::Instant>,
    first_word: Option<std::time::Instant>,
    result: Option<std::time::Instant>,
    cli_ms: u64,
}

impl Timing {
    fn spawned(began: std::time::Instant) -> Self {
        Timing {
            began,
            spawned: std::time::Instant::now(),
            boot: None,
            first_word: None,
            result: None,
            cli_ms: 0,
        }
    }
    fn mark_boot(&mut self) {
        self.boot.get_or_insert_with(std::time::Instant::now);
    }
    fn mark_first_word(&mut self) {
        self.first_word.get_or_insert_with(std::time::Instant::now);
    }
    fn mark_result(&mut self) {
        self.result = Some(std::time::Instant::now());
    }
    fn log(&self, agent_id: &str) {
        let since = |t: Option<std::time::Instant>| {
            t.map(|t| t.duration_since(self.spawned).as_millis() as u64)
        };
        let tail = self.result.map(|r| r.elapsed().as_millis() as u64);
        tracing::info!(
            target: "agents::timing",
            agent = agent_id,
            prep_ms = self.spawned.duration_since(self.began).as_millis() as u64,
            boot_ms = since(self.boot).unwrap_or(0),
            first_word_ms = since(self.first_word).unwrap_or(0),
            result_ms = since(self.result).unwrap_or(0),
            tail_ms = tail.unwrap_or(0),
            cli_ms = self.cli_ms,
            "turn timing"
        );
    }
}

/// The working line for a turn the CLI has said nothing in for a while,
/// with no tool call open (a long build is not silence): honest that it may
/// be stuck, so the user can Stop it. `None` while it isn't quiet that long.
pub(super) fn quiet_line(who: &str, last_word: i64, now: i64, tool_open: bool) -> Option<String> {
    let quiet = now.saturating_sub(last_word);
    if tool_open || quiet < QUIET_MS {
        return None;
    }
    let minutes = quiet / 60_000;
    Some(format!(
        "No word from {who} for {minutes} min. It may be stuck; Stop it if it doesn't move on."
    ))
}

/// How a turn that didn't fail ended.
#[derive(Debug, PartialEq)]
pub(super) enum Ended {
    Finished,
    /// Stopped for a newer message, which the next turn reads.
    Interrupted,
    /// Stopped by the user (`None`), or by us: the time limit, or a turn
    /// whose permissions can't be trusted (the line the chat was given).
    Stopped(Option<&'static str>),
    /// Its engine's process ended mid-turn on its own (crashed, killed):
    /// what the chat would say. Picked up once by [`run_on_accounts`].
    Died(String),
}

/// Run one turn on `account`. `retry_fresh` lets a vanished session be replaced once.
pub(super) async fn run_turn(
    app: &AppHandle,
    agent_id: &str,
    prompt: &str,
    routine: bool,
    retry_fresh: bool,
    account: &super::wallet::Account,
) -> Result<Ended, CommandError> {
    let began = std::time::Instant::now();
    // On the other engine while its own is out (`crossover`): the agent as
    // it is there, its own engine's session and settings left as they are.
    let own = store::get(agent_id)?;
    let crossed = own.engine != account.engine;
    let mut agent = super::crossover::as_on(own, account.engine);
    let engine = agent.engine;
    // The app's own turn (`tidy`): its words never reach the chat.
    let quiet = super::tidy::is_quiet(agent_id);
    let home = store::agent_home(agent_id)?;
    std::fs::create_dir_all(&home).map_err(super::err_io)?;
    let binary = super::engine::binary(engine).await.ok_or_else(|| {
        CommandError::expected(super::failure::missing_engine_line(engine.label()))
    })?;
    // How this turn runs it (Codex speaks app-server when it can).
    let driver = Driver::pick(engine, &binary).await;
    driver.ready_as(account).await?;
    // Only the app server and OpenCode stream what a command prints as it runs.
    super::work::set_streams(
        agent_id,
        matches!(driver, Driver::CodexApp | Driver::OpenCodeAcp),
    );
    super::wallet::prepare(account);
    let (port, _) = crate::agent_bridge::start_global_agent_bridge(app.clone())
        .await
        .map_err(super::err_other)?;
    // The turn's secret names the agent and the turn, and dies with the
    // turn: the approval broker refuses requests from any turn but this one,
    // once it's over (`agents::broker`). It reaches the CLI by a 0600 file
    // (Claude Code) or this process's environment (Codex), never argv.
    let turn = super::broker::open_turn(agent_id);
    let url = super::reach::agent_url(port);
    // The apps it was granted on login cards (tokens refreshed), the
    // claude.ai connectors it's kept from, and its browser (`connections`).
    // A "When…" routine's items came from outside: such a turn gets no
    // browser, and can't write its own instructions or memory (below).
    let outside = from_outside(agent_id);
    // The way into the user's Chrome that works right now: Your Chrome when
    // it's connected, else Claude in Chrome only if a browser answers it
    // (`chrome_health`, cached a minute; said once when it doesn't).
    if !quiet {
        super::chrome_health::before_turn(app, &agent, outside).await;
    }
    let mut access = super::connections::for_turn(&agent, port, outside).await;
    // On an added Claude Code account, `--chrome` would look for a browser
    // signed in to that account's claude.ai, not the user's: the same
    // server, run as this Mac's sign-in, under another name
    // (`account_reach`, "Claude in Chrome").
    let chrome_as_this_mac =
        super::account_reach::chrome_as_this_mac(engine, access.browser, account.is_this_mac());
    let mut claude_servers = access.claude_servers(turn.secret());
    if chrome_as_this_mac {
        access.browser = false;
        claude_servers.insert(
            super::account_reach::CHROME_SERVER.to_string(),
            super::account_reach::chrome_server(&binary),
        );
        if !access.prompt.is_empty() {
            access.prompt.push('\n');
        }
        access
            .prompt
            .push_str(&super::account_reach::chrome_prompt_line());
    }
    let mcp_config = match engine {
        Engine::Claude => Some(super::reach::write_config(
            &super::reach::claude_config_with(&url, turn.secret(), claude_servers),
        )?),
        Engine::Codex | Engine::OpenCode => None,
    };

    let (session_id, resuming) = match &agent.session_id {
        Some(id) => (id.clone(), true),
        None => (driver.new_session(), false),
    };
    // What was asked, before any recap: a fork that falls back asks again.
    let asked = prompt;
    // Gone back to an earlier point (`rewind`): where this conversation's
    // new session starts. Claude Code resumes at an entry, Codex's
    // app-server forks a thread through a turn, each only from a session
    // still on this Mac; anything else picks up from a recap.
    let loaded_conversation = super::conversations::loaded(&agent).to_string();
    let branch = if crossed || quiet {
        None
    } else {
        super::rewind::pending(agent_id, &loaded_conversation, agent.session_id.is_some()).map(
            |p| match p.branch {
                super::rewind::Branch::Fork { session, at }
                    if engine == Engine::Claude
                        && super::wallet::valid_session(&session)
                        && super::wallet::valid_session(&at)
                        && super::transcript::resumable(agent_id, engine, &session) =>
                {
                    super::rewind::Branch::Fork { session, at }
                }
                super::rewind::Branch::CodexFork { thread, turn }
                    if engine == Engine::Codex
                        && driver == Driver::CodexApp
                        && super::wallet::valid_session(&thread)
                        && !turn.is_empty()
                        && super::transcript::resumable(agent_id, engine, &thread) =>
                {
                    super::rewind::Branch::CodexFork { thread, turn }
                }
                super::rewind::Branch::Fork { .. } | super::rewind::Branch::CodexFork { .. } => {
                    super::rewind::Branch::Recap
                }
                b => b,
            },
        )
    };
    let recapped = !resuming
        && (agent.new_engine || !retry_fresh || branch == Some(super::rewind::Branch::Recap));
    // First turn on a new engine: it starts blank, so it gets the conversation.
    let prompt = if agent.new_engine && !resuming {
        with_recap(agent_id, prompt)
    } else if branch == Some(super::rewind::Branch::Recap) && !resuming {
        with_recap_as(agent_id, super::rewind::RECAP_HEADER, None, prompt)
    } else {
        prompt.to_string()
    };
    // A value pasted into a message reaches the agent as its reference.
    let prompt = super::secrets::redact(&prompt).into_owned();

    // What its settings let it work in (`policy`): the folders it may
    // write, and what stays read-only inside them.
    let policy = super::policy::effective(&agent);
    if let Some(why) = super::policy::own_refusal(&policy, &agent) {
        return Err(CommandError::expected(why));
    }
    let mut layout = super::project::layout(&agent, &home, work_dirs());
    let dirs = super::policy::turn_dirs(
        &policy,
        &agent,
        &super::policy::Places::current(),
        work_dirs(),
        layout.copy.is_some(),
    );
    layout.add_dirs = policy_dirs(&layout, &home, dirs.add_dirs);
    if engine == Engine::Claude {
        access.blocked.extend(dirs.claude_deny);
    }
    if let Some(project) = &layout.project {
        if !project.is_dir() {
            return Err(CommandError::expected(format!(
                "{} works in {}, which isn't there any more. Pick another project in Edit agent, or clear it.",
                agent.name,
                project.display()
            )));
        }
    }
    // Its conversation, where this turn's engine looks for it: another
    // account's folder, another working folder (a bound agent's copy), or
    // the app's own copy when the engine's was deleted (`transcript`).
    if resuming && super::transcript::ensure(account, &layout.cwd, &home, &session_id) {
        tracing::info!("[Agents] put {agent_id}'s conversation back where its engine looks for it");
    }
    // A fork's source, likewise.
    match &branch {
        Some(super::rewind::Branch::Fork { session, .. })
        | Some(super::rewind::Branch::CodexFork {
            thread: session, ..
        }) => {
            super::transcript::ensure(account, &layout.cwd, &home, session);
        }
        _ => {}
    }
    // Where this conversation stands before the turn, for going back to
    // before what it answers (`rewind`).
    let resumed_at = if !resuming || crossed || quiet {
        None
    } else if engine == Engine::Claude {
        super::transcript::claude_leaf(&home, &session_id)
    } else if engine == Engine::Codex && driver == Driver::CodexApp {
        super::rewind::codex_last_turn(agent_id, &session_id)
    } else {
        None
    };
    if let Some(caps) = driver
        .capabilities_before(&agent, &binary, store::now_ms(), &access)
        .await
    {
        agent.capabilities = Some(caps.clone());
        store::update(agent_id, |a| a.capabilities = Some(caps)).or_log("an agent's capabilities");
    }
    // This agent's secrets, as variables of this process only (see `secrets`).
    let secret_env = super::secrets::env_for(&agent);
    let mut system_prompt = system_prompt_for(&agent, &home, &layout);
    let have = super::secrets::prompt_section(&agent, &secret_env);
    if !have.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&have);
    }
    if !access.prompt.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&access.prompt);
    }
    if let Some(note) = outside_note(outside) {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(note);
    }
    // Said in this build's words for the computer: "this PC" on Windows (`computer`).
    let system_prompt = crate::computer::localize(&system_prompt).into_owned();
    // What it was told, for the desk's read-only "What it was told". A bound
    // agent's CLAUDE.md is in the prompt already; an unbound one's engine
    // reads it from its home.
    {
        let instructions = layout.project.is_none().then(|| {
            std::fs::read_to_string(home.join("CLAUDE.md"))
                .unwrap_or_default()
                .chars()
                .take(40_000)
                .collect::<String>()
        });
        if let Some(key) = super::briefing::keep(
            agent_id,
            &system_prompt,
            instructions.as_deref(),
            store::now_ms(),
        ) {
            super::work::on_briefing(agent_id, key);
        }
    }
    // A routine may have a model of its own (`CheckIn::model`).
    let chosen = if routine && !crossed {
        super::runs::routine_model(agent_id, &turn_tickets(agent_id))
    } else {
        None
    };
    let model = if routine {
        super::schedule::model_for(&agent, chosen.as_deref())
    } else {
        agent.model.as_deref()
    };
    // Its effort is for its conversation: a routine mostly checks, on a
    // cheaper model that may not offer the same levels.
    let effort = if routine {
        None
    } else {
        agent.effort.as_deref()
    };
    // Codex with permission profiles keeps every `.git` / `.shipstudio`
    // folder it can reach read-only; Claude Code gets the same as deny rules.
    let profiles =
        driver.engine() == Engine::Codex && super::codex::profiles_supported(&binary).await;
    let protected = profiles.then(|| {
        let mut roots: Vec<std::path::PathBuf> = layout
            .add_dirs
            .iter()
            .map(std::path::PathBuf::from)
            .collect();
        roots.push(layout.cwd.clone());
        let mut paths = super::reach::protected_paths(&roots);
        paths.extend(dirs.read_only.iter().cloned());
        paths
    });
    // A Codex without permission profiles can't keep a folder it works in
    // read-only: say so rather than let it write there.
    if driver.engine() == Engine::Codex && !profiles && !dirs.read_only.is_empty() {
        return Err(CommandError::expected(format!(
            "{}'s settings keep {} read-only, and this version of Codex can't hold a folder it works in read-only. Update Codex, or ask in chat to let it work in its own copy.",
            agent.name,
            dirs.read_only
                .first()
                .map(|p| super::project::folder_name(&p.to_string_lossy()).to_string())
                .unwrap_or_default()
        )));
    }
    let mcp_config_arg = mcp_config
        .as_ref()
        .map(super::reach::ConfigFile::arg)
        .unwrap_or_default();
    let mut cmd = crate::utils::create_command(&binary);
    cmd.args(driver.args(&TurnSpec {
        model,
        effort,
        session: &session_id,
        resuming,
        url: &url,
        mcp_config: &mcp_config_arg,
        system_prompt: &system_prompt,
        writable: &layout.add_dirs,
        protected: protected.as_deref(),
        access: Some(&access),
        window: agent.context.as_ref().map(|c| c.window),
    }));
    // A new session that starts as `session` did at entry `at`: Claude
    // Code's own fork, leaving that transcript as it was.
    if let Some(super::rewind::Branch::Fork { session, at }) = &branch {
        cmd.args([
            "--resume",
            session.as_str(),
            "--resume-session-at",
            at.as_str(),
            "--fork-session",
        ]);
    }
    // A "When…" routine's items came from outside: this turn can't write its
    // own instructions or memory (Claude Code refuses the edit; for Codex,
    // and for anything that gets past that, it's put back when the turn ends).
    if outside && engine == super::engine::Engine::Claude {
        cmd.args(outside_turn_args(&home));
    }
    let _memory_seal = outside.then(|| MemorySeal::hold(app, agent_id, &home));
    strip_session_env(&mut cmd);
    if engine == Engine::Claude {
        // Compaction on and tuned, whatever this app's environment says (`tidy`).
        for key in super::tidy::CLAUDE_ENV_OFF {
            cmd.env_remove(key);
        }
        cmd.envs(super::tidy::claude_env());
        // claude.ai artifact links read directly (`claude::ENV`).
        cmd.envs(super::claude::ENV);
    }
    if engine == Engine::Codex {
        // Read by `bearer_token_env_var`. Codex's default shell environment
        // policy leaves any `*TOKEN*` variable out of the commands it runs.
        cmd.env(super::reach::TOKEN_ENV, turn.secret());
    }
    // OpenCode: what it is told as instruction files (the prompt in a 0600
    // file of the turn's), its permissions and model in its inline config,
    // project config off (`opencode`). The secret goes over stdin only.
    let _opencode_prompt = if engine == Engine::OpenCode {
        let file = super::reach::write_instructions(&system_prompt)?;
        let instructions = super::opencode::instruction_files(file.path(), &layout.cwd);
        let given: Vec<String> = access.servers.iter().map(|s| s.key.clone()).collect();
        for key in super::opencode::ENV_REMOVED {
            cmd.env_remove(key);
        }
        cmd.envs(super::opencode::env(super::opencode::config(
            model,
            &instructions,
            &given,
        )));
        Some(file)
    } else {
        None
    };
    cmd.env("PATH", crate::utils::get_extended_path())
        // Claude Code gives an MCP tool call ~60s by default, and the approval
        // tool waits for a person. Verified: with the default, a card left for
        // two minutes came back as a timeout the agent read as "Bash is
        // hanging". Raised past our own approval wait so we always answer
        // first. (Claude Code still caps a permission prompt at 300s; see
        // mcp::APPROVAL_WAIT_SECS.) Codex gets the same as `tool_timeout_sec`.
        .env(
            "MCP_TOOL_TIMEOUT",
            ((super::mcp::APPROVAL_WAIT_SECS + 60) * 1000).to_string(),
        )
        .envs(secret_env);
    // The account it runs on (nothing for this Mac's own sign-in): its own
    // folder's login, never one inherited from this app's environment.
    for var in super::wallet::env_unset_for(account) {
        cmd.env_remove(var);
    }
    cmd.envs(super::wallet::env_for(account))
        .current_dir(&layout.cwd);

    let mut cmd = tokio::process::Command::from(cmd);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, so Stop takes down what it started too.
    procs::own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        super::engine::forget_binary(engine);
        tracing::warn!("[Agents] Couldn't start {}: {e}", engine.label());
        // Moved or deleted since it was found: installing it again is the
        // fix (never the os error). Still there, it's something else (the
        // folder it runs in went), which installing wouldn't fix.
        if std::path::Path::new(&binary).exists() {
            CommandError::expected(format!(
                concat!(
                    "{} couldn't start on this ",
                    crate::computer::noun!(),
                    ". Retry; if it happens again, restart the app."
                ),
                engine.label()
            ))
        } else {
            CommandError::expected(super::failure::missing_engine_line(engine.label()))
        }
    })?;
    let pid = child.id();
    if let Some(pid) = pid {
        procs::register(agent_id, pid);
    }
    let mut timing = Timing::spawned(began);

    // What identifies this turn's process, for the next launch to recognise a leftover.
    let mut mark = read_mark(agent_id).unwrap_or_default();
    mark.pid = pid;
    mark.session = driver.process_mark(&session_id, &home);
    mark.quiet = super::tidy::is_quiet(agent_id);
    // The conversation to pick up, should the turn be cut off: Claude Code's
    // is known now; a new Codex thread's once it says (`Step::Session`).
    if !session_id.is_empty() {
        mark.session_id = Some(session_id.clone());
    }
    let answered = mark.batch.clone();
    write_mark(agent_id, mark);
    if !crossed && !quiet {
        super::rewind::note_turn(
            agent_id,
            &answered,
            super::rewind::start_point(
                engine,
                resuming,
                &session_id,
                resumed_at,
                branch.as_ref(),
                recapped,
            ),
        );
    }

    // An app-server conversation: stdin stays open for the turn, written by
    // one task (approval answers come from tasks of their own); `None` closes it.
    let (writer, mut conversation) = if driver.converses() {
        let (conversation, first) = if driver == Driver::OpenCodeAcp {
            let mut servers = vec![super::opencode::McpServer {
                name: super::prompts::SERVER_KEY.to_string(),
                url: url.clone(),
            }];
            servers.extend(
                access
                    .servers
                    .iter()
                    .filter(|s| s.key != super::prompts::SERVER_KEY)
                    .map(|s| super::opencode::McpServer {
                        name: s.key.clone(),
                        url: s.url.clone(),
                    }),
            );
            let mut writable: Vec<std::path::PathBuf> = layout
                .add_dirs
                .iter()
                .map(std::path::PathBuf::from)
                .collect();
            writable.push(layout.cwd.clone());
            let mut read_only = dirs.read_only.clone();
            // A turn answering outside text can't write its own instructions.
            if outside {
                read_only.extend(["CLAUDE.md", "AGENTS.md"].map(|f| home.join(f)));
            }
            let (conversation, first) = super::opencode::Conversation::new(
                resuming.then_some(session_id.as_str()),
                &layout.cwd,
                &prompt,
                &servers,
                turn.secret(),
                super::opencode::Scope {
                    writable,
                    read_only,
                },
            );
            (Conversation::OpenCode(conversation), first)
        } else {
            let (conversation, first) = super::codex_app::Conversation::new(
                resuming.then_some(session_id.as_str()),
                &layout.cwd,
                model,
                &system_prompt,
                &prompt,
                profiles,
            );
            let conversation = conversation.with_effort(effort);
            // Gone back to an earlier point: a fork of the thread (`rewind`).
            let conversation = match &branch {
                Some(super::rewind::Branch::CodexFork { thread, turn }) => {
                    conversation.forking(thread, turn)
                }
                _ => conversation,
            };
            let conversation = if super::tidy::is_compacting(agent_id) {
                conversation.compacting()
            } else {
                conversation
            };
            (Conversation::Codex(conversation), first)
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Option<String>>();
        let mut stdin = child.stdin.take();
        tokio::spawn(async move {
            while let Some(Some(line)) = rx.recv().await {
                let Some(pipe) = stdin.as_mut() else { break };
                if pipe
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            drop(stdin);
        });
        let _ = tx.send(Some(first.to_string()));
        (Some(tx), Some(conversation))
    } else {
        // A CLI that dies on startup closes stdin before reading it. Its exit
        // status and stderr say why; a "Broken pipe" here would only hide that.
        // Written from a task of its own: a prompt bigger than the pipe, to a
        // CLI not reading yet, would otherwise block here, before Stop and
        // the deadline are watched.
        if let Some(mut stdin) = child.stdin.take() {
            let (id, prompt) = (agent_id.to_string(), prompt.clone());
            tokio::spawn(async move {
                if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
                    tracing::warn!("[Agents] couldn't hand {id} its prompt: {e}");
                }
                drop(stdin);
            });
        }
        (None, None)
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| super::err_other("no stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| super::err_other("no stderr"))?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let cancel = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.cancel.clone())
        .unwrap_or_else(|| Arc::new(Notify::new()));

    let started = store::now_ms();
    set_status(
        app,
        agent_id,
        Status {
            state: "working",
            activity: None,
            since: Some(started),
            work: None,
            room: None,
        },
    );

    let mut lines = BufReader::new(stdout).lines();
    let mut saw_result = false;
    // Whether that result really ended it, and the helpers still out (`turn_end`).
    let mut turn_end = super::turn_end::TurnEnd::default();
    let mut tally = super::usage::TurnTally::default();
    let mut said_anything = false;
    let mut result_error: Option<String> = None;
    // What the engine said along the way, for a turn that ends without a result.
    let mut last_detail: Option<String> = None;
    let mut session_confirmed = false;
    // The session this turn is in, once known: a context reading is kept only
    // while the agent is still on it (not after a fresh start).
    let mut this_session = resuming.then(|| session_id.clone());
    let mut claude_context = super::context::ClaudeContext::default();
    // A turn on the agent's own model replaces the reading, or clears it if it
    // gives none (stopped, timed out, an engine that doesn't say): the
    // conversation grew, so the last number is no longer its size. A routine
    // on another model leaves the conversation's reading alone: that model's
    // window isn't the one the conversation runs against.
    let mut reading = ReadingWatch {
        app: app.clone(),
        agent_id: agent_id.to_string(),
        // Another engine's readings aren't its own conversation's.
        armed: !crossed && model == agent.model.as_deref(),
        read: false,
    };
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(TURN_TIMEOUT_SECS));
    tokio::pin!(deadline);
    // None: ran to the end. Some(None): the user pressed Stop. Some(Some(note)): we stopped it.
    let mut stopped: Option<Option<&'static str>> = None;
    let mut drafts = Drafts::default();
    let mut draft_tick = tokio::time::interval(DRAFT_EVERY);
    draft_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Short lines written mid-turn go to the timeline (`narration`).
    let mut narration = super::narration::Narration::default();
    clear_blocks_asked(agent_id);
    super::blocks::clear_shown(agent_id);
    // The `show` call itself has been read: only words after it can follow
    // the question (`blocks::is_call`).
    let mut show_read = false;
    // When the engine's process tree was last looked at (`dev_servers`).
    let mut tree_seen_at = 0_i64;
    // `claude` exited. Its output normally closes with it, but a child that
    // inherited the pipe can hold it open: read what's left for a moment,
    // then stop waiting for an end that may never come. Likewise once the
    // `result` event is in: `claude --print` stays alive for as long as a
    // background task its Bash tool started keeps running (a dev server: for
    // ever), which would hold the agent "working" and its slot for hours.
    // Observed with Claude Code 2.1. The turn is over; what it left running
    // is stopped with it (see `finish`).
    let mut exited: Option<std::io::Result<std::process::ExitStatus>> = None;
    let drain_rest = tokio::time::sleep(Duration::from_secs(TURN_TIMEOUT_SECS));
    tokio::pin!(drain_rest);
    // A hung CLI (a dead connection after sleep, a stalled MCP server) says
    // nothing for hours. Wall-clock time, so a sleep counts as time passed.
    let mut last_word = store::now_ms();
    let mut quiet_tick = tokio::time::interval(Duration::from_secs(60));
    quiet_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Signs of life, looked at quietly (`work::liveness`), and a running
    // command's output, sent on at most once a second.
    let mut pulse_tick = tokio::time::interval(PULSE_EVERY);
    pulse_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut peek_tick = tokio::time::interval(PEEK_EVERY);
    peek_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // What it has done changed since it was last saved into the mark: saved
    // on the next peek tick, so a cut-off turn keeps its reply and timeline.
    let mut progress_dirty = false;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                let line = super::e2e_alias::line(line);
                last_word = store::now_ms();
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let kind = value.get("type").and_then(|t| t.as_str());
                // Claude Code's `tool_progress` says only that a tool is still
                // running: alive, but not progress.
                super::work::on_sign(agent_id, last_word, kind != Some("tool_progress"));
                // A `result` can answer something queued ahead of the user's
                // message, or a helper reporting back: anything it does after
                // one means the turn isn't over until the next (`turn_end`),
                // and the row that went idle at that `result` is working again.
                if driver == Driver::ClaudePrint && turn_end.on_line(&value) {
                    let now = status_of(agent_id);
                    if now.state == "idle" || now.activity.as_deref().is_some_and(super::turn_end::is_waiting_line) {
                        set_status(app, agent_id, Status { state: "working", activity: None, since: Some(started), work: None, room: None });
                    }
                }
                // Claude Code's init says how it is really running: a turn
                // nothing would ask about is stopped before it acts.
                if driver == Driver::ClaudePrint && kind == Some("system") {
                    if let Some(why) = super::broker::observe(app, agent_id, &value) {
                        stopped = Some(Some(why));
                        break;
                    }
                }
                let steps = match driver {
                    Driver::ClaudePrint if kind == Some("stream_event") => {
                        drafts.on_stream_event(&value, store::new_id);
                        continue;
                    }
                    Driver::ClaudePrint => {
                        // What the browser showed: which control each ref is.
                        if matches!(kind, Some("assistant" | "user")) {
                            super::browser_gate::observe(agent_id, &value);
                        }
                        // Outside content it reads: the rest of the turn asks.
                        super::exposure::observe_claude(agent_id, &value);
                        let mut steps = stream::claude_steps(&value, store::now_ms());
                        steps.extend(claude_context.observe(&value, store::now_ms()).map(Step::Context));
                        steps
                    }
                    Driver::CodexExec => {
                        super::exposure::observe_codex(agent_id, &value);
                        super::codex::steps(&value)
                    }
                    Driver::CodexApp | Driver::OpenCodeAcp => match conversation.as_mut() {
                        Some(conversation) => {
                            let mut steps = Vec::new();
                            for out in conversation.on_message(&value) {
                                match out {
                                    Out::Step(step) => steps.push(step),
                                    Out::Send(msg) => send(&writer, Some(msg)),
                                    Out::Close => send(&writer, None),
                                    Out::DraftOpen => drafts.open(store::new_id()),
                                    Out::DraftDelta(text) => drafts.grow(&text),
                                    Out::Ask(ask) => {
                                        let (app, id, tx, turn) = (app.clone(), agent_id.to_string(), writer.clone(), turn.id());
                                        tokio::spawn(async move {
                                            for msg in super::codex_app::answer(&app, &id, turn, *ask).await {
                                                send(&tx, Some(msg));
                                            }
                                        });
                                    }
                                    Out::AskOpenCode(ask) => {
                                        let (app, id, tx, turn) = (app.clone(), agent_id.to_string(), writer.clone(), turn.id());
                                        if let Some((gate, round)) = conversation.opencode_gate() {
                                            tokio::spawn(async move {
                                                for msg in super::opencode::answer(&app, &id, turn, round, *ask, gate).await {
                                                    send(&tx, Some(msg));
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                            steps
                        }
                        None => super::codex::steps(&value),
                    },
                };
                if driver == Driver::CodexApp {
                    super::exposure::observe_codex(agent_id, &value);
                }
                // Outside content it reads: the rest of the turn asks.
                if let Some(conversation) = conversation.as_mut() {
                    for (tool, input) in conversation.take_calls() {
                        super::exposure::note(agent_id, &tool, &input);
                    }
                }
                progress_dirty |= !steps.is_empty();
                for step in steps {
                    match step {
                        Step::Session(sid) if !session_confirmed => {
                            timing.mark_boot();
                            session_confirmed = true;
                            this_session = Some(sid.clone());
                            let id = agent_id.to_string();
                            let _ = tokio::task::spawn_blocking(move || {
                                // The conversation a pick-up resumes.
                                update_mark(&id, |m| m.session_id = Some(sid.clone()));
                                store::update(&id, |a| {
                                    super::crossover::save_session(a, engine, sid)
                                })
                            }).await;
                        }
                        Step::Session(_) => {}
                        Step::Capabilities(caps) => {
                            compare_after_switch(app, agent_id, &caps);
                            store::update(agent_id, |a| a.capabilities = Some(caps)).or_log("an agent's capabilities");
                        }
                        Step::Reply(text) => {
                            // Recorded under the draft's id, so it takes the draft's place.
                            let draft_id = drafts.finish(&text);
                            // A check-in with nothing new posts nothing.
                            if !quiet && super::schedule::is_nothing_new(&text) && quiet_check_in(agent_id) {
                                if let Some(id) = &draft_id {
                                    emit_draft(app, agent_id, id, "");
                                }
                                said_anything = true;
                                nothing_new(app, agent_id);
                                continue;
                            }
                            // An agent's answer with nothing new for the user.
                            if !quiet && super::schedule::is_nothing_new(&text) && quiet_answer(agent_id) {
                                if let Some(id) = &draft_id {
                                    emit_draft(app, agent_id, id, "");
                                }
                                said_anything = true;
                                let _ = record_in_turn(
                                    app,
                                    new_message(agent_id, MessageKind::Note, ANSWER_READ_LINE),
                                );
                                continue;
                            }
                            // Asked with blocks: the question is the last word.
                            // Shown without asking: a line only restating it.
                            if !text.is_empty()
                                && !quiet
                                && show_read
                                && (blocks_asked(agent_id)
                                    || super::blocks::restates_shown(agent_id, &text))
                            {
                                said_anything = true;
                                let fold = super::narration::Fate::Fold(super::narration::Held {
                                    draft_id,
                                    text,
                                });
                                settle_narration(app, agent_id, Some(fold), &mut said_anything).await;
                                continue;
                            }
                            if !text.is_empty() && !quiet {
                                let (before, held) = narration.reply(draft_id.clone(), &text);
                                settle_narration(app, agent_id, before, &mut said_anything).await;
                                if !held {
                                    said_anything = true;
                                    record_reply(app, agent_id, draft_id, text).await;
                                }
                            }
                        }
                        Step::Activity(activity) => {
                            if status_of(agent_id).state != "waiting" {
                                set_status(app, agent_id, Status { state: "working", activity: Some(activity), since: Some(started), work: None, room: None });
                            }
                        }
                        Step::Action(action) => {
                            note_acted(agent_id);
                            show_read |= super::blocks::is_call(&action);
                            settle_narration(app, agent_id, narration.work(), &mut said_anything).await;
                            super::workplace::note(app, agent_id, &layout.cwd, &action);
                            let doing = super::work::on_action(agent_id, action, store::now_ms());
                            if status_of(agent_id).state != "waiting" {
                                set_status(app, agent_id, Status { state: "working", activity: Some(doing), since: Some(started), work: None, room: None });
                            }
                        }
                        Step::Result(result) => {
                            // What the call left running (a dev server it started).
                            if let Some(pid) = pid.filter(|_| store::now_ms() - tree_seen_at > 5_000) {
                                tree_seen_at = store::now_ms();
                                note_engine_tree(agent_id, pid).await;
                            }
                            let before = super::work::live(agent_id).and_then(|w| w.doing);
                            super::work::on_result(agent_id, result);
                            // The step's outcome changed: the open list says so.
                            let mut now = status_of(agent_id);
                            if now.state == "working" {
                                // The line said that call; it's back, so the
                                // agent is on to deciding what's next.
                                let after = super::work::live(agent_id).and_then(|w| w.doing);
                                if before.is_some() && after.is_none() && now.activity == before {
                                    now.activity = Some(THINKING.into());
                                }
                                set_status(app, agent_id, now);
                            }
                        }
                        Step::Output { id, text } => {
                            super::work::on_output(agent_id, &id, &text, store::now_ms());
                        }
                        Step::Usage(turn) => {
                            // A second `result` (a helper reported back) is the same turn.
                            let mut turn = tally.next(turn);
                            timing.cli_ms = turn.duration_ms;
                            // Codex doesn't time its turns; this one was timed here.
                            if turn.duration_ms == 0 {
                                turn.duration_ms = u64::try_from(store::now_ms() - started).unwrap_or(0);
                            }
                            let today = super::usage::today();
                            add_turn_usage(agent_id, &turn);
                            // The account's token count, which forecasts set against its readings.
                            super::usage_plan::add_turn(engine, &account.id, agent_id, &turn, store::now_ms());
                            let id = agent_id.to_string();
                            let _ = tokio::task::spawn_blocking(move || store::update(&id, |a| a.usage.record(&turn, today))).await;
                        }
                        Step::Quota(reading) => {
                            let now_ms = store::now_ms();
                            // Its plan, used up: the account is out until the reset it names.
                            if let Some(at) = super::quota::limited_until(std::slice::from_ref(&reading), reading.engine, now_ms) {
                                super::wallet::reported_out_with_twins(reading.engine, &account.id, at, now_ms);
                            }
                            // Kept as this account's own too, with a sample for forecasts.
                            super::usage_plan::archive(&account.id, &reading, now_ms);
                            // A reading is one account's: another's is cleared first.
                            if super::wallet::reading_moves_to(reading.engine, &account.id) {
                                super::quota::clear(reading.engine, now_ms);
                            }
                            let changed = tokio::task::spawn_blocking(move || super::quota::record(reading, store::now_ms()))
                                .await
                                .unwrap_or(false);
                            if changed {
                                let _ = app.emit(EVENT_QUOTA, ());
                            }
                        }
                        Step::Context(fill) if reading.armed => {
                            let (id, on) = (agent_id.to_string(), this_session.clone());
                            let turn_model = model.map(str::to_string);
                            let kept = tokio::task::spawn_blocking(move || {
                                let mut kept = false;
                                store::update(&id, |a| {
                                    kept = keep_reading(a, on.as_deref(), turn_model.as_deref(), fill);
                                }).or_log("an agent's context reading");
                                kept
                            })
                            .await
                            .unwrap_or(false);
                            if kept {
                                reading.read = true;
                                let _ = app.emit(EVENT_REGISTRY, ());
                            }
                        }
                        Step::Context(_) => {}
                        Step::Compacted => super::tidy::note_compacted(agent_id),
                        Step::Model(model) => super::work::on_model(agent_id, &model),
                        Step::Failed(text) => result_error = Some(text),
                        Step::Detail(text) => last_detail = Some(text),
                        Step::Done => {
                            saw_result = true;
                            turn_end.on_done();
                            timing.mark_result();
                            // The turn's last word, if it was held back.
                            settle_narration(app, agent_id, narration.end(said_anything || blocks_asked(agent_id)), &mut said_anything).await;
                            // The engine is still up: what it started is still under it.
                            if let Some(pid) = pid {
                                note_engine_tree(agent_id, pid).await;
                            }
                            // Its reply is complete: no "working" while the CLI
                            // exits, unless helpers it started are still out.
                            let helpers = turn_end.waiting_on();
                            if helpers == 0 {
                                set_status(app, agent_id, Status::idle());
                            } else {
                                set_status(app, agent_id, Status { state: "working", activity: Some(super::turn_end::waiting_line(helpers)), since: Some(started), work: None, room: None });
                            }
                            // Codex ends its turn once; only Claude Code's can reopen.
                            let grace = match driver {
                                Driver::ClaudePrint => turn_end.grace(),
                                _ => Duration::from_secs(3),
                            };
                            drain_rest.as_mut().reset(tokio::time::Instant::now() + grace);
                        }
                    }
                }
            }
            _ = draft_tick.tick(), if drafts.dirty() => {
                progress_dirty = true;
                if let Some((id, text)) = drafts.flush() {
                    timing.mark_first_word();
                    if !quiet {
                        emit_draft(app, agent_id, id, text);
                    }
                }
            }
            status = child.wait(), if exited.is_none() => {
                exited = Some(status);
                drain_rest.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(2));
            }
            _ = &mut drain_rest, if exited.is_some() || turn_end.over() => break,
            _ = cancel.notified() => {
                // Its reply was complete and nothing is still out: a new
                // message (or Stop) just ends the wait, not the turn's work.
                if turn_end.over() && turn_end.waiting_on() == 0 {
                    forget_interrupt(agent_id);
                    break;
                }
                stopped = Some(None);
                break;
            }
            _ = &mut deadline => { stopped = Some(Some(TIMEOUT_NOTE)); break; }
            _ = peek_tick.tick() => {
                if std::mem::take(&mut progress_dirty) {
                    save_progress(agent_id, drafts.current());
                }
                if super::work::take_dirty(agent_id) {
                    let now = status_of(agent_id);
                    if now.state == "working" {
                        set_status(app, agent_id, now);
                    }
                }
            }
            _ = pulse_tick.tick() => {
                // The running command's process, only when there is one to find.
                let rows = match super::work::step_needle(agent_id) {
                    Some(_) => tokio::task::spawn_blocking(procs::snapshot).await.ok().flatten(),
                    None => None,
                };
                let pulse = super::work::pulse(agent_id, store::now_ms(), rows.as_deref(), pid);
                if pulse.hung {
                    tracing::warn!("[Agents] {agent_id}: its command ended but the engine never moved on; stopping the turn");
                    stopped = Some(Some(HUNG_NOTE));
                    break;
                }
                let now = status_of(agent_id);
                // Sent again while a call runs, so "Last activity" stays fresh.
                let running = super::work::live(agent_id).is_some_and(|w| w.current.is_some());
                if now.state == "working" && (pulse.changed || running) {
                    set_status(app, agent_id, now);
                }
            }
            _ = quiet_tick.tick() => {
                let now = status_of(agent_id);
                let tool_open = super::work::live(agent_id).is_some_and(|w| w.doing.is_some());
                // Waiting on its helpers is quiet by design, not stuck.
                if now.state == "working" && !turn_end.over() {
                    if let Some(line) = quiet_line(engine.label(), last_word, store::now_ms(), tool_open) {
                        if now.activity.as_deref() != Some(line.as_str()) {
                            set_status(app, agent_id, Status { state: "working", activity: Some(line), since: Some(started), work: None, room: None });
                        }
                    }
                }
            }
        }
    }

    // An app-server turn is interrupted first, so Codex ends it cleanly and
    // the thread records it; what streams meanwhile still counts as written.
    if let (Some(_), Some(conversation)) = (&stopped, conversation.as_mut()) {
        if let Some(interrupt) = conversation.interrupt() {
            send(&writer, Some(interrupt));
            let _ = tokio::time::timeout(Duration::from_secs(3), async {
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    for out in conversation.on_message(&value) {
                        match out {
                            Out::DraftDelta(text) => drafts.grow(&text),
                            // Completed under the interrupt: kept whole, not cut off.
                            Out::Step(Step::Reply(text)) if !text.is_empty() && !quiet => {
                                let id = drafts.finish(&text).unwrap_or_else(store::new_id);
                                record_reply(app, agent_id, Some(id), text).await;
                            }
                            _ => {}
                        }
                    }
                    if conversation.over() {
                        break;
                    }
                }
            })
            .await;
        }
        send(&writer, None);
    }

    // Stop, interrupt and the timeout end the whole tree, not just `claude`:
    // a dev server or watcher its Bash tool started dies with it.
    if stopped.is_some() {
        if let Some(pid) = pid {
            let _ = tokio::task::spawn_blocking(move || procs::kill_tree_sync(pid)).await;
        }
    }
    // A held line the turn never followed up (stopped, cut off) is its word.
    settle_narration(
        app,
        agent_id,
        narration.end(said_anything || blocks_asked(agent_id)),
        &mut said_anything,
    )
    .await;
    // Its question is in the chat: not a silent turn.
    said_anything |= blocks_asked(agent_id);
    let (status, settled) = match exited {
        Some(status) => (status, false),
        None => finish(&mut child, pid, saw_result, agent_id, stopped.is_none()).await,
    };
    // Dev servers it left: stopped unless someone is looking at them.
    if stopped.is_none() && !settled {
        super::dev_servers::turn_ended(agent_id, pid).await;
    }
    procs::unregister(agent_id);
    timing.log(agent_id);
    // The app's own copy of the conversation, so a deleted transcript never
    // costs the agent its memory of this chat (`transcript`).
    // A Codex app-server turn's id, for forking its thread through it later.
    if engine == Engine::Codex && !crossed && !quiet {
        if let (Some(Conversation::Codex(c)), Some(thread)) = (&conversation, &this_session) {
            if let Some(turn) = c.turn_id() {
                super::rewind::note_codex_turn(agent_id, thread, turn);
            }
        }
    }
    let kept = this_session
        .clone()
        .or_else(|| (!session_id.is_empty()).then(|| session_id.clone()));
    if let Some(sid) = kept {
        let (account, home) = (account.clone(), home.clone());
        let _ = tokio::task::spawn_blocking(move || {
            super::transcript::back_up(&account, &home, &sid);
        })
        .await;
    }
    let status = status.map_err(super::err_io)?;
    let stderr_text = tokio::time::timeout(EXIT_BOUND, stderr_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();

    // A reply cut off mid-sentence keeps what it had said, marked as stopped.
    let cut_off = drafts.take().filter(|_| !quiet).map(|(id, text)| {
        let mut message = new_message(agent_id, MessageKind::Agent, text);
        message.id = id;
        message.stopped = true;
        said_anything = true;
        let _ = record(app, message);
    });

    if let Some(note) = stopped {
        // Helpers it started went with it: said, so nobody waits on them.
        if let Some(line) = super::turn_end::stopped_helpers_line(turn_end.waiting_on()) {
            if !quiet {
                let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
            }
        }
        if note.is_none() && take_interrupt(agent_id) {
            // The app's own turn gave way: nothing was cut off for the next to hear.
            if quiet {
                clear_interrupted(agent_id);
                return Ok(Ended::Interrupted);
            }
            // Cut off in a room for a message in its own chat: the room hears
            // it won't get an answer, and nothing said there goes with it.
            let line = match turn_room(agent_id) {
                Some(_) => interrupted_in_room_line(agent_id),
                None => "Interrupted to read your new message".to_string(),
            };
            let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
            return Ok(Ended::Interrupted);
        }
        // Stopped by the user is their doing, not a failure: a quiet line,
        // unless the cut-off reply already says so. Our own stop is an error.
        match note {
            Some(note) => {
                let _ = record_in_turn(app, new_message(agent_id, MessageKind::Error, note));
            }
            None if cut_off.is_none() => {
                if let Ok(line) =
                    record_in_turn(app, new_message(agent_id, MessageKind::Note, "Stopped"))
                {
                    super::work::anchor_on(&line);
                }
            }
            None => {}
        }
        return Ok(Ended::Stopped(note));
    }

    // Going back to the exact point failed before the engine started a
    // session (a Claude Code that no longer takes `--resume-session-at`, a
    // Codex that won't fork the thread): nothing ran, so this turn runs
    // again from a recap, and the chat says so. An engine update never
    // breaks going back.
    let forked = matches!(
        branch,
        Some(super::rewind::Branch::Fork { .. }) | Some(super::rewind::Branch::CodexFork { .. })
    );
    if forked && !session_confirmed && !saw_result && !said_anything && !quiet {
        tracing::warn!(
            "[Agents] {agent_id}'s engine couldn't go back to the exact point; picking up from a recap: {}",
            stderr_text.lines().last().unwrap_or("")
        );
        super::rewind::fell_back(agent_id, &loaded_conversation);
        let _ = record_in_turn(
            app,
            new_message(agent_id, MessageKind::Note, super::rewind::RECAP_CLAUSE),
        );
        return Box::pin(run_turn(app, agent_id, asked, routine, false, account)).await;
    }

    let missing_session =
        is_missing_session(&stderr_text) || result_error.as_deref().is_some_and(is_missing_session);
    // A conversation the engine started is there, whatever its errors say
    // (an MCP server's "session not found" is about that server).
    if retry_fresh && resuming && missing_session && !session_confirmed && !quiet {
        tracing::warn!("[Agents] Session {session_id} for {agent_id} is gone; starting a new one");
        // The reading was the lost session's; the retry takes its own.
        reading.armed = false;
        store::update(agent_id, |a| super::crossover::drop_session(a, engine))
            .or_log("an agent's dropped engine session");
        // The new session starts blank. Hand it the conversation the user
        // can see, so the agent doesn't greet them like a stranger, and say so.
        let _ = record_in_turn(
            app,
            new_message(agent_id, MessageKind::Note, FRESH_SESSION_NOTE),
        );
        let prompt = with_recap(agent_id, &prompt);
        return Box::pin(run_turn(app, agent_id, &prompt, routine, false, account)).await;
    }

    if let Some(err) = result_error {
        let err = super::failure::cli_failure(engine.label(), &err).unwrap_or(err);
        return Err(CommandError::expected(err));
    }
    if !saw_result {
        let stderr_text = match last_detail {
            Some(detail) if stderr_text.trim().is_empty() => detail,
            _ => stderr_text,
        };
        let detail = unfinished_turn(engine, status.success(), stderr_text);
        // Agents' own words for what it can name (never PR generation's).
        let text = super::failure::cli_failure(engine.label(), &detail)
            .unwrap_or_else(|| crate::external_command::truncate_output(detail.trim()));
        // Its process went mid-turn, in a conversation that is on disk: the
        // turn is picked up there, rather than ended with nothing.
        let kind = super::failure::describe_now(engine, &text).1.kind;
        if died_mid_turn(session_confirmed, kind) {
            return Ok(Ended::Died(text));
        }
        return Err(CommandError::expected(text));
    }
    if !said_anything {
        tracing::info!("[Agents] {agent_id} finished a turn without a reply");
    }
    // Never silent: the worker says so once the turn's cards are in, and
    // names helpers that stopped with it (`turn_end`).
    if !quiet {
        super::turn_end::leave(
            agent_id,
            super::turn_end::Left {
                silent: !said_anything,
                helpers: turn_end.waiting_on(),
            },
        );
    }
    Ok(Ended::Finished)
}

/// Whether a turn's reading describes the agent's conversation as it is
/// now, and if so, keep it: the agent is still on the session the turn ran
/// in (not started fresh or moved since) and on the model the turn ran on.
pub(super) fn keep_reading(
    agent: &mut store::Agent,
    session: Option<&str>,
    turn_model: Option<&str>,
    fill: super::context::ContextFill,
) -> bool {
    let current = session.is_some()
        && agent.session_id.as_deref() == session
        && agent.model.as_deref() == turn_model;
    if current {
        agent.context = Some(fill);
    }
    current
}

/// Clears the agent's reading when its turn ends without having replaced
/// it, however it ends (a result, an error, a Stop, the timeout).
pub(super) struct ReadingWatch {
    app: AppHandle,
    agent_id: String,
    /// The turn's readings are the conversation's (it runs on the agent's model).
    armed: bool,
    /// It replaced the reading at least once.
    read: bool,
}

impl Drop for ReadingWatch {
    fn drop(&mut self) {
        if self.armed && !self.read {
            let mut had = false;
            store::update(&self.agent_id, |a| had = a.context.take().is_some())
                .or_log("an agent's cleared context reading");
            if had {
                let _ = self.app.emit(EVENT_REGISTRY, ());
            }
        }
    }
}
