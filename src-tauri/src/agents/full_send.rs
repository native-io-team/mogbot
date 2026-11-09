//! "Full send": what the turn sent without asking, said once.
//!
//! At "Full send" sending, posting, scheduling, commenting and publishing
//! what the user asked for run without a card (`go_hard`, `browser_gate`).
//! Nothing happens invisibly: each one leaves its own line in "What it did"
//! (`mcp::decide`, "Sent without asking — Full send · …"), and at the end of
//! the turn the chat gets one plain line saying what went out where
//! ([`take_summary`]: "Without asking (Full send): posted on x.com 3 times,
//! pushed branch fix/copy").
//!
//! The line names what happened, read from the command or the tool and its
//! arguments ([`describe`]): "pushed branch fix/copy", "posted in #launch",
//! "created a Vercel bypass token on fictional-site". When nothing better
//! can be read it says the command's first words ("ran “deploy-tool
//! sync”"), never a vague "a command that sends".
//!
//! A call counts here when "Full send" let it through and "Go hard" would
//! have asked: exactly the things the user would otherwise have seen a card
//! for. Kept in memory per agent, for the turn in progress.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::autoallow::Ctx;
use super::go_hard;

/// (what, where) → how many, in the order first seen.
type Ledger = Vec<((String, String), usize)>;

static SENT: Mutex<Option<HashMap<String, Ledger>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashMap<String, Ledger>) -> T) -> T {
    let mut guard = SENT.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// A turn starts: nothing sent yet.
pub fn begin(agent_id: &str) {
    with(|m| m.remove(agent_id));
}

/// One thing sent without a card.
pub fn note(agent_id: &str, what: &str, place: &str) {
    with(|m| {
        let ledger = m.entry(agent_id.to_string()).or_default();
        let key = (what.to_string(), place.to_string());
        match ledger.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => ledger.push((key, 1)),
        }
    });
}

/// The chat's one line for the turn, and the ledger cleared.
pub fn take_summary(agent_id: &str) -> Option<String> {
    let ledger = with(|m| m.remove(agent_id))?;
    summary(&ledger)
}

fn summary(ledger: &Ledger) -> Option<String> {
    if ledger.is_empty() {
        return None;
    }
    let parts: Vec<String> = ledger
        .iter()
        .map(|((what, place), n)| {
            let times = if *n == 1 {
                String::new()
            } else {
                format!(" {n} times")
            };
            if place.is_empty() {
                format!("{what}{times}")
            } else {
                format!("{what} {place}{times}")
            }
        })
        .collect();
    Some(format!("Without asking (Unleashed): {}.", parts.join(", ")))
}

/// What a browser control did, from its label: "posted", "scheduled"…
pub fn browser_verb(label: &str) -> &'static str {
    let lower = label.to_ascii_lowercase();
    let has = |w: &str| {
        lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|x| x == w)
    };
    if has("schedule") {
        "scheduled"
    } else if has("post") || has("tweet") || has("repost") {
        "posted"
    } else if has("reply") || has("comment") {
        "replied"
    } else if has("publish") {
        "published"
    } else if has("share") {
        "shared"
    } else if has("send") || has("forward") {
        "sent"
    } else if has("delete") || has("remove") || has("trash") {
        "deleted"
    } else {
        "submitted"
    }
}

fn clip(text: &str, n: usize) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n {
        t.chars().take(n).collect::<String>() + "…"
    } else {
        t
    }
}

/// The value after any of `names` (`--title x` or `--title=x`).
fn flag_value<'a>(args: &[&'a str], names: &[&str]) -> Option<&'a str> {
    args.iter().enumerate().find_map(|(i, a)| {
        if names.contains(a) {
            return args.get(i + 1).copied();
        }
        names.iter().find_map(|n| {
            n.starts_with("--")
                .then(|| a.strip_prefix(&format!("{n}=")))
                .flatten()
        })
    })
}

