//! One yes for the whole plan (`ask_plan`).
//!
//! Before several outward things an agent already knows it needs (a deploy,
//! an issue and two comments, a push and a pull request), it lists them once
//! with `ask_plan`. The user answers one card ("Do these under your name?",
//! a numbered list, Allow / Deny: desk, phone, Catch up, or a typed "yes" in
//! that chat), or has already said yes in chat to the plan the agent just
//! listed. Allow creates a **plan grant**: those actions, each matched on
//! what it is (a push, a comment, a deploy…) *and* where (a repo, a project,
//! a channel, a host), for [`LIFETIME_MS`], held by the agent and every
//! agent it hands the work to (`carry`, from `message_agent`). Each covered
//! call then runs without a card and leaves a line ("Under your OK · …").
//!
//! **What a grant never covers** (the floor): money and payments,
//! credentials, the Keychain and `sudo`, deleting anything (data outside the
//! projects, a branch, an issue, a repo), force pushes, system persistence
//! and system tools, and anything on a line the plan doesn't name. It never
//! applies in a turn answering outside text. At "Check with me often" and
//! "Use good judgement" a covered command must be *only* what was listed
//! (and `cd`); at "Go hard" and "Full send" the rest of the line is judged
//! by that level as usual.
//!
//! **Provenance.** A grant comes only from the user: Allow on the plan card
//! (`commands::agents::answer_card`), or the user's own typed yes in chat
//! (`note_chat_yes`, called only from their send) to a plan the agent's
//! previous reply listed: every action's target must appear in that reply.
//! Kept in memory: a restart forgets every grant.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use tauri::AppHandle;

use super::autoallow::Ctx;
use super::independence::Level;
use super::runner;
use super::store::{self, MessageKind};

pub const TOOL: &str = "ask_plan";

pub const DESCRIPTION: &str = "Before outward actions you already know you'll do (sending, posting, issues and comments, deploys including production, pushes, pull requests), list them all here once. The user answers one card \"Do these under your name?\" (or already said yes in chat to the plan you just listed). Once allowed, each listed action runs without another card for 60 minutes, for you and any agent you hand it to with message_agent. Never for paying, credentials, sudo or deleting.";

/// How long a plan the user allowed stays good.
pub const LIFETIME_MS: i64 = 60 * 60 * 1000;

/// How long the user's typed yes stays an answer to the plan before it.
const CHAT_YES_MS: i64 = 15 * 60 * 1000;

/// At most this many actions on one card.
const MAX_ACTIONS: usize = 12;

/// At most this long, an action's exact text.
const MAX_TEXT: usize = 4000;

/// The line each covered action leaves, in "What it did" and the chat.
pub const LINE: &str = "Under your OK";

/// The card's title.
pub const TITLE: &str = "Do these under your name?";

/// What an action is. Matched against what a call does: a comment is not a
/// push, and a deploy is not a post.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Push,
    PullRequest,
    Merge,
    Issue,
    Comment,
    Release,
    Deploy,
    Publish,
    Post,
    Send,
    /// A web request that writes (`curl -X POST`), to a host.
    Request,
    /// Any other GitHub write on a repo (a workflow run, a label).
    Github,
}

const KINDS: &[(&str, Kind)] = &[
    ("push", Kind::Push),
    ("pull_request", Kind::PullRequest),
    ("merge", Kind::Merge),
    ("issue", Kind::Issue),
    ("comment", Kind::Comment),
    ("release", Kind::Release),
    ("deploy", Kind::Deploy),
    ("publish", Kind::Publish),
    ("post", Kind::Post),
    ("send", Kind::Send),
    ("request", Kind::Request),
    ("github", Kind::Github),
];

/// One action on the plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAction {
    pub kind: Kind,
    /// Where: a repo (`owner/repo`), a project, a channel, a site or address.
    pub target: String,
    /// In the agent's words: "Redeploy shippy's production on Vercel".
    pub summary: String,
    /// The exact words it sends, posts or comments, when it does: shown on
    /// the card, and the only words this action covers when the user holds
    /// sends for the exact text (`outward`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// What a plan card carries (`Approval::plan`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub actions: Vec<PlanAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

pub fn schema() -> Value {
    let kinds: Vec<&str> = KINDS.iter().map(|(k, _)| *k).collect();
    json!({
        "type": "object",
        "properties": {
            "actions": {
                "type": "array",
                "description": "Every outward action, in order, one each (two comments are two actions).",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": kinds },
                        "target": { "type": "string", "description": "Where: the repo (owner/repo), the project, the channel, the site or address." },
                        "summary": { "type": "string", "description": "What it does, in a few words the user reads on the card." },
                        "text": { "type": "string", "description": "For a send, post, comment, email, issue or pull request: everything it will send (title and body), word for word. Required to cover it when the user OKs exact text; the call must send exactly these words." }
                    },
                    "required": ["kind", "target", "summary"]
                }
            },
            "why": { "type": "string", "description": "One line: what it's for." }
        },
        "required": ["actions"]
    })
}

/* ------------------------------------------------------------ grants */

#[derive(Debug, Clone)]
struct Slot {
    action: PlanAction,
    used: bool,
}

