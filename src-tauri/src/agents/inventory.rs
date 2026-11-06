//! What the user has to run agents on, and what is left of it: every engine
//! and account in the wallet, each account's last reported plan windows,
//! other compute installed on this Mac, and forecasts from past runs.
//!
//! Read by the agents (`usage_overview`, `forecast_usage`), Settings →
//! Agents → Usage, What's in flight and the phone. The rules:
//!
//! - **Readings are only what an engine reported**, with when. An account
//!   with none says "no reading". The engine-wide reading (`quota.json`) is
//!   given to an account only when the wallet recorded it came from that
//!   one, or the engine has a single account; otherwise it isn't anyone's.
//! - **Plan names** only when the engine said (Codex's `planType`; Claude
//!   Code's credentials' `subscriptionType`, read with its limits by `usage_read`).
//! - **Other compute** is detected, never assumed: Opencode's binary, and
//!   Ollama or LM Studio when installed, with the models their own local
//!   servers list when they're running. Agents here don't run on them; they
//!   are listed so the Chief can say what's available.
//! - **Forecasts** are estimates (`forecast.rs`), labelled so everywhere,
//!   and absent with too little history.

use serde::Serialize;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use chrono::NaiveDate;

use super::compute;
use super::engine::{Engine, EngineInfo};
use super::forecast::{self, PerRun, Unit, WindowShare};
use super::quota::{Quota, QuotaWindow};
use super::store::Agent;
use super::usage_plan::{self, AccountReading, Mode, Spare, SpareItem};
use super::wallet::{self, Account, Candidate, Choice};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineLine {
    pub id: Engine,
    pub label: &'static str,
    pub installed: bool,
    pub signed_in: bool,
    /// Agents that run on it.
    pub agents: u32,
    /// The account its next turn runs on, when one can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_account: Option<String>,
    /// Every signed-in account is out of usage.
    pub all_out: bool,
    /// An average turn on it here, from every agent's past turns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_turn: Option<PerRun>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountLine {
    pub engine: Engine,
    pub id: String,
    pub name: String,
    pub this_mac: bool,
    pub signed_in: bool,
    /// Out of usage now (a turn hit the limit, or a reading said so).
    pub out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_until: Option<i64>,
    /// The engine's next turn runs on it.
    pub next: bool,
    /// The plan's name, when the engine said it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Its windows as last reported and still current. Empty: no reading.
    pub windows: Vec<QuotaWindow>,
    /// Window kinds whose share per token has been learned (`forecast::rate`).
    pub learned: Vec<String>,
    /// When a window would reach 100% at the recent rate, before its reset:
    /// an ESTIMATE from this account's own readings (`forecast::pace`), one
    /// per window that has one. Empty: none to say.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pace: Vec<forecast::Pace>,
    /// How its last check without a turn went (`usage_read`), when there was one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<usage_plan::Check>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalCompute {
    /// "Opencode", "Ollama", "LM Studio".
    pub name: &'static str,
    /// Its local server answered (Ollama, LM Studio). `None`: not asked
    /// (Opencode has no server to ask).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    /// The models its server listed. Empty when not running or none.
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentLine {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub is_main: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_turn: Option<PerRun>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineLine {
    pub agent_id: String,
    pub id: String,
    /// The first line of its note.
    pub what: String,
    /// A "When…" routine: its runs are model checks.
    pub when: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_run: Option<PerRun>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub mode: Mode,
    /// When the user set it; absent while it is the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_set_at: Option<i64>,
    pub engines: Vec<EngineLine>,
    pub accounts: Vec<AccountLine>,
    pub local: Vec<LocalCompute>,
    /// Windows near their reset with capacity left, soonest first.
    pub spare: Vec<Spare>,
    pub backlog: Vec<SpareItem>,
    pub agents: Vec<AgentLine>,
    pub routines: Vec<RoutineLine>,
    /// Every account at once: what there is room on, by reading (`compute.rs`).
    pub totals: compute::Totals,
    pub now: i64,
}

/// Everything `build` needs, read beforehand so it stays pure.
pub struct Parts {
    pub mode: (Mode, i64),
    pub engines: Vec<EngineInfo>,
    pub candidates: Vec<Candidate>,
    /// `quota::shown` of `quota.json`.
    pub engine_readings: Vec<Quota>,
    /// Which account each engine's reading came from.
    pub reading_from: Vec<(Engine, Option<String>)>,
    pub archived: std::collections::BTreeMap<String, Quota>,
    pub samples: std::collections::BTreeMap<String, Vec<forecast::Sample>>,
    /// Each account's last check without a turn (`usage_plan::checks`).
    pub checks: std::collections::BTreeMap<String, usage_plan::Check>,
    pub agents: Vec<Agent>,
    pub local: Vec<LocalCompute>,
    pub backlog: Vec<SpareItem>,
    pub today: NaiveDate,
    pub now: i64,
}

fn current(q: &Quota, now: i64) -> Option<Quota> {
    super::quota::shown(std::slice::from_ref(q), now).pop()
}

/// The reading that is this account's, if any (see the module doc).
fn reading_for(parts: &Parts, account: &Account) -> Option<Quota> {
    let engine = account.engine;
    let of_engine = parts
        .candidates
        .iter()
        .filter(|c| c.account.engine == engine)
        .count();
    let from = parts
        .reading_from
        .iter()
        .find(|(e, _)| *e == engine)
        .and_then(|(_, f)| f.clone());
    let attributed = match &from {
        Some(id) => *id == account.id,
        None => of_engine == 1,
    };
    let engine_wide = parts
        .engine_readings
        .iter()
        .find(|q| q.engine == engine)
        .filter(|_| attributed)
        .cloned();
    let own = parts
        .archived
        .get(&usage_plan::account_key(engine, &account.id))
        .cloned();
    // The newer of the two: a check without a turn can be newer than the last turn's.
    let newest = |q: &Quota| q.windows.iter().map(|w| w.observed_at).max().unwrap_or(0);
    match (engine_wide, own) {
        (Some(e), Some(o)) => Some(if newest(&o) > newest(&e) { o } else { e }),
        (e, o) => e.or(o),
    }
    .and_then(|q| current(&q, parts.now))
}

pub fn build(parts: Parts) -> Inventory {
    let now = parts.now;
    let mut accounts = Vec::new();
    let mut engines = Vec::new();
    for info in &parts.engines {
        let mine: Vec<Candidate> = parts
            .candidates
            .iter()
            .filter(|c| c.account.engine == info.id)
            .cloned()
            .collect();
        let choice = (info.installed && !mine.is_empty()).then(|| wallet::choose(&mine, &[], now));
        let next_id = match &choice {
            Some(Choice::Run(a)) if info.signed_in => Some(a.id.clone()),
            _ => None,
        };
        let histories: Vec<&[super::usage::DayUsage]> = parts
            .agents
            .iter()
            .filter(|a| a.engine == info.id)
            .map(|a| a.usage.days.as_slice())
            .collect();
        engines.push(EngineLine {
            id: info.id,
            label: info.label,
            installed: info.installed,
            signed_in: info.signed_in,
            agents: histories.len() as u32,
            next_account: next_id
                .as_ref()
                .and_then(|id| mine.iter().find(|c| &c.account.id == id))
                .map(|c| c.account.name.clone()),
            all_out: matches!(choice, Some(Choice::AllOut { .. })),
            per_turn: forecast::pooled(&histories, Unit::Turns, parts.today),
        });
        if !info.installed {
            continue;
        }
        for c in &mine {
            let reading = reading_for(&parts, &c.account);
            let key = usage_plan::account_key(info.id, &c.account.id);
            let learned = reading
                .iter()
                .flat_map(|q| q.windows.iter())
                .map(|w| w.kind.clone())
                .filter(|k| {
                    parts
                        .samples
                        .get(&key)
                        .is_some_and(|s| forecast::rate(s, k).is_some())
                })
                .collect();
            let pace = match (&reading, parts.samples.get(&key)) {
                (Some(q), Some(samples)) => q
                    .windows
                    .iter()
                    .filter_map(|w| forecast::pace(samples, w, now))
                    .collect(),
                _ => Vec::new(),
            };
            let out = c.account.out(now);
            accounts.push(AccountLine {
                engine: info.id,
                id: c.account.id.clone(),
                name: c.account.name.clone(),
                this_mac: c.account.is_this_mac(),
                signed_in: c.signed_in,
                out: out.is_some(),
                out_until: out.flatten(),
                next: next_id.as_deref() == Some(c.account.id.as_str()),
                plan: reading.as_ref().and_then(|q| q.plan.clone()),
                windows: reading.map(|q| q.windows).unwrap_or_default(),
                learned,
                // An account that's out has nothing left to run out of.
                pace: if out.is_some() { Vec::new() } else { pace },
                check: parts.checks.get(&key).cloned(),
            });
        }
    }
    let readings: Vec<AccountReading> = accounts
        .iter()
        .filter(|a| !a.windows.is_empty())
        .map(|a| AccountReading {
            engine: a.engine,
            account_id: a.id.clone(),
            account_name: a.name.clone(),
            next: a.next,
            quota: Quota {
                engine: a.engine,
                windows: a.windows.clone(),
                plan: a.plan.clone(),
            },
        })
        .collect();
    let visible = parts.agents.iter().filter(|a| !a.hidden);
    let agents = visible
        .clone()
        .map(|a| AgentLine {
            id: a.id.clone(),
            name: a.name.clone(),
            engine: a.engine,
            model: a.model.clone(),
            is_main: a.is_main,
            per_turn: forecast::per_run(&a.usage.days, Unit::Turns, parts.today),
        })
        .collect();
    let routines = visible
        .flat_map(|a| {
            a.check_ins.iter().filter(|c| !c.paused).map(|c| {
                let when = c.watch.is_some();
                RoutineLine {
                    agent_id: a.id.clone(),
                    id: c.id.clone(),
                    what: c
                        .note
                        .lines()
                        .next()
                        .unwrap_or("")
                        .chars()
                        .take(80)
                        .collect(),
                    when,
                    per_run: forecast::per_run(
                        &c.usage.days,
                        if when { Unit::Checks } else { Unit::Turns },
                        parts.today,
                    ),
                }
            })
        })
        .collect();
    Inventory {
        mode: parts.mode.0,
        mode_set_at: (parts.mode.1 > 0).then_some(parts.mode.1),
        spare: usage_plan::spare(&readings, now),
        totals: compute::totals(&accounts, now),
        engines,
        accounts,
        local: parts.local,
        backlog: parts.backlog,
        agents,
        routines,
        now,
    }
}

/* ---------------------------------------------------- other compute */

/// What was found, and when.
type Found = Option<(Vec<LocalCompute>, Instant)>;
static LOCAL: LazyLock<Mutex<Found>> = LazyLock::new(|| Mutex::new(None));
const LOCAL_FOR: Duration = Duration::from_secs(60);

async fn models_at(url: &str, list: &str, name: &str) -> Option<Vec<String>> {
    // Loopback only: no proxy (a system proxy would carry the request off
    // this Mac) and no redirects (whatever answers on that port could point
    // anywhere).
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let body: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    Some(
        body.get(list)?
            .as_array()?
            .iter()
            .filter_map(|m| m.get(name).and_then(|v| v.as_str()).map(str::to_string))
            .take(20)
            .collect(),
    )
}

fn home_has(path: &str) -> bool {
    dirs::home_dir().is_some_and(|h| h.join(path).exists())
}

/// Opencode, Ollama and LM Studio, when installed (cached a minute).
pub async fn local_compute() -> Vec<LocalCompute> {
    if let Some((found, at)) = LOCAL.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < LOCAL_FOR {
            return found.clone();
        }
    }
    let find = |name: &'static str| async move {
        tokio::task::spawn_blocking(move || {
            crate::commands::claude::find_binary_by_name(name).is_some()
        })
        .await
        .unwrap_or(false)
    };
    let mut found = Vec::new();
    if find("opencode").await {
        found.push(LocalCompute {
            name: "Opencode",
            running: None,
            models: Vec::new(),
        });
    }
    if find("ollama").await || std::path::Path::new("/Applications/Ollama.app").exists() {
        let models = models_at("http://127.0.0.1:11434/api/tags", "models", "name").await;
        found.push(LocalCompute {
            name: "Ollama",
            running: Some(models.is_some()),
            models: models.unwrap_or_default(),
        });
    }
    if find("lms").await
        || home_has(".lmstudio/bin/lms")
        || std::path::Path::new("/Applications/LM Studio.app").exists()
    {
        let models = models_at("http://127.0.0.1:1234/v1/models", "data", "id").await;
        found.push(LocalCompute {
            name: "LM Studio",
            running: Some(models.is_some()),
            models: models.unwrap_or_default(),
        });
    }
    *LOCAL.lock().unwrap_or_else(|e| e.into_inner()) = Some((found.clone(), Instant::now()));
    found
}

