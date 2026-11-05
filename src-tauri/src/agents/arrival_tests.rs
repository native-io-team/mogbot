use super::*;
use crate::agents::{import, review, store};

const GROK: &str = "Grok Bot";

fn nowhere(_: &str) -> bool {
    false
}

/// An imported agent's instructions, in the shape Grok Bot sends them.
const GARDEN: &str = "Project lead for the garden redesign. Owns the research at /workspace/garden-redesign/ (plants, suppliers, budget). Report only to Chief of Staff.";

#[test]
fn foreign_paths_are_found_as_written_and_nothing_else() {
    let text = "Reports: /workspace/site-qa/<site>/report.md; checklist: `/workspace/site-qa/checklist.md`.\n\
        Also /workspace/notes-deb: and (/workspace/kitchen-plan/, /mnt/data/a.csv).\n\
        Not these: ~/workspace/x, src/workspace/y, /workspaces/z, https://x.com/workspace/q, /Users/me/workspace.";
    assert_eq!(
        paths_with(text, &nowhere),
        [
            "/workspace/site-qa/<site>/report.md",
            "/workspace/site-qa/checklist.md",
            "/workspace/notes-deb",
            "/workspace/kitchen-plan/",
            "/mnt/data/a.csv",
        ]
    );
    // One that does exist here is left alone.
    assert!(paths_with("see /workspace/real/", &|p: &str| p == "/workspace/real/").is_empty());
}

#[test]
fn the_first_mention_of_each_path_is_marked_and_no_word_is_lost() {
    let text = "Owns /workspace/garden-redesign/ (listings). Keep /workspace/garden-redesign/ tidy; see `/workspace/x.md`.";
    let (out, paths) = annotate_with(text, GROK, &nowhere);
    assert_eq!(
        out,
        "Owns /workspace/garden-redesign/ (from Grok Bot — not on this Mac) (listings). Keep /workspace/garden-redesign/ tidy; see `/workspace/x.md` (from Grok Bot — not on this Mac)."
    );
    assert_eq!(paths, ["/workspace/garden-redesign/", "/workspace/x.md"]);
    // Every word the user wrote is still there, in order.
    assert_eq!(out.replace(" (from Grok Bot — not on this Mac)", ""), text);
    // Twice is the same as once.
    let (again, _) = annotate_with(&out, GROK, &nowhere);
    assert_eq!(again, out);
    // Nothing foreign: untouched.
    assert_eq!(annotate_with("Be brief.", GROK, &nowhere).0, "Be brief.");
}

#[test]
fn grok_and_remote_access_tools_are_translated_by_whole_word() {
    let notes = tools("Use x_keyword_search, then prepare_push/confirm_push. message_agent the Chief. Not my_web_search_tool.");
    let names: Vec<&str> = notes.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["x_keyword_search", "prepare_push", "confirm_push"]);
    assert_eq!(notes[0].here, None);
    assert!(notes[2].here.as_deref().unwrap().starts_with("push"));
}

#[test]
fn a_proposal_is_marked_everywhere_and_says_so_for_the_card() {
    let mut p = review::Proposal {
        key: "p1".into(),
        name: "Site QA".into(),
        instructions: "Write /workspace/site-qa/<site>/report.md. Use browse_page.".into(),
        memory: "- Checklist at /workspace/site-qa/checklist.md".into(),
        apps: vec![review::ProposedApp {
            name: "Workspace files (/workspace/site-qa/)".into(),
            purpose: "Reports".into(),
        }],
        ..Default::default()
    };
    annotate_proposal_with(&mut p, GROK, &nowhere);
    assert!(p
        .instructions
        .contains("report.md (from Grok Bot — not on this Mac)."));
    assert!(p
        .memory
        .contains("checklist.md (from Grok Bot — not on this Mac)"));
    assert!(p.apps[0]
        .name
        .contains("/workspace/site-qa/ (from Grok Bot — not on this Mac)"));
    assert_eq!(
        p.foreign_paths,
        [
            "/workspace/site-qa/<site>/report.md",
            "/workspace/site-qa/checklist.md",
            "/workspace/site-qa/",
        ]
    );
    assert_eq!(p.foreign_tools.len(), 1);
    assert_eq!(p.foreign_tools[0].name, "browse_page");
    let before = p.clone();
    annotate_proposal_with(&mut p, GROK, &nowhere);
    assert_eq!(p, before, "marking twice changes nothing");
}

