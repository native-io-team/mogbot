//! How an agent's CLI reaches the agents endpoint of the agent bridge without
//! anyone else being able to.
//!
//! The endpoint's URL carries no secret: `http://127.0.0.1:<port>/mcp/agent`
//! (or `/mcp/import` for an import's interview). The caller is named by the
//! bearer secret it sends (`broker::grant`), which is only ever:
//!
//! - **Claude Code**: in a `--mcp-config` *file* (0600, in a 0700 folder of
//!   our own), as an `Authorization` header. The command line carries the
//!   file's path. Verified on Claude Code 2.1.318: `--mcp-config <file>` with
//!   `"headers": {"Authorization": "Bearer …"}` sends the header on every
//!   request, `server/discover` and `initialize` included.
//! - **Codex**: in an environment variable of the turn's process, named by
//!   `bearer_token_env_var` on our server's `-c` entry. Verified on Codex
//!   0.166 (`app-server`): every request carries `Authorization: Bearer`.
//!
//! macOS `ps` shows any process's arguments to every local account but its
//! environment only to its owner (and root), and the config file is readable
//! by its owner alone. Before this, the bridge's one long-lived token and the
//! agent's id sat in every turn's argv.

use std::path::{Path, PathBuf};

use super::prompts::SERVER_KEY;
use crate::errors::CommandError;

/// The environment variable a Codex process reads its bridge secret from.
pub const TOKEN_ENV: &str = "SHIPSTUDIO_AGENTS_BRIDGE_TOKEN";

/// Path of the agents endpoint (a turn or a take-over).
pub const AGENT_PATH: &str = "/mcp/agent";
/// Path of an import interview's endpoint.
pub const IMPORT_PATH: &str = "/mcp/import";

pub fn agent_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{AGENT_PATH}")
}

pub fn import_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{IMPORT_PATH}")
}

/// The secret in an `Authorization: Bearer <secret>` header value.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let value = header?.trim();
    let (scheme, secret) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| secret.trim())
        .filter(|s| !s.is_empty())
}

/// Claude Code's MCP config: our one server, its URL and the secret header.
pub fn claude_config(url: &str, secret: &str) -> String {
    serde_json::json!({
        "mcpServers": {
            SERVER_KEY: {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {secret}") },
            }
        }
    })
    .to_string()
}

/// A config file that lives as long as this does.
#[derive(Debug)]
pub struct ConfigFile {
    path: PathBuf,
}