/// The inventory now, from disk, the engines and this Mac.
pub async fn read() -> Inventory {
    let engines = super::engine::overview().await;
    let mut candidates = Vec::new();
    for engine in Engine::ALL {
        candidates.extend(wallet::candidates(engine).await);
    }
    let local = local_compute().await;
    let now = super::store::now_ms();
    tokio::task::spawn_blocking(move || {
        let (archived, samples) = usage_plan::readings();
        build(Parts {
            mode: usage_plan::mode(),
            engines,
            candidates,
            engine_readings: super::quota::shown(&super::quota::load(), now),
            reading_from: Engine::ALL
                .iter()
                .map(|e| (*e, wallet::reading_from(*e)))
                .collect(),
            archived,
            samples,
            checks: usage_plan::checks(),
            agents: super::store::list().unwrap_or_default(),
            local,
            backlog: usage_plan::backlog(),
            today: super::usage::today(),
            now,
        })
    })
    .await
    .unwrap_or_else(|_| empty(now))
}

fn empty(now: i64) -> Inventory {
    Inventory {
        mode: Mode::Normal,
        mode_set_at: None,
        engines: Vec::new(),
        accounts: Vec::new(),
        local: Vec::new(),
        spare: Vec::new(),
        backlog: Vec::new(),
        agents: Vec::new(),
        routines: Vec::new(),
        totals: compute::totals(&[], now),
        now,
    }
}

