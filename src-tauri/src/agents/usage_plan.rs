//! How the user wants their plans' limits used: the budget mode, the list
//! of work to do "when there's spare capacity", and each account's last
//! reading, kept per account so the inventory can say what each one has.
//!
//! **Modes.** `Normal` (the default) never slows anything down or skimps
//! because of limits; agents say what something big will likely use before
//! they start it, and carry on. `Save` asks before heavy work and sends light
//! work to lighter models or engines. `UseItAll` is the user's standing OK
//! to spend what would otherwise expire: when a window is near its reset
//! with capacity left, on the account turns would run on next, the Chief is
//! woken with the spare-capacity list ([`should_nudge`]), once per window.
//! It changes no approval: anything that sends, spends or changes what
//! others see still waits for the user's Allow.
//!
//! **Per-account readings.** `quota.json` holds one picture per engine (the
//! account the last turn ran on). Here each account keeps its own last
//! reading, said with its age, plus the samples forecasts learn the share
//! of a window per token from (`forecast::Sample`). Both start empty and
//! fill as turns report: nothing is back-filled.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;

use super::engine::Engine;
use super::forecast::{self, Sample};
use super::quota::{self, Quota, QuotaWindow};
use crate::errors::CommandError;

const HOUR_MS: i64 = 60 * 60 * 1000;
/// "Near its reset": within a fifth of the window's length, at most a day.
const NEAR_MAX_MS: i64 = 24 * HOUR_MS;
/// "Capacity left": at least this many points of the window unused.
pub const SPARE_MIN_PERCENT: f64 = 25.0;
/// The spare-capacity list holds at most this many items.
pub const BACKLOG_MAX: usize = 50;
/// An item is at most this long.
const ITEM_MAX: usize = 600;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Normal,
    Save,
    UseItAll,
}

