//! The `user_chrome` MCP server: the user's own Chrome through the app's
//! extension, answered on the agent bridge at `/mcp/user-chrome` for Claude
//! Code and Codex turns alike, whatever account each runs on.
//!
//! **The same tools as the agents' browser** (`agent_browser::tools`): the
//! same names and arguments, refs from the same accessibility-tree reader,
//! and the same page logic (`agent_browser::page`), plus `hover`, and
//! `browsers` / `use_browser` for the Chrome profiles the extension is in.
//!
//! **Who's calling** is the turn's bearer secret (`agents::reach`), and an
//! agent sees and acts only in the tabs it opened: the app keeps that list,
//! and the extension keeps its own and refuses any other tab.
//!
//! **What asks** is `agents::browser_gate` with Claude in Chrome's rules
//! (it is the user's signed-in Chrome): looking is free, acting is free
//! unless it would send, post, pay, delete or share, Enter outside a search
//! box asks, outside text never gets it. A call the engine already asked
//! about leaves a one-time pass ([`note_cleared`]).
//!
//! **What never happens here**: no script tool, no uploads, no downloads,
//! never typing into a password or one-time-code field, and only the CDP
//! methods and the app's own expressions the extension allows.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::link::{CallError, Conn};
use super::protocol::{ExtEvent, Op, TabInfo};
use crate::agent_browser::axtree::{self, RefTarget};
use crate::agent_browser::keys::Key;
use crate::agent_browser::page::{scroll_step_js, Focus, PageCdp, Scrolled};
use crate::agents::browser_gate::{self, Gate, USER_CHROME_SERVER};

/// The server's name in a turn's MCP config (tools are `mcp__user_chrome__*`).
pub const SERVER_KEY: &str = "user_chrome";
/// Its path on the agent bridge.
pub const PATH: &str = "/mcp/user-chrome";

pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{PATH}")
}

/// A CDP command's wait.
const T: Duration = Duration::from_secs(20);
/// What one `type` may carry.
const MAX_TYPE: usize = 4000;
const MAX_TEXT: usize = 20_000;
/// Tabs one agent may hold at once.
pub const MAX_TABS: usize = 6;

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    schema: fn() -> Value,
}

/// The agents' browser's schema for a tool of the same name.
fn same_as_agents(name: &str) -> Value {
    crate::agent_browser::tools::TOOLS
        .iter()
        .find(|t| t.name == name)
        .map(|t| (t.schema)())
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
}

fn tab_prop() -> Value {
    json!({ "type": "integer", "description": "Which of your tabs (from `tabs`). Default: the one you used last." })
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "tabs",
        description: "List the tabs you opened in the user's Chrome: number, title and address.",
        schema: || same_as_agents("tabs"),
    },
    ToolDef {
        name: "open",
        description: "Open a web page (http or https) in a new tab of the user's own Chrome, where they're signed in, in a tab group of yours. Returns where it landed.",
        schema: || same_as_agents("open"),
    },
    ToolDef {
        name: "navigate",
        description: "Go to a web page in one of your tabs, or \"back\" / \"forward\".",
        schema: || same_as_agents("navigate"),
    },
    ToolDef {
        name: "read_page",
        description: "Read the page as its accessibility tree: headings, text and every control with a ref (ref_N) that click and type take. `interactive: true` lists controls and headings only.",
        schema: || same_as_agents("read_page"),
    },
    ToolDef {
        name: "find",
        description: "Find controls or text on the page by words (\"search box\", \"Sign in\"). Returns the matching lines with their refs.",
        schema: || same_as_agents("find"),
    },
    ToolDef {
        name: "get_text",
        description: "The page's visible text, as plain text.",
        schema: || same_as_agents("get_text"),
    },
    ToolDef {
        name: "screenshot",
        description: "A picture of the visible page. Its pixels are the page's: click takes x, y on it.",
        schema: || same_as_agents("screenshot"),
    },
    ToolDef {
        name: "click",
        description: "Click a control by its ref from read_page or find (preferred), or at x, y on the screenshot. A click that would send, post, pay, delete or share asks the user first.",
        schema: || same_as_agents("click"),
    },
    ToolDef {
        name: "hover",
        description: "Point at a control by its ref (or at x, y) without clicking, to open a menu or a tooltip.",
        schema: || json!({ "type": "object", "properties": { "ref": { "type": "string" }, "x": { "type": "number" }, "y": { "type": "number" }, "tab": tab_prop() } }),
    },
    ToolDef {
        name: "type",
        description: "Type text into a field (by ref; it's clicked first) or wherever the cursor is. Never a password: password and one-time-code fields are refused.",
        schema: || same_as_agents("type"),
    },
    ToolDef {
        name: "press",
        description: "Press one key: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End. Enter outside a search box asks the user first.",
        schema: || same_as_agents("press"),
    },
    ToolDef {
        name: "attach_image",
        description: "Attach a picture from this Mac to the page. With a ref (the composer, the site's upload button or its drop area) it goes in as a file, the way the site's own upload takes it, else it's pasted there; with no ref it's pasted wherever the cursor is. `path`: a PNG, JPEG, GIF or WebP in your own folder or a project, at most 20 MB. Asks the user first, like any upload.",
        schema: || json!({ "type": "object", "properties": { "path": { "type": "string", "description": "Full path to the image." }, "ref": { "type": "string" }, "tab": tab_prop() }, "required": ["path"] }),
    },
    ToolDef {
        name: "scroll",
        description: "Scroll the page (or the control `ref` is in): up, down, left or right, by 1-10 steps.",
        schema: || same_as_agents("scroll"),
    },
    ToolDef {
        name: "wait_for",
        description: "Wait until `text` shows on the page (up to `seconds`, at most 30), or just wait `seconds`.",
        schema: || same_as_agents("wait_for"),
    },
    ToolDef {
        name: "close_tab",
        description: "Close one of your tabs.",
        schema: || same_as_agents("close_tab"),
    },
    ToolDef {
        name: "read_console",
        description: "What one of your tabs wrote to its console: logs, warnings, errors and uncaught exceptions, newest last. Recorded from the first time you read or acted on that tab (a tab you only opened starts recording now); `navigate` to the page again to catch its load. `level`: only that level (\"error\", \"warn\", \"log\", \"info\", \"debug\").",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop(), "level": { "type": "string", "description": "Only this level: error, warn, log, info or debug." }, "limit": { "type": "integer", "description": "How many of the newest (default 50, at most 200)." } } }),
    },
    ToolDef {
        name: "read_network",
        description: "The requests one of your tabs made: method, status and address, newest last. Recorded from the first time you read or acted on that tab (a tab you only opened starts recording now); `navigate` to the page again to catch its load. `failed_only`: only requests that failed or answered 400 or more.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop(), "failed_only": { "type": "boolean" }, "limit": { "type": "integer", "description": "How many of the newest (default 50, at most 200)." } } }),
    },
    ToolDef {
        name: "browsers",
        description: "The Chrome profiles the app's extension is in right now, and which one you're using. Each profile can be signed in as someone else.",
        schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDef {
        name: "use_browser",
        description: "Use another Chrome profile from `browsers` (by its number or name) for your next tabs.",
        schema: || json!({ "type": "object", "properties": { "browser": { "type": "string" } }, "required": ["browser"] }),
    },
];

