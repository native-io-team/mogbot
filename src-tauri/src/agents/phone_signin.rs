//! Sign in on your Mac, from your phone (`agents.signin*`).
//!
//! An agent that found a sign-in page raises a login card. Away from the
//! Mac, the user taps **Sign in from here**, and the phone gets a live
//! picture of one window on this Mac and sends back taps, typing, keys and
//! scrolls. Two drivers ([`Via`]):
//!
//! - **The agents' browser** (`agent_browser`, the card's `agent_browser`
//!   way in, the default): a window of the agents' own Chrome, frames from
//!   its screencast, input as CDP events. No extension, so no per-site
//!   Allow waiting at the Mac. A site that refuses a driven browser (Google)
//!   moves to a plain window of the same profile (`agents.signinFallback`,
//!   `agent_browser::plain`), seen and driven through macOS.
//! - **The user's own Chrome** (a card without the agents' browser): a tab of
//!   its own through Claude in Chrome's MCP server (`browser::ChromeMcp`).
//!
//! **Done** checks the page here; signed in, the card answers itself and the
//! agent carries on.
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
/// However slow the browser, opening the page answers the phone within this
/// (the phone gives up a little after it, so the Mac's reason arrives first).
pub const BEGIN_TIMEOUT: Duration = Duration::from_secs(20);
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

/// How the phone sees and drives the sign-in.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// A window of the agents' own Chrome (`agent_browser`): screencast
    /// frames out, CDP input in. No Mac permission, no extension Allow.
    AgentsBrowser,
    /// A tab of the user's own Chrome, through Claude in Chrome.
    Chrome,
    /// The agents' profile in a plain Chrome window, through macOS capture
    /// and input (a site that refuses a driven browser).
    MacWindow,
}

/// `agents.signinBegin`'s answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub session_id: String,
    /// "figma.com": what the phone and the desk name.
    pub domain: String,
    pub title: String,
    pub idle_seconds: u64,
    pub via: Via,
    /// How long the phone waits between pictures.
    pub frame_gap_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameState {
    /// The page, as it is.
    Live,
    /// The tab went somewhere outside the sign-in: not shown; Back only.
    Outside,
    /// The site refuses this window (`blocked` says why): the phone offers
    /// "Sign in another way" (`agents.signinFallback`).
    Blocked,
}

fn is_false(b: &bool) -> bool {
    !*b
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
    /// The picture's number: the next `agents.signinFrame` asks for one
    /// after it (and the Mac waits for one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// The focused field takes a password or a code: the phone hides what's
    /// typed.
    #[serde(default, skip_serializing_if = "is_false")]
    pub secure: bool,
    /// Why the site refuses this window (`Blocked`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

impl Frame {
    fn empty(state: FrameState, host: Option<String>) -> Frame {
        Frame {
            state,
            host,
            image: None,
            width: 0,
            height: 0,
            seq: None,
            secure: false,
            blocked: None,
        }
    }
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
    pub via: Via,
}

/// One request from the phone, as the router hands it over. `Debug` is
impl Op {
    /// For the log: the step, never its contents.
    pub fn name(&self) -> &'static str {
        match self {
            Op::Begin { .. } => "begin",
            Op::Frame { .. } => "frame",
            Op::Input { .. } => "input",
            Op::Done { .. } => "done",
            Op::Stop { .. } => "stop",
            Op::Fallback { .. } => "fallback",
        }
    }
}

/// [`Input`]'s: no typed text.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Begin {
        agent_id: String,
        request_id: String,
        /// The phone asked for this way ("Try the agents' browser"); none:
        /// the Mac picks ([`choose`]).
        way: Option<Via>,
    },
    Frame {
        session_id: String,
        /// The last picture the phone has: wait for a newer one.
        after: Option<u64>,
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
    /// The site refused the agents' browser: the same profile in a plain
    /// window, shown through macOS (needs Screen Recording and
    /// Accessibility), or a plain answer that it happens at the Mac.
    Fallback {
        session_id: String,
    },
}

/* --------------------------------------------------------------- runtime */

/// The user's own Chrome, through Claude in Chrome: the connection, and
/// the session's one tab.
pub struct ChromeTab {
    mcp: ChromeMcp,
    tab: u64,
    /// Where the tab was last seen.
    url: String,
    geom: Option<FrameGeom>,
}

