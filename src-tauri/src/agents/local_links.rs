//! Links in an agent's reply to a server on this Mac.
//!
//! An agent that ran a project in the background writes
//! `[after](http://localhost:3401)`. On the desk that's a link to a page the
//! user can't see beside the chat; on the phone it's a dead link. So the
//! link comes out of the text and rides on the message as a `LocalLink`:
//!
//! - **Known**: something the app knows serves a project on that port (a
//!   preview proxy, a dev server the agent's own turn started in one of the
//!   user's projects or its copy). The card's Preview opens the pane beside
//!   the chat on that folder, and the phone gets Watch live.
//! - **Unknown**: a plain "running on this Mac" chip. Never a dead link.
//!
//! What the text keeps: a markdown link's own words, or "the preview below"
//! in place of a bare address. Code (inline or fenced) is left alone: an
//! address in code is something the agent is showing, not a link.

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// One reply's links to this Mac, at most: past it the rest stay as text.
pub const MAX_LINKS: usize = 8;
/// What a bare address becomes in the text.
pub const BARE_WORDS: &str = "the preview below";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalLink {
    pub url: String,
    pub label: String,
    pub port: u16,
    /// The folder the app knows serves on this port (a project or a copy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The user's project that folder is, or is a copy of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub copy: bool,
}

/// What the app knows serves a port.
#[derive(Debug, Clone, PartialEq)]
pub struct Known {
    pub path: String,
    pub project: String,
    pub copy: bool,
}

static LINK: LazyLock<regex::Regex> = LazyLock::new(|| {
    // A markdown link, an autolink, or a bare address, to this Mac.
    regex::Regex::new(
        r"(?i)\[([^\]\n]{0,200})\]\((https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:/[^\s)]*)?)\)|<(https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:/[^\s>]*)?)>|(https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:/[^\s)\]>`]*)?)",
    )
    .expect("local link pattern")
});

/// The port a local address names (80 / 443 when it names none).
pub fn port_of(url: &str) -> Option<u16> {
    let parsed = url::Url::parse(url).ok()?;
    parsed.port_or_known_default()
}

fn host_port(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => url.to_string(),
        })
        .unwrap_or_else(|| url.to_string())
}

/// Byte ranges of code (fenced blocks and inline spans), left untouched.
fn code_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"```") {
            let end = text[i + 3..]
                .find("```")
                .map(|e| i + 3 + e + 3)
                .unwrap_or(text.len());
            out.push((i, end));
            i = end;
        } else if bytes[i] == b'`' {
            let end = text[i + 1..]
                .find(['`', '\n'])
                .map(|e| i + 1 + e + 1)
                .unwrap_or(text.len());
            out.push((i, end));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// A trailing sentence mark isn't part of a bare address.
fn trim_bare(url: &str) -> &str {
    url.trim_end_matches(['.', ',', ';', ':', '!', '?'])
}

/// Take the reply's links to this Mac out of its text. `known` says which
/// port the app knows serves a project. Returns the text as it should read
/// and the links, in the order written, one per address.
pub fn rewrite(text: &str, known: impl Fn(u16) -> Option<Known>) -> (String, Vec<LocalLink>) {
    let code = code_ranges(text);
    let in_code = |at: usize| code.iter().any(|(s, e)| at >= *s && at < *e);
    let mut out = String::with_capacity(text.len());
    let mut links: Vec<LocalLink> = Vec::new();
    let mut last = 0;
    for caps in LINK.captures_iter(text) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        if in_code(whole.start()) || links.len() >= MAX_LINKS {
            continue;
        }
        let (url, label, end, words) = if let (Some(label), Some(url)) = (caps.get(1), caps.get(2))
        {
            let label = label.as_str().trim();
            let words = if label.is_empty() {
                None
            } else {
                Some(label.to_string())
            };
            (url.as_str().to_string(), words.clone(), whole.end(), words)
        } else if let Some(url) = caps.get(3) {
            (
                url.as_str().to_string(),
                None,
                whole.end(),
                Some(BARE_WORDS.to_string()),
            )
        } else if let Some(raw) = caps.get(4) {
            let url = trim_bare(raw.as_str());
            (
                url.to_string(),
                None,
                whole.start() + url.len(),
                Some(BARE_WORDS.to_string()),
            )
        } else {
            continue;
        };
        let Some(port) = port_of(&url) else {
            continue;
        };
        let k = known(port);
        // "The preview below" only where a preview shows that address (a
        // project the app knows serves on it). Anything else on this Mac —
        // the agents' own browser, a page an agent asks the user to step
        // into — keeps its short form, so the sentence stays true.
        let words = match words.as_deref() {
            Some(BARE_WORDS) if k.is_none() => Some(host_port(&url)),
            _ => words,
        };
        out.push_str(&text[last..whole.start()]);
        // A line of nothing but links ("[before](…) [after](…)") goes: the
        // chips under the reply carry the same words.
        if !link_only_line(text, whole.start()) {
            out.push_str(words.as_deref().unwrap_or(""));
        }
        last = end;
        let label = label.unwrap_or_else(|| host_port(&url));
        // The same address twice is one chip.
        if links.iter().any(|l| l.url == url) {
            continue;
        }
        links.push(LocalLink {
            label,
            port,
            path: k.as_ref().map(|k| k.path.clone()),
            project: k.as_ref().map(|k| k.project.clone()),
            copy: k.is_some_and(|k| k.copy),
            url,
        });
    }
    if links.is_empty() {
        return (text.to_string(), links);
    }
    out.push_str(&text[last..]);
    (tidy(&out), links)
}