impl Mode {
    pub fn parse(value: &str) -> Result<Mode, CommandError> {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str()
        {
            "normal" => Ok(Mode::Normal),
            "save" | "save_my_limits" => Ok(Mode::Save),
            "use_it_all" | "use_it_all_before_reset" => Ok(Mode::UseItAll),
            _ => Err(super::err_invalid(
                "mode",
                "Pick normal, save (Save my limits) or use_it_all (Use it all before reset).",
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mode::Normal => "Normal",
            Mode::Save => "Save my limits",
            Mode::UseItAll => "Use it all before reset",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    #[default]
    Waiting,
    /// The Chief has started it (handed it to an agent, or begun it).
    Started,
}

/// Work to do when there's spare capacity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpareItem {
    pub id: String,
    pub text: String,
    /// Who should do it, when it was named (an agent's id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// "you", or the agent that added it.
    pub added_by: String,
    pub added_at: i64,
    #[serde(default)]
    pub state: ItemState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanFile {
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    mode_set_at: i64,
    #[serde(default)]
    backlog: Vec<SpareItem>,
    /// Windows the Chief was already woken for (`spare_key`).
    #[serde(default)]
    nudged: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingsFile {
    /// Each account's last reading (`engine:id`).
    #[serde(default)]
    readings: BTreeMap<String, Quota>,
    /// Each account's samples, for forecasts.
    #[serde(default)]
    samples: BTreeMap<String, Vec<Sample>>,
    /// Each account's running token count, from turns this app ran.
    #[serde(default)]
    tokens: BTreeMap<String, u64>,
    /// How each account's last check without a turn went (`usage_read`).
    #[serde(default)]
    checks: BTreeMap<String, Check>,
}

/// How a check of an account's limits without a turn came out
/// (`usage_read`). A reading itself goes where a turn's does
/// ([`archive`]); this says only whether it could be read, and when.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    /// Read: its reading is the account's own, with this time.
    Read,
    /// The engine answered with no plan windows for this login.
    NoPlan,
    /// This account can't be read without a turn (a sign-in that may not
    /// read limits, signed out, or a token only its engine can refresh).
    CantRead,
    /// The engine or the network didn't answer this time.
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub at: i64,
    pub outcome: CheckOutcome,
    /// Why, in a few plain words, when it wasn't read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// How it was read, when not the usual way (`usage_read`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<CheckVia>,
}

/// How a reading was taken without a turn, when not the engine's own usage read.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckVia {
    /// From the rate-limit headers of a one-token request (a setup-token
    /// Claude sign-in, which the usage endpoint refuses).
    Headers,
}

pub fn account_key(engine: Engine, id: &str) -> String {
    let word = match engine {
        Engine::Claude => "claude",
        Engine::Codex => "codex",
    };
    format!("{word}:{id}")
}

/* ------------------------------------------------------------- spare */

/// A window near its reset with capacity left.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spare {
    pub engine: Engine,
    pub account_id: String,
    pub account_name: String,
    /// Turns on this engine run on this account next.
    pub next: bool,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<i64>,
    pub used_percent: f64,
    pub resets_at: i64,
    pub observed_at: i64,
}

/// How long a window is, from what the engine said: Codex's
/// `windowDurationMins`, else Claude Code's window names, which say it
/// (`five_hour`, `seven_day…`). Another name: unknown.
pub fn window_ms(w: &QuotaWindow) -> Option<i64> {
    if let Some(m) = w.window_minutes.filter(|m| *m > 0) {
        return Some(m * 60 * 1000);
    }
    match w.kind.as_str() {
        "five_hour" => Some(5 * HOUR_MS),
        k if k.starts_with("seven_day") => Some(7 * 24 * HOUR_MS),
        _ => None,
    }
}

/// Whether `w` is near its reset with capacity left, at `now`.
pub fn is_spare(w: &QuotaWindow, now: i64) -> bool {
    let (Some(reset), Some(used), Some(len)) = (w.resets_at, w.used_percent, window_ms(w)) else {
        return false;
    };
    let near = (len / 5).min(NEAR_MAX_MS);
    !w.limited && reset > now && reset - now <= near && 100.0 - used >= SPARE_MIN_PERCENT
}

/// An account's reading, as the inventory has it.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountReading {
    pub engine: Engine,
    pub account_id: String,
    pub account_name: String,
    pub next: bool,
    pub quota: Quota,
}

/// Every spare window, soonest reset first.
pub fn spare(readings: &[AccountReading], now: i64) -> Vec<Spare> {
    let mut out: Vec<Spare> = readings
        .iter()
        .flat_map(|r| {
            r.quota
                .windows
                .iter()
                .filter(|w| is_spare(w, now))
                .map(move |w| Spare {
                    engine: r.engine,
                    account_id: r.account_id.clone(),
                    account_name: r.account_name.clone(),
                    next: r.next,
                    kind: w.kind.clone(),
                    window_minutes: w.window_minutes,
                    used_percent: w.used_percent.unwrap_or(0.0),
                    resets_at: w.resets_at.unwrap_or(0),
                    observed_at: w.observed_at,
                })
        })
        .collect();
    out.sort_by_key(|s| s.resets_at);
    out
}

pub fn spare_key(s: &Spare) -> String {
    format!(
        "{}:{}:{}",
        account_key(s.engine, &s.account_id),
        s.kind,
        s.resets_at
    )
}

/// Whether to wake the Chief to use a spare window, and for which: only in
/// `UseItAll`, only with work waiting, only while the Chief is free, only
/// for the account turns would actually run on next (spare capacity on
/// another account wouldn't be what the work spends), and once per window.
pub fn should_nudge<'a>(
    mode: Mode,
    spare: &'a [Spare],
    waiting: usize,
    chief_busy: bool,
    nudged: &[String],
) -> Option<&'a Spare> {
    if mode != Mode::UseItAll || waiting == 0 || chief_busy {
        return None;
    }
    spare
        .iter()
        .find(|s| s.next && !nudged.iter().any(|k| same_window(k, s)))
}

