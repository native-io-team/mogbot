//! A shell command in plain words: "Running the Cypress tests", "Looking up
//! PR #248 on GitHub", "Installing packages", "Reading 3 files".
//!
//! The words come from a table of the tools agents actually run (package
//! managers and their scripts, test runners, builds, git, gh, curl, docker,
//! interpreters, file commands) and never from the command's arguments,
//! except values that are safe and say something: a PR or issue number, a
//! web host, a script name, a file's own name, a count. Anything the table
//! doesn't know falls back to the program's name ("Running ffmpeg"), never to
//! raw shell. Every phrase still goes through `work::clean` (Keychain
//! redaction, the scrubber, the length limit) before anyone sees it.
//!
//! A phrase also says whether the tool is one that is known to take a while
//! ([`Slow`]): the working line uses it for "This usually takes a few
//! minutes", and the stall check gives such a step longer before it calls it
//! stuck.

use serde::{Deserialize, Serialize};

/// The kind of slow a known slow tool is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Slow {
    Tests,
    Build,
    Install,
    Deploy,
    #[serde(other)]
    Other,
}

/// A command, described three ways.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Phrase {
    /// For the working line: "Running the Cypress tests".
    pub doing: String,
    /// For the timeline: "Ran the Cypress tests".
    pub done: String,
    /// For "Tried to …" / "Asked to … — you declined": "run the Cypress tests".
    pub ask: String,
    pub slow: Option<Slow>,
}

/// A verb in its three forms: doing, done, bare.
#[derive(Clone, Copy)]
struct V(&'static str, &'static str, &'static str);

const RUN: V = V("Running", "Ran", "run");
const CHECK: V = V("Checking", "Checked", "check");
const LOOK_AT: V = V("Looking at", "Looked at", "look at");
const LOOK_UP: V = V("Looking up", "Looked up", "look up");
const LOOK_THROUGH: V = V("Looking through", "Looked through", "look through");
const LOOK_FOR: V = V("Looking for", "Looked for", "look for");
const READ: V = V("Reading", "Read", "read");
const FETCH: V = V("Getting", "Got", "get");
const PULL: V = V("Pulling", "Pulled", "pull");
const PUSH: V = V("Pushing", "Pushed", "push");
const SAVE: V = V("Saving", "Saved", "save");
const SWITCH: V = V("Switching", "Switched", "switch");
const STAGE: V = V("Staging", "Staged", "stage");
const INSTALL: V = V("Installing", "Installed", "install");
const REMOVE: V = V("Removing", "Removed", "remove");
const BUILD: V = V("Building", "Built", "build");
const START: V = V("Starting", "Started", "start");
const STOP: V = V("Stopping", "Stopped", "stop");
const FORMAT: V = V("Formatting", "Formatted", "format");
const OPEN: V = V("Opening", "Opened", "open");
const SEARCH: V = V("Searching", "Searched", "search");
const COPY: V = V("Copying", "Copied", "copy");
const MOVE: V = V("Moving", "Moved", "move");
const CREATE: V = V("Creating", "Created", "create");
const DELETE: V = V("Deleting", "Deleted", "delete");
const MERGE: V = V("Merging", "Merged", "merge");
const APPLY: V = V("Applying", "Applied", "apply");
const SET_ASIDE: V = V("Setting aside", "Set aside", "set aside");
const COMMENT: V = V("Commenting on", "Commented on", "comment on");
const SEND: V = V("Sending", "Sent", "send");
const DEPLOY: V = V("Deploying", "Deployed", "deploy");
const WAIT: V = V("Waiting", "Waited", "wait");
const COUNT: V = V("Counting", "Counted", "count");
const COMPARE: V = V("Comparing", "Compared", "compare");
const EDIT: V = V("Editing", "Edited", "edit");
const WRITE: V = V("Writing", "Wrote", "write");
const UPDATE: V = V("Updating", "Updated", "update");
const CONNECT: V = V("Connecting to", "Connected to", "connect to");
const WATCH: V = V("Watching", "Watched", "watch");
const QUERY: V = V("Querying", "Queried", "query");
const PACK: V = V("Packing", "Packed", "pack");
const UNPACK: V = V("Unpacking", "Unpacked", "unpack");
const PRINT: V = V("Printing", "Printed", "print");
const GENERATE: V = V("Generating", "Generated", "generate");
const MEASURE: V = V("Measuring", "Measured", "measure");
const CLOSE: V = V("Closing", "Closed", "close");
const REVIEW: V = V("Reviewing", "Reviewed", "review");
const DOWNLOAD: V = V("Downloading", "Downloaded", "download");
const UPLOAD: V = V("Uploading", "Uploaded", "upload");
const REWRITE: V = V("Rebasing", "Rebased", "rebase");
const RESET: V = V("Resetting", "Reset", "reset");
const RESTORE: V = V("Restoring", "Restored", "restore");

fn p(v: V, object: impl AsRef<str>) -> Phrase {
    let o = object.as_ref();
    let join = |verb: &str| {
        if o.is_empty() {
            verb.to_string()
        } else {
            format!("{verb} {o}")
        }
    };
    Phrase {
        doing: join(v.0),
        done: join(v.1),
        ask: join(v.2),
        slow: None,
    }
}

fn slow(mut phrase: Phrase, kind: Slow) -> Phrase {
    phrase.slow = Some(kind);
    phrase
}

const OUTWARD: [&str; 4] = ["push", "send", "open a pull request", "comment on"];
const CONSEQUENTIAL: [&str; 3] = ["save a commit", "merge", "update the last commit"];

/// How much a command says about what the whole line is for: a line's
/// headline is its weightiest command ("cd x && npm install && npm test" is
/// running the tests).
fn weight(phrase: &Phrase, trivial: bool) -> u8 {
    if trivial {
        return 0;
    }
    match phrase.slow {
        Some(Slow::Tests) => 6,
        Some(Slow::Deploy) => 5,
        Some(Slow::Build) => 5,
        Some(Slow::Install) => 4,
        Some(Slow::Other) => 3,
        // What others see says the most, then what changes the project.
        None if OUTWARD.iter().any(|a| phrase.ask.starts_with(a)) => 4,
        None if CONSEQUENTIAL.iter().any(|a| phrase.ask.starts_with(a)) => 3,
        None => 2,
    }
}

// ============================================================================
// Reading the shell
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String),
    /// `&&`, `||`, `;`, `&`, a newline: the next command is separate.
    Sep,
    /// `|`: the next command reads this one's output.
    Pipe,
    /// `> file`, `>> file`: where this command's output goes.
    Into(String),
}

