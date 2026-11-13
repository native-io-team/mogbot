//! Getting work to an agent: every way a message reaches its inbox (the user, a routine, outside text, a room, another agent's request or answer), the seal on its memory while it answers outside text, and starting its worker.

use super::*;

/// Queue a message for an agent and make sure a worker is draining its inbox.
/// From another agent, it is a request: the turn that handles it answers it.
pub fn enqueue(app: &AppHandle, agent_id: &str, text: String, from: From) {
    push(
        app,
        agent_id,
        Inbound {
            id: String::new(),
            text,
            from,
            reply: false,
            routine: false,
            ticket: None,
            room: None,
            outside: false,
            resume: 0,
            typed: None,
            conversation: None,
        },
    );
}

/// Queue the user's own message, under its chat message's id: the turn that
/// answers it knows which line in the log it is (see [`with_recap`]), and the
/// same message is never queued twice. `typed`: the user's words as typed in
/// this agent's own chat, on the desk or the phone (`agents_send`), without
/// what the app adds to the prompt; `None` for a message the app writes for
/// them from a button.
pub fn enqueue_user(
    app: &AppHandle,
    agent_id: &str,
    message_id: &str,
    text: String,
    typed: Option<String>,
) {
    enqueue_user_in(app, agent_id, message_id, text, typed, None);
}

/// [`enqueue_user`] in one of the agent's conversations: the one the user
/// sent it in (`None`: the one its engine has loaded).
pub fn enqueue_user_in(
    app: &AppHandle,
    agent_id: &str,
    message_id: &str,
    text: String,
    typed: Option<String>,
    conversation: Option<String>,
) {
    // They're up: quiet hours hold nothing for a while (`quiet`).
    if typed.is_some() {
        super::quiet::user_wrote(store::now_ms());
        // A follow-up not run yet goes into their turn instead (`follow_up`).
        if let Some(note) = super::follow_up::fold_into_user_turn(agent_id) {
            add_nudge(agent_id, &note);
            let _ = app.emit(EVENT_REGISTRY, ());
        }
    }
    let mut inbound = user_inbound(message_id, text, typed);
    inbound.conversation = conversation;
    push(app, agent_id, inbound);
}

pub(super) fn user_inbound(message_id: &str, text: String, typed: Option<String>) -> Inbound {
    Inbound {
        id: message_id.to_string(),
        text,
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
        resume: 0,
        typed,
        conversation: None,
    }
}

/// The user's own words when the latest of what a turn answers is a message
/// they typed in this chat: never another agent's message, a routine, a
/// room, outside text or a notice the app queued. Every typed message in
/// the batch counts ("Always a lot to do with those" / "you're always
/// allowed to do those"), but only when the last one is typed.
pub(super) fn typed_of(batch: &[Inbound], outside: bool) -> Option<String> {
    let plain =
        |m: &Inbound| matches!(m.from, From::User) && !m.routine && !m.outside && m.room.is_none();
    let last = batch.last()?;
    if outside || !plain(last) || last.typed.is_none() {
        return None;
    }
    let said: Vec<&str> = batch
        .iter()
        .filter(|m| plain(m))
        .filter_map(|m| m.typed.as_deref())
        .collect();
    Some(said.join("\n"))
}

/// What the user typed that the agent's turn in progress answers, when that
/// is the latest thing it answers ([`typed_of`]). `remember_permission` is
/// refused without it.
pub fn typed_input(agent_id: &str) -> Option<String> {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .filter(|r| r.running && !r.outside)
        .and_then(|r| r.typed.clone())
}

/// Scheduled wakes the user OK'd themselves, on a card (`routine_steps`):
/// the turn answering one counts as answering them, as a typed message
/// does. Kept in memory: a wake resumed after a restart no longer counts.
pub(super) static APPROVED_TICKETS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// The user pressed Go ahead for the wake carrying `ticket`.
pub fn approve_ticket(ticket: &str) {
    let mut set = APPROVED_TICKETS.lock().unwrap_or_else(|e| e.into_inner());
    if set.len() > 200 {
        set.clear();
    }
    set.insert(ticket.to_string());
}

