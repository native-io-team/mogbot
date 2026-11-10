//! Quiet hours: when the user doesn't want to hear from the team.
//!
//! Before, an owner's "quiet hours 22:00–07:00" lived only in an agent's
//! memory. A check-in that read it could answer `[nothing new]`, but an
//! hourly sweep still posted at 06:33, and a turn started by another agent's
//! answer never looked. Now it is the app's: one team-wide window
//! (`quiet-hours.json`), set from chat (`set_quiet_hours`), and kept in two
//! places, whatever any agent remembers:
//!
//! - **Scheduled work waits** (`schedule::tick`). Inside the window nothing
//!   scheduled fires (check-ins, follow-ups, interval routines like a sweep),
//!   except a routine whose own time is inside it: the user picked "every day
//!   at 6:00". What waited fires once when the window ends, and its wake says
//!   so (never once per missed run).
//! - **Notifications are held** (`notify::post`). Every banner and phone push
//!   except an approval, whose agent is blocked on the user, waits. When the
//!   window ends, one notification says who posted. The chat still gets its
//!   lines, and they count as unread as ever.
//!
//! The user writing to an agent (desk or phone) means they're up: for the
//! next [`AWAKE_MS`] nothing is held.

use chrono::{TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use super::schedule::{self, CheckIn, Repeat};
use crate::errors::CommandError;

/// After the user writes, how long they count as awake.
pub const AWAKE_MS: i64 = 30 * 60_000;
const DAY_MINUTES: u32 = 24 * 60;
const FILE: &str = "quiet-hours.json";

/// A daily window, in minutes after local midnight. `start > end` wraps
/// past midnight (22:00–07:00).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window: Option<Window>,
    #[serde(default)]
    set_at: i64,
}

impl Window {
    pub fn contains_minute(&self, minute: u32) -> bool {
        if self.start == self.end {
            return false;
        }
        if self.start < self.end {
            (self.start..self.end).contains(&minute)
        } else {
            minute >= self.start || minute < self.end
        }
    }

    fn minute_at<Tz: TimeZone>(tz: &Tz, ms: i64) -> Option<u32> {
        let t = tz.timestamp_millis_opt(ms).single()?;
        Some(t.hour() * 60 + t.minute())
    }

    /// Whether `ms` is inside the window, in `tz`.
    pub fn contains<Tz: TimeZone>(&self, tz: &Tz, ms: i64) -> bool {
        Self::minute_at(tz, ms).is_some_and(|m| self.contains_minute(m))
    }

    /// When the window that holds `ms` ends (the first minute after it, at
    /// most a day on). `None` when `ms` isn't inside it.
    pub fn ends_after<Tz: TimeZone>(&self, tz: &Tz, ms: i64) -> Option<i64> {
        if !self.contains(tz, ms) {
            return None;
        }
        let start = ms - ms.rem_euclid(60_000);
        (1..=DAY_MINUTES as i64)
            .map(|n| start + n * 60_000)
            .find(|&t| !self.contains(tz, t))
    }

    /// "22:00–07:00".
    pub fn label(&self) -> String {
        let hm = |m: u32| format!("{:02}:{:02}", m / 60, m % 60);
        format!("{}–{}", hm(self.start), hm(self.end))
    }

    /// "07:00": when it ends, as a time.
    pub fn end_label(&self) -> String {
        format!("{:02}:{:02}", self.end / 60, self.end % 60)
    }
}

/// Settings and the phone read quiet hours again on this.
pub const EVENT: &str = "agents-quiet-hours-changed";

/// A window from Settings or the phone, checked: whole minutes in a day,
/// and not the same start and end.
pub fn checked(w: Window) -> Result<Window, String> {
    if w.start >= DAY_MINUTES || w.end >= DAY_MINUTES {
        return Err("Quiet hours start and end inside one day (00:00 to 23:59).".into());
    }
    if w.start == w.end {
        return Err("`from` and `to` are the same time: that's no quiet hours at all.".into());
    }
    Ok(w)
}

