//! What each scheduled run came to, and trying again when one failed for a
//! reason that heals on its own.
//!
//! A check-in or routine firing is a wake like any other (`schedule::wake`);
//! the turn that answers it may be shared with other messages. So a firing
//! leaves a [`Ticket`] whose id rides on the queued wake, and when a turn
//! ends (`runner::drain` → [`turn_ended`]) the tickets that turn carried are
//! settled by id, by how it ended: stopped (by the user, or dropped by a
//! Stop before it started) is a failure, "Stopped"; otherwise its newest
//! chat line is a failed turn's error, or it isn't. An interrupted turn's
//! tickets carry over to the turn that replaces it.
//!
//! - **Temporary failures are retried** (`failure::is_temporary`: the usage
//!   limit, Anthropic overloaded or erroring, the network): with backoff for
//!   up to [`RETRY_WINDOW_MS`]; a usage limit that says when it resets is
//!   retried just after that instead. A routine's retry never runs into its
//!   own next run, which supersedes it. A sign-in or anything we can't name
//!   isn't retried: retrying wouldn't help.
//! - **The user hears twice at most:** when it first fails (saying when it
//!   tries again), and at the end only if it ended in failure. Retries in
//!   between are silent; the schedule popover shows them.
//! - **Each routine keeps its last [`HISTORY`] runs**: when, and what came of it.
//! - Connectors Claude Code reported as needing sign-in are named on the run
//!   and in its failure notice.
//!
//! Like the schedule, nothing runs while Ship Studio is closed: a run cut off
//! by quitting is recorded as such at the next launch, and a routine's retry
//! that came due while closed is dropped rather than run late.

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};
use tauri::AppHandle;

use super::failure::{self, Failure};
use super::schedule::{CheckIn, ROUTINE_GRACE_MS};
use super::store::{self, MessageKind};
use super::usage::UsageTotals;

const MINUTE_MS: i64 = 60_000;
/// Runs kept per check-in.
pub const HISTORY: usize = 10;
/// How long after the first failure retries keep coming.
pub const RETRY_WINDOW_MS: i64 = 3 * 60 * MINUTE_MS;
/// A usage limit's reset further off than this (a weekly limit) isn't waited for.
pub const RESET_WINDOW_MS: i64 = 6 * 60 * MINUTE_MS;
/// A reset time is when the limit lifts; a minute later it has.
pub const AFTER_RESET_MS: i64 = MINUTE_MS;
/// Waits before each retry, in minutes; the last repeats.
const BACKOFF_MINUTES: [i64; 6] = [2, 5, 10, 20, 40, 60];
/// The final retry is pulled in to the window's end, unless that's this close.
const LAST_TRY_GAP_MS: i64 = 10 * MINUTE_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Running,
    /// The turn ended without an error.
    Ran,
    /// It failed and is tried again at `retry_at`.
    Retrying,
    Failed,
    /// Its time came while the user was driving the agent (`takeover`).
    Skipped,
    /// Written by a newer build.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// When it fired.
    pub at: i64,
    pub outcome: Outcome,
    /// 1 for the run itself, 2 for its first retry, …
    #[serde(default = "first")]
    pub attempt: u32,
    /// Why it failed, as the chat said it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    /// Connectors Claude Code said need signing in again, when it ran.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sign_in: Vec<String>,
    /// Run now, from the popover.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
}

fn first() -> u32 {
    1
}

/// A failed run waiting to be tried again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retry {
    pub at: i64,
    /// Tries that have failed so far.
    pub attempts: u32,
    pub first_failed_at: i64,
    /// When the run being retried was due.
    pub due_at: i64,
}

/// Keep `run` in a check-in's history: it replaces the row with the same
/// firing time (the one marked running), else it's added; the oldest go.
pub fn record(runs: &mut Vec<Run>, run: Run) {
    match runs.iter_mut().find(|r| r.at == run.at) {
        Some(row) => *row = run,
        None => runs.push(run),
    }
    let excess = runs.len().saturating_sub(HISTORY);
    runs.drain(..excess);
}

