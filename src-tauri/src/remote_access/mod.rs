//! # Remote access
//!
//! Lets a chat assistant on the user's phone (Grok Bot first; anything that
//! speaks MCP) drive the app running on their own Mac: read what an
//! agent tab is showing, answer it, start a new agent, look at the preview,
//! and — with a confirmation step — push.
//!
//! The shape, and why:
//!
//! - **An MCP server, not SSH.** The work keeps happening in the same agent
//!   tabs the user left, so when they sit back down the conversation is right
//!   there. A shell would start a second, parallel session instead.
//! - **The user's own tunnel.** Tailscale Funnel on their own account
//!   publishes the server. Nothing passes through infrastructure we run, so
//!   there is nothing of ours to breach and nothing for us to be liable for.
//! - **A narrow surface.** Only opted-in projects are visible. Text goes only
//!   to agent tabs, never to plain shell tabs. A push takes two calls with a
//!   summary between them, bound to the exact commit and changes summarised.
//! - **The machine has to be on.** Most of this module and its UI exist to
//!   make that true for as long as possible and to say plainly when it isn't.
//!
//! Full design: `docs/remote-access.md`.

pub(crate) mod agent_state;
mod deploy;
pub mod power;
pub mod screen;
pub(crate) mod server;
pub mod shots;
pub mod tailscale;
pub(crate) mod tools;

use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};

pub use server::{is_running, running_port, start_server, stop_server};

// ============================================================================
// Persisted settings
// ============================================================================

/// What the user chose, in its own owner-only file next to app_state.json —
/// same reasoning as the agent bridge's identity file: app_state.json is
/// read-modify-written by many writers. The connector token itself lives in
/// the login Keychain ([`token_store`]); the file carries it only while the
/// Keychain refuses it, and an older file's copy is moved over on first read.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RemoteConfig {
    pub enabled: bool,
    /// Filled from the Keychain on read; written to the file only as the
    /// fallback when the Keychain refused it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub token: String,
    pub port: Option<u16>,
    /// Project paths the remote may see, exactly as the dashboard knows them.
    pub projects: Vec<String>,
    /// An authenticated client has reached the server at least once with the
    /// current link. This — not "the link exists" — is what finishes setup,
    /// so it survives restarts and is cleared when the link is replaced.
    pub ever_connected: bool,
    /// Salted, stretched hash of the push PIN. `None` = remote pushing off.
    pub push_pin_hash: Option<String>,
    pub push_pin_salt: Option<String>,
    /// Wrong PINs in a row. At [`PUSH_MAX_FAILURES`] pushing locks.
    pub push_failures: u8,
    /// Lid-closed mode was switched on from Remote access, so turning remote
    /// access off should switch it back. Never set when the user had it on
    /// already — we only undo what we did.
    pub lid_mode_by_us: bool,
}

static CONFIG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn config_path() -> Option<std::path::PathBuf> {
    crate::commands::setup::get_app_state_path()
        .parent()
        .map(|dir| dir.join("remote_access.json"))
}

fn lock_config() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn read_config() -> RemoteConfig {
    let _guard = lock_config();
    match config_path() {
        Some(path) => load_config(&path, token_store::app()),
        None => RemoteConfig::default(),
    }
}

/// The file at `path`, with the token from `store`. Holding [`CONFIG_LOCK`].
///
/// An older file carries the token itself: it is copied into `store`, read
/// back, and only once it reads back the same is the file rewritten without
/// it. If the Keychain refuses (locked, denied), the file's copy keeps
/// working and the move is tried again next read.
fn load_config(path: &std::path::Path, store: &dyn token_store::Store) -> RemoteConfig {
    let mut config: RemoteConfig = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let in_file = std::mem::take(&mut config.token);
    match store.load() {
        Ok(Some(kept)) if in_file.is_empty() || in_file == kept => {
            config.token = kept;
            if !in_file.is_empty() {
                // Already moved: the file's copy goes.
                if let Err(e) = write_file(path, &config, false) {
                    tracing::warn!(error = %e, "[Remote] Could not drop the token from the settings file");
                }
            }
        }
        Ok(None) if in_file.is_empty() => {}
        // The file holds a token only when the Keychain refused it, so one
        // that differs from the Keychain's is the newer link: it moves too.
        Ok(_) => {
            config.token = in_file;
            if token_store::save_verified(store, &config.token) {
                tracing::info!("[Remote] Moved the connector token into the Keychain");
                if let Err(e) = write_file(path, &config, false) {
                    tracing::warn!(error = %e, "[Remote] Could not drop the token from the settings file");
                }
            }
        }
        // The Keychain didn't answer: never mistake that for "no token" (a
        // new one would break the link the assistant holds).
        Err(e) => {
            tracing::warn!(error = %e, "[Remote] Keychain didn't answer; using the settings file's token");
            config.token = in_file;
        }
    }
    config
}

fn write_config(config: &RemoteConfig) -> Result<(), CommandError> {
    let path = config_path().ok_or_else(|| CommandError::expected("No home folder."))?;
    store_config(&path, config, token_store::app())
}

/// Write `config`: the token into `store` (unless it is already there), the
/// rest into the file. A token the Keychain refused stays in the file, as
/// before, so the link keeps working.
fn store_config(
    path: &std::path::Path,
    config: &RemoteConfig,
    store: &dyn token_store::Store,
) -> Result<(), CommandError> {
    let in_keychain = config.token.is_empty()
        || store.load().ok().flatten().as_deref() == Some(config.token.as_str())
        || token_store::save_verified(store, &config.token);
    if !in_keychain {
        tracing::warn!(
            "[Remote] Keychain refused the connector token; keeping it in the settings file"
        );
    }
    write_file(path, config, !in_keychain)
}

