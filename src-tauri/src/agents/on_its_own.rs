//! "What can this agent do without asking me?", answered in plain words from
//! the app's own stores, never inferred (desk, phone and the Chief alike).
//!
//! Competitors show a list of plain-language "Allow automatically" rules; our
//! answer was spread over the level slider, the editor's Permissions, rules
//! remembered from chat (shown only on their chat line), plan grants (held in
//! memory, shown nowhere), "What it can reach", the admin switch, Runs on and
//! Slack. [`view`] reads every one of those for one agent:
//!
//! - its level (its own or the team's) and that level's one line, and the
//!   floor that asks at every level (plus the exact-text switch when on);
//! - every standing rule: Always allow chosen on a card, rules remembered
//!   from chat (its own and the team's), live plan grants with their end,
//!   app connections and their read / read-and-asks grant, its browsers,
//!   admin powers, the accounts it spends, and whether it replies in Slack
//!   by itself.
//!
//! Each item that can be narrowed carries the [`Narrow`]s offered for it.
//! [`narrow`] applies only a narrow the current view offers, so nothing here
//! can widen access: widening stays on cards and in Settings. It applies at
//! once and returns the line the caller leaves in the agent's chat.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::connections::{self, Access};
use super::independence::Level;
use super::permissions::Rule;
use super::plan_grant::Held;
use super::store::{self, Agent};
use crate::errors::CommandError;

/* ------------------------------------------------------------- words */

/// The slider's line for each stop: `INDEPENDENCE_DETAIL` in the protocol's
/// `independence.ts` (a test holds them equal).
pub fn level_line(level: Level) -> &'static str {
    match level {
        Level::Often => "Reads and looks around; asks before bigger changes.",
        Level::Judgement => {
            concat!("Reads and edits; asks before running changes or anything leaving this ", crate::computer::noun!(), ".")
        }
        Level::GoHard => concat!("Does local work on this ", crate::computer::noun!(), "; asks before anything leaves it."),
        Level::FullSend => {
            "Sends, posts and pushes too; only stops for money, logins, deleting for good or going live."
        }
    }
}

/// True at every level: `INDEPENDENCE_ALWAYS_ASKS`.
pub const ALWAYS_ASKS: &str =
    "Always asks before spending money, using your passwords, or deleting for good.";

/// With the exact-text switch on (`outward`).
pub const EXACT_TEXT: &str =
    "Anything it sends under your name waits for you to OK the exact words.";

/* ------------------------------------------------------------- model */

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Always allow, chosen on a card.
    Rule,
    /// Remembered from what the user said in this agent's chat.
    Said,
    /// Remembered from chat for every agent.
    TeamRule,
    /// A plan the user said yes to, while it lasts.
    Plan,
    /// An app connection granted to it.
    App,
    /// The user's Chrome or the agents' own browser.
    Browser,
    /// Admin: manages and answers for other agents.
    Admin,
    /// Which of the user's accounts its turns spend.
    Account,
    /// Answers the user's asks in Slack.
    Slack,
}

/// One way to narrow an item, in one tap. Every variant takes something
/// away; there is no variant that gives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Narrow {
    /// Forget a rule, its own or the team's (`remember::forget`).
    #[serde(rename_all = "camelCase")]
    Rule { rule_id: String },
    /// End a plan grant now, for every agent holding it.
    #[serde(rename_all = "camelCase")]
    Plan { grant_id: String },
    /// Take an app away from this agent (the account stays for others).
    #[serde(rename_all = "camelCase")]
    App { connection_id: String },
    /// Down from read-and-asks to read only.
    #[serde(rename_all = "camelCase")]
    AppReadOnly { connection_id: String },
    /// No browser for it: neither the user's Chrome nor the agents' own.
    Browser,
    /// Admin off.
    Admin,
    /// Its sends under the user's name, Slack replies included, wait for the
    /// exact words to be OK'd (`outward_text_needs_ok`, its own setting).
    ExactText,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Stable within one view, for lists.
    pub key: String,
    pub kind: Kind,
    /// What it may do, in plain words.
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// When it stops on its own (a plan grant), epoch ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
    /// What one tap may take away. Empty: shown, not changed here.
    pub narrow: Vec<Narrow>,
}

/// One agent's answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnItsOwn {
    pub agent_id: String,
    pub agent_name: String,
    pub level: Level,
    /// Its own level rather than the team's.
    pub own_level: bool,
    pub level_line: String,
    /// What asks whatever the rules say.
    pub always_asks: Vec<String>,
    pub items: Vec<Item>,
}