#[test]
fn the_preamble_names_home_paths_imports_projects_logins_and_tools() {
    let paths = vec!["/workspace/garden-redesign/".to_string()];
    let tools = tools("confirm_push and x_search");
    let text = preamble(&Arrival {
        source: GROK,
        home: Path::new("/Users/j/Library/Application Support/Dashbot/agents/abc"),
        imported: Some("imported/grok-bot/".into()),
        paths: &paths,
        tools: &tools,
    });
    assert!(text.starts_with(HEADING));
    for want in [
        "on Claude Code or Codex",
        "not in Grok Bot's sandbox",
        "`/Users/j/Library/Application Support/Dashbot/agents/abc`",
        "/workspace/garden-redesign/ is `garden-redesign/` there",
        "none of them on this Mac: `/workspace/garden-redesign/`",
        "`imported/grok-bot/`",
        "project_list",
        "request_login",
        "Never ask for a password",
        "confirm_push → push",
        "x_search: not available here",
    ] {
        assert!(text.contains(want), "{want:?} missing from:\n{text}");
    }
    let bare = preamble(&Arrival {
        source: GROK,
        home: Path::new("/h"),
        imported: None,
        paths: &[],
        tools: &[],
    });
    assert!(bare.contains("No files or past conversations came over from Grok Bot."));
    assert!(!bare.contains("none of them on this Mac"));
    assert!(!bare.contains("Tools your instructions"));
}

/* ------------------------------------------------------ the file, for real */

fn root() -> (std::sync::MutexGuard<'static, ()>, tempfile::TempDir) {
    let serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    (serial, dir)
}

fn claude_md(id: &str) -> String {
    std::fs::read_to_string(store::agent_home(id).unwrap().join("CLAUDE.md")).unwrap()
}

#[test]
fn an_import_marks_paths_and_writes_the_preamble_outside_the_instructions() {
    let (_serial, _dir) = root();
    let summary = import::import(
        vec![import::ImportedAgent {
            name: "Garden Redesign".into(),
            role: "Canada research".into(),
            instructions: GARDEN.into(),
            memory: "- Research lives at /workspace/garden-redesign/".into(),
            is_main: false,
            color: None,
            routines: vec![],
        }],
        GROK,
    )
    .unwrap();
    assert_eq!(summary.created, ["Garden Redesign"]);
    let agent = store::find("Garden Redesign").unwrap().unwrap();
    let md = claude_md(&agent.id);
    let instructions = store::read_instructions(&agent.id).unwrap();
    store::set_root_for_tests(None);
    // The user's instructions: their words, the path marked, no preamble.
    assert_eq!(
        instructions,
        GARDEN.replace(
            "/workspace/garden-redesign/",
            "/workspace/garden-redesign/ (from Grok Bot — not on this Mac)"
        )
    );
    assert!(!instructions.contains(HEADING));
    // The preamble sits above them, and memory below is as imported.
    let at = md.find(HEADING).unwrap();
    assert!(at < md.find("## Instructions").unwrap());
    assert!(md.contains("### Imported from Grok Bot"));
    assert!(md.contains("none of them on this Mac: `/workspace/garden-redesign/`"));
}

