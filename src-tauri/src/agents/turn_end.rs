//! When a Claude Code turn is really over, and what it left unfinished.
//!
//! `claude --print` can send more than one `result` in a turn. Resumed after
//! its process was stopped, it first answers what was queued in the
//! conversation (a notification that the background helpers it started were
//! stopped), with a `result` of its own, and only then the user's message.
//! While background helpers (the Agent tool, which runs them in the
//! background by default) are still working it stays up, and each one that
//! reports back starts another round that ends in another `result`.
//!
//! The runner used to take the first `result` as the end and give the
//! process three seconds of streamed output to prove otherwise. A tool call
//! that ran longer than that (a screenshot script, `sleep 8`), or a long
//! think, ended the turn mid-work: the process tree was stopped, the helpers
//! it had just launched with it, nothing was said, and the next turn opened
//! on another "your helpers were stopped" notification, so it happened
//! again. Observed 2026-11-08 on Claude Code 2.1.319, three turns in a row.
//!
//! So here: a `result` ends the turn only if nothing follows it. Anything
//! the engine does after one (its model streaming, a tool call, a tool's
//! result) reopens the turn until the next `result`. While a helper it
//! launched hasn't reported back, the turn waits for it rather than ending.

use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// How long after a `result` the turn waits for more. `claude` normally
/// exits at once (and the exit ends the turn sooner); it stays up only for
/// something it started (a dev server) or more work queued behind the
/// result, whose first output can take a few seconds to arrive on a long
/// conversation.
pub const AFTER_RESULT: Duration = Duration::from_secs(15);

/// How long after a `result` the turn waits for helpers it started in the
/// background to report back, from the last thing it heard.
pub const HELPER_WAIT: Duration = Duration::from_secs(30 * 60);

/// The text Claude Code's Agent tool answers with when it launched a helper
/// in the background, followed by `agentId: <id>`.
const LAUNCHED: &str = "Async agent launched";

#[derive(Debug, Default)]
pub struct TurnEnd {
    /// A `result` is in and nothing has happened since.
    done: bool,
    /// Helpers launched in the background this turn, not reported back.
    helpers: BTreeSet<String>,
}

impl TurnEnd {
    /// Fold in one stream-json line of Claude Code's (before its steps).
    /// True when it reopened a turn whose `result` was in.
    pub fn on_line(&mut self, value: &Value) -> bool {
        let kind = value.get("type").and_then(Value::as_str);
        if kind == Some("user") || kind == Some("system") {
            for id in reported_back(value) {
                self.helpers.remove(&id);
            }
        }
        if kind == Some("user") {
            self.helpers.extend(launched(value));
        }
        // Its model, a tool call or a tool's result: still working. Not a
        // `system` line or a progress tick, which it can send after its
        // final result while something it started is still running.
        let working = matches!(kind, Some("assistant" | "stream_event" | "user"));
        let reopened = working && self.done;
        if reopened {
            self.done = false;
        }
        reopened
    }

    /// A `result` (any engine's end of turn).
    pub fn on_done(&mut self) {
        self.done = true;
    }

    /// The result is in and nothing has followed it.
    pub fn over(&self) -> bool {
        self.done
    }

    /// How long to wait after a result for anything more.
    pub fn grace(&self) -> Duration {
        if self.helpers.is_empty() {
            AFTER_RESULT
        } else {
            HELPER_WAIT
        }
    }

    /// Helpers it started in the background that haven't reported back.
    pub fn waiting_on(&self) -> usize {
        self.helpers.len()
    }
}

/// The working line while a finished reply waits on its helpers.
pub fn waiting_line(helpers: usize) -> String {
    match helpers {
        1 => "Waiting for the helper it started to report back".to_string(),
        n => format!("Waiting for the {n} helpers it started to report back"),
    }
}

/// Whether a working line is [`waiting_line`]'s.
pub fn is_waiting_line(line: &str) -> bool {
    line.starts_with("Waiting for the ") && line.ends_with(" to report back")
}

/// The ids of helpers a tool result says were launched in the background.
fn launched(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let blocks = value.pointer("/message/content").and_then(Value::as_array);
    for block in blocks.into_iter().flatten() {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let mut texts = Vec::new();
        strings(block.get("content").unwrap_or(&Value::Null), &mut texts);
        for text in texts {
            if !text.contains(LAUNCHED) {
                continue;
            }
            if let Some(id) = after(text, "agentId:") {
                out.push(id);
            }
        }
    }
    out
}

/// The ids of tasks a line says reported back (completed, failed or were
/// stopped): Claude Code's `<task-notification>`, or its `task_notification`
/// system event.
fn reported_back(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if value.get("subtype").and_then(Value::as_str) == Some("task_notification") {
        if let Some(id) = value.get("task_id").and_then(Value::as_str) {
            out.push(id.to_string());
        }
    }
    let mut texts = Vec::new();
    strings(value.get("message").unwrap_or(&Value::Null), &mut texts);
    for text in texts
        .into_iter()
        .filter(|t| t.contains("<task-notification>"))
    {
        let mut rest = text;
        while let Some(start) = rest.find("<task-id>") {
            rest = &rest[start + "<task-id>".len()..];
            let Some(end) = rest.find("</task-id>") else {
                break;
            };
            out.push(rest[..end].trim().to_string());
            rest = &rest[end..];
        }
    }
    out
}

/// The first word after `label` in `text`.
fn after(text: &str, label: &str) -> Option<String> {
    let rest = &text[text.find(label)? + label.len()..];
    let id: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!id.is_empty()).then_some(id)
}

fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(s) => out.push(s),
        Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| strings(v, out)),
        _ => {}
    }
}

/// What a finished turn left for the chat to say, when the turn itself
/// said nothing or left helpers behind (taken by the worker once the
/// turn's cards are in).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Left {
    /// The turn recorded no reply of its own.
    pub silent: bool,
    /// Helpers it started in the background that stopped with it.
    pub helpers: usize,
}

static LEFT: LazyLock<Mutex<HashMap<String, Left>>> = LazyLock::new(Default::default);

pub fn leave(agent_id: &str, left: Left) {
    if left == Left::default() {
        return;
    }
    LEFT.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), left);
}

pub fn take(agent_id: &str) -> Option<Left> {
    LEFT.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
}

/// The one line a finished turn ends on when it said nothing (`shown`: it
/// left a card, a question or an error instead), or when helpers it started
/// stopped with it. `None`: the turn's own words are enough.
pub fn closing_line(left: Left, shown: bool) -> Option<String> {
    let silent = left.silent && !shown;
    let helpers = match left.helpers {
        0 => None,
        1 => Some("The helper it started in the background stopped with it, before reporting back. Ask it to run that again.".to_string()),
        n => Some(format!("The {n} helpers it started in the background stopped with it, before reporting back. Ask it to run them again.")),
    };
    match (silent, helpers) {
        (true, Some(h)) => Some(format!("Finished without a reply. {h}")),
        (true, None) => Some(
            "Finished without a reply. What it did is in its timeline; ask it what it found."
                .to_string(),
        ),
        (false, h) => h,
    }
}

/// The line for a turn stopped (by the user, a new message or a limit)
/// while helpers it started were still working.
pub fn stopped_helpers_line(helpers: usize) -> Option<String> {
    match helpers {
        0 => None,
        1 => Some("The helper it started in the background was stopped too.".to_string()),
        n => Some(format!(
            "The {n} helpers it started in the background were stopped too."
        )),
    }
}

#[cfg(test)]
#[path = "turn_end_tests.rs"]
mod tests;