#[derive(Debug, Clone)]
struct Grant {
    /// So the user can take one back ("What it does on its own").
    id: String,
    holders: Vec<String>,
    slots: Vec<Slot>,
    /// Calls already made under it: the same call again (a retry) is covered.
    made: Vec<(String, Value)>,
    expires_at: i64,
}

static GRANTS: LazyLock<Mutex<Vec<Grant>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn with_grants<T>(f: impl FnOnce(&mut Vec<Grant>) -> T) -> T {
    let mut g = GRANTS.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut g)
}

/// The user allowed `plan` for `agent_id`: a grant from `now`.
pub fn grant(agent_id: &str, plan: &Plan, now: i64) {
    with_grants(|g| {
        g.retain(|x| x.expires_at > now);
        g.push(Grant {
            id: store::new_id(),
            holders: vec![agent_id.to_string()],
            slots: plan
                .actions
                .iter()
                .map(|a| Slot {
                    action: a.clone(),
                    used: false,
                })
                .collect(),
            made: Vec::new(),
            expires_at: now + LIFETIME_MS,
        });
    });
}

/// `from` handed work to `to` (`message_agent`): every plan `from` holds
/// goes with it, for the actions still on it.
pub fn carry(from: &str, to: &str, now: i64) -> bool {
    with_grants(|g| {
        let mut carried = false;
        for x in g.iter_mut().filter(|x| x.expires_at > now) {
            if x.holders.iter().any(|h| h == from) && !x.holders.iter().any(|h| h == to) {
                x.holders.push(to.to_string());
                carried = true;
            }
        }
        carried
    })
}

/// Whether `agent_id` holds a live plan.
pub fn holds(agent_id: &str, now: i64) -> bool {
    with_grants(|g| {
        g.iter()
            .any(|x| x.expires_at > now && x.holders.iter().any(|h| h == agent_id))
    })
}

/// One live plan grant, as "What it does on its own" shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub id: String,
    /// Each listed action's summary, and whether it was done already (a
    /// retry of a done action is still covered).
    pub actions: Vec<(String, bool)>,
    /// Every agent holding it, the one the user allowed it for first.
    pub holders: Vec<String>,
    pub expires_at: i64,
}

/// The live plans `agent_id` holds, soonest to end first.
pub fn held_by(agent_id: &str, now: i64) -> Vec<Held> {
    with_grants(|g| {
        let mut out: Vec<Held> = g
            .iter()
            .filter(|x| x.expires_at > now && x.holders.iter().any(|h| h == agent_id))
            .map(|x| Held {
                id: x.id.clone(),
                actions: x
                    .slots
                    .iter()
                    .map(|s| (s.action.summary.clone(), s.used))
                    .collect(),
                holders: x.holders.clone(),
                expires_at: x.expires_at,
            })
            .collect();
        out.sort_by_key(|h| h.expires_at);
        out
    })
}

/// The user takes a plan back: it ends now for every agent holding it,
/// since it was one yes. Whether there was one to take back.
pub fn revoke(id: &str) -> bool {
    with_grants(|g| {
        let before = g.len();
        g.retain(|x| x.id != id);
        g.len() != before
    })
}

/* --------------------------------------------- the user's yes in chat */

/// (when, the agent's reply it answered).
static CHAT_YES: LazyLock<Mutex<HashMap<String, (i64, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The user's own typed yes (`agents_send`, desk or phone, and nothing
/// else), with no card it answered: kept, with the reply it says yes to, so
/// a plan that reply listed becomes a grant without a card.
pub fn note_chat_yes(agent_id: &str, proposal: &str, now: i64) {
    if proposal.trim().is_empty() {
        return;
    }
    CHAT_YES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), (now, proposal.to_string()));
}

/// The agent's last reply before the user's message: what a yes answers.
pub fn last_reply(log: &[store::AgentMessage]) -> Option<String> {
    let mut seen_user = false;
    for m in log.iter().rev() {
        match m.kind {
            MessageKind::User if !seen_user => seen_user = true,
            MessageKind::User => return None,
            MessageKind::Agent if seen_user => return Some(m.text.clone()),
            _ => {}
        }
    }
    None
}

/// The yes in chat, taken, when it answers this plan: fresh, and every
/// action's target named in the reply it said yes to.
fn take_chat_yes(agent_id: &str, plan: &Plan, now: i64) -> bool {
    let mut map = CHAT_YES.lock().unwrap_or_else(|e| e.into_inner());
    let Some((at, proposal)) = map.get(agent_id) else {
        return false;
    };
    if now - at > CHAT_YES_MS || now < *at {
        map.remove(agent_id);
        return false;
    }
    // An action's exact words were in the reply too: the yes saw them.
    let said = super::outward::norm(proposal);
    if !plan.actions.iter().all(|a| {
        named_in(&a.target, proposal)
            && a.text
                .as_deref()
                .is_none_or(|t| said.contains(&super::outward::norm(t)))
    }) {
        return false;
    }
    map.remove(agent_id);
    true
}

