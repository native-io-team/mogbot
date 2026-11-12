//! # Automatic Error Reporting
//!
//! Sends error reports to the report endpoint named by `links.errorReports`
//! in brand.json. With no endpoint configured (the default) the whole
//! pipeline is off: nothing is sent anywhere, whatever the build or consent.
//! See `docs/error-reporting.md` for the endpoint contract.
//!
//! This complements Sentry (aggregation/alerting); the admin agent is the
//! act-on-it pipeline. Rules enforced here:
//!
//! - **Production builds only** — dev-loop noise never reaches the agent
//!   (override with `SHIPSTUDIO_BUG_REPORT_FORCE=1` for integration testing).
//! - **Secret stays in Rust** — injected at build time via
//!   `option_env!("BUG_REPORT_SECRET")`; builds without it are a silent no-op.
//! - **Fire-and-forget** — reporting can never block or fail the UX.
//! - **One report per fingerprint per app session** — the server dedups too,
//!   but we don't hammer it from tight error loops.
//! - **No PII** — messages and stacks are scrubbed of home-dir paths
//!   (usernames, project folder names) before leaving the machine, since
//!   reports can end up in public GitHub issues.
//! - **Opt-out respected** — turning off "Usage analytics & error reports" in
//!   Settings disables this pipeline entirely, alongside PostHog analytics.

use crate::logging::scrub_string;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Where reports go. `None` (no `links.errorReports` in brand.json) turns
/// reporting off entirely.
const ENDPOINT: Option<&str> = crate::brand::links::ERROR_REPORTS;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// Delivery receipts are separate from `bug-report-throttle.json`: the
/// throttle records attempts before network I/O, while this ledger records
/// only responses the endpoint explicitly accepted.
const RECEIPTS_FILENAME: &str = "automatic-report-receipts.json";
const RECEIPT_RETENTION_SECS: i64 = 30 * 24 * 60 * 60;
const MAX_REPORT_RECEIPTS: usize = 50;
const MAX_RECEIPT_SUMMARY_CHARS: usize = 240;
const MAX_RECEIPT_SOURCE_CHARS: usize = 80;
const MAX_RECEIPT_ISSUE_URL_BYTES: usize = 512;
const MAX_ACCEPTANCE_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_RECEIPT_LEDGER_BYTES: u64 = 512 * 1024;

