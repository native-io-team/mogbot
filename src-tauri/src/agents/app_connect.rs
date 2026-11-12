//! Connecting an app from "Apps your agents can use" (`AgentAppsModal`),
//! without an agent having asked first.
//!
//! The same sign-in as a login card's **Connect** (`logins.rs`
//! `Method::Oauth`): our own OAuth (`oauth.rs`) in this Mac's browser, the
//! token in its Keychain, the connection in `connections.json`, reached by
//! every engine through the bridge's relay (`conn_relay.rs`). It used to add
//! the app to Claude Code (`claude mcp add`) and sign in by typing `/mcp` in
//! a raw `claude` terminal, which first showed Claude Code's folder-trust
//! prompt, and reached Claude Code agents only.
//!
//! Grants are the user's answer in the dialog, never wider: the agents they
//! ticked, each Read or Full (docs/agents.md, "Grants, read vs send, and
//! turns"), or none, in which case the connection is kept and offered on
//! the next card as "Use <account>". An agent granted it with a card
//! waiting for that app has the card answered.
//!
//! The flow lives in this process only, keyed by the catalogue's service
//! id, and is sent to the dialog as [`EVENT`].

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::connections::{self, Access, Connection, Kind};
use super::login_relay;
use super::logins::{self, Connector, Flow, FlowState, Service};
use super::store;
use crate::errors::CommandError;

/// The dialog's live flow, one per app.
pub const EVENT: &str = "agents-app-connect";

/// An app we sign in to ourselves.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueApp {
    pub service: String,
    pub title: String,
    /// What reading lets an agent do.
    pub read: String,
    /// What a full grant adds (each time, on a card).
    pub write: String,
    /// The connector's host, for the curious.
    pub host: String,
}

/// Where a connect from the dialog has got to.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppFlow {
    pub service: String,
    /// Under way, failed or stopped; the same shape a login card carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<Flow>,
    /// Done: the connection it made or signed in again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected: Option<Connected>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub connection_id: String,
    /// "Connected as sam@acme.com".
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub apps: Vec<CatalogueApp>,
    pub connections: Vec<Connection>,
    pub flows: Vec<AppFlow>,
}

/// One agent the user ticked, and how.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrantInput {
    pub agent_id: String,
    pub access: Access,
}

struct Live {
    flow: AppFlow,
    task: Option<tokio::task::AbortHandle>,
}

static FLOWS: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(Default::default);

fn host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

/// Every app with a connector of our own, in the catalogue's order.
pub fn catalogue() -> Vec<CatalogueApp> {
    logins::SERVICES
        .iter()
        .filter_map(|s| match s.connector {
            Connector::Oauth(url) => Some(CatalogueApp {
                service: s.id.to_string(),
                title: s.title.to_string(),
                read: s.read.to_string(),
                write: s.write.to_string(),
                host: host(url),
            }),
            _ => None,
        })
        .collect()
}

fn oauth_service(id: &str) -> Result<(&'static Service, &'static str), CommandError> {
    let s = logins::service(id)
        .ok_or_else(|| super::err_invalid("service", "That app isn't on the list."))?;
    match s.connector {
        Connector::Oauth(url) => Ok((s, url)),
        _ => Err(CommandError::expected(format!(
            "{} isn't one this app signs in to itself.",
            s.title
        ))),
    }
}

/// The user's ticks, checked: each agent exists, once each.
pub fn checked_grants(
    grants: &[GrantInput],
    known: &[String],
) -> Result<Vec<(String, Access)>, CommandError> {
    let mut out: Vec<(String, Access)> = Vec::new();
    for g in grants {
        if !known.contains(&g.agent_id) {
            return Err(super::err_invalid("grants", "One of those agents is gone."));
        }
        match out.iter_mut().find(|(id, _)| id == &g.agent_id) {
            Some(existing) => existing.1 = g.access,
            None => out.push((g.agent_id.clone(), g.access)),
        }
    }
    Ok(out)
}

fn known_agents() -> Vec<String> {
    store::list()
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.id)
        .collect()
}

