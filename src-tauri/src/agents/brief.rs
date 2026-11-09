//! The morning brief: once a day, at the user's time, the Chief of Staff
//! posts one short message in its chat saying what the team did, what is
//! waiting on the user, what runs today, how much room the accounts have,
//! and what didn't work.
//!
//! - **No model turn.** It is composed here from the app's own records
//!   ([`gather`], [`compose`]): each agent's chat log, its routines and their
//!   runs, the cards still waiting, and the accounts' own usage readings
//!   (`compute::totals`, only numbers an engine reported). Nothing in it is
//!   inferred: an agent that did nothing isn't named, and usage nobody read
//!   is said to be unread.
//! - **Prepared ahead.** [`PREPARE_LEAD_MS`] before the time the slow parts
//!   (the usage inventory, the user's own checks) are read and kept in
//!   `morning-brief-state.json`; at the time it is posted at once.
//! - **Nothing to say, nothing posted**, unless the user asked for it
//!   anyway (`always`). Usage alone is only news when there is no room.
//! - **Your own checks** (opt-in, `checks`): read-only questions through one
//!   connector each ("my calendar today"), run as the sealed "When…" check
//!   runs them (`watch::check`, `watch_seal`): no shell, no files, only that
//!   connector's read tools. What they find is outside text: shown to the
//!   user as escaped plain lines, never given to a turn as instructions. A
//!   check that can't run says why in one line.
//! - **Missed, not late.** The Mac asleep or the app closed for more than
//!   [`LATE_MS`] past the time: that day's brief is skipped, not posted at noon.
//! - **Set from chat** (`set_morning_brief`, the Chief's), Settings → Agents
//!   → Notifications and the phone's Settings. The default is on at 8:00.
//!
//! Full design: docs/agents.md, "Morning brief".

use chrono::{NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use super::compute::{Family, Totals};
use super::runs::Outcome;
use super::store::{self, Agent, AgentMessage, MessageKind};
use crate::errors::CommandError;

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MINUTES: u32 = 24 * 60;
/// How long before the time the slow parts are read.
pub const PREPARE_LEAD_MS: i64 = 20 * MINUTE_MS;
/// Past its time by more than this (the Mac asleep, the app closed), a
/// day's brief is skipped.
pub const LATE_MS: i64 = 3 * HOUR_MS;
/// 08:00.
pub const DEFAULT_AT: u32 = 8 * 60;
/// At most this many of the user's own checks.
pub const MAX_CHECKS: usize = 4;
/// Items shown per list before "and N more".
const LIST_CAP: usize = 5;
/// Every brief starts with this, so the next one knows not to count it.
pub const HEAD: &str = "Morning brief";

const FILE: &str = "morning-brief.json";
const STATE_FILE: &str = "morning-brief-state.json";

/// Settings and the phone read the brief's settings again on this.
pub const EVENT: &str = "agents-morning-brief-changed";

/* ------------------------------------------------------------ settings */

/// A read-only question the brief asks through one connector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// In the user's words: "events on my calendar today".
    pub what: String,
    /// The connector, by its name in Apps or Claude Code ("Google Calendar").
    pub app: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub on: bool,
    /// Minutes after local midnight.
    pub at: u32,
    /// Post even when there's nothing worth saying.
    #[serde(default)]
    pub always: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<Check>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            on: true,
            at: DEFAULT_AT,
            always: false,
            checks: Vec::new(),
        }
    }
}

/// "08:00".
pub fn clock_label(minute: u32) -> String {
    format!("{:02}:{:02}", (minute / 60) % 24, minute % 60)
}

