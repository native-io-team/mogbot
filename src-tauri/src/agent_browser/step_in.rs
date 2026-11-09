//! "Step in": the person takes one of an agent's own tabs for a step only a
//! person can pass (an SSO or "verify it's you" page, a passkey, a 2FA code,
//! a CAPTCHA), then hands it back.
//!
//! - **The real window.** Stepping in brings the tab's own Chrome window on
//!   screen and in front ([`Service::show`]): real keyboard and mouse, the
//!   Mac's own passkey and Touch ID sheets, nothing relayed. Handing back
//!   parks it in its corner again.
//! - **Held.** While the person is in it the tab is held ([`refusal`]):
//!   every call of the agent's browser tools that resolves to that tab is
//!   refused, reading included, so nothing on the page mid-step (a code on
//!   screen) reaches the agent. Its other tabs still work.
//! - **Nothing typed is seen.** Keys go from the keyboard to Chrome; the app
//!   never reads them. The agent is told only where the page ended up (its
//!   address, without query or fragment, [`resume_note`]).
//! - **Ends** by Hand back, by the tab closing, or after [`LIMIT`]
//!   ([`ended_by`]): always with a line in the chat and the agent woken.
//!
//! The card and the wake are `agents::step_in`; this is the hold itself.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::service::{self, Owner, Service, Tab};
use crate::agents::browser::Landed;

/// The longest the person can hold a tab before it's handed back for them.
pub const LIMIT_MS: i64 = 15 * 60 * 1000;

/// Every call on a held tab.
pub const REFUSAL: &str = "The user is in this tab right now: they stepped in for you. Don't use it until they hand it back; you're woken then with where the page ended up. Your other tabs, and `open`, still work.";

/// One held tab.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    /// The card it's for.
    pub request_id: String,
    /// The agent's tab ("tab 2"), and its Chrome target.
    pub tab: u32,
    pub target_id: String,
    /// When the person stepped in (ms since the epoch).
    pub since_ms: i64,
    /// Where the page was then.
    pub before: Landed,
}

/// How it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    /// The person pressed Hand back (or ⌘K).
    HandedBack,
    /// [`LIMIT_MS`] passed with no hand-back.
    TimedOut,
    /// The tab (or the whole browser) closed under it.
    Closed,
}

/// What hand-back reports.
#[derive(Debug, Clone, PartialEq)]
pub struct Ended {
    pub held: Held,
    /// Where the page is now; `None` when the tab is gone.
    pub after: Option<Landed>,
    pub how: How,
    pub minutes: i64,
}

static HELD: Mutex<Option<HashMap<String, Held>>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut HashMap<String, Held>) -> R) -> R {
    let mut g = HELD.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

/* ------------------------------------------------------------ registry */

/// Hold `agent`'s tab for card `held.request_id`. One at a time per agent:
/// a second card can't take another tab while one is held.
pub fn hold(agent: &str, held: Held) -> Result<(), String> {
    with(|m| match m.get(agent) {
        Some(h) if h.request_id != held.request_id => {
            Err("You're already in another of its tabs. Hand that one back first.".into())
        }
        _ => {
            m.insert(agent.to_string(), held);
            Ok(())
        }
    })
}

/// What `agent` has held, if anything.
pub fn held(agent: &str) -> Option<Held> {
    with(|m| m.get(agent).cloned())
}

/// The held tab of card `request_id`, if the person is in it now.
pub fn held_for(request_id: &str) -> Option<(String, Held)> {
    with(|m| {
        m.iter()
            .find(|(_, h)| h.request_id == request_id)
            .map(|(a, h)| (a.clone(), h.clone()))
    })
}

/// Let go of `agent`'s hold if it is card `request_id`'s.
pub fn release(agent: &str, request_id: &str) -> Option<Held> {
    with(|m| {
        if m.get(agent).is_some_and(|h| h.request_id == request_id) {
            m.remove(agent)
        } else {
            None
        }
    })
}

/// The agent is gone: forget whatever it held.
pub fn forget(agent: &str) {
    with(|m| {
        m.remove(agent);
    });
}

/// Anyone is in a tab (the idle reaper keeps Chrome open meanwhile).
pub fn any() -> bool {
    with(|m| !m.is_empty())
}

/// Why `agent`'s call on `tab` is refused, if it is: the person is in it.
pub fn refusal(agent: &str, tab: &Tab) -> Option<&'static str> {
    with(|m| {
        m.get(agent)
            .filter(|h| h.target_id == tab.target_id)
            .map(|_| REFUSAL)
    })
}

