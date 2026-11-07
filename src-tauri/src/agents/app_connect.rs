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
        let made = outcome.and_then(|done| {
            let account = again_account
                .clone()
                .or_else(|| done.email.clone())
                .unwrap_or_default();
            let c = connections::add_for(
                svc.id,
                svc.title,
                &account,
                Kind::Oauth {
                    server_url: url.to_string(),
                },
                &grants,
            )?;
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
                logins::answer_waiting_with(&app2, &c);
                put(
                    &app2,
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
