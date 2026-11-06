//! Reliability audit tests (the "silent bot" class). Each was first written
//! to show a bug, and now holds its fix.
//!
//! Run:  cargo test --lib agents::audit_tests -- --nocapture
//! Scale bench (slow, ignored by default):
//!       cargo test --release --lib agents::audit_tests::scale -- --ignored --nocapture

use serde_json::{json, Value};

use super::engine::Engine;
use super::failure::{self, FailureKind};
use super::store::{self, AgentMessage, MessageKind};

/* ------------------------------------------------------------ helpers */

/// Tiny deterministic PRNG (xorshift), so a failure reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() % xs.len() as u64) as usize]
    }
}

/// The largest counter a CLI could print: usage totals saturate rather than
/// overflow (which panicked a debug build mid-turn).
const AUDIT_BIG: u64 = u64::MAX;

const NASTY: &[&str] = &[
    "",
    " ",
    "İİİ",
    "é",
    "🦀🦀",
    "a\u{0301}",
    "\u{200d}",
    "ß",
    "://@",
    "https://user:pässwörd@hôst/",
    "resets 4:40pm (Asia/Dubai)",
    "usage limit reached|",
    "usage limit reached|17300000000000000000000",
    "resets İ:4",
    "try again at 7:18 pm.",
    "\n\n\n",
    "\"",
    "sk-ant-api03-ŁÓŻ",
    "X-Api-Key: ü",
    "aws_secret_access_key é",
    "--flag=é",
    "cd 'é' && npm run dév",
    "~/../../etc/passwd",
];

fn nasty_string(rng: &mut Rng) -> String {
    let n = 1 + rng.next() % 4;
    (0..n)
        .map(|_| *rng.pick(NASTY))
        .collect::<Vec<_>>()
        .join("")
}

/// Every string leaf in `v` replaced with a nasty one (sometimes), and
/// sometimes a value swapped for another JSON type.
fn mutate(v: &Value, rng: &mut Rng) -> Value {
    match v {
        Value::String(_) if rng.next() % 3 == 0 => Value::String(nasty_string(rng)),
        Value::Number(_) if rng.next() % 5 == 0 => rng
            .pick(&[
                json!(-1),
                json!(0),
                json!(AUDIT_BIG),
                json!(1e308),
                json!("12"),
            ])
            .clone(),
        Value::Array(a) => Value::Array(a.iter().map(|x| mutate(x, rng)).collect()),
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, x) in o {
                if rng.next() % 17 == 0 {
                    continue; // drop a field
                }
                let x = if rng.next() % 13 == 0 {
                    rng.pick(&[
                        json!(null),
                        json!([]),
                        json!({}),
                        json!(true),
                        json!(""),
                        json!("é"),
                    ])
                    .clone()
                } else {
                    mutate(x, rng)
                };
                out.insert(k.clone(), x);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn testdata(name: &str) -> Vec<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/agents/testdata")
        .join(name);
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/* ------------------------------------------- 1. parser panics = wedges */

/// A panic anywhere in `runner::drain` / `run_turn` unwinds the task with
/// `Runtime.running == true` and nothing resets it: every later message is
/// queued behind a worker that no longer exists (a permanently silent bot).
/// So the stream parsers must never panic on anything the CLI can print.
/// This fuzzes them with mutated real streams and Unicode edge cases.
#[test]
fn stream_parsers_never_panic_on_mutated_real_streams() {
    let claude = testdata("stream-partial.jsonl");
    let exec = testdata("codex-exec.jsonl");
    let app = testdata("codex-app-server.jsonl");
    let mut rng = Rng(0x5eed_1234_dead_beef);
    for round in 0..3000 {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut drafts = super::stream::Drafts::default();
            let mut ctx = super::context::ClaudeContext::default();
            let mut ids = 0u32;
            for v in &claude {
                let v = mutate(v, &mut rng);
                drafts.on_stream_event(&v, || {
                    ids += 1;
                    format!("d{ids}")
                });
                let _ = super::stream::claude_steps(&v, 1);
                let _ = ctx.observe(&v, 1);
                let _ = super::work::claude_actions(&v);
                let _ = super::work::claude_results(&v);
                if let Some(t) = v.pointer("/message/content/0/text").and_then(Value::as_str) {
                    let _ = drafts.finish(t);
                }
                let _ = drafts.flush();
            }
            let _ = drafts.take();
            for v in &exec {
                let _ = super::codex::steps(&mutate(v, &mut rng));
            }
            let (mut conv, _first) = super::codex_app::Conversation::new(
                None,
                std::path::Path::new("/tmp/é"),
                None,
                "dev",
                "hi",
                false,
            );
            for v in &app {
                let _ = conv.on_message(&mutate(v, &mut rng));
            }
            let _ = conv.interrupt();
        }));
        assert!(r.is_ok(), "parser panicked in round {round}");
    }
}

