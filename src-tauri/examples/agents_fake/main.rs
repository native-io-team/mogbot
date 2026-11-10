//! Whole agent turns against a fake engine: deterministic, free, offline.
//!
//! Drives the real runner, store, agent bridge, approval broker, wallet and
//! MCP tools through the same commands the UI calls, with a scripted stand-in
//! for `claude` (`scripts/fake-engine/fake_claude.py`) first on PATH. The fake
//! speaks Claude Code's stream-json and calls the bridge's tools for real, so
//! cards, results, messages and the timeline are the app's own; only the
//! model is scripted. Each message a test sends carries the turn's script
//! (`#fake [...]`, see the fake's header).
//!
//! Everything lives under a throwaway HOME, and the Keychain is kept in
//! memory (`keychain::use_memory_for_e2e`): nothing of the owner's is read or
//! written, and no model is called.
//!
//! ```text
//! scripts/agents-fake-e2e.sh              # every scenario
//! scripts/agents-fake-e2e.sh normal stop  # some of them
//! ```

// A test driver: a failed unwrap is a failed run.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::disallowed_methods)]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use app_lib::agents::engine::Engine;
use app_lib::agents::{self, runner, store};
use app_lib::commands::agents as cmd;
use store::{AgentMessage, MessageKind};
use tauri::{AppHandle, Listener};

type Check = Result<(), String>;

fn ensure(cond: bool, what: impl Into<String>) -> Check {
    if cond {
        Ok(())
    } else {
        Err(what.into())
    }
}

/// A message carrying a turn's script.
fn fake(steps: Value) -> String {
    format!("#fake {steps}")
}

/* ------------------------------------------------------------------ harness */

#[derive(Clone)]
struct H {
    app: AppHandle,
    home: PathBuf,
    /// Every draft seen: (agent id, text so far).
    drafts: Arc<Mutex<Vec<(String, String)>>>,
}

