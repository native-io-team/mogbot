//! `team_record`: the incremental index, ranking, caps, privacy and outside text.

use super::store;
use super::team_record::*;
use serde_json::{json, Value};
use std::io::Write;

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;

fn line(v: Value) -> String {
    format!("{v}\n")
}

fn result_line(id: &str, card: &str, ts: i64, title: &str, summary: &str) -> String {
    line(json!({
        "id": id, "agentId": "a", "ts": ts, "kind": "agent", "text": "Here it is.",
        "result": { "id": card, "version": 1, "title": title, "summary": summary,
                    "checked": ["Totals tie to the ledger"], "notVerified": ["VAT"] }
    }))
}

fn reply_line(id: &str, ts: i64, text: &str) -> String {
    line(json!({ "id": id, "agentId": "a", "ts": ts, "kind": "agent", "text": text }))
}

fn user_line(id: &str, ts: i64, text: &str) -> String {
    line(json!({ "id": id, "agentId": "a", "ts": ts, "kind": "user", "text": text }))
}

fn card_line(id: &str, request: &str, ts: i64, title: &str, detail: &str, extra: Value) -> String {
    let mut approval =
        json!({ "requestId": request, "title": title, "detail": detail, "status": "pending" });
    if let (Value::Object(a), Value::Object(e)) = (&mut approval, extra) {
        a.extend(e);
    }
    line(json!({ "id": id, "agentId": "a", "ts": ts, "kind": "approval", "approval": approval }))
}

fn answer_line(request: &str, status: &str, note: Option<&str>) -> String {
    line(json!({ "requestId": request, "status": status, "note": note }))
}

fn append(path: &std::path::Path, text: &str) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(text.as_bytes()).unwrap();
}

fn entry(kind: Kind, title: &str, body: &str, ts: i64) -> Entry {
    Entry {
        agent_id: "a".into(),
        ts,
        kind,
        title: title.into(),
        body: body.into(),
        message_id: Some("m1".into()),
        outside: false,
    }
}

const ALL: Rights = Rights {
    chats: true,
    outside_turn: false,
};
const PLAIN: Rights = Rights {
    chats: false,
    outside_turn: false,
};

fn ask(q: &str) -> Ask {
    Ask {
        query: q.into(),
        ..Ask::default()
    }
}

/* ------------------------------------------------------------------ index */

#[test]
fn the_index_reads_only_what_was_added() {
    let home = tempfile::tempdir().unwrap();
    let log = home.path().join("messages.jsonl");
    append(
        &log,
        &result_line("m1", "r1", NOW - HOUR, "Q3 summary", "Revenue up 12%."),
    );
    append(
        &log,
        &reply_line("m2", NOW - HOUR, "Done, the Q3 summary is on the card."),
    );
    let mut index = AgentIndex::default();
    index.refresh("a", home.path());
    assert_eq!(index.results.len(), 1);
    assert_eq!(index.replies.len(), 1);
    let r = &index.results[0];
    assert_eq!(r.title, "Q3 summary");
    assert!(r.body.contains("Revenue up 12%."));
    assert!(r
        .body
        .contains("It says it checked: Totals tie to the ledger."));
    assert!(r.body.contains("Not verified: VAT."));

    // Nothing new: nothing read twice.
    index.refresh("a", home.path());
    assert_eq!(index.replies.len(), 1);

    // A line still being written waits for its newline.
    let next = reply_line("m3", NOW, "A second reply.");
    let (half, rest) = next.split_at(20);
    append(&log, half);
    index.refresh("a", home.path());
    assert_eq!(index.replies.len(), 1);
    append(&log, rest);
    index.refresh("a", home.path());
    assert_eq!(index.replies.len(), 2);
    assert_eq!(index.replies[1].message_id.as_deref(), Some("m3"));
}

#[test]
fn a_rewritten_log_is_read_again() {
    let home = tempfile::tempdir().unwrap();
    let log = home.path().join("messages.jsonl");
    append(&log, &reply_line("m1", NOW, "First."));
    let mut index = AgentIndex::default();
    index.refresh("a", home.path());
    assert_eq!(index.replies.len(), 1);
    // A block put in front (an import's history) changes the first bytes.
    let old = std::fs::read_to_string(&log).unwrap();
    std::fs::write(&log, reply_line("m0", NOW - HOUR, "Imported.") + &old).unwrap();
    index.refresh("a", home.path());
    let ids: Vec<_> = index
        .replies
        .iter()
        .map(|e| e.message_id.clone().unwrap())
        .collect();
    assert_eq!(ids, ["m0", "m1"]);
    // Shorter than read: started over, not doubled.
    std::fs::write(&log, reply_line("z", NOW, "Only.")).unwrap();
    index.refresh("a", home.path());
    assert_eq!(index.replies.len(), 1);
}

