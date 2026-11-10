//! The exports `import_export` reads, by what each app really writes.
//!
//! Researched 2026-11-09 from each project's own docs and source; nothing
//! here is read from an observed sample alone (docs/agents.md, "From an
//! export file or a pasted reply", keeps the sources):
//!
//! - **Grok Bot** has no export of its own. The format people actually have
//!   is the one the Hermes `agent-importers` plugin asks the bot to write
//!   (`{"format": "grok-bot-export", "version": 1, "bots": […]}`, a `.json`
//!   or a reply), so that is what's read, plus our own [`PROMPT`] reply.
//! - **OpenBot** keeps agents in a database (`openbot.db`), not files, and
//!   isn't read there. Its two documented files are: the Grok Bot migration
//!   zip (`openbot-import.json`, `"format": "openbot-agent-import"`) and its
//!   own instance transfer (`openbot-transfer.json`,
//!   `"format": "openbot-instance-transfer"`).
//! - **OpenClaw**: a workspace folder (`AGENTS.md`, `SOUL.md`, `USER.md`,
//!   `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`,
//!   `memory/YYYY-MM-DD.md`), or the state folder `~/.openclaw` holding
//!   `workspace` / `workspace-<id>` and `openclaw.json` (`agents.entries`,
//!   or the legacy `agents.list`), or a `openclaw backup` `.tar.gz`. Its
//!   scheduled jobs live in SQLite since 2026.6.1 and aren't read; a
//!   leftover legacy `cron/jobs.json` is.
//! - **Hermes**: its home (`~/.hermes`) or a profile
//!   (`~/.hermes/profiles/<name>`), or a profile export `.tar.gz`: `SOUL.md`,
//!   `memories/MEMORY.md` (entries split by a line holding `§`),
//!   `memories/USER.md`, `skills/<name>/SKILL.md`, `cron/jobs.json`.
//!
//! **What is never read**: anything but `.md`, `.json` and `.txt` files;
//! credential files by name (`.env`, `auth.json`, `auth-profiles.json`,
//! anything named like credentials, keys or tokens); databases; session
//! logs. Of `openclaw.json` only agent names and workspaces are taken. The
//! rest of every file is masked for credentials before it's staged.
//!
//! [`PROMPT`]: super::import_export::PROMPT

use std::io::Read;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::import_export::{Agent, Export};

/// Bytes one file may have, and all of them together.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 48 * 1024 * 1024;
/// Entries an archive or folder walk looks at before giving up.
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    /// Our own shape: a reply to `import_export::PROMPT`, pasted or saved.
    #[default]
    Handover,
    GrokBot,
    OpenBotImport,
    OpenBotTransfer,
    OpenClaw,
    Hermes,
    /// An agent shared as a recipe (`recipe`).
    Recipe,
}

impl Format {
    pub fn label(self) -> &'static str {
        match self {
            Format::Handover => "Pasted reply",
            Format::GrokBot => "Grok Bot export",
            Format::OpenBotImport => "OpenBot import file",
            Format::OpenBotTransfer => "OpenBot transfer",
            Format::OpenClaw => "OpenClaw workspace",
            Format::Hermes => "Hermes profile",
            Format::Recipe => "Agent recipe",
        }
    }

    /// Who it's from when the export doesn't say.
    pub fn source_name(self) -> &'static str {
        match self {
            Format::Handover => "your assistant",
            Format::GrokBot => "Grok Bot",
            Format::OpenBotImport | Format::OpenBotTransfer => "OpenBot",
            Format::OpenClaw => "OpenClaw",
            Format::Hermes => "Hermes",
            Format::Recipe => "a recipe",
        }
    }

    /// Read as that app's docs or source describe it. All are: a shape we
    /// couldn't verify isn't read at all (it falls to the pasted path).
    pub fn verified(self) -> bool {
        true
    }
}

/* -------------------------------------------------------------- files */

/// The text files found, by path relative to what was picked ('/' joined,
/// a single wrapping folder in an archive removed).
#[derive(Debug, Default)]
pub struct Files {
    pub list: Vec<(String, String)>,
    pub skipped: Vec<String>,
}

impl Files {
    pub fn get(&self, path: &str) -> Option<&str> {
        self.list
            .iter()
            .find(|(p, _)| p.eq_ignore_ascii_case(path))
            .map(|(_, t)| t.as_str())
    }

    fn under<'a>(&'a self, dir: &'a str) -> impl Iterator<Item = (&'a str, &'a str)> + 'a {
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        self.list.iter().filter_map(move |(p, t)| {
            p.strip_prefix(prefix.as_str())
                .map(|rest| (rest, t.as_str()))
        })
    }
}

