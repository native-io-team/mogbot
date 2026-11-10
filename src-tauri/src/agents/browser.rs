//! "Let agents use your browser": the user's own signed-in Chrome, through
//! Claude in Chrome, set up once and checked by the app.
//!
//! **The mechanism.** Claude Code's `--chrome` loads the `claude-in-chrome`
//! MCP server into a turn. It reaches the Claude in Chrome extension in the
//! user's Chrome, which must be signed in to the same claude.ai account as
//! Claude Code. Its tools open tabs, navigate, read a page's text or
//! accessibility tree, take screenshots, click, type and fill forms, all as
//! the user, in the browser they're already signed in to. Codex has no
//! equivalent here: a Codex agent never gets the browser.
//!
//! **Checked by the app, not by a model.** `claude --claude-in-chrome-mcp`
//! runs the same server on its own, over stdio; [`ChromeMcp`] speaks to it
//! directly. `list_connected_browsers` says whether the extension is
//! reachable, with no model turn and nothing opened ([`status`]). The flag
//! isn't in `claude --help`; it is what Claude Code's own `--chrome` starts,
//! and was verified on 2.1.318 (initialize, tools/list, tools/call).
//!
//! **One switch, then per agent.** The team's browser is off until the user
//! sets it up from the one guided card ("Let agents use your browser · Set
//! up"), which enables it only once the app has seen a connected browser.
//! From then on an agent uses it without asking first ([`for_turn`]), unless:
//! - the user took it away from that agent ("What it can reach"),
//! - the agent runs on Codex, or
//! - the turn answers text from outside (a "When…" routine's items, or a
//!   message carrying that taint through `message_agent` or a room). Such a
//!   turn runs `--no-chrome`: text from outside never drives the browser.
//!
//! **What still asks** (`browser_gate`): looking is free; clicks, typing and
//! forms go through at "Use good judgement" and "Go hard" unless they would
//! send, post, publish, pay, delete or share; scripts, uploads and shortcuts
//! always ask. Threat model: docs/agents.md, "Your browser".

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::engine::Engine;
use super::store::{self, Agent};
use crate::errors::CommandError;

/// Claude in Chrome's id in the Chrome Web Store.
pub const EXTENSION_ID: &str = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
/// Where it's installed from (Anthropic's page, which links the store).
pub const INSTALL_URL: &str = "https://claude.ai/chrome";
/// Fired when the setup or the switch changes.
pub const EVENT: &str = "agents://browser";
const STATE_FILE: &str = "browser.json";
/// The MCP server answers in well under a second when it's there.
const MCP_TIMEOUT: Duration = Duration::from_secs(20);
/// A page can take a while; a probe gives up rather than hang the pass.
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);

/* --------------------------------------------------------------- state */

/// What's kept: whether the user switched it on, and when it last worked.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_at: Option<i64>,
    /// The last time the app saw a connected browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<i64>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<PathBuf, CommandError> {
    Ok(store::agents_root()?.join(STATE_FILE))
}

pub fn load() -> Stored {
    let Ok(p) = path() else {
        return Stored::default();
    };
    let existed = p.exists();
    if let Some(kept) = super::survive::read_kept(&p, "Your browser setting for agents") {
        return kept;
    }
    // Decided once, and kept: the upgrade reads agents' sites, which the
    // access chain now also gives for the agents' own browser
    // (`access_chain`, `give_site`). Worked out afresh on every read, the
    // first "use the agents' browser" on a new team switched Claude in
    // Chrome on for every agent, with no setup and nothing verified (found
    // by the fake-engine suite). A damaged file starts off, not upgraded.
    let decided = if existed {
        Stored::default()
    } else {
        upgraded()
    };
    if store::may_write_root() {
        if let Err(e) = save(&decided) {
            tracing::warn!("[Agents] Couldn't keep the browser setting: {e}");
        }
    }
    decided
}