/// What a command or connector call sent, and where, for the summary: the
/// command (or tool) and its arguments in plain words. `ctx`: the turn's
/// folders, to read the branch a bare `git push` pushes.
pub fn describe(tool: &str, input: &Value, ctx: Option<&Ctx>) -> (String, String) {
    if tool == "Bash" {
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        return describe_command(command, ctx);
    }
    if let Some(rest) = tool.strip_prefix("mcp__") {
        return describe_connector(rest, input);
    }
    ("did".into(), "something that sends".into())
}

fn describe_command(command: &str, ctx: Option<&Ctx>) -> (String, String) {
    let mut cwd: Option<PathBuf> = ctx.map(|c| c.cwd.clone());
    let mut fallback: Option<Vec<String>> = None;
    let mut first: Option<Vec<String>> = None;
    for words in go_hard::commands(command) {
        if words.first().map(String::as_str) == Some("cd") {
            if let (Some(c), Some(d)) = (ctx, words.get(1)) {
                let here = Ctx {
                    cwd: cwd.clone().unwrap_or_else(|| c.cwd.clone()),
                    ..c.clone()
                };
                if let Some(dir) = go_hard::resolve(d, &here) {
                    cwd = Some(dir);
                }
            }
            continue;
        }
        let w: Vec<&str> = words.iter().map(String::as_str).collect();
        let rest = runner_stripped(go_hard::unwrapped(&w));
        let Some((prog, args)) = rest.split_first() else {
            continue;
        };
        let prog = go_hard::base(prog);
        if let Some(d) = command_words(prog, args, cwd.as_deref()) {
            return d;
        }
        let shown: Vec<String> = rest.iter().map(|s| s.to_string()).collect();
        if first.is_none() {
            first = Some(shown.clone());
        }
        let asks = ctx.is_some_and(|c| {
            let here = Ctx {
                cwd: cwd.clone().unwrap_or_else(|| c.cwd.clone()),
                ..c.clone()
            };
            go_hard::words_ask_at_go_hard(&words, &here)
        });
        if fallback.is_none() && asks {
            fallback = Some(shown);
        }
    }
    let words = fallback.or(first).unwrap_or_else(|| {
        command
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    let head: Vec<&str> = words.iter().take(3).map(String::as_str).collect();
    if head.is_empty() {
        return ("ran".into(), "a command".into());
    }
    (
        format!("ran “{}”", clip(&head.join(" "), 60)),
        String::new(),
    )
}

/// `npx vercel …` is `vercel …`.
fn runner_stripped<'a, 'b>(rest: &'a [&'b str]) -> &'a [&'b str] {
    match rest.first().map(|p| go_hard::base(p)) {
        Some("npx" | "pnpx" | "bunx" | "uvx") => {
            let mut r = &rest[1..];
            while r.first().is_some_and(|w| w.starts_with('-')) {
                r = &r[1..];
            }
            r
        }
        _ => rest,
    }
}

/// Plain words for the commands that send, when they can be read.
fn command_words(prog: &str, args: &[&str], cwd: Option<&Path>) -> Option<(String, String)> {
    match prog {
        "git" => git_words(args, cwd),
        "gh" => Some(gh_words(args)),
        "vercel" => Some(vercel_words(args, cwd)),
        "mail" | "mailx" | "sendmail" | "mutt" | "msmtp" | "neomutt" | "swaks" => {
            let to = flag_value(args, &["--to", "-t"])
                .filter(|t| t.contains('@'))
                .or_else(|| {
                    args.iter()
                        .copied()
                        .find(|a| !a.starts_with('-') && a.contains('@'))
                });
            Some(match to {
                Some(t) => ("emailed".into(), clip(t, 60)),
                None => ("sent an email".into(), String::new()),
            })
        }
        "osascript" => {
            let text = args.join(" ").to_ascii_lowercase();
            Some(if text.contains("\"messages\"") {
                ("sent a message".into(), "with Messages".into())
            } else if text.contains("\"mail\"") || text.contains("mail.app") {
                ("sent an email".into(), "with Mail".into())
            } else {
                ("ran an AppleScript that sends".into(), String::new())
            })
        }
        "curl" | "wget" | "http" | "https" | "xh" | "xhs" => {
            let host = args
                .iter()
                .find_map(|w| super::browser_gate::host_of(w))
                .map(|h| format!("to {h}"))
                .unwrap_or_default();
            let method = flag_value(args, &["-X", "--request", "--method"])
                .map(str::to_ascii_uppercase)
                .or_else(|| {
                    args.iter()
                        .find(|a| {
                            matches!(
                                a.to_ascii_uppercase().as_str(),
                                "POST" | "PUT" | "PATCH" | "DELETE"
                            )
                        })
                        .map(|a| a.to_ascii_uppercase())
                })
                .unwrap_or_else(|| "POST".into());
            Some((format!("sent a {method} request"), host))
        }
        p if go_hard::is_messenger(p) => {
            let channel = flag_value(args, &["--channel", "-c", "--chat", "--to"]).or_else(|| {
                args.iter()
                    .copied()
                    .find(|a| a.starts_with('#') && a.len() > 1)
            });
            Some(match channel {
                Some(c) => ("posted".into(), format!("in {}", clip(c, 40))),
                None => ("sent a message".into(), format!("with {p}")),
            })
        }
        _ => None,
    }
}

