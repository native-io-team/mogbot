use super::*;
use crate::agents::store;
use serde_json::json;

fn args(extra: Value) -> Value {
    let mut base = json!({ "title": "October summary", "summary": "One page, every invoice." });
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) {
        base.extend(extra);
    }
    base
}

fn err(v: Value) -> String {
    parse(&v).unwrap_err()
}

// ---------------------------------------------------------------- parsing

#[test]
fn a_title_and_a_summary_are_all_it_needs() {
    let draft = parse(&args(json!({}))).unwrap();
    assert_eq!(draft.title, "October summary");
    assert!(draft.items.is_empty() && draft.checked.is_empty() && draft.not_verified.is_empty());
    assert!(err(json!({ "summary": "x" })).contains("`title` is required"));
    assert!(err(json!({ "title": "x", "summary": "  " })).contains("`summary` is required"));
    assert!(err(json!({ "title": 3, "summary": "x" })).contains("must be text"));
}

#[test]
fn too_much_is_refused_never_trimmed() {
    let long = |n: usize| "a".repeat(n);
    assert!(err(args(json!({ "title": long(MAX_TITLE + 1) }))).contains("title"));
    assert!(parse(&args(json!({ "title": long(MAX_TITLE) }))).is_ok());
    assert!(err(args(json!({ "summary": long(MAX_SUMMARY + 1) }))).contains("summary"));
    // A "not verified" line cut short would hide what matters: refused.
    let e = err(args(json!({ "not_verified": [long(MAX_LINE + 1)] })));
    assert!(e.contains("not_verified") && e.contains("Nothing was shared"));
    let many: Vec<String> = (0..=MAX_LINES).map(|i| format!("check {i}")).collect();
    assert!(err(args(json!({ "checked": many }))).contains("lines"));
    let links: Vec<Value> = (0..=MAX_ITEMS)
        .map(|i| json!({ "url": format!("https://e.com/{i}") }))
        .collect();
    assert!(err(args(json!({ "items": links }))).contains("too many"));
    let files: Vec<Value> = (0..=attachments::MAX_FILES)
        .map(|i| json!({ "path": format!("f{i}.txt") }))
        .collect();
    assert!(err(args(json!({ "items": files }))).contains("files is too many"));
    assert!(err(args(json!({ "changes": long(MAX_LINE + 1) }))).contains("changes"));
}

#[test]
fn lines_drop_blanks_and_take_a_single_string() {
    let draft = parse(&args(json!({
        "checked": ["Totals match", "  ", ""],
        "not_verified": "EUR rate"
    })))
    .unwrap();
    assert_eq!(draft.checked, ["Totals match"]);
    assert_eq!(draft.not_verified, ["EUR rate"]);
    assert!(err(args(json!({ "checked": [1] }))).contains("list of short lines"));
    assert!(err(args(json!({ "checked": { "a": 1 } }))).contains("list of short lines"));
}

#[test]
fn an_item_is_a_file_or_a_link_never_both() {
    let draft = parse(&args(json!({ "items": [
        { "path": "report.pdf", "label": "Report" },
        { "url": "https://acme.com/pricing", "label": "Live page" },
        { "path": "after.png", "role": "after" }
    ]})))
    .unwrap();
    assert_eq!(
        draft.items,
        [
            DraftItem::File {
                path: "report.pdf".into(),
                label: Some("Report".into()),
                role: None,
                page: None
            },
            DraftItem::Link {
                url: "https://acme.com/pricing".into(),
                label: Some("Live page".into())
            },
            DraftItem::File {
                path: "after.png".into(),
                label: None,
                role: Some(ShotRole::After),
                page: None
            },
        ]
    );
    assert!(err(args(
        json!({ "items": [{ "path": "a", "url": "https://a.com" }] })
    ))
    .contains("not both"));
    assert!(err(args(json!({ "items": [{ "label": "x" }] }))).contains("needs a `path`"));
    assert!(err(args(json!({ "items": ["a.pdf"] }))).contains("object"));
    assert!(err(args(
        json!({ "items": [{ "path": "a.png", "role": "during" }] })
    ))
    .contains("\"before\" or \"after\""));
    assert!(err(args(
        json!({ "items": [{ "url": "https://a.com", "role": "after" }] })
    ))
    .contains("not links"));
}

