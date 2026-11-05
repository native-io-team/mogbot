//! How much of the user's plan is left, exactly as each engine reports it.
//!
//! Never estimated. A reading exists only because an engine said so, and it
//! is kept with the time it said it:
//!
//! - **Claude Code** (verified, 2.1.318 on a subscription): every
//!   `--print --output-format stream-json` turn emits a `rate_limit_event`
//!   before its `result`. `rate_limit_info.unifiedWindows` holds one entry per
//!   plan window (`seven_day`, and `five_hour` when it applies) with
//!   `utilization` (0–1), `resetsAt` (epoch seconds) and `status` (`allowed`,
//!   `allowed_warning`, `rejected`). An `allowed` event may omit the
//!   top-level `utilization`, so the windows are read first
//!   (`testdata/claude-rate-limit.jsonl` is real output).
//! - **Codex** (0.166's app-server schema; *not* verified against a signed-in
//!   account, none was available): `account/rateLimits/read` answers, and
//!   `account/rateLimits/updated` notifies, a `RateLimitSnapshot` whose
//!   `primary` / `secondary` windows carry `usedPercent` (0–100),
//!   `windowDurationMins` and `resetsAt` (epoch seconds). Updates are sparse:
//!   a null window means "not in this update", never "cleared", so windows
//!   are merged rather than replaced. An API-key login reports no windows.
//!
//! A window whose reset time has passed is history, not a reading, and is
//! not shown; neither is one with no reset time once it is a day old.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;

use super::engine::Engine;

const HOUR_MS: i64 = 60 * 60 * 1000;
/// A window with no reset time is shown for this long after it was read.
const UNDATED_FOR_MS: i64 = 24 * HOUR_MS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// The engine's own name for it: `five_hour`, `seven_day`, `primary`, …
    pub kind: String,
    /// 0–100, when the engine gave a figure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// When it resets, epoch ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
    /// How long the window is, when the engine said (Codex does).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<i64>,
    /// The engine said this window is used up.
    #[serde(default)]
    pub limited: bool,
    /// When the engine reported it, epoch ms.
    pub observed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub engine: Engine,
    pub windows: Vec<QuotaWindow>,
}

fn secs_to_ms(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).map(|s| s * 1000)
}

/// One `rate_limit_event` line of Claude Code's stream-json. `None` for any
/// other line, or one that names no window.
pub fn from_claude(value: &Value, now: i64) -> Option<Quota> {
    if value.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return None;
    }
    let info = value.get("rate_limit_info")?;
    let window = |kind: &str, w: &Value| QuotaWindow {
        kind: kind.to_string(),
        used_percent: w
            .get("utilization")
            .and_then(Value::as_f64)
            .map(|u| u * 100.0),
        resets_at: secs_to_ms(w.get("resetsAt")),
        window_minutes: None,
        limited: w.get("status").and_then(Value::as_str) == Some("rejected"),
        observed_at: now,
    };
    let mut windows: Vec<QuotaWindow> = match info.get("unifiedWindows").and_then(Value::as_object)
    {
        Some(map) if !map.is_empty() => map.iter().map(|(k, w)| window(k, w)).collect(),
        _ => {
            let kind = info
                .get("rateLimitType")
                .and_then(Value::as_str)
                .unwrap_or("plan");
            vec![window(kind, info)]
        }
    };
    windows.retain(|w| w.used_percent.is_some() || w.limited);
    windows.sort_by(|a, b| a.kind.cmp(&b.kind));
    (!windows.is_empty()).then_some(Quota {
        engine: Engine::Claude,
        windows,
    })
}

/// A Codex `RateLimitSnapshot` (`account/rateLimits/read`'s `rateLimits`, or
/// the `account/rateLimits/updated` notification's).
pub fn from_codex(snapshot: &Value, now: i64) -> Option<Quota> {
    let reached = snapshot
        .get("rateLimitReachedType")
        .is_some_and(|r| !r.is_null());
    let windows: Vec<QuotaWindow> = ["primary", "secondary"]
        .iter()
        .filter_map(|kind| {
            let w = snapshot.get(*kind).filter(|w| w.is_object())?;
            let used = w.get("usedPercent").and_then(Value::as_f64)?;
            Some(QuotaWindow {
                kind: kind.to_string(),
                used_percent: Some(used),
                resets_at: secs_to_ms(w.get("resetsAt")),
                window_minutes: w.get("windowDurationMins").and_then(Value::as_i64),
                limited: reached && used >= 100.0,
                observed_at: now,
            })
        })
        .collect();
    (!windows.is_empty()).then_some(Quota {
        engine: Engine::Codex,
        windows,
    })
}

