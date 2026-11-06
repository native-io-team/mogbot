//! Sign in on your Mac, from your phone (`agents.signin*`).
//!
//! An agent that opened a site in the user's Chrome and found a sign-in page
//! raises a login card. Away from the Mac, the user taps **Sign in from
//! here**: this Mac opens that site's sign-in page in a tab of its own in the
//! user's Chrome (Claude in Chrome's own MCP server, the same one the app
//! already uses for its checks, `browser::ChromeMcp`), and the phone gets a
//! live picture of that one tab and sends back taps, typing, keys and
//! scrolls. **Done** checks the page here; signed in, the card answers itself
//! "Using your browser" and the agent carries on.
//!
//! The mechanism, and why: docs/agents.md, "Signing in on your Mac from the phone".
//!
//! What holds, tested in `phone_signin_tests.rs`:
//! - **Only the human, only a paired phone.** It's reachable only through the
//!   companion router (a socket that authenticated as a paired device); no
//!   agent tool calls it. Every frame and input names a session, and only the
//!   device that began it may use it ([`Table::check`]).
//! - **One tab, one site.** The tab is the app's own. Its page is shown and
//!   driven only while it's on the card's site or a known sign-in provider
//!   ([`Scope::allows`]); anywhere else the phone sees "outside the sign-in"
//!   and may only go Back. No address bar, no shortcuts: [`Key`] is a short
//!   list of editing keys.
//! - **What's typed is never kept.** [`Input`]'s `Debug` names a length,
//!   never the text; the router doesn't audit frames or inputs; the audit
//!   line is the domain and the outcome. Nothing reaches an agent or a model:
//!   agents' browser calls are refused while a session is live
//!   (`browser_gate::gate`), and frames go only to the phone that asked.
//! - **It ends.** Five minutes with no input from the phone, twenty in all,
//!   Stop on either device, or Done.
//! - **The Mac says so.** A bar on every conversation on the desk, "Your
//!   phone is signing in to figma.com", with Stop ([`EVENT`]).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::browser::ChromeMcp;
use crate::errors::CommandError;

/// No input from the phone for this long and the session ends.
pub const IDLE: Duration = Duration::from_secs(5 * 60);
/// However busy, a session ends after this long.
pub const MAX_AGE: Duration = Duration::from_secs(20 * 60);
/// What one `type` may carry: a password or a code, never a document.
pub const MAX_TEXT: usize = 256;
/// The widest frame sent: plenty for a phone, small enough to stream.
pub const FRAME_WIDTH: u32 = 1000;
/// The desk's bar listens for this.
pub const EVENT: &str = "agents://phone-signin";

/* ---------------------------------------------------------------- scope */

/// Sign-in providers a site's "Sign in with …" sends people to. Exact hosts.
pub const IDP_HOSTS: &[&str] = &[
    "accounts.google.com",
    "accounts.youtube.com",
    "login.microsoftonline.com",
    "login.microsoft.com",
    "login.live.com",
    "account.live.com",
    "appleid.apple.com",
    "idmsa.apple.com",
    "github.com",
    "www.facebook.com",
    "m.facebook.com",
    "slack.com",
];

/// Single sign-on providers whose tenants live under them (acme.okta.com).
pub const IDP_SUFFIXES: &[&str] = &[
    "okta.com",
    "oktapreview.com",
    "auth0.com",
    "onelogin.com",
    "duosecurity.com",
    "jumpcloud.com",
];

/// A site that signs in on a second domain of its own.
const SIBLINGS: &[(&str, &[&str])] = &[("x.com", &["twitter.com"]), ("notion.so", &["notion.com"])];

/// Where a session's tab may be: the card's site (and its domain), its
/// sibling domains, and the sign-in providers.
#[derive(Debug, Clone, PartialEq)]
pub struct Scope {
    /// The catalogue's site ("www.figma.com"), as the card names it.
    pub site: String,
    /// What the user reads ("figma.com").
    pub domain: String,
    roots: Vec<String>,
}

