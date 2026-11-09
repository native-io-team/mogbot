//! A stand-in for Claude in Chrome served under another MCP server name,
//! decided and recorded as the real one.
//!
//! Claude Code reserves the server name `claude-in-chrome` for its own (a
//! `--mcp-config` entry by that name is dropped without `--chrome`, and
//! replaced by the real one with it; observed on 2.1.319). Two stand-ins
//! exist, and this maps both back where the app reads tool names: the
//! approval broker (so the browser gate decides their calls, cards and all)
//! and the turn's stream (so capabilities, "What it did" and the stored log
//! name Chrome):
//!
//! - In every build, [`account_reach::CHROME_SERVER`]: the user's Chrome
//!   reached as this Mac's sign-in by a turn on an added Claude Code account
//!   (see `account_reach`, "Claude in Chrome").
//! - Debug builds only, and only when the e2e suite asks: the adversarial
//!   suite (`examples/agents_e2e/adversarial.rs`) can't let a turn reach the
//!   owner's Chrome, so its stand-in runs as
//!   `SHIPSTUDIO_AGENTS_E2E_BROWSER_SERVER`. A release build never reads the
//!   variable.
//!
//! [`account_reach::CHROME_SERVER`]: super::account_reach::CHROME_SERVER

use std::borrow::Cow;

const VAR: &str = "SHIPSTUDIO_AGENTS_E2E_BROWSER_SERVER";

/// Server names that stand for Claude in Chrome.
fn aliases() -> Vec<String> {
    let mut out = vec![super::account_reach::CHROME_SERVER.to_string()];
    if cfg!(debug_assertions) {
        if let Ok(s) = std::env::var(VAR) {
            if !s.is_empty() && s != super::browser_gate::SERVER {
                out.push(s);
            }
        }
    }
    out
}

/// A tool name the broker was handed, as the browser's when it's a stand-in's.
pub fn tool(name: &str) -> Cow<'_, str> {
    for server in aliases() {
        if let Some(rest) = name.strip_prefix(&format!("mcp__{server}__")) {
            return Cow::Owned(format!("{}{rest}", super::browser_gate::SERVER));
        }
    }
    Cow::Borrowed(name)
}

/// A line of a turn's stream, with a stand-in named as Claude in Chrome.
pub fn line(mut line: String) -> String {
    for server in aliases() {
        if !line.contains(&server) {
            continue;
        }
        line = line
            .replace(&format!("mcp__{server}__"), super::browser_gate::SERVER)
            .replace(
                &format!("\"name\":\"{server}\""),
                "\"name\":\"claude-in-chrome\"",
            );
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chrome_reached_as_this_mac_reads_as_claude_in_chrome() {
        let s = super::super::account_reach::CHROME_SERVER;
        assert_eq!(
            tool(&format!("mcp__{s}__computer")),
            "mcp__claude-in-chrome__computer"
        );
        assert_eq!(tool("mcp__figma__get"), "mcp__figma__get");
        let init = format!(
            r#"{{"tools":["mcp__{s}__navigate"],"mcp_servers":[{{"name":"{s}","status":"connected"}}]}}"#
        );
        assert_eq!(
            line(init),
            r#"{"tools":["mcp__claude-in-chrome__navigate"],"mcp_servers":[{"name":"claude-in-chrome","status":"connected"}]}"#
        );
    }
}
