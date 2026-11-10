//! Keeping a long conversation healthy: the engines' own compaction, on and
//! tuned for every turn, and the app's tidy between turns.
//!
//! **Every turn.** Claude Code gets `autoCompactEnabled: true` through
//! `--settings` (command-line settings outrank the user's own files), its
//! threshold lowered to [`ENGINE_PERCENT`] of the window with
//! `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (which can only lower it), and neither
//! `DISABLE_AUTO_COMPACT` nor `DISABLE_COMPACT` from this app's environment.
//! Codex gets `compact_prompt` (what its summary keeps) and, once a reading
//! has told us the model's window, `model_auto_compact_token_limit` at the
//! same share of it. These are the safety net mid-turn.
//!
//! **Between turns.** Once a turn has finished with nothing else queued and
//! the agent's reading (`context`) is at [`TIDY_PERCENT`] or more, the app
//! runs two quiet turns of its own in the same conversation: first the agent
//! is asked to update its `## Memory` ([`memory_prompt`]), then the engine
//! compacts with [`KEEP`] as its instructions (`/compact …` on Claude Code,
//! `thread/compact/start` on Codex's app-server). Neither turn's words reach
//! the chat; one quiet line does ([`LINE`]). When compaction isn't available
//! (`codex exec`) or doesn't happen, the next message starts a fresh
//! conversation instead, its memory holding the hand-off. Anything that
//! arrives meanwhile waits, as for any turn, and a tidy gives way to it
//! between its two steps.
//!
//! Observed versus assumed: docs/agents.md, "Keeping context healthy".

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::context::ContextFill;
use super::driver::Driver;

/// The share of the window at which the app tidies, between turns.
pub const TIDY_PERCENT: u64 = 70;

/// However large the window, the size at which the app tidies: a 1M window
/// at 70% would re-read ~700k tokens on every resume.
pub const TIDY_TOKENS: u64 = 200_000;

/// The share at which the engine compacts on its own, mid-turn: the safety
/// net under the app's tidy.
pub const ENGINE_PERCENT: u64 = 85;

/// The chat's line for a tidy.
pub const LINE: &str = "Tidied this conversation's memory — nothing lost";

/// The working line while a tidy runs.
pub const ACTIVITY: &str = "Tidying its memory";

/// What any summary of the conversation keeps: the engine's compaction
/// instructions, on both engines.
pub const KEEP: &str = "Keep, in this order: the task in progress and exactly where it stands; \
decisions made and why; open asks (what the user or another agent is waiting on, and what you \
are waiting on); every file, folder, branch, PR, URL and project touched, by full path or link; \
and that your instructions and memory are in your home's CLAUDE.md. Drop greetings, tool output \
you've already acted on, and anything already in your memory.";

/// Codex's `compact_prompt`, which replaces its own summary prompt.
const CODEX_COMPACT: &str = "You are compacting this conversation so it can continue in a \
smaller context. Write a hand-off summary for yourself, in plain prose and short lists, that \
lets you carry on without asking again.";

/// Whether the reading says the conversation is due a tidy: at
/// [`TIDY_PERCENT`] of its window, or [`TIDY_TOKENS`] used, whichever comes
/// first.
pub fn due(fill: Option<&ContextFill>) -> bool {
    fill.is_some_and(|f| {
        f.used >= TIDY_TOKENS
            || (f.window > 0 && f.used.saturating_mul(100) >= f.window * TIDY_PERCENT)
    })
}

/// How a tidy ends the old context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Way {
    /// The engine summarises the conversation in place.
    Compact,
    /// A new conversation on the next message, with memory as the hand-off.
    Fresh,
}

/// What this driver can do: `codex exec` has no way to compact a thread,
/// and ACP none to ask OpenCode for it (its own compaction stays on, by its
/// own settings).
pub fn way(driver: Driver) -> Way {
    match driver {
        Driver::ClaudePrint | Driver::CodexApp => Way::Compact,
        Driver::CodexExec | Driver::OpenCodeAcp => Way::Fresh,
    }
}

/// What the runner knows when a turn ends, for [`between_turns`].
#[derive(Debug, Clone, Copy, Default)]
pub struct Moment {
    /// The turn ran to its end (not stopped, interrupted or failed).
    pub finished: bool,
    /// Something else is queued for the agent: it runs first.
    pub queued: bool,
    /// A card in its chat waits on the user.
    pub waiting_on_user: bool,
    /// The user is driving its session in a terminal.
    pub driven: bool,
    /// The turn answered outside text: it can't write its own memory.
    pub outside: bool,
    /// A project-bound agent with no copy open: its turn would run in the
    /// user's own folder, which a tidy never does.
    pub in_users_folder: bool,
}

