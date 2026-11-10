//! `real-chief`: one real Claude Code turn of the Chief of Staff, to see what
//! its prompt and tools make it do with a first message. Needs
//! `AGENTS_REAL_CLAUDE`; the message is `AGENTS_REAL_PROMPT`. Prints the chat,
//! every tool call and the cards it raised; asserts nothing about wording.
//! The app's state stays in the throwaway HOME, like `real-blocks`.

use super::*;

pub(super) async fn real_chief(h: &H) -> Check {
    ensure(
        std::env::var("AGENTS_REAL_CLAUDE").is_ok(),
        "set AGENTS_REAL_CLAUDE to the claude binary",
    )?;
    let chief = h.chief();
    let ask = std::env::var("AGENTS_REAL_PROMPT")
        .unwrap_or_else(|_| "I want a daily summary of AI news at 8am".into());
    h.send(&chief.id, &ask).await?;
    // Until the turn ends, or it stops on a card nobody here will answer.
    let waiting = |id: &str| log(id).iter().any(|m| m.approval.is_some());
    let _ = h
        .until(
            "the turn to end or a card",
            Duration::from_secs(300),
            || !runner::in_turn(&chief.id) || waiting(&chief.id),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let stopped_on_card = runner::in_turn(&chief.id);
    for m in log(&chief.id) {
        println!("--- {:?}: {}", m.kind, m.text);
        if let Some(a) = &m.approval {
            println!("    card: {}", serde_json::to_string(a).unwrap_or_default());
        }
        if let Some(b) = &m.blocks {
            println!(
                "    blocks: {}",
                serde_json::to_string(b).unwrap_or_default()
            );
        }
    }
    for a in store::list().unwrap_or_default() {
        if a.id != chief.id {
            println!("agent made: {} ({})", a.name, a.role);
        }
    }
    let projects = PathBuf::from(std::env::var("AGENTS_FAKE_REAL_HOME").unwrap_or_default())
        .join(".claude/projects");
    let tag = format!("agents-fake-{}", std::process::id());
    let ours: Vec<PathBuf> = std::fs::read_dir(&projects)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().contains(&tag))
        })
        .collect();
    // Claude Code writes some entries twice: each tool call once.
    let mut seen = std::collections::HashSet::new();
    for file in ours.iter().flat_map(|d| walk(d)) {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            for part in v["message"]["content"].as_array().into_iter().flatten() {
                let id = part["id"].as_str().or(part["tool_use_id"].as_str());
                if id.is_some_and(|id| !seen.insert(format!("{}{id}", part["type"]))) {
                    continue;
                }
                if part["type"] == "tool_use" {
                    let input = part["input"].to_string();
                    let cut: String = input.chars().take(600).collect();
                    println!("tool: {} {cut}", part["name"].as_str().unwrap_or(""));
                }
                if part["type"] == "tool_result" {
                    let out = part["content"].to_string();
                    let cut: String = out.chars().take(400).collect();
                    println!("  -> {cut}");
                }
            }
        }
    }
    for d in &ours {
        let _ = std::fs::remove_dir_all(d);
    }
    if stopped_on_card {
        println!("(stopped on a card)");
        runner::stop(&h.app, &chief.id);
    }
    Ok(())
}