/// A window of the agents' browser, and the last picture's size.
pub struct AgentsTab {
    win: Arc<crate::agent_browser::signin::SigninWindow>,
    geom: Option<FrameGeom>,
}

pub enum Driver {
    Chrome(Box<ChromeTab>),
    Agents(AgentsTab),
}

/// What a session holds: how it's driven, and the driver.
#[derive(Clone)]
pub struct Shared {
    via: Via,
    driver: Arc<tokio::sync::Mutex<Driver>>,
    /// The first picture reached the phone (logged once).
    shown: Arc<std::sync::atomic::AtomicBool>,
}

impl Shared {
    fn new(via: Via, d: Driver) -> Shared {
        Shared {
            via,
            driver: Arc::new(tokio::sync::Mutex::new(d)),
            shown: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

static TABLE: Mutex<Option<Table<Shared>>> = Mutex::new(None);

fn with_table<R>(f: impl FnOnce(&mut Table<Shared>) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Table::default))
}

/// A phone is driving this Mac's own Chrome now (through Claude in
/// Chrome): agents keep out of it. A sign-in in the agents' browser keeps
/// only that agent out (`agent_browser::signin::refusal_for`).
pub fn live() -> bool {
    with_table(|t| t.current().is_some_and(|l| l.extra.via == Via::Chrome))
}

/// What the desk's bar shows.
pub fn banner() -> Option<Banner> {
    with_table(|t| {
        t.current().map(|l| Banner {
            domain: l.scope.domain.clone(),
            device_name: l.device_name.clone(),
            started_at: l.started_ms,
            via: l.extra.via,
        })
    })
}

fn set_via(id: &str, via: Via) {
    with_table(|t| {
        if let Some(l) = t.live.as_mut().filter(|l| l.id == id) {
            l.extra.via = via;
        }
    });
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
async fn where_is(b: &mut ChromeTab) -> Option<String> {
    let text = b.mcp.call("tabs_context_mcp", json!({})).await.ok()?;
    super::browser::landed_in(&text, Some(b.tab)).map(|l| l.url)
}

/// How long the phone waits between pictures, by how they're made.
pub fn frame_gap(via: Via) -> Duration {
    match via {
        // The Mac waits for the next screencast frame; the phone asks again
        // as soon as one arrives (about 15 a second at most).
        Via::AgentsBrowser => Duration::from_millis(30),
        // A screenshot per picture.
        Via::Chrome => Duration::from_millis(300),
        Via::MacWindow => Duration::from_millis(150),
    }
}

/// Which way a sign-in from the phone goes, decided when the phone asks,
/// not when the card was raised: the agents' browser whenever it's here
/// (the card names a site), whatever the card offered, so a card raised by
/// an older build or while the switch was off still gets it; else the
/// user's own Chrome when the card has that way. `asked`: the phone named
/// a way. Pure.
pub fn choose(
    asked: Option<Via>,
    agents_available: bool,
    chrome_offered: bool,
) -> Result<Via, &'static str> {
    match asked {
        Some(Via::AgentsBrowser | Via::MacWindow) if agents_available => Ok(Via::AgentsBrowser),
        Some(Via::AgentsBrowser | Via::MacWindow) => Err(NO_AGENTS_BROWSER),
        Some(Via::Chrome) if chrome_offered => Ok(Via::Chrome),
        Some(Via::Chrome) => Err(NOT_FROM_HERE),
        None if agents_available => Ok(Via::AgentsBrowser),
        None if chrome_offered => Ok(Via::Chrome),
        None => Err(NOT_FROM_HERE),
    }
}

pub const NO_AGENTS_BROWSER: &str = "The agents' browser isn't on on this Mac (Settings → Agents), or Google Chrome isn't installed there.";
const NOT_FROM_HERE: &str = "This card isn't one you can sign in to from here.";
/// The Mac's reasons when opening it failed or took too long.
pub const CHROME_SLOW: &str =
    "Chrome on your Mac isn't answering. It needs to be open there with Claude in Chrome on.";
pub const AGENTS_SLOW: &str =
    "The agents' browser on your Mac didn't open the page in time. Try again.";

/// Start a session for a login card: its site's sign-in page in a window
/// of the agents' browser (or, for a card without that, a tab of the
/// user's own Chrome).
pub async fn begin(
    app: &AppHandle,
    device_id: &str,
    device_name: &str,
    agent_id: &str,
    request_id: &str,
    asked: Option<Via>,
) -> Result<Begun, CommandError> {
    tracing::info!(?asked, "[Agents] phone sign-in: begin asked");
    let r = super::logins::pending_login(agent_id, request_id).inspect_err(|e| {
        tracing::info!(error = %e, "[Agents] phone sign-in: card not pending");
    })?;
    let site = super::logins::service(&r.service)
        .and_then(|s| s.site)
        .ok_or_else(|| CommandError::expected("This card has no site to open."))?;
    let has = |m: super::logins::Method| r.options.iter().any(|o| o.method == m);
    let agents_available = crate::agent_browser::available();
    let via =
        choose(asked, agents_available, has(super::logins::Method::Browser)).map_err(|why| {
            tracing::info!(
                service = %r.service,
                agents_available,
                "[Agents] phone sign-in: no way from the phone"
            );
            CommandError::expected(why)
        })?;
    tracing::info!(
        service = %r.service,
        ?via,
        card_offered_agents_browser = has(super::logins::Method::AgentBrowser),
        agents_available,
        "[Agents] phone sign-in: way chosen"
    );
    let scope = Scope::for_site(site);
    // Busy elsewhere: refused before any browser is touched.
    if let Some(other) = with_table(|t| {
        t.expire(Instant::now());
        t.current()
            .filter(|l| l.device_id != device_id)
            .map(|_| Refusal::Busy)
    }) {
        return Err(refused(other));
    }
    let url = start_url(&r.service, site);
    let shared = match tokio::time::timeout(
        BEGIN_TIMEOUT,
        open_way(via, device_name, agent_id, request_id, site, &scope, &url),
    )
    .await
    {
        Ok(Ok(shared)) => shared,
        Ok(Err(e)) => {
            tracing::info!(domain = %scope.domain, ?via, error = %e, "[Agents] phone sign-in: didn't open");
            return Err(e);
        }
        Err(_) => {
            tracing::info!(
                domain = %scope.domain,
                ?via,
                secs = BEGIN_TIMEOUT.as_secs(),
                "[Agents] phone sign-in: opening timed out"
            );
            audit(device_name, &scope.domain, "timed out opening it", false);
            return Err(CommandError::expected(slow(via)));
        }
    };
    let open = Opening {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        agent_id: agent_id.to_string(),
        request_id: request_id.to_string(),
        scope: scope.clone(),
    };
    let begun = with_table(|t| t.begin(open, shared, Instant::now(), super::store::now_ms()));
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
    tracing::info!(domain = %scope.domain, ?via, "[Agents] phone sign-in started");
    Ok(Begun {
        session_id: id,
        domain: scope.domain,
        title: r.title,
        idle_seconds: IDLE.as_secs(),
        via,
        frame_gap_ms: frame_gap(via).as_millis() as u64,
    })
}

/// The phone's words when opening it took longer than [`BEGIN_TIMEOUT`].
pub fn slow(via: Via) -> &'static str {
    match via {
        Via::Chrome => CHROME_SLOW,
        Via::AgentsBrowser | Via::MacWindow => AGENTS_SLOW,
    }
}

