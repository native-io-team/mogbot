//! Settings from chat through the Chief's own tools: accounts, Slack, the
//! app's switches and disk space; and the usage settings' gate (spending
//! more is a card, holding back is a line). Fictional agents, accounts and
//! Slack conversations.

use super::*;
use crate::agents::crossover::Mode as Fallback;
use crate::agents::usage_plan::Mode;
use crate::agents::usage_tools::{fallback_lowers, mode_lowers};

fn agent(id: &str, name: &str, main: bool) -> store::Agent {
    let mut a: store::Agent = serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap();
    a.is_main = main;
    a
}

fn conv(id: &str, kind: &str, name: &str) -> Conversation {
    Conversation {
        id: id.into(),
        kind: kind.into(),
        name: name.into(),
    }
}

fn status(conversations: Vec<Conversation>) -> Status {
    Status {
        connected: true,
        team: Some("Acme".into()),
        user: Some("sam".into()),
        enabled: true,
        needs_sign_in: false,
        agent_id: Some("m1".into()),
        agent_name: Some("Chief of Staff".into()),
        conversations,
        trigger: "agent".into(),
        default_trigger: "agent".into(),
        others_can_start: false,
        last_check_at: None,
        last_error: None,
        waiting: 0,
        setup_url: String::new(),
        disconnected: None,
    }
}

/* ------------------------------------------------------------ who gets them */

#[test]
fn only_the_chief_is_served_them() {
    let chief = agent("m1", "Chief of Staff", true);
    let other = agent("f1", "Finance", false);
    let names = |a: &store::Agent| crate::agents::mcp::tool_names(a);
    for t in TOOLS {
        assert!(names(&chief).contains(&t.name.to_string()), "{}", t.name);
        assert!(!names(&other).contains(&t.name.to_string()), "{}", t.name);
    }
    // Every tool's schema is an object, and its words never name a secret value.
    for t in TOOLS {
        assert_eq!((t.schema)()["type"], "object");
        assert!(!t
            .description
            .to_lowercase()
            .contains("paste the token here"));
    }
}

/* ---------------------------------------------------------------- accounts */

#[test]
fn an_account_moves_where_the_user_says() {
    assert_eq!(move_to("first", 2, 3).unwrap(), 0);
    assert_eq!(move_to("last", 0, 3).unwrap(), 2);
    assert_eq!(move_to("up", 0, 3).unwrap(), 0);
    assert_eq!(move_to("down", 2, 3).unwrap(), 2);
    assert_eq!(move_to("2", 0, 3).unwrap(), 1);
    assert_eq!(move_to("9", 0, 3).unwrap(), 2);
    assert!(move_to("sideways", 0, 3).is_err());
    assert!(move_to("0", 0, 3).is_err());
    let ids: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
    assert_eq!(moved_order(&ids, "c", 0), ["c", "a", "b"]);
    assert_eq!(moved_order(&ids, "a", 2), ["b", "c", "a"]);
}

#[test]
fn runs_on_is_one_of_its_engines_accounts_or_any() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let work = wallet::add(Engine::Claude, "Work").unwrap();
    use crate::agents::mcp::runs_on_account;
    assert_eq!(
        runs_on_account(Engine::Claude, "Work").unwrap(),
        Some(work.id.clone())
    );
    assert_eq!(
        runs_on_account(Engine::Claude, "work").unwrap(),
        Some(work.id)
    );
    for any in ["any", "Any account", "default"] {
        assert_eq!(runs_on_account(Engine::Claude, any).unwrap(), None);
    }
    // Another engine's account, or none by that name: refused, never guessed.
    assert!(runs_on_account(Engine::Codex, "Work").is_err());
    assert!(runs_on_account(Engine::Claude, "Personal").is_err());
    store::set_root_for_tests(None);
}

/* ------------------------------------------------------------------ Slack */

#[test]
fn slack_conversations_are_found_by_the_names_the_user_says() {
    let all = vec![
        conv("C1", "channel", "#launch"),
        conv("D1", "self", "Your own DM"),
        conv("D2", "im", "Dana"),
    ];
    let got =
        resolve_conversations(&all, &["launch".into(), "#launch".into(), "my DM".into()]).unwrap();
    assert_eq!(
        got.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["C1", "D1"]
    );
    assert_eq!(
        resolve_conversations(&all, &["@dana".into()]).unwrap()[0].id,
        "D2"
    );
    let e = resolve_conversations(&all, &["#random".into()]).unwrap_err();
    assert!(e.contains("#random") && e.contains("#launch"), "{e}");
}

