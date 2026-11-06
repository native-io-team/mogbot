//! What a Claude in Chrome call may do without a card, and the card's words
//! when it may not.
//!
//! **Looking is free** at "Use good judgement" and "Go hard": tabs, browsers,
//! going to any web page (`http`/`https` only), reading it, screenshots,
//! scrolling, the console and network. At "Check with me often" only the
//! agent's own sites (`browser_sites`) are free to open, as before.
//!
//! **Acting is free unless it sends.** A click, keystroke or form fill goes
//! through at "Use good judgement" and "Go hard", except when it would send,
//! post, publish, pay, delete or share: the target's accessible name (from
//! what `read_page` / `find` answered, kept per agent in [`Page`]) names one
//! of [`SENDS`], Enter is pressed anywhere but a search box, or the page is a
//! checkout, payment or compose page. When it can't be told, it asks. At
//! "Check with me often" every interaction asks.
//!
//! **Always a card** below "Go hard": `javascript_tool`, `file_upload`,
//! `upload_image`, `shortcuts_execute` (each can carry data anywhere), and
//! anything this build doesn't know. **At "Go hard"** everything runs,
//! scripts and shortcuts included, except uploads, send-like clicks and
//! keys, and a script that submits or posts (`go_hard::script_sends`).
//!
//! Turns answering outside text never get the browser at all
//! (`browser::allowed`). Threat model: docs/agents.md, "Your browser".

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

use super::browser::{allowed, team_enabled};
use super::independence::Level;
use super::store::Agent;

/// What [`gate`] does with a Claude in Chrome call.
#[derive(Debug, PartialEq)]
pub enum Gate {
    /// Not a browser tool: the usual rules apply.
    NotBrowser,
    /// Goes through without a card.
    Allow,
    /// Asks on a card.
    Ask,
    /// It may not use the browser this turn.
    Refuse(String),
}

pub const SERVER: &str = "mcp__claude-in-chrome__";

/// Every browser call while the user signs in from their phone.
pub const PHONE_SIGNIN_REFUSAL: &str = "The user is signing in to a site in this Mac's Chrome from their phone right now. Don't use the browser until they're done: carry on with what doesn't need it, or wait a few minutes and try again.";

/// Tools that only look: they change nothing on a page or a site.
const LOOKS: &[&str] = &[
    "tabs_context_mcp",
    "tabs_close_mcp",
    "get_page_text",
    "read_page",
    "find",
    "read_console_messages",
    "read_network_requests",
    "list_connected_browsers",
    "select_browser",
    "switch_browser",
    "resize_window",
    "shortcuts_list",
];

/// Always a card: each can run anything or carry data anywhere.
const ALWAYS_ASK: &[&str] = &[
    "javascript_tool",
    "file_upload",
    "upload_image",
    "shortcuts_execute",
];

/// `computer` actions that only look.
const COMPUTER_LOOKS: &[&str] = &[
    "screenshot",
    "scroll",
    "zoom",
    "hover",
    "wait",
    "scroll_to",
    "mouse_move",
];

/// `computer` actions that click.
const CLICKS: &[&str] = &[
    "left_click",
    "right_click",
    "double_click",
    "triple_click",
    "middle_click",
    "left_click_drag",
    "left_mouse_down",
    "left_mouse_up",
];

/// Words on a control that mean it sends, posts, publishes, pays, deletes or
/// shares, and what that is in plain words.
pub const SENDS: &[(&str, &str)] = &[
    ("send", "send it as you"),
    ("reply", "send it as you"),
    ("forward", "send it as you"),
    ("post", "post it as you"),
    ("repost", "post it as you"),
    ("tweet", "post it as you"),
    ("comment", "post it as you"),
    ("publish", "publish it as you"),
    ("share", "share it as you"),
    ("invite", "invite someone as you"),
    ("submit", "submit it as you"),
    ("confirm", "confirm it as you"),
    ("approve", "approve it as you"),
    ("pay", "spend your money"),
    ("buy", "spend your money"),
    ("purchase", "spend your money"),
    ("checkout", "spend your money"),
    ("order", "spend your money"),
    ("subscribe", "spend your money"),
    ("upgrade", "spend your money"),
    ("donate", "spend your money"),
    ("transfer", "move your money"),
    ("withdraw", "move your money"),
    ("book", "book it as you"),
    ("schedule", "schedule it to go out as you"),
    ("delete", "delete something"),
    ("remove", "delete something"),
    ("discard", "delete something"),
    ("trash", "delete something"),
    ("merge", "change what others see"),
    ("deploy", "change what others see"),
    ("promote", "change what others see"),
    ("rollback", "change what others see"),
];

/// Two-word controls that count as one ("Check out", "Place order").
const SENDS_PHRASES: &[(&str, &str)] = &[
    ("check out", "spend your money"),
    ("place order", "spend your money"),
    ("roll back", "change what others see"),
];

/// Hosts where any click may pay.
const PAY_HOSTS: &[&str] = &[
    "paypal.com",
    "checkout.stripe.com",
    "buy.stripe.com",
    "pay.google.com",
    "venmo.com",
    "wise.com",
    "coinbase.com",
    "cash.app",
];