/// The last two labels of a host, without `www.`: every catalogue site is
/// under a plain two-label domain.
fn root_of(host: &str) -> String {
    let h = host.trim_start_matches("www.").to_ascii_lowercase();
    let labels: Vec<&str> = h.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    labels[labels.len() - 2..].join(".")
}

fn under(host: &str, root: &str) -> bool {
    !root.is_empty() && (host == root || host.ends_with(&format!(".{root}")))
}

impl Scope {
    pub fn for_site(site: &str) -> Scope {
        let domain = root_of(site);
        let mut roots = vec![domain.clone()];
        for (main, others) in SIBLINGS {
            if *main == domain {
                roots.extend(others.iter().map(|s| s.to_string()));
            }
        }
        Scope {
            site: site.to_ascii_lowercase(),
            domain,
            roots,
        }
    }

    /// The tab may show and be driven on `url`: `https` only, on the site's
    /// domain or a sign-in provider. Not a lookalike (`figma.com.evil.test`),
    /// not a userinfo trick (`https://figma.com@evil.test`), not `http`.
    pub fn allows(&self, url: &str) -> bool {
        let Some(host) = https_host(url) else {
            return false;
        };
        self.roots.iter().any(|r| under(&host, r))
            || IDP_HOSTS.contains(&host.as_str())
            || IDP_SUFFIXES
                .iter()
                .any(|s| host.ends_with(&format!(".{s}")))
    }
}

/// The host of an `https` URL, lowercased.
pub fn https_host(url: &str) -> Option<String> {
    let u = url::Url::parse(url.trim()).ok()?;
    (u.scheme() == "https")
        .then(|| u.host_str().map(str::to_ascii_lowercase))
        .flatten()
}

/// What the tab opens on: the service's account page (which sends a
/// signed-out visitor to its sign-in), else the site's front page.
pub fn start_url(service: &str, site: &str) -> String {
    super::browser::probe_url(service)
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://{site}/"))
}

/* ---------------------------------------------------------------- input */

/// The keys the phone may press: editing and moving, nothing that opens,
/// closes or goes anywhere (no modifiers, no shortcuts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Key {
    Enter,
    Tab,
    Backspace,
    Delete,
    Escape,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
}

impl Key {
    /// Claude in Chrome's name for it (`computer` `key`).
    pub fn chrome(self) -> &'static str {
        match self {
            Key::Enter => "Enter",
            Key::Tab => "Tab",
            Key::Backspace => "Backspace",
            Key::Delete => "Delete",
            Key::Escape => "Escape",
            Key::Space => "space",
            Key::ArrowUp => "ArrowUp",
            Key::ArrowDown => "ArrowDown",
            Key::ArrowLeft => "ArrowLeft",
            Key::ArrowRight => "ArrowRight",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

impl Direction {
    fn chrome(self) -> &'static str {
        match self {
            Direction::Up => "up",
            Direction::Down => "down",
            Direction::Left => "left",
            Direction::Right => "right",
        }
    }
}

fn three() -> u8 {
    3
}

/// One thing the phone did, in the frame's own pixels. `Debug` never shows
/// what was typed.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Input {
    Tap {
        x: f64,
        y: f64,
    },
    /// Typed at the focused field. `secure`: the phone hid it as it was
    /// typed (a password). Treated the same here: never kept, never logged.
    Type {
        text: String,
        #[serde(default)]
        secure: bool,
    },
    Key {
        key: Key,
    },
    Scroll {
        x: f64,
        y: f64,
        direction: Direction,
        #[serde(default = "three")]
        amount: u8,
    },
    Back,
    Reload,
}

impl fmt::Debug for Input {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Input::Tap { .. } => f.write_str("Tap"),
            Input::Type { text, secure } => write!(
                f,
                "Type {{ chars: {}, secure: {secure} }}",
                text.chars().count()
            ),
            Input::Key { key } => write!(f, "Key({key:?})"),
            Input::Scroll { direction, .. } => write!(f, "Scroll({direction:?})"),
            Input::Back => f.write_str("Back"),
            Input::Reload => f.write_str("Reload"),
        }
    }
}

