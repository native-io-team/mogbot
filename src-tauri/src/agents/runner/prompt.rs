//! What a turn is told: its prompt from the batch, its system prompt and the folders it may work in; and the words for a turn that errored.

use super::*;

/// `onward`: for an answer, who the request was asked on behalf of, by the
/// helper's id (see [`ONWARD`]); the turn's outcome goes to them.
pub(super) fn compose(batch: &[Inbound], onward: &HashMap<String, Vec<AgentRef>>) -> String {
    batch
        .iter()
        // A pick-up's note is said once, in the app's words, to whoever
        // asked: the request itself is already in the conversation.
        .filter(|m| m.resume == 0 || !m.text.is_empty())
        .map(|m| match &m.from {
            // The app's own words name this build's computer (`computer`).
            _ if m.resume > 0 => crate::computer::localize(&m.text).into_owned(),
            From::App => crate::computer::localize(&m.text).into_owned(),
            From::User => m.text.clone(),
            From::Agent { sender, .. } => {
                let back_to: Vec<String> = match m.reply {
                    true => onward
                        .get(&sender.id)
                        .map(|up| up.iter().map(|a| a.name.clone()).collect())
                        .unwrap_or_default(),
                    false => Vec::new(),
                };
                prompts::from_agent(&sender.name, &m.text, m.reply, &back_to)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What a failed `result` event means, in words. The CLI puts the reason in
/// `errors` (e.g. "No conversation found with session ID: …") and only a code
/// in `subtype` ("error_during_execution"), which must never reach the chat.
pub(crate) fn result_error_text(value: &serde_json::Value) -> String {
    if let Some(text) = value
        .get("result")
        .and_then(|r| r.as_str())
        .filter(|t| !t.trim().is_empty())
    {
        return text.to_string();
    }
    let errors: Vec<String> = value
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|e| e.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !errors.is_empty() {
        return errors.join(" ");
    }
    match value.get("subtype").and_then(|s| s.as_str()) {
        Some("error_max_turns") => "It ran out of steps before finishing. Send a message to let it continue.".into(),
        _ => "Something went wrong running this agent. Send your message again; if it keeps happening, check that Claude Code works in a terminal.".into(),
    }
}

/// Why a turn that never sent its `result` event failed. Every finished turn
/// ends with one; without it the process died or wrote something unreadable,
/// whatever its exit code says, so this is never a silent "done". The CLI's
/// own words win when it left any.
pub(super) fn unfinished_turn(engine: Engine, exited_cleanly: bool, stderr: String) -> String {
    if !stderr.trim().is_empty() {
        return stderr;
    }
    let who = engine.label();
    let what = if exited_cleanly {
        "stopped before finishing its reply"
    } else {
        "quit unexpectedly before finishing its reply"
    };
    format!("{who} {what}. Send your message again; if it keeps happening, check that {who} works in a terminal.")
}

/// Folders an agent may work in without asking: every Ship Studio project.
/// The folders a turn adds, by its settings: for a bound agent its home
/// first (its memory), then what the policy lets it write, but never its
/// working folder twice.
pub(super) fn policy_dirs(
    layout: &super::project::Layout,
    home: &std::path::Path,
    allowed: Vec<String>,
) -> Vec<String> {
    let home = home.to_string_lossy().to_string();
    let mut out = Vec::new();
    if layout.project.is_some() {
        out.push(home.clone());
    }
    let project = layout
        .project
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    for d in allowed {
        if Some(&d) != project.as_ref() && d != home && !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

pub(in crate::agents) fn work_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Ok(root) = crate::utils::projects_root() {
        dirs.push(root.to_string_lossy().to_string());
    }
    if let Ok(config) = crate::commands::external_projects::load_config() {
        dirs.extend(config.projects.into_iter().map(|p| p.path));
    }
    dirs
}

/// Plain-language label for what a stream-json line's (last) tool call is
/// doing, as the working line says it. The words live in `work`.
pub fn describe_activity(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    super::work::claude_actions(&value).pop().map(|a| a.doing)
}

/// The system prompt for a turn. A bound agent's own CLAUDE.md is carried
/// in it, because its working directory is the project, not its home.
pub(in crate::agents) fn system_prompt_for(
    agent: &store::Agent,
    home: &std::path::Path,
    layout: &super::project::Layout,
) -> String {
    let mut prompt = system_prompt_base(agent, home, layout);
    prompt.push_str("\n\n");
    prompt.push_str(&prompts::usage_section(
        super::usage_plan::mode().0,
        agent.is_main,
    ));
    // How much to do on its own: the user's level, or the strictest for a
    // turn answering outside text. Fixed per level, so the cache holds.
    prompt.push_str("\n\n");
    // Its own level when its settings give it one (`policy`).
    prompt.push_str(&super::independence::prompt_section(
        super::policy::independence_for(agent, from_outside(&agent.id)),
    ));
    // What it may do, the user's rules for it, and how to change either.
    prompt.push_str("\n\n");
    prompt.push_str(&super::policy::prompt_section(
        &super::policy::effective(agent),
        agent,
    ));
    // An admin's powers, said only in a turn that has them: fixed text, so
    // the prompt changes only when the user flips the switch.
    if super::admin::admin_now(agent) {
        prompt.push_str("\n\n");
        prompt.push_str(super::admin::PROMPT_SECTION);
    }
    // Skills it saved, named with their files where its engine doesn't read
    // them itself (Codex, OpenCode, a turn in a project): `skills_learn`.
    if let Some(skills) = super::skills_learn::prompt_for(agent, home, layout.project.is_some()) {
        prompt.push_str("\n\n");
        prompt.push_str(&skills);
    }
    // Apps the user chose not to connect: don't ask, work around them.
    if let Some(declined) = super::declined::prompt_section() {
        prompt.push_str("\n\n");
        prompt.push_str(&declined);
    }
    // Who else is here and their latest result, in a few lines
    // (`team_record`): enough to know whom to check with, never their chats.
    if let Some(roster) = crate::agents::team_record::roster_for(agent) {
        prompt.push_str("\n\n");
        prompt.push_str(&roster);
    }
    if agent.is_main {
        if let Some(team) = store::list()
            .ok()
            .and_then(|all| prompts::team(&all, &agent.id))
        {
            prompt.push_str("\n\n");
            prompt.push_str(&team);
        }
        // First run's "bring your agents over" guide, while it runs.
        if let Some(line) = crate::agents::guide::briefing_line() {
            prompt.push_str("\n\n");
            prompt.push_str(&line);
        }
    }
    prompt
}

pub(super) fn system_prompt_base(
    agent: &store::Agent,
    home: &std::path::Path,
    layout: &super::project::Layout,
) -> String {
    let Some(project) = &layout.project else {
        return prompts::system_prompt(agent, None);
    };
    let identity: String = std::fs::read_to_string(home.join("CLAUDE.md"))
        .unwrap_or_default()
        .chars()
        .take(40_000)
        .collect();
    prompts::system_prompt(
        agent,
        Some(&prompts::Bound {
            home: &home.to_string_lossy(),
            project: &project.to_string_lossy(),
            identity: &identity,
            copy: layout.copy.as_ref(),
        }),
    )
}