fn git_words(args: &[&str], cwd: Option<&Path>) -> Option<(String, String)> {
    let mut i = 0;
    let mut dir: Option<PathBuf> = None;
    while i < args.len() {
        let a = args[i];
        if a == "-C" {
            dir = args.get(i + 1).map(PathBuf::from);
            i += 2;
        } else if matches!(a, "-c" | "--git-dir" | "--work-tree" | "--namespace") {
            i += 2;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            break;
        }
    }
    let rest = args.get(i + 1..).unwrap_or(&[]);
    match args.get(i).copied() {
        Some("push") => {
            const TAKES: &[&str] = &["-o", "--push-option", "--repo", "--receive-pack", "--exec"];
            let mut pos = Vec::new();
            let mut j = 0;
            while j < rest.len() {
                if TAKES.contains(&rest[j]) {
                    j += 2;
                    continue;
                }
                if !rest[j].starts_with('-') {
                    pos.push(rest[j]);
                }
                j += 1;
            }
            let named = pos.get(1).map(|r| {
                let r = r.trim_start_matches('+');
                let d = r.rsplit_once(':').map(|(_, d)| d).unwrap_or(r);
                d.strip_prefix("refs/heads/").unwrap_or(d).to_string()
            });
            let branch = named
                .filter(|b| !b.is_empty() && b != "HEAD" && b != "@")
                .or_else(|| {
                    let at = match (&dir, cwd) {
                        (Some(d), Some(c)) if d.is_relative() => Some(c.join(d)),
                        (Some(d), _) => Some(d.clone()),
                        (None, c) => c.map(Path::to_path_buf),
                    };
                    at.and_then(|p| go_hard::current_branch(&p))
                });
            Some(match branch {
                Some(b) => ("pushed branch".into(), clip(&b, 60)),
                None => ("pushed".into(), "a branch".into()),
            })
        }
        Some("send-email") => {
            let to = flag_value(rest, &["--to"]);
            Some((
                "emailed a patch".into(),
                to.map(|t| format!("to {}", clip(t, 60)))
                    .unwrap_or_default(),
            ))
        }
        _ => None,
    }
}

