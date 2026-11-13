//! Which approval cards the user's independence level answers for them.
//!
//! An app-owned classifier, run by `mcp::decide` for every call an engine
//! asks about (Claude Code's permission prompt tool and Codex's approval
//! requests alike), after a one-time grant and an "Always allow" rule and
//! before a card. It sorts a call into one of three classes:
//!
//! - [`Class::Read`]: only reads, anywhere the user's own account can read,
//!   except credentials and private stores (Keychains, `~/.ssh`, `~/.gnupg`,
//!   browser profiles, the app's own data, `.env` and key files…).
//! - [`Class::Change`]: local work. Creating, editing, moving, copying or
//!   unpacking files inside the user's home (never a shell profile, a launch
//!   agent, a credential store, the app's data, or a `.git` / `.shipstudio`
//!   folder); deleting only inside the agent's own home or its copy of a
//!   project; running the project's own build and test tools, and local
//!   scripts whose code shows nothing that sends, deletes or spawns.
//! - [`Class::Ask`]: everything else, and always: sending, posting,
//!   publishing or pushing; network transfers of any kind; payments and
//!   connector tools; deleting the user's files; `sudo`; installing
//!   software; changing ownership, a shell profile or launch agents;
//!   anything touching credentials. Anything this file doesn't recognise.
//!
//! **When in doubt, a card.** The classifier is an allow-list: a program, a
//! subcommand, a flag or a path it can't vouch for asks. A command line is
//! split into every command it runs (`&&`, `||`, `;`, `|`, `&`, line breaks,
//! `$(…)` and backticks) and takes the class of its most dangerous part.
//! Variables other than `$HOME`, here-documents, subshells and anything it
//! can't parse ask.
//!
//! **Levels** ([`allows`]): "Check with me often" answers nothing; "Use good
//! judgement" answers reads (at most that for a turn answering outside text,
//! `independence::for_turn`). "Go hard" doesn't use this classifier at all:
//! it allows by default and asks only for its short list (`go_hard`).
//!
//! **Hardening at "Go hard"** (on top of `go_hard`'s list): no network
//! request goes through on its own with a secret in its address, query or
//! headers (`egress`); in a turn that read outside content (`exposure`),
//! network writes to another host and packages new to the project ask
//! ([`after_outside_asks`], `installs`).

use serde_json::Value;
use std::path::{Component, Path, PathBuf};

use super::egress;
use super::independence::{self, Level};
use super::installs::{self, Eco};
use super::paths::{self, name_is, same, under, Anchor};

/// What a call does, from harmless to "ask".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    Read,
    Change,
    Ask,
}

/// Whether `level` answers a call of `class` without a card.
pub fn allows(level: Level, class: Class) -> bool {
    match (level, class) {
        (_, Class::Ask) | (Level::Often, _) => false,
        (Level::Judgement, Class::Read) => true,
        (Level::Judgement, Class::Change) => false,
        (Level::GoHard | Level::FullSend, _) => true,
    }
}

/// The class a call is answered as, when the user's `chosen` level answers
/// it: `None` means a card. `outside`: the turn answers outside text.
pub fn auto(chosen: Level, outside: bool, tool: &str, input: &Value, ctx: &Ctx) -> Option<Class> {
    // "Go hard" is allow-by-default with a short list that asks
    // (`go_hard`), outside text or not: reading a page is the job. "Full
    // send" asks only the floor of that list, and never for outside text:
    // a turn answering it runs at "Go hard"'s rules.
    if chosen.goes_hard() {
        let full = chosen == Level::FullSend && !outside;
        let asks = if full != ctx.full_send {
            let mut c = ctx.clone();
            c.full_send = full;
            super::go_hard::asks(tool, input, &c, outside)
        } else {
            super::go_hard::asks(tool, input, ctx, outside)
        };
        if asks {
            return None;
        }
        return Some(match classify(tool, input, ctx) {
            Class::Read => Class::Read,
            _ => Class::Change,
        });
    }
    let level = independence::for_turn(chosen, outside);
    if level == Level::Often {
        return None;
    }
    let class = classify(tool, input, ctx);
    allows(level, class).then_some(class)
}

/// Where the agent is, for resolving what a call touches.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    /// The user's home.
    pub home: PathBuf,
    /// The agent's own home (inside the app's data, but its own).
    pub own_home: PathBuf,
    /// The turn's working directory.
    pub cwd: PathBuf,
    /// Where deleting is local work: its own home, its copy of a project.
    pub scratch: Vec<PathBuf>,
    /// The app's own data (every agent's home, bridge config, tokens).
    pub app_data: Vec<PathBuf>,
    /// Secret values that must never leave in an address (`egress::known`).
    pub secrets: Vec<String>,
    /// Packages the user already allowed for this project on a card
    /// (`installs::remembered`), as `npm:zod`.
    pub packages: Vec<String>,
    /// An admin (`admin`): the Chief and the agents the user made admins.
    /// At "Go hard" and "Full send" every agent reads the team's homes
    /// without a card (`go_hard::team_file`), so this no longer decides that.
    pub team_reader: bool,
    /// The turn runs at "Full send" (never for outside text): `go_hard`
    /// asks only its floor. Set by [`auto`], never by `for_agent`.
    pub full_send: bool,
}

impl Ctx {
    /// The context of a turn of `agent`, as `runner` lays it out.
    pub fn for_agent(agent: &super::store::Agent) -> Option<Ctx> {
        let home = dirs::home_dir()?;
        let own_home = super::store::agent_home(&agent.id).ok()?;
        let layout = super::project::layout(agent, &own_home, Vec::new());
        let mut scratch = vec![own_home.clone()];
        if let Some(copy) = &layout.copy {
            scratch.push(PathBuf::from(&copy.path));
        }
        let mut app_data = vec![crate::brand::app_support_dir()];
        if let Ok(root) = super::store::agents_root() {
            app_data.push(root);
        }
        let key = super::installs::key_for(layout.project.as_deref(), &own_home);
        Some(Ctx {
            home,
            own_home,
            cwd: layout.cwd,
            scratch,
            app_data,
            secrets: super::egress::known(),
            packages: super::installs::remembered(&key),
            team_reader: super::admin::is_admin(agent),
            full_send: false,
        })
    }

    /// Folders whose contents are credentials or private stores: never read
    /// or written without a card.
    fn secret_dirs(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = SECRET_DIRS.iter().map(|d| self.home.join(d)).collect();
        dirs.push(self.home.join(format!(".{}", crate::brand::SLUG)));
        dirs.extend(self.app_data.iter().cloned());
        dirs
    }

    fn is_secret(&self, p: &Path) -> bool {
        if under(p, &self.own_home) {
            return false;
        }
        self.secret_dirs().iter().any(|d| under(p, d))
            || SYSTEM_SECRETS.iter().any(|s| under(p, Path::new(s)))
            || sensitive_name(p)
    }

    /// A folder that holds a secret somewhere below it: reading its contents
    /// recursively would read the secret.
    fn holds_secret(&self, p: &Path) -> bool {
        if under(p, &self.own_home) {
            return false;
        }
        self.secret_dirs()
            .iter()
            .chain(self.write_protected().iter())
            .any(|d| under(d, p) && !same(d, p))
    }

    /// Writes that change how the Mac or the shell behaves.
    fn write_protected(&self) -> Vec<PathBuf> {
        PROFILE_PATHS.iter().map(|d| self.home.join(d)).collect()
    }

    fn readable(&self, p: &Path) -> bool {
        both(p, |p| !self.is_secret(p))
    }

    fn readable_tree(&self, p: &Path) -> bool {
        both(p, |p| !self.is_secret(p) && !self.holds_secret(p))
    }

    /// The app's own files in the agent's home: its log, its instructions.
    fn bookkeeping(&self, p: &Path) -> bool {
        p.parent().is_some_and(|d| same(d, &self.own_home))
            && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                let n = n.to_lowercase();
                n.ends_with(".jsonl")
                    || n.ends_with(".json")
                    || n.starts_with('.')
                    || matches!(n.as_str(), "claude.md" | "agents.md")
            })
    }

    fn writable(&self, p: &Path) -> bool {
        nowhere(p)
            || both(p, in_temp)
            || both(p, |p| {
                under(p, &self.home)
                    && !self.bookkeeping(p)
                    && !self.is_secret(p)
                    && !self.write_protected().iter().any(|d| under(p, d))
                    && !p.components().any(|c| {
                        matches!(c, Component::Normal(n) if PROTECTED_FOLDERS.iter().any(|f| name_is(n, f)))
                    })
            })
    }

    /// Deleting without a card is only for folders the project's tools
    /// rebuild (`REGENERABLE`), inside the agent's own home or its copy of a
    /// project. Every other delete asks, even there.
    fn deletable(&self, p: &Path) -> bool {
        if nowhere(p) || both(p, in_temp) {
            return true;
        }
        self.writable(p)
            && both(p, |p| {
                self.scratch.iter().any(|s| {
                    under(p, s)
                        && p.components().skip(s.components().count()).any(|c| {
                            matches!(c, Component::Normal(n)
                                if REGENERABLE.iter().any(|r| name_is(n, r)))
                        })
                })
            })
    }
}

/// A path on a top-level folder this Mac doesn't have (`/workspace/…`, the
/// Grok sandbox an imported agent remembers) where this account can't make
/// one: whatever a command does there fails at once and changes nothing, and
/// the agent learns from the error and its "Where you are now" section.
fn nowhere(p: &Path) -> bool {
    let mut parts = p.components();
    if parts.next() != Some(Component::RootDir) {
        return false;
    }
    let Some(Component::Normal(top)) = parts.next() else {
        return false;
    };
    if std::fs::symlink_metadata(Path::new("/").join(top)).is_ok() {
        return false;
    }
    // The tests' fictional Mac (`/Users/…`, `/Applications/…`) on a computer
    // that has neither (a Linux runner): those folders exist on the Mac the
    // tests describe, so they're never "nowhere" there.
    #[cfg(test)]
    if matches!(top.to_str(), Some("Users" | "Applications")) {
        return false;
    }
    !root_writable()
}