/* ------------------------------------------------------- forecasting */

/// One part of a planned piece of work.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub engine: Engine,
    /// "Research: 3 turns".
    pub label: String,
    /// `None`: too little history to say.
    pub per_run: Option<PerRun>,
    pub runs: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineForecast {
    pub engine: Engine,
    pub estimate: bool,
    /// Tokens, by estimate, over the parts that had history.
    pub tokens: u64,
    /// Parts with too little history: left out of `tokens`.
    pub unknown: Vec<String>,
    /// The account it would run on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Share of that account's windows, where a rate is learned.
    pub shares: Vec<WindowShare>,
}

/// Add up a plan per engine and set it against the account each would run on.
pub fn forecast(
    inv: &Inventory,
    samples: &std::collections::BTreeMap<String, Vec<forecast::Sample>>,
    planned: &[Planned],
) -> Vec<EngineForecast> {
    let mut out: Vec<EngineForecast> = Vec::new();
    for p in planned {
        let at = match out.iter().position(|f| f.engine == p.engine) {
            Some(i) => i,
            None => {
                out.push(EngineForecast {
                    engine: p.engine,
                    estimate: true,
                    tokens: 0,
                    unknown: Vec::new(),
                    account: None,
                    shares: Vec::new(),
                });
                out.len() - 1
            }
        };
        match &p.per_run {
            Some(r) => out[at].tokens += r.tokens.saturating_mul(u64::from(p.runs)),
            None => out[at].unknown.push(p.label.clone()),
        }
    }
    for f in &mut out {
        let Some(account) = inv.accounts.iter().find(|a| a.engine == f.engine && a.next) else {
            continue;
        };
        f.account = Some(account.name.clone());
        let key = usage_plan::account_key(account.engine, &account.id);
        for w in &account.windows {
            let (Some(used), Some(rate)) = (
                w.used_percent,
                samples.get(&key).and_then(|s| forecast::rate(s, &w.kind)),
            ) else {
                continue;
            };
            if f.tokens > 0 {
                f.shares
                    .push(forecast::share(f.tokens, rate, &w.kind, used));
            }
        }
    }
    out
}