/// Whether `key` (a `spare_key`) is `s`'s window instance. A reset time
/// reported a little differently by a later reading (rounding, a second's
/// drift) is still the same instance: windows are hours long, so any two
/// resets of one kind within the slack are one window, and the Chief is
/// never woken twice for it.
fn same_window(key: &str, s: &Spare) -> bool {
    const SLACK_MS: i64 = 30 * 60 * 1000;
    let Some((prefix, at)) = key.rsplit_once(':') else {
        return false;
    };
    let Ok(at) = at.parse::<i64>() else {
        return key == spare_key(s);
    };
    let want = spare_key(s);
    let want_prefix = want.rsplit_once(':').map_or(want.as_str(), |(p, _)| p);
    prefix == want_prefix && (at - s.resets_at).abs() <= SLACK_MS
}

/// Whether work forecast to use `percent` of a window needs the user's OK
/// first. In `Save`, anything heavy does: a tenth of a window, or more than
/// a known forecast can say (`None`, no forecast) for a fan-out. Elsewhere
/// it is said, not asked: `Normal` never slows down for limits, and
/// `UseItAll` is a standing OK.
pub fn ask_first(mode: Mode, percent: Option<f64>, fan_out: bool) -> bool {
    match mode {
        Mode::Save => match percent {
            Some(p) => p >= 10.0,
            None => fan_out,
        },
        Mode::Normal | Mode::UseItAll => false,
    }
}

/* -------------------------------------------------------------- disk */

static LOCK: Mutex<()> = Mutex::new(());

fn plan_path() -> Result<std::path::PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join("usage-plan.json"))
}

fn readings_path() -> Result<std::path::PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join("usage-readings.json"))
}

fn read_json<T: Default + for<'de> Deserialize<'de>>(
    path: Result<std::path::PathBuf, CommandError>,
) -> T {
    path.ok()
        .and_then(|p| super::survive::read_kept(&p, "Your usage settings"))
        .unwrap_or_default()
}

fn write_json<T: Serialize>(
    path: Result<std::path::PathBuf, CommandError>,
    value: &T,
) -> Result<(), CommandError> {
    let path = path?;
    let json = serde_json::to_vec_pretty(value).map_err(super::err_other)?;
    super::store::write_atomic(&path, &json)
}

fn change_plan<T>(
    f: impl FnOnce(&mut PlanFile) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file: PlanFile = read_json(plan_path());
    let out = f(&mut file)?;
    write_json(plan_path(), &file)?;
    Ok(out)
}

fn change_readings(f: impl FnOnce(&mut ReadingsFile)) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file: ReadingsFile = read_json(readings_path());
    f(&mut file);
    if let Err(e) = write_json(readings_path(), &file) {
        tracing::warn!("[Agents] usage readings not saved: {e}");
    }
}

/// The mode and when it was set (0: never set, the default).
pub fn mode() -> (Mode, i64) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file: PlanFile = read_json(plan_path());
    (file.mode, file.mode_set_at)
}

pub fn set_mode(mode: Mode, now: i64) -> Result<(), CommandError> {
    change_plan(|f| {
        if f.mode != mode {
            f.mode = mode;
            f.mode_set_at = now;
        }
        Ok(())
    })
}

pub fn backlog() -> Vec<SpareItem> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_json::<PlanFile>(plan_path()).backlog
}

fn clean_text(text: &str) -> Result<String, CommandError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(super::err_invalid("text", "Say what to do."));
    }
    Ok(if text.chars().count() > ITEM_MAX {
        text.chars().take(ITEM_MAX - 1).collect::<String>() + "…"
    } else {
        text.to_string()
    })
}

pub fn add_item(
    text: &str,
    agent_id: Option<String>,
    added_by: &str,
    now: i64,
) -> Result<SpareItem, CommandError> {
    let text = clean_text(text)?;
    change_plan(|f| {
        if f.backlog.len() >= BACKLOG_MAX {
            return Err(super::err_invalid(
                "text",
                "The spare-capacity list is full (50). Finish or remove something first.",
            ));
        }
        let item = SpareItem {
            id: super::store::new_id(),
            text,
            agent_id,
            added_by: added_by.to_string(),
            added_at: now,
            state: ItemState::Waiting,
            started_at: None,
        };
        f.backlog.push(item.clone());
        Ok(item)
    })
}

