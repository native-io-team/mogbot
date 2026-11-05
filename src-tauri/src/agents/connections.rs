//! Connections: the apps an agent signs in to through a login card
//! (`agents/logins.rs`), and which agents may use each one.
//!
//! A connection is one account at one service ("Linear · sam@acme.com",
//! "Gmail · work"). There are four kinds, and they keep their sign-in in
//! different places, which the UI says plainly:
//!
//! - **Ours** ([`Kind::Oauth`]): a remote MCP server we signed in to with our
//!   own OAuth client (`agents/oauth.rs`). Its tokens are in this Mac's
//!   Keychain under an app-owned item (`<slug>-connection-<id>`), never in
//!   this registry, an agent's folder, a chat log or anything sent to the
//!   phone. Turns of the agents it's granted to get the server with the
//!   token as a header: Claude Code in the turn's 0600 `--mcp-config` file,
//!   Codex in an environment variable of the turn's process (`reach`).
//! - **claude.ai** ([`Kind::ClaudeAi`]): one of the user's claude.ai
//!   connectors (Gmail, Google Calendar, Slack…). The sign-in is held by
//!   claude.ai, not this Mac; Claude Code loads it into every turn of a
//!   claude.ai account, so a grant here is enforced by *not* blocking it
//!   (`--disallowedTools mcp__claude_ai_<Name>` for every other agent).
//! - **GitHub CLI** ([`Kind::Gh`]): the `gh` sign-in already on this Mac.
//!   Its token is `gh`'s own (in the Keychain, under `gh`'s item). Agents
//!   use it through `gh` commands, each of which asks unless read-only.
//! - Browser access is not a connection: it's per agent (`AgentReach`).
//!
//! **Grants.** Each connection lists the agents that may use it and how:
//! [`Access::Read`] (tools that only read go through; anything else is
//! refused) or [`Access::Full`] (reads go through; everything else asks on
//! a card, every time, unless the user chose Always allow for that tool).
//! Revoking a grant takes effect from the agent's next turn; deleting a
//! connection deletes its Keychain item too.
//!
//! The registry is `connections.json` in the agents folder: names, accounts
//! and grants only. Shared by every window, guarded by one lock.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use super::store;
use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Only tools that read go through; the rest are refused.
    #[default]
    Read,
    /// Reads go through; anything that writes, sends, posts or pays asks.
    Full,
}

impl Access {
    pub fn label(self) -> &'static str {
        match self {
            Access::Read => "Can read",
            Access::Full => "Can read; asks before it sends or changes anything",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub agent_id: String,
    pub access: Access,
    pub granted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Kind {
    /// A remote MCP server we signed in to. Tokens are in the Keychain.
    #[serde(rename_all = "camelCase")]
    Oauth { server_url: String },
    /// A claude.ai connector, by its name in Claude Code ("claude.ai Gmail").
    #[serde(rename_all = "camelCase")]
    ClaudeAi { server_name: String },
    /// The GitHub CLI's own sign-in.
    Gh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    /// The catalogue's id (`logins::Service::id`): "gmail", "linear".
    pub service: String,
    /// "Linear".
    pub title: String,
    /// Which account, as the user named it or the sign-in told us
    /// ("sam@acme.com", "Work"). Two of one service are told apart by it.
    pub account: String,
    pub kind: Kind,
    /// The MCP server name a turn sees it as (`mcp__<serverKey>__<tool>`).
    pub server_key: String,
    pub created_at: i64,
    #[serde(default)]
    pub grants: Vec<Grant>,
    /// The last sign-in stopped working (a refresh was refused): it needs
    /// signing in again, and turns don't get it until then.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_sign_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Connection {
    pub fn grant_for(&self, agent_id: &str) -> Option<&Grant> {
        self.grants.iter().find(|g| g.agent_id == agent_id)
    }

    /// Where its sign-in is kept, in the UI's words.
    pub fn kept(&self) -> &'static str {
        match self.kind {
            Kind::Oauth { .. } => "Signed in on this Mac; the token is in its Keychain",
            Kind::ClaudeAi { .. } => "Connected on claude.ai; the sign-in is held there",
            Kind::Gh => "GitHub CLI sign-in on this Mac",
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    #[serde(default)]
    connections: Vec<Connection>,
}

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(Default::default);

fn path() -> Result<PathBuf, CommandError> {
    Ok(store::agents_root()?.join("connections.json"))
}

fn read() -> Result<Registry, CommandError> {
    let path = path()?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[Agents] connections.json unreadable ({e}); starting empty");
            Registry::default()
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(e) => Err(super::err_io(e)),
    }
}

fn write(registry: &Registry) -> Result<(), CommandError> {
    let path = path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(super::err_io)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(registry).map_err(super::err_other)?;
    std::fs::write(&tmp, text).map_err(super::err_io)?;
    std::fs::rename(&tmp, &path).map_err(super::err_io)
}

fn change<T>(f: impl FnOnce(&mut Registry) -> T) -> Result<T, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read()?;
    let out = f(&mut registry);
    write(&registry)?;
    Ok(out)
}

pub fn list() -> Result<Vec<Connection>, CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(read()?.connections)
}

