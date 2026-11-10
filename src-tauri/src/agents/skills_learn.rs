//! "Save how I did this as a skill": an agent that finished a hard task
//! keeps the steps, so next time the same request is one sentence.
//!
//! **Who decides when.** The agent calls `save_skill` (a name, when to use
//! it, the steps) at the end of a task. The app, not the model, judges
//! whether the turn took real effort, from what it *observed* the turn do
//! (`work::snapshot`: its tool steps and how long it ran, [`effort`]). A
//! quick turn's skill is refused, whatever the model says about it.
//!
//! **Per agent: Automatically / Ask me / Off** (`Agent::learn_skills`,
//! default Ask me). Automatically saves at once with a line in the chat;
//! Ask me puts one card in the chat ("Save “Export invoices” as a skill?",
//! Save / Not now, desk and phone); Off doesn't serve the tool at all. A
//! turn answering outside text, or in a conversation that read outside
//! content (`exposure::read_outside`), always gets the card ([`gate`]):
//! words planted in a page must never become a standing skill unseen.
//!
//! **What is never in one.** Every field goes through the Keychain
//! redaction (`secrets::redact`) and the recipe scrub (`recipe::scrub`:
//! anything shaped like a credential, home-folder paths, email addresses,
//! phone numbers), each replaced by "[removed: …]" and counted on the card.
//!
//! **Where it lives.** One file per skill, `<home>/.claude/skills/<slug>/SKILL.md`,
//! with the front matter Claude Code reads (`name`, `description`). Claude
//! Code finds it there by itself when the turn runs in the agent's home
//! ([`Placement::Native`]). Codex and OpenCode don't (not verified to), and
//! a project-bound agent's turn runs in the project, so for those the
//! system prompt carries a short index naming each skill and its file
//! ([`Placement::Index`], [`prompt_section`]). The same files serve every
//! engine, so switching engines keeps them.
//!
//! **Listed** under the agent as "What it knows how to do" (desk and phone:
//! `agents_skills`, `agents.skills`), each one editable and removable, and
//! carried in a recipe (`recipe.rs`), scrubbed again on the way out.
//!
//! Residual: the agent can still write a file into that folder with its own
//! file tools (as it can any file in its home); `save_skill` is the path the
//! app checks and shows.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use super::engine::Engine;
use super::runner;
use super::store::{self, Agent, Approval, ApprovalStatus, MessageKind};
use super::work::{StepKind, TurnWork};
use crate::errors::CommandError;

pub const TOOL: &str = "save_skill";

pub const DESCRIPTION: &str = "Only at the end of a task that took you many steps and that the user is likely to ask for again (a site's export flow, a filing routine, a report's format): save how you did it as a skill, so next time it's one sentence. `name` is a few words (\"Export invoices from Xero\"); `when` says when to use it; `steps` are the steps that worked, numbered, with the commands, pages and checks you actually used. No secrets, personal details or text copied from pages or messages. The app judges whether the task took real effort and may refuse; depending on the user's setting it saves at once or shows them a card. Never for a quick answer.";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "A few words: what it does (\"Export invoices from Xero\")." },
            "when": { "type": "string", "description": "When to use it, one sentence (\"When the user asks for last month's invoices\")." },
            "steps": {
                "description": "The steps that worked, in order. Text, or a list of steps.",
                "anyOf": [
                    { "type": "string" },
                    { "type": "array", "items": { "type": "string" } }
                ]
            }
        },
        "required": ["name", "when", "steps"]
    })
}

/* ------------------------------------------------------------ the setting */

/// "Save what it learns": Automatically / Ask me / Off.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Learning {
    Auto,
    #[default]
    Ask,
    Off,
}

impl Learning {
    pub fn is_default(&self) -> bool {
        *self == Learning::Ask
    }

    /// The words people and the Chief use for each.
    pub fn parse(raw: &str) -> Result<Learning, String> {
        match raw
            .trim()
            .to_ascii_lowercase()
            .replace(['-', '_'], " ")
            .as_str()
        {
            "auto" | "automatic" | "automatically" | "always" | "on" => Ok(Learning::Auto),
            "ask" | "ask me" | "ask first" | "default" => Ok(Learning::Ask),
            "off" | "never" | "no" | "none" => Ok(Learning::Off),
            other => Err(format!(
                "\"{other}\" isn't a choice: it's \"automatically\", \"ask me\" or \"off\"."
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Learning::Auto => "Automatically",
            Learning::Ask => "Ask me",
            Learning::Off => "Off",
        }
    }

    /// The tool's and the chat line's words for it, after "Saving skills: ".
    pub fn said(self) -> &'static str {
        match self {
            Learning::Auto => "saves what it learns without asking",
            Learning::Ask => "asks before saving what it learns",
            Learning::Off => "doesn't save what it learns",
        }
    }
}

/* ------------------------------------------------------------- the effort */

/// Tool steps that make a turn real work on their own.
pub const MANY_STEPS: u32 = 8;
/// Fewer steps count when the turn also ran this long.
pub const SOME_STEPS: u32 = 4;
pub const LONG_MS: i64 = 3 * 60_000;

/// What the app saw the turn do, for [`took_effort`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Effort {
    /// Tool steps: reads, edits, commands, searches, pages… never its own
    /// narration, a card it raised or a plan it wrote.
    pub steps: u32,
    pub ms: i64,
}

