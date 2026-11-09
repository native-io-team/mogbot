//! Agent keys: the Mac's migration lands where the clients' fallback does
//! (`agent-key-cases.json`, held by agentKeys.test.ts too), bound keys stay
//! unique, and a key changes from chat at once through `update_agent`.
//! Fixtures are fictional.

use super::keys::{self, KeyChange};
use super::mcp::look_args;
use super::store::{self, Agent};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

fn agent(id: &str, name: &str, color: &str) -> Agent {
    serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": color, "createdAt": 0
    }))
    .unwrap()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IconCase {
    name: String,
    role: String,
    is_main: bool,
    icon: String,
}

#[derive(Deserialize)]
struct KeyCase {
    name: String,
    taken: String,
    key: String,
}

#[derive(Deserialize)]
struct ColorCase {
    color: String,
    colorway: String,
}

#[derive(Deserialize)]
struct Cases {
    icons: Vec<IconCase>,
    #[serde(rename = "boundKeys")]
    bound_keys: Vec<KeyCase>,
    colors: Vec<ColorCase>,
}

fn cases() -> Cases {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/companion-protocol/src/agent-key-cases.json"
    )))
    .unwrap()
}

#[test]
fn the_shared_cases_hold_on_the_mac() {
    let c = cases();
    for case in c.icons {
        assert_eq!(
            keys::icon_for(&case.name, &case.role, case.is_main),
            case.icon,
            "{}",
            case.name
        );
    }
    for case in c.bound_keys {
        let taken: HashSet<String> = case.taken.chars().map(|c| c.to_string()).collect();
        assert_eq!(
            keys::bound_key_for(&case.name, &taken).as_deref(),
            Some(case.key.as_str()),
            "{}",
            case.name
        );
    }
    for case in c.colors {
        assert_eq!(keys::colorway_for_color(&case.color), case.colorway);
    }
    // Every old colour key has a nearest colourway, and every colourway an old colour.
    for old in store::COLORS {
        assert!(keys::is_colorway(&keys::colorway_for_color(old)), "{old}");
    }
    for c in keys::colorways() {
        assert!(store::COLORS.contains(&keys::legacy_color_for(c).as_str()));
    }
    assert_eq!(keys::colorways().len(), 8);
    assert!(keys::icons().len() >= 20);
}

