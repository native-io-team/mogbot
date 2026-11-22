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
        // Steps that name no tool: Chrome would refuse the batch, so it's
        // refused here with the shape, not put on a card (observed on Gmail).
        let unnamed = json!({"actions": [
            {"action": "navigate", "tabId": 7, "url": "https://mail.google.com/mail/u/0/#inbox"},
            {"action": "screenshot", "tabId": 7}
        ]});
        assert_eq!(
            at(level, "browser_batch", unnamed),
            Gate::Refuse(super::BATCH_SHAPE.into())
        );
    }
    assert_eq!(at(Level::Often, "browser_batch", calm), Gate::Ask);
}

/// Steps written flat (`{"action": …}` with no tool name): Claude in Chrome
/// refuses the whole batch without doing anything (observed on Gmail: the
/// card was allowed, then the call failed). So they're refused here at every
/// level with the right shape, never put on a card.
#[test]
fn a_flat_batch_is_refused_with_the_shape_not_a_card() {
    let look = json!({"actions": [
        {"action": "navigate", "tabId": 7, "url": "https://mail.google.com/mail/u/0/#sent"},
        {"action": "wait", "duration": 3},
        {"action": "screenshot", "scale": 0.5, "tabId": 7}
    ]});
    let sends = json!({"actions": [
        {"action": "type", "text": "Hi", "tabId": 7},
        {"action": "left_click", "ref": "ref_4", "tabId": 7}
    ]});
    for level in [Level::Often, Level::GoHard, Level::FullSend] {
        for batch in [&look, &sends] {
            assert_eq!(
                at(level, "browser_batch", batch.clone()),
                Gate::Refuse(super::BATCH_SHAPE.into()),
                "{level:?}"
            );
        }
    }
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
            {"type": "tool_use", "id": "c1", "name": t("navigate"), "input": {"url": "https://mail.google.com/mail/u/0/", "tabId": 3}},
            {"type": "tool_use", "id": "c2", "name": t("read_page"), "input": {"tabId": 3}}
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
    // Buy credits asks; Delete account runs (Unleashed asks only for money).
    assert_eq!(
        in_editor(Level::FullSend, "computer", click("ref_8")),
        Gate::Ask
    );
    assert_eq!(
        in_editor(Level::FullSend, "computer", click("ref_10")),
        Gate::Allow
    );
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
        Gate::Allow,
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
        "button \"Delete account\"",
        "button \"Delete repository\"",
    ] {
        assert!(final_submit(l, Level::FullSend).is_none(), "{l}");
    }
    for l in [
        "button \"Buy now\"",
        "button \"Place order\"",
        "button \"Subscribe\"",
    ] {
        assert!(final_submit(l, Level::FullSend).is_some(), "{l}");
    }
}

/// "Talk to Grok": the Chief asks the user's real Grok in their Chrome. At
/// "Go hard" and above, the Send (or Enter) that asks it a question runs
/// without a card: it's their own assistant, not a post as them. Below that
/// it asks, as every send does, and sharing or deleting in Grok, or posting
/// anywhere else on X, still asks at "Go hard".
#[test]
fn asking_the_users_own_grok_runs_at_go_hard() {
    let mut p = Page::default();
    on_answer(
        &mut p,
        "textbox \"Ask Grok anything\" [ref_1]\nbutton \"Send\" [ref_2]\nbutton \"Share\" [ref_3]\nbutton \"Delete chat\" [ref_4]",
    );
    p.tabs.insert(1, "https://grok.com/".into());
    p.tabs
        .insert(2, "https://x.com/i/grok?conversation=1".into());
    p.tabs.insert(3, "https://x.com/home".into());
    let click = |level: Level, r: &str, tab: u64| {
        gate_with(
            true,
            level,
            &agent(),
            &t("computer"),
            &json!({"action": "left_click", "ref": r, "tabId": tab}),
            false,
            &p,
        )
    };
    let enter = |level: Level, tab: u64| {
        let mut p = p.clone();
        p.last_target = Some("textbox \"Ask Grok anything\"".into());
        gate_with(
            true,
            level,
            &agent(),
            &t("computer"),
            &json!({"action": "key", "text": "Enter", "tabId": tab}),
            false,
            &p,
        )
    };
    for level in [Level::GoHard, Level::FullSend] {
        for tab in [1, 2] {
            assert_eq!(click(level, "ref_2", tab), Gate::Allow, "{level:?} {tab}");
            assert_eq!(enter(level, tab), Gate::Allow, "{level:?} {tab}");
        }
    }
    // Share and delete still ask at Go hard; so does a send on X's timeline.
    for r in ["ref_3", "ref_4"] {
        assert_eq!(click(Level::GoHard, r, 1), Gate::Ask, "{r}");
    }
    assert_eq!(click(Level::GoHard, "ref_2", 3), Gate::Ask);
    assert_eq!(enter(Level::GoHard, 3), Gate::Ask);
    // Below Go hard a send asks, Grok or not.
    assert_eq!(click(Level::Judgement, "ref_2", 1), Gate::Ask);
    assert_eq!(enter(Level::Judgement, 1), Gate::Ask);
    assert!(assistant_chat(Some("https://grok.com/c/abc")));
    assert!(assistant_chat(Some("https://x.com/i/grok")));
    assert!(!assistant_chat(Some("https://x.com/i/grokking")));
    assert!(!assistant_chat(Some("https://notgrok.com/")));
    assert!(!assistant_chat(Some("https://x.com/compose/post")));
}

