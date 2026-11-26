use super::*;
use std::path::Path;

#[test]
fn each_project_tab_has_its_own_secret_and_keeps_it() {
    let a = for_project_tab("pty-a", Some(Path::new("/Users/x/ShipStudio/shop")));
    let b = for_project_tab("pty-b", Some(Path::new("/Users/x/ShipStudio/shop")));
    assert_ne!(a, b, "own token per tab");
    assert_eq!(a.len(), 64);
    assert_eq!(
        for_project_tab("pty-a", None),
        a,
        "a respawned tab keeps its tabs"
    );
    let who = caller(&a).unwrap();
    assert_eq!(who.kind, Kind::ProjectTab);
    assert_eq!(who.label, "shop", "its tab group is named for the project");
    assert_ne!(who.id, caller(&b).unwrap().id);
    assert!(who.id.starts_with("session-"));
    assert!(!who.id.contains("shop"), "the id names no path");
}

#[test]
fn the_terminal_has_one_secret_per_run() {
    let t = terminal_secret();
    assert_eq!(terminal_secret(), t);
    let who = caller(&t).unwrap();
    assert_eq!(who.id, TERMINAL_ID);
    assert_eq!(who.label, "Terminal");
    assert_eq!(who.kind, Kind::Terminal);
}

#[test]
fn an_unknown_or_malformed_secret_is_nobody() {
    assert!(caller("").is_none());
    assert!(caller("short").is_none());
    assert!(caller(&"a".repeat(64)).is_none());
}

#[test]
fn a_session_never_passes_for_a_stored_agent() {
    let s = Session {
        id: tab_id("pty-x"),
        label: "shop".into(),
        kind: Kind::ProjectTab,
    };
    let a = agent_of(&s);
    assert_eq!(a.id, s.id);
    assert_eq!(a.name, "shop");
    assert!(!a.is_main);
    assert!(!a.reach.browser_off);
    assert!(crate::agents::store::get(&a.id).is_err());
}

#[test]
fn claude_gets_a_config_file_and_codex_an_env_var_never_the_secret_in_argv() {
    let url = "http://127.0.0.1:4000/mcp/user-chrome";
    let secret = "f".repeat(64);
    let c = spawn_for("claude-code", url, &secret, Some("/tmp/mcp-1.json"));
    assert_eq!(c.args, vec!["--mcp-config", "/tmp/mcp-1.json"]);
    assert_eq!(c.env, vec![(TOKEN_ENV.to_string(), secret.clone())]);
    let x = spawn_for("codex", url, &secret, None);
    assert_eq!(
        x.args,
        vec![
            "-c",
            "mcp_servers.user_chrome.url=\"http://127.0.0.1:4000/mcp/user-chrome\"",
            "-c",
            "mcp_servers.user_chrome.bearer_token_env_var=\"USER_CHROME_MCP_TOKEN\"",
        ]
    );
    for s in [&c, &x] {
        assert!(s.args.iter().all(|a| !a.contains(&secret)));
    }
    // A shell tab: only the environment, for a launcher started inside it.
    let sh = spawn_for("terminal", url, &secret, None);
    assert!(sh.args.is_empty());
    assert_eq!(sh.env.len(), 1);
    // The config names the one server with the secret as a header.
    let cfg: serde_json::Value = serde_json::from_str(&claude_config(url, &secret)).unwrap();
    let srv = &cfg["mcpServers"]["user_chrome"];
    assert_eq!(srv["type"], "http");
    assert_eq!(srv["url"], url);
    assert_eq!(srv["headers"]["Authorization"], format!("Bearer {secret}"));
}

#[test]
fn a_debug_build_never_publishes_the_installed_apps_endpoint() {
    let support = Path::new("/Users/x/Library/Application Support/App");
    assert_eq!(
        endpoint_path_for(support, false),
        support.join("user-chrome-mcp.json")
    );
    assert_ne!(
        endpoint_path_for(support, true),
        endpoint_path_for(support, false)
    );
    assert_ne!(
        endpoint_path(),
        crate::brand::app_support_dir().join("user-chrome-mcp.json"),
        "the tests are a debug build"
    );
}

#[test]
fn the_endpoint_is_private_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("e.json");
    let e = Endpoint {
        port: 4321,
        token: "a".repeat(64),
    };
    write_endpoint_at(&p, &e).unwrap();
    assert_eq!(read_endpoint_at(&p), Some(e.clone()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&p).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // Readable by others: not the app's.
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_endpoint_at(&p), None);
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    // Rewritten in place (a new run).
    let next = Endpoint {
        port: 5000,
        token: "b".repeat(64),
    };
    write_endpoint_at(&p, &next).unwrap();
    assert_eq!(read_endpoint_at(&p), Some(next));
    assert_eq!(read_endpoint_at(&dir.path().join("missing.json")), None);
    std::fs::write(&p, "{\"port\":0,\"token\":\"x\"}").unwrap();
    assert_eq!(read_endpoint_at(&p), None, "malformed");
}

#[test]
fn the_register_command_names_this_binary_and_the_subcommand() {
    assert_eq!(
        register_command(Path::new("/Applications/Mogbot.app/Contents/MacOS/mogbot")),
        "claude mcp add --scope user user_chrome -- /Applications/Mogbot.app/Contents/MacOS/mogbot mcp user-chrome"
    );
    assert_eq!(
        register_command(Path::new("/Users/x/My Apps/app")),
        "claude mcp add --scope user user_chrome -- '/Users/x/My Apps/app' mcp user-chrome"
    );
}

#[test]
fn the_config_flag_never_swallows_the_opening_prompt() {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let extra = || v(&["--mcp-config", "/c.json"]);
    // Before the first flag, so the list ends at it.
    let mut a = v(&["--disallowedTools=x", "--session-id", "s", "hello"]);
    place(&mut a, Some("claude-code"), extra());
    assert_eq!(
        a,
        v(&[
            "--mcp-config",
            "/c.json",
            "--disallowedTools=x",
            "--session-id",
            "s",
            "hello"
        ])
    );
    // No flag at all: last, after the prompt.
    let mut a = v(&["hello there"]);
    place(&mut a, Some("claude-code"), extra());
    assert_eq!(a, v(&["hello there", "--mcp-config", "/c.json"]));
    // Windows' cmd.exe prefix stays first.
    let mut a = v(&["/C", "claude.cmd", "--resume", "s"]);
    place(&mut a, Some("claude-code"), extra());
    assert_eq!(
        a,
        v(&[
            "/C",
            "claude.cmd",
            "--mcp-config",
            "/c.json",
            "--resume",
            "s"
        ])
    );
    // Codex: first, like the preview's overrides.
    let mut a = v(&["prompt"]);
    place(&mut a, Some("codex"), v(&["-c", "k=v"]));
    assert_eq!(a, v(&["-c", "k=v", "prompt"]));
    // Nothing to add: untouched.
    let mut a = v(&["x"]);
    place(&mut a, Some("claude-code"), Vec::new());
    assert_eq!(a, v(&["x"]));
}