/// Never read, whatever folder it's in.
fn denied(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let parts: Vec<&str> = lower.split('/').collect();
    name.starts_with(".env")
        || name == "auth.json"
        || name.starts_with("auth-profiles")
        || name.contains("credential")
        || name.contains("secret")
        || name.contains("token")
        || name.ends_with(".key")
        || name.ends_with(".pem")
        || parts.iter().any(|p| {
            matches!(
                *p,
                "node_modules"
                    | ".git"
                    | "sessions"
                    | "logs"
                    | "output"
                    | "state"
                    | "browser"
                    | "credentials"
                    | "identity"
                    | "devices"
            )
        })
}

fn wanted(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    (lower.ends_with(".md") || lower.ends_with(".json") || lower.ends_with(".txt")) && !denied(path)
}

impl Files {
    fn add(&mut self, path: String, bytes: Vec<u8>, total: &mut u64) {
        *total += bytes.len() as u64;
        match String::from_utf8(bytes) {
            Ok(text) => self.list.push((path, text)),
            Err(_) => self.skipped.push(format!("{path} (not text)")),
        }
    }

    /// Drop one folder wrapping everything (an archive of a folder).
    fn unwrap_root(&mut self) {
        let first = |p: &str| p.split('/').next().unwrap_or("").to_string();
        let Some((p0, _)) = self.list.first() else {
            return;
        };
        let root = first(p0);
        if root.is_empty()
            || !self
                .list
                .iter()
                .all(|(p, _)| p.contains('/') && first(p) == root)
        {
            return;
        }
        for (p, _) in &mut self.list {
            *p = p[root.len() + 1..].to_string();
        }
    }
}

/// Path components of an archive entry, or `None` for one that climbs out
/// or is absolute (read in memory, never extracted, but named honestly).
fn clean_entry(name: &str) -> Option<String> {
    let parts: Vec<&str> = name
        .split(['/', '\\'])
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.is_empty() || parts.contains(&"..") || name.starts_with('/') {
        return None;
    }
    Some(parts.join("/"))
}

fn from_zip(path: &Path) -> Result<Files, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open it: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|_| "That isn't a readable zip.".to_string())?;
    let mut files = Files::default();
    let mut total = 0;
    for i in 0..zip.len().min(MAX_ENTRIES) {
        let Ok(entry) = zip.by_index(i) else { continue };
        if !entry.is_file() {
            continue;
        }
        let raw = entry.name().map(|n| n.to_string()).unwrap_or_default();
        let Some(name) = clean_entry(&raw) else {
            files.skipped.push(format!("{raw} (outside the archive)"));
            continue;
        };
        if !wanted(&name) {
            continue;
        }
        if entry.size() > MAX_FILE_BYTES || total + entry.size() > MAX_TOTAL_BYTES {
            files.skipped.push(format!("{name} (too large)"));
            continue;
        }
        let mut bytes = Vec::new();
        // Read no more than it claims, whatever it really inflates to.
        if entry
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_FILE_BYTES
        {
            files.skipped.push(format!("{name} (unreadable)"));
            continue;
        }
        files.add(name, bytes, &mut total);
    }
    files.unwrap_root();
    Ok(files)
}

fn from_tar_gz(path: &Path) -> Result<Files, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open it: {e}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let entries = archive
        .entries()
        .map_err(|_| "That isn't a readable .tar.gz.".to_string())?;
    let mut files = Files::default();
    let mut total = 0;
    for (n, entry) in entries.enumerate() {
        if n >= MAX_ENTRIES {
            break;
        }
        let Ok(entry) = entry else {
            return Err("That .tar.gz is damaged part way through.".into());
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let raw = entry
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let Some(name) = clean_entry(&raw) else {
            files.skipped.push(format!("{raw} (outside the archive)"));
            continue;
        };
        if !wanted(&name) {
            continue;
        }
        let size = entry.header().size().unwrap_or(u64::MAX);
        if size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES {
            files.skipped.push(format!("{name} (too large)"));
            continue;
        }
        let mut bytes = Vec::new();
        if entry
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            files.skipped.push(format!("{name} (unreadable)"));
            continue;
        }
        files.add(name, bytes, &mut total);
    }
    files.unwrap_root();
    Ok(files)
}

fn from_dir(root: &Path) -> Files {
    let mut files = Files::default();
    let mut total = 0;
    let walk = walkdir::WalkDir::new(root)
        .max_depth(6)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e
                    .path()
                    .strip_prefix(root)
                    .map(|p| denied(&p.to_string_lossy()))
                    .unwrap_or(true)
        });
    for entry in walk.take(MAX_ENTRIES).flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !wanted(&rel) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
        if size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES {
            files.skipped.push(format!("{rel} (too large)"));
            continue;
        }
        match std::fs::read(entry.path()) {
            Ok(bytes) => files.add(rel, bytes, &mut total),
            Err(_) => files.skipped.push(format!("{rel} (unreadable)")),
        }
    }
    files
}

