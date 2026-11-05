//! Login cards: how an agent gets access to an app, without a password ever
//! passing through a chat.
//!
//! An agent that needs an account calls `request_login {service,
//! account_hint, scopes, why}` instead of asking for a password. That puts one
//! card in its chat ("Recruiter needs your Gmail"): which account, what it will
//! be able to do (read, or also send), and the ways in, best first:
//!
//! 1. **Connect** (tier 1): a connector, scoped and revocable, whose sign-in
//!    the agent never sees. Ours (`oauth.rs`, token in this Mac's Keychain),
//!    a claude.ai connector (held by claude.ai), or the GitHub CLI's sign-in.
//!    An account already connected for another agent is offered as "Use …",
//!    one click.
//! 2. **Use my browser** (tier 2): for a site with no connector, the agent
//!    works in the user's own Chrome through Claude in Chrome, where they are
//!    already signed in. Every click, post, send or payment asks on a card.
//! 3. **A key** (tier 3): only for a raw API key, into the masked field and
//!    the Keychain (`secrets.rs`). Never a password.
//!
//! When a service has no connector, the card says so in one line rather
//! than offering a password field.
//!
//! **Where it runs.** Every way in runs on this Mac, whichever device the
//! card was answered on: the phone asks the Mac to start it
//! (`agents.loginStart`), the Mac opens the sign-in in its own browser, and
//! the token is created and kept here. The card's live state
//! ([`Flow`], in memory, overlaid onto the card wherever it is read or
//! emitted) reaches both devices as the card itself.
//!
//! **Upgrading.** Secret cards an older build raised for something that has
//! a connector or a site (an import's "gmail_work", "linkedin_token") are
//! moved onto login cards at launch ([`migrate_pending`]): the old card is
//! marked expired with a line saying where it went, and a login card takes
//! its place, quiet if the old one was. Nobody re-answers anything.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::connections::{self, Access, Kind};
use super::engine::Engine;
use super::runner;
use super::secrets;
use super::store::{self, Agent, AgentMessage, Approval, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/* ------------------------------------------------------------ catalogue */

/// How a service can be connected (tier 1), if at all.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Connector {
    /// A remote MCP server that registers clients and signs in with OAuth.
    Oauth(&'static str),
    /// A claude.ai connector, by its name there ("Gmail").
    ClaudeAi(&'static str),
    /// The GitHub CLI's own sign-in.
    Gh,
    None,
}

pub struct Service {
    pub id: &'static str,
    pub title: &'static str,
    /// Words in a request's name that mean this service.
    pub aliases: &'static [&'static str],
    pub connector: Connector,
    /// The site the agent would use in the browser.
    pub site: Option<&'static str>,
    pub read: &'static str,
    pub write: &'static str,
    /// Why there's no connector of our own, said plainly on the card.
    pub why_not: Option<&'static str>,
    /// A raw API key is a real way in (tier 3): its label.
    pub key: Option<&'static str>,
}

/// Every service a card knows by name. Checked 2026-11 against each
/// vendor's published MCP metadata (see `oauth.rs`).
pub const SERVICES: &[Service] = &[
    Service {
        id: "gmail",
        title: "Gmail",
        aliases: &["gmail", "google mail", "googlemail"],
        connector: Connector::ClaudeAi("Gmail"),
        site: Some("mail.google.com"),
        read: "Read and search your email",
        write: "Draft and send email",
        why_not: Some("Google only lets apps it has approved use Gmail's own connector, so Gmail comes through claude.ai's connector or your browser."),
        key: None,
    },
    Service {
        id: "google_calendar",
        title: "Google Calendar",
        aliases: &["google calendar", "gcal", "calendar"],
        connector: Connector::ClaudeAi("Google Calendar"),
        site: Some("calendar.google.com"),
        read: "See your calendar",
        write: "Create and change events",
        why_not: Some("Google only lets apps it has approved use Calendar's own connector, so it comes through claude.ai's connector or your browser."),
        key: None,
    },
    Service {
        id: "google_drive",
        title: "Google Drive",
        aliases: &["google drive", "gdrive", "google docs", "google sheets"],
        connector: Connector::ClaudeAi("Google Drive"),
        site: Some("drive.google.com"),
        read: "Find and read your files",
        write: "Create and edit files",
        why_not: Some("Google only lets apps it has approved use Drive's own connector, so it comes through claude.ai's connector or your browser."),
        key: None,
    },
    Service {
        id: "slack",
        title: "Slack",
        aliases: &["slack"],
        connector: Connector::ClaudeAi("Slack"),
        site: Some("app.slack.com"),
        read: "Read channels and messages",
        write: "Post messages",
        why_not: Some("Slack's own connector only signs in apps registered with Slack, so Slack comes through claude.ai's connector or your browser."),
        key: None,
    },
    Service {
        id: "linkedin",
        title: "LinkedIn",
        aliases: &["linkedin", "linked in"],
        connector: Connector::None,
        site: Some("www.linkedin.com"),
        read: "Read your feed, profile and messages",
        write: "Post and send messages",
        why_not: Some("LinkedIn has no connector agents can sign in to."),
        key: None,
    },
    Service {
        id: "x",
        title: "X",
        aliases: &["x", "twitter", "x com", "tweet", "tweets"],
        connector: Connector::None,
        site: Some("x.com"),
        read: "Read your timeline and mentions",
        write: "Post and reply",
        why_not: Some("X has no connector agents can sign in to; its API needs a developer account."),
        key: Some("X API bearer token"),
    },
    Service {
        id: "github",
        title: "GitHub",
        aliases: &["github", "gh"],
        connector: Connector::Gh,
        site: Some("github.com"),
        read: "Read repositories, issues and pull requests",
        write: "Comment, open issues and push",
        why_not: None,
        key: None,
    },
    Service {
        id: "linear",
        title: "Linear",
        aliases: &["linear"],
        connector: Connector::Oauth("https://mcp.linear.app/mcp"),
        site: Some("linear.app"),
        read: "Read issues and projects",
        write: "Create and update issues",
        why_not: None,
        key: None,
    },
    Service {
        id: "notion",
        title: "Notion",
        aliases: &["notion"],
        connector: Connector::Oauth("https://mcp.notion.com/mcp"),
        site: Some("www.notion.so"),
        read: "Read pages and databases",
        write: "Create and edit pages",
        why_not: None,
        key: None,
    },
    Service {
        id: "figma",
        title: "Figma",
        aliases: &["figma"],
        connector: Connector::Oauth("https://mcp.figma.com/mcp"),
        site: Some("www.figma.com"),
        read: "Read designs and comments",
        write: "Comment and change designs",
        why_not: None,
        key: None,
    },
    Service {
        id: "stripe",
        title: "Stripe",
        aliases: &["stripe"],
        connector: Connector::Oauth("https://mcp.stripe.com"),
        site: Some("dashboard.stripe.com"),
        read: "Read customers, payments and invoices",
        write: "Create invoices, refunds and payments",
        why_not: None,
        key: Some("Stripe restricted key"),
    },
    Service {
        id: "vercel",
        title: "Vercel",
        aliases: &["vercel"],
        connector: Connector::Oauth("https://mcp.vercel.com"),
        site: Some("vercel.com"),
        read: "Read projects, deployments and logs",
        write: "Change projects and deploy",
        why_not: None,
        key: None,
    },
];

pub fn service(id: &str) -> Option<&'static Service> {
    SERVICES.iter().find(|s| s.id == id)
}