#[test]
fn only_plain_web_links() {
    assert_eq!(
        check_url("https://acme.com/a?b=1").unwrap(),
        "https://acme.com/a?b=1"
    );
    assert!(check_url("http://localhost:3000/").is_ok());
    for bad in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "ftp://acme.com/x",
        "acme.com",
        "",
    ] {
        assert!(check_url(bad).is_err(), "{bad}");
    }
    assert!(check_url("https://me:hunter2@acme.com/")
        .unwrap_err()
        .contains("sign-in"));
    assert!(check_url(&format!("https://a.com/{}", "a".repeat(MAX_URL))).is_err());
}

// ---------------------------------------------------------------- versions

fn result_message(id: &str, card_id: &str, version: u32) -> AgentMessage {
    let mut m = crate::agents::runner::new_message("a1", MessageKind::Agent, "s");
    m.id = id.into();
    m.result = Some(ResultCard {
        id: card_id.into(),
        version,
        title: format!("Title v{version}"),
        summary: "s".into(),
        items: Vec::new(),
        checked: Vec::new(),
        not_verified: Vec::new(),
        changes: None,
        project: None,
        test: None,
        checkpoint: false,
    });
    m
}

fn ask(card_id: &str, version: u32) -> AgentMessage {
    let mut m = crate::agents::runner::new_message("a1", MessageKind::User, "change it");
    m.revises = Some(ResultRef {
        id: card_id.into(),
        version,
        title: "t".into(),
    });
    m
}

fn say(kind: MessageKind) -> AgentMessage {
    crate::agents::runner::new_message("a1", kind, "hi")
}

#[test]
fn ask_for_changes_points_the_next_result_at_the_same_card() {
    let log = vec![
        result_message("m1", "r1", 1),
        say(MessageKind::Agent),
        ask("r1", 1),
    ];
    let target = revision_target(&log, None).unwrap().unwrap();
    assert_eq!((target.id.as_str(), target.version), ("r1", 1));

    // Answered already: a later result settles the request.
    let mut answered = log.clone();
    answered.push(result_message("m2", "r1", 2));
    assert!(revision_target(&answered, None).unwrap().is_none());

    // Revising what is now version 2 makes version 3, whatever the ask said.
    answered.push(ask("r1", 1));
    let target = revision_target(&answered, None).unwrap().unwrap();
    assert_eq!(target.version, 2);
}

#[test]
fn a_later_message_from_the_user_is_a_new_request() {
    // Ask for changes on r1, the agent answers without a card, then the user
    // moves on: the next result is new, not version 2 of r1.
    let log = vec![
        result_message("m1", "r1", 1),
        ask("r1", 1),
        say(MessageKind::Agent),
        say(MessageKind::User),
    ];
    assert!(revision_target(&log, None).unwrap().is_none());
    // The explicit id still works when the agent means it.
    assert_eq!(
        revision_target(&log, Some("r1")).unwrap().unwrap().version,
        1
    );
}

#[test]
fn without_an_ask_a_result_is_new() {
    let log = vec![result_message("m1", "r1", 1), say(MessageKind::User)];
    assert!(revision_target(&log, None).unwrap().is_none());
    assert!(revision_target(&[], None).unwrap().is_none());
    // An ask about a result that isn't there any more starts a new one.
    assert!(revision_target(&[ask("gone", 1)], None).unwrap().is_none());
}

#[test]
fn an_explicit_revision_must_exist() {
    let log = vec![result_message("m1", "r1", 1), result_message("m2", "r1", 2)];
    assert_eq!(
        revision_target(&log, Some("r1")).unwrap().unwrap().version,
        2
    );
    let e = revision_target(&log, Some("nope")).unwrap_err();
    assert!(e.contains("no result nope"));
}

#[test]
fn the_reference_comes_from_the_log() {
    let log = vec![result_message("m1", "r1", 1), result_message("m2", "r1", 2)];
    let r = reference(&log, "r1").unwrap();
    assert_eq!((r.version, r.title.as_str()), (2, "Title v2"));
    assert!(reference(&log, "r9").is_none());
    assert!(
        revising_prompt(&r).contains("revises: \"r1\"")
            && revising_prompt(&r).contains("version 3")
    );
}

fn file(name: &str) -> Attachment {
    Attachment {
        name: name.into(),
        path: format!("attachments/m/{name}"),
        mime: attachments::mime_for(name).into(),
        size: 1,
    }
}

