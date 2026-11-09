use super::*;
use crate::agents::browser_gate::{gate_user_chrome_with, Page};
use crate::agents::independence::Level;
use crate::agents::store::Agent;

fn agent() -> Agent {
    serde_json::from_value(json!({
        "id": "ops", "name": "Ops", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap()
}

fn gate(level: Level, name: &str, input: Value, page: &Page) -> Gate {
    gate_user_chrome_with(true, level, &agent(), name, &input, false, page)
}

#[test]
fn the_agents_browser_tools_are_all_here_with_the_same_arguments() {
    for t in crate::agent_browser::tools::TOOLS {
        // Step in is for the agents' own browser: this one is already the
        // user's, and they're in it whenever they look at it.
        if t.name == crate::agent_browser::tools::STEP_IN_TOOL {
            continue;
        }
        let ours = TOOLS
            .iter()
            .find(|o| o.name == t.name)
            .unwrap_or_else(|| panic!("{} is missing", t.name));
        assert_eq!(
            (ours.schema)(),
            (t.schema)(),
            "{}'s arguments differ",
            t.name
        );
    }
    let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
    for extra in ["hover", "browsers", "use_browser"] {
        assert!(names.contains(&extra));
    }
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), names.len(), "a tool is listed twice");
}

#[test]
fn every_tool_is_one_the_gate_knows() {
    for t in TOOLS {
        let (n, _) = browser_gate::agents_equivalent(t.name, &json!({}));
        assert!(!n.starts_with("unknown_"), "{} would always ask", t.name);
    }
}

#[test]
fn off_outside_text_or_its_browser_off_is_refused() {
    let page = Page::default();
    let a = agent();
    let read = json!({});
    assert!(matches!(
        gate_user_chrome_with(false, Level::GoHard, &a, "read_page", &read, false, &page),
        Gate::Refuse(why) if why.contains("Your Chrome")
    ));
    assert!(matches!(
        gate_user_chrome_with(true, Level::FullSend, &a, "read_page", &read, true, &page),
        Gate::Refuse(why) if why.contains("outside")
    ));
    let mut off = agent();
    off.reach.browser_off = true;
    assert!(matches!(
        gate_user_chrome_with(true, Level::GoHard, &off, "tabs", &read, false, &page),
        Gate::Refuse(_)
    ));
}

#[test]
fn looking_is_free_and_sending_asks_as_in_claude_in_chrome() {
    let mut page = Page::default();
    page.url = Some("https://mail.google.com/mail/u/0/#inbox".into());
    page.refs.insert("ref_1".into(), "button \"Send\"".into());
    page.refs.insert("ref_2".into(), "link \"Inbox\"".into());
    for (name, input) in [
        ("tabs", json!({})),
        ("browsers", json!({})),
        ("use_browser", json!({ "browser": "1" })),
        ("open", json!({ "url": "https://example.com/" })),
        ("read_page", json!({})),
        ("find", json!({ "query": "search" })),
        ("get_text", json!({})),
        ("screenshot", json!({})),
        ("scroll", json!({ "direction": "down" })),
        ("hover", json!({ "ref": "ref_1" })),
    ] {
        assert_eq!(
            gate(Level::Judgement, name, input, &page),
            Gate::Allow,
            "{name}"
        );
    }
    assert_eq!(
        gate(Level::Judgement, "click", json!({ "ref": "ref_2" }), &page),
        Gate::Allow
    );
    assert_eq!(
        gate(Level::Judgement, "click", json!({ "ref": "ref_1" }), &page),
        Gate::Ask
    );
    assert_eq!(
        gate(Level::GoHard, "click", json!({ "ref": "ref_1" }), &page),
        Gate::Ask
    );
    // A page that isn't http(s) asks.
    assert_eq!(
        gate(
            Level::Judgement,
            "open",
            json!({ "url": "file:///etc/passwd" }),
            &page
        ),
        Gate::Ask
    );
    // At "Check with me often" every interaction asks.
    assert_eq!(
        gate(Level::Often, "click", json!({ "ref": "ref_2" }), &page),
        Gate::Ask
    );
}

#[test]
fn own_browser_helpers_cover_the_users_chrome() {
    let tool = format!("{USER_CHROME_SERVER}click");
    assert!(browser_gate::is_own_browser(&tool));
    assert_eq!(
        browser_gate::own_page_key("ops", &tool).as_deref(),
        Some("chrome:ops")
    );
    assert!(!browser_gate::is_own_browser(
        "mcp__claude-in-chrome__computer"
    ));
    let (title, said) = browser_gate::describe_agents(
        &format!("{USER_CHROME_SERVER}open"),
        &json!({ "url": "https://x.com/" }),
        &Page::default(),
    );
    assert!(!title.is_empty());
    assert!(!said.contains("agents' browser"), "{said}");
}

#[test]
fn a_sign_in_page_says_where_to_go() {
    let t = Owned {
        profile: "p".into(),
        tab_id: 5,
        url: "https://accounts.example.com/signin?continue=x".into(),
        title: "Sign in".into(),
    };
    let line = where_line(&t);
    assert!(line.starts_with("Tab 5 · Sign in · https://accounts.example.com/"));
    assert!(line.contains("request_login"));
    let t = Owned {
        title: String::new(),
        url: "https://example.com/".into(),
        ..t
    };
    assert_eq!(where_line(&t), "Tab 5 · (untitled) · https://example.com/");
}

#[test]
fn with_no_chrome_connected_it_says_so() {
    let e = run("nobody-here", "Nobody", "tabs", &json!({})).unwrap_err();
    assert!(e.contains("isn't connected"), "{e}");
    assert_eq!(
        run("nobody-here", "Nobody", "browsers", &json!({})).unwrap()[0]["text"],
        "No Chrome is connected right now."
    );
}

#[tokio::test]
async fn the_server_answers_mcp() {
    let a = agent();
    let init = dispatch(None, &a, Some(1), &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).await;
    assert_eq!(init["result"]["serverInfo"]["name"], SERVER_KEY);
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let list = dispatch(
        None,
        &a,
        Some(1),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    assert_eq!(
        list["result"]["tools"].as_array().unwrap().len(),
        TOOLS.len()
    );
    let unknown = dispatch(None, &a, Some(1), &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "javascript_tool" } })).await;
    assert_eq!(unknown["error"]["code"], -32602);
}