#[test]
fn a_first_read_takes_only_the_tail_and_starts_on_a_whole_line() {
    let home = tempfile::tempdir().unwrap();
    let log = home.path().join("messages.jsonl");
    let filler = reply_line("old", NOW - 400 * HOUR, &"x".repeat(1_000));
    let mut big = String::new();
    while (big.len() as u64) < TAIL_BYTES + 50_000 {
        big.push_str(&filler);
    }
    big.push_str(&result_line("new", "r9", NOW, "Fresh result", "It's new."));
    std::fs::write(&log, big).unwrap();
    let mut index = AgentIndex::default();
    index.refresh("a", home.path());
    assert_eq!(index.results.len(), 1);
    // Bounded per agent, whatever the log holds.
    assert_eq!(index.replies.len(), KEEP_REPLIES);
}

#[test]
fn a_revised_result_replaces_its_earlier_version() {
    let mut index = AgentIndex::default();
    index.ingest_messages("a", &result_line("m1", "r1", NOW - HOUR, "Draft", "v1"));
    index.ingest_messages("a", &result_line("m2", "r1", NOW, "Draft v2", "v2"));
    assert_eq!(index.results.len(), 1);
    assert_eq!(index.last_result().unwrap().title, "Draft v2");
}

#[test]
fn decisions_are_allow_and_deny_only_and_secret_cards_give_only_their_title() {
    let home = tempfile::tempdir().unwrap();
    let log = home.path().join("messages.jsonl");
    append(
        &log,
        &card_line(
            "c1",
            "q1",
            NOW,
            "Post to LinkedIn",
            "Post the launch note",
            json!({}),
        ),
    );
    append(
        &log,
        &card_line(
            "c2",
            "q2",
            NOW,
            "Push to main",
            "git push origin main",
            json!({}),
        ),
    );
    append(
        &log,
        &card_line("c3", "q3", NOW, "Run a command", "npm test", json!({})),
    );
    append(
        &log,
        &card_line(
            "c4",
            "q4",
            NOW,
            "Save your Stripe key",
            "sk_live_shown_nowhere",
            json!({ "secret": { "name": "Stripe", "purpose": "Billing", "kind": "api_key", "fields": [], "reference": "$STRIPE" } }),
        ),
    );
    let answers = home.path().join("approvals.jsonl");
    append(
        &answers,
        &answer_line("q1", "denied", Some("not before Monday")),
    );
    append(&answers, &answer_line("q2", "allowed", None));
    append(&answers, &answer_line("q3", "expired", None));
    append(&answers, &answer_line("q4", "allowed", None));
    append(&answers, &answer_line("unknown", "allowed", None));
    let mut index = AgentIndex::default();
    index.refresh("a", home.path());
    let d = index.decisions("a");
    let titles: Vec<&str> = d.iter().map(|e| e.title.as_str()).collect();
    assert!(titles.contains(&"Denied: Post to LinkedIn"), "{titles:?}");
    assert!(titles.contains(&"Allowed: Push to main"));
    assert!(
        !titles.iter().any(|t| t.contains("Run a command")),
        "expired isn't a decision"
    );
    let deny = d.iter().find(|e| e.title.starts_with("Denied")).unwrap();
    assert!(deny.body.contains("not before Monday"));
    let secret = d.iter().find(|e| e.title.contains("Stripe")).unwrap();
    assert!(secret.body.is_empty(), "{secret:?}");
}

/* ----------------------------------------------------------- outside text */