fn gh_words(args: &[&str]) -> (String, String) {
    let pos = go_hard::positional(args);
    let group = pos.first().copied().unwrap_or("");
    let action = pos.get(1).copied().unwrap_or("");
    let place = flag_value(args, &["-R", "--repo"])
        .map(|r| format!("in {r}"))
        .unwrap_or_else(|| "on GitHub".into());
    let num = pos
        .get(2)
        .map(|n| n.trim_start_matches('#'))
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        .map(|n| format!(" #{n}"))
        .unwrap_or_default();
    let title = flag_value(args, &["-t", "--title"]).map(|t| clip(t, 60));
    let what = match (group, action) {
        ("pr", "create") => match title {
            Some(t) => format!("opened pull request “{t}”"),
            None => "opened a pull request".into(),
        },
        ("issue", "create") => match title {
            Some(t) => format!("opened issue “{t}”"),
            None => "opened an issue".into(),
        },
        ("pr", "comment") => format!("commented on pull request{num}"),
        ("issue", "comment") => format!("commented on issue{num}"),
        ("pr", "review") => format!("reviewed pull request{num}"),
        ("pr", "edit") => format!("edited pull request{num}"),
        ("issue", "edit") => format!("edited issue{num}"),
        ("pr", "close") => format!("closed pull request{num}"),
        ("issue", "close") => format!("closed issue{num}"),
        ("pr", "reopen") => format!("reopened pull request{num}"),
        ("issue", "reopen") => format!("reopened issue{num}"),
        ("pr", "ready") => format!("marked pull request{num} ready"),
        ("release", "create") => match pos.get(2) {
            Some(tag) => format!("released {}", clip(tag, 40)),
            None => "made a release".into(),
        },
        ("gist", "create") => "created a gist".into(),
        ("repo", "create") => match pos.get(2) {
            Some(r) => format!("created repo {}", clip(r, 60)),
            None => "created a repo".into(),
        },
        ("api", _) => {
            let path = go_hard::gh_api_path(args);
            let method = flag_value(args, &["-X", "--method"])
                .map(str::to_ascii_uppercase)
                .unwrap_or_else(|| "POST".into());
            return (
                format!("called GitHub's API ({method} {})", clip(path, 80)),
                String::new(),
            );
        }
        (g, a) => clip(&format!("ran gh {g} {a}"), 60),
    };
    (what, place)
}

