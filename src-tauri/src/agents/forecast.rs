//! Forecasts: what a turn, a routine or a fan-out will probably use, from
//! this user's own past runs. **Estimates, never readings.**
//!
//! The project rule for *readings* stands (`usage.rs`, `quota.rs`): a figure
//! shown as what an engine reported is only ever what it reported. A forecast
//! is a different thing and is always said as one: every value here comes out
//! labelled `estimate` with how many past runs it rests on, and when there is
//! too little history there is no forecast at all (`None`), never a guess
//! from nothing or a default.
//!
//! Two kinds of history feed it:
//!
//! - **Tokens per run**: the per-day totals already kept for every agent and
//!   routine (`AgentUsage::days`, the last 7 days). So history from before
//!   this module existed is used at once. A day on which an agent also ran
//!   model checks ("When…" routines) is left out of its per-turn figure:
//!   those days' tokens mix turns and checks and can't be split honestly.
//! - **Share of a plan window per token** ([`Sample`], [`rate`]): engines
//!   report a window's use as a percentage, never in tokens, so the link
//!   between the two is learned from this Mac's own readings: two readings
//!   of the same window (same kind, same reset) with the tokens this app's
//!   turns reported on that account in between. Use of the same plan
//!   elsewhere (the CLI, the web) moves the percentage without moving our
//!   token count, so the rate errs high: a forecast share is an upper-side
//!   estimate. This history starts when the readings are first recorded,
//!   so until two readings a percentage point apart exist, a forecast gives
//!   tokens only.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::quota::QuotaWindow;
use super::usage::{DayUsage, UsageTotals};

/// Fewer past runs than this: no forecast.
pub const MIN_RUNS: u32 = 5;
/// The window's reported use must have moved at least this many percentage
/// points across the samples before a rate is learned from them.
pub const MIN_RATE_DELTA: f64 = 2.0;
/// Samples older than this are dropped.
pub const SAMPLE_KEEP_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// At most this many samples per account and window kind.
pub const SAMPLE_MAX: usize = 400;

/// Every token a run reported, the figure the rest of the app calls
/// "tokens" (the watch card and the cost lines count the same four).
pub fn tokens(t: &UsageTotals) -> u64 {
    t.input_tokens
        .saturating_add(t.output_tokens)
        .saturating_add(t.cache_read_tokens)
        .saturating_add(t.cache_write_tokens)
}

/// What one run (a turn, or a model check) has used, from past runs.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerRun {
    /// Always true: this is an estimate from past runs, not a reading.
    pub estimate: bool,
    /// The average over the runs below, in tokens.
    pub tokens: u64,
    /// The lightest and heaviest day's average, in tokens.
    pub low: u64,
    pub high: u64,
    /// How many past runs, over how many days, it rests on.
    pub runs: u32,
    pub days: u32,
}

/// Which runs a day's totals are counted as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    /// Turns: days that also had model checks are left out.
    Turns,
    /// Model checks: days that also had turns are left out.
    Checks,
}

fn in_week(day: &str, today: NaiveDate) -> bool {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map(|d| d <= today && (today - d).num_days() < 7)
        .unwrap_or(false)
}

/// Per run, from per-day totals. `None` with fewer than [`MIN_RUNS`] runs.
pub fn per_run(days: &[DayUsage], unit: Unit, today: NaiveDate) -> Option<PerRun> {
    let mut runs = 0u32;
    let mut total = 0u64;
    let mut averages: Vec<u64> = Vec::new();
    for d in days.iter().filter(|d| in_week(&d.day, today)) {
        let t = &d.totals;
        let n = match unit {
            Unit::Turns if t.checks == 0 => t.turns,
            Unit::Checks if t.turns == 0 => t.checks,
            _ => continue,
        };
        if n == 0 {
            continue;
        }
        let tok = tokens(t);
        runs += n;
        total = total.saturating_add(tok);
        averages.push(tok / u64::from(n));
    }
    if runs < MIN_RUNS {
        return None;
    }
    Some(PerRun {
        estimate: true,
        tokens: total / u64::from(runs),
        low: averages.iter().copied().min().unwrap_or(0),
        high: averages.iter().copied().max().unwrap_or(0),
        runs,
        days: averages.len() as u32,
    })
}

