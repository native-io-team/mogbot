use super::*;
use crate::agents::engine::Engine;

fn with_root<F: FnOnce()>(f: F) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

// A fictional team.
fn agent(name: &str) -> Agent {
    let a = store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    store::update(&a.id, |x| x.engine = Engine::Claude).unwrap()
}

fn ask(service: &str) -> Ask {
    Ask {
        service: service.into(),
        why: "Pull the latest frames for the deck".into(),
        scopes: vec!["read".into()],
        ..Default::default()
    }
}

fn seen(a: &Agent, service: &str, status: ApprovalStatus, said: Option<&str>) -> Seen {
    Seen {
        agent_id: a.id.clone(),
        agent_name: a.name.clone(),
        request_id: format!("r-{}-{service}", a.name),
        status,
        login: logins::build(a, &ask(service)).unwrap(),
        said: said.map(str::to_string),
        at: 0,
    }
}

fn browser() -> Here {
    Here {
        browser: true,
        ..Default::default()
    }
}

#[test]
fn the_chain_runs_in_order_and_asks_last() {
    with_root(|| {
        let designer = agent("Designer");
        let r = logins::build(&designer, &ask("figma")).unwrap();
        let none = Tried::default();
        // Nothing here at all: a card.
        assert_eq!(
            decide(&designer, &r, &none, &Here::default(), &[]),
            Step::Ask
        );
        // The browser comes before any card.
        assert!(matches!(
            decide(&designer, &r, &none, &browser(), &[]),
            Step::Browser { ref site, .. } if site == "www.figma.com"
        ));
        // ...unless it showed a sign-in page.
        let out = Tried {
            signed_out: true,
            ..Default::default()
        };
        assert_eq!(decide(&designer, &r, &out, &browser(), &[]), Step::Ask);
        // Granted already beats the browser.
        connections::add_and_grant(
            "figma",
            "Figma",
            "sam@example.com",
            Kind::Oauth {
                server_url: "https://mcp.figma.com/mcp".into(),
            },
            &designer.id,
            Access::Read,
        )
        .unwrap();
        assert!(
            matches!(decide(&designer, &r, &none, &browser(), &[]), Step::Have(ref w) if w.contains("sam@example.com"))
        );
    });
}

#[test]
fn github_uses_this_macs_sign_in_before_anything_else() {
    with_root(|| {
        let dev = agent("Builder");
        let r = logins::build(&dev, &ask("github")).unwrap();
        let here = Here {
            gh: Some("sam-example".into()),
            browser: true,
            ..Default::default()
        };
        assert_eq!(
            decide(&dev, &r, &Tried::default(), &here, &[]),
            Step::Gh("sam-example".into())
        );
    });
}

#[test]
fn one_ask_per_service_team_wide() {
    with_root(|| {
        let designer = agent("Designer");
        let writer = agent("Writer");
        let r = logins::build(&writer, &ask("figma")).unwrap();
        let none = Tried::default();
        // Designer's card for Figma is waiting: Writer joins it.
        let team = [seen(&designer, "figma", ApprovalStatus::Pending, None)];
        assert!(matches!(
            decide(&writer, &r, &none, &Here::default(), &team),
            Step::Join { ref agent_name, .. } if agent_name == "Designer"
        ));
        // Answered no (or "Not needed"), for anyone: never asked again, not
        // even through the browser.
        let team = [seen(
            &designer,
            "figma",
            ApprovalStatus::Denied,
            Some("Not needed"),
        )];
        assert!(matches!(
            decide(&writer, &r, &none, &browser(), &team),
            Step::AlreadyDeclined { ref said, .. } if said == "Not needed"
        ));
        // Another service's card doesn't count.
        let team = [seen(&designer, "notion", ApprovalStatus::Pending, None)];
        assert_eq!(
            decide(&writer, &r, &none, &Here::default(), &team),
            Step::Ask
        );
        // An expired (covered) card doesn't block a new ask.
        let team = [seen(&designer, "figma", ApprovalStatus::Expired, None)];
        assert_eq!(
            decide(&writer, &r, &none, &Here::default(), &team),
            Step::Ask
        );
    });
}

#[test]
fn one_thing_at_a_time_per_agent() {
    with_root(|| {
        let designer = agent("Designer");
        let r = logins::build(&designer, &ask("notion")).unwrap();
        let team = [seen(&designer, "figma", ApprovalStatus::Pending, None)];
        assert!(matches!(
            decide(&designer, &r, &Tried::default(), &Here::default(), &team),
            Step::OneAtATime { ref title } if title == "Figma"
        ));
    });
}

