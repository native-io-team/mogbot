//! "Go hard": allow by default, with a short, explicit list that still asks.
//!
//! At "Go hard" the user has said "do what I asked without asking me at every
//! step", like Claude Code's own "do anything" mode. So the question here is
//! the opposite of `autoallow`'s: not "can this be vouched for?" but "is this
//! on the list of things that act as the user, outside this Mac, or on the
//! Mac itself?". Anything not on the list runs: local git, builds, installs,
//! dev servers, backgrounding, `pkill`, copying `.env` files between the
//! user's projects, network reads, localhost requests, file work in the home.
//!
//! **Still asks** ([`asks`]):
//! - `git push` of any kind (force, deleting a remote branch), `git send-email`
//! - `gh` acting as the user: pr/issue/release/repo/gist/workflow/secret
//!   writes, `gh api` with a write method or fields
//! - `npm`/`pnpm`/`yarn`/`bun` publish (and unpublish, deprecate, dist-tag, owner)
//! - deploys: `vercel` (bare, `deploy`, `--prod`, promote, alias…),
//!   `netlify deploy --prod`, `fly deploy`, `firebase deploy`, `wrangler
//!   deploy|publish`, and the rest in [`program`]
//! - sending messages: `mail`, `sendmail`, `osascript` naming Mail/Messages or
//!   send, and the chat CLIs in [`MESSENGERS`]
//! - Stripe in live mode, except reads
//! - `curl`/`wget`/`http` that write (a write method, or a body) to a host
//!   other than this Mac
//! - `sudo`/`su`/`doas`; `rm -r` outside the user's projects, the agents'
//!   homes and temporary folders (and always of the home, `~/Library`, `/`)
//! - writes to `~/.ssh`, shell profiles, launch agents, credential stores, the
//!   app's own data (another agent's home); `crontab`, `security`, `launchctl`,
//!   disk and system tools; `defaults write` / `delete` / `import`
//! - reading the app's own data, except that an admin (the Chief) reads the
//!   agents folder (every agent's home) and an agent its own home
//! - connector tools whose name sends, publishes, pushes, uploads, spends or
//!   deletes (send, post, push, upload, pay, delete…); records in the user's
//!   own tools (create, update) run. On a code host or a database
//!   (`github`, `gitlab`, `bitbucket`, `supabase`, `postgres`, `neon`,
//!   `planetscale`, `mysql`) every write asks: pushing files, creating or
//!   updating a file, a branch, a pull request, a release or a tag, and
//!   running SQL. Reads (`get_…`, `list_…`, `search_…`) run
//! - a network request with a secret in its address, query or headers
//!   (`egress`): `curl`, `wget`, `http`, `gh api`, `git` remotes, WebFetch,
//!   WebSearch; requests to this Mac are exempt
//!
//! Wrappers are judged by what they run: `env`, `xargs`, `timeout`, `eval`,
//! `find -exec` / `-execdir` / `-ok` (and `find -delete` like `rm -r`), and
//! the quoted text of `bash -c` and the like.
//!
//! **After outside content** (`exposure`: the turn fetched a page, searched,
//! read issue comments, mail or chat): the same, plus moving data to another
//! host ([`sends_off_mac`]: `ssh`, `scp`, `rsync host:`, `nc`…) and packages
//! new to the project (`autoallow::after_outside_asks`). Network reads,
//! builds, project installs and here-document scripts still run.
//!
//! **Outside text** (a turn answering a routine's items): the same, plus any
//! network write (even to localhost) and running a package fetched by name
//! (`npx pkg`, `npm i pkg`, `pip install`, `curl … | sh`). Local work and
//! reading stay allowed: reading a page is the job.
//!
//! Parsing is deliberately forgiving: a command line is split into every
//! command it runs, including those inside quotes (`bash -c "…"`), and each
//! is checked against the list. A here-document's body is data unless a
//! shell (or `ssh`, `osascript`) runs it, or it is a script that starts
//! processes, whose strings are then checked. Something it can't read runs, because "Go
//! hard" is allow-by-default; the list is what has to be right.

use serde_json::Value;
use std::path::{Path, PathBuf};

use super::autoallow::Ctx;

/// Whether a call still asks at "Go hard". `outside`: the turn answers
/// outside text.
pub fn asks(tool: &str, input: &Value, ctx: &Ctx, outside: bool) -> bool {
    let field = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim();
    match tool {
        "Bash" => command_asks(field("command"), ctx, outside),
        "Write" | "Edit" | "MultiEdit" => write_asks(field("file_path"), ctx),
        "NotebookEdit" => write_asks(field("notebook_path"), ctx),
        "Read" | "Glob" | "Grep" | "LS" => {
            let raw = if field("file_path").is_empty() {
                field("path")
            } else {
                field("file_path")
            };
            !raw.is_empty() && resolve(raw, ctx).is_some_and(|p| secret_to_read(&p, ctx))
        }
        // A page or a search that would carry a secret off this Mac.
        "WebFetch" => super::egress::carries_secret(field("url"), &ctx.secrets),
        "WebSearch" | "web_search" => super::egress::holds_secret(field("query"), &ctx.secrets),
        t if t.starts_with(super::browser_gate::SERVER) => false,
        t if t.starts_with("mcp__") => {
            if ctx.full_send {
                connector_floor(t)
            } else {
                connector_asks(t, outside)
            }
        }
        // claude.ai artifacts: reading runs; publishing, commenting or writing
        // rows acts as the user on claude.ai, so it asks (at "Full send" only
        // deleting one does, as for connectors).
        t if super::autoallow::artifact_read(t, input) == Some(false) => {
            !ctx.full_send || field("action") == "delete"
        }
        // Claude Code's and Codex's own tools (web search, todo lists, tasks).
        _ => false,
    }
}

/// What no rule remembered from chat ever covers (`remember`), whatever it
/// says: commands and file work on Go hard's own ask list (pushing,
/// publishing, deploys, sending, `sudo`, deleting outside the work folders,
/// credentials and system files), every action in the user's browser, and
/// connector tools that send or post as the user, pay, push, delete or touch
/// credentials: every connector call Go hard asks for, plus credentials,
/// payouts and wipes. What is left for a remembered rule is what the lower
/// levels ask for, such as updating the user's own records ("upsert social
/// posts").
pub fn floor(tool: &str, input: &Value, ctx: &Ctx) -> bool {
    match tool {
        t if t.starts_with(super::browser_gate::SERVER) => true,
        t if t.starts_with("mcp__") => remembered_floor(t),
        _ => asks(tool, input, ctx, false),
    }
}

/* ------------------------------------------------------------ paths */

fn resolve(raw: &str, ctx: &Ctx) -> Option<PathBuf> {
    let home = ctx.home.to_string_lossy().to_string();
    let raw = raw.replace("${HOME}", &home).replace("$HOME", &home);
    if raw.contains('$') {
        return None;
    }
    let p = if raw == "~" {
        ctx.home.clone()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        ctx.home.join(rest)
    } else if raw.starts_with('~') {
        return None;
    } else if raw.starts_with('/') {
        PathBuf::from(&raw)
    } else {
        ctx.cwd.join(&raw)
    };
    Some(normalise(&p))
}

