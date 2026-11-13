//! Settings changed from chat, beyond what each agent may do: this Mac's
//! stay-on switches, an app already connected here given to (or taken from)
//! an agent, and `update_agent`'s model, effort, routines' model and mute.
//! Giving more room is a card; less applies with a line; only an admin
//! proposes for others or for the Mac. Fictional agents and a fictional Mac.

use super::*;
use crate::agents::engine::Engine;
use crate::agents::mcp::{chat_model, run_settings};
use crate::agents::policy::{self, AppsMode, Change, Target};
use serde_json::json;

fn agent(id: &str, name: &str, main: bool) -> Agent {
    let mut a: Agent = serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap();
    a.is_main = main;
    a
}

fn linear(id: &str, account: &str, grants: &[(&str, &str)]) -> Connection {
    serde_json::from_value(json!({
        "id": id, "service": "linear", "title": "Linear", "account": account,
        "kind": { "type": "oauth", "serverUrl": "https://mcp.linear.app/mcp" },
        "serverKey": format!("linear-{id}"), "createdAt": 0,
        "grants": grants.iter().map(|(a, x)| json!({ "agentId": a, "access": x, "grantedAt": 0 })).collect::<Vec<_>>(),
    }))
    .unwrap()
}

fn to(id: &str) -> Vec<Target> {
    vec![Target::Agent {
        agent_id: id.into(),
    }]
}

fn ask(v: Value) -> GrantAsk {
    GrantAsk::parse(Some(&v)).unwrap()
}

fn named(id: &str) -> String {
    match id {
        "out" => "Outreach".into(),
        other => other.into(),
    }
}

/* ------------------------------------------------------------ this Mac */

#[test]
fn keeping_the_mac_going_is_a_card_and_letting_it_rest_is_a_line() {
    let now = MacNow {
        stay_on_supported: true,
        keep_running_available: true,
        open_at_login_available: true,
        ..Default::default()
    };
    let awake = MacChange {
        keep_awake: Some(true),
        ..Default::default()
    };
    let p = mac_proposal(true, &awake, &now, Some("keep going overnight".into()), 2).unwrap();
    assert_eq!(p.groups[0].who, "This Mac");
    assert!(p.groups[0].changes[0].contains("stays awake"));
    assert!(!mac_lowers(p.mac.as_ref().unwrap()));
    assert!(!proposal_lowers(
        &p,
        &policy::migrate(&[]),
        &[],
        Level::Judgement
    ));

    // Open at login installs a LaunchAgent: on is a card too.
    let login = MacChange {
        open_at_login: Some(true),
        keep_running: Some(true),
        ..Default::default()
    };
    let p = mac_proposal(true, &login, &now, None, 2).unwrap();
    assert_eq!(p.groups[0].changes.len(), 2);
    assert!(!mac_lowers(p.mac.as_ref().unwrap()));

    // Everything off: agents do less, so no card.
    let on = MacNow {
        keep_awake: true,
        keep_running: true,
        open_at_login: true,
        ..now.clone()
    };
    let off = MacChange {
        keep_awake: Some(false),
        keep_running: Some(false),
        open_at_login: Some(false),
        ..Default::default()
    };
    let p = mac_proposal(true, &off, &on, None, 2).unwrap();
    assert!(mac_lowers(p.mac.as_ref().unwrap()));
    assert!(proposal_lowers(
        &p,
        &policy::migrate(&[]),
        &[],
        Level::Judgement
    ));
    assert!(summary(&p.groups).contains("may sleep again"));

    // One on among offs is still a card.
    let mixed = MacChange {
        keep_awake: Some(true),
        open_at_login: Some(false),
        ..Default::default()
    };
    let p = mac_proposal(true, &mixed, &on, None, 2).unwrap();
    // Already awake: only the off is kept, so it's a line.
    assert_eq!(p.mac.as_ref().unwrap().keep_awake, None);
    assert!(mac_lowers(p.mac.as_ref().unwrap()));
}

