//! The agents' browser, running: one Chrome on the app's own "Agents"
//! profile, its windows, and the frames the phone watches.
//!
//! - **One process.** Started on first use ([`ensure`]), over a CDP pipe
//!   (no port; it dies with its pipe). Closed after [`IDLE`] with nothing
//!   using it, when the Settings switch goes off, for a plain-mode sign-in
//!   (`plain`), and when the app quits.
//! - **A window per tab.** A tab behind another tab in the same window
//!   paints nothing (docs/internal/agent-browser.md), so every tab an agent
//!   opens, and the one a sign-in uses, is a window of its own, parked in the
//!   bottom-right corner of the screen: not minimized (a minimized window
//!   stops painting and misses clicks), in the Dock, brought forward only for
//!   "Sign in here" at the desk.
//! - **Owned.** Each tab belongs to one agent or one sign-in ([`Owner`]).
//!   An agent's tools see its own tabs only; a sign-in's tab is nobody's.
//! - **Frames.** A screencast runs only while someone watches (a sign-in),
//!   at most about [`FPS`] a second; the newest frame wins ([`FrameSlot`]),
//!   nothing queues and nothing is kept.
//!
//! Every call here blocks (CDP replies come back on the pipe's reader
//! thread): async callers go through `spawn_blocking`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::cdp::{Browser, Event};
use super::chrome;

/// Closed after this long with no tool call, sign-in or frame.
pub const IDLE: Duration = Duration::from_secs(15 * 60);
/// The most frames a second a watcher gets.
pub const FPS: u64 = 15;
/// How wide a frame is for the phone.
pub const FRAME_MAX_WIDTH: u32 = 780;
pub const FRAME_MAX_HEIGHT: u32 = 1600;
/// Windows the agents' Chrome opens at.
pub const WINDOW: (u32, u32) = (1280, 860);
/// Tabs one agent may hold at once.
pub const MAX_TABS: usize = 6;
/// A CDP call's wait.
const T: Duration = Duration::from_secs(20);

/// What the focused field is, before anything is typed into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// Not a password or a code.
    Plain,
    /// A password or one-time-code field.
    Secret,
    /// Couldn't be told: focus in another site's frame, or no answer.
    Unknown,
}

impl Focus {
    /// [`FOCUSED_FIELD_JS`]'s answer. Anything but a plain "plain" fails
    /// closed.
    pub fn from_answer(answer: Result<Value, String>) -> Focus {
        match answer.ok().as_ref().and_then(Value::as_str) {
            Some("plain") => Focus::Plain,
            Some("secret") => Focus::Secret,
            _ => Focus::Unknown,
        }
    }
}

/// Follows focus through shadow roots and into same-origin frames; a frame
/// whose document it can't read (another site's) is "unknown", as is a
/// chain too deep to follow.
const FOCUSED_FIELD_JS: &str = "(() => { let e = document.activeElement; for (let i = 0; e; i++) { if (i > 32) return 'unknown'; if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; } const tag = (e.tagName || '').toUpperCase(); if (tag === 'IFRAME' || tag === 'FRAME') { let d = null; try { d = e.contentDocument; } catch (_) { return 'unknown'; } if (!d) return 'unknown'; e = d.activeElement; continue; } break; } if (!e || (e.tagName || '').toUpperCase() !== 'INPUT') return 'plain'; const t = (e.type || '').toLowerCase(); const a = (e.autocomplete || '').toLowerCase(); return (t === 'password' || a.includes('one-time-code') || a.includes('current-password') || a.includes('new-password')) ? 'secret' : 'plain'; })()";

/// Who a tab belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Owner {
    Agent(String),
    /// A sign-in session's own tab (`signin`): no agent's tools reach it.
    Signin(String),
}

/// One tab (window) of the agents' Chrome.
#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    /// Short and stable for the agent ("tab 2").
    pub id: u32,
    pub target_id: String,
    pub session_id: String,
    pub url: String,
    pub title: String,
    pub owner: Owner,
}

/// One frame of a watched tab.
#[derive(Debug, Clone)]
pub struct Frame {
    pub jpeg: Arc<Vec<u8>>,
    pub seq: u64,
    /// The picture's own pixels.
    pub width: u32,
    pub height: u32,
    /// The page's viewport, in CSS pixels: a point in the picture maps here.
    pub css_width: f64,
    pub css_height: f64,
}

