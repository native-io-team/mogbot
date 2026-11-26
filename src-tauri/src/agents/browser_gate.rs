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
//! keys, and a script that submits or posts (`go_hard::script_sends`). The
//! Send or Enter that asks the user's own Grok a question in its chat
//! (`assistant_chat`) isn't a send as them: it runs at "Go hard".
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
pub const PHONE_SIGNIN_REFUSAL: &str = concat!("The user is signing in to a site in this ", crate::computer::noun!(), "'s Chrome from their phone right now. Don't use the browser until they're done: carry on with what doesn't need it, or wait a few minutes and try again.");

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
    // Openers: "Start a post", "Create post", "Write a comment" open a
    // composer; the button inside it sends (Julian, 2026-11-16).
    "start",
    "create",
    "write",
    "compose",
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
    /// What it typed or filled in on this page, in order: the words a send
    /// click would send, shown on that card (`outward`).
    pub typed: Vec<String>,
    /// Browser calls waiting for their answer: tool_use id → tool name. An
    /// answer is read for labels only when it is one of these (CTO review
    /// 2026-11-14: `echo 'ref_42 search box'` from Bash relabelled Send).
    pub calls: HashMap<String, String>,
    /// Counts the agent's typing and its navigations (open, navigate) on
    /// this browser: an allowed send ends when it moves (`AllowedSend`).
    pub epoch: u64,
}

const MAX_REFS: usize = 4000;
const MAX_CALLS: usize = 256;

/// Browser calls whose answer says which `ref` is which control, or which
/// page each tab is on.
fn names_controls(name: &str) -> bool {
    matches!(name, "read_page" | "find" | "browser_batch") || name.starts_with("tabs_")
}
const MAX_TYPED: usize = 8;

/// Note what a typing step puts on the page (`form_input`'s value, a
/// `computer` "type"), so a send card can show the words. A navigation
/// starts over.
fn on_typed(page: &mut Page, name: &str, input: &Value) {
    let text = match name {
        "navigate" => {
            page.typed.clear();
            page.epoch += 1;
            return;
        }
        "tabs_create_mcp" => {
            page.epoch += 1;
            return;
        }
        "form_input" => input.get("value").and_then(Value::as_str),
        "computer" if input.get("action").and_then(Value::as_str) == Some("type") => {
            input.get("text").and_then(Value::as_str)
        }
        _ => None,
    };
    // Typing ends an allowed send, the same words again included; a date or
    // a time (the schedule step of a post) is not typing.
    if let Some(t) = text.map(str::trim) {
        if t.is_empty() || !super::outward::is_schedule_value(t) {
            page.epoch += 1;
        }
    }
    let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) else {
        return;
    };
    if page.typed.last().map(String::as_str) == Some(text) {
        return;
    }
    page.typed.push(text.to_string());
    if page.typed.len() > MAX_TYPED {
        page.typed.remove(0);
    }
}

/// An agents' browser call about to run: what it types, for the send card.
pub fn note_typed_agents(agent_id: &str, name: &str, input: &Value) {
    let (n, i) = agents_equivalent(name, input);
    note_agents_page(agent_id, |p| on_typed(p, &n, &i));
}

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
    ALLOWED_SENDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|s| s.agent != agent_id);
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
                    if let Some(id) = b.get("id").and_then(Value::as_str) {
                        if page.calls.len() >= MAX_CALLS {
                            page.calls.clear();
                        }
                        page.calls.insert(id.to_string(), name.to_string());
                    }
                    on_call(page, name, &input);
                }
                Some("tool_result") => {
                    // Only the browser's own reads name controls and tabs:
                    // any other tool's output (a command, a fetched page) is
                    // text the page could have written.
                    let call = b
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .and_then(|id| page.calls.remove(id));
                    if call.as_deref().is_some_and(names_controls) {
                        let text = result_text(b.get("content"));
                        on_answer(page, &text);
                    }
                }
                _ => {}
            }
        }
    });
}