static RECEIPT_LEDGER_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticReportReceipt {
    pub timestamp: String,
    pub kind: AutomaticReportKind,
    pub source: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_url: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomaticReportKind {
    Crash,
    Error,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptLedger {
    #[serde(default)]
    receipts: Vec<AutomaticReportReceipt>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticReportStatusReason {
    DevelopmentBuild,
    ConsentDisabled,
    MissingSecret,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticReportStatus {
    /// Whether the current build and consent setting allow reporting.
    pub enabled: bool,
    /// Whether this binary was built with the endpoint secret.
    pub configured: bool,
    /// Why delivery is unavailable, if the current build cannot send reports.
    pub reason: Option<AutomaticReportStatusReason>,
    pub receipts: Vec<AutomaticReportReceipt>,
}

struct AcceptedReport {
    issue_url: Option<String>,
}

/// Hard cap on reports per app session — a pathological error loop with
/// varying messages (which defeat fingerprint dedup) stops here.
const MAX_REPORTS_PER_SESSION: usize = 25;

/// Dedup keys already reported this app session.
static REPORTED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn enabled() -> bool {
    reporting_build_enabled() && reporting_consent_enabled()
}

fn reporting_build_enabled() -> bool {
    let force = std::env::var("SHIPSTUDIO_BUG_REPORT_FORCE").ok().as_deref() == Some("1");
    !cfg!(debug_assertions) || force
}

fn reporting_consent_enabled() -> bool {
    // Privacy: the Settings → "Usage analytics & error reports" toggle governs
    // this pipeline too. Opted-out users share nothing — not even scrubbed
    // crash reports. This is the single authoritative check; every report
    // (frontend or backend) funnels through here.
    crate::commands::setup::read_app_state()
        .analytics_enabled
        .unwrap_or(true)
}

fn secret() -> Option<&'static str> {
    ENDPOINT?;
    option_env!("BUG_REPORT_SECRET").filter(|s| !s.is_empty())
}

/// Stable per-session dedup key: the explicit fingerprint when the catch-site
/// provides one, otherwise source + the first line of the message.
fn dedupe_key(message: &str, source: &str, fingerprint: Option<&str>) -> String {
    match fingerprint {
        Some(f) => f.to_string(),
        None => {
            let first_line = message.lines().next().unwrap_or_default();
            let truncated: String = first_line.chars().take(200).collect();
            format!("{source}:{truncated}")
        }
    }
}

/// Returns true only the first time a key is seen this session.
fn first_occurrence(key: &str) -> bool {
    match REPORTED.lock() {
        Ok(mut seen) => {
            if seen.len() >= MAX_REPORTS_PER_SESSION {
                return false;
            }
            seen.insert(key.to_string())
        }
        // Poisoned lock (a panic mid-insert): stop reporting rather than risk
        // duplicate storms.
        Err(_) => false,
    }
}

// --- Cross-session throttle ------------------------------------------------
//
// Each report can trigger a paid agent investigation, so the in-session dedup
// alone isn't enough: a crash-looping install that relaunches every few
// seconds would send one report per relaunch. Persist a small throttle file
// next to app_state.json: the same fingerprint reports at most once per 24h,
// and there's a global daily cap per machine. Any I/O failure fails open to
// the in-session dedup — a broken disk must not disable crash reporting.

/// Same fingerprint reports at most once per this window, across restarts.
const REFRACTORY_SECS: i64 = 24 * 60 * 60;
/// Global daily report cap per machine.
const DAILY_CAP: usize = 30;
/// Bound the throttle file: prune entries older than this…
const PRUNE_AFTER_SECS: i64 = 7 * 24 * 60 * 60;
/// …and never track more fingerprints than this (oldest dropped first).
const MAX_TRACKED_FINGERPRINTS: usize = 300;

#[derive(Default, Serialize, Deserialize)]
struct Throttle {
    #[serde(default)]
    day: String,
    #[serde(default)]
    count: usize,
    /// fingerprint -> unix timestamp of last report
    #[serde(default)]
    fingerprints: HashMap<String, i64>,
}

fn throttle_path() -> Option<PathBuf> {
    Some(crate::brand::app_support_dir().join("bug-report-throttle.json"))
}

fn receipt_ledger_path() -> Option<PathBuf> {
    Some(crate::brand::app_support_dir().join(RECEIPTS_FILENAME))
}

fn read_receipts(path: &Path, now: chrono::DateTime<chrono::Utc>) -> Vec<AutomaticReportReceipt> {
    let mut receipts = read_receipt_file(path);
    prune_receipts(&mut receipts, now);
    receipts
}

fn read_receipt_file(path: &Path) -> Vec<AutomaticReportReceipt> {
    if std::fs::metadata(path)
        .map(|metadata| metadata.len() > MAX_RECEIPT_LEDGER_BYTES)
        .unwrap_or(true)
    {
        return Vec::new();
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ReceiptLedger>(&contents).ok())
        .map(|ledger| ledger.receipts)
        .unwrap_or_default()
}

fn prune_receipts(receipts: &mut Vec<AutomaticReportReceipt>, now: chrono::DateTime<chrono::Utc>) {
    let cutoff = now - chrono::Duration::seconds(RECEIPT_RETENTION_SECS);
    receipts.retain(|receipt| {
        chrono::DateTime::parse_from_rfc3339(&receipt.timestamp)
            .map(|timestamp| timestamp.with_timezone(&chrono::Utc) >= cutoff)
            .unwrap_or(false)
    });
    receipts.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    receipts.truncate(MAX_REPORT_RECEIPTS);
}

fn persist_receipt(
    path: &Path,
    receipt: AutomaticReportReceipt,
    now: chrono::DateTime<chrono::Utc>,
) {
    let Ok(_guard) = RECEIPT_LEDGER_LOCK.lock() else {
        return;
    };

    let mut receipts = read_receipts(path, now.clone());
    receipts.push(receipt);
    prune_receipts(&mut receipts, now);
    write_receipts(path, &receipts);
}

fn persist_panic_receipt(
    path: &Path,
    receipt: AutomaticReportReceipt,
    now: chrono::DateTime<chrono::Utc>,
) {
    // The panic hook joins this request thread to preserve the send timeout.
    // Never wait on another report's receipt write here; a missing local
    // receipt is safer than extending a crash path indefinitely.
    let Ok(_guard) = RECEIPT_LEDGER_LOCK.try_lock() else {
        return;
    };
    let mut receipts = read_receipts(path, now.clone());
    receipts.push(receipt);
    prune_receipts(&mut receipts, now);
    write_receipts(path, &receipts);
}

fn write_receipts(path: &Path, receipts: &[AutomaticReportReceipt]) {
    let ledger = ReceiptLedger {
        receipts: receipts.to_vec(),
    };
    let Ok(contents) = serde_json::to_vec(&ledger) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }

    let Ok(mut temporary) = tempfile::NamedTempFile::new_in(parent) else {
        return;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // NamedTempFile is owner-only by default; explicitly keep that
        // contract for this local copy of error summaries too.
        let Ok(metadata) = temporary.as_file().metadata() else {
            return;
        };
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        if temporary.as_file().set_permissions(permissions).is_err() {
            return;
        }
    }
    use std::io::Write;
    if temporary.write_all(&contents).is_err() || temporary.as_file().sync_all().is_err() {
        return;
    }
    let _ = temporary.persist(path);
}

fn read_recent_receipts(
    path: &Path,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<AutomaticReportReceipt> {
    let Ok(_guard) = RECEIPT_LEDGER_LOCK.lock() else {
        return Vec::new();
    };
    let mut receipts = read_receipt_file(path);
    let prior_len = receipts.len();
    prune_receipts(&mut receipts, now);
    if receipts.len() != prior_len {
        write_receipts(path, &receipts);
    }
    receipts
}

fn make_receipt(
    source: &str,
    message: &str,
    issue_url: Option<String>,
    now: chrono::DateTime<chrono::Utc>,
) -> AutomaticReportReceipt {
    let safe_source: String = scrub_string(source)
        .chars()
        .take(MAX_RECEIPT_SOURCE_CHARS)
        .collect();
    let summary = safe_receipt_summary(message);

    AutomaticReportReceipt {
        timestamp: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        kind: if matches!(source, "panic" | "frontend-crash") {
            AutomaticReportKind::Crash
        } else {
            AutomaticReportKind::Error
        },
        source: safe_source,
        summary,
        issue_url,
    }
}

/// Keep receipt summaries useful while removing common inline credentials and
/// account identifiers in addition to the home paths handled by
/// `logging::scrub_string`.
fn safe_receipt_summary(message: &str) -> String {
    let scrubbed_message = scrub_string(message);
    let first_line = scrubbed_message.lines().next().unwrap_or_default();
    let mut safe_words = Vec::new();
    let mut redact_next = false;

    for word in first_line.split_whitespace() {
        let lower = word.to_ascii_lowercase();
        if redact_next {
            if matches!(word, "=" | ":") {
                safe_words.push(word.to_string());
                continue;
            }
            safe_words.push("<redacted>".to_string());
            redact_next = lower == "bearer";
            continue;
        }

        if let Some(separator) = word.find(|character| character == '=' || character == ':') {
            if is_sensitive_receipt_label(&word[..separator]) {
                let value = word[separator + 1..]
                    .trim_matches(|character| character == '"' || character == '\'');
                if value.is_empty() {
                    safe_words.push(word[..=separator].to_string());
                    redact_next = true;
                } else {
                    safe_words.push(format!("{}<redacted>", &word[..=separator]));
                }
                continue;
            }
        }

        let label = word.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}'
            )
        });
        if is_sensitive_receipt_label(label) {
            safe_words.push(word.to_string());
            redact_next = true;
        } else if looks_like_receipt_secret(&lower) || looks_like_email(label) {
            safe_words.push("<redacted>".to_string());
        } else {
            safe_words.push(word.to_string());
        }
    }

    safe_words
        .join(" ")
        .chars()
        .take(MAX_RECEIPT_SUMMARY_CHARS)
        .collect()
}

fn is_sensitive_receipt_label(label: &str) -> bool {
    let label = label
        .trim_matches(|character: char| {
            matches!(character, '"' | '\'' | '{' | '}' | '[' | ']' | ',')
        })
        .to_ascii_lowercase();
    matches!(
        label.as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "api_key"
            | "api-key"
            | "secret"
            | "client_secret"
            | "password"
            | "authorization"
            | "cookie"
            | "username"
            | "user"
            | "user_id"
            | "email"
    ) || ["_token", "_secret", "_password", "_key", "_email"]
        .iter()
        .any(|suffix| label.ends_with(suffix))
}

fn looks_like_receipt_secret(word: &str) -> bool {
    [
        "ghp_",
        "github_pat_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "sk-ant-",
        "sk-proj-",
        "sk-",
        "xoxb-",
        "xoxp-",
        "xapp-",
        "akia",
    ]
    .iter()
    .any(|prefix| word.starts_with(prefix))
}

fn looks_like_email(word: &str) -> bool {
    word.split_once('@')
        .is_some_and(|(_, domain)| domain.contains('.'))
}