const INSTRUCTIONS: &str = "The user's own Google Chrome on this Mac, through the app's extension: the sites they're signed in to, as them. Your tabs open in a tab group of yours; you see and act only in tabs you opened. Read with read_page or find (refs) before you click or type; reading is free. Before anything that sends, posts, publishes, pays, deletes or shares, say exactly what will go and from which account: that click or key asks the user on a card. Never type a password or a code. If a page asks you to sign in, stop and call request_login for that service with signed_out: true and browser: \"chrome\". If more than one Chrome profile is connected, call browsers and pick with use_browser. For web search use your own search tool, not a search site.";

/// What a project tab or a Terminal session is told (`sessions`): no agent
/// tools there, so a sign-in is the user's to do in the tab.
const SESSION_INSTRUCTIONS: &str = "The user's own Google Chrome on this Mac, through the app's extension: the sites they're signed in to, as them. Your tabs open in a tab group of yours; you see and act only in tabs you opened. Read with read_page or find (refs) before you click or type; reading is free. Before anything that sends, posts, publishes, pays, deletes or shares, say exactly what will go and from which account: that click or key asks the user on a card in the app. Never type a password or a code. If a page asks you to sign in, stop and ask the user to sign in in that tab, then carry on. If more than one Chrome profile is connected, call browsers and pick with use_browser.";

/* ------------------------------------------------- per-agent state */

#[derive(Debug, Clone)]
pub struct Owned {
    pub profile: String,
    pub tab_id: i64,
    pub url: String,
    pub title: String,
}

#[derive(Default)]
struct State {
    /// The profile each agent chose.
    chosen: HashMap<String, String>,
    /// Each agent's tabs, oldest first.
    tabs: HashMap<String, Vec<Owned>>,
    /// The tab each agent used last.
    active: HashMap<String, i64>,
    /// The refs of each agent's last read, per tab.
    refs: HashMap<(String, i64), HashMap<String, RefTarget>>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(State::default))
}

