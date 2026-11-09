//! Every account's plan limits, read without running a turn, so the usage
//! view can say what *each* account has rather than only the one that ran
//! last. Only what an engine said is kept, with when (`quota.rs`'s rule);
//! an account that can't be read this way says so, and its figures arrive
//! with its next turn as before.
//!
//! - **Claude Code** (verified against a Max login on 2.1.319): Claude
//!   Code's own `/usage` reads `GET https://api.anthropic.com/api/oauth/usage`
//!   with the sign-in's OAuth access token. The answer names each window
//!   (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, …) with
//!   `utilization` (0–100) and `resets_at` (RFC 3339), `null` for one that
//!   doesn't apply. It needs the `user:profile` scope: a `claude /login`
//!   sign-in has it, a `claude setup-token` token (how accounts added here
//!   sign in) doesn't, and is refused `403 oauth_scope_insufficient`
//!   (verified). The token is Claude Code's, read where Claude Code keeps it:
//!   the login Keychain item `Claude Code-credentials` (with
//!   `-<first 8 hex of sha256(config dir)>` when `CLAUDE_CONFIG_DIR` is set,
//!   as Claude Code names it), under the user's name, else
//!   `<config dir>/.credentials.json`; for an added account, its own config
//!   folder's, then the setup token kept in this app's Keychain. An access
//!   token past its expiry is not used and **never refreshed** here: a
//!   refresh rotates the refresh token, which would sign Claude Code out. It
//!   is read again once Claude Code (any turn) has refreshed it.
//! - **A setup-token Claude account** (verified against a real setup token):
//!   the usage endpoint refuses it, but a Messages answer on it carries the
//!   plan's unified rate-limit headers: `anthropic-ratelimit-unified-7d-*`
//!   (`utilization` 0–1, `reset` epoch seconds, `status` `allowed` /
//!   `allowed_warning` / `rejected`), and `-5h-*` the same (named as Claude
//!   Code's own `rate_limit_event` names its windows; only `7d` was seen, on
//!   an account at its weekly limit, which answered 429). So such an account
//!   is read with the smallest request there is ([`CLAUDE_PROBE_MODEL`],
//!   `max_tokens` 1, about twenty input tokens), at most every
//!   [`HEADER_RECHECK_MS`], and its check is marked `via: headers`. A 429
//!   carries the headers too and costs nothing. Only the
//!   `anthropic-ratelimit-unified-*` headers are kept; the body is dropped.
//! - **Codex** (protocol verified against 0.166; *not* against a signed-in
//!   account, none here): `codex app-server` with the account's
//!   `CODEX_HOME`, `initialize` then `account/rateLimits/read`, and nothing
//!   else: no thread, no turn. Signed out it answers "codex account
//!   authentication required to read rate limits" (verified).
//!
//! Tokens stay in memory for the one request: never in argv (the Keychain
//! read prints to a pipe), a log, an error string, or anything the phone is
//! sent. Checks run on open and every [`EVERY`] while the app is open, and
//! on demand when someone looks ([`refresh_if_stale`]), one at a time.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::engine::Engine;
use super::quota::{Quota, QuotaWindow};
use super::usage_plan::{self, Check, CheckOutcome, CheckVia};
use super::wallet::{self, Account};

/// How often every account is read while the app is open.
pub const EVERY: Duration = Duration::from_secs(10 * 60);
/// The first check after launch waits this long, so it doesn't add to start-up.
const FIRST_AFTER: Duration = Duration::from_secs(20);
/// A check asked for by someone looking is skipped within this of the last.
const FRESH_FOR: Duration = Duration::from_secs(2 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const CODEX_TIMEOUT: Duration = Duration::from_secs(15);
/// An access token this close to its expiry isn't used.
const EXPIRY_SLACK_MS: i64 = 60_000;
/// A sign-in refused for its scope (a setup token) is asked again this seldom:
/// the answer won't change until it signs in differently.
const SCOPE_RECHECK_MS: i64 = 6 * 60 * 60 * 1000;
/// Why, for a sign-in whose token may not read limits.
pub const NO_SCOPE: &str =
    "Can't read its limits between turns with the token it was added with. They show after a turn runs on it";
/// A setup-token account read from response headers is asked this seldom:
/// each read is a one-token request on the user's plan.
const HEADER_RECHECK_MS: i64 = 30 * 60 * 1000;

pub const CLAUDE_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
/// The cheapest model, for the one-token request a setup token is read with.
pub const CLAUDE_PROBE_MODEL: &str = "claude-haiku-4-5";

pub const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_SERVICE: &str = "Claude Code-credentials";

/// The windows Claude's usage answer is read for (`quota::CLAUDE_WINDOWS`).
const CLAUDE_WINDOWS: &[&str] = &[
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
];

/// What one check said.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Read(Quota),
    /// Read from a one-token request's rate-limit headers (a setup token).
    ReadHeaders(Quota),
    NoPlan,
    CantRead(String),
    Failed(String),
}

