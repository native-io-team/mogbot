//! An outside assistant's handover: collected into one card, nothing saved
//! before the user's yes (child of handoff.rs). Fixtures are fictional.
use super::*;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str, is_main: bool) -> store::Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main,
    })
    .unwrap()
}

const TRUCK: &str = "Here's what I know about the truck, for your memory.\n\
- Model: a 2019 pickup, blue\n\
- Next service: oil change at 5,000 miles\n\
- Insurance: renews in March with Example Mutual\n\
- Parking: the north garage, spot 12";

fn pending(chief: &str) -> Vec<Approval> {
    store::pending_approvals(chief).unwrap()
}

#[test]
fn questions_go_to_the_chief_and_handovers_are_collected() {
    // A plain question is answered by the Chief, as before.
    for q in [
        "What's on the user's plate this week?",
        "Is the finance agent running its Monday routine? I want to stop mine.",
        "hey, are you there",
    ] {
        assert!(!is_handoff(q, false, false), "{q}");
    }
    // Asked while a handover is open, a question still gets an answer.
    assert!(!is_handoff("Did you get the routines part?", false, true));
    // A dump of facts, or one saying it's a handover, is collected.
    assert!(is_handoff(TRUCK, false, false));
    let long_list = format!(
        "People:\n{}",
        (1..=8)
            .map(|i| format!("- Person {i}: a fictional contact who handles area {i} of the work"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(long_list.chars().count() >= 500);
    assert!(is_handoff(&long_list, false, false));
    // The next part of one already open joins it, whatever it looks like.
    assert!(is_handoff(
        "Finances: the budget sheet is in the shared drive.",
        false,
        true
    ));
    // Said in so many words by the assistant, even with a question mark in it.
    assert!(is_handoff("Part 3: open questions? none.", true, false));
    // A short request isn't mistaken for a handover.
    assert!(!is_handoff(
        "Please take over the morning briefing from tomorrow.",
        false,
        false
    ));
}

#[test]
fn parts_collect_per_source_and_post_only_once_quiet() {
    let mut b = Batches::default();
    let one = b
        .add("Example Bot", "Agents: Finance, Travel.", 1, (0, 0))
        .unwrap();
    let two = b
        .add("example bot ", "Routines: Monday budget check.", 2, (0, 0))
        .unwrap();
    assert_eq!(two.parts, 2, "the same source, however it's spelled");
    let other = b.add("Other Bot", "Something else.", 3, (0, 0)).unwrap();
    assert_eq!(other.parts, 1);
    // A timer from an earlier part finds a newer one and waits.
    assert!(b.take_if_quiet("Example Bot", one.generation).is_none());
    let (name, parts) = b.take_if_quiet("Example Bot", two.generation).unwrap();
    assert_eq!(name, "example bot ");
    assert_eq!(parts.len(), 2);
    assert!(!b.is_open("Example Bot"));
    assert!(b.is_open("Other Bot"));
}

#[test]
fn credentials_and_oversized_handovers_are_refused() {
    let mut b = Batches::default();
    let err = b
        .add(
            "Example Bot",
            "Bank login password: hunter22-fictional",
            1,
            (0, 0),
        )
        .unwrap_err();
    assert!(err.contains("secure card"), "{err}");
    assert!(
        !b.is_open("Example Bot"),
        "nothing kept from a refused part"
    );
    let err = b
        .add("Example Bot", &"x".repeat(MAX_PART_CHARS + 1), 1, (0, 0))
        .unwrap_err();
    assert!(err.contains("too long"), "{err}");
    // The card it would fold into is already full.
    let err = b
        .add("Example Bot", "One more fact.", 1, (MAX_PARTS, 10))
        .unwrap_err();
    assert!(err.contains("full"), "{err}");
    assert!(b.add("Example Bot", "   ", 1, (0, 0)).is_err());
}

#[test]
fn one_card_holds_every_part_and_later_parts_fold_into_it() {
    scratch(|| {
        let chief = agent("Morgan", true);
        let now = store::now_ms();
        assert!(!open_for(&chief.id, "Example Bot", now));
        let parts = vec![TRUCK.to_string(), "Agents: Finance, Travel.".to_string()];
        post(None, &chief.id, "Example Bot", &parts, now).unwrap();
        let open = pending(&chief.id);
        assert_eq!(open.len(), 1, "one card, not one per part");
        let card = &open[0];
        assert_eq!(card.title, "Example Bot sent what it knows");
        assert_eq!(card.handoff.as_ref().unwrap().parts, 2);
        assert!(card.detail.contains("— Part 1 —") && card.detail.contains("— Part 2 —"));
        assert!(card
            .summary
            .as_ref()
            .unwrap()
            .contains("Nothing is saved until you say so"));
        assert!(
            card.tool.is_none(),
            "no tool call: no level or rule answers it"
        );
        assert_eq!(
            on_card(&chief.id, "Example Bot", now),
            (2, card.detail.chars().count())
        );
        // Still unanswered: the source counts as having one open.
        assert!(open_for(&chief.id, "example bot", now));

        // A late part: the card is replaced by one with everything.
        post(
            None,
            &chief.id,
            "Example Bot",
            &["Routines: Monday budget check.".into()],
            now,
        )
        .unwrap();
        let open = pending(&chief.id);
        assert_eq!(open.len(), 1);
        let merged = &open[0];
        assert_eq!(merged.handoff.as_ref().unwrap().parts, 3);
        assert!(merged
            .detail
            .contains("— Part 3 —\nRoutines: Monday budget check."));
        assert!(
            merged.detail.contains("Next service"),
            "the earlier parts are kept"
        );
        let old = store::find_approval(&chief.id, &card.request_id)
            .unwrap()
            .unwrap();
        assert_eq!(old.status, ApprovalStatus::Expired);
        assert!(old.set_aside.unwrap().contains("Folded into"));

        // Another source's handover is its own card.
        post(
            None,
            &chief.id,
            "Other Bot",
            &["Something else.".into()],
            now,
        )
        .unwrap();
        assert_eq!(pending(&chief.id).len(), 2);
    });
}

#[test]
fn ignore_saves_nothing_and_save_is_a_turn_the_user_authorised() {
    scratch(|| {
        let chief = agent("Morgan", true);
        let now = store::now_ms();
        post(None, &chief.id, "Example Bot", &[TRUCK.to_string()], now).unwrap();
        let card = pending(&chief.id).remove(0);
        let memory_before =
            std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md"))
                .unwrap_or_default();

        // Ignore: answered, and no turn for the Chief.
        let (updated, turn) = answer(&chief.id, &card, false).unwrap();
        assert!(turn.is_none());
        let a = updated.unwrap().approval.unwrap();
        assert_eq!(a.status, ApprovalStatus::Denied);
        assert_eq!(a.choice.as_deref(), Some("Ignored"));
        // A second answer finds it answered: no way to save it after Ignore.
        assert!(answer(&chief.id, &card, true).is_err());
        let memory_after =
            std::fs::read_to_string(store::agent_home(&chief.id).unwrap().join("CLAUDE.md"))
                .unwrap_or_default();
        assert_eq!(
            memory_before, memory_after,
            "nothing written before or after Ignore"
        );

        // Save to memory: the Chief is handed the parts, framed as information.
        post(None, &chief.id, "Example Bot", &[TRUCK.to_string()], now).unwrap();
        let card = pending(&chief.id).remove(0);
        let (_, turn) = answer(&chief.id, &card, true).unwrap();
        let turn = turn.unwrap();
        assert!(turn.contains("said yes"));
        assert!(turn.contains("message_agent"));
        assert!(turn.contains("isn't the user's request"));
        assert!(turn.contains("Next service: oil change"));
        assert!(pending(&chief.id).is_empty());
    });
}

#[test]
fn only_the_chief_answers_a_handover_and_nothing_answers_it_for_the_user() {
    scratch(|| {
        let _chief = agent("Morgan", true);
        let other = agent("Finance", false);
        let card = card_for("Example Bot", None, &[TRUCK.to_string()]);
        assert!(answer(&other.id, &card, true).is_err());
        // An admin may not answer it, and it outlives a restart.
        let (kind, _) = super::super::admin::classify_in(&card, false, None);
        assert_eq!(kind, super::super::admin::Kind::Yours);
        for moment in [
            super::super::expiry::Moment::Launch,
            super::super::expiry::Moment::Tick,
        ] {
            assert!(super::super::expiry::verdict(&card, i64::MAX / 2, false, moment).is_none());
        }
    });
}