/// Check + record `key` against the persistent throttle. Corrupt or missing
/// files reset to an empty throttle (fail open); write failures are ignored.
fn passes_persistent_throttle(path: &Path, key: &str, now: i64, today: &str) -> bool {
    let mut throttle: Throttle = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    if throttle.day != today {
        throttle.day = today.to_string();
        throttle.count = 0;
    }
    if throttle.count >= DAILY_CAP {
        return false;
    }
    if let Some(&last) = throttle.fingerprints.get(key) {
        if now - last < REFRACTORY_SECS {
            return false;
        }
    }

    throttle.count += 1;
    throttle.fingerprints.insert(key.to_string(), now);
    throttle
        .fingerprints
        .retain(|_, ts| now - *ts < PRUNE_AFTER_SECS);
    if throttle.fingerprints.len() > MAX_TRACKED_FINGERPRINTS {
        let mut by_age: Vec<(String, i64)> = throttle
            .fingerprints
            .iter()
            .map(|(k, ts)| (k.clone(), *ts))
            .collect();
        by_age.sort_by_key(|(_, ts)| *ts);
        for (old_key, _) in by_age
            .iter()
            .take(throttle.fingerprints.len() - MAX_TRACKED_FINGERPRINTS)
        {
            throttle.fingerprints.remove(old_key);
        }
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string(&throttle) {
        let _ = std::fs::write(path, serialized);
    }
    true
}

// --- Incident collapse ------------------------------------------------------
//
// One failure often fires several reporting channels within milliseconds:
// the backend logs `tracing::error!`, the `CommandError` crosses IPC (its
// Serialize hook), and the frontend shows an error toast. Each carries a
// different fingerprint, so dedup alone won't merge them — and each unique
// report can trigger a paid investigation. The first channel to fire wins;
// anything else inside the gap is suppressed *before* any dedup state is
// recorded, so a genuine recurrence later can still report.

const MIN_GAP: Duration = Duration::from_secs(5);
static LAST_REPORT_ATTEMPT_AT: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));

fn within_min_gap() -> bool {
    match LAST_REPORT_ATTEMPT_AT.lock() {
        Ok(guard) => matches!(*guard, Some(t) if t.elapsed() < MIN_GAP),
        Err(_) => true, // poisoned: suppress rather than risk a storm
    }
}

fn mark_report_attempted() {
    if let Ok(mut guard) = LAST_REPORT_ATTEMPT_AT.lock() {
        *guard = Some(Instant::now());
    }
}

/// Session dedup read-only check — no state is recorded.
fn session_already_seen(key: &str) -> bool {
    match REPORTED.lock() {
        Ok(seen) => seen.len() >= MAX_REPORTS_PER_SESSION || seen.contains(key),
        Err(_) => true,
    }
}

/// Full send gate: session dedup, incident collapse, then the persistent
/// cross-session throttle. Returns true when this occurrence should be sent.
/// `respect_gap: false` is for panics — a crash report must never be
/// swallowed because some lesser error fired just before it.
fn allow_report_with_gap(key: &str, respect_gap: bool) -> bool {
    if session_already_seen(key) {
        return false;
    }
    if respect_gap && within_min_gap() {
        return false;
    }
    if !first_occurrence(key) {
        return false;
    }
    let allowed = match throttle_path() {
        None => true,
        Some(path) => {
            let now = chrono::Utc::now();
            passes_persistent_throttle(
                &path,
                key,
                now.timestamp(),
                &now.format("%Y-%m-%d").to_string(),
            )
        }
    };
    if allowed {
        mark_report_attempted();
    }
    allowed
}

fn allow_report(key: &str) -> bool {
    allow_report_with_gap(key, true)
}

fn build_body(
    message: &str,
    stack: Option<&str>,
    source: &str,
    fingerprint: Option<&str>,
) -> serde_json::Value {
    json!({
        "message": scrub_string(message),
        "stack": stack.map(scrub_string),
        "source": source,
        "appVersion": env!("CARGO_PKG_VERSION"),
        // Scrubbed defensively like message/stack — fingerprints are meant to
        // be static slugs, but nothing should leave unscrubbed.
        "fingerprint": fingerprint.map(scrub_string),
        "context": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
    })
}

fn validated_issue_url(value: &serde_json::Value) -> Option<String> {
    let candidate = value.as_str()?;
    if candidate.len() > MAX_RECEIPT_ISSUE_URL_BYTES {
        return None;
    }
    let parsed = url::Url::parse(candidate).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    let path: Vec<&str> = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    if path.len() != 4
        || path[0].is_empty()
        || path[1].is_empty()
        || path[2] != "issues"
        || path[3].is_empty()
        || !path[3].chars().all(|character| character.is_ascii_digit())
    {
        return None;
    }

    Some(parsed.to_string())
}

fn parse_accepted_response(status: reqwest::StatusCode, body: &[u8]) -> Option<AcceptedReport> {
    if !status.is_success() {
        return None;
    }
    let response: serde_json::Value = serde_json::from_slice(body).ok()?;
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }

    let issue_url = response
        .get("issueUrl")
        .or_else(|| response.get("issue_url"))
        .and_then(validated_issue_url);
    Some(AcceptedReport { issue_url })
}

async fn post(secret: &'static str, body: serde_json::Value) -> Option<AcceptedReport> {
    let response = reqwest::Client::new()
        .post(ENDPOINT?)
        .bearer_auth(secret)
        .json(&body)
        .timeout(SEND_TIMEOUT)
        .send()
        .await;
    let response = response.ok()?;
    let status = response.status();
    let body = response.bytes().await.ok()?;
    if body.len() > MAX_ACCEPTANCE_RESPONSE_BYTES {
        return None;
    }
    parse_accepted_response(status, &body)
}

/// Report an error to the admin agent. Fire-and-forget: returns immediately,
/// never blocks, never surfaces a failure.
///
/// Call this from `Err` branches at known catch-sites with a stable
/// `fingerprint` slug (e.g. `"cmd-publish_to_staging"`) so repeat occurrences
/// land on the agent's existing session instead of filing duplicate issues.
pub fn report_error(message: &str, stack: Option<&str>, source: &str, fingerprint: Option<&str>) {
    if !enabled() {
        return;
    }
    let Some(secret) = secret() else { return };
    if !allow_report(&dedupe_key(message, source, fingerprint)) {
        return;
    }
    let body = build_body(message, stack, source, fingerprint);
    let receipt_source = source.to_string();
    let receipt_message = message.to_string();
    tauri::async_runtime::spawn(async move {
        if let Some(accepted) = post(secret, body).await {
            if let Some(path) = receipt_ledger_path() {
                let now = chrono::Utc::now();
                let receipt =
                    make_receipt(&receipt_source, &receipt_message, accepted.issue_url, now);
                persist_receipt(&path, receipt, now);
            }
        }
    });
}

/// How a problem report the user asked for went (`send_user_report`).
#[derive(Debug, PartialEq, Eq)]
pub enum UserReportOutcome {
    /// The endpoint took it; `issue_url` only when it returned a valid one.
    Sent { issue_url: Option<String> },
    /// This build sends no reports (no endpoint or secret, or a dev build).
    Off,
    /// It didn't go: the network, or the endpoint said no.
    Failed,
}

/// Longest problem description sent, in characters.
const MAX_USER_REPORT_CHARS: usize = 6000;