/// Words in a page's path or fragment that make a click there unsure.
const SENSITIVE_PAGES: &[&str] = &[
    "compose",
    "send",
    "checkout",
    "payment",
    "payments",
    "pay",
    "cart",
    "basket",
    "billing",
    "transfer",
    "purchase",
    "donate",
    "subscribe",
    "upgrade",
];

/// [`SENSITIVE_PAGES`] that spend money: still unsure at "Full send".
const MONEY_PAGES: &[&str] = &[
    "checkout",
    "payment",
    "payments",
    "pay",
    "cart",
    "basket",
    "billing",
    "transfer",
    "purchase",
    "donate",
    "subscribe",
    "upgrade",
];

/// [`SENDS`] that spend or move money: they ask at every level.
const MONEY_WORDS: &[&str] = &[
    "pay",
    "buy",
    "purchase",
    "checkout",
    "order",
    "subscribe",
    "upgrade",
    "donate",
    "transfer",
    "withdraw",
];

/// The first word of a label that describes rather than acts ("Will send
/// on Fri", "Edit post", "New post"): not the final step at "Go hard".
const NOT_ACTIONS: &[&str] = &[
    "will",
    "scheduled",
    "sent",
    "posted",
    "published",
    "edit",
    "view",
    "open",
    "show",
    "see",
    "draft",
    "drafts",
    "unsent",
    "close",
    "back",
    "more",
    "new",
    "preview",
    "cancel",
    "undo",
    "your",
    "my",
    "all",
    "copy",
    "save",
];

/// [`SENDS`] that, at "Go hard", are steps on the way rather than the final
/// send: throwing away an unsaved edit is the editor's business.
const INTERMEDIATE: &[&str] = &["discard"];

/// Labels of boxes where Enter only searches.
const SEARCH_BOXES: &[&str] = &[
    "search",
    "find",
    "filter",
    "query",
    "address",
    "url",
    "go",
    "jump",
    "searchbox",
    "combobox",
];

/* ------------------------------------------------------- page memory */

/// What the agent's browser showed, from its own calls' answers: which
/// control each `ref` is, the page each tab is on, and what it last acted on.
#[derive(Debug, Clone, Default)]
pub struct Page {
    /// `ref_12` → `button "Send"`.
    pub refs: HashMap<String, String>,
    pub tabs: HashMap<u64, String>,
    /// The page it last went to, when a call doesn't name its tab.
    pub url: Option<String>,
    /// The control it last clicked or filled (for Enter).
    pub last_target: Option<String>,
}

const MAX_REFS: usize = 4000;

static PAGES: Mutex<Option<HashMap<String, Page>>> = Mutex::new(None);

fn with_pages<T>(f: impl FnOnce(&mut HashMap<String, Page>) -> T) -> T {
    let mut guard = PAGES.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// The agent's page memory as it is now.
pub fn page_of(agent_id: &str) -> Page {
    with_pages(|p| p.get(agent_id).cloned().unwrap_or_default())
}

pub fn forget(agent_id: &str) {
    with_pages(|p| p.remove(agent_id));
}

fn tab_of(input: &Value) -> Option<u64> {
    input.get("tabId").and_then(Value::as_u64)
}

/// One line of Claude Code's stream-json: the browser calls it makes, and
/// what `read_page`, `find` and `tabs_context_mcp` answered.
pub fn observe(agent_id: &str, value: &Value) {
    let blocks = value.pointer("/message/content").and_then(Value::as_array);
    let Some(blocks) = blocks else { return };
    with_pages(|pages| {
        let page = pages.entry(agent_id.to_string()).or_default();
        for b in blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let Some(name) = b
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(|n| n.strip_prefix(SERVER))
                    else {
                        continue;
                    };
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    on_call(page, name, &input);
                }
                Some("tool_result") => {
                    let text = result_text(b.get("content"));
                    on_answer(page, &text);
                }
                _ => {}
            }
        }
    });
}