/// Several histories pooled (every agent on one engine, say): their days
/// added together, then [`per_run`].
pub fn pooled(histories: &[&[DayUsage]], unit: Unit, today: NaiveDate) -> Option<PerRun> {
    let mut by_day: std::collections::BTreeMap<String, UsageTotals> = Default::default();
    for days in histories {
        for d in days.iter() {
            // A mixed day stays out of the pool too, per history.
            let t = &d.totals;
            let keep = match unit {
                Unit::Turns => t.checks == 0,
                Unit::Checks => t.turns == 0,
            };
            if keep {
                by_day.entry(d.day.clone()).or_default().add(t);
            }
        }
    }
    let days: Vec<DayUsage> = by_day
        .into_iter()
        .map(|(day, totals)| DayUsage { day, totals })
        .collect();
    per_run(&days, unit, today)
}

/* ------------------------------------------------- share of the window */

/// One reading of a plan window, with the tokens this app's runs had
/// reported on that account when it arrived.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
    /// 0–100, as reported.
    pub used: f64,
    /// The account's running token count (`tokens`) at the time.
    pub tokens: u64,
    pub at: i64,
}

/// Keep `sample`, dropping old ones and a repeat of the last (same figure,
/// same tokens: nothing happened in between).
pub fn keep_sample(samples: &mut Vec<Sample>, sample: Sample, now: i64) {
    samples.retain(|s| now - s.at < SAMPLE_KEEP_MS);
    if samples.last().is_some_and(|l| {
        l.kind == sample.kind
            && l.resets_at == sample.resets_at
            && l.tokens == sample.tokens
            && (l.used - sample.used).abs() < f64::EPSILON
    }) {
        return;
    }
    samples.push(sample);
    if samples.len() > SAMPLE_MAX {
        let extra = samples.len() - SAMPLE_MAX;
        samples.drain(..extra);
    }
}

/// Percentage points of `kind`'s window per token, learned from samples of
/// that window: within each instance of it (one reset), the first and last
/// sample; pooled over instances. `None` until the reported use has moved by
/// [`MIN_RATE_DELTA`] points with tokens recorded in between.
pub fn rate(samples: &[Sample], kind: &str) -> Option<f64> {
    let mut instances: Vec<(Option<i64>, &Sample, &Sample)> = Vec::new();
    for s in samples.iter().filter(|s| s.kind == kind) {
        match instances.iter_mut().find(|(r, _, _)| *r == s.resets_at) {
            Some(inst) => inst.2 = s,
            None => instances.push((s.resets_at, s, s)),
        }
    }
    let (mut used, mut tok) = (0.0f64, 0u64);
    for (_, first, last) in instances {
        // The counter only grows; a window's use only grows until its reset.
        if last.tokens > first.tokens && last.used > first.used {
            used += last.used - first.used;
            tok += last.tokens - first.tokens;
        }
    }
    (used >= MIN_RATE_DELTA && tok > 0).then(|| used / tok as f64)
}

/// What a planned piece of work would use of one window, by estimate.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowShare {
    pub estimate: bool,
    pub kind: String,
    /// Percentage points of the window, by estimate (rounded up to 1).
    pub percent: f64,
    /// What was left of it at the last reading, as reported.
    pub left_reported: f64,
    /// Whether the estimate fits in what was left.
    pub fits: bool,
}

