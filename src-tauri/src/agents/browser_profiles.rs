//! Which Chrome profile: a user can have Claude in Chrome in more than one
//! Chrome profile (a personal and a work Google account, say), each signed
//! in to sites as someone else. The agent works out the right one itself.
//!
//! - **Listed by the app.** When the access chain hands an agent the
//!   browser, the app asks Claude in Chrome's own server which browsers are
//!   connected (`list_connected_browsers`: nothing opened, no model turn)
//!   and [`pick`]s where to start: the profile this site was last used in,
//!   the only one, or each in turn.
//! - **Checked by the agent, read-only.** It opens the site, reads which
//!   account the page shows, and if that isn't the account the task needs it
//!   moves to another connected profile (`select_browser` /
//!   `switch_browser`, both looks in `browser::gate`).
//! - **One plain card, never a login ask.** When no other profile is
//!   connected, `ask_bring_browser_to_front` raises one card ("Bring your
//!   work Chrome window to the front so I can use it", Not now / Check
//!   again), shared team-wide like a login card's waiters.
//! - **Remembered by the app.** `remember_browser_account` keeps
//!   site → profile and account in app data (`browser-accounts.json`), not
//!   in the agent's memory; the next time starts there. Shown, and
//!   forgettable, in "What it can reach".
//!
//! Partly verified: on the Mac this was built on, the extension sat in two
//! profiles but only one browser ("Browser 1") was connected at a time, so
//! switching between two connected profiles hasn't been seen working. The
//! answer's shape is read leniently ([`parse_browsers`]). docs/agents.md,
//! "Your browser".

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::AppHandle;

