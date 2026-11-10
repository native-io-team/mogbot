//! Who is doing what: where a message came from, what is queued, the status shown, and each agent's runtime (its inbox, its turn in flight) under one lock.

use super::*;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub enum From {
    /// The user, in this agent's own chat: what they sent (`enqueue_user`),
    /// and the scheduled, room and outside wakes whose own flags say what
    /// they are.
    User,
    /// A note the app queues on its own: a late Allow, a card answered, a
    /// step-in handed back, a crossover's run again, spare capacity. The
    /// turn runs like a user's (no agent owed, the hop chain starts over),
    /// but it is never the user's own request: no `answering_user`, no
    /// `users_words`, no typed words, no Go hard `direct`.
    App,
    Agent {
        sender: AgentRef,
        hop: u8,
    },
}

impl From {
    /// Said here rather than by another agent: the user or the app.
    pub(super) fn here(&self) -> bool {
        matches!(self, From::User | From::App)
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(super) struct Inbound {
    /// Given when it is queued (`push`), so recovery can tell a message that
    /// was resent from one a cut-off turn had already taken. Empty in an
    /// inbox written before ids existed (given one when it is read back).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) id: String,
    pub(super) text: String,
    pub(super) from: From,
    /// An agent's answer to a request this agent sent it: answered by
    /// telling the user, never by replying (see [`settle`]).
    #[serde(default)]
    pub(super) reply: bool,
    /// One of the agent's routines firing (see [`store::Agent::routine_model`]).
    #[serde(default)]
    pub(super) routine: bool,
    /// The scheduled run this wakes the agent for (`runs::Ticket::id`): the
    /// turn that answers it settles it by this id, however that turn ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) ticket: Option<String>,
    /// Asked in a room (`agents::rooms`): the turn replies there, is never
    /// batched with anything said anywhere else, and owes no agent an answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) room: Option<super::rooms::RoomRef>,
    /// It carries text from outside (a "When…" routine's items): the turn
    /// that answers it can't change the team, set up routines or edit its
    /// own memory without a card (`from_outside`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) outside: bool,
    /// Put back to carry on a turn the app (or its engine) cut off: which
    /// pick-up this is (one at most, `MAX_RESUMES`). The turn it starts runs
    /// in the same session, told to carry on, never from scratch.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(super) resume: u8,
    /// What the user typed themselves, in this agent's own chat (desk or
    /// phone): only [`enqueue_user`] sets it. A notice the app queues (a late
    /// Allow, a declined login: `From::App`) never has it. What
    /// `remember_permission` checks the user's words against (`remember`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) typed: Option<String>,
    /// Which of the agent's conversations it was said in, or is for
    /// (`conversations`): its turn runs in that conversation's session and
    /// is never batched with another's. Given when it is queued (`push`);
    /// absent in an inbox written before conversations, and on a room's
    /// ask: the turn runs in whichever is loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) conversation: Option<String>,
}

pub(super) fn is_zero(n: &u8) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `idle`, `working`, or `waiting` (on the user's approval).
    pub state: &'static str,
    /// What it's doing right now, in a few words ("Reading …/src/App.tsx").
    pub activity: Option<String>,
    pub since: Option<i64>,
    /// The turn's timeline so far (its newest steps), while it isn't idle.
    /// Filled in by [`set_status`] and [`status_of`]; older clients ignore it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<super::work::TurnWork>,
    /// The room the turn in progress answers in (`agents::rooms`), so a
    /// room shows its own members' working lines and drafts and nobody
    /// else's. Filled in like `work`; absent for a turn in the agent's own chat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
}

impl Status {
    /// Working, with what it's doing.
    pub fn working(activity: String) -> Self {
        Status {
            state: "working",
            activity: Some(activity),
            since: Some(store::now_ms()),
            work: None,
            room: None,
        }
    }

    pub(super) fn idle() -> Self {
        Status {
            state: "idle",
            activity: None,
            since: None,
            work: None,
            room: None,
        }
    }
}

#[derive(Default)]
pub(super) struct Runtime {
    pub(super) queue: VecDeque<Inbound>,
    pub(super) running: bool,
    pub(super) status: Option<Status>,
    pub(super) cancel: Option<Arc<Notify>>,
    /// Hop count of the turn in progress (0 when the user started it).
    pub(super) hop: u8,
    /// The agent whose message started the turn in progress; `None` when the
    /// user's own message is among what it answers.
    pub(super) origin: Option<String>,
    /// What the turn in progress was asked, for the note an interruption leaves.
    pub(super) prompt: Option<String>,
    /// The user asked to interrupt the turn in progress (see [`interrupt`]).
    pub(super) interrupt: bool,
    /// Set when a turn was interrupted: what the next turn is told first.
    pub(super) interrupted: Option<String>,
    /// Where the turn `interrupted` was about was said: a room's id, or
    /// `None` for the agent's own chat. Only a turn in the same place is
    /// told it, so nothing said in one conversation is carried into another.
    pub(super) interrupted_in: Option<String>,
    /// Agents whose requests the turn in progress is answering. Whatever the
    /// turn ends up saying goes back to each of them (see [`return_results`]),
    /// unless it already answered one with `message_agent`.
    pub(super) owed: Vec<AgentRef>,
    /// Waiting for a free slot (or memory) before its turn can start.
    pub(super) queued: bool,
    /// Scheduled runs the turn in progress answers (an interrupted turn's
    /// carry over to the turn that replaces it). Settled when it ends.
    pub(super) tickets: Vec<String>,
    /// Which turn this is, counted per agent: a card's wait belongs to one.
    pub(super) turn_gen: u64,
    /// Approval cards the turn in progress is waiting on right now. The
    /// status stays "waiting" until every one of them is answered.
    pub(super) waits: u32,
    /// The user is driving the agent's session in a terminal (`takeover`):
    /// no turn starts, and what arrives waits in the queue until hand-back.
    pub(super) driven: bool,
    /// The agent is being deleted (`stop_for_delete`): nothing more is
    /// queued for it, so no turn starts on an agent about to go.
    pub(super) deleting: bool,
    /// What the turn in progress has cost so far, as its engine reported it
    /// (a session retry is a second report; an interrupted turn's cost carries
    /// over to the one that replaces it, like its scheduled runs): what a
    /// routine it ran is charged.
    pub(super) turn_usage: super::usage::UsageTotals,
    /// Something other than a routine firing was in the turn in progress
    /// (or in a turn it replaced): its cost is nobody's routine's.
    pub(super) turn_mixed: bool,
    /// The room the turn in progress answers in, if it was asked in one.
    pub(super) room: Option<super::rooms::RoomRef>,
    /// The conversation the turn in progress answers in (`conversations`).
    pub(super) conversation: Option<String>,
    /// The turn in progress (or one it replaced) answers text from outside.
    pub(super) outside: bool,
    /// A quiet note for the next turn in the agent's own chat
    /// (`share_text::labels_only_note`). Unlike `interrupted` it outlasts the
    /// worker going idle: the user's next message is when it is read.
    pub(super) nudge: Option<String>,
    /// The turn in progress answers, last, what the user typed in this chat
    /// ([`typed_of`]): their words. `None` for anything else.
    pub(super) typed: Option<String>,
    /// The user's own message (in the agent's chat: not a routine, a
    /// check-in, a room or outside text) is among what the turn in progress
    /// answers, or the one it replaced. What it hands on is the user's ask.
    pub(super) user_asked: bool,
    /// The queue ids of the messages the turn in progress answers. A user's
    /// message is queued under its chat message's id (`enqueue_user`), so a
    /// recap never hands the turn what it is also being sent.
    pub(super) batch_ids: Vec<String>,
    /// The user's own words in the turn in progress (see `user_asked`), and
    /// any the Chief or an admin passed on with its request (`RELAYED`).
    pub(super) user_text: String,
    /// A note the app queued (`From::App`) is among what the turn in
    /// progress answers: it isn't a quiet check-in, though nobody asked.
    pub(super) noted: bool,
    /// Another agent's message is among what the turn in progress answers
    /// (or the one it replaced): its words ride in the same prompt as the
    /// user's, so the turn is not the user's alone ([`users_own_ask`]).
    pub(super) agent_in: bool,
    /// Everything the turn in progress answers (and the one it replaced) is
    /// other agents' answers to this agent: it may end with no post
    /// ([`quiet_answer`]).
    pub(super) answers_only: bool,
}

/// Why a take-over can't start now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// A turn is running, or waiting for a slot: it is in the session.
    Busy,
    /// Someone is already driving it.
    Driven,
}

impl Runtime {
    /// Queue `inbound`. `Ok(true)` when a worker must be started to drain
    /// it: nothing is draining yet, and nobody is driving the session.
    /// Refused (handed back) while the agent is being deleted.
    pub(super) fn admit(&mut self, inbound: Inbound) -> Result<bool, Box<Inbound>> {
        if self.deleting {
            return Err(Box::new(inbound));
        }
        // The same message twice (one id, queued again): once is enough.
        if !inbound.id.is_empty() && self.queue.iter().any(|m| m.id == inbound.id) {
            return Ok(false);
        }
        self.queue.push_back(inbound);
        if self.running || self.driven {
            return Ok(false);
        }
        self.running = true;
        Ok(true)
    }