/// `tokens` against a window whose last reading said `used` percent.
pub fn share(tokens: u64, rate: f64, kind: &str, used: f64) -> WindowShare {
    let percent = (tokens as f64 * rate).max(0.0);
    let left = (100.0 - used).max(0.0);
    WindowShare {
        estimate: true,
        kind: kind.to_string(),
        // Up to the next tenth, ignoring float dust (50.0000001 is 50.0).
        percent: (percent * 10.0 - 1e-6).ceil() / 10.0,
        left_reported: left,
        fits: percent <= left,
    }
}

/* ------------------------------------------------------------- pace */

/// Fewer readings of one window instance than this: no pace.
pub const PACE_MIN_READINGS: usize = 3;
/// The readings must span at least this long.
pub const PACE_MIN_SPAN_MS: i64 = 30 * 60 * 1000;
/// The window's reported use must have risen at least this many points
/// across them; less is flat, and flat use never runs out.
pub const PACE_MIN_RISE: f64 = 1.0;
/// Two readings of one window whose resets are this close are the same
/// instance of it (Claude Code's reported reset can move a little).
const SAME_RESET_MS: i64 = 30 * 60 * 1000;
const PACE_HOUR_MS: i64 = 60 * 60 * 1000;

/// How far back "the recent rate" looks: half the window, at least an hour
/// and at most a day (a weekly window's last day, not its last hour, so a
/// burst of work isn't read as the whole week's pace). A window we can't
/// size looks back two hours.
fn pace_lookback_ms(w: &QuotaWindow) -> i64 {
    super::usage_plan::window_ms(w)
        .map(|len| (len / 2).clamp(PACE_HOUR_MS, 24 * PACE_HOUR_MS))
        .unwrap_or(2 * PACE_HOUR_MS)
}

/// When a window reaches 100% at the recent rate. **An estimate, never a
/// reading**: the straight line through this account's own readings of
/// this window instance, extended from the latest one. Served only when it
/// says something (see [`pace`]).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pace {
    /// Always true: extrapolated from readings, not a reading.
    pub estimate: bool,
    /// The window it is for (`five_hour`, `seven_day`, `primary`, …).
    pub kind: String,
    /// That window's reset, as reported, epoch ms.
    pub resets_at: i64,
    /// When it would reach 100% at the recent rate, epoch ms.
    pub reaches_at: i64,
    /// How many readings, over how many minutes, it rests on.
    pub readings: u32,
    pub span_minutes: u32,
}