/// The user's yes in chat covers `plan`: the turn answers their typed
/// message and nothing else (a "yes" batched with another agent's request
/// or an app note may be answering either, so the card asks:
/// `runner::users_message_alone`), and the yes answers this plan
/// (`take_chat_yes`, which it takes).
pub(super) fn chat_yes_covers(caller_id: &str, plan: &Plan, now: i64) -> bool {
    runner::users_message_alone(caller_id) && take_chat_yes(caller_id, plan, now)
}

/// Whether `target` (or its last part: `shippy` of `julian/shippy`) is in
/// the text.
fn named_in(target: &str, text: &str) -> bool {
    let t = norm(target);
    if t.len() < 2 {
        return false;
    }
    let text = text.to_ascii_lowercase();
    let last = t.rsplit('/').next().unwrap_or(&t);
    text.contains(&t) || (last.len() >= 2 && text.contains(last))
}

/* ------------------------------------------------------------ the tool */

/// Read the tool's arguments into a plan, or what's wrong with them.
pub fn parse(args: &Value) -> Result<Plan, String> {
    let Some(list) = args.get("actions").and_then(Value::as_array) else {
        return Err("List the actions in `actions`.".into());
    };
    if list.is_empty() {
        return Err("List at least one action.".into());
    }
    if list.len() > MAX_ACTIONS {
        return Err(format!(
            "At most {MAX_ACTIONS} actions on one card; ask for the rest after."
        ));
    }
    let mut actions = Vec::new();
    for a in list {
        let field = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").trim();
        let kind = KINDS
            .iter()
            .find(|(k, _)| *k == field("kind"))
            .map(|(_, k)| *k)
            .ok_or_else(|| {
                format!(
                    "`kind` is one of: {}. Paying, credentials, sudo and deleting are never on a plan: ask for those on their own card.",
                    KINDS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")
                )
            })?;
        let (target, summary) = (field("target"), field("summary"));
        if norm(target).len() < 2 {
            return Err(
                "Each action needs its `target`: the repo, project, channel or site.".into(),
            );
        }
        if summary.is_empty() {
            return Err("Each action needs a `summary` the user reads.".into());
        }
        let text = a
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty());
        if text.is_some_and(|t| t.chars().count() > MAX_TEXT) {
            return Err(format!(
                "Keep each action's `text` under {MAX_TEXT} characters; ask for a longer one on its own card."
            ));
        }
        actions.push(PlanAction {
            kind,
            target: target.chars().take(200).collect(),
            summary: summary.chars().take(200).collect(),
            text: text.map(str::to_string),
        });
    }
    let why = args
        .get("why")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map(|w| w.chars().take(300).collect());
    Ok(Plan { actions, why })
}

/// An action's exact words, as the card shows them under it.
fn text_line(a: &PlanAction) -> String {
    a.text
        .as_deref()
        .map(|t| format!("\n   Exactly: “{t}”"))
        .unwrap_or_default()
}

/// The numbered list, as the card and the agent read it.
pub fn numbered(plan: &Plan) -> String {
    plan.actions
        .iter()
        .enumerate()
        .map(|(i, a)| format!("{}. {}{}", i + 1, a.summary, text_line(a)))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn card_detail(plan: &Plan) -> String {
    let list = plan
        .actions
        .iter()
        .enumerate()
        .map(|(i, a)| format!("{}. {} ({}){}", i + 1, a.summary, a.target, text_line(a)))
        .collect::<Vec<_>>()
        .join("\n");
    match &plan.why {
        Some(why) => format!("{list}\n\nWhy: {why}"),
        None => list,
    }
}

const GO: &str = "Do them now. Each listed action runs without another card for the next 60 minutes, for you and any agent you hand it to with message_agent. Don't ask the user again, and never tell them a step may still show a card. Anything not on the list, and paying, credentials, sudo or deleting, still asks.";

/// `ask_plan`.
pub async fn call(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    if runner::from_outside(&caller.id) {
        return crate::agent_bridge::tool_error_result(
            "Not while answering text from outside this app: ask for each action on its own card.",
        );
    }
    let plan = match parse(args) {
        Ok(p) => p,
        Err(e) => return crate::agent_bridge::tool_error_result(&e),
    };
    let now = store::now_ms();
    // The user's own yes in chat to the plan just listed.
    if chat_yes_covers(&caller.id, &plan, now) {
        grant(&caller.id, &plan, now);
        let _ = runner::record_in_turn(
            app,
            runner::new_message(
                &caller.id,
                MessageKind::Note,
                format!("Your yes covers, for an hour:\n{}", numbered(&plan)),
            ),
        );
        return text(format!("The user already said yes to this in chat. {GO}"));
    }
    let answer = super::mcp::ask_plan_card(
        app,
        caller,
        TITLE.to_string(),
        plan_summary(&plan),
        card_detail(&plan),
        plan.clone(),
    )
    .await;
    // Allow made the grant where it was answered (`answer_card`). No answer
    // yet: the card stays up (`expiry::stays_open`), and a later Allow
    // wakes this agent to do it (`mcp::answer_late`).
    match super::mcp::refused_reply(&answer, "do any of it") {
        None => text(format!("The user allowed the plan. {GO}")),
        Some(_) if answer == super::mcp::Answer::NotYet => text(WAITING.to_string()),
        Some(why) => text(why),
    }
}

/// What the agent is told when its plan card is still up, unanswered.
pub const WAITING: &str = "No answer yet. The card stays in the user's chat until they answer it, and when they allow it you're woken to do it: don't ask again, don't do any of it before then, and don't work around it. Tell the user in one line that it's waiting on their OK on the card, then stop.";

/// The card's plain text, for clients that don't draw the list.
pub fn plan_summary(plan: &Plan) -> String {
    match &plan.why {
        Some(why) => format!("{}\n\n{why}", numbered(plan)),
        None => numbered(plan),
    }
}

fn text(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }] })
}

