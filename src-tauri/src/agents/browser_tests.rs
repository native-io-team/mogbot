use super::*;
use serde_json::json;

fn with_root<F: FnOnce()>(f: F) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

// Fictional agents; the sites are the real services' hosts.
fn agent(engine: Engine, sites: &[&str], off: bool) -> Agent {
    let mut a: Agent = serde_json::from_value(json!({
        "id": "designer", "name": "Designer", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap();
    a.engine = engine;
    a.reach.browser_sites = sites.iter().map(|s| s.to_string()).collect();
    a.reach.browser_off = off;
    a
}

const NAV: &str = "mcp__claude-in-chrome__navigate";

#[test]
fn only_a_switched_on_team_and_its_own_turns_get_the_browser() {
    let a = agent(Engine::Claude, &[], false);
    assert!(allowed(true, &a, false));
    // The team's switch is off until it's set up.
    assert!(!allowed(false, &a, false));
    // Never for text from outside (a "When…" routine, a tainted message).
    assert!(!allowed(true, &a, true));
    // Taken away from this agent.
    assert!(!allowed(true, &agent(Engine::Claude, &[], true), false));
    // Codex has no browser.
    assert!(!allowed(true, &agent(Engine::Codex, &[], false), false));
}

#[test]
fn reading_is_free_on_its_sites_and_everything_else_asks() {
    let a = agent(Engine::Claude, &["www.figma.com"], false);
    let g = |tool: &str, input: serde_json::Value| gate_with(true, &a, tool, &input, false);
    assert_eq!(
        g(NAV, json!({"url": "https://www.figma.com/files"})),
        Gate::Allow
    );
    assert_eq!(
        g(NAV, json!({"url": "https://figma.com/design/abc"})),
        Gate::Allow
    );
    // Another site: asks (a page could try to carry data there).
    assert_eq!(
        g(NAV, json!({"url": "https://evil.example/?q=secret"})),
        Gate::Ask
    );
    assert_eq!(
        g(NAV, json!({"url": "https://figma.com.evil.example/"})),
        Gate::Ask
    );
    assert_eq!(g(NAV, json!({"url": "javascript:alert(1)"})), Gate::Ask);
    assert_eq!(g(NAV, json!({"url": "back"})), Gate::Allow);
    for tool in [
        "get_page_text",
        "read_page",
        "find",
        "tabs_context_mcp",
        "tabs_create_mcp",
    ] {
        assert_eq!(
            g(&format!("{SERVER}{tool}"), json!({})),
            Gate::Allow,
            "{tool}"
        );
    }
    assert_eq!(
        g(
            "mcp__claude-in-chrome__computer",
            json!({"action": "screenshot"})
        ),
        Gate::Allow
    );
    // Anything that acts: the Allow card.
    assert_eq!(
        g(
            "mcp__claude-in-chrome__computer",
            json!({"action": "left_click"})
        ),
        Gate::Ask
    );
    assert_eq!(
        g(
            "mcp__claude-in-chrome__computer",
            json!({"action": "type", "text": "hi"})
        ),
        Gate::Ask
    );
    for tool in [
        "form_input",
        "javascript_tool",
        "file_upload",
        "upload_image",
        "shortcuts_execute",
        "browser_batch",
        "something_new",
    ] {
        assert_eq!(
            g(&format!("{SERVER}{tool}"), json!({})),
            Gate::Ask,
            "{tool}"
        );
    }
    assert_eq!(g("Bash", json!({})), Gate::NotBrowser);
    assert_eq!(g("mcp__figma__get_file", json!({})), Gate::NotBrowser);
}

#[test]
fn a_url_inside_a_url_or_a_new_tab_elsewhere_or_a_gif_export_asks() {
    let a = agent(Engine::Claude, &["www.linkedin.com"], false);
    let g = |tool: &str, input: serde_json::Value| gate_with(true, &a, tool, &input, false);
    // Its own site's redirect endpoint would carry page data off-site.
    for url in [
        "https://www.linkedin.com/redir/redirect?url=https://evil.example/?d=x",
        "https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fevil.example",
        "https://www.linkedin.com/redir/redirect?url=https%253A%252F%252Fevil.example",
        "https://www.linkedin.com/redir/redirect?url=//evil.example",
        "https://www.linkedin.com/go/https://evil.example/",
        "https://www.linkedin.com/feed/#u=https://evil.example",
    ] {
        assert_eq!(g(NAV, json!({ "url": url })), Gate::Ask, "{url}");
    }
    assert_eq!(
        g(
            NAV,
            json!({"url": "https://www.linkedin.com/search/results/all/?keywords=design"})
        ),
        Gate::Allow
    );
    // A new tab is a look, unless it opens a URL elsewhere.
    let tab = format!("{SERVER}tabs_create_mcp");
    assert_eq!(g(&tab, json!({})), Gate::Allow);
    assert_eq!(g(&tab, json!({"url": "https://evil.example/"})), Gate::Ask);
    assert_eq!(
        g(&tab, json!({"url": "https://www.linkedin.com/feed/"})),
        Gate::Allow
    );
    // Recording looks; exporting can upload it to a page.
    let gif = format!("{SERVER}gif_creator");
    assert_eq!(g(&gif, json!({"action": "start_recording"})), Gate::Allow);
    assert_eq!(
        g(&gif, json!({"action": "export", "download": true})),
        Gate::Ask
    );
    assert_eq!(g(&gif, json!({})), Gate::Ask);
}

#[test]
fn an_outside_turn_or_a_switched_off_team_is_refused_even_reads() {
    let a = agent(Engine::Claude, &["www.figma.com"], false);
    let read = json!({"url": "https://www.figma.com/"});
    assert!(
        matches!(gate_with(true, &a, NAV, &read, true), Gate::Refuse(w) if w.contains("from outside"))
    );
    assert!(
        matches!(gate_with(false, &a, NAV, &read, false), Gate::Refuse(w) if w.contains("request_login"))
    );
}

#[test]
fn browsers_are_counted_from_the_tool_answer() {
    // `[]` is what 2.1.318 answered with the extension signed out.
    assert_eq!(count_browsers("[]"), 0);
    assert_eq!(count_browsers(r#"[{"id":"b1","name":"Chrome"}]"#), 1);
    assert_eq!(count_browsers("Browser extension is not connected."), 0);
}

#[test]
fn the_card_walks_through_what_is_missing_in_order() {
    let none = steps(&Facts::default());
    assert_eq!(none.iter().filter(|s| s.done).count(), 0);
    assert_eq!(none[1].open_url.as_deref(), Some(INSTALL_URL));

    let api_key = steps(&Facts {
        claude_installed: true,
        claude_ai: false,
        ..Default::default()
    });
    assert!(!api_key[0].done && api_key[0].detail.contains("API key"));

    let not_signed = steps(&Facts {
        claude_installed: true,
        claude_ai: true,
        account: Some("sam@example.com".into()),
        extension_installed: true,
        browsers: Some(0),
    });
    assert!(not_signed[0].done && not_signed[1].done && !not_signed[2].done);
    // It names the account the extension has to use.
    assert!(not_signed[2].detail.contains("sam@example.com"));
    assert!(not_signed[1].open_url.is_none());

    let ready = steps(&Facts {
        claude_installed: true,
        claude_ai: true,
        account: None,
        extension_installed: false,
        browsers: Some(1),
    });
    assert!(ready.iter().all(|s| s.done));
}

#[test]
fn signed_in_is_only_said_when_the_account_page_stayed_put() {
    let at = |url: &str, title: &str| Landed {
        url: url.into(),
        title: title.into(),
    };
    let gh = "github.com";
    assert_eq!(
        signed_in(
            gh,
            &at("https://github.com/settings/profile", "Your profile")
        ),
        Some(true)
    );
    assert_eq!(
        signed_in(
            gh,
            &at(
                "https://github.com/login?return_to=%2Fsettings%2Fprofile",
                "Sign in to GitHub"
            )
        ),
        Some(false)
    );
    assert_eq!(
        signed_in(
            "mail.google.com",
            &at("https://accounts.google.com/v3/signin/identifier", "Gmail")
        ),
        Some(false)
    );
    assert_eq!(
        signed_in(
            "www.linkedin.com",
            &at("https://www.linkedin.com/authwall?x=1", "LinkedIn")
        ),
        Some(false)
    );
    // Somewhere else entirely: can't be told.
    assert_eq!(signed_in(gh, &at("https://example.com/", "Example")), None);
    assert_eq!(
        probe_url("github"),
        Some("https://github.com/settings/profile")
    );
    assert_eq!(probe_url("bankline"), None);
}

#[test]
fn tabs_are_read_from_either_shape() {
    assert_eq!(find_tab(r#"{"tabId": 412}"#), Some(412));
    assert_eq!(find_tab("Created new tab. Tab ID: 77"), Some(77));
    assert_eq!(find_tab("nothing here"), None);
    let ctx = r#"{"availableTabs":[{"tabId":1,"title":"Inbox","url":"https://mail.google.com/"},{"tabId":77,"title":"Your profile","url":"https://github.com/settings/profile"}]}"#;
    let l = landed_in(ctx, Some(77)).unwrap();
    assert_eq!(l.url, "https://github.com/settings/profile");
    assert_eq!(landed_in("not json", None), None);
}

#[test]
fn the_switch_starts_off_and_an_old_browser_choice_keeps_it_on() {
    with_root(|| {
        assert!(!team_enabled());
        let a = store::create(store::NewAgent {
            name: "Social".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        // Chosen on a login card in an older build.
        give_site(&a.id, "x.com").unwrap();
        assert!(team_enabled());
        change(|s| s.enabled = false).unwrap();
        assert!(!team_enabled(), "a kept choice wins over the upgrade");
    });
}

#[test]
fn an_action_card_says_exactly_what_where_and_as_whom() {
    let (t, d) = card_for(
        "mcp__claude-in-chrome__computer",
        &json!({"action": "type", "text": "See you at 3"}),
        Some("mail.google.com"),
        Some("sam@example.com"),
    )
    .unwrap();
    assert_eq!(t, "Type in your browser");
    assert!(d.contains("“See you at 3”"));
    assert!(d.contains("On mail.google.com, as sam@example.com."));
    let (_, d) = card_for(
        "mcp__claude-in-chrome__form_input",
        &json!({"ref": "ref_4", "value": "Q3 numbers"}),
        Some("app.slack.com"),
        None,
    )
    .unwrap();
    assert!(d.contains("“Q3 numbers”"));
    assert!(d.contains("as whoever is signed in there"));
    let (t, _) = card_for(
        "mcp__claude-in-chrome__computer",
        &json!({"action": "left_click", "coordinate": [10, 20]}),
        None,
        None,
    )
    .unwrap();
    assert_eq!(t, "Click in your browser");
    assert!(card_for("Bash", &json!({}), None, None).is_none());
}