/// The frame the phone's coordinates are in, and how it maps onto the tab.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameGeom {
    pub width: u32,
    pub height: u32,
    /// Tab pixels (as Claude in Chrome's screenshot measures them) per frame pixel.
    pub scale: f64,
}

impl Input {
    /// Refused before anything reaches Chrome. The reasons never quote it.
    pub fn check(&self, geom: Option<FrameGeom>) -> Result<(), String> {
        let inside = |x: f64, y: f64| -> Result<(), String> {
            let g = geom.ok_or("Wait for the page to show, then tap it.")?;
            if !(x.is_finite() && y.is_finite())
                || x < 0.0
                || y < 0.0
                || x > g.width as f64
                || y > g.height as f64
            {
                return Err("That tap was outside the page.".into());
            }
            Ok(())
        };
        match self {
            Input::Tap { x, y } => inside(*x, *y),
            Input::Scroll { x, y, amount, .. } => {
                if !(1..=10).contains(amount) {
                    return Err("Scroll by 1 to 10.".into());
                }
                inside(*x, *y)
            }
            Input::Type { text, .. } => {
                if text.is_empty() {
                    return Err("Nothing to type.".into());
                }
                if text.chars().count() > MAX_TEXT {
                    return Err(format!("Type at most {MAX_TEXT} characters at a time."));
                }
                if text.chars().any(char::is_control) {
                    return Err("Use the keys for Enter and Tab.".into());
                }
                Ok(())
            }
            Input::Key { .. } | Input::Back | Input::Reload => Ok(()),
        }
    }

    /// The Claude in Chrome call it becomes. `url`: where the tab is now
    /// (Reload goes there again). Pure.
    pub fn call(&self, tab: u64, geom: Option<FrameGeom>, url: &str) -> (&'static str, Value) {
        let at = |x: f64, y: f64| {
            let s = geom.map(|g| g.scale).unwrap_or(1.0);
            json!([(x * s).round() as i64, (y * s).round() as i64])
        };
        match self {
            Input::Tap { x, y } => (
                "computer",
                json!({ "action": "left_click", "coordinate": at(*x, *y), "tabId": tab }),
            ),
            Input::Type { text, .. } => (
                "computer",
                json!({ "action": "type", "text": text, "tabId": tab }),
            ),
            Input::Key { key } => (
                "computer",
                json!({ "action": "key", "text": key.chrome(), "tabId": tab }),
            ),
            Input::Scroll {
                x,
                y,
                direction,
                amount,
            } => (
                "computer",
                json!({
                    "action": "scroll",
                    "coordinate": at(*x, *y),
                    "scroll_direction": direction.chrome(),
                    "scroll_amount": amount,
                    "tabId": tab,
                }),
            ),
            Input::Back => ("navigate", json!({ "url": "back", "tabId": tab })),
            Input::Reload => ("navigate", json!({ "url": url, "tabId": tab })),
        }
    }
}

/* ---------------------------------------------------------------- table */

/// Why a call on a session was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// No such session (finished, stopped, or never).
    Gone,
    /// Another paired device's session.
    NotYours,
    /// It sat idle, or ran too long, and ended.
    TimedOut,
    /// Another phone is signing in already.
    Busy,
}

impl Refusal {
    pub fn message(&self) -> &'static str {
        match self {
            Refusal::Gone => "That sign-in has ended.",
            Refusal::NotYours => "That sign-in was started on another phone.",
            Refusal::TimedOut => "That sign-in sat idle for five minutes, so it was closed.",
            Refusal::Busy => "Another phone is signing in on this Mac right now.",
        }
    }
}

/// One live session.
pub struct Live<T> {
    pub id: String,
    pub device_id: String,
    pub device_name: String,
    pub agent_id: String,
    pub request_id: String,
    pub scope: Scope,
    pub started: Instant,
    pub started_ms: i64,
    pub last_input: Instant,
    pub extra: T,
}

