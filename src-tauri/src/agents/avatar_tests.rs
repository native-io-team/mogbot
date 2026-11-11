//! Looks from before keys (a shape, a face, a finish): nothing draws them
//! any more (agents are keys, docs/design/agent-keys.md), so they are no
//! longer kept, served or changed from chat. A registry that still holds
//! one reads as before and drops it on the next save. Fixtures are fictional
//! (Hiring).

use super::mcp::look_args;
use super::store::{self, Agent};
use serde_json::json;

fn agent(id: &str, name: &str) -> Agent {
    serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap()
}

#[test]
fn a_saved_look_reads_and_is_dropped_on_the_next_save() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let made = store::create(store::NewAgent {
        name: "Hiring".into(),
        role: "Finds people".into(),
        instructions: "Be brief.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    // As an older build wrote it: the agent with a look beside its key.
    let path = dir.path().join("agents.json");
    let raw = std::fs::read_to_string(&path).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    value["agents"][0]["avatar"] =
        json!({ "shape": "hexagon", "face": "smile", "finish": "embossed" });
    std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();

    let read = store::get(&made.id).unwrap();
    assert_eq!(read.name, "Hiring");
    assert!(!read.extra.contains_key(store::OLD_LOOK), "not served");
    let served = serde_json::to_value(&read).unwrap();
    assert!(served.get("avatar").is_none());

    store::update(&made.id, |a| a.muted = true).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(saved["agents"][0].get("avatar").is_none(), "gone from disk");
    assert_eq!(saved["agents"][0]["muted"], true);
    store::set_root_for_tests(None);
}

#[test]
fn the_chief_changes_a_key_not_a_shape() {
    let hiring = agent("h1", "Hiring");
    let team = vec![hiring.clone()];
    // A shape, face or finish is no longer a look: nothing changes, no error.
    let old = look_args(
        &hiring,
        &team,
        &json!({ "shape": "hexagon", "face": "smile", "finish": "embossed" }),
    )
    .unwrap();
    assert_eq!(old.line(), None);
    // Its key and colour still change.
    let teal = look_args(&hiring, &team, &json!({ "color": "teal" })).unwrap();
    assert_eq!(teal.color.as_deref(), Some("teal"));
    assert!(teal.line().is_some_and(|l| l.contains("teal")));
}