#[test]
fn only_an_admin_proposes_the_macs_switches_and_only_where_they_exist() {
    let now = MacNow {
        stay_on_supported: true,
        open_at_login_available: false,
        ..Default::default()
    };
    let awake = MacChange {
        keep_awake: Some(true),
        ..Default::default()
    };
    assert!(mac_proposal(false, &awake, &now, None, 1)
        .unwrap_err()
        .contains("Only an admin"));
    let login = MacChange {
        open_at_login: Some(true),
        ..Default::default()
    };
    assert!(mac_proposal(true, &login, &now, None, 1)
        .unwrap_err()
        .contains("isn't available in this build"));
    let elsewhere = MacNow::default();
    assert!(mac_proposal(true, &awake, &elsewhere, None, 1)
        .unwrap_err()
        .contains("can't be held awake"));
    let keep = MacChange {
        keep_running: Some(true),
        ..Default::default()
    };
    assert!(mac_proposal(true, &keep, &now, None, 1)
        .unwrap_err()
        .contains("only offered on macOS"));
    // Nothing would change.
    let already = MacNow {
        keep_awake: true,
        ..now
    };
    assert!(mac_proposal(true, &awake, &already, None, 1)
        .unwrap_err()
        .contains("already how it is"));
    // The tool offers them, and old cards still read.
    let s = schema().to_string();
    for k in MAC_KEYS {
        assert!(s.contains(k), "{k}");
    }
    let v = serde_json::to_value(
        mac_proposal(
            true,
            &awake,
            &MacNow {
                stay_on_supported: true,
                ..Default::default()
            },
            None,
            1,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(v["mac"]["keepAwake"], true);
    assert!(v.get("grants").is_none());
}

/* ------------------------------------------- an app already connected */

#[test]
fn an_app_is_found_by_name_however_spelled_and_by_account_when_there_are_two() {
    let one = vec![linear("c1", "sam@acme.com", &[])];
    assert_eq!(find_connection(&one, "Linear", None).unwrap().id, "c1");
    assert_eq!(find_connection(&one, "linear", None).unwrap().id, "c1");
    assert!(find_connection(&one, "Notion", None)
        .unwrap_err()
        .contains("request_login"));
    let two = vec![
        linear("c1", "sam@acme.com", &[]),
        linear("c2", "Personal", &[]),
    ];
    assert!(find_connection(&two, "Linear", None)
        .unwrap_err()
        .contains("say which with `account`"));
    assert_eq!(
        find_connection(&two, "Linear", Some("acme")).unwrap().id,
        "c1"
    );
    assert!(find_connection(&two, "Linear", Some("work"))
        .unwrap_err()
        .contains("no Linear account matching"));
}

#[test]
fn giving_an_app_is_a_card_and_taking_it_away_is_a_line() {
    let list = vec![linear("c1", "sam@acme.com", &[])];
    let yes = |_: &str, _: &Connection| true;
    let give = grant_changes(
        &to("out"),
        &ask(json!({ "give": ["Linear"] })),
        &list,
        yes,
        named,
    )
    .unwrap();
    assert_eq!(give.len(), 1);
    assert_eq!(
        give[0].access,
        Some(Access::Read),
        "read unless asked for more"
    );
    assert_eq!(give[0].before, None);
    assert_eq!(give[0].line, "Can use Linear (sam@acme.com), read only");
    assert!(!give[0].lowers());
    let p = Proposal {
        targets: to("out"),
        change: Change::default(),
        version: 0,
        groups: Vec::new(),
        why: None,
        has_rules: false,
        mac: None,
        grants: give,
    };
    assert!(!proposal_lowers(
        &p,
        &policy::migrate(&[]),
        &[],
        Level::Judgement
    ));

    let full = grant_changes(
        &to("out"),
        &ask(json!({ "give": [{ "app": "Linear", "access": "full" }] })),
        &list,
        yes,
        named,
    )
    .unwrap();
    assert!(full[0].line.contains("asks you before it sends"));

    // Already has it: taking it away, or down to read, applies with a line.
    let had = vec![linear("c1", "sam@acme.com", &[("out", "full")])];
    let take = grant_changes(
        &to("out"),
        &ask(json!({ "take": ["Linear"] })),
        &had,
        yes,
        named,
    )
    .unwrap();
    assert_eq!(take[0].access, None);
    assert!(take[0].lowers());
    assert_eq!(take[0].line, "Can no longer use Linear (sam@acme.com)");
    let down = grant_changes(
        &to("out"),
        &ask(json!({ "give": [{ "app": "Linear", "access": "read" }] })),
        &had,
        yes,
        named,
    )
    .unwrap();
    assert!(down[0].lowers());
    let p = Proposal { grants: take, ..p };
    assert!(proposal_lowers(
        &p,
        &policy::migrate(&[]),
        &[],
        Level::Judgement
    ));

    // Nothing to change: left out.
    assert!(grant_changes(
        &to("out"),
        &ask(json!({ "give": [{ "app": "Linear", "access": "full" }] })),
        &had,
        yes,
        named
    )
    .unwrap()
    .is_empty());
}

#[test]
fn an_app_its_settings_hide_is_refused_and_the_team_isnt_given_one() {
    let list = vec![linear("c1", "sam@acme.com", &[])];
    let err = grant_changes(
        &to("out"),
        &ask(json!({ "give": ["Linear"] })),
        &list,
        |_, _| false,
        named,
    )
    .unwrap_err();
    assert!(err.contains("Outreach's settings keep it from Linear"));
    assert!(err.contains("apps"));
    let err = grant_changes(
        &[Target::Team { everyone: false }],
        &ask(json!({ "give": ["Linear"] })),
        &list,
        |_, _| true,
        named,
    )
    .unwrap_err();
    assert!(err.contains("agent by agent"));
    assert!(GrantAsk::parse(Some(
        &json!({ "give": [{ "app": "Linear", "access": "admin" }] })
    ))
    .is_err());
    // A settings change that allows the app makes the grant allowed.
    let mut saved = policy::migrate(&[]);
    saved.team.apps.mode = AppsMode::None;
    assert!(!policy::connection_allowed_in(
        &saved, "out", "linear", "Linear"
    ));
    saved.team.apps.mode = AppsMode::All;
    assert!(policy::connection_allowed_in(
        &saved, "out", "linear", "Linear"
    ));
}

#[test]
fn only_an_admin_gives_another_agent_an_app() {
    let chief = agent("m1", "Chief of Staff", true);
    let out = agent("out", "Outreach", false);
    // Not an admin: only for itself.
    assert!(may_propose(&out, false, &to("m1"), &Change::default()).is_err());
    assert!(may_propose(&out, false, &to("out"), &Change::default()).is_ok());
    assert!(may_propose(&chief, true, &to("out"), &Change::default()).is_ok());
}

#[test]
fn allow_applies_exactly_the_grant_shown_and_a_moved_one_applies_nothing() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let write = |c: &[Connection]| {
        std::fs::write(
            root.path().join("connections.json"),
            serde_json::to_string(&json!({ "connections": c })).unwrap(),
        )
        .unwrap()
    };
    write(&[linear("c1", "sam@acme.com", &[])]);
    let list = connections::list().unwrap();
    let grants = grant_changes(
        &to("out"),
        &ask(json!({ "give": ["Linear"] })),
        &list,
        |_, _| true,
        named,
    )
    .unwrap();
    let p = Proposal {
        targets: to("out"),
        change: Change::default(),
        version: 0,
        groups: Vec::new(),
        why: None,
        has_rules: false,
        mac: None,
        grants,
    };
    assert_eq!(apply_proposal(&p).unwrap(), None);
    let c = connections::get("c1").unwrap().unwrap();
    assert_eq!(c.grants.len(), 1);
    assert_eq!(c.grants[0].access, Access::Read);
    // The same card again: its access moved since, so nothing.
    assert!(apply_proposal(&p).unwrap_err().contains("changed after"));
    // Taken away again.
    let list = connections::list().unwrap();
    let take = grant_changes(
        &to("out"),
        &ask(json!({ "take": ["Linear"] })),
        &list,
        |_, _| true,
        named,
    )
    .unwrap();
    apply_proposal(&Proposal { grants: take, ..p }).unwrap();
    assert!(connections::get("c1").unwrap().unwrap().grants.is_empty());
    store::set_root_for_tests(None);
}

#[test]
fn grant_lines_join_the_agents_own_group_on_the_card() {
    let mut groups = vec![Group {
        who: "Outreach".into(),
        agent_ids: vec!["out".into()],
        changes: vec!["Can no longer use your browser".into()],
    }];
    let list = vec![linear("c1", "sam@acme.com", &[])];
    let g = grant_changes(
        &to("out"),
        &ask(json!({ "give": ["Linear"] })),
        &list,
        |_, _| true,
        named,
    )
    .unwrap();
    add_grant_lines(&mut groups, &g, named);
    assert_eq!(groups.len(), 1);
    assert_eq!(
        summary(&groups),
        "Outreach: Can no longer use your browser. Can use Linear (sam@acme.com), read only."
    );
    let mut fresh = Vec::new();
    add_grant_lines(&mut fresh, &g, named);
    assert_eq!(fresh[0].who, "Outreach");
}

/* ------------------------------------------------- what it runs on */

#[test]
fn model_and_effort_come_in_the_users_words_and_go_back_to_default() {
    assert_eq!(
        chat_model(Engine::Claude, "Opus").unwrap(),
        Some("opus".into())
    );
    assert_eq!(
        chat_model(Engine::Claude, "haiku").unwrap(),
        Some("haiku".into())
    );
    assert_eq!(chat_model(Engine::Claude, "default").unwrap(), None);
    assert!(chat_model(Engine::Claude, "gpt-9").is_err());
    // The app's own words for them (the menu's "Smartest · Opus").
    assert_eq!(
        chat_model(Engine::Claude, "Smartest").unwrap(),
        Some("opus".into())
    );
    assert_eq!(
        chat_model(Engine::Claude, " balanced ").unwrap(),
        Some("sonnet".into())
    );
    assert_eq!(
        chat_model(Engine::Claude, "Fastest").unwrap(),
        Some("haiku".into())
    );
    // Codex's models have no such families: the word isn't guessed at.
    assert!(chat_model(Engine::Codex, "Smartest").is_err());
    let r = run_settings(
        Engine::Claude,
        &json!({ "model": "Sonnet", "effort": "High" }),
    )
    .unwrap();
    assert_eq!(r.model, Some(Some("sonnet".into())));
    assert_eq!(r.effort, Some(Some("high".into())));
    assert_eq!(r.routine_model, None);
    assert_eq!(r.muted, None);
    let back = run_settings(
        Engine::Claude,
        &json!({ "effort": "default", "routine_model": "same", "muted": true }),
    )
    .unwrap();
    assert_eq!(back.effort, Some(None));
    assert_eq!(back.routine_model, Some(Some("same".into())));
    assert_eq!(back.muted, Some(true));
    assert_eq!(
        run_settings(Engine::Claude, &json!({ "routine_model": "auto" }))
            .unwrap()
            .routine_model,
        Some(None)
    );
    assert!(run_settings(Engine::Claude, &json!({ "effort": "max" })).is_err());
}

#[test]
fn what_it_runs_on_applies_with_a_line_not_a_card() {
    let mut a = agent("r1", "Research", false);
    let r = run_settings(
        Engine::Claude,
        &json!({ "model": "opus", "effort": "high", "muted": true }),
    )
    .unwrap();
    assert_eq!(
        r.changed(&a, false),
        vec!["model", "effort", "notifications"]
    );
    let before = a.clone();
    r.apply(&mut a);
    assert_eq!(a.model.as_deref(), Some("opus"));
    assert_eq!(a.effort.as_deref(), Some("high"));
    assert!(a.muted);
    // The chat's quiet line, as the editor leaves it.
    assert_eq!(
        crate::commands::agents::settings_line(&before, &a, false).as_deref(),
        Some("Now on Opus · High from its next message")
    );
    assert!(r.said(&before, &a)[0].contains("no notifications"));
    // Nothing changes: no audit lines.
    assert!(r.changed(&a, false).is_empty());
    // It is the Chief's (update_agent), and no card guards it outside a
    // "When…" turn: it changes what turns run on, never what they may do.
    let chief = agent("m1", "Chief of Staff", true);
    let names = crate::agents::mcp::tool_names(&chief);
    assert!(names.contains(&"update_agent".to_string()));
    assert!(!crate::agents::mcp::tool_names(&a).contains(&"update_agent".to_string()));
    assert!(crate::agents::mcp::needs_card_in_routine_turn(
        "update_agent"
    ));
}

#[test]
fn your_chrome_on_is_a_card_off_is_a_line_and_only_where_it_runs() {
    let now = MacNow {
        your_chrome_supported: true,
        ..Default::default()
    };
    let on = MacChange {
        your_chrome: Some(true),
        ..Default::default()
    };
    let p = mac_proposal(true, &on, &now, Some("let agents use my Chrome".into()), 3).unwrap();
    assert!(p.groups[0].changes[0].contains("your own Chrome"));
    assert!(!mac_lowers(p.mac.as_ref().unwrap()));
    // Already on, turning it off applies with a line.
    let was_on = MacNow {
        your_chrome: true,
        ..now.clone()
    };
    let off = MacChange {
        your_chrome: Some(false),
        ..Default::default()
    };
    let p = mac_proposal(true, &off, &was_on, None, 3).unwrap();
    assert!(mac_lowers(p.mac.as_ref().unwrap()));
    assert!(p.groups[0].changes[0].contains("no longer"));
    // Not an admin, or not on macOS: refused before a card.
    assert!(mac_proposal(false, &on, &now, None, 3).is_err());
    let elsewhere = MacNow::default();
    assert!(mac_proposal(true, &on, &elsewhere, None, 3)
        .unwrap_err()
        .contains("macOS"));
    // The tool's key reads it.
    assert_eq!(
        MacChange::from_args(&json!({ "your_chrome": true })).your_chrome,
        Some(true)
    );
    assert!(MAC_KEYS.contains(&"your_chrome"));
}

#[test]
fn independence_takes_the_names_on_the_slider_and_the_old_ones() {
    let schema = schema();
    let levels = schema["properties"]["changes"]["properties"]["independence"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    for name in [
        "careful",
        "steady",
        "bold",
        "unleashed",
        "often",
        "go_hard",
        "team",
    ] {
        assert!(levels.iter().any(|l| l == name), "{name}");
    }
    for name in ["careful", "steady", "bold", "unleashed"] {
        assert!(Level::parse(name).is_ok(), "{name}");
    }
}