/// With the exact-text switch on (`outward`), what counts as going out
/// under the user's name in the browser, and the words its card shows.
#[test]
fn a_send_click_is_outward_and_its_card_knows_what_was_typed() {
    let mut p = page();
    let a = agent();
    let send = json!({ "action": "left_click", "ref": "ref_4", "tabId": 7 });
    let enter = json!({ "action": "key", "text": "Return", "tabId": 7 });
    assert!(outward_step_on(&a, "computer", &send, &p));
    // Typing, filling and looking don't send.
    let fill = json!({ "ref": "ref_3", "value": "Thanks, see you Friday.", "tabId": 7 });
    assert!(!outward_step_on(&a, "form_input", &fill, &p));
    assert!(!outward_step_on(
        &a,
        "get_page_text",
        &json!({ "tabId": 7 }),
        &p
    ));
    assert!(!outward_step_on(
        &a,
        "navigate",
        &json!({ "url": "https://mail.google.com/" }),
        &p
    ));
    // What it typed is remembered for the send card, and a new page starts over.
    on_call(&mut p, "form_input", &fill);
    assert_eq!(p.typed, vec!["Thanks, see you Friday.".to_string()]);
    p.last_target = Some("textbox \"Message Body\"".into());
    assert!(outward_step_on(&a, "computer", &enter, &p));
    on_call(
        &mut p,
        "navigate",
        &json!({ "url": "https://mail.google.com/mail/u/0/#inbox", "tabId": 7 }),
    );
    assert!(p.typed.is_empty());
}

/// Observed: a batch that closed a menu, opened a Gmail search (the link
/// naming the account in `authuser`) and read the page got a "Goes out under
/// your name" card at Full send, and a message typed in one batch then sent
/// with Return reached its card as "can't read the exact words". Fictional
/// account and message.
#[test]
fn a_batch_is_outward_only_for_its_send_and_its_card_knows_what_it_typed() {
    let a = agent();
    let p = page();
    let look = json!({ "actions": [
        { "name": "computer", "input": { "action": "key", "text": "Escape", "tabId": 7 } },
        { "name": "navigate", "input": { "tabId": 7,
            "url": "https://mail.google.com/mail/?authuser=sam@example.test#search/garage" } },
        { "name": "computer", "input": { "action": "wait", "duration": 3, "tabId": 7 } },
        { "name": "get_page_text", "input": { "tabId": 7 } }
    ]});
    assert!(!outward_step_on(&a, "browser_batch", &look, &p));
    for level in [Level::GoHard, Level::FullSend] {
        assert_eq!(
            at(level, "browser_batch", look.clone()),
            Gate::Allow,
            "{level:?}"
        );
    }
    // Typing then Return in one batch: outward, and the words are known.
    let send = json!({ "actions": [
        { "name": "computer", "input": { "action": "left_click", "ref": "ref_3", "tabId": 7 } },
        { "name": "computer", "input": { "action": "type", "text": "Running ten minutes late", "tabId": 7 } },
        { "name": "computer", "input": { "action": "key", "text": "Return", "tabId": 7 } }
    ]});
    assert!(outward_step_on(&a, "browser_batch", &send, &p));
    assert_eq!(
        typed_through(p.clone(), &t("browser_batch"), &send),
        vec!["Running ten minutes late".to_string()]
    );
    // Typed in an earlier batch: the page remembers it for the next send.
    let mut later = p.clone();
    on_call(
        &mut later,
        "browser_batch",
        &json!({ "actions": [
            { "name": "computer", "input": { "action": "left_click", "ref": "ref_3", "tabId": 7 } },
            { "name": "computer", "input": { "action": "type", "text": "Running ten minutes late", "tabId": 7 } }
        ]}),
    );
    assert_eq!(later.typed, vec!["Running ten minutes late".to_string()]);
    assert_eq!(
        later.last_target.as_deref(),
        Some("textbox \"Message Body\"")
    );
}