/// Everything in what the user picked, read by its format.
pub fn read(path: &Path) -> Export {
    let mut out = Export::default();
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => {
            out.problems
                .push("That file or folder isn't there any more.".into());
            return out;
        }
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let files = if meta.is_dir() {
        Ok(from_dir(path))
    } else if name.ends_with(".zip") {
        from_zip(path)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        from_tar_gz(path)
    } else if wanted(&name)
        || name.ends_with(".json")
        || name.ends_with(".md")
        || name.ends_with(".txt")
    {
        if denied(&name) {
            Err("That file holds credentials, so it isn't read. Pick the export or the folder instead.".into())
        } else if meta.len() > MAX_FILE_BYTES {
            Err("That file is too large to be an export.".into())
        } else {
            std::fs::read(path)
                .map_err(|e| format!("Couldn't read it: {e}"))
                .map(|bytes| {
                    let mut f = Files::default();
                    f.add(name.clone(), bytes, &mut 0);
                    f
                })
        }
    } else {
        Err("That isn't a kind of file an export comes in (.json, .zip, .tar.gz, .md or .txt), or a folder.".into())
    };
    match files {
        Ok(files) => {
            out.skipped = files.skipped.clone();
            read_files(&files, &mut out);
        }
        Err(why) => out.problems.push(why),
    }
    out
}

/// What the files are, and everything in them.
pub fn read_files(files: &Files, out: &mut Export) {
    // A file that names its own format wins; folder layouts after.
    for (path, text) in &files.list {
        let lower = path.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(&lower);
        if base == "openbot-import.json" || base == "openbot-transfer.json" {
            match serde_json::from_str::<Value>(text) {
                Ok(v) => match v.get("format").and_then(Value::as_str) {
                    Some("openbot-agent-import") => {
                        openbot_import(&v, files, path, out);
                        return;
                    }
                    Some("openbot-instance-transfer") => {
                        openbot_transfer(&v, path, out);
                        return;
                    }
                    _ => {}
                },
                Err(e) => {
                    out.problems.push(format!("{path} isn't valid JSON: {e}."));
                    return;
                }
            }
        }
    }
    // Recipes: an agent someone shared, one file each.
    let mut recipes = false;
    for (path, text) in &files.list {
        for value in json_values(text) {
            if super::recipe::is_recipe(&value) {
                super::recipe::read_value(&value, path, out);
                recipes = true;
            }
        }
    }
    if recipes {
        return;
    }
    // Grok Bot exports, possibly several (one per bot), possibly as a reply.
    let mut grok = Vec::new();
    for (path, text) in &files.list {
        for value in json_values(text) {
            if value.get("format").and_then(Value::as_str) == Some("grok-bot-export") {
                grok.push((path.clone(), value));
            }
        }
    }
    if !grok.is_empty() {
        grok_bot(&grok, out);
        return;
    }
    if is_openclaw(files) {
        openclaw(files, out);
        return;
    }
    if is_hermes(files) {
        hermes(files, out);
        return;
    }
    // Our own shape, saved to a file.
    let mut any = false;
    for (path, text) in &files.list {
        for value in json_values(text) {
            if value.get("agents").is_some() || value.get("about_me").is_some() {
                out.add_value(value, path);
                out.read.push(path.clone());
                any = true;
            }
        }
    }
    if !any {
        // A `.json` that doesn't parse is most likely the export itself with
        // a typo (a bot wrote it): say where, not "doesn't look like an export".
        let broken: Vec<String> = files
            .list
            .iter()
            .filter(|(path, _)| path.to_ascii_lowercase().ends_with(".json"))
            .filter_map(|(path, text)| {
                super::paste::parse_block(text, path)
                    .err()
                    .filter(|_| json_values(text).is_empty())
            })
            .take(3)
            .collect();
        if !broken.is_empty() {
            out.problems.extend(broken);
            return;
        }
        out.problems.push(
            "This doesn't look like an export from Grok Bot, OpenBot, OpenClaw or Hermes. Pick the export itself or the app's folder, or use Paste a reply instead.".into(),
        );
    }
}

/// Every JSON value a file holds: the whole of it, or its ```json blocks.
fn json_values(text: &str) -> Vec<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{FEFF}').trim()) {
        return vec![v];
    }
    super::paste::extract_blocks(text)
        .iter()
        .filter_map(|b| super::paste::parse_block(b, "").ok())
        .collect()
}

/* ------------------------------------------------------- time phrases */

const DAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn day_list(days: &[usize]) -> String {
    let names: Vec<&str> = days.iter().map(|d| DAYS[*d % 7]).collect();
    match names.as_slice() {
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        [] => String::new(),
    }
}