/// The service a free-text name means: "Work Gmail inbox (gmail_work)"
/// is Gmail, "linkedin_token" is LinkedIn, "x_api" is X. Whole words only,
/// so "excel" isn't X and "calendar app" without Google still is Calendar.
pub fn match_service(text: &str) -> Option<&'static Service> {
    let words: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();
    let padded = format!(
        " {} ",
        words.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    // Longer aliases first, so "google calendar" beats a bare "calendar".
    let mut best: Option<(&'static Service, usize)> = None;
    for s in SERVICES {
        for alias in s.aliases {
            if padded.contains(&format!(" {alias} ")) && best.is_none_or(|(_, n)| alias.len() > n) {
                best = Some((s, alias.len()));
            }
        }
    }
    best.map(|(s, _)| s)
}

/* ---------------------------------------------------------------- card */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ability {
    /// `read` or `write`.
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// An account already connected (for another agent): one click.
    Existing,
    Oauth,
    ClaudeAi,
    Gh,
    Browser,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginOption {
    /// Unique on the card: the method, or `existing:<connection id>`.
    pub id: String,
    pub method: Method,
    /// The button: "Connect Linear", "Use my browser", "Use work@acme.com".
    pub label: String,
    /// What it means, honestly: where it signs in, where the sign-in is kept.
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlowState {
    /// Getting the sign-in ready (finding the app's sign-in page).
    #[default]
    Starting,
    /// The sign-in is open in this Mac's browser, waiting for the user.
    Waiting,
    Failed,
    Cancelled,
}

/// A way in that's under way, as both devices show it. Never stored: it
/// lives in this process and is laid over the card when it's read.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub state: FlowState,
    pub option: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub started_at: i64,
    /// Started from the phone: it says "Finish signing in on your Mac".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_phone: bool,
    /// The sign-in itself is on the phone (its sign-in sheet, or claude.ai
    /// there), not in this Mac's browser. Implies `from_phone`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub on_phone: bool,
    /// A device sign-in's one-time code (GitHub's, through `gh`): typed at
    /// `verification_uri` on any device. Short-lived and single-use; only
    /// on the card while it's waiting, never stored or logged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
}

/// What a login card carries (`Approval.login`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// The catalogue's id, or `other` for a service it doesn't know.
    pub service: String,
    pub title: String,
    /// What the agent called it, when that's not just the title
    /// ("Work Gmail inbox (gmail_work)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_as: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_hint: Option<String>,
    pub why: String,
    pub abilities: Vec<Ability>,
    /// Best first. Empty when nothing here can sign it in (the card says why).
    pub options: Vec<LoginOption>,
    /// Why there's no connector, when there isn't one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_connector: Option<String>,
    /// The masked field (tier 3), when a key is a way in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<secrets::Request>,
    /// Raised for an agent an import brought in: answering doesn't wake it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub quiet: bool,
    /// The secret card an older build raised, which this one replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<Flow>,
}

impl LoginRequest {
    pub fn access(&self) -> Access {
        if self.abilities.iter().any(|a| a.id == "write") {
            Access::Full
        } else {
            Access::Read
        }
    }

    pub fn option(&self, id: &str) -> Option<&LoginOption> {
        self.options.iter().find(|o| o.id == id)
    }
}

/// What the agent asked for, before it's checked.
#[derive(Debug, Default, Clone)]
pub struct Ask {
    pub service: String,
    pub account_hint: Option<String>,
    pub scopes: Vec<String>,
    pub why: String,
    pub quiet: bool,
}

impl Ask {
    pub fn from_args(args: &Value) -> Ask {
        let s = |k: &str| {
            args.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.chars().take(300).collect::<String>())
        };
        Ask {
            service: s("service").unwrap_or_default(),
            account_hint: s("account_hint"),
            scopes: args
                .get("scopes")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            why: s("why").unwrap_or_default(),
            quiet: false,
        }
    }
}

/// Whether a scope word asks for more than reading.
fn writes(scope: &str) -> bool {
    let s = scope.trim().to_ascii_lowercase();
    !(s.is_empty()
        || s == "read"
        || s.starts_with("read")
        || s == "search"
        || s == "list"
        || s == "view")
}

/// Claude in Chrome's helper for Claude Code is installed on this Mac. It
/// says nothing about whether Chrome is open; the agent finds that out.
pub fn browser_helper_installed() -> bool {
    dirs::home_dir().is_some_and(|h| {
        h.join("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json")
            .is_file()
    })
}

/// The card for `ask` from `agent`, with the ways in this agent can use.
pub fn build(agent: &Agent, ask: &Ask) -> Result<LoginRequest, CommandError> {
    if ask.service.trim().is_empty() {
        return Err(super::err_invalid(
            "service",
            "Name the app or site, e.g. \"gmail\" or \"linkedin\".",
        ));
    }
    if ask.why.trim().is_empty() {
        return Err(super::err_invalid(
            "why",
            "Say in one line what you'll use it for: the user sees it on the card.",
        ));
    }
    let known = service(&ask.service.to_ascii_lowercase()).or_else(|| match_service(&ask.service));
    let title = known.map(|s| s.title.to_string()).unwrap_or_else(|| {
        let t: String = ask.service.trim().chars().take(40).collect();
        let mut c = t.chars();
        c.next()
            .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    });
    let wants_write = ask.scopes.iter().any(|s| writes(s));
    let mut abilities = vec![Ability {
        id: "read".into(),
        label: known
            .map(|s| s.read.to_string())
            .unwrap_or_else(|| format!("Read your {title}")),
    }];
    if wants_write {
        abilities.push(Ability {
            id: "write".into(),
            label: format!(
                "{} — it asks you on a card each time",
                known
                    .map(|s| s.write.to_string())
                    .unwrap_or_else(|| format!("Make changes in {title}"))
            ),
        });
    }
    let name = agent.name.as_str();
    let claude = agent.engine == Engine::Claude;
    let mut options = Vec::new();

    // Already connected for someone else: one click, nothing to sign in to.
    if let Some(s) = known {
        for c in connections::for_service(s.id) {
            if c.grant_for(&agent.id).is_some() || c.needs_sign_in {
                continue;
            }
            if matches!(c.kind, Kind::ClaudeAi { .. }) && !claude {
                continue;
            }
            options.push(LoginOption {
                id: format!("existing:{}", c.id),
                method: Method::Existing,
                label: format!("Use {}", c.account),
                detail: format!("Already connected. {}. {name} gets its own permission, which you can take back.", c.kept()),
                connection_id: Some(c.id.clone()),
            });
        }
    }
    let mut no_connector = None;
    match known.map(|s| s.connector).unwrap_or(Connector::None) {
        Connector::Oauth(_) => options.push(LoginOption {
            id: "oauth".into(),
            method: Method::Oauth,
            label: format!("Connect {title}"),
            detail: format!("Opens {title}'s own sign-in in this Mac's browser. The token stays in this Mac's Keychain; {name} never sees a password, and you can disconnect it any time."),
            connection_id: None,
        }),
        Connector::ClaudeAi(on) if claude => options.push(LoginOption {
            id: "claude_ai".into(),
            method: Method::ClaudeAi,
            label: format!("Connect {title}"),
            detail: format!("Uses claude.ai's {on} connector, which keeps the sign-in with your Claude account. If it isn't added yet, claude.ai opens in this Mac's browser to add it. {name} never sees a password."),
            connection_id: None,
        }),
        Connector::ClaudeAi(_) => {
            no_connector = Some(format!("{title} comes through a claude.ai connector, which only agents on Claude Code can use. {name} runs on Codex."));
        }
        Connector::Gh => options.push(LoginOption {
            id: "gh".into(),
            method: Method::Gh,
            label: "Use GitHub on this Mac".into(),
            detail: format!("Uses the GitHub CLI's sign-in on this Mac. {name} works through `gh` commands; anything that changes GitHub asks you first."),
            connection_id: None,
        }),
        Connector::None => {}
    }
    if no_connector.is_none() {
        no_connector = known
            .filter(|s| s.connector == Connector::None)
            .and_then(|s| s.why_not)
            .map(str::to_string)
            .or_else(|| {
                known
                    .is_none()
                    .then(|| format!("There's no connector for {title} here."))
            });
    }
    if let Some(site) = known.and_then(|s| s.site) {
        if claude {
            let helper = if browser_helper_installed() {
                ""
            } else {
                " It needs the Claude in Chrome extension, which isn't set up on this Mac yet."
            };
            options.push(LoginOption {
                id: "browser".into(),
                method: Method::Browser,
                label: "Use my browser".into(),
                detail: format!("{name} works in your own Chrome on this Mac, where you're already signed in to {site}, through Claude in Chrome. It asks you here before every click, post, send or payment; it never sees your password.{helper}"),
                connection_id: None,
            });
        } else if no_connector.is_some() {
            no_connector = no_connector.map(|n| {
                format!("{n} Using your browser needs Claude Code, and {name} runs on Codex.")
            });
        }
    }
    // A key only where a raw API key is a real way in, or for a service
    // nothing else here knows.
    let key_label = known
        .and_then(|s| s.key)
        .map(str::to_string)
        .or_else(|| known.is_none().then(|| "API key".to_string()));
    let key = match key_label {
        Some(label) => {
            let slug = secrets::slug(&format!(
                "{}_key",
                known.map(|s| s.id).unwrap_or(&ask.service)
            ))
            .unwrap_or_else(|| "app_key".into());
            let mut r = secrets::build_request(agent, &slug, &ask.why, "api_key", &[])?;
            r.fields[0].label = label;
            r.quiet = ask.quiet;
            options.push(LoginOption {
                id: "key".into(),
                method: Method::Key,
                label: "Enter an API key".into(),
                detail: format!("Only for a key made for apps, never a password. It goes into this Mac's Keychain; {name} gets ${}, never the value.", r.fields[0].env),
                connection_id: None,
            });
            Some(r)
        }
        None => None,
    };
    let asked_as = (!ask.service.eq_ignore_ascii_case(&title)
        && !known.is_some_and(|s| ask.service.eq_ignore_ascii_case(s.id)))
    .then(|| ask.service.clone());
    Ok(LoginRequest {
        service: known
            .map(|s| s.id.to_string())
            .unwrap_or_else(|| "other".into()),
        title,
        asked_as,
        account_hint: ask.account_hint.clone(),
        why: ask.why.trim().chars().take(300).collect(),
        abilities,
        options,
        no_connector,
        key,
        quiet: ask.quiet,
        replaces: None,
        flow: None,
    })
}

/// The card's own words: "Recruiter needs your Gmail".
pub fn title(agent: &Agent, r: &LoginRequest) -> String {
    match &r.account_hint {
        Some(hint) => format!("{} needs your {} ({hint})", agent.name, r.title),
        None => format!("{} needs your {}", agent.name, r.title),
    }
}

