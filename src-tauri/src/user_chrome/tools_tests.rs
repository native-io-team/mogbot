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
    // Nothing else: every quoted CDP method in the file is one of ours, a
    // domain the extension switches on itself, or an event it keeps for
    // read_console / read_network.
    let own = [
        "Page.enable",
        "DOM.enable",
        "Accessibility.enable",
        "Runtime.enable",
        "Network.enable",
        "Runtime.consoleAPICalled",
        "Runtime.exceptionThrown",
        "Network.requestWillBeSent",
        "Network.responseReceived",
        "Network.loadingFailed",
    ];
    let re = regex::Regex::new(r"'([A-Z][A-Za-z]+\.[a-z][A-Za-z]+)'").unwrap();
    for c in re.captures_iter(&js) {
        let m = &c[1];
        assert!(
            crate::agent_browser::page::METHODS.contains(&m) || own.contains(&m),
            "cdp.js allows {m}, which the app never sends"
        );
    }
    // Those are never the app's to send.
    for m in own {
        assert!(!crate::agent_browser::page::METHODS.contains(&m));
    }
}

#[test]
fn the_smallest_control_under_a_click_names_it() {
    let q = |x0: f64, y0: f64, x1: f64, y1: f64| vec![x0, y0, x1, y0, x1, y1, x0, y1];
    let boxes = vec![
        ("group \"Form\"".to_string(), q(0.0, 0.0, 500.0, 500.0)),
        ("radio \"Yes\"".to_string(), q(100.0, 670.0, 130.0, 700.0)),
        ("button \"Next\"".to_string(), q(400.0, 450.0, 480.0, 480.0)),
    ];
    assert_eq!(
        smallest_under(&boxes, 114.0, 683.0).as_deref(),
        Some("radio \"Yes\"")
    );
    assert_eq!(
        smallest_under(&boxes, 420.0, 460.0).as_deref(),
        Some("button \"Next\"")
    );
    assert_eq!(smallest_under(&boxes, 50.0, 50.0), None);
    assert_eq!(smallest_under(&boxes, 900.0, 900.0), None);
}

#[test]
fn a_project_tab_or_terminal_still_asks_before_it_sends_even_unleashed() {
    use crate::agents::browser_gate::session_level;
    assert_eq!(session_level(Level::FullSend), Level::GoHard);
    for l in [Level::Often, Level::Judgement, Level::GoHard] {
        assert_eq!(session_level(l), l, "below Unleashed: the team's own");
    }
    let mut page = Page::default();
    page.url = Some("https://mail.google.com/mail/u/0/#inbox".into());
    page.refs.insert("ref_1".into(), "button \"Send\"".into());
    page.refs.insert("ref_2".into(), "link \"Inbox\"".into());
    let s = super::super::sessions::Session {
        id: super::super::sessions::TERMINAL_ID.into(),
        label: "Terminal".into(),
        kind: super::super::sessions::Kind::Terminal,
    };
    let who = super::super::sessions::agent_of(&s);
    let at = session_level(Level::FullSend);
    let send = json!({ "ref": "ref_1" });
    assert_eq!(
        gate_user_chrome_with(true, at, &who, "click", &send, false, &page),
        Gate::Ask
    );
    let look = json!({ "ref": "ref_2" });
    assert_eq!(
        gate_user_chrome_with(true, at, &who, "click", &look, false, &page),
        Gate::Allow
    );
    assert_eq!(
        crate::agents::mcp::session_card_title("Terminal", "Send in Gmail"),
        "Terminal: Send in Gmail"
    );
}

#[test]
fn reading_the_console_and_requests_is_free_at_every_level() {
    let page = Page::default();
    for level in [
        Level::Often,
        Level::Judgement,
        Level::GoHard,
        Level::FullSend,
    ] {
        for name in ["read_console", "read_network"] {
            assert_eq!(
                gate(level, name, json!({ "tab": 3, "limit": 10 }), &page),
                Gate::Allow,
                "{name} at {level:?}"
            );
        }
    }
    let (n, _) = browser_gate::agents_equivalent("read_console", &json!({}));
    assert_eq!(n, "read_console_messages");
    let (n, _) = browser_gate::agents_equivalent("read_network", &json!({}));
    assert_eq!(n, "read_network_requests");
}

fn logged(started: bool, entries: Value) -> Logged {
    let mut l: Logged = serde_json::from_value(json!({ "entries": entries })).unwrap();
    l.started = started;
    l
}

