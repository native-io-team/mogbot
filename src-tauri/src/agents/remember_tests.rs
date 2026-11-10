//! `remember_permission` against fictional cards and a fictional Mac: what a
//! user's "you can always do those" may record, what it never covers, the
//! cards it answers, and Undo. Provenance from the runner's side is in
//! `remember_runner_tests.rs`.

use super::*;
use serde_json::json;

const HOME: &str = "/Users/fictional-tester";
const UPSERT: &str = "mcp__native-os__upsertSocialPosts";
const SEND: &str = "mcp__fictionalmail__send_email";

fn ctx() -> Ctx {
    let app = format!("{HOME}/Library/Application Support/FictionalApp");
    let own = format!("{app}/agents/a1");
    Ctx {
        home: HOME.into(),
        own_home: own.clone().into(),
        cwd: own.clone().into(),
        scratch: vec![own.into()],
        app_data: vec![app.into()],
        secrets: Vec::new(),
        packages: Vec::new(),
        team_reader: false,
        full_send: false,
    }
}

fn card(id: &str, tool: &str, input: Value) -> Approval {
    super::super::mcp::new_card(
        id.into(),
        "Use a tool".into(),
        String::new(),
        Some((tool, &input)),
    )
}

fn in_chat(cards: Vec<Approval>) -> Vec<AgentMessage> {
    cards
        .into_iter()
        .map(|a| {
            let mut m = runner::new_message("a1", MessageKind::Approval, "");
            m.approval = Some(a);
            m
        })
        .collect()
}

fn args(pattern: &str, quote: &str) -> Value {
    json!({ "tool_or_pattern": pattern, "quote": quote })
}

fn posts() -> Value {
    json!({ "posts": [{ "id": "p1", "status": "draft" }] })
}

const SAID: &str = "Always a lot to do with those\nur always allowed to do those i mean";

#[test]
fn the_users_words_and_a_card_they_saw_make_a_rule() {
    let log = in_chat(vec![card("r1", UPSERT, posts())]);
    let plan = plan(
        Some(SAID),
        &args(UPSERT, "ur always allowed to do those"),
        &log,
        Some(&ctx()),
    )
    .unwrap();
    assert!(!plan.team);
    assert_eq!(plan.scope.kind, RuleKind::Tool);
    assert_eq!(plan.scope.value, UPSERT);
    assert_eq!(
        plan.scope.said.as_deref(),
        Some("ur always allowed to do those")
    );
    assert!(line("Lead Gen", &plan).starts_with("Remembered: Lead Gen can always "));
    // "team" names the team instead.
    let team = plan_for_team();
    assert!(team.team);
    assert!(line("Lead Gen", &team).starts_with("Remembered: the team can always "));
}

fn plan_for_team() -> Plan {
    let log = in_chat(vec![card("r1", UPSERT, posts())]);
    let mut a = args(UPSERT, "always allowed to do those");
    a["scope"] = json!("team");
    plan(Some(SAID), &a, &log, Some(&ctx())).unwrap()
}

#[test]
fn not_typed_by_the_user_records_nothing() {
    let log = in_chat(vec![card("r1", UPSERT, posts())]);
    // Another agent's message, a routine, outside text: no typed words.
    assert_eq!(
        plan(None, &args(UPSERT, "always allowed"), &log, Some(&ctx())),
        Err(NOT_TYPED.to_string())
    );
}

#[test]
fn the_quote_must_be_what_they_typed() {
    let log = in_chat(vec![card("r1", UPSERT, posts())]);
    for quote in [
        "you may always send email",
        "",
        "ur",
        "always allowed to do those things",
    ] {
        assert_eq!(
            plan(Some(SAID), &args(UPSERT, quote), &log, Some(&ctx())),
            Err(NOT_QUOTED.to_string()),
            "{quote:?}"
        );
    }
    // Punctuation and case don't matter; whole words do.
    assert!(quoted("UR always, allowed!", SAID));
    assert!(!quoted("always allow", SAID));
}

#[test]
fn only_a_card_in_this_chat_and_nothing_broader() {
    let log = in_chat(vec![
        card("r1", UPSERT, posts()),
        card("r2", "Bash", json!({ "command": "npm test -- --run" })),
    ]);
    for wanted in [
        "Bash",
        "Bash *",
        "*",
        "mcp__native-os__*",
        "mcp__native-os__deleteAll",
        "npm",
    ] {
        let err = plan(
            Some(SAID),
            &args(wanted, "always allowed"),
            &log,
            Some(&ctx()),
        )
        .unwrap_err();
        assert!(err.starts_with("No card in this chat"), "{wanted}: {err}");
    }
    // The command's own scope, as the card offered it.
    let plan = plan(
        Some(SAID),
        &args("npm test", "always allowed"),
        &log,
        Some(&ctx()),
    )
    .unwrap();
    assert_eq!(
        (plan.scope.kind, plan.scope.value.as_str()),
        (RuleKind::CommandPrefix, "npm test")
    );
    // A card that offered no "Always" (Ship Studio's own confirmation) has none to take.
    let confirm = in_chat(vec![super::super::mcp::new_card(
        "c1".into(),
        "Delete Finance".into(),
        String::new(),
        None,
    )]);
    assert!(plan_err(&confirm, "Delete Finance").starts_with("No card"));
}