/// Start an item, or take it off the list (`done`). Unknown id: an error.
pub fn settle_item(id: &str, done: bool, now: i64) -> Result<SpareItem, CommandError> {
    change_plan(|f| {
        let at = f.backlog.iter().position(|i| i.id == id).ok_or_else(|| {
            super::err_invalid("id", "There's no spare-capacity item with that id.")
        })?;
        if done {
            return Ok(f.backlog.remove(at));
        }
        let item = &mut f.backlog[at];
        item.state = ItemState::Started;
        item.started_at = Some(now);
        Ok(item.clone())
    })
}

/// Note a window the Chief was woken for (keeping the last 50).
pub fn mark_nudged(key: String) -> Result<(), CommandError> {
    change_plan(|f| {
        if !f.nudged.contains(&key) {
            f.nudged.push(key);
        }
        let extra = f.nudged.len().saturating_sub(50);
        f.nudged.drain(..extra);
        Ok(())
    })
}

pub fn nudged() -> Vec<String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_json::<PlanFile>(plan_path()).nudged
}

/// A turn on `account` reported `turn`'s tokens.
pub fn add_tokens(engine: Engine, account: &str, turn: &super::usage::UsageTotals) {
    let n = forecast::tokens(turn);
    if n == 0 {
        return;
    }
    let key = account_key(engine, account);
    change_readings(|f| {
        let count = f.tokens.entry(key).or_default();
        *count = count.saturating_add(n);
    });
}

/// A reading arrived from a turn on `account`: kept as its own, and each
/// window with a figure kept as a sample against its token count. A reading
/// with no windows (no plan on this login) clears the account's.
pub fn archive(account: &str, reading: &Quota, now: i64) {
    let key = account_key(reading.engine, account);
    change_readings(|f| {
        if reading.windows.is_empty() {
            f.readings.remove(&key);
            return;
        }
        let mut known: Vec<Quota> = f.readings.get(&key).cloned().into_iter().collect();
        quota::merge(&mut known, reading.clone(), now);
        match known.pop() {
            Some(q) => {
                f.readings.insert(key.clone(), q);
            }
            None => {
                f.readings.remove(&key);
            }
        }
        let tokens = f.tokens.get(&key).copied().unwrap_or(0);
        let samples = f.samples.entry(key).or_default();
        for w in &reading.windows {
            if let Some(used) = w.used_percent {
                forecast::keep_sample(
                    samples,
                    Sample {
                        kind: w.kind.clone(),
                        resets_at: w.resets_at,
                        used,
                        tokens,
                        at: now,
                    },
                    now,
                );
            }
        }
    });
}

/// Forget an account's reading (its engine said it's signed out).
pub fn forget_reading(engine: Engine, account: &str) {
    let key = account_key(engine, account);
    change_readings(|f| {
        f.readings.remove(&key);
    });
}

/// Note how an account's check without a turn went. True when that is
/// news (a different outcome from the last check).
pub fn set_check(engine: Engine, account: &str, check: Check) -> bool {
    let key = account_key(engine, account);
    let mut news = false;
    change_readings(|f| {
        news = f
            .checks
            .get(&key)
            .is_none_or(|c| c.outcome != check.outcome || c.why != check.why);
        f.checks.insert(key, check);
    });
    news
}

/// Every account's last check without a turn.
pub fn checks() -> BTreeMap<String, Check> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_json::<ReadingsFile>(readings_path()).checks
}