#[test]
fn waiters_get_the_answer_and_never_more_than_it_allowed() {
    with_root(|| {
        add_waiter("req-1", "designer", "writer", Access::Full, false).unwrap();
        add_waiter("req-1", "designer", "writer", Access::Read, false).unwrap();
        // The card's own agent isn't its own waiter.
        add_waiter("req-1", "designer", "designer", Access::Read, false).unwrap();
        let w = load_waiters();
        let (owner, list) = w.cards.get("req-1").unwrap();
        assert_eq!(owner, "designer");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].access, Access::Full, "the most it asked for");
        assert_eq!(Access::Full.min_with(Access::Read), Access::Read);
        assert_eq!(take_waiters("req-1").len(), 1);
        assert!(take_waiters("req-1").is_empty());
    });
}

#[test]
fn every_reply_tells_the_agent_what_to_do_next() {
    let browser = reply(&Step::Browser {
        site: "www.figma.com".into(),
        title: "Figma".into(),
    });
    assert!(browser.contains("I'm in Figma as"));
    assert!(browser.contains("never guess"));
    assert!(browser.contains("asks the user on a card"));
    assert!(browser.contains("signed_out: true"));
    assert!(reply(&Step::AlreadyDeclined {
        title: "Figma".into(),
        said: "No".into()
    })
    .contains("Don't ask for it again"));
    assert!(reply(&Step::OneAtATime {
        title: "Figma".into()
    })
    .contains("One at a time"));
}

#[test]
fn outside_text_is_granted_and_joins_nothing_unseen() {
    with_root(|| {
        let dev = agent("Builder");
        let writer = agent("Writer");
        let none = Tried::default();
        let gh = logins::build(&dev, &ask("github")).unwrap();
        let outside = Here {
            gh: Some("sam-example".into()),
            browser: true,
            outside: true,
            ..Default::default()
        };
        // No silent `gh` grant and no browser: it ends on a card.
        assert_eq!(decide(&dev, &gh, &none, &outside, &[]), Step::Ask);
        // Doesn't join another agent's waiting card (its answer would grant).
        let r = logins::build(&writer, &ask("figma")).unwrap();
        let team = [seen(&dev, "figma", ApprovalStatus::Pending, None)];
        assert_eq!(decide(&writer, &r, &none, &outside, &team), Step::Ask);
    });
}

#[test]
fn not_needed_on_the_checklist_and_other_spellings_count_as_no() {
    with_root(|| {
        let designer = agent("Designer");
        let writer = agent("Writer");
        let none = Tried::default();
        let r = logins::build(&writer, &ask("figma")).unwrap();
        let here = Here {
            browser: true,
            not_needed: vec!["figma".into()],
            ..Default::default()
        };
        assert!(matches!(
            decide(&writer, &r, &none, &here, &[]),
            Step::AlreadyDeclined { ref said, .. } if said == "Not needed"
        ));
        // An unknown service, spelled differently, is still the same one.
        let acme = logins::build(&writer, &ask("acme-crm")).unwrap();
        assert_eq!(acme.service, "other");
        let here = Here {
            not_needed: vec!["other:acme crm".into()],
            ..Default::default()
        };
        assert!(matches!(
            decide(&writer, &acme, &none, &here, &[]),
            Step::AlreadyDeclined { .. }
        ));
        let declined = seen(&designer, "ACME_crm.", ApprovalStatus::Denied, None);
        assert!(matches!(
            decide(&writer, &acme, &none, &Here::default(), &[declined]),
            Step::AlreadyDeclined { .. }
        ));
    });
}

