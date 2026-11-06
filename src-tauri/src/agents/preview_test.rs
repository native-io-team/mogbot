//! Preview and test a project from a chat card.
//!
//! - **Preview** on a result or copy card opens a pane beside the chat with
//!   the project's own dev server in it (the agent's copy when the card is a
//!   live copy's, otherwise the project). Which folder that is comes from the
//!   card as the log has it ([`target_path`]), never from a path the client
//!   names, and a project must still be one of the user's projects.
//! - **Test it** asks the agent to click through the site in that pane while
//!   the user watches. The pane registers itself ([`attach_pane`]); the agent
//!   bridge then routes preview tool calls for that folder to it. The agent
//!   gets `test_*` tools for as long as the run is open — only after the user
//!   pressed Test it, only for that folder, and only while the pane is open.
//!   Clicking around the user's own localhost is local work, so these never
//!   raise a card (the same answer "Go hard" gives local work), and they can
//!   reach nothing but that page.
//! - **Each step is observed**, not reported: a click that matched nothing is
//!   "Couldn't click …", whatever the agent says next. The console errors on
//!   the report are read from the preview's own console capture. The outcome,
//!   the summary and what's broken are the agent's words.
//! - **The report is a new version** of the card it was started from
//!   ([`report_message`]), staged for the turn's end like `share_result`. A
//!   live copy's card stays the copy's card (Keep / Discard carry over). A run
//!   whose turn ends without a report leaves a line saying so: nothing goes
//!   silent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::attachments::Attachment;
use super::results::ResultCard;
use super::store::{self, AgentMessage, MessageKind};
use super::task::TaskCopy;

/// The event every pane listens to: one run's state, whole.
pub const EVENT_TEST: &str = "agents://preview-test";

/// Steps one run may record; past it, actions still run but say so.
pub const MAX_STEPS: usize = 60;
/// Screenshots one run may keep (the phone's strip, the card's pictures).
pub const MAX_SHOTS: usize = 8;
pub const MAX_SUMMARY: usize = 600;
/// One line of "broken", a note, or a step's label.
pub const MAX_LINE: usize = 300;
pub const MAX_BROKEN: usize = 8;
/// Console errors kept on a report.
pub const MAX_CONSOLE: usize = 8;
/// Inline screenshots back to the agent above this are named, not sent.
const MAX_INLINE_SHOT_BYTES: u64 = 1_500_000;

// ============================================================================
// What a card previews
// ============================================================================

/// What a Preview opens, resolved from the card as the log has it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    pub agent_id: String,
    pub message_id: String,
    /// The folder whose dev server the pane shows: the copy, or the project.
    pub path: String,
    /// The user's own project the folder belongs to.
    pub project: String,
    /// True when `path` is the agent's open copy of `project`.
    pub copy: bool,
    /// The port its dev server should use: one already serving it in this
    /// app, else the one saved for that folder. `None` means the client picks
    /// its usual port for the folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// A preview proxy already serves this folder (a workspace has it open).
    pub running: bool,
    /// The card's title, for the pane's header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Which folder a card previews, as (folder, project, is the copy).
///
/// A live copy's card previews the copy; a card whose copy was kept or
/// discarded previews the project itself (the copy is gone); a plain change
/// card or a result naming a project previews that project. Anything else
/// has nothing to preview.
pub fn target_path(
    message: &AgentMessage,
    open_copy: Option<&TaskCopy>,
) -> Option<(String, String, bool)> {
    if let Some(changes) = &message.changes {
        if let (Some(copy), Some(open)) = (&changes.copy, open_copy) {
            if copy.id == open.id && copy.path == open.path {
                return Some((open.path.clone(), changes.project.clone(), true));
            }
        }
        return Some((changes.project.clone(), changes.project.clone(), false));
    }
    let project = message.result.as_ref()?.project.clone()?;
    Some((project.clone(), project, false))
}

/// The port to preview on: a server already up in this app wins over the one
/// saved for the folder, so the pane shows what the workspace shows.
pub fn pick_port(live: Option<u16>, saved: Option<u16>) -> Option<u16> {
    live.filter(|p| *p > 0).or(saved.filter(|p| *p > 0))
}