#[test]
fn labels_and_failure_wording_never_panic_on_unicode() {
    let mut rng = Rng(42);
    for _ in 0..20_000 {
        let s = nasty_string(&mut rng);
        let r = std::panic::catch_unwind(|| {
            let _ = super::work::scrub(&s);
            let _ = super::work::command_words(&s);
            for tool in [
                "Bash",
                "Edit",
                "Read",
                "WebFetch",
                "Grep",
                "mcp__x__y",
                "Task",
            ] {
                let _ = super::work::describe_tool(
                    tool,
                    Some(
                        &json!({"command": s, "file_path": s, "url": s, "pattern": s, "description": s}),
                    ),
                );
            }
            let _ = failure::describe(
                Engine::Claude,
                &s,
                &chrono::Utc,
                Some("utc"),
                1_700_000_000_000,
            );
            let _ = failure::describe(
                Engine::Codex,
                &format!("Usage limit reached. {s}"),
                &chrono::Utc,
                None,
                0,
            );
            let _ = super::runner::result_error_text(&json!({"result": s, "errors": [s]}));
        });
        assert!(r.is_ok(), "panicked on {s:?}");
    }
}

/* ------------------------------- 2. honest state: failure classification */

/// A transient API 429 ("rate limit") is a retryable blip in its own words,
/// never the usage limit.
#[test]
fn transient_rate_limit_is_its_own_temporary_failure() {
    let detail = r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#;
    for (engine, detail) in [
        (Engine::Claude, detail),
        (Engine::Codex, "Rate limit exceeded, retry later"),
    ] {
        let (text, f) = failure::describe(engine, detail, &chrono::Utc, None, 0);
        assert_eq!(f.kind, FailureKind::Other, "{text}");
        assert!(!text.contains("usage limit"), "{text}");
        assert!(text.contains("rate-limited"), "{text}");
        assert!(failure::is_temporary(&text, &f), "retried: {text}");
    }
}

/// Agents says CLI failures in its own words: never PR generation's copy
/// ("AI generation") and never "open an agent terminal".
#[test]
fn agents_chat_has_its_own_failure_wording() {
    for stderr in [
        "Error: this model requires usage credits",
        "Failed to load skill at ~/.claude/skills/x/SKILL.md",
        "model is not supported when using Codex with a ChatGPT account",
        "Error: this folder has not been trusted",
        "Selected model is at capacity",
        "Failed to refresh OAuth token: another Claude Code process is refreshing it",
    ] {
        let line = failure::cli_failure("Claude Code", stderr).expect("worded");
        let (text, _f) = failure::describe(Engine::Claude, &line, &chrono::Utc, None, 0);
        assert_eq!(text, line, "describe leaves it as it is");
        assert!(!text.contains("AI generation"), "{text}");
        assert!(!text.to_lowercase().contains("terminal"), "{text}");
    }
    assert!(failure::cli_failure("Claude Code", "Error: ENOENT").is_none());
}

/* -------------------------------- 3. routine runs that never settle */

