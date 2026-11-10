//! Bringing agents over without Remote Access: an export file or folder the
//! user picks or drops, or a reply they paste back from their old assistant.
//!
//! Both end exactly where the connector's interview does: one review card in
//! the Chief's chat (`connector::post_review_card`), answered by the same
//! Import / Don't import (`connector::apply_review`). Nothing becomes an
//! agent until the user presses Import, routines arrive paused, a name
//! already taken comes in as "<Name> (from <source>)" unless they choose
//! Replace, and the Chief is never changed (its counterpart's instructions
//! and what the export says about the user are offered as notes).
//!
//! **Sealed by construction.** What's read here is outside text. No model
//! reads it on the way in: it's parsed by plain code (`serde_json`, the
//! folder readers in `import_formats`), with no tools, no turn, no engine.
//! Text is only ever copied into fields (an agent's instructions stay its
//! instructions, word for word, whatever they say); a field never changes
//! what else is imported. Hidden characters go (`review::clean_text`),
//! anything shaped like a credential is masked before it is staged
//! (`harvest::mask_secrets`), names kept for the user or the Chief are
//! refused, and the export's own claim about where it's from can't take
//! the name of the user or an agent here (`connector::clean_source`).
//!
//! **Exhaustive by asking again.** A file is what it is, but a pasted reply
//! came from an assistant we can't call. So every check lists what's still
//! missing (each agent's routines, what it watches for, its apps and
//! memory; the six areas about the user; parts not yet pasted) and writes
//! the follow-up message that asks for exactly that. The user sends it and
//! pastes the answer under the last one; replies merge by agent name. The
//! card can still be put up with gaps: it says what they are.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::coverage::{Area, AreaLine, CoverageReport};
use super::import_formats::{self, Format};
use super::review::{self, Proposal, Review};
use super::store;
use crate::errors::CommandError;

/// Every review card from here has a talk id starting with this: no
/// connector import is behind it (`connector::apply_review` leaves an armed
/// one alone).
pub const TALK_PREFIX: &str = "export-";

pub fn is_export_card(talk_id: &str) -> bool {
    talk_id.starts_with(TALK_PREFIX)
}

/// One field's text: how many characters a pasted reply or file may carry.
const MAX_TEXT_CHARS: usize = 2_000_000;

/// What the user sends their old assistant. It asks for everything the
/// interview does (docs/agents.md, "It doesn't stop until it has
/// everything"), in one JSON shape this reads.
pub const PROMPT: &str = r#"I'm moving to a new app on my computer and I want to bring everything you do for me. Please give me a complete copy: every agent, bot or persona you run for me (including the main one that manages the others), and everything you know about me that they need.

Reply with ```json code blocks in exactly this shape:

{
  "source": "your product's name, e.g. Grok Bot",
  "part": 1,
  "parts": 1,
  "agents": [
    {
      "name": "the agent's name",
      "role": "one line: what it does",
      "is_main": false,
      "instructions": "its full instructions or system prompt, word for word",
      "memory": ["everything it remembers that it still needs, one fact each"],
      "routines": [{ "when": "every weekday at 9am", "what": "what it does then" }],
      "watches": [{ "when": "an invoice email arrives", "what": "what it does then" }],
      "apps": [{ "name": "Gmail", "purpose": "what it uses it for" }],
      "logins": [{ "name": "Stripe", "purpose": "reads invoices", "kind": "api_key" }],
      "preferences": ["how I like this agent's work done, one each"],
      "context": ["people, projects and facts it works with, one each"]
    }
  ],
  "about_me": {
    "people": ["everyone you know about: name, who they are to me, what's open with them"],
    "tasks": ["every ongoing task or project: where it stands, the next step, deadlines"],
    "preferences": ["every standing rule or preference I gave you, word for word"],
    "accounts": ["every account, app and tool you use for me, by name, and what for"],
    "personal": ["saved facts: family, home, vehicles, money, dates that matter"],
    "threads": ["conversations still open: what was asked, what you promised, what's waiting"]
  },
  "complete": false
}

Rules:
- Include every agent, each in full. Copy instructions and memory word for word: don't summarize or shorten. Long is fine.
- Set "is_main": true on the one that manages the others (at most one).
- "routines": everything it does on a schedule, with the exact time ("every monday at 8:30am", "every 2 hours", "every month on the 1st at 9am"). "watches": everything it does when something happens. Use [] for none, so I know there are none.
- Fill every list in "about_me", or [] if there's truly nothing.
- Never include passwords, API keys, tokens or card numbers: name the login in "logins" instead, and write [removed] where one appeared in any text.
- Valid JSON only: straight double quotes, \n for line breaks inside text, no comments, no trailing commas.
- If it's long, split it into parts ("part": 1, "parts": 3, ...), each a whole ```json block in the same shape, never splitting one agent. Send the next part when I say "continue".
- Set "complete": true in the last part only when nothing at all is left out."#;

