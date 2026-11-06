use super::*;
use crate::agents::project::ChangeSummary;
use crate::agents::task::CopyRef;
use serde_json::json;

fn agent(copy: Option<TaskCopy>) -> store::Agent {
    let mut a: store::Agent = serde_json::from_value(json!({
        "id": "a1",
        "name": "Site Builder",
        "shape": 0,
        "color": "red",
        "createdAt": 0
    }))
    .expect("an agent from the minimum fields");
    a.copy = copy;
    a
}

fn task_copy(id: &str, path: &str) -> TaskCopy {
    TaskCopy {
        id: id.into(),
        project: "/p/harbor-bakery".into(),
        path: path.into(),
        branch: "site/hero-1".into(),
        base: "abc".into(),
        base_branch: Some("main".into()),
        created_at: 0,
        deps: true,
        stuck: None,
    }
}

fn changes(project: &str, copy: Option<(&str, &str)>) -> ChangeSummary {
    ChangeSummary {
        project: project.into(),
        branch: Some("main".into()),
        from: "t1".into(),
        to: "t2".into(),
        files: Vec::new(),
        file_count: 1,
        added: 3,
        removed: 1,
        copy: copy.map(|(id, path)| CopyRef {
            id: id.into(),
            path: path.into(),
            branch: "site/hero-1".into(),
        }),
        left_out: Vec::new(),
        warning: None,
    }
}

fn card(id: &str, version: u32, project: Option<&str>) -> ResultCard {
    ResultCard {
        id: id.into(),
        version,
        title: "New hero section".into(),
        summary: "Rebuilt the hero.".into(),
        items: Vec::new(),
        checked: Vec::new(),
        not_verified: Vec::new(),
        changes: None,
        project: project.map(str::to_string),
        test: None,
    }
}

fn message(id: &str, kind: MessageKind) -> AgentMessage {
    let mut m = crate::agents::runner::new_message("a1", kind, "s");
    m.id = id.into();
    m
}

// ---------------------------------------------------------------- which folder

#[test]
fn a_live_copy_card_previews_the_copy() {
    let copy = task_copy("c1", "/p/.worktrees/harbor-bakery/site-1");
    let mut m = message("m1", MessageKind::Changes);
    m.changes = Some(changes(
        "/p/harbor-bakery",
        Some(("c1", "/p/.worktrees/harbor-bakery/site-1")),
    ));
    assert_eq!(
        target_path(&m, Some(&copy)),
        Some((
            "/p/.worktrees/harbor-bakery/site-1".into(),
            "/p/harbor-bakery".into(),
            true
        ))
    );
}

#[test]
fn a_kept_or_discarded_copy_previews_the_project() {
    let mut m = message("m1", MessageKind::Changes);
    m.changes = Some(changes("/p/harbor-bakery", Some(("c1", "/p/.worktrees/x"))));
    // No open copy, or a newer one: the card's copy is gone.
    let newer = task_copy("c2", "/p/.worktrees/y");
    for open in [None, Some(&newer)] {
        assert_eq!(
            target_path(&m, open),
            Some(("/p/harbor-bakery".into(), "/p/harbor-bakery".into(), false))
        );
    }
}

#[test]
fn a_copy_with_the_same_id_but_another_folder_is_not_trusted() {
    let open = task_copy("c1", "/p/.worktrees/elsewhere");
    let mut m = message("m1", MessageKind::Changes);
    m.changes = Some(changes("/p/harbor-bakery", Some(("c1", "/p/.worktrees/x"))));
    assert_eq!(target_path(&m, Some(&open)).unwrap().2, false);
}

#[test]
fn a_result_previews_its_project_and_nothing_else_previews_at_all() {
    let mut m = message("m1", MessageKind::Agent);
    m.result = Some(card("r1", 1, Some("/p/harbor-bakery")));
    assert_eq!(
        target_path(&m, None),
        Some(("/p/harbor-bakery".into(), "/p/harbor-bakery".into(), false))
    );
    m.result = Some(card("r1", 1, None));
    assert_eq!(target_path(&m, None), None);
    assert_eq!(target_path(&message("m2", MessageKind::Agent), None), None);
}