/// An interrupted turn's next prompt carries the old one only truncated
/// (`prompts::interrupted`, 600 chars), so a ticket matched by prompt text
/// was never settled. Tickets now ride on the wake and settle by id (see
/// `runner::audit_runner_tests::scheduled_runs_settle_by_ticket_across_an_interrupt`);
/// this keeps the truncation that made text matching unsound in view.
#[test]
fn an_interrupted_long_routine_prompt_is_truncated_so_tickets_go_by_id() {
    let routine_prompt = format!(
        "[Scheduled check-in] {}",
        "Summarise the inbox. ".repeat(40)
    );
    assert!(routine_prompt.chars().count() > 600);
    let next_turn = format!(
        "{}{}",
        super::prompts::interrupted(&routine_prompt, Some("Reading mail")),
        "user: what's up?"
    );
    assert!(!next_turn.contains(&routine_prompt));
}

/* ------------------------------------------------- 4. scale bench */

fn msg(agent_id: &str, i: usize, approval: bool) -> AgentMessage {
    let mut m = super::runner::new_message(
        agent_id,
        if i % 2 == 0 {
            MessageKind::User
        } else {
            MessageKind::Agent
        },
        format!(
            "message {i} about invoices, pricing tables and the quarterly plan. {}",
            "lorem ipsum ".repeat(20)
        ),
    );
    if approval {
        m.kind = MessageKind::Approval;
        m.approval = Some(
            serde_json::from_value(json!({
                "requestId": format!("req-{agent_id}-{i}"),
                "title": "Run npm test",
                "detail": "",
                "status": "allowed"
            }))
            .unwrap(),
        );
    }
    m
}

