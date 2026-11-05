//! Search across every agent's conversation.
//!
//! A plain scan of each `messages.jsonl`: at the scale one person's agents
//! reach (tens of agents, thousands of lines) reading them is faster than
//! keeping an index honest. Matching is case-insensitive and every word of the
//! query must appear in the message; hits are newest first. Each log is read
//! newest line first, without its lock (it is append-only), raw lines that
//! can't hold every word are skipped before parsing, and an agent stops once
//! it has [`MAX_HITS`]. 100 agents × 10k messages: well under 500 ms.

use serde::Serialize;

use super::store::{self, AgentMessage, MessageKind};
use crate::errors::CommandError;

/// Most hits returned. Past this a search is too vague to scroll through.
pub const MAX_HITS: usize = 50;
/// Characters of context kept before the first match in a snippet.
const LEAD: usize = 40;
/// Total snippet length, in characters, before ellipses.
const SNIPPET_LEN: usize = 140;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub agent_id: String,
    pub agent_name: String,
    pub agent_color: String,
    pub message_id: String,
    pub ts: i64,
    pub kind: MessageKind,
    /// The other agent, for agent-to-agent lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_name: Option<String>,
    /// The text around the first match, whitespace collapsed, with `…` where cut.
    pub snippet: String,
}

/// The words of a query, lowercased. Empty when there's nothing to search for.
fn terms(query: &str) -> Vec<Vec<char>> {
    query
        .split_whitespace()
        .map(lower_chars)
        .filter(|w| !w.is_empty())
        .collect()
}