/// When to try again after `failures` failed tries, or `None` to stop.
/// `next_regular` is a routine's own next run, which a retry never reaches.
pub fn next_retry(
    failures: u32,
    first_failed_at: i64,
    now: i64,
    resets_at: Option<i64>,
    next_regular: Option<i64>,
) -> Option<i64> {
    let at = match resets_at {
        Some(reset) if reset > now => {
            if reset - first_failed_at > RESET_WINDOW_MS {
                return None;
            }
            reset + AFTER_RESET_MS
        }
        _ => {
            let step = (failures.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1);
            let at = now + BACKOFF_MINUTES[step] * MINUTE_MS;
            let end = first_failed_at + RETRY_WINDOW_MS;
            if at <= end {
                at
            } else if end - now >= LAST_TRY_GAP_MS {
                end
            } else {
                return None;
            }
        }
    };
    match next_regular {
        Some(next) if at >= next => None,
        _ => Some(at),
    }
}

/// A firing waiting for the turn that answers it.
#[derive(Debug, Clone)]
pub struct Ticket {
    /// Rides on the queued wake (`runner::Inbound::ticket`), so the turn
    /// that answers it settles it by id, however that turn ends.
    pub id: String,
    pub agent_id: String,
    /// The wake prompt it queued, verbatim.
    pub prompt: String,
    /// What fired (first), and one-time notes folded into the same wake.
    pub check_ins: Vec<CheckIn>,
    pub fired_at: i64,
    pub attempt: u32,
    pub first_failed_at: Option<i64>,
    pub due_at: i64,
    pub manual: bool,
}

/// How a ticket settled.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub run: Run,
    pub retry: Option<Retry>,
    /// `None`: notifications as the chat would have them. `Some(None)`:
    /// silent (a retry failing again). `Some(Some(text))`: say this instead.
    pub alert: Option<Option<String>>,
}

fn short(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars()
        .take(max - 1)
        .collect::<String>()
        .trim_end()
        .to_string()
        + "…"
}

fn sign_in_line(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => format!(" {one} needs signing in again."),
        many => format!(" {} need signing in again.", many.join(", ")),
    }
}

/// What a ticket comes to, given how its turn ended. Pure; `when` words a time.
pub fn settle(
    ticket: &Ticket,
    failed: Option<(&str, &Failure)>,
    sign_in: &[String],
    now: i64,
    next_regular: Option<i64>,
    when: impl Fn(i64) -> String,
) -> Settled {
    let mut run = Run {
        at: ticket.fired_at,
        outcome: Outcome::Ran,
        attempt: ticket.attempt,
        detail: None,
        retry_at: None,
        sign_in: sign_in.to_vec(),
        manual: ticket.manual,
    };
    let Some((detail, failure)) = failed else {
        return Settled {
            run,
            retry: None,
            alert: None,
        };
    };
    run.detail = Some(short(detail, 200));
    run.outcome = Outcome::Failed;
    // Run now: the user is there, and the chat already says what happened.
    if ticket.manual {
        return Settled {
            run,
            retry: None,
            alert: None,
        };
    }
    let first_failed_at = ticket.first_failed_at.unwrap_or(now);
    let retry_at = if failure::is_temporary(detail, failure) {
        next_retry(
            ticket.attempt,
            first_failed_at,
            now,
            failure.resets_at,
            next_regular,
        )
    } else {
        None
    };
    let name = ticket
        .check_ins
        .first()
        .map(|c| short(&c.note, 48))
        .unwrap_or_default();
    // What it was, in the alert's first words.
    let what = if ticket.check_ins.first().is_some_and(|c| c.watch.is_some()) {
        "“When…” routine"
    } else {
        "Scheduled"
    };
    let mut reason = short(detail, 160);
    if !reason.ends_with(['.', '!', '?', '…']) {
        reason.push('.');
    }
    let sign = sign_in_line(sign_in);
    match retry_at {
        Some(at) => {
            run.outcome = Outcome::Retrying;
            run.retry_at = Some(at);
            Settled {
                run,
                retry: Some(Retry {
                    at,
                    attempts: ticket.attempt,
                    first_failed_at,
                    due_at: ticket.due_at,
                }),
                alert: Some((ticket.attempt == 1).then(|| {
                    format!(
                        "{what} “{name}” didn't run: {reason} Trying again {}.{sign}",
                        when(at)
                    )
                })),
            }
        }
        None => Settled {
            run,
            retry: None,
            alert: Some(Some(if ticket.attempt == 1 {
                format!("{what} “{name}” didn't run: {reason}{sign}")
            } else {
                format!(
                    "{what} “{name}” still didn't run after {} tries: {reason}{sign}",
                    ticket.attempt
                )
            })),
        },
    }
}

/* ------------------------------------------------------------- tickets */

