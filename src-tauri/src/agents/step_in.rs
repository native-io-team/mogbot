//! "Step in": an agent in its own browser hits a wall only a person can pass
//! (an SSO or "verify it's you" page, a passkey, a 2FA code, a CAPTCHA) and
//! calls `ask_user_to_step_in` instead of failing or asking for a password.
//!
//! 1. **One card**, "<Agent> needs you in its browser: <reason>", with
//!    **Step in** and **Not now** ([`ask`]). It returns at once: the agent
//!    stops, and is woken when the user hands back or says not now.
//! 2. **Step in** (desk only, [`step_in`]) brings that tab's real Chrome
//!    window on screen and holds the tab (`agent_browser::step_in`): no tool
//!    of the agent's reads or acts on it meanwhile, and no live picture of it
//!    is taken. The chat shows "You're in <Agent>'s browser · Hand back".
//! 3. **Hand back** ([`hand_back`]) parks the window, answers the card, leaves
//!    a line, and wakes the agent with where the page ended up (address and
//!    title only, `agent_browser::step_in::resume_note`). Closing the tab, or
//!    [`LIMIT_MS`] with no hand-back, ends it the same way, with a line.
//! 4. **The phone** steps in too ([`begin_from_phone`]): the same hold, the
//!    window left parked, and the tab shown and driven on the phone through
//!    the sign-in screen's frames and taps (`agents::phone_signin`, its
//!    `Op::StepIn`). Hand back from either device ends both.
//!
//! Never for a turn answering outside text: the browser server isn't given
//! to those turns, and [`ask`] refuses one anyway.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::runner;
use super::store::{self, AgentMessage, ApprovalStatus, MessageKind};
use crate::agent_browser::step_in::{self as hold, How};
use crate::errors::CommandError;

pub use crate::agent_browser::step_in::LIMIT_MS;

/// What a step-in card carries. Never anything typed: the reason, and the
/// page the agent was on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepIn {
    /// The agent's words: what the user needs to do there.
    pub reason: String,
    /// The page's host ("accounts.example.com"), for the card.
    pub site: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub page_title: String,
    /// The agent's tab ("tab 2").
    pub tab: u32,
    /// Live, laid over on read ([`apply`]), never stored: the user is in the
    /// tab now, since this moment (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_since: Option<i64>,
    /// Live: when it is handed back by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    /// Live: the user is in it from this phone (its name), not at the desk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_phone: Option<String>,
}

/// A turn answering outside text.
pub const OUTSIDE: &str = "You can't ask the user to step in while you answer text from outside (a routine's items, or a message that carried them). Do this from the user's own request.";
/// The phone, or an older client's plain Allow.
pub const ON_YOUR_MAC: &str = "Step in on your Mac: press Step in on the card there.";
/// What a card's receipt says when it was handed back for the user: 15
/// minutes at the desk, or a phone left idle.
pub fn timed_out_aside(minutes: i64) -> String {
    format!("Handed back by itself after {minutes} min")
}

const MAX_REASON: usize = 120;

/// The reason, as the card shows it: one line, short, required.
pub fn reason_of(args: &Value) -> Result<String, String> {
    let raw = args.get("reason").and_then(Value::as_str).unwrap_or("");
    let one = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let one = one.trim_end_matches(['.', ' ']).to_string();
    if one.is_empty() {
        return Err("Say what they need to do there, in a few words (`reason`).".into());
    }
    Ok(if one.chars().count() > MAX_REASON {
        one.chars().take(MAX_REASON).collect::<String>() + "…"
    } else {
        one
    })
}

/// Whether this turn may ask at all, and the reason it gives. Never for a
/// turn answering outside text.
pub fn check_ask(args: &Value, outside: bool) -> Result<String, String> {
    if outside {
        return Err(OUTSIDE.into());
    }
    reason_of(args)
}

/// "Finance needs you in its browser: approve the Okta sign-in".
pub fn card_title(agent_name: &str, reason: &str) -> String {
    format!("{agent_name} needs you in its browser: {reason}")
}

/// The line hand-back leaves in the chat.
pub fn line(agent_name: &str, e: &hold::Ended) -> String {
    let site = e
        .after
        .as_ref()
        .and_then(|a| super::browser_gate::host_of(&a.url))
        .map(|h| format!(" · {}", h.trim_start_matches("www.")))
        .unwrap_or_default();
    let took = match e.minutes {
        1 => "a minute".to_string(),
        n => format!("{n} min"),
    };
    match e.how {
        How::HandedBack => format!("You handed {agent_name} its browser back after {took}{site}"),
        How::TimedOut => {
            format!("{agent_name}'s browser was handed back by itself after {took}{site}")
        }
        How::Closed => format!("The tab closed while you were in {agent_name}'s browser"),
    }
}

