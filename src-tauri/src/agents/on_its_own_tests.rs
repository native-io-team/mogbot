use super::*;
use crate::agents::connections::Kind as ConnKind;
use crate::agents::permissions::{RuleKind, Scope};
use crate::agents::plan_grant::{self, Kind as PlanKind, Plan, PlanAction};

fn agent(json: Value) -> Agent {
    serde_json::from_value(json).unwrap()
}

fn rule(id: &str, kind: RuleKind, value: &str, said: Option<&str>) -> Rule {
    Rule {
        id: id.into(),
        scope: Scope {
            kind,
            value: value.into(),
            label: value.into(),
            said: said.map(Into::into),
        },
        created_at: 1,
        extra: Default::default(),
    }
}

fn facts(a: Agent) -> Facts {
    Facts {
        agent: a,
        level: Level::GoHard,
        own_level: false,
        exact_text: false,
        team_rules: Vec::new(),
        plans: Vec::new(),
        names: Vec::new(),
        apps: Vec::new(),
        browser: BrowserFact::default(),
        admin: false,
        pinned_account: None,
        slack: None,
    }
}

fn plain() -> Agent {
    agent(json!({ "id": "a1", "name": "Finance", "shape": 0, "color": "red", "createdAt": 0 }))
}

#[test]
fn the_level_lines_are_the_sliders_own_words() {
    let ts = include_str!("../../../packages/companion-protocol/src/independence.ts");
    for level in [
        Level::Often,
        Level::Judgement,
        Level::GoHard,
        Level::FullSend,
    ] {
        assert!(
            ts.contains(level_line(level)),
            "independence.ts and on_its_own.rs disagree on {}",
            level.label()
        );
    }
    assert!(ts.contains(ALWAYS_ASKS));
}

#[test]
fn a_bare_agent_says_its_level_the_floor_and_its_accounts_only() {
    let v = build(&facts(plain()));
    assert_eq!(v.level, Level::GoHard);
    assert_eq!(v.level_line, level_line(Level::GoHard));
    assert_eq!(v.always_asks, vec![ALWAYS_ASKS.to_string()]);
    assert_eq!(v.items.len(), 1);
    assert_eq!(v.items[0].kind, Kind::Account);
    assert_eq!(
        v.items[0].text,
        "Spends your Claude Code accounts, in your order"
    );
    // Which account it spends is shown, never taken away here (that could widen it).
    assert!(v.items[0].narrow.is_empty());
}

#[test]
fn every_standing_rule_is_listed_in_plain_words_with_its_way_off() {
    let mut a = plain();
    a.permissions = vec![
        rule("r1", RuleKind::CommandPrefix, "npm test", None),
        rule(
            "r2",
            RuleKind::Tool,
            "Post · Native OS",
            Some("ur always allowed to do those"),
        ),
    ];
    let mut f = facts(a);
    f.team_rules = vec![rule(
        "t1",
        RuleKind::Domain,
        "example.com",
        Some("all of you can"),
    )];
    f.plans = vec![Held {
        id: "g1".into(),
        actions: vec![
            ("Redeploy shippy".into(), true),
            ("Open an issue".into(), false),
        ],
        holders: vec!["a1".into(), "a2".into()],
        expires_at: 10_000_000,
    }];
    f.names = vec![("a2".into(), "Builder".into())];
    f.apps = vec![
        AppFact {
            connection_id: "c1".into(),
            title: "Gmail".into(),
            account: "sam@acme.com".into(),
            access: Access::Full,
            needs_sign_in: false,
        },
        AppFact {
            connection_id: "c2".into(),
            title: "Linear".into(),
            account: "Linear".into(),
            access: Access::Read,
            needs_sign_in: true,
        },
    ];
    f.browser = BrowserFact {
        claude_in_chrome: false,
        your_chrome: true,
        agents_browser: true,
    };
    f.admin = true;
    f.pinned_account = Some("Work".into());
    f.exact_text = true;
    f.slack = Some(SlackFact { by_itself: false });
    let v = build(&f);
    let by = |key: &str| v.items.iter().find(|i| i.key == key).unwrap();

    assert_eq!(by("rule:r1").text, "Run npm test");
    assert_eq!(by("rule:r1").kind, Kind::Rule);
    assert_eq!(by("rule:r2").kind, Kind::Said);
    assert!(by("rule:r2")
        .detail
        .as_ref()
        .unwrap()
        .contains("“ur always allowed to do those”"));
    assert_eq!(by("rule:t1").kind, Kind::TeamRule);
    assert_eq!(by("rule:t1").text, "Open pages on example.com");

    let plan = by("plan:g1");
    assert_eq!(plan.text, "Redeploy shippy (done); Open an issue");
    assert_eq!(plan.ends_at, Some(10_000_000));
    assert!(plan.detail.as_ref().unwrap().ends_with("also for Builder"));

    let gmail = by("app:c1");
    assert_eq!(gmail.text, "Uses Gmail (sam@acme.com)");
    assert_eq!(
        gmail.narrow.len(),
        2,
        "full access can go, or go down to read"
    );
    let linear = by("app:c2");
    assert_eq!(linear.text, "Uses Linear");
    assert_eq!(
        linear.narrow.len(),
        1,
        "read only has nothing narrower but gone"
    );
    assert!(linear
        .detail
        .as_ref()
        .unwrap()
        .contains("needs signing in again"));

    assert!(
        by("browser").text.contains("your Chrome")
            && by("browser").text.contains("agents’ own browser")
    );
    assert!(by("browser")
        .detail
        .as_ref()
        .unwrap()
        .starts_with("Through the app’s Chrome extension"));
    assert_eq!(by("admin").narrow, vec![Narrow::Admin]);
    assert_eq!(
        by("account").text,
        "Spends only your Work account (Claude Code)"
    );
    assert!(
        by("slack").narrow.is_empty(),
        "a reply that's already a card has nothing to take"
    );
    assert_eq!(
        v.always_asks,
        vec![ALWAYS_ASKS.to_string(), EXACT_TEXT.to_string()]
    );
}

