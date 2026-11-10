//! When this Mac's own sign-in to an engine becomes a different account.
//!
//! Signing Claude Code (or Codex) in again on this Mac as someone else
//! silently swaps the account behind "This Mac": the old one is no longer
//! reachable from here, and if the new one is an account already added, the
//! stack shows a duplicate and is an account's worth of room short. The
//! Usage view says so once, with the way back ("Add it").
//!
//! Only what the app recorded (Never Assume Data):
//! - **History** (`usage-readings.json`, `signIns`): each identity this
//!   Mac's own sign-in has had, by the engine's own record of who it is (the
//!   organization when it's known, else the email), with when it was first
//!   and last seen and the weekly reset a reading reported while it was the
//!   one signed in. A reading observed before an identity was first seen is
//!   never credited to it.
//! - **Before there was history**, the one record that tells two accounts
//!   apart is the weekly reset in this sign-in's own samples: a weekly limit
//!   resets at the same time each week, so a reset that moved to another
//!   time of the week, and stayed there, is another account behind the same
//!   sign-in. Said as exactly that (`by_reset`), never with a name.
//! - Nothing is said while the previous account is still connected (another
//!   account in the stack is it, or may be), or once the user answered it.
//!
//! Pure; `inventory::read` brings the files.

use serde::{Deserialize, Serialize};

use super::engine::Engine;
use super::forecast::Sample;
use super::identity::Identity;

pub const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Two weekly resets within this of each other (in the week) are one schedule.
const SAME_SCHEDULE_MS: i64 = 60 * 60 * 1000;
/// `seen` is rewritten at most this often when nothing else changed.
const SEEN_EVERY_MS: i64 = 60 * 60 * 1000;
/// Identities kept per engine.
const HISTORY_MAX: usize = 8;

/// One identity this Mac's own sign-in has had.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInRecord {
    /// What it is compared by: the engine's organization/user id, else
    /// `email:<address>`. Never shown.
    pub who: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    /// First seen signed in here, epoch ms.
    pub since: i64,
    /// Last seen signed in here.
    pub seen: i64,
    /// The latest weekly reset a reading reported while this was the one
    /// signed in (observed at or after `since`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_reset: Option<i64>,
}

/// The one notice: this Mac's sign-in is now another account, and the one
/// it was isn't connected any more.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInChange {
    pub engine: Engine,
    /// What answering it records (`usage_plan::sign_in_told`); no account id.
    pub key: String,
    /// When the new sign-in was first seen.
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now_org_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_org_name: Option<String>,
    /// A weekly reset the previous account reported: its day and time of the week.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_weekly_reset: Option<i64>,
    /// The current one's weekly reset, when a reading reported it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now_weekly_reset: Option<i64>,
    /// Told apart only by the weekly reset moving (no identity was recorded
    /// before): the wording says that, rather than naming an account.
    pub by_reset: bool,
}

/// Another signed-in account in the stack, to say whether the previous one
/// is still connected.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Connected {
    pub who: Option<String>,
    pub weekly_reset: Option<i64>,
}

/// What an identity is compared by, when the engine recorded anything.
pub fn who_of(identity: &Identity) -> Option<String> {
    identity.org.clone().or_else(|| {
        identity
            .email
            .as_ref()
            .map(|e| format!("email:{}", e.to_ascii_lowercase()))
    })
}

/// Where in the week `at` falls.
fn in_week(at: i64) -> i64 {
    at.rem_euclid(WEEK_MS)
}

/// Two resets on one weekly schedule.
pub fn same_schedule(a: i64, b: i64) -> bool {
    let d = (in_week(a) - in_week(b)).abs();
    d.min(WEEK_MS - d) <= SAME_SCHEDULE_MS
}