/// The Vercel project a call names: `/projects/<name>/…` in an API path,
/// `--project`, or the folder's own link (`.vercel/project.json`).
fn vercel_project(args: &[&str], path: &str, cwd: Option<&Path>) -> Option<String> {
    let segs: Vec<&str> = path.split(['/', '?']).filter(|s| !s.is_empty()).collect();
    segs.iter()
        .position(|s| *s == "projects")
        .and_then(|i| segs.get(i + 1))
        .map(|s| s.to_string())
        .or_else(|| flag_value(args, &["--project"]).map(str::to_string))
        .or_else(|| {
            let text = std::fs::read_to_string(cwd?.join(".vercel/project.json")).ok()?;
            let v: Value = serde_json::from_str(&text).ok()?;
            v.get("projectName")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn vercel_words(args: &[&str], cwd: Option<&Path>) -> (String, String) {
    let words = go_hard::vercel_words(args);
    let sub = words.first().copied().unwrap_or("");
    match sub {
        "curl" | "api" => {
            let path = words.get(1).copied().unwrap_or("/");
            let lower = path.to_ascii_lowercase();
            let method = flag_value(args, &["-X", "--request", "--method"])
                .map(str::to_ascii_uppercase)
                .unwrap_or_else(|| {
                    let body = args
                        .iter()
                        .any(|a| a.starts_with("--data") || *a == "-d" || *a == "--json");
                    if body { "POST" } else { "GET" }.into()
                });
            let project = vercel_project(args, path, cwd)
                .map(|p| format!("on {}", clip(&p, 60)))
                .unwrap_or_default();
            if lower.contains("bypass") && method != "GET" && method != "DELETE" {
                return ("created a Vercel bypass token".into(), project);
            }
            if lower.contains("protection") && method != "GET" {
                return ("changed Vercel deployment protection".into(), project);
            }
            (
                format!("called Vercel's API ({method} {})", clip(path, 80)),
                String::new(),
            )
        }
        "" | "deploy" => {
            let project = vercel_project(args, "", cwd)
                .map(|p| format!("of {}", clip(&p, 60)))
                .unwrap_or_default();
            ("deployed a preview".into(), project)
        }
        other => (clip(&format!("ran vercel {other}"), 60), String::new()),
    }
}

fn describe_connector(rest: &str, input: &Value) -> (String, String) {
    let mut parts = rest.split("__");
    let server = parts.next().unwrap_or("");
    let name = parts.last().unwrap_or("").to_ascii_lowercase();
    let verb = if name.contains("schedule") {
        "scheduled"
    } else if name.contains("post") || name.contains("tweet") || name.contains("publish") {
        "posted"
    } else if name.contains("reply") || name.contains("comment") {
        "replied"
    } else if name.contains("send") || name.contains("forward") {
        "sent"
    } else {
        "updated"
    };
    let service = super::mcp::service_name(server);
    let field = |keys: &[&str]| {
        keys.iter().find_map(|k| {
            input
                .get(*k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| clip(v, 40))
        })
    };
    let place = if let Some(c) = field(&["channel", "channel_name", "channel_id", "chat"]) {
        format!("in {c} on {service}")
    } else if let Some(to) = field(&["to", "recipient", "recipients", "email"]) {
        format!("to {to} on {service}")
    } else {
        format!("in {service}")
    };
    (verb.to_string(), place)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_plain_line_for_the_turn() {
        let id = "fictional-full-send-ledger";
        begin(id);
        assert_eq!(take_summary(id), None);
        note(id, "posted", "on x.example");
        note(id, "posted", "on x.example");
        note(id, "posted", "on x.example");
        note(id, "pushed branch", "fix/copy");
        assert_eq!(
            take_summary(id).as_deref(),
            Some(
                "Without asking (Unleashed): posted on x.example 3 times, pushed branch fix/copy."
            )
        );
        assert_eq!(take_summary(id), None, "taken once");
    }

    #[test]
    fn verbs_come_from_what_was_clicked_or_run() {
        assert_eq!(browser_verb("button \"Post\""), "posted");
        assert_eq!(browser_verb("button \"Schedule post\""), "scheduled");
        assert_eq!(browser_verb("button \"Send\""), "sent");
    }

    fn said(command: &str) -> String {
        let (what, place) = describe("Bash", &json!({ "command": command }), None);
        if place.is_empty() {
            what
        } else {
            format!("{what} {place}")
        }
    }

    /// What happened, by name. Observed: a protection bypass token made with
    /// `vercel curl` was summed up as "ran a command that sends".
    #[test]
    fn the_summary_names_what_happened() {
        for (command, line) in [
            (
                "npx vercel curl -X POST /v1/projects/fictional-site/protection-bypass",
                "created a Vercel bypass token on fictional-site",
            ),
            (
                "vercel curl /v9/projects/fictional-site --method PATCH -d '{}'",
                "called Vercel's API (PATCH /v9/projects/fictional-site)",
            ),
            ("git push -u origin fix/copy", "pushed branch fix/copy"),
            (
                "cd site && git push origin HEAD:refs/heads/fix/nav",
                "pushed branch fix/nav",
            ),
            (
                "slack chat send --channel '#launch' --text 'Live'",
                "posted in #launch",
            ),
            (
                "mail -s hi sam@example.com < note.txt",
                "emailed sam@example.com",
            ),
            (
                "gh pr comment 12 --body 'Fixed in 3e1'",
                "commented on pull request #12 on GitHub",
            ),
            (
                "gh issue create -R fictional/site --title 'Broken nav' --body x",
                "opened issue “Broken nav” in fictional/site",
            ),
            (
                "curl -X POST https://hooks.example.com/notify -d '{}'",
                "sent a POST request to hooks.example.com",
            ),
            (
                "git send-email --to=list@example.com 0001.patch",
                "emailed a patch to list@example.com",
            ),
            (
                "osascript -e 'tell application \"Messages\" to send \"hi\" to buddy \"Sam\"'",
                "sent a message with Messages",
            ),
        ] {
            assert_eq!(said(command), line, "{command}");
        }
        // Nothing better to say: the command's first words.
        assert_eq!(
            said("fictional-cli broadcast --all now"),
            "ran “fictional-cli broadcast --all”"
        );
        assert!(!said("anything").contains("a command that sends"));
    }

    #[test]
    fn a_connector_says_where() {
        let (what, place) = describe(
            "mcp__claude_ai_Slack__post_message",
            &json!({ "channel": "#launch", "text": "Live" }),
            None,
        );
        assert_eq!(what, "posted");
        assert!(place.starts_with("in #launch on "), "{place}");
    }
}
