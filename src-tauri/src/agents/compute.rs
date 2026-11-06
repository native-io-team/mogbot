//! The user's total compute: every account at once, from each one's own
//! reading. What they have, what they don't, and (labelled as an estimate)
//! when an engine runs out on every account at the recent pace.
//!
//! The rules (`inventory.rs`'s, carried over):
//!
//! - **Room is only what a reading said.** An account counts as having room
//!   when it is signed in, isn't out, has a current reading of its 5-hour or
//!   weekly limit, and none of those is used up. One with no reading is
//!   counted as *not read*, never as having room or as being out.
//! - **"Runs out on every account" is an estimate**, from each account's
//!   own pace (`forecast::pace`), and is said only when the evidence covers
//!   every account of the engine: each one read, each with room running out
//!   before its reset at the recent pace (or already out), and no account
//!   back before the last one runs out. Otherwise there is no such line,
//!   never a guess. Only for an engine with two or more accounts: with one,
//!   its own pace line says it.

use serde::Serialize;

use super::engine::Engine;
use super::inventory::AccountLine;
use super::quota::QuotaWindow;

/// The two kinds of plan window the totals are said in.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    /// Claude's `five_hour`, Codex's 300-minute window.
    Session,
    /// Claude's `seven_day` (all models), Codex's 10080-minute window.
    Weekly,
}

pub fn family(w: &QuotaWindow) -> Option<Family> {
    match (w.kind.as_str(), w.window_minutes) {
        ("five_hour", _) | (_, Some(300)) => Some(Family::Session),
        ("seven_day", _) | (_, Some(10080)) => Some(Family::Weekly),
        _ => None,
    }
}

fn full(w: &QuotaWindow) -> bool {
    w.limited || w.used_percent.is_some_and(|p| p >= 100.0)
}

/// An account and a time: a reset, or when it has room again.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountAt {
    pub engine: Engine,
    pub account_id: String,
    pub account_name: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineCount {
    pub engine: Engine,
    pub accounts: u32,
    /// With a current reading.
    pub read: u32,
    /// With room now, by that reading.
    pub room: u32,
}

/// One kind of window across every account that reported it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowRoom {
    pub family: Family,
    /// Accounts with a current reading of this window.
    pub read: u32,
    /// Of those, with this window not used up.
    pub room: u32,
    /// The soonest reset of this window among them, as reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soonest_reset: Option<AccountAt>,
}

/// When an engine runs out on every account at the recent pace. **An
/// estimate**, from each account's own readings.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunOut {
    /// Always true: extrapolated from readings, not a reading.
    pub estimate: bool,
    pub engine: Engine,
    /// When the last of its accounts reaches its limit, epoch ms.
    pub reaches_at: i64,
    /// How many readings, across how many accounts, it rests on.
    pub readings: u32,
    pub accounts: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Every account listed (signed in or not).
    pub accounts: u32,
    pub engines: Vec<EngineCount>,
    /// Accounts with a current reading.
    pub read: u32,
    /// Accounts with room now.
    pub room: u32,
    /// The 5-hour windows, then the weekly ones; a kind no account reported is left out.
    pub windows: Vec<WindowRoom>,
    /// Of the accounts read and without room, the soonest one has room
    /// again (its out-until, or the reset of the limit it's at).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_room: Option<AccountAt>,
    /// Engines that run out on every account at the recent pace (estimates).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub run_out: Vec<RunOut>,
}

/// The windows the totals look at: 5-hour and weekly (all models).
fn plan_windows(a: &AccountLine) -> impl Iterator<Item = &QuotaWindow> {
    a.windows.iter().filter(|w| family(w).is_some())
}

/// Whether the account was read: a current reading of a plan window.
pub fn is_read(a: &AccountLine) -> bool {
    a.signed_in && plan_windows(a).next().is_some()
}

/// Points left on the account's tightest plan window, by its reading.
/// `None`: not read. `Some(0)`: no room (out, or a limit used up).
pub fn room(a: &AccountLine) -> Option<f64> {
    if !is_read(a) {
        return None;
    }
    if a.out || plan_windows(a).any(full) {
        return Some(0.0);
    }
    plan_windows(a)
        .filter_map(|w| w.used_percent)
        .map(|p| (100.0 - p).max(0.0))
        .fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.min(x))))
}

fn has_room(a: &AccountLine) -> bool {
    room(a).is_some_and(|r| r > 0.0)
}