/// Words and separators, quotes removed, redirections and comments dropped,
/// here-document bodies skipped. Never fails: an unterminated quote simply
/// runs to the end.
#[allow(unused_assignments)]
fn tokenize(src: &str) -> Vec<Tok> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut word = String::new();
    let mut has_word = false;
    let mut i = 0;
    // Here-documents waiting for the end of their line: their delimiters.
    let mut heredocs: Vec<String> = Vec::new();
    let mut skip_next_word = false;
    // The next word is where output goes (`> note.txt`).
    let mut into_next_word = false;
    macro_rules! flush {
        () => {
            if has_word {
                if into_next_word {
                    into_next_word = false;
                    skip_next_word = false;
                    out.push(Tok::Into(std::mem::take(&mut word)));
                } else if skip_next_word {
                    skip_next_word = false;
                } else {
                    out.push(Tok::Word(std::mem::take(&mut word)));
                }
                word.clear();
                has_word = false;
            }
        };
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                if chars[i + 1] != '\n' {
                    word.push(chars[i + 1]);
                    has_word = true;
                }
                i += 2;
                continue;
            }
            '\'' => {
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
                has_word = true;
            }
            '"' => {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                has_word = true;
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                // `$(…)` (and `$((…))`) is one opaque word.
                let mut depth = 0;
                while i < chars.len() {
                    match chars[i] {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                word.push(')');
                                break;
                            }
                        }
                        _ => {}
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                has_word = true;
            }
            '`' => {
                word.push('`');
                i += 1;
                while i < chars.len() && chars[i] != '`' {
                    word.push(chars[i]);
                    i += 1;
                }
                word.push('`');
                has_word = true;
            }
            '#' if !has_word => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            ' ' | '\t' | '\r' => flush!(),
            '\n' => {
                flush!();
                out.push(Tok::Sep);
                // Here-document bodies are data, not commands.
                for delim in std::mem::take(&mut heredocs) {
                    loop {
                        let start = (i + 1).min(chars.len());
                        let mut end = start;
                        while end < chars.len() && chars[end] != '\n' {
                            end += 1;
                        }
                        let line: String = chars[start..end].iter().collect();
                        i = end;
                        if line.trim() == delim || end >= chars.len() {
                            break;
                        }
                    }
                }
            }
            ';' => {
                flush!();
                out.push(Tok::Sep);
                // `;;` in a case statement.
                while chars.get(i + 1) == Some(&';') {
                    i += 1;
                }
            }
            '&' => {
                if chars.get(i + 1) == Some(&'>') {
                    // `&>file`
                    flush!();
                    i += 2;
                    if chars.get(i) == Some(&'>') {
                        i += 1;
                    }
                    skip_next_word = true;
                    continue;
                }
                flush!();
                out.push(Tok::Sep);
                if chars.get(i + 1) == Some(&'&') {
                    i += 1;
                }
            }
            '|' => {
                flush!();
                if chars.get(i + 1) == Some(&'|') {
                    out.push(Tok::Sep);
                    i += 1;
                } else {
                    out.push(Tok::Pipe);
                    if chars.get(i + 1) == Some(&'&') {
                        i += 1;
                    }
                }
            }
            '>' | '<' => {
                // A file descriptor number before it is part of the redirection.
                let mut fd_other = false;
                if has_word && word.chars().all(|c| c.is_ascii_digit()) {
                    fd_other = word != "1";
                    word.clear();
                    has_word = false;
                } else {
                    flush!();
                }
                if c == '<' && chars.get(i + 1) == Some(&'<') {
                    if chars.get(i + 2) == Some(&'<') {
                        // `<<<word`: a here-string, its word is data.
                        i += 3;
                        skip_next_word = true;
                        continue;
                    }
                    // `<<EOF`, `<<-'EOF'`: a here-document.
                    i += 2;
                    if chars.get(i) == Some(&'-') {
                        i += 1;
                    }
                    while chars.get(i) == Some(&' ') {
                        i += 1;
                    }
                    let mut delim = String::new();
                    while i < chars.len() && !" \t\n;&|".contains(chars[i]) {
                        if !"'\"".contains(chars[i]) {
                            delim.push(chars[i]);
                        }
                        i += 1;
                    }
                    if !delim.is_empty() {
                        heredocs.push(delim);
                    }
                    continue;
                }
                if c == '<' && chars.get(i + 1) == Some(&'(') {
                    // `<(…)` process substitution: opaque.
                    word.push('<');
                    has_word = true;
                    i += 1;
                    continue;
                }
                i += 1;
                if chars.get(i) == Some(&'>') {
                    i += 1;
                }
                if chars.get(i) == Some(&'&') {
                    // `2>&1`, `>&2`: to another descriptor.
                    i += 1;
                    while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '-') {
                        i += 1;
                    }
                    continue;
                }
                if c == '>' && !fd_other {
                    into_next_word = true;
                } else {
                    skip_next_word = true;
                }
                continue;
            }
            '(' | ')' if !has_word => {
                flush!();
                out.push(Tok::Sep);
            }
            // A `{ …; }` group, not a `{1..5}` brace expansion.
            '{' if !has_word && chars.get(i + 1).is_none_or(|n| n.is_whitespace()) => {
                out.push(Tok::Sep);
            }
            '}' if !has_word && i > 0 && (chars[i - 1].is_whitespace() || chars[i - 1] == ';') => {
                out.push(Tok::Sep);
            }
            _ => {
                word.push(c);
                has_word = true;
            }
        }
        i += 1;
    }
    flush!();
    out
}

/// One simple command, and the loop it is in.
#[derive(Debug, Clone, PartialEq)]
struct Cmd {
    words: Vec<String>,
    /// Where its output goes (`> note.txt`), when it's a file.
    into: Option<String>,
    /// It reads another command's output (`… | tail -20`).
    piped: bool,
    /// Inside a loop: how many times, when that's written down.
    times: Option<Option<usize>>,
}

/// Shell keywords that only shape the line around the real commands.
const KEYWORDS: [&str; 12] = [
    "do", "done", "then", "fi", "else", "elif", "if", "esac", "!", "time", "{", "}",
];

/// The commands in a line, with what loops they run in.
fn commands(src: &str) -> Vec<Cmd> {
    let mut out = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut piped = false;
    // The loop being read: its count, and how deep in `do … done` we are.
    let mut times: Option<Option<usize>> = None;
    let mut depth = 0usize;
    let toks = tokenize(src);
    let mut i = 0;
    let mut into: Option<String> = None;
    let push = |out: &mut Vec<Cmd>,
                words: &mut Vec<String>,
                into: &mut Option<String>,
                piped: bool,
                times| {
        let into = into.take();
        if !words.is_empty() {
            out.push(Cmd {
                words: std::mem::take(words),
                into,
                piped,
                times,
            });
        }
    };
    while i < toks.len() {
        match &toks[i] {
            Tok::Sep => {
                push(&mut out, &mut current, &mut into, piped, times);
                piped = false;
            }
            Tok::Pipe => {
                push(&mut out, &mut current, &mut into, piped, times);
                piped = true;
            }
            Tok::Into(file) => into = Some(file.clone()),
            Tok::Word(w) if current.is_empty() && (w == "for" || w == "select") => {
                // `for x in a b c; do …; done`: count the items when they're written out.
                let mut j = i + 1;
                let mut items: Vec<&str> = Vec::new();
                let mut has_in = false;
                while let Some(Tok::Word(w)) = toks.get(j) {
                    if w == "do" {
                        break;
                    }
                    if has_in {
                        items.push(w);
                    }
                    if w == "in" {
                        has_in = true;
                    }
                    j += 1;
                }
                let count = has_in.then(|| count_items(&items)).flatten();
                times = Some(count);
                depth += 1;
                // Skip to `do`.
                while i < toks.len() && toks[i] != Tok::Word("do".into()) {
                    i += 1;
                }
                piped = false;
            }
            Tok::Word(w) if current.is_empty() && (w == "while" || w == "until") => {
                times = Some(None);
                depth += 1;
                // The condition is a command too (`while ! curl …`), but the
                // body is what repeats: skip the condition.
                while i < toks.len() && toks[i] != Tok::Word("do".into()) {
                    i += 1;
                }
                piped = false;
            }
            Tok::Word(w) if current.is_empty() && w == "done" => {
                push(&mut out, &mut current, &mut into, piped, times);
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    times = None;
                }
            }
            Tok::Word(w) if current.is_empty() && w == "case" => {
                // `case x in …`: the patterns aren't commands; read on after `in`.
                while i < toks.len() && toks[i] != Tok::Word("in".into()) {
                    i += 1;
                }
            }
            Tok::Word(w) if current.is_empty() && KEYWORDS.contains(&w.as_str()) => {}
            Tok::Word(w) if current.is_empty() && w.ends_with(')') && !w.starts_with("$(") => {
                // A case pattern (`start)`).
            }
            Tok::Word(w) => current.push(w.clone()),
        }
        i += 1;
    }
    push(&mut out, &mut current, &mut into, piped, times);
    out
}

/// How many items a `for` loop goes over, when that is written out.
fn count_items(items: &[&str]) -> Option<usize> {
    let mut n = 0usize;
    for item in items {
        if item.contains("$(") || item.contains('`') || item.starts_with('$') {
            return None;
        }
        if item.contains(['*', '?']) {
            return None;
        }
        // `{1..5}`
        if let Some(range) = item.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            if let Some((a, b)) = range.split_once("..") {
                let (a, b) = (a.parse::<i64>().ok()?, b.parse::<i64>().ok()?);
                n += usize::try_from((b - a).unsigned_abs() + 1).ok()?;
                continue;
            }
            n += range.split(',').count();
            continue;
        }
        n += 1;
    }
    (n > 0).then_some(n)
}

// ============================================================================
// Safe pieces of arguments
// ============================================================================

fn file_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// A file's own name, when it's plain enough to show.
fn plain_file(word: &str) -> Option<String> {
    if word.starts_with('-') || word.contains(['$', '*', '?', '`', '=', '{', '[']) {
        return None;
    }
    let name = file_name(word);
    let ok = (1..=48).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || "._-+@".contains(c))
        && name.chars().any(|c| c.is_alphanumeric())
        && !super::work::looks_like_token(name);
    ok.then(|| name.to_string())
}

/// A program or script name: short, plain.
fn plain_word(word: &str) -> bool {
    (1..=32).contains(&word.chars().count())
        && word
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-:".contains(c))
        && !super::work::looks_like_token(word)
}

