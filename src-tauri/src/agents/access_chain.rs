//! The access chain: an agent that needs an app "just tries" before it asks.
//!
//! `request_login` doesn't go straight to a card. In order, per task:
//!
//! 1. **The user already said no** to that service, for anyone on the team
//!    (declined, or "Not needed"): no second ask. The agent is told to carry
//!    on without it.
//! 2. **It already has it**: one of our own working connections granted to
//!    it (OAuth, `gh`). A claude.ai connector is an optional extra, never
//!    counted here: the browser comes first.
//! 3. **This Mac is signed in already**: GitHub through `gh`. The agent works
//!    through `gh`, whose commands still ask through the approval broker.
//! 4. **A browser**: for a site, the agents' own browser first
//!    (`agent_browser`, either engine), unless this turn has Claude in
//!    Chrome (`browser::for_turn`) and the site is Google's, Slack's, X's,
//!    LinkedIn's or Grok's ([`users_chrome_first`]: Google refuses a
//!    sign-in in a driven browser) or was last found signed in only in the
//!    user's personal Chrome; then that. A sign-in page in the agents' browser
//!    (`signed_out`) moves the agent to the user's Chrome at once. Never for
//!    outside text. The site is given to the agent and it's told to open it
//!    and say which account it's in. Only when no browser is left
//!    (`signed_out` in the user's Chrome, `browser: "chrome"`, or with no
//!    Chrome) does it get a card, which offers "Sign in from here" first.
//!    A plain Deny on an import's quiet card doesn't stop the user's Chrome.
//! 4b. **A teammate already has it** through the app (a working connection
//!    granted to them, or its connector in their engine;
//!    `team_reach::holders`): the Chief is told to hand the work to them
//!    with `message_agent`, and no card is raised. Only the Chief, whose job
//!    is delegating; another agent needs it for its own work and gets the
//!    card. Never for outside text.
//! 5. **Someone already asked** for it and the card is waiting: this agent is
//!    added to that card instead of raising its own ([`Waiters`]), and woken
//!    with the same answer when the user gives it. One ask per service,
//!    team-wide, enforced here rather than left to the prompt.
//! 6. **One ask at a time per agent**: an agent with a sign-in card still
//!    waiting can't raise another until that one is answered.
//! 7. Only then: one login card (`logins::raise`), whose first way in is a
//!    sign-in button, never a field, unless the service has nothing else.
//!
//! Reading a link the user gave isn't a login: it's read directly first
//! (claude.ai artifacts through Claude Code's `Artifact` tool, anything else
//! fetched), and the browser only when it needs a signed-in page
//! (`prompts::links_section`).
//!
//! Full design: docs/agents.md, "Just try first".

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::AppHandle;

use super::connections::{self, Access, Kind};
use super::logins::{self, Ask, LoginRequest};
use super::store::{self, Agent, ApprovalStatus};
use crate::errors::CommandError;

/* ------------------------------------------------------------- the ask */

/// What the agent asked, plus what it tried.
#[derive(Debug, Clone, Default)]
pub struct Tried {
    /// It opened the site in a browser and got a sign-in page.
    pub signed_out: bool,
    /// That browser was the user's own Chrome (`browser: "chrome"`), not
    /// the agents' browser.
    pub in_chrome: bool,
}

impl Tried {
    pub fn from_args(args: &serde_json::Value) -> Tried {
        Tried {
            signed_out: args
                .get("signed_out")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            in_chrome: args
                .get("browser")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|b| {
                    let b = b.to_ascii_lowercase();
                    b.contains("chrome") || b.contains("user")
                }),
        }
    }
}

/// Sites the user is signed in to in their own Chrome and the agents'
/// browser can't sign in to: Google refuses a sign-in in a driven browser
/// ("This browser or app may not be secure"), and Slack's workspace sign-in
/// goes by email links to the user's inbox. X, LinkedIn and Grok (on
/// grok.com or X) challenge a new browser and are signed in only in the
/// user's own. With Claude in Chrome these go straight to the user's
/// Chrome. Observed: Gmail opened in the agents' browser landed on Google's
/// signed-out product page every time, and the agent was then told to carry
/// on without Gmail; an agent "couldn't search X because the agents'
/// browser isn't signed in there".
pub fn users_chrome_first(service: &str) -> bool {
    matches!(
        service,
        "gmail" | "google_calendar" | "google_drive" | "slack" | "x" | "linkedin" | "grok"
    ) || logins::service(service)
        .and_then(|s| s.site)
        .is_some_and(|site| site == "google.com" || site.ends_with(".google.com"))
}

