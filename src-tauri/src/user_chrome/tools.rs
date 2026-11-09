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
    let version = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .filter(|v| ["2024-11-05", "2025-03-26", "2025-06-18"].contains(v))
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_KEY, "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
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

/// [`handle_rpc`] for a known agent. `app`: where a call that asks puts its
/// card; with none (the end-to-end check) such a call is refused, never let
/// through.
pub async fn dispatch(
    app: Option<&AppHandle>,
    agent: &crate::agents::store::Agent,
    turn: Option<u64>,
    message: &Value,
) -> Value {
    let agent_id = agent.id.as_str();
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params");
    let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let fail = |code: i64, msg: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } });
    match method {
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
            let outside = crate::agents::runner::from_outside(agent_id);
            match browser_gate::gate(agent, &tool, &args, outside) {
                Gate::Allow | Gate::NotBrowser => {}
                Gate::Refuse(why) => return ok(result(vec![text(why)], true)),
                Gate::Ask => {
                    if !take_cleared(agent_id, &tool, &args) && turn.is_some() {
                        let Some(app) = app else {
                            return ok(result(
                                vec![text(
                                    "This needs the user's OK, and nobody can be asked here.",
                                )],
                                true,
                            ));
                        };
                        if let Err(why) =
                            crate::agents::mcp::decide_agents_browser(app, agent_id, &tool, &args)
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