/// "22:00" and "7am" as a window. Refused when they're the same time.
pub fn parse(from: &str, to: &str) -> Result<Window, String> {
    let read = |raw: &str, field: &str| {
        schedule::clock(&raw.trim().to_ascii_lowercase())
            .map(|(h, m)| h * 60 + m)
            .ok_or_else(|| format!("`{field}` isn't a time: say it like \"22:00\" or \"7am\"."))
    };
    let window = Window {
        start: read(from, "from")?,
        end: read(to, "to")?,
    };
    if window.start == window.end {
        return Err("`from` and `to` are the same time: that's no quiet hours at all.".into());
    }
    Ok(window)
}

/* -------------------------------------------------------------- disk */

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join(FILE))
}

fn load() -> Saved {
    path()
        .ok()
        .and_then(|p| super::survive::read_kept(&p, "Your quiet hours"))
        .unwrap_or_default()
}

/// The team's quiet hours, if the user set any.
pub fn get() -> Option<Window> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load().window
}

/// Set (or, with `None`, turn off) the team's quiet hours.
pub fn set(window: Option<Window>, now: i64) -> Result<(), CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let saved = Saved {
        window,
        set_at: now,
    };
    let json = serde_json::to_vec_pretty(&saved).map_err(super::err_other)?;
    super::store::write_atomic(&path()?, &json)
}

/* ------------------------------------------------------- now, and who */

/// When the user last wrote to an agent (desk or phone), this run.
static LAST_USER: AtomicI64 = AtomicI64::new(0);

/// The user wrote: they're up.
pub fn user_wrote(now: i64) {
    LAST_USER.fetch_max(now, Ordering::Relaxed);
}

/// Whether quiet hours hold things now: inside the window, and the user
/// hasn't written in the last [`AWAKE_MS`]. Pure.
pub fn holds<Tz: TimeZone>(window: Option<&Window>, tz: &Tz, now: i64, last_user: i64) -> bool {
    window.is_some_and(|w| w.contains(tz, now)) && now - last_user >= AWAKE_MS
}

/// [`holds`] for the team's window, here and now.
pub fn holding_now() -> bool {
    holds(
        get().as_ref(),
        &chrono::Local,
        super::store::now_ms(),
        LAST_USER.load(Ordering::Relaxed),
    )
}

/// A check-in that fires inside quiet hours anyway: a routine on days at a
/// clock time that is itself inside the window (the user chose that time).
/// Everything else scheduled waits for the window to end.
pub fn fires_anyway(check_in: &CheckIn, window: &Window) -> bool {
    match &check_in.repeat {
        Some(Repeat::Days { hour, minute, .. }) => window.contains_minute(hour * 60 + minute),
        _ => false,
    }
}

/// Whether `check_in` waits for quiet hours to end: they hold now
/// (`holding`, [`holds`]) and it isn't one that [`fires_anyway`]. Pure.
pub fn waits(check_in: &CheckIn, window: Option<&Window>, holding: bool) -> bool {
    holding && window.is_some_and(|w| !fires_anyway(check_in, w))
}

/* -------------------------------------------------- held notifications */

/// A notification held for the end of quiet hours.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    pub agent_id: String,
    pub title: String,
    pub body: String,
}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());

/// Hold a notification until quiet hours end.
pub fn hold(held: Held) {
    let mut list = HELD.lock().unwrap_or_else(|e| e.into_inner());
    // One per agent: its latest.
    list.retain(|h| h.agent_id != held.agent_id);
    list.push(held);
}

/// The user opened this agent's chat: nothing held for it is news any more.
pub fn seen(agent_id: &str) {
    HELD.lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|h| h.agent_id != agent_id);
}