#[test]
fn a_project_that_left_the_list_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().to_string_lossy().to_string();
    let mut m = message("m1", MessageKind::Agent);
    m.result = Some(card("r1", 1, Some(&project)));
    let none = |_: &str| None;
    let e = resolve(&agent(None), &m, &[], none, none).unwrap_err();
    assert!(e.contains("isn't one of your projects"), "{e}");
    let ok = resolve(&agent(None), &m, &[project.clone()], none, |_| Some(4123)).unwrap();
    assert_eq!(
        (ok.path.as_str(), ok.port, ok.running, ok.copy),
        (project.as_str(), Some(4123), false, false)
    );
    assert_eq!(ok.title.as_deref(), Some("New hero section"));
}

#[test]
fn a_copy_is_previewed_without_being_a_project_but_must_exist() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().to_string();
    let mut m = message("m1", MessageKind::Changes);
    m.changes = Some(changes("/p/harbor-bakery", Some(("c1", &path))));
    let none = |_: &str| None;
    let t = resolve(
        &agent(Some(task_copy("c1", &path))),
        &m,
        &[],
        |_| Some(4500),
        |_| Some(4200),
    )
    .unwrap();
    assert!(t.copy && t.running);
    assert_eq!(t.port, Some(4500));
    drop(dir);
    let e = resolve(&agent(Some(task_copy("c1", &path))), &m, &[], none, none).unwrap_err();
    assert!(e.contains("copy isn't there"), "{e}");
}

// ---------------------------------------------------------------- ports

#[test]
fn a_server_already_up_wins_over_the_saved_port() {
    assert_eq!(pick_port(Some(4100), Some(3000)), Some(4100));
    assert_eq!(pick_port(None, Some(3000)), Some(3000));
    assert_eq!(pick_port(None, None), None);
    assert_eq!(pick_port(Some(0), Some(0)), None);
    assert_eq!(pick_port(Some(0), Some(3001)), Some(3001));
}

// ---------------------------------------------------------------- the pane

#[test]
fn one_pane_per_window_and_only_its_own_window_detaches_it() {
    attach_pane("/tmp/pane-test-a", "main", true);
    assert_eq!(pane_window("/tmp/pane-test-a").as_deref(), Some("main"));
    // Another window detaching the same folder doesn't close main's pane.
    attach_pane("/tmp/pane-test-a", "other", false);
    assert_eq!(pane_window("/tmp/pane-test-a").as_deref(), Some("main"));
    // Showing another folder replaces the first.
    attach_pane("/tmp/pane-test-b", "main", true);
    assert_eq!(pane_window("/tmp/pane-test-a"), None);
    assert_eq!(pane_window("/tmp/pane-test-b").as_deref(), Some("main"));
    attach_pane("/tmp/pane-test-b", "main", false);
    assert_eq!(pane_window("/tmp/pane-test-b"), None);
}

// ---------------------------------------------------------------- steps

#[test]
fn steps_say_what_happened_in_plain_words() {
    let a = json!({ "path": "/pricing" });
    assert_eq!(step_label("test_open", &a, true), "Opened /pricing");
    assert_eq!(step_label("test_open", &a, false), "Couldn't open /pricing");
    let c = json!({ "selector": "button.cta", "label": "Sign up" });
    assert_eq!(step_label("test_click", &c, true), "Clicked “Sign up”");
    // A click that matched nothing says so, whatever the agent says next.
    assert_eq!(
        step_label("test_click", &c, false),
        "Couldn't click “Sign up”"
    );
    let t = json!({ "selector": "#email", "text": "Email", "submit": true });
    assert_eq!(
        step_label("test_type", &t, true),
        "Filled in “Email” and sent it"
    );
    assert_eq!(
        step_label("test_scroll", &json!({ "to": "bottom" }), true),
        "Scrolled to the bottom"
    );
    assert_eq!(
        step_label("test_viewport", &json!({ "preset": "mobile" }), true),
        "Switched to phone width"
    );
    assert_eq!(
        step_label("test_viewport", &json!({ "width": 390.4 }), true),
        "Switched to 390px wide"
    );
    assert_eq!(
        step_label(
            "test_note",
            &json!({ "text": "Form showed an error" }),
            true
        ),
        "Form showed an error"
    );
    assert_eq!(console_label(0), "Checked the console: no errors");
    assert_eq!(console_label(2), "Checked the console: 2 errors");
}

