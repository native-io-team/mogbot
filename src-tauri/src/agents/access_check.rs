//! "Checking what your team can already reach": after an import, the app
//! (not the user, and not a model) works out which of the logins the new
//! agents mentioned this Mac can already reach, and leaves only the rest.
//!
//! An import used to turn every login another assistant had into a card:
//! a dozen agents, forty cards, "a million years of work". Now:
//!
//! - **Maybe later, not cards.** What an imported agent says it used
//!   ([`Later`]) is kept on the "Setting up your team" checklist, by
//!   service, deduped team-wide. Nothing is asked in any chat.
//! - **The check** ([`run`]), straight after the import and on demand (⌘K,
//!   the checklist's "Check again"), tries for each service, read-only, in
//!   order: one of our own connections already made here; this Mac's own
//!   sign-in (`gh`, `vercel`); once the team's browser is set up, the
//!   user's signed-in Chrome: one page per asked service, opened in a new
//!   tab, looked at, and closed (`browser::probe`); and last, as an extra,
//!   an app in Claude Code (a claude.ai connector or the user's own MCP
//!   server, as `claude mcp list` reports it). No click, no typing, no
//!   form, nothing sent.
//! - **Resolved silently.** A service found is ticked with a one-line
//!   receipt ("Figma: your browser, signed in on www.figma.com"); for the
//!   browser, the agents that asked are given that site. Nothing is granted
//!   that the user hadn't already set up: a connection found is used at the
//!   agent's first task, on a one-tap card then.
//! - **The residue.** The Logins step shows only what nothing reached:
//!   "Your team is ready. 3 things I couldn't reach on this Mac", each with
//!   one sign-in button (a key only when the service has no sign-in at
//!   all) and "Not needed".
//!
//! Only the app starts it: there's no agent tool for it, so text from
//! outside can't. What's kept per service is its name, how it was reached
//! and the account name a connection or CLI reported, nothing more.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use super::logins::{self, Connector};
use super::store;
use crate::errors::CommandError;

/* --------------------------------------------------------- maybe later */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum LaterState {
    /// Nothing has reached it yet.
    Open,
    /// The check found a way in: how, in a line.
    #[serde(rename_all = "camelCase")]
    Reachable { via: String },
    /// The user said it isn't needed.
    NotNeeded,
    /// Turned into a sign-in card (for this agent): the card decides now.
    #[serde(rename_all = "camelCase")]
    Asked {
        agent_id: String,
        request_id: String,
    },
}

/// A login an imported agent mentioned, kept for later instead of a card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Later {
    pub agent_id: String,
    /// The catalogue's id, or `other`.
    pub service: String,
    /// "Figma", or what it was called for one we don't know.
    pub title: String,
    /// What the other assistant called it ("figma_token").
    pub name: String,
    pub purpose: String,
    /// `api_key`, `password`… as the import said it.
    #[serde(default)]
    pub kind: String,
    /// It sends, posts or changes things there.
    #[serde(default)]
    pub writes: bool,
}

/// The key a group of [`Later`]s shares: a service, or an unknown one's title.
pub fn key_of(service: &str, title: &str) -> String {
    if service == "other" {
        format!("other:{}", title.trim().to_ascii_lowercase())
    } else {
        service.to_string()
    }
}

/// What an imported agent's login becomes.
pub fn later_from(agent_id: &str, name: &str, purpose: &str, kind: &str) -> Later {
    let known = logins::match_service(name);
    let title = known.map(|s| s.title.to_string()).unwrap_or_else(|| {
        let t = name.replace(['_', '-'], " ");
        let t = t.trim();
        let mut c = t.chars();
        c.next()
            .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    });
    let p = purpose.to_ascii_lowercase();
    Later {
        agent_id: agent_id.to_string(),
        service: known
            .map(|s| s.id.to_string())
            .unwrap_or_else(|| "other".into()),
        title,
        name: name.to_string(),
        purpose: purpose.to_string(),
        kind: kind.to_string(),
        writes: [
            "send", "post", "reply", "publish", "tweet", "message", "schedule", "write",
        ]
        .iter()
        .any(|w| p.contains(w)),
    }
}

/// One row of the Logins step: a service and every agent that mentioned it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaterGroup {
    pub key: String,
    pub service: String,
    pub title: String,
    pub agents: Vec<String>,
    pub agent_ids: Vec<String>,
    #[serde(flatten)]
    pub state: LaterState,
    /// The one button: "Connect Figma", "Use my browser", "Get your key".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// A key is the only way in (no sign-in exists here for it).
    pub key_only: bool,
}