/* ------------------------------------------------------------- the data */

/// One agent as an export or a reply describes it, before the review's
/// cleaning. `sent` is which fields were there at all: an empty list says
/// "none", a missing one is a gap to ask about.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Agent {
    pub name: String,
    pub role: String,
    pub is_main: bool,
    pub instructions: String,
    pub memory: String,
    pub routines: Vec<(String, String)>,
    pub watches: Vec<(String, String)>,
    pub apps: Vec<(String, String)>,
    pub logins: Vec<(String, String, String)>,
    pub preferences: String,
    pub context: String,
    pub sent: BTreeSet<&'static str>,
    /// A recipe's key look and suggested independence (`recipe`).
    pub look: Option<review::ProposedLook>,
}

/// Everything read from one file, folder or reply.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Export {
    pub source: String,
    pub format: Format,
    pub agents: Vec<Agent>,
    /// The areas about the user, by `coverage::Area` key. Present with no
    /// facts means the source said there are none.
    pub about: BTreeMap<&'static str, Vec<String>>,
    /// "parts": N, as the reply declared it, and which part numbers arrived.
    pub parts: Option<usize>,
    pub parts_seen: BTreeSet<usize>,
    /// The source said it left nothing out.
    pub complete: bool,
    /// Anything wrong that blocks the review: each names where it is.
    pub problems: Vec<String>,
    /// What was read and what was left alone, for the preview (a file's
    /// names, never its contents).
    pub read: Vec<String>,
    pub skipped: Vec<String>,
}

/// The areas about the user a reply is asked for (agents and routines
/// are the agents' own).
pub const ABOUT: [Area; 6] = [
    Area::People,
    Area::Tasks,
    Area::Preferences,
    Area::Accounts,
    Area::Personal,
    Area::Threads,
];

/* -------------------------------------------------------- reading JSON */

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "empty",
        Value::Bool(_) => "true/false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// Text, or a list of texts read one per line. Anything else is a problem.
fn lines_field(value: Option<&Value>, at: &str, problems: &mut Vec<String>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(s) => Some(s.trim().to_string()),
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                match item {
                    Value::String(s) if !s.trim().is_empty() => out.push(s.trim().to_string()),
                    Value::String(_) => {}
                    other => {
                        problems.push(format!(
                            "{at} should be text or a list of texts, but holds {}.",
                            kind(other)
                        ));
                        return None;
                    }
                }
            }
            Some(out.join("\n"))
        }
        other => {
            problems.push(format!("{at} should be text, not {}.", kind(other)));
            None
        }
    }
}