/// Settings from the desk or the phone, checked.
pub fn checked(s: Settings) -> Result<Settings, String> {
    if s.at >= DAY_MINUTES {
        return Err("The brief's time is a minute in the day (00:00 to 23:59).".into());
    }
    if s.checks.len() > MAX_CHECKS {
        return Err(format!("At most {MAX_CHECKS} checks."));
    }
    let checks = s
        .checks
        .into_iter()
        .map(|c| Check {
            what: one_line(&c.what, 200),
            app: one_line(&c.app, 80),
        })
        .collect::<Vec<_>>();
    if checks.iter().any(|c| c.what.is_empty() || c.app.is_empty()) {
        return Err("Each check says what to look for and which app to look in.".into());
    }
    Ok(Settings { checks, ..s })
}

/* ---------------------------------------------------------------- state */

/// What the slow parts came to, read shortly before the time.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// The local day it is for, `YYYY-MM-DD`.
    pub day: String,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<CheckLine>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared: Option<Prepared>,
    /// The last local day a brief was settled for (posted, skipped as
    /// empty, or missed): it isn't looked at again that day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_day: Option<String>,
    /// When a brief was last posted: the next one covers from here.
    #[serde(default)]
    pub last_posted_at: i64,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path(name: &str) -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agents_root()?.join(name))
}

fn read<T: serde::de::DeserializeOwned + Default>(name: &str, what: &str) -> T {
    path(name)
        .ok()
        .and_then(|p| super::survive::read_kept(&p, what))
        .unwrap_or_default()
}

fn write<T: Serialize>(name: &str, value: &T) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(value).map_err(super::err_other)?;
    store::write_atomic(&path(name)?, &json)
}

/// The brief's settings: the default (on, 08:00) until the user changes them.
pub fn get() -> Settings {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(FILE, "Your morning brief")
}

pub fn set(settings: Settings) -> Result<Settings, CommandError> {
    let settings = checked(settings).map_err(CommandError::expected)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write(FILE, &settings)?;
    Ok(settings)
}

fn state() -> State {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(STATE_FILE, "The morning brief's state")
}

fn save_state(change: impl FnOnce(&mut State)) -> Result<(), CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s: State = read(STATE_FILE, "The morning brief's state");
    change(&mut s);
    write(STATE_FILE, &s)
}

/* ------------------------------------------------------------- when */

pub fn day_key(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn local_date<Tz: TimeZone>(tz: &Tz, ms: i64) -> Option<NaiveDate> {
    tz.timestamp_millis_opt(ms).single().map(|t| t.date_naive())
}

/// What the tick does about the brief now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Read the slow parts for `day`, ahead of its time.
    Prepare {
        day: String,
    },
    /// Its time has come: post (preparing first if that didn't happen).
    Post {
        day: String,
    },
    /// Too late to be a morning brief: settle the day with nothing posted.
    Missed {
        day: String,
    },
}

/// The step for `now`. Pure.
pub fn decide<Tz: TimeZone>(settings: &Settings, state: &State, tz: &Tz, now: i64) -> Step {
    if !settings.on {
        return Step::Nothing;
    }
    let Some(today) = local_date(tz, now) else {
        return Step::Nothing;
    };
    let day = day_key(today);
    if state.settled_day.as_deref() == Some(day.as_str()) {
        return Step::Nothing;
    }
    let Some(at) = super::schedule::resolve(tz, today, settings.at / 60, settings.at % 60) else {
        return Step::Nothing;
    };
    if now < at - PREPARE_LEAD_MS {
        return Step::Nothing;
    }
    if now < at {
        let ready = state.prepared.as_ref().is_some_and(|p| p.day == day);
        return if ready {
            Step::Nothing
        } else {
            Step::Prepare { day }
        };
    }
    if now - at > LATE_MS {
        return Step::Missed { day };
    }
    Step::Post { day }
}

/* ------------------------------------------------------------- facts */