/// What `work` says the turn did, by `now`.
pub fn effort(work: &TurnWork, now: i64) -> Effort {
    let not_work = |k: StepKind| matches!(k, StepKind::Note | StepKind::Approval | StepKind::Plan);
    let kept = work.steps.len() as u32;
    let kept_tools = work.steps.iter().filter(|s| !not_work(s.kind)).count() as u32;
    // Steps no longer kept were counted but not seen: count them as work.
    let dropped = work.step_count.saturating_sub(kept);
    Effort {
        steps: kept_tools + dropped,
        ms: (now - work.started_at).max(0),
    }
}

/// Calls to `save_skill` itself are not the work it is judging.
pub fn without_own_calls(e: Effort, own: u32) -> Effort {
    Effort {
        steps: e.steps.saturating_sub(own),
        ..e
    }
}

pub fn took_effort(e: Effort) -> bool {
    e.steps >= MANY_STEPS || (e.steps >= SOME_STEPS && e.ms >= LONG_MS)
}

pub const TOO_QUICK: &str = "This task was quick (the app saw only a few steps), so there's nothing worth keeping as a skill. Nothing was saved. Don't mention it.";
pub const NOT_LIVE: &str =
    "Only at the end of a task you worked through in this turn. Nothing was saved.";
pub const IS_OFF: &str = "Saving skills is off for you. Nothing was saved. Don't mention it.";

/* --------------------------------------------------------------- the gate */

/// What a call does, by the agent's setting and where the turn's words
/// came from. Pure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Save,
    Card,
    Refuse(&'static str),
}

pub fn gate(setting: Learning, outside: bool, live: bool, effort_ok: bool) -> Gate {
    if setting == Learning::Off {
        return Gate::Refuse(IS_OFF);
    }
    if !live {
        return Gate::Refuse(NOT_LIVE);
    }
    if !effort_ok {
        return Gate::Refuse(TOO_QUICK);
    }
    // Outside text never saves unseen, whatever the setting.
    if outside || setting == Learning::Ask {
        return Gate::Card;
    }
    Gate::Save
}

/* -------------------------------------------------------------- the skill */

pub const NAME_CHARS: usize = 60;
pub const WHEN_CHARS: usize = 300;
pub const STEPS_CHARS: usize = 6_000;
/// Skills one agent keeps; a new one past this is refused.
pub const MAX_SKILLS: usize = 40;

/// One skill, as listed and as the card shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Its folder's name: lowercase words and hyphens (Claude Code's rule).
    pub slug: String,
    pub name: String,
    pub when: String,
    pub steps: String,
}

/// "Export invoices from Xero" → "export-invoices-from-xero".
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(48).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "skill".to_string()
    } else {
        out
    }
}

/// Whether `s` is a slug this module could have made: what a request may
/// name, so nothing outside the skills folder is ever touched.
pub fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
}

fn one_line(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(max).collect::<String>().trim().to_string()
}

fn clip_text(s: &str, max: usize) -> String {
    // Front-matter fences in the body would end the file's header early.
    let s = s.replace("\r\n", "\n").replace("\n---", "\n—");
    s.trim()
        .chars()
        .take(max)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// The steps as one text: a list becomes a numbered one.
fn steps_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .enumerate()
            .map(|(i, s)| format!("{}. {s}", i + 1))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Everything personal or secret taken out of `text`: the Keychain's own
/// values first, then the recipe scrub. Returns how many were removed.
pub fn clean(text: &str) -> (String, usize) {
    let redacted = super::secrets::redact(text);
    let keychain = usize::from(redacted != text);
    let (out, removed) = super::recipe::scrub(&redacted);
    (out, keychain + removed.personal() + removed.secrets)
}

/// A skill from what was asked, cleaned and checked. Pure (but for the
/// Keychain's known values). The count is what was removed.
pub fn draft(name: &str, when: &str, steps: &str) -> Result<(Skill, usize), String> {
    let (name, a) = clean(&one_line(name, NAME_CHARS));
    let (when, b) = clean(&one_line(when, WHEN_CHARS));
    let (steps, c) = clean(&clip_text(steps, STEPS_CHARS));
    if name.is_empty() {
        return Err("A skill needs a `name`. Nothing was saved.".into());
    }
    if when.is_empty() {
        return Err("Say `when` to use it. Nothing was saved.".into());
    }
    if steps.chars().count() < 20 {
        return Err("Write out the `steps` that worked. Nothing was saved.".into());
    }
    Ok((
        Skill {
            slug: slug(&name),
            name,
            when,
            steps,
        },
        a + b + c,
    ))
}

/// A tool call's arguments as a skill.
pub fn from_args(args: &Value) -> Result<(Skill, usize), String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
    draft(s("name"), s("when"), &steps_text(args.get("steps")))
}

