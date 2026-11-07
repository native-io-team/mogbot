//! The exact-text switch (`outward_text_needs_ok`) in the policy: the rule
//! that turns it on, inheritance, changes from chat and the desk, what is
//! said about it, and who hears about a settings change. Fictional team.

use super::*;
use crate::agents::policy_card::{self as card, Group};
use serde_json::json;

fn agent(id: &str, name: &str) -> Agent {
    serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap()
}

fn chief() -> Agent {
    let mut a = agent("chief", "Chief of Staff");
    a.is_main = true;
    a
}

const OWNERS_RULE: &str = "Nothing goes out under my name unless I approve that exact text";

#[test]
fn the_owners_words_are_recognised() {
    for r in [
        OWNERS_RULE,
        "Never post anything word for word without me",
        "Send nothing until I've approved the text",
        "Show me the exact wording before anything is sent",
        "Word-for-word approval for every email",
    ] {
        assert!(states_exact_text(r), "{r}");
    }
    for r in [
        "Never email clients",
        "Approve invoices under $50",
        "Keep replies short",
        "Text me when the deploy is done",
    ] {
        assert!(!states_exact_text(r), "{r}");
    }
}

#[test]
fn a_rule_that_says_it_turns_the_switch_on_once_and_stays_in_place() {
    let mut saved = Saved {
        version: 4,
        team: Preset::Balanced.team(),
        agents: Default::default(),
        exact_text_migrated: false,
    };
    saved.team.rules.push(OWNERS_RULE.into());
    saved.agents.insert(
        "voice".into(),
        Overrides {
            rules: vec!["Approve the text of every tweet first".into()],
            ..Default::default()
        },
    );
    saved.agents.insert(
        "ops".into(),
        Overrides {
            rules: vec!["Never email clients".into()],
            ..Default::default()
        },
    );
    assert!(migrate_exact_text(&mut saved));
    assert!(saved.team.outward_text_needs_ok);
    assert_eq!(
        saved.team.rules,
        vec![OWNERS_RULE.to_string()],
        "the words stay"
    );
    assert_eq!(saved.agents["voice"].outward_text_needs_ok, Some(true));
    assert_eq!(saved.agents["ops"].outward_text_needs_ok, None);
    // Once: an "off" the user chose later stays off.
    saved.team.outward_text_needs_ok = false;
    assert!(!migrate_exact_text(&mut saved));
    assert!(!saved.team.outward_text_needs_ok);
    // A fresh team starts migrated, with nothing to turn on.
    assert!(migrate(&[]).exact_text_migrated);
    // Old files without the field read as off.
    let old: Saved = serde_json::from_value(json!({
        "version": 2,
        "team": {
            "projects": { "scope": "all", "how": "copy", "elsewhere": "change" },
            "apps": { "mode": "all" },
            "browser": true,
            "rules": [OWNERS_RULE]
        }
    }))
    .unwrap();
    assert!(!old.team.outward_text_needs_ok);
    assert!(!old.exact_text_migrated);
}