/// A PR or issue number: `248`, `#248`, or the end of a `…/pull/248` link.
fn number(word: &str) -> Option<u64> {
    let w = word.trim_start_matches('#');
    if let Ok(url) = url::Url::parse(w) {
        let mut segs: Vec<&str> = url.path_segments()?.collect();
        while segs
            .last()
            .is_some_and(|s| s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()))
        {
            segs.pop();
        }
        return segs.last()?.parse().ok();
    }
    (w.len() <= 7 && !w.is_empty() && w.chars().all(|c| c.is_ascii_digit()))
        .then(|| w.parse().ok())
        .flatten()
}

/// A URL's host (with its port for a local one), never its path or query.
fn host_of(word: &str) -> Option<String> {
    let w = word.trim();
    let parsed = if w.contains("://") {
        url::Url::parse(w).ok()?
    } else {
        // `localhost:3000/x`, `api.acme.com/v1`
        let head = w.split('/').next()?;
        let host = head.split(':').next()?;
        let dotted = host.contains('.')
            && host
                .rsplit('.')
                .next()
                .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
        if !(dotted || host == "localhost") || w.starts_with(['.', '/', '-']) {
            return None;
        }
        url::Url::parse(&format!("http://{w}")).ok()?
    };
    let host = parsed.host_str()?.trim_start_matches("www.").to_string();
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-[]:".contains(c))
    {
        return None;
    }
    let local = host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0" || host == "[::1]";
    Some(match (local, parsed.port()) {
        (true, Some(port)) => format!("{host}:{port}"),
        _ => host,
    })
}

/// Words that aren't flags (and not the values of `flags_with_values`).
fn positional<'a>(words: &'a [String], flags_with_values: &[&str]) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut skip = false;
    for w in words {
        if skip {
            skip = false;
            continue;
        }
        if w == "--" || w.is_empty() {
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            if !w.contains('=') && flags_with_values.contains(&w.as_str()) {
                skip = true;
            }
            continue;
        }
        out.push(w.as_str());
    }
    out
}

fn has_flag(words: &[String], flags: &[&str]) -> bool {
    words.iter().any(|w| {
        flags.contains(&w.as_str()) || flags.iter().any(|f| w.starts_with(&format!("{f}=")))
    })
}

fn files_phrase(v: V, files: &[&str]) -> Phrase {
    match files {
        [] => p(v, "files"),
        [one] => match plain_file(one) {
            Some(name) => p(v, name),
            None => p(v, "a file"),
        },
        many => p(v, format!("{} files", many.len())),
    }
}

// ============================================================================
// The table
// ============================================================================

/// Programs that only set up the command after them.
const WRAPPERS: [&str; 10] = [
    "sudo",
    "env",
    "time",
    "nohup",
    "command",
    "exec",
    "nice",
    "caffeinate",
    "stdbuf",
    "unbuffer",
];
/// Words that don't do anything on their own.
const SETUP: [&str; 12] = [
    "cd", "export", "set", "source", ".", "pushd", "popd", "true", "false", "unset", "local", ":",
];
/// Commands that rarely say what a line is for.
const TRIVIAL: [&str; 10] = [
    "echo", "printf", "pwd", "clear", "wait", "exit", "date", "sleep", "read", "trap",
];