/// Before this switch existed every Claude Code agent had the browser, and
/// a user who chose "Use my browser" on a login card meant it: that team
/// starts switched on. Everyone else starts off, until they set it up.
/// Read once, the first time the setting is (see [`load`]).
fn upgraded() -> Stored {
    let chose = store::list()
        .unwrap_or_default()
        .iter()
        .any(|a| !a.reach.browser_sites.is_empty() && !a.reach.browser_off);
    Stored {
        enabled: chose,
        ..Default::default()
    }
}

fn save(s: &Stored) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec_pretty(s).map_err(super::err_other)?;
    store::write_atomic(&path()?, &bytes)
}

fn change(f: impl FnOnce(&mut Stored)) -> Result<Stored, CommandError> {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load();
    f(&mut s);
    save(&s)?;
    Ok(s)
}

/// The team's browser is switched on.
pub fn team_enabled() -> bool {
    load().enabled
}

/// Whether a turn of `agent` gets Claude in Chrome. `outside`: the turn
/// answers text from outside (see the module docs).
pub fn allowed(enabled: bool, agent: &Agent, outside: bool) -> bool {
    enabled && agent.engine == Engine::Claude && !agent.reach.browser_off && !outside
}

/// Whether a turn of `agent` has the user's own Chrome by any route:
/// Claude in Chrome ([`claude_in_chrome_for_turn`]), or the app's own
/// extension (`user_chrome`), for either engine.
pub fn for_turn(agent: &Agent, outside: bool) -> bool {
    claude_in_chrome_for_turn(agent, outside) || crate::user_chrome::for_turn(agent, outside)
}

/// [`allowed`] with the team's switch as it is now, and Claude in Chrome
/// not known to be down (`chrome_health`: the app's last check found no
/// browser answering): Claude in Chrome only.
pub fn claude_in_chrome_for_turn(agent: &Agent, outside: bool) -> bool {
    allowed(team_enabled(), agent, outside) && !super::chrome_health::known_down()
}

/* ------------------------------------------------------------- the gate */

pub use super::browser_gate::{gate, gate_with, Gate, Page, SERVER};

/// The host of a URL the agent asked to open, if it's a web URL.
fn host_of(url: &str) -> Option<String> {
    super::browser_gate::host_of(url)
}

/// Whether `host` is `site` or under it.
fn host_matches(host: &str, site: &str) -> bool {
    let h = host.trim_start_matches("www.").to_ascii_lowercase();
    let s = site.trim_start_matches("www.").to_ascii_lowercase();
    !s.is_empty() && (h == s || h.ends_with(&format!(".{s}")))
}

/// The site each agent last opened in the browser, so a card can say where
/// (and as whom) an action happens. In memory: it's only for the card.
static OPENED: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

/// Remember where a navigation went, once it's going ahead.
pub fn note_opened(agent_id: &str, tool: &str, input: &Value) {
    let Some(name) = tool.strip_prefix(SERVER) else {
        return;
    };
    if !matches!(name, "navigate" | "tabs_create_mcp") {
        return;
    }
    if let Some(host) = input.get("url").and_then(Value::as_str).and_then(host_of) {
        OPENED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(Default::default)
            .insert(agent_id.to_string(), host);
    }
}

fn opened(agent_id: &str) -> Option<String> {
    OPENED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(agent_id).cloned())
}