#[test]
fn the_extension_relays_exactly_the_page_logics_methods_and_expressions() {
    let js = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../chrome-extension/extension/src/cdp.js"),
    )
    .unwrap();
    for m in crate::agent_browser::page::METHODS {
        assert!(js.contains(&format!("'{m}'")), "cdp.js doesn't relay {m}");
    }
    for e in crate::agent_browser::page::EXPRESSIONS {
        // A double-quoted literal (the expression has single quotes in it),
        // or a single-quoted one (Prettier's choice when it doesn't).
        let double = serde_json::to_string(e).unwrap();
        let single = format!("'{e}'");
        assert!(
            js.contains(&double) || (!e.contains('\'') && js.contains(&single)),
            "cdp.js doesn't allow {double}"
        );
    }
    for f in crate::agent_browser::page::FUNCTIONS {
        let double = serde_json::to_string(f).unwrap();
        assert!(js.contains(&double), "cdp.js doesn't allow {double}");
    }
    // Nothing else: every quoted CDP method in the file is one of ours.
    let re = regex::Regex::new(r"'([A-Z][A-Za-z]+\.[a-z][A-Za-z]+)'").unwrap();
    for c in re.captures_iter(&js) {
        let m = &c[1];
        assert!(
            crate::agent_browser::page::METHODS.contains(&m)
                || ["Page.enable", "DOM.enable", "Accessibility.enable"].contains(&m),
            "cdp.js allows {m}, which the app never sends"
        );
    }
}
