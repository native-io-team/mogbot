//! What a turn did: the "Worked 6 min · 23 steps · edited 2 files" line
//! under a reply, and the steps behind it.
//!
//! Every step is something the engine's own output said it did — a tool call
//! (Claude Code's `tool_use`, a Codex item), an approval card, a screenshot —
//! labelled in plain words ("Read Hero.tsx", "Ran npm test", "Messaged Acme
//! Site"). Nothing is inferred: a turn with no steps has no timeline.
//!
//! While the turn runs the steps ride on its status (the newest
//! [`LIVE_STEPS`] of them), so the working line can open into them. When it
//! ends they are written to `<home>/turns/<message-id>.json`, keyed by the
//! last message the turn left (its reply, its error, or "Stopped"), and that
//! message is sent again carrying them. The chat log itself is never touched:
//! `messages.jsonl` stays append-only and readable by builds that predate
//! this, which simply show no timeline.
//!
//! Bounded and scrubbed: at most [`MAX_STEPS`] steps (the newest) with
//! labels of at most [`LABEL_CHARS`], at most [`MAX_FILES`] file names. Tool
//! inputs are never stored, only the label made from them, and a label goes
//! through the Keychain redaction plus [`scrub`], which blanks anything
//! shaped like a credential (a `TOKEN=…`, a bearer header, a key prefix).

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::attachments::Attachment;
use super::store::{self, AgentMessage, MessageKind};

/// Steps kept per turn (the newest); the count still says how many there were.
pub const MAX_STEPS: usize = 60;
/// Steps carried live on the status, which is sent on every step.
pub const LIVE_STEPS: usize = 12;
/// Longest label kept, in characters.
pub const LABEL_CHARS: usize = 100;
/// File names kept per turn.
pub const MAX_FILES: usize = 30;

/// What kind of thing a step was, for its icon. Unknown kinds (a newer
/// build's) read as `Tool`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Read,
    Edit,
    Search,
    Web,
    Command,
    Message,
    Approval,
    Screenshot,
    Plan,
    Delegate,
    Project,
    #[serde(other)]
    Tool,
}

/// One step, as stored and shown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkStep {
    /// When it was seen, ms since the epoch.
    pub at: i64,
    pub kind: StepKind,
    pub label: String,
    /// A screenshot this step produced (an attachment of a `session` line).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<Attachment>,
}

/// A turn's timeline. Live (on the status) while it runs, `endedAt` once over.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnWork {
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Every step seen, including any no longer kept in `steps`.
    pub step_count: u32,
    /// The newest steps, oldest first.
    pub steps: Vec<WorkStep>,
    /// Files it edited (as named in its edit calls), distinct.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// How many distinct files it edited, including any not kept in `files`.
    #[serde(default)]
    pub file_count: u32,
}

/// A tool call, as the parsers describe it.
#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    /// The engine's id for the call, so a call reported twice is one step.
    pub id: Option<String>,
    pub kind: StepKind,
    /// What it did, for the timeline ("Read Hero.tsx").
    pub label: String,
    /// What it's doing, for the working line ("Reading Hero.tsx").
    pub doing: String,
    /// Full paths it edits, for counting distinct files.
    pub files: Vec<String>,
}

// ============================================================================
// Describing tool calls
// ============================================================================

/// The tool calls in one line of Claude Code's stream-json (an `assistant`
/// event), in order. Sub-agent calls count: they are work done for this turn.
pub fn claude_actions(value: &Value) -> Vec<Action> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|b| {
            let name = b.get("name")?.as_str()?;
            let mut action = describe_tool(name, b.get("input"))?;
            action.id = b.get("id").and_then(Value::as_str).map(String::from);
            Some(action)
        })
        .collect()
}

fn file_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// `"a long query"` in curly quotes, cut to fit.
fn quoted(text: &str) -> String {
    format!("“{}”", clip(text.trim(), 60))
}