#[test]
fn build_numbers_versions_and_keeps_changes_only_on_revisions() {
    let draft = parse(&args(json!({
        "items": [
            { "path": "a.pdf", "role": "after" },
            { "url": "https://a.com" },
            { "path": "b.png", "role": "before" }
        ],
        "changes": "ignored on a first version"
    })))
    .unwrap();
    let v1 = build(
        draft.clone(),
        None,
        vec![file("a.pdf"), file("b.png")],
        || "new".into(),
    );
    assert_eq!(
        (v1.id.as_str(), v1.version, v1.changes.as_deref()),
        ("new", 1, None)
    );
    // Kept in order; a before/after on a non-picture is dropped.
    assert!(
        matches!(&v1.items[0], ResultItem::File { file, role: None, .. } if file.name == "a.pdf")
    );
    assert!(matches!(&v1.items[1], ResultItem::Link { .. }));
    assert!(matches!(
        &v1.items[2],
        ResultItem::File {
            role: Some(ShotRole::Before),
            ..
        }
    ));

    let v2 = build(
        draft,
        Some(&v1),
        vec![file("a.pdf"), file("b.png")],
        || unreachable!(),
    );
    assert_eq!((v2.id.as_str(), v2.version), ("new", 2));
    assert_eq!(v2.changes.as_deref(), Some("ignored on a first version"));
}

#[test]
fn the_wire_shape_is_camel_case_and_tagged() {
    let card = build(
        parse(&args(json!({ "items": [{ "url": "https://a.com", "label": "Site" }], "not_verified": ["x"] }))).unwrap(),
        None,
        Vec::new(),
        || "r1".into(),
    );
    let v = serde_json::to_value(&card).unwrap();
    assert_eq!(v["notVerified"], json!(["x"]));
    assert_eq!(
        v["items"][0],
        json!({ "kind": "link", "url": "https://a.com/", "label": "Site" })
    );
    assert!(v.get("checked").is_none() && v.get("changes").is_none());
}

#[test]
fn a_site_result_carries_its_project_through_revisions() {
    let mut first = parse(&args(json!({ "project": "bakery-site" }))).unwrap();
    assert_eq!(first.project.as_deref(), Some("bakery-site"));
    // The caller resolves the name to the real path before building.
    first.project = Some("/Users/me/ShipStudio/bakery-site".into());
    let v1 = build(first, None, Vec::new(), || "r1".into());
    assert_eq!(
        serde_json::to_value(&v1).unwrap()["project"],
        json!("/Users/me/ShipStudio/bakery-site")
    );
    let v2 = build(
        parse(&args(json!({ "changes": "Bigger photos" }))).unwrap(),
        Some(&v1),
        Vec::new(),
        || unreachable!(),
    );
    assert_eq!(v2.project, v1.project, "a revision is still that site");
    // No project named: none on the card, and none on the wire.
    let plain = build(parse(&args(json!({}))).unwrap(), None, Vec::new(), || {
        "r2".into()
    });
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("project")
        .is_none());
}

// ---------------------------------------------------------------- files

fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("agents/a1");
    let project = dir.path().join("acme");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(home.join("report.pdf"), b"%PDF").unwrap();
    std::fs::write(project.join("after.png"), b"png").unwrap();
    std::fs::write(dir.path().join("secret.txt"), b"no").unwrap();
    (dir, home, project)
}

#[test]
fn files_must_exist_in_the_agents_own_files_and_are_copied() {
    let (_dir, home, project) = dirs();
    let roots = [home.clone(), project.clone()];
    let draft = parse(&args(json!({ "items": [
        { "path": "report.pdf" },
        { "path": project.join("after.png").display().to_string(), "role": "after" },
        { "url": "https://a.com" }
    ]})))
    .unwrap();
    let saved = save_files(&draft, &home, &roots, "m7").unwrap();
    let names: Vec<&str> = saved.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, ["report.pdf", "after.png"]);
    assert!(home.join("attachments/m7/report.pdf").is_file());
    assert!(home.join("attachments/m7/after.png").is_file());
}

#[test]
fn one_bad_file_shares_nothing() {
    let (_dir, home, project) = dirs();
    let roots = [home.clone(), project.clone()];
    for bad in ["missing.pdf", "../../secret.txt", "/etc/hosts", "."] {
        let draft = parse(&args(
            json!({ "items": [{ "path": "report.pdf" }, { "path": bad }] }),
        ))
        .unwrap();
        assert!(save_files(&draft, &home, &roots, "m8").is_err(), "{bad}");
        assert!(
            !home.join("attachments/m8").exists(),
            "{bad} left files behind"
        );
    }
    // Secrets are refused, with nothing copied.
    std::fs::write(project.join(".env.local"), b"STRIPE_KEY=sk_live_abc").unwrap();
    let env = project.join(".env.local").display().to_string();
    let draft = parse(&args(
        json!({ "items": [{ "path": "report.pdf" }, { "path": env }] }),
    ))
    .unwrap();
    assert!(save_files(&draft, &home, &roots, "m10")
        .unwrap_err()
        .contains("holds secrets"));
    assert!(!home.join("attachments/m10").exists());
    // A before/after must be a picture.
    let draft = parse(&args(
        json!({ "items": [{ "path": "report.pdf", "role": "before" }] }),
    ))
    .unwrap();
    assert!(save_files(&draft, &home, &roots, "m9")
        .unwrap_err()
        .contains("isn't a picture"));
}