/* ------------------------------------------------------------ Claude */

/// A Claude Code sign-in's access token. Never printed.
pub struct ClaudeLogin {
    token: String,
    /// Epoch ms, when the credentials say.
    expires_at: Option<i64>,
    /// `subscriptionType` (`max`, `pro`, …), as Claude Code recorded it.
    plan: Option<String>,
    /// A `claude setup-token` token: the usage endpoint refuses it.
    setup_token: bool,
}

impl std::fmt::Debug for ClaudeLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeLogin")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("plan", &self.plan)
            .field("setup_token", &self.setup_token)
            .finish()
    }
}

/// Claude Code's Keychain service for a config folder, as it names it:
/// plain for its default folder, else suffixed with the first 8 hex of
/// the folder's SHA-256.
pub fn claude_service(config_dir: Option<&Path>) -> String {
    use sha2::{Digest, Sha256};
    match config_dir {
        None => CLAUDE_SERVICE.to_string(),
        Some(dir) => {
            let hash = Sha256::digest(dir.to_string_lossy().as_bytes());
            let hex: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("{CLAUDE_SERVICE}-{hex}")
        }
    }
}

/// The Keychain account Claude Code files its item under: the user's name,
/// when it is a plain one.
fn claude_keychain_account() -> String {
    let user = std::env::var("USER").unwrap_or_default();
    let plain = !user.is_empty()
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if plain {
        user
    } else {
        "claude-code-user".to_string()
    }
}

/// Claude Code's stored credentials (`{"claudeAiOauth": {...}}`), or `None`
/// when they hold no claude.ai sign-in.
pub fn parse_claude_credentials(raw: &str) -> Option<ClaudeLogin> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    let o = v.get("claudeAiOauth")?;
    let token = o
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())?
        .to_string();
    Some(ClaudeLogin {
        token,
        expires_at: o.get("expiresAt").and_then(Value::as_i64),
        plan: o
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string),
        setup_token: false,
    })
}