/// What the agent is told after Not now.
pub fn not_now_note(reason: &str) -> String {
    format!(
        "[The user said not now to stepping into your browser for \"{reason}\". Don't ask again for this; carry on with what doesn't need it, or say in one line what you can't do without it.]"
    )
}

/// How long a Not now keeps the same site from being asked about again.
pub const NOT_NOW_QUIET_MS: i64 = 60 * 60 * 1000;

/// Not now, by agent: the site and when.
static NOT_NOW: std::sync::Mutex<Option<std::collections::HashMap<String, (String, i64)>>> =
    std::sync::Mutex::new(None);

/// The user said Not now to `agent` stepping in on `site`.
pub fn note_not_now(agent: &str, site: &str, now: i64) {
    let mut g = NOT_NOW.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(Default::default)
        .insert(agent.to_string(), (site.to_string(), now));
}

/// Whether `agent` may ask about `site` again: not within
/// [`NOT_NOW_QUIET_MS`] of a Not now for it, so neither the agent nor a
/// page steering it can put up card after card.
pub fn ask_again(agent: &str, site: &str, now: i64) -> Result<(), String> {
    let g = NOT_NOW.lock().unwrap_or_else(|e| e.into_inner());
    let recent = g
        .as_ref()
        .and_then(|m| m.get(agent))
        .is_some_and(|(s, at)| s == site && now.saturating_sub(*at) < NOT_NOW_QUIET_MS);
    if recent {
        return Err(format!(
            "The user said not now to stepping in on {site} a moment ago. Don't ask again: carry on with what doesn't need it, or say in one line what you can't do without it."
        ));
    }
    Ok(())
}

/* ---------------------------------------------------------------- ask */

/// `ask_user_to_step_in`: one card in the agent's own chat.
pub async fn ask(
    app: &AppHandle,
    agent: &store::Agent,
    args: &Value,
    outside: bool,
) -> Result<String, String> {
    let reason = check_ask(args, outside)?;
    let open = store::pending_approvals(&agent.id).unwrap_or_default();
    if open.iter().any(|a| a.step_in.is_some()) {
        return Ok("You already asked the user to step in; the card is waiting. Stop here: you're woken when they hand it back.".into());
    }
    let tab_arg = args
        .get("tab")
        .and_then(Value::as_u64)
        .and_then(|t| u32::try_from(t).ok());
    let a = agent.id.clone();
    // The running Chrome only: a tab to step into must be open already.
    let tab = tokio::task::spawn_blocking(move || {
        let svc = crate::agent_browser::service::running()
            .ok_or("Your browser has no page open to step into. Open the page first.")?;
        let t = svc
            .tab_for(&a, tab_arg)
            .map_err(|_| "You have no tab open to step into. Open the page first.".to_string())?;
        Ok::<_, String>(svc.refreshed(&t))
    })
    .await
    .map_err(|_| "The browser didn't answer.".to_string())??;
    let site = super::browser_gate::host_of(&tab.url)
        .map(|h| h.trim_start_matches("www.").to_string())
        .unwrap_or_else(|| "this page".into());
    ask_again(&agent.id, &site, store::now_ms())?;
    let card_data = StepIn {
        reason: reason.clone(),
        site: site.clone(),
        url: tab.url.clone(),
        page_title: tab.title.chars().take(200).collect(),
        tab: tab.id,
        in_since: None,
        until: None,
        on_phone: None,
    };
    let mut approval = super::mcp::new_card(
        store::new_id(),
        card_title(&agent.name, &reason),
        format!(
            "Its tab on {site} opens on this Mac for you to do this yourself; Hand back when you're done. It never sees what you type, only where the page ends up."
        ),
        None,
    );
    approval.step_in = Some(card_data);
    let mut card = runner::new_message(&agent.id, MessageKind::Approval, "");
    card.approval = Some(approval);
    runner::record_own(app, card).map_err(|e| e.to_string())?;
    store::refresh_pending(&agent.id);
    super::notify::refresh_badge(app);
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    Ok(format!(
        "A card asks the user to step into tab {} ({site}) for: {reason}. Stop here and say in one line what you need them for. Don't use that tab meanwhile; you're woken when they hand it back, with where the page ended up.",
        tab.id
    ))
}

