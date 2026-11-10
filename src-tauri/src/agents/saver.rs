//! What "Save my limits" does on its own, and what any mode does when every
//! account an agent runs on is out (persona review 2026-11-09, the Saver and
//! the Adversary).
//!
//! - **Routines are held, not just asked to be careful.** In Save, a routine
//!   that comes due while every account its agent could run on is past
//!   [`HOLD_PERCENT`] of a 5-hour or weekly limit waits for the earliest of
//!   those limits to reset, then runs once (as a routine missed while the
//!   app was closed does). In any mode, one that comes due while every such
//!   account is out until a reset the engine reported waits the same way,
//!   instead of spending a refused try per due routine, unless the agent
//!   would carry on with the other engine (`crossover`). Each hold is said
//!   once, as a line in the agent's chat and a row in the routine's runs
//!   ("Waiting for the refill"). Run now still runs; "When…" routines aren't
//!   held (their checks are sealed calls the watch decides).
//! - **One warning per window.** The first time the account turns run on
//!   next is past [`HOLD_PERCENT`] of a limit, or its pace (an estimate,
//!   `forecast::pace`) says it runs out more than an hour before the reset,
//!   the user gets one notification (desk, and the phone when away from it),
//!   in the Chief's name, and a line in the Chief's chat. Never again for
//!   that window instance (`usage_plan::first_warning`); not in "Use it all
//!   before reset", where spending it is the point.
//!
//! Only readings decide: an account with no reading has room as far as this
//! knows (never held), and a limit with no known reset isn't waited for.

use crate::agents::store::OrLog;
use std::collections::BTreeMap;
use std::sync::Mutex;

use tauri::AppHandle;

use super::compute::family;
use super::engine::Engine;
use super::forecast::{self, Sample};
use super::inventory::window_name;
use super::quota::QuotaWindow;
use super::store::{self, MessageKind};
use super::usage_plan::{self, Mode};
use super::wallet;

const HOUR_MS: i64 = 60 * 60 * 1000;
/// "Nearly out": this much of a limit used.
pub const HOLD_PERCENT: f64 = 90.0;
/// A pace that runs out at least this long before the reset is worth a warning.
pub const PACE_EARLY_MS: i64 = HOUR_MS;
/// Two resets of one window this close are the same instance of it.
const SAME_RESET_MS: i64 = 30 * 60 * 1000;

/// One account an agent's turns could run on, as known without a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Seat {
    pub id: String,
    pub name: String,
    /// `None`: not checked yet (counted as signed in).
    pub signed_in: Option<bool>,
    /// `Account::out`: `Some(Some(t))` out until `t`, `Some(None)` out with no reset known.
    pub out: Option<Option<i64>>,
    /// Its current reading's windows (past resets dropped).
    pub windows: Vec<QuotaWindow>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Why {
    /// Out of usage until a reset the engine reported.
    Out,
    /// Past [`HOLD_PERCENT`] of a limit ("Save my limits").
    Near {
        kind: String,
        window_minutes: Option<i64>,
        used: f64,
    },
}

/// A routine waits until `until`: the first time one of its agent's accounts has room again.
#[derive(Debug, Clone, PartialEq)]
pub struct Hold {
    pub until: i64,
    /// The account back first, as named everywhere.
    pub account: String,
    pub why: Why,
}

/// The plan windows (5-hour, weekly) of a seat that haven't reset yet.
fn plan_windows(seat: &Seat, now: i64) -> impl Iterator<Item = &QuotaWindow> {
    seat.windows
        .iter()
        .filter(move |w| family(w).is_some() && w.resets_at.is_some_and(|r| r > now))
}

fn near(w: &QuotaWindow) -> bool {
    w.limited || w.used_percent.is_some_and(|p| p >= HOLD_PERCENT)
}

/// Until when `seat` has no room by the line in force, and why. `save`: the
/// Saver's line (nearly out); otherwise only out until a known reset.
pub fn blocked(seat: &Seat, save: bool, now: i64) -> Option<(i64, Why)> {
    if let Some(out) = seat.out {
        // Out with no reset known is tried: it may be back.
        return out.filter(|&t| t > now).map(|t| (t, Why::Out));
    }
    if !save {
        return None;
    }
    // Every nearly-out limit has to reset before it has room: the latest.
    let w = plan_windows(seat, now)
        .filter(|w| near(w))
        .max_by_key(|w| w.resets_at)?;
    Some((
        w.resets_at?,
        Why::Near {
            kind: w.kind.clone(),
            window_minutes: w.window_minutes,
            used: w.used_percent.unwrap_or(100.0),
        },
    ))
}

