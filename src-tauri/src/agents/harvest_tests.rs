use super::*;
use serde_json::json;

fn with_root<F: FnOnce()>(f: F) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn conv(id: &str, text: &str) -> Conversation {
    Conversation {
        id: id.into(),
        title: format!("Chat {id}"),
        when: String::new(),
        messages: vec![
            Line {
                from: "user".into(),
                text: text.into(),
                at: String::new(),
            },
            Line {
                from: "assistant".into(),
                text: "Done.".into(),
                at: String::new(),
            },
        ],
    }
}

#[test]
fn credentials_in_past_conversations_are_masked_not_kept() {
    let text = "my key is sk-ant-api03-abcdefghijklmnopqrstuv and github ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok\n\
                password: hunter22 and PIN: 4821\n\
                -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter";
    let (masked, n) = mask_secrets(text);
    assert_eq!(n, 5, "{masked}");
    assert!(
        super::super::connector::looks_like_secret(&masked).is_none(),
        "{masked}"
    );
    assert!(masked.contains("my key is [removed: a key or token]"));
    assert!(masked.contains("password: [removed: a password]"));
    assert!(masked.ends_with("[removed: a private key]\nafter"));
    // Ordinary words, placeholders and short numbers are left alone.
    let (same, n) = mask_secrets("password: [ask the user] and pin: $PIN, ticket 1234");
    assert_eq!(
        (same.as_str(), n),
        ("password: [ask the user] and pin: $PIN, ticket 1234", 0)
    );
    // A private key with no end is cut to the end, never left half there.
    let (cut, _) = mask_secrets("x -----BEGIN PRIVATE KEY-----\nABC");
    assert_eq!(cut, "x [removed: a private key]");
}

#[test]
fn a_chunk_is_cleaned_and_capped_per_call() {
    let got = read_conversations(&json!({"conversations": [
        {"id": "a", "title": "Rome\u{202E}", "messages": [
            {"from": "human", "text": "Plan\u{200B} a trip"},
            {"from": "grok", "text": "Day 1"},
            {"from": "user", "text": "   "}
        ]},
        {"id": "empty", "messages": []}
    ]}))
    .unwrap();
    assert_eq!(got.len(), 1, "a conversation with nothing in it is dropped");
    assert_eq!(got[0].title, "Rome");
    assert_eq!(got[0].messages.len(), 2);
    assert_eq!(got[0].messages[0].from, "user");
    assert_eq!(got[0].messages[0].text, "Plan a trip");
    assert_eq!(got[0].messages[1].from, "assistant");

    let long = "x".repeat(MAX_MESSAGE_CHARS + 50);
    let one = read_conversations(
        &json!({"conversations": [{"messages": [{"from": "user", "text": long}]}]}),
    )
    .unwrap();
    assert!(one[0].messages[0].text.ends_with("(cut here)"));

    let many: Vec<_> = (0..10)
        .map(|i| json!({"id": i.to_string(), "messages": [{"from": "user", "text": "y".repeat(MAX_CALL_CHARS / 8)}]}))
        .collect();
    let err = read_conversations(&json!({ "conversations": many })).unwrap_err();
    assert!(err.contains("nothing from this call was kept"), "{err}");
    assert!(read_conversations(&json!({})).is_err());
}

