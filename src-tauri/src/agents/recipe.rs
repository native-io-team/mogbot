//! Sharing an agent as a recipe: its shareable definition, never what it
//! knows about the person who made it.
//!
//! A recipe is one JSON object (`format: "agent-recipe"`, `version`; the
//! schema is in docs/agents.md, "Share an agent as a recipe"): its name,
//! role, instructions, routines as words, what it watches for, the apps it
//! needs by name, its key's look and the independence it suggests.
//!
//! **Never in it:** memory, the conversation, logins, keys or connection
//! tokens, which accounts it uses, its project, and, in every text that is
//! in it, email addresses, phone numbers, file paths under a home folder and
//! anything shaped like a credential (each replaced by "[removed: …]" and
//! counted, so the preview can say "2 personal details removed").
//!
//! **Importing one** goes through the export path (`import_formats` reads
//! it, `import_export::post` puts the same review card in the Chief's chat):
//! plain code copies fields, nothing reads it as instructions, routines
//! arrive paused, a taken name comes in as "<Name> (from a recipe)", a
//! taken key gets a free one, and an independence it suggests is only ever
//! applied when it's stricter than the team's (`level_to_apply`).

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::import_export::Export;
use super::independence::Level;
use super::review::ProposedLook;
use super::store;
use crate::errors::CommandError;

/// What a recipe says it is. Not the app's name: a recipe from a fork or a
/// renamed build reads the same.
pub const FORMAT: &str = "agent-recipe";
/// The newest shape this build writes and reads.
pub const VERSION: u64 = 1;

/// The file's name ends with this ("Finance.mogbot-recipe.json").
pub fn file_suffix() -> String {
    format!(".{}-recipe.json", crate::brand::SLUG)
}

/* -------------------------------------------------------------- shape */

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Routine {
    pub when: String,
    pub what: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Look {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colorway: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// One recipe, exactly as the file holds it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Recipe {
    pub format: String,
    pub version: u64,
    pub name: String,
    pub role: String,
    pub instructions: String,
    pub routines: Vec<Routine>,
    pub watches: Vec<Routine>,
    pub apps: Vec<String>,
    pub look: Look,
    /// "often", "judgement", "go_hard" or "full_send": a suggestion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independence: Option<Level>,
}

/// What the scrub took out of the recipe's text, by kind.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub emails: usize,
    pub phones: usize,
    pub paths: usize,
    /// Passwords, keys and tokens.
    pub secrets: usize,
}

impl Removed {
    /// Emails, phone numbers and home-folder paths.
    pub fn personal(&self) -> usize {
        self.emails + self.phones + self.paths
    }

    fn add(&mut self, other: Removed) {
        self.emails += other.emails;
        self.phones += other.phones;
        self.paths += other.paths;
        self.secrets += other.secrets;
    }
}

/* -------------------------------------------------------------- scrub */

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b").expect("regex")
});
/// A path under someone's home folder, where a path starts: after a space,
/// a quote or a bracket, never inside a web address ("example.com/home/").
static PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?i)(^|[\s"'`(\[<=,;:])"#,
        r#"((?:file://)?(?:"#,
        r#"/(?:Users|home|private/var|var/folders|Volumes)/[^\s"'`<>()\[\]]+"#,
        r#"|~/[^\s"'`<>()\[\]]*"#,
        r#"|[a-z]:\\Users\\[^\s"'`<>()\[\]]+"#,
        r#"))"#
    ))
    .expect("regex")
});
static PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\+\d[\d ().-]{6,}\d|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b").expect("regex")
});

/// `text` with anything personal or secret replaced by "[removed: …]", and
/// how many of each. Secrets first, so a token is never read as a path.
pub fn scrub(text: &str) -> (String, Removed) {
    let mut removed = Removed::default();
    let (text, secrets) = super::harvest::mask_secrets(text);
    removed.secrets = secrets;
    let text = PATH.replace_all(&text, |c: &regex::Captures| {
        removed.paths += 1;
        format!("{}[removed: a file path]", &c[1])
    });
    let text = EMAIL.replace_all(&text, |_: &regex::Captures| {
        removed.emails += 1;
        "[removed: an email address]"
    });
    let text = PHONE.replace_all(&text, |_: &regex::Captures| {
        removed.phones += 1;
        "[removed: a phone number]"
    });
    (text.into_owned(), removed)
}

/* ------------------------------------------------------------- export */

/// What goes into a recipe, gathered by the caller (`for_agent`), so the
/// rules are tested without a store.
pub struct Source<'a> {
    pub agent: &'a store::Agent,
    /// The `## Instructions` section of its CLAUDE.md, never its memory.
    pub instructions: &'a str,
    /// The apps it was given, by their names ("Linear"), never the account.
    pub apps: Vec<String>,
    pub independence: Option<Level>,
}

