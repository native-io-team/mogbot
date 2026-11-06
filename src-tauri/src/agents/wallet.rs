//! Usage wallets: more than one account per engine, so an agent keeps
//! working when one subscription's usage limit is reached.
//!
//! An engine's accounts are an ordered list (the order is the priority).
//! The first is always **this Mac's own sign-in** (`id == "default"`): the
//! `claude` / `codex` login the user already has, which every turn used
//! before wallets existed and still uses while it is the only one. Each
//! account added here is signed in into a folder of its own, with the
//! isolation `commands::accounts` already had for workspaces:
//!
//! - Claude Code: `CLAUDE_CONFIG_DIR=~/.<slug>/accounts/<id>/claude`, plus
//!   the long-lived token `claude setup-token` printed (captured in Rust,
//!   kept in the Keychain) as `CLAUDE_CODE_OAUTH_TOKEN`. The config dir
//!   alone doesn't separate logins on macOS, because Claude Code's own
//!   Keychain entry is shared (see `accounts::get_env_vars_for_account`).
//! - Codex: `CODEX_HOME=~/.<slug>/accounts/<id>/codex`, signed in by
//!   `codex login` run there (its `auth.json`).
//!
//! **Failover** (`runner::run_on_accounts`). A turn runs on the first account
//! that is signed in and not marked out. A turn that ends on the usage limit
//! marks its account out until the reset the engine reported (its
//! `rate_limit_event` / rate-limit snapshot, or the time in its message);
//! with no reset reported, out for [`UNKNOWN_OUT_MS`] and then tried again.
//! The turn then runs again on the next account, at most
//! [`MAX_SWITCHES`] times, with a quiet line in the chat saying so. When
//! none is left the turn ends on one line naming the earliest reported
//! reset; never silently.
//!
//! **The conversation carries over.** Each engine keeps its transcript in
//! its own folder (`<config>/projects/<cwd folder>/<session>.jsonl`;
//! `<codex home>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`), which is
//! per account. Before a turn resumes a session on an account, the newest
//! copy of that transcript found in any of the engine's account folders is
//! copied into this one ([`carry_session`]), so `--resume` / `thread/resume`
//! finds the same conversation. If the engine still can't find it, the
//! runner's existing fallback starts a new session with the recent
//! conversation (`with_recap`), as it does for any lost session.
//!
//! **What the engines share.** An added account's folder gets links to this
//! Mac's own settings, instructions and skills ([`SHARED`]), so an agent
//! behaves the same on every account. Not its login, history or user-level
//! state: Claude Code's `.claude.json` (which holds the signed-in account and
//! the user's own MCP servers) is per account, so MCP servers added with
//! `claude mcp add --scope user` are only on this Mac's own sign-in.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::engine::Engine;
use crate::commands::accounts::{self, DEFAULT_ACCOUNT_ID};
use crate::errors::CommandError;

/// This Mac's own sign-in, as an account in the list.
pub const THIS_MAC: &str = DEFAULT_ACCOUNT_ID;

/// A limit with no reset reported keeps its account out this long, then it
/// is tried again (a failed try costs one quick refusal, and re-marks it).
pub const UNKNOWN_OUT_MS: i64 = 60 * 60 * 1000;

/// At most this many switches in one turn, however many accounts there are.
pub const MAX_SWITCHES: usize = 4;

/// Names of accounts are short labels.
const NAME_MAX: usize = 40;

/// What an added account's folder links to in this Mac's own one.
const SHARED: &[(Engine, &[&str])] = &[
    (
        Engine::Claude,
        &[
            "settings.json",
            "CLAUDE.md",
            "agents",
            "commands",
            "skills",
            "plugins",
        ],
    ),
    (
        Engine::Codex,
        &[
            "config.toml",
            "AGENTS.md",
            "prompts",
            "skills",
            "models_cache.json",
        ],
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitHit {
    /// When the turn on this account ended on the usage limit, epoch ms.
    pub at: i64,
    /// When the engine said it resets, epoch ms. `None`: it didn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub engine: Engine,
    pub name: String,
    #[serde(default)]
    pub added_at: i64,
    /// The last time a turn on it ended on the usage limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<LimitHit>,
}

impl Account {
    pub fn is_this_mac(&self) -> bool {
        self.id == THIS_MAC
    }

    /// Until when it is out, if it is now: the reported reset, or for a
    /// limit with none, [`UNKNOWN_OUT_MS`] after it was hit (`Some(None)`
    /// says the reset isn't known).
    pub fn out(&self, now: i64) -> Option<Option<i64>> {
        let hit = self.limit.as_ref()?;
        match hit.resets_at {
            Some(at) if at > now => Some(Some(at)),
            Some(_) => None,
            None if now - hit.at < UNKNOWN_OUT_MS => Some(None),
            None => None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletFile {
    #[serde(default)]
    accounts: Vec<Account>,
    /// Which account each agent's last turn ran on (`engine:id`), so the
    /// chat can say when that changed.
    #[serde(default)]
    last_used: BTreeMap<String, String>,
    /// Which account each engine's plan reading (`quota.json`) came from.
    #[serde(default)]
    quota_from: BTreeMap<String, String>,
}

fn this_mac(engine: Engine) -> Account {
    Account {
        id: THIS_MAC.to_string(),
        engine,
        name: "This Mac".to_string(),
        added_at: 0,
        limit: None,
    }
}

impl WalletFile {
    /// Every engine has this Mac's own sign-in, first unless moved.
    fn normalized(mut self) -> Self {
        for engine in Engine::ALL {
            if !self
                .accounts
                .iter()
                .any(|a| a.engine == engine && a.is_this_mac())
            {
                let at = self
                    .accounts
                    .iter()
                    .position(|a| a.engine == engine)
                    .unwrap_or(self.accounts.len());
                self.accounts.insert(at, this_mac(engine));
            }
        }
        // An id is one account; a hand-edited duplicate is dropped.
        let mut seen = std::collections::HashSet::new();
        self.accounts
            .retain(|a| seen.insert((a.engine, a.id.clone())) && valid_id(&a.id));
        self
    }

    fn of(&self, engine: Engine) -> impl Iterator<Item = &Account> {
        self.accounts.iter().filter(move |a| a.engine == engine)
    }

    fn find_mut(&mut self, engine: Engine, id: &str) -> Option<&mut Account> {
        self.accounts
            .iter_mut()
            .find(|a| a.engine == engine && a.id == id)
    }
}

fn valid_id(id: &str) -> bool {
    accounts::validate_account_id(id).is_ok()
}

fn key(engine: Engine, id: &str) -> String {
    format!("{}:{id}", engine_word(engine))
}

fn engine_word(engine: Engine) -> &'static str {
    match engine {
        Engine::Claude => "claude",
        Engine::Codex => "codex",
    }
}

/* --------------------------------------------------------------- disk */

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<PathBuf, CommandError> {
    Ok(super::store::agents_root()?.join("wallet.json"))
}

fn read() -> WalletFile {
    path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<WalletFile>(&raw).ok())
        .unwrap_or_default()
        .normalized()
}

fn write(file: &WalletFile) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(file).map_err(super::err_other)?;
    super::store::write_atomic(&path()?, &json)
}

/// Read, change and write the wallet under its lock.
fn change<T>(
    f: impl FnOnce(&mut WalletFile) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read();
    let out = f(&mut file)?;
    write(&file)?;
    Ok(out)
}

/// Every account, each engine's in priority order.
pub fn list() -> Vec<Account> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read().accounts
}

/// One engine's accounts, in priority order.
pub fn of(engine: Engine) -> Vec<Account> {
    list().into_iter().filter(|a| a.engine == engine).collect()
}

fn clean_name(name: &str) -> Result<String, CommandError> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if name.is_empty() {
        return Err(super::err_invalid("name", "Give the account a name."));
    }
    Ok(name.chars().take(NAME_MAX).collect())
}

