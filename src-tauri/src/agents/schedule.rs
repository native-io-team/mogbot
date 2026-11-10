//! Check-ins and routines: an agent that says "I'll check back Thursday" and
//! then does.
//!
//! An agent schedules one with the `schedule_check_in` tool, in the user's
//! local time: once ("tomorrow at 9:00", "in 2 hours") or on repeat ("every
//! weekday at 9:00", "every 2 hours"). It's stored on the agent's registry
//! entry. When it comes due, a turn is queued for that agent with the note it
//! left itself, and a quiet "Scheduled check-in" line goes in the chat above
//! the reply.
//!
//! The rules (inherited from Ship Studio's workflow scheduler), which the UI
//! and the tool both say out loud:
//!
//! - **Nothing fires while Ship Studio is closed.** There is no server.
//! - **A missed one-time check-in fires once, late, when the app reopens**,
//!   and says it's late. The user asked for it; late beats never. An agent
//!   that missed several is woken once, with all of their notes.
//! - **A missed routine runs once, late, and doesn't backfill.** A week away
//!   is one brief when the app reopens, marked late, not seven, and never
//!   none: a routine is never skipped silently. If its next time is only
//!   minutes off, the late run stands in for it.
//! - **At most one check-in fires per tick**, most overdue first, so a
//!   backlog at launch can't start every agent at once.
//!
//! Its own loop, not a line in another tick: a tick that awaited a long run
//! would make every check-in queued behind it arrive "late" for a reason that
//! has nothing to do with the user.

use chrono::{
    DateTime, Datelike, Duration as Span, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

use super::runner;
use super::runs;
use super::store::{self, MessageKind};
use crate::errors::CommandError;

/// More than this and an agent is spamming, not following up.
pub const MAX_PER_AGENT: usize = 12;
/// A turn spends the user's Claude quota; half an hour is the tightest loop
/// worth having. A week is the loosest an "every" phrase should mean.
pub const MIN_EVERY_MINUTES: u32 = 30;
pub const MAX_EVERY_MINUTES: u32 = 7 * 24 * 60;
const MAX_AHEAD_DAYS: i64 = 366;
const MAX_NOTE_CHARS: usize = 600;

/// Fired more than this after it was due: the app wasn't running (or the Mac
/// was asleep), so it's marked late. A tick is a minute; three is slack.
pub const LATE_AFTER_MS: i64 = 3 * 60_000;
/// A routine missed by more than this runs once, late, and a next time
/// closer than this is the one that late run stands in for.
pub const ROUTINE_GRACE_MS: i64 = 30 * 60_000;

const TICK: Duration = Duration::from_secs(60);
/// Same grace as the workflow scheduler: let the window and projects load.
const STARTUP_GRACE: Duration = Duration::from_secs(45);

const MINUTE_MS: i64 = 60_000;

/// How a routine repeats. A one-time check-in has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Repeat {
    /// On these weekdays (0 = Sunday, as in JavaScript), at a local time.
    Days {
        days: Vec<u8>,
        hour: u32,
        minute: u32,
    },
    /// A fixed interval, measured in real minutes (DST doesn't stretch it).
    Every { minutes: u32 },
    /// On a day of the month at a local time, every month or every few (3
    /// for quarterly). A date a month doesn't have ("the 31st" in April,
    /// "the 29th" in a February of 28 days) runs on that month's last day,
    /// so a routine set for a date never skips a month.
    Monthly {
        /// Every this many months, 1 to 12.
        #[serde(default = "one_month")]
        months: u32,
        on: MonthDay,
        hour: u32,
        minute: u32,
        /// With `months` over 1: a month it runs in (`year * 12 + month - 1`),
        /// so "every 3 months" keeps to the same months. Absent for every month.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<i32>,
    },
}

fn one_month() -> u32 {
    1
}

/// Which day of the month a monthly routine runs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MonthDay {
    /// The `nth` (1 to 4, or -1 for the last) `weekday` (0 = Sunday) of the month.
    Weekday { nth: i8, weekday: u8 },
    /// A date, 1 to 31, or -1 for the month's last day.
    Date { day: i8 },
}

/// The most months a routine can be apart: a year.
pub const MAX_EVERY_MONTHS: u32 = 12;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIn {
    pub id: String,
    /// What the agent told itself to do, in its own words.
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
    /// When it next fires, epoch ms. Advanced past `now` every time a routine
    /// fires or is skipped, so it is always the one true next time.
    pub next_at: i64,
    pub created_at: i64,
    #[serde(default)]
    pub paused: bool,
    /// Paused by an import (so a routine doesn't run in two apps at once),
    /// not by the user. Cleared when it's resumed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub paused_on_import: bool,
    /// Its last runs, oldest first (`agents::runs`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<runs::Run>,
    /// A failed run waiting to be tried again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<runs::Retry>,
    /// A "When…" routine (`agents::watch`): it fires when something
    /// happens, not at a time. `next_at` is then its next check and
    /// `repeat` is `None`; the time tick leaves it alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<super::watch::Watch>,
    /// What its runs cost, as the engine reported it: only turns that ran
    /// nothing but this routine (`runs::turn_ended`).
    #[serde(default, skip_serializing_if = "super::usage::AgentUsage::is_empty")]
    pub usage: super::usage::AgentUsage,
    /// The app recorded it, not the agent: a reply promised work ("I'll
    /// check Slack next") and the turn ended without doing it
    /// (`follow_up`). Its wake says so, and its turn never records another.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub follow_up: bool,
    /// Steps after the first (`note`), each its own turn, some waiting for
    /// the user's OK (`agents::routine_steps`). Time routines only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub then: Vec<super::routine_steps::Step>,
    /// A run waiting for the user's OK between two steps, with its card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<super::routine_steps::Waiting>,
    /// Fields a newer Ship Studio wrote that this build doesn't know: kept
    /// and written back as they were, so running an older build never
    /// strips what a newer one saved.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Stored on the chat line a firing leaves, so the UI can say when it was for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInMark {
    pub due_at: i64,
    pub late: bool,
    pub repeats: bool,
    /// The user pressed Run now; its schedule didn't move.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
    /// A "When…" routine fired: what it found, in a few words ("2 new
    /// GitHub mentions"). The chat line says this instead of a time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found: Option<String>,
}

/* -------------------------------------------------------------- grammar */

const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

const EXAMPLES: &str = "Examples: \"in 2 hours\", \"tomorrow at 9:00\", \"friday at 14:30\", \"2026-11-20 09:00\", \"every weekday at 9:00\", \"every monday at 8am\", \"every 2 hours\", \"every month on the 1st at 9:00\", \"every month on the last friday at 16:00\", \"every 3 months on the 15th at 9:00\".";

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// `march`, `mar`, `sept`: 0 = January.
fn month_name(word: &str) -> Option<u32> {
    let word = word.trim_end_matches('.');
    MONTHS
        .iter()
        .position(|m| *m == word || (word.len() >= 3 && m.starts_with(word)))
        .map(|i| i as u32)
}

fn weekday(word: &str) -> Option<u8> {
    let word = word.trim().trim_end_matches('s');
    WEEKDAYS
        .iter()
        .position(|d| *d == word || (word.len() >= 3 && d.starts_with(word)))
        .map(|i| i as u8)
}

/// `9`, `9:30`, `09:30`, `9am`, `9:30 pm`, `17:00`, `noon`, `midnight`.
pub(super) fn clock(raw: &str) -> Option<(u32, u32)> {
    let s = raw.trim().replace('.', "");
    match s.as_str() {
        "noon" => return Some((12, 0)),
        "midnight" => return Some((0, 0)),
        _ => {}
    }
    let (body, meridiem) = if let Some(b) = s.strip_suffix("am") {
        (b.trim(), Some(false))
    } else if let Some(b) = s.strip_suffix("pm") {
        (b.trim(), Some(true))
    } else {
        (s.as_str(), None)
    };
    let (h, m) = body.split_once(':').unwrap_or((body, "0"));
    if h.is_empty() || m.len() > 2 || !h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (mut hour, minute): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if minute > 59 {
        return None;
    }
    match meridiem {
        Some(pm) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            hour = match (pm, hour) {
                (false, 12) => 0,
                (true, 12) => 12,
                (true, h) => h + 12,
                (false, h) => h,
            };
        }
        None if hour > 23 => return None,
        None => {}
    }
    Some((hour, minute))
}

/// `"<day part> at <time>"`, or `"<day part> <time>"` when the time is the last word.
fn split_at_time(s: &str) -> Option<(&str, (u32, u32))> {
    if let Some((day, time)) = s.rsplit_once(" at ") {
        return Some((day.trim(), clock(time)?));
    }
    // A bare time: "9:00", "5pm".
    if let Some(t) = clock(s) {
        return Some(("", t));
    }
    // "tomorrow 9am", "friday 14:30", "2026-11-20 09:00", "monday 9 am"
    let words: Vec<&str> = s.split(' ').collect();
    for take in [2, 1] {
        if words.len() > take {
            let (day, time) = words.split_at(words.len() - take);
            if let Some(t) = clock(&time.join(" ")) {
                return Some((s[..day.join(" ").len()].trim(), t));
            }
        }
    }
    None
}

/// A wall-clock time on a date in `tz`. On the spring-forward night a time
/// that doesn't exist (02:30) becomes the same time an hour on (03:30), as if
/// the clock had never jumped; on the fall-back night the first of the two
/// 01:30s is used. Both are what a person setting an alarm would expect.
pub fn resolve<Tz: TimeZone>(tz: &Tz, date: NaiveDate, hour: u32, minute: u32) -> Option<i64> {
    let naive = NaiveDateTime::new(date, NaiveTime::from_hms_opt(hour, minute, 0)?);
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        LocalResult::None => tz
            .from_local_datetime(&(naive + Span::hours(1)))
            .earliest()
            .map(|t| t.timestamp_millis()),
    }
}

fn local<Tz: TimeZone>(tz: &Tz, ms: i64) -> Option<DateTime<Tz>> {
    tz.timestamp_millis_opt(ms).single()
}

/// The first time strictly after `after` that is on one of `days` at `hour:minute`.
pub fn next_on_days<Tz: TimeZone>(
    tz: &Tz,
    days: &[u8],
    hour: u32,
    minute: u32,
    after: i64,
) -> Option<i64> {
    let mut date = local(tz, after)?.date_naive();
    // Eight days covers any weekday, plus today when its time already went.
    for _ in 0..9 {
        if days.contains(&(date.weekday().num_days_from_sunday() as u8)) {
            if let Some(at) = resolve(tz, date, hour, minute) {
                if at > after {
                    return Some(at);
                }
            }
        }
        date = date.succ_opt()?;
    }
    None
}

/// A month as one number, `year * 12 + month - 1`, so months add and compare.
fn month_index(date: NaiveDate) -> i32 {
    date.year() * 12 + date.month0() as i32
}

/// The date `on` names in the month `index` ([`month_index`]). A date the
/// month doesn't have is its last day; a value no writer here makes (a 0th,
/// a 5th Monday) is read as the nearest one that exists, never a panic.
pub fn month_day(index: i32, on: &MonthDay) -> Option<NaiveDate> {
    let (year, month) = (index.div_euclid(12), index.rem_euclid(12) as u32 + 1);
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let last = first
        .checked_add_months(chrono::Months::new(1))?
        .pred_opt()?;
    match *on {
        MonthDay::Date { day } => {
            let day = if day < 0 { 31 } else { day.max(1) as u32 };
            first.with_day(day.min(last.day()))
        }
        MonthDay::Weekday { nth, weekday } => {
            let want = (weekday % 7) as i64;
            if !(0..=4).contains(&nth) {
                let back = (last.weekday().num_days_from_sunday() as i64 - want).rem_euclid(7);
                return Some(last - Span::days(back));
            }
            let ahead = (want - first.weekday().num_days_from_sunday() as i64).rem_euclid(7);
            Some(first + Span::days(ahead + 7 * (nth.max(1) as i64 - 1)))
        }
    }
}

/// The first time strictly after `after` that a monthly routine runs: in a
/// month `months` apart from `from` (any month without one), on `on`, at
/// `hour:minute` local. Each month's time is read on its own date, so a
/// routine at 09:00 stays at 09:00 across a DST change.
pub fn next_monthly<Tz: TimeZone>(
    tz: &Tz,
    months: u32,
    on: &MonthDay,
    hour: u32,
    minute: u32,
    from: Option<i32>,
    after: i64,
) -> Option<i64> {
    let step = months.clamp(1, MAX_EVERY_MONTHS) as i32;
    let here = month_index(local(tz, after)?.date_naive());
    let phase = from.unwrap_or(here);
    let mut index = here + (phase - here).rem_euclid(step);
    // This month's may have gone; the next one in step never has.
    for _ in 0..3 {
        if let Some(at) = month_day(index, on).and_then(|d| resolve(tz, d, hour, minute)) {
            if at > after {
                return Some(at);
            }
        }
        index += step;
    }
    None
}