#[test]
fn a_typed_value_never_shows_in_the_step() {
    let t = json!({ "selector": "#password", "value": "hunter2-made-up" });
    assert!(!step_label("test_type", &t, true).contains("hunter2"));
}

#[test]
fn console_errors_come_from_the_previews_own_capture() {
    let with_meta = json!({ "content": [{ "type": "text", "text": "x" }], "_meta": { "lines": [
        "[error] TypeError: price is undefined", "[log] hello", "[error]   "
    ] } });
    assert_eq!(
        error_lines(&with_meta),
        vec!["TypeError: price is undefined"]
    );
    let fenced = json!({ "content": [{ "type": "text", "text":
        "Here's the current browser console from the preview:\n\n```\n[warn] slow\n[error] 404 /api/plans\n```" }] });
    assert_eq!(error_lines(&fenced), vec!["404 /api/plans"]);
}

// ---------------------------------------------------------------- runs

fn target(agent_id: &str) -> PreviewTarget {
    PreviewTarget {
        agent_id: agent_id.into(),
        message_id: "m1".into(),
        path: "/p/harbor-bakery".into(),
        project: "/p/harbor-bakery".into(),
        copy: false,
        port: Some(4100),
        running: true,
        title: Some("New hero section".into()),
    }
}

#[test]
fn one_run_at_a_time_and_only_its_own_turn_closes_it() {
    let run = open(&target("run-a"), 1_000).unwrap();
    assert!(is_open("run-a"));
    assert!(open(&target("run-a"), 1_001)
        .unwrap_err()
        .contains("already running"));
    // A turn that began before Test it was pressed isn't the test's turn.
    assert_eq!(settle_at_turn_end(&run, 999), None);
    assert_eq!(settle_at_turn_end(&run, 1_000), Some(RunState::Stopped));
    let mut reported = run.clone();
    reported.state = RunState::Reported;
    assert_eq!(
        settle_at_turn_end(&reported, 2_000),
        Some(RunState::Reported)
    );
    runs().remove("run-a");
    assert!(!is_open("run-a"));
    assert!(definitions("run-a").is_empty());
}

#[test]
fn the_tools_are_listed_only_while_a_run_is_open() {
    open(&target("run-b"), 5).unwrap();
    let names: Vec<String> = definitions("run-b")
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_string())
        .collect();
    assert!(
        names.contains(&"test_click".to_string()) && names.contains(&"test_report".to_string())
    );
    runs().remove("run-b");
}

// ---------------------------------------------------------------- the report

#[test]
fn a_report_is_checked_and_too_much_is_refused() {
    assert!(parse_report(&json!({ "outcome": "fine", "summary": "x" })).is_err());
    assert!(parse_report(&json!({ "outcome": "passed" })).is_err());
    let e = parse_report(&json!({ "outcome": "broken", "summary": "x" })).unwrap_err();
    assert!(e.contains("what's broken"));
    let many: Vec<String> = (0..=MAX_BROKEN).map(|i| format!("thing {i}")).collect();
    assert!(parse_report(&json!({ "outcome": "broken", "summary": "x", "broken": many })).is_err());
    let long = "a".repeat(MAX_SUMMARY + 1);
    assert!(parse_report(&json!({ "outcome": "passed", "summary": long })).is_err());
    let ok = parse_report(&json!({ "outcome": "broken", "summary": "Mostly works.", "broken": ["Sign up 404s", " "] })).unwrap();
    assert_eq!(
        ok,
        (
            Outcome::Broken,
            "Mostly works.".into(),
            vec!["Sign up 404s".to_string()]
        )
    );
}

fn report(outcome: Outcome, broken: &[&str]) -> TestReport {
    TestReport {
        outcome,
        summary: "Clicked through three pages.".into(),
        broken: broken.iter().map(|s| s.to_string()).collect(),
        console_errors: Vec::new(),
        steps: vec![TestStep {
            kind: StepKind::Open,
            label: "Opened /".into(),
            ok: true,
            shot: None,
            ts: 1,
        }],
        on_copy: false,
    }
}