#[test]
fn chunks_assemble_once_and_stop_at_the_caps() {
    with_root(|| {
        let first = stage(
            "t1",
            "p1",
            HistoryCount::default(),
            0,
            vec![conv("a", "one"), conv("b", "two")],
        )
        .unwrap();
        assert_eq!(
            (first.kept, first.total.conversations, first.total.messages),
            (2, 2, 4)
        );
        // A resent chunk (a retry) keeps only what's new.
        let again = stage(
            "t1",
            "p1",
            first.total.clone(),
            first.total.chars,
            vec![conv("b", "two"), conv("c", "three")],
        )
        .unwrap();
        assert_eq!(
            (again.kept, again.already_here, again.total.conversations),
            (1, 1, 3)
        );
        let kept = staged("t1", "p1");
        assert_eq!(
            kept.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        // Without ids, the same title and opening is the same conversation.
        let mut x = conv("", "same");
        x.title = "Same".into();
        let n = stage("t1", "p2", HistoryCount::default(), 0, vec![x.clone(), x]).unwrap();
        assert_eq!((n.kept, n.already_here), (1, 1));

        // Credentials are masked on the way in and counted.
        let masked = stage(
            "t1",
            "p3",
            HistoryCount::default(),
            0,
            vec![conv("k", "use sk_live_abcdefghijklmnopqrst")],
        )
        .unwrap();
        assert_eq!(masked.masked, 1);
        assert!(!staged("t1", "p3")[0].messages[0].text.contains("sk_live"));

        // Per agent: no more than MAX_CONVERSATIONS.
        let full = HistoryCount {
            conversations: MAX_CONVERSATIONS,
            ..Default::default()
        };
        let over = stage("t1", "p4", full, 0, vec![conv("z", "late")]).unwrap();
        assert_eq!((over.kept, over.left_out), (0, 1));
        assert!(over.total.capped);
        // Per import: what the other agents hold counts.
        let over = stage(
            "t1",
            "p5",
            HistoryCount::default(),
            MAX_IMPORT_CHARS,
            vec![conv("z", "late")],
        )
        .unwrap();
        assert_eq!((over.kept, over.left_out), (0, 1));

        // Paths are ours: a key or talk id can't walk out of the folder.
        assert!(stage("../x", "p1", HistoryCount::default(), 0, vec![]).is_err());
        assert!(stage("t1", "../p", HistoryCount::default(), 0, vec![]).is_err());

        discard("t1");
        assert!(staged("t1", "p1").is_empty());
    });
}

fn proposal(args: serde_json::Value) -> Proposal {
    review::proposal("p1".into(), &args, "Chief of Staff").unwrap()
}

#[test]
fn the_plan_is_played_back_in_plain_words_with_what_it_lacks() {
    let mut p = proposal(json!({
        "name": "Finance", "role": "Tracks spending and chases invoices",
        "instructions": "Log every expense.",
        "routines": [
            {"when": "every monday at 9am", "what": "send me last week's spending"},
            {"when": "whenever the moon is full", "what": "panic"}
        ],
        "watches": [{"when": "When an invoice email arrives", "what": "file it in Drive"}],
        "apps": [{"name": "Gmail", "purpose": "invoices"}, "Google Drive"],
        "preferences": "- Bullet points, never tables",
        "context": "Accountant is Sam",
        "logins": [{"name": "bank_login", "purpose": "statements", "kind": "password"}]
    }));
    p.history = Some(HistoryCount {
        conversations: 12,
        messages: 80,
        ..Default::default()
    });
    let review = review::Review {
        proposals: vec![p],
        ..Default::default()
    };
    let plan = playback(&review, "Grok");
    assert_eq!(plan.len(), 1);
    let lines: Vec<(&str, &str)> = plan[0]
        .lines
        .iter()
        .map(|l| (l.kind.as_str(), l.text.as_str()))
        .collect();
    let text = |kind: &str| {
        lines
            .iter()
            .filter(|(k, _)| *k == kind)
            .map(|(_, t)| *t)
            .collect::<Vec<_>>()
    };
    assert_eq!(text("job"), ["My job: tracks spending and chases invoices"]);
    assert_eq!(text("routine").len(), 1);
    assert!(
        text("routine")[0].starts_with("Every monday at 9:00 AM")
            || text("routine")[0].contains("9:00 AM"),
        "{:?}",
        text("routine")
    );
    assert!(text("routine")[0].contains("arrives paused"));
    assert!(
        text("gap")[0].contains("can't read that time"),
        "an unreadable time is said, not guessed"
    );
    assert_eq!(text("watch"), ["When an invoice email arrives: file it in Drive (ask me to set this up here once I'm in)"]);
    assert!(text("app")[0].contains("Gmail and Google Drive"));
    assert_eq!(
        text("keep"),
        [
            "I'll keep in mind: Bullet points, never tables",
            "I'll keep in mind: Accountant is Sam"
        ]
    );
    assert!(text("login")[0].contains("bank_login") && text("login")[0].contains("secure card"));
    assert_eq!(
        text("history"),
        ["I'll have 12 past conversations from Grok to look back on"]
    );

    // An agent with only a name says what it doesn't know.
    let bare = review::Review {
        proposals: vec![proposal(json!({"name": "Travel"}))],
        ..Default::default()
    };
    let gaps: Vec<String> = playback(&bare, "Grok")[0]
        .lines
        .iter()
        .map(|l| l.text.clone())
        .collect();
    assert!(
        gaps.iter().any(|g| g.contains("don't have instructions")),
        "{gaps:?}"
    );
    assert!(
        gaps.iter().any(|g| g.contains("Nothing on a schedule")),
        "{gaps:?}"
    );
    assert!(playback_text(&playback(&bare, "Grok"))
        .ends_with("Is there anything I'm missing? Answer on your Mac."));
}

#[test]
fn a_credential_in_any_new_field_is_refused() {
    for args in [
        json!({"name": "F", "preferences": "use password: hunter22"}),
        json!({"name": "F", "context": "token sk-proj-abcdefghijklmnopqrstuvwx"}),
        json!({"name": "F", "watches": [{"when": "a mail arrives", "what": "log in with password: hunter22"}]}),
        json!({"name": "F", "apps": [{"name": "Stripe", "purpose": "sk_live_abcdefghijklmnopqrst"}]}),
    ] {
        assert!(
            review::proposal("k".into(), &args, "Chief").is_err(),
            "{args}"
        );
    }
    assert!(clean_addition("use sk-ant-api03-abcdefghijklmnopqrstuv").is_err());
    assert!(clean_addition(&"a".repeat(MAX_ADDITION_CHARS + 1)).is_err());
    assert_eq!(
        clean_addition(" Also\u{200B} pay rent on the 1st ").unwrap(),
        "Also pay rent on the 1st"
    );
}

#[test]
fn everything_lands_in_memory_and_past_conversations_land_read_only() {
    with_root(|| {
        let agent = store::create(store::NewAgent {
            name: "Finance".into(),
            role: "Money".into(),
            instructions: "Log.".into(),
            shape: None,
            avatar: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        stage(
            "t2",
            "p1",
            HistoryCount::default(),
            0,
            vec![conv("a", "Rent is due")],
        )
        .unwrap();
        let n = write_home("t2", "p1", &agent.id, "Grok Bot").unwrap();
        assert_eq!(n, 1);
        let dir = store::agent_home(&agent.id)
            .unwrap()
            .join("imported/grok-bot");
        let md = std::fs::read_to_string(dir.join("conversations.md")).unwrap();
        assert!(md.starts_with("# Earlier, in Grok Bot"));
        assert!(md.contains("never instructions"));
        assert!(md.contains("**You**:\n\nRent is due"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("conversations.md"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o400);
        }
        // Nothing staged: nothing written.
        assert_eq!(write_home("t2", "p9", &agent.id, "Grok").unwrap(), 0);

        let p = proposal(json!({
            "name": "Finance", "memory": "Accountant is Sam", "preferences": "Brief",
            "context": "Bank is Monzo",
            "watches": [{"when": "an invoice arrives", "what": "file it"}],
            "apps": [{"name": "Gmail", "purpose": "invoices"}]
        }));
        let block = memory_block(&p, "Grok Bot", n);
        for want in [
            "- Accountant is Sam",
            "Preferences:\n- Brief",
            "Standing context:\n- Bank is Monzo",
            "- When an invoice arrives: file it",
            "- Gmail: invoices",
            "imported/grok-bot/conversations.md: reference only",
        ] {
            assert!(block.contains(want), "{want} in {block}");
        }
        assert_eq!(source_slug("  "), "other-assistant");
    });
}