/// "Connected as sam@acme.com", or "Connected" when the sign-in didn't say.
pub fn connected_line(c: &Connection) -> String {
    if c.account.is_empty() || c.account == c.title {
        "Connected".to_string()
    } else {
        format!("Connected as {}", c.account)
    }
}

pub fn overview() -> Result<Overview, CommandError> {
    let flows = FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|l| l.flow.clone())
        .collect();
    Ok(Overview {
        apps: catalogue(),
        connections: connections::list()?,
        flows,
    })
}

fn under_way(service: &str) -> bool {
    FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(service)
        .and_then(|l| l.flow.flow.as_ref())
        .is_some_and(|f| matches!(f.state, FlowState::Starting | FlowState::Waiting))
}

fn current(service: &str) -> Option<Flow> {
    FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(service)
        .and_then(|l| l.flow.flow.clone())
}

fn put(app: &AppHandle, flow: AppFlow, task: Option<tokio::task::AbortHandle>) {
    {
        let mut flows = FLOWS.lock().unwrap_or_else(|e| e.into_inner());
        let entry = flows.entry(flow.service.clone()).or_insert(Live {
            flow: flow.clone(),
            task: None,
        });
        entry.flow = flow.clone();
        if task.is_some() {
            entry.task = task;
        }
    }
    let _ = app.emit(EVENT, &flow);
}

fn flow(state: FlowState, message: Option<String>) -> Flow {
    Flow {
        state,
        option: "oauth".into(),
        message,
        started_at: store::now_ms(),
        ..Default::default()
    }
}

fn set(app: &AppHandle, service: &str, f: Flow) {
    put(
        app,
        AppFlow {
            service: service.to_string(),
            flow: Some(f),
            connected: None,
        },
        None,
    );
}

/// A connect, checked before anything starts: one of ours, the ticks are
/// agents that exist, the connection signed in again is still there, and
/// nothing is signing in to it already.
struct Ask {
    svc: &'static Service,
    url: &'static str,
    grants: Vec<(String, Access)>,
    again_account: Option<String>,
}

fn ask(service: &str, grants: &[GrantInput], again: Option<&str>) -> Result<Ask, CommandError> {
    let (svc, url) = oauth_service(service)?;
    let grants = checked_grants(grants, &known_agents())?;
    let again_account = match again {
        Some(id) => Some(
            connections::get(id)?
                .filter(|c| c.service == svc.id)
                .ok_or_else(|| CommandError::expected("That connection is gone."))?
                .account,
        ),
        None => None,
    };
    if under_way(service) {
        return Err(CommandError::expected("It's already signing in."));
    }
    Ok(Ask {
        svc,
        url,
        grants,
        again_account,
    })
}

/// Sign in to `service` in this Mac's browser and let `grants` use it.
/// `again`: the connection to sign in again (it needs it), kept as the same
/// one whatever account the sign-in reports. Returns at once; the dialog
/// follows [`EVENT`].
pub async fn start(
    app: &AppHandle,
    service: &str,
    grants: &[GrantInput],
    again: Option<&str>,
) -> Result<(), CommandError> {
    let Ask {
        svc,
        url,
        grants,
        again_account,
    } = ask(service, grants, again)?;
    set(app, service, flow(FlowState::Starting, None));
    let app2 = app.clone();
    let task = tokio::spawn(async move {
        let outcome = async {
            let pending = super::oauth::begin(url).await?;
            // Opening can fail, or "succeed" into a browser the user can't
            // see: either way the dialog keeps the link.
            let message = match logins::open_in_browser(&pending.url) {
                Ok(()) => format!("{}'s sign-in opened in your browser.", svc.title),
                Err(_) => format!(
                    "Couldn't open your browser. Copy the link to sign in to {}.",
                    svc.title
                ),
            };
            let mut waiting = flow(FlowState::Waiting, Some(message));
            waiting.url = Some(pending.url.clone());
            waiting.opened_at = Some(store::now_ms());
            set(&app2, svc.id, waiting);
            pending.finish().await
        }
        .await;
        match outcome {
            Ok(done) => {
                let _ = complete(&app2, svc, url, again_account, &grants, done);
            }
            Err(e) => {
                // A cancel already said so.
                if current(svc.id).is_some_and(|f| f.state == FlowState::Cancelled) {
                    return;
                }
                set(&app2, svc.id, flow(FlowState::Failed, Some(e.to_string())));
            }
        }
    });
    put(
        app,
        AppFlow {
            service: service.to_string(),
            flow: Some(flow(FlowState::Starting, None)),
            connected: None,
        },
        Some(task.abort_handle()),
    );
    Ok(())
}

