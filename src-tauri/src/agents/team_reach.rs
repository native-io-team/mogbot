//! "Can you read my Gmail?" answered from what the app knows, never a guess.
//!
//! Observed (2026-11-07): the Chief told the owner it couldn't read Gmail
//! while another agent on the team was reading it. Each agent only knew its
//! own "What you can do here" list, and the prompt said not to claim what
//! wasn't listed, so a missing line became "can't". The app knows more: per
//! agent, the connectors its engine reported at its last turn
//! (`capabilities`), the connections granted to it (`connections`), and
//! whether its turns get the user's Chrome or the agents' browser for the
//! service's site (`access_chain`'s browser step). [`ways`] reads exactly
//! those, for the caller and then the team, and is what `who_can_reach`
//! answers and what `follow_up` checks a "can't" against.

use super::capabilities::Capabilities;
use super::logins::{self, Connector, Service};
use super::store::Agent;

/// What the app knows about one agent and one service.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    /// The engine listed the service's connector at the agent's last turn:
    /// `Some(true)` connected, `Some(false)` needing sign-in.
    pub connector: Option<bool>,
    /// Connections granted to it that work: "Gmail (sam@example.test)".
    pub connections: Vec<String>,
    /// Its turns get the user's Chrome, and the service has a site.
    pub chrome: bool,
    /// Its turns get the agents' own browser, and the service has a site.
    pub agents_browser: bool,
}

/// Whether `caps` lists a connector called `name` (as connected, or as
/// needing sign-in), unless the agent is kept from it (`blocked`). Pure.
pub fn connector_seen(caps: Option<&Capabilities>, name: &str, blocked: &[String]) -> Option<bool> {
    let name = name.to_ascii_lowercase();
    if blocked
        .iter()
        .any(|b| b.to_ascii_lowercase().contains(&name))
    {
        return None;
    }
    let caps = caps?;
    let listed = |what: &str| {
        caps.lines.iter().any(|l| {
            l.what == what
                && l.detail
                    .to_ascii_lowercase()
                    .split([',', '.'])
                    .flat_map(|p| p.split(" and "))
                    .any(|p| p.trim() == name)
        })
    };
    if listed("Connectors") {
        Some(true)
    } else if listed("Needs sign-in") {
        Some(false)
    } else {
        None
    }
}

/// The ways in, in plain words, best first. Empty: none the app knows of.
/// Pure.
pub fn ways(facts: &Facts, service: &Service) -> Vec<String> {
    let mut out: Vec<String> = facts
        .connections
        .iter()
        .map(|c| format!("connected: {c}"))
        .collect();
    if facts.connector == Some(true) {
        out.push(format!(
            "the {} connector in its engine (as of its last turn)",
            service.title
        ));
    }
    if let Some(site) = service.site {
        if facts.chrome {
            out.push(format!("the user's own Chrome, on {site}"));
        }
        if facts.agents_browser {
            out.push(format!("the agents' browser, on {site}"));
        }
    }
    out
}

fn connector_name(service: &Service) -> &'static str {
    match service.connector {
        Connector::ClaudeAi(name) | Connector::Oauth(name) => name,
        _ => service.title,
    }
}

/// What the app knows about `agent` and `service`, now.
pub fn facts(agent: &Agent, service: &Service) -> Facts {
    Facts {
        connector: connector_seen(
            agent.capabilities.as_ref(),
            connector_name(service),
            &agent.reach.blocked_apps,
        ),
        connections: super::connections::granted_to(&agent.id)
            .into_iter()
            .filter(|(c, _)| c.service == service.id && !c.needs_sign_in)
            .map(|(c, _)| {
                if c.account.is_empty() {
                    c.title
                } else {
                    format!("{} ({})", c.title, c.account)
                }
            })
            .collect(),
        chrome: super::browser::for_turn(agent, false),
        agents_browser: super::connections::agents_browser_for_turn(agent, false),
    }
}

/// Who on the team can reach `service`, the caller first: (name, ways).
/// Only agents with at least one way.
pub fn team(caller: &Agent, service: &Service) -> Vec<(String, Vec<String>)> {
    let mut agents = super::store::list().unwrap_or_default();
    agents.retain(|a| !a.hidden);
    agents.sort_by_key(|a| a.id != caller.id);
    agents
        .iter()
        .map(|a| (a.name.clone(), ways(&facts(a, service), service)))
        .filter(|(_, w)| !w.is_empty())
        .collect()
}

/// The service a name means, from the catalogue.
pub fn service_named(name: &str) -> Option<&'static Service> {
    logins::service(&name.trim().to_ascii_lowercase()).or_else(|| logins::match_service(name))
}

