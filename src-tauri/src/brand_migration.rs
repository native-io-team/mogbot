//! # Carrying state over a rename
//!
//! Every place this app keeps state is named from `brand.json`: the
//! app-support and log folders (`appDirName`), the `~/.<slug>` account homes,
//! the webview's storage (the binary's name, which is the slug, or the bundle
//! identifier), the reopen-at-login LaunchAgent (`<identifier>.…`) and every
//! Keychain item (`<slug>-…`). Renaming the app moves all of them, so the
//! first launch under a new name would find nothing and start over.
//!
//! When `brand.json` names a `previous` identity, [`run_at_startup`] moves
//! that identity's folders to the current names once, before anything reads
//! them (it is the first thing `lib.rs` does). Keychain items are carried
//! over lazily, on their first read, by `crate::keychain` ("Carrying secrets
//! over a rename"). Remote Access's old Funnel mount is removed the next time
//! it is turned on (`remote_access::tailscale`), and the Chrome native host's
//! old manifest the next time it is installed (`user_chrome::install`).
//!
//! ## Never losing anything
//!
//! - **Rename, never copy-then-delete,** and only onto a name that doesn't
//!   exist yet (or is an empty folder). When both names hold something, the
//!   old one is left exactly where it is and the conflict is logged on every
//!   launch until someone sorts it out; nothing is merged or overwritten.
//! - **The old app-support folder and `~/.<old slug>` become links** to the
//!   new ones, so an absolute path written down somewhere this migration
//!   doesn't rewrite (an agent's script, its chat history, an engine's own
//!   transcript) still resolves.
//! - **Not while the old app runs.** Moving a live app's folder out from
//!   under it would lose whatever it writes next, so a launch that finds the
//!   previous build running does nothing and tries again next time.
//! - **Crash-safe by being idempotent.** Each step checks the disk before it
//!   acts, so a launch that stops half-way finishes the rest next time. The
//!   marker that says "done" is written last.
//! - Absolute paths to the old app-support folder are rewritten where the
//!   app itself reads them as instructions: the agents' registries
//!   (`agents/*.json`, routines' prompts among them) and each agent's
//!   `CLAUDE.md`. Chat logs and turn records are history and are left as
//!   they were (the link keeps their paths working).

use std::path::{Path, PathBuf};

/// One identity's names, as the migration needs them.
#[derive(Debug, Clone)]
pub struct Names {
    pub slug: String,
    pub identifier: String,
    pub app_dir_name: String,
}

/// Where everything lives for one home folder, old and new.
#[derive(Debug, Clone)]
pub struct Layout {
    pub home: PathBuf,
    pub old: Names,
    pub new: Names,
}

impl Layout {
    fn support(&self, n: &Names) -> PathBuf {
        self.home
            .join("Library/Application Support")
            .join(&n.app_dir_name)
    }
    fn support_by_id(&self, n: &Names) -> PathBuf {
        self.home
            .join("Library/Application Support")
            .join(&n.identifier)
    }
    fn logs(&self, n: &Names) -> PathBuf {
        self.home.join("Library/Logs").join(&n.app_dir_name)
    }
    fn dot(&self, n: &Names) -> PathBuf {
        self.home.join(format!(".{}", n.slug))
    }
    fn webkit(&self, name: &str) -> PathBuf {
        self.home.join("Library/WebKit").join(name)
    }
    fn launch_agent(&self, n: &Names) -> PathBuf {
        self.home
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", launch_agent_label(n)))
    }
    /// Written last: the migration from `old` is finished.
    fn marker(&self) -> PathBuf {
        self.support(&self.new)
            .join(format!(".renamed-from-{}", self.old.slug))
    }
}

fn launch_agent_label(n: &Names) -> String {
    format!("{}.reopen-at-login", n.identifier)
}

/// The previous and current identities from `brand.json`, for this user's
/// home. `None` when there is no previous identity.
pub fn layout() -> Option<Layout> {
    use crate::brand;
    let old = Names {
        slug: brand::previous::SLUG?.to_string(),
        identifier: brand::previous::IDENTIFIER?.to_string(),
        app_dir_name: brand::previous::APP_DIR_NAME?.to_string(),
    };
    if old.slug == brand::SLUG || old.app_dir_name == brand::APP_DIR_NAME {
        return None;
    }
    Some(Layout {
        home: dirs::home_dir()?,
        old,
        new: Names {
            slug: brand::SLUG.to_string(),
            identifier: brand::IDENTIFIER.to_string(),
            app_dir_name: brand::APP_DIR_NAME.to_string(),
        },
    })
}

