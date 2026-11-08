//! "Nothing goes out under my name unless I approve that exact text."
//!
//! A typed switch in each agent's policy (`policy::Effective::
//! outward_text_needs_ok`, the team's or its own), set from chat through the
//! Chief's `propose_settings_change` or on the desk, and turned on by itself
//! when a rule already says it (`policy::migrate_exact_text`). Before, the
//! owner's rule was only prompt text, "(an instruction, not enforced)".
//!
//! When it is on, any call that sends, posts, comments or emails under the
//! user's name ([`sends_as_user`]: the commands Go hard counts as sending,
//! a send click or Enter in the user's or the agents' browser, a connector
//! tool that sends or posts) runs only:
//!
//! - after a card that shows the exact text going out ([`card_block`]), or
//! - under an `ask_plan` grant whose listed action carries that exact text
//!   (`plan_grant`: what the call sends, title and body together, must be
//!   exactly the action's `text`, whitespace aside; [`approved_covers`]).
//!
//! At every level, "Full send" included: no independence level, no standing
//! "Always allow" rule and no plan without the words answers it
//! (`mcp::decide_inner`, `browser_gate::gate`, `mcp::sweep_auto_allowed`).
//! The text is read from the call itself ([`texts`]): a command's message,
//! title and body flags, here-documents and body files it names; a
//! connector's text fields; what was typed on the page before a send click.
//! When it can't be read the card says so, and a plan can't cover it.

use serde_json::Value;
use std::path::Path;

use super::autoallow::Ctx;
use super::go_hard;

/// Hosts where a web request that writes is a message under the user's
/// name (chat, mail and social APIs, webhooks into a channel).
const MESSAGE_HOSTS: &[&str] = &[
    "slack.com",
    "discord.com",
    "discordapp.com",
    "api.telegram.org",
    "graph.facebook.com",
    "api.twitter.com",
    "api.x.com",
    "api.linkedin.com",
    "gmail.googleapis.com",
    "graph.microsoft.com",
    "api.sendgrid.com",
    "api.mailgun.net",
    "api.postmarkapp.com",
    "api.resend.com",
    "api.twilio.com",
    "bsky.social",
    "api.bsky.app",
    "api.threads.net",
    "api.buffer.com",
    "api.mailchimp.com",
    "webhook.office.com",
    "chat.googleapis.com",
];

/// Whether `agent`'s policy holds sends for the exact text's OK.
pub fn required(agent: &super::store::Agent) -> bool {
    super::policy::effective(agent).outward_text_needs_ok
}

/// Whether this call sends, posts, comments or emails under the user's name.
pub fn sends_as_user(agent: &super::store::Agent, tool: &str, input: &Value) -> bool {
    match tool {
        "Bash" => command_sends(input.get("command").and_then(Value::as_str).unwrap_or("")),
        t if t.starts_with(super::browser_gate::SERVER)
            || t.starts_with(super::browser_gate::AGENTS_SERVER) =>
        {
            super::browser_gate::outward_step(agent, t, input)
        }
        t if t.starts_with("mcp__") => connector_sends(t),
        _ => false,
    }
}

/// The words of a command, wrappers and `npx` taken off.
fn program<'a, 'b>(words: &'a [&'b str]) -> &'a [&'b str] {
    let rest = go_hard::unwrapped(words);
    match rest.first().map(|p| go_hard::base(p)) {
        Some("npx" | "pnpx" | "bunx") => {
            let mut r = &rest[1..];
            while r.first().is_some_and(|w| w.starts_with('-')) {
                r = &r[1..];
            }
            r
        }
        _ => rest,
    }
}

/// A command line that sends as the user: chat and mail CLIs, an
/// AppleScript that sends, `git send-email`, `gh` issues, pull requests,
/// comments, reviews, releases and gists, a `gh api` write to those, and a
/// web request that writes to a chat, mail or social API.
pub fn command_sends(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.contains("osascript") && go_hard::OSASCRIPT_SENDS.iter().any(|w| lower.contains(w)) {
        return true;
    }
    go_hard::commands(command).iter().any(|w| words_send(w))
}

