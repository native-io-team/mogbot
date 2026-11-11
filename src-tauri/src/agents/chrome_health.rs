//! Is Claude in Chrome reachable right now? Asked by the app, per turn, so a
//! turn's way into the user's Chrome is the one that works.
//!
//! Observed: after a Claude account switch Claude in Chrome's native host went
//! stale, `list_connected_browsers` said `[]`, three routines ran `--chrome`
//! into nothing and failed, and the Chief told the owner to "open Chrome with
//! the Claude extension running, signed in to the same account".
//!
//! Per turn ([`before_turn`]), in order:
//!
//! 1. **Your Chrome connected** (`user_chrome::for_turn`: the app's own
//!    extension, a live link right now): the turn uses it and runs
//!    `--no-chrome`. Nothing to probe.
//! 2. Else, only when the turn would get Claude in Chrome
//!    (`browser::allowed`: the team's switch, the agent's, Claude Code, never
//!    outside text): `list_connected_browsers` through
//!    `claude --claude-in-chrome-mcp` ([`check`]), with no model turn, cached
//!    for [`FRESH_MS`] and never run twice at once. A probe that couldn't run
//!    or timed out is [`Reach::Unknown`] and changes nothing: the turn keeps
//!    `--chrome`, as before this check existed.
//! 3. **Down** (no browser answered): `browser::claude_in_chrome_for_turn`
//!    is false, so the turn runs `--no-chrome`, the access chain sends sites
//!    to the agents' browser, and the turn's prompt says why
//!    (`connections::CHROME_DOWN_PROMPT`). The app's own line, once per agent
//!    while it stays down ([`line`]), says what's wrong and the one fix,
//!    Your Chrome, with a button to its settings (`NoteFix::UserChrome`).
//!
//! The setup card's own check (`browser::status`) and the profile list
//! (`browser_profiles::connected`) feed the same cache ([`note_answer`]).

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::AppHandle;

use super::engine::Engine;
use super::store::{self, Agent, MessageKind};

/// How long one answer stands before a turn asks again.
pub const FRESH_MS: i64 = 60_000;
/// Starting Claude Code and asking takes a second or two; past this the
/// answer is "unknown", never "down".
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// What the last probe found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Reach {
    /// Never asked, or the asking failed: nothing is assumed.
    #[default]
    Unknown,
    /// At least one browser answered.
    Up,
    /// Asked, and no browser answered.
    Down,
}

impl Reach {
    /// `Some(n)`: the probe ran and named `n` browsers.
    pub fn from_probe(browsers: Option<usize>) -> Reach {
        match browsers {
            Some(0) => Reach::Down,
            Some(_) => Reach::Up,
            None => Reach::Unknown,
        }
    }
}

/// The cache, and which agents were already told during this outage.
#[derive(Debug, Default)]
pub struct Health {
    pub reach: Reach,
    /// When it was last asked (epoch ms); 0: never.
    pub checked_at: i64,
    said: HashSet<String>,
}

impl Health {
    /// The last answer is recent enough to use without asking again.
    pub fn fresh(&self, now: i64) -> bool {
        self.checked_at > 0 && now.saturating_sub(self.checked_at) < FRESH_MS
    }

    pub fn record(&mut self, reach: Reach, now: i64) {
        self.reach = reach;
        self.checked_at = now;
        // Back up: the next outage is news again.
        if reach == Reach::Up {
            self.said.clear();
        }
    }

    pub fn down(&self) -> bool {
        self.reach == Reach::Down
    }

    /// Whether `agent_id` should be told now: down, and not yet told during
    /// this outage. Telling is recorded.
    pub fn take_line(&mut self, agent_id: &str) -> bool {
        self.down() && self.said.insert(agent_id.to_string())
    }
}

static HEALTH: LazyLock<Mutex<Health>> = LazyLock::new(Default::default);
/// One probe at a time; a turn that waited uses the answer it got.
static PROBING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn health() -> std::sync::MutexGuard<'static, Health> {
    HEALTH.lock().unwrap_or_else(|e| e.into_inner())
}

/// The last probe found no browser. Sync, no probing: what every per-turn
/// decision reads (`browser::claude_in_chrome_for_turn`).
pub fn known_down() -> bool {
    health().down()
}