/// At most one session on this Mac at a time. Pure: the clock is passed in.
pub struct Table<T> {
    live: Option<Live<T>>,
}

impl<T> Default for Table<T> {
    fn default() -> Self {
        Table { live: None }
    }
}

/// What a new session needs.
pub struct Opening {
    pub device_id: String,
    pub device_name: String,
    pub agent_id: String,
    pub request_id: String,
    pub scope: Scope,
}

impl<T> Table<T> {
    /// Start one. Another device's live session refuses it; the same
    /// device's is replaced (returned, so its tab is closed).
    #[allow(clippy::type_complexity)]
    pub fn begin(
        &mut self,
        open: Opening,
        extra: T,
        now: Instant,
        now_ms: i64,
    ) -> Result<(String, Option<Live<T>>), (Refusal, T)> {
        let old = self.expire(now);
        if let Some(l) = &self.live {
            if l.device_id != open.device_id {
                return Err((Refusal::Busy, extra));
            }
        }
        let replaced = self.live.take().or(old);
        let id = format!("signin_{}", uuid::Uuid::new_v4().simple());
        self.live = Some(Live {
            id: id.clone(),
            device_id: open.device_id,
            device_name: open.device_name,
            agent_id: open.agent_id,
            request_id: open.request_id,
            scope: open.scope,
            started: now,
            started_ms: now_ms,
            last_input: now,
            extra,
        });
        Ok((id, replaced))
    }

    /// The session `id`, for `device_id`. An expired one is removed and
    /// reads as timed out; another device's is refused and left alone.
    pub fn check(
        &mut self,
        device_id: &str,
        id: &str,
        now: Instant,
    ) -> Result<&mut Live<T>, Refusal> {
        let expired = match &self.live {
            Some(l) if l.id == id => {
                if l.device_id != device_id {
                    return Err(Refusal::NotYours);
                }
                is_expired(l, now)
            }
            _ => return Err(Refusal::Gone),
        };
        if expired {
            self.live = None;
            return Err(Refusal::TimedOut);
        }
        Ok(self.live.as_mut().expect("checked above"))
    }

    /// Input arrived: the idle clock starts again.
    pub fn touch(&mut self, device_id: &str, id: &str, now: Instant) -> Result<(), Refusal> {
        self.check(device_id, id, now)?.last_input = now;
        Ok(())
    }

    /// End `id` (any device: the desk's Stop has none).
    pub fn take(&mut self, id: &str) -> Option<Live<T>> {
        if self.live.as_ref().is_some_and(|l| l.id == id) {
            self.live.take()
        } else {
            None
        }
    }

    /// End whatever is live.
    pub fn take_any(&mut self) -> Option<Live<T>> {
        self.live.take()
    }

    /// The live session, if it ran out: removed and returned.
    pub fn expire(&mut self, now: Instant) -> Option<Live<T>> {
        if self.live.as_ref().is_some_and(|l| is_expired(l, now)) {
            self.live.take()
        } else {
            None
        }
    }

    pub fn current(&self) -> Option<&Live<T>> {
        self.live.as_ref()
    }
}

fn is_expired<T>(l: &Live<T>, now: Instant) -> bool {
    now.saturating_duration_since(l.last_input) >= IDLE
        || now.saturating_duration_since(l.started) >= MAX_AGE
}

/* ----------------------------------------------------------- wire views */

/// `agents.signinBegin`'s answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub session_id: String,
    /// "figma.com": what the phone and the desk name.
    pub domain: String,
    pub title: String,
    pub idle_seconds: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameState {
    /// The page, as it is.
    Live,
    /// The tab went somewhere outside the sign-in: not shown; Back only.
    Outside,
}

/// `agents.signinFrame`'s answer: one picture of the tab, or why not.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub state: FrameState,
    /// Where the tab is: its host only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// A JPEG, base64. Absent when the page isn't shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Signed in: the card answered itself and the agent was woken.
    SignedIn,
    /// Still on a sign-in page: the session goes on.
    SignedOut,
    /// It couldn't be told: the phone offers "Hand it over anyway".
    Unknown,
}