/// One command (its words) that sends as the user.
pub fn words_send(words: &[String]) -> bool {
    let w: Vec<&str> = words.iter().map(String::as_str).collect();
    let rest = program(&w);
    let Some((prog, args)) = rest.split_first() else {
        return false;
    };
    let prog = go_hard::base(prog);
    if go_hard::is_messenger(prog) {
        return true;
    }
    let pos = go_hard::positional(args);
    match prog {
        "git" => {
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
            args.get(i) == Some(&"send-email")
        }
        "gh" => {
            let group = pos.first().copied().unwrap_or("");
            let action = pos.get(1).copied().unwrap_or("");
            match group {
                "pr" => matches!(action, "create" | "comment" | "review" | "edit"),
                "issue" => matches!(action, "create" | "comment" | "edit"),
                "release" => matches!(action, "create" | "edit"),
                "gist" => matches!(action, "create" | "edit"),
                "discussion" => matches!(action, "create" | "comment"),
                "api" => {
                    let path = go_hard::gh_api_path(args).to_ascii_lowercase();
                    // A read (`-X GET -f q=…`, a GraphQL query) sends
                    // nothing, whatever it reads: `gh api -X GET
                    // search/issues -f q=…` was held for "exact text".
                    // Deleting carries no words of the user's.
                    let deletes = args.windows(2).any(|p| {
                        matches!(p[0], "-X" | "--method") && p[1].eq_ignore_ascii_case("DELETE")
                    }) || args.iter().any(|a| {
                        a.eq_ignore_ascii_case("-XDELETE")
                            || a.eq_ignore_ascii_case("--method=DELETE")
                    });
                    go_hard::gh_writes(args)
                        && !deletes
                        && [
                            "comments",
                            "issues",
                            "pulls",
                            "reviews",
                            "discussions",
                            "releases",
                            "gists",
                        ]
                        .iter()
                        .any(|s| path.contains(s))
                }
                _ => false,
            }
        }
        "curl" | "wget" | "http" | "https" | "xh" | "xhs" => {
            let to_messages = args.iter().any(|a| {
                super::browser_gate::host_of(a).is_some_and(|h| {
                    let h = h.to_ascii_lowercase();
                    MESSAGE_HOSTS
                        .iter()
                        .any(|m| h == *m || h.ends_with(&format!(".{m}")))
                })
            });
            to_messages && go_hard::web_write(prog, args)
        }
        _ => false,
    }
}

/// A connector tool that sends, posts, replies, comments or publishes under
/// the user's name. Drafts and reads don't; the app's own tools and the
/// browsers are judged elsewhere.
pub fn connector_sends(tool: &str) -> bool {
    let Some(rest) = tool.strip_prefix("mcp__") else {
        return false;
    };
    let server = rest.split("__").next().unwrap_or("");
    if server == super::prompts::SERVER_KEY
        || tool.starts_with(super::browser_gate::SERVER)
        || tool.starts_with(super::browser_gate::AGENTS_SERVER)
    {
        return false;
    }
    let words = go_hard::tool_words(tool);
    let has = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
    const READS: &[&str] = &[
        "get", "list", "search", "fetch", "read", "find", "query", "view", "count",
    ];
    if words.first().is_some_and(|w| READS.contains(&w.as_str())) || has(&["draft", "drafts"]) {
        return false;
    }
    has(&[
        "send",
        "post",
        "reply",
        "comment",
        "publish",
        "tweet",
        "retweet",
        "repost",
        "forward",
        "schedule",
        "broadcast",
        "announce",
        "dm",
    ]) || (has(&["create", "open", "add", "write"])
        && has(&[
            "message", "email", "mail", "issue", "pull", "pr", "review", "tweet", "status",
        ]))
}

/* ------------------------------------------------------------ the words */

/// What goes out, as far as the call says it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Texts {
    /// Each piece of text going out, word for word.
    pub pieces: Vec<String>,
    /// Files the text is read from that couldn't be read here.
    pub unread: Vec<String>,
}

