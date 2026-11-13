//! # Account (Workspace) Management Commands
//!
//! Accounts ("Workspaces" in the UI) isolate Claude Code login, GitHub CLI
//! login, and a small credential vault per org/client context. Unlike the
//! old per-project profile assignment, an Account is selected once per
//! session at app startup (or via "Switch Workspace") and applies to newly
//! spawned terminals/processes.
//!
//! Credentials (Vercel/Figma/OpenAI tokens, git identity) are stored in the
//! system's secret store (`crate::keychain`: the macOS Keychain, Windows
//! Credential Manager, the Linux Secret Service) — values never leave the
//! Rust layer.
//! Claude Code and GitHub CLI logins are isolated via `CLAUDE_CONFIG_DIR` /
//! `GH_CONFIG_DIR`, each pointed at a per-account directory under
//! `~/.<slug>/accounts/<id>/`.
//!
//! ## Env var injection
//!
//! Call `get_env_vars_for_active_account()` to get a `HashMap<String, String>`
//! of environment variables to inject when spawning Claude/GitHub CLI
//! processes. This is the integration point used by `pty::spawn`, `ai`,
//! `github`, and `pull_requests`.

use crate::agent::AgentConfig;
use crate::commands::claude::find_binary_by_name;
use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{Account, AccountCredentialStatus};
use crate::utils::{create_command, get_extended_path};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// The ID of the built-in default account. Always exists; cannot be deleted.
pub const DEFAULT_ACCOUNT_ID: &str = "default";

/// Credential key -> injected environment variable name.
const CRED_ENV_VARS: &[(&str, &str)] = &[
    ("anthropic_base_url", "ANTHROPIC_BASE_URL"),
    ("vercel_token", "VERCEL_TOKEN"),
    ("cloudflare_api_token", "CLOUDFLARE_API_TOKEN"),
    ("netlify_auth_token", "NETLIFY_AUTH_TOKEN"),
];

/// All credential keys storable in the keychain (including git identity,
/// which isn't injected via `CRED_ENV_VARS` but via `GIT_*` env vars).
const ALL_CRED_KEYS: &[&str] = &[
    "anthropic_base_url",
    "vercel_token",
    "cloudflare_api_token",
    "netlify_auth_token",
    "git_name",
    "git_email",
];

/// Credential keys managed internally by the backend (never settable or
/// clearable through the frontend `set/clear_account_credential` commands, so
/// they're deliberately NOT in `ALL_CRED_KEYS`). They still belong to the
/// account, so they're wiped alongside the rest on account deletion.
///
/// `claude_oauth_token` is a long-lived token an older build captured from
/// `claude setup-token` and injected as `CLAUDE_CODE_OAUTH_TOKEN`. Nothing
/// stores one any more: an isolated account now signs in with Claude Code's
/// own `claude auth login` into its own config folder, and Claude Code keeps
/// that login itself ([`claude_folder_signed_in`]). A token left from before
/// is still used until the account is signed in again, then deleted
/// ([`finish_claude_folder_sign_in`]). `claude_email` was typed at connect
/// time, display only.
const MANAGED_CRED_KEYS: &[&str] = &[
    "claude_oauth_token",
    "claude_email",
    "claude_token_expires_at",
];

/// Keychain key holding a workspace's legacy Claude OAuth token.
const CLAUDE_TOKEN_KEY: &str = "claude_oauth_token";
/// Keychain key holding the email for a workspace's connected Claude account.
const CLAUDE_EMAIL_KEY: &str = "claude_email";
/// Keychain key holding the unix-seconds expiry of the legacy Claude token.
const CLAUDE_EXPIRES_KEY: &str = "claude_token_expires_at";

/// Written into an isolated account's Claude config folder once a
/// `claude auth login` there was confirmed by `claude auth status` run as that
/// folder. Holds only the time; the login itself is Claude Code's.
pub const CLAUDE_FOLDER_LOGIN_MARKER: &str = ".signed-in-here";

/// The first Claude Code known to key its Keychain login per config folder
/// (`Claude Code-credentials-<sha256(dir)[..8]>`; read in 2.1.323's own code,
/// and seen as an item on this Mac). Older builds shared one item, so a sign-in
/// in another folder would replace this Mac's own: refused below this.
const CLAUDE_PER_FOLDER_LOGIN_SINCE: (u64, u64, u64) = (2, 1, 318);

/// Validates a frontend-supplied account id before it's joined into filesystem
/// paths (`~/.<slug>/accounts/<id>/`), keychain service names, or env vars.
///
/// Account ids are always either the literal `"default"` or a generated UUID, so
/// we hold a strict allowlist: non-empty, at most 64 chars, ASCII alphanumeric
/// and `-` only. This rejects `..`, `/`, `\`, and other traversal/injection
/// payloads that would otherwise let a caller read or create directories outside
/// the accounts root.
pub fn validate_account_id(account_id: &str) -> Result<(), CommandError> {
    let valid = !account_id.is_empty()
        && account_id.len() <= 64
        && account_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "account_id".into(),
            reason: "Invalid workspace id".into(),
        })
    }
}

// ============ Secret store helpers ============
//
// Every secret goes through `crate::keychain`: the login Keychain on macOS,
// Windows Credential Manager on Windows, the Secret Service on Linux
// (GNOME Keyring, KWallet). Where none of those exists (another platform) the
// honest behaviour is to say so rather than fail like a bug (issue #922).

/// Whether this platform has a credential vault behind these helpers.
const KEYCHAIN_SUPPORTED: bool = crate::keychain::SUPPORTED;

/// The refusal used everywhere the vault is asked for and isn't there.
///
/// `Expected`, because a platform without an implementation is a known state
/// with a user-side course of action, not something going wrong.
fn keychain_unsupported() -> CommandError {
    CommandError::expected(
        "Per-workspace credentials can't be stored on this platform: the app has no \
         credential vault here. Use the default workspace, or sign in with the \
         provider's own CLI (`vercel login`, `gh auth login`, `claude /login`), and this project \
         will use those credentials.",
    )
}

fn keychain_service(account_id: &str) -> String {
    format!("{}{account_id}", crate::brand::keychain_prefix("account"))
}

fn write_to_keychain(account_id: &str, key: &str, value: &str) -> Result<(), CommandError> {
    if !KEYCHAIN_SUPPORTED {
        return Err(keychain_unsupported());
    }
    keychain_write(&keychain_service(account_id), key, value)
}

/// Store `value` under (`service`, `key`). Shared with Agents' secrets
/// (`agents::secrets`), which keep their own service namespace per agent,
/// and the companion's identity key. How items are kept, and how older ones
/// move over without ever being at risk, is [`crate::keychain`].
pub(crate) fn keychain_write(service: &str, key: &str, value: &str) -> Result<(), CommandError> {
    if !KEYCHAIN_SUPPORTED {
        return Err(CommandError::expected(
            "Secrets can't be stored on this platform: there's no credential vault here.",
        ));
    }
    crate::keychain::write(service, key, value).map_err(|e| {
        CommandError::from(format!(
            "Failed to store credential '{key}' in {}: {e}",
            crate::keychain::STORE_NAME
        ))
    })
}

fn read_from_keychain(account_id: &str, key: &str) -> Option<String> {
    keychain_read(&keychain_service(account_id), key)
}

fn read_from_keychain_checked(account_id: &str, key: &str) -> crate::keychain::Read {
    keychain_read_checked(&keychain_service(account_id), key)
}

/// The value under (`service`, `key`), or `None` for "no value" and "the
/// Keychain didn't answer" alike. Where the two must be told apart (status
/// shown to the user, the companion's identity key) use
/// [`keychain_read_checked`].
pub(crate) fn keychain_read(service: &str, key: &str) -> Option<String> {
    match keychain_read_checked(service, key) {
        crate::keychain::Read::Found(v) => Some(v),
        crate::keychain::Read::NotFound => None,
        crate::keychain::Read::Error(e) => {
            tracing::warn!(service, error = %e, "[Keychain] read failed");
            None
        }
    }
}

/// Found / definitely not there / couldn't check.
pub(crate) fn keychain_read_checked(service: &str, key: &str) -> crate::keychain::Read {
    if !KEYCHAIN_SUPPORTED {
        return crate::keychain::Read::Error(
            "there's nowhere to keep secrets on this platform".into(),
        );
    }
    crate::keychain::read(service, key)
}

fn delete_from_keychain(account_id: &str, key: &str) {
    keychain_delete(&keychain_service(account_id), key);
}

pub(crate) fn keychain_delete(service: &str, key: &str) {
    if !KEYCHAIN_SUPPORTED {
        return;
    }
    if let Err(e) = crate::keychain::delete(service, key) {
        tracing::warn!(service, error = %e, "[Keychain] delete failed");
    }
}

fn delete_all_account_credentials(account_id: &str) {
    for key in ALL_CRED_KEYS.iter().chain(MANAGED_CRED_KEYS.iter()) {
        delete_from_keychain(account_id, key);
    }
}