pub fn get(id: &str) -> Result<Option<Connection>, CommandError> {
    Ok(list()?.into_iter().find(|c| c.id == id))
}

/// Every connection to `service`, granted to `agent_id` or not.
pub fn for_service(service: &str) -> Vec<Connection> {
    list()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.service == service)
        .collect()
}

/// The connections `agent_id` may use.
pub fn granted_to(agent_id: &str) -> Vec<(Connection, Access)> {
    list()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| {
            let access = c.grant_for(agent_id)?.access;
            Some((c, access))
        })
        .collect()
}

/* ---------------------------------------------------------------- vault */

fn service_name(connection_id: &str) -> String {
    format!(
        "{}{connection_id}",
        crate::brand::keychain_prefix("connection")
    )
}

const TOKEN_KEY: &str = "oauth";

/// What's kept in the Keychain for an OAuth connection. Never serialized
/// anywhere else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix ms; `None` when the server didn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// The MCP server the token is for (the OAuth `resource`).
    pub resource: String,
}

#[cfg(not(test))]
mod vault {
    use crate::commands::accounts::{keychain_delete, keychain_read, keychain_write};
    use crate::errors::CommandError;
    pub fn put(service: &str, key: &str, value: &str) -> Result<(), CommandError> {
        keychain_write(service, key, value)
    }
    pub fn get(service: &str, key: &str) -> Option<String> {
        keychain_read(service, key)
    }
    pub fn delete(service: &str, key: &str) {
        keychain_delete(service, key)
    }
}

/// Tests never touch the real Keychain.
#[cfg(test)]
pub(crate) mod vault {
    pub use crate::agents::secrets::vault::{delete, get, put};
}

pub fn store_tokens(connection_id: &str, tokens: &Tokens) -> Result<(), CommandError> {
    let text = serde_json::to_string(tokens).map_err(super::err_other)?;
    vault::put(&service_name(connection_id), TOKEN_KEY, &text)?;
    // The access and refresh tokens are scrubbed from anything Agents
    // writes or shows, like a secret's value.
    super::secrets::remember_external(&tokens.access_token, "connection token");
    if let Some(refresh) = &tokens.refresh_token {
        super::secrets::remember_external(refresh, "connection token");
    }
    Ok(())
}

pub fn tokens(connection_id: &str) -> Option<Tokens> {
    vault::get(&service_name(connection_id), TOKEN_KEY).and_then(|t| serde_json::from_str(&t).ok())
}