/// A list of `{when, what}`-like pairs (`a`, `b` name the keys).
fn pairs(
    value: Option<&Value>,
    a: &str,
    b: &str,
    at: &str,
    problems: &mut Vec<String>,
) -> Option<Vec<(String, String)>> {
    let list = match value? {
        Value::Null => return None,
        Value::Array(list) => list,
        other => {
            problems.push(format!("{at} should be a list, not {}.", kind(other)));
            return None;
        }
    };
    let mut out = Vec::new();
    for (i, item) in list.iter().enumerate() {
        match item {
            // A bare name is fine for apps.
            Value::String(s) if b == "purpose" => out.push((s.trim().to_string(), String::new())),
            Value::Object(o) => {
                let get = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").trim();
                if get(a).is_empty() {
                    problems.push(format!("{at}, item {}, has no \"{a}\".", i + 1));
                    continue;
                }
                out.push((get(a).to_string(), get(b).to_string()));
            }
            other => problems.push(format!(
                "{at}, item {}: expected {{\"{a}\", \"{b}\"}}, found {}.",
                i + 1,
                kind(other)
            )),
        }
    }
    Some(out)
}

/// One agent entry, or `None` with why.
fn read_agent(value: &Value, position: &str, problems: &mut Vec<String>) -> Option<Agent> {
    let Some(obj) = value.as_object() else {
        problems.push(format!(
            "{position} isn't an agent: expected {{\"name\", ...}}, found {}.",
            kind(value)
        ));
        return None;
    };
    let name = match obj.get("name") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(Value::String(_)) | None | Some(Value::Null) => {
            problems.push(format!("{position} has no \"name\"."));
            return None;
        }
        Some(other) => {
            problems.push(format!(
                "{position}: \"name\" should be text, not {}.",
                kind(other)
            ));
            return None;
        }
    };
    let who = format!("\u{201C}{name}\u{201D}");
    let mut a = Agent {
        name,
        ..Agent::default()
    };
    let field = |k: &str| format!("{who}'s \"{k}\"");
    for (key, slot) in [
        ("role", &mut a.role),
        ("instructions", &mut a.instructions),
        ("memory", &mut a.memory),
        ("preferences", &mut a.preferences),
        ("context", &mut a.context),
    ] {
        if let Some(text) = lines_field(obj.get(key), &field(key), problems) {
            *slot = text;
            a.sent.insert(static_key(key));
        }
    }
    match obj.get("is_main") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(b)) => a.is_main = *b,
        Some(other) => problems.push(format!(
            "{who}: \"is_main\" should be true or false, not {}.",
            kind(other)
        )),
    }
    if let Some(list) = pairs(
        obj.get("routines"),
        "when",
        "what",
        &field("routines"),
        problems,
    ) {
        a.routines = list;
        a.sent.insert("routines");
    }
    if let Some(list) = pairs(
        obj.get("watches"),
        "when",
        "what",
        &field("watches"),
        problems,
    ) {
        a.watches = list;
        a.sent.insert("watches");
    }
    if let Some(list) = pairs(obj.get("apps"), "name", "purpose", &field("apps"), problems) {
        a.apps = list;
        a.sent.insert("apps");
    }
    if let Some(list) = pairs(
        obj.get("logins"),
        "name",
        "purpose",
        &field("logins"),
        problems,
    ) {
        let kinds: Vec<String> = obj
            .get("logins")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .map(|x| {
                        x.get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("other")
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_default();
        a.logins = list
            .into_iter()
            .enumerate()
            .map(|(i, (n, p))| {
                (
                    n,
                    p,
                    kinds.get(i).cloned().unwrap_or_else(|| "other".into()),
                )
            })
            .collect();
        a.sent.insert("logins");
    }
    Some(a)
}

fn static_key(key: &str) -> &'static str {
    match key {
        "role" => "role",
        "instructions" => "instructions",
        "memory" => "memory",
        "preferences" => "preferences",
        _ => "context",
    }
}