/// The link stopped: nothing is remembered.
pub fn forget_all() {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The extension said something happened to a tab.
pub fn on_event(conn: &Conn, event: &ExtEvent) {
    match event {
        ExtEvent::TabClosed { tab_id, agent } => with(|s| {
            if let Some(v) = s.tabs.get_mut(agent) {
                v.retain(|t| !(t.tab_id == *tab_id && t.profile == conn.profile_id));
            }
            s.refs.remove(&(agent.clone(), *tab_id));
            if s.active.get(agent) == Some(tab_id) {
                s.active.remove(agent);
            }
        }),
        ExtEvent::TabUpdated {
            tab_id,
            agent,
            url,
            title,
        } => with(|s| {
            if let Some(t) = s
                .tabs
                .get_mut(agent)
                .and_then(|v| v.iter_mut().find(|t| t.tab_id == *tab_id))
            {
                t.url = url.clone();
                t.title = title.clone();
            }
        }),
        ExtEvent::DebuggerDetached {
            tab_id,
            agent,
            reason,
        } => {
            tracing::info!(
                tab_id,
                agent,
                reason,
                "[UserChrome] Chrome stopped the app driving a tab"
            );
        }
    }
}

/* ------------------------------------------------------- one-time passes */

const CLEARED_FOR: Duration = Duration::from_secs(120);
type Pass = (String, String, Value, Instant);
static CLEARED: Mutex<Vec<Pass>> = Mutex::new(Vec::new());

/// The engine asked, the gate said this call asks, and the user allowed it:
/// that exact call goes through once.
pub fn note_cleared(agent_id: &str, tool: &str, input: &Value) {
    let mut v = CLEARED.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    v.retain(|(_, _, _, at)| now.duration_since(*at) < CLEARED_FOR);
    v.push((agent_id.to_string(), tool.to_string(), input.clone(), now));
}

fn take_cleared(agent_id: &str, tool: &str, input: &Value) -> bool {
    let mut v = CLEARED.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    v.retain(|(_, _, _, at)| now.duration_since(*at) < CLEARED_FOR);
    match v
        .iter()
        .position(|(a, t, i, _)| a == agent_id && t == tool && i == input)
    {
        Some(i) => {
            v.remove(i);
            true
        }
        None => false,
    }
}

/* ------------------------------------------------------------ a page */

/// One of an agent's tabs, as a [`PageCdp`] page.
pub struct ExtPage {
    conn: Arc<Conn>,
    agent: String,
    tab_id: i64,
}

impl PageCdp for ExtPage {
    fn cdp(&self, method: &str, params: Value) -> Result<Value, String> {
        self.conn
            .call(
                Op::Cdp {
                    agent: self.agent.clone(),
                    tab_id: self.tab_id,
                    method: method.into(),
                    params,
                },
                T,
            )
            .map_err(|e| e.line())
    }
}

fn line_of(e: CallError) -> String {
    e.line()
}

/// The connection an agent's calls go to.
fn conn_for(agent: &str) -> Result<Arc<Conn>, String> {
    let reg = super::registry();
    let conns = reg.conns();
    if conns.is_empty() {
        return Err("The user's Chrome isn't connected right now (Chrome is closed, or the extension is off). Ask them to open Chrome, then try again; or use the agents' browser.".into());
    }
    if let Some(p) = with(|s| s.chosen.get(agent).cloned()) {
        if let Some(c) = reg.by_profile(&p) {
            return Ok(c);
        }
    }
    // The profile the agent's tabs are in, if it has any.
    if let Some(p) = with(|s| {
        s.tabs
            .get(agent)
            .and_then(|v| v.last())
            .map(|t| t.profile.clone())
    }) {
        if let Some(c) = reg.by_profile(&p) {
            return Ok(c);
        }
    }
    match conns.as_slice() {
        [only] => Ok(only.clone()),
        _ => Err("More than one Chrome profile is connected. Call browsers, then use_browser with the one to use.".into()),
    }
}

/// One of the agent's tabs: the one named, else the one it used last.
fn tab_for(agent: &str, conn: &Conn, id: Option<i64>) -> Result<Owned, String> {
    with(|s| {
        let mine = s.tabs.get(agent).cloned().unwrap_or_default();
        // The one named; else the one used last, if it's still open; else
        // the newest.
        let found = match id {
            Some(id) => mine.iter().find(|t| t.tab_id == id).cloned(),
            None => s
                .active
                .get(agent)
                .and_then(|a| mine.iter().find(|t| t.tab_id == *a))
                .or(mine.last())
                .cloned(),
        };
        match found {
            Some(t) if t.profile == conn.profile_id => Ok(t),
            Some(_) => Err("That tab is in another Chrome profile. Call browsers, or use one of this profile's tabs.".into()),
            None if mine.is_empty() => Err("You have no tabs open in the user's Chrome. Use `open` with a URL.".into()),
            None => Err("That isn't one of your tabs. Use `tabs` to see yours.".into()),
        }
    })
}

/// Make the tab the shown one of its window before a click or a key. Chrome
/// paints only that tab, and input to a tab it isn't painting waits for a
/// frame: a pointer move to an agent's tab behind another agent's waited
/// out Chrome's 5 s input timeout every time.
fn to_front(conn: &Conn, agent: &str, tab: &Owned) -> Result<(), String> {
    conn.call(
        Op::TabFocus {
            agent: agent.into(),
            tab_id: tab.tab_id,
        },
        T,
    )
    .map(|_| ())
    .map_err(line_of)
}

/// A click, made so it lands at once whether or not Chrome is painting the
/// tab: the pointer moves first only where Chrome paints (a move waits for
/// a frame; a press carries its own position).
fn click(p: &ExtPage, x: f64, y: f64) -> Result<(), String> {
    if p.painted() {
        p.click(x, y)
    } else {
        p.press_at(x, y)
    }
}

/// Hover where Chrome isn't painting: a move would wait for a frame.
const NOT_PAINTED_HOVER: &str = "Chrome isn't showing the agents' window right now (it's minimised, or covered by other windows), and pointing at something only works where Chrome paints. Click instead, or ask the user to bring that Chrome window back.";

fn page(conn: &Arc<Conn>, agent: &str, tab: &Owned) -> ExtPage {
    with(|s| s.active.insert(agent.to_string(), tab.tab_id));
    ExtPage {
        conn: conn.clone(),
        agent: agent.into(),
        tab_id: tab.tab_id,
    }
}

fn set_refs(agent: &str, tab: i64, refs: HashMap<String, RefTarget>) {
    let labels: HashMap<String, String> = refs
        .iter()
        .map(|(k, v)| (k.clone(), v.label.clone()))
        .collect();
    with(|s| s.refs.insert((agent.to_string(), tab), refs));
    browser_gate::note_user_chrome_page(agent, |p| p.refs = labels);
}

fn ref_of(agent: &str, tab: i64, r: &str) -> Result<RefTarget, String> {
    with(|s| {
        s.refs
            .get(&(agent.to_string(), tab))
            .and_then(|m| m.get(r.trim()))
            .cloned()
    })
    .ok_or_else(|| {
        format!("{r} isn't on this tab's last read. Read the page again (read_page or find).")
    })
}

fn clear_refs(agent: &str, tab: i64) {
    with(|s| s.refs.remove(&(agent.to_string(), tab)));
}

/// The tab as Chrome has it now, kept in the agent's list.
fn refreshed(conn: &Conn, agent: &str, tab: &Owned) -> Owned {
    let info = conn
        .call(
            Op::TabGet {
                agent: agent.into(),
                tab_id: tab.tab_id,
            },
            T,
        )
        .ok()
        .and_then(|v| serde_json::from_value::<TabInfo>(v).ok());
    let Some(info) = info else {
        return tab.clone();
    };
    let t = Owned {
        profile: tab.profile.clone(),
        tab_id: tab.tab_id,
        url: info.url,
        title: info.title,
    };
    with(|s| {
        if let Some(o) = s
            .tabs
            .get_mut(agent)
            .and_then(|v| v.iter_mut().find(|o| o.tab_id == t.tab_id))
        {
            *o = t.clone();
        }
    });
    t
}

/// The gate's memory of where the agent's tabs are.
fn note_where(agent: &str, active: Option<&Owned>) {
    let tabs = with(|s| s.tabs.get(agent).cloned().unwrap_or_default());
    browser_gate::note_user_chrome_page(agent, |p| {
        p.tabs = tabs
            .iter()
            .map(|t| (t.tab_id as u64, t.url.clone()))
            .collect();
        if let Some(a) = active {
            p.url = Some(a.url.clone());
        }
    });
}

fn text(s: impl Into<String>) -> Value {
    json!({ "type": "text", "text": s.into() })
}

fn result(content: Vec<Value>, error: bool) -> Value {
    if error {
        json!({ "content": content, "isError": true })
    } else {
        json!({ "content": content })
    }
}

fn web_url(u: &str) -> Result<String, String> {
    let t = u.trim();
    if matches!(t, "back" | "forward") {
        return Ok(t.to_string());
    }
    browser_gate::host_of(t)
        .map(|_| t.to_string())
        .ok_or_else(|| "Only http and https pages open here.".to_string())
}

fn tab_arg(args: &Value) -> Option<i64> {
    args.get("tab").and_then(Value::as_i64)
}

/// "Tab 812 · Example Domain · https://example.com/", and what the page
/// means for the agent (a sign-in page).
pub fn where_line(t: &Owned) -> String {
    let mut line = format!(
        "Tab {} · {} · {}",
        t.tab_id,
        if t.title.is_empty() {
            "(untitled)"
        } else {
            &t.title
        },
        t.url
    );
    let landed = crate::agents::browser::Landed {
        url: t.url.clone(),
        title: t.title.clone(),
    };
    if crate::agents::browser::signed_in("", &landed) == Some(false) {
        line.push_str("\n\nSigned out here, in the user's own Chrome (a sign-in or signed-out page). Don't type anything into it: call request_login for this service with signed_out: true and browser: \"chrome\".");
    }
    line
}

/// The ref name the gate is shown for a click by position whose control was
/// found under the point ([`label_at`]).
pub const AT_POINT_REF: &str = "@point";

/// The label of the control under a click by position (`button "Next"`,
/// `radio "Yes"`), read from the page's controls and their boxes. `None`
/// when the click names a ref, has no point, or nothing is under it. Lets
/// the gate judge a click by what it clicks: Julian, 2026-11-17, at Bold,
/// clicks on radios and Next raised "goes out under your name" cards
/// because they were made by position after typing.
fn label_at(agent: &str, args: &Value) -> Option<String> {
    if args.get("ref").is_some() {
        return None;
    }
    let (x, y) = xy(args)?;
    let why = |step: &str, e: &str| {
        tracing::info!(
            agent,
            step,
            error = e,
            x,
            y,
            "[UserChrome] point lookup failed"
        );
    };
    let conn = conn_for(agent)
        .map_err(|e| why("conn", &e.to_string()))
        .ok()?;
    let tab = tab_for(agent, &conn, tab_arg(args))
        .map_err(|e| why("tab", &e.to_string()))
        .ok()?;
    let p = page(&conn, agent, &tab);
    let nodes = p.ax_nodes().map_err(|e| why("ax", &e)).ok()?;
    let r = axtree::render(&nodes, true);
    let mut failed = 0usize;
    let boxes: Vec<(String, Vec<f64>)> = r
        .refs
        .values()
        .take(MAX_POINT_LOOKUPS)
        .filter_map(|t| {
            let bm = match p.cdp(
                "DOM.getBoxModel",
                json!({ "backendNodeId": t.backend_node_id }),
            ) {
                Ok(v) => v,
                Err(e) => {
                    if failed == 0 {
                        why("box", &e);
                    }
                    failed += 1;
                    return None;
                }
            };
            let q: Vec<f64> = bm["model"]["border"]
                .as_array()?
                .iter()
                .filter_map(Value::as_f64)
                .collect();
            Some((t.label.clone(), q))
        })
        .collect();
    let found = smallest_under(&boxes, x, y);
    tracing::info!(
        agent,
        nodes = nodes.len(),
        refs = r.refs.len(),
        boxes = boxes.len(),
        failed,
        x,
        y,
        found = found.as_deref().unwrap_or("-"),
        sample = ?boxes.iter().take(3).collect::<Vec<_>>(),
        "[UserChrome] point lookup"
    );
    found
}

/// The roles a click by position may be named by.
const POINT_ROLES: &[&str] = &[
    "button",
    "link",
    "radio",
    "checkbox",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "menuitemcheckbox",
    "option",
    "combobox",
    "textbox",
    "searchbox",
    "listbox",
    "slider",
    "spinbutton",
    "treeitem",
];

/// Controls looked at for one click by position.
const MAX_POINT_LOOKUPS: usize = 400;

/// The label of the smallest box (a CDP quad) holding the point. Pure.
pub fn smallest_under(boxes: &[(String, Vec<f64>)], x: f64, y: f64) -> Option<String> {
    // Only controls: a dialog or group holding the point says nothing about
    // an unlabelled button inside it, which stays unknown.
    let control = |label: &str| {
        let role = label.split_whitespace().next().unwrap_or("");
        POINT_ROLES.contains(&role)
    };
    boxes
        .iter()
        .filter(|(label, q)| q.len() == 8 && control(label))
        .filter_map(|(label, q)| {
            let xs = [q[0], q[2], q[4], q[6]];
            let ys = [q[1], q[3], q[5], q[7]];
            let (x0, x1) = (
                xs.iter().cloned().fold(f64::MAX, f64::min),
                xs.iter().cloned().fold(f64::MIN, f64::max),
            );
            let (y0, y1) = (
                ys.iter().cloned().fold(f64::MAX, f64::min),
                ys.iter().cloned().fold(f64::MIN, f64::max),
            );
            (x >= x0 && x <= x1 && y >= y0 && y <= y1 && x1 > x0 && y1 > y0)
                .then(|| (label, (x1 - x0) * (y1 - y0)))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(label, _)| label.clone())
}

/// What the gate judges for `args`: a click by position whose control was
/// found is judged as a click on that control's ref.
fn gated_args(agent: &str, name: &str, args: &Value, at: Option<&str>) -> Value {
    match (name, at) {
        ("click", Some(label)) => {
            let label = label.to_string();
            browser_gate::note_user_chrome_page(agent, |p| {
                p.refs.insert(AT_POINT_REF.into(), label);
            });
            let mut a = args.clone();
            if let Some(o) = a.as_object_mut() {
                o.remove("x");
                o.remove("y");
                o.insert("ref".into(), json!(AT_POINT_REF));
            }
            a
        }
        _ => args.clone(),
    }
}

fn xy(args: &Value) -> Option<(f64, f64)> {
    match (
        args.get("x").and_then(Value::as_f64),
        args.get("y").and_then(Value::as_f64),
    ) {
        (Some(x), Some(y)) if x >= 0.0 && y >= 0.0 => Some((x, y)),
        _ => None,
    }
}

/// The browsers line for `browsers`.
fn browsers_text(agent: &str) -> String {
    let reg = super::registry();
    let conns = reg.conns();
    if conns.is_empty() {
        return "No Chrome is connected right now.".into();
    }
    let chosen = conn_for(agent).ok().map(|c| c.profile_id.clone());
    conns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let name = if c.profile_label.is_empty() {
                format!("Chrome profile {}", i + 1)
            } else {
                c.profile_label.clone()
            };
            let mark = if chosen.as_deref() == Some(c.profile_id.as_str()) {
                " (you're using this one)"
            } else {
                ""
            };
            format!("{} · {name}{mark}", i + 1)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The picture's type, from its extension (`attachable` allows only these).
fn image_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

/// Pictures an agent may attach: an image file, inside its own folder or
/// the projects folder, at most 20 MB. Anything else is refused.
pub fn attachable(agent: &str, raw: &str) -> Result<std::path::PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Give the picture's full path.".into());
    }
    let path = std::fs::canonicalize(raw).map_err(|_| format!("No file at {raw}."))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err("Only pictures attach this way: PNG, JPEG, GIF or WebP.".into());
    }
    let mut roots = Vec::new();
    if let Ok(home) = crate::agents::store::agent_home(agent) {
        roots.extend(std::fs::canonicalize(home));
    }
    if let Ok(projects) = crate::utils::projects_root() {
        roots.extend(std::fs::canonicalize(projects));
    }
    if !roots.iter().any(|r| path.starts_with(r)) {
        return Err(
            "Attach pictures from your own folder or a project. Copy it there first.".into(),
        );
    }
    let size = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(u64::MAX);
    if size > 20 * 1024 * 1024 {
        return Err("That picture is over 20 MB.".into());
    }
    Ok(path)
}