/* -------------------------------------------------------- the words */

fn engine_name(e: Engine) -> &'static str {
    e.label()
}

/// "5-hour", "weekly", as `windowName` in the companion protocol says it.
pub fn window_name(w: &str, minutes: Option<i64>) -> String {
    match (w, minutes) {
        ("five_hour", _) | (_, Some(300)) => "5-hour".into(),
        ("seven_day", _) | (_, Some(10080)) => "weekly".into(),
        ("seven_day_opus", _) => "weekly Opus".into(),
        ("seven_day_sonnet", _) => "weekly Sonnet".into(),
        (k, _) => k.replace('_', " "),
    }
}

pub fn compact(n: u64) -> String {
    let n = n as f64;
    if n < 1000.0 {
        format!("{}", n.round() as u64)
    } else if n < 1_000_000.0 {
        format!("{}k", (n / 1000.0).round() as u64)
    } else {
        format!("{:.1}M", n / 1_000_000.0)
    }
}

fn when<Tz: chrono::TimeZone>(tz: &Tz, at: i64, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    super::failure::clock_phrase(tz, at, now)
}

fn per_run_words(r: &PerRun) -> String {
    format!(
        "about {} tokens a run (estimate from your past {} runs over {} day{}; {}–{})",
        compact(r.tokens),
        r.runs,
        r.days,
        if r.days == 1 { "" } else { "s" },
        compact(r.low),
        compact(r.high)
    )
}