/// The pace of `window` (its current reading) from `samples` (the
/// account's, every window kind), at `now`. `None` unless there are at
/// least [`PACE_MIN_READINGS`] readings of this instance of the window
/// within the lookback, spanning [`PACE_MIN_SPAN_MS`], risen by
/// [`PACE_MIN_RISE`] points, and the line crosses 100% after now and
/// before the reset.
pub fn pace(samples: &[Sample], window: &QuotaWindow, now: i64) -> Option<Pace> {
    let reset = window.resets_at.filter(|&r| r > now)?;
    let used_now = window.used_percent?;
    if window.limited || used_now >= 100.0 {
        // Used up already: the meter says so; there is nothing to forecast.
        return None;
    }
    let since = now - pace_lookback_ms(window);
    let mut points: Vec<(i64, f64)> = samples
        .iter()
        .filter(|s| s.kind == window.kind && s.at >= since && s.at <= now)
        .filter(|s| {
            s.resets_at
                .is_some_and(|r| (r - reset).abs() <= SAME_RESET_MS)
        })
        .map(|s| (s.at, s.used))
        .collect();
    points.sort_by_key(|p| p.0);
    // The current reading is the last point when it's newer than every
    // sample (a repeat isn't kept as a sample, but time has still passed).
    let newer = points.last().map_or(true, |p| window.observed_at > p.0);
    if newer && window.observed_at >= since && window.observed_at <= now {
        points.push((window.observed_at, used_now));
    }
    if points.len() < PACE_MIN_READINGS {
        return None;
    }
    let (first, last) = (points[0], points[points.len() - 1]);
    let span = last.0 - first.0;
    if span < PACE_MIN_SPAN_MS || last.1 - first.1 < PACE_MIN_RISE {
        return None;
    }
    // Least squares: points per ms, time measured from the first reading.
    let n = points.len() as f64;
    let t = |p: &(i64, f64)| (p.0 - first.0) as f64;
    let mean_t = points.iter().map(t).sum::<f64>() / n;
    let mean_u = points.iter().map(|p| p.1).sum::<f64>() / n;
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for p in &points {
        let dt = t(p) - mean_t;
        num += dt * (p.1 - mean_u);
        den += dt * dt;
    }
    let slope = if den > 0.0 { num / den } else { 0.0 };
    if slope <= 0.0 || !slope.is_finite() {
        return None;
    }
    let reaches_at = last.0 + ((100.0 - last.1).max(0.0) / slope).round() as i64;
    (reaches_at > now && reaches_at < reset).then(|| Pace {
        estimate: true,
        kind: window.kind.clone(),
        resets_at: reset,
        reaches_at,
        readings: points.len() as u32,
        span_minutes: (span / 60_000) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn d(day: &str, turns: u32, checks: u32, input: u64) -> DayUsage {
        DayUsage {
            day: day.into(),
            totals: UsageTotals {
                turns,
                checks,
                input_tokens: input,
                ..Default::default()
            },
        }
    }

    #[test]
    fn too_little_history_gives_no_forecast() {
        let today = day("2026-11-05");
        assert_eq!(per_run(&[], Unit::Turns, today), None);
        // Four turns: one short of a forecast.
        assert_eq!(
            per_run(&[d("2026-11-05", 4, 0, 4000)], Unit::Turns, today),
            None
        );
        // Old days don't count: ten turns, all outside the week.
        assert_eq!(
            per_run(&[d("2026-10-20", 10, 0, 10_000)], Unit::Turns, today),
            None
        );
    }

    #[test]
    fn per_turn_is_the_average_with_the_spread_of_days() {
        let today = day("2026-11-05");
        let days = [d("2026-11-03", 2, 0, 20_000), d("2026-11-05", 4, 0, 80_000)];
        let est = per_run(&days, Unit::Turns, today).unwrap();
        assert!(est.estimate);
        assert_eq!(est.runs, 6);
        assert_eq!(est.days, 2);
        assert_eq!(est.tokens, 100_000 / 6);
        assert_eq!((est.low, est.high), (10_000, 20_000));
    }

    #[test]
    fn a_day_mixing_turns_and_checks_is_left_out() {
        let today = day("2026-11-05");
        let days = [
            d("2026-11-04", 5, 0, 50_000),
            // Its tokens mix turns and checks: neither figure uses it.
            d("2026-11-05", 3, 40, 900_000),
        ];
        let turns = per_run(&days, Unit::Turns, today).unwrap();
        assert_eq!((turns.runs, turns.tokens), (5, 10_000));
        assert_eq!(per_run(&days, Unit::Checks, today), None);
        let checks = per_run(&[d("2026-11-05", 0, 6, 6_000)], Unit::Checks, today).unwrap();
        assert_eq!(checks.tokens, 1_000);
    }

    #[test]
    fn pooled_history_adds_agents_together() {
        let today = day("2026-11-05");
        let a = [d("2026-11-05", 3, 0, 30_000)];
        let b = [d("2026-11-05", 3, 0, 90_000)];
        assert_eq!(per_run(&a, Unit::Turns, today), None);
        let both = pooled(&[&a, &b], Unit::Turns, today).unwrap();
        assert_eq!((both.runs, both.tokens), (6, 20_000));
    }

    fn s(kind: &str, reset: i64, used: f64, tokens: u64, at: i64) -> Sample {
        Sample {
            kind: kind.into(),
            resets_at: Some(reset),
            used,
            tokens,
            at,
        }
    }

    #[test]
    fn a_rate_needs_the_reading_to_have_moved() {
        // One sample, or a move under two points: no rate.
        assert_eq!(rate(&[s("five_hour", 1, 10.0, 0, 0)], "five_hour"), None);
        assert_eq!(
            rate(
                &[
                    s("five_hour", 1, 10.0, 0, 0),
                    s("five_hour", 1, 11.0, 100_000, 1)
                ],
                "five_hour"
            ),
            None
        );
        // 10 points over 1M tokens: 1e-5 points per token.
        let samples = [
            s("five_hour", 1, 10.0, 0, 0),
            s("five_hour", 1, 14.0, 400_000, 1),
            s("five_hour", 1, 20.0, 1_000_000, 2),
            s("seven_day", 9, 1.0, 0, 0),
        ];
        let r = rate(&samples, "five_hour").unwrap();
        assert!((r - 1e-5).abs() < 1e-12);
        assert_eq!(rate(&samples, "seven_day"), None);
    }

    #[test]
    fn a_reset_starts_a_new_instance_and_instances_pool() {
        let samples = [
            s("five_hour", 1, 80.0, 0, 0),
            s("five_hour", 1, 90.0, 1_000_000, 1),
            // Reset: 3% now, which must not read as a fall of 87 points.
            s("five_hour", 2, 3.0, 1_000_000, 2),
            s("five_hour", 2, 13.0, 2_000_000, 3),
        ];
        let r = rate(&samples, "five_hour").unwrap();
        assert!((r - 1e-5).abs() < 1e-12);
    }

    #[test]
    fn samples_drop_repeats_and_age() {
        let mut v = Vec::new();
        keep_sample(&mut v, s("five_hour", 1, 10.0, 5, 0), 0);
        keep_sample(&mut v, s("five_hour", 1, 10.0, 5, 10), 10);
        assert_eq!(v.len(), 1);
        keep_sample(
            &mut v,
            s("five_hour", 1, 12.0, 9, SAMPLE_KEEP_MS + 1),
            SAMPLE_KEEP_MS + 1,
        );
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].used, 12.0);
    }

    const MIN: i64 = 60_000;
    const T0: i64 = 1_793_867_800_000;

    /// The five-hour window's current reading: `used` at `at`, resetting at `reset`.
    fn win(used: f64, at: i64, reset: i64) -> QuotaWindow {
        QuotaWindow {
            kind: "five_hour".into(),
            used_percent: Some(used),
            resets_at: Some(reset),
            window_minutes: None,
            limited: false,
            observed_at: at,
        }
    }

    /// Readings of the five-hour window every `every` minutes from T0, one per figure.
    fn climb(figures: &[f64], every: i64, reset: i64) -> Vec<Sample> {
        figures
            .iter()
            .enumerate()
            .map(|(i, &u)| {
                s(
                    "five_hour",
                    reset,
                    u,
                    i as u64 * 1000,
                    T0 + i as i64 * every * MIN,
                )
            })
            .collect()
    }

    #[test]
    fn pace_extends_a_steady_climb_to_100_before_the_reset() {
        // 10 → 20 → 30 over an hour: 20 points an hour, 70 left from the
        // last reading → 3.5 hours later. The reset is 4 hours after that reading.
        let reset = T0 + 60 * MIN + 240 * MIN;
        let samples = climb(&[10.0, 20.0, 30.0], 30, reset);
        let now = T0 + 61 * MIN;
        let p = pace(&samples, &win(30.0, T0 + 60 * MIN, reset), now).unwrap();
        assert!(p.estimate);
        assert_eq!(p.kind, "five_hour");
        assert_eq!(p.resets_at, reset);
        assert_eq!(p.reaches_at, T0 + 60 * MIN + 210 * MIN);
        assert_eq!((p.readings, p.span_minutes), (3, 60));
    }

    #[test]
    fn too_few_readings_or_too_short_a_span_is_no_pace() {
        let reset = T0 + 600 * MIN;
        let now = T0 + 61 * MIN;
        // Two readings: one short.
        let two = climb(&[10.0, 30.0], 60, reset);
        assert_eq!(pace(&two, &win(30.0, T0 + 60 * MIN, reset), now), None);
        // Three readings, but over 20 minutes.
        let quick = climb(&[10.0, 20.0, 30.0], 10, reset);
        assert_eq!(pace(&quick, &win(30.0, T0 + 20 * MIN, reset), now), None);
        // No readings at all.
        assert_eq!(pace(&[], &win(30.0, T0, reset), now), None);
    }

    #[test]
    fn flat_or_falling_use_is_no_pace() {
        let reset = T0 + 600 * MIN;
        let now = T0 + 121 * MIN;
        let flat = climb(&[40.0, 40.0, 40.0, 40.0, 40.0], 30, reset);
        assert_eq!(pace(&flat, &win(40.0, T0 + 120 * MIN, reset), now), None);
        // Under a point of rise is flat too.
        let creep = climb(&[40.0, 40.2, 40.5, 40.8], 30, reset);
        assert_eq!(pace(&creep, &win(40.8, T0 + 90 * MIN, reset), now), None);
    }

    #[test]
    fn a_crossing_after_the_reset_is_no_pace() {
        // 2 points an hour from 30%: 35 hours to go, the reset is in 3.
        let reset = T0 + 90 * MIN + 180 * MIN;
        let samples = climb(&[27.0, 28.0, 29.0, 30.0], 30, reset);
        let now = T0 + 91 * MIN;
        assert_eq!(pace(&samples, &win(30.0, T0 + 90 * MIN, reset), now), None);
    }

    #[test]
    fn only_this_instance_and_recent_readings_count() {
        let reset = T0 + 60 * MIN + 240 * MIN;
        // The previous instance's readings (an earlier reset) are not this one's.
        let mut samples = climb(&[50.0, 70.0, 90.0], 30, reset - 300 * MIN);
        samples.push(s("five_hour", reset, 10.0, 1, T0 + 30 * MIN));
        samples.push(s("five_hour", reset, 30.0, 2, T0 + 60 * MIN));
        let now = T0 + 61 * MIN;
        assert_eq!(pace(&samples, &win(30.0, T0 + 60 * MIN, reset), now), None);
        // Readings older than the lookback (half of five hours) don't count:
        // the same climb, asked about 2.5 hours on, is too old to be "recent".
        let climb_then = climb(&[10.0, 20.0, 30.0], 30, reset);
        let later = T0 + 60 * MIN + 151 * MIN;
        assert_eq!(
            pace(&climb_then, &win(30.0, T0 + 60 * MIN, reset), later),
            None
        );
    }

    #[test]
    fn a_used_up_window_or_one_without_a_reset_has_no_pace() {
        let reset = T0 + 600 * MIN;
        let samples = climb(&[60.0, 80.0, 99.0], 30, reset);
        let now = T0 + 61 * MIN;
        let mut used_up = win(99.0, T0 + 60 * MIN, reset);
        used_up.limited = true;
        assert_eq!(pace(&samples, &used_up, now), None);
        let mut undated = win(99.0, T0 + 60 * MIN, reset);
        undated.resets_at = None;
        assert_eq!(pace(&samples, &undated, now), None);
    }

    #[test]
    fn a_share_says_whether_it_fits_what_was_left() {
        let fits = share(500_000, 1e-5, "five_hour", 60.0);
        assert!(fits.estimate && fits.fits);
        assert_eq!(fits.percent, 5.0);
        assert_eq!(fits.left_reported, 40.0);
        let not = share(5_000_000, 1e-5, "five_hour", 60.0);
        assert!(!not.fits);
        assert_eq!(not.percent, 50.0);
    }
}