impl Texts {
    /// Every piece is known: nothing is read from a file the app couldn't
    /// open, and there is something to show.
    pub fn complete(&self) -> bool {
        !self.pieces.is_empty() && self.unread.is_empty()
    }
}

/// Whitespace collapsed, for comparing what was OK'd with what goes out.
pub fn norm(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

const MAX_FILE: u64 = 64 * 1024;

fn push(out: &mut Texts, text: &str) {
    let t = text.trim();
    if !t.is_empty() && !out.pieces.iter().any(|p| p == t) {
        out.pieces.push(t.to_string());
    }
}

fn read_file(out: &mut Texts, raw: &str, ctx: Option<&Ctx>) {
    let raw = raw.trim_start_matches('@');
    if raw == "-" || raw.is_empty() {
        return;
    }
    let path = match ctx {
        Some(c) => go_hard::resolve(raw, c),
        None => Some(Path::new(raw).to_path_buf()).filter(|p| p.is_absolute()),
    };
    let text = path.and_then(|p| {
        let meta = std::fs::metadata(&p).ok()?;
        (meta.is_file() && meta.len() <= MAX_FILE)
            .then(|| std::fs::read_to_string(&p).ok())
            .flatten()
    });
    match text {
        Some(t) => push(out, &t),
        None => out.unread.push(raw.to_string()),
    }
}

/// The text in a field of a JSON body or a `key=value` field that carries
/// words (`body=…`, `text=…`).
const TEXT_KEYS: &[&str] = &[
    "text",
    "message",
    "body",
    "content",
    "comment",
    "subject",
    "title",
    "caption",
    "status",
    "description",
    "markdown",
    "html",
    "post",
    "reply",
    "tweet",
    "note",
    "notes",
];

fn json_texts(out: &mut Texts, v: &Value, depth: u8) {
    match v {
        Value::Object(o) => {
            for (k, val) in o {
                let key = k.to_ascii_lowercase();
                match val {
                    Value::String(s) if TEXT_KEYS.contains(&key.as_str()) => push(out, s),
                    Value::Object(_) | Value::Array(_) if depth < 3 => {
                        json_texts(out, val, depth + 1)
                    }
                    _ => {}
                }
            }
        }
        Value::Array(a) if depth < 3 => a.iter().for_each(|x| json_texts(out, x, depth + 1)),
        _ => {}
    }
}

/// The bodies of a command line's here-documents.
fn heredoc_bodies(command: &str) -> Vec<String> {
    heredocs(command).into_iter().map(|(_, b)| b).collect()
}

/// Each here-document body, with the line its `<<` is on.
fn heredocs(command: &str) -> Vec<(usize, String)> {
    let lines: Vec<&str> = command.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let mut ends = Vec::new();
        let mut rest = line;
        while let Some(at) = rest.find("<<") {
            let after = &rest[at + 2..];
            if after.starts_with('<') {
                rest = &after[1..];
                continue;
            }
            let after = after.trim_start_matches('-').trim_start();
            let word: String = after
                .trim_start_matches(['\'', '"'])
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !word.is_empty() {
                ends.push(word);
            }
            rest = after;
        }
        let at = i;
        i += 1;
        for end in ends {
            let mut body = Vec::new();
            while i < lines.len() && lines[i].trim() != end {
                body.push(lines[i]);
                i += 1;
            }
            i += 1;
            out.push((at, body.join("\n")));
        }
    }
    out
}

/// Variables the command itself sets to plain words or a here-document
/// (`F="Shipped"`, `F=$(cat <<'EOF' … EOF)`), so `$F` can be shown as the
/// words it holds. A value built any other way (a command's output, another
/// variable) is not here: it can't be read without running it.
fn assigned_vars(command: &str) -> std::collections::HashMap<String, String> {
    let mut vars = std::collections::HashMap::new();
    let docs = heredocs(command);
    for (n, line) in command.lines().enumerate() {
        let t = line.trim_start();
        let t = t.strip_prefix("export ").unwrap_or(t).trim_start();
        let Some((name, rest)) = t.split_once('=') else {
            continue;
        };
        if name.is_empty()
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.starts_with(|c: char| c.is_ascii_digit())
        {
            continue;
        }
        let r = rest.trim_start_matches('"');
        if r.starts_with("$(cat <<") || r.starts_with("$(cat<<") {
            if let Some((_, body)) = docs.iter().find(|(at, _)| *at == n) {
                vars.insert(name.to_string(), body.clone());
            }
        } else if !rest.contains("$(") && !rest.contains('`') && !rest.contains('$') {
            if let Some(v) = super::admin::shell_words(rest).into_iter().next() {
                vars.insert(name.to_string(), v);
            }
        }
    }
    vars
}