/// Add an account for an engine, last in its order. It isn't signed in yet:
/// the caller runs the sign-in into its folder next.
pub fn add(engine: Engine, name: &str) -> Result<Account, CommandError> {
    let name = clean_name(name)?;
    change(|file| {
        if file.of(engine).any(|a| a.name.eq_ignore_ascii_case(&name)) {
            return Err(super::err_invalid(
                "name",
                format!(
                    "There's already a {} account called {name}.",
                    engine.label()
                ),
            ));
        }
        let account = Account {
            id: super::store::new_id(),
            engine,
            name,
            added_at: super::store::now_ms(),
            limit: None,
        };
        let at = file
            .accounts
            .iter()
            .rposition(|a| a.engine == engine)
            .map_or(file.accounts.len(), |i| i + 1);
        file.accounts.insert(at, account.clone());
        Ok(account)
    })
}

pub fn rename(engine: Engine, id: &str, name: &str) -> Result<Account, CommandError> {
    let name = clean_name(name)?;
    change(|file| {
        if file
            .of(engine)
            .any(|a| a.id != id && a.name.eq_ignore_ascii_case(&name))
        {
            return Err(super::err_invalid(
                "name",
                format!(
                    "There's already a {} account called {name}.",
                    engine.label()
                ),
            ));
        }
        let account = file.find_mut(engine, id).ok_or_else(not_found)?;
        account.name = name;
        Ok(account.clone())
    })
}

/// Put an engine's accounts in this order. Every one of them must be named,
/// once; anything else is refused rather than guessed at.
pub fn reorder(engine: Engine, ids: &[String]) -> Result<Vec<Account>, CommandError> {
    change(|file| {
        let mut mine: Vec<Account> = file.of(engine).cloned().collect();
        let same = ids.len() == mine.len()
            && ids.iter().all(|id| mine.iter().any(|a| &a.id == id))
            && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len();
        if !same {
            return Err(super::err_invalid(
                "ids",
                "The list of accounts changed meanwhile. Try again.",
            ));
        }
        mine.sort_by_key(|a| ids.iter().position(|id| id == &a.id));
        // Keep the other engine's accounts where they are.
        let mut placed = mine.into_iter();
        for slot in file.accounts.iter_mut().filter(|a| a.engine == engine) {
            if let Some(next) = placed.next() {
                *slot = next;
            }
        }
        Ok(file.of(engine).cloned().collect())
    })
}

/// Remove an added account: from the list, and its sign-in (Keychain items
/// and its folder) from this Mac. This Mac's own sign-in isn't ours to remove.
pub fn remove(engine: Engine, id: &str) -> Result<(), CommandError> {
    if id == THIS_MAC {
        return Err(super::err_invalid(
            "id",
            "This Mac's own sign-in can't be removed here; move it down the list instead.",
        ));
    }
    change(|file| {
        let before = file.accounts.len();
        file.accounts
            .retain(|a| !(a.engine == engine && a.id == id));
        if file.accounts.len() == before {
            return Err(not_found());
        }
        let k = key(engine, id);
        file.last_used.retain(|_, v| *v != k);
        file.quota_from.retain(|_, v| *v != k);
        Ok(())
    })?;
    // Conversations that last ran there go on: their newest copies are kept
    // in this Mac's own folder before the account's folder goes.
    let gone = Account {
        id: id.to_string(),
        engine,
        name: String::new(),
        added_at: 0,
        limit: None,
    };
    let kept = keep_sessions(engine, &folder(&gone), &folder(&this_mac(engine)));
    tracing::info!("[Agents] kept {kept} conversation(s) from a removed account");
    accounts::forget_isolated_account(id);
    Ok(())
}