/// A sign-in came back (in this Mac's browser, or the phone's sheet): keep
/// the connection and its token, give it to the agents ticked, answer their
/// waiting cards, and say so on the row. A failure is said on the row too.
fn complete(
    app: &AppHandle,
    svc: &'static Service,
    url: &'static str,
    again_account: Option<String>,
    grants: &[(String, Access)],
    done: super::oauth::Finished,
) -> Result<Connection, CommandError> {
    let account = again_account
        .or_else(|| done.email.clone())
        .unwrap_or_default();
    let made = connections::add_for(
        svc.id,
        svc.title,
        &account,
        Kind::Oauth {
            server_url: url.to_string(),
        },
        grants,
    )
    .and_then(|c| {
        connections::store_tokens(&c.id, &done.tokens)?;
        Ok(c)
    });
    match made {
        Ok(c) => {
            tracing::info!(
                service = svc.id,
                agents = c.grants.len(),
                "connected an app from the apps dialog"
            );
            logins::answer_waiting_with(app, &c);
            put(
                app,
                AppFlow {
                    service: svc.id.to_string(),
                    flow: None,
                    connected: Some(Connected {
                        connection_id: c.id.clone(),
                        line: connected_line(&c),
                    }),
                },
                None,
            );
            Ok(c)
        }
        Err(e) => {
            set(app, svc.id, flow(FlowState::Failed, Some(e.to_string())));
            Err(e)
        }
    }
}

/// Stop a sign-in under way.
pub fn cancel(app: &AppHandle, service: &str) -> Result<(), CommandError> {
    let task = FLOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(service)
        .and_then(|l| l.task.take());
    if let Some(t) = task {
        t.abort();
    }
    let _ = sheets().forget_request(&sheet_key(service));
    set(
        app,
        service,
        flow(
            FlowState::Cancelled,
            Some("Stopped. Connect again when you're ready.".into()),
        ),
    );
    Ok(())
}

/// "Open again": the sign-in page, in this Mac's browser again.
pub fn reopen(app: &AppHandle, service: &str) -> Result<(), CommandError> {
    let mut f = current(service)
        .filter(|f| f.state == FlowState::Waiting)
        .ok_or_else(|| CommandError::expected("Nothing is waiting to sign in."))?;
    let url = f
        .url
        .clone()
        .ok_or_else(|| CommandError::expected("Nothing is waiting to sign in."))?;
    let opened = logins::open_in_browser(&url);
    f.opened_at = Some(store::now_ms());
    if opened.is_err() {
        f.message = Some("Couldn't open your browser. Copy the link and open it yourself.".into());
    }
    set(app, service, f);
    opened
}

/// Exactly these agents may use the connection, each as ticked.
pub fn set_grants(connection_id: &str, grants: &[GrantInput]) -> Result<Connection, CommandError> {
    let grants = checked_grants(grants, &known_agents())?;
    connections::set_grants(connection_id, &grants)
}

/* ---------------------------------------------------------------- phone */

/// "Apps your agents can use" on the phone (`agents.apps`): the same list,
/// without anything a phone has no use for. No token is ever in it (those
/// are only in this Mac's Keychain), nor the page this Mac's browser was
/// asked to open, which only this Mac's browser can finish.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneApps {
    pub apps: Vec<CatalogueApp>,
    pub connections: Vec<PhoneConnection>,
    pub flows: Vec<AppFlow>,
}

/// One connection, as the phone shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneConnection {
    pub connection_id: String,
    pub service: String,
    pub title: String,
    pub account: String,
    /// Where its sign-in is kept: `oauth` (this Mac), `gh`, `claude_ai`.
    pub kind: &'static str,
    pub grants: Vec<PhoneGrant>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_sign_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneGrant {
    pub agent_id: String,
    pub access: Access,
}

