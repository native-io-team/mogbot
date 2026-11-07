//! One agent's own independence level: what it resolves to, that the
//! decision paths read it, that outside text is never raised by it, and that
//! from chat raising one needs the user's card while lowering one applies at
//! once. Fictional agents (Finance, Social Posts) and a fictional Mac.

use super::*;
use crate::agents::autoallow::{auto, Ctx};
use crate::agents::independence::{self, prompt_section, Level};
use crate::agents::policy::{
    self, independence_for, migrate, own_independence, Change, Overrides, Saved, Target,
};
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

fn with_level(saved: &mut Saved, id: &str, level: Level) {
    saved.agents.insert(
        id.into(),
        Overrides {
            independence: Some(level),
            ..Default::default()
        },
    );
}

fn level_change(level: &str) -> Change {
    Change {
        independence: Some(level.into()),
        ..Default::default()
    }
}

fn one(id: &str) -> Vec<Target> {
    vec![Target::Agent {
        agent_id: id.into(),
    }]
}

/// Build what the Chief would propose, and whether it applies without a card.
fn lowers(saved: &Saved, targets: Vec<Target>, change: Change, team: Level) -> Option<bool> {
    let agents = vec![chief(), agent("f", "Finance"), agent("s", "Social Posts")];
    let p = build(&chief(), true, targets, change, None, saved, &agents, team).ok()?;
    Some(lowers_proposal(&p, saved, &agents, team))
}

#[test]
fn the_effective_level_is_its_own_or_the_teams() {
    let mut saved = migrate(&[]);
    with_level(&mut saved, "s", Level::FullSend);
    let social = agent("s", "Social Posts");
    let finance = agent("f", "Finance");
    assert_eq!(own_independence(&saved, "s"), Some(Level::FullSend));
    assert_eq!(own_independence(&saved, "f"), None);
    for team in [
        Level::Often,
        Level::Judgement,
        Level::GoHard,
        Level::FullSend,
    ] {
        assert_eq!(
            policy::resolve(&saved, &social, team).independence,
            Level::FullSend
        );
        assert_eq!(policy::resolve(&saved, &finance, team).independence, team);
    }
    // Back on the team's: nothing of its own left.
    policy::apply(
        &mut saved,
        &one("s")[0],
        &level_change("team"),
        Level::GoHard,
    )
    .unwrap();
    assert_eq!(own_independence(&saved, "s"), None);
}

#[test]
fn the_decision_paths_read_the_agents_own_level() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    independence::set_level(Level::GoHard, 1).unwrap();
    policy::modify(|s| {
        with_level(s, "s", Level::FullSend);
        with_level(s, "f", Level::Often);
        Ok(())
    })
    .unwrap();
    let social = agent("s", "Social Posts");
    let finance = agent("f", "Finance");
    let plain = agent("p", "Plain");
    assert_eq!(policy::chosen_level(&social), Level::FullSend);
    assert_eq!(policy::chosen_level(&finance), Level::Often);
    assert_eq!(policy::chosen_level(&plain), Level::GoHard, "the team's");

    // `mcp::decide`'s auto-allow at each one's own level: opening a pull
    // request asks at Go hard (the team) and runs at Full send (its own).
    let home = "/Users/fictional-tester";
    let ctx = Ctx {
        home: home.into(),
        own_home: format!("{home}/agents/s").into(),
        cwd: format!("{home}/agents/s").into(),
        scratch: vec![format!("{home}/agents/s").into()],
        ..Default::default()
    };
    let pr = json!({ "command": "gh pr create --base main --head fix/copy --title Copy --body x" });
    let card = |a: &Agent, outside: bool| {
        auto(policy::chosen_level(a), outside, "Bash", &pr, &ctx).is_none()
    };
    assert!(!card(&social, false), "Full send: no card");
    assert!(card(&plain, false), "Go hard: a card");
    assert!(card(&finance, false), "Check with me often: a card");
    // A plain read: answered at Go hard, asked at "Check with me often".
    let read = json!({ "command": format!("ls -la {home}/Documents") });
    assert!(auto(policy::chosen_level(&plain), false, "Bash", &read, &ctx).is_some());
    assert!(auto(policy::chosen_level(&finance), false, "Bash", &read, &ctx).is_none());

    // Outside text is capped whatever the agent's own level: its sends ask,
    // and its prompt and browser run at "Use good judgement".
    assert!(
        card(&social, true),
        "outside text never sends without a card"
    );
    assert_eq!(independence_for(&social, true), Level::Judgement);
    assert_eq!(independence_for(&social, false), Level::FullSend);
    assert_eq!(
        prompt_section(independence_for(&social, true)),
        prompt_section(Level::Judgement)
    );
    // Lower than the cap stays lower.
    assert_eq!(independence_for(&finance, true), Level::Often);
    store::set_root_for_tests(None);
}