impl Frame {
    /// A point in the picture's pixels, in the page's CSS pixels.
    pub fn to_css(&self, x: f64, y: f64) -> (f64, f64) {
        let sx = if self.width > 0 {
            self.css_width / self.width as f64
        } else {
            1.0
        };
        let sy = if self.height > 0 {
            self.css_height / self.height as f64
        } else {
            1.0
        };
        (x * sx, y * sy)
    }
}

/// The newest frame of one tab. Waiters are woken by each new one.
#[derive(Default)]
pub struct FrameSlot {
    latest: Mutex<Option<Frame>>,
    cv: Condvar,
    seq: AtomicU64,
}

impl FrameSlot {
    pub fn push(&self, jpeg: Vec<u8>, width: u32, height: u32, css: (f64, f64)) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut l) = self.latest.lock() {
            *l = Some(Frame {
                jpeg: Arc::new(jpeg),
                seq,
                width,
                height,
                css_width: css.0,
                css_height: css.1,
            });
        }
        self.cv.notify_all();
    }

    /// The newest frame after `after`, waiting up to `wait` for one.
    pub fn next(&self, after: u64, wait: Duration) -> Option<Frame> {
        let l = self.latest.lock().ok()?;
        let (l, _) = self
            .cv
            .wait_timeout_while(l, wait, |f| f.as_ref().is_none_or(|f| f.seq <= after))
            .ok()?;
        l.clone().filter(|f| f.seq > after)
    }

    /// The newest frame, however old.
    pub fn last(&self) -> Option<Frame> {
        self.latest.lock().ok()?.clone()
    }
}

#[derive(Default)]
struct Inner {
    tabs: HashMap<String, Tab>,
    /// The tab each agent last used.
    active: HashMap<String, String>,
    next_tab: u32,
}

/// A running agents' Chrome.
pub struct Service {
    pub browser: Arc<Browser>,
    profile: PathBuf,
    inner: Mutex<Inner>,
    /// Keyed by CDP session id.
    frames: Mutex<HashMap<String, Arc<FrameSlot>>>,
    last_used: Mutex<Instant>,
    dead: Arc<AtomicBool>,
}

impl Service {
    /// Take over a connected Chrome: discover its targets and route its
    /// events. Used by [`ensure`] and by tests with a fake Chrome.
    pub fn start(browser: Browser, profile: PathBuf) -> Result<Arc<Service>, String> {
        let events = browser.take_events().ok_or("no event stream")?;
        let browser = Arc::new(browser);
        browser.call("Browser.getVersion", json!({}), None, T)?;
        browser.call(
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
            None,
            T,
        )?;
        let svc = Arc::new(Service {
            browser,
            profile,
            inner: Mutex::new(Inner {
                next_tab: 1,
                ..Default::default()
            }),
            frames: Mutex::new(HashMap::new()),
            last_used: Mutex::new(Instant::now()),
            dead: Arc::new(AtomicBool::new(false)),
        });
        spawn_pump(Arc::downgrade(&svc), events, svc.dead.clone());
        Ok(svc)
    }

    pub fn profile(&self) -> &Path {
        &self.profile
    }

