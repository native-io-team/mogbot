use super::*;
use crate::commands::projects::DevCommandSurface;
use std::collections::BTreeMap;

fn consent(state: ConsentState) -> DevServerConsent {
    let mut scripts = BTreeMap::new();
    scripts.insert("dev".to_string(), "next dev".to_string());
    scripts.insert(
        "postinstall".to_string(),
        "node scripts/setup.js".to_string(),
    );
    let mut files = BTreeMap::new();
    files.insert("next.config.mjs".to_string(), "abc".to_string());
    DevServerConsent {
        state,
        fingerprint: "f".into(),
        surface: DevCommandSurface {
            scripts,
            files,
            ..Default::default()
        },
        install_scripts_pending: false,
    }
}

#[test]
fn every_tool_is_listed_once_and_never_collides() {
    let defs = definitions();
    assert_eq!(defs.len(), TOOLS.len());
    let mut names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), TOOLS.len());
    for d in &defs {
        assert_eq!(d["inputSchema"]["type"], "object", "{}", d["name"]);
        assert_eq!(d["inputSchema"]["required"][0], "project", "{}", d["name"]);
        let name = d["name"].as_str().unwrap();
        assert!(super::super::sessions::find(name).is_none(), "{name}");
        assert!(super::super::preview_test::find(name).is_none(), "{name}");
        // Short enough to sit in every agent's tool list.
        assert!(d["description"].as_str().unwrap().len() < 400, "{name}");
    }
}

#[test]
fn what_changes_the_folder_or_github_is_gated_by_the_agents_settings() {
    // policy::session_refusal refuses these for an agent that may only look.
    for name in [
        "project_install",
        "git_commit",
        "git_branch",
        "pull_request",
    ] {
        assert!(CHANGES.contains(&name), "{name}");
    }
    assert!(CHANGES.contains(&"preview_start"), "it may install");
    assert!(!CHANGES.contains(&"preview_logs"));
    assert!(!CHANGES.contains(&"preview_stop"));
}

#[test]
fn the_consent_card_lists_what_runs_and_what_is_approved() {
    let (title, summary, detail) = consent_card("bakery", &consent(ConsentState::New));
    assert_eq!(title, "Run bakery's own commands?");
    assert!(summary.contains("on this Mac"));
    assert!(summary.contains("Only allow projects you trust"));
    assert!(detail.contains("dev: next dev"));
    assert!(detail.contains("postinstall: node scripts/setup.js"));
    assert!(detail.contains("next.config.mjs"));

    let (title, summary, _) = consent_card("bakery", &consent(ConsentState::Changed));
    assert_eq!(title, "bakery changed. Run its commands?");
    assert!(summary.contains("changed since you last allowed"));

    let mut empty = consent(ConsentState::New);
    empty.surface = DevCommandSurface::default();
    empty.install_scripts_pending = true;
    let (_, _, detail) = consent_card("blank", &empty);
    assert!(detail.starts_with("This project defines no scripts."));
    assert!(detail.contains("those run first"));
}

#[test]
fn a_long_script_list_is_cut_and_says_how_many_more() {
    let mut c = consent(ConsentState::New);
    c.surface.scripts = (0..30)
        .map(|i| (format!("s{i:02}"), "x".to_string()))
        .collect();
    let (_, _, detail) = consent_card("big", &c);
    assert!(detail.contains("… and 10 more"));
    assert!(!detail.contains("s29"));
}

#[test]
fn the_custom_command_and_workspaces_come_in_the_preview_order() {
    let mut c = consent(ConsentState::New);
    c.surface.custom_command = Some("nx serve web".into());
    c.surface.workspace_subpath = Some("apps/web".into());
    c.surface.workspace_scripts = Some(BTreeMap::from([("dev".into(), "vite".into())]));
    c.surface.workspaces = BTreeMap::from([(
        "packages/ui".into(),
        BTreeMap::from([("build".into(), "tsc".into())]),
    )]);
    let (_, _, detail) = consent_card("mono", &c);
    let at = |s: &str| {
        detail
            .find(s)
            .unwrap_or_else(|| panic!("{s} missing: {detail}"))
    };
    assert!(at("dev command: nx serve web") < at("dev: next dev"));
    assert!(at("dev: next dev") < at("apps/web › dev: vite"));
    assert!(at("apps/web › dev: vite") < at("packages/ui › build: tsc"));
}