/// Observed (2026-11-08), fictionalised: a read-only search in a chat web
/// app, clicked by position, typed and sent with Return, raised "Goes out
/// under your name" at Full send and expired unanswered. Now the agent is
/// told to name the box first; a labelled search box runs, a labelled
/// message box still asks, and the same steps sent again reach the card.
#[test]
fn enter_after_a_click_by_position_asks_the_agent_to_name_the_box() {
    let a = agent();
    let mut p = Page::default();
    p.tabs
        .insert(3, "https://chat.example.com/client/T1/C2".into());
    let by_position = json!({ "actions": [
        { "name": "computer", "input": { "action": "left_click", "coordinate": [700, 20], "tabId": 3 } },
        { "name": "computer", "input": { "action": "type", "text": "Northwind", "tabId": 3 } },
        { "name": "computer", "input": { "action": "key", "text": "Return", "tabId": 3 } },
        { "name": "computer", "input": { "action": "screenshot", "tabId": 3 } }
    ]});
    for (level, exact) in [
        (Level::FullSend, true),
        (Level::GoHard, false),
        (Level::GoHard, true),
        (Level::Judgement, false),
    ] {
        assert!(
            only_unlabelled_enter(level, &a, exact, "browser_batch", &by_position, &p),
            "{level:?} {exact}"
        );
    }
    // A lone Enter with nothing clicked: the same.
    let enter = json!({ "action": "key", "text": "Return", "tabId": 3 });
    assert!(only_unlabelled_enter(
        Level::GoHard,
        &a,
        false,
        "computer",
        &enter,
        &p
    ));
    // At "Check with me often" the click asks anyway: not this case.
    assert!(!only_unlabelled_enter(
        Level::Often,
        &a,
        false,
        "browser_batch",
        &by_position,
        &p
    ));

    // Named by ref: a search box runs, a message box is a real send.
    on_answer(
        &mut p,
        "combobox \"Search Northwind\" [ref_1]\ntextbox \"Message #general\" [ref_2]",
    );
    let named = |r: &str| {
        json!({ "actions": [
            { "name": "computer", "input": { "action": "left_click", "ref": r, "tabId": 3 } },
            { "name": "computer", "input": { "action": "type", "text": "Northwind", "tabId": 3 } },
            { "name": "computer", "input": { "action": "key", "text": "Return", "tabId": 3 } }
        ]})
    };
    assert_eq!(
        gate_with(
            true,
            Level::GoHard,
            &a,
            &t("browser_batch"),
            &named("ref_1"),
            false,
            &p
        ),
        Gate::Allow
    );
    assert!(outward_step_on(&a, "browser_batch", &named("ref_2"), &p));
    assert!(!only_unlabelled_enter(
        Level::GoHard,
        &a,
        true,
        "browser_batch",
        &named("ref_2"),
        &p
    ));
    // A send click in the same batch is its own reason to ask.
    let mut q = p.clone();
    on_answer(&mut q, "button \"Send now\" [ref_9]");
    let with_send = json!({ "actions": [
        { "name": "computer", "input": { "action": "left_click", "ref": "ref_9", "tabId": 3 } },
        { "name": "computer", "input": { "action": "key", "text": "Return", "tabId": 3 } }
    ]});
    assert!(!only_unlabelled_enter(
        Level::GoHard,
        &a,
        false,
        "browser_batch",
        &with_send,
        &q
    ));

    // Redirected once; the same steps again go to the card.
    let id = "enter-redirect-test";
    assert!(first_try(id, &by_position));
    assert!(!first_try(id, &by_position));
}

/// Exact-text on: a click by coordinate after typing is treated as a send
/// (it may be the Post button), and before typing it isn't.
#[test]
fn an_unlabelled_click_after_typing_counts_as_outward() {
    let mut p = page();
    let a = agent();
    let by_spot = json!({ "action": "left_click", "coordinate": [640, 410], "tabId": 7 });
    let unknown_ref = json!({ "action": "left_click", "ref": "ref_999", "tabId": 7 });
    // Nothing typed: an unlabelled click is just a click.
    assert!(!outward_step_on(&a, "computer", &by_spot, &p));
    on_call(
        &mut p,
        "computer",
        &json!({ "action": "type", "text": "Big news today", "tabId": 7 }),
    );
    assert!(!p.typed.is_empty());
    assert!(outward_step_on(&a, "computer", &by_spot, &p));
    assert!(outward_step_on(&a, "computer", &unknown_ref, &p));
    // A labelled harmless click stays a click.
    let labelled = json!({ "action": "left_click", "ref": "ref_3", "tabId": 7 });
    assert!(!outward_step_on(&a, "computer", &labelled, &p));
}