/// The settings file, with the token only when `with_token`.
fn write_file(
    path: &std::path::Path,
    config: &RemoteConfig,
    with_token: bool,
) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut on_disk = config.clone();
    if !with_token {
        on_disk.token.clear();
    }
    let json = serde_json::to_string_pretty(&on_disk)
        .map_err(|e| CommandError::from(format!("serialize remote config: {e}")))?;
    write_private(path, json.as_bytes())?;
    Ok(())
}

/// Where the connector token lives: one generic-password item in the login
/// Keychain (`crate::keychain`, the same path as every other secret here),
/// kept in memory after the first read since the server checks it on every
/// request. Tests never reach the real Keychain.
pub(crate) mod token_store {
    use std::sync::Mutex;

    /// `Ok(None)` only when there is definitely no token.
    pub trait Store: Send + Sync {
        fn load(&self) -> Result<Option<String>, String>;
        fn save(&self, token: &str) -> Result<(), String>;
    }

    /// Save, then read back: only a token that reads back the same counts as
    /// kept (the old file's copy is deleted on that alone).
    pub fn save_verified(store: &dyn Store, token: &str) -> bool {
        store.save(token).is_ok() && store.load().ok().flatten().as_deref() == Some(token)
    }

    /// The app's own item, through a cache.
    pub fn app() -> &'static dyn Store {
        &CACHED
    }

    struct Cached;
    static CACHED: Cached = Cached;
    static CACHE: Mutex<Option<String>> = Mutex::new(None);

    impl Store for Cached {
        fn load(&self) -> Result<Option<String>, String> {
            let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = cache.as_ref() {
                return Ok(Some(t.clone()));
            }
            let found = backend::load()?;
            cache.clone_from(&found);
            Ok(found)
        }

        fn save(&self, token: &str) -> Result<(), String> {
            let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            *cache = None;
            backend::save(token)?;
            *cache = Some(token.to_string());
            Ok(())
        }
    }

    #[cfg(not(test))]
    mod backend {
        fn item() -> crate::companion::keystore::Keychain {
            crate::companion::keystore::Keychain::named(
                format!("{}token", crate::brand::keychain_prefix("remote-access")),
                "connector-token".into(),
            )
        }
        pub fn load() -> Result<Option<String>, String> {
            use crate::companion::keystore::KeyStore;
            item().load()
        }
        pub fn save(token: &str) -> Result<(), String> {
            use crate::companion::keystore::KeyStore;
            item().save(token)
        }
    }

    #[cfg(test)]
    mod backend {
        use std::sync::Mutex;
        static ITEM: Mutex<Option<String>> = Mutex::new(None);
        pub fn load() -> Result<Option<String>, String> {
            Ok(ITEM.lock().unwrap().clone())
        }
        pub fn save(token: &str) -> Result<(), String> {
            *ITEM.lock().unwrap() = Some(token.to_string());
            Ok(())
        }
    }

    /// In memory, for tests: a token, and switches to make it fail.
    #[cfg(test)]
    #[derive(Default)]
    pub struct Memory {
        pub token: Mutex<Option<String>>,
        pub fail_load: std::sync::atomic::AtomicBool,
        pub fail_save: std::sync::atomic::AtomicBool,
    }

    #[cfg(test)]
    impl Store for Memory {
        fn load(&self) -> Result<Option<String>, String> {
            use std::sync::atomic::Ordering;
            if self.fail_load.load(Ordering::SeqCst) {
                return Err("locked".into());
            }
            Ok(self.token.lock().unwrap().clone())
        }
        fn save(&self, token: &str) -> Result<(), String> {
            use std::sync::atomic::Ordering;
            if self.fail_save.load(Ordering::SeqCst) {
                return Err("refused".into());
            }
            *self.token.lock().unwrap() = Some(token.to_string());
            Ok(())
        }
    }
}

/// Write a file only its owner can read. Created 0600 rather than chmod-ed
/// after, so the token is never briefly world-readable.
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// Read-modify-write the config under one lock.
pub fn update_config<T>(f: impl FnOnce(&mut RemoteConfig) -> T) -> Result<T, CommandError> {
    let _guard = lock_config();
    let path = config_path().ok_or_else(|| CommandError::expected("No home folder."))?;
    let mut config = load_config(&path, token_store::app());
    let out = f(&mut config);
    write_config(&config)?;
    Ok(out)
}

/// 256 bits from the OS RNG, hex.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    // The OS CSPRNG. If it's unavailable there's no safe token to mint, and
    // a predictable one would be worse than refusing to start.
    getrandom::getrandom(&mut bytes).expect("the OS random number generator is unavailable");
    hex::encode(bytes)
}

/// The token, minting one on first use.
pub fn ensure_token() -> Result<String, CommandError> {
    update_config(|c| {
        if c.token.len() < 32 {
            c.token = new_token();
        }
        c.token.clone()
    })
}

/// Is `project_path` one the user opted in?
pub fn project_allowed(config: &RemoteConfig, project_path: &str) -> bool {
    config.projects.iter().any(|p| p == project_path)
}

// ============================================================================
// Activity — what the user sees as proof the connector actually works
// ============================================================================

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Unix ms of the last authenticated request.
    pub last_request_ms: Option<u64>,
    /// `clientInfo.name` from the last `initialize`, as the client reported it.
    pub last_client: Option<String>,
    /// Requests that reached the server without a valid token, this run.
    pub rejected_requests: u64,
}

static ACTIVITY: LazyLock<Mutex<Activity>> = LazyLock::new(|| Mutex::new(Activity::default()));

pub fn activity() -> Activity {
    ACTIVITY.lock().map(|a| a.clone()).unwrap_or_default()
}

