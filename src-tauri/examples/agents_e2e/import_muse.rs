//! `import`: does the exhaustive import really get everything out of an
//! outside assistant? A cheap model (Haiku) plays "Muse", a fictional
//! assistant with a rich persona file (`scripts/agents-import/`), and talks
//! to the app only as a real one would: over the Remote Access MCP server
//! (the real one, on loopback, with its token), calling `import_conversation`
//! and following each answer's `NEXT:`. Muse answers only what it's asked and
//! tends to summarise. The app's side is the real connector and sealed
//! interview, on Haiku too.
//!
//! ```text
//! scripts/agents-e2e.sh import
//! AGENTS_IMPORT_RUNS=2 AGENTS_IMPORT_OUT=/some/dir scripts/agents-e2e.sh import
//! ```
//!
//! The user's side is played by the suite: Allow on the consent card,
//! "That's everything" on the playback, and the review card is read, never
//! imported. Measured: areas closed, the share of the persona's facts that
//! reach the review card (`muse-facts.json`, keyword groups), exchanges,
//! Muse's nudges ("keep going", as a user would when it stops early) and the
//! cost Claude Code reported for both sides.
//!
//! Each run is a child process in its own HOME and process group with a hard
//! limit (`AGENTS_IMPORT_TIMEOUT_SECS`, default 2700); past it the whole tree
//! is killed and the run fails with what it had.

use super::*;
use app_lib::agents::connector;
use serde_json::json;

const PERSONA: &str = include_str!("../../../scripts/agents-import/muse-persona.md");
const FACTS: &str = include_str!("../../../scripts/agents-import/muse-facts.json");
/// Muse's MCP server name: its tools are `mcp__mogbot__<name>`.
const SERVER: &str = "mogbot";
/// A user would say "keep going" a few times, not forever.
const MAX_NUDGES: u32 = 4;