/// Whether a routine of an agent set to `pin` (or any account) waits, and
/// until when: only when every account it could run on is blocked; the
/// first one back decides. A signed-out account isn't one it could run on.
pub fn hold(seats: &[Seat], pin: Option<&str>, save: bool, now: i64) -> Option<Hold> {
    let mine: Vec<&Seat> = match pin {
        Some(p) if seats.iter().any(|s| s.id == p) => seats.iter().filter(|s| s.id == p).collect(),
        _ => seats
            .iter()
            .filter(|s| s.signed_in != Some(false))
            .collect(),
    };
    if mine.is_empty() {
        return None;
    }
    let mut first: Option<Hold> = None;
    for seat in mine {
        let (until, why) = blocked(seat, save, now)?;
        if first.as_ref().is_none_or(|h| until < h.until) {
            first = Some(Hold {
                until,
                account: seat.name.clone(),
                why,
            });
        }
    }
    first
}

/// The key a hold is said once under: the routine and the time it waits for.
pub fn held_key(agent_id: &str, routine: &str, until: i64) -> String {
    format!("{agent_id}:{routine}:{until}")
}

fn what(note: &str) -> String {
    let first = note.lines().next().unwrap_or("").trim();
    let mut out: String = first.chars().take(60).collect();
    if out.chars().count() < note.trim().chars().count() {
        out.push('…');
    }
    out
}

fn left(used: f64) -> String {
    format!("{}%", (100.0 - used).max(0.0).floor())
}

/// "at 10:00 AM" after "until": "until 10:00 AM" ("until tomorrow at 10:00 AM" stays).
fn until_phrase(when: &str) -> &str {
    when.strip_prefix("at ")
        .or_else(|| when.strip_prefix("on "))
        .unwrap_or(when)
}

/// The chat line for a held routine.
pub fn held_line<Tz: chrono::TimeZone>(
    engine: Engine,
    note: &str,
    hold: &Hold,
    tz: &Tz,
    now: i64,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let when = super::failure::clock_phrase(tz, hold.until, now);
    let account = wallet::line_name(&hold.account);
    match &hold.why {
        Why::Out => format!(
            "Holding “{}” until {} is back {when}: {account} has reached its usage limit, so running it now would only be refused. It runs once it’s back.",
            what(note),
            engine.label(),
        ),
        Why::Near {
            kind,
            window_minutes,
            used,
        } => format!(
            "Holding “{}” until {}, when {account}’s {} limit refills: it has {} left, and Save my limits keeps routines for after the refill. Run now still runs it.",
            what(note),
            until_phrase(&when),
            window_name(kind, *window_minutes),
            left(*used),
        ),
    }
}

/// The routine's run row while it waits.
pub fn held_detail<Tz: chrono::TimeZone>(hold: &Hold, tz: &Tz, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let when = super::failure::clock_phrase(tz, hold.until, now);
    match &hold.why {
        Why::Out => format!("Waiting for the usage limit to refill {when}."),
        Why::Near {
            kind,
            window_minutes,
            used,
        } => format!(
            "Waiting for the {} limit to refill {when}: {} left, Save my limits.",
            window_name(kind, *window_minutes),
            left(*used)
        ),
    }
}

/* ------------------------------------------------------------ warnings */