/// What `list_connected_browsers` answered, as a reach. Only a list the
/// app can read counts: `[]` (verified with none) is down; an answer in any
/// other shape is unknown, never down, so a changed format can't take the
/// browser away from a turn. Pure.
pub fn reach_of(text: &str) -> Reach {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return Reach::Unknown;
    };
    let list = v.as_array().or_else(|| {
        v.get("browsers")
            .or_else(|| v.get("connectedBrowsers"))
            .and_then(serde_json::Value::as_array)
    });
    Reach::from_probe(list.map(Vec::len))
}

/// Another check the app made (the setup card, the profile list) got this
/// answer from `list_connected_browsers`.
pub fn note_answer(text: &str) {
    let reach = reach_of(text);
    if reach != Reach::Unknown {
        health().record(reach, store::now_ms());
    }
}

/// `list_connected_browsers`' text, or `None` when it couldn't be asked or
/// the tool said it failed.
async fn ask(claude: &std::path::Path) -> Option<String> {
    let mut mcp = super::browser::ChromeMcp::start(claude).await.ok()?;
    mcp.call_checked("list_connected_browsers", serde_json::json!({}))
        .await
        .ok()
}

/// Is Claude in Chrome reachable? The cached answer while it's fresh, else
/// one probe (never two at once).
pub async fn check() -> Reach {
    {
        let h = health();
        if h.fresh(store::now_ms()) {
            return h.reach;
        }
    }
    let _one = PROBING.lock().await;
    {
        let h = health();
        if h.fresh(store::now_ms()) {
            return h.reach;
        }
    }
    let answer = match super::engine::binary(Engine::Claude).await {
        Some(claude) => tokio::time::timeout(PROBE_TIMEOUT, ask(&claude))
            .await
            .ok()
            .flatten(),
        None => None,
    };
    let reach = answer.as_deref().map_or(Reach::Unknown, reach_of);
    tracing::info!(?reach, "[Agents] Claude in Chrome checked");
    health().record(reach, store::now_ms());
    reach
}

/// A turn of `agent` would use Claude in Chrome, but for its health: the
/// switches allow it and Your Chrome isn't connected to take its place.
pub fn would_use(agent: &Agent, outside: bool) -> bool {
    super::browser::allowed(super::browser::team_enabled(), agent, outside)
        && !crate::user_chrome::for_turn(agent, outside)
}

/// The app's line when Claude in Chrome isn't answering. `user_chrome_on`:
/// Your Chrome is switched on (but not connected); `agents_browser`: this
/// agent has the agents' browser to fall back on. Pure.
pub fn line(user_chrome_on: bool, agents_browser: bool) -> String {
    let mut s = if user_chrome_on {
        "Chrome isn't reachable: Claude's extension isn't answering and Your Chrome isn't connected. Open Chrome and Your Chrome reconnects by itself (Settings → Chrome).".to_string()
    } else {
        "Chrome isn't reachable through Claude's extension. Set up Your Chrome once (Settings → Chrome) so this can't happen again.".to_string()
    };
    if agents_browser {
        s.push_str(" Until then, agents use their own browser for sites signed in there.");
    }
    s
}

/// The button under [`line`]: "Set up Your Chrome" only when it isn't set
/// up; on but not connected, "Check Your Chrome" (the words say opening
/// Chrome reconnects it, so "Set up" would contradict them).
pub fn fix_for(user_chrome_on: bool) -> store::NoteFix {
    if user_chrome_on {
        store::NoteFix::UserChromeCheck
    } else {
        store::NoteFix::UserChrome
    }
}

