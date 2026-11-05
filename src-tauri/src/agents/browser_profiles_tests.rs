use super::*;
use serde_json::json;

// Fictional browsers and accounts.
fn b(name: &str) -> Connected {
    Connected {
        id: format!("id-{name}"),
        name: name.into(),
    }
}

fn known(browser: &str, account: &str) -> Remembered {
    Remembered {
        browser: browser.into(),
        account: Some(account.into()),
        at: 0,
    }
}

#[test]
fn the_answer_is_read_in_every_shape_seen_or_likely() {
    assert!(parse_browsers("[]").is_empty());
    assert!(parse_browsers("not json").is_empty());
    assert_eq!(
        parse_browsers(r#"["Browser 1"]"#),
        vec![Connected {
            id: "Browser 1".into(),
            name: "Browser 1".into()
        }]
    );
    let list =
        parse_browsers(r#"[{"id": 7, "name": "Browser 1"}, {"deviceId": "abc", "label": "Work"}]"#);
    assert_eq!(
        list[0],
        Connected {
            id: "7".into(),
            name: "Browser 1".into()
        }
    );
    assert_eq!(
        list[1],
        Connected {
            id: "abc".into(),
            name: "Work".into()
        }
    );
    assert_eq!(
        parse_browsers(r#"{"browsers": [{"name": "Browser 2"}]}"#)[0].id,
        "Browser 2"
    );
    // Nothing usable in it: skipped, not invented.
    assert!(parse_browsers(r#"[{"connected": true}, 3]"#).is_empty());
}

#[test]
fn it_starts_where_the_site_was_last_found() {
    let two = [b("Browser 1"), b("Browser 2")];
    let r = known("Browser 2", "sam@work.example");
    assert_eq!(
        pick(&two, Some(&r), &[]),
        Pick::Use {
            browser: b("Browser 2"),
            remembered: Some(r.clone()),
            select: true
        }
    );
    // The only one connected is the remembered one: no select needed.
    assert!(matches!(
        pick(&[b("Browser 2")], Some(&r), &[]),
        Pick::Use { select: false, .. }
    ));
    // Remembered, but it isn't connected now: look in what is.
    assert_eq!(
        pick(&[b("Browser 1")], Some(&r), &[]),
        Pick::TryEach {
            browsers: vec![b("Browser 1")],
            missing: Some(r.clone())
        }
    );
}

#[test]
fn with_nothing_remembered_it_tries_each_then_asks_to_bring_one_forward() {
    let two = [b("Browser 1"), b("Browser 2")];
    assert!(matches!(
        pick(&[b("Browser 1")], None, &[]),
        Pick::Use {
            select: false,
            remembered: None,
            ..
        }
    ));
    assert_eq!(
        pick(&two, None, &[]),
        Pick::TryEach {
            browsers: two.to_vec(),
            missing: None
        }
    );
    // Looked in one already (by name or id): the other one.
    assert!(matches!(
        pick(&two, None, &["browser 1".into()]),
        Pick::Use { ref browser, select: true, .. } if browser.name == "Browser 2"
    ));
    assert!(matches!(
        pick(&two, None, &["id-Browser 1".into()]),
        Pick::Use { .. }
    ));
    // Every connected one was the wrong account, or none is connected.
    assert_eq!(
        pick(&two, None, &["Browser 1".into(), "Browser 2".into()]),
        Pick::BringToFront { remembered: None }
    );
    assert_eq!(
        pick(&[], None, &[]),
        Pick::BringToFront { remembered: None }
    );
}

#[test]
fn the_steps_say_check_the_page_switch_then_one_card_never_a_login() {
    let g = guidance("www.figma.com", Some(&[b("Browser 1")]), None);
    assert!(g.contains("Only \"Browser 1\" is connected"));
    assert!(g.contains("read which account the page shows"));
    assert!(g.contains("select_browser / switch_browser"));
    assert!(g.contains("ask_bring_browser_to_front"));
    assert!(g.contains("never request_login"));
    assert!(g.contains("remember_browser_account"));
    let r = known("Browser 2", "sam@work.example");
    let g = guidance(
        "www.figma.com",
        Some(&[b("Browser 1"), b("Browser 2")]),
        Some(&r),
    );
    assert!(g.contains("as sam@work.example in \"Browser 2\": select_browser it first"));
    assert!(guidance("www.figma.com", None, None).contains("call list_connected_browsers"));
}

#[test]
fn only_its_own_sites_are_remembered_and_never_for_outside_text() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let mut a: Agent = serde_json::from_value(json!({
        "id": "designer", "name": "Designer", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap();
    a.engine = super::super::engine::Engine::Claude;
    a.reach.browser_sites = vec!["www.figma.com".into()];
    // The team's browser is off: nothing is remembered.
    let args = json!({"site": "figma.com", "browser": "Browser 2", "account": "sam@work.example"});
    assert!(remember(&a, &args, false).is_err());
    std::fs::write(dir.path().join("browser.json"), r#"{"enabled": true}"#).unwrap();
    assert!(remember(&a, &args, true).is_err(), "outside text");
    assert!(remember(
        &a,
        &json!({"site": "evil.example", "browser": "Browser 1"}),
        false
    )
    .is_err());
    assert!(remember(&a, &args, false).unwrap().contains("Browser 2"));
    assert_eq!(
        remembered("www.figma.com/").map(|r| r.browser),
        Some("Browser 2".into())
    );
    assert_eq!(
        for_reach(&a)[0].account.as_deref(),
        Some("sam@work.example")
    );
    forget("figma.com").unwrap();
    assert!(for_reach(&a).is_empty());
    store::set_root_for_tests(None);
}

#[test]
fn the_card_names_the_account_and_is_one_per_site_and_account() {
    let f = Front {
        site: "www.figma.com".into(),
        account: Some("sam@work.example".into()),
    };
    assert_eq!(
        front_title(&f),
        "Bring your sam@work.example Chrome window to the front so I can use it"
    );
    assert!(same_front(
        &f,
        &Front {
            site: "figma.com".into(),
            account: Some("SAM@work.example".into())
        }
    ));
    assert!(!same_front(
        &f,
        &Front {
            site: "figma.com".into(),
            account: None
        }
    ));
}
