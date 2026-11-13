//! The classifier on each system's own paths: a Mac's case-insensitive disk,
//! and Windows' drives, Git Bash forms and profile folders, held to the same
//! lines as the fictional Mac in `autoallow_tests`.

use super::*;
use serde_json::json;

fn file(tool: &str, path: &str) -> Value {
    let mut v = json!({ "file_path": path });
    if tool == "Write" {
        v["content"] = json!("x");
    }
    v
}

/// A shell profile or a credential folder spelled in another case is still
/// that file on APFS, existing yet or not.
#[cfg(target_os = "macos")]
#[test]
fn a_mac_reads_paths_whatever_their_case() {
    const HOME: &str = "/Users/fictional-tester";
    let c = Ctx {
        home: HOME.into(),
        own_home: format!("{HOME}/Library/Application Support/FictionalApp/agents/a1").into(),
        cwd: format!("{HOME}/Projects/site").into(),
        ..Default::default()
    };
    for (tool, path, want) in [
        ("Write", "~/.ZSHRC", Class::Ask),
        ("Write", "~/Library/launchagents/x.plist", Class::Ask),
        ("Read", "~/.SSH/id_ed25519", Class::Ask),
        ("Write", "~/Projects/site/.GIT/hooks/pre-commit", Class::Ask),
        ("Write", "~/Projects/site/src/App.tsx", Class::Change),
    ] {
        assert_eq!(classify(tool, &file(tool, path), &c), want, "{tool} {path}");
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    const HOME: &str = r"C:\Users\fictional-tester";

    fn ctx() -> Ctx {
        let app = format!(r"{HOME}\AppData\Roaming\FictionalApp");
        let own = format!(r"{app}\agents\a1");
        Ctx {
            home: HOME.into(),
            own_home: own.clone().into(),
            cwd: format!(r"{HOME}\Projects\site").into(),
            scratch: vec![own.into()],
            app_data: vec![app.into()],
            ..Default::default()
        }
    }

    fn bash(command: &str) -> Class {
        classify("Bash", &json!({ "command": command }), &ctx())
    }

    #[test]
    fn file_tools_place_windows_paths() {
        let c = ctx();
        for (tool, path, want) in [
            (
                "Read",
                r"C:\Users\fictional-tester\Projects\site\src\App.tsx",
                Class::Read,
            ),
            (
                "Read",
                "C:/Users/fictional-tester/Projects/site/README.md",
                Class::Read,
            ),
            ("Read", r"src\App.tsx", Class::Read),
            (
                "Read",
                r"C:\Users\fictional-tester\.ssh\id_ed25519",
                Class::Ask,
            ),
            ("Read", r"c:\users\FICTIONAL-TESTER\.SSH\config", Class::Ask),
            (
                "Read",
                r"C:\Users\fictional-tester\AppData\Local\Google\Chrome\User Data\Default\Cookies",
                Class::Ask,
            ),
            (
                "Write",
                r"C:\Users\fictional-tester\Projects\site\src\App.tsx",
                Class::Change,
            ),
            ("Write", r"src\App.tsx", Class::Change),
            (
                "Write",
                r"C:\Users\fictional-tester\Projects\site\.git\config",
                Class::Ask,
            ),
            (
                "Write",
                r"C:\Users\fictional-tester\Projects\site\.GIT\hooks\pre-commit",
                Class::Ask,
            ),
            (
                "Write",
                r"C:\Users\fictional-tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.cmd",
                Class::Ask,
            ),
            (
                "Write",
                r"C:\Users\fictional-tester\Documents\PowerShell\Microsoft.PowerShell_profile.ps1",
                Class::Ask,
            ),
            (
                "Write",
                r"C:\Windows\System32\drivers\etc\hosts",
                Class::Ask,
            ),
            ("Write", r"\\server\share\x.txt", Class::Ask),
            ("Write", r"\Users\fictional-tester\x.txt", Class::Ask),
            ("Write", "C:x.txt", Class::Ask),
        ] {
            assert_eq!(classify(tool, &file(tool, path), &c), want, "{tool} {path}");
        }
    }

    #[test]
    fn git_bash_paths_are_the_drives_own() {
        for (command, want) in [
            (
                "cat /c/Users/fictional-tester/Projects/site/package.json",
                Class::Read,
            ),
            (
                "cat C:/Users/fictional-tester/Projects/site/package.json",
                Class::Read,
            ),
            ("ls ~/Projects", Class::Read),
            ("cat /c/Users/fictional-tester/.ssh/id_ed25519", Class::Ask),
            ("cat ~/.ssh/id_ed25519", Class::Ask),
            (
                "mkdir -p /c/Users/fictional-tester/Projects/site/out",
                Class::Change,
            ),
            ("touch /c/Windows/x", Class::Ask),
            ("touch /usr/bin/x", Class::Ask),
        ] {
            assert_eq!(bash(command), want, "{command}");
        }
    }

    #[test]
    fn bold_asks_for_the_same_places_on_windows() {
        let c = ctx();
        let asks = |command: &str| {
            super::super::super::go_hard::asks("Bash", &json!({ "command": command }), &c, false)
        };
        for command in [
            "cat /c/Users/fictional-tester/.ssh/id_ed25519",
            "cat C:/Users/fictional-tester/.SSH/id_ed25519",
            "echo x >> '/c/Users/fictional-tester/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.cmd'",
            "echo x > C:/Windows/System32/x.dll",
        ] {
            assert!(asks(command), "{command}");
        }
        for command in [
            "echo x > /c/Users/fictional-tester/Projects/site/notes.txt",
            "echo done > /tmp/build.log 2>&1",
            "cat /c/Users/fictional-tester/Projects/site/package.json",
        ] {
            assert!(!asks(command), "{command}");
        }
    }
}
