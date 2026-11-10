//! The recap a turn starts with when its engine lost the conversation: the recent chat, newest last.

use super::*;

/// The recap's window: about 30 exchanges (a line each way)...
pub(super) const RECAP_LINES: usize = 60;
/// ...or about 6k tokens, whichever is less. Paid for in full (nothing
/// cached) on the one turn that needs it.
pub(super) const RECAP_CHARS: usize = 24_000;
/// One message's most, so one long report doesn't crowd out the rest.
pub(super) const RECAP_LINE_CHARS: usize = 2_000;
/// Messages read to find them (notes and cards in between don't count).
pub(super) const RECAP_SCAN: usize = 400;

/// A prompt for a fresh session, prefixed with the visible conversation.
pub(super) fn with_recap(agent_id: &str, prompt: &str) -> String {
    let Ok(log) = recap_log(agent_id) else {
        return prompt.to_string();
    };
    // What this turn is sent, and what waits behind it, are already on their
    // way as messages: in the recap too, the agent read them twice ("your
    // message came through twice").
    let lines = recap_lines_except(&log, &on_the_way(agent_id));
    recap_prompt(&lines, &recap_open(&log), prompt)
}

/// [`with_recap`] opening with `header`, and only what was said since
/// `since` when given (carrying on with, or back from, another engine).
pub(in crate::agents) fn with_recap_as(
    agent_id: &str,
    header: &str,
    since: Option<i64>,
    prompt: &str,
) -> String {
    let Ok(mut log) = recap_log(agent_id) else {
        return prompt.to_string();
    };
    if let Some(since) = since {
        log.retain(|m| m.ts >= since);
    }
    let lines = recap_lines_except(&log, &on_the_way(agent_id));
    recap_prompt_with(header, &lines, &recap_open(&log), prompt)
}

/// What a recap is read from: the newest of the conversation the agent's
/// engine has loaded (the turn's), never what was said in its others.
pub(super) fn recap_log(agent_id: &str) -> Result<Vec<store::AgentMessage>, CommandError> {
    let conversation = store::get(agent_id)
        .map(|a| super::conversations::loaded(&a).to_string())
        .unwrap_or_else(|_| super::conversations::FIRST.to_string());
    // What a rewind folded didn't happen, as far as this conversation goes.
    let rewound = super::conversations::page_spec(agent_id, &conversation).rewound;
    let mut page = store::conversation_page(agent_id, &conversation, RECAP_SCAN, None, None)?;
    page.retain(|m| !rewound.contains(&m.id));
    Ok(page)
}

pub(super) const LOST_HEADER: &str = "[Your previous working session was lost. This is the recent conversation from your own chat, newest last: what \"You\" said, you said, and you know it. Pick up from here without mentioning the loss unless asked; never ask the user to repeat or paste anything in it. search_my_chat finds anything older.]";

/// The recap around `prompt`: the conversation, then what is still open.
pub(super) fn recap_prompt(lines: &[String], open: &[String], prompt: &str) -> String {
    recap_prompt_with(LOST_HEADER, lines, open, prompt)
}

/// [`recap_prompt`] opening with `header`.
pub(in crate::agents) fn recap_prompt_with(
    header: &str,
    lines: &[String],
    open: &[String],
    prompt: &str,
) -> String {
    if lines.is_empty() && open.is_empty() {
        return prompt.to_string();
    }
    let mut out = format!("{header}\n\n");
    out.push_str(&lines.join("\n"));
    if !open.is_empty() {
        out.push_str("\n\n[Still open]\n");
        out.push_str(&open.join("\n"));
    }
    out.push_str("\n\n[New message]\n\n");
    out.push_str(prompt);
    out
}