/// Remove a workspace's legacy Claude token + email + expiry. Its terminals
/// fall back to no injected token.
pub fn clear_claude_token(account_id: &str) {
    delete_from_keychain(account_id, CLAUDE_TOKEN_KEY);
    delete_from_keychain(account_id, CLAUDE_EMAIL_KEY);
    delete_from_keychain(account_id, CLAUDE_EXPIRES_KEY);
}

/// Whether an isolated account is signed in to Claude Code in its own config
/// folder: its sign-in was confirmed there ([`finish_claude_folder_sign_in`]).
/// The login itself is Claude Code's, in its own Keychain item for that
/// folder; this app never reads or keeps it. Stored state only, no process.
pub fn claude_folder_signed_in(account_id: &str) -> bool {
    if account_id == DEFAULT_ACCOUNT_ID || validate_account_id(account_id).is_err() {
        return false;
    }
    account_config_root(account_id)
        .join("claude")
        .join(CLAUDE_FOLDER_LOGIN_MARKER)
        .is_file()
}

/// `claude auth status`, run as `account_id`'s own config folder with any
/// token stripped from its environment, so the answer is about the login
/// Claude Code keeps for that folder. `None`: the CLI couldn't answer.
pub async fn claude_folder_auth_status(account_id: &str) -> Option<(bool, Option<String>)> {
    if account_id == DEFAULT_ACCOUNT_ID || validate_account_id(account_id).is_err() {
        return None;
    }
    let binary = find_binary_by_name("claude")?;
    let mut cmd = create_command(binary);
    cmd.args(["auth", "status"]);
    cmd.env("PATH", get_extended_path());
    cmd.env("CLAUDE_CONFIG_DIR", claude_config_dir(account_id));
    for var in CLAUDE_LOGIN_OVERRIDES {
        cmd.env_remove(var);
    }
    let out = run_with_timeout(tokio::process::Command::from(cmd), "claude auth status", 10)
        .await
        .ok()?;
    parse_claude_auth_status(&String::from_utf8_lossy(&out.stdout))
}

/// Variables that would make Claude Code use some other login than the one
/// it keeps for the config folder: an injected token, or a secure-storage
/// folder that isn't this one. Removed from every process run as an
/// isolated account's own sign-in.
pub const CLAUDE_LOGIN_OVERRIDES: &[&str] =
    &["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"];

/// After `claude auth login` ran in an isolated account's folder and exited
/// 0: confirm it with `claude auth status` as that folder, and only then
/// record it ([`CLAUDE_FOLDER_LOGIN_MARKER`]) and delete the token an older
/// build kept for the account. Returns whether the folder is signed in.
pub async fn finish_claude_folder_sign_in(account_id: &str) -> bool {
    if !matches!(claude_folder_auth_status(account_id).await, Some((true, _))) {
        tracing::warn!(
            account_id,
            "claude auth login exited 0 but its folder isn't signed in"
        );
        return false;
    }
    let marker = claude_config_dir(account_id).join(CLAUDE_FOLDER_LOGIN_MARKER);
    if let Err(e) = std::fs::write(&marker, unix_now().to_string()) {
        tracing::warn!(account_id, error = %e, "couldn't record a Claude folder sign-in");
        return false;
    }
    // The login works on its own now: the token from before goes.
    clear_claude_token(account_id);
    // A usage account signed in again may be another Claude account now.
    crate::agents::usage_plan::fresh_sign_in(crate::agents::engine::Engine::Claude, account_id);
    true
}

/// `claude --version` (`2.1.323 (Claude Code)`) at or past `since`.
fn claude_version_at_least(text: &str, since: (u64, u64, u64)) -> bool {
    let Some(word) = text
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
    else {
        return false;
    };
    let mut parts = word.split('.').map(|p| {
        p.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u64>()
            .ok()
    });
    match (
        parts.next().flatten(),
        parts.next().flatten(),
        parts.next().flatten(),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c) >= since,
        _ => false,
    }
}

/// Whether this Claude Code keeps a separate login per config folder, asked
/// of the binary itself (bounded: a hung CLI answers no). Called from a
/// command thread, outside the async runtime.
fn claude_logs_in_per_folder(binary: &std::path::Path) -> bool {
    let mut cmd = create_command(binary);
    cmd.arg("--version").env("PATH", get_extended_path());
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return false;
    };
    match rt.block_on(run_with_timeout(
        tokio::process::Command::from(cmd),
        "claude --version",
        10,
    )) {
        Ok(out) if out.status.success() => claude_version_at_least(
            &String::from_utf8_lossy(&out.stdout),
            CLAUDE_PER_FOLDER_LOGIN_SINCE,
        ),
        _ => false,
    }
}

/// Current wall-clock time in unix seconds (0 if the clock is before the epoch).
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Decide whether a workspace's stored Claude token should be injected as
/// `CLAUDE_CODE_OAUTH_TOKEN` into a spawned process, from stored state only
/// (this runs on every PTY spawn — never make a network call here).
///
/// `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over any interactive `/login`
/// the user performs inside the terminal, so injecting a token past its
/// recorded expiry would permanently shadow a fresh re-login with a dead
/// credential (issue #159 — "cannot sign back into Claude"). Expired → don't
/// inject; the terminal is then free to authenticate interactively.
///
/// Tokens the API rejected at connect time are never persisted in the first
/// place (see `claude_token_check` in `connect_claude_account`), so
/// "no token stored" is the stored rejection state and this helper only needs
/// the expiry. No expiry recorded (older connect) → inject, mirroring
/// `resolve_claude_identity`'s benefit-of-the-doubt for pre-expiry connects.
fn should_inject_claude_token(expires_at: Option<u64>, now: u64) -> bool {
    match expires_at {
        Some(expires_at) => now < expires_at,
        None => true,
    }
}

/// The legacy Claude token an older build kept for an isolated account, while
/// its recorded expiry hasn't passed and the account hasn't been signed in
/// again in its own folder (then Claude Code's own login is used and this
/// token is deleted). Used by usage wallets (`agents::wallet`).
pub fn claude_token_for(account_id: &str) -> Option<String> {
    if account_id == DEFAULT_ACCOUNT_ID || validate_account_id(account_id).is_err() {
        return None;
    }
    if claude_folder_signed_in(account_id) {
        return None;
    }
    let token = read_from_keychain(account_id, CLAUDE_TOKEN_KEY)?;
    should_inject_claude_token(read_claude_token_expiry(account_id), unix_now()).then_some(token)
}

/// The email given when an isolated account's Claude sign-in was made.
pub fn claude_email_for(account_id: &str) -> Option<String> {
    if account_id == DEFAULT_ACCOUNT_ID || validate_account_id(account_id).is_err() {
        return None;
    }
    read_from_keychain(account_id, CLAUDE_EMAIL_KEY)
}

/// Remove an isolated account's sign-ins from this Mac: its Keychain items
/// and its folder under `~/.<slug>/accounts/<id>/`. Refuses the Default
/// account and any id a workspace uses (those are `delete_account`'s).
pub fn forget_isolated_account(account_id: &str) {
    if account_id == DEFAULT_ACCOUNT_ID || validate_account_id(account_id).is_err() {
        return;
    }
    if read_app_state().accounts.iter().any(|a| a.id == account_id) {
        tracing::warn!(
            account_id,
            "not removing a workspace's sign-ins from a usage account"
        );
        return;
    }
    delete_all_account_credentials(account_id);
    // Claude Code's own login for the folder lives in its Keychain item for
    // that folder: Claude Code removes it, before the folder goes.
    if claude_folder_signed_in(account_id) {
        claude_folder_sign_out(account_id);
    }
    if let Err(e) = std::fs::remove_dir_all(account_config_root(account_id)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(account_id, error = %e, "couldn't remove a usage account's folder");
        }
    }
}

/// Read a workspace's stored Claude token expiry (unix seconds), if any.
fn read_claude_token_expiry(account_id: &str) -> Option<u64> {
    read_from_keychain(account_id, CLAUDE_EXPIRES_KEY).and_then(|s| s.trim().parse::<u64>().ok())
}

/// Connection state of a workspace's Claude login, for the agent card.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeConnState {
    /// Never connected — render today's neutral "Not signed in / Sign in" UI.
    NotConnected,
    /// Connected with a token believed valid — green stroke, show email.
    Connected,
    /// Was connected but the token has expired — red stroke + inline Reconnect.
    NeedsReconnect,
    /// The Keychain didn't answer (locked, refused): whether it's connected
    /// isn't known. Never shown as "not connected", which would invite a
    /// reconnect over a token that is fine.
    KeychainUnavailable,
}

/// Resolved Claude identity for a workspace: connection state + the email to show.
pub struct ClaudeIdentity {
    pub state: ClaudeConnState,
    pub email: Option<String>,
}

