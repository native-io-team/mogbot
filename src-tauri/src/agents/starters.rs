//! A new agent speaks first: a short welcome in its own voice and three
//! first tasks the user can tap, chosen from what it can already reach.
//!
//! Like the Chief's greeting (`CHIEF_GREETING`), the welcome is a stored
//! message, not a model turn. The tasks come from what is already known when
//! the agent is made, never from a call made to find them:
//!
//! - **Ideas** its creator wrote: the sealed draft ("Describe the agent you
//!   want", `draft.rs`), the Chief's `create_agent`, or a ready-made agent's
//!   own buttons (`templates.rs`). Each names the apps it needs.
//! - **Its routines**: the first one's first step, done now.
//! - **Its project**, when it is bound to one: always reachable.
//! - **The apps its job needs**, each checked against what the app knows
//!   (`team_reach::facts`: a connection granted to it, a connector its engine
//!   listed; for GitHub, `gh` signed in on this Mac). A browser being switched
//!   on doesn't count: that says nothing about being signed in.
//!
//! A task is offered only when every app it needs is reachable. When the job
//! needs one that isn't, one of the three is the ask to connect it, first.
//! What's left is filled with tasks that need nothing.
//!
//! Tapping one sends it as the user's message. They are kept beside the
//! agent (`starters.json` in its home) until the user sends anything
//! (`runner::record`), then removed: one look, never a standing menu.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::store::{self, MessageKind};

/// How many are offered.
pub const COUNT: usize = 3;
/// A starter's words, in characters: a button, not a brief.
pub const MAX_TEXT: usize = 70;
/// Ideas a creator may offer to choose from.
pub const MAX_IDEAS: usize = 6;
/// The welcome, in characters: one or two short sentences.
pub const MAX_WELCOME: usize = 240;

const FILE: &str = "starters.json";

/// One tappable first task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Starter {
    /// The button, and exactly what it sends.
    pub text: String,
    /// The app this one asks to connect: the login ask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<String>,
}

/// A first task a creator suggested, with the apps it needs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    pub text: String,
    #[serde(default)]
    pub needs: Vec<String>,
}

/// An app the job needs, and whether the app knows of a way in.
#[derive(Debug, Clone, PartialEq)]
pub struct Need {
    /// As said to the user ("Gmail", "my email").
    pub title: String,
    pub reachable: bool,
}

/// Everything the choice is made from. Nothing here is fetched.
#[derive(Debug, Clone, Default)]
pub struct Known {
    pub ideas: Vec<Idea>,
    /// Its routines' first steps, in order.
    pub routines: Vec<String>,
    pub needs: Vec<Need>,
    /// Its bound project's folder name.
    pub project: Option<String>,
}

/// Always within reach: they need nothing but the conversation.
const ANYTIME: [&str; 3] = [
    "What do you need from me to start?",
    "Walk me through how you’ll work",
    "Check in with me tomorrow at 9",
];

fn clean(text: &str, max: usize) -> String {
    let s: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    s.trim().to_string().chars().take(max).collect::<String>()
}

/// A starter's words, or `None` when they don't make a button: empty, or
/// too long to read at a glance (cut, they'd send something else).
fn button(text: &str) -> Option<String> {
    let t = clean(text, usize::MAX);
    let t = t.trim_end_matches(['.', ' ']).to_string();
    (!t.is_empty() && t.chars().count() <= MAX_TEXT).then_some(t)
}