/// Every session in `from` carried into `into` where it is newer there.
pub fn keep_sessions(engine: Engine, from: &Path, into: &Path) -> usize {
    let roots = [from.to_path_buf(), into.to_path_buf()];
    let mut ids: Vec<String> = Vec::new();
    match engine {
        Engine::Claude => {
            for dir in std::fs::read_dir(from.join("projects"))
                .into_iter()
                .flatten()
                .flatten()
            {
                for file in std::fs::read_dir(dir.path())
                    .into_iter()
                    .flatten()
                    .flatten()
                {
                    let name = file.file_name().to_string_lossy().into_owned();
                    if let Some(id) = name.strip_suffix(".jsonl") {
                        ids.push(id.to_string());
                    }
                }
            }
        }
        Engine::Codex => {
            let mut dirs = vec![(from.join("sessions"), 0)];
            while let Some((dir, depth)) = dirs.pop() {
                for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if path.is_dir() && depth < 4 {
                        dirs.push((path, depth + 1));
                    } else if let Some(stem) = name.strip_suffix(".jsonl") {
                        if let Some(id) = rollout_session(stem) {
                            ids.push(id.to_string());
                        }
                    }
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids.iter()
        .filter(|id| valid_session(id))
        .filter(|id| {
            match engine {
                Engine::Claude => carry_claude(&roots, into, id),
                Engine::Codex => carry_codex(&roots, into, id),
            }
            .unwrap_or(false)
        })
        .count()
}

/// The session in a Codex file name's stem, `rollout-<time>-<uuid>`: its
/// last 36 bytes. Any file can sit in that folder, so a name where that cut
/// lands inside a character (`rollout-日本…`) is no session, never a panic.
pub(super) fn rollout_session(stem: &str) -> Option<&str> {
    if !stem.starts_with("rollout-") || stem.len() <= 36 {
        return None;
    }
    stem.get(stem.len() - 36..)
}

fn not_found() -> CommandError {
    CommandError::expected("That account isn't in the list any more.")
}

/// Mark an account out: a turn on it ended on the usage limit.
pub fn mark_out(engine: Engine, id: &str, resets_at: Option<i64>, now: i64) {
    let result = change(|file| {
        if let Some(a) = file.find_mut(engine, id) {
            a.limit = Some(LimitHit {
                at: now,
                resets_at: resets_at.filter(|&t| t > now),
            });
        }
        Ok(())
    });
    if let Err(e) = result {
        tracing::warn!("[Agents] usage limit for an account not saved: {e}");
    }
}

/// The engine reported, mid-turn, that the account's plan is used up until
/// `resets_at` (a window it said is `rejected` / reached). Recorded only when
/// it adds a reset to a limit already known, or there is none yet.
pub fn reported_out(engine: Engine, id: &str, resets_at: i64, now: i64) {
    if resets_at <= now {
        return;
    }
    let _ = change(|file| {
        if let Some(a) = file.find_mut(engine, id) {
            let known = a.limit.as_ref().and_then(|l| l.resets_at);
            if known != Some(resets_at) {
                a.limit = Some(LimitHit {
                    at: now,
                    resets_at: Some(resets_at),
                });
            }
        }
        Ok(())
    });
}

/// Before recording an engine's plan reading from `seat`: true when the
/// reading known came from another account, which the caller then clears
/// (a reading is one account's picture, never two mixed).
pub fn reading_moves_to(engine: Engine, id: &str) -> bool {
    change(|file| {
        let k = key(engine, id);
        let prev = file
            .quota_from
            .insert(engine_word(engine).to_string(), k.clone());
        Ok(prev.is_some_and(|p| p != k))
    })
    .unwrap_or(false)
}

/// Which account the engine's plan reading (`quota.json`) came from, when
/// that was recorded (it is from the first reading after wallets).
pub fn reading_from(engine: Engine) -> Option<String> {
    let file = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read()
    };
    let k = file.quota_from.get(engine_word(engine))?;
    k.split_once(':').map(|(_, id)| id.to_string())
}

/* ------------------------------------------------------------ choosing */

/// An account a turn can run on, and whether it is signed in.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub account: Account,
    pub signed_in: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    /// Run on this one.
    Run(Account),
    /// Every signed-in account is out; the earliest reset any reported.
    AllOut { earliest: Option<i64>, count: usize },
}

/// Which account the next try runs on: the first signed-in one, in order,
/// that isn't out and wasn't tried in this turn. With one account there is
/// nothing to choose: it runs, and the engine says whether it can.
pub fn choose(candidates: &[Candidate], tried: &[String], now: i64) -> Choice {
    let usable: Vec<&Candidate> = candidates.iter().filter(|c| c.signed_in).collect();
    if usable.len() <= 1 && tried.is_empty() {
        let only = usable
            .first()
            .map(|c| c.account.clone())
            .or_else(|| candidates.first().map(|c| c.account.clone()));
        if let Some(account) = only {
            return Choice::Run(account);
        }
    }
    if let Some(c) = usable
        .iter()
        .find(|c| !tried.contains(&c.account.id) && c.account.out(now).is_none())
    {
        return Choice::Run(c.account.clone());
    }
    let earliest = usable
        .iter()
        .filter_map(|c| c.account.out(now).flatten())
        .min();
    Choice::AllOut {
        earliest,
        count: usable.len(),
    }
}

/// Whether a signed-in account is there to switch to after `tried`.
pub fn can_switch(candidates: &[Candidate], tried: &[String], now: i64) -> bool {
    tried.len() <= MAX_SWITCHES
        && candidates
            .iter()
            .any(|c| c.signed_in && !tried.contains(&c.account.id) && c.account.out(now).is_none())
}

/// The engine's accounts with whether each is signed in, from what is on
/// this Mac (no network): this Mac's own sign-in as the engine check says;
/// an added Claude Code account by its stored token; an added Codex
/// account by the `auth.json` its sign-in wrote.
pub async fn candidates(engine: Engine) -> Vec<Candidate> {
    let mut out = Vec::new();
    for account in of(engine) {
        let signed_in = signed_in(&account).await;
        out.push(Candidate { account, signed_in });
    }
    out
}

pub async fn signed_in(account: &Account) -> bool {
    if account.is_this_mac() {
        return super::engine::signed_in_here(account.engine).await;
    }
    match account.engine {
        Engine::Claude => accounts::claude_token_for(&account.id).is_some(),
        Engine::Codex => accounts::codex_home_dir(&account.id)
            .join("auth.json")
            .is_file(),
    }
}

/// Any added account signed in (for whether the engine is ready at all).
pub async fn any_added_signed_in(engine: Engine) -> bool {
    for account in of(engine).iter().filter(|a| !a.is_this_mac()) {
        if signed_in(account).await {
            return true;
        }
    }
    false
}

/* ------------------------------------------------------------- the turn */

/// What a turn's process gets to run as `account`: nothing for this Mac's
/// own sign-in (the engine finds its own login, as always), else the
/// account's folder and, for Claude Code, its token.
pub fn env_for(account: &Account) -> Vec<(String, String)> {
    if account.is_this_mac() {
        return Vec::new();
    }
    match account.engine {
        Engine::Claude => {
            let mut env = vec![(
                "CLAUDE_CONFIG_DIR".to_string(),
                accounts::claude_config_dir(&account.id)
                    .to_string_lossy()
                    .into_owned(),
            )];
            if let Some(token) = accounts::claude_token_for(&account.id) {
                env.push(("CLAUDE_CODE_OAUTH_TOKEN".to_string(), token));
            }
            env
        }
        Engine::Codex => vec![(
            "CODEX_HOME".to_string(),
            accounts::codex_home_dir(&account.id)
                .to_string_lossy()
                .into_owned(),
        )],
    }
}

/// The engine's folder for an account (where its transcripts live).
pub fn folder(account: &Account) -> PathBuf {
    match account.engine {
        Engine::Claude => accounts::claude_config_dir(&account.id),
        Engine::Codex => accounts::codex_home_dir(&account.id),
    }
}

/// Claude Code's own settings file for an account (where its folder trust
/// is recorded): this Mac's as Claude Code finds it, else the one in the
/// account's folder.
pub fn claude_config_for(account: &Account) -> Option<PathBuf> {
    if account.is_this_mac() {
        return super::decisions::claude_config();
    }
    Some(folder(account).join(".claude.json"))
}

/// The account an agent's turns last ran on (for a take-over's terminal),
/// else the engine's first.
pub fn last_account(engine: Engine, agent_id: &str) -> Account {
    let file = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read()
    };
    let last = file.last_used.get(agent_id).cloned();
    let found = file
        .of(engine)
        .find(|a| last.as_deref() == Some(key(engine, &a.id).as_str()))
        .or_else(|| file.of(engine).next())
        .cloned();
    found.unwrap_or_else(|| this_mac(engine))
}

