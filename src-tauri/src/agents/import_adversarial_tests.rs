//! Exports and pasted replies that go wrong: every one ends in one plain
//! line that says the fix, never a parser's message alone and never
//! nothing; and no read is bigger or slower than its caps.

use super::*;
use std::time::Instant;

/// A line the user can act on: it names what to do next.
fn says_the_fix(line: &str) -> bool {
    [
        "Ask ",
        "Paste",
        "Pick ",
        "Send ",
        "Export again",
        "rename",
        "Answer ",
        "Delete ",
    ]
    .iter()
    .any(|w| line.contains(w))
}

fn only_problem(e: &Export) -> &str {
    assert_eq!(e.problems.len(), 1, "{:?}", e.problems);
    let p = &e.problems[0];
    assert!(says_the_fix(p), "no fix in: {p}");
    assert!(
        !p.contains("Error(") && !p.contains("column"),
        "raw parser text: {p}"
    );
    p
}

fn file(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

const ONE_AGENT: &str =
    r#"{"source":"Grok Bot","agents":[{"name":"Ledger","instructions":"Log expenses."}]}"#;

#[test]
fn an_empty_file_says_it_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    for body in ["", "   \n\t"] {
        let e = read_path(&file(dir.path(), "export.json", body.as_bytes()));
        assert!(only_problem(&e).starts_with("That file is empty."));
    }
}

#[test]
fn a_cut_off_file_says_so_and_how_to_get_it_whole() {
    let dir = tempfile::tempdir().unwrap();
    let e = read_path(&file(
        dir.path(),
        "export.json",
        &ONE_AGENT.as_bytes()[..40],
    ));
    assert!(only_problem(&e).contains("cut off"));
}

#[test]
fn a_binary_file_is_not_text() {
    let dir = tempfile::tempdir().unwrap();
    let e = read_path(&file(
        dir.path(),
        "export.json",
        &[0xff, 0xfe, 0x00, 0x9f, 0x92],
    ));
    assert!(only_problem(&e).starts_with("That file isn't text"));
}

#[test]
fn a_fake_zip_or_tar_says_which_and_what_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let z = read_path(&file(dir.path(), "export.zip", b"not a zip at all"));
    assert!(only_problem(&z).starts_with("That isn't a readable zip."));
    let t = read_path(&file(dir.path(), "export.tar.gz", b"not gzip"));
    let p = only_problem(&t);
    assert!(p.contains(".tar.gz"), "{p}");
}

#[test]
fn another_kind_of_file_names_what_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let e = read_path(&file(dir.path(), "export.json.gz", b"\x1f\x8b"));
    assert!(only_problem(&e).contains(".json, .zip, .tar.gz"));
    let gone = read_path(&dir.path().join("moved.json"));
    assert!(only_problem(&gone).contains("isn't there any more"));
}

#[test]
fn a_huge_file_is_refused_before_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("export.json");
    // 50 MB, sparse: refused on its size, in no time and no memory.
    let f = std::fs::File::create(&path).unwrap();
    f.set_len(50 * 1024 * 1024).unwrap();
    let started = Instant::now();
    let e = read_path(&path);
    assert!(only_problem(&e).contains("over 4 MB"));
    assert!(started.elapsed().as_secs() < 2);
}

#[cfg(unix)]
#[test]
fn a_link_to_a_huge_file_is_capped_by_what_is_read_not_the_links_size() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.bin");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(50 * 1024 * 1024)
        .unwrap();
    let link = dir.path().join("export.json");
    std::os::unix::fs::symlink(&big, &link).unwrap();
    let e = read_path(&link);
    assert!(only_problem(&e).contains("over 4 MB"), "{:?}", e.problems);
    // A link the user picked to a real export is followed.
    let real = file(dir.path(), "real.json", ONE_AGENT.as_bytes());
    let to_real = dir.path().join("picked.json");
    std::os::unix::fs::symlink(&real, &to_real).unwrap();
    let ok = read_path(&to_real);
    assert!(ok.problems.is_empty(), "{:?}", ok.problems);
    assert_eq!(ok.agents[0].name, "Ledger");
}

#[cfg(unix)]
#[test]
fn a_device_picked_as_an_export_is_never_read_forever() {
    // /dev/zero never ends; it isn't a file, so it isn't read at all.
    let e = read_path(Path::new("/dev/zero"));
    assert_eq!(e.problems.len(), 1, "{:?}", e.problems);
    assert!(says_the_fix(&e.problems[0]), "{:?}", e.problems);
}

#[test]
fn deeply_nested_json_is_said_plainly_and_never_overflows() {
    let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    let dir = tempfile::tempdir().unwrap();
    let e = read_path(&file(dir.path(), "export.json", deep.as_bytes()));
    assert!(only_problem(&e).contains("nested too deeply"));
    let pasted = read_text(&format!("```json\n{deep}\n```"));
    assert!(only_problem(&pasted).contains("nested too deeply"));
}