pub(crate) fn record_request(client: Option<String>) {
    if let Ok(mut a) = ACTIVITY.lock() {
        a.last_request_ms = Some(now_ms());
        if client.is_some() {
            a.last_client = client;
        }
    }
    // Written once per link, not per request.
    if !read_config().ever_connected {
        if let Err(e) = update_config(|c| c.ever_connected = true) {
            tracing::warn!("[Remote] Could not record the first connection: {}", e);
        }
    }
}

pub(crate) fn record_rejected() {
    if let Ok(mut a) = ACTIVITY.lock() {
        a.rejected_requests += 1;
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================================
// Audit log — what the remote did, for the person who comes back to it
// ============================================================================

/// One remote action. Written for a person reading it later: which tool,
/// which project, a short preview of what was typed, and whether it worked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at_ms: u64,
    pub tool: String,
    pub project: Option<String>,
    pub detail: String,
    pub ok: bool,
    /// Who acted, when it wasn't the remote assistant: one of this app's
    /// own agents, by name (`agents/sessions.rs`). Absent for remote access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
}

/// Keep each log to a size anyone would read: past this the file is
/// rotated to `<name>.1` (replacing the older one) and a new one started,
/// so the last two files are always there and nothing in the newer one is
/// ever cut. A flood of junk can still push old lines out, but only after
/// a whole file of it, and the phone's failed connections are folded to a
/// line a minute (`companion::limits::RefusalLog`) so they can't.
const AUDIT_MAX_BYTES: u64 = 1024 * 1024;
const AUDIT_PREVIEW_CHARS: usize = 140;

fn audit_path() -> Option<std::path::PathBuf> {
    config_path().map(|p| p.with_file_name("remote_audit.jsonl"))
}

/// The phone companion's own log: kept apart from Remote Access's, so
/// neither can roll the other's record out.
fn companion_audit_path() -> Option<std::path::PathBuf> {
    config_path().map(|p| p.with_file_name("companion_audit.jsonl"))
}

/// `<file>.1`: the rotated, older half of a log.
fn rotated(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// A log's lines, oldest first, across its rotated file and the current one.
fn read_log(path: &std::path::Path) -> String {
    let old = std::fs::read_to_string(rotated(path)).unwrap_or_default();
    let new = std::fs::read_to_string(path).unwrap_or_default();
    if old.is_empty() {
        new
    } else {
        old + &new
    }
}

/// Append one line, rotating first when the file is past `max` bytes.
fn append_rotating(path: &std::path::Path, line: &str, max: u64) -> std::io::Result<()> {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() > max) {
        std::fs::rename(path, rotated(path))?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(line.as_bytes())
}

static AUDIT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// A one-line preview of user-supplied text for the log.
pub(crate) fn preview(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= AUDIT_PREVIEW_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(AUDIT_PREVIEW_CHARS).collect();
    format!("{cut}…")
}

pub(crate) fn audit(tool: &str, project: Option<&str>, detail: String, ok: bool) {
    audit_as(None, tool, project, detail, ok);
}

/// [`audit`], naming who acted. The same log and the same rules.
pub(crate) fn audit_as(
    actor: Option<&str>,
    tool: &str,
    project: Option<&str>,
    detail: String,
    ok: bool,
) {
    if let Some(path) = audit_path() {
        write_entry(&path, actor, tool, project, detail, ok);
    }
}

/// What a paired phone did (`companion`), in the companion's own log.
pub(crate) fn companion_audit(actor: &str, tool: &str, detail: String, ok: bool) {
    if let Some(path) = companion_audit_path() {
        write_entry(&path, Some(actor), tool, None, detail, ok);
    }
}

fn write_entry(
    path: &std::path::Path,
    actor: Option<&str>,
    tool: &str,
    project: Option<&str>,
    detail: String,
    ok: bool,
) {
    let entry = AuditEntry {
        at_ms: now_ms(),
        tool: tool.to_string(),
        project: project.map(str::to_string),
        // An agent's secret is never written down, here either.
        detail: crate::agents::secrets::redact(&detail).into_owned(),
        ok,
        actor: actor.map(str::to_string),
    };
    let Ok(_guard) = AUDIT_LOCK.lock() else {
        return;
    };
    let Ok(mut line) = serde_json::to_string(&entry) else {
        return;
    };
    line.push('\n');
    if let Err(e) = append_rotating(path, &line, AUDIT_MAX_BYTES) {
        tracing::warn!("[Remote] Could not write the audit log: {}", e);
    }
}

/// The newest `limit` remote-access entries, newest first. What Ship
/// Studio's own agents did is in the same file, but isn't remote activity.
pub fn read_audit(limit: usize) -> Vec<AuditEntry> {
    let Some(raw) = audit_path().map(|p| read_log(&p)) else {
        return Vec::new();
    };
    raw.lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .filter(|e| e.actor.is_none())
        .take(limit)
        .collect()
}

/// The newest entry for each of `actors`, from the companion's log, for the
/// Phone panel's "last activity". `skip` names tools that are presence or
/// pairing rather than something the phone did.
pub fn latest_by_actor(
    actors: &[String],
    skip: &[&str],
) -> std::collections::HashMap<String, AuditEntry> {
    let mut found = std::collections::HashMap::new();
    let Some(raw) = companion_audit_path().map(|p| read_log(&p)) else {
        return found;
    };
    latest_in(&raw, actors, skip, &mut found);
    found
}

fn latest_in(
    raw: &str,
    actors: &[String],
    skip: &[&str],
    found: &mut std::collections::HashMap<String, AuditEntry>,
) {
    for entry in raw
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
    {
        if found.len() == actors.len() {
            break;
        }
        let Some(actor) = entry.actor.clone() else {
            continue;
        };
        if actors.contains(&actor) && !skip.contains(&entry.tool.as_str()) {
            found.entry(actor).or_insert(entry);
        }
    }
}

#[cfg(test)]
mod latest_tests {
    use super::*;

    #[test]
    fn a_full_log_rotates_instead_of_losing_its_newer_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jsonl");
        for i in 0..100 {
            append_rotating(&path, &format!("line {i}\n"), 200).unwrap();
        }
        let all = read_log(&path);
        let lines: Vec<&str> = all.lines().collect();
        assert_eq!(lines.last(), Some(&"line 99"), "the newest is always kept");
        // Two files at most, each a little over the cap.
        assert!(rotated(&path).exists());
        assert!(!dir.path().join("a.jsonl.1.1").exists());
        assert!(
            lines.len() > 20,
            "a whole file's worth survives the rotation"
        );
        // Every line that survives is in order, with none cut in half.
        let nums: Vec<u32> = lines
            .iter()
            .map(|l| l.strip_prefix("line ").unwrap().parse().unwrap())
            .collect();
        assert!(nums.windows(2).all(|w| w[1] == w[0] + 1));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn the_newest_real_action_per_actor() {
        let line = |at: u64, actor: &str, tool: &str| {
            serde_json::to_string(&AuditEntry {
                at_ms: at,
                tool: tool.into(),
                project: None,
                detail: String::new(),
                ok: true,
                actor: Some(actor.into()),
            })
            .unwrap()
        };
        let raw = [
            line(1, "Phone · A", "agents.send"),
            line(2, "Phone · B", "agents.stop"),
            line(3, "Phone · A", "agents.answerApproval"),
            line(4, "Phone · A", "connected"),
        ]
        .join("\n");
        let mut found = std::collections::HashMap::new();
        let actors = vec!["Phone · A".to_string(), "Phone · B".to_string()];
        latest_in(&raw, &actors, &["connected"], &mut found);
        assert_eq!(found["Phone · A"].tool, "agents.answerApproval");
        assert_eq!(found["Phone · B"].at_ms, 2);
    }
}

// ============================================================================
// Pushing: a PIN only the user knows
// ============================================================================
//
// The remote assistant reads terminal output, and terminal output can contain
// text written by anyone — a web page the agent fetched, a dependency's
// README. If confirming a push needed only something the assistant had seen
// (a code in a tool result), injected text could tell it to confirm. So the
// confirmation is a PIN the user set on this Mac and types into the chat
// themselves. It is never sent to the assistant, stored only as a salted,
// stretched hash, and five wrong tries switch remote pushing off until the
// user sets a new PIN at the computer.

/// How long a push summary stays confirmable.
const PUSH_TTL_MS: u64 = 10 * 60 * 1000;
/// Wrong PINs, in a row, before remote pushing locks.
pub const PUSH_MAX_FAILURES: u8 = 5;
const PIN_STRETCH_ROUNDS: u32 = 200_000;

/// Hash a PIN with its salt. Stretched so that a copy of the config file
/// doesn't give up a short PIN instantly.
pub(crate) fn hash_pin(salt: &str, pin: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::digest(format!("{salt}:{pin}").as_bytes());
    for _ in 0..PIN_STRETCH_ROUNDS {
        let mut h = Sha256::new();
        h.update(salt.as_bytes());
        h.update(digest);
        digest = h.finalize();
    }
    hex::encode(digest)
}

/// 6 to 12 digits, and not something trivially guessable.
pub fn validate_pin(pin: &str) -> Result<(), CommandError> {
    let bad = |reason: &str| CommandError::Validation {
        field: "pin".into(),
        reason: reason.into(),
    };
    if !(6..=12).contains(&pin.len()) || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad("Use 6 to 12 digits."));
    }
    let bytes = pin.as_bytes();
    let all_same = bytes.iter().all(|b| *b == bytes[0]);
    let ascending = bytes.windows(2).all(|w| w[1] == w[0] + 1);
    let descending = bytes.windows(2).all(|w| w[0] == w[1] + 1);
    if all_same || ascending || descending {
        return Err(bad("That PIN is too easy to guess."));
    }
    Ok(())
}