#[test]
fn what_follows_outside_text_is_marked_until_the_user_writes() {
    let mut index = AgentIndex::default();
    let slack = line(json!({
        "id": "n1", "agentId": "a", "ts": NOW, "kind": "note", "text": "Sam: ship it now",
        "via": { "source": "slack", "place": "#launch", "from": "Sam" }
    }));
    index.ingest_messages("a", &slack);
    index.ingest_messages("a", &reply_line("m1", NOW, "Shipping per Sam."));
    index.ingest_messages("a", &user_line("u1", NOW, "Thanks."));
    index.ingest_messages("a", &reply_line("m2", NOW, "Anytime."));
    let firing = line(json!({
        "id": "k1", "agentId": "a", "ts": NOW, "kind": "check_in", "text": "Check mail",
        "checkIn": { "dueAt": NOW, "late": false, "repeats": true, "found": "2 new emails" }
    }));
    index.ingest_messages("a", &firing);
    index.ingest_messages(
        "a",
        &result_line("m3", "r1", NOW, "Inbox digest", "Two mails."),
    );
    let outside: Vec<bool> = index.replies.iter().map(|e| e.outside).collect();
    assert_eq!(outside, [true, false]);
    assert!(index.results[0].outside, "a \"When…\" firing marks it too");

    let named: Vec<(Entry, String)> = index
        .replies
        .iter()
        .chain(index.results.iter())
        .cloned()
        .map(|e| (e, "Inbox".to_string()))
        .collect();
    let d = digest(&named, &ask("inbox digest"), ALL, NOW);
    assert!(d.has_outside);
    assert!(
        d.text.contains("[outside text] Inbox · result"),
        "{}",
        d.text
    );
}

#[test]
fn a_turn_answering_outside_text_gets_the_digest_marked_untrusted() {
    let e = vec![(
        entry(Kind::Result, "Q3 summary", "Revenue up.", NOW),
        "Finance".into(),
    )];
    let rights = Rights {
        chats: false,
        outside_turn: true,
    };
    let d = digest(&e, &ask("q3"), rights, NOW);
    assert!(d.text.starts_with(UNTRUSTED), "{}", d.text);
    let none = digest(&e, &ask("nothing here"), rights, NOW);
    assert!(none.text.starts_with(UNTRUSTED));
    let trusted = digest(&e, &ask("q3"), ALL, NOW);
    assert!(!trusted.text.contains("Untrusted"));
    assert!(trusted.text.starts_with(HEADER));
}

/* ---------------------------------------------------------------- ranking */

#[test]
fn results_rank_above_replies_and_titles_above_bodies() {
    let e = vec![
        (
            entry(Kind::Reply, "", "the q3 summary is coming", NOW),
            "Finance".into(),
        ),
        (
            entry(
                Kind::Result,
                "Q3 summary",
                "Revenue up 12%.",
                NOW - 3 * HOUR,
            ),
            "Finance".into(),
        ),
        (
            entry(Kind::Result, "Weekly notes", "mentions the q3 summary", NOW),
            "Ops".into(),
        ),
    ];
    let d = digest(&e, &ask("Q3 summary"), ALL, NOW);
    let first = d.text.lines().nth(1).unwrap();
    assert!(first.contains("\"Q3 summary\""), "{}", d.text);
    assert!(first.contains("[Finance's result m1]"), "cited: {first}");
    assert_eq!(d.headline.as_deref(), Some("Finance's Q3 summary"));
    let reply_at = d.text.find("· reply ·").unwrap();
    let notes_at = d.text.find("Weekly notes").unwrap();
    assert!(notes_at < reply_at, "{}", d.text);
}

#[test]
fn stop_words_are_ignored_and_a_teammates_name_counts() {
    assert_eq!(
        terms("what did we find about the Q3 revenue?"),
        ["find", "q3", "revenue"]
    );
    assert_eq!(terms("the"), ["the"]);
    let e = entry(Kind::Result, "Revenue", "Up 12%.", NOW);
    assert!(score(&e, "Finance", &terms("finance revenue"), NOW).is_some());
    assert!(score(&e, "Finance", &terms("hiring"), NOW).is_none());
    // Three words or more: two must match.
    assert!(score(&e, "Ops", &terms("revenue hiring payroll"), NOW).is_none());
    assert!(score(&e, "Finance", &terms("revenue finance payroll"), NOW).is_some());
    // Fresher wins a tie.
    let old = entry(Kind::Result, "Revenue", "Up 12%.", NOW - 40 * 24 * HOUR);
    assert!(score(&e, "F", &terms("revenue"), NOW) > score(&old, "F", &terms("revenue"), NOW));
}

