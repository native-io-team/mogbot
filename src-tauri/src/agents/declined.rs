//! Apps the user chose not to connect: "Not needed" on a row of "What your
//! team needs" or on a login card, and "Skip the rest" for the whole list.
//!
//! A decline is for the service, across the team, and it is remembered
//! (`declined-services.json` in the agents folder): every card waiting for it
//! is put away with a one-line receipt, no agent can raise another
//! (`request_login` and `request_secret` answer with [`refusal`] instead of a
//! card), and every agent's app-owned system prompt says so
//! ([`prompt_section`]), so it does the work another way or says what it
//! can't do. Nothing wakes an agent for it: it reads the section on its next
//! turn.
//!
//! Turning one back on ("What it can reach", Settings → Agents, or the Undo
//! on the receipt) removes it; within [`RESTORE_WINDOW_MS`] of the decline the
//! cards it put away come back as fresh cards, so an Undo is a real undo.
//! Later it only lets agents ask again.
//!
//! A service the catalogue doesn't know (`other`) is declined by its title
//! ("other:acme bank"), never as `other`, which would silence every app
//! nobody has catalogued.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use super::logins::{self, LoginRequest};
use super::runner;
use super::store::{self, AgentMessage, ApprovalStatus};
use crate::errors::CommandError;

/// An Undo this soon after the decline brings its cards back.
pub const RESTORE_WINDOW_MS: i64 = 5 * 60 * 1000;

/// One service the user doesn't want connected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Declined {
    /// [`key`]: the catalogue id, or `other:<title>`.
    pub key: String,
    /// "Gmail", "Acme Bank".
    pub title: String,
    pub declined_at: i64,
    /// The cards it put away, for an Undo.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub closed: Vec<Closed>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
    pub agent_id: String,
    pub request_id: String,
}

/// What a decline did, for its receipt line.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    /// The keys declined, for the Undo.
    pub keys: Vec<String>,
    /// "Not connecting Acme Bank. No agent will ask for it again."
    pub line: String,
    /// How many waiting cards were put away.
    pub closed: usize,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    services: Vec<Declined>,
    /// Turned back on, and when (the latest per key): a no on a card from
    /// before then no longer stops an agent asking (`access_chain`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    turned_on: Vec<TurnedOn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TurnedOn {
    key: String,
    at: i64,
}

impl Saved {
    fn mark_on(&mut self, key: &str, at: i64) {
        self.turned_on.retain(|t| t.key != key);
        self.turned_on.push(TurnedOn {
            key: key.to_string(),
            at,
        });
    }
}

/// Services turned back on, and when.
pub fn turned_on() -> Vec<(String, i64)> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read()
        .turned_on
        .into_iter()
        .map(|t| (t.key, t.at))
        .collect()
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agents_root()?.join("declined-services.json"))
}

fn read() -> Saved {
    path()
        .ok()
        .and_then(|p| super::survive::read_kept(&p, "The list of apps you said no to"))
        .unwrap_or_default()
}

fn write(saved: &Saved) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(saved).map_err(super::err_other)?;
    store::write_atomic(&path()?, &json)
}

/// The identity a decline is kept under.
pub fn key(service: &str, title: &str) -> String {
    if service == "other" {
        format!("other:{}", title.trim().to_lowercase())
    } else {
        service.to_string()
    }
}

pub fn key_of(r: &LoginRequest) -> String {
    key(&r.service, &r.title)
}

/// Everything declined, oldest first.
pub fn list() -> Vec<Declined> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read().services
}

pub fn find(key: &str) -> Option<Declined> {
    list().into_iter().find(|d| d.key == key)
}

/// What `request_login` / `request_secret` answer for a declined service.
pub fn refusal(title: &str) -> String {
    format!("The user chose not to connect {title}; don't ask for it. Do the work another way, or say plainly what you can't do without it. Stop asking here.")
}