/// CTO review 2026-11-14: any tool's output was read for labels, so
/// `echo 'ref_42 search box'` could relabel the Send button.
#[test]
fn only_the_browsers_own_reads_name_its_controls() {
    forget("ops-poison");
    observe(
        "ops-poison",
        &json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "r1", "name": t("read_page"), "input": {"tabId": 3}},
            {"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "echo"}}
        ]}}),
    );
    observe(
        "ops-poison",
        &json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "r1", "content": "button \"Send\" [ref_42]"},
            {"type": "tool_result", "tool_use_id": "b1", "content": "ref_42 search box"},
            {"type": "tool_result", "tool_use_id": "nobody", "content": "ref_43 search box"}
        ]}}),
    );
    let p = page_of("ops-poison");
    assert_eq!(
        p.refs.get("ref_42").map(String::as_str),
        Some("button \"Send\"")
    );
    assert!(!p.refs.contains_key("ref_43"));
    forget("ops-poison");
}

/// Julian, 2026-11-16: a scheduled LinkedIn post asked for "Start a post",
/// then again for Post, Confirm and Schedule, each with the same words.
/// Opening a composer isn't a send, and once the words were allowed the
/// rest of that same send goes through.
#[test]
fn one_send_asks_once_and_opening_a_composer_never_asks() {
    for opener in [
        "button \"Start a post\"",
        "button \"Create post\"",
        "button \"Write a comment\"",
    ] {
        assert!(final_submit(opener, Level::GoHard).is_none(), "{opener}");
    }
    assert!(final_submit("button \"Post\"", Level::GoHard).is_some());
    assert!(final_submit("button \"Schedule\"", Level::GoHard).is_some());

    let mut a = agent();
    a.id = "same-send-test".into();
    let mut p = Page::default();
    on_answer(
        &mut p,
        "textbox \"Text editor for creating content\" [ref_1]\nbutton \"Post\" [ref_16]\nbutton \"Confirm\" [ref_2]\nbutton \"Schedule\" [ref_21]",
    );
    p.tabs.insert(5, "https://www.linkedin.com/feed/".into());
    p.typed
        .push("working from my phone more and more lately".into());
    with_pages(|pages| pages.insert(a.id.clone(), p.clone()));
    let click = |r: &str| json!({ "action": "left_click", "ref": r, "tabId": 5 });
    let tool = t("computer");
    assert!(!same_send_allowed(&a, &tool, &click("ref_2")));
    note_allowed_send(&a, &tool, &click("ref_16"));
    // Julian's Post, Confirm, Schedule: one card.
    assert!(same_send_allowed(&a, &tool, &click("ref_2")));
    assert!(same_send_allowed(&a, &tool, &click("ref_21")));
    // Other words typed: a new send, it asks again.
    with_pages(|pages| {
        pages.get_mut(&a.id).unwrap().typed = vec!["a different post".into()];
    });
    assert!(!same_send_allowed(&a, &tool, &click("ref_21")));
    // Another agent never rides on it.
    let mut b = agent();
    b.id = "same-send-other".into();
    with_pages(|pages| pages.insert(b.id.clone(), p.clone()));
    assert!(!same_send_allowed(&b, &tool, &click("ref_21")));
}

/// Julian, 2026-11-16: an agent working on X in his Chrome hit X's chat
/// passcode and got an agents'-browser sign-in. The app knows which browser
/// it was in from its own page memory.
#[test]
fn the_app_knows_a_site_is_open_in_the_users_chrome() {
    let id = "in-chrome-test";
    let mut p = Page::default();
    p.tabs.insert(3, "https://x.com/messages/compose".into());
    with_pages(|pages| pages.insert(user_chrome_key(id), p));
    assert!(in_users_chrome_on(id, "x.com"));
    assert!(!in_users_chrome_on(id, "linkedin.com"));
    assert!(!in_users_chrome_on("someone-else", "x.com"));
}

#[test]
fn bold_uploads_the_agents_own_pictures_and_asks_for_anything_else() {
    // The agents folder is process-wide: another test moving it between
    // these lines and the gate's own lookup made this fail under load.
    let _store = crate::agents::store::tests_lock();
    let home = crate::agents::store::agent_home("ops").unwrap();
    let own = |f: &str| home.join(f).to_string_lossy().into_owned();
    let up = |level, paths: Vec<String>| {
        at(
            level,
            "file_upload",
            json!({"paths": paths, "ref": "ref_2"}),
        )
    };
    // Its own post picture and video: no card at Bold.
    assert_eq!(
        up(Level::GoHard, vec![own("scheduled/w47/1-mon16-nate.png")]),
        Gate::Allow
    );
    assert_eq!(up(Level::GoHard, vec![own("clip.MP4")]), Gate::Allow);
    // The user's own files, a non-picture, a way out of its folder, a key: ask.
    assert_eq!(
        up(
            Level::GoHard,
            vec!["/Users/fictional/Desktop/post1.png".into()]
        ),
        Gate::Ask
    );
    assert_eq!(up(Level::GoHard, vec![own("notes/memory.md")]), Gate::Ask);
    assert_eq!(up(Level::GoHard, vec![own("../other/x.png")]), Gate::Ask);
    assert_eq!(up(Level::GoHard, vec![own(".ssh/id.png")]), Gate::Ask);
    // One stranger in the list asks for the lot; no path at all asks.
    assert_eq!(
        up(
            Level::GoHard,
            vec![own("a.png"), "/Users/fictional/b.png".into()]
        ),
        Gate::Ask
    );
    assert_eq!(
        at(Level::GoHard, "upload_image", json!({"imageId": "s1"})),
        Gate::Ask
    );
    // Below Bold, uploads always ask.
    assert_eq!(up(Level::Judgement, vec![own("a.png")]), Gate::Ask);
}

