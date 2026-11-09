//! A long chat (5,000 lines with cards, timelines, attachments and code)
//! paged the way the desk and the phone page it: the newest page first, then
//! back to the start one page at a time, and a search hit reached in one go.
//!
//! `pages_of_a_long_chat_*` hold what each page contains; `long_chat_timings`
//! (ignored; `cargo test --lib long_chat_timings -- --ignored --nocapture`)
//! prints what each read costs and how big the page is on the wire.

use super::store::{self, AgentMessage, NewAgent};
use serde_json::json;

const LINES: usize = 5000;

fn with_root(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn markdown(i: usize) -> String {
    format!(
        "### Update {i}\nHere is what I found about **item {i}**, with `inline code`, a \
         [link](https://example.com/{i}) and a path ~/ShipStudio/acme/src/page-{i}.tsx.\n\n\
         - first point\n- second point, with `code`\n\n| Client | Due |\n| --- | --- |\n| Acme | ${} |\n\n\
         ```ts\nexport function price{i}(n: number) {{\n  return n * {i};\n}}\n```",
        i * 10
    )
}

/// One line of the log, by its place in it; a timeline beside every tenth.
fn line(agent_id: &str, i: usize) -> serde_json::Value {
    let base = json!({ "id": format!("m{i}"), "agentId": agent_id, "ts": 1_700_000_000_000i64 + i as i64 * 60_000 });
    let mut v = base.as_object().unwrap().clone();
    let set =
        |v: &mut serde_json::Map<String, serde_json::Value>, k: &str, x: serde_json::Value| {
            v.insert(k.into(), x);
        };
    match i % 10 {
        0 | 5 => {
            set(&mut v, "kind", json!("user"));
            set(
                &mut v,
                "text",
                json!(format!("Question {i}: can you check item {i}?")),
            );
        }
        3 => {
            set(&mut v, "kind", json!("approval"));
            set(
                &mut v,
                "approval",
                json!({ "requestId": format!("r{i}"), "title": "Run a command", "detail": format!("npm run build -- --item {i}"), "status": "pending" }),
            );
        }
        6 => {
            set(&mut v, "kind", json!("user"));
            set(&mut v, "text", json!("Screenshots attached"));
            set(
                &mut v,
                "attachments",
                json!([{ "name": "a.png", "path": format!("attachments/m{i}/a.png"), "mime": "image/png", "size": 27238 }]),
            );
        }
        8 => {
            set(&mut v, "kind", json!("note"));
            set(
                &mut v,
                "text",
                json!("Allowed automatically: Read package.json"),
            );
        }
        _ => {
            set(&mut v, "kind", json!("agent"));
            set(&mut v, "text", json!(markdown(i)));
        }
    }
    serde_json::Value::Object(v)
}

const KINDS: [&str; 5] = ["read", "edit", "search", "web", "command"];

fn timeline(i: usize) -> serde_json::Value {
    let t0 = 1_700_000_000_000i64 + i as i64 * 60_000 - 240_000;
    json!({
        "startedAt": t0,
        "endedAt": t0 + 240_000,
        "stepCount": 60,
        "files": ["src/a.tsx", "src/b.css", "src/c.ts"],
        "fileCount": 3,
        "steps": (0..60).map(|s| json!({
            "at": t0 + s * 4000,
            "kind": KINDS[s as usize % 5],
            "label": format!("Step {}: Read thing-{s}.tsx", s + 1),
        })).collect::<Vec<_>>(),
    })
}

/// A 5,000-line chat on disk, its answers and its timelines.
fn long_chat() -> String {
    let a = store::create(NewAgent {
        name: "Chief".into(),
        role: "Runs the team".into(),
        instructions: "Be brief.".into(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let home = store::agent_home(&a.id).unwrap();
    let mut raw = String::new();
    for i in 0..LINES {
        raw.push_str(&serde_json::to_string(&line(&a.id, i)).unwrap());
        raw.push('\n');
    }
    std::fs::write(home.join("messages.jsonl"), raw).unwrap();
    std::fs::create_dir_all(home.join("turns")).unwrap();
    for i in (1..LINES).step_by(10) {
        std::fs::write(
            home.join("turns").join(format!("m{i}.json")),
            serde_json::to_vec(&timeline(i)).unwrap(),
        )
        .unwrap();
    }
    for i in [13, 2503, 4993] {
        store::set_approval_status(&a.id, &format!("r{i}"), store::ApprovalStatus::Allowed)
            .unwrap()
            .unwrap();
    }
    a.id
}

/// A page as `agents_messages` serves it, timelines and all.
fn served(
    id: &str,
    limit: usize,
    before: Option<&str>,
    through: Option<&str>,
) -> Vec<AgentMessage> {
    let mut page = store::messages_page(id, limit, before, through.map(|t| (t, 5000))).unwrap();
    super::work::apply(id, &mut page);
    page
}

fn ids(page: &[AgentMessage]) -> Vec<String> {
    page.iter().map(|m| m.id.clone()).collect()
}

fn range(from: usize, to: usize) -> Vec<String> {
    (from..to).map(|i| format!("m{i}")).collect()
}

#[test]
fn pages_of_a_long_chat_walk_back_to_the_start_in_order() {
    with_root(|| {
        let id = long_chat();
        let full = store::messages(&id, usize::MAX).unwrap();
        assert_eq!(full.len(), LINES);

        let mut page = served(&id, 150, None, None);
        assert_eq!(ids(&page), range(LINES - 150, LINES));
        let mut seen = ids(&page);
        while let Some(first) = page.first().map(|m| m.id.clone()) {
            page = served(&id, 150, Some(&first), None);
            let mut older = ids(&page);
            older.extend(seen);
            seen = older;
        }
        // Every line exactly once, oldest first, each as a full read gives it.
        assert_eq!(seen, range(0, LINES));
    });
}

#[test]
fn pages_of_a_long_chat_carry_answers_and_timelines() {
    with_root(|| {
        let id = long_chat();
        let card = |p: &[AgentMessage], rid: &str| {
            p.iter()
                .filter_map(|m| m.approval.as_ref())
                .find(|a| a.request_id == rid)
                .map(|a| a.status)
        };
        let newest = served(&id, 150, None, None);
        assert_eq!(card(&newest, "r4993"), Some(store::ApprovalStatus::Allowed));
        assert_eq!(card(&newest, "r4983"), Some(store::ApprovalStatus::Pending));
        let middle = served(&id, 150, Some("m2600"), None);
        assert_eq!(ids(&middle), range(2450, 2600));
        assert_eq!(card(&middle, "r2503"), Some(store::ApprovalStatus::Allowed));
        let first = served(&id, 150, Some("m150"), None);
        assert_eq!(card(&first, "r13"), Some(store::ApprovalStatus::Allowed));
        // A timeline under every reply that has one, and only those.
        let with_work: Vec<String> = middle
            .iter()
            .filter(|m| m.work.is_some())
            .map(|m| m.id.clone())
            .collect();
        assert_eq!(
            with_work,
            (2451..2600)
                .step_by(10)
                .map(|i| format!("m{i}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            middle
                .iter()
                .find(|m| m.id == "m2451")
                .unwrap()
                .work
                .as_ref()
                .unwrap()
                .steps
                .len(),
            60
        );
    });
}

#[test]
fn pages_of_a_long_chat_reach_back_to_a_search_hit() {
    with_root(|| {
        let id = long_chat();
        let reach = served(&id, 150, Some("m4850"), Some("m1200"));
        assert_eq!(ids(&reach), range(1200, 4850));
        // A hit already inside the page: just the page.
        let inside = served(&id, 150, Some("m4850"), Some("m4800"));
        assert_eq!(ids(&inside), range(4700, 4850));
        // A cursor that isn't in the log: nothing, never a page from elsewhere.
        assert!(served(&id, 150, Some("m-gone"), None).is_empty());
        // An id that only appears inside another line's text is not that line.
        assert!(served(&id, 150, Some("item"), None).is_empty());
        // Further back than the cap: the newest `cap`, as before.
        let capped = store::messages_page(&id, 150, Some("m4850"), Some(("m1200", 300))).unwrap();
        assert_eq!(ids(&capped), range(4550, 4850));
    });
}

#[test]
fn reading_back_survives_odd_lines_and_chunk_edges() {
    with_root(|| {
        let id = long_chat();
        let path = store::agent_home(&id).unwrap().join("messages.jsonl");
        let mut raw = std::fs::read(&path).unwrap();
        // A line longer than any chunk, one in CRLF, an unknown kind, a blank
        // line, a line with a cut emoji, then a torn last line.
        let mut long = line(&id, 5000);
        long["text"] = json!("é".repeat(200_000));
        let mut push = |v: &serde_json::Value, end: &[u8]| {
            raw.extend_from_slice(serde_json::to_string(v).unwrap().as_bytes());
            raw.extend_from_slice(end);
        };
        push(&long, b"\n");
        push(&line(&id, 5001), b"\r\n");
        let mut odd = line(&id, 5002);
        odd["kind"] = json!("from_the_future");
        push(&odd, b"\n\n");
        let mut cut = serde_json::to_string(&line(&id, 5005))
            .unwrap()
            .into_bytes();
        let at = cut.iter().position(|b| *b == b'Q').unwrap_or(10);
        cut.splice(at..at, [0xF0, 0x9F]);
        raw.extend_from_slice(&cut);
        raw.extend_from_slice(b"\n{\"id\":\"torn\",\"kind\":\"us");
        std::fs::write(&path, raw).unwrap();

        let newest = served(&id, 4, None, None);
        assert_eq!(ids(&newest), ["m4999", "m5000", "m5001", "m5005"]);
        assert_eq!(newest[1].text.chars().count(), 200_000);
        // Paging from past the long line still lands on the line before it.
        assert_eq!(
            ids(&served(&id, 2, Some("m5001"), None)),
            ["m4999", "m5000"]
        );
        assert_eq!(
            ids(&served(&id, 2, Some("m5000"), None)),
            ["m4998", "m4999"]
        );
        // The same lines a whole read gives, in the same order.
        let full = store::messages(&id, usize::MAX).unwrap();
        let mut walked = served(&id, 150, None, None);
        let mut all = ids(&walked);
        while let Some(first) = walked.first().map(|m| m.id.clone()) {
            walked = served(&id, 150, Some(&first), None);
            let mut older = ids(&walked);
            older.extend(all);
            all = older;
        }
        assert_eq!(all, ids(&full));
    });
}

#[test]
#[ignore = "timings; run with --ignored --nocapture"]
fn long_chat_timings() {
    with_root(|| {
        let id = long_chat();
        let size = std::fs::metadata(store::agent_home(&id).unwrap().join("messages.jsonl"))
            .unwrap()
            .len();
        let time = |label: &str, runs: u32, f: &mut dyn FnMut() -> usize| {
            let t = std::time::Instant::now();
            let mut n = 0;
            for _ in 0..runs {
                n = f();
            }
            let ms = t.elapsed().as_secs_f64() * 1000.0 / runs as f64;
            println!("{label:<48} {ms:>8.2} ms  ({n})");
        };
        println!("log: {LINES} lines, {:.1} MB", size as f64 / 1e6);
        time("newest page (150)", 20, &mut || {
            served(&id, 150, None, None).len()
        });
        time("page from the middle (before m2500)", 20, &mut || {
            served(&id, 150, Some("m2500"), None).len()
        });
        time("oldest page (before m150)", 20, &mut || {
            served(&id, 150, Some("m150"), None).len()
        });
        time("all pages, newest to oldest", 3, &mut || {
            let mut page = served(&id, 150, None, None);
            let mut n = page.len();
            while let Some(first) = page.first().map(|m| m.id.clone()) {
                page = served(&id, 150, Some(&first), None);
                n += page.len();
            }
            n
        });
        time("search hit far back (through m300)", 5, &mut || {
            served(&id, 150, Some("m4900"), Some("m300")).len()
        });
        let page = served(&id, 150, None, None);
        let bytes = serde_json::to_vec(&page).unwrap().len();
        let work: usize = page
            .iter()
            .filter_map(|m| m.work.as_ref())
            .map(|w| serde_json::to_vec(w).unwrap().len())
            .sum();
        println!(
            "newest page on the wire: {:.0} KB, of which timelines {:.0} KB",
            bytes as f64 / 1024.0,
            work as f64 / 1024.0
        );
    });
}