fn same_place(a: &str, b: &str) -> bool {
    a == b
        || match (dunce::canonicalize(a), dunce::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
}

/// Resolve a card's Preview. `projects` is the user's project list: a folder
/// that isn't one of them (and isn't the agent's open copy) is refused.
pub fn resolve(
    agent: &store::Agent,
    message: &AgentMessage,
    projects: &[String],
    live_port: impl Fn(&str) -> Option<u16>,
    saved_port: impl Fn(&str) -> Option<u16>,
) -> Result<PreviewTarget, String> {
    let (path, project, copy) = target_path(message, agent.copy.as_ref())
        .ok_or_else(|| "This card has no project to preview.".to_string())?;
    if !copy && !projects.iter().any(|p| same_place(p, &project)) {
        return Err(format!(
            "{} isn't one of your projects any more, so there's nothing to preview.",
            super::project::folder_name(&project)
        ));
    }
    if !Path::new(&path).is_dir() {
        return Err(if copy {
            "The copy isn't there any more.".to_string()
        } else {
            format!(
                "{} isn't on this Mac any more.",
                super::project::folder_name(&project)
            )
        });
    }
    let live = live_port(&path);
    Ok(PreviewTarget {
        agent_id: agent.id.clone(),
        message_id: message.id.clone(),
        port: pick_port(live, saved_port(&path)),
        running: live.is_some(),
        title: message.result.as_ref().map(|r| r.title.clone()),
        path,
        project,
        copy,
    })
}

// ============================================================================
// The pane: which window is showing which folder
// ============================================================================

static PANES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn key(path: &str) -> String {
    dunce::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// A window's preview pane is (or stops being) live for `path`. One pane per
/// window: attaching another folder replaces that window's earlier one.
pub fn attach_pane(path: &str, window: &str, attached: bool) {
    let mut panes = PANES.lock().unwrap_or_else(|e| e.into_inner());
    let key = key(path);
    if attached {
        panes.retain(|_, w| w != window);
        panes.insert(key, window.to_string());
    } else if panes.get(&key).map(String::as_str) == Some(window) {
        panes.remove(&key);
    }
}

/// The window whose pane shows `path`, if one does.
pub fn pane_window(path: &str) -> Option<String> {
    PANES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key(path))
        .cloned()
}

// ============================================================================
// A test run
// ============================================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Open,
    Click,
    Type,
    Scroll,
    Viewport,
    Look,
    Console,
    Network,
    Shot,
    Note,
}

/// One thing the agent did in the pane, in the app's words (a note is the
/// agent's own).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestStep {
    pub kind: StepKind,
    pub label: String,
    /// False when the action didn't do what was asked, or a note flags a problem.
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot: Option<Attachment>,
    pub ts: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Passed,
    Broken,
}

/// What a test found, on the card it was started from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub outcome: Outcome,
    /// The agent's words.
    pub summary: String,
    /// What's broken, in the agent's words.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub broken: Vec<String>,
    /// Errors the preview's console showed during the run (observed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub console_errors: Vec<String>,
    /// Every step, observed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<TestStep>,
    /// The folder it ran against was the agent's copy.
    #[serde(default)]
    pub on_copy: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Waiting for the agent's turn, or under way.
    Running,
    /// The agent reported; the card's new version follows at the turn's end.
    Reported,
    /// The turn ended without a report, or the user stopped it.
    Stopped,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// Also the id of the card version the report becomes, and the folder
    /// its screenshots are kept in (`attachments/<id>/`).
    pub id: String,
    pub agent_id: String,
    pub message_id: String,
    pub path: String,
    pub project: String,
    pub copy: bool,
    pub title: Option<String>,
    pub started_at: i64,
    pub state: RunState,
    pub steps: Vec<TestStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
}

impl Run {
    fn shots(&self) -> usize {
        self.steps.iter().filter(|s| s.shot.is_some()).count()
    }
}

/// The open (or just finished) run per agent.
static RUNS: LazyLock<Mutex<HashMap<String, Run>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn runs() -> std::sync::MutexGuard<'static, HashMap<String, Run>> {
    RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The agent's run, as it stands.
pub fn run_of(agent_id: &str) -> Option<Run> {
    runs().get(agent_id).cloned()
}

/// True while the agent has a run it may drive.
pub fn is_open(agent_id: &str) -> bool {
    runs()
        .get(agent_id)
        .is_some_and(|r| r.state == RunState::Running)
}

