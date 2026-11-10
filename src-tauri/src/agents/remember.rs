//! "You can always do those": an "Always allow" rule the user gives in chat.
//!
//! Only pressing Always on a card used to record a rule, so a user who typed
//! "ur always allowed to do those" kept getting the same cards. Now the
//! agent records it with `remember_permission`, and it sticks.
//!
//! **What stops it being a way round the wall** (enforced here, not asked of
//! the model):
//! - **The user's own words, just now.** Only in a live turn whose latest
//!   input is a message the user typed in this agent's own chat, on the desk
//!   or the phone (`runner::typed_input`): never another agent's message, a
//!   routine, a room, a notice the app queued, or anything answering outside
//!   text. So an admin acting on another agent's request can't either. The
//!   `quote` must be in what they typed.
//! - **Only a card they've seen.** The rule is the exact "Always allow"
//!   scope a card in this chat offered (`Approval::always`: one connector
//!   tool, a command's leading words, one host), found by its tool, command
//!   or label. Nothing broader ("Bash *") can be named.
//! - **Never the floor.** A remembered rule never covers Go hard's floor
//!   (`go_hard::floor`): sending or posting as the user, paying, pushing,
//!   deleting their data, credentials, `sudo`, the user's browser. A rule
//!   for one is refused, and a call it would cover on the floor still asks.
//!   A rule chosen on a card (no `said`) is unchanged.
//!
//! Recorded, it leaves one line, "Remembered: Lead Gen can always … · Undo"
//! (desk and phone; Undo is `agents_revoke_permission`), and every card
//! still waiting in that chat that it covers is allowed, marked as by the
//! user's rule. "For the team" keeps it in `remembered-permissions.json` in
//! the agents folder and covers every agent, under the same floor.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use super::autoallow::Ctx;
use super::permissions::{Rule, RuleKind, Scope};
use super::runner;
use super::store::{self, Agent, AgentMessage, Approval, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

pub const TOOL: &str = "remember_permission";

pub const DESCRIPTION: &str = "Only when the user, in their own message just now, says you may always do something a card in this chat asked for (\"you can always post those\"): record it, so those cards stop. `tool_or_pattern` is what the card asked: its tool name (mcp__…), command or site. `quote` is their exact words. It can't cover sending or posting as them, payments, pushing, deleting or credentials: those keep asking, so tell them.";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tool_or_pattern": { "type": "string", "description": "The card's tool name (mcp__app__tool), command (npm test) or site (example.com)." },
            "scope": { "type": "string", "enum": ["this agent", "team"], "description": "\"team\" only when they said every agent may. Default: this agent." },
            "quote": { "type": "string", "description": "The user's words that said so, exactly as they typed them." }
        },
        "required": ["tool_or_pattern", "quote"]
    })
}

/// On the line a remembered rule leaves (`AgentMessage::remembered`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Remembered {
    pub rule_id: String,
    /// For every agent, not just this one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
    /// Still in force: read from the rules themselves whenever the log is
    /// read ([`apply`]), so Undo anywhere shows everywhere.
    #[serde(default)]
    pub active: bool,
}

/* ------------------------------------------------------------ team rules */

const FILE: &str = "remembered-permissions.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    rules: Vec<Rule>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agents_root()?.join(FILE))
}

fn read() -> Saved {
    path()
        .ok()
        .and_then(|p| super::survive::read_kept(&p, "What you told agents they can always do"))
        .unwrap_or_default()
}

fn write(saved: &Saved) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(saved).map_err(super::err_other)?;
    store::write_atomic(&path()?, &json)
}

/// The rules the user gave the whole team.
pub fn team_rules() -> Vec<Rule> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read().rules
}

/* -------------------------------------------------------------- matching */