/// `who_can_reach`'s answer for `caller`. `team`: [`team`]'s rows.
pub fn answer(
    caller: &Agent,
    service: &Service,
    team: &[(String, Vec<String>)],
    declined: bool,
) -> String {
    let mut lines = Vec::new();
    if declined {
        lines.push(format!(
            "The user said no to connecting {} for the team. A way that connects nothing (their own Chrome, where they're signed in) still counts; don't raise a card for it again.",
            service.title
        ));
    }
    let mine = team.iter().find(|(n, _)| *n == caller.name);
    match mine {
        Some((_, ways)) => lines.push(format!(
            "You can reach {}: {}. Use it.",
            service.title,
            ways.join("; ")
        )),
        None => lines.push(format!(
            "You have no way into {} the app knows of yet.",
            service.title
        )),
    }
    let others: Vec<String> = team
        .iter()
        .filter(|(n, _)| *n != caller.name)
        .map(|(n, w)| format!("{n}: {}", w.join("; ")))
        .collect();
    if others.is_empty() {
        if mine.is_none() {
            lines.push("Nobody else on the team has one either. Don't tell the user it can't be done: call request_login, which tries the browser first and asks them only if nothing works.".into());
        }
    } else {
        lines.push(format!("On the team: {}.", others.join(". ")));
        if mine.is_none() {
            lines.push("Hand the work to one of them with message_agent rather than saying it can't be done.".into());
        }
    }
    lines.join(" ")
}

pub const TOOL: &str = "who_can_reach";

pub const DESCRIPTION: &str = "Which agents on the team can reach an app or site (Gmail, Slack, Linear…) and how, from what the app itself knows: connectors their engine listed, connections granted, the user's Chrome or the agents' browser. Call it before you tell the user you or the team can't read, check or use something, and hand the work to whoever can.";

pub fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "service": { "type": "string", "description": "The app or site: \"gmail\", \"slack\", \"Google Calendar\"." }
        },
        "required": ["service"]
    })
}

/// The tool, for `caller`.
pub fn call(caller: &Agent, args: &serde_json::Value) -> Result<String, String> {
    let asked = args
        .get("service")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if asked.is_empty() {
        return Err("Name the app or site, e.g. \"gmail\".".into());
    }
    let Some(service) = service_named(asked) else {
        return Ok(format!(
            "The app doesn't know {asked} by name, so it can't say who reaches it. Try it (a connection, a command on this Mac, the browser), and call request_login if nothing works."
        ));
    };
    let rows = team(caller, service);
    let key = super::access_check::key_of(service.id, service.title);
    let declined = super::declined::list().iter().any(|d| d.key == key);
    Ok(answer(caller, service, &rows, declined))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::capabilities::Line;

    fn caps(lines: &[(&str, &str)]) -> Capabilities {
        Capabilities {
            seen_at: 1,
            lines: lines
                .iter()
                .map(|(w, d)| Line {
                    what: w.to_string(),
                    detail: d.to_string(),
                })
                .collect(),
        }
    }

    fn gmail() -> &'static Service {
        service_named("gmail").unwrap()
    }

    #[test]
    fn a_connector_counts_only_as_listed_and_not_when_kept_from_it() {
        let c = caps(&[
            ("Connectors", "Gmail, Linear and Google Calendar"),
            (
                "Needs sign-in",
                "Notion. Connect them in Claude Code to use them here.",
            ),
        ]);
        assert_eq!(connector_seen(Some(&c), "Gmail", &[]), Some(true));
        assert_eq!(connector_seen(Some(&c), "Google Calendar", &[]), Some(true));
        assert_eq!(connector_seen(Some(&c), "Notion", &[]), Some(false));
        assert_eq!(connector_seen(Some(&c), "Slack", &[]), None);
        assert_eq!(
            connector_seen(Some(&c), "Gmail", &["claude.ai Gmail".into()]),
            None
        );
        assert_eq!(connector_seen(None, "Gmail", &[]), None);
    }

    /// The observed case: the Chief has no Gmail line, Inbox does.
    #[test]
    fn the_answer_names_who_can_and_says_to_hand_it_over() {
        let chief: Agent = serde_json::from_value(serde_json::json!({
            "id": "m", "name": "Chief of Staff", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        let inbox_facts = Facts {
            connector: Some(true),
            ..Default::default()
        };
        let rows = vec![("Inbox".to_string(), ways(&inbox_facts, gmail()))];
        let said = answer(&chief, gmail(), &rows, false);
        assert!(said.contains("You have no way into Gmail"), "{said}");
        assert!(said.contains("Inbox: the Gmail connector"), "{said}");
        assert!(said.contains("message_agent"), "{said}");
        // With the user's Chrome itself, it's told to use it.
        let own = Facts {
            chrome: true,
            ..Default::default()
        };
        let rows = vec![
            ("Chief of Staff".to_string(), ways(&own, gmail())),
            ("Inbox".to_string(), ways(&inbox_facts, gmail())),
        ];
        let said = answer(&chief, gmail(), &rows, false);
        assert!(
            said.starts_with("You can reach Gmail: the user's own Chrome, on mail.google.com"),
            "{said}"
        );
        // Nobody: never "can't", the chain instead.
        let said = answer(&chief, gmail(), &[], false);
        assert!(said.contains("request_login"), "{said}");
    }

    #[test]
    fn ways_are_listed_best_first() {
        let f = Facts {
            connector: Some(true),
            connections: vec!["Gmail (sam@example.test)".into()],
            chrome: true,
            agents_browser: true,
        };
        let w = ways(&f, gmail());
        assert_eq!(w.len(), 4);
        assert!(w[0].starts_with("connected: Gmail"));
        assert!(ways(
            &Facts {
                connector: Some(false),
                ..Default::default()
            },
            gmail()
        )
        .is_empty());
    }
}