#[derive(Debug, Clone, PartialEq)]
pub struct AgentDid {
    pub name: String,
    pub replies: u32,
    /// Result cards shared, by title (one per result, its latest version).
    pub results: Vec<String>,
    /// Routine runs that ended well.
    pub routines_ran: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub agent: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Today {
    pub at: i64,
    pub agent: String,
    pub what: String,
    /// "every 2 hours", for a routine that runs more than once a day.
    pub repeat: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failed {
    pub agent: String,
    /// A routine's name, or `None` for a reply that ended in an error.
    pub routine: Option<String>,
    pub at: i64,
    pub detail: Option<String>,
    /// How many like it (errors in this agent's chat).
    pub count: u32,
}

/// The accounts' room, as their own readings said (`compute::Totals`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub signed_in: u32,
    pub read: u32,
    pub room: u32,
    /// The soonest reset of any reported window: (account, engine, window, at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soonest_reset: Option<ResetAt>,
    /// With no room anywhere: when the first account has room again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_room: Option<ResetAt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetAt {
    pub account: String,
    pub engine: String,
    /// "5-hour", "weekly"; empty for "room again".
    #[serde(default)]
    pub window: String,
    pub at: i64,
}

impl Usage {
    pub fn from_totals(t: &Totals) -> Usage {
        let soonest_reset = t
            .windows
            .iter()
            .filter_map(|w| w.soonest_reset.as_ref().map(|r| (w.family, r)))
            .min_by_key(|(_, r)| r.at)
            .map(|(family, r)| ResetAt {
                account: r.account_name.clone(),
                engine: r.engine.label().to_string(),
                window: match family {
                    Family::Session => "5-hour",
                    Family::Weekly => "weekly",
                }
                .to_string(),
                at: r.at,
            });
        Usage {
            signed_in: t.signed_in,
            read: t.read,
            room: t.room,
            soonest_reset,
            next_room: t.next_room.as_ref().map(|r| ResetAt {
                account: r.account_name.clone(),
                engine: r.engine.label().to_string(),
                window: String::new(),
                at: r.at,
            }),
        }
    }

    /// Out of room on every account that reported: worth a brief alone.
    pub fn is_out(&self) -> bool {
        self.read > 0 && self.room == 0
    }
}

/// One of the user's checks, as it came back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckLine {
    pub what: String,
    pub app: String,
    /// What it found, by title (outside text: escaped when shown).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
    /// Why it couldn't check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub since: i64,
    pub did: Vec<AgentDid>,
    pub waiting: Vec<Waiting>,
    pub today: Vec<Today>,
    pub failed: Vec<Failed>,
    pub usage: Option<Usage>,
    pub checks: Vec<CheckLine>,
}

impl Facts {
    /// Anything the user would want to hear. Usage alone is news only when
    /// there's no room left.
    pub fn worth_saying(&self) -> bool {
        !self.did.is_empty()
            || !self.waiting.is_empty()
            || !self.today.is_empty()
            || !self.failed.is_empty()
            || !self.checks.is_empty()
            || self.usage.as_ref().is_some_and(Usage::is_out)
    }
}

/// One agent's records, as read for [`gather`].
pub struct AgentRecords<'a> {
    pub agent: &'a Agent,
    /// Its chat log since `since` (more is ignored).
    pub log: &'a [AgentMessage],
    /// Its cards still waiting on the user.
    pub cards: &'a [AgentMessage],
}