/// `text` with `$NAME` / `${NAME}` replaced from `vars`; the names it
/// couldn't fill are returned.
fn expand_vars(
    text: &str,
    vars: &std::collections::HashMap<String, String>,
) -> (String, Vec<String>) {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut missing = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' {
            let braced = chars.get(i + 1) == Some(&'{');
            let start = i + 1 + usize::from(braced);
            let mut j = start;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            let name: String = chars[start..j].iter().collect();
            let ok = !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && (!braced || chars.get(j) == Some(&'}'));
            if ok {
                match vars.get(&name) {
                    Some(v) => out.push_str(v),
                    None => missing.push(format!("${name}")),
                }
                i = j + usize::from(braced);
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, missing)
}

/// The text a call sends, as far as it can be read from the call. `page`:
/// what was typed on the page, for a browser step.
pub fn texts(tool: &str, input: &Value, ctx: Option<&Ctx>, typed: &[String]) -> Texts {
    let mut out = Texts::default();
    if tool == "Bash" {
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        command_texts(&mut out, command, ctx);
    } else if tool.starts_with(super::browser_gate::SERVER)
        || tool.starts_with(super::browser_gate::AGENTS_SERVER)
    {
        for t in typed {
            push(&mut out, t);
        }
    } else {
        json_texts(&mut out, input, 0);
    }
    out
}

fn command_texts(out: &mut Texts, command: &str, ctx: Option<&Ctx>) {
    const TEXT_FLAGS: &[&str] = &[
        "-m",
        "--message",
        "-b",
        "--body",
        "-t",
        "--title",
        "-s",
        "--subject",
        "--text",
        "--notes",
        "--msg",
        "-d",
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
        "--json",
    ];
    const FILE_FLAGS: &[&str] = &["--body-file", "--notes-file", "--input", "-F", "--file"];
    let commands = go_hard::commands(command);
    let sending = commands.iter().any(|w| words_send(w)) || command_sends(command);
    if !sending {
        return;
    }
    for words in &commands {
        let w: Vec<&str> = words.iter().map(String::as_str).collect();
        let rest = program(&w);
        let Some((prog, args)) = rest.split_first() else {
            continue;
        };
        let prog = go_hard::base(prog);
        // `echo "…" | mail sam@…`: the words piped in.
        if matches!(prog, "echo" | "printf") {
            let words: Vec<&str> = args
                .iter()
                .copied()
                .filter(|a| !a.starts_with('-'))
                .collect();
            push(out, &words.join(" "));
            continue;
        }
        if !words_send(words) && !(prog == "osascript") {
            continue;
        }
        let mut i = 0;
        while i < args.len() {
            let a = args[i];
            let (flag, inline) = match a.split_once('=') {
                Some((f, v)) if f.starts_with("--") => (f, Some(v)),
                _ => (a, None),
            };
            let value = inline.or_else(|| args.get(i + 1).copied());
            let gh_field = prog == "gh" && matches!(flag, "-f" | "-F" | "--field" | "--raw-field");
            if gh_field {
                if let Some((k, v)) = value.and_then(|v| v.split_once('=')) {
                    if TEXT_KEYS.contains(&k.to_ascii_lowercase().as_str()) {
                        match v.strip_prefix('@') {
                            Some(file) => read_file(out, file, ctx),
                            None => push(out, v),
                        }
                    }
                }
            } else if FILE_FLAGS.contains(&flag) && !(prog == "curl") {
                if let Some(v) = value {
                    read_file(out, v, ctx);
                }
            } else if TEXT_FLAGS.contains(&flag) {
                if let Some(v) = value {
                    match v.strip_prefix('@') {
                        Some(file) if prog == "curl" => read_file(out, file, ctx),
                        _ => match serde_json::from_str::<Value>(v) {
                            Ok(json @ Value::Object(_)) => json_texts(out, &json, 0),
                            _ => push(out, v),
                        },
                    }
                }
            } else if a == "<" {
                if let Some(v) = args.get(i + 1) {
                    read_file(out, v, ctx);
                }
            } else if prog == "osascript" && a == "-e" {
                if let Some(v) = value {
                    push(out, v);
                }
            }
            if inline.is_none()
                && (gh_field
                    || FILE_FLAGS.contains(&flag)
                    || TEXT_FLAGS.contains(&flag)
                    || a == "<")
            {
                i += 2;
            } else {
                i += 1;
            }
        }
        // A chat CLI's message given as words: `slackcat "Live"`.
        if go_hard::is_messenger(prog) && out.pieces.is_empty() {
            let pos: Vec<&str> = args
                .iter()
                .copied()
                .filter(|a| !a.starts_with('-') && !a.starts_with('#') && !a.contains('@'))
                .collect();
            if let Some(last) = pos.last() {
                push(out, last);
            }
        }
    }
    // `$F` is the words the command itself put in F; one it can't fill is
    // said plainly rather than shown as `$F`.
    let vars = assigned_vars(command);
    let found = std::mem::take(&mut out.pieces);
    for piece in found {
        let (text, missing) = expand_vars(&piece, &vars);
        if missing.is_empty() {
            push(out, &text);
        } else {
            for m in missing {
                if !out.unread.contains(&m) {
                    out.unread.push(m);
                }
            }
        }
    }
    for body in heredoc_bodies(command) {
        push(out, &body);
    }
}

