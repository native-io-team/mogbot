//! Avatars: the keys match the shared spec the clients draw from, the
//! default look matches theirs exactly, and a look changes from chat at
//! once through `update_agent` (no card: looks aren't settings). Fixtures are fictional (Hiring, Sales).

use super::mcp::{look_args, LookUpdate};
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

fn look(a: &Agent, args: serde_json::Value) -> Result<LookUpdate, String> {
    look_args(a, &args)
}

#[test]
fn give_hiring_a_hexagon_with_a_curious_face_applies_without_a_card() {
    let hiring = agent("h", "Hiring");
    let l = look(&hiring, json!({ "shape": "Hexagon", "face": "curious" })).unwrap();
    assert_eq!(
        l.avatar,
        Some(AgentLook {
            shape: "hexagon".into(),
            face: "curious".into()
        })
    );
    assert_eq!(
        l.line().as_deref(),
        Some("now a hexagon with a curious face")
    );
    // Colour only.
    let blue = look(&hiring, json!({ "color": "blue" })).unwrap();
    assert_eq!(blue.avatar, None);
    assert_eq!(blue.line().as_deref(), Some("now blue"));
    // A face alone keeps the shape it wears.
    let sleepy = look(&hiring, json!({ "face": "sleepy" })).unwrap();
    let now = AgentLook::default_for("h", false);
    assert_eq!(sleepy.avatar.as_ref().unwrap().shape, now.shape);
    assert_eq!(sleepy.line().as_deref(), Some("now has a sleepy face"));
}

#[test]
fn a_look_is_checked_in_plain_words_and_what_it_wears_changes_nothing() {
    let hiring = agent("h", "Hiring");
    assert!(look(&hiring, json!({ "shape": "star" }))
        .unwrap_err()
        .contains("no shape called \"star\""));
    assert!(look(&hiring, json!({ "color": "neon" }))
        .unwrap_err()
        .contains("no colour called \"neon\""));
    // No look asked for: nothing.
    assert_eq!(
        look(&hiring, json!({ "role": "x" })).unwrap(),
        LookUpdate::default()
    );
    // What it already wears changes nothing.
    let now = AgentLook::default_for("h", false);
    let same = look(
        &hiring,
        json!({ "shape": now.shape, "face": now.face, "color": "red" }),
    )
    .unwrap();
    assert_eq!(same, LookUpdate::default());
    assert_eq!(same.line(), None);
}