/// One agent's row in the team's answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRow {
    pub agent_id: String,
    pub name: String,
    pub level: Level,
    pub own_level: bool,
    /// How many standing items it has beyond its level (account excluded).
    pub standing: usize,
}

/// Settings → Agents: the team's level, the rules every agent shares, and
/// each agent in a line.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamOnItsOwn {
    pub level: Level,
    pub level_line: String,
    pub always_asks: Vec<String>,
    pub team_rules: Vec<Item>,
    pub agents: Vec<TeamRow>,
}

/* ------------------------------------------------------------- facts */

/// An app granted to the agent, as `connections.json` says.
#[derive(Debug, Clone, PartialEq)]
pub struct AppFact {
    pub connection_id: String,
    pub title: String,
    pub account: String,
    pub access: Access,
    pub needs_sign_in: bool,
}

/// Which browsers its turns get (outside text aside).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BrowserFact {
    pub claude_in_chrome: bool,
    pub your_chrome: bool,
    pub agents_browser: bool,
}

/// Slack, when it is connected, on, and this agent answers there.
#[derive(Debug, Clone, PartialEq)]
pub struct SlackFact {
    /// It posts its reply by itself (`slack::decide`'s level and exact-text
    /// conditions hold); else every reply is a card.
    pub by_itself: bool,
}

/// Everything [`build`] reads, gathered from the stores by [`facts_for`].
#[derive(Debug, Clone)]
pub struct Facts {
    pub agent: Agent,
    pub level: Level,
    pub own_level: bool,
    pub exact_text: bool,
    pub team_rules: Vec<Rule>,
    pub plans: Vec<Held>,
    /// Names for plan holders other than this agent.
    pub names: Vec<(String, String)>,
    pub apps: Vec<AppFact>,
    pub browser: BrowserFact,
    pub admin: bool,
    /// The account it is pinned to, by the name it is shown with.
    pub pinned_account: Option<String>,
    pub slack: Option<SlackFact>,
}

/* ------------------------------------------------------------- build */