fn quoted(v: Option<&Value>) -> Option<String> {
    let t = match v? {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let t: String = t.chars().take(600).collect();
    (!t.trim().is_empty()).then(|| format!("“{t}”"))
}

/// The Allow card for a browser action: what will happen, exactly, where,
/// and from which account. `site`/`account`: where the agent last opened a
/// page and who it was found signed in as there (`browser_profiles`). Pure.
pub fn card_for(
    tool: &str,
    input: &Value,
    site: Option<&str>,
    account: Option<&str>,
) -> Option<(String, String)> {
    let name = tool.strip_prefix(SERVER)?;
    let field = |k: &str| input.get(k);
    let (title, what) = match name {
        "navigate" | "tabs_create_mcp" => (
            "Open a page in your browser".to_string(),
            field("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        "computer" => {
            let action = field("action").and_then(Value::as_str).unwrap_or("");
            match action {
                "type" => ("Type in your browser".into(), format!("Types {}", quoted(field("text")).unwrap_or_default())),
                "key" => ("Press keys in your browser".into(), format!("Presses {}", quoted(field("text")).unwrap_or_default())),
                a if a.contains("click") => (
                    "Click in your browser".into(),
                    format!(
                        "{} at {} on the page. What it sends, if anything, is what the agent said in chat just before.",
                        a.replace('_', " "),
                        field("coordinate").or_else(|| field("ref")).map(Value::to_string).unwrap_or_else(|| "a spot".into())
                    ),
                ),
                a => ("Act in your browser".into(), a.replace('_', " ")),
            }
        }
        "form_input" => (
            "Fill in a form in your browser".into(),
            format!(
                "Sets a field to {}",
                quoted(field("value")).unwrap_or_else(|| "(empty)".into())
            ),
        ),
        "javascript_tool" => (
            "Run a script on a page in your browser".into(),
            quoted(field("text").or_else(|| field("code"))).unwrap_or_default(),
        ),
        "file_upload" | "upload_image" => (
            "Upload a file in your browser".into(),
            quoted(
                field("paths")
                    .or_else(|| field("path"))
                    .or_else(|| field("imageId")),
            )
            .unwrap_or_default(),
        ),
        "gif_creator" => (
            "Export a recording from your browser".into(),
            "A GIF of what it recorded".into(),
        ),
        _ => return None,
    };
    let from = match (site, account) {
        (Some(s), Some(a)) => format!("On {s}, as {a}."),
        (Some(s), None) => {
            format!("On {s}, as whoever is signed in there (it should have said who in chat).")
        }
        _ => "On the page open in your browser.".to_string(),
    };
    Some((title, format!("{what}\n\n{from}")))
}

/// [`card_for`] for `agent_id`, with what's known of where it is.
pub fn card(agent_id: &str, tool: &str, input: &Value) -> Option<(String, String)> {
    let site = opened(agent_id);
    let account = site
        .as_deref()
        .and_then(super::browser_profiles::remembered)
        .and_then(|r| r.account);
    card_for(tool, input, site.as_deref(), account.as_deref())
}

/// Give `agent` the browser for `site` (shown in "What it can reach").
pub fn give_site(agent_id: &str, site: &str) -> Result<(), CommandError> {
    store::update(agent_id, |a| {
        if !a.reach.browser_sites.iter().any(|s| s == site) {
            a.reach.browser_sites.push(site.to_string());
        }
    })?;
    Ok(())
}

/* ------------------------------------------------------- the MCP client */

/// Claude in Chrome's MCP server, run on its own (`claude
/// --claude-in-chrome-mcp`) and spoken to over stdio. One per check: it's
/// started, asked, and killed when dropped.
pub struct ChromeMcp {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    next: u64,
}

impl ChromeMcp {
    pub async fn start(claude: &std::path::Path) -> Result<ChromeMcp, CommandError> {
        use tokio::io::AsyncBufReadExt;
        let mut std_cmd = crate::utils::create_command(claude);
        std_cmd.arg("--claude-in-chrome-mcp");
        super::runner::strip_session_env(&mut std_cmd);
        std_cmd.env("PATH", crate::utils::get_extended_path());
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(super::err_io)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CommandError::expected("no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CommandError::expected("no stdout"))?;
        let mut mcp = ChromeMcp {
            child,
            stdin,
            lines: tokio::io::BufReader::new(stdout).lines(),
            next: 1,
        };
        mcp.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": crate::brand::SLUG, "version": env!("CARGO_PKG_VERSION") },
            }),
            MCP_TIMEOUT,
        )
        .await?;
        mcp.notify("notifications/initialized").await?;
        Ok(mcp)
    }

    async fn write(&mut self, v: &Value) -> Result<(), CommandError> {
        use tokio::io::AsyncWriteExt;
        let mut line = serde_json::to_vec(v).map_err(super::err_other)?;
        line.push(b'\n');
        self.stdin.write_all(&line).await.map_err(super::err_io)?;
        self.stdin.flush().await.map_err(super::err_io)
    }

    async fn notify(&mut self, method: &str) -> Result<(), CommandError> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method }))
            .await
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, CommandError> {
        let id = self.next;
        self.next += 1;
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        let read = async {
            while let Ok(Some(line)) = self.lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if v.get("id").and_then(Value::as_u64) == Some(id) {
                    return Some(v);
                }
            }
            None
        };
        let v = tokio::time::timeout(wait, read)
            .await
            .map_err(|_| CommandError::expected("Claude in Chrome didn't answer in time."))?
            .ok_or_else(|| CommandError::expected("Claude in Chrome stopped."))?;
        if let Some(e) = v.get("error") {
            return Err(CommandError::expected(format!(
                "Claude in Chrome: {}",
                e.get("message").and_then(Value::as_str).unwrap_or("error")
            )));
        }
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Call a tool; its text content, joined.
    pub async fn call(&mut self, tool: &str, args: Value) -> Result<String, CommandError> {
        Ok(text_of(&self.call_result(tool, args).await?))
    }

    /// Call a tool; its whole result (an image's data included).
    pub async fn call_result(&mut self, tool: &str, args: Value) -> Result<Value, CommandError> {
        let wait = if tool == "navigate" {
            PAGE_TIMEOUT
        } else {
            MCP_TIMEOUT
        };
        self.request(
            "tools/call",
            json!({ "name": tool, "arguments": args }),
            wait,
        )
        .await
    }

    /// Call a tool; its text, or its text as the error when the tool said
    /// it failed (`isError`), or the reason it couldn't be asked.
    pub async fn call_checked(&mut self, tool: &str, args: Value) -> Result<String, String> {
        match self.call_result(tool, args).await {
            Ok(r) if r.get("isError").and_then(Value::as_bool) == Some(true) => Err(text_of(&r)),
            Ok(r) => Ok(text_of(&r)),
            Err(e) => Err(e.to_string()),
        }
    }
}

