//! A living page per conversation (child of page.rs): validation, patches
//! by block id, history, storage beside the log.
use super::*;
use serde_json::json;

fn table(id: &str, rows: Value) -> Value {
    json!({ "id": id, "kind": "table", "title": "Applications", "columns": ["Company", "Stage"], "rows": rows })
}

fn checklist(id: &str, done: bool) -> Value {
    json!({ "id": id, "kind": "checklist", "items": [{ "text": "Send the portfolio", "done": done }] })
}

fn up(args: Value) -> Update {
    parse(&args).unwrap()
}

fn first(args: Value) -> PageFile {
    apply(None, "first", &up(args), 1_000, false)
        .unwrap()
        .unwrap()
}

#[test]
fn a_page_block_is_a_show_block_with_an_id() {
    let u = up(json!({
        "title": "Job search",
        "blocks": [table("apps", json!([["Acme", "Applied"]])), checklist("next", false)],
        "note": "Started tracking"
    }));
    assert_eq!(u.title.as_deref(), Some("Job search"));
    assert_eq!(u.set.len(), 2);
    assert_eq!(u.set[0]["id"], "apps");
    assert_eq!(u.set[0]["kind"], "table");
    // Filled in exactly as `show` fills it: a summary for older clients.
    assert!(u.set[0]["summary"].as_str().unwrap().contains("Acme"));
    assert!(!u.is_read());
    assert!(up(json!({})).is_read());
}

#[test]
fn every_block_is_checked_as_show_checks_it() {
    let refused = |args: Value| parse(&args).unwrap_err();
    // No id, a bad id, the same id twice.
    assert!(
        refused(json!({ "blocks": [{ "kind": "callout", "text": "Hi" }] }))
            .contains("needs an `id`")
    );
    assert!(refused(
        json!({ "blocks": [{ "id": "Has Spaces", "kind": "callout", "text": "Hi" }] })
    )
    .contains("needs an `id`"));
    assert!(
        refused(json!({ "blocks": [checklist("a", false), checklist("a", true)] }))
            .contains("given twice")
    );
    // Nothing on a page answers, and images aren't kept here.
    for kind in ["choices", "comparison", "form", "image"] {
        let e = refused(json!({ "blocks": [{ "id": "x", "kind": kind }] }));
        assert!(e.contains("can't go on a page"), "{kind}: {e}");
    }
    // HTML, a bad link, an unknown kind: `blocks::parse`'s own refusals, at the right index.
    let e = refused(
        json!({ "blocks": [checklist("ok", false), { "id": "x", "kind": "callout", "text": "<b>hi</b>" }] }),
    );
    assert!(e.starts_with("blocks[1]"), "{e}");
    let e = refused(
        json!({ "blocks": [{ "id": "x", "kind": "links", "items": [{ "url": "javascript:alert(1)" }] }] }),
    );
    assert!(e.contains("blocks[0]"), "{e}");
    assert!(
        refused(json!({ "blocks": [{ "id": "x", "kind": "pyramid" }] })).contains("no \"pyramid\"")
    );
    // HTML in the title, too.
    assert!(
        refused(json!({ "title": "<script>x</script>", "blocks": [checklist("a", false)] }))
            .contains("no HTML")
    );
    // Too many blocks for a page.
    let many: Vec<Value> = (0..13)
        .map(|i| checklist(&format!("c{i}"), false))
        .collect();
    assert!(refused(json!({ "blocks": many })).contains("at most 12"));
    // Set and removed at once.
    assert!(
        refused(json!({ "blocks": [checklist("a", false)], "remove": ["a"] }))
            .contains("both set and removed")
    );
}