pub fn engine_folders(engine: Engine) -> Vec<PathBuf> {
    folders(engine)
}

/// Every account folder of an engine that exists, this Mac's first.
fn folders(engine: Engine) -> Vec<PathBuf> {
    of(engine)
        .iter()
        .map(folder)
        .filter(|p| p.is_dir())
        .collect()
}

/// Get an account's folder ready for a turn: links to this Mac's own
/// settings and skills ([`SHARED`]) where it has none of its own.
pub fn prepare(account: &Account) {
    if account.is_this_mac() {
        return;
    }
    let native = folder(&this_mac(account.engine));
    link_shared(account.engine, &native, &folder(account));
}

pub fn link_shared(engine: Engine, native: &Path, target: &Path) {
    let Some((_, names)) = SHARED.iter().find(|(e, _)| *e == engine) else {
        return;
    };
    if native == target {
        return;
    }
    for name in *names {
        let from = native.join(name);
        let to = target.join(name);
        if !from.exists() || to.symlink_metadata().is_ok() {
            continue;
        }
        #[cfg(unix)]
        if let Err(e) = std::os::unix::fs::symlink(&from, &to) {
            tracing::warn!("[Agents] couldn't link {name} into an account's folder: {e}");
        }
    }
}

/// Before resuming `session` on `account`: make sure its folder has the
/// newest copy of the session's transcript among the engine's accounts.
/// True when one was copied in. Nothing found anywhere is not an error: the
/// engine then says it has no such session, and the runner starts a new one
/// with the recent conversation.
pub fn carry_session(account: &Account, session: &str) -> bool {
    if session.is_empty() || !valid_session(session) {
        return false;
    }
    let target = folder(account);
    let roots = folders(account.engine);
    match account.engine {
        Engine::Claude => carry_claude(&roots, &target, session),
        Engine::Codex => carry_codex(&roots, &target, session),
    }
    .unwrap_or_else(|e| {
        tracing::warn!("[Agents] couldn't carry a session to another account: {e}");
        false
    })
}

/// Whether `session`'s transcript is on disk in any of the engine's account
/// folders: Claude Code's `projects/<folder>/<session>.jsonl`, Codex's
/// `sessions/…/rollout-…-<thread>.jsonl`. A turn is only ever picked up on
/// a conversation that is really there; without one it would start blank
/// and could do again what was already done.
pub fn session_on_disk(engine: Engine, session: &str) -> bool {
    session_in(&folders(engine), engine, session)
}

pub fn session_in(roots: &[PathBuf], engine: Engine, session: &str) -> bool {
    if !valid_session(session) {
        return false;
    }
    match engine {
        Engine::Claude => {
            let name = format!("{session}.jsonl");
            roots.iter().any(|root| {
                std::fs::read_dir(root.join("projects"))
                    .is_ok_and(|dirs| dirs.flatten().any(|d| d.path().join(&name).is_file()))
            })
        }
        Engine::Codex => {
            let suffix = format!("-{session}.jsonl");
            roots.iter().any(|root| {
                let mut dirs = vec![(root.join("sessions"), 0)];
                while let Some((dir, depth)) = dirs.pop() {
                    let Ok(entries) = std::fs::read_dir(&dir) else {
                        continue;
                    };
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() && depth < 4 {
                            dirs.push((path, depth + 1));
                        } else if path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                        {
                            return true;
                        }
                    }
                }
                false
            })
        }
    }
}

/// Session and thread ids are uuids: nothing else is looked for on disk.
pub(super) fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

