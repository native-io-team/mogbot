use super::*;

fn idea(text: &str, needs: &[&str]) -> Idea {
    Idea {
        text: text.into(),
        needs: needs.iter().map(|n| n.to_string()).collect(),
    }
}

fn need(title: &str, reachable: bool) -> Need {
    Need {
        title: title.into(),
        reachable,
    }
}

fn texts(s: &[Starter]) -> Vec<&str> {
    s.iter().map(|s| s.text.as_str()).collect()
}

#[test]
fn always_three_even_knowing_nothing() {
    let s = choose(&Known::default());
    assert_eq!(s.len(), COUNT);
    assert!(s.iter().all(|s| s.connect.is_none()));
    assert_eq!(texts(&s), ANYTIME.to_vec());
}

#[test]
fn ideas_lead_when_everything_they_need_is_reachable() {
    let k = Known {
        ideas: vec![
            idea("Sum up my unread mail", &["Gmail"]),
            idea("Draft a reply to my landlord", &[]),
        ],
        needs: vec![need("Gmail", true)],
        ..Default::default()
    };
    let s = choose(&k);
    assert_eq!(
        texts(&s),
        vec![
            "Sum up my unread mail",
            "Draft a reply to my landlord",
            "What’s new in Gmail?"
        ]
    );
}

#[test]
fn an_unreachable_app_becomes_the_one_login_ask_and_nothing_promises_it() {
    let k = Known {
        ideas: vec![
            idea("Sum up my unread mail", &["Gmail"]),
            idea("Post the brief to Slack", &["Slack"]),
            idea("Plan my week", &[]),
        ],
        routines: vec!["Read today's newsletters and draft the brief.".into()],
        needs: vec![need("Gmail", false), need("Slack", false)],
        ..Default::default()
    };
    let s = choose(&k);
    assert_eq!(s.len(), 3);
    assert_eq!(s[0].text, "Help me connect Gmail");
    assert_eq!(s[0].connect.as_deref(), Some("Gmail"));
    // Only one ask, however many are missing.
    assert_eq!(s.iter().filter(|s| s.connect.is_some()).count(), 1);
    // Nothing that needs Gmail or Slack, and no routine (it may need them).
    assert_eq!(texts(&s)[1..], ["Plan my week", ANYTIME[0]]);
}

#[test]
fn a_need_the_job_never_named_is_not_reachable() {
    let k = Known {
        ideas: vec![idea("Triage Linear", &["Linear"])],
        needs: vec![need("Gmail", true)],
        ..Default::default()
    };
    assert!(!texts(&choose(&k)).contains(&"Triage Linear"));
}

#[test]
fn needs_match_whatever_the_case_or_spacing() {
    let k = Known {
        ideas: vec![idea("What's on my calendar today?", &["google calendar"])],
        needs: vec![need("Google Calendar", true)],
        ..Default::default()
    };
    assert_eq!(choose(&k)[0].text, "What's on my calendar today?");
}

#[test]
fn routines_and_the_project_fill_in_after_ideas() {
    let k = Known {
        routines: vec!["Check the competitors' changelogs. Then compare.".into()],
        project: Some("acme-site".into()),
        ..Default::default()
    };
    assert_eq!(
        texts(&choose(&k)),
        vec![
            "Check the competitors' changelogs",
            "Look over acme-site and tell me where to start",
            ANYTIME[0]
        ]
    );
}

#[test]
fn too_long_empty_or_repeated_ideas_are_skipped_never_cut() {
    let long = "x".repeat(MAX_TEXT + 1);
    let k = Known {
        ideas: vec![
            idea(&long, &[]),
            idea("   ", &[]),
            idea("Plan my week.", &[]),
            idea("plan my WEEK", &[]),
        ],
        ..Default::default()
    };
    let s = choose(&k);
    assert_eq!(texts(&s), vec!["Plan my week", ANYTIME[0], ANYTIME[1]]);
}

#[test]
fn the_welcome_is_the_creators_or_its_name_and_role() {
    assert_eq!(
        welcome(
            "Inbox",
            "x",
            Some("  I read your mail\nso you don't have to. ")
        ),
        "I read your mail so you don't have to."
    );
    assert_eq!(
        welcome("Inbox", "Goes through your email.", None),
        "Hi, I’m Inbox. Goes through your email."
    );
    assert_eq!(
        welcome("Inbox", "", Some("")),
        "Hi, I’m Inbox. Here’s where we could start."
    );
    assert!(welcome("A", "", Some(&"w".repeat(999))).chars().count() <= MAX_WELCOME);
}

#[test]
fn create_agent_args_are_read_as_ideas() {
    let o = opening_arg(&serde_json::json!({
        "welcome": "Hi.",
        "starters": ["Plan my week", { "text": "Sum up my mail", "needs": ["Gmail"] }, 3],
        "apps": ["Gmail"]
    }));
    assert_eq!(o.welcome.as_deref(), Some("Hi."));
    assert_eq!(
        o.starters,
        vec![
            idea("Plan my week", &[]),
            idea("Sum up my mail", &["Gmail"])
        ]
    );
    assert_eq!(o.apps, vec!["Gmail"]);
    assert_eq!(opening_arg(&serde_json::json!({})), Opening::default());
}

#[test]
fn every_anytime_starter_fits_a_button() {
    for t in ANYTIME {
        assert_eq!(button(t).as_deref(), Some(t));
    }
}