#[test]
fn from_chat_raising_needs_the_card_and_lowering_applies() {
    let saved = migrate(&[]);
    let team = Level::GoHard;
    // "Make Finance check with me often": lower, no card.
    assert_eq!(
        lowers(&saved, one("f"), level_change("often"), team),
        Some(true)
    );
    // "Put Social Posts on Full send": higher than the team, a card.
    assert_eq!(
        lowers(&saved, one("s"), level_change("full_send"), team),
        Some(false)
    );
    // The team's level down: everyone stricter, no card. Up: a card.
    let team_t = vec![Target::Team { everyone: false }];
    assert_eq!(
        lowers(&saved, team_t.clone(), level_change("judgement"), team),
        Some(true)
    );
    assert_eq!(
        lowers(&saved, team_t, level_change("full_send"), team),
        Some(false)
    );
    // Lowering together with anything else: a card for all of it.
    let mut both = level_change("often");
    both.browser = Some(true);
    let mut off = migrate(&[]);
    off.agents.insert(
        "f".into(),
        Overrides {
            browser: Some(false),
            ..Default::default()
        },
    );
    assert_eq!(lowers(&off, one("f"), both, team), Some(false));

    // Back to the team's when the team is higher than its own: a raise.
    let mut strict = migrate(&[]);
    with_level(&mut strict, "f", Level::Often);
    assert_eq!(
        lowers(&strict, one("f"), level_change("team"), team),
        Some(false)
    );
    // And when the team is lower than its own: a lowering.
    let mut wild = migrate(&[]);
    with_level(&mut wild, "s", Level::FullSend);
    assert_eq!(
        lowers(&wild, one("s"), level_change("team"), team),
        Some(true)
    );
    // Nothing would change: no proposal at all.
    assert_eq!(
        lowers(&wild, one("s"), level_change("full_send"), team),
        None
    );
}

#[test]
fn an_agent_may_lower_itself_but_never_raise_itself_without_a_card() {
    let saved = migrate(&[]);
    let social = agent("s", "Social Posts");
    let agents = vec![chief(), social.clone()];
    let down = build(
        &social,
        false,
        one("s"),
        level_change("often"),
        None,
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert!(lowers_proposal(&down, &saved, &agents, Level::Judgement));
    let up = build(
        &social,
        false,
        one("s"),
        level_change("full_send"),
        None,
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert!(!lowers_proposal(&up, &saved, &agents, Level::Judgement));
    // Not for another agent unless it's an admin.
    assert!(build(
        &social,
        false,
        one("chief"),
        level_change("often"),
        None,
        &saved,
        &agents,
        Level::Judgement
    )
    .is_err());
}

#[test]
fn the_tool_tells_the_chief_how_to_set_one_agent() {
    let schema = schema().to_string();
    assert!(schema.contains("put Social Posts on Full send"));
    assert!(schema.contains("make Finance check with me often"));
    assert!(schema.contains("Raising needs the user's card; lowering"));
}

#[test]
fn fix_stopped_previews_changes_from_chat_like_any_setting() {
    // On is more room: a card. Off only has agents do less: no card.
    let fix = |on: bool| MacChange {
        fix_previews: Some(on),
        ..Default::default()
    };
    let now = |on: bool| MacNow {
        fix_previews: on,
        ..Default::default()
    };
    let on = mac_proposal(true, &fix(true), &now(false), Some("you asked".into()), 4).unwrap();
    assert_eq!(on.groups[0].who, "This Mac");
    assert!(on.groups[0].changes[0].contains("fix their own stopped previews"));
    assert!(on.targets.is_empty() && on.change.is_empty());
    assert!(!mac_lowers(on.mac.as_ref().unwrap()));
    let off = mac_proposal(true, &fix(false), &now(true), None, 4).unwrap();
    assert!(mac_lowers(off.mac.as_ref().unwrap()));
    assert!(summary(&off.groups).starts_with("This Mac: Agents no longer fix"));
    // Only an admin, and only a real change.
    assert!(mac_proposal(false, &fix(false), &now(true), None, 4).is_err());
    assert!(mac_proposal(true, &fix(true), &now(true), None, 4).is_err());
    // It travels on the card as `mac`, and old cards read without it.
    let v = serde_json::to_value(&on).unwrap();
    assert_eq!(v["mac"]["fixPreviews"], true);
    let old: Proposal = serde_json::from_value(json!({
        "targets": [], "change": {}, "version": 1, "groups": []
    }))
    .unwrap();
    assert_eq!(old.mac, None);
    // The tool says it can.
    let schema = schema().to_string();
    assert!(schema.contains("fix_previews"));
    assert!(DESCRIPTION.contains("Fix stopped previews”"));
}