/// What the chain found, before anything is changed. Pure: [`decide`].
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// The user said no to it already.
    AlreadyDeclined { title: String, said: String },
    /// Granted already: carry on.
    Have(String),
    /// Use `gh` (signed in as this login).
    Gh(String),
    /// Use the browser for this site.
    Browser { site: String, title: String },
    /// Use the agents' own browser for this site.
    AgentsBrowser { site: String, title: String },
    /// Join the card already waiting for it.
    Join {
        agent_id: String,
        agent_name: String,
        request_id: String,
        title: String,
    },
    /// A teammate already holds it (`team_reach::holders`): hand it over.
    Teammate {
        name: String,
        way: String,
        title: String,
    },
    /// Its own sign-in card is still waiting for something else.
    OneAtATime { title: String },
    /// Raise a card.
    Ask,
}

/// One login card anywhere on the team, as it reads now.
#[derive(Debug, Clone)]
pub struct Seen {
    pub agent_id: String,
    pub agent_name: String,
    pub request_id: String,
    pub status: ApprovalStatus,
    pub login: LoginRequest,
    /// "Not needed", or what the user said.
    pub said: Option<String>,
    /// When the card was posted.
    pub at: i64,
}

/// Every login card on the team.
pub fn seen() -> Vec<Seen> {
    let mut out = Vec::new();
    for agent in store::list().unwrap_or_default() {
        for m in store::login_cards(&agent.id) {
            let Some(a) = m.approval else { continue };
            let Some(login) = a.login else { continue };
            out.push(Seen {
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                request_id: a.request_id,
                status: a.status,
                said: a.note.or(a.choice),
                at: m.ts,
                login,
            });
        }
    }
    out
}

/// What's true on this Mac for the chain, gathered once per ask.
#[derive(Debug, Clone, Default)]
pub struct Here {
    /// `gh` is signed in, as this login.
    pub gh: Option<String>,
    /// This turn has the user's browser.
    pub browser: bool,
    /// This turn has the agents' own browser.
    pub agents_browser: bool,
    /// The site was last found signed in in one of the user's own Chrome
    /// profiles (not the agents' browser).
    pub personal_site: bool,
    /// Services the user marked "Not needed" on the setup checklist
    /// (`access_check::key_of` keys).
    pub not_needed: Vec<String>,
    /// The turn answers text from outside: nothing is granted or joined
    /// without the user seeing a card.
    pub outside: bool,
    /// Services the user turned back on after saying no (`declined`), and
    /// when: a no on a card older than that no longer counts.
    pub turned_on: Vec<(String, i64)>,
    /// The user's own words in this turn name the service ([`names_service`]):
    /// an earlier no (a Deny, "Not needed") is set aside for this request.
    pub user_named: bool,
    /// Teammates who already hold the service through the app, and how
    /// (`team_reach::holders`).
    pub teammates: Vec<(String, String)>,
}

/// Whether `words` (the user's own message) name the service `r` asks for:
/// its title, its catalogue id or its site's name, as whole words in any
/// case ("post this to Slack", "check my gmail").
pub fn names_service(words: &str, r: &LoginRequest) -> bool {
    let said: Vec<String> = words
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    if said.is_empty() {
        return false;
    }
    let has_phrase = |phrase: &str| {
        let want: Vec<String> = phrase
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_lowercase)
            .collect();
        !want.is_empty() && said.windows(want.len()).any(|w| w == want.as_slice())
    };
    let site_name = logins::service(&r.service)
        .and_then(|s| s.site)
        .and_then(|site| {
            let labels: Vec<&str> = site.split('.').collect();
            labels.len().checked_sub(2).map(|i| labels[i].to_string())
        });
    has_phrase(&r.title)
        || (r.service != "other" && has_phrase(&r.service))
        || site_name.is_some_and(|n| n.len() >= 3 && has_phrase(&n))
}