/// Observed (Julian, 2026-11-17, Play Console): an email typed into a form,
/// then a radio button clicked by position, raised "Goes out under your
/// name, exactly: “<the email>”" under the exact-text rule. Now the agent is
/// told to click by ref first; a labelled radio runs, a labelled Send still
/// asks, and the exact-text rule off or nothing typed is not this case.
#[test]
fn a_click_by_position_after_typing_asks_the_agent_to_click_by_ref() {
    let a = agent();
    let mut p = Page::default();
    p.tabs
        .insert(3, "https://console.example.com/app/content-rating".into());
    let typed = json!({ "action": "type", "text": "me@example.com", "tabId": 3 });
    let click = json!({ "action": "left_click", "coordinate": [114, 683], "tabId": 3 });
    // Nothing typed yet: a plain click, not this case.
    assert!(!only_unlabelled_click(
        Level::GoHard,
        &a,
        true,
        "computer",
        &click,
        &p
    ));
    on_call(&mut p, "computer", &typed);
    assert!(only_unlabelled_click(
        Level::GoHard,
        &a,
        true,
        "computer",
        &click,
        &p
    ));
    assert!(only_unlabelled_click(
        Level::FullSend,
        &a,
        true,
        "computer",
        &click,
        &p
    ));
    // Without the exact-text rule the click already runs.
    assert!(!only_unlabelled_click(
        Level::GoHard,
        &a,
        false,
        "computer",
        &click,
        &p
    ));
    // At "Check with me often" the click asks anyway.
    assert!(!only_unlabelled_click(
        Level::Often,
        &a,
        true,
        "computer",
        &click,
        &p
    ));
    // By ref: a radio runs at Go hard; a Send button is a real send.
    on_answer(
        &mut p,
        "radio \"All Other App Types\" [ref_1]\nbutton \"Send\" [ref_2]",
    );
    let by_ref = |r: &str| json!({ "action": "left_click", "ref": r, "tabId": 3 });
    assert!(!outward_step_on(&a, "computer", &by_ref("ref_1"), &p));
    assert!(outward_step_on(&a, "computer", &by_ref("ref_2"), &p));
    assert!(!only_unlabelled_click(
        Level::GoHard,
        &a,
        true,
        "computer",
        &by_ref("ref_2"),
        &p
    ));
}

/// Julian, 2026-11-17, at Bold with the exact-text rule: clicks by position
/// on a radio and Next after typing raised "goes out under your name" cards.
/// Once the control under the point is known, it is judged by its label:
/// a radio or Next runs, a Post still asks.
#[test]
fn a_click_found_under_the_point_is_judged_by_what_it_clicks() {
    let a = agent();
    let mut p = Page::default();
    p.tabs
        .insert(3, "https://console.example.com/app/content-rating".into());
    on_call(
        &mut p,
        "computer",
        &json!({ "action": "type", "text": "me@example.com", "tabId": 3 }),
    );
    let click = json!({ "action": "left_click", "ref": "@point", "tabId": 3 });
    for (label, sends) in [
        ("radio \"Yes\"", false),
        ("button \"Next\"", false),
        ("checkbox \"I agree\"", false),
        ("button \"Save\"", false),
        ("button \"Post\"", true),
        ("button \"Send\"", true),
    ] {
        p.refs.insert("@point".into(), label.into());
        assert_eq!(
            outward_step_on(&a, "computer", &click, &p),
            sends,
            "{label}"
        );
        assert_eq!(
            decide(Level::GoHard, &a, "computer", &click, &p) == Gate::Allow,
            !sends,
            "{label}"
        );
    }
}

