use super::*;
use serde_json::json;
use std::os::unix::fs::symlink;

/// A project with the links tonight's review used: a file and a folder that
/// point outside it, one into its `.git`, one to nowhere. Everything in a
/// temp folder; nothing of the user's.
struct Fixture {
    _dir: tempfile::TempDir,
    proj: PathBuf,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let proj = root.join("proj");
    let outside = root.join("outside");
    std::fs::create_dir_all(proj.join(".git/hooks")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("target.txt"), "orig").unwrap();
    std::fs::write(proj.join("plain.md"), "x").unwrap();
    symlink(outside.join("target.txt"), proj.join("notes.md")).unwrap();
    symlink(&outside, proj.join("outdir")).unwrap();
    symlink(".git/hooks", proj.join("hooks")).unwrap();
    symlink(outside.join("ghost.txt"), proj.join("dangling.md")).unwrap();
    std::fs::create_dir_all(proj.join("src")).unwrap();
    symlink("src", proj.join("lib")).unwrap();
    Fixture {
        _dir: dir,
        proj,
        outside,
    }
}

fn at(f: &Fixture, tool: &str, rel: &str) -> Landing {
    let p = f.proj.join(rel).to_string_lossy().into_owned();
    landing(
        tool,
        &json!({ "file_path": p }),
        &f.proj,
        Path::new("/nonexistent-home"),
    )
}

#[test]
fn a_plain_path_is_judged_as_written() {
    let f = fixture();
    assert_eq!(at(&f, "Edit", "plain.md"), Landing::Direct);
    assert_eq!(at(&f, "Write", "new/file.md"), Landing::Direct);
    assert_eq!(at(&f, "Read", "plain.md"), Landing::Direct);
}

#[test]
fn a_write_through_a_folder_link_is_judged_where_it_lands() {
    let f = fixture();
    let Landing::Redirected { input, note } = at(&f, "Write", "outdir/new.txt") else {
        panic!("not redirected");
    };
    assert_eq!(
        input["file_path"],
        json!(f.outside.join("new.txt").to_string_lossy())
    );
    assert!(note.contains("is a link"), "{note}");
}

#[test]
fn an_edit_of_a_file_link_is_judged_where_it_points() {
    let f = fixture();
    let Landing::Redirected { input, .. } = at(&f, "Edit", "notes.md") else {
        panic!("not redirected");
    };
    assert_eq!(
        input["file_path"],
        json!(f.outside.join("target.txt").to_string_lossy())
    );
    // A read through it too: what it reads is the outside file.
    assert!(matches!(
        at(&f, "Read", "notes.md"),
        Landing::Redirected { .. }
    ));
}

#[test]
fn a_write_carried_into_git_by_a_link_is_refused() {
    let f = fixture();
    assert!(matches!(
        at(&f, "Write", "hooks/pre-commit"),
        Landing::Protected(_)
    ));
    assert!(matches!(
        at(&f, "MultiEdit", "hooks/pre-commit"),
        Landing::Protected(_)
    ));
    // Reading there isn't a write.
    assert!(matches!(
        at(&f, "Read", "hooks/pre-commit"),
        Landing::Redirected { .. }
    ));
}

#[test]
fn a_write_through_a_dangling_link_always_asks() {
    let f = fixture();
    assert!(matches!(
        at(&f, "Write", "dangling.md"),
        Landing::Dangling(_)
    ));
    // Reading through it reads nothing: judged as written.
    assert_eq!(at(&f, "Read", "dangling.md"), Landing::Direct);
}

#[test]
fn a_link_inside_the_project_lands_inside_it() {
    let f = fixture();
    let Landing::Redirected { input, .. } = at(&f, "Edit", "lib/a.ts") else {
        panic!("not redirected");
    };
    assert_eq!(
        input["file_path"],
        json!(f.proj.join("src/a.ts").to_string_lossy())
    );
}

#[test]
fn relative_paths_notebooks_and_folder_tools_are_covered() {
    let f = fixture();
    assert!(matches!(
        landing(
            "Edit",
            &json!({ "file_path": "outdir/x" }),
            &f.proj,
            Path::new("/h")
        ),
        Landing::Redirected { .. }
    ));
    assert!(matches!(
        landing(
            "NotebookEdit",
            &json!({ "notebook_path": f.proj.join("hooks/n.ipynb") }),
            &f.proj,
            Path::new("/h")
        ),
        Landing::Protected(_)
    ));
    assert!(matches!(
        landing(
            "Grep",
            &json!({ "pattern": "x", "path": "outdir" }),
            &f.proj,
            Path::new("/h")
        ),
        Landing::Redirected { .. }
    ));
    // Not a file tool, or no path: untouched.
    assert_eq!(
        landing(
            "Bash",
            &json!({ "command": "ls outdir" }),
            &f.proj,
            Path::new("/h")
        ),
        Landing::Direct
    );
    assert_eq!(
        landing("Glob", &json!({ "pattern": "*" }), &f.proj, Path::new("/h")),
        Landing::Direct
    );
}

/// The gap this closes: at "Bold" and "Unleashed" a write is judged by
/// `go_hard`, which reads the path as text. `proj/agents -> ~/Library/LaunchAgents`
/// made `proj/agents/x.plist` look like project work. Judged where it lands,
/// it asks, at every level.
#[test]
fn bold_and_unleashed_ask_for_a_write_a_link_carries_out_of_the_project() {
    use crate::agents::autoallow::{auto, Ctx};
    use crate::agents::independence::Level;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();
    let proj = home.join("ShipStudio/site");
    let launch = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::create_dir_all(&launch).unwrap();
    std::fs::write(home.join(".zshrc"), "").unwrap();
    symlink(&launch, proj.join("agents")).unwrap();
    symlink(home.join(".zshrc"), proj.join("notes.md")).unwrap();
    let ctx = Ctx {
        home: home.clone(),
        own_home: home.join("agent-home"),
        cwd: proj.clone(),
        ..Ctx::default()
    };
    for (tool, rel) in [("Write", "agents/x.plist"), ("Edit", "notes.md")] {
        let written = json!({ "file_path": proj.join(rel).to_string_lossy() });
        let Landing::Redirected { input: real, .. } = landing(tool, &written, &proj, &home) else {
            panic!("{rel}: not redirected");
        };
        for level in [Level::GoHard, Level::FullSend] {
            // As written, it passed: the gap.
            assert!(
                auto(level, false, tool, &written, &ctx).is_some(),
                "{rel} {level:?}"
            );
            // Where it lands, it asks.
            assert!(
                auto(level, false, tool, &real, &ctx).is_none(),
                "{rel} {level:?}"
            );
        }
        for level in [Level::Often, Level::Judgement] {
            assert!(
                auto(level, false, tool, &real, &ctx).is_none(),
                "{rel} {level:?}"
            );
        }
    }
}

#[test]
fn macos_own_aliases_are_not_links_crossed() {
    // `/tmp` and `/var` are links to `/private/…` on macOS; a write in a temp
    // folder is not a write "through a link".
    assert!(!crosses_link(Path::new("/tmp/some-file-that-is-not-there")));
    let t = std::env::temp_dir().join("links-tests-not-there.txt");
    assert!(!crosses_link(&t));
}
