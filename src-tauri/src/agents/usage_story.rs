//! "Where did my usage go": each rise in an account's meter, and the turns
//! this app ran on that account while it rose.
//!
//! A meter that jumps with no explanation is the complaint competitors get
//! most (a weekly meter going 32% → 67% overnight). The answer here is only
//! what was recorded, never a guess:
//!
//! - **A rise** is read off the account's own samples (`forecast::Sample`,
//!   every reading of a window, from turns and from checks without one):
//!   consecutive readings of one window instance where the figure went up,
//!   joined while they keep rising with less than [`JOIN_GAP_MS`] between
//!   them. From the reading before it to the reading that showed it.
//! - **What ran** is the turns this app recorded on that account in that
//!   time (`usage_plan::TurnRecord`), by agent and, when a turn ran one
//!   routine alone, by routine, with their tokens as the engines reported
//!   them. Points are never split between them: an engine reports tokens
//!   per turn and a percentage per window, and nothing says how one maps to
//!   the other for a given turn. The turns are listed with their tokens;
//!   the share is the reader's.
//! - **Nothing ran here** is said only for a rise that started after this
//!   Mac began recording turns ([`Records::tracked_since`]): the account
//!   was used outside these agents (a Claude Code or Codex terminal, the
//!   claude.ai or ChatGPT app, another computer). Before that, the rise is
//!   left out rather than called unexplained.
//! - Accounts known to be one account (`inventory`'s `same_as`) share one
//!   meter, so turns on either explain a rise on both.

use serde::Serialize;

use super::forecast::Sample;
use super::quota::QuotaWindow;
use super::usage_plan::TurnRecord;

/// Two rises this close together are one.
pub const JOIN_GAP_MS: i64 = 45 * 60 * 1000;
/// A rise smaller than this (in points) isn't news.
pub const MIN_RISE: f64 = 2.0;
/// The most rises listed per window, newest first.
pub const MAX_CHANGES: usize = 6;
/// Two readings of one window instance: a reset can be reported a little differently.
const SAME_RESET_MS: i64 = 30 * 60 * 1000;

/// What ran in one rise, by agent (and routine, when one ran alone).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRun {
    pub agent_id: String,
    /// The agent's name now; "An agent since deleted" when it is gone.
    pub name: String,
    /// The routine's first line, when these turns each ran it alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routine: Option<String>,
    pub turns: u32,
    /// As the engines reported them.
    pub tokens: u64,
}

/// One rise in a window's meter.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageChange {
    /// The window (`five_hour`, `seven_day`, Codex's `primary`, …).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<i64>,
    /// 0–100 before and after, as reported.
    pub from: f64,
    pub to: f64,
    /// The reading before the rise, and the one that showed it.
    pub since: i64,
    pub until: i64,
    /// Turns this app ran on the account in that time, most tokens first.
    pub runs: Vec<ChangeRun>,
    /// Nothing this app ran explains it (only said once turns were recorded).
    pub nothing_here: bool,
}

/// A name for an agent id, and a routine's line for (agent, routine).
pub trait Names {
    fn agent(&self, id: &str) -> Option<String>;
    fn routine(&self, agent: &str, id: &str) -> Option<String>;
}

fn same_instance(a: Option<i64>, b: Option<i64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= SAME_RESET_MS,
        (None, None) => true,
        _ => false,
    }
}