fn normalise(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Keychains, `~/.ssh`, `~/.gnupg` and the like, and the app's own data
/// other than this agent's home: never read or written without a card.
fn credential_store(p: &Path, ctx: &Ctx) -> bool {
    if p.starts_with(&ctx.own_home) {
        return false;
    }
    const STORES: &[&str] = &[
        "Library/Keychains",
        ".ssh",
        ".gnupg",
        ".password-store",
        "Library/Cookies",
        "Library/Application Support/com.apple.TCC",
        "Library/Application Support/1Password",
    ];
    STORES.iter().any(|s| p.starts_with(ctx.home.join(s)))
        || ctx.app_data.iter().any(|d| p.starts_with(d))
        || p.starts_with("/Library/Keychains")
}

/// Files in the agents folder that name accounts and connections: read
/// only with a card, whoever asks.
const TEAM_PRIVATE: &[&str] = &["wallet.json", "connections.json"];

/// The team's own files, which every agent reads without a card at "Go
/// hard" and "Full send": every agent's home (`CLAUDE.md`, its chat log,
/// what it did, the files it made) and the team's registry. No secret lives
/// there (they are in the Keychain; the bridge and Remote Access tokens sit
/// beside it in the app's data, and still ask), and using what the team made
/// is the job. The account files ([`TEAM_PRIVATE`]) and anything named like
/// a secret (`.env`, a key, "token", "password"…) still ask. Writing another
/// agent's files still asks ([`protected`]); copying out of them into its own
/// home or a project doesn't.
fn team_file(p: &Path, ctx: &Ctx) -> bool {
    ctx.app_data.iter().any(|d| {
        let root = d.join("agents");
        p.starts_with(&root)
            && !super::autoallow::sensitive_name(p)
            && !p
                .strip_prefix(&root)
                .ok()
                .and_then(|r| r.to_str())
                .is_some_and(|r| TEAM_PRIVATE.contains(&r))
    })
}

/// Reading here asks: a credential store, but not the team's own files.
fn secret_to_read(p: &Path, ctx: &Ctx) -> bool {
    credential_store(p, ctx) && !team_file(p, ctx)
}

/// Writing here changes what runs next, or who can get in.
fn protected(p: &Path, ctx: &Ctx) -> bool {
    const PROFILES: &[&str] = &[
        ".zshrc",
        ".zshenv",
        ".zprofile",
        ".zlogin",
        ".zlogout",
        ".bashrc",
        ".bash_profile",
        ".bash_login",
        ".profile",
        ".config/fish",
        ".oh-my-zsh",
        "Library/LaunchAgents",
        "Library/LaunchDaemons",
    ];
    if credential_store(p, ctx) || PROFILES.iter().any(|s| p.starts_with(ctx.home.join(s))) {
        return true;
    }
    // The app's own files in the agent's home: its log and instructions.
    if p.parent() == Some(ctx.own_home.as_path()) {
        if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
            if n.ends_with(".jsonl") || matches!(n, "CLAUDE.md" | "AGENTS.md") {
                return true;
            }
        }
    }
    // Outside the home and temporary folders: the Mac's own files.
    !p.starts_with(&ctx.home) && !in_temp(p) && !p.starts_with("/dev")
}

fn write_asks(raw: &str, ctx: &Ctx) -> bool {
    match resolve(raw, ctx) {
        Some(p) => protected(&p, ctx),
        None => true,
    }
}

fn in_temp(p: &Path) -> bool {
    let mut roots = vec![
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/var/folders"),
        PathBuf::from("/private/var/folders"),
    ];
    roots.push(std::env::temp_dir());
    roots.iter().any(|r| p.starts_with(r) && p != r)
}

/// Folders people keep projects in, below the home.
const PROJECT_FOLDERS: &[&str] = &[
    "ShipStudio",
    "Projects",
    "Desktop/Projects",
    "Documents/Projects",
    "Developer",
    "Code",
    "code",
    "src",
    "dev",
    "repos",
    "git",
    "work",
    "Sites",
];

/// Where `rm -r` runs without a card: the user's projects, the agents' homes
/// and copies, temporary folders, below the turn's working folder.
fn deletable(p: &Path, ctx: &Ctx) -> bool {
    if in_temp(p) {
        return true;
    }
    let lib = ctx.home.join("Library");
    let agents = ctx.app_data.iter().map(|d| d.join("agents"));
    let mut roots: Vec<PathBuf> = ctx.scratch.clone();
    roots.push(ctx.own_home.clone());
    roots.extend(agents);
    roots.extend(PROJECT_FOLDERS.iter().map(|f| ctx.home.join(f)));
    if let Ok(r) = crate::utils::projects_root() {
        roots.push(r);
    }
    if ctx.cwd.starts_with(&ctx.home) && ctx.cwd != ctx.home && !ctx.cwd.starts_with(&lib) {
        roots.push(ctx.cwd.clone());
        // The folder the working copy sits in (`../fix-268` beside it).
        if let Some(repo) = repo_of(&ctx.cwd) {
            if let Some(parent) = repo.parent() {
                if parent.starts_with(&ctx.home) && parent != ctx.home {
                    roots.push(parent.to_path_buf());
                }
            }
        }
    }
    if roots.iter().any(|r| p.starts_with(r) && p != r) {
        return true;
    }
    // Inside a git working copy below the home (not the home, not ~/Library).
    p.starts_with(&ctx.home)
        && !p.starts_with(&lib)
        && repo_of(p).is_some_and(|r| r != ctx.home && r.starts_with(&ctx.home))
}

/// The working copy `p` is in: the nearest ancestor (or itself) with `.git`.
fn repo_of(p: &Path) -> Option<PathBuf> {
    p.ancestors()
        .find(|a| a.join(".git").exists())
        .map(Path::to_path_buf)
}

/* ------------------------------------------------------------ lexing */

/// Every simple command in a command line, as its words. Quoted text is also
/// split as commands of its own (`bash -c "git push"`), and so is what
/// follows `$(` or a backtick.
pub(super) fn commands(src: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    lex_into(&without_heredoc_data(src), &mut out, 0);
    out
}

/// What an AppleScript that sends mail or a message says.
const OSASCRIPT_SENDS: &[&str] = &[
    "\"mail\"",
    "\"messages\"",
    "send ",
    "outgoing message",
    "mail.app",
];

/// How a script in a here-document starts a process (Python, Node, Ruby,
/// Perl): its string literals are then read as commands.
const SPAWNS: &[&str] = &[
    "subprocess",
    "os.system",
    "os.popen",
    "child_process",
    "execSync",
    "execFile",
    "spawn",
    "system(",
    "exec(",
    "Popen",
];

/// Programs whose here-document is run as commands, not kept as data.
const RUNS_ITS_INPUT: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "ssh",
    "osascript",
    "eval",
    "source",
    "xargs",
    "su",
    "sudo",
    "doas",
];