/// The rule that lets this call through, if one does: the agent's own
/// first, then the team's. A rule from chat (and every team rule) never
/// covers the floor; without a context to judge the floor by, it covers
/// nothing.
pub fn covering<'a>(
    own: &'a [Rule],
    team: &'a [Rule],
    tool: &str,
    input: &Value,
    ctx: Option<&Ctx>,
) -> Option<&'a Rule> {
    let off_floor = || ctx.is_some_and(|c| !super::go_hard::floor(tool, input, c));
    own.iter()
        .find(|r| r.scope.matches(tool, input) && (r.scope.said.is_none() || off_floor()))
        .or_else(|| {
            team.iter()
                .find(|r| r.scope.matches(tool, input) && off_floor())
        })
}

/// Whether a standing rule (chosen on a card, or remembered) covers this call.
pub fn covers(agent: &Agent, tool: &str, input: &Value) -> bool {
    let team = team_rules();
    if agent.permissions.is_empty() && team.is_empty() {
        return false;
    }
    let ctx = Ctx::for_agent(agent);
    covering(&agent.permissions, &team, tool, input, ctx.as_ref()).is_some()
}

/// The cards still waiting that a remembered rule now covers.
pub fn covered(scope: &Scope, open: &[Approval], ctx: Option<&Ctx>) -> Vec<String> {
    open.iter()
        .filter(|a| a.status == ApprovalStatus::Pending)
        .filter(|a| match (&a.tool, &a.input) {
            (Some(tool), Some(input)) => {
                scope.matches(tool, input)
                    && ctx.is_some_and(|c| !super::go_hard::floor(tool, input, c))
            }
            _ => false,
        })
        .map(|a| a.request_id.clone())
        .collect()
}

/* -------------------------------------------------------------- the plan */

/// What a call to the tool would record.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub scope: Scope,
    pub team: bool,
}

pub const NOT_TYPED: &str = "Only right after the user says so themselves, in this chat. Nothing was recorded. If they want it, they can say it here or choose Always allow on the card.";
pub const NOT_QUOTED: &str = "That isn't what the user said in their message. Quote their exact words. Nothing was recorded.";
pub const ON_THE_FLOOR: &str = "That one keeps asking whatever they say: it sends or posts as them, pays, pushes, deletes or touches credentials. Nothing was recorded; tell them it will still ask.";

/// Lowercase words, so a quote matches whatever its punctuation or spacing.
fn words(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `quote` is the user's own words in `said`.
pub fn quoted(quote: &str, said: &str) -> bool {
    let quote = words(quote);
    quote.chars().count() >= 4 && format!(" {} ", words(said)).contains(&format!(" {quote} "))
}

/// The most recent card in this chat that offered to always allow `wanted`:
/// by its tool name, its command or host, or its label.
pub fn card_scope<'a>(log: &'a [AgentMessage], wanted: &str) -> Option<&'a Approval> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return None;
    }
    log.iter()
        .rev()
        .filter_map(|m| m.approval.as_ref())
        .find(|a| {
            a.always.as_ref().is_some_and(|s| {
                s.value == wanted
                    || s.label.eq_ignore_ascii_case(wanted)
                    || (s.kind == RuleKind::Tool && a.tool.as_deref() == Some(wanted))
            })
        })
}