/// Set (or replace) the push PIN. Also clears any lockout.
pub fn set_push_pin(pin: &str) -> Result<(), CommandError> {
    validate_pin(pin)?;
    let salt = new_token();
    let hash = hash_pin(&salt, pin);
    update_config(|c| {
        c.push_pin_salt = Some(salt);
        c.push_pin_hash = Some(hash);
        c.push_failures = 0;
    })?;
    clear_pending_push();
    Ok(())
}

/// Turn remote pushing off entirely.
pub fn clear_push_pin() -> Result<(), CommandError> {
    update_config(|c| {
        c.push_pin_salt = None;
        c.push_pin_hash = None;
        c.push_failures = 0;
    })?;
    clear_pending_push();
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PushPinState {
    /// No PIN: remote pushing is off.
    NotSet,
    Set,
    /// Too many wrong PINs; off until a new PIN is set at the computer.
    Locked,
}

pub fn push_pin_state(config: &RemoteConfig) -> PushPinState {
    match (
        &config.push_pin_hash,
        config.push_failures >= PUSH_MAX_FAILURES,
    ) {
        (None, _) => PushPinState::NotSet,
        (Some(_), true) => PushPinState::Locked,
        (Some(_), false) => PushPinState::Set,
    }
}

/// A push the remote has been shown the summary of. Bound to the exact
/// commit and working-tree state summarised: if either changes before
/// confirmation, the confirmation is refused, so what gets pushed is always
/// what was described.
#[derive(Debug, Clone)]
pub(crate) struct PendingPush {
    pub project_path: String,
    /// The branch the summary named — what gets pushed to, whatever is
    /// checked out by the time the PIN arrives.
    pub branch: String,
    pub head: String,
    /// The git tree the working copy would commit as (see
    /// `tools::frozen_tree`): an exact content hash of everything summarised.
    pub tree_fingerprint: String,
    pub created_ms: u64,
}

static PENDING_PUSH: LazyLock<Mutex<Option<PendingPush>>> = LazyLock::new(|| Mutex::new(None));
/// Serialises PIN checks so parallel guesses can't race the failure counter.
static PIN_CHECK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

pub(crate) fn set_pending_push(push: PendingPush) {
    if let Ok(mut p) = PENDING_PUSH.lock() {
        *p = Some(push);
    }
}

pub(crate) fn clear_pending_push() {
    if let Ok(mut p) = PENDING_PUSH.lock() {
        *p = None;
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PushCheck {
    Ok,
    NoPin,
    Locked,
    NothingPending,
    Expired,
    WrongPin { attempts_left: u8 },
    Changed,
}

/// Everything a confirmation is decided on, with no I/O.
pub(crate) struct PushAttempt<'a> {
    pub project_path: &'a str,
    pub has_pin: bool,
    pub failures: u8,
    pub pending: Option<&'a PendingPush>,
    pub pin_matches: bool,
    pub head: &'a str,
    pub tree_fingerprint: &'a str,
    pub now: u64,
}

/// The rules, in order. A wrong PIN is counted before anything about the
/// pending push is revealed, and a lockout beats everything.
pub(crate) fn decide_push(a: &PushAttempt) -> PushCheck {
    if !a.has_pin {
        return PushCheck::NoPin;
    }
    if a.failures >= PUSH_MAX_FAILURES {
        return PushCheck::Locked;
    }
    let Some(pending) = a.pending.filter(|p| p.project_path == a.project_path) else {
        return PushCheck::NothingPending;
    };
    if a.now.saturating_sub(pending.created_ms) > PUSH_TTL_MS {
        return PushCheck::Expired;
    }
    if !a.pin_matches {
        let failures = a.failures.saturating_add(1);
        return if failures >= PUSH_MAX_FAILURES {
            PushCheck::Locked
        } else {
            PushCheck::WrongPin {
                attempts_left: PUSH_MAX_FAILURES - failures,
            }
        };
    }
    if pending.head != a.head || pending.tree_fingerprint != a.tree_fingerprint {
        return PushCheck::Changed;
    }
    PushCheck::Ok
}

/// Check a confirmation and apply its consequences: count a wrong PIN, reset
/// the count on a right one, and consume the pending push on anything final.
pub(crate) async fn check_push(
    project_path: &str,
    pin: &str,
    head: &str,
    tree_fingerprint: &str,
    now: u64,
) -> (PushCheck, Option<PendingPush>) {
    let _serial = PIN_CHECK.lock().await;
    let config = read_config();
    let pending = PENDING_PUSH.lock().ok().and_then(|p| p.clone());
    let pin_matches = match (&config.push_pin_salt, &config.push_pin_hash) {
        (Some(salt), Some(expected)) => {
            let (salt, pin) = (salt.clone(), pin.trim().to_string());
            let given = tokio::task::spawn_blocking(move || hash_pin(&salt, &pin))
                .await
                .unwrap_or_default();
            server::constant_time_eq(given.as_bytes(), expected.as_bytes())
        }
        _ => false,
    };
    let result = decide_push(&PushAttempt {
        project_path,
        has_pin: config.push_pin_hash.is_some(),
        failures: config.push_failures,
        pending: pending.as_ref(),
        pin_matches,
        head,
        tree_fingerprint,
        now,
    });
    match result {
        PushCheck::WrongPin { .. } | PushCheck::Locked if !pin_matches => {
            let _ = update_config(|c| c.push_failures = c.push_failures.saturating_add(1));
        }
        PushCheck::Ok | PushCheck::Changed if config.push_failures > 0 => {
            let _ = update_config(|c| c.push_failures = 0);
        }
        _ => {}
    }
    if matches!(
        result,
        PushCheck::Ok | PushCheck::Changed | PushCheck::Expired | PushCheck::Locked
    ) {
        clear_pending_push();
    }
    let confirmed = (result == PushCheck::Ok).then_some(pending).flatten();
    (result, confirmed)
}

// ============================================================================
// Lifecycle
// ============================================================================

/// Bring everything up for an enabled config: server, keep-awake, Funnel.
/// Each piece is reported separately by the status command, so a Funnel that
/// needs approval doesn't stop the rest from running.
pub async fn bring_up(app: tauri::AppHandle) -> Result<tailscale::FunnelOutcome, CommandError> {
    ensure_token()?;
    let port = start_server(app).await?;
    power::start_keep_awake()?;
    stop_approval_watch();
    let (outcome, pending) = match tailscale::status().await {
        tailscale::TailscaleState::Connected { .. } => {
            tailscale::remove_previous_mount().await;
            tailscale::enable_funnel_waiting(port).await
        }
        tailscale::TailscaleState::NotInstalled => (
            tailscale::FunnelOutcome::Failed {
                detail: "Tailscale isn't installed.".to_string(),
            },
            None,
        ),
        tailscale::TailscaleState::NeedsLogin => (
            tailscale::FunnelOutcome::Failed {
                detail: "Sign in to Tailscale first.".to_string(),
            },
            None,
        ),
        tailscale::TailscaleState::Unknown { detail } => {
            (tailscale::FunnelOutcome::Failed { detail }, None)
        }
    };
    // Recorded before any watch starts, so a watch that finishes first is
    // never overwritten by this older answer.
    set_last_funnel(Some(outcome.clone()));
    match outcome {
        tailscale::FunnelOutcome::On => start_publish_watch(port),
        tailscale::FunnelOutcome::NeedsApproval { .. } => start_approval_watch(port, pending),
        tailscale::FunnelOutcome::Failed { .. } => {}
    }
    Ok(outcome)
}

/// Take everything down. The Funnel goes first so nothing new arrives while
/// the server stops.
pub async fn tear_down() {
    stop_approval_watch();
    set_last_funnel(None);
    stop_publish_watch();
    shots::clear();
    if tailscale::find_binary().is_some() {
        if let Err(e) = tailscale::disable_funnel().await {
            tracing::warn!("[Remote] Could not remove the Funnel: {}", e);
        }
    }
    stop_server();
    // Still held if the user asked for it apart from remote access, or a phone needs it.
    if !power::keep_awake_asked() && !power::phone_holds_awake() {
        power::stop_keep_awake();
    }
}

// ============================================================================
// Publishing — getting from "Funnel on" to "the internet can reach it"
// ============================================================================
//
// A real first run sat with Funnel on and Tailscale's public DNS holding no
// record for the machine, and the user had nothing to press. So once the
// Funnel is on, a watchdog checks the public path; if the address still isn't
// published after a few minutes it asks Tailscale again (Funnel off and on)
// once, by itself, and it keeps the timeline so the UI can say how long it
// has been and what was tried. The user can also ask again at any time.

/// How long to wait before asking Tailscale again on the user's behalf.
const AUTO_REPUBLISH_AFTER: std::time::Duration = std::time::Duration::from_secs(2 * 60);
/// How long the watchdog keeps checking before leaving it to the user.
const PUBLISH_WATCH_FOR: std::time::Duration = std::time::Duration::from_secs(20 * 60);
const PUBLISH_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishProgress {
    /// When the Funnel was (last) turned on and we started waiting, Unix ms.
    pub since_ms: Option<u64>,
    /// The app already asked Tailscale again by itself.
    pub auto_retried: bool,
    /// The watchdog gave up waiting; it's over to the user.
    pub gave_up: bool,
}

struct PublishWatch {
    progress: PublishProgress,
    generation: u64,
}

static PUBLISH: LazyLock<Mutex<PublishWatch>> = LazyLock::new(|| {
    Mutex::new(PublishWatch {
        progress: PublishProgress::default(),
        generation: 0,
    })
});

pub fn publish_progress() -> PublishProgress {
    PUBLISH
        .lock()
        .map(|p| p.progress.clone())
        .unwrap_or_default()
}

fn stop_publish_watch() {
    if let Ok(mut p) = PUBLISH.lock() {
        p.generation += 1;
        p.progress = PublishProgress::default();
    }
}

/// Start (or restart) waiting for the public address. Each start bumps a
/// generation number, so an older watchdog notices and stops.
fn start_publish_watch(port: u16) {
    let generation = {
        let Ok(mut p) = PUBLISH.lock() else { return };
        p.generation += 1;
        p.progress = PublishProgress {
            since_ms: Some(now_ms()),
            auto_retried: false,
            gave_up: false,
        };
        p.generation
    };
    tailscale::forget_reachability();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        loop {
            tokio::time::sleep(PUBLISH_CHECK_EVERY).await;
            let current = PUBLISH.lock().map(|p| p.generation).unwrap_or(0);
            if current != generation {
                return;
            }
            let tailscale::TailscaleState::Connected { dns_name, .. } = tailscale::status().await
            else {
                continue;
            };
            let token = read_config().token;
            if tailscale::public_reachability(&dns_name, &token).await
                == tailscale::Reachability::Reachable
            {
                if let Ok(mut p) = PUBLISH.lock() {
                    if p.generation == generation {
                        p.progress.since_ms = None;
                    }
                }
                tracing::info!("[Remote] Reachable from the internet");
                return;
            }
            let auto_retried = publish_progress().auto_retried;
            if !auto_retried && started.elapsed() >= AUTO_REPUBLISH_AFTER {
                tracing::warn!("[Remote] Still not published; asking Tailscale again");
                let _ = tailscale::disable_funnel().await;
                let outcome = tailscale::enable_funnel(port).await;
                tailscale::forget_reachability();
                audit(
                    "republish",
                    None,
                    format!("asked Tailscale to publish the address again ({outcome:?})"),
                    outcome == tailscale::FunnelOutcome::On,
                );
                if let Ok(mut p) = PUBLISH.lock() {
                    if p.generation == generation {
                        p.progress.auto_retried = true;
                    }
                }
            }
            if started.elapsed() >= PUBLISH_WATCH_FOR {
                if let Ok(mut p) = PUBLISH.lock() {
                    if p.generation == generation {
                        p.progress.gave_up = true;
                    }
                }
                return;
            }
        }
    });
}

