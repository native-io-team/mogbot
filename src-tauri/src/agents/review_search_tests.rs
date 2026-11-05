//! Adversarial tests for the lock-free, prefiltered search (child of
//! search.rs): a differential test against the old brute-force search, and
//! the two false negatives it once had, now holding their fix.
use super::*;
use crate::agents::store::{append_message, create, set_root_for_tests, tests_lock, NewAgent};

fn with_root<F: FnOnce()>(f: F) {
    let _serial = tests_lock();
    let dir = tempfile::tempdir().unwrap();
    set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    set_root_for_tests(None);
}

fn agent(name: &str) -> store::Agent {
    create(NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn msg(agent: &store::Agent, ts: i64, text: &str) -> AgentMessage {
    AgentMessage {
        id: store::new_id(),
        agent_id: agent.id.clone(),
        ts,
        kind: MessageKind::Agent,
        text: text.into(),
        peer: None,
        approval: None,
        attachments: Vec::new(),
        check_in: None,
        stopped: false,
        mentions: Vec::new(),
        failure: None,
        changes: None,
        session: None,
        client_id: None,
        work: None,
        fresh: false,
        takeover: false,
        room: None,
        result: None,
        revises: None,
    }
}

/// The old implementation: every parsed message, match_message, newest first.
fn brute(agents: &[store::Agent], query: &str, limit: usize) -> Vec<String> {
    let terms = terms(query);
    if terms.is_empty() {
        return vec![];
    }
    let mut hits = vec![];
    for a in agents {
        for m in store::messages(&a.id, usize::MAX).unwrap() {
            if match_message(&m, &terms).is_some() {
                hits.push((m.ts, m.id.clone()));
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.truncate(limit);
    hits.into_iter().map(|h| h.1).collect()
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[(self.next() % v.len() as u64) as usize]
    }
}

#[test]
fn differential_against_brute_force() {
    with_root(|| {
        let mut rng = Rng(0x9e3779b97f4a7c15);
        let pieces = [
            "north", "wind", "**", "`", "\"", "\\", "\n", "\t", " ", "Ü", "ü", "MÜLLER", "İ", "K",
            "\u{212A}", "#", "é", "日本", "\u{1}", "/", "x", "Invoice", "a*b", "*",
        ];
        let agents: Vec<_> = (0..3).map(|i| agent(&format!("A{i}"))).collect();
        let mut ts = 0;
        for a in &agents {
            for _ in 0..400 {
                let n = 1 + rng.next() % 12;
                let mut t = String::new();
                for _ in 0..n {
                    let p = *rng.pick(&pieces[..]);
                    t.push_str(p);
                }
                if rng.next().is_multiple_of(50) {
                    t.push_str(&"pad ".repeat(40_000));
                    t.push_str("tailword");
                }
                ts += 1;
                append_message(&msg(a, ts, &t)).unwrap();
            }
        }
        // Note: none of the random queries below is "kelvin" against a U+212A text by luck of
        // the seed; see the targeted test.
        let queries = [
            "north",
            "wind",
            "northwind",
            "müller",
            "MÜLLER",
            "ü",
            "invoice",
            "kelvin",
            "k",
            "x",
            "a*b",
            "b",
            "tailword",
            "pad tailword",
            "日本",
            "é",
            "#north",
            "\"",
            "\\",
            "/",
            "north wind",
        ];
        let mut misses = vec![];
        for q in queries {
            let got: Vec<String> = search_in(&agents, q, 10_000)
                .unwrap()
                .into_iter()
                .map(|h| h.message_id)
                .collect();
            let want = brute(&agents, q, 10_000);
            let mut g = got.clone();
            g.sort();
            let mut w = want.clone();
            w.sort();
            if g != w {
                misses.push(format!("{q:?}: got {} want {}", g.len(), w.len()));
            }
        }
        assert!(
            misses.is_empty(),
            "prefilter/chunked read disagrees with brute force: {misses:?}"
        );
    });
}

/// U+212A KELVIN SIGN lowercases (one char) to ASCII 'k': the prefilter lets it through.
#[test]
fn kelvin_sign_is_a_false_negative() {
    with_root(|| {
        let a = agent("A");
        append_message(&msg(&a, 1, "\u{212A}ELVIN units")).unwrap();
        let all = store::list().unwrap();
        assert_eq!(brute(&all, "kelvin", 50).len(), 1, "old search finds it");
        assert_eq!(
            search_in(&all, "kelvin", 50).unwrap().len(),
            1,
            "and so does the new one"
        );
    });
}

/// A raw imported line (prepend_log_block keeps lines verbatim) using JSON's `\/` escape.
#[test]
fn an_escaped_solidus_in_an_imported_line_is_a_false_negative() {
    with_root(|| {
        let a = agent("A");
        let line = format!(
            r#"{{"id":"m1","agentId":"{}","ts":5,"kind":"agent","text":"see https:\/\/acme.com\/x"}}"#,
            a.id
        );
        store::prepend_log_block(&a.id, None, vec![line], vec![]).unwrap();
        let all = store::list().unwrap();
        assert_eq!(
            brute(&all, "acme.com/x", 50).len(),
            1,
            "old search finds it"
        );
        assert_eq!(
            search_in(&all, "acme.com/x", 50).unwrap().len(),
            1,
            "and so does the new one"
        );
    });
}
