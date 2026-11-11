//! Where a file call an engine asks about really lands, for the approval
//! broker (`mcp::decide`), every engine alike.
//!
//! Claude Code asks about an edit or a read with the path as written: a
//! directory link inside the project (`outdir -> ~/Library/LaunchAgents`)
//! makes `proj/outdir/x.plist` look like project work, though Claude Code
//! itself asked because it resolved the link (verified on 2.1.322). Codex's
//! sandbox refuses a write through such a link (seatbelt follows it) and its
//! approval request names the path as written too; OpenCode's out-of-folder
//! edits arrive the same way. Every rule after the card's (a level, a plan,
//! an "Always allow", the agent's settings) matches paths as text, so each
//! is judged on where the call really goes:
//!
//! - **A link crossed:** the call is judged with its path resolved, and its
//!   card says through which link.
//! - **A write that a link carries into `.git` or `.shipstudio`:** refused,
//!   as a write there as written is (`reach::claude_deny_rules`, Codex's
//!   profile).
//! - **A dangling or looping link** on a write's way (a write creates the
//!   file at its target, wherever that is): always a card, never answered
//!   by a level, a plan or a rule.
//!
//! macOS's own aliases (`/var`, `/tmp`, `/etc` → `/private/…`) are not
//! links crossed.

use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Where a file call lands.
#[derive(Debug, Clone, PartialEq)]
pub enum Landing {
    /// No link on the way (or not a file call): judged as it is.
    Direct,
    /// Through a link: judge this input (the path resolved) instead, and
    /// put the note on the card.
    Redirected { input: Value, note: String },
    /// A write through a link into `.git` / `.shipstudio`: refused, with why.
    Protected(String),
    /// A write through a link that can't be followed: a card, with this note.
    Dangling(String),
}

const WRITES: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const READS: [&str; 4] = ["Read", "Glob", "Grep", "LS"];

/// The input field holding the call's path.
fn path_field(tool: &str, input: &Value) -> Option<&'static str> {
    let has = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    };
    match tool {
        "NotebookEdit" => Some("notebook_path"),
        "Write" | "Edit" | "MultiEdit" | "Read" => Some("file_path"),
        "Glob" | "Grep" | "LS" => has("path").then_some("path"),
        _ => None,
    }
    .filter(|k| has(k))
}

/// Where `tool` called with `input` lands, from the turn's working folder
/// `cwd` and the user's `home`.
pub fn landing(tool: &str, input: &Value, cwd: &Path, home: &Path) -> Landing {
    let writing = WRITES.contains(&tool);
    if !writing && !READS.contains(&tool) {
        return Landing::Direct;
    }
    let Some(field) = path_field(tool, input) else {
        return Landing::Direct;
    };
    let raw = input[field].as_str().unwrap_or("").trim();
    let Some(lexical) = absolute(raw, cwd, home) else {
        return Landing::Direct;
    };
    if !crosses_link(&lexical) {
        return Landing::Direct;
    }
    let Some(real) = resolved(&lexical) else {
        // Reading through a link to nowhere reads nothing.
        return if writing {
            Landing::Dangling(format!(
                "{} goes through a link that points nowhere yet, so this would create a file wherever that link points.",
                lexical.display()
            ))
        } else {
            Landing::Direct
        };
    };
    if writing && protected(&real) && !protected(&lexical) {
        return Landing::Protected(format!(
            "{} is a link into {}, which is kept read-only for agents (git's and the app's own folders).",
            lexical.display(),
            real.display()
        ));
    }
    let mut judged = input.clone();
    judged[field] = Value::String(real.to_string_lossy().into_owned());
    Landing::Redirected {
        input: judged,
        note: format!(
            "{} is a link: this really {} {}.",
            lexical.display(),
            if writing { "changes" } else { "reads" },
            real.display()
        ),
    }
}

/// `~/x`, `/abs` or `rel` (against `cwd`), with `.` and `..` taken out;
/// `None` for `~other`.
fn absolute(raw: &str, cwd: &Path, home: &Path) -> Option<PathBuf> {
    let joined = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if raw.starts_with('~') {
        return None;
    } else if raw.starts_with('/') {
        PathBuf::from(raw)
    } else {
        cwd.join(raw)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Some(out)
}

/// macOS's top-level aliases into `/private`.
const SYSTEM_ALIASES: [&str; 3] = ["/var", "/tmp", "/etc"];

/// Whether any part of `p` that exists is a symlink (other than macOS's
/// own aliases).
fn crosses_link(p: &Path) -> bool {
    let mut at = PathBuf::new();
    for c in p.components() {
        at.push(c);
        if SYSTEM_ALIASES.iter().any(|a| at == Path::new(a)) {
            continue;
        }
        match at.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => return true,
            Ok(_) => {}
            // Nothing below a part that isn't there can be a link.
            Err(_) => return false,
        }
    }
    false
}

/// `p` with every link followed: its deepest existing part canonicalized,
/// then the rest as written. `None` when a part is there but can't be
/// followed (a dangling or looping link).
fn resolved(p: &Path) -> Option<PathBuf> {
    let mut existing = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut real) => {
                for part in rest.iter().rev() {
                    real.push(part);
                }
                return Some(real);
            }
            Err(_) if existing.symlink_metadata().is_ok() => return None,
            Err(_) => {}
        }
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?.to_path_buf();
    }
}

fn protected(p: &Path) -> bool {
    p.components().any(|c| {
        super::reach::PROTECTED_DIRS
            .iter()
            .any(|d| c.as_os_str() == *d)
    })
}

// Symlinks are made with std::os::unix in these tests.
#[cfg(all(test, unix))]
#[path = "links_tests.rs"]
mod tests;
