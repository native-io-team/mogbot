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
//! - [`policy`]: what each agent may do (projects, folders, apps, browser, independence, rules), and the team default
//! - [`policy_card`]: "Change this agent's settings?", the card behind `propose_settings_change`
//! - [`notify`]: macOS notifications and the Dock badge
//! - [`tray`]: the menu-bar icon, and what a quit would interrupt
//! - [`quick_entry`]: the system-wide shortcut and its floating composer
//! - [`attachments`]: files sent with a message, copied into the agent's home
//! - [`failure`]: a failed turn in Agents' own words (usage limit, signed out)
//! - [`files`]: files an agent shares back, the Files list, paths in prose
//! - [`import`]: bring an existing setup over from another assistant
//! - [`arrival`]: an imported agent told where it is now (its home, foreign paths, tools)
//! - [`other_app`]: a one-time, read-only copy of the team from the app this grew out of
//! - [`schedule`]: check-ins and routines that wake an agent on time
//! - [`project`]: binding an agent to a project, and what its turns changed there
//! - [`task`]: a copy of the project (a git worktree) per task, kept or discarded
//! - [`procs`]: a turn's whole process tree, so Stop and quit leave nothing running
//! - [`prompts`]: voice and role
//! - [`rooms`]: group conversations of 2–6 agents, @one or @everyone
//! - [`search`]: find a message across every conversation
//! - [`secrets`]: credentials an agent asked for, kept in the Keychain, never shown to it
//! - [`logins`]: login cards (`request_login`), the team's list, what an agent can reach
//! - [`browser`]: the team's signed-in Chrome (Claude in Chrome), set up once, per agent, never for outside text
//! - [`browser_profiles`]: which Chrome profile a site is signed in to, found by the agent and remembered by the app
//! - [`access_check`]: "Checking what your team can already reach" after an import
//! - [`conn_relay`]: a turn reaches a connected app through the bridge, never holding its token
//! - [`connections`]: accounts connected through them, per-agent grants, what a turn gets
//! - [`oauth`]: signing in to a remote MCP server ourselves (PKCE, loopback)
//! - [`team_setup`]: "Setting up your team" after an import: one checklist, quiet agents, the fan-out cap
//! - [`templates`]: ready-made agents (role templates) the Chief and the New agent dialog offer
//! - [`stream`]: a reply while it is being written (drafts)
//! - [`usage`]: tokens and cost per agent, from each turn's `result` event
//! - [`work`]: what a turn did, step by step, for the timeline under its reply
//!
//! Full design: docs/agents.md.

pub mod access_chain;
pub mod access_check;
pub mod admin;
pub mod apps;
pub mod arrival;
pub mod attachments;
pub mod autoallow;
pub mod broker;
pub mod browser;
pub mod browser_gate;
pub mod browser_profiles;
pub mod capabilities;
pub mod capacity;
pub mod claude;
pub mod codex;
pub mod codex_app;
pub mod conn_relay;
pub mod connections;
pub mod connector;
pub mod context;
pub mod decisions;
pub mod defaults;
pub mod describe;
pub mod driver;
pub mod engine;
pub mod expiry;
pub mod failure;
pub mod files;
pub mod forecast;
pub mod go_hard;
pub mod harvest;
pub mod import;
pub mod independence;
pub mod interview;
pub mod inventory;
pub mod login_relay;
pub mod logins;
pub mod mcp;
pub mod memory;
pub mod notify;
pub mod oauth;
pub mod other_app;
pub mod paste;
pub mod permissions;
pub mod policy;
pub mod policy_card;
pub mod preview_test;
pub mod procs;
pub mod project;
pub mod prompts;
pub mod quick_entry;
pub mod quota;
pub mod reach;
pub mod results;
pub mod review;
pub mod room_tools;
pub mod rooms;
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
pub mod team_setup;
pub mod templates;
pub mod tray;
pub mod usage;
pub mod usage_plan;
pub mod usage_tools;
pub mod wallet;
pub mod watch;
pub mod watch_seal;
pub mod work;
pub mod workplace;

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
        room: None,
        decide: Vec::new(),
    };
    if let Err(e) = store::append_message(&message) {
        tracing::warn!("[Agents] Couldn't write the Chief's greeting: {e}");
    }
}

/// The Chief of Staff exists from the first time anyone looks.
pub fn ensure_main() -> Result<store::Agent, CommandError> {
    if let Some(main) = store::list()?.into_iter().find(|a| a.is_main) {
        admin::note_upgrade(&main);
        if let Err(e) = upgrade_chief(&main) {
            tracing::warn!("[Agents] Couldn't bring the Chief's instructions up to date: {e}");
        }
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
            admin::mark_noted(&agent.id);
            Ok(agent)
        }
        // Two callers raced; the other one made it.
        Err(_) => store::list()?
            .into_iter()
            .find(|a| a.is_main)
            .ok_or_else(|| err_other("Couldn't create the Chief of Staff.")),
    }
}

/// Bring a Chief made by an older build onto the current `CHIEF_INSTRUCTIONS`.
///
/// Only the app's own words are replaced: the old default, found word for
/// word in its `## Instructions`, becomes the new one, and anything the user
/// added around it stays where it was. Instructions the user rewrote (no old
/// default left intact) are theirs and are never touched, not even appended
/// to: new guidance tacked onto rules someone chose could contradict them.
/// Memory, the role and the heading are kept by `write_instructions`. Cheap
/// and idempotent (one read), so it runs on every look-up of the Chief.
/// Returns whether it rewrote anything.
pub(crate) fn upgrade_chief(chief: &store::Agent) -> Result<bool, CommandError> {
    let current = store::read_instructions(&chief.id)?;
    let Some(upgraded) = upgraded_chief_instructions(&current) else {
        return Ok(false);
    };
    store::write_instructions(&store::agent_home(&chief.id)?, chief, &upgraded)?;
    tracing::info!("[Agents] The Chief's instructions were brought up to date");
    Ok(true)
}

