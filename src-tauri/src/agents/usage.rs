//! What each agent's turns cost, as its engine reports it, per agent and per
//! routine (a turn that ran one routine alone is also charged to it:
//! `runs::charged_to`).
//!
//! Claude Code's source is the stream's final `result` event: `usage` (token
//! counts), `total_cost_usd` and `duration_ms`. Its `modelUsage[*].costBasis`
//! is `"list"`: the cost is at API list prices, which on a Pro/Max plan is
//! not what the user is billed. Codex reports tokens only. Only those numbers are kept. Nothing is estimated: a turn
//! that reports no cost adds tokens only, and a window containing such a turn
//! shows no dollar figure at all rather than a partial one.

use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};

/// Days of history kept per agent: enough for "this week".
const KEEP_DAYS: i64 = 7;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    /// Sum of `total_cost_usd` over the turns that reported one.
    #[serde(default)]
    pub cost_usd: f64,
    /// Turns that reported a cost. `cost_usd` is the whole story only when
    /// this equals `turns`.
    #[serde(default)]
    pub priced_turns: u32,
    /// Wall-clock time of the turns, as the CLI timed them.
    #[serde(default)]
    pub duration_ms: u64,
    /// "When…" routines' model checks (`watch`): headless calls, not turns,
    /// so they never inflate `turns`. Their tokens and cost are in the
    /// totals above.
    #[serde(default)]
    pub checks: u32,
    /// Checks that reported a cost. `cost_usd` is the whole story only when
    /// `priced_turns + priced_checks == turns + checks`.
    #[serde(default)]
    pub priced_checks: u32,
}

impl UsageTotals {
    pub fn add(&mut self, other: &UsageTotals) {
        self.turns = self.turns.saturating_add(other.turns);
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.cost_usd += other.cost_usd;
        self.priced_turns = self.priced_turns.saturating_add(other.priced_turns);
        self.duration_ms = self.duration_ms.saturating_add(other.duration_ms);
        self.checks = self.checks.saturating_add(other.checks);
        self.priced_checks = self.priced_checks.saturating_add(other.priced_checks);
    }

