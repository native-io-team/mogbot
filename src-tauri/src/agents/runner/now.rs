//! Asking about an agent's turn now: whom it answers and where (user, routine, room, outside text, another agent), its hop and status, whether it is busy or queued, and the pointer to a card waiting on the user.

use super::*;

/// The turn in progress answers only scheduled runs (check-ins, routines,
/// "When…" firings): no user words, no agent's request, no room.
pub(super) fn quiet_check_in(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| {
            r.running
                && !r.tickets.is_empty()
                && !r.user_asked
                && !r.noted
                && r.origin.is_none()
                && r.owed.is_empty()
                && r.room.is_none()
        })
}

/// The turn in progress answers nothing but other agents' answers to this
/// agent's own messages, and owes nobody an outcome: an answer that only
/// acknowledges, or repeats what the user was already told, may end with
/// [`super::schedule::NOTHING_NEW`] and post nothing. Observed: a weekly
/// report sent to the Chief came back as two acknowledgements, and each
/// became a post in the reporter's chat retelling the Chief's news about a
/// third agent, which the user had already read in two other chats.
pub(super) fn quiet_answer(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| {
            r.running
                && r.answers_only
                && r.tickets.is_empty()
                && !r.user_asked
                && !r.noted
                && !r.outside
                && r.owed.is_empty()
                && r.room.is_none()
        })
}

/// The quiet line an answer with nothing new for the user leaves.
pub const ANSWER_READ_LINE: &str = "Read the answer · nothing new for you";

/// A check-in answered [`super::schedule::NOTHING_NEW`]: no reply, no
/// notification, and the unread its firing line added taken back. One quiet
/// line says it ran.
pub(super) fn nothing_new(app: &AppHandle, agent_id: &str) {
    notify::replace_held(agent_id, None);
    // Off screen, the firing line counted as unread (`announce`).
    if !notify::on_screen(app, agent_id) {
        store::update(agent_id, |a| a.unread = a.unread.saturating_sub(1))
            .or_log("an agent's unread count");
    }
    let _ = record_in_turn(
        app,
        new_message(agent_id, MessageKind::Note, NOTHING_NEW_LINE),
    );
    let _ = app.emit(EVENT_REGISTRY, ());
}

/// The quiet line a check-in with nothing new leaves.
pub const NOTHING_NEW_LINE: &str = "Checked · nothing new";

/// Whether the turn in progress answers the user's own message (and no
/// outside text): what it hands on is the user asking.
pub fn answering_user(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running && r.user_asked && !r.outside)
}

/// The turn in progress answers the user's own message *and nothing else*:
/// no other agent's request or note from the app rides in the same prompt,
/// no outside text, and nothing its conversation read came from outside
/// (`exposure::read_outside`: a web page, a search result, mail or chat
/// through a connection). What a setting from chat applies without a card
/// needs: words planted in what was read, or passed on by another agent,
/// read to the engine exactly like the user's own.
pub fn users_own_ask(agent_id: &str) -> bool {
    users_message_alone(agent_id) && !super::exposure::read_outside(agent_id)
}

/// The turn in progress answers the user's own message and nothing else in
/// the same prompt: no other agent's request, no note from the app, no
/// outside text. Unlike [`users_own_ask`] it ignores the conversation's
/// exposure mark: for what is about *who asked* in this turn (Go hard's
/// "direct", which exists for a marked conversation; the user's typed yes
/// to a plan just listed), not about planted words in what was read.
pub fn users_message_alone(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running && r.user_asked && !r.outside && !r.noted && !r.agent_in)
}

/// The Chief (or an admin) passing on the user's own request, "try again":
/// as good as the user writing to `target` themselves, so a card that
/// expired there may be raised again (`expiry::new_task`). Returns whether
/// it was lifted.
pub fn relay_lifts_expired(caller: &store::Agent, target_id: &str) -> bool {
    let relays = (caller.is_main || super::admin::is_admin(caller)) && answering_user(&caller.id);
    if relays {
        super::expiry::new_task(target_id);
        // What the user said goes with it: "post it to Slack" said to the
        // Chief is the user asking for Slack (`access_chain::names_service`).
        let words = users_words(&caller.id);
        if !words.is_empty() {
            RELAYED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(target_id.to_string(), words);
        }
    }
    relays
}