/// At launch: every token, so redaction holds before any turn runs.
pub fn load_known() {
    for c in list().unwrap_or_default() {
        if let Some(t) = tokens(&c.id) {
            super::secrets::remember_external(&t.access_token, "connection token");
            if let Some(r) = &t.refresh_token {
                super::secrets::remember_external(r, "connection token");
            }
        }
    }
}

/* ------------------------------------------------------------- changing */

/// A short MCP server name for a turn: letters, digits and `_`, unique
/// among connections ("linear", "gmail_work").
fn server_key_for(service: &str, account: &str, taken: &[String]) -> String {
    let clean = |s: &str| {
        let mut out = String::new();
        for c in s.chars() {
            if c.is_ascii_alphanumeric() {
                out.push(c.to_ascii_lowercase());
            } else if !out.ends_with('_') && !out.is_empty() {
                out.push('_');
            }
        }
        out.trim_end_matches('_')
            .chars()
            .take(24)
            .collect::<String>()
    };
    let base = clean(service);
    let base = if base.is_empty() {
        "app".to_string()
    } else {
        base
    };
    if !taken.contains(&base) {
        return base;
    }
    let with = format!("{base}_{}", clean(account));
    if !with.ends_with('_') && !taken.contains(&with) {
        return with;
    }
    (2..)
        .map(|n| format!("{base}_{n}"))
        .find(|k| !taken.contains(k))
        .unwrap_or(base)
}

/// Add a connection (or, for one already there with the same service,
/// kind and account, return that one) and grant it to `agent_id`.
pub fn add_and_grant(
    service: &str,
    title: &str,
    account: &str,
    kind: Kind,
    agent_id: &str,
    access: Access,
) -> Result<Connection, CommandError> {
    let account = account.trim();
    change(|r| {
        // No account named: the one already there for this service, if any.
        let existing = r.connections.iter().position(|c| {
            c.service == service
                && c.kind == kind
                && (account.is_empty() || c.account.eq_ignore_ascii_case(account))
        });
        let index = match existing {
            Some(i) => i,
            None => {
                let taken: Vec<String> =
                    r.connections.iter().map(|c| c.server_key.clone()).collect();
                let server_key = match &kind {
                    Kind::ClaudeAi { server_name } => claude_tool_key(server_name),
                    _ => server_key_for(service, account, &taken),
                };
                let account = if account.is_empty() {
                    let n = r
                        .connections
                        .iter()
                        .filter(|c| c.service == service)
                        .count();
                    if n == 0 {
                        title.to_string()
                    } else {
                        format!("{title} {}", n + 1)
                    }
                } else {
                    account.to_string()
                };
                r.connections.push(Connection {
                    id: store::new_id(),
                    service: service.to_string(),
                    title: title.to_string(),
                    account,
                    kind,
                    server_key,
                    created_at: store::now_ms(),
                    grants: Vec::new(),
                    needs_sign_in: false,
                    last_used_at: None,
                    extra: Default::default(),
                });
                r.connections.len() - 1
            }
        };
        let c = &mut r.connections[index];
        c.needs_sign_in = false;
        upsert_grant(c, agent_id, access);
        c.clone()
    })
}

fn upsert_grant(c: &mut Connection, agent_id: &str, access: Access) {
    match c.grants.iter_mut().find(|g| g.agent_id == agent_id) {
        // Never narrowed by a second card: a read request on top of a full
        // grant leaves it full.
        Some(g) => {
            if access == Access::Full {
                g.access = Access::Full;
            }
        }
        None => c.grants.push(Grant {
            agent_id: agent_id.to_string(),
            access,
            granted_at: store::now_ms(),
        }),
    }
}

/// Let `agent_id` use an existing connection.
pub fn grant(
    connection_id: &str,
    agent_id: &str,
    access: Access,
) -> Result<Connection, CommandError> {
    change(|r| {
        let c = r
            .connections
            .iter_mut()
            .find(|c| c.id == connection_id)
            .ok_or_else(|| CommandError::expected("That connection is gone."))?;
        upsert_grant(c, agent_id, access);
        Ok(c.clone())
    })?
}