/// 100 agents x 10k messages. Prints timings for the hot paths:
/// registry update (every recorded message does one), get, list, chat page,
/// search, pending approvals (reads the whole log), startup expiry.
#[test]
#[ignore]
fn scale() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let agents_n: usize = std::env::var("AUDIT_AGENTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);
    let msgs_n: usize = std::env::var("AUDIT_MSGS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let mut ids = Vec::new();
    let t = std::time::Instant::now();
    for a in 0..agents_n {
        let agent = store::create(store::NewAgent {
            name: format!("Agent {a}"),
            role: "Does things".into(),
            instructions: "Be useful. ".repeat(50),
            shape: None,
            avatar: None,
            color: None,
            is_main: a == 0,
        })
        .unwrap();
        // Write the log directly (append_message per line is the slow part
        // of building fixtures, not of what's measured).
        let home = store::agent_home(&agent.id).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let mut buf = String::new();
        for i in 0..msgs_n {
            buf.push_str(&serde_json::to_string(&msg(&agent.id, i, i % 200 == 0)).unwrap());
            buf.push('\n');
        }
        std::fs::write(home.join("messages.jsonl"), buf).unwrap();
        ids.push(agent.id);
    }
    eprintln!(
        "fixture: {agents_n} agents x {msgs_n} msgs in {:?}",
        t.elapsed()
    );
    let reg = std::fs::metadata(dir.path().join("agents.json"))
        .map(|m| m.len())
        .unwrap_or(0);
    let log = std::fs::metadata(store::agent_home(&ids[1]).unwrap().join("messages.jsonl"))
        .unwrap()
        .len();
    eprintln!(
        "agents.json = {} KB, one messages.jsonl = {} KB",
        reg / 1024,
        log / 1024
    );

    let time = |label: &str, n: usize, f: &mut dyn FnMut()| {
        let t = std::time::Instant::now();
        for _ in 0..n {
            f();
        }
        eprintln!(
            "{label:<44} {:>10.2} ms/op",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
    };
    let id = ids[ids.len() / 2].clone();
    time("store::update (per recorded message)", 50, &mut || {
        store::update(&id, |a| a.unread = a.unread.wrapping_add(1)).unwrap();
    });
    time("store::get", 50, &mut || {
        store::get(&id).unwrap();
    });
    time("store::list", 50, &mut || {
        store::list().unwrap();
    });
    time("messages(400) (open a chat)", 20, &mut || {
        store::messages(&id, 400).unwrap();
    });
    time("pending_approvals (whole log read)", 20, &mut || {
        store::pending_approvals(&id).unwrap();
    });
    time("search('quarterly invoices') all agents", 1, &mut || {
        super::search::search("quarterly invoices").unwrap();
    });
    // Nothing matches: every line of every log is looked at.
    time("search('nothing-matches-this') all agents", 1, &mut || {
        super::search::search("nothing-matches-this").unwrap();
    });
    time("expire_stale_approvals (startup)", 1, &mut || {
        store::expire_stale_approvals();
    });
    // Contention: one search holds each agent's log lock while it parses that
    // agent's whole log; an append for that agent waits behind it.
    let id2 = id.clone();
    let searcher = std::thread::spawn(|| {
        super::search::search("nothing-matches-this").unwrap();
    });
    std::thread::sleep(std::time::Duration::from_millis(5));
    let t = std::time::Instant::now();
    for i in 0..50 {
        store::append_message(&msg(&id2, i, false)).unwrap();
    }
    eprintln!("50 appends during a search: {:?}", t.elapsed());
    searcher.join().unwrap();
    store::set_root_for_tests(None);
}

/* ------------------------- 4b. pending approvals without whole-log reads */

/// Pending cards are cached per agent and follow every card and answer
/// written here; a log changed by anything else is read again.
#[test]
fn pending_approvals_follow_cards_and_answers_and_outside_changes() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let a = store::create(store::NewAgent {
        name: "Cards".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let card = |id: &str| {
        let mut m = super::runner::new_message(&a.id, MessageKind::Approval, "");
        m.approval = Some(
            serde_json::from_value(json!({
                "requestId": id, "title": "Run npm test", "detail": "", "status": "pending"
            }))
            .unwrap(),
        );
        m
    };
    assert!(store::pending_approvals(&a.id).unwrap().is_empty());
    store::append_message(&card("r1")).unwrap();
    store::append_message(&super::runner::new_message(&a.id, MessageKind::Agent, "hi")).unwrap();
    store::append_message(&card("r2")).unwrap();
    assert_eq!(store::pending_approvals(&a.id).unwrap().len(), 2);
    store::set_approval_status(&a.id, "r1", store::ApprovalStatus::Allowed).unwrap();
    let left = store::pending_approvals(&a.id).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].request_id, "r2");
    assert_eq!(
        store::find_approval(&a.id, "r1").unwrap().unwrap().status,
        store::ApprovalStatus::Allowed
    );
    // Written by something else (an older build, an import): read again.
    let log = store::agent_home(&a.id).unwrap().join("messages.jsonl");
    let mut raw = std::fs::read_to_string(&log).unwrap();
    raw.push_str(&serde_json::to_string(&card("r3")).unwrap());
    raw.push('\n');
    std::fs::write(&log, raw).unwrap();
    assert_eq!(store::pending_approvals(&a.id).unwrap().len(), 2);
    store::set_root_for_tests(None);
}

/* ------------------------------------- 5. delete during a turn */

/// A deleted agent's dying turn records "Stopped", a cut-off reply or a
/// timeline after its folder is gone. Those writes are refused: the folder
/// (the user's deleted chat) never comes back.
#[test]
fn a_message_recorded_after_delete_never_resurrects_the_home() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let a = store::create(store::NewAgent {
        name: "Temp".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let home = store::agent_home(&a.id).unwrap();
    store::delete(&a.id).unwrap();
    assert!(!home.exists());
    // What the dying turn does next:
    let refused = store::append_message(&super::runner::new_message(
        &a.id,
        MessageKind::Agent,
        "half a reply",
    ));
    assert!(refused.is_err());
    assert!(!home.exists(), "the deleted chat stays deleted");
    assert!(store::get(&a.id).is_err());
    assert!(store::is_gone(&a.id));
    // A registered agent whose folder went missing gets it back.
    let b = store::create(store::NewAgent {
        name: "Kept".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let home = store::agent_home(&b.id).unwrap();
    std::fs::remove_dir_all(&home).unwrap();
    store::append_message(&super::runner::new_message(&b.id, MessageKind::Agent, "hi")).unwrap();
    assert!(home.join("messages.jsonl").exists());
    store::set_root_for_tests(None);
}