pub(super) fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// `<root>/projects/<folder>/<session>.jsonl` in every root; the newest is
/// copied into `target` under the same folder name (Claude Code's own name
/// for the working directory, so the same cwd finds it).
pub fn carry_claude(roots: &[PathBuf], target: &Path, session: &str) -> std::io::Result<bool> {
    let name = format!("{session}.jsonl");
    let mut found: Vec<(PathBuf, String)> = Vec::new();
    for root in roots {
        let Ok(dirs) = std::fs::read_dir(root.join("projects")) else {
            continue;
        };
        for dir in dirs.flatten() {
            let file = dir.path().join(&name);
            if file.is_file() {
                found.push((file, dir.file_name().to_string_lossy().into_owned()));
            }
        }
    }
    let Some((newest, folder_name)) = found.iter().max_by_key(|(p, _)| modified(p)).cloned() else {
        return Ok(false);
    };
    let dest_dir = target.join("projects").join(&folder_name);
    let dest = dest_dir.join(&name);
    if newest == dest || (dest.is_file() && modified(&dest) >= modified(&newest)) {
        return Ok(false);
    }
    super::store::ensure_private_dir(&dest_dir)?;
    copy_replacing(&newest, &dest)?;
    // Sub-agent transcripts and saved tool output live beside it.
    if let Some(side) = newest.parent().map(|p| p.join(session)) {
        if side.is_dir() {
            copy_dir(&side, &dest_dir.join(session))?;
        }
    }
    Ok(true)
}

/// `<home>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl` in every home; the
/// newest is copied into `target` at the same place.
pub fn carry_codex(roots: &[PathBuf], target: &Path, thread: &str) -> std::io::Result<bool> {
    let suffix = format!("-{thread}.jsonl");
    let mut found: Vec<(PathBuf, PathBuf)> = Vec::new();
    for root in roots {
        let sessions = root.join("sessions");
        let mut dirs = vec![(sessions.clone(), 0)];
        while let Some((dir, depth)) = dirs.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && depth < 4 {
                    dirs.push((path, depth + 1));
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                {
                    if let Ok(rel) = path.strip_prefix(&sessions) {
                        found.push((path.clone(), rel.to_path_buf()));
                    }
                }
            }
        }
    }
    let Some((newest, rel)) = found.iter().max_by_key(|(p, _)| modified(p)).cloned() else {
        return Ok(false);
    };
    let dest = target.join("sessions").join(&rel);
    if newest == dest || (dest.is_file() && modified(&dest) >= modified(&newest)) {
        return Ok(false);
    }
    if let Some(dir) = dest.parent() {
        super::store::ensure_private_dir(dir)?;
    }
    copy_replacing(&newest, &dest)?;
    Ok(true)
}

/// Copy keeping the source's modified time, so "newest" stays comparable.
pub(super) fn copy_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tmp = to.as_os_str().to_owned();
    tmp.push(".carry");
    let tmp = PathBuf::from(tmp);
    std::fs::copy(from, &tmp)?;
    // A conversation is the user's own: readable by them only, whatever
    // the source's mode was.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    if let Some(at) = modified(from) {
        if let Ok(f) = std::fs::File::options().write(true).open(&tmp) {
            let _ = f.set_modified(at);
        }
    }
    std::fs::rename(&tmp, to)
}

pub(super) fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    super::store::ensure_private_dir(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let path = entry.path();
        let dest = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&path, &dest)?;
        } else if kind.is_file() {
            copy_replacing(&path, &dest)?;
        }
    }
    Ok(())
}

/* ---------------------------------------------------------- the chat's */

/// Record which account an agent's turn ran on; the account it ran on
/// before, when that was another one of the same engine.
pub fn ran_on(agent_id: &str, account: &Account) -> Option<String> {
    change(|file| {
        let k = key(account.engine, &account.id);
        let prev = file.last_used.insert(agent_id.to_string(), k.clone());
        Ok(prev.filter(|p| *p != k && p.starts_with(engine_word(account.engine))))
    })
    .ok()
    .flatten()
    .and_then(|k| k.split_once(':').map(|(_, id)| id.to_string()))
}

/// The agent was deleted: nothing of it is kept here.
pub fn forget_agent(agent_id: &str) {
    let _ = change(|file| {
        file.last_used.remove(agent_id);
        Ok(())
    });
}

/// "Switched to Work: This Mac is out until 10:00 AM." The quiet line for a
/// turn that runs on another account than the last, for the reason the
/// last one is out (said only when it is).
pub fn switch_line<Tz: chrono::TimeZone>(
    to: &Account,
    from: Option<&Account>,
    tz: &Tz,
    now: i64,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let why = from.and_then(|f| {
        let until = f.out(now)?;
        Some(match until {
            Some(at) => format!(
                "{} is out of usage until {}",
                f.name,
                strip_at(&super::failure::clock_phrase(tz, at, now))
            ),
            None => format!("{} is out of usage", f.name),
        })
    });
    match why {
        Some(why) => format!("Switched to {}: {why}.", to.name),
        None => format!("Switched to {}.", to.name),
    }
}

/// "at 3:00 PM" reads "until 3:00 PM"; "tomorrow at …", "Sat at …" stay.
fn strip_at(phrase: &str) -> String {
    phrase.strip_prefix("at ").unwrap_or(phrase).to_string()
}

/// The line a turn ends on when every account of its engine is out.
pub fn all_out_line<Tz: chrono::TimeZone>(
    engine: Engine,
    count: usize,
    earliest: Option<i64>,
    tz: &Tz,
    now: i64,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let who = engine.label();
    let all = if count == 2 {
        format!("Both {who} accounts have")
    } else {
        format!("All {count} {who} accounts have")
    };
    match earliest {
        Some(at) => format!(
            "{all} reached their usage limit. The first is back {}.",
            super::failure::clock_phrase(tz, at, now)
        ),
        None => format!("{all} reached their usage limit, and none said when it resets."),
    }
}

/// What the next account is told: the same request, with why it's here
/// again, so work already done on the last one is continued, not redone.
pub fn continue_prompt(prompt: &str) -> String {
    const NOTE: &str = "[The last attempt at this stopped because that account's usage limit was reached. It continues here on another account. If you had already started, carry on from where you stopped rather than starting over; don't mention the switch unless asked.]";
    if prompt.starts_with(NOTE) {
        return prompt.to_string();
    }
    format!("{NOTE}\n\n{prompt}")
}

/* ----------------------------------------------------------- all-out */

