//! "These may be the same account": a question, never a verdict (persona
//! review 2026-11-09, the Stacker).
//!
//! A second sign-in of one account is counted once only when the engines'
//! own records say so (`inventory::same_as`): the same organization or the
//! same ChatGPT user and workspace. For a setup-token sign-in that record may
//! never come, and the owner's real evidence was the figures: two accounts'
//! weekly meters moving together, resetting at the same moment. That is
//! asked, worded as a possibility with the same fix, and changes nothing
//! else: the totals, failover and spare capacity still count them as two.
//!
//! Asked only when, across at least [`MIN_PAIRS`] pairs of readings taken
//! close together (the background read reads every account in one pass),
//! both accounts' weekly limit has the same reset to the second and the same
//! figure, the figure moved, and one of them had no turn this app ran on it
//! in that span (so its meter moving is the other's use showing).

use super::forecast::Sample;
use super::usage_plan::TurnRecord;

/// Readings of the two accounts at most this far apart are a pair.
pub const PAIR_WITHIN_MS: i64 = 15 * 60 * 1000;
/// "The same reset to the second".
pub const SAME_RESET_MS: i64 = 1000;
/// Figures this close are the same figure.
pub const SAME_FIGURE: f64 = 0.5;
/// At least this many pairs.
pub const MIN_PAIRS: usize = 3;
/// Moved together by at least this many points.
pub const MIN_MOVE: f64 = 1.0;

fn weekly(s: &Sample) -> bool {
    s.kind == "seven_day" || s.kind == "secondary"
}

/// Whether two accounts' weekly readings moved together, with no turn of
/// this app's on one of them while they did.
pub fn together(
    a: &[Sample],
    b: &[Sample],
    a_turns: &[TurnRecord],
    b_turns: &[TurnRecord],
) -> bool {
    let mut pairs: Vec<(&Sample, &Sample)> = Vec::new();
    for x in a.iter().filter(|s| weekly(s)) {
        let Some(y) = b
            .iter()
            .filter(|s| s.kind == x.kind && (s.at - x.at).abs() <= PAIR_WITHIN_MS)
            .min_by_key(|s| (s.at - x.at).abs())
        else {
            continue;
        };
        let same_reset = match (x.resets_at, y.resets_at) {
            (Some(r), Some(q)) => (r - q).abs() <= SAME_RESET_MS,
            _ => false,
        };
        if !same_reset || (x.used - y.used).abs() > SAME_FIGURE {
            // One pair that disagrees: they aren't moving together.
            return false;
        }
        pairs.push((x, y));
    }
    if pairs.len() < MIN_PAIRS {
        return false;
    }
    pairs.sort_by_key(|(x, _)| x.at);
    let (first, last) = (pairs[0], pairs[pairs.len() - 1]);
    if last.0.used - first.0.used < MIN_MOVE {
        return false;
    }
    let (from, to) = (first.0.at.min(first.1.at), last.0.at.max(last.1.at));
    let quiet = |turns: &[TurnRecord]| !turns.iter().any(|t| t.at >= from && t.at <= to);
    quiet(a_turns) || quiet(b_turns)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const RESET: i64 = 1_800_000_000_000;

    fn s(at: i64, used: f64, reset: i64) -> Sample {
        Sample {
            kind: "seven_day".into(),
            resets_at: Some(reset),
            used,
            tokens: 0,
            at,
        }
    }

    fn turn(at: i64) -> TurnRecord {
        TurnRecord {
            at,
            agent: "a".into(),
            tokens: 1000,
            routine: None,
        }
    }

    fn walk(offset: i64, reset: i64, figures: &[f64]) -> Vec<Sample> {
        figures
            .iter()
            .enumerate()
            .map(|(i, &u)| s(i as i64 * 30 * MIN + offset, u, reset))
            .collect()
    }

    #[test]
    fn two_meters_moving_together_with_one_unused_is_a_question() {
        let a = walk(0, RESET, &[40.0, 42.0, 45.0]);
        let b = walk(MIN, RESET + 300, &[40.0, 42.0, 45.2]);
        // Turns ran on a only: b's meter moving is a's use showing.
        assert!(together(&a, &b, &[turn(10 * MIN)], &[]));
        // Turns on both in that span: two accounts both in use; not asked.
        assert!(!together(&a, &b, &[turn(10 * MIN)], &[turn(20 * MIN)]));
    }

    #[test]
    fn anything_less_is_not_asked() {
        let a = walk(0, RESET, &[40.0, 42.0, 45.0]);
        // Two pairs only.
        assert!(!together(
            &a[..2],
            &walk(MIN, RESET, &[40.0, 42.0]),
            &[],
            &[]
        ));
        // A different reset: two accounts that happen to read alike.
        assert!(!together(
            &a,
            &walk(MIN, RESET + 60 * MIN, &[40.0, 42.0, 45.0]),
            &[],
            &[]
        ));
        // Figures apart in one pair.
        assert!(!together(
            &a,
            &walk(MIN, RESET, &[40.0, 44.0, 45.0]),
            &[],
            &[]
        ));
        // Not moving: two idle accounts at the same figure say nothing.
        let flat = walk(0, RESET, &[40.0, 40.2, 40.3]);
        assert!(!together(
            &flat,
            &walk(MIN, RESET, &[40.0, 40.2, 40.3]),
            &[],
            &[]
        ));
        // Read far apart: no pairs.
        assert!(!together(
            &a,
            &walk(20 * MIN, RESET, &[40.0, 42.0, 45.0]),
            &[],
            &[]
        ));
        // The 5-hour window isn't what's compared.
        let five: Vec<Sample> = a
            .iter()
            .map(|x| Sample {
                kind: "five_hour".into(),
                ..x.clone()
            })
            .collect();
        assert!(!together(&five, &five.clone(), &[], &[]));
    }
}