/// A Keychain item's secret through `security` (Claude Code writes its item
/// with it, so it is trusted to read it back without asking). The value comes
/// back on a pipe; nothing is logged.
async fn security_read(service: &str, account: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new("/usr/bin/security");
    cmd.args(["find-generic-password", "-a", account, "-s", service, "-w"])
        .stdin(std::process::Stdio::null());
    let out = crate::external_command::run_with_timeout(cmd, "security (Claude sign-in)", 10)
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8(out.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Where Claude Code keeps the sign-in for `config_dir` (`None`: its default
/// folder): the Keychain, then the folder's `.credentials.json`.
async fn claude_code_login(config_dir: Option<&Path>, folder: &Path) -> Option<ClaudeLogin> {
    if cfg!(target_os = "macos") {
        let service = claude_service(config_dir);
        if let Some(raw) = security_read(&service, &claude_keychain_account()).await {
            if let Some(login) = parse_claude_credentials(&raw) {
                return Some(login);
            }
        }
    }
    let file = folder.join(".credentials.json");
    let raw = tokio::fs::read_to_string(&file).await.ok()?;
    parse_claude_credentials(&raw)
}

/// The sign-in to read `account` with, or why there is none.
async fn claude_login_for(account: &Account) -> Result<ClaudeLogin, String> {
    let folder = wallet::folder(account);
    if account.is_this_mac() {
        // This Mac's sign-in is Claude Code's own, wherever this app's
        // environment points it.
        let set = std::env::var("CLAUDE_CONFIG_DIR").ok().map(PathBuf::from);
        return claude_code_login(set.as_deref(), &folder)
            .await
            .ok_or_else(|| "Its sign-in isn't one this app can read".to_string());
    }
    // Signed in with `claude /login` in its own folder: that sign-in reads.
    if let Some(login) = claude_code_login(Some(&folder), &folder).await {
        return Ok(login);
    }
    // The setup token it was added with: read from response headers.
    match crate::commands::accounts::claude_token_for(&account.id) {
        Some(token) => Ok(ClaudeLogin {
            token,
            expires_at: None,
            plan: None,
            setup_token: true,
        }),
        None => Err("Not signed in".into()),
    }
}

fn rfc3339_ms(v: Option<&Value>) -> Option<i64> {
    let s = v?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Claude's usage answer as a reading. `None`: it named no window with a figure.
pub fn parse_claude_usage(body: &Value, plan: Option<String>, now: i64) -> Option<Quota> {
    let mut windows: Vec<QuotaWindow> = CLAUDE_WINDOWS
        .iter()
        .filter_map(|kind| {
            let w = body.get(*kind).filter(|w| w.is_object())?;
            let used = w.get("utilization").and_then(Value::as_f64)?;
            Some(QuotaWindow {
                kind: kind.to_string(),
                used_percent: Some(used.clamp(0.0, 100.0)),
                resets_at: rfc3339_ms(w.get("resets_at")),
                window_minutes: None,
                limited: used >= 100.0,
                observed_at: now,
            })
        })
        .collect();
    windows.sort_by(|a, b| a.kind.cmp(&b.kind));
    (!windows.is_empty()).then_some(Quota {
        engine: Engine::Claude,
        windows,
        plan,
    })
}

/// What an answer from the usage endpoint means.
pub fn claude_answer(status: u16, body: &str, plan: Option<String>, now: i64) -> Answer {
    match status {
        200 => match serde_json::from_str::<Value>(body) {
            Ok(v) => parse_claude_usage(&v, plan, now).map_or(Answer::NoPlan, Answer::Read),
            Err(_) => Answer::Failed("Claude's answer wasn't readable".into()),
        },
        401 => Answer::CantRead("Its sign-in has expired; it reads again after a turn".into()),
        403 if body.contains("scope") => Answer::CantRead(NO_SCOPE.into()),
        403 => Answer::CantRead("Claude refused to say".into()),
        429 => Answer::Failed("Claude asked to wait".into()),
        s => Answer::Failed(format!("Claude answered {s}")),
    }
}

/// One reading from the unified rate-limit headers of a Messages answer
/// (lower-cased names, `anthropic-ratelimit-unified-*` only). `None`: they
/// named no window with a figure.
pub fn parse_claude_headers(headers: &[(String, String)], now: i64) -> Option<Quota> {
    let get = |name: String| {
        headers
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.trim())
    };
    let mut windows: Vec<QuotaWindow> = [("5h", "five_hour"), ("7d", "seven_day")]
        .iter()
        .filter_map(|(short, kind)| {
            let at = |field: &str| get(format!("anthropic-ratelimit-unified-{short}-{field}"));
            let used = at("utilization")?.parse::<f64>().ok()?;
            Some(QuotaWindow {
                kind: kind.to_string(),
                used_percent: Some((used * 100.0).clamp(0.0, 100.0)),
                resets_at: at("reset")
                    .and_then(|r| r.parse::<i64>().ok())
                    .map(|s| s * 1000),
                window_minutes: None,
                limited: at("status") == Some("rejected"),
                observed_at: now,
            })
        })
        .collect();
    windows.sort_by(|a, b| a.kind.cmp(&b.kind));
    (!windows.is_empty()).then_some(Quota {
        engine: Engine::Claude,
        windows,
        plan: None,
    })
}

/// What a one-token request's answer means for a setup-token account.
pub fn claude_headers_answer(status: u16, headers: &[(String, String)], now: i64) -> Answer {
    if let Some(q) = parse_claude_headers(headers, now) {
        return Answer::ReadHeaders(q);
    }
    match status {
        401 => {
            Answer::CantRead("Its sign-in has expired. Sign it in again to see its limits".into())
        }
        403 => Answer::CantRead(NO_SCOPE.into()),
        429 => Answer::Failed("Claude asked to wait".into()),
        s => Answer::Failed(format!("Claude answered {s}")),
    }
}

/// The smallest Messages request there is, for its rate-limit headers only:
/// the cheapest model, one output token. The body is dropped unread.
pub async fn claude_probe(url: &str, token: &str) -> Result<(u16, Vec<(String, String)>), String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "couldn't start a request".to_string())?;
    let body = json!({
        "model": CLAUDE_PROBE_MODEL,
        "max_tokens": 1,
        // What Claude Code says first; a subscription token is Claude Code's.
        "system": "You are Claude Code, Anthropic's official CLI for Claude.",
        "messages": [{ "role": "user", "content": "hi" }],
    });
    let res = client
        .post(url)
        .bearer_auth(token)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(
            "User-Agent",
            format!("{}/{}", crate::brand::SLUG, env!("CARGO_PKG_VERSION")),
        )
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Claude didn't answer in time".to_string()
            } else {
                "Couldn't reach Claude".to_string()
            }
        })?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            let k = k.as_str().to_ascii_lowercase();
            if !k.starts_with("anthropic-ratelimit-unified-") {
                return None;
            }
            Some((k, v.to_str().ok()?.to_string()))
        })
        .collect();
    Ok((status, headers))
}