/// Whether the line around `at` holds nothing but links to this Mac,
/// separators and list marks.
fn link_only_line(text: &str, at: usize) -> bool {
    let start = text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = text[at..].find('\n').map(|i| at + i).unwrap_or(text.len());
    let line = &text[start..end];
    let rest = LINK.replace_all(line, "");
    rest.split_whitespace().all(|w| {
        w.chars().all(|c| "-*•|,/·:;()".contains(c))
            || ["and", "or", "vs", "vs.", "&"].contains(&w.to_lowercase().as_str())
    })
}

/// Links taken out leave gaps: "see  and" or a line of nothing but spaces.
fn tidy(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        // Leading indentation (lists, code) stays as it was; doubled spaces
        // after it close up.
        let body = line.trim_start();
        let indent = &line[..line.len() - body.len()];
        let mut closed = String::with_capacity(line.len());
        closed.push_str(indent);
        let mut prev_space = false;
        for ch in body.chars() {
            if ch == ' ' && prev_space {
                continue;
            }
            prev_space = ch == ' ';
            closed.push(ch);
        }
        let closed = closed.trim_end().to_string();
        let blank = closed.trim().is_empty();
        if blank && out.last().is_none_or(|l| l.trim().is_empty()) {
            continue;
        }
        out.push(if blank { String::new() } else { closed });
    }
    out.join("\n").trim().to_string()
}

/// The ports a reply links to on this Mac, before anything is looked up.
pub fn ports_in(text: &str) -> Vec<u16> {
    let (_, links) = rewrite(text, |_| None);
    let mut ports: Vec<u16> = links.into_iter().map(|l| l.port).collect();
    ports.dedup();
    ports
}

/// Which known folder `cwd` is in: the longest folder that contains it.
pub fn folder_for(cwd: &str, folders: &[Known]) -> Option<Known> {
    let cwd = cwd.trim_end_matches('/');
    folders
        .iter()
        .filter(|k| {
            let root = k.path.trim_end_matches('/');
            cwd == root || cwd.starts_with(&format!("{root}/"))
        })
        .max_by_key(|k| k.path.len())
        .cloned()
}

// ============================================================================
// Looking ports up (the app's own state, then what's listening)
// ============================================================================

/// What listens on `port` on this Mac, as (pid, its working folder).
#[cfg(unix)]
async fn listener(port: u16) -> Option<(u32, String)> {
    let mut cmd = tokio::process::Command::new("lsof");
    cmd.args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"]);
    let out = crate::external_command::run_with_timeout(cmd, "lsof listen", 5)
        .await
        .ok()?;
    let pid: u32 = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()?;
    let cwd = cwd_of(pid).await?;
    Some((pid, cwd))
}

#[cfg(not(unix))]
async fn listener(_port: u16) -> Option<(u32, String)> {
    None
}

/// A process's working folder (`lsof -d cwd`).
#[cfg(unix)]
pub async fn cwd_of(pid: u32) -> Option<String> {
    let mut cmd = tokio::process::Command::new("lsof");
    cmd.args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]);
    let out = crate::external_command::run_with_timeout(cmd, "lsof cwd", 5)
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(str::to_string))
}

#[cfg(not(unix))]
pub async fn cwd_of(_pid: u32) -> Option<String> {
    None
}

/// The folders an agent's links may point at: its open copy, then the
/// user's projects.
async fn folders_for(agent_id: &str) -> Vec<Known> {
    let mut folders = Vec::new();
    if let Ok(agent) = super::store::get(agent_id) {
        if let Some(copy) = agent.copy {
            folders.push(Known {
                path: copy.path,
                project: copy.project,
                copy: true,
            });
        }
    }
    if let Ok(projects) = crate::commands::projects::list_projects().await {
        folders.extend(projects.into_iter().map(|p| Known {
            project: p.path.clone(),
            path: p.path,
            copy: false,
        }));
    }
    folders
}

/// What the app knows serves each of `ports`, for `agent_id`'s reply.
pub async fn lookup(agent_id: &str, ports: &[u16]) -> Vec<(u16, Known)> {
    if ports.is_empty() {
        return Vec::new();
    }
    let folders = folders_for(agent_id).await;
    let mut out = Vec::new();
    for &port in ports {
        // A preview proxy's dev server, or one the agent's turn left running.
        let served = crate::proxy::dev_servers()
            .into_iter()
            .find(|(_, p)| *p == port)
            .map(|(path, _)| path)
            .or_else(|| super::dev_servers::path_on(port));
        let found = match served {
            Some(path) => folder_for(&path, &folders),
            None => match listener(port).await {
                Some((_, cwd)) => folder_for(&cwd, &folders),
                None => None,
            },
        };
        if let Some(k) = found {
            out.push((port, k));
        }
    }
    out
}

/// Rewrite an agent reply's text, looking its ports up first.
pub async fn apply(mut message: super::store::AgentMessage) -> super::store::AgentMessage {
    if message.kind != super::store::MessageKind::Agent || message.text.is_empty() {
        return message;
    }
    let ports = ports_in(&message.text);
    if ports.is_empty() {
        return message;
    }
    let known = lookup(&message.agent_id, &ports).await;
    let (text, links) = rewrite(&message.text, |port| {
        known
            .iter()
            .find(|(p, _)| *p == port)
            .map(|(_, k)| k.clone())
    });
    message.text = text;
    message.local_links = links;
    message
}

#[cfg(test)]
#[path = "local_links_tests.rs"]
mod tests;
