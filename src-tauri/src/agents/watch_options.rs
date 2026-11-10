//! What the phone's "When…" composer may offer for one agent
//! (`agents.watch.options`): the raw lists the desk's composer reads to know
//! which apps a check could read through (our own connections given to this
//! agent, then Claude Code's own servers; `whenApps` in
//! packages/companion-protocol reads them, on desk and phone alike), and the
//! folders on this Mac a phone may pick for a "new file" routine.
//!
//! A phone can't browse or type a path on the Mac: it picks from
//! [`folders`], and a folder off that list is refused
//! ([`refuse_unoffered_folder`]), so a paired phone can't point a routine at
//! an arbitrary place on disk.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use super::watch::Source;
use crate::errors::CommandError;

/// The standard folders offered, under the home folder, when they exist.
const STANDARD: &[&str] = &["Downloads", "Desktop", "Documents"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Folder {
    /// Absolute, as the routine saves it.
    pub path: String,
    /// "~/Downloads".
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// `WhenConnection`s: only what `whenApps` reads, and only this agent's grant.
    pub connections: Vec<Value>,
    /// `WhenClaudeApp`s: Claude Code's own servers (`apps::list`), or none if
    /// Claude Code couldn't list them.
    pub claude_apps: Vec<Value>,
    pub folders: Vec<Folder>,
}

/// "~/Downloads" for a path under `home`.
fn label(path: &str, home: &str) -> String {
    if path == home {
        "~".into()
    } else if let Some(rest) = path.strip_prefix(&format!("{home}/")) {
        format!("~/{rest}")
    } else {
        path.to_string()
    }
}

/// The folders a phone may pick: Downloads, Desktop and Documents when they
/// exist, then every folder a "new file" routine on this Mac already
/// watches (so an edit keeps its own), each once.
pub fn folders_in(home: &Path, watched: &[String]) -> Vec<Folder> {
    let home_s = home.to_string_lossy().trim_end_matches('/').to_string();
    let mut out: Vec<Folder> = Vec::new();
    let mut add = |path: String| {
        let path = path.trim_end_matches('/').to_string();
        if path.is_empty() || out.iter().any(|f| f.path == path) {
            return;
        }
        out.push(Folder {
            label: label(&path, &home_s),
            path,
        });
    };
    for name in STANDARD {
        let p = home.join(name);
        if p.is_dir() {
            add(p.to_string_lossy().into_owned());
        }
    }
    for w in watched {
        add(w.clone());
    }
    out
}

/// Every folder a "new file" routine watches, on any agent.
fn watched_folders() -> Vec<String> {
    super::store::list()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|a| a.check_ins.into_iter())
        .filter_map(|c| match c.watch.map(|w| w.source) {
            Some(Source::NewFile { folder }) => Some(folder),
            _ => None,
        })
        .collect()
}

/// The folders a phone may pick on this Mac.
pub fn folders() -> Vec<Folder> {
    match dirs::home_dir() {
        Some(home) => folders_in(&home, &watched_folders()),
        None => Vec::new(),
    }
}

/// A "new file" source from the phone must name one of `offered`; anything
/// else is fine as it is (the Mac's own `watch::validate` still runs).
pub fn refuse_unoffered_folder(source: &Source, offered: &[Folder]) -> Result<(), CommandError> {
    if let Source::NewFile { folder } = source {
        let folder = folder.trim().trim_end_matches('/');
        if !offered.iter().any(|f| f.path == folder) {
            return Err(CommandError::expected(
                "Pick one of the folders your Mac offers. Another folder is set on the Mac.",
            ));
        }
    }
    Ok(())
}

/// One of our connections as `whenApps` reads it, with only `agent_id`'s grant.
fn connection_for(c: &super::connections::Connection, agent_id: &str) -> Value {
    let kind = match c.kind {
        super::connections::Kind::Oauth { .. } => "oauth",
        super::connections::Kind::ClaudeAi { .. } => "claude_ai",
        _ => "other",
    };
    let grants: Vec<Value> = c
        .grants
        .iter()
        .filter(|g| g.agent_id == agent_id)
        .map(|g| json!({ "agentId": g.agent_id }))
        .collect();
    json!({
        "service": c.service,
        "title": c.title,
        "account": c.account,
        "kind": { "type": kind },
        "serverKey": c.server_key,
        "needsSignIn": c.needs_sign_in,
        "grants": grants,
    })
}

/// What the composer may offer for `agent_id`. Either app list failing just
/// leaves its apps out, as on the desk.
pub async fn options(agent_id: &str) -> Result<Options, CommandError> {
    let agent_id = agent_id.to_string();
    let (connections, folders) = tokio::task::spawn_blocking({
        let agent_id = agent_id.clone();
        move || {
            super::store::get(&agent_id)?;
            let connections: Vec<Value> = super::connections::list()
                .unwrap_or_default()
                .iter()
                .map(|c| connection_for(c, &agent_id))
                .collect();
            Ok::<_, CommandError>((connections, folders()))
        }
    })
    .await
    .map_err(super::err_other)??;
    let claude_apps = match super::apps::list().await {
        Ok(apps) => apps
            .connected
            .iter()
            .map(|a| serde_json::to_value(a).unwrap_or(Value::Null))
            .filter(|v| !v.is_null())
            .collect(),
        Err(_) => Vec::new(),
    };
    Ok(Options {
        connections,
        claude_apps,
        folders,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_the_standard_folders_that_exist_then_watched_ones_once() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("Downloads")).unwrap();
        std::fs::create_dir(home.path().join("Documents")).unwrap();
        let h = home.path().to_string_lossy().to_string();
        let got = folders_in(
            home.path(),
            &[
                format!("{h}/Downloads/"),
                format!("{h}/Invoices"),
                "/Volumes/Share/in".into(),
            ],
        );
        let labels: Vec<&str> = got.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "~/Downloads",
                "~/Documents",
                "~/Invoices",
                "/Volumes/Share/in"
            ]
        );
        assert_eq!(got[0].path, format!("{h}/Downloads"));
    }

    #[test]
    fn a_phone_folder_must_be_one_offered() {
        let offered = vec![Folder {
            path: "/Users/sam/Downloads".into(),
            label: "~/Downloads".into(),
        }];
        let ok = Source::NewFile {
            folder: "/Users/sam/Downloads/".into(),
        };
        assert!(refuse_unoffered_folder(&ok, &offered).is_ok());
        let other = Source::NewFile {
            folder: "/Users/sam/.ssh".into(),
        };
        assert!(refuse_unoffered_folder(&other, &offered).is_err());
        let not_a_folder = Source::GithubMentions;
        assert!(refuse_unoffered_folder(&not_a_folder, &[]).is_ok());
    }

    #[test]
    fn a_connection_carries_only_this_agents_grant_and_no_token() {
        let c: super::super::connections::Connection = serde_json::from_value(json!({
            "id": "c1", "service": "gmail", "title": "Gmail", "account": "sam@example.com",
            "kind": { "type": "oauth", "serverUrl": "https://mcp.example.com/mcp" },
            "serverKey": "gmail", "createdAt": 0,
            "grants": [
                { "agentId": "a1", "access": "read", "grantedAt": 0 },
                { "agentId": "b2", "access": "full", "grantedAt": 0 }
            ]
        }))
        .unwrap();
        let v = connection_for(&c, "a1");
        assert_eq!(v["kind"]["type"], "oauth");
        assert_eq!(v["grants"], json!([{ "agentId": "a1" }]));
        assert!(v.get("serverUrl").is_none() && v["kind"].get("serverUrl").is_none());
    }
}
