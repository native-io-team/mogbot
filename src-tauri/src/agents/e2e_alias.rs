//! Debug builds only, and only when the e2e suite asks: a stand-in for Claude
//! in Chrome served under another MCP server name, decided and recorded as
//! the real one.
//!
//! The adversarial suite (`examples/agents_e2e/adversarial.rs`) can't let a
//! turn reach the owner's Chrome, and Claude Code reserves the server name
//! `claude-in-chrome` for its own (a `--mcp-config` entry by that name is
//! dropped without `--chrome`, and replaced by the real one with it; observed
//! on 2.1.319). So the stand-in runs as `SHIPSTUDIO_AGENTS_E2E_BROWSER_SERVER`
//! and this maps it back where the app reads tool names: the approval broker
//! (so the browser gate decides its calls, cards and all) and the turn's
//! stream (so capabilities, "What it did" and the stored log name Chrome).
//! A release build never reads the variable.

use std::borrow::Cow;

const VAR: &str = "SHIPSTUDIO_AGENTS_E2E_BROWSER_SERVER";

fn alias() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(VAR)
        .ok()
        .filter(|s| !s.is_empty() && s != super::browser_gate::SERVER)
}

/// A tool name the broker was handed, as the browser's when it's the stand-in's.
pub fn tool(name: &str) -> Cow<'_, str> {
    let Some(server) = alias() else {
        return Cow::Borrowed(name);
    };
    match name.strip_prefix(&format!("mcp__{server}__")) {
        Some(rest) => Cow::Owned(format!("{}{rest}", super::browser_gate::SERVER)),
        None => Cow::Borrowed(name),
    }
}

/// A line of a turn's stream, with the stand-in named as Claude in Chrome.
pub fn line(line: String) -> String {
    let Some(server) = alias() else {
        return line;
    };
    if !line.contains(&server) {
        return line;
    }
    line.replace(&format!("mcp__{server}__"), super::browser_gate::SERVER)
        .replace(
            &format!("\"name\":\"{server}\""),
            "\"name\":\"claude-in-chrome\"",
        )
}