/// Stop `agent_id` using it. The connection stays for the others.
pub fn revoke(connection_id: &str, agent_id: &str) -> Result<(), CommandError> {
    change(|r| {
        if let Some(c) = r.connections.iter_mut().find(|c| c.id == connection_id) {
            c.grants.retain(|g| g.agent_id != agent_id);
        }
    })
}

/// Rename the account ("Work", "Personal").
pub fn rename(connection_id: &str, account: &str) -> Result<Connection, CommandError> {
    let account = account.trim();
    if account.is_empty() || account.chars().count() > 80 {
        return Err(super::err_invalid("account", "Give it a short name."));
    }
    change(|r| {
        let c = r
            .connections
            .iter_mut()
            .find(|c| c.id == connection_id)
            .ok_or_else(|| CommandError::expected("That connection is gone."))?;
        c.account = account.to_string();
        Ok(c.clone())
    })?
}

/// Delete it for everyone, and its Keychain item.
pub fn delete(connection_id: &str) -> Result<(), CommandError> {
    change(|r| r.connections.retain(|c| c.id != connection_id))?;
    vault::delete(&service_name(connection_id), TOKEN_KEY);
    Ok(())
}

/// An agent is being deleted: it loses every grant.
pub fn forget_agent(agent_id: &str) {
    let _ = change(|r| {
        for c in &mut r.connections {
            c.grants.retain(|g| g.agent_id != agent_id);
        }
    });
}

fn mark(connection_id: &str, f: impl FnOnce(&mut Connection)) {
    let _ = change(|r| {
        if let Some(c) = r.connections.iter_mut().find(|c| c.id == connection_id) {
            f(c);
        }
    });
}

/* ---------------------------------------------------------- tool names */