/// A secret request whose name or purpose means a declined service.
pub fn refusal_for_text(text: &str) -> Option<String> {
    let s = logins::match_service(text)?;
    find(s.id).map(|d| refusal(&d.title))
}

/// The app-owned section every turn's system prompt carries while anything
/// is declined. Only titles, in a fixed order: it changes when the list
/// does, never per turn.
pub fn prompt_section() -> Option<String> {
    let titles: Vec<String> = list().into_iter().map(|d| d.title).collect();
    if titles.is_empty() {
        return None;
    }
    Some(format!(
        "## Apps the user chose not to connect\n\nThe user chose not to connect {}. Don't ask for them: no `request_login`, no `request_secret`, no asking in chat. Do the work another way, or say plainly what you can't do without them. If the user's own message asks for one again, `request_login` works for that request.",
        logins::list_names(&titles)
    ))
}

/// Decline `services` (key, title) for the whole team. Every waiting login
/// card for one of them, and every secret card that means one, is put away
/// as "Not needed". Returns the receipt and the cards to emit.
pub fn decline_all(
    services: &[(String, String)],
    now: i64,
) -> Result<(Receipt, Vec<AgentMessage>), CommandError> {
    if services.is_empty() {
        return Err(CommandError::expected("Nothing to skip."));
    }
    let mut messages = Vec::new();
    let mut closed: Vec<(String, Closed)> = Vec::new();
    let keys: Vec<&str> = services.iter().map(|(k, _)| k.as_str()).collect();
    for agent in store::list().unwrap_or_default() {
        let mut touched = false;
        for a in store::pending_approvals(&agent.id).unwrap_or_default() {
            let matched = match (&a.login, &a.secret) {
                (Some(l), _) => Some(key_of(l)),
                (None, Some(s)) => logins::match_service(&s.name)
                    .or_else(|| logins::match_service(&format!("{} {}", s.name, s.purpose)))
                    .map(|x| x.id.to_string()),
                _ => None,
            };
            let Some(k) = matched.filter(|k| keys.contains(&k.as_str())) else {
                continue;
            };
            // One being answered (a sign-in finishing) keeps that answer.
            let Some(_claim) =
                super::answer_gate::try_claim(&agent.id, &a.request_id, logins::NOT_NEEDED)
            else {
                continue;
            };
            logins::clear_flow(&a.request_id);
            if let Some(m) = store::deny_with_note(&agent.id, &a.request_id, logins::NOT_NEEDED)? {
                messages.push(m);
            }
            touched = true;
            // Only a login card comes back on an Undo; a secret card was
            // already the older way of asking.
            if a.login.is_some() {
                closed.push((
                    k,
                    Closed {
                        agent_id: agent.id.clone(),
                        request_id: a.request_id.clone(),
                    },
                ));
            }
        }
        if touched {
            store::refresh_pending(&agent.id);
        }
    }
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved = read();
        for (k, title) in services {
            let mine: Vec<Closed> = closed
                .iter()
                .filter(|(ck, _)| ck == k)
                .map(|(_, c)| c.clone())
                .collect();
            match saved.services.iter_mut().find(|d| &d.key == k) {
                Some(d) => {
                    d.declined_at = now;
                    d.closed = mine;
                }
                None => saved.services.push(Declined {
                    key: k.clone(),
                    title: title.clone(),
                    declined_at: now,
                    closed: mine,
                }),
            }
        }
        write(&saved)?;
    }
    let titles: Vec<String> = services.iter().map(|(_, t)| t.clone()).collect();
    let them = if titles.len() == 1 { "it" } else { "them" };
    Ok((
        Receipt {
            keys: services.iter().map(|(k, _)| k.clone()).collect(),
            line: format!(
                "Not connecting {}. No agent will ask for {them} again.",
                logins::list_names(&titles)
            ),
            closed: closed.len(),
        },
        messages,
    ))
}