    /// Hand the session to the user. Only while no turn is in it, so there
    /// is never a turn and a terminal on one session at once.
    pub(super) fn claim(&mut self) -> Result<(), Claim> {
        if self.driven {
            return Err(Claim::Driven);
        }
        if self.running || self.queued {
            return Err(Claim::Busy);
        }
        self.driven = true;
        Ok(())
    }

    /// The user handed the session back. `told` opens the next turn's prompt
    /// (after anything already waiting there). True when what queued up
    /// meanwhile needs a worker started. `drop_queue` (the agent is being
    /// deleted) clears what waited instead, in the same step, so no turn can
    /// start between the release and the delete.
    pub(super) fn release(&mut self, told: Option<String>, drop_queue: bool) -> bool {
        if !std::mem::take(&mut self.driven) {
            return false;
        }
        if drop_queue {
            self.queue.clear();
            return false;
        }
        if let Some(told) = told {
            // What the user did in the terminal is the agent's own chat's:
            // a preamble left for a room's turn isn't joined to it.
            let earlier = self
                .interrupted
                .take()
                .filter(|_| self.interrupted_in.is_none());
            self.interrupted = Some(match earlier {
                Some(earlier) => format!("{earlier}{told}"),
                None => told,
            });
            self.interrupted_in = None;
        }
        if self.running || self.queue.is_empty() {
            return false;
        }
        self.running = true;
        true
    }
}

pub(super) static RUNTIMES: LazyLock<Mutex<HashMap<String, Runtime>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