/// `src` with the body of each here-document dropped when it is data: the
/// file a `cat > f.mjs <<'EOF'` writes is a script's text (regexes with
/// `<` and `>`, words like `import`), not commands this line runs. A body
/// fed to a shell (`bash <<EOF`) or another program that runs it (`ssh`,
/// `osascript`) is kept and checked like the rest, and so
/// is everything when a body has no closing line (nothing is dropped on a
/// guess). `<<` inside quotes is text, and `<<<` is a here-string.
pub(super) fn without_heredoc_data(src: &str) -> String {
    if !src.contains("<<") {
        return src.to_string();
    }
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut quote: Option<char> = None;
    let mut pending: Vec<(String, bool)> = Vec::new();
    let mut line_start = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == '\\' && q == '"' && i + 1 < chars.len() {
                out.push(c);
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            out.push(c);
            i += 1;
            continue;
        }
        match c {
            '\\' if i + 1 < chars.len() => {
                out.push(c);
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            '\'' | '"' => quote = Some(c),
            '<' if chars.get(i + 1) == Some(&'<') => {
                if chars.get(i + 2) == Some(&'<') {
                    out.push_str("<<<");
                    i += 3;
                    continue;
                }
                let mut j = i + 2;
                let tabs = chars.get(j) == Some(&'-');
                if tabs {
                    j += 1;
                }
                while chars.get(j).is_some_and(|c| *c == ' ' || *c == '\t') {
                    j += 1;
                }
                let mut delim = String::new();
                while let Some(&d) = chars.get(j) {
                    if d.is_whitespace() || matches!(d, ';' | '&' | '|' | '<' | '>' | '(' | ')') {
                        break;
                    }
                    if d != '\'' && d != '"' && d != '\\' {
                        delim.push(d);
                    }
                    j += 1;
                }
                if !delim.is_empty() {
                    pending.push((delim, tabs));
                }
                out.extend(&chars[i..j]);
                i = j;
                continue;
            }
            '\n' if !pending.is_empty() => {
                out.push('\n');
                let line: String = chars[line_start..i].iter().collect();
                let runs = line
                    .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')'))
                    .any(|w| RUNS_ITS_INPUT.contains(&base(w)));
                let rest: String = chars[i + 1..].iter().collect();
                let mut bodies = rest.split_inclusive('\n');
                let mut used = 0;
                for (delim, tabs) in pending.drain(..) {
                    let mut closed = false;
                    let mut data = String::new();
                    for body in bodies.by_ref() {
                        used += body.chars().count();
                        let end = body.trim_end_matches(['\n', '\r']);
                        let end = if tabs {
                            end.trim_start_matches('\t')
                        } else {
                            end
                        };
                        if end == delim {
                            // A script that starts processes: the commands
                            // it names in its strings are checked.
                            if SPAWNS.iter().any(|s| data.contains(s)) {
                                for lit in string_literals(&data) {
                                    out.push_str(&lit);
                                    out.push('\n');
                                }
                            }
                            out.push_str(body);
                            closed = true;
                            break;
                        }
                        if runs {
                            out.push_str(body);
                        } else {
                            data.push_str(body);
                        }
                    }
                    if !closed {
                        return src.to_string();
                    }
                }
                i += 1 + used;
                line_start = i;
                continue;
            }
            '\n' => line_start = i + 1,
            _ => {}
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Quoted text given to a program that only matches or edits text with it:
/// `sed`, `grep` and the like always, `perl` when the script starts no
/// process. `words`: the command's words so far.
fn pattern_text(words: &[String], inner: &str) -> bool {
    let Some(prog) = words
        .iter()
        .map(String::as_str)
        .find(|w| !is_assignment(w) && !KEYWORDS.contains(w))
    else {
        return false;
    };
    // A command substitution runs whatever it quotes.
    if inner.contains("$(") || inner.contains('`') {
        return false;
    }
    match base(prog) {
        "sed" | "gsed" | "grep" | "egrep" | "fgrep" | "rg" | "jq" => true,
        "perl" => !["system", "exec", "qx", "`", "open", "fork"]
            .iter()
            .any(|w| inner.contains(w)),
        _ => false,
    }
}

fn lex_into(src: &str, out: &mut Vec<Vec<String>>, depth: u8) {
    let chars: Vec<char> = src.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut nested: Vec<String> = Vec::new();
    let flush_word = |word: &mut String, started: &mut bool, words: &mut Vec<String>| {
        if *started {
            words.push(std::mem::take(word));
            *started = false;
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                word.push(chars[i + 1]);
                started = true;
                i += 2;
                continue;
            }
            '\'' | '"' => {
                let close = chars[i + 1..].iter().position(|&x| x == c);
                let end = close.map(|n| i + 1 + n).unwrap_or(chars.len());
                let inner: String = chars[i + 1..end].iter().collect();
                word.push_str(&inner);
                started = true;
                // A `sed` or `grep` pattern is text, not commands it runs
                // (`'/<script src="/old.js">/d'` isn't a redirect into `/d`),
                // and so is a `perl` script that starts nothing.
                if !pattern_text(&words, &inner) {
                    nested.push(inner);
                }
                i = end + 1;
                continue;
            }
            ' ' | '\t' => flush_word(&mut word, &mut started, &mut words),
            ';' | '&' | '|' | '\n' | '(' | ')' | '`' | '{' | '}' => {
                flush_word(&mut word, &mut started, &mut words);
                if !words.is_empty() {
                    out.push(std::mem::take(&mut words));
                }
            }
            '$' if chars.get(i + 1) == Some(&'{') => {
                let close = chars[i..].iter().position(|&x| x == '}');
                let end = close.map(|n| i + n).unwrap_or(chars.len() - 1);
                word.extend(&chars[i..=end]);
                started = true;
                i = end + 1;
                continue;
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                flush_word(&mut word, &mut started, &mut words);
                if !words.is_empty() {
                    out.push(std::mem::take(&mut words));
                }
                i += 2;
                continue;
            }
            '>' | '<' => {
                // A redirect: `>`, `>>`, `2>`, `&>`; the target is its own word.
                let digits = word.chars().all(|d| d.is_ascii_digit());
                if started && digits {
                    word.clear();
                    started = false;
                }
                flush_word(&mut word, &mut started, &mut words);
                let mut op = String::from(c);
                while chars
                    .get(i + 1)
                    .is_some_and(|&n| n == '>' || n == '&' || n == '<')
                {
                    i += 1;
                    op.push(chars[i]);
                }
                words.push(op);
            }
            _ => {
                word.push(c);
                started = true;
            }
        }
        i += 1;
    }
    flush_word(&mut word, &mut started, &mut words);
    if !words.is_empty() {
        out.push(words);
    }
    if depth < 3 {
        for n in nested {
            if n.chars().any(char::is_whitespace) {
                lex_into(&n, out, depth + 1);
            }
        }
    }
}

/* ------------------------------------------------------------ commands */

fn command_asks(command: &str, ctx: &Ctx, outside: bool) -> bool {
    let lower = command.to_ascii_lowercase();
    // `osascript` reading its script from a here-document or a pipe: the
    // script is not its arguments, so look at the whole line.
    if !ctx.full_send
        && lower.contains("osascript")
        && OSASCRIPT_SENDS.iter().any(|w| lower.contains(w))
    {
        return true;
    }
    // Fetched code piped into a shell: a new package by another name.
    if outside
        && [
            "| sh", "|sh", "| bash", "|bash", "| zsh", "| python", "| node",
        ]
        .iter()
        .any(|p| lower.contains(p))
        && (lower.contains("curl") || lower.contains("wget"))
    {
        return true;
    }
    // Follow `cd` through the line, so `cd ~/p && cp ../q/.env .` resolves
    // where the shell would.
    // The engine's shell keeps its folder between calls, so until a `cd`
    // here says where it is, a relative path is only resolved for `rm -r`
    // (against the turn's folder); credential and profile checks look at
    // absolute and `~` paths.
    let mut here = ctx.clone();
    let mut known = false;
    for words in commands(command) {
        if words.first().map(String::as_str) == Some("cd") {
            match words.get(1).and_then(|d| resolve(d, &here)) {
                Some(dir) => here.cwd = dir,
                None if words.len() == 1 => here.cwd = ctx.home.clone(),
                None => {}
            }
            known = words.get(1).is_none_or(|d| is_abs(d) || known);
            continue;
        }
        if simple_asks(&words, &here, outside, known) {
            return true;
        }
    }
    false
}

/// Shell words that come before the command they run.
const KEYWORDS: &[&str] = &[
    "do", "then", "else", "elif", "if", "while", "until", "!", "time",
];

const WRAPPERS: &[&str] = &[
    "env",
    "eval",
    "nohup",
    "time",
    "command",
    "exec",
    "nice",
    "builtin",
    "caffeinate",
    "stdbuf",
];

fn base(w: &str) -> &str {
    w.rsplit('/').next().unwrap_or(w)
}