/// One Claude Code tool call (or the Claude-shaped equivalent of a Codex
/// item) in plain words. `None` only for a call with no name.
pub fn describe_tool(name: &str, input: Option<&Value>) -> Option<Action> {
    if name.is_empty() {
        return None;
    }
    let field = |k: &str| {
        input
            .and_then(|i| i.get(k))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let act = |kind, label: String, doing: String| Action {
        id: None,
        kind,
        label,
        doing,
        files: Vec::new(),
    };
    let ours = format!("mcp__{}__", super::prompts::SERVER_KEY);
    if let Some(tool) = name.strip_prefix(&ours) {
        let named = |k: &str| field(k).unwrap_or_default();
        return Some(match tool {
            "message_agent" => act(
                StepKind::Message,
                format!("Messaged {}", named("agent")),
                format!("Messaging {}", named("agent")),
            ),
            "create_agent" => act(
                StepKind::Delegate,
                format!("Created {}", named("name")),
                format!("Creating {}", named("name")),
            ),
            "list_agents" => act(
                StepKind::Message,
                "Checked on the team".into(),
                "Checking on the team".into(),
            ),
            "project_list" => act(
                StepKind::Project,
                "Looked at your projects".into(),
                "Looking at your projects".into(),
            ),
            "project_create" => act(
                StepKind::Project,
                format!("Created the project {}", named("name")),
                format!("Creating {}", named("name")),
            ),
            "session_message" | "session_start" => act(
                StepKind::Project,
                format!("Worked in {}", file_name(&named("project"))),
                format!("Working in {}", file_name(&named("project"))),
            ),
            "session_wait" | "session_progress" => act(
                StepKind::Project,
                format!("Followed {}", file_name(&named("project"))),
                format!("Following {}", file_name(&named("project"))),
            ),
            "preview_screenshot" => act(
                StepKind::Screenshot,
                format!("Took a screenshot of {}", file_name(&named("project"))),
                format!("Looking at {}", file_name(&named("project"))),
            ),
            "push" => act(
                StepKind::Project,
                format!("Pushed {}", file_name(&named("project"))),
                format!("Pushing {}", file_name(&named("project"))),
            ),
            other => {
                let words = sentence(&other.replace('_', " "));
                act(StepKind::Tool, words.clone(), words)
            }
        });
    }
    if let Some(rest) = name.strip_prefix("mcp__") {
        // Someone else's MCP server: "Used navigate (claude-in-chrome)".
        let (server, tool) = rest.split_once("__").unwrap_or(("", rest));
        let tool = tool.replace('_', " ");
        let from = if server.is_empty() {
            String::new()
        } else {
            format!(" ({})", server.replace('_', " "))
        };
        return Some(act(
            StepKind::Tool,
            format!("Used {tool}{from}"),
            format!("Using {tool}"),
        ));
    }
    Some(match name {
        "Read" | "NotebookRead" => match field("file_path").or_else(|| field("notebook_path")) {
            Some(path) => act(
                StepKind::Read,
                format!("Read {}", file_name(&path)),
                format!("Reading {}", file_name(&path)),
            ),
            None => act(
                StepKind::Read,
                "Read a file".into(),
                "Reading a file".into(),
            ),
        },
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let path = field("file_path").or_else(|| field("notebook_path"));
            let verb = if name == "Write" { "Wrote" } else { "Edited" };
            let mut a = match &path {
                Some(path) => act(
                    StepKind::Edit,
                    format!("{verb} {}", file_name(path)),
                    format!("Editing {}", file_name(path)),
                ),
                None => act(
                    StepKind::Edit,
                    "Edited files".into(),
                    "Editing files".into(),
                ),
            };
            a.files.extend(path);
            a
        }
        "Bash" => match field("command") {
            Some(cmd) => {
                let line = cmd.lines().next().unwrap_or("").trim().to_string();
                act(
                    StepKind::Command,
                    format!("Ran {}", clip(&line, 80)),
                    format!("Running {}", clip(&line, 80)),
                )
            }
            None => act(
                StepKind::Command,
                "Ran a command".into(),
                "Running a command".into(),
            ),
        },
        "Grep" => match field("pattern") {
            Some(p) => act(
                StepKind::Search,
                format!("Searched for {}", quoted(&p)),
                format!("Searching for {}", quoted(&p)),
            ),
            None => act(StepKind::Search, "Searched".into(), "Searching".into()),
        },
        "Glob" | "LS" => match field("pattern").or_else(|| field("path")) {
            Some(p) => act(
                StepKind::Search,
                format!("Listed {}", clip(&p, 60)),
                format!("Listing {}", clip(&p, 60)),
            ),
            None => act(
                StepKind::Search,
                "Listed files".into(),
                "Listing files".into(),
            ),
        },
        "WebSearch" => match field("query") {
            Some(q) => act(
                StepKind::Web,
                format!("Searched the web for {}", quoted(&q)),
                format!("Searching the web for {}", quoted(&q)),
            ),
            None => act(
                StepKind::Web,
                "Searched the web".into(),
                "Searching the web".into(),
            ),
        },
        "WebFetch" => match field("url") {
            Some(url) => {
                let host = url::Url::parse(&url)
                    .ok()
                    .and_then(|u| {
                        u.host_str()
                            .map(|h| h.trim_start_matches("www.").to_string())
                    })
                    .unwrap_or_else(|| clip(&url, 60));
                act(
                    StepKind::Web,
                    format!("Opened {host}"),
                    format!("Reading {host}"),
                )
            }
            None => act(
                StepKind::Web,
                "Opened a web page".into(),
                "Reading a web page".into(),
            ),
        },
        "Task" | "Agent" => match field("description") {
            Some(d) => act(
                StepKind::Delegate,
                format!("Ran a sub-task: {}", clip(&d, 60)),
                "Working on a sub-task".into(),
            ),
            None => act(
                StepKind::Delegate,
                "Ran a sub-task".into(),
                "Working on a sub-task".into(),
            ),
        },
        "TodoWrite" => act(StepKind::Plan, "Updated its plan".into(), "Planning".into()),
        other => act(
            StepKind::Tool,
            format!("Used {other}"),
            format!("Using {other}"),
        ),
    })
}

