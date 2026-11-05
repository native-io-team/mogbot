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
