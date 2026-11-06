//! Agents never hear the app called "Ship Studio".
//!
//! An agent took the app's name from what it was handed (its tool ids were
//! `mcp__shipstudio_agents__*`) and told the user "No Ship Studio sessions
//! are open". The rule (CLAUDE.md, "Brand and identity"): the name comes only
//! from brand.json, and copy says "the app" or "this Mac". The shared-compat
//! identifiers stay (`~/ShipStudio`, `.shipstudio/`, `shipstudio-preview`,
//! `.shipstudio-team/`, the plugin ABI): they are folder and protocol names,
//! never the app's name in a sentence.
//!
//! What the user wrote (an agent's instructions and memory) is never scanned
//! or changed: an imported agent may well work on a product called Ship Studio.

use std::path::{Path, PathBuf};

use super::store;

fn says_old_name(text: &str) -> bool {
    text.to_lowercase().contains("ship studio")
}

/// Lines that may say it: the other app's name where the user imports from
/// it, the skills' safety swap, and log lines (never shown to an agent).
fn allowed(line: &str) -> bool {
    line.contains("OTHER_APP_NAME: &str")
        || line.contains(".replace(\"Ship Studio\"")
        || ["warn!(", "debug!(", "info!(", "error!("]
            .iter()
            .any(|m| line.contains(m))
}

/// The code half of a source file: up to its `#[cfg(test)] mod …`.
fn code_lines(source: &str) -> Vec<(usize, &str)> {
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed == "#[cfg(test)]"
            && lines
                .get(i + 1)
                .is_some_and(|next| next.trim_start().starts_with("mod "))
        {
            break;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        out.push((i + 1, *line));
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs")
            && !path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with("_tests.rs"))
            && path.file_name().is_none_or(|n| n != "tests.rs")
        {
            out.push(path);
        }
    }
}

/// Every string the app writes for an agent lives in these files: the
/// agents engine (prompts, tool descriptions, card and refusal text), the
/// preview bridge, the bundled skills, and the agent commands.
#[test]
fn no_app_owned_agent_text_calls_the_app_ship_studio() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src.join("agents"), &mut files);
    for extra in [
        "agent_bridge.rs",
        "commands/agents.rs",
        "commands/skills/bundled.rs",
        "commands/workflows/skill.rs",
        "commands/team/skill.rs",
    ] {
        files.push(src.join(extra));
    }
    assert!(files.len() > 50, "the agents folder was found");
    let mut found = Vec::new();
    for file in &files {
        let source = std::fs::read_to_string(file).unwrap();
        let lines = code_lines(&source);
        for (i, (n, line)) in lines.iter().enumerate() {
            // A string continued on the next line (`Ship \` / `Studio`).
            let next = lines.get(i + 1).map_or("", |(_, next)| *next);
            let joined = format!(
                "{} {}",
                line.trim_end().trim_end_matches('\\').trim_end(),
                next.trim_start()
            );
            let wrapped = says_old_name(&joined) && !says_old_name(next);
            if (says_old_name(line) || wrapped) && !allowed(line) {
                found.push(format!("{}:{n}: {}", file.display(), line.trim()));
            }
        }
    }
    let templates = std::fs::read_to_string(src.join("agents/templates.json")).unwrap();
    if says_old_name(&templates) {
        found.push("agents/templates.json".into());
    }
    assert!(found.is_empty(), "say \"the app\":\n{}", found.join("\n"));
}

/// What a turn is actually handed, built the way a turn builds it.
#[test]
fn what_an_agent_is_served_never_names_ship_studio() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));

    // Its tool ids: `mcp__<key>__<tool>`.
    assert!(!super::prompts::SERVER_KEY.to_lowercase().contains("ship"));
    assert!(!super::prompts::approval_tool_id().contains("shipstudio"));

    let mut texts: Vec<String> = Vec::new();
    for main in [true, false] {
        let agent: store::Agent = serde_json::from_value(serde_json::json!({
            "id": format!("brand-{main}"), "name": "Ops", "shape": 0,
            "color": "red", "createdAt": 0, "isMain": main
        }))
        .unwrap();
        texts.push(super::prompts::system_prompt(&agent, None));
        texts.push(super::policy::prompt_section(
            &super::policy::effective(&agent),
            &agent,
        ));
        let tools = super::mcp::tools_list_for_tests(&agent);
        for tool in tools["tools"].as_array().unwrap() {
            texts.push(tool.to_string());
        }
    }
    texts.push(super::mcp::initialize_result(None).to_string());
    texts.push(super::prompts::CHIEF_INSTRUCTIONS.into());
    texts.push(super::prompts::CHIEF_GREETING.into());
    texts.push(super::admin::PROMPT_SECTION.into());
    use super::independence::{prompt_section, Level};
    for level in [Level::Often, Level::Judgement, Level::GoHard] {
        texts.push(prompt_section(level));
    }
    // The bundled skills, as written and as installed.
    for skill in crate::commands::skills::bundled::BUNDLED_SKILLS {
        let body = (skill.body)();
        texts.push(crate::commands::skills::bundled::branded_body(&body));
        texts.push(body);
    }
    for text in &texts {
        assert!(!says_old_name(text), "names Ship Studio: {text}");
    }
    store::set_root_for_tests(None);
}