/// A cron expression in the words the schedule reads, or `None` when it
/// isn't one of the plain shapes (the card then shows it wasn't set).
pub fn cron_words(expr: &str) -> Option<String> {
    let f: Vec<&str> = expr.split_whitespace().collect();
    if f.len() != 5 {
        return None;
    }
    let num = |s: &str| s.parse::<u32>().ok();
    let (m, h, dom, mon, dow) = (f[0], f[1], f[2], f[3], f[4]);
    if mon != "*" {
        return None;
    }
    if let Some(n) = m.strip_prefix("*/").and_then(num) {
        return (h == "*" && dom == "*" && dow == "*").then(|| format!("every {n} minutes"));
    }
    let minute = num(m)?;
    if h == "*" {
        return (dom == "*" && dow == "*").then(|| "every hour".to_string());
    }
    if let Some(n) = h.strip_prefix("*/").and_then(num) {
        return (dom == "*" && dow == "*").then(|| format!("every {n} hours"));
    }
    let hour = num(h)?;
    if hour > 23 || minute > 59 {
        return None;
    }
    let at = format!("{hour:02}:{minute:02}");
    match (dom, dow) {
        ("*", "*") => Some(format!("every day at {at}")),
        ("*", "1-5") => Some(format!("every weekday at {at}")),
        ("*", days) => {
            let mut list = Vec::new();
            for part in days.split(',') {
                if let Some((a, b)) = part.split_once('-') {
                    let (a, b) = (dow_num(a)?, dow_num(b)?);
                    if a > b {
                        return None;
                    }
                    list.extend(a..=b);
                } else {
                    list.push(dow_num(part)?);
                }
            }
            let mut list: Vec<usize> = list.into_iter().map(|d| d % 7).collect();
            list.sort_unstable();
            list.dedup();
            // Monday first, as people say it.
            list.sort_by_key(|d| (d + 6) % 7);
            Some(format!("every {} at {at}", day_list(&list)))
        }
        (day, "*") => {
            let d = num(day).filter(|d| (1..=31).contains(d))?;
            Some(format!("every month on the {} at {at}", ordinal(d)))
        }
        _ => None,
    }
}

fn dow_num(s: &str) -> Option<usize> {
    if let Ok(n) = s.parse::<usize>() {
        return (n <= 7).then_some(n);
    }
    let s = s.to_ascii_lowercase();
    DAYS.iter().position(|d| d.starts_with(&s) && s.len() >= 3)
}

fn minutes_words(minutes: u64) -> String {
    if minutes >= 60 && minutes % 60 == 0 {
        match minutes / 60 {
            1 => "every hour".into(),
            h => format!("every {h} hours"),
        }
    } else {
        format!("every {minutes} minutes")
    }
}

/// An ISO time ("2026-11-20T09:00:00Z") as the schedule reads a one-off, in
/// this Mac's time; the text as it was if it isn't one.
fn once_words(at: &str) -> String {
    use chrono::{DateTime, Local, NaiveDateTime};
    if let Ok(t) = DateTime::parse_from_rfc3339(at) {
        return t.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string();
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(at, f) {
            return t.format("%Y-%m-%d %H:%M").to_string();
        }
    }
    at.to_string()
}