/// The card's words about the text: what goes out, word for word, or that
/// it can't be read here.
pub fn card_block(t: &Texts) -> String {
    let mut out = String::new();
    if t.pieces.is_empty() {
        out.push_str("Goes out under your name. The app can't read the exact words from this request: check them under Details, or on the page, before you allow.");
    } else {
        out.push_str("Goes out under your name, exactly:");
        for p in &t.pieces {
            let shown: String = p.chars().take(1500).collect();
            let more = if p.chars().count() > 1500 { "…" } else { "" };
            out.push_str(&format!("\n“{shown}{more}”"));
        }
    }
    for f in &t.unread {
        if f.starts_with('$') {
            out.push_str(&format!(
                "\nSome of the words come from {f}, which this app can't read from the request: check them under Details before you allow."
            ));
        } else {
            out.push_str(&format!(
                "\nIt also sends what's in {f}, which the app couldn't read: allowing sends whatever that file holds."
            ));
        }
    }
    out
}

/// Whether `approved` (an `ask_plan` action's text) is what goes out: the
/// pieces, together (a title and a body, in either order), are exactly its
/// words, whitespace aside, and nothing is read from a file the app
/// couldn't open. A part of the OK'd text is not the OK'd text ("deploy" of
/// "Don't deploy").
pub fn approved_covers(approved: &str, t: &Texts) -> bool {
    let a = norm(approved);
    if a.is_empty() || !t.complete() {
        return false;
    }
    let pieces: Vec<String> = t.pieces.iter().map(|p| norm(p)).collect();
    if pieces.len() > 3 {
        return norm(&pieces.join(" ")) == a;
    }
    let mut order: Vec<usize> = (0..pieces.len()).collect();
    permutations(&mut order, 0, &mut |o| {
        norm(
            &o.iter()
                .map(|&i| pieces[i].as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ) == a
    })
}

fn permutations(v: &mut Vec<usize>, k: usize, ok: &mut dyn FnMut(&[usize]) -> bool) -> bool {
    if k == v.len() {
        return ok(v);
    }
    for i in k..v.len() {
        v.swap(k, i);
        if permutations(v, k + 1, ok) {
            return true;
        }
        v.swap(k, i);
    }
    false
}

#[cfg(test)]
#[path = "outward_tests.rs"]
mod tests;