#[derive(Debug, Clone, PartialEq)]
pub enum Warn {
    /// Past [`HOLD_PERCENT`] (or used up by the engine's word).
    Near { used: f64 },
    /// At the recent pace it runs out before the reset (an estimate).
    Pace { reaches_at: i64, readings: u32 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Warning {
    pub kind: String,
    pub window_minutes: Option<i64>,
    pub resets_at: i64,
    pub warn: Warn,
}

/// What to warn about on the account turns run on next, if anything: its
/// soonest-resetting plan window that is nearly out, or that its pace says
/// runs out at least [`PACE_EARLY_MS`] before its reset.
pub fn warning(seat: &Seat, samples: &[Sample], now: i64) -> Option<Warning> {
    if seat.out.is_some() {
        // Already out: the chat says so where it matters.
        return None;
    }
    let mut windows: Vec<&QuotaWindow> = plan_windows(seat, now).collect();
    windows.sort_by_key(|w| w.resets_at);
    windows.into_iter().find_map(|w| {
        let resets_at = w.resets_at?;
        let warn = if near(w) {
            Warn::Near {
                used: w.used_percent.unwrap_or(100.0),
            }
        } else {
            let p = forecast::pace(samples, w, now)?;
            if p.reaches_at + PACE_EARLY_MS > p.resets_at {
                return None;
            }
            Warn::Pace {
                reaches_at: p.reaches_at,
                readings: p.readings,
            }
        };
        Some(Warning {
            kind: w.kind.clone(),
            window_minutes: w.window_minutes,
            resets_at,
            warn,
        })
    })
}

/// The key a window instance is warned about once under.
pub fn warn_key(engine: Engine, account: &str, kind: &str, resets_at: i64) -> String {
    format!(
        "{}:{kind}:{resets_at}",
        usage_plan::account_key(engine, account)
    )
}

/// Whether an earlier key is the same window instance (a later reading
/// can put its reset a little off).
pub fn same_instance(key: &str, want: &str) -> bool {
    let (Some((a, at)), Some((b, want_at))) = (key.rsplit_once(':'), want.rsplit_once(':')) else {
        return key == want;
    };
    match (at.parse::<i64>(), want_at.parse::<i64>()) {
        (Ok(x), Ok(y)) => a == b && (x - y).abs() <= SAME_RESET_MS,
        _ => key == want,
    }
}

/// The notification's words.
pub fn warn_text<Tz: chrono::TimeZone>(
    engine: Engine,
    account: &str,
    w: &Warning,
    mode: Mode,
    tz: &Tz,
    now: i64,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let limit = window_name(&w.kind, w.window_minutes);
    let reset = super::failure::clock_phrase(tz, w.resets_at, now);
    let who = format!("{} “{}”", engine.label(), wallet::line_name(account));
    let said = match &w.warn {
        Warn::Near { used } => format!(
            "{who} has {} of its {limit} limit left; it refills {reset}.",
            left(*used)
        ),
        Warn::Pace {
            reaches_at,
            readings,
        } => format!(
            "At the recent pace, {who} runs out of its {limit} limit {}, before it refills {reset} (an estimate from {readings} readings).",
            super::failure::clock_phrase(tz, *reaches_at, now)
                .replacen("at ", "around ", 1)
        ),
    };
    match mode {
        Mode::Save => format!("{said} Save my limits holds routines until it has room."),
        _ => format!("{said} Switch to Save my limits in Usage to hold routines until then."),
    }
}

/* ------------------------------------------------------------- state */

/// What only an async look can say, kept for the minute tick: which
/// accounts are signed in, and whether each engine's agents could carry on
/// with the other one. Refreshed every few minutes ([`refresh`]).
#[derive(Debug, Clone, Default)]
struct Looked {
    signed_in: BTreeMap<String, bool>,
    /// Per engine: the other engine is installed with a signed-in account
    /// that isn't out.
    other_ready: BTreeMap<String, bool>,
}

static LOOKED: Mutex<Option<Looked>> = Mutex::new(None);

fn looked() -> Looked {
    LOOKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
}

/// An engine's accounts as seats, in its order, from what is on disk.
pub fn seats(engine: Engine, now: i64) -> Vec<Seat> {
    let (readings, _) = usage_plan::readings();
    let known = looked();
    // In the order turns try them now (an account being spent first leads).
    let first = wallet::spending_first(engine, now).map(|s| s.id);
    wallet::in_spending_order(wallet::of(engine), first.as_deref(), |a| a.id.as_str())
        .into_iter()
        .map(|a| {
            let key = usage_plan::account_key(engine, &a.id);
            let windows = readings
                .get(&key)
                .map(|q| super::quota::shown(std::slice::from_ref(q), now))
                .and_then(|mut v| v.pop())
                .map(|q| q.windows)
                .unwrap_or_default();
            let signed_in = known.signed_in.get(&key).copied();
            let out = a.out(now);
            let name = wallet::labelled(a.clone(), signed_in.unwrap_or(true)).name;
            Seat {
                id: a.id,
                name,
                signed_in,
                out,
                windows,
            }
        })
        .collect()
}

/// Whether `agent`'s turns would carry on with the other engine rather
/// than wait, were its own out: unknown until looked, then by the
/// crossover choice and whether the other engine is ready.
fn would_cross(agent: &store::Agent) -> bool {
    if agent.account.is_some() {
        // Set to one account: never moved anywhere else.
        return false;
    }
    if super::crossover::mode(agent.engine) == super::crossover::Mode::Wait {
        return false;
    }
    let other = super::crossover::other(agent.engine);
    looked()
        .other_ready
        .get(other.label())
        .copied()
        .unwrap_or(true)
}

/// Seats per engine, read once per tick, only when a routine is due.
#[derive(Default)]
pub struct Holds {
    save: bool,
    seats: std::cell::RefCell<BTreeMap<&'static str, Vec<Seat>>>,
}

impl Holds {
    pub fn new(mode: Mode) -> Holds {
        Holds {
            save: mode == Mode::Save,
            seats: Default::default(),
        }
    }

    /// Whether `check_in` of `agent`, due now, waits for a reset.
    pub fn of(
        &self,
        agent: &store::Agent,
        check_in: &super::schedule::CheckIn,
        now: i64,
    ) -> Option<Hold> {
        if check_in.watch.is_some() || agent.away.is_some() {
            return None;
        }
        let engine = agent.engine;
        let mut cache = self.seats.borrow_mut();
        let seats = cache
            .entry(engine.label())
            .or_insert_with(|| seats(engine, now));
        // The Saver's line is for routines; a one-time note runs unless out.
        let save = self.save && check_in.repeat.is_some();
        let h = hold(seats, agent.account.as_deref(), save, now)?;
        if h.why == Why::Out && would_cross(agent) {
            return None;
        }
        Some(h)
    }
}

/// A routine is held: said once per hold, as a line in its agent's chat and
/// a row in its runs.
pub fn say_held(
    app: &AppHandle,
    agent: &store::Agent,
    check_in: &super::schedule::CheckIn,
    h: &Hold,
    now: i64,
) {
    if !usage_plan::first_hold(held_key(&agent.id, &check_in.id, h.until)) {
        return;
    }
    let tz = chrono::Local;
    let detail = held_detail(h, &tz, now);
    store::update(&agent.id, |a| {
        if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == check_in.id) {
            super::runs::record(
                &mut c.runs,
                super::runs::Run {
                    at: now,
                    outcome: super::runs::Outcome::Held,
                    attempt: 1,
                    detail: Some(detail.clone()),
                    retry_at: Some(h.until),
                    sign_in: Vec::new(),
                    manual: false,
                    step: 0,
                },
            );
        }
    })
    .or_log("a routine run's record");
    let mut line = super::runner::new_message(
        &agent.id,
        MessageKind::Note,
        held_line(agent.engine, &check_in.note, h, &tz, now),
    );
    line.conversation = Some(super::conversations::routine_in(&agent.id, &check_in.id));
    let _ = super::runner::record(app, line);
    tracing::info!(agent = %agent.id, routine = %check_in.id, until = h.until, "routine held for a reset");
}

/// From the minute tick: look again at most every few minutes (sign-ins,
/// the other engine), then warn about the account in use if it's time.
pub fn tick(app: &AppHandle) {
    use std::time::{Duration, Instant};
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|at| at.elapsed() < Duration::from_secs(180)) {
            return;
        }
        *last = Some(Instant::now());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { refresh(&app).await });
}