/// What is still open in the recap's window: requests waiting on the user,
/// and the questions put to them they haven't answered.
pub(super) fn recap_open(log: &[store::AgentMessage]) -> Vec<String> {
    let mut open: Vec<String> = log
        .iter()
        .filter_map(|m| m.approval.as_ref())
        .filter(|a| a.status == store::ApprovalStatus::Pending)
        .map(|a| format!("- Waiting on the user's answer: {}", a.title))
        .collect();
    open.extend(
        super::schedule::open_questions(log)
            .into_iter()
            .map(|q| format!("- You asked the user, unanswered: {q}")),
    );
    open
}

/// The recap's lines: the visible conversation since the last fresh start.
/// What came before it the user chose to leave behind, so a new session
/// (an engine switch, a session that vanished) is never handed it again.
#[cfg(test)]
pub(super) fn recap_lines(log: &[store::AgentMessage]) -> Vec<String> {
    recap_lines_except(log, &std::collections::HashSet::new())
}

/// The ids of what the turn in progress answers and what is queued behind it.
pub(super) fn on_the_way(agent_id: &str) -> std::collections::HashSet<String> {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .map(|r| {
            r.batch_ids
                .iter()
                .chain(r.queue.iter().map(|m| &m.id))
                .filter(|id| !id.is_empty())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// One message as a recap line, or `None` for what isn't conversation.
pub(super) fn recap_line(m: &store::AgentMessage) -> Option<String> {
    let who = match m.kind {
        MessageKind::User => "User".to_string(),
        MessageKind::Agent => "You".to_string(),
        MessageKind::SentToAgent => format!("You → {}", m.peer.as_ref()?.name),
        MessageKind::FromAgent => format!("{} → you", m.peer.as_ref()?.name),
        MessageKind::CheckIn => "Your scheduled check-in".to_string(),
        // What went wrong was shown to the user: the agent knows it too.
        MessageKind::Error => "Error shown to the user".to_string(),
        MessageKind::Approval => {
            let a = m.approval.as_ref()?;
            let status = match a.status {
                store::ApprovalStatus::Pending => "waiting",
                store::ApprovalStatus::Allowed => "allowed",
                store::ApprovalStatus::Denied => "denied",
                store::ApprovalStatus::Expired => "expired",
            };
            return Some(format!(
                "You asked the user to approve: {} ({status})",
                a.title
            ));
        }
        _ => return None,
    };
    let mut text = m.text.trim().to_string();
    if let Some(card) = &m.result {
        text = format!(
            "{text} [shared a result: {} — {}]",
            card.title, card.summary
        );
    }
    if text.trim().is_empty() {
        return None;
    }
    let mut cut: String = text.chars().take(RECAP_LINE_CHARS).collect();
    if text.chars().count() > RECAP_LINE_CHARS {
        cut.push('…');
    }
    Some(format!("{who}: {cut}"))
}

/// [`recap_lines`], leaving out the messages in `skip` (by id): the newest
/// lines that fit the window, oldest first.
pub(super) fn recap_lines_except(
    log: &[store::AgentMessage],
    skip: &std::collections::HashSet<String>,
) -> Vec<String> {
    let since = log
        .iter()
        .rposition(|m| m.fresh && m.kind == MessageKind::Note)
        .map_or(0, |i| i + 1);
    let mut out = Vec::new();
    let mut used = 0;
    for line in log[since..]
        .iter()
        .rev()
        // An import conversation was the sealed interview's, never this
        // agent's: it isn't handed to its session.
        .filter(|m| !super::connector::is_connector_line(m))
        .filter(|m| !skip.contains(&m.id))
        .filter_map(recap_line)
    {
        if out.len() >= RECAP_LINES || (used + line.len() > RECAP_CHARS && !out.is_empty()) {
            break;
        }
        used += line.len() + 1;
        out.push(line);
    }
    out.reverse();
    out
}

/// `--resume` / `exec resume` refusing a session it has no file for (the
/// user cleared ~/.claude or ~/.codex, or the first turn died before writing
/// one). Codex 0.166 says "no rollout found for thread id …" (observed).
pub(super) fn is_missing_session(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    lower.contains("no conversation found")
        || lower.contains("session not found")
        || lower.contains("no rollout found")
}