fn plan_err(log: &[AgentMessage], wanted: &str) -> String {
    plan(
        Some(SAID),
        &args(wanted, "always allowed"),
        log,
        Some(&ctx()),
    )
    .unwrap_err()
}

#[test]
fn the_floor_can_never_be_remembered() {
    let log = in_chat(vec![
        card("s1", SEND, json!({ "to": "client@example.com" })),
        card("s2", "mcp__fictionalpay__create_refund", json!({})),
        card("s3", "mcp__fictionalcms__deletePosts", json!({})),
        card("s4", "mcp__fictionalvault__get_api_key", json!({})),
        card(
            "s5",
            "mcp__claude-in-chrome__computer",
            json!({ "action": "left_click" }),
        ),
        card("b1", "Bash", json!({ "command": "git push origin main" })),
        card("b2", "Bash", json!({ "command": "sudo launchctl list" })),
        card("b3", "Bash", json!({ "command": "vercel deploy --prod" })),
        card(
            "b4",
            "Bash",
            json!({ "command": "rm -rf /Users/fictional-tester/Documents" }),
        ),
    ]);
    for (wanted, why) in [
        (SEND, "sends as the user"),
        ("mcp__fictionalpay__create_refund", "money"),
        ("mcp__fictionalcms__deletePosts", "deletes"),
        ("mcp__fictionalvault__get_api_key", "credentials"),
        ("git push", "pushing"),
        ("sudo launchctl list", "sudo"),
        ("vercel deploy", "deploying"),
        (
            "rm -rf /Users/fictional-tester/Documents",
            "deleting their data",
        ),
    ] {
        assert_eq!(plan_err(&log, wanted), ON_THE_FLOOR, "{wanted}: {why}");
    }
    // The user's browser: its cards never offer Always, so there is no
    // scope to name, and the floor would refuse it anyway.
    let browser = plan_err(&log, "mcp__claude-in-chrome__computer");
    assert!(browser.contains("Nothing was recorded"), "{browser}");
    assert!(super::super::go_hard::floor(
        "mcp__claude-in-chrome__computer",
        &json!({ "action": "left_click" }),
        &ctx()
    ));
    // No context to judge by: refused, never assumed safe.
    let ok = in_chat(vec![card("r1", UPSERT, posts())]);
    assert_eq!(
        plan(Some(SAID), &args(UPSERT, "always allowed"), &ok, None),
        Err(ON_THE_FLOOR.to_string())
    );
}

#[test]
fn updating_the_users_own_records_is_off_the_floor() {
    let c = ctx();
    for tool in [
        UPSERT,
        "mcp__fictionalcrm__update_contact",
        "mcp__fictionalcms__createDraft",
    ] {
        assert!(
            !super::super::go_hard::floor(tool, &json!({}), &c),
            "{tool}"
        );
    }
    assert!(!super::super::go_hard::floor("WebSearch", &json!({}), &c));
    assert!(!super::super::go_hard::floor(
        "Bash",
        &json!({ "command": "npm test" }),
        &c
    ));
}

fn rule(id: &str, scope: Scope) -> Rule {
    Rule {
        id: id.into(),
        scope,
        created_at: 0,
        extra: Default::default(),
    }
}

fn scope(kind: RuleKind, value: &str, said: Option<&str>) -> Scope {
    Scope {
        kind,
        value: value.into(),
        label: value.into(),
        said: said.map(str::to_string),
    }
}

#[test]
fn a_remembered_rule_still_asks_on_the_floor_whatever_it_says() {
    let c = ctx();
    let push = json!({ "command": "git push origin main" });
    // Written by hand (or by an older build) for a push: it never covers one.
    let said = [rule(
        "r",
        scope(RuleKind::CommandPrefix, "git push", Some("always push")),
    )];
    assert!(covering(&said, &[], "Bash", &push, Some(&c)).is_none());
    // A team rule is held to the floor, said or not.
    let team = [rule("t", scope(RuleKind::CommandPrefix, "git push", None))];
    assert!(covering(&[], &team, "Bash", &push, Some(&c)).is_none());
    let send = [rule("m", scope(RuleKind::Tool, SEND, None))];
    assert!(covering(&[], &send, SEND, &json!({}), Some(&c)).is_none());
    // The user's own Always on a card is theirs: unchanged.
    let chosen = [rule("k", scope(RuleKind::CommandPrefix, "git push", None))];
    assert!(covering(&chosen, &[], "Bash", &push, Some(&c)).is_some());
    // Off the floor, a remembered rule covers the call; without a context it covers nothing.
    let upsert = [rule("u", scope(RuleKind::Tool, UPSERT, Some("always")))];
    assert!(covering(&upsert, &[], UPSERT, &posts(), Some(&c)).is_some());
    assert!(covering(&upsert, &[], UPSERT, &posts(), None).is_none());
    assert!(covering(&[], &upsert, UPSERT, &posts(), Some(&c)).is_some());
    assert!(covering(&upsert, &[], SEND, &json!({}), Some(&c)).is_none());
}