/// The next time a routine fires after it was due at `due`, skipping every
/// occurrence up to `now` — that is the "no backfill" rule.
pub fn advance<Tz: TimeZone>(tz: &Tz, repeat: &Repeat, due: i64, now: i64) -> Option<i64> {
    match repeat {
        Repeat::Every { minutes } => {
            // Anchored on the schedule, not on when the tick happened to run,
            // so "every 2 hours" doesn't drift a minute a day.
            // Never under the floor, whatever a file on disk says: a
            // `minutes: 0` would divide by zero here, every tick.
            let step = (*minutes).max(MIN_EVERY_MINUTES) as i64 * MINUTE_MS;
            let behind = (now - due).max(0) / step + 1;
            Some(due + behind * step)
        }
        Repeat::Days { days, hour, minute } => next_on_days(tz, days, *hour, *minute, now),
        Repeat::Monthly {
            months,
            on,
            hour,
            minute,
            from,
        } => next_monthly(tz, *months, on, *hour, *minute, *from, now),
    }
}

/// Parse `when`, relative to `now`, into a repeat (if any) and the first time it fires.
///
/// Errors are written for the agent: they say what was wrong and show the
/// shapes that work, because the agent will simply try again.
pub fn parse<Tz: TimeZone>(when: &str, tz: &Tz, now: i64) -> Result<(Option<Repeat>, i64), String> {
    let s = when
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let fail = |why: &str| Err(format!("{why} {EXAMPLES}"));
    if s.is_empty() {
        return fail("`when` is empty.");
    }

    if s.split(' ')
        .any(|w| matches!(w, "year" | "years" | "yearly" | "annually" | "annual"))
        && !s.starts_with("in ")
    {
        return fail("Routines don't repeat by the year, but every 12 months does the same: \"every 12 months on the 3rd at 9:00 starting march\".");
    }
    if let Some(monthly) = parse_monthly(&s, tz, now) {
        let (repeat, next) = monthly.map_err(|why| format!("{why} {EXAMPLES}"))?;
        return Ok((Some(repeat), next));
    }

    let recurring = s
        .strip_prefix("every ")
        .map(str::to_string)
        .or_else(|| s.strip_prefix("daily at ").map(|t| format!("day at {t}")));
    if let Some(rest) = recurring {
        let repeat = parse_repeat(&rest)?;
        let next = match &repeat {
            Repeat::Every { minutes } => now + *minutes as i64 * MINUTE_MS,
            other => advance(tz, other, now, now)
                .ok_or_else(|| "That time doesn't exist.".to_string())?,
        };
        return Ok((Some(repeat), next));
    }

    let at = parse_once(&s, tz, now)?;
    if at <= now {
        return fail("That time has already passed.");
    }
    if at - now > MAX_AHEAD_DAYS * 24 * 60 * MINUTE_MS {
        return fail("That's more than a year away.");
    }
    Ok((None, at))
}

fn unit_minutes(unit: &str) -> Option<i64> {
    match unit.trim_end_matches('s') {
        "m" | "min" | "minute" => Some(1),
        "h" | "hr" | "hour" => Some(60),
        "d" | "day" => Some(24 * 60),
        "w" | "wk" | "week" => Some(7 * 24 * 60),
        _ => None,
    }
}

/// `30 minutes`, `2h`, `an hour`, `3 days`.
fn amount(s: &str) -> Option<(i64, i64)> {
    let s = s.trim();
    let (n, unit) = match s.split_once(' ') {
        Some((n, unit)) => (n, unit),
        None => {
            let split = s.find(|c: char| !c.is_ascii_digit())?;
            s.split_at(split)
        }
    };
    let n: i64 = match n {
        "a" | "an" | "one" | "" => 1,
        n => n.parse().ok()?,
    };
    (n > 0).then_some(())?;
    Some((n, unit_minutes(unit.trim())?))
}

fn parse_repeat(rest: &str) -> Result<Repeat, String> {
    let fail = |why: &str| Err(format!("{why} {EXAMPLES}"));
    // "every 2 hours", "every hour", "every 90 minutes"
    if let Some((n, per)) = amount(rest).or_else(|| amount(&format!("1 {rest}"))) {
        if per < 24 * 60 {
            let minutes = n * per;
            if minutes < MIN_EVERY_MINUTES as i64 {
                return fail("Routines can't run more often than every 30 minutes.");
            }
            return Ok(Repeat::Every {
                minutes: minutes as u32,
            });
        }
        if n == 1 && rest.trim_start_matches("1 ").trim_end_matches('s') != "week" {
            return fail("Give it a time of day, e.g. \"every day at 9:00\".");
        }
        if (n * per) > MAX_EVERY_MINUTES as i64 {
            return fail("That's too far apart for a routine.");
        }
        return fail(
            "For a daily or weekly routine, name the day and time, e.g. \"every monday at 9:00\".",
        );
    }
    let Some((day_part, (hour, minute))) = split_at_time(rest) else {
        return fail("Give the routine a time of day.");
    };
    let mut days: Vec<u8> = match day_part {
        "day" | "morning" | "evening" | "night" => (0..7).collect(),
        "weekday" | "work day" | "workday" => (1..=5).collect(),
        "weekend" | "weekend day" => vec![0, 6],
        list => {
            let mut days = Vec::new();
            for word in list
                .split([',', ' ', '/'])
                .filter(|w| !w.is_empty() && *w != "and")
            {
                match weekday(word) {
                    Some(d) => days.push(d),
                    None => return fail(&format!("\"{word}\" isn't a day I know.")),
                }
            }
            days
        }
    };
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return fail("Name the days.");
    }
    Ok(Repeat::Days { days, hour, minute })
}

/// The words of a monthly routine: they say "month" (or "monthly",
/// "quarter", "quarterly") and aren't a one-off ("in 3 months").
fn says_monthly(s: &str) -> bool {
    !s.starts_with("in ")
        && s.split([' ', ','])
            .any(|w| matches!(w, "month" | "months" | "monthly" | "quarter" | "quarterly"))
}

