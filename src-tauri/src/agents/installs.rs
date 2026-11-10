//! Code from the network: which packages are already the project's.
//!
//! At "Go hard" installs go through without a card. In a turn that read
//! outside content (`exposure`), one that fetches a package new to the
//! project asks (`autoallow::after_outside_asks`). A package is the
//! project's when it is:
//! - declared in its manifest or lockfile (`package.json`, `requirements*.txt`,
//!   `pyproject.toml`, `Cargo.toml` / `Cargo.lock`, `go.mod`, `Brewfile`),
//!   or already installed in its `node_modules`, in the folder the command
//!   runs in or any folder above it up to the home;
//! - on a short list of well-known tools ([`well_known`]);
//! - or one the user already allowed on a card for this project
//!   ([`remembered`]): each new package asks at most once per project.
//!
//! An install with no package named (`pnpm install`, `npm ci`,
//! `pip install -r requirements.txt`, `cargo build`) fetches only what the
//! project declares.
//!
//! "This project" is the project a bound agent works on (its copies count as
//! the project), or an unbound agent's own home. Saved beside the agents
//! (`installs.json`).

use crate::agents::store::OrLog;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where a package comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eco {
    Npm,
    Pip,
    Cargo,
    Go,
    Brew,
}

impl Eco {
    fn tag(self) -> &'static str {
        match self {
            Eco::Npm => "npm",
            Eco::Pip => "pip",
            Eco::Cargo => "cargo",
            Eco::Go => "go",
            Eco::Brew => "brew",
        }
    }
}

/// `npm:zod`: how a package is remembered.
pub fn entry(eco: Eco, name: &str) -> String {
    format!("{}:{name}", eco.tag())
}

/// The package a spec names, without its version (`zod@3` → `zod`,
/// `@scope/x@1` → `@scope/x`, `requests==2.31` → `requests`).
pub fn package_name(eco: Eco, spec: &str) -> Option<String> {
    let spec = spec.trim();
    if spec.is_empty() || spec.starts_with('-') {
        return None;
    }
    let name = match eco {
        Eco::Npm => {
            let (scope, rest) = match spec.strip_prefix('@') {
                Some(r) => ("@", r),
                None => ("", spec),
            };
            let base = rest.split('@').next().unwrap_or("");
            // `npm:alias@…` and other protocols stay as written: they ask.
            format!("{scope}{base}")
        }
        Eco::Pip => spec
            .split(['=', '<', '>', '~', '!', '[', ';', ' ', '@'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .replace('_', "-"),
        Eco::Cargo | Eco::Go | Eco::Brew => spec.split('@').next().unwrap_or("").to_string(),
    };
    (!name.is_empty() && name != "@").then_some(name)
}

/// Tools common enough that installing them needs no card.
pub fn well_known(eco: Eco, name: &str) -> bool {
    let list: &[&str] = match eco {
        Eco::Npm => &[
            "typescript",
            "tsx",
            "ts-node",
            "prettier",
            "eslint",
            "vitest",
            "jest",
            "@biomejs/biome",
            "biome",
            "tsc",
            "playwright",
            "@playwright/test",
        ],
        Eco::Pip => &[
            "pip",
            "setuptools",
            "wheel",
            "build",
            "pytest",
            "ruff",
            "black",
            "mypy",
            "uv",
        ],
        Eco::Brew => &[
            "jq",
            "ripgrep",
            "gh",
            "git",
            "node",
            "pnpm",
            "uv",
            "python",
            "ffmpeg",
            "tree",
            "wget",
            "coreutils",
        ],
        Eco::Cargo | Eco::Go => &[],
    };
    list.contains(&name)
}

/// Whether `name` is already the project's: declared in a manifest or
/// lockfile, or installed in `node_modules`, in `cwd` or a folder above it
/// (never above `stop`, the home).
pub fn declared(eco: Eco, name: &str, cwd: &Path, stop: &Path) -> bool {
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        if declared_in(eco, name, d) {
            return true;
        }
        if d == stop || !d.starts_with(stop) {
            break;
        }
        dir = d.parent();
    }
    false
}

fn read(p: PathBuf) -> Option<String> {
    let meta = std::fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
        return None;
    }
    std::fs::read_to_string(p).ok()
}