/// The middle part of a claude.ai connector's tool names, as Claude Code
/// makes it: "claude.ai Google Calendar" → `claude_ai_Google_Calendar`
/// (observed: `mcp__claude_ai_Claude_Docs__batch`).
pub fn claude_tool_key(server_name: &str) -> String {
    server_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// A tool name's server part and tool part: `mcp__linear__list_issues` →
/// (`linear`, `list_issues`).
fn split_tool(tool: &str) -> Option<(&str, &str)> {
    let rest = tool.strip_prefix("mcp__")?;
    rest.split_once("__")
}

/// Whether a tool only reads, from its name. Anything we can't tell is a
/// write: it asks.
pub fn reads_only(tool_name: &str) -> bool {
    let t = tool_name.to_ascii_lowercase();
    const READ: &[&str] = &[
        "get", "list", "search", "read", "fetch", "find", "query", "view", "describe", "show",
        "lookup", "retrieve", "whoami", "me", "count",
    ];
    let first = t
        .split(|c: char| c == '_' || c == '-' || c == '.')
        .next()
        .unwrap_or("");
    // camelCase: "getIssue", "listChannels".
    let lead: String = tool_name
        .chars()
        .take_while(|c| c.is_ascii_lowercase())
        .collect();
    READ.contains(&first) || READ.contains(&lead.as_str())
}

/// What `decide` does with a tool call from `agent_id`, before any card.
#[derive(Debug, PartialEq)]
pub enum Gate {
    /// Not one of the agent's connections: the usual rules apply.
    Ask,
    /// A read through a connection it was granted: no card.
    Allow,
    /// Not allowed by its grant; the agent is told why.
    Refuse(String),
}

pub fn gate(agent_id: &str, tool: &str) -> Gate {
    let Some((server, name)) = split_tool(tool) else {
        return Gate::Ask;
    };
    let connections = list().unwrap_or_default();
    let Some(c) = connections.iter().find(|c| c.server_key == server) else {
        return Gate::Ask;
    };
    gate_for(c, agent_id, name)
}

fn gate_for(c: &Connection, agent_id: &str, tool: &str) -> Gate {
    match c.grant_for(agent_id) {
        // A claude.ai connector this agent hasn't been granted is blocked by
        // `--disallowedTools` already; one we serve isn't in its config. If a
        // call arrives anyway, the user still decides on a card.
        None => Gate::Ask,
        Some(g) if reads_only(tool) => {
            let _ = g;
            mark(&c.id, |c| c.last_used_at = Some(store::now_ms()));
            Gate::Allow
        }
        Some(g) if g.access == Access::Read => Gate::Refuse(format!(
            "You may only read {} ({}): `{tool}` would change something. If the user wants you to, ask with request_login for \"{}\" with the abilities it needs, and they'll be asked on a card.",
            c.title, c.account, c.service
        )),
        Some(_) => Gate::Ask,
    }
}

/* ------------------------------------------------------------- turns */

/// One server a turn gets, with its token. Lives only as long as the turn's
/// setup: the token goes into the 0600 config file or the process's
/// environment, nowhere else.
#[derive(Clone)]
pub struct TurnServer {
    pub key: String,
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for TurnServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnServer")
            .field("key", &self.key)
            .field("url", &self.url)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// What a turn of `agent` can reach beyond its own tools: our servers with
/// fresh tokens, the claude.ai connectors it must not see, and lines for
/// its prompt.
#[derive(Debug, Default)]
pub struct TurnAccess {
    pub servers: Vec<TurnServer>,
    /// `mcp__<name>` entries for `--disallowedTools`.
    pub blocked: Vec<String>,
    pub browser: bool,
    pub prompt: String,
}

impl TurnAccess {
    /// Codex: one `-c` per server, its token read from an environment
    /// variable whose name has `TOKEN` in it, so Codex's default shell
    /// policy keeps it out of the commands it runs.
    pub fn codex_config(&self) -> Vec<String> {
        self.servers
            .iter()
            .map(|s| {
                format!(
                    "mcp_servers.{}={{url={},bearer_token_env_var={}}}",
                    s.key,
                    toml(&s.url),
                    toml(&env_name(&s.key))
                )
            })
            .collect()
    }

    pub fn codex_env(&self) -> Vec<(String, String)> {
        self.servers
            .iter()
            .map(|s| (env_name(&s.key), s.token.clone()))
            .collect()
    }

    /// Claude Code: the servers for the turn's `--mcp-config` file.
    pub fn claude_servers(&self) -> serde_json::Map<String, serde_json::Value> {
        self.servers
            .iter()
            .map(|s| {
                (
                    s.key.clone(),
                    serde_json::json!({
                        "type": "http",
                        "url": s.url,
                        "headers": { "Authorization": format!("Bearer {}", s.token) },
                    }),
                )
            })
            .collect()
    }
}

fn toml(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

pub fn env_name(key: &str) -> String {
    format!("SHIPSTUDIO_CONN_{}_TOKEN", key.to_ascii_uppercase())
}

/// Everything a turn of `agent` gets. Refreshes tokens that are about to
/// expire; a refresh the server refuses marks the connection as needing a
/// new sign-in, and the turn goes without it (its prompt says so).
pub async fn for_turn(agent: &store::Agent) -> TurnAccess {
    let all = list().unwrap_or_default();
    let mut access = TurnAccess {
        browser: !agent.reach.browser_off,
        ..Default::default()
    };
    let mut lines = Vec::new();
    for c in &all {
        let grant = c.grant_for(&agent.id);
        match (&c.kind, grant) {
            (Kind::ClaudeAi { server_name }, None) => {
                access
                    .blocked
                    .push(format!("mcp__{}", claude_tool_key(server_name)));
            }
            (Kind::ClaudeAi { .. }, Some(g)) => {
                if agent.engine == super::engine::Engine::Claude {
                    lines.push(line(c, g.access));
                }
            }
            (Kind::Gh, Some(g)) => lines.push(format!(
                "- {} ({}): use the `gh` command. {}",
                c.title,
                c.account,
                g.access.label()
            )),
            (Kind::Oauth { server_url }, Some(g)) => {
                if c.needs_sign_in {
                    lines.push(format!(
                        "- {} ({}) needs signing in again. If you need it, ask with request_login for \"{}\".",
                        c.title, c.account, c.service
                    ));
                    continue;
                }
                match fresh_token(c).await {
                    Some(token) => {
                        access.servers.push(TurnServer {
                            key: c.server_key.clone(),
                            url: server_url.clone(),
                            token,
                        });
                        lines.push(line(c, g.access));
                    }
                    None => lines.push(format!(
                        "- {} ({}) couldn't be reached this turn: its sign-in needs renewing. If you need it, ask with request_login for \"{}\".",
                        c.title, c.account, c.service
                    )),
                }
            }
            _ => {}
        }
    }
    // Apps the user blocked for this agent (Claude Code's own, every agent's by default).
    for name in &agent.reach.blocked_apps {
        let entry = format!("mcp__{}", claude_tool_key(name));
        if !access.blocked.contains(&entry) {
            access.blocked.push(entry);
        }
    }
    if !lines.is_empty() {
        access.prompt = format!(
            "### Apps you're signed in to\n\nThrough the user's own sign-in, for this agent:\n\n{}\n\nTools that read go straight through. Anything that sends, posts, changes or pays asks the user on a card first; a read-only grant refuses it.",
            lines.join("\n")
        );
    }
    access
}

fn line(c: &Connection, access: Access) -> String {
    format!(
        "- {} ({}): tools named `mcp__{}__*`. {}",
        c.title,
        c.account,
        c.server_key,
        access.label()
    )
}

/// A usable access token, refreshed when it expires within two minutes.
async fn fresh_token(c: &Connection) -> Option<String> {
    let t = tokens(&c.id)?;
    let soon = store::now_ms() + 120_000;
    if t.expires_at.is_none_or(|at| at > soon) {
        mark(&c.id, |c| c.last_used_at = Some(store::now_ms()));
        return Some(t.access_token);
    }
    match super::oauth::refresh(&t).await {
        Ok(new) => {
            let _ = store_tokens(&c.id, &new);
            mark(&c.id, |c| c.last_used_at = Some(store::now_ms()));
            Some(new.access_token)
        }
        Err(super::oauth::RefreshError::Refused) => {
            mark(&c.id, |c| c.needs_sign_in = true);
            None
        }
        Err(super::oauth::RefreshError::Unreachable) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_root<F: FnOnce(&std::path::Path)>(f: F) {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        f(dir.path());
        store::set_root_for_tests(None);
    }

    fn oauth(url: &str) -> Kind {
        Kind::Oauth {
            server_url: url.into(),
        }
    }

    fn tokens_for(access: &str) -> Tokens {
        Tokens {
            access_token: access.into(),
            refresh_token: Some(format!("{access}-refresh")),
            expires_at: None,
            token_endpoint: "https://mcp.linear.app/token".into(),
            client_id: "client-1".into(),
            client_secret: None,
            resource: "https://mcp.linear.app/mcp".into(),
        }
    }

    fn grep(dir: &std::path::Path, needle: &str) -> Vec<PathBuf> {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                std::fs::read(e.path())
                    .map(|b| String::from_utf8_lossy(&b).contains(needle))
                    .unwrap_or(false)
            })
            .map(|e| e.path().to_path_buf())
            .collect()
    }

    #[test]
    fn a_grant_is_per_agent_and_revocable() {
        with_root(|_| {
            let c = add_and_grant(
                "linear",
                "Linear",
                "sam@acme.com",
                oauth("https://mcp.linear.app/mcp"),
                "recruiter",
                Access::Read,
            )
            .unwrap();
            assert_eq!(c.server_key, "linear");
            assert_eq!(granted_to("recruiter").len(), 1);
            assert!(granted_to("social").is_empty());
            grant(&c.id, "social", Access::Full).unwrap();
            assert_eq!(granted_to("social")[0].1, Access::Full);
            // A second, narrower card never narrows an existing grant.
            grant(&c.id, "social", Access::Read).unwrap();
            assert_eq!(granted_to("social")[0].1, Access::Full);
            revoke(&c.id, "recruiter").unwrap();
            assert!(granted_to("recruiter").is_empty());
            assert_eq!(granted_to("social").len(), 1);
            forget_agent("social");
            assert!(granted_to("social").is_empty());
            assert_eq!(list().unwrap().len(), 1, "the connection itself stays");
        });
    }

    #[test]
    fn two_accounts_of_one_service_are_two_named_connections() {
        with_root(|_| {
            let work = add_and_grant(
                "gmail",
                "Gmail",
                "work@acme.com",
                Kind::ClaudeAi {
                    server_name: "claude.ai Gmail".into(),
                },
                "a",
                Access::Read,
            )
            .unwrap();
            let home = add_and_grant(
                "linear",
                "Linear",
                "",
                oauth("https://mcp.linear.app/mcp"),
                "a",
                Access::Read,
            )
            .unwrap();
            let second = add_and_grant(
                "linear",
                "Linear",
                "",
                oauth("https://mcp.linear.app/mcp"),
                "b",
                Access::Read,
            )
            .unwrap();
            assert_eq!(home.id, second.id, "same account, same connection");
            let other = add_and_grant(
                "linear",
                "Linear",
                "personal",
                oauth("https://mcp.linear.app/mcp"),
                "b",
                Access::Read,
            )
            .unwrap();
            assert_ne!(other.id, home.id);
            assert_ne!(other.server_key, home.server_key);
            assert_eq!(other.server_key, "linear_personal");
            assert_eq!(work.server_key, "claude_ai_Gmail");
            assert_eq!(home.account, "Linear");
            let renamed = rename(&home.id, "Work").unwrap();
            assert_eq!(renamed.account, "Work");
            assert_eq!(for_service("linear").len(), 2);
        });
    }

    #[test]
    fn tokens_live_only_in_the_keychain_never_in_the_agents_folder() {
        with_root(|root| {
            let c = add_and_grant(
                "linear",
                "Linear",
                "",
                oauth("https://mcp.linear.app/mcp"),
                "recruiter",
                Access::Full,
            )
            .unwrap();
            store_tokens(&c.id, &tokens_for("lin_oauth_access_abcdef123456")).unwrap();
            assert_eq!(
                tokens(&c.id).unwrap().access_token,
                "lin_oauth_access_abcdef123456"
            );
            assert!(
                grep(root, "lin_oauth_access_abcdef123456").is_empty(),
                "registry and homes hold no token"
            );
            assert!(grep(root, "lin_oauth_access_abcdef123456-refresh").is_empty());
            // Scrubbed from anything Agents writes.
            assert!(
                !super::super::secrets::redact("token lin_oauth_access_abcdef123456")
                    .contains("abcdef123456")
            );
            // The registry's JSON never carries it either.
            assert!(!serde_json::to_string(&list().unwrap())
                .unwrap()
                .contains("abcdef"));
            delete(&c.id).unwrap();
            assert!(
                tokens(&c.id).is_none(),
                "deleting removes the Keychain item"
            );
        });
    }

    #[test]
    fn turns_get_only_their_granted_servers_and_blocks_for_the_rest() {
        with_root(|_| {
            let mut recruiter = store::create(store::NewAgent {
                name: "Recruiter".into(),
                role: String::new(),
                instructions: String::new(),
                shape: None,
                color: None,
                is_main: false,
            })
            .unwrap();
            let social = store::create(store::NewAgent {
                name: "Social".into(),
                role: String::new(),
                instructions: String::new(),
                shape: None,
                color: None,
                is_main: false,
            })
            .unwrap();
            let c = add_and_grant(
                "linear",
                "Linear",
                "",
                oauth("https://mcp.linear.app/mcp"),
                &recruiter.id,
                Access::Read,
            )
            .unwrap();
            store_tokens(&c.id, &tokens_for("lin_turn_token_998877")).unwrap();
            add_and_grant(
                "gmail",
                "Gmail",
                "",
                Kind::ClaudeAi {
                    server_name: "claude.ai Gmail".into(),
                },
                &social.id,
                Access::Full,
            )
            .unwrap();
            recruiter.reach.blocked_apps = vec!["figma".into()];
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let h = rt.block_on(for_turn(&recruiter));
            assert_eq!(h.servers.len(), 1);
            assert_eq!(h.servers[0].token, "lin_turn_token_998877");
            assert!(
                h.blocked.contains(&"mcp__claude_ai_Gmail".to_string()),
                "{:?}",
                h.blocked
            );
            assert!(h.blocked.contains(&"mcp__figma".to_string()));
            assert!(h.prompt.contains("mcp__linear__*"));
            assert!(
                !h.prompt.contains("lin_turn_token"),
                "the prompt never carries a token"
            );
            assert!(
                !format!("{h:?}").contains("lin_turn_token"),
                "nor does a log line"
            );
            let config = h.codex_config();
            assert_eq!(config, vec![r#"mcp_servers.linear={url="https://mcp.linear.app/mcp",bearer_token_env_var="SHIPSTUDIO_CONN_LINEAR_TOKEN"}"#.to_string()]);
            assert!(
                !config.concat().contains("lin_turn_token"),
                "argv never carries it"
            );
            assert_eq!(
                h.codex_env(),
                vec![(
                    "SHIPSTUDIO_CONN_LINEAR_TOKEN".into(),
                    "lin_turn_token_998877".into()
                )]
            );

            let s = rt.block_on(for_turn(&social));
            assert!(s.servers.is_empty());
            assert!(!s.blocked.contains(&"mcp__claude_ai_Gmail".to_string()));
            assert!(s.prompt.contains("mcp__claude_ai_Gmail__*"));
        });
    }

    #[test]
    fn reads_go_through_writes_ask_or_are_refused() {
        with_root(|_| {
            let c = add_and_grant(
                "linear",
                "Linear",
                "",
                oauth("https://mcp.linear.app/mcp"),
                "reader",
                Access::Read,
            )
            .unwrap();
            grant(&c.id, "writer", Access::Full).unwrap();
            assert_eq!(gate("reader", "mcp__linear__list_issues"), Gate::Allow);
            assert_eq!(gate("reader", "mcp__linear__getIssue"), Gate::Allow);
            assert!(matches!(
                gate("reader", "mcp__linear__create_issue"),
                Gate::Refuse(_)
            ));
            assert_eq!(gate("writer", "mcp__linear__create_issue"), Gate::Ask);
            assert_eq!(
                gate("writer", "mcp__linear__search_documentation"),
                Gate::Allow
            );
            assert_eq!(gate("stranger", "mcp__linear__list_issues"), Gate::Ask);
            assert_eq!(gate("reader", "Bash"), Gate::Ask);
            assert_eq!(gate("reader", "mcp__other__list"), Gate::Ask);
            assert!(!reads_only("send_email"));
            assert!(!reads_only("update"));
            assert!(reads_only("search_threads"));
        });
    }

    #[test]
    fn claude_ai_tool_keys_match_claude_codes() {
        assert_eq!(
            claude_tool_key("claude.ai Google Calendar"),
            "claude_ai_Google_Calendar"
        );
        assert_eq!(
            claude_tool_key("claude.ai Claude Docs"),
            "claude_ai_Claude_Docs"
        );
    }
}