pub(super) fn approved_ticket(ticket: &str) -> bool {
    APPROVED_TICKETS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(ticket)
}

/// Queue the turn a check-in wakes the agent for: one of its routines
/// (`routine`), or a one-time check-in. `ticket` is the scheduled run it
/// answers (`runs::issue`), settled however the turn ends.
pub fn enqueue_scheduled(
    app: &AppHandle,
    agent_id: &str,
    text: String,
    routine: bool,
    ticket: String,
) {
    enqueue_scheduled_in(app, agent_id, text, routine, ticket, None);
}

/// [`enqueue_scheduled`] in the conversation the routine was set up in
/// (`CheckIn::conversation`; `None`: the first, where every routine made
/// before conversations was).
pub fn enqueue_scheduled_in(
    app: &AppHandle,
    agent_id: &str,
    text: String,
    routine: bool,
    ticket: String,
    conversation: Option<String>,
) {
    let conversation = Some(
        conversation
            .filter(|c| super::conversations::exists(agent_id, c))
            .unwrap_or_else(|| super::conversations::FIRST.to_string()),
    );
    push(
        app,
        agent_id,
        Inbound {
            id: String::new(),
            text,
            from: From::User,
            reply: false,
            routine,
            ticket: Some(ticket),
            room: None,
            outside: false,
            resume: 0,
            typed: None,
            conversation,
        },
    );
}

/// Queue a message another assistant sent the Chief over Remote Access
/// (`ask_chief`). It's outside text: the turn is capped and sealed the same
/// way as any other text that didn't come from the user here.
pub fn enqueue_assistant(app: &AppHandle, agent_id: &str, text: String) {
    enqueue_assistant_for(app, agent_id, "", text);
}

/// [`enqueue_assistant`] under the id of the chat line that shows it (a
/// note), so whoever queued it can tell which turn took it
/// (`slack::took`). Still outside text: sealed and capped all the same.
pub fn enqueue_assistant_for(app: &AppHandle, agent_id: &str, message_id: &str, text: String) {
    push(
        app,
        agent_id,
        Inbound {
            id: message_id.to_string(),
            text,
            from: From::User,
            reply: false,
            routine: false,
            ticket: None,
            room: None,
            outside: true,
            resume: 0,
            typed: None,
            conversation: None,
        },
    );
}

/// Queue a "When…" routine's wake: like a scheduled one, but what it
/// carries came from outside (see [`from_outside`]).
pub fn enqueue_from_outside(app: &AppHandle, agent_id: &str, text: String, ticket: String) {
    enqueue_from_outside_in(app, agent_id, text, ticket, None);
}

/// [`enqueue_from_outside`] in the conversation the routine was set up in.
pub fn enqueue_from_outside_in(
    app: &AppHandle,
    agent_id: &str,
    text: String,
    ticket: String,
    conversation: Option<String>,
) {
    push(
        app,
        agent_id,
        Inbound {
            id: String::new(),
            text,
            from: From::User,
            reply: false,
            routine: true,
            ticket: Some(ticket),
            room: None,
            outside: true,
            resume: 0,
            typed: None,
            conversation,
        },
    );
}

/// Queue a turn for a member of a room: asked there by the user, or brought
/// in by another member's @mention (`agents::rooms`). `outside`: the reply
/// that brought it in answered text from outside, and the taint goes with it
/// (see [`from_outside`]).
pub fn enqueue_room(
    app: &AppHandle,
    agent_id: &str,
    text: String,
    room: super::rooms::RoomRef,
    outside: bool,
) {
    push(app, agent_id, room_inbound(text, room, outside));
}

/// What [`enqueue_room`] queues: a room ask, owed to no agent, carrying the
/// outside taint of the reply that brought it in.
pub(super) fn room_inbound(text: String, room: super::rooms::RoomRef, outside: bool) -> Inbound {
    Inbound {
        id: String::new(),
        text,
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: Some(room),
        outside,
        resume: 0,
        typed: None,
        conversation: None,
    }
}