fn sentence(text: &str) -> String {
    let mut chars = text.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// At most `max` characters, an ellipsis if anything was cut.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

// ============================================================================
// Scrubbing
// ============================================================================

const SECRET_WORDS: [&str; 9] = [
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "pass",
    "auth",
    "credential",
    "session",
];

const SECRET_PREFIXES: [&str; 10] = [
    "sk-",
    "sk_",
    "pk_live",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "xox",
    "glpat-",
    "AKIA",
];

fn secretish_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| lower.contains(w))
}

/// Long, mixed letters and digits, not a path or a file name: a token.
fn looks_like_token(word: &str) -> bool {
    let w = word.trim_matches(|c: char| "\"'`,;()[]{}".contains(c));
    if SECRET_PREFIXES.iter().any(|p| w.starts_with(p)) && w.len() >= 12 {
        return true;
    }
    if w.starts_with("eyJ") && w.len() >= 24 {
        return true; // a JWT
    }
    w.len() >= 32
        && !w.contains('/')
        && !w.contains('.')
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_+=".contains(c))
}

/// A label with anything shaped like a credential blanked to `…`: values of
/// secret-sounding variables and flags, bearer headers, URL passwords, and
/// long tokens. Errs towards blanking; a label is for reading, not rerunning.
pub fn scrub(label: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut blank_next = false;
    for word in label.split(' ') {
        if blank_next && !word.is_empty() {
            blank_next = false;
            out.push("…".into());
            continue;
        }
        let bare = word.trim_matches(|c: char| "\"'`".contains(c));
        let lower = bare.to_ascii_lowercase();
        // `Authorization: Bearer x`, `-u user:pass`, `--token x`
        if matches!(lower.as_str(), "bearer" | "basic" | "-u" | "--user")
            || (lower.starts_with("--") && secretish_name(&lower) && !lower.contains('='))
        {
            out.push(word.to_string());
            blank_next = true;
            continue;
        }
        // NAME=value / --name=value / ?api_key=value
        if let Some((name, _)) = bare.split_once('=') {
            let name = name.rsplit(['?', '&']).next().unwrap_or(name);
            if secretish_name(name) && !name.is_empty() {
                let keep = &bare[..bare.find('=').unwrap_or(0) + 1];
                out.push(format!("{keep}…"));
                continue;
            }
        }
        // https://user:pass@host
        if let Some(at) = bare.find("://").and_then(|s| {
            let rest = &bare[s + 3..];
            let at = rest.find('@')?;
            rest[..at].contains(':').then_some((s + 3, s + 3 + at))
        }) {
            out.push(format!("{}…{}", &bare[..at.0], &bare[at.1..]));
            continue;
        }
        if looks_like_token(word) {
            out.push("…".into());
            continue;
        }
        out.push(word.to_string());
    }
    out.join(" ")
}