/* ------------------------------------------------------------- live */

/// Lay each step-in card's live state over it (the user is in the tab now),
/// for a page being read.
pub fn apply(page: &mut [AgentMessage]) {
    for m in page.iter_mut() {
        let Some(a) = m.approval.as_mut() else {
            continue;
        };
        let pending = a.status == ApprovalStatus::Pending;
        let id = a.request_id.clone();
        if let Some(s) = a.step_in.as_mut() {
            let live = pending.then(|| hold::held_for(&id)).flatten();
            s.in_since = live.as_ref().map(|(_, h)| h.since_ms);
            s.until = live.as_ref().map(|(_, h)| h.since_ms + LIMIT_MS);
            s.on_phone = live
                .is_some()
                .then(|| super::phone_signin::step_in_device(&id))
                .flatten();
        }
    }
}

fn emit_card(app: &AppHandle, agent_id: &str, request_id: &str) {
    if let Some(mut m) = store::card(agent_id, request_id) {
        apply(std::slice::from_mut(&mut m));
        let _ = tauri::Emitter::emit(app, runner::EVENT_MESSAGE, &m);
    }
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
}

/// The open step-in card, held for this answer (`answer_gate`): Step in,
/// Hand back and Not now from the desk, the phone and the watcher never
/// act on it at once.
fn pending_card(
    agent_id: &str,
    request_id: &str,
    said: &str,
) -> Result<(super::answer_gate::Claim, StepIn), CommandError> {
    let claim = super::answer_gate::claim(agent_id, request_id, said)?;
    let card = store::find_approval(agent_id, request_id)?
        .ok_or_else(|| CommandError::expected("That request no longer exists."))?;
    let step_in = card
        .step_in
        .ok_or_else(|| CommandError::expected("That isn't a step-in card."))?;
    Ok((claim, step_in))
}

/* ---------------------------------------------------------- step in */

/// Step in (the desk's button): the tab's window comes forward and is held.
pub async fn step_in(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
) -> Result<(), CommandError> {
    let (_claim, card) = pending_card(agent_id, request_id, "Stepped in")?;
    store::get(agent_id)?;
    let (a, r, url) = (
        agent_id.to_string(),
        request_id.to_string(),
        card.url.clone(),
    );
    let tab = card.tab;
    tokio::task::spawn_blocking(move || hold::begin(&a, &r, tab, &url, store::now_ms()))
        .await
        .map_err(super::err_other)?
        .map_err(CommandError::expected)?;
    tracing::info!(agent = agent_id, "[StepIn] the user stepped in");
    emit_card(app, agent_id, request_id);
    watch(app.clone(), agent_id.to_string(), request_id.to_string());
    Ok(())
}

/// Step in from the phone: the tab is held as at the desk, but its window
/// stays parked; the caller (`phone_signin`) streams it to the phone and
/// calls [`began`] once the session is live. Refused while the user is in
/// it at the desk. Blocks the caller on the browser.
pub async fn begin_from_phone(
    agent_id: &str,
    request_id: &str,
) -> Result<
    (
        StepIn,
        std::sync::Arc<crate::agent_browser::service::Service>,
        crate::agent_browser::service::Tab,
    ),
    CommandError,
> {
    let (_claim, card) = pending_card(agent_id, request_id, "Stepped in from the phone")?;
    store::get(agent_id)?;
    let (a, r, url) = (
        agent_id.to_string(),
        request_id.to_string(),
        card.url.clone(),
    );
    let tab = card.tab;
    let (svc, t, _) = tokio::task::spawn_blocking(move || {
        hold::begin_for_phone(&a, &r, tab, &url, store::now_ms())
    })
    .await
    .map_err(super::err_other)?
    .map_err(CommandError::expected)?;
    tracing::info!(agent = agent_id, "[StepIn] the user stepped in from the phone");
    Ok((card, svc, t))
}

/// The phone's session is live: the card shows it, and the hold is
/// watched (tab closed, time up) as at the desk.
pub fn began(app: &AppHandle, agent_id: &str, request_id: &str) {
    emit_card(app, agent_id, request_id);
    watch(app.clone(), agent_id.to_string(), request_id.to_string());
}

/// The phone's session didn't start after all: let the tab go, untouched,
/// with nothing answered and nobody woken.
pub fn abandon(agent_id: &str, request_id: &str) {
    hold::release(agent_id, request_id);
}