/// The desk's bar.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Banner {
    pub domain: String,
    pub device_name: String,
    pub started_at: i64,
}

/// One request from the phone, as the router hands it over. `Debug` is
/// [`Input`]'s: no typed text.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Begin {
        agent_id: String,
        request_id: String,
    },
    Frame {
        session_id: String,
    },
    Input {
        session_id: String,
        input: Input,
    },
    Done {
        session_id: String,
        anyway: bool,
    },
    Stop {
        session_id: String,
    },
}

/* --------------------------------------------------------------- runtime */

/// The app's own Chrome connection for the session, and its one tab.
pub struct Browser {
    mcp: ChromeMcp,
    tab: u64,
    /// Where the tab was last seen.
    url: String,
    geom: Option<FrameGeom>,
}

type Shared = Arc<tokio::sync::Mutex<Browser>>;

static TABLE: Mutex<Option<Table<Shared>>> = Mutex::new(None);

fn with_table<R>(f: impl FnOnce(&mut Table<Shared>) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Table::default))
}

/// A phone is driving this Mac's Chrome now: agents keep out of it.
pub fn live() -> bool {
    with_table(|t| t.current().is_some())
}

/// What the desk's bar shows.
pub fn banner() -> Option<Banner> {
    with_table(|t| {
        t.current().map(|l| Banner {
            domain: l.scope.domain.clone(),
            device_name: l.device_name.clone(),
            started_at: l.started_ms,
        })
    })
}

fn refused(r: Refusal) -> CommandError {
    CommandError::expected(r.message())
}

fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT, banner());
}

/// The audit line: the domain and how it ended, nothing else.
fn audit(device_name: &str, domain: &str, outcome: &str, ok: bool) {
    crate::remote_access::companion_audit(
        &crate::companion::actor_for(device_name),
        "phone sign-in",
        format!("{domain}: {outcome}"),
        ok,
    );
}

/// Claude in Chrome's words when its own per-site prompt went unanswered.
fn waiting_on_mac(text: &str) -> bool {
    text.to_ascii_lowercase().contains("permission prompt")
}

fn mac_prompt(domain: &str) -> CommandError {
    CommandError::expected(format!(
        "Chrome on your Mac is asking whether Claude can use {domain}, and that question can only be answered at the Mac. Allow it there once (or allow the site in Claude in Chrome's settings), then try again."
    ))
}

/// The tab's URL now, from `tabs_context_mcp`.
async fn where_is(b: &mut Browser) -> Option<String> {
    let text = b.mcp.call("tabs_context_mcp", json!({})).await.ok()?;
    super::browser::landed_in(&text, Some(b.tab)).map(|l| l.url)
}

