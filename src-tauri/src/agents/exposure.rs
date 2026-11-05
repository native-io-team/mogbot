//! A turn that read outside content asks before it sends, or runs new code.
//!
//! "Go hard" answers local work, network reads and installs without a card.
//! That is the user's choice for *their* work; text the agent reads from
//! outside (a web page, a search result, an email or chat message through a
//! connection, issue and pull request comments, a page in the browser on
//! someone else's site) shouldn't be able to ride on it off this Mac. So the
//! first time a turn reads any of that, it is marked ([`note`]), and for the
//! rest of that turn two things ask on a card even at "Go hard"
//! (`autoallow::after_outside_asks`, from `mcp::decide`): sending anything
//! to the network beyond a read (a `curl` body or upload, a non-GET, a `gh`
//! write, `git push`, `ssh`/`scp`/`rsync`…, to anywhere but this Mac), and
//! fetching and running a package the project doesn't have yet. Everything
//! else — reading and clicking in the browser, local work, builds, project
//! installs, network reads — goes on as before. The timeline says so once,
//! quietly ([`LINE`]).
//!
//! Turns that never read outside content are untouched. Marks are seen three
//! ways, whichever comes first: every call `mcp::decide` lets through, every
//! call through the connection relay, and every tool call in the engine's
//! stream (calls the engine runs without asking, like Codex's web search).
//! The next turn starts clean ([`begin`]).
//!
//! This is much narrower than a turn answering outside text
//! (`runner::from_outside`, a "When…" routine's items), which is capped at
//! "Use good judgement" and also loses the browser, its memory and the team
//! tools.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

use super::independence::Level;

/// The quiet line in the timeline when a turn is marked.
pub const LINE: &str =
    "Asking before it sends anything or runs a new package, because it read outside content";

/// Agents whose turn in progress read outside content.
static MARKED: Mutex<Option<HashMap<String, ()>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashMap<String, ()>) -> T) -> T {
    let mut guard = MARKED.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// A turn starts: nothing read yet.
pub fn begin(agent_id: &str) {
    with(|m| m.remove(agent_id));
}

/// Whether the agent's turn in progress read outside content.
pub fn read_outside(agent_id: &str) -> bool {
    with(|m| m.contains_key(agent_id))
}

/// Mark the turn; `true` the first time.
fn mark(agent_id: &str) -> bool {
    with(|m| m.insert(agent_id.to_string(), ()).is_none())
}

/// Whether a call reads content from outside this Mac. `page`: the page the
/// browser call acts on, when known.
pub fn reads_outside(tool: &str, input: &Value, page: Option<&str>) -> bool {
    let field = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "WebFetch" | "WebSearch" | "web_search" | "web_fetch" => true,
        "Bash" => super::autoallow::command_reads_outside(field("command")),
        _ if tool.starts_with(super::browser_gate::SERVER) => {
            browser_reads_outside(&tool[super::browser_gate::SERVER.len()..], input, page)
        }
        // claude.ai connectors: mail, chat, documents from other people.
        _ if tool.starts_with("mcp__claude_ai_") => true,
        _ => false,
    }
}

/// A browser call that shows the agent a page that isn't this Mac's own
/// (the project's preview, `localhost`). An unknown page counts as outside.
fn browser_reads_outside(name: &str, input: &Value, page: Option<&str>) -> bool {
    let reads = match name {
        "get_page_text"
        | "read_page"
        | "find"
        | "read_console_messages"
        | "read_network_requests"
        | "browser_batch" => true,
        "navigate" | "tabs_create_mcp" => {
            return input
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|u| super::autoallow::remote_url(u.trim()))
        }
        "computer" => matches!(
            input.get("action").and_then(Value::as_str),
            Some("screenshot" | "zoom")
        ),
        _ => false,
    };
    reads && !page.is_some_and(own_page)
}

/// The project's preview or another page served from this Mac.
fn own_page(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("file:") || lower.starts_with("about:") {
        return true;
    }
    url::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(super::autoallow::local_host))
        .unwrap_or(false)
}

/// A call the turn made (or was allowed to make): mark the turn when it
/// read outside content, and say so once, when it changes anything (the
/// agent runs at "Go hard" and its turn isn't capped already).
pub fn note(agent_id: &str, tool: &str, input: &Value) {
    if read_outside(agent_id) {
        return;
    }
    let page = tool
        .starts_with(super::browser_gate::SERVER)
        .then(|| super::browser_gate::url_of(agent_id, input))
        .flatten();
    let ours = format!("mcp__{}__", super::prompts::SERVER_KEY);
    let outside = reads_outside(tool, input, page.as_deref())
        || (tool.starts_with("mcp__")
            && !tool.starts_with(&ours)
            && !tool.starts_with(super::browser_gate::SERVER)
            && super::connections::is_connection_tool(tool));
    if outside {
        mark_read(agent_id, tool);
    }
}