/* -------------------------------------------------------------- the files */

/// `<home>/.claude/skills`: where every engine's skills are kept.
pub fn dir(home: &Path) -> PathBuf {
    home.join(".claude").join("skills")
}

pub fn file(home: &Path, slug: &str) -> PathBuf {
    dir(home).join(slug).join("SKILL.md")
}

/// How the engine finds them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Claude Code in the agent's own home reads `.claude/skills` itself.
    Native,
    /// Named in the system prompt, with each file's path.
    Index,
}

pub fn placement(engine: Engine, bound: bool) -> Placement {
    match engine {
        Engine::Claude if !bound => Placement::Native,
        _ => Placement::Index,
    }
}

/// YAML-safe: one line, quoted.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The file, as Claude Code reads a skill: `name` and `description` in the
/// front matter, then the steps under the skill's own name.
pub fn to_markdown(skill: &Skill) -> String {
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n# {}\n\n{}\n",
        skill.slug,
        quoted(&skill.when),
        skill.name,
        skill.steps.trim()
    )
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        s.to_string()
    }
}

/// A SKILL.md read back: ours, or one the user put there by hand.
pub fn parse_markdown(slug: &str, text: &str) -> Skill {
    let text = text.replace("\r\n", "\n");
    let (front, body) = match text
        .strip_prefix("---\n")
        .and_then(|r| r.split_once("\n---"))
    {
        Some((front, rest)) => (front.to_string(), rest.trim_start_matches('-').to_string()),
        None => (String::new(), text.clone()),
    };
    let field = |k: &str| {
        front
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{k}:")).map(unquote))
            .unwrap_or_default()
    };
    let body = body.trim();
    let (name, steps) = match body.strip_prefix("# ") {
        Some(rest) => match rest.split_once('\n') {
            Some((title, steps)) => (title.trim().to_string(), steps.trim().to_string()),
            None => (rest.trim().to_string(), String::new()),
        },
        None => (String::new(), body.to_string()),
    };
    let name = if name.is_empty() {
        let n = field("name");
        if n.is_empty() {
            slug.to_string()
        } else {
            n
        }
    } else {
        name
    };
    Skill {
        slug: slug.to_string(),
        name,
        when: field("description"),
        steps,
    }
}

/// Its skills, by name.
pub fn list(home: &Path) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir(home)) else {
        return Vec::new();
    };
    let mut out: Vec<Skill> = entries
        .flatten()
        .filter_map(|e| {
            let slug = e.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path().join("SKILL.md")).ok()?;
            Some(parse_markdown(&slug, &text))
        })
        .collect();
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