/// What the user decided per service, kept on the setup.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaterBook {
    #[serde(default)]
    pub items: Vec<Later>,
    /// `key -> state` (absent: open).
    #[serde(default)]
    pub states: std::collections::BTreeMap<String, LaterState>,
}

impl LaterBook {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn add(&mut self, l: Later) {
        let dup = self.items.iter().any(|x| {
            x.agent_id == l.agent_id && key_of(&x.service, &x.title) == key_of(&l.service, &l.title)
        });
        if !dup {
            self.items.push(l);
        }
    }

    pub fn state(&self, key: &str) -> LaterState {
        self.states.get(key).cloned().unwrap_or(LaterState::Open)
    }

    /// The rows, in the order they came in, names resolved by `name_of`.
    pub fn groups(&self, name_of: &dyn Fn(&str) -> Option<String>) -> Vec<LaterGroup> {
        let mut out: Vec<LaterGroup> = Vec::new();
        for l in &self.items {
            let Some(agent) = name_of(&l.agent_id) else {
                continue;
            };
            let key = key_of(&l.service, &l.title);
            match out.iter_mut().find(|g| g.key == key) {
                Some(g) => {
                    if !g.agent_ids.contains(&l.agent_id) {
                        g.agent_ids.push(l.agent_id.clone());
                        g.agents.push(agent);
                    }
                }
                None => {
                    let (action, key_only) = action_for(&l.service, &l.title);
                    out.push(LaterGroup {
                        state: self.state(&key),
                        key,
                        service: l.service.clone(),
                        title: l.title.clone(),
                        agents: vec![agent],
                        agent_ids: vec![l.agent_id.clone()],
                        action,
                        key_only,
                    })
                }
            }
        }
        out
    }
}

/// The residue's one button for a service, and whether a key is all there is.
fn action_for(service: &str, title: &str) -> (Option<String>, bool) {
    match logins::service(service) {
        Some(s) => match s.connector {
            Connector::Oauth(_) | Connector::Gh => (Some(format!("Connect {}", s.title)), false),
            // The browser first; claude.ai's connector is an extra on the card.
            Connector::ClaudeAi(_) if s.site.is_some() => (Some("Use my browser".into()), false),
            Connector::ClaudeAi(_) => (Some(format!("Connect {}", s.title)), false),
            Connector::None if s.site.is_some() => (Some("Use my browser".into()), false),
            Connector::None if s.key.is_some() => (Some("Get your key".into()), true),
            Connector::None => (None, false),
        },
        // Nothing here knows it: a key is the only way in, and it's said so.
        None => (Some(format!("Add a key for {title}")), true),
    }
}

/* ------------------------------------------------------------ the check */

/// What one way in found for one service. Pure input to [`resolve`].
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub key: String,
    /// The receipt's "how": "your browser, signed in on www.figma.com".
    pub via: String,
}

/// Mark every open row a finding reached; the rest stay open. Rows the
/// user decided (Not needed, a card raised) are left as they are.
pub fn resolve(book: &mut LaterBook, found: &[Found]) -> usize {
    let mut n = 0;
    for f in found {
        if book.state(&f.key) == LaterState::Open
            && book
                .items
                .iter()
                .any(|l| key_of(&l.service, &l.title) == f.key)
        {
            book.states
                .insert(f.key.clone(), LaterState::Reachable { via: f.via.clone() });
            n += 1;
        }
    }
    n
}

/// The one line per service once it's reached: "Figma: your browser, …".
pub fn receipt(title: &str, via: &str) -> String {
    format!("{title}: {via}")
}

/// The check's progress, live, on the checklist (desk and phone).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckView {
    pub running: bool,
    /// Services being checked.
    pub total: usize,
    /// Done so far, in order: the title and whether it was reached.
    pub checked: Vec<Checked>,
    /// The browser was part of it (set up and on).
    pub browser: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub title: String,
    pub reached: bool,
}

pub const EVENT: &str = "agents://access-check";

static CHECK: Mutex<Option<CheckView>> = Mutex::new(None);