static ALL_OUT: Mutex<BTreeMap<String, (String, Option<i64>)>> = Mutex::new(BTreeMap::new());

/// The runner ended a turn because every account is out: the line (and the
/// earliest reset) its failure is said with, instead of the engine's own.
pub fn set_all_out(agent_id: &str, line: String, resets_at: Option<i64>) {
    ALL_OUT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), (line, resets_at));
}

pub fn take_all_out(agent_id: &str) -> Option<(String, Option<i64>)> {
    ALL_OUT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
}

/* ---------------------------------------------------------- the views */

/// One account as Settings shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub engine: Engine,
    pub name: String,
    pub this_mac: bool,
    pub signed_in: bool,
    /// Who it is signed in as, as the engine recorded it (`identity`), or
    /// the email captured when it was signed in here. Never guessed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The plan's name, only when the engine's own file names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// The last limit hit, as recorded (only from a turn that hit it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<LimitHit>,
    /// Out right now.
    pub out: bool,
}

/// Who `account` is signed in as, from its engine's own files; for an added
/// Claude Code account, the email captured at its sign-in comes first (its
/// folder's settings file may not name one).
fn identity_of(account: &Account) -> super::identity::Identity {
    use super::identity;
    match account.engine {
        Engine::Claude => {
            let mut who = identity::read(claude_config_for(account).as_deref(), identity::claude);
            if !account.is_this_mac() {
                if let Some(email) = accounts::claude_email_for(&account.id) {
                    who.email = Some(email);
                }
            }
            who
        }
        Engine::Codex => identity::read(
            Some(&accounts::codex_home_dir(&account.id).join("auth.json")),
            identity::codex,
        ),
    }
}