/// Turn `key` back on. Within [`RESTORE_WINDOW_MS`] of the decline, the
/// login cards it put away are handed back (agent id + the request), to be
/// raised again as fresh cards.
pub fn turn_back_on(
    key: &str,
    now: i64,
) -> Result<Vec<(store::Agent, LoginRequest)>, CommandError> {
    let removed = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved = read();
        let Some(at) = saved.services.iter().position(|d| d.key == key) else {
            return Ok(Vec::new());
        };
        let d = saved.services.remove(at);
        saved.mark_on(key, now);
        write(&saved)?;
        d
    };
    if now - removed.declined_at > RESTORE_WINDOW_MS {
        return Ok(Vec::new());
    }
    let mut back = Vec::new();
    for c in removed.closed {
        let Ok(agent) = store::get(&c.agent_id) else {
            continue;
        };
        let Ok(Some(a)) = store::find_approval(&c.agent_id, &c.request_id) else {
            continue;
        };
        // Answered as the decline left it: anything else is the user's own later answer.
        if a.status != ApprovalStatus::Denied || a.note.as_deref() != Some(logins::NOT_NEEDED) {
            continue;
        }
        if let Some(mut l) = a.login {
            l.flow = None;
            back.push((agent, l));
        }
    }
    Ok(back)
}

/// Turn `key` back on without bringing any card back ("What it can reach",
/// Settings): agents may simply ask again.
pub fn forget(key: &str) -> Result<(), CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut saved = read();
    let before = saved.services.len();
    saved.services.retain(|d| d.key != key);
    if saved.services.len() != before {
        saved.mark_on(key, store::now_ms());
        write(&saved)?;
        tracing::info!(key, "turned a declined service back on");
    }
    Ok(())
}

/* ------------------------------------------------------- with the app */

fn emit_all(app: &AppHandle, messages: &[AgentMessage]) {
    for m in messages {
        let _ = app.emit(runner::EVENT_MESSAGE, m);
    }
    super::notify::refresh_badge(app);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
}

/// Decline these services for the team, from either device.
pub fn decline(app: &AppHandle, services: &[(String, String)]) -> Result<Receipt, CommandError> {
    let (receipt, messages) = decline_all(services, store::now_ms())?;
    tracing::info!(keys = ?receipt.keys, closed = receipt.closed, "declined services");
    emit_all(app, &messages);
    Ok(receipt)
}

/// The services on these rows of "What your team needs" (or all of them).
pub fn rows(keys: Option<&[String]>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for need in logins::team(None).needs {
        if keys.is_some_and(|k| !k.contains(&need.key)) {
            continue;
        }
        for card in need
            .cards
            .iter()
            .filter(|c| c.state == logins::CardState::Waiting)
        {
            let k = key(&card.service, &card.title);
            if !out.iter().any(|(x, _)| x == &k) {
                out.push((k, card.title.clone()));
            }
        }
    }
    out
}

/// The service a login card asks for, declined for the team.
pub fn decline_card(
    app: &AppHandle,
    agent_id: &str,
    request_id: &str,
) -> Result<Receipt, CommandError> {
    let r = logins::pending_login(agent_id, request_id)?;
    decline(app, &[(key_of(&r), r.title.clone())])
}

