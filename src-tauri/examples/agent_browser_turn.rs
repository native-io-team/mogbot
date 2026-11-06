//! The agents' browser the way a turn reaches it, end to end on this Mac:
//! whether a turn is given the `browser` server (this build, the Settings
//! switch, Chrome, the agent's settings), the server's entry in the turn's
//! MCP config, then the JSON-RPC a turn sends (`initialize`, `tools/list`,
//! `tools/call open example.com`, `read_page`) through the same dispatch the
//! agent bridge's `/mcp/browser` uses, and the timeline's words for it.
//!
//! Chrome runs on a scratch profile (never the app's own, never the user's
//! own Chrome) and is closed at the end. It only reads the app's settings.
//!
//! `cargo run --example agent_browser_turn -- <scratch dir>`

#![allow(clippy::disallowed_methods, clippy::unwrap_used, clippy::expect_used)]
use app_lib::agent_browser::{self, chrome, service, tools};
use app_lib::agents::{connections, reach, store::Agent, work};
use serde_json::{json, Value};
use std::time::Instant;

fn text(v: &Value) -> String {
    v["result"]["content"]
        .as_array()
        .map(|c| {
            c.iter()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn main() {
    let scratch = std::env::args()
        .nth(1)
        .expect("usage: agent_browser_turn <scratch dir>");
    let mut failed = Vec::new();
    let mut check = |what: &str, ok: bool| {
        println!("{} {what}", if ok { "✓" } else { "✗" });
        if !ok {
            failed.push(what.to_string());
        }
    };

    // --- 1. would a turn get it?
    println!("compiled in: {}", agent_browser::COMPILED);
    println!(
        "on this Mac: {}",
        agent_browser::unavailable_reason().unwrap_or("available")
    );
    let agent: Agent = serde_json::from_value(json!({
        "id": "turn_check", "name": "Turn check", "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap();
    let given = connections::agents_browser_for_turn(&agent, false);
    check("a turn of a new agent gets the agents' browser", given);
    check(
        "a turn answering outside text doesn't",
        !connections::agents_browser_for_turn(&agent, true),
    );
    let access = connections::TurnAccess {
        servers: vec![connections::TurnServer {
            key: tools::SERVER_KEY.into(),
            url: tools::url(51118),
        }],
        ..Default::default()
    };
    let config: Value = serde_json::from_str(&reach::claude_config_with(
        &reach::agent_url(51118),
        "secret",
        access.claude_servers("secret"),
    ))
    .unwrap();
    check(
        "Claude Code's --mcp-config has `app` and `browser`",
        config["mcpServers"]["app"].is_object()
            && config["mcpServers"]["browser"]["url"]
                .as_str()
                .is_some_and(|u| u.ends_with("/mcp/browser")),
    );
    check(
        "Codex gets `-c mcp_servers.browser=…`",
        access
            .codex_config()
            .iter()
            .any(|c| c.starts_with("mcp_servers.browser=")),
    );

    // --- 2. Chrome on a scratch profile, as the service starts it
    let root = std::path::PathBuf::from(scratch).join("agent-browser");
    let profile = root.join("Agents");
    let chrome = chrome::find_chrome().expect("Google Chrome");
    let t = Instant::now();
    let svc = service::launch_at(&chrome, &profile, &root).expect("launched");
    println!(
        "launched pid {} on a scratch profile in {} ms",
        svc.browser.pid(),
        t.elapsed().as_millis()
    );
    service::install_for_tests(svc);

    // --- 3. the JSON-RPC a turn sends to /mcp/browser
    let rt = tokio::runtime::Runtime::new().unwrap();
    let rpc = |id: u64, method: &str, params: Value| -> Value {
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        rt.block_on(tools::dispatch(None, &agent, Some(1), &msg))
    };
    let init = rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" }));
    check(
        "initialize answers as `browser`",
        init["result"]["serverInfo"]["name"] == "browser",
    );
    let list = rpc(2, "tools/list", json!({}));
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .map(|t| t.iter().filter_map(|t| t["name"].as_str()).collect())
        .unwrap_or_default();
    check(
        &format!("tools/list has open and read_page ({} tools)", names.len()),
        names.contains(&"open") && names.contains(&"read_page"),
    );
    let t = Instant::now();
    let open = rpc(
        3,
        "tools/call",
        json!({ "name": "open", "arguments": { "url": "https://example.com/" } }),
    );
    let said = text(&open);
    println!(
        "    open → {} ({} ms)",
        said.lines().next().unwrap_or(""),
        t.elapsed().as_millis()
    );
    check(
        "open example.com lands on Example Domain",
        open["result"]["isError"] != true && said.contains("Example Domain"),
    );
    let read = text(&rpc(
        4,
        "tools/call",
        json!({ "name": "read_page", "arguments": {} }),
    ));
    println!(
        "    read_page → {}",
        read.lines().take(3).collect::<Vec<_>>().join(" | ")
    );
    check(
        &format!(
            "read_page reads the page ({} lines, {} refs)",
            read.lines().count(),
            read.matches("ref_").count()
        ),
        read.contains("documentation examples"),
    );
    check("its tab is the agent's", service::has_tabs(&agent.id));

    // --- 4. what the timeline says
    let opened = work::describe_tool(
        "mcp__browser__open",
        Some(&json!({ "url": "https://example.com/" })),
    )
    .unwrap();
    println!("    timeline: {} / {}", opened.label, opened.doing);
    check(
        "the timeline says \"Using its own browser · example.com\"",
        opened.doing == "Using its own browser · example.com",
    );
    work::begin(&agent.id, 0);
    let doing = work::on_action(
        &agent.id,
        work::describe_tool("mcp__browser__read_page", Some(&json!({}))).unwrap(),
        1,
    );
    check(
        &format!("a step naming no site gets the page it's on ({doing})"),
        doing == "Using its own browser · example.com",
    );
    work::forget_agent(&agent.id);

    service::shutdown();
    println!("closed the scratch Chrome");
    if !failed.is_empty() {
        eprintln!("failed: {failed:?}");
        std::process::exit(1);
    }
}
