use super::*;
use serde_json::json;
use std::process::Command;

const H: Duration = Duration::from_secs(60 * 60);

fn later() -> SystemTime {
    SystemTime::now() + 2 * H
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A package with installed dependencies: `node_modules` beside `package.json`.
fn npm_package(dir: &Path) {
    write(&dir.join("package.json"), "{}");
    write(
        &dir.join("node_modules/left-kit/index.js"),
        "x".repeat(10_000).as_str(),
    );
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(["-c", "user.email=t@example.test", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn levels_and_the_turn_note() {
    assert_eq!(level_for(None), Level::Fine);
    assert_eq!(level_for(Some(40 * GB)), Level::Fine);
    assert_eq!(level_for(Some(12 * GB)), Level::Low);
    assert_eq!(level_for(Some(2 * GB)), Level::Floor);
    assert_eq!(note_for(None), "");
    assert_eq!(note_for(Some(40 * GB)), "");
    let low = note_for(Some(12 * GB));
    assert!(low.contains("12 GB free"), "{low}");
    assert!(low.contains("delete node_modules"), "{low}");
    assert!(low.contains("keep reports and unpushed commits"), "{low}");
    assert!(!low.contains("on a card"), "{low}");
    let floor = note_for(Some(1_500_000_000));
    assert!(floor.contains("1.5 GB free"), "{floor}");
    assert!(floor.contains("ask the user on a card"), "{floor}");
    assert!(floor.starts_with("[A note from the app, not the user:"));
}

#[test]
fn each_crossing_is_said_once_until_space_comes_back() {
    let mut said = Said::default();
    assert_eq!(step(&mut said, 40 * GB), None);
    assert_eq!(step(&mut said, 14 * GB), Some(Crossing::Low));
    assert_eq!(step(&mut said, 13 * GB), None);
    assert_eq!(step(&mut said, 4 * GB), Some(Crossing::Floor));
    assert_eq!(step(&mut said, 2 * GB), None);
    // A little back, not past the floor's margin: still quiet.
    assert_eq!(step(&mut said, 6 * GB), None);
    assert_eq!(step(&mut said, 4 * GB), None);
    // Past the floor's margin, then down again: the floor once more, not "low".
    assert_eq!(step(&mut said, 8 * GB), None);
    assert_eq!(step(&mut said, 4 * GB), Some(Crossing::Floor));
    // Fully back, then low again.
    assert_eq!(step(&mut said, 30 * GB), None);
    assert_eq!(step(&mut said, 10 * GB), Some(Crossing::Low));
    // Straight from fine to the floor is one line, the floor's.
    let mut said = Said::default();
    assert_eq!(step(&mut said, GB), Some(Crossing::Floor));
    assert_eq!(step(&mut said, GB), None);
}

/// Observed (2026-11-08): six relaunches in an afternoon, the disk hovering
/// at 11–15 GB, six identical lines in the Chief's chat. What was said
/// survives a relaunch; space coming back still re-arms it.
#[test]
fn a_relaunch_is_not_a_new_crossing() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(SAID_FILE);
    assert_eq!(step_kept(&kept, 13 * GB), Some(Crossing::Low));
    // Each reading below is a fresh launch: only the file carries over.
    for free in [14 * GB, 14 * GB, 11 * GB, 14 * GB] {
        assert_eq!(step_kept(&kept, free), None, "{free}");
    }
    assert_eq!(step_kept(&kept, 4 * GB), Some(Crossing::Floor));
    assert_eq!(step_kept(&kept, 3 * GB), None);
    assert_eq!(step_kept(&kept, 30 * GB), None);
    assert_eq!(step_kept(&kept, 12 * GB), Some(Crossing::Low));
    // A file it can't read is a fresh start, never a panic.
    std::fs::write(&kept, "not json").unwrap();
    assert_eq!(step_kept(&kept, 12 * GB), Some(Crossing::Low));
}

#[test]
fn installs_and_clones_are_recognised() {
    for cmd in [
        "npm ci",
        "cd clones/a && npm install",
        "npm i zod",
        "pnpm install --frozen-lockfile",
        "pnpm --filter web add zod",
        "yarn",
        "yarn add left-pad",
        "bun install",
        "pip install -r requirements.txt",
        "python3 -m pip install requests",
        "uv sync",
        "uv pip install ruff",
        "cargo build --release",
        "go mod download",
        "brew install jq",
        "git clone https://example.test/a.git clones/a",
        "git -C sweep clone https://example.test/b.git",
        "gh repo clone acme/site",
        "for r in a b; do (cd $r && npm ci) & done; wait",
        "bash -c 'npm ci'",
        "timeout 600 npm ci",
    ] {
        assert!(fetches(cmd), "{cmd}");
    }
    for cmd in [
        "ls -la",
        "npm test",
        "npm run build",
        "pnpm audit --json",
        "npm audit",
        "git status",
        "git log --oneline",
        "gh repo view acme/site",
        "rm -rf node_modules",
        "du -sh .",
        "uv run pytest",
        "echo npm ci",
    ] {
        assert!(!fetches(cmd), "{cmd}");
    }
}

#[test]
fn below_the_floor_installs_ask_and_nothing_else_does() {
    let npm = json!({ "command": "npm ci", "description": "x" });
    let ls = json!({ "command": "ls", "description": "x" });
    assert!(!floor_asks_at(Some(40 * GB), "Bash", &npm));
    assert!(
        !floor_asks_at(Some(10 * GB), "Bash", &npm),
        "low is a note, not a card"
    );
    assert!(floor_asks_at(Some(3 * GB), "Bash", &npm));
    assert!(!floor_asks_at(Some(3 * GB), "Bash", &ls));
    assert!(!floor_asks_at(
        Some(3 * GB),
        "Read",
        &json!({ "file_path": "/x" })
    ));
    assert!(card_line_for(Some(3 * GB)).contains("3.0 GB free"));
    assert!(
        !floor_asks_at(None, "Bash", &npm),
        "unknown free space never asks"
    );
    // Tests never read this Mac's own disk.
    assert!(!floor_asks("Bash", &npm));
    assert_eq!(turn_note(), "");
}

#[test]
fn only_regenerable_folders_beside_their_manifest_are_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let sweep = home.join("sweep-2026-11-07");
    npm_package(&sweep.join("clones/a"));
    npm_package(&sweep.join("wt/a-fix"));
    // A Rust crate's build folder, and a Next app's.
    write(&sweep.join("clones/r/Cargo.toml"), "[package]");
    write(&sweep.join("clones/r/target/debug/x"), "x");
    write(&sweep.join("clones/n/package.json"), "{}");
    write(&sweep.join("clones/n/.next/cache/x"), "x");
    // A folder merely named `target` or `node_modules`, with nothing that rebuilds it.
    write(&home.join("notes/target/plan.md"), "keep");
    write(&home.join("loose/node_modules/x.js"), "keep");
    // One with its own `.git`, and one inside a `.git` folder.
    write(&home.join("odd/package.json"), "{}");
    write(&home.join("odd/node_modules/.git/HEAD"), "ref");
    write(&home.join("repo/.git/package.json"), "{}");
    write(&home.join("repo/.git/node_modules/x"), "x");
    let found = candidates(home, H, later());
    let rel: Vec<String> = found
        .iter()
        .map(|p| p.strip_prefix(home).unwrap().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        rel,
        vec![
            "sweep-2026-11-07/clones/a/node_modules",
            "sweep-2026-11-07/clones/n/.next",
            "sweep-2026-11-07/clones/r/target",
            "sweep-2026-11-07/wt/a-fix/node_modules",
        ]
    );
    // Recently touched: not yet.
    assert!(candidates(home, H, SystemTime::now()).is_empty());
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_home_is_never_followed() {
    let outside = tempfile::tempdir().unwrap();
    npm_package(&outside.path().join("project"));
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    std::os::unix::fs::symlink(outside.path().join("project"), home.join("project")).unwrap();
    write(&home.join("site/package.json"), "{}");
    std::os::unix::fs::symlink(
        outside.path().join("project/node_modules"),
        home.join("site/node_modules"),
    )
    .unwrap();
    assert!(candidates(home, Duration::ZERO, later()).is_empty());
    let freed = rt().block_on(prune(home, Duration::ZERO, || false));
    assert_eq!(freed.removed, 0);
    assert!(outside
        .path()
        .join("project/node_modules/left-kit/index.js")
        .is_file());
}

#[test]
fn prune_removes_ignored_dependencies_and_keeps_everything_else() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    // A clone: node_modules ignored, a report, an unpushed commit.
    let a = home.join("sweep/clones/a");
    npm_package(&a);
    write(&a.join(".gitignore"), "node_modules/\n");
    write(&a.join("REPORT.md"), "findings");
    git(&a, &["init", "-q"]);
    git(&a, &["add", "package.json", ".gitignore", "REPORT.md"]);
    git(&a, &["commit", "-qm", "unpushed"]);
    write(&a.join("WIP.md"), "uncommitted");
    // A repo that commits its node_modules: never removed.
    let b = home.join("sweep/clones/b");
    npm_package(&b);
    git(&b, &["init", "-q"]);
    git(&b, &["add", "."]);
    git(&b, &["commit", "-qm", "vendored"]);
    // A repo that doesn't ignore it: removing it would be a change.
    let c = home.join("sweep/clones/c");
    npm_package(&c);
    git(&c, &["init", "-q"]);
    // Not a repo at all: regenerable by name and manifest.
    let d = home.join("scratch/d");
    npm_package(&d);

    // A later prune sees them as old by passing a zero age.
    let freed = rt().block_on(prune(home, Duration::ZERO, || false));
    assert_eq!(freed.removed, 2, "{freed:?}");
    assert_eq!(freed.kept, 2, "{freed:?}");
    assert!(freed.bytes > 0);
    assert!(!a.join("node_modules").exists());
    assert!(!d.join("node_modules").exists());
    assert!(b.join("node_modules/left-kit/index.js").is_file());
    assert!(c.join("node_modules/left-kit/index.js").is_file());
    // What isn't regenerable is exactly as it was.
    for kept in [
        "REPORT.md",
        "WIP.md",
        "package.json",
        ".gitignore",
        ".git/HEAD",
    ] {
        assert!(a.join(kept).exists(), "{kept}");
    }
    let log = Command::new("git")
        .args(["log", "--oneline"])
        .current_dir(&a)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains("unpushed"));
}

#[test]
fn prune_stops_when_the_agent_starts_working() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    npm_package(&home.join("a"));
    npm_package(&home.join("b"));
    let freed = rt().block_on(prune(home, Duration::ZERO, || true));
    assert!(freed.busy);
    assert_eq!(freed.removed, 0);
    assert!(home.join("a/node_modules").exists());
    assert!(home.join("b/node_modules").exists());
}

#[test]
fn measuring_a_home_counts_its_regenerable_part() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    npm_package(&home.join("a"));
    write(&home.join("report.md"), "y".repeat(5_000).as_str());
    let (total, regen) = measure(home);
    assert!(regen > 0);
    assert!(total > regen);
}

#[test]
fn sizes_read_like_finder() {
    assert_eq!(gb(39 * GB), "39 GB");
    assert_eq!(gb(3_400_000_000), "3.4 GB");
    assert_eq!(gb(20_000_000), "20 MB");
}