/// Whether the agent has been asked in this room and hasn't started on it:
/// it's busy with something else, or waiting for a slot.
pub fn queued_for_room(agent_id: &str, room_id: &str) -> bool {
    let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(r) = runtimes.get(agent_id) else {
        return false;
    };
    let in_this_room = r.room.as_ref().is_some_and(|x| x.room_id == room_id);
    let asked = r
        .queue
        .iter()
        .any(|m| m.room.as_ref().is_some_and(|x| x.room_id == room_id));
    asked && (!in_this_room || r.queued)
}

/// Whether the agent's turn in progress answers text from outside (a
/// "When…" routine's items), or replaced one that did. Such a turn needs a
/// card to change the team, set up routines or edit its memory.
/// Whether the batch the agent's current turn answers carries outside text,
/// running or about to.
pub(super) fn batch_outside(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.outside)
}

pub fn from_outside(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running && r.outside)
}

/// Whether the agent's turn in progress is a routine's run (it holds a
/// scheduled run's ticket): a page it updates says "by a routine".
pub fn in_routine(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running && !r.tickets.is_empty())
}

/// The name of the routine the agent's turn in progress runs, when it runs
/// exactly one: a page it updates names it ("by Weekly report").
pub fn routine_running(agent_id: &str) -> Option<String> {
    if !in_routine(agent_id) {
        return None;
    }
    super::runs::routine_named(agent_id, &turn_tickets(agent_id))
}

/// What a turn answering outside text is told about itself, so it doesn't
/// report the browser it wasn't given as broken (`prompts::OUTSIDE_TURN`).
pub fn outside_note(outside: bool) -> Option<&'static str> {
    outside.then_some(super::prompts::OUTSIDE_TURN)
}

/// What a turn answering outside text adds to Claude Code's command line:
/// its own CLAUDE.md (instructions and memory) can't be written. Bash still
/// asks through `approve`, so nothing writes it without a card.
pub fn outside_turn_args(home: &Path) -> Vec<String> {
    let file = home.join("CLAUDE.md");
    let file = super::super::reach::claude_rule_path(&file.to_string_lossy());
    // `//` makes it an absolute path in a permission rule.
    let rule = |tool: &str| format!("{tool}(/{file})");
    vec![
        "--disallowedTools".to_string(),
        ["Edit", "Write", "MultiEdit", "NotebookEdit"]
            .iter()
            .map(|t| rule(t))
            .collect::<Vec<_>>()
            .join(","),
    ]
}

/// Holds a turn's CLAUDE.md as it began, for a turn answering outside text:
/// if the turn changed it anyway (Codex has no such rule; a Bash write the
/// user allowed), it's put back when the turn ends, unless the app itself
/// wrote it meanwhile (the user editing memory or instructions).
pub struct MemorySeal {
    pub(super) agent_id: String,
    pub(super) path: std::path::PathBuf,
    pub(super) before: Option<Vec<u8>>,
    pub(super) writes: u64,
    /// AGENTS.md as the turn began: Codex has no rule against writing it,
    /// and a file of its own there would be Codex's project doc and folded
    /// into memory (`crossover::sync_instructions`).
    pub(super) home: std::path::PathBuf,
    pub(super) agents_before: super::crossover::AgentsDoc,
    pub(super) app: AppHandle,
}

impl MemorySeal {
    pub fn hold(app: &AppHandle, agent_id: &str, home: &Path) -> MemorySeal {
        let path = home.join("CLAUDE.md");
        MemorySeal {
            agent_id: agent_id.to_string(),
            before: std::fs::read(&path).ok(),
            writes: store::claude_md_writes(&path),
            path,
            home: home.to_path_buf(),
            agents_before: super::crossover::agents_doc(home),
            app: app.clone(),
        }
    }
}

