//! Avatars: the keys match the shared spec the clients draw from, the
//! default look matches theirs exactly, and a look changes from chat only
//! through a settings card. Fixtures are fictional (Hiring, Sales).

use super::policy::{Change, Target};
use super::policy_card::{self as card, LookChange};
use super::store::{self, Agent, AgentLook};
use serde_json::json;

const SPEC: &str = include_str!("../../../packages/companion-protocol/src/avatar.ts");

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

/// The quoted keys of `export const <name> = [ … ]` in avatar.ts.
fn spec_keys(name: &str) -> Vec<String> {
    let start = SPEC
        .find(&format!("export const {name} = ["))
        .unwrap_or_else(|| panic!("{name} is in avatar.ts"));
    let body = &SPEC[start..];
    let body = &body[body.find('[').unwrap() + 1..body.find(']').unwrap()];
    body.split(',')
        .map(|k| k.trim().trim_matches('\'').to_string())
        .filter(|k| !k.is_empty())
        .collect()
}

#[test]
fn the_keys_are_the_specs_in_its_order() {
    assert_eq!(spec_keys("AVATAR_SHAPES"), store::AVATAR_SHAPES);
    assert_eq!(spec_keys("AVATAR_FACES"), store::AVATAR_FACES);
}

#[test]
fn the_default_look_is_the_one_the_clients_derive() {
    // Computed by `defaultLook` in avatar.ts (FNV-1a of the id); avatar.test.ts
    // holds the same table, so the two can't drift apart.
    for (id, shape, face) in [
        ("hiring", "circle", "focused"),
        ("finance", "pill", "quiet"),
        ("a1b2c3", "drop", "bright"),
        ("acme", "cookie", "cheerful"),
        ("leadgen", "arch", "determined"),
        ("social", "rounded", "content"),
        ("é-agent", "circle", "focused"),
    ] {
        assert_eq!(
            AgentLook::default_for(id, false),
            AgentLook {
                shape: shape.into(),
                face: face.into()
            },
            "{id}"
        );
    }
    let mut boss = chief();
    assert_eq!(AgentLook::of(&boss).shape, "squircle");
    assert_eq!(AgentLook::of(&boss).face, "calm");
    // A saved choice wins, field by field; an unknown key falls back.
    boss.avatar = Some(AgentLook {
        shape: "hexagon".into(),
        face: "from-a-newer-build".into(),
    });
    assert_eq!(AgentLook::of(&boss).shape, "hexagon");
    assert_eq!(AgentLook::of(&boss).face, "calm");
}

#[test]
fn an_agent_without_a_look_reads_and_writes_as_before() {
    let a = agent("h", "Hiring");
    assert_eq!(a.avatar, None);
    let v = serde_json::to_value(&a).unwrap();
    assert!(v.get("avatar").is_none());
    let mut b = a.clone();
    b.avatar = Some(AgentLook::checked("Hexagon", " curious ").unwrap());
    let round: Agent = serde_json::from_value(serde_json::to_value(&b).unwrap()).unwrap();
    assert_eq!(
        round.avatar,
        Some(AgentLook {
            shape: "hexagon".into(),
            face: "curious".into()
        })
    );
    assert!(AgentLook::checked("triangle", "calm")
        .unwrap_err()
        .contains("circle, rounded"));
}

fn hiring_only() -> Vec<Target> {
    vec![Target::Agent {
        agent_id: "h".into(),
    }]
}

#[test]
fn give_hiring_a_hexagon_with_a_curious_face() {
    let agents = vec![chief(), agent("h", "Hiring")];
    let look = card::parse_look(Some(&json!({ "shape": "Hexagon", "face": "curious" })))
        .unwrap()
        .unwrap();
    let p = card::look_only(&chief(), true, hiring_only(), look, None, &agents).unwrap();
    assert_eq!(
        card::summary(&p.groups),
        "Hiring: Now a hexagon with a curious face."
    );
    assert!(p.change.is_empty());
    assert_eq!(p.look.as_ref().unwrap().shape.as_deref(), Some("hexagon"));
    // Colour only.
    let blue = card::parse_look(Some(&json!({ "color": "blue" })))
        .unwrap()
        .unwrap();
    let p = card::look_only(&chief(), true, hiring_only(), blue, None, &agents).unwrap();
    assert_eq!(card::summary(&p.groups), "Hiring: Now blue.");
}

#[test]
fn a_look_is_checked_and_refused_in_plain_words() {
    let agents = vec![chief(), agent("h", "Hiring"), agent("s", "Sales")];
    assert!(card::parse_look(Some(&json!({ "shape": "star" })))
        .unwrap_err()
        .contains("no shape called \"star\""));
    assert!(card::parse_look(Some(&json!({})))
        .unwrap_err()
        .contains("empty"));
    assert_eq!(card::parse_look(None).unwrap(), None);
    let hex = || LookChange {
        shape: Some("hexagon".into()),
        ..Default::default()
    };
    // Not for the team's defaults.
    assert!(card::look_only(
        &chief(),
        true,
        vec![Target::Team { everyone: false }],
        hex(),
        None,
        &agents
    )
    .is_err());
    // An agent proposes its own look; only an admin proposes another's.
    let sales = agent("s", "Sales");
    assert!(card::look_only(&sales, false, hiring_only(), hex(), None, &agents).is_err());
    let own = vec![Target::Agent {
        agent_id: "s".into(),
    }];
    assert!(card::look_only(&sales, false, own, hex(), None, &agents).is_ok());
    // What it already wears changes nothing.
    let now = AgentLook::default_for("h", false);
    let same = LookChange {
        shape: Some(now.shape),
        face: Some(now.face),
        color: Some("red".into()),
    };
    assert!(
        card::look_only(&chief(), true, hiring_only(), same, None, &agents)
            .unwrap_err()
            .contains("already")
    );
}

#[test]
fn a_look_rides_along_with_a_policy_change_on_one_line_of_its_group() {
    let agents = vec![chief(), agent("h", "Hiring")];
    let base = card::Proposal {
        targets: hiring_only(),
        change: Change {
            browser: Some(false),
            ..Default::default()
        },
        version: 1,
        groups: vec![card::Group {
            who: "Hiring".into(),
            agent_ids: vec!["h".into()],
            changes: vec!["Can no longer use your browser".into()],
        }],
        why: None,
        has_rules: false,
        look: None,
    };
    let look = LookChange {
        face: Some("sleepy".into()),
        ..Default::default()
    };
    let p = card::add_look(base, &chief(), true, look, &agents).unwrap();
    assert_eq!(
        card::summary(&p.groups),
        "Hiring: Can no longer use your browser. Now has a sleepy face."
    );
}
