//! The same reach on every Claude Code account: what an agent can use
//! shouldn't change because its turn failed over from this Mac's sign-in to
//! an added account (`wallet`).
//!
//! Three things differ per Claude Code config dir, and each is handled here:
//!
//! 1. **User-scope MCP servers** live in `.claude.json`'s `mcpServers`, which
//!    is per config dir. Before a turn on an added account, this Mac's are
//!    merged into the account's file ([`sync_servers`]): only that key, an
//!    atomic 0600 write, the account's own servers kept, and a server this
//!    Mac no longer has removed only when it was put there by this sync
//!    (recorded in [`SYNCED_FILE`]). Never a login: the OAuth tokens those
//!    servers use are in Claude Code's secure storage, which is per config
//!    dir too (Keychain `Claude Code-credentials-<sha256(dir)[..8]>`, key
//!    `mcpOAuth`, read in 2.1.319's own code), so a server that signs in by
//!    OAuth needs one sign-in per account. [`needs_auth_line`] says which,
//!    from `claude mcp list` run as that account.
//! 2. **Claude in Chrome**. `--chrome` reaches the extension through the
//!    claude.ai bridge, as the claude.ai account its OAuth token belongs to
//!    (2.1.319: `bridgeConfig.getUserId` resolves the token's account), and
//!    the extension in the user's Chrome is signed in to this Mac's. So on an
//!    added account `--chrome` finds no browser (observed: "Browser extension
//!    is not connected" under the account's `CLAUDE_CONFIG_DIR`). Such a turn
//!    runs `--no-chrome` and gets the same server under [`CHROME_SERVER`],
//!    started without the account's variables ([`chrome_server`]), so it
//!    reaches the user's Chrome as this Mac's sign-in (observed: the same
//!    browser listed). Claude Code reserves the name `claude-in-chrome`, so
//!    its tools are `mcp__user-chrome__*`; the broker and the stream map
//!    them back (`e2e_alias`), and the browser gate decides them exactly as
//!    the real ones.
//! 3. **claude.ai connectors** (Gmail, Calendar, Slack through claude.ai)
//!    belong to each claude.ai account and can't be copied. When a switched
//!    turn's engine lists its connectors, [`lost_line`] compares them with
//!    the last turn's and says, once, what isn't on this account and how the
//!    agent reaches it meanwhile.

use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::Path;

use super::capabilities::Capabilities;

/// The MCP server name a turn on an added account reaches the user's Chrome
/// under. Not `claude-in-chrome`: Claude Code drops a config entry by that
/// name (observed on 2.1.319).
pub const CHROME_SERVER: &str = "user-chrome";

/// Beside an account's `.claude.json`: the server names this sync put there.
pub const SYNCED_FILE: &str = ".synced-mcp-servers.json";

/* ------------------------------------------------------ MCP servers */

/// What a sync did, for the log and the tests.
#[derive(Debug, Default, PartialEq)]
pub struct Synced {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

impl Synced {
    pub fn changed(&self) -> bool {
        !(self.added.is_empty() && self.updated.is_empty() && self.removed.is_empty())
    }
}

fn read_json(path: &Path) -> std::io::Result<Option<Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Merge `native`'s user-scope `mcpServers` into `target`'s. Only that key
/// is written; the rest of `target` (its login, its projects) is kept as
/// read. A `target` that isn't JSON is left alone (an error). Nothing to
/// change, nothing written.
pub fn sync_servers(native: &Path, target: &Path) -> std::io::Result<Synced> {
    let from: Map<String, Value> = read_json(native)?
        .and_then(|v| v.get("mcpServers")?.as_object().cloned())
        .unwrap_or_default();
    let mut config = match read_json(target)? {
        Some(Value::Object(m)) => m,
        Some(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "an account's .claude.json isn't an object",
            ))
        }
        None => Map::new(),
    };
    let ledger = target.with_file_name(SYNCED_FILE);
    let before: BTreeSet<String> = read_json(&ledger)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let mut servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut done = Synced::default();
    for (name, def) in &from {
        match servers.get(name) {
            None => done.added.push(name.clone()),
            Some(have) if have != def => done.updated.push(name.clone()),
            Some(_) => continue,
        }
        servers.insert(name.clone(), def.clone());
    }
    for name in &before {
        if !from.contains_key(name) && servers.remove(name).is_some() {
            done.removed.push(name.clone());
        }
    }
    let now: BTreeSet<String> = from.keys().cloned().collect();
    if done.changed() {
        config.insert("mcpServers".into(), Value::Object(servers));
        let bytes = serde_json::to_vec_pretty(&Value::Object(config))
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        write_atomic(target, &bytes)?;
    }
    if now != before {
        let bytes = serde_json::to_vec(&now).unwrap_or_default();
        write_atomic(&ledger, &bytes)?;
    }
    Ok(done)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    super::store::write_private(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Before a turn on `account`: this Mac's user-scope servers on it too.
pub fn prepare(account: &super::wallet::Account) {
    if account.is_this_mac() || account.engine != super::engine::Engine::Claude {
        return;
    }
    let Some(native) = super::decisions::claude_config() else {
        return;
    };
    let target = super::wallet::folder(account).join(".claude.json");
    if !target.parent().is_some_and(Path::is_dir) {
        return;
    }
    match sync_servers(&native, &target) {
        Ok(done) if done.changed() => tracing::info!(
            account = %account.id, added = ?done.added, updated = ?done.updated, removed = ?done.removed,
            "[Agents] brought this Mac's MCP servers to an added account"
        ),
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(account = %account.id, "[Agents] couldn't bring this Mac's MCP servers to an added account: {e}")
        }
    }
}