/// Resolve a workspace's Claude login state + display email.
///
/// - **Default workspace**: uses Claude's native keychain login, so we ask the
///   CLI directly via `claude auth status` (which returns the email for a
///   `claude.ai` login). No injected token.
/// - **Other workspaces**: driven entirely by the per-workspace vault — token
///   presence means connected, the stored expiry decides connected-vs-reconnect,
///   and the email is whatever was captured at connect time. We deliberately do
///   NOT shell out here (the opaque token can't be validated cheaply anyway).
pub async fn resolve_claude_identity(account_id: &str) -> ClaudeIdentity {
    if account_id == DEFAULT_ACCOUNT_ID {
        return resolve_default_claude_identity().await;
    }

    if claude_folder_signed_in(account_id) {
        // Who it is, as Claude Code's own file for the folder records it.
        let config = claude_config_dir(account_id).join(".claude.json");
        let who = crate::agents::identity::read(Some(&config), crate::agents::identity::claude);
        return ClaudeIdentity {
            state: ClaudeConnState::Connected,
            email: who.email,
        };
    }
    match read_from_keychain_checked(account_id, CLAUDE_TOKEN_KEY) {
        crate::keychain::Read::Found(_) => {}
        crate::keychain::Read::NotFound => {
            return ClaudeIdentity {
                state: ClaudeConnState::NotConnected,
                email: None,
            }
        }
        crate::keychain::Read::Error(e) => {
            tracing::warn!(account_id, error = %e, "[Keychain] couldn't check the Claude token");
            return ClaudeIdentity {
                state: ClaudeConnState::KeychainUnavailable,
                email: None,
            };
        }
    }
    let email = read_from_keychain(account_id, CLAUDE_EMAIL_KEY);
    // No expiry recorded (older connect): treat as still valid rather than
    // nagging the user with a false red (see should_inject_claude_token).
    let valid = should_inject_claude_token(read_claude_token_expiry(account_id), unix_now());
    ClaudeIdentity {
        state: if valid {
            ClaudeConnState::Connected
        } else {
            ClaudeConnState::NeedsReconnect
        },
        email,
    }
}

/// Identity for the Default workspace via `claude auth status` (native login).
async fn resolve_default_claude_identity() -> ClaudeIdentity {
    match claude_cli_auth_status().await {
        Some((true, email)) => ClaudeIdentity {
            state: ClaudeConnState::Connected,
            email,
        },
        // Logged out, or the CLI couldn't answer — either way there's no
        // usable native login to report.
        _ => ClaudeIdentity {
            state: ClaudeConnState::NotConnected,
            email: None,
        },
    }
}

/// Ask the Claude CLI for its *native* (keychain/`~/.claude`) login state via
/// `claude auth status`. This is the single source of truth shared by the
/// dashboard's Agents panel and onboarding's `check_claude_auth_status` — file
/// indicators like `~/.claude/settings.json` survive a sign-out and would make
/// the two disagree (issue #159).
///
/// Returns `Some((logged_in, email))` when the CLI gave a definitive answer.
/// Returns `None` when it *couldn't* answer — binary missing, spawn
/// failure/timeout, or output that isn't the expected status JSON (e.g. an
/// older CLI without the `auth` subcommand) — so callers may fall back to
/// weaker signals.
///
/// Callers that ask while a probe is already running share its answer
/// (`joined`): the overview, usage and setup ask at the same moment.
pub async fn claude_cli_auth_status() -> Option<(bool, Option<String>)> {
    static PROBE: crate::joined::Joined<Option<(bool, Option<String>)>> =
        crate::joined::Joined::new();
    PROBE.run(probe_claude_cli_auth_status).await
}

async fn probe_claude_cli_auth_status() -> Option<(bool, Option<String>)> {
    let binary = find_binary_by_name("claude")?;
    let mut cmd = create_command(binary);
    cmd.args(["auth", "status"]);
    cmd.env("PATH", get_extended_path());
    // Native locations; do NOT pin CLAUDE_CONFIG_DIR or inject a token.
    let tokio_cmd = tokio::process::Command::from(cmd);
    let out = run_with_timeout(tokio_cmd, "claude auth status", 10)
        .await
        .ok()?;
    // Parse stdout regardless of exit code: a logged-out CLI may exit non-zero
    // while still printing the status JSON. Unparseable output → None.
    parse_claude_auth_status(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `claude auth status` JSON → `Some((logged_in, email))`. Tolerant of
/// unknown fields; returns `None` for non-JSON output or JSON without a
/// `loggedIn` bool (not a definitive answer).
fn parse_claude_auth_status(stdout: &str) -> Option<(bool, Option<String>)> {
    let v = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok()?;
    let logged_in = v.get("loggedIn").and_then(|b| b.as_bool())?;
    let email = v
        .get("email")
        .and_then(|e| e.as_str())
        .map(str::to_string)
        .filter(|e| !e.is_empty());
    Some((logged_in, email))
}

// ============ Config dir isolation ============

/// Root directory for an account's isolated config: `~/.<slug>/accounts/<id>/`
/// (this app's own, never Ship Studio's `~/.ship-studio`).
fn account_config_root(account_id: &str) -> PathBuf {
    crate::brand::dot_dir()
        .unwrap_or_default()
        .join("accounts")
        .join(account_id)
}

/// Create `dir` (and ancestors) and lock it down to owner-only (`0700`) on Unix.
///
/// Isolated workspace dirs hold real auth tokens (gh `hosts.yml`, Claude creds,
/// codex auth). A bare `create_dir_all` leaves them at the default `0755`
/// (world-readable/traversable); on a shared machine another local user could
/// walk in. We also tighten the `~/.<slug>/accounts/<id>` parent so the
/// whole per-account subtree is private, not just the leaf.
fn create_private_dir(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// Build a per-account config subdir (e.g. `claude`, `gh`), creating both it and
/// the account root with owner-only permissions.
fn private_account_subdir(account_id: &str, leaf: &str) -> PathBuf {
    let root = account_config_root(account_id);
    let dir = root.join(leaf);
    create_private_dir(&dir);
    // Also lock the account root itself (create_private_dir made its ancestors
    // with default perms while creating the leaf).
    create_private_dir(&root);
    dir
}

/// Directory used as `CLAUDE_CONFIG_DIR` for this account, created on access.
///
/// The Default account resolves to the real, global Claude config directory
/// (honoring `CLAUDE_CONFIG_DIR` if already set in the environment, else
/// `~/.claude`) so existing users' logins are unaffected by Workspace
/// isolation. Other accounts get an isolated directory under
/// `~/.<slug>/accounts/<id>/`.
pub fn claude_config_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        return std::env::var("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".claude"));
    }
    private_account_subdir(account_id, "claude")
}

/// Directory used as `GH_CONFIG_DIR` for this account, created on access.
///
/// The Default account resolves to the real, global `gh` config directory
/// (honoring `GH_CONFIG_DIR`/`XDG_CONFIG_HOME` if already set, else
/// `~/.config/gh`) so existing users' `gh` logins are unaffected by Workspace
/// isolation. Other accounts get an isolated directory under
/// `~/.<slug>/accounts/<id>/`.
pub fn gh_config_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        if let Ok(dir) = std::env::var("GH_CONFIG_DIR") {
            return PathBuf::from(dir);
        }
        let config_home = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".config"));
        return config_home.join("gh");
    }
    private_account_subdir(account_id, "gh")
}

/// Directory used as `CODEX_HOME` for this account, created on access.
///
/// The Default account resolves to the real, global Codex directory
/// (honoring `CODEX_HOME` if already set, else `~/.codex`). Other accounts
/// get an isolated directory under `~/.<slug>/accounts/<id>/`.
pub fn codex_home_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        return std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".codex"));
    }
    private_account_subdir(account_id, "codex")
}

/// Directory used as `XDG_DATA_HOME` for this account, created on access.
///
/// The Default account resolves to the real, global data directory (honoring
/// `XDG_DATA_HOME` if already set, else `~/.local/share`) so Opencode's
/// existing `~/.local/share/opencode` login is unaffected. Other accounts get
/// an isolated directory under `~/.<slug>/accounts/<id>/`.
pub fn opencode_data_home_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        return std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".local")
                    .join("share")
            });
    }
    private_account_subdir(account_id, "data")
}

/// Resolves the directory that holds `agent`'s auth/config state for the
/// given account — the per-account equivalent of `$HOME/<agent.auth_config_dir>`.
/// The Default account maps to the real global directory; other accounts get
/// an isolated directory under `~/.<slug>/accounts/<id>/`.
pub fn agent_auth_dir(account_id: &str, agent: &AgentConfig) -> PathBuf {
    match agent.id {
        "claude-code" => claude_config_dir(account_id),
        "codex" => codex_home_dir(account_id),
        "opencode" => opencode_data_home_dir(account_id).join("opencode"),
        _ => account_config_root(account_id).join(agent.auth_config_dir),
    }
}

// ============ Internal helpers ============

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ensures the built-in "Default" account exists and that an active account
/// is set, seeding both on first run.
fn ensure_default_account(state: &mut crate::types::AppState) {
    if !state.accounts.iter().any(|a| a.id == DEFAULT_ACCOUNT_ID) {
        state.accounts.insert(
            0,
            Account {
                id: DEFAULT_ACCOUNT_ID.to_string(),
                name: "Default".to_string(),
                color: "#6b7280".to_string(),
                is_default: true,
                created_at: now_ms(),
                projects_root: None,
            },
        );
    }
    if state.active_account_id.is_none() {
        state.active_account_id = Some(DEFAULT_ACCOUNT_ID.to_string());
    }
}