/// Everything a label goes through before it is shown or kept.
fn clean(label: &str) -> String {
    let redacted = super::secrets::redact(label);
    clip(&scrub(&redacted), LABEL_CHARS)
}

// ============================================================================
// The turn in progress
// ============================================================================

#[derive(Default)]
struct Live {
    work: TurnWork,
    /// Call ids seen, and where each one's step is (its index among all steps).
    calls: HashMap<String, u32>,
    files: HashSet<String>,
    /// The newest message the turn left that a timeline can hang under.
    anchor: Option<AgentMessage>,
}

impl Live {
    fn push(&mut self, step: WorkStep) {
        self.work.step_count = self.work.step_count.saturating_add(1);
        self.work.steps.push(step);
        if self.work.steps.len() > MAX_STEPS {
            let over = self.work.steps.len() - MAX_STEPS;
            self.work.steps.drain(..over);
        }
    }

    /// The step at absolute index `n`, if it's still kept.
    fn step_mut(&mut self, n: u32) -> Option<&mut WorkStep> {
        let first = self.work.step_count as usize - self.work.steps.len();
        let at = (n as usize).checked_sub(first)?;
        self.work.steps.get_mut(at)
    }

    fn action(&mut self, action: Action, now: i64) {
        for path in action.files {
            if self.files.insert(path.clone()) {
                self.work.file_count = self.work.file_count.saturating_add(1);
                if self.work.files.len() < MAX_FILES {
                    self.work.files.push(clip(file_name(&path), LABEL_CHARS));
                }
            }
        }
        let label = clean(&action.label);
        // The same call reported again (Codex says so as it starts and as it
        // ends): one step, with the better description.
        if let Some(id) = &action.id {
            if let Some(&n) = self.calls.get(id) {
                if let Some(step) = self.step_mut(n) {
                    step.label = label;
                }
                return;
            }
            self.calls.insert(id.clone(), self.work.step_count);
        }
        self.push(WorkStep {
            at: now,
            kind: action.kind,
            label,
            image: None,
        });
    }

    /// A message the turn recorded.
    fn message(&mut self, message: &AgentMessage) {
        match message.kind {
            MessageKind::Agent | MessageKind::Error | MessageKind::Note => {
                self.anchor = Some(message.clone());
            }
            MessageKind::Approval => {
                if let Some(approval) = &message.approval {
                    self.push(WorkStep {
                        at: message.ts,
                        kind: StepKind::Approval,
                        label: clean(&format!("Asked you to approve: {}", approval.title)),
                        image: None,
                    });
                }
            }
            MessageKind::Session => {
                let shot = message
                    .session
                    .as_ref()
                    .is_some_and(|s| s.event == super::sessions::SessionEvent::Screenshot);
                let Some(image) = message.attachments.first().filter(|_| shot) else {
                    return;
                };
                // The screenshot call's own step gets its picture; any other
                // (a second device, or one a session reply came with) is a step.
                if let Some(last) = self.work.steps.last_mut().filter(|s| {
                    s.image.is_none() && matches!(s.kind, StepKind::Screenshot | StepKind::Project)
                }) {
                    last.image = Some(image.clone());
                    return;
                }
                let project = message
                    .session
                    .as_ref()
                    .map(|s| file_name(&s.project).to_string())
                    .unwrap_or_default();
                self.push(WorkStep {
                    at: message.ts,
                    kind: StepKind::Screenshot,
                    label: clean(&format!("Took a screenshot of {project}")),
                    image: Some(image.clone()),
                });
            }
            _ => {}
        }
    }
}

static LIVE: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_live<T>(agent_id: &str, f: impl FnOnce(&mut Live) -> T) -> Option<T> {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(agent_id)
        .map(f)
}

/// A turn starts: a fresh timeline.
pub fn begin(agent_id: &str, now: i64) {
    let live = Live {
        work: TurnWork {
            started_at: now,
            ..TurnWork::default()
        },
        ..Live::default()
    };
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), live);
}

/// A tool call the turn made. Its working-line words are returned.
pub fn on_action(agent_id: &str, action: Action, now: i64) -> String {
    let doing = clean(&action.doing);
    with_live(agent_id, |live| live.action(action, now));
    doing
}