#[test]
fn more_room_in_slack_is_a_card_and_less_is_a_line() {
    let now = status(vec![conv("C1", "channel", "#launch")]);
    let none = Patch::default();
    // Adding a conversation: a card.
    let add = Patch {
        conversations: Some(vec![
            conv("C1", "channel", "#launch"),
            conv("C2", "channel", "#ops"),
        ]),
        ..Patch::default()
    };
    assert!(slack_widens(&now, &add, None));
    assert_eq!(slack_lines(&now, &add, None, None), ["Listens in #ops"]);
    // Taking one away: a line.
    let remove = Patch {
        conversations: Some(Vec::new()),
        ..Patch::default()
    };
    assert!(!slack_widens(&now, &remove, None));
    assert_eq!(
        slack_lines(&now, &remove, None, None),
        ["No longer listens in #launch"]
    );
    // Letting others in: a card; turning it off: a line.
    let others = Patch {
        others_can_start: Some(true),
        ..Patch::default()
    };
    assert!(slack_widens(&now, &others, None));
    let off = Patch {
        enabled: Some(false),
        ..Patch::default()
    };
    assert!(!slack_widens(&now, &off, None));
    assert!(slack_lines(&now, &off, None, None)[0].contains("paused"));
    // Another agent answering: a card; the one answering now: nothing.
    assert!(slack_widens(&now, &none, Some("f1")));
    assert_eq!(
        slack_lines(&now, &none, Some("f1"), Some("Finance")),
        ["Finance answers in Slack"]
    );
    assert!(!slack_widens(&now, &none, Some("m1")));
    assert!(slack_lines(&now, &none, Some("m1"), None).is_empty());
    // A new trigger word is a line.
    let trigger = Patch {
        trigger: Some("hey".into()),
        ..Patch::default()
    };
    assert!(!slack_widens(&now, &trigger, None));
    assert!(slack_lines(&now, &trigger, None, None)[0].contains("“hey”"));
}

/* --------------------------------------------------------- app and disk */

#[test]
fn the_apps_switches_say_what_they_did() {
    assert_eq!(theme_line("dark"), "The app is dark now");
    assert_eq!(
        theme_line("system"),
        "The app follows the Mac's appearance now"
    );
    assert!(slow_line(false).contains("usual pace"));
    assert!(slow_line(true).contains("slow down"));
}

#[test]
fn freeing_space_says_how_much_and_who_was_skipped() {
    assert_eq!(freed_line(0, &[]), "Nothing to free in agents' folders");
    assert_eq!(
        freed_line(2_400_000_000, &[]),
        "Freed 2.4 GB in agents' folders"
    );
    assert_eq!(
        freed_line(30_000_000, &[]),
        "Freed 30 MB in agents' folders"
    );
    assert_eq!(
        freed_line(0, &["Research".into()]),
        "Nothing to free in agents' folders; skipped Research (working now)"
    );
}

/* ------------------------------------------------------------- usage gate */

#[test]
fn holding_back_usage_is_a_line_and_spending_more_is_a_card() {
    assert!(mode_lowers(Mode::Normal, Mode::Save));
    assert!(mode_lowers(Mode::UseItAll, Mode::Save));
    assert!(mode_lowers(Mode::UseItAll, Mode::Normal));
    assert!(!mode_lowers(Mode::Save, Mode::Normal));
    assert!(!mode_lowers(Mode::Normal, Mode::UseItAll));
    assert!(!mode_lowers(Mode::Save, Mode::Save));
    // Carrying on with the other engine spends more; waiting or asking doesn't.
    assert!(!fallback_lowers(Fallback::Ask, Fallback::Carry));
    assert!(fallback_lowers(Fallback::Carry, Fallback::Wait));
    assert!(fallback_lowers(Fallback::Carry, Fallback::Ask));
}

/// Keeping full pace on battery spends the battery: off from on is more
/// room (a card unless the user's own message asked); on, or off from off,
/// is not.
#[test]
fn slow_on_battery_off_is_more_room() {
    assert!(slow_widens(true, Some(false)));
    assert!(!slow_widens(true, Some(true)));
    assert!(!slow_widens(false, Some(false)));
    assert!(!slow_widens(true, None));
}

/// The account card says what changes, in the user's names.
#[test]
fn the_account_card_says_what_changes() {
    let detail = account_card_detail(&serde_json::json!({
        "action": "move", "account": "Personal", "to": "first"
    }));
    assert_eq!(
        detail,
        "Move “Personal” to first in the order turns try accounts"
    );
    let detail = account_card_detail(&serde_json::json!({
        "action": "add", "engine": "codex", "name": "Side project"
    }));
    assert!(detail.contains("“Side project”"), "{detail}");
}

#[test]
fn settings_pages_are_named_and_offered() {
    for page in SETTINGS_PAGES {
        assert!(settings_page_title(page).is_some(), "{page} has a title");
    }
    assert_eq!(settings_page_title("phone"), Some("Phone"));
    assert_eq!(settings_page_title("nowhere"), None);
    let def = find("open_settings").expect("the Chief can open a page");
    let schema = (def.schema)();
    assert_eq!(
        schema["properties"]["page"]["enum"]
            .as_array()
            .unwrap()
            .len(),
        SETTINGS_PAGES.len()
    );
}