fn declared_in(eco: Eco, name: &str, dir: &Path) -> bool {
    match eco {
        Eco::Npm => {
            let in_manifest = read(dir.join("package.json"))
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .is_some_and(|v| {
                    [
                        "dependencies",
                        "devDependencies",
                        "optionalDependencies",
                        "peerDependencies",
                    ]
                    .iter()
                    .any(|k| v.get(k).and_then(|d| d.get(name)).is_some())
                });
            in_manifest
                || dir
                    .join("node_modules")
                    .join(name)
                    .join("package.json")
                    .is_file()
                || dir.join("node_modules/.bin").join(name).exists()
        }
        Eco::Pip => {
            let mut texts: Vec<String> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    let n = e.file_name().to_string_lossy().to_ascii_lowercase();
                    if (n.starts_with("requirements") && n.ends_with(".txt"))
                        || matches!(
                            n.as_str(),
                            "pyproject.toml" | "pipfile" | "setup.cfg" | "uv.lock" | "poetry.lock"
                        )
                    {
                        texts.extend(read(e.path()));
                    }
                }
            }
            texts
                .iter()
                .any(|t| mentions(&t.to_ascii_lowercase().replace('_', "-"), name))
        }
        Eco::Cargo => ["Cargo.toml", "Cargo.lock"].iter().any(|f| {
            read(dir.join(f)).is_some_and(|t| {
                t.lines().any(|l| {
                    let l = l.trim();
                    l.strip_prefix(name).is_some_and(|r| {
                        let r = r.trim_start();
                        r.starts_with('=') || r.starts_with(".workspace")
                    }) || l == format!("name = \"{name}\"")
                })
            })
        }),
        Eco::Go => read(dir.join("go.mod"))
            .is_some_and(|t| t.lines().any(|l| l.split_whitespace().any(|w| w == name))),
        Eco::Brew => read(dir.join("Brewfile")).is_some_and(|t| {
            t.contains(&format!("brew \"{name}\"")) || t.contains(&format!("brew '{name}'"))
        }),
    }
}

/// `name` stands as a word of its own in `text` (a requirements line,
/// a quoted dependency).
fn mentions(text: &str, name: &str) -> bool {
    let boundary =
        |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '.'));
    text.match_indices(name).any(|(i, _)| {
        boundary(text[..i].chars().last()) && boundary(text[i + name.len()..].chars().next())
    })
}

/* ------------------------------------------------------- remembered */

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    projects: BTreeMap<String, Vec<String>>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    super::store::agents_root()
        .ok()
        .map(|r| r.join("installs.json"))
}