pub fn phone_connection(c: &Connection) -> PhoneConnection {
    PhoneConnection {
        connection_id: c.id.clone(),
        service: c.service.clone(),
        title: c.title.clone(),
        account: c.account.clone(),
        kind: match c.kind {
            Kind::Oauth { .. } => "oauth",
            Kind::Gh => "gh",
            Kind::ClaudeAi { .. } => "claude_ai",
            Kind::MacApp => "mac_app",
        },
        grants: c
            .grants
            .iter()
            .map(|g| PhoneGrant {
                agent_id: g.agent_id.clone(),
                access: g.access,
            })
            .collect(),
        needs_sign_in: c.needs_sign_in,
        last_used_at: c.last_used_at,
    }
}

/// A flow as the phone sees it: the Mac browser's page left out.
pub fn phone_flow(mut f: AppFlow) -> AppFlow {
    if let Some(flow) = f.flow.as_mut() {
        if !flow.on_phone {
            flow.url = None;
        }
    }
    f
}

pub fn phone_overview() -> Result<PhoneApps, CommandError> {
    let o = overview()?;
    Ok(PhoneApps {
        apps: o.apps,
        connections: o.connections.iter().map(phone_connection).collect(),
        flows: o.flows.into_iter().map(phone_flow).collect(),
    })
}

/// What the phone opens in its sign-in sheet. No secret: the PKCE verifier
/// and `state` stay here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneBegin {
    pub flow_id: String,
    pub service: String,
    pub url: String,
    pub redirect_uri: String,
}

/// A phone sign-in waiting for its code (never sent anywhere).
struct Sheet {
    app: AppHandle,
    svc: &'static Service,
    url: &'static str,
    grants: Vec<(String, Access)>,
    again_account: Option<String>,
    prepared: super::oauth::Prepared,
}

static SHEETS: LazyLock<Mutex<login_relay::Table<Sheet>>> = LazyLock::new(Default::default);

fn sheets() -> std::sync::MutexGuard<'static, login_relay::Table<Sheet>> {
    SHEETS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The relay keeps one sign-in per card; with no card, one per app.
fn sheet_key(service: &str) -> String {
    format!("app:{service}")
}

/// Whether `flow_id` is a phone sign-in started from the apps screen.
pub fn is_phone_flow(flow_id: &str) -> bool {
    sheets().contains(flow_id)
}

const TOO_LONG: &str = "Sign-in took too long, so it was stopped. Try again.";

/// Get a phone sign-in ready, as a card's is (`login_relay::begin`): this
/// Mac does discovery, registers the companion app's redirect and makes the
/// PKCE verifier and `state`, which never leave it. The phone gets only the
/// authorization URL. The row follows it on both devices.
pub async fn phone_begin(
    app: &AppHandle,
    device_id: &str,
    service: &str,
    grants: &[GrantInput],
    again: Option<&str>,
) -> Result<PhoneBegin, CommandError> {
    let Ask {
        svc,
        url,
        grants,
        again_account,
    } = ask(service, grants, again)?;
    let on_phone = |mut f: Flow| {
        f.from_phone = true;
        f.on_phone = true;
        f
    };
    set(app, svc.id, on_phone(flow(FlowState::Starting, None)));
    let redirect = login_relay::redirect_uri();
    let prepared = match super::oauth::prepare(url, &redirect).await {
        Ok(p) => p,
        Err(e) => {
            let said = format!(
                concat!(
                    "{} {} won't sign in from a phone, so connect it on your ",
                    crate::computer::noun!(),
                    "."
                ),
                e, svc.title
            );
            set(app, svc.id, flow(FlowState::Failed, Some(said.clone())));
            return Err(CommandError::expected(said));
        }
    };
    let flow_id = login_relay::new_flow_id();
    let sheet_url = prepared.url.clone();
    let state = prepared.state.clone();
    set(
        app,
        svc.id,
        on_phone(flow(
            FlowState::Waiting,
            Some(format!("{}'s sign-in is open on your phone.", svc.title)),
        )),
    );
    sheets().insert(
        &flow_id,
        device_id,
        &sheet_key(svc.id),
        &state,
        &redirect,
        std::time::Instant::now() + login_relay::SHEET_TIMEOUT,
        Sheet {
            app: app.clone(),
            svc,
            url,
            grants,
            again_account,
            prepared,
        },
    );
    // Give up on it when its time is up, and say so on the row.
    tokio::spawn(async move {
        tokio::time::sleep(login_relay::SHEET_TIMEOUT + std::time::Duration::from_secs(1)).await;
        let due = sheets().expire(std::time::Instant::now());
        for s in due {
            set(
                &s.app,
                s.svc.id,
                flow(FlowState::Failed, Some(TOO_LONG.into())),
            );
        }
    });
    Ok(PhoneBegin {
        flow_id,
        service: svc.id.to_string(),
        url: sheet_url,
        redirect_uri: redirect,
    })
}