/// One GET of the usage endpoint at `url` with `token`. The token is a
/// header, and no redirect is followed (it would carry the header along).
pub async fn claude_get(url: &str, token: &str) -> Result<(u16, String), String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "couldn't start a request".to_string())?;
    let res = client
        .get(url)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(
            "User-Agent",
            format!("{}/{}", crate::brand::SLUG, env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        // Never the error's own text: it can carry the request.
        .map_err(|e| {
            if e.is_timeout() {
                "Claude didn't answer in time".to_string()
            } else {
                "Couldn't reach Claude".to_string()
            }
        })?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    Ok((status, body))
}

pub async fn read_claude(account: &Account, url: &str, now: i64) -> Answer {
    let login = match claude_login_for(account).await {
        Ok(l) => l,
        Err(why) => return Answer::CantRead(why),
    };
    if login.expires_at.is_some_and(|e| e - EXPIRY_SLACK_MS <= now) {
        return Answer::CantRead(
            "Its sign-in needs refreshing by Claude Code; it reads again after a turn".into(),
        );
    }
    if login.setup_token {
        return match claude_probe(CLAUDE_MESSAGES_URL, &login.token).await {
            Ok((status, headers)) => claude_headers_answer(status, &headers, now),
            Err(why) => Answer::Failed(why),
        };
    }
    match claude_get(url, &login.token).await {
        Ok((status, body)) => claude_answer(status, &body, login.plan, now),
        Err(why) => Answer::Failed(why),
    }
}

/* ------------------------------------------------------------- Codex */

const CODEX_READ_ID: u64 = 2;

/// The lines written to `codex app-server`: the handshake and the read.
pub fn codex_requests() -> Vec<Value> {
    vec![
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "clientInfo": { "name": crate::brand::SLUG, "title": crate::brand::NAME, "version": env!("CARGO_PKG_VERSION") },
            "capabilities": null,
        }}),
        json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": CODEX_READ_ID, "method": "account/rateLimits/read",
            "params": { "excludeResetCreditDetails": true } }),
    ]
}

/// One line from the app-server: the answer, once it's the read's (or the
/// handshake failed). `None`: keep reading.
pub fn codex_answer(line: &str, now: i64) -> Option<Answer> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let id = v.get("id").and_then(Value::as_u64)?;
    if v.get("method").is_some() {
        return None; // a request from the server, not an answer
    }
    let error = v.pointer("/error/message").and_then(Value::as_str);
    match (id, error) {
        (1, Some(_)) => Some(Answer::Failed("Codex didn't start".into())),
        (CODEX_READ_ID, Some(m)) if m.to_lowercase().contains("authentication") => {
            Some(Answer::CantRead("Not signed in".into()))
        }
        (CODEX_READ_ID, Some(_)) => Some(Answer::Failed("This Codex can't say".into())),
        (CODEX_READ_ID, None) => Some(
            super::quota::from_codex(&v["result"]["rateLimits"], now)
                .map_or(Answer::NoPlan, Answer::Read),
        ),
        _ => None,
    }
}

/// Ask `binary`'s app-server, as `account`, for its rate limits.
pub async fn read_codex(binary: &Path, account: &Account, now: i64) -> Answer {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("app-server")
        .env("PATH", crate::utils::get_extended_path())
        .envs(wallet::env_for(account))
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = cmd.spawn() else {
        return Answer::Failed("Codex didn't start".into());
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Answer::Failed("Codex didn't start".into());
    };
    let talk = async {
        for line in codex_requests() {
            let mut text = line.to_string();
            text.push('\n');
            if stdin.write_all(text.as_bytes()).await.is_err() {
                return Answer::Failed("Codex closed".into());
            }
        }
        let _ = stdin.flush().await;
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(answer) = codex_answer(&line, now) {
                return answer;
            }
        }
        Answer::Failed("Codex closed without saying".into())
    };
    let answer = tokio::time::timeout(CODEX_TIMEOUT, talk)
        .await
        .unwrap_or_else(|_| Answer::Failed("Codex didn't answer in time".into()));
    let _ = child.kill().await;
    answer
}

/* ---------------------------------------------------------- recording */