/// Fold `next` into `into`: a later part or a follow-up answer adds to the
/// agent of the same name rather than repeating it.
fn merge_agent(into: &mut Agent, next: Agent) {
    let text = |a: &mut String, b: String| {
        let b = b.trim().to_string();
        if b.is_empty() || a.contains(&b) {
            return;
        }
        if a.trim().is_empty() || b.contains(a.trim()) {
            *a = b;
        } else {
            a.push_str("\n\n");
            a.push_str(&b);
        }
    };
    text(&mut into.role, next.role);
    text(&mut into.instructions, next.instructions);
    text(&mut into.memory, next.memory);
    text(&mut into.preferences, next.preferences);
    text(&mut into.context, next.context);
    into.is_main |= next.is_main;
    if into.look.is_none() {
        into.look = next.look;
    }
    fn add<T: PartialEq>(list: &mut Vec<T>, more: Vec<T>) {
        for m in more {
            if !list.contains(&m) {
                list.push(m);
            }
        }
    }
    add(&mut into.routines, next.routines);
    add(&mut into.watches, next.watches);
    add(&mut into.apps, next.apps);
    add(&mut into.logins, next.logins);
    into.sent.extend(next.sent);
}

impl Export {
    pub(crate) fn add_agent(&mut self, agent: Agent) {
        match self
            .agents
            .iter_mut()
            .find(|a| a.name.trim().eq_ignore_ascii_case(agent.name.trim()))
        {
            Some(existing) => merge_agent(existing, agent),
            None => self.agents.push(agent),
        }
    }