fn one_line(s: &str, max: usize) -> String {
    let line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= max {
        return line;
    }
    let mut cut: String = line.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// A routine's name: its note's first line, short.
fn routine_name(note: &str) -> String {
    one_line(
        note.lines().find(|l| !l.trim().is_empty()).unwrap_or(""),
        70,
    )
}

/// The facts since `since`, up to the end of `now`'s local day. Pure.
pub fn gather<Tz: TimeZone>(records: &[AgentRecords], since: i64, tz: &Tz, now: i64) -> Facts {
    let end_of_day = local_date(tz, now)
        .and_then(|d| d.succ_opt())
        .and_then(|d| super::schedule::resolve(tz, d, 0, 0))
        .unwrap_or(now + 24 * HOUR_MS);
    let mut facts = Facts {
        since,
        ..Default::default()
    };
    for r in records {
        let a = r.agent;
        let recent = r.log.iter().filter(|m| m.ts >= since && m.ts <= now);
        let mut replies = 0u32;
        let mut results: Vec<(String, String)> = Vec::new();
        let mut errors: Vec<&AgentMessage> = Vec::new();
        for m in recent {
            match m.kind {
                MessageKind::Agent if m.text.trim_start().starts_with(HEAD) && a.is_main => {}
                MessageKind::Agent => {
                    if let Some(card) = &m.result {
                        match results.iter_mut().find(|(id, _)| *id == card.id) {
                            Some(slot) => slot.1 = one_line(&card.title, 80),
                            None => results.push((card.id.clone(), one_line(&card.title, 80))),
                        }
                    } else if !m.text.trim().is_empty() || !m.attachments.is_empty() {
                        replies += 1;
                    }
                }
                MessageKind::Error => errors.push(m),
                _ => {}
            }
        }
        let mut routines_ran = 0u32;
        let mut routine_failures = Vec::new();
        for c in &a.check_ins {
            for run in c.runs.iter().filter(|run| run.at >= since && run.at <= now) {
                match run.outcome {
                    Outcome::Ran => routines_ran += 1,
                    Outcome::Failed => routine_failures.push(Failed {
                        agent: a.name.clone(),
                        routine: Some(routine_name(&c.note)),
                        at: run.at,
                        detail: run.detail.as_deref().map(|d| one_line(d, 140)),
                        count: 1,
                    }),
                    _ => {}
                }
            }
            if !c.paused && c.watch.is_none() && c.next_at >= now && c.next_at < end_of_day {
                let repeat = match &c.repeat {
                    Some(r @ super::schedule::Repeat::Every { .. }) => {
                        Some(super::schedule::describe(r))
                    }
                    _ => None,
                };
                facts.today.push(Today {
                    at: c.next_at,
                    agent: a.name.clone(),
                    what: routine_name(&c.note),
                    repeat,
                });
            }
        }
        if replies > 0 || !results.is_empty() || routines_ran > 0 {
            facts.did.push(AgentDid {
                name: a.name.clone(),
                replies,
                results: results.into_iter().map(|(_, t)| t).collect(),
                routines_ran,
            });
        }
        // A failed routine also leaves an error line: named once, as the routine.
        if routine_failures.is_empty() {
            if let Some(last) = errors.last() {
                facts.failed.push(Failed {
                    agent: a.name.clone(),
                    routine: None,
                    at: last.ts,
                    detail: Some(one_line(
                        last.text
                            .lines()
                            .find(|l| !l.trim().is_empty())
                            .unwrap_or(""),
                        140,
                    ))
                    .filter(|d| !d.is_empty()),
                    count: errors.len() as u32,
                });
            }
        }
        facts.failed.extend(routine_failures);
        for card in r.cards {
            if let Some(approval) = &card.approval {
                facts.waiting.push(Waiting {
                    agent: a.name.clone(),
                    title: one_line(&approval.title, 80),
                });
            }
        }
    }
    facts.today.sort_by_key(|t| t.at);
    facts.failed.sort_by_key(|f| f.at);
    facts
}

/* ---------------------------------------------------------- the words */

/// Outside text as one plain line: markdown can't make it a link (not
/// even a bare address, which GFM links by itself: `:`, `.` and `@` are
/// escaped too), a list, a heading or anything but the words.
pub fn plain(s: &str) -> String {
    let mut out = String::new();
    for c in one_line(s, 120).chars() {
        if matches!(
            c,
            '\\' | '`'
                | '*'
                | '_'
                | '['
                | ']'
                | '<'
                | '>'
                | '#'
                | '|'
                | '!'
                | '('
                | ')'
                | '~'
                | ':'
                | '.'
                | '@'
                | '-'
                | '+'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn hm<Tz: TimeZone>(tz: &Tz, ms: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    tz.timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%H:%M").to_string())
        .unwrap_or_default()
}

fn capped(lines: Vec<String>, out: &mut Vec<String>) {
    let more = lines.len().saturating_sub(LIST_CAP);
    out.extend(lines.into_iter().take(LIST_CAP));
    if more > 0 {
        out.push(format!("- and {more} more"));
    }
}

/// The brief, or `None` when there's nothing worth saying and the user
/// didn't ask for it anyway. Its first line is the notification. Pure.
pub fn compose<Tz: TimeZone>(facts: &Facts, always: bool, tz: &Tz, now: i64) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    if !always && !facts.worth_saying() {
        return None;
    }
    let date = tz
        .timestamp_millis_opt(now)
        .single()
        .map(|t| t.format("%A %-d %B").to_string())
        .unwrap_or_default();
    let mut gist = Vec::new();
    if !facts.waiting.is_empty() {
        let n = facts.waiting.len();
        gist.push(format!("{} for you", plural(n, "card waits", "cards wait")));
    }
    if !facts.failed.is_empty() {
        gist.push(format!(
            "{} didn’t work",
            plural(facts.failed.len(), "thing", "things")
        ));
    }
    if !facts.today.is_empty() {
        gist.push(format!(
            "{} today",
            plural(facts.today.len(), "routine", "routines")
        ));
    }
    if !facts.did.is_empty() {
        gist.push(format!(
            "{} worked",
            plural(facts.did.len(), "agent", "agents")
        ));
    }
    if facts.usage.as_ref().is_some_and(Usage::is_out) {
        gist.push("no account has room".into());
    }
    let gist = if gist.is_empty() {
        "nothing needs you.".to_string()
    } else {
        let mut g = gist.join(", ");
        g.push('.');
        g
    };
    let mut out = vec![format!("{HEAD}, {date}: {gist}")];

    let section = |out: &mut Vec<String>, title: &str, lines: Vec<String>| {
        if lines.is_empty() {
            return;
        }
        out.push(String::new());
        out.push(format!("**{title}**"));
        capped(lines, out);
    };

    let waiting = facts
        .waiting
        .iter()
        .map(|w| format!("- {}: {}", w.agent, w.title))
        .collect();
    section(&mut out, "Waiting on you", waiting);

    let failed = facts
        .failed
        .iter()
        .map(|f| {
            let what = match (&f.routine, f.count) {
                (Some(r), _) => format!("{}’s routine “{r}” failed", f.agent),
                (None, 1) => format!("{}’s reply ended in an error", f.agent),
                (None, n) => format!("{} replies from {} ended in an error", n, f.agent),
            };
            let when = super::failure::clock_phrase(tz, f.at, now);
            match &f.detail {
                Some(d) if !d.is_empty() => format!("- {what} {when}: {d}"),
                _ => format!("- {what} {when}"),
            }
        })
        .collect();
    section(&mut out, "Didn’t work", failed);

    let today = facts
        .today
        .iter()
        .map(|t| {
            let repeat = t
                .repeat
                .as_ref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default();
            format!("- {} {}: {}{repeat}", hm(tz, t.at), t.agent, t.what)
        })
        .collect();
    section(&mut out, "Today", today);

    let since_title = if now - facts.since <= 30 * HOUR_MS {
        "Since yesterday".to_string()
    } else {
        tz.timestamp_millis_opt(facts.since)
            .single()
            .map(|t| format!("Since {}", t.format("%A")))
            .unwrap_or_else(|| "Since the last brief".into())
    };
    let did = facts
        .did
        .iter()
        .map(|d| {
            let mut parts = Vec::new();
            match d.results.as_slice() {
                [] => {}
                [one] => parts.push(format!("shared “{one}”")),
                many => parts.push(format!("shared {} results", many.len())),
            }
            if d.routines_ran > 0 {
                parts.push(format!(
                    "ran {}",
                    plural(d.routines_ran as usize, "routine", "routines")
                ));
            }
            if d.replies > 0 {
                parts.push(plural(d.replies as usize, "reply", "replies"));
            }
            format!("- {}: {}", d.name, parts.join(", "))
        })
        .collect();
    section(&mut out, &since_title, did);

    if let Some(u) = &facts.usage {
        let mut lines = Vec::new();
        if u.signed_in > 0 {
            if u.read == 0 {
                lines.push("- No account has reported its limits yet.".to_string());
            } else {
                let unread = u.signed_in.saturating_sub(u.read);
                let unread = if unread > 0 {
                    format!(" ({unread} not reported)")
                } else {
                    String::new()
                };
                lines.push(format!(
                    "- Room on {} of {} accounts{unread}, by their own readings.",
                    u.room, u.signed_in
                ));
            }
            if u.is_out() {
                if let Some(r) = &u.next_room {
                    lines.push(format!(
                        "- {} ({}) has room again {}.",
                        r.account,
                        r.engine,
                        super::failure::clock_phrase(tz, r.at, now)
                    ));
                }
            }
            if let Some(r) = &u.soonest_reset {
                lines.push(format!(
                    "- Soonest reset: {} ({}), {} limit, {}.",
                    r.account,
                    r.engine,
                    r.window,
                    super::failure::clock_phrase(tz, r.at, now)
                ));
            }
        }
        section(&mut out, "Usage", lines);
    }

    if !facts.checks.is_empty() {
        out.push(String::new());
        out.push("**Your checks**".to_string());
        for c in &facts.checks {
            match &c.error {
                Some(why) => out.push(format!(
                    "- {} ({}): couldn’t check. {}",
                    plain(&c.what),
                    plain(&c.app),
                    plain(why)
                )),
                None if c.items.is_empty() => out.push(format!(
                    "- {} ({}): nothing.",
                    plain(&c.what),
                    plain(&c.app)
                )),
                None => {
                    out.push(format!("- {} ({}):", plain(&c.what), plain(&c.app)));
                    let items: Vec<String> = c
                        .items
                        .iter()
                        .map(|i| format!("  - {}", plain(i)))
                        .collect();
                    let more = items.len().saturating_sub(LIST_CAP);
                    out.extend(items.into_iter().take(LIST_CAP));
                    if more > 0 {
                        out.push(format!("  - and {more} more"));
                    }
                }
            }
        }
    }
    Some(out.join("\n"))
}

/* ------------------------------------------------------ the chat tool */

pub const TOOL: &str = "set_morning_brief";

pub const DESCRIPTION: &str = "The morning brief, the app's own: once a day at the user's time you post one short message in your chat, composed by the app from its records without a turn (what each agent did, cards waiting, routines today, usage room, what failed). Call it when the user says when to brief them (\"brief me at 7:30\"), to stop it (\"stop the morning brief\" → `off: true`), to have it posted even on days with nothing to say (`always`), or to add read-only checks through a connected app (`checks`, at most 4, each `what` in their words and the `app` to look in; they run sealed, read only). `now: true` posts today's brief at once. It applies at once: say in a line what's set.";

pub fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "at": { "type": "string", "description": "When, local time: \"7:30\", \"8am\"." },
            "off": { "type": "boolean", "description": "Stop the morning brief." },
            "always": { "type": "boolean", "description": "Post it even when there's nothing worth saying." },
            "checks": {
                "type": "array",
                "description": "Replace the read-only checks (empty clears them).",
                "items": {
                    "type": "object",
                    "properties": {
                        "what": { "type": "string", "description": "What to look for: \"events on my calendar today\"." },
                        "app": { "type": "string", "description": "The connected app: \"Google Calendar\", \"Gmail\"." }
                    },
                    "required": ["what", "app"]
                }
            },
            "now": { "type": "boolean", "description": "Post today's brief now." }
        }
    })
}

