//! Keep our agents off Ship Studio's preview bridge.
//!
//! Both apps register a preview MCP server in the user's agent configs —
//! ours as [`crate::brand::preview_mcp_name`], Ship Studio's as
//! `shipstudio-preview`. Codex, Opencode and Cursor registrations are global
//! and Claude Code's local-scope entries persist per project, so an agent
//! started by either app sees *both*: one of our agents could drive the preview
//! Ship Studio has focused (possibly another project), or wait on Ship
//! Studio's server when Ship Studio is closed.
//!
//! The fix is per spawn, never per config: we leave Ship Studio's registration
//! exactly where it is (it is theirs, and Ship Studio needs it) and tell each
//! agent we start to ignore it.
//!
//! - **Claude Code:** `--disallowedTools=mcp__shipstudio-preview`. A server-
//!   level rule denies every tool on that server. Verified on 2.1.318 against
//!   a stand-in `shipstudio-preview` server: its tool is listed without the
//!   flag and absent with it, and the flag is harmless when no such server
//!   exists. The `=` form matters: the option is variadic, and a following
//!   bare argument (the opening prompt) would otherwise be read as a tool name.
//! - **Codex:** `-c mcp_servers.shipstudio-preview.enabled=false`, but only
//!   when that server is actually configured. Verified on codex-cli 0.166.0:
//!   with the server registered, `codex mcp list` shows it `disabled`; with it
//!   absent, the override creates a half-defined server and Codex refuses to
//!   start ("invalid transport in `mcp_servers.…`").
//! - **Opencode / Cursor:** no per-launch switch exists; their agents still see
//!   both servers.
//!
//! The same goes for our own registration under the app's previous name
//! (`<previous slug>-preview`, from `brand.json` `previous`): it names a
//! bridge that no longer answers to that name, so our agents ignore it too.

use std::path::{Path, PathBuf};

/// Ship Studio's preview server name in agent configs. Shared namespace, not
/// ours: we only ever read it, never add or remove it.
pub const SHIP_STUDIO_PREVIEW_MCP: &str = "shipstudio-preview";

/// Preview servers in shared agent configs that our agents must ignore:
/// Ship Studio's, and ours under the app's previous name.
pub fn foreign_servers() -> Vec<String> {
    let mut out = vec![SHIP_STUDIO_PREVIEW_MCP.to_string()];
    if let Some(slug) = crate::brand::previous::SLUG {
        let old = format!("{slug}-preview");
        if old != crate::brand::preview_mcp_name() && old != SHIP_STUDIO_PREVIEW_MCP {
            out.push(old);
        }
    }
    out
}

/// The Claude Code flag that hides those servers' tools (one flag, the
/// names comma-separated, which Claude Code accepts).
pub fn claude_flag() -> String {
    let tools: Vec<String> = foreign_servers()
        .iter()
        .map(|name| format!("mcp__{name}"))
        .collect();
    format!("--disallowedTools={}", tools.join(","))
}