/// Returns env vars to inject for the currently active account.
pub fn get_env_vars_for_active_account() -> HashMap<String, String> {
    let state = read_app_state();
    let account_id = state
        .active_account_id
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());
    get_env_vars_for_account(&account_id)
}

/// Env vars for the account a *project* belongs to — its tagged workspace,
/// falling back to the active account when the project is untagged. Operations
/// that act on a specific project (terminal spawn, git push, PR create, AI
/// generation) use this instead of `get_env_vars_for_active_account` so they
/// inherit the project's workspace credentials rather than whichever workspace
/// happens to be globally active — letting you work two projects in two
/// different workspaces at once without their logins crossing.
pub fn get_env_vars_for_project(project_path: &std::path::Path) -> HashMap<String, String> {
    let account_id = crate::commands::projects::project_account_id_sync(project_path);
    get_env_vars_for_account(&account_id)
}

/// Returns env vars to inject for a specific account: isolated Claude/GitHub
/// config dirs, plus any credentials stored in the keychain for that account.
pub fn get_env_vars_for_account(account_id: &str) -> HashMap<String, String> {
    // Single chokepoint for every env-injection path (active account, project
    // account, direct). The active-account id is read from app_state.json, which
    // is a plain user-writable file that never re-validates on read — a tampered
    // or recovered id could otherwise be joined into filesystem paths
    // (create_dir_all) below. Refuse anything that isn't a well-formed id and
    // fall back to the Default workspace so we never traverse outside the
    // accounts root.
    let account_id = if validate_account_id(account_id).is_ok() {
        account_id
    } else {
        tracing::warn!(account_id = %account_id, "Invalid account id during env resolution; falling back to Default");
        DEFAULT_ACCOUNT_ID
    };

    let mut vars = HashMap::new();

    // Only override the CLI config/data dirs for isolated (non-default)
    // workspaces. The Default workspace MUST let each tool resolve its own
    // native location so the user's existing global login is found on every
    // platform. Forcing these for Default broke GitHub auth on Windows (gh's
    // native dir is %AppData%\GitHub CLI, never ~/.config/gh) and on Macs whose
    // token lived elsewhere (e.g. a shell-set GH_CONFIG_DIR/XDG_CONFIG_HOME a
    // Dock-launched GUI can't see, the same limitation we work around for PATH),
    // and broke opencode on Windows (XDG_DATA_HOME != %LOCALAPPDATA%). Not
    // injecting restores pre-Workspaces behavior: if the app's own environment
    // already carries one of these (launched from a configured shell), the child
    // still inherits it; otherwise the tool resolves natively.
    if account_id != DEFAULT_ACCOUNT_ID {
        vars.insert(
            "CLAUDE_CONFIG_DIR".to_string(),
            claude_config_dir(account_id).to_string_lossy().to_string(),
        );
        vars.insert(
            "GH_CONFIG_DIR".to_string(),
            gh_config_dir(account_id).to_string_lossy().to_string(),
        );
        vars.insert(
            "CODEX_HOME".to_string(),
            codex_home_dir(account_id).to_string_lossy().to_string(),
        );
        vars.insert(
            "XDG_DATA_HOME".to_string(),
            opencode_data_home_dir(account_id)
                .to_string_lossy()
                .to_string(),
        );

        // Per-workspace Claude login. Claude Code (2.1.318 on) keeps its
        // login per config folder (Keychain `Claude Code-credentials-<hash of
        // the folder>`), so the CLAUDE_CONFIG_DIR above is the whole of the
        // isolation: the workspace signs in with `claude auth login` there and
        // nothing of the login passes through this app.
        //
        // Legacy: older builds captured a `claude setup-token` token instead.
        // It is still injected until the workspace is signed in again in its
        // folder (then it is deleted, `finish_claude_folder_sign_in`), and
        // never past its stored expiry: the env token overrides any login in
        // the terminal, so a dead one would make signing in again impossible
        // (issue #159).
        if claude_folder_signed_in(account_id) {
            // Claude Code's own login for the folder; nothing to inject.
        } else if let Some(token) = read_from_keychain(account_id, CLAUDE_TOKEN_KEY) {
            if should_inject_claude_token(read_claude_token_expiry(account_id), unix_now()) {
                vars.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), token);
            } else {
                tracing::warn!(
                    account_id = %account_id,
                    "stored Claude token for workspace has expired; not injecting CLAUDE_CODE_OAUTH_TOKEN so an interactive login can work — reconnect the workspace to refresh it"
                );
            }
        }
    }

    for (key, env_name) in CRED_ENV_VARS {
        if let Some(value) = read_from_keychain(account_id, key) {
            vars.insert(env_name.to_string(), value);
        }
    }

    if let Some(name) = read_from_keychain(account_id, "git_name") {
        vars.insert("GIT_AUTHOR_NAME".to_string(), name.clone());
        vars.insert("GIT_COMMITTER_NAME".to_string(), name);
    }
    if let Some(email) = read_from_keychain(account_id, "git_email") {
        vars.insert("GIT_AUTHOR_EMAIL".to_string(), email.clone());
        vars.insert("GIT_COMMITTER_EMAIL".to_string(), email);
    }

    vars
}

/// Parses `gh auth status` output, returning the connected github.com username
/// or `None` when there is no usable login.
///
/// We intentionally key off the printed output, NOT the process exit code:
/// `gh auth status` exits NON-ZERO whenever *any* configured account has an
/// invalid token, even when a different account is logged in and active. A user
/// with a stale second account (`X Failed to log in to github.com account ...`)
/// was therefore reported as "Not connected" — a grey GitHub button that
/// re-prompted in a loop. The `✓ Logged in to github.com ...` line is the
/// source of truth.
///
/// When gh reports multiple accounts we prefer the one it marks
/// `Active account: true`, because every git/gh operation the app runs uses
/// that account — so its validity, not just "any login exists", determines
/// whether we're really connected. If the active account's token is invalid we
/// return `None` even if some other account is valid. When there's no active
/// marker at all (older single-account gh), any valid login counts.
///
/// `gh` changed the phrasing in ~v2.40: older builds print
/// `Logged in to github.com as <user>` while newer ones print
/// `Logged in to github.com account <user>`. We accept both so modern `gh`
/// installs aren't reported as "Not connected".
pub(crate) fn parse_gh_auth_status(stdout: &str, stderr: &str) -> Option<String> {
    const LOGGED_IN: &str = "Logged in to github.com ";
    const FAILED: &str = "Failed to log in to github.com ";

    // Extract the username following the connector word ("as" on older gh,
    // "account" on ~v2.40+) after `marker` within `line`.
    fn username_after(line: &str, marker: &str) -> Option<String> {
        let idx = line.find(marker)?;
        let rest = &line[idx + marker.len()..];
        let mut words = rest.split_whitespace();
        match words.next() {
            Some("as") | Some("account") => {
                words.next().filter(|u| !u.is_empty()).map(String::from)
            }
            _ => None,
        }
    }

    // One account block in the output. `valid` is the ✓ vs ✗ distinction;
    // `active` is set when the following `- Active account: true` line is seen.
    struct Entry {
        user: String,
        valid: bool,
        active: bool,
    }

    let combined = format!("{stdout}{stderr}");
    let mut entries: Vec<Entry> = Vec::new();
    for line in combined.lines() {
        let trimmed = line.trim();
        // "Failed to log in" does not contain "Logged in" (capital L), so the two
        // markers never collide — a failed account is never read as a login.
        if let Some(user) = username_after(trimmed, LOGGED_IN) {
            entries.push(Entry {
                user,
                valid: true,
                active: false,
            });
        } else if let Some(user) = username_after(trimmed, FAILED) {
            entries.push(Entry {
                user,
                valid: false,
                active: false,
            });
        } else if trimmed.contains("Active account: true") {
            if let Some(last) = entries.last_mut() {
                last.active = true;
            }
        }
    }

    // Prefer the account gh treats as active; the app operates as that account.
    if let Some(active) = entries.iter().find(|e| e.active) {
        return active.valid.then(|| active.user.clone());
    }
    // No active marker (older single-account gh): any valid login counts.
    entries.into_iter().find(|e| e.valid).map(|e| e.user)
}

// ============ Tauri commands ============

/// List all accounts (workspaces). Creates the Default account on first call.
#[tauri::command]
#[tracing::instrument]
pub fn list_accounts() -> Result<Vec<Account>, CommandError> {
    let mut state = read_app_state();
    // Ensure the built-in Default exists in the returned list, but DON'T persist
    // here — this is a read-path getter called very frequently (every workspace
    // indicator refresh, focus, etc.). Writing on read created an unguarded
    // read-modify-write race that clobbered concurrent set_active_account_id /
    // create_account writes (the "switch didn't stick / wrong active workspace"
    // bug). The Default account is persisted lazily by the next real mutation.
    ensure_default_account(&mut state);
    Ok(state.accounts)
}