#[test]
fn the_browser_comes_before_a_claude_ai_connector_and_after_our_own() {
    with_root(|| {
        let mailroom = agent("Mailroom");
        let none = Tried::default();
        // A claude.ai Gmail connector granted already isn't "you have it":
        // the browser is tried first.
        connections::add_and_grant(
            "gmail",
            "Gmail",
            "sam@example.com",
            Kind::ClaudeAi {
                server_name: "claude.ai Gmail".into(),
            },
            &mailroom.id,
            Access::Read,
        )
        .unwrap();
        let gmail = logins::build(&mailroom, &ask("gmail")).unwrap();
        assert!(matches!(
            decide(&mailroom, &gmail, &none, &browser(), &[]),
            Step::Browser { ref site, .. } if site == "mail.google.com"
        ));
        // Without the browser it still ends on one card, never a dead end.
        assert_eq!(
            decide(&mailroom, &gmail, &none, &Here::default(), &[]),
            Step::Ask
        );
        // Our own OAuth connection does count, before the browser.
        connections::add_and_grant(
            "linear",
            "Linear",
            "sam@example.com",
            Kind::Oauth {
                server_url: "https://mcp.linear.app/mcp".into(),
            },
            &mailroom.id,
            Access::Read,
        )
        .unwrap();
        let linear = logins::build(&mailroom, &ask("linear")).unwrap();
        assert!(matches!(
            decide(&mailroom, &linear, &none, &browser(), &[]),
            Step::Have(_)
        ));
        // The browser's reply holds the account rule and the card rule.
        let told = reply(&Step::Browser {
            site: "mail.google.com".into(),
            title: "Gmail".into(),
        });
        assert!(told.contains("I'm in Gmail as"));
        assert!(told.contains("exactly what will go and from which account"));
    });
}

#[test]
fn a_no_from_before_the_user_turned_it_back_on_no_longer_counts() {
    with_root(|| {
        let designer = agent("Designer");
        let writer = agent("Writer");
        let none = Tried::default();
        let r = logins::build(&writer, &ask("figma")).unwrap();
        let mut no = seen(
            &designer,
            "figma",
            ApprovalStatus::Denied,
            Some("Not needed"),
        );
        no.at = 10;
        let team = [no];
        assert!(matches!(
            decide(&writer, &r, &none, &Here::default(), &team),
            Step::AlreadyDeclined { .. }
        ));
        let on = Here {
            turned_on: vec![("figma".into(), 20)],
            ..Default::default()
        };
        assert_eq!(decide(&writer, &r, &none, &on, &team), Step::Ask);
    });
}

#[test]
fn the_agents_browser_comes_before_the_users_own_chrome() {
    with_root(|| {
        let social = agent("Social");
        let r = logins::build(&social, &ask("figma")).unwrap();
        let none = Tried::default();
        let both = Here {
            browser: true,
            agents_browser: true,
            ..Default::default()
        };
        assert!(matches!(
            decide(&social, &r, &none, &both, &[]),
            Step::AgentsBrowser { ref site, .. } if site == "www.figma.com"
        ));
        // Only the agents' browser (a Codex agent, or Claude in Chrome off).
        let agents_only = Here {
            agents_browser: true,
            ..Default::default()
        };
        assert!(matches!(
            decide(&social, &r, &none, &agents_only, &[]),
            Step::AgentsBrowser { .. }
        ));
        // The site was last found signed in only in the user's own Chrome:
        // that's where the task's session is.
        let personal = Here {
            personal_site: true,
            ..both.clone()
        };
        assert!(matches!(
            decide(&social, &r, &none, &personal, &[]),
            Step::Browser { .. }
        ));
        // A sign-in page in the agents' browser: the user's own Chrome at
        // once, no card.
        let out = Tried {
            signed_out: true,
            ..Default::default()
        };
        assert!(matches!(
            decide(&social, &r, &out, &both, &[]),
            Step::Browser { .. }
        ));
        // Signed out in their Chrome too: a card (whose first way in is
        // "Sign in from here").
        let out_everywhere = Tried {
            signed_out: true,
            in_chrome: true,
        };
        assert_eq!(decide(&social, &r, &out_everywhere, &both, &[]), Step::Ask);
        // Signed out with only the agents' browser to try: a card.
        assert_eq!(decide(&social, &r, &out, &agents_only, &[]), Step::Ask);
        // A site with no connector of its own: that card's first way in is
        // the agents' browser.
        let li = logins::build(&social, &ask("linkedin")).unwrap();
        assert_eq!(li.options[0].method, logins::Method::AgentBrowser);
        // Never for outside text.
        let outside = Here {
            outside: true,
            ..both
        };
        assert_eq!(decide(&social, &r, &none, &outside, &[]), Step::Ask);
        let told = reply(&Step::AgentsBrowser {
            site: "www.linkedin.com".into(),
            title: "LinkedIn".into(),
        });
        assert!(told.contains("mcp__browser__*") && told.contains("signed_out: true"));
        assert!(told.contains("from their phone"));
    });
}