/// The Codex `-c` values that disable each of [`foreign_servers`], for those
/// the Codex config at `codex_home` (or the project's `.codex/config.toml`)
/// actually declares.
pub fn codex_overrides(codex_home: Option<&Path>, project: Option<&Path>) -> Vec<String> {
    let home = codex_home
        .map(Path::to_path_buf)
        .or_else(crate::agents::codex::codex_home);
    let texts: Vec<String> = [
        home.map(|h| h.join("config.toml")),
        project.map(|p| p.join(".codex").join("config.toml")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|path: PathBuf| std::fs::read_to_string(path).ok())
    .collect();
    foreign_servers()
        .into_iter()
        .filter(|name| texts.iter().any(|t| declares_server(t, name)))
        .map(|name| format!("mcp_servers.{name}.enabled=false"))
        .collect()
}

/// Arguments to put in front of an agent CLI's own, by our agent id.
pub fn spawn_args(
    agent_id: &str,
    codex_home: Option<&Path>,
    project: Option<&Path>,
) -> Vec<String> {
    // Never hide our own server, in the unlikely case the brand slug is
    // `shipstudio`.
    if crate::brand::preview_mcp_name() == SHIP_STUDIO_PREVIEW_MCP {
        return Vec::new();
    }
    match agent_id {
        "claude-code" => vec![claude_flag()],
        "codex" => codex_overrides(codex_home, project)
            .into_iter()
            .flat_map(|value| ["-c".to_string(), value])
            .collect(),
        _ => Vec::new(),
    }
}

/// Splice `extra` into a PTY argv: after a Windows `cmd.exe /C <binary>`
/// prefix when there is one, else at the front. Flags first keeps them ahead
/// of the opening prompt, which every CLI takes as the trailing positional.
pub fn insert_front(args: &mut Vec<String>, extra: Vec<String>) {
    if extra.is_empty() {
        return;
    }
    let at = if args.first().is_some_and(|a| a.eq_ignore_ascii_case("/C")) && args.len() >= 2 {
        2
    } else {
        0
    };
    args.splice(at..at, extra);
}

/// Whether a Codex `config.toml` declares `[mcp_servers.<name>]`. A plain
/// line scan rather than a TOML parse: a false negative only leaves the
/// server visible (the old behaviour), so the match is strict to keep false
/// positives — which would stop Codex starting — out.
fn declares_server(toml: &str, name: &str) -> bool {
    let bare = format!("[mcp_servers.{name}]");
    let quoted = format!("[mcp_servers.\"{name}\"]");
    toml.lines().any(|line| {
        let line = line.split('#').next().unwrap_or("").trim();
        let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        compact == bare || compact == quoted
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_table_codex_mcp_add_writes() {
        let toml = "model = \"o3\"\n\n[mcp_servers.shipstudio-preview]\nurl = \"http://127.0.0.1:1/mcp/x/active\"\n";
        assert!(declares_server(toml, SHIP_STUDIO_PREVIEW_MCP));
        assert!(declares_server(
            "[ mcp_servers.\"shipstudio-preview\" ] # theirs",
            SHIP_STUDIO_PREVIEW_MCP
        ));
    }

    #[test]
    fn ignores_lookalikes_and_comments() {
        for toml in [
            "[mcp_servers.someone-preview]\nurl = \"x\"",
            "# [mcp_servers.shipstudio-preview]",
            "[mcp_servers.shipstudio-preview.env]\nA = \"b\"",
            "[mcp_servers.shipstudio-preview-old]",
        ] {
            assert!(!declares_server(toml, SHIP_STUDIO_PREVIEW_MCP), "{toml}");
        }
    }

    #[test]
    fn codex_gets_the_override_only_when_the_server_exists() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        assert!(spawn_args("codex", Some(home.path()), Some(project.path())).is_empty());

        std::fs::write(
            home.path().join("config.toml"),
            "[mcp_servers.shipstudio-preview]\nurl = \"http://127.0.0.1:1\"\n",
        )
        .unwrap();
        assert_eq!(
            spawn_args("codex", Some(home.path()), Some(project.path())),
            vec![
                "-c".to_string(),
                "mcp_servers.shipstudio-preview.enabled=false".to_string()
            ]
        );
    }

    #[test]
    fn our_registration_under_the_previous_name_is_ignored_too() {
        let Some(slug) = crate::brand::previous::SLUG else {
            return;
        };
        let old = format!("{slug}-preview");
        assert!(foreign_servers().contains(&old));
        assert!(!foreign_servers().contains(&crate::brand::preview_mcp_name()));
        assert!(claude_flag().contains(&format!(",mcp__{old}")));

        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("config.toml"),
            format!("[mcp_servers.{old}]\nurl = \"http://127.0.0.1:1\"\n"),
        )
        .unwrap();
        assert_eq!(
            codex_overrides(Some(home.path()), None),
            vec![format!("mcp_servers.{old}.enabled=false")]
        );
    }

    #[test]
    fn a_project_level_codex_config_counts() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join(".codex")).unwrap();
        std::fs::write(
            project.path().join(".codex/config.toml"),
            "[mcp_servers.shipstudio-preview]\nurl = \"http://127.0.0.1:1\"\n",
        )
        .unwrap();
        assert_eq!(
            spawn_args("codex", Some(home.path()), Some(project.path())).len(),
            2
        );
    }

    #[test]
    fn claude_always_gets_the_deny_in_equals_form() {
        let args = spawn_args("claude-code", None, None);
        assert_eq!(args, vec![claude_flag()]);
        assert!(claude_flag().starts_with("--disallowedTools=mcp__shipstudio-preview"));
        assert!(!claude_flag().contains(' '), "one argument, no spaces");
        assert!(spawn_args("opencode", None, None).is_empty());
        assert!(spawn_args("terminal", None, None).is_empty());
    }

    #[test]
    fn inserted_ahead_of_the_prompt_and_after_a_cmd_wrapper() {
        let mut args = vec![
            "--session-id".to_string(),
            "s".to_string(),
            "hi".to_string(),
        ];
        insert_front(&mut args, vec!["--x=1".to_string()]);
        assert_eq!(args, ["--x=1", "--session-id", "s", "hi"]);

        let mut win = vec!["/C".to_string(), "claude".to_string(), "hi".to_string()];
        insert_front(&mut win, vec!["--x=1".to_string()]);
        assert_eq!(win, ["/C", "claude", "--x=1", "hi"]);
    }
}
