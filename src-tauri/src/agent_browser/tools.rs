//! The `browser` MCP server: the agents' browser's tools, for Claude Code and
//! Codex alike, answered on the agent bridge at `/mcp/browser`.
//!
//! **Who's calling** is the turn's bearer secret, as for `/mcp/agent`
//! (`agents::reach`): the server sees only that agent's own tabs.
//!
//! **What asks** is `agents::browser_gate`, the same rules as Claude in
//! Chrome (looking is free; acting is free unless it would send, post, pay,
//! delete or share; Enter outside a search box, uploads and anything unknown
//! ask). Labels come from the accessibility tree the server itself read, so
//! "is this the Send button" is answered from Chrome, not from a page's own
//! claims. An engine that asked first (`approve`, Codex's approval request)
//! leaves a one-time pass ([`note_cleared`]); one that didn't is asked here.
//!
//! **What never happens here**: no script tool (arbitrary JavaScript is the
//! widest way to carry data out), no uploads, no downloads, never typing
//! into a password or one-time-code field, never acting on a page the user
//! is signing in on (`signin`). Outside text never gets the browser.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::axtree::{self, RefTarget};
use super::keys::Key;
use super::service::{self, Owner, Service, Tab};
use crate::agents::browser_gate::{self, Gate, AGENTS_SERVER};

/// "Step in": the user takes the agent's tab for a step only a person can pass.
pub const STEP_IN_TOOL: &str = "ask_user_to_step_in";

/// The server's name in a turn's MCP config (tools are `mcp__browser__*`).
pub const SERVER_KEY: &str = "browser";
/// Its path on the agent bridge.
pub const PATH: &str = "/mcp/browser";

pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{PATH}")
}

/// What one `type` may carry.
const MAX_TYPE: usize = 4000;
const MAX_TEXT: usize = 20_000;

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: fn() -> Value,
}

