use super::*;
use crate::agents::engine::Engine;
use serde_json::json;

// Fictional agent and pages; the hosts are real services'.
fn agent() -> Agent {
    let mut a: Agent = serde_json::from_value(json!({
        "id": "ops", "name": "Ops", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap();
    a.engine = Engine::Claude;
    a
}

fn t(name: &str) -> String {
    format!("{SERVER}{name}")
}

/// A page the agent read: Gmail with a compose box open, and a dashboard.
fn page() -> Page {
    let mut p = Page::default();
    on_answer(
        &mut p,
        "button \"Compose\" [ref_1]\ntextbox \"To recipients\" [ref_2]\ntextbox \"Message Body\" [ref_3]\nbutton \"Send\" [ref_4]\nsearchbox \"Search mail\" [ref_5]\n- ref_6: link \"Inbox\"\nbutton \"Place order\" [ref_7]\nbutton \"Delete project\" [ref_8]\nbutton \"Next\" [ref_9]\nbutton \"Sign in\" [ref_10]",
    );
    p.tabs
        .insert(7, "https://mail.google.com/mail/u/0/#inbox".into());
    p.tabs
        .insert(8, "https://checkout.stripe.com/c/pay/cs_test_x".into());
    p.tabs.insert(9, "https://shop.example/cart".into());
    p
}

fn at(level: Level, tool: &str, input: serde_json::Value) -> Gate {
    gate_with(true, level, &agent(), &t(tool), &input, false, &page())
}

const ALL: [Level; 3] = [Level::Often, Level::Judgement, Level::GoHard];
const FREE: [Level; 2] = [Level::Judgement, Level::GoHard];

#[test]
fn looking_around_never_asks_except_off_site_at_often() {
    let looks = [
        ("tabs_context_mcp", json!({"createIfEmpty": true})),
        ("tabs_create_mcp", json!({})),
        ("tabs_close_mcp", json!({"tabId": 7})),
        ("list_connected_browsers", json!({})),
        ("select_browser", json!({"browser": "Browser 1"})),
        ("switch_browser", json!({})),
        ("read_page", json!({"tabId": 7})),
        ("get_page_text", json!({"tabId": 7})),
        ("find", json!({"query": "deploy button", "tabId": 7})),
        ("read_console_messages", json!({"tabId": 7})),
        ("read_network_requests", json!({"tabId": 7})),
        ("resize_window", json!({"width": 1200, "height": 800})),
        ("gif_creator", json!({"action": "start_recording"})),
        ("shortcuts_list", json!({})),
    ];
    for level in ALL {
        for (tool, input) in &looks {
            assert_eq!(
                at(level, tool, input.clone()),
                Gate::Allow,
                "{tool} at {level:?}"
            );
        }
        for action in [
            "screenshot",
            "zoom",
            "scroll",
            "mouse_move",
            "wait",
            "hover",
            "scroll_to",
        ] {
            assert_eq!(
                at(level, "computer", json!({"action": action, "tabId": 7})),
                Gate::Allow,
                "{action}"
            );
        }
    }
    // Any web page at Judgement and Go hard; only its own sites at Often.
    let vercel = json!({"url": "https://vercel.com/dashboard", "tabId": 7});
    for level in FREE {
        assert_eq!(at(level, "navigate", vercel.clone()), Gate::Allow);
        assert_eq!(
            at(
                level,
                "tabs_create_mcp",
                json!({"url": "https://vercel.com/"})
            ),
            Gate::Allow
        );
        // Web pages only.
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "chrome://settings",
        ] {
            assert_eq!(
                at(level, "navigate", json!({ "url": url })),
                Gate::Ask,
                "{url}"
            );
        }
    }
    assert_eq!(at(Level::Often, "navigate", vercel), Gate::Ask);
}

/// Opening a page never carries a secret off this Mac without a card
/// (`egress`): a token in the address asks, at every level.
#[test]
fn an_address_carrying_a_secret_asks() {
    for level in FREE {
        for (tool, url) in [
            (
                "navigate",
                "https://collect.example.test/?k=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
            ),
            (
                "tabs_create_mcp",
                "https://collect.example.test/?access_token=abcdef123456",
            ),
        ] {
            assert_eq!(at(level, tool, json!({ "url": url })), Gate::Ask, "{url}");
        }
        assert_eq!(
            at(
                level,
                "navigate",
                json!({ "url": "https://example.test/docs?page=2" })
            ),
            Gate::Allow
        );
    }
}

#[test]
fn clicks_and_typing_go_through_unless_they_send() {
    for level in FREE {
        let g = |tool: &str, input: serde_json::Value| at(level, tool, input);
        // Ordinary clicks, by ref or by coordinate, on an ordinary page.
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "ref": "ref_1", "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "ref": "ref_9", "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "ref": "ref_10", "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "ref": "ref_6", "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "coordinate": [10, 20], "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "type", "text": "Hi Sam", "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "key", "text": "Tab", "tabId": 7})
            ),
            Gate::Allow
        );
        assert_eq!(
            g(
                "form_input",
                json!({"ref": "ref_2", "value": "sam@example.test", "tabId": 7})
            ),
            Gate::Allow
        );
        // Sending, paying and deleting ask.
        for r in ["ref_4", "ref_7", "ref_8"] {
            assert_eq!(
                g(
                    "computer",
                    json!({"action": "left_click", "ref": r, "tabId": 7})
                ),
                Gate::Ask,
                "{r}"
            );
        }
        // Any click on a payment or cart page, even one it can't name.
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "coordinate": [1, 2], "tabId": 8})
            ),
            Gate::Ask
        );
        assert_eq!(
            g(
                "computer",
                json!({"action": "left_click", "ref": "ref_9", "tabId": 9})
            ),
            Gate::Ask
        );
        // Unknown actions ask.
        assert_eq!(g("computer", json!({"action": "something_new"})), Gate::Ask);
    }
    // Check with me often: every interaction asks.
    for (tool, input) in [
        (
            "computer",
            json!({"action": "left_click", "ref": "ref_1", "tabId": 7}),
        ),
        ("computer", json!({"action": "type", "text": "x"})),
        ("form_input", json!({"ref": "ref_2", "value": "x"})),
    ] {
        assert_eq!(at(Level::Often, tool, input), Gate::Ask);
    }
}