/// Ask Tailscale to publish the address again: Funnel off, Funnel on, and
/// start waiting afresh. What "Ask Tailscale again" does.
pub async fn republish() -> Result<tailscale::FunnelOutcome, CommandError> {
    let port =
        running_port().ok_or_else(|| CommandError::expected("Remote access isn't running."))?;
    stop_approval_watch();
    let _ = tailscale::disable_funnel().await;
    let (outcome, pending) = tailscale::enable_funnel_waiting(port).await;
    set_last_funnel(Some(outcome.clone()));
    match outcome {
        tailscale::FunnelOutcome::On => start_publish_watch(port),
        tailscale::FunnelOutcome::NeedsApproval { .. } => start_approval_watch(port, pending),
        tailscale::FunnelOutcome::Failed { .. } => {}
    }
    audit(
        "republish",
        None,
        "asked Tailscale to publish the address again".into(),
        outcome == tailscale::FunnelOutcome::On,
    );
    Ok(outcome)
}

// ============================================================================
// Approval — Tailscale's one-time "Allow" page, finished without the user
// coming back to press anything
// ============================================================================
//
// The first time, Tailscale wants the tailnet's owner to approve HTTPS
// certificates and Funnel (one page: approving it creates the certificates
// and adds the `funnel` node attribute to the policy file, per Tailscale's
// Funnel docs). The CLI prints that page's link and waits. We used to kill
// it there, so after approving, the user had to come back and press Check
// again. Now the waiting CLI is kept: the moment they approve, it finishes,
// and the publish watch takes over. If Tailscale's CLI didn't wait, it is
// asked again every few seconds until it says yes.