    /// Chrome went away (crashed, quit, or the pipe broke).
    pub fn dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed) || self.browser.exited()
    }

    pub fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .map(|t| t.elapsed())
            .unwrap_or_default()
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /* ---------------------------------------------------------- tabs */

    /// `owner`'s tabs, oldest first.
    pub fn tabs_of(&self, owner: &Owner) -> Vec<Tab> {
        let mut v: Vec<Tab> = self
            .inner()
            .tabs
            .values()
            .filter(|t| &t.owner == owner)
            .cloned()
            .collect();
        v.sort_by_key(|t| t.id);
        v
    }

    /// Every sign-in tab, for "is anything signing in".
    pub fn has_owner(&self, owner: &Owner) -> bool {
        self.inner().tabs.values().any(|t| &t.owner == owner)
    }

    /// The tab `agent` names (`id`), or the one it used last, or its newest.
    pub fn tab_for(&self, agent: &str, id: Option<u32>) -> Result<Tab, String> {
        let owner = Owner::Agent(agent.to_string());
        let inner = self.inner();
        let mine = || inner.tabs.values().filter(|t| t.owner == owner);
        if let Some(id) = id {
            return mine()
                .find(|t| t.id == id)
                .cloned()
                .ok_or_else(|| format!("You have no tab {id}. `tabs` lists yours."));
        }
        if let Some(t) = inner.active.get(agent).and_then(|tid| inner.tabs.get(tid)) {
            if t.owner == owner {
                return Ok(t.clone());
            }
        }
        mine()
            .max_by_key(|t| t.id)
            .cloned()
            .ok_or_else(|| "You have no tab open. Use `open` with a URL first.".to_string())
    }

    pub fn set_active(&self, agent: &str, tab: &Tab) {
        self.inner()
            .active
            .insert(agent.to_string(), tab.target_id.clone());
    }

    /// A new tab, in a window of its own, parked; then `url`.
    pub fn open(&self, owner: Owner, url: &str) -> Result<Tab, String> {
        if let Owner::Agent(a) = &owner {
            if self.tabs_of(&owner).len() >= MAX_TABS {
                return Err(format!(
                    "You have {MAX_TABS} tabs open already. Close one with `close_tab` first."
                ));
            }
            let _ = a;
        }
        let t = self.browser.call(
            "Target.createTarget",
            json!({ "url": "about:blank", "newWindow": true }),
            None,
            T,
        )?;
        let target_id = t["targetId"].as_str().ok_or("no targetId")?.to_string();
        let s = self.browser.call(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
            T,
        )?;
        let session_id = s["sessionId"].as_str().ok_or("no sessionId")?.to_string();
        let tab = {
            let mut inner = self.inner();
            let id = inner.next_tab;
            inner.next_tab += 1;
            let tab = Tab {
                id,
                target_id: target_id.clone(),
                session_id,
                url: "about:blank".into(),
                title: String::new(),
                owner: owner.clone(),
            };
            inner.tabs.insert(target_id, tab.clone());
            if let Owner::Agent(a) = &owner {
                inner.active.insert(a.clone(), tab.target_id.clone());
            }
            tab
        };
        for m in ["Page.enable", "DOM.enable", "Accessibility.enable"] {
            let _ = self.call(&tab, m, json!({}));
        }
        let _ = self.park(&tab);
        if url != "about:blank" {
            self.navigate(&tab, url)?;
        }
        Ok(self.refreshed(&tab))
    }

    /// The tab as Chrome says it is now (URL and title).
    pub fn refreshed(&self, tab: &Tab) -> Tab {
        if let Ok(info) = self.browser.call(
            "Target.getTargetInfo",
            json!({ "targetId": tab.target_id }),
            None,
            T,
        ) {
            let i = &info["targetInfo"];
            let mut inner = self.inner();
            if let Some(t) = inner.tabs.get_mut(&tab.target_id) {
                if let Some(u) = i["url"].as_str() {
                    t.url = u.to_string();
                }
                if let Some(ti) = i["title"].as_str() {
                    t.title = ti.to_string();
                }
                return t.clone();
            }
        }
        tab.clone()
    }

    pub fn close_tab(&self, tab: &Tab) {
        let _ = self.browser.call(
            "Target.closeTarget",
            json!({ "targetId": tab.target_id }),
            None,
            T,
        );
        self.forget(&tab.target_id);
    }

    fn forget(&self, target_id: &str) {
        let mut inner = self.inner();
        if let Some(t) = inner.tabs.remove(target_id) {
            self.frames
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&t.session_id);
        }
        inner.active.retain(|_, tid| tid != target_id);
    }

    /// Close every tab an owner holds (an agent deleted, a sign-in ended).
    pub fn close_all_of(&self, owner: &Owner) {
        for t in self.tabs_of(owner) {
            self.close_tab(&t);
        }
    }

    /* --------------------------------------------------------- pages */

    pub fn call(&self, tab: &Tab, method: &str, params: Value) -> Result<Value, String> {
        self.browser.call(method, params, Some(&tab.session_id), T)
    }

    /// Go to `url` (or "back"/"forward"), then wait for it to settle.
    pub fn navigate(&self, tab: &Tab, url: &str) -> Result<(), String> {
        match url.trim() {
            "back" | "forward" => {
                let h = self.call(tab, "Page.getNavigationHistory", json!({}))?;
                let at = h["currentIndex"].as_i64().unwrap_or(0);
                let entries = h["entries"].as_array().cloned().unwrap_or_default();
                let to = if url.trim() == "back" { at - 1 } else { at + 1 };
                let entry = usize::try_from(to)
                    .ok()
                    .and_then(|i| entries.get(i))
                    .ok_or("There's no page to go to that way.")?;
                self.call(
                    tab,
                    "Page.navigateToHistoryEntry",
                    json!({ "entryId": entry["id"] }),
                )?;
            }
            u => {
                let r = self.call(tab, "Page.navigate", json!({ "url": u }))?;
                if let Some(e) = r["errorText"].as_str().filter(|e| !e.is_empty()) {
                    return Err(format!("The page didn't load ({e})."));
                }
            }
        }
        self.settle(tab, Duration::from_secs(15));
        Ok(())
    }

    /// Wait until the document has loaded (or `max` passes).
    pub fn settle(&self, tab: &Tab, max: Duration) {
        let end = Instant::now() + max;
        std::thread::sleep(Duration::from_millis(150));
        while Instant::now() < end {
            let ready = self
                .eval(tab, "document.readyState")
                .ok()
                .and_then(|v| v.as_str().map(str::to_string));
            if ready.as_deref() == Some("complete") {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// The app's own expression in the page (never an agent's: there is no
    /// script tool), its value returned.
    pub fn eval(&self, tab: &Tab, expression: &str) -> Result<Value, String> {
        let r = self.call(
            tab,
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true, "silent": true }),
        )?;
        if r.get("exceptionDetails").is_some() {
            return Err("The page didn't answer.".into());
        }
        Ok(r["result"]["value"].clone())
    }

    /// The page's visible text, cut at `max` characters.
    pub fn text(&self, tab: &Tab, max: usize) -> String {
        let t = self
            .eval(tab, "document.body ? document.body.innerText : ''")
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        if t.chars().count() > max {
            t.chars().take(max).collect::<String>() + "\n… (cut)"
        } else {
            t
        }
    }

    /// What the focused field is, followed into shadow roots and same-origin
    /// frames. Focus in a frame the page can't see into (another site's), or
    /// a check that didn't answer, is [`Focus::Unknown`]: never typed into.
    pub fn focused_field(&self, tab: &Tab) -> Focus {
        Focus::from_answer(self.eval(tab, FOCUSED_FIELD_JS))
    }

    /// The focused field may take a password or a code: a secret one, or
    /// one that couldn't be told.
    pub fn focused_is_secret(&self, tab: &Tab) -> bool {
        self.focused_field(tab) != Focus::Plain
    }

    pub fn ax_nodes(&self, tab: &Tab) -> Result<Vec<Value>, String> {
        let r = self.call(tab, "Accessibility.getFullAXTree", json!({}))?;
        Ok(r["nodes"].as_array().cloned().unwrap_or_default())
    }

    /// The centre of a node, scrolled into view, in CSS pixels.
    pub fn center_of(&self, tab: &Tab, backend_node_id: i64) -> Result<(f64, f64), String> {
        let _ = self.call(
            tab,
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": backend_node_id }),
        );
        let bm = self
            .call(
                tab,
                "DOM.getBoxModel",
                json!({ "backendNodeId": backend_node_id }),
            )
            .map_err(|_| "That control isn't on the page any more. Read the page again.")?;
        let q: Vec<f64> = bm["model"]["content"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default();
        if q.len() != 8 {
            return Err("That control has no size on the page.".into());
        }
        Ok((
            (q[0] + q[2] + q[4] + q[6]) / 4.0,
            (q[1] + q[3] + q[5] + q[7]) / 4.0,
        ))
    }

    /// The node is a password (or one-time code) input, or couldn't be
    /// described: either way nothing is typed into it.
    pub fn node_is_secret(&self, tab: &Tab, backend_node_id: i64) -> bool {
        let Ok(d) = self.call(
            tab,
            "DOM.describeNode",
            json!({ "backendNodeId": backend_node_id }),
        ) else {
            return true;
        };
        let attrs: Vec<String> = d["node"]["attributes"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_ascii_lowercase()))
                    .collect()
            })
            .unwrap_or_default();
        attrs.chunks(2).any(|kv| match kv {
            [k, v] => {
                (k == "type" && v == "password")
                    || (k == "autocomplete"
                        && (v.contains("password") || v.contains("one-time-code")))
            }
            _ => false,
        })
    }

    /// A real click: move, press, release.
    pub fn click(&self, tab: &Tab, x: f64, y: f64) -> Result<(), String> {
        self.call(
            tab,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y }),
        )?;
        for t in ["mousePressed", "mouseReleased"] {
            self.call(
                tab,
                "Input.dispatchMouseEvent",
                json!({ "type": t, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )?;
        }
        Ok(())
    }

    /// Text at the focused field, as typing would put it there.
    pub fn insert_text(&self, tab: &Tab, text: &str) -> Result<(), String> {
        self.call(tab, "Input.insertText", json!({ "text": text }))
            .map(|_| ())
    }

    pub fn key(&self, tab: &Tab, key: super::keys::Key) -> Result<(), String> {
        let (down, up) = key.events();
        self.call(tab, "Input.dispatchKeyEvent", down)?;
        self.call(tab, "Input.dispatchKeyEvent", up)?;
        Ok(())
    }

    pub fn wheel(&self, tab: &Tab, x: f64, y: f64, dx: f64, dy: f64) -> Result<(), String> {
        self.call(
            tab,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy }),
        )
        .map(|_| ())
    }

    /// The viewport's size in CSS pixels.
    pub fn viewport(&self, tab: &Tab) -> (f64, f64) {
        self.call(tab, "Page.getLayoutMetrics", json!({}))
            .ok()
            .and_then(|m| {
                let v = m.get("cssLayoutViewport")?;
                Some((v["clientWidth"].as_f64()?, v["clientHeight"].as_f64()?))
            })
            .unwrap_or((WINDOW.0 as f64, WINDOW.1 as f64))
    }

    /// A JPEG of the viewport, at CSS-pixel size (so a point on it is a
    /// point `click` takes).
    pub fn screenshot(&self, tab: &Tab) -> Result<(Vec<u8>, u32, u32), String> {
        let (cw, ch) = self.viewport(tab);
        let r = self.call(
            tab,
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 70, "optimizeForSpeed": true }),
        )?;
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(r["data"].as_str().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        let img = image::load_from_memory(&raw).map_err(|e| e.to_string())?;
        let (w, h) = (cw.round().max(1.0) as u32, ch.round().max(1.0) as u32);
        let img = if img.width() > w {
            img.resize_exact(w, h, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let rgb = img.to_rgb8();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 70)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;
        Ok((out, rgb.width(), rgb.height()))
    }

    /* ------------------------------------------------------- windows */

    fn window_of(&self, tab: &Tab) -> Result<i64, String> {
        let w = self.browser.call(
            "Browser.getWindowForTarget",
            json!({ "targetId": tab.target_id }),
            None,
            T,
        )?;
        w["windowId"].as_i64().ok_or_else(|| "no window".into())
    }

    /// Into the corner, out of the way (never minimized).
    pub fn park(&self, tab: &Tab) -> Result<(), String> {
        let id = self.window_of(tab)?;
        let _ = self.browser.call(
            "Browser.setWindowBounds",
            json!({ "windowId": id, "bounds": { "windowState": "normal" } }),
            None,
            T,
        );
        self.browser.call(
            "Browser.setWindowBounds",
            json!({ "windowId": id, "bounds": { "left": chrome::PARK_AT.0, "top": chrome::PARK_AT.1, "width": WINDOW.0, "height": WINDOW.1 } }),
            None,
            T,
        )?;
        Ok(())
    }

    /// On screen and in front, for the person at the Mac.
    pub fn show(&self, tab: &Tab) -> Result<(), String> {
        let id = self.window_of(tab)?;
        self.browser.call(
            "Browser.setWindowBounds",
            json!({ "windowId": id, "bounds": { "left": 120, "top": 80, "width": 1100, "height": 820 } }),
            None,
            T,
        )?;
        let _ = self.browser.call(
            "Target.activateTarget",
            json!({ "targetId": tab.target_id }),
            None,
            T,
        );
        Ok(())
    }

    /* -------------------------------------------------------- frames */

    /// Start sending `tab`'s frames to its slot.
    pub fn watch(&self, tab: &Tab) -> Result<Arc<FrameSlot>, String> {
        let slot = self
            .frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(tab.session_id.clone())
            .or_default()
            .clone();
        self.call(
            tab,
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": 60,
                "maxWidth": FRAME_MAX_WIDTH,
                "maxHeight": FRAME_MAX_HEIGHT,
                "everyNthFrame": 1,
            }),
        )?;
        Ok(slot)
    }

    pub fn unwatch(&self, tab: &Tab) {
        let _ = self.call(tab, "Page.stopScreencast", json!({}));
        self.frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&tab.session_id);
    }

    fn slot(&self, session_id: &str) -> Option<Arc<FrameSlot>> {
        self.frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    fn on_event(&self, ev: &Event, acks: &std::sync::mpsc::Sender<(String, i64, Instant)>) {
        match ev.method.as_str() {
            "Page.screencastFrame" => {
                let Some(session) = ev.session_id.as_deref() else {
                    return;
                };
                let frame_id = ev.params["sessionId"].as_i64().unwrap_or(0);
                // Acked after the frame gap: Chrome sends the next one only
                // then, which is what caps the rate.
                let due = Instant::now() + Duration::from_millis(1000 / FPS);
                let _ = acks.send((session.to_string(), frame_id, due));
                let Some(slot) = self.slot(session) else {
                    return;
                };
                use base64::Engine as _;
                let Ok(jpeg) = base64::engine::general_purpose::STANDARD
                    .decode(ev.params["data"].as_str().unwrap_or(""))
                else {
                    return;
                };
                let (w, h) = jpeg_size(&jpeg).unwrap_or((0, 0));
                let m = &ev.params["metadata"];
                let css = (
                    m["deviceWidth"].as_f64().unwrap_or(w as f64),
                    m["deviceHeight"].as_f64().unwrap_or(h as f64),
                );
                slot.push(jpeg, w, h, css);
            }
            "Target.targetInfoChanged" => {
                let i = &ev.params["targetInfo"];
                if let Some(id) = i["targetId"].as_str() {
                    let mut inner = self.inner();
                    if let Some(t) = inner.tabs.get_mut(id) {
                        if let Some(u) = i["url"].as_str() {
                            t.url = u.to_string();
                        }
                        if let Some(ti) = i["title"].as_str() {
                            t.title = ti.to_string();
                        }
                    }
                }
            }
            "Target.targetDestroyed" => {
                if let Some(id) = ev.params["targetId"].as_str() {
                    self.forget(id);
                }
            }
            _ => {}
        }
    }
}