/// Julian, 2026-11-18: Social Posts' Walmart video sat in a project folder,
/// so at "Go hard" its upload asked on top of the post's own card. Pictures
/// and videos in the projects folder are the agent's work; a PDF there, a
/// file elsewhere, a climb out or a projects folder that is the whole home
/// still ask.
#[test]
fn project_pictures_and_videos_upload_without_a_second_card() {
    let base = std::env::temp_dir().join(format!("own-media-{}", std::process::id()));
    let home = base.join("agent-home");
    let projects = base.join("ShipStudio");
    let other = base.join("Documents");
    for d in [&home, &projects.join("acme/scratch"), &other] {
        std::fs::create_dir_all(d).unwrap();
    }
    let file = |dir: &std::path::Path, name: &str| {
        let p = dir.join(name);
        std::fs::write(&p, b"x").unwrap();
        p.to_string_lossy().to_string()
    };
    let video = file(&projects.join("acme/scratch"), "walmart.mp4");
    let pdf_in_project = file(&projects.join("acme"), "contract.pdf");
    let pdf_in_home = file(&home, "deck.pdf");
    let elsewhere = file(&other, "photo.jpg");
    let up = |p: &str| json!({ "paths": [p] });

    assert!(own_media_in(&home, Some(&projects), &up(&video)));
    assert!(own_media_in(&home, Some(&projects), &up(&pdf_in_home)));
    assert!(!own_media_in(&home, Some(&projects), &up(&pdf_in_project)));
    assert!(!own_media_in(&home, Some(&projects), &up(&elsewhere)));
    assert!(!own_media_in(&home, None, &up(&video)));
    let climb = format!("{}/acme/../../Documents/photo.jpg", projects.display());
    assert!(!own_media_in(&home, Some(&projects), &up(&climb)));
    // One file outside spoils the lot.
    assert!(!own_media_in(
        &home,
        Some(&projects),
        &json!({ "paths": [video, elsewhere] })
    ));
    // A projects folder that is the user's whole home counts for nothing.
    let user_home = dirs::home_dir().unwrap();
    let in_home = user_home.join(format!(".own-media-{}.jpg", std::process::id()));
    std::fs::write(&in_home, b"x").unwrap();
    assert!(!own_media_in(
        &home,
        Some(&user_home),
        &up(&in_home.to_string_lossy())
    ));
    let _ = std::fs::remove_file(&in_home);
    let _ = std::fs::remove_dir_all(&base);
}

/// Julian, 2026-11-18: at Unleashed, opening a LinkedIn post, a Slack
/// message or a GitHub issue asked "goes out under your name". Links, tabs
/// and rows open things; the send stays a button.
#[test]
fn opening_things_never_asks_but_the_send_button_still_does() {
    for l in [
        "link \"Post by Ada: shipping today\"",
        "link \"Merge conflicts in settings\"",
        "link \"Share\"",
        "link \"Buy now\"",
        "row \"Reply from Bradford\"",
        "tab \"Comments\"",
        "heading \"Order #1234\"",
    ] {
        for level in [Level::GoHard, Level::FullSend] {
            assert!(final_submit(l, level).is_none(), "{l}");
        }
    }
    assert!(final_submit("button \"Post\"", Level::GoHard).is_some());
    assert!(final_submit("button \"Merge pull request\"", Level::GoHard).is_some());
    assert!(final_submit("button \"Buy now\"", Level::FullSend).is_some());
    assert!(final_submit("textbox \"Post\"", Level::GoHard).is_none());
}

/// Replay of the 50 most recent browser cards raised in the user's Chrome
/// (2026-11-18/19), titles and inputs as recorded. Prints each decision.
#[test]
#[ignore]
fn replay_recorded_cards() {
    let cards: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(std::env::var("REPLAY").unwrap()).unwrap())
            .unwrap();
    for level in [Level::GoHard, Level::FullSend] {
        let mut asks = 0;
        for c in &cards {
            let name = c["t"].as_str().unwrap();
            let input = c["in"].clone();
            let title = c["title"].as_str().unwrap();
            let host = title.rsplit(" on ").next().unwrap_or("");
            let mut p = Page {
                url: Some(format!("https://{host}/")),
                ..Page::default()
            };
            if let Some(r) = input.get("ref").and_then(|v| v.as_str()) {
                if let Some(l) = title.split('“').nth(1).and_then(|s| s.split('”').next()) {
                    p.refs.insert(r.to_string(), format!("button \"{l}\""));
                }
            }
            let g = gate_user_chrome_with(true, level, &agent(), name, &input, false, &p);
            if g != Gate::Allow {
                asks += 1;
            }
            println!("{level:?} {:?} | {title}", g);
        }
        println!("{level:?}: {asks}/{} not allowed", cards.len());
    }
}

#[test]
fn opening_a_thread_never_asks_but_its_send_does() {
    for open in [
        "button \"1 reply\"",
        "button \"12 replies\"",
        "button \"Reply in thread\"",
    ] {
        assert_eq!(final_submit(open, Level::GoHard), None, "{open}");
    }
    for send in [
        "button \"Send now\"",
        "button \"Reply\"",
        "button \"Reply all\"",
    ] {
        assert!(final_submit(send, Level::GoHard).is_some(), "{send}");
    }
}