/// The sheet's answer, from the phone (`agents.loginPhoneFinish`): taken by
/// the relay's own rules (`Table::take`: once, in time, from the device that
/// began it, on the registered redirect with this Mac's `state`), exchanged
/// here with the verifier, the token into this Mac's Keychain.
pub async fn phone_finish(
    device_id: &str,
    flow_id: &str,
    callback: &str,
) -> Result<(), CommandError> {
    let taken = sheets().take(flow_id, device_id, callback, std::time::Instant::now());
    let (sheet, code) = match taken {
        Ok(ok) => ok,
        Err(login_relay::Refusal { spent, error }) => {
            if let Some(s) = spent {
                set(
                    &s.app,
                    s.svc.id,
                    flow(FlowState::Failed, Some(error.to_string())),
                );
            }
            return Err(error);
        }
    };
    let Sheet {
        app,
        svc,
        url,
        grants,
        again_account,
        prepared,
    } = sheet;
    match prepared.exchange(&code).await {
        Ok(done) => complete(&app, svc, url, again_account, &grants, done).map(|_| ()),
        Err(e) => {
            set(&app, svc.id, flow(FlowState::Failed, Some(e.to_string())));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dialog_offers_every_app_we_sign_in_to_ourselves_and_only_those() {
        let apps = catalogue();
        let ids: Vec<&str> = apps.iter().map(|a| a.service.as_str()).collect();
        for id in ["linear", "notion", "figma", "stripe", "vercel", "sentry"] {
            assert!(ids.contains(&id), "{id} missing");
        }
        // claude.ai's connectors, GitHub's CLI and browser-only apps aren't ours.
        for id in ["gmail", "slack", "github", "linkedin", "x"] {
            assert!(!ids.contains(&id), "{id} offered");
        }
        let vercel = apps.iter().find(|a| a.service == "vercel").unwrap();
        assert_eq!(vercel.host, "mcp.vercel.com");
        assert!(oauth_service("gmail").is_err());
        assert!(oauth_service("nope").is_err());
        assert_eq!(oauth_service("vercel").unwrap().1, "https://mcp.vercel.com");
    }

    #[test]
    fn grants_are_only_agents_that_exist_once_each() {
        let known = vec!["chief".to_string(), "rex".to_string()];
        let g = |id: &str, access| GrantInput {
            agent_id: id.into(),
            access,
        };
        assert_eq!(checked_grants(&[], &known).unwrap(), vec![]);
        assert_eq!(
            checked_grants(
                &[
                    g("chief", Access::Read),
                    g("rex", Access::Full),
                    g("chief", Access::Full)
                ],
                &known
            )
            .unwrap(),
            vec![("chief".into(), Access::Full), ("rex".into(), Access::Full)]
        );
        assert!(checked_grants(&[g("ghost", Access::Read)], &known).is_err());
    }

    #[test]
    fn connected_says_which_account_when_the_sign_in_said() {
        let mut c: Connection = serde_json::from_value(serde_json::json!({
            "id": "c", "service": "vercel", "title": "Vercel", "account": "Vercel",
            "kind": {"type": "oauth", "serverUrl": "https://mcp.vercel.com"},
            "serverKey": "vercel", "createdAt": 0
        }))
        .unwrap();
        assert_eq!(connected_line(&c), "Connected");
        c.account = "sam@acme.com".into();
        assert_eq!(connected_line(&c), "Connected as sam@acme.com");
    }
}