use super::store::{self, Agent, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/* ------------------------------------------------------- the browsers */

/// One browser Claude in Chrome reaches: a Chrome profile with the
/// extension, signed in.
#[derive(Debug, Clone, PartialEq)]
pub struct Connected {
    /// What `select_browser` takes.
    pub id: String,
    /// What it's called ("Browser 1").
    pub name: String,
}

fn text_field(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match v.get(*k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

/// The browsers in `list_connected_browsers`' answer. Verified only as `[]`
/// and with one browser named "Browser 1", so objects, plain names, and an
/// object holding the list are all read.
pub fn parse_browsers(text: &str) -> Vec<Connected> {
    let Ok(v) = serde_json::from_str::<Value>(text.trim()) else {
        return Vec::new();
    };
    let list = v
        .as_array()
        .cloned()
        .or_else(|| {
            v.get("browsers")
                .or_else(|| v.get("connectedBrowsers"))
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_default();
    list.iter()
        .filter_map(|b| match b {
            Value::String(s) if !s.trim().is_empty() => Some(Connected {
                id: s.trim().into(),
                name: s.trim().into(),
            }),
            Value::Object(_) => {
                let id = text_field(b, &["id", "browserId", "deviceId", "clientId"]);
                let name = text_field(b, &["name", "label", "displayName", "browserName"]);
                let id = id.clone().or_else(|| name.clone())?;
                Some(Connected {
                    name: name.unwrap_or_else(|| id.clone()),
                    id,
                })
            }
            _ => None,
        })
        .map(|c| Connected {
            id: clip(&c.id, 120),
            name: clip(&c.name, 80),
        })
        .collect()
}

/// The browsers connected now, as the app sees them. `None`: it couldn't ask.
pub async fn connected() -> Option<Vec<Connected>> {
    let claude = super::engine::binary(super::engine::Engine::Claude).await?;
    let mut mcp = super::browser::ChromeMcp::start(&claude).await.ok()?;
    let text = mcp
        .call("list_connected_browsers", serde_json::json!({}))
        .await
        .ok()?;
    Some(parse_browsers(&text))
}

/* -------------------------------------------------------- remembered */

/// Where a site was last found signed in as the right account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Remembered {
    /// The browser's name as Claude in Chrome reported it.
    pub browser: String,
    /// The account the page showed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// Site (lowercase, without `www.`) -> where it was.
    #[serde(default)]
    pub sites: BTreeMap<String, Remembered>,
}

const FILE: &str = "browser-accounts.json";
static LOCK: Mutex<()> = Mutex::new(());

/// One spelling per site.
pub fn site_key(site: &str) -> String {
    site.trim()
        .trim_start_matches("www.")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn clip(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn load() -> Book {
    store::agents_root()
        .ok()
        .and_then(|r| super::survive::read_kept(&r.join(FILE), "The browser accounts agents use"))
        .unwrap_or_default()
}

fn change(f: impl FnOnce(&mut Book)) -> Result<(), CommandError> {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut b = load();
    f(&mut b);
    let bytes = serde_json::to_vec_pretty(&b).map_err(super::err_other)?;
    store::write_atomic(&store::agents_root()?.join(FILE), &bytes)
}

pub fn remembered(site: &str) -> Option<Remembered> {
    load().sites.get(&site_key(site)).cloned()
}

/// The name a site is remembered under when it was signed in in the
/// agents' own browser rather than one of the user's Chrome profiles.
pub const AGENTS_BROWSER: &str = "Agents";

/// The user signed in to `site` in the agents' browser: the access chain
/// sends agents there first from now on.
pub fn remember_agents_browser(site: &str) {
    let _ = change(|b| {
        b.sites.insert(
            site_key(site),
            Remembered {
                browser: AGENTS_BROWSER.to_string(),
                account: None,
                at: store::now_ms(),
            },
        );
    });
}

/// `site` was last found signed in in the agents' browser.
pub fn in_agents_browser(r: Option<&Remembered>) -> bool {
    r.is_some_and(|r| r.browser == AGENTS_BROWSER)
}

/// `site` was last found signed in in one of the user's own Chrome profiles.
pub fn in_personal_chrome(r: Option<&Remembered>) -> bool {
    r.is_some_and(|r| r.browser != AGENTS_BROWSER)
}

pub fn forget(site: &str) -> Result<(), CommandError> {
    change(|b| {
        b.sites.remove(&site_key(site));
    })
}

/// The site `agent` names, if it's one it was given (an agent can only
/// remember where its own sites are, never add one).
fn own_site(agent: &Agent, site: &str) -> Option<String> {
    let want = site_key(site);
    agent
        .reach
        .browser_sites
        .iter()
        .find(|s| site_key(s) == want)
        .cloned()
}

/* ------------------------------------------------------------ the pick */

/// Where an agent starts looking for the right account.
#[derive(Debug, Clone, PartialEq)]
pub enum Pick {
    /// This one: the profile the site was last used in, or the only one.
    /// `select`: more than one is connected, so select it first.
    Use {
        browser: Connected,
        remembered: Option<Remembered>,
        select: bool,
    },
    /// Several connected and none known for this site (or the known one
    /// isn't among them): open the site in each, in this order.
    TryEach {
        browsers: Vec<Connected>,
        missing: Option<Remembered>,
    },
    /// Nothing left to try: ask the user to bring the right window forward.
    BringToFront { remembered: Option<Remembered> },
}

/// Pure, for tests. `ruled_out`: browsers the agent already looked in and
/// found the wrong account (by id or name).
pub fn pick(
    connected: &[Connected],
    remembered: Option<&Remembered>,
    ruled_out: &[String],
) -> Pick {
    let out = |b: &Connected| {
        ruled_out
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&b.id) || r.eq_ignore_ascii_case(&b.name))
    };
    let left: Vec<Connected> = connected.iter().filter(|b| !out(b)).cloned().collect();
    if let Some(r) = remembered {
        if let Some(b) = left.iter().find(|b| {
            b.name.eq_ignore_ascii_case(&r.browser) || b.id.eq_ignore_ascii_case(&r.browser)
        }) {
            return Pick::Use {
                browser: b.clone(),
                remembered: Some(r.clone()),
                select: connected.len() > 1,
            };
        }
    }
    let missing = remembered.cloned();
    match left.len() {
        0 => Pick::BringToFront {
            remembered: missing,
        },
        1 if missing.is_none() => Pick::Use {
            browser: left[0].clone(),
            remembered: None,
            select: connected.len() > 1,
        },
        _ => Pick::TryEach {
            browsers: left,
            missing,
        },
    }
}

fn as_account(r: &Remembered) -> String {
    r.account
        .as_deref()
        .map(|a| format!(" as {a}"))
        .unwrap_or_default()
}

/// The steps the agent is handed with the browser for `site`. `connected`:
/// `None` when the app couldn't ask.
pub fn guidance(
    site: &str,
    connected: Option<&[Connected]>,
    remembered: Option<&Remembered>,
) -> String {
    let start = match connected {
        None => "First call list_connected_browsers to see which Chrome profiles are connected."
            .to_string(),
        Some(list) => {
            let names = if list.is_empty() {
                "none".to_string()
            } else {
                list.iter()
                    .map(|b| format!("\"{}\"", b.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let how = match pick(list, remembered, &[]) {
                Pick::Use {
                    browser,
                    remembered: Some(r),
                    select,
                } => format!(
                    "Last time {site} was signed in{} in \"{}\": {}.",
                    as_account(&r),
                    browser.name,
                    if select { "select_browser it first" } else { "it's the one connected" }
                ),
                Pick::Use { browser, .. } => format!("Only \"{}\" is connected: start there.", browser.name),
                Pick::TryEach { browsers, missing } => format!(
                    "{}Look in each, in order: {}.",
                    missing
                        .map(|r| format!("Last time {site} was signed in{} in \"{}\", which isn't connected now. ", as_account(&r), r.browser))
                        .unwrap_or_default(),
                    browsers.iter().map(|b| format!("\"{}\"", b.name)).collect::<Vec<_>>().join(", ")
                ),
                Pick::BringToFront { remembered } => format!(
                    "No browser is connected right now. Call ask_bring_browser_to_front for {site}{} and do what it says.",
                    remembered.map(|r| as_account(&r)).unwrap_or_default()
                ),
            };
            format!("Connected Chrome profiles: {names}. {how}")
        }
    };
    format!(
        "Which Chrome profile: the user may have Chrome open in more than one profile, each signed in as someone else. {start} Open {site} and read which account the page shows. If it isn't the account this task needs (or it shows a sign-in), select_browser / switch_browser to another connected profile and look again. If no other profile is connected, call ask_bring_browser_to_front once, with the account you need, and stop: never request_login for this. Once you're in the right account, call remember_browser_account (site, browser, account) so next time starts there."
    )
}

/* ------------------------------------------------------------ the tools */

/// Fields of a "bring it to the front" card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Front {
    pub site: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

fn arg(args: &Value, k: &str) -> Option<String> {
    args.get(k)
        .and_then(Value::as_str)
        .map(|s| clip(s, 80))
        .filter(|s| !s.is_empty())
}

fn usable(agent: &Agent, outside: bool) -> Result<(), String> {
    if !super::browser::claude_in_chrome_for_turn(agent, outside) {
        return Err(if outside {
            "Your browser isn't available while you answer text from outside.".into()
        } else {
            "The user's browser isn't on for you.".into()
        });
    }
    Ok(())
}

/// `remember_browser_account`: the site was found signed in as `account`
/// in `browser`.
pub fn remember(agent: &Agent, args: &Value, outside: bool) -> Result<String, String> {
    usable(agent, outside)?;
    let site = arg(args, "site").ok_or("Which site?")?;
    let site = own_site(agent, &site)
        .ok_or_else(|| format!("{site} isn't one of your sites in the user's browser."))?;
    let browser =
        arg(args, "browser").ok_or("Which browser (its name from list_connected_browsers)?")?;
    let account = arg(args, "account");
    change(|b| {
        b.sites.insert(
            site_key(&site),
            Remembered {
                browser: browser.clone(),
                account: account.clone(),
                at: store::now_ms(),
            },
        );
    })
    .map_err(|e| e.to_string())?;
    Ok(format!(
        "Remembered: {site}{} is in \"{browser}\". Next time starts there.",
        account.map(|a| format!(" as {a}")).unwrap_or_default()
    ))
}

/// One card's title.
pub fn front_title(f: &Front) -> String {
    match &f.account {
        Some(a) => format!("Bring your {a} Chrome window to the front so I can use it"),
        None => format!(
            "Bring the Chrome window you use for {} to the front so I can use it",
            f.site
        ),
    }
}

fn same_front(a: &Front, b: &Front) -> bool {
    site_key(&a.site) == site_key(&b.site)
        && a.account.as_deref().map(str::to_ascii_lowercase)
            == b.account.as_deref().map(str::to_ascii_lowercase)
}

/* ----------------------------------- bringing it forward ourselves */

/// Per agent and site: how many times the app brought Chrome forward, how
/// many windows it had then, and when. Forgotten after a quiet while.
static FRONTED: Mutex<BTreeMap<String, (usize, usize, i64)>> = Mutex::new(BTreeMap::new());
const FRONTED_FOR_MS: i64 = 15 * 60 * 1000;

/// What the app does before a front card, given how many times it already
/// tried (`tried`) and how many windows Chrome had (`windows`): `Some(false)`
/// brings Chrome forward (opening it if it's closed), `Some(true)` also
/// brings its backmost window to the front, so `windows` tries visit each
/// window once; `None` once every window was tried: then the card.
/// Observed: an agent asked the owner to bring Chrome forward, and the
/// owner had to tell it to open Chrome itself, which then worked.
pub fn front_step(tried: usize, windows: usize) -> Option<bool> {
    match tried {
        0 => Some(false),
        n if n < windows => Some(true),
        _ => None,
    }
}

/// Chrome brought forward (and rotated a window, `rotate`): how many
/// windows it has. `None`: it couldn't (not installed, no permission).
#[cfg(all(target_os = "macos", not(test)))]
async fn raise_chrome(rotate: bool) -> Option<usize> {
    let script = format!(
        "tell application \"Google Chrome\"\nactivate\nset n to count of windows\nif {rotate} and n > 1 then set index of window n to 1\nreturn n\nend tell"
    );
    let mut cmd = crate::utils::create_command("osascript");
    cmd.args(["-e", &script]);
    let out = crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "osascript bring Chrome forward",
        8,
    )
    .await
    .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(any(not(target_os = "macos"), test))]
async fn raise_chrome(_rotate: bool) -> Option<usize> {
    None
}

/// Before a front card: bring Chrome forward, one window per call, and
/// tell the agent what is connected now. `None`: nothing left to try.
async fn front_ourselves(agent: &Agent, site: &str, ruled_out: &[String]) -> Option<String> {
    let key = format!("{}\n{}", agent.id, site_key(site));
    let now = store::now_ms();
    let (tried, windows) = {
        let map = FRONTED.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&key) {
            Some(&(t, w, at)) if now - at < FRONTED_FOR_MS => (t, w),
            _ => (0, 0),
        }
    };
    let rotate = front_step(tried, windows)?;
    let windows = raise_chrome(rotate).await?;
    FRONTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, (tried + 1, windows, now));
    // The extension reconnects to the profile now in front.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let which = if rotate {
        format!("another Chrome window (try {} of {windows})", tried + 1)
    } else {
        "Chrome".to_string()
    };
    let again = format!(
        "Open {site}, check the account on the page, and if it's still wrong call ask_bring_browser_to_front again with looked_in."
    );
    Some(match connected().await {
        Some(list) if !list.is_empty() => match pick(&list, None, ruled_out) {
            Pick::Use { browser, .. } => format!(
                "The app brought {which} to the front; \"{}\" is connected now: select_browser it. {again}",
                browser.name
            ),
            Pick::TryEach { browsers, .. } => format!(
                "The app brought {which} to the front; connected now: {}. {again}",
                browsers.iter().map(|b| format!("\"{}\"", b.name)).collect::<Vec<_>>().join(", ")
            ),
            // The same name as before may be another profile now.
            Pick::BringToFront { .. } => format!(
                "The app brought {which} to the front. Call list_connected_browsers and select the one connected. {again}"
            ),
        },
        _ => format!(
            "The app brought {which} to the front. Call list_connected_browsers; if none is connected yet, call ask_bring_browser_to_front again."
        ),
    })
}

/// `ask_bring_browser_to_front`: no other connected profile has the right
/// account. Another connected one now? It's named instead. Otherwise one
/// card, joined by anyone else who needs the same.
pub async fn bring_to_front(
    app: &AppHandle,
    agent: &Agent,
    args: &Value,
    outside: bool,
) -> Result<String, String> {
    usable(agent, outside)?;
    let site = arg(args, "site").ok_or("Which site?")?;
    let site = own_site(agent, &site)
        .ok_or_else(|| format!("{site} isn't one of your sites in the user's browser."))?;
    let front = Front {
        site: site.clone(),
        account: arg(args, "account"),
    };
    let ruled_out: Vec<String> = args
        .get("looked_in")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| clip(s, 120))
                .collect()
        })
        .unwrap_or_default();
    if let Some(list) = connected().await {
        match pick(&list, None, &ruled_out) {
            Pick::BringToFront { .. } => {}
            Pick::Use { browser, .. } => {
                return Ok(format!(
                    "\"{}\" is connected and you haven't looked there: select_browser it and open {site}. Pass looked_in if it's the wrong account too.",
                    browser.name
                ))
            }
            Pick::TryEach { browsers, .. } => {
                return Ok(format!(
                    "Other profiles are connected that you haven't looked in: {}. Try those first.",
                    browsers.iter().map(|b| format!("\"{}\"", b.name)).collect::<Vec<_>>().join(", ")
                ))
            }
        }
    }
    // Bring Chrome forward ourselves before asking the user to.
    if let Some(told) = front_ourselves(agent, &site, &ruled_out).await {
        return Ok(told);
    }
    // One card team-wide: join one that's waiting for the same.
    for other in store::list().unwrap_or_default() {
        for a in store::pending_approvals(&other.id).unwrap_or_default() {
            if a.front.as_ref().is_some_and(|f| same_front(f, &front)) {
                if other.id == agent.id {
                    return Ok("You already asked; the card is waiting. Stop here: you're woken when they answer.".into());
                }
                super::access_chain::add_waiter(
                    &a.request_id,
                    &other.id,
                    &agent.id,
                    super::connections::Access::Read,
                    false,
                )
                .map_err(|e| e.to_string())?;
                return Ok(format!(
                    "The user is already being asked to bring that window forward (for {}). Stop here: you're woken when they answer.",
                    other.name
                ));
            }
        }
    }
    let request_id = store::new_id();
    let mut card = super::runner::new_message(&agent.id, MessageKind::Approval, "");
    card.approval = Some(store::Approval {
        request_id,
        title: front_title(&front),
        detail: format!(
            "{} needs {site}{}. Only the Chrome profile in front reaches your agents; bring that window forward, then Check again.",
            agent.name,
            front.account.as_deref().map(|a| format!(" as {a}")).unwrap_or_default()
        ),
        summary: None,
        status: ApprovalStatus::Pending,
        tool: None,
        input: None,
        always: None,
        always_allowed: false,
        note: None,
        prompt: None,
        choice: None,
        secret: None,
        connector: None,
        login: None,
        set_aside: None,
        expiry: None,
        from_outside: None,
        front: Some(front),
        settings: None,
        plan: None,
        handoff: None,
        gate: None,
        step_in: None,
        crossover: None,
        account_switch: None,
        slack_reply: None,
    });
    super::runner::record_own(app, card).map_err(|e| e.to_string())?;
    store::refresh_pending(&agent.id);
    super::notify::refresh_badge(app);
    Ok("A card is in the chat asking the user to bring that Chrome window to the front. Stop here and say so in one line; you're woken when they answer.".into())
}