/// "On Personal, Figma and Webflow need a one-time sign-in…": the user-scope
/// servers `claude mcp list` (run as that account) says need authentication.
/// `None` when none does. Pure.
pub fn needs_auth_line(account: &str, agent: &str, apps: &[super::apps::App]) -> Option<String> {
    let names: Vec<String> = apps
        .iter()
        .filter(|a| a.status == "needs_auth" && a.source == super::apps::Source::User)
        .map(|a| super::apps::display_name(&a.name))
        .collect();
    if names.is_empty() {
        return None;
    }
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let (list, verb) = (join(&refs), if names.len() == 1 { "needs" } else { "need" });
    Some(format!(
        "On {account}, {list} {verb} a one-time sign-in: their logins are kept per Claude account. Take over {agent}, type /mcp and sign in, then hand back."
    ))
}

/* --------------------------------------------------------- Chrome */

/// The `--mcp-config` entry that reaches the user's Chrome as this Mac's
/// sign-in: Claude Code's own Claude in Chrome server, started with the
/// account's variables taken away, so it resolves this Mac's login.
pub fn chrome_server(claude: &Path) -> Value {
    serde_json::json!({
        "type": "stdio",
        "command": "/usr/bin/env",
        "args": [
            "-u", "CLAUDE_CONFIG_DIR",
            "-u", "CLAUDE_CODE_OAUTH_TOKEN",
            "-u", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            claude.to_string_lossy(),
            "--claude-in-chrome-mcp",
        ],
    })
}

/// What a turn on an added account is told about its Chrome tools' name.
pub fn chrome_prompt_line() -> String {
    format!("Your Chrome tools in this turn are named mcp__{CHROME_SERVER}__* (the same Claude in Chrome tools as mcp__claude-in-chrome__*, in the user's own Chrome, with the same rules). Use them wherever you'd use mcp__claude-in-chrome__*.")
}

/* ------------------------------------------------------- connectors */

fn listed(caps: &Capabilities, what: &str) -> Vec<String> {
    caps.lines
        .iter()
        .filter(|l| l.what == what)
        .flat_map(|l| {
            let detail = l
                .detail
                .split(". Connect them")
                .next()
                .unwrap_or("")
                .trim_end_matches('.')
                .to_string();
            detail
                .split(", ")
                .flat_map(|p| p.split(" and "))
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn chrome_connected(caps: &Capabilities) -> bool {
    caps.lines
        .iter()
        .any(|l| l.what == "Chrome" && !l.detail.starts_with("Not connected"))
}

/// The one quiet line for a turn that switched to `account`: the connectors
/// the last turn had that this one's engine doesn't list as connected, and
/// how it reaches them meanwhile (`chrome`: its turns get the user's Chrome).
/// Also says when Chrome itself was lost. `None`: nothing lost. Pure.
pub fn lost_line(
    account: &str,
    before: &Capabilities,
    now: &Capabilities,
    chrome: bool,
) -> Option<String> {
    let have: BTreeSet<String> = listed(now, "Connectors").into_iter().collect();
    let lost: Vec<String> = listed(before, "Connectors")
        .into_iter()
        .filter(|c| !have.contains(c))
        .collect();
    let lost_chrome = chrome_connected(before) && !chrome_connected(now);
    if lost.is_empty() && !lost_chrome {
        return None;
    }
    let mut parts = Vec::new();
    if !lost.is_empty() {
        let refs: Vec<&str> = lost.iter().map(String::as_str).collect();
        let (list, verb) = (
            join(&refs),
            if lost.len() == 1 { "isn't" } else { "aren't" },
        );
        let meanwhile = if chrome && !lost_chrome {
            "agents use them in your Chrome meanwhile"
        } else {
            "or connect them here"
        };
        parts.push(format!(
            "{list} {verb} on in claude.ai for {account}: turn {} on at claude.ai/settings/connectors while signed in as {account}; {meanwhile}.",
            if lost.len() == 1 { "it" } else { "them" }
        ));
    }
    if lost_chrome {
        parts.push(format!(
            "Your Chrome isn't reachable on {account}; agents use their own browser for sites they're allowed."
        ));
    }
    Some(parts.join(" "))
}

fn join(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
#[path = "account_reach_tests.rs"]
mod tests;