/// Every account's last reading and samples, as stored.
pub fn readings() -> (BTreeMap<String, Quota>, BTreeMap<String, Vec<Sample>>) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let f: ReadingsFile = read_json(readings_path());
    (f.readings, f.samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_867_800_000;

    fn w(kind: &str, used: f64, resets_in: i64, minutes: Option<i64>) -> QuotaWindow {
        QuotaWindow {
            kind: kind.into(),
            used_percent: Some(used),
            resets_at: Some(NOW + resets_in),
            window_minutes: minutes,
            limited: false,
            observed_at: NOW - HOUR_MS,
        }
    }

    fn reading(id: &str, next: bool, windows: Vec<QuotaWindow>) -> AccountReading {
        AccountReading {
            engine: Engine::Claude,
            account_id: id.into(),
            account_name: id.into(),
            next,
            quota: Quota {
                engine: Engine::Claude,
                windows,
                plan: None,
            },
        }
    }

    #[test]
    fn modes_parse_from_what_people_say() {
        assert_eq!(Mode::parse("Normal").unwrap(), Mode::Normal);
        assert_eq!(Mode::parse("save my limits").unwrap(), Mode::Save);
        assert_eq!(Mode::parse("use-it-all").unwrap(), Mode::UseItAll);
        assert!(Mode::parse("turbo").is_err());
        // The default, for a file that never set one.
        assert_eq!(
            serde_json::from_str::<PlanFile>("{}").unwrap().mode,
            Mode::Normal
        );
        assert_eq!(
            serde_json::to_string(&Mode::UseItAll).unwrap(),
            "\"use_it_all\""
        );
    }

    #[test]
    fn spare_means_near_the_reset_with_a_quarter_left() {
        // 5-hour window: near is the last hour.
        assert!(is_spare(&w("five_hour", 40.0, 30 * 60_000, None), NOW));
        assert!(!is_spare(&w("five_hour", 40.0, 2 * HOUR_MS, None), NOW));
        // Too little left.
        assert!(!is_spare(&w("five_hour", 80.0, 30 * 60_000, None), NOW));
        // Weekly: near is the last day.
        assert!(is_spare(&w("seven_day", 10.0, 20 * HOUR_MS, None), NOW));
        assert!(!is_spare(&w("seven_day", 10.0, 30 * HOUR_MS, None), NOW));
        // Codex says its length.
        assert!(is_spare(&w("primary", 0.0, 50 * 60_000, Some(300)), NOW));
        // A window we can't size, or one already past, is never spare.
        assert!(!is_spare(&w("mystery", 0.0, 60_000, None), NOW));
        assert!(!is_spare(&w("five_hour", 0.0, -60_000, None), NOW));
        let mut limited = w("five_hour", 10.0, 60_000, None);
        limited.limited = true;
        assert!(!is_spare(&limited, NOW));
        // No figure: no claim.
        let mut blank = w("five_hour", 0.0, 60_000, None);
        blank.used_percent = None;
        assert!(!is_spare(&blank, NOW));
    }

    #[test]
    fn spare_windows_come_soonest_first() {
        let all = [
            reading("a", true, vec![w("seven_day", 10.0, 20 * HOUR_MS, None)]),
            reading("b", false, vec![w("five_hour", 10.0, 10 * 60_000, None)]),
        ];
        let s = spare(&all, NOW);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].account_id, "b");
    }

    #[test]
    fn the_chief_is_woken_only_in_use_it_all_and_once_per_window() {
        let all = [
            reading(
                "other",
                false,
                vec![w("five_hour", 10.0, 10 * 60_000, None)],
            ),
            reading("next", true, vec![w("five_hour", 30.0, 40 * 60_000, None)]),
        ];
        let s = spare(&all, NOW);
        assert_eq!(should_nudge(Mode::Normal, &s, 3, false, &[]), None);
        assert_eq!(should_nudge(Mode::Save, &s, 3, false, &[]), None);
        assert_eq!(should_nudge(Mode::UseItAll, &s, 0, false, &[]), None);
        assert_eq!(should_nudge(Mode::UseItAll, &s, 3, true, &[]), None);
        // Not the account work would run on: never that one.
        let chosen = should_nudge(Mode::UseItAll, &s, 3, false, &[]).unwrap();
        assert_eq!(chosen.account_id, "next");
        let done = [spare_key(chosen)];
        assert_eq!(should_nudge(Mode::UseItAll, &s, 3, false, &done), None);
        // A later reading that puts the same reset a few seconds off is the
        // same window: not a second wake.
        let drifted = [spare_key(&Spare {
            resets_at: chosen.resets_at + 7_000,
            ..chosen.clone()
        })];
        assert_eq!(should_nudge(Mode::UseItAll, &s, 3, false, &drifted), None);
        // The next window of that kind (hours later) is a new one.
        let earlier = [spare_key(&Spare {
            resets_at: chosen.resets_at - 5 * HOUR_MS,
            ..chosen.clone()
        })];
        assert!(should_nudge(Mode::UseItAll, &s, 3, false, &earlier).is_some());
    }

    #[test]
    fn only_save_asks_before_heavy_work() {
        assert!(!ask_first(Mode::Normal, Some(80.0), true));
        assert!(!ask_first(Mode::UseItAll, Some(80.0), true));
        assert!(ask_first(Mode::Save, Some(10.0), false));
        assert!(!ask_first(Mode::Save, Some(2.0), false));
        assert!(ask_first(Mode::Save, None, true));
        assert!(!ask_first(Mode::Save, None, false));
    }

    fn with_root(f: impl FnOnce()) {
        let _serial = crate::agents::store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        crate::agents::store::set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        crate::agents::store::set_root_for_tests(None);
    }

    #[test]
    fn nothing_stored_reads_as_normal_with_no_readings() {
        with_root(|| {
            // A Mac upgrading from before this file existed.
            assert_eq!(mode(), (Mode::Normal, 0));
            assert!(backlog().is_empty());
            let (readings, samples) = readings();
            assert!(readings.is_empty() && samples.is_empty());
        });
    }

    #[test]
    fn each_account_keeps_its_own_reading_and_samples_against_its_tokens() {
        with_root(|| {
            let turn = crate::agents::usage::UsageTotals {
                turns: 1,
                input_tokens: 1_000,
                output_tokens: 500,
                ..Default::default()
            };
            let q = |used: f64| Quota {
                engine: Engine::Claude,
                windows: vec![w("five_hour", used, HOUR_MS, None)],
                plan: None,
            };
            archive("default", &q(10.0), NOW);
            add_tokens(Engine::Claude, "default", &turn);
            add_tokens(Engine::Claude, "default", &turn);
            archive("default", &q(14.0), NOW + 1);
            archive("w1", &q(70.0), NOW + 2);
            let (kept, samples) = readings();
            assert_eq!(kept["claude:default"].windows[0].used_percent, Some(14.0));
            assert_eq!(kept["claude:w1"].windows[0].used_percent, Some(70.0));
            let mine = &samples["claude:default"];
            assert_eq!(
                mine.iter().map(|s| s.tokens).collect::<Vec<_>>(),
                vec![0, 3_000]
            );
            let rate = forecast::rate(mine, "five_hour").unwrap();
            assert!((rate - 4.0 / 3_000.0).abs() < 1e-12);
            // No plan on this login: its reading goes, the other's stays.
            archive("default", &quota::none(Engine::Claude), NOW + 3);
            let (kept, _) = readings();
            assert!(!kept.contains_key("claude:default"));
            assert!(kept.contains_key("claude:w1"));
            forget_reading(Engine::Claude, "w1");
            assert!(readings_is_empty());
        });
    }

    fn readings_is_empty() -> bool {
        readings().0.is_empty()
    }

    #[test]
    fn the_list_and_the_mode_persist() {
        with_root(|| {
            set_mode(Mode::UseItAll, 5).unwrap();
            assert_eq!(mode(), (Mode::UseItAll, 5));
            let item = add_item(" Summarise the papers ", None, "you", 7).unwrap();
            assert_eq!(item.text, "Summarise the papers");
            let started = settle_item(&item.id, false, 9).unwrap();
            assert_eq!(
                (started.state, started.started_at),
                (ItemState::Started, Some(9))
            );
            assert_eq!(backlog()[0].state, ItemState::Started);
            settle_item(&item.id, true, 10).unwrap();
            assert!(backlog().is_empty());
            assert!(settle_item(&item.id, true, 11).is_err());
            mark_nudged("k".into()).unwrap();
            mark_nudged("k".into()).unwrap();
            assert_eq!(nudged(), vec!["k".to_string()]);
        });
    }

    #[test]
    fn items_are_trimmed_and_never_empty() {
        assert!(clean_text("   ").is_err());
        assert_eq!(
            clean_text("  Read the backlog  ").unwrap(),
            "Read the backlog"
        );
        assert_eq!(
            clean_text(&"x".repeat(900)).unwrap().chars().count(),
            ITEM_MAX
        );
    }
}
