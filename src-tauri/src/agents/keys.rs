//! Agent keys (docs/internal/agent-keys.md): every agent is a keycap with a
//! colourway, a legend (an icon) and a keyboard key it's bound to. This holds
//! the ids, fills them in for agents saved before keys existed, keeps bound
//! keys unique, and checks a change from chat or a client.
//!
//! The data is the shared `agent-keys.json` the clients read too
//! (`packages/companion-protocol/src/agentKeys.ts`), so the Mac's migration
//! and a client's fallback land on the same key; `agent-key-cases.json` holds
//! both to the same answers.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::store::Agent;

#[derive(Deserialize)]
struct Colorway {
    id: String,
    name: String,
    legacy: String,
}

#[derive(Deserialize)]
struct Icon {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Rule {
    icon: String,
    words: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    colorways: Vec<Colorway>,
    legacy_colors: HashMap<String, String>,
    icons: Vec<Icon>,
    chief_icon: String,
    default_icon: String,
    icon_rules: Vec<Rule>,
    key_chars: String,
}

static SPEC: LazyLock<Spec> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/companion-protocol/src/agent-keys.json"
    )))
    .expect("agent-keys.json is the shared spec")
});

pub fn colorways() -> Vec<&'static str> {
    SPEC.colorways.iter().map(|c| c.id.as_str()).collect()
}

pub fn icons() -> Vec<&'static str> {
    SPEC.icons.iter().map(|i| i.id.as_str()).collect()
}

pub fn is_colorway(id: &str) -> bool {
    SPEC.colorways.iter().any(|c| c.id == id)
}

pub fn is_icon(id: &str) -> bool {
    SPEC.icons.iter().any(|i| i.id == id)
}

/// "Blue", "Inbox": what a line in chat calls them.
pub fn colorway_name(id: &str) -> String {
    SPEC.colorways
        .iter()
        .find(|c| c.id == id)
        .map_or_else(|| id.to_string(), |c| c.name.clone())
}

pub fn icon_name(id: &str) -> String {
    SPEC.icons
        .iter()
        .find(|i| i.id == id)
        .map_or_else(|| id.to_string(), |i| i.name.clone())
}

/// The nearest colourway to an old avatar colour key (the first for one it doesn't know).
pub fn colorway_for_color(color: &str) -> String {
    let key = color.trim().to_ascii_lowercase();
    if is_colorway(&key) {
        return key;
    }
    SPEC.legacy_colors
        .get(&key)
        .cloned()
        .unwrap_or_else(|| SPEC.colorways[0].id.clone())
}

/// The old colour key written beside a colourway, for clients that only know colours.
pub fn legacy_color_for(colorway: &str) -> String {
    SPEC.colorways
        .iter()
        .find(|c| c.id == colorway)
        .map_or_else(|| "blue".to_string(), |c| c.legacy.clone())
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// An icon read from the agent's name, then its role (`iconFor` in agentKeys.ts).
pub fn icon_for(name: &str, role: &str, is_main: bool) -> String {
    if is_main {
        return SPEC.chief_icon.clone();
    }
    for text in [name, role] {
        let ws = words(text);
        for rule in &SPEC.icon_rules {
            if ws.iter().any(|w| rule.words.contains(w)) {
                return rule.icon.clone();
            }
        }
    }
    SPEC.default_icon.clone()
}

/// One typed key as a bound key: a letter or digit, upper-cased.
pub fn normalize_bound_key(key: &str) -> Option<String> {
    let k = key.trim().to_ascii_uppercase();
    (k.chars().count() == 1 && SPEC.key_chars.contains(&k)).then_some(k)
}

/// The first key free for `name`: its own letters first, then every other one.
pub fn bound_key_for(name: &str, taken: &HashSet<String>) -> Option<String> {
    let upper = name.to_ascii_uppercase();
    upper
        .chars()
        .filter(|c| SPEC.key_chars.contains(*c))
        .chain(SPEC.key_chars.chars())
        .map(|c| c.to_string())
        .find(|c| !taken.contains(c))
}

/// The colourway fewest on the team wear, in palette order.
pub fn fresh_colorway<'a>(worn: impl IntoIterator<Item = &'a str>) -> String {
    let mut counts: Vec<(&str, usize)> =
        SPEC.colorways.iter().map(|c| (c.id.as_str(), 0)).collect();
    for w in worn {
        if let Some(entry) = counts.iter_mut().find(|(id, _)| *id == w) {
            entry.1 += 1;
        }
    }
    let mut best = counts[0];
    for c in &counts {
        if c.1 < best.1 {
            best = *c;
        }
    }
    best.0.to_string()
}

/// A colourway for a key with `icon` that no one on the team already wears
/// with that icon: `preferred` when it's free, else the fewest-worn one that
/// is, so two agents never look the same (two blue speakers). `preferred`
/// when every colourway is taken with that icon.
pub fn distinct_colorway<'a>(
    preferred: &str,
    icon: &str,
    team: impl IntoIterator<Item = (&'a str, &'a str)> + Clone,
) -> String {
    let clash = |c: &str| team.clone().into_iter().any(|(w, i)| w == c && i == icon);
    if !clash(preferred) {
        return preferred.to_string();
    }
    let mut counts: Vec<(&str, usize)> = SPEC
        .colorways
        .iter()
        .map(|c| (c.id.as_str(), 0))
        .filter(|(id, _)| !clash(id))
        .collect();
    for (w, _) in team.clone() {
        if let Some(entry) = counts.iter_mut().find(|(id, _)| *id == w) {
            entry.1 += 1;
        }
    }
    counts
        .iter()
        .min_by_key(|(_, n)| *n)
        .map(|(id, _)| id.to_string())
        .unwrap_or_else(|| preferred.to_string())
}