/// One "No" to Slack used to block it for good, even after the owner asked
/// for it again. The user's own words naming the service set an earlier no
/// aside for that request; anything else still honours it.
#[test]
fn the_users_own_request_for_a_declined_app_lifts_the_no() {
    with_root(|| {
        let social = agent("Social");
        let other = agent("Other");
        let none = Tried::default();
        let r = logins::build(&social, &ask("slack")).unwrap();
        assert!(names_service("Can you post the recap to Slack?", &r));
        assert!(names_service("check SLACK for replies", &r));
        assert!(!names_service("post the recap to the team", &r));
        assert!(!names_service("slackline photos", &r), "whole words only");

        let no = seen(&other, "slack", ApprovalStatus::Denied, None);
        assert!(matches!(
            decide(
                &social,
                &r,
                &none,
                &Here::default(),
                std::slice::from_ref(&no)
            ),
            Step::AlreadyDeclined { .. }
        ));
        let asked = Here {
            user_named: true,
            ..Default::default()
        };
        assert_eq!(decide(&social, &r, &none, &asked, &[no]), Step::Ask);
        // "Not needed" too.
        let skipped = Here {
            not_needed: vec!["slack".into()],
            user_named: true,
            ..Default::default()
        };
        assert_eq!(decide(&social, &r, &none, &skipped, &[]), Step::Ask);
        assert_eq!(
            lifted_line("Slack"),
            "You asked for Slack in this request, so the earlier no is set aside for it"
        );
    });
}

/// Gmail opened in the agents' browser lands on Google's signed-out product
/// page (Google refuses a sign-in in a driven browser), and the agent was then
/// told to carry on without Gmail. Google's, Slack's, X's, LinkedIn's and
/// Grok's sites go to the user's own Chrome first, and a Deny on an import's
/// quiet setup card doesn't stop that.
#[test]
fn gmail_goes_straight_to_the_users_chrome() {
    with_root(|| {
        let chief = agent("Chief");
        let recruiter = agent("Recruiter");
        let r = logins::build(&chief, &ask("gmail")).unwrap();
        let none = Tried::default();
        let both = Here {
            browser: true,
            agents_browser: true,
            ..Default::default()
        };
        for service in [
            "gmail",
            "google_calendar",
            "google_drive",
            "slack",
            "x",
            "linkedin",
            "grok",
        ] {
            assert!(users_chrome_first(service), "{service}");
            let r = logins::build(&chief, &ask(service)).unwrap();
            assert!(
                matches!(decide(&chief, &r, &none, &both, &[]), Step::Browser { .. }),
                "{service}"
            );
        }
        assert!(!users_chrome_first("figma") && !users_chrome_first("notion"));
        // "Grok Bot" is the user's own Grok, on grok.com.
        assert_eq!(
            logins::match_service("talk to GROKBOT").map(|s| s.id),
            Some("grok")
        );
        assert_eq!(
            logins::service("grok").and_then(|s| s.site),
            Some("grok.com")
        );
        // No Claude in Chrome this turn (Codex): the agents' browser.
        let agents_only = Here {
            agents_browser: true,
            ..Default::default()
        };
        assert!(matches!(
            decide(&chief, &r, &none, &agents_only, &[]),
            Step::AgentsBrowser { .. }
        ));
        // The agents' browser showed it signed out: the user's Chrome.
        let out = Tried {
            signed_out: true,
            ..Default::default()
        };
        assert!(matches!(
            decide(&chief, &r, &out, &both, &[]),
            Step::Browser { ref site, .. } if site == "mail.google.com"
        ));
        // An import's quiet card for another agent, denied with no words:
        // still the user's Chrome, where they're signed in already.
        let mut quiet = seen(&recruiter, "gmail", ApprovalStatus::Denied, None);
        quiet.login.quiet = true;
        assert!(matches!(
            decide(&chief, &r, &out, &both, std::slice::from_ref(&quiet)),
            Step::Browser { .. }
        ));
        // ...but never a new card: with no Chrome, the no stands.
        assert!(matches!(
            decide(&chief, &r, &out, &agents_only, std::slice::from_ref(&quiet)),
            Step::AlreadyDeclined { .. }
        ));
        // A no the user gave on a task's card, or in words, still stands.
        let plain = seen(&recruiter, "gmail", ApprovalStatus::Denied, None);
        assert!(matches!(
            decide(&chief, &r, &none, &both, &[plain]),
            Step::AlreadyDeclined { .. }
        ));
        let mut worded = seen(
            &recruiter,
            "gmail",
            ApprovalStatus::Denied,
            Some("Not my inbox"),
        );
        worded.login.quiet = true;
        assert!(matches!(
            decide(&chief, &r, &none, &both, &[worded]),
            Step::AlreadyDeclined { .. }
        ));
        // Never for outside text.
        let outside = Here {
            outside: true,
            ..both.clone()
        };
        assert_eq!(decide(&chief, &r, &none, &outside, &[]), Step::Ask);
        // The Chrome reply says how to report a sign-in there.
        let told = reply(&Step::Browser {
            site: "mail.google.com".into(),
            title: "Gmail".into(),
        });
        assert!(told.contains("Reading there needs no card"));
        assert!(told.contains("browser: \"chrome\""));
    });
}