/// When an account without room has it again, as reported: its out-until,
/// else the latest reset among its used-up windows (the binding one).
fn back_at(a: &AccountLine) -> Option<i64> {
    if a.out {
        return a.out_until;
    }
    plan_windows(a)
        .filter(|w| full(w))
        .filter_map(|w| w.resets_at)
        .max()
}

fn at(a: &AccountLine, at: i64) -> AccountAt {
    AccountAt {
        engine: a.engine,
        account_id: a.id.clone(),
        account_name: a.name.clone(),
        at,
    }
}

/// The engine's run-out estimate, when the evidence covers every account.
fn run_out(engine: Engine, accounts: &[&AccountLine], now: i64) -> Option<RunOut> {
    let signed: Vec<&&AccountLine> = accounts.iter().filter(|a| a.signed_in).collect();
    if signed.len() < 2 {
        return None;
    }
    let (mut last, mut readings, mut paced) = (None::<i64>, 0u32, 0u32);
    // Each account's (runs out at, has room again at).
    let mut spans: Vec<(i64, i64)> = Vec::new();
    for a in &signed {
        if !is_read(a) {
            return None; // one we can't see: no claim about all of them
        }
        if !has_room(a) {
            spans.push((now, back_at(a)?));
            continue;
        }
        // Its binding pace: the soonest any of its plan windows runs out.
        let pace = a
            .pace
            .iter()
            .filter(|p| {
                a.windows
                    .iter()
                    .any(|w| w.kind == p.kind && family(w).is_some())
            })
            .filter(|p| p.reaches_at > now && p.reaches_at < p.resets_at)
            .min_by_key(|p| p.reaches_at)?; // flat use: it has room at this pace
        spans.push((pace.reaches_at, pace.resets_at));
        last = Some(last.map_or(pace.reaches_at, |l| l.max(pace.reaches_at)));
        readings += pace.readings;
        paced += 1;
    }
    let reaches_at = last?;
    // Every account must still be out when the last one runs out.
    spans
        .iter()
        .all(|&(from, back)| from <= reaches_at && back > reaches_at)
        .then_some(RunOut {
            estimate: true,
            engine,
            reaches_at,
            readings,
            accounts: paced,
        })
}

pub fn totals(accounts: &[AccountLine], now: i64) -> Totals {
    let mut engines: Vec<EngineCount> = Vec::new();
    for a in accounts {
        let i = match engines.iter().position(|e| e.engine == a.engine) {
            Some(i) => i,
            None => {
                engines.push(EngineCount {
                    engine: a.engine,
                    accounts: 0,
                    read: 0,
                    room: 0,
                });
                engines.len() - 1
            }
        };
        let e = &mut engines[i];
        e.accounts += 1;
        e.read += u32::from(is_read(a));
        e.room += u32::from(has_room(a));
    }
    let windows = [Family::Session, Family::Weekly]
        .into_iter()
        .filter_map(|fam| {
            let mut w = WindowRoom {
                family: fam,
                read: 0,
                room: 0,
                soonest_reset: None,
            };
            for a in accounts.iter().filter(|a| a.signed_in) {
                let Some(win) = a.windows.iter().find(|x| family(x) == Some(fam)) else {
                    continue;
                };
                w.read += 1;
                w.room += u32::from(!a.out && !full(win));
                if let Some(reset) = win.resets_at.filter(|&r| r > now) {
                    if w.soonest_reset.as_ref().is_none_or(|s| reset < s.at) {
                        w.soonest_reset = Some(at(a, reset));
                    }
                }
            }
            (w.read > 0).then_some(w)
        })
        .collect();
    let next_room = accounts
        .iter()
        .filter(|a| is_read(a) && !has_room(a))
        .filter_map(|a| back_at(a).filter(|&t| t > now).map(|t| at(a, t)))
        .min_by_key(|x| x.at);
    let run_out = Engine::ALL
        .iter()
        .filter_map(|&e| {
            let mine: Vec<&AccountLine> = accounts.iter().filter(|a| a.engine == e).collect();
            run_out(e, &mine, now)
        })
        .collect();
    Totals {
        accounts: accounts.len() as u32,
        read: engines.iter().map(|e| e.read).sum(),
        room: engines.iter().map(|e| e.room).sum(),
        engines,
        windows,
        next_room,
        run_out,
    }
}

#[cfg(test)]
#[path = "compute_tests.rs"]
mod tests;