/// What the agent is told when the card is in its chat.
pub fn asked_reply(r: &LoginRequest) -> String {
    if r.options.is_empty() {
        return format!(
            "Asked the user about {} on a card, but nothing here can sign you in to it: {} Stop and tell them in one line; don't ask for a password.",
            r.title,
            r.no_connector.clone().unwrap_or_default()
        );
    }
    format!(
        "Asked the user to connect {} on a card in this chat. Stop here and tell them in one short line what it's for. You'll be woken when they connect it (with the tools to use) or decline. Never ask for their password.",
        r.title
    )
}

/// What the agent is told once it's connected.
pub fn connected_prompt(r: &LoginRequest, how: &str) -> String {
    format!(
        "[The user connected {} for you: {how}. Carry on with what you needed it for.]",
        r.title
    )
}

pub fn declined_prompt(r: &LoginRequest, note: Option<&str>) -> String {
    let said = note
        .map(|n| format!(" They said: \"{n}\". Do that instead."))
        .unwrap_or_else(|| " Don't ask again unless they bring it up; carry on without it, or say in one line what you can't do without it.".into());
    format!("[The user declined to connect {}.{said}]", r.title)
}

pub const RULES: &str = "\
## Logins

When you need access to an app or account (email, calendar, Slack, LinkedIn, \
X, GitHub, Linear…), ask with `request_login`: the user connects it on a card \
here, signed in on their own Mac, and you're woken with how to use it. Say \
which account if it matters (`account_hint`) and whether you only need to \
read or also to send or change things (`scopes`). Never ask for a password, \
and never ask the user to paste a login, token or code in chat. Use \
`request_secret` only for an API key made for programs, never for a \
password. Sending, posting and paying always ask the user on a card first.";

/* ---------------------------------------------------------- live state */

struct Live {
    flow: Flow,
    task: Option<tokio::task::AbortHandle>,
}

static FLOWS: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(Default::default);

fn flow_of(request_id: &str) -> Option<Flow> {
    FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(request_id)
        .map(|l| l.flow.clone())
}

/// Lay each login card's live state over it, for a page being read.
pub fn apply(page: &mut [AgentMessage]) {
    let flows = FLOWS.lock().unwrap_or_else(|e| e.into_inner());
    if flows.is_empty() {
        return;
    }
    for m in page.iter_mut() {
        if let Some(login) = m.approval.as_mut().and_then(|a| {
            let pending = a.status == ApprovalStatus::Pending;
            let id = a.request_id.clone();
            a.login.as_mut().map(|l| (l, id, pending))
        }) {
            let (l, id, pending) = login;
            l.flow = if pending {
                flows.get(&id).map(|f| f.flow.clone())
            } else {
                None
            };
        }
    }
}

/// The card as it reads now, live state included, to both devices.
fn emit_card(app: &AppHandle, agent_id: &str, request_id: &str) {
    if let Some(mut m) = store::card(agent_id, request_id) {
        apply(std::slice::from_mut(&mut m));
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
}

fn set_flow(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    flow: Flow,
    task: Option<tokio::task::AbortHandle>,
) {
    {
        let mut flows = FLOWS.lock().unwrap_or_else(|e| e.into_inner());
        let entry = flows.entry(request_id.to_string()).or_insert(Live {
            flow: flow.clone(),
            task: None,
        });
        entry.flow = flow;
        if task.is_some() {
            entry.task = task;
        }
    }
    emit_card(app, agent_id, request_id);
}

fn clear_flow(request_id: &str) {
    super::login_relay::forget_request(request_id);
    if let Some(live) = FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id)
    {
        if let Some(task) = live.task {
            task.abort();
        }
    }
}

pub(crate) fn pending_login(
    agent_id: &str,
    request_id: &str,
) -> Result<LoginRequest, CommandError> {
    let approval = store::find_approval(agent_id, request_id)?
        .ok_or_else(|| CommandError::expected("That card no longer exists."))?;
    if approval.status != ApprovalStatus::Pending {
        return Err(CommandError::expected("That card was already answered."));
    }
    approval
        .login
        .ok_or_else(|| CommandError::expected("That card isn't asking for a login."))
}

/* ------------------------------------------------------------- answers */

