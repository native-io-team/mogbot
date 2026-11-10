//! A sign-in window in the agents' browser: the person signs in, the
//! agents get the cookies.
//!
//! One window per sign-in, owned by the sign-in ([`Owner::Signin`]): no
//! agent's tools can reach it, and the agent the card is for has its
//! browser refused until it ends ([`refusal_for`]). It runs one of two ways:
//!
//! - **Agents mode** (almost every site): a window of the agents' Chrome.
//!   The phone sees it through the screencast and drives it with CDP input
//!   (`agents::phone_signin`); at the desk it's brought on screen. No Mac
//!   permission, no extension's per-site Allow.
//! - **Plain mode** (a site that refuses a driven browser, [`refusal`]):
//!   the same profile in an ordinary Chrome window with nothing attached
//!   ([`plain`]). The phone sees it through macOS window capture, which
//!   needs Screen Recording and Accessibility.
//!
//! What's typed is never kept, logged or shown to an agent: it goes from
//! the phone's request straight into an input event.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::keys::Key;
use super::plain::Plain;
use super::refusal::{self, Refused};
use super::service::{self, Frame, FrameSlot, Owner, Service, Tab};

/// How the window is shown and driven.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// A window of the agents' Chrome (CDP).
    AgentsBrowser,
    /// The profile in a plain Chrome window (macOS capture and input).
    MacWindow,
}

/// One picture for the phone.
#[derive(Debug, Clone)]
pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub seq: u64,
    /// Where it is (agents mode only: a plain window's address isn't read).
    pub url: Option<String>,
    /// The focused field takes a password or a code.
    pub secret: bool,
    /// The page refuses this window.
    pub refused: Option<Refused>,
}

enum State {
    Agents {
        svc: Arc<Service>,
        tab: Tab,
        slot: Arc<FrameSlot>,
        last: Option<Frame>,
        checked: Option<(String, Instant, Option<Refused>)>,
    },
    Plain {
        plain: Plain,
        seq: u64,
        frame: (u32, u32),
    },
    Closed,
}

pub struct SigninWindow {
    /// The card's request id (what owns the window).
    pub key: String,
    pub agent_id: String,
    /// The agent's own tab, held for a step-in from the phone
    /// (`agent_browser::step_in`), not a window of the sign-in's: ending it
    /// stops the pictures and leaves the tab where it is.
    borrowed: bool,
    state: Mutex<State>,
}

/* ------------------------------------------------------------- registry */

static ACTIVE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub(crate) fn note(key: &str, agent: Option<&str>) {
    let mut g = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    match agent {
        Some(a) => {
            m.insert(key.to_string(), a.to_string());
        }
        None => {
            m.remove(key);
        }
    }
}

/// Why `agent_id`'s browser call waits, if it does: the profile is open in
/// a plain window (everyone waits), or the user is signing in for it.
pub fn refusal_for(agent_id: &str) -> Option<String> {
    if service::PLAIN_HOLD.load(std::sync::atomic::Ordering::Relaxed) {
        return Some(super::BUSY_PLAIN.into());
    }
    let g = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref()
        .is_some_and(|m| m.values().any(|a| a == agent_id))
        .then(|| crate::agents::browser_gate::AGENTS_SIGNIN_REFUSAL.to_string())
}

/// A sign-in window is open for this card.
pub fn open_for(request_id: &str) -> bool {
    ACTIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|m| m.contains_key(request_id))
}

/* --------------------------------------------------------------- window */

impl SigninWindow {
    /// A window for card `key` at `url`. `on_screen`: for the person at
    /// the Mac; otherwise it's parked and watched (the phone).
    pub fn open(
        key: &str,
        agent_id: &str,
        url: &str,
        on_screen: bool,
    ) -> Result<Arc<SigninWindow>, String> {
        let svc = service::ensure()?;
        let owner = Owner::Signin(key.to_string());
        // A window left from an earlier try on this card goes first.
        svc.close_all_of(&owner);
        let tab = svc.open(owner, url)?;
        let slot = if on_screen {
            let _ = svc.show(&tab);
            Arc::new(FrameSlot::default())
        } else {
            svc.watch(&tab)?
        };
        note(key, Some(agent_id));
        Ok(Arc::new(SigninWindow {
            key: key.to_string(),
            agent_id: agent_id.to_string(),
            borrowed: false,
            state: Mutex::new(State::Agents {
                svc,
                tab,
                slot,
                last: None,
                checked: None,
            }),
        }))
    }

    /// The phone steps into `agent_id`'s own tab `tab`, already held for
    /// card `key` (`step_in::begin_for_phone`): pictures from its
    /// screencast, input as CDP events, its window left parked. The agent
    /// isn't kept out of its other tabs (only the held one is refused).
    pub fn borrow(
        key: &str,
        agent_id: &str,
        svc: Arc<Service>,
        tab: Tab,
    ) -> Result<Arc<SigninWindow>, String> {
        let slot = svc.watch(&tab)?;
        Ok(Arc::new(SigninWindow {
            key: key.to_string(),
            agent_id: agent_id.to_string(),
            borrowed: true,
            state: Mutex::new(State::Agents {
                svc,
                tab,
                slot,
                last: None,
                checked: None,
            }),
        }))
    }

