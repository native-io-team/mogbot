//! # Tauri Commands
//!
//! This module re-exports all Tauri command handlers organized by category.

pub mod accounts;
pub mod agent_bridge;
pub mod agents;
pub mod ai;
pub mod analytics;
pub mod assets;
pub mod attached_libraries;
pub mod claude;
pub mod clipboard;
pub mod code;
pub mod color_picker;
pub mod companion;
pub mod companion_install;
pub mod conflicts;
pub mod css_rule_mutations;
pub mod custom_classes;
pub mod dictation;
pub mod edit;
pub mod edit_css;
pub mod edit_structure;
pub mod env;
pub mod external_projects;
pub mod folders;
pub mod git;
pub mod github;
pub mod health;
pub mod hosting;
pub mod i18n;
pub mod ide;
pub mod issue_reports;
pub mod mcp;
pub mod migration;
pub mod mobile;
pub mod monorepo;
pub mod plugins;
pub mod projects;
pub mod proxy;
pub mod pty;
pub mod pty_session;
pub mod publishing;
pub mod pull_requests;
pub mod remote_access;
pub mod settings;
pub mod setup;
pub mod shopify;
pub mod skills;
pub mod snapshots;
pub mod spotify;
pub mod static_server;
pub mod team;
pub mod templates;
pub mod window;
pub mod workflows;

// Re-export all commands for easy access in lib.rs
pub use accounts::*;
pub use ai::*;
pub use analytics::*;
pub use assets::*;
pub use attached_libraries::*;
pub use claude::*;
pub use clipboard::*;
pub use code::*;
pub use color_picker::*;
pub use conflicts::*;
pub use custom_classes::*;
pub use edit::*;
pub use env::*;
pub use external_projects::*;
pub use folders::*;
pub use git::*;
pub use github::*;
pub use health::*;
pub use i18n::*;
pub use ide::*;
pub use issue_reports::*;
pub use mcp::*;
pub use monorepo::*;
pub use plugins::*;
pub use projects::*;
pub use proxy::*;
pub use pty::*;
pub use pty_session::*;
pub use publishing::*;
pub use pull_requests::*;
pub use settings::*;
pub use setup::*;
pub use shopify::*;
pub use skills::*;
pub use snapshots::*;
pub use spotify::*;
pub use static_server::*;
pub use templates::*;
pub use window::*;
pub use workflows::*;

#[cfg(test)]
mod log_hygiene_tests {
    //! `#[tracing::instrument]` records every argument it isn't told to skip,
    //! at INFO, into the log file (and the log goes into bug reports). A
    //! command taking a credential, an agent's instructions, a note or a
    //! file's bytes must skip it.

    /// Argument names that carry something that must not reach a log.
    const SENSITIVE: &[&str] = &[
        "token",
        "secret",
        "secrets",
        "secret_id",
        "password",
        "pin",
        "value",
        "values",
        "input",
        "note",
        "notes",
        "instructions",
        "text",
        "body",
        "data",
        "file_data",
        "zip_data",
        "picks",
        "old_text",
        "new_text",
        "content",
        "prompt",
        "draft",
    ];

    #[test]
    fn commands_never_log_credentials_instructions_or_notes() {
        let re = regex::Regex::new(
            r"#\[tracing::instrument(\((?s:.*?)\))?\]\s*(?:#\[[^\]]*\]\s*)*pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(((?s:.*?))\)\s*(?:->|\{)",
        )
        .unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        for entry in walkdir::WalkDir::new(&root).into_iter().flatten() {
            if entry.path().extension().is_none_or(|e| e != "rs") {
                continue;
            }
            let src = std::fs::read_to_string(entry.path()).unwrap();
            for cap in re.captures_iter(&src) {
                let attr = cap.get(1).map_or("", |m| m.as_str());
                if attr.contains("skip_all") {
                    continue;
                }
                let skipped: Vec<&str> = regex::Regex::new(r"skip\(([^)]*)\)")
                    .unwrap()
                    .captures(attr)
                    .map(|c| {
                        c.get(1)
                            .unwrap()
                            .as_str()
                            .split(',')
                            .map(str::trim)
                            .collect()
                    })
                    .unwrap_or_default();
                for param in cap[3].split(',') {
                    let Some((name, ty)) = param.split_once(':') else {
                        continue;
                    };
                    let name = name.trim().trim_start_matches("mut ").trim();
                    // A number or a flag (a comment's pin number, a volume) says nothing.
                    let ty = ty.trim().trim_start_matches("Option<");
                    let scalar = ty.starts_with("bool")
                        || ["u", "i", "f"].iter().any(|p| {
                            ty.strip_prefix(p).is_some_and(|r| {
                                r.starts_with(|c: char| c.is_ascii_digit()) || r.starts_with("size")
                            })
                        });
                    if !scalar && SENSITIVE.contains(&name) && !skipped.contains(&name) {
                        offenders.push(format!(
                            "{}: {}({name})",
                            entry.path().strip_prefix(&root).unwrap().display(),
                            &cap[2]
                        ));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "skip these in #[tracing::instrument]: {offenders:#?}"
        );
    }
}