fn tab_prop() -> Value {
    json!({ "type": "integer", "description": "Which of your tabs (from `tabs`). Default: the one you used last." })
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "tabs",
        description: "List your tabs in the agents' browser: number, title and address.",
        schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDef {
        name: "open",
        description: "Open a web page (http or https) in a new tab of the agents' browser, the team's own Chrome on this Mac: the browser to use first for any site. Returns where it landed.",
        schema: || json!({ "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] }),
    },
    ToolDef {
        name: "navigate",
        description: "Go to a web page in one of your tabs, or \"back\" / \"forward\".",
        schema: || json!({ "type": "object", "properties": { "url": { "type": "string" }, "tab": tab_prop() }, "required": ["url"] }),
    },
    ToolDef {
        name: "read_page",
        description: "Read the page as its accessibility tree: headings, text and every control with a ref (ref_N) that click and type take. `interactive: true` lists controls and headings only.",
        schema: || json!({ "type": "object", "properties": { "interactive": { "type": "boolean" }, "tab": tab_prop() } }),
    },
    ToolDef {
        name: "find",
        description: "Find controls or text on the page by words (\"search box\", \"Sign in\"). Returns the matching lines with their refs.",
        schema: || json!({ "type": "object", "properties": { "query": { "type": "string" }, "tab": tab_prop() }, "required": ["query"] }),
    },
    ToolDef {
        name: "get_text",
        description: "The page's visible text, as plain text.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop() } }),
    },
    ToolDef {
        name: "screenshot",
        description: "A picture of the visible page. Its pixels are the page's: click takes x, y on it.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop() } }),
    },
    ToolDef {
        name: "click",
        description: "Click a control by its ref from read_page or find (preferred), or at x, y on the screenshot. A click that would send, post, pay, delete or share asks the user first.",
        schema: || json!({ "type": "object", "properties": { "ref": { "type": "string" }, "x": { "type": "number" }, "y": { "type": "number" }, "tab": tab_prop() } }),
    },
    ToolDef {
        name: "type",
        description: "Type text into a field (by ref; it's clicked first) or wherever the cursor is. Never a password: password and one-time-code fields are refused.",
        schema: || json!({ "type": "object", "properties": { "text": { "type": "string" }, "ref": { "type": "string" }, "tab": tab_prop() }, "required": ["text"] }),
    },
    ToolDef {
        name: "press",
        description: "Press one key: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End. Enter outside a search box asks the user first.",
        schema: || json!({ "type": "object", "properties": { "key": { "type": "string" }, "tab": tab_prop() }, "required": ["key"] }),
    },
    ToolDef {
        name: "scroll",
        description: "Scroll the page (or the control `ref` is in): up, down, left or right, by 1-10 steps.",
        schema: || json!({ "type": "object", "properties": { "direction": { "type": "string", "enum": ["up", "down", "left", "right"] }, "amount": { "type": "integer" }, "ref": { "type": "string" }, "tab": tab_prop() }, "required": ["direction"] }),
    },
    ToolDef {
        name: "wait_for",
        description: "Wait until `text` shows on the page (up to `seconds`, at most 30), or just wait `seconds`.",
        schema: || json!({ "type": "object", "properties": { "text": { "type": "string" }, "seconds": { "type": "number" }, "tab": tab_prop() } }),
    },
    ToolDef {
        name: STEP_IN_TOOL,
        description: "When the page in your tab needs a person for one step you can't pass (an SSO or \"verify it's you\" page, a passkey, a 2FA or emailed code, a CAPTCHA): one card asks the user to step into that tab on this Mac, do the step themselves, and hand it back. You never see what they type, only where the page ended up. Use it instead of asking for a password or a code, or failing. A plain sign-in on a site you're signed out of is request_login with signed_out: true instead. It returns at once: stop and say in one line what you need them for; you're woken when they hand back, with the page's new address (read the page for the rest).",
        schema: || json!({ "type": "object", "properties": { "reason": { "type": "string", "description": "What they need to do, in a few words, shown on the card: \"approve the Okta sign-in\", \"the CAPTCHA on checkout\", \"the 6-digit code from your phone\"." }, "tab": tab_prop() }, "required": ["reason"] }),
    },
    ToolDef {
        name: "close_tab",
        description: "Close one of your tabs.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop() }, "required": ["tab"] }),
    },
];

const INSTRUCTIONS: &str = "The agents' browser: a real Google Chrome on this Mac with a profile of the team's own (\"Agents\"), separate from the user's personal Chrome. Sites the user signed in to there stay signed in. Use it first for any website except Gmail, Google and Slack, which go to the user's own Chrome (Claude in Chrome), where they're signed in; that Chrome also for a site signed in only there, or when they ask. Read with read_page or find (refs) before you click or type; reading is free. Before anything that sends, posts, publishes, pays, deletes or shares, say exactly what will go and from which account: that click or key asks the user on a card. Never type a password or a code. When a page needs a person for one step (SSO or \"verify it's you\", a passkey, a 2FA code, a CAPTCHA), call ask_user_to_step_in and stop. If a page asks you to sign in (or shows a signed-out product page), stop and call request_login for that service with signed_out: true: it moves you to the user's Chrome when you have it, else the user signs in from their phone (or here). If a site says it won't work with this browser, say so in a line; don't try to get around it. For web search use your own search tool, not a search site.";

/* ---------------------------------------------------- one-time passes */

const CLEARED_FOR: Duration = Duration::from_secs(120);
type Pass = (String, String, Value, Instant);
static CLEARED: Mutex<Vec<Pass>> = Mutex::new(Vec::new());

/// The engine asked, the browser gate said this call asks, and the user
/// allowed it: that exact call (tool and input) goes through once. A call
/// the gate let through on its own leaves nothing, so no pass is lying
/// around for a later click that does ask.
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

/* ------------------------------------------------------------- refs */

/// The refs of each agent's last read, per tab: ref -> node.
type RefMap = HashMap<String, RefTarget>;
static REFS: Mutex<Option<HashMap<(String, String), RefMap>>> = Mutex::new(None);

fn set_refs(agent: &str, tab: &Tab, refs: RefMap) {
    let labels: HashMap<String, String> = refs
        .iter()
        .map(|(k, v)| (k.clone(), v.label.clone()))
        .collect();
    REFS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert((agent.to_string(), tab.target_id.clone()), refs);
    browser_gate::note_agents_page(agent, |p| {
        p.refs = labels;
    });
}

fn ref_of(agent: &str, tab: &Tab, r: &str) -> Result<RefTarget, String> {
    REFS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(&(agent.to_string(), tab.target_id.clone())))
        .and_then(|m| m.get(r.trim()))
        .cloned()
        .ok_or_else(|| {
            format!("{r} isn't on this tab's last read. Read the page again (read_page or find).")
        })
}

fn clear_refs(agent: &str, tab: &Tab) {
    if let Some(m) = REFS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        m.remove(&(agent.to_string(), tab.target_id.clone()));
    }
}