impl Drop for ChromeMcp {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub(crate) fn text_of(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// How many browsers `list_connected_browsers` names. Its answer is a JSON
/// array (verified: `[]` with none); anything else counts as none.
pub fn count_browsers(text: &str) -> usize {
    serde_json::from_str::<Value>(text.trim())
        .ok()
        .and_then(|v| v.as_array().map(Vec::len))
        .unwrap_or(0)
}

/* ------------------------------------------------------------ the setup */

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepId {
    /// Claude Code installed and signed in with a claude.ai account.
    ClaudeCode,
    /// The extension in Chrome.
    Extension,
    /// The extension signed in to the same claude.ai account, and reachable.
    Connect,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: StepId,
    pub done: bool,
    pub title: String,
    pub detail: String,
    /// The one thing to press, when there is one: opens this URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_label: Option<String>,
}

/// The guided card, read fresh each time.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    /// The team's switch.
    pub enabled: bool,
    /// Every step done: a browser is connected right now.
    pub ready: bool,
    pub steps: Vec<Step>,
    /// The claude.ai account Claude Code is signed in with (the extension
    /// must use the same one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub browsers: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<i64>,
    /// Some agents run on Codex, which can't use it.
    pub codex_agents: usize,
}

/// What was found on this Mac, before it's put into words.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub claude_installed: bool,
    /// Signed in with a claude.ai account (not an API key, which keeps
    /// Claude in Chrome off).
    pub claude_ai: bool,
    pub account: Option<String>,
    pub extension_installed: bool,
    /// `None`: not asked (no Claude Code to ask with).
    pub browsers: Option<usize>,
}