fn on_call(page: &mut Page, name: &str, input: &Value) {
    // A batch's steps type, click and navigate like single calls do.
    // Observed: a message typed inside a batch, then sent with Return,
    // reached the exact-text card as "can't read the exact words".
    if name == "browser_batch" {
        for (n, i) in batch_steps(input).unwrap_or_default() {
            if n != "browser_batch" {
                on_call(page, &n, &i);
            }
        }
        return;
    }
    on_typed(page, name, input);
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

/// Whether the agent has `site` open in the user's own Chrome (our
/// extension's tabs, or Claude in Chrome's): the browser it is working in
/// there. A sign-in, passcode or step on that site belongs in that same
/// Chrome, never the agents' browser where it isn't signed in (Julian,
/// 2026-11-16: an X passcode in his Chrome raised an agents'-browser
/// sign-in).
pub fn in_users_chrome_on(agent_id: &str, site: &str) -> bool {
    [user_chrome_key(agent_id), agent_id.to_string()]
        .iter()
        .map(|k| page_of(k))
        .any(|p| {
            p.tabs
                .values()
                .chain(p.url.iter())
                .filter_map(|u| host_of(u))
                .any(|h| host_matches(&h, site))
        })
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
    // Julian, 2026-11-18: opening a LinkedIn post, a Slack message or a
    // GitHub issue asked "goes out under your name". A link, tab, row or
    // heading opens something; it never sends. The send is a button.
    if navigates(label) {
        return None;
    }
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

/// Controls that open, show or select something and never send it: a link,
/// tab, row, list item, heading or image. Where a page makes a send out of
/// one of these, the page it opens (a checkout, a composer) is judged on
/// its own, and the send itself is still a button the gate asks about.
pub fn navigates(label: &str) -> bool {
    let lower = label.trim_start().to_ascii_lowercase();
    if opens_thread(&name_in(label)) {
        return true;
    }
    [
        "link",
        "tab",
        "row",
        "cell",
        "gridcell",
        "listitem",
        "treeitem",
        "heading",
        "img",
        "image",
        "article",
        "statictext",
        "generic",
        "paragraph",
    ]
    .iter()
    .any(|r| {
        lower
            .strip_prefix(r)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '"', '[']))
    })
}

/// A control that opens a conversation to read: "1 reply", "12 replies",
/// "Reply in thread", "View thread". Observed 2026-11-18/19: opening a Slack
/// thread asked at Bold because "reply" is a send word. The send is the
/// composer's own button ("Send now"), which still asks.
fn opens_thread(name: &str) -> bool {
    let ws = words(name);
    let ws: Vec<&str> = ws.iter().map(String::as_str).collect();
    match ws.as_slice() {
        [n, "reply" | "replies"] => n.chars().all(|c| c.is_ascii_digit()),
        ["reply", "in", "thread"] | ["view", "thread"] | ["open", "thread"] => true,
        _ => false,
    }
}

/// A control that spends money or deletes something that doesn't come back
/// (an account, a repository, a project): it asks at every level, "Full
/// send" included.
pub fn floor_control(label: &str) -> Option<&'static str> {
    if navigates(label) {
        return None;
    }
    let name = name_in(label).to_ascii_lowercase();
    let ws = words(&name);
    let joined = ws.join(" ");
    if joined.contains("check out") || joined.contains("place order") {
        return Some("spend your money");
    }
    if ws.iter().any(|w| MONEY_WORDS.contains(&w.as_str())) && !is_field(label) {
        return Some("spend your money");
    }
    // "Unleashed" asks for nothing but money (the user's own words, 18 Nov
    // 2026): closing an account or deleting a repository runs too.
    None
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

/// The user's own assistant's chat: Grok on grok.com, or on X under
/// `/i/grok`. Asking it a question there is reading their own assistant, not
/// posting as them, so at "Go hard" and above the Enter or Send that asks it
/// goes through ([`asks_assistant`]). Sharing, publishing or deleting there
/// still asks, and the rest of x.com (posts, replies) is unchanged.
/// Observed: the Chief messaged an agent imported from Grok, which knew
/// nothing, instead of asking the user's real Grok.
pub fn assistant_chat(url: Option<&str>) -> bool {
    let Some(u) = url.and_then(|u| url::Url::parse(u.trim()).ok()) else {
        return false;
    };
    if !matches!(u.scheme(), "https" | "http") {
        return false;
    }
    let host = u.host_str().unwrap_or("");
    let path = u.path().to_ascii_lowercase();
    host_matches(host, "grok.com")
        || ((host_matches(host, "x.com") || host_matches(host, "twitter.com"))
            && (path == "/i/grok" || path.starts_with("/i/grok/")))
}

/// A Send (or Submit, or Enter) in the user's own assistant's chat, at "Go
/// hard" or above: asking it, which goes through. `what` is what
/// [`final_submit`] said the control does.
fn asks_assistant(level: Level, url: Option<&str>, what: &str) -> bool {
    level.goes_hard()
        && assistant_chat(url)
        && matches!(what, "send it as you" | "submit it as you")
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
            final_submit(label, level).is_none_or(|what| asks_assistant(level, url, what))
                && !money_page(url)
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
                        || (asks_assistant(level, url, "send it as you") && !in_password())
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
    // Windows paths use `\`: judge them with `/` like the rest.
    all.iter().map(|s| s.replace('\\', "/")).any(|s| {
        s.contains("/.ssh/")
            || s.contains("Keychains")
            || s.contains("/.gnupg/")
            || (s.contains('/') && super::autoallow::sensitive_name(std::path::Path::new(&s)))
    })
}

/// Pictures, videos and PDFs an upload may carry at "Go hard" when they are
/// the agent's own.
const OWN_MEDIA: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "m4v", "webm", "pdf",
];