/// "The morning brief is on at 08:00 …": what a turn is told, and the line.
pub fn describe(s: &Settings) -> String {
    if !s.on {
        return "The morning brief is off.".into();
    }
    let mut line = format!(
        "The morning brief is on, at {} every day",
        clock_label(s.at)
    );
    if s.always {
        line.push_str(", even on days with nothing to say");
    }
    match s.checks.len() {
        0 => {}
        n => line.push_str(&format!(", with {}", plural(n, "check", "checks"))),
    }
    line.push('.');
    line
}

/// The settings `set_morning_brief`'s arguments ask for, from `now`. Pure.
pub fn wanted(args: &serde_json::Value, now: &Settings) -> Result<Settings, String> {
    let mut next = now.clone();
    if args.get("off").and_then(serde_json::Value::as_bool) == Some(true) {
        next.on = false;
        return Ok(next);
    }
    if let Some(at) = args.get("at").and_then(serde_json::Value::as_str) {
        let (h, m) = super::schedule::clock(&at.trim().to_ascii_lowercase()).ok_or_else(|| {
            format!("`at` isn't a time: say it like \"7:30\" or \"8am\" (got {at:?}).")
        })?;
        next.at = h * 60 + m;
        next.on = true;
    }
    if let Some(always) = args.get("always").and_then(serde_json::Value::as_bool) {
        next.always = always;
        next.on = true;
    }
    if let Some(list) = args.get("checks") {
        let list = list
            .as_array()
            .ok_or("`checks` is a list of {what, app}.")?;
        next.checks = list
            .iter()
            .map(|c| Check {
                what: c
                    .get("what")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                app: c
                    .get("app")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
            .collect();
        next.on = true;
    }
    if args.get("off").is_none() && args.get("at").is_none() && args.get("now").is_none() {
        next.on = true;
    }
    checked(next)
}

/// Whether going from `now` to `next` adds a check: a read of the user's
/// apps, unattended, every day, so it wants their own ask or a card. Pure.
pub fn adds_checks(now: &Settings, next: &Settings) -> bool {
    next.on && next.checks.iter().any(|c| !now.checks.contains(c))
}

/// The card's line for adding checks. Pure.
pub fn checks_line(next: &Settings) -> String {
    let list: Vec<String> = next
        .checks
        .iter()
        .map(|c| format!("“{}” in {}", c.what, c.app))
        .collect();
    format!(
        "Every morning before your brief, read (never change): {}",
        list.join("; ")
    )
}

/* ------------------------------------------------------------ running */

static BUSY: AtomicBool = AtomicBool::new(false);

/// From the check-in tick, every minute: prepare, post or settle today's
/// brief when its time says so. The work runs off the tick.
pub fn tick(app: &tauri::AppHandle) {
    let tz = chrono::Local;
    let now = store::now_ms();
    let step = decide(&get(), &state(), &tz, now);
    if step == Step::Nothing {
        return;
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match step {
            Step::Prepare { day } => prepare(&app, &day).await.map(|_| ()),
            Step::Post { day } => post(&app, &day, false).await.map(|_| ()),
            Step::Missed { day } => save_state(|s| {
                s.settled_day = Some(day);
                s.prepared = None;
            }),
            Step::Nothing => Ok(()),
        };
        if let Err(e) = result {
            tracing::warn!(error = %e, "morning brief");
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

/// Post today's brief now, whatever the time (the Chief's `now: true`).
/// `false` when there was nothing to say (and it wasn't asked for anyway).
///
/// Boxed: a check runs through the agent bridge, whose tool calls reach
/// this again, and an unboxed future here would be its own type's part.
pub fn post_now(
    app: &tauri::AppHandle,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, CommandError>> + Send + '_>> {
    let tz = chrono::Local;
    let day = local_date(&tz, store::now_ms())
        .map(day_key)
        .unwrap_or_default();
    Box::pin(async move { post(app, &day, true).await })
}

/// Read the slow parts for `day` and keep them.
async fn prepare(app: &tauri::AppHandle, day: &str) -> Result<Prepared, CommandError> {
    let settings = get();
    let inv = super::inventory::read().await;
    let usage = (inv.totals.signed_in > 0).then(|| Usage::from_totals(&inv.totals));
    let chief = chief()?;
    let mut checks = Vec::new();
    for c in &settings.checks {
        let source = super::watch::Source::Custom {
            check: c.what.clone(),
            app: c.app.clone(),
        };
        let (found, _) = super::watch::check(app, &chief.id, &source).await;
        checks.push(match found {
            Ok(f) => CheckLine {
                what: c.what.clone(),
                app: c.app.clone(),
                items: f.events.into_iter().map(|e| e.title).collect(),
                error: None,
            },
            Err(why) => CheckLine {
                what: c.what.clone(),
                app: c.app.clone(),
                items: Vec::new(),
                error: Some(why),
            },
        });
    }
    let prepared = Prepared {
        day: day.to_string(),
        at: store::now_ms(),
        usage,
        checks,
    };
    let keep = prepared.clone();
    save_state(|s| s.prepared = Some(keep))?;
    Ok(prepared)
}

fn chief() -> Result<Agent, CommandError> {
    store::list()?
        .into_iter()
        .find(|a| a.is_main)
        .ok_or_else(|| CommandError::expected("There's no Chief of Staff to post the brief."))
}

/// How far back a log is read for the brief.
const LOG_READ: usize = 400;

/// The facts now, from disk, with what was prepared.
fn facts_now(prepared: Option<&Prepared>, since: i64, now: i64) -> Result<Facts, CommandError> {
    let agents = store::list()?;
    let logs: Vec<Vec<AgentMessage>> = agents
        .iter()
        .map(|a| store::messages(&a.id, LOG_READ).unwrap_or_default())
        .collect();
    let cards: Vec<Vec<AgentMessage>> = agents
        .iter()
        .map(|a| store::pending_card_messages(&a.id).unwrap_or_default())
        .collect();
    let records: Vec<AgentRecords> = agents
        .iter()
        .zip(logs.iter().zip(cards.iter()))
        .map(|(agent, (log, cards))| AgentRecords { agent, log, cards })
        .collect();
    let mut facts = gather(&records, since, &chrono::Local, now);
    if let Some(p) = prepared {
        facts.usage = p.usage.clone();
        facts.checks = p.checks.clone();
    }
    Ok(facts)
}

/// Where a brief's "since" starts: the last one, if within a week, else a day back.
pub fn since(last_posted_at: i64, now: i64) -> i64 {
    let day_back = now - 24 * HOUR_MS;
    if last_posted_at > 0 && last_posted_at < now && now - last_posted_at <= 7 * 24 * HOUR_MS {
        last_posted_at
    } else {
        day_back
    }
}

async fn post(app: &tauri::AppHandle, day: &str, asked: bool) -> Result<bool, CommandError> {
    let st = state();
    let prepared = match st.prepared.filter(|p| p.day == day) {
        Some(p) => p,
        None => prepare(app, day).await?,
    };
    let now = store::now_ms();
    let since = since(st.last_posted_at, now);
    let facts = tokio::task::spawn_blocking({
        let prepared = prepared.clone();
        move || facts_now(Some(&prepared), since, now)
    })
    .await
    .map_err(super::err_other)??;
    let settings = get();
    let text = compose(&facts, settings.always || asked, &chrono::Local, now);
    let chief = chief()?;
    let posted = text.is_some();
    if let Some(text) = text {
        let message = super::runner::new_message(&chief.id, MessageKind::Agent, text);
        super::runner::record(app, message)?;
    }
    let day = day.to_string();
    save_state(|s| {
        s.settled_day = Some(day);
        s.prepared = None;
        if posted {
            s.last_posted_at = now;
        }
    })?;
    Ok(posted)
}

/// For Settings and the phone: the settings and when one was last posted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(flatten)]
    pub settings: Settings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_posted_at: Option<i64>,
}

pub fn view() -> View {
    let last = state().last_posted_at;
    View {
        settings: get(),
        last_posted_at: (last > 0).then_some(last),
    }
}

#[cfg(test)]
#[path = "brief_tests.rs"]
mod tests;