/// The card's steps from what was found. Pure, for tests.
pub fn steps(f: &Facts) -> Vec<Step> {
    let account = f
        .account
        .as_deref()
        .map(|a| format!(" ({a})"))
        .unwrap_or_default();
    let code_ok = f.claude_installed && f.claude_ai;
    let connected = f.browsers.unwrap_or(0) > 0;
    vec![
        Step {
            id: StepId::ClaudeCode,
            done: code_ok,
            title: "Claude Code, signed in with your Claude account".into(),
            detail: if !f.claude_installed {
                "Agents use your browser through Claude Code. Set it up in Settings → Agents first.".into()
            } else if !f.claude_ai {
                "Claude Code is signed in with an API key, which can't use the browser. Sign it in with your Claude account.".into()
            } else {
                format!("Signed in{account}.")
            },
            open_url: None,
            open_label: None,
        },
        Step {
            id: StepId::Extension,
            done: f.extension_installed || connected,
            title: "Add Claude in Chrome to Chrome".into(),
            detail: "Anthropic's extension. It lets your agents use the sites you're signed in to, as you; it never sees your passwords.".into(),
            open_url: (!f.extension_installed && !connected).then(|| INSTALL_URL.to_string()),
            open_label: (!f.extension_installed && !connected).then(|| "Get the extension".to_string()),
        },
        Step {
            id: StepId::Connect,
            done: connected,
            title: "Sign the extension in".into(),
            detail: if connected {
                "Connected. Your agents can use Chrome now.".into()
            } else {
                format!("Open the extension in Chrome and sign in with the same Claude account as Claude Code{account}. If it was just installed, quit and reopen Chrome. Then check again.")
            },
            open_url: None,
            open_label: None,
        },
    ]
}

/// Claude in Chrome is in some Chrome profile on this Mac.
fn extension_installed() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let chrome = home.join("Library/Application Support/Google/Chrome");
    let Ok(entries) = std::fs::read_dir(&chrome) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().join("Extensions").join(EXTENSION_ID).is_dir())
}

/// `claude auth status`: signed in with claude.ai, and as whom.
async fn claude_account(claude: &std::path::Path) -> (bool, Option<String>) {
    let mut cmd = crate::utils::create_command(claude);
    cmd.args(["auth", "status"]);
    super::runner::strip_session_env(&mut cmd);
    let Ok(out) = crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "claude auth status",
        15,
    )
    .await
    else {
        return (false, None);
    };
    let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else {
        return (false, None);
    };
    let claude_ai = v.get("loggedIn").and_then(Value::as_bool) == Some(true)
        && v.get("authMethod").and_then(Value::as_str) == Some("claude.ai");
    let email = v.get("email").and_then(Value::as_str).map(str::to_string);
    (claude_ai, email)
}

/// How many browsers Claude in Chrome reaches right now.
pub async fn connected_browsers(claude: &std::path::Path) -> Result<usize, CommandError> {
    let mut mcp = ChromeMcp::start(claude).await?;
    let text = mcp.call("list_connected_browsers", json!({})).await?;
    super::chrome_health::note_answer(&text);
    Ok(count_browsers(&text))
}

/// The guided card, checked now: Claude Code's sign-in, the extension, and
/// whether a browser answers. Nothing is opened in Chrome.
pub async fn status() -> BrowserStatus {
    let mut facts = Facts {
        extension_installed: extension_installed(),
        ..Default::default()
    };
    if let Some(claude) = super::engine::binary(Engine::Claude).await {
        facts.claude_installed = true;
        let (claude_ai, account) = claude_account(&claude).await;
        facts.claude_ai = claude_ai;
        facts.account = account;
        if claude_ai {
            facts.browsers = Some(connected_browsers(&claude).await.unwrap_or(0));
        }
    }
    let ready = facts.browsers.unwrap_or(0) > 0;
    let stored = if ready {
        change(|s| s.verified_at = Some(store::now_ms())).unwrap_or_else(|_| load())
    } else {
        load()
    };
    BrowserStatus {
        enabled: stored.enabled,
        ready,
        steps: steps(&facts),
        account: facts.account,
        browsers: facts.browsers.unwrap_or(0),
        verified_at: stored.verified_at,
        codex_agents: store::list()
            .unwrap_or_default()
            .iter()
            .filter(|a| a.engine == Engine::Codex && !a.hidden)
            .count(),
    }
}

