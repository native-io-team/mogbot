//! The import's checklist and the NEXT it drives (child of coverage.rs).
//! Fixtures are fictional.
use super::*;

fn facts(f: &[&str]) -> Record {
    Record {
        facts: f.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

fn exhausted() -> Record {
    Record {
        exhausted: true,
        ..Default::default()
    }
}

fn none() -> Record {
    Record {
        none: true,
        ..Default::default()
    }
}

#[test]
fn it_asks_for_the_list_then_each_listed_agent_in_full_by_name() {
    let mut c = Coverage::default();
    let gap = c.next(&[]).unwrap();
    assert!(gap.ask.starts_with("List every agent"), "{}", gap.ask);
    c.list_agents(&["Scout".into(), "Ledger".into(), "Outreach".into()]);
    // Staged without instructions doesn't count as sent in full.
    let staged = vec![("Scout".to_string(), true), ("Ledger".to_string(), false)];
    let gap = c.next(&staged).unwrap();
    assert!(
        gap.ask
            .contains("You listed 3 agents; send agent 2 \"Ledger\" in full"),
        "{}",
        gap.ask
    );
    assert!(gap.ask.contains("word for word"));
    let staged = vec![("Scout".to_string(), true), ("Ledger".to_string(), true)];
    assert!(c
        .next(&staged)
        .unwrap()
        .ask
        .contains("agent 3 \"Outreach\""));
}

#[test]
fn an_area_closes_only_after_a_what_else_round_never_in_one_line() {
    let mut c = Coverage::default();
    c.list_agents(&[]);
    // Specifics and "that's everything" in the same breath: not closed.
    let mut r = facts(&["Dentist every 6 months, next on the 14th"]);
    r.exhausted = true;
    let said = c.record(Area::People, r).unwrap();
    assert!(said.contains("not closed"), "{said}");
    assert_eq!(c.note(Area::People).status, AreaStatus::Started);
    // Asked what else; nothing more: now it closes.
    c.record(Area::People, exhausted()).unwrap();
    assert_eq!(c.note(Area::People).status, AreaStatus::Exhausted);
    // A bare "nothing more" with no round before it doesn't close either.
    c.record(Area::Tasks, exhausted()).unwrap();
    assert_eq!(c.note(Area::Tasks).status, AreaStatus::Started);
    let gap = c.next(&[]).unwrap();
    assert_eq!(
        gap.area,
        Some(Area::Agents),
        "agents still to confirm first"
    );
    // "None at all" closes an empty area at once.
    c.record(Area::Personal, none()).unwrap();
    assert_eq!(c.note(Area::Personal).status, AreaStatus::Exhausted);
}

#[test]
fn vague_answers_get_the_pointed_follow_up_and_mentions_their_own_turn() {
    let mut c = Coverage::default();
    c.list_agents(&[]);
    c.record(Area::Agents, exhausted()).unwrap();
    c.record(Area::Agents, exhausted()).unwrap();
    let mut r = facts(&["Owes a client an invoice"]);
    r.follow_up = Some("Which client, what amount, and by what date?".into());
    r.mentions = vec!["the blue pickup".into(), "Jordan".into()];
    c.record(Area::Tasks, r).unwrap();
    // Mentions in passing come first, one at a time.
    let gap = c.next(&[]).unwrap();
    assert!(
        gap.ask.contains("\"the blue pickup\" in passing"),
        "{}",
        gap.ask
    );
    let mut r = facts(&["The blue pickup: 2019, service due at 60,000 miles"]);
    r.resolves = vec!["The Blue Pickup".into()];
    c.record(Area::Personal, r).unwrap();
    assert!(c.next(&[]).unwrap().ask.contains("\"Jordan\""));
    c.record(
        Area::People,
        Record {
            facts: vec!["Jordan: the user's accountant".into()],
            resolves: vec!["jordan".into()],
            ..Default::default()
        },
    )
    .unwrap();
    // Routines is the first area not started: the verbatim ask.
    let gap = c.next(&[]).unwrap();
    assert_eq!(gap.area, Some(Area::Routines));
    assert!(gap.ask.contains("exact time or cron"), "{}", gap.ask);
    c.record(Area::Routines, none()).unwrap();
    // Then the vague task, with its follow-up.
    let gap = c.next(&[]).unwrap();
    assert_eq!(
        gap.area,
        Some(Area::People),
        "people started, not confirmed"
    );
    assert!(gap.ask.contains("What else in people and contacts"));
    c.record(Area::People, exhausted()).unwrap();
    let gap = c.next(&[]).unwrap();
    assert_eq!(gap.area, Some(Area::Tasks));
    assert!(gap.ask.contains("Which client, what amount"), "{}", gap.ask);
}

#[test]
fn done_only_when_every_area_is_confirmed_and_the_card_names_the_gaps() {
    let mut c = Coverage::default();
    c.list_agents(&["Scout".into(), "Ledger".into()]);
    let staged = vec![("Scout".to_string(), true)];
    let report = c.report(&staged, true);
    let agents = &report.areas[0];
    assert_eq!(agents.gap.as_deref(), Some("Not sent in full: Ledger"));
    let lines = report.lines();
    assert!(
        lines.iter().any(|l| l == "Personal facts: Not covered"),
        "{lines:?}"
    );
    assert!(lines.iter().any(|l| l.contains("message limit")));

    let staged = vec![("Scout".to_string(), true), ("Ledger".to_string(), true)];
    for area in AREAS {
        assert!(c.next(&staged).is_some(), "{area:?} still open");
        c.record(area, facts(&["A fictional specific"])).unwrap();
        c.record(area, exhausted()).unwrap();
    }
    assert_eq!(c.next(&staged), None);
    assert_eq!(c.progress(&staged), (8, 8));
    assert!(c
        .report(&staged, false)
        .areas
        .iter()
        .all(|l| l.gap.is_none()));
    let notes = c.notes().unwrap();
    assert!(notes.contains("## Personal facts\n- A fictional specific"));
}

#[test]
fn a_credential_is_never_recorded() {
    let mut c = Coverage::default();
    let err = c
        .record(
            Area::Accounts,
            facts(&["Bank: password: hunter22-fictional"]),
        )
        .unwrap_err();
    assert!(err.contains("leave it out"));
    assert!(c.note(Area::Accounts).facts.is_empty());
}

#[test]
fn progress_counts_closed_areas() {
    let mut c = Coverage::default();
    assert_eq!(c.progress(&[]), (0, 8));
    c.list_agents(&[]);
    c.record(Area::Personal, none()).unwrap();
    c.record(Area::Threads, none()).unwrap();
    assert_eq!(c.progress(&[]), (2, 8));
}

/// Observed against a stand-in assistant (the `import` e2e run): the
/// interview recorded "Moneybird: invoicing; Ledger reads it" under
/// accounts but never passed `resolves`, so every NEXT for six exchanges
/// still opened on "You mentioned \"Moneybird\" in passing", contradicting
/// what the interview itself was asking.
#[test]
fn a_later_fact_naming_a_mention_answers_it_without_resolves() {
    let mut c = Coverage::default();
    c.list_agents(&[]);
    let mut r = facts(&["Ledger reads Moneybird for invoices"]);
    r.mentions = vec!["Moneybird".into(), "Halvorsen Studio".into()];
    c.record(Area::Agents, r).unwrap();
    // Named in passing in its own call: still to chase.
    assert_eq!(c.mentions, vec!["Moneybird", "Halvorsen Studio"]);
    // A fact in the same call that is about it is its answer: never chased.
    let mut r = facts(&["Fastmail: her work email", "Todoist is her task list"]);
    r.mentions = vec!["Fastmail".into(), "todoist".into()];
    c.record(Area::Accounts, r).unwrap();
    assert_eq!(c.mentions, vec!["Moneybird", "Halvorsen Studio"]);
    // Named by a later fact, in any area: answered.
    c.record(
        Area::Routines,
        facts(&["Every Monday at 08:15: check MONEYBIRD for overdue invoices"]),
    )
    .unwrap();
    assert_eq!(c.mentions, vec!["Halvorsen Studio"]);
    // Whole words only.
    c.record(Area::Tasks, facts(&["Halvorsen Studios abroad: none"]))
        .unwrap();
    assert_eq!(c.mentions, vec!["Halvorsen Studio"]);
    c.record(
        Area::People,
        facts(&["Ingrid Halvorsen: client, runs Halvorsen Studio"]),
    )
    .unwrap();
    assert!(c.mentions.is_empty());
}

#[test]
fn a_mention_already_recorded_as_a_subject_is_not_chased() {
    let mut c = Coverage::default();
    c.record(Area::Accounts, facts(&["Todoist: her task list"]))
        .unwrap();
    let mut r = facts(&["Grant draft lives in Notion"]);
    // "Al" is too short to tell; "todoist" is known; "Notion" is new.
    r.mentions = vec!["todoist".into(), "Notion".into(), "Al".into()];
    c.record(Area::Tasks, r).unwrap();
    assert_eq!(c.mentions, vec!["Notion", "Al"]);
    // Whole words only: "Notional" isn't Notion.
    c.record(Area::Tasks, facts(&["Notional budget: EUR 300"]))
        .unwrap();
    assert_eq!(c.mentions, vec!["Notion", "Al"]);
    c.record(Area::Accounts, facts(&["Al: a fictional cousin"]))
        .unwrap();
    assert_eq!(c.mentions, vec!["Notion", "Al"], "too short to tell");
}

#[test]
fn a_mention_gets_one_next_of_its_own_and_is_never_chased_again() {
    let mut c = Coverage::default();
    c.list_agents(&["Scout".into()]);
    let mut r = facts(&["Invoice M-2207 is with a client"]);
    r.mentions = vec!["Halvorsen Studio".into(), "Kamp Zeewind".into()];
    c.record(Area::Tasks, r).unwrap();
    // While an agent is still to come, NEXT asks for it: no mention closes.
    assert_eq!(c.answered_mention(&[]), None);
    assert_eq!(c.mentions.len(), 2);
    let staged = vec![("Scout".to_string(), true)];
    assert!(c
        .next(&staged)
        .unwrap()
        .ask
        .contains("\"Halvorsen Studio\""));
    // The assistant replied to that NEXT: it's done, the next one leads.
    assert_eq!(
        c.answered_mention(&staged).as_deref(),
        Some("Halvorsen Studio")
    );
    assert!(c.next(&staged).unwrap().ask.contains("\"Kamp Zeewind\""));
    // Mentioned again later: not chased a second time.
    let mut r = facts(&["Second reminder drafted"]);
    r.mentions = vec!["halvorsen studio".into()];
    c.record(Area::Tasks, r).unwrap();
    assert_eq!(c.mentions, vec!["Kamp Zeewind"]);
    c.answered_mention(&staged);
    assert!(c.mentions.is_empty());
    // With no mention left, NEXT is an area again and nothing closes.
    assert!(c.next(&staged).unwrap().area.is_some());
    assert_eq!(c.answered_mention(&staged), None);
}