/// Bring the held window forward again.
pub async fn show(agent_id: &str) -> Result<(), CommandError> {
    let a = agent_id.to_string();
    tokio::task::spawn_blocking(move || hold::show_again(&a))
        .await
        .map_err(super::err_other)?
        .map_err(CommandError::expected)
}

/// End it: Hand back (the button, ⌘K), or by itself (the tab closed, the
/// time ran out). The card is answered, a line left, the agent woken.
pub async fn hand_back(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    how: How,
) -> Result<(), CommandError> {
    let (_claim, card) = pending_card(agent_id, request_id, "Handed back")?;
    let agent = store::get(agent_id)?;
    let (a, r) = (agent_id.to_string(), request_id.to_string());
    let ended = tokio::task::spawn_blocking(move || hold::end(&a, &r, how, store::now_ms()))
        .await
        .map_err(super::err_other)?
        .ok_or_else(|| CommandError::expected("You're not in its browser."))?;
    // A phone in it is done too (its own Hand back took its session first).
    super::phone_signin::end_step_in(app, request_id).await;
    finish(app, &agent, request_id, &card, &ended);
    Ok(())
}

fn finish(app: &AppHandle, agent: &store::Agent, request_id: &str, card: &StepIn, e: &hold::Ended) {
    tracing::info!(agent = %agent.id, how = ?e.how, minutes = e.minutes, "[StepIn] handed back");
    let closed = match e.how {
        How::TimedOut => store::set_aside(&agent.id, request_id, &timed_out_aside(e.minutes)),
        _ => store::set_approval_status(&agent.id, request_id, ApprovalStatus::Allowed),
    };
    // Something else closed it first: that answer stands, nobody woken twice.
    if !matches!(closed, Ok(Some(_))) {
        emit_card(app, &agent.id, request_id);
        return;
    }
    store::refresh_pending(&agent.id);
    super::notify::refresh_badge(app);
    let _ = runner::record(
        app,
        runner::new_message(&agent.id, MessageKind::Note, line(&agent.name, e)),
    );
    emit_card(app, &agent.id, request_id);
    runner::enqueue(
        app,
        &agent.id,
        hold::resume_note(&card.reason, e),
        runner::From::App,
    );
}

/// Not now (desk or phone). Ends a step-in under way first.
pub async fn decline(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
) -> Result<(), CommandError> {
    let (_claim, card) = pending_card(agent_id, request_id, "Not now")?;
    let (a, r) = (agent_id.to_string(), request_id.to_string());
    let _ =
        tokio::task::spawn_blocking(move || hold::end(&a, &r, How::HandedBack, store::now_ms()))
            .await;
    super::phone_signin::end_step_in(app, request_id).await;
    // Hand back (or the watcher ending it) answered it meanwhile: that
    // answer stands, and the agent isn't woken twice.
    if store::set_approval_status(agent_id, request_id, ApprovalStatus::Denied)?.is_none() {
        return Err(super::answer_gate::lost(agent_id, request_id));
    }
    note_not_now(agent_id, &card.site, store::now_ms());
    store::refresh_pending(agent_id);
    super::notify::refresh_badge(app);
    emit_card(app, agent_id, request_id);
    runner::enqueue(app, agent_id, not_now_note(&card.reason), runner::From::App);
    Ok(())
}

/// While the user is in the tab: every two seconds, has the tab closed, or
/// the time run out? Either ends it as Hand back would, with its own line.
fn watch(app: AppHandle, agent_id: String, request_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let Some((_, held)) = hold::held_for(&request_id) else {
                return;
            };
            let a = agent_id.clone();
            let alive = tokio::task::spawn_blocking(move || hold::alive(&a))
                .await
                .unwrap_or(false);
            if let Some(how) = hold::ended_by(held.since_ms, store::now_ms(), alive) {
                if let Err(e) = hand_back(&app, &agent_id, &request_id, how).await {
                    tracing::info!(agent = %agent_id, error = %e, "[StepIn] couldn't end it");
                    // The card went (deleted, answered): let the tab go anyway.
                    hold::release(&agent_id, &request_id);
                }
                return;
            }
        }
    });
}

/// Whether a card is a step-in (for routing an answer).
pub fn is_step_in(agent_id: &str, request_id: &str) -> bool {
    store::find_approval(agent_id, request_id)
        .ok()
        .flatten()
        .is_some_and(|c| c.step_in.is_some())
}

#[cfg(test)]
#[path = "step_in_tests.rs"]
mod tests;