/// What `usage_overview` answers: plain lines, readings and estimates
/// kept apart and each labelled.
pub fn overview_text<Tz: chrono::TimeZone>(inv: &Inventory, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let now = inv.now;
    let mut s = String::new();
    s.push_str(&format!("Usage mode: {}.", inv.mode.label()));
    s.push_str(match inv.mode {
        Mode::Normal => " Don't slow down or skimp for limits; say what something big will likely use before starting it.\n",
        Mode::Save => " Ask before heavy work; send light work to lighter models or engines.\n",
        Mode::UseItAll => " The user's standing OK to use capacity that would otherwise expire on work from the spare-capacity list.\n",
    });
    total_text(&mut s, inv, tz);
    s.push_str("\nREADINGS (only what the engines reported):\n");
    for e in &inv.engines {
        if !e.installed {
            s.push_str(&format!("- {}: not installed.\n", engine_name(e.id)));
            continue;
        }
        let next = match (&e.next_account, e.all_out, e.signed_in) {
            (_, true, _) => " Every signed-in account is out of usage.".to_string(),
            (Some(a), _, _) => format!(" Next turn runs on: {a}."),
            (None, _, false) => " Not signed in.".to_string(),
            (None, _, true) => String::new(),
        };
        s.push_str(&format!(
            "- {} ({} agent{}).{next}\n",
            engine_name(e.id),
            e.agents,
            if e.agents == 1 { "" } else { "s" }
        ));
        for a in inv.accounts.iter().filter(|a| a.engine == e.id) {
            let mut line = format!("  - Account \"{}\"", a.name);
            if let Some(plan) = &a.plan {
                line.push_str(&format!(" ({plan} plan, as reported)"));
            }
            if !a.signed_in {
                line.push_str(": not signed in");
            } else if a.out {
                match a.out_until {
                    Some(at) => {
                        line.push_str(&format!(": out of usage until {}", when(tz, at, now)))
                    }
                    None => line.push_str(": out of usage, reset time not reported"),
                }
            }
            if a.windows.is_empty() {
                line.push_str(". No reading");
                match a.check.as_ref() {
                    Some(c) if c.outcome == usage_plan::CheckOutcome::CantRead => {
                        line.push_str(&format!(
                            " (can't be read without a turn: {}; its next turn reports it)",
                            c.why.as_deref().unwrap_or("no reason given").to_lowercase()
                        ))
                    }
                    Some(c) if c.outcome == usage_plan::CheckOutcome::NoPlan => {
                        line.push_str(" (the engine reported no plan limits for this login)")
                    }
                    _ => {}
                }
                line.push('.');
            } else {
                let parts: Vec<String> = a
                    .windows
                    .iter()
                    .map(|w| {
                        let name = window_name(&w.kind, w.window_minutes);
                        let used = match w.used_percent {
                            Some(p) if w.limited || p >= 100.0 => "used up".to_string(),
                            Some(p) => format!("{}% used", p.floor()),
                            None if w.limited => "used up".to_string(),
                            None => "no figure".to_string(),
                        };
                        let reset = w
                            .resets_at
                            .map(|r| format!(", resets {}", when(tz, r, now)))
                            .unwrap_or_default();
                        format!(
                            "{name} limit {used}{reset} (reported {})",
                            when(tz, w.observed_at, now)
                        )
                    })
                    .collect();
                line.push_str(&format!(". {}.", parts.join("; ")));
            }
            s.push_str(&line);
            s.push('\n');
        }
    }
    if !inv.local.is_empty() {
        s.push_str("\nOTHER COMPUTE ON THIS MAC (detected; agents here don't run on it):\n");
        for l in &inv.local {
            let state = match l.running {
                None => "installed".to_string(),
                Some(false) => "installed, not running".to_string(),
                Some(true) if l.models.is_empty() => "running, no models listed".to_string(),
                Some(true) => format!("running, models: {}", l.models.join(", ")),
            };
            s.push_str(&format!("- {}: {state}.\n", l.name));
        }
    }
    if !inv.spare.is_empty() {
        s.push_str("\nNEAR A RESET WITH CAPACITY LEFT:\n");
        for sp in &inv.spare {
            s.push_str(&format!(
                "- {} \"{}\": {} limit resets {} and was {}% used when reported {}{}.\n",
                engine_name(sp.engine),
                sp.account_name,
                window_name(&sp.kind, sp.window_minutes),
                when(tz, sp.resets_at, now),
                sp.used_percent.floor(),
                when(tz, sp.observed_at, now),
                if sp.next {
                    ""
                } else {
                    " (not the account turns run on next)"
                }
            ));
        }
    }
    s.push_str("\nESTIMATES (from this user's past runs; not readings):\n");
    let mut any = false;
    for r in &inv.totals.run_out {
        any = true;
        s.push_str(&format!(
            "- {} across all its accounts: at the recent pace every one would be at its limit by {}, before any resets (ESTIMATE from {} readings across {} accounts, not a reading).\n",
            engine_name(r.engine),
            when(tz, r.reaches_at, now),
            r.readings,
            r.accounts
        ));
    }
    for a in &inv.accounts {
        for p in &a.pace {
            any = true;
            let window = a.windows.iter().find(|w| w.kind == p.kind);
            s.push_str(&format!(
                "- {} \"{}\": at the recent pace its {} limit would run out {}, before it resets {} (ESTIMATE from {} readings over {} minutes, not a reading).\n",
                engine_name(a.engine),
                a.name,
                window_name(&p.kind, window.and_then(|w| w.window_minutes)),
                when(tz, p.reaches_at, now),
                when(tz, p.resets_at, now),
                p.readings,
                p.span_minutes
            ));
        }
    }
    for e in inv.engines.iter().filter(|e| e.installed) {
        if let Some(r) = &e.per_turn {
            any = true;
            s.push_str(&format!(
                "- An average {} turn here: {}.\n",
                engine_name(e.id),
                per_run_words(r)
            ));
        }
    }
    for a in &inv.agents {
        if let Some(r) = &a.per_turn {
            any = true;
            s.push_str(&format!("- {}: {}.\n", a.name, per_run_words(r)));
        }
    }
    for r in &inv.routines {
        if let Some(p) = &r.per_run {
            any = true;
            let who = inv
                .agents
                .iter()
                .find(|a| a.id == r.agent_id)
                .map(|a| a.name.as_str())
                .unwrap_or("?");
            s.push_str(&format!(
                "- Routine {} \"{}\" ({who}): {}.\n",
                r.id,
                r.what,
                per_run_words(p)
            ));
        }
    }
    if !any {
        s.push_str("- Too little history to estimate anything yet.\n");
    }
    let waiting: Vec<&SpareItem> = inv.backlog.iter().collect();
    s.push_str("\nSPARE-CAPACITY LIST:\n");
    if waiting.is_empty() {
        s.push_str("- Empty.\n");
    }
    for i in waiting {
        let state = match i.state {
            usage_plan::ItemState::Waiting => "waiting",
            usage_plan::ItemState::Started => "started",
        };
        s.push_str(&format!(
            "- [{}] {} ({state}, added by {})\n",
            i.id, i.text, i.added_by
        ));
    }
    s
}