/// A recipe, what was removed from it, and what was left out on purpose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub recipe: Recipe,
    pub removed: Removed,
    /// What isn't in it, in the preview's words ("Its memory").
    pub left_out: Vec<String>,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn build(src: Source) -> Built {
    let a = src.agent;
    let mut removed = Removed::default();
    let mut clean = |text: &str| {
        let (out, r) = scrub(text.trim());
        removed.add(r);
        out
    };
    let mut routines = Vec::new();
    let mut watches = Vec::new();
    let mut one_offs = 0;
    let mut steps = 0;
    for c in a.check_ins.iter().filter(|c| !c.follow_up) {
        if let Some(w) = &c.watch {
            watches.push(Routine {
                when: clean(&super::watch::describe(&w.source)),
                what: clean(&c.note),
            });
        } else if let Some(repeat) = &c.repeat {
            if !c.then.is_empty() {
                steps += 1;
            }
            routines.push(Routine {
                when: super::schedule::describe(repeat),
                what: clean(&c.note),
            });
        } else {
            one_offs += 1;
        }
    }
    let mut seen = BTreeSet::new();
    let apps: Vec<String> = src
        .apps
        .iter()
        .map(|n| clean(n))
        .filter(|n| !n.is_empty() && seen.insert(n.to_ascii_lowercase()))
        .collect();
    let recipe = Recipe {
        format: FORMAT.into(),
        version: VERSION,
        name: clean(&a.name),
        role: clean(&a.role),
        instructions: clean(src.instructions),
        routines,
        watches,
        apps,
        look: Look {
            colorway: a.colorway.clone(),
            icon: a.icon.clone(),
            key: a.bound_key.clone(),
        },
        independence: src.independence,
    };
    let mut left_out = vec![
        "Its memory and everything it knows about you".to_string(),
        "Its conversations".to_string(),
        "Logins, keys and which accounts it uses".to_string(),
    ];
    if a.project.is_some() {
        left_out.push("The project it works in".into());
    }
    if one_offs > 0 {
        left_out.push(plural(one_offs, "one-time reminder", "one-time reminders"));
    }
    if steps > 0 {
        left_out.push(format!(
            "The later steps of {}",
            plural(steps, "routine", "routines")
        ));
    }
    Built {
        recipe,
        removed,
        left_out,
    }
}

/// The file's contents.
pub fn to_json(r: &Recipe) -> String {
    serde_json::to_string_pretty(r).unwrap_or_default() + "\n"
}

/// "Copy as text": a line saying what it is, and the recipe in a block the
/// paste path reads.
pub fn to_text(r: &Recipe) -> String {
    let app = crate::brand::NAME;
    format!(
        "An agent recipe for {}, from {app}. To use it, paste all of this into the Chief of Staff's chat in {app}.\n\n```json\n{}```\n",
        r.name,
        to_json(r)
    )
}

/// "Finance.mogbot-recipe.json": the name, with anything a file name can't
/// hold dropped.
pub fn file_name(r: &Recipe) -> String {
    let base: String = r
        .name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .collect();
    let base = base.trim();
    format!(
        "{}{}",
        if base.is_empty() { "Agent" } else { base },
        file_suffix()
    )
}

/// What the share dialog shows: the recipe exactly as it will be written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    #[serde(flatten)]
    pub built: Built,
    pub json: String,
    pub text: String,
    pub file_name: String,
}

pub fn preview_of(built: Built) -> Preview {
    Preview {
        json: to_json(&built.recipe),
        text: to_text(&built.recipe),
        file_name: file_name(&built.recipe),
        built,
    }
}

/// The recipe for one agent here, read now.
pub fn for_agent(id: &str) -> Result<Preview, CommandError> {
    let agent = store::get(id)?;
    let instructions = store::read_instructions(&agent.id)?;
    let apps = super::connections::granted_to(&agent.id)
        .into_iter()
        .map(|(c, _)| c.title)
        .collect();
    let independence = Some(super::policy::chosen_level(&agent));
    Ok(preview_of(build(Source {
        agent: &agent,
        instructions: &instructions,
        apps,
        independence,
    })))
}

/// Write it where the user picked, only if it's still what they were shown.
pub fn save(id: &str, path: &std::path::Path, shown: &str) -> Result<(), CommandError> {
    let now = for_agent(id)?;
    if now.json != shown {
        return Err(CommandError::expected(
            "It changed since the preview. Look at it again, then save.",
        ));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !name.ends_with(".json") {
        return Err(super::err_invalid("path", "Save it as a .json file."));
    }
    std::fs::write(path, now.json.as_bytes()).map_err(|e| super::err_io(e.to_string()))?;
    tracing::info!(agent = %id, "[Agents] shared as a recipe");
    Ok(())
}

/* ------------------------------------------------------------- import */

pub fn is_recipe(value: &Value) -> bool {
    value.get("format").and_then(Value::as_str) == Some(FORMAT)
}

fn text_field(obj: &serde_json::Map<String, Value>, key: &str, problems: &mut Vec<String>) -> String {
    match obj.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(_) => {
            problems.push(format!("The recipe's \"{key}\" should be text."));
            String::new()
        }
    }
}