/// A message the turn recorded (called for every message; ignored between turns).
pub fn on_message(message: &AgentMessage) {
    with_live(&message.agent_id, |live| live.message(message));
}

/// The timeline so far, newest [`LIVE_STEPS`] only, for the status.
pub fn live(agent_id: &str) -> Option<TurnWork> {
    with_live(agent_id, |live| {
        let mut work = live.work.clone();
        let from = work.steps.len().saturating_sub(LIVE_STEPS);
        work.steps.drain(..from);
        work
    })
    .filter(|w| w.step_count > 0)
}

/// The turn is over: keep its timeline under the last message it left, and
/// send that message again carrying it. A turn without steps keeps nothing.
pub fn finish(app: &AppHandle, agent_id: &str, now: i64) {
    let Some(live) = LIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
    else {
        return;
    };
    let Some((message, work)) = settle(live, now) else {
        return;
    };
    if let Err(e) = save(agent_id, &message.id, &work) {
        tracing::warn!("[Agents] couldn't keep the timeline for {agent_id}: {e}");
        return;
    }
    let mut message = message;
    message.work = Some(work);
    let _ = app.emit(super::runner::EVENT_MESSAGE, &message);
}

fn settle(live: Live, now: i64) -> Option<(AgentMessage, TurnWork)> {
    if live.work.step_count == 0 {
        return None;
    }
    let mut work = live.work;
    work.ended_at = Some(now.max(work.started_at));
    Some((live.anchor?, work))
}

// ============================================================================
// On disk: <home>/turns/<message-id>.json
// ============================================================================

fn path_for(agent_id: &str, message_id: &str) -> Option<std::path::PathBuf> {
    let safe = !message_id.is_empty()
        && message_id.len() <= 64
        && message_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe {
        return None;
    }
    Some(
        store::agent_home(agent_id)
            .ok()?
            .join("turns")
            .join(format!("{message_id}.json")),
    )
}