/// The turn read outside content (`what`): mark it, and say so once.
pub fn mark_read(agent_id: &str, what: &str) {
    if !mark(agent_id) {
        return;
    }
    tracing::info!(agent = agent_id, what, "[Agents] turn read outside content");
    let level = super::store::get(agent_id)
        .map(|a| super::policy::chosen_level(&a))
        .unwrap_or_default();
    if level == Level::GoHard && !super::runner::from_outside(agent_id) {
        super::work::on_step(
            agent_id,
            super::work::StepKind::Approval,
            LINE,
            super::store::now_ms(),
        );
    }
}

/// The tool calls in one line of Claude Code's stream-json.
pub fn observe_claude(agent_id: &str, value: &Value) {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let blocks = value.pointer("/message/content").and_then(Value::as_array);
    for b in blocks.into_iter().flatten() {
        if b.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        if let Some(name) = b.get("name").and_then(Value::as_str) {
            note(agent_id, name, b.get("input").unwrap_or(&Value::Null));
        }
    }
}

/// The item in one Codex event (`exec`'s or the app server's).
pub fn observe_codex(agent_id: &str, value: &Value) {
    let item = value.get("item").or_else(|| value.pointer("/params/item"));
    let Some(item) = item else { return };
    if let Some((name, input)) = super::codex::call(&super::codex_app::as_exec(item)) {
        note(agent_id, &name, &input);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash(c: &str) -> Value {
        json!({ "command": c })
    }

    #[test]
    fn outside_content_is_recognised() {
        for (tool, input, page) in [
            ("WebFetch", json!({ "url": "https://example.test/" }), None),
            ("WebSearch", json!({ "query": "x" }), None),
            ("web_search", json!({ "query": "x" }), None),
            ("Bash", bash("curl -s https://example.test/api"), None),
            ("Bash", bash("wget -qO- https://example.test/"), None),
            (
                "Bash",
                bash("X=$(curl -s https://example.test/a) && echo $X"),
                None,
            ),
            (
                "Bash",
                bash("bash -c 'curl -s https://example.test/'"),
                None,
            ),
            (
                "Bash",
                bash("gh issue view 12 --repo FictionalOrg/site"),
                None,
            ),
            ("Bash", bash("gh pr view 12 --comments"), None),
            ("Bash", bash("gh pr view 12 --json reviews,comments"), None),
            (
                "Bash",
                bash("gh api repos/FictionalOrg/site/pulls/12/comments"),
                None,
            ),
            (
                "Bash",
                bash("git clone https://example.test/fictional/repo.git"),
                None,
            ),
            ("mcp__claude_ai_Gmail__search_threads", json!({}), None),
            (
                "mcp__claude-in-chrome__get_page_text",
                json!({ "tabId": 1 }),
                Some("https://mail.example.test/inbox"),
            ),
            (
                "mcp__claude-in-chrome__get_page_text",
                json!({ "tabId": 1 }),
                None,
            ),
            (
                "mcp__claude-in-chrome__computer",
                json!({ "action": "screenshot" }),
                Some("https://example.test/"),
            ),
            (
                "mcp__claude-in-chrome__navigate",
                json!({ "url": "https://example.test/" }),
                None,
            ),
        ] {
            assert!(reads_outside(tool, &input, page), "{tool} {input}");
        }
    }

    #[test]
    fn the_owners_own_work_is_not_outside_content() {
        for (tool, input, page) in [
            ("Read", json!({ "file_path": "/tmp/x" }), None),
            ("Edit", json!({ "file_path": "/tmp/x" }), None),
            ("Bash", bash("gh pr view 12"), None),
            ("Bash", bash("gh pr checks 12"), None),
            (
                "Bash",
                bash("gh run view 123456 --log-failed > /tmp/r.log 2>&1"),
                None,
            ),
            (
                "Bash",
                bash("for n in 1 2 3; do gh pr view $n --json title,state; done"),
                None,
            ),
            ("Bash", bash("git fetch -q origin && git status"), None),
            (
                "Bash",
                bash("pnpm install --frozen-lockfile && pnpm test"),
                None,
            ),
            (
                "Bash",
                bash("curl -s http://localhost:3000/api/health"),
                None,
            ),
            ("Bash", bash("curl -s http://127.0.0.1:5173/"), None),
            ("Bash", bash("cat /tmp/curl-notes.txt | grep wget"), None),
            (
                "mcp__claude-in-chrome__get_page_text",
                json!({ "tabId": 1 }),
                Some("http://localhost:3000/"),
            ),
            (
                "mcp__claude-in-chrome__navigate",
                json!({ "url": "http://localhost:3000/" }),
                None,
            ),
            (
                "mcp__claude-in-chrome__computer",
                json!({ "action": "left_click" }),
                Some("https://example.test/"),
            ),
        ] {
            assert!(!reads_outside(tool, &input, page), "{tool} {input}");
        }
    }

    #[test]
    fn a_mark_lasts_until_the_next_turn() {
        let id = "exposure-test-agent";
        begin(id);
        assert!(!read_outside(id));
        assert!(mark(id));
        assert!(!mark(id), "marked once");
        assert!(read_outside(id));
        begin(id);
        assert!(!read_outside(id));
    }
}
