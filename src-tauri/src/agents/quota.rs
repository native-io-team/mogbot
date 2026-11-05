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
//!   (`testdata/claude-rate-limit.jsonl` is real output). Each event is the
//!   account's whole picture, so it **replaces** what was known for Claude
//!   rather than merging into it: a window the new event doesn't name (another
//!   account's `five_hour`, say) is not kept. An event that names no window
//!   and no limit type at all is taken as "no plan here" (an API-key login,
//!   or signed out) and clears Claude's reading.
//! - **Codex** (0.166's app-server schema; *not* verified against a signed-in
//!   account, none was available): `account/rateLimits/read` answers, and
//!   `account/rateLimits/updated` notifies, a `RateLimitSnapshot` whose
//!   `primary` / `secondary` windows carry `usedPercent` (0–100),
//!   `windowDurationMins` and `resetsAt` (epoch seconds). Updates are sparse:
//!   a null window means "not in this update", never "cleared", so windows
//!   are merged rather than replaced. An API-key login reports no windows,
//!   and its `account/rateLimits/read` is refused for authentication, which
//!   clears Codex's reading. Codex keeps separate limits per model, each
//!   snapshot naming its `limitId`; only the main one (`codex`, or a snapshot
//!   naming none) is the plan's, so a per-model snapshot is not read at all
//!   rather than shown as "Codex usage".
//!
//! A turn that fails because the engine is signed out clears that engine's
//! reading too: whatever it said belonged to an account that isn't here.
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

/// Claude's plan windows, as Claude Code names them. Only these are read
/// from an event's top-level `rateLimitType` (when it has no
/// `unifiedWindows`): that field can also name things that aren't a plan
/// window (`overage`), which would read as one.
const CLAUDE_WINDOWS: &[&str] = &[
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
];

/// The main Codex limit's id; others are per-model limits.
const CODEX_MAIN_LIMIT: &str = "codex";

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
/// other line, or one that says nothing usable. A reading with no windows
/// is the event saying there is no plan (see the module doc): recording it
/// clears Claude's reading.
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
    let named = info
        .get("unifiedWindows")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty());
    let mut windows: Vec<QuotaWindow> = match (named, info.get("rateLimitType")) {
        (Some(map), _) => map.iter().map(|(k, w)| window(k, w)).collect(),
        // No window and no limit type: no plan on this login.
        (None, None) => {
            return Some(Quota {
                engine: Engine::Claude,
                windows: Vec::new(),
            })
        }
        (None, Some(kind)) => {
            let kind = kind.as_str().filter(|k| CLAUDE_WINDOWS.contains(k))?;
            vec![window(kind, info)]
        }
    };
    windows.retain(|w| w.used_percent.is_some() || w.limited);
    windows.sort_by(|a, b| a.kind.cmp(&b.kind));
    // Windows were named but none had a figure: nothing to say either way.
    (!windows.is_empty()).then_some(Quota {
        engine: Engine::Claude,
        windows,
    })
}