/// Create a new account (workspace).
#[tauri::command]
#[tracing::instrument]
pub fn create_account(name: String, color: String) -> Result<Account, CommandError> {
    if name.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "name".into(),
            reason: "Workspace name cannot be empty".into(),
        });
    }
    let mut state = read_app_state();
    ensure_default_account(&mut state);

    let account = Account {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        color,
        is_default: false,
        created_at: now_ms(),
        projects_root: None,
    };
    state.accounts.push(account.clone());
    write_app_state(&state)?;
    tracing::info!(name = %account.name, "Account created");
    Ok(account)
}

/// Update an account's name and color.
#[tauri::command]
#[tracing::instrument]
pub fn update_account(id: String, name: String, color: String) -> Result<Account, CommandError> {
    validate_account_id(&id)?;
    if name.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "name".into(),
            reason: "Workspace name cannot be empty".into(),
        });
    }
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    let account = state
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::Other {
            message: format!("Account '{id}' not found"),
        })?;

    account.name = name.trim().to_string();
    account.color = color;
    let updated = account.clone();
    write_app_state(&state)?;
    Ok(updated)
}

/// Delete an account. The Default account cannot be deleted.
/// If the deleted account was active, the active account falls back to Default.
#[tauri::command]
#[tracing::instrument]
pub fn delete_account(id: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "Cannot delete the Default workspace".into(),
        });
    }
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    let before = state.accounts.len();
    state.accounts.retain(|a| a.id != id);
    if state.accounts.len() == before {
        return Err(CommandError::Other {
            message: format!("Account '{id}' not found"),
        });
    }

    if state.active_account_id.as_deref() == Some(id.as_str()) {
        state.active_account_id = Some(DEFAULT_ACCOUNT_ID.to_string());
    }

    delete_all_account_credentials(&id);
    // Remove the workspace's isolated config dir too — it holds live Claude /
    // gh / codex session tokens. Leaving it behind means a deleted workspace's
    // logins survive on disk (and would be reused if the id were ever reused).
    // Guarded by validate_account_id above so this can't escape the accounts root.
    let config_dir = account_config_root(&id);
    if let Err(e) = std::fs::remove_dir_all(&config_dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(id = %id, error = %e, "Failed to remove account config dir on delete");
        }
    }
    write_app_state(&state)?;
    tracing::info!(id = %id, "Account deleted");
    Ok(())
}

/// Returns the currently active account's ID (defaults to "default").
#[tauri::command]
#[tracing::instrument]
pub fn get_active_account_id() -> Result<String, CommandError> {
    // Read-only getter: do NOT write here. It's called on every dashboard
    // refresh, env injection, and indicator update; persisting on read raced
    // with set_active_account_id and silently reverted workspace switches.
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    Ok(state
        .active_account_id
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string()))
}

/// Sets the currently active account. Already-running terminals keep their
/// existing env; only newly spawned processes pick up the new account.
#[tauri::command]
#[tracing::instrument]
pub fn set_active_account_id(id: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    if !state.accounts.iter().any(|a| a.id == id) {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: format!("Account '{id}' does not exist"),
        });
    }
    state.active_account_id = Some(id.clone());
    write_app_state(&state)?;
    // The GitHub username is cached with a 10-min TTL; without busting it here a
    // workspace switch would keep reporting the previous workspace's identity.
    crate::commands::github::invalidate_github_username_cache();
    // The projects folder is per-workspace, so switching changes which folder
    // the dashboard scans — drop the cached active root.
    crate::utils::invalidate_projects_root_cache();
    tracing::info!(id = %id, "Active account changed");
    Ok(())
}

/// Returns auth/credential status for an account, for display in the account
/// settings modal. Secret values never leave the Rust layer.
#[tauri::command]
#[tracing::instrument]
pub async fn get_account_credential_status(
    id: String,
) -> Result<AccountCredentialStatus, CommandError> {
    validate_account_id(&id)?;

    // An agent is "connected" for this workspace if its auth file exists in the
    // workspace's isolated config dir (the same file-based check used in setup).
    let agent_connected = |agent_id: &str| -> Option<String> {
        let agent = crate::agent::get_agent_by_id(agent_id);
        let dir = agent_auth_dir(&id, agent);
        agent
            .auth_indicators
            .iter()
            .any(|indicator| dir.join(indicator).exists())
            .then(|| "Connected".to_string())
    };
    // Claude can't use the file-indicator check: on macOS its login lives in a
    // global keychain entry that ignores CLAUDE_CONFIG_DIR, so indicator files
    // exist even for workspaces that were never connected. Use the real
    // per-workspace token/identity instead, surfacing the actual email.
    let claude = resolve_claude_identity(&id).await;
    let claude_auth_email = match claude.state {
        ClaudeConnState::Connected => Some(
            claude
                .email
                .clone()
                .unwrap_or_else(|| "Connected".to_string()),
        ),
        ClaudeConnState::NeedsReconnect => Some("Reconnect needed".to_string()),
        ClaudeConnState::KeychainUnavailable => {
            Some(format!("Couldn't check {}", crate::keychain::STORE_NAME))
        }
        ClaudeConnState::NotConnected => None,
    };
    let codex_auth_email = agent_connected("codex");
    let opencode_auth_email = agent_connected("opencode");

    let mut gh_cmd = tokio::process::Command::from(create_command("gh"));
    gh_cmd.args(["auth", "status"]);
    gh_cmd.env("PATH", get_extended_path());
    // Only pin GH_CONFIG_DIR for isolated workspaces; the Default workspace must
    // let `gh` find its own native config (see get_env_vars_for_account) or this
    // status read reports "not connected" even when the user is logged in.
    if id != DEFAULT_ACCOUNT_ID {
        gh_cmd.env("GH_CONFIG_DIR", gh_config_dir(&id));
    }
    let github_auth_email = match run_with_timeout(gh_cmd, "gh auth status", 10).await {
        Ok(output) => parse_gh_auth_status(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(_) => None,
    };

    // Vercel identity, resolved the same way setup/status.rs does: verify the
    // workspace's injected token via `vercel whoami`. The Default workspace
    // (no injected token) falls back to the machine's native CLI session.
    let vercel_username = {
        let token = get_env_vars_for_account(&id).remove("VERCEL_TOKEN");
        if token.is_some() || id == DEFAULT_ACCOUNT_ID {
            match find_binary_by_name("vercel") {
                Some(p) => crate::commands::setup::vercel_whoami(&p, token.as_deref()).await,
                None => None,
            }
        } else {
            // Non-default workspace without a token → not connected for Vercel.
            None
        }
    };

    // Presence of each credential, three-way: one the Keychain couldn't
    // answer for is reported as such, not as "not set".
    let mut keychain_unavailable = claude.state == ClaudeConnState::KeychainUnavailable;
    let mut has = |key: &str| match read_from_keychain_checked(&id, key) {
        crate::keychain::Read::Found(_) => true,
        crate::keychain::Read::NotFound => false,
        crate::keychain::Read::Error(_) => {
            keychain_unavailable = true;
            false
        }
    };
    let has_anthropic_base_url = has("anthropic_base_url");
    let has_vercel_token = has("vercel_token");
    let has_cloudflare_api_token = has("cloudflare_api_token");
    let has_netlify_auth_token = has("netlify_auth_token");
    let has_git_name = has("git_name");
    let has_git_email = has("git_email");

    Ok(AccountCredentialStatus {
        claude_auth_email,
        codex_auth_email,
        opencode_auth_email,
        github_auth_email,
        vercel_username,
        has_anthropic_base_url,
        has_vercel_token,
        has_cloudflare_api_token,
        has_netlify_auth_token,
        has_git_name,
        has_git_email,
        keychain_unavailable,
    })
}

// NOTE: there is deliberately no Tauri command that returns a Workspace's env
// vars to the frontend. Those maps contain real secret token values
// (Vercel/Figma/OpenAI/Anthropic-base-url) and must never cross the IPC
// boundary into the webview. PTYs get the right Workspace env injected
// server-side in `pty/spawn.rs` and `pty_session.rs` via the internal
// `get_env_vars_for_project` / `get_env_vars_for_active_account` helpers.

/// Reject any credential key not on the allowlist. Both set and clear funnel
/// through this so the frontend can't probe or delete arbitrary keychain items
/// under this account's service name.
fn validate_credential_key(key: &str) -> Result<(), CommandError> {
    if ALL_CRED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "key".into(),
            reason: format!("Unknown credential key '{key}'"),
        })
    }
}

/// Store a credential in the keychain for an account.
///
/// Allowed keys: `anthropic_base_url`, `vercel_token`, `git_name`, `git_email`
#[tauri::command]
#[tracing::instrument(skip(value))]
pub fn set_account_credential(id: String, key: String, value: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    validate_credential_key(&key)?;
    if value.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "value".into(),
            reason: "Credential value cannot be empty".into(),
        });
    }
    write_to_keychain(&id, &key, value.trim())?;
    if key == "vercel_token" {
        crate::commands::setup::invalidate_vercel_whoami_cache();
    }
    Ok(())
}