fn on_call(page: &mut Page, name: &str, input: &Value) {
    match name {
        "navigate" | "tabs_create_mcp" => {
            if let Some(url) = input.get("url").and_then(Value::as_str) {
                if host_of(url).is_some() {
                    page.url = Some(url.trim().to_string());
                    if let Some(t) = tab_of(input) {
                        page.tabs.insert(t, url.trim().to_string());
                    }
                    page.refs.clear();
                    page.last_target = None;
                }
            }
        }
        "form_input" => page.last_target = target_of(page, input),
        "computer" => {
            let action = input.get("action").and_then(Value::as_str).unwrap_or("");
            if CLICKS.contains(&action) {
                page.last_target = target_of(page, input);
            }
        }
        _ => {}
    }
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Lines naming a `ref_N` become that ref's label; a tabs answer, the tabs.
fn on_answer(page: &mut Page, text: &str) {
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        let tabs = v
            .get("availableTabs")
            .or_else(|| v.get("tabs"))
            .and_then(Value::as_array);
        for t in tabs.into_iter().flatten() {
            let id = t
                .get("tabId")
                .or_else(|| t.get("id"))
                .and_then(Value::as_u64);
            if let (Some(id), Some(url)) = (id, t.get("url").and_then(Value::as_str)) {
                page.tabs.insert(id, url.to_string());
            }
        }
    }
    for line in text.lines() {
        let Some(at) = line.find("ref_") else {
            continue;
        };
        let digits: String = line[at + 4..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if digits.is_empty() || page.refs.len() >= MAX_REFS {
            continue;
        }
        let r = format!("ref_{digits}");
        let label = line
            .replace(&format!("[{r}]"), "")
            .replace(&r, "")
            .trim_matches(|c: char| c.is_whitespace() || "-:*[]()".contains(c))
            .to_string();
        if !label.is_empty() {
            page.refs.insert(r, label);
        }
    }
}

/* ---------------------------------------------------------- deciding */

fn host_matches(host: &str, site: &str) -> bool {
    let h = host.trim_start_matches("www.").to_ascii_lowercase();
    let s = site.trim_start_matches("www.").to_ascii_lowercase();
    !s.is_empty() && (h == s || h.ends_with(&format!(".{s}")))
}

/// The host of a web URL (`http`/`https` only).
pub fn host_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url.trim()).ok()?;
    matches!(u.scheme(), "https" | "http")
        .then(|| u.host_str().map(str::to_string))
        .flatten()
}

/// "Check with me often": a web URL on one of `sites`, carrying no other URL
/// in its query or fragment (an own site's redirect endpoint would otherwise
/// carry page data to a host nobody named).
fn own_site(url: &str, sites: &[String]) -> bool {
    let Ok(u) = url::Url::parse(url.trim()) else {
        return false;
    };
    let Some(host) = host_of(url) else {
        return false;
    };
    if !sites.iter().any(|s| host_matches(&host, s)) {
        return false;
    }
    let rest = format!(
        "{}?{}#{}",
        u.path().get(1..).unwrap_or(""),
        u.query().unwrap_or(""),
        u.fragment().unwrap_or("")
    )
    .to_ascii_lowercase()
    .replace("%25", "%")
    .replace("%2f", "/")
    .replace("%5c", "/")
    .replace('\\', "/");
    !rest.contains("//")
}

/// Whether going to `url` needs a card at `level`.
/// An address that would carry a secret off this Mac (`egress`).
fn leaks(url: &str) -> bool {
    super::egress::carries_secret(url, &super::egress::known())
}

fn may_open(level: Level, url: &str, agent: &Agent) -> bool {
    if matches!(url.trim(), "back" | "forward") {
        return true;
    }
    match level {
        Level::Often => own_site(url, &agent.reach.browser_sites),
        Level::Judgement | Level::GoHard | Level::FullSend => host_of(url).is_some(),
    }
}

fn words(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The quoted name in `button "Send now"`, else the whole label.
pub fn name_in(label: &str) -> String {
    let quoted = label
        .split_once('"')
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(name, _)| name.trim().to_string());
    quoted
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| label.trim().to_string())
}

/// What a control would do as the user, when its label says it sends, pays,
/// deletes or shares.
pub fn sends(label: &str) -> Option<&'static str> {
    let name = name_in(label).to_ascii_lowercase();
    let joined = words(&name).join(" ");
    if let Some((_, what)) = SENDS_PHRASES.iter().find(|(p, _)| joined.contains(p)) {
        return Some(what);
    }
    let ws = words(&name);
    SENDS
        .iter()
        .find(|(w, _)| ws.iter().any(|x| x == w))
        .map(|(_, what)| *what)
}

/// The final step of a send at "Go hard" or above, when a control's label
/// says it is one, and what it would do. At "Go hard": a control whose name
/// starts with a send word ("Post", "Send now", "Schedule post", "Delete
/// post"), or a short one (three words or fewer) that holds one and doesn't
/// start by describing ("Will send on Fri", "Edit post"); text boxes and
/// "Discard" are steps on the way. At "Full send": only the floor, spending
/// money and closing an account.
pub fn final_submit(label: &str, level: Level) -> Option<&'static str> {
    if level == Level::FullSend {
        return floor_control(label);
    }
    if is_field(label) {
        return None;
    }
    let name = name_in(label).to_ascii_lowercase();
    let ws = words(&name);
    let joined = ws.join(" ");
    if let Some((_, what)) = SENDS_PHRASES.iter().find(|(p, _)| joined.contains(p)) {
        return Some(what);
    }
    let send = |w: &str| {
        SENDS
            .iter()
            .find(|(s, _)| *s == w && !INTERMEDIATE.contains(s))
            .map(|(_, what)| *what)
    };
    let first = ws.first()?;
    if let Some(what) = send(first) {
        return Some(what);
    }
    if ws.len() <= 3 && !NOT_ACTIONS.contains(&first.as_str()) {
        return ws.iter().find_map(|w| send(w));
    }
    None
}