/// The user's words the Chief (or an admin) passed on to an agent with its
/// request, taken by that agent's next turn that answers an agent.
pub(super) static RELAYED: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(Default::default);

/// The user's own words in the turn in progress (and any relayed to it),
/// empty when there are none or the turn answers outside text.
pub fn users_words(agent_id: &str) -> String {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .filter(|r| r.running && !r.outside)
        .map(|r| r.user_text.clone())
        .unwrap_or_default()
}

/// The line in the Chief's chat when an agent working on someone else's
/// request raises a card: the user is talking to the Chief, so the card in
/// that agent's own chat would otherwise go unseen. Its name is a link there.
pub fn card_pointer(name: &str, title: &str) -> String {
    let title = title.trim().trim_end_matches(['.', '?']);
    format!("{name} is waiting on your OK in its chat: {title}")
}

/// When each agent last had a [`card_pointer`] left for it.
pub(super) static POINTED: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);

/// How long one pointer stands for an agent's next cards.
pub const POINTER_QUIET_MS: i64 = 15 * 60 * 1000;

/// Whether a new card from an agent gets its own pointer: not while another
/// of its cards is still waiting (the last pointer still says so), nor
/// within [`POINTER_QUIET_MS`] of the last one. `pending` counts this card.
pub fn pointer_due(pending: u32, last: Option<i64>, now: i64) -> bool {
    pending <= 1 && last.is_none_or(|at| now - at >= POINTER_QUIET_MS)
}

/// Leave [`card_pointer`] in the Chief's chat when `agent` is working on a
/// request from another agent (not the user's own words in its chat).
pub fn point_to_card(app: &AppHandle, agent: &store::Agent, title: &str) {
    if agent.is_main || !delegated(&agent.id) {
        return;
    }
    // One pointer per wait: observed, four "waiting on your OK" lines in
    // seven minutes for one agent's cards, each a new line in the Chief's chat.
    let pending = store::get(&agent.id)
        .map(|a| a.pending_approvals)
        .unwrap_or(1);
    let now = store::now_ms();
    {
        let mut last = POINTED.lock().unwrap_or_else(|e| e.into_inner());
        if !pointer_due(pending, last.get(&agent.id).copied(), now) {
            return;
        }
        last.insert(agent.id.clone(), now);
    }
    let Some(chief) = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main))
    else {
        return;
    };
    let mut line = new_message(
        &chief.id,
        MessageKind::Note,
        card_pointer(&agent.name, title),
    );
    line.peer = Some(AgentRef {
        id: agent.id.clone(),
        name: agent.name.clone(),
    });
    let _ = record(app, line);
}

/// The turn in progress was started by another agent's message, with none
/// of the user's own in it.
pub(super) fn delegated(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running && r.origin.is_some() && !r.user_asked)
}

/// Who a request was really for, per (asker, helper). Chief → Social Posts →
/// Voice: Social Posts asked Voice while answering the Chief, so Voice's
/// answer reaches a Social Posts turn that owes the Chief, and what that turn
/// says goes back up, however deep the chain (each level noted as it asks).
/// Written when the request is sent, replaced by the next one between the
/// same two; in memory only, like `owed`.
pub(super) static ONWARD: LazyLock<Mutex<HashMap<(String, String), Vec<AgentRef>>>> =
    LazyLock::new(Default::default);

