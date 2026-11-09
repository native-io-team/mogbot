//! The rename migration against a scratch home folder.

use super::*;

fn layout(home: &Path) -> Layout {
    Layout {
        home: home.to_path_buf(),
        old: Names {
            slug: "oldbot".into(),
            identifier: "io.example.oldbot".into(),
            app_dir_name: "Oldbot".into(),
        },
        new: Names {
            slug: "newbot".into(),
            identifier: "io.example.newbot".into(),
            app_dir_name: "Newbot".into(),
        },
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

const AGENT: &str = "0123456789abcdef0123456789abcdef";

/// An old install: app support with agents, logs, account homes, webview
/// storage and a reopen-at-login item.
fn old_install(home: &Path) {
    let support = home.join("Library/Application Support/Oldbot");
    write(&support.join("companion.json"), "{\"devices\":[1]}");
    write(
        &support.join("agents/agents.json"),
        &format!(
            "{{\"routines\":[\"run ~/Library/Application\\\\ Support/Oldbot/agents/{AGENT}/tools/x.py\",\"read {home}/Library/Application Support/Oldbot/agents/*/messages.jsonl\",\"see ~/ShipStudio/oldbot-site and Application Support/OldbotSite\"]}}",
            home = home.display()
        ),
    );
    write(
        &support.join(format!("agents/{AGENT}/CLAUDE.md")),
        "My tools: ~/Library/Application Support/Oldbot/agents/x/tools\n",
    );
    write(
        &support.join(format!("agents/{AGENT}/messages.jsonl")),
        "{\"text\":\"~/Library/Application Support/Oldbot/agents\"}\n",
    );
    write(
        &support.join("agents/recently-deleted/abc/CLAUDE.md"),
        "Application Support/Oldbot/\n",
    );
    write(
        &home.join("Library/Logs/Oldbot/oldbot.log.2026-11-08"),
        "log",
    );
    write(&home.join(".oldbot/accounts/a1/claude/.claude.json"), "{}");
    write(
        &home.join("Library/WebKit/oldbot/WebsiteData/LocalStorage/x.sqlite3"),
        "ls",
    );
    write(
        &home.join("Library/LaunchAgents/io.example.oldbot.reopen-at-login.plist"),
        "<plist><dict><key>Label</key><string>io.example.oldbot.reopen-at-login</string><string>/Applications/Oldbot.app</string></dict></plist>",
    );
}

#[test]
fn an_old_install_moves_over_whole_and_the_old_paths_still_resolve() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    let l = layout(h);

    let log = migrate(&l, false, None);
    assert!(log.iter().any(|l| l.contains("app-support")), "{log:?}");

    let new_support = h.join("Library/Application Support/Newbot");
    assert_eq!(
        read(&new_support.join("companion.json")),
        "{\"devices\":[1]}"
    );
    // The old folder is a link to the new one.
    let old_support = h.join("Library/Application Support/Oldbot");
    assert!(old_support.is_symlink());
    assert_eq!(std::fs::read_link(&old_support).unwrap(), new_support);
    assert_eq!(
        read(&old_support.join("companion.json")),
        "{\"devices\":[1]}"
    );

    assert!(h
        .join("Library/Logs/Newbot/oldbot.log.2026-11-08")
        .is_file());
    assert!(!h.join("Library/Logs/Oldbot").exists());
    assert!(h.join(".newbot/accounts/a1/claude/.claude.json").is_file());
    assert!(h.join(".oldbot").is_symlink());
    assert!(h
        .join("Library/WebKit/newbot/WebsiteData/LocalStorage/x.sqlite3")
        .is_file());

    // The reopen-at-login item carries the new label and the old one is gone.
    let plist = h.join("Library/LaunchAgents/io.example.newbot.reopen-at-login.plist");
    assert!(read(&plist).contains("<string>io.example.newbot.reopen-at-login</string>"));
    assert!(!h
        .join("Library/LaunchAgents/io.example.oldbot.reopen-at-login.plist")
        .exists());

    // Registries and instructions point at the new folder; history is untouched.
    let agents = read(&new_support.join("agents/agents.json"));
    assert!(
        agents.contains("Application\\\\ Support/Newbot/agents/"),
        "{agents}"
    );
    assert!(agents.contains(&format!(
        "{}/Library/Application Support/Newbot/agents/*",
        h.display()
    )));
    assert!(
        agents.contains("~/ShipStudio/oldbot-site"),
        "project names are left alone"
    );
    assert!(
        agents.contains("Support/OldbotSite"),
        "only a whole folder name matches"
    );
    assert!(!agents.contains("Support/Oldbot/"));
    assert_eq!(
        read(&new_support.join(format!("agents/{AGENT}/CLAUDE.md"))),
        "My tools: ~/Library/Application Support/Newbot/agents/x/tools\n"
    );
    assert_eq!(
        read(&new_support.join("agents/recently-deleted/abc/CLAUDE.md")),
        "Application Support/Newbot/\n"
    );
    assert!(
        read(&new_support.join(format!("agents/{AGENT}/messages.jsonl")))
            .contains("Support/Oldbot/")
    );

    // Done, and recorded.
    assert!(l.marker().is_file());
}

#[test]
fn running_it_again_changes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    let l = layout(h);
    migrate(&l, false, None);
    let before = read(&h.join("Library/Application Support/Newbot/agents/agents.json"));
    let log = migrate(&l, false, None);
    assert!(log.is_empty(), "{log:?}");
    assert_eq!(
        read(&h.join("Library/Application Support/Newbot/agents/agents.json")),
        before
    );
}