/// A JPEG's width and height, from its header.
pub fn jpeg_size(jpeg: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::with_format(std::io::Cursor::new(jpeg), image::ImageFormat::Jpeg)
        .into_dimensions()
        .ok()
}

fn spawn_pump(svc: std::sync::Weak<Service>, events: Receiver<Event>, dead: Arc<AtomicBool>) {
    let (ack_tx, ack_rx) = std::sync::mpsc::channel::<(String, i64, Instant)>();
    let browser = svc.upgrade().map(|s| Arc::downgrade(&s.browser));
    std::thread::spawn(move || {
        for (session, frame_id, due) in ack_rx {
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            let Some(b) = browser.as_ref().and_then(std::sync::Weak::upgrade) else {
                return;
            };
            let _ = b.call(
                "Page.screencastFrameAck",
                json!({ "sessionId": frame_id }),
                Some(&session),
                T,
            );
        }
    });
    std::thread::spawn(move || {
        for ev in events {
            let Some(s) = svc.upgrade() else { return };
            s.on_event(&ev, &ack_tx);
        }
        // The pipe closed: Chrome is gone.
        dead.store(true, Ordering::Relaxed);
    });
}

/* ------------------------------------------------------------ the one */

static RUNNING: Mutex<Option<Arc<Service>>> = Mutex::new(None);
/// Held while the profile is open in a plain window (`plain`): the agents'
/// Chrome can't start on the same profile meanwhile.
pub static PLAIN_HOLD: AtomicBool = AtomicBool::new(false);