/// The agent's line when a late Allow made the grant.
pub fn late_line(plan: &Plan) -> String {
    format!(
        "[The user has now allowed the plan you asked for: {}. {GO}]",
        numbered(plan).replace('\n', " ")
    )
}

/* ------------------------------------------------------------ matching */

/// What a call does, and the places it names.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Call {
    pub kind: Kind,
    pub places: Vec<String>,
}

fn kind_ok(listed: Kind, call: Kind) -> bool {
    use Kind::*;
    listed == call
        || matches!(
            (listed, call),
            (Post, Send) | (Send, Post) | (Post, Request) | (Send, Request) | (Request, Post) | (Request, Send)
        )
        // "Any GitHub write on the repo" covers its issues, comments and
        // pull requests; never a merge or a release, which are their own.
        || (listed == Github && matches!(call, Issue | Comment | PullRequest | Push))
}

/// Lower case, no scheme, `www.`, `github.com/`, `.git` or slashes at the end.
fn norm(s: &str) -> String {
    let mut t = s
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_ascii_lowercase();
    for scheme in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = t.strip_prefix(scheme) {
            t = rest.to_string();
        }
    }
    if let Some(rest) = t.strip_prefix("www.") {
        t = rest.to_string();
    }
    if let Some(rest) = t.strip_prefix("github.com/") {
        t = rest.to_string();
    }
    let t = t.trim_end_matches('/');
    let t = t.strip_suffix(".git").unwrap_or(t);
    t.trim_start_matches('#').to_string()
}

/// Deployment hosts named after the project (`shippy-abc123.vercel.app`).
const DEPLOY_HOSTS: &[&str] = &[
    ".vercel.app",
    ".netlify.app",
    ".pages.dev",
    ".fly.dev",
    ".web.app",
    ".surge.sh",
];

fn target_ok(target: &str, places: &[String]) -> bool {
    let t = norm(target);
    if t.len() < 2 {
        return false;
    }
    let t_host = t.split('/').next().unwrap_or("").to_string();
    places.iter().map(|p| norm(p)).any(|p| {
        !p.is_empty()
            && (p == t
                || p.ends_with(&format!("/{t}"))
                || (!p.contains('/') && t.ends_with(&format!("/{p}")))
                || (t_host.contains('.') && (p == t_host || p.ends_with(&format!(".{t_host}"))))
                || DEPLOY_HOSTS.iter().any(|h| {
                    p.ends_with(h) && {
                        let label = p.split('.').next().unwrap_or("");
                        label == t || label.starts_with(&format!("{t}-"))
                    }
                }))
    })
}

/// `texts`: when the user OKs exact text (`outward`), what the call sends;
/// the action must carry text holding all of it, word for word.
fn matches(a: &PlanAction, call: &Call, texts: Option<&super::outward::Texts>) -> bool {
    kind_ok(a.kind, call.kind)
        && target_ok(&a.target, &call.places)
        && texts.is_none_or(|t| {
            a.text
                .as_deref()
                .is_some_and(|x| super::outward::approved_covers(x, t))
        })
}

/// The slot covering `call` in a grant `holder` holds: one not used yet,
/// else (the same call made again) the one it used.
#[allow(clippy::too_many_arguments)]
fn find(
    grants: &[Grant],
    holder: &str,
    call: &Call,
    made: &(String, Value),
    taken: &[(usize, usize)],
    now: i64,
    texts: Option<&super::outward::Texts>,
) -> Option<(usize, usize)> {
    let live = |g: &Grant| g.expires_at > now && g.holders.iter().any(|h| h == holder);
    for (gi, g) in grants.iter().enumerate().filter(|(_, g)| live(g)) {
        for (si, s) in g.slots.iter().enumerate() {
            if !s.used && !taken.contains(&(gi, si)) && matches(&s.action, call, texts) {
                return Some((gi, si));
            }
        }
    }
    for (gi, g) in grants.iter().enumerate().filter(|(_, g)| live(g)) {
        if g.made.contains(made) {
            if let Some(si) = g
                .slots
                .iter()
                .position(|s| s.used && matches(&s.action, call, texts))
            {
                return Some((gi, si));
            }
        }
    }
    None
}

fn commit(grants: &mut [Grant], picked: &[(usize, usize)], made: (String, Value)) -> Vec<String> {
    let mut lines = Vec::new();
    for &(gi, si) in picked {
        let g = &mut grants[gi];
        let slot = &mut g.slots[si];
        lines.push(slot.action.summary.clone());
        slot.used = true;
        if !g.made.contains(&made) {
            g.made.push(made.clone());
        }
    }
    lines
}