/// Where each of the agent's tabs is, for the gate's "is this a checkout".
fn note_where(agent: &str, svc: &Service, active: Option<&Tab>) {
    let tabs = svc.tabs_of(&Owner::Agent(agent.to_string()));
    browser_gate::note_agents_page(agent, |p| {
        p.tabs = tabs.iter().map(|t| (t.id as u64, t.url.clone())).collect();
        if let Some(a) = active {
            p.url = Some(a.url.clone());
        }
    });
}

/* ------------------------------------------------------------- calls */

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

/// The tab a call names (or the one it used last), unless the user is in it
/// ([`super::step_in`]): then nothing on it is read or done.
fn tab_of(svc: &Service, agent: &str, args: &Value) -> Result<Tab, String> {
    let tab = svc.tab_for(agent, tab_arg(args))?;
    match super::step_in::refusal(agent, &tab) {
        Some(why) => Err(why.into()),
        None => Ok(tab),
    }
}

fn tab_arg(args: &Value) -> Option<u32> {
    args.get("tab")
        .and_then(Value::as_u64)
        .and_then(|t| u32::try_from(t).ok())
}

/// "Tab 2 · Example Domain · https://example.com/", and what the page means
/// for the agent (a sign-in page, a site refusing this browser).
fn where_line(svc: &Service, tab: &Tab) -> String {
    let t = svc.refreshed(tab);
    let mut line = format!(
        "Tab {} · {} · {}",
        t.id,
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
    let body = if t.url.starts_with("http") {
        svc.text(&t, 4000)
    } else {
        String::new()
    };
    if let Some(r) = super::refusal::refuses(&t.url, &t.title, &body) {
        line.push_str(&format!(
            "\n\n{} Tell the user in one line; don't try to get around it.",
            r.reason()
        ));
        if r.needs_plain_window() {
            line.push_str(" To sign in, call request_login for it with signed_out: true.");
        }
    } else if crate::agents::browser::signed_in("", &landed) == Some(false) {
        line.push_str("\n\nSigned out here (a sign-in or signed-out page). Don't type anything into it: if you have the Claude in Chrome tools (mcp__claude-in-chrome__*), open it there now, where the user is signed in, without asking; else call request_login for this service with signed_out: true, and the user signs in from their phone or here.");
    }
    line
}

/// Run one tool, blocking. `Err` is told to the agent as an error result.
pub fn run(agent: &str, name: &str, args: &Value) -> Result<Vec<Value>, String> {
    let svc = service::ensure()?;
    svc.touch();
    let owner = Owner::Agent(agent.to_string());
    match name {
        "tabs" => {
            let tabs = svc.tabs_of(&owner);
            if tabs.is_empty() {
                return Ok(vec![text("No tabs open. Use `open` with a URL.")]);
            }
            let lines: Vec<String> = tabs
                .iter()
                .map(|t| {
                    // A tab the user is in: named, never read.
                    if super::step_in::refusal(agent, t).is_some() {
                        return format!(
                            "{} · (the user is in this tab; wait for them to hand it back)",
                            t.id
                        );
                    }
                    let t = svc.refreshed(t);
                    format!("{} · {} · {}", t.id, t.title, t.url)
                })
                .collect();
            note_where(agent, &svc, None);
            Ok(vec![text(lines.join("\n"))])
        }
        "open" => {
            let url = web_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            if matches!(url.as_str(), "back" | "forward") {
                return Err("Open takes a web address.".into());
            }
            let tab = svc.open(owner, &url)?;
            let line = where_line(&svc, &tab);
            note_where(agent, &svc, Some(&svc.refreshed(&tab)));
            Ok(vec![text(line)])
        }
        "navigate" => {
            let url = web_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            let tab = tab_of(&svc, agent, args)?;
            svc.navigate(&tab, &url)?;
            clear_refs(agent, &tab);
            svc.set_active(agent, &tab);
            let line = where_line(&svc, &tab);
            note_where(agent, &svc, Some(&svc.refreshed(&tab)));
            Ok(vec![text(line)])
        }
        "read_page" | "find" => {
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            let interactive = name == "read_page"
                && args.get("interactive").and_then(Value::as_bool) == Some(true);
            let r = axtree::render(&svc.ax_nodes(&tab)?, interactive);
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
            set_refs(agent, &tab, r.refs);
            note_where(agent, &svc, Some(&svc.refreshed(&tab)));
            Ok(vec![text(out)])
        }
        "get_text" => {
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            Ok(vec![text(svc.text(&tab, MAX_TEXT))])
        }
        "screenshot" => {
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            let (jpeg, w, h) = svc.screenshot(&tab)?;
            use base64::Engine as _;
            Ok(vec![
                json!({ "type": "image", "mimeType": "image/jpeg", "data": base64::engine::general_purpose::STANDARD.encode(jpeg) }),
                text(format!("{w}×{h}: click takes x, y in these pixels.")),
            ])
        }
        "click" => {
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            let (x, y) = match args.get("ref").and_then(Value::as_str) {
                Some(r) => svc.center_of(&tab, ref_of(agent, &tab, r)?.backend_node_id)?,
                None => match (
                    args.get("x").and_then(Value::as_f64),
                    args.get("y").and_then(Value::as_f64),
                ) {
                    (Some(x), Some(y)) if x >= 0.0 && y >= 0.0 => (x, y),
                    _ => return Err("Click takes a ref, or x and y.".into()),
                },
            };
            svc.click(&tab, x, y)?;
            svc.settle(&tab, Duration::from_secs(5));
            clear_refs(agent, &tab);
            let line = where_line(&svc, &tab);
            note_where(agent, &svc, Some(&svc.refreshed(&tab)));
            Ok(vec![text(format!("Clicked. {line}"))])
        }
        "type" => {
            let t = args.get("text").and_then(Value::as_str).unwrap_or("");
            if t.is_empty() {
                return Err("Nothing to type.".into());
            }
            if t.chars().count() > MAX_TYPE {
                return Err(format!("Type at most {MAX_TYPE} characters at a time."));
            }
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            if let Some(r) = args.get("ref").and_then(Value::as_str) {
                let node = ref_of(agent, &tab, r)?;
                if svc.node_is_secret(&tab, node.backend_node_id) {
                    return Err(NO_PASSWORDS.into());
                }
                let (x, y) = svc.center_of(&tab, node.backend_node_id)?;
                svc.click(&tab, x, y)?;
            }
            match svc.focused_field(&tab) {
                service::Focus::Plain => {}
                service::Focus::Secret => return Err(NO_PASSWORDS.into()),
                service::Focus::Unknown => return Err(CANT_TELL.into()),
            }
            svc.insert_text(&tab, t)?;
            Ok(vec![text("Typed.")])
        }
        "press" => {
            let k = args.get("key").and_then(Value::as_str).unwrap_or("");
            let key = Key::parse(k).ok_or_else(|| format!("\"{k}\" isn't a key this browser presses. One of: Enter, Tab, Escape, Backspace, Delete, Space, the arrows, PageUp, PageDown, Home, End."))?;
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            svc.key(&tab, key)?;
            if key == Key::Enter {
                svc.settle(&tab, Duration::from_secs(5));
                clear_refs(agent, &tab);
                let line = where_line(&svc, &tab);
                note_where(agent, &svc, Some(&svc.refreshed(&tab)));
                return Ok(vec![text(format!("Pressed Enter. {line}"))]);
            }
            Ok(vec![text(format!("Pressed {}.", key.name()))])
        }
        "scroll" => {
            let tab = tab_of(&svc, agent, args)?;
            svc.set_active(agent, &tab);
            let amount = args
                .get("amount")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .clamp(1, 10) as f64;
            let step = 120.0 * amount;
            let (dx, dy) = match args.get("direction").and_then(Value::as_str) {
                Some("up") => (0.0, -step),
                Some("down") => (0.0, step),
                Some("left") => (-step, 0.0),
                Some("right") => (step, 0.0),
                _ => return Err("Scroll up, down, left or right.".into()),
            };
            let (x, y) = match args.get("ref").and_then(Value::as_str) {
                Some(r) => svc.center_of(&tab, ref_of(agent, &tab, r)?.backend_node_id)?,
                None => {
                    let (w, h) = svc.viewport(&tab);
                    (w / 2.0, h / 2.0)
                }
            };
            svc.wheel(&tab, x, y, dx, dy)?;
            std::thread::sleep(Duration::from_millis(250));
            clear_refs(agent, &tab);
            Ok(vec![text(
                "Scrolled. Read the page again to see what's there now.",
            )])
        }
        "wait_for" => {
            let tab = tab_of(&svc, agent, args)?;
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
                    // The user stepped in while it waited: stop reading.
                    if let Some(why) = super::step_in::refusal(agent, &tab) {
                        return Err(why.into());
                    }
                    if svc.text(&tab, MAX_TEXT).contains(want) {
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
            let tab = tab_of(&svc, agent, args)?;
            clear_refs(agent, &tab);
            svc.close_tab(&tab);
            note_where(agent, &svc, None);
            Ok(vec![text(format!("Closed tab {id}."))])
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

/// The focused field couldn't be checked (another site's frame, or the page
/// didn't answer): typed into only when it's known not to be a password.
pub const CANT_TELL: &str = "Couldn't tell whether the focused field takes a password (it may be inside another site's frame), so nothing was typed. Click the field by its ref from read_page and try again; if it's a sign-in, call request_login for it with signed_out: true.";
pub const NO_PASSWORDS: &str ="That's a password or code field: agents never type those. If the site needs signing in, call request_login for it with signed_out: true, and the user signs in themselves (from their phone, or here).";

/// An agent was deleted, or its browser taken away: its windows close.
pub fn close_agent(agent: &str) {
    super::step_in::forget(agent);
    if let Some(svc) = service::running() {
        svc.close_all_of(&Owner::Agent(agent.to_string()));
    }
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
/// card; with none (the live check, `examples/agent_browser_turn`) such a
/// call is refused, never let through.
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
    // Descriptions, instructions and results name this build's computer
    // ("this PC" on Windows; `computer`). A tool call's `input` stays exact.
    let ok = |mut result: Value| {
        crate::computer::localize_json(&mut result, &["input"]);
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    };
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
            let tool = format!("{AGENTS_SERVER}{name}");
            let outside = crate::agents::runner::from_outside(agent_id);
            match browser_gate::gate(agent, &tool, &args, outside) {
                Gate::Allow | Gate::NotBrowser => {}
                Gate::Refuse(why) => return ok(result(vec![text(why)], true)),
                Gate::Ask => {
                    // Asked already (the engine's own approval), or the user
                    // is at the keyboard (a take-over): through. Else a card.
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
            // "Step in": a card, not a browser action. Never in a take-over
            // (the user is at the keyboard already) or with nobody to ask.
            if name == STEP_IN_TOOL {
                let (Some(app), Some(_)) = (app, turn) else {
                    return ok(result(
                        vec![text("Nobody can be asked to step in here.")],
                        true,
                    ));
                };
                return match crate::agents::step_in::ask(app, agent, &args, outside).await {
                    Ok(said) => ok(result(vec![text(said)], false)),
                    Err(why) => ok(result(vec![text(why)], true)),
                };
            }
            // What it types, for a later send card's exact words.
            browser_gate::note_typed_agents(agent_id, &name, &args);
            let a = agent_id.to_string();
            let done = tokio::task::spawn_blocking(move || run(&a, &name, &args)).await;
            match done {
                Ok(Ok(content)) => ok(result(content, false)),
                Ok(Err(why)) => ok(result(vec![text(why)], true)),
                Err(_) => ok(result(vec![text("The browser didn't answer.")], true)),
            }
        }
        _ => fail(-32601, &format!("Method not found: {method}")),
    }
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