/// Lowercase one char to one char, so positions in the lowered text are
/// positions in the original. The few chars that lowercase to several (İ)
/// are kept as they are.
fn lower_char(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

fn lower_chars(s: &str) -> Vec<char> {
    s.chars().map(lower_char).collect()
}

fn find(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// What the user saw, minus the markdown punctuation and line breaks that
/// would make a one-line snippet unreadable.
fn plain(text: &str) -> Vec<char> {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let line = line.trim_start().trim_start_matches('#').trim_start();
        out.push_str(&line.replace("**", "").replace('`', ""));
        out.push(' ');
    }
    let mut chars = Vec::with_capacity(out.len());
    let mut last_space = true;
    for c in out.chars() {
        let space = c.is_whitespace();
        if space && last_space {
            continue;
        }
        chars.push(if space { ' ' } else { c });
        last_space = space;
    }
    while chars.last() == Some(&' ') {
        chars.pop();
    }
    chars
}

/// The searchable text of a message, or `None` for lines that aren't
/// conversation (approval cards, errors).
fn searchable(message: &AgentMessage) -> Option<&str> {
    match message.kind {
        MessageKind::User
        | MessageKind::Agent
        | MessageKind::SentToAgent
        | MessageKind::FromAgent
        // A fired check-in's text is the note it was scheduled with.
        | MessageKind::CheckIn
        // What was sent to a project session, and its reply.
        | MessageKind::Session => Some(&message.text),
        MessageKind::Approval | MessageKind::Error | MessageKind::Note | MessageKind::Changes => None,
    }
}

/// A snippet around `at` (a char index into `text`), cut on word boundaries
/// where one is close.
fn snippet(text: &[char], at: usize) -> String {
    if text.len() <= SNIPPET_LEN {
        return text.iter().collect();
    }
    let mut start = at.saturating_sub(LEAD);
    // Don't start mid-word if a space is near.
    if start > 0 {
        if let Some(space) = text[start..at].iter().position(|c| *c == ' ') {
            start += space + 1;
        }
    }
    let mut end = (start + SNIPPET_LEN).min(text.len());
    if end < text.len() {
        if let Some(space) = text[start..end].iter().rposition(|c| *c == ' ') {
            if space > (end - start) / 2 {
                end = start + space;
            }
        }
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(text[start..end].iter());
    if end < text.len() {
        out.push('…');
    }
    out
}

/// Whether every term is in the message; if so, the snippet around the
/// earliest one.
fn match_message(message: &AgentMessage, terms: &[Vec<char>]) -> Option<String> {
    let text = plain(searchable(message)?);
    let lowered: Vec<char> = text.iter().copied().map(lower_char).collect();
    let mut first = usize::MAX;
    for term in terms {
        first = first.min(find(&lowered, term)?);
    }
    Some(snippet(&text, first))
}

/// Whether a raw log line (lowered, ASCII only, so offsets stay put) may hold
/// every term, before it is parsed. Exact as a filter for what
/// [`match_message`] matches, which is in the line's own text lowered the
/// same way, except where markdown it drops (`**`, a backtick) joins words
/// (those lines are checked with it dropped), a char is JSON-escaped (a term
/// with a quote, backslash or control char isn't used to filter; a line with
/// a `\u` escape is let through), or a term isn't ASCII (left to the parse).
struct Prefilter {
    terms: Vec<String>,
}

impl Prefilter {
    fn new(terms: &[Vec<char>]) -> Self {
        let usable =
            |t: &&Vec<char>| t.iter().all(|c| c.is_ascii() && !matches!(c, '"' | '\\') && !c.is_control());
        Prefilter {
            terms: terms.iter().filter(usable).map(|t| t.iter().collect()).collect(),
        }
    }

    fn may_match(&self, lowered: &str) -> bool {
        let all = |line: &str| self.terms.iter().all(|t| line.contains(t.as_str()));
        if self.terms.is_empty() || all(lowered) || lowered.contains("\\u") {
            return true;
        }
        (lowered.contains("**") || lowered.contains('`'))
            && all(&lowered.replace("**", "").replace('`', ""))
    }
}

/// One agent's hits, newest first, at most `limit`. The log is read from its
/// end in growing chunks, only as far back as it takes, and without its lock:
/// it is only ever appended to, and a line torn by an append in progress just
/// doesn't parse.
fn search_agent(
    agent: &store::Agent,
    terms: &[Vec<char>],
    limit: usize,
) -> Result<Vec<SearchHit>, CommandError> {
    use std::io::{Read, Seek, SeekFrom};
    let path = store::agent_home(&agent.id)?.join("messages.jsonl");
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    let mut end = file.metadata().map_err(super::err_io)?.len();
    let filter = Prefilter::new(terms);
    let mut hits = Vec::new();
    let mut chunk: u64 = 256 * 1024;
    // The start of a later chunk's first line, cut by the chunk edge.
    let mut carry: Vec<u8> = Vec::new();
    while end > 0 && hits.len() < limit {
        let from = end.saturating_sub(chunk);
        let mut buf = vec![0u8; (end - from) as usize];
        file.seek(SeekFrom::Start(from))
            .and_then(|_| file.read_exact(&mut buf))
            .map_err(super::err_io)?;
        buf.extend_from_slice(&carry);
        end = from;
        let whole_from = if from == 0 {
            0
        } else {
            match buf.iter().position(|b| *b == b'\n') {
                Some(at) => at + 1,
                None => {
                    carry = buf;
                    chunk = chunk.saturating_mul(2);
                    continue;
                }
            }
        };
        carry = buf[..whole_from].to_vec();
        let text = String::from_utf8_lossy(&buf[whole_from..]);
        let lowered = text.to_ascii_lowercase();
        for (low, line) in lowered.split('\n').rev().zip(text.split('\n').rev()) {
            if hits.len() >= limit {
                break;
            }
            if line.trim().is_empty() || !filter.may_match(low) {
                continue;
            }
            let Ok(message) = serde_json::from_str::<AgentMessage>(line) else {
                continue;
            };
            if let Some(snippet) = match_message(&message, terms) {
                hits.push(SearchHit {
                    agent_id: agent.id.clone(),
                    agent_name: agent.name.clone(),
                    agent_color: agent.color.clone(),
                    peer_name: message.peer.as_ref().map(|p| p.name.clone()),
                    message_id: message.id,
                    ts: message.ts,
                    kind: message.kind,
                    snippet,
                });
            }
        }
        chunk = chunk.saturating_mul(2).min(8 * 1024 * 1024);
    }
    Ok(hits)
}

/// Search the given agents' conversations. Separate from [`search`] so tests
/// can run it over a fixed set. An agent whose log can't be read is left
/// out, not the whole search.
pub fn search_in(
    agents: &[store::Agent],
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CommandError> {
    let terms = terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    // Each agent's newest `limit` are all that could make the cut; agents are
    // read a few at a time, in order, so the merge below is deterministic.
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8);
    let per = agents.len().div_ceil(threads).max(1);
    let terms = &terms;
    let found: Vec<Vec<SearchHit>> = std::thread::scope(|scope| {
        let workers: Vec<_> = agents
            .chunks(per)
            .map(|group| {
                scope.spawn(move || {
                    let mut hits = Vec::new();
                    for agent in group {
                        match search_agent(agent, terms, limit) {
                            Ok(mut found) => hits.append(&mut found),
                            Err(e) => tracing::warn!("[Agents] search skipped {}: {e}", agent.id),
                        }
                    }
                    hits
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|w| w.join().unwrap_or_default())
            .collect()
    });
    let mut hits: Vec<SearchHit> = found.into_iter().flatten().collect();
    // Newest first. Each agent's hits came newest first already, so a
    // stable sort keeps same-millisecond lines newest-in-log first.
    hits.sort_by(|a, b| b.ts.cmp(&a.ts));
    hits.truncate(limit);
    Ok(hits)
}

pub fn search(query: &str) -> Result<Vec<SearchHit>, CommandError> {
    search_in(&store::list()?, query, MAX_HITS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::store::{
        append_message, create, set_root_for_tests, tests_lock, AgentRef, NewAgent,
    };

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

    fn say(agent: &store::Agent, kind: MessageKind, ts: i64, text: &str) -> String {
        let id = store::new_id();
        append_message(&AgentMessage {
            id: id.clone(),
            agent_id: agent.id.clone(),
            ts,
            kind,
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
        })
        .unwrap();
        id
    }

    #[test]
    fn every_word_must_match_in_any_case_and_order() {
        with_root(|| {
            let finance = agent("Finance");
            let hit = say(
                &finance,
                MessageKind::Agent,
                1,
                "Northwind owes $4,200 on the INVOICE.",
            );
            say(&finance, MessageKind::Agent, 2, "Globex paid the invoice.");
            let found = search_in(&store::list().unwrap(), "invoice northwind", 50).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].message_id, hit);
            assert!(search_in(&store::list().unwrap(), "   ", 50)
                .unwrap()
                .is_empty());
        });
    }

    #[test]
    fn newest_first_across_agents_and_capped() {
        with_root(|| {
            let a = agent("Finance");
            let b = agent("Acme Site");
            say(&a, MessageKind::User, 10, "deploy please");
            let newest = say(&b, MessageKind::Agent, 30, "deploy is green");
            say(&a, MessageKind::Agent, 20, "deploy started");
            let all = store::list().unwrap();
            let found = search_in(&all, "deploy", 50).unwrap();
            assert_eq!(
                found.iter().map(|h| h.ts).collect::<Vec<_>>(),
                vec![30, 20, 10]
            );
            assert_eq!(found[0].message_id, newest);
            assert_eq!(found[0].agent_name, "Acme Site");
            assert_eq!(search_in(&all, "deploy", 2).unwrap().len(), 2);
        });
    }

    #[test]
    fn skips_approval_cards_and_errors_and_names_the_peer() {
        with_root(|| {
            let a = agent("Chief");
            say(&a, MessageKind::Error, 1, "deploy failed");
            say(&a, MessageKind::Approval, 2, "deploy");
            append_message(&AgentMessage {
                id: store::new_id(),
                agent_id: a.id.clone(),
                ts: 3,
                kind: MessageKind::SentToAgent,
                text: "Check the deploy".into(),
                peer: Some(AgentRef {
                    id: "x".into(),
                    name: "Acme Site".into(),
                }),
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
            })
            .unwrap();
            let found = search_in(&store::list().unwrap(), "deploy", 50).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].peer_name.as_deref(), Some("Acme Site"));
        });
    }

    #[test]
    fn the_raw_prefilter_never_hides_a_match() {
        with_root(|| {
            let a = agent("Finance");
            // Joined by dropped markdown, quoted, non-ASCII case, multi-line.
            say(&a, MessageKind::Agent, 1, "Pay **north**wind now");
            say(&a, MessageKind::Agent, 2, "He said \"MÜLLER\" owes us");
            say(&a, MessageKind::Agent, 3, "line one\nInvoice two");
            let all = store::list().unwrap();
            assert_eq!(search_in(&all, "northwind", 50).unwrap().len(), 1);
            assert_eq!(search_in(&all, "\"müller\"", 50).unwrap().len(), 1);
            assert_eq!(search_in(&all, "müller", 50).unwrap().len(), 1);
            assert_eq!(search_in(&all, "invoice", 50).unwrap().len(), 1);
            assert!(search_in(&all, "globex", 50).unwrap().is_empty());
        });
    }

    #[test]
    fn an_unreadable_log_leaves_out_one_agent_not_the_search() {
        with_root(|| {
            let a = agent("Finance");
            let b = agent("Broken");
            say(&a, MessageKind::Agent, 1, "deploy done");
            say(&b, MessageKind::Agent, 2, "deploy done");
            let log = store::agent_home(&b.id).unwrap().join("messages.jsonl");
            std::fs::remove_file(&log).unwrap();
            std::fs::create_dir(&log).unwrap(); // can't be read as a file
            let found = search_in(&store::list().unwrap(), "deploy", 50).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].agent_id, a.id);
        });
    }

    #[test]
    fn each_agent_stops_at_the_cap_keeping_its_newest() {
        with_root(|| {
            let a = agent("Finance");
            for ts in 0..30 {
                say(&a, MessageKind::Agent, ts, "invoice");
            }
            let found = search_in(&store::list().unwrap(), "invoice", 5).unwrap();
            assert_eq!(
                found.iter().map(|h| h.ts).collect::<Vec<_>>(),
                vec![29, 28, 27, 26, 25]
            );
        });
    }

    #[test]
    fn short_messages_are_the_whole_snippet_without_markdown() {
        let text = plain("## Done\n\nThe **pricing** table uses `grid`.\n");
        assert_eq!(
            text.iter().collect::<String>(),
            "Done The pricing table uses grid."
        );
    }

    #[test]
    fn long_messages_are_cut_around_the_first_match_on_word_boundaries() {
        let before = "alpha ".repeat(30);
        let after = " omega".repeat(30);
        let text: Vec<char> = format!("{before}needle{after}").chars().collect();
        let at = find(
            &lower_chars(&text.iter().collect::<String>()),
            &lower_chars("needle"),
        )
        .unwrap();
        let s = snippet(&text, at);
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(s.contains("needle"));
        // Cut between words, not through them.
        assert!(s.starts_with("…alpha"), "{s}");
        assert!(s.trim_end_matches('…').ends_with("omega"), "{s}");
        assert!(s.chars().count() <= SNIPPET_LEN + 2);
        // The match sits near the front, with some lead-in.
        let pos = s.find("needle").unwrap();
        assert!(pos > 10 && pos <= LEAD + 4, "{pos}");
    }

    #[test]
    fn a_match_at_the_very_start_has_no_leading_ellipsis() {
        let text: Vec<char> = format!("needle {}", "word ".repeat(60)).chars().collect();
        let s = snippet(&text, 0);
        assert!(s.starts_with("needle"));
        assert!(s.ends_with('…'));
    }

    #[test]
    fn matching_handles_non_ascii_case() {
        let message = AgentMessage {
            id: "m".into(),
            agent_id: "a".into(),
            ts: 0,
            kind: MessageKind::User,
            text: "Rechnung für MÜLLER".into(),
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
        };
        assert!(match_message(&message, &terms("müller")).is_some());
        assert!(match_message(&message, &terms("müller schmidt")).is_none());
    }
}