/* ---------------------------------------------------------------- pure */

/// Whether a hold has ended by itself at `now_ms`: the tab went away, or
/// [`LIMIT_MS`] passed. Hand back is the person's, never decided here.
pub fn ended_by(since_ms: i64, now_ms: i64, tab_alive: bool) -> Option<How> {
    if !tab_alive {
        return Some(How::Closed);
    }
    (now_ms.saturating_sub(since_ms) >= LIMIT_MS).then_some(How::TimedOut)
}

/// Whole minutes, at least one, for a line.
pub fn minutes(since_ms: i64, now_ms: i64) -> i64 {
    ((now_ms.saturating_sub(since_ms)) / 60_000).max(1)
}

/// Where a page is, for the note: scheme, host and path only. The note is
/// queued as from the user, so nothing the site writes goes in it (its
/// title), and nothing a sign-in or a form leaves in an address (a query's
/// one-time code, a fragment's token, credentials before the host). The
/// agent reads the page itself, through its tools, for the rest.
pub fn address(url: &str) -> String {
    match url::Url::parse(url.trim()) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => {
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!(
                "{}://{}{port}{}",
                u.scheme(),
                u.host_str().unwrap_or_default(),
                clip(u.path(), 200)
            )
        }
        _ => "a page that isn't a web address".to_string(),
    }
}

fn page_words(l: &Landed) -> String {
    address(&l.url)
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        s.chars().take(n).collect::<String>() + "…"
    } else {
        s.to_string()
    }
}

/// What the agent is woken with: where the page was, where it is, and how
/// it ended. Only the address, without its query or fragment ([`address`]):
/// never anything typed, nor the page's own words.
pub fn resume_note(reason: &str, e: &Ended) -> String {
    let tab = e.held.tab;
    let took = match e.minutes {
        1 => "a minute".to_string(),
        n => format!("{n} min"),
    };
    let reason = clip(reason.trim(), 160);
    let head = match e.how {
        How::HandedBack => format!(
            "[The user stepped into your browser (tab {tab}) for \"{reason}\" and handed it back after {took}."
        ),
        How::TimedOut => format!(
            "[The user stepped into your browser (tab {tab}) for \"{reason}\" but didn't hand it back, so the app did after {took}. They may not have finished."
        ),
        How::Closed => format!(
            "[The user stepped into your browser (tab {tab}) for \"{reason}\", and the tab closed while they were in it."
        ),
    };
    let place = match &e.after {
        None => " That tab is gone: open the page again if you still need it.".to_string(),
        Some(a) if address(&a.url) == address(&e.held.before.url) => format!(
            " The page is where it was: {}. Read it to see what changed.",
            page_words(a)
        ),
        Some(a) => format!(
            " Before: {}. Now: {}.",
            page_words(&e.held.before),
            page_words(a)
        ),
    };
    let tail = match e.how {
        How::TimedOut => " Read the page; if the same wall is still there, say so in one line rather than asking again.]",
        _ => " Nothing they typed is shown to you. Read the page and carry on.]",
    };
    format!("{head}{place}{tail}")
}

/* ------------------------------------------------------------- windows */

/// Step in: find `agent`'s tab `tab` (or, if Chrome closed it meanwhile,
/// open `url` again as a new tab of the agent's), hold it, bring its window
/// on screen. Returns the tab and where it is. Blocks.
pub fn begin(
    agent: &str,
    request_id: &str,
    tab: u32,
    url: &str,
    now_ms: i64,
) -> Result<(Tab, Landed), String> {
    let svc = service::ensure()?;
    begin_on(&svc, agent, request_id, tab, url, now_ms)
}