// ---------------------------------------------------------------- the call

fn with_store<T>(f: impl FnOnce(&str, &Path) -> T) -> T {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let agent = store::create(store::NewAgent {
        name: "Finance".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let home = store::agent_home(&agent.id).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let out = f(&agent.id, &home);
    store::set_root_for_tests(None);
    out
}

#[test]
fn prepare_versions_against_the_log_and_requires_what_changed() {
    with_store(|id, home| {
        std::fs::write(home.join("summary.pdf"), b"%PDF").unwrap();
        let roots = [home.to_path_buf()];
        let first = prepare(
            id,
            home,
            &roots,
            parse(&args(
                json!({ "items": [{ "path": "summary.pdf" }], "not_verified": ["EUR rate"] }),
            ))
            .unwrap(),
        )
        .unwrap();
        let card = first.result.clone().unwrap();
        assert_eq!(card.version, 1);
        assert_eq!(first.kind, MessageKind::Agent);
        assert_eq!(first.text, "One page, every invoice.");
        // Mirrored for the Files list and older clients.
        assert_eq!(first.attachments.len(), 1);
        assert_eq!(
            first.attachments[0].path,
            format!("attachments/{}/summary.pdf", first.id)
        );
        store::append_message(&first).unwrap();

        let mut asked =
            crate::agents::runner::new_message(id, MessageKind::User, "Use the October rate");
        asked.revises = reference(&store::messages(id, usize::MAX).unwrap(), &card.id);
        store::append_message(&asked).unwrap();

        // A revision must say what changed; nothing is copied when it doesn't.
        let e = prepare(
            id,
            home,
            &roots,
            parse(&args(json!({ "items": [{ "path": "summary.pdf" }] }))).unwrap(),
        )
        .unwrap_err();
        assert!(e.contains("`changes`") && e.contains("version 1"));
        let copies = std::fs::read_dir(home.join("attachments")).unwrap().count();
        assert_eq!(copies, 1);

        let second = prepare(
            id,
            home,
            &roots,
            parse(&args(json!({ "changes": "EUR at the October rate" }))).unwrap(),
        )
        .unwrap();
        let v2 = second.result.unwrap();
        assert_eq!((v2.id, v2.version), (card.id, 2));
        assert_eq!(v2.changes.as_deref(), Some("EUR at the October rate"));
    });
}

#[test]
fn a_second_result_in_a_turn_replaces_the_first() {
    with_store(|id, home| {
        std::fs::write(home.join("a.txt"), b"a").unwrap();
        let roots = [home.to_path_buf()];
        let make = || {
            prepare(
                id,
                home,
                &roots,
                parse(&args(json!({ "items": [{ "path": "a.txt" }] }))).unwrap(),
            )
            .unwrap()
        };
        let first = make();
        let first_dir = home.join("attachments").join(&first.id);
        assert!(!stage(first));
        assert!(first_dir.is_dir());
        let second = make();
        let second_id = second.id.clone();
        assert!(stage(second));
        // The replaced card's copies go with it.
        assert!(!first_dir.exists());
        assert_eq!(take(id).unwrap().id, second_id);
        assert!(take(id).is_none());

        // A new turn starts clean.
        let third = make();
        let third_dir = home.join("attachments").join(&third.id);
        stage(third);
        discard(id);
        assert!(take(id).is_none() && !third_dir.exists());
    });
}

#[test]
fn without_a_live_turn_the_card_goes_in_now() {
    assert_eq!(delivery(true, false), Delivery::AtTurnEnd);
    assert_eq!(delivery(false, false), Delivery::Now);
    // A checkpoint in a live turn goes in now; outside one, as any card does.
    assert_eq!(delivery(true, true), Delivery::Checkpoint);
    assert_eq!(delivery(false, true), Delivery::Now);
    let card = build(parse(&args(json!({}))).unwrap(), None, Vec::new(), || {
        "r".into()
    });
    let reply = recorded_reply(&card);
    // Truthful about where it is: never "at the end of your reply".
    assert!(reply.contains("in the chat now") && !reply.contains("end of your reply"));
    assert!(reply.contains("adds another card"));
}

#[test]
fn the_reply_to_the_agent_says_where_it_shows() {
    let card = build(parse(&args(json!({}))).unwrap(), None, Vec::new(), || {
        "r".into()
    });
    let reply = staged_reply(&card, false);
    assert!(reply.contains("one card at the end of your reply") && !reply.contains("replaces"));
    let mut v2 = card.clone();
    v2.version = 2;
    assert!(
        staged_reply(&v2, true).contains("version 2")
            && staged_reply(&v2, true).contains("replaces")
    );
}

// ------------------------------------------------------------ visual work

/// Before/after shots of several pages are ONE card, grouped by page, with
/// the captions as the agent wrote them.
#[test]
fn a_visual_set_is_one_card_with_a_page_on_each_shot() {
    let draft = parse(&args(json!({
        "title": "New hero",
        "summary": "Bigger headline on three pages.",
        "project": "bakery",
        "items": [
            { "path": "home-before.png", "role": "before", "page": "Home" },
            { "path": "home-after.png", "role": "after", "page": "Home", "label": "Headline at 64px" },
            { "path": "menu-before.png", "role": "before", "page": "Menu" },
            { "path": "menu-after.png", "role": "after", "page": "Menu" }
        ]
    })))
    .unwrap();
    let pic = |name: &str| Attachment {
        name: name.into(),
        path: format!("attachments/m/{name}"),
        mime: "image/png".into(),
        size: 1,
    };
    let saved = [
        "home-before.png",
        "home-after.png",
        "menu-before.png",
        "menu-after.png",
    ]
    .map(pic)
    .to_vec();
    let card = build(draft, None, saved, || "r".into());
    assert_eq!(card.items.len(), 4);
    let pages: Vec<_> = card
        .items
        .iter()
        .map(|i| match i {
            ResultItem::File { page, role, .. } => (page.clone(), *role),
            ResultItem::Link { .. } => (None, None),
        })
        .collect();
    assert_eq!(pages[0], (Some("Home".into()), Some(ShotRole::Before)));
    assert_eq!(pages[3], (Some("Menu".into()), Some(ShotRole::After)));
    let wire = serde_json::to_value(&card).unwrap();
    assert_eq!(wire["items"][1]["page"], "Home");
    assert_eq!(wire["items"][1]["label"], "Headline at 64px");
    assert!(wire.get("checkpoint").is_none(), "false stays off the wire");
}

#[test]
fn a_page_needs_a_role_and_a_short_name() {
    assert!(err(args(
        json!({ "items": [{ "path": "a.png", "page": "Home" }] })
    ))
    .contains("give it a `role`"));
    let long = "x".repeat(MAX_PAGE + 1);
    assert!(err(args(
        json!({ "items": [{ "path": "a.png", "role": "after", "page": long }] })
    ))
    .contains("`page`"));
    assert!(err(args(json!({ "checkpoint": "yes" }))).contains("true or false"));
}

#[test]
fn a_checkpoint_is_marked_and_the_turns_next_card_continues_it() {
    let draft = parse(&args(json!({ "checkpoint": true }))).unwrap();
    assert!(draft.checkpoint);
    let card = build(draft, None, Vec::new(), || "r-check".into());
    assert!(card.checkpoint);
    assert_eq!(serde_json::to_value(&card).unwrap()["checkpoint"], true);

    // Later in the same turn: the next version of it, not a second card.
    let mut later = parse(&args(json!({ "changes": "All three pages done" }))).unwrap();
    continue_checkpoint(&mut later, Some("r-check".into()));
    assert_eq!(later.revises.as_deref(), Some("r-check"));
    let v2 = build(later, Some(&card), Vec::new(), || unreachable!());
    assert_eq!((v2.id.as_str(), v2.version), ("r-check", 2));
    assert!(!v2.checkpoint, "the finished card isn't partway");

    // A card naming its own target keeps it.
    let mut other = parse(&args(json!({ "revises": "r-old" }))).unwrap();
    continue_checkpoint(&mut other, Some("r-check".into()));
    assert_eq!(other.revises.as_deref(), Some("r-old"));
}

#[test]
fn a_checkpoint_is_forgotten_when_the_next_turn_starts() {
    note_checkpoint("a-cp", "r-cp");
    assert_eq!(checkpoint_of("a-cp").as_deref(), Some("r-cp"));
    discard("a-cp");
    assert_eq!(checkpoint_of("a-cp"), None);
}