fn is_assignment(w: &str) -> bool {
    w.split_once('=').is_some_and(|(k, _)| {
        !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn is_abs(raw: &str) -> bool {
    raw.starts_with('/')
        || raw.starts_with('~')
        || raw.starts_with("$HOME")
        || raw.starts_with("${HOME}")
}

/// `raw` resolved when where it points can be known (see `command_asks`).
fn resolve_known(raw: &str, ctx: &Ctx, known: bool) -> Option<PathBuf> {
    (known || is_abs(raw)).then(|| resolve(raw, ctx)).flatten()
}

fn simple_asks(words: &[String], ctx: &Ctx, outside: bool, known: bool) -> bool {
    let mut words: Vec<&str> = words.iter().map(String::as_str).collect();
    // Redirect targets: writing into a protected file asks.
    let mut targets = Vec::new();
    let mut i = 0;
    while i < words.len() {
        if words[i].starts_with('>') {
            if let Some(t) = words.get(i + 1) {
                targets.push(*t);
            }
            words.drain(i..(i + 2).min(words.len()));
        } else if words[i].starts_with('<') {
            words.drain(i..(i + 2).min(words.len()));
        } else {
            i += 1;
        }
    }
    if targets
        .iter()
        .any(|t| resolve_known(t, ctx, known).is_some_and(|p| protected(&p, ctx)))
    {
        return true;
    }
    // Leading assignments and wrappers.
    let rest = unwrapped(&words);
    let Some((&prog, args)) = rest.split_first() else {
        return false;
    };
    // Any program reading or writing a credential store asks.
    if args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .any(|a| resolve_known(a, ctx, known).is_some_and(|p| secret_to_read(&p, ctx)))
    {
        return true;
    }
    // A request that would carry a secret off this Mac (`egress`).
    if leaks_secret(base(prog), args, ctx) {
        return true;
    }
    if base(prog) == "find" {
        return find_asks(args, ctx, outside, known);
    }
    program(base(prog), args, ctx, outside, known)
}

/// `find`: each `-exec` / `-execdir` / `-ok` / `-okdir` command is judged as
/// the command it is (`{}` stands for what it finds, under the roots), and
/// `-delete` like `rm -r` of each root.
fn find_asks(args: &[&str], ctx: &Ctx, outside: bool, known: bool) -> bool {
    let roots: Vec<&str> = args
        .iter()
        .copied()
        .take_while(|a| !a.starts_with('-') && !matches!(*a, "!" | "(" | ")"))
        .collect();
    let roots = if roots.is_empty() { vec!["."] } else { roots };
    if args.contains(&"-delete") {
        let rm: Vec<&str> = std::iter::once("-r").chain(roots.iter().copied()).collect();
        if program("rm", &rm, ctx, outside, known) {
            return true;
        }
    }
    let mut i = 0;
    while i < args.len() {
        if matches!(args[i], "-exec" | "-execdir" | "-ok" | "-okdir") {
            let inner: Vec<&str> = args[i + 1..]
                .iter()
                .copied()
                .take_while(|w| !matches!(*w, ";" | "\\;" | "+"))
                .collect();
            if inner.is_empty() {
                return true;
            }
            for root in &roots {
                let found = format!("{}/x", root.trim_end_matches('/'));
                let mut words: Vec<String> = inner
                    .iter()
                    .map(|w| {
                        if *w == "{}" {
                            found.clone()
                        } else {
                            w.to_string()
                        }
                    })
                    .collect();
                // What it finds is an argument even where the line lost `{}`.
                if !inner.contains(&"{}") {
                    words.push(found);
                }
                if simple_asks(&words, ctx, outside, known || is_abs(root)) {
                    return true;
                }
            }
            i += inner.len() + 2;
        } else {
            i += 1;
        }
    }
    false
}

/// Programs that make network requests, whose addresses and headers
/// `egress` reads.
fn leaks_secret(prog: &str, args: &[&str], ctx: &Ctx) -> bool {
    use super::egress::{carries_secret, header_carries_secret, holds_secret, secret_name};
    let secrets = &ctx.secrets;
    let urls = || args.iter().copied().filter(|a| a.contains("://"));
    // A secret sent to this Mac doesn't leave it (`localhost:3000/api`).
    let off_mac = || {
        let named: Vec<&str> = args
            .iter()
            .copied()
            .filter(|a| !a.starts_with('-') && (a.contains("://") || local_host(a)))
            .collect();
        named.is_empty() || !named.iter().all(|a| local_host(a))
    };
    let url_leaks = || urls().any(|u| carries_secret(u, secrets));
    match prog {
        "curl" => {
            if !off_mac() {
                return false;
            }
            let mut it = args.iter().copied();
            while let Some(a) = it.next() {
                let (flag, inline) = match a.split_once('=') {
                    Some((f, v)) if a.starts_with("--") => (f, Some(v)),
                    _ if a.starts_with("-H") && a.len() > 2 && !a.starts_with("--") => {
                        ("-H", Some(&a[2..]))
                    }
                    _ => (a, None),
                };
                match flag {
                    "-H" | "--header" | "--proxy-header" => {
                        let v = inline.or_else(|| it.next()).unwrap_or("");
                        if header_carries_secret(v, secrets) {
                            return true;
                        }
                    }
                    // Credentials sent with the request.
                    "-u" | "--user" | "--oauth2-bearer" | "-b" | "--cookie" | "--proxy-user" => {
                        return true
                    }
                    "-e" | "--referer" | "-A" | "--user-agent" | "--url" | "--url-query" => {
                        let v = inline.or_else(|| it.next()).unwrap_or("");
                        if holds_secret(v, secrets) || carries_secret(v, secrets) {
                            return true;
                        }
                    }
                    _ => {}
                }
            }
            url_leaks()
        }
        "wget" => {
            off_mac()
                && (url_leaks()
                    || args.iter().any(|a| {
                        a.strip_prefix("--header=")
                            .is_some_and(|h| header_carries_secret(h, secrets))
                            || a.starts_with("--password=")
                            || a.starts_with("--http-password=")
                    }))
        }
        "http" | "https" | "xh" | "xhs" => {
            off_mac()
                && (url_leaks()
                    || args.iter().any(|a| {
                        // `Name:value` is a header; `name==value` a query.
                        let header = a.contains(':') && !a.contains("://") && !a.contains(":=");
                        (header && header_carries_secret(a, secrets))
                            || a.split_once("==").is_some_and(|(n, v)| {
                                secret_name(n) && !v.is_empty() || holds_secret(v, secrets)
                            })
                            || a.starts_with("--auth")
                            || *a == "-a"
                    }))
        }
        "gh" if args.first() == Some(&"api") => {
            let mut it = args[1..].iter().copied();
            while let Some(a) = it.next() {
                let (flag, inline) = match a.split_once('=') {
                    Some((f, v)) if a.starts_with("--") => (f, Some(v)),
                    _ => (a, None),
                };
                match flag {
                    "-H" | "--header" => {
                        let v = inline.or_else(|| it.next()).unwrap_or("");
                        if header_carries_secret(v, secrets) {
                            return true;
                        }
                    }
                    "-f" | "-F" | "--field" | "--raw-field" => {
                        let v = inline.or_else(|| it.next()).unwrap_or("");
                        let (name, value) = v.split_once('=').unwrap_or((v, ""));
                        if (secret_name(name) && !value.is_empty()) || holds_secret(value, secrets)
                        {
                            return true;
                        }
                    }
                    f if f.starts_with('-') => {}
                    endpoint => {
                        let url = if endpoint.contains("://") {
                            endpoint.to_string()
                        } else {
                            format!("https://api.invalid/{}", endpoint.trim_start_matches('/'))
                        };
                        if carries_secret(&url, secrets) {
                            return true;
                        }
                    }
                }
            }
            false
        }
        // A token in a remote's address (`git clone https://x:tok@…`).
        "git" => off_mac() && url_leaks(),
        _ => false,
    }
}

/// Whether a command line writes to the network somewhere other than this
/// Mac: a `curl` / `wget` / `http` write, a `gh` write, `git push`, or a
/// tool that exists to move data (`ssh`, `scp`, `rsync host:…`, `nc`…).
/// Asked for after outside content (`exposure`); here-document bodies stay
/// data, and requests to this Mac don't count.
pub fn sends_off_mac(command: &str, ctx: &Ctx) -> bool {
    commands(command).iter().any(|words| {
        let words: Vec<&str> = words.iter().map(String::as_str).collect();
        let rest = unwrapped(&words);
        let Some((&prog, args)) = rest.split_first() else {
            return false;
        };
        let pos = positional(args);
        let remote = |a: &&str| !local_host(a);
        match base(prog) {
            p @ ("curl" | "wget" | "http" | "https" | "xh" | "xhs") => {
                program(p, args, ctx, false, false)
            }
            "git" => git(args),
            "gh" => gh(args),
            "ssh" | "sftp" | "telnet" | "ftp" | "nc" | "ncat" | "netcat" | "socat" => {
                pos.first().is_some_and(remote)
            }
            "scp" | "rsync" => pos.iter().any(|a| {
                a.starts_with("rsync://")
                    || a.split_once(':').is_some_and(|(host, _)| {
                        !host.is_empty() && !host.contains('/') && !local_host(host)
                    })
            }),
            _ => false,
        }
    })
}

/// [`sends_off_mac`] at "Full send": only the tools that move raw data to
/// another host (`curl` and friends with a body, `ssh`, `scp`, `rsync`,
/// `nc`…). Pushing a branch and `gh` writes follow the "Full send" floor
/// instead, so reading a search result doesn't put a card back on every
/// pull request.
pub fn moves_data_off_mac(command: &str, ctx: &Ctx) -> bool {
    // Judged as a write, not by "Full send"'s own rule for the program.
    let ctx = &Ctx {
        full_send: false,
        ..ctx.clone()
    };
    commands(command).iter().any(|words| {
        let words: Vec<&str> = words.iter().map(String::as_str).collect();
        let rest = unwrapped(&words);
        rest.first()
            .is_some_and(|p| !matches!(base(p), "git" | "gh"))
            && sends_off_mac(&words.join(" "), ctx)
    })
}

/// The command a line of words runs, past leading assignments, shell
/// keywords and wrappers (`env`, `eval`, `xargs`, `timeout`…).
fn unwrapped<'a, 'b>(mut rest: &'a [&'b str]) -> &'a [&'b str] {
    loop {
        match rest.first() {
            Some(w) if is_assignment(w) || KEYWORDS.contains(w) => rest = &rest[1..],
            Some(w) if WRAPPERS.contains(&base(w)) => {
                rest = &rest[1..];
                while rest
                    .first()
                    .is_some_and(|w| w.starts_with('-') || is_assignment(w))
                {
                    rest = &rest[1..];
                }
            }
            Some(w) if base(w) == "timeout" || base(w) == "gtimeout" => {
                rest = &rest[1..];
                while rest.first().is_some_and(|w| w.starts_with('-')) {
                    rest = &rest[1..];
                }
                rest = rest.get(1..).unwrap_or(&[]);
            }
            Some(w) if base(w) == "xargs" => {
                rest = &rest[1..];
                while rest.first().is_some_and(|w| w.starts_with('-')) {
                    let takes = matches!(
                        *rest.first().unwrap(),
                        "-I" | "-n" | "-P" | "-L" | "-d" | "-s"
                    );
                    rest = rest.get(if takes { 2 } else { 1 }..).unwrap_or(&[]);
                }
            }
            _ => break,
        }
    }
    rest
}

/// Chat and messaging CLIs: each sends as the user.
const MESSENGERS: &[&str] = &[
    "mail",
    "mailx",
    "sendmail",
    "mutt",
    "msmtp",
    "neomutt",
    "swaks",
    "slack",
    "slack-cli",
    "slackcat",
    "discord",
    "discordcat",
    "telegram-send",
    "telegram-cli",
    "tg",
    "signal-cli",
    "twilio",
    "imessage",
    "wacli",
];

/// A chat or messaging CLI ([`MESSENGERS`]).
pub fn is_messenger(prog: &str) -> bool {
    MESSENGERS.contains(&prog)
}

/// Disk and system tools: each changes the Mac itself.
const SYSTEM_TOOLS: &[&str] = &[
    "diskutil",
    "dd",
    "launchctl",
    "csrutil",
    "nvram",
    "pmset",
    "systemsetup",
    "spctl",
    "fdesetup",
    "kextload",
    "kextunload",
    "mkfs",
    "newfs_apfs",
    "newfs_hfs",
    "shutdown",
    "reboot",
    "halt",
    "crontab",
    "security",
    "dscl",
    "networksetup",
    "scutil",
    "tccutil",
    "softwareupdate",
    "asr",
    "bless",
    "sudo",
    "su",
    "doas",
    "visudo",
    "passwd",
    "chsh",
];

/// Programs that write to their arguments.
const WRITERS: &[&str] = &[
    "cp",
    "mv",
    "ln",
    "tee",
    "rm",
    "rmdir",
    "chmod",
    "chown",
    "chflags",
    "touch",
    "install",
    "rsync",
    "truncate",
    "unlink",
    "mkdir",
    "ditto",
    "sed",
    "perl",
    "xattr",
    "ssh-keygen",
    "ssh-add",
    "ssh-copy-id",
];

/// The file arguments of a program that writes them. For `sed` and `perl`
/// the script (`-e …`, or `sed`'s first word without one) and the backup
/// suffix of `-i` are not files; for the rest, every argument that isn't a
/// flag.
fn edit_targets<'a>(prog: &str, args: &[&'a str]) -> Vec<&'a str> {
    if !matches!(prog, "sed" | "perl") {
        return positional(args);
    }
    let mut out = Vec::new();
    let mut script = false;
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        if matches!(a, "-e" | "-E" | "--expression" | "-f" | "--file")
            && !(prog == "sed" && a == "-E")
        {
            script = true;
            i += 2;
            continue;
        }
        if a.starts_with("--expression=") || a.starts_with("--file=") {
            script = true;
        } else if prog == "perl" && a.starts_with('-') && !a.starts_with("--") && a.ends_with('e') {
            // `-pie 's/a/b/'`, `-pi -e`: the code follows.
            script = true;
            i += 2;
            continue;
        } else if a == "-i" && prog == "sed" {
            // macOS `sed -i '' …` or `-i .bak`: the suffix isn't a file.
            if args
                .get(i + 1)
                .is_some_and(|n| n.is_empty() || (n.starts_with('.') && !n.contains('/')))
            {
                i += 2;
                continue;
            }
        } else if !a.starts_with('-') {
            if !script && (prog == "sed" || out.is_empty() && prog == "perl") {
                // The script itself (or perl's script file, which it reads).
                script = true;
            } else {
                out.push(a);
            }
        }
        i += 1;
    }
    out
}

