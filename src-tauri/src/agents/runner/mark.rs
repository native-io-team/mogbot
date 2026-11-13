//! A turn on disk: its `turn.json` mark from spawn to end, the saved inbox, and what a cut-off turn is (its cause, whether it is picked up, and the lines that say so).

use super::*;

/// A turn in flight, on disk (`<home>/turn.json`) from spawn until the turn
/// ends. Still there at launch means the app quit or crashed mid-turn, and
/// it holds what the next launch needs to pick the turn up where it was.
#[derive(Serialize, serde::Deserialize, Default)]
pub(super) struct TurnMark {
    /// Claude Code's process, once spawned.
    pub(super) pid: Option<u32>,
    #[serde(default)]
    pub(super) session: String,
    /// A bound agent's project and its snapshot from before the turn, for
    /// the change card if the turn never gets to record one.
    #[serde(default)]
    pub(super) project: Option<String>,
    #[serde(default)]
    pub(super) tree: Option<String>,
    /// The ids of the messages the turn took, written before they left the
    /// queue. All of them still in the inbox at launch means the turn never
    /// took them (the app went in between): they are resent, not retried.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) batch: Vec<String>,
    /// Those messages themselves (redacted, like the inbox): who asked, and
    /// where, so a turn picked up after a restart answers the same people.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) took: Vec<Inbound>,
    /// The engine's conversation the turn runs in: Claude Code's session id
    /// (known before it starts) or Codex's thread (once it says). What a
    /// pick-up resumes; without it nothing is picked up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
    /// How many times this turn was already picked up (`MAX_RESUMES`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(super) resumes: u8,
    /// The user pressed Stop: a turn they ended is never picked up again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) stopped: bool,
    /// What the turn had done so far, saved as it goes ([`save_progress`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) progress: Option<Progress>,
    /// The app's own turn (a tidy, `tidy::QuietTurn`): cut off, its process
    /// is stopped and nothing else happens. No line, no pick-up: the user
    /// never asked for it, and the next turn's end tidies again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) quiet: bool,
    /// The app quit cleanly while the turn ran (`shutdown_sync`): an update,
    /// a relaunch, the user's ⌘Q. Not the turn's doing, so the pick-up it
    /// gets doesn't count toward [`MAX_RESUMES`] (up to [`MAX_QUIT_RESUMES`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) quit: bool,
}

/// A running turn's progress, saved at most once a second while it changes:
/// the reply streaming now (completed replies are already in the log) and
/// the "what it did" timeline so far.
#[derive(Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
pub(super) struct Progress {
    /// The reply being written: its message id and the text so far.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) draft: Option<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) work: Option<super::work::TurnWork>,
}

/// Auto pick-ups a turn gets, whatever cut it off (a restart, its engine
/// dying). Past that, the chat says it was interrupted and offers Continue.
pub(super) const MAX_RESUMES: u8 = 1;

/// Pick-ups a turn gets when what cut it off each time was the app quitting
/// cleanly. Observed: a turn picked up after an update, then cut off by the
/// next relaunch, waited on a typed "Continue". A crash or the engine dying
/// still gets [`MAX_RESUMES`]: it may be the turn's own doing.
pub(super) const MAX_QUIT_RESUMES: u8 = 4;