/// Every file an upload names is a picture, video or PDF inside the agent's
/// own home (where it makes a post's image), or a picture or video in the
/// projects folder (where agents make and render work: Social Posts' Walmart
/// video, 2026-11-18), judged where a link lands. "Go hard" uploads those
/// without a card: one OK on the post's words covers the post, and asking
/// again for its picture was a card per post (Social Posts, 12 posts,
/// 2026-11-16). Anything else (the user's other files, a PDF outside its
/// home, a file that isn't media, no path at all) still asks.
fn own_media(agent_id: &str, input: &Value) -> bool {
    let Ok(home) = super::store::agent_home(agent_id) else {
        return false;
    };
    own_media_in(&home, crate::utils::projects_root().ok().as_deref(), input)
}

/// Pictures and videos only from the projects folder: a PDF there may be the
/// user's own document.
const PROJECT_MEDIA: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "m4v", "webm",
];

/// [`own_media`] with its folders given, for tests.
pub fn own_media_in(
    home: &std::path::Path,
    projects: Option<&std::path::Path>,
    input: &Value,
) -> bool {
    use std::path::{Component, Path, PathBuf};
    let real = |p: &Path| -> Option<PathBuf> {
        if let Ok(c) = p.canonicalize() {
            return Some(c);
        }
        // Not on disk (yet): only a plain absolute path, never `..`.
        (p.is_absolute() && !p.components().any(|c| c == Component::ParentDir))
            .then(|| p.to_path_buf())
    };
    let Some(home) = real(home) else {
        return false;
    };
    // A projects folder set to the home folder (or above it) would make
    // every picture on this computer the agent's own: then only its home counts.
    let user_home = dirs::home_dir().and_then(|h| real(&h));
    let projects = projects
        .and_then(&real)
        .filter(|p| user_home.as_ref().is_none_or(|h| !h.starts_with(p)));
    let mut paths = Vec::new();
    for key in ["paths", "path", "filePath", "file"] {
        match input.get(key) {
            Some(Value::String(s)) => paths.push(s.clone()),
            Some(Value::Array(a)) => {
                paths.extend(a.iter().filter_map(Value::as_str).map(str::to_string))
            }
            _ => {}
        }
    }
    !paths.is_empty()
        && paths.iter().all(|p| {
            let path = Path::new(p);
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            // `..` by either separator: in a Windows verbatim path (`\\?\C:\…`)
            // `/` isn't a separator, so `components()` alone misses `../x`.
            let climbs = p.split(['/', '\\']).any(|s| s == "..");
            let inside = |root: &Path| real(path).is_some_and(|r| r.starts_with(root) && r != root);
            !climbs
                && ((OWN_MEDIA.contains(&ext.as_str()) && inside(&home))
                    || (PROJECT_MEDIA.contains(&ext.as_str())
                        && projects.as_deref().is_some_and(inside)))
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
/// can't be read (it asks). A step written flat, `{"action": "navigate",
/// "url": …}` or `{"action": "screenshot"}`, is that `navigate` or that
/// `computer` action. Observed: navigate, wait and screenshot written flat
/// raised a card at Full send.
fn batch_steps(input: &Value) -> Option<Vec<(String, Value)>> {
    let list = ["actions", "steps", "calls", "batch", "commands"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_array))?;
    list.iter()
        .map(|s| {
            let flat = match s.get("action").and_then(Value::as_str) {
                Some("navigate") => Some("navigate"),
                Some(_) => Some("computer"),
                None => None,
            };
            let name = s
                .get("tool")
                .or_else(|| s.get("name"))
                .and_then(Value::as_str)
                .or(flat)?;
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

/// What an agent is told about a batch whose steps name no tool.
pub const BATCH_SHAPE: &str = "Nothing ran: each browser_batch step needs \"name\" (the tool, e.g. \"navigate\", \"computer\", \"get_page_text\") and \"input\" (its arguments, with tabId). Or call the tools one at a time.";

/// A batch with a list of steps, at least one of them naming no tool.
fn batch_unnamed(input: &Value) -> bool {
    ["actions", "steps", "calls", "batch", "commands"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_array))
        .is_some_and(|list| {
            !list.is_empty()
                && list.iter().any(|s| {
                    s.get("tool")
                        .or_else(|| s.get("name"))
                        .and_then(Value::as_str)
                        .is_none()
                })
        })
}

/// One browser tool (its name without the server) at `level`.
fn decide(level: Level, agent: &Agent, name: &str, input: &Value, page: &Page) -> Gate {
    let free = |ok: bool| if ok { Gate::Allow } else { Gate::Ask };
    // "Go hard": everything runs, scripts and shortcuts included, except
    // uploads and what sends (a script that submits or posts, a send click).
    if level.goes_hard() {
        match name {
            "file_upload" | "upload_image" => {
                return free(
                    !uploads_secret(input)
                        && (level == Level::FullSend || own_media(&agent.id, input)),
                )
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
        // Steps without a tool name: Chrome refuses the batch without doing
        // anything, so a card for it is a question about nothing. Checked
        // before reading the steps (which would guess a tool from `action`).
        "browser_batch" if batch_unnamed(input) => Gate::Refuse(BATCH_SHAPE.into()),
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
            // Steps without a tool name: Chrome refuses the batch without
            // doing anything, so a card for it is a question about nothing.
            // Observed: a navigate-and-screenshot batch on Gmail, written as
            // `{"action": …}`, asked the user, then failed once allowed.
            None if batch_unnamed(input) => Gate::Refuse(BATCH_SHAPE.into()),
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
        let g = gate_agents_with(
            crate::agent_browser::settings::enabled(),
            level,
            agent,
            name,
            input,
            outside,
            &page_of(&agents_key(&agent.id)),
        );
        let g = held_for_exact_text(g, agent, tool, input);
        let g = unless_same_send(g, agent, tool, input);
        let page = page_of(&agents_key(&agent.id));
        let (n, i) = agents_equivalent(name, input);
        if g == Gate::Ask
            && only_unlabelled_click(level, agent, super::outward::required(agent), &n, &i, &page)
            && first_try(&agent.id, input)
        {
            return Gate::Refuse(UNLABELLED_CLICK.into());
        }
        return g;
    }
    if let Some(name) = tool.strip_prefix(USER_CHROME_SERVER) {
        let level = super::independence::for_turn(super::policy::chosen_level(agent), outside);
        return gate_user_chrome_at(level, agent, tool, name, input, outside);
    }
    gate_rest(agent, tool, input, outside)
}

/// A project tab's or a Terminal session's call to Your Chrome
/// (`user_chrome::sessions`): the user's own rules for agents, at the
/// team's level but never past "Bold" ([`session_level`]), so what sends,
/// posts, pays, deletes or shares always asks on a card.
pub fn gate_session(agent: &Agent, tool: &str, input: &Value) -> Gate {
    match tool.strip_prefix(USER_CHROME_SERVER) {
        Some(name) => gate_user_chrome_at(
            session_level(super::independence::level()),
            agent,
            tool,
            name,
            input,
            false,
        ),
        None => Gate::NotBrowser,
    }
}

/// A session's level: the team's, with "Unleashed" held to "Bold". Pure.
pub fn session_level(team: Level) -> Level {
    match team {
        Level::FullSend => Level::GoHard,
        other => other,
    }
}

/// Your Chrome's call at `level`.
fn gate_user_chrome_at(
    level: Level,
    agent: &Agent,
    tool: &str,
    name: &str,
    input: &Value,
    outside: bool,
) -> Gate {
    // The user's own Chrome, through the app's extension: the same
    // Chrome a phone sign-in drives, so it waits for that too.
    if let Some(refused) = while_phone_signs_in(super::phone_signin::live()) {
        return refused;
    }
    let page = page_of(&user_chrome_key(&agent.id));
    let g = gate_user_chrome_with(
        crate::user_chrome::settings::enabled(),
        level,
        agent,
        name,
        input,
        outside,
        &page,
    );
    let g = held_for_exact_text(g, agent, tool, input);
    let g = unless_same_send(g, agent, tool, input);
    let (n, i) = agents_equivalent(name, input);
    let exact = super::outward::required(agent);
    if g == Gate::Ask
        && only_unlabelled_enter(level, agent, exact, &n, &i, &page)
        && first_try(&agent.id, input)
    {
        return Gate::Refuse(UNLABELLED_ENTER.into());
    }
    if g == Gate::Ask
        && only_unlabelled_click(level, agent, exact, &n, &i, &page)
        && first_try(&agent.id, input)
    {
        return Gate::Refuse(UNLABELLED_CLICK.into());
    }
    g
}

/// [`gate`] for Claude in Chrome and anything else.
fn gate_rest(agent: &Agent, tool: &str, input: &Value, outside: bool) -> Gate {
    if !tool.starts_with(SERVER) {
        return Gate::NotBrowser;
    }
    // The user's phone is driving a sign-in in this Chrome: no agent sees
    // or touches it until it ends (`phone_signin`).
    if let Some(refused) = while_phone_signs_in(super::phone_signin::live()) {
        return refused;
    }
    let level = super::independence::for_turn(super::policy::chosen_level(agent), outside);
    let page = page_of(&agent.id);
    let g = gate_with(team_enabled(), level, agent, tool, input, outside, &page);
    let g = held_for_exact_text(g, agent, tool, input);
    let g = unless_same_send(g, agent, tool, input);
    let name = tool.strip_prefix(SERVER).unwrap_or(tool);
    if g == Gate::Ask
        && only_unlabelled_enter(
            level,
            agent,
            super::outward::required(agent),
            name,
            input,
            &page,
        )
        && first_try(&agent.id, input)
    {
        return Gate::Refuse(UNLABELLED_ENTER.into());
    }
    if g == Gate::Ask
        && only_unlabelled_click(
            level,
            agent,
            super::outward::required(agent),
            name,
            input,
            &page,
        )
        && first_try(&agent.id, input)
    {
        return Gate::Refuse(UNLABELLED_CLICK.into());
    }
    g
}

/// What an agent is told when Enter would press into a box it never named.
pub const UNLABELLED_ENTER: &str = "Nothing ran: this presses Enter in a box clicked by position, and the app can't tell a search box from a message box, so it would have put a \"goes out under your name\" card to the user. Find the box first (find \"search box\", or read_page) and click it by its ref: Enter in a search box then runs on its own, and in a message box it asks with the exact words. If the box has no ref, send the same steps again and they go to the user on a card.";

/// Whether the only thing a call would ask about is Enter pressed after a
/// click (or no click) the page memory has no label for. Observed
/// (2026-11-08): a read-only search in a team chat's web app, typed into
/// the search box clicked by position, raised "Goes out under your name,
/// exactly: “<the search words>”" at Full send. Nobody answered, it
/// expired, and the check stopped there. Asking the agent to name the box
/// costs one call and answers the question the card couldn't. Pure.
pub fn only_unlabelled_enter(
    level: Level,
    agent: &Agent,
    exact_text: bool,
    name: &str,
    input: &Value,
    page: &Page,
) -> bool {
    let steps = if name == "browser_batch" {
        match batch_steps(input) {
            Some(s) if !s.is_empty() => s,
            _ => return false,
        }
    } else {
        vec![(name.to_string(), input.clone())]
    };
    let mut page = page.clone();
    let mut found = false;
    for (n, i) in &steps {
        let enter = n == "computer"
            && i.get("action").and_then(Value::as_str) == Some("key")
            && i.get("text")
                .or_else(|| i.get("key"))
                .and_then(Value::as_str)
                .is_some_and(is_enter);
        if enter && page.last_target.is_none() && !money_page(url_for(&page, i).as_deref()) {
            found = true;
        } else if n == "browser_batch"
            || decide(level, agent, n, i, &page) != Gate::Allow
            || (exact_text && outward_step_on(agent, n, i, &page))
        {
            return false;
        }
        on_call(&mut page, n, i);
    }
    found
}

/// What an agent is told when a click by position after typing would ask.
pub const UNLABELLED_CLICK: &str = "Nothing ran: this clicks by position after you typed on the page, and the app can't tell that from a Send or Post button, so it would have put a \"goes out under your name\" card to the user. Find the control first (find \"<its words>\", or read_page) and click it by its ref: a radio, checkbox, tab, menu or Next then runs on its own, and a Send or Post asks with the exact words. If it has no ref, send the same click again and it goes to the user on a card.";

/// Whether the only thing a call would ask about is a click by position
/// after typing, held by the exact-text rule ([`outward_step_on`]) though
/// the level lets it through. Observed (Julian, 2026-11-17, Play Console):
/// an email typed into a form, then a radio button clicked by position,
/// raised "Goes out under your name, exactly: “<the email>”". Asking the
/// agent to click by ref costs one call and answers what the card couldn't.
/// Pure.
pub fn only_unlabelled_click(
    level: Level,
    agent: &Agent,
    exact_text: bool,
    name: &str,
    input: &Value,
    page: &Page,
) -> bool {
    let action = input.get("action").and_then(Value::as_str).unwrap_or("");
    exact_text
        && name == "computer"
        && CLICKS.contains(&action)
        && !page.typed.is_empty()
        && target_of(page, input).is_none()
        && !money_page(url_for(page, input).as_deref())
        && decide(level, agent, name, input, page) == Gate::Allow
}

static REDIRECTED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// The first time an agent sends these exact steps: later, the same steps
/// go to the user on a card, so an agent that can't name the box isn't stuck.
fn first_try(agent_id: &str, input: &Value) -> bool {
    let key = format!("{agent_id}\u{1f}{input}");
    let mut guard = REDIRECTED.lock().unwrap_or_else(|e| e.into_inner());
    let seen = guard.get_or_insert_with(Default::default);
    if seen.len() > 500 {
        seen.clear();
    }
    seen.insert(key)
}

/// A send the user allowed on a card. Posting is several clicks (Post,
/// Confirm, Schedule) of one send (Julian, 2026-11-16: three cards per
/// scheduled post), so the allowed words cover later clicks in the same tab,
/// on the same site, with the same words, for 15 minutes, and END the next
/// time the agent types (the same words included; a date or time is not
/// typing) or navigates (`Page::epoch`). The page changing its own address
/// doesn't end it. The same control repeats for a minute only (a click
/// retried after a hiccup); a second Post asks. Money always asks (`send_of`).
/// It leaves: a site's own Forward or Share button, clicked in that tab on
/// that page before any typing, rides on the Allow.
struct AllowedSend {
    agent: String,
    host: String,
    words: String,
    tab: Option<u64>,
    epoch: u64,
    at: i64,
    /// The controls clicked under this entry, and when.
    seen: Vec<(String, i64)>,
}

static ALLOWED_SENDS: Mutex<Vec<AllowedSend>> = Mutex::new(Vec::new());

/// How long an allowed send's later clicks go through.
const SAME_SEND_MS: i64 = 15 * 60 * 1000;

/// How long the very same control may be clicked again.
const RETRY_MS: i64 = 60 * 1000;

/// The page, tool name and input a browser call acts on, for any browser.
fn call_on(agent_id: &str, tool: &str, input: &Value) -> Option<(Page, String, Value)> {
    own_call(agent_id, tool, input).or_else(|| {
        let name = tool.strip_prefix(SERVER)?;
        Some((page_of(agent_id), name.to_string(), input.clone()))
    })
}

/// What an allowed send is remembered by: the site, the words, the tab, the
/// page memory's epoch, and the control clicked.
struct SendOf {
    host: String,
    words: String,
    tab: Option<u64>,
    epoch: u64,
    control: String,
    /// Its label is a step of getting words out (`continues_a_send`).
    covered: bool,
}

/// Labels that are steps of getting words out. Anything else (Delete
/// project, Invite, a label in another language) is not covered by an Allow
/// for a post: it asks.
const SEND_STEPS: &[&str] = &[
    "post", "send", "reply", "publish", "schedule", "confirm", "next", "done", "save",
];

/// Words that may sit beside a send step ("Post now", "Send message").
const SEND_FILLER: &[&str] = &[
    "now", "it", "this", "the", "your", "a", "message", "comment",
];

/// Whether a control is one more step of getting words out: no label at all,
/// or only send-step words.
fn continues_a_send(label: Option<&str>) -> bool {
    let Some(label) = label else {
        return true;
    };
    let name = name_in(label);
    let tokens = words(&name);
    if !label.contains('"') {
        // A role with no name: unlabelled.
        return true;
    }
    !tokens.is_empty()
        && tokens.iter().any(|t| SEND_STEPS.contains(&t.as_str()))
        && tokens
            .iter()
            .all(|t| SEND_STEPS.contains(&t.as_str()) || SEND_FILLER.contains(&t.as_str()))
}

/// How many different controls one Allow covers (a click by position is
/// looked at twice, raw and then labelled, so it counts twice).
const MAX_CONTROLS: usize = 8;

/// The send a step is a part of: `None` unless it is a step that goes out
/// under the user's name with words typed on a known site, and nothing "Full
/// send" still asks for (money, uploads, scripts). A date
/// or time typed isn't part of the words.
fn send_of(agent: &Agent, tool: &str, input: &Value) -> Option<SendOf> {
    let (page, name, input) = call_on(&agent.id, tool, input)?;
    if matches!(
        name.as_str(),
        "javascript_tool" | "file_upload" | "upload_image" | "browser_batch"
    ) || page.typed.is_empty()
        || !outward_step_on(agent, &name, &input, &page)
        || decide(Level::FullSend, agent, &name, &input, &page) != Gate::Allow
    {
        return None;
    }
    let host = url_for(&page, &input).and_then(|u| host_of(&u))?;
    let words: Vec<&str> = page
        .typed
        .iter()
        .map(String::as_str)
        .filter(|t| !super::outward::is_schedule_value(t))
        .collect();
    let tab = tab_of(&input);
    let control = match input.get("ref").and_then(Value::as_str) {
        Some(r) => format!("{tab:?}|{}", page.refs.get(r).map_or(r, String::as_str)),
        None => format!("{tab:?}|{name}|{input}"),
    };
    let label = input
        .get("ref")
        .and_then(Value::as_str)
        .and_then(|r| page.refs.get(r))
        .map(String::as_str);
    Some(SendOf {
        covered: continues_a_send(label),
        host,
        words: super::outward::norm(&words.join("\n")),
        tab,
        epoch: page.epoch,
        control,
    })
}

/// The user allowed this browser step on a card: later clicks of the same
/// send won't ask again (see [`AllowedSend`]).
pub fn note_allowed_send(agent: &Agent, tool: &str, input: &Value) {
    let Some(send) = send_of(agent, tool, input) else {
        return;
    };
    let now = super::store::now_ms();
    let mut sends = ALLOWED_SENDS.lock().unwrap_or_else(|e| e.into_inner());
    sends.retain(|s| now - s.at < SAME_SEND_MS);
    sends.push(AllowedSend {
        agent: agent.id.clone(),
        host: send.host,
        words: send.words,
        tab: send.tab,
        epoch: send.epoch,
        at: now,
        seen: vec![(send.control, now)],
    });
}

/// Whether this step continues a send the user already allowed.
fn same_send_allowed(agent: &Agent, tool: &str, input: &Value) -> bool {
    let Some(send) = send_of(agent, tool, input) else {
        return false;
    };
    let now = super::store::now_ms();
    let mut sends = ALLOWED_SENDS.lock().unwrap_or_else(|e| e.into_inner());
    sends.retain(|s| now - s.at < SAME_SEND_MS);
    for s in sends.iter_mut().filter(|s| {
        s.agent == agent.id
            && s.host == send.host
            && s.words == send.words
            && s.tab == send.tab
            && s.epoch == send.epoch
    }) {
        let room = send.covered && s.seen.len() < MAX_CONTROLS;
        match s.seen.iter_mut().find(|(c, _)| *c == send.control) {
            // The same control again: a retry within a minute, never a
            // second Post.
            Some((_, at)) => {
                if now - *at < RETRY_MS {
                    return true;
                }
            }
            None if room => {
                s.seen.push((send.control.clone(), now));
                return true;
            }
            None => {}
        }
    }
    false
}

/// A card the gate would raise for the next step of a send already allowed.
fn unless_same_send(g: Gate, agent: &Agent, tool: &str, input: &Value) -> Gate {
    if g == Gate::Ask && same_send_allowed(agent, tool, input) {
        Gate::Allow
    } else {
        g
    }
}

/// With "nothing goes out under my name unless I OK the exact text" on
/// (`outward`), a send click, Enter or script that submits asks at every
/// level, "Full send" included: its card shows what was typed.
fn held_for_exact_text(g: Gate, agent: &Agent, tool: &str, input: &Value) -> Gate {
    if g == Gate::Allow && super::outward::required(agent) && outward_step(agent, tool, input) {
        Gate::Ask
    } else {
        g
    }
}

/// A browser step that sends, posts or submits under the user's name: one
/// "Go hard" asks for (a send click, Enter in a message box, a script that
/// submits), other than opening a page or uploading a file.
pub fn outward_step(agent: &Agent, tool: &str, input: &Value) -> bool {
    let (page, name, input) = if let Some(own) = own_call(&agent.id, tool, input) {
        own
    } else if let Some(name) = tool.strip_prefix(SERVER) {
        (page_of(&agent.id), name.to_string(), input.clone())
    } else {
        return false;
    };
    outward_step_on(agent, &name, &input, &page)
}

/// [`outward_step`] on a known page, for tests.
pub fn outward_step_on(agent: &Agent, name: &str, input: &Value, page: &Page) -> bool {
    // A batch goes out only when one of its steps does: a navigation the
    // gate asks about, or a look, isn't a send. Observed: a batch that
    // closed a menu, opened a Gmail search and read the page got a "Goes
    // out under your name" card.
    if name == "browser_batch" {
        let Some(steps) = batch_steps(input).filter(|s| !s.is_empty()) else {
            return !batch_unnamed(input);
        };
        let mut page = page.clone();
        for (n, i) in &steps {
            if n == "browser_batch" || outward_step_on(agent, n, i, &page) {
                return true;
            }
            on_call(&mut page, n, i);
        }
        return false;
    }
    if matches!(
        name,
        "navigate" | "tabs_create_mcp" | "gif_creator" | "file_upload" | "upload_image"
    ) || name.starts_with("unknown_")
    {
        return false;
    }
    // A click by coordinate (or on a ref nothing labelled) after typing on
    // this page can't be told from the Post button: Go hard lets it through
    // as unlabelled, so on its own it would skip the exact-text card. Found
    // in review (CTO, 2026-11-14): type a post, click Post by position.
    if name == "computer" && !page.typed.is_empty() {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        if CLICKS.contains(&action) && target_of(page, input).is_none() {
            return true;
        }
    }
    decide(Level::GoHard, agent, name, input, page) != Gate::Allow
}

/// What was typed on the page a browser call acts on (`outward`'s card).
pub fn typed_for(agent_id: &str, tool: &str, input: &Value) -> Vec<String> {
    if let Some(key) = own_page_key(agent_id, tool) {
        page_of(&key).typed
    } else {
        typed_through(page_of(agent_id), tool, input)
    }
}

/// What was typed by the time a call sends: the page's, plus what a batch
/// types in its own steps before the send.
pub fn typed_through(mut page: Page, tool: &str, input: &Value) -> Vec<String> {
    if tool.strip_prefix(SERVER) == Some("browser_batch") {
        on_call(&mut page, "browser_batch", input);
    }
    page.typed
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
    let (page, name, input) = if let Some(own) = own_call(&agent.id, tool, input) {
        own
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

/// A browser step a plan the user allowed could cover (`plan_grant`): one
/// "Full send" would let through and the agent's own level asks for (a post,
/// a reply, a send on a site), with what it does and where. Never the floor
/// "Full send" still asks for (paying, passwords, uploads of secrets), never
/// a script or an upload, and never a step with no known site.
pub fn plan_step(agent: &Agent, tool: &str, input: &Value) -> Option<(&'static str, String)> {
    let (page, name, input) = if let Some(own) = own_call(&agent.id, tool, input) {
        own
    } else {
        let name = tool.strip_prefix(SERVER)?;
        (page_of(&agent.id), name.to_string(), input.clone())
    };
    if matches!(
        name.as_str(),
        "javascript_tool" | "file_upload" | "upload_image"
    ) || decide(Level::FullSend, agent, &name, &input, &page) != Gate::Allow
    {
        return None;
    }
    let label = target_of(&page, &input).unwrap_or_default();
    let verb = super::full_send::browser_verb(&label);
    let host = url_for(&page, &input).and_then(|u| host_of(&u))?;
    Some((verb, host))
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
        "read_console" => ("read_console_messages".into(), i),
        "read_network" => ("read_network_requests".into(), i),
        "close_tab" => ("tabs_close_mcp".into(), i),
        // A picture pasted from this Mac is an upload: the same rules.
        "attach_image" => ("upload_image".into(), i),
        "browsers" => ("list_connected_browsers".into(), i),
        "use_browser" => ("select_browser".into(), i),
        "hover" => {
            let mut extra = vec![("action", json!("hover"))];
            if let (Some(x), Some(y)) = (input.get("x"), input.get("y")) {
                extra.push(("coordinate", json!([x, y])));
            }
            ("computer".into(), with(json!({}), &extra))
        }
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

/* ------------------------------------- the user's Chrome, our extension */

/// The user's own Chrome through the app's extension (`user_chrome`), as its
/// tools are named in a turn. Same tool names and shapes as the agents'
/// browser ([`AGENTS_SERVER`]), so prompts and these rules carry over.
pub const USER_CHROME_SERVER: &str = "mcp__user_chrome__";

/// Where an agent's page memory for the user's Chrome is kept.
pub fn user_chrome_key(agent_id: &str) -> String {
    format!("chrome:{agent_id}")
}

/// Change an agent's page memory for the user's Chrome (the server knows
/// what each ref is, as for the agents' browser).
pub fn note_user_chrome_page(agent_id: &str, f: impl FnOnce(&mut Page)) {
    with_pages(|p| f(p.entry(user_chrome_key(agent_id)).or_default()));
}

/// A user's-Chrome call about to run: what it types, for the send card.
pub fn note_typed_user_chrome(agent_id: &str, name: &str, input: &Value) {
    let (n, i) = agents_equivalent(name, input);
    note_user_chrome_page(agent_id, |p| on_typed(p, &n, &i));
}

/// One of the app's own browser servers: the agents' browser, or the
/// user's Chrome through the app's extension. Both answer the same tools.
pub fn is_own_browser(tool: &str) -> bool {
    tool.starts_with(AGENTS_SERVER) || tool.starts_with(USER_CHROME_SERVER)
}

/// The page memory an own-browser tool reads.
pub fn own_page_key(agent_id: &str, tool: &str) -> Option<String> {
    if tool.starts_with(AGENTS_SERVER) {
        Some(agents_key(agent_id))
    } else if tool.starts_with(USER_CHROME_SERVER) {
        Some(user_chrome_key(agent_id))
    } else {
        None
    }
}

/// The page an own-browser call acts on, when its page memory knows it.
pub fn own_url_of(agent_id: &str, tool: &str, input: &Value) -> Option<String> {
    let (page, _, i) = own_call(agent_id, tool, input)?;
    url_for(&page, &i)
}

/// An own-browser call as the Claude in Chrome call it amounts to, with
/// the page memory it is judged on.
fn own_call(agent_id: &str, tool: &str, input: &Value) -> Option<(Page, String, Value)> {
    let key = own_page_key(agent_id, tool)?;
    let name = tool
        .strip_prefix(AGENTS_SERVER)
        .or_else(|| tool.strip_prefix(USER_CHROME_SERVER))?;
    let (n, i) = agents_equivalent(name, input);
    Some((page_of(&key), n, i))
}

/// Decide a call into the user's own Chrome through the app's extension.
/// `enabled`: Settings → Agents → "Your Chrome". Any engine may use it (it
/// isn't tied to a Claude account), but never in a turn answering outside
/// text, never for an agent whose browser is off, and every rule that
/// decides a Claude in Chrome call decides this one. Pure but for `page`.
pub fn gate_user_chrome_with(
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
            "Your Chrome isn't connected for agents (Settings → Chrome). If the task needs a signed-in site, ask with request_login for it.".into(),
        );
    }
    if outside {
        return Gate::Refuse("Your browser isn't available while you answer text from outside (a routine's items, or a message that carried them). Do this from the user's own request.".into());
    }
    if agent.reach.browser_off {
        return Gate::Refuse(
            "The user's browser isn't on for you. If the task needs a signed-in site, ask with request_login for it.".into(),
        );
    }
    let (n, i) = agents_equivalent(name, input);
    decide(level, agent, &n, &i, page)
}

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
    if let Some(name) = tool.strip_prefix(USER_CHROME_SERVER) {
        // The user's own Chrome: Claude in Chrome's words are already right.
        let (n, i) = agents_equivalent(name, input);
        return describe(&format!("{SERVER}{n}"), &i, page);
    }
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
            concat!(
                "This puts a file from this ",
                crate::computer::noun!(),
                " on the page."
            )
            .into(),
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