#[test]
fn waiting_cards_it_covers_are_answered_and_no_others() {
    let c = ctx();
    let mut answered = card("done", UPSERT, posts());
    answered.status = ApprovalStatus::Denied;
    let open = vec![
        card("w1", UPSERT, posts()),
        card("w2", UPSERT, json!({ "posts": [] })),
        card("w3", SEND, json!({ "to": "a@example.com" })),
        card("w4", "Bash", json!({ "command": "npm test" })),
        answered,
    ];
    let plan = plan(
        Some(SAID),
        &args(UPSERT, "always allowed"),
        &in_chat(vec![card("r1", UPSERT, posts())]),
        Some(&c),
    )
    .unwrap();
    assert_eq!(covered(&plan.scope, &open, Some(&c)), vec!["w1", "w2"]);
    assert!(covered(&plan.scope, &open, None).is_empty());
    // Even a rule naming a send tool answers no send card.
    let send = scope(RuleKind::Tool, SEND, Some("always"));
    assert!(covered(&send, &open, Some(&c)).is_empty());
}

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str) -> Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn remembered_line(agent_id: &str, rule_id: &str, team: bool) -> AgentMessage {
    let mut m = runner::new_message(agent_id, MessageKind::Note, "Remembered: …");
    m.remembered = Some(Remembered {
        rule_id: rule_id.into(),
        team,
        active: true,
    });
    m
}

#[test]
fn undo_takes_the_rule_back_and_the_line_says_so() {
    scratch(|| {
        let lead = agent("Lead Gen");
        let p = Plan {
            scope: scope(RuleKind::Tool, UPSERT, Some("always allowed")),
            team: false,
        };
        let id = record(&lead.id, &p).unwrap().expect("a new rule");
        // The same rule again is nothing new.
        assert_eq!(record(&lead.id, &p).unwrap(), None);
        let me = store::get(&lead.id).unwrap();
        assert!(covers(&me, UPSERT, &posts()));
        let mut page = vec![remembered_line(&lead.id, &id, false)];
        apply(&lead.id, &mut page);
        assert!(page[0].remembered.as_ref().unwrap().active);

        assert!(forget(&lead.id, &id).unwrap());
        assert!(!covers(&store::get(&lead.id).unwrap(), UPSERT, &posts()));
        apply(&lead.id, &mut page);
        assert!(!page[0].remembered.as_ref().unwrap().active);
        // Undo twice: nothing more to take back.
        assert!(!forget(&lead.id, &id).unwrap());
    });
}

#[test]
fn a_team_rule_covers_every_agent_until_undone() {
    scratch(|| {
        let lead = agent("Lead Gen");
        let other = agent("Social");
        let p = Plan {
            scope: scope(RuleKind::Tool, UPSERT, Some("you all can always do those")),
            team: true,
        };
        let id = record(&lead.id, &p).unwrap().expect("a new rule");
        assert!(store::get(&lead.id).unwrap().permissions.is_empty());
        assert!(covers(&store::get(&other.id).unwrap(), UPSERT, &posts()));
        let mut page = vec![remembered_line(&lead.id, &id, true)];
        apply(&lead.id, &mut page);
        assert!(page[0].remembered.as_ref().unwrap().active);

        assert!(forget(&lead.id, &id).unwrap());
        assert!(!covers(&store::get(&other.id).unwrap(), UPSERT, &posts()));
        apply(&lead.id, &mut page);
        assert!(!page[0].remembered.as_ref().unwrap().active);
    });
}

#[test]
fn always_on_the_card_later_makes_the_rule_the_cards() {
    scratch(|| {
        let lead = agent("Lead Gen");
        let p = Plan {
            scope: scope(RuleKind::Tool, UPSERT, Some("always allowed")),
            team: false,
        };
        record(&lead.id, &p).unwrap();
        let c = card("r9", UPSERT, posts());
        super::super::mcp::always_allow(&lead.id, &c).unwrap();
        let rules = store::get(&lead.id).unwrap().permissions;
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].scope.said, None);
    });
}