#[test]
fn which_browser_showed_the_sign_in_is_read_from_the_call() {
    let t = Tried::from_args(&serde_json::json!({"signed_out": true, "browser": "chrome"}));
    assert!(t.signed_out && t.in_chrome);
    let t = Tried::from_args(&serde_json::json!({"signed_out": true, "browser": "agents"}));
    assert!(t.signed_out && !t.in_chrome);
    let t = Tried::from_args(&serde_json::json!({"signed_out": true}));
    assert!(!t.in_chrome);
}

fn chief() -> Agent {
    let a = store::create(store::NewAgent {
        name: "Chief of Staff".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: true,
    })
    .unwrap();
    store::update(&a.id, |x| x.engine = Engine::Claude).unwrap()
}

/// Seen live on Haiku: "can you read my email?" got a sign-in card from the
/// Chief while Mailroom had Gmail connected. Now the chain hands it over.
#[test]
fn the_chief_hands_work_to_a_teammate_who_has_it_instead_of_asking() {
    with_root(|| {
        let boss = chief();
        let mail = agent("Mailroom");
        let other = agent("Writer");
        connections::add_and_grant(
            "gmail",
            "Gmail",
            "sam@example.test",
            Kind::Oauth {
                server_url: "https://mail.example.test/mcp".into(),
            },
            &mail.id,
            Access::Read,
        )
        .unwrap();
        let gmail = logins::service("gmail").unwrap();
        // Who holds it: never the caller, and only as far as the grant goes.
        let rows = super::super::team_reach::holders(&boss, gmail, Access::Read);
        assert_eq!(
            rows,
            vec![(
                "Mailroom".to_string(),
                "connected: Gmail (sam@example.test)".to_string()
            )]
        );
        assert!(super::super::team_reach::holders(&boss, gmail, Access::Full).is_empty());
        assert!(super::super::team_reach::holders(&mail, gmail, Access::Read).is_empty());

        let r = logins::build(&boss, &ask("gmail")).unwrap();
        let out = Tried {
            signed_out: true,
            ..Default::default()
        };
        let here = Here {
            agents_browser: true,
            teammates: rows.clone(),
            ..Default::default()
        };
        let step = decide(&boss, &r, &out, &here, &[]);
        assert!(
            matches!(&step, Step::Teammate { name, .. } if name == "Mailroom"),
            "{step:?}"
        );
        let said = reply(&step);
        assert!(
            said.contains("message_agent") && said.contains("Mailroom"),
            "{said}"
        );
        // A browser that works still comes first: nothing is asked either way.
        assert!(matches!(
            decide(&boss, &r, &Tried::default(), &here, &[]),
            Step::AgentsBrowser { .. }
        ));
        // Not for outside text, and not for an agent whose own job needs it.
        let outside = Here {
            outside: true,
            ..here.clone()
        };
        assert_eq!(decide(&boss, &r, &out, &outside, &[]), Step::Ask);
        let r2 = logins::build(&other, &ask("gmail")).unwrap();
        assert_eq!(decide(&other, &r2, &out, &here, &[]), Step::Ask);
        // An earlier no still wins.
        let no = [seen(&other, "gmail", ApprovalStatus::Denied, Some("No"))];
        assert!(matches!(
            decide(&boss, &r, &out, &here, &no),
            Step::AlreadyDeclined { .. }
        ));
    });
}