#[test]
fn slack_by_itself_can_be_held_for_the_exact_words() {
    let mut f = facts(plain());
    f.level = Level::FullSend;
    f.slack = Some(SlackFact { by_itself: true });
    let v = build(&f);
    let slack = v.items.iter().find(|i| i.kind == Kind::Slack).unwrap();
    assert_eq!(slack.text, "Replies in Slack by itself, under your name");
    assert_eq!(slack.narrow, vec![Narrow::ExactText]);
}

#[test]
fn no_browser_means_no_browser_line() {
    assert!(browser_item(&BrowserFact::default()).is_none());
    let only_agents = browser_item(&BrowserFact {
        agents_browser: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(only_agents.text, "Opens pages in the agents’ own browser");
}

#[test]
fn no_narrow_gives_anything() {
    // The wire names: every one takes something away.
    for (n, kind) in [
        (
            Narrow::Rule {
                rule_id: "x".into(),
            },
            "rule",
        ),
        (
            Narrow::Plan {
                grant_id: "x".into(),
            },
            "plan",
        ),
        (
            Narrow::App {
                connection_id: "x".into(),
            },
            "app",
        ),
        (
            Narrow::AppReadOnly {
                connection_id: "x".into(),
            },
            "app_read_only",
        ),
        (Narrow::Browser, "browser"),
        (Narrow::Admin, "admin"),
        (Narrow::ExactText, "exact_text"),
    ] {
        assert_eq!(serde_json::to_value(&n).unwrap()["kind"], kind);
    }
    // Anything else is refused at the door.
    assert!(serde_json::from_value::<Narrow>(json!({ "kind": "browser_on" })).is_err());
    assert!(serde_json::from_value::<Narrow>(json!({ "kind": "admin_on" })).is_err());
}

#[test]
fn the_agent_reads_it_in_words_with_time_left() {
    let mut f = facts(plain());
    f.plans = vec![Held {
        id: "g".into(),
        actions: vec![("Push fix/copy".into(), false)],
        holders: vec!["a1".into()],
        expires_at: 42 * 60_000,
    }];
    let said = describe(&build(&f), 0);
    assert!(
        said.starts_with("Finance is on Bold (the team's level): Does local work"),
        "{said}"
    );
    assert!(said.contains(ALWAYS_ASKS));
    assert!(
        said.contains("- Push fix/copy (A plan you said yes to), about 42 minutes left"),
        "{said}"
    );
}

/* ---------------------------------------------------- against the stores */

fn with_root<F: FnOnce()>(f: F) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn made(name: &str, main: bool) -> Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: main,
    })
    .unwrap()
}