/// Switch the team's browser on: only once a browser answers. The error
/// names the first step still to do.
pub async fn enable(app: &AppHandle) -> Result<BrowserStatus, CommandError> {
    let mut st = status().await;
    if !st.ready {
        let todo = st.steps.iter().find(|s| !s.done);
        return Err(CommandError::expected(match todo {
            Some(s) => format!("Not yet: {}", s.title.to_lowercase()),
            None => "No browser answered yet. Open Chrome and check again.".into(),
        }));
    }
    let now = store::now_ms();
    change(|s| {
        s.enabled = true;
        s.enabled_at.get_or_insert(now);
    })?;
    st.enabled = true;
    let _ = app.emit(EVENT, &st);
    let _ = app.emit(super::runner::EVENT_REGISTRY, ());
    Ok(st)
}

pub fn disable(app: &AppHandle) -> Result<(), CommandError> {
    change(|s| s.enabled = false)?;
    let _ = app.emit(EVENT, ());
    let _ = app.emit(super::runner::EVENT_REGISTRY, ());
    Ok(())
}

/* ------------------------------------------------------------ probing */

/// Pages that send a signed-out visitor to a sign-in page, per service: the
/// probe opens one and looks at where it landed. A service not listed isn't
/// probed (an open home page says nothing about being signed in).
pub fn probe_url(service: &str) -> Option<&'static str> {
    Some(match service {
        "github" => "https://github.com/settings/profile",
        "figma" => "https://www.figma.com/files/recents-and-sharing",
        "linkedin" => "https://www.linkedin.com/feed/",
        "x" => "https://x.com/home",
        "gmail" => "https://mail.google.com/mail/u/0/",
        "google_calendar" => "https://calendar.google.com/calendar/u/0/r",
        "google_drive" => "https://drive.google.com/drive/my-drive",
        "notion" => "https://www.notion.so/",
        "linear" => "https://linear.app/",
        "slack" => "https://app.slack.com/client",
        "stripe" => "https://dashboard.stripe.com/dashboard",
        "vercel" => "https://vercel.com/dashboard",
        _ => return None,
    })
}

/// Where a probe ended up.
#[derive(Debug, Clone, PartialEq)]
pub struct Landed {
    pub url: String,
    pub title: String,
}

/// Signed in, from where the account page landed: `Some(true)` only when it
/// stayed on the service's own site and isn't a sign-in page; `Some(false)`
/// on a sign-in page; `None` when it can't be told.
pub fn signed_in(site: &str, landed: &Landed) -> Option<bool> {
    let lower = landed.url.to_ascii_lowercase();
    let title = landed.title.to_ascii_lowercase();
    const SIGN_IN: &[&str] = &[
        "/login",
        "/signin",
        "/sign-in",
        "/sign_in",
        "/session",
        "/auth",
        "accounts.google.com",
        "/uas/login",
        "/i/flow/login",
        "/checkpoint",
        "/authwall",
        // Signed out of Google, mail.google.com redirects to the product
        // page (observed: workspace.google.com/intl/…/gmail/), not to a
        // sign-in; Slack's signed-out pages likewise.
        "workspace.google.com",
        "google.com/gmail/about",
        "slack.com/get-started",
        "slack.com/workspace-signin",
    ];
    if SIGN_IN.iter().any(|w| lower.contains(w))
        || ["sign in", "log in", "login", "sign up"].iter().any(|w| {
            title.starts_with(w)
                || title.contains(&format!("{w} to"))
                || title.contains(&format!("{w} |"))
                || title.contains(&format!("| {w}"))
        })
    {
        return Some(false);
    }
    let host = host_of(&landed.url)?;
    host_matches(&host, site).then_some(true)
}