/// `1st`, `15th`, `22`, `first`, `last`: which one (-1 = the last).
fn ordinal(word: &str) -> Option<i8> {
    match word {
        "first" => return Some(1),
        "second" => return Some(2),
        "third" => return Some(3),
        "fourth" => return Some(4),
        "fifth" => return Some(5),
        "last" | "final" => return Some(-1),
        _ => {}
    }
    let digits = word.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    if digits.is_empty()
        || !digits.chars().all(|c| c.is_ascii_digit())
        || !matches!(&word[digits.len()..], "" | "st" | "nd" | "rd" | "th")
    {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    i8::try_from(n.min(99)).ok()
}

/// `two` … `twelve`, for "every three months".
fn small_number(word: &str) -> Option<u32> {
    if let Ok(n) = word.parse() {
        return Some(n);
    }
    [
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
        "twelve",
    ]
    .iter()
    .position(|w| *w == word)
    .map(|i| i as u32 + 1)
}

/// A monthly routine, or `None` when the words aren't about months at all:
/// "every month on the 1st at 09:00", "on the 1st of every month at 9am",
/// "monthly on day 15 at 9:00", "every last friday of the month at 16:00",
/// "every 3 months on the 15th at 09:00 starting january", "quarterly on
/// the 1st at 9:00" (quarterly keeps to calendar quarters: January, April,
/// July and October).
fn parse_monthly<Tz: TimeZone>(
    s: &str,
    tz: &Tz,
    now: i64,
) -> Option<Result<(Repeat, i64), String>> {
    says_monthly(s).then(|| read_monthly(s, tz, now))
}

fn read_monthly<Tz: TimeZone>(s: &str, tz: &Tz, now: i64) -> Result<(Repeat, i64), String> {
    let mut words: Vec<&str> = s
        .split([' ', ',', '(', ')'])
        .filter(|w| !w.is_empty())
        .collect();

    // "starting january", "from march 2027", "beginning in april": the month
    // its first run is in, wherever it is said.
    let mut start: Option<(u32, Option<i32>)> = None;
    let mut i = 0;
    while i < words.len() {
        if matches!(words[i], "starting" | "from" | "beginning") {
            let at = i + 1 + usize::from(words.get(i + 1) == Some(&"in"));
            if let Some(m) = words.get(at).and_then(|w| month_name(w)) {
                let year = words
                    .get(at + 1)
                    .filter(|w| w.len() == 4)
                    .and_then(|w| w.parse::<i32>().ok());
                start = Some((m, year));
                words.drain(i..=at + usize::from(year.is_some()));
                continue;
            }
        }
        i += 1;
    }

    // The time: "at 9:00" / "at 9 am" anywhere, else a clock at the end
    // ("9am", "17:00"); a bare "15" at the end is a day, not 15:00.
    let mut time: Option<(u32, u32)> = None;
    for i in (0..words.len()).rev() {
        if words[i] != "at" {
            continue;
        }
        for take in [2, 1] {
            let end = i + 1 + take;
            if end <= words.len() {
                if let Some(t) = clock(&words[i + 1..end].join(" ")) {
                    time = Some(t);
                    words.drain(i..end);
                    break;
                }
            }
        }
        if time.is_some() {
            break;
        }
    }
    if time.is_none() {
        for take in [2, 1] {
            if words.len() >= take {
                let tail = words[words.len() - take..].join(" ");
                let clockish = tail.contains(':')
                    || tail.ends_with("am")
                    || tail.ends_with("pm")
                    || tail == "noon"
                    || tail == "midnight";
                if let Some(t) = clock(&tail).filter(|_| clockish) {
                    time = Some(t);
                    words.truncate(words.len() - take);
                    break;
                }
            }
        }
    }
    let Some((hour, minute)) = time else {
        return Err(
            "Give the routine a time of day, e.g. \"every month on the 1st at 9:00\".".into(),
        );
    };

    let mut months: Option<u32> = None;
    let mut quarterly = false;
    let mut nth: Option<i8> = None;
    let mut day_of: Option<u8> = None;
    let mut listed: Vec<u32> = Vec::new();
    let mut k = 0;
    while k < words.len() {
        let word = words[k];
        match word {
            "on" | "the" | "of" | "each" | "a" | "an" | "and" | "in" | "per" | "at" | "once"
            | "day" | "date" => {
                // "day 15": the number after it is the date.
                if word == "day" {
                    if let Some(n) = words.get(k + 1).and_then(|w| w.parse::<u32>().ok()) {
                        nth = Some(i8::try_from(n.min(99)).unwrap_or(99));
                        k += 1;
                    }
                }
            }
            "month" | "months" | "monthly" => {
                months.get_or_insert(1);
            }
            "quarter" | "quarterly" | "quarters" => {
                months = Some(3);
                quarterly = true;
            }
            "every" | "other" => {
                let next = words.get(k + 1).copied();
                let unit = words.get(k + 2).copied();
                if word == "every" && next == Some("other") && unit == Some("month") {
                    months = Some(2);
                    k += 2;
                } else if let (Some(n), Some("month" | "months")) =
                    (next.and_then(small_number), unit)
                {
                    months = Some(n);
                    k += 2;
                }
            }
            "end" => nth = Some(-1),
            "weekday" | "workday" | "business" | "working" => {
                return Err("A working day of the month can't be scheduled; name a weekday (\"the last friday\") or a date (\"the 1st\").".into());
            }
            _ => {
                if let Some(d) = weekday(word) {
                    if day_of.is_some_and(|x| x != d) {
                        return Err("Name one weekday for a monthly routine.".into());
                    }
                    day_of = Some(d);
                } else if let Some(n) = ordinal(word) {
                    if nth.is_some_and(|x| x != n) {
                        return Err("Name one day of the month (two days are two routines).".into());
                    }
                    nth = Some(n);
                } else if let Some(m) = month_name(word) {
                    listed.push(m);
                } else {
                    return Err(format!(
                        "\"{word}\" isn't something I can read in a monthly routine."
                    ));
                }
            }
        }
        k += 1;
    }

    let months = months.unwrap_or(1);
    if months == 0 {
        return Err(
            "Say how many months apart, e.g. \"every 3 months on the 15th at 9:00\".".into(),
        );
    }
    if months > MAX_EVERY_MONTHS {
        return Err("That's too far apart for a routine: every 12 months at most.".into());
    }
    let on = match (nth, day_of) {
        (Some(n @ (1..=4 | -1)), Some(d)) => MonthDay::Weekday { nth: n, weekday: d },
        (Some(5), Some(d)) => {
            return Err(format!(
                "Not every month has a fifth {}; say \"the last {}\".",
                day_name(d),
                WEEKDAYS[d as usize]
            ))
        }
        (_, Some(d)) => {
            return Err(format!(
                "Say which {} of the month: the first, second, third, fourth or last.",
                day_name(d)
            ))
        }
        (Some(n @ (1..=31 | -1)), None) => MonthDay::Date { day: n },
        (Some(_), None) => return Err("A month has at most 31 days.".into()),
        (None, None) => {
            return Err(
                "Say which day of the month, e.g. \"every month on the 1st at 9:00\" or \"every month on the last friday at 16:00\"."
                    .into(),
            )
        }
    };

    let unreadable = || "The clock is unreadable.".to_string();
    let here = month_index(local(tz, now).ok_or_else(unreadable)?.date_naive());
    let step = months as i32;
    // The months it runs in, named ("(jan, apr, jul and oct)", as `describe`
    // writes them): they must be `months` apart. Quarterly with none named
    // is the calendar's quarters.
    if let Some(&first) = listed.first() {
        if months > 1
            && listed
                .iter()
                .any(|m| (*m as i32 - first as i32) % step != 0)
        {
            return Err(format!("Those months aren't {months} months apart."));
        }
    }
    let phase = listed
        .first()
        .copied()
        .or(quarterly.then_some(0))
        .map(|m| here - here.rem_euclid(12) + m as i32);
    let first = match (start, phase) {
        (_, _) if months == 1 => next_monthly(tz, 1, &on, hour, minute, None, now),
        // "starting january": its first run is in that month (this one, if
        // it's this month), however many months off.
        (Some((m, year)), _) => {
            let mut begin = match year {
                Some(y) => y * 12 + m as i32,
                None => here + (m as i32 - here.rem_euclid(12)).rem_euclid(12),
            };
            // A month gone by keeps its step: "from march 2025" in step from then.
            if begin < here {
                begin += (here - begin + step - 1) / step * step;
            }
            let after = if begin > here {
                let first_day =
                    month_day(begin, &MonthDay::Date { day: 1 }).ok_or_else(unreadable)?;
                resolve(tz, first_day, 0, 0).ok_or_else(unreadable)? - 1
            } else {
                now
            };
            next_monthly(tz, months, &on, hour, minute, Some(begin), after.max(now))
        }
        (None, Some(phase)) => next_monthly(tz, months, &on, hour, minute, Some(phase), now),
        // No month named: the first is the next one, and the step counts from it.
        (None, None) => next_monthly(tz, 1, &on, hour, minute, None, now),
    }
    .ok_or_else(|| "That time doesn't exist.".to_string())?;
    let from = (months > 1)
        .then(|| local(tz, first).map(|t| month_index(t.date_naive())))
        .flatten();
    Ok((
        Repeat::Monthly {
            months,
            on,
            hour,
            minute,
            from,
        },
        first,
    ))
}

/// "Friday".
fn day_name(d: u8) -> String {
    let n = WEEKDAYS[d as usize % 7];
    n[..1].to_uppercase() + &n[1..]
}

fn parse_once<Tz: TimeZone>(s: &str, tz: &Tz, now: i64) -> Result<i64, String> {
    let fail = |why: &str| Err(format!("{why} {EXAMPLES}"));
    let today = local(tz, now)
        .ok_or("The clock is unreadable.")?
        .date_naive();

    // "in 2 hours", "in 3 days". Days and weeks keep the wall-clock time
    // ("in 3 days" at 9:00 is 9:00, even across a DST change).
    if let Some(rest) = s.strip_prefix("in ") {
        let Some((n, per)) = amount(rest) else {
            return fail(&format!("I can't read \"{rest}\" as an amount of time."));
        };
        if per < 24 * 60 {
            return Ok(now + n * per * MINUTE_MS);
        }
        let then = local(tz, now).ok_or("The clock is unreadable.")?;
        let date = today + Span::days(n * per / (24 * 60));
        return resolve(tz, date, then.hour_(), then.minute_())
            .ok_or_else(|| "That time doesn't exist.".to_string());
    }

    let Some((day_part, (hour, minute))) = split_at_time(s) else {
        return fail("Give it a day and a time.");
    };
    let day_part = day_part
        .trim_start_matches("on ")
        .trim_start_matches("next ")
        .trim_start_matches("this ")
        .trim();
    let at = |date: NaiveDate| {
        resolve(tz, date, hour, minute).ok_or_else(|| "That time doesn't exist.".to_string())
    };
    match day_part {
        "" | "today" | "tonight" => {
            let t = at(today)?;
            // A bare time that already went today means tomorrow.
            if t <= now && day_part.is_empty() {
                at(today + Span::days(1))
            } else {
                Ok(t)
            }
        }
        "tomorrow" => at(today + Span::days(1)),
        other => {
            if let Some(d) = weekday(other) {
                return next_on_days(tz, &[d], hour, minute, now)
                    .ok_or_else(|| "That time doesn't exist.".to_string());
            }
            match NaiveDate::parse_from_str(other.trim_end_matches('t'), "%Y-%m-%d") {
                Ok(date) => at(date),
                Err(_) => fail(&format!("I can't read \"{other}\" as a day.")),
            }
        }
    }
}

/// chrono's `Timelike` getters, without importing a trait named like a field.
trait HourMinute {
    fn hour_(&self) -> u32;
    fn minute_(&self) -> u32;
}
impl<Tz: TimeZone> HourMinute for DateTime<Tz> {
    fn hour_(&self) -> u32 {
        chrono::Timelike::hour(&self.naive_local())
    }
    fn minute_(&self) -> u32 {
        chrono::Timelike::minute(&self.naive_local())
    }
}

/* ------------------------------------------------------------- describe */

/// "9:00 AM" or "09:00", as this Mac shows times (`clock`). The grammar reads
/// both back, so what an agent quotes from here still parses.
fn clock_text(hour: u32, minute: u32) -> String {
    super::clock::hm(hour, minute)
}

/// "every weekday at 9:00 AM", "every Monday and Thursday at 08:30", "every 2 hours".
pub fn describe(repeat: &Repeat) -> String {
    match repeat {
        Repeat::Every { minutes } if minutes % 60 == 0 => match minutes / 60 {
            1 => "every hour".to_string(),
            h => format!("every {h} hours"),
        },
        Repeat::Every { minutes } => format!("every {minutes} minutes"),
        Repeat::Days { days, hour, minute } => {
            let at = clock_text(*hour, *minute);
            let named = match days.as_slice() {
                [0, 1, 2, 3, 4, 5, 6] => "day".to_string(),
                [1, 2, 3, 4, 5] => "weekday".to_string(),
                [0, 6] => "weekend day".to_string(),
                list => {
                    let names: Vec<String> = list
                        .iter()
                        .map(|d| {
                            let n = WEEKDAYS[*d as usize % 7];
                            n[..1].to_uppercase() + &n[1..]
                        })
                        .collect();
                    match names.split_last() {
                        Some((last, [])) => last.clone(),
                        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
                        None => String::new(),
                    }
                }
            };
            format!("every {named} at {at}")
        }
        Repeat::Monthly {
            months,
            on,
            hour,
            minute,
            from,
        } => {
            let every = match months {
                0 | 1 => "every month".to_string(),
                n => format!("every {n} months"),
            };
            // Which months, when it isn't all of them: "(Jan, Apr, Jul and Oct)".
            let which = match (from, *months) {
                (Some(from), n) if n > 1 && MAX_EVERY_MONTHS.is_multiple_of(n) => {
                    // In the calendar's order.
                    let mut in_year: Vec<usize> = (0..12 / n)
                        .map(|i| (from + (i * n) as i32).rem_euclid(12) as usize)
                        .collect();
                    in_year.sort_unstable();
                    let names: Vec<String> = in_year
                        .into_iter()
                        .map(|m| MONTHS[m][..1].to_uppercase() + &MONTHS[m][1..3])
                        .collect();
                    match names.split_last() {
                        Some((last, [])) => format!(" ({last})"),
                        Some((last, rest)) => format!(" ({} and {last})", rest.join(", ")),
                        None => String::new(),
                    }
                }
                (Some(from), n) if n > 1 => {
                    let m = MONTHS[from.rem_euclid(12) as usize];
                    format!(
                        ", from {}{} {}",
                        m[..1].to_uppercase(),
                        &m[1..3],
                        from.div_euclid(12)
                    )
                }
                _ => String::new(),
            };
            format!(
                "{every} on {} at {}{which}",
                describe_month_day(on),
                clock_text(*hour, *minute)
            )
        }
    }
}

/// "1st", "22nd", "13th".
pub fn ordinal_text(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// "the 1st", "the last day", "the second Tuesday", "the last Friday".
fn describe_month_day(on: &MonthDay) -> String {
    match *on {
        MonthDay::Date { day } if day < 0 => "the last day".to_string(),
        MonthDay::Date { day } => format!("the {}", ordinal_text(day.max(1) as u32)),
        MonthDay::Weekday { nth, weekday } => {
            let which = match nth {
                1 => "first",
                2 => "second",
                3 => "third",
                4 => "fourth",
                _ => "last",
            };
            format!("the {which} {}", day_name(weekday))
        }
    }
}

/// "Thu 5 Nov 2026, 09:00 (UTC-05:00)": exact, and unambiguous to an agent
/// that will repeat it to the user.
pub fn format_time<Tz: TimeZone>(tz: &Tz, ms: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match local(tz, ms) {
        Some(t) => format!(
            "{}, {} (UTC{})",
            t.format("%a %-d %b %Y"),
            super::clock::of(&t),
            t.format("%:z")
        ),
        None => ms.to_string(),
    }
}

/* ------------------------------------------------------- what's due now */

#[derive(Debug, Clone, PartialEq)]
pub enum Due {
    /// Run it now. `next` is when a routine fires after this; `None` for a
    /// one-time check-in, which is then removed.
    Fire { late: bool, next: Option<i64> },
    /// A failed run's retry is due (`agents::runs`); a routine's own next
    /// time doesn't move.
    Retry,
}

/// Whether a check-in is due at `now`, and what happens if so.
pub fn due<Tz: TimeZone>(tz: &Tz, check_in: &CheckIn, now: i64) -> Option<Due> {
    // A "When…" routine is checked by `agents::watch`, never fired by time.
    if check_in.paused || check_in.watch.is_some() {
        return None;
    }
    if let Some(retry) = &check_in.retry {
        // A routine whose own time has come runs that instead.
        if check_in.repeat.is_none() || check_in.next_at > now {
            return (retry.at <= now).then_some(Due::Retry);
        }
    }
    if check_in.next_at > now {
        return None;
    }
    let overdue = now - check_in.next_at;
    let late = overdue > LATE_AFTER_MS;
    let Some(repeat) = &check_in.repeat else {
        return Some(Due::Fire { late, next: None });
    };
    let mut next = advance(tz, repeat, check_in.next_at, now)?;
    // Missed for longer (the app was closed, the Mac asleep): it runs once
    // now, marked late, never once per time it missed. Should its next time
    // be only minutes off, that one is what this run stands in for.
    if overdue > ROUTINE_GRACE_MS && next - now < ROUTINE_GRACE_MS {
        next = advance(tz, repeat, next, next)?;
    }
    Some(Due::Fire {
        late,
        next: Some(next),
    })
}

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// The one check-in that fires this tick, most overdue first. Anything
    /// else due waits for a later tick: nothing due is ever skipped.
    pub fire: Option<Firing>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Firing {
    pub agent_id: String,
    pub check_in: CheckIn,
    pub late: bool,
    pub next: Option<i64>,
    /// The same agent's other one-time check-ins that were missed while the
    /// app was closed: folded into this wake and removed with it, so a
    /// reopened app wakes each agent once, not once per missed note.
    pub also: Vec<CheckIn>,
    /// Run now, from the schedule popover: on demand, ahead of its time.
    pub manual: bool,
    /// Trying a failed run again: how it has gone so far.
    pub retry: Option<runs::Retry>,
    /// It was due inside the user's quiet hours and waited for them to end
    /// (`quiet`): late for that reason, not because the app was closed.
    pub waited: bool,
}

impl Firing {
    /// When it was due to fire: its retry's time, or its own.
    fn due_at(&self) -> i64 {
        self.retry.as_ref().map_or(self.check_in.next_at, |r| r.at)
    }
}

pub fn plan<Tz: TimeZone>(tz: &Tz, agents: &[store::Agent], now: i64) -> Plan {
    plan_with(tz, agents, now, &|_| false)
}

/// [`plan`], leaving out the check-ins `waits` holds back (inside quiet
/// hours, `quiet::fires_anyway` says which don't): they stay due, and fire
/// once when it lets them.
pub fn plan_with<Tz: TimeZone>(
    tz: &Tz,
    agents: &[store::Agent],
    now: i64,
    waits: &dyn Fn(&CheckIn) -> bool,
) -> Plan {
    let mut plan = Plan::default();
    for agent in agents {
        for check_in in agent.check_ins.iter().filter(|c| !waits(c)) {
            match due(tz, check_in, now) {
                None => {}
                Some(Due::Retry) => {
                    let retry = check_in.retry.clone();
                    let at = retry.as_ref().map_or(check_in.next_at, |r| r.at);
                    if plan.fire.as_ref().is_none_or(|f| at < f.due_at()) {
                        plan.fire = Some(Firing {
                            agent_id: agent.id.clone(),
                            check_in: check_in.clone(),
                            late: false,
                            next: check_in.repeat.as_ref().map(|_| check_in.next_at),
                            also: Vec::new(),
                            manual: false,
                            retry,
                            waited: false,
                        });
                    }
                }
                Some(Due::Fire { late, next }) => {
                    let older = plan
                        .fire
                        .as_ref()
                        .is_none_or(|f| check_in.next_at < f.due_at());
                    if older {
                        let also = if late && next.is_none() {
                            agent
                                .check_ins
                                .iter()
                                .filter(|c| {
                                    c.id != check_in.id && c.repeat.is_none() && c.watch.is_none()
                                })
                                .filter(|c| !c.paused && c.retry.is_none() && !waits(c))
                                .filter(|c| now - c.next_at > LATE_AFTER_MS)
                                .cloned()
                                .collect()
                        } else {
                            Vec::new()
                        };
                        plan.fire = Some(Firing {
                            agent_id: agent.id.clone(),
                            check_in: check_in.clone(),
                            late,
                            next,
                            also,
                            manual: false,
                            retry: None,
                            waited: false,
                        });
                    }
                }
            }
        }
    }
    plan
}

/// What a check-in replies, alone, when nothing changed and nothing needs
/// the user: the app posts nothing for it (`runner`), rather than a line an
/// hour that buries what the agent is actually waiting on.
pub const NOTHING_NEW: &str = "[nothing new]";

/// Whether a reply is [`NOTHING_NEW`] (any case, a stray period or quotes),
/// or opens or ends with the bracketed marker: the words around it only
/// explain the silence. Observed: "It's 23:33, inside quiet hours, so I'm
/// sending nothing. … [nothing new]" posted in the owner's chat at night.
pub fn is_nothing_new(text: &str) -> bool {
    let t = text
        .trim()
        .trim_matches(|c: char| c == '.' || c == '`' || c == '"' || c.is_whitespace())
        .to_ascii_lowercase();
    t == NOTHING_NEW || t == "nothing new" || t.ends_with(NOTHING_NEW) || t.starts_with(NOTHING_NEW)
}

/// The questions the agent put to the user that are still unanswered: its
/// lines asking something (ending in "?") since the user last wrote, newest
/// last, at most three. A check-in is told them, so a routine that has
/// nothing new doesn't bury them under a fresh post, and one that has
/// something new keeps them in view.
pub fn open_questions(log: &[store::AgentMessage]) -> Vec<String> {
    let since = log
        .iter()
        .rposition(|m| m.kind == MessageKind::User)
        .map_or(0, |i| i + 1);
    let mut out: Vec<String> = log[since..]
        .iter()
        .filter(|m| m.kind == MessageKind::Agent && m.room.is_none())
        .flat_map(|m| {
            m.text
                .lines()
                .map(str::trim)
                .filter(|l| l.ends_with('?'))
                .map(|l| {
                    l.trim_start_matches(['-', '*', ' '])
                        .chars()
                        .take(200)
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
        })
        .collect();
    out.dedup();
    let skip = out.len().saturating_sub(3);
    out.drain(..skip);
    out
}

/// How a check-in decides. Observed (2026-11-06, an hourly "Agent sweep"
/// at Full send): its posts handed decisions back ("that's your call",
/// "pick one, my recommendation is…") on things it could have just done.
pub const SWEEP: &str = "Anything reversible your level covers, decide and do now; never ask the user's opinion on a reversible choice (no \"your call\", no \"pick one\"): pick, act, say what you chose. Surface only what's truly blocked on them or on the floor (money, credentials, deleting for good, production), each with the one thing it needs.";

/// What the agent is woken with.
pub fn wake_prompt<Tz: TimeZone>(tz: &Tz, firing: &Firing, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    wake_prompt_with(tz, firing, now, &[])
}

/// [`wake_prompt`], with the questions still waiting on the user
/// ([`open_questions`]).
pub fn wake_prompt_with<Tz: TimeZone>(tz: &Tz, firing: &Firing, now: i64, open: &[String]) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let c = &firing.check_in;
    let late = if firing.manual {
        " The user asked you to run it now, ahead of its time; its schedule is unchanged."
            .to_string()
    } else if let Some(r) = &firing.retry {
        format!(
            " It was due {} and didn't finish then, so this is try {}.",
            format_time(tz, r.due_at),
            r.attempts + 1
        )
    } else if firing.waited {
        format!(
            " It was due {}, inside the user's quiet hours, so it waited until they ended.",
            format_time(tz, c.next_at)
        )
    } else if firing.late {
        format!(
            " It was due {}, but the app wasn't running then, so it's late.",
            format_time(tz, c.next_at)
        )
    } else {
        String::new()
    };
    let repeats = match &c.repeat {
        Some(r) => format!(
            " This is a routine ({}); cancel_check_in with id {} stops it if it's no longer useful.",
            describe(r),
            c.id
        ),
        None => String::new(),
    };
    let also: String = firing
        .also
        .iter()
        .map(|o| {
            format!(
                "\n[Also missed, due {}: {}]",
                format_time(tz, o.next_at),
                o.note
            )
        })
        .collect();
    let waiting = match open {
        [] => String::new(),
        qs => format!(
            "\n\n[Still waiting on the user, asked earlier: {}. A reversible choice your level covers isn't theirs: decide it now and say what you chose. One truly blocked on them stays in view: if what you find bears on it, say so.]",
            qs.iter().map(|q| format!("“{q}”")).collect::<Vec<_>>().join(", ")
        ),
    };
    if c.follow_up {
        return format!(
            "[A follow-up the app recorded, not the user: your reply said {}, and the turn ended without doing it.]{waiting}\n\n[It's now {}.{late} Do it now, in full, then tell the user in a few lines what you found or did. If it's already done or no longer wanted, reply with exactly {NOTHING_NEW} and nothing else.]",
            c.note,
            format_time(tz, now)
        );
    }
    if !c.then.is_empty() {
        // A routine in steps: the first only, and always something to show.
        return format!(
            "[Scheduled routine you set, step 1: {}]{also}{waiting}\n\n[It's now {}.{late}{repeats} Do what the note says. {SWEEP}]{}",
            c.note,
            format_time(tz, now),
            super::routine_steps::first_step_context(c)
        );
    }
    format!(
        "[Scheduled check-in you set: {}]{also}{waiting}\n\n[It's now {}.{late}{repeats} Do what the note says. {SWEEP} Then tell the user in a few lines what you did and what's left. If nothing changed since your last check-in and nothing needs them, reply with exactly {NOTHING_NEW} and nothing else: no post goes in their chat.]",
        c.note,
        format_time(tz, now)
    )
}

/* ------------------------------------------------------ store + tools */

pub struct Created {
    pub check_in: CheckIn,
    pub summary: String,
}

/// Why a check-in wasn't added.
#[derive(Debug)]
pub enum Refused {
    /// The phrase or the note can't be used. `why` is written for the agent
    /// (it ends with example phrases); [`Refused::plain`] drops those.
    Invalid {
        field: &'static str,
        why: String,
    },
    Full,
    /// The same note on the same schedule is already there.
    Duplicate,
    Store(CommandError),
}

impl Refused {
    pub fn into_error(self) -> CommandError {
        match self {
            Refused::Invalid { field, why } => super::err_invalid(field, why),
            Refused::Full => CommandError::expected(format!(
                "You already have {MAX_PER_AGENT} check-ins. Cancel one you don't need first (list_check_ins)."
            )),
            Refused::Duplicate => CommandError::expected(
                "That check-in is already scheduled. list_check_ins shows it.",
            ),
            Refused::Store(e) => e,
        }
    }

    /// The reason in a sentence for the user, without the agent-facing examples.
    pub fn plain(&self) -> String {
        match self {
            Refused::Invalid { why, .. } => plain_reason(why),
            Refused::Full => {
                format!("the agent already has {MAX_PER_AGENT} routines.")
            }
            Refused::Duplicate => "it's already set.".into(),
            Refused::Store(e) => e.to_string(),
        }
    }
}

/// A parse error without the trailing list of example phrases.
pub fn plain_reason(why: &str) -> String {
    why.strip_suffix(EXAMPLES).unwrap_or(why).trim().to_string()
}

/// Check a phrase and a note without storing anything: the repeat (if any)
/// and the first time it fires, or why it can't be used.
pub fn check<Tz: TimeZone>(
    tz: &Tz,
    when: &str,
    note: &str,
    now: i64,
) -> Result<(Option<Repeat>, i64), Refused> {
    check_note(note)?;
    parse(when, tz, now).map_err(|why| Refused::Invalid { field: "when", why })
}

/// A check-in's note: something to do, and not an essay.
fn check_note(note: &str) -> Result<(), Refused> {
    let note = note.trim();
    let invalid = |why: &str| Refused::Invalid {
        field: "note",
        why: why.to_string(),
    };
    if note.is_empty() {
        return Err(invalid(
            "Write a note to yourself saying what to do when it fires.",
        ));
    }
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(invalid("Keep the note under 600 characters."));
    }
    Ok(())
}

/// What a check-in is, for the user: "every weekday at 09:00", or "once, Fri 6 Nov 2026, 09:00 (UTC-05:00)".
pub fn describe_schedule<Tz: TimeZone>(tz: &Tz, repeat: Option<&Repeat>, next_at: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match repeat {
        Some(r) => describe(r),
        None => format!("once, {}", format_time(tz, next_at)),
    }
}

/// Add a check-in to an agent. The returned summary is what the tool says
/// back: the exact resolved time, so the agent tells the user something true.
pub fn create(agent_id: &str, when: &str, note: &str) -> Result<Created, CommandError> {
    create_with_steps(agent_id, when, note, &[])
}

/// [`create`], with steps after the first (`agents::routine_steps`).
pub fn create_with_steps(
    agent_id: &str,
    when: &str,
    note: &str,
    then: &[super::routine_steps::Step],
) -> Result<Created, CommandError> {
    let then = super::routine_steps::check(then).map_err(|why| super::err_invalid("then", why))?;
    let mut created = create_in(&chrono::Local, agent_id, when, note, store::now_ms())
        .map_err(Refused::into_error)?;
    if then.is_empty() {
        return Ok(created);
    }
    let id = created.check_in.id.clone();
    store::update(agent_id, |a| {
        if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == id) {
            c.then = then.clone();
        }
    })?;
    created.check_in.then = then.clone();
    let steps = super::routine_steps::total(&created.check_in);
    let asks = then.iter().filter(|s| s.ask_first).count();
    created.summary.push_str(&format!(
        " It runs in {steps} steps, one turn each{}.",
        match asks {
            0 => String::new(),
            1 => ", and waits for the user's OK on a card before the step marked so".to_string(),
            n => format!(
                ", and waits for the user's OK on a card before each of the {n} steps marked so"
            ),
        }
    ));
    Ok(created)
}

pub(crate) fn create_in<Tz: TimeZone>(
    tz: &Tz,
    agent_id: &str,
    when: &str,
    note: &str,
    now: i64,
) -> Result<Created, Refused>
where
    Tz::Offset: std::fmt::Display,
{
    let (repeat, next_at) = check(tz, when, note, now)?;
    let check_in = CheckIn {
        id: store::new_id()[..8].to_string(),
        note: note.trim().to_string(),
        repeat,
        next_at,
        created_at: now,
        paused: false,
        paused_on_import: false,
        runs: Vec::new(),
        retry: None,
        watch: None,
        usage: Default::default(),
        follow_up: false,
        then: Vec::new(),
        waiting: None,
        extra: Default::default(),
    };
    let mut refused: Option<Refused> = None;
    let candidate = check_in.clone();
    store::update(agent_id, |agent| {
        if agent.check_ins.iter().any(|c| same_schedule(c, &candidate)) {
            refused = Some(Refused::Duplicate);
            return;
        }
        if agent.check_ins.len() >= MAX_PER_AGENT {
            refused = Some(Refused::Full);
            return;
        }
        agent.check_ins.push(candidate);
    })
    .map_err(Refused::Store)?;
    if let Some(err) = refused {
        return Err(err);
    }
    // It runs in the conversation it was set up in.
    super::conversations::note_routine(agent_id, &check_in.id);
    let when_text = format_time(tz, check_in.next_at);
    let summary = match &check_in.repeat {
        None => format!(
            "Scheduled for {when_text}, your user's local time (id {}). It fires only while the app is open on this Mac; if it's closed then, it runs as soon as the app reopens, marked late. Tell the user the time.",
            check_in.id
        ),
        Some(r) => format!(
            "Routine set: {}, your user's local time. First run {when_text} (id {}). It runs only while the app is open on this Mac; if it's closed then, the routine runs once when it reopens, marked late (never once for each time it missed). Tell the user exactly this.",
            describe(r),
            check_in.id
        ),
    };
    Ok(Created { check_in, summary })
}

/// Two entries that would do the same thing at the same times.
pub(crate) fn same_schedule(a: &CheckIn, b: &CheckIn) -> bool {
    let source = |c: &CheckIn| c.watch.as_ref().map(|w| w.source.clone());
    if a.watch.is_some() || b.watch.is_some() {
        return a.note == b.note && source(a) == source(b);
    }
    a.note == b.note && a.repeat == b.repeat && (a.repeat.is_some() || a.next_at == b.next_at)
}

/// Change when and what, in place: same id, paused stays paused. `when` is
/// re-read from now, so an edited routine's next time is its next one.
pub fn edit(agent_id: &str, id: &str, when: &str, note: &str) -> Result<CheckIn, CommandError> {
    edit_in(&chrono::Local, agent_id, id, when, note, store::now_ms())
}

/// [`edit`], and its steps after the first: `None` keeps them as they are.
pub fn edit_with_steps(
    agent_id: &str,
    id: &str,
    when: &str,
    note: &str,
    then: Option<&[super::routine_steps::Step]>,
) -> Result<CheckIn, CommandError> {
    let then = then
        .map(super::routine_steps::check)
        .transpose()
        .map_err(|why| super::err_invalid("then", why))?;
    if let Some(steps) = then.as_ref().filter(|s| !s.is_empty()) {
        let agent = store::get(agent_id)?;
        if agent
            .check_ins
            .iter()
            .any(|c| c.id == id && c.watch.is_some())
        {
            return Err(CommandError::expected(
                "A “When…” routine runs in one step. Make the rest a routine of its own.",
            ));
        }
        let _ = steps;
    }
    let mut edited = edit_in(&chrono::Local, agent_id, id, when, note, store::now_ms())?;
    if let Some(steps) = then {
        store::update(agent_id, |a| {
            if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == id) {
                c.then = steps.clone();
            }
        })?;
        edited.then = steps;
    }
    Ok(edited)
}