    /// The agent's own tab, held for a step-in.
    pub fn borrowed(&self) -> bool {
        self.borrowed
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn via(&self) -> Via {
        match &*self.state() {
            State::Plain { .. } => Via::MacWindow,
            _ => Via::AgentsBrowser,
        }
    }

    /// The newest picture after `after`, waiting up to `wait` for one.
    pub fn frame(&self, after: u64, wait: Duration) -> Result<Shot, String> {
        // Agents mode waits on the slot without holding the lock.
        let agents = match &*self.state() {
            State::Agents { slot, svc, tab, .. } => Some((slot.clone(), svc.clone(), tab.clone())),
            State::Plain { .. } => None,
            State::Closed => return Err("That sign-in has ended.".into()),
        };
        let Some((slot, svc, tab)) = agents else {
            return self.plain_frame();
        };
        let f = slot
            .next(after, wait)
            .or_else(|| slot.last().filter(|f| f.seq > 0))
            .ok_or("The page hasn't drawn yet.")?;
        let now = svc.refreshed(&tab);
        let secret = svc.focused_is_secret(&now);
        let mut st = self.state();
        let State::Agents { last, checked, .. } = &mut *st else {
            return Err("That sign-in has ended.".into());
        };
        *last = Some(f.clone());
        // Whether the page refuses this window, read again only when it
        // moved, or every couple of seconds.
        let stale = checked
            .as_ref()
            .is_none_or(|(u, at, _)| u != &now.url || at.elapsed() > Duration::from_secs(2));
        if stale {
            let r = if now.url.contains("google.com") {
                refusal::refuses(&now.url, &now.title, &svc.text(&now, 3000))
            } else {
                refusal::refuses(&now.url, &now.title, "")
            };
            *checked = Some((now.url.clone(), Instant::now(), r));
        }
        let refused = checked.as_ref().and_then(|(_, _, r)| *r);
        Ok(Shot {
            jpeg: (*f.jpeg).clone(),
            width: f.width,
            height: f.height,
            seq: f.seq,
            url: Some(now.url),
            secret,
            refused,
        })
    }

    fn plain_frame(&self) -> Result<Shot, String> {
        let mut st = self.state();
        let State::Plain { plain, seq, frame } = &mut *st else {
            return Err("That sign-in has ended.".into());
        };
        if plain.exited() {
            return Err("The sign-in window was closed on the Mac.".into());
        }
        let (jpeg, w, h) = plain.frame(service::FRAME_MAX_WIDTH)?;
        *seq += 1;
        *frame = (w, h);
        Ok(Shot {
            jpeg,
            width: w,
            height: h,
            seq: *seq,
            url: None,
            secret: false,
            refused: None,
        })
    }

    /// Where the window is now (agents mode).
    pub fn location(&self) -> Option<crate::agents::browser::Landed> {
        match &*self.state() {
            State::Agents { svc, tab, .. } => {
                let t = svc.refreshed(tab);
                Some(crate::agents::browser::Landed {
                    url: t.url,
                    title: t.title,
                })
            }
            _ => None,
        }
    }

    /// The page now refuses this window (read fresh).
    pub fn refused_now(&self) -> Option<Refused> {
        match &*self.state() {
            State::Agents { svc, tab, .. } => {
                let t = svc.refreshed(tab);
                refusal::refuses(&t.url, &t.title, &svc.text(&t, 3000))
            }
            _ => None,
        }
    }

    pub fn tap(&self, x: f64, y: f64) -> Result<(), String> {
        match &mut *self.state() {
            State::Agents { svc, tab, last, .. } => {
                let f = last
                    .as_ref()
                    .ok_or("Wait for the page to show, then tap it.")?;
                let (cx, cy) = f.to_css(x, y);
                svc.click(tab, cx, cy)
            }
            State::Plain { plain, .. } => plain.tap(x, y),
            State::Closed => Err("That sign-in has ended.".into()),
        }
    }

    /// Typed at the focused field. Never kept: it goes into one input
    /// event and the string is dropped by the caller.
    pub fn type_text(&self, text: &str) -> Result<(), String> {
        match &mut *self.state() {
            State::Agents { svc, tab, .. } => svc.insert_text(tab, text),
            State::Plain { plain, .. } => {
                plain.type_text(text);
                Ok(())
            }
            State::Closed => Err("That sign-in has ended.".into()),
        }
    }

    pub fn key(&self, key: Key) -> Result<(), String> {
        match &mut *self.state() {
            State::Agents { svc, tab, .. } => svc.key(tab, key),
            State::Plain { plain, .. } => {
                plain.key(key);
                Ok(())
            }
            State::Closed => Err("That sign-in has ended.".into()),
        }
    }

    /// `dy`, `dx` in steps (a step is about a line and a half).
    pub fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32) -> Result<(), String> {
        match &mut *self.state() {
            State::Agents { svc, tab, last, .. } => {
                let (cx, cy) = last.as_ref().map(|f| f.to_css(x, y)).unwrap_or((x, y));
                svc.wheel(tab, cx, cy, dx as f64 * 120.0, dy as f64 * 120.0)
            }
            State::Plain { plain, .. } => plain.scroll(x, y, dy * 40),
            State::Closed => Err("That sign-in has ended.".into()),
        }
    }