/// The first `http(s)` URL in a tool's text, and the tab id it names.
pub(crate) fn find_tab(text: &str) -> Option<u64> {
    // `tabs_create_mcp` / `tabs_context_mcp` answer with JSON or prose that
    // names "tabId": 123 / "Tab ID: 123". Unverified against a connected
    // browser: both shapes are read.
    let v: Option<Value> = serde_json::from_str(text.trim()).ok();
    if let Some(id) = v.as_ref().and_then(|v| {
        v.get("tabId")
            .or_else(|| v.get("id"))
            .and_then(Value::as_u64)
    }) {
        return Some(id);
    }
    let lower = text.to_ascii_lowercase();
    for key in ["tabid\":", "tab id:", "tabid:", "tab_id\":", "tab "] {
        if let Some(at) = lower.find(key) {
            let rest = &text[at + key.len()..];
            let digits: String = rest
                .trim_start_matches(|c: char| c.is_whitespace() || c == '"' || c == '#')
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(id) = digits.parse() {
                return Some(id);
            }
        }
    }
    None
}

/// The URL and title a tab shows, from `tabs_context_mcp`'s answer.
pub(crate) fn landed_in(text: &str, tab: Option<u64>) -> Option<Landed> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let tabs = v
        .get("availableTabs")
        .or_else(|| v.get("tabs"))
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| v.as_array().cloned())?;
    let pick = tabs
        .iter()
        .find(|t| {
            tab.is_some()
                && t.get("tabId")
                    .or_else(|| t.get("id"))
                    .and_then(Value::as_u64)
                    == tab
        })
        .or_else(|| tabs.last())?;
    Some(Landed {
        url: pick.get("url").and_then(Value::as_str)?.to_string(),
        title: pick
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// The group's one tab, when it's an empty new tab (what
/// `tabs_context_mcp {createIfEmpty}` makes along with a new group): used
/// rather than opening a second, so closing it leaves nothing behind.
/// Verified 2.1.318: `{"availableTabs":[{"tabId":…,"title":"New Tab","url":"chrome://newtab/"}],…}`.
pub(crate) fn only_blank_tab(text: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let tabs = v.get("availableTabs").and_then(Value::as_array)?;
    match tabs.as_slice() {
        [t] if t.get("url").and_then(Value::as_str) == Some("chrome://newtab/") => {
            t.get("tabId").and_then(Value::as_u64)
        }
        _ => None,
    }
}

/// Open `service`'s account page in a new tab of the user's Chrome, see
/// where it lands, and close the tab. Nothing is clicked or typed; only the
/// one page for the service asked about is opened. `None`: it couldn't be
/// told (no probe page, no browser, an answer it couldn't read).
pub async fn probe(mcp: &mut ChromeMcp, service: &str, site: &str) -> Option<bool> {
    let url = probe_url(service)?;
    let _ = mcp
        .call("tabs_context_mcp", json!({ "createIfEmpty": true }))
        .await
        .ok()?;
    let created = mcp.call("tabs_create_mcp", json!({})).await.ok()?;
    let tab = find_tab(&created);
    let mut nav = json!({ "url": url });
    if let Some(t) = tab {
        nav["tabId"] = json!(t);
    }
    mcp.call("navigate", nav).await.ok()?;
    let context = mcp.call("tabs_context_mcp", json!({})).await.ok()?;
    let landed = landed_in(&context, tab);
    if let Some(t) = tab {
        let _ = mcp.call("tabs_close_mcp", json!({ "tabId": t })).await;
    }
    signed_in(site, &landed?)
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;