/// Check a call to the tool in full. `said` is what the user typed in the
/// turn's latest input (`None` refuses), `log` this agent's chat.
pub fn plan(
    said: Option<&str>,
    args: &Value,
    log: &[AgentMessage],
    ctx: Option<&Ctx>,
) -> Result<Plan, String> {
    let arg = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
    };
    let said = said.ok_or_else(|| NOT_TYPED.to_string())?;
    let quote = arg("quote");
    if !quoted(quote, said) {
        return Err(NOT_QUOTED.to_string());
    }
    let team = match arg("scope").to_ascii_lowercase().as_str() {
        "" | "this agent" | "this_agent" | "agent" | "me" => false,
        "team" | "the team" | "everyone" => true,
        _ => return Err("`scope` is \"this agent\" or \"team\". Nothing was recorded.".into()),
    };
    let wanted = arg("tool_or_pattern");
    let no_card = || {
        format!("No card in this chat offered to always allow “{wanted}”. Use the tool name, command or site a card here asked for. Nothing was recorded.")
    };
    let card = card_scope(log, wanted).ok_or_else(no_card)?;
    let mut scope = card.always.clone().ok_or_else(no_card)?;
    // The floor, judged on the call the card was for and on the rule itself.
    let ctx = ctx.ok_or_else(|| ON_THE_FLOOR.to_string())?;
    let (tool, input) = match scope.kind {
        RuleKind::Tool => (
            scope.value.clone(),
            card.input.clone().unwrap_or_else(|| json!({})),
        ),
        RuleKind::Command | RuleKind::CommandPrefix => {
            ("Bash".to_string(), json!({ "command": scope.value }))
        }
        RuleKind::Domain => (
            "WebFetch".to_string(),
            json!({ "url": format!("https://{}/", scope.value) }),
        ),
    };
    let card_call = match (&card.tool, &card.input) {
        (Some(t), Some(i)) => super::go_hard::floor(t, i, ctx),
        _ => false,
    };
    if card_call || super::go_hard::floor(&tool, &input, ctx) {
        return Err(ON_THE_FLOOR.to_string());
    }
    scope.said = Some(quote.chars().take(240).collect());
    Ok(Plan { scope, team })
}

/// "post to social media · Acme CRM", "run `npm test`", "open pages on example.com".
pub fn phrase(scope: &Scope) -> String {
    match scope.kind {
        RuleKind::Command | RuleKind::CommandPrefix => format!("run {}", scope.label),
        RuleKind::Domain => format!("open pages on {}", scope.label),
        RuleKind::Tool if scope.value == "WebSearch" => "search the web".to_string(),
        RuleKind::Tool => {
            let mut chars = scope.label.chars();
            match chars.next() {
                Some(first) => first.to_lowercase().chain(chars).collect(),
                None => scope.value.clone(),
            }
        }
    }
}

/// The line's words.
pub fn line(who: &str, plan: &Plan) -> String {
    let who = if plan.team { "the team" } else { who };
    format!("Remembered: {who} can always {}", phrase(&plan.scope))
}

/* -------------------------------------------------------------- records */

/// Keep the rule. `None` when the same rule was already there (nothing new
/// to say, nothing to undo); else the new rule's id.
pub fn record(agent_id: &str, plan: &Plan) -> Result<Option<String>, CommandError> {
    let rule = Rule {
        id: store::new_id(),
        scope: plan.scope.clone(),
        created_at: store::now_ms(),
        extra: Default::default(),
    };
    let id = rule.id.clone();
    if plan.team {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved = read();
        if saved.rules.iter().any(|r| r.scope.same_rule(&plan.scope)) {
            return Ok(None);
        }
        saved.rules.push(rule);
        write(&saved)?;
        return Ok(Some(id));
    }
    let mut fresh = false;
    store::update(agent_id, |a| {
        if !a.permissions.iter().any(|r| r.scope.same_rule(&plan.scope)) {
            a.permissions.push(rule);
            fresh = true;
        }
    })?;
    Ok(fresh.then_some(id))
}