/// `asker`'s turn is sending `helper` a request: whoever that turn owes an
/// answer is owed the one `helper`'s reply makes possible too.
pub fn note_onward(asker: &str, helper: &str) {
    let owed = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(asker)
        .map(|r| r.owed.clone())
        .unwrap_or_default();
    let key = (asker.to_string(), helper.to_string());
    let mut onward = ONWARD.lock().unwrap_or_else(|e| e.into_inner());
    if owed.is_empty() {
        onward.remove(&key);
    } else {
        onward.insert(key, owed);
    }
}

/// Who `asker` asked `helper` on behalf of (see [`ONWARD`]).
pub(super) fn onward_for(asker: &str, helper: &str) -> Vec<AgentRef> {
    ONWARD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(asker.to_string(), helper.to_string()))
        .cloned()
        .unwrap_or_default()
}

/// The agent's status, without its timeline (checked all through a turn,
/// so it never copies one). [`status_with_work`] is the one shown.
pub fn status_of(agent_id: &str) -> Status {
    let status = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.status.clone())
        .unwrap_or_else(Status::idle);
    status
}

/// What the row shows: its own status, or, while it has nothing of its own
/// going, the import interview it is running (`agents::connector`), so the
/// Chief reads "Talking to Grok (import)" and its Stop (here and on the
/// phone) stops the import.
pub(super) fn shown(agent_id: &str, status: Status) -> Status {
    if status.state == "idle" {
        if let Some(talking) = super::connector::interview_status(agent_id) {
            return talking;
        }
    }
    status
}

/// Tell the UI the agent's status again (the import interview started or ended).
pub fn refresh_status(app: &AppHandle, agent_id: &str) {
    let raw = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.status.clone())
        .unwrap_or_else(Status::idle);
    set_status(app, agent_id, raw);
}

/// The agent's status as the UI shows it: with the turn's timeline so far.
pub fn status_with_work(agent_id: &str) -> Status {
    let mut status = shown(agent_id, status_of(agent_id));
    with_work(agent_id, &mut status);
    status
}

/// A status that isn't idle carries the turn's timeline as it stands now.
pub(super) fn with_work(agent_id: &str, status: &mut Status) {
    status.work = match status.state {
        "idle" => None,
        _ => super::work::live(agent_id),
    };
    status.room = match status.state {
        "idle" => None,
        _ => turn_room(agent_id).map(|r| r.room_id),
    };
}

/// The room the turn in progress (or about to start) answers in.
pub fn turn_room(agent_id: &str) -> Option<super::rooms::RoomRef> {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.room.clone())
}

/// Who handed this agent the turn it is running: another agent's id, or
/// `None` when the user asked (or nothing is running).
pub fn turn_origin(agent_id: &str) -> Option<String> {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.origin.clone())
}

pub fn current_hop(agent_id: &str) -> u8 {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .map(|r| r.hop)
        .unwrap_or(0)
}

/// The hop a request sent from the agent's turn in progress travels at
/// (`message_agent`, `create_agent`'s first task): one past that turn's, or
/// `None` past [`MAX_HOPS`]. A room turn's starts at its room hop.
pub fn next_hop(agent_id: &str) -> Option<u8> {
    reply_hop(current_hop(agent_id))
}

/// The hop a message sent on behalf of a turn at `hop` travels at, or
/// `None` past [`MAX_HOPS`]: that word is not sent, so a chain can't loop.
pub(super) fn reply_hop(hop: u8) -> Option<u8> {
    let next = hop.saturating_add(1);
    (next <= MAX_HOPS).then_some(next)
}

/// Whether a worker is draining this agent's inbox (a turn is running or about to).
pub fn in_turn(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running)
}

/// Whether the agent's turn is waiting for a free slot rather than running.
pub fn queued(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.queued)
}

pub(super) fn set_queued(agent_id: &str, queued: bool) {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .queued = queued;
}

/// Whether this agent has a turn running or waiting for a slot.
pub fn is_working(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running || r.queued)
}

/// How many agents have a turn running or waiting for a slot. The updater
/// asks before it restarts the app.
pub fn busy_count() -> usize {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .filter(|r| r.running)
        .count()
}