/// What a delete or close button can take with it for good.
const ACCOUNT_THINGS: &[&str] = &[
    "account",
    "repository",
    "repo",
    "project",
    "workspace",
    "organization",
    "organisation",
    "team",
    "database",
    "site",
    "domain",
    "server",
    "bucket",
    "app",
    "store",
    "channel",
    "profile",
];

/// A control that spends money or deletes something that doesn't come back
/// (an account, a repository, a project): it asks at every level, "Full
/// send" included.
pub fn floor_control(label: &str) -> Option<&'static str> {
    let name = name_in(label).to_ascii_lowercase();
    let ws = words(&name);
    let joined = ws.join(" ");
    if joined.contains("check out") || joined.contains("place order") {
        return Some("spend your money");
    }
    if ws.iter().any(|w| MONEY_WORDS.contains(&w.as_str())) && !is_field(label) {
        return Some("spend your money");
    }
    // Things that don't come back: the account, a repository, a project.
    let account = ws.iter().any(|w| ACCOUNT_THINGS.contains(&w.as_str()));
    let ends = ws.iter().any(|w| {
        matches!(
            w.as_str(),
            "delete" | "close" | "deactivate" | "terminate" | "erase" | "remove" | "destroy"
        )
    });
    (account && ends && !is_field(label)).then_some("delete something for good")
}

/// A box for a password or a card's security code: typing there is the
/// user's credentials, so it asks at "Go hard" and "Full send".
pub fn password_field(label: &str) -> bool {
    let ws = words(label);
    ws.iter().any(|w| {
        matches!(
            w.as_str(),
            "password" | "passcode" | "passphrase" | "cvv" | "cvc" | "pin"
        )
    }) || ws
        .windows(2)
        .any(|w| w == ["security", "code"] || w == ["card", "number"])
}

/// The page a call acts on.
/// The page a browser call of `agent_id` acts on, when known.
pub fn url_of(agent_id: &str, input: &Value) -> Option<String> {
    url_for(&page_of(agent_id), input)
}

fn url_for(page: &Page, input: &Value) -> Option<String> {
    tab_of(input)
        .and_then(|t| page.tabs.get(&t).cloned())
        .or_else(|| page.url.clone())
}

/// A checkout, payment or compose page: a click there can't be told safe.
fn sensitive_page(url: Option<&str>) -> bool {
    let Some(url) = url else { return false };
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let host = u.host_str().unwrap_or("");
    if PAY_HOSTS.iter().any(|h| host_matches(host, h)) {
        return true;
    }
    let tail = format!(
        "{} {} {}",
        u.path(),
        u.query().unwrap_or(""),
        u.fragment().unwrap_or("")
    );
    words(&tail)
        .iter()
        .any(|w| SENSITIVE_PAGES.contains(&w.as_str()))
}

/// A page where a click may spend money: still unsure at "Full send".
fn money_page(url: Option<&str>) -> bool {
    let Some(url) = url else { return false };
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let host = u.host_str().unwrap_or("");
    if PAY_HOSTS.iter().any(|h| host_matches(host, h)) {
        return true;
    }
    let tail = format!(
        "{} {} {}",
        u.path(),
        u.query().unwrap_or(""),
        u.fragment().unwrap_or("")
    );
    words(&tail)
        .iter()
        .any(|w| MONEY_PAGES.contains(&w.as_str()))
}

/// The control a call names by `ref`, as `read_page` / `find` labelled it.
fn target_of(page: &Page, input: &Value) -> Option<String> {
    let r = input.get("ref").and_then(Value::as_str)?;
    page.refs.get(r.trim()).cloned()
}

fn is_enter(key: &str) -> bool {
    key.split(['+', ' ']).any(|k| {
        matches!(
            k.trim().to_ascii_lowercase().as_str(),
            "enter" | "return" | "kp_enter"
        )
    })
}

fn search_box(label: &str) -> bool {
    words(label)
        .iter()
        .any(|w| SEARCH_BOXES.contains(&w.as_str()))
}