/// The line in the chat when the user's own request lifts an earlier no.
pub fn lifted_line(title: &str) -> String {
    format!("You asked for {title} in this request, so the earlier no is set aside for it")
}

/// One spelling for an unknown service's name: "Acme CRM", "acme-crm" and
/// "ACME_crm." are the same thing.
fn same_title(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|c| c.to_ascii_lowercase())
            .collect::<String>()
    };
    norm(a) == norm(b)
}

/// Which step of the chain answers `r` from `agent`. Pure, for tests.
pub fn decide(agent: &Agent, r: &LoginRequest, tried: &Tried, here: &Here, team: &[Seen]) -> Step {
    let same = |s: &Seen| {
        s.login.service == r.service
            && (r.service != "other" || same_title(&s.login.title, &r.title))
    };
    // 1a. "Not needed" on the setup checklist counts as a no. Unless the
    // user's own message in this turn asks for it again.
    let key = super::access_check::key_of(&r.service, &r.title);
    if !here.user_named
        && here.not_needed.iter().any(|k| {
            k == &key
                || (r.service == "other"
                    && k.strip_prefix("other:")
                        .is_some_and(|t| same_title(t, &r.title)))
        })
    {
        return Step::AlreadyDeclined {
            title: r.title.clone(),
            said: "Not needed".into(),
        };
    }
    // 1. Said no, for anyone: not asked again. Unless the user turned it
    // back on since (Undo, or "Turn back on").
    let turned_on = here
        .turned_on
        .iter()
        .filter(|(k, _)| k == &key)
        .map(|(_, at)| *at)
        .max();
    if let Some(no) = team
        .iter()
        .filter(|_| !here.user_named)
        .filter(|s| same(s) && s.status == ApprovalStatus::Denied)
        .filter(|s| turned_on.is_none_or(|on| s.at > on))
        .last()
    {
        // A plain no on a card an import raised (a setup ask, for an agent
        // nobody was working with yet) said "don't connect it", not "never
        // use it": the user's own Chrome, where they're already signed in,
        // connects nothing and asks before every send. Observed: one such
        // Deny for another agent left the Chief "carrying on without Gmail"
        // while Gmail sat open and signed in in the user's Chrome.
        if no.login.quiet && no.said.is_none() {
            if let Some(step @ Step::Browser { .. }) = browser_step(r, tried, here) {
                return step;
            }
        }
        return Step::AlreadyDeclined {
            title: r.title.clone(),
            said: no.said.clone().unwrap_or_else(|| "No".into()),
        };
    }
    // 2. Granted already: our own working connection (OAuth, `gh`). A
    // claude.ai connector isn't counted: it isn't always recognised in a
    // turn, so the browser comes first and the connector stays an extra.
    if let Some((c, access)) = connections::granted_to(&agent.id)
        .into_iter()
        .find(|(c, _)| {
            c.service == r.service && !c.needs_sign_in && !matches!(c.kind, Kind::ClaudeAi { .. })
        })
    {
        if access == Access::Full || r.access() == Access::Read {
            return Step::Have(format!("{} ({})", c.title, c.account));
        }
    }
    // 3. This Mac's own sign-in.
    // Not for outside text: it would grant `gh` to this agent unseen.
    if r.service == "github" && !here.outside {
        if let Some(login) = &here.gh {
            return Step::Gh(login.clone());
        }
    }
    // 4. A browser (never for outside text: such a turn has no browser).
    // The agents' own first; the user's own Chrome for a site signed in
    // only there (known, or Google's and Slack's, [`users_chrome_first`]),
    // and at once when the agents' browser showed a sign-in page. A sign-in
    // page in the user's Chrome (or with no Chrome to try) is a card.
    if let Some(step) = browser_step(r, tried, here) {
        return step;
    }
    // 4b. A teammate already holds it through the app: the work goes to
    // them, not a card to the user. Observed (2026-11-08, live on Haiku):
    // asked "can you read my email?", the Chief found Gmail signed out in
    // the agents' browser and raised a sign-in card, while another agent
    // had Gmail connected; the open card then kept the follow-up that
    // checks a "can't" (`follow_up`) from running. Only the Chief, whose
    // job is handing work out; not for outside text, whose asks stay on
    // cards the user sees.
    if let Some((name, way)) = here
        .teammates
        .first()
        .filter(|_| agent.is_main && !here.outside)
    {
        return Step::Teammate {
            name: name.clone(),
            way: way.clone(),
            title: r.title.clone(),
        };
    }
    // 5. Someone's card for it is waiting: join it. Outside text doesn't
    // join (the answer would grant it unseen); it raises its own card.
    if let Some(open) = team
        .iter()
        .find(|s| same(s) && s.status == ApprovalStatus::Pending)
        .filter(|_| !here.outside)
    {
        return Step::Join {
            agent_id: open.agent_id.clone(),
            agent_name: open.agent_name.clone(),
            request_id: open.request_id.clone(),
            title: r.title.clone(),
        };
    }
    // 6. One at a time: its own card for something else is still waiting.
    if let Some(mine) = team
        .iter()
        .find(|s| s.agent_id == agent.id && s.status == ApprovalStatus::Pending && !s.login.quiet)
    {
        return Step::OneAtATime {
            title: mine.login.title.clone(),
        };
    }
    Step::Ask
}