/// Gives every agent saved before keys a colourway (its colour's nearest),
/// an icon (from its name and role) and a key (the first free letter of its
/// name), the Chief first, then in team order; and keeps bound keys unique
/// (a later duplicate, say a restored agent's, gets a free one). Returns
/// whether anything changed.
pub fn fill(agents: &mut [Agent]) -> bool {
    let mut changed = false;
    for i in 0..agents.len() {
        let a = &agents[i];
        let had_colorway = a.colorway.as_deref().is_some_and(is_colorway);
        let had_icon = a.icon.as_deref().is_some_and(is_icon);
        if had_colorway && had_icon {
            continue;
        }
        let icon = if had_icon {
            a.icon.clone().unwrap_or_default()
        } else {
            icon_for(&a.name, &a.role, a.is_main)
        };
        let colorway = if had_colorway {
            a.colorway.clone().unwrap_or_default()
        } else {
            // Not one someone chose: one no one else wears with this icon.
            let worn: Vec<(&str, &str)> = agents
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .filter_map(|(_, b)| Some((b.colorway.as_deref()?, b.icon.as_deref()?)))
                .collect();
            distinct_colorway(&colorway_for_color(&a.color), &icon, worn.iter().copied())
        };
        let a = &mut agents[i];
        a.colorway = Some(colorway);
        a.icon = Some(icon);
        changed = true;
    }
    let mut order: Vec<usize> = (0..agents.len()).collect();
    order.sort_by_key(|i| !agents[*i].is_main);
    let mut taken = HashSet::new();
    let mut missing = Vec::new();
    for i in order {
        match agents[i]
            .bound_key
            .as_deref()
            .and_then(normalize_bound_key)
            .filter(|k| !taken.contains(k))
        {
            Some(k) => {
                if agents[i].bound_key.as_deref() != Some(k.as_str()) {
                    agents[i].bound_key = Some(k.clone());
                    changed = true;
                }
                taken.insert(k);
            }
            None => missing.push(i),
        }
    }
    for i in missing {
        let key = bound_key_for(&agents[i].name, &taken);
        if let Some(k) = &key {
            taken.insert(k.clone());
        }
        if agents[i].bound_key != key {
            agents[i].bound_key = key;
            changed = true;
        }
    }
    changed
}

/// A change to an agent's key, checked: ids this build draws, and a bound
/// key no one else on the team has.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct KeyChange {
    pub colorway: Option<String>,
    pub icon: Option<String>,
    pub bound_key: Option<String>,
}

impl KeyChange {
    pub fn is_empty(&self) -> bool {
        self.colorway.is_none() && self.icon.is_none() && self.bound_key.is_none()
    }

    /// Checks what was asked against `agent` (`None`: one being made) and
    /// its team, keeping only what differs.
    pub fn checked(
        agent: Option<&Agent>,
        team: &[Agent],
        colorway: Option<&str>,
        icon: Option<&str>,
        bound_key: Option<&str>,
    ) -> Result<KeyChange, String> {
        let mut out = KeyChange::default();
        if let Some(c) = colorway.map(|c| c.trim().to_ascii_lowercase()) {
            if !is_colorway(&c) {
                return Err(format!(
                    "There's no colourway called \"{c}\": {}.",
                    colorways().join(", ")
                ));
            }
            if agent.and_then(|a| a.colorway.as_deref()) != Some(c.as_str()) {
                out.colorway = Some(c);
            }
        }
        if let Some(i) = icon.map(|i| i.trim().to_ascii_lowercase()) {
            if !is_icon(&i) {
                return Err(format!(
                    "There's no icon called \"{i}\": {}.",
                    icons().join(", ")
                ));
            }
            if agent.and_then(|a| a.icon.as_deref()) != Some(i.as_str()) {
                out.icon = Some(i);
            }
        }
        if let Some(raw) = bound_key {
            let Some(k) = normalize_bound_key(raw) else {
                return Err(format!(
                    "\"{}\" can't be a key: pick one letter or digit.",
                    raw.trim()
                ));
            };
            if let Some(other) = team.iter().find(|o| {
                agent.is_none_or(|a| a.id != o.id) && o.bound_key.as_deref() == Some(k.as_str())
            }) {
                return Err(format!(
                    "{k} is already {}'s key. Pick another, or change theirs first.",
                    other.name
                ));
            }
            if agent.and_then(|a| a.bound_key.as_deref()) != Some(k.as_str()) {
                out.bound_key = Some(k);
            }
        }
        Ok(out)
    }

    /// Applies it, keeping the old colour field near the colourway for clients that only read that.
    pub fn apply(&self, a: &mut Agent) {
        if let Some(c) = &self.colorway {
            a.colorway = Some(c.clone());
            a.color = legacy_color_for(c);
        }
        if let Some(i) = &self.icon {
            a.icon = Some(i.clone());
        }
        if let Some(k) = &self.bound_key {
            a.bound_key = Some(k.clone());
        }
    }

    /// "now Teal, with the Chat legend, on key Q", for a line in chat.
    pub fn line(&self) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(c) = &self.colorway {
            parts.push(format!("now {}", colorway_name(c)));
        }
        if let Some(i) = &self.icon {
            parts.push(format!("with the {} legend", icon_name(i)));
        }
        if let Some(k) = &self.bound_key {
            parts.push(format!("on key {k}"));
        }
        if parts.is_empty() {
            return None;
        }
        let mut line = parts.join(", ");
        if self.colorway.is_none() {
            line = format!("now {line}");
        }
        Some(line)
    }
}