fn plural(n: u32, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// The TOTAL lines: every account at once, by reading.
fn total_text<Tz: chrono::TimeZone>(s: &mut String, inv: &Inventory, tz: &Tz)
where
    Tz::Offset: std::fmt::Display,
{
    let t = &inv.totals;
    if t.accounts == 0 {
        return;
    }
    let now = inv.now;
    let by: Vec<String> = t
        .engines
        .iter()
        .map(|e| format!("{} {}", engine_name(e.engine), e.accounts))
        .collect();
    s.push_str("\nTOTAL COMPUTE (from readings; an account with none is \"not read\", never assumed to have room):\n");
    let unread = t.accounts - t.read;
    s.push_str(&format!(
        "- {} ({}). Room now on {} of {} read{}.\n",
        plural(t.accounts, "account"),
        by.join(", "),
        t.room,
        t.read,
        if unread > 0 {
            format!(" ({unread} not read yet)")
        } else {
            String::new()
        }
    ));
    for w in &t.windows {
        let name = match w.family {
            compute::Family::Session => "5-hour",
            compute::Family::Weekly => "Weekly",
        };
        let soonest = w
            .soonest_reset
            .as_ref()
            .map(|r| {
                format!(
                    "; soonest reset {} \"{}\" {}",
                    engine_name(r.engine),
                    r.account_name,
                    when(tz, r.at, now)
                )
            })
            .unwrap_or_default();
        s.push_str(&format!(
            "- {name} limits: {} of {} {} room{soonest}.\n",
            w.room,
            plural(w.read, "account"),
            if w.room == 1 { "has" } else { "have" }
        ));
    }
    if let Some(n) = &t.next_room {
        s.push_str(&format!(
            "- First back: {} \"{}\" has room again {}.\n",
            engine_name(n.engine),
            n.account_name,
            when(tz, n.at, now)
        ));
    }
}

/// What `forecast_usage` answers.
pub fn forecast_text<Tz: chrono::TimeZone>(
    inv: &Inventory,
    forecasts: &[EngineForecast],
    tz: &Tz,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let mut s = String::from("ESTIMATE from this user's past runs (not a reading):\n");
    for f in forecasts {
        let on = f
            .account
            .as_ref()
            .map(|a| format!(" on account \"{a}\""))
            .unwrap_or_default();
        if f.tokens > 0 {
            s.push_str(&format!(
                "- {}{on}: about {} tokens.",
                engine_name(f.engine),
                compact(f.tokens)
            ));
        } else {
            s.push_str(&format!("- {}{on}: no estimate.", engine_name(f.engine)));
        }
        for sh in &f.shares {
            s.push_str(&format!(
                " About {}% of its {} limit, which had {}% left when last reported{}.",
                sh.percent,
                window_name(&sh.kind, None),
                sh.left_reported.floor(),
                if sh.fits { "" } else { ": more than is left" }
            ));
        }
        if f.tokens > 0 && f.shares.is_empty() {
            s.push_str(" What share of a limit that is isn't known yet: it's learned from this Mac's readings as turns report them.");
        }
        if !f.unknown.is_empty() {
            s.push_str(&format!(
                " Too little history to estimate: {}.",
                f.unknown.join(", ")
            ));
        }
        s.push('\n');
    }
    let heaviest = forecasts
        .iter()
        .flat_map(|f| f.shares.iter().map(|s| s.percent))
        .fold(None, |m: Option<f64>, p| Some(m.map_or(p, |m| m.max(p))));
    let fan_out = forecasts.iter().map(|f| f.unknown.len()).sum::<usize>() > 1;
    if usage_plan::ask_first(inv.mode, heaviest, fan_out) {
        s.push_str("\nMode is Save my limits: ask the user before starting this, saying what it will likely use.\n");
    } else {
        s.push_str("\nSay in one line what it will likely use and which account it runs on, then go ahead.\n");
    }
    let _ = (tz, inv.now);
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::usage::{AgentUsage, DayUsage, UsageTotals};

    const NOW: i64 = 1_793_867_800_000;

    fn account(engine: Engine, id: &str, name: &str) -> Account {
        Account {
            id: id.into(),
            engine,
            name: name.into(),
            added_at: 0,
            limit: None,
        }
    }

    fn info(id: Engine, installed: bool, signed_in: bool) -> EngineInfo {
        EngineInfo {
            id,
            label: id.label(),
            installed,
            signed_in,
            asks: true,
            models: Vec::new(),
        }
    }

    fn window(kind: &str, used: f64, resets_in: i64) -> QuotaWindow {
        QuotaWindow {
            kind: kind.into(),
            used_percent: Some(used),
            resets_at: Some(NOW + resets_in),
            window_minutes: None,
            limited: false,
            observed_at: NOW - 60_000,
        }
    }

    fn agent(id: &str, engine: Engine, days: Vec<DayUsage>) -> Agent {
        let mut a: Agent = serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "role": "", "shape": 0, "color": "blue",
            "createdAt": 0, "lastActivityAt": 0
        }))
        .unwrap();
        a.engine = engine;
        a.usage = AgentUsage {
            all_time: UsageTotals::default(),
            days,
        };
        a
    }

    fn parts() -> Parts {
        Parts {
            mode: (Mode::Normal, 0),
            engines: vec![
                info(Engine::Claude, true, true),
                info(Engine::Codex, false, false),
            ],
            candidates: vec![
                Candidate {
                    account: account(Engine::Claude, "default", "This Mac"),
                    signed_in: true,
                },
                Candidate {
                    account: account(Engine::Claude, "w1", "Work"),
                    signed_in: true,
                },
                Candidate {
                    account: account(Engine::Codex, "default", "This Mac"),
                    signed_in: false,
                },
            ],
            engine_readings: vec![Quota {
                engine: Engine::Claude,
                windows: vec![window("five_hour", 40.0, 30 * 60_000)],
                plan: None,
            }],
            reading_from: vec![(Engine::Claude, Some("w1".into())), (Engine::Codex, None)],
            archived: Default::default(),
            samples: Default::default(),
            checks: Default::default(),
            agents: Vec::new(),
            local: Vec::new(),
            backlog: Vec::new(),
            today: NaiveDate::from_ymd_opt(2026, 11, 5).unwrap(),
            now: NOW,
        }
    }

    #[test]
    fn a_reading_belongs_only_to_the_account_it_came_from() {
        let inv = build(parts());
        let this_mac = &inv.accounts[0];
        let work = &inv.accounts[1];
        assert!(this_mac.windows.is_empty(), "never someone else's reading");
        assert_eq!(work.windows.len(), 1);
        // Codex isn't installed: listed as an engine, no accounts shown.
        assert!(inv.accounts.iter().all(|a| a.engine == Engine::Claude));
        assert!(!inv.engines[1].installed);
        // Turns go to the first account in order.
        assert!(this_mac.next && !work.next);
        assert_eq!(inv.engines[0].next_account.as_deref(), Some("This Mac"));
        // Work's window is spare, but not where turns would run.
        assert_eq!(inv.spare.len(), 1);
        assert!(!inv.spare[0].next);
    }

    #[test]
    fn with_no_source_recorded_a_reading_is_given_only_to_a_lone_account() {
        let mut p = parts();
        p.reading_from = vec![];
        let inv = build(p);
        assert!(inv.accounts.iter().all(|a| a.windows.is_empty()));

        let mut p = parts();
        p.reading_from = vec![];
        p.candidates.remove(1);
        let inv = build(p);
        assert_eq!(inv.accounts[0].windows.len(), 1);
        assert!(inv.spare[0].next);
    }

    #[test]
    fn an_archived_reading_fills_the_other_account_and_past_windows_drop() {
        let mut p = parts();
        p.archived.insert(
            "claude:default".into(),
            Quota {
                engine: Engine::Claude,
                windows: vec![
                    window("seven_day", 70.0, 3 * 86_400_000),
                    window("five_hour", 5.0, -1),
                ],
                plan: None,
            },
        );
        let inv = build(p);
        let this_mac = &inv.accounts[0];
        assert_eq!(this_mac.windows.len(), 1);
        assert_eq!(this_mac.windows[0].kind, "seven_day");
    }

    #[test]
    fn a_check_without_a_turn_newer_than_the_last_turn_wins_and_totals_follow() {
        let mut p = parts();
        // Work's last turn said 40% a minute ago; a check just now says 55%.
        let mut fresh = window("five_hour", 55.0, 30 * 60_000);
        fresh.observed_at = NOW;
        p.archived.insert(
            "claude:w1".into(),
            Quota {
                engine: Engine::Claude,
                windows: vec![fresh],
                plan: Some("max".into()),
            },
        );
        // This Mac couldn't be read, and says why.
        p.checks.insert(
            "claude:default".into(),
            usage_plan::Check {
                at: NOW,
                outcome: usage_plan::CheckOutcome::CantRead,
                why: Some("Its sign-in can't read limits without a turn".into()),
            },
        );
        let inv = build(p);
        let work = &inv.accounts[1];
        assert_eq!(work.windows[0].used_percent, Some(55.0));
        assert_eq!(work.plan.as_deref(), Some("max"));
        assert_eq!(inv.totals.accounts, 2);
        assert_eq!((inv.totals.read, inv.totals.room), (1, 1));
        let text = overview_text(&inv, &chrono::Utc);
        assert!(text.contains("TOTAL COMPUTE"));
        assert!(
            text.contains("2 accounts (Claude Code 2). Room now on 1 of 1 read (1 not read yet).")
        );
        assert!(text.contains("5-hour limits: 1 of 1 account has room"));
        assert!(text.contains("can't be read without a turn: its sign-in can't read limits"));
    }

    #[test]
    fn an_accounts_pace_is_served_from_its_own_readings_and_labelled() {
        let mut p = parts();
        // Work's five-hour window: 10 → 25 → 40% over the last hour (30 points
        // an hour), resetting in 3 hours: the 60 points left go in 2.
        let reset = NOW + 3 * 60 * 60_000;
        p.engine_readings[0].windows = vec![QuotaWindow {
            resets_at: Some(reset),
            ..window("five_hour", 40.0, 0)
        }];
        let sample = |used: f64, ago_min: i64| forecast::Sample {
            kind: "five_hour".into(),
            resets_at: Some(reset),
            used,
            tokens: 0,
            at: NOW - ago_min * 60_000,
        };
        p.samples.insert(
            "claude:w1".into(),
            vec![sample(10.0, 61), sample(25.0, 31), sample(40.0, 1)],
        );
        let inv = build(p);
        let (this_mac, work) = (&inv.accounts[0], &inv.accounts[1]);
        assert!(this_mac.pace.is_empty(), "no readings of its own");
        assert_eq!(work.pace.len(), 1);
        let pace = &work.pace[0];
        assert!(pace.estimate);
        assert_eq!(pace.reaches_at, NOW - 60_000 + 2 * 60 * 60_000);
        let text = overview_text(&inv, &chrono::Utc);
        assert!(text.contains("at the recent pace its 5-hour limit would run out"));
        assert!(text.contains("ESTIMATE from 3 readings over 60 minutes"));
        let json = serde_json::to_value(this_mac).unwrap();
        assert!(json.get("pace").is_none(), "absent, not empty, with none");
    }

    #[test]
    fn no_history_means_no_estimate_and_existing_history_counts_at_once() {
        let mut p = parts();
        let day = |d: &str, turns, input| DayUsage {
            day: d.into(),
            totals: UsageTotals {
                turns,
                input_tokens: input,
                ..Default::default()
            },
        };
        p.agents = vec![
            agent("new", Engine::Claude, vec![]),
            agent(
                "old",
                Engine::Claude,
                vec![day("2026-11-04", 3, 30_000), day("2026-11-05", 3, 30_000)],
            ),
        ];
        let inv = build(p);
        assert_eq!(inv.agents[0].per_turn, None);
        assert_eq!(inv.agents[1].per_turn.as_ref().unwrap().tokens, 10_000);
        assert_eq!(inv.engines[0].per_turn.as_ref().unwrap().runs, 6);
        let text = overview_text(&inv, &chrono::Utc);
        assert!(text.contains("ESTIMATES (from this user's past runs; not readings)"));
        assert!(text.contains("No reading."));
    }

    #[test]
    fn a_forecast_shares_a_window_only_once_a_rate_is_learned() {
        let mut p = parts();
        p.reading_from = vec![(Engine::Claude, Some("default".into()))];
        let inv = build(p);
        let per = PerRun {
            estimate: true,
            tokens: 100_000,
            low: 50_000,
            high: 150_000,
            runs: 9,
            days: 3,
        };
        let planned = [
            Planned {
                engine: Engine::Claude,
                label: "Research: 5 turns".into(),
                per_run: Some(per),
                runs: 5,
            },
            Planned {
                engine: Engine::Claude,
                label: "Newbie: 1 turn".into(),
                per_run: None,
                runs: 1,
            },
        ];
        let none = forecast(&inv, &Default::default(), &planned);
        assert_eq!(none[0].tokens, 500_000);
        assert_eq!(none[0].unknown, vec!["Newbie: 1 turn".to_string()]);
        assert!(none[0].shares.is_empty());
        assert_eq!(none[0].account.as_deref(), Some("This Mac"));

        let mut samples = std::collections::BTreeMap::new();
        let s = |used, tokens| forecast::Sample {
            kind: "five_hour".into(),
            resets_at: Some(NOW + 30 * 60_000),
            used,
            tokens,
            at: 0,
        };
        samples.insert(
            "claude:default".to_string(),
            vec![s(30.0, 0), s(40.0, 1_000_000)],
        );
        let learned = forecast(&inv, &samples, &planned);
        assert_eq!(learned[0].shares[0].percent, 5.0);
        assert!(learned[0].shares[0].fits);
        let text = forecast_text(&inv, &learned, &chrono::Utc);
        assert!(text.starts_with("ESTIMATE from this user's past runs (not a reading)"));
        assert!(text.contains("About 5% of its 5-hour limit"));
    }

    #[test]
    fn save_mode_asks_first_and_normal_never_does() {
        let mut p = parts();
        p.mode = (Mode::Save, 1);
        let inv = build(p);
        let f = vec![EngineForecast {
            engine: Engine::Claude,
            estimate: true,
            tokens: 1,
            unknown: vec!["a".into(), "b".into()],
            account: None,
            shares: vec![],
        }];
        assert!(forecast_text(&inv, &f, &chrono::Utc).contains("ask the user before starting"));
        let inv = build(parts());
        assert!(!forecast_text(&inv, &f, &chrono::Utc).contains("ask the user before starting"));
    }
}
