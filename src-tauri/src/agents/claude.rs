//! Claude Code's command line for one turn: `claude --print`, stream-json
//! out, the prompt on stdin, approvals through our MCP server's `approve`
//! tool. Its stream is read by `stream::claude_steps` (and drafts by
//! `stream::Drafts::on_stream_event`); the counterpart for Codex is `codex`
//! and `codex_app`. `driver` picks between them per turn.

use super::prompts;

/// Every argument a turn's `claude` process gets. The prompt goes on stdin.
/// `mcp_config` is the path of the turn's 0600 config file naming the agent
/// bridge and its secret (`reach`): never the config itself, which `ps`
/// would show to every account on the Mac.
pub(super) fn args(
    model: Option<&str>,
    session_id: &str,
    resuming: bool,
    mcp_config: &str,
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
    // Compaction on, whatever the user's own settings say (`tidy`).
    args.extend(["--settings".to_string(), super::tidy::claude_settings()]);
    let session_flag = if resuming { "--resume" } else { "--session-id" };
    args.extend([session_flag.to_string(), session_id.to_string()]);
    args.extend([
        "--permission-mode".into(),
        "acceptEdits".into(),
        "--permission-prompt-tool".into(),
        prompts::approval_tool_id(),
        "--mcp-config".into(),
        mcp_config.to_string(),
        "--allowedTools".into(),
        format!("mcp__{}", prompts::SERVER_KEY),
        "--append-system-prompt".into(),
        system_prompt.to_string(),
    ]);
    for dir in add_dirs {
        args.extend(["--add-dir".to_string(), dir.clone()]);
    }
    // Never write `.git` or `.shipstudio`, here or in any added folder. The
    // list ends at the next flag, which always follows.
    args.push("--disallowedTools".into());
    args.extend(super::reach::claude_deny_rules(add_dirs));
    // Ship Studio's preview bridge is registered for the same projects; an
    // agent here drives our preview, never theirs.
    args.push(crate::preview_isolation::claude_flag());
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}

/// The environment a turn's `claude` gets on top of the app's own.
///
/// `CLAUDE_CODE_ARTIFACT=1` turns on Claude Code's `Artifact` tool, which
/// reads a claude.ai artifact link (`claude.ai/artifact/{id}`) straight from
/// the user's claude.ai account instead of driving their browser. `--print`
/// runs as the `sdk-cli` entrypoint, where that tool is off by default.
/// Verified on 2.1.318: without the variable the tool isn't listed at all;
/// with it, `Artifact` is listed directly (not deferred), and a `read` of an
/// artifact it can't vouch for asks through the permission prompt tool, so
/// it reaches the approval broker like any other call. Without a claude.ai
/// sign-in the tool simply isn't there.
pub(super) const ENV: [(&str, &str); 1] = [("CLAUDE_CODE_ARTIFACT", "1")];

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
    mcp_config: &str,
    system_prompt: &str,
    add_dirs: &[String],
) -> Vec<String> {
    let print = args(model, session_id, true, mcp_config, system_prompt, add_dirs);
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

    /// Every `--disallowedTools` entry: the arguments after the flag up to
    /// the next flag, and any `--disallowedTools=` form.
    fn denied(args: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        let mut inside = false;
        for a in args {
            if let Some(v) = a.strip_prefix("--disallowedTools=") {
                out.push(v.to_string());
                inside = false;
            } else if a == "--disallowedTools" {
                inside = true;
            } else if a.starts_with("--") {
                inside = false;
            } else if inside {
                out.push(a.clone());
            }
        }
        out
    }

    #[test]
    fn a_turn_keeps_the_artifact_tool_that_reads_claude_ai_links() {
        let dirs = vec!["/u/home".to_string()];
        let turn = args(None, "sid", false, "/s/mcp.json", "be you", &dirs);
        let deny = denied(&turn);
        assert!(!deny.is_empty(), "the deny list is still there");
        for rule in &deny {
            assert!(
                !rule.starts_with("Artifact") && rule != "ToolSearch",
                "{rule} would hide the Artifact tool"
            );
        }
        // Nothing narrows the tool set to a list that leaves it out.
        assert!(!turn
            .iter()
            .any(|a| a == "--tools" || a.starts_with("--tools=")));
        // `--print` lists it only with the switch on.
        assert!(ENV.contains(&("CLAUDE_CODE_ARTIFACT", "1")));
    }

    #[test]
    fn taking_over_runs_the_turns_own_command_line_minus_print() {
        let dirs = vec!["/u/home".to_string(), "/u/ShipStudio".to_string()];
        let config = "/s/agent-bridge/mcp-1.json";
        let turn = args(Some("opus"), "sid", true, config, "be you", &dirs);
        let mine = interactive_args(Some("opus"), "sid", config, "be you", &dirs);

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
        assert_eq!(pair("--mcp-config"), config);
        assert!(!mine.iter().any(|a| a.contains("Bearer")));
        assert_eq!(pair("--disallowedTools"), "Edit(**/.git/**)");
        assert!(mine.contains(&"Edit(//u/ShipStudio/**/.shipstudio/**)".to_string()));
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
