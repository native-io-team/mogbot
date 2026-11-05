//! What the approval broker (`mcp::approve`) trusts before it puts a card in
//! front of the user, and what it checks Claude Code is actually doing.
//!
//! - **A caller is who its secret says.** Each turn (and each take-over
//!   terminal) is granted a random 256-bit secret ([`grant`]), which its CLI
//!   sends as `Authorization: Bearer`, read from a 0600 config file or an
//!   environment variable: never from a command line, where `ps` shows it to
//!   every local account. The secret names the agent and the turn; nothing
//!   in the URL does. It stops working the moment its turn ends.
//! - **A request belongs to a live turn.** A request with no turn, from a
//!   turn that has ended (a dying process, a Stop that raced it), or naming a
//!   turn that was never issued is denied at once: it would only ever be a
//!   zombie card nobody can act on.
//! - **A request is asked once.** A repeated `tool_use_id` is denied rather
//!   than shown twice.
//! - **The permission mode is read, not assumed.** We start every turn in
//!   `acceptEdits` and rely on Claude Code asking us for everything else. Its
//!   `system/init` event says the mode it really runs in (verified on Claude
//!   Code 2.1.318: `"permissionMode": "acceptEdits"`). If that is
//!   `bypassPermissions`, nothing would ever ask, so the turn is stopped
//!   before it does anything; a stricter mode is noted once and carried on.
//!   If our own server failed to start, its approval tool doesn't exist, and
//!   the turn is stopped too.
//!
//! The same event lists the user's connectors and which of them need signing
//! in again (`"status": "needs-auth"`); scheduled runs report those.

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use tauri::AppHandle;

use super::prompts::SERVER_KEY;
use super::runner;
use super::store::MessageKind;

/// Request ids remembered per agent, for refusing a repeat.
const SEEN_PER_AGENT: usize = 256;

#[derive(Default)]
struct Book {
    issued: u64,
    /// Agent id → the turn it has open.
    open: HashMap<String, u64>,
    seen: HashMap<String, VecDeque<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Live,
    /// No turn named, or one that was never issued.
    NoTurn,
    /// A turn that has ended, or one replaced by a newer turn.
    Closed,
    /// This request id was already asked.
    Duplicate,
}

impl Book {
    fn open(&mut self, agent_id: &str) -> u64 {
        self.issued += 1;
        self.open.insert(agent_id.to_string(), self.issued);
        self.issued
    }

    fn close(&mut self, agent_id: &str, turn: u64) {
        if self.open.get(agent_id) == Some(&turn) {
            self.open.remove(agent_id);
        }
    }

    fn admit(&mut self, agent_id: &str, turn: Option<u64>, request_id: Option<&str>) -> Admission {
        let Some(turn) = turn.filter(|t| (1..=self.issued).contains(t)) else {
            return Admission::NoTurn;
        };
        if self.open.get(agent_id) != Some(&turn) {
            return Admission::Closed;
        }
        if let Some(id) = request_id {
            let seen = self.seen.entry(agent_id.to_string()).or_default();
            if seen.iter().any(|s| s == id) {
                return Admission::Duplicate;
            }
            seen.push_back(id.to_string());
            if seen.len() > SEEN_PER_AGENT {
                seen.pop_front();
            }
        }
        Admission::Live
    }
}

static BOOK: LazyLock<Mutex<Book>> = LazyLock::new(|| Mutex::new(Book::default()));

fn book() -> std::sync::MutexGuard<'static, Book> {
    BOOK.lock().unwrap_or_else(|e| e.into_inner())
}

/* ------------------------------------------------------ bridge access */

/// Who a request to the agents endpoint comes from, as its secret says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub agent_id: String,
    /// The headless turn it belongs to; `None` for a take-over terminal,
    /// whose CLI asks the person at the keyboard rather than the broker.
    pub turn: Option<u64>,
}

static GRANTS: LazyLock<Mutex<HashMap<String, Caller>>> = LazyLock::new(Default::default);

fn grants() -> std::sync::MutexGuard<'static, HashMap<String, Caller>> {
    GRANTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 256 bits from the OS, as hex.
pub fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("the OS random number generator is unavailable");
    hex::encode(bytes)
}