/// The body of a problem report the user asked for, in their words: scrubbed
/// like every report (home paths), its text capped, `source: user-report`.
fn user_report_body(title: &str, details: &str) -> serde_json::Value {
    let details: String = details.chars().take(MAX_USER_REPORT_CHARS).collect();
    let mut body = build_body(&format!("User report: {title}"), None, "user-report", None);
    body["context"]["details"] = json!(scrub_string(&details));
    body
}

/// Send a problem report the user asked for in chat, after they saw its exact
/// text on a card (`report_problem`). Unlike automatic reports it isn't held
/// by the usage-and-error-reports switch, the session dedup or the daily cap:
/// the user chose to send this one. Same endpoint, secret and scrubbing.
pub async fn send_user_report(title: &str, details: &str) -> UserReportOutcome {
    if !reporting_build_enabled() {
        return UserReportOutcome::Off;
    }
    let Some(secret) = secret() else {
        return UserReportOutcome::Off;
    };
    if ENDPOINT.is_none() {
        return UserReportOutcome::Off;
    }
    match post(secret, user_report_body(title, details)).await {
        Some(accepted) => {
            if let Some(path) = receipt_ledger_path() {
                let now = chrono::Utc::now();
                let receipt = make_receipt("user-report", title, accepted.issue_url.clone(), now);
                persist_receipt(&path, receipt, now);
            }
            UserReportOutcome::Sent {
                issue_url: accepted.issue_url,
            }
        }
        None => UserReportOutcome::Failed,
    }
}

/// Cap on how much captured backtrace ships with a panic report. Backtraces
/// from release builds are mostly hex frames plus a handful of symbolized
/// ones — the useful part is at the top, and reports can end up in public
/// GitHub issues, so keep the payload bounded.
const PANIC_BACKTRACE_MAX_CHARS: usize = 4000;

/// The panic report's `stack` field: the panic location (always first — it's
/// the one guaranteed-symbolized frame) followed by the captured backtrace,
/// truncated to [`PANIC_BACKTRACE_MAX_CHARS`]. Everything here passes through
/// `scrub_string` in [`build_body`] before leaving the machine.
fn panic_stack(location: Option<&str>, backtrace: &str) -> String {
    let mut truncated: String = backtrace.chars().take(PANIC_BACKTRACE_MAX_CHARS).collect();
    if truncated.len() < backtrace.len() {
        truncated.push_str("\n… [backtrace truncated]");
    }
    match location {
        Some(l) => format!("{l}\n{truncated}"),
        None => truncated,
    }
}

/// Panic-path variant: sends synchronously (bounded by [`SEND_TIMEOUT`])
/// because the process may be about to die and a spawned task would be lost.
fn report_panic(message: &str, location: Option<&str>, backtrace: &str) {
    if !enabled() {
        return;
    }
    let Some(secret) = secret() else { return };
    let fingerprint = location.map(|l| format!("panic-{}", scrub_string(l)));
    if !allow_report_with_gap(&dedupe_key(message, "panic", fingerprint.as_deref()), false) {
        return;
    }
    let stack = panic_stack(location, backtrace);
    let body = build_body(
        &format!("panic: {message}"),
        Some(&stack),
        "panic",
        fingerprint.as_deref(),
    );
    let receipt_message = format!("panic: {message}");
    // Dedicated thread + single-threaded runtime: the panic hook can fire on
    // any thread, including inside an async context where block_on would panic.
    let handle = std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            if let Some(accepted) = rt.block_on(post(secret, body)) {
                if let Some(path) = receipt_ledger_path() {
                    let now = chrono::Utc::now();
                    let receipt = make_receipt("panic", &receipt_message, accepted.issue_url, now);
                    persist_panic_receipt(&path, receipt, now);
                }
            }
        }
    });
    let _ = handle.join();
}

/// A string-slicing panic without the string. The standard library quotes
/// up to 256 characters of the string it was slicing ("byte index 25 is not
/// a char boundary; it is inside 'İ' (bytes 24..26) of `Finance works…`"),
/// which can be anything: a message from another assistant, an agent's
/// instructions. What failed and where is kept; the text never reaches the
/// crash log or the report.
fn without_sliced_text(message: &str) -> String {
    let slicing = [
        "byte index ",
        "begin <= end ",
        "end byte index ",
        "failed to slice string",
    ]
    .iter()
    .any(|p| message.starts_with(p));
    if !slicing {
        return message.to_string();
    }
    let cut = [";", " of `", " when slicing `"]
        .iter()
        .filter_map(|m| message.find(m))
        .min()
        .unwrap_or(message.len());
    format!("{} [string text removed]", &message[..cut])
}

/// Install a panic hook that reports to the admin agent, chaining the
/// previously installed hook (Sentry's, when initialized) so both fire.
/// Call after `logging::init_sentry()`.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic with non-string payload".to_string());
        let message = without_sliced_text(&message);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        // Capture a real stack, not just the panic's file:line — panics that
        // abort the process (e.g. unwinding across an FFI/dispatch boundary,
        // issue #684) otherwise leave no trace of how they were reached.
        // `force_capture` ignores RUST_BACKTRACE, so user machines don't need
        // any env setup for the frames to exist.
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        // Write the local crash record FIRST, before the network report and
        // before any chained hook. A panic that aborts the process (unwinding
        // across an FFI/dispatch boundary, issue #684) gets no orderly
        // shutdown, and the normal log file is behind `tracing_appender`'s
        // non-blocking worker thread — so anything logged through `tracing`
        // here dies buffered and the user's log just stops mid-line, with no
        // `.ips` from the OS either. That is the "it silently vanished"
        // report: the app leaves no evidence of its own death on the machine
        // it died on. This write is synchronous and flushed, so it survives.
        write_panic_crashlog(&message, location.as_deref(), &backtrace);
        report_panic(&message, location.as_deref(), &backtrace);
        prev(info);
    }));
}

/// Filename the panic hook appends to, beside the rotating `ship-studio.log`
/// files. Deliberately NOT one of them: the rotating writer prunes to the
/// last 14 days and a crash record is the one line worth keeping past that.
const PANIC_CRASHLOG_FILENAME: &str = "ship-studio-crash.log";

/// Append a panic to `<log dir>/ship-studio-crash.log`, synchronously.
///
/// Deliberately bypasses `tracing`: the file layer is a
/// `tracing_appender::non_blocking` writer, whose worker thread never gets
/// scheduled when a panic aborts the process, so a `tracing::error!` here
/// would be lost exactly when it matters most. Opened, written and flushed
/// inline instead — best-effort, and every failure is swallowed, because a
/// panic hook that panics aborts with even less to show for it.
///
/// Unscrubbed on purpose: this file never leaves the machine (the scrubbed
/// copy goes to the admin agent via `report_panic`), and stripping the
/// user's own paths out of their own crash log only makes it harder to read.
fn write_panic_crashlog(message: &str, location: Option<&str>, backtrace: &str) {
    append_panic_record(&crate::logging::get_log_dir(), message, location, backtrace);
}

