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
        let out = Tried { signed_out: true };
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