#[test]
fn since_reads_the_shapes_it_promises() {
    assert_eq!(parse_since("24h", NOW).unwrap(), NOW - 24 * HOUR);
    assert_eq!(parse_since("3d", NOW).unwrap(), NOW - 72 * HOUR);
    assert_eq!(parse_since("2w", NOW).unwrap(), NOW - 14 * 24 * HOUR);
    assert!(parse_since("today", NOW).unwrap() <= NOW);
    assert!(parse_since("yesterday", NOW).unwrap() < parse_since("today", NOW).unwrap());
    assert!(parse_since("2026-11-01", NOW).is_ok());
    assert!(parse_since("soonish", NOW)
        .unwrap_err()
        .contains("isn't a time"));

    let e = vec![
        (
            entry(Kind::Result, "Old report", "", NOW - 10 * 24 * HOUR),
            "A".into(),
        ),
        (
            entry(Kind::Result, "New report", "", NOW - HOUR),
            "A".into(),
        ),
    ];
    let d = digest(
        &e,
        &Ask {
            query: "report".into(),
            agent: None,
            since: Some(NOW - 24 * HOUR),
        },
        ALL,
        NOW,
    );
    assert!(
        d.text.contains("New report") && !d.text.contains("Old report"),
        "{}",
        d.text
    );
}

/* ------------------------------------------------------------------- caps */

#[test]
fn the_digest_never_passes_its_cap() {
    let e: Vec<(Entry, String)> = (0..200)
        .map(|i| {
            (
                entry(
                    Kind::Result,
                    &format!("Report {i}"),
                    &"report body ".repeat(80),
                    NOW - i,
                ),
                format!("Agent {i}"),
            )
        })
        .collect();
    let d = digest(&e, &ask("report"), ALL, NOW);
    assert!(
        d.text.chars().count() <= DIGEST_CAP,
        "{}",
        d.text.chars().count()
    );
    assert!(
        d.text.contains("more: narrow it with `agent` or `since`"),
        "{}",
        d.text
    );
    for l in d.text.lines().skip(1) {
        assert!(l.chars().count() <= 361, "{l}");
    }
}

#[test]
fn the_roster_stays_tiny() {
    let members: Vec<Member> = (0..40)
        .map(|i| Member {
            name: format!("Agent number {i}"),
            role: "Keeps the books, chases invoices, files receipts and reconciles every account each week".into(),
            last_result: (i % 2 == 0).then(|| ("A long result title that goes on and on and on".to_string(), NOW - i as i64 * 24 * HOUR)),
            last_activity: NOW,
        })
        .collect();
    let r = roster(&members, true, NOW).unwrap();
    assert!(r.chars().count() <= ROSTER_CAP, "{}", r.chars().count());
    assert!(r.contains("(list_agents)"), "{r}");
    // A role is at most eight words.
    assert!(
        r.contains(": Keeps the books, chases invoices, files receipts and…"),
        "{r}"
    );
    // Freshest result first.
    assert!(r.lines().nth(3).unwrap().contains("Agent number 0:"), "{r}");
    assert!(r.contains("today"));

    let chief = roster(&members[..2], false, NOW).unwrap();
    assert!(
        !chief.contains("Keeps the books"),
        "the Chief's team section has roles"
    );
    assert!(chief.contains("no results yet"));
    assert_eq!(roster(&[], true, NOW), None);
}

#[test]
fn ages_are_coarse_so_the_briefing_stays_put() {
    assert_eq!(age(NOW - 60_000, NOW), "today");
    assert_eq!(age(NOW - 3 * 24 * HOUR, NOW), "3 days ago");
    assert_eq!(age(NOW - 15 * 24 * HOUR, NOW), "2 weeks ago");
    assert_eq!(age(NOW - 90 * 24 * HOUR, NOW), "over a month ago");
}

/* ---------------------------------------------------------------- privacy */

#[test]
fn chats_and_memory_are_withheld_without_the_right_and_counted() {
    let e = vec![
        (
            entry(Kind::Reply, "", "the truck is an F150", NOW),
            "Car".into(),
        ),
        (
            entry(Kind::Memory, "", "Truck: F150, tow hitch fitted", 0),
            "Car".into(),
        ),
        (
            entry(Kind::Result, "Truck service plan", "F150 service due", NOW),
            "Car".into(),
        ),
    ];
    let plain = digest(&e, &ask("f150"), PLAIN, NOW);
    assert!(!plain.text.contains("tow hitch"), "{}", plain.text);
    assert!(!plain.text.contains("the truck is an F150"));
    assert!(plain.text.contains("Truck service plan"));
    assert!(
        plain
            .text
            .contains("2 more in teammates' chats or memory aren't open to you"),
        "{}",
        plain.text
    );
    let open = digest(&e, &ask("f150"), ALL, NOW);
    assert!(open.text.contains("tow hitch") && !open.text.contains("aren't open"));
    // Only withheld matches: said so, not "nothing".
    let only = digest(&e[..2], &ask("hitch"), PLAIN, NOW);
    assert!(
        only.text.contains("1 more in teammates' chats"),
        "{}",
        only.text
    );
    assert_eq!(only.headline, None);
}

