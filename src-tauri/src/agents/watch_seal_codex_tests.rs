use super::*;
use serde_json::json;

fn value_after<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    args.windows(2)
        .filter(|w| w[0] == flag)
        .map(|w| w[1].as_str())
        .collect()
}

const RELAY: &str = "http://127.0.0.1:4100/mcp/conn/linear";

#[test]
fn the_codex_check_is_sealed_to_one_connections_reads() {
    let a = args("linear", RELAY, Some("gpt-small"));
    assert_eq!(a[0], "exec");
    // The prompt on stdin, last.
    assert_eq!(a.last().map(String::as_str), Some("-"));
    for flag in [
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--strict-config",
        "--ignore-user-config",
        "--ignore-rules",
    ] {
        assert!(a.iter().any(|x| x == flag), "{flag} missing");
    }
    assert_eq!(value_after(&a, "--sandbox"), vec!["read-only"]);
    // Every built-in that reaches a command, a file, the web or another
    // agent, off by name.
    let off = value_after(&a, "--disable");
    for f in [
        "shell_tool",
        "unified_exec",
        "view_image",
        "multi_agent",
        "apps",
        "plugins",
        "browser_use",
        "computer_use",
        "hooks",
    ] {
        assert!(off.contains(&f), "{f} not disabled");
    }
    assert_eq!(off.len(), FEATURES_OFF.len());
    let config = value_after(&a, "-c");
    for c in [
        "approval_policy=\"never\"",
        "web_search=\"disabled\"",
        "project_doc_max_bytes=0",
        "skills.include_instructions=false",
        "skills.bundled.enabled=false",
        "model_reasoning_effort=\"low\"",
    ] {
        assert!(config.contains(&c), "{c} missing");
    }
    assert!(config.contains(
        &format!(
            "developer_instructions={}",
            serde_json::to_string(super::super::watch_seal::SYSTEM_PROMPT).unwrap()
        )
        .as_str()
    ));
    // One server, ours: the relay, its secret named, never given.
    let servers: Vec<&&str> = config
        .iter()
        .filter(|c| c.starts_with("mcp_servers."))
        .collect();
    assert_eq!(
        servers,
        vec![
            &r#"mcp_servers.linear={url="http://127.0.0.1:4100/mcp/conn/linear",bearer_token_env_var="SHIPSTUDIO_AGENTS_CHECK_TOKEN",startup_timeout_sec=30,tool_timeout_sec=120}"#
        ]
    );
    // Codex's own default approval for it: only tools marked read-only run.
    assert!(!servers[0].contains("approval_mode"));
    assert_eq!(value_after(&a, "-m"), vec!["gpt-small"]);
    for never in [
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--approve-for-me",
        "--full-auto",
        "--add-dir",
        "--enable",
        "--profile",
        "-p",
        "--cd",
        "-C",
        "resume",
        "workspace-write",
        "danger-full-access",
    ] {
        assert!(!a.iter().any(|x| x == never), "{never} present");
    }
    for c in &config {
        for never in [
            "on-request",
            "on-failure",
            "untrusted",
            "network_access",
            "default_permissions",
            "CLAUDE.md",
            "default_tools_approval_mode",
            "enabled=true",
        ] {
            assert!(!c.contains(never), "{c} has {never}");
        }
    }
    // Without a small model: Codex's default, still at low effort.
    let a = args("linear", RELAY, None);
    assert!(!a.iter().any(|x| x == "-m"));
}

#[test]
fn only_a_plain_server_key_goes_in_a_config_path() {
    for ok in ["linear", "gmail_work", "app2"] {
        assert!(key_is_plain(ok), "{ok}");
    }
    for no in ["", "a.b", "a=b", "a\"b", "my linear", "x{y}", "a-b"] {
        assert!(!key_is_plain(no), "{no}");
    }
}

/// The exact command line, for the probe in docs/agents.md ("When…
/// routines"): `cargo test print_codex_check_args -- --ignored --nocapture`.
#[test]
#[ignore]
fn print_codex_check_args() {
    let a = args("probe", "http://127.0.0.1:47822/mcp", Some("gpt-5.5"));
    println!("{}", a.join("\n"));
}

#[test]
fn a_small_model_is_one_codex_itself_lists() {
    let cache = json!({ "models": [
        { "slug": "big-one", "visibility": "list", "priority": 1, "description": "Frontier intelligence." },
        { "slug": "hidden-fast", "visibility": "hide", "priority": 2, "description": "Fast and affordable." },
        { "slug": "luna", "visibility": "list", "priority": 8, "description": "Older fast and efficient model." },
        { "slug": "thing-mini", "visibility": "list", "priority": 9, "description": "" },
        { "slug": "--evil", "visibility": "list", "priority": 0, "description": "fast" },
    ] })
    .to_string();
    assert_eq!(small_model(&cache).as_deref(), Some("luna"));
    let none = json!({ "models": [
        { "slug": "big-one", "visibility": "list", "priority": 1, "description": "Frontier." },
    ] })
    .to_string();
    assert_eq!(small_model(&none), None);
    assert_eq!(small_model("not json"), None);
}

/// Codex 0.166's own output for a sealed check that read through the relay.
const READ_RUN: &str = r#"{"type":"thread.started","thread_id":"01a1c312"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"linear","tool":"list_items","arguments":{},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"linear","tool":"list_items","arguments":{},"result":{"content":[{"type":"text","text":"ENG-1"}],"structured_content":null},"error":null,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\"items\":[{\"id\":\"ENG-1\",\"url\":\"https://linear.app/x/issue/ENG-1\",\"title\":\"Fix it\"}]}"}}
{"type":"turn.completed","usage":{"input_tokens":2000,"cached_input_tokens":1600,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0}}
"#;

#[test]
fn a_codex_checks_answer_is_its_last_message() {
    let (reply, usage) = parse_result(READ_RUN, "linear");
    let items = super::super::watch::parse_model_items(&reply.unwrap()).unwrap();
    assert_eq!(
        items[0].url.as_deref(),
        Some("https://linear.app/x/issue/ENG-1")
    );
    let usage = usage.unwrap();
    assert_eq!(usage.input_tokens, 400);
    assert_eq!(usage.cache_read_tokens, 1600);
    assert_eq!(usage.output_tokens, 40);
}

#[test]
fn a_codex_check_that_did_anything_else_is_not_used() {
    let stray = |item: Value| {
        let line = json!({ "type": "item.started", "item": item }).to_string();
        format!("{line}\n{READ_RUN}")
    };
    for item in [
        json!({ "type": "command_execution", "command": "cat ~/.ssh/id_rsa" }),
        json!({ "type": "file_change", "changes": [] }),
        json!({ "type": "web_search", "query": "x" }),
        json!({ "type": "mcp_tool_call", "server": "other", "tool": "list_items" }),
        json!({ "type": "collab_tool_call" }),
    ] {
        let (reply, usage) = parse_result(&stray(item.clone()), "linear");
        assert!(reply.unwrap_err().contains("doesn't allow"), "{item}");
        // What it spent still counts.
        assert!(usage.is_some());
    }
}

#[test]
fn a_codex_check_that_failed_says_why() {
    let failed = r#"{"type":"turn.started"}
{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#;
    assert_eq!(
        parse_result(failed, "linear").0.unwrap_err(),
        "You've hit your usage limit."
    );
    let silent = r#"{"type":"turn.started"}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#;
    assert_eq!(
        parse_result(silent, "linear").0.unwrap_err(),
        "Codex finished without an answer."
    );
    assert_eq!(
        parse_result("", "linear").0.unwrap_err(),
        "Codex's answer couldn't be read."
    );
}