static TICKETS: LazyLock<Mutex<Vec<Ticket>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// A wake was queued; `turn_ended` settles it. Older tickets than a turn
/// can last (a turn that never ran: stopped, or its agent deleted) are dropped.
pub fn issue(ticket: Ticket) {
    let mut tickets = TICKETS.lock().unwrap_or_else(|e| e.into_inner());
    let oldest = ticket.fired_at - 4 * 60 * MINUTE_MS;
    tickets.retain(|t| t.fired_at >= oldest);
    tickets.push(ticket);
}

fn take(agent_id: &str, ids: &[String]) -> Vec<Ticket> {
    let mut tickets = TICKETS.lock().unwrap_or_else(|e| e.into_inner());
    let (mine, rest): (Vec<Ticket>, Vec<Ticket>) = tickets
        .drain(..)
        .partition(|t| t.agent_id == agent_id && ids.contains(&t.id));
    *tickets = rest;
    mine
}

/// The routine a turn's cost belongs to: the one thing it ran. A turn that
/// answered two routines' firings (or a routine and anything else, which
/// `spent` being `None` says) is charged to neither, because there is no
/// honest way to split one turn's reported cost between them. Every
/// check-in a ticket names counts, not just its first.
pub fn charged_to(tickets: &[Ticket], spent: Option<&UsageTotals>) -> Option<String> {
    spent.filter(|s| s.turns > 0)?;
    let mut ids = tickets
        .iter()
        .flat_map(|t| t.check_ins.iter().map(|c| c.id.as_str()));
    let first = ids.next()?;
    ids.all(|id| id == first).then(|| first.to_string())
}

/// A turn ended, or the wakes it would have answered were dropped. Settle
/// the scheduled runs `ids` it answered. `stopped`: it was stopped (or
/// never started), so they failed with these words; otherwise a failure is
/// the turn's newest line, when that's an error after it fired. `spent`:
/// what the turn cost, when it finished having run nothing but routines.
pub fn turn_ended(
    app: &AppHandle,
    agent_id: &str,
    ids: &[String],
    stopped: Option<&str>,
    spent: Option<&UsageTotals>,
) {
    let mine = take(agent_id, ids);
    let Some(since) = mine.iter().map(|t| t.fired_at).min() else {
        return;
    };
    if let (Some(id), Some(spent)) = (charged_to(&mine, spent), spent) {
        let today = super::usage::today();
        let _ = store::update(agent_id, |agent| {
            if let Some(c) = agent.check_ins.iter_mut().find(|c| c.id == id) {
                c.usage.record(spent, today);
            }
        });
    }
    let now = store::now_ms();
    let failed = match stopped {
        Some(why) => Some((why.to_string(), Failure::OTHER)),
        None => store::messages(agent_id, 1)
            .ok()
            .and_then(|m| m.into_iter().last())
            .filter(|m| m.kind == MessageKind::Error && m.ts >= since)
            .map(|m| {
                let failure = m.failure.clone().unwrap_or(Failure::OTHER);
                (m.text, failure)
            }),
    };
    let sign_in = super::broker::needs_sign_in(agent_id);
    let tz = chrono::Local;
    for ticket in mine {
        let Some(fired) = ticket.check_ins.first() else {
            continue;
        };
        let next_regular = store::get(agent_id)
            .ok()
            .and_then(|a| a.check_ins.into_iter().find(|c| c.id == fired.id))
            .filter(|c| c.repeat.is_some())
            .map(|c| c.next_at);
        let settled = settle(
            &ticket,
            failed.as_ref().map(|(t, f)| (t.as_str(), f)),
            &sign_in,
            now,
            next_regular,
            |at| failure::clock_phrase(&tz, at, now),
        );
        let _ = store::update(agent_id, |agent| {
            for snapshot in &ticket.check_ins {
                match agent.check_ins.iter_mut().find(|c| c.id == snapshot.id) {
                    Some(c) => {
                        record(&mut c.runs, settled.run.clone());
                        c.retry = settled.retry.clone();
                        // A "When…" firing settled for good: its items are done with.
                        if settled.retry.is_none() {
                            if let Some(w) = c.watch.as_mut() {
                                w.pending.clear();
                            }
                        }
                    }
                    // A one-time check-in left when it fired; it comes back to be retried.
                    None if settled.retry.is_some() && snapshot.repeat.is_none() => {
                        let mut back = snapshot.clone();
                        record(&mut back.runs, settled.run.clone());
                        back.retry = settled.retry.clone();
                        agent.check_ins.push(back);
                    }
                    None => {}
                }
            }
        });
        if let Some(alert) = settled.alert {
            super::notify::replace_held(agent_id, alert);
        }
        tracing::info!(agent = agent_id, attempt = ticket.attempt, outcome = ?settled.run.outcome, retry_at = ?settled.retry.as_ref().map(|r| r.at), "[Agents] scheduled run settled");
    }
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
}

