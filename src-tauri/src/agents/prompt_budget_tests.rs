//! The app-owned system prompt (child of runner.rs), held to a budget so it
//! stays small and stable for prompt caching. Measured in characters (about
//! four to a token for this prose). Raising a budget is a decision: trim
//! something first, and note the new size in docs/agents.md, "Keeping
//! context healthy".
use super::*;

/// A plain agent on Claude Code: 12,054 characters when this was set
/// (3,827 tokens as Claude Code counted it); 12,697 with the agents' browser
/// in "Getting access", after trimming elsewhere.
const PLAIN_BUDGET: usize = 12_800;
/// The same agent on Codex (its sandbox section): 13,262.
const CODEX_BUDGET: usize = 13_400;
/// The Chief of Staff, with no team yet: 16,646.
const CHIEF_BUDGET: usize = 16_800;

fn agent(id: &str, name: &str, main: bool, engine: Engine) -> store::Agent {
    let mut a: store::Agent = serde_json::from_value(serde_json::json!({
        "id": id, "name": name, "role": "Keeps the books.", "shape": 0,
        "color": "red", "createdAt": 0
    }))
    .unwrap();
    a.is_main = main;
    a.engine = engine;
    a
}

fn prompt_of(a: &store::Agent) -> String {
    let home = tempfile::tempdir().unwrap();
    let layout = super::super::project::layout(a, home.path(), vec![]);
    let p = system_prompt_for(a, home.path(), &layout);
    // `DUMP_PROMPTS=<dir>` writes each one out, to count its tokens.
    if let Ok(dir) = std::env::var("DUMP_PROMPTS") {
        std::fs::write(format!("{dir}/{}.txt", a.id), &p).unwrap();
    }
    p
}

#[test]
fn the_app_owned_system_prompt_stays_within_its_budget() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let plain = prompt_of(&agent("p1", "Ledger", false, Engine::Claude));
    let codex = prompt_of(&agent("c1", "Ledger", false, Engine::Codex));
    let chief = prompt_of(&agent("m1", "Chief of Staff", true, Engine::Claude));
    store::set_root_for_tests(None);
    for (name, prompt, budget) in [
        ("plain", &plain, PLAIN_BUDGET),
        ("codex", &codex, CODEX_BUDGET),
        ("chief", &chief, CHIEF_BUDGET),
    ] {
        assert!(
            prompt.len() <= budget,
            "the {name} agent's app-owned prompt is {} characters, over its budget of {budget}",
            prompt.len()
        );
        // Every agent is told how its context is kept healthy.
        assert!(prompt.contains("tidied between turns"), "{name}");
        assert!(prompt.contains("in a file in your home"), "{name}");
        // Nothing in it changes from turn to turn (the cache would miss).
        assert!(!prompt.contains(&chrono::Local::now().format("%Y-%m-%d").to_string()));
    }
}

#[test]
fn a_bound_agent_is_told_the_same() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("CLAUDE.md"),
        "# Ledger\n\n## Memory\n\n- Q3 closes.",
    )
    .unwrap();
    let mut a = agent("b1", "Ledger", false, Engine::Claude);
    a.project = Some("/ext/site".into());
    let layout = super::super::project::layout(&a, home.path(), vec!["/ext/site".into()]);
    let prompt = system_prompt_for(&a, home.path(), &layout);
    assert!(prompt.contains("tidied between turns"));
    assert!(prompt.contains("- Q3 closes."));
}