/// Start a session for a login card: its site's sign-in page in a tab of
/// the app's own in this Mac's Chrome.
pub async fn begin(
    app: &AppHandle,
    device_id: &str,
    device_name: &str,
    agent_id: &str,
    request_id: &str,
) -> Result<Begun, CommandError> {
    let r = super::logins::pending_login(agent_id, request_id)?;
    if !r
        .options
        .iter()
        .any(|o| o.method == super::logins::Method::Browser)
    {
        return Err(CommandError::expected(
            "This card isn't one your Mac's Chrome can sign in to.",
        ));
    }
    let site = super::logins::service(&r.service)
        .and_then(|s| s.site)
        .ok_or_else(|| CommandError::expected("This card has no site to open."))?;
    let scope = Scope::for_site(site);
    // Busy elsewhere: refused before Chrome is touched.
    if let Some(other) = with_table(|t| {
        t.expire(Instant::now());
        t.current()
            .filter(|l| l.device_id != device_id)
            .map(|_| Refusal::Busy)
    }) {
        return Err(refused(other));
    }
    let claude = super::engine::binary(super::engine::Engine::Claude)
        .await
        .ok_or_else(|| {
            CommandError::expected("Claude Code isn't on this Mac, so its Chrome can't be reached.")
        })?;
    let mut mcp = ChromeMcp::start(&claude).await?;
    let browsers = mcp
        .call("list_connected_browsers", json!({}))
        .await
        .unwrap_or_default();
    let connected = super::browser_profiles::parse_browsers(&browsers);
    if connected.is_empty() {
        return Err(CommandError::expected(
            "Chrome on your Mac isn't answering. It needs to be open there with Claude in Chrome on.",
        ));
    }
    // The profile this site was last found signed in to, when it's connected.
    if let Some(known) = super::browser_profiles::remembered(site) {
        if let Some(c) = connected.iter().find(|c| c.name == known.browser) {
            let _ = mcp
                .call("select_browser", json!({ "deviceId": c.id }))
                .await;
        }
    }
    // A tab of the app's own, in its own group: the group's empty first tab
    // when the call just made one, else a new tab.
    let context = mcp
        .call("tabs_context_mcp", json!({ "createIfEmpty": true }))
        .await?;
    let tab = match super::browser::only_blank_tab(&context) {
        Some(t) => t,
        None => {
            let created = mcp.call("tabs_create_mcp", json!({})).await?;
            super::browser::find_tab(&created)
                .ok_or_else(|| CommandError::expected("Chrome on your Mac didn't open a tab."))?
        }
    };
    let url = start_url(&r.service, site);
    let nav = mcp
        .call_checked("navigate", json!({ "url": url, "tabId": tab }))
        .await;
    if let Err(text) = nav {
        let _ = mcp.call("tabs_close_mcp", json!({ "tabId": tab })).await;
        audit(device_name, &scope.domain, "Chrome couldn't open it", false);
        return Err(if waiting_on_mac(&text) {
            mac_prompt(&scope.domain)
        } else {
            CommandError::expected(format!(
                "Chrome on your Mac couldn't open {}.",
                scope.domain
            ))
        });
    }
    let browser = Arc::new(tokio::sync::Mutex::new(Browser {
        mcp,
        tab,
        url,
        geom: None,
    }));
    let open = Opening {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        agent_id: agent_id.to_string(),
        request_id: request_id.to_string(),
        scope: scope.clone(),
    };
    let begun = with_table(|t| t.begin(open, browser, Instant::now(), super::store::now_ms()));
    let (id, replaced) = match begun {
        Ok(v) => v,
        Err((why, b)) => {
            close(b).await;
            return Err(refused(why));
        }
    };
    if let Some(old) = replaced {
        close(old.extra).await;
    }
    audit(device_name, &scope.domain, "started", true);
    emit(app);
    spawn_reaper(app.clone(), id.clone());
    tracing::info!(domain = %scope.domain, "[Agents] phone sign-in started");
    Ok(Begun {
        session_id: id,
        domain: scope.domain,
        title: r.title,
        idle_seconds: IDLE.as_secs(),
    })
}

/// Close the tab and let the Chrome connection go.
async fn close(b: Shared) {
    let mut b = b.lock().await;
    let tab = b.tab;
    let _ = b.mcp.call("tabs_close_mcp", json!({ "tabId": tab })).await;
}

/// End it: the tab closes, the bar goes, one audit line.
async fn end(app: &AppHandle, live: Live<Shared>, outcome: &str, ok: bool) {
    close(live.extra).await;
    audit(&live.device_name, &live.scope.domain, outcome, ok);
    emit(app);
    tracing::info!(domain = %live.scope.domain, outcome, "[Agents] phone sign-in ended");
}

fn spawn_reaper(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let (gone, expired) = with_table(|t| match t.current() {
                Some(l) if l.id == id => (false, t.expire(Instant::now())),
                _ => (true, None),
            });
            if let Some(l) = expired {
                end(&app, l, "timed out", false).await;
                return;
            }
            if gone {
                return;
            }
        }
    });
}