/// Take a rule back, the agent's own or the team's. Whether one went.
pub fn forget(agent_id: &str, rule_id: &str) -> Result<bool, CommandError> {
    let mut gone = false;
    store::update(agent_id, |a| {
        let before = a.permissions.len();
        a.permissions.retain(|r| r.id != rule_id);
        gone = a.permissions.len() != before;
    })?;
    if gone {
        return Ok(true);
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut saved = read();
    let before = saved.rules.len();
    saved.rules.retain(|r| r.id != rule_id);
    if saved.rules.len() == before {
        return Ok(false);
    }
    write(&saved)?;
    Ok(true)
}

/// Each remembered line as it is now: in force, or undone.
pub fn apply(agent_id: &str, page: &mut [AgentMessage]) {
    if !page.iter().any(|m| m.remembered.is_some()) {
        return;
    }
    let own: Vec<String> = store::get(agent_id)
        .map(|a| a.permissions.into_iter().map(|r| r.id).collect())
        .unwrap_or_default();
    let team: Vec<String> = team_rules().into_iter().map(|r| r.id).collect();
    for m in page.iter_mut() {
        if let Some(r) = m.remembered.as_mut() {
            r.active = own.contains(&r.rule_id) || team.contains(&r.rule_id);
        }
    }
}

/// Undo (`agents_revoke_permission`, desk and phone): the rule goes, and
/// the lines that offered it say so wherever they're shown.
pub fn forget_and_show(app: &AppHandle, agent_id: &str, rule_id: &str) -> Result<(), CommandError> {
    forget(agent_id, rule_id)?;
    let mut lines: Vec<AgentMessage> = store::messages(agent_id, 2000)?
        .into_iter()
        .filter(|m| m.remembered.as_ref().is_some_and(|r| r.rule_id == rule_id))
        .collect();
    apply(agent_id, &mut lines);
    for message in lines {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    Ok(())
}

/* -------------------------------------------------------------- the tool */

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

/// `remember_permission`. `turn` is the caller's live turn (`broker`).
pub async fn call(app: &AppHandle, caller: &Agent, turn: Option<u64>, args: &Value) -> Value {
    let said = if super::broker::is_live(&caller.id, turn) {
        runner::typed_input(&caller.id)
    } else {
        None
    };
    let log = match store::messages(&caller.id, 1000) {
        Ok(log) => log,
        Err(e) => return error(e.to_string()),
    };
    let ctx = Ctx::for_agent(caller);
    let plan = match plan(said.as_deref(), args, &log, ctx.as_ref()) {
        Ok(plan) => plan,
        Err(why) => return error(why),
    };
    let rule_id = match record(&caller.id, &plan) {
        Ok(Some(id)) => id,
        Ok(None) => return text("That was already remembered: those cards don't ask any more."),
        Err(e) => return error(e.to_string()),
    };
    let mut note = runner::new_message(&caller.id, MessageKind::Note, line(&caller.name, &plan));
    note.remembered = Some(Remembered {
        rule_id,
        team: plan.team,
        active: true,
    });
    if let Err(e) = runner::record(app, note) {
        tracing::warn!(error = %e, "remembered line could not be recorded");
    }
    // The cards waiting in this chat that it covers: allowed, by their rule.
    let mut allowed = 0;
    if let Ok(open) = store::pending_approvals(&caller.id) {
        for id in covered(&plan.scope, &open, ctx.as_ref()) {
            let Some(card) = open.iter().find(|a| a.request_id == id) else {
                continue;
            };
            // The user answering it right now keeps their answer.
            let Some(_claim) = super::answer_gate::try_claim(&caller.id, &id, "Always allowed")
            else {
                continue;
            };
            match store::allow_always(&caller.id, &id, &plan.scope) {
                Ok(Some(message)) => {
                    let _ = app.emit(runner::EVENT_MESSAGE, &message);
                }
                Ok(None) => continue,
                Err(e) => {
                    tracing::warn!(request_id = %id, error = %e, "covered card not answered");
                    continue;
                }
            }
            allowed += 1;
            if !super::mcp::answer_approval(&id, true) {
                if let Err(e) = super::mcp::answer_late(app, &caller.id, card, true) {
                    tracing::warn!(request_id = %id, error = %e, "covered card could not wake its agent");
                }
            }
        }
    }
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    let waiting = match allowed {
        0 => String::new(),
        1 => " The card waiting for it was allowed.".to_string(),
        n => format!(" The {n} cards waiting for it were allowed."),
    };
    text(format!(
        "Remembered. A line in the chat says so, with Undo.{waiting} Tell the user in one line; don't repeat the line."
    ))
}

#[cfg(test)]
#[path = "remember_tests.rs"]
mod tests;