fn sentence(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

fn rule_item(r: &Rule, team: bool) -> Item {
    let text = sentence(&super::remember::phrase(&r.scope));
    let (kind, detail) = match (&r.scope.said, team) {
        (Some(q), true) => (
            Kind::TeamRule,
            format!("Every agent · from what you said: “{q}”"),
        ),
        (None, true) => (Kind::TeamRule, "Every agent".to_string()),
        (Some(q), false) => (Kind::Said, format!("From what you said: “{q}”")),
        (None, false) => (Kind::Rule, "Always allowed on a card".to_string()),
    };
    Item {
        key: format!("rule:{}", r.id),
        kind,
        text,
        detail: Some(detail),
        ends_at: None,
        narrow: vec![Narrow::Rule {
            rule_id: r.id.clone(),
        }],
    }
}

fn plan_item(h: &Held, me: &str, names: &[(String, String)]) -> Item {
    let text = h
        .actions
        .iter()
        .map(|(s, done)| {
            if *done {
                format!("{s} (done)")
            } else {
                s.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    let others: Vec<&str> = h
        .holders
        .iter()
        .filter(|id| id.as_str() != me)
        .filter_map(|id| names.iter().find(|(i, _)| i == id).map(|(_, n)| n.as_str()))
        .collect();
    Item {
        key: format!("plan:{}", h.id),
        kind: Kind::Plan,
        text: sentence(&text),
        detail: Some(if others.is_empty() {
            "A plan you said yes to".to_string()
        } else {
            format!("A plan you said yes to · also for {}", others.join(", "))
        }),
        ends_at: Some(h.expires_at),
        narrow: vec![Narrow::Plan {
            grant_id: h.id.clone(),
        }],
    }
}

fn app_item(a: &AppFact) -> Item {
    let who = if a.account.is_empty() || a.account == a.title {
        a.title.clone()
    } else {
        format!("{} ({})", a.title, a.account)
    };
    let mut detail = match a.access {
        Access::Read => "Reads without asking; anything else is refused".to_string(),
        Access::Full => "Reads without asking; sending or changing asks you each time".to_string(),
    };
    if a.needs_sign_in {
        detail.push_str(" · needs signing in again");
    }
    let mut narrow = vec![Narrow::App {
        connection_id: a.connection_id.clone(),
    }];
    if a.access == Access::Full {
        narrow.push(Narrow::AppReadOnly {
            connection_id: a.connection_id.clone(),
        });
    }
    Item {
        key: format!("app:{}", a.connection_id),
        kind: Kind::App,
        text: format!("Uses {who}"),
        detail: Some(detail),
        ends_at: None,
        narrow,
    }
}

fn browser_item(b: &BrowserFact) -> Option<Item> {
    let chrome = b.claude_in_chrome || b.your_chrome;
    let text = match (chrome, b.agents_browser) {
        (true, true) => {
            "Opens pages in your Chrome, where you’re signed in, and in the agents’ own browser"
        }
        (true, false) => "Opens pages in your Chrome, where you’re signed in",
        (false, true) => "Opens pages in the agents’ own browser",
        (false, false) => return None,
    };
    let mut via = Vec::new();
    if b.claude_in_chrome {
        via.push("Claude in Chrome");
    }
    if b.your_chrome {
        via.push("the app’s Chrome extension");
    }
    let mut detail = String::new();
    if !via.is_empty() {
        detail.push_str(&format!("Through {} · ", via.join(" and ")));
    }
    detail.push_str("what it does on a page follows its level; never for text from outside");
    Some(Item {
        key: "browser".into(),
        kind: Kind::Browser,
        text: text.into(),
        detail: Some(detail),
        ends_at: None,
        narrow: vec![Narrow::Browser],
    })
}

/// One agent's answer from its facts. Pure.
pub fn build(f: &Facts) -> OnItsOwn {
    let mut items: Vec<Item> = Vec::new();
    items.extend(
        f.agent
            .permissions
            .iter()
            .filter(|r| r.scope.said.is_none())
            .map(|r| rule_item(r, false)),
    );
    items.extend(
        f.agent
            .permissions
            .iter()
            .filter(|r| r.scope.said.is_some())
            .map(|r| rule_item(r, false)),
    );
    items.extend(f.team_rules.iter().map(|r| rule_item(r, true)));
    items.extend(f.plans.iter().map(|h| plan_item(h, &f.agent.id, &f.names)));
    items.extend(f.apps.iter().map(app_item));
    items.extend(browser_item(&f.browser));
    if f.admin {
        items.push(Item {
            key: "admin".into(),
            kind: Kind::Admin,
            text: "Manages the team: answers other agents’ local requests, pauses them, changes their routines".into(),
            detail: Some("Never spending, sending, publishing, pushing or keys: those come to you".into()),
            ends_at: None,
            narrow: vec![Narrow::Admin],
        });
    }
    if let Some(s) = &f.slack {
        items.push(if s.by_itself {
            Item {
                key: "slack".into(),
                kind: Kind::Slack,
                text: "Replies in Slack by itself, under your name".into(),
                detail: Some("Only to what you asked there yourself, in a turn that read nothing from outside".into()),
                ends_at: None,
                narrow: vec![Narrow::ExactText],
            }
        } else {
            Item {
                key: "slack".into(),
                kind: Kind::Slack,
                text: "Answers what you ask in Slack".into(),
                detail: Some("Each reply waits for your OK on a card".into()),
                ends_at: None,
                narrow: Vec::new(),
            }
        });
    }
    let engine = f.agent.engine.label();
    items.push(Item {
        key: "account".into(),
        kind: Kind::Account,
        text: match &f.pinned_account {
            Some(name) => format!("Spends only your {name} account ({engine})"),
            None => format!("Spends your {engine} accounts, in your order"),
        },
        detail: Some(match &f.pinned_account {
            Some(_) => "Waits when it runs out; change it in Edit agent".into(),
            None => "Moves on to the next when one runs out; change it in Edit agent".into(),
        }),
        ends_at: None,
        narrow: Vec::new(),
    });
    let mut always_asks = vec![ALWAYS_ASKS.to_string()];
    if f.exact_text {
        always_asks.push(EXACT_TEXT.to_string());
    }
    OnItsOwn {
        agent_id: f.agent.id.clone(),
        agent_name: f.agent.name.clone(),
        level: f.level,
        own_level: f.own_level,
        level_line: level_line(f.level).into(),
        always_asks,
        items,
    }
}

/* ------------------------------------------------------------- read */

/// Its facts, read from the stores now.
pub fn facts_for(agent: &Agent, now: i64) -> Facts {
    let saved = super::policy::load();
    let own = super::policy::own_independence(&saved, &agent.id);
    let level = own.unwrap_or_else(super::independence::level);
    let effective = super::policy::effective(agent);
    let apps = connections::granted_to(&agent.id)
        .into_iter()
        .map(|(c, access)| AppFact {
            connection_id: c.id,
            title: c.title,
            account: c.account,
            access,
            needs_sign_in: c.needs_sign_in,
        })
        .collect();
    let off = agent.reach.browser_off;
    let browser = BrowserFact {
        claude_in_chrome: super::browser::allowed(super::browser::team_enabled(), agent, false),
        your_chrome: crate::user_chrome::settings::enabled() && effective.browser && !off,
        agents_browser: crate::agent_browser::settings::enabled() && !off,
    };
    let pinned_account = agent.account.as_ref().and_then(|id| {
        super::wallet::of(agent.engine)
            .into_iter()
            .find(|a| &a.id == id)
            .map(|a| super::wallet::line_name(&super::wallet::labelled(a, true).name))
    });
    let slack_settings = super::slack::load();
    let slack = (slack_settings.account.is_some() && slack_settings.enabled)
        .then(|| super::slack::answering_agent(&slack_settings))
        .flatten()
        .filter(|a| a.id == agent.id)
        .map(|_| SlackFact {
            by_itself: level == Level::FullSend && !effective.outward_text_needs_ok,
        });
    let plans = super::plan_grant::held_by(&agent.id, now);
    let names = store::list()
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.id, a.name))
        .collect();
    Facts {
        agent: agent.clone(),
        level,
        own_level: own.is_some(),
        exact_text: effective.outward_text_needs_ok,
        team_rules: super::remember::team_rules(),
        plans,
        names,
        apps,
        browser,
        admin: super::admin::is_admin(agent),
        pinned_account,
        slack,
    }
}

/// One agent's answer, now.
pub fn view(agent: &Agent) -> OnItsOwn {
    build(&facts_for(agent, store::now_ms()))
}

/// The team's answer, now.
pub fn team_view() -> Result<TeamOnItsOwn, CommandError> {
    let level = super::independence::level();
    let team_rules: Vec<Item> = super::remember::team_rules()
        .iter()
        .map(|r| rule_item(r, true))
        .collect();
    let agents = store::list()?
        .iter()
        .map(|a| {
            let v = view(a);
            TeamRow {
                agent_id: v.agent_id,
                name: v.agent_name,
                level: v.level,
                own_level: v.own_level,
                standing: v
                    .items
                    .iter()
                    .filter(|i| !matches!(i.kind, Kind::Account | Kind::TeamRule))
                    .count(),
            }
        })
        .collect();
    Ok(TeamOnItsOwn {
        level,
        level_line: level_line(level).into(),
        always_asks: vec![ALWAYS_ASKS.to_string()],
        team_rules,
        agents,
    })
}

/* ------------------------------------------------------------- narrow */

/// The line left in the agent's chat once `narrow` took `item` away.
pub fn line_for(item: &Item, narrow: &Narrow) -> String {
    match narrow {
        Narrow::AppReadOnly { .. } => format!(
            "{}: read only now. Anything else is refused; it asks for more on a card.",
            item.text
        ),
        Narrow::ExactText => "Slack replies, and everything else it sends under your name, now wait for your OK on the exact words.".into(),
        Narrow::Admin => "Admin turned off: it no longer manages or answers for other agents".into(),
        Narrow::Plan { .. } => format!("Plan taken back: {}. Those steps ask again.", item.text),
        _ if item.kind == Kind::TeamRule => {
            format!("Taken back for every agent: {}. It asks again.", item.text)
        }
        _ => format!("Taken back: {}. It asks again.", item.text),
    }
}

/// The item in `view` that offers `narrow`, if it does.
pub fn offered<'a>(view: &'a OnItsOwn, narrow: &Narrow) -> Option<&'a Item> {
    view.items.iter().find(|i| i.narrow.contains(narrow))
}