/// Open the page the chosen way. Bounded by the caller ([`BEGIN_TIMEOUT`]);
/// a window that opens after the phone was told it timed out is closed.
async fn open_way(
    via: Via,
    device_name: &str,
    agent_id: &str,
    request_id: &str,
    site: &str,
    scope: &Scope,
    url: &str,
) -> Result<Shared, CommandError> {
    match via {
        Via::AgentsBrowser | Via::MacWindow => {
            let (key, agent, u) = (
                request_id.to_string(),
                agent_id.to_string(),
                url.to_string(),
            );
            let job = tokio::task::spawn_blocking(move || {
                crate::agent_browser::signin::SigninWindow::open(&key, &agent, &u, false)
            });
            // Dropping a join handle doesn't stop the work: if the caller
            // gives up, the window that opens late is closed, not left.
            let mut late = LateWindow(Some(job));
            let joined = match late.0.as_mut() {
                Some(job) => job.await,
                None => unreachable!(),
            };
            late.0 = None;
            let win = joined.map_err(super::err_other)?.map_err(|e| {
                audit(
                    device_name,
                    &scope.domain,
                    "the agents' browser didn't open",
                    false,
                );
                CommandError::expected(e)
            })?;
            tracing::info!("[Agents] phone sign-in: agents' browser window open");
            Ok(Shared::new(
                Via::AgentsBrowser,
                Driver::Agents(AgentsTab { win, geom: None }),
            ))
        }
        Via::Chrome => Ok(Shared::new(
            via,
            Driver::Chrome(Box::new(open_chrome(device_name, site, scope, url).await?)),
        )),
    }
}