/// An empty `when` keeps the schedule as it is and changes only the note:
/// the phone sends `when` only when its picker changed it, so editing a
/// note neither re-anchors "every 2 hours" nor moves a one-off by the
/// difference between the phone's clock and this Mac's.
fn edit_in<Tz: TimeZone>(
    tz: &Tz,
    agent_id: &str,
    id: &str,
    when: &str,
    note: &str,
    now: i64,
) -> Result<CheckIn, CommandError> {
    let schedule = if when.trim().is_empty() {
        check_note(note).map_err(Refused::into_error)?;
        None
    } else {
        Some(check(tz, when, note, now).map_err(Refused::into_error)?)
    };
    let note = note.trim();
    let mut outcome: Result<CheckIn, CommandError> =
        Err(CommandError::expected("That routine no longer exists."));
    store::update(agent_id, |agent| {
        let Some(i) = agent.check_ins.iter().position(|c| c.id == id) else {
            return;
        };
        let current = agent.check_ins[i].clone();
        if current.watch.is_some() && schedule.is_some() {
            outcome = Err(CommandError::expected(
                "That routine starts when something happens, not at a time. Change what it waits for in its When… settings.",
            ));
            return;
        }
        let edited = match &schedule {
            Some((repeat, next_at)) => CheckIn {
                note: note.to_string(),
                repeat: repeat.clone(),
                next_at: *next_at,
                // A pending retry was for when it used to run.
                retry: None,
                ..current
            },
            // Same schedule, so a pending retry of it still stands.
            None => CheckIn {
                note: note.to_string(),
                ..current
            },
        };
        let clash = agent
            .check_ins
            .iter()
            .any(|c| c.id != id && same_schedule(c, &edited));
        if clash {
            outcome = Err(CommandError::expected("That routine is already scheduled."));
            return;
        }
        agent.check_ins[i] = edited.clone();
        outcome = Ok(edited);
    })?;
    outcome
}