/// Whether this account can make folders at `/` (only root can on macOS).
fn root_writable() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: a NUL-terminated literal that `access` only reads.
        unsafe { libc::access(c"/".as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Folders no write goes into without a card, wherever they are: git's own
/// (its hooks run on every commit) and the project's metadata.
const PROTECTED_FOLDERS: &[&str] = &[".git", ".shipstudio"];

/// Build output and caches the project's own tools make again.
const REGENERABLE: &[&str] = &["node_modules", "dist", "build", ".next", "target", ".cache"];

/// `check` holds for the path as written and for where it really is (a
/// symlink inside the home pointing outside it doesn't pass).
fn both(p: &Path, check: impl Fn(&Path) -> bool) -> bool {
    check(p) && check(&real(p))
}

/// The path with its longest existing ancestor resolved.
fn real(p: &Path) -> PathBuf {
    let mut base = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(canon) = std::fs::canonicalize(&base) {
            let mut out = paths::plain(canon);
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (base.file_name().map(|n| n.to_os_string()), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// Inside the home: credentials, keys, browser profiles, mail and messages.
const SECRET_DIRS: &[&str] = &[
    "Library/Keychains",
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".config/gh",
    ".docker",
    ".kube",
    ".codex",
    ".claude",
    ".claude.json",
    ".password-store",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "Library/Cookies",
    "Library/Safari",
    "Library/Mail",
    "Library/Messages",
    "Library/Containers/com.apple.Safari",
    "Library/Group Containers",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
    "Library/Application Support/Vivaldi",
    "Library/Application Support/com.operasoftware.Opera",
    "Library/Application Support/com.apple.TCC",
    "Library/Application Support/1Password",
    // Shell profiles: where people keep exported tokens.
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".config/fish",
    // Windows: Credential Manager and DPAPI keys, browser profiles, CLI
    // logins, PowerShell profiles.
    "AppData/Roaming/Microsoft/Credentials",
    "AppData/Local/Microsoft/Credentials",
    "AppData/Roaming/Microsoft/Protect",
    "AppData/Roaming/Microsoft/Vault",
    "AppData/Local/Microsoft/Vault",
    "AppData/Local/Google/Chrome",
    "AppData/Local/Microsoft/Edge",
    "AppData/Local/BraveSoftware",
    "AppData/Local/Vivaldi",
    "AppData/Roaming/Opera Software",
    "AppData/Roaming/Mozilla",
    "AppData/Local/1Password",
    "AppData/Roaming/1Password",
    "AppData/Roaming/GitHub CLI",
    "AppData/Roaming/gcloud",
    "AppData/Roaming/npm-cache/_cacache/index-v5",
    "Documents/PowerShell",
    "Documents/WindowsPowerShell",
];

/// Outside the home, the few readable files that are still secrets.
const SYSTEM_SECRETS: &[&str] = &[
    "/etc/sudoers",
    "/private/etc/sudoers",
    "/etc/master.passwd",
    "/private/etc/master.passwd",
    "/Library/Keychains",
    // Windows' registry hives (SAM, SECURITY) and its own credential store.
    "C:/Windows/System32/config",
    "C:/ProgramData/Microsoft/Crypto",
];

/// Shell profiles, launch agents, preferences and PATH folders: writing
/// these changes what runs next, so they always ask.
const PROFILE_PATHS: &[&str] = &[
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".zlogout",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
    ".inputrc",
    ".gitconfig",
    ".config/git",
    ".config/fish",
    ".oh-my-zsh",
    ".local/bin",
    "bin",
    "Library/LaunchAgents",
    "Library/LaunchDaemons",
    "Library/Preferences",
    "Library/Services",
    "Library/Scripts",
    // Windows: what runs at sign-in, and every PowerShell session.
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
    "Documents/PowerShell",
    "Documents/WindowsPowerShell",
];

/// A file whose name says it holds a secret.
pub(super) fn sensitive_name(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    let env = lower == ".env"
        || (lower.starts_with(".env.")
            && !matches!(
                lower.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            ));
    env || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
        .iter()
        .any(|k| lower.starts_with(k))
        || [
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".keychain",
            ".keychain-db",
            ".kdbx",
            ".ovpn",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
        || lower.contains("credential")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("token")
}

// ============================================================================
// Tool calls
// ============================================================================

/// Claude Code's claude.ai artifact tools (`claude::ENV`): whether this call
/// only reads (a page, a listing, a database row), as the user's own
/// claude.ai account can. `None` for any other tool. Publishing, deleting,
/// commenting, writing rows and anything unrecognised are not reads.
pub fn artifact_read(tool: &str, input: &Value) -> Option<bool> {
    let action = input.get("action").and_then(Value::as_str).unwrap_or("");
    match tool {
        "Artifact" => Some(matches!(action, "read" | "list")),
        "ArtifactData" => Some(matches!(action, "get" | "list" | "query")),
        "ArtifactComments" => Some(matches!(action, "read" | "list")),
        _ => None,
    }
}

/// The class of one call an engine asked about.
pub fn classify(tool: &str, input: &Value, ctx: &Ctx) -> Class {
    let field = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim();
    let path = |k: &str| {
        let raw = field(k);
        (!raw.is_empty())
            .then(|| resolve_plain(raw, &ctx.cwd, &ctx.home))
            .flatten()
    };
    let read = |p: Option<PathBuf>, tree: bool| match p {
        Some(p) if (tree && ctx.readable_tree(&p)) || (!tree && ctx.readable(&p)) => Class::Read,
        _ => Class::Ask,
    };
    match tool {
        "Bash" => classify_command(field("command"), ctx),
        "Read" => read(path("file_path"), false),
        "Glob" | "Grep" | "LS" => {
            let p = if field("path").is_empty() {
                Some(ctx.cwd.clone())
            } else {
                path("path")
            };
            read(p, tool != "LS")
        }
        "Write" | "Edit" | "MultiEdit" => match path("file_path") {
            Some(p) if ctx.writable(&p) => Class::Change,
            _ => Class::Ask,
        },
        "NotebookEdit" => match path("notebook_path") {
            Some(p) if ctx.writable(&p) => Class::Change,
            _ => Class::Ask,
        },
        // Searching the web and fetching a page are reads (Claude Code's
        // tools, and Codex's own web search). A turn reading outside text
        // keeps its outside-text cap (`independence::for_turn`).
        // Never when the address or the query carries a secret (`egress`).
        "WebFetch" if egress::carries_secret(field("url"), &ctx.secrets) => Class::Ask,
        "WebSearch" | "web_search" if egress::holds_secret(field("query"), &ctx.secrets) => {
            Class::Ask
        }
        "WebSearch" | "WebFetch" | "web_search" => Class::Read,
        // Reading a claude.ai artifact is reading a page; publishing one asks.
        t if artifact_read(t, input) == Some(true) => Class::Read,
        // Connectors, payments, anything else.
        _ => Class::Ask,
    }
}

/// `~/x`, `/abs` or `rel` (against `cwd`), normalised; `None` when it can't
/// be known (`~other`, climbing above `/`).
fn resolve_plain(raw: &str, cwd: &Path, home: &Path) -> Option<PathBuf> {
    let joined = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = paths::home_rest(raw) {
        home.join(rest)
    } else if raw.starts_with('~') {
        return None;
    } else {
        match paths::anchor(raw) {
            Anchor::Absolute(p) => p,
            Anchor::Relative => cwd.join(raw),
            Anchor::Unknown => return None,
        }
    };
    normalise(&joined)
}

/// `.` and `..` taken out; `None` unless the result is absolute. On Windows
/// only a drive path (`C:\…`) is: a rooted path with no drive, a share or a
/// device path can't be placed (`paths`).
fn normalise(p: &Path) -> Option<PathBuf> {
    let p = paths::plain(p.to_path_buf());
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR_STR),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() || out.as_os_str().is_empty() {
                    return None;
                }
            }
            Component::Normal(n) => out.push(n),
            Component::Prefix(pre) => match pre.kind() {
                std::path::Prefix::Disk(_) if out.as_os_str().is_empty() => out.push(c.as_os_str()),
                _ => return None,
            },
        }
    }
    out.is_absolute().then_some(out)
}

// ============================================================================
// Shell: words
// ============================================================================

#[derive(Debug, Clone, Default)]
struct Word {
    text: String,
    /// An unquoted `*`, `?`, `[` or `{`: it stands for other names.
    glob: bool,
    /// Part of it is only known when it runs (`$VAR`, `$(…)`).
    dynamic: bool,
    /// Starts with an unquoted `~`.
    tilde: bool,
}

#[derive(Debug)]
enum Tok {
    Word(Word),
    /// `&&`, `||`, `;`, `|`, `&`, a line break.
    Sep,
    /// `>`, `>>`, `&>`: the next word is written.
    Out,
    /// `<`: the next word is read.
    In,
    /// `<<<`: the next word is text.
    Text,
}

struct Lexed {
    toks: Vec<Tok>,
    /// What `$(…)` and backticks run, classified as commands of their own.
    subs: Vec<String>,
}

/// Split a command line into words and separators. `None` for anything this
/// doesn't follow: an unclosed quote, a here-document, a subshell, process
/// substitution, `$'…'`.
fn lex(src: &str, home: &str) -> Option<Lexed> {
    let chars: Vec<char> = src.chars().collect();
    let mut toks = Vec::new();
    let mut subs = Vec::new();
    let mut word: Option<Word> = None;
    let mut i = 0;
    macro_rules! end_word {
        () => {
            if let Some(w) = word.take() {
                toks.push(Tok::Word(w));
            }
        };
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => {
                end_word!();
                i += 1;
            }
            '\n' | ';' => {
                end_word!();
                toks.push(Tok::Sep);
                i += 1;
            }
            '&' | '|' => {
                // `2>&1`, `>&2`: a descriptor, not a separator.
                end_word!();
                if c == '&' && chars.get(i + 1) == Some(&'>') {
                    toks.push(Tok::Out);
                    i += 2;
                    if chars.get(i) == Some(&'>') {
                        i += 1;
                    }
                    continue;
                }
                toks.push(Tok::Sep);
                i += 1;
                if chars.get(i) == Some(&c) || (c == '|' && chars.get(i) == Some(&'&')) {
                    i += 1;
                }
            }
            '>' | '<' => {
                // A descriptor number just before (`2>`) belongs to this.
                if let Some(w) = &word {
                    if w.text.chars().all(|d| d.is_ascii_digit()) && !w.dynamic && !w.glob {
                        word = None;
                    }
                }
                end_word!();
                if c == '<' {
                    match (chars.get(i + 1), chars.get(i + 2)) {
                        (Some('<'), Some('<')) => {
                            toks.push(Tok::Text);
                            i += 3;
                        }
                        (Some('<'), _) | (Some('('), _) | (Some('>'), _) => return None,
                        (Some('&'), _) => {
                            i += 2;
                            skip_descriptor(&chars, &mut i)?;
                        }
                        _ => {
                            toks.push(Tok::In);
                            i += 1;
                        }
                    }
                } else {
                    i += 1;
                    match chars.get(i) {
                        Some('(') => return None,
                        Some('&') => {
                            i += 1;
                            skip_descriptor(&chars, &mut i)?;
                            continue;
                        }
                        Some('>') | Some('|') => i += 1,
                        _ => {}
                    }
                    toks.push(Tok::Out);
                }
            }
            '(' | ')' => return None,
            '#' if word.is_none() => {
                // A comment, to the end of the line.
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            _ => {
                let w = word.get_or_insert_with(Word::default);
                i = lex_word_part(&chars, i, w, &mut subs, home)?;
            }
        }
    }
    end_word!();
    Some(Lexed { toks, subs })
}

/// `&1`, `&2`, `&-`: the descriptor after `>&` / `<&`.
fn skip_descriptor(chars: &[char], i: &mut usize) -> Option<()> {
    let start = *i;
    while chars
        .get(*i)
        .is_some_and(|c| c.is_ascii_digit() || *c == '-')
    {
        *i += 1;
    }
    (*i > start).then_some(())
}

/// One piece of a word starting at `i`: a quoted run, an expansion, or one
/// plain character. Returns where the next piece starts.
fn lex_word_part(
    chars: &[char],
    mut i: usize,
    w: &mut Word,
    subs: &mut Vec<String>,
    home: &str,
) -> Option<usize> {
    let c = chars[i];
    match c {
        '\'' => {
            let end = chars[i + 1..].iter().position(|&c| c == '\'')? + i + 1;
            w.text.extend(&chars[i + 1..end]);
            Some(end + 1)
        }
        '"' => {
            i += 1;
            loop {
                match chars.get(i)? {
                    '"' => return Some(i + 1),
                    '\\' => {
                        let next = *chars.get(i + 1)?;
                        if !matches!(next, '$' | '`' | '"' | '\\' | '\n') {
                            w.text.push('\\');
                        }
                        w.text.push(next);
                        i += 2;
                    }
                    '$' | '`' => i = lex_expansion(chars, i, w, subs, home)?,
                    &other => {
                        w.text.push(other);
                        i += 1;
                    }
                }
            }
        }
        '\\' => {
            let next = *chars.get(i + 1)?;
            if next == '\n' {
                return None;
            }
            w.text.push(next);
            Some(i + 2)
        }
        '$' | '`' => lex_expansion(chars, i, w, subs, home),
        '~' if w.text.is_empty() && !w.dynamic => {
            w.tilde = true;
            w.text.push('~');
            Some(i + 1)
        }
        '*' | '?' | '[' | ']' | '{' | '}' => {
            w.glob = true;
            w.text.push(c);
            Some(i + 1)
        }
        _ => {
            w.text.push(c);
            Some(i + 1)
        }
    }
}

/// `$HOME`, `${HOME}`, `$(…)`, `` `…` `` or any other `$`: only `$HOME` is
/// known; command substitutions are classified on their own.
fn lex_expansion(
    chars: &[char],
    i: usize,
    w: &mut Word,
    subs: &mut Vec<String>,
    home: &str,
) -> Option<usize> {
    if chars[i] == '`' {
        let end = chars[i + 1..].iter().position(|&c| c == '`')? + i + 1;
        let inner: String = chars[i + 1..end].iter().collect();
        if inner.contains('\\') {
            return None;
        }
        subs.push(inner);
        w.dynamic = true;
        return Some(end + 1);
    }
    match chars.get(i + 1) {
        Some('(') => {
            if chars.get(i + 2) == Some(&'(') {
                return None;
            }
            let end = closing_paren(chars, i + 1)?;
            subs.push(chars[i + 2..end].iter().collect());
            w.dynamic = true;
            Some(end + 1)
        }
        Some('\'') => None,
        Some('{') => {
            let end = chars[i + 2..].iter().position(|&c| c == '}')? + i + 2;
            let name: String = chars[i + 2..end].iter().collect();
            if let Some(tmp) = (name == "TMPDIR").then(known_tmpdir).flatten() {
                w.text.push_str(&tmp);
            } else if name == "HOME" {
                w.text.push_str(home);
            } else {
                w.dynamic = true;
            }
            Some(end + 1)
        }
        _ => {
            let mut end = i + 1;
            while chars
                .get(end)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
            {
                end += 1;
            }
            if end == i + 1 {
                // `$?`, `$1`, `$$`, a bare `$`.
                w.dynamic = true;
                return Some((i + 2).min(chars.len()));
            }
            let name: String = chars[i + 1..end].iter().collect();
            if let Some(tmp) = (name == "TMPDIR").then(known_tmpdir).flatten() {
                w.text.push_str(&tmp);
            } else if name == "HOME" {
                w.text.push_str(home);
            } else {
                w.dynamic = true;
            }
            Some(end)
        }
    }
}

/// The `)` closing the `(` at `open`, skipping quoted text.
fn closing_paren(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            '\'' => i += chars[i + 1..].iter().position(|&c| c == '\'')? + 1,
            '"' => i += chars[i + 1..].iter().position(|&c| c == '"')? + 1,
            '\\' => i += 1,
            _ => {}
        }
        i += 1;
    }
    None
}

// ============================================================================
// Shell: commands
// ============================================================================

/// How deep `bash -c`, scripts and substitutions may nest before it asks.
const MAX_DEPTH: u8 = 4;

/// The class of a whole command line: its most dangerous part.
pub fn classify_command(command: &str, ctx: &Ctx) -> Class {
    let mut eval = Eval::new(ctx);
    eval.line(command);
    eval.worst
}

/// The packages `command` installs or runs that aren't the project's yet
/// (`installs`), as `npm:zod`: what an Allow on its card remembers.
pub fn new_packages(command: &str, ctx: &Ctx) -> Vec<String> {
    let mut eval = Eval::new(ctx);
    eval.line(command);
    eval.unknown
}

struct Eval<'a> {
    ctx: &'a Ctx,
    /// The working directory as the line runs (`cd`), `None` once unknown.
    cwd: Option<PathBuf>,
    worst: Class,
    depth: u8,
    /// Packages it would fetch that the project doesn't have yet.
    unknown: Vec<String>,
}

/// What a command does with one of its words.
#[derive(Clone, Copy, PartialEq)]
enum Use {
    /// Lists or describes it.
    Names,
    /// Reads what's in it.
    Content,
    /// Reads everything under it.
    Tree,
    Write,
    Delete,
}