fn emit(app: &AppHandle, run: &Run) {
    let _ = app.emit(EVENT_TEST, run);
}

/// Open a run for a target the user pressed Test it on. Refused while the
/// agent already has one going.
pub fn open(target: &PreviewTarget, now: i64) -> Result<Run, String> {
    let mut all = runs();
    if all
        .get(&target.agent_id)
        .is_some_and(|r| r.state == RunState::Running)
    {
        return Err("A test is already running here.".into());
    }
    let run = Run {
        id: store::new_id(),
        agent_id: target.agent_id.clone(),
        message_id: target.message_id.clone(),
        path: target.path.clone(),
        project: target.project.clone(),
        copy: target.copy,
        title: target.title.clone(),
        started_at: now,
        state: RunState::Running,
        steps: Vec::new(),
        outcome: None,
    };
    all.insert(target.agent_id.clone(), run.clone());
    Ok(run)
}

/// Add a step to the agent's open run; false when there isn't one or it's full.
fn push_step(agent_id: &str, step: TestStep) -> Option<Run> {
    let mut all = runs();
    let run = all.get_mut(agent_id)?;
    if run.state != RunState::Running || run.steps.len() >= MAX_STEPS {
        return None;
    }
    run.steps.push(step);
    Some(run.clone())
}

/// The user stopped it (closed the pane or pressed Stop).
pub fn stop(app: &AppHandle, agent_id: &str) -> bool {
    let stopped = {
        let mut all = runs();
        match all.get_mut(agent_id) {
            Some(run) if run.state == RunState::Running => {
                run.state = RunState::Stopped;
                Some(run.clone())
            }
            _ => None,
        }
    };
    if let Some(run) = &stopped {
        emit(app, run);
    }
    stopped.is_some()
}

/// What happens to a run when a turn ends: one that began after the run was
/// opened is the test's turn, and the run closes with it.
pub fn settle_at_turn_end(run: &Run, turn_started: i64) -> Option<RunState> {
    if turn_started < run.started_at {
        return None;
    }
    Some(match run.state {
        RunState::Running => RunState::Stopped,
        other => other,
    })
}

/// The turn ended (runner): close the agent's run, and say so when it
/// stopped without a report.
pub fn turn_ended(app: &AppHandle, agent_id: &str, turn_started: i64) {
    let ended = {
        let mut all = runs();
        let Some(run) = all.get(agent_id) else {
            return;
        };
        let Some(state) = settle_at_turn_end(run, turn_started) else {
            return;
        };
        let was = run.state;
        let mut run = all.remove(agent_id).expect("checked above");
        run.state = state;
        (run, was)
    };
    let (run, was) = ended;
    if was == RunState::Running {
        let line = super::runner::new_message(
            agent_id,
            MessageKind::Note,
            "The test stopped before it reported back.",
        );
        let _ = super::runner::record(app, line);
    }
    emit(app, &run);
}

// ============================================================================
// Step labels: what the user sees beside the frame
// ============================================================================

fn one_line(raw: &str, max: usize) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// What a click or a field is called: the agent's own name for it, else the
/// visible text it matched, else the selector.
fn target_name(args: &Value) -> String {
    let raw = str_arg(args, "label")
        .or(str_arg(args, "text"))
        .or(str_arg(args, "selector"))
        .unwrap_or("the page");
    format!("“{}”", one_line(raw, 60))
}