/// A secret that opens the agents endpoint as one agent, for as long as this
/// is held. Dropping it revokes the secret.
#[derive(Debug)]
pub struct Access {
    secret: String,
}

impl Access {
    pub fn secret(&self) -> &str {
        &self.secret
    }
}

impl Drop for Access {
    fn drop(&mut self) {
        grants().remove(&self.secret);
    }
}

/// Issue a fresh secret for `agent_id` (and `turn`, when it's a turn's).
pub fn grant(agent_id: &str, turn: Option<u64>) -> Access {
    let secret = new_secret();
    grants().insert(
        secret.clone(),
        Caller {
            agent_id: agent_id.to_string(),
            turn,
        },
    );
    Access { secret }
}

/// Who holds `secret`, while it's live. An empty or unknown secret is no one.
pub fn caller(secret: &str) -> Option<Caller> {
    if secret.len() != 64 {
        return None;
    }
    grants().get(secret).cloned()
}

/// A turn's id, open for as long as this is held: dropped when `run_turn`
/// returns, however it returns. It carries the turn's bridge secret, which
/// is revoked with it.
pub struct TurnGuard {
    agent_id: String,
    id: u64,
    access: Access,
}

impl TurnGuard {
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The secret this turn's CLI presents to the agents endpoint.
    pub fn secret(&self) -> &str {
        self.access.secret()
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        book().close(&self.agent_id, self.id);
    }
}

pub fn open_turn(agent_id: &str) -> TurnGuard {
    let id = book().open(agent_id);
    TurnGuard {
        agent_id: agent_id.to_string(),
        id,
        access: grant(agent_id, Some(id)),
    }
}

/// Whether the broker should take this request to the user at all.
pub fn admit(agent_id: &str, turn: Option<u64>, request_id: Option<&str>) -> Admission {
    book().admit(agent_id, turn, request_id)
}

/// What Claude Code is told when a request is refused without asking.
pub fn refusal(admission: Admission) -> &'static str {
    match admission {
        Admission::Live => "",
        Admission::Duplicate => "This exact request was already put to the user; it isn't asked twice. Wait for that answer, or tell the user what you need.",
        Admission::NoTurn | Admission::Closed => "This request arrived after its turn had ended, so it was declined without asking the user. If you still need it, say so in your next reply.",
    }
}

/* ------------------------------------------------------- the init event */

/// What a turn's `system/init` event said that matters here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Init {
    pub permission_mode: Option<String>,
    /// Connectors Claude Code says need signing in again, by display name.
    pub needs_sign_in: Vec<String>,
    /// Our own server's status, if it was listed.
    pub ours: Option<String>,
}

pub fn read_init(event: &Value) -> Option<Init> {
    if event.get("type")?.as_str()? != "system" || event.get("subtype")?.as_str()? != "init" {
        return None;
    }
    let servers = event
        .get("mcp_servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let status = |s: &Value| s.get("status").and_then(Value::as_str).map(str::to_string);
    Some(Init {
        permission_mode: event
            .get("permissionMode")
            .and_then(Value::as_str)
            .map(str::to_string),
        needs_sign_in: servers
            .iter()
            .filter(|s| status(s).as_deref() == Some("needs-auth"))
            .filter_map(|s| s.get("name").and_then(Value::as_str))
            .map(|n| n.trim_start_matches("claude.ai ").to_string())
            .collect(),
        ours: servers
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some(SERVER_KEY))
            .and_then(status),
    })
}

/// The permission mode every turn is started in (`claude::args`).
pub const EXPECTED_MODE: &str = "acceptEdits";

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Fine,
    /// Carry on, saying this once in the chat.
    Note(String),
    /// Stop the turn before it does anything, with this as its error.
    Stop(&'static str),
}