pub fn current() -> Option<CheckView> {
    CHECK.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_check(app: Option<&AppHandle>, f: impl FnOnce(&mut CheckView)) {
    let view = {
        let mut c = CHECK.lock().unwrap_or_else(|e| e.into_inner());
        let v = c.get_or_insert_with(CheckView::default);
        f(v);
        v.clone()
    };
    if let Some(app) = app {
        let _ = app.emit(EVENT, &view);
        super::team_setup::emit(app);
    }
}

/// The progress line: "Checking 14 services… Figma ✓ GitHub ✓".
pub fn progress_line(v: &CheckView) -> String {
    let marks: Vec<String> = v
        .checked
        .iter()
        .map(|c| format!("{} {}", c.title, if c.reached { "✓" } else { "–" }))
        .collect();
    let head = if v.running {
        format!(
            "Checking {} service{}…",
            v.total,
            if v.total == 1 { "" } else { "s" }
        )
    } else {
        format!(
            "Checked {} service{}.",
            v.total,
            if v.total == 1 { "" } else { "s" }
        )
    };
    if marks.is_empty() {
        head
    } else {
        format!("{head} {}", marks.join(" "))
    }
}

/// Claude Code's apps that are connected, lowercased, once per check.
async fn claude_apps() -> Vec<String> {
    super::apps::list()
        .await
        .map(|a| {
            a.connected
                .into_iter()
                .filter(|a| a.status == "connected")
                .map(|a| a.name.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// An app in Claude Code that is this service: a claude.ai connector by its
/// name there, or the user's own server named for it ("figma").
pub fn app_for(service: &str, apps: &[String]) -> Option<String> {
    let s = logins::service(service)?;
    if let Connector::ClaudeAi(name) = s.connector {
        let want = format!("claude.ai {}", name.to_ascii_lowercase());
        if let Some(a) = apps.iter().find(|a| **a == want) {
            return Some(a.clone());
        }
    }
    apps.iter()
        .find(|a| a.as_str() == s.id || a.replace(['-', '_', ' '], "") == s.id.replace('_', ""))
        .cloned()
}

async fn cli_account(bin: &str, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .env("PATH", crate::utils::get_extended_path());
    let out = crate::external_command::run_with_timeout(cmd, bin, 15)
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.starts_with('>') && !l.contains("Vercel CLI"))?;
    // Only a plain account name, never a sentence or anything token-like.
    (line.len() <= 80 && !line.contains(' ')).then(|| line.to_string())
}

static RUNNING: Mutex<bool> = Mutex::new(false);

/// Run the check now. Returns how many services it reached. One at a time:
/// a second start while one runs is a no-op.
pub async fn run(app: &AppHandle) -> Result<usize, CommandError> {
    {
        let mut r = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if *r {
            return Ok(0);
        }
        *r = true;
    }
    let out = run_inner(app).await;
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = false;
    out
}

async fn run_inner(app: &AppHandle) -> Result<usize, CommandError> {
    let Some(book) = super::team_setup::later_book() else {
        return Ok(0);
    };
    let names = |id: &str| store::get(id).ok().map(|a| a.name);
    let open: Vec<LaterGroup> = book
        .groups(&names)
        .into_iter()
        .filter(|g| g.state == LaterState::Open)
        .collect();
    let browser_on = super::browser::team_enabled();
    set_check(Some(app), |v| {
        *v = CheckView {
            running: true,
            total: open.len(),
            browser: browser_on,
            ..Default::default()
        }
    });
    let apps = if open.iter().any(|g| g.service != "other") {
        claude_apps().await
    } else {
        Vec::new()
    };
    let gh = if open.iter().any(|g| g.service == "github") {
        cli_account("gh", &["api", "user", "--jq", ".login"]).await
    } else {
        None
    };
    let vercel = if open.iter().any(|g| g.service == "vercel") {
        cli_account("vercel", &["whoami"]).await
    } else {
        None
    };
    // The browser: one server for the whole check, only when it's set up.
    let mut chrome = None;
    if browser_on
        && open
            .iter()
            .any(|g| super::browser::probe_url(&g.service).is_some())
    {
        if let Some(claude) = super::engine::binary(super::engine::Engine::Claude).await {
            chrome = super::browser::ChromeMcp::start(&claude).await.ok();
        }
    }
    let mut found = Vec::new();
    for g in &open {
        let mut via: Option<String> = None;
        if g.service != "other" {
            if let Some(c) = super::connections::for_service(&g.service)
                .into_iter()
                .find(|c| {
                    !c.needs_sign_in && !matches!(c.kind, super::connections::Kind::ClaudeAi { .. })
                })
            {
                via = Some(format!("connected already ({})", c.account));
            }
        }
        if via.is_none() && g.service == "github" {
            via = gh
                .as_ref()
                .map(|l| format!("GitHub CLI on this Mac, signed in as {l}"));
        }
        if via.is_none() && g.service == "vercel" {
            via = vercel
                .as_ref()
                .map(|l| format!("Vercel CLI on this Mac, signed in as {l}"));
        }
        if via.is_none() {
            if let (Some(mcp), Some(site)) = (
                chrome.as_mut(),
                logins::service(&g.service).and_then(|s| s.site),
            ) {
                if super::browser::probe(mcp, &g.service, site).await == Some(true) {
                    for id in &g.agent_ids {
                        let _ = super::browser::give_site(id, site);
                    }
                    via = Some(format!("your browser, signed in on {site}"));
                }
            }
        }
        // Last, an extra: an app in Claude Code (a claude.ai connector or
        // the user's own server), after the browser.
        if via.is_none() {
            via = app_for(&g.service, &apps).map(|a| format!("Claude Code's {a} app"));
        }
        let reached = via.is_some();
        if let Some(via) = via {
            found.push(Found {
                key: g.key.clone(),
                via,
            });
        }
        let title = g.title.clone();
        set_check(Some(app), |v| v.checked.push(Checked { title, reached }));
    }
    drop(chrome);
    let n = super::team_setup::resolve_later(&found)?;
    set_check(Some(app), |v| {
        v.running = false;
        v.finished_at = Some(store::now_ms());
    });
    tracing::info!(
        "[Agents] access check: {} of {} services reachable",
        n,
        open.len()
    );
    Ok(n)
}

/* ------------------------------------------------------- the residue */

/// The card a "Connect" raised.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Raised {
    pub agent_id: String,
    pub request_id: String,
}

/// "Connect" on a row nothing reached: one sign-in card (for the first
/// agent that mentioned it; the others join it, `access_chain`), and its
/// best way in started at once, so the sign-in opens now. Returns the card
/// (agent, request id), shown in place: a key's field, or how it's going.
pub async fn connect(
    app: &AppHandle,
    key: &str,
    origin: logins::Origin,
) -> Result<(String, String), CommandError> {
    let book = super::team_setup::later_book()
        .ok_or_else(|| CommandError::expected("The checklist isn't open any more."))?;
    let names = |id: &str| store::get(id).ok().map(|a| a.name);
    let group = book
        .groups(&names)
        .into_iter()
        .find(|g| g.key == key)
        .ok_or_else(|| CommandError::expected("That isn't on the checklist any more."))?;
    let items: Vec<&Later> = book
        .items
        .iter()
        .filter(|l| key_of(&l.service, &l.title) == key)
        .collect();
    let first = group
        .agent_ids
        .first()
        .cloned()
        .ok_or_else(|| CommandError::expected("Nobody needs that any more."))?;
    let agent = store::get(&first)?;
    let writes = items.iter().any(|l| l.writes);
    let ask = logins::Ask {
        service: if group.service == "other" {
            group.title.clone()
        } else {
            group.service.clone()
        },
        account_hint: None,
        scopes: if writes {
            vec!["read".into(), "write".into()]
        } else {
            vec!["read".into()]
        },
        why: items
            .iter()
            .find(|l| l.agent_id == first)
            .map(|l| l.purpose.clone())
            .unwrap_or_default(),
        // Agents still being set up aren't woken by it; they use it from
        // the user's first message.
        quiet: true,
    };
    let request_id = logins::raise_card(app, &agent, &ask)?;
    let access = if writes {
        super::connections::Access::Full
    } else {
        super::connections::Access::Read
    };
    for other in group.agent_ids.iter().skip(1) {
        super::access_chain::add_waiter(&request_id, &first, other, access, true)?;
    }
    super::team_setup::set_later(
        key,
        LaterState::Asked {
            agent_id: first.clone(),
            request_id: request_id.clone(),
        },
    )?;
    super::team_setup::emit(app);
    // Its best way in, now: a sign-in, never a key (that's typed on the card).
    let best = logins::pending_login(&first, &request_id)
        .ok()
        .and_then(|r| {
            r.options
                .iter()
                .find(|o| o.method != logins::Method::Key)
                .map(|o| o.id.clone())
        });
    if let Some(option) = best {
        logins::start(app, &first, &request_id, &option, origin).await?;
    }
    Ok((first, request_id))
}

/// "Not needed" on a row: nobody is asked about it.
pub fn not_needed(app: &AppHandle, key: &str) -> Result<(), CommandError> {
    super::team_setup::set_later(key, LaterState::NotNeeded)?;
    super::team_setup::emit(app);
    Ok(())
}

/// Start the check in the background (after an import).
pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&app).await {
            tracing::warn!("[Agents] access check failed: {e}");
        }
    });
}

#[cfg(test)]
#[path = "access_check_tests.rs"]
mod tests;