/// Put a CLAUDE.md back as it was before a turn answering outside text,
/// if the turn changed it and the app itself didn't write it meanwhile.
/// Returns whether it was put back.
pub fn put_back_claude_md(path: &Path, before: Option<&[u8]>, writes_before: u64) -> bool {
    let Some(before) = before else { return false };
    if std::fs::read(path).ok().as_deref() == Some(before) {
        return false;
    }
    if store::claude_md_writes(path) != writes_before {
        tracing::info!(path = %path.display(), "[Agents] CLAUDE.md changed during an outside-text turn, by the app too: kept");
        return false;
    }
    store::restore_claude_md(path, before).is_ok()
}

impl Drop for MemorySeal {
    fn drop(&mut self) {
        let claude = put_back_claude_md(&self.path, self.before.as_deref(), self.writes);
        let agents = super::crossover::put_back_agents_md(&self.home, &self.agents_before);
        if claude || agents {
            let line = new_message(
                &self.agent_id,
                MessageKind::Note,
                "This turn answered a “When…” routine's items, which came from outside, and it changed its instructions or memory. That was put back. Ask it yourself if you want the change.",
            );
            let _ = record(&self.app, line);
        }
    }
}

/// Queue an agent's answer to a request `agent_id` sent it.
pub fn enqueue_reply(app: &AppHandle, agent_id: &str, text: String, sender: AgentRef, hop: u8) {
    enqueue_reply_from(app, agent_id, text, sender, hop, false);
}

/// [`enqueue_reply`], carrying the outside taint of the sender's turn (see
/// [`from_outside`]): what a turn answering a "When…" routine's items says
/// to another agent is as much outside text as the items were.
pub fn enqueue_reply_from(
    app: &AppHandle,
    agent_id: &str,
    text: String,
    sender: AgentRef,
    hop: u8,
    outside: bool,
) {
    push(
        app,
        agent_id,
        agent_inbound(text, sender, hop, true, outside),
    );
}

/// How an answer owed to an agent that asked reaches it, sent on behalf of
/// a turn at `hop`: as a turn one hop further, or, past [`MAX_HOPS`], shown
/// in its chat without a turn (with a line saying why).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnswerWay {
    Turn(u8),
    ShowOnly,
}

pub(super) fn answer_way(hop: u8) -> AnswerWay {
    reply_hop(hop).map_or(AnswerWay::ShowOnly, AnswerWay::Turn)
}

/// The line under an answer that came too far down a chain to start a turn.
pub(super) fn chain_end_line(asker: &str, sender: &str) -> String {
    format!(
        "{sender}'s answer came at the end of a long chain of agents asking each other, so {asker} wasn't started on it. Message {asker} to carry on from here."
    )
}

/// Give an agent that asked the answer it is owed. Within the hop cap it is
/// queued as a turn, as ever. Past it, the answer used to be dropped
/// without a word: the deepest agent in a 6-hop chain did the work and the
/// one that asked never heard. It is now shown in the asker's chat with a
/// line saying the chain stopped there, still without a turn (an answer can
/// start a further answer, and a chain of them could otherwise loop).
pub(super) fn give_answer(
    app: &AppHandle,
    to: &AgentRef,
    sender: &AgentRef,
    text: String,
    hop: u8,
    outside: bool,
) {
    if store::get(&to.id).is_err() {
        return;
    }
    // In the conversation that asked, wherever the asker is now.
    let asked = super::conversations::asked_in(&to.id, &sender.id);
    let mut line = new_message(&to.id, MessageKind::FromAgent, text.clone());
    line.peer = Some(sender.clone());
    line.conversation = asked.clone();
    let _ = record(app, line);
    match answer_way(hop) {
        AnswerWay::Turn(next) => {
            enqueue_reply_from(app, &to.id, text, sender.clone(), next, outside)
        }
        AnswerWay::ShowOnly => {
            tracing::info!(to = %to.id, from = %sender.id, "[Agents] answer past the hop cap shown, not run");
            let note = chain_end_line(&to.name, &sender.name);
            let mut note = new_message(&to.id, MessageKind::Note, note);
            note.conversation = asked;
            let _ = record(app, note);
        }
    }
}