fn session(device_id: &str, id: &str) -> Result<(Shared, Scope), CommandError> {
    let now = Instant::now();
    let r = with_table(|t| {
        t.check(device_id, id, now)
            .map(|l| (l.extra.clone(), l.scope.clone()))
    });
    r.map_err(refused)
}

/// One picture of the tab, scaled for the phone. Doesn't count as activity.
pub async fn frame(device_id: &str, id: &str) -> Result<Frame, CommandError> {
    let (shared, scope) = session(device_id, id)?;
    let mut b = shared.lock().await;
    let url = where_is(&mut b).await.unwrap_or_else(|| b.url.clone());
    b.url = url.clone();
    let host = https_host(&url);
    if !scope.allows(&url) {
        return Ok(Frame {
            state: FrameState::Outside,
            host,
            image: None,
            width: 0,
            height: 0,
        });
    }
    let tab = b.tab;
    let shot = b
        .mcp
        .call_result("computer", json!({ "action": "screenshot", "tabId": tab }))
        .await?;
    if shot.get("isError").and_then(Value::as_bool) == Some(true) {
        let text = super::browser::text_of(&shot);
        return Err(if waiting_on_mac(&text) {
            mac_prompt(&scope.domain)
        } else {
            CommandError::expected("Chrome on your Mac didn't send a picture of the page.")
        });
    }
    let (jpeg, geom) = scale_frame(&shot)?;
    b.geom = Some(geom);
    use base64::Engine as _;
    Ok(Frame {
        state: FrameState::Live,
        host,
        image: Some(base64::engine::general_purpose::STANDARD.encode(jpeg)),
        width: geom.width,
        height: geom.height,
    })
}

/// The screenshot's image, at most [`FRAME_WIDTH`] wide, as a JPEG.
pub fn scale_frame(result: &Value) -> Result<(Vec<u8>, FrameGeom), CommandError> {
    use base64::Engine as _;
    let data = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find(|p| p.get("type").and_then(Value::as_str) == Some("image"))
        })
        .and_then(|p| p.get("data").and_then(Value::as_str))
        .ok_or_else(|| {
            CommandError::expected("Chrome on your Mac didn't send a picture of the page.")
        })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(super::err_other)?;
    let img = image::load_from_memory(&bytes).map_err(super::err_other)?;
    let w = img.width().max(1);
    let img = if w > FRAME_WIDTH {
        img.resize(FRAME_WIDTH, u32::MAX, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = Vec::new();
    let rgb = img.to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 70)
        .encode_image(&rgb)
        .map_err(super::err_other)?;
    Ok((
        out,
        FrameGeom {
            width: rgb.width(),
            height: rgb.height(),
            scale: w as f64 / rgb.width().max(1) as f64,
        },
    ))
}

/// A tap, typing, a key, a scroll, Back or Reload, on the session's tab.
pub async fn input(device_id: &str, id: &str, input: Input) -> Result<(), CommandError> {
    let (shared, scope) = session(device_id, id)?;
    let mut b = shared.lock().await;
    input
        .check(b.geom)
        .map_err(|reason| super::err_invalid("input", reason))?;
    with_table(|t| t.touch(device_id, id, Instant::now())).map_err(refused)?;
    // Only on the sign-in itself; Back is how you get back to it.
    let url = where_is(&mut b).await.unwrap_or_else(|| b.url.clone());
    b.url = url.clone();
    if input != Input::Back && !scope.allows(&url) {
        return Err(CommandError::expected(
            "That page is outside the sign-in. Go back to carry on.",
        ));
    }
    let (tool, args) = input.call(b.tab, b.geom, &url);
    // What went wrong, never what was typed: Chrome's own words are dropped.
    match b.mcp.call_checked(tool, args).await {
        Ok(_) => Ok(()),
        Err(text) if waiting_on_mac(&text) => Err(mac_prompt(&scope.domain)),
        Err(_) => Err(CommandError::expected(
            "That didn't reach Chrome on your Mac.",
        )),
    }
}