#[test]
fn nothing_that_looks_like_a_secret_goes_on_a_page() {
    let key = format!("sk-ant-{}", "a1".repeat(20));
    let e = parse(&json!({ "blocks": [{ "id": "k", "kind": "facts", "items": [{ "label": "API key", "value": key }] }] })).unwrap_err();
    assert!(e.contains("Never put secrets on a page"), "{e}");
    let e = parse(
        &json!({ "blocks": [{ "id": "k", "kind": "callout", "text": "password: hunter22" }] }),
    )
    .unwrap_err();
    assert!(e.contains("Never put secrets"), "{e}");
    let e = parse(&json!({ "title": format!("Keys {key}"), "blocks": [checklist("a", false)] }))
        .unwrap_err();
    assert!(e.contains("secrets"), "{e}");
}

#[test]
fn a_new_page_is_pinned_version_one_with_every_block_added() {
    let f = first(
        json!({ "title": "Job search", "blocks": [table("apps", json!([["Acme", "Applied"]]))] }),
    );
    assert!(f.pinned);
    assert_eq!(f.conversation, "first");
    let v = f.current().unwrap();
    assert_eq!(v.version, 1);
    assert_eq!(v.changes.added, vec!["apps"]);
    // A new page needs a title and a block.
    let e = apply(
        None,
        "first",
        &up(json!({ "blocks": [checklist("a", false)] })),
        1,
        false,
    )
    .unwrap_err();
    assert!(e.contains("needs a `title`"));
    let e = apply(None, "first", &up(json!({ "title": "T" })), 1, false).unwrap_err();
    assert!(e.contains("at least one block"));
}