/// Before a turn of `agent` builds what it can reach: ask whether Claude in
/// Chrome answers when the turn would use it, and say so once when it
/// doesn't. `quiet` turns (the app's own) never ask.
pub async fn before_turn(app: &AppHandle, agent: &Agent, outside: bool) {
    if !would_use(agent, outside) {
        return;
    }
    if check().await != Reach::Down {
        return;
    }
    if !health().take_line(&agent.id) {
        return;
    }
    let on = crate::user_chrome::settings::enabled();
    let text = line(
        on,
        super::connections::agents_browser_for_turn(agent, outside),
    );
    let mut m = super::runner::new_message(&agent.id, MessageKind::Note, text);
    m.fix = Some(fix_for(on));
    if let Err(e) = super::runner::record(app, m) {
        tracing::warn!("[Agents] couldn't say Chrome isn't reachable: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_probe_that_could_not_run_is_unknown_never_down() {
        assert_eq!(Reach::from_probe(None), Reach::Unknown);
        assert_eq!(Reach::from_probe(Some(0)), Reach::Down);
        assert_eq!(Reach::from_probe(Some(2)), Reach::Up);
    }

    /// docs/design/failure-states.md: the button never contradicts the
    /// note (on but not connected says opening Chrome reconnects it).
    #[test]
    fn the_button_matches_the_note() {
        assert_eq!(fix_for(false), store::NoteFix::UserChrome);
        assert!(line(false, false).contains("Set up Your Chrome"));
        assert_eq!(fix_for(true), store::NoteFix::UserChromeCheck);
        assert!(!line(true, false).contains("Set up"));
        let wire = serde_json::to_value(store::NoteFix::UserChromeCheck).unwrap();
        assert_eq!(wire, "user_chrome_check");
        assert_eq!(serde_json::to_value(store::NoteFix::Disk).unwrap(), "disk");
    }

    #[test]
    fn agents_point_to_your_chrome_never_to_the_claude_extension() {
        // The incident: "open Chrome with the Claude extension running,
        // signed in to the same account". The turn's own words and every
        // agent's standing rules point at Your Chrome instead.
        let down = super::super::connections::CHROME_DOWN_PROMPT;
        assert!(down.contains("Never tell the user to sign out of or into the Claude extension"));
        assert!(down.contains("Settings → Chrome"));
        assert!(down.contains("mcp__browser__*"));
        let rules = super::super::logins::RULES;
        assert!(rules.contains(
            "Chrome not answering? The fix is Settings → Chrome, never the Claude extension."
        ));
    }

    #[test]
    fn only_a_list_it_can_read_says_down() {
        assert_eq!(reach_of("[]"), Reach::Down);
        assert_eq!(reach_of(" [] \n"), Reach::Down);
        assert_eq!(reach_of(r#"[{"name":"Browser 1"}]"#), Reach::Up);
        assert_eq!(reach_of(r#"{"browsers":[]}"#), Reach::Down);
        assert_eq!(reach_of(r#"{"connectedBrowsers":["a"]}"#), Reach::Up);
        assert_eq!(reach_of("No browsers"), Reach::Unknown);
        assert_eq!(reach_of(r#"{"error":"x"}"#), Reach::Unknown);
        assert_eq!(reach_of(""), Reach::Unknown);
    }

    #[test]
    fn an_answer_stands_for_a_minute() {
        let mut h = Health::default();
        assert!(!h.fresh(1_000), "never asked");
        h.record(Reach::Up, 1_000);
        assert!(h.fresh(1_000 + FRESH_MS - 1));
        assert!(!h.fresh(1_000 + FRESH_MS));
    }

    #[test]
    fn each_agent_is_told_once_per_outage() {
        let mut h = Health::default();
        assert!(!h.take_line("a"), "nothing known: nothing said");
        h.record(Reach::Down, 1);
        assert!(h.take_line("a"));
        assert!(!h.take_line("a"), "said once");
        assert!(h.take_line("b"), "another agent hears it too");
        // Unknown in between neither clears nor repeats.
        h.record(Reach::Unknown, 2);
        assert!(!h.down());
        h.record(Reach::Down, 3);
        assert!(!h.take_line("a"));
        // Back up, then down again: a new outage.
        h.record(Reach::Up, 4);
        assert!(!h.take_line("a"));
        h.record(Reach::Down, 5);
        assert!(h.take_line("a"));
    }

    #[test]
    fn the_line_names_the_problem_and_one_fix_never_the_claude_extension() {
        let off = line(false, true);
        assert_eq!(
            off,
            "Chrome isn't reachable through Claude's extension. Set up Your Chrome once (Settings → Chrome) so this can't happen again. Until then, agents use their own browser for sites signed in there."
        );
        let on = line(true, false);
        assert!(on.contains("Your Chrome isn't connected"));
        assert!(on.contains("Settings → Chrome"));
        assert!(!on.contains("their own browser"));
        for l in [off, on] {
            let lower = l.to_lowercase();
            assert!(!lower.contains("sign out"), "{l}");
            assert!(!lower.contains("sign in"), "{l}");
            assert!(!lower.contains("same account"), "{l}");
            assert!(!lower.contains("reinstall"), "{l}");
        }
    }
}