/// Done: is it signed in? If so the card answers itself (the browser way
/// in) and the session ends. `anyway`: hand it over without being sure.
pub async fn done(
    app: &AppHandle,
    device_id: &str,
    id: &str,
    anyway: bool,
) -> Result<Outcome, CommandError> {
    let (shared, scope) = session(device_id, id)?;
    let (agent_id, request_id, service) = with_table(|t| {
        t.current()
            .map(|l| (l.agent_id.clone(), l.request_id.clone()))
    })
    .map(|(a, r)| {
        let service = super::logins::pending_login(&a, &r)
            .map(|l| l.service)
            .unwrap_or_default();
        (a, r, service)
    })
    .ok_or_else(|| refused(Refusal::Gone))?;
    let outcome = if anyway {
        Outcome::SignedIn
    } else {
        let mut b = shared.lock().await;
        // The account page tells: it stays put signed in, and goes to a
        // sign-in page signed out.
        if let Some(probe) = super::browser::probe_url(&service) {
            let tab = b.tab;
            let _ = b
                .mcp
                .call_checked("navigate", json!({ "url": probe, "tabId": tab }))
                .await;
        }
        let text = b
            .mcp
            .call("tabs_context_mcp", json!({}))
            .await
            .unwrap_or_default();
        match super::browser::landed_in(&text, Some(b.tab))
            .and_then(|l| super::browser::signed_in(&scope.site, &l))
        {
            Some(true) => Outcome::SignedIn,
            Some(false) => Outcome::SignedOut,
            None => Outcome::Unknown,
        }
    };
    if outcome != Outcome::SignedIn {
        return Ok(outcome);
    }
    let Some(live) = with_table(|t| t.take(id)) else {
        return Err(refused(Refusal::Gone));
    };
    end(
        app,
        live,
        if anyway { "handed over" } else { "signed in" },
        true,
    )
    .await;
    super::logins::start(
        app,
        &agent_id,
        &request_id,
        "browser",
        super::logins::Origin::phone(false),
    )
    .await?;
    Ok(Outcome::SignedIn)
}

/// Stop from the phone that started it.
pub async fn stop(app: &AppHandle, device_id: &str, id: &str) -> Result<(), CommandError> {
    let live = with_table(|t| {
        t.check(device_id, id, Instant::now())?;
        Ok::<_, Refusal>(t.take(id))
    });
    match live {
        Ok(Some(l)) => end(app, l, "stopped on the phone", true).await,
        Ok(None) | Err(Refusal::Gone) | Err(Refusal::TimedOut) => {}
        Err(other) => return Err(refused(other)),
    }
    Ok(())
}

/// Stop from the desk's bar: whatever is live.
pub async fn stop_from_desk(app: &AppHandle) {
    if let Some(l) = with_table(Table::take_any) {
        end(app, l, "stopped on the Mac", true).await;
    }
}

/// The router's one entry point.
pub async fn run(
    app: &AppHandle,
    device_id: &str,
    device_name: &str,
    op: Op,
) -> Result<Value, CommandError> {
    fn v<T: Serialize>(r: Result<T, CommandError>) -> Result<Value, CommandError> {
        r.and_then(|x| serde_json::to_value(x).map_err(super::err_other))
    }
    match op {
        Op::Begin {
            agent_id,
            request_id,
        } => v(begin(app, device_id, device_name, &agent_id, &request_id).await),
        Op::Frame { session_id } => v(frame(device_id, &session_id).await),
        Op::Input {
            session_id,
            input: i,
        } => {
            input(device_id, &session_id, i).await?;
            Ok(Value::Null)
        }
        Op::Done { session_id, anyway } => {
            let outcome = done(app, device_id, &session_id, anyway).await?;
            Ok(json!({ "outcome": outcome }))
        }
        Op::Stop { session_id } => {
            stop(app, device_id, &session_id).await?;
            Ok(Value::Null)
        }
    }
}

#[cfg(test)]
#[path = "phone_signin_tests.rs"]
mod tests;