/// What the evaluation of a call needs to know about the turn.
pub(super) struct Turn<'a> {
    pub holder: &'a str,
    pub ctx: &'a Ctx,
    pub level: Level,
    /// The turn read outside content (`exposure`): a command must be only
    /// what was listed.
    pub exposed: bool,
    /// A browser step a plan could cover (`browser_gate::plan_step`).
    pub browser: Option<(&'static str, String)>,
    pub now: i64,
    /// The user OKs the exact text of what goes out under their name
    /// (`outward`), and this call sends: only an action whose `text` holds
    /// every word it sends covers it.
    pub exact: bool,
    /// What was typed on the page, for a browser send.
    pub typed: Vec<String>,
}

/// Whether a plan covers this call: the summaries of what it covers,
/// marked used. `None` leaves the call to the usual decision.
pub(super) fn cover(tool: &str, input: &Value, turn: &Turn) -> Option<Vec<String>> {
    with_grants(|grants| cover_in(grants, tool, input, turn))
}

fn cover_in(grants: &mut [Grant], tool: &str, input: &Value, turn: &Turn) -> Option<Vec<String>> {
    let made = (tool.to_string(), input.clone());
    if tool == "Bash" {
        let command = input.get("command").and_then(Value::as_str)?;
        let parts = bash_parts(command, turn.ctx);
        // Exact text: what the line sends, and every part that sends must
        // be covered by an action carrying those words.
        let texts = turn
            .exact
            .then(|| super::outward::texts(tool, input, Some(turn.ctx), &[]));
        let mut picked = Vec::new();
        let mut covered = Vec::new();
        let mut all_listed = true;
        let mut send_uncovered = false;
        for (words, part) in &parts {
            let sends = turn.exact && super::outward::words_send(words);
            match part {
                Part::Cd => {}
                Part::Outward(call) => {
                    let need = if sends { texts.as_ref() } else { None };
                    match find(grants, turn.holder, call, &made, &picked, turn.now, need) {
                        Some(slot) => {
                            picked.push(slot);
                            covered.push(words.clone());
                        }
                        None => {
                            all_listed = false;
                            send_uncovered |= sends;
                        }
                    }
                }
                Part::Other => {
                    all_listed = false;
                    send_uncovered |= sends;
                }
            }
        }
        if picked.is_empty() || send_uncovered {
            return None;
        }
        let strict = !turn.level.goes_hard() || turn.exposed;
        if strict && !all_listed {
            return None;
        }
        // The rest of the line, judged as usual; what's covered, as allowed.
        let allowed = super::go_hard::with_covered(covered, || {
            if strict {
                let ctx = Ctx {
                    full_send: false,
                    ..turn.ctx.clone()
                };
                !super::go_hard::asks(tool, input, &ctx, false)
            } else {
                super::autoallow::auto(turn.level, false, tool, input, turn.ctx).is_some()
            }
        });
        return allowed.then(|| commit(grants, &picked, made));
    }
    let call = if tool.starts_with(super::browser_gate::SERVER)
        || super::browser_gate::is_own_browser(tool)
    {
        let (verb, host) = turn.browser.clone()?;
        Call {
            kind: browser_kind(verb)?,
            places: vec![host],
        }
    } else if tool.starts_with("mcp__") {
        connector_call(tool, input)?
    } else {
        return None;
    };
    let texts = turn
        .exact
        .then(|| super::outward::texts(tool, input, Some(turn.ctx), &turn.typed));
    let slot = find(
        grants,
        turn.holder,
        &call,
        &made,
        &[],
        turn.now,
        texts.as_ref(),
    )?;
    Some(commit(grants, &[slot], made))
}

fn browser_kind(verb: &str) -> Option<Kind> {
    Some(match verb {
        "posted" | "scheduled" | "shared" => Kind::Post,
        "replied" => Kind::Comment,
        "sent" | "submitted" => Kind::Send,
        "published" => Kind::Publish,
        _ => return None,
    })
}

/* ------------------------------------------------------------ commands */

#[derive(Debug)]
enum Part {
    Cd,
    Outward(Call),
    Other,
}

fn bash_parts(command: &str, ctx: &Ctx) -> Vec<(Vec<String>, Part)> {
    let mut here = ctx.clone();
    let mut out = Vec::new();
    for words in super::go_hard::commands(command) {
        if words.first().map(String::as_str) == Some("cd") {
            if let Some(dir) = words.get(1).and_then(|d| super::go_hard::resolve(d, &here)) {
                here.cwd = dir;
            }
            out.push((words, Part::Cd));
            continue;
        }
        let part = match command_call(&words, &here) {
            Some(call) => Part::Outward(call),
            None => Part::Other,
        };
        out.push((words, part));
    }
    out
}

/// Flags that take a value, so it isn't read as a positional argument.
const VALUE_FLAGS: &[&str] = &[
    "-R",
    "--repo",
    "-t",
    "--title",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-B",
    "--base",
    "-H",
    "--head",
    "-l",
    "--label",
    "-a",
    "--assignee",
    "-m",
    "--milestone",
    "-X",
    "--method",
    "-f",
    "--field",
    "--raw-field",
    "--scope",
    "--project",
    "--token",
    "--site",
    "--app",
    "-s",
    "-p",
    "--name",
    "--env",
    "-e",
    "--message",
    "--input",
    "-r",
    "--reviewer",
];