#[test]
fn the_report_is_the_next_version_of_the_newest_card() {
    let latest = card("r1", 2, Some("/p/harbor-bakery"));
    let next = report_card(
        Some(&latest),
        report(Outcome::Broken, &["a", "b"]),
        "/p/harbor-bakery",
        || unreachable!(),
    );
    assert_eq!((next.id.as_str(), next.version), ("r1", 3));
    assert_eq!(
        next.changes.as_deref(),
        Some("Tested it in the preview: 2 things are broken")
    );
    assert_eq!(next.title, latest.title);
    assert!(next.test.is_some());
    let passed = report_card(
        Some(&latest),
        report(Outcome::Passed, &[]),
        "/p/x",
        || unreachable!(),
    );
    assert_eq!(
        passed.changes.as_deref(),
        Some("Tested it in the preview: it works")
    );
}

#[test]
fn a_copy_card_without_a_result_gets_a_first_one() {
    let first = report_card(
        None,
        report(Outcome::Passed, &[]),
        "/p/harbor-bakery",
        || "new".into(),
    );
    assert_eq!(
        (first.id.as_str(), first.version, first.title.as_str()),
        ("new", 1, "Tested harbor-bakery")
    );
    assert_eq!(first.project.as_deref(), Some("/p/harbor-bakery"));
    assert_eq!(first.changes, None);
}

#[test]
fn a_live_copy_card_stays_a_change_card_so_keep_carries_over() {
    let mut source = message("m1", MessageKind::Changes);
    source.changes = Some(changes("/p/harbor-bakery", Some(("c1", "/p/.worktrees/x"))));
    source.result = Some(card("r1", 1, None));
    let mut v2 = message("m2", MessageKind::Agent);
    v2.result = Some(card("r1", 2, None));
    let log = vec![source.clone(), v2];
    let mut run = open(&target("run-c"), 1).unwrap();
    runs().remove("run-c");
    run.project = "/p/harbor-bakery".into();
    let mut r = report(Outcome::Passed, &[]);
    r.steps[0].shot = Some(Attachment {
        name: "step-1.png".into(),
        path: format!("attachments/{}/step-1.png", run.id),
        mime: "image/png".into(),
        size: 10,
    });
    let m = report_message(&source, &log, &run, r);
    assert_eq!(m.kind, MessageKind::Changes);
    assert_eq!(m.id, run.id);
    assert_eq!(m.changes.as_ref().unwrap().copy.as_ref().unwrap().id, "c1");
    // From the newest version (v2), not the one the card showed.
    assert_eq!(m.result.as_ref().unwrap().version, 3);
    assert_eq!(m.attachments.len(), 1);
    // A plain result card stays an agent message.
    let mut plain = message("m3", MessageKind::Agent);
    plain.result = Some(card("r9", 1, Some("/p/harbor-bakery")));
    let m = report_message(&plain, &[plain.clone()], &run, report(Outcome::Passed, &[]));
    assert_eq!((m.kind, m.result.unwrap().version), (MessageKind::Agent, 2));
}

#[test]
fn screenshots_are_kept_under_the_runs_id() {
    let home = tempfile::tempdir().unwrap();
    let src = home.path().join("capture.png");
    std::fs::write(&src, b"\x89PNG fake").unwrap();
    let a = keep_shot(home.path(), "run1", 2, &src).unwrap();
    assert_eq!(a.path, "attachments/run1/step-2.png");
    assert_eq!(a.mime, "image/png");
    assert!(home.path().join(&a.path).is_file());
    assert!(keep_shot(home.path(), "run1", 3, &home.path().join("missing.png")).is_err());
}

#[test]
fn the_prompt_names_the_tools_and_the_report() {
    let mut run = open(&target("run-d"), 1).unwrap();
    runs().remove("run-d");
    run.copy = true;
    let p = test_prompt(&run);
    assert!(p.contains("your copy of harbor-bakery"));
    assert!(p.contains("test_report") && p.contains("made-up details"));
    assert!(p.contains("\"New hero section\""));
}