/// Keep what this Mac's own sign-in is now. `weekly` is its current weekly
/// window's reset and when that was observed. True when the history changed.
pub fn note(
    history: &mut Vec<SignInRecord>,
    identity: &Identity,
    weekly: Option<(i64, i64)>,
    now: i64,
) -> bool {
    let Some(who) = who_of(identity) else {
        return false;
    };
    match history.last_mut() {
        Some(last) if last.who == who => {
            let mut changed = false;
            if let Some((reset, observed)) = weekly {
                if observed >= last.since && last.weekly_reset != Some(reset) {
                    last.weekly_reset = Some(reset);
                    changed = true;
                }
            }
            if identity.email.is_some() && last.email != identity.email {
                last.email = identity.email.clone();
                changed = true;
            }
            if identity.org_name.is_some() && last.org_name != identity.org_name {
                last.org_name = identity.org_name.clone();
                changed = true;
            }
            if changed || now - last.seen >= SEEN_EVERY_MS {
                last.seen = now;
                changed = true;
            }
            changed
        }
        _ => {
            history.push(SignInRecord {
                who,
                email: identity.email.clone(),
                org_name: identity.org_name.clone(),
                since: now,
                seen: now,
                weekly_reset: weekly.filter(|(_, at)| *at >= now).map(|(r, _)| r),
            });
            if history.len() > HISTORY_MAX {
                history.remove(0);
            }
            true
        }
    }
}

/// From this sign-in's own samples: the weekly reset it had before its
/// latest move to another time of the week, when the new schedule was first
/// seen, and the latest reset. `None` when the reset never moved.
pub fn moved_schedule(samples: &[Sample]) -> Option<(i64, i64, i64)> {
    let mut weekly: Vec<(i64, i64)> = samples
        .iter()
        .filter(|s| s.kind == "seven_day")
        .filter_map(|s| s.resets_at.map(|r| (s.at, r)))
        .collect();
    weekly.sort();
    let (_, latest) = *weekly.last()?;
    // The last sample on another schedule; every one after it is on the latest's.
    let last_old = weekly
        .iter()
        .rposition(|(_, r)| !same_schedule(*r, latest))?;
    let (_, old) = weekly[last_old];
    let (first_new, _) = weekly[last_old + 1];
    Some((old, first_new, latest))
}

/// The notice for one engine, if there is one to give.
pub fn notice(
    engine: Engine,
    history: &[SignInRecord],
    samples: &[Sample],
    connected: &[Connected],
    told: &[String],
) -> Option<SignInChange> {
    let current = history.last()?;
    // Another account on that reset may be it, unless its identity is
    // recorded as someone else.
    let on_reset = |reset: Option<i64>, who: Option<&str>| {
        connected.iter().any(|c| {
            let same_reset =
                matches!((reset, c.weekly_reset), (Some(a), Some(b)) if same_schedule(a, b));
            let other = matches!((who, c.who.as_deref()), (Some(a), Some(b)) if a != b);
            same_reset && !other
        })
    };
    let change = if history.len() >= 2 {
        let before = &history[history.len() - 2];
        let by_who = connected
            .iter()
            .any(|c| c.who.as_deref() == Some(before.who.as_str()));
        if by_who || on_reset(before.weekly_reset, Some(&before.who)) {
            return None;
        }
        SignInChange {
            engine,
            key: format!("{}:{}", engine_word(engine), current.since),
            at: current.since,
            now_email: current.email.clone(),
            now_org_name: current.org_name.clone(),
            before_email: before.email.clone(),
            before_org_name: before.org_name.clone(),
            before_weekly_reset: before.weekly_reset,
            now_weekly_reset: current.weekly_reset,
            by_reset: false,
        }
    } else {
        let (old, at, latest) = moved_schedule(samples)?;
        // The current one's own recorded reset says otherwise.
        if current.weekly_reset.is_some_and(|r| same_schedule(r, old)) {
            return None;
        }
        if on_reset(Some(old), None) {
            return None;
        }
        SignInChange {
            engine,
            key: format!("{}:moved:{at}", engine_word(engine)),
            at,
            now_email: current.email.clone(),
            now_org_name: current.org_name.clone(),
            before_email: None,
            before_org_name: None,
            before_weekly_reset: Some(old),
            now_weekly_reset: Some(current.weekly_reset.unwrap_or(latest)),
            by_reset: true,
        }
    };
    (!told.contains(&change.key)).then_some(change)
}

fn engine_word(engine: Engine) -> &'static str {
    engine.word()
}

#[cfg(test)]
#[path = "sign_in_change_tests.rs"]
mod tests;