#[test]
fn wrong_types_everywhere_name_where_and_block_the_review() {
    let e = read_text(
        r#"```json
{"agents": [1, {"name": 5}, {"name": "A", "routines": "daily", "is_main": "yes", "memory": {"x": 1}}],
 "about_me": [], "parts": "two"}
```"#,
    );
    assert!(e.problems.len() >= 4, "{:?}", e.problems);
    for p in &e.problems {
        assert!(!p.contains("Error("), "{p}");
    }
    // The UI shows these behind one line (`PasteProblems`); the lines
    // themselves say where.
    assert!(e.problems.iter().any(|p| p.contains("\"routines\"")));
    let s = read_text(
        r#"```json
{"agents": "Ledger"}
```"#,
    );
    assert!(s.problems.iter().any(|p| p.contains("should be a list")));
}

#[test]
fn a_broken_openbot_manifest_reads_like_any_broken_json() {
    let files = crate::agents::import_formats::files_for_test(&[(
        "openbot-import.json",
        r#"{"format": "openbot-agent-import", "agents": [ }"#,
    )]);
    let mut e = Export::default();
    crate::agents::import_formats::read_files(&files, &mut e);
    let p = only_problem(&e);
    assert!(
        p.starts_with("openbot-import.json isn't valid JSON at line 1"),
        "{p}"
    );
}

#[test]
fn a_paste_over_the_cap_asks_for_parts() {
    let big = "a".repeat(2_000_001);
    let started = Instant::now();
    let e = read_text(&big);
    assert!(only_problem(&e).contains("Paste it in parts"));
    assert!(started.elapsed().as_secs() < 2);
}

#[test]
fn prose_with_no_json_says_to_paste_the_whole_reply() {
    let e = read_text("Sure, I run Ledger and Atlas for you. Want me to export them?");
    assert!(only_problem(&e).contains("```json"));
}

#[test]
fn parts_out_of_order_and_twice_merge_to_one_copy() {
    let p1 = r#"Here:
```json
{"source":"Grok Bot","part":1,"parts":2,"agents":[{"name":"Ledger","instructions":"Log expenses.","routines":[{"when":"every day at 9am","what":"check"}]}]}
```"#;
    let p2 = r#"```json
{"source":"Grok Bot","part":2,"parts":2,"agents":[{"name":"ledger","apps":["Sheets"]}],"complete":true}
```"#;
    let e = read_text(&format!("{p2}\n\n{p1}\n\n{p1}\nthanks!"));
    assert!(e.problems.is_empty(), "{:?}", e.problems);
    assert_eq!(e.agents.len(), 1);
    let a = &e.agents[0];
    assert_eq!(a.instructions, "Log expenses.");
    assert_eq!(a.routines.len(), 1);
    assert_eq!(a.apps.len(), 1);
    assert_eq!(e.parts_seen.len(), 2);
}

#[test]
fn lookalike_names_in_one_export_keep_the_first_and_say_how_to_get_the_other() {
    // Latin "Ledger" and one with a Cyrillic "е".
    let e = read_text(
        "```json\n{\"agents\":[{\"name\":\"Ledger\",\"instructions\":\"one\"},{\"name\":\"L\u{0435}dger\",\"instructions\":\"two\"}]}\n```",
    );
    assert!(e.problems.is_empty(), "{:?}", e.problems);
    let (review, refused, _) = to_review(&e, "Chief of Staff");
    assert_eq!(review.proposals.len(), 1);
    assert_eq!(refused.len(), 1);
    assert!(says_the_fix(&refused[0]), "{}", refused[0]);
}

#[test]
fn a_folder_of_ten_thousand_files_is_read_within_its_caps() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..10_000 {
        std::fs::write(dir.path().join(format!("note{i}.md")), "# a note\n").unwrap();
    }
    file(dir.path(), "export.json", ONE_AGENT.as_bytes());
    let started = Instant::now();
    let e = read_path(dir.path());
    assert!(started.elapsed().as_secs() < 20, "{:?}", started.elapsed());
    assert!(e.problems.is_empty(), "{:?}", e.problems);
    assert_eq!(e.agents.len(), 1);
}

#[cfg(unix)]
#[test]
fn links_in_a_folder_are_never_followed_and_are_said() {
    let outside = tempfile::tempdir().unwrap();
    let secret = file(outside.path(), "notes.json", ONE_AGENT.as_bytes());
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("export.json")).unwrap();
    // A loop.
    std::os::unix::fs::symlink(dir.path(), dir.path().join("again")).unwrap();
    let e = read_path(dir.path());
    assert!(e.agents.is_empty(), "read through a link: {:?}", e.agents);
    assert!(
        e.skipped
            .iter()
            .any(|s| s == "export.json (a link, not followed)"),
        "{:?}",
        e.skipped
    );
    assert_eq!(e.problems.len(), 1, "{:?}", e.problems);
    assert!(says_the_fix(&e.problems[0]));
}

fn pending_review(source: &str, talk_id: &str, review: Review) -> store::Approval {
    let mut card = crate::agents::mcp::new_card("r1".into(), "t".into(), String::new(), None);
    card.connector = Some(review::ConnectorCard {
        kind: review::CardKind::Review,
        talk_id: talk_id.into(),
        source: source.into(),
        review: Some(review),
        playback: None,
    });
    card
}

#[test]
fn the_same_export_twice_while_its_card_is_up_is_said_not_doubled() {
    let e = read_text(&format!("```json\n{ONE_AGENT}\n```"));
    let (review, _, _) = to_review(&e, "Chief of Staff");
    let up = [pending_review("Grok Bot", "export-1", review.clone())];
    assert!(already_waiting(&up, "Grok Bot", &review));
    assert!(already_waiting(&up, "grok bot", &review));
    // Another source, other agents, or a connector import's card: a new card.
    assert!(!already_waiting(&up, "Hermes", &review));
    let other = read_text(
        r#"```json
{"agents":[{"name":"Ledger","instructions":"Log expenses, and more."}]}
```"#,
    );
    let (changed, _, _) = to_review(&other, "Chief of Staff");
    assert!(!already_waiting(&up, "Grok Bot", &changed));
    let talk = [pending_review("Grok Bot", "talk-1", review.clone())];
    assert!(!already_waiting(&talk, "Grok Bot", &review));
    assert!(!already_waiting(&[], "Grok Bot", &review));
}