/// A request from another agent (`message_agent`), carrying the outside
/// taint of the sender's turn, as a room's @mention does.
pub fn enqueue_request(
    app: &AppHandle,
    agent_id: &str,
    text: String,
    sender: AgentRef,
    hop: u8,
    outside: bool,
) {
    // Its answer goes back to the conversation asking now.
    super::conversations::note_asked(&sender.id, agent_id);
    push(
        app,
        agent_id,
        agent_inbound(text, sender, hop, false, outside),
    );
}

/// What another agent's request (or answer, `reply`) queues.
pub(super) fn agent_inbound(
    text: String,
    sender: AgentRef,
    hop: u8,
    reply: bool,
    outside: bool,
) -> Inbound {
    Inbound {
        id: String::new(),
        text,
        from: From::Agent { sender, hop },
        reply,
        routine: false,
        ticket: None,
        room: None,
        outside,
        resume: 0,
        typed: None,
        conversation: None,
    }
}

/// `from` is messaging `to`. If `from`'s turn is answering a request `to`
/// sent, this message is that answer: it settles the debt, so the turn's
/// final words aren't sent back as well. Returns whether it was an answer.
/// Whether the turn in progress for `from` owes `to` an answer (`to` asked
/// it something): a reply to it is an answer, not new work handed out.
pub fn owes(from: &str, to: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(from)
        .is_some_and(|r| r.owed.iter().any(|a| a.id == to))
}

/// Which turn this agent is on, counted per agent (0 before its first).
pub fn turn_number(agent_id: &str) -> u64 {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .map(|r| r.turn_gen)
        .unwrap_or(0)
}

pub fn settle(from: &str, to: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(owed) = runtimes.get_mut(from).map(|r| &mut r.owed) else {
        return false;
    };
    let before = owed.len();
    owed.retain(|a| a.id != to);
    owed.len() < before
}

pub(super) fn push(app: &AppHandle, agent_id: &str, mut inbound: Inbound) {
    if inbound.id.is_empty() {
        inbound.id = store::new_id();
    }
    if inbound.room.is_none() && inbound.conversation.is_none() {
        inbound.conversation = Some(conversation_for(agent_id, &inbound));
    }
    let admitted = {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = runtimes.entry(agent_id.to_string()).or_default();
        let admitted = runtime.admit(inbound);
        if admitted.is_ok() {
            save_inbox(agent_id, &runtime.queue);
        }
        admitted
    };
    match admitted {
        Ok(true) => start_worker(app, agent_id),
        Ok(false) => {}
        // Being deleted: whoever asked hears it won't be done.
        Err(refused) => tell_dropped(app, agent_id, vec![*refused], Dropped::Deleting),
    }
}

/// The conversation a message that didn't say goes to: an answer to the
/// conversation that asked for it, anything else to the one the agent's
/// engine has loaded (where it was working).
pub(super) fn conversation_for(agent_id: &str, inbound: &Inbound) -> String {
    if let (From::Agent { sender, .. }, true) = (&inbound.from, inbound.reply) {
        if let Some(asked) = super::conversations::asked_in(agent_id, &sender.id) {
            return asked;
        }
    }
    store::get(agent_id)
        .map(|a| super::conversations::loaded(&a).to_string())
        .unwrap_or_else(|_| super::conversations::FIRST.to_string())
}

/// Load conversation `to`'s session for the turn about to start. Whatever
/// the next turn was to be told first belonged to the one left, so it
/// waits there (`interrupted_in` is per place).
pub(super) fn load_conversation(app: &AppHandle, agent_id: &str, to: &str) {
    let mut swapped = false;
    store::update(agent_id, |a| swapped = super::conversations::swap(a, to))
        .or_log("the conversation an agent's turn runs in");
    if swapped {
        tracing::info!(agent = %agent_id, conversation = %to, "[Agents] loaded a conversation for its turn");
        let _ = app.emit(EVENT_REGISTRY, ());
    }
}

pub(super) fn start_worker(app: &AppHandle, agent_id: &str) {
    let app = app.clone();
    let agent_id = agent_id.to_string();
    tauri::async_runtime::spawn(async move { drain(app, agent_id).await });
}