/// Apply `narrow` to `agent_id`, only when its current view offers it.
/// Returns the line for its chat.
pub fn narrow(agent_id: &str, narrow: &Narrow) -> Result<String, CommandError> {
    let agent = store::get(agent_id)?;
    let now = view(&agent);
    let item = offered(&now, narrow)
        .ok_or_else(|| CommandError::expected("That's already gone, or it isn't this agent's."))?
        .clone();
    match narrow {
        Narrow::Rule { rule_id } => {
            super::remember::forget(agent_id, rule_id)?;
        }
        Narrow::Plan { grant_id } => {
            super::plan_grant::revoke(grant_id);
        }
        Narrow::App { connection_id } => connections::revoke(connection_id, agent_id)?,
        Narrow::AppReadOnly { connection_id } => connections::set_access(
            connection_id,
            agent_id,
            Some(Access::Full),
            Some(Access::Read),
        )?,
        Narrow::Browser => {
            super::logins::remove(agent_id, &super::logins::Removal::Browser)?;
        }
        Narrow::Admin => {
            super::admin::set_admin(agent_id, false)?;
        }
        Narrow::ExactText => super::policy::set(
            &super::policy::Target::Agent {
                agent_id: agent_id.to_string(),
            },
            &super::policy::Change {
                outward_text_needs_ok: Some(true),
                ..Default::default()
            },
            &[agent],
        )?,
    }
    Ok(line_for(&item, narrow))
}