async fn refresh(app: &AppHandle) {
    let now = store::now_ms();
    let mut seen = Looked::default();
    for engine in Engine::ALL {
        let installed = super::engine::binary(engine).await.is_some();
        let candidates = if installed {
            wallet::candidates(engine).await
        } else {
            Vec::new()
        };
        for c in &candidates {
            seen.signed_in
                .insert(usage_plan::account_key(engine, &c.account.id), c.signed_in);
        }
        seen.other_ready.insert(
            engine.label().to_string(),
            candidates
                .iter()
                .any(|c| c.signed_in && c.account.out(now).is_none()),
        );
    }
    *LOOKED.lock().unwrap_or_else(|e| e.into_inner()) = Some(seen);
    let app = app.clone();
    let _ = tokio::task::spawn_blocking(move || warn_now(&app, now)).await;
}

/// The engine's account turns run on next: the first signed in, not out.
fn next_seat(engine: Engine, now: i64) -> Option<Seat> {
    seats(engine, now)
        .into_iter()
        .find(|s| s.signed_in != Some(false) && s.out.is_none())
}

fn warn_now(app: &AppHandle, now: i64) {
    let mode = usage_plan::mode().0;
    if mode == Mode::UseItAll {
        return;
    }
    let Some(chief) = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main))
    else {
        return;
    };
    let (_, samples) = usage_plan::readings();
    for engine in Engine::ALL {
        let Some(seat) = next_seat(engine, now) else {
            continue;
        };
        let key = usage_plan::account_key(engine, &seat.id);
        let mine = samples.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        let Some(w) = warning(&seat, mine, now) else {
            continue;
        };
        let want = warn_key(engine, &seat.id, &w.kind, w.resets_at);
        if !usage_plan::first_warning(want.clone(), |k| same_instance(k, &want)) {
            continue;
        }
        let text = warn_text(engine, &seat.name, &w, mode, &chrono::Local, now);
        let line = super::runner::new_message(&chief.id, MessageKind::Note, text.clone());
        let _ = super::runner::record(app, line);
        super::notify::alert_user(app, &chief.id, &text);
        // One a look: a second engine's waits for the next.
        return;
    }
}

#[cfg(test)]
#[path = "saver_tests.rs"]
mod tests;