/// An interaction at "Use good judgement" or above: through, unless it
/// would send (or it can't be told). At "Go hard" only the final step of a
/// send asks ([`final_submit`]): opening, focusing, typing, discarding and
/// closing inside an editor run. At "Full send" only the floor asks:
/// spending money, closing the account, a password.
fn interaction_may_go(level: Level, page: &Page, name: &str, input: &Value) -> bool {
    let url = url_for(page, input);
    let url = url.as_deref();
    let hard = level.goes_hard();
    let full = level == Level::FullSend;
    // Where an unknown target can't be told safe. At Go hard and above a
    // click is judged by what it clicks (label and role), never by the
    // page's address: a scheduled-posts list lives under ".../compose/...",
    // and asking for every unlabelled click there was the owner's report.
    // Only a page that spends money stays unsure.
    let unsure = |url: Option<&str>| {
        if hard {
            money_page(url)
        } else {
            sensitive_page(url)
        }
    };
    let ok_target = |label: &str| {
        if hard {
            final_submit(label, level).is_none() && !money_page(url)
        } else {
            sends(label).is_none() && !sensitive_page(url)
        }
    };
    match name {
        "form_input" => match target_of(page, input) {
            Some(label) if hard && password_field(&label) => false,
            // Filling in a field doesn't send; pressing its button does.
            Some(label) if hard => final_submit(&label, level).is_none() || is_field(&label),
            Some(label) => sends(&label).is_none() || is_field(&label),
            None => !unsure(url),
        },
        "computer" => {
            let action = input.get("action").and_then(Value::as_str).unwrap_or("");
            if CLICKS.contains(&action) {
                return match target_of(page, input) {
                    Some(label) => ok_target(&label),
                    None => !unsure(url),
                };
            }
            let in_password = || hard && page.last_target.as_deref().is_some_and(password_field);
            match action {
                "type" => !in_password(),
                "key" => {
                    let key = input
                        .get("text")
                        .or_else(|| input.get("key"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if full {
                        return !(is_enter(key) && (money_page(url) || in_password()));
                    }
                    !is_enter(key)
                        || page
                            .last_target
                            .as_deref()
                            .is_some_and(|t| search_box(t) && !sensitive_page(url))
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// An upload at "Full send": asks only when what it would upload looks like
/// a key or a credential store.
fn uploads_secret(input: &Value) -> bool {
    fn strings(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Object(o) => o.values().for_each(|x| strings(x, out)),
            _ => {}
        }
    }
    let mut all = Vec::new();
    strings(input, &mut all);
    all.iter().any(|s| {
        s.contains("/.ssh/")
            || s.contains("Keychains")
            || s.contains("/.gnupg/")
            || (s.contains('/') && super::autoallow::sensitive_name(std::path::Path::new(s)))
    })
}

/// A text box or option, not a button: `textbox "Message"`, `combobox …`.
fn is_field(label: &str) -> bool {
    let lower = label.trim_start().to_ascii_lowercase();
    [
        "textbox",
        "searchbox",
        "combobox",
        "checkbox",
        "radio",
        "option",
        "listbox",
        "spinbutton",
        "slider",
        "textarea",
        "input",
    ]
    .iter()
    .any(|r| lower.starts_with(r))
}

/// The steps of a `browser_batch`, as (tool, input). `None` when its shape
/// can't be read (it asks).
fn batch_steps(input: &Value) -> Option<Vec<(String, Value)>> {
    let list = ["actions", "steps", "calls", "batch", "commands"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_array))?;
    list.iter()
        .map(|s| {
            let name = s
                .get("tool")
                .or_else(|| s.get("name"))
                .and_then(Value::as_str)?;
            let args = s
                .get("input")
                .or_else(|| s.get("args"))
                .or_else(|| s.get("arguments"))
                .or_else(|| s.get("params"))
                .cloned()
                .unwrap_or_else(|| s.clone());
            Some((name.trim_start_matches(SERVER).to_string(), args))
        })
        .collect()
}

/// One browser tool (its name without the server) at `level`.
fn decide(level: Level, agent: &Agent, name: &str, input: &Value, page: &Page) -> Gate {
    let free = |ok: bool| if ok { Gate::Allow } else { Gate::Ask };
    // "Go hard": everything runs, scripts and shortcuts included, except
    // uploads and what sends (a script that submits or posts, a send click).
    if level.goes_hard() {
        match name {
            "file_upload" | "upload_image" => {
                return free(level == Level::FullSend && !uploads_secret(input))
            }
            "javascript_tool" => {
                let url = url_for(page, input);
                let asks = super::go_hard::script_sends(input, level)
                    || level == Level::FullSend && money_page(url.as_deref());
                return free(!asks);
            }
            "shortcuts_execute" => return Gate::Allow,
            _ => {}
        }
    }
    if ALWAYS_ASK.contains(&name) {
        return Gate::Ask;
    }
    match name {
        "navigate" => {
            let url = input.get("url").and_then(Value::as_str).unwrap_or("");
            free(may_open(level, url, agent) && !leaks(url))
        }
        "tabs_create_mcp" => match input.get("url").and_then(Value::as_str) {
            Some(url) if !url.trim().is_empty() => free(may_open(level, url, agent) && !leaks(url)),
            _ => Gate::Allow,
        },
        // Recording is a look; exporting can drop the file onto a page.
        "gif_creator" => {
            let action = input.get("action").and_then(Value::as_str).unwrap_or("");
            free(matches!(
                action,
                "start_recording" | "stop_recording" | "clear"
            ))
        }
        "computer" => {
            let action = input.get("action").and_then(Value::as_str).unwrap_or("");
            if COMPUTER_LOOKS.contains(&action) {
                Gate::Allow
            } else if level == Level::Often {
                Gate::Ask
            } else {
                free(interaction_may_go(level, page, name, input))
            }
        }
        "form_input" => {
            if level == Level::Often {
                Gate::Ask
            } else {
                free(interaction_may_go(level, page, name, input))
            }
        }
        "browser_batch" => match batch_steps(input) {
            Some(steps) if !steps.is_empty() => {
                // Steps after a navigation in the batch land on a page whose
                // controls weren't read: judged as unknown targets there.
                let mut page = page.clone();
                for (n, i) in &steps {
                    if n == "browser_batch" || decide(level, agent, n, i, &page) != Gate::Allow {
                        return Gate::Ask;
                    }
                    on_call(&mut page, n, i);
                }
                Gate::Allow
            }
            _ => Gate::Ask,
        },
        n if LOOKS.contains(&n) => Gate::Allow,
        _ => free(level.goes_hard()),
    }
}

/// Decide a browser tool call from `agent` before any card. `enabled`: the
/// team's switch; `level`: the turn's independence level.
pub fn gate_with(
    enabled: bool,
    level: Level,
    agent: &Agent,
    tool: &str,
    input: &Value,
    outside: bool,
    page: &Page,
) -> Gate {
    let Some(name) = tool.strip_prefix(SERVER) else {
        return Gate::NotBrowser;
    };
    if !allowed(enabled, agent, outside) {
        return Gate::Refuse(if outside {
            "Your browser isn't available while you answer text from outside (a routine's items, or a message that carried them). Do this from the user's own request.".into()
        } else {
            "The user's browser isn't on for you. If the task needs a signed-in site, ask with request_login for it.".into()
        });
    }
    decide(level, agent, name, input, page)
}

/// Every browser call is refused while a phone sign-in is live, at every
/// level and for every agent: the tab is the user's, and so is the page.
pub fn while_phone_signs_in(live: bool) -> Option<Gate> {
    live.then(|| Gate::Refuse(PHONE_SIGNIN_REFUSAL.into()))
}

pub fn gate(agent: &Agent, tool: &str, input: &Value, outside: bool) -> Gate {
    if let Some(name) = tool.strip_prefix(AGENTS_SERVER) {
        // A sign-in in the agents' browser for this agent is under way (or
        // its profile is open in a plain window): it waits.
        if let Some(why) = crate::agent_browser::signin::refusal_for(&agent.id) {
            return Gate::Refuse(why);
        }
        let level = super::independence::for_turn(super::policy::chosen_level(agent), outside);
        return gate_agents_with(
            crate::agent_browser::settings::enabled(),
            level,
            agent,
            name,
            input,
            outside,
            &page_of(&agents_key(&agent.id)),
        );
    }
    if !tool.starts_with(SERVER) {
        return Gate::NotBrowser;
    }
    // The user's phone is driving a sign-in in this Chrome: no agent sees
    // or touches it until it ends (`phone_signin`).
    if let Some(refused) = while_phone_signs_in(super::phone_signin::live()) {
        return refused;
    }
    let level = super::independence::for_turn(super::policy::chosen_level(agent), outside);
    gate_with(
        team_enabled(),
        level,
        agent,
        tool,
        input,
        outside,
        &page_of(&agent.id),
    )
}

/// A browser step "Full send" let through that "Go hard" would have asked
/// for (a post, a send, a schedule), as (what it did, where) for the
/// turn's summary (`full_send`). `None` for everything else.
pub fn sent_at_full_send(
    agent: &Agent,
    tool: &str,
    input: &Value,
    outside: bool,
) -> Option<(&'static str, String)> {
    let level = super::independence::for_turn(super::policy::chosen_level(agent), outside);
    if level != Level::FullSend {
        return None;
    }
    let (page, name, input) = if let Some(name) = tool.strip_prefix(AGENTS_SERVER) {
        let (n, i) = agents_equivalent(name, input);
        (page_of(&agents_key(&agent.id)), n, i)
    } else {
        let name = tool.strip_prefix(SERVER)?;
        (page_of(&agent.id), name.to_string(), input.clone())
    };
    if decide(Level::FullSend, agent, &name, &input, &page) != Gate::Allow
        || decide(Level::GoHard, agent, &name, &input, &page) == Gate::Allow
    {
        return None;
    }
    let label = target_of(&page, &input).unwrap_or_default();
    let verb = if name == "javascript_tool" {
        "ran a script that submits"
    } else if matches!(name.as_str(), "file_upload" | "upload_image") {
        "uploaded"
    } else {
        super::full_send::browser_verb(&label)
    };
    let place = url_for(&page, &input)
        .and_then(|u| host_of(&u))
        .map(|h| format!("on {h}"))
        .unwrap_or_default();
    Some((verb, place))
}

/* --------------------------------------------- the agents' browser */

/// The agents' own browser's MCP server (`agent_browser::tools`), as its
/// tools are named in a turn.
pub const AGENTS_SERVER: &str = "mcp__browser__";

/// Where an agent's page memory for the agents' browser is kept (its
/// Claude in Chrome memory is under its bare id).
pub fn agents_key(agent_id: &str) -> String {
    format!("agents:{agent_id}")
}

/// Change an agent's page memory for the agents' browser: the server knows
/// exactly what each ref is, so it writes it here itself.
pub fn note_agents_page(agent_id: &str, f: impl FnOnce(&mut Page)) {
    with_pages(|p| f(p.entry(agents_key(agent_id)).or_default()));
}

/// An agents' browser tool as the Claude in Chrome call it amounts to, so
/// the same rules decide it: `click {ref}` is `computer {left_click, ref}`,
/// `type {ref, text}` is `form_input`, `press {key}` is `computer {key}`.
pub fn agents_equivalent(name: &str, input: &Value) -> (String, Value) {
    use serde_json::json;
    let mut i = input.clone();
    let tab = input.get("tab").cloned();
    if let (Some(t), Some(obj)) = (tab, i.as_object_mut()) {
        obj.insert("tabId".into(), t);
    }
    let with = |mut v: Value, extra: &[(&str, Value)]| {
        if let (Some(o), Some(src)) = (v.as_object_mut(), i.as_object()) {
            for (k, val) in src {
                o.entry(k.clone()).or_insert(val.clone());
            }
            for (k, val) in extra {
                o.insert((*k).to_string(), val.clone());
            }
        }
        v
    };
    match name {
        "tabs" => ("tabs_context_mcp".into(), i),
        "open" => ("tabs_create_mcp".into(), i),
        "navigate" => ("navigate".into(), i),
        "read_page" => ("read_page".into(), i),
        "find" => ("find".into(), i),
        "get_text" => ("get_page_text".into(), i),
        "close_tab" => ("tabs_close_mcp".into(), i),
        "screenshot" => (
            "computer".into(),
            with(json!({}), &[("action", json!("screenshot"))]),
        ),
        "scroll" => (
            "computer".into(),
            with(json!({}), &[("action", json!("scroll"))]),
        ),
        "wait_for" => (
            "computer".into(),
            with(json!({}), &[("action", json!("wait"))]),
        ),
        "click" => {
            let mut extra = vec![("action", json!("left_click"))];
            if let (Some(x), Some(y)) = (input.get("x"), input.get("y")) {
                extra.push(("coordinate", json!([x, y])));
            }
            ("computer".into(), with(json!({}), &extra))
        }
        "type" => match input.get("ref") {
            Some(r) => (
                "form_input".into(),
                with(
                    json!({}),
                    &[
                        ("ref", r.clone()),
                        ("value", input.get("text").cloned().unwrap_or(Value::Null)),
                    ],
                ),
            ),
            None => (
                "computer".into(),
                with(json!({}), &[("action", json!("type"))]),
            ),
        },
        "press" => (
            "computer".into(),
            with(
                json!({}),
                &[
                    ("action", json!("key")),
                    ("text", input.get("key").cloned().unwrap_or(Value::Null)),
                ],
            ),
        ),
        // Anything this build doesn't know asks.
        other => (format!("unknown_{other}"), i),
    }
}

/// While the user signs in for this agent from the phone (or at the Mac),
/// its browser waits.
pub const AGENTS_SIGNIN_REFUSAL: &str = "The user is signing in to a site in the agents' browser right now. Don't use the browser until they're done: carry on with what doesn't need it, or wait a few minutes and try again.";

/// Decide an agents' browser call. `enabled`: the Settings switch; the
/// agent's own "browser" setting and outside text apply as for Claude in
/// Chrome, but any engine may use it. Pure but for `page`.
pub fn gate_agents_with(
    enabled: bool,
    level: Level,
    agent: &Agent,
    name: &str,
    input: &Value,
    outside: bool,
    page: &Page,
) -> Gate {
    if !enabled {
        return Gate::Refuse(
            "The agents' browser is off (Settings → Agents). If the task needs a signed-in site, ask with request_login for it.".into(),
        );
    }
    if outside {
        return Gate::Refuse("The browser isn't available while you answer text from outside (a routine's items, or a message that carried them). Do this from the user's own request.".into());
    }
    if agent.reach.browser_off {
        return Gate::Refuse(
            "The browser isn't on for you. If the task needs a signed-in site, ask with request_login for it.".into(),
        );
    }
    let (n, i) = agents_equivalent(name, input);
    decide(level, agent, &n, &i, page)
}

/// [`describe`] for the agents' browser: the same plain words, about the
/// agents' browser rather than the user's own Chrome.
pub fn describe_agents(tool: &str, input: &Value, page: &Page) -> (String, String) {
    let name = tool.strip_prefix(AGENTS_SERVER).unwrap_or(tool);
    let (n, i) = agents_equivalent(name, input);
    let (title, said) = describe(&format!("{SERVER}{n}"), &i, page);
    let said = said
        .replace("in your signed-in Chrome", "in the agents' browser")
        .replace("in your Chrome", "in the agents' browser")
        .replace(
            "A new tab in your Chrome.",
            "A new window in the agents' browser.",
        );
    (title, said)
}

/* ------------------------------------------------------- card words */

fn site_of(page: &Page, input: &Value) -> String {
    url_for(page, input)
        .as_deref()
        .and_then(host_of)
        .map(|h| h.trim_start_matches("www.").to_string())
        .unwrap_or_else(|| "the page".to_string())
}

fn on(site: &str) -> String {
    if site == "the page" {
        "on the page".to_string()
    } else {
        format!("on {site}")
    }
}

fn clip(text: &str, n: usize) -> String {
    let t = text.trim().replace('\n', " ");
    if t.chars().count() > n {
        t.chars().take(n).collect::<String>() + "…"
    } else {
        t
    }
}

/// A browser call in plain words: a title, and a sentence saying what it
/// would do. The raw call stays behind Details.
pub fn describe(tool: &str, input: &Value, page: &Page) -> (String, String) {
    let name = tool.strip_prefix(SERVER).unwrap_or(tool);
    let site = site_of(page, input);
    let s = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let target = target_of(page, input).map(|l| name_in(&l));
    let as_you = |label: &str| match sends(label) {
        Some(what) => format!("This would {what}, in your signed-in Chrome."),
        None => "In your signed-in Chrome.".to_string(),
    };
    match name {
        "navigate" => {
            let url = s("url");
            match host_of(&url) {
                Some(h) => (
                    format!("Go to {}", h.trim_start_matches("www.")),
                    format!("Open {} in your Chrome.", clip(&url, 120)),
                ),
                None => (
                    "Open a link that isn't a web page".into(),
                    format!("Open {} in your Chrome.", clip(&url, 120)),
                ),
            }
        }
        "tabs_create_mcp" => ("Open a tab".into(), "A new tab in your Chrome.".into()),
        "tabs_close_mcp" => ("Close a tab".into(), "A tab it opened.".into()),
        "tabs_context_mcp" => (
            "Look at your open tabs".into(),
            "Which tabs are open.".into(),
        ),
        "list_connected_browsers" | "select_browser" | "switch_browser" => (
            "Use one of your Chrome profiles".into(),
            "Which Chrome it works in.".into(),
        ),
        "read_page" | "get_page_text" | "find" => (
            format!("Look at the page {}", on(&site)),
            "Reading only.".into(),
        ),
        "read_console_messages" | "read_network_requests" => (
            format!("Read the page's diagnostics {}", on(&site)),
            "Reading only.".into(),
        ),
        "javascript_tool" => (
            format!("Run a script {}", on(&site)),
            "A script can read anything on the page and send it anywhere.".into(),
        ),
        "file_upload" | "upload_image" => (
            format!("Upload a file {}", on(&site)),
            "This puts a file from this Mac on the page.".into(),
        ),
        "shortcuts_execute" => (
            "Run a Chrome shortcut".into(),
            "A shortcut can do anything in your Chrome.".into(),
        ),
        "gif_creator" => ("Save a recording".into(), "A GIF of what it did.".into()),
        "form_input" => {
            let what = target.clone().unwrap_or_else(|| "a field".into());
            (
                format!("Fill in “{}” {}", clip(&what, 40), on(&site)),
                as_you(&what),
            )
        }
        "computer" => {
            let action = s("action");
            if CLICKS.contains(&action.as_str()) {
                match target {
                    Some(t) => (
                        format!("Click “{}” {}", clip(&t, 40), on(&site)),
                        as_you(&t),
                    ),
                    None => (
                        format!("Click {}", on(&site)),
                        "It can't tell what this button does, so it's asking.".into(),
                    ),
                }
            } else if action == "type" {
                (
                    format!("Type {}", on(&site)),
                    format!("“{}”", clip(&s("text"), 120)),
                )
            } else if action == "key" {
                let key = Some(s("text"))
                    .filter(|k| !k.is_empty())
                    .unwrap_or_else(|| s("key"));
                if is_enter(&key) {
                    (
                        format!("Press Enter {}", on(&site)),
                        "This could send what it typed.".into(),
                    )
                } else {
                    (
                        format!("Press {} {}", clip(&key, 30), on(&site)),
                        String::new(),
                    )
                }
            } else {
                (format!("Look at the page {}", on(&site)), String::new())
            }
        }
        "browser_batch" => {
            let steps = batch_steps(input).unwrap_or_default();
            let first = steps
                .iter()
                .find(|(n, i)| !is_look(n, i))
                .map(|(n, i)| describe(&format!("{SERVER}{n}"), i, page));
            match first {
                Some((t, d)) if steps.len() > 1 => {
                    (format!("{t} (and {} more steps)", steps.len() - 1), d)
                }
                Some(td) => td,
                None => (
                    format!("Do several steps {}", on(&site)),
                    "In your signed-in Chrome.".into(),
                ),
            }
        }
        other => (
            format!(
                "{} {}",
                capitalized(&super::mcp::split_words(other).join(" ")),
                on(&site)
            ),
            "In your Chrome.".into(),
        ),
    }
}

/// A step that only looks (for picking the one a batch's card is about).
fn is_look(name: &str, input: &Value) -> bool {
    LOOKS.contains(&name)
        || name == "tabs_create_mcp"
        || (name == "computer"
            && input
                .get("action")
                .and_then(Value::as_str)
                .is_some_and(|a| COMPUTER_LOOKS.contains(&a)))
}

fn capitalized(text: &str) -> String {
    let mut c = text.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "browser_gate_tests.rs"]
mod tests;