type OpenJob =
    tokio::task::JoinHandle<Result<Arc<crate::agent_browser::signin::SigninWindow>, String>>;

/// A window still opening when its caller gave up: closed once it opens.
struct LateWindow(Option<OpenJob>);

impl Drop for LateWindow {
    fn drop(&mut self) {
        if let Some(job) = self.0.take() {
            tauri::async_runtime::spawn(async move {
                if let Ok(Ok(w)) = job.await {
                    tracing::info!("[Agents] phone sign-in: closing a window that opened too late");
                    let _ = tokio::task::spawn_blocking(move || w.close()).await;
                }
            });
        }
    }
}

/// A tab of the app's own in the user's Chrome, at `url` (Claude in Chrome).
async fn open_chrome(
    device_name: &str,
    site: &str,
    scope: &Scope,
    url: &str,
) -> Result<ChromeTab, CommandError> {
    let claude = super::engine::binary(super::engine::Engine::Claude)
        .await
        .ok_or_else(|| {
            CommandError::expected("Claude Code isn't on this Mac, so its Chrome can't be reached.")
        })?;
    tracing::info!("[Agents] phone sign-in: starting Claude in Chrome");
    let mut mcp = ChromeMcp::start(&claude).await.map_err(|e| {
        tracing::info!(error = %e, "[Agents] phone sign-in: Claude in Chrome didn't start");
        CommandError::expected(CHROME_SLOW)
    })?;
    let browsers = mcp
        .call("list_connected_browsers", json!({}))
        .await
        .unwrap_or_default();
    let connected = super::browser_profiles::parse_browsers(&browsers);
    tracing::info!(
        connected = connected.len(),
        "[Agents] phone sign-in: Chrome browsers connected"
    );
    if connected.is_empty() {
        return Err(CommandError::expected(CHROME_SLOW));
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
    Ok(ChromeTab {
        mcp,
        tab,
        url: url.to_string(),
        geom: None,
    })
}

/// Close the tab or window and let the browser go.
async fn close(b: Shared) {
    let mut d = b.driver.lock().await;
    match &mut *d {
        Driver::Chrome(c) => {
            let tab = c.tab;
            let _ = c.mcp.call("tabs_close_mcp", json!({ "tabId": tab })).await;
        }
        Driver::Agents(a) => {
            let w = a.win.clone();
            let _ = tokio::task::spawn_blocking(move || w.close()).await;
        }
    }
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

/// One picture of the window, scaled for the phone. Doesn't count as
/// activity. `after`: the agents' browser waits up to a second and a half
/// for a newer one.
pub async fn frame(device_id: &str, id: &str, after: Option<u64>) -> Result<Frame, CommandError> {
    let (shared, scope) = session(device_id, id)?;
    let r = frame_of(&shared, &scope, after).await;
    match &r {
        Ok(f) if f.image.is_some() => {
            if !shared
                .shown
                .swap(true, std::sync::atomic::Ordering::Relaxed)
            {
                tracing::info!(
                    domain = %scope.domain,
                    via = ?shared.via,
                    width = f.width,
                    height = f.height,
                    "[Agents] phone sign-in: first picture"
                );
            }
        }
        Ok(_) => {}
        Err(e) => {
            tracing::info!(domain = %scope.domain, via = ?shared.via, error = %e, "[Agents] phone sign-in: picture failed");
        }
    }
    r
}

async fn frame_of(
    shared: &Shared,
    scope: &Scope,
    after: Option<u64>,
) -> Result<Frame, CommandError> {
    let mut d = shared.driver.lock().await;
    match &mut *d {
        Driver::Chrome(b) => chrome_frame(b, scope).await,
        Driver::Agents(a) => {
            let w = a.win.clone();
            let shot = tokio::task::spawn_blocking(move || {
                w.frame(after.unwrap_or(0), Duration::from_millis(1500))
            })
            .await
            .map_err(super::err_other)?;
            let shot = match shot {
                Ok(s) => s,
                // Nothing drawn yet: the phone keeps its spinner.
                Err(e) if e.contains("hasn't drawn") => {
                    return Ok(Frame::empty(FrameState::Live, None))
                }
                Err(e) => return Err(CommandError::expected(e)),
            };
            let host = shot.url.as_deref().and_then(https_host);
            if let Some(u) = shot.url.as_deref() {
                if !scope.allows(u) {
                    return Ok(Frame::empty(FrameState::Outside, host));
                }
            }
            a.geom = Some(FrameGeom {
                width: shot.width,
                height: shot.height,
                scale: 1.0,
            });
            use base64::Engine as _;
            Ok(Frame {
                state: if shot.refused.is_some() {
                    FrameState::Blocked
                } else {
                    FrameState::Live
                },
                host,
                image: Some(base64::engine::general_purpose::STANDARD.encode(&shot.jpeg)),
                width: shot.width,
                height: shot.height,
                seq: Some(shot.seq),
                secure: shot.secret,
                blocked: shot.refused.map(|r| r.reason().to_string()),
            })
        }
    }
}

async fn chrome_frame(b: &mut ChromeTab, scope: &Scope) -> Result<Frame, CommandError> {
    let url = where_is(b).await.unwrap_or_else(|| b.url.clone());
    b.url = url.clone();
    let host = https_host(&url);
    if !scope.allows(&url) {
        return Ok(Frame::empty(FrameState::Outside, host));
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
        seq: None,
        secure: false,
        blocked: None,
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

/// The agents' browser's key for one the phone pressed.
pub fn agents_key(k: Key) -> crate::agent_browser::keys::Key {
    use crate::agent_browser::keys::Key as A;
    match k {
        Key::Enter => A::Enter,
        Key::Tab => A::Tab,
        Key::Backspace => A::Backspace,
        Key::Delete => A::Delete,
        Key::Escape => A::Escape,
        Key::Space => A::Space,
        Key::ArrowUp => A::ArrowUp,
        Key::ArrowDown => A::ArrowDown,
        Key::ArrowLeft => A::ArrowLeft,
        Key::ArrowRight => A::ArrowRight,
    }
}

/// One input on a window of the agents' browser. Blocking. What's typed
/// goes into one input event and nowhere else.
fn agents_input(
    w: &crate::agent_browser::signin::SigninWindow,
    input: &Input,
) -> Result<(), String> {
    match input {
        Input::Tap { x, y } => w.tap(*x, *y),
        Input::Type { text, .. } => w.type_text(text),
        Input::Key { key } => w.key(agents_key(*key)),
        Input::Scroll {
            x,
            y,
            direction,
            amount,
        } => {
            let n = *amount as i32;
            let (dx, dy) = match direction {
                Direction::Up => (0, -n),
                Direction::Down => (0, n),
                Direction::Left => (-n, 0),
                Direction::Right => (n, 0),
            };
            w.scroll(*x, *y, dx, dy)
        }
        Input::Back => w.back(),
        Input::Reload => w.reload(),
    }
}

/// A tap, typing, a key, a scroll, Back or Reload, on the session's window.
pub async fn input(device_id: &str, id: &str, input: Input) -> Result<(), CommandError> {
    let (shared, scope) = session(device_id, id)?;
    let mut d = shared.driver.lock().await;
    let geom = match &*d {
        Driver::Chrome(b) => b.geom,
        Driver::Agents(a) => a.geom,
    };
    input
        .check(geom)
        .map_err(|reason| super::err_invalid("input", reason))?;
    with_table(|t| t.touch(device_id, id, Instant::now())).map_err(refused)?;
    match &mut *d {
        Driver::Chrome(b) => chrome_input(b, &scope, input).await,
        Driver::Agents(a) => {
            let w = a.win.clone();
            let (scope, i) = (scope.clone(), input);
            let r = tokio::task::spawn_blocking(move || {
                // Only on the sign-in itself; Back is how you get back to it.
                if i != Input::Back {
                    if let Some(l) = w.location() {
                        if !scope.allows(&l.url) {
                            return Err("That page is outside the sign-in. Go back to carry on."
                                .to_string());
                        }
                    }
                }
                agents_input(&w, &i)
                    .map_err(|_| "That didn't reach the page on your Mac.".to_string())
            })
            .await
            .map_err(super::err_other)?;
            r.map_err(CommandError::expected)
        }
    }
}

async fn chrome_input(b: &mut ChromeTab, scope: &Scope, input: Input) -> Result<(), CommandError> {
    // Only on the sign-in itself; Back is how you get back to it.
    let url = where_is(b).await.unwrap_or_else(|| b.url.clone());
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

/// Done: is it signed in? If so the card answers itself and the session
/// ends. `anyway`: hand it over without being sure.
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
        let mut d = shared.driver.lock().await;
        let landed = match &mut *d {
            Driver::Chrome(b) => {
                // The account page tells: it stays put signed in, and goes
                // to a sign-in page signed out.
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
                super::browser::landed_in(&text, Some(b.tab))
            }
            Driver::Agents(a) => {
                let w = a.win.clone();
                let probe = start_url(&service, &scope.site);
                let landed = tokio::task::spawn_blocking(move || w.check(&probe))
                    .await
                    .ok()
                    .flatten();
                // A plain window was closed for the check: the agents'
                // browser shows it again.
                if shared.via == Via::MacWindow {
                    set_via(id, Via::AgentsBrowser);
                }
                landed
            }
        };
        match landed.and_then(|l| super::browser::signed_in(&scope.site, &l)) {
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
    let via = live.extra.via;
    end(
        app,
        live,
        if anyway { "handed over" } else { "signed in" },
        true,
    )
    .await;
    match via {
        Via::Chrome => {
            super::logins::start(
                app,
                &agent_id,
                &request_id,
                "browser",
                super::logins::Origin::phone(false),
            )
            .await?
        }
        Via::AgentsBrowser | Via::MacWindow => {
            super::logins::complete_agents_browser(app, &agent_id, &request_id)?
        }
    }
    Ok(Outcome::SignedIn)
}

/// The site refused the agents' browser: the same profile in a plain
/// window the phone sees through macOS, if the Mac allows it; else the
/// plain answer that this one sign-in happens at the Mac.
pub async fn fallback(app: &AppHandle, device_id: &str, id: &str) -> Result<Begun, CommandError> {
    let (shared, scope) = session(device_id, id)?;
    let (title, started) = with_table(|t| {
        t.current().map(|l| {
            let title = super::logins::pending_login(&l.agent_id, &l.request_id)
                .map(|r| r.title)
                .unwrap_or_default();
            (title, l.device_name.clone())
        })
    })
    .ok_or_else(|| refused(Refusal::Gone))?;
    let d = shared.driver.lock().await;
    let Driver::Agents(a) = &*d else {
        return Err(CommandError::expected(
            "This sign-in is in your own Chrome; there's no other way from here.",
        ));
    };
    let w = a.win.clone();
    let start = start_url("", &scope.site);
    let r = tokio::task::spawn_blocking(move || {
        let at = w
            .location()
            .map(|l| l.url)
            .filter(|u| u.starts_with("https://"))
            .unwrap_or(start);
        w.go_plain(&at, true)
    })
    .await
    .map_err(super::err_other)?;
    drop(d);
    if let Err(e) = r {
        audit(&started, &scope.domain, "needs the Mac", false);
        return Err(CommandError::expected(e));
    }
    set_via(id, Via::MacWindow);
    emit(app);
    with_table(|t| {
        let _ = t.touch(device_id, id, Instant::now());
    });
    Ok(Begun {
        session_id: id.to_string(),
        domain: scope.domain,
        title,
        idle_seconds: IDLE.as_secs(),
        via: Via::MacWindow,
        frame_gap_ms: frame_gap(Via::MacWindow).as_millis() as u64,
    })
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
    let name = op.name();
    // Frames log their own first picture and failures; the rest, each step.
    if !matches!(op, Op::Frame { .. } | Op::Begin { .. }) {
        tracing::info!(op = name, "[Agents] phone sign-in: step");
    }
    let r = run_op(app, device_id, device_name, op).await;
    if let Err(e) = &r {
        if name != "frame" {
            tracing::info!(op = name, error = %e, "[Agents] phone sign-in: step failed");
        }
    }
    r
}

async fn run_op(
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
            way,
        } => v(begin(app, device_id, device_name, &agent_id, &request_id, way).await),
        Op::Frame { session_id, after } => v(frame(device_id, &session_id, after).await),
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
        Op::Fallback { session_id } => v(fallback(app, device_id, &session_id).await),
    }
}

#[cfg(test)]
#[path = "phone_signin_tests.rs"]
mod tests;