    /// One turn's numbers recounted as a model check's.
    pub fn as_check(&self) -> UsageTotals {
        UsageTotals {
            turns: 0,
            priced_turns: 0,
            checks: self.turns.max(1),
            priced_checks: self.priced_turns,
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

/// Stored on the agent in the registry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(default)]
    pub all_time: UsageTotals,
    /// The last few days, oldest first.
    #[serde(default)]
    pub days: Vec<DayUsage>,
}

/// What the edit dialog shows.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// Today and the six days before it.
    pub week: UsageTotals,
    pub all_time: UsageTotals,
    /// This week, per routine that ran on its own in it (a share of `week`).
    pub routines: Vec<RoutineUsage>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineUsage {
    /// The check-in's id.
    pub id: String,
    pub week: UsageTotals,
}

/// One agent's summary, with each routine's week beside it.
pub fn summarize(agent: &super::store::Agent, today: NaiveDate) -> UsageSummary {
    let mut summary = agent.usage.summary(today);
    summary.routines = agent
        .check_ins
        .iter()
        .map(|c| RoutineUsage {
            id: c.id.clone(),
            week: c.usage.summary(today).week,
        })
        .filter(|r| r.week.turns > 0 || r.week.checks > 0)
        .collect();
    summary
}

/// One turn's numbers from a `result` event. `None` when the event carries
/// no usage at all (nothing to record).
pub fn from_result(value: &serde_json::Value) -> Option<UsageTotals> {
    let usage = value.get("usage")?.as_object()?;
    let n = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let cost = value.get("total_cost_usd").and_then(|v| v.as_f64());
    Some(UsageTotals {
        turns: 1,
        input_tokens: n("input_tokens"),
        output_tokens: n("output_tokens"),
        cache_read_tokens: n("cache_read_input_tokens"),
        cache_write_tokens: n("cache_creation_input_tokens"),
        cost_usd: cost.unwrap_or(0.0),
        priced_turns: u32::from(cost.is_some()),
        duration_ms: value
            .get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        ..Default::default()
    })
}

/// One turn's `result`s, recorded once. Claude Code can send more than one
/// `result` in a turn (`turn_end`: a helper reporting back starts another
/// round), and each carries `total_cost_usd` **for the whole process so
/// far** (observed on 2.1.319: two results, both 0.00523), while its `usage`
/// tokens and `duration_ms` are that round's. Recorded as they came, one
/// turn counted as two and its cost twice.
#[derive(Debug, Default)]
pub struct TurnTally {
    results: u32,
    /// The process's cost as the last result reported it.
    cost_so_far: f64,
    priced: bool,
}

impl TurnTally {
    /// What this `result` adds to the turn already recorded: the first is
    /// the turn; each later one adds its round's tokens and time and the
    /// cost the process added since, never another turn.
    pub fn next(&mut self, mut u: UsageTotals) -> UsageTotals {
        let first = self.results == 0;
        self.results += 1;
        if u.priced_turns > 0 {
            let total = u.cost_usd;
            u.cost_usd = (total - self.cost_so_far).max(0.0);
            self.cost_so_far = self.cost_so_far.max(total);
            u.priced_turns = u32::from(!self.priced);
            self.priced = true;
        }
        if !first {
            u.turns = 0;
        }
        u
    }
}

fn day_key(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

fn in_window(key: &str, today: NaiveDate) -> bool {
    NaiveDate::parse_from_str(key, "%Y-%m-%d")
        .map(|d| d <= today && today - d < Duration::days(KEEP_DAYS))
        .unwrap_or(false)
}

impl AgentUsage {
    pub fn is_empty(&self) -> bool {
        self.all_time.turns == 0 && self.all_time.checks == 0 && self.days.is_empty()
    }

    pub fn record(&mut self, turn: &UsageTotals, today: NaiveDate) {
        self.all_time.add(turn);
        let key = day_key(today);
        match self.days.iter_mut().find(|d| d.day == key) {
            Some(day) => day.totals.add(turn),
            None => self.days.push(DayUsage {
                day: key,
                totals: turn.clone(),
            }),
        }
        self.days.retain(|d| in_window(&d.day, today));
        self.days.sort_by(|a, b| a.day.cmp(&b.day));
    }

    pub fn summary(&self, today: NaiveDate) -> UsageSummary {
        let mut week = UsageTotals::default();
        for day in self.days.iter().filter(|d| in_window(&d.day, today)) {
            week.add(&day.totals);
        }
        UsageSummary {
            week,
            all_time: self.all_time.clone(),
            routines: Vec::new(),
        }
    }
}

pub fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// Found live (`nf-turn-end`): a turn whose helper reported back sent
    /// two `result`s, each with the process's cost so far, and was counted
    /// as two turns at twice its cost.
    #[test]
    fn two_results_in_one_turn_are_one_turn_at_its_own_cost() {
        let result = |cost: f64, cache_write: u64, ms: u64| {
            from_result(&serde_json::json!({
                "type": "result", "total_cost_usd": cost, "duration_ms": ms,
                "usage": {"input_tokens": 4, "output_tokens": 200,
                    "cache_creation_input_tokens": cache_write, "cache_read_input_tokens": 100}
            }))
            .unwrap()
        };
        let mut tally = TurnTally::default();
        let mut usage = AgentUsage::default();
        // Trimmed from Claude Code 2.1.319: both results said 0.00523485.
        usage.record(
            &tally.next(result(0.00523485, 12166, 4280)),
            day("2026-11-09"),
        );
        usage.record(
            &tally.next(result(0.00523485, 684, 2379)),
            day("2026-11-09"),
        );
        let t = &usage.all_time;
        assert_eq!(t.turns, 1);
        assert_eq!(t.priced_turns, 1);
        assert!((t.cost_usd - 0.00523485).abs() < 1e-12, "{}", t.cost_usd);
        // Each round's own tokens and time do add up.
        assert_eq!(t.cache_write_tokens, 12166 + 684);
        assert_eq!(t.output_tokens, 400);
        assert_eq!(t.duration_ms, 4280 + 2379);
        // A later result that cost more adds only the difference.
        let more = tally.next(result(0.008, 10, 1));
        assert!((more.cost_usd - (0.008 - 0.00523485)).abs() < 1e-12);
        assert_eq!((more.turns, more.priced_turns), (0, 0));
        // One result: exactly as before.
        let mut one = TurnTally::default();
        assert_eq!(one.next(result(0.1, 5, 9)), result(0.1, 5, 9));
    }

    #[test]
    fn reads_a_real_result_event() {
        // Trimmed from `claude -p "say ok" --output-format stream-json --verbose`
        // (Claude Code, 2026-11-03).
        let event = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false,
            "total_cost_usd": 0.1448284, "duration_ms": 2381,
            "usage": {"input_tokens": 2, "cache_creation_input_tokens": 17808,
                      "cache_read_input_tokens": 11382, "output_tokens": 4}
        });
        let turn = from_result(&event).unwrap();
        assert_eq!(turn.input_tokens, 2);
        assert_eq!(turn.output_tokens, 4);
        assert_eq!(turn.cache_read_tokens, 11382);
        assert_eq!(turn.cache_write_tokens, 17808);
        assert_eq!(turn.priced_turns, 1);
        assert_eq!(turn.duration_ms, 2381);
        assert!((turn.cost_usd - 0.1448284).abs() < 1e-9);
    }