#[test]
fn console_lines_say_level_text_and_where() {
    let got = logged(
        false,
        json!([
            { "seq": 1, "t": 0, "level": "log", "text": "booted", "source": "" },
            { "seq": 2, "t": 0, "level": "warn", "text": "slow\nrender", "source": "https://a.test/app.js:12" },
            { "seq": 3, "t": 0, "level": "error", "text": "TypeError: x is undefined", "source": "https://a.test/app.js:40" },
        ]),
    );
    assert_eq!(
        console_text(&got, None, 50),
        "[log] booted\n[warn] slow render (https://a.test/app.js:12)\n[error] TypeError: x is undefined (https://a.test/app.js:40)"
    );
    assert_eq!(
        console_text(&got, Some("error"), 50),
        "[error] TypeError: x is undefined (https://a.test/app.js:40)"
    );
    assert_eq!(
        console_text(&got, Some("warning"), 50),
        "[warn] slow render (https://a.test/app.js:12)"
    );
    // The newest, with a count of what's left out.
    assert_eq!(
        console_text(&got, None, 1),
        "(2 older not shown)\n[error] TypeError: x is undefined (https://a.test/app.js:40)"
    );
    assert_eq!(
        console_text(&got, Some("debug"), 50),
        "No debug messages in this tab's console."
    );
    assert_eq!(
        console_text(&logged(false, json!([])), None, 50),
        "This tab's console is empty."
    );
    // Just attached: says recording started, not "empty".
    assert!(console_text(&logged(true, json!([])), None, 50).starts_with("Nothing recorded yet"));
}

#[test]
fn request_lines_say_method_status_and_address() {
    let got = logged(
        false,
        json!([
            { "seq": 1, "method": "GET", "url": "https://a.test/", "status": 200 },
            { "seq": 2, "method": "POST", "url": "https://a.test/api", "status": 500 },
            { "seq": 3, "method": "GET", "url": "https://cdn.test/x.js", "failed": "net::ERR_BLOCKED_BY_CLIENT" },
            { "seq": 4, "method": "GET", "url": "https://a.test/slow" },
        ]),
    );
    assert_eq!(
        network_text(&got, false, 50),
        "GET 200 https://a.test/\nPOST 500 https://a.test/api\nGET failed (net::ERR_BLOCKED_BY_CLIENT) https://cdn.test/x.js\nGET pending https://a.test/slow"
    );
    assert_eq!(
        network_text(&got, true, 50),
        "POST 500 https://a.test/api\nGET failed (net::ERR_BLOCKED_BY_CLIENT) https://cdn.test/x.js"
    );
    assert_eq!(
        network_text(
            &logged(
                false,
                json!([{ "method": "GET", "url": "https://a.test/", "status": 200 }])
            ),
            true,
            50
        ),
        "No failed requests in this tab."
    );
}

#[test]
fn sessions_are_told_to_ask_the_user_to_sign_in_not_request_login() {
    let r = session_initialize_result(None);
    let i = r["instructions"].as_str().unwrap();
    assert!(i.contains("ask the user to sign in"));
    assert!(!i.contains("request_login"));
    assert_eq!(r["serverInfo"]["name"], SERVER_KEY);
}

#[test]
fn an_older_extension_is_told_apart_from_a_failure() {
    assert!(crate::user_chrome::older("0.1.2", LOGS_SINCE));
    assert!(!crate::user_chrome::older("0.1.3", LOGS_SINCE));
    let line = logs_need_update("0.1.1");
    assert!(line.contains("0.1.1") && line.contains(LOGS_SINCE));
    // The extension's own version is the one this build ships.
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../chrome-extension/extension/manifest.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!crate::user_chrome::older(
        manifest["version"].as_str().unwrap(),
        LOGS_SINCE
    ));
}

#[test]
fn the_logs_op_has_the_shape_the_extension_reads() {
    let op = Op::TabLogs {
        agent: "ops".into(),
        tab_id: 3,
        log: "network".into(),
        since: None,
        limit: Some(200),
    };
    assert_eq!(
        serde_json::to_value(&op).unwrap(),
        json!({ "kind": "tab_logs", "agent": "ops", "tab_id": 3, "log": "network", "since": null, "limit": 200 })
    );
    assert_eq!(op.agent(), Some("ops"));
}