/// Step 4 of [`decide`]: which browser, if any.
fn browser_step(r: &LoginRequest, tried: &Tried, here: &Here) -> Option<Step> {
    if here.outside {
        return None;
    }
    let site = logins::service(&r.service).and_then(|s| s.site)?;
    let (site, title) = (site.to_string(), r.title.clone());
    // Signed out in the user's Chrome, or with no agents' browser it could
    // have been anywhere else.
    let chrome_failed = tried.signed_out && (tried.in_chrome || !here.agents_browser);
    if here.browser && !chrome_failed {
        let chrome_first = here.personal_site || users_chrome_first(&r.service);
        if chrome_first || !here.agents_browser || tried.signed_out {
            return Some(Step::Browser { site, title });
        }
    }
    if here.agents_browser && !tried.signed_out {
        return Some(Step::AgentsBrowser { site, title });
    }
    None
}

/// What the agent is told for each step.
pub fn reply(step: &Step) -> String {
    match step {
        Step::AlreadyDeclined { title, said } => format!(
            "The user already answered about {title} (\"{said}\"). Don't ask for it again: carry on without it, or say in one line what you can't do without it."
        ),
        Step::Have(what) => format!("You already have {what}. Use it; nothing to ask."),
        Step::Gh(login) => format!(
            "GitHub is signed in on this Mac as {login}: use the `gh` command. Anything that changes GitHub asks the user on a card first. Nothing to ask."
        ),
        Step::Browser { site, title } => format!(
            "Use {title} in the user's own Chrome, where they're already signed in: the Claude in Chrome tools (mcp__claude-in-chrome__*), on {site}. First open it in a new tab and tell the user in one line which account you're in, from what the page shows (\"I'm in {title} as …\"); never guess one. Reading there needs no card. Before any send, post, publish, payment, delete or share, say in chat exactly what will go and from which account; the click or keystroke that does it asks the user on a card, which shows it too. Never type a password. If the page asks you to sign in, call request_login again for it with signed_out: true and browser: \"chrome\"."
        ),
        Step::AgentsBrowser { site, title } => format!(
            "Use {title} in the agents' browser (the mcp__browser__* tools), a Chrome of the team's own on this Mac: open {site} and tell the user in one line which account you're in, from what the page shows (\"I'm in {title} as …\"); never guess one. Reading there needs no card. Before any send, post, publish, payment, delete or share, say in chat exactly what will go and from which account; the click or keystroke that does it asks the user on a card. Never type a password. If the page asks you to sign in (or shows a signed-out product page), call request_login again for it with signed_out: true: that moves you to the user's own Chrome when you have it, else the user signs in from their phone."
        ),
        Step::Join { agent_name, title, .. } => format!(
            "The user is already being asked about {title} (for {agent_name}). You're on that same card: you'll be woken when they answer. Don't ask again; stop here or carry on with what doesn't need it."
        ),
        Step::Teammate { name, way, title } => format!(
            "{name} on the team already has {title} ({way}). Nothing to ask the user: hand this to {name} with message_agent, saying exactly what you need, and never tell the user it can't be done."
        ),
        Step::OneAtATime { title } => format!(
            "You already have a sign-in waiting on the user ({title}). One at a time: wait for that answer before asking for anything else, and carry on with what you can do meanwhile."
        ),
        Step::Ask => String::new(),
    }
}

