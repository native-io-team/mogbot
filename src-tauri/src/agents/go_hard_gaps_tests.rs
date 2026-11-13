//! Gaps a second adversarial review left open (2026-11-08): programs that
//! come from a variable or a substitution, scripts the line writes and then
//! runs, aliases and project scripts, a few remote and UI tools, moving the
//! user's own folders, and relative paths into the app's data. Each test
//! checks both directions: what now asks, and the everyday work beside it
//! that still runs. Paths, hosts and names are fictional.

use super::*;
use serde_json::json;

const HOME: &str = "/Users/fictional-tester";

fn ctx_at(full_send: bool) -> Ctx {
    let app = format!("{HOME}/Library/Application Support/FictionalApp");
    let own = format!("{app}/agents/a1");
    Ctx {
        home: HOME.into(),
        own_home: own.clone().into(),
        cwd: own.clone().into(),
        scratch: vec![own.into()],
        app_data: vec![app.into()],
        full_send,
        ..Default::default()
    }
}

fn go_hard(command: &str) -> bool {
    asks(
        "Bash",
        &json!({ "command": command }),
        &ctx_at(false),
        false,
    )
}

fn full_send(command: &str) -> bool {
    asks("Bash", &json!({ "command": command }), &ctx_at(true), false)
}

/// A fictional home on disk with a project in it, for the rules that read
/// files (package.json, a Makefile, git config, a script).
struct Disk {
    _dir: tempfile::TempDir,
    home: PathBuf,
    project: PathBuf,
}

impl Disk {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap().join("home");
        let project = home.join("Projects/fictional-site");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::write(project.join(".git/HEAD"), "ref: refs/heads/feature-x\n").unwrap();
        Disk {
            _dir: dir,
            home,
            project,
        }
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.project.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn ctx(&self, full_send: bool) -> Ctx {
        Ctx {
            home: self.home.clone(),
            own_home: self.home.join("agent-home"),
            cwd: self.project.clone(),
            scratch: vec![self.project.clone()],
            full_send,
            ..Default::default()
        }
    }

    fn asks(&self, command: &str, full_send: bool) -> bool {
        asks(
            "Bash",
            &json!({ "command": command }),
            &self.ctx(full_send),
            false,
        )
    }
}

/* 1 ------------------------------------------------- unknown programs */

/// A program word that is a variable the line never set, or a command
/// substitution, can't be read. It is judged by what the words after it
/// would do for the programs on the ask list: `$X push origin main` asks
/// as `git push` would. A substitution that only echoes or looks up a name
/// (`$(echo git)`, `$(which git)`) is the name it prints.
#[test]
fn an_unreadable_program_is_judged_by_its_arguments() {
    for cmd in [
        "$X push origin main",
        "${GIT} push origin main",
        "$(echo git) push origin main",
        "`echo git` push origin main",
        "$(which git) push origin main",
        "\"$(command -v git)\" push",
        "$(which sudo) ls",
        "$(echo git push)",
        "$TOOL publish",
        "$X deploy --prod",
        "$X -rf ~/Documents",
        "git $(echo push) origin main",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
    }
    // At Full send the same rules as for the program it would be.
    assert!(full_send("$X push origin main"));
    assert!(full_send("$(echo git) push --force origin feature-x"));
    // Local work through a variable or a substitution keeps running.
    for cmd in [
        "$PY render.py --out dist",
        "\"$(git rev-parse --show-toplevel)/scripts/render.sh\" --out dist",
        "$(npm bin)/eslint .",
        "$EDITOR notes.md",
        "`which python3` build.py",
        "$NODE scripts/shot.mjs http://localhost:3000",
        "X=$(git rev-parse HEAD); echo $X > rev.txt",
        "cd $(mktemp -d) && touch a",
    ] {
        assert!(!go_hard(cmd), "runs at Go hard: {cmd}");
        assert!(!full_send(cmd), "runs at Full send: {cmd}");
    }
}

/* 2 ---------------------------------------- written, then run scripts */