fn has(args: &[&str], any: &[&str]) -> bool {
    args.iter().any(|a| any.contains(a))
}

/// Positional arguments (not flags).
fn positional<'a>(args: &[&'a str]) -> Vec<&'a str> {
    args.iter()
        .copied()
        .filter(|a| !a.starts_with('-'))
        .collect()
}

fn program(prog: &str, args: &[&str], ctx: &Ctx, outside: bool, known: bool) -> bool {
    if SYSTEM_TOOLS.contains(&prog) {
        // `crontab -l` only lists.
        return !(prog == "crontab" && args == ["-l"]);
    }
    // Sending as the user is what "Full send" lets through.
    if MESSENGERS.contains(&prog) {
        return !ctx.full_send;
    }
    let edits_in_place = !matches!(prog, "sed" | "perl")
        || args
            .iter()
            .any(|a| a.starts_with("-i") || a.starts_with("-pi"));
    // What it writes: its file arguments (a `sed` or `perl` script such as
    // `/^import/d` is not a file outside the home).
    let targets = edit_targets(prog, args);
    if WRITERS.contains(&prog)
        && edits_in_place
        && targets
            .iter()
            .any(|a| resolve_known(a, ctx, known).is_some_and(|p| protected(&p, ctx)))
    {
        // Copying *from* the Mac's own files into the home is fine; only a
        // protected destination or a credential source asks.
        let dest_or_secret = targets.iter().enumerate().any(|(n, a)| {
            resolve_known(a, ctx, known).is_some_and(|p| {
                secret_to_read(&p, ctx)
                    || (protected(&p, ctx)
                        && (n + 1 == targets.len()
                            || !matches!(prog, "cp" | "rsync" | "ditto" | "ln" | "install")))
            })
        });
        if dest_or_secret {
            return true;
        }
    }
    if ctx.full_send {
        if let Some(asks) = full_send_program(prog, args, ctx) {
            return asks;
        }
    }
    match prog {
        "git" => git(args),
        "gh" => gh(args),
        "npm" | "pnpm" | "yarn" | "bun" => {
            has(
                args,
                &["publish", "unpublish", "deprecate", "dist-tag", "owner"],
            ) || (outside && installs_package(prog, args))
        }
        "npx" | "pnpx" | "bunx" | "uvx" => {
            let pos = positional(args);
            if outside && !pos.is_empty() {
                return true;
            }
            let rest: Vec<&str> = args
                .iter()
                .copied()
                .skip_while(|a| a.starts_with('-'))
                .collect();
            match rest.split_first() {
                Some((p, a)) => program(
                    base(p.split('@').next().unwrap_or(p)),
                    a,
                    ctx,
                    outside,
                    known,
                ),
                None => false,
            }
        }
        "pip" | "pip3" | "pipx" | "brew" | "cargo" | "gem" | "go" | "uv" => {
            outside && has(args, &["install", "run", "add"])
        }
        "vercel" => {
            let pos = positional(args);
            const READS: &[&str] = &[
                "ls", "list", "inspect", "logs", "whoami", "env", "link", "dev", "build", "pull",
                "help", "project", "projects", "domains", "login", "switch", "teams", "certs",
                "dns", "git", "init", "bisect",
            ];
            has(args, &["--prod", "--production"])
                || (args
                    .iter()
                    .all(|a| !matches!(*a, "--version" | "-v" | "--help" | "-h"))
                    && pos.first().is_none_or(|s| !READS.contains(s)))
                || (pos.first() == Some(&"env") && has(&pos, &["add", "rm", "remove"]))
        }
        "netlify" | "ntl" => {
            has(args, &["deploy"]) && has(args, &["--prod", "--prod-if-unlocked", "-p"])
        }
        "fly" | "flyctl" => has(args, &["deploy", "destroy"]),
        "firebase" => args
            .iter()
            .any(|a| a.starts_with("deploy") || a.contains(":deploy")),
        "wrangler" => has(args, &["deploy", "publish"]),
        "heroku" | "railway" | "render" | "surge" | "amplify" => {
            has(args, &["deploy", "up", "release", "publish", "promote"])
        }
        "stripe" => {
            let live = args
                .iter()
                .any(|a| a.starts_with("--live") || a.contains("sk_live"));
            live && !has(
                args,
                &["list", "retrieve", "get", "logs", "listen", "--help"],
            )
        }
        "osascript" => {
            let text = args.join(" ").to_ascii_lowercase();
            !ctx.full_send && OSASCRIPT_SENDS.iter().any(|w| text.contains(w))
        }
        "curl" => curl(args, outside),
        "wget" => {
            let writes = args.iter().any(|a| {
                a.starts_with("--post-data")
                    || a.starts_with("--post-file")
                    || a.starts_with("--body-data")
                    || a.starts_with("--body-file")
                    || a.to_ascii_uppercase().starts_with("--METHOD=")
                        && !a.to_ascii_uppercase().ends_with("=GET")
                        && !a.to_ascii_uppercase().ends_with("=HEAD")
            });
            writes && (outside || !all_local(args))
        }
        "http" | "https" | "xh" | "xhs" => {
            let pos = positional(args);
            let method_write = pos.first().is_some_and(|m| {
                matches!(
                    m.to_ascii_uppercase().as_str(),
                    "POST" | "PUT" | "PATCH" | "DELETE"
                )
            });
            let body = pos
                .iter()
                .skip(1)
                .any(|a| a.contains('=') || a.contains(":="))
                || has(args, &["-f", "--form"]);
            let local = pos.iter().any(|a| a.starts_with(':') || local_host(a));
            (method_write || body) && (outside || !local)
        }
        "rm" => {
            let recursive = args.iter().any(|a| {
                *a == "--recursive"
                    || (a.starts_with('-')
                        && !a.starts_with("--")
                        && (a.contains('r') || a.contains('R')))
            });
            recursive
                && positional(args).iter().any(|a| {
                    let prefix: String = a.split(['*', '?', '[']).next().unwrap_or("").into();
                    match resolve(if prefix.is_empty() { "." } else { &prefix }, ctx) {
                        Some(p) => !deletable(&p, ctx),
                        None => true,
                    }
                })
        }
        "defaults" => {
            let pos = positional(args);
            // Any app's settings, not only the system's: always a card.
            matches!(
                pos.first(),
                Some(&"write") | Some(&"delete") | Some(&"import") | Some(&"rename")
            )
        }
        "bash" | "sh" | "zsh" | "eval" | "ssh" => false, // their quoted text is split above
        _ => false,
    }
}