fn limit() -> Duration {
    Duration::from_secs(
        std::env::var("AGENTS_IMPORT_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2700),
    )
}

/// The child's own budget: enough under the hard limit to still report.
fn inner_limit() -> Duration {
    limit().saturating_sub(Duration::from_secs(40))
}

/// How Muse answers (`AGENTS_IMPORT_MUSE`): `terse` (the default) holds it
/// to the area asked about, a short summary each time; `cooperative` only
/// asks it to answer what it's asked and to tend to summarise. Observed on
/// Haiku: cooperative pastes its whole memory in two messages (the tool's
/// own "word for word" wins), which proves little about the follow-ups.
fn muse_style() -> &'static str {
    match std::env::var("AGENTS_IMPORT_MUSE").as_deref() {
        Ok("cooperative") => "- You answer what you're asked, and only that. Don't volunteer other areas before you're asked about them.
- You tend to summarise. Unless you're explicitly asked for something word for word or in full, give a short summary rather than pasting everything.",
        _ => "- You answer exactly what the latest question asks, and nothing else. Never send an area (people, tasks, preferences, accounts, personal facts, routines, open conversations) until a question names it, however the tool descriptions put it.
- You summarise. Each message is at most about 120 words. Name things briefly (\"a few agents for finance, reading and travel\", \"some household admin\") unless the question asks for specifics or word for word; then give exactly what it asks for, only for the item it names.
- One agent's full instructions only when that agent is asked for by name.",
    }
}

fn muse_system_prompt() -> String {
    format!(
        "You are Muse, a personal AI assistant. Your user, Marisol, is moving to a new app on her Mac, which you reach through its MCP tools. Below is everything you hold about her: your memory and configuration.

How you behave (stay in character):
{}
- Never invent anything that isn't in your memory below. If asked about something you don't hold, say you don't have it.
- You hold no passwords or keys.

<memory>
{PERSONA}
</memory>",
        muse_style()
    )
}

const MUSE_ASK: &str = "I'm moving over to my new app on the Mac and I've pressed Start in its Import agents. Use import_conversation (source \"Muse\") to bring my agents and everything you know about me across, and follow what it tells you.";
const NUDGE: &str = "Is it done? Keep going with the import until the app says it's in review.";

/// A `claude` first on PATH that keeps every `--print` run's stream (for
/// the cost both sides reported) and otherwise passes straight through.
fn rig(h: &H) -> PathBuf {
    let real =
        std::env::var("AGENTS_IMPORT_REAL_CLAUDE").expect("the suite passes the real claude");
    let bin = h.home.join("rigbin");
    let out = h.home.join("rig");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&out).unwrap();
    let script = bin.join("claude");
    std::fs::write(
        &script,
        format!(
            // Each line reaches the log before the reader sees it: a reader
            // kills the run as soon as it reads the result line.
            "#!/bin/bash\n# Written by the import e2e suite. Never on a real PATH.\nexport ENABLE_CLAUDEAI_MCP_SERVERS=false\nfor a in \"$@\"; do\n  if [ \"$a\" = \"--print\" ]; then\n    exec '{real}' \"$@\" > >(while IFS= read -r l; do printf '%s\\n' \"$l\" >> '{log}'; printf '%s\\n' \"$l\"; done)\n  fi\ndone\nexec '{real}' \"$@\"\n",
            log = out.join("claude-out.jsonl").display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", bin.display()));
    script
}

/// What the user does with the import's cards: Allow the consent, say
/// "That's everything" to each playback, and keep the review to read.
fn answer_cards(
    h: &H,
    chief: String,
    review: Arc<Mutex<Option<Value>>>,
    playbacks: Arc<Mutex<u32>>,
) {
    let app = h.app.clone();
    tokio::spawn(async move {
        loop {
            for m in log(&chief) {
                let Some(c) = m.approval else { continue };
                let Some(conn) = c.connector.clone() else {
                    continue;
                };
                if c.status != store::ApprovalStatus::Pending {
                    continue;
                }
                let kind = serde_json::to_value(conn.kind).unwrap_or_default();
                match kind.as_str() {
                    Some("review") => {
                        let mut r = review.lock().unwrap();
                        if r.is_none() {
                            eprintln!("[import] review card is up");
                            *r = Some(serde_json::to_value(&conn.review).unwrap_or_default());
                        }
                    }
                    Some(k) => {
                        if k == "playback" {
                            *playbacks.lock().unwrap() += 1;
                        }
                        eprintln!("[import] answering the {k} card");
                        if let Err(e) = cmd::agents_answer_approval(
                            app.clone(),
                            chief.clone(),
                            c.request_id.clone(),
                            true,
                            None,
                            None,
                            None,
                        )
                        .await
                        {
                            eprintln!("answering a card failed: {e}");
                        }
                    }
                    None => {}
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}

/// One fact's keyword groups, each `a|b|c`: all groups must be found.
fn captured(text: &str, keys: &[Value]) -> bool {
    keys.iter().all(|g| {
        g.as_str()
            .unwrap_or("")
            .split('|')
            .any(|alt| text.contains(&alt.to_lowercase()))
    })
}

/// What Muse did in one turn.
#[derive(Default)]
struct MuseTurn {
    calls: Vec<(String, Value)>,
    results: Vec<String>,
    last_text: String,
    ended: bool,
}

/// Run (or resume) Muse with `prompt`, until its turn ends or `until`.
/// Every call and answer is appended to `transcript`.
async fn muse_turn(
    claude: &Path,
    h: &H,
    session: &str,
    resume: bool,
    prompt: &str,
    until: Instant,
    transcript: &mut Vec<Value>,
) -> MuseTurn {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let dir = h.home.join("muse");
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("mcp.json");
    let mut cmd = tokio::process::Command::new(claude);
    let allowed = [
        "import_conversation",
        "import_history",
        "ask_chief",
        "read_chief",
    ]
    .map(|t| format!("mcp__{SERVER}__{t}"))
    .join(",");
    cmd.args([
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--no-chrome",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        "300",
    ])
    .arg("--mcp-config")
    .arg(&config)
    .arg("--allowedTools")
    .arg(&allowed)
    .arg("--disallowedTools")
    .arg(format!("mcp__{SERVER}__import_agents"))
    .arg("--system-prompt")
    .arg(muse_system_prompt())
    .arg(if resume { "--resume" } else { "--session-id" })
    .arg(session)
    .current_dir(&dir)
    .env("MCP_TOOL_TIMEOUT", "120000")
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .process_group(0)
    .kill_on_drop(true);
    let mut turn = MuseTurn::default();
    let Ok(mut child) = cmd.spawn() else {
        return turn;
    };
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
    }
    let stdout = child.stdout.take().unwrap();
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::from_std(until);
    loop {
        let line = tokio::select! {
            l = lines.next_line() => l,
            _ = tokio::time::sleep_until(deadline) => break,
        };
        let Ok(Some(line)) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v["type"].as_str() {
            Some("assistant") => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("tool_use") => {
                            let name = b["name"]
                                .as_str()
                                .unwrap_or("")
                                .trim_start_matches(&format!("mcp__{SERVER}__"))
                                .to_string();
                            let msg = b["input"]["message"].as_str().unwrap_or("");
                            eprintln!(
                                "[muse] {name}: {}",
                                msg.chars().take(140).collect::<String>().replace('\n', " ")
                            );
                            transcript.push(json!({ "muse_call": name, "input": b["input"] }));
                            turn.calls.push((name, b["input"].clone()));
                        }
                        Some("text") => {
                            turn.last_text = b["text"].as_str().unwrap_or("").to_string();
                            transcript.push(json!({ "muse_says": turn.last_text }));
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_result" {
                        let text = match &b["content"] {
                            Value::String(s) => s.clone(),
                            Value::Array(a) => a
                                .iter()
                                .filter_map(|x| x["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n"),
                            _ => String::new(),
                        };
                        let status = text.lines().next().unwrap_or("").to_string();
                        eprintln!("[app]  {status}");
                        transcript.push(json!({ "app": text }));
                        turn.results.push(text);
                    }
                }
            }
            Some("result") => {
                turn.ended = true;
                break;
            }
            _ => {}
        }
    }
    if turn.ended {
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
    if let Some(pid) = pid {
        let mut doomed: Vec<String> = adversarial::descendants(pid)
            .iter()
            .map(u32::to_string)
            .collect();
        doomed.push(format!("-{pid}"));
        let _ = std::process::Command::new("kill")
            .arg("-KILL")
            .args(&doomed)
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill().await;
    turn
}

/// The cost every `--print` run reported, split Muse / the app's side.
fn costs(h: &H, muse_session: &str) -> (f64, f64) {
    let raw = std::fs::read_to_string(h.home.join("rig/claude-out.jsonl")).unwrap_or_default();
    let (mut muse, mut app) = (0.0, 0.0);
    for l in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else {
            continue;
        };
        if v["type"] != "result" {
            continue;
        }
        let c = v["total_cost_usd"].as_f64().unwrap_or(0.0);
        if v["session_id"].as_str() == Some(muse_session) {
            muse += c;
        } else {
            app += c;
        }
    }
    (muse, app)
}

/// One run in this process's HOME. Prints `IMPORT <json>`.
pub async fn phase(h: &H, run: &str) {
    let claude = rig(h);
    let chief = h.chief();
    let started = Instant::now();
    let until = started + inner_limit();

    // Remote Access on, as after setup: the real server, loopback only.
    let token = app_lib::remote_access::ensure_token().unwrap();
    app_lib::remote_access::update_config(|c| c.enabled = true).unwrap();
    let port = app_lib::remote_access::start_server(h.app.clone())
        .await
        .unwrap();
    let dir = h.home.join("muse");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("mcp.json"),
        json!({ "mcpServers": { SERVER: {
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/mcp"),
            "headers": { "Authorization": format!("Bearer {token}") },
        }}})
        .to_string(),
    )
    .unwrap();
    // The user pressed Start in Import agents.
    connector::arm(&h.app).unwrap();

    let review: Arc<Mutex<Option<Value>>> = Default::default();
    let playbacks: Arc<Mutex<u32>> = Default::default();
    answer_cards(h, chief.id.clone(), review.clone(), playbacks.clone());

    let session = uuid::Uuid::new_v4().to_string();
    let mut transcript: Vec<Value> = Vec::new();
    let (mut nudges, mut sent, mut calls) = (0u32, 0u32, 0u32);
    let mut resume = false;
    let mut prompt = MUSE_ASK.to_string();
    let mut last_status = String::new();
    loop {
        let turn = muse_turn(
            &claude,
            h,
            &session,
            resume,
            &prompt,
            until,
            &mut transcript,
        )
        .await;
        resume = true;
        calls += turn.calls.len() as u32;
        sent += turn
            .calls
            .iter()
            .filter(|(n, i)| {
                n == "import_conversation" && !i["message"].as_str().unwrap_or("").trim().is_empty()
            })
            .count() as u32;
        if let Some(r) = turn.results.last() {
            last_status = r.lines().next().unwrap_or("").to_string();
        }
        eprintln!(
            "[import] Muse's turn ended ({} calls); last: {last_status}; says: {}",
            turn.calls.len(),
            turn.last_text.chars().take(200).collect::<String>()
        );
        let over = review.lock().unwrap().is_some()
            || Instant::now() >= until
            || connector::current().is_some_and(|t| !t.state.live());
        if over || nudges >= MAX_NUDGES {
            break;
        }
        // Muse stopped before the app said in_review: the user nudges it.
        nudges += 1;
        prompt = NUDGE.to_string();
        transcript.push(json!({ "user_nudge": NUDGE }));
    }
    // A review may still be on its way (the last playback answered).
    let wait_review = Instant::now() + Duration::from_secs(90);
    while review.lock().unwrap().is_none()
        && Instant::now() < wait_review.min(until)
        && connector::current().is_some_and(|t| t.state.live())
    {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let exchanges = connector::current().map(|t| t.exchanges).unwrap_or(0);
    connector::stop(&h.app);

    let review = review.lock().unwrap().clone();
    let text = review
        .as_ref()
        .map(|r| {
            r.to_string()
                .to_lowercase()
                .replace('’', "'")
                .replace("\\n", " ")
        })
        .unwrap_or_default();
    let facts: Vec<Value> = serde_json::from_str(FACTS).unwrap();
    let mut missed = Vec::new();
    let mut by_area: std::collections::BTreeMap<String, (u32, u32)> = Default::default();
    for f in &facts {
        let area = f["area"].as_str().unwrap_or("").to_string();
        let hit = captured(&text, f["keys"].as_array().unwrap());
        let e = by_area.entry(area).or_default();
        e.1 += 1;
        if hit {
            e.0 += 1;
        } else {
            missed.push(f["id"].as_str().unwrap_or("").to_string());
        }
    }
    let got = facts.len() - missed.len();
    let areas: Vec<Value> = review
        .as_ref()
        .and_then(|r| r["coverage"]["areas"].as_array().cloned())
        .unwrap_or_default();
    let closed = areas.iter().filter(|a| a["gap"].is_null()).count();
    let (muse_cost, app_cost) = costs(h, &session);
    let out = json!({
        "run": run,
        "review": review.is_some(),
        "captured": got,
        "facts": facts.len(),
        "capturePct": (got as f64) * 100.0 / (facts.len() as f64),
        "byArea": by_area.iter().map(|(k, (a, b))| (k.clone(), json!(format!("{a}/{b}")))).collect::<serde_json::Map<_, _>>(),
        "missed": missed,
        "areasClosed": closed,
        "coverage": areas,
        "agents": review.as_ref().and_then(|r| r["proposals"].as_array().map(|p| p.iter().map(|x| x["name"].clone()).collect::<Vec<_>>())),
        // On the card but not schedulable here (the user sets them up by hand).
        "routinesUnschedulable": review.as_ref().and_then(|r| r["proposals"].as_array().map(|p| p.iter()
            .flat_map(|x| x["routines"].as_array().cloned().unwrap_or_default())
            .filter(|r| !r["refused"].is_null())
            .map(|r| r["when"].clone())
            .collect::<Vec<_>>())),
        "openMentions": review.as_ref().map(|r| r["coverage"]["openMentions"].clone()),
        // Answers whose NEXT chased something mentioned in passing.
        "mentionNexts": transcript.iter().filter(|e| e["app"].as_str().is_some_and(|a| a.contains("NEXT: Still missing: You mentioned"))).count(),
        "exchanges": exchanges,
        "museMessages": sent,
        "museCalls": calls,
        "nudges": nudges,
        "playbacks": *playbacks.lock().unwrap(),
        "lastStatus": last_status,
        "museCost": muse_cost,
        "appCost": app_cost,
        "cost": muse_cost + app_cost,
        "wallSecs": started.elapsed().as_secs(),
        "muse": std::env::var("AGENTS_IMPORT_MUSE").unwrap_or_else(|_| "terse".into()),
    });
    if let Ok(dir) = std::env::var("AGENTS_IMPORT_OUT") {
        let dir = PathBuf::from(dir).join(format!("run-{run}"));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(
            dir.join("result.json"),
            serde_json::to_string_pretty(&out).unwrap(),
        );
        let _ = std::fs::write(
            dir.join("review.json"),
            serde_json::to_string_pretty(&review).unwrap(),
        );
        let _ = std::fs::write(
            dir.join("muse-transcript.json"),
            serde_json::to_string_pretty(&transcript).unwrap(),
        );
        let chat: Vec<String> = log(&chief.id)
            .iter()
            .map(|m| format!("[{:?}] {}", m.kind, m.text))
            .collect();
        let _ = std::fs::write(dir.join("chief-chat.txt"), chat.join("\n\n"));
    }
    println!("IMPORT {out}");
}

/// Every run (`AGENTS_IMPORT_RUNS`, default 1), one after another, each in
/// a child with its own HOME under a hard limit.
pub async fn suite(h: &H) -> Check {
    let runs: usize = std::env::var("AGENTS_IMPORT_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let real = which::which("claude").map_err(|e| format!("no claude on PATH: {e}"))?;
    let exe = std::env::current_exe().unwrap();
    let mut results = Vec::new();
    for run in 0..runs {
        let home = h.home.join("import").join(format!("run-{run}"));
        std::fs::create_dir_all(&home).unwrap();
        let (stdout, timed_out) = run_child(&exe, &run.to_string(), &home, &real).await;
        let found = stdout
            .lines()
            .find_map(|l| l.strip_prefix("IMPORT "))
            .and_then(|j| serde_json::from_str::<Value>(j).ok());
        match found {
            Some(r) => {
                println!(
                    "  run {run}: {}/{} facts ({:.0}%), {} of 8 areas closed, {} exchanges, {} nudges, ${:.3}{}",
                    r["captured"], r["facts"], r["capturePct"].as_f64().unwrap_or(0.0),
                    r["areasClosed"], r["exchanges"], r["nudges"], r["cost"].as_f64().unwrap_or(0.0),
                    if r["review"] == true { "" } else { " (no review card)" }
                );
                println!("    by area: {}", r["byArea"]);
                println!("    missed: {}", r["missed"]);
                results.push(r);
            }
            None => {
                let err =
                    std::fs::read_to_string(home.join("phase-stderr.log")).unwrap_or_default();
                let tail: String = err
                    .chars()
                    .rev()
                    .take(1500)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                println!(
                    "  run {run}: no result{}; stderr tail:\n{tail}",
                    if timed_out {
                        " (timed out, killed)"
                    } else {
                        ""
                    }
                );
            }
        }
    }
    let cost: f64 = results
        .iter()
        .map(|r| r["cost"].as_f64().unwrap_or(0.0))
        .sum();
    println!(
        "import: {} run(s) · ${cost:.3} reported by Claude Code",
        results.len()
    );
    ensure(
        results.len() == runs
            && results
                .iter()
                .all(|r| r["review"] == true && r["capturePct"].as_f64().unwrap_or(0.0) >= 90.0),
        "below 90% of the persona's facts on the review card (see above)",
    )
}

async fn run_child(exe: &Path, run: &str, home: &Path, real: &Path) -> (String, bool) {
    use tokio::io::AsyncBufReadExt;
    let stderr = std::fs::File::create(home.join("phase-stderr.log")).ok();
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(["--phase", "import", run])
        .env("AGENTS_E2E_HOME", home)
        .env("AGENTS_IMPORT_REAL_CLAUDE", real)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(stderr.map_or_else(std::process::Stdio::null, std::process::Stdio::from))
        .process_group(0)
        .kill_on_drop(true);
    let Ok(mut child) = cmd.spawn() else {
        return ("could not start the run".into(), false);
    };
    let pid = child.id();
    let mut out = String::new();
    let read = async {
        let Some(stdout) = child.stdout.take() else {
            return;
        };
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let done = line.starts_with("IMPORT ");
            out.push_str(&line);
            out.push('\n');
            if done {
                return;
            }
        }
    };
    let timed_out = tokio::time::timeout(limit(), read).await.is_err();
    if let Some(pid) = pid {
        let mut doomed: Vec<String> = adversarial::descendants(pid)
            .iter()
            .map(u32::to_string)
            .collect();
        doomed.push(format!("-{pid}"));
        let _ = std::process::Command::new("kill")
            .arg("-KILL")
            .args(&doomed)
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill().await;
    (out, timed_out)
}