/// Run one tool, blocking. `label`: the agent's name, for its tab group.
/// `Err` is told to the agent as an error result.
pub fn run(agent: &str, label: &str, name: &str, args: &Value) -> Result<Vec<Value>, String> {
    match name {
        "browsers" => return Ok(vec![text(browsers_text(agent))]),
        "use_browser" => {
            let want = args
                .get("browser")
                .map(|v| match v {
                    Value::String(s) => s.trim().to_string(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            let conns = super::registry().conns();
            let pick = want
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|i| conns.get(i))
                .or_else(|| {
                    conns.iter().find(|c| {
                        !c.profile_label.is_empty() && c.profile_label.eq_ignore_ascii_case(&want)
                    })
                })
                .ok_or("No connected Chrome profile by that name. Call browsers to see them.")?;
            with(|s| s.chosen.insert(agent.to_string(), pick.profile_id.clone()));
            return Ok(vec![text(format!(
                "Using that profile now.\n{}",
                browsers_text(agent)
            ))]);
        }
        _ => {}
    }
    let conn = conn_for(agent)?;
    match name {
        "tabs" => {
            let v = conn.call(Op::TabsList, T).map_err(line_of)?;
            let all: Vec<TabInfo> = serde_json::from_value(v).unwrap_or_default();
            let mine: Vec<Owned> = all
                .into_iter()
                .filter(|t| t.agent == agent)
                .map(|t| Owned {
                    profile: conn.profile_id.clone(),
                    tab_id: t.tab_id,
                    url: t.url,
                    title: t.title,
                })
                .collect();
            with(|s| {
                let keep: Vec<Owned> = s
                    .tabs
                    .get(agent)
                    .map(|v| {
                        v.iter()
                            .filter(|t| t.profile != conn.profile_id)
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                let mut next = keep;
                next.extend(mine.iter().cloned());
                s.tabs.insert(agent.to_string(), next);
            });
            note_where(agent, None);
            if mine.is_empty() {
                return Ok(vec![text("No tabs open. Use `open` with a URL.")]);
            }
            Ok(vec![text(
                mine.iter()
                    .map(|t| format!("{} · {} · {}", t.tab_id, t.title, t.url))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )])
        }
        "open" => {
            let url = web_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            if matches!(url.as_str(), "back" | "forward") {
                return Err("Open takes a web address.".into());
            }
            if with(|s| s.tabs.get(agent).map_or(0, Vec::len)) >= MAX_TABS {
                return Err(format!(
                    "You have {MAX_TABS} tabs open: close one first (close_tab)."
                ));
            }
            let v = conn
                .call(
                    Op::TabsOpen {
                        agent: agent.into(),
                        label: label.chars().take(40).collect(),
                        url,
                        color: None,
                    },
                    T,
                )
                .map_err(line_of)?;
            let info: TabInfo = serde_json::from_value(v)
                .map_err(|_| "Chrome opened a tab but didn't say which.".to_string())?;
            let tab = Owned {
                profile: conn.profile_id.clone(),
                tab_id: info.tab_id,
                url: info.url,
                title: info.title,
            };
            with(|s| {
                s.tabs
                    .entry(agent.to_string())
                    .or_default()
                    .push(tab.clone())
            });
            let p = page(&conn, agent, &tab);
            p.settle(Duration::from_secs(15));
            let tab = refreshed(&conn, agent, &tab);
            note_where(agent, Some(&tab));
            Ok(vec![text(where_line(&tab))])
        }
        "navigate" => {
            let url = web_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            page(&conn, agent, &tab).navigate(&url)?;
            clear_refs(agent, tab.tab_id);
            let tab = refreshed(&conn, agent, &tab);
            note_where(agent, Some(&tab));
            Ok(vec![text(where_line(&tab))])
        }
        "read_page" | "find" => {
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            let p = page(&conn, agent, &tab);
            let interactive = name == "read_page"
                && args.get("interactive").and_then(Value::as_bool) == Some(true);
            let r = axtree::render(&p.ax_nodes()?, interactive);
            let out = if name == "find" {
                let q = args.get("query").and_then(Value::as_str).unwrap_or("");
                let found = axtree::find(&r, q);
                if found.is_empty() {
                    format!("Nothing on the page matches \"{q}\".")
                } else {
                    found
                }
            } else {
                r.text.clone()
            };
            set_refs(agent, tab.tab_id, r.refs);
            let tab = refreshed(&conn, agent, &tab);
            note_where(agent, Some(&tab));
            Ok(vec![text(out)])
        }
        "get_text" => {
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            Ok(vec![text(page(&conn, agent, &tab).text(MAX_TEXT))])
        }
        "read_console" | "read_network" => {
            if super::older(&conn.extension_version, LOGS_SINCE) {
                return Err(logs_need_update(&conn.extension_version));
            }
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            let console = name == "read_console";
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .map_or(50, |n| n.clamp(1, 200)) as u32;
            let v = conn
                .call(
                    Op::TabLogs {
                        agent: agent.into(),
                        tab_id: tab.tab_id,
                        log: if console { "console" } else { "network" }.into(),
                        since: None,
                        // Filtering happens here: ask for all kept, then take the newest.
                        limit: Some(200),
                    },
                    T,
                )
                .map_err(|e| match &e {
                    CallError::Ext(x)
                        if x.code == super::protocol::ErrorCode::BadRequest
                            && x.message.contains("unknown op") =>
                    {
                        logs_need_update(&conn.extension_version)
                    }
                    _ => e.line(),
                })?;
            let got: Logged = serde_json::from_value(v)
                .map_err(|_| "Chrome answered, but not with its logs.".to_string())?;
            Ok(vec![text(if console {
                console_text(
                    &got,
                    args.get("level").and_then(Value::as_str),
                    limit as usize,
                )
            } else {
                network_text(
                    &got,
                    args.get("failed_only")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    limit as usize,
                )
            })])
        }
        "screenshot" => {
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            // Chrome paints only the shown tab of a window.
            conn.call(
                Op::TabFocus {
                    agent: agent.into(),
                    tab_id: tab.tab_id,
                },
                T,
            )
            .map_err(line_of)?;
            let (jpeg, w, h) = page(&conn, agent, &tab).screenshot()?;
            use base64::Engine as _;
            Ok(vec![
                json!({ "type": "image", "mimeType": "image/jpeg", "data": base64::engine::general_purpose::STANDARD.encode(jpeg) }),
                text(format!("{w}×{h}: click takes x, y in these pixels.")),
            ])
        }
        "click" | "hover" => {
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            to_front(&conn, agent, &tab)?;
            let p = page(&conn, agent, &tab);
            let (x, y) = match args.get("ref").and_then(Value::as_str) {
                Some(r) => p.center_of(ref_of(agent, tab.tab_id, r)?.backend_node_id)?,
                None => xy(args).ok_or(if name == "click" {
                    "Click takes a ref, or x and y."
                } else {
                    "Hover takes a ref, or x and y."
                })?,
            };
            if name == "hover" {
                if !p.painted() {
                    return Err(NOT_PAINTED_HOVER.into());
                }
                p.hover(x, y)?;
                return Ok(vec![text(
                    "Pointed. Read the page again to see what opened.",
                )]);
            }
            click(&p, x, y)?;
            p.settle(Duration::from_secs(5));
            clear_refs(agent, tab.tab_id);
            let tab = refreshed(&conn, agent, &tab);
            note_where(agent, Some(&tab));
            Ok(vec![text(format!("Clicked. {}", where_line(&tab)))])
        }
        "type" => {
            let t = args.get("text").and_then(Value::as_str).unwrap_or("");
            if t.is_empty() {
                return Err("Nothing to type.".into());
            }
            if t.chars().count() > MAX_TYPE {
                return Err(format!("Type at most {MAX_TYPE} characters at a time."));
            }
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            to_front(&conn, agent, &tab)?;
            let p = page(&conn, agent, &tab);
            if let Some(r) = args.get("ref").and_then(Value::as_str) {
                let node = ref_of(agent, tab.tab_id, r)?;
                if p.node_is_secret(node.backend_node_id) {
                    return Err(crate::agent_browser::tools::NO_PASSWORDS.into());
                }
                let (x, y) = p.center_of(node.backend_node_id)?;
                click(&p, x, y)?;
            }
            match p.focused_field() {
                Focus::Plain => {}
                Focus::Secret => return Err(crate::agent_browser::tools::NO_PASSWORDS.into()),
                Focus::Unknown => return Err(crate::agent_browser::tools::CANT_TELL.into()),
            }
            p.insert_text(t)?;
            Ok(vec![text("Typed.")])
        }
        "attach_image" => {
            let path = attachable(
                agent,
                args.get("path").and_then(Value::as_str).unwrap_or(""),
            )?;
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            to_front(&conn, agent, &tab)?;
            let p = page(&conn, agent, &tab);
            let node = match args.get("ref").and_then(Value::as_str) {
                Some(r) => Some(ref_of(agent, tab.tab_id, r)?.backend_node_id),
                None => None,
            };
            // First as a file, the way the site's own upload takes it
            // (LinkedIn ignores a pasted picture); then as a paste. An
            // extension from before this refuses the file route.
            let mut old_extension = false;
            if let Some(n) = node {
                let bytes =
                    std::fs::read(&path).map_err(|e| format!("Couldn't read the picture: {e}"))?;
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "picture.png".into());
                match p.attach_file(n, &bytes, &name, image_mime(&path), true) {
                    Ok(crate::agent_browser::page::Attached::Input)
                    | Ok(crate::agent_browser::page::Attached::Dropped) => {
                        p.settle(Duration::from_secs(3));
                        clear_refs(agent, tab.tab_id);
                        return Ok(vec![text(
                            "Attached as a file. Read the page or take a screenshot to check the picture shows before you post.",
                        )]);
                    }
                    Ok(crate::agent_browser::page::Attached::Nothing) => {}
                    Err(e) if e.starts_with("The extension refused") => old_extension = true,
                    Err(e) => return Err(e),
                }
                let (x, y) = p.center_of(n)?;
                click(&p, x, y)?;
            }
            let kept = crate::user_chrome::clipboard::put_image(&path)?;
            let pasted = p.paste();
            std::thread::sleep(Duration::from_millis(800));
            crate::user_chrome::clipboard::restore(kept);
            pasted?;
            p.settle(Duration::from_secs(3));
            clear_refs(agent, tab.tab_id);
            Ok(vec![text(if old_extension {
                "Pasted. Read the page or take a screenshot to check the picture shows before you post. If it doesn't, this site needs a newer Mogbot for Chrome (Chrome updates it from the Web Store)."
            } else if node.is_some() {
                "Pasted (nothing on the page took it as a file). Read the page or take a screenshot to check the picture shows before you post."
            } else {
                "Pasted. Read the page or take a screenshot to check the picture shows before you post. If it doesn't, try again with the ref of the site's upload button or drop area."
            })])
        }
        "press" => {
            let k = args.get("key").and_then(Value::as_str).unwrap_or("");
            let key = Key::parse(k).ok_or_else(|| format!("\"{k}\" isn't a key this browser presses. One of: Enter, Tab, Escape, Backspace, Delete, Space, the arrows, PageUp, PageDown, Home, End."))?;
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            to_front(&conn, agent, &tab)?;
            let p = page(&conn, agent, &tab);
            p.key(key)?;
            if key == Key::Enter {
                p.settle(Duration::from_secs(5));
                clear_refs(agent, tab.tab_id);
                let tab = refreshed(&conn, agent, &tab);
                note_where(agent, Some(&tab));
                return Ok(vec![text(format!("Pressed Enter. {}", where_line(&tab)))]);
            }
            Ok(vec![text(format!("Pressed {}.", key.name()))])
        }
        "scroll" => {
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            let p = page(&conn, agent, &tab);
            let amount = args
                .get("amount")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .clamp(1, 10);
            let direction = args.get("direction").and_then(Value::as_str).unwrap_or("");
            let step_js = scroll_step_js(direction).ok_or("Scroll up, down, left or right.")?;
            match args.get("ref").and_then(Value::as_str) {
                // Inside a control (a list, a pane): the box around it,
                // scrolled by a script on the node. Never the wheel: Chrome
                // answers a wheel only once the tab paints, and the agents'
                // tabs are often not painted (behind another tab, in an
                // unfocused or minimised window), so it waited the full 20 s
                // and held every later click behind it.
                Some(r) => {
                    let node = ref_of(agent, tab.tab_id, r)?.backend_node_id;
                    let step = 120.0 * amount as f64;
                    let (dx, dy) = match direction {
                        "up" => (0.0, -step),
                        "down" => (0.0, step),
                        "left" => (-step, 0.0),
                        _ => (step, 0.0),
                    };
                    match p.scroll_within(node, dx, dy)? {
                        Scrolled::Moved => {}
                        Scrolled::AtEnd => {
                            return Ok(vec![text(format!(
                                "It's already at the {} there: nothing moved.",
                                match direction {
                                    "up" => "top",
                                    "down" => "bottom",
                                    "left" => "left edge",
                                    _ => "right edge",
                                }
                            ))]);
                        }
                        Scrolled::Nothing => {
                            for _ in 0..amount {
                                p.eval(step_js)?;
                            }
                            clear_refs(agent, tab.tab_id);
                            return Ok(vec![text(
                                "Nothing around that control scrolls that way, so the page itself scrolled. Read the page again to see what's there now.",
                            )]);
                        }
                    }
                }
                // The page itself: scrolled directly, which works whether
                // or not Chrome is painting the window.
                None => {
                    for _ in 0..amount {
                        p.eval(step_js)?;
                    }
                }
            }
            clear_refs(agent, tab.tab_id);
            Ok(vec![text(
                "Scrolled. Read the page again to see what's there now.",
            )])
        }
        "wait_for" => {
            let tab = tab_for(agent, &conn, tab_arg(args))?;
            let p = page(&conn, agent, &tab);
            let secs = args
                .get("seconds")
                .and_then(Value::as_f64)
                .unwrap_or(10.0)
                .clamp(0.0, 30.0);
            let end = Instant::now() + Duration::from_secs_f64(secs);
            match args
                .get("text")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                Some(want) => loop {
                    if p.text(MAX_TEXT).contains(want) {
                        return Ok(vec![text(format!("\"{want}\" is on the page."))]);
                    }
                    if Instant::now() >= end {
                        return Ok(vec![text(format!(
                            "\"{want}\" didn't show in {secs:.0} s."
                        ))]);
                    }
                    std::thread::sleep(Duration::from_millis(400));
                },
                None => {
                    std::thread::sleep(Duration::from_secs_f64(secs));
                    Ok(vec![text("Waited.")])
                }
            }
        }
        "close_tab" => {
            let id = tab_arg(args).ok_or("Which tab?")?;
            let tab = tab_for(agent, &conn, Some(id))?;
            conn.call(
                Op::TabClose {
                    agent: agent.into(),
                    tab_id: tab.tab_id,
                },
                T,
            )
            .map_err(line_of)?;
            clear_refs(agent, tab.tab_id);
            with(|s| {
                if let Some(v) = s.tabs.get_mut(agent) {
                    v.retain(|t| t.tab_id != tab.tab_id);
                }
                // The next call without a tab goes to one still open.
                if s.active.get(agent) == Some(&tab.tab_id) {
                    s.active.remove(agent);
                }
            });
            note_where(agent, None);
            Ok(vec![text(format!("Closed tab {id}."))])
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

/* ------------------------------------------------- console and requests */

/// The first extension that records a tab's console and requests.
pub const LOGS_SINCE: &str = "0.1.3";

fn logs_need_update(have: &str) -> String {
    format!("The extension in this Chrome ({have}) can't read a tab's console or requests yet: that needs version {LOGS_SINCE} or later. Ask the user to update the app's Chrome extension; meanwhile read_page and get_text still work.")
}

/// One console line or request, as the extension keeps it (`logs.js`).
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct LogEntry {
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub failed: Option<String>,
}

/// The extension's answer to `tab_logs`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Logged {
    /// It attached to the tab just now: nothing before this was recorded.
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub entries: Vec<LogEntry>,
}

const NOTHING_YET: &str = "Nothing recorded yet: the extension starts recording a tab the first time you read or act on it, and it has now. Use navigate to load the page again, then read again.";

/// `read_console`'s answer: `[level] text (source)`, newest last.
pub fn console_text(got: &Logged, level: Option<&str>, limit: usize) -> String {
    let want = level.map(|l| match l.trim().to_lowercase().as_str() {
        "warning" => "warn".to_string(),
        other => other.to_string(),
    });
    let lines: Vec<String> = got
        .entries
        .iter()
        .filter(|e| want.as_deref().is_none_or(|w| w.is_empty() || e.level == w))
        .map(|e| {
            let text = e.text.replace('\n', " ");
            if e.source.is_empty() {
                format!("[{}] {text}", e.level)
            } else {
                format!("[{}] {text} ({})", e.level, e.source)
            }
        })
        .collect();
    finish(lines, limit, got.started, || match &want {
        Some(l) if !l.is_empty() => format!("No {l} messages in this tab's console."),
        _ => "This tab's console is empty.".into(),
    })
}

/// `read_network`'s answer: `METHOD status address`, newest last.
pub fn network_text(got: &Logged, failed_only: bool, limit: usize) -> String {
    let lines: Vec<String> = got
        .entries
        .iter()
        .filter(|e| !failed_only || e.failed.is_some() || e.status.is_some_and(|s| s >= 400))
        .map(|e| {
            let status = match (&e.failed, e.status) {
                (Some(why), _) => format!("failed ({why})"),
                (None, Some(s)) => s.to_string(),
                (None, None) => "pending".into(),
            };
            format!("{} {status} {}", e.method, e.url)
        })
        .collect();
    finish(lines, limit, got.started, || {
        if failed_only {
            "No failed requests in this tab.".into()
        } else {
            "This tab hasn't made any requests since recording started.".into()
        }
    })
}

fn finish(
    lines: Vec<String>,
    limit: usize,
    started: bool,
    none: impl FnOnce() -> String,
) -> String {
    if lines.is_empty() {
        return if started { NOTHING_YET.into() } else { none() };
    }
    let skip = lines.len().saturating_sub(limit.max(1));
    let mut out = String::new();
    if skip > 0 {
        out.push_str(&format!("({skip} older not shown)\n"));
    }
    out.push_str(&lines[skip..].join("\n"));
    out
}

/// An agent was deleted or its browser taken away: its tabs close.
pub fn close_agent(agent: &str) {
    for c in super::registry().conns() {
        let _ = c.call(
            Op::Release {
                agent: agent.into(),
            },
            T,
        );
    }
    with(|s| {
        s.tabs.remove(agent);
        s.active.remove(agent);
        s.chosen.remove(agent);
        s.refs.retain(|(a, _), _| a != agent);
    });
}

/* ------------------------------------------------------------- MCP */

fn initialize_result(params: Option<&Value>) -> Value {
    initialize_with(params, INSTRUCTIONS)
}

/// `initialize` for a project tab or a Terminal session (`sessions`).
pub fn session_initialize_result(params: Option<&Value>) -> Value {
    initialize_with(params, SESSION_INSTRUCTIONS)
}

fn initialize_with(params: Option<&Value>, instructions: &str) -> Value {
    let version = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .filter(|v| ["2024-11-05", "2025-03-26", "2025-06-18"].contains(v))
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_KEY, "version": env!("CARGO_PKG_VERSION") },
        "instructions": instructions,
    })
}

pub fn tools_list() -> Value {
    json!({
        "tools": TOOLS
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
            .collect::<Vec<_>>()
    })
}

/// One JSON-RPC message from `agent_id`'s turn (`turn`: `None` for a
/// take-over, which the user drives at the keyboard).
pub async fn handle_rpc(
    app: &AppHandle,
    agent_id: &str,
    turn: Option<u64>,
    message: &Value,
) -> Value {
    let agent = match crate::agents::store::get(agent_id) {
        Ok(a) => a,
        Err(_) => {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": "This agent no longer exists." } });
        }
    };
    dispatch(Some(app), &agent, turn, message).await
}

/// One JSON-RPC message from a project tab or a Terminal session
/// (`sessions`): the same tools, its own tabs, and a card in the Chief of
/// Staff's chat for anything that asks.
pub async fn handle_rpc_session(
    app: &AppHandle,
    session: &super::sessions::Session,
    message: &Value,
) -> Value {
    let agent = super::sessions::agent_of(session);
    dispatch_as(Some(app), &agent, Asker::Session, message).await
}

/// Who answers a call that asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asker {
    /// An agent's turn, on a card in its chat (`None`: a take-over, whose
    /// engine asks the user at the keyboard).
    Turn(Option<u64>),
    /// A project tab or a Terminal session: a card in the Chief's chat.
    Session,
}

