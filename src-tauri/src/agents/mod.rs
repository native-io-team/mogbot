//! # Agents
//!
//! Persistent, named AI agents the user chats with, a Grok Bot-style
//! experience running on the user's own Claude Code. One of them, the Chief of
//! Staff, manages the rest: it creates, briefs, delegates to and deletes them.
//!
//! - [`apps`]: the user's Claude Code MCP servers, which every turn loads
//! - [`store`]: the registry and each agent's home (CLAUDE.md + chat log)
//! - [`runner`]: per-agent inbox; each turn is one `claude --print --resume`
//!   or one `codex app-server` (`codex exec [resume]` on a Codex without it)
//! - [`engine`]: Claude Code or Codex per agent: availability, sign-in, models
//! - [`driver`]: how one turn runs its engine (the per-engine boundary)
//! - [`claude`]: Claude Code's command line for a turn
//! - [`codex`]: Codex's command line and JSONL, mapped onto the same turn steps
//! - [`codex_app`]: Codex's app-server: streaming, approval cards, interrupt
//! - [`context`]: how full a conversation is, only as its engine reports it
//! - [`mcp`]: the tools agents get (team, projects, management, approvals)
//! - [`permissions`]: "Always allow" rules and how narrowly they match
//! - [`notify`]: macOS notifications and the Dock badge
//! - [`tray`]: the menu-bar icon, and what a quit would interrupt
//! - [`quick_entry`]: the system-wide shortcut and its floating composer
//! - [`attachments`]: files sent with a message, copied into the agent's home
//! - [`failure`]: a failed turn in Agents' own words (usage limit, signed out)
//! - [`files`]: files an agent shares back, the Files list, paths in prose
//! - [`import`]: bring an existing setup over from another assistant
//! - [`other_app`]: a one-time, read-only copy of the team from the app this grew out of
//! - [`schedule`]: check-ins and routines that wake an agent on time
//! - [`project`]: binding an agent to a project, and what its turns changed there
//! - [`task`]: a copy of the project (a git worktree) per task, kept or discarded
//! - [`procs`]: a turn's whole process tree, so Stop and quit leave nothing running
//! - [`prompts`]: voice and role
//! - [`search`]: find a message across every conversation
//! - [`secrets`]: credentials an agent asked for, kept in the Keychain, never shown to it
//! - [`stream`]: a reply while it is being written (drafts)
//! - [`usage`]: tokens and cost per agent, from each turn's `result` event
//! - [`work`]: what a turn did, step by step, for the timeline under its reply
//!
//! Full design: docs/agents.md.

pub mod apps;
pub mod attachments;
pub mod broker;
pub mod capabilities;
pub mod capacity;
pub mod claude;
pub mod codex;
pub mod codex_app;
pub mod connector;
pub mod context;
pub mod decisions;
pub mod driver;
pub mod engine;
pub mod failure;
pub mod files;
pub mod import;
pub mod interview;
pub mod mcp;
pub mod memory;
pub mod notify;
pub mod other_app;
pub mod paste;
pub mod permissions;
pub mod procs;
pub mod project;
pub mod prompts;
pub mod quick_entry;
pub mod quota;
pub mod results;
pub mod review;
pub mod runner;
pub mod runs;
pub mod schedule;
pub mod search;
pub mod secrets;
pub mod sessions;
pub mod store;
pub mod stream;
pub mod takeover;
pub mod task;
pub mod tray;
pub mod usage;
pub mod watch;
pub mod work;

use crate::errors::CommandError;

pub(crate) fn err_other(message: impl std::fmt::Display) -> CommandError {
    CommandError::Other {
        message: message.to_string(),
    }
}

pub(crate) fn err_io(e: impl std::fmt::Display) -> CommandError {
    CommandError::Io {
        message: e.to_string(),
    }
}

pub(crate) fn err_invalid(field: &str, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.to_string(),
        reason: reason.into(),
    }
}

/// The Chief speaks first: a new Chief's chat opens on its greeting. A
/// failure here is logged, never fatal; the chat is only emptier.
fn greet(agent_id: &str) {
    let message = store::AgentMessage {
        id: store::new_id(),
        agent_id: agent_id.to_string(),
        ts: store::now_ms(),
        kind: store::MessageKind::Agent,
        text: prompts::CHIEF_GREETING.to_string(),
        peer: None,
        approval: None,
        attachments: Vec::new(),
        check_in: None,
        stopped: false,
        mentions: Vec::new(),
        failure: None,
        changes: None,
        session: None,
        client_id: None,
        work: None,
        fresh: false,
        result: None,
        revises: None,
        takeover: false,
    };
    if let Err(e) = store::append_message(&message) {
        tracing::warn!("[Agents] Couldn't write the Chief's greeting: {e}");
    }
}

/// The Chief of Staff exists from the first time anyone looks.
pub fn ensure_main() -> Result<store::Agent, CommandError> {
    if let Some(main) = store::list()?.into_iter().find(|a| a.is_main) {
        return Ok(main);
    }
    let created = store::create(store::NewAgent {
        name: prompts::CHIEF_NAME.to_string(),
        role: prompts::CHIEF_ROLE.to_string(),
        instructions: prompts::CHIEF_INSTRUCTIONS.to_string(),
        shape: Some(5),
        color: Some("white".to_string()),
        is_main: true,
    });
    match created {
        Ok(agent) => {
            greet(&agent.id);
            Ok(agent)
        }
        // Two callers raced; the other one made it.
        Err(_) => store::list()?
            .into_iter()
            .find(|a| a.is_main)
            .ok_or_else(|| err_other("Couldn't create the Chief of Staff.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_chief_opens_on_its_greeting_once() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let chief = ensure_main().unwrap();
        let again = ensure_main().unwrap();
        let log = store::messages(&chief.id, 10).unwrap();
        store::set_root_for_tests(None);
        assert_eq!(chief.id, again.id);
        assert_eq!(
            log.len(),
            1,
            "one greeting, however often the Chief is looked up"
        );
        assert_eq!(log[0].kind, store::MessageKind::Agent);
        assert_eq!(log[0].text, prompts::CHIEF_GREETING);
    }
}

#[cfg(test)]
mod audit_tests;