/// The label for a step, from the tool, its arguments and whether it worked.
pub fn step_label(tool: &str, args: &Value, ok: bool) -> String {
    match tool {
        "test_open" => {
            let path = str_arg(args, "path").unwrap_or("/");
            if ok {
                format!("Opened {}", one_line(path, 80))
            } else {
                format!("Couldn't open {}", one_line(path, 80))
            }
        }
        "test_click" => {
            let name = target_name(args);
            if ok {
                format!("Clicked {name}")
            } else {
                format!("Couldn't click {name}")
            }
        }
        "test_type" => {
            let name = target_name(args);
            let submit = args.get("submit").and_then(Value::as_bool) == Some(true);
            match (ok, submit) {
                (true, true) => format!("Filled in {name} and sent it"),
                (true, false) => format!("Filled in {name}"),
                (false, _) => format!("Couldn't fill in {name}"),
            }
        }
        "test_scroll" => {
            let to = match str_arg(args, "to") {
                Some("top") => "the top".to_string(),
                Some("bottom") => "the bottom".to_string(),
                _ if str_arg(args, "selector").is_some() || str_arg(args, "text").is_some() => {
                    target_name(args)
                }
                _ => "further down".to_string(),
            };
            if ok {
                format!("Scrolled to {to}")
            } else {
                format!("Couldn't scroll to {to}")
            }
        }
        "test_viewport" => {
            let size = match (
                str_arg(args, "preset"),
                args.get("width").and_then(Value::as_f64),
            ) {
                (_, Some(w)) => format!("{}px wide", w.round() as i64),
                (Some("mobile"), _) => "phone width".into(),
                (Some("tablet"), _) => "tablet width".into(),
                (Some("laptop"), _) => "laptop width".into(),
                (Some("desktop"), _) => "desktop width".into(),
                _ => "full width".into(),
            };
            if ok {
                format!("Switched to {size}")
            } else {
                format!("Couldn't switch to {size}")
            }
        }
        "test_screenshot" => str_arg(args, "caption")
            .map(|c| one_line(c, MAX_LINE))
            .unwrap_or_else(|| "Took a screenshot".into()),
        "test_note" => one_line(str_arg(args, "text").unwrap_or(""), MAX_LINE),
        _ => tool.to_string(),
    }
}

/// The console step's label, from the number of errors it saw.
pub fn console_label(errors: usize) -> String {
    match errors {
        0 => "Checked the console: no errors".into(),
        1 => "Checked the console: 1 error".into(),
        n => format!("Checked the console: {n} errors"),
    }
}

/// `[error] …` lines from the bridge's console answer (`_meta.lines` when the
/// preview sends them, else the fenced block).
pub fn error_lines(result: &Value) -> Vec<String> {
    let from_meta = result
        .get("_meta")
        .and_then(|m| m.get("lines"))
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let lines = from_meta.unwrap_or_else(|| {
        result
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .flat_map(|t| t.lines().map(str::to_string).collect::<Vec<_>>())
            .collect()
    });
    lines
        .into_iter()
        .filter_map(|l| {
            l.trim()
                .strip_prefix("[error]")
                .map(|rest| one_line(rest, MAX_LINE))
        })
        .filter(|l| !l.is_empty())
        .collect()
}

// ============================================================================
// The report: a new version of the card
// ============================================================================

