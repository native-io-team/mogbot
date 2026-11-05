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