/// The last Funnel attempt's result, so a "needs approval" link survives the
/// status being re-read. Cleared whenever the Funnel is confirmed on.
static LAST_FUNNEL: LazyLock<Mutex<Option<tailscale::FunnelOutcome>>> =
    LazyLock::new(|| Mutex::new(None));

pub fn last_funnel() -> Option<tailscale::FunnelOutcome> {
    LAST_FUNNEL.lock().ok().and_then(|l| l.clone())
}

pub fn set_last_funnel(outcome: Option<tailscale::FunnelOutcome>) {
    if let Ok(mut l) = LAST_FUNNEL.lock() {
        *l = outcome;
    }
}

/// How long to keep waiting for the approval before leaving it to the user
/// (the screen still shows the link; Try again asks afresh).
const APPROVAL_WAIT_FOR: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// How often to ask again when Tailscale's CLI didn't stay to wait.
const APPROVAL_ASK_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

static APPROVAL_TASK: LazyLock<Mutex<Option<tokio::task::AbortHandle>>> =
    LazyLock::new(|| Mutex::new(None));

/// Stop waiting for an approval; the waiting CLI is killed with the task.
fn stop_approval_watch() {
    if let Some(h) = APPROVAL_TASK.lock().ok().and_then(|mut t| t.take()) {
        h.abort();
    }
}