/// Write it (a new one, or over the one with its slug).
pub fn write(home: &Path, skill: &Skill) -> Result<(), CommandError> {
    if !valid_slug(&skill.slug) {
        return Err(super::err_invalid("slug", "That isn't one of its skills."));
    }
    let path = file(home, &skill.slug);
    let exists = path.is_file();
    if !exists && list(home).len() >= MAX_SKILLS {
        return Err(CommandError::expected(format!(
            "It already keeps {MAX_SKILLS} skills. Remove one first."
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| super::err_io(e.to_string()))?;
    }
    store::write_atomic(&path, to_markdown(skill).as_bytes())
}

/// Remove one. Whether it was there.
pub fn remove(home: &Path, slug: &str) -> Result<bool, CommandError> {
    if !valid_slug(slug) {
        return Err(super::err_invalid("slug", "That isn't one of its skills."));
    }
    let folder = dir(home).join(slug);
    if !folder.is_dir() {
        return Ok(false);
    }
    std::fs::remove_dir_all(&folder).map_err(|e| super::err_io(e.to_string()))?;
    Ok(true)
}

/// For an engine that doesn't read the folder: each skill's name, when to
/// use it and its file, so the agent reads the file before doing that.
/// `None` with no skills, or where the engine reads them itself.
pub fn prompt_section(placement: Placement, home: &Path, skills: &[Skill]) -> Option<String> {
    if placement == Placement::Native || skills.is_empty() {
        return None;
    }
    let lines: Vec<String> = skills
        .iter()
        .map(|s| {
            format!(
                "- {}: {} ({})",
                s.name,
                s.when,
                file(home, &s.slug).display()
            )
        })
        .collect();
    Some(format!(
        "## Skills you saved\n\nHow you did these before. When a task matches one, read its file first and follow it.\n{}",
        lines.join("\n")
    ))
}

/// The prompt's section for this agent, read now.
pub fn prompt_for(agent: &Agent, home: &Path, bound: bool) -> Option<String> {
    let place = placement(agent.engine, bound);
    if place == Placement::Native {
        return None;
    }
    prompt_section(place, home, &list(home))
}

/* --------------------------------------------------------------- the card */

/// On the card (`Approval::skill`): the skill exactly as it would be saved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCard {
    #[serde(flatten)]
    pub skill: Skill,
    /// Personal details and secrets taken out of it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub removed: usize,
    /// It came from a turn answering outside text, so it asks whatever the setting.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub outside: bool,
    /// It has a skill by this name already, which this replaces.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replaces: bool,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

pub const CARD_ALLOW: &str = "Save";
pub const CARD_DENY: &str = "Not now";

/// "4 personal details removed" (or none). Pure.
pub fn removed_line(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("1 personal detail or secret removed.".into()),
        n => Some(format!("{n} personal details or secrets removed.")),
    }
}

/// The card. Its `summary` and `detail` say the same for a client that
/// doesn't know `skill`: when to use it, then the steps. Pure.
pub fn card(card: SkillCard) -> Approval {
    let mut summary = format!("When to use it: {}", card.skill.when);
    if card.replaces {
        summary.push_str(" It replaces the skill it has by this name.");
    }
    if let Some(line) = removed_line(card.removed) {
        summary.push(' ');
        summary.push_str(&line);
    }
    if card.outside {
        summary.push_str(
            " It read outside content in this conversation: check nothing in it came from there.",
        );
    }
    let mut a = super::mcp::new_card(
        store::new_id(),
        format!("Save “{}” as a skill?", card.skill.name),
        card.skill.steps.clone(),
        None,
    );
    a.summary = Some(summary);
    a.risk = Some(if card.outside {
        store::Risk::High
    } else {
        store::Risk::Low
    });
    a.skill = Some(card);
    a
}

/// The line a saved skill leaves. Pure.
pub fn saved_line(name: &str, replaced: bool) -> String {
    if replaced {
        format!("Updated a skill: {name}. Next time it follows these steps.")
    } else {
        format!("Learned a skill: {name}. Next time it follows these steps.")
    }
}

/* --------------------------------------------------------------- the tool */

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

/// Save it and say so in the chat.
fn save_now(app: &AppHandle, agent_id: &str, skill: &Skill) -> Result<bool, CommandError> {
    let home = store::agent_home(agent_id)?;
    let replaced = file(&home, &skill.slug).is_file();
    write(&home, skill)?;
    tracing::info!(agent = %agent_id, slug = %skill.slug, "[Agents] skill saved");
    let note = runner::new_message(
        agent_id,
        MessageKind::Note,
        saved_line(&skill.name, replaced),
    );
    let _ = runner::record(app, note);
    let _ = app.emit(EVENT, agent_id);
    Ok(replaced)
}

/// Emitted with the agent's id when its skills change, so the lists refresh.
pub const EVENT: &str = "agents-skills-changed";

/// `save_skill`. `turn` is the caller's live turn (`broker`).
pub async fn call(app: &AppHandle, caller: &Agent, turn: Option<u64>, args: &Value) -> Value {
    let live = super::broker::is_live(&caller.id, turn);
    let outside = runner::from_outside(&caller.id) || super::exposure::read_outside(&caller.id);
    // Judge on every step the engine took before this call: the bridge can
    // be asked before the stream reader has recorded them.
    if caller.learn_skills != Learning::Off && live {
        super::work::caught_up(&caller.id, TOOL, super::work::CATCH_UP_MS).await;
    }
    let work_effort = super::work::snapshot(&caller.id)
        .map(|w| effort(&w, store::now_ms()))
        .map(|e| without_own_calls(e, super::work::reported(&caller.id, TOOL)))
        .unwrap_or_default();
    let verdict = gate(caller.learn_skills, outside, live, took_effort(work_effort));
    if let Gate::Refuse(why) = verdict {
        return error(why);
    }
    let (skill, removed) = match from_args(args) {
        Ok(s) => s,
        Err(why) => return error(why),
    };
    let home = match store::agent_home(&caller.id) {
        Ok(h) => h,
        Err(e) => return error(e.to_string()),
    };
    let replaces = file(&home, &skill.slug).is_file();
    if verdict == Gate::Save {
        return match save_now(app, &caller.id, &skill) {
            Ok(_) => text(format!(
                "Saved as a skill, “{}”. A line in the chat says so; don't repeat it.",
                skill.name
            )),
            Err(e) => error(e.to_string()),
        };
    }
    // One card per skill: a second call while one waits says so.
    let open = store::pending_approvals(&caller.id).unwrap_or_default();
    if open
        .iter()
        .any(|a| a.skill.as_ref().is_some_and(|c| c.skill.slug == skill.slug))
    {
        return text("The card offering to save that skill is still open in the chat. Don't mention it again.");
    }
    let mut message = runner::new_message(&caller.id, MessageKind::Approval, "");
    message.approval = Some(card(SkillCard {
        skill,
        removed,
        outside,
        replaces,
    }));
    if let Err(e) = runner::record_own(app, message) {
        return error(e.to_string());
    }
    store::refresh_pending(&caller.id);
    super::notify::refresh_badge(app);
    text("The user has a card to save it as a skill (Save / Not now). Nothing waits on it: finish your reply, and don't mention the card beyond a few words.")
}

/// The card answered (desk or phone): Save writes it, Not now saves nothing.
pub fn answer_card(
    app: &AppHandle,
    agent_id: &str,
    approval: &Approval,
    allow: bool,
) -> Result<(), CommandError> {
    let Some(c) = approval.skill.clone() else {
        return Err(CommandError::expected("That isn't a card about a skill."));
    };
    let status = if allow {
        ApprovalStatus::Allowed
    } else {
        ApprovalStatus::Denied
    };
    // Only the answer that closed the card saves (`answer_gate`).
    let Some(m) = store::set_approval_status(agent_id, &approval.request_id, status)? else {
        return Err(super::answer_gate::lost(agent_id, &approval.request_id));
    };
    let _ = app.emit(runner::EVENT_MESSAGE, &m);
    store::refresh_pending(agent_id);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    if allow {
        save_now(app, agent_id, &c.skill)?;
    }
    Ok(())
}

/* ---------------------------------------------------- the desk and phone */

/// "What it knows how to do": the setting and the skills.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub agent_id: String,
    pub setting: Learning,
    pub skills: Vec<Skill>,
}