/// [`handle_rpc`] for a known agent. `app`: where a call that asks puts its
/// card; with none (the end-to-end check) such a call is refused, never let
/// through.
pub async fn dispatch(
    app: Option<&AppHandle>,
    agent: &crate::agents::store::Agent,
    turn: Option<u64>,
    message: &Value,
) -> Value {
    dispatch_as(app, agent, Asker::Turn(turn), message).await
}

/// [`dispatch`], for either kind of caller.
pub async fn dispatch_as(
    app: Option<&AppHandle>,
    agent: &crate::agents::store::Agent,
    asker: Asker,
    message: &Value,
) -> Value {
    let agent_id = agent.id.as_str();
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params");
    // Descriptions, instructions and results name this build's computer
    // ("this PC" on Windows; `computer`). A tool call's `input` stays exact.
    let ok = |mut result: Value| {
        crate::computer::localize_json(&mut result, &["input"]);
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    };
    let fail = |code: i64, msg: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } });
    match method {
        "initialize" if asker == Asker::Session => ok(session_initialize_result(params)),
        "initialize" => ok(initialize_result(params)),
        "ping" => ok(json!({})),
        "tools/list" => ok(tools_list()),
        "tools/call" => {
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !TOOLS.iter().any(|t| t.name == name) {
                return fail(-32602, &format!("Unknown tool: {name}"));
            }
            let tool = format!("{USER_CHROME_SERVER}{name}");
            // A session is the user at the keyboard: never outside text.
            let outside = asker != Asker::Session && crate::agents::runner::from_outside(agent_id);
            // A click by position: judged by the control under it.
            let at = if name == "click" && args.get("ref").is_none() {
                let (a, g) = (agent_id.to_string(), args.clone());
                tokio::task::spawn_blocking(move || label_at(&a, &g))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let judged = gated_args(agent_id, &name, &args, at.as_deref());
            let gate = match asker {
                Asker::Session => browser_gate::gate_session(agent, &tool, &judged),
                Asker::Turn(_) => browser_gate::gate(agent, &tool, &judged, outside),
            };
            match gate {
                Gate::Allow | Gate::NotBrowser => {}
                Gate::Refuse(why) => return ok(result(vec![text(why)], true)),
                Gate::Ask if asker == Asker::Session => {
                    let Some(app) = app else {
                        return ok(result(
                            vec![text(
                                "This needs the user's OK, and nobody can be asked here.",
                            )],
                            true,
                        ));
                    };
                    if let Err(why) =
                        crate::agents::mcp::decide_for_session(app, agent, &tool, &judged).await
                    {
                        return ok(result(vec![text(why)], true));
                    }
                }
                Gate::Ask => {
                    let turn = match asker {
                        Asker::Turn(t) => t,
                        Asker::Session => None,
                    };
                    if !take_cleared(agent_id, &tool, &judged) && turn.is_some() {
                        let Some(app) = app else {
                            return ok(result(
                                vec![text(
                                    "This needs the user's OK, and nobody can be asked here.",
                                )],
                                true,
                            ));
                        };
                        if let Err(why) =
                            crate::agents::mcp::decide_agents_browser(app, agent_id, &tool, &judged)
                                .await
                        {
                            return ok(result(vec![text(why)], true));
                        }
                    }
                }
            }
            browser_gate::note_typed_user_chrome(agent_id, &name, &args);
            let (a, label) = (agent_id.to_string(), agent.name.clone());
            let done = tokio::task::spawn_blocking(move || run(&a, &label, &name, &args)).await;
            match done {
                Ok(Ok(content)) => ok(result(content, false)),
                Ok(Err(why)) => ok(result(vec![text(why)], true)),
                Err(_) => ok(result(vec![text("Chrome didn't answer.")], true)),
            }
        }
        _ => fail(-32601, &format!("Method not found: {method}")),
    }
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