/// Where the Agents profile lives: the app's own data, never the user's
/// Chrome (`chrome::profile_is_ours`).
pub fn profile_root() -> PathBuf {
    crate::brand::app_support_dir().join("agent-browser")
}

pub fn profile_dir() -> PathBuf {
    profile_root().join("Agents")
}

/// `agent` has a tab open in the agents' Chrome now (doesn't start it).
pub fn has_tabs(agent: &str) -> bool {
    running().is_some_and(|s| s.has_owner(&Owner::Agent(agent.to_string())))
}

/// Bring `agent`'s current tab on screen and in front (`show`), or put it
/// back in its corner (`!show`), so the person can watch it work.
pub fn show_agent(agent: &str, show: bool) -> Result<(), String> {
    let svc = running().ok_or("Its browser isn't open right now.")?;
    let tab = svc
        .tab_for(agent, None)
        .map_err(|_| "It has no page open in its browser right now.".to_string())?;
    if show {
        svc.show(&tab)
    } else {
        svc.park(&tab)
    }
}

/// The running Chrome, if there is one (doesn't start it).
pub fn running() -> Option<Arc<Service>> {
    let mut g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().is_some_and(|s| s.dead()) {
        *g = None;
    }
    g.clone()
}

/// The agents' Chrome, started if it isn't running.
pub fn ensure() -> Result<Arc<Service>, String> {
    if PLAIN_HOLD.load(Ordering::Relaxed) {
        return Err(super::BUSY_PLAIN.into());
    }
    let mut g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    // Running means switched on: the switch going off closes it.
    if let Some(s) = g.as_ref().filter(|s| !s.dead()) {
        s.touch();
        return Ok(s.clone());
    }
    if !super::settings::enabled() {
        return Err("The agents' browser is off in Settings → Agents.".into());
    }
    let chrome = chrome::find_chrome()
        .ok_or("Google Chrome isn't installed on this Mac, so agents have no browser of their own. Install it from google.com/chrome.")?;
    let svc = launch_at(&chrome, &profile_dir(), &profile_root())?;
    *g = Some(svc.clone());
    spawn_reaper();
    tracing::info!(pid = svc.browser.pid(), "[AgentBrowser] started");
    Ok(svc)
}