/// One command, in words, and whether it's one that says little.
fn describe_cmd(words: &[String], depth: u8) -> Option<(Phrase, bool)> {
    let mut i = 0;
    // Wrappers, assignments, `timeout 600`, `xargs -n1`.
    while i < words.len() {
        let w = words[i].as_str();
        if is_assignment(w) || WRAPPERS.contains(&file_name(w)) {
            i += 1;
            continue;
        }
        if w.starts_with('-') && i > 0 {
            i += 1;
            continue;
        }
        if matches!(file_name(w), "timeout" | "gtimeout") {
            i += 1;
            while i < words.len()
                && (words[i].starts_with('-')
                    || words[i].chars().next().is_some_and(|c| c.is_ascii_digit()))
            {
                i += 1;
            }
            continue;
        }
        if file_name(w) == "xargs" {
            i += 1;
            while i < words.len() && words[i].starts_with('-') {
                // `-n 1`, `-I {}`
                if matches!(words[i].as_str(), "-n" | "-I" | "-P" | "-L" | "-d") {
                    i += 1;
                }
                i += 1;
            }
            continue;
        }
        break;
    }
    let words = &words[i.min(words.len())..];
    let program = file_name(words.first()?);
    let args = &words[1..];
    if SETUP.contains(&program) {
        return None;
    }
    if !plain_word(program) {
        return Some((p(RUN, "a command"), true));
    }
    let trivial = TRIVIAL.contains(&program);
    if let Some(phrase) = known(program, args, depth) {
        return Some((phrase, trivial));
    }
    if program.starts_with("create-") {
        return Some((p(CREATE, "a project"), false));
    }
    Some((p(RUN, program), trivial))
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn known(program: &str, args: &[String], depth: u8) -> Option<Phrase> {
    let pos = positional(args, &[]);
    let first = pos.first().copied().unwrap_or("");
    Some(match program {
        // ---- shells: describe what they run ----
        "bash" | "sh" | "zsh" | "dash" | "fish" => {
            let at = args
                .iter()
                .position(|a| a.starts_with('-') && !a.starts_with("--") && a.contains('c'));
            return match at.and_then(|at| args.get(at + 1)) {
                Some(inner) if depth < 4 => describe(inner, depth + 1),
                Some(_) => Some(p(RUN, "a shell command")),
                None => run_file("a shell script", pos.first().copied()),
            };
        }
        // ---- JavaScript package managers ----
        "npm" | "pnpm" | "yarn" | "bun" => return package_manager(program, args, depth),
        "npx" | "bunx" => return npx(args, depth),
        "deno" => match first {
            "test" => slow(p(RUN, "the Deno tests"), Slow::Tests),
            "task" => script(pos.get(1).copied()?)?,
            "run" => run_file("a Deno script", pos.get(1).copied())?,
            "install" | "add" => slow(p(INSTALL, "packages"), Slow::Install),
            _ => p(RUN, "Deno"),
        },
        "node" | "tsx" | "ts-node" | "python" | "python3" | "ruby" | "perl" | "php" => {
            return interpreter(program, args, depth)
        }
        // ---- test runners, builds and tools usually run through npx ----
        "cypress" | "playwright" | "jest" | "vitest" | "mocha" | "ava" | "pytest" | "tsc"
        | "eslint" | "prettier" | "biome" | "next" | "vite" | "astro" | "nuxt" | "webpack"
        | "esbuild" | "rollup" | "turbo" | "nx" | "vercel" | "netlify" | "wrangler" | "prisma"
        | "drizzle-kit" | "expo" | "eas" | "storybook" | "lighthouse" | "tauri" | "svelte-kit"
        | "remix" | "gatsby" | "react-scripts" | "stylelint" | "knip" => {
            return tool(program, args, depth)
        }
        // ---- version control ----
        "git" => return git(args),
        "gh" => return gh(args),
        // ---- the network ----
        "curl" | "wget" | "http" | "https" | "xh" => return fetch(program, args),
        "open" | "xdg-open" => {
            let target = pos.first()?;
            match host_of(target).filter(|_| target.contains("://")) {
                Some(host) => p(OPEN, host),
                None => files_phrase(OPEN, &pos),
            }
        }
        "ssh" | "mosh" => p(CONNECT, "a server"),
        "scp" | "rsync" | "sftp" => p(COPY, "files"),
        "ping" => p(
            CHECK,
            pos.first()
                .and_then(|w| host_of(w))
                .unwrap_or_else(|| "the network".into()),
        ),
        // ---- containers and the cloud ----
        "docker" | "podman" => return docker(args),
        "docker-compose" => return compose(args),
        "kubectl" => match first {
            "apply" => p(APPLY, "changes to Kubernetes"),
            "logs" => p(READ, "Kubernetes logs"),
            _ => p(CHECK, "Kubernetes"),
        },
        "terraform" => match first {
            "apply" => slow(p(APPLY, "infrastructure changes"), Slow::Deploy),
            "plan" => p(CHECK, "planned infrastructure changes"),
            "init" => slow(p(INSTALL, "Terraform providers"), Slow::Install),
            _ => p(RUN, "Terraform"),
        },
        "aws" | "gcloud" | "az" | "doctl" | "flyctl" | "fly" | "heroku" | "railway" => {
            let cloud = match program {
                "aws" => "AWS",
                "gcloud" => "Google Cloud",
                "az" => "Azure",
                "doctl" => "DigitalOcean",
                "heroku" => "Heroku",
                "railway" => "Railway",
                _ => "Fly.io",
            };
            if pos.contains(&"deploy") {
                slow(p(DEPLOY, format!("to {cloud}")), Slow::Deploy)
            } else {
                p(V("Working in", "Worked in", "work in"), cloud)
            }
        }
        "supabase" => match first {
            "db" | "migration" => p(UPDATE, "the database"),
            "functions" if pos.contains(&"deploy") => {
                slow(p(DEPLOY, "Supabase functions"), Slow::Deploy)
            }
            "start" => slow(p(START, "Supabase"), Slow::Other),
            _ => p(RUN, "Supabase"),
        },
        "firebase" => match first {
            "deploy" => slow(p(DEPLOY, "to Firebase"), Slow::Deploy),
            "emulators:start" => p(START, "the Firebase emulators"),
            _ => p(RUN, "Firebase"),
        },
        "psql" | "mysql" | "sqlite3" | "mongosh" | "redis-cli" | "pg_dump" => {
            if program == "pg_dump" {
                p(COPY, "the database")
            } else {
                p(QUERY, "the database")
            }
        }
        // ---- other languages ----
        "cargo" => match first {
            "test" | "nextest" => slow(p(RUN, "the Rust tests"), Slow::Tests),
            "build" => slow(p(BUILD, "the Rust code"), Slow::Build),
            "check" | "clippy" => slow(p(CHECK, "the Rust code"), Slow::Build),
            "run" => p(RUN, "the Rust program"),
            "fmt" => p(FORMAT, "the Rust code"),
            "add" | "install" | "fetch" | "update" => {
                slow(p(INSTALL, "Rust packages"), Slow::Install)
            }
            _ => p(RUN, "cargo"),
        },
        "go" => match first {
            "test" => slow(p(RUN, "the Go tests"), Slow::Tests),
            "build" => slow(p(BUILD, "the Go code"), Slow::Build),
            "run" => p(RUN, "the Go program"),
            "get" | "install" | "mod" => slow(p(INSTALL, "Go packages"), Slow::Install),
            "vet" => p(CHECK, "the Go code"),
            "fmt" => p(FORMAT, "the Go code"),
            _ => p(RUN, "go"),
        },
        "pip" | "pip3" | "pipx" | "uv" | "poetry" | "pdm" | "conda" => {
            return python_packages(program, args, depth)
        }
        "bundle" => match first {
            "install" => slow(p(INSTALL, "packages"), Slow::Install),
            "exec" => {
                let rest = &args[args.iter().position(|a| a == "exec")? + 1..];
                return describe_cmd(rest, depth).map(|(p, _)| p);
            }
            _ => p(RUN, "Bundler"),
        },
        "gem" if first == "install" => slow(p(INSTALL, "packages"), Slow::Install),
        "rails" | "rake" => match first {
            "test" | "spec" => slow(p(RUN, "the Rails tests"), Slow::Tests),
            "server" | "s" => p(START, "the dev server"),
            f if f.starts_with("db:") => p(UPDATE, "the database"),
            _ => p(RUN, program),
        },
        "rspec" => slow(p(RUN, "the RSpec tests"), Slow::Tests),
        "dotnet" => match first {
            "test" => slow(p(RUN, "the .NET tests"), Slow::Tests),
            "build" => slow(p(BUILD, "the .NET project"), Slow::Build),
            "restore" | "add" => slow(p(INSTALL, "packages"), Slow::Install),
            _ => p(RUN, "dotnet"),
        },
        "flutter" => match first {
            "test" => slow(p(RUN, "the Flutter tests"), Slow::Tests),
            "build" => slow(p(BUILD, "the Flutter app"), Slow::Build),
            "pub" => slow(p(INSTALL, "packages"), Slow::Install),
            "run" => p(START, "the Flutter app"),
            _ => p(RUN, "Flutter"),
        },
        "xcodebuild" => {
            if pos.contains(&"test") {
                slow(p(RUN, "the Xcode tests"), Slow::Tests)
            } else {
                slow(p(BUILD, "the Xcode project"), Slow::Build)
            }
        }
        "pod" if first == "install" => slow(p(INSTALL, "CocoaPods"), Slow::Install),
        "swift" => match first {
            "test" => slow(p(RUN, "the Swift tests"), Slow::Tests),
            "build" => slow(p(BUILD, "the Swift package"), Slow::Build),
            _ => p(RUN, "Swift"),
        },
        "make" | "just" | "task" => {
            let target = positional(args, &["-C", "-f", "-j"]).first().copied();
            match target {
                Some(t) if t.starts_with("test") || t == "check" => {
                    slow(p(RUN, "the tests"), Slow::Tests)
                }
                Some(t) if t == "build" || t == "all" => slow(p(BUILD, "the project"), Slow::Build),
                Some(t) if t == "install" || t == "deps" => {
                    slow(p(INSTALL, "packages"), Slow::Install)
                }
                Some(t) if plain_word(t) => p(RUN, format!("{program} {t}")),
                _ => p(RUN, program),
            }
        }
        // ---- system package managers ----
        "brew" => match first {
            "install" | "upgrade" | "reinstall" => {
                slow(p(INSTALL, "software with Homebrew"), Slow::Install)
            }
            "uninstall" | "remove" => p(REMOVE, "software with Homebrew"),
            "update" => slow(p(UPDATE, "Homebrew"), Slow::Install),
            "services" => p(V("Managing", "Managed", "manage"), "background services"),
            _ => p(CHECK, "Homebrew"),
        },
        "apt" | "apt-get" | "dnf" | "yum" | "apk" | "port" if first == "install" => {
            slow(p(INSTALL, "software"), Slow::Install)
        }
        // ---- files ----
        "cat" | "head" | "less" | "more" | "bat" | "nl" => {
            files_phrase(READ, &pos_skipping_counts(args))
        }
        "tail" => {
            let files = pos_skipping_counts(args);
            if has_flag(args, &["-f", "-F", "--follow"]) {
                files_phrase(WATCH, &files)
            } else {
                files_phrase(READ, &files)
            }
        }
        "sed" | "gsed" => {
            let editing = args
                .iter()
                .any(|a| a == "-i" || a.starts_with("-i") && a.len() <= 4 || a == "--in-place");
            let mut files = positional(args, &["-e", "-f"]);
            // The script is the first positional unless given with -e.
            if !has_flag(args, &["-e", "-f"]) && !files.is_empty() {
                files.remove(0);
            }
            if editing {
                files_phrase(EDIT, &files)
            } else {
                files_phrase(READ, &files)
            }
        }
        "awk" | "gawk" => {
            let mut files = positional(args, &["-F", "-v", "-f"]);
            if !files.is_empty() {
                files.remove(0);
            }
            files_phrase(READ, &files)
        }
        "grep" | "rg" | "ag" | "ack" | "egrep" | "fgrep" | "git-grep" => p(SEARCH, "the files"),
        "find" | "fd" | "mdfind" | "locate" => p(LOOK_FOR, "files"),
        "ls" | "tree" | "exa" | "eza" | "du" => p(LOOK_THROUGH, "the files"),
        "wc" => {
            let files = positional(args, &[]);
            match files.as_slice() {
                [] => p(COUNT, "lines"),
                [one] => match plain_file(one) {
                    Some(name) => p(COUNT, format!("the lines in {name}")),
                    None => p(COUNT, "lines"),
                },
                many => p(COUNT, format!("the lines in {} files", many.len())),
            }
        }
        "diff" | "cmp" | "colordiff" => p(COMPARE, "files"),
        "jq" | "yq" => p(READ, "JSON"),
        "mkdir" => p(CREATE, if pos.len() > 1 { "folders" } else { "a folder" }),
        "touch" => files_phrase(CREATE, &pos),
        "rm" | "rmdir" | "trash" => files_phrase(DELETE, &pos),
        "mv" => files_phrase(MOVE, &pos[..pos.len().saturating_sub(1)]),
        "cp" => files_phrase(COPY, &pos[..pos.len().saturating_sub(1)]),
        "ln" => p(V("Linking", "Linked", "link"), "files"),
        "chmod" | "chown" => p(V("Changing", "Changed", "change"), "file permissions"),
        "tar" | "zip" | "gzip" | "unzip" | "gunzip" | "7z" => {
            let extract = |a: &String| {
                (a.starts_with('-') && !a.starts_with("--") && a.contains('x'))
                    || (a.len() <= 5
                        && a.contains('x')
                        && a.chars().all(|c| c.is_ascii_alphabetic()))
            };
            if program.starts_with("un") || program == "gunzip" || args.iter().any(extract) {
                p(UNPACK, "files")
            } else {
                p(PACK, "files")
            }
        }
        "echo" | "printf" => p(PRINT, "a message"),
        "sleep" => {
            let secs: Option<f64> = pos
                .first()
                .and_then(|s| s.trim_end_matches('s').parse().ok());
            match secs {
                Some(s) if s >= 60.0 => p(WAIT, format!("{} min", (s / 60.0).round() as u64)),
                Some(s) if s >= 1.0 => p(WAIT, format!("{} seconds", s.round() as u64)),
                _ => p(WAIT, ""),
            }
        }
        // ---- processes and the machine ----
        "kill" | "pkill" | "killall" => p(STOP, "a process"),
        "lsof" => {
            let port = args
                .iter()
                .filter_map(|a| a.rsplit_once(':').map(|(_, port)| port))
                .find(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()));
            match port {
                Some(port) => p(CHECK, format!("what's using port {port}")),
                None => p(CHECK, "open files"),
            }
        }
        "ps" | "top" | "pgrep" | "htop" => p(CHECK, "running processes"),
        "which" | "type" | "whereis" => match pos.first().filter(|w| plain_word(w)) {
            Some(tool) => p(CHECK, format!("{tool} is installed")),
            None => p(CHECK, "a tool is installed"),
        },
        "env" | "printenv" => p(READ, "the environment"),
        "uname" | "sw_vers" | "system_profiler" | "sysctl" => p(CHECK, "this Mac"),
        "df" => p(CHECK, "disk space"),
        "defaults" => p(READ, "a setting"),
        "osascript" => p(RUN, "an AppleScript"),
        "say" => p(V("Speaking", "Spoke", "speak"), ""),
        "ffmpeg" | "ffprobe" => p(V("Processing", "Processed", "process"), "a video"),
        "convert" | "magick" | "sips" => p(V("Processing", "Processed", "process"), "an image"),
        "screencapture" => p(V("Taking", "Took", "take"), "a screenshot"),
        "code" | "cursor" => p(OPEN, "the editor"),
        "tmux" | "screen" => p(V("Managing", "Managed", "manage"), "a terminal session"),
        "security" => p(CHECK, "the Keychain"),
        _ => return None,
    })
}