/// `test_report`'s arguments, checked. Too much is refused, never trimmed.
pub fn parse_report(args: &Value) -> Result<(Outcome, String, Vec<String>), String> {
    let outcome = match str_arg(args, "outcome") {
        Some("passed") => Outcome::Passed,
        Some("broken") => Outcome::Broken,
        _ => return Err("`outcome` is \"passed\" or \"broken\".".into()),
    };
    let summary = str_arg(args, "summary")
        .ok_or("`summary`: a sentence or two on what you tried and how it went.")?
        .to_string();
    if summary.chars().count() > MAX_SUMMARY {
        return Err(format!(
            "`summary` is over {MAX_SUMMARY} characters. Say it shorter; nothing was saved."
        ));
    }
    let broken: Vec<String> = match args.get("broken") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(lines)) => lines
            .iter()
            .map(|l| {
                l.as_str()
                    .map(|s| s.trim().to_string())
                    .ok_or("`broken` is a list of short lines.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|l| !l.is_empty())
            .collect(),
        Some(_) => return Err("`broken` is a list of short lines.".into()),
    };
    if broken.len() > MAX_BROKEN {
        return Err(format!(
            "`broken` has more than {MAX_BROKEN} lines. Group them; nothing was saved."
        ));
    }
    if broken.iter().any(|l| l.chars().count() > MAX_LINE) {
        return Err(format!(
            "A line in `broken` is over {MAX_LINE} characters; nothing was saved."
        ));
    }
    if outcome == Outcome::Broken && broken.is_empty() {
        return Err("Say what's broken in `broken`; nothing was saved.".into());
    }
    Ok((outcome, summary, broken))
}

/// The one line a report adds to the card ("Changes since v1: …").
pub fn changes_line(report: &TestReport) -> String {
    match (report.outcome, report.broken.len()) {
        (Outcome::Passed, _) => "Tested it in the preview: it works".into(),
        (Outcome::Broken, 1) => "Tested it in the preview: 1 thing is broken".into(),
        (Outcome::Broken, n) => format!("Tested it in the preview: {n} things are broken"),
    }
}

/// The card's new version: the newest version of the card the test started
/// from, plus the report; or, for a copy card that had no result, a first
/// version that is the report.
pub fn report_card(
    latest: Option<&ResultCard>,
    report: TestReport,
    project: &str,
    new_id: impl FnOnce() -> String,
) -> ResultCard {
    match latest {
        Some(before) => {
            let mut card = before.clone();
            card.version = before.version + 1;
            card.changes = Some(changes_line(&report));
            card.test = Some(report);
            card
        }
        None => ResultCard {
            id: new_id(),
            version: 1,
            title: format!("Tested {}", super::project::folder_name(project)),
            summary: report.summary.clone(),
            items: Vec::new(),
            checked: Vec::new(),
            not_verified: Vec::new(),
            changes: None,
            project: Some(project.to_string()),
            test: Some(report),
        },
    }
}

/// The message the report becomes. A change card stays a change card (the
/// copy's Keep / Discard live on the newest one), under the run's id, so its
/// screenshots (`attachments/<run id>/`) are filed under it.
pub fn report_message(
    source: &AgentMessage,
    log: &[AgentMessage],
    run: &Run,
    report: TestReport,
) -> AgentMessage {
    let latest = source
        .result
        .as_ref()
        .and_then(|r| super::results::latest(log, &r.id));
    let shots: Vec<Attachment> = report.steps.iter().filter_map(|s| s.shot.clone()).collect();
    let card = report_card(latest.as_ref(), report, &run.project, store::new_id);
    let mut message = if source.kind == MessageKind::Changes {
        let mut m = source.clone();
        m.work = None;
        m.client_id = None;
        m
    } else {
        super::runner::new_message(&run.agent_id, MessageKind::Agent, card.summary.clone())
    };
    message.id = run.id.clone();
    message.ts = store::now_ms();
    message.attachments = shots;
    message.result = Some(card);
    message
}

/// The prompt ahead of the Test it message.
pub fn test_prompt(run: &Run) -> String {
    let what = run
        .title
        .as_deref()
        .map(|t| format!("\"{t}\""))
        .unwrap_or_else(|| "your work".into());
    let place = if run.copy {
        format!("your copy of {}", super::project::folder_name(&run.project))
    } else {
        super::project::folder_name(&run.project).to_string()
    };
    format!(
        "The user pressed Test it on {what}. The site from {place} is open in a preview beside this chat and they are watching it. \
Click through it the way a careful first-time visitor would, using only the test_* tools (test_open, test_click, test_type, test_scroll, test_viewport, test_page, test_console, test_network, test_screenshot, test_note): \
the main pages, the main buttons and links, and any form, with made-up details (never real ones). Every action shows up beside the preview as you take it. \
Take a screenshot of each screen that matters (at most {MAX_SHOTS}), check the console after each page, and use test_note when something looks wrong (\"The form showed an error\"). \
Don't change any files and don't use any other tool for this. \
Finish by calling test_report once: outcome passed or broken, a sentence or two of summary, and what's broken. The report becomes a new version of the card. Then reply with one line."
    )
}

// ============================================================================
// The tools
// ============================================================================

pub struct Tool {
    pub name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

fn target_schema(extra: Value) -> Value {
    let mut props = json!({
        "selector": { "type": "string", "description": "CSS selector of the element." },
        "text": { "type": "string", "description": "Only elements whose visible text contains this." },
        "index": { "type": "number", "description": "Which match, from 0, when several match." },
        "label": { "type": "string", "description": "What to call it beside the preview, e.g. \"Sign up\"." }
    });
    if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    json!({ "type": "object", "properties": props, "required": ["selector"] })
}

pub const TOOLS: &[Tool] = &[
    Tool {
        name: "test_open",
        description: "Open a page of the site in the preview the user is watching, by its path (\"/pricing\").",
        schema: || json!({ "type": "object", "properties": { "path": { "type": "string", "description": "In-site path starting with /." } }, "required": ["path"] }),
    },
    Tool {
        name: "test_click",
        description: "Click an element in the preview, as a visitor would.",
        schema: || target_schema(json!({})),
    },
    Tool {
        name: "test_type",
        description: "Fill in a field in the preview. Made-up details only, never real ones.",
        schema: || target_schema(json!({
            "value": { "type": "string", "description": "What to type." },
            "submit": { "type": "boolean", "description": "Press Enter / submit the form after." }
        })),
    },
    Tool {
        name: "test_scroll",
        description: "Scroll the preview: to the top or bottom, by an amount, or to an element.",
        schema: || json!({ "type": "object", "properties": {
            "to": { "type": "string", "enum": ["top", "bottom"] },
            "y": { "type": "number", "description": "Pixels down (negative: up)." },
            "selector": { "type": "string" },
            "text": { "type": "string" }
        } }),
    },
    Tool {
        name: "test_viewport",
        description: "Try the site at another width: a preset or a width in pixels.",
        schema: || json!({ "type": "object", "properties": {
            "preset": { "type": "string", "enum": ["mobile", "tablet", "laptop", "desktop", "full"] },
            "width": { "type": "number" }
        } }),
    },
    Tool {
        name: "test_page",
        description: "Read what's on the page now: the whole page, or the elements matching a selector.",
        schema: || json!({ "type": "object", "properties": { "selector": { "type": "string" }, "text": { "type": "string" } } }),
    },
    Tool {
        name: "test_console",
        description: "The preview's browser console since the test began (errors first). Check it after each page.",
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Tool {
        name: "test_network",
        description: "The preview's network requests; failed_only for the ones that failed.",
        schema: || json!({ "type": "object", "properties": { "failed_only": { "type": "boolean" } } }),
    },
    Tool {
        name: "test_screenshot",
        description: "Screenshot the preview as it is now. It appears beside the preview and on the report.",
        schema: || json!({ "type": "object", "properties": { "caption": { "type": "string", "description": "What it shows, e.g. \"Pricing page\"." } } }),
    },
    Tool {
        name: "test_note",
        description: "Say what you see, beside the preview (\"The form showed an error\"). problem: true when it's wrong.",
        schema: || json!({ "type": "object", "properties": { "text": { "type": "string" }, "problem": { "type": "boolean" } }, "required": ["text"] }),
    },
    Tool {
        name: "test_report",
        description: "Finish the test: outcome passed or broken, a short summary, and what's broken. Call it once, at the end.",
        schema: || json!({ "type": "object", "properties": {
            "outcome": { "type": "string", "enum": ["passed", "broken"] },
            "summary": { "type": "string" },
            "broken": { "type": "array", "items": { "type": "string" } }
        }, "required": ["outcome", "summary"] }),
    },
];

pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

/// The tools, listed only to an agent with an open run.
pub fn definitions(agent_id: &str) -> Vec<Value> {
    if !is_open(agent_id) || super::runner::from_outside(agent_id) {
        return Vec::new();
    }
    TOOLS
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect()
}

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

fn is_error(result: &Value) -> bool {
    result.get("isError").and_then(Value::as_bool) == Some(true)
}

/// The preview tool a test tool runs, with its arguments.
fn bridge_call(tool: &str, args: &Value) -> Option<(&'static str, Value)> {
    let pick = |keys: &[&str]| {
        let mut out = serde_json::Map::new();
        for k in keys {
            if let Some(v) = args.get(*k) {
                out.insert((*k).to_string(), v.clone());
            }
        }
        Value::Object(out)
    };
    Some(match tool {
        "test_open" => ("preview_navigate", pick(&["path"])),
        "test_click" => ("preview_click", pick(&["selector", "text", "index"])),
        "test_type" => (
            "preview_type",
            pick(&["selector", "text", "index", "value", "submit"]),
        ),
        "test_scroll" => ("preview_scroll", pick(&["to", "y", "selector", "text"])),
        "test_viewport" => ("preview_set_viewport", pick(&["preset", "width"])),
        "test_page" if args.get("selector").is_some() => {
            ("preview_query", pick(&["selector", "text"]))
        }
        "test_page" => ("preview_dom", json!({})),
        "test_network" => ("preview_network", pick(&["failed_only"])),
        _ => return None,
    })
}

fn kind_of(tool: &str) -> StepKind {
    match tool {
        "test_open" => StepKind::Open,
        "test_click" => StepKind::Click,
        "test_type" => StepKind::Type,
        "test_scroll" => StepKind::Scroll,
        "test_viewport" => StepKind::Viewport,
        "test_page" => StepKind::Look,
        "test_console" => StepKind::Console,
        "test_network" => StepKind::Network,
        "test_screenshot" => StepKind::Shot,
        _ => StepKind::Note,
    }
}

fn record_step(
    app: &AppHandle,
    run: &Run,
    kind: StepKind,
    label: String,
    ok: bool,
    shot: Option<Attachment>,
) {
    let step = TestStep {
        kind,
        label,
        ok,
        shot,
        ts: store::now_ms(),
    };
    if let Some(updated) = push_step(&run.agent_id, step) {
        emit(app, &updated);
    } else {
        tracing::debug!("[PreviewTest] step not recorded for run {}", run.id);
    }
}

/// Run one test tool for `caller`.
pub async fn call(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    tool: &Tool,
    args: &Value,
) -> Value {
    // A turn answering outside text (a "When…" routine's items) never drives
    // the user's preview, even while a run they started is open.
    if super::runner::from_outside(&caller.id) {
        return error("Not while answering what a “When…” routine found: that text came from outside this app. The test runs in its own turn.");
    }
    let Some(run) = run_of(&caller.id).filter(|r| r.state == RunState::Running) else {
        return error(
            "There's no test running: these tools work only after the user presses Test it.",
        );
    };
    if pane_window(&run.path).is_none() {
        return error("The user closed the preview, so the test can't go on. Call test_report with what you found so far.");
    }
    match tool.name {
        "test_note" => {
            let Some(note) = str_arg(args, "text") else {
                return error("`text`: what you see.");
            };
            let problem = args.get("problem").and_then(Value::as_bool) == Some(true);
            record_step(
                app,
                &run,
                StepKind::Note,
                step_label("test_note", args, true),
                !problem,
                None,
            );
            let _ = note;
            text("Noted beside the preview.")
        }
        "test_console" => {
            let result = crate::agent_bridge::call_preview_tool(
                app.clone(),
                &run.path,
                "preview_console",
                json!({ "since": run.started_at, "limit": 50 }),
            )
            .await;
            if !is_error(&result) {
                let errors = error_lines(&result).len();
                record_step(
                    app,
                    &run,
                    StepKind::Console,
                    console_label(errors),
                    errors == 0,
                    None,
                );
            }
            result
        }
        "test_screenshot" => screenshot(app, &run, args).await,
        "test_report" => report(app, caller, turn, &run, args).await,
        name => {
            let Some((bridge_tool, bridge_args)) = bridge_call(name, args) else {
                return error("Unknown tool");
            };
            let result = crate::agent_bridge::call_preview_tool(
                app.clone(),
                &run.path,
                bridge_tool,
                bridge_args,
            )
            .await;
            let ok = !is_error(&result);
            match name {
                // Reading the page is quiet; a network check speaks only of failures.
                "test_page" => {}
                "test_network" => {
                    if ok && args.get("failed_only").and_then(Value::as_bool) == Some(true) {
                        let failed = result
                            .get("content")
                            .and_then(Value::as_array)
                            .and_then(|c| c.first())
                            .and_then(|b| b.get("text"))
                            .and_then(Value::as_str)
                            .map(|t| !t.contains("none yet") && t.contains("```"))
                            .unwrap_or(false);
                        if failed {
                            record_step(
                                app,
                                &run,
                                StepKind::Network,
                                "Some requests failed".into(),
                                false,
                                None,
                            );
                        }
                    }
                }
                _ => record_step(
                    app,
                    &run,
                    kind_of(name),
                    step_label(name, args, ok),
                    ok,
                    None,
                ),
            }
            result
        }
    }
}

async fn screenshot(app: &AppHandle, run: &Run, args: &Value) -> Value {
    if run.shots() >= MAX_SHOTS {
        return error(format!(
            "That's {MAX_SHOTS} screenshots already, the most one test keeps. Carry on without, or finish with test_report."
        ));
    }
    let result = crate::agent_bridge::call_preview_tool(
        app.clone(),
        &run.path,
        "preview_screenshot",
        json!({ "inline": false }),
    )
    .await;
    if is_error(&result) {
        return result;
    }
    let Some(saved) = result
        .get("_meta")
        .and_then(|m| m.get("savedPath"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return error("The preview took the screenshot but didn't say where it put it.");
    };
    let Ok(home) = store::agent_home(&run.agent_id) else {
        return error("Couldn't find your folder.");
    };
    let n = run.shots() + 1;
    let kept = keep_shot(&home, &run.id, n, Path::new(&saved));
    let shot = match kept {
        Ok(a) => a,
        Err(e) => return error(format!("Couldn't keep the screenshot: {e}")),
    };
    let _ = app_scope_allow(app, &home.join(&shot.path));
    record_step(
        app,
        run,
        StepKind::Shot,
        step_label("test_screenshot", args, true),
        true,
        Some(shot.clone()),
    );
    let full = home.join(&shot.path);
    let size = std::fs::metadata(&full)
        .map(|m| m.len())
        .unwrap_or(u64::MAX);
    if size <= MAX_INLINE_SHOT_BYTES {
        if let Ok(bytes) = std::fs::read(&full) {
            use base64::Engine;
            return json!({ "content": [
                { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(bytes), "mimeType": shot.mime },
                { "type": "text", "text": "Screenshot taken; it's beside the preview and goes on the report." }
            ] });
        }
    }
    text(format!(
        "Screenshot taken; it's beside the preview and goes on the report. Too large to send back inline: {}",
        full.display()
    ))
}

fn app_scope_allow(app: &AppHandle, path: &Path) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| e.to_string())
}

/// Copy a screenshot into `attachments/<run id>/` as `step-<n>.<ext>`.
pub fn keep_shot(home: &Path, run_id: &str, n: usize, source: &Path) -> Result<Attachment, String> {
    let meta = std::fs::metadata(source).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("it isn't a file".into());
    }
    if meta.len() > super::attachments::MAX_FILE_BYTES {
        return Err("it's over 25 MB".into());
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg"))
        .unwrap_or("png")
        .to_ascii_lowercase();
    let name = format!("step-{n}.{ext}");
    let rel = format!("attachments/{run_id}/{name}");
    let dest = home.join(&rel);
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok(Attachment {
        mime: super::attachments::mime_for(&name).to_string(),
        name,
        path: rel,
        size: meta.len(),
    })
}

async fn report(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    run: &Run,
    args: &Value,
) -> Value {
    let (outcome, summary, broken) = match parse_report(args) {
        Ok(parsed) => parsed,
        Err(e) => return error(e),
    };
    // What the console showed, read from the preview itself.
    let console = crate::agent_bridge::call_preview_tool(
        app.clone(),
        &run.path,
        "preview_console",
        json!({ "since": run.started_at, "level": "error", "limit": 50 }),
    )
    .await;
    let mut console_errors = if is_error(&console) {
        Vec::new()
    } else {
        error_lines(&console)
    };
    console_errors.dedup();
    console_errors.truncate(MAX_CONSOLE);
    let current = run_of(&run.agent_id).unwrap_or_else(|| run.clone());
    let report = TestReport {
        outcome,
        summary,
        broken,
        console_errors,
        steps: current.steps.clone(),
        on_copy: run.copy,
    };
    let agent_id = run.agent_id.clone();
    let run_for_build = current.clone();
    let built = tokio::task::spawn_blocking(move || {
        let log = store::messages(&agent_id, usize::MAX).map_err(|e| e.to_string())?;
        let source = log
            .iter()
            .find(|m| m.id == run_for_build.message_id)
            .cloned()
            .ok_or_else(|| {
                "The card the test started from isn't in this conversation any more.".to_string()
            })?;
        Ok::<_, String>(report_message(&source, &log, &run_for_build, report))
    })
    .await;
    let message = match built {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return error(e),
        Err(e) => return error(e.to_string()),
    };
    // Reported: no more steps, and the pane says so.
    let updated = {
        let mut all = runs();
        all.get_mut(&run.agent_id).map(|r| {
            r.state = RunState::Reported;
            r.outcome = Some(outcome);
            r.clone()
        })
    };
    if let Some(updated) = &updated {
        emit(app, updated);
    }
    let version = message.result.as_ref().map(|r| r.version).unwrap_or(1);
    if super::broker::is_live(&caller.id, turn) {
        super::results::stage(message);
        text(format!(
            "Saved the report as version {version} of the card; it appears at the end of your reply. Say one line about it, don't repeat it."
        ))
    } else {
        match super::runner::record(app, message) {
            Ok(_) => text(format!(
                "The report is in the chat now as version {version} of the card."
            )),
            Err(e) => error(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests;