/* ------------------------------------------------------------- the tool */

pub const TOOL: &str = "what_it_does_on_its_own";

pub const DESCRIPTION: &str = "What an agent may do without asking the user, from the app's own records: its level, what always asks, Always allow rules, rules remembered from chat, plans the user said yes to (with time left), app grants, browsers, admin powers, the accounts it spends and Slack. Use it to answer \"what can X do on its own?\" exactly; never guess. Changing any of it is the user's (narrowing in that view, widening on a card).";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "agent": { "type": "string", "description": "The agent's name or id; \"team\" for the whole team. Omit for yourself." }
        }
    })
}

fn minutes_left(ends_at: i64, now: i64) -> String {
    let m = ((ends_at - now).max(0) + 59_999) / 60_000;
    if m <= 1 {
        "about a minute left".into()
    } else {
        format!("about {m} minutes left")
    }
}

/// The answer in words, for an agent to read.
pub fn describe(v: &OnItsOwn, now: i64) -> String {
    let whose = if v.own_level { "its own" } else { "the team's" };
    let mut out = format!(
        "{} is on {} ({whose} level): {}\n{}",
        v.agent_name,
        v.level.label(),
        v.level_line,
        v.always_asks.join(" ")
    );
    if v.items.is_empty() {
        return out;
    }
    out.push_str("\nStanding, beyond its level:");
    for i in &v.items {
        out.push_str(&format!("\n- {}", i.text));
        if let Some(d) = &i.detail {
            out.push_str(&format!(" ({d})"));
        }
        if let Some(at) = i.ends_at {
            out.push_str(&format!(", {}", minutes_left(at, now)));
        }
    }
    out
}

fn describe_team(t: &TeamOnItsOwn) -> String {
    let mut out = format!(
        "The team is on {}: {}\n{}",
        t.level.label(),
        t.level_line,
        t.always_asks.join(" ")
    );
    if !t.team_rules.is_empty() {
        out.push_str("\nRules for every agent:");
        for r in &t.team_rules {
            out.push_str(&format!("\n- {}", r.text));
        }
    }
    for a in &t.agents {
        out.push_str(&format!(
            "\n- {}: {}{}, {} standing",
            a.name,
            a.level.label(),
            if a.own_level { " (its own)" } else { "" },
            a.standing
        ));
    }
    out
}

/// The tool, for `caller`: itself always; anyone and the team for the Chief
/// and admins.
pub fn call(caller: &Agent, args: &Value) -> Result<String, String> {
    let asked = args
        .get("agent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let manages = caller.is_main || super::admin::is_admin(caller);
    let now = store::now_ms();
    match asked {
        None => Ok(describe(&view(caller), now)),
        Some(a) if a.eq_ignore_ascii_case("team") => {
            if !manages {
                return Err("Only the Chief of Staff and admins can read the whole team's.".into());
            }
            team_view()
                .map(|t| describe_team(&t))
                .map_err(|e| e.to_string())
        }
        Some(a) => {
            let agents = store::list().map_err(|e| e.to_string())?;
            let found = agents
                .iter()
                .find(|x| x.id == a || x.name.eq_ignore_ascii_case(a))
                .ok_or_else(|| format!("No agent called {a}."))?;
            if found.id != caller.id && !manages {
                return Err(
                    "You can read only your own. Ask the Chief of Staff for a teammate's.".into(),
                );
            }
            Ok(describe(&view(found), now))
        }
    }
}

#[cfg(test)]
#[path = "on_its_own_tests.rs"]
mod tests;