    /// One JSON value in the shape [`PROMPT`] asks for (or a bare list of
    /// agents, or one agent).
    pub fn add_value(&mut self, value: Value, label: &str) {
        let (agents, obj): (Vec<Value>, Option<Map<String, Value>>) = match value {
            Value::Object(obj) if obj.contains_key("agents") || obj.contains_key("about_me") => {
                let list = match obj.get("agents") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::Array(list)) => list.clone(),
                    Some(other) => {
                        self.problems.push(format!(
                            "{label}: \"agents\" should be a list, not {}.",
                            kind(other)
                        ));
                        Vec::new()
                    }
                };
                (list, Some(obj))
            }
            Value::Object(obj) if obj.contains_key("name") => (vec![Value::Object(obj)], None),
            Value::Array(list) => (list, None),
            _ => {
                self.problems
                    .push(format!("{label} has no \"agents\" list."));
                return;
            }
        };
        if let Some(obj) = &obj {
            if self.source.is_empty() {
                if let Some(s) = obj.get("source").and_then(Value::as_str) {
                    self.source = s.trim().to_string();
                }
            }
            let number = |k: &str| {
                obj.get(k)
                    .and_then(Value::as_u64)
                    .map(|n| n as usize)
                    .filter(|n| (1..=50).contains(n))
            };
            if let Some(parts) = number("parts") {
                self.parts = Some(self.parts.map_or(parts, |p| p.max(parts)));
            }
            if let Some(part) = number("part") {
                self.parts_seen.insert(part);
            }
            if obj.get("complete").and_then(Value::as_bool) == Some(true) {
                self.complete = true;
            }
            match obj.get("about_me") {
                None | Some(Value::Null) => {}
                Some(Value::Object(about)) => {
                    for area in ABOUT {
                        let at = format!("{label}: \"about_me\".\"{}\"", area.key());
                        if let Some(text) =
                            lines_field(about.get(area.key()), &at, &mut self.problems)
                        {
                            let facts = self.about.entry(area.key()).or_default();
                            for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                                if !facts.iter().any(|f| f == line) {
                                    facts.push(line.to_string());
                                }
                            }
                        }
                    }
                }
                Some(other) => self.problems.push(format!(
                    "{label}: \"about_me\" should be an object, not {}.",
                    kind(other)
                )),
            }
        }
        let many = agents.len() > 1;
        for (j, entry) in agents.iter().enumerate() {
            let position = if many {
                format!("Agent {} in {}", j + 1, label.to_lowercase())
            } else {
                format!("The agent in {}", label.to_lowercase())
            };
            if let Some(agent) = read_agent(entry, &position, &mut self.problems) {
                self.add_agent(agent);
            }
        }
    }

    /// Everything wrong that a review can't be put up with. Two "main"
    /// agents is one: which one's notes go to the Chief would be a guess.
    fn check(&mut self) {
        let mains: Vec<&str> = self
            .agents
            .iter()
            .filter(|a| a.is_main)
            .map(|a| a.name.as_str())
            .collect();
        if mains.len() > 1 {
            self.problems.push(format!(
                "Only one agent can be the main one, but {} are all marked \"is_main\": true.",
                mains
                    .iter()
                    .map(|n| format!("\u{201C}{n}\u{201D}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if self.agents.is_empty()
            && self.about.values().all(Vec::is_empty)
            && self.problems.is_empty()
        {
            self.problems.push("There are no agents in it.".into());
        }
    }
}

/// Everything in a pasted reply (or several, one under the other).
pub fn read_text(text: &str) -> Export {
    let mut out = Export::default();
    if text.chars().count() > MAX_TEXT_CHARS {
        out.problems
            .push("That's more than one import can read at once. Paste it in parts.".into());
        return out;
    }
    let blocks = super::paste::extract_blocks(text);
    if blocks.is_empty() {
        out.problems.push(
            "There's no JSON in what you pasted. Paste the assistant's whole reply, including its ```json block.".into(),
        );
        return out;
    }
    let many = blocks.len() > 1;
    for (i, raw) in blocks.iter().enumerate() {
        let label = if many {
            format!("Block {}", i + 1)
        } else {
            "The JSON".to_string()
        };
        match super::paste::parse_block(raw, &label) {
            Ok(v) if super::recipe::is_recipe(&v) => super::recipe::read_value(&v, &label, &mut out),
            Ok(v) => out.add_value(v, &label),
            Err(p) => out.problems.push(p),
        }
    }
    out.check();
    out
}

/// Everything in a file or folder the user picked or dropped.
pub fn read_path(path: &Path) -> Export {
    let mut out = import_formats::read(path);
    out.check();
    out
}

/* --------------------------------------------------------------- gaps */

/// What's still missing, one line each, in the order the follow-up asks.
/// A file in another app's own format has nothing to ask (it holds what
/// that app keeps); the gaps there are what it doesn't keep, said on the
/// card's areas.
pub fn gaps(e: &Export) -> Vec<String> {
    let mut out = Vec::new();
    if e.format != Format::Handover {
        return out;
    }
    if let Some(parts) = e.parts {
        let missing: Vec<String> = (1..=parts)
            .filter(|n| !e.parts_seen.contains(n))
            .map(|n| n.to_string())
            .collect();
        if !missing.is_empty() {
            out.push(format!(
                "part {} of {parts}",
                missing.join(if missing.len() == 2 { " and " } else { ", " })
            ));
        }
    }
    for a in &e.agents {
        let mut want: Vec<&str> = Vec::new();
        if a.instructions.trim().is_empty() {
            want.push("its full instructions, word for word");
        }
        for (key, words) in [
            ("memory", "what it remembers"),
            ("routines", "its routines with exact times"),
            ("watches", "what it watches for"),
            ("apps", "the apps it uses"),
        ] {
            if !a.sent.contains(key) {
                want.push(words);
            }
        }
        if !want.is_empty() {
            out.push(format!("{}: {}", a.name, join_and(&want)));
        }
    }
    for area in ABOUT {
        if !e.about.contains_key(area.key()) {
            out.push(area_ask(area).to_string());
        }
    }
    if out.is_empty() && !e.complete {
        out.push("anything else at all you do for me or know about me".into());
    }
    out
}

fn join_and(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn area_ask(area: Area) -> &'static str {
    match area {
        Area::People => "the people you know about (\"about_me\".\"people\")",
        Area::Tasks => "my ongoing tasks and projects (\"about_me\".\"tasks\")",
        Area::Preferences => "my preferences and standing rules (\"about_me\".\"preferences\")",
        Area::Accounts => {
            "the accounts and tools you use for me, by name (\"about_me\".\"accounts\")"
        }
        Area::Personal => "the saved facts about me (\"about_me\".\"personal\")",
        Area::Threads => "the conversations still open (\"about_me\".\"threads\")",
        Area::Agents | Area::Routines => "",
    }
}

/// The message that asks for exactly what's missing, or `None` when nothing is.
pub fn follow_up(e: &Export) -> Option<String> {
    let gaps = gaps(e);
    if gaps.is_empty() {
        return None;
    }
    let list: String = gaps.iter().map(|g| format!("\n- {g}")).collect();
    Some(format!(
        "Thanks. Some things are still missing:{list}\n\nSend just these as another ```json block in the same shape as before, using the same agent names (\"agents\" with only the fields that were missing, \"about_me\" with only the missing lists). Word for word, [] where there's truly nothing, no passwords or keys. Set \"complete\": true only when nothing at all is left out."
    ))
}

/* ------------------------------------------------------------- review */

/// What the preview says before anything is put up.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub source: String,
    /// "OpenClaw workspace", "Pasted reply"…
    pub format: String,
    /// Read the way that app's own docs or code describe it, not a guess.
    pub verified: bool,
    pub agents: Vec<PreviewAgent>,
    /// The Chief's counterpart there, whose notes are offered, never applied.
    pub main: Option<String>,
    /// Facts about the user, by area label.
    pub about: Vec<(String, usize)>,
    /// Block the review.
    pub problems: Vec<String>,
    /// Agents the review won't take, and why.
    pub refused: Vec<String>,
    pub gaps: Vec<String>,
    pub follow_up: Option<String>,
    /// Credentials replaced by "[removed: …]" before anything was staged.
    pub masked: usize,
    pub read: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAgent {
    pub name: String,
    pub role: String,
    pub instructions_chars: usize,
    pub memory_lines: usize,
    pub routines: usize,
    pub watches: usize,
    pub apps: usize,
}

/// `text` with credentials masked, and how many.
fn masked(text: &str, count: &mut usize) -> String {
    let (out, n) = super::harvest::mask_secrets(text);
    *count += n;
    out
}

/// The review card's content from what was read, the agents it refused
/// and why, and how many credentials were masked. Pure but for reading the
/// team (names kept for the Chief).
pub fn to_review(e: &Export, chief: &str) -> (Review, Vec<String>, usize) {
    let mut count = 0;
    let mut refused = Vec::new();
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for (i, a) in e.agents.iter().enumerate() {
        if a.is_main {
            notes.push(main_notes(a, &e.source, &mut count));
            continue;
        }
        if proposals.len() >= review::MAX_PROPOSALS {
            refused.push(format!(
                "{}: one import takes {} agents; import again for the rest.",
                a.name,
                review::MAX_PROPOSALS
            ));
            continue;
        }
        let mut m = |s: &str| masked(s, &mut count);
        let pairs =
            |list: &[(String, String)], k1: &str, k2: &str, m: &mut dyn FnMut(&str) -> String| {
                list.iter()
                    .map(|(x, y)| json!({ k1: m(x), k2: m(y) }))
                    .collect::<Vec<_>>()
            };
        let routines = pairs(&a.routines, "when", "what", &mut m);
        let watches = pairs(&a.watches, "when", "what", &mut m);
        let apps = pairs(&a.apps, "name", "purpose", &mut m);
        let logins: Vec<Value> = a
            .logins
            .iter()
            .map(|(n, p, k)| json!({ "name": m(n), "purpose": m(p), "kind": m(k) }))
            .collect();
        let args = json!({
            "name": a.name,
            "role": m(&a.role),
            "instructions": m(&a.instructions),
            "memory": m(&a.memory),
            "preferences": m(&a.preferences),
            "context": m(&a.context),
            "routines": routines,
            "watches": watches,
            "apps": apps,
            "logins": logins,
            "look": a.look,
        });
        match review::proposal(format!("x{i}"), &args, chief) {
            Ok(p)
                if proposals
                    .iter()
                    .any(|q| review::same_name(&q.name, &p.name)) =>
            {
                refused.push(format!(
                    "{}: another agent in it has a name that looks the same.",
                    p.name
                ))
            }
            Ok(p) => proposals.push(p),
            Err(why) => refused.push(format!("{}: {why}", review::clean_line(&a.name, 40))),
        }
    }
    let about = about_notes(e, &mut count);
    if !about.is_empty() {
        notes.push(about);
    }
    let chief_notes = review::clean_text(&notes.join("\n\n"), review::MAX_FIELD_CHARS);
    let review = Review {
        proposals,
        chief_notes: (!chief_notes.is_empty()).then_some(chief_notes),
        summary: None,
        coverage: (e.format == Format::Handover).then(|| coverage(e)),
    };
    (review, refused, count)
}

/// What the other app's main agent was, as notes for the Chief: never its
/// instructions (the Chief's are the app's), only offered on the card.
fn main_notes(a: &Agent, source: &str, count: &mut usize) -> String {
    let mut out = vec![format!(
        "What {} ({source}'s main agent) was told and knew:",
        a.name
    )];
    for (label, text) in [
        ("Its instructions there", &a.instructions),
        ("What it remembered", &a.memory),
        ("Preferences", &a.preferences),
        ("Context", &a.context),
    ] {
        if !text.trim().is_empty() {
            out.push(format!("{label}:\n{}", masked(text.trim(), count)));
        }
    }
    let routines: Vec<String> = a
        .routines
        .iter()
        .map(|(w, x)| format!("- {}: {}", masked(w, count), masked(x, count)))
        .collect();
    if !routines.is_empty() {
        out.push(format!(
            "Its routines there (not scheduled here; ask to set any up):\n{}",
            routines.join("\n")
        ));
    }
    out.join("\n\n")
}

fn about_notes(e: &Export, count: &mut usize) -> String {
    let mut out = Vec::new();
    for area in ABOUT {
        let Some(facts) = e.about.get(area.key()).filter(|f| !f.is_empty()) else {
            continue;
        };
        let lines: Vec<String> = facts
            .iter()
            .map(|f| format!("- {}", masked(f, count)))
            .collect();
        out.push(format!("{}:\n{}", area.label(), lines.join("\n")));
    }
    out.join("\n\n")
}

/// The card's account of what came, by area, with every gap.
fn coverage(e: &Export) -> CoverageReport {
    let gaps = gaps(e);
    let agent_gap = e
        .agents
        .iter()
        .any(|a| gaps.iter().any(|g| g.starts_with(&format!("{}:", a.name))));
    let routines: usize = e.agents.iter().map(|a| a.routines.len()).sum();
    let mut areas = vec![
        AreaLine {
            area: Area::Agents,
            label: Area::Agents.label().into(),
            facts: e.agents.len(),
            none: false,
            gap: agent_gap.then(|| "some agents came without everything".to_string()),
        },
        AreaLine {
            area: Area::Routines,
            label: Area::Routines.label().into(),
            facts: routines,
            none: routines == 0 && e.agents.iter().all(|a| a.sent.contains("routines")),
            gap: (routines == 0 && !e.agents.iter().all(|a| a.sent.contains("routines")))
                .then(|| "not sent".to_string()),
        },
    ];
    for area in ABOUT {
        let facts = e.about.get(area.key());
        areas.push(AreaLine {
            area,
            label: area.label().into(),
            facts: facts.map_or(0, Vec::len),
            none: facts.is_some_and(Vec::is_empty),
            gap: facts.is_none().then(|| "not sent".to_string()),
        });
    }
    CoverageReport {
        areas,
        open_mentions: Vec::new(),
        capped: false,
    }
}

/// What the preview shows: read again by the post, never trusted from here.
pub fn preview(e: &Export) -> Preview {
    let chief = chief_name();
    let (review, refused, masked) = to_review(e, &chief);
    let about = ABOUT
        .iter()
        .filter_map(|a| {
            e.about
                .get(a.key())
                .filter(|f| !f.is_empty())
                .map(|f| (a.label().to_string(), f.len()))
        })
        .collect();
    Preview {
        source: source_name(e),
        format: e.format.label().into(),
        verified: e.format.verified(),
        agents: review
            .proposals
            .iter()
            .map(|p| PreviewAgent {
                name: p.name.clone(),
                role: p.role.clone(),
                instructions_chars: p.instructions.chars().count(),
                memory_lines: p.memory.lines().filter(|l| !l.trim().is_empty()).count(),
                routines: p.routines.len(),
                watches: p.watches.len(),
                apps: p.apps.len(),
            })
            .collect(),
        main: e.agents.iter().find(|a| a.is_main).map(|a| a.name.clone()),
        about,
        problems: e.problems.clone(),
        refused,
        gaps: gaps(e),
        follow_up: follow_up(e),
        masked,
        read: e.read.clone(),
        skipped: e.skipped.clone(),
    }
}

fn chief() -> Result<store::Agent, CommandError> {
    store::list()?
        .into_iter()
        .find(|a| a.is_main)
        .ok_or_else(|| CommandError::expected("There's no Chief of Staff to review it with yet."))
}

fn chief_name() -> String {
    chief().map(|c| c.name).unwrap_or_default()
}

/// Who it says it's from, or what it is, when that can't be used.
fn source_name(e: &Export) -> String {
    let fallback = e.format.source_name().to_string();
    if e.source.trim().is_empty() {
        return fallback;
    }
    super::connector::clean_source(&e.source, &chief_name()).unwrap_or(fallback)
}

/// Where the card went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Posted {
    pub chief_id: String,
    pub request_id: String,
    pub agents: usize,
}

/// Put the review card up in the Chief's chat. Read afresh by the caller
/// (never the preview's copy); refuses while anything blocks it.
pub fn post(app: &AppHandle, e: &Export) -> Result<Posted, CommandError> {
    if !e.problems.is_empty() {
        return Err(super::err_invalid("export", e.problems.join("\n")));
    }
    let chief = chief()?;
    let (review, refused, masked) = to_review(e, &chief.name);
    if review.proposals.is_empty() && review.chief_notes.is_none() {
        let why = if refused.is_empty() {
            "There are no agents in it.".to_string()
        } else {
            refused.join("\n")
        };
        return Err(super::err_invalid("export", why));
    }
    let source = source_name(e);
    let review = review::with_arrival(review::with_clashes(review), &source);
    let agents = review.proposals.len();
    let talk_id = format!("{TALK_PREFIX}{}", store::new_id());
    let request_id = super::connector::post_review_card(app, &chief.id, &talk_id, &source, review)
        .ok_or_else(|| CommandError::expected("Couldn't put the review in the chat."))?;
    // What didn't make the card is said beside it, so nothing goes quietly.
    let mut said = Vec::new();
    if !refused.is_empty() {
        said.push(format!("Not on the card: {}.", refused.join("; ")));
    }
    if masked > 0 {
        said.push(format!(
            "{masked} thing{} that looked like a password or key {} replaced with [removed].",
            if masked == 1 { "" } else { "s" },
            if masked == 1 { "was" } else { "were" }
        ));
    }
    if !said.is_empty() {
        let _ = super::runner::record(
            app,
            super::runner::new_message(&chief.id, store::MessageKind::Note, said.join(" ")),
        );
    }
    tracing::info!(
        format = e.format.label(),
        agents,
        refused = refused.len(),
        masked,
        "[Agents] import review put up from an export"
    );
    Ok(Posted {
        chief_id: chief.id,
        request_id,
        agents,
    })
}

#[cfg(test)]
#[path = "import_export_tests.rs"]
mod tests;