#[test]
fn an_update_patches_by_id_and_keeps_the_version_before() {
    let f = first(json!({
        "title": "Job search",
        "blocks": [table("apps", json!([["Acme", "Applied"]])), checklist("next", false)]
    }));
    // Replace one block by id, add a new one at the end, keep the rest.
    let g = apply(
        Some(&f),
        "first",
        &up(json!({
            "blocks": [table("apps", json!([["Acme", "Interviewing"]])), { "id": "budget", "kind": "metrics", "items": [{ "label": "Saved", "value": 1200, "prefix": "$" }] }],
            "note": "Acme moved to interviewing"
        })),
        2_000,
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(g.versions.len(), 2);
    let v = g.current().unwrap();
    assert_eq!(v.version, 2);
    assert!(v.by_routine);
    assert_eq!(v.note.as_deref(), Some("Acme moved to interviewing"));
    let ids: Vec<&str> = v.items.iter().map(|b| b["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["apps", "next", "budget"]);
    assert_eq!(v.changes.changed, vec!["apps"]);
    assert_eq!(v.changes.added, vec!["budget"]);
    assert!(v.changes.removed.is_empty());
    // The version before is kept as it was.
    assert_eq!(g.versions[0], f.versions[0]);
    assert_eq!(change_words(&v.changes), "added budget; changed apps");

    // Remove by id; an unknown id is refused and names what's there.
    let h = apply(
        Some(&g),
        "first",
        &up(json!({ "remove": ["next"] })),
        3_000,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(h.current().unwrap().changes.removed, vec!["next"]);
    let e = apply(
        Some(&g),
        "first",
        &up(json!({ "remove": ["nope"] })),
        3_000,
        false,
    )
    .unwrap_err();
    assert!(
        e.contains("No block \"nope\"") && e.contains("apps, next, budget"),
        "{e}"
    );

    // Removing everything is refused: unpinning is the user's.
    let e = apply(
        Some(&h),
        "first",
        &up(json!({ "remove": ["apps", "budget"] })),
        4_000,
        false,
    )
    .unwrap_err();
    assert!(e.contains("empty"));

    // `replace` makes the given blocks the whole page, in that order.
    let r = apply(
        Some(&h),
        "first",
        &up(json!({ "replace": true, "title": "Hunt", "blocks": [checklist("next", true)] })),
        5_000,
        false,
    )
    .unwrap()
    .unwrap();
    let c = &r.current().unwrap().changes;
    assert!(c.retitled);
    assert_eq!(c.added, vec!["next"]);
    assert_eq!(c.removed, vec!["apps", "budget"]);
}

#[test]
fn an_update_that_changes_nothing_makes_no_version() {
    let f = first(json!({ "title": "Reading list", "blocks": [checklist("books", false)] }));
    let same = apply(
        Some(&f),
        "first",
        &up(json!({ "blocks": [checklist("books", false)] })),
        9,
        false,
    )
    .unwrap();
    assert!(same.is_none());
    // Only the order changing is a change.
    let two =
        first(json!({ "title": "R", "blocks": [checklist("a", false), checklist("b", false)] }));
    let swapped = apply(
        Some(&two),
        "first",
        &up(json!({ "replace": true, "blocks": [checklist("b", false), checklist("a", false)] })),
        9,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(swapped.current().unwrap().changes.changed, vec!["b", "a"]);
}

#[test]
fn history_is_capped_oldest_first_and_versions_keep_counting() {
    let mut f = first(json!({ "title": "Budget", "blocks": [checklist("a", false)] }));
    for i in 0..(MAX_HISTORY + 5) {
        let done = i % 2 == 0;
        f = apply(
            Some(&f),
            "first",
            &up(json!({ "blocks": [checklist("a", done)], "note": format!("step {i}") })),
            i as i64,
            false,
        )
        .unwrap()
        .unwrap();
    }
    assert_eq!(f.versions.len(), MAX_HISTORY);
    assert_eq!(f.current().unwrap().version, MAX_HISTORY as u32 + 6);
    assert_eq!(f.versions[0].version, 7);
}

#[test]
fn a_page_too_big_is_refused_not_trimmed() {
    let rows: Vec<Value> = (0..200)
        .map(|i| json!([format!("{i} {}", "x".repeat(200)), "Applied"]))
        .collect();
    let blocks: Vec<Value> = (0..3)
        .map(|i| table(&format!("t{i}"), json!(rows)))
        .collect();
    let u = parse(&json!({ "title": "Big", "blocks": blocks }));
    // Each block passes `show`'s own cap; the page as a whole doesn't.
    match u {
        Ok(u) => {
            let e = apply(None, "first", &u, 1, false).unwrap_err();
            assert!(e.contains("KB"), "{e}");
        }
        Err(e) => assert!(e.contains("KB"), "{e}"),
    }
}

#[test]
fn stored_beside_the_log_one_file_per_conversation_never_in_messages() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let a = store::create(store::NewAgent {
        name: "Scout".into(),
        role: "Tracks things".into(),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let home = store::agent_home(&a.id).unwrap();
    let log_before = std::fs::read_to_string(home.join("messages.jsonl")).unwrap_or_default();

    assert!(get(&a.id, "first").unwrap().is_none());
    assert!(turn_note(&a.id, "first").is_empty());
    let (f, changed) = update(
        &a.id,
        "first",
        &up(json!({ "title": "Job search", "blocks": [checklist("next", false)] })),
        false,
    )
    .unwrap();
    assert!(changed);
    assert!(home.join("pages/first.json").exists());
    assert!(receipt(&f, true).contains("Made the page \"Job search\" (v1)"));
    // Another conversation has its own page (none yet).
    assert!(get(&a.id, "c2").unwrap().is_none());
    // The chat log is untouched.
    assert_eq!(
        std::fs::read_to_string(home.join("messages.jsonl")).unwrap_or_default(),
        log_before
    );

    let (_, changed) = update(
        &a.id,
        "first",
        &up(json!({ "blocks": [checklist("next", true)] })),
        true,
    )
    .unwrap();
    assert!(changed);
    let (same, changed) = update(
        &a.id,
        "first",
        &up(json!({ "blocks": [checklist("next", true)] })),
        true,
    )
    .unwrap();
    assert!(!changed);
    assert!(receipt(&same, false).contains("Nothing changed"));

    let view = get(&a.id, "first").unwrap().unwrap();
    assert_eq!(view.current.version, 2);
    assert!(view.pinned);
    assert_eq!(
        view.history.iter().map(|h| h.version).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert_eq!(view.current.blocks["v"], 1);
    assert_eq!(view.current.blocks["items"][0]["id"], "next");
    let wire = serde_json::to_value(&view).unwrap();
    assert_eq!(wire["agentId"], a.id.as_str());
    assert!(wire["at"].is_i64());
    assert!(
        version(&a.id, "first", 1).unwrap().unwrap().blocks["items"][0]["items"][0]["done"]
            == false
    );
    assert!(version(&a.id, "first", 9).unwrap().is_none());

    // The user unpins it: updates keep it unpinned, and say so.
    assert!(!set_pinned(&a.id, "first", false).unwrap().unwrap().pinned);
    let (f, _) = update(&a.id, "first", &up(json!({ "title": "Hunt" })), false).unwrap();
    assert!(!f.pinned);
    assert!(receipt(&f, true).contains("unpinned it"));
    assert!(for_agent(Some(&f)).contains("unpinned by the user"));
    assert!(turn_note(&a.id, "first").contains("\"Hunt\" (v3; blocks next)"));

    // Ids that would leave the folder are refused.
    assert!(get(&a.id, "../x").is_err());
    assert!(set_pinned(&a.id, "a/b", true).is_err());
    store::set_root_for_tests(None);
}

#[test]
fn the_card_and_the_agents_read_say_what_it_is() {
    let f = first(
        json!({ "title": "Job search", "blocks": [checklist("next", false)], "note": "Started" }),
    );
    let (title, detail) = card(None, &f);
    assert_eq!(title, "Pin a page to this conversation?");
    assert!(detail.contains("\"Job search\", v1: added next.") && detail.contains("Started"));
    let g = apply(
        Some(&f),
        "first",
        &up(json!({ "blocks": [checklist("next", true)] })),
        2,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(card(Some(&f), &g).0, "Update this conversation's page?");
    assert!(for_agent(Some(&g)).contains("\"id\":\"next\""));
    assert!(for_agent(None).contains("no page yet"));
}

#[test]
fn a_fork_gets_the_page_as_it_was_then_or_none() {
    let mut f = first(json!({ "title": "Budget", "blocks": [checklist("a", false)] }));
    f.versions[0].at = 1_000;
    let g = apply(
        Some(&f),
        "first",
        &up(json!({ "blocks": [checklist("a", true)] })),
        5_000,
        false,
    )
    .unwrap()
    .unwrap();
    // Before the page existed: none.
    assert!(as_of(&g, "c9", 500).is_none());
    // Between v1 and v2: v1, in the new conversation, its history cut there.
    let then = as_of(&g, "c9", 3_000).unwrap();
    assert_eq!(then.conversation, "c9");
    assert_eq!(then.current().unwrap().version, 1);
    assert_eq!(then.versions.len(), 1);
    // After both: the page as it is.
    assert_eq!(
        as_of(&g, "c9", 9_000).unwrap().current().unwrap().version,
        2
    );
}

#[test]
fn a_routine_s_version_names_the_routine_and_only_a_routine_s() {
    let f = first(json!({ "title": "Budget", "blocks": [checklist("a", false)] }));
    let mut u = up(json!({ "blocks": [checklist("a", true)] }));
    u.routine = Some("Evening budget check".into());
    let g = apply(Some(&f), "first", &u, 2_000, true).unwrap().unwrap();
    assert_eq!(
        g.current().unwrap().routine.as_deref(),
        Some("Evening budget check")
    );
    let shown = view("a1", &g).unwrap();
    assert_eq!(
        serde_json::to_value(&shown.history[0]).unwrap()["routine"],
        "Evening budget check"
    );
    // Not a routine's turn: no name, whatever was passed.
    let h = apply(Some(&f), "first", &u, 2_000, false).unwrap().unwrap();
    assert!(h.current().unwrap().routine.is_none());
    assert!(serde_json::to_value(&view("a1", &h).unwrap().history[0])
        .unwrap()
        .get("routine")
        .is_none());
}
