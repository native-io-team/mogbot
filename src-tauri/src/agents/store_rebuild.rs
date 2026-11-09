//! The last way back for a damaged `agents.json` with no `.bak` beside it.
//!
//! Every agent's folder still holds its `CLAUDE.md` (name, role,
//! instructions, memory) and its chat. That is enough to put each agent back
//! in the list with its own words; what lived only in the registry (engine,
//! routines, check-ins, logins granted, project binding) starts at defaults,
//! and the line in the Chief's chat says so. Nothing in a folder is changed,
//! and the damaged registry is copied aside before the rebuilt one is written.

use std::path::Path;

use super::{color_for, validate_id, Agent, Registry, SHAPE_COUNT};

/// The agents found in `root`'s folders, oldest first. A folder counts when
/// its name is an agent id and it has a `CLAUDE.md` that starts with a
/// `# Name` heading; anything else is left alone.
pub(super) fn from_homes(root: &Path) -> Registry {
    let mut found: Vec<(i64, i64, String, String, String)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return Registry::default();
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if validate_id(&id).is_err() || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let home = entry.path();
        let Ok(raw) = std::fs::read(home.join("CLAUDE.md")) else {
            continue;
        };
        let raw = String::from_utf8_lossy(&raw);
        let Some((name, role)) = heading_and_role(&raw) else {
            continue;
        };
        let created = time_ms(&home, true);
        let active = time_ms(&home.join("messages.jsonl"), false).max(created);
        found.push((created, active, id, name, role));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));

    let mut registry = Registry::default();
    for (created, active, id, name, role) in found {
        let name = unique_name(&registry.agents, &name);
        let index = registry.agents.len();
        let is_main = !registry.agents.iter().any(|a| a.is_main)
            && (role == super::super::prompts::CHIEF_ROLE
                || name == super::super::prompts::CHIEF_NAME);
        registry.agents.push(Agent {
            id,
            name,
            role,
            shape: (index as u8 * 5 + 1) % SHAPE_COUNT,
            avatar: None,
            color: if is_main {
                "white".to_string()
            } else {
                color_for(None, index)
            },
            is_main,
            pinned: is_main,
            hidden: false,
            session_id: None,
            created_at: created,
            last_activity_at: active,
            preview: None,
            unread: 0,
            pending_approvals: 0,
            engine: Default::default(),
            model: None,
            effort: None,
            new_engine: false,
            away: None,
            context: None,
            routine_model: None,
            account: None,
            template: None,
            reach: Default::default(),
            muted: false,
            check_ins: Vec::new(),
            usage: Default::default(),
            permissions: Vec::new(),
            failure: None,
            project: None,
            copy: None,
            work_directly: false,
            capabilities: None,
            secrets: Vec::new(),
            extra: Default::default(),
        });
    }
    registry
}

/// `# Name`, then the role: the paragraph(s) before the first `##` section,
/// as `write_instructions` lays the file out.
fn heading_and_role(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim_start_matches('\u{feff}');
    let (first, rest) = raw.split_once('\n').unwrap_or((raw, ""));
    let name = first.strip_prefix("# ")?.trim();
    if name.is_empty() || name.len() > 200 {
        return None;
    }
    let role = rest.split("\n## ").next().unwrap_or("").trim().to_string();
    Some((name.to_string(), role))
}

/// Two folders with the same heading (a copy, a hand edit): the later one
/// gets a number, since names must be unique.
fn unique_name(agents: &[Agent], name: &str) -> String {
    let taken = |n: &str| agents.iter().any(|a| a.name.eq_ignore_ascii_case(n));
    if !taken(name) {
        return name.to_string();
    }
    (2..)
        .map(|i| format!("{name} {i}"))
        .find(|n| !taken(n))
        .unwrap_or_else(|| name.to_string())
}

/// A file's birth (or change) time in ms; now when the disk won't say.
fn time_ms(path: &Path, created: bool) -> i64 {
    let meta = std::fs::metadata(path).ok();
    let time = meta.and_then(|m| {
        if created {
            m.created().ok()
        } else {
            m.modified().ok()
        }
    });
    time.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|| if created { super::now_ms() } else { 0 })
}

/// The line for the Chief's chat after a rebuild.
pub(super) fn line(count: usize, kept: &str) -> String {
    let agents = if count == 1 {
        "1 agent".to_string()
    } else {
        format!("{count} agents")
    };
    format!(
        "Your agents list was damaged and had no backup, so it was rebuilt from the agents' folders: {agents} back, with their instructions, memory and chats. Their engine, routines, project and logins start at the defaults, so set those again. The damaged list is kept as {kept}."
    )
}