#[test]
fn a_team_saved_before_keys_gets_one_each_chief_first() {
    let mut chief = agent("chief", "Chief of Staff", "white");
    chief.is_main = true;
    let mut team = vec![
        agent("c", "Client Sites", "teal"),
        agent("f", "Finance", "amber"),
        chief,
        agent("f2", "Finance Two", "purple"),
    ];
    assert!(keys::fill(&mut team));
    let got: Vec<(&str, &str, &str)> = team
        .iter()
        .map(|a| {
            (
                a.colorway.as_deref().unwrap(),
                a.icon.as_deref().unwrap(),
                a.bound_key.as_deref().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("teal", "globe", "L"),
            ("mustard", "money", "F"),
            ("putty", "star", "C"),
            ("blue", "money", "I"),
        ]
    );
    // Nothing changes the second time.
    assert!(!keys::fill(&mut team));
    // A duplicate (a restored agent) gets a free key; the first keeps its own.
    team[3].bound_key = Some("F".into());
    assert!(keys::fill(&mut team));
    assert_eq!(team[1].bound_key.as_deref(), Some("F"));
    assert_eq!(team[3].bound_key.as_deref(), Some("I"));
}

#[test]
fn a_key_change_is_checked_against_the_team() {
    let mut team = vec![agent("a", "Finance", "amber"), agent("b", "Hiring", "teal")];
    keys::fill(&mut team);
    let hiring = team[1].clone();
    let err = KeyChange::checked(Some(&hiring), &team, None, None, Some("f")).unwrap_err();
    assert!(err.contains("F is already Finance's key"), "{err}");
    assert!(
        KeyChange::checked(Some(&hiring), &team, None, None, Some("/"))
            .unwrap_err()
            .contains("one letter or digit")
    );
    assert!(
        KeyChange::checked(Some(&hiring), &team, Some("chrome"), None, None)
            .unwrap_err()
            .contains("blue, orange, putty")
    );
    assert!(
        KeyChange::checked(Some(&hiring), &team, None, Some("unicorn"), None)
            .unwrap_err()
            .contains("There's no icon")
    );
    let change = KeyChange::checked(
        Some(&hiring),
        &team,
        Some("Graphite"),
        Some("chat"),
        Some("q"),
    )
    .unwrap();
    assert_eq!(
        change.line().as_deref(),
        Some("now Graphite, with the Chat legend, on key Q")
    );
    let mut h = hiring.clone();
    change.apply(&mut h);
    assert_eq!(
        (
            h.colorway.as_deref(),
            h.icon.as_deref(),
            h.bound_key.as_deref(),
            h.color.as_str()
        ),
        (Some("graphite"), Some("chat"), Some("Q"), "gray")
    );
    // Its own key again is no change.
    let same = KeyChange::checked(Some(&h), &team, None, None, Some("q")).unwrap();
    assert!(same.is_empty());
}

#[test]
fn put_finance_on_g_from_chat_applies_without_a_card() {
    let mut team = vec![agent("a", "Finance", "amber"), agent("b", "Hiring", "teal")];
    keys::fill(&mut team);
    let l = look_args(&team[0], &team, &json!({ "key": "g", "icon": "chart" })).unwrap();
    assert_eq!(
        l.line().as_deref(),
        Some("now with the Data legend, on key G")
    );
    assert!(look_args(&team[0], &team, &json!({ "key": "H" }))
        .unwrap_err()
        .contains("Hiring's key"));
    // An old colour moves the colourway with it, said once.
    let blue = look_args(&team[0], &team, &json!({ "color": "blue" })).unwrap();
    assert_eq!(blue.key.colorway.as_deref(), Some("blue"));
    assert_eq!(blue.line().as_deref(), Some("now blue"));
}

#[test]
fn keys_round_trip_and_an_agent_without_them_reads_as_before() {
    let a = agent("h", "Hiring", "red");
    let v = serde_json::to_value(&a).unwrap();
    assert!(v.get("colorway").is_none() && v.get("boundKey").is_none());
    let mut b = a.clone();
    keys::fill(std::slice::from_mut(&mut b));
    let v = serde_json::to_value(&b).unwrap();
    assert_eq!(v["colorway"], json!("orange"));
    assert_eq!(v["icon"], json!("people"));
    assert_eq!(v["boundKey"], json!("H"));
    let round: Agent = serde_json::from_value(v).unwrap();
    assert_eq!(round, b);
}

#[test]
fn a_new_agent_gets_its_colours_nearest_colourway_its_icon_and_its_letter() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let make = |name: &str, color: Option<&str>| {
        store::create(store::NewAgent {
            name: name.into(),
            role: "Does things".into(),
            instructions: "Do them.".into(),
            shape: None,
            avatar: None,
            color: color.map(Into::into),
            is_main: false,
        })
        .unwrap()
    };
    let finance = make("Finance", None);
    let fixer = make("Fixer", None);
    let social = make("Social Posts", Some("pink"));
    assert_eq!(
        (
            finance.colorway.as_deref(),
            finance.icon.as_deref(),
            finance.bound_key.as_deref()
        ),
        (Some("orange"), Some("money"), Some("F"))
    );
    assert_eq!(fixer.colorway.as_deref(), Some("graphite"));
    assert_eq!(fixer.bound_key.as_deref(), Some("I"));
    assert_eq!(
        (
            social.colorway.as_deref(),
            social.icon.as_deref(),
            social.color.as_str()
        ),
        (Some("pink"), Some("megaphone"), "pink")
    );
    // Written back: a second read is the same.
    assert_eq!(store::get(&fixer.id).unwrap(), fixer);
    store::set_root_for_tests(None);
}