#[test]
fn each_narrow_applies_at_once_and_only_when_offered() {
    with_root(|| {
        let chief = made("Chief of Staff", true);
        let a = made("Outreach", false);
        store::update(&a.id, |x| {
            x.permissions
                .push(rule("r1", RuleKind::CommandPrefix, "npm test", None))
        })
        .unwrap();
        let c = connections::add_and_grant(
            "gmail",
            "Gmail",
            "sam@acme.com",
            ConnKind::ClaudeAi {
                server_name: "claude.ai Gmail".into(),
            },
            &a.id,
            Access::Full,
        )
        .unwrap();
        plan_grant::grant(
            &a.id,
            &Plan {
                actions: vec![PlanAction {
                    kind: PlanKind::Push,
                    target: "acme/site".into(),
                    summary: "Push fix/copy".into(),
                    text: None,
                }],
                why: None,
            },
            store::now_ms(),
        );
        let before = view(&store::get(&a.id).unwrap());
        assert!(before.items.iter().any(|i| i.key == "rule:r1"));

        // Something it doesn't have is refused, with nothing changed.
        assert!(narrow(&a.id, &Narrow::Admin).is_err());
        assert!(narrow(
            &a.id,
            &Narrow::Rule {
                rule_id: "nope".into()
            }
        )
        .is_err());
        // Another agent's rule can't be taken through this one.
        assert!(narrow(
            &chief.id,
            &Narrow::Rule {
                rule_id: "r1".into()
            }
        )
        .is_err());

        let line = narrow(
            &a.id,
            &Narrow::Rule {
                rule_id: "r1".into(),
            },
        )
        .unwrap();
        assert_eq!(line, "Taken back: Run npm test. It asks again.");
        assert!(store::get(&a.id).unwrap().permissions.is_empty());

        let line = narrow(
            &a.id,
            &Narrow::AppReadOnly {
                connection_id: c.id.clone(),
            },
        )
        .unwrap();
        assert!(
            line.starts_with("Uses Gmail (sam@acme.com): read only now"),
            "{line}"
        );
        assert_eq!(connections::granted_to(&a.id)[0].1, Access::Read);
        // Read only offers no read-only again.
        assert!(narrow(
            &a.id,
            &Narrow::AppReadOnly {
                connection_id: c.id.clone()
            }
        )
        .is_err());
        narrow(
            &a.id,
            &Narrow::App {
                connection_id: c.id.clone(),
            },
        )
        .unwrap();
        assert!(connections::granted_to(&a.id).is_empty());

        let plan = plan_grant::held_by(&a.id, store::now_ms());
        assert_eq!(plan.len(), 1);
        let line = narrow(
            &a.id,
            &Narrow::Plan {
                grant_id: plan[0].id.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            line,
            "Plan taken back: Push fix/copy. Those steps ask again."
        );
        assert!(!plan_grant::holds(&a.id, store::now_ms()));

        // The Chief is an admin by default: that goes too.
        let line = narrow(&chief.id, &Narrow::Admin).unwrap();
        assert!(line.starts_with("Admin turned off"));
        assert!(!crate::agents::admin::is_admin(
            &store::get(&chief.id).unwrap()
        ));

        let after = view(&store::get(&a.id).unwrap());
        assert!(after
            .items
            .iter()
            .all(|i| matches!(i.kind, Kind::Account | Kind::Browser)));
    });
}

#[test]
fn a_team_rule_shows_on_every_agent_and_goes_for_all() {
    with_root(|| {
        let a = made("Outreach", false);
        let b = made("Builder", false);
        let scope = Scope {
            kind: RuleKind::Domain,
            value: "example.com".into(),
            label: "example.com".into(),
            said: Some("you can all read it".into()),
        };
        let id = crate::agents::remember::record(
            &a.id,
            &crate::agents::remember::Plan { scope, team: true },
        )
        .unwrap()
        .unwrap();
        let team = team_view().unwrap();
        assert_eq!(team.team_rules.len(), 1);
        assert_eq!(team.agents.len(), 2);
        assert!(view(&store::get(&b.id).unwrap())
            .items
            .iter()
            .any(|i| i.kind == Kind::TeamRule));
        let line = narrow(&b.id, &Narrow::Rule { rule_id: id }).unwrap();
        assert!(line.starts_with("Taken back for every agent"), "{line}");
        assert!(crate::agents::remember::team_rules().is_empty());
    });
}

#[test]
fn only_managers_read_teammates() {
    with_root(|| {
        let chief = made("Chief of Staff", true);
        let a = made("Outreach", false);
        assert!(call(&a, &json!({})).unwrap().starts_with("Outreach is on"));
        assert!(call(&a, &json!({ "agent": "Chief of Staff" })).is_err());
        assert!(call(&a, &json!({ "agent": "team" })).is_err());
        assert!(call(&chief, &json!({ "agent": "outreach" }))
            .unwrap()
            .starts_with("Outreach is on"));
        assert!(call(&chief, &json!({ "agent": "team" }))
            .unwrap()
            .starts_with("The team is on"));
        assert!(call(&chief, &json!({ "agent": "Nobody" })).is_err());
    });
}
