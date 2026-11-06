//! Avatars: the keys match the shared spec the clients draw from, the
//! default look matches theirs exactly, a look saved under the previous
//! system reads as its nearest key the same way theirs does, and a look
//! changes from chat at once through `update_agent` (no card: looks aren't
//! settings). Fixtures are fictional (Hiring, Sales).

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

fn look_of(shape: &str, face: &str, finish: Option<&str>) -> AgentLook {
    AgentLook {
        shape: shape.into(),
        face: face.into(),
        finish: finish.map(Into::into),
    }
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

/// The `key: 'value',` pairs of `export const <name>: Record<…> = { … }` in avatar.ts.
fn spec_map(name: &str) -> Vec<(String, String)> {
    let start = SPEC
        .find(&format!("export const {name}:"))
        .unwrap_or_else(|| panic!("{name} is in avatar.ts"));
    let body = &SPEC[start..];
    let body = &body[body.find("= {").unwrap() + 3..body.find("};").unwrap()];
    body.lines()
        .filter_map(|line| {
            let (k, v) = line.trim().trim_end_matches(',').split_once(':')?;
            Some((
                k.trim().to_string(),
                v.trim().trim_matches('\'').to_string(),
            ))
        })
        .collect()
}

#[test]
fn the_keys_are_the_specs_in_its_order() {
    assert_eq!(spec_keys("AVATAR_SHAPES"), store::AVATAR_SHAPES);
    assert_eq!(spec_keys("AVATAR_FACES"), store::AVATAR_FACES);
    assert_eq!(spec_keys("AVATAR_FINISHES"), store::AVATAR_FINISHES);
    assert!(SPEC.contains(&format!(
        "export const DEFAULT_FACE: AvatarFace = '{}';",
        store::DEFAULT_FACE
    )));
}

#[test]
fn an_old_look_migrates_to_the_nearest_key_exactly_as_the_clients_do() {
    let pairs = |m: &[(&str, &str)]| -> Vec<(String, String)> {
        m.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    };
    assert_eq!(spec_map("LEGACY_SHAPES"), pairs(store::LEGACY_SHAPES));
    assert_eq!(spec_map("LEGACY_FACES"), pairs(store::LEGACY_FACES));
    // Every old key is covered: the previous system's eight shapes and ten faces.
    for old in [
        "circle", "rounded", "squircle", "hexagon", "pill", "drop", "cookie", "arch",
    ] {
        assert!(store::shape_key(old).is_some(), "{old}");
    }
    for old in [
        "calm",
        "cheerful",
        "curious",
        "focused",
        "sleepy",
        "wink",
        "determined",
        "quiet",
        "content",
        "bright",
    ] {
        assert!(store::face_key(old).is_some(), "{old}");
    }
    // A stored old look reads as its nearest, field by field, and stays on disk as written.
    let mut social = agent("social", "Social");
    social.avatar = Some(look_of("drop", "wink", None));
    assert_eq!(AgentLook::of(&social), look_of("circle", "smile", None));
    let mut sales = agent("sales", "Sales");
    sales.avatar = Some(look_of("arch", "quiet", Some("embossed")));
    assert_eq!(
        AgentLook::of(&sales),
        look_of("squircle", "dots", Some("embossed"))
    );
    assert_eq!(sales.avatar.as_ref().unwrap().shape, "arch");
    // What the phone or the desk sends in old keys is saved in new ones.
    assert_eq!(
        look_of("rounded", "content", None).normalized(),
        Some(look_of("squircle", "dots", None))
    );
    assert_eq!(look_of("triangle", "dots", None).normalized(), None);
}

#[test]
fn the_default_look_is_the_one_the_clients_derive() {
    // Computed by `defaultLook` in avatar.ts (FNV-1a of the id); avatar.test.ts
    // holds the same table, so the two can't drift apart.
    for (id, shape, face) in [
        ("hiring", "hexagon", "dots"),
        ("finance", "circle", "dots"),
        ("a1b2c3", "hexagon", "dots"),
        ("acme", "diamond", "dots"),
        ("leadgen", "circle", "dots"),
        ("social", "diamond", "dots"),
        ("é-agent", "hexagon", "dots"),
    ] {
        assert_eq!(
            AgentLook::default_for(id, false),
            look_of(shape, face, None),
            "{id}"
        );
    }
    let mut boss = chief();
    assert_eq!(AgentLook::of(&boss), look_of("squircle", "dots", None));
    // A saved choice wins, field by field; an unknown key falls back.
    boss.avatar = Some(look_of("hexagon", "from-a-newer-build", Some("chrome")));
    assert_eq!(AgentLook::of(&boss), look_of("hexagon", "dots", None));
}

#[test]
fn an_agent_without_a_look_reads_and_writes_as_before() {
    let a = agent("h", "Hiring");
    assert_eq!(a.avatar, None);
    let v = serde_json::to_value(&a).unwrap();
    assert!(v.get("avatar").is_none());
    let mut b = a.clone();
    b.avatar = Some(AgentLook::checked("Hexagon", " smile ").unwrap());
    let v = serde_json::to_value(&b).unwrap();
    // A key cap writes no finish: exactly the shape an older build reads.
    assert_eq!(v["avatar"], json!({ "shape": "hexagon", "face": "smile" }));
    let round: Agent = serde_json::from_value(v).unwrap();
    assert_eq!(round.avatar, Some(look_of("hexagon", "smile", None)));
    let embossed = AgentLook::checked_with("circle", "dots", Some("Embossed")).unwrap();
    assert_eq!(
        serde_json::to_value(&embossed).unwrap(),
        json!({ "shape": "circle", "face": "dots", "finish": "embossed" })
    );
    assert!(AgentLook::checked("triangle", "dots")
        .unwrap_err()
        .contains("circle, squircle, diamond, hexagon"));
    assert!(AgentLook::checked_with("circle", "dots", Some("gold"))
        .unwrap_err()
        .contains("keycap, embossed"));
}

fn look(a: &Agent, args: serde_json::Value) -> Result<LookUpdate, String> {
    look_args(a, &args)
}

#[test]
fn give_hiring_a_hexagon_with_dot_eyes_applies_without_a_card() {
    let hiring = agent("h", "Hiring");
    let now = AgentLook::default_for("h", false);
    let target = if now.shape == "hexagon" {
        "diamond"
    } else {
        "hexagon"
    };
    let l = look(&hiring, json!({ "shape": target, "face": "smile" })).unwrap();
    assert_eq!(l.avatar, Some(look_of(target, "smile", None)));
    assert_eq!(
        l.line(),
        Some(format!("now a {target} with eyes and a mouth"))
    );
    // Colour only.
    let blue = look(&hiring, json!({ "color": "blue" })).unwrap();
    assert_eq!(blue.avatar, None);
    assert_eq!(blue.line().as_deref(), Some("now blue"));
    // A face alone keeps the shape it wears.
    let mono = look(&hiring, json!({ "face": "monogram" })).unwrap();
    assert_eq!(mono.avatar.as_ref().unwrap().shape, now.shape);
    assert_eq!(mono.line().as_deref(), Some("now has a monogram"));
    // The finish alone.
    let emb = look(&hiring, json!({ "finish": "embossed" })).unwrap();
    assert_eq!(
        emb.avatar.as_ref().unwrap().finish.as_deref(),
        Some("embossed")
    );
    assert_eq!(emb.line(), Some(format!("now an embossed {}", now.shape)));
    // An old word from chat still lands on its nearest key.
    let pill = look(&hiring, json!({ "shape": "pill" })).unwrap();
    if now.shape != "circle" {
        assert_eq!(pill.avatar.unwrap().shape, "circle");
    }
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
    // What it already wears changes nothing (a key cap asked for, a key cap worn).
    let now = AgentLook::default_for("h", false);
    let same = look(
        &hiring,
        json!({ "shape": now.shape, "face": now.face, "finish": "keycap", "color": "red" }),
    )
    .unwrap();
    assert_eq!(same, LookUpdate::default());
    assert_eq!(same.line(), None);
    // Back from embossed to a key cap, in words.
    let mut emb = agent("h", "Hiring");
    emb.avatar = Some(look_of(&now.shape, &now.face, Some("embossed")));
    let back = look(&emb, json!({ "finish": "keycap" })).unwrap();
    assert_eq!(back.line().as_deref(), Some("now a key cap"));
}

#[test]
fn describe_says_it_as_the_clients_do() {
    // describeLook in avatar.ts; avatar.test.ts checks the same sentences.
    let d = AgentLook::describe;
    assert_eq!(
        d(Some("hexagon"), Some("dots"), None),
        "a hexagon with dot eyes"
    );
    assert_eq!(
        d(Some("circle"), Some("smile"), None),
        "a circle with eyes and a mouth"
    );
    assert_eq!(
        d(Some("diamond"), None, Some("embossed")),
        "an embossed diamond"
    );
    assert_eq!(d(None, Some("monogram"), None), "a monogram");
    assert_eq!(d(None, None, Some("embossed")), "an embossed key");
}