fn installs_package(_prog: &str, args: &[&str]) -> bool {
    let pos = positional(args);
    let Some((sub, rest)) = pos.split_first() else {
        return false;
    };
    match *sub {
        "install" | "i" | "add" => !rest.is_empty(),
        "dlx" | "x" => true,
        _ => false,
    }
}

fn git(args: &[&str]) -> bool {
    // Skip global options to find the subcommand.
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        if matches!(a, "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace") {
            i += 2;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            break;
        }
    }
    matches!(args.get(i), Some(&"push") | Some(&"send-email"))
}

fn gh(args: &[&str]) -> bool {
    let pos = positional(args);
    let (Some(group), action) = (pos.first().copied(), pos.get(1).copied()) else {
        return false;
    };
    let action = action.unwrap_or("");
    match group {
        "pr" => matches!(
            action,
            "create"
                | "merge"
                | "review"
                | "comment"
                | "close"
                | "edit"
                | "ready"
                | "reopen"
                | "lock"
                | "unlock"
        ),
        "issue" => matches!(
            action,
            "create"
                | "comment"
                | "close"
                | "edit"
                | "reopen"
                | "delete"
                | "transfer"
                | "lock"
                | "pin"
        ),
        "release" => matches!(
            action,
            "create" | "delete" | "edit" | "upload" | "delete-asset"
        ),
        "repo" => matches!(
            action,
            "create"
                | "delete"
                | "edit"
                | "rename"
                | "archive"
                | "unarchive"
                | "fork"
                | "deploy-key"
        ),
        "gist" => matches!(action, "create" | "edit" | "delete"),
        // Prints the user's GitHub token.
        "auth" => action == "token",
        "workflow" => matches!(action, "run" | "enable" | "disable"),
        "run" => matches!(action, "rerun" | "cancel" | "delete"),
        "secret" | "variable" | "label" | "ruleset" | "cache" => {
            matches!(action, "set" | "delete" | "create" | "edit" | "clone")
        }
        "api" => {
            let mut i = 0;
            let mut write = false;
            while i < args.len() {
                let a = args[i];
                let method = if a == "-X" || a == "--method" {
                    args.get(i + 1).copied()
                } else {
                    a.strip_prefix("-X").or_else(|| a.strip_prefix("--method="))
                };
                if let Some(m) = method.filter(|m| !m.is_empty()) {
                    write |= !matches!(m.to_ascii_uppercase().as_str(), "GET" | "HEAD");
                }
                if matches!(a, "-f" | "-F" | "--field" | "--raw-field" | "--input")
                    || a.starts_with("--field=")
                    || a.starts_with("--raw-field=")
                {
                    write = true;
                }
                i += 1;
            }
            // `gh api … -X GET -f q=…` reads.
            let get = args
                .windows(2)
                .any(|w| (w[0] == "-X" || w[0] == "--method") && w[1].eq_ignore_ascii_case("GET"))
                || args.iter().any(|a| {
                    a.eq_ignore_ascii_case("-XGET") || a.eq_ignore_ascii_case("--method=GET")
                });
            write && !get
        }
        _ => false,
    }
}

fn local_host(arg: &str) -> bool {
    let rest = arg.split_once("://").map(|(_, r)| r).unwrap_or(arg);
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let host = if let Some(v6) = rest.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        rest.split(['/', ':', '?', '#']).next().unwrap_or("")
    };
    let host = host.to_ascii_lowercase();
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || host.ends_with(".localhost")
        || host.starts_with("127.")
}

/// Every URL-looking argument names this Mac (and there is at least one).
fn all_local(args: &[&str]) -> bool {
    let urls: Vec<&str> = args
        .iter()
        .copied()
        .filter(|a| {
            !a.starts_with('-')
                && (a.contains("://")
                    || local_host(a)
                    || a.contains('.') && !a.starts_with('/') && !a.starts_with('@'))
        })
        .collect();
    let named: Vec<&str> = urls
        .iter()
        .copied()
        .filter(|a| a.contains("://") || local_host(a))
        .collect();
    !named.is_empty()
        && named.iter().all(|a| local_host(a))
        && urls.iter().all(|a| named.contains(a) || !a.contains("://"))
}