fn positionals<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        if VALUE_FLAGS.contains(&a) {
            i += 2;
            continue;
        }
        if !a.starts_with('-') {
            out.push(a);
        }
        i += 1;
    }
    out
}

fn flag_value<'a>(args: &[&'a str], names: &[&str]) -> Option<&'a str> {
    for (i, a) in args.iter().enumerate() {
        for n in names {
            if a == n {
                return args.get(i + 1).copied();
            }
            if let Some(v) = a.strip_prefix(&format!("{n}=")) {
                return Some(v);
            }
        }
    }
    None
}

fn command_call(words: &[String], ctx: &Ctx) -> Option<Call> {
    let ws: Vec<&str> = words.iter().map(String::as_str).collect();
    let rest = super::go_hard::unwrapped(&ws);
    let (&prog, args) = rest.split_first()?;
    let prog = super::go_hard::base(prog);
    let cwd = ctx.cwd.clone();
    let has = |w: &[&str]| args.iter().any(|a| w.contains(a));
    match prog {
        "git" => {
            let mut i = 0;
            let mut dir = cwd.clone();
            while i < args.len() {
                let a = args[i];
                if a == "-C" {
                    if let Some(d) = args
                        .get(i + 1)
                        .and_then(|d| super::go_hard::resolve(d, ctx))
                    {
                        dir = d;
                    }
                    i += 2;
                } else if matches!(a, "-c" | "--git-dir" | "--work-tree" | "--namespace") {
                    i += 2;
                } else if a.starts_with('-') {
                    i += 1;
                } else {
                    break;
                }
            }
            let sub = args.get(i).copied()?;
            let rest = &args[i + 1..];
            match sub {
                "push" => {
                    // Rewriting or deleting what's on the remote is never on a plan.
                    let destroys = rest.iter().any(|a| {
                        matches!(
                            *a,
                            "-f" | "--force"
                                | "-d"
                                | "--delete"
                                | "--mirror"
                                | "--prune"
                                | "--tags"
                                | "--all"
                        ) || a.starts_with("--force")
                            || a.starts_with('+')
                            || a.starts_with(':')
                            || a.contains(":refs/") && a.starts_with(':')
                    });
                    if destroys {
                        return None;
                    }
                    let mut places = repo_places(&dir);
                    places.extend(
                        rest.iter()
                            .filter(|a| a.contains("://") || a.contains('@'))
                            .map(|a| remote_repo(a).unwrap_or_else(|| a.to_string())),
                    );
                    Some(Call {
                        kind: Kind::Push,
                        places,
                    })
                }
                "send-email" => Some(Call {
                    kind: Kind::Send,
                    places: rest.iter().map(|a| a.to_string()).collect(),
                }),
                _ => None,
            }
        }
        "gh" => gh_call(args, &cwd),
        "vercel" => {
            let pos = positionals(args);
            const NEVER: &[&str] = &[
                "env", "secrets", "secret", "remove", "rm", "domains", "dns", "certs", "teams",
                "login", "logout", "project", "projects",
            ];
            if pos.first().is_some_and(|s| NEVER.contains(s)) {
                return None;
            }
            let mut places = dir_places(&cwd);
            places.extend(flag_value(args, &["--scope", "--project"]).map(str::to_string));
            places.extend(pos.iter().filter_map(|p| host_or_word(p)));
            Some(Call {
                kind: Kind::Deploy,
                places,
            })
        }
        "netlify" | "ntl" | "fly" | "flyctl" | "firebase" | "wrangler" | "heroku" | "railway"
        | "render" | "surge" | "amplify" => {
            let deploys = args.iter().any(|a| {
                matches!(*a, "deploy" | "publish" | "up" | "release" | "promote")
                    || a.contains(":deploy")
                    || a.starts_with("deploy")
            });
            if !deploys || has(&["destroy", "delete", "remove", "rm", "secrets", "env"]) {
                return None;
            }
            let mut places = dir_places(&cwd);
            places.extend(
                flag_value(
                    args,
                    &["--site", "--app", "-a", "--project", "--name", "-s", "-p"],
                )
                .map(str::to_string),
            );
            places.extend(positionals(args).iter().filter_map(|p| host_or_word(p)));
            Some(Call {
                kind: Kind::Deploy,
                places,
            })
        }
        "npm" | "pnpm" | "yarn" | "bun" => {
            if !has(&["publish"]) || has(&["unpublish", "deprecate", "owner", "dist-tag"]) {
                return None;
            }
            let mut places = dir_places(&cwd);
            places.extend(package_name(&cwd));
            Some(Call {
                kind: Kind::Publish,
                places,
            })
        }
        "curl" | "wget" | "http" | "https" | "xh" | "xhs" => {
            if args.iter().any(|a| super::go_hard::pay_api(a)) {
                return None;
            }
            let places: Vec<String> = args
                .iter()
                .filter_map(|a| super::browser_gate::host_of(a))
                .collect();
            (!places.is_empty()).then_some(Call {
                kind: Kind::Request,
                places,
            })
        }
        "osascript" => Some(Call {
            kind: Kind::Send,
            places: args
                .iter()
                .flat_map(|a| {
                    a.split(|c: char| !(c.is_ascii_alphanumeric() || "@.+-_".contains(c)))
                        .filter(|w| w.len() >= 2)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .collect(),
        }),
        p if super::go_hard::is_messenger(p) => Some(Call {
            kind: Kind::Send,
            places: positionals(args).iter().map(|a| a.to_string()).collect(),
        }),
        _ => None,
    }
}

fn gh_call(args: &[&str], cwd: &Path) -> Option<Call> {
    let pos = positionals(args);
    let (group, action) = (*pos.first()?, pos.get(1).copied().unwrap_or(""));
    let kind = match (group, action) {
        ("issue", "create" | "edit" | "close" | "reopen") => Kind::Issue,
        ("issue", "comment") | ("pr", "comment") => Kind::Comment,
        ("pr", "create" | "edit" | "ready" | "review" | "close" | "reopen") => Kind::PullRequest,
        ("pr", "merge") => Kind::Merge,
        ("release", "create" | "edit" | "upload") => Kind::Release,
        ("workflow", "run") | ("run", "rerun") => Kind::Github,
        ("api", _) => return gh_api_call(args, &pos),
        _ => return None,
    };
    let places = match flag_value(args, &["-R", "--repo"]) {
        Some(repo) => vec![repo.to_string()],
        None => repo_places(cwd),
    };
    Some(Call { kind, places })
}

fn gh_api_call(args: &[&str], pos: &[&str]) -> Option<Call> {
    let method = flag_value(args, &["-X", "--method"])
        .or_else(|| {
            args.iter()
                .find_map(|a| a.strip_prefix("-X"))
                .filter(|m| !m.is_empty())
        })
        .unwrap_or("")
        .to_ascii_uppercase();
    if method == "DELETE" {
        return None;
    }
    let path = pos.get(1)?.trim_start_matches('/');
    let segs: Vec<&str> = path.split(['/', '?']).collect();
    if segs.first() != Some(&"repos") || segs.len() < 3 {
        return None;
    }
    let repo = format!("{}/{}", segs[1], segs[2]);
    // Secrets, keys, hooks and collaborators are credentials and access.
    if segs.iter().any(|s| {
        matches!(
            *s,
            "secrets"
                | "keys"
                | "hooks"
                | "collaborators"
                | "variables"
                | "environments"
                | "actions"
        )
    }) && !segs.contains(&"dispatches")
    {
        return None;
    }
    let has = |s: &str| segs.contains(&s);
    let kind = if has("merge") {
        Kind::Merge
    } else if has("comments") {
        Kind::Comment
    } else if has("pulls") {
        Kind::PullRequest
    } else if has("issues") {
        Kind::Issue
    } else if has("releases") {
        Kind::Release
    } else {
        Kind::Github
    };
    Some(Call {
        kind,
        places: vec![repo],
    })
}

/// A web address's host, or a plain word (a project or app name).
fn host_or_word(arg: &str) -> Option<String> {
    if arg.contains("://") {
        return super::browser_gate::host_of(arg);
    }
    (!arg.contains('/') && arg.len() >= 2).then(|| arg.to_string())
}

/// `git@github.com:o/r.git`, `https://github.com/o/r` → `o/r`.
fn remote_repo(url: &str) -> Option<String> {
    let mut u = url.trim().to_string();
    for scheme in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = u.strip_prefix(scheme) {
            u = rest.to_string();
        }
    }
    if let Some((_, rest)) = u.split_once('@') {
        u = rest.to_string();
    }
    let u = u.replacen(':', "/", 1);
    let u = u.trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    let segs: Vec<&str> = u.split('/').filter(|s| !s.is_empty()).collect();
    (segs.len() >= 3).then(|| format!("{}/{}", segs[segs.len() - 2], segs[segs.len() - 1]))
}

/// The folder's own name and its repo's (`owner/repo` from each remote, the
/// main checkout's folder for a worktree), and a Vercel link's project name.
fn repo_places(dir: &Path) -> Vec<String> {
    let mut out = dir_places(dir);
    for d in dir.ancestors() {
        let dot = d.join(".git");
        let config = if dot.is_dir() {
            out.extend(name_of(d));
            dot.join("config")
        } else if dot.is_file() {
            let Ok(text) = std::fs::read_to_string(&dot) else {
                break;
            };
            let Some(gitdir) = text.trim().strip_prefix("gitdir:").map(str::trim) else {
                break;
            };
            let gitdir = d.join(gitdir);
            let common = std::fs::read_to_string(gitdir.join("commondir"))
                .map(|c| gitdir.join(c.trim()))
                .unwrap_or(gitdir);
            let common = std::fs::canonicalize(&common).unwrap_or(common);
            out.extend(name_of(d));
            if let Some(main) = common.parent() {
                out.extend(name_of(main));
            }
            common.join("config")
        } else {
            continue;
        };
        if let Ok(text) = std::fs::read_to_string(config) {
            for line in text.lines() {
                if let Some(url) = line.trim().strip_prefix("url").map(str::trim) {
                    if let Some(url) = url.strip_prefix('=') {
                        out.extend(remote_repo(url));
                    }
                }
            }
        }
        break;
    }
    out.sort();
    out.dedup();
    out
}

fn name_of(dir: &Path) -> Option<String> {
    dir.file_name().map(|n| n.to_string_lossy().to_string())
}

fn dir_places(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = name_of(dir).into_iter().collect();
    if let Ok(text) = std::fs::read_to_string(dir.join(".vercel/project.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            for k in ["projectName", "projectId"] {
                out.extend(v.get(k).and_then(Value::as_str).map(str::to_string));
            }
        }
    }
    out
}