/// Whether a reading still says something about now.
fn current(window: &QuotaWindow, now: i64) -> bool {
    match window.resets_at {
        Some(reset) => reset > now,
        None => now - window.observed_at < UNDATED_FOR_MS,
    }
}

/// Fold a new reading into what was known: a window it names is replaced,
/// one it doesn't is kept while it's still current.
pub fn merge(known: &mut Vec<Quota>, reading: Quota, now: i64) {
    match known.iter_mut().find(|q| q.engine == reading.engine) {
        Some(quota) => {
            quota
                .windows
                .retain(|w| current(w, now) && !reading.windows.iter().any(|n| n.kind == w.kind));
            quota.windows.extend(reading.windows);
            quota.windows.sort_by(|a, b| a.kind.cmp(&b.kind));
        }
        None => known.push(reading),
    }
}

/// What is worth showing now: only current windows, only engines with one.
pub fn shown(known: &[Quota], now: i64) -> Vec<Quota> {
    known
        .iter()
        .filter_map(|q| {
            let windows: Vec<QuotaWindow> = q
                .windows
                .iter()
                .filter(|w| current(w, now))
                .cloned()
                .collect();
            (!windows.is_empty()).then(|| Quota {
                engine: q.engine,
                windows,
            })
        })
        .collect()
}

/// When an engine's used-up window lifts, as it reported it: the latest
/// reset among the windows it said are used up (the binding one).
pub fn limited_until(known: &[Quota], engine: Engine, now: i64) -> Option<i64> {
    known
        .iter()
        .find(|q| q.engine == engine)?
        .windows
        .iter()
        .filter(|w| w.limited || w.used_percent.is_some_and(|p| p >= 100.0))
        .filter_map(|w| w.resets_at)
        .filter(|&at| at > now)
        .max()
}

/* --------------------------------------------------------------- disk */

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, crate::errors::CommandError> {
    Ok(super::store::agents_root()?.join("quota.json"))
}

fn read_all() -> Vec<Quota> {
    path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Every reading known, as stored.
pub fn load() -> Vec<Quota> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_all()
}