/// [`begin`] against a given Chrome (tests use a fake one).
pub fn begin_on(
    svc: &Arc<Service>,
    agent: &str,
    request_id: &str,
    tab: u32,
    url: &str,
    now_ms: i64,
) -> Result<(Tab, Landed), String> {
    // Held already for this card (a second click): show it again.
    if let Some(h) = held(agent).filter(|h| h.request_id == request_id) {
        let t = svc
            .tabs_of(&Owner::Agent(agent.to_string()))
            .into_iter()
            .find(|t| t.target_id == h.target_id)
            .ok_or("That tab has closed.")?;
        let _ = svc.show(&t);
        return Ok((t, h.before));
    }
    if held(agent).is_some() {
        return Err("You're already in another of its tabs. Hand that one back first.".into());
    }
    let t = match svc.tab_for(agent, Some(tab)) {
        Ok(t) => svc.refreshed(&t),
        // Chrome was closed while the card waited: the page it was on.
        Err(_) if url.starts_with("http") => svc.open(Owner::Agent(agent.to_string()), url)?,
        Err(_) => return Err("That tab has closed, and there's no page to open again.".into()),
    };
    let before = Landed {
        url: t.url.clone(),
        title: t.title.clone(),
    };
    hold(
        agent,
        Held {
            request_id: request_id.to_string(),
            tab: t.id,
            target_id: t.target_id.clone(),
            since_ms: now_ms,
            before: before.clone(),
        },
    )?;
    if let Err(e) = svc.show(&t) {
        release(agent, request_id);
        return Err(format!("Its window didn't come forward: {e}"));
    }
    svc.touch();
    Ok((t, before))
}

/// Bring the held tab's window forward again (the person went back to the
/// app and wants it).
pub fn show_again(agent: &str) -> Result<(), String> {
    let h = held(agent).ok_or("You're not in its browser.")?;
    let svc = service::running().ok_or("Its browser has closed.")?;
    let t = svc
        .tabs_of(&Owner::Agent(agent.to_string()))
        .into_iter()
        .find(|t| t.target_id == h.target_id)
        .ok_or("That tab has closed.")?;
    svc.show(&t)
}

/// The held tab is still open in a running Chrome.
pub fn alive(agent: &str) -> bool {
    let Some(h) = held(agent) else { return false };
    service::running().is_some_and(|svc| {
        svc.tabs_of(&Owner::Agent(agent.to_string()))
            .iter()
            .any(|t| t.target_id == h.target_id)
    })
}

/// End the hold of card `request_id`: read where the page is, park its
/// window, let go. `None` when nothing was held for it. Blocks.
pub fn end(agent: &str, request_id: &str, how: How, now_ms: i64) -> Option<Ended> {
    let svc = service::running();
    end_on(svc.as_ref(), agent, request_id, how, now_ms)
}

/// [`end`] against a given Chrome (`None`: it has closed).
pub fn end_on(
    svc: Option<&Arc<Service>>,
    agent: &str,
    request_id: &str,
    how: How,
    now_ms: i64,
) -> Option<Ended> {
    let h = held(agent).filter(|h| h.request_id == request_id)?;
    let tab = svc.and_then(|s| {
        s.tabs_of(&Owner::Agent(agent.to_string()))
            .into_iter()
            .find(|t| t.target_id == h.target_id)
    });
    let after = match (svc, &tab) {
        (Some(s), Some(t)) => {
            let now = s.refreshed(t);
            let _ = s.park(&now);
            s.touch();
            Some(Landed {
                url: now.url,
                title: now.title,
            })
        }
        _ => None,
    };
    let how = if after.is_none() { How::Closed } else { how };
    let held = release(agent, request_id)?;
    Some(Ended {
        minutes: minutes(held.since_ms, now_ms),
        held,
        after,
        how,
    })
}

#[cfg(test)]
#[path = "step_in_tests.rs"]
mod tests;