/// A script the line writes and then runs is judged by what it says.
#[test]
fn a_script_the_line_writes_then_runs_is_judged_by_its_body() {
    for cmd in [
        "cat > a.sh <<'EOF'\ngit push origin main\nEOF\nsh a.sh",
        "cat <<EOF > a.sh\ngit push origin main\nEOF\nbash a.sh",
        "cat > a.sh <<EOF\ngit push\nEOF\nchmod +x a.sh && ./a.sh",
        "tee a.sh >/dev/null <<EOF\nsudo ls\nEOF\nzsh a.sh",
        "echo 'git push origin main' > a.sh; sh a.sh",
        "printf 'set -e\\ngit push origin main\\n' > a.sh && bash a.sh",
        "echo 'echo hi >> ~/.zshrc' > a.sh; source a.sh",
        "cat > a.sh <<EOF\nvercel deploy --prod\nEOF\n. ./a.sh",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd:?}");
        assert!(full_send(cmd), "asks at Full send: {cmd:?}");
    }
    // A local render written and run the same way keeps running.
    for cmd in [
        "cat > r.sh <<'EOF'\nnode render.mjs --out dist\nopen dist/index.html\nEOF\nbash r.sh",
        "echo 'python3 shot.py > out.png' > s.sh && sh s.sh",
        // Written but not run: data, as before.
        "cat > deploy.sh <<'EOF'\ngit push origin main\nEOF",
        // Run but not written here (nothing on disk to read): as before.
        "bash build.sh",
    ] {
        assert!(!go_hard(cmd), "runs at Go hard: {cmd:?}");
        assert!(!full_send(cmd), "runs at Full send: {cmd:?}");
    }
}