fn curl(args: &[&str], outside: bool) -> bool {
    let mut write = false;
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        if a == "-X" || a == "--request" {
            if let Some(m) = args.get(i + 1) {
                write |= !matches!(m.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS");
            }
            i += 2;
            continue;
        }
        if let Some(m) = a.strip_prefix("--request=") {
            write |= !matches!(m.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS");
        } else if a.starts_with("--data")
            || a.starts_with("--form")
            || a.starts_with("--json")
            || a.starts_with("--upload-file")
            || a == "-T"
        {
            write = true;
        } else if a.starts_with('-') && !a.starts_with("--") {
            let flags = &a[1..];
            if let Some(pos) = flags.find('X') {
                let m = &flags[pos + 1..];
                let m = if m.is_empty() {
                    args.get(i + 1).copied().unwrap_or("")
                } else {
                    m
                };
                write |= !matches!(m.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS");
            }
            // Short flags that take a value end the cluster; d, F, T send a body.
            for ch in flags.chars() {
                if matches!(ch, 'd' | 'F' | 'T') {
                    write = true;
                    break;
                }
                if matches!(
                    ch,
                    'o' | 'w'
                        | 'H'
                        | 'u'
                        | 'A'
                        | 'e'
                        | 'b'
                        | 'c'
                        | 'K'
                        | 'x'
                        | 'm'
                        | 'X'
                        | 'r'
                        | 'C'
                        | 'E'
                        | 'U'
                        | 'Y'
                        | 'y'
                        | 'z'
                ) {
                    break;
                }
            }
        }
        i += 1;
    }
    write && (outside || !all_local(args))
}

/* ------------------------------------------------------------ Full send */

/// Branches a push to which still asks at "Full send": the default branch
/// and the ones that usually deploy.
const PROTECTED_BRANCHES: &[&str] = &[
    "main",
    "master",
    "production",
    "prod",
    "live",
    "release",
    "stable",
    "trunk",
    "gh-pages",
];

/// Payment APIs: a write to one spends (or moves) the user's money.
const PAY_API_HOSTS: &[&str] = &[
    "api.stripe.com",
    "api.paypal.com",
    "api-m.paypal.com",
    "connect.squareup.com",
    "api.squareup.com",
    "api.braintreegateway.com",
    "api.adyen.com",
    "api.checkout.com",
    "api.coinbase.com",
    "api.wise.com",
    "api.transferwise.com",
    "api.mollie.com",
    "api.razorpay.com",
    "api.lemonsqueezy.com",
    "api.paddle.com",
];

/// The "Full send" answer for the programs whose rule it changes: `None`
/// means "Go hard"'s rule (the floor's own items: system tools, `sudo`,
/// credential stores, `rm -r` outside the deletable folders, deploys to
/// production, Stripe live and package publishing are checked as at "Go
/// hard"). Sending as the user runs: mail and chat CLIs, `git send-email`,
/// `gh` comments, issues and pull requests, network writes, preview deploys.
fn full_send_program(prog: &str, args: &[&str], ctx: &Ctx) -> Option<bool> {
    Some(match prog {
        "git" => git_full_send(args, ctx),
        "gh" => gh_full_send(args),
        "curl" | "wget" | "http" | "https" | "xh" | "xhs" => {
            // A write to a payment API spends; any other write sends.
            let go_hard = Ctx {
                full_send: false,
                ..ctx.clone()
            };
            program(prog, args, &go_hard, false, true) && args.iter().any(|a| pay_api(a))
        }
        "vercel" => {
            let pos = positional(args);
            const ASKS: &[&str] = &[
                "promote", "alias", "rollback", "remove", "rm", "redeploy", "secrets", "secret",
            ];
            has(args, &["--prod", "--production", "--target=production"])
                || args
                    .windows(2)
                    .any(|w| w[0] == "--target" && w[1] == "production")
                || pos.first().is_some_and(|s| ASKS.contains(s))
                || (pos
                    .first()
                    .is_some_and(|s| matches!(*s, "env" | "domains" | "dns" | "certs"))
                    && has(&pos, &["add", "rm", "remove"]))
        }
        _ => return None,
    })
}

/// A web address (or bare host) on a payment API.
fn pay_api(arg: &str) -> bool {
    let rest = arg.split_once("://").map(|(_, r)| r).unwrap_or(arg);
    let host = rest
        .split(['/', ':', '?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    PAY_API_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// `git` at "Full send": a push asks only when it goes to a protected
/// branch (or one it can't tell), forces, deletes a remote branch, mirrors
/// or pushes tags. Everything else in `git` runs, `send-email` included.
fn git_full_send(args: &[&str], ctx: &Ctx) -> bool {
    let mut i = 0;
    let mut dir: Option<PathBuf> = None;
    while i < args.len() {
        let a = args[i];
        if a == "-C" {
            dir = args.get(i + 1).and_then(|d| resolve(d, ctx));
            i += 2;
        } else if matches!(a, "-c" | "--git-dir" | "--work-tree" | "--namespace") {
            i += 2;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            break;
        }
    }
    if args.get(i) != Some(&"push") {
        return false;
    }
    let rest = &args[i + 1..];
    let cwd = dir.unwrap_or_else(|| ctx.cwd.clone());
    // Forcing, deleting, mirroring or tagging can't be taken back.
    const ASKS: &[&str] = &[
        "-f",
        "-d",
        "--mirror",
        "--all",
        "--branches",
        "--prune",
        "--tags",
        "--follow-tags",
    ];
    if rest.iter().any(|a| {
        ASKS.contains(a)
            || a.starts_with("--force")
            || a.starts_with("--delete")
            || (a.starts_with('-') && !a.starts_with("--") && (a.contains('f') || a.contains('d')))
    }) {
        return true;
    }
    // Flags that take a value: their value isn't a refspec.
    const TAKES: &[&str] = &["-o", "--push-option", "--repo", "--receive-pack", "--exec"];
    let mut pos = Vec::new();
    let mut j = 0;
    while j < rest.len() {
        let a = rest[j];
        if TAKES.contains(&a) {
            j += 2;
            continue;
        }
        if !a.starts_with('-') {
            pos.push(a);
        }
        j += 1;
    }
    let on_protected = || current_branch(&cwd).is_none_or(|b| protected_branch(&b));
    let refspecs: Vec<&str> = pos.iter().skip(1).copied().collect();
    if refspecs.is_empty() {
        // `git push` / `git push origin`: the branch it's on, read from the
        // working copy; unknown asks.
        return on_protected();
    }
    refspecs.iter().any(|r| {
        if r.starts_with('+') || r.starts_with(':') {
            return true;
        }
        let dest = r.rsplit_once(':').map(|(_, d)| d).unwrap_or(r);
        if dest == "HEAD" || dest == "@" {
            return on_protected();
        }
        // A tag releases; a pattern or a variable can't be told.
        dest.contains('*')
            || dest.contains('$')
            || dest.starts_with("refs/tags/")
            || protected_branch(dest)
    })
}

/// `refs/heads/main` or `main`: a protected branch.
fn protected_branch(name: &str) -> bool {
    let name = name.trim();
    let name = name.strip_prefix("refs/heads/").unwrap_or(name);
    PROTECTED_BRANCHES.contains(&name)
}

/// The branch the working copy at `cwd` is on (`.git/HEAD`, following a
/// worktree's `gitdir:`), when it's on one. The remote's default branch
/// (`refs/remotes/origin/HEAD`) reads as `main`, whatever it's called.
fn current_branch(cwd: &Path) -> Option<String> {
    let repo = repo_of(cwd)?;
    let dot = repo.join(".git");
    let gitdir = if dot.is_file() {
        let text = std::fs::read_to_string(&dot).ok()?;
        let p = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
        if p.is_absolute() {
            p
        } else {
            repo.join(p)
        }
    } else {
        dot
    };
    let head = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let branch = head.trim().strip_prefix("ref: refs/heads/")?.to_string();
    // A worktree's common folder holds the remotes.
    let common = std::fs::read_to_string(gitdir.join("commondir"))
        .ok()
        .map(|c| {
            let p = PathBuf::from(c.trim());
            if p.is_absolute() {
                p
            } else {
                gitdir.join(p)
            }
        })
        .unwrap_or_else(|| gitdir.clone());
    if let Ok(default) = std::fs::read_to_string(common.join("refs/remotes/origin/HEAD")) {
        if default.trim().strip_prefix("ref: refs/remotes/origin/") == Some(branch.as_str()) {
            return Some("main".into());
        }
    }
    Some(branch)
}

/// `gh` at "Full send": issues, pull requests, comments, reviews, gists
/// and repos it makes run. Merging, releases, deleting or transferring,
/// secrets and branch rules, starting workflows (they deploy) and the
/// user's keys and sign-in ask.
fn gh_full_send(args: &[&str]) -> bool {
    let pos = positional(args);
    let (Some(group), action) = (pos.first().copied(), pos.get(1).copied()) else {
        return false;
    };
    let action = action.unwrap_or("");
    match group {
        "pr" => action == "merge",
        "issue" => matches!(action, "delete" | "transfer"),
        "repo" => matches!(
            action,
            "delete" | "archive" | "rename" | "deploy-key" | "transfer"
        ),
        "gist" | "run" | "label" | "cache" => action == "delete",
        "release" | "workflow" | "secret" | "variable" | "ruleset" => gh(args),
        "auth" | "ssh-key" | "gpg-key" => action != "status",
        "api" => {
            if !gh(args) {
                return false;
            }
            let delete = args.windows(2).any(|w| {
                (w[0] == "-X" || w[0] == "--method") && w[1].eq_ignore_ascii_case("DELETE")
            }) || args.iter().any(|a| {
                a.eq_ignore_ascii_case("-XDELETE") || a.eq_ignore_ascii_case("--method=DELETE")
            });
            let path = pos.get(1).copied().unwrap_or("").to_ascii_lowercase();
            const ASKS: &[&str] = &[
                "/merge",
                "/merges",
                "secrets",
                "keys",
                "/releases",
                "/git/refs",
                "protection",
                "rulesets",
                "/collaborators",
                "/transfer",
                "/dispatches",
                "/deployments",
            ];
            delete || ASKS.iter().any(|w| path.contains(w))
        }
        _ => false,
    }
}

/// A connector at "Full send": sending, posting, publishing, scheduling and
/// changing records run; spending money, deleting, deploying, merging and
/// anything about keys or the account ask.
fn connector_floor(tool: &str) -> bool {
    let words = tool_words(tool);
    // Credentials ask even to read ("get_password", "reveal_secret").
    const SECRETS: &[&str] = &[
        "password",
        "passwords",
        "credential",
        "credentials",
        "secret",
        "secrets",
        "token",
        "tokens",
        "keychain",
        "vault",
    ];
    if words.iter().any(|w| SECRETS.contains(&w.as_str())) {
        return true;
    }
    const READS: &[&str] = &[
        "get", "list", "search", "fetch", "read", "find", "query", "view", "count",
    ];
    if words.first().is_some_and(|w| READS.contains(&w.as_str())) {
        return false;
    }
    const FLOOR: &[&str] = &[
        "charge",
        "refund",
        "pay",
        "payment",
        "payout",
        "transfer",
        "purchase",
        "buy",
        "order",
        "checkout",
        "subscribe",
        "subscription",
        "invoice",
        "book",
        "donate",
        "withdraw",
        "delete",
        "remove",
        "trash",
        "destroy",
        "purge",
        "erase",
        "wipe",
        "deploy",
        "merge",
        "password",
        "credential",
        "credentials",
        "secret",
        "token",
        "key",
        "keys",
        "account",
        "billing",
        "cancel",
        "revoke",
    ];
    words.iter().any(|w| FLOOR.contains(&w.as_str()))
}

/* ------------------------------------------------------------ browser scripts */

/// A `javascript_tool` script that would submit, post or send: a form
/// submit, a fetch / XHR / beacon / jQuery / axios write, a form's action
/// changed, or a click (or Enter) where a string in the script names a
/// control that sends (`browser_gate::sends`, `type=submit`). Anything else
/// reads or clicks around, and runs at "Go hard".
pub fn script_sends(input: &Value, level: super::independence::Level) -> bool {
    use super::independence::Level;
    // "Full send": a script that posts or submits is the job; one that names
    // a control that spends money or closes the account still asks.
    if level == Level::FullSend {
        let code: String = ["text", "code", "script", "expression"]
            .iter()
            .filter_map(|k| input.get(*k).and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        return string_literals(&code).iter().any(|l| {
            let spaced: String = l
                .to_ascii_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
                .collect();
            super::browser_gate::floor_control(&spaced).is_some()
                || super::browser_gate::password_field(&spaced)
        });
    }
    let code: String = ["text", "code", "script", "expression"]
        .iter()
        .filter_map(|k| input.get(*k).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let compact: String = code
        .to_ascii_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    const SUBMITS: &[&str] = &[
        "submit(",
        "requestsubmit",
        "sendbeacon",
        ".action=",
        "$.post(",
        "$.ajax(",
        "axios.post",
        "axios.put",
        "axios.patch",
        "axios.delete",
        "axios(",
    ];
    if SUBMITS.iter().any(|m| compact.contains(m)) {
        return true;
    }
    let write_method = ["post", "put", "patch", "delete"].iter().any(|m| {
        ['\'', '"', '`'].iter().any(|q| {
            compact.contains(&format!("method:{q}{m}{q}"))
                || compact.contains(&format!("open({q}{m}{q}"))
        })
    });
    if compact.contains("fetch(") && (write_method || compact.contains("body:")) {
        return true;
    }
    if compact.contains("xmlhttprequest")
        && (write_method || (compact.contains(".send(") && !compact.contains(".send()")))
    {
        return true;
    }
    let keys = compact.contains("keyboardevent(");
    let clicks = compact.contains(".click(")
        || compact.contains("dispatchevent(")
        || compact.contains("mouseevent(");
    if !clicks && !keys {
        return false;
    }
    string_literals(&code).iter().any(|l| {
        let l = l.to_ascii_lowercase();
        let spaced: String = l
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
            .collect();
        // Throwing away an unsaved edit is a step on the way (`browser_gate`).
        super::browser_gate::sends(&spaced.replace("discard", " ")).is_some()
            || spaced
                .split_whitespace()
                .collect::<Vec<_>>()
                .windows(2)
                .any(|w| w == ["type", "submit"])
            || (keys && matches!(l.trim(), "enter" | "return"))
    })
}

/// The quoted strings in a script ('…', "…", `…`).
fn string_literals(code: &str) -> Vec<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, '\'' | '"' | '`') {
            let mut j = i + 1;
            let mut s = String::new();
            while j < chars.len() && chars[j] != c {
                if chars[j] == '\\' && j + 1 < chars.len() {
                    j += 1;
                }
                s.push(chars[j]);
                j += 1;
            }
            out.push(s);
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/* ------------------------------------------------------------ connectors */

/// The words of a connector tool's own name (camelCase and snake_case split).
fn tool_words(tool: &str) -> Vec<String> {
    let name = tool.rsplit("__").next().unwrap_or(tool);
    let mut spaced = String::new();
    for (n, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && n > 0 {
            spaced.push(' ');
        }
        spaced.push(c.to_ascii_lowercase());
    }
    spaced
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// A connector tool that asks at Go hard ([`connector_asks`]), or whose name
/// says it pays out, wipes, or touches credentials ([`floor`]).
fn remembered_floor(tool: &str) -> bool {
    const FLOOR: &[&str] = &[
        // Sending or posting as the user.
        "send",
        "reply",
        "forward",
        "post",
        "publish",
        "share",
        "invite",
        "submit",
        "comment",
        "react",
        "tweet",
        "dm",
        "broadcast",
        "notify",
        // Money.
        "charge",
        "refund",
        "pay",
        "payment",
        "payout",
        "transfer",
        "purchase",
        "buy",
        "checkout",
        "subscribe",
        // Pushing and deploying.
        "push",
        "deploy",
        "release",
        "merge",
        // Deleting.
        "delete",
        "remove",
        "trash",
        "destroy",
        "purge",
        "erase",
        "wipe",
        "unpublish",
        // Credentials.
        "credential",
        "credentials",
        "password",
        "passwords",
        "secret",
        "secrets",
        "token",
        "tokens",
        "key",
        "keys",
        "apikey",
        "auth",
        "oauth",
        "login",
        "sudo",
    ];
    connector_asks(tool, false) || tool_words(tool).iter().any(|w| FLOOR.contains(&w.as_str()))
}

/// At Go hard a connector asks only when its name says it sends or publishes as
/// the user, spends, deletes, or deploys. Creating and updating records in the
/// user's own tools (an upsert into their dashboard, a task, a page) just runs:
/// asking for those is the "asks for everything" the owner rejected. A turn
/// answering outside text still asks for any write.
fn connector_asks(tool: &str, outside: bool) -> bool {
    let words = tool_words(tool);
    let has = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
    const SENDS_SPENDS_DELETES: &[&str] = &[
        "send", "reply", "forward", "post", "publish", "share", "invite", "submit", "tweet",
        "comment", "react", "charge", "refund", "pay", "payment",
        "transfer", "purchase", "buy", "order", "book", "subscribe", "cancel", "delete",
        "remove", "trash", "destroy", "purge", "deploy", "merge", "approve",
        "push", "upload",
    ];
    // A read named after what it reads ("get_post", "list_comments") is a read.
    const READS: &[&str] = &[
        "get", "list", "search", "fetch", "read", "find", "query", "view", "count",
    ];
    if words.first().is_some_and(|w| READS.contains(&w.as_str())) {
        return false;
    }
    if has(SENDS_SPENDS_DELETES) {
        return true;
    }
    // A code host or a database: any write there is a push, a pull request,
    // a release or a statement against live data, which ask like `git push`
    // and `gh` writes do.
    if repo_or_database(tool) && (connector_writes(&words) || has(REPO_DB_WRITES)) {
        return true;
    }
    outside && connector_writes(&words)
}

/// Connector servers whose writes always ask at Go hard: code hosts and
/// databases. Matched within the server's name, so a claude.ai connector
/// (`mcp__claude_ai_GitHub__…`) counts too.
const REPO_DB_SERVERS: &[&str] = &[
    "github",
    "gitlab",
    "bitbucket",
    "supabase",
    "postgres",
    "neon",
    "planetscale",
    "mysql",
];

/// Words that write on a code host or a database beyond [`connector_writes`].
const REPO_DB_WRITES: &[&str] = &[
    "push",
    "pull",
    "release",
    "tag",
    "sql",
    "fork",
    "branch",
    "commit",
    "apply",
    "migration",
    "restore",
    "reset",
    "rollback",
    "drop",
    "truncate",
];

fn repo_or_database(tool: &str) -> bool {
    let server = tool.split("__").nth(1).unwrap_or("").to_ascii_lowercase();
    REPO_DB_SERVERS.iter().any(|s| server.contains(s))
}

/// A connector tool whose name says it writes anything at all.
fn connector_writes(words: &[String]) -> bool {
    const WRITES: &[&str] = &[
        "create", "update", "edit", "write", "archive", "move", "add", "set", "insert", "upload",
        "draft", "schedule", "assign", "close", "upsert", "patch", "put", "modify", "rename",
        "import", "execute", "run", "mutate", "complete",
    ];
    words.iter().any(|w| WRITES.contains(&w.as_str()))
}

#[cfg(test)]
#[path = "go_hard_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "go_hard_hardening_tests.rs"]
mod hardening_tests;

#[cfg(test)]
#[path = "full_send_tests.rs"]
mod full_send_tests;