    pub fn back(&self) -> Result<(), String> {
        match &*self.state() {
            State::Agents { svc, tab, .. } => svc.navigate(tab, "back"),
            _ => Ok(()),
        }
    }

    pub fn reload(&self) -> Result<(), String> {
        match &*self.state() {
            State::Agents { svc, tab, .. } => svc
                .call(tab, "Page.reload", serde_json::json!({}))
                .map(|_| ()),
            _ => Ok(()),
        }
    }

    /// On screen and in front, for the person at the Mac.
    pub fn show(&self) {
        if let State::Agents { svc, tab, .. } = &*self.state() {
            let _ = svc.show(tab);
        }
    }

    /// Switch to plain mode at `url`: the agents' Chrome closes and the
    /// profile opens in an ordinary window. `for_phone`: refused unless the
    /// phone can drive it (both permissions on).
    pub fn go_plain(&self, url: &str, for_phone: bool) -> Result<(), String> {
        if self.borrowed {
            return Err("This is the agent's own tab: there's no other way in from here.".into());
        }
        if for_phone && !super::plain::phone_can_drive() {
            return Err(super::plain::AT_THE_MAC.into());
        }
        let mut st = self.state();
        if let State::Agents { svc, tab, .. } = &*st {
            svc.close_tab(tab);
        }
        *st = State::Closed;
        let plain = Plain::open(url)?;
        *st = State::Plain {
            plain,
            seq: 0,
            frame: (0, 0),
        };
        Ok(())
    }

    /// The plain window's Chrome quit (the person pressed ⌘Q at the Mac).
    pub fn plain_exited(&self) -> bool {
        match &mut *self.state() {
            State::Plain { plain, .. } => plain.exited(),
            _ => false,
        }
    }

    /// The window closed under it (agents mode).
    pub fn gone(&self) -> bool {
        match &*self.state() {
            State::Agents { svc, tab, .. } if self.borrowed => {
                svc.dead()
                    || !svc
                        .tabs_of(&Owner::Agent(self.agent_id.clone()))
                        .iter()
                        .any(|t| t.target_id == tab.target_id)
            }
            State::Agents { svc, .. } => {
                svc.dead() || !svc.has_owner(&Owner::Signin(self.key.clone()))
            }
            State::Plain { .. } => false,
            State::Closed => true,
        }
    }

    /// Signed in? The service's account page in the agents' browser:
    /// where it lands says (`browser::signed_in`). A plain window is
    /// closed first, so its cookies are saved and the agents' Chrome comes
    /// back to read them.
    pub fn check(&self, probe: &str) -> Option<crate::agents::browser::Landed> {
        if self.borrowed {
            return self.location();
        }
        let plain = matches!(&*self.state(), State::Plain { .. });
        if plain {
            let mut st = self.state();
            *st = State::Closed; // drops (quits) the plain window
            drop(st);
            let svc = service::ensure().ok()?;
            let owner = Owner::Signin(self.key.clone());
            let tab = svc.open(owner, probe).ok()?;
            let t = svc.refreshed(&tab);
            let slot = Arc::new(FrameSlot::default());
            *self.state() = State::Agents {
                svc: svc.clone(),
                tab: t.clone(),
                slot,
                last: None,
                checked: None,
            };
            return Some(crate::agents::browser::Landed {
                url: t.url,
                title: t.title,
            });
        }
        let st = self.state();
        let State::Agents { svc, tab, .. } = &*st else {
            return None;
        };
        svc.navigate(tab, probe).ok()?;
        let t = svc.refreshed(tab);
        Some(crate::agents::browser::Landed {
            url: t.url,
            title: t.title,
        })
    }

    /// End it: the window closes (a plain one quits), nothing is kept.
    pub fn close(&self) {
        let mut st = self.state();
        if let State::Agents { svc, tab, .. } = &*st {
            svc.unwatch(tab);
            if !self.borrowed {
                svc.close_tab(tab);
            }
        }
        *st = State::Closed;
        drop(st);
        if !self.borrowed {
            note(&self.key, None);
        }
    }
}

impl Drop for SigninWindow {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_whose_card_it_is_waits_and_others_dont() {
        note("req_test_1", Some("agent_waits"));
        assert!(refusal_for("agent_waits").is_some());
        assert!(refusal_for("agent_free").is_none());
        assert!(open_for("req_test_1"));
        note("req_test_1", None);
        assert!(refusal_for("agent_waits").is_none());
    }
}
