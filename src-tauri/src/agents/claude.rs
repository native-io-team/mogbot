//! Claude Code's command line for one turn: `claude --print`, stream-json
//! out, the prompt on stdin, approvals through our MCP server's `approve`
//! tool. Its stream is read by `stream::claude_steps` (and drafts by
//! `stream::Drafts::on_stream_event`); the counterpart for Codex is `codex`
//! and `codex_app`. `driver` picks between them per turn.

use super::prompts;

/// The agent bridge as Claude Code's `--mcp-config`.
pub(super) fn mcp_config(url: &str) -> String {
    serde_json::json!({
        "mcpServers": { prompts::SERVER_KEY: { "type": "http", "url": url } }
    })
    .to_string()
}

/// Every argument a turn's `claude` process gets. The prompt goes on stdin.
pub(super) fn args(
    model: Option<&str>,
    session_id: &str,
    resuming: bool,
    url: &str,
    system_prompt: &str,
    add_dirs: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Claude in Chrome. Verified in --print on 2.1.318: its tools load and
        // answer when the extension is connected. Its calls aren't allowed in
        // advance, so they ask through `approve` like any other MCP tool.
        "--chrome",
    ]
    .map(String::from)
    .to_vec();
    let session_flag = if resuming { "--resume" } else { "--session-id" };
    args.extend([session_flag.to_string(), session_id.to_string()]);
    args.extend([
        "--permission-mode".into(),
        "acceptEdits".into(),
        "--permission-prompt-tool".into(),
        prompts::approval_tool_id(),
        "--mcp-config".into(),
        mcp_config(url),
        "--allowedTools".into(),
        format!("mcp__{}", prompts::SERVER_KEY),
        "--append-system-prompt".into(),
        system_prompt.to_string(),
    ]);
    for dir in add_dirs {
        args.extend(["--add-dir".to_string(), dir.clone()]);
    }
    // Ship Studio's preview bridge is registered for the same projects; an
    // agent here drives our preview, never theirs.
    args.push(crate::preview_isolation::claude_flag());
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}

/// What only a `--print` turn gets: its output format, and approvals through
/// our `approve` tool. A flag here that takes a value drops it too.
const PRINT_ONLY: [&str; 5] = [
    "--print",
    "--output-format",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
];

/// Flags in [`PRINT_ONLY`] followed by a value.
const PRINT_ONLY_WITH_VALUE: [&str; 2] = ["--output-format", "--permission-prompt-tool"];

/// The command line for the user taking over the agent's session
/// (`takeover`): exactly a turn's, resuming the same session, so its tools,
/// folders, identity and permission mode are the ones the agent works with,
/// but interactive. Without `--print` Claude Code asks its permission
/// questions in the terminal, to the person at the keyboard, so there is no
/// `--permission-prompt-tool`.
pub(super) fn interactive_args(
    model: Option<&str>,
    session_id: &str,
    url: &str,
    system_prompt: &str,
    add_dirs: &[String],
) -> Vec<String> {
    let print = args(model, session_id, true, url, system_prompt, add_dirs);
    let mut out = Vec::with_capacity(print.len());
    let mut it = print.into_iter();
    while let Some(arg) = it.next() {
        if PRINT_ONLY_WITH_VALUE.contains(&arg.as_str()) {
            it.next();
        } else if !PRINT_ONLY.contains(&arg.as_str()) {
            out.push(arg);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taking_over_runs_the_turns_own_command_line_minus_print() {
        let dirs = vec!["/u/home".to_string(), "/u/ShipStudio".to_string()];
        let url = "http://b/x?turn=3";
        let turn = args(Some("opus"), "sid", true, url, "be you", &dirs);
        let mine = interactive_args(Some("opus"), "sid", url, "be you", &dirs);

        for flag in PRINT_ONLY {
            assert!(!mine.iter().any(|a| a == flag), "{flag} is print-only");
        }
        assert!(!mine.contains(&"stream-json".to_string()));
        assert!(!mine.contains(&prompts::approval_tool_id()));

        // Everything else is the turn's, in the turn's order: exactly seven
        // arguments fewer (five flags, two values).
        assert_eq!(mine.len(), turn.len() - 7);
        let mut rest = turn.iter();
        for arg in &mine {
            assert!(rest.any(|t| t == arg), "{arg} out of the turn's order");
        }

        let pair = |flag: &str| {
            mine.windows(2)
                .find(|w| w[0] == flag)
                .map(|w| w[1].clone())
                .unwrap_or_else(|| panic!("{flag} missing"))
        };
        // The same session, resumed: never a new one.
        assert_eq!(pair("--resume"), "sid");
        assert!(!mine.contains(&"--session-id".to_string()));
        assert_eq!(pair("--permission-mode"), "acceptEdits");
        assert_eq!(pair("--mcp-config"), mcp_config(url));
        assert_eq!(
            pair("--allowedTools"),
            format!("mcp__{}", prompts::SERVER_KEY)
        );
        assert_eq!(pair("--append-system-prompt"), "be you");
        assert_eq!(pair("--model"), "opus");
        assert!(mine.contains(&"--chrome".to_string()));
        assert!(mine.contains(&crate::preview_isolation::claude_flag()));
        let added: Vec<_> = mine
            .windows(2)
            .filter(|w| w[0] == "--add-dir")
            .map(|w| w[1].clone())
            .collect();
        assert_eq!(added, dirs);
    }
}