/// What ran between `since` (exclusive) and `until` (inclusive).
fn runs_in(turns: &[&TurnRecord], since: i64, until: i64, names: &dyn Names) -> Vec<ChangeRun> {
    // Grouped by agent and routine id; the routine is said by its line.
    let mut groups: Vec<(&str, Option<&str>, ChangeRun)> = Vec::new();
    for t in turns.iter().filter(|t| t.at > since && t.at <= until) {
        let routine = t.routine.as_deref();
        match groups
            .iter_mut()
            .find(|(agent, r, _)| *agent == t.agent && *r == routine)
        {
            Some((_, _, run)) => {
                run.turns += 1;
                run.tokens = run.tokens.saturating_add(t.tokens);
            }
            None => groups.push((
                t.agent.as_str(),
                routine,
                ChangeRun {
                    agent_id: t.agent.clone(),
                    name: agent_name(names, &t.agent),
                    routine: routine.map(|id| {
                        names
                            .routine(&t.agent, id)
                            .unwrap_or_else(|| "A routine since removed".to_string())
                    }),
                    turns: 1,
                    tokens: t.tokens,
                },
            )),
        }
    }
    let mut out: Vec<ChangeRun> = groups.into_iter().map(|(_, _, run)| run).collect();
    out.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.name.cmp(&b.name)));
    out
}

fn agent_name(names: &dyn Names, id: &str) -> String {
    names
        .agent(id)
        .unwrap_or_else(|| "An agent since deleted".to_string())
}

/// Every rise in `window`'s current instance, newest first.
pub fn changes(
    window: &QuotaWindow,
    samples: &[Sample],
    turns: &[&TurnRecord],
    tracked_since: Option<i64>,
    names: &dyn Names,
) -> Vec<UsageChange> {
    let mut mine: Vec<&Sample> = samples
        .iter()
        .filter(|s| s.kind == window.kind && same_instance(s.resets_at, window.resets_at))
        .collect();
    mine.sort_by_key(|s| s.at);
    // (from, to, since, until)
    let mut rises: Vec<(f64, f64, i64, i64)> = Vec::new();
    for pair in mine.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if b.used - a.used < 0.5 {
            continue;
        }
        match rises.last_mut() {
            Some(last) if a.at - last.3 < JOIN_GAP_MS => {
                last.1 = b.used;
                last.3 = b.at;
            }
            _ => rises.push((a.used, b.used, a.at, b.at)),
        }
    }
    rises
        .into_iter()
        .rev()
        .filter(|(from, to, _, _)| to - from >= MIN_RISE)
        .filter_map(|(from, to, since, until)| {
            let runs = runs_in(turns, since, until, names);
            let recorded = tracked_since.is_some_and(|t| since >= t);
            // A rise from before turns were recorded can't be explained or not.
            if runs.is_empty() && !recorded {
                return None;
            }
            Some(UsageChange {
                kind: window.kind.clone(),
                window_minutes: window.window_minutes,
                from,
                to,
                since,
                until,
                nothing_here: runs.is_empty(),
                runs,
            })
        })
        .take(MAX_CHANGES)
        .collect()
}