/// Undo / "Turn back on", from either device.
pub fn undo(app: &AppHandle, keys: &[String]) -> Result<usize, CommandError> {
    let mut restored = 0;
    for k in keys {
        for (agent, l) in turn_back_on(k, store::now_ms())? {
            logins::record_card(app, &agent, l)?;
            restored += 1;
        }
    }
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::engine::Engine;

    fn with_root<F: FnOnce()>(f: F) {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        store::set_root_for_tests(None);
    }

    fn agent(name: &str) -> store::Agent {
        let a = store::create(store::NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        store::update(&a.id, |x| x.engine = Engine::Claude).unwrap()
    }

    fn card(agent: &store::Agent, service: &str) -> String {
        let r = logins::build(
            agent,
            &logins::Ask {
                service: service.into(),
                account_hint: None,
                scopes: vec![],
                why: "Reconcile the month".into(),
                quiet: false,
            },
        )
        .unwrap();
        logins::store_card(agent, r).unwrap()
    }

    #[test]
    fn unknown_apps_are_declined_by_title_never_as_other() {
        assert_eq!(key("other", " Acme Bank "), "other:acme bank");
        assert_eq!(key("gmail", "Gmail"), "gmail");
    }

    #[test]
    fn a_decline_is_kept_closes_every_agents_ask_and_tells_them() {
        with_root(|| {
            let books = agent("Bookkeeper");
            let chief = agent("Planner");
            let a = card(&books, "Acme Bank");
            let b = card(&chief, "Acme Bank");
            let other = card(&chief, "Notetaker Pro");
            assert_eq!(prompt_section(), None);

            let services = vec![("other:acme bank".to_string(), "Acme Bank".to_string())];
            let (receipt, messages) = decline_all(&services, 1_000).unwrap();
            assert_eq!(receipt.closed, 2);
            assert_eq!(messages.len(), 2);
            assert_eq!(
                receipt.line,
                "Not connecting Acme Bank. No agent will ask for it again."
            );
            for (who, id) in [(&books, &a), (&chief, &b)] {
                let ap = store::find_approval(&who.id, id).unwrap().unwrap();
                assert_eq!(ap.status, ApprovalStatus::Denied);
                assert_eq!(ap.note.as_deref(), Some(logins::NOT_NEEDED));
            }
            // A different unknown app is untouched.
            let o = store::find_approval(&chief.id, &other).unwrap().unwrap();
            assert_eq!(o.status, ApprovalStatus::Pending);

            // Persisted, and in every agent's app-owned prompt.
            let kept = list();
            assert_eq!(kept.len(), 1);
            assert_eq!(kept[0].closed.len(), 2);
            let section = prompt_section().unwrap();
            assert!(section.contains("chose not to connect Acme Bank"));
            assert!(section.contains("Do the work another way"));
        });
    }

    #[test]
    fn a_declined_service_is_never_asked_for_again() {
        with_root(|| {
            let books = agent("Bookkeeper");
            decline_all(&[("gmail".into(), "Gmail".into())], 1_000).unwrap();
            let ask = logins::Ask {
                service: "gmail".into(),
                account_hint: None,
                scopes: vec![],
                why: "Read invoices".into(),
                quiet: false,
            };
            let reply = logins::declined_reply(&books, &ask).unwrap();
            assert!(reply.contains("chose not to connect Gmail"));
            assert!(refusal_for_text("gmail_app_password for invoices").is_some());
            assert!(refusal_for_text("linkedin token").is_none());
            // Nothing new was put in its chat.
            assert!(store::pending_approvals(&books.id).unwrap().is_empty());
        });
    }

    #[test]
    fn undo_soon_brings_the_cards_back_later_only_lets_them_ask() {
        with_root(|| {
            let books = agent("Bookkeeper");
            let id = card(&books, "Acme Bank");
            let key = "other:acme bank".to_string();
            decline_all(&[(key.clone(), "Acme Bank".into())], 10_000).unwrap();
            let back = turn_back_on(&key, 10_000 + 3_000).unwrap();
            assert_eq!(back.len(), 1);
            assert_eq!(back[0].0.id, books.id);
            assert_eq!(back[0].1.title, "Acme Bank");
            assert!(list().is_empty());
            assert_eq!(prompt_section(), None);
            let _ = id;

            // Declined again, turned back on from Settings a day later.
            card(&books, "Acme Bank");
            decline_all(&[(key.clone(), "Acme Bank".into())], 10_000).unwrap();
            let later = turn_back_on(&key, 10_000 + RESTORE_WINDOW_MS + 1).unwrap();
            assert!(later.is_empty());
            assert!(list().is_empty());
            let ask = logins::Ask {
                service: "Acme Bank".into(),
                account_hint: None,
                scopes: vec![],
                why: "x".into(),
                quiet: false,
            };
            assert!(logins::declined_reply(&books, &ask).is_none());
        });
    }
}