/// `request_login`: try the chain, and raise a card only when it ends there.
pub async fn request(
    app: &AppHandle,
    agent: &Agent,
    ask: &Ask,
    tried: &Tried,
    outside: bool,
) -> Result<String, CommandError> {
    let r = logins::build(agent, ask)?;
    let here = Here {
        gh: if r.service == "github" {
            gh_login().await
        } else {
            None
        },
        browser: super::browser::for_turn(agent, outside),
        agents_browser: super::connections::agents_browser_for_turn(agent, outside),
        personal_site: logins::service(&r.service)
            .and_then(|s| s.site)
            .is_some_and(|site| {
                super::browser_profiles::in_personal_chrome(
                    super::browser_profiles::remembered(site).as_ref(),
                )
            }),
        not_needed: not_needed_keys(),
        outside,
        turned_on: super::declined::turned_on(),
        user_named: !outside && names_service(&super::runner::users_words(&agent.id), &r),
        teammates: logins::service(&r.service)
            .filter(|_| agent.is_main)
            .map(|s| super::team_reach::holders(agent, s, r.access()))
            .unwrap_or_default(),
    };
    let team = seen();
    let step = decide(agent, &r, tried, &here, &team);
    // The user asked for it again: say so, once, where they are.
    let lifted = here.user_named
        && matches!(
            decide(
                agent,
                &r,
                tried,
                &Here {
                    user_named: false,
                    ..here.clone()
                },
                &team
            ),
            Step::AlreadyDeclined { .. }
        );
    if lifted {
        let line = super::runner::new_message(
            &agent.id,
            super::store::MessageKind::Note,
            lifted_line(&r.title),
        );
        let _ = super::runner::record(app, line);
    }
    match &step {
        Step::Ask => return logins::raise_as(app, agent, ask, lifted),
        Step::Gh(login) => {
            connections::add_and_grant("github", "GitHub", login, Kind::Gh, &agent.id, r.access())?;
        }
        Step::Browser { site, .. } | Step::AgentsBrowser { site, .. } => {
            super::browser::give_site(&agent.id, site)?
        }
        Step::Join {
            agent_id,
            request_id,
            ..
        } => {
            add_waiter(request_id, agent_id, &agent.id, r.access(), ask.quiet)?;
        }
        _ => {}
    }
    tracing::info!(agent = %agent.id, service = %r.service, step = ?std::mem::discriminant(&step), "[Agents] access chain");
    // Which Chrome profile: listed by the app (nothing opened), started from
    // where this site was last found (`browser_profiles`).
    if let Step::Browser { site, .. } = &step {
        let list = super::browser_profiles::connected().await;
        let known = super::browser_profiles::remembered(site);
        return Ok(format!(
            "{} {}",
            reply(&step),
            super::browser_profiles::guidance(site, list.as_deref(), known.as_ref())
        ));
    }
    Ok(reply(&step))
}

/// Rows the user marked "Not needed" on the setup checklist, kept even
/// after the checklist is put away, and apps declined for the whole team
/// (`declined`: "Not needed" on a card or a row, "Skip the rest").
fn not_needed_keys() -> Vec<String> {
    let team = super::declined::list().into_iter().map(|d| d.key);
    let checklist = super::team_setup::load()
        .map(|s| {
            s.later
                .states
                .into_iter()
                .filter(|(_, st)| *st == super::access_check::LaterState::NotNeeded)
                .map(|(k, _)| k)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    team.chain(checklist).collect()
}

pub(crate) async fn gh_login() -> Option<String> {
    crate::commands::github::get_github_username(None)
        .await
        .ok()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/* ------------------------------------------------------------- waiters */

/// An agent waiting on another agent's card for the same service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Waiter {
    pub agent_id: String,
    pub access: Access,
    #[serde(default)]
    pub quiet: bool,
}

/// `request id -> (card's agent, waiters)`, kept beside the registry so a
/// card answered tomorrow still reaches everyone who asked.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Waiters {
    #[serde(default)]
    pub cards: BTreeMap<String, (String, Vec<Waiter>)>,
}

const WAITERS_FILE: &str = "login-waiters.json";
static LOCK: Mutex<()> = Mutex::new(());

fn waiters_path() -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agents_root()?.join(WAITERS_FILE))
}