/// Fire one now, as a normal wake, without touching its next time. A
/// one-time check-in stays scheduled too: this is a rehearsal, not a skip.
pub fn run_now(app: &AppHandle, agent_id: &str, id: &str) -> Result<(), CommandError> {
    let agent = store::get(agent_id)?;
    if agent
        .check_ins
        .iter()
        .any(|c| c.id == id && c.watch.is_some())
    {
        // "Run now" on a "When…" routine is "Check now": it runs only if
        // something new is there.
        let (app, agent_id, id) = (app.clone(), agent_id.to_string(), id.to_string());
        tauri::async_runtime::spawn(async move {
            let _ = super::watch::check_now(&app, &agent_id, &id).await;
        });
        return Ok(());
    }
    let firing = manual_firing(&agent, id)?;
    let now = store::now_ms();
    store::update(agent_id, |a| {
        if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == id) {
            runs::record(&mut c.runs, running(&firing, now));
        }
    })?;
    wake(app, &chrono::Local, &firing, now)
}

/// The history row a firing starts as.
fn running(firing: &Firing, now: i64) -> runs::Run {
    runs::Run {
        at: now,
        outcome: runs::Outcome::Running,
        attempt: firing.retry.as_ref().map_or(1, |r| r.attempts + 1),
        detail: None,
        retry_at: None,
        sign_in: Vec::new(),
        manual: firing.manual,
        step: if firing.check_in.then.is_empty() {
            0
        } else {
            1
        },
    }
}

fn manual_firing(agent: &store::Agent, id: &str) -> Result<Firing, CommandError> {
    let check_in = agent
        .check_ins
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| CommandError::expected("That routine no longer exists."))?;
    Ok(Firing {
        agent_id: agent.id.clone(),
        check_in,
        late: false,
        next: None,
        also: Vec::new(),
        manual: true,
        retry: None,
        waited: false,
    })
}

/// The tool's answer to `list_check_ins`.
pub fn list_text(agent: &store::Agent) -> String {
    if agent.check_ins.is_empty() {
        return "Nothing scheduled.".to_string();
    }
    let tz = chrono::Local;
    agent
        .check_ins
        .iter()
        .map(|c| {
            let when = match (&c.watch, &c.repeat) {
                (Some(w), _) => super::watch::list_line(w),
                (None, Some(r)) => format!("{}, next {}", describe(r), format_time(&tz, c.next_at)),
                (None, None) => format_time(&tz, c.next_at),
            };
            let paused = match (c.paused, c.paused_on_import) {
                (true, true) => " [paused by the import, until the user turns it on]",
                (true, false) => " [paused by the user]",
                _ => "",
            };
            format!("- {} · {when}{paused}: {}", c.id, c.note)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Remove one. Errors if it doesn't exist (the agent should know).
pub fn cancel(agent_id: &str, id: &str) -> Result<CheckIn, CommandError> {
    let id = id.trim();
    let mut removed = None;
    store::update(agent_id, |agent| {
        if let Some(i) = agent.check_ins.iter().position(|c| c.id == id) {
            removed = Some(agent.check_ins.remove(i));
        }
    })?;
    removed.ok_or_else(|| {
        CommandError::expected(format!(
            "There's no check-in with id {id}. list_check_ins shows what's scheduled."
        ))
    })
}

/// Pause or resume. A resumed routine picks up at its next time from now
/// rather than firing for what it missed while paused.
pub fn set_paused(agent_id: &str, id: &str, paused: bool) -> Result<(), CommandError> {
    let now = store::now_ms();
    let tz = chrono::Local;
    let mut found = false;
    store::update(agent_id, |agent| {
        if let Some(c) = agent.check_ins.iter_mut().find(|c| c.id == id) {
            found = true;
            if c.watch.is_some() {
                if c.paused && !paused {
                    if let Some(w) = c.watch.as_mut() {
                        super::watch::resumed(w);
                    }
                    c.next_at = now;
                }
            } else if c.paused && !paused && c.next_at <= now {
                if let Some(r) = &c.repeat {
                    if let Some(next) = advance(&tz, r, c.next_at, now) {
                        c.next_at = next;
                    }
                }
            }
            c.paused = paused;
            c.paused_on_import = false;
        }
    })?;
    if found {
        Ok(())
    } else {
        Err(CommandError::expected("That routine no longer exists."))
    }
}

/* ------------------------------------------------------------- the tick */

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let now = store::now_ms();
        for agent in store::list().unwrap_or_default() {
            if agent
                .check_ins
                .iter()
                .any(|c| !c.runs.is_empty() || c.retry.is_some())
            {
                let _ = store::update(&agent.id, |a| {
                    runs::after_restart(&mut a.check_ins, now);
                });
            }
        }
        tokio::time::sleep(STARTUP_GRACE).await;
        loop {
            // A panic in one tick is caught: routines keep firing.
            if let Some(Err(err)) = super::survive::tick_blocking("schedule", || tick(&app)) {
                tracing::warn!(error = %err, "agent check-in tick failed");
            }
            super::survive::flush(&app);
            // On the minute, with the other minute loops (one wake-up).
            crate::power::sleep_aligned(TICK).await;
        }
    });
}

/// One tick, now. For the end-to-end suite (`examples/agents_e2e`), which
/// can't wait a minute between ticks; the app only ever ticks from [`spawn`].
#[doc(hidden)]
pub fn tick_once(app: &AppHandle) -> Result<(), CommandError> {
    tick(app)
}

fn tick(app: &AppHandle) -> Result<(), CommandError> {
    let tz = chrono::Local;
    let now = store::now_ms();
    let agents = store::list()?;
    // Quiet hours: scheduled work waits for them to end, unless the user
    // set its time inside them (`quiet`). What they held is released here.
    let quiet = super::quiet::get();
    let holding = super::quiet::holding_now();
    let waits = |c: &CheckIn| super::quiet::waits(c, quiet.as_ref(), holding);
    let mut plan = plan_with(&tz, &agents, now, &waits);
    if let (Some(f), Some(w)) = (plan.fire.as_mut(), quiet.as_ref()) {
        f.waited = f.late && f.retry.is_none() && w.contains(&tz, f.check_in.next_at);
    }
    super::notify::release_quiet(app);
    let changed = plan.fire.is_some();

    if let Some(firing) = plan.fire.filter(|f| !skip_while_driven(app, f)) {
        // Move it on before waking anyone, so a crash mid-turn can't fire it twice.
        store::update(&firing.agent_id, |a| match firing.next {
            Some(next) => {
                if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == firing.check_in.id) {
                    c.next_at = next;
                    // Its own time came round with a retry still pending: that retry is moot.
                    if c.retry.take().is_some() && firing.retry.is_none() {
                        runs::superseded(&mut c.runs);
                    }
                    runs::record(&mut c.runs, running(&firing, now));
                }
            }
            None => a.check_ins.retain(|c| {
                c.id != firing.check_in.id && !firing.also.iter().any(|o| o.id == c.id)
            }),
        })?;
        wake(app, &tz, &firing, now)?;
    }
    if changed {
        let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    }
    // "Use it all before reset": capacity about to expire wakes the Chief.
    super::usage_tools::maybe_nudge(app);
    // The morning brief: prepared ahead, posted at the user's time (`brief`).
    super::brief::tick(app);
    Ok(())
}

/// A routine coming due while the user drives its agent's session
/// (`takeover`) doesn't run: it moves on to its next time, with a note in
/// the chat and in its past runs. A one-time check-in isn't skipped; it
/// waits in the queue like a message and runs once the agent is handed back.
/// True when `firing` was skipped.
fn skip_while_driven(app: &AppHandle, firing: &Firing) -> bool {
    if firing.manual || firing.check_in.repeat.is_none() || !runner::driven(&firing.agent_id) {
        return false;
    }
    let now = store::now_ms();
    let name = store::get(&firing.agent_id)
        .map(|a| a.name)
        .unwrap_or_default();
    let detail = format!("Skipped: you were driving {name} in a terminal.");
    let updated = store::update(&firing.agent_id, |a| {
        if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == firing.check_in.id) {
            if let Some(next) = firing.next {
                c.next_at = next;
            }
            if c.retry.take().is_some() {
                runs::superseded(&mut c.runs);
            }
            runs::record(&mut c.runs, skipped_run(firing, now, detail.clone()));
        }
    });
    if updated.is_err() {
        // Not moved on: firing it is better than skipping it every tick.
        return false;
    }
    let line = runner::new_message(
        &firing.agent_id,
        MessageKind::Note,
        skipped_line(&firing.check_in.note, &name),
    );
    let _ = runner::record(app, line);
    tracing::info!(agent = %firing.agent_id, check_in = %firing.check_in.id, "routine skipped: taken over");
    true
}

fn skipped_run(firing: &Firing, now: i64, detail: String) -> runs::Run {
    runs::Run {
        outcome: runs::Outcome::Skipped,
        detail: Some(detail),
        ..running(firing, now)
    }
}

/// "Skipped “Morning brief” · you were driving Finance".
fn skipped_line(note: &str, name: &str) -> String {
    let mut what: String = note
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(60)
        .collect();
    if what.chars().count() < note.trim().chars().count() {
        what.push('…');
    }
    format!("Skipped “{what}” · you were driving {name}")
}

