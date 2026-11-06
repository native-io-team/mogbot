//! "Full send": what the turn sent without asking, said once.
//!
//! At "Full send" sending, posting, scheduling, commenting and publishing
//! what the user asked for run without a card (`go_hard`, `browser_gate`).
//! Nothing happens invisibly: each one leaves its own line in "What it did"
//! (`mcp::decide`, "Sent without asking — Full send · …"), and at the end of
//! the turn the chat gets one plain line saying what went out where
//! ([`take_summary`]: "Without asking: posted 3 times on x.com, pushed 1
//! branch").
//!
//! A call counts here when "Full send" let it through and "Go hard" would
//! have asked: exactly the things the user would otherwise have seen a card
//! for. Kept in memory per agent, for the turn in progress.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// (what, where) → how many, in the order first seen.
type Ledger = Vec<((&'static str, String), usize)>;

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
pub fn note(agent_id: &str, what: &'static str, place: &str) {
    with(|m| {
        let ledger = m.entry(agent_id.to_string()).or_default();
        let key = (what, place.to_string());
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
                format!("{what}{times} {place}")
            }
        })
        .collect();
    Some(format!("Without asking (Full send): {}.", parts.join(", ")))
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

/// What a command or connector call sent, and where, for the summary.
pub fn describe(tool: &str, input: &Value) -> (&'static str, String) {
    if tool == "Bash" {
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        for words in super::go_hard::commands(command) {
            let prog = words
                .iter()
                .find(|w| !w.contains('='))
                .map(|w| w.rsplit('/').next().unwrap_or(w).to_string())
                .unwrap_or_default();
            let has = |w: &str| words.iter().any(|x| x == w);
            match prog.as_str() {
                "git" if has("push") => return ("pushed", "a branch".into()),
                "git" if has("send-email") => return ("emailed", "a patch".into()),
                "gh" if has("comment") => return ("commented", "on GitHub".into()),
                "gh" if has("create") => return ("opened", "on GitHub".into()),
                "gh" => return ("updated", "on GitHub".into()),
                "mail" | "mailx" | "sendmail" | "mutt" | "msmtp" | "neomutt" | "swaks" => {
                    return ("sent", "an email".into())
                }
                "osascript" => return ("sent", "a message".into()),
                "curl" | "wget" | "http" | "https" | "xh" | "xhs" => {
                    let host = words
                        .iter()
                        .find_map(|w| super::browser_gate::host_of(w))
                        .map(|h| format!("to {h}"))
                        .unwrap_or_default();
                    return ("sent a request", host);
                }
                "vercel" => return ("deployed", "a preview".into()),
                p if !p.is_empty() && super::go_hard::is_messenger(p) => {
                    return ("sent", "a message".into())
                }
                _ => {}
            }
        }
        return ("ran", "a command that sends".into());
    }
    if let Some(rest) = tool.strip_prefix("mcp__") {
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
        return (verb, format!("in {}", super::mcp::service_name(server)));
    }
    ("did", "something that sends".into())
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
        note(id, "pushed", "a branch");
        assert_eq!(
            take_summary(id).as_deref(),
            Some("Without asking (Full send): posted 3 times on x.example, pushed a branch.")
        );
        assert_eq!(take_summary(id), None, "taken once");
    }

    #[test]
    fn verbs_come_from_what_was_clicked_or_run() {
        assert_eq!(browser_verb("button \"Post\""), "posted");
        assert_eq!(browser_verb("button \"Schedule post\""), "scheduled");
        assert_eq!(browser_verb("button \"Send\""), "sent");
        let push = json!({ "command": "git push -u origin fix/copy" });
        assert_eq!(describe("Bash", &push).0, "pushed");
        let mail = json!({ "command": "mail -s hi sam@example.com < note.txt" });
        assert_eq!(describe("Bash", &mail).0, "sent");
    }
}