fn save(agent_id: &str, message_id: &str, work: &TurnWork) -> Result<(), String> {
    let path = path_for(agent_id, message_id).ok_or("not a message id")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut value = serde_json::to_value(work).map_err(|e| e.to_string())?;
    super::secrets::redact_value(&mut value);
    let raw = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The timeline kept under this message, if any.
pub fn load(agent_id: &str, message_id: &str) -> Option<TurnWork> {
    let raw = std::fs::read(path_for(agent_id, message_id)?).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Give each message in a page the timeline kept under it.
pub fn apply(agent_id: &str, page: &mut [AgentMessage]) {
    let Some(dir) = store::agent_home(agent_id).ok().map(|h| h.join("turns")) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    for message in page.iter_mut().filter(|m| {
        matches!(
            m.kind,
            MessageKind::Agent | MessageKind::Error | MessageKind::Note
        )
    }) {
        if let Some(work) = load(agent_id, &message.id) {
            message.work = Some(work);
        }
    }
}

/// The timeline file a message's deletion should take with it.
pub fn forget(agent_id: &str, message_id: &str) {
    if let Some(path) = path_for(agent_id, message_id) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = include_str!("testdata/stream-partial.jsonl");
    const CODEX_EXEC: &str = include_str!("testdata/codex-exec.jsonl");
    const CODEX_APP: &str = include_str!("testdata/codex-app-server.jsonl");

    fn lines(sample: &str) -> impl Iterator<Item = Value> + '_ {
        sample.lines().filter_map(|l| serde_json::from_str(l).ok())
    }

    fn message(kind: MessageKind, id: &str) -> AgentMessage {
        let mut m = super::super::runner::new_message("a1", kind, "hi");
        m.id = id.into();
        m
    }

    #[test]
    fn a_real_claude_turn_has_one_step_per_tool_call() {
        let actions: Vec<Action> = lines(CLAUDE).flat_map(|v| claude_actions(&v)).collect();
        assert_eq!(
            actions.len(),
            1,
            "one Bash call; stream events aren't steps"
        );
        assert_eq!(actions[0].kind, StepKind::Command);
        assert_eq!(actions[0].label, "Ran echo hi");
        assert_eq!(actions[0].doing, "Running echo hi");
        assert_eq!(
            actions[0].id.as_deref(),
            Some("toolu_01Bx3SDHNvfg9pLufm1c4tQQ")
        );
    }

    #[test]
    fn a_real_codex_exec_turn_maps_onto_the_same_steps() {
        let actions: Vec<Action> = lines(CODEX_EXEC)
            .flat_map(|v| super::super::codex::steps(&v))
            .filter_map(|s| match s {
                super::super::stream::Step::Action(a) => Some(a),
                _ => None,
            })
            .collect();
        let labels: Vec<&str> = actions.iter().map(|a| a.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Ran echo hi > note.txt && cat note.txt",
                "Checked on the team"
            ]
        );
        // Started and completed are one step, not two.
        let mut live = Live::default();
        for a in actions {
            live.action(a, 1);
        }
        assert_eq!(live.work.step_count, 2);
    }

    #[test]
    fn a_real_codex_app_server_turn_maps_onto_the_same_steps() {
        let mut conversation = super::super::codex_app::Conversation::new(
            None,
            std::path::Path::new("/h/a"),
            None,
            "",
            "run it",
        )
        .0;
        let mut live = Live::default();
        for value in lines(CODEX_APP) {
            for out in conversation.on_message(&value) {
                if let super::super::codex_app::Out::Step(super::super::stream::Step::Action(a)) =
                    out
                {
                    live.action(a, 1);
                }
            }
        }
        assert_eq!(live.work.step_count, 1);
        assert_eq!(
            live.work.steps[0].label,
            "Ran echo esc-ok > /tmp/ss-probe-esc.txt"
        );
    }

    #[test]
    fn tool_calls_read_as_plain_words() {
        let d = |name: &str, input: Value| describe_tool(name, Some(&input)).unwrap().label;
        assert_eq!(
            d("Read", serde_json::json!({"file_path": "/a/src/Hero.tsx"})),
            "Read Hero.tsx"
        );
        assert_eq!(
            d("WebSearch", serde_json::json!({"query": "best espresso"})),
            "Searched the web for “best espresso”"
        );
        assert_eq!(
            d(
                "WebFetch",
                serde_json::json!({"url": "https://www.example.com/a?b"})
            ),
            "Opened example.com"
        );
        assert_eq!(
            d("Bash", serde_json::json!({"command": "npm test\nmore"})),
            "Ran npm test"
        );
        let ours = format!("mcp__{}__message_agent", super::super::prompts::SERVER_KEY);
        assert_eq!(
            d(&ours, serde_json::json!({"agent": "Acme Site"})),
            "Messaged Acme Site"
        );
        assert_eq!(
            d("mcp__claude-in-chrome__navigate", serde_json::json!({})),
            "Used navigate (claude-in-chrome)"
        );
        let edit = describe_tool(
            "Edit",
            Some(&serde_json::json!({"file_path": "/p/App.tsx"})),
        )
        .unwrap();
        assert_eq!(
            (edit.label.as_str(), edit.doing.as_str()),
            ("Edited App.tsx", "Editing App.tsx")
        );
        assert_eq!(edit.files, ["/p/App.tsx"]);
    }

    #[test]
    fn credentials_never_reach_a_label() {
        for (raw, want) in [
            (
                "Ran STRIPE_KEY=sk_live_abcdefghijklmnop npm run x",
                "Ran STRIPE_KEY=… npm run x",
            ),
            (
                "Ran curl -H Authorization: Bearer abc.def.ghi https://x.io",
                "Ran curl -H Authorization: Bearer … https://x.io",
            ),
            (
                "Ran git clone https://me:hunter2@github.com/a/b",
                "Ran git clone https://…@github.com/a/b",
            ),
            ("Ran deploy --token abcd", "Ran deploy --token …"),
            ("Ran echo ghp_0123456789abcdefABCDEF", "Ran echo …"),
            (
                "Opened https://x.io/?api_key=123",
                "Opened https://x.io/?api_key=…",
            ),
            (
                "Ran npm test -- src/App.test.tsx",
                "Ran npm test -- src/App.test.tsx",
            ),
        ] {
            assert_eq!(scrub(raw), want, "{raw}");
        }
    }

    #[test]
    fn a_turn_is_bounded() {
        let mut live = Live::default();
        for n in 0..(MAX_STEPS + 15) {
            let mut a = describe_tool(
                "Edit",
                Some(&serde_json::json!({"file_path": format!("/p/f{n}.ts")})),
            )
            .unwrap();
            a.label = "x".repeat(500);
            live.action(a, n as i64);
        }
        assert_eq!(live.work.step_count as usize, MAX_STEPS + 15);
        assert_eq!(live.work.steps.len(), MAX_STEPS);
        assert_eq!(live.work.steps[0].at, 15, "the newest are kept");
        assert!(live
            .work
            .steps
            .iter()
            .all(|s| s.label.chars().count() <= LABEL_CHARS));
        assert_eq!(live.work.file_count as usize, MAX_STEPS + 15);
        assert_eq!(live.work.files.len(), MAX_FILES);
    }

    #[test]
    fn an_edit_to_the_same_file_twice_is_one_file() {
        let mut live = Live::default();
        for _ in 0..3 {
            let a = describe_tool(
                "Edit",
                Some(&serde_json::json!({"file_path": "/p/App.tsx"})),
            )
            .unwrap();
            live.action(a, 0);
        }
        assert_eq!((live.work.step_count, live.work.file_count), (3, 1));
        assert_eq!(live.work.files, ["App.tsx"]);
    }

    #[test]
    fn approvals_and_screenshots_are_steps_and_the_last_reply_is_the_anchor() {
        let mut live = Live::default();
        let ours = format!(
            "mcp__{}__preview_screenshot",
            super::super::prompts::SERVER_KEY
        );
        live.action(
            describe_tool(&ours, Some(&serde_json::json!({"project": "/p/acme"}))).unwrap(),
            1,
        );
        let mut shot = message(MessageKind::Session, "s1");
        shot.session = Some(super::super::sessions::SessionMark {
            project: "/p/acme".into(),
            event: super::super::sessions::SessionEvent::Screenshot,
            session_id: None,
            tab: None,
            cli: None,
        });
        shot.attachments = vec![Attachment {
            name: "acme-desktop.jpg".into(),
            path: "attachments/s1/acme-desktop.jpg".into(),
            mime: "image/jpeg".into(),
            size: 10,
        }];
        live.message(&shot);
        live.message(&shot); // the phone-sized one
        live.message(&message(MessageKind::Agent, "r1"));
        live.message(&message(MessageKind::Agent, "r2"));
        live.message(&message(MessageKind::User, "u1"));
        assert_eq!(live.work.step_count, 2);
        assert!(live.work.steps.iter().all(|s| s.image.is_some()));
        assert_eq!(live.work.steps[0].label, "Took a screenshot of acme");
        let (anchor, work) = settle(live, 9).unwrap();
        assert_eq!(anchor.id, "r2");
        assert_eq!(work.ended_at, Some(9));
    }

    #[test]
    fn a_turn_without_steps_keeps_nothing() {
        let mut live = Live::default();
        live.message(&message(MessageKind::Agent, "r1"));
        assert!(settle(live, 1).is_none());
    }

    #[test]
    fn kept_on_disk_beside_the_log_never_in_it() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let agent_id = "a1";
        let work = TurnWork {
            started_at: 1,
            ended_at: Some(2),
            step_count: 1,
            steps: vec![WorkStep {
                at: 1,
                kind: StepKind::Read,
                label: "Read a.ts".into(),
                image: None,
            }],
            files: vec![],
            file_count: 0,
        };
        let id = store::new_id();
        save(agent_id, &id, &work).unwrap();
        assert_eq!(load(agent_id, &id), Some(work.clone()));
        let mut page = vec![
            message(MessageKind::Agent, &id),
            message(MessageKind::User, "u"),
        ];
        apply(agent_id, &mut page);
        assert_eq!(page[0].work.as_ref(), Some(&work));
        assert!(page[1].work.is_none());
        // Never a path out of the home.
        assert!(path_for(agent_id, "../x").is_none());
        forget(agent_id, &id);
        assert!(load(agent_id, &id).is_none());
        store::set_root_for_tests(None);
    }

    #[test]
    fn an_older_build_reads_a_message_carrying_work() {
        // What a newer build would send: an unknown step kind still reads.
        let raw =
            r#"{"startedAt":1,"stepCount":1,"steps":[{"at":1,"kind":"teleport","label":"x"}]}"#;
        let work: TurnWork = serde_json::from_str(raw).unwrap();
        assert_eq!(work.steps[0].kind, StepKind::Tool);
    }
}