/// `head -n 20 a.ts`: the 20 isn't a file.
fn pos_skipping_counts(args: &[String]) -> Vec<&str> {
    positional(args, &["-n", "-c", "-s", "-m", "--lines", "--bytes"])
}

/// What a project script is for, by its name: `test`, `build`, `dev`.
fn script(name: &str) -> Option<Phrase> {
    if !plain_word(name) {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let base = lower.split(':').next().unwrap_or(&lower);
    Some(match base {
        "test" | "tests" | "t" | "spec" => {
            let what = match lower.split_once(':').map(|(_, k)| k) {
                Some("e2e") => "the end-to-end tests",
                Some("unit") => "the unit tests",
                Some(k) if k.contains("cypress") => "the Cypress tests",
                Some(k) if k.contains("playwright") => "the Playwright tests",
                _ => "the tests",
            };
            slow(p(RUN, what), Slow::Tests)
        }
        "e2e" => slow(p(RUN, "the end-to-end tests"), Slow::Tests),
        "cypress" | "cy" => slow(p(RUN, "the Cypress tests"), Slow::Tests),
        "playwright" => slow(p(RUN, "the Playwright tests"), Slow::Tests),
        "build" => slow(p(BUILD, "the project"), Slow::Build),
        "dev" | "serve" | "develop" => p(START, "the dev server"),
        "start" => p(START, "the app"),
        "preview" => p(START, "a preview of the build"),
        "lint" | "eslint" => p(CHECK, "the code for problems"),
        "format" | "fmt" | "prettier" => p(FORMAT, "the code"),
        "typecheck" | "type-check" | "tsc" | "types" => p(CHECK, "types"),
        "check" => p(RUN, "the project's checks"),
        "deploy" | "release" | "publish" => slow(p(DEPLOY, "the project"), Slow::Deploy),
        "storybook" => p(START, "Storybook"),
        "tauri" => p(RUN, "Tauri"),
        _ => p(RUN, format!("the {name} script")),
    })
}

fn package_manager(pm: &str, args: &[String], depth: u8) -> Option<Phrase> {
    // `pnpm -C web test`, `npm --prefix web run build`, `pnpm --filter app build`
    let pos = positional(
        args,
        &[
            "-C",
            "--dir",
            "--prefix",
            "--filter",
            "-F",
            "-w",
            "--workspace",
            "--cwd",
        ],
    );
    let Some(&sub) = pos.first() else {
        // A bare `yarn` / `pnpm` installs.
        return Some(slow(p(INSTALL, "packages"), Slow::Install));
    };
    Some(match sub {
        "install" | "i" | "ci" | "add" | "update" | "up" | "upgrade" | "rebuild" => {
            slow(p(INSTALL, "packages"), Slow::Install)
        }
        "uninstall" | "remove" | "rm" | "un" => p(REMOVE, "a package"),
        "run" | "run-script" => script(pos.get(1).copied()?)?,
        "test" | "t" | "tst" => slow(p(RUN, "the tests"), Slow::Tests),
        "start" => p(START, "the app"),
        "exec" | "dlx" | "x" => {
            let at = args.iter().position(|a| a == sub)?;
            return npx(&args[at + 1..], depth);
        }
        "create" | "init" => p(CREATE, "a project"),
        "publish" => slow(
            p(V("Publishing", "Published", "publish"), "a package"),
            Slow::Deploy,
        ),
        "audit" => p(CHECK, "packages for known problems"),
        "outdated" => p(CHECK, "for package updates"),
        "ls" | "list" | "why" => p(LOOK_AT, "the installed packages"),
        "view" | "info" | "show" | "search" => p(LOOK_UP, "a package"),
        "version" => p(UPDATE, "the version number"),
        "cache" | "store" | "config" | "prune" | "dedupe" => p(RUN, format!("{pm} {sub}")),
        "workspace" => script(pos.get(2).copied()?)?,
        // `pnpm vitest run`, `yarn eslint .`: a tool the project installed.
        name if pm != "npm" && tool(name, &[], depth).is_some() => {
            let at = args.iter().position(|a| a == name)?;
            return tool(name, &args[at + 1..], depth);
        }
        // `pnpm build`, `yarn dev`: a script by its name.
        name if pm != "npm" => script(name)?,
        name if plain_word(name) => p(RUN, format!("npm {name}")),
        _ => p(RUN, pm),
    })
}

fn npx(args: &[String], depth: u8) -> Option<Phrase> {
    let at = args.iter().position(|a| !a.starts_with('-') && a != "--")?;
    let rest = &args[at..];
    let tool_name = strip_version(&rest[0]);
    let mut words: Vec<String> = vec![tool_name];
    words.extend(rest[1..].iter().cloned());
    describe_cmd(&words, depth).map(|(p, _)| p)
}

/// `@playwright/test@1.2` → `playwright`, `create-next-app@latest` → `create-next-app`.
fn strip_version(word: &str) -> String {
    let w = word
        .strip_prefix('@')
        .map_or(word, |s| s.split_once('/').map_or(s, |(_, n)| n));
    let w = w.split('@').next().unwrap_or(w);
    match w {
        "test" if word.starts_with("@playwright") => "playwright".into(),
        "cli" if word.starts_with("@tauri-apps") => "tauri".into(),
        "cli" if word.starts_with("@angular") => "ng".into(),
        "cli" if word.starts_with("@biomejs") => "biome".into(),
        "biome" => "biome".into(),
        other => other.to_string(),
    }
}

fn tool(program: &str, args: &[String], _depth: u8) -> Option<Phrase> {
    let pos = positional(
        args,
        &[
            "--config",
            "-c",
            "--spec",
            "-s",
            "--project",
            "-p",
            "--browser",
            "-b",
            "--port",
            "--reporter",
        ],
    );
    let first = pos.first().copied().unwrap_or("");
    Some(match program {
        "cypress" => match first {
            "open" => p(OPEN, "Cypress"),
            "install" | "verify" => slow(p(INSTALL, "Cypress"), Slow::Install),
            _ => slow(p(RUN, "the Cypress tests"), Slow::Tests),
        },
        "playwright" => match first {
            "install" => slow(p(INSTALL, "Playwright's browsers"), Slow::Install),
            "show-report" => p(OPEN, "the Playwright report"),
            "codegen" => p(OPEN, "Playwright's recorder"),
            _ => slow(p(RUN, "the Playwright tests"), Slow::Tests),
        },
        "jest" => slow(p(RUN, "the Jest tests"), Slow::Tests),
        "vitest" => match first {
            "bench" => slow(p(RUN, "the benchmarks"), Slow::Tests),
            _ => slow(p(RUN, "the Vitest tests"), Slow::Tests),
        },
        "mocha" => slow(p(RUN, "the Mocha tests"), Slow::Tests),
        "ava" => slow(p(RUN, "the AVA tests"), Slow::Tests),
        "pytest" => slow(p(RUN, "the Python tests"), Slow::Tests),
        "tsc" => {
            if has_flag(args, &["--noEmit", "--noemit"])
                || !has_flag(args, &["-b", "--build", "--outDir"])
            {
                p(CHECK, "types")
            } else {
                slow(p(BUILD, "the TypeScript"), Slow::Build)
            }
        }
        "eslint" | "stylelint" | "knip" => {
            if has_flag(args, &["--fix"]) {
                p(V("Fixing", "Fixed", "fix"), "code problems")
            } else {
                p(CHECK, "the code for problems")
            }
        }
        "prettier" | "biome" => {
            if has_flag(args, &["--check", "-c", "--list-different", "-l"])
                || first == "check"
                || first == "lint"
            {
                p(CHECK, "the formatting")
            } else {
                p(FORMAT, "the code")
            }
        }
        "next" | "nuxt" | "astro" | "vite" | "gatsby" | "remix" | "svelte-kit"
        | "react-scripts" => {
            let name = match program {
                "next" => "the Next.js app",
                "nuxt" => "the Nuxt app",
                "astro" => "the Astro site",
                "gatsby" => "the Gatsby site",
                _ => "the project",
            };
            match first {
                "build" | "generate" | "export" => slow(p(BUILD, name), Slow::Build),
                "" | "dev" | "start" | "develop" | "serve" | "preview" => {
                    p(START, "the dev server")
                }
                "test" => slow(p(RUN, "the tests"), Slow::Tests),
                "lint" => p(CHECK, "the code for problems"),
                _ => p(RUN, program),
            }
        }
        "webpack" | "esbuild" | "rollup" => {
            if has_flag(args, &["serve", "--watch", "-w"]) || first == "serve" {
                p(START, "the dev server")
            } else {
                slow(p(BUILD, "the project"), Slow::Build)
            }
        }
        "turbo" | "nx" => {
            let task = match first {
                "run" | "run-many" => pos.get(1).copied().unwrap_or(""),
                other => other,
            };
            match script(task) {
                Some(phrase) => phrase,
                None => p(RUN, program),
            }
        }
        "vercel" => match first {
            "" | "deploy" | "--prod" => slow(p(DEPLOY, "to Vercel"), Slow::Deploy),
            "env" => p(CHECK, "Vercel's settings"),
            "logs" | "inspect" => p(READ, "Vercel's logs"),
            "ls" | "list" => p(CHECK, "deployments on Vercel"),
            "link" => p(V("Linking", "Linked", "link"), "the project to Vercel"),
            "build" => slow(p(BUILD, "the project for Vercel"), Slow::Build),
            "dev" => p(START, "the dev server"),
            _ => p(V("Working in", "Worked in", "work in"), "Vercel"),
        },
        "netlify" => match first {
            "deploy" => slow(p(DEPLOY, "to Netlify"), Slow::Deploy),
            "dev" => p(START, "the dev server"),
            "build" => slow(p(BUILD, "the project for Netlify"), Slow::Build),
            _ => p(V("Working in", "Worked in", "work in"), "Netlify"),
        },
        "wrangler" => match first {
            "deploy" | "publish" | "pages" => slow(p(DEPLOY, "to Cloudflare"), Slow::Deploy),
            "dev" => p(START, "the dev server"),
            "tail" => p(WATCH, "Cloudflare's logs"),
            _ => p(V("Working in", "Worked in", "work in"), "Cloudflare"),
        },
        "prisma" | "drizzle-kit" => match first {
            "generate" => p(GENERATE, "the database client"),
            "studio" => p(OPEN, "the database browser"),
            "migrate" | "db" | "push" | "migration" => p(UPDATE, "the database"),
            _ => p(RUN, program),
        },
        "expo" | "eas" => match first {
            "start" | "" => p(START, "the Expo dev server"),
            "build" | "export" | "prebuild" => slow(p(BUILD, "the app"), Slow::Build),
            "install" => slow(p(INSTALL, "packages"), Slow::Install),
            "submit" => slow(p(UPLOAD, "the app to the store"), Slow::Deploy),
            "run:ios" | "run:android" => slow(p(BUILD, "and starting the app"), Slow::Build),
            _ => p(RUN, "Expo"),
        },
        "storybook" => match first {
            "build" => slow(p(BUILD, "Storybook"), Slow::Build),
            _ => p(START, "Storybook"),
        },
        "lighthouse" => match pos.first().and_then(|w| host_of(w)) {
            Some(host) => slow(p(MEASURE, format!("{host} with Lighthouse")), Slow::Tests),
            None => slow(p(MEASURE, "a page with Lighthouse"), Slow::Tests),
        },
        "tauri" => match first {
            "build" => slow(p(BUILD, "the app"), Slow::Build),
            "dev" => p(START, "the app"),
            _ => p(RUN, "Tauri"),
        },
        _ => return None,
    })
}

fn interpreter(program: &str, args: &[String], depth: u8) -> Option<Phrase> {
    let lang = match program {
        "python" | "python3" => "Python",
        "ruby" => "Ruby",
        "perl" => "Perl",
        "php" => "PHP",
        _ => "JavaScript",
    };
    if let Some(at) = args.iter().position(|a| a == "-m") {
        let module = args.get(at + 1)?.as_str();
        let rest = &args[at + 2..];
        return Some(match module {
            "pytest" | "unittest" => slow(p(RUN, "the Python tests"), Slow::Tests),
            "pip" => return python_packages("pip", rest, depth),
            "http.server" => p(START, "a local web server"),
            "venv" | "virtualenv" => p(CREATE, "a Python environment"),
            "json.tool" => p(READ, "JSON"),
            m if plain_word(m) => p(RUN, format!("Python's {m}")),
            _ => p(RUN, "a Python module"),
        });
    }
    if has_flag(args, &["-c", "-e", "--eval", "-p", "--print"]) {
        return Some(p(RUN, format!("a short {lang} snippet")));
    }
    let file = positional(
        args,
        &["-r", "--require", "--import", "--loader", "-W", "-X"],
    )
    .first()
    .copied();
    Some(match file {
        // `python3 - <<EOF`: the script is in the line itself.
        None if has_flag(args, &["--test"]) => slow(p(RUN, "the Node tests"), Slow::Tests),
        None | Some("-") => p(RUN, format!("a {lang} script")),
        Some(f) => return run_file(&format!("a {lang} script"), Some(f)),
    })
}

fn run_file(fallback: &str, file: Option<&str>) -> Option<Phrase> {
    Some(match file.and_then(plain_file) {
        Some(name) => p(RUN, name),
        None => p(RUN, fallback),
    })
}

fn python_packages(program: &str, args: &[String], depth: u8) -> Option<Phrase> {
    let pos = positional(args, &["-r", "--requirement", "-p", "--python"]);
    let first = pos.first().copied().unwrap_or("");
    Some(match first {
        "install" | "add" | "sync" | "update" | "lock" => {
            slow(p(INSTALL, "packages"), Slow::Install)
        }
        "uninstall" | "remove" => p(REMOVE, "a package"),
        "pip" if program == "uv" => return python_packages("pip", &args[1..], depth),
        "run" | "exec" | "tool" => {
            let at = args.iter().position(|a| a == first)?;
            let rest = &args[at + 1..];
            let skip = rest.iter().position(|a| !a.starts_with('-'))?;
            return describe_cmd(&rest[skip..], depth).map(|(p, _)| p);
        }
        "list" | "freeze" | "show" => p(LOOK_AT, "the installed packages"),
        "venv" => p(CREATE, "a Python environment"),
        _ => p(RUN, program),
    })
}

fn git(args: &[String]) -> Option<Phrase> {
    // `git -C path status`, `git --no-pager log`
    let pos = positional(args, &["-C", "-c", "--git-dir", "--work-tree"]);
    let sub = pos.first().copied().unwrap_or("");
    let at = args.iter().position(|a| a == sub).unwrap_or(0);
    let rest = &args[(at + 1).min(args.len())..];
    let rest_pos = positional(
        rest,
        &[
            "-m", "-b", "-B", "-n", "--format", "--pretty", "-u", "--author", "--since",
        ],
    );
    Some(match sub {
        "status" => p(CHECK, "what changed"),
        "diff" => p(LOOK_AT, "the changes"),
        "log" | "shortlog" | "reflog" => p(READ, "the commit history"),
        "show" => p(LOOK_AT, "a commit"),
        "blame" => p(LOOK_AT, "who changed each line"),
        "fetch" => p(FETCH, "the latest changes"),
        "pull" => p(PULL, "the latest changes"),
        "push" => {
            if has_flag(rest, &["--force", "-f", "--force-with-lease"]) {
                p(PUSH, "changes (overwriting)")
            } else if has_flag(rest, &["--tags"]) {
                p(PUSH, "tags")
            } else {
                p(PUSH, "changes")
            }
        }
        "commit" => {
            if has_flag(rest, &["--amend"]) {
                p(UPDATE, "the last commit")
            } else {
                p(SAVE, "a commit")
            }
        }
        "add" => p(STAGE, "changes"),
        "checkout" | "switch" => {
            if has_flag(rest, &["-b", "-B", "-c", "--create"]) {
                p(CREATE, "a branch")
            } else if rest.iter().any(|a| a == "--")
                || rest_pos.iter().any(|w| w.contains('.') || w.contains('/'))
            {
                p(RESTORE, "files")
            } else {
                p(SWITCH, "branches")
            }
        }
        "branch" => {
            if has_flag(rest, &["-d", "-D", "--delete"]) {
                p(DELETE, "a branch")
            } else if rest_pos.is_empty() {
                p(LOOK_AT, "the branches")
            } else {
                p(CREATE, "a branch")
            }
        }
        "stash" => match rest_pos.first().copied() {
            Some("pop" | "apply") => p(
                V("Bringing back", "Brought back", "bring back"),
                "set-aside changes",
            ),
            Some("list" | "show") => p(LOOK_AT, "set-aside changes"),
            _ => p(SET_ASIDE, "changes"),
        },
        "merge" => {
            if has_flag(rest, &["--abort"]) {
                p(V("Cancelling", "Cancelled", "cancel"), "a merge")
            } else {
                p(MERGE, "changes")
            }
        }
        "rebase" => {
            if has_flag(rest, &["--abort"]) {
                p(V("Cancelling", "Cancelled", "cancel"), "a rebase")
            } else {
                p(REWRITE, "the branch")
            }
        }
        "cherry-pick" => p(APPLY, "a commit"),
        "revert" => p(V("Undoing", "Undid", "undo"), "a commit"),
        "reset" => {
            if has_flag(rest, &["--hard"]) {
                p(RESET, "the branch (discarding changes)")
            } else {
                p(RESET, "staged changes")
            }
        }
        "restore" => p(RESTORE, "files"),
        "clean" => p(DELETE, "untracked files"),
        "rm" => p(DELETE, "files from the repository"),
        "mv" => p(MOVE, "files"),
        "clone" => slow(p(COPY, "a repository"), Slow::Install),
        "init" => p(CREATE, "a repository"),
        "remote" => p(CHECK, "the remotes"),
        "tag" => {
            if rest_pos.is_empty() || has_flag(rest, &["-l", "--list"]) {
                p(LOOK_AT, "the tags")
            } else {
                p(CREATE, "a tag")
            }
        }
        "worktree" => match rest_pos.first().copied() {
            Some("add") => p(CREATE, "a working copy"),
            Some("remove" | "prune") => p(REMOVE, "a working copy"),
            _ => p(LOOK_AT, "the working copies"),
        },
        "rev-parse" | "rev-list" | "ls-files" | "ls-tree" | "cat-file" | "config" | "describe"
        | "merge-base" | "for-each-ref" | "symbolic-ref" | "name-rev" => p(CHECK, "the repository"),
        "grep" => p(SEARCH, "the code"),
        "bisect" => p(
            V("Hunting for", "Hunted for", "hunt for"),
            "the commit that broke something",
        ),
        "submodule" => p(UPDATE, "submodules"),
        "lfs" => p(DOWNLOAD, "large files"),
        "apply" | "am" => p(APPLY, "a patch"),
        "" => p(RUN, "git"),
        other if plain_word(other) => p(RUN, format!("git {other}")),
        _ => p(RUN, "git"),
    })
}

fn gh(args: &[String]) -> Option<Phrase> {
    let pos = positional(
        args,
        &[
            "-R",
            "--repo",
            "--json",
            "-q",
            "--jq",
            "-t",
            "--template",
            "-b",
            "--body",
            "--title",
            "-B",
            "--base",
            "-H",
            "--head",
            "-l",
            "--label",
            "-L",
            "--limit",
            "-s",
            "--state",
            "-a",
            "--assignee",
            "-X",
            "--method",
            "-f",
            "-F",
            "--field",
            "--raw-field",
            "-H",
            "--header",
            "-w",
            "--workflow",
            "-A",
            "--author",
            "--search",
            "-S",
        ],
    );
    let group = pos.first().copied().unwrap_or("");
    let verb = pos.get(1).copied().unwrap_or("");
    let num = pos
        .get(2)
        .and_then(|w| number(w))
        .or_else(|| pos.get(1).and_then(|w| number(w)));
    let thing = |kind: &str| match num {
        Some(n) => format!("{kind} #{n}"),
        None => format!("a {kind}"),
    };
    let on_github = |v: V, object: String| p(v, format!("{object} on GitHub"));
    Some(match group {
        "pr" => match verb {
            "view" | "" => on_github(LOOK_UP, thing("PR")),
            "list" | "status" => on_github(LOOK_AT, "the pull requests".into()),
            "diff" => p(READ, format!("the changes in {}", thing("PR"))),
            "checks" => {
                let what = format!("the checks on {}", thing("PR"));
                if has_flag(args, &["--watch"]) {
                    slow(p(WATCH, what), Slow::Tests)
                } else {
                    p(CHECK, what)
                }
            }
            "create" | "new" => on_github(OPEN, "a pull request".into()),
            "checkout" | "co" => p(SWITCH, format!("to {}", thing("PR"))),
            "merge" => on_github(MERGE, thing("PR")),
            "comment" => on_github(COMMENT, thing("PR")),
            "review" => on_github(REVIEW, thing("PR")),
            "edit" | "ready" => on_github(UPDATE, thing("PR")),
            "close" => on_github(CLOSE, thing("PR")),
            "reopen" => on_github(V("Reopening", "Reopened", "reopen"), thing("PR")),
            _ => on_github(V("Working on", "Worked on", "work on"), thing("PR")),
        },
        "issue" => match verb {
            "view" | "" => on_github(LOOK_UP, thing("issue")),
            "list" | "status" => on_github(LOOK_AT, "the issues".into()),
            "create" | "new" => on_github(OPEN, "an issue".into()),
            "comment" => on_github(COMMENT, thing("issue")),
            "close" => on_github(CLOSE, thing("issue")),
            "edit" => on_github(UPDATE, thing("issue")),
            _ => on_github(V("Working on", "Worked on", "work on"), thing("issue")),
        },
        "run" => match verb {
            "watch" => slow(p(WATCH, "a GitHub Actions run"), Slow::Tests),
            "view" => p(LOOK_AT, "a GitHub Actions run"),
            "rerun" => p(V("Re-running", "Re-ran", "re-run"), "a GitHub Actions run"),
            "download" => p(DOWNLOAD, "files from a GitHub Actions run"),
            _ => p(CHECK, "the GitHub Actions runs"),
        },
        "workflow" => match verb {
            "run" => p(START, "a GitHub Actions workflow"),
            _ => p(LOOK_AT, "the GitHub Actions workflows"),
        },
        "repo" => match verb {
            "clone" => slow(p(COPY, "a repository from GitHub"), Slow::Install),
            "create" => on_github(CREATE, "a repository".into()),
            "fork" => on_github(V("Forking", "Forked", "fork"), "a repository".into()),
            _ => on_github(LOOK_UP, "a repository".into()),
        },
        "release" => match verb {
            "create" | "upload" | "edit" => {
                on_github(V("Publishing", "Published", "publish"), "a release".into())
            }
            _ => on_github(LOOK_AT, "the releases".into()),
        },
        "auth" => p(CHECK, "the GitHub sign-in"),
        "search" => p(SEARCH, "GitHub"),
        "browse" => p(OPEN, "GitHub"),
        "gist" => on_github(
            V("Working with", "Worked with", "work with"),
            "a gist".into(),
        ),
        "label" => on_github(V("Managing", "Managed", "manage"), "labels".into()),
        "secret" | "variable" => on_github(
            V("Managing", "Managed", "manage"),
            "repository settings".into(),
        ),
        "api" => gh_api(args, verb),
        _ => p(V("Working in", "Worked in", "work in"), "GitHub"),
    })
}

fn gh_api(args: &[String], path: &str) -> Phrase {
    let method = args
        .iter()
        .position(|a| a == "-X" || a == "--method")
        .and_then(|i| args.get(i + 1))
        .map(|m| m.to_ascii_uppercase())
        .or_else(|| {
            args.iter()
                .find_map(|a| {
                    a.strip_prefix("--method=")
                        .or_else(|| a.strip_prefix("-X"))
                        .filter(|m| !m.is_empty())
                })
                .map(|m| m.to_ascii_uppercase())
        });
    let fields = has_flag(args, &["-f", "-F", "--field", "--raw-field", "--input"]);
    let writes = match method.as_deref() {
        Some("GET") => false,
        Some(_) => true,
        None => fields && path != "graphql",
    };
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let after = |name: &str| {
        segs.iter()
            .position(|s| *s == name)
            .and_then(|i| segs.get(i + 1))
            .and_then(|n| n.parse::<u64>().ok())
    };
    let subject = if let Some(n) = after("pulls") {
        Some(format!("PR #{n}"))
    } else {
        after("issues").map(|n| format!("issue #{n}"))
    };
    let tail = segs.last().copied().unwrap_or("");
    match (subject, writes) {
        (Some(s), true) if tail == "comments" || tail == "reviews" => {
            p(COMMENT, format!("{s} on GitHub"))
        }
        (Some(s), true) => p(UPDATE, format!("{s} on GitHub")),
        (Some(s), false) if tail == "comments" || tail == "reviews" => {
            p(READ, format!("the comments on {s}"))
        }
        (Some(s), false) if tail == "files" => p(READ, format!("the files changed in {s}")),
        (Some(s), false) if tail == "commits" => p(READ, format!("the commits in {s}")),
        (Some(s), false) => p(LOOK_UP, format!("{s} on GitHub")),
        (None, true) => p(SEND, "a change to GitHub"),
        (None, false) if segs.contains(&"actions") => p(CHECK, "the GitHub Actions runs"),
        (None, false) if segs.contains(&"notifications") => p(CHECK, "GitHub notifications"),
        (None, false) => p(LOOK_UP, "something on GitHub"),
    }
}

fn fetch(program: &str, args: &[String]) -> Option<Phrase> {
    let pos = positional(
        args,
        &[
            "-X",
            "--request",
            "-H",
            "--header",
            "-d",
            "--data",
            "--data-raw",
            "--data-binary",
            "-F",
            "--form",
            "-o",
            "--output",
            "-u",
            "--user",
            "-A",
            "--user-agent",
            "-e",
            "--referer",
            "-b",
            "--cookie",
            "-w",
            "--write-out",
            "-m",
            "--max-time",
            "--connect-timeout",
            "--retry",
            "-O",
            "--json",
            "-T",
            "--upload-file",
        ],
    );
    let host = pos.iter().find_map(|w| host_of(w));
    let method = args
        .iter()
        .position(|a| a == "-X" || a == "--request")
        .and_then(|i| args.get(i + 1))
        .map(|m| m.to_ascii_uppercase());
    let sends = matches!(method.as_deref(), Some(m) if m != "GET" && m != "HEAD")
        || has_flag(
            args,
            &[
                "-d",
                "--data",
                "--data-raw",
                "--data-binary",
                "-F",
                "--form",
                "--json",
                "-T",
                "--upload-file",
            ],
        );
    let head = has_flag(args, &["-I", "--head"]) || method.as_deref() == Some("HEAD");
    let downloads = program == "wget" || has_flag(args, &["-o", "--output", "-O"]);
    let target = host.unwrap_or_else(|| "a web address".to_string());
    Some(if sends {
        p(SEND, format!("a request to {target}"))
    } else if head {
        p(CHECK, target)
    } else if downloads {
        p(DOWNLOAD, format!("from {target}"))
    } else {
        p(V("Fetching", "Fetched", "fetch"), target)
    })
}

fn docker(args: &[String]) -> Option<Phrase> {
    let pos = positional(
        args,
        &[
            "-f",
            "--file",
            "-t",
            "--tag",
            "-p",
            "-v",
            "-e",
            "--name",
            "-w",
            "--network",
            "--platform",
        ],
    );
    Some(match pos.first().copied().unwrap_or("") {
        "build" | "buildx" => slow(p(BUILD, "a Docker image"), Slow::Build),
        "run" => p(RUN, "a Docker container"),
        "compose" => return compose(&args[args.iter().position(|a| a == "compose")? + 1..]),
        "ps" | "images" | "inspect" | "stats" => p(CHECK, "the Docker containers"),
        "logs" => p(READ, "the Docker logs"),
        "exec" => p(RUN, "a command in a Docker container"),
        "pull" => slow(p(DOWNLOAD, "a Docker image"), Slow::Install),
        "push" => slow(p(UPLOAD, "a Docker image"), Slow::Deploy),
        "stop" | "kill" | "rm" | "down" => p(STOP, "a Docker container"),
        "start" | "restart" => p(START, "a Docker container"),
        _ => p(RUN, "Docker"),
    })
}

fn compose(args: &[String]) -> Option<Phrase> {
    let pos = positional(args, &["-f", "--file", "-p", "--project-name", "--profile"]);
    Some(match pos.first().copied().unwrap_or("") {
        "up" => slow(p(START, "the Docker services"), Slow::Build),
        "down" | "stop" => p(STOP, "the Docker services"),
        "build" => slow(p(BUILD, "the Docker services"), Slow::Build),
        "logs" => p(READ, "the Docker logs"),
        "ps" => p(CHECK, "the Docker services"),
        "exec" | "run" => p(RUN, "a command in a Docker container"),
        "pull" => slow(p(DOWNLOAD, "Docker images"), Slow::Install),
        "restart" => p(START, "the Docker services again"),
        _ => p(RUN, "Docker Compose"),
    })
}

// ============================================================================
// A whole line
// ============================================================================

/// A command line in plain words. `None` when there is nothing to say
/// (an empty line, only `cd` and `export`), and the caller says "a command".
pub fn describe(command: &str, depth: u8) -> Option<Phrase> {
    let cmds = commands(command);
    let mut best: Option<(u8, usize, Phrase)> = None;
    for (index, cmd) in cmds.iter().enumerate() {
        // What reads another command's output only shapes it (`| tail -20`).
        if cmd.piped {
            continue;
        }
        let Some((mut phrase, mut trivial)) = describe_cmd(&cmd.words, depth) else {
            continue;
        };
        // `echo hi > note.txt`, `cat > a.json <<EOF`: what it does is write that file.
        let writer = matches!(
            cmd.words.first().map(|w| file_name(w)),
            Some("echo" | "printf" | "cat" | "tee")
        );
        if let (true, Some(file)) = (writer, cmd.into.as_deref()) {
            if !file.starts_with("/dev/") {
                phrase = match plain_file(file) {
                    Some(name) => p(WRITE, name),
                    None => p(WRITE, "a file"),
                };
                trivial = false;
            }
        }
        if let Some(times) = cmd.times {
            let tail = match times {
                Some(1) => String::new(),
                Some(n) => format!(", {n} times"),
                None => ", repeatedly".to_string(),
            };
            // A number a loop fills in isn't one: "PR #$n" can't happen, but
            // a loop's own count says how many.
            phrase.doing.push_str(&tail);
            phrase.done.push_str(&tail);
            phrase.ask.push_str(&tail);
        }
        let w = weight(&phrase, trivial);
        // The weightiest; of equals, the first (what the line is for usually
        // comes first: `npm test 2>&1; echo done`).
        if best.as_ref().is_none_or(|(bw, _, _)| w > *bw) {
            best = Some((w, index, phrase));
        }
    }
    best.map(|(_, _, phrase)| phrase)
}

#[cfg(test)]
#[path = "describe_tests.rs"]
mod tests;