/// A routine's "what", with the time zone it ran in there when it says one.
fn with_zone(what: &str, zone: Option<&str>) -> String {
    match zone.map(str::trim).filter(|z| !z.is_empty()) {
        Some(z) => format!("{what}\n(It ran on {z} time there.)"),
        None => what.to_string(),
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

/// A list of strings (or `{text}` objects). A Grok Bot export is written by the
/// bot itself, so a list sometimes arrives as one string: one item a line.
fn strings(v: Option<&Value>) -> Vec<String> {
    if let Some(one) = v.and_then(Value::as_str) {
        return one
            .lines()
            .map(|l| {
                l.trim()
                    .trim_start_matches(['-', '•', '*'])
                    .trim()
                    .to_string()
            })
            .filter(|l| !l.is_empty())
            .collect();
    }
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| {
            x.as_str()
                .map(str::to_string)
                .or_else(|| x.get("text").and_then(Value::as_str).map(str::to_string))
        })
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

/// An agent as a file format gives it: every field counts as sent (there's
/// no one to ask for more).
pub(crate) fn agent(name: &str) -> Agent {
    let mut a = Agent {
        name: name.trim().to_string(),
        ..Agent::default()
    };
    for k in [
        "role",
        "instructions",
        "memory",
        "preferences",
        "context",
        "routines",
        "watches",
        "apps",
        "logins",
    ] {
        a.sent.insert(k);
    }
    a
}

fn push_section(text: &mut String, heading: &str, body: &str) {
    let body = body.trim();
    if body.is_empty() {
        return;
    }
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    if heading.is_empty() {
        text.push_str(body);
    } else {
        text.push_str(&format!("## {heading}\n\n{body}"));
    }
}

fn about(out: &mut Export, area: &'static str, facts: impl IntoIterator<Item = String>) {
    let list = out.about.entry(area).or_default();
    for f in facts {
        let f = f.trim().to_string();
        if !f.is_empty() && !list.contains(&f) {
            list.push(f);
        }
    }
}

/* ----------------------------------------------------------- Grok Bot */

/// `{"format": "grok-bot-export", "bots": [...]}`, possibly split across
/// files with the same bot name: their lists are merged.
fn grok_bot(values: &[(String, Value)], out: &mut Export) {
    out.format = Format::GrokBot;
    for (path, v) in values {
        out.read.push(path.clone());
        for bot in v
            .get("bots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = s(bot, "name");
            if name.is_empty() {
                out.problems.push(format!("{path}: a bot has no \"name\"."));
                continue;
            }
            let mut a = agent(name);
            a.role = s(bot, "title").to_string();
            a.instructions = s(bot, "instructions").to_string();
            a.memory = strings(bot.get("memories")).join("\n");
            let mut named_only = Vec::new();
            for skill in bot
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                // Just a name ("skills": ["web-brief"]): there's nothing to run.
                if let Some(name) = skill.as_str().map(str::trim).filter(|n| !n.is_empty()) {
                    named_only.push(name.to_string());
                    continue;
                }
                let body = format!(
                    "{}\n\n{}",
                    s(skill, "description"),
                    s(skill, "instructions")
                );
                push_section(
                    &mut a.instructions,
                    &format!("Skill: {}", s(skill, "name")),
                    &body,
                );
            }
            for r in bot
                .get("routines")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let what = [s(r, "name"), s(r, "instruction")]
                    .iter()
                    .filter(|x| !x.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(": ");
                let trigger = s(r, "trigger");
                if trigger.is_empty() || trigger == "schedule" {
                    // `schedule_cron` as asked; a bot writing its own export
                    // sometimes says `cron` or `schedule` instead.
                    let cron = [s(r, "schedule_cron"), s(r, "cron"), s(r, "schedule")]
                        .into_iter()
                        .find(|c| !c.is_empty())
                        .unwrap_or("");
                    let when = cron_words(cron)
                        .or_else(|| {
                            Some(s(r, "schedule_text").to_string()).filter(|t| !t.is_empty())
                        })
                        .unwrap_or_else(|| cron.to_string());
                    a.routines.push((
                        when,
                        with_zone(&what, r.get("timezone").and_then(Value::as_str)),
                    ));
                } else {
                    let details = s(r, "trigger_details");
                    let when = if details.is_empty() {
                        format!("something arrives from {trigger}")
                    } else {
                        format!("{trigger}: {details}")
                    };
                    a.watches.push((when, what));
                }
            }
            for app in bot
                .get("apps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                // The MCP address stays behind: it can carry a key. Just a
                // name ("apps": ["Linear"]) is the same app.
                let n = app
                    .as_str()
                    .map(str::trim)
                    .unwrap_or_else(|| s(app, "name"));
                if !n.is_empty() {
                    a.apps.push((n.to_string(), String::new()));
                }
            }
            if !named_only.is_empty() {
                a.context = format!("Skills it had there:\n- {}", named_only.join("\n- "));
            }
            about(out, "personal", strings(bot.get("user_facts")));
            out.add_agent(a);
        }
    }
}

/* ------------------------------------------------------------ OpenBot */

/// An OpenBot routine schedule (`{kind: daily, time}`…) in words.
fn openbot_when(schedule: &Value) -> String {
    let time = s(schedule, "time");
    match s(schedule, "kind") {
        "hourly" => "every hour".into(),
        "daily" => format!("every day at {time}"),
        "weekdays" => format!("every weekday at {time}"),
        "weekly" => {
            let day = schedule
                .get("weekday")
                .and_then(Value::as_u64)
                .map(|d| DAYS[(d % 7) as usize])
                .unwrap_or("week");
            format!("every {day} at {time}")
        }
        "monthly" => {
            let day = schedule.get("day").and_then(Value::as_u64).unwrap_or(1) as u32;
            format!("every month on the {} at {time}", ordinal(day))
        }
        "interval" => {
            let n = schedule.get("amount").and_then(Value::as_u64).unwrap_or(0);
            match s(schedule, "unit") {
                "minutes" | "minute" => minutes_words(n),
                "hours" | "hour" => minutes_words(n * 60),
                unit => format!("every {n} {unit}"),
            }
        }
        "custom" => {
            let expr = s(schedule, "expression");
            cron_words(expr).unwrap_or_else(|| expr.to_string())
        }
        other => format!("{other} {time}").trim().to_string(),
    }
}

fn openbot_routines(a: &mut Agent, list: Option<&Value>) {
    for r in list.and_then(Value::as_array).into_iter().flatten() {
        let what = [s(r, "name"), s(r, "instruction")]
            .iter()
            .filter(|x| !x.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(": ");
        let when = r.get("schedule").map(openbot_when).unwrap_or_default();
        a.routines.push((
            when,
            with_zone(&what, r.get("timezone").and_then(Value::as_str)),
        ));
    }
}

/// A skill folder's SKILL.md: its front matter's name and description.
fn skill_line(files: &Files, dir: &str) -> Option<String> {
    let text = files.get(&format!("{dir}/SKILL.md"))?;
    let mut name = dir.rsplit('/').next().unwrap_or(dir).to_string();
    let mut description = String::new();
    if let Some(front) = text.strip_prefix("---") {
        for line in front.lines().take_while(|l| l.trim() != "---") {
            if let Some(v) = line.strip_prefix("name:") {
                name = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("description:") {
                description = v.trim().trim_matches('"').to_string();
            }
        }
    }
    Some(if description.is_empty() {
        name
    } else {
        format!("{name}: {description}")
    })
}

fn openbot_import(v: &Value, files: &Files, path: &str, out: &mut Export) {
    out.format = Format::OpenBotImport;
    out.read.push(path.to_string());
    if let Some(app) = v
        .get("source")
        .and_then(|s| s.get("app"))
        .and_then(Value::as_str)
    {
        out.source = match app {
            "grok-bot" => "Grok Bot".into(),
            other => other.to_string(),
        };
    }
    for item in v
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = if s(item, "name").is_empty() {
            s(item, "key")
        } else {
            s(item, "name")
        };
        if name.is_empty() {
            continue;
        }
        let mut a = agent(name);
        a.role = s(item, "title").to_string();
        a.instructions = s(item, "description").to_string();
        a.memory = strings(item.get("memories")).join("\n");
        openbot_routines(&mut a, item.get("routines"));
        let skills: Vec<String> = strings(item.get("skills"))
            .iter()
            .map(|dir| {
                skill_line(files, dir)
                    .unwrap_or_else(|| dir.rsplit('/').next().unwrap_or(dir).to_string())
            })
            .collect();
        if !skills.is_empty() {
            a.context = format!("Skills it had there:\n- {}", skills.join("\n- "));
        }
        out.add_agent(a);
    }
    for ch in v
        .get("channels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let members = strings(ch.get("members"));
        let note = format!(
            "In the group \"{}\" ({}): {}",
            if s(ch, "name").is_empty() {
                s(ch, "key")
            } else {
                s(ch, "name")
            },
            members.join(", "),
            s(ch, "instructions")
        );
        about(out, "tasks", [note]);
    }
}

fn openbot_transfer(v: &Value, path: &str, out: &mut Export) {
    out.format = Format::OpenBotTransfer;
    out.read.push(path.to_string());
    for item in v
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = if s(item, "name").is_empty() {
            s(item, "key")
        } else {
            s(item, "name")
        };
        if name.is_empty() {
            continue;
        }
        let mut a = agent(name);
        a.role = s(item, "title").to_string();
        a.instructions = s(item, "description").to_string();
        a.memory = strings(item.get("memories")).join("\n");
        openbot_routines(&mut a, item.get("routines"));
        openbot_routines(&mut a, item.get("oneTimeRoutines"));
        let skills = strings(item.get("skills"));
        if !skills.is_empty() {
            a.context = format!("Skills it had there: {}", skills.join(", "));
        }
        out.add_agent(a);
    }
    // MCP servers by name only (OpenBot blanks their values anyway).
    if let Some(servers) = v
        .get("settings")
        .and_then(|s| s.get("mcpServers"))
        .and_then(Value::as_object)
    {
        about(
            out,
            "accounts",
            servers
                .keys()
                .map(|k| format!("{k} (an MCP server it had)")),
        );
    }
}

/* ----------------------------------------------------------- OpenClaw */

fn is_openclaw(files: &Files) -> bool {
    files.get("openclaw.json").is_some()
        || files.list.iter().any(|(p, _)| {
            let lower = p.to_ascii_lowercase();
            lower.ends_with("agents.md")
                && files
                    .get(&lower.replace("agents.md", "identity.md"))
                    .or_else(|| files.get(&lower.replace("agents.md", "soul.md")))
                    .is_some()
        })
}

/// "- **Name:** Clawd" in IDENTITY.md.
fn identity_name(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let l = l.trim().trim_start_matches(['-', '*', ' ']);
        let rest = l
            .strip_prefix("**Name:**")
            .or_else(|| l.strip_prefix("Name:"))
            .or_else(|| l.strip_prefix("**Name**:"))?;
        let name = rest.trim().trim_matches(['*', '_', '"']).trim();
        (!name.is_empty() && !name.starts_with('(')).then(|| name.to_string())
    })
}