#[test]
fn enter_asks_unless_it_was_in_a_search_box() {
    let a = agent();
    let enter = json!({"action": "key", "text": "Enter", "tabId": 7});
    let mut p = page();
    // Typing in the message body, then Enter: could send.
    on_call(
        &mut p,
        "computer",
        &json!({"action": "left_click", "ref": "ref_3"}),
    );
    for level in FREE {
        assert_eq!(
            gate_with(true, level, &a, &t("computer"), &enter, false, &p),
            Gate::Ask
        );
        let cmd = json!({"action": "key", "text": "cmd+Return", "tabId": 7});
        assert_eq!(
            gate_with(true, level, &a, &t("computer"), &cmd, false, &p),
            Gate::Ask
        );
    }
    // In the search box: just searches.
    on_call(
        &mut p,
        "computer",
        &json!({"action": "left_click", "ref": "ref_5"}),
    );
    for level in FREE {
        assert_eq!(
            gate_with(true, level, &a, &t("computer"), &enter, false, &p),
            Gate::Allow
        );
    }
    // Nothing known about where the cursor is: asks.
    let blank = Page::default();
    assert_eq!(
        gate_with(
            true,
            Level::GoHard,
            &a,
            &t("computer"),
            &enter,
            false,
            &blank
        ),
        Gate::Ask
    );
}

#[test]
fn send_words_are_whole_words_on_the_control_name() {
    for label in [
        "button \"Send\"",
        "button \"Reply all\"",
        "button \"Post\"",
        "button \"Publish now\"",
        "button \"Tweet\"",
        "button \"Pay $49.00\"",
        "button \"Buy now\"",
        "button \"Check out\"",
        "button \"Place order\"",
        "button \"Delete project\"",
        "button \"Remove member\"",
        "button \"Transfer\"",
        "button \"Share\"",
        "button \"Invite\"",
        "button \"Confirm\"",
        "button \"Merge pull request\"",
        "button \"Redeploy\"",
        "button \"Deploy\"",
        "button \"Submit\"",
    ] {
        // "Redeploy" is one word: it's caught by the page check, not the name.
        if label.contains("Redeploy") {
            assert_eq!(sends(label), None);
            continue;
        }
        assert!(sends(label).is_some(), "{label}");
    }
    for label in [
        "button \"Compose\"",
        "link \"Posts\"",
        "button \"Next\"",
        "button \"Sign in\"",
        "link \"Inbox\"",
        "button \"Settings\"",
        "link \"Facebook\"",
        "button \"Sender details\"",
    ] {
        assert_eq!(sends(label), None, "{label}");
    }
}