/// Remove a credential from the keychain for an account.
#[tauri::command]
#[tracing::instrument]
pub fn clear_account_credential(id: String, key: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    validate_credential_key(&key)?;
    delete_from_keychain(&id, &key);
    if key == "vercel_token" {
        crate::commands::setup::invalidate_vercel_whoami_cache();
    }
    Ok(())
}

// ============ Sign-in terminals (backend-owned PTY) ============
//
// A CLI's own sign-in (`claude auth login`, `codex login`, `gh auth login`,
// `opencode auth login`) run in a real pseudo-terminal under the account's
// isolated env, so the login lands in the account's own config folder. The
// backend streams the terminal to the webview and takes keystrokes (the code
// `claude auth login` asks to have pasted back when the browser can't call it
// back). Nothing is scraped: the CLI keeps its own login.

/// One in-flight sign-in PTY, keyed by a frontend-supplied session id.
struct ConnectSession {
    writer: Mutex<Box<dyn Write + Send>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
}

static CONNECT_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<ConnectSession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Disconnect a workspace's Claude login: clears its captured token, email, and
/// expiry. The workspace's terminals fall back to no injected token (logged out).
#[tauri::command]
#[tracing::instrument]
pub fn disconnect_claude_account(id: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace's Claude login isn't managed by the app; \
                     run `claude` and use /logout there instead."
                .into(),
        });
    }
    clear_claude_token(&id);
    forget_claude_folder_sign_in(&id);
    Ok(())
}

/// `claude auth logout` as an isolated account's own folder (bounded, best
/// effort), so Claude Code removes the login it keeps for it. Runs on its own
/// thread with its own runtime, so it is safe to call from anywhere.
fn claude_folder_sign_out(account_id: &str) {
    let Some(binary) = find_binary_by_name("claude") else {
        return;
    };
    let mut cmd = create_command(binary);
    cmd.args(["auth", "logout"])
        .env("PATH", get_extended_path())
        .env("CLAUDE_CONFIG_DIR", claude_config_dir(account_id));
    for var in CLAUDE_LOGIN_OVERRIDES {
        cmd.env_remove(var);
    }
    let done = std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            let _ = rt.block_on(run_with_timeout(
                tokio::process::Command::from(cmd),
                "claude auth logout",
                15,
            ));
        }
    });
    let _ = done.join();
}

/// Forget that an isolated account signed in to Claude Code in its folder
/// (its login itself is Claude Code's: `claude auth logout` there removes it).
fn forget_claude_folder_sign_in(account_id: &str) {
    if account_id == DEFAULT_ACCOUNT_ID || validate_account_id(account_id).is_err() {
        return;
    }
    let marker = account_config_root(account_id)
        .join("claude")
        .join(CLAUDE_FOLDER_LOGIN_MARKER);
    let _ = std::fs::remove_file(marker);
}

// ── Per-account login PTY (Claude Code / GitHub / Codex / Opencode) ──────────
//
// Every login here is *config-dir* based: running the CLI's own login under
// the account's injected `CLAUDE_CONFIG_DIR` / `GH_CONFIG_DIR` / `CODEX_HOME` /
// `XDG_DATA_HOME` keeps the credentials in that account's own place (for
// Claude Code, its Keychain item for that folder). Output streams verbatim —
// there's no secret in it — and process exit is the completion signal. For
// Claude Code an exit 0 counts only once `claude auth status` as that folder
// says it is signed in (`finish_claude_folder_sign_in`).

/// A login service that authenticates by writing into a per-workspace config dir.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectService {
    Claude,
    Github,
    Codex,
    Opencode,
}

impl ConnectService {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "github" => Some(Self::Github),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            _ => None,
        }
    }

    /// The CLI binary name to look up on PATH.
    fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Github => "gh",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }

    /// Login subcommand args for the binary.
    fn args(self) -> &'static [&'static str] {
        match self {
            // `--web` uses the device flow (prints a one-time code + opens the
            // browser); `--git-protocol https` skips the protocol prompt.
            Self::Github => &["auth", "login", "--web", "--git-protocol", "https"],
            // Claude Code's own sign-in, the same command the first sign-in
            // runs (`TERMINAL_COMMANDS.claude_auth`).
            Self::Claude => &["auth", "login"],
            Self::Codex => &["login"],
            Self::Opencode => &["auth", "login"],
        }
    }

    /// Whether this service's CLI pauses on a "Press Enter to open…" prompt that
    /// we can auto-advance so the browser opens without a manual keystroke.
    fn auto_enter(self) -> bool {
        matches!(self, Self::Github)
    }
}

/// Emit a chunk of PTY output to the webview for a workspace-connect session.
fn emit_workspace_connect_data(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    let _ = app.emit(
        "workspace-connect-data",
        serde_json::json!({ "sessionId": session_id, "data": bytes }),
    );
}

/// Start an interactive GitHub/Codex/Opencode login for a workspace in a
/// backend-owned PTY.
///
/// Spawns the service's login CLI under the workspace's isolated env (so the
/// credentials land in the workspace's config dir, never the global one).
/// Output streams to the webview via `workspace-connect-data`; the user types
/// into it via [`workspace_connect_write`]. There is no token to capture — the
/// CLI writes its own credential files — so completion is signalled purely by
/// `workspace-connect-exit` when the process ends. For GitHub we watch for the
/// "Press Enter to open…" prompt and send Enter once so the browser opens
/// immediately.
#[tauri::command]
#[tracing::instrument(skip(app), fields(session_id = %session_id, id = %id, service = %service))]
pub fn workspace_connect_start(
    app: AppHandle,
    session_id: String,
    id: String,
    service: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    validate_account_id(&session_id)?;
    let svc = ConnectService::parse(&service).ok_or_else(|| CommandError::Validation {
        field: "service".into(),
        reason: format!("unknown connect service '{service}'"),
    })?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace uses your machine's native logins; \
                     run the CLI's login command in a terminal instead of connecting."
                .into(),
        });
    }

    let binary = find_binary_by_name(svc.binary()).ok_or_else(|| CommandError::Io {
        message: format!(
            "{} CLI not found. Install it first, then connect.",
            svc.binary()
        ),
    })?;
    // An older Claude Code keeps one login for every folder: signing in here
    // would sign this Mac's own Claude Code in as this account.
    if svc == ConnectService::Claude && !claude_logs_in_per_folder(&binary) {
        return Err(CommandError::expected(
            "Update Claude Code first: this version keeps one sign-in for the whole Mac, \
             so signing in another account would replace yours.",
        ));
    }

    // Idempotent: a live session under this id means connect is already running.
    {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        if map.contains_key(&session_id) {
            return Ok(());
        }
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(crate::commands::pty_session::openpty_error)?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    let mut cmd = CommandBuilder::new(&binary);
    for arg in svc.args() {
        cmd.arg(arg);
    }
    cmd.cwd(dirs::home_dir().unwrap_or_default());
    cmd.env("PATH", get_extended_path());
    cmd.env("TERM", "xterm-256color");
    // Run inside the workspace's isolated env so the login writes into the
    // workspace's config dir (CLAUDE_CONFIG_DIR / GH_CONFIG_DIR / CODEX_HOME /
    // XDG_DATA_HOME).
    let mut env = get_env_vars_for_account(&id);
    if svc == ConnectService::Claude {
        // Claude Code's own login for this folder, nothing else: no token
        // from before, no other secure-storage folder (inherited or set).
        for var in CLAUDE_LOGIN_OVERRIDES {
            env.remove(*var);
            cmd.env_remove(var);
        }
    }
    for (k, v) in env {
        cmd.env(k, v);
    }

    // Labeled + retried on transient EAGAIN; a persistent one is classified
    // Expected instead of a bare "spawn_command: os error 35" (issue #587).
    let login_label = format!("{} login", svc.binary());
    let mut child = crate::external_command::retry_spawn_on_pressure(&login_label, || {
        pair.slave.spawn_command(cmd.clone())
    })
    .map_err(|e| {
        let message = format!("spawn_command `{login_label}`: {e}");
        if crate::external_command::is_spawn_resource_pressure(&message) {
            crate::external_command::spawn_resource_pressure_error(&login_label)
        } else {
            CommandError::from(message)
        }
    })?;
    let child_killer = child.clone_killer();

    let session = Arc::new(ConnectSession {
        writer: Mutex::new(writer),
        child_killer: Mutex::new(child_killer),
        master: Mutex::new(pair.master),
    });
    CONNECT_REGISTRY
        .lock()
        .map_err(|e| format!("connect registry poisoned: {e}"))?
        .insert(session_id.clone(), session.clone());

    // Reader thread: stream output verbatim. For GitHub, auto-send Enter once we
    // see the "Press Enter to open…" prompt so the browser launches itself.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        let session = session.clone();
        let auto_enter = svc.auto_enter();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut sent_enter = false;
            // Small rolling window so the prompt is matched even when it straddles
            // a read boundary.
            let mut tail: Vec<u8> = Vec::new();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                emit_workspace_connect_data(&app, &session_id, &buf[..n]);
                if auto_enter && !sent_enter {
                    tail.extend_from_slice(&buf[..n]);
                    let hay = String::from_utf8_lossy(&tail).to_lowercase();
                    if hay.contains("press enter") {
                        if let Ok(mut w) = session.writer.lock() {
                            let _ = w.write_all(b"\r");
                        }
                        sent_enter = true;
                        tail.clear();
                    } else if tail.len() > 4096 {
                        // Bound the window; keep only the most recent bytes.
                        let keep = tail.len() - 2048;
                        tail.drain(..keep);
                    }
                }
            }
        });
    }

    // Waiter thread: reaps the child, drops the registry entry, signals exit.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        let is_github = matches!(svc, ConnectService::Github);
        let is_claude = matches!(svc, ConnectService::Claude);
        let account_id = id.clone();
        std::thread::spawn(move || {
            let mut code = match child.wait() {
                Ok(status) if status.success() => 0,
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            // Claude Code said it signed in: done only once its folder says so.
            if is_claude && code == 0 {
                let confirmed = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map(|rt| rt.block_on(finish_claude_folder_sign_in(&account_id)))
                    .unwrap_or(false);
                if !confirmed {
                    let msg = "\r\n\x1b[31mClaude Code finished, but this account doesn't \
                               show as signed in. Start over to try again.\x1b[0m\r\n";
                    emit_workspace_connect_data(&app, &session_id, msg.as_bytes());
                    code = 1;
                }
            }
            if let Ok(mut map) = CONNECT_REGISTRY.lock() {
                map.remove(&session_id);
            }
            // A GitHub login just finished — the identity for this workspace may
            // have changed without an active-account switch, so drop any cached
            // username (keyed per-workspace) to avoid showing a stale owner.
            if is_github {
                crate::commands::github::invalidate_github_username_cache();
            }
            let _ = app.emit(
                "workspace-connect-exit",
                serde_json::json!({ "sessionId": session_id, "exitCode": code }),
            );
        });
    }

    Ok(())
}