#[test]
fn editing_or_renaming_an_imported_agent_keeps_its_preamble() {
    let (_serial, _dir) = root();
    let agent = store::create(store::NewAgent {
        name: "Finance".into(),
        role: "Books".into(),
        instructions: "Keep /workspace/finance/status.md".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    import::add_memory(&agent.id, "- Ledger in /workspace/finance/", GROK).unwrap();
    arrive(&agent.id, GROK).unwrap();
    let preamble = section_text(&claude_md(&agent.id)).unwrap();
    store::write_instructions(&store::agent_home(&agent.id).unwrap(), &agent, "Be brief.").unwrap();
    let md = claude_md(&agent.id);
    let instructions = store::read_instructions(&agent.id).unwrap();
    store::set_root_for_tests(None);
    assert_eq!(instructions, "Be brief.");
    assert_eq!(section_text(&md).unwrap(), preamble);
    assert!(md.contains("- Ledger in /workspace/finance/"));
}

/// The owner's agents as they are today: imported before the preamble, with
/// the user's (and Grok's) text holding sandbox paths.
fn already_imported(name: &str, instructions: &str, memory: &str) -> (store::Agent, String) {
    let agent = store::create(store::NewAgent {
        name: name.into(),
        role: "Research".into(),
        instructions: instructions.into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    import::add_memory(&agent.id, memory, GROK).unwrap();
    let before = claude_md(&agent.id);
    (agent, before)
}

#[test]
fn an_agent_imported_before_gets_the_preamble_once_and_nothing_else_changes() {
    let (_serial, _dir) = root();
    let memory = "- Research lives at /workspace/garden-redesign/\n- Never contact realtors";
    let (agent, before) = already_imported("Garden Redesign", GARDEN, memory);
    assert!(upgrade(&agent).unwrap());
    let after = claude_md(&agent.id);
    let instructions = store::read_instructions(&agent.id).unwrap();
    // Once: a second launch changes nothing.
    assert!(!upgrade(&agent).unwrap());
    assert_eq!(upgrade_all(), 0);
    let again = claude_md(&agent.id);
    store::set_root_for_tests(None);
    // The user's instructions are byte for byte as they were (no marks added
    // to them: they're the user's), and so is the memory.
    assert_eq!(instructions, GARDEN);
    let (s, e) = section(&after).unwrap();
    assert_eq!(format!("{}{}", &after[..s], &after[e..]), before);
    assert!(after[s..e].contains("`/workspace/garden-redesign/`"));
    assert_eq!(again, after);
}

#[test]
fn the_upgrade_leaves_the_chief_ship_studio_agents_and_our_own_alone() {
    let (_serial, _dir) = root();
    let chief = crate::agents::ensure_main().unwrap();
    import::add_memory(&chief.id, "- Lives in Lisbon", GROK).unwrap();
    let from_ship = store::create(store::NewAgent {
        name: "Ops".into(),
        role: String::new(),
        instructions: "Be brief.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    import::add_memory(
        &from_ship.id,
        "- Tea",
        crate::agents::other_app::OTHER_APP_NAME,
    )
    .unwrap();
    let ours = store::create(store::NewAgent {
        name: "Mine".into(),
        role: String::new(),
        instructions: "Mentions ### Imported from Grok Bot in its instructions.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let before: Vec<String> = [&chief.id, &from_ship.id, &ours.id]
        .iter()
        .map(|id| claude_md(id))
        .collect();
    let n = upgrade_all();
    let after: Vec<String> = [&chief.id, &from_ship.id, &ours.id]
        .iter()
        .map(|id| claude_md(id))
        .collect();
    store::set_root_for_tests(None);
    assert_eq!(n, 0);
    assert_eq!(after, before);
}

#[test]
fn an_agent_with_a_section_of_its_own_is_never_overwritten_by_the_upgrade() {
    let (_serial, _dir) = root();
    let (agent, _) = already_imported("Car", "Find a shop.", "- Has a Golf");
    let path = store::agent_home(&agent.id).unwrap().join("CLAUDE.md");
    let raw = claude_md(&agent.id);
    let edited = raw.replacen(
        "## Instructions",
        &format!("{HEADING}\n\nThe user rewrote this.\n\n## Instructions"),
        1,
    );
    std::fs::write(&path, &edited).unwrap();
    let wrote = upgrade(&agent).unwrap();
    let now = claude_md(&agent.id);
    store::set_root_for_tests(None);
    assert!(!wrote);
    assert_eq!(now, edited);
}

#[test]
fn the_imported_folder_is_named_only_when_it_is_there() {
    let (_serial, _dir) = root();
    let (agent, _) = already_imported("Italy Move", "Plan the move.", "- Rome");
    let home = store::agent_home(&agent.id).unwrap();
    std::fs::create_dir_all(home.join("imported/grok-bot")).unwrap();
    upgrade(&agent).unwrap();
    let md = claude_md(&agent.id);
    store::set_root_for_tests(None);
    assert!(md.contains("What came over from Grok Bot is in `imported/grok-bot/`"));
}

#[test]
fn importing_from_the_review_card_writes_what_the_card_showed() {
    let (_serial, _dir) = root();
    let chief = crate::agents::ensure_main().unwrap();
    let p = review::proposal(
        "p1".into(),
        &serde_json::json!({
            "name": "Site QA",
            "instructions": "Write /workspace/site-qa/checklist.md and use confirm_push.",
            "memory": "- Reports in /workspace/site-qa/",
        }),
        &chief.name,
    )
    .unwrap();
    let card = review::ConnectorCard {
        kind: review::CardKind::Review,
        talk_id: "t".into(),
        source: GROK.into(),
        review: Some(review::Review {
            proposals: vec![p],
            ..Default::default()
        }),
        playback: None,
    };
    // What the card shows.
    let shown = review::with_arrival(card.review.clone().unwrap(), GROK);
    let p = &shown.proposals[0];
    assert_eq!(
        p.foreign_paths,
        ["/workspace/site-qa/checklist.md", "/workspace/site-qa/"]
    );
    assert_eq!(p.foreign_tools[0].name, "confirm_push");
    let picks = review::Picks {
        agents: vec![review::Pick {
            key: "p1".into(),
            ..Default::default()
        }],
        chief_notes: false,
    };
    review::apply(None, &chief, &card, &picks).unwrap();
    let agent = store::find("Site QA").unwrap().unwrap();
    let instructions = store::read_instructions(&agent.id).unwrap();
    let md = claude_md(&agent.id);
    store::set_root_for_tests(None);
    assert_eq!(instructions, p.instructions);
    assert!(md.contains("- Reports in /workspace/site-qa/ (from Grok Bot — not on this Mac)"));
    let (s, e) = section(&md).unwrap();
    assert!(s < md.find("## Instructions").unwrap());
    assert!(md[s..e].contains("confirm_push → push"));
    assert!(md[s..e].contains("No files or past conversations came over from Grok Bot."));
}