fn openclaw(files: &Files, out: &mut Export) {
    out.format = Format::OpenClaw;
    // Workspaces: "" (a workspace picked itself), "workspace", "workspace-<id>".
    let mut spaces: Vec<(String, String)> = Vec::new(); // (dir, agent id)
    if files.get("AGENTS.md").is_some() {
        spaces.push((String::new(), "main".into()));
    }
    let mut dirs: Vec<String> = files
        .list
        .iter()
        .filter_map(|(p, _)| {
            let (dir, file) = p.split_once('/')?;
            (file.eq_ignore_ascii_case("AGENTS.md") && dir.starts_with("workspace"))
                .then(|| dir.to_string())
        })
        .collect();
    dirs.sort();
    dirs.dedup();
    for dir in dirs {
        let id = dir.strip_prefix("workspace-").unwrap_or("main").to_string();
        spaces.push((dir, id));
    }
    // Names from openclaw.json: agents.entries.<id>.name (or .identity.name),
    // or the legacy agents.list[].
    let mut names: Vec<(String, String)> = Vec::new();
    if let Some(cfg) = files.get("openclaw.json") {
        out.read.push("openclaw.json (agent names only)".into());
        match serde_json::from_str::<Value>(cfg) {
            Ok(v) => {
                let agents = v.get("agents");
                let name_of = |e: &Value| {
                    let n = s(e, "name");
                    if n.is_empty() {
                        e.get("identity")
                            .map(|i| s(i, "name").to_string())
                            .unwrap_or_default()
                    } else {
                        n.to_string()
                    }
                };
                if let Some(entries) = agents
                    .and_then(|a| a.get("entries"))
                    .and_then(Value::as_object)
                {
                    for (id, e) in entries {
                        names.push((id.clone(), name_of(e)));
                    }
                }
                for e in agents
                    .and_then(|a| a.get("list"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    names.push((s(e, "id").to_string(), name_of(e)));
                }
            }
            // JSON5 configs exist: names then come from IDENTITY.md.
            Err(_) => out
                .skipped
                .push("openclaw.json (not plain JSON; names read from IDENTITY.md)".into()),
        }
    }
    let at = |dir: &str, file: &str| {
        if dir.is_empty() {
            file.to_string()
        } else {
            format!("{dir}/{file}")
        }
    };
    let mut ids: Vec<String> = Vec::new();
    for (dir, id) in &spaces {
        let get = |f: &str| files.get(&at(dir, f)).unwrap_or("");
        let name = names
            .iter()
            .find(|(i, n)| i == id && !n.is_empty())
            .map(|(_, n)| n.clone())
            .or_else(|| identity_name(get("IDENTITY.md")))
            .unwrap_or_else(|| {
                if id == "main" {
                    "OpenClaw".into()
                } else {
                    id.clone()
                }
            });
        let mut a = agent(&name);
        let mut instructions = String::new();
        push_section(&mut instructions, "", get("AGENTS.md"));
        push_section(&mut instructions, "Who it is (SOUL.md)", get("SOUL.md"));
        push_section(
            &mut instructions,
            "Its identity (IDENTITY.md)",
            get("IDENTITY.md"),
        );
        push_section(&mut instructions, "Tool notes (TOOLS.md)", get("TOOLS.md"));
        push_section(
            &mut instructions,
            "What it checked on every heartbeat there (HEARTBEAT.md)",
            get("HEARTBEAT.md"),
        );
        a.instructions = instructions;
        let mut memory = get("MEMORY.md").trim().to_string();
        // Daily notes, newest first: the most useful survive the review's cap.
        let memory_dir = at(dir, "memory");
        let mut days: Vec<(&str, &str)> = files
            .under(&memory_dir)
            .filter(|(p, _)| !p.contains('/') && p.to_ascii_lowercase().ends_with(".md"))
            .collect();
        days.sort_by(|a, b| b.0.cmp(a.0));
        for (day, text) in &days {
            push_section(&mut memory, day.trim_end_matches(".md"), text);
        }
        a.memory = memory;
        let user = get("USER.md");
        if !user.trim().is_empty() {
            about(out, "personal", [user.trim().to_string()]);
        }
        for f in [
            "AGENTS.md",
            "SOUL.md",
            "IDENTITY.md",
            "TOOLS.md",
            "HEARTBEAT.md",
            "MEMORY.md",
            "USER.md",
        ] {
            if files.get(&at(dir, f)).is_some() {
                out.read.push(at(dir, f));
            }
        }
        if !days.is_empty() {
            out.read.push(format!(
                "{} ({} daily notes)",
                at(dir, "memory/"),
                days.len()
            ));
        }
        ids.push(id.clone());
        out.add_agent(a);
    }
    // Legacy scheduled jobs (before 2026.6.1 they were a file).
    if let Some(jobs) = files.get("cron/jobs.json") {
        out.read.push("cron/jobs.json".into());
        let v: Value = serde_json::from_str(jobs).unwrap_or(Value::Null);
        let list = v.get("jobs").cloned().unwrap_or(v);
        for job in list.as_array().into_iter().flatten() {
            let (when, what) = openclaw_job(job);
            let owner = s(job, "agentId");
            let i = ids.iter().position(|i| i == owner).unwrap_or(0);
            if let Some(a) = out.agents.get_mut(i) {
                a.routines.push((when, what));
            }
        }
    } else {
        out.skipped.push(
            "OpenClaw's scheduled jobs: it keeps them in a database since 2026.6.1. Ask OpenClaw to list them, then add them here".into(),
        );
    }
}

fn openclaw_job(job: &Value) -> (String, String) {
    let sched = job.get("schedule").cloned().unwrap_or(Value::Null);
    let when = match s(&sched, "kind") {
        "cron" => {
            let expr = s(&sched, "expr");
            cron_words(expr).unwrap_or_else(|| expr.to_string())
        }
        "every" => {
            minutes_words(sched.get("everyMs").and_then(Value::as_u64).unwrap_or(0) / 60_000)
        }
        "at" => match sched.get("at") {
            Some(Value::String(at)) => once_words(at),
            Some(Value::Number(ms)) => ms
                .as_i64()
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|t| {
                    t.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M")
                        .to_string()
                })
                .unwrap_or_default(),
            _ => String::new(),
        },
        other => other.to_string(),
    };
    let payload = job.get("payload").cloned().unwrap_or(Value::Null);
    let body = [s(&payload, "message"), s(&payload, "text")]
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or("");
    let what = [s(job, "name"), body]
        .iter()
        .filter(|x| !x.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(": ");
    (
        when,
        with_zone(&what, sched.get("tz").and_then(Value::as_str)),
    )
}

/* ------------------------------------------------------------- Hermes */

fn hermes_root(files: &Files, dir: &str) -> bool {
    let at = |f: &str| {
        if dir.is_empty() {
            f.to_string()
        } else {
            format!("{dir}/{f}")
        }
    };
    files.get(&at("SOUL.md")).is_some()
        && (files.get(&at("memories/MEMORY.md")).is_some()
            || files.get(&at("memories/USER.md")).is_some()
            || files.get(&at("cron/jobs.json")).is_some())
}

fn is_hermes(files: &Files) -> bool {
    hermes_root(files, "") || !hermes_profiles(files).is_empty()
}

fn hermes_profiles(files: &Files) -> Vec<String> {
    let mut out: Vec<String> = files
        .list
        .iter()
        .filter_map(|(p, _)| {
            let rest = p.strip_prefix("profiles/")?;
            let (name, file) = rest.split_once('/')?;
            file.eq_ignore_ascii_case("SOUL.md")
                .then(|| name.to_string())
        })
        .filter(|name| hermes_root(files, &format!("profiles/{name}")))
        .collect();
    out.sort();
    out.dedup();
    out
}

fn hermes(files: &Files, out: &mut Export) {
    out.format = Format::Hermes;
    let mut roots: Vec<(String, String)> = Vec::new();
    if hermes_root(files, "") {
        roots.push((String::new(), "Hermes".into()));
    }
    for p in hermes_profiles(files) {
        roots.push((format!("profiles/{p}"), p));
    }
    for (dir, name) in roots {
        let at = |f: &str| {
            if dir.is_empty() {
                f.to_string()
            } else {
                format!("{dir}/{f}")
            }
        };
        let get = |f: &str| files.get(&at(f)).unwrap_or("");
        let mut a = agent(&name);
        a.instructions = get("SOUL.md").trim().to_string();
        a.memory = get("memories/MEMORY.md")
            .split('\n')
            .map(str::trim)
            .filter(|l| !l.is_empty() && *l != "§")
            .collect::<Vec<_>>()
            .join("\n");
        let user: Vec<String> = get("memories/USER.md")
            .split("\n§\n")
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        about(out, "personal", user);
        let mut skills: Vec<String> = files
            .under(&at("skills"))
            .filter_map(|(p, _)| {
                let dir = p.strip_suffix("/SKILL.md")?;
                skill_line(files, &at(&format!("skills/{dir}")))
            })
            .collect();
        skills.sort();
        if !skills.is_empty() {
            a.context = format!("Skills it had there:\n- {}", skills.join("\n- "));
            out.read
                .push(format!("{} ({} skills)", at("skills/"), skills.len()));
        }
        if let Some(jobs) = files.get(&at("cron/jobs.json")) {
            out.read.push(at("cron/jobs.json"));
            let v: Value = serde_json::from_str(jobs).unwrap_or(Value::Null);
            for job in v
                .get("jobs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let sched = job.get("schedule").cloned().unwrap_or(Value::Null);
                let when = match s(&sched, "kind") {
                    "cron" => {
                        let expr = s(&sched, "expr");
                        cron_words(expr).unwrap_or_else(|| expr.to_string())
                    }
                    "interval" => {
                        minutes_words(sched.get("minutes").and_then(Value::as_u64).unwrap_or(0))
                    }
                    "once" => once_words(s(&sched, "run_at")),
                    _ => s(&sched, "display").to_string(),
                };
                let what = [s(job, "name"), s(job, "prompt")]
                    .iter()
                    .filter(|x| !x.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(": ");
                if !what.is_empty() {
                    a.routines.push((when, what));
                }
            }
        }
        for f in ["SOUL.md", "memories/MEMORY.md", "memories/USER.md"] {
            if files.get(&at(f)).is_some() {
                out.read.push(at(f));
            }
        }
        out.add_agent(a);
    }
}

#[cfg(test)]
pub(crate) fn files_for_test(list: &[(&str, &str)]) -> Files {
    Files {
        list: list
            .iter()
            .map(|(p, t)| (p.to_string(), t.to_string()))
            .collect(),
        skipped: Vec::new(),
    }
}