pub fn load_waiters() -> Waiters {
    waiters_path()
        .ok()
        .and_then(|p| super::survive::read_kept(&p, "The list of agents waiting on a login"))
        .unwrap_or_default()
}

fn change_waiters<T>(f: impl FnOnce(&mut Waiters) -> T) -> Result<T, CommandError> {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut w = load_waiters();
    let out = f(&mut w);
    let bytes = serde_json::to_vec_pretty(&w).map_err(super::err_other)?;
    store::write_atomic(&waiters_path()?, &bytes)?;
    Ok(out)
}

pub fn add_waiter(
    request_id: &str,
    card_agent: &str,
    agent_id: &str,
    access: Access,
    quiet: bool,
) -> Result<(), CommandError> {
    if card_agent == agent_id {
        return Ok(());
    }
    change_waiters(|w| {
        let entry = w
            .cards
            .entry(request_id.to_string())
            .or_insert_with(|| (card_agent.to_string(), Vec::new()));
        match entry.1.iter_mut().find(|x| x.agent_id == agent_id) {
            // Asking for more than before: the most it asked for.
            Some(x) => {
                if access == Access::Full {
                    x.access = Access::Full;
                }
            }
            None => entry.1.push(Waiter {
                agent_id: agent_id.to_string(),
                access,
                quiet,
            }),
        }
    })
}

/// Agents waiting on `request_id`, taken off the list.
pub fn take_waiters(request_id: &str) -> Vec<Waiter> {
    change_waiters(|w| {
        w.cards
            .remove(request_id)
            .map(|(_, v)| v)
            .unwrap_or_default()
    })
    .unwrap_or_default()
}

/// How a card was answered, for its waiters.
pub enum Answered<'a> {
    /// Connected: the card's agent now has this connection.
    Connection(&'a connections::Connection),
    /// The browser, for this site.
    Browser(&'a str),
    /// The agents' browser, signed in to this site.
    AgentsBrowser(&'a str),
    Declined(Option<&'a str>),
}

/// A card was answered: everyone who joined it gets the same answer. A
/// connection is granted to each with what it asked for (the user connected
/// it for this service, for every agent on the card); the browser gives
/// each the site; a no is passed on.
pub fn answer_waiters(app: &AppHandle, request_id: &str, r: &LoginRequest, how: Answered<'_>) {
    for w in take_waiters(request_id) {
        let told = match &how {
            // Never more than the card the user answered allowed.
            Answered::Connection(c) => {
                match connections::grant(&c.id, &w.agent_id, w.access.min_with(r.access())) {
                    Ok(_) => logins::connected_prompt(r, &format!("{} ({})", c.title, c.account)),
                    Err(_) => continue,
                }
            }
            Answered::Browser(site) => {
                if super::browser::give_site(&w.agent_id, site).is_err() {
                    continue;
                }
                logins::connected_prompt(
                    r,
                    &format!("use {site} in the user's own Chrome (mcp__claude-in-chrome__*)"),
                )
            }
            Answered::AgentsBrowser(site) => {
                if super::browser::give_site(&w.agent_id, site).is_err() {
                    continue;
                }
                logins::connected_prompt(r, &logins::agents_browser_told(site))
            }
            Answered::Declined(note) => logins::declined_prompt(r, *note),
        };
        if w.quiet {
            continue;
        }
        super::runner::enqueue(app, &w.agent_id, told, super::runner::From::App);
    }
}

#[cfg(test)]
#[path = "access_chain_tests.rs"]
mod tests;