fn package_name(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("name").and_then(Value::as_str).map(str::to_string)
}

/* ------------------------------------------------------------ connectors */

/// Words in a connector tool's name that are never on a plan.
const CONNECTOR_FLOOR: &[&str] = &[
    "pay",
    "payment",
    "payments",
    "charge",
    "payout",
    "payouts",
    "refund",
    "transfer",
    "invoice",
    "subscription",
    "checkout",
    "purchase",
    "buy",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "token",
    "tokens",
    "password",
    "key",
    "keys",
    "delete",
    "remove",
    "destroy",
    "drop",
    "wipe",
    "purge",
    "erase",
    "trash",
    "sql",
    "query",
    "execute",
    "migration",
    "member",
    "members",
    "collaborator",
    "permission",
    "permissions",
    "role",
    "roles",
    "invite",
];

/// Verbs that make a connector call a write.
const CONNECTOR_WRITES: &[&str] = &[
    "create", "update", "add", "edit", "post", "send", "push", "comment", "reply", "merge",
    "close", "reopen", "publish", "deploy", "redeploy", "promote", "submit", "write", "tweet",
    "repost", "schedule", "share", "forward", "commit", "fork", "assign", "label", "dispatch",
    "run",
];

fn connector_call(tool: &str, input: &Value) -> Option<Call> {
    let rest = tool.strip_prefix("mcp__")?;
    let mut parts = rest.split("__");
    let server = parts.next()?;
    let name = parts.last()?;
    let words: Vec<String> = super::mcp::split_words(name)
        .into_iter()
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let has = |w: &str| words.iter().any(|x| x == w);
    if words.iter().any(|w| CONNECTOR_FLOOR.contains(&w.as_str()))
        || !words.iter().any(|w| CONNECTOR_WRITES.contains(&w.as_str()))
    {
        return None;
    }
    let code_host = ["github", "gitlab", "bitbucket"]
        .iter()
        .any(|h| server.to_ascii_lowercase().contains(h));
    let kind = if has("merge") {
        Kind::Merge
    } else if has("comment") || has("reply") {
        Kind::Comment
    } else if has("review") || has("pull") || has("pr") || has("pulls") {
        Kind::PullRequest
    } else if has("issue") || has("issues") {
        Kind::Issue
    } else if has("release") {
        Kind::Release
    } else if has("deploy") || has("redeploy") || has("promote") || has("deployment") {
        Kind::Deploy
    } else if has("publish") {
        Kind::Publish
    } else if has("post") || has("tweet") || has("repost") || has("schedule") || has("share") {
        Kind::Post
    } else if has("send") || has("forward") || has("email") || has("message") || has("mail") {
        Kind::Send
    } else if code_host && (has("push") || has("commit") || has("file") || has("files")) {
        Kind::Push
    } else if code_host {
        Kind::Github
    } else {
        return None;
    };
    let mut places = vec![server.to_string(), super::mcp::service_name(server)];
    let field = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    if let (Some(owner), Some(repo)) = (field("owner"), field("repo")) {
        places.push(format!("{owner}/{repo}"));
    }
    const KEYS: &[&str] = &[
        "repo",
        "repository",
        "full_name",
        "channel",
        "channel_id",
        "channel_name",
        "channelId",
        "to",
        "recipient",
        "email",
        "project",
        "project_id",
        "projectId",
        "projectName",
        "project_name",
        "name",
        "site",
        "site_id",
        "app",
        "url",
        "team",
        "space",
        "deployment",
        "deploymentId",
        "deployment_id",
    ];
    for k in KEYS {
        match input.get(*k) {
            Some(Value::String(s)) => {
                places.push(s.clone());
                places.extend(super::browser_gate::host_of(s));
            }
            Some(Value::Array(list)) => {
                places.extend(list.iter().filter_map(Value::as_str).map(str::to_string))
            }
            _ => {}
        }
    }
    Some(Call { kind, places })
}

/// For the turn's working folder, without a running agent (tests).
#[cfg(test)]
pub(super) fn call_for_tests(tool: &str, input: &Value, ctx: &Ctx) -> Vec<Option<Kind>> {
    if tool == "Bash" {
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        return bash_parts(command, ctx)
            .into_iter()
            .filter(|(_, p)| !matches!(p, Part::Cd))
            .map(|(_, p)| match p {
                Part::Outward(c) => Some(c.kind),
                _ => None,
            })
            .collect();
    }
    vec![connector_call(tool, input).map(|c| c.kind)]
}

#[cfg(test)]
#[path = "plan_grant_tests.rs"]
mod tests;