pub(super) fn read_mark(agent_id: &str) -> Option<TurnMark> {
    let raw = std::fs::read_to_string(mark_path(agent_id)?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// One writer at a time: the turn saves its progress while a Stop, from
/// another thread, marks it stopped; neither may lose the other's change.
pub(super) static MARK_LOCK: Mutex<()> = Mutex::new(());

/// Written whole and redacted (what it took, the reply so far), 0600, by
/// rename: a crash mid-write leaves the last good mark, never half of one.
pub(super) fn write_mark(agent_id: &str, mark: TurnMark) {
    let _one = MARK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    put_mark(agent_id, &mark);
}

pub(super) fn put_mark(agent_id: &str, mark: &TurnMark) {
    let Some(path) = mark_path(agent_id) else {
        return;
    };
    if let Ok(json) = serde_json::to_value(mark).and_then(|mut v| {
        super::secrets::redact_value(&mut v);
        serde_json::to_vec(&v)
    }) {
        let tmp = path.with_extension("json.tmp");
        if super::store::write_private(&tmp, &json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Change the mark in place, if the turn has one.
pub(super) fn update_mark(agent_id: &str, f: impl FnOnce(&mut TurnMark)) {
    let _one = MARK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut mark) = read_mark(agent_id) {
        f(&mut mark);
        put_mark(agent_id, &mark);
    }
}

/// Save what the running turn has done so far into its mark.
pub(super) fn save_progress(agent_id: &str, draft: Option<(&str, &str)>) {
    let work = super::work::snapshot(agent_id);
    let draft = draft
        .filter(|(_, text)| !text.trim().is_empty())
        .map(|(id, text)| (id.to_string(), text.to_string()));
    update_mark(agent_id, |m| m.progress = Some(Progress { draft, work }));
}

/// The engine's conversation the running turn is in, when known: its mark's,
/// else the agent's.
pub(in crate::agents) fn turn_session(agent_id: &str) -> Option<String> {
    read_mark(agent_id)
        .and_then(|m| m.session_id)
        .or_else(|| store::get(agent_id).ok().and_then(|a| a.session_id))
}

pub(super) fn mark_path(agent_id: &str) -> Option<std::path::PathBuf> {
    store::agent_home(agent_id)
        .ok()
        .map(|h| h.join("turn.json"))
}

pub(super) fn clear_mark(agent_id: &str) {
    let _one = MARK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(path) = mark_path(agent_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// The next pick-up a cut-off turn gets, if it has one left.
pub(super) fn next_pickup(resumes: u8) -> Option<u8> {
    (resumes < MAX_RESUMES).then(|| resumes + 1)
}

/// The next pick-up a cut-off turn's mark allows: more when the app quit.
pub(super) fn next_pickup_of(mark: &TurnMark) -> Option<u8> {
    let cap = if mark.quit { MAX_QUIT_RESUMES } else { MAX_RESUMES };
    (mark.resumes < cap).then(|| mark.resumes + 1)
}

/// Taken from the queue but its engine never started (the app went while
/// the turn was getting ready: a bound agent's copy, an account check): no
/// process, no conversation, nothing done. Its messages are simply sent
/// again; there is nothing to pick up and nothing that could run twice.
pub(super) fn never_spawned(mark: &TurnMark) -> bool {
    mark.pid.is_none()
        && mark.session.is_empty()
        && mark.progress.is_none()
        && !mark.took.is_empty()
}

/// Its engine's process ended mid-turn by itself, in a conversation the
/// engine had confirmed (so it is on disk to carry on in), and not for a
/// reason that needs the user (signed out, out of usage): worth picking up.
pub(super) fn died_mid_turn(session_confirmed: bool, kind: super::failure::FailureKind) -> bool {
    session_confirmed && kind == super::failure::FailureKind::Other
}

/// Agents whose turn ends cut off and not picked up: its line offers
/// Continue (`FailureKind::Interrupted`), never Retry, which would send the
/// request again and could do the same work twice.
pub(super) static CUT_OFF: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(Default::default);

pub(super) fn set_cut_off(agent_id: &str) {
    CUT_OFF
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string());
}

pub(super) fn take_cut_off(agent_id: &str) -> bool {
    CUT_OFF
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
}

/// Its engine died a second time in the same turn: not picked up again.
/// What it printed ("Killed: 9") goes to the log, never the chat.
pub(super) fn died_again_line(engine: Engine, detail: &str) -> String {
    tracing::warn!(
        "[Agents] {} stopped unexpectedly again: {}",
        engine.label(),
        detail.trim()
    );
    format!(
        "Interrupted: {} stopped unexpectedly again, so this turn stopped part-way. Continue picks it up where it was.",
        engine.label()
    )
}

/// The line a turn the app cut off ends on when it isn't picked up by itself.
pub(super) const RESTART_LINE: &str =
    "Interrupted: the app closed while this agent was working, so the turn stopped part-way. Continue picks it up where it was.";
/// A pick-up whose conversation can't be found: nothing is started blank.
pub(super) const SESSION_GONE_LINE: &str = "Interrupted: the app couldn't find this agent's conversation to carry on in, so it didn't start the turn again from scratch (that could do the same work twice). Check what was done, then Continue or send what's left.";
/// The quiet line a turn picked up after a restart starts with.
pub(super) const PICKED_UP_LINE: &str = "Picked up after the app restarted";
/// The line a turn that panicked ends on when it isn't picked up by itself
/// (it panicked again, or it can't be: driven by hand, in a room).
pub(super) const PANIC_INTERRUPTED_LINE: &str =
    "Interrupted: something went wrong in the app while this agent was working, so the turn stopped part-way. Continue picks it up where it was.";
/// The quiet line a turn picked up after a panic starts with.
pub(super) const PANIC_PICKED_UP_LINE: &str = "Picked up after something went wrong in the app";

/// What cut a turn off: the app going (a quit, a crash, an update), found at
/// the next launch; or a panic in this run, caught by its worker. Both are
/// recovered the same way ([`plan_recovery_for`]); only the words differ.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Cause {
    Restart,
    Panic,
}

impl Cause {
    /// The chat line for a turn that isn't picked up by itself.
    pub(super) fn interrupted_line(self) -> &'static str {
        match self {
            Cause::Restart => RESTART_LINE,
            Cause::Panic => PANIC_INTERRUPTED_LINE,
        }
    }

    /// The quiet line a picked-up turn starts with.
    pub(super) fn picked_up_line(self) -> &'static str {
        match self {
            Cause::Restart => PICKED_UP_LINE,
            Cause::Panic => PANIC_PICKED_UP_LINE,
        }
    }

    /// What the agent is told cut it off ([`prompts::carry_on`]).
    pub(super) fn why(self) -> &'static str {
        match self {
            Cause::Restart => "The app restarted",
            Cause::Panic => "Something went wrong in the app",
        }
    }
}

/// What is queued behind the turn in progress, on disk (`<home>/inbox.json`)
/// so a quit, crash or update doesn't lose it. Written whenever the queue
/// changes, under the runtimes lock, so writes land in order.
pub(super) fn save_inbox(agent_id: &str, queue: &VecDeque<Inbound>) {
    let Ok(home) = store::agent_home(agent_id) else {
        return;
    };
    let path = home.join("inbox.json");
    if queue.is_empty() {
        let _ = std::fs::remove_file(path);
    } else if let Ok(json) = serde_json::to_value(queue).and_then(|mut v| {
        super::secrets::redact_value(&mut v);
        serde_json::to_vec(&v)
    }) {
        // By rename: a crash mid-write leaves the last good queue, never half.
        if let Err(e) = super::store::write_atomic(&path, &json) {
            tracing::warn!("[Agents] couldn't save {agent_id}'s queue: {e}");
        }
    }
}

/// What became of a turn the last run cut off after it had taken its messages.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Pickup {
    /// Picked up by itself, in the same conversation: queued first.
    Resume,
    /// The user had pressed Stop.
    Stopped,
    /// Left for the user: the line says why, and offers Continue.
    Continue(&'static str),
}

/// What recovery does for one agent, worked out without the app: the mark
/// is read and removed, and a pick-up is queued, here; recording the lines
/// is [`recover_one`]'s.
#[derive(Default)]
pub(super) struct Recovery {
    /// A bound agent's project and its snapshot from before the turn.
    pub(super) changes: Option<(String, String)>,
    /// The reply that was streaming, kept as it stood (cut off).
    pub(super) partial: Option<AgentMessage>,
    /// `None`: no turn was cut off (or it never took its messages).
    pub(super) pickup: Option<Pickup>,
    /// Its timeline so far, for the recovery line.
    pub(super) work: Option<super::work::TurnWork>,
    /// Messages a turn took but never started on, back on the queue as
    /// they were ([`never_spawned`]).
    pub(super) resent: Vec<Inbound>,
}