pub fn judge(init: &Init) -> Verdict {
    if init.ours.as_deref() == Some("failed") {
        return Verdict::Stop("The connection to Claude Code didn't start for this turn, so nothing could ask you before acting. It was stopped. Send your message again.");
    }
    match init.permission_mode.as_deref() {
        None | Some(EXPECTED_MODE) => Verdict::Fine,
        Some("bypassPermissions") => Verdict::Stop("Claude Code started this turn with permission checks off (bypassPermissions), so nothing would have asked you first. It was stopped before doing anything. Check Claude Code's permission settings, then send your message again."),
        Some(mode @ ("default" | "plan" | "dontAsk")) => Verdict::Note(format!(
            "Claude Code ran this turn in its “{mode}” permission mode rather than accept-edits, so it may ask more often or do less."
        )),
        Some(mode) => Verdict::Note(format!(
            "Claude Code reported a permission mode this app doesn't know (“{mode}”). Requests still come to you here."
        )),
    }
}

/// The latest init per agent, for scheduled runs to report connectors.
static SEEN_INIT: LazyLock<Mutex<HashMap<String, Init>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Agents already told about an unexpected mode this session.
static NOTED: LazyLock<Mutex<HashSet<(String, String)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Called with each `system` event of a turn. Returns the reason to stop the
/// turn, if it must not go on.
pub fn observe(app: &AppHandle, agent_id: &str, event: &Value) -> Option<&'static str> {
    let init = read_init(event)?;
    if init.permission_mode.is_none() {
        tracing::warn!("[Agents] Claude Code's init didn't say its permission mode; approvals can't be checked");
    }
    let verdict = judge(&init);
    SEEN_INIT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), init.clone());
    match verdict {
        Verdict::Fine => None,
        Verdict::Stop(why) => {
            tracing::warn!(agent = agent_id, mode = ?init.permission_mode, ours = ?init.ours, "[Agents] stopping a turn whose permissions can't be trusted");
            Some(why)
        }
        Verdict::Note(text) => {
            let key = (
                agent_id.to_string(),
                init.permission_mode.clone().unwrap_or_default(),
            );
            if NOTED.lock().unwrap_or_else(|e| e.into_inner()).insert(key) {
                tracing::warn!(agent = agent_id, mode = ?init.permission_mode, "[Agents] unexpected permission mode");
                let _ = runner::record(app, runner::new_message(agent_id, MessageKind::Note, text));
            }
            None
        }
    }
}