/// A run cut off by the app quitting.
pub const APP_CLOSED: &str = "The app closed before it finished.";
/// A retry that came due while the app was closed.
pub const APP_NOT_RUNNING: &str = "The app wasn't running when it was due to try again.";

/// A run's failure was the app quitting, not the run failing: it doesn't
/// count toward a routine pausing itself.
pub fn is_interruption(detail: &str) -> bool {
    detail == APP_CLOSED || detail == APP_NOT_RUNNING
}

/// At launch: a run still marked running was cut off by quitting, and a
/// routine's retry that came due while closed is dropped, not run late.
pub fn after_restart(check_ins: &mut [CheckIn], now: i64) -> bool {
    let mut changed = false;
    for c in check_ins.iter_mut() {
        for run in c.runs.iter_mut().filter(|r| r.outcome == Outcome::Running) {
            run.outcome = Outcome::Failed;
            run.detail = Some(APP_CLOSED.to_string());
            changed = true;
        }
        let stale = (c.repeat.is_some() || c.watch.is_some())
            && c.retry
                .as_ref()
                .is_some_and(|r| now - r.at > ROUTINE_GRACE_MS);
        if stale {
            c.retry = None;
            if let Some(run) = c
                .runs
                .iter_mut()
                .rev()
                .find(|r| r.outcome == Outcome::Retrying)
            {
                run.outcome = Outcome::Failed;
                run.retry_at = None;
                run.detail = Some(APP_NOT_RUNNING.to_string());
            }
            changed = true;
        }
    }
    changed
}