fn key(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Whether `need` is one the app knows a way into.
fn reaches(needs: &[Need], need: &str) -> bool {
    let need = key(need);
    needs.iter().any(|n| n.reachable && key(&n.title) == need)
}

/// The three starters for `known`. Pure.
pub fn choose(known: &Known) -> Vec<Starter> {
    let mut out: Vec<Starter> = Vec::new();
    let push = |out: &mut Vec<Starter>, text: Option<String>, connect: Option<String>| {
        let Some(text) = text else { return };
        if out.len() < COUNT && !out.iter().any(|s| key(&s.text) == key(&text)) {
            out.push(Starter { text, connect });
        }
    };
    // Its job needs an app nobody can reach yet: asking for it comes first.
    let missing = known.needs.iter().find(|n| !n.reachable);
    if let Some(m) = missing {
        push(
            &mut out,
            button(&format!("Help me connect {}", m.title)),
            Some(m.title.clone()),
        );
    }
    for idea in known.ideas.iter().take(MAX_IDEAS) {
        if idea.needs.iter().all(|n| reaches(&known.needs, n)) {
            push(&mut out, button(&idea.text), None);
        }
    }
    // A routine's first step can need any of the job's apps: only when all
    // of them are reachable.
    if missing.is_none() {
        if let Some(first) = known.routines.first() {
            let sentence = first.split(['\n', '.']).next().unwrap_or("");
            push(&mut out, button(sentence), None);
        }
    }
    if let Some(p) = known.project.as_deref().map(|p| clean(p, 40)) {
        if !p.is_empty() {
            push(
                &mut out,
                button(&format!("Look over {p} and tell me where to start")),
                None,
            );
        }
    }
    for n in known.needs.iter().filter(|n| n.reachable) {
        push(
            &mut out,
            button(&format!("What’s new in {}?", n.title)),
            None,
        );
    }
    for text in ANYTIME {
        push(&mut out, button(text), None);
    }
    out
}

/// The welcome: what its creator wrote, else its name and role.
pub fn welcome(name: &str, role: &str, written: Option<&str>) -> String {
    if let Some(w) = written.map(|w| clean(w, MAX_WELCOME)) {
        if !w.is_empty() {
            return w;
        }
    }
    let role = clean(role, 200);
    let role = role.trim_end_matches('.');
    if role.is_empty() {
        format!("Hi, I’m {}. Here’s where we could start.", clean(name, 40))
    } else {
        format!("Hi, I’m {}. {role}.", clean(name, 40))
    }
}

/* ------------------------------------------------------------- stored */

/// Its starters, while the user hasn't said anything yet.
pub fn load(agent_id: &str) -> Vec<Starter> {
    let Ok(home) = store::agent_home(agent_id) else {
        return Vec::new();
    };
    std::fs::read(home.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(agent_id: &str, starters: &[Starter]) -> Result<(), String> {
    let home = store::agent_home(agent_id).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let tmp = home.join(format!("{FILE}.tmp"));
    let body = serde_json::to_vec(starters).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, home.join(FILE)).map_err(|e| e.to_string())
}

/// The user said something: the starters go. Whether there were any.
pub fn clear(agent_id: &str) -> bool {
    store::agent_home(agent_id)
        .map(|home| std::fs::remove_file(home.join(FILE)).is_ok())
        .unwrap_or(false)
}

/* ---------------------------------------------------------- at create */

/// What its creator said about its first open.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    /// Its welcome, in its own voice.
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub starters: Vec<Idea>,
    /// Apps its job needs ("Gmail").
    #[serde(default)]
    pub apps: Vec<String>,
}

/// Mail services an "email app" need is met by.
const MAIL: [&str; 2] = ["gmail", "outlook"];

/// Whether the app knows a way for `agent` into `service`: a working
/// connection granted to it or its engine's connector; for GitHub, `gh`
/// signed in on this Mac.
fn reachable(agent: &store::Agent, service: &super::logins::Service, gh: bool) -> bool {
    if service.id == "github" && gh {
        return true;
    }
    let facts = super::team_reach::facts(agent, service);
    !facts.connections.is_empty() || facts.connector == Some(true)
}

/// What's known about `agent` now, with `opening`.
async fn known(agent: &store::Agent, opening: &Opening) -> Known {
    let template = agent.template.as_deref().and_then(super::templates::find);
    let mut ideas = opening.starters.clone();
    let mut apps: Vec<String> = opening.apps.clone();
    for i in &ideas {
        for n in &i.needs {
            if !apps.iter().any(|a| key(a) == key(n)) {
                apps.push(n.clone());
            }
        }
    }
    let mail = template.is_some_and(|t| t.needs.as_deref() == Some("mail"));
    if let Some(t) = template {
        // A ready-made agent's own buttons, those that send as they are.
        let needs: Vec<String> = if mail {
            vec!["my email".into()]
        } else {
            Vec::new()
        };
        ideas.extend(t.starters.iter().filter(|s| s.send).map(|s| Idea {
            text: s.text.clone(),
            needs: needs.clone(),
        }));
    }
    let gh = if apps.iter().any(|a| key(a) == "github") {
        super::access_chain::gh_login().await.is_some()
    } else {
        false
    };
    let mut needs: Vec<Need> = apps
        .iter()
        .take(super::draft::MAX_APPS)
        .map(|a| Need {
            title: clean(a, 40),
            reachable: super::team_reach::service_named(a).is_some_and(|s| reachable(agent, s, gh)),
        })
        .filter(|n| !n.title.is_empty())
        .collect();
    if mail {
        needs.push(Need {
            title: "my email".into(),
            reachable: MAIL
                .iter()
                .filter_map(|id| super::logins::service(id))
                .any(|s| reachable(agent, s, false)),
        });
    }
    Known {
        ideas,
        routines: agent.check_ins.iter().map(|c| c.note.clone()).collect(),
        needs,
        project: agent.project.as_deref().and_then(|p| {
            std::path::Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        }),
    }
}

/// A new agent's first open: its welcome in its chat and, with `offer`, its
/// starters kept beside it (one handed a first task is already busy). Never
/// fatal: without them the chat is only emptier.
pub async fn open(app: &AppHandle, agent_id: &str, opening: &Opening, offer: bool) {
    let Ok(agent) = store::get(agent_id) else {
        return;
    };
    if agent.is_main {
        return;
    }
    if offer {
        let starters = choose(&known(&agent, opening).await);
        if let Err(e) = save(agent_id, &starters) {
            tracing::warn!("[Agents] Couldn't keep {}'s starters: {e}", agent.name);
        }
    }
    let text = welcome(&agent.name, &agent.role, opening.welcome.as_deref());
    let message = super::runner::new_message(agent_id, MessageKind::Agent, text);
    if let Err(e) = super::runner::record_quietly(app, message) {
        tracing::warn!("[Agents] Couldn't write {}'s welcome: {e}", agent.name);
    }
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
}

/// `create_agent`'s `welcome`, `starters` and `apps`.
pub fn opening_arg(args: &serde_json::Value) -> Opening {
    let str_of = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let list = |v: Option<&serde_json::Value>| -> Vec<String> {
        v.and_then(serde_json::Value::as_array)
            .map(|a| a.iter().filter_map(str_of).collect())
            .unwrap_or_default()
    };
    Opening {
        welcome: args.get("welcome").and_then(str_of),
        starters: args
            .get("starters")
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| match s {
                        serde_json::Value::String(t) => Some(Idea {
                            text: t.clone(),
                            needs: Vec::new(),
                        }),
                        serde_json::Value::Object(_) => Some(Idea {
                            text: s.get("text").and_then(str_of)?,
                            needs: list(s.get("needs")),
                        }),
                        _ => None,
                    })
                    .take(MAX_IDEAS)
                    .collect()
            })
            .unwrap_or_default(),
        apps: list(args.get("apps")),
    }
}

#[cfg(test)]
#[path = "starters_tests.rs"]
mod tests;
