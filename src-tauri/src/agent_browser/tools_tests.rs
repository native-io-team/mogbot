use super::*;
use crate::agents::browser_gate::{gate_agents_with, Gate, Page};
use crate::agents::independence::Level;
use crate::agents::store::Agent;

fn agent() -> Agent {
    serde_json::from_value(json!({
        "id": "a1", "name": "Research", "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap()
}

fn page_with(refs: &[(&str, &str)], url: &str) -> Page {
    Page {
        refs: refs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        tabs: Default::default(),
        url: Some(url.to_string()),
        last_target: None,
        typed: Vec::new(),
    }
}

fn g(level: Level, name: &str, input: Value, page: &Page) -> Gate {
    gate_agents_with(true, level, &agent(), name, &input, false, page)
}

#[test]
fn looking_is_free_and_acting_is_free_unless_it_sends() {
    let p = page_with(
        &[
            ("ref_1", "textbox \"Search\""),
            ("ref_2", "button \"Send\""),
            ("ref_3", "link \"Next page\""),
        ],
        "https://example.com/",
    );
    for level in [Level::Judgement, Level::GoHard] {
        for (name, input) in [
            ("tabs", json!({})),
            ("read_page", json!({})),
            ("find", json!({ "query": "x" })),
            ("get_text", json!({})),
            ("screenshot", json!({})),
            ("scroll", json!({ "direction": "down" })),
            ("wait_for", json!({ "seconds": 1 })),
            ("navigate", json!({ "url": "https://en.wikipedia.org/" })),
            ("open", json!({ "url": "https://example.com/" })),
            ("click", json!({ "ref": "ref_3" })),
            ("type", json!({ "ref": "ref_1", "text": "rust" })),
        ] {
            assert_eq!(
                g(level, name, input.clone(), &p),
                Gate::Allow,
                "{level:?} {name} {input}"
            );
        }
        // A send is a card, at every level.
        assert_eq!(
            g(level, "click", json!({ "ref": "ref_2" }), &p),
            Gate::Ask,
            "{level:?}"
        );
        // Enter anywhere but a search box asks.
        assert_eq!(
            g(level, "press", json!({ "key": "Enter" }), &p),
            Gate::Ask,
            "{level:?}"
        );
        assert_eq!(g(level, "press", json!({ "key": "Tab" }), &p), Gate::Allow);
    }
}

#[test]
fn a_click_on_a_checkout_page_asks() {
    let p = page_with(
        &[("ref_1", "button \"Continue\"")],
        "https://shop.example/checkout",
    );
    assert_eq!(
        g(Level::GoHard, "click", json!({ "ref": "ref_1" }), &p),
        Gate::Ask
    );
    // An unknown target where the page can't be told: a coordinate click on
    // an ordinary page goes, on a checkout asks.
    assert_eq!(
        g(Level::Judgement, "click", json!({ "x": 5, "y": 5 }), &p),
        Gate::Ask
    );
}

#[test]
fn check_with_me_often_asks_for_every_action_and_unknown_sites() {
    let p = page_with(&[("ref_1", "link \"Next\"")], "https://example.com/");
    assert_eq!(
        g(Level::Often, "click", json!({ "ref": "ref_1" }), &p),
        Gate::Ask
    );
    assert_eq!(
        g(
            Level::Often,
            "navigate",
            json!({ "url": "https://example.com/" }),
            &p
        ),
        Gate::Ask
    );
    assert_eq!(g(Level::Often, "read_page", json!({}), &p), Gate::Allow);
}

#[test]
fn off_outside_text_and_a_browser_taken_away_refuse() {
    let p = Page::default();
    let a = agent();
    let read = json!({});
    assert!(matches!(
        gate_agents_with(false, Level::GoHard, &a, "read_page", &read, false, &p),
        Gate::Refuse(_)
    ));
    assert!(matches!(
        gate_agents_with(true, Level::GoHard, &a, "read_page", &read, true, &p),
        Gate::Refuse(_)
    ));
    let mut off = agent();
    off.reach.browser_off = true;
    assert!(matches!(
        gate_agents_with(true, Level::GoHard, &off, "read_page", &read, false, &p),
        Gate::Refuse(_)
    ));
}

#[test]
fn agent_tools_are_refused_while_the_user_signs_in_for_it() {
    let tool = format!("{AGENTS_SERVER}read_page");
    let mut a = agent();
    a.id = "a_signing_in".into();
    super::super::signin::note("req_tools_test", Some("a_signing_in"));
    match browser_gate::gate(&a, &tool, &json!({}), false) {
        Gate::Refuse(why) => assert_eq!(why, browser_gate::AGENTS_SIGNIN_REFUSAL),
        other => panic!("{other:?}"),
    }
    super::super::signin::note("req_tools_test", None);
    assert!(!matches!(
        browser_gate::gate(&a, &tool, &json!({}), false),
        Gate::Refuse(w) if w == browser_gate::AGENTS_SIGNIN_REFUSAL
    ));
}

#[test]
fn no_script_upload_or_download_tool_exists() {
    let list = tools_list().to_string();
    for banned in [
        "evaluate",
        "javascript",
        "upload",
        "download",
        "execute",
        "cookie",
    ] {
        assert!(!list.contains(&format!("\"name\":\"{banned}")), "{banned}");
    }
    assert_eq!(TOOLS.len(), 14);
    let init = initialize_result(None);
    let text = init["instructions"].as_str().unwrap();
    assert!(text.contains("request_login") && text.contains("signed_out: true"));
    assert!(text.contains("Never type a password"));
    assert!(text.contains("ask_user_to_step_in"));
}

#[test]
fn an_engines_approval_is_a_pass_for_one_call() {
    let send = json!({ "ref": "ref_2" });
    note_cleared("a_pass", "mcp__browser__click", &send);
    assert!(take_cleared("a_pass", "mcp__browser__click", &send));
    assert!(!take_cleared("a_pass", "mcp__browser__click", &send));
    note_cleared("a_pass", "mcp__browser__click", &send);
    assert!(!take_cleared("someone_else", "mcp__browser__click", &send));
    // Only that call: a click on another control isn't covered.
    assert!(!take_cleared(
        "a_pass",
        "mcp__browser__click",
        &json!({ "ref": "ref_9" })
    ));
    assert!(take_cleared("a_pass", "mcp__browser__click", &send));
}

#[test]
fn the_card_says_the_agents_browser_not_your_chrome() {
    let p = page_with(&[("ref_2", "button \"Send\"")], "https://mail.example/");
    let (title, said) =
        browser_gate::describe_agents("mcp__browser__click", &json!({ "ref": "ref_2" }), &p);
    assert_eq!(title, "Click “Send” on mail.example");
    assert!(said.contains("in the agents' browser"), "{said}");
    assert!(!said.contains("your signed-in Chrome"));
}

/// The tools against a fake Chrome: refs from the tree Chrome built, a
/// password field refused, a tab only its agent can reach. One test: the
/// running Chrome is one per process.
#[test]
fn the_tools_drive_a_fake_chrome() {
    let (b, fake) = super::super::service::tests::fake_browser();
    let svc = Service::start(b, std::path::PathBuf::from("/tmp/none")).unwrap();
    service::install_for_tests(svc.clone());

    let opened = run(
        "tool_agent",
        "open",
        &json!({ "url": "https://example.com/" }),
    )
    .unwrap();
    assert!(
        opened[0]["text"].as_str().unwrap().starts_with("Tab "),
        "{opened:?}"
    );
    assert!(run(
        "tool_agent",
        "open",
        &json!({ "url": "file:///etc/passwd" })
    )
    .is_err());
    assert!(run(
        "tool_agent",
        "open",
        &json!({ "url": "javascript:alert(1)" })
    )
    .is_err());

    let read = run("tool_agent", "read_page", &json!({})).unwrap();
    let text = read[0]["text"].as_str().unwrap().to_string();
    assert!(text.contains("textbox \"Password\" [ref_1]"), "{text}");
    assert!(text.contains("button \"Send\" [ref_2]"), "{text}");
    // The gate's page memory has Chrome's own labels.
    let page = browser_gate::page_of(&browser_gate::agents_key("tool_agent"));
    assert_eq!(
        page.refs.get("ref_2").map(String::as_str),
        Some("button \"Send\"")
    );

    // Never into a password field, by ref.
    let err = run(
        "tool_agent",
        "type",
        &json!({ "ref": "ref_1", "text": "hunter2" }),
    )
    .unwrap_err();
    assert_eq!(err, NO_PASSWORDS);
    assert!(!fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c == "Input.insertText"));

    // Clicking a ref is a real click at its centre.
    run("tool_agent", "click", &json!({ "ref": "ref_2" })).unwrap();
    assert!(fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c == "Input.dispatchMouseEvent"));
    // Refs end with the page that had them.
    assert!(run("tool_agent", "click", &json!({ "ref": "ref_2" })).is_err());

    // Another agent sees none of it.
    assert!(run("other_agent", "read_page", &json!({})).is_err());
    let tabs = run("other_agent", "tabs", &json!({})).unwrap();
    assert!(tabs[0]["text"].as_str().unwrap().starts_with("No tabs"));

    // Keys are a short list.
    assert!(run("tool_agent", "press", &json!({ "key": "cmd+w" })).is_err());
    run("tool_agent", "press", &json!({ "key": "Tab" })).unwrap();

    // The user stepped into this tab: nothing reads or acts on it, and
    // `tabs` names it without reading it; another tab still works.
    let held_tab = svc.tab_for("tool_agent", None).unwrap();
    super::super::step_in::hold(
        "tool_agent",
        super::super::step_in::Held {
            request_id: "req_tools".into(),
            tab: held_tab.id,
            target_id: held_tab.target_id.clone(),
            since_ms: 0,
            before: crate::agents::browser::Landed {
                url: String::new(),
                title: String::new(),
            },
        },
    )
    .unwrap();
    for (name, args) in [
        ("read_page", json!({})),
        ("screenshot", json!({})),
        ("get_text", json!({})),
        ("press", json!({ "key": "Tab" })),
        ("navigate", json!({ "url": "https://example.com/" })),
        ("close_tab", json!({ "tab": held_tab.id })),
    ] {
        assert_eq!(
            run("tool_agent", name, &args).unwrap_err(),
            super::super::step_in::REFUSAL,
            "{name}"
        );
    }
    let tabs = run("tool_agent", "tabs", &json!({})).unwrap();
    assert!(tabs[0]["text"]
        .as_str()
        .unwrap()
        .contains("the user is in this tab"));
    run(
        "tool_agent",
        "open",
        &json!({ "url": "https://example.com/" }),
    )
    .unwrap();
    run("tool_agent", "get_text", &json!({})).unwrap();
    assert!(run("tool_agent", "get_text", &json!({ "tab": held_tab.id })).is_err());
    super::super::step_in::release("tool_agent", "req_tools");
    run("tool_agent", "get_text", &json!({ "tab": held_tab.id })).unwrap();

    // Review: a `wait_for` already waiting when the user steps in kept
    // reading the page they were in (and answered whether a text the agent
    // chose, a code, was on it). It stops at the hold.
    let target = held_tab.target_id.clone();
    let id = held_tab.id;
    let stepper = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        super::super::step_in::hold(
            "tool_agent",
            super::super::step_in::Held {
                request_id: "req_wait".into(),
                tab: id,
                target_id: target,
                since_ms: 0,
                before: crate::agents::browser::Landed {
                    url: String::new(),
                    title: String::new(),
                },
            },
        )
        .unwrap();
    });
    let waited = run(
        "tool_agent",
        "wait_for",
        &json!({ "tab": held_tab.id, "text": "never on the page 123456", "seconds": 4 }),
    );
    stepper.join().unwrap();
    assert_eq!(waited.unwrap_err(), super::super::step_in::REFUSAL);
    super::super::step_in::release("tool_agent", "req_wait");

    close_agent("tool_agent");
    assert!(svc.tabs_of(&Owner::Agent("tool_agent".into())).is_empty());
}