fn load(path: &Path) -> Saved {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The project a remembered package belongs to: a bound agent's project, or
/// an unbound agent's own home.
pub fn key_for(project: Option<&Path>, own_home: &Path) -> PathBuf {
    project.unwrap_or(own_home).to_path_buf()
}

/// What the user already allowed for the project at `key`.
pub fn remembered(key: &Path) -> Vec<String> {
    let Some(p) = path() else { return Vec::new() };
    remembered_in(&p, key)
}

fn remembered_in(file: &Path, key: &Path) -> Vec<String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(file)
        .projects
        .remove(&key.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// The user allowed a card that installs `entries`: remember them for the
/// project, so each asks only once.
pub fn remember(key: &Path, entries: &[String]) {
    if entries.is_empty() {
        return;
    }
    if let Some(p) = path() {
        remember_in(&p, key, entries);
    }
}

fn remember_in(file: &Path, key: &Path, entries: &[String]) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut saved = load(file);
    let list = saved
        .projects
        .entry(key.to_string_lossy().to_string())
        .or_default();
    for e in entries {
        if !list.contains(e) {
            list.push(e.clone());
        }
    }
    if let Ok(json) = serde_json::to_vec_pretty(&saved) {
        super::store::write_atomic(file, &json).or_log("the packages allowed for this project");
    }
}

/// After the user allowed a command on a card: remember the packages it
/// installs that weren't the project's yet (`autoallow::new_packages`).
pub fn remember_allowed(agent: &super::store::Agent, tool: &str, input: &serde_json::Value) {
    if tool != "Bash" {
        return;
    }
    let Some(ctx) = super::autoallow::Ctx::for_agent(agent) else {
        return;
    };
    let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let new = super::autoallow::new_packages(command, &ctx);
    let Ok(own) = super::store::agent_home(&agent.id) else {
        return;
    };
    let layout = super::project::layout(agent, &own, Vec::new());
    remember(&key_for(layout.project.as_deref(), &own), &new);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_lose_their_versions() {
        assert_eq!(package_name(Eco::Npm, "zod@3.1").as_deref(), Some("zod"));
        assert_eq!(
            package_name(Eco::Npm, "@scope/kit@^1").as_deref(),
            Some("@scope/kit")
        );
        assert_eq!(
            package_name(Eco::Pip, "Fictional_Lib[extra]==2.0").as_deref(),
            Some("fictional-lib")
        );
        assert_eq!(
            package_name(Eco::Go, "example.test/mod@v1").as_deref(),
            Some("example.test/mod")
        );
        assert_eq!(package_name(Eco::Npm, "-D"), None);
    }

    #[test]
    fn a_project_declares_what_its_manifests_and_lockfiles_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let app = root.join("app");
        std::fs::create_dir_all(app.join("node_modules/left-kit")).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"devDependencies":{"fictional-test-kit":"1"}}"#,
        )
        .unwrap();
        std::fs::write(app.join("package.json"), r#"{"dependencies":{"zod":"3"}}"#).unwrap();
        std::fs::write(app.join("node_modules/left-kit/package.json"), "{}").unwrap();
        std::fs::write(
            app.join("requirements-dev.txt"),
            "requests==2.31\nfictional_tool>=1\n",
        )
        .unwrap();
        std::fs::write(app.join("Cargo.toml"), "[dependencies]\nserde = \"1\"\n").unwrap();
        std::fs::write(
            app.join("go.mod"),
            "module x\nrequire example.test/mod v1.0.0\n",
        )
        .unwrap();
        for (eco, name) in [
            (Eco::Npm, "zod"),
            (Eco::Npm, "fictional-test-kit"),
            (Eco::Npm, "left-kit"),
            (Eco::Pip, "requests"),
            (Eco::Pip, "fictional-tool"),
            (Eco::Cargo, "serde"),
            (Eco::Go, "example.test/mod"),
        ] {
            assert!(declared(eco, name, &app, root), "{name}");
        }
        for (eco, name) in [
            (Eco::Npm, "fictional-typosquat"),
            (Eco::Pip, "request"),
            (Eco::Cargo, "serde_json"),
        ] {
            assert!(!declared(eco, name, &app, root), "{name}");
        }
        // Never above the home.
        assert!(!declared(Eco::Npm, "fictional-test-kit", &app, &app));
    }

    #[test]
    fn an_allowed_package_is_remembered_for_its_project_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("installs.json");
        let a = Path::new("/Users/fictional/Projects/site");
        let b = Path::new("/Users/fictional/Projects/other");
        remember_in(&file, a, &[entry(Eco::Npm, "fictional-chart")]);
        remember_in(&file, a, &[entry(Eco::Npm, "fictional-chart")]);
        assert_eq!(remembered_in(&file, a), vec!["npm:fictional-chart"]);
        assert!(remembered_in(&file, b).is_empty());
    }
}