#[test]
fn scripts_uploads_and_shortcuts_ask_below_go_hard() {
    for level in ALL {
        for tool in [
            "javascript_tool",
            "file_upload",
            "upload_image",
            "shortcuts_execute",
            "brand_new_tool",
        ] {
            // Go hard runs scripts, shortcuts and unknown tools; uploads ask.
            let expected =
                if level == Level::GoHard && !matches!(tool, "file_upload" | "upload_image") {
                    Gate::Allow
                } else {
                    Gate::Ask
                };
            assert_eq!(
                at(level, tool, json!({"tabId": 7})),
                expected,
                "{tool} at {level:?}"
            );
        }
        let send = json!({"text": "document.querySelector('form').submit()"});
        assert_eq!(at(level, "javascript_tool", send), Gate::Ask, "{level:?}");
        assert_eq!(
            at(level, "gif_creator", json!({"action": "export"})),
            Gate::Ask
        );
    }
}

#[test]
fn a_batch_goes_through_only_when_every_step_would() {
    let calm = json!({"actions": [
        {"tool": "computer", "input": {"action": "left_click", "ref": "ref_1", "tabId": 7}},
        {"tool": "computer", "input": {"action": "type", "text": "Draft", "tabId": 7}},
        {"tool": "computer", "input": {"action": "screenshot", "tabId": 7}}
    ]});
    let sends_mail = json!({"actions": [
        {"tool": "computer", "input": {"action": "type", "text": "Hi", "tabId": 7}},
        {"tool": "computer", "input": {"action": "left_click", "ref": "ref_4", "tabId": 7}}
    ]});
    let script = json!({"actions": [{"tool": "javascript_tool", "input": {"text": "1"}}]});
    for level in FREE {
        assert_eq!(at(level, "browser_batch", calm.clone()), Gate::Allow);
        assert_eq!(at(level, "browser_batch", sends_mail.clone()), Gate::Ask);
        let script_gate = if level == Level::GoHard {
            Gate::Allow
        } else {
            Gate::Ask
        };
        assert_eq!(at(level, "browser_batch", script.clone()), script_gate);
        assert_eq!(at(level, "browser_batch", json!({"weird": 1})), Gate::Ask);
    }
    assert_eq!(at(Level::Often, "browser_batch", calm), Gate::Ask);
}

#[test]
fn outside_text_never_gets_the_browser() {
    let a = agent();
    for level in ALL {
        for (tool, input) in [
            (
                "computer",
                json!({"action": "left_click", "ref": "ref_1", "tabId": 7}),
            ),
            ("form_input", json!({"ref": "ref_2", "value": "x"})),
            ("navigate", json!({"url": "https://vercel.com/"})),
            ("javascript_tool", json!({})),
        ] {
            assert!(matches!(
                gate_with(true, level, &a, &t(tool), &input, true, &page()),
                Gate::Refuse(_)
            ));
        }
    }
    // And the level a turn runs at from outside is never Go hard.
    assert_eq!(
        super::super::independence::for_turn(Level::GoHard, true),
        Level::Judgement
    );
}

#[test]
fn the_page_memory_follows_the_stream() {
    forget("ops-stream");
    observe(
        "ops-stream",
        &json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "c1", "name": t("navigate"), "input": {"url": "https://mail.google.com/mail/u/0/", "tabId": 3}}
        ]}}),
    );
    observe(
        "ops-stream",
        &json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "c2", "content": [{"type": "text", "text": "button \"Send\" [ref_44]"}]}
        ]}}),
    );
    let p = page_of("ops-stream");
    assert_eq!(
        p.refs.get("ref_44").map(String::as_str),
        Some("button \"Send\"")
    );
    assert_eq!(
        p.tabs.get(&3).map(String::as_str),
        Some("https://mail.google.com/mail/u/0/")
    );
    // A new page forgets the old one's controls.
    observe(
        "ops-stream",
        &json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "c3", "name": t("navigate"), "input": {"url": "https://vercel.com/", "tabId": 3}}
        ]}}),
    );
    assert!(page_of("ops-stream").refs.is_empty());
    forget("ops-stream");
}