/// Whether to tidy now: only between turns, never mid-task.
pub fn between_turns(m: Moment) -> bool {
    m.finished && !m.queued && !m.waiting_on_user && !m.driven && !m.outside && !m.in_users_folder
}

/// The app's own message asking the agent to update its memory first.
/// `fresh`: the next message starts a new conversation, so memory is all
/// that carries over.
pub fn memory_prompt(claude_md: &str, fresh: bool) -> String {
    let after = if fresh {
        "Your next message starts a new conversation that sees only your instructions and memory."
    } else {
        "This conversation is about to be summarised to free up room."
    };
    format!(
        "[From the app, not the user. {after} Before that, update the `## Memory` section of \
`{claude_md}`: add or correct one line per durable fact you've learnt (a preference, a standing \
rule, who someone is, where something lives, a decision that stands). If work is unfinished, keep \
exactly one line starting `In progress:` saying the task, where it stands, open asks, and the \
files, branches and links involved, replacing any earlier one; if nothing is unfinished, remove \
it. Change nothing else, run nothing else, and reply with one word.]"
    )
}

/// Claude Code's compaction, as a turn's prompt.
pub fn claude_compact_prompt() -> String {
    format!("/compact {KEEP}")
}

/// The `--settings` a Claude Code turn gets.
pub fn claude_settings() -> String {
    serde_json::json!({ "autoCompactEnabled": true }).to_string()
}

/// Variables of this app's environment that would turn compaction off.
pub const CLAUDE_ENV_OFF: [&str; 2] = ["DISABLE_AUTO_COMPACT", "DISABLE_COMPACT"];

/// The variables a Claude Code turn gets.
pub fn claude_env() -> [(&'static str, String); 1] {
    [(
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
        ENGINE_PERCENT.to_string(),
    )]
}

/// The `-c` overrides a Codex turn gets. `window`: the model's context
/// window from the agent's last reading, when there is one.
pub fn codex_config(window: Option<u64>) -> Vec<String> {
    let prompt = format!("{CODEX_COMPACT} {KEEP}");
    let mut out = vec![format!("compact_prompt={}", super::codex::toml(&prompt))];
    if let Some(window) = window.filter(|w| *w > 0) {
        out.push(format!(
            "model_auto_compact_token_limit={}",
            window * ENGINE_PERCENT / 100
        ));
    }
    out
}

/// A quiet turn in progress: the app's own, whose words don't reach the chat.
#[derive(Debug, Clone, Copy, Default)]
struct Quiet {
    /// This one compacts (Codex: `thread/compact/start` instead of a turn).
    compacting: bool,
    /// The engine said it compacted.
    compacted: bool,
}

static QUIET: LazyLock<Mutex<HashMap<String, Quiet>>> = LazyLock::new(Default::default);

fn quiet_map() -> std::sync::MutexGuard<'static, HashMap<String, Quiet>> {
    QUIET.lock().unwrap_or_else(|e| e.into_inner())
}

/// Held for one quiet turn.
pub struct QuietTurn(String);

impl QuietTurn {
    pub fn begin(agent_id: &str, compacting: bool) -> Self {
        quiet_map().insert(
            agent_id.to_string(),
            Quiet {
                compacting,
                compacted: false,
            },
        );
        Self(agent_id.to_string())
    }

    /// Whether the engine said it compacted during this turn.
    pub fn compacted(&self) -> bool {
        quiet_map().get(&self.0).is_some_and(|q| q.compacted)
    }
}

impl Drop for QuietTurn {
    fn drop(&mut self) {
        quiet_map().remove(&self.0);
    }
}

/// The agent's turn in progress is the app's own.
pub fn is_quiet(agent_id: &str) -> bool {
    quiet_map().contains_key(agent_id)
}

/// The agent's turn in progress is a compaction.
pub fn is_compacting(agent_id: &str) -> bool {
    quiet_map().get(agent_id).is_some_and(|q| q.compacting)
}