#[test]
fn a_bound_agent_works_on_its_own_copy_of_that_project_only() {
    let copy = super::super::task::TaskCopy {
        id: "c1".into(),
        project: "/u/ShipStudio/site".into(),
        path: "/u/ShipStudio/.worktrees/site-c1".into(),
        branch: "agent/c1".into(),
        base: "abc".into(),
        base_branch: None,
        created_at: 0,
        deps: false,
        stuck: None,
    };
    let t = target_for("/u/ShipStudio/site/", Some(&copy));
    assert!(t.copy);
    assert_eq!(t.path, "/u/ShipStudio/.worktrees/site-c1");
    assert_eq!(t.name(), "site");
    let other = target_for("/u/ShipStudio/blog", Some(&copy));
    assert!(!other.copy);
    assert_eq!(other.path, "/u/ShipStudio/blog");
    assert!(!target_for("/u/ShipStudio/site", None).copy);
}

#[test]
fn a_started_server_that_isnt_a_preview_says_why() {
    let up = Report {
        status: "ready".into(),
        port: Some(3000),
        ..Default::default()
    };
    assert_eq!(not_a_preview("site", &up), None);
    let mobile = Report {
        mobile: true,
        ..up.clone()
    };
    assert!(not_a_preview("app", &mobile)
        .unwrap()
        .contains("no web preview"));
    let nothing = Report {
        status: "not-running".into(),
        port: Some(3000),
        ..Default::default()
    };
    assert!(not_a_preview("tool", &nothing)
        .unwrap()
        .contains("no dev server"));
    let install = Report {
        needs_install: true,
        ..up.clone()
    };
    assert!(not_a_preview("site", &install)
        .unwrap()
        .contains("packages"));
    let consent = Report {
        consent_pending: true,
        ..up
    };
    assert!(not_a_preview("site", &consent)
        .unwrap()
        .contains("approval"));
}

#[test]
fn the_window_answers_in_camel_case_and_old_windows_still_parse() {
    let r: Report = serde_json::from_value(json!({
        "status": "stopped",
        "port": 5173,
        "projectType": "vite",
        "needsInstall": false,
        "output": "\u{1b}[31mError: Cannot find module 'react'\u{1b}[0m\n"
    }))
    .unwrap();
    assert_eq!(r.port, Some(5173));
    assert_eq!(r.project_type.as_deref(), Some("vite"));
    assert_eq!(tail(&r.output, 5), "Error: Cannot find module 'react'");
    let bare: Report = serde_json::from_value(json!({})).unwrap();
    assert_eq!(bare, Report::default());
    // Nobody waiting on it: answering is a no-op, not a panic.
    assert!(!answer("nobody", bare));
}

#[test]
fn a_tail_keeps_the_last_lines_that_say_something() {
    assert_eq!(tail("a\n\nb\n  \nc\nd\n", 2), "c\nd");
    assert_eq!(tail("", 5), "");
}

#[test]
fn after_the_preview_the_agent_hands_back_a_card_with_the_screenshot() {
    let next = next_after_preview(
        "bakery",
        false,
        &["attachments/m1/bakery-desktop.jpg".into()],
    );
    assert!(next.contains("share_result naming project \"bakery\""));
    assert!(next.contains("`attachments/m1/bakery-desktop.jpg` as a file"));
    assert!(next.contains("Watch live on the phone"));
    let copy = next_after_preview("bakery", true, &[]);
    assert!(copy.contains("Keep"));
    assert!(!copy.contains("as a file"));
}

#[test]
fn the_pull_request_card_says_it_pushes_and_who_sees_it() {
    let s = pull_request_summary("acme/site", "feature/hero", "main", "Bigger hero");
    assert!(s.starts_with("Pushes feature/hero to acme/site"));
    assert!(s.contains("into main"));
    assert!(s.contains("“Bigger hero”"));
    assert!(s.contains("can see it"));
}

#[test]
fn package_managers_are_the_four_the_install_plan_accepts() {
    assert_eq!(package_manager("pnpm\n"), "pnpm");
    assert_eq!(package_manager("yarn"), "yarn");
    assert_eq!(package_manager("bun"), "bun");
    assert_eq!(package_manager("npm"), "npm");
    assert_eq!(package_manager("something-else"), "npm");
}