#[test]
fn cards_are_in_plain_words() {
    let p = page();
    let d = |tool: &str, input: serde_json::Value| describe(&t(tool), &input, &p).0;
    assert_eq!(
        d("navigate", json!({"url": "https://vercel.com/dashboard"})),
        "Go to vercel.com"
    );
    assert_eq!(
        d("tabs_context_mcp", json!({"createIfEmpty": true})),
        "Look at your open tabs"
    );
    assert_eq!(d("tabs_create_mcp", json!({})), "Open a tab");
    assert_eq!(
        d(
            "computer",
            json!({"action": "left_click", "ref": "ref_4", "tabId": 7})
        ),
        "Click “Send” on mail.google.com"
    );
    assert_eq!(
        d(
            "computer",
            json!({"action": "key", "text": "Enter", "tabId": 7})
        ),
        "Press Enter on mail.google.com"
    );
    assert_eq!(
        d("javascript_tool", json!({"tabId": 7})),
        "Run a script on mail.google.com"
    );
    assert_eq!(
        d("file_upload", json!({"tabId": 8})),
        "Upload a file on checkout.stripe.com"
    );
    let (_, why) = describe(
        &t("computer"),
        &json!({"action": "left_click", "ref": "ref_4", "tabId": 7}),
        &p,
    );
    assert!(why.contains("send it as you"), "{why}");
    let (_, why) = describe(
        &t("computer"),
        &json!({"action": "left_click", "ref": "ref_7"}),
        &p,
    );
    assert!(why.contains("spend your money"), "{why}");
    // A batch is described by the step that acts.
    let batch = json!({"actions": [
        {"tool": "computer", "input": {"action": "screenshot", "tabId": 7}},
        {"tool": "computer", "input": {"action": "left_click", "ref": "ref_4", "tabId": 7}}
    ]});
    assert_eq!(
        d("browser_batch", batch),
        "Click “Send” on mail.google.com (and 1 more steps)"
    );
    // No raw tool names, anywhere.
    for tool in [
        "tabs_context_mcp",
        "read_page",
        "computer",
        "form_input",
        "shortcuts_execute",
        "gif_creator",
    ] {
        let (title, _) = describe(&t(tool), &json!({"action": "screenshot"}), &p);
        assert!(
            !title.contains('_') && !title.to_lowercase().contains("mcp"),
            "{title}"
        );
    }
}

/* ------------------------------------------- Go hard editors, Full send */

/// The owner's scheduled-post editors (labels from real cards, hosts
/// fictional): an X-like editor, open on a task the user asked for.
fn editor() -> Page {
    let mut p = Page::default();
    on_answer(
        &mut p,
        "button \"Will send on Fri, Nov 7 at 10:00 AM\" [ref_1]\ntextbox \"Post text\" [ref_2]\nbutton \"Discard changes\" [ref_3]\nbutton \"Close\" [ref_4]\nbutton \"Schedule\" [ref_5]\nbutton \"Post\" [ref_6]\nbutton \"Edit post\" [ref_7]\nbutton \"Buy credits\" [ref_8]\ntextbox \"Password\" [ref_9]\nbutton \"Delete account\" [ref_10]\nbutton \"Send now\" [ref_11]\ntab \"Scheduled posts\" [ref_12]",
    );
    p.tabs
        .insert(3, "https://x.example/compose/post/unsent/scheduled".into());
    p.tabs.insert(4, "https://shop.example/checkout".into());
    p
}

fn in_editor(level: Level, tool: &str, input: serde_json::Value) -> Gate {
    gate_with(true, level, &agent(), &t(tool), &input, false, &editor())
}

fn click(r: &str) -> serde_json::Value {
    json!({"action": "left_click", "ref": r, "tabId": 3})
}