/// The write itself, with the directory injected so it is testable without
/// touching the real log directory.
fn append_panic_record(dir: &Path, message: &str, location: Option<&str>, backtrace: &str) {
    use std::io::Write;

    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(PANIC_CRASHLOG_FILENAME);

    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    // Owner-only. This file is deliberately unscrubbed — it holds the user's
    // own paths and panic messages, which is the point of a local crash record
    // — and `get_log_dir` falls back to /tmp/ship-studio-logs when the home
    // directory cannot be resolved. /tmp is world-readable, so on that path
    // the default umask would publish a crash log to every account on the
    // machine. The mode applies only at creation; an existing file keeps its
    // own, which is correct for a log the user may have chosen to share.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let Ok(mut file) = options.open(&path) else {
        return;
    };

    let when = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let record = format!(
        "\n===== PANIC =====\nunix_time: {when}\nversion:   {}\npid:       {}\nthread:    {}\nlocation:  {}\nmessage:   {message}\nbacktrace:\n{backtrace}\n",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        std::thread::current().name().unwrap_or("<unnamed>"),
        location.unwrap_or("<unknown>"),
    );
    let _ = file.write_all(record.as_bytes());
    let _ = file.flush();
}

/// Derive a stable fingerprint for a `CommandError` crossing the IPC
/// boundary. `None` for both the skip-entirely case and variants whose
/// messages carry the only useful identity (dedup falls back to content).
fn command_error_fingerprint(err: &crate::errors::CommandError) -> Option<String> {
    use crate::errors::CommandError as E;
    match err {
        E::Timeout { cmd, .. } => Some(format!("cmderr-timeout-{cmd}")),
        E::Process { cmd, .. } => Some(format!("cmderr-process-{cmd}")),
        E::MergeConflict { .. } => Some("cmderr-merge-conflict".to_string()),
        E::Validation { .. }
        | E::NotAuthenticated { .. }
        | E::Io { .. }
        | E::Expected { .. }
        | E::Other { .. } => None,
    }
}

/// True when `message` carries git's "not a git repository" fatal — in any
/// locale. Git translates the whole sentence (a Spanish install emits
/// "fatal: no es un repositorio git (ni ninguno de los directorios
/// superiores): .git", issue #672), so the English substring alone silently
/// missed non-English machines. Rather than enumerating languages, also match
/// the locale-invariant part: the untranslated `.git` marker git was probing
/// for, which every translation substitutes into the sentence.
///
/// The original tail check ("ends with `: .git`") assumed the marker always
/// lands at the end — true for English/Spanish/French/Chinese, but Italian's
/// translation moves the placeholder to the *front* (`.git non è un repository
/// Git (né lo è alcuna delle directory genitrici)`), so those reports kept
/// reaching telemetry (issue #727). Scanning for a standalone `.git` token
/// instead catches both word orders while still excluding remote URLs, where
/// `.git` is glued to the repo name (`…/repo.git'` tokenizes as `…/repo.git`,
/// never a bare `.git`).
///
/// Quotes are deliberately NOT separators. Git substitutes the probe marker
/// into the not-a-repo sentence bare (`…): .git`) in every locale, but quotes
/// paths in access failures (`fatal: cannot access '.git': Operation not
/// permitted` — a real macOS TCC / permissions problem). Treating quotes as
/// separators made `'.git'` tokenize to `.git`, so that genuine failure was
/// suppressed as benign and the user's report never arrived.
fn is_not_a_git_repo_message(message: &str) -> bool {
    if message
        .to_ascii_lowercase()
        .contains("not a git repository")
    {
        return true;
    }
    message
        .split(|c: char| c.is_whitespace() || "()（）:：".contains(c))
        .any(|token| token == ".git")
}

/// Report a `CommandError` the moment it's serialized for the frontend —
/// the one choke point that sees every backend failure a user experiences.
/// Called from `CommandError`'s `Serialize` impl.
///
/// Skipped variants are states where the app is working correctly:
/// - `NotAuthenticated` — a not-yet-connected integration is expected.
/// - `Validation` — user-input feedback rendered inline. These were
///   deliberately reported at first (and did surface one real UX dead end,
///   issue #287), but a cost audit showed the class is overwhelmingly
///   "app refusing correctly" noise at investigation prices.
/// - `Expected` — the typed marker for by-design refusals, environment gaps
///   ("install X first"), and benign races, classified at the throw site.
///   New skip cases belong THERE, not in message sniffing here.
///
/// One message-text exception remains: "not a git repository" arrives inside
/// arbitrary git stderr passthrough (issue #254; locale-tolerant matching via
/// [`is_not_a_git_repo_message`], issue #672), so it can't be typed at a
/// throw site.
pub fn report_command_error(err: &crate::errors::CommandError) {
    use crate::errors::CommandError as E;
    if matches!(
        err,
        E::NotAuthenticated { .. } | E::Validation { .. } | E::Expected { .. }
    ) {
        return;
    }
    if let E::Other { message } = err {
        if is_not_a_git_repo_message(message) {
            return;
        }
    }
    let fingerprint = command_error_fingerprint(err);
    report_error(
        &err.to_string(),
        None,
        "command-error",
        fingerprint.as_deref(),
    );
}

// --- Tracing integration ---------------------------------------------------

/// Forwards every `tracing::error!` from Ship Studio code to the admin agent,
/// fingerprinted by callsite (`rs-<file>:<line>` — stable across occurrences
/// and releases). Attached in `logging::init_logging()` alongside the Sentry
/// layer, so any error-level log — existing or future — reports automatically
/// without per-site wiring. When something isn't working as intended, log it
/// with `tracing::error!` and the agent hears about it.
pub struct AdminAgentLayer;

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for AdminAgentLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let meta = event.metadata();
        if *meta.level() != tracing::Level::ERROR {
            return;
        }
        let target = meta.target();
        // Only our own code — error logs from dependencies aren't our bugs.
        if !target.starts_with("app_lib") {
            return;
        }
        // Frontend logger errors arrive via `logging::log_frontend_event`; the
        // frontend reports those itself with proper stacks (`errorReporting.ts`).
        // Skipping here prevents double reports for the same incident.
        if target.starts_with("app_lib::logging") {
            return;
        }

        let mut visitor = EventVisitor::default();
        event.record(&mut visitor);
        if visitor.message.is_empty() {
            return;
        }
        let fingerprint = match (meta.file(), meta.line()) {
            (Some(file), Some(line)) => Some(format!("rs-{file}:{line}")),
            _ => None,
        };
        let fields = if visitor.fields.is_empty() {
            None
        } else {
            Some(visitor.fields.join("\n"))
        };
        report_error(
            &visitor.message,
            fields.as_deref(),
            target,
            fingerprint.as_deref(),
        );
    }
}