impl ConfigFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn arg(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for ConfigFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Our folder for these files: 0700, inside app support.
fn config_dir() -> PathBuf {
    crate::brand::app_support_dir().join("agent-bridge")
}

/// Write `contents` to a new 0600 file in a 0700 folder. Removed on drop.
pub fn write_config(contents: &str) -> Result<ConfigFile, CommandError> {
    write_config_in(&config_dir(), contents)
}

fn write_config_in(dir: &Path, contents: &str) -> Result<ConfigFile, CommandError> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(super::err_io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(super::err_io)?;
    }
    let path = dir.join(format!("mcp-{}.json", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(super::err_io)?;
    file.write_all(contents.as_bytes()).map_err(super::err_io)?;
    Ok(ConfigFile { path })
}

/// Leftovers from a run that didn't get to clean up (a crash): their
/// secrets are dead, but they needn't sit there.
pub fn sweep() {
    if let Ok(entries) = std::fs::read_dir(config_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("mcp-") && name.ends_with(".json") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/* ------------------------------------------------------- write scope */

/// Folders an agent's file tools may never write, wherever they are: the
/// shared Ship Studio project metadata and git's own store. (The copy-per-task
/// commit is made by the app, not the agent; see `task`.)
pub const PROTECTED_DIRS: [&str; 2] = [".git", ".shipstudio"];

/// Claude Code permission rules denying writes to [`PROTECTED_DIRS`] under
/// the working directory (relative rules) and under each added folder
/// (absolute `//` rules: a relative rule doesn't reach an `--add-dir`).
/// Verified on Claude Code 2.1.318 with a Write into each, including an
/// added folder whose path has a space and a comma.
pub fn claude_deny_rules(add_dirs: &[String]) -> Vec<String> {
    let mut rules: Vec<String> = PROTECTED_DIRS
        .iter()
        .map(|d| format!("Edit(**/{d}/**)"))
        .collect();
    for dir in add_dirs {
        let dir = dir.trim_end_matches('/');
        if dir.is_empty() {
            continue;
        }
        for d in PROTECTED_DIRS {
            rules.push(format!("Edit(/{dir}/**/{d}/**)"));
        }
    }
    rules.extend(claude_bash_deny_rules());
    rules
}

/// Git settings that make a later `git` run (the app's own included) execute
/// a program: hooks from anywhere, a file-system monitor, an SSH command.
const DANGEROUS_GIT_KEYS: [&str; 3] = ["core.hooksPath", "core.fsmonitor", "core.sshCommand"];
const GIT_CONFIG_SCOPES: [&str; 5] = ["", "--local ", "--worktree ", "--global ", "--system "];

/// Shell commands denied outright, on top of the file-tool rules: setting
/// one of [`DANGEROUS_GIT_KEYS`] persistently. Claude Code matches a `Bash`
/// rule as a command prefix (and checks each part of a compound command), and
/// a deny wins over any allow in the user's own settings.
///
/// Residuals, by design of prefix rules: a shell can still write into `.git`
/// another way (`echo … > .git/hooks/pre-commit`, `cp`, an interpreter), and
/// `git config` spelled differently (`git -C x config …`, `git config
/// --file .git/config …`) isn't matched. Those aren't silent: in
/// `acceptEdits` every shell command asks through `approve`, unless the
/// user's settings allow it. This is defence in depth, not a sandbox.
pub fn claude_bash_deny_rules() -> Vec<String> {
    let mut rules = Vec::new();
    for key in DANGEROUS_GIT_KEYS {
        for scope in GIT_CONFIG_SCOPES {
            rules.push(format!("Bash(git config {scope}{key}:*)"));
        }
    }
    rules
}

/// How deep below a writable root [`protected_paths`] looks.
const SCAN_DEPTH: usize = 3;
/// At most this many protected paths are listed.
const SCAN_LIMIT: usize = 400;

/// Existing [`PROTECTED_DIRS`] folders inside `roots`, for Codex's sandbox
/// to keep read-only. Codex accepts a glob only to deny reading, so they are
/// listed by exact path: the roots themselves, projects in them, and copies
/// under `.worktrees/<project>/` (depth 3).
///
/// Re-checked on Codex 0.166 (`codex sandbox -P`): a `"<root>/**/.git" =
/// "read"` entry is refused outright ("filesystem glob path … only supports
/// `deny` access"), and a `deny` would stop git *reading* its own store. The
/// list is fixed when a turn's process starts (a process per turn), so a
/// `.git` created during the turn (`git init`, `git clone`) isn't on it until
/// the next turn, which scans again. Nor is one deeper than [`SCAN_DEPTH`] or
/// beyond [`SCAN_LIMIT`]. Codex older than 0.166 has no profiles and keeps
/// only each root's own top-level `.git` read-only.
pub fn protected_paths(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        scan(root, 0, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn scan(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= SCAN_LIMIT {
        return;
    }
    for name in PROTECTED_DIRS {
        let p = dir.join(name);
        if p.is_dir() {
            out.push(p);
        }
    }
    if depth >= SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Projects, and `.worktrees` (where copies live); never into a
        // dependency tree or another hidden folder.
        let skip = (name.starts_with('.') && name != ".worktrees") || name == "node_modules";
        if !skip {
            scan(&entry.path(), depth + 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bearer_secret_is_read_from_its_header() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer  abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(Some("abc")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn the_urls_carry_no_secret() {
        assert_eq!(agent_url(9), "http://127.0.0.1:9/mcp/agent");
        assert_eq!(import_url(9), "http://127.0.0.1:9/mcp/import");
    }

    #[test]
    fn claudes_config_names_the_secret_only_in_a_header() {
        let config: serde_json::Value =
            serde_json::from_str(&claude_config("http://x/mcp/agent", "s3")).unwrap();
        let server = &config["mcpServers"][SERVER_KEY];
        assert_eq!(server["url"], "http://x/mcp/agent");
        assert_eq!(server["headers"]["Authorization"], "Bearer s3");
    }

    #[cfg(unix)]
    #[test]
    fn a_config_file_is_private_and_goes_when_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bridge");
        let file = write_config_in(&dir, "{}").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(file.path()), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "{}");
        let path = file.path().to_path_buf();
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn claude_is_denied_writes_under_its_cwd_and_every_added_folder() {
        let rules = claude_deny_rules(&["/u/Ship Studio".into(), "/ext/site/".into()]);
        let edit_rules: Vec<_> = rules.iter().filter(|r| r.starts_with("Edit(")).collect();
        assert_eq!(
            edit_rules,
            vec![
                "Edit(**/.git/**)",
                "Edit(**/.shipstudio/**)",
                "Edit(//u/Ship Studio/**/.git/**)",
                "Edit(//u/Ship Studio/**/.shipstudio/**)",
                "Edit(//ext/site/**/.git/**)",
                "Edit(//ext/site/**/.shipstudio/**)",
            ]
        );
    }

    #[test]
    fn claude_is_denied_persisting_git_settings_that_run_programs() {
        let rules = claude_deny_rules(&[]);
        for rule in [
            "Bash(git config core.hooksPath:*)",
            "Bash(git config --local core.hooksPath:*)",
            "Bash(git config --global core.fsmonitor:*)",
            "Bash(git config core.sshCommand:*)",
        ] {
            assert!(rules.iter().any(|r| r == rule), "{rule}");
        }
        assert_eq!(claude_bash_deny_rules().len(), 15);
    }

    #[test]
    fn protected_folders_are_found_in_roots_projects_and_copies() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for dir in [
            ".shipstudio",
            "site/.git",
            "site/.shipstudio",
            "site/node_modules/pkg/.git",
            "site/src",
            ".worktrees/site/a1-t1/.shipstudio",
            ".hidden/x/.git",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        // A copy's `.git` is a file pointing into the project's: not listed.
        std::fs::write(root.join(".worktrees/site/a1-t1/.git"), "gitdir: x").unwrap();
        let found = protected_paths(&[root.to_path_buf()]);
        let rel: Vec<String> = found
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            rel,
            vec![
                ".shipstudio",
                ".worktrees/site/a1-t1/.shipstudio",
                "site/.git",
                "site/.shipstudio",
            ]
        );
    }
}