/// The user answered a front card: Check again (`allow`) or Not now.
pub async fn answer(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    allow: bool,
) -> Result<(), CommandError> {
    let status = if allow {
        ApprovalStatus::Allowed
    } else {
        ApprovalStatus::Denied
    };
    // One answer per card (`answer_gate`).
    let _claim = super::answer_gate::claim(
        agent_id,
        request_id,
        if allow { "Check again" } else { "Not now" },
    )?;
    let card = store::find_approval(agent_id, request_id)?
        .ok_or_else(|| CommandError::expected("That request no longer exists."))?;
    let front = card
        .front
        .ok_or_else(|| CommandError::expected("That isn't a browser card."))?;
    if store::set_approval_status(agent_id, request_id, status)?.is_none() {
        return Err(super::answer_gate::lost(agent_id, request_id));
    }
    store::refresh_pending(agent_id);
    super::notify::refresh_badge(app);
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    let told = if allow {
        let now = match connected().await {
            Some(list) if !list.is_empty() => format!(
                " Connected now: {}.",
                list.iter()
                    .map(|b| format!("\"{}\"", b.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Some(_) => " The app sees no connected browser yet.".into(),
            None => String::new(),
        };
        format!(
            "[The user brought the Chrome window for {} to the front.{now} Call list_connected_browsers, select the right one, check the account on the page, and carry on.]",
            front.site
        )
    } else {
        format!(
            "[The user said not now to bringing the Chrome window for {} forward. Carry on without it, or say in one line what you can't do.]",
            front.site
        )
    };
    let mut wake = vec![agent_id.to_string()];
    wake.extend(
        super::access_chain::take_waiters(request_id)
            .into_iter()
            .map(|w| w.agent_id),
    );
    for id in wake {
        super::runner::enqueue(app, &id, told.clone(), super::runner::From::App);
    }
    Ok(())
}

/// What "What it can reach" shows for `agent`: each of its sites with a
/// profile remembered.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachAccount {
    pub site: String,
    pub browser: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

pub fn for_reach(agent: &Agent) -> Vec<ReachAccount> {
    let book = load();
    agent
        .reach
        .browser_sites
        .iter()
        .filter_map(|s| {
            book.sites.get(&site_key(s)).map(|r| ReachAccount {
                site: s.clone(),
                browser: r.browser.clone(),
                account: r.account.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "browser_profiles_tests.rs"]
mod tests;