pub fn view(agent_id: &str) -> Result<View, CommandError> {
    let agent = store::get(agent_id)?;
    let home = store::agent_home(agent_id)?;
    Ok(View {
        agent_id: agent.id,
        setting: agent.learn_skills,
        skills: list(&home),
    })
}

/// The user's edit: cleaned as a new one is. A renamed skill moves folder.
pub fn edit(
    app: &AppHandle,
    agent_id: &str,
    slug_was: &str,
    name: &str,
    when: &str,
    steps: &str,
) -> Result<Skill, CommandError> {
    if !valid_slug(slug_was) {
        return Err(super::err_invalid("slug", "That isn't one of its skills."));
    }
    let home = store::agent_home(agent_id)?;
    if !file(&home, slug_was).is_file() {
        return Err(CommandError::expected("That skill isn't there any more."));
    }
    let (skill, _) = draft(name, when, steps).map_err(|e| {
        CommandError::expected(e.trim_end_matches(" Nothing was saved.").to_string())
    })?;
    if skill.slug != slug_was && file(&home, &skill.slug).is_file() {
        return Err(CommandError::expected(
            "It already has a skill by that name.",
        ));
    }
    write(&home, &skill)?;
    if skill.slug != slug_was {
        remove(&home, slug_was)?;
    }
    let _ = app.emit(EVENT, agent_id);
    Ok(skill)
}

pub fn remove_one(app: &AppHandle, agent_id: &str, slug: &str) -> Result<(), CommandError> {
    let home = store::agent_home(agent_id)?;
    if !remove(&home, slug)? {
        return Err(CommandError::expected("That skill isn't there any more."));
    }
    tracing::info!(agent = %agent_id, slug = %slug, "[Agents] skill removed");
    let _ = app.emit(EVENT, agent_id);
    Ok(())
}

#[cfg(test)]
#[path = "skills_learn_tests.rs"]
mod tests;