/// Start `chrome` on `profile` (which must be inside `root`) and take it over.
pub fn launch_at(chrome: &Path, profile: &Path, root: &Path) -> Result<Arc<Service>, String> {
    if !chrome::profile_is_ours(profile, root) {
        return Err("That profile isn't the app's own.".into());
    }
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    }
    let args = chrome::args(&chrome::LaunchSpec {
        user_data_dir: profile.to_path_buf(),
        window: chrome::Window::Parked {
            width: WINDOW.0,
            height: WINDOW.1,
        },
        mute: true,
    });
    let browser =
        Browser::launch(chrome, &args).map_err(|e| format!("Chrome didn't start: {e}"))?;
    Service::start(browser, profile.to_path_buf())
}

/// Use `svc` as the running Chrome: tests (a fake one) and the live
/// example (a real Chrome on a scratch profile, never the app's own).
pub fn install_for_tests(svc: Arc<Service>) {
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(svc);
}

/// Close it (Settings switch off, a plain sign-in, the app quitting).
pub fn shutdown() {
    let svc = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(s) = svc {
        s.browser.shutdown();
        tracing::info!("[AgentBrowser] closed");
    }
}

static REAPER: AtomicBool = AtomicBool::new(false);

fn spawn_reaper() {
    if REAPER.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let Some(s) = running() else { continue };
        let signing_in = s
            .inner()
            .tabs
            .values()
            .any(|t| matches!(t.owner, Owner::Signin(_)));
        if !signing_in && s.idle_for() >= IDLE {
            tracing::info!("[AgentBrowser] idle; closing");
            shutdown();
        }
    });
}

#[cfg(test)]
#[path = "service_tests.rs"]
pub(crate) mod tests;