/// Collects the event's `message` field plus remaining fields as `key=value`
/// lines (sent as the report's `stack` for extra context).
#[derive(Default)]
struct EventVisitor {
    message: String,
    fields: Vec<String>,
}

impl tracing::field::Visit for EventVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.fields.push(format!("{}={:?}", field.name(), value));
        }
    }
}

/// Forward an uncaught frontend error (ErrorBoundary, window.onerror,
/// unhandledrejection) to the admin agent. The frontend gates on production
/// and dedups per fingerprint too; this side re-checks both and scrubs paths.
#[tauri::command]
#[tracing::instrument(skip_all)]
pub fn report_frontend_error(
    message: String,
    stack: Option<String>,
    source: Option<String>,
    fingerprint: Option<String>,
) {
    report_error(
        &message,
        stack.as_deref(),
        source.as_deref().unwrap_or("frontend"),
        fingerprint.as_deref(),
    );
}

/// Read the recent reports whose delivery was explicitly accepted by the
/// admin-agent endpoint. Attempt throttles live in a different file and are
/// never exposed as receipts.
#[tauri::command]
#[tracing::instrument(skip_all)]
pub fn get_automatic_report_status() -> Result<AutomaticReportStatus, crate::errors::CommandError> {
    let build_enabled = reporting_build_enabled();
    let consent_enabled = reporting_consent_enabled();
    let configured = secret().is_some();
    let enabled = build_enabled && consent_enabled;
    let reason = if !build_enabled {
        Some(AutomaticReportStatusReason::DevelopmentBuild)
    } else if !consent_enabled {
        Some(AutomaticReportStatusReason::ConsentDisabled)
    } else if !configured {
        Some(AutomaticReportStatusReason::MissingSecret)
    } else {
        None
    };
    let receipts = receipt_ledger_path()
        .map(|path| read_recent_receipts(&path, chrono::Utc::now()))
        .unwrap_or_default();

    Ok(AutomaticReportStatus {
        enabled,
        configured,
        reason,
        receipts,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_user_report_is_scrubbed_capped_and_marked_as_theirs() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        let long = "x".repeat(super::MAX_USER_REPORT_CHARS + 50);
        let body = super::user_report_body(
            "The phone drops",
            &format!("It said {home}/Desktop/secret.txt. {long}"),
        );
        assert_eq!(body["source"], "user-report");
        assert_eq!(body["message"], "User report: The phone drops");
        let details = body["context"]["details"].as_str().unwrap();
        assert!(!details.contains(&home), "home path left in: {details}");
        assert!(details.chars().count() <= super::MAX_USER_REPORT_CHARS);
    }

    #[test]
    fn a_slicing_panic_never_carries_the_string() {
        let text = "Finance works from our İstanbul office. password: hunter22";
        let caught = std::panic::catch_unwind(|| {
            // Inside the two bytes of "İ".
            let at = text.find('İ').unwrap() + 1;
            text[at..].len()
        });
        let payload = caught.unwrap_err();
        let raw = payload
            .downcast_ref::<String>()
            .cloned()
            .unwrap_or_default();
        assert!(raw.contains("İstanbul"), "the std message quotes it: {raw}");
        let clean = super::without_sliced_text(&raw);
        assert!(
            !clean.contains("Istanbul") && !clean.contains("İstanbul"),
            "{clean}"
        );
        assert!(!clean.contains("hunter22"), "{clean}");
        assert!(clean.starts_with("byte index "), "{clean}");
        // Other panics are left as they are.
        assert_eq!(
            super::without_sliced_text("called `Option::unwrap()` on a `None` value"),
            "called `Option::unwrap()` on a `None` value"
        );
    }

    #[test]
    fn panic_crashlog_records_message_location_and_backtrace() {
        let dir = tempfile::tempdir().unwrap();
        append_panic_record(
            dir.path(),
            "attempt to unwrap a None value",
            Some("src/commands/ide/screenshots/webview_snapshot.rs:241:17"),
            "0: ship_studio_lib::snapshot\n1: objc2::rc::autoreleasepool",
        );

        let written = std::fs::read_to_string(dir.path().join(PANIC_CRASHLOG_FILENAME)).unwrap();
        assert!(written.contains("attempt to unwrap a None value"));
        assert!(written.contains("webview_snapshot.rs:241:17"));
        assert!(written.contains("objc2::rc::autoreleasepool"));
        // The whole point is knowing WHICH run died — a record with no pid or
        // version can't be matched against the user's log file.
        assert!(written.contains(&std::process::id().to_string()));
        assert!(written.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn panic_crashlog_appends_rather_than_truncating() {
        let dir = tempfile::tempdir().unwrap();
        append_panic_record(dir.path(), "first death", None, "bt-one");
        append_panic_record(dir.path(), "second death", None, "bt-two");

        let written = std::fs::read_to_string(dir.path().join(PANIC_CRASHLOG_FILENAME)).unwrap();
        // Crashing five times in a day is the actual report this exists to
        // answer; a writer that truncates would keep only the last one.
        assert!(written.contains("first death"), "earlier panic was lost");
        assert!(written.contains("second death"));
        assert_eq!(written.matches("===== PANIC =====").count(), 2);
    }

    /// The crash log carries unscrubbed paths, and the log directory falls
    /// back to world-readable /tmp when the home directory is unavailable.
    #[cfg(unix)]
    #[test]
    fn panic_crashlog_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        append_panic_record(dir.path(), "secrets in the path", None, "bt");

        let mode = std::fs::metadata(dir.path().join(PANIC_CRASHLOG_FILENAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "crash log was created group/world readable");
    }

    #[test]
    fn panic_crashlog_creates_a_missing_log_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("Logs").join("ShipStudio");
        append_panic_record(&nested, "panic before logging was set up", None, "bt");

        assert!(nested.join(PANIC_CRASHLOG_FILENAME).exists());
    }

    #[test]
    fn panic_crashlog_never_propagates_a_failure() {
        // An unwritable destination must be swallowed: this runs inside the
        // panic hook, where a second panic aborts with nothing recorded.
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("taken");
        std::fs::write(&blocked, "I am a file, not a directory").unwrap();

        append_panic_record(&blocked, "message", None, "bt");
    }

    use super::*;

    #[test]
    fn accepted_delivery_requires_success_status_and_explicit_ok() {
        let accepted = parse_accepted_response(
            reqwest::StatusCode::OK,
            br#"{"ok":true,"issueUrl":"https://github.com/ship-studio/ship-studio/issues/42"}"#,
        )
        .expect("documented endpoint acceptance should be recorded");
        assert_eq!(
            accepted.issue_url.as_deref(),
            Some("https://github.com/ship-studio/ship-studio/issues/42")
        );

        assert!(parse_accepted_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            br#"{"ok":true}"#
        )
        .is_none());
        assert!(parse_accepted_response(reqwest::StatusCode::OK, br#"{"ok":false}"#).is_none());
        assert!(parse_accepted_response(reqwest::StatusCode::OK, b"not json").is_none());
        assert!(parse_accepted_response(reqwest::StatusCode::OK, b"{}").is_none());
    }

    #[test]
    fn receipt_only_keeps_a_valid_endpoint_returned_github_issue_url() {
        let invalid_urls = [
            "http://github.com/ship-studio/ship-studio/issues/42",
            "https://github.com.evil.test/ship-studio/ship-studio/issues/42",
            "https://github.com/ship-studio/ship-studio/pull/42",
            "https://github.com/ship-studio/ship-studio/issues/not-a-number",
            "https://attacker@github.com/ship-studio/ship-studio/issues/42",
        ];

        for url in invalid_urls {
            let response = format!(r#"{{"ok":true,"issueUrl":"{url}"}}"#);
            let accepted = parse_accepted_response(reqwest::StatusCode::OK, response.as_bytes())
                .expect("valid acceptance must remain accepted without a URL");
            assert!(
                accepted.issue_url.is_none(),
                "untrusted URL was kept: {url}"
            );
        }

        let accepted = parse_accepted_response(
            reqwest::StatusCode::OK,
            br#"{"ok":true,"issue_url":"https://github.com/ship-studio/ship-studio/issues/42"}"#,
        )
        .unwrap();
        assert_eq!(
            accepted.issue_url.as_deref(),
            Some("https://github.com/ship-studio/ship-studio/issues/42")
        );
    }

    #[test]
    fn confirmed_receipts_are_scrubbed_bounded_and_persisted_separately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RECEIPTS_FILENAME);
        let now = chrono::Utc::now();
        let receipt = make_receipt(
            "frontend-log",
            &format!("failed at /Users/julian/project: {}", "x".repeat(400)),
            None,
            now.clone(),
        );

        assert!(matches!(receipt.kind, AutomaticReportKind::Error));
        assert!(!receipt.summary.contains("julian"));
        assert!(receipt.summary.contains("/Users/<redacted>"));
        assert!(receipt.summary.chars().count() <= MAX_RECEIPT_SUMMARY_CHARS);

        persist_receipt(&path, receipt, now.clone());
        let stored = read_receipts(&path, now.clone());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].source, "frontend-log");
        assert_eq!(
            stored[0].timestamp,
            now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        );

        // The attempted-send throttle remains its own file and is never
        // populated by recording an accepted response.
        assert!(!dir.path().join("bug-report-throttle.json").exists());
    }

    #[test]
    fn receipt_ledger_prunes_old_entries_and_caps_recent_history() {
        let now = chrono::Utc::now();
        let old = make_receipt(
            "panic",
            "old crash",
            None,
            now.clone() - chrono::Duration::seconds(RECEIPT_RETENTION_SECS + 1),
        );
        let mut receipts = vec![old];
        for index in 0..(MAX_REPORT_RECEIPTS + 2) {
            receipts.push(make_receipt(
                "command-error",
                &format!("error {index}"),
                None,
                now.clone() + chrono::Duration::seconds(index as i64),
            ));
        }

        prune_receipts(&mut receipts, now);
        assert_eq!(receipts.len(), MAX_REPORT_RECEIPTS);
        assert!(receipts
            .iter()
            .all(|receipt| receipt.summary != "old crash"));
        assert_eq!(
            receipts[0].summary,
            format!("error {}", MAX_REPORT_RECEIPTS + 1)
        );
    }

    #[test]
    fn panic_receipt_is_classified_as_crash() {
        let receipt = make_receipt("panic", "panic: boom", None, chrono::Utc::now());
        assert!(matches!(receipt.kind, AutomaticReportKind::Crash));
    }

    #[test]
    fn receipt_summary_redacts_credentials_and_account_identifiers() {
        let summary = safe_receipt_summary(
            "Authorization: Bearer bearer-secret API_KEY=api-secret user julian email julian@example.com ghp_github-secret",
        );

        for secret in ["bearer-secret", "api-secret", "julian", "github-secret"] {
            assert!(
                !summary.contains(secret),
                "summary leaked {secret}: {summary}"
            );
        }
        assert!(summary.contains("<redacted>"));

        let json_summary = safe_receipt_summary(r#"{"api_key":"json-secret"}"#);
        assert!(!json_summary.contains("json-secret"));
    }

    #[test]
    fn only_explicit_frontend_crashes_are_classified_as_crashes() {
        let receipt = make_receipt("frontend-crash", "render failed", None, chrono::Utc::now());
        assert!(matches!(receipt.kind, AutomaticReportKind::Crash));

        let receipt = make_receipt("window-error", "uncaught error", None, chrono::Utc::now());
        assert!(matches!(receipt.kind, AutomaticReportKind::Error));
    }

    #[test]
    fn status_serializes_the_frontend_receipt_contract() {
        let receipt = make_receipt(
            "panic",
            "panic: boom",
            Some("https://github.com/ship-studio/ship-studio/issues/42".into()),
            chrono::Utc::now(),
        );
        let status = AutomaticReportStatus {
            enabled: true,
            configured: true,
            reason: None,
            receipts: vec![receipt],
        };

        let serialized = serde_json::to_value(status).unwrap();
        assert_eq!(serialized["enabled"], true);
        assert_eq!(serialized["configured"], true);
        assert!(serialized["reason"].is_null());
        assert_eq!(serialized["receipts"][0]["kind"], "crash");
        assert_eq!(
            serialized["receipts"][0]["issueUrl"],
            "https://github.com/ship-studio/ship-studio/issues/42"
        );
        assert!(serialized["receipts"][0].get("issue_url").is_none());
    }

    // Issue #672: the "not a git repository" telemetry skip must survive
    // git's message localization — match the structural, untranslated parts
    // rather than the English sentence.
    #[test]
    fn not_a_git_repo_skip_is_locale_tolerant() {
        // English (issue #254's original case).
        assert!(is_not_a_git_repo_message(
            "Failed to list branches: fatal: not a git repository (or any of the parent directories): .git\n"
        ));
        // Spanish (the #672 report).
        assert!(is_not_a_git_repo_message(
            "Failed to list branches: fatal: no es un repositorio git (ni ninguno de los directorios superiores): .git\n"
        ));
        // French (space before the colon).
        assert!(is_not_a_git_repo_message(
            "fatal : ce n'est pas un dépôt git (ni aucun des répertoires parents) : .git"
        ));
        // Chinese (full-width colon).
        assert!(is_not_a_git_repo_message(
            "fatal: 不是一个 git 仓库（或者任何父目录）：.git"
        ));
        // Italian (issue #727) — the translation puts the `.git` placeholder
        // first, so the sentence ends with ')' and no tail check can see it.
        assert!(is_not_a_git_repo_message(
            "Failed to list branches: fatal: .git non è un repository Git (né lo è alcuna delle directory genitrici)"
        ));
    }

    #[test]
    fn not_a_git_repo_skip_ignores_other_git_errors() {
        // Remote URLs end in ".git" but not in the ": .git" probe tail —
        // these are real failures that must keep reporting.
        assert!(!is_not_a_git_repo_message(
            "error: failed to push some refs to 'https://github.com/o/r.git'"
        ));
        assert!(!is_not_a_git_repo_message(
            "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"
        ));
        assert!(!is_not_a_git_repo_message(
            "fatal: repository 'https://github.com/o/r.git/' not found"
        ));
        // Paths *inside* .git are a different failure — the token check must
        // not treat ".git/index" as the bare probe marker (issue #727).
        assert!(!is_not_a_git_repo_message(
            "error: unable to write to .git/index"
        ));
        // A macOS TCC / permissions failure quotes the path. Git never quotes
        // the bare probe marker in the not-a-repo sentence, so a quoted '.git'
        // is a genuine access problem — suppressing it hid the real failure.
        assert!(!is_not_a_git_repo_message(
            "fatal: cannot access '.git': Operation not permitted"
        ));
        assert!(!is_not_a_git_repo_message(
            "Failed to list branches: fatal: cannot access '.git': Operation not permitted"
        ));
        assert!(!is_not_a_git_repo_message(""));
    }

    #[test]
    fn dedupe_key_prefers_explicit_fingerprint() {
        assert_eq!(
            dedupe_key(
                "anything at all",
                "publishing",
                Some("publish-staging-io-error")
            ),
            "publish-staging-io-error"
        );
    }

    #[test]
    fn dedupe_key_falls_back_to_source_and_first_line() {
        let key = dedupe_key("boom happened\n    at some_frame:12", "frontend", None);
        assert_eq!(key, "frontend:boom happened");
    }

    #[test]
    fn dedupe_key_truncates_long_messages() {
        let long = "x".repeat(500);
        let key = dedupe_key(&long, "frontend", None);
        assert_eq!(key.len(), "frontend:".len() + 200);
    }

    #[test]
    fn first_occurrence_dedups_within_session() {
        let key = "test-unique-fingerprint-for-dedup";
        assert!(first_occurrence(key));
        assert!(!first_occurrence(key));
    }

    #[test]
    fn command_error_fingerprints_are_stable_slugs() {
        use crate::errors::CommandError as E;
        // Validation is no longer reported at all (user-input feedback, not
        // a malfunction) — no fingerprint.
        assert_eq!(
            command_error_fingerprint(&E::Validation {
                field: "branch".into(),
                reason: "Invalid ref name".into()
            }),
            None
        );
        assert_eq!(
            command_error_fingerprint(&E::Timeout {
                cmd: "git fetch".into(),
                secs: 30
            })
            .as_deref(),
            Some("cmderr-timeout-git fetch")
        );
        // Variable-message variants dedupe on content instead.
        assert!(command_error_fingerprint(&E::Other {
            message: "x".into()
        })
        .is_none());
    }

    #[test]
    fn incident_gap_suppresses_rapid_followups() {
        mark_report_attempted();
        assert!(within_min_gap());
    }

    #[test]
    fn throttle_allows_first_and_blocks_repeat_within_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("throttle.json");
        let now = 1_000_000;
        assert!(passes_persistent_throttle(&path, "fp-a", now, "2026-07-28"));
        // Same key, next session, one hour later: blocked.
        assert!(!passes_persistent_throttle(
            &path,
            "fp-a",
            now + 3_600,
            "2026-07-28"
        ));
        // Different key still allowed.
        assert!(passes_persistent_throttle(
            &path,
            "fp-b",
            now + 3_600,
            "2026-07-28"
        ));
        // Same key after the 24h window: allowed again.
        assert!(passes_persistent_throttle(
            &path,
            "fp-a",
            now + REFRACTORY_SECS + 1,
            "2026-07-29"
        ));
    }

    #[test]
    fn throttle_enforces_daily_cap_and_resets_next_day() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("throttle.json");
        let now = 1_000_000;
        for i in 0..DAILY_CAP {
            assert!(passes_persistent_throttle(
                &path,
                &format!("fp-{i}"),
                now,
                "2026-07-28"
            ));
        }
        assert!(!passes_persistent_throttle(
            &path,
            "fp-over-cap",
            now,
            "2026-07-28"
        ));
        // New day: cap resets.
        assert!(passes_persistent_throttle(
            &path,
            "fp-over-cap",
            now + REFRACTORY_SECS + 1,
            "2026-07-29"
        ));
    }

    #[test]
    fn throttle_fails_open_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("throttle.json");
        std::fs::write(&path, "not json{{{").unwrap();
        assert!(passes_persistent_throttle(
            &path,
            "fp-a",
            1_000_000,
            "2026-07-28"
        ));
    }

    // Issue #684: panic reports must carry a real stack (not just file:line),
    // bounded, and scrubbed like every other payload field.

    #[test]
    fn panic_stack_leads_with_location_and_keeps_short_backtraces_whole() {
        let stack = panic_stack(Some("src/foo.rs:10:5"), "0: frame_a\n1: frame_b");
        assert!(stack.starts_with("src/foo.rs:10:5\n"));
        assert!(stack.contains("frame_b"));
        assert!(!stack.contains("[backtrace truncated]"));
        // No location (panic without one) still yields the backtrace alone.
        assert_eq!(panic_stack(None, "0: frame_a"), "0: frame_a");
    }

    #[test]
    fn panic_stack_truncates_oversized_backtraces_at_the_cap() {
        let huge = "x".repeat(PANIC_BACKTRACE_MAX_CHARS * 3);
        let stack = panic_stack(Some("src/foo.rs:1:1"), &huge);
        assert!(stack.contains("[backtrace truncated]"));
        // location + newline + cap + truncation marker, nothing more.
        assert!(
            stack.len() < PANIC_BACKTRACE_MAX_CHARS + 100,
            "stack len {} exceeds cap headroom",
            stack.len()
        );
    }

    #[test]
    fn panic_stack_is_scrubbed_by_build_body_before_sending() {
        // The backtrace goes out through build_body's stack field — home-dir
        // paths (usernames) must not survive the scrub.
        let stack = panic_stack(
            Some("/Users/julian/ShipStudio/app/src-tauri/src/main.rs:5:9"),
            "0: ship_studio::thing\n   at /Users/julian/ShipStudio/app/src-tauri/src/thing.rs:42",
        );
        let body = build_body("panic: boom", Some(&stack), "panic", None);
        let text = body.to_string();
        assert!(!text.contains("julian"), "username leaked: {text}");
        assert!(text.contains("/Users/<redacted>"), "{text}");
    }

    #[test]
    fn body_scrubs_home_dir_paths() {
        let body = build_body(
            "ENOENT: /Users/julian/ShipStudio/my-app/package.json",
            Some("at load (/Users/julian/ShipStudio/my-app/src/index.ts:1:1)"),
            "frontend",
            None,
        );
        let text = body.to_string();
        assert!(!text.contains("julian"), "username leaked: {text}");
        assert!(text.contains("/Users/<redacted>"));
    }
}