#[test]
fn at_go_hard_only_the_final_send_in_an_editor_asks() {
    // Opening a scheduled post, the text box, discarding, closing, editing.
    for r in ["ref_1", "ref_2", "ref_3", "ref_4", "ref_7", "ref_12"] {
        assert_eq!(
            in_editor(Level::GoHard, "computer", click(r)),
            Gate::Allow,
            "{r}"
        );
    }
    assert_eq!(
        in_editor(
            Level::GoHard,
            "form_input",
            json!({"ref": "ref_2", "value": "New copy", "tabId": 3})
        ),
        Gate::Allow
    );
    assert_eq!(
        in_editor(
            Level::GoHard,
            "computer",
            json!({"action": "type", "text": "Fixed typo", "tabId": 3})
        ),
        Gate::Allow
    );
    // The owner's seven cards, as one batch: now none.
    let batch = json!({"actions": [
        {"tool": "computer", "input": click("ref_1")},
        {"tool": "computer", "input": click("ref_2")},
        {"tool": "form_input", "input": {"ref": "ref_2", "value": "x", "tabId": 3}},
        {"tool": "computer", "input": click("ref_3")},
    ]});
    assert_eq!(
        in_editor(Level::GoHard, "browser_batch", batch),
        Gate::Allow
    );
    // The final step still asks at Go hard.
    for r in ["ref_5", "ref_6", "ref_11", "ref_8", "ref_10"] {
        assert_eq!(
            in_editor(Level::GoHard, "computer", click(r)),
            Gate::Ask,
            "{r}"
        );
    }
    let posting = json!({"actions": [
        {"tool": "computer", "input": click("ref_2")},
        {"tool": "computer", "input": click("ref_6")},
    ]});
    assert_eq!(
        in_editor(Level::GoHard, "browser_batch", posting.clone()),
        Gate::Ask
    );
    // A password box asks at Go hard and above.
    let pw = json!({"ref": "ref_9", "value": "x", "tabId": 3});
    assert_eq!(
        in_editor(Level::GoHard, "form_input", pw.clone()),
        Gate::Ask
    );
    assert_eq!(in_editor(Level::FullSend, "form_input", pw), Gate::Ask);
    // "Use good judgement" is as before: a send word asks.
    assert_eq!(
        in_editor(Level::Judgement, "computer", click("ref_1")),
        Gate::Ask
    );
    // At Full send the final send runs too.
    for r in ["ref_5", "ref_6", "ref_11", "ref_1", "ref_3"] {
        assert_eq!(
            in_editor(Level::FullSend, "computer", click(r)),
            Gate::Allow,
            "{r}"
        );
    }
    assert_eq!(
        in_editor(Level::FullSend, "browser_batch", posting),
        Gate::Allow
    );
}

/// The owner's scheduled-posts page is under ".../compose/...": at Go hard a
/// click there is judged by what it clicks, not by the address, so clicks
/// with no readable label run. The final submit still asks by its label.
#[test]
fn at_go_hard_a_compose_address_alone_never_asks() {
    let somewhere = json!({"action": "left_click", "coordinate": [40, 300], "tabId": 3});
    let unknown_ref = json!({"action": "left_click", "ref": "ref_99", "tabId": 3});
    for level in [Level::GoHard, Level::FullSend] {
        assert_eq!(
            in_editor(level, "computer", somewhere.clone()),
            Gate::Allow,
            "{level:?}"
        );
        assert_eq!(
            in_editor(level, "computer", unknown_ref.clone()),
            Gate::Allow,
            "{level:?}"
        );
        assert_eq!(
            in_editor(
                level,
                "form_input",
                json!({"ref": "ref_98", "value": "x", "tabId": 3})
            ),
            Gate::Allow,
            "{level:?}"
        );
    }
    // By label: Post, Schedule, Send now still ask at Go hard, not at Full send.
    for r in ["ref_5", "ref_6", "ref_11"] {
        assert_eq!(
            in_editor(Level::GoHard, "computer", click(r)),
            Gate::Ask,
            "{r}"
        );
        assert_eq!(
            in_editor(Level::FullSend, "computer", click(r)),
            Gate::Allow,
            "{r}"
        );
    }
    // Below Go hard the address still makes an unknown click unsure.
    assert_eq!(
        in_editor(Level::Judgement, "computer", somewhere),
        Gate::Ask
    );
    // A checkout page stays unsure at every level.
    let checkout = json!({"action": "left_click", "coordinate": [10, 10], "tabId": 4});
    assert_eq!(in_editor(Level::GoHard, "computer", checkout), Gate::Ask);
}