/// Whether a build under the previous name is running now (its binary is
/// named after the slug in a development build, after the product name in
/// an installed one).
///
/// `pgrep` directly rather than `run_with_timeout`: this runs before the
/// async runtime exists, and a local `pgrep` answers in milliseconds.
#[cfg(target_os = "macos")]
#[allow(clippy::disallowed_methods)]
fn previous_app_running(old: &Names) -> bool {
    let mut names = vec![old.slug.clone()];
    if let Some(name) = crate::brand::previous::NAME {
        names.push(name.to_string());
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() }.to_string();
    names.iter().any(|name| {
        std::process::Command::new("/usr/bin/pgrep")
            .args(["-x", "-U", &uid, name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    })
}

/// Run the migration for this user, once. Called before logging starts (the
/// log folder is one of the things it moves), so it returns what it did as
/// lines for the caller to log.
pub fn run_at_startup() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let Some(layout) = layout() else {
            return Vec::new();
        };
        if layout.marker().exists() {
            return Vec::new();
        }
        let bundle = crate::remote_access::power::app_bundle_path();
        migrate(
            &layout,
            previous_app_running(&layout.old),
            bundle.as_deref(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Is `dir` missing, or a folder with nothing in it but Finder's litter?
fn absent_or_empty(dir: &Path) -> bool {
    if std::fs::symlink_metadata(dir).is_err() {
        return true;
    }
    if !dir.is_dir() || dir.is_symlink() {
        return false;
    }
    std::fs::read_dir(dir)
        .is_ok_and(|entries| entries.flatten().all(|e| e.file_name() == ".DS_Store"))
}

/// What moving one folder did.
#[derive(Debug, PartialEq, Eq)]
enum Moved {
    /// Nothing under the old name (or it is already our link).
    Nothing,
    Done,
    /// Both names hold something: the old one is left alone.
    Conflict,
    Failed(String),
}

/// Rename `old` to `new` when `new` is free; with `link`, leave a symlink at
/// `old` pointing to `new`.
fn move_dir(old: &Path, new: &Path, link: bool) -> Moved {
    let Ok(meta) = std::fs::symlink_metadata(old) else {
        return Moved::Nothing;
    };
    if meta.file_type().is_symlink() {
        return Moved::Nothing;
    }
    if !meta.is_dir() {
        return Moved::Nothing;
    }
    if !absent_or_empty(new) {
        return Moved::Conflict;
    }
    if std::fs::symlink_metadata(new).is_ok() {
        // An empty folder (made by something that ran before us): make way.
        let _ = std::fs::remove_file(new.join(".DS_Store"));
        if let Err(e) = std::fs::remove_dir(new) {
            return Moved::Failed(format!("couldn't clear the empty {}: {e}", new.display()));
        }
    }
    if let Some(parent) = new.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::rename(old, new) {
        return Moved::Failed(format!(
            "couldn't move {} to {}: {e}",
            old.display(),
            new.display()
        ));
    }
    #[cfg(unix)]
    if link {
        // Best effort: the move is what matters; the link only keeps old
        // absolute paths working.
        let _ = std::os::unix::fs::symlink(new, old);
    }
    #[cfg(not(unix))]
    let _ = link;
    Moved::Done
}

/// `text` with every absolute path into the old app-support folder pointed
/// at the new one. Matches `…Support/<Old>` followed by anything but a
/// letter or digit, so the shell-escaped (`Application\ Support/…`) and
/// JSON-escaped spellings are covered and `<Old>Site` is not. `None` when
/// nothing changes.
pub fn rewrite_support_paths(text: &str, old_dir: &str, new_dir: &str) -> Option<String> {
    let needle = format!("Support/{old_dir}");
    if !text.contains(&needle) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut changed = false;
    while let Some(at) = rest.find(&needle) {
        let end = at + needle.len();
        let boundary = rest[end..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric());
        out.push_str(&rest[..at]);
        if boundary {
            out.push_str("Support/");
            out.push_str(new_dir);
            changed = true;
        } else {
            out.push_str(&needle);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    changed.then_some(out)
}

/// Rewrite one file in place (atomically, keeping its permissions).
fn rewrite_file(path: &Path, old_dir: &str, new_dir: &str) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(false); // missing, or not text: not ours to touch
    };
    let Some(next) = rewrite_support_paths(&text, old_dir, new_dir) else {
        return Ok(false);
    };
    let perms = std::fs::metadata(path).map(|m| m.permissions()).ok();
    let tmp = path.with_extension(format!(
        "{}.renaming",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, next).map_err(|e| format!("{}: {e}", tmp.display()))?;
    if let Some(p) = perms {
        let _ = std::fs::set_permissions(&tmp, p);
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// The files under the (new) app-support folder whose old absolute paths are
/// rewritten: the agents' registries, and each agent's instructions.
fn files_to_rewrite(support: &Path) -> Vec<PathBuf> {
    let agents = support.join("agents");
    let mut out = Vec::new();
    let mut agent_dirs = Vec::new();
    for entry in std::fs::read_dir(&agents).into_iter().flatten().flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name == "recently-deleted" {
                for e in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                    agent_dirs.push(e.path());
                }
            } else {
                agent_dirs.push(path);
            }
        } else if name.ends_with(".json") || name.ends_with(".json.bak") {
            out.push(path);
        }
    }
    for dir in agent_dirs {
        out.push(dir.join("CLAUDE.md"));
        out.push(dir.join("AGENTS.md"));
    }
    out.retain(|p| p.is_file());
    out.sort();
    out
}

/// The reopen-at-login agent, under its new label: written for `bundle` when
/// this build runs from one, else the old file's own contents with the label
/// changed. The old file goes once the new one is written.
fn move_launch_agent(layout: &Layout, bundle: Option<&Path>) -> Result<bool, String> {
    let old = layout.launch_agent(&layout.old);
    let Ok(text) = std::fs::read_to_string(&old) else {
        return Ok(false);
    };
    let new = layout.launch_agent(&layout.new);
    if !new.exists() {
        let body = match bundle {
            Some(b) => crate::remote_access::power::launch_agent_plist(b),
            None => text.replace(
                &format!("<string>{}</string>", launch_agent_label(&layout.old)),
                &format!("<string>{}</string>", launch_agent_label(&layout.new)),
            ),
        };
        std::fs::write(&new, body).map_err(|e| format!("{}: {e}", new.display()))?;
    }
    std::fs::remove_file(&old).map_err(|e| format!("{}: {e}", old.display()))?;
    Ok(true)
}

/// The whole migration for `layout`. Every step is safe to repeat.
pub fn migrate(layout: &Layout, previous_running: bool, bundle: Option<&Path>) -> Vec<String> {
    let mut log = Vec::new();
    let (old, new) = (&layout.old, &layout.new);
    if previous_running {
        log.push(format!(
            "[Rename] {} is still running: not moving its folders this launch (quit it and reopen this app)",
            crate::brand::previous::NAME.unwrap_or(&old.app_dir_name)
        ));
        return log;
    }
    let mut done = true;
    let mut note = |what: &str, moved: Moved, log: &mut Vec<String>, required: bool| match moved {
        Moved::Nothing => {}
        Moved::Done => log.push(format!("[Rename] moved {what}")),
        Moved::Conflict => {
            log.push(format!(
                "[Rename] {what}: both the old and the new folder hold something; the old one is left where it is"
            ));
            if required {
                done = false;
            }
        }
        Moved::Failed(e) => {
            log.push(format!("[Rename] {what}: {e}"));
            if required {
                done = false;
            }
        }
    };

    let support = move_dir(&layout.support(old), &layout.support(new), true);
    note("the app-support folder", support, &mut log, true);
    let by_id = move_dir(
        &layout.support_by_id(old),
        &layout.support_by_id(new),
        false,
    );
    note(
        "the identifier's app-support folder",
        by_id,
        &mut log,
        false,
    );
    let logs = move_dir(&layout.logs(old), &layout.logs(new), false);
    note("the log folder", logs, &mut log, false);
    let dot = move_dir(&layout.dot(old), &layout.dot(new), true);
    note("the account homes", dot, &mut log, true);
    for (from, to) in [(&old.slug, &new.slug), (&old.identifier, &new.identifier)] {
        let webkit = move_dir(&layout.webkit(from), &layout.webkit(to), false);
        note("the window's saved settings", webkit, &mut log, false);
    }
    match move_launch_agent(layout, bundle) {
        Ok(true) => log.push("[Rename] moved the reopen-at-login item".into()),
        Ok(false) => {}
        Err(e) => log.push(format!("[Rename] the reopen-at-login item: {e}")),
    }

    let new_support = layout.support(new);
    let mut rewritten = 0;
    for file in files_to_rewrite(&new_support) {
        match rewrite_file(&file, &old.app_dir_name, &new.app_dir_name) {
            Ok(true) => rewritten += 1,
            Ok(false) => {}
            Err(e) => {
                log.push(format!("[Rename] couldn't update a path in {e}"));
                done = false;
            }
        }
    }
    if rewritten > 0 {
        log.push(format!(
            "[Rename] pointed {rewritten} file(s) at the new folder"
        ));
    }

    if done && new_support.is_dir() {
        let body = serde_json::json!({
            "from": old.app_dir_name,
            "to": new.app_dir_name,
            "at": chrono::Utc::now().to_rfc3339(),
        });
        if let Err(e) = std::fs::write(layout.marker(), body.to_string()) {
            log.push(format!(
                "[Rename] couldn't record that the move is done: {e}"
            ));
        }
    }
    log
}

#[cfg(test)]
#[path = "brand_migration_tests.rs"]
mod tests;