impl H {
    fn new(app: AppHandle, home: PathBuf) -> Self {
        let h = H {
            app: app.clone(),
            home,
            drafts: Default::default(),
        };
        let drafts = h.drafts.clone();
        app.listen_any(runner::EVENT_DRAFT, move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                let id = v["agentId"].as_str().unwrap_or("").to_string();
                let text = v["text"].as_str().unwrap_or("").to_string();
                drafts.lock().unwrap().push((id, text));
            }
        });
        h
    }

    /// A fresh, muted agent on Claude Code (the fake).
    fn agent(&self, name: &str) -> store::Agent {
        if let Ok(Some(old)) = store::find(name) {
            runner::stop(&self.app, &old.id);
            let _ = store::delete(&old.id);
        }
        let a = store::create(store::NewAgent {
            name: name.into(),
            role: format!("{name} for the fake-engine suite"),
            instructions: String::new(),
            shape: None,
            avatar: None,
            color: None,
            is_main: false,
        })
        .expect("create agent");
        store::update(&a.id, |a| {
            a.engine = Engine::Claude;
            a.muted = true;
        })
        .unwrap()
    }

    fn chief(&self) -> store::Agent {
        let chief = agents::ensure_main().expect("chief");
        store::update(&chief.id, |a| {
            a.engine = Engine::Claude;
            a.muted = true;
        })
        .unwrap()
    }

    async fn send(&self, id: &str, text: &str) -> Result<AgentMessage, String> {
        self.send_in(id, text, None).await
    }

    async fn send_in(
        &self,
        id: &str,
        text: &str,
        conversation: Option<&str>,
    ) -> Result<AgentMessage, String> {
        cmd::agents_send(
            self.app.clone(),
            id.into(),
            text.into(),
            None,
            None,
            None,
            None,
            conversation.map(String::from),
        )
        .await
        .map_err(|e| format!("send failed: {e}"))
    }

    /// Until none of `ids` has a turn running or queued, steadily for `settle`.
    async fn idle(&self, ids: &[&str], settle: Duration, limit: Duration) -> Check {
        let start = Instant::now();
        let mut quiet_since: Option<Instant> = None;
        tokio::time::sleep(Duration::from_millis(200)).await;
        loop {
            let busy = ids.iter().any(|id| runner::in_turn(id));
            match (busy, quiet_since) {
                (true, _) => quiet_since = None,
                (false, None) => quiet_since = Some(Instant::now()),
                (false, Some(t)) if t.elapsed() >= settle => break,
                _ => {}
            }
            if start.elapsed() > limit {
                return Err(format!("still busy after {}s", limit.as_secs()));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for id in ids {
            let s = runner::status_of(id);
            ensure(s.state == "idle", format!("status stuck on {:?}", s.state))?;
        }
        Ok(())
    }

    async fn turn(&self, id: &str) -> Check {
        self.idle(&[id], Duration::from_millis(600), Duration::from_secs(60))
            .await
    }

    async fn until<F: Fn() -> bool>(&self, what: &str, limit: Duration, f: F) -> Check {
        let start = Instant::now();
        while !f() {
            if start.elapsed() > limit {
                return Err(format!("timed out waiting for {what}"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    }

    fn drafting(&self, id: &str, min_chars: usize) -> bool {
        self.drafts
            .lock()
            .unwrap()
            .iter()
            .any(|(a, t)| a == id && t.len() >= min_chars)
    }

    /// What the fake recorded: each turn's start and every bridge answer.
    fn fake_log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("fake-engine.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// The turns the fake started whose prompt contains `tag`.
    fn turns_with(&self, tag: &str) -> Vec<Value> {
        self.fake_log()
            .into_iter()
            .filter(|e| e.get("turn").is_some())
            .filter(|e| e["prompt"].as_str().unwrap_or("").contains(tag))
            .collect()
    }
}

fn log(id: &str) -> Vec<AgentMessage> {
    store::messages(id, usize::MAX).unwrap_or_default()
}

fn of_kind(id: &str, kind: MessageKind) -> Vec<AgentMessage> {
    log(id).into_iter().filter(|m| m.kind == kind).collect()
}

fn replies(id: &str) -> Vec<String> {
    of_kind(id, MessageKind::Agent)
        .into_iter()
        .map(|m| m.text)
        .collect()
}

fn last_reply(id: &str) -> String {
    replies(id).pop().unwrap_or_default()
}

fn notes(id: &str) -> Vec<String> {
    of_kind(id, MessageKind::Note)
        .into_iter()
        .map(|m| m.text)
        .collect()
}

fn errors(id: &str) -> Vec<String> {
    of_kind(id, MessageKind::Error)
        .into_iter()
        .map(|m| m.text)
        .collect()
}

fn no_errors(id: &str) -> Check {
    let e = errors(id);
    ensure(e.is_empty(), format!("error bubbles: {e:?}"))
}

fn approvals(id: &str) -> Vec<store::Approval> {
    log(id).into_iter().filter_map(|m| m.approval).collect()
}

async fn card(h: &H, id: &str, seen: usize) -> Result<store::Approval, String> {
    h.until("an approval card", Duration::from_secs(30), || {
        approvals(id).len() > seen
    })
    .await?;
    Ok(approvals(id).pop().unwrap())
}

async fn answer(h: &H, id: &str, card: &store::Approval, allow: bool) -> Check {
    cmd::agents_answer_approval(
        h.app.clone(),
        id.into(),
        card.request_id.clone(),
        allow,
        None,
        None,
        None,
    )
    .await
    .map_err(|e| e.to_string())
}

/// The labels of the "What it did" timeline kept under the turn's last reply.
fn timeline(id: &str) -> Vec<(String, Option<String>)> {
    let Some(last) = of_kind(id, MessageKind::Agent).pop() else {
        return Vec::new();
    };
    let work = last
        .work
        .clone()
        .or_else(|| agents::work::load(id, &last.id));
    work.map(|w| {
        w.steps
            .into_iter()
            .map(|s| {
                (
                    s.label,
                    s.outcome
                        .map(|o| serde_json::to_value(o).unwrap().to_string()),
                )
            })
            .collect()
    })
    .unwrap_or_default()
}

/* ---------------------------------------------------------------- scenarios */

/// A normal turn: streamed bubbles, a command and a file in "What it did",
/// usage recorded, the session kept for the next turn.
async fn normal(h: &H) -> Check {
    let a = h.agent("Plain");
    h.send(
        &a.id,
        &fake(json!([
            {"say": "Looking into it."},
            {"bash": "echo hello-from-bash", "ask": false},
            {"write": "notes.txt", "text": "remember this"},
            {"say": "Done: session {session}, turn {turn}."}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    // The short line before it went on working is narration: it goes in
    // the timeline, and the chat keeps the final reply (`narration`).
    let said = replies(&a.id);
    ensure(
        said.len() == 1 && said[0].starts_with("Done:"),
        format!("bubbles: {said:?}"),
    )?;
    ensure(h.drafting(&a.id, 5), "the reply never streamed as a draft")?;
    let steps = timeline(&a.id);
    ensure(
        steps.len() >= 2,
        format!("\"What it did\" has {} steps: {steps:?}", steps.len()),
    )?;
    let agent = store::get(&a.id).unwrap();
    let session = agent.session_id.clone().ok_or("no session kept")?;
    ensure(
        said[0].contains(&session) && said[0].contains("turn 1"),
        format!(
            "session {session} not the one the engine ran: {:?}",
            said[0]
        ),
    )?;
    let labels = format!("{steps:?}");
    ensure(
        labels.contains("Looking into it."),
        format!("the narration isn't in \"What it did\": {labels}"),
    )?;
    ensure(agent.usage.all_time.turns >= 1, "no usage recorded")?;

    // The next turn resumes the same session.
    h.send(
        &a.id,
        &fake(json!([{"say": "again {session} turn {turn}"}])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == format!("again {session} turn 2"),
        format!("not resumed: {:?}", last_reply(&a.id)),
    )
}

/// A command asks on a card; Allow runs it, Deny doesn't, and the turn
/// carries on either way.
async fn approvals_scenario(h: &H) -> Check {
    let a = h.agent("Asker");
    h.send(
        &a.id,
        &fake(json!([
            {"bash": "python3 -c 'print(6*7)' > allowed.txt"},
            {"say": "after allow"}
        ])),
    )
    .await?;
    let c = card(h, &a.id, 0).await?;
    ensure(
        c.tool.as_deref() == Some("Bash"),
        format!("card for {:?}", c.tool),
    )?;
    h.until("the row to say waiting", Duration::from_secs(5), || {
        runner::status_of(&a.id).state == "waiting"
    })
    .await?;
    answer(h, &a.id, &c, true).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let home = store::agent_home(&a.id).unwrap();
    ensure(
        std::fs::read_to_string(home.join("allowed.txt"))
            .unwrap_or_default()
            .trim()
            == "42",
        "the allowed command didn't run",
    )?;
    ensure(last_reply(&a.id) == "after allow", "no reply after Allow")?;

    h.send(
        &a.id,
        &fake(json!([
            {"bash": "python3 -c 'print(6*9)' > denied.txt"},
            {"say": "after deny"}
        ])),
    )
    .await?;
    let c = card(h, &a.id, 1).await?;
    answer(h, &a.id, &c, false).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(!home.join("denied.txt").exists(), "a denied command ran")?;
    ensure(last_reply(&a.id) == "after deny", "no reply after Deny")?;
    let steps = timeline(&a.id);
    ensure(
        steps
            .iter()
            .any(|(_, o)| o.as_deref() == Some("\"declined\"")),
        format!("the denied step isn't marked declined: {steps:?}"),
    )?;
    let cards = approvals(&a.id);
    ensure(
        cards.len() == 2
            && cards[0].status == store::ApprovalStatus::Allowed
            && cards[1].status == store::ApprovalStatus::Denied,
        format!(
            "cards: {:?}",
            cards.iter().map(|c| &c.status).collect::<Vec<_>>()
        ),
    )
}

/// One Allow on an `ask_plan` card covers the listed command, with no
/// second card and the "Under your OK" line.
async fn plan(h: &H) -> Check {
    let a = h.agent("Planner");
    h.send(
        &a.id,
        &fake(json!([
            {"tool": "ask_plan", "args": {
                "actions": [{"kind": "comment", "target": "acme/site", "summary": "Comment on #12"}],
                "why": "Tell them it's fixed"}},
            {"bash": "gh issue comment 12 -R acme/site --body 'Fixed'"},
            {"say": "commented"}
        ])),
    )
    .await?;
    let c = card(h, &a.id, 0).await?;
    answer(h, &a.id, &c, true).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        approvals(&a.id).len() == 1,
        format!(
            "the planned comment asked again: {} cards",
            approvals(&a.id).len()
        ),
    )?;
    let ran = h
        .fake_log()
        .into_iter()
        .filter(|e| e["tool"] == "approve")
        .any(|e| e["reply"].to_string().contains("allow"));
    ensure(ran, "the covered command wasn't allowed")?;
    let lines = notes(&a.id).join(" | ");
    let steps = format!("{:?}", timeline(&a.id));
    ensure(
        lines.contains(agents::plan_grant::LINE) || steps.contains(agents::plan_grant::LINE),
        format!("no \"Under your OK\" line: notes {lines:?}, steps {steps}"),
    )
}

/// A finished piece of work comes back as one result card.
async fn result_card(h: &H) -> Check {
    let a = h.agent("Maker");
    h.send(
        &a.id,
        &fake(json!([
            {"write": "report.csv", "text": "a,b\n1,2\n"},
            {"tool": "share_result", "args": {
                "title": "Tiny report",
                "summary": "Two columns, one row.",
                "items": [{"path": "report.csv", "label": "The CSV"}],
                "checked": ["Opened it"],
                "not_verified": ["Nothing else"]}},
            {"say": "Here it is."}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let cards: Vec<AgentMessage> = log(&a.id)
        .into_iter()
        .filter(|m| m.result.is_some())
        .collect();
    ensure(cards.len() == 1, format!("{} result cards", cards.len()))?;
    let card = cards[0].result.as_ref().unwrap();
    let v = serde_json::to_value(card).unwrap();
    ensure(
        v.to_string().contains("Tiny report") && v.to_string().contains("report.csv"),
        format!("card: {v}"),
    )
}

/// Agent to agent: the Chief hands Scout work, Scout answers back, and a
/// ping-pong stops at the hop cap.
async fn delegation(h: &H) -> Check {
    let chief = h.chief();
    let scout = h.agent("Scout");
    let ask_back = fake(json!([
        {"tool": "message_agent", "args": {"agent": "Chief of Staff", "message": "the answer is 42"}},
        {"say": "sent"}
    ]));
    h.send(
        &chief.id,
        &fake(json!([
            {"tool": "message_agent", "args": {"agent": "Scout", "message": ask_back}},
            {"say": "asked Scout"}
        ])),
    )
    .await?;
    h.idle(
        &[&chief.id, &scout.id],
        Duration::from_secs(2),
        Duration::from_secs(60),
    )
    .await?;
    ensure(
        of_kind(&chief.id, MessageKind::SentToAgent)
            .iter()
            .any(|m| m.peer.as_ref().is_some_and(|p| p.id == scout.id)),
        "the Chief never messaged Scout",
    )?;
    ensure(
        of_kind(&chief.id, MessageKind::FromAgent)
            .iter()
            .any(|m| m.text.contains("42")),
        "Scout's answer never reached the Chief",
    )?;
    no_errors(&chief.id)?;
    no_errors(&scout.id)?;

    // Ping-pong between two agents: each turn messages the other with the
    // same script. The chain stops at the cap; nothing loops for ever.
    let ping = h.agent("Ping");
    let pong = h.agent("Pong");
    h.send(
        &ping.id,
        &fake(json!([{"volley": {"to": "Pong", "back": "Ping"}}])),
    )
    .await?;
    h.idle(
        &[&ping.id, &pong.id],
        Duration::from_secs(2),
        Duration::from_secs(90),
    )
    .await?;
    let sent = of_kind(&ping.id, MessageKind::SentToAgent).len()
        + of_kind(&pong.id, MessageKind::SentToAgent).len();
    ensure(
        sent == usize::from(runner::MAX_HOPS),
        format!("{sent} hops delivered, cap is {}", runner::MAX_HOPS),
    )?;
    let refused = h
        .fake_log()
        .into_iter()
        .filter(|e| e["tool"] == "message_agent")
        .filter(|e| e["reply"]["result"]["isError"] == true)
        .count();
    ensure(refused >= 1, "the hop past the cap wasn't refused")
}

/// Out of usage mid-turn on this Mac's account: the turn carries on, on the
/// next signed-in account, with one quiet line saying so.
async fn failover(h: &H) -> Check {
    let spare = agents::wallet::add(Engine::Claude, "Spare").map_err(|e| e.to_string())?;
    app_lib::commands::accounts::store_claude_token(
        &spare.id,
        "fake-token",
        Some("spare@example.com"),
    )
    .map_err(|e| e.to_string())?;
    let a = h.agent("Thrifty");
    let result = async {
        h.send(
            &a.id,
            &fake(json!([
                {"say": "starting"},
                {"rate_limit": 0.99},
                {"usage_limit": true, "unless_env": "CLAUDE_CODE_OAUTH_TOKEN"},
                {"say": "finished on {account}"}
            ])),
        )
        .await?;
        h.turn(&a.id).await?;
        no_errors(&a.id)?;
        let last = last_reply(&a.id);
        ensure(
            last.starts_with("finished on ") && !last.ends_with("this-mac"),
            format!("didn't carry on on the spare account: {last:?}"),
        )?;
        let switched: Vec<String> = notes(&a.id);
        ensure(
            switched.iter().any(|n| n.contains("Spare")),
            format!("no quiet line about the switch: {switched:?}"),
        )
    }
    .await;
    let _ = agents::wallet::remove(Engine::Claude, &spare.id);
    agents::wallet::finish_remove(Engine::Claude, &spare.id);
    result
}

/// The engine crashes, exits without a result, or fails: each turn ends in
/// a line saying so, keeps what it had streamed, and the next turn works.
async fn crash(h: &H) -> Check {
    let a = h.agent("Fragile");
    for (name, script) in [
        ("crash", json!([{"crash": true}])),
        ("exit", json!([{"say": "partial"}, {"exit": 3}])),
        (
            "error",
            json!([{"error": "API Error: 500 Internal server error"}]),
        ),
        (
            "stderr",
            json!([{"stderr": "Error: something broke"}, {"exit": 1}]),
        ),
    ] {
        let before = log(&a.id).len();
        h.send(&a.id, &fake(script)).await?;
        h.turn(&a.id).await.map_err(|e| format!("{name}: {e}"))?;
        let new: Vec<AgentMessage> = log(&a.id).into_iter().skip(before).collect();
        let ended = new.iter().any(|m| {
            matches!(m.kind, MessageKind::Error | MessageKind::Note) && !m.text.trim().is_empty()
        });
        ensure(
            ended,
            format!(
                "{name}: the turn ended without a line: {:?}",
                new.iter()
                    .map(|m| (m.kind, m.text.clone()))
                    .collect::<Vec<_>>()
            ),
        )?;
        if name == "crash" {
            ensure(
                new.iter()
                    .any(|m| m.kind == MessageKind::Agent && m.text.contains("first half")),
                "crash: the partial reply wasn't kept",
            )?;
        }
    }
    let before = errors(&a.id).len();
    h.send(&a.id, &fake(json!([{"say": "back"}]))).await?;
    h.turn(&a.id).await?;
    ensure(errors(&a.id).len() == before, "the turn after failed too")?;
    ensure(
        last_reply(&a.id) == "back",
        format!("no recovery: {:?}", last_reply(&a.id)),
    )
}

/// Stop mid-reply keeps the partial reply; Stop on a hung engine ends the
/// turn; the next turn works.
async fn stop(h: &H) -> Check {
    let a = h.agent("Talker");
    let long = "word ".repeat(200);
    h.send(&a.id, &fake(json!([{"slow": long, "every": 0.05}])))
        .await?;
    h.until("a draft", Duration::from_secs(20), || h.drafting(&a.id, 40))
        .await?;
    ensure(
        cmd::agents_stop(h.app.clone(), a.id.clone())
            .await
            .unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    let kept = of_kind(&a.id, MessageKind::Agent);
    ensure(
        kept.last().is_some_and(|m| m.stopped && m.text.len() >= 20),
        format!(
            "the partial reply wasn't kept: {:?}",
            kept.last().map(|m| (&m.text, m.stopped))
        ),
    )?;

    // A hung engine: silent until Stop.
    h.send(
        &a.id,
        &fake(json!([{"say": "about to hang"}, {"hang": true}])),
    )
    .await?;
    h.until("the hang", Duration::from_secs(20), || {
        last_reply(&a.id) == "about to hang"
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    ensure(runner::in_turn(&a.id), "the hung turn ended on its own")?;
    ensure(
        cmd::agents_stop(h.app.clone(), a.id.clone())
            .await
            .unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    ensure(
        notes(&a.id).iter().any(|n| n.starts_with("Stopped")),
        format!("no Stopped line: {:?}", notes(&a.id)),
    )?;
    h.send(&a.id, &fake(json!([{"say": "ready"}]))).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(last_reply(&a.id) == "ready", "no turn after Stop")
}

/// Messages sent while a turn runs wait, and go together in the next one.
async fn queueing(h: &H) -> Check {
    let a = h.agent("Busy");
    h.send(&a.id, &fake(json!([{"sleep": 2}, {"say": "first done"}])))
        .await?;
    h.until("the turn to start", Duration::from_secs(10), || {
        !h.turns_with("first done").is_empty()
    })
    .await?;
    h.send(&a.id, "queued-one").await?;
    h.send(&a.id, &fake(json!([{"say": "queued-two answered"}])))
        .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let both = h.turns_with("queued-one");
    ensure(
        both.len() == 1 && both[0]["prompt"].as_str().unwrap().contains("queued-two"),
        format!(
            "queued messages weren't batched into one turn: {}",
            both.len()
        ),
    )?;
    ensure(
        replies(&a.id) == ["first done", "queued-two answered"],
        format!("replies: {:?}", replies(&a.id)),
    )
}

/// Two conversations with one agent: each its own engine session, resumed
/// in turn.
async fn conversations(h: &H) -> Check {
    let a = h.agent("Juggler");
    h.send(&a.id, &fake(json!([{"say": "one {session} {turn}"}])))
        .await?;
    h.turn(&a.id).await?;
    let first = agents::conversations::list(&a.id).map_err(|e| e.to_string())?;
    let first_id = first.current.clone();
    let s1 = store::get(&a.id).unwrap().session_id.ok_or("no session")?;

    let second = cmd::agents_conversation_new(h.app.clone(), a.id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let second_id = second.current.clone();
    ensure(second_id != first_id, "no new conversation")?;
    h.send_in(
        &a.id,
        &fake(json!([{"say": "two {session} {turn}"}])),
        Some(&second_id),
    )
    .await?;
    h.turn(&a.id).await?;
    let s2 = store::get(&a.id).unwrap().session_id.ok_or("no session")?;
    ensure(
        s1 != s2,
        "the second conversation reused the first's session",
    )?;
    ensure(
        last_reply(&a.id) == format!("two {s2} 1"),
        format!("second: {:?}", last_reply(&a.id)),
    )?;

    // Back in the first: its own session, resumed.
    h.send_in(
        &a.id,
        &fake(json!([{"say": "one again {session} {turn}"}])),
        Some(&first_id),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == format!("one again {s1} 2"),
        format!("first again: {:?}", last_reply(&a.id)),
    )?;
    let in_first: Vec<String> = log(&a.id)
        .into_iter()
        .filter(|m| m.kind == MessageKind::Agent)
        .filter(|m| m.conversation.as_deref().is_none_or(|c| c == first_id))
        .map(|m| m.text)
        .collect();
    ensure(
        in_first.iter().all(|t| t.starts_with("one")),
        format!("the first conversation's chat has: {in_first:?}"),
    )
}

/// The engine's copy of the conversation goes missing: the app puts its own
/// back and the turn resumes it.
async fn lost_transcript(h: &H) -> Check {
    let a = h.agent("Forgetful");
    h.send(&a.id, &fake(json!([{"say": "t{turn}"}]))).await?;
    h.turn(&a.id).await?;
    let projects = h.home.join(".claude").join("projects");
    let _ = std::fs::remove_dir_all(&projects);
    h.send(&a.id, &fake(json!([{"say": "t{turn}"}]))).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == "t2",
        format!("not resumed from the app's copy: {:?}", last_reply(&a.id)),
    )
}

/// The morning brief, composed from the turns above: names the agents that
/// did something and what is waiting.
async fn brief(h: &H) -> Check {
    let chief = h.chief();
    let waiting = h.agent("Waiter");
    h.send(
        &waiting.id,
        &fake(json!([{"bash": "python3 -c 'print(1)'"}])),
    )
    .await?;
    let c = card(h, &waiting.id, 0).await?;
    let posted = agents::brief::post_now(&h.app)
        .await
        .map_err(|e| e.to_string())?;
    ensure(posted, "nothing posted")?;
    let text = last_reply(&chief.id);
    answer(h, &waiting.id, &c, false).await?;
    h.turn(&waiting.id).await?;
    ensure(
        text.starts_with(agents::brief::HEAD),
        format!("brief: {text:?}"),
    )?;
    ensure(
        text.contains("Waiter"),
        format!("the waiting card isn't in it: {text}"),
    )?;
    ensure(
        text.contains("Plain") || text.contains("Maker"),
        format!("the agents that worked aren't in it: {text}"),
    )?;
    println!(
        "      ---\n{}\n      ---",
        text.lines()
            .map(|l| format!("      {l}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok(())
}

const ALL: &[&str] = &[
    "normal",
    "approvals",
    "plan",
    "result",
    "delegation",
    "failover",
    "crash",
    "stop",
    "queue",
    "conversations",
    "lost-transcript",
    "brief",
];

/* --------------------------------------------------------------------- main */

/// The fake on PATH as `claude` (and a `gh` that only prints), first.
fn install_fake(home: &Path) {
    let bin = home.join("fakebin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/fake-engine/fake_claude.py")
        .canonicalize()
        .expect("scripts/fake-engine/fake_claude.py");
    let claude = bin.join("claude");
    let _ = std::fs::remove_file(&claude);
    std::os::unix::fs::symlink(&script, &claude).unwrap();
    let gh = bin.join("gh");
    std::fs::write(&gh, "#!/bin/sh\necho \"fake gh: $*\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", bin.display()));
    std::env::set_var("FAKE_ENGINE_LOG", home.join("fake-engine.jsonl"));
}

fn main() {
    let home = std::env::temp_dir().join(format!("agents-fake-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("SHIPSTUDIO_AGENTS_SILENT", "1");
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy().to_string();
        if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") || key == "CLAUDE_CONFIG_DIR" {
            std::env::remove_var(key);
        }
    }
    std::fs::create_dir_all(home.join("ShipStudio")).unwrap();
    app_lib::keychain::use_memory_for_e2e();
    install_fake(&home);

    #[allow(unused_mut)]
    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .build(tauri::generate_context!())
        .expect("build tauri app");
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let h = H::new(app.handle().clone(), home.clone());

    let args: Vec<String> = std::env::args().skip(1).collect();
    let wanted: Vec<&str> = if args.is_empty() {
        ALL.to_vec()
    } else {
        args.iter().map(String::as_str).collect()
    };
    println!("HOME for this run: {}", home.display());
    let started = Instant::now();
    let mut failed = 0;
    tauri::async_runtime::block_on(async {
        for name in wanted {
            let t = Instant::now();
            let result = match name {
                "normal" => normal(&h).await,
                "approvals" => approvals_scenario(&h).await,
                "plan" => plan(&h).await,
                "result" => result_card(&h).await,
                "delegation" => delegation(&h).await,
                "failover" => failover(&h).await,
                "crash" => crash(&h).await,
                "stop" => stop(&h).await,
                "queue" => queueing(&h).await,
                "conversations" => conversations(&h).await,
                "lost-transcript" => lost_transcript(&h).await,
                "brief" => brief(&h).await,
                other => Err(format!("unknown scenario {other}")),
            };
            let took = t.elapsed().as_secs_f32();
            match result {
                Ok(()) => println!("PASS  {name:<16} {took:>5.1}s"),
                Err(e) => {
                    failed += 1;
                    println!("FAIL  {name:<16} {took:>5.1}s  {e}");
                }
            }
        }
    });
    println!("{failed} failed · {}s", started.elapsed().as_secs());
    if std::env::var("AGENTS_FAKE_KEEP").is_err() {
        let _ = std::fs::remove_dir_all(&home);
    }
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