#[test]
fn unleashed_lets_recorded_chrome_clicks_through() {
    // Opening a LinkedIn post, a Slack message, a GitHub issue: clicks by
    // position and by label that don't pay or delete for good.
    let input = json!({"x": 800, "y": 110, "tab": 1});
    for host in ["linkedin.com", "app.slack.com", "github.com"] {
        let p = Page {
            url: Some(format!("https://{host}/")),
            ..Page::default()
        };
        assert_eq!(
            gate_user_chrome_with(true, Level::FullSend, &agent(), "click", &input, false, &p),
            Gate::Allow,
            "{host}"
        );
    }
}

/// An allowed send (Post, then Confirm and Schedule) with its page memory.
fn allowed_send(id: &str) -> (Agent, String) {
    let mut a = agent();
    a.id = id.into();
    let mut p = Page::default();
    on_answer(
        &mut p,
        "textbox \"Text editor for creating content\" [ref_1]\nbutton \"Post\" [ref_16]\nbutton \"Confirm\" [ref_2]\nbutton \"Schedule\" [ref_21]\nbutton \"Delete project\" [ref_30]\nbutton \"Delete account\" [ref_31]\nbutton \"Invite\" [ref_32]\nbutton \"Enviar\" [ref_33]\nbutton \"Share\" [ref_34]\nbutton \"Merge\" [ref_35]\nbutton \"Publish\" [ref_60]\nbutton \"Send\" [ref_61]\nbutton \"Reply\" [ref_62]\nbutton \"Send now\" [ref_63]\nbutton \"Post now\" [ref_64]\nbutton \"Send it\" [ref_65]",
    );
    p.tabs.insert(5, "https://www.linkedin.com/feed/".into());
    on_typed(
        &mut p,
        "form_input",
        &json!({ "value": "see you all there" }),
    );
    with_pages(|pages| pages.insert(a.id.clone(), p));
    note_allowed_send(&a, &t("computer"), &click_ref("ref_16"));
    (a, t("computer"))
}

fn click_ref(r: &str) -> Value {
    json!({ "action": "left_click", "ref": r, "tabId": 5 })
}

fn on_page(a: &Agent, f: impl FnOnce(&mut Page)) {
    with_pages(|pages| f(pages.get_mut(&a.id).unwrap()));
}

#[test]
fn an_allowed_send_survives_a_date_typed_and_the_page_changing_its_own_address() {
    let (a, tool) = allowed_send("send-date");
    on_page(&a, |p| {
        on_typed(p, "form_input", &json!({ "value": "Nov 25, 2026" }));
        on_typed(p, "form_input", &json!({ "value": "11:00 AM" }));
        // The page moving itself (a composer's own address): not the agent.
        p.tabs
            .insert(5, "https://www.linkedin.com/feed/?shareActive=true".into());
    });
    assert!(same_send_allowed(&a, &tool, &click_ref("ref_2")));
    assert!(same_send_allowed(&a, &tool, &click_ref("ref_21")));
}

#[test]
fn an_allowed_send_ends_when_the_agent_types_again_even_the_same_words() {
    let (a, tool) = allowed_send("send-retype");
    // The same words to a second person, typed again: asks.
    on_page(&a, |p| {
        on_typed(p, "form_input", &json!({ "value": "see you all there" }));
    });
    assert!(!same_send_allowed(&a, &tool, &click_ref("ref_21")));
    let (b, tool) = allowed_send("send-retype-keys");
    on_page(&b, |p| {
        on_typed(
            p,
            "computer",
            &json!({ "action": "type", "text": "see you all there" }),
        );
    });
    assert!(!same_send_allowed(&b, &tool, &click_ref("ref_21")));
}

#[test]
fn an_allowed_send_ends_on_navigate_and_open() {
    let (a, tool) = allowed_send("send-nav");
    on_page(&a, |p| {
        on_typed(
            p,
            "navigate",
            &json!({ "url": "https://www.linkedin.com/feed/" }),
        );
        on_typed(p, "form_input", &json!({ "value": "see you all there" }));
    });
    assert!(!same_send_allowed(&a, &tool, &click_ref("ref_21")));
    let (b, tool) = allowed_send("send-open");
    on_page(&b, |p| on_typed(p, "tabs_create_mcp", &json!({})));
    assert!(!same_send_allowed(&b, &tool, &click_ref("ref_21")));
}

#[test]
fn the_same_control_repeats_for_a_minute_only() {
    let (a, tool) = allowed_send("send-repeat");
    // A click retried after a hiccup.
    assert!(same_send_allowed(&a, &tool, &click_ref("ref_16")));
    assert!(same_send_allowed(&a, &tool, &click_ref("ref_2")));
    assert!(same_send_allowed(&a, &tool, &click_ref("ref_2")));
    // A minute on, a second Post asks.
    ALLOWED_SENDS
        .lock()
        .unwrap()
        .iter_mut()
        .filter(|s| s.agent == a.id)
        .for_each(|s| s.seen.iter_mut().for_each(|(_, at)| *at -= RETRY_MS + 1));
    assert!(!same_send_allowed(&a, &tool, &click_ref("ref_16")));
    assert!(!same_send_allowed(&a, &tool, &click_ref("ref_2")));
}