/// Wait for the user to approve on Tailscale's page, then finish turning the
/// link on by ourselves.
fn start_approval_watch(port: u16, pending: Option<tailscale::PendingApproval>) {
    use tailscale::FunnelOutcome as F;
    stop_approval_watch();
    let task = tokio::spawn(async move {
        let started = std::time::Instant::now();
        let mut pending = pending;
        loop {
            let left = APPROVAL_WAIT_FOR.saturating_sub(started.elapsed());
            if left.is_zero() {
                tracing::info!("[Remote] Stopped waiting for the Tailscale approval");
                return;
            }
            let (outcome, next) = match pending.take() {
                Some(p) if !p.exited() => p.wait(left).await,
                _ => {
                    tokio::time::sleep(APPROVAL_ASK_EVERY).await;
                    if !read_config().enabled || running_port() != Some(port) {
                        return;
                    }
                    tailscale::enable_funnel_waiting(port).await
                }
            };
            match outcome {
                F::On => {
                    tracing::info!("[Remote] Tailscale approved; the link is on");
                    set_last_funnel(Some(F::On));
                    start_publish_watch(port);
                    return;
                }
                F::NeedsApproval { .. } => {
                    set_last_funnel(Some(outcome));
                    pending = next;
                }
                F::Failed { .. } if started.elapsed() >= APPROVAL_WAIT_FOR => return,
                F::Failed { .. } => {
                    tracing::warn!(?outcome, "[Remote] Funnel failed after the approval");
                    set_last_funnel(Some(outcome));
                    return;
                }
            }
        }
    });
    if let Ok(mut t) = APPROVAL_TASK.lock() {
        *t = Some(task.abort_handle());
    }
}