/// The engine said the conversation was compacted. Outside a quiet turn it
/// is the engine's own, mid-turn: only logged.
pub fn note_compacted(agent_id: &str) {
    match quiet_map().get_mut(agent_id) {
        Some(q) => q.compacted = true,
        None => tracing::info!("[Agents] {agent_id}'s engine compacted its conversation mid-turn"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill(used: u64, window: u64) -> ContextFill {
        ContextFill {
            used,
            window,
            at: 1,
            model: None,
        }
    }

    #[test]
    fn a_tidy_is_due_from_seventy_percent_of_the_engines_own_reading() {
        assert!(!due(None));
        assert!(!due(Some(&fill(139_999, 200_000))));
        assert!(due(Some(&fill(140_000, 200_000))));
        assert!(due(Some(&fill(990_000, 1_000_000))));
        // A reading with no window says nothing.
        assert!(!due(Some(&fill(10, 0))));
    }

    #[test]
    fn a_tidy_is_due_at_two_hundred_thousand_tokens_whatever_the_window() {
        // A 1M window: 70% would be 700k; the cap comes first.
        assert!(!due(Some(&fill(199_999, 1_000_000))));
        assert!(due(Some(&fill(200_000, 1_000_000))));
        assert!(due(Some(&fill(450_000, 1_000_000))));
        // A small window still tidies at its 70%.
        assert!(due(Some(&fill(90_000, 128_000))));
        assert!(!due(Some(&fill(80_000, 128_000))));
        // Used tokens alone are a reading, even without a window.
        assert!(due(Some(&fill(200_000, 0))));
    }

    #[test]
    fn a_tidy_waits_for_the_turn_to_be_over_and_nothing_to_need_it() {
        let idle = Moment {
            finished: true,
            ..Moment::default()
        };
        assert!(between_turns(idle));
        for busy in [
            Moment {
                finished: false,
                ..idle
            },
            Moment {
                queued: true,
                ..idle
            },
            Moment {
                waiting_on_user: true,
                ..idle
            },
            Moment {
                driven: true,
                ..idle
            },
            Moment {
                outside: true,
                ..idle
            },
            Moment {
                in_users_folder: true,
                ..idle
            },
        ] {
            assert!(!between_turns(busy), "{busy:?}");
        }
    }

    #[test]
    fn codex_exec_falls_back_to_a_fresh_start() {
        assert_eq!(way(Driver::ClaudePrint), Way::Compact);
        assert_eq!(way(Driver::CodexApp), Way::Compact);
        assert_eq!(way(Driver::CodexExec), Way::Fresh);
    }

    #[test]
    fn the_memory_prompt_names_the_file_and_what_to_keep() {
        let p = memory_prompt("/h/CLAUDE.md", false);
        assert!(p.starts_with("[From the app, not the user."));
        assert!(p.contains("`/h/CLAUDE.md`"));
        assert!(p.contains("## Memory"));
        assert!(p.contains("In progress:"));
        assert!(p.contains("summarised"));
        let fresh = memory_prompt("/h/CLAUDE.md", true);
        assert!(fresh.contains("new conversation"));
    }

    #[test]
    fn compaction_keeps_the_work_the_asks_and_the_memory_pointer() {
        for needed in [
            "task in progress",
            "decisions",
            "open asks",
            "branch",
            "URL",
            "CLAUDE.md",
        ] {
            assert!(KEEP.contains(needed), "{needed}");
        }
        assert!(claude_compact_prompt().starts_with("/compact Keep"));
    }

    #[test]
    fn engines_are_told_to_compact_whatever_the_users_config_says() {
        assert_eq!(claude_settings(), r#"{"autoCompactEnabled":true}"#);
        assert_eq!(claude_env()[0].1, "85");
        let codex = codex_config(Some(200_000));
        assert!(codex[0].starts_with("compact_prompt=\"You are compacting"));
        assert_eq!(codex[1], "model_auto_compact_token_limit=170000");
        // No reading yet: Codex's own threshold, with our instructions.
        assert_eq!(codex_config(None).len(), 1);
    }

    /// The `compact_boundary` a real `/compact` in `--print` printed on
    /// Claude Code 2.1.318 (ids shortened).
    #[test]
    fn claude_codes_compact_boundary_is_a_compaction() {
        let line = serde_json::json!({"type": "system", "subtype": "compact_boundary",
            "session_id": "s1", "compact_metadata": {"trigger": "manual",
            "pre_tokens": 29470, "post_tokens": 9602}});
        let steps = super::super::stream::claude_steps(&line, 1);
        assert!(steps.contains(&super::super::stream::Step::Compacted));
        let status = serde_json::json!({"type": "system", "subtype": "status",
            "status": "compacting", "session_id": "s1"});
        assert!(!super::super::stream::claude_steps(&status, 1)
            .contains(&super::super::stream::Step::Compacted));
    }

    #[test]
    fn a_quiet_turn_is_marked_only_while_it_runs() {
        let id = "tidy-test-agent";
        assert!(!is_quiet(id));
        {
            let turn = QuietTurn::begin(id, true);
            assert!(is_quiet(id) && is_compacting(id));
            assert!(!turn.compacted());
            note_compacted(id);
            assert!(turn.compacted());
        }
        assert!(!is_quiet(id));
        // The engine's own, mid-turn: nothing to mark.
        note_compacted(id);
        assert!(!is_quiet(id));
    }
}
