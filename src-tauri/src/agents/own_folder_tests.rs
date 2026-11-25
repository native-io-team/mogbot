//! "Work in my real folder", from chat: an agent moving itself from its own
//! copy to working directly in its project needs no card when the user's own
//! message asked, and an open copy no longer stops the switch. Anything more
//! than that one move still waits for the card. Fictional agents and paths.

use super::*;
use crate::agents::policy::{migrate, Change, Target};
use serde_json::json;

fn agent(id: &str, name: &str, project: Option<&str>) -> Agent {
    let mut a: Agent = serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap();
    a.project = project.map(str::to_string);
    a
}

fn site() -> Agent {
    agent("site", "Bakery Site", Some("/Users/x/ShipStudio/bakery"))
}

fn one(id: &str) -> Vec<Target> {
    vec![Target::Agent {
        agent_id: id.into(),
    }]
}

fn how(h: How) -> Change {
    Change {
        how: Some(h),
        ..Default::default()
    }
}

fn proposal(caller: &Agent, targets: Vec<Target>, change: Change, agents: &[Agent]) -> Proposal {
    build(
        caller,
        policy::is_admin(caller),
        targets,
        change,
        None,
        &migrate(&[]),
        agents,
        Level::Judgement,
    )
    .unwrap()
}

#[test]
fn moving_itself_from_its_copy_to_its_folder_is_the_one_move_that_skips_the_card() {
    let me = site();
    let agents = vec![me.clone(), agent("w", "Writer", None)];
    let saved = migrate(&[]);
    assert_eq!(
        policy::resolve(&saved, &me, Level::Judgement).projects.how,
        How::Copy,
        "copies are the default"
    );
    let p = proposal(&me, one("site"), how(How::Direct), &agents);
    assert!(own_folder_only(&me, &p, &saved, &agents, Level::Judgement));
    // It isn't a lowering, so without the user's own ask it is still a card.
    assert!(!proposal_lowers(&p, &saved, &agents, Level::Judgement));
}

#[test]
fn anything_more_than_that_move_still_waits_for_the_card() {
    let me = site();
    let other = agent("w", "Writer", Some("/Users/x/ShipStudio/blog"));
    let agents = vec![me.clone(), other.clone()];
    let saved = migrate(&[]);
    // Another agent's folder (only an admin may even propose it).
    let p = build(
        &me,
        true,
        one("w"),
        how(How::Direct),
        None,
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert!(!own_folder_only(&me, &p, &saved, &agents, Level::Judgement));
    // Its folder plus a level.
    let more = Change {
        how: Some(How::Direct),
        independence: Some("full_send".into()),
        ..Default::default()
    };
    let p = proposal(&me, one("site"), more, &agents);
    assert!(!own_folder_only(&me, &p, &saved, &agents, Level::Judgement));
    // Its folder plus how it treats every other project.
    let flipped = match saved.team.projects.elsewhere {
        policy::Elsewhere::Change => policy::Elsewhere::Read,
        policy::Elsewhere::Read => policy::Elsewhere::Change,
    };
    let more = Change {
        how: Some(How::Direct),
        elsewhere: Some(flipped),
        ..Default::default()
    };
    let p = build(
        &me,
        false,
        one("site"),
        more,
        None,
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert!(!own_folder_only(&me, &p, &saved, &agents, Level::Judgement));
    // From read only to directly is more room, not the copy move.
    let mut ro = saved.clone();
    ro.agents.insert(
        "site".into(),
        policy::Overrides {
            projects: Some(policy::Projects {
                how: How::ReadOnly,
                ..ro.team.projects.clone()
            }),
            ..Default::default()
        },
    );
    let p = build(
        &me,
        false,
        one("site"),
        how(How::Direct),
        None,
        &ro,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert!(!own_folder_only(&me, &p, &ro, &agents, Level::Judgement));
    // An agent with no project has no folder to move to.
    let loose = agent("l", "Loose", None);
    let agents = vec![loose.clone()];
    if let Ok(p) = build(
        &loose,
        false,
        one("l"),
        how(How::Direct),
        None,
        &saved,
        &agents,
        Level::Judgement,
    ) {
        assert!(!own_folder_only(
            &loose,
            &p,
            &saved,
            &agents,
            Level::Judgement
        ));
    }
}

#[test]
fn an_open_copy_no_longer_blocks_working_directly() {
    let mut me = site();
    me.copy = Some(
        serde_json::from_value(json!({
            "id": "c1",
            "project": "/Users/x/ShipStudio/bakery",
            "path": "/Users/x/ShipStudio/.worktrees/bakery/bakery-site-c1",
            "branch": "bakery-site/c1",
            "base": "0000000000000000000000000000000000000000",
            "createdAt": 0
        }))
        .unwrap(),
    );
    let agents = vec![me.clone()];
    let p = build(
        &me,
        false,
        one("site"),
        how(How::Direct),
        None,
        &migrate(&[]),
        &agents,
        Level::Judgement,
    );
    assert!(p.is_ok(), "{:?}", p.err());
}