impl<'a> Eval<'a> {
    fn new(ctx: &'a Ctx) -> Eval<'a> {
        Eval {
            ctx,
            cwd: Some(ctx.cwd.clone()),
            worst: Class::Read,
            depth: 0,
            unknown: Vec::new(),
        }
    }

    fn bump(&mut self, class: Class) {
        self.worst = self.worst.max(class);
    }

    fn ask(&mut self) {
        self.bump(Class::Ask);
    }

    /// An address (absolute, or a path with a query) that would carry a
    /// secret off this Mac (`egress`).
    fn leaks(&self, t: &str) -> bool {
        let secrets = &self.ctx.secrets;
        egress::carries_secret(t, secrets)
            || (!web_url(t) && egress::carries_secret(&format!("https://x.invalid/{t}"), secrets))
    }

    /// `gh api`: the endpoint, its headers and the fields a GET sends as a
    /// query, checked for secrets.
    fn gh_api_leaks(&self, rest: &[&str]) -> bool {
        let mut it = rest.iter().copied();
        while let Some(t) = it.next() {
            let (flag, inline) = match t.split_once('=') {
                Some((f, v)) if t.starts_with("--") => (f, Some(v)),
                _ => (t, None),
            };
            match flag {
                "-H" | "--header" => {
                    let v = inline.or_else(|| it.next()).unwrap_or("");
                    if egress::header_carries_secret(v, &self.ctx.secrets) {
                        return true;
                    }
                }
                "-f" | "-F" | "--field" | "--raw-field" => {
                    let v = inline.or_else(|| it.next()).unwrap_or("");
                    let (name, value) = v.split_once('=').unwrap_or((v, ""));
                    if (egress::secret_name(name) && !value.is_empty())
                        || egress::holds_secret(value, &self.ctx.secrets)
                    {
                        return true;
                    }
                }
                f if f.starts_with('-') => {}
                endpoint => {
                    if self.leaks(endpoint) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn line(&mut self, command: &str) {
        if self.depth > MAX_DEPTH {
            return self.ask();
        }
        let command = command.trim();
        // Codex's unwrapped `'…'\''…'` quoting, or anything else this lexer
        // would read differently from the shell.
        if command.contains("'\\''") {
            return self.ask();
        }
        let home = self.ctx.home.to_string_lossy().to_string();
        let Some(lexed) = lex(command, &home) else {
            return self.ask();
        };
        for sub in &lexed.subs {
            self.depth += 1;
            let saved = self.cwd.clone();
            self.line(sub);
            self.cwd = saved;
            self.depth -= 1;
        }
        let mut words: Vec<Word> = Vec::new();
        let mut redirects: Vec<(Use, Word)> = Vec::new();
        let mut toks = lexed.toks.into_iter().peekable();
        while let Some(tok) = toks.next() {
            match tok {
                Tok::Word(w) => words.push(w),
                Tok::Sep => {
                    self.simple(std::mem::take(&mut words), std::mem::take(&mut redirects));
                }
                Tok::Out | Tok::In | Tok::Text => match toks.next() {
                    Some(Tok::Word(target)) => {
                        let how = match tok {
                            Tok::Out => Use::Write,
                            Tok::In => Use::Content,
                            _ => continue,
                        };
                        redirects.push((how, target));
                    }
                    _ => return self.ask(),
                },
            }
        }
        self.simple(words, redirects);
    }

    fn path(&self, w: &Word) -> Option<PathBuf> {
        if w.dynamic || w.text.is_empty() {
            return None;
        }
        if w.text.starts_with('~') && !w.tilde {
            // A quoted `~` is a folder named "~".
            return normalise(&self.cwd.as_ref()?.join(&w.text));
        }
        if w.text.starts_with('~') {
            return resolve_plain(&w.text, Path::new("/"), &self.ctx.home);
        }
        match paths::anchor(&w.text) {
            Anchor::Absolute(p) => normalise(&p),
            Anchor::Relative => normalise(&self.cwd.as_ref()?.join(&w.text)),
            Anchor::Unknown => None,
        }
    }

    /// Account for `how` on `w`.
    fn touch(&mut self, w: &Word, how: Use) {
        if matches!(w.text.as_str(), "/dev/null" | "/dev/stdout" | "/dev/stderr")
            && !w.dynamic
            && !w.glob
        {
            return;
        }
        if w.dynamic {
            return self.ask();
        }
        let ctx = self.ctx;
        let (target, how) = if w.glob {
            // A pattern stands for anything under the folder it starts in.
            let first = w.text.find(['*', '?', '[', ']', '{', '}']).unwrap_or(0);
            let prefix = &w.text[..first];
            let last = prefix.rfind('/').map(|i| &prefix[..=i]).unwrap_or("");
            let rest = &w.text[last.len()..];
            if rest.starts_with('.') || (rest.contains('/') && how != Use::Names) {
                return self.ask();
            }
            let base = Word {
                text: if last.is_empty() {
                    ".".into()
                } else {
                    last.into()
                },
                tilde: w.tilde,
                ..Word::default()
            };
            let how = match how {
                Use::Content => Use::Tree,
                other => other,
            };
            (self.path(&base), how)
        } else {
            (self.path(w), how)
        };
        let Some(p) = target else {
            return self.ask();
        };
        let ok = match how {
            Use::Names => ctx.readable(&p),
            Use::Content => ctx.readable(&p),
            Use::Tree => ctx.readable_tree(&p),
            Use::Write => {
                ctx.writable(&p) && (!w.glob || !ctx.write_protected().iter().any(|d| under(d, &p)))
            }
            Use::Delete => ctx.deletable(&p),
        };
        match (ok, how) {
            (false, _) => self.ask(),
            (true, Use::Write | Use::Delete) => self.bump(Class::Change),
            (true, _) => self.bump(Class::Read),
        }
    }

    fn touch_all(&mut self, words: &[&Word], how: Use) {
        for w in words {
            self.touch(w, how);
        }
    }

    /// The working directory, read the way `how` says (a command with no
    /// path operates on it).
    fn touch_cwd(&mut self, how: Use) {
        self.touch(
            &Word {
                text: ".".into(),
                ..Word::default()
            },
            how,
        );
    }

    /// One command: its assignments, program and arguments, and redirects.
    fn simple(&mut self, mut words: Vec<Word>, redirects: Vec<(Use, Word)>) {
        for (how, target) in &redirects {
            self.touch(target, *how);
        }
        // Loop and branch words: the commands inside are judged on their own
        // (`for n in 1 2; do gh pr view $n; done`, `if test -f x; then …; fi`).
        while words.first().is_some_and(|w| {
            !w.dynamic
                && !w.glob
                && matches!(
                    w.text.as_str(),
                    "do" | "then" | "else" | "if" | "elif" | "while" | "until" | "!"
                )
        }) {
            words.remove(0);
        }
        if let [w] = words.as_slice() {
            if !w.dynamic && matches!(w.text.as_str(), "done" | "fi") {
                return;
            }
        }
        if words.first().is_some_and(|w| w.text == "for" && !w.dynamic) {
            // `for NAME in WORDS`: names a variable; `$(…)` in the list is
            // judged as a command of its own.
            let named = words.get(1).is_some_and(|w| {
                !w.dynamic
                    && !w.glob
                    && is_assignment(&Word {
                        text: format!("{}=", w.text),
                        ..Word::default()
                    })
                    && shell_variable(&w.text)
            });
            if !named || words.get(2).is_none_or(|w| w.text != "in" || w.dynamic) {
                return self.ask();
            }
            return self.bump(Class::Read);
        }
        // A line of only `NAME=value` sets shell variables for the lines
        // after it: fine unless the name changes how programs run.
        if !words.is_empty() && words.iter().all(is_assignment) {
            for w in &words {
                let name = w.text.split('=').next().unwrap_or("");
                if !shell_variable(name) {
                    return self.ask();
                }
            }
            return self.bump(Class::Read);
        }
        // Leading `NAME=value` assignments: only harmless names.
        while words.first().is_some_and(is_assignment) {
            let w = words.remove(0);
            let name = w.text.split('=').next().unwrap_or("");
            if !SAFE_ENV.contains(&name) {
                return self.ask();
            }
        }
        let Some(first) = words.first() else {
            return;
        };
        if first.dynamic || first.glob {
            return self.ask();
        }
        let program = first.text.clone();
        let args: Vec<&Word> = words.iter().skip(1).collect();
        let name = program_name(&program);
        let Some(name) = name else {
            // `./build.sh`, `~/bin/tool`: a script file of its own.
            return self.script(first, &args);
        };
        self.program(name, &args);
    }

    fn program(&mut self, name: &str, args: &[&Word]) {
        let texts: Vec<&str> = args.iter().map(|w| w.text.as_str()).collect();
        let (flags, positional) = split_args(args);
        // `set -euo pipefail` at the top of a script.
        if name == "set"
            && !texts.is_empty()
            && texts.iter().all(|t| {
                *t == "pipefail"
                    || (t.starts_with('-') && t[1..].chars().all(|c| "euxo".contains(c)))
            })
        {
            return self.bump(Class::Read);
        }
        if ALWAYS_ASK.contains(&name) {
            return self.ask();
        }
        // `node --version`, `git --help`: a toolchain saying what it is.
        if TOOLCHAINS.contains(&name)
            && texts.len() == 1
            && matches!(
                texts[0],
                "--version" | "-v" | "-V" | "version" | "--help" | "-h"
            )
        {
            return self.bump(Class::Read);
        }
        match name {
            // Say things; touch nothing.
            "echo" | "printf" | "true" | "false" | ":" | "pwd" | "whoami" | "id" | "groups"
            | "uname" | "sw_vers" | "uptime" | "sleep" | "seq" | "basename" | "dirname"
            | "test" | "[" | "ps" | "pgrep" | "vm_stat" | "nproc" | "arch" | "tty" | "locale"
            | "cal" | "expr" | "ioreg" | "system_profiler" | "lsof" | "df" | "tput" | "clear"
            | "jobs" | "wait" | "hash" | "which" | "whereis" | "type" | "man" | "apropos"
            | "mdfind" | "locate" => self.bump(Class::Read),
            "date" => {
                if texts
                    .iter()
                    .all(|t| t.starts_with('+') || matches!(*t, "-u" | "-R" | "-I"))
                {
                    self.bump(Class::Read)
                } else {
                    self.ask()
                }
            }
            "hostname" if texts.is_empty() => self.bump(Class::Read),
            "top" if texts == ["-l", "1"] => self.bump(Class::Read),
            "printenv" => {
                let secretish = |t: &str| {
                    let up = t.to_ascii_uppercase();
                    [
                        "TOKEN", "KEY", "SECRET", "PASS", "AUTH", "CRED", "COOKIE", "SESSION",
                    ]
                    .iter()
                    .any(|k| up.contains(k))
                };
                if !positional.is_empty() && positional.iter().all(|w| !secretish(&w.text)) {
                    self.bump(Class::Read)
                } else {
                    self.ask()
                }
            }
            "sysctl" => {
                if texts.iter().any(|t| t.contains('=') || *t == "-w") {
                    self.ask()
                } else {
                    self.bump(Class::Read)
                }
            }
            "command" => match texts.first() {
                Some(&"-v") | Some(&"-V") => self.bump(Class::Read),
                _ => self.ask(),
            },
            "cd" | "pushd" => {
                let target = positional.first().copied();
                self.cwd = match target {
                    None => Some(self.ctx.home.clone()),
                    Some(w) if w.text == "-" => None,
                    Some(w) => self.path(w),
                };
                if positional.len() > 1 || flags.iter().any(|f| f.text != "-P" && f.text != "-L") {
                    self.cwd = None;
                }
            }
            "popd" => self.cwd = None,
            // Lists names and sizes.
            "ls" | "stat" | "file" | "du" | "tree" | "wc" | "realpath" | "readlink" | "mdls"
            | "getfattr" => {
                if positional.is_empty() {
                    self.touch_cwd(Use::Names);
                }
                self.touch_all(&positional, Use::Names);
            }
            "xattr" => {
                if flags.iter().any(|f| f.text.contains(['w', 'd', 'c', 'r'])) {
                    return self.ask();
                }
                self.touch_all(&positional, Use::Names);
            }
            // Read what's in them.
            "cat" | "head" | "tail" | "less" | "more" | "bat" | "nl" | "od" | "hexdump"
            | "strings" | "cut" | "column" | "fold" | "fmt" | "paste" | "rev" | "tac"
            | "expand" | "unexpand" | "comm" | "cmp" | "md5" | "md5sum" | "shasum" | "sha1sum"
            | "sha256sum" | "sha512sum" | "cksum" | "jq" | "tr" | "look" | "iconv" => {
                self.flag_values(&flags, Use::Content);
                self.touch_all(&positional, Use::Content);
            }
            "diff" => {
                let tree = flags.iter().any(|f| is_flag(f, 'r', "--recursive"));
                self.touch_all(&positional, if tree { Use::Tree } else { Use::Content });
            }
            "sort" | "base64" => {
                if flags
                    .iter()
                    .any(|f| is_flag(f, 'o', "--output") || f.text == "-i" && name == "base64")
                {
                    return self.ask();
                }
                self.touch_all(&positional, Use::Content);
            }
            "uniq" | "xxd" => {
                if positional.len() > 1 || flags.iter().any(|f| f.text == "-r") {
                    return self.ask();
                }
                self.touch_all(&positional, Use::Content);
            }
            "grep" | "egrep" | "fgrep" | "zgrep" => {
                let tree = flags.iter().any(|f| {
                    is_flag(f, 'r', "--recursive") || is_flag(f, 'R', "--dereference-recursive")
                });
                self.flag_values(&flags, Use::Content);
                let how = if tree { Use::Tree } else { Use::Content };
                if tree && positional.len() <= 1 {
                    self.touch_cwd(Use::Tree);
                }
                self.touch_all(&positional, how);
            }
            "rg" | "ag" | "ack" => {
                if flags.iter().any(|f| f.text.starts_with("--pre")) {
                    return self.ask();
                }
                self.flag_values(&flags, Use::Content);
                if positional.len() <= 1 {
                    self.touch_cwd(Use::Tree);
                }
                self.touch_all(&positional, Use::Tree);
            }
            "find" => self.find(&texts, args),
            "fd" => {
                if texts.iter().any(|t| {
                    matches!(*t, "-x" | "-X" | "--exec" | "--exec-batch") || t.starts_with("--exec")
                }) {
                    return self.ask();
                }
                if positional.len() <= 1 {
                    self.touch_cwd(Use::Names);
                }
                self.touch_all(&positional, Use::Names);
            }
            "sed" => self.sed(&flags, &positional),
            "plutil" => match texts.first() {
                Some(&"-p") | Some(&"-lint") => self.touch_all(&positional, Use::Content),
                _ => self.ask(),
            },
            "launchctl" => match texts.first() {
                Some(&"list") | Some(&"print") => self.bump(Class::Read),
                _ => self.ask(),
            },
            "defaults" => match texts.first() {
                Some(&"read") | Some(&"read-type") | Some(&"domains") | Some(&"find") => {
                    self.bump(Class::Read)
                }
                _ => self.ask(),
            },
            "pmset" if texts.first() == Some(&"-g") => self.bump(Class::Read),
            "diskutil" => match texts.first() {
                Some(&"list") | Some(&"info") => self.bump(Class::Read),
                _ => self.ask(),
            },
            "git" => self.git(args),
            "gh" => self.gh(&texts, args),
            "curl" => self.curl(args),
            "wget" => self.wget(args),
            "xargs" => {
                // What it runs gets words nobody has seen: only listing.
                let rest = skip_xargs_flags(args);
                match rest.first().and_then(|w| program_name(&w.text)) {
                    Some("ls" | "stat" | "file" | "wc" | "du" | "echo") => self.bump(Class::Read),
                    _ => self.ask(),
                }
            }
            // Wrappers that run what follows.
            "time" | "nice" | "caffeinate" => self.wrapped(args, 0),
            "env" => self.env(args),
            // `eval` of words written out: the line they make, judged as one.
            "eval" => {
                if args.is_empty() || args.iter().any(|w| w.dynamic) {
                    return self.ask();
                }
                let line = texts.join(" ");
                self.depth += 1;
                let saved = self.cwd.clone();
                self.line(&line);
                self.cwd = saved;
                self.depth -= 1;
            }
            "timeout" | "gtimeout" => self.wrapped(args, 1),
            // Local work.
            "mkdir" | "touch" | "tee" => {
                if name == "touch" && flags.iter().any(|f| f.text.starts_with("-r")) {
                    return self.ask();
                }
                self.touch_all(&positional, Use::Write)
            }
            "cp" | "ditto" => {
                let Some((dest, sources)) = positional.split_last() else {
                    return self.ask();
                };
                self.touch_all(sources, Use::Tree);
                self.touch(dest, Use::Write);
            }
            "mv" => {
                if positional.len() < 2 {
                    return self.ask();
                }
                self.touch_all(&positional, Use::Write);
            }
            "ln" => {
                let Some((dest, sources)) = positional.split_last() else {
                    return self.ask();
                };
                self.touch_all(sources, Use::Names);
                if positional.len() == 1 {
                    self.touch_cwd(Use::Write);
                } else {
                    self.touch(dest, Use::Write);
                }
            }
            "chmod" => {
                let Some((mode, files)) = positional.split_first() else {
                    return self.ask();
                };
                // setuid / setgid, or a mode that isn't plain.
                if mode.text.contains(['s', 't'])
                    || mode.text.len() > 3 && mode.text.chars().all(|c| c.is_ascii_digit())
                {
                    return self.ask();
                }
                self.touch_all(files, Use::Write);
            }
            "rm" | "rmdir" | "unlink" | "trash" => {
                if positional.is_empty() {
                    return self.ask();
                }
                self.touch_all(&positional, Use::Delete)
            }
            "unzip" => self.unzip(&texts, args),
            "tar" | "bsdtar" | "gtar" => self.tar(args),
            "gzip" | "gunzip" | "bzip2" | "bunzip2" | "xz" | "unxz" | "zstd" => {
                let to_stdout = flags.iter().any(|f| is_flag(f, 'c', "--stdout"));
                self.touch_all(
                    &positional,
                    if to_stdout { Use::Content } else { Use::Write },
                );
            }
            "zip" => {
                let Some((archive, inputs)) = positional.split_first() else {
                    return self.ask();
                };
                self.touch(archive, Use::Write);
                self.touch_all(inputs, Use::Tree);
            }
            // The project's own tools.
            "npm" | "pnpm" | "yarn" | "bun" => self.package_manager(name, &texts),
            "npx" | "bunx" => self.npx(&texts),
            "cargo" => match texts.first() {
                Some(&("build" | "check" | "test" | "clippy" | "fmt" | "doc" | "bench")) => {
                    self.bump(Class::Change)
                }
                Some(&("tree" | "metadata")) => self.bump(Class::Read),
                Some(&("add" | "install" | "fetch" | "update")) => {
                    self.install(Eco::Cargo, &texts[1..])
                }
                _ => self.ask(),
            },
            "go" => match texts.first() {
                Some(&("build" | "test" | "vet" | "fmt")) => self.bump(Class::Change),
                Some(&("get" | "install")) => self.install(Eco::Go, &texts[1..]),
                Some(&"mod") => match texts.get(1) {
                    Some(&("tidy" | "download" | "verify" | "graph" | "why" | "vendor")) => {
                        self.bump(Class::Change)
                    }
                    _ => self.ask(),
                },
                Some(&("env" | "list")) => self.bump(Class::Read),
                _ => self.ask(),
            },
            "swift" => match texts.first() {
                Some(&("build" | "test")) => self.bump(Class::Change),
                _ => self.ask(),
            },
            "make" | "gmake" => {
                if flags
                    .iter()
                    .any(|f| f.text.starts_with("-f") || f.text.starts_with("-C"))
                    || !positional
                        .iter()
                        .all(|w| SAFE_MAKE.contains(&w.text.as_str()))
                {
                    return self.ask();
                }
                self.bump(Class::Change)
            }
            "tsc" | "eslint" | "prettier" | "vitest" | "jest" | "pytest" | "mypy" | "ruff"
            | "black" | "rustfmt" | "biome" => self.bump(Class::Change),
            "brew" => match texts.first() {
                Some(&("list" | "info" | "--prefix" | "config" | "doctor" | "outdated")) => {
                    self.bump(Class::Read)
                }
                // Homebrew installs into its own prefix, as this account.
                Some(&("install" | "upgrade" | "reinstall")) => {
                    self.install(Eco::Brew, &texts[1..])
                }
                _ => self.ask(),
            },
            "pip" | "pip3" => match texts.first() {
                Some(&("list" | "show" | "freeze")) => self.bump(Class::Read),
                Some(&"install") => self.install(Eco::Pip, &texts[1..]),
                _ => self.ask(),
            },
            "pipx" => match texts.as_slice() {
                ["install" | "upgrade", rest @ ..] => self.install(Eco::Pip, rest),
                ["run", rest @ ..] => self.run_package(Eco::Pip, rest),
                ["list", ..] => self.bump(Class::Read),
                _ => self.ask(),
            },
            "uv" => match texts.as_slice() {
                ["pip", "install", rest @ ..] | ["tool", "install", rest @ ..] => {
                    self.install(Eco::Pip, rest)
                }
                ["tool", "run", rest @ ..] => self.run_package(Eco::Pip, rest),
                ["add", rest @ ..] => self.install(Eco::Pip, rest),
                ["sync" | "lock" | "venv", ..] => self.bump(Class::Change),
                ["pip", "list" | "show" | "freeze", ..] | ["tree", ..] => self.bump(Class::Read),
                _ => self.ask(),
            },
            "uvx" => self.run_package(Eco::Pip, &texts),
            "sh" | "bash" | "zsh" | "dash" => self.shell(args),
            "python" | "python3" | "node" | "ruby" | "perl" | "deno" | "tsx" | "ts-node" => {
                self.interpreter(name, args)
            }
            _ => self.ask(),
        }
    }

    /// `--file=~/x`: a value that looks like a path is read too.
    fn flag_values(&mut self, flags: &[&Word], how: Use) {
        for f in flags {
            if let Some((_, value)) = f.text.split_once('=') {
                if value.contains('/') || value.starts_with('~') {
                    let w = Word {
                        text: value.to_string(),
                        tilde: value.starts_with('~'),
                        ..(*f).clone()
                    };
                    self.touch(&w, how);
                }
            }
        }
    }

    /// `env [-i] [NAME=value]… command`: the command, given only harmless
    /// names. `env` alone prints the environment (secrets): it asks.
    fn env(&mut self, args: &[&Word]) {
        let mut rest: Vec<Word> = Vec::new();
        let mut it = args.iter().copied();
        while let Some(w) = it.next() {
            if w.dynamic {
                return self.ask();
            }
            match w.text.as_str() {
                "-i" | "-" | "--ignore-environment" if rest.is_empty() => {}
                "-u" | "--unset" if rest.is_empty() => {
                    if it.next().is_none() {
                        return self.ask();
                    }
                }
                t if rest.is_empty() && t.starts_with('-') => return self.ask(),
                _ if rest.is_empty() && is_assignment(w) => {
                    let name = w.text.split('=').next().unwrap_or("");
                    if !SAFE_ENV.contains(&name) {
                        return self.ask();
                    }
                }
                _ => rest.push(w.clone()),
            }
        }
        if rest.is_empty() {
            return self.ask();
        }
        self.simple(rest, Vec::new());
    }

    fn wrapped(&mut self, args: &[&Word], skip: usize) {
        let rest: Vec<Word> = args.iter().skip(skip).map(|w| (*w).clone()).collect();
        if rest.is_empty() {
            return self.ask();
        }
        self.simple(rest, Vec::new());
    }

    fn find(&mut self, texts: &[&str], args: &[&Word]) {
        const ACTS: &[&str] = &["-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
        if texts.iter().any(|t| ACTS.contains(t)) {
            return self.ask();
        }
        // The paths come before the first expression.
        let roots: Vec<&Word> = args
            .iter()
            .take_while(|w| !w.text.starts_with('-') && !matches!(w.text.as_str(), "(" | "!"))
            .copied()
            .collect();
        if roots.is_empty() {
            self.touch_cwd(Use::Names);
        }
        self.touch_all(&roots, Use::Names);
        // What it finds: anything under each root.
        let found: Vec<Word> = if roots.is_empty() {
            vec![plain_glob(".")]
        } else {
            roots.iter().map(|r| plain_glob(&r.text)).collect()
        };
        if texts.contains(&"-delete") {
            for f in &found {
                self.touch(f, Use::Delete);
            }
        }
        // `-exec cmd {} ;` / `+`: the command, on what it finds.
        let mut i = 0;
        while i < args.len() {
            if matches!(args[i].text.as_str(), "-exec" | "-execdir") && !args[i].dynamic {
                let Some(len) = args[i + 1..]
                    .iter()
                    .position(|w| matches!(w.text.as_str(), ";" | "+") && !w.dynamic)
                else {
                    return self.ask();
                };
                let inner = &args[i + 1..i + 1 + len];
                if inner.is_empty() {
                    return self.ask();
                }
                for f in &found {
                    let words: Vec<Word> = inner
                        .iter()
                        .map(|w| {
                            if w.text == "{}" {
                                f.clone()
                            } else {
                                (*w).clone()
                            }
                        })
                        .collect();
                    self.simple(words, Vec::new());
                }
                i += len + 2;
            } else {
                i += 1;
            }
        }
    }

    fn sed(&mut self, flags: &[&Word], positional: &[&Word]) {
        let in_place = flags.iter().any(|f| {
            f.text == "-i" || f.text.starts_with("-i") || f.text.starts_with("--in-place")
        });
        let scripts_in_flags = flags.iter().any(|f| f.text == "-e" || f.text == "-f");
        if flags
            .iter()
            .any(|f| f.text == "-f" || f.text.starts_with("--file"))
        {
            return self.ask();
        }
        // With `-e`, the script is the word after it and was split as a
        // positional; without, the first positional is the script.
        // macOS `sed -i '' …` / `sed -i .bak …`: the backup suffix comes first.
        let mut positional = positional.to_vec();
        if flags.iter().any(|f| f.text == "-i")
            && positional.first().is_some_and(|w| {
                w.text.is_empty() || (w.text.starts_with('.') && !w.text.contains('/'))
            })
        {
            positional.remove(0);
        }
        let (scripts, files): (Vec<&Word>, Vec<&Word>) = if scripts_in_flags {
            let n = flags.iter().filter(|f| f.text == "-e").count();
            (
                positional.iter().take(n).copied().collect(),
                positional.iter().skip(n).copied().collect(),
            )
        } else {
            match positional.split_first() {
                Some((s, rest)) => (vec![*s], rest.to_vec()),
                None => return self.ask(),
            }
        };
        if !scripts.iter().all(|s| !s.dynamic && plain_sed(&s.text)) {
            return self.ask();
        }
        if in_place && files.is_empty() {
            return self.ask();
        }
        self.touch_all(&files, if in_place { Use::Write } else { Use::Content });
    }

    fn git(&mut self, args: &[&Word]) {
        let mut rest = args.iter().copied().peekable();
        let saved = self.cwd.clone();
        // `git -C <dir>`, `--no-pager`: anything else before the subcommand asks.
        while let Some(w) = rest.peek() {
            match w.text.as_str() {
                "--no-pager" | "-P" => {
                    rest.next();
                }
                "-C" => {
                    rest.next();
                    let Some(dir) = rest.next() else {
                        return self.ask();
                    };
                    self.cwd = self.path(dir);
                    self.touch(dir, Use::Names);
                }
                t if t.starts_with('-') => return self.ask(),
                _ => break,
            }
        }
        let words: Vec<&Word> = rest.collect();
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        let Some((&sub, more)) = texts.split_first() else {
            self.cwd = saved;
            return self.ask();
        };
        let only_flags = more.iter().all(|t| t.starts_with('-'));
        let read = match sub {
            "status" | "log" | "show" | "blame" | "shortlog" | "describe" | "rev-parse"
            | "ls-files" | "ls-tree" | "cat-file" | "rev-list" | "merge-base" | "grep"
            | "whatchanged" | "name-rev" | "show-ref" | "for-each-ref" | "count-objects"
            | "check-ignore" | "annotate" | "cherry" | "show-branch" => {
                !more.iter().any(|t| t.starts_with("--output") || *t == "-O")
            }
            "diff" => !more
                .iter()
                .any(|t| t.starts_with("--output") || t.starts_with("--ext")),
            "branch" if more.iter().any(|t| BRANCH_FILTERS.contains(t)) => {
                // `git branch -r --contains <sha>`: each filter takes one value.
                let mut it = more.iter();
                let mut ok = true;
                while let Some(t) = it.next() {
                    if BRANCH_FILTERS.contains(t) {
                        ok &= it.next().is_some_and(|v| !v.starts_with('-'));
                    } else {
                        ok &= matches!(
                            *t,
                            "-a" | "-r" | "-v" | "-vv" | "--list" | "-l" | "--all" | "--remotes"
                        ) || t.starts_with("--format")
                            || t.starts_with("--sort");
                    }
                }
                ok
            }
            // Fetching and pulling reach the network and update `.git`, but
            // send nothing: local work ("Go hard"). Never a helper program
            // (`--upload-pack`) or a remote-helper URL (`ext::…`).
            "fetch" | "pull" => {
                let safe = more.iter().all(|t| {
                    !t.contains("::")
                        && !t.starts_with("--upload-pack")
                        && !t.starts_with("--exec")
                        && !t.starts_with("--recurse-submodules")
                        && !matches!(*t, "-u")
                }) && words.iter().all(|w| !w.dynamic)
                    // A token in a remote's address never leaves on its own.
                    && !more.iter().any(|t| web_url(t) && self.leaks(t));
                self.cwd = saved;
                return if safe {
                    self.bump(Class::Change)
                } else {
                    self.ask()
                };
            }
            "branch" => {
                only_flags
                    && more.iter().all(|t| {
                        matches!(
                            *t,
                            "-a" | "-r"
                                | "-v"
                                | "-vv"
                                | "--list"
                                | "-l"
                                | "--all"
                                | "--remotes"
                                | "--show-current"
                                | "--merged"
                                | "--no-merged"
                        ) || t.starts_with("--format")
                            || t.starts_with("--sort")
                    })
            }
            "tag" => more.is_empty() || matches!(more, ["-l"] | ["--list"]),
            "remote" => more.is_empty() || matches!(more, ["-v"] | ["get-url", _]),
            "stash" => matches!(more.first(), Some(&"list") | Some(&"show")),
            "worktree" => matches!(more, ["list"] | ["list", "--porcelain"]),
            "reflog" => more.is_empty() || more.first() == Some(&"show"),
            "config" => matches!(
                more.first(),
                Some(&"--get")
                    | Some(&"--get-all")
                    | Some(&"--list")
                    | Some(&"-l")
                    | Some(&"--get-regexp")
            ),
            _ => false,
        };
        self.cwd = saved;
        if read {
            self.bump(Class::Read)
        } else {
            // Commits, checkouts and the like write `.git`, which agents don't
            // write without a card; push, fetch and pull reach the network.
            self.ask()
        }
    }

    fn gh(&mut self, texts: &[&str], args: &[&Word]) {
        if texts.first() == Some(&"api") && self.gh_api_leaks(&texts[1..]) {
            return self.ask();
        }
        let read = match texts {
            ["auth", "status", ..] => true,
            // A GET: no method but GET, and fields only when the method is
            // said to be GET (`gh api` turns fields into a POST otherwise).
            // A word known only when it runs could be a method: it asks.
            ["api", rest @ ..] => {
                let mut method: Option<String> = None;
                let mut fields = false;
                let mut it = rest.iter();
                while let Some(t) = it.next() {
                    if let Some(m) = t.strip_prefix("--method=") {
                        method = Some(m.to_string());
                    } else if let Some(m) = t.strip_prefix("-X").filter(|m| !m.is_empty()) {
                        method = Some(m.to_string());
                    } else if matches!(*t, "-X" | "--method") {
                        method = Some(it.next().map(|m| m.to_string()).unwrap_or_default());
                    } else if matches!(*t, "-f" | "-F" | "--field" | "--raw-field")
                        || t.starts_with("--field=")
                        || t.starts_with("--raw-field=")
                    {
                        fields = true;
                    } else if *t == "--input" || t.starts_with("--input=") {
                        method = Some("INPUT".into());
                    }
                }
                let get = match method.as_deref() {
                    None => !fields,
                    Some(m) => m.eq_ignore_ascii_case("GET"),
                };
                get && rest.first() != Some(&"graphql") && args.iter().all(|w| !w.dynamic)
            }
            [group, verb, ..] => {
                (matches!(
                    *group,
                    "pr" | "issue"
                        | "repo"
                        | "run"
                        | "release"
                        | "workflow"
                        | "label"
                        | "search"
                        | "cache"
                        | "ruleset"
                ) && matches!(*verb, "view" | "list" | "status" | "diff" | "checks"))
                    || *group == "search"
            }
            _ => false,
        };
        if read && !texts.iter().any(|t| *t == "--web" || *t == "-w") {
            self.bump(Class::Read)
        } else {
            self.ask()
        }
    }

    /// `curl` that only fetches: an http(s) GET (or HEAD) that sends no
    /// body, form, upload or config file. Reaching the network is local work
    /// ("Go hard"); the files it saves are writes like any other.
    fn curl(&mut self, args: &[&Word]) {
        // Short flags whose value is the next word (or the rest of the group).
        const VALUED: &str = "HAebcDmuxwryYzEQCtPKoTdFX";
        let mut fetched = false;
        let mut it = args.iter().copied();
        while let Some(w) = it.next() {
            if w.dynamic {
                return self.ask();
            }
            let t = w.text.as_str();
            if let Some(long) = t.strip_prefix("--") {
                let (name, inline) = match long.split_once('=') {
                    Some((n, v)) => (n, Some(v.to_string())),
                    None => (long, None),
                };
                let value = |it: &mut dyn Iterator<Item = &Word>| {
                    inline.clone().or_else(|| it.next().map(|v| v.text.clone()))
                };
                match name {
                    "request" => {
                        let m = value(&mut it).unwrap_or_default();
                        if !matches!(m.as_str(), "GET" | "HEAD") {
                            return self.ask();
                        }
                    }
                    "output" | "cookie-jar" | "dump-header" | "trace" | "trace-ascii"
                    | "stderr" | "libcurl" | "etag-save" | "hsts" | "alt-svc" => {
                        let Some(target) = value(&mut it) else {
                            return self.ask();
                        };
                        self.touch(&plain_word(target), Use::Write);
                    }
                    "remote-name" | "remote-name-all" | "remote-header-name" => {
                        self.touch_cwd(Use::Write)
                    }
                    n if n.starts_with("data")
                        || n.starts_with("form")
                        || n.starts_with("upload")
                        || n.starts_with("mail")
                        || n.starts_with("ftp")
                        || matches!(n, "json" | "config" | "post301" | "post302" | "post303") =>
                    {
                        return self.ask()
                    }
                    // Credentials sent with the request: always a card.
                    "cookie" | "user" | "oauth2-bearer" | "cert" | "key" | "pass"
                    | "proxy-user" | "aws-sigv4" | "netrc" | "netrc-file" => return self.ask(),
                    "header" | "proxy-header" => {
                        let v = value(&mut it).unwrap_or_default();
                        if egress::header_carries_secret(&v, &self.ctx.secrets) {
                            return self.ask();
                        }
                    }
                    "user-agent" | "referer" | "proxy" | "write-out" | "max-time"
                    | "connect-timeout" | "retry" | "range" | "url-query" | "cacert"
                    | "resolve" | "max-filesize" | "retry-delay" | "retry-max-time"
                    | "limit-rate" | "url" => {
                        let v = value(&mut it).unwrap_or_default();
                        if name == "url" && !web_url(&v) {
                            return self.ask();
                        }
                        if matches!(name, "url" | "referer" | "url-query" | "user-agent")
                            && self.leaks(&v)
                        {
                            return self.ask();
                        }
                        fetched |= name == "url";
                    }
                    _ => {}
                }
            } else if let Some(group) = t.strip_prefix('-').filter(|g| !g.is_empty()) {
                for (i, c) in group.char_indices() {
                    if !VALUED.contains(c) {
                        continue;
                    }
                    let rest = &group[i + c.len_utf8()..];
                    let value = if rest.is_empty() {
                        it.next().map(|v| v.text.clone())
                    } else {
                        Some(rest.to_string())
                    };
                    match c {
                        'X' => {
                            if !matches!(value.as_deref(), Some("GET" | "HEAD")) {
                                return self.ask();
                            }
                        }
                        'd' | 'F' | 'T' | 'K' | 'u' | 'b' | 'E' | 'U' => return self.ask(),
                        'H' => {
                            let v = value.unwrap_or_default();
                            if egress::header_carries_secret(&v, &self.ctx.secrets) {
                                return self.ask();
                            }
                        }
                        'e' | 'A' => {
                            if self.leaks(&value.unwrap_or_default()) {
                                return self.ask();
                            }
                        }
                        'o' | 'c' | 'D' => {
                            let Some(target) = value else {
                                return self.ask();
                            };
                            self.touch(&plain_word(target), Use::Write);
                        }
                        _ => {}
                    }
                    break;
                }
                if group.contains('O') && !group.contains(|c: char| VALUED.contains(c)) {
                    self.touch_cwd(Use::Write);
                }
            } else if web_url(t) {
                if self.leaks(t) {
                    return self.ask();
                }
                fetched = true;
            } else {
                return self.ask();
            }
        }
        if fetched {
            self.bump(Class::Change)
        } else {
            self.ask()
        }
    }

    /// `wget` that only downloads: GET, no posted body, no commands.
    fn wget(&mut self, args: &[&Word]) {
        let mut saved_to: Option<String> = None;
        let mut fetched = false;
        let mut it = args.iter().copied();
        while let Some(w) = it.next() {
            if w.dynamic {
                return self.ask();
            }
            let t = w.text.as_str();
            let (name, inline) = match t.split_once('=') {
                Some((n, v)) if t.starts_with("--") => (n, Some(v.to_string())),
                _ => (t, None),
            };
            let mut value = || inline.clone().or_else(|| it.next().map(|v| v.text.clone()));
            match name {
                "--post-data" | "--post-file" | "--body-data" | "--body-file" | "-e"
                | "--execute" | "--config" | "-i" | "--input-file" | "--use-askpass" => {
                    return self.ask()
                }
                "--method" => {
                    if !matches!(value().as_deref(), Some("GET" | "HEAD")) {
                        return self.ask();
                    }
                }
                "-O" | "--output-document" => saved_to = Some(value().unwrap_or_default()),
                "-P" | "--directory-prefix" | "-o" | "--output-file" | "-a" | "--append-output" => {
                    let Some(target) = value() else {
                        return self.ask();
                    };
                    self.touch(&plain_word(target), Use::Write);
                }
                "-q" | "--quiet" | "-nv" | "--no-verbose" | "-c" | "--continue" | "-S"
                | "--server-response" | "--spider" | "-N" | "--timestamping" => {}
                "--header" => {
                    let v = value().unwrap_or_default();
                    if egress::header_carries_secret(&v, &self.ctx.secrets) {
                        return self.ask();
                    }
                }
                n if n.starts_with("--user-agent")
                    || n.starts_with("--timeout")
                    || n.starts_with("--tries") => {}
                n if n.starts_with('-') => return self.ask(),
                n if web_url(n) => {
                    if self.leaks(n) {
                        return self.ask();
                    }
                    fetched = true
                }
                _ => return self.ask(),
            }
        }
        match saved_to.as_deref() {
            Some("-") => {}
            Some("") => return self.ask(),
            Some(file) => self.touch(&plain_word(file.to_string()), Use::Write),
            None => self.touch_cwd(Use::Write),
        }
        if fetched {
            self.bump(Class::Change)
        } else {
            self.ask()
        }
    }

    fn unzip(&mut self, texts: &[&str], args: &[&Word]) {
        if texts.iter().any(|t| *t == "-l" || *t == "-t" || *t == "-Z") {
            return self.touch_all(
                &args
                    .iter()
                    .filter(|w| !w.text.starts_with('-'))
                    .copied()
                    .collect::<Vec<_>>(),
                Use::Content,
            );
        }
        let mut dest: Option<&Word> = None;
        let mut archive: Option<&Word> = None;
        let mut it = args.iter().copied();
        while let Some(w) = it.next() {
            if w.text == "-d" {
                dest = it.next();
                if dest.is_none() {
                    return self.ask();
                }
            } else if w.text.starts_with('-') {
                if w.text == "-p" || w.text == "-c" {
                    return self.ask();
                }
            } else if archive.is_none() {
                archive = Some(w);
            }
            // Further words name members to extract.
        }
        let Some(archive) = archive else {
            return self.ask();
        };
        self.touch(archive, Use::Content);
        match dest {
            Some(d) => self.touch(d, Use::Write),
            None => self.touch_cwd(Use::Write),
        }
    }

    fn tar(&mut self, args: &[&Word]) {
        let mut letters = String::new();
        let mut archive: Option<Word> = None;
        let mut dest: Option<&Word> = None;
        let mut inputs: Vec<&Word> = Vec::new();
        let mut it = args.iter().copied().enumerate();
        while let Some((i, w)) = it.next() {
            let t = w.text.as_str();
            let bundle = if let Some(b) = t.strip_prefix("--") {
                match b {
                    "extract" | "get" => letters.push('x'),
                    "create" => letters.push('c'),
                    "list" => letters.push('t'),
                    "file" => archive = it.next().map(|(_, w)| w.clone()),
                    "directory" => dest = it.next().map(|(_, w)| w),
                    "gzip" | "gunzip" | "bzip2" | "xz" | "zstd" | "verbose" => {}
                    _ => match b.strip_prefix("file=") {
                        Some(f) => {
                            archive = Some(Word {
                                text: f.to_string(),
                                tilde: f.starts_with('~'),
                                ..w.clone()
                            })
                        }
                        None => return self.ask(),
                    },
                }
                continue;
            } else if let Some(b) = t.strip_prefix('-') {
                b
            } else if i == 0 {
                t
            } else {
                inputs.push(w);
                continue;
            };
            for c in bundle.chars() {
                match c {
                    'x' | 'c' | 't' | 'v' | 'z' | 'j' | 'J' | 'k' => letters.push(c),
                    'f' => archive = it.next().map(|(_, w)| w.clone()),
                    'C' => dest = it.next().map(|(_, w)| w),
                    // `-P` keeps absolute paths and `..`; anything else unknown asks.
                    _ => return self.ask(),
                }
            }
        }
        self.tar_mode(&letters, archive.as_ref(), dest, &inputs)
    }

    fn tar_mode(
        &mut self,
        letters: &str,
        archive: Option<&Word>,
        dest: Option<&Word>,
        inputs: &[&Word],
    ) {
        let Some(archive) = archive else {
            return self.ask();
        };
        if letters.contains('x') {
            self.touch(archive, Use::Content);
            match dest {
                Some(d) => self.touch(d, Use::Write),
                None => self.touch_cwd(Use::Write),
            }
        } else if letters.contains('c') {
            self.touch(archive, Use::Write);
            if inputs.is_empty() {
                return self.ask();
            }
            self.touch_all(inputs, Use::Tree);
        } else if letters.contains('t') {
            self.touch(archive, Use::Content);
        } else {
            self.ask()
        }
    }

    /// Installing packages: local work ("Go hard") when it fetches only
    /// what the project already has (`installs`): no package named, or each
    /// one declared, well known, or allowed before for this project. A new
    /// package asks (and is remembered once allowed). Never from a raw
    /// address (`https://…`, `git+…`), another registry or index, or global
    /// (`-g`); `sudo` already asks before this is reached.
    fn install(&mut self, eco: Eco, rest: &[&str]) {
        let raw = |t: &str| {
            let l = t.to_ascii_lowercase();
            l.contains("://")
                || l.starts_with("git+")
                || l.starts_with("git@")
                || l.starts_with("github:")
                || l.starts_with("gitlab:")
                || l.starts_with("bitbucket:")
                || l.starts_with("npm:")
                || l.starts_with("file:")
                || l.ends_with(".tgz")
                || l.ends_with(".whl") && l.contains('/')
        };
        let global = |t: &str| {
            matches!(
                t,
                "-g" | "--global"
                    | "--location=global"
                    | "--system"
                    | "--break-system-packages"
                    | "--root"
                    | "--prefix"
                    | "--target"
                    | "--index-url"
                    | "--extra-index-url"
                    | "--registry"
                    | "--git"
                    | "--path"
            ) || t.starts_with("--prefix=")
                || t.starts_with("--root=")
                || t.starts_with("--target=")
                || t.starts_with("--index-url=")
                || t.starts_with("--extra-index-url=")
                || t.starts_with("--registry=")
        };
        if rest.iter().any(|t| t.is_empty() || raw(t) || global(t)) {
            return self.ask();
        }
        let mut it = rest.iter().copied();
        while let Some(t) = it.next() {
            match t {
                // pip's own requirements file: what the project declares.
                "-r" | "--requirement" | "-c" | "--constraint" if eco == Eco::Pip => {
                    let Some(file) = it.next() else {
                        return self.ask();
                    };
                    self.touch(&plain_word(file.to_string()), Use::Content);
                }
                // pip's other index: another registry.
                "-i" if eco == Eco::Pip => return self.ask(),
                // The project itself, from its own folder.
                "-e" | "--editable" if eco == Eco::Pip => match it.next() {
                    Some(p) if p.starts_with('.') || p.starts_with('/') => {}
                    _ => return self.ask(),
                },
                // A workspace filter names a package of the project's own.
                "--filter" | "-F" | "--workspace" if eco == Eco::Npm => {
                    it.next();
                }
                "." if eco == Eco::Pip => {}
                t if t.starts_with('-') => {}
                spec => self.package(eco, spec),
            }
        }
        self.bump(Class::Change)
    }

    /// One package an install names: the project's already, or it asks.
    fn package(&mut self, eco: Eco, spec: &str) {
        let Some(name) = installs::package_name(eco, spec) else {
            return self.ask();
        };
        let entry = installs::entry(eco, &name);
        let known = installs::well_known(eco, &name)
            || self.ctx.packages.contains(&entry)
            || self
                .cwd
                .as_ref()
                .is_some_and(|cwd| installs::declared(eco, &name, cwd, &self.ctx.home));
        // Not the project's yet: still local work at "Go hard", but noted. In
        // a turn that read outside content it asks (`after_outside_asks`).
        if !known && !self.unknown.contains(&entry) {
            self.unknown.push(entry);
        }
    }

    /// `npx x`, `pnpm dlx x`, `uvx x`, `pipx run x`: fetching and running a
    /// package. Local work only when it is the project's (or well known).
    fn run_package(&mut self, eco: Eco, texts: &[&str]) {
        let mut named: Option<&str> = None;
        let mut it = texts.iter().copied();
        while let Some(t) = it.next() {
            match t {
                "-p" | "--package" | "--from" | "--spec" => named = it.next(),
                t if t.starts_with("--package=") || t.starts_with("--from=") => {
                    named = t.split_once('=').map(|(_, v)| v)
                }
                // `npx -c "…"` runs a shell line.
                "-c" | "--call" => return self.ask(),
                t if t.starts_with('-') => {}
                t => {
                    named = named.or(Some(t));
                    break;
                }
            }
        }
        let Some(spec) = named else {
            return self.ask();
        };
        if spec.contains("://") || spec.starts_with("git+") || spec.contains(':') {
            return self.ask();
        }
        if eco == Eco::Npm && SAFE_NPX.contains(&spec) {
            return self.bump(Class::Change);
        }
        self.package(eco, spec);
        self.bump(Class::Change)
    }

    fn package_manager(&mut self, name: &str, texts: &[&str]) {
        match texts {
            ["install" | "i" | "add" | "ci" | "update" | "up" | "upgrade", rest @ ..] => {
                return self.install(Eco::Npm, rest)
            }
            // Removing fetches nothing.
            ["remove" | "rm" | "uninstall" | "un", rest @ ..] => {
                if rest.iter().any(|t| matches!(*t, "-g" | "--global")) {
                    return self.ask();
                }
                return self.bump(Class::Change);
            }
            [] if name != "npm" => return self.install(Eco::Npm, &[]),
            ["dlx" | "x", rest @ ..] if name != "npm" => return self.run_package(Eco::Npm, rest),
            ["exec", rest @ ..] if name == "npm" => return self.run_package(Eco::Npm, rest),
            _ => {}
        }
        let script = match texts {
            ["test" | "t", ..] => Some("test"),
            ["run" | "run-script", script, ..] => Some(*script),
            ["ls" | "list" | "why" | "outdated" | "view" | "info", ..] => {
                return self.bump(Class::Read)
            }
            ["config", "get", ..] | ["config", "list"] => return self.bump(Class::Read),
            [script, ..] if name != "npm" && !script.starts_with('-') => {
                // `pnpm build`, `yarn lint`: a script, unless it's a command
                // of the package manager's own.
                if PM_COMMANDS.contains(script) {
                    None
                } else {
                    Some(*script)
                }
            }
            _ => None,
        };
        match script {
            Some(s) if safe_script(s) => self.bump(Class::Change),
            _ => self.ask(),
        }
    }

    /// `npx <package>`: fetching and running a published package. Local
    /// work at "Go hard" only when it's the project's (`run_package`).
    fn npx(&mut self, texts: &[&str]) {
        self.run_package(Eco::Npm, texts)
    }

    fn shell(&mut self, args: &[&Word]) {
        let mut it = args.iter().copied();
        while let Some(w) = it.next() {
            match w.text.as_str() {
                t if t.starts_with('-')
                    && t.ends_with('c')
                    && t[1..].chars().all(|c| "lecuxi".contains(c)) =>
                {
                    let Some(code) = it.next() else {
                        return self.ask();
                    };
                    if code.dynamic {
                        return self.ask();
                    }
                    self.depth += 1;
                    let saved = self.cwd.clone();
                    self.line(&code.text);
                    self.cwd = saved;
                    self.depth -= 1;
                    return;
                }
                "-l" | "-e" | "-u" | "-x" | "-eu" => {}
                t if t.starts_with('-') => return self.ask(),
                _ => return self.run_file(w, Some(Lang::Shell)),
            }
        }
        // `bash` alone reads commands from somewhere unseen.
        self.ask()
    }

    fn interpreter(&mut self, name: &str, args: &[&Word]) {
        let lang = if matches!(name, "python" | "python3") {
            Lang::Python
        } else {
            Lang::Other
        };
        let mut it = args.iter().copied();
        while let Some(w) = it.next() {
            match w.text.as_str() {
                "-c" | "-e" | "--eval" | "-p" | "--print" => {
                    let Some(code) = it.next() else {
                        return self.ask();
                    };
                    if code.dynamic || !clean_code(&code.text) {
                        return self.ask();
                    }
                    return self.bump(Class::Change);
                }
                "-m" if lang == Lang::Python => {
                    return match it.next().map(|w| w.text.as_str()) {
                        Some("pytest" | "unittest" | "py_compile" | "compileall" | "json.tool") => {
                            self.bump(Class::Change)
                        }
                        _ => self.ask(),
                    };
                }
                "-u" | "-B" | "-O" | "-W" | "--no-warnings" => {}
                "run" if name == "deno" => {}
                t if t.starts_with('-') => return self.ask(),
                _ => return self.run_file(w, Some(lang)),
            }
        }
        self.ask()
    }

    /// A program named by its path (`./build.sh`): what its first line says
    /// runs it.
    fn script(&mut self, program: &Word, _args: &[&Word]) {
        self.run_file(program, None)
    }

    /// Run a script file: its code, read here, has to pass too.
    fn run_file(&mut self, file: &Word, lang: Option<Lang>) {
        let Some(path) = self.path(file) else {
            return self.ask();
        };
        if !self.ctx.writable(&path) && !under(&path, &self.ctx.own_home) {
            // Only scripts in the home, outside every protected place.
            return self.ask();
        }
        let Some(code) = read_small(&path) else {
            return self.ask();
        };
        let lang = lang.or_else(|| shebang_lang(&code));
        match lang {
            Some(Lang::Shell) => {
                let body: String = code
                    .lines()
                    .filter(|l| !l.trim_start().starts_with("#!"))
                    .map(|l| format!("{l}\n"))
                    .collect();
                self.depth += 1;
                let saved = self.cwd.clone();
                self.line(&body);
                self.cwd = saved;
                self.depth -= 1;
                self.bump(Class::Change);
            }
            Some(Lang::Python | Lang::Other) if clean_code(&code) => self.bump(Class::Change),
            _ => self.ask(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Lang {
    Shell,
    Python,
    Other,
}

fn shebang_lang(code: &str) -> Option<Lang> {
    let first = code.lines().next()?.strip_prefix("#!")?;
    let last = first.split_whitespace().last()?;
    let name = last.rsplit('/').next()?;
    match name {
        "sh" | "bash" | "zsh" | "dash" => Some(Lang::Shell),
        "python" | "python3" => Some(Lang::Python),
        "node" | "ruby" | "perl" | "deno" | "tsx" => Some(Lang::Other),
        _ => None,
    }
}

/// A script's text, if it's small enough to read through.
fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 256 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Code (not shell) that shows nothing that sends, deletes, spawns or reaches
/// a protected place. A heuristic: its text is read, not what it imports.
fn clean_code(code: &str) -> bool {
    let lower = code.to_ascii_lowercase();
    !CODE_MARKERS.iter().any(|m| lower.contains(m))
}

const CODE_MARKERS: &[&str] = &[
    "subprocess",
    "os.system",
    "os.popen",
    "os.exec",
    "os.spawn",
    "pty.",
    "child_process",
    "execsync",
    "spawn",
    "exec(",
    "eval(",
    "system(",
    "popen",
    "`",
    "%x",
    "socket",
    "http",
    "urllib",
    "requests",
    "fetch(",
    "axios",
    "smtp",
    "net/",
    "net::",
    "ftp",
    "websocket",
    "ws://",
    "rmtree",
    "remove(",
    "unlink",
    "rmsync",
    "rmdir",
    "fs.rm",
    "rm_rf",
    "chmod",
    "chown",
    "keychain",
    ".ssh",
    ".gnupg",
    "launchagents",
    "launchdaemons",
    ".zshrc",
    ".bashrc",
    ".bash_profile",
    ".profile",
    "sudo",
    "git push",
    "ctypes",
    "__import__",
    "importlib",
    "ffi",
    "dlopen",
    "process.binding",
    "deno.run",
    "deno.command",
    "osascript",
    ".env",
    "credential",
    "secret",
    "token",
    "password",
    "library/application support",
];

/// sed scripts that only print, delete lines or substitute (no `w` file, no
/// `e` command, no `r` read).
fn plain_sed(script: &str) -> bool {
    script.split([';', '\n']).all(|part| {
        let part = part.trim();
        if part.is_empty() {
            return true;
        }
        // An address: line numbers, `$`, `/re/`, ranges.
        let mut rest = part;
        loop {
            let before = rest;
            rest = rest.trim_start_matches(|c: char| c.is_ascii_digit() || c == '$' || c == ',');
            if let Some(r) = rest.strip_prefix('/') {
                match r.find('/') {
                    Some(end) => rest = &r[end + 1..],
                    None => return false,
                }
            }
            if rest == before {
                break;
            }
        }
        let rest = rest.trim_start_matches('!').trim();
        match rest.chars().next() {
            Some('p' | 'd' | 'q' | '=' | 'n' | 'N' | 'P' | 'D' | 'G' | 'g' | 'h' | 'H' | 'x') => {
                rest.len() == 1
            }
            Some('s') => {
                let mut chars = rest.chars();
                chars.next();
                let Some(delim) = chars.next() else {
                    return false;
                };
                let body: String = chars.collect();
                let parts: Vec<&str> = body.split(delim).collect();
                parts.len() == 3
                    && parts[2].chars().all(|c| {
                        matches!(c, 'g' | 'p' | 'i' | 'I' | 'm' | 'M') || c.is_ascii_digit()
                    })
            }
            None => true,
            _ => false,
        }
    })
}

/// Anything under `root`, as a pattern (`root/*`).
fn plain_glob(root: &str) -> Word {
    Word {
        text: format!("{}/*", root.trim_end_matches('/')),
        glob: true,
        tilde: root.starts_with('~'),
        ..Word::default()
    }
}

/// A word as the shell would read it unquoted (`~/x` is the home).
fn plain_word(text: String) -> Word {
    Word {
        tilde: text.starts_with('~'),
        text,
        ..Word::default()
    }
}

/// An `http://` or `https://` address (never `file://`, which reads files).
fn web_url(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

/// The temporary folders: `/tmp` (`/private/tmp`) and this account's `$TMPDIR`.
fn temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")];
    // `$TMPDIR` only where macOS puts it: a `TMPDIR` pointed at the home
    // doesn't make the home a temporary folder.
    let tmp = std::env::temp_dir();
    let real = std::fs::canonicalize(&tmp).unwrap_or_else(|_| tmp.clone());
    if real.starts_with("/private/var/folders") && real.components().count() > 4 {
        roots.push(real);
        roots.push(tmp);
    } else if cfg!(windows) {
        // The account's own temp folder (`%LOCALAPPDATA%\Temp`, Git Bash's
        // `/tmp`), not one a `TEMP` setting moved somewhere else.
        let real = paths::plain(real);
        if dirs::home_dir()
            .is_some_and(|h| under(&real, &h.join("AppData").join("Local").join("Temp")))
        {
            roots.push(real);
        }
    }
    roots
}

/// `$TMPDIR` as agents' shells see it (they inherit this process's), when
/// it is a temporary folder macOS made.
fn known_tmpdir() -> Option<String> {
    let tmp = std::env::var("TMPDIR").ok()?;
    let trimmed = tmp.trim_end_matches('/').to_string();
    (temp_roots().len() > 2 && !trimmed.is_empty()).then_some(trimmed)
}

/// Inside a temporary folder (not the folder itself).
fn in_temp(p: &Path) -> bool {
    temp_roots().iter().any(|r| under(p, r) && !same(p, r))
}

/// `git branch` filters that take a commit.
const BRANCH_FILTERS: &[&str] = &[
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
];

/// A name a script may set for itself (`RID=…`): not one that changes how
/// the programs after it run (`PATH`, `IFS`, `DYLD_*`…), and not one already
/// handed to programs (an exported name would reach them).
fn shell_variable(name: &str) -> bool {
    const NEVER: &[&str] = &[
        "PATH",
        "IFS",
        "CDPATH",
        "ENV",
        "BASH_ENV",
        "PS4",
        "PROMPT_COMMAND",
        "HOME",
        "ZDOTDIR",
        "SHELLOPTS",
        "BASHOPTS",
        "GLOBIGNORE",
        "FPATH",
        "PAGER",
        "EDITOR",
        "VISUAL",
        "SHELL",
        "TMPDIR",
    ];
    const PREFIXES: &[&str] = &[
        "LD_",
        "DYLD_",
        "GIT_",
        "GH_",
        "NODE_",
        "NPM_",
        "PYTHON",
        "PERL",
        "RUBY",
        "BASH_",
        "ZSH",
        "CURL",
        "SSH_",
        "HTTP",
        "HTTPS",
        "ALL_PROXY",
        "NO_PROXY",
    ];
    let upper = name.to_ascii_uppercase();
    !NEVER.contains(&upper.as_str())
        && !PREFIXES.iter().any(|p| upper.starts_with(p))
        && !upper.ends_with("_PROXY")
        && std::env::var_os(name).is_none()
}

fn is_assignment(w: &Word) -> bool {
    let Some((name, _)) = w.text.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && !w.tilde
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// The program a command names: a bare name, or one in a system bin folder.
/// `None` for a path to a file of its own.
fn program_name(program: &str) -> Option<&str> {
    if !program.contains('/') {
        return Some(program);
    }
    let (dir, name) = program.rsplit_once('/')?;
    matches!(
        dir,
        "/bin" | "/usr/bin" | "/usr/sbin" | "/sbin" | "/usr/local/bin" | "/opt/homebrew/bin"
    )
    .then_some(name)
}

/// Flags (`-x`, `--y`, until `--`) and the rest.
fn split_args<'a>(args: &[&'a Word]) -> (Vec<&'a Word>, Vec<&'a Word>) {
    let mut flags = Vec::new();
    let mut positional = Vec::new();
    let mut ended = false;
    for w in args {
        if !ended && w.text == "--" {
            ended = true;
        } else if !ended && w.text.starts_with('-') && w.text.len() > 1 && !w.dynamic {
            flags.push(*w);
        } else {
            positional.push(*w);
        }
    }
    (flags, positional)
}

/// `-r` (alone or bundled, `-rn`) or its long name.
fn is_flag(w: &Word, short: char, long: &str) -> bool {
    let t = w.text.as_str();
    t == long
        || t.starts_with(&format!("{long}="))
        || (t.starts_with('-') && !t.starts_with("--") && t[1..].contains(short))
}

fn skip_xargs_flags<'a>(args: &[&'a Word]) -> Vec<&'a Word> {
    let mut i = 0;
    while i < args.len() && args[i].text.starts_with('-') {
        if matches!(
            args[i].text.as_str(),
            "-I" | "-n" | "-P" | "-L" | "-d" | "-E" | "-s"
        ) {
            i += 1;
        }
        i += 1;
    }
    args[i.min(args.len())..].to_vec()
}

fn safe_script(name: &str) -> bool {
    SAFE_SCRIPTS.contains(&name)
        || [
            "test:",
            "build:",
            "lint:",
            "check:",
            "typecheck:",
            "format:",
            "fmt:",
        ]
        .iter()
        .any(|p| name.starts_with(p))
}

/// Environment names a command may be given in front of it.
const SAFE_ENV: &[&str] = &[
    "CI",
    "NODE_ENV",
    "FORCE_COLOR",
    "NO_COLOR",
    "LANG",
    "LC_ALL",
    "TZ",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "DEBUG",
    "TERM",
    "COLUMNS",
    "PAGER",
    "GIT_PAGER",
];

const TOOLCHAINS: &[&str] = &[
    "node",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "python",
    "python3",
    "pip",
    "pip3",
    "ruby",
    "go",
    "cargo",
    "rustc",
    "rustup",
    "git",
    "gh",
    "brew",
    "java",
    "swift",
    "tsc",
    "claude",
    "codex",
    "make",
    "xcodebuild",
];

/// Package-script names that build, check or test.
const SAFE_SCRIPTS: &[&str] = &[
    "test",
    "build",
    "lint",
    "typecheck",
    "type-check",
    "check",
    "format",
    "fmt",
    "tsc",
    "compile",
    "verify",
];

/// A package manager's own commands, which aren't scripts (`pnpm add`).
const PM_COMMANDS: &[&str] = &[
    "add",
    "install",
    "i",
    "ci",
    "remove",
    "rm",
    "uninstall",
    "update",
    "up",
    "upgrade",
    "publish",
    "pack",
    "link",
    "unlink",
    "login",
    "logout",
    "dlx",
    "exec",
    "x",
    "create",
    "init",
    "patch",
    "deploy",
    "store",
    "config",
    "set",
    "import",
    "rebuild",
    "audit",
];

const SAFE_NPX: &[&str] = &["tsc", "eslint", "prettier", "vitest", "jest", "biome"];

const SAFE_MAKE: &[&str] = &["all", "build", "test", "check", "lint", "fmt", "format"];

/// Programs that always ask, at every level: they send, publish, reach the
/// network, run something unseen, need root, install software, or touch
/// credentials, ownership, the shell or the system. (Anything not
/// recognised asks too; this list is the explicit part.)
pub const ALWAYS_ASK: &[&str] = &[
    // Root, other users, other shells' worth of code.
    "sudo",
    "doas",
    "su",
    "exec",
    "source",
    ".",
    "nohup",
    "disown",
    "export",
    "unset",
    "set",
    "alias",
    "trap",
    "awk",
    "gawk",
    "nawk",
    // The network.
    "http",
    "https",
    "xh",
    "httpie",
    "nc",
    "ncat",
    "netcat",
    "telnet",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "ftp",
    "socat",
    "aria2c",
    // Sending and publishing.
    "mail",
    "mailx",
    "sendmail",
    "msmtp",
    "mutt",
    "slack",
    "slack-cli",
    "twilio",
    "stripe",
    "vercel",
    "netlify",
    "wrangler",
    "firebase",
    "fly",
    "flyctl",
    "heroku",
    "aws",
    "gcloud",
    "gsutil",
    "az",
    "doctl",
    "terraform",
    "pulumi",
    "kubectl",
    "helm",
    "docker",
    "podman",
    "twine",
    "gem",
    "lpr",
    "say",
    // Credentials, the system and the shell.
    "security",
    "osascript",
    "open",
    "crontab",
    "at",
    "chsh",
    "dscl",
    "dseditgroup",
    "systemsetup",
    "networksetup",
    "scutil",
    "softwareupdate",
    "installer",
    "pkgutil",
    "spctl",
    "csrutil",
    "tccutil",
    "kextload",
    "nvram",
    "bless",
    "mount",
    "umount",
    "hdiutil",
    "chown",
    "chgrp",
    "chflags",
    "dd",
    "mkfs",
    "newfs_apfs",
    "shutdown",
    "reboot",
    "halt",
    "kill",
    "pkill",
    "killall",
    "code",
    "cursor",
    "pbcopy",
    "pbpaste",
    "shred",
    "srm",
    "mas",
    "port",
    "rustup",
];

// ============================================================================
// Reading outside content (`exposure`)
// ============================================================================

/// Whether a command line reads text from outside this Mac: a web page or
/// API answer (`curl` / `wget` to anything but this Mac, or a script that
/// fetches one), issue or pull request comments (`gh issue view --comments`,
/// `gh pr view --comments`, `gh api …/comments`), a repository's files, a
/// cloned repository, or Mail and Messages on this Mac. `exposure` marks the
/// turn. A pull request's or issue's own text, its diff and a run's log
/// ([`reads_by_author`]) are decided by who wrote them, once the output is
/// seen; `gh pr checks`, plain `gh run view` and `git fetch` don't count.
pub fn command_reads_outside(command: &str) -> bool {
    outside_line(command, 0)
}

/// A `gh` read whose text is outside content unless the signed-in user
/// wrote it (`exposure` decides from the output, failing safe).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByAuthor {
    /// Its output names its author: `gh pr view`, `gh issue view`, `gh api
    /// …/pulls/N` or `…/issues/N`. `pr`: the pull request it shows, when
    /// named (`<repo>#<number>`), so a later diff of it is known.
    Shown { pr: Option<String> },
    /// `gh pr diff`: the diff names no author; only an earlier view of the
    /// same pull request (`pr`) says whose it is.
    Diff { pr: Option<String> },
    /// No author can be read from it (`gh run view --log`, a line too
    /// complex to follow): outside.
    Unknown,
}

/// Every [`ByAuthor`] read on a command line.
pub fn reads_by_author(command: &str) -> Vec<ByAuthor> {
    let mut out = Vec::new();
    by_author_line(command, 0, &mut out);
    out
}

fn by_author_line(command: &str, depth: u8, out: &mut Vec<ByAuthor>) {
    if depth > MAX_DEPTH {
        out.push(ByAuthor::Unknown);
        return;
    }
    let Some(lexed) = lex(command, "") else {
        let lower = command.to_ascii_lowercase();
        if ["gh pr ", "gh issue ", "gh run ", "gh api "]
            .iter()
            .any(|m| lower.contains(m))
        {
            out.push(ByAuthor::Unknown);
        }
        return;
    };
    for s in &lexed.subs {
        by_author_line(s, depth + 1, out);
    }
    let mut words: Vec<Word> = Vec::new();
    let mut toks = lexed.toks.into_iter();
    loop {
        let tok = toks.next();
        let end = tok.is_none();
        match tok {
            Some(Tok::Word(w)) => {
                words.push(w);
                continue;
            }
            Some(Tok::Out | Tok::In | Tok::Text) => {
                toks.next();
                continue;
            }
            Some(Tok::Sep) | None => {}
        }
        let simple = strip_wrappers(std::mem::take(&mut words));
        let texts: Vec<&str> = simple.iter().map(|w| w.text.as_str()).collect();
        match texts.first().and_then(|p| program_name(p)) {
            Some("gh") => out.extend(gh_by_author(&texts[1..])),
            Some("sh" | "bash" | "zsh" | "dash") => {
                if let Some(code) = texts
                    .iter()
                    .position(|t| t.starts_with('-') && t.ends_with('c'))
                    .and_then(|i| texts.get(i + 1))
                {
                    by_author_line(code, depth + 1, out);
                }
            }
            Some("eval") => by_author_line(&texts[1..].join(" "), depth + 1, out),
            _ => {}
        }
        if end {
            return;
        }
    }
}

/// The [`ByAuthor`] read one `gh` invocation makes, if any.
fn gh_by_author(args: &[&str]) -> Option<ByAuthor> {
    let comments = |rest: &[&str]| rest.iter().any(|a| matches!(*a, "--comments" | "-c"));
    // `--json state,statusCheckRollup`: no one's words, only status.
    let only_status = |rest: &[&str]| {
        const TEXT: &[&str] = &[
            "title",
            "body",
            "comments",
            "reviews",
            "latestReviews",
            "commits",
            "files",
            "headRefName",
        ];
        let fields = rest
            .iter()
            .position(|a| *a == "--json")
            .and_then(|i| rest.get(i + 1).copied())
            .or_else(|| rest.iter().find_map(|a| a.strip_prefix("--json=")));
        fields.is_some_and(|f| !f.split(',').any(|f| TEXT.contains(&f.trim())))
    };
    match args {
        ["pr", "view", rest @ ..] if !comments(rest) && !only_status(rest) => {
            Some(ByAuthor::Shown { pr: pr_key(rest) })
        }
        ["pr", "diff", rest @ ..] => Some(ByAuthor::Diff { pr: pr_key(rest) }),
        ["issue", "view", rest @ ..] if !comments(rest) && !only_status(rest) => {
            Some(ByAuthor::Shown { pr: None })
        }
        ["run", "view", rest @ ..] if rest.iter().any(|a| a.starts_with("--log")) => {
            Some(ByAuthor::Unknown)
        }
        ["api", rest @ ..]
            if rest
                .iter()
                .any(|a| !a.starts_with('-') && api_single_item(a)) =>
        {
            Some(ByAuthor::Shown { pr: None })
        }
        _ => None,
    }
}

/// `<repo>#<number>` for a `gh pr view|diff` naming one (a number or a pull
/// request's address); `None` for the current branch's, which can change.
fn pr_key(rest: &[&str]) -> Option<String> {
    let mut repo = "";
    let mut number = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match *a {
            "-R" | "--repo" => repo = it.next().copied().unwrap_or(""),
            // Flags that take a value: skip it.
            "-q" | "--jq" | "-t" | "--template" | "--json" | "--color" | "-B" => {
                it.next();
            }
            a if a.starts_with("--repo=") => repo = &a["--repo=".len()..],
            a if a.starts_with('-') => {}
            a if number.is_none()
                && !a.is_empty()
                && (a.chars().all(|c| c.is_ascii_digit()) || a.contains("/pull/")) =>
            {
                number = Some(a)
            }
            _ => {}
        }
    }
    number.map(|n| format!("{}#{n}", repo.to_ascii_lowercase()))
}

/// `gh api` path naming one pull request or issue (`repos/o/r/pulls/12`):
/// its JSON's `user` is the author. Anything under it (`/comments`,
/// `/files`) isn't one.
fn api_single_item(path: &str) -> bool {
    let path = path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let mut segs = path.rsplit('/');
    let (Some(number), Some(kind)) = (segs.next(), segs.next()) else {
        return false;
    };
    matches!(kind, "pulls" | "issues")
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

fn outside_line(command: &str, depth: u8) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    let Some(lexed) = lex(command, "") else {
        // Unparseable (it asked): judge the text itself.
        let lower = command.to_ascii_lowercase();
        return [
            "curl ",
            "wget ",
            "gh issue",
            "gh api",
            "--comments",
            "git clone",
        ]
        .iter()
        .any(|m| lower.contains(m))
            || script_text_reads_outside(&lower);
    };
    if lexed.subs.iter().any(|s| outside_line(s, depth + 1)) {
        return true;
    }
    let mut words: Vec<Word> = Vec::new();
    // `<<<` text: what an interpreter reads as its program.
    let mut here: Vec<String> = Vec::new();
    let mut toks = lexed.toks.into_iter();
    while let Some(tok) = toks.next() {
        match tok {
            Tok::Word(w) => words.push(w),
            Tok::Sep => {
                if outside_simple(
                    std::mem::take(&mut words),
                    &std::mem::take(&mut here),
                    depth,
                ) {
                    return true;
                }
            }
            Tok::Text => {
                if let Some(Tok::Word(w)) = toks.next() {
                    here.push(w.text);
                }
            }
            // A redirect's target isn't an argument.
            Tok::Out | Tok::In => {
                toks.next();
            }
        }
    }
    outside_simple(words, &here, depth)
}

fn outside_simple(words: Vec<Word>, here: &[String], depth: u8) -> bool {
    let words = strip_wrappers(words);
    let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
    let Some(name) = texts.first().and_then(|p| program_name(p)) else {
        return false;
    };
    // Mail and Messages on this Mac are other people's words, whatever
    // reads them (`sqlite3 …/chat.db`, `cat …/Mail/…/*.emlx`, `grep -r`).
    if texts[1..].iter().any(|a| message_store(a)) {
        return true;
    }
    if let Some(reads) = interpreter_reads_outside(name, &texts[1..], here) {
        return reads;
    }
    let args = &texts[1..];
    match name {
        "curl" | "wget" => curl_reads_outside(args),
        "git" => args.contains(&"clone") && args.iter().any(|a| remote_url(a) || a.contains('@')),
        "gh" => match args {
            // Without comments, an issue's or a pull request's text is the
            // author's: [`reads_by_author`] decides once its output is seen.
            ["issue", "view", rest @ ..] => rest.iter().any(|a| matches!(*a, "--comments" | "-c")),
            ["pr", "view", rest @ ..] => rest.iter().any(|a| {
                matches!(*a, "--comments" | "-c")
                    || ((a.contains("comments") || a.contains("reviews") || a.contains("Reviews"))
                        && !a.starts_with('-'))
            }),
            ["api", rest @ ..] => rest.iter().any(|a| {
                !a.starts_with('-')
                    && !api_single_item(a)
                    && [
                        "comments",
                        "reviews",
                        "issues",
                        "discussions",
                        "notifications",
                        "timeline",
                        "events",
                        "graphql",
                        "contents",
                        "files",
                        "logs",
                    ]
                    .iter()
                    .any(|m| a.contains(m))
            }),
            _ => false,
        },
        "sh" | "bash" | "zsh" | "dash" => texts
            .iter()
            .position(|t| t.starts_with('-') && t.ends_with('c'))
            .and_then(|i| texts.get(i + 1))
            .is_some_and(|code| outside_line(code, depth + 1)),
        "eval" => outside_line(&args.join(" "), depth + 1),
        _ => false,
    }
}

/// Whether a `curl` / `wget` with these arguments reads from off this Mac.
/// A full address says where; without one (`curl evil.example/x`,
/// `curl "$URL"`, `curl -K config`, `wget -i list`) the target can't be
/// read off the line, so only one that names this Mac is local. Flags alone
/// (`curl --version`) read nothing.
fn curl_reads_outside(args: &[&str]) -> bool {
    let full: Vec<&str> = args
        .iter()
        .filter_map(|a| {
            a.find("://").map(|i| {
                let start = a[..i]
                    .rfind(|c: char| !c.is_ascii_alphabetic())
                    .map_or(0, |j| j + 1);
                &a[start..]
            })
        })
        .collect();
    if !full.is_empty() {
        return full.iter().any(|u| remote_url(u));
    }
    if args.iter().all(|a| a.starts_with('-')) {
        return false;
    }
    let host_of = |a: &str| -> String {
        let h = a.split(['/', '?', '#']).next().unwrap_or("");
        match h.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host.to_string(),
            _ => h.to_string(),
        }
    };
    !args.iter().any(|a| {
        let h = host_of(a);
        !h.is_empty() && local_host(&h)
    })
}

/// What a script names when it reaches the network, by language. A
/// denylist: a program that does it some other way (a script file, a
/// library not listed, a binary) isn't seen. See docs/agents.md, "Other
/// programs that fetch".
const NET_PY: &[&str] = &[
    "urllib",
    "requests",
    "http.client",
    "httpx",
    "aiohttp",
    "urlopen",
    "socket",
    "pycurl",
    "ftplib",
    "imaplib",
    "poplib",
];
const NET_JS: &[&str] = &[
    "fetch(",
    "require('http",
    "require(\"http",
    "from 'http",
    "from \"http",
    "node:http",
    "http.get",
    "https.get",
    "http.request",
    "https.request",
    "axios",
    "undici",
    "net.connect",
    "xmlhttprequest",
    "websocket",
];
const NET_RB: &[&str] = &[
    "net/http",
    "net::http",
    "open-uri",
    "uri.open",
    "httparty",
    "faraday",
    "socket",
    "net/imap",
    "net::imap",
];
const NET_PL: &[&str] = &[
    "lwp",
    "http::tiny",
    "io::socket",
    "net::http",
    "net::imap",
    "mojo::useragent",
];

/// Mail and Messages on this Mac: other people's words, in the user's
/// own stores (`~/Library/Messages/chat.db`, `~/Library/Mail/…`).
fn message_store(arg: &str) -> bool {
    let a = arg.to_ascii_lowercase();
    ["library/messages", "library/mail", "com.apple.mail"]
        .iter()
        .any(|m| {
            a.match_indices(m).any(|(i, _)| {
                let after = a[i + m.len()..].chars().next();
                after.is_none_or(|c| c == '/' || c == '"' || c == '\'')
            })
        })
        || a.ends_with("/chat.db")
        || a == "chat.db"
}

/// An AppleScript or JXA program that talks to Mail or Messages.
fn osascript_reads_mail(code: &str) -> bool {
    let c = code.to_ascii_lowercase();
    ["mail", "messages", "microsoft outlook"].iter().any(|app| {
        [
            format!("application \"{app}\""),
            format!("app \"{app}\""),
            format!("application(\"{app}\")"),
            format!("application('{app}')"),
            format!("application id \"com.apple.{app}\""),
        ]
        .iter()
        .any(|p| c.contains(p.as_str()))
    })
}

/// Whether script code that reaches the network (`markers`) reads from
/// somewhere other than this Mac. Every address it writes out decides; with
/// none (a variable, an argument), only one naming this Mac is local.
fn script_reads_network(code: &str, markers: &[&str]) -> bool {
    let lower = code.to_ascii_lowercase();
    if !markers.iter().any(|m| lower.contains(m)) {
        return false;
    }
    let urls: Vec<&str> = ["http://", "https://", "ws://", "wss://", "ftp://"]
        .iter()
        .flat_map(|scheme| lower.match_indices(scheme).map(|(i, _)| i))
        .map(|i| {
            let rest = &lower[i..];
            let end = rest
                .find(|c: char| c.is_whitespace() || "'\"`)(;,<>".contains(c))
                .unwrap_or(rest.len());
            &rest[..end]
        })
        .collect();
    if !urls.is_empty() {
        return urls.iter().any(|u| remote_url(u));
    }
    !["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|h| lower.contains(h))
}

/// `Some(reads)` when `name` is a script interpreter (or `sqlite3`,
/// `osascript`) this knows; `None` for any other program. `here`: `<<<`
/// text handed to it.
fn interpreter_reads_outside(name: &str, args: &[&str], here: &[String]) -> Option<bool> {
    // The program as written on the line: inline code (`-c`, `-e`,
    // `--eval=`), modules it loads (`-M`, `-r`, `-m`) and `<<<` text. A
    // script file's contents aren't seen.
    let code = args
        .iter()
        .copied()
        .chain(here.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let reads = match name {
        n if n == "python" || n.starts_with("python2") || n.starts_with("python3") => {
            script_reads_network(&code, NET_PY)
        }
        "node" | "bun" | "deno" => script_reads_network(&code, NET_JS),
        "ruby" => script_reads_network(&code, NET_RB),
        "perl" => script_reads_network(&code, NET_PL),
        "osascript" => osascript_reads_mail(&code) || script_reads_network(&code, NET_JS),
        // A database file: Messages' and Mail's are caught above.
        "sqlite3" => false,
        _ => return None,
    };
    Some(reads)
}

/// A command line too complex to follow (a here-document): whether its text
/// runs an interpreter on code that reaches the network or reads Mail or
/// Messages.
fn script_text_reads_outside(lower: &str) -> bool {
    let runs = |names: &[&str]| names.iter().any(|n| lower.contains(n));
    (runs(&["python"]) && script_reads_network(lower, NET_PY))
        || (runs(&["node", "bun ", "deno "]) && script_reads_network(lower, NET_JS))
        || (runs(&["ruby"]) && script_reads_network(lower, NET_RB))
        || (runs(&["perl"]) && script_reads_network(lower, NET_PL))
        || (runs(&["osascript"]) && osascript_reads_mail(lower))
        || lower.split_whitespace().any(message_store)
}

/// Loop words, assignments and wrappers in front of the program.
fn strip_wrappers(mut words: Vec<Word>) -> Vec<Word> {
    loop {
        let Some(first) = words.first() else {
            return words;
        };
        let skip = match first.text.as_str() {
            "do" | "then" | "else" | "if" | "elif" | "while" | "until" | "!" | "time" | "nice"
            | "caffeinate" | "nohup" | "command" => 1,
            "timeout" | "gtimeout" => 2,
            "env" | "xargs" => {
                1 + words[1..]
                    .iter()
                    .take_while(|w| w.text.starts_with('-') || is_assignment(w))
                    .count()
            }
            _ if is_assignment(first) => 1,
            _ => 0,
        };
        if skip == 0 {
            return words;
        }
        words.drain(..skip.min(words.len()));
    }
}

/// In a turn that read outside content (`exposure`), whether this call asks
/// even at "Go hard": it writes to the network somewhere other than this Mac
/// (`go_hard::sends_off_mac`), or fetches a package the project doesn't have
/// yet (`installs`). Everything else (local work, builds, project installs,
/// network reads, dev servers, here-document scripts) is unaffected.
pub fn after_outside_asks(tool: &str, input: &Value, ctx: &Ctx) -> bool {
    if tool != "Bash" {
        return false;
    }
    let command = input.get("command").and_then(Value::as_str).unwrap_or("");
    let line = super::go_hard::without_heredoc_data(command);
    let sends = if ctx.full_send {
        super::go_hard::moves_data_off_mac(command, ctx)
    } else {
        super::go_hard::sends_off_mac(command, ctx)
    };
    sends || !new_packages(&line, ctx).is_empty()
}

#[cfg(test)]
mod outside_mark_tests {
    use super::*;
    use serde_json::json;

    fn bash(command: &str) -> Value {
        json!({ "command": command, "description": "x" })
    }

    /// The Chief read x.com once; later the owner asks it directly for
    /// ordinary work. At Go hard that used to raise a card for every network
    /// write in the conversation; now only raw data off the Mac and new
    /// packages ask.
    #[test]
    fn the_owners_own_request_isnt_carded_by_an_earlier_outside_read() {
        let c = Ctx::default();
        let webhook = "curl -X POST https://hooks.example.test/notify -d '{\"ok\":true}'";
        let upload = "curl -T notes.txt https://collect.example.test/";
        let package = "pnpm add fictional-chart";
        let gh_comment = "gh issue comment 4 --body done";
        // Not the owner's own words: as before, every network write asks.
        for cmd in [webhook, upload, package, gh_comment] {
            assert!(
                outside_mark_asks("Bash", &bash(cmd), &c, false, false),
                "{cmd}"
            );
        }
        // The owner asked: `gh` writes are the level's own business (Go hard
        // asks for them anyway), while data leaving and new packages ask.
        assert!(!outside_mark_asks(
            "Bash",
            &bash(gh_comment),
            &c,
            false,
            true
        ));
        assert!(outside_mark_asks("Bash", &bash(upload), &c, false, true));
        assert!(outside_mark_asks("Bash", &bash(webhook), &c, false, true));
        assert!(outside_mark_asks("Bash", &bash(package), &c, false, true));
        assert!(!outside_mark_asks(
            "Bash",
            &bash("ls -la && pnpm build"),
            &c,
            false,
            true
        ));
    }
}

/// What the outside-content mark (`exposure`) asks for, in a turn that read
/// something from outside earlier in its conversation. The mark lasts the
/// conversation; `direct` (the turn answers the owner's own message, at Go
/// hard or Full send) narrows it to what Full send keeps after outside
/// content: raw data leaving for another host and packages new to the
/// project. Reading x.com once no longer puts cards on the owner's own later
/// requests; pushes and `gh` writes still follow the level's own rules.
pub fn outside_mark_asks(
    tool: &str,
    input: &Value,
    ctx: &Ctx,
    full_send: bool,
    direct: bool,
) -> bool {
    let ctx = Ctx {
        full_send: full_send || direct,
        ..ctx.clone()
    };
    after_outside_asks(tool, input, &ctx)
}

/// A web address somewhere other than this Mac.
pub fn remote_url(t: &str) -> bool {
    if !web_url(t) {
        return false;
    }
    let Ok(u) = url::Url::parse(t) else {
        return true;
    };
    !u.host_str().is_some_and(local_host)
}

/// This Mac: `localhost`, a loopback address, `*.localhost`.
pub fn local_host(host: &str) -> bool {
    let h = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || h.ends_with(".localhost")
        || h.starts_with("127.")
}

#[cfg(test)]
#[path = "autoallow_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "autoallow_gaps_tests.rs"]
mod gaps_tests;

#[cfg(test)]
#[path = "autoallow_hardening_tests.rs"]
mod hardening_tests;

#[cfg(test)]
#[path = "autoallow_os_tests.rs"]
mod os_tests;