/// Queue the turn and leave the "Scheduled check-in" line above its answer.
fn wake<Tz: TimeZone>(
    app: &AppHandle,
    tz: &Tz,
    firing: &Firing,
    now: i64,
) -> Result<(), CommandError>
where
    Tz::Offset: std::fmt::Display,
{
    // A run still waiting on the user's OK closes: this run replaces it.
    if firing.check_in.waiting.is_some() {
        super::routine_steps::superseded(app, &firing.agent_id, &firing.check_in.id);
    }
    let note = std::iter::once(&firing.check_in)
        .chain(&firing.also)
        .map(|c| c.note.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut line = runner::new_message(&firing.agent_id, MessageKind::CheckIn, note);
    line.check_in = Some(CheckInMark {
        due_at: if firing.manual {
            now
        } else {
            firing.check_in.next_at
        },
        late: firing.late,
        repeats: firing.check_in.repeat.is_some(),
        manual: firing.manual,
        found: None,
    });
    // Wake first, then record the line: recorded during the turn, it goes
    // through `runner::record` like a reply (a `wants_user` kind), so the
    // notifications slice posts one banner for the check-in and its
    // answer when the turn ends, rather than one for each.
    let open = store::messages(&firing.agent_id, 40)
        .map(|log| open_questions(&log))
        .unwrap_or_default();
    let mut prompt = wake_prompt_with(tz, firing, now, &open);
    // It remembers quiet hours the app doesn't have: it sets them (`quiet`).
    let memory = store::agent_home(&firing.agent_id)
        .ok()
        .and_then(|h| std::fs::read_to_string(h.join("CLAUDE.md")).ok())
        .unwrap_or_default();
    if let Some(hint) = super::quiet::memory_hint(&memory, super::quiet::get().as_ref()) {
        prompt.push_str(hint);
    }
    // Before the wake, so even the quickest turn finds its ticket.
    let ticket = store::new_id();
    runs::issue(runs::Ticket {
        id: ticket.clone(),
        agent_id: firing.agent_id.clone(),
        prompt: prompt.clone(),
        check_ins: std::iter::once(&firing.check_in)
            .chain(&firing.also)
            .cloned()
            .collect(),
        fired_at: now,
        attempt: firing.retry.as_ref().map_or(1, |r| r.attempts + 1),
        first_failed_at: firing.retry.as_ref().map(|r| r.first_failed_at),
        due_at: firing
            .retry
            .as_ref()
            .map_or(firing.check_in.next_at, |r| r.due_at),
        manual: firing.manual,
        step: 1,
        row_at: now,
    });
    let routine = firing.check_in.repeat.is_some();
    // In the conversation it was set up in, line and turn alike.
    let conversation = super::conversations::routine_in(&firing.agent_id, &firing.check_in.id);
    line.conversation = Some(conversation.clone());
    runner::enqueue_scheduled_in(
        app,
        &firing.agent_id,
        prompt,
        routine,
        ticket,
        Some(conversation),
    );
    runner::record(app, line).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, NaiveDate, Offset};

    /// A routine file saying `every 0 minutes` (hand-edited, or an old or
    /// foreign writer) used to divide by zero on every tick.
    #[test]
    fn a_zero_interval_on_disk_never_panics() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let next = advance(&utc, &Repeat::Every { minutes: 0 }, 0, 10 * MINUTE_MS).unwrap();
        assert_eq!(next, MIN_EVERY_MINUTES as i64 * MINUTE_MS);
    }

    #[test]
    fn a_routine_skipped_while_driven_says_which_and_why() {
        assert_eq!(
            skipped_line("Morning brief\nwith the calendar", "Finance"),
            "Skipped “Morning brief…” · you were driving Finance"
        );
        assert_eq!(
            skipped_line("Triage email", "Inbox"),
            "Skipped “Triage email” · you were driving Inbox"
        );
        let long = "x".repeat(80);
        assert!(skipped_line(&long, "A").contains(&format!("{}…", "x".repeat(60))));
    }

    /// US Eastern for 2026, by hand (chrono has no tz database here):
    /// EDT (UTC-4) from Sun 8 Mar 02:00 local to Sun 1 Nov 02:00 local.
    #[derive(Debug, Clone, Copy)]
    pub(super) struct Eastern;

    fn est() -> FixedOffset {
        FixedOffset::west_opt(5 * 3600).unwrap()
    }
    fn edt() -> FixedOffset {
        FixedOffset::west_opt(4 * 3600).unwrap()
    }
    fn dst_start_utc() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(7, 0, 0)
            .unwrap()
    }
    fn dst_end_utc() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 1)
            .unwrap()
            .and_hms_opt(6, 0, 0)
            .unwrap()
    }

    impl TimeZone for Eastern {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            Eastern
        }
        fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<FixedOffset> {
            let as_est = *local + Span::hours(5);
            let as_edt = *local + Span::hours(4);
            let est_ok = self.offset_from_utc_datetime(&as_est) == est();
            let edt_ok = self.offset_from_utc_datetime(&as_edt) == edt();
            match (edt_ok, est_ok) {
                (true, true) => LocalResult::Ambiguous(edt(), est()),
                (true, false) => LocalResult::Single(edt()),
                (false, true) => LocalResult::Single(est()),
                (false, false) => LocalResult::None,
            }
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            if *utc >= dst_start_utc() && *utc < dst_end_utc() {
                edt()
            } else {
                est()
            }
        }
    }

    pub(super) fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        resolve(&Eastern, NaiveDate::from_ymd_opt(y, mo, d).unwrap(), h, mi).unwrap()
    }
    pub(super) fn show(ms: i64) -> String {
        Eastern
            .timestamp_millis_opt(ms)
            .unwrap()
            .format("%a %Y-%m-%d %H:%M %:z")
            .to_string()
    }
    /// Tue 3 Nov 2026, 15:00 Eastern.
    pub(super) fn now() -> i64 {
        at(2026, 11, 3, 15, 0)
    }
    fn once(when: &str) -> String {
        let (repeat, next) = parse(when, &Eastern, now()).unwrap();
        assert!(repeat.is_none(), "{when} should be one-time");
        show(next)
    }

    #[test]
    fn the_test_zone_really_has_dst() {
        assert_eq!(
            Eastern.offset_from_utc_datetime(&dst_start_utc()).fix(),
            edt()
        );
        assert_eq!(show(at(2026, 7, 1, 9, 0)), "Wed 2026-07-01 09:00 -04:00");
        assert_eq!(show(at(2026, 12, 1, 9, 0)), "Tue 2026-12-01 09:00 -05:00");
    }

    #[test]
    fn one_time_phrases_resolve_to_exact_local_times() {
        assert_eq!(once("tomorrow at 9:00"), "Wed 2026-11-04 09:00 -05:00");
        assert_eq!(once("Tomorrow 9am"), "Wed 2026-11-04 09:00 -05:00");
        assert_eq!(once("friday at 2:30pm"), "Fri 2026-11-06 14:30 -05:00");
        assert_eq!(once("on Thursday at 17:00"), "Thu 2026-11-05 17:00 -05:00");
        assert_eq!(once("next monday 08:15"), "Mon 2026-11-09 08:15 -05:00");
        assert_eq!(once("2026-11-20 09:00"), "Fri 2026-11-20 09:00 -05:00");
        assert_eq!(once("today at 6pm"), "Tue 2026-11-03 18:00 -05:00");
        assert_eq!(once("in 2 hours"), "Tue 2026-11-03 17:00 -05:00");
        assert_eq!(once("in 90 minutes"), "Tue 2026-11-03 16:30 -05:00");
        assert_eq!(once("in an hour"), "Tue 2026-11-03 16:00 -05:00");
        assert_eq!(once("in 3 days"), "Fri 2026-11-06 15:00 -05:00");
        // A bare time that already went today means tomorrow.
        assert_eq!(once("9:00"), "Wed 2026-11-04 09:00 -05:00");
        // The same weekday as today, later today, is today.
        assert_eq!(once("tuesday at 16:00"), "Tue 2026-11-03 16:00 -05:00");
        assert_eq!(once("tuesday at 10:00"), "Tue 2026-11-10 10:00 -05:00");
        assert_eq!(once("tomorrow at noon"), "Wed 2026-11-04 12:00 -05:00");
        assert_eq!(once("tomorrow at 12am"), "Wed 2026-11-04 00:00 -05:00");
    }

    #[test]
    fn recurring_phrases_parse_into_routines() {
        let r = |w: &str| parse(w, &Eastern, now()).unwrap().0.unwrap();
        assert_eq!(
            r("every weekday at 9:00"),
            Repeat::Days {
                days: vec![1, 2, 3, 4, 5],
                hour: 9,
                minute: 0
            }
        );
        assert_eq!(
            r("Every Monday at 8am"),
            Repeat::Days {
                days: vec![1],
                hour: 8,
                minute: 0
            }
        );
        assert_eq!(
            r("every mon, thu and fri at 17:30"),
            Repeat::Days {
                days: vec![1, 4, 5],
                hour: 17,
                minute: 30
            }
        );
        assert_eq!(
            r("every mondays at 9"),
            Repeat::Days {
                days: vec![1],
                hour: 9,
                minute: 0
            }
        );
        assert_eq!(
            r("daily at 07:45"),
            Repeat::Days {
                days: (0..7).collect(),
                hour: 7,
                minute: 45
            }
        );
        assert_eq!(r("every 2 hours"), Repeat::Every { minutes: 120 });
        assert_eq!(r("every hour"), Repeat::Every { minutes: 60 });
        assert_eq!(r("every 45 minutes"), Repeat::Every { minutes: 45 });
    }

    #[test]
    fn the_grammar_refuses_what_it_cant_mean() {
        for bad in [
            "",
            "soon",
            "yesterday at 9",
            "tomorrow",
            "every day",
            "every monday",
            "every 5 minutes",
            "every 2 days",
            "every blursday at 9",
            "tomorrow at 25:00",
            "tomorrow at 13pm",
            "today at 9:00",
            "2025-01-01 09:00",
            "2028-01-01 09:00",
            "in 0 minutes",
        ] {
            let result = parse(bad, &Eastern, now());
            assert!(result.is_err(), "{bad:?} parsed as {result:?}");
        }
        // And the error teaches the agent the shapes that work.
        assert!(parse("soon", &Eastern, now())
            .unwrap_err()
            .contains("every weekday at 9:00"));
    }

    #[test]
    fn describes_routines_the_way_a_person_would() {
        // A Mac set to a 24-hour clock; `reads_twelve_hour_and_round_trips` has the other.
        crate::agents::clock::test_hour24(true);
        let d = |w: &str| describe(&parse(w, &Eastern, now()).unwrap().0.unwrap());
        assert_eq!(d("every weekday at 9:00"), "every weekday at 09:00");
        assert_eq!(d("every day at 9"), "every day at 09:00");
        assert_eq!(d("every sat, sun at 10"), "every weekend day at 10:00");
        assert_eq!(
            d("every mon and thu at 8:30"),
            "every Monday and Thursday at 08:30"
        );
        assert_eq!(d("every 2 hours"), "every 2 hours");
        assert_eq!(d("every 90 minutes"), "every 90 minutes");
    }

    #[test]
    fn reads_twelve_hour_and_round_trips() {
        // A Mac on a 12-hour clock reads "9:00 AM", as the desk and phone do,
        // and what an agent quotes back from it parses to the same routine.
        crate::agents::clock::test_hour24(false);
        let r = |w: &str| parse(w, &Eastern, now()).unwrap().0.unwrap();
        for (said, reads) in [
            ("every weekday at 9:00", "every weekday at 9:00 AM"),
            ("every day at 0:15", "every day at 12:15 AM"),
            ("every sat, sun at 12", "every weekend day at 12:00 PM"),
            (
                "every mon and thu at 17:30",
                "every Monday and Thursday at 5:30 PM",
            ),
            (
                "every month on the last friday at 16:00",
                "every month on the last Friday at 4:00 PM",
            ),
        ] {
            let repeat = r(said);
            assert_eq!(describe(&repeat), reads);
            assert_eq!(r(reads), repeat, "{reads}");
        }
        assert!(format_time(&Eastern, at(2026, 11, 6, 14, 5)).contains("Fri 6 Nov 2026, 2:05 PM"));
        crate::agents::clock::test_hour24(true);
        assert_eq!(
            describe(&r("every weekday at 9am")),
            "every weekday at 09:00"
        );
        assert!(format_time(&Eastern, at(2026, 11, 6, 14, 5)).contains("Fri 6 Nov 2026, 14:05"));
    }

    #[test]
    fn a_daily_routine_stays_at_nine_across_both_dst_changes() {
        let days: Vec<u8> = (0..7).collect();
        // Spring: Sat 7 Mar 09:00 EST → Sun 8 Mar 09:00 EDT, 23 hours later.
        let sat = at(2026, 3, 7, 9, 0);
        let sun = next_on_days(&Eastern, &days, 9, 0, sat).unwrap();
        assert_eq!(show(sun), "Sun 2026-03-08 09:00 -04:00");
        assert_eq!(sun - sat, 23 * 3_600_000);
        // Autumn: Sat 31 Oct 09:00 EDT → Sun 1 Nov 09:00 EST, 25 hours later.
        let sat = at(2026, 10, 31, 9, 0);
        let sun = next_on_days(&Eastern, &days, 9, 0, sat).unwrap();
        assert_eq!(show(sun), "Sun 2026-11-01 09:00 -05:00");
        assert_eq!(sun - sat, 25 * 3_600_000);
    }

    #[test]
    fn a_time_inside_the_dst_gap_or_overlap_still_fires_once() {
        let days: Vec<u8> = (0..7).collect();
        // 02:30 doesn't exist on 8 Mar: it fires at 03:30, as if the clock hadn't jumped.
        let before = at(2026, 3, 7, 12, 0);
        let gap = next_on_days(&Eastern, &days, 2, 30, before).unwrap();
        assert_eq!(show(gap), "Sun 2026-03-08 03:30 -04:00");
        // And the next day is back to 02:30.
        let after = next_on_days(&Eastern, &days, 2, 30, gap).unwrap();
        assert_eq!(show(after), "Mon 2026-03-09 02:30 -04:00");
        // 01:30 happens twice on 1 Nov: the first one, and only once.
        let before = at(2026, 10, 31, 12, 0);
        let first = next_on_days(&Eastern, &days, 1, 30, before).unwrap();
        assert_eq!(show(first), "Sun 2026-11-01 01:30 -04:00");
        let next = next_on_days(&Eastern, &days, 1, 30, first).unwrap();
        assert_eq!(show(next), "Mon 2026-11-02 01:30 -05:00");
    }

    #[test]
    fn in_n_days_keeps_the_wall_clock_across_dst() {
        let fri = at(2026, 10, 30, 9, 0);
        let (_, next) = parse("in 3 days", &Eastern, fri).unwrap();
        assert_eq!(show(next), "Mon 2026-11-02 09:00 -05:00");
        // Hours are real hours.
        let (_, next) = parse("in 48 hours", &Eastern, fri).unwrap();
        assert_eq!(show(next), "Sun 2026-11-01 08:00 -05:00");
    }

    #[test]
    fn an_interval_routine_counts_real_time_and_does_not_drift() {
        let r = Repeat::Every { minutes: 120 };
        let due_at = at(2026, 11, 3, 9, 0);
        // The tick ran 40s late: the next is still 11:00, not 11:00:40.
        assert_eq!(
            show(advance(&Eastern, &r, due_at, due_at + 40_000).unwrap()),
            "Tue 2026-11-03 11:00 -05:00"
        );
        // Across the fall-back hour, 2 hours is 2 real hours.
        let night = at(2026, 11, 1, 0, 30);
        assert_eq!(
            show(advance(&Eastern, &r, night, night).unwrap()),
            "Sun 2026-11-01 01:30 -05:00"
        );
    }

    fn check_in(id: &str, next_at: i64, repeat: Option<Repeat>) -> CheckIn {
        CheckIn {
            id: id.into(),
            note: format!("note {id}"),
            repeat,
            next_at,
            created_at: 0,
            paused: false,
            paused_on_import: false,
            runs: Vec::new(),
            retry: None,
            watch: None,
            usage: Default::default(),
            follow_up: false,
            then: Vec::new(),
            waiting: None,
            extra: Default::default(),
        }
    }

    fn weekdays_at_nine() -> Option<Repeat> {
        Some(Repeat::Days {
            days: vec![1, 2, 3, 4, 5],
            hour: 9,
            minute: 0,
        })
    }

    #[test]
    fn nothing_fires_before_its_time_or_while_paused() {
        let nine = at(2026, 11, 3, 9, 0);
        assert_eq!(due(&Eastern, &check_in("a", nine, None), nine - 1), None);
        let mut paused = check_in("a", nine, None);
        paused.paused = true;
        assert_eq!(due(&Eastern, &paused, nine + 3_600_000), None);
    }

    #[test]
    fn on_time_firing_is_not_late() {
        let nine = at(2026, 11, 3, 9, 0);
        assert_eq!(
            due(&Eastern, &check_in("a", nine, None), nine + 30_000),
            Some(Due::Fire {
                late: false,
                next: None
            })
        );
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", nine, weekdays_at_nine()),
                nine + 30_000
            ),
            Some(Due::Fire {
                late: false,
                next: Some(at(2026, 11, 4, 9, 0))
            })
        );
    }

    #[test]
    fn a_missed_one_time_check_in_fires_once_late() {
        // Due Monday 9:00; Ship Studio reopened Wednesday afternoon.
        let due_at = at(2026, 11, 2, 9, 0);
        let reopened = at(2026, 11, 4, 14, 0);
        assert_eq!(
            due(&Eastern, &check_in("a", due_at, None), reopened),
            Some(Due::Fire {
                late: true,
                next: None
            })
        );
    }

    #[test]
    fn a_missed_routine_runs_once_late_and_never_backfills() {
        let due_at = at(2026, 11, 3, 9, 0);
        // The Mac woke at 9:10: today's brief still comes, marked late.
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", due_at, weekdays_at_nine()),
                due_at + 10 * 60_000
            ),
            Some(Due::Fire {
                late: true,
                next: Some(at(2026, 11, 4, 9, 0))
            })
        );
        // Closed since last Monday's 9:00, reopened this Saturday: one run
        // now, marked late (not five), then the next weekday at 9:00.
        let last_monday = at(2026, 10, 26, 9, 0);
        let saturday = at(2026, 10, 31, 11, 0);
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", last_monday, weekdays_at_nine()),
                saturday
            ),
            Some(Due::Fire {
                late: true,
                next: Some(at(2026, 11, 2, 9, 0))
            })
        );
        // Every 2 hours, closed since 9:00 and reopened at 14:50: one late
        // run, which stands in for 15:00 (ten minutes off); next is 17:00.
        let every_two = Some(Repeat::Every { minutes: 120 });
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", due_at, every_two),
                at(2026, 11, 3, 14, 50)
            ),
            Some(Due::Fire {
                late: true,
                next: Some(at(2026, 11, 3, 17, 0))
            })
        );
    }

    fn agent_with(id: &str, check_ins: Vec<CheckIn>) -> store::Agent {
        store::Agent {
            id: id.into(),
            name: id.into(),
            role: String::new(),
            shape: 0,
            color: "red".into(),
            colorway: None,
            icon: None,
            bound_key: None,
            is_main: false,
            pinned: false,
            hidden: false,
            session_id: None,
            created_at: 0,
            last_activity_at: 0,
            preview: None,
            unread: 0,
            pending_approvals: 0,
            engine: Default::default(),
            model: None,
            effort: None,
            new_engine: false,
            away: None,
            context: None,
            routine_model: None,
            account: None,
            template: None,
            reach: Default::default(),
            conversations: Default::default(),
            muted: false,
            check_ins,
            usage: Default::default(),
            permissions: Vec::new(),
            failure: None,
            project: None,
            copy: None,
            work_directly: false,
            capabilities: None,
            secrets: Vec::new(),
            extra: Default::default(),
        }
    }

    #[test]
    fn one_check_in_fires_per_tick_most_overdue_first_and_nothing_is_skipped() {
        let now = at(2026, 11, 3, 15, 0);
        let agents = vec![
            agent_with("a", vec![check_in("recent", now - 60_000, None)]),
            agent_with(
                "b",
                vec![
                    check_in("oldest", now - 86_400_000, None),
                    check_in("stale-routine", now - 3 * 86_400_000, weekdays_at_nine()),
                ],
            ),
        ];
        let fire = plan(&Eastern, &agents, now).fire.unwrap();
        // The routine missed for days is the most overdue: it runs (once,
        // late), and the others wait for the next ticks rather than go.
        assert_eq!(
            (fire.agent_id.as_str(), fire.check_in.id.as_str(), fire.late),
            ("b", "stale-routine", true)
        );
        assert_eq!(fire.next, Some(at(2026, 11, 4, 9, 0)));
        // Next tick, with that routine moved on: the oldest check-in.
        let mut agents = agents;
        agents[1].check_ins[1].next_at = at(2026, 11, 4, 9, 0);
        let fire = plan(&Eastern, &agents, now).fire.unwrap();
        assert_eq!(
            (fire.agent_id.as_str(), fire.check_in.id.as_str(), fire.late),
            ("b", "oldest", true)
        );
    }

    #[test]
    fn the_wake_prompt_carries_the_note_and_says_when_it_is_late() {
        let due_at = at(2026, 11, 2, 9, 0);
        let firing = Firing {
            agent_id: "a".into(),
            check_in: check_in("x1", due_at, None),
            late: true,
            next: None,
            also: vec![check_in("x2", due_at + 3_600_000, None)],
            manual: false,
            retry: None,
            waited: false,
        };
        let prompt = wake_prompt(&Eastern, &firing, at(2026, 11, 3, 15, 0));
        assert!(prompt.starts_with("[Scheduled check-in you set: note x1]"));
        assert!(prompt.contains("Mon 2 Nov 2026, 9:00 AM (UTC-05:00)"));
        assert!(prompt.contains("late"));
        assert!(prompt.contains("[Also missed, due Mon 2 Nov 2026, 10:00 AM (UTC-05:00): note x2]"));
    }

    /// The hourly sweep: nothing new may end with no post, and a question
    /// the agent asked earlier rides along instead of being buried.
    #[test]
    fn a_check_in_may_end_silently_and_keeps_open_questions_in_view() {
        assert!(is_nothing_new("[nothing new]"));
        assert!(is_nothing_new(" [Nothing new]. "));
        assert!(is_nothing_new("Nothing new"));
        assert!(!is_nothing_new(
            "Nothing new in the inbox, but the invoice bounced."
        ));
        // The marker with an explanation around it still posts nothing.
        assert!(is_nothing_new(
            "It's 23:40, inside quiet hours, so I'm sending nothing. The invoice question stays open until morning. [nothing new]"
        ));
        assert!(is_nothing_new(
            "[Nothing new] Quiet hours, holding until 7."
        ));
        assert!(!is_nothing_new(
            "The invoice bounced; [nothing new] otherwise, but this needs you."
        ));

        let said = |kind, text: &str| crate::agents::runner::new_message("a", kind, text);
        let log = vec![
            said(MessageKind::Agent, "Should I archive last month's leads?"),
            said(MessageKind::User, "Yes"),
            said(
                MessageKind::Agent,
                "Done.\n\nWhich list should the new leads go to?",
            ),
            said(MessageKind::CheckIn, "Sweep the inbox"),
            said(MessageKind::Agent, "Nothing urgent."),
        ];
        assert_eq!(
            open_questions(&log),
            vec!["Which list should the new leads go to?".to_string()]
        );
        // Answered since: nothing open.
        assert!(open_questions(&log[..2]).is_empty());

        let due_at = at(2026, 11, 2, 9, 0);
        let firing = Firing {
            agent_id: "a".into(),
            check_in: check_in("x1", due_at, None),
            late: false,
            next: None,
            also: vec![],
            manual: false,
            retry: None,
            waited: false,
        };
        let p = wake_prompt_with(&Eastern, &firing, due_at, &open_questions(&log));
        assert!(p.contains(
            "Still waiting on the user, asked earlier: “Which list should the new leads go to?”"
        ));
        assert!(p.contains(NOTHING_NEW));
        assert!(!wake_prompt(&Eastern, &firing, due_at).contains("Still waiting"));
        // A choice it asked about earlier is decided, not carried along.
        assert!(p.contains("A reversible choice your level covers isn't theirs: decide it now"));
    }

    /// The "Agent sweep" check-in handed decisions back ("that's your call",
    /// "pick one, my recommendation…"): every wake says to decide and act on
    /// what's reversible, and to surface only what's blocked or on the floor.
    #[test]
    fn a_check_in_decides_what_is_reversible_and_surfaces_only_blocks() {
        let due_at = at(2026, 11, 2, 9, 0);
        let firing = Firing {
            agent_id: "a".into(),
            check_in: check_in("Agent sweep for the owner", due_at, weekdays_at_nine()),
            late: false,
            next: None,
            also: vec![],
            manual: false,
            retry: None,
            waited: false,
        };
        let p = wake_prompt(&Eastern, &firing, due_at);
        assert!(p.contains(SWEEP));
        assert!(p.contains("decide and do now"));
        assert!(p.contains("no \"your call\", no \"pick one\""));
        assert!(p.contains("Surface only what's truly blocked on them or on the floor"));
        assert!(p.contains(NOTHING_NEW), "a quiet sweep still posts nothing");
    }

    #[test]
    fn a_reopened_app_wakes_each_agent_once_for_everything_it_missed() {
        let now = at(2026, 11, 3, 15, 0);
        let agents = vec![agent_with(
            "a",
            vec![
                check_in("first", now - 2 * 86_400_000, None),
                check_in("second", now - 86_400_000, None),
                // Not missed: due in a minute, stays for its own time.
                check_in("upcoming", now + 60_000, None),
                // A routine is never folded into a one-off's wake.
                check_in("routine", now - 60_000, weekdays_at_nine()),
            ],
        )];
        let fire = plan(&Eastern, &agents, now).fire.unwrap();
        assert_eq!(fire.check_in.id, "first");
        let also: Vec<&str> = fire.also.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(also, vec!["second"]);
        // On time: nothing is folded in.
        let on_time = vec![agent_with(
            "a",
            vec![
                check_in("now", now - 10_000, None),
                check_in("now2", now - 5_000, None),
            ],
        )];
        assert!(plan(&Eastern, &on_time, now).fire.unwrap().also.is_empty());
    }

    #[test]
    fn creating_answers_with_the_exact_time_and_refuses_spam() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let agent = store::create(store::NewAgent {
            name: "Finance".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let made = create_in(
            &Eastern,
            &agent.id,
            "friday at 9:00",
            "Chase Northwind",
            now(),
        )
        .unwrap();
        assert!(
            made.summary.contains("Fri 6 Nov 2026, 9:00 AM (UTC-05:00)"),
            "{}",
            made.summary
        );
        assert!(made.summary.contains("only while the app is open"));
        let again = create_in(
            &Eastern,
            &agent.id,
            "friday at 10:00",
            "Chase Northwind",
            now(),
        );
        assert!(
            again.is_ok(),
            "a different time for the same note is a new one-off"
        );
        let routine = create_in(&Eastern, &agent.id, "every weekday at 9", "Brief", now()).unwrap();
        assert!(routine.summary.contains("every weekday at 9:00 AM"));
        assert!(routine
            .summary
            .contains("runs once when it reopens, marked late"));
        assert!(create_in(&Eastern, &agent.id, "every weekday at 10", "Brief", now()).is_ok());
        assert!(create_in(&Eastern, &agent.id, "every weekday at 10", "Brief", now()).is_err());
        assert!(create_in(&Eastern, &agent.id, "tomorrow at 9", "  ", now()).is_err());

        assert_eq!(store::get(&agent.id).unwrap().check_ins.len(), 4);
        cancel(&agent.id, &made.check_in.id).unwrap();
        assert!(cancel(&agent.id, &made.check_in.id).is_err());
        for i in 0..MAX_PER_AGENT {
            let _ = create_in(&Eastern, &agent.id, "in 3 hours", &format!("n{i}"), now());
        }
        assert_eq!(
            store::get(&agent.id).unwrap().check_ins.len(),
            MAX_PER_AGENT
        );
        store::set_root_for_tests(None);
    }

    #[test]
    fn a_described_routine_reads_back_as_the_same_routine() {
        // The popover's Edit prefills the composer with these words.
        for when in [
            "every weekday at 9:00",
            "every day at 7:45",
            "every weekend day at 10:00",
            "every mon, thu and fri at 17:30",
            "every 2 hours",
            "every hour",
            "every 45 minutes",
        ] {
            let repeat = parse(when, &Eastern, now()).unwrap().0.unwrap();
            let again = parse(&describe(&repeat), &Eastern, now())
                .unwrap()
                .0
                .unwrap();
            assert_eq!(again, repeat, "{when}");
        }
    }

    #[test]
    fn run_now_is_a_normal_wake_that_says_it_was_asked_for() {
        let agent = agent_with(
            "a",
            vec![check_in("r1", at(2026, 11, 5, 9, 0), weekdays_at_nine())],
        );
        let firing = manual_firing(&agent, "r1").unwrap();
        assert!(firing.manual && !firing.late && firing.also.is_empty());
        let prompt = wake_prompt(&Eastern, &firing, now());
        assert!(prompt.starts_with("[Scheduled check-in you set: note r1]"));
        assert!(prompt.contains("asked you to run it now"));
        assert!(prompt.contains("This is a routine"));
        assert!(!prompt.contains("late"));
        assert!(manual_firing(&agent, "gone").is_err());
        // The mark only grows a field when it was run by hand.
        let mark = CheckInMark {
            due_at: 0,
            late: false,
            repeats: true,
            manual: false,
            found: None,
        };
        assert!(!serde_json::to_string(&mark).unwrap().contains("manual"));
    }

    /// The phone's routine picker writes these words (packages/companion-protocol,
    /// `routineWhenPhrase`; mobile's start.node.test.ts checks it does). Each must
    /// read back here as the schedule the picker meant.
    #[test]
    fn reads_every_phrase_the_phone_picker_writes() {
        #[derive(serde::Deserialize)]
        #[serde(tag = "kind", rename_all = "lowercase")]
        enum When {
            Days {
                days: Vec<u8>,
                hour: u32,
                minute: u32,
            },
            Every {
                minutes: u32,
            },
            Once {
                date: String,
                hour: u32,
                minute: u32,
            },
            Monthly {
                months: u32,
                on: MonthDay,
                hour: u32,
                minute: u32,
                /// The month its first run is in, 1 to 12.
                #[serde(default)]
                start: Option<u32>,
            },
        }
        #[derive(serde::Deserialize)]
        struct Case {
            when: When,
            phrase: String,
        }
        #[derive(serde::Deserialize)]
        struct Phrases {
            cases: Vec<Case>,
        }
        let file: Phrases = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../packages/companion-protocol/src/routine-phrases.json"
        )))
        .unwrap();
        assert!(file.cases.len() >= 10);
        for case in file.cases {
            let (repeat, next_at) = parse(&case.phrase, &Eastern, now())
                .unwrap_or_else(|e| panic!("{:?} didn't parse: {e}", case.phrase));
            match case.when {
                When::Days { days, hour, minute } => {
                    let mut days = days;
                    days.sort_unstable();
                    assert_eq!(
                        repeat,
                        Some(Repeat::Days { days, hour, minute }),
                        "{}",
                        case.phrase
                    );
                }
                When::Every { minutes } => {
                    assert_eq!(repeat, Some(Repeat::Every { minutes }), "{}", case.phrase);
                }
                When::Once { date, hour, minute } => {
                    assert_eq!(repeat, None, "{}", case.phrase);
                    let d = NaiveDate::parse_from_str(&date, "%Y-%m-%d").unwrap();
                    let want = resolve(&Eastern, d, hour, minute).unwrap();
                    assert_eq!(show(next_at), show(want), "{}", case.phrase);
                }
                When::Monthly {
                    months,
                    on,
                    hour,
                    minute,
                    start,
                } => {
                    let Some(Repeat::Monthly {
                        months: m,
                        on: o,
                        hour: h,
                        minute: mi,
                        from,
                    }) = repeat
                    else {
                        panic!("{} isn't monthly: {repeat:?}", case.phrase);
                    };
                    assert_eq!((m, o, h, mi), (months, on, hour, minute), "{}", case.phrase);
                    // Its first run is in the month the picker named.
                    if let Some(start) = start {
                        assert_eq!(from.map(|f| f.rem_euclid(12) + 1), Some(start as i32));
                        let first = Eastern.timestamp_millis_opt(next_at).unwrap();
                        assert_eq!(first.month(), start, "{}", case.phrase);
                    }
                }
            }
        }
    }

    #[test]
    fn an_edit_without_a_when_changes_only_the_note() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let agent = store::create(store::NewAgent {
            name: "Finance".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let made = create_in(&Eastern, &agent.id, "every 2 hours", "Check", now()).unwrap();
        // An hour later, only the note changes: it isn't re-anchored to then.
        let later = now() + 60 * 60 * 1000;
        let edited = edit_in(
            &Eastern,
            &agent.id,
            &made.check_in.id,
            "  ",
            "Check mail",
            later,
        )
        .unwrap();
        assert_eq!(edited.note, "Check mail");
        assert_eq!(edited.repeat, made.check_in.repeat);
        assert_eq!(edited.next_at, made.check_in.next_at);
        // The note's own rules still hold.
        assert!(edit_in(&Eastern, &agent.id, &made.check_in.id, "", " ", later).is_err());
        store::set_root_for_tests(None);
    }

    #[test]
    fn editing_changes_when_and_what_in_place() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let agent = store::create(store::NewAgent {
            name: "Finance".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let brief = create_in(&Eastern, &agent.id, "every weekday at 9", "Brief", now()).unwrap();
        let other = create_in(&Eastern, &agent.id, "friday at 9:00", "Chase", now()).unwrap();
        set_paused(&agent.id, &brief.check_in.id, true).unwrap();

        let edited = edit_in(
            &Eastern,
            &agent.id,
            &brief.check_in.id,
            "every monday at 8am",
            "Brief me on Acme",
            now(),
        )
        .unwrap();
        assert_eq!(edited.id, brief.check_in.id);
        assert_eq!(edited.created_at, brief.check_in.created_at);
        assert!(edited.paused, "a paused routine stays paused");
        assert_eq!(
            edited.repeat,
            Some(Repeat::Days {
                days: vec![1],
                hour: 8,
                minute: 0
            })
        );
        assert_eq!(edited.next_at, at(2026, 11, 9, 8, 0));
        let stored = store::get(&agent.id).unwrap().check_ins;
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0], edited, "kept its place in the list");

        // A routine can become a one-off, and the grammar's errors come through.
        let once = edit_in(
            &Eastern,
            &agent.id,
            &edited.id,
            "tomorrow at 10",
            "Once",
            now(),
        )
        .unwrap();
        assert_eq!(once.repeat, None);
        assert!(edit_in(&Eastern, &agent.id, &edited.id, "soon", "x", now()).is_err());
        assert!(edit_in(
            &Eastern,
            &agent.id,
            &edited.id,
            "tomorrow at 10",
            " ",
            now()
        )
        .is_err());
        // Can't be edited into a copy of another, nor edit one that's gone.
        assert!(edit_in(
            &Eastern,
            &agent.id,
            &edited.id,
            "friday at 9:00",
            "Chase",
            now()
        )
        .is_err());
        assert!(edit_in(&Eastern, &agent.id, "gone", "friday at 9:00", "x", now()).is_err());
        // Saving it unchanged is not a clash with itself.
        assert!(edit_in(
            &Eastern,
            &agent.id,
            &other.check_in.id,
            "friday at 9:00",
            "Chase",
            now()
        )
        .is_ok());
        store::set_root_for_tests(None);
    }

    #[test]
    fn a_failed_run_is_retried_at_its_time_without_moving_the_routine() {
        let nine = at(2026, 11, 3, 9, 0);
        let retry = |at: i64| runs::Retry {
            at,
            attempts: 1,
            first_failed_at: nine,
            due_at: nine,
        };
        // A routine with a retry pending at 9:02; its own next run is tomorrow.
        let mut routine = check_in("r", at(2026, 11, 4, 9, 0), weekdays_at_nine());
        routine.retry = Some(retry(nine + 2 * MINUTE_MS));
        assert_eq!(due(&Eastern, &routine, nine + MINUTE_MS), None);
        assert_eq!(
            due(&Eastern, &routine, nine + 2 * MINUTE_MS),
            Some(Due::Retry)
        );
        let plan = plan(
            &Eastern,
            &[agent_with("a", vec![routine.clone()])],
            nine + 3 * MINUTE_MS,
        );
        let fire = plan.fire.expect("the retry fires");
        assert_eq!(
            fire.next,
            Some(routine.next_at),
            "the routine's own time doesn't move"
        );
        assert_eq!(fire.retry.as_ref().map(|r| r.attempts), Some(1));
        let prompt = wake_prompt(&Eastern, &fire, nine + 3 * MINUTE_MS);
        assert!(prompt.contains("didn't finish then, so this is try 2"));
        // Paused: no retry either.
        let mut paused = routine.clone();
        paused.paused = true;
        assert_eq!(due(&Eastern, &paused, nine + 3 * MINUTE_MS), None);
        // A one-time check-in waits for its retry, not its (past) time.
        let mut once = check_in("o", nine, None);
        once.retry = Some(retry(nine + 5 * MINUTE_MS));
        assert_eq!(due(&Eastern, &once, nine + 3 * MINUTE_MS), None);
        assert_eq!(due(&Eastern, &once, nine + 5 * MINUTE_MS), Some(Due::Retry));
        // When the routine's own time comes first, that runs instead.
        let mut overdue = check_in("r2", nine, weekdays_at_nine());
        overdue.retry = Some(retry(nine + 60 * MINUTE_MS));
        assert!(matches!(
            due(&Eastern, &overdue, nine + MINUTE_MS),
            Some(Due::Fire { .. })
        ));
    }

    #[test]
    fn a_registry_with_run_history_round_trips() {
        let mut c = check_in("h", 1, weekdays_at_nine());
        runs::record(
            &mut c.runs,
            runs::Run {
                at: 1,
                outcome: runs::Outcome::Retrying,
                attempt: 1,
                detail: Some("API Error: 529 overloaded".into()),
                retry_at: Some(2),
                sign_in: vec!["Gmail".into()],
                manual: false,
                step: 0,
            },
        );
        c.retry = Some(runs::Retry {
            at: 2,
            attempts: 1,
            first_failed_at: 1,
            due_at: 1,
        });
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["runs"][0]["outcome"], "retrying");
        assert_eq!(json["retry"]["firstFailedAt"], 1);
        let back: CheckIn = serde_json::from_value(json).unwrap();
        assert_eq!(back, c);
        // Nothing written for a check-in that never ran.
        let plain = serde_json::to_value(check_in("p", 1, None)).unwrap();
        assert!(plain.get("runs").is_none() && plain.get("retry").is_none());
    }

    #[test]
    fn check_ins_are_optional_in_an_old_registry() {
        let old = r#"{"id":"a","name":"A","shape":0,"color":"red","createdAt":0}"#;
        let agent: store::Agent = serde_json::from_str(old).unwrap();
        assert!(agent.check_ins.is_empty());
        // And an agent with none doesn't grow the file.
        assert!(!serde_json::to_string(&agent).unwrap().contains("checkIns"));
    }
}

/// Monthly routines: the grammar, the next-run maths across month lengths
/// and DST, and what they are called.
#[cfg(test)]
#[path = "schedule_monthly_tests.rs"]
mod monthly_tests;