#[test]
fn an_allowed_send_covers_only_its_own_tab_and_site() {
    let (a, tool) = allowed_send("send-tab");
    let other_tab = json!({ "action": "left_click", "ref": "ref_21", "tabId": 6 });
    on_page(&a, |p| {
        p.tabs.insert(6, "https://www.linkedin.com/feed/".into());
    });
    assert!(!same_send_allowed(&a, &tool, &other_tab));
    on_page(&a, |p| {
        p.tabs.insert(5, "https://x.com/compose".into());
    });
    assert!(!same_send_allowed(&a, &tool, &click_ref("ref_21")));
}

#[test]
fn an_allowed_post_covers_only_steps_of_getting_words_out() {
    let (a, tool) = allowed_send("send-labels");
    for r in ["ref_30", "ref_31", "ref_32", "ref_33", "ref_34", "ref_35"] {
        // Delete project, Delete account, Invite, a label in another
        // language, Share, Merge: each asks.
        assert!(!same_send_allowed(&a, &tool, &click_ref(r)), "{r}");
    }
    // Eight different controls per Allow (the Post itself counts): the
    // ninth asks.
    for r in [
        "ref_2", "ref_21", "ref_60", "ref_61", "ref_62", "ref_63", "ref_64",
    ] {
        assert!(same_send_allowed(&a, &tool, &click_ref(r)), "{r}");
    }
    assert!(!same_send_allowed(&a, &tool, &click_ref("ref_65")));
    assert!(continues_a_send(None));
    assert!(continues_a_send(Some("button")));
    assert!(continues_a_send(Some("button \"Post now\"")));
    assert!(!continues_a_send(Some("button \"Post to anyone\"")));
    assert!(!continues_a_send(Some("button \"Delete post\"")));
}

/// The agents' browser names its tab `tab`, not `tabId`.
#[test]
fn an_allowed_send_in_a_live_browser_is_told_by_its_tab() {
    let mut a = agent();
    a.id = "send-live".into();
    let key = agents_key(&a.id);
    let mut p = Page::default();
    on_answer(
        &mut p,
        "button \"Post\" [ref_16]\nbutton \"Confirm\" [ref_2]\nbutton \"Delete project\" [ref_30]",
    );
    p.tabs.insert(5, "https://www.linkedin.com/feed/".into());
    p.tabs.insert(6, "https://www.linkedin.com/feed/".into());
    on_typed(
        &mut p,
        "form_input",
        &json!({ "value": "see you all there" }),
    );
    with_pages(|pages| pages.insert(key.clone(), p));
    let tool = format!("{AGENTS_SERVER}click");
    let click = |r: &str, tab: u64| json!({ "ref": r, "tab": tab });
    note_allowed_send(&a, &tool, &click("ref_16", 5));
    assert!(same_send_allowed(&a, &tool, &click("ref_2", 5)));
    assert!(!same_send_allowed(&a, &tool, &click("ref_30", 5)));
    assert!(!same_send_allowed(&a, &tool, &click("ref_2", 6)));
}

/// Your Chrome clicks by position: each is looked at raw, then again with
/// the label found under it. Post, Confirm, Schedule that way is one card.
#[test]
fn three_position_clicks_in_your_chrome_are_one_card() {
    let mut a = agent();
    a.id = "send-points".into();
    let key = user_chrome_key(&a.id);
    let mut p = Page::default();
    p.tabs.insert(5, "https://www.linkedin.com/feed/".into());
    on_typed(
        &mut p,
        "form_input",
        &json!({ "value": "see you all there" }),
    );
    with_pages(|pages| pages.insert(key.clone(), p));
    let label = |l: &str| {
        with_pages(|pages| {
            pages
                .get_mut(&key)
                .unwrap()
                .refs
                .insert("@point".into(), format!("button \"{l}\""));
        })
    };
    let tool = format!("{USER_CHROME_SERVER}click");
    let raw = |x: u32| json!({ "x": x, "y": 40, "tab": 5 });
    let labelled = json!({ "ref": "@point", "tab": 5 });
    label("Post");
    note_allowed_send(&a, &tool, &labelled);
    for (x, l) in [(100, "Confirm"), (200, "Schedule")] {
        assert!(same_send_allowed(&a, &tool, &raw(x)), "raw {l}");
        label(l);
        assert!(same_send_allowed(&a, &tool, &labelled), "labelled {l}");
    }
}