/// The card is done: it says how, and the agent is woken (unless quiet).
fn complete(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    r: &LoginRequest,
    said: String,
    told: String,
) -> Result<(), CommandError> {
    clear_flow(request_id);
    let card = store::answer_prompt(agent_id, request_id, ApprovalStatus::Allowed, &said)?;
    if let Some(m) = card {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    // Its other asks for the same thing (a second card, an old token card) are covered now.
    for m in retire_stale(agent_id, &r.service, request_id, &said.to_lowercase()) {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(agent_id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    if r.quiet {
        let _ = runner::record(
            app,
            runner::new_message(
                agent_id,
                MessageKind::Note,
                format!("{said}. It's used from your first message."),
            ),
        );
    } else {
        runner::enqueue(
            app,
            agent_id,
            connected_prompt(r, &told),
            runner::From::User,
        );
    }
    Ok(())
}

fn tools_line(c: &connections::Connection, access: Access) -> String {
    match c.kind {
        Kind::Gh => format!("use the `gh` command ({})", access.label().to_lowercase()),
        _ => format!(
            "its tools are named `mcp__{}__*` ({})",
            c.server_key,
            access.label().to_lowercase()
        ),
    }
}

fn connected_line(c: &connections::Connection) -> String {
    if c.account == c.title {
        format!("Connected · {}", c.title)
    } else {
        format!("Connected · {} ({})", c.title, c.account)
    }
}

/// Where a way in was started, and where its sign-in happens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Origin {
    /// Answered on the phone.
    pub from_phone: bool,
    /// The sign-in is on the phone too (its sheet, claude.ai there, a
    /// device code typed there), so this Mac's browser isn't opened.
    pub on_phone: bool,
}

impl Origin {
    pub const DESK: Origin = Origin {
        from_phone: false,
        on_phone: false,
    };
    pub fn phone(on_phone: bool) -> Origin {
        Origin {
            from_phone: true,
            on_phone,
        }
    }
}

/// One way in under way, for the card's live state.
#[derive(Clone)]
pub(crate) struct Run {
    pub app: AppHandle,
    pub agent_id: String,
    pub request_id: String,
    pub option: String,
    pub origin: Origin,
}

impl Run {
    pub fn flow(&self, state: FlowState, message: Option<String>) -> Flow {
        Flow {
            state,
            option: self.option.clone(),
            message,
            started_at: store::now_ms(),
            from_phone: self.origin.from_phone,
            on_phone: self.origin.on_phone,
            user_code: None,
            verification_uri: None,
        }
    }
    pub fn set(&self, state: FlowState, message: Option<String>) {
        self.set_flow(self.flow(state, message), None);
    }
    pub fn set_flow(&self, flow: Flow, task: Option<tokio::task::AbortHandle>) {
        set_flow(&self.app, &self.agent_id, &self.request_id, flow, task);
    }
    pub fn fail(&self, message: String) {
        // A cancel already said so.
        if matches!(
            flow_of(&self.request_id),
            Some(Flow {
                state: FlowState::Cancelled,
                ..
            })
        ) {
            return;
        }
        self.set(FlowState::Failed, Some(message));
    }
    pub fn complete(&self, r: &LoginRequest, c: &connections::Connection, access: Access) {
        let _ = complete(
            &self.app,
            &self.agent_id,
            &self.request_id,
            r,
            connected_line(c),
            tools_line(c, access),
        );
    }
}

/// A sign-in under way already (starting or waiting) on this card.
pub(crate) fn busy(request_id: &str) -> bool {
    matches!(
        flow_of(request_id),
        Some(Flow {
            state: FlowState::Starting | FlowState::Waiting,
            ..
        })
    )
}

/// A finished OAuth sign-in, from this Mac's browser or the phone's sheet:
/// the connection, its token in the Keychain, the card answered.
pub(crate) fn connect_oauth(
    run: &Run,
    r: &LoginRequest,
    server_url: &str,
    done: super::oauth::Finished,
) -> Result<connections::Connection, CommandError> {
    let access = r.access();
    let account = r.account_hint.clone().or(done.email).unwrap_or_default();
    let c = connections::add_and_grant(
        &r.service,
        &r.title,
        &account,
        Kind::Oauth {
            server_url: server_url.to_string(),
        },
        &run.agent_id,
        access,
    )?;
    connections::store_tokens(&c.id, &done.tokens)?;
    run.complete(r, &c, access);
    Ok(c)
}

/// Start the way in `option_id`. Returns at once; the card follows it on
/// every device. The sign-in runs on this Mac unless `origin.on_phone`.
pub async fn start(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    option_id: &str,
    origin: Origin,
) -> Result<(), CommandError> {
    let r = pending_login(agent_id, request_id)?;
    let option = r
        .option(option_id)
        .cloned()
        .ok_or_else(|| super::err_invalid("option", "That isn't one of this card's choices."))?;
    if busy(request_id) {
        return Err(CommandError::expected(if origin.from_phone {
            "It's already signing in."
        } else {
            "It's already signing in on your Mac."
        }));
    }
    let access = r.access();
    let run = Run {
        app: app.clone(),
        agent_id: agent_id.to_string(),
        request_id: request_id.to_string(),
        option: option.id.clone(),
        origin,
    };
    match option.method {
        Method::Key => Err(CommandError::expected(
            "Type the key into the card's field.",
        )),
        Method::Existing => {
            let id = option.connection_id.as_deref().unwrap_or_default();
            let c = connections::grant(id, agent_id, access)?;
            complete(
                app,
                agent_id,
                request_id,
                &r,
                connected_line(&c),
                tools_line(&c, access),
            )
        }
        Method::Browser => {
            let site = service(&r.service)
                .and_then(|s| s.site)
                .unwrap_or("the site");
            store::update(agent_id, |a| {
                a.reach.browser_off = false;
                if !a.reach.browser_sites.iter().any(|s| s == site) {
                    a.reach.browser_sites.push(site.to_string());
                }
            })?;
            complete(
                app,
                agent_id,
                request_id,
                &r,
                format!("Using your browser · {site}"),
                format!("use {site} in the user's own Chrome through the Claude in Chrome tools (mcp__claude-in-chrome__*), where they're already signed in. Every click, post or send asks them on a card; never type a password, and if a page asks for one, stop and tell them"),
            )
        }
        Method::Gh => {
            run.set(FlowState::Starting, None);
            if let Some(login) = gh_login().await {
                let c = connections::add_and_grant(
                    "github",
                    "GitHub",
                    &login,
                    Kind::Gh,
                    agent_id,
                    access,
                )?;
                return complete(
                    app,
                    agent_id,
                    request_id,
                    &r,
                    connected_line(&c),
                    tools_line(&c, access),
                );
            }
            // Not signed in yet: GitHub's device sign-in, through gh, so the
            // code can be typed on the phone as well as here.
            let (run2, r2) = (run.clone(), r.clone());
            let task = tokio::spawn(async move {
                match super::login_relay::gh_device(&run2).await {
                    Ok(login) => match connections::add_and_grant(
                        "github",
                        "GitHub",
                        &login,
                        Kind::Gh,
                        &run2.agent_id,
                        access,
                    ) {
                        Ok(c) => run2.complete(&r2, &c, access),
                        Err(e) => run2.fail(e.to_string()),
                    },
                    Err(e) => run2.fail(e.to_string()),
                }
            });
            run.set_flow(
                run.flow(FlowState::Starting, None),
                Some(task.abort_handle()),
            );
            Ok(())
        }
        Method::ClaudeAi => {
            let Some(Connector::ClaudeAi(name)) = service(&r.service).map(|s| s.connector) else {
                return Err(CommandError::expected(
                    "That app has no claude.ai connector.",
                ));
            };
            run.set(FlowState::Starting, None);
            let (run2, r2) = (run.clone(), r.clone());
            let task = tokio::spawn(async move {
                match watch_claude_ai(&run2, name).await {
                    Ok(server_name) => match connections::add_and_grant(
                        &r2.service,
                        &r2.title,
                        r2.account_hint.as_deref().unwrap_or(""),
                        Kind::ClaudeAi { server_name },
                        &run2.agent_id,
                        access,
                    ) {
                        Ok(c) => run2.complete(&r2, &c, access),
                        Err(e) => run2.fail(e.to_string()),
                    },
                    Err(e) => run2.fail(e.to_string()),
                }
            });
            run.set_flow(
                run.flow(FlowState::Starting, None),
                Some(task.abort_handle()),
            );
            Ok(())
        }
        Method::Oauth => {
            let Some(Connector::Oauth(url)) = service(&r.service).map(|s| s.connector) else {
                return Err(CommandError::expected("That app has no connector."));
            };
            if origin.on_phone {
                return Err(CommandError::expected(
                    "Signing in on the phone goes through its sign-in sheet.",
                ));
            }
            run.set(FlowState::Starting, None);
            let (run2, r2) = (run.clone(), r.clone());
            let task = tokio::spawn(async move {
                let outcome = async {
                    let pending = super::oauth::begin(url).await?;
                    tauri_plugin_opener::open_url(&pending.url, None::<&str>)
                        .map_err(|_| CommandError::expected("Couldn't open this Mac's browser."))?;
                    run2.set(
                        FlowState::Waiting,
                        Some(format!(
                            "{}'s sign-in is open in this Mac's browser.",
                            r2.title
                        )),
                    );
                    pending.finish().await
                }
                .await;
                match outcome.and_then(|done| connect_oauth(&run2, &r2, url, done)) {
                    Ok(_) => {}
                    Err(e) => run2.fail(e.to_string()),
                }
            });
            run.set_flow(
                run.flow(FlowState::Starting, None),
                Some(task.abort_handle()),
            );
            Ok(())
        }
    }
}

/// The GitHub account `gh` is signed in to on this Mac, if it is.
async fn gh_login() -> Option<String> {
    crate::commands::github::get_github_username(None)
        .await
        .ok()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// The claude.ai connector named `name` is connected in Claude Code: at
/// once, or after the user adds it on claude.ai (in this Mac's browser, or
/// on the phone when the sign-in is there), checked every 20 seconds for
/// up to ten minutes.
async fn watch_claude_ai(run: &Run, name: &str) -> Result<String, CommandError> {
    let wanted = format!("claude.ai {name}");
    let connected = || async {
        super::apps::list().await.ok().and_then(|apps| {
            apps.connected
                .into_iter()
                .find(|a| a.name.eq_ignore_ascii_case(&wanted) && a.status == "connected")
                .map(|a| a.name)
        })
    };
    if let Some(found) = connected().await {
        return Ok(found);
    }
    let message = if run.origin.on_phone {
        format!("Add {name} on claude.ai on your phone, signed in to the same Claude account as this Mac; this card notices when it's connected.")
    } else {
        tauri_plugin_opener::open_url(CLAUDE_AI_CONNECTORS, None::<&str>)
            .map_err(|_| CommandError::expected("Couldn't open this Mac's browser."))?;
        format!("claude.ai's connectors are open in this Mac's browser. Add {name} there; this card notices when it's connected.")
    };
    run.set(FlowState::Waiting, Some(message));
    let until = std::time::Instant::now() + super::oauth::SIGN_IN_TIMEOUT;
    while std::time::Instant::now() < until {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        if let Some(found) = connected().await {
            return Ok(found);
        }
    }
    Err(CommandError::expected(format!("{name} didn't show up as connected within ten minutes. Try again once it's added on claude.ai.")))
}

/// Where claude.ai's connectors are added (opened on the Mac, or the phone).
pub const CLAUDE_AI_CONNECTORS: &str = "https://claude.ai/settings/connectors";

/// Stop a sign-in under way. The card stays, to try again or decline.
pub fn cancel(app: &AppHandle, agent_id: &str, request_id: &str) -> Result<(), CommandError> {
    let option = flow_of(request_id).map(|f| f.option).unwrap_or_default();
    if let Some(live) = FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(request_id)
    {
        if let Some(task) = live.task.take() {
            task.abort();
        }
    }
    // A phone sign-in waiting for its code can't finish any more.
    super::login_relay::forget_request(request_id);
    set_flow(
        app,
        agent_id,
        request_id,
        Flow {
            state: FlowState::Cancelled,
            option,
            started_at: store::now_ms(),
            ..Flow::default()
        },
        None,
    );
    Ok(())
}

/// Declined: nothing is connected, and the agent is told (unless quiet).
pub fn decline(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    note: Option<&str>,
) -> Result<(), CommandError> {
    let r = pending_login(agent_id, request_id)?;
    clear_flow(request_id);
    let card = match note {
        Some(n) => store::deny_with_note(agent_id, request_id, n)?,
        None => store::set_approval_status(agent_id, request_id, ApprovalStatus::Denied)?,
    };
    if let Some(m) = card {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(agent_id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    if !r.quiet {
        runner::enqueue(app, agent_id, declined_prompt(&r, note), runner::From::User);
    }
    Ok(())
}

/// The key option's masked field, saved into the Keychain (`secrets`).
pub fn save_key(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
    value: &str,
) -> Result<secrets::Secret, CommandError> {
    let r = pending_login(agent_id, request_id)?;
    let key = r
        .key
        .clone()
        .ok_or_else(|| CommandError::expected("This card doesn't take a key."))?;
    let secret = secrets::put_for_card(agent_id, &key, &[value.to_string()])?;
    clear_flow(request_id);
    let said = format!("Saved a key · {}", secret.name);
    let card = store::answer_prompt(agent_id, request_id, ApprovalStatus::Allowed, &said)?;
    if let Some(m) = card {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(agent_id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    if r.quiet {
        let _ = runner::record(
            app,
            runner::new_message(
                agent_id,
                MessageKind::Note,
                format!("{said}. It's used from your first message."),
            ),
        );
    } else {
        runner::enqueue(
            app,
            agent_id,
            secrets::saved_prompt(&secret),
            runner::From::User,
        );
    }
    Ok(secret)
}

/// An old phone's Allow on a login card (it shows only Allow / Deny): the
/// card's first way in, started on this Mac. A key can't be typed that way.
pub async fn allow_from_old_client(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
) -> Result<(), CommandError> {
    let r = pending_login(agent_id, request_id)?;
    match r.options.iter().find(|o| o.method != Method::Key) {
        Some(o) => {
            start(
                app,
                agent_id,
                request_id,
                &o.id.clone(),
                Origin::phone(false),
            )
            .await
        }
        None => Err(CommandError::expected(
            "This card needs a key typed in. Open it on your Mac, or update the app on your phone.",
        )),
    }
}

/* --------------------------------------------------------------- cards */

/// A login card in `agent`'s chat. One per service at a time.
pub fn raise(app: &AppHandle, agent: &Agent, ask: &Ask) -> Result<String, CommandError> {
    let r = build(agent, ask)?;
    if let Some(open) = store::pending_approvals(&agent.id)
        .unwrap_or_default()
        .into_iter()
        .find(|a| {
            a.login
                .as_ref()
                .is_some_and(|l| l.service == r.service && l.title == r.title)
        })
    {
        let _ = open;
        return Ok(format!(
            "You already asked for {}; the card is still waiting in this chat. Stop here.",
            r.title
        ));
    }
    // Already granted: nothing to ask.
    if let Some((c, access)) = connections::granted_to(&agent.id)
        .into_iter()
        .find(|(c, _)| c.service == r.service && !c.needs_sign_in)
    {
        if access == Access::Full || r.access() == Access::Read {
            return Ok(format!(
                "You already have {} ({}): {}.",
                c.title,
                c.account,
                tools_line(&c, access)
            ));
        }
    }
    let reply = asked_reply(&r);
    record_card(app, agent, r)?;
    Ok(reply)
}

fn record_card(app: &AppHandle, agent: &Agent, r: LoginRequest) -> Result<(), CommandError> {
    let mut card = runner::new_message(&agent.id, MessageKind::Approval, "");
    card.approval = Some(Approval {
        request_id: store::new_id(),
        title: title(agent, &r),
        detail: r.why.clone(),
        summary: None,
        status: ApprovalStatus::Pending,
        tool: None,
        input: None,
        always: None,
        always_allowed: false,
        note: None,
        prompt: None,
        choice: None,
        secret: None,
        connector: None,
        set_aside: None,
        login: Some(r),
    });
    runner::record_own(app, card)?;
    store::refresh_pending(&agent.id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    Ok(())
}

/// A secret request an older build (or an import) would have raised, as a
/// login card when the name means a service with a connector or a site.
/// `None` keeps it a secret card: a real API key, or a service we don't know.
pub fn from_secret(agent: &Agent, request: &secrets::Request) -> Option<LoginRequest> {
    let text = format!("{} {}", request.name, request.purpose);
    // By its name only: a purpose names where the work goes ("an OpenAI
    // key, to summarise into Notion"), not what the credential is for.
    let s = match_service(&request.name)?;
    let has_way = s.connector != Connector::None || s.site.is_some();
    if !has_way {
        return None;
    }
    // "Stripe key" really is an API key: leave it be.
    if s.key.is_some() && matches!(request.kind, secrets::Kind::ApiKey) {
        return None;
    }
    let pretty = request.name.replace('_', " ");
    let ask = Ask {
        service: s.id.into(),
        account_hint: None,
        scopes: if writes_in(&text) {
            vec!["write".into()]
        } else {
            vec!["read".into()]
        },
        why: request.purpose.clone(),
        quiet: request.quiet,
    };
    let mut r = build(agent, &ask).ok()?;
    if !pretty.eq_ignore_ascii_case(s.title) {
        r.asked_as = Some(pretty);
    }
    Some(r)
}

fn writes_in(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    [
        "send", "post", "reply", "publish", "write", "tweet", "message", "schedule",
    ]
    .iter()
    .any(|w| t.contains(w))
}

/// Move every pending secret card that has a better way in onto a login
/// card. Idempotent: a moved card is no longer pending. Returns how many.
pub fn migrate_pending(app: Option<&AppHandle>) -> usize {
    let Ok(agents) = store::list() else { return 0 };
    let mut moved = 0;
    for agent in agents {
        let Ok(open) = store::pending_approvals(&agent.id) else {
            continue;
        };
        for approval in open {
            let Some(secret) = approval.secret.as_ref() else {
                continue;
            };
            let Some(mut login) = from_secret(&agent, secret) else {
                continue;
            };
            // A second old card for the same service (a LinkedIn token and a
            // LinkedIn password) folds into the login card already there.
            let already = store::pending_approvals(&agent.id)
                .unwrap_or_default()
                .into_iter()
                .any(|a| a.login.as_ref().is_some_and(|l| l.service == login.service));
            if already {
                let note = format!(
                    "Moved to the sign-in card for {}: no password needed.",
                    login.title
                );
                if let Ok(Some(old)) =
                    store::expire_with_note(&agent.id, &approval.request_id, &note)
                {
                    if let Some(app) = app {
                        let _ = app.emit(runner::EVENT_MESSAGE, &old);
                    }
                }
                store::refresh_pending(&agent.id);
                moved += 1;
                continue;
            }
            login.replaces = Some(approval.request_id.clone());
            let text = format!(
                "Moved to a sign-in card for {}: no password needed.",
                login.title
            );
            let mut card = runner::new_message(&agent.id, MessageKind::Approval, "");
            card.approval = Some(Approval {
                request_id: store::new_id(),
                title: title(&agent, &login),
                detail: login.why.clone(),
                summary: None,
                status: ApprovalStatus::Pending,
                tool: None,
                input: None,
                always: None,
                always_allowed: false,
                note: None,
                prompt: None,
                choice: None,
                secret: None,
                connector: None,
                set_aside: None,
                login: Some(login),
            });
            let new = match app {
                Some(app) => runner::record_own(app, card).map(|_| ()),
                None => store::append_message(&secrets::redact_message(card)),
            };
            if new.is_err() {
                continue;
            }
            // Expired, not declined: the user never said no.
            if let Ok(Some(old)) = store::expire_with_note(&agent.id, &approval.request_id, &text) {
                if let Some(app) = app {
                    let _ = app.emit(runner::EVENT_MESSAGE, &old);
                }
            }
            store::refresh_pending(&agent.id);
            moved += 1;
        }
    }
    if moved > 0 {
        tracing::info!("[Agents] moved {moved} secret card(s) onto login cards");
        if let Some(app) = app {
            super::notify::refresh_badge(app);
            let _ = app.emit(runner::EVENT_REGISTRY, ());
        }
    }
    moved
}

/* ------------------------------------------- what your team needs */

/// Services one sign-in page covers, shown as one row: Gmail, Calendar and
/// Drive are each their own connector, but the user adds them in one visit
/// to claude.ai, so they're asked for together.
pub fn family(service: &str) -> (&'static str, &'static str) {
    match service {
        "gmail" | "google_calendar" | "google_drive" => ("google", "Google"),
        _ => ("", ""),
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CardState {
    Waiting,
    Connected,
    /// Declined, or "Not needed".
    Skipped,
    /// Replaced by another card or a connection that covers it.
    Covered,
}

/// One agent's ask, on its row.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamCard {
    pub agent_id: String,
    pub agent_name: String,
    pub request_id: String,
    pub service: String,
    pub title: String,
    /// What it asked to do, in words ("Read and search your email").
    pub abilities: Vec<Ability>,
    pub state: CardState,
    /// How it was answered ("Connected · Gmail (work@acme.com)").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asked_as: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<Flow>,
}

/// One row of "What your team needs": a service (or a family of them),
/// every agent that asked for it, and one way in for all of them.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamNeed {
    /// The service id, or the family's ("google").
    pub key: String,
    /// "Google · Gmail + Calendar", "LinkedIn".
    pub title: String,
    pub services: Vec<String>,
    /// The ways in, best first, from the cards still waiting. An `existing`
    /// option is left out: it's per agent.
    pub options: Vec<LoginOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_connector: Option<String>,
    pub cards: Vec<TeamCard>,
    /// Every card on the row is answered one way or another.
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamLogins {
    pub needs: Vec<TeamNeed>,
    /// Rows done, of rows: "4 of 9 connected".
    pub done: usize,
    pub total: usize,
}

fn card_state(a: &Approval) -> CardState {
    match a.status {
        ApprovalStatus::Pending => CardState::Waiting,
        ApprovalStatus::Allowed => CardState::Connected,
        ApprovalStatus::Denied => CardState::Skipped,
        ApprovalStatus::Expired => CardState::Covered,
    }
}

/// Every login card waiting (and, with `since`, those answered since then,
/// for the progress line), one row per service: the screen that gives the
/// whole team what it needs in one place.
pub fn team(since: Option<i64>) -> TeamLogins {
    let flows: HashMap<String, Flow> = FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(k, v)| (k.clone(), v.flow.clone()))
        .collect();
    let mut needs: Vec<TeamNeed> = Vec::new();
    for agent in store::list().unwrap_or_default() {
        for m in store::login_cards(&agent.id) {
            let Some(a) = m.approval else { continue };
            let Some(l) = a.login.clone() else { continue };
            let state = card_state(&a);
            if state != CardState::Waiting && since.is_none_or(|t| m.ts < t) {
                continue;
            }
            let (fam, fam_title) = family(&l.service);
            let key = if fam.is_empty() {
                l.service.clone()
            } else {
                fam.to_string()
            };
            let card = TeamCard {
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                request_id: a.request_id.clone(),
                service: l.service.clone(),
                title: l.title.clone(),
                abilities: l.abilities.clone(),
                state,
                outcome: a.choice.clone().or(a.note.clone()),
                asked_as: l.asked_as.clone(),
                flow: (state == CardState::Waiting)
                    .then(|| flows.get(&a.request_id).cloned())
                    .flatten(),
            };
            let shared: Vec<LoginOption> = l
                .options
                .iter()
                .filter(|o| o.method != Method::Existing)
                .cloned()
                .collect();
            let need = match needs.iter_mut().find(|n| n.key == key) {
                Some(n) => n,
                None => {
                    needs.push(TeamNeed {
                        key: key.clone(),
                        title: if fam.is_empty() {
                            l.title.clone()
                        } else {
                            fam_title.to_string()
                        },
                        services: Vec::new(),
                        options: Vec::new(),
                        no_connector: None,
                        cards: Vec::new(),
                        done: false,
                    });
                    needs.last_mut().unwrap()
                }
            };
            if !need.services.contains(&l.service) {
                need.services.push(l.service.clone());
            }
            if state == CardState::Waiting {
                // The union of ways in, in the order they're best.
                for o in shared {
                    if !need.options.iter().any(|x| x.id == o.id) {
                        need.options.push(o);
                    }
                }
                if need.no_connector.is_none() {
                    need.no_connector = l.no_connector.clone();
                }
            }
            // The same ask from one agent twice (two old secret cards for
            // LinkedIn) is one line: the waiting one wins.
            match need
                .cards
                .iter_mut()
                .find(|c| c.agent_id == card.agent_id && c.service == card.service)
            {
                Some(existing)
                    if existing.state != CardState::Waiting && card.state == CardState::Waiting =>
                {
                    *existing = card
                }
                Some(_) => {}
                None => need.cards.push(card),
            }
        }
    }
    let rank = |m: Method| match m {
        Method::Oauth | Method::ClaudeAi | Method::Gh => 0,
        Method::Browser => 1,
        Method::Key => 2,
        Method::Existing => 3,
    };
    for n in &mut needs {
        n.options.sort_by_key(|o| rank(o.method));
        n.done = n.cards.iter().all(|c| c.state != CardState::Waiting);
        if n.services.len() > 1 {
            let names: Vec<&str> = n
                .services
                .iter()
                .filter_map(|s| service(s))
                .map(|s| s.title.trim_start_matches("Google "))
                .collect();
            n.title = format!("{} · {}", n.title, names.join(" + "));
        }
    }
    // Waiting rows first; within each, as the cards came in.
    needs.sort_by_key(|n| n.done);
    let done = needs.iter().filter(|n| n.done).count();
    TeamLogins {
        total: needs.len(),
        done,
        needs,
    }
}

/// Connect a row once for every agent waiting on it. A connector signs in
/// once (on this Mac) for the first card of each service on the row, and
/// the rest of that service's cards are granted the same connection as
/// soon as it's there. The browser is per agent, so it's given to each.
/// `skip` names agents the user unticked: they're left waiting.
pub async fn connect_need(
    app: &AppHandle,
    key: &str,
    option_id: &str,
    skip: &[String],
    origin: Origin,
) -> Result<(), CommandError> {
    let need = team(None)
        .needs
        .into_iter()
        .find(|n| n.key == key)
        .ok_or_else(|| CommandError::expected("Nothing is waiting for that any more."))?;
    let option = need
        .options
        .iter()
        .find(|o| o.id == option_id)
        .cloned()
        .ok_or_else(|| super::err_invalid("option", "That isn't one of this row's choices."))?;
    let waiting: Vec<TeamCard> = need
        .cards
        .into_iter()
        .filter(|c| c.state == CardState::Waiting && !skip.contains(&c.agent_id))
        .collect();
    if option.method == Method::Browser {
        for card in &waiting {
            // A card that can't use the browser (Codex) is left for its own chat.
            if pending_login(&card.agent_id, &card.request_id)
                .is_ok_and(|r| r.option("browser").is_some())
            {
                let _ = start(app, &card.agent_id, &card.request_id, "browser", origin).await;
            }
        }
        return Ok(());
    }
    if option.method == Method::Key {
        return Err(CommandError::expected(
            "A key is typed into each agent's own card.",
        ));
    }
    for service_id in &need.services {
        let cards: Vec<TeamCard> = waiting
            .iter()
            .filter(|c| &c.service == service_id)
            .cloned()
            .collect();
        let Some(first) = cards
            .iter()
            .find(|c| {
                pending_login(&c.agent_id, &c.request_id)
                    .is_ok_and(|r| r.option(&option.id).is_some())
            })
            .cloned()
        else {
            continue;
        };
        start(app, &first.agent_id, &first.request_id, &option.id, origin).await?;
        let rest: Vec<TeamCard> = cards
            .into_iter()
            .filter(|c| c.request_id != first.request_id)
            .collect();
        if rest.is_empty() {
            continue;
        }
        fan_out(app, service_id, first, rest);
    }
    Ok(())
}

/// Once `first`'s card is connected, `rest` (the same service's other
/// waiting cards on a team row) are granted the same connection.
pub(crate) fn fan_out(app: &AppHandle, service_id: &str, first: TeamCard, rest: Vec<TeamCard>) {
    if rest.is_empty() {
        return;
    }
    let (app, service_id) = (app.clone(), service_id.to_string());
    tokio::spawn(async move {
        // Once the first card is connected, the others use its connection.
        for _ in 0..(11 * 60) {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let state = store::find_approval(&first.agent_id, &first.request_id)
                .ok()
                .flatten()
                .map(|a| a.status);
            match state {
                Some(ApprovalStatus::Pending) => {
                    if matches!(
                        flow_of(&first.request_id),
                        Some(Flow {
                            state: FlowState::Failed | FlowState::Cancelled,
                            ..
                        })
                    ) {
                        return;
                    }
                    continue;
                }
                Some(ApprovalStatus::Allowed) => {}
                _ => return,
            }
            let Some(c) = connections::for_service(&service_id)
                .into_iter()
                .find(|c| c.grant_for(&first.agent_id).is_some())
            else {
                return;
            };
            for card in &rest {
                let Ok(r) = pending_login(&card.agent_id, &card.request_id) else {
                    continue;
                };
                if let Ok(c) = connections::grant(&c.id, &card.agent_id, r.access()) {
                    let _ = complete(
                        &app,
                        &card.agent_id,
                        &card.request_id,
                        &r,
                        connected_line(&c),
                        tools_line(&c, r.access()),
                    );
                }
            }
            return;
        }
    });
}

/// "Not needed": the card is put away without connecting anything, and the
/// agent isn't woken. If it really needs it, it asks again.
pub fn dismiss(app: &AppHandle, agent_id: &str, request_id: &str) -> Result<(), CommandError> {
    pending_login(agent_id, request_id)?;
    clear_flow(request_id);
    if let Some(m) = store::deny_with_note(agent_id, request_id, NOT_NEEDED)? {
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(agent_id);
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    Ok(())
}

pub const NOT_NEEDED: &str = "Not needed";

/// After `agent_id` got `service` one way, its other asks for the same
/// thing are stale: another login card for it, or an old secret card
/// (an X token when it now posts through the browser). Each is marked
/// expired with a line saying what covers it. Returns the cards it put away.
pub fn retire_stale(agent_id: &str, service_id: &str, keep: &str, how: &str) -> Vec<AgentMessage> {
    let mut out = Vec::new();
    for a in store::pending_approvals(agent_id).unwrap_or_default() {
        if a.request_id == keep {
            continue;
        }
        let same = match (&a.login, &a.secret) {
            (Some(l), _) => l.service == service_id,
            (None, Some(s)) => {
                let text = format!("{} {}", s.name, s.purpose);
                match_service(&s.name)
                    .or_else(|| match_service(&text))
                    .is_some_and(|x| x.id == service_id)
            }
            _ => false,
        };
        if same {
            clear_flow(&a.request_id);
            if let Ok(Some(m)) = store::expire_with_note(
                agent_id,
                &a.request_id,
                &format!("Not needed any more: {how}."),
            ) {
                out.push(m);
            }
        }
    }
    if !out.is_empty() {
        store::refresh_pending(agent_id);
    }
    out
}

/* ------------------------------------------------ what it can reach */

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachConnection {
    pub connection_id: String,
    pub service: String,
    pub title: String,
    pub account: String,
    pub access: Access,
    pub kept: String,
    pub needs_sign_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachBrowser {
    /// Claude in Chrome is offered to its turns (Claude Code only).
    pub on: bool,
    pub sites: Vec<String>,
    pub helper_installed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachSecret {
    pub secret_id: String,
    pub name: String,
    pub purpose: String,
    pub variables: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

/// Everything one agent can reach, for "What it can reach".
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    pub connections: Vec<ReachConnection>,
    /// `None` on Codex, which has no browser.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser: Option<ReachBrowser>,
    pub secrets: Vec<ReachSecret>,
    /// Claude Code apps this agent is kept from (by name in Claude Code).
    pub blocked_apps: Vec<String>,
}

pub fn reach(agent: &Agent) -> Reach {
    Reach {
        connections: connections::granted_to(&agent.id)
            .into_iter()
            .map(|(c, access)| ReachConnection {
                kept: c.kept().to_string(),
                connection_id: c.id,
                service: c.service,
                title: c.title,
                account: c.account,
                access,
                needs_sign_in: c.needs_sign_in,
                last_used_at: c.last_used_at,
            })
            .collect(),
        browser: (agent.engine == Engine::Claude).then(|| ReachBrowser {
            on: !agent.reach.browser_off,
            sites: agent.reach.browser_sites.clone(),
            helper_installed: browser_helper_installed(),
        }),
        secrets: agent
            .secrets
            .iter()
            .map(|s| ReachSecret {
                secret_id: s.id.clone(),
                name: s.name.clone(),
                purpose: s.purpose.clone(),
                variables: s.fields.iter().map(|f| format!("${}", f.env)).collect(),
                last_used_at: s.last_used_at,
            })
            .collect(),
        blocked_apps: agent.reach.blocked_apps.clone(),
    }
}

/// One thing taken away, from "What it can reach".
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Removal {
    #[serde(rename_all = "camelCase")]
    Connection {
        connection_id: String,
    },
    Browser,
    #[serde(rename_all = "camelCase")]
    BrowserSite {
        site: String,
    },
    #[serde(rename_all = "camelCase")]
    Secret {
        secret_id: String,
    },
    /// Keep a Claude Code app (every agent's) from this agent.
    #[serde(rename_all = "camelCase")]
    BlockApp {
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    UnblockApp {
        name: String,
    },
}

pub fn remove(agent_id: &str, removal: &Removal) -> Result<Reach, CommandError> {
    match removal {
        Removal::Connection { connection_id } => connections::revoke(connection_id, agent_id)?,
        Removal::Browser => {
            store::update(agent_id, |a| {
                a.reach.browser_off = true;
                a.reach.browser_sites.clear();
            })?;
        }
        Removal::BrowserSite { site } => {
            store::update(agent_id, |a| a.reach.browser_sites.retain(|s| s != site))?;
        }
        Removal::Secret { secret_id } => secrets::revoke(agent_id, secret_id)?,
        Removal::BlockApp { name } => {
            let name = name.trim().chars().take(120).collect::<String>();
            if name.is_empty() {
                return Err(super::err_invalid("name", "Which app?"));
            }
            store::update(agent_id, |a| {
                if !a.reach.blocked_apps.contains(&name) {
                    a.reach.blocked_apps.push(name);
                }
            })?;
        }
        Removal::UnblockApp { name } => {
            store::update(agent_id, |a| a.reach.blocked_apps.retain(|n| n != name))?;
        }
    }
    Ok(reach(&store::get(agent_id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_root<F: FnOnce()>(f: F) {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        store::set_root_for_tests(None);
    }

    fn agent(name: &str, engine: Engine) -> Agent {
        let a = store::create(store::NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        store::update(&a.id, |x| x.engine = engine).unwrap()
    }

    fn ask(service: &str, scopes: &[&str]) -> Ask {
        Ask {
            service: service.into(),
            account_hint: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            why: "Screen candidates".into(),
            quiet: false,
        }
    }

    #[test]
    fn free_text_names_find_their_service() {
        let id = |t: &str| match_service(t).map(|s| s.id);
        assert_eq!(id("Work Gmail inbox (gmail_work)"), Some("gmail"));
        assert_eq!(id("gmail_work"), Some("gmail"));
        assert_eq!(id("linkedin_token"), Some("linkedin"));
        assert_eq!(id("x_api_token"), Some("x"));
        assert_eq!(id("Twitter login"), Some("x"));
        assert_eq!(id("Slack workspace"), Some("slack"));
        assert_eq!(id("google_calendar"), Some("google_calendar"));
        assert_eq!(id("Acme Community Slack"), Some("slack"));
        assert_eq!(id("Acme OS recruiting tools"), None);
        assert_eq!(id("excel exports"), None, "whole words only");
        assert_eq!(id("GitHub token"), Some("github"));
    }

    #[test]
    fn the_card_puts_the_best_way_first_and_never_a_password() {
        with_root(|| {
            let recruiter = agent("Recruiter", Engine::Claude);
            let gmail = build(&recruiter, &ask("gmail", &["read", "send"])).unwrap();
            assert_eq!(gmail.options[0].method, Method::ClaudeAi);
            assert_eq!(gmail.options[1].method, Method::Browser);
            assert!(gmail.key.is_none(), "no password field for Gmail");
            assert_eq!(gmail.access(), Access::Full);
            assert!(gmail.abilities[1].label.contains("asks you"));

            let linear = build(&recruiter, &ask("linear", &[])).unwrap();
            assert_eq!(linear.options[0].method, Method::Oauth);
            assert_eq!(linear.access(), Access::Read);

            let linkedin = build(&recruiter, &ask("LinkedIn", &["post"])).unwrap();
            assert_eq!(linkedin.options[0].method, Method::Browser);
            assert!(linkedin
                .no_connector
                .as_deref()
                .unwrap()
                .contains("no connector"));

            let x = build(&recruiter, &ask("x", &["post"])).unwrap();
            assert_eq!(
                x.options.iter().map(|o| o.method).collect::<Vec<_>>(),
                vec![Method::Browser, Method::Key]
            );
            assert_eq!(x.key.as_ref().unwrap().kind, secrets::Kind::ApiKey);

            let unknown = build(&recruiter, &ask("Acme OS recruiting tools", &[])).unwrap();
            assert_eq!(unknown.service, "other");
            assert_eq!(
                unknown.options.iter().map(|o| o.method).collect::<Vec<_>>(),
                vec![Method::Key]
            );
            assert!(unknown.no_connector.is_some());

            assert!(build(
                &recruiter,
                &Ask {
                    why: " ".into(),
                    ..ask("gmail", &[])
                }
            )
            .is_err());
        });
    }

    #[test]
    fn codex_agents_are_told_plainly_what_they_cant_use() {
        with_root(|| {
            let codex = agent("Posts", Engine::Codex);
            let gmail = build(&codex, &ask("gmail", &[])).unwrap();
            assert!(gmail.options.is_empty());
            assert!(gmail.no_connector.as_deref().unwrap().contains("Codex"));
            assert!(asked_reply(&gmail).contains("don't ask for a password"));
            let linear = build(&codex, &ask("linear", &[])).unwrap();
            assert_eq!(
                linear.options[0].method,
                Method::Oauth,
                "our own connector works on either engine"
            );
        });
    }

    #[test]
    fn an_account_connected_for_another_agent_is_one_click() {
        with_root(|| {
            let recruiter = agent("Recruiter", Engine::Claude);
            let social = agent("Social", Engine::Claude);
            connections::add_and_grant(
                "gmail",
                "Gmail",
                "work@acme.com",
                Kind::ClaudeAi {
                    server_name: "claude.ai Gmail".into(),
                },
                &recruiter.id,
                Access::Read,
            )
            .unwrap();
            let card = build(&social, &ask("gmail", &[])).unwrap();
            assert_eq!(card.options[0].method, Method::Existing);
            assert_eq!(card.options[0].label, "Use work@acme.com");
            // The agent it's already granted to isn't offered it again.
            let again = build(&recruiter, &ask("gmail", &[])).unwrap();
            assert!(again.options.iter().all(|o| o.method != Method::Existing));
        });
    }

    fn old_secret_card(
        agent: &Agent,
        name: &str,
        purpose: &str,
        kind: &str,
        quiet: bool,
    ) -> String {
        let mut request = secrets::build_request(agent, name, purpose, kind, &[]).unwrap();
        request.quiet = quiet;
        let mut card = runner::new_message(&agent.id, MessageKind::Approval, "");
        let id = store::new_id();
        card.approval = Some(Approval {
            request_id: id.clone(),
            title: format!("Secure input · {name}"),
            detail: purpose.into(),
            summary: None,
            status: ApprovalStatus::Pending,
            tool: None,
            input: None,
            always: None,
            always_allowed: false,
            note: None,
            prompt: None,
            choice: None,
            secret: Some(request),
            set_aside: None,
            connector: None,
            login: None,
        });
        // Written the way an older build wrote it: no `login` key at all.
        let line = serde_json::to_string(&card).unwrap();
        assert!(!line.contains("\"login\""));
        store::append_message(&card).unwrap();
        id
    }

    #[test]
    fn pending_secret_cards_from_an_older_build_become_login_cards_once() {
        with_root(|| {
            let recruiter = agent("Recruiter", Engine::Claude);
            let social = agent("Publicist", Engine::Claude);
            let finance = agent("Finance", Engine::Claude);
            let gmail = old_secret_card(
                &recruiter,
                "gmail_work",
                "Work Gmail inbox (gmail_work)",
                "token",
                true,
            );
            let os = old_secret_card(
                &recruiter,
                "acme_os",
                "Acme OS recruiting tools",
                "password",
                true,
            );
            let li = old_secret_card(
                &social,
                "linkedin_token",
                "Post to LinkedIn",
                "token",
                false,
            );
            let li2 = old_secret_card(
                &social,
                "linkedin_password",
                "LinkedIn login",
                "password",
                false,
            );
            let stripe = old_secret_card(
                &finance,
                "stripe_key",
                "Reconcile payouts",
                "api_key",
                false,
            );
            let openai = old_secret_card(
                &finance,
                "openai_key",
                "Summarise the books into Notion and Slack",
                "api_key",
                false,
            );

            assert_eq!(migrate_pending(None), 3);
            assert_eq!(migrate_pending(None), 0, "idempotent");

            let open = store::pending_approvals(&recruiter.id).unwrap();
            let login = open
                .iter()
                .find_map(|a| a.login.clone())
                .expect("a login card");
            assert_eq!(login.service, "gmail");
            assert_eq!(login.replaces.as_deref(), Some(gmail.as_str()));
            assert!(login.quiet, "an import's card stays quiet");
            assert_eq!(login.asked_as.as_deref(), Some("gmail work"));
            let old = store::find_approval(&recruiter.id, &gmail)
                .unwrap()
                .unwrap();
            assert_eq!(old.status, ApprovalStatus::Expired);
            // Not a service: stays a secret card.
            assert_eq!(
                store::find_approval(&recruiter.id, &os)
                    .unwrap()
                    .unwrap()
                    .status,
                ApprovalStatus::Pending
            );
            // A key named for something else isn't moved by its purpose.
            assert_eq!(
                store::find_approval(&finance.id, &openai)
                    .unwrap()
                    .unwrap()
                    .status,
                ApprovalStatus::Pending
            );
            // A real API key stays a key.
            assert_eq!(
                store::find_approval(&finance.id, &stripe)
                    .unwrap()
                    .unwrap()
                    .status,
                ApprovalStatus::Pending
            );

            let social_login = store::pending_approvals(&social.id)
                .unwrap()
                .into_iter()
                .find_map(|a| a.login)
                .unwrap();
            assert_eq!(social_login.service, "linkedin");
            assert_eq!(social_login.access(), Access::Full, "it posts");
            assert!(!social_login.quiet);
            assert_eq!(
                store::find_approval(&social.id, &li)
                    .unwrap()
                    .unwrap()
                    .status,
                ApprovalStatus::Expired
            );
            // Its second LinkedIn card folded into the same login card.
            assert_eq!(
                store::find_approval(&social.id, &li2)
                    .unwrap()
                    .unwrap()
                    .status,
                ApprovalStatus::Expired
            );
            assert_eq!(store::pending_approvals(&social.id).unwrap().len(), 1);
            assert_eq!(store::get(&recruiter.id).unwrap().pending_approvals, 2);

            // "What your team needs" sees one row per service.
            let t = team(None);
            assert_eq!(
                t.needs.iter().map(|n| n.key.as_str()).collect::<Vec<_>>(),
                vec!["google", "linkedin"]
            );
            assert_eq!((t.done, t.total), (0, 2));
        });
    }

    #[test]
    fn a_login_card_round_trips_and_old_data_loads() {
        with_root(|| {
            let recruiter = agent("Recruiter", Engine::Claude);
            let r = build(&recruiter, &ask("linear", &["write"])).unwrap();
            let v = serde_json::to_value(&r).unwrap();
            assert_eq!(v["options"][0]["method"], "oauth");
            assert!(v.get("flow").is_none(), "live state is never stored");
            let back: LoginRequest = serde_json::from_value(v).unwrap();
            assert_eq!(back, r);
            // An agent written before `reach` existed loads with defaults.
            let old: Agent = serde_json::from_value(serde_json::json!({"id": "a1", "name": "Old", "shape": 0, "color": "red", "createdAt": 0})).unwrap();
            assert!(!old.reach.browser_off);
            assert!(
                serde_json::to_value(&old).unwrap().get("reach").is_none(),
                "nothing new written for an untouched agent"
            );
        });
    }

    #[test]
    fn what_it_can_reach_lists_and_removes_each_thing() {
        with_root(|| {
            let recruiter = agent("Recruiter", Engine::Claude);
            let c = connections::add_and_grant(
                "linear",
                "Linear",
                "",
                Kind::Oauth {
                    server_url: "https://mcp.linear.app/mcp".into(),
                },
                &recruiter.id,
                Access::Read,
            )
            .unwrap();
            store::update(&recruiter.id, |a| {
                a.reach.browser_sites.push("www.linkedin.com".into())
            })
            .unwrap();
            let r = reach(&store::get(&recruiter.id).unwrap());
            assert_eq!(r.connections.len(), 1);
            assert!(r.browser.as_ref().unwrap().on);
            let r = remove(
                &recruiter.id,
                &Removal::Connection {
                    connection_id: c.id.clone(),
                },
            )
            .unwrap();
            assert!(r.connections.is_empty());
            let r = remove(&recruiter.id, &Removal::Browser).unwrap();
            assert!(!r.browser.unwrap().on);
            let r = remove(
                &recruiter.id,
                &Removal::BlockApp {
                    name: "claude.ai Gmail".into(),
                },
            )
            .unwrap();
            assert_eq!(r.blocked_apps, vec!["claude.ai Gmail".to_string()]);
            let removal: Removal = serde_json::from_value(
                serde_json::json!({"kind": "connection", "connectionId": "x"}),
            )
            .unwrap();
            assert_eq!(
                removal,
                Removal::Connection {
                    connection_id: "x".into()
                }
            );
            // Never a token in what's shown.
            assert!(!serde_json::to_string(&r)
                .unwrap()
                .to_lowercase()
                .contains("token\":"));
        });
    }

    fn raise_quiet(a: &Agent, s: &str) -> String {
        let r = build(
            a,
            &Ask {
                quiet: true,
                ..ask(s, &["read"])
            },
        )
        .unwrap();
        let mut card = runner::new_message(&a.id, MessageKind::Approval, "");
        let id = store::new_id();
        card.approval = Some(Approval {
            request_id: id.clone(),
            title: title(a, &r),
            detail: r.why.clone(),
            summary: None,
            status: ApprovalStatus::Pending,
            tool: None,
            input: None,
            always: None,
            always_allowed: false,
            note: None,
            prompt: None,
            choice: None,
            secret: None,
            connector: None,
            set_aside: None,
            login: Some(r),
        });
        store::append_message(&card).unwrap();
        store::refresh_pending(&a.id);
        id
    }

    #[test]
    fn the_team_list_is_one_row_per_service_with_every_agent_on_it() {
        with_root(|| {
            let recruiter = agent("Recruiter", Engine::Claude);
            let inbox = agent("Mailroom", Engine::Claude);
            let cal = agent("Calendar", Engine::Claude);
            let devs: Vec<Agent> = ["Site", "Docs", "Release"]
                .iter()
                .map(|n| agent(n, Engine::Claude))
                .collect();
            raise_quiet(&recruiter, "gmail");
            raise_quiet(&inbox, "gmail");
            let dropped = raise_quiet(&cal, "google_calendar");
            for d in &devs {
                raise_quiet(d, "github");
            }
            let t = team(None);
            assert_eq!(t.total, 2);
            let google = t.needs.iter().find(|n| n.key == "google").unwrap();
            assert_eq!(google.title, "Google · Gmail + Calendar");
            assert_eq!(
                google
                    .cards
                    .iter()
                    .map(|c| c.agent_name.as_str())
                    .collect::<Vec<_>>(),
                vec!["Recruiter", "Mailroom", "Calendar"]
            );
            assert_eq!(google.options[0].method, Method::ClaudeAi);
            let gh = t.needs.iter().find(|n| n.key == "github").unwrap();
            assert_eq!(
                gh.cards.len(),
                3,
                "three agents asking for the same thing is one row"
            );
            assert_eq!(
                gh.options.iter().filter(|o| o.method == Method::Gh).count(),
                1
            );

            // "Not needed" on one; progress counts rows fully answered.
            let started = store::now_ms() - 60_000;
            store::deny_with_note(&cal.id, &dropped, NOT_NEEDED).unwrap();
            for d in &devs {
                for a in store::pending_approvals(&d.id).unwrap() {
                    store::answer_prompt(
                        &d.id,
                        &a.request_id,
                        ApprovalStatus::Allowed,
                        "Connected",
                    )
                    .unwrap();
                }
            }
            let t = team(Some(started));
            assert_eq!((t.done, t.total), (1, 2));
            let google = t.needs.iter().find(|n| n.key == "google").unwrap();
            assert_eq!(
                google
                    .cards
                    .iter()
                    .find(|c| c.agent_name == "Calendar")
                    .unwrap()
                    .state,
                CardState::Skipped
            );
            assert!(!google.done);
            assert!(t.needs.last().unwrap().done, "done rows sort last");
            // Without `since`, only what's still waiting.
            assert_eq!(team(None).total, 1);
        });
    }

    #[test]
    fn getting_a_service_one_way_retires_its_other_asks() {
        with_root(|| {
            let social = agent("Publicist", Engine::Claude);
            let token = old_secret_card(&social, "x_api_token", "Post to X", "api_key", false);
            let keep = raise_quiet(&social, "x");
            let retired = retire_stale(&social.id, "x", &keep, "uses your browser");
            assert_eq!(retired.len(), 1);
            let old = store::find_approval(&social.id, &token).unwrap().unwrap();
            assert_eq!(old.status, ApprovalStatus::Expired);
            assert!(old.note.unwrap().contains("uses your browser"));
            assert_eq!(
                store::find_approval(&social.id, &keep)
                    .unwrap()
                    .unwrap()
                    .status,
                ApprovalStatus::Pending
            );
        });
    }
}