#[test]
fn it_is_set_from_chat_inherited_and_said_plainly() {
    let saved = migrate(&[]);
    let voice = agent("voice", "Voice");
    let agents = vec![chief(), voice.clone()];
    // The Chief proposes it for the team.
    let p = card::build(
        &chief(),
        true,
        vec![Target::Team { everyone: false }],
        Change {
            outward_text_needs_ok: Some(true),
            ..Default::default()
        },
        None,
        &saved,
        &agents,
        Level::FullSend,
    )
    .unwrap();
    assert!(card::summary(&p.groups)
        .contains("Nothing goes out under your name until you OK the exact text"));
    // On is stricter: it applies without a card. Off waits for one.
    assert!(card::lowers_proposal(&p, &saved, &agents, Level::FullSend));
    let (on, _) = card::simulate(&saved, &p.targets, &p.change, Level::FullSend).unwrap();
    let eff = resolve(&on, &voice, Level::FullSend);
    assert!(eff.outward_text_needs_ok, "inherited from the team");
    let off = card::Proposal {
        change: Change {
            outward_text_needs_ok: Some(false),
            ..Default::default()
        },
        ..p.clone()
    };
    assert!(!card::lowers_proposal(&off, &on, &agents, Level::FullSend));
    // Shown on "What it can do", enforced by the app; not in the prompt's list
    // but said in its own paragraph.
    let line = describe(&eff, None)
        .into_iter()
        .find(|l| l.key == "outward_text")
        .unwrap();
    assert_eq!(line.enforced, "app");
    assert!(line.team);
    assert!(line.value.contains("exact text"));
    let prompt = prompt_section(&eff, &voice);
    assert!(prompt.contains("until they OK its exact text"));
    assert!(
        !prompt_section(&resolve(&saved, &voice, Level::FullSend), &voice).contains("exact text:")
    );
    // An agent of its own: on for one, the team's off.
    let mut one = saved.clone();
    apply(
        &mut one,
        &Target::Agent {
            agent_id: "voice".into(),
        },
        &Change {
            outward_text_needs_ok: Some(true),
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    let e = resolve(&one, &voice, Level::GoHard);
    assert!(e.outward_text_needs_ok && e.own.contains(&"outward_text"));
    assert!(!resolve(&one, &chief(), Level::GoHard).outward_text_needs_ok);
}

#[test]
fn adding_the_rule_in_chat_turns_it_on_and_presets_keep_it() {
    let saved = migrate(&[]);
    let voice = agent("voice", "Voice");
    let agents = vec![chief(), voice.clone()];
    let p = card::build(
        &chief(),
        true,
        vec![Target::Team { everyone: false }],
        Change {
            add_rules: vec![OWNERS_RULE.into()],
            ..Default::default()
        },
        None,
        &saved,
        &agents,
        Level::GoHard,
    )
    .unwrap();
    let said = card::summary(&p.groups);
    assert!(said.contains("(the app enforces it)"), "{said}");
    assert!(!said.contains("not enforced"), "{said}");
    assert!(!p.has_rules, "not only words");
    let (mut after, _) = card::simulate(&saved, &p.targets, &p.change, Level::GoHard).unwrap();
    assert!(after.team.outward_text_needs_ok);
    assert_eq!(after.team.rules, vec![OWNERS_RULE.to_string()]);
    // A preset for the team is about reach: the switch stays on.
    apply(
        &mut after,
        &Target::Team { everyone: true },
        &Change {
            preset: Some(Preset::Trusted),
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    assert!(after.team.outward_text_needs_ok);
}

fn group(who: &str, ids: &[&str], change: &str) -> Group {
    Group {
        who: who.into(),
        agent_ids: ids.iter().map(|s| s.to_string()).collect(),
        changes: vec![change.into()],
    }
}

/// Observed: a team rule put ~17 identical "Settings changed: New rule…"
/// notes in every agent's chat in the same minute.
#[test]
fn a_team_change_is_one_note_in_the_chiefs_chat() {
    let mut agents = vec![chief()];
    for i in 0..17 {
        agents.push(agent(&format!("a{i}"), &format!("Agent {i}")));
    }
    let before = migrate(&[]);
    let mut after = before.clone();
    after.team.rules.push("Keep replies short".into());
    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    let groups = vec![group("Everyone", &ids, "New rule: “Keep replies short”")];
    // Proposed by the Chief: its card is the note; nobody else hears.
    assert!(card::notes_for(&before, &after, &groups, &agents, Some("chief"), "S: ").is_empty());
    // Changed on the desk: exactly one note, in the Chief's chat.
    let notes = card::notes_for(&before, &after, &groups, &agents, None, "S: ");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].0, "chief");
    // Proposed by another admin: the Chief hears once, the proposer has its card.
    let notes = card::notes_for(&before, &after, &groups, &agents, Some("a3"), "S: ");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].0, "chief");
}

#[test]
fn an_agent_hears_only_about_its_own_settings() {
    let agents = vec![chief(), agent("voice", "Voice"), agent("ops", "Ops")];
    let before = migrate(&[]);
    let mut after = before.clone();
    after.agents.insert(
        "voice".into(),
        Overrides {
            browser: Some(false),
            ..Default::default()
        },
    );
    let groups = vec![group("Voice", &["voice"], "Can no longer use your browser")];
    let notes = card::notes_for(&before, &after, &groups, &agents, Some("chief"), "S: ");
    assert_eq!(
        notes,
        vec![(
            "voice".to_string(),
            "S: Can no longer use your browser".to_string()
        )]
    );
}