/// `instructions` with an old default swapped for the current one, or `None`
/// when there is nothing of ours to replace.
fn upgraded_chief_instructions(instructions: &str) -> Option<String> {
    if instructions.contains(prompts::CHIEF_INSTRUCTIONS) {
        return None;
    }
    // Longest first: an early default is a prefix of the one after it.
    let mut past: Vec<&str> = prompts::PAST_CHIEF_INSTRUCTIONS.to_vec();
    past.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let old = past.into_iter().find(|p| instructions.contains(p))?;
    Some(instructions.replacen(old, prompts::CHIEF_INSTRUCTIONS, 1))
}

/// Whether `instructions` is one of the Chief's defaults, current or past:
/// the app's words, not the user's.
pub(crate) fn is_chief_default(instructions: &str) -> bool {
    let t = instructions.trim();
    t == prompts::CHIEF_INSTRUCTIONS || prompts::PAST_CHIEF_INSTRUCTIONS.contains(&t)
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

    fn chief_with(dir: &std::path::Path, instructions: &str, memory: &str) -> store::Agent {
        store::set_root_for_tests(Some(dir.to_path_buf()));
        let chief = ensure_main().unwrap();
        let home = store::agent_home(&chief.id).unwrap();
        let md = format!(
            "# {}\n\n{}\n\n## Instructions\n\n{instructions}\n\n## Memory\n\n{memory}\n",
            chief.name, chief.role
        );
        std::fs::write(home.join("CLAUDE.md"), md).unwrap();
        chief
    }

    fn claude_md(chief: &store::Agent) -> String {
        std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md")).unwrap()
    }

    #[test]
    fn an_older_chief_gets_the_new_instructions_and_keeps_its_memory() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let memory = "- Julian runs a design studio.\n- Prefers mornings.";
        for old in prompts::PAST_CHIEF_INSTRUCTIONS {
            let chief = chief_with(dir.path(), old, memory);
            ensure_main().unwrap();
            let after = claude_md(&chief);
            assert_eq!(
                store::read_instructions(&chief.id).unwrap(),
                prompts::CHIEF_INSTRUCTIONS
            );
            assert!(after.contains(memory), "memory kept: {after}");
            assert!(after.contains(prompts::CHIEF_ROLE));
            // Once is enough: nothing changes on the next look.
            ensure_main().unwrap();
            assert_eq!(claude_md(&chief), after);
        }
        store::set_root_for_tests(None);
    }

    #[test]
    fn what_the_user_added_around_the_old_default_stays() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        let old = prompts::PAST_CHIEF_INSTRUCTIONS.last().unwrap();
        let theirs = format!("{old}\n\n### From the other app\n\nAlways answer in French.");
        let chief = chief_with(dir.path(), &theirs, "- Has two cats.");
        assert!(upgrade_chief(&chief).unwrap());
        let now = store::read_instructions(&chief.id).unwrap();
        store::set_root_for_tests(None);
        assert_eq!(
            now,
            format!(
                "{}\n\n### From the other app\n\nAlways answer in French.",
                prompts::CHIEF_INSTRUCTIONS
            )
        );
    }

    #[test]
    fn instructions_the_user_rewrote_are_left_alone() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        // The old default with one word changed is the user's now.
        let old = prompts::PAST_CHIEF_INSTRUCTIONS
            .iter()
            .rev()
            .find(|p| p.contains("daily brief"))
            .unwrap();
        let edited = old.replace("daily brief", "weekly brief");
        assert_ne!(&edited, old);
        for theirs in [
            edited.as_str(),
            "Be brief. Never create agents without asking.",
        ] {
            let chief = chief_with(dir.path(), theirs, "- Likes tea.");
            let before = claude_md(&chief);
            assert!(!upgrade_chief(&chief).unwrap());
            ensure_main().unwrap();
            assert_eq!(claude_md(&chief), before, "untouched");
        }
        store::set_root_for_tests(None);
    }

    #[test]
    fn a_current_chief_is_not_rewritten() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let chief = ensure_main().unwrap();
        let before = claude_md(&chief);
        let upgraded = upgrade_chief(&chief).unwrap();
        store::set_root_for_tests(None);
        assert!(!upgraded);
        assert!(before.contains(prompts::CHIEF_INSTRUCTIONS));
    }

    #[test]
    fn every_past_default_is_told_apart_from_the_current_one() {
        assert!(!prompts::PAST_CHIEF_INSTRUCTIONS.contains(&prompts::CHIEF_INSTRUCTIONS));
        assert!(is_chief_default(prompts::CHIEF_INSTRUCTIONS));
        for old in prompts::PAST_CHIEF_INSTRUCTIONS {
            assert!(is_chief_default(old));
            assert_eq!(
                upgraded_chief_instructions(old).as_deref(),
                Some(prompts::CHIEF_INSTRUCTIONS)
            );
        }
        assert!(!is_chief_default("Be brief."));
    }
}

#[cfg(test)]
mod audit_tests;