/// Who used an account since `since`, by agent, most tokens first.
pub fn spent_by(turns: &[&TurnRecord], since: i64, names: &dyn Names) -> Vec<ChangeRun> {
    let mut by_agent: Vec<ChangeRun> = Vec::new();
    for t in turns.iter().filter(|t| t.at > since) {
        match by_agent.iter_mut().find(|r| r.agent_id == t.agent) {
            Some(r) => {
                r.turns += 1;
                r.tokens = r.tokens.saturating_add(t.tokens);
            }
            None => by_agent.push(ChangeRun {
                agent_id: t.agent.clone(),
                name: agent_name(names, &t.agent),
                routine: None,
                turns: 1,
                tokens: t.tokens,
            }),
        }
    }
    by_agent.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.name.cmp(&b.name)));
    by_agent
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_260_000_000;
    const M: i64 = 60 * 1000;
    const RESET: i64 = NOW + 5 * 24 * 60 * M;

    struct Team;
    impl Names for Team {
        fn agent(&self, id: &str) -> Option<String> {
            match id {
                "riley" => Some("Riley".into()),
                "max" => Some("Max".into()),
                _ => None,
            }
        }
        fn routine(&self, _agent: &str, id: &str) -> Option<String> {
            (id == "r1").then(|| "Morning brief".to_string())
        }
    }

    fn week() -> QuotaWindow {
        QuotaWindow {
            kind: "seven_day".into(),
            used_percent: Some(67.0),
            resets_at: Some(RESET),
            window_minutes: None,
            limited: false,
            observed_at: NOW,
        }
    }

    fn s(used: f64, at: i64) -> Sample {
        Sample {
            kind: "seven_day".into(),
            resets_at: Some(RESET),
            used,
            tokens: 0,
            at,
        }
    }

    fn t(agent: &str, at: i64, tokens: u64, routine: Option<&str>) -> TurnRecord {
        TurnRecord {
            at,
            agent: agent.into(),
            tokens,
            routine: routine.map(str::to_string),
        }
    }

    #[test]
    fn an_overnight_jump_with_nothing_run_here_says_so() {
        let samples = [s(32.0, NOW - 600 * M), s(67.0, NOW - 60 * M)];
        let got = changes(&week(), &samples, &[], Some(NOW - 900 * M), &Team);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].from, got[0].to), (32.0, 67.0));
        assert!(got[0].nothing_here && got[0].runs.is_empty());
    }

    #[test]
    fn a_rise_before_turns_were_recorded_is_left_out_not_called_unexplained() {
        let samples = [s(32.0, NOW - 600 * M), s(67.0, NOW - 60 * M)];
        assert!(changes(&week(), &samples, &[], Some(NOW - 300 * M), &Team).is_empty());
        assert!(changes(&week(), &samples, &[], None, &Team).is_empty());
    }

    #[test]
    fn the_turns_in_a_rise_are_listed_by_agent_and_routine_with_tokens() {
        let samples = [
            s(10.0, NOW - 200 * M),
            s(12.0, NOW - 180 * M),
            s(15.0, NOW - 150 * M),
            // Flat for hours, then a second rise.
            s(15.0, NOW - 100 * M),
            s(19.0, NOW - 10 * M),
        ];
        let turns = [
            t("riley", NOW - 190 * M, 900, None),
            t("riley", NOW - 160 * M, 100, None),
            t("max", NOW - 170 * M, 4000, Some("r1")),
            // Before the rise: not counted.
            t("max", NOW - 300 * M, 7, None),
            t("gone", NOW - 20 * M, 50, None),
        ];
        let refs: Vec<&TurnRecord> = turns.iter().collect();
        let got = changes(&week(), &samples, &refs, Some(NOW - 1000 * M), &Team);
        assert_eq!(got.len(), 2);
        // Newest first.
        assert_eq!((got[0].from, got[0].to), (15.0, 19.0));
        assert_eq!(got[0].runs[0].name, "An agent since deleted");
        assert_eq!((got[1].from, got[1].to), (10.0, 15.0));
        let runs = &got[1].runs;
        assert_eq!(runs[0].name, "Max");
        assert_eq!(runs[0].routine.as_deref(), Some("Morning brief"));
        assert_eq!(
            (runs[1].name.as_str(), runs[1].turns, runs[1].tokens),
            ("Riley", 2, 1000)
        );
        assert!(!got[1].nothing_here);
    }

    #[test]
    fn small_rises_and_other_instances_are_not_news() {
        let mut old = s(0.0, NOW - 500 * M);
        old.resets_at = Some(RESET - 7 * 24 * 60 * M);
        let samples = [old, s(40.0, NOW - 400 * M), s(41.0, NOW - 300 * M)];
        assert!(changes(&week(), &samples, &[], Some(0), &Team).is_empty());
    }

    #[test]
    fn spent_this_week_is_by_agent() {
        let turns = [
            t("riley", NOW - 10 * M, 5, None),
            t("riley", NOW - 9 * M, 5, Some("r1")),
            t("max", NOW - 8 * M, 3, None),
            t("max", NOW - 9000 * M, 999, None),
        ];
        let refs: Vec<&TurnRecord> = turns.iter().collect();
        let got = spent_by(&refs, NOW - 100 * M, &Team);
        assert_eq!(got.len(), 2);
        assert_eq!(
            (got[0].name.as_str(), got[0].turns, got[0].tokens),
            ("Riley", 2, 10)
        );
        assert_eq!(got[1].tokens, 3);
    }
}