pub async fn views() -> Vec<AccountView> {
    let now = super::store::now_ms();
    let mut out = Vec::new();
    for account in list() {
        let signed_in = signed_in(&account).await;
        // Only for a sign-in that is there: a file can outlive a sign-out.
        let who = if signed_in {
            identity_of(&account)
        } else {
            super::identity::Identity::default()
        };
        out.push(AccountView {
            out: account.out(now).is_some(),
            this_mac: account.is_this_mac(),
            id: account.id,
            engine: account.engine,
            name: account.name,
            signed_in,
            email: who.email,
            plan: who.plan,
            limit: account.limit,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    /// Any file can be in Codex's sessions folder: a name where the last 36
    /// bytes start inside a character is skipped, never a panic.
    #[test]
    fn rollout_names_with_multibyte_text_never_panic() {
        let id = "0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e";
        assert_eq!(
            rollout_session(&format!("rollout-2026-11-05T10-00-00-{id}")),
            Some(id)
        );
        // 36 bytes back from the end lands inside "日" / "⌘" / the emoji.
        for name in [
            "rollout-日本語のメモ日本語のメモ日本語のメモa",
            "rollout-⌘⌘⌘⌘⌘⌘⌘⌘⌘⌘⌘⌘⌘⌘a",
            "rollout-🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a",
        ] {
            assert_eq!(rollout_session(name), None, "{name}");
        }
        assert_eq!(rollout_session("rollout-short"), None);
        assert_eq!(rollout_session(&format!("other-{id}")), None);
    }

    /// Thu 5 Nov 2026, 08:00 UTC.
    fn now() -> i64 {
        Utc.with_ymd_and_hms(2026, 11, 5, 8, 0, 0)
            .unwrap()
            .timestamp_millis()
    }
    const H: i64 = 3_600_000;

    fn account(id: &str, name: &str, limit: Option<LimitHit>) -> Account {
        Account {
            id: id.into(),
            engine: Engine::Claude,
            name: name.into(),
            added_at: 0,
            limit,
        }
    }

    fn cand(id: &str, name: &str, signed_in: bool, limit: Option<LimitHit>) -> Candidate {
        Candidate {
            account: account(id, name, limit),
            signed_in,
        }
    }

    fn out_until(at: i64) -> Option<LimitHit> {
        Some(LimitHit {
            at: now() - H,
            resets_at: Some(at),
        })
    }

    #[test]
    fn the_first_signed_in_account_that_isnt_out_runs() {
        let list = [
            cand("default", "This Mac", true, out_until(now() + 2 * H)),
            cand("a1", "Work", false, None),
            cand("a2", "Personal", true, None),
        ];
        assert_eq!(
            choose(&list, &[], now()),
            Choice::Run(list[2].account.clone())
        );
        // Its reset passed: back first in line.
        let back = [
            cand("default", "This Mac", true, out_until(now() - 1)),
            cand("a2", "Personal", true, None),
        ];
        assert_eq!(
            choose(&back, &[], now()),
            Choice::Run(back[0].account.clone())
        );
    }

    #[test]
    fn one_account_always_runs_and_the_engine_says_whether_it_can() {
        let one = [cand("default", "This Mac", true, out_until(now() + H))];
        assert_eq!(
            choose(&one, &[], now()),
            Choice::Run(one[0].account.clone())
        );
        // Signed out, alone: it still runs (the turn says it's signed out).
        let out = [cand("default", "This Mac", false, None)];
        assert_eq!(
            choose(&out, &[], now()),
            Choice::Run(out[0].account.clone())
        );
        // One signed in among signed-out ones runs even when marked out.
        let mixed = [
            cand("default", "This Mac", false, None),
            cand("a1", "Work", true, out_until(now() + H)),
        ];
        assert_eq!(
            choose(&mixed, &[], now()),
            Choice::Run(mixed[1].account.clone())
        );
    }

    #[test]
    fn when_every_account_is_out_the_earliest_reported_reset_is_named() {
        let list = [
            cand("default", "This Mac", true, out_until(now() + 5 * H)),
            cand("a1", "Work", true, out_until(now() + 2 * H)),
            cand(
                "a2",
                "Personal",
                true,
                Some(LimitHit {
                    at: now(),
                    resets_at: None,
                }),
            ),
        ];
        assert_eq!(
            choose(&list, &[], now()),
            Choice::AllOut {
                earliest: Some(now() + 2 * H),
                count: 3
            }
        );
        // A limit with no reset is out for an hour, then tried again.
        let unknown = [
            cand(
                "default",
                "This Mac",
                true,
                Some(LimitHit {
                    at: now() - UNKNOWN_OUT_MS,
                    resets_at: None,
                }),
            ),
            cand("a1", "Work", true, out_until(now() + H)),
        ];
        assert_eq!(
            choose(&unknown, &[], now()),
            Choice::Run(unknown[0].account.clone())
        );
    }

    #[test]
    fn an_account_tried_in_this_turn_is_never_tried_again_in_it() {
        let list = [
            cand("default", "This Mac", true, None),
            cand("a1", "Work", true, None),
        ];
        let tried = vec!["default".to_string()];
        assert_eq!(
            choose(&list, &tried, now()),
            Choice::Run(list[1].account.clone())
        );
        let both = vec!["default".to_string(), "a1".to_string()];
        assert!(matches!(choose(&list, &both, now()), Choice::AllOut { .. }));
        assert!(!can_switch(&list, &both, now()));
        assert!(can_switch(&list, &tried, now()));
        // The cap holds whatever the list says.
        let many: Vec<String> = (0..=MAX_SWITCHES).map(|i| format!("x{i}")).collect();
        assert!(!can_switch(&list, &many, now()));
    }

    #[test]
    fn the_lines_say_who_is_out_and_until_when() {
        let work = account("a1", "Work", None);
        let mac = account("default", "This Mac", out_until(now() + 2 * H));
        assert_eq!(
            switch_line(&work, Some(&mac), &Utc, now()),
            "Switched to Work: This Mac is out of usage until 10:00 AM."
        );
        let unknown = account(
            "default",
            "This Mac",
            Some(LimitHit {
                at: now(),
                resets_at: None,
            }),
        );
        assert_eq!(
            switch_line(&work, Some(&unknown), &Utc, now()),
            "Switched to Work: This Mac is out of usage."
        );
        // Back on an account whose limit lifted: no reason is invented.
        assert_eq!(switch_line(&work, None, &Utc, now()), "Switched to Work.");
        assert_eq!(
            all_out_line(Engine::Claude, 2, Some(now() + 26 * H), &Utc, now()),
            "Both Claude Code accounts have reached their usage limit. The first is back tomorrow at 10:00 AM."
        );
        assert_eq!(
            all_out_line(Engine::Codex, 3, None, &Utc, now()),
            "All 3 Codex accounts have reached their usage limit, and none said when it resets."
        );
    }

    #[test]
    fn the_all_out_line_reads_as_the_usage_limit() {
        let line = all_out_line(Engine::Claude, 2, Some(now() + H), &Utc, now());
        let (_, f) = super::super::failure::describe(Engine::Claude, &line, &Utc, None, now());
        assert_eq!(f.kind, super::super::failure::FailureKind::UsageLimit);
    }

    #[test]
    fn the_next_account_is_told_once_why_it_has_this() {
        let once = continue_prompt("Book a table");
        assert!(once.ends_with("Book a table"));
        assert_eq!(continue_prompt(&once), once);
    }

    #[test]
    fn this_mac_is_always_in_the_list_and_ids_are_kept_safe() {
        let file = WalletFile {
            accounts: vec![
                account("a1", "Work", None),
                account("a1", "Dup", None),
                account("../x", "Bad", None),
            ],
            ..Default::default()
        }
        .normalized();
        let claude: Vec<&str> = file.of(Engine::Claude).map(|a| a.id.as_str()).collect();
        assert_eq!(claude, ["default", "a1"]);
        assert_eq!(file.of(Engine::Codex).count(), 1);
        assert!(file.of(Engine::Codex).next().unwrap().is_this_mac());
    }

    fn in_scratch(f: impl FnOnce()) {
        let _serial = super::super::store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        super::super::store::set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        super::super::store::set_root_for_tests(None);
    }

    #[test]
    fn accounts_are_added_renamed_reordered_and_marked_out_on_disk() {
        in_scratch(|| {
            let work = add(Engine::Claude, " Work ").unwrap();
            assert_eq!(work.name, "Work");
            assert!(
                add(Engine::Claude, "work").is_err(),
                "names are one per engine"
            );
            let home = add(Engine::Codex, "Work").unwrap();
            assert_eq!(home.engine, Engine::Codex);
            let personal = add(Engine::Claude, "Personal").unwrap();
            let ids: Vec<String> = of(Engine::Claude).into_iter().map(|a| a.id).collect();
            assert_eq!(ids, ["default", work.id.as_str(), personal.id.as_str()]);

            let order = vec![personal.id.clone(), "default".into(), work.id.clone()];
            reorder(Engine::Claude, &order).unwrap();
            let ids: Vec<String> = of(Engine::Claude).into_iter().map(|a| a.id).collect();
            assert_eq!(ids, order);
            // Codex's own order is untouched.
            assert_eq!(of(Engine::Codex).len(), 2);
            assert!(reorder(Engine::Claude, &order[..2]).is_err());

            assert_eq!(
                rename(Engine::Claude, &work.id, "Office").unwrap().name,
                "Office"
            );
            assert!(rename(Engine::Claude, &work.id, "personal").is_err());
            assert!(remove(Engine::Claude, THIS_MAC).is_err());

            mark_out(Engine::Claude, &work.id, Some(now() + H), now());
            let marked = of(Engine::Claude)
                .into_iter()
                .find(|a| a.id == work.id)
                .unwrap();
            assert_eq!(marked.out(now()), Some(Some(now() + H)));
            // A reset already past is not a reset.
            mark_out(Engine::Claude, &work.id, Some(now() - 1), now());
            let marked = of(Engine::Claude)
                .into_iter()
                .find(|a| a.id == work.id)
                .unwrap();
            assert_eq!(marked.limit.unwrap().resets_at, None);

            assert_eq!(ran_on("ag1", &marked_account(&work.id)), None);
            assert_eq!(
                ran_on("ag1", &this_mac(Engine::Claude)),
                Some(work.id.clone())
            );
            assert_eq!(ran_on("ag1", &this_mac(Engine::Claude)), None);
            assert!(!reading_moves_to(Engine::Claude, &work.id));
            assert!(reading_moves_to(Engine::Claude, THIS_MAC));
            assert!(!reading_moves_to(Engine::Claude, THIS_MAC));
        });
    }

    fn marked_account(id: &str) -> Account {
        account(id, "Work", None)
    }

    fn touch(path: &Path, text: &str, age_s: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        let at = std::time::SystemTime::now() - std::time::Duration::from_secs(age_s);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    #[test]
    fn the_newest_claude_transcript_is_carried_to_the_account_that_resumes_it() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, work) = (dir.path().join("mac"), dir.path().join("work"));
        let sid = "85100e7a-050c-4811-a26e-55203a85d28b";
        let folder = "-Users-me-Library-Application-Support-app-agents-ag1";
        touch(
            &mac.join("projects")
                .join(folder)
                .join(format!("{sid}.jsonl")),
            "old\nnew\n",
            10,
        );
        touch(
            &mac.join("projects")
                .join(folder)
                .join(sid)
                .join("subagents/a.jsonl"),
            "x",
            10,
        );
        std::fs::create_dir_all(&work).unwrap();
        let roots = [mac.clone(), work.clone()];
        assert!(carry_claude(&roots, &work, sid).unwrap());
        let carried = work
            .join("projects")
            .join(folder)
            .join(format!("{sid}.jsonl"));
        assert_eq!(std::fs::read_to_string(&carried).unwrap(), "old\nnew\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&carried).unwrap().permissions().mode();
            assert_eq!(
                mode & 0o777,
                0o600,
                "a carried conversation is the user's only"
            );
        }
        assert!(work
            .join("projects")
            .join(folder)
            .join(sid)
            .join("subagents/a.jsonl")
            .is_file());
        // Already the newest there: nothing to do.
        assert!(!carry_claude(&roots, &work, sid).unwrap());
        // It went on on the other account, and comes back: the newer copy wins.
        touch(&carried, "old\nnew\nmore\n", 0);
        assert!(carry_claude(&roots, &mac, sid).unwrap());
        assert_eq!(
            std::fs::read_to_string(
                mac.join("projects")
                    .join(folder)
                    .join(format!("{sid}.jsonl"))
            )
            .unwrap(),
            "old\nnew\nmore\n"
        );
        // A session nobody has: nothing, and no error.
        assert!(!carry_claude(&roots, &work, "0000").unwrap());
    }

    #[test]
    fn removing_an_account_keeps_the_conversations_that_last_ran_there() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, work) = (dir.path().join("mac"), dir.path().join("work"));
        let sid = "85100e7a-050c-4811-a26e-55203a85d28b";
        let folder = "-Users-me-Library-Application-Support-app-agents-ag1";
        let at = |root: &Path| {
            root.join("projects")
                .join(folder)
                .join(format!("{sid}.jsonl"))
        };
        touch(&at(&mac), "old\n", 100);
        touch(&at(&work), "old\nnewer\n", 0);
        assert_eq!(keep_sessions(Engine::Claude, &work, &mac), 1);
        assert_eq!(std::fs::read_to_string(at(&mac)).unwrap(), "old\nnewer\n");
        // Already kept: nothing to do again.
        assert_eq!(keep_sessions(Engine::Claude, &work, &mac), 0);

        let thread = "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b";
        let rel = format!("2026/11/05/rollout-2026-11-05T10-00-00-{thread}.jsonl");
        touch(&work.join("sessions").join(&rel), "t\n", 0);
        assert_eq!(keep_sessions(Engine::Codex, &work, &mac), 1);
        assert!(mac.join("sessions").join(&rel).is_file());
    }

    #[test]
    fn a_codex_rollout_is_carried_to_the_same_place_in_the_other_home() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, work) = (dir.path().join("mac"), dir.path().join("work"));
        let thread = "019a3c1e-0b5e-7e30-9e62-6a1d9c8f1a2b";
        let rel = format!("2026/11/04/rollout-2026-11-04T10-00-00-{thread}.jsonl");
        touch(&mac.join("sessions").join(&rel), "{}\n", 5);
        touch(
            &mac.join("sessions/2026/11/04/rollout-2026-11-04T09-00-00-other.jsonl"),
            "{}\n",
            5,
        );
        assert!(carry_codex(&[mac.clone(), work.clone()], &work, thread).unwrap());
        assert!(work.join("sessions").join(&rel).is_file());
        assert!(!work
            .join("sessions/2026/11/04/rollout-2026-11-04T09-00-00-other.jsonl")
            .exists());
        assert!(!carry_codex(&[mac, work.clone()], &work, thread).unwrap());
    }

    #[test]
    fn only_settings_and_skills_are_shared_never_a_login() {
        let dir = tempfile::tempdir().unwrap();
        let (mac, work) = (dir.path().join("mac"), dir.path().join("work"));
        for f in ["settings.json", ".claude.json", ".credentials.json"] {
            touch(&mac.join(f), "{}", 0);
        }
        std::fs::create_dir_all(mac.join("skills/one")).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        link_shared(Engine::Claude, &mac, &work);
        assert!(work.join("settings.json").is_file());
        assert!(work.join("skills/one").is_dir());
        assert!(!work.join(".claude.json").exists());
        assert!(!work.join(".credentials.json").exists());
        // Its own file is never replaced.
        let codex_mac = dir.path().join("cmac");
        let codex_work = dir.path().join("cwork");
        touch(&codex_mac.join("config.toml"), "model = \"x\"", 0);
        touch(&codex_mac.join("auth.json"), "{}", 0);
        touch(&codex_work.join("config.toml"), "mine", 0);
        link_shared(Engine::Codex, &codex_mac, &codex_work);
        assert_eq!(
            std::fs::read_to_string(codex_work.join("config.toml")).unwrap(),
            "mine"
        );
        assert!(!codex_work.join("auth.json").exists());
    }

    #[test]
    fn only_uuid_like_sessions_are_looked_for() {
        assert!(valid_session("85100e7a-050c-4811-a26e-55203a85d28b"));
        assert!(!valid_session("../../etc"));
        assert!(!valid_session(""));
    }
}