/// Called at launch: if the user left remote access on, put it back.
pub async fn resume_on_launch(app: tauri::AppHandle) {
    if !read_config().enabled {
        return;
    }
    match bring_up(app).await {
        Ok(outcome) => tracing::info!(?outcome, "[Remote] Resumed remote access at launch"),
        Err(e) => tracing::error!("[Remote] Could not resume remote access: {}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_has_token(path: &std::path::Path, token: &str) -> bool {
        std::fs::read_to_string(path).unwrap().contains(token)
    }

    /// An older settings file held the token. The first read moves it into
    /// the Keychain, checks it reads back, and only then drops it from the
    /// file; the link (the token) is unchanged.
    #[test]
    fn an_old_files_token_moves_to_the_keychain() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote_access.json");
        let old = "a".repeat(64);
        std::fs::write(
            &path,
            serde_json::json!({ "enabled": true, "token": old, "projects": ["/p/site"] })
                .to_string(),
        )
        .unwrap();

        // The Keychain is locked: the file's copy keeps working, untouched.
        let store = token_store::Memory::default();
        store.fail_load.store(true, Ordering::SeqCst);
        let c = load_config(&path, &store);
        assert_eq!(c.token, old);
        assert!(file_has_token(&path, &old));

        // It refuses the write: still the file's copy, still in the file.
        store.fail_load.store(false, Ordering::SeqCst);
        store.fail_save.store(true, Ordering::SeqCst);
        assert_eq!(load_config(&path, &store).token, old);
        assert!(file_has_token(&path, &old));

        // It takes it: moved, verified, and gone from the file.
        store.fail_save.store(false, Ordering::SeqCst);
        let c = load_config(&path, &store);
        assert_eq!(c.token, old);
        assert!(c.enabled && c.projects == vec!["/p/site".to_string()]);
        assert_eq!(store.token.lock().unwrap().as_deref(), Some(old.as_str()));
        assert!(!file_has_token(&path, &old), "the file no longer holds it");
        // And reads back from the Keychain from then on.
        assert_eq!(load_config(&path, &store).token, old);
    }

    /// A new token goes to the Keychain, never the file; one the Keychain
    /// refuses is kept in the file so the link still works.
    #[test]
    fn a_new_token_is_kept_in_the_keychain() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote_access.json");
        let store = token_store::Memory::default();
        let mut c = load_config(&path, &store);
        assert!(c.token.is_empty());
        c.token = new_token();
        store_config(&path, &c, &store).unwrap();
        assert!(!file_has_token(&path, &c.token));
        assert_eq!(load_config(&path, &store).token, c.token);

        // Replaced while the Keychain refuses writes: the file carries it.
        store.fail_save.store(true, Ordering::SeqCst);
        let replaced = new_token();
        c.token = replaced.clone();
        store_config(&path, &c, &store).unwrap();
        assert!(file_has_token(&path, &replaced));
        // The Keychain still holds the old one; the file's is the link the
        // user copied, so it wins and is moved on the next read.
        assert_eq!(load_config(&path, &store).token, replaced);
        assert!(file_has_token(&path, &replaced), "still refused: kept");
        store.fail_save.store(false, Ordering::SeqCst);
        assert_eq!(load_config(&path, &store).token, replaced);
        assert!(!file_has_token(&path, &replaced));
        assert_eq!(load_config(&path, &store).token, replaced);
    }

    #[test]
    fn pins_must_be_digits_and_not_obvious() {
        assert!(validate_pin("482915").is_ok());
        assert!(validate_pin("12345").is_err(), "too short");
        assert!(validate_pin("1234567890123").is_err(), "too long");
        assert!(validate_pin("48a915").is_err());
        assert!(validate_pin("000000").is_err());
        assert!(validate_pin("123456").is_err());
        assert!(validate_pin("987654").is_err());
    }

    #[test]
    fn pin_hashes_depend_on_salt_and_pin() {
        let a = hash_pin("salt-a", "482915");
        assert_eq!(a, hash_pin("salt-a", "482915"));
        assert_ne!(a, hash_pin("salt-b", "482915"));
        assert_ne!(a, hash_pin("salt-a", "482916"));
        assert!(!a.contains("482915"));
    }

    fn pending() -> PendingPush {
        PendingPush {
            project_path: "/p".into(),
            branch: "main".into(),
            head: "abc".into(),
            tree_fingerprint: "t1".into(),
            created_ms: 1_000,
        }
    }

    fn attempt<'a>(pending: Option<&'a PendingPush>) -> PushAttempt<'a> {
        PushAttempt {
            project_path: "/p",
            has_pin: true,
            failures: 0,
            pending,
            pin_matches: true,
            head: "abc",
            tree_fingerprint: "t1",
            now: 2_000,
        }
    }

    #[test]
    fn push_rules() {
        let p = pending();
        assert_eq!(decide_push(&attempt(Some(&p))), PushCheck::Ok);
        assert_eq!(
            decide_push(&PushAttempt {
                has_pin: false,
                ..attempt(Some(&p))
            }),
            PushCheck::NoPin
        );
        assert_eq!(decide_push(&attempt(None)), PushCheck::NothingPending);
        assert_eq!(
            decide_push(&PushAttempt {
                project_path: "/other",
                ..attempt(Some(&p))
            }),
            PushCheck::NothingPending
        );
        assert_eq!(
            decide_push(&PushAttempt {
                now: 1_000 + PUSH_TTL_MS + 1,
                ..attempt(Some(&p))
            }),
            PushCheck::Expired
        );
        assert_eq!(
            decide_push(&PushAttempt {
                pin_matches: false,
                ..attempt(Some(&p))
            }),
            PushCheck::WrongPin {
                attempts_left: PUSH_MAX_FAILURES - 1
            }
        );
        assert_eq!(
            decide_push(&PushAttempt {
                pin_matches: false,
                failures: PUSH_MAX_FAILURES - 1,
                ..attempt(Some(&p))
            }),
            PushCheck::Locked,
            "the last allowed wrong PIN locks"
        );
        assert_eq!(
            decide_push(&PushAttempt {
                failures: PUSH_MAX_FAILURES,
                ..attempt(Some(&p))
            }),
            PushCheck::Locked,
            "locked even with the right PIN"
        );
        assert_eq!(
            decide_push(&PushAttempt {
                head: "def",
                ..attempt(Some(&p))
            }),
            PushCheck::Changed
        );
        assert_eq!(
            decide_push(&PushAttempt {
                tree_fingerprint: "t2",
                ..attempt(Some(&p))
            }),
            PushCheck::Changed
        );
        assert_eq!(
            decide_push(&PushAttempt {
                pin_matches: false,
                head: "def",
                ..attempt(Some(&p))
            }),
            PushCheck::WrongPin {
                attempts_left: PUSH_MAX_FAILURES - 1
            },
            "a wrong PIN learns nothing about the project"
        );
    }

    #[test]
    fn pin_state_follows_the_config() {
        let mut c = RemoteConfig::default();
        assert_eq!(push_pin_state(&c), PushPinState::NotSet);
        c.push_pin_hash = Some("h".into());
        assert_eq!(push_pin_state(&c), PushPinState::Set);
        c.push_failures = PUSH_MAX_FAILURES;
        assert_eq!(push_pin_state(&c), PushPinState::Locked);
    }

    #[test]
    fn previews_are_one_short_line() {
        assert_eq!(preview("fix\n  the   header"), "fix the header");
        let long = "x".repeat(500);
        let p = preview(&long);
        assert_eq!(p.chars().count(), AUDIT_PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn tokens_are_long_and_distinct() {
        let a = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, new_token());
    }
}