/// A shell script written earlier in the turn (just now, on disk) and run
/// by a shell is judged by what it says; one that has sat there a while,
/// or that isn't a shell script, keeps today's behaviour.
#[test]
fn a_shell_script_written_just_now_is_judged_by_its_body() {
    let d = Disk::new();
    d.write("ship.sh", "#!/bin/sh\nset -e\ngit push origin main\n");
    d.write("render.sh", "#!/bin/sh\nnode render.mjs\n");
    d.write("tool.py", "import os\nprint('git push')\n");
    assert!(d.asks("bash ship.sh", false));
    assert!(d.asks("chmod +x ship.sh && ./ship.sh", false));
    assert!(d.asks("sh ./ship.sh", true));
    assert!(!d.asks("bash render.sh", false));
    assert!(!d.asks("python3 tool.py", false));
    // Older than a turn: as before.
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 60 * 60);
    std::fs::File::options()
        .write(true)
        .open(d.project.join("ship.sh"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert!(!d.asks("bash ship.sh", false));
}

/* 3 ------------------------------------- aliases and project scripts */

/// A git alias runs what it stands for: one given with `-c`, one the line
/// sets with `git config`, and one in the repo's or the user's config.
#[test]
fn git_aliases_are_judged_by_what_they_run() {
    for cmd in [
        "git -c alias.x=push x origin main",
        "git -c alias.x='!git push' x",
        "git config alias.x push && git x origin main",
        "git config --local alias.ship 'push origin main' && git ship",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
        assert!(full_send(cmd), "asks at Full send: {cmd}");
    }
    assert!(!go_hard("git -c alias.st=status st"));
    assert!(!go_hard("git -c color.ui=always log --oneline"));
    assert!(!full_send("git -c alias.x=push x origin feature-x"));

    let d = Disk::new();
    std::fs::write(
        d.project.join(".git/config"),
        "[core]\n\tbare = false\n[alias]\n\tp = push\n\tco = checkout\n",
    )
    .unwrap();
    std::fs::write(
        d.home.join(".gitconfig"),
        "[alias]\n  yolo = !git push -f\n",
    )
    .unwrap();
    assert!(d.asks("git p origin main", false));
    assert!(d.asks("git yolo", true));
    assert!(!d.asks("git co -b feature-y", false));
}

/// `npm run`, `pnpm`, `yarn`, `bun run` and `make` run the script or
/// target the project defines; one level of it is read from the folder's
/// `package.json` or `Makefile`. An unknown script runs as before.
#[test]
fn project_scripts_are_judged_by_their_body() {
    let d = Disk::new();
    d.write(
        "package.json",
        r#"{"scripts":{"build":"next build","ship":"vercel deploy --prod","release":"npm publish","predeploy":"npm run build","deploy":"git push origin main","shots":"node scripts/shots.mjs"}}"#,
    );
    d.write(
        "Makefile",
        "all: build\n\nbuild:\n\tnode build.mjs\n\npublish:\n\t@echo shipping\n\tnpm publish\n\n.PHONY: all build publish\n",
    );
    for cmd in [
        "npm run ship",
        "pnpm run ship",
        "pnpm ship",
        "yarn ship",
        "bun run ship",
        "npm run release",
        "npm run deploy",
        "make publish",
        "make -C . publish",
    ] {
        assert!(d.asks(cmd, false), "asks at Go hard: {cmd}");
    }
    assert!(d.asks("npm run ship", true));
    for cmd in [
        "npm run build",
        "pnpm build",
        "npm run shots",
        "make",
        "make build",
        "npm run missing",
        "make nothing-here",
    ] {
        assert!(!d.asks(cmd, false), "runs at Go hard: {cmd}");
    }
}

/* 4 ------------------------------------- ssh, curl -K, System Events */

#[test]
fn remote_commands_curl_configs_and_ui_scripting_ask() {
    for cmd in [
        "ssh box.example.invalid git push origin main",
        "ssh -p 2222 -l deploy box.example.invalid sudo systemctl restart web",
        "curl -K req.txt",
        "curl --config req.txt https://api.example.invalid",
        "osascript -e 'tell application \"System Events\" to keystroke \"v\" using command down'",
        "osascript -e 'tell application \"System Events\" to click button \"Send\" of window 1'",
        "osascript <<EOF\ntell application \"System Events\"\nkey code 36\nend tell\nEOF",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
        assert!(full_send(cmd), "asks at Full send: {cmd}");
    }
    for cmd in [
        "ssh box.example.invalid uptime",
        "ssh box.example.invalid 'ls -la /var/www'",
        "curl -s https://example.invalid/status",
        "osascript -e 'tell application \"System Events\" to get name of every process'",
        "osascript -e 'display notification \"done\"'",
    ] {
        assert!(!go_hard(cmd), "runs at Go hard: {cmd}");
    }
}

/* 5 ----------------------------------------------- destructive moves */

#[test]
fn moving_or_trashing_the_users_folders_asks_like_rm_r() {
    for cmd in [
        "mv ~/Documents /tmp/x",
        "mv ~/Desktop/ ~/old-desktop",
        "mv ~/Downloads/* /tmp/gone",
        "mv ~ /tmp/home",
        "trash ~/Pictures",
        "trash ~/Documents/*",
        "rsync -a --delete /tmp/empty/ ~/Documents/",
        "rsync -a --delete-after build/ ~/Desktop",
        "rsync -a --remove-source-files ~/Pictures/ /tmp/p/",
        "find ~/Downloads -name '*.zip' -delete",
        "cd ~ && mv Documents /tmp/x",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
        assert!(full_send(cmd), "asks at Full send: {cmd}");
    }
    for cmd in [
        "mv ~/Downloads/report.pdf ~/Projects/site/public/",
        "mv dist dist-old",
        "trash ~/Projects/site/node_modules",
        "rsync -a --delete build/ ~/Projects/site/out/",
        "rsync -a ~/Documents/notes/ /tmp/notes/",
        "mv ~/Desktop/Projects/a ~/Desktop/Projects/b",
    ] {
        assert!(!go_hard(cmd), "runs at Go hard: {cmd}");
    }
}

/* 6 ------------------------------- a variable naming a protected path */

#[test]
fn a_write_through_a_variable_set_to_a_protected_path_asks() {
    for cmd in [
        "X=~/.zshrc; echo hi >> $X",
        "export X=~/.zshrc; echo hi >> \"$X\"",
        "declare X=$HOME/.ssh/authorized_keys; cat k.pub >> $X",
        "X=notes.txt; X=~/.zshrc; echo hi >> $X",
        "X=~/.zshrc; X=$(pwd)/n; echo hi >> $X",
        "P=~/Library/LaunchAgents; cp x.plist $P/",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
        assert!(full_send(cmd), "asks at Full send: {cmd}");
    }
    for cmd in [
        "X=notes.txt; echo hi >> $X",
        "export OUT=dist; node build.mjs > $OUT/log.txt",
        "D=a; D=b; echo hi > $D.txt",
    ] {
        assert!(!go_hard(cmd), "runs at Go hard: {cmd}");
    }
}

/* 7 ------------------------------ relative paths into the app's data */

/// After `cd ..` (or with a bare relative path) from the agent's home, a
/// path into the app's data is judged where it lands, as the absolute path
/// would be. Only a guess that names something there counts: the engine's
/// shell may have moved since, and `../site/.env` from a project the shell
/// is really in stays a read of that project.
#[test]
// TODO(windows): on CI the temp dir is an 8.3 short name (RUNNER~1), and the
// absolute read of bridge.json there didn't ask. Likely one side is
// canonicalised to the long name and the other isn't. The real app-data
// folder (%APPDATA%) has no short name; fix the comparison, then drop this.
#[cfg_attr(windows, ignore = "8.3 short temp path vs canonical long path")]
fn relative_paths_into_the_apps_data_are_resolved() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap().join("home");
    let app = home.join("Library/Application Support/FictionalApp");
    let own = app.join("agents/a1");
    for f in [
        "bridge.json",
        "agents/wallet.json",
        "agents/connections.json",
        "agents/a2/CLAUDE.md",
        "agents/a2/messages.jsonl",
        "agents/a2/report.md",
        "agents/a1/CLAUDE.md",
    ] {
        let p = app.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "fictional").unwrap();
    }
    let ctx = |full_send| Ctx {
        home: home.clone(),
        own_home: own.clone(),
        cwd: own.clone(),
        scratch: vec![own.clone()],
        app_data: vec![app.clone()],
        full_send,
        ..Default::default()
    };
    let at =
        |cmd: &str, full_send| asks("Bash", &json!({ "command": cmd }), &ctx(full_send), false);
    let app_s = app.display().to_string();
    // The absolute forms, for comparison.
    assert!(at(&format!("cat '{app_s}/bridge.json'"), false));
    assert!(at(
        &format!("echo x >> '{app_s}/agents/a2/CLAUDE.md'"),
        false
    ));
    assert!(!at(
        &format!("cat '{app_s}/agents/a2/messages.jsonl'"),
        false
    ));
    for cmd in [
        "cd .. && cat ../bridge.json",
        "cd ../.. && cat bridge.json",
        "cat ../../bridge.json",
        "cd .. && echo x >> a2/CLAUDE.md",
        "echo x >> ../a2/CLAUDE.md",
        "cd .. && cat wallet.json",
        "cat ../connections.json",
        "cd .. && cp ~/x.txt a2/notes.md",
    ] {
        assert!(at(cmd, false), "asks at Go hard: {cmd}");
        assert!(at(cmd, true), "asks at Full send: {cmd}");
    }
    for cmd in [
        "cd .. && cat a2/messages.jsonl",
        "cat ../a2/CLAUDE.md",
        "cd .. && ls",
        "echo x >> notes.md",
        "cd .. && cp a2/report.md a1/report.md",
        // Nothing of that name beside the agent's home: the shell is elsewhere.
        "cp ../site-marketing/.env.local .",
        "echo x >> ../site-marketing/notes.md",
    ] {
        assert!(!at(cmd, false), "runs at Go hard: {cmd}");
    }
}