#[test]
fn full_send_still_asks_for_money_accounts_and_secrets_in_the_browser() {
    for r in ["ref_8", "ref_10"] {
        assert_eq!(
            in_editor(Level::FullSend, "computer", click(r)),
            Gate::Ask,
            "{r}"
        );
    }
    // Any click on a checkout page, or a pay host.
    let checkout = json!({"action": "left_click", "coordinate": [10, 10], "tabId": 4});
    assert_eq!(in_editor(Level::FullSend, "computer", checkout), Gate::Ask);
    assert_eq!(
        at(
            Level::FullSend,
            "computer",
            json!({"action": "left_click", "coordinate": [1, 1], "tabId": 8})
        ),
        Gate::Ask
    );
    assert_eq!(
        at(
            Level::FullSend,
            "computer",
            json!({"action": "left_click", "ref": "ref_7", "tabId": 7})
        ),
        Gate::Ask,
        "Place order"
    );
    assert_eq!(
        at(
            Level::FullSend,
            "computer",
            json!({"action": "left_click", "ref": "ref_8", "tabId": 7})
        ),
        Gate::Ask,
        "Delete project"
    );
    // Uploads: what it posts runs; a key file asks.
    assert_eq!(
        in_editor(
            Level::FullSend,
            "file_upload",
            json!({"paths": ["/Users/fictional/Desktop/post1.png"], "ref": "ref_2"})
        ),
        Gate::Allow
    );
    assert_eq!(
        in_editor(
            Level::FullSend,
            "file_upload",
            json!({"paths": ["/Users/fictional/.ssh/id_ed25519"], "ref": "ref_2"})
        ),
        Gate::Ask
    );
    assert_eq!(
        in_editor(
            Level::GoHard,
            "file_upload",
            json!({"paths": ["/Users/fictional/Desktop/post1.png"]})
        ),
        Gate::Ask
    );
}

#[test]
fn scripts_that_read_or_click_run_and_ones_that_post_follow_the_level() {
    let js = |code: &str| json!({"action": "javascript_exec", "text": code, "tabId": 3});
    let reads = js("document.querySelectorAll('[data-testid=tweetText]').length");
    let edits = js("document.querySelector('button[aria-label=\"Discard changes\"]').click()");
    let posts = js("document.querySelector('button[aria-label=\"Post\"]').click()");
    let pays = js("document.querySelector('button[aria-label=\"Buy credits\"]').click()");
    for level in [Level::GoHard, Level::FullSend] {
        assert_eq!(
            in_editor(level, "javascript_tool", reads.clone()),
            Gate::Allow
        );
        assert_eq!(
            in_editor(level, "javascript_tool", edits.clone()),
            Gate::Allow
        );
        assert_eq!(in_editor(level, "javascript_tool", pays.clone()), Gate::Ask);
    }
    assert_eq!(
        in_editor(Level::GoHard, "javascript_tool", posts.clone()),
        Gate::Ask
    );
    assert_eq!(
        in_editor(Level::FullSend, "javascript_tool", posts),
        Gate::Allow
    );
    // Below Go hard a script always asks.
    assert_eq!(
        in_editor(Level::Judgement, "javascript_tool", reads),
        Gate::Ask
    );
}

#[test]
fn outside_text_never_gets_the_browser_at_full_send() {
    let g = gate_with(
        true,
        Level::FullSend,
        &agent(),
        &t("computer"),
        &click("ref_6"),
        true,
        &editor(),
    );
    assert!(matches!(g, Gate::Refuse(_)));
}

#[test]
fn final_submit_tells_the_last_step_from_the_ones_before_it() {
    for l in [
        "button \"Post\"",
        "button \"Send now\"",
        "button \"Schedule post\"",
        "button \"Publish\"",
        "button \"Pay $12\"",
        "button \"Delete account\"",
        "button \"Reply\"",
    ] {
        assert!(final_submit(l, Level::GoHard).is_some(), "{l}");
    }
    for l in [
        "button \"Will send on Fri, Nov 7\"",
        "textbox \"Post text\"",
        "button \"Discard changes\"",
        "button \"Close\"",
        "button \"Edit post\"",
        "tab \"Scheduled posts\"",
        "button \"New post\"",
        "link \"Drafts\"",
    ] {
        assert!(final_submit(l, Level::GoHard).is_none(), "{l}");
    }
    for l in [
        "button \"Post\"",
        "button \"Send\"",
        "button \"Schedule\"",
        "button \"Delete post\"",
    ] {
        assert!(final_submit(l, Level::FullSend).is_none(), "{l}");
    }
    for l in [
        "button \"Buy now\"",
        "button \"Place order\"",
        "button \"Delete account\"",
        "button \"Delete repository\"",
        "button \"Subscribe\"",
    ] {
        assert!(final_submit(l, Level::FullSend).is_some(), "{l}");
    }
}