/// Keep what a check said about `account`. True when what's shown changed.
pub fn record(account: &Account, answer: Answer, of_engine: usize, now: i64) -> bool {
    let engine = account.engine;
    let (outcome, why, via) = match &answer {
        Answer::Read(_) => (CheckOutcome::Read, None, None),
        Answer::ReadHeaders(_) => (CheckOutcome::Read, None, Some(CheckVia::Headers)),
        Answer::NoPlan => (CheckOutcome::NoPlan, None, None),
        Answer::CantRead(w) => (CheckOutcome::CantRead, Some(w.clone()), None),
        Answer::Failed(w) => (CheckOutcome::Failed, Some(w.clone()), None),
    };
    let mut changed = usage_plan::set_check(
        engine,
        &account.id,
        Check {
            at: now,
            outcome,
            why,
            via,
        },
    );
    if let Answer::Read(reading) | Answer::ReadHeaders(reading) = answer {
        if let Some(at) = super::quota::limited_until(std::slice::from_ref(&reading), engine, now) {
            wallet::reported_out(engine, &account.id, at, now);
        }
        // The account's own reading, and a sample its pace learns from.
        usage_plan::archive(&account.id, &reading, now);
        // The engine-wide picture (the sidebar foot) is this account's: keep it fresh too.
        let from = wallet::reading_from(engine);
        let ours = match &from {
            Some(id) => *id == account.id,
            None => of_engine == 1,
        };
        if ours {
            if from.is_none() {
                wallet::reading_moves_to(engine, &account.id);
            }
            super::quota::record(reading, now);
        }
        changed = true;
    }
    changed
}

/* ---------------------------------------------------------- the loop */

static RUNNING: AtomicBool = AtomicBool::new(false);
static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Whether to leave an account unasked this time: its sign-in was refused
/// for its scope not long ago (asking again would get the same refusal), or
/// it was read from response headers not long ago (each read costs a token).
pub fn skip(last: Option<&Check>, now: i64) -> bool {
    last.is_some_and(|c| {
        let refused = c.outcome == CheckOutcome::CantRead
            && c.why.as_deref() == Some(NO_SCOPE)
            && now - c.at < SCOPE_RECHECK_MS;
        let by_headers = c.outcome == CheckOutcome::Read
            && c.via == Some(CheckVia::Headers)
            && now - c.at < HEADER_RECHECK_MS;
        refused || by_headers
    })
}

/// Read every signed-in account of every installed engine, one at a time.
/// True when anything shown changed. A check already running is not doubled.
pub async fn check_all() -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
    let checks = tokio::task::spawn_blocking(usage_plan::checks)
        .await
        .unwrap_or_default();
    let mut changed = false;
    for engine in Engine::ALL {
        let Some(binary) = super::engine::binary(engine).await else {
            continue;
        };
        let candidates = wallet::candidates(engine).await;
        let of_engine = candidates.len();
        for c in candidates {
            let now = super::store::now_ms();
            let key = usage_plan::account_key(engine, &c.account.id);
            if c.signed_in && skip(checks.get(&key), now) {
                continue;
            }
            let answer = if !c.signed_in {
                Answer::CantRead("Not signed in".into())
            } else {
                match engine {
                    Engine::Claude => read_claude(&c.account, CLAUDE_USAGE_URL, now).await,
                    Engine::Codex => read_codex(&binary, &c.account, now).await,
                }
            };
            if let Answer::Failed(why) | Answer::CantRead(why) = &answer {
                tracing::debug!(engine = engine.label(), why, "[Agents] usage not read");
            }
            let account = c.account.clone();
            changed |=
                tokio::task::spawn_blocking(move || record(&account, answer, of_engine, now))
                    .await
                    .unwrap_or(false);
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
    changed
}

async fn check_and_tell(app: &AppHandle) {
    if check_all().await {
        let _ = app.emit(super::runner::EVENT_QUOTA, ());
    }
}

/// Someone is looking (the usage popover, Settings, the phone, an agent's
/// `usage_overview`): read again unless a check ran in the last two minutes.
pub async fn refresh_if_stale(app: &AppHandle) {
    let stale = LAST
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_none_or(|at| at.elapsed() >= FRESH_FOR);
    if stale {
        check_and_tell(app).await;
    }
}

/// On open and every [`EVERY`] while the app is open (twice that on
/// battery, `power::Poll::UsageRead`). Someone looking still gets a fresh
/// read at once ([`refresh_if_stale`]).
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_AFTER).await;
        loop {
            check_and_tell(&app).await;
            tokio::time::sleep(crate::power::every(crate::power::Poll::UsageRead)).await;
        }
    });
}

#[cfg(test)]
#[path = "usage_read_tests.rs"]
mod tests;