    #[test]
    fn a_turn_without_cost_counts_tokens_only() {
        let event =
            serde_json::json!({"type": "result", "usage": {"input_tokens": 5, "output_tokens": 7}});
        let turn = from_result(&event).unwrap();
        assert_eq!((turn.turns, turn.priced_turns), (1, 0));
        assert_eq!(turn.cost_usd, 0.0);
        assert!(from_result(&serde_json::json!({"type": "result"})).is_none());
    }

    #[test]
    fn accumulates_per_day_and_keeps_only_the_last_week() {
        let turn = |tokens: u64, cost: f64| UsageTotals {
            turns: 1,
            input_tokens: tokens,
            cost_usd: cost,
            priced_turns: 1,
            ..Default::default()
        };
        let mut usage = AgentUsage::default();
        usage.record(&turn(100, 1.0), day("2026-10-20"));
        usage.record(&turn(10, 0.5), day("2026-10-28"));
        usage.record(&turn(20, 0.25), day("2026-11-03"));
        usage.record(&turn(30, 0.25), day("2026-11-03"));

        // 10-20 fell out of the window when 10-28 was recorded.
        assert_eq!(
            usage
                .days
                .iter()
                .map(|d| d.day.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-10-28", "2026-11-03"]
        );
        assert_eq!(usage.days[1].totals.input_tokens, 50);
        assert_eq!(usage.all_time.turns, 4);
        assert_eq!(usage.all_time.input_tokens, 160);

        // On 11-03 the week is 10-28 ..= 11-03.
        let summary = usage.summary(day("2026-11-03"));
        assert_eq!(summary.week.turns, 3);
        assert_eq!(summary.week.input_tokens, 60);
        assert!((summary.week.cost_usd - 1.0).abs() < 1e-9);
        // A few days later, only what's still inside counts, even unwritten.
        let later = usage.summary(day("2026-11-04"));
        assert_eq!(later.week.input_tokens, 50);
        assert_eq!(later.all_time.input_tokens, 160);
    }

    #[test]
    fn old_registries_without_usage_still_load() {
        let usage: AgentUsage = serde_json::from_str("{}").unwrap();
        assert_eq!(usage, AgentUsage::default());
        let day: DayUsage = serde_json::from_str(r#"{"day":"2026-11-03","turns":2}"#).unwrap();
        assert_eq!(day.totals.turns, 2);
    }
}