/// Connectors the agent's latest turn couldn't use until they're signed in again.
pub fn needs_sign_in(agent_id: &str) -> Vec<String> {
    SEEN_INIT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .map(|i| i.needs_sign_in.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_live_turns_requests_reach_the_user() {
        let mut book = Book::default();
        assert_eq!(book.admit("a", None, Some("t1")), Admission::NoTurn);
        assert_eq!(book.admit("a", Some(9), Some("t1")), Admission::NoTurn);
        let first = book.open("a");
        assert_eq!(book.admit("a", Some(first), Some("t1")), Admission::Live);
        // Another agent's turn isn't this one's.
        let other = book.open("b");
        assert_eq!(book.admit("a", Some(other), Some("t2")), Admission::Closed);
        // A newer turn replaces the old one: the old one's late requests are refused.
        let second = book.open("a");
        assert_eq!(book.admit("a", Some(first), Some("t3")), Admission::Closed);
        assert_eq!(book.admit("a", Some(second), Some("t3")), Admission::Live);
        // After it ends, nothing from it is asked.
        book.close("a", second);
        assert_eq!(book.admit("a", Some(second), Some("t4")), Admission::Closed);
        // Closing an old turn doesn't close the new one.
        let third = book.open("a");
        book.close("a", second);
        assert_eq!(book.admit("a", Some(third), Some("t5")), Admission::Live);
    }

    #[test]
    fn a_repeated_request_id_is_refused() {
        let mut book = Book::default();
        let turn = book.open("a");
        assert_eq!(
            book.admit("a", Some(turn), Some("toolu_1")),
            Admission::Live
        );
        assert_eq!(
            book.admit("a", Some(turn), Some("toolu_1")),
            Admission::Duplicate
        );
        // Even in a later turn.
        let next = book.open("a");
        assert_eq!(
            book.admit("a", Some(next), Some("toolu_1")),
            Admission::Duplicate
        );
        // Another agent's ids are its own.
        let b = book.open("b");
        assert_eq!(book.admit("b", Some(b), Some("toolu_1")), Admission::Live);
        // No id: can't be checked for repeats, but still needs a live turn.
        assert_eq!(book.admit("a", Some(next), None), Admission::Live);
    }

    #[test]
    fn the_guard_closes_its_turn_on_any_return() {
        let (turn, id) = {
            let guard = open_turn("guarded-agent");
            let id = guard.id();
            (admit("guarded-agent", Some(id), Some("g1")), id)
        };
        assert_eq!(turn, Admission::Live);
        assert_eq!(
            admit("guarded-agent", Some(id), Some("g2")),
            Admission::Closed
        );
    }

    #[test]
    fn a_turns_secret_names_it_and_dies_with_it() {
        let (secret, id) = {
            let guard = open_turn("secret-agent");
            let secret = guard.secret().to_string();
            assert_eq!(secret.len(), 64);
            assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(
                caller(&secret),
                Some(Caller {
                    agent_id: "secret-agent".into(),
                    turn: Some(guard.id()),
                })
            );
            (secret, guard.id())
        };
        // The turn is over: its secret opens nothing, and its id is closed.
        assert_eq!(caller(&secret), None);
        assert_eq!(admit("secret-agent", Some(id), None), Admission::Closed);
    }

    #[test]
    fn secrets_are_random_not_sequential_and_unguessable() {
        let a = open_turn("seq-agent");
        let b = open_turn("seq-agent");
        assert_ne!(a.secret(), b.secret());
        // Neither the agent id, nor the turn id, nor a near miss gets in.
        assert_eq!(caller("seq-agent"), None);
        assert_eq!(caller(&b.id().to_string()), None);
        assert_eq!(caller(""), None);
        let mut near = a.secret().to_string();
        let first = if near.starts_with('0') { "1" } else { "0" };
        near.replace_range(0..1, first);
        assert_eq!(caller(&near), None);
        assert_eq!(caller(&a.secret()[..63]), None);
    }

    #[test]
    fn a_take_over_grant_has_no_turn_and_ends_when_dropped() {
        let access = grant("driven-agent", None);
        let secret = access.secret().to_string();
        assert_eq!(
            caller(&secret),
            Some(Caller {
                agent_id: "driven-agent".into(),
                turn: None,
            })
        );
        drop(access);
        assert_eq!(caller(&secret), None);
    }

    /// Trimmed from a real Claude Code 2.1.318 init event.
    fn init_event(mode: Option<&str>, ours: &str) -> Value {
        let mut event = json!({
            "type": "system", "subtype": "init", "session_id": "s",
            "mcp_servers": [
                {"name": "Sanity", "status": "connected", "source": "user"},
                {"name": "webflow", "status": "needs-auth", "source": "user"},
                {"name": "claude.ai Google Drive", "status": "needs-auth", "source": "claudeai"},
                {"name": SERVER_KEY, "status": ours}
            ],
            "claude_code_version": "2.1.318"
        });
        if let Some(mode) = mode {
            event["permissionMode"] = json!(mode);
        }
        event
    }

    #[test]
    fn the_real_permission_mode_is_read_and_judged() {
        let init = read_init(&init_event(Some("acceptEdits"), "connected")).unwrap();
        assert_eq!(init.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(init.needs_sign_in, vec!["webflow", "Google Drive"]);
        assert_eq!(judge(&init), Verdict::Fine);

        let bypass = read_init(&init_event(Some("bypassPermissions"), "connected")).unwrap();
        assert!(matches!(judge(&bypass), Verdict::Stop(_)));
        let plan = read_init(&init_event(Some("plan"), "connected")).unwrap();
        assert!(matches!(judge(&plan), Verdict::Note(n) if n.contains("plan")));
        let odd = read_init(&init_event(Some("auto"), "connected")).unwrap();
        assert!(matches!(judge(&odd), Verdict::Note(_)));
        // Not said: nothing to check against, so nothing is claimed.
        let silent = read_init(&init_event(None, "connected")).unwrap();
        assert_eq!(judge(&silent), Verdict::Fine);
        // Our server down means no approval tool: never carry on without it.
        let down = read_init(&init_event(Some("acceptEdits"), "failed")).unwrap();
        assert!(matches!(judge(&down), Verdict::Stop(_)));
        // Only the init event counts.
        assert!(read_init(&json!({"type": "system", "subtype": "compact_boundary"})).is_none());
    }
}