#[test]
fn a_launch_that_stopped_half_way_finishes_the_rest() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    let l = layout(h);
    // As if the last launch had moved app support (and linked it) and then
    // stopped: nothing else moved, no marker.
    let old_support = h.join("Library/Application Support/Oldbot");
    let new_support = h.join("Library/Application Support/Newbot");
    std::fs::rename(&old_support, &new_support).unwrap();
    std::os::unix::fs::symlink(&new_support, &old_support).unwrap();

    migrate(&l, false, None);
    assert!(h.join(".newbot/accounts/a1").is_dir());
    assert!(h.join("Library/Logs/Newbot").is_dir());
    assert!(read(&new_support.join("agents/agents.json")).contains("Support/Newbot/"));
    assert!(l.marker().is_file());
}

#[test]
fn when_both_folders_hold_something_neither_is_touched() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    let new_support = h.join("Library/Application Support/Newbot");
    write(&new_support.join("companion.json"), "{\"devices\":[2]}");
    let l = layout(h);

    let log = migrate(&l, false, None);
    assert!(log.iter().any(|l| l.contains("both")), "{log:?}");
    let old_support = h.join("Library/Application Support/Oldbot");
    assert!(!old_support.is_symlink());
    assert_eq!(
        read(&old_support.join("companion.json")),
        "{\"devices\":[1]}"
    );
    assert_eq!(
        read(&new_support.join("companion.json")),
        "{\"devices\":[2]}"
    );
    // Not recorded as done: it says so again next launch.
    assert!(!l.marker().exists());
}

#[test]
fn an_empty_new_folder_made_before_us_makes_way() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    let new_logs = h.join("Library/Logs/Newbot");
    std::fs::create_dir_all(&new_logs).unwrap();
    migrate(&layout(h), false, None);
    assert!(new_logs.join("oldbot.log.2026-11-08").is_file());
}

#[test]
fn nothing_moves_while_the_old_app_runs() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    let l = layout(h);
    let log = migrate(&l, true, None);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(h
        .join("Library/Application Support/Oldbot/companion.json")
        .is_file());
    assert!(!h.join("Library/Application Support/Newbot").exists());
    assert!(!l.marker().exists());
}

#[test]
fn a_fresh_install_has_nothing_to_move() {
    let home = tempfile::tempdir().unwrap();
    let log = migrate(&layout(home.path()), false, None);
    assert!(log.is_empty(), "{log:?}");
}

#[test]
fn the_reopen_item_names_this_bundle_when_there_is_one() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    old_install(h);
    migrate(
        &layout(h),
        false,
        Some(Path::new("/Applications/Newbot.app")),
    );
    let plist = read(&h.join("Library/LaunchAgents/io.example.newbot.reopen-at-login.plist"));
    assert!(plist.contains("/Applications/Newbot.app"), "{plist}");
}

#[test]
fn rewriting_keeps_a_files_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("agents.json");
    std::fs::write(&f, "Application Support/Oldbot/x").unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(rewrite_file(&f, "Oldbot", "Newbot").unwrap());
    assert_eq!(read(&f), "Application Support/Newbot/x");
    assert_eq!(
        std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!dir.path().join("agents.json.renaming").exists());
}

#[test]
fn path_rewrites_match_whole_folder_names_only() {
    let r = |t: &str| rewrite_support_paths(t, "Oldbot", "Newbot");
    assert_eq!(r("Support/Oldbot").as_deref(), Some("Support/Newbot"));
    assert_eq!(
        r("a Support/Oldbot\"").as_deref(),
        Some("a Support/Newbot\"")
    );
    assert_eq!(r("Support/Oldbots"), None);
    assert_eq!(r("oldbot Oldbot"), None);
    assert_eq!(
        r("Support/Oldbot2 Support/Oldbot/").as_deref(),
        Some("Support/Oldbot2 Support/Newbot/")
    );
}

#[test]
fn the_live_brand_has_a_previous_identity_to_move_from() {
    // brand.json's `previous`: the layout exists, and old and new differ
    // everywhere a folder is named.
    if let Some(l) = super::layout() {
        assert_ne!(l.old.slug, l.new.slug);
        assert_ne!(l.old.app_dir_name, l.new.app_dir_name);
        assert_ne!(l.old.identifier, l.new.identifier);
    }
}