#[test]
fn a_known_secret_never_leaves_in_a_digest() {
    let secret = "tr-team-record-secret-0f9e8d7c6b5a";
    super::secrets::remember_external(secret, "the test token");
    let e = vec![(
        entry(
            Kind::Result,
            "Deploy notes",
            &format!("used token {secret}"),
            NOW,
        ),
        "Ops".into(),
    )];
    let d = digest(&e, &ask("deploy"), ALL, NOW);
    super::secrets::forget_external(secret);
    assert!(!d.text.contains(secret), "{}", d.text);
}

#[test]
fn apps_are_named_never_their_account() {
    let conn: super::connections::Connection = serde_json::from_value(json!({
        "id": "c1", "service": "gmail", "title": "Gmail", "account": "sam@private.example",
        "kind": { "type": "gh" }, "serverKey": "gmail_1", "createdAt": NOW,
        "grants": [{ "agentId": "a1", "access": "read", "grantedAt": NOW }]
    }))
    .unwrap();
    let agent: store::Agent = serde_json::from_value(json!({
        "id": "a1", "name": "Inbox", "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap();
    let e = login_entries_from(&[conn], &[agent]);
    assert_eq!(e.len(), 1);
    let all = format!("{} {}", e[0].title, e[0].body);
    assert!(
        all.contains("Gmail") && all.contains("Used by Inbox"),
        "{all}"
    );
    assert!(!all.contains("sam@private.example"));
}

/* --------------------------------------------------------- the whole tool */

#[test]
fn an_agent_finds_a_teammates_result_and_the_roster_names_it() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    reset_for_tests();
    let new = |name: &str| {
        store::create(store::NewAgent {
            name: name.into(),
            role: format!("{name} work"),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap()
    };
    let finance = new("Finance");
    let writer = new("Writer");
    let hidden = new("Secret Squirrel");
    store::update(&hidden.id, |a| a.hidden = true).unwrap();
    let card: super::results::ResultCard = serde_json::from_value(json!({
        "id": "res1", "version": 1, "title": "Q3 summary",
        "summary": "Revenue £1.2m, up 12% on Q2.", "checked": ["Totals tie to the ledger"]
    }))
    .unwrap();
    let mut m = super::runner::new_message(&finance.id, store::MessageKind::Agent, "Here's Q3.");
    m.result = Some(card);
    store::append_message(&m).unwrap();
    let mut h = super::runner::new_message(&hidden.id, store::MessageKind::Agent, "q3 squirrel");
    h.result = Some(
        serde_json::from_value(json!({"id": "res2", "version": 1, "title": "Q3 squirrel"}))
            .unwrap(),
    );
    store::append_message(&h).unwrap();

    let found = lookup(&writer, &json!({ "query": "Q3 revenue" }), PLAIN).unwrap();
    assert!(found.text.contains("Finance · result"), "{}", found.text);
    assert!(found.text.contains("Revenue £1.2m"));
    assert!(found.text.contains("[Finance's result res1]"));
    assert!(
        !found.text.contains("squirrel"),
        "hidden agents are left out"
    );
    assert_eq!(found.headline.as_deref(), Some("Finance's Q3 summary"));

    // Its own work isn't "the team".
    let own = lookup(&finance, &json!({ "query": "Q3" }), ALL).unwrap();
    assert!(!own.text.contains("Finance · result"), "{}", own.text);
    // One teammate, by name; an unknown one is said so.
    assert!(lookup(&writer, &json!({ "agent": "finance" }), PLAIN)
        .unwrap()
        .text
        .contains("Q3 summary"));
    assert!(lookup(&writer, &json!({ "agent": "Nobody" }), PLAIN).is_err());
    assert!(lookup(&writer, &json!({}), PLAIN).is_err());

    let roster = roster_for(&writer).unwrap();
    assert!(
        roster.contains("- Finance: Finance work · \"Q3 summary\", today"),
        "{roster}"
    );
    assert!(!roster.contains("Squirrel"));
    assert!(!roster.contains("- Writer"), "not itself");

    store::set_root_for_tests(None);
    reset_for_tests();
}