fn pairs(obj: &serde_json::Map<String, Value>, key: &str, problems: &mut Vec<String>) -> Vec<(String, String)> {
    let Some(v) = obj.get(key).filter(|v| !v.is_null()) else {
        return Vec::new();
    };
    let Some(list) = v.as_array() else {
        problems.push(format!("The recipe's \"{key}\" should be a list."));
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let when = item.get("when")?.as_str()?.trim();
            let what = item.get("what")?.as_str()?.trim();
            (!when.is_empty() && !what.is_empty()).then(|| (when.to_string(), what.to_string()))
        })
        .collect()
}

/// One recipe as an agent to review. Only the fields a recipe has are
/// read: anything else in it ("memory", "is_main", "logins", a secret) is
/// ignored, whatever it says.
pub fn read_value(value: &Value, label: &str, out: &mut Export) {
    out.format = super::import_formats::Format::Recipe;
    let Some(obj) = value.as_object() else {
        out.problems.push(format!("{label} isn't a recipe."));
        return;
    };
    match obj.get("version").and_then(Value::as_u64) {
        Some(v) if (1..=VERSION).contains(&v) => {}
        Some(v) if v > VERSION => {
            out.problems.push(
                "That recipe was made by a newer version of the app. Update to import it.".into(),
            );
            return;
        }
        _ => {
            out.problems
                .push(format!("{label} has no recipe \"version\" this app reads."));
            return;
        }
    }
    let mut problems = Vec::new();
    let name = text_field(obj, "name", &mut problems);
    if name.is_empty() {
        out.problems.push(format!("{label} has no \"name\"."));
        return;
    }
    let mut a = super::import_formats::agent(&name);
    a.role = text_field(obj, "role", &mut problems);
    a.instructions = text_field(obj, "instructions", &mut problems);
    a.routines = pairs(obj, "routines", &mut problems);
    a.watches = pairs(obj, "watches", &mut problems);
    a.apps = match obj.get("apps") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|v| v.as_str().or_else(|| v.get("name")?.as_str()))
            .map(|n| (n.trim().to_string(), String::new()))
            .filter(|(n, _)| !n.is_empty())
            .collect(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => {
            problems.push("The recipe's \"apps\" should be a list of names.".into());
            Vec::new()
        }
    };
    let look = obj.get("look");
    let s = |k: &str| look.and_then(|l| l.get(k)).and_then(Value::as_str);
    a.look = ProposedLook::read(
        s("colorway"),
        s("icon"),
        s("key"),
        obj.get("independence").and_then(Value::as_str),
    );
    out.problems.extend(problems);
    if out.source.is_empty() {
        out.source = super::import_formats::Format::Recipe.source_name().into();
    }
    out.read.push(label.to_string());
    out.add_agent(a);
}

/// Imported recipes may suggest how much an agent does on its own: applied
/// only when it's stricter than the team's, so a recipe can never give an
/// agent more room than the user already gives every agent.
pub fn level_to_apply(suggested: Level, team: Level) -> Option<Level> {
    (suggested.rank() < team.rank()).then_some(suggested)
}

/// A new agent made from a recipe takes its look (a free key when its own
/// is taken) and, when stricter, its independence. Returns what to say.
pub fn apply_look(agent_id: &str, look: &ProposedLook) -> Vec<String> {
    let mut lines = Vec::new();
    if let Ok(agent) = store::get(agent_id) {
        let team = store::list().unwrap_or_default();
        let colorway = look.colorway.as_deref();
        let icon = look.icon.as_deref();
        let change = match super::keys::KeyChange::checked(
            Some(&agent),
            &team,
            colorway,
            icon,
            look.key.as_deref(),
        ) {
            Ok(c) => Some(c),
            Err(_) => {
                if let Some(k) = &look.key {
                    lines.push(format!(
                        "Its key {k} is taken here, so it's on {}.",
                        agent.bound_key.as_deref().unwrap_or("another key")
                    ));
                }
                super::keys::KeyChange::checked(Some(&agent), &team, colorway, icon, None).ok()
            }
        };
        if let Some(change) = change.filter(|c| !c.is_empty()) {
            let _ = store::update(agent_id, |a| change.apply(a));
        }
    }
    if let Some(suggested) = look.independence {
        let team = super::independence::level();
        match level_to_apply(suggested, team) {
            Some(level) => {
                let set = super::policy::modify(|s| {
                    s.agents.entry(agent_id.to_string()).or_default().independence = Some(level);
                    Ok(())
                });
                if set.is_ok() {
                    lines.push(format!(
                        "It's set to {}, as the recipe suggests.",
                        level.label()
                    ));
                }
            }
            None if suggested.rank() > team.rank() => lines.push(format!(
                "The recipe suggests {}; it stays at your team's {} until you change it.",
                suggested.label(),
                team.label()
            )),
            None => {}
        }
    }
    lines
}

#[cfg(test)]
#[path = "recipe_tests.rs"]
mod tests;