/// Keep a reading. True when what's shown changed.
pub fn record(reading: Quota, now: i64) -> bool {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut known = read_all();
    let before = shown(&known, now);
    merge(&mut known, reading, now);
    let after = shown(&known, now);
    if let (Ok(path), Ok(json)) = (path(), serde_json::to_vec_pretty(&known)) {
        if let Err(e) = super::store::write_atomic(&path, &json) {
            tracing::warn!("[Agents] quota not saved: {e}");
        }
    }
    // A newer reading of the same figures still moves `observed_at`.
    before != after
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_867_800_000;

    fn fixture() -> Vec<Value> {
        include_str!("testdata/claude-rate-limit.jsonl")
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn reads_claude_codes_real_rate_limit_events() {
        let events = fixture();
        // An `allowed` event: the figure is only in its window.
        let calm = from_claude(&events[0], NOW).unwrap();
        assert_eq!(calm.engine, Engine::Claude);
        assert_eq!(calm.windows.len(), 1);
        let w = &calm.windows[0];
        assert_eq!(w.kind, "seven_day");
        assert!((w.used_percent.unwrap() - 34.0).abs() < 1e-9);
        assert_eq!(w.resets_at, Some(1_794_063_600_000));
        assert!(!w.limited);
        // `allowed_warning` past 75%: still not used up.
        let warn = from_claude(&events[1], NOW).unwrap();
        assert!((warn.windows[0].used_percent.unwrap() - 85.0).abs() < 1e-9);
        assert!(!warn.windows[0].limited);
    }

    #[test]
    fn a_rejected_window_is_used_up_even_without_a_figure() {
        // Shape of a real event, status as Claude Code documents it when the plan is used up.
        let event = serde_json::json!({"type":"rate_limit_event","rate_limit_info":{
            "status":"rejected","resetsAt":1794063600,"rateLimitType":"five_hour"}});
        let q = from_claude(&event, NOW).unwrap();
        assert_eq!(q.windows[0].kind, "five_hour");
        assert_eq!(q.windows[0].used_percent, None);
        assert!(q.windows[0].limited);
        assert_eq!(
            limited_until(&[q], Engine::Claude, NOW),
            Some(1_794_063_600_000)
        );
    }

    #[test]
    fn nothing_reported_is_nothing_shown() {
        let bare =
            serde_json::json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}});
        assert!(from_claude(&bare, NOW).is_none());
        assert!(from_claude(&serde_json::json!({"type":"result"}), NOW).is_none());
        // Codex's real notification on an account with no plan windows (testdata/codex-app-server.jsonl).
        let line = include_str!("testdata/codex-app-server.jsonl")
            .lines()
            .find(|l| l.contains("account/rateLimits/updated"))
            .unwrap();
        let v: Value = serde_json::from_str(line).unwrap();
        assert!(from_codex(&v["params"]["rateLimits"], NOW).is_none());
    }

    #[test]
    fn reads_a_codex_snapshot() {
        // Constructed from 0.166's RateLimitSnapshot schema (no signed-in account to capture from).
        let snap = serde_json::json!({"limitId":"codex","primary":{"usedPercent":92,"windowDurationMins":300,"resetsAt":1793880000},
            "secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1794300000},"rateLimitReachedType":null});
        let q = from_codex(&snap, NOW).unwrap();
        assert_eq!(q.engine, Engine::Codex);
        assert_eq!(q.windows[0].kind, "primary");
        assert_eq!(q.windows[0].used_percent, Some(92.0));
        assert_eq!(q.windows[0].window_minutes, Some(300));
        assert_eq!(q.windows[0].resets_at, Some(1_793_880_000_000));
        assert!(!q.windows[0].limited);
        let hit = serde_json::json!({"primary":{"usedPercent":100,"resetsAt":1793880000},"rateLimitReachedType":"rate_limit_reached"});
        assert!(from_codex(&hit, NOW).unwrap().windows[0].limited);
    }

    #[test]
    fn sparse_updates_merge_and_passed_resets_disappear() {
        let w = |kind: &str, pct: f64, reset: i64, at: i64| QuotaWindow {
            kind: kind.into(),
            used_percent: Some(pct),
            resets_at: Some(reset),
            window_minutes: None,
            limited: false,
            observed_at: at,
        };
        let mut known = Vec::new();
        merge(
            &mut known,
            Quota {
                engine: Engine::Codex,
                windows: vec![
                    w("primary", 50.0, NOW + HOUR_MS, NOW),
                    w("secondary", 10.0, NOW + 100 * HOUR_MS, NOW),
                ],
            },
            NOW,
        );
        // An update naming only the primary keeps the secondary.
        merge(
            &mut known,
            Quota {
                engine: Engine::Codex,
                windows: vec![w("primary", 60.0, NOW + HOUR_MS, NOW + 1)],
            },
            NOW + 1,
        );
        let now = shown(&known, NOW + 2);
        assert_eq!(now[0].windows.len(), 2);
        assert_eq!(now[0].windows[0].used_percent, Some(60.0));
        // After the primary resets only the secondary is a reading.
        let later = shown(&known, NOW + 2 * HOUR_MS);
        assert_eq!(later[0].windows.len(), 1);
        assert_eq!(later[0].windows[0].kind, "secondary");
        // After both, nothing.
        assert!(shown(&known, NOW + 200 * HOUR_MS).is_empty());
    }

    #[test]
    fn stored_and_read_back() {
        let _serial = super::super::store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        super::super::store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let reading = from_claude(&fixture()[1], NOW).unwrap();
        assert!(record(reading.clone(), NOW));
        assert!(
            !record(reading.clone(), NOW),
            "same figures: nothing new to show"
        );
        assert_eq!(shown(&load(), NOW), vec![reading]);
        super::super::store::set_root_for_tests(None);
    }
}