/// Forward keystrokes to a workspace-connect PTY.
#[tauri::command]
#[tracing::instrument(skip(data))]
pub fn workspace_connect_write(session_id: String, data: Vec<u8>) -> Result<(), CommandError> {
    let session = {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        // A keystroke/resize can land after the connect PTY exited (the waiter
        // thread pruned the registry) or after the modal was closed — a benign,
        // expected race the frontend already ignores, not a bug (issue #563).
        return Err(CommandError::expected("unknown connect session"));
    };
    let mut w = session
        .writer
        .lock()
        .map_err(|e| format!("writer lock poisoned: {e}"))?;
    w.write_all(&data).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Resize a workspace-connect PTY to match the on-screen terminal.
#[tauri::command]
#[tracing::instrument]
pub fn workspace_connect_resize(
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let session = {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        // A keystroke/resize can land after the connect PTY exited (the waiter
        // thread pruned the registry) or after the modal was closed — a benign,
        // expected race the frontend already ignores, not a bug (issue #563).
        return Err(CommandError::expected("unknown connect session"));
    };
    let master = session
        .master
        .lock()
        .map_err(|e| format!("master lock poisoned: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

/// Kill a workspace-connect PTY and drop its registry entry. Idempotent.
#[tauri::command]
#[tracing::instrument]
pub fn workspace_connect_close(session_id: String) -> Result<(), CommandError> {
    let session = {
        let mut map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        map.remove(&session_id)
    };
    if let Some(session) = session {
        if let Ok(mut killer) = session.child_killer.lock() {
            let _ = killer.kill();
        }
    }
    Ok(())
}

/// Sign a workspace out of a config-dir login (Claude Code / GitHub / Codex / Opencode) by
/// running the CLI's logout under the workspace's isolated env. Best-effort:
/// returns the captured output for surfacing, but a non-zero exit (already
/// logged out) is not treated as an error.
#[tauri::command]
#[tracing::instrument]
pub fn workspace_disconnect_service(id: String, service: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    let svc = ConnectService::parse(&service).ok_or_else(|| CommandError::Validation {
        field: "service".into(),
        reason: format!("unknown connect service '{service}'"),
    })?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace uses your machine's native logins; \
                     sign out with the CLI directly."
                .into(),
        });
    }
    let binary = find_binary_by_name(svc.binary()).ok_or_else(|| CommandError::Io {
        message: format!("{} CLI not found.", svc.binary()),
    })?;
    let logout_args: &[&str] = match svc {
        ConnectService::Github => &["auth", "logout", "--hostname", "github.com"],
        ConnectService::Codex => &["logout"],
        ConnectService::Opencode => &["auth", "logout"],
        ConnectService::Claude => &["auth", "logout"],
    };
    let mut command = std::process::Command::new(&binary);
    command.args(logout_args);
    command.env("PATH", get_extended_path());
    let mut env = get_env_vars_for_account(&id);
    if svc == ConnectService::Claude {
        forget_claude_folder_sign_in(&id);
        for var in CLAUDE_LOGIN_OVERRIDES {
            env.remove(*var);
            command.env_remove(var);
        }
    }
    for (k, v) in env {
        command.env(k, v);
    }
    // Best-effort: failures (e.g. "not logged in") are fine.
    let _ = command.output();
    // Logging out changes this workspace's GitHub identity — drop any cached
    // username so a subsequent lookup doesn't return the signed-out account.
    if matches!(svc, ConnectService::Github) {
        crate::commands::github::invalidate_github_username_cache();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_uses_prefix() {
        let slug = crate::brand::SLUG;
        assert_eq!(
            keychain_service("default"),
            format!("{slug}-account-default")
        );
        assert_eq!(
            keychain_service("abc-123"),
            format!("{slug}-account-abc-123")
        );
    }

    #[test]
    fn get_env_vars_injects_config_dirs_for_isolated_workspaces() {
        // A non-default workspace must override the CLI config/data dirs so its
        // logins stay isolated from the global ones.
        let vars = get_env_vars_for_account("nonexistent-account-xyz-test");
        assert!(vars.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(vars.contains_key("GH_CONFIG_DIR"));
        assert!(vars.contains_key("CODEX_HOME"));
        assert!(vars.contains_key("XDG_DATA_HOME"));
        // No credentials stored for this account, so no token vars. Claude's
        // per-workspace token is only injected once the workspace connects.
        assert!(!vars.contains_key("VERCEL_TOKEN"));
        assert!(!vars.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    #[test]
    fn get_env_vars_omits_config_dirs_for_default_workspace() {
        // Regression (GitHub auth loop on Windows + some Macs): forcing these on
        // the Default workspace pointed gh/opencode at a dir the token wasn't in,
        // so status reads found no login and the connect button looped. The
        // Default workspace must let each tool resolve its own native location.
        let vars = get_env_vars_for_account(DEFAULT_ACCOUNT_ID);
        assert!(!vars.contains_key("GH_CONFIG_DIR"));
        assert!(!vars.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(!vars.contains_key("CODEX_HOME"));
        assert!(!vars.contains_key("XDG_DATA_HOME"));
        // The Default workspace uses Claude's native keychain login, never an
        // injected token — injecting one would override the user's real login.
        assert!(!vars.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    #[test]
    fn connect_service_parses_known_services_only() {
        assert_eq!(
            ConnectService::parse("github"),
            Some(ConnectService::Github)
        );
        assert_eq!(ConnectService::parse("codex"), Some(ConnectService::Codex));
        assert_eq!(
            ConnectService::parse("opencode"),
            Some(ConnectService::Opencode)
        );
        assert_eq!(
            ConnectService::parse("claude"),
            Some(ConnectService::Claude)
        );
        assert_eq!(ConnectService::parse("vercel"), None);
        assert_eq!(ConnectService::parse(""), None);
    }

    #[test]
    fn connect_service_only_github_auto_enters() {
        // Only GitHub's device flow pauses on a "Press Enter to open…" prompt.
        assert!(ConnectService::Github.auto_enter());
        assert!(!ConnectService::Codex.auto_enter());
        assert!(!ConnectService::Opencode.auto_enter());
        assert!(!ConnectService::Claude.auto_enter());
    }

    #[test]
    fn claude_signs_in_with_its_own_login_never_a_setup_token() {
        // The same command the first sign-in runs; nothing is captured.
        assert_eq!(ConnectService::Claude.binary(), "claude");
        assert_eq!(ConnectService::Claude.args(), &["auth", "login"]);
        assert!(CLAUDE_LOGIN_OVERRIDES.contains(&"CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(CLAUDE_LOGIN_OVERRIDES.contains(&"CLAUDE_SECURESTORAGE_CONFIG_DIR"));
    }

    #[test]
    fn only_a_claude_code_that_keeps_a_login_per_folder_signs_in_here() {
        let since = CLAUDE_PER_FOLDER_LOGIN_SINCE;
        assert!(claude_version_at_least("2.1.323 (Claude Code)", since));
        assert!(claude_version_at_least("2.1.318 (Claude Code)", since));
        assert!(claude_version_at_least("2.2.0 (Claude Code)", since));
        assert!(claude_version_at_least("3.0.0", since));
        assert!(!claude_version_at_least("2.1.317 (Claude Code)", since));
        assert!(!claude_version_at_least("1.9.999 (Claude Code)", since));
        assert!(!claude_version_at_least("Claude Code", since));
        assert!(!claude_version_at_least("", since));
    }

    #[test]
    fn a_confirmed_folder_sign_in_replaces_the_old_token() {
        let id = "folder-login-test-0b5e";
        assert!(!claude_folder_signed_in(id));
        let marker = claude_config_dir(id).join(CLAUDE_FOLDER_LOGIN_MARKER);
        std::fs::write(&marker, "1").unwrap();
        assert!(claude_folder_signed_in(id));
        // Signed in in its folder: no token is handed to anything.
        assert!(claude_token_for(id).is_none());
        assert!(!get_env_vars_for_account(id).contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        forget_claude_folder_sign_in(id);
        assert!(!claude_folder_signed_in(id));
        let _ = std::fs::remove_dir_all(account_config_root(id));
        // Never for the Default account or a bad id.
        assert!(!claude_folder_signed_in(DEFAULT_ACCOUNT_ID));
        assert!(!claude_folder_signed_in("../x"));
    }

    #[test]
    fn connect_service_uses_isolated_login_commands() {
        assert_eq!(ConnectService::Github.binary(), "gh");
        assert!(ConnectService::Github
            .args()
            .starts_with(&["auth", "login"]));
        assert_eq!(ConnectService::Codex.binary(), "codex");
        assert_eq!(ConnectService::Codex.args(), &["login"]);
        assert_eq!(ConnectService::Opencode.binary(), "opencode");
        assert_eq!(ConnectService::Opencode.args(), &["auth", "login"]);
    }

    #[test]
    fn workspace_disconnect_rejects_default_and_unknown_service() {
        // Unknown service is rejected before anything is run.
        assert!(workspace_disconnect_service("some-workspace".into(), "bogus".into()).is_err());
        // The Default workspace's native logins aren't managed here.
        assert!(workspace_disconnect_service(DEFAULT_ACCOUNT_ID.into(), "github".into()).is_err());
    }

    #[test]
    fn parse_claude_auth_status_reads_email_and_logged_in() {
        // The shape `claude auth status` returns for a native claude.ai login.
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.com"}"#;
        assert_eq!(
            parse_claude_auth_status(json),
            Some((true, Some("a@b.com".into())))
        );

        // Token-auth shape has no email — must not invent one.
        let token_shape = r#"{"loggedIn":true,"authMethod":"oauth_token"}"#;
        assert_eq!(parse_claude_auth_status(token_shape), Some((true, None)));

        // A definitive logged-out answer is still an answer.
        let logged_out = r#"{"loggedIn":false}"#;
        assert_eq!(parse_claude_auth_status(logged_out), Some((false, None)));
    }

    #[test]
    fn parse_claude_auth_status_returns_none_when_cli_cannot_answer() {
        // Non-JSON (e.g. an older CLI without `auth status`) / empty output is
        // NOT a definitive "logged out" — callers fall back to weaker signals.
        assert_eq!(parse_claude_auth_status("not json"), None);
        assert_eq!(parse_claude_auth_status(""), None);
        assert_eq!(parse_claude_auth_status(r#"Unknown command "auth""#), None);
        // JSON without a loggedIn bool is equally non-definitive.
        assert_eq!(parse_claude_auth_status(r#"{"email":"a@b.com"}"#), None);
        assert_eq!(parse_claude_auth_status(r#"{"loggedIn":"yes"}"#), None);
    }

    #[test]
    fn should_inject_claude_token_skips_expired_tokens() {
        let now = 1_750_000_000_u64;
        // Valid (expiry in the future) → inject.
        assert!(should_inject_claude_token(Some(now + 1), now));
        // Expired → never inject: CLAUDE_CODE_OAUTH_TOKEN would override an
        // interactive /login inside the terminal with a dead token (#159).
        assert!(!should_inject_claude_token(Some(now - 1), now));
        // Exactly at expiry counts as expired (mirrors the old `now >= exp`).
        assert!(!should_inject_claude_token(Some(now), now));
    }

    #[test]
    fn should_inject_claude_token_gives_benefit_of_the_doubt_without_expiry() {
        // Older connects recorded no expiry — inject rather than silently
        // logging every terminal out (matches resolve_claude_identity).
        assert!(should_inject_claude_token(None, 1_750_000_000));
    }

    #[test]
    fn managed_cred_keys_are_not_frontend_settable() {
        // claude_oauth_token / claude_email are backend-managed: the frontend
        // must not be able to write or probe them via set/clear_account_credential.
        for key in MANAGED_CRED_KEYS {
            assert!(
                validate_credential_key(key).is_err(),
                "managed key {key:?} must be rejected by the frontend credential allowlist"
            );
        }
    }

    #[test]
    fn get_env_vars_falls_back_to_default_for_invalid_id() {
        // An invalid id falls back to Default, which (post-fix) injects no config
        // dirs — so a tampered id can't smuggle in a forced GH_CONFIG_DIR either.
        let vars = get_env_vars_for_account("../../etc");
        assert!(!vars.contains_key("GH_CONFIG_DIR"));
    }

    #[test]
    fn parse_gh_auth_status_extracts_username() {
        // Old gh phrasing ("... as <user>"), no "Active account" marker.
        let old = "github.com\n  Logged in to github.com as octocat (oauth_token)\n";
        assert_eq!(parse_gh_auth_status(old, ""), Some("octocat".to_string()));

        // New gh phrasing (~v2.40+: "... account <user>"), with the ✓ glyph.
        let new = "github.com\n  ✓ Logged in to github.com account sam-work (keyring)\n  - Active account: true\n";
        assert_eq!(parse_gh_auth_status(new, ""), Some("sam-work".to_string()));
    }

    #[test]
    fn parse_gh_auth_status_returns_none_when_not_logged_in() {
        assert_eq!(
            parse_gh_auth_status("", "You are not logged into any GitHub hosts."),
            None
        );
    }

    #[test]
    fn parse_gh_auth_status_finds_active_login_despite_failed_second_account() {
        // Regression (grey GitHub button / connect loop): `gh auth status` exits
        // NON-ZERO when any configured account has an invalid token, even though a
        // different account is logged in and active. We must report the user as
        // connected by reading the ✓ active login, not the exit code — and the
        // "X Failed to log in" line must NOT be mistaken for a login.
        let out = "github.com\n  \u{2713} Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Token scopes: 'gist', 'read:org', 'repo'\n\n  X Failed to log in to github.com account hubot (keyring)\n  - Active account: false\n  - The token in keyring is invalid.\n";
        assert_eq!(parse_gh_auth_status(out, ""), Some("octocat".to_string()));
    }

    #[test]
    fn parse_gh_auth_status_reports_disconnected_when_active_account_invalid() {
        // Inverse edge: the *active* account's token is invalid while a different
        // (non-active) account is still valid. gh operations run as the active
        // account, so this must report "not connected" rather than a false green.
        let out = "github.com\n  X Failed to log in to github.com account broken-active (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n\n  \u{2713} Logged in to github.com account good-inactive (keyring)\n  - Active account: false\n";
        assert_eq!(parse_gh_auth_status(out, ""), None);
    }

    /// Issue #922: on a platform with no vault, a credential save must say so
    /// rather than reporting that a macOS binary is missing.
    #[test]
    fn the_vault_refusal_names_the_limitation_and_is_not_a_bug() {
        let err = keychain_unsupported();
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("this platform"), "got: {msg}");
        assert!(msg.contains("default workspace"), "got: {msg}");
        // Nothing about a missing program: that was the old message, and it
        // sent people looking for something to install.
        assert!(!msg.contains("program not found"), "got: {msg}");
    }

    /// And on a platform without one, reads answer "nothing stored" rather
    /// than spawning a binary that isn't there — this runs on every PTY spawn
    /// for a non-default workspace.
    #[test]
    fn reads_are_silent_where_there_is_no_vault() {
        if KEYCHAIN_SUPPORTED {
            return;
        }
        assert_eq!(read_from_keychain("some-workspace", "VERCEL_TOKEN"), None);
    }

    #[test]
    fn validate_account_id_accepts_default_and_uuids() {
        assert!(validate_account_id("default").is_ok());
        assert!(validate_account_id("bd2a40a3-268d-4242-a350-fa720de78dd7").is_ok());
    }

    #[test]
    fn validate_account_id_rejects_traversal_and_injection() {
        for bad in [
            "",
            "..",
            "../../etc",
            "a/b",
            "a\\b",
            "foo/../bar",
            ".",
            "id with space",
            "name;rm -rf",
        ] {
            assert!(
                validate_account_id(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn validate_account_id_rejects_overlong() {
        let long = "a".repeat(65);
        assert!(validate_account_id(&long).is_err());
    }
}