/// The one notification for what was held: the agent's own when only one
/// posted, else who did ("Finance, Inbox and 2 more posted"). Pure.
pub fn summary(held: &[Held]) -> Option<Held> {
    let last = held.last()?;
    if held.len() == 1 {
        return Some(last.clone());
    }
    let names: Vec<&str> = held.iter().rev().map(|h| h.title.as_str()).collect();
    let body = match names.as_slice() {
        [a, b] => format!("{a} and {b} posted"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more posted", rest.len()),
        _ => String::new(),
    };
    Some(Held {
        agent_id: last.agent_id.clone(),
        title: "While quiet hours were on".into(),
        body,
    })
}

/// Quiet hours are over (or the user is up): what was held, as one
/// notification, once, leaving out the agents `seen_now` says the user is
/// already looking at. `None` while they still hold, or nothing is left.
pub fn take_release(seen_now: impl Fn(&str) -> bool) -> Option<Held> {
    if holding_now() {
        return None;
    }
    let mut held = std::mem::take(&mut *HELD.lock().unwrap_or_else(|e| e.into_inner()));
    held.retain(|h| !seen_now(&h.agent_id));
    summary(&held)
}

/* ------------------------------------------------------------ the tool */

pub const TOOL: &str = "set_quiet_hours";

pub const DESCRIPTION: &str = "Set the team's quiet hours, the app's own: nothing scheduled runs inside them (except a routine the user set for a time inside them), and every notification but an approval waits until they end. Call it as soon as the user says when not to hear from you (\"quiet hours 10pm to 7am\", \"don't message me before 8\"), or when your memory has quiet hours and the app's aren't set. `off: true` turns them off. It applies at once: say in a line what's set.";

pub fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "from": { "type": "string", "description": "When they start, local time: \"22:00\", \"10pm\"." },
            "to": { "type": "string", "description": "When they end: \"07:00\", \"7am\"." },
            "off": { "type": "boolean", "description": "Turn quiet hours off." }
        }
    })
}

/// What a turn is told about quiet hours as they stand.
pub fn describe(window: Option<&Window>) -> String {
    match window {
        Some(w) => format!(
            "Quiet hours are {} (local time), for the whole team.",
            w.label()
        ),
        None => "No quiet hours are set.".into(),
    }
}

/// `set_quiet_hours`. Never in a turn answering outside text (a "When…"
/// routine's items): quiet hours are the user's. Anywhere else it only
/// holds back, never lets more through (approvals always notify), so it
/// applies at once. Pure apart from the write.
pub fn call(args: &serde_json::Value, outside: bool, now: i64) -> Result<String, String> {
    if outside {
        return Err("Not while answering what a \u{201c}When\u{2026}\u{201d} routine found: that text came from outside this app. Tell the user instead.".into());
    }
    let window = wanted(args)?;
    set(window, now).map_err(|e| e.to_string())?;
    Ok(match window {
        Some(w) => format!(
            "Quiet hours set: {} every day, for the whole team. Scheduled work waits until {} and notifications other than approvals are held until then; while the user is writing, nothing is held. Tell the user in one line.",
            w.label(),
            w.end_label()
        ),
        None => "Quiet hours are off. Tell the user in one line.".into(),
    })
}

/// The window `set_quiet_hours`'s arguments ask for: `None` for `off: true`.
pub fn wanted(args: &serde_json::Value) -> Result<Option<Window>, String> {
    let s = |k: &str| {
        args.get(k)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    if args.get("off").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(None);
    }
    Ok(Some(parse(s("from"), s("to"))?))
}

/// Whether going from `now` to `next` holds back less: some minute quiet
/// now isn't quiet after. Setting hours where there were none, or widening
/// them, holds back more. Pure.
pub fn holds_less(now: Option<Window>, next: Option<Window>) -> bool {
    let Some(now) = now else { return false };
    (0..DAY_MINUTES).any(|m| now.contains_minute(m) && !next.is_some_and(|n| n.contains_minute(m)))
}

/// The card's line for a change of quiet hours. Pure.
pub fn change_line(now: Option<Window>, next: Option<Window>) -> String {
    let was = now.map(|w| w.label()).unwrap_or_else(|| "none".into());
    match next {
        Some(w) => format!("Quiet hours {was} → {}", w.label()),
        None => {
            format!("Quiet hours {was} → off: routines run and notifications arrive at any hour")
        }
    }
}

/// A line for a check-in's wake, when the agent remembers quiet hours the
/// app doesn't have: it sets them from what the user said.
pub fn memory_hint(memory: &str, window: Option<&Window>) -> Option<&'static str> {
    let lower = memory.to_lowercase();
    let mentions = [
        "quiet hours",
        "do not disturb",
        "don't message me",
        "no messages before",
        "no messages after",
    ]
    .iter()
    .any(|w| lower.contains(w));
    (window.is_none() && mentions).then_some(
        "\n\n[Your memory mentions quiet hours, but the app has none set, so it can't hold anything for them. Set them with set_quiet_hours from what the user said; until then keep them yourself.]",
    )
}

#[cfg(test)]
#[path = "quiet_tests.rs"]
mod tests;