/// A routine's own time came while a retry was pending: the retry is dropped.
pub fn superseded(runs: &mut [Run]) {
    if let Some(run) = runs
        .iter_mut()
        .rev()
        .find(|r| r.outcome == Outcome::Retrying)
    {
        run.outcome = Outcome::Failed;
        run.retry_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::super::failure::FailureKind;
    use super::*;

    const NOW: i64 = 1_793_613_600_000;
    const MIN: i64 = MINUTE_MS;

    fn other() -> Failure {
        Failure::OTHER
    }

    /// Retries from a first failure at NOW, failing instantly each time.
    fn schedule(resets_at: Option<i64>, next_regular: Option<i64>) -> Vec<i64> {
        let mut at = NOW;
        let mut out = Vec::new();
        for failures in 1..=20 {
            match next_retry(failures, NOW, at, resets_at, next_regular) {
                Some(next) => {
                    out.push((next - NOW) / MIN);
                    at = next;
                }
                None => break,
            }
        }
        out
    }

    #[test]
    fn backs_off_for_about_three_hours_then_stops() {
        assert_eq!(schedule(None, None), vec![2, 7, 17, 37, 77, 137, 180]);
        assert!(*schedule(None, None).last().unwrap() * MIN <= RETRY_WINDOW_MS);
    }

    #[test]
    fn a_known_reset_is_waited_for_then_tried_just_after() {
        let reset = NOW + 95 * MIN;
        assert_eq!(
            next_retry(1, NOW, NOW, Some(reset), None),
            Some(reset + AFTER_RESET_MS)
        );
        // Even past the backoff window, as long as it's a session limit's reset.
        let later = NOW + 4 * 60 * MIN;
        assert_eq!(
            next_retry(1, NOW, NOW, Some(later), None),
            Some(later + AFTER_RESET_MS)
        );
        // A weekly limit days away isn't waited for.
        assert_eq!(
            next_retry(1, NOW, NOW, Some(NOW + 3 * 24 * 60 * MIN), None),
            None
        );
        // A reset already past: plain backoff.
        assert_eq!(
            next_retry(2, NOW, NOW + 2 * MIN, Some(NOW), None),
            Some(NOW + 7 * MIN)
        );
    }

    #[test]
    fn a_routines_retry_never_reaches_its_next_run() {
        assert_eq!(schedule(None, Some(NOW + 60 * MIN)), vec![2, 7, 17, 37]);
        assert_eq!(
            next_retry(1, NOW, NOW, Some(NOW + 90 * MIN), Some(NOW + 60 * MIN)),
            None
        );
    }

    fn check_in(note: &str, repeat: bool) -> CheckIn {
        serde_json::from_value(serde_json::json!({
            "id": "c1", "note": note, "nextAt": NOW, "createdAt": 0,
            "repeat": if repeat { serde_json::json!({"kind": "every", "minutes": 60}) } else { serde_json::Value::Null }
        }))
        .unwrap()
    }

    #[test]
    fn a_turn_is_charged_to_a_routine_only_when_it_ran_that_routine_alone() {
        let spent = UsageTotals {
            turns: 1,
            cost_usd: 0.42,
            priced_turns: 1,
            ..Default::default()
        };
        let one = ticket(1);
        assert_eq!(
            charged_to(std::slice::from_ref(&one), Some(&spent)),
            Some("c1".into())
        );
        // A retry of the same routine in the same turn is still that routine.
        assert_eq!(
            charged_to(&[one.clone(), ticket(2)], Some(&spent)),
            Some("c1".into())
        );
        // Two routines in one turn: neither, the cost can't be split honestly.
        let mut other = ticket(1);
        other.check_ins[0].id = "c2".into();
        assert_eq!(charged_to(&[one.clone(), other], Some(&spent)), None);
        // One ticket naming two check-ins (a one-time firing's `also`): every
        // one counts, not just the first.
        let mut two = ticket(1);
        let mut also = check_in("Also this", true);
        also.id = "c9".into();
        two.check_ins.push(also);
        assert_eq!(charged_to(std::slice::from_ref(&two), Some(&spent)), None);
        // Mixed with a person's message (the runner passes no cost), or nothing reported.
        assert_eq!(charged_to(std::slice::from_ref(&one), None), None);
        assert_eq!(
            charged_to(std::slice::from_ref(&one), Some(&UsageTotals::default())),
            None
        );
        assert_eq!(charged_to(&[], Some(&spent)), None);
    }

    #[test]
    fn a_routines_week_is_kept_beside_its_runs() {
        let mut c = check_in("Brief me", true);
        assert!(c.usage.is_empty());
        let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let spent = UsageTotals {
            turns: 1,
            cost_usd: 0.5,
            priced_turns: 1,
            input_tokens: 100,
            ..Default::default()
        };
        c.usage.record(&spent, day);
        c.usage.record(&spent, day);
        let json = serde_json::to_value(&c).unwrap();
        assert!(json.get("usage").is_some());
        let back: CheckIn = serde_json::from_value(json).unwrap();
        let week = back.usage.summary(day).week;
        assert_eq!(
            (week.turns, week.priced_turns, week.input_tokens),
            (2, 2, 200)
        );
        assert!((week.cost_usd - 1.0).abs() < 1e-9);
        // A routine that never ran writes no usage at all (older builds read the same file).
        assert!(serde_json::to_value(check_in("x", true))
            .unwrap()
            .get("usage")
            .is_none());
    }

    fn ticket(attempt: u32) -> Ticket {
        Ticket {
            id: "t1".into(),
            agent_id: "a".into(),
            prompt: "[Scheduled check-in you set: brief]".into(),
            check_ins: vec![check_in("Brief me on Acme", true)],
            fired_at: NOW,
            attempt,
            first_failed_at: (attempt > 1).then_some(NOW - 10 * MIN),
            due_at: NOW - 10 * MIN,
            manual: false,
        }
    }

    fn at(ms: i64) -> String {
        format!("at +{}m", (ms - NOW) / MIN)
    }

    #[test]
    fn notifies_on_the_first_failure_and_only_a_failed_end() {
        let overloaded = "API Error: 529 overloaded";
        // First failure: retried, and said once with when.
        let s = settle(&ticket(1), Some((overloaded, &other())), &[], NOW, None, at);
        assert_eq!(s.run.outcome, Outcome::Retrying);
        assert_eq!(s.retry.as_ref().map(|r| r.at), Some(NOW + 2 * MIN));
        assert_eq!(
            s.alert,
            Some(Some("Scheduled “Brief me on Acme” didn't run: API Error: 529 overloaded. Trying again at +2m.".into()))
        );
        // A retry failing again: silent.
        let s = settle(&ticket(2), Some((overloaded, &other())), &[], NOW, None, at);
        assert_eq!(s.run.outcome, Outcome::Retrying);
        assert_eq!(s.alert, Some(None));
        assert_eq!(s.retry.unwrap().first_failed_at, NOW - 10 * MIN);
        // A retry that works: no failure notice; the reply notifies as usual.
        let s = settle(&ticket(3), None, &[], NOW, None, at);
        assert_eq!(
            (s.run.outcome, s.retry, s.alert),
            (Outcome::Ran, None, None)
        );
        // Out of retries: the end, said.
        let mut late = ticket(8);
        late.first_failed_at = Some(NOW - 3 * 60 * MIN);
        let s = settle(&late, Some((overloaded, &other())), &[], NOW, None, at);
        assert_eq!(s.run.outcome, Outcome::Failed);
        assert!(s
            .alert
            .unwrap()
            .unwrap()
            .contains("still didn't run after 8 tries"));
    }

    #[test]
    fn what_retrying_cant_fix_fails_at_once_and_names_sign_ins() {
        let signed_out = Failure {
            kind: FailureKind::SignedOut,
            resets_at: None,
        };
        let s = settle(
            &ticket(1),
            Some(("Claude Code is signed out.", &signed_out)),
            &["Gmail".to_string()],
            NOW,
            None,
            at,
        );
        assert_eq!(s.run.outcome, Outcome::Failed);
        assert_eq!(s.retry, None);
        assert_eq!(
            s.alert,
            Some(Some("Scheduled “Brief me on Acme” didn't run: Claude Code is signed out. Gmail needs signing in again.".into()))
        );
        assert_eq!(s.run.sign_in, vec!["Gmail"]);
        // Run now isn't retried or announced.
        let mut manual = ticket(1);
        manual.manual = true;
        let s = settle(
            &manual,
            Some(("API Error: 529 overloaded", &other())),
            &[],
            NOW,
            None,
            at,
        );
        assert_eq!(
            (s.run.outcome, s.retry, s.alert),
            (Outcome::Failed, None, None)
        );
    }

    #[test]
    fn a_usage_limit_retries_after_its_reset() {
        let limit = Failure {
            kind: FailureKind::UsageLimit,
            resets_at: Some(NOW + 50 * MIN),
        };
        let s = settle(
            &ticket(1),
            Some(("Claude Code's usage limit is reached.", &limit)),
            &[],
            NOW,
            None,
            at,
        );
        assert_eq!(s.retry.unwrap().at, NOW + 51 * MIN);
    }

    #[test]
    fn history_keeps_the_last_ten_and_settles_in_place() {
        let mut runs = Vec::new();
        for i in 0..12 {
            record(
                &mut runs,
                Run {
                    at: i,
                    outcome: Outcome::Running,
                    attempt: 1,
                    detail: None,
                    retry_at: None,
                    sign_in: vec![],
                    manual: false,
                },
            );
        }
        assert_eq!(runs.len(), HISTORY);
        assert_eq!(runs[0].at, 2);
        let mut done = runs[9].clone();
        done.outcome = Outcome::Ran;
        record(&mut runs, done);
        assert_eq!(runs.len(), HISTORY);
        assert_eq!(runs[9].outcome, Outcome::Ran);
    }

    #[test]
    fn a_restart_closes_cut_off_runs_and_drops_stale_retries() {
        let mut c = check_in("Brief", true);
        c.runs = vec![
            Run {
                at: NOW - 200 * MIN,
                outcome: Outcome::Retrying,
                attempt: 1,
                detail: None,
                retry_at: Some(NOW - 190 * MIN),
                sign_in: vec![],
                manual: false,
            },
            Run {
                at: NOW - 5 * MIN,
                outcome: Outcome::Running,
                attempt: 1,
                detail: None,
                retry_at: None,
                sign_in: vec![],
                manual: false,
            },
        ];
        c.retry = Some(Retry {
            at: NOW - 190 * MIN,
            attempts: 1,
            first_failed_at: NOW - 200 * MIN,
            due_at: NOW - 200 * MIN,
        });
        let mut list = vec![c];
        assert!(after_restart(&mut list, NOW));
        assert_eq!(list[0].retry, None);
        assert!(list[0].runs.iter().all(|r| r.outcome == Outcome::Failed));
        // A newer build's outcome reads as unknown, not as an unreadable registry.
        let run: Run =
            serde_json::from_value(serde_json::json!({"at": 1, "outcome": "skipped_by_policy"}))
                .unwrap();
        assert_eq!((run.outcome, run.attempt), (Outcome::Unknown, 1));
    }
}