/// A Codex `RateLimitSnapshot` (`account/rateLimits/read`'s `rateLimits`, or
/// the `account/rateLimits/updated` notification's).
pub fn from_codex(snapshot: &Value, now: i64) -> Option<Quota> {
    // A per-model limit is not the plan's (see the module doc).
    match snapshot.get("limitId") {
        None | Some(Value::Null) => {}
        Some(id) if id.as_str() == Some(CODEX_MAIN_LIMIT) => {}
        Some(_) => return None,
    }
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

/// The engine's answer for an account with no plan to read (Codex's refusal
/// of `account/rateLimits/read`, or a sign-out): recording it clears.
pub fn none(engine: Engine) -> Quota {
    Quota {
        engine,
        windows: Vec::new(),
    }
}

/// Fold a new reading into what was known. A reading with no windows
/// clears the engine. Claude's readings are whole snapshots and replace
/// what was known; Codex's are sparse, so a window one names is replaced
/// and one it doesn't is kept while it's still current.
pub fn merge(known: &mut Vec<Quota>, reading: Quota, now: i64) {
    if reading.windows.is_empty() {
        known.retain(|q| q.engine != reading.engine);
        return;
    }
    match known.iter_mut().find(|q| q.engine == reading.engine) {
        Some(quota) if reading.engine == Engine::Claude => *quota = reading,
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
            (!windows.is_empty()).then_some(Quota {
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

/// Forget an engine's reading (its turn failed signed out). True when
/// what's shown changed.
pub fn clear(engine: Engine, now: i64) -> bool {
    record(none(engine), now)
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
        // No window and no limit type: no plan here, which clears what was kept.
        let bare =
            serde_json::json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}});
        assert_eq!(from_claude(&bare, NOW), Some(none(Engine::Claude)));
        assert!(from_claude(&serde_json::json!({"type":"result"}), NOW).is_none());
        // Windows named without a figure say nothing either way.
        let blank = serde_json::json!({"type":"rate_limit_event","rate_limit_info":{
            "unifiedWindows":{"seven_day":{"status":"allowed"}}}});
        assert!(from_claude(&blank, NOW).is_none());
        // Codex's real notification on an account with no plan windows (testdata/codex-app-server.jsonl).
        let line = include_str!("testdata/codex-app-server.jsonl")
            .lines()
            .find(|l| l.contains("account/rateLimits/updated"))
            .unwrap();
        let v: Value = serde_json::from_str(line).unwrap();
        assert!(from_codex(&v["params"]["rateLimits"], NOW).is_none());
    }

    #[test]
    fn the_fallback_reads_only_known_plan_windows() {
        let event = |kind: &str| {
            serde_json::json!({"type":"rate_limit_event","rate_limit_info":{
                "status":"allowed_warning","utilization":0.8,"resetsAt":1794063600,"rateLimitType":kind}})
        };
        assert_eq!(
            from_claude(&event("five_hour"), NOW).unwrap().windows[0].kind,
            "five_hour"
        );
        // Not a plan window: read as nothing, rather than as a window called "overage".
        assert!(from_claude(&event("overage"), NOW).is_none());
    }

    #[test]
    fn a_claude_event_replaces_what_was_known_and_no_plan_clears_it() {
        let mut known = Vec::new();
        let both = serde_json::json!({"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{
            "five_hour":{"utilization":0.5,"resetsAt":1794063600},
            "seven_day":{"utilization":0.2,"resetsAt":1794063600}}}});
        merge(&mut known, from_claude(&both, NOW).unwrap(), NOW);
        assert_eq!(known[0].windows.len(), 2);
        // Another account's event names only its weekly window: the other
        // account's five-hour figure is not kept beside it.
        merge(
            &mut known,
            from_claude(&fixture()[0], NOW + 1).unwrap(),
            NOW + 1,
        );
        let kinds: Vec<&str> = known[0].windows.iter().map(|w| w.kind.as_str()).collect();
        assert_eq!(kinds, ["seven_day"]);
        // Codex's reading is untouched by Claude's, and by Claude's clearing.
        merge(
            &mut known,
            from_codex(
                &serde_json::json!({"primary":{"usedPercent":5,"resetsAt":1794063600}}),
                NOW,
            )
            .unwrap(),
            NOW,
        );
        let bare =
            serde_json::json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}});
        merge(&mut known, from_claude(&bare, NOW + 2).unwrap(), NOW + 2);
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].engine, Engine::Codex);
        merge(&mut known, none(Engine::Codex), NOW + 3);
        assert!(known.is_empty());
    }

    #[test]
    fn only_the_main_codex_limit_is_the_plans() {
        // The real snapshot (testdata/codex-app-server.jsonl), given figures.
        let line = include_str!("testdata/codex-app-server.jsonl")
            .lines()
            .find(|l| l.contains("account/rateLimits/updated"))
            .unwrap();
        let v: Value = serde_json::from_str(line).unwrap();
        let mut snap = v["params"]["rateLimits"].clone();
        assert_eq!(snap["limitId"], "codex");
        snap["primary"] =
            serde_json::json!({"usedPercent":40,"windowDurationMins":300,"resetsAt":1794063600});
        assert_eq!(
            from_codex(&snap, NOW).unwrap().windows[0].used_percent,
            Some(40.0)
        );
        // A per-model limit's snapshot is not "Codex usage".
        snap["limitId"] = "codex_bengalfox".into();
        snap["limitName"] = "GPT-5.3-Codex-Spark".into();
        assert!(from_codex(&snap, NOW).is_none());
        // No limitId (an older Codex): the plan's.
        snap.as_object_mut().unwrap().remove("limitId");
        assert!(from_codex(&snap, NOW).is_some());
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
        // Signed out: cleared, once.
        assert!(clear(Engine::Claude, NOW));
        assert!(!clear(Engine::Claude, NOW));
        assert!(load().is_empty());
        super::super::store::set_root_for_tests(None);
    }
}
