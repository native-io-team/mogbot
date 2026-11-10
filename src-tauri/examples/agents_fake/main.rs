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
            {"slow": "Done: session {session}, turn {turn}.", "every": 0.1}
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
/// Every Claude Code account has room again: a scenario that ran one out
/// leaves the next one starting clean.
fn accounts_have_room() {
    for acc in agents::wallet::of(Engine::Claude) {
        agents::wallet::mark_out(Engine::Claude, &acc.id, Some(0), 0);
    }
}

async fn failover(h: &H) -> Check {
    accounts_have_room();
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
    accounts_have_room();
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

    // A hung engine: silent until Stop. The short line it wrote before
    // going silent is held as possible narration; Stop must not lose it.
    h.send(
        &a.id,
        &fake(json!([{"say": "about to hang"}, {"hang": true}])),
    )
    .await?;
    h.until("the hang", Duration::from_secs(20), || {
        !h.turns_with("about to hang").is_empty()
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(800)).await;
    ensure(runner::in_turn(&a.id), "the hung turn ended on its own")?;
    ensure(
        cmd::agents_stop(h.app.clone(), a.id.clone())
            .await
            .unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    let said: Vec<String> = log(&a.id).into_iter().map(|m| m.text).collect();
    let kept_in_chat = said.iter().any(|t| t.contains("about to hang"));
    let kept_in_timeline = format!("{:?}", timeline(&a.id)).contains("about to hang");
    ensure(
        kept_in_chat || kept_in_timeline,
        format!("the line written before the hang was lost: {said:?}"),
    )?;
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

/// Out of usage after it already ran a command: the next account resumes
/// the same conversation (carried to that account's folder), so nothing is
/// done twice. Then every account out: one line saying so, no loop.
async fn failover_after_acting(h: &H) -> Check {
    accounts_have_room();
    let spare = agents::wallet::add(Engine::Claude, "Second").map_err(|e| e.to_string())?;
    app_lib::commands::accounts::store_claude_token(&spare.id, "fake-token-2", None)
        .map_err(|e| e.to_string())?;
    let a = h.agent("Doer");
    let result = async {
        h.send(&a.id, &fake(json!([{"say": "warming up {turn}"}])))
            .await?;
        h.turn(&a.id).await?;
        h.send(
            &a.id,
            &fake(json!([
                {"bash": "echo once >> did.txt", "ask": false},
                {"usage_limit": true, "unless_env": "CLAUDE_CODE_OAUTH_TOKEN"},
                {"say": "carried on at turn {turn} on {account}"}
            ])),
        )
        .await?;
        h.turn(&a.id).await?;
        let home = store::agent_home(&a.id).unwrap();
        let did = std::fs::read_to_string(home.join("did.txt")).unwrap_or_default();
        let last = last_reply(&a.id);
        ensure(
            last.starts_with("carried on at turn 3") && !last.ends_with("this-mac"),
            format!(
                "didn't resume the conversation on the other account: {last:?}, errors {:?}, notes {:?}",
                errors(&a.id),
                notes(&a.id)
            ),
        )?;
        // The fake re-runs its script on the resumed try; what matters is
        // that the try resumed the conversation that already acted.
        ensure(
            did.lines().count() <= 2,
            format!("the command ran {} times", did.lines().count()),
        )?;

        // Every account out: one line, no loop.
        let before = log(&a.id).len();
        std::env::set_var(
            "FAKE_ENGINE_DEFAULT",
            json!([{"usage_limit": true}]).to_string(),
        );
        h.send(&a.id, &fake(json!([{"usage_limit": true}])))
            .await?;
        let ended = h.turn(&a.id).await;
        std::env::remove_var("FAKE_ENGINE_DEFAULT");
        ended?;
        let new: Vec<AgentMessage> = log(&a.id).into_iter().skip(before).collect();
        let lines: Vec<String> = new
            .iter()
            .filter(|m| matches!(m.kind, MessageKind::Error | MessageKind::Note))
            .map(|m| m.text.clone())
            .collect();
        ensure(
            lines.iter().any(|l| l.contains("usage limit")),
            format!("all out: {lines:?}"),
        )?;
        let tries = h.turns_with("{\"usage_limit\":true}]").len();
        ensure(tries <= 3, format!("{tries} tries for one message"))
    }
    .await;
    let _ = agents::wallet::remove(Engine::Claude, &spare.id);
    agents::wallet::finish_remove(Engine::Claude, &spare.id);
    accounts_have_room();
    result
}

/// An engine that crashes on every try: picked up once, then one line.
async fn crash_twice(h: &H) -> Check {
    let a = h.agent("Doomed");
    std::env::set_var("FAKE_ENGINE_DEFAULT", json!([{"crash": true}]).to_string());
    let r = async {
        h.send(&a.id, &fake(json!([{"crash": true}]))).await?;
        h.turn(&a.id).await
    }
    .await;
    std::env::remove_var("FAKE_ENGINE_DEFAULT");
    r?;
    let lines: Vec<(MessageKind, String)> = log(&a.id)
        .into_iter()
        .filter(|m| matches!(m.kind, MessageKind::Error | MessageKind::Note))
        .map(|m| (m.kind, m.text))
        .collect();
    ensure(
        lines.last().is_some_and(|(k, _)| *k == MessageKind::Error),
        format!("didn't end on an error line: {lines:?}"),
    )?;
    h.send(&a.id, &fake(json!([{"say": "alive"}]))).await?;
    h.turn(&a.id).await?;
    ensure(
        last_reply(&a.id) == "alive",
        format!("after: {:?}", last_reply(&a.id)),
    )
}

/// Stop while a card waits: a late Allow can't run anything, the card
/// doesn't stay waiting, and the next turn works.
async fn stop_on_card(h: &H) -> Check {
    let a = h.agent("Patient");
    h.send(
        &a.id,
        &fake(json!([{"bash": "touch stopped-card.txt"}, {"say": "ran"}])),
    )
    .await?;
    let c = card(h, &a.id, 0).await?;
    ensure(
        cmd::agents_stop(h.app.clone(), a.id.clone())
            .await
            .unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    // A late Allow after Stop: refused or harmless, never runs the command.
    let _ = answer(h, &a.id, &c, true).await;
    h.turn(&a.id).await?;
    let home = store::agent_home(&a.id).unwrap();
    ensure(
        !home.join("stopped-card.txt").exists(),
        "a command ran after Stop",
    )?;
    h.send(&a.id, &fake(json!([{"say": "after"}]))).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == "after",
        format!("after: {:?}", replies(&a.id)),
    )?;
    let still = approvals(&a.id);
    ensure(
        still
            .iter()
            .all(|c| c.status != store::ApprovalStatus::Pending),
        format!(
            "a card still waits after Stop: {:?}",
            still.iter().map(|c| &c.status).collect::<Vec<_>>()
        ),
    )?;
    ensure(
        store::get(&a.id).unwrap().pending_approvals == 0,
        "the pending count still counts it",
    )
}

/// A message while a card waits is queued, not lost, and the card stays.
async fn queue_on_card(h: &H) -> Check {
    let a = h.agent("Juggling");
    h.send(
        &a.id,
        &fake(json!([{"bash": "touch q.txt"}, {"say": "carded"}])),
    )
    .await?;
    let c = card(h, &a.id, 0).await?;
    h.send(&a.id, &fake(json!([{"say": "the second"}]))).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    ensure(
        approvals(&a.id)
            .last()
            .is_some_and(|c| c.status == store::ApprovalStatus::Pending),
        "the card went away when a message arrived",
    )?;
    answer(h, &a.id, &c, true).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let said = replies(&a.id);
    ensure(
        said.iter().any(|t| t == "the second"),
        format!("the queued message was lost: {said:?}"),
    )
}

/// Interrupt: the running turn stops, keeps what it said, and the new
/// message runs next.
async fn interrupt(h: &H) -> Check {
    let a = h.agent("Interrupted");
    let long = "slow ".repeat(200);
    h.send(&a.id, &fake(json!([{"slow": long, "every": 0.05}])))
        .await?;
    h.until("a draft", Duration::from_secs(20), || h.drafting(&a.id, 30))
        .await?;
    h.send(&a.id, &fake(json!([{"say": "switched"}]))).await?;
    ensure(
        cmd::agents_interrupt(a.id.clone()).await.unwrap_or(false),
        "interrupt refused",
    )?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == "switched",
        format!("{:?}", replies(&a.id)),
    )?;
    ensure(
        notes(&a.id).iter().any(|n| n.starts_with("Interrupted")),
        format!("no interruption line: {:?}", notes(&a.id)),
    )
}

/// The same on Codex (`exec`, the fake as `codex`): a reply, a command, a
/// tool of the bridge, the thread resumed, a failure said.
async fn codex(h: &H) -> Check {
    let a = h.agent("Codexer");
    store::update(&a.id, |a| a.engine = Engine::Codex).unwrap();
    h.send(
        &a.id,
        &fake(json!([
            {"bash": "echo from-codex > codex.txt"},
            {"tool": "list_agents"},
            {"say": "codex {session} {turn}"}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let thread = store::get(&a.id)
        .unwrap()
        .session_id
        .ok_or("no thread kept")?;
    ensure(
        last_reply(&a.id) == format!("codex {thread} 1"),
        format!("{:?}", last_reply(&a.id)),
    )?;
    ensure(
        timeline(&a.id).len() >= 2,
        format!("timeline {:?}", timeline(&a.id)),
    )?;
    h.send(&a.id, &fake(json!([{"say": "again {session} {turn}"}])))
        .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == format!("again {thread} 2"),
        format!("not resumed: {:?}", last_reply(&a.id)),
    )?;
    h.send(
        &a.id,
        &fake(json!([{"error": "stream error: something broke"}])),
    )
    .await?;
    h.turn(&a.id).await?;
    ensure(
        !errors(&a.id).is_empty(),
        "a failed Codex turn said nothing",
    )
}

/// The same on OpenCode (`opencode acp`, the fake as `opencode`): a command
/// that asks and runs on Allow, a tool of the bridge, the reply streamed,
/// the session resumed; a denied command never runs, its step is declined
/// and the agent is told why in the round after; a crash and an error each
/// end in a line; a lost session is replaced; the bridge secret never on its
/// command line, in its config or its environment.
async fn opencode(h: &H) -> Check {
    let a = h.agent("Opener");
    store::update(&a.id, |a| a.engine = Engine::OpenCode).unwrap();
    let home = store::agent_home(&a.id).unwrap();
    h.send(
        &a.id,
        &fake(json!([
            {"bash": "python3 -c 'print(6*7)' > oc.txt"},
            {"tool": "list_agents"},
            {"slow": "opencode {session} {turn}", "every": 0.05}
        ])),
    )
    .await?;
    let c = card(h, &a.id, 0).await?;
    ensure(
        c.tool.as_deref() == Some("Bash"),
        format!("card for {:?}", c.tool),
    )?;
    answer(h, &a.id, &c, true).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        std::fs::read_to_string(home.join("oc.txt"))
            .unwrap_or_default()
            .trim()
            == "42",
        "the allowed command didn't run",
    )?;
    let session = store::get(&a.id)
        .unwrap()
        .session_id
        .ok_or("no session kept")?;
    ensure(
        last_reply(&a.id) == format!("opencode {session} 1"),
        format!("{:?}", last_reply(&a.id)),
    )?;
    ensure(h.drafting(&a.id, 5), "the reply never streamed as a draft")?;
    ensure(
        timeline(&a.id).len() >= 2,
        format!("timeline {:?}", timeline(&a.id)),
    )?;
    // The secret went over stdin only.
    let opened: Vec<Value> = h
        .fake_log()
        .into_iter()
        .filter(|e| e["engine"] == "opencode" && e.get("method").is_some())
        .collect();
    ensure(!opened.is_empty(), "the fake never opened a session")?;
    for e in &opened {
        ensure(
            e["header"] == true,
            "no Authorization header in session/new",
        )?;
        ensure(
            e["env_has_bearer"] == false,
            "the secret is in its environment",
        )?;
        ensure(
            !e["argv"].to_string().contains("Bearer")
                && !e["config"].to_string().contains("Bearer"),
            "the secret is on its command line or in its config",
        )?;
        ensure(
            e["config"]["permission"]["bash"] == "ask",
            format!("bash isn't asked: {}", e["config"]["permission"]),
        )?;
    }

    // Resumed: the same session, the second turn in it.
    h.send(&a.id, &fake(json!([{"say": "again {session} {turn}"}])))
        .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == format!("again {session} 2"),
        format!("not resumed: {:?}", last_reply(&a.id)),
    )?;

    // Denied: nothing runs, and the agent hears why in the next round.
    h.send(
        &a.id,
        &fake(json!([
            {"bash": "python3 -c 'print(6*9)' > denied.txt"},
            {"say": "never said"}
        ])),
    )
    .await?;
    let c = card(h, &a.id, 1).await?;
    answer(h, &a.id, &c, false).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(!home.join("denied.txt").exists(), "a denied command ran")?;
    ensure(
        last_reply(&a.id).starts_with("Noted:") && last_reply(&a.id).contains("said no"),
        format!("the agent wasn't told: {:?}", last_reply(&a.id)),
    )?;
    ensure(
        !replies(&a.id).iter().any(|r| r == "never said"),
        "the round carried on past a reject",
    )?;

    // A crash and an error each end in a line.
    for (name, script) in [
        ("crash", json!([{"crash": true}])),
        ("error", json!([{"error": "Provider returned 500"}])),
    ] {
        let before = log(&a.id).len();
        h.send(&a.id, &fake(script)).await?;
        h.turn(&a.id).await.map_err(|e| format!("{name}: {e}"))?;
        let new: Vec<AgentMessage> = log(&a.id).into_iter().skip(before).collect();
        ensure(
            new.iter().any(|m| {
                matches!(m.kind, MessageKind::Error | MessageKind::Note)
                    && !m.text.trim().is_empty()
            }),
            format!(
                "{name}: the turn ended without a line: {:?}",
                new.iter()
                    .map(|m| (m.kind, m.text.clone()))
                    .collect::<Vec<_>>()
            ),
        )?;
    }

    // A session OpenCode can't load is replaced, once, with the recap.
    store::update(&a.id, |a| {
        a.session_id = Some("ses_gone0000000000000000".into())
    })
    .unwrap();
    h.send(&a.id, &fake(json!([{"say": "fresh {session}"}])))
        .await?;
    h.turn(&a.id).await?;
    let now = store::get(&a.id).unwrap().session_id.unwrap_or_default();
    ensure(
        now != "ses_gone0000000000000000" && last_reply(&a.id) == format!("fresh {now}"),
        format!(
            "lost session not replaced: {:?} / {:?} / errors {:?}",
            now,
            last_reply(&a.id),
            errors(&a.id)
        ),
    )
}

/// Not in the default run: the real `opencode` on PATH (with
/// `AGENTS_FAKE_REAL_OPENCODE=1`, so the fake isn't installed as it), under
/// this run's throwaway HOME, on OpenCode's free models: a real model asks to
/// run a command, the card is allowed, and its reply comes back in a session
/// the next turn resumes. Needs the network.
async fn opencode_real(h: &H) -> Check {
    let a = h.agent("RealOpen");
    store::update(&a.id, |a| a.engine = Engine::OpenCode).unwrap();
    h.send(
        &a.id,
        "Run the shell command `echo opencode-real > real.txt` with your bash tool, then reply with just the word done.",
    )
    .await?;
    // A real model may or may not ask first; any card that comes is allowed.
    let start = Instant::now();
    let mut answered = 0;
    while runner::in_turn(&a.id) || start.elapsed() < Duration::from_secs(2) {
        if start.elapsed() > Duration::from_secs(240) {
            return Err("the real turn took over 4 minutes".into());
        }
        let cards = approvals(&a.id);
        if cards.len() > answered {
            let c = cards[answered].clone();
            answer(h, &a.id, &c, true).await?;
            answered += 1;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let home = store::agent_home(&a.id).unwrap();
    ensure(
        std::fs::read_to_string(home.join("real.txt"))
            .unwrap_or_default()
            .contains("opencode-real"),
        format!(
            "the command didn't run (cards answered: {answered}); replies {:?}",
            replies(&a.id)
        ),
    )?;
    println!("      cards answered: {answered}");
    let session = store::get(&a.id)
        .unwrap()
        .session_id
        .ok_or("no session kept")?;
    ensure(!last_reply(&a.id).is_empty(), "no reply")?;
    h.send(&a.id, "What word did you reply with last time? One word.")
        .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        store::get(&a.id).unwrap().session_id.as_deref() == Some(session.as_str()),
        "the session wasn't resumed",
    )?;
    println!(
        "      real replies: {:?}; timeline: {:?}",
        replies(&a.id),
        timeline(&a.id)
    );
    Ok(())
}

/// Claude Code's `result` is in but the process stays alive (a background
/// task it started): the turn is over, and the agent is idle soon after.
async fn lingering(h: &H) -> Check {
    let a = h.agent("Lingerer");
    let started = Instant::now();
    h.send(
        &a.id,
        &fake(json!([{"say": "all done"}, {"result": true}, {"hang": true}])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        started.elapsed() < Duration::from_secs(30),
        format!("idle only after {}s", started.elapsed().as_secs()),
    )?;
    ensure(
        last_reply(&a.id) == "all done",
        format!("{:?}", replies(&a.id)),
    )
}

/// A `result`, then more work in the same process (a helper reporting back
/// starts another round): both replies kept, one turn counted.
async fn rounds(h: &H) -> Check {
    let a = h.agent("Rounds");
    h.send(
        &a.id,
        &fake(json!([
            {"say": "first round"},
            {"result": true},
            {"sleep": 1},
            {"say": "second round"}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let said = replies(&a.id);
    ensure(
        said == ["first round", "second round"],
        format!("replies: {said:?}"),
    )?;
    let usage = store::get(&a.id).unwrap().usage.all_time;
    ensure(usage.turns == 1, format!("{} turns counted", usage.turns))
}

/// Torn and foreign lines in the stream are skipped; the turn still lands.
async fn garbage(h: &H) -> Check {
    let a = h.agent("Noisy");
    h.send(
        &a.id,
        &fake(json!([
            {"raw": "not json at all"},
            {"raw": "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"te"},
            {"raw": "{\"type\":\"mystery_event\",\"x\":1}"},
            {"raw": "[1,2,3]"},
            {"say": "landed"}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == "landed",
        format!("{:?}", replies(&a.id)),
    )
}

/// The approval wait runs out (shortened): the call is denied with "no
/// answer", the card closes as expired, the turn carries on, and a late
/// Allow on it runs nothing.
async fn late_allow(h: &H) -> Check {
    let a = h.agent("Late");
    std::env::set_var("SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS", "2");
    let r = async {
        h.send(
            &a.id,
            &fake(json!([{"bash": "touch late.txt"}, {"say": "gave up waiting"}])),
        )
        .await?;
        let c = card(h, &a.id, 0).await?;
        h.turn(&a.id).await?;
        Ok::<_, String>(c)
    }
    .await;
    std::env::remove_var("SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS");
    let c = r?;
    let home = store::agent_home(&a.id).unwrap();
    ensure(!home.join("late.txt").exists(), "ran without an answer")?;
    ensure(
        last_reply(&a.id) == "gave up waiting",
        format!("the turn didn't carry on: {:?}", replies(&a.id)),
    )?;
    let told = h
        .fake_log()
        .into_iter()
        .filter(|e| e["tool"] == "approve")
        .any(|e| e["reply"].to_string().contains("No answer"));
    ensure(told, "the engine wasn't told there was no answer")?;
    let still = approvals(&a.id).pop().unwrap();
    ensure(
        still.status == store::ApprovalStatus::Expired,
        format!("the card after the wait: {:?}", still.status),
    )?;
    let _ = answer(h, &a.id, &c, true).await;
    h.turn(&a.id).await?;
    ensure(!home.join("late.txt").exists(), "a late Allow ran it")?;
    ensure(
        store::get(&a.id).unwrap().pending_approvals == 0,
        "the pending count still counts it",
    )
}

/// A message for another conversation while a turn runs: never batched
/// with this one, and it runs in its own conversation's session.
async fn queue_conversations(h: &H) -> Check {
    let a = h.agent("TwoRooms");
    h.send(&a.id, &fake(json!([{"say": "one {session} {turn}"}])))
        .await?;
    h.turn(&a.id).await?;
    let first = agents::conversations::list(&a.id)
        .map_err(|e| e.to_string())?
        .current;
    let s1 = store::get(&a.id).unwrap().session_id.ok_or("no session")?;
    let second = cmd::agents_conversation_new(h.app.clone(), a.id.clone())
        .await
        .map_err(|e| e.to_string())?
        .current;
    h.send_in(
        &a.id,
        &fake(json!([{"sleep": 1.5}, {"say": "first-slow {session}"}])),
        Some(&first),
    )
    .await?;
    h.until("the turn to start", Duration::from_secs(10), || {
        !h.turns_with("first-slow").is_empty()
    })
    .await?;
    h.send_in(&a.id, "second-a", Some(&second)).await?;
    h.send_in(
        &a.id,
        &fake(json!([{"say": "second-b {session} {turn}"}])),
        Some(&first),
    )
    .await?;
    h.send_in(
        &a.id,
        &fake(json!([{"say": "second-c {session} {turn}"}])),
        Some(&second),
    )
    .await?;
    h.idle(&[&a.id], Duration::from_secs(1), Duration::from_secs(60))
        .await?;
    no_errors(&a.id)?;
    for t in h.fake_log().into_iter().filter(|e| e.get("turn").is_some()) {
        let p = t["prompt"].as_str().unwrap_or("");
        ensure(
            !(p.contains("second-a") && p.contains("second-b")),
            "messages for two conversations went in one turn",
        )?;
    }
    let by_text = |prefix: &str| {
        log(&a.id)
            .into_iter()
            .find(|m| m.kind == MessageKind::Agent && m.text.starts_with(prefix))
    };
    let b = by_text("second-b").ok_or("no reply in the first conversation")?;
    let c = by_text("second-c").ok_or("no reply in the second conversation")?;
    ensure(
        b.text.contains(&s1) && b.conversation.as_deref().is_none_or(|x| x == first),
        format!(
            "first conversation's reply: {:?} in {:?}",
            b.text, b.conversation
        ),
    )?;
    ensure(
        !c.text.contains(&s1) && c.conversation.as_deref() == Some(second.as_str()),
        format!(
            "second conversation's reply: {:?} in {:?}",
            c.text, c.conversation
        ),
    )
}

/// Ask for changes: the agent's second share_result revises the card (v2).
async fn revise(h: &H) -> Check {
    let a = h.agent("Reviser");
    let share = |revises: Option<&str>, title: &str| {
        let mut args = json!({
            "title": title,
            "summary": "A note.",
            "items": [{"path": "note.md"}],
            "checked": ["Read it back"],
            "not_verified": []
        });
        if let Some(id) = revises {
            args["revises"] = json!(id);
            args["changes"] = json!("Shorter");
        }
        fake(json!([
            {"write": "note.md", "text": title},
            {"tool": "share_result", "args": args},
            {"say": "shared"}
        ]))
    };
    h.send(&a.id, &share(None, "Note v1")).await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let first = log(&a.id)
        .into_iter()
        .find_map(|m| m.result)
        .ok_or("no result card")?;
    cmd::agents_send(
        h.app.clone(),
        a.id.clone(),
        share(Some(&first.id), "Note v2"),
        None,
        None,
        None,
        Some(first.id.clone()),
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let cards: Vec<_> = log(&a.id).into_iter().filter_map(|m| m.result).collect();
    let last = cards.last().unwrap();
    ensure(
        last.version == 2 && last.id == first.id && last.title == "Note v2",
        format!(
            "cards: {:?}",
            cards
                .iter()
                .map(|c| (&c.id, c.version, &c.title))
                .collect::<Vec<_>>()
        ),
    )
}

/// A big reply and a big command output in one turn.
async fn big(h: &H) -> Check {
    let a = h.agent("Verbose");
    let long = "lorem ipsum dolor sit amet ".repeat(4000);
    h.send(
        &a.id,
        &fake(json!([
            {"bash": "python3 -c \"print('x' * 2000000)\"", "ask": false},
            {"say": long},
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id).len() >= 100_000,
        format!("reply cut to {}", last_reply(&a.id).len()),
    )
}

/// The agent is deleted while its turn runs: the turn stops, nothing is
/// written back for it, and nothing is left running.
async fn delete_mid_turn(h: &H) -> Check {
    let a = h.agent("Doomed2");
    h.send(&a.id, &fake(json!([{"say": "working"}, {"hang": true}])))
        .await?;
    h.until("the turn", Duration::from_secs(10), || {
        !h.turns_with("\"working\"").is_empty()
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    cmd::agents_delete(h.app.clone(), a.id.clone())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    h.until("the turn to end", Duration::from_secs(20), || {
        !runner::in_turn(&a.id)
    })
    .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let pids: Vec<i64> = h
        .turns_with("\"working\"")
        .iter()
        .filter_map(|t| t["pid"].as_i64())
        .collect();
    for pid in pids {
        // SAFETY: signal 0 only asks whether the process exists.
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
        ensure(!alive, format!("the engine ({pid}) still runs"))?;
    }
    ensure(store::get(&a.id).is_err(), "still there")
}

/// A crash in the second conversation is picked up in that conversation's
/// session, never the first's.
async fn conversation_crash(h: &H) -> Check {
    let a = h.agent("CrashRoom");
    h.send(&a.id, &fake(json!([{"say": "one {session}"}])))
        .await?;
    h.turn(&a.id).await?;
    let s1 = store::get(&a.id).unwrap().session_id.ok_or("no session")?;
    let second = cmd::agents_conversation_new(h.app.clone(), a.id.clone())
        .await
        .map_err(|e| e.to_string())?
        .current;
    std::env::set_var(
        "FAKE_ENGINE_DEFAULT",
        json!([{"say": "picked up in {session}"}]).to_string(),
    );
    let r = async {
        h.send_in(
            &a.id,
            &fake(json!([{"say": "two {session}"}, {"crash": true}])),
            Some(&second),
        )
        .await?;
        h.turn(&a.id).await
    }
    .await;
    std::env::remove_var("FAKE_ENGINE_DEFAULT");
    r?;
    let picked = log(&a.id)
        .into_iter()
        .find(|m| m.kind == MessageKind::Agent && m.text.starts_with("picked up in"))
        .ok_or_else(|| format!("no pick-up: {:?}", replies(&a.id)))?;
    ensure(
        !picked.text.contains(&s1),
        format!(
            "picked up in the first conversation's session: {}",
            picked.text
        ),
    )?;
    ensure(
        picked.conversation.as_deref() == Some(second.as_str()),
        format!("the pick-up went to {:?}", picked.conversation),
    )
}

/// Tool calls the app refuses (an agent that doesn't exist, a file outside
/// its folders) come back as errors to the engine; the turn carries on.
async fn refused_tools(h: &H) -> Check {
    let a = h.agent("Wrong");
    h.send(
        &a.id,
        &fake(json!([
            {"tool": "message_agent", "args": {"agent": "Nobody Here", "message": "hi"}},
            {"tool": "share_result", "args": {
                "title": "Secrets", "summary": "x",
                "items": [{"path": "/etc/hosts"}], "checked": [], "not_verified": []}},
            {"tool": "no_such_tool", "args": {}},
            {"say": "carried on"}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id) == "carried on",
        format!("{:?}", replies(&a.id)),
    )?;
    let answers: Vec<Value> = h
        .fake_log()
        .into_iter()
        .filter(|e| {
            e["tool"] == "message_agent" && e["args"]["agent"] == "Nobody Here"
                || e["tool"] == "share_result" && e["args"]["title"] == "Secrets"
                || e["tool"] == "no_such_tool"
        })
        .collect();
    ensure(answers.len() == 3, format!("{} answers", answers.len()))?;
    for e in &answers {
        let refused = e["reply"]["result"]["isError"] == true || e["reply"].get("error").is_some();
        ensure(refused, format!("not refused: {e}"))?;
    }
    ensure(
        log(&a.id).iter().all(|m| m.result.is_none()),
        "a result card was made from a file outside its folders",
    )
}

/// Every Claude Code account out, Codex signed in: one card asks; Allow
/// (just this time) carries the turn on with Codex, with its quiet line;
/// the Claude Code session is kept for when it's back.
async fn crossover(h: &H) -> Check {
    accounts_have_room();
    let a = h.agent("Crosser");
    h.send(&a.id, &fake(json!([{"say": "on claude {session}"}])))
        .await?;
    h.turn(&a.id).await?;
    let claude_session = store::get(&a.id).unwrap().session_id.ok_or("no session")?;
    let script = fake(json!([
        {"usage_limit": true},
        {"say": "on the other engine"}
    ]));
    h.send(&a.id, &script).await?;
    let card_seen = h
        .until("the carry-on card", Duration::from_secs(20), || {
            approvals(&a.id).iter().any(|c| c.crossover.is_some())
        })
        .await;
    let result = async {
        card_seen?;
        let c = approvals(&a.id)
            .into_iter()
            .find(|c| c.crossover.is_some())
            .unwrap();
        answer(h, &a.id, &c, true).await?;
        h.idle(&[&a.id], Duration::from_secs(1), Duration::from_secs(60))
            .await?;
        let codex_turns: Vec<Value> = h
            .turns_with("on the other engine")
            .into_iter()
            .filter(|t| t["engine"] == "codex")
            .collect();
        ensure(
            !codex_turns.is_empty(),
            format!(
                "never ran on Codex: replies {:?}, notes {:?}, errors {:?}",
                replies(&a.id),
                notes(&a.id),
                errors(&a.id)
            ),
        )?;
        ensure(
            last_reply(&a.id) == "on the other engine",
            format!("{:?}", replies(&a.id)),
        )?;
        ensure(
            notes(&a.id).iter().any(|n| n.contains("Codex")),
            format!("no line about carrying on: {:?}", notes(&a.id)),
        )?;
        let agent = store::get(&a.id).unwrap();
        ensure(
            agent.engine == Engine::Claude && agent.session_id.as_deref() == Some(&claude_session),
            format!(
                "its own engine's session wasn't kept: {:?} {:?}",
                agent.engine, agent.session_id
            ),
        )?;

        // Its own engine has room again: back in the session it left, with
        // one line saying so.
        accounts_have_room();
        h.send(&a.id, &fake(json!([{"say": "back in {session}"}])))
            .await?;
        h.turn(&a.id).await?;
        ensure(
            last_reply(&a.id) == format!("back in {claude_session}"),
            format!(
                "not back in its own session: {:?}, notes {:?}",
                replies(&a.id),
                notes(&a.id)
            ),
        )?;
        ensure(
            notes(&a.id).iter().any(|n| n.starts_with("Back on")),
            format!("no line about coming back: {:?}", notes(&a.id)),
        )
    }
    .await;
    accounts_have_room();
    result
}

/// Make an agent's routines due now and tick the scheduler once.
fn fire_routines(h: &H, id: &str) {
    let now = store::now_ms();
    store::update(id, |a| {
        for c in &mut a.check_ins {
            c.next_at = now - 1_000;
        }
    })
    .unwrap();
    agents::schedule::tick_once(&h.app).unwrap();
}

/// A routine the agent set up itself fires, runs its note as a turn and is
/// recorded as run; a routine in steps waits on "OK to go on?" before the
/// step marked so, and goes on when it's allowed.
async fn routines(h: &H) -> Check {
    let a = h.agent("Regular");
    let step1 = fake(json!([{"say": "step one done"}]));
    let step2 = fake(json!([{"say": "step two done"}]));
    h.send(
        &a.id,
        &fake(json!([
            {"tool": "schedule_check_in", "args": {
                "when": "every day at 9:00",
                "note": step1,
                "then": [{"text": step2, "ask_first": true}]}},
            {"say": "set up"}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let agent = store::get(&a.id).unwrap();
    ensure(
        agent.check_ins.len() == 1,
        format!(
            "{} routines: {:?}",
            agent.check_ins.len(),
            h.fake_log()
                .into_iter()
                .filter(|e| e["tool"] == "schedule_check_in")
                .map(|e| e["reply"].to_string())
                .collect::<Vec<_>>()
        ),
    )?;
    fire_routines(h, &a.id);
    h.until("step one", Duration::from_secs(20), || {
        replies(&a.id).iter().any(|r| r == "step one done")
    })
    .await?;
    let c = card(h, &a.id, 0).await?;
    ensure(
        replies(&a.id).iter().all(|r| r != "step two done"),
        "step two ran before its OK",
    )?;
    answer(h, &a.id, &c, true).await?;
    h.until("step two", Duration::from_secs(20), || {
        replies(&a.id).iter().any(|r| r == "step two done")
    })
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let agent = store::get(&a.id).unwrap();
    let runs = &agent.check_ins[0].runs;
    ensure(!runs.is_empty(), "the routine's run wasn't recorded")?;
    ensure(
        agent.check_ins[0].next_at > store::now_ms(),
        "the routine isn't scheduled again",
    )?;
    ensure(
        of_kind(&a.id, MessageKind::CheckIn).len() >= 1,
        "no line saying the routine fired",
    )
}

/// A routine whose turn fails is recorded as failed (and retried, not
/// lost), and shows in the brief as a routine that didn't work.
async fn routine_fails(h: &H) -> Check {
    let a = h.agent("Flaky");
    let bad = fake(json!([{"error": "API Error: 529 Overloaded"}]));
    h.send(
        &a.id,
        &fake(json!([
            {"tool": "schedule_check_in", "args": {"when": "every day at 9:00", "note": bad}},
            {"say": "set up"}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    fire_routines(h, &a.id);
    h.until("the routine's turn", Duration::from_secs(20), || {
        !h.turns_with("529 Overloaded").is_empty()
    })
    .await?;
    h.turn(&a.id).await?;
    let agent = store::get(&a.id).unwrap();
    let c = &agent.check_ins[0];
    let outcomes: Vec<String> = c.runs.iter().map(|r| format!("{:?}", r.outcome)).collect();
    ensure(
        outcomes.iter().any(|o| o == "Failed") || c.retry.is_some(),
        format!("runs {outcomes:?}, retry {:?}", c.retry.is_some()),
    )
}

/// "Always allow" on a card: the same command later runs without one, and
/// says so in a line.
async fn always_allow(h: &H) -> Check {
    let a = h.agent("Trusting");
    h.send(
        &a.id,
        &fake(json!([{"bash": "touch always.txt"}, {"say": "first"}])),
    )
    .await?;
    let c = card(h, &a.id, 0).await?;
    cmd::agents_answer_approval(
        h.app.clone(),
        a.id.clone(),
        c.request_id.clone(),
        true,
        Some(true),
        None,
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    h.turn(&a.id).await?;
    h.send(
        &a.id,
        &fake(json!([{"bash": "touch always.txt"}, {"say": "second"}])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        approvals(&a.id).len() == 1,
        format!("asked again: {} cards", approvals(&a.id).len()),
    )?;
    ensure(
        last_reply(&a.id) == "second",
        format!("{:?}", replies(&a.id)),
    )
}

/// Two agents waiting on cards at once: each answer reaches its own turn.
async fn two_cards(h: &H) -> Check {
    let a = h.agent("Left");
    let b = h.agent("Right");
    h.send(
        &a.id,
        &fake(json!([{"bash": "touch left.txt"}, {"say": "left {turn}"}])),
    )
    .await?;
    h.send(
        &b.id,
        &fake(json!([{"bash": "touch right.txt"}, {"say": "right {turn}"}])),
    )
    .await?;
    let ca = card(h, &a.id, 0).await?;
    let cb = card(h, &b.id, 0).await?;
    // Answering one agent's card with the other's id does nothing.
    let crossed = answer(h, &a.id, &cb, true).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    ensure(
        !store::agent_home(&a.id).unwrap().join("right.txt").exists()
            && !store::agent_home(&b.id).unwrap().join("right.txt").exists(),
        format!("a card answered through the wrong agent ran it ({crossed:?})"),
    )?;
    answer(h, &b.id, &cb, false).await?;
    answer(h, &a.id, &ca, true).await?;
    h.idle(
        &[&a.id, &b.id],
        Duration::from_secs(1),
        Duration::from_secs(30),
    )
    .await?;
    ensure(
        store::agent_home(&a.id).unwrap().join("left.txt").exists(),
        "the allowed one didn't run",
    )?;
    ensure(
        !store::agent_home(&b.id).unwrap().join("right.txt").exists(),
        "the denied one ran",
    )
}

/// An agent blocked on an app asks once (`request_login`): one login card,
/// on its turn's word to stop; a second ask for the same app while it waits
/// makes no second card. Declining it wakes the agent.
async fn login(h: &H) -> Check {
    let a = h.agent("Needy");
    // Just try first: the app points it at the agents' browser; the page
    // asks for a sign-in, so it asks again saying so, and gets a card.
    let first = json!({"tool": "request_login", "args": {
        "service": "linear", "scopes": ["read"], "why": "Read the open issues"}});
    let ask = json!({"tool": "request_login", "args": {
        "service": "linear", "scopes": ["read"], "why": "Read the open issues",
        "signed_out": true, "browser": "agents"}});
    h.send(
        &a.id,
        &fake(json!([first, ask, {"say": "asked for Linear"}])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let logins = || {
        approvals(&a.id)
            .into_iter()
            .filter(|c| c.login.is_some())
            .collect::<Vec<_>>()
    };
    ensure(
        logins().len() == 1,
        format!(
            "{} login cards; the tool said {:?}",
            logins().len(),
            h.fake_log()
                .into_iter()
                .filter(|e| e["tool"] == "request_login")
                .map(|e| e["reply"].to_string())
                .collect::<Vec<_>>()
        ),
    )?;
    h.send(&a.id, &fake(json!([ask, {"say": "asked again"}])))
        .await?;
    h.turn(&a.id).await?;
    ensure(
        logins().len() == 1,
        format!("asked twice: {} login cards", logins().len()),
    )?;
    let c = logins().pop().unwrap();
    let turns = h
        .fake_log()
        .iter()
        .filter(|e| e.get("turn").is_some())
        .count();
    answer(h, &a.id, &c, false).await?;
    h.until("the agent woken", Duration::from_secs(20), || {
        h.fake_log()
            .iter()
            .filter(|e| e.get("turn").is_some())
            .count()
            > turns
    })
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    ensure(
        store::get(&a.id).unwrap().pending_approvals == 0,
        "the declined card still counts",
    )
}

/// A turn whose engine reports permission checks off is stopped, and says
/// so; one whose connection to the app failed is stopped too.
async fn untrusted_init(h: &H) -> Check {
    let a = h.agent("Bypassed");
    std::env::set_var("FAKE_ENGINE_PERMISSION_MODE", "bypassPermissions");
    let r = async {
        h.send(
            &a.id,
            &fake(json!([{"sleep": 2}, {"say": "should not be seen"}])),
        )
        .await?;
        h.turn(&a.id).await
    }
    .await;
    std::env::remove_var("FAKE_ENGINE_PERMISSION_MODE");
    r?;
    ensure(
        replies(&a.id).iter().all(|r| r != "should not be seen"),
        "a bypassPermissions turn went on",
    )?;
    let said: Vec<String> = log(&a.id)
        .into_iter()
        .filter(|m| matches!(m.kind, MessageKind::Error | MessageKind::Note))
        .map(|m| m.text)
        .collect();
    ensure(
        said.iter().any(|t| t.contains("bypassPermissions")),
        format!("no line saying why: {said:?}"),
    )
}

/// The fixture both clients draw: this scenario's two messages, as the desk
/// (`agents_messages`) and the phone (the companion's `messages`) receive
/// them, made stable. `AGENTS_FAKE_WRITE_FIXTURES=1` rewrites it from a run.
fn blocks_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/companion-protocol/src/blocks-turn.json")
}

/// What the fake's turn calls: a `show` with metrics, a chart, a table and
/// a choice, then nothing more (the receipt says stop and wait).
fn blocks_show() -> Value {
    json!({
        "text": "Here's the fruit stand this week.",
        "blocks": [
            {"kind": "metrics", "items": [
                {"label": "Sold", "value": 412, "delta": 9, "vs": "vs last week", "good": "up"},
                {"label": "Waste", "value": 3.5, "suffix": "%", "delta": "+0.5%", "good": "down"}
            ]},
            {"kind": "chart", "chart": "bar", "title": "Sold per day",
             "labels": ["Mon", "Tue", "Wed"],
             "series": [{"name": "Apples", "values": [40, 52, 61]},
                        {"name": "Mangoes", "values": [22, 30, null]}]},
            {"kind": "table", "title": "Prices",
             "columns": ["Fruit", {"label": "Price", "prefix": "$"}],
             "rows": [["Apple", 1.2], ["Banana", 0.5], ["Mango", 2.75]]},
            {"kind": "choices", "question": "Which one do you want?",
             "options": ["Apple", {"label": "Mango", "reply": "Mangoes, please."}]}
        ]
    })
}

/// Blocks end to end: the agent's `show` is checked and kept as one message
/// (its blocks, and a text fallback of the intro plus a summary each), the
/// agent is told to stop and wait, and answering the choice is the user's
/// own words through the ordinary send, reaching the next turn. The kept
/// messages must equal `blocks-turn.json`, which the desk's
/// (`AgentBlocks.test.tsx`) and the phone's (`blocks.test.tsx`) tests draw
/// and answer.
async fn blocks(h: &H) -> Check {
    let a = h.agent("Grocer");
    // Then a line repeating the question, as the real model wrote (twice)
    // even when told to stop: it goes in "What it did", not the chat.
    h.send(
        &a.id,
        &fake(json!([
            {"tool": "show", "args": blocks_show()},
            {"say": "I put up a table of prices. Which one do you want? Tap a fruit above."}
        ])),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let said = replies(&a.id);
    ensure(
        !said.iter().any(|r| r.contains("Tap a fruit above")),
        format!("the repeat reached the chat: {said:?}"),
    )?;
    let in_timeline = log(&a.id).iter().any(|m| {
        let work = m.work.clone().or_else(|| agents::work::load(&a.id, &m.id));
        format!("{work:?}").contains("Tap a fruit above")
    });
    ensure(in_timeline, "the repeat isn't in \"What it did\"")?;
    let shown: Vec<AgentMessage> = log(&a.id)
        .into_iter()
        .filter(|m| m.blocks.is_some())
        .collect();
    ensure(
        shown.len() == 1,
        format!("{} messages with blocks", shown.len()),
    )?;
    let m = &shown[0];
    let set = m.blocks.clone().unwrap();
    ensure(set["v"] == 1, format!("version: {}", set["v"]))?;
    let items = set["items"].as_array().cloned().unwrap_or_default();
    let kinds: Vec<&str> = items.iter().filter_map(|b| b["kind"].as_str()).collect();
    ensure(
        kinds == ["metrics", "chart", "table", "choices"],
        format!("kinds: {kinds:?}"),
    )?;
    ensure(
        items
            .iter()
            .all(|b| !b["summary"].as_str().unwrap_or("").is_empty()),
        format!("a block without a summary: {set}"),
    )?;
    ensure(
        m.text.starts_with("Here's the fruit stand this week.") && m.text.contains("Mango"),
        format!("text fallback: {:?}", m.text),
    )?;
    // The agent was told it's shown, and to wait for the answer.
    let told = h
        .fake_log()
        .iter()
        .any(|e| e.to_string().contains("stop here and wait for it"));
    ensure(told, "the show receipt never reached the engine")?;

    // Tapping "Mango" is the user's message, sent as anything typed is.
    h.send(&a.id, "Mangoes, please.").await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    // (The first turn's prompt holds the words too, inside its script.)
    let turns: Vec<Value> = h
        .turns_with("Mangoes, please.")
        .into_iter()
        .filter(|t| !t["prompt"].as_str().unwrap_or("").contains("#fake"))
        .collect();
    ensure(
        turns.len() == 1,
        format!("{} turns got the answer", turns.len()),
    )?;
    let after: Vec<AgentMessage> = log(&a.id)
        .into_iter()
        .skip_while(|x| x.id != m.id)
        .collect();
    let user = after
        .iter()
        .find(|x| x.kind == MessageKind::User)
        .ok_or("no user message after the blocks")?;
    ensure(
        user.text == "Mangoes, please.",
        format!("answer: {:?}", user.text),
    )?;

    // What the clients receive, made stable, against the shared fixture.
    let wire = |x: &AgentMessage, id: &str, ts: i64| -> Value {
        let mut v = serde_json::to_value(x).unwrap();
        let o = v.as_object_mut().unwrap();
        o.retain(|k, _| ["kind", "text", "blocks"].contains(&k.as_str()));
        o.insert("id".into(), json!(id));
        o.insert("agentId".into(), json!("grocer"));
        o.insert("ts".into(), json!(ts));
        v
    };
    let got = json!({ "messages": [wire(m, "m-blocks", 1), wire(user, "m-answer", 2)] });
    let path = blocks_fixture_path();
    if std::env::var("AGENTS_FAKE_WRITE_FIXTURES").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?,
    )
    .map_err(|e| e.to_string())?;
    ensure(
        got == want,
        format!(
            "the kept messages differ from blocks-turn.json (AGENTS_FAKE_WRITE_FIXTURES=1 rewrites it):\n{}",
            serde_json::to_string_pretty(&got).unwrap()
        ),
    )
}

/// One real Claude Code turn (`AGENTS_REAL_CLAUDE`, never in `ALL`): asked
/// for a table and a question, does the model call `show` with valid blocks
/// first try? Prints every `show` call and what the app answered.
async fn real_blocks(h: &H) -> Check {
    ensure(
        std::env::var("AGENTS_REAL_CLAUDE").is_ok(),
        "set AGENTS_REAL_CLAUDE to the claude binary",
    )?;
    let a = h.agent("Grocer");
    let ask = std::env::var("AGENTS_REAL_PROMPT").unwrap_or_else(|_| {
        "show me a small table of 3 fruits and their prices and ask me which one I want".into()
    });
    h.send(&a.id, &ask).await?;
    h.idle(
        &[&a.id],
        Duration::from_millis(800),
        Duration::from_secs(240),
    )
    .await?;
    for m in log(&a.id) {
        println!(
            "--- {:?}: {}\n{}",
            m.kind,
            m.text,
            m.blocks
                .as_ref()
                .map(|b| serde_json::to_string_pretty(b).unwrap())
                .unwrap_or_default()
        );
    }
    // Every `show` call and its answer, from the engine's own transcript.
    // Under the real HOME, in the folders named after this run's (temp) agent
    // homes; removed once read, so nothing of the run stays behind.
    let mut calls = 0;
    let mut failed = 0;
    let projects = PathBuf::from(std::env::var("AGENTS_FAKE_REAL_HOME").unwrap_or_default())
        .join(".claude/projects");
    let tag = format!("agents-fake-{}", std::process::id());
    let ours: Vec<PathBuf> = std::fs::read_dir(&projects)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().contains(&tag))
        })
        .collect();
    let files: Vec<PathBuf> = ours.iter().flat_map(|d| walk(d)).collect();
    for entry in files {
        let text = std::fs::read_to_string(&entry).unwrap_or_default();
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            for part in v["message"]["content"].as_array().into_iter().flatten() {
                if part["type"] == "tool_use"
                    && part["name"].as_str().unwrap_or("").ends_with("__show")
                {
                    calls += 1;
                    println!("show call: {}", part["input"]);
                }
                if (part["type"] == "tool_result" && line.contains("Shown in the chat"))
                    || part["is_error"] == true
                {
                    if part["is_error"] == true {
                        failed += 1;
                    }
                    println!("tool result: {}", part["content"]);
                }
            }
        }
    }
    for d in &ours {
        let _ = std::fs::remove_dir_all(d);
    }
    ensure(calls > 0, "the model never called show")?;
    ensure(failed == 0, format!("{failed} tool calls failed"))?;
    ensure(
        log(&a.id).iter().any(|m| m.blocks.is_some()),
        "no message with blocks",
    )
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(p);
        }
    }
    out
}

/* ------------------------------------------------------------------ parity */

/// The engines a feature must work the same on: Claude Code, Codex on its
/// `app-server` (what a current Codex runs on), Codex on `exec` (the
/// fallback for an older one) and OpenCode over ACP.
#[derive(Clone, Copy, PartialEq, Debug)]
enum On {
    Claude,
    CodexApp,
    CodexExec,
    OpenCode,
}

impl On {
    fn engine(self) -> Engine {
        match self {
            On::Claude => Engine::Claude,
            On::CodexApp | On::CodexExec => Engine::Codex,
            On::OpenCode => Engine::OpenCode,
        }
    }

    /// Whether its turns can stop on a card (`EngineInfo::asks`).
    fn asks(self) -> bool {
        self != On::CodexExec
    }

    /// Set the Codex driver the next turns use (debug builds read this).
    fn drive(self) {
        if self == On::CodexApp {
            std::env::remove_var("SHIPSTUDIO_AGENTS_CODEX_EXEC");
        } else {
            std::env::set_var("SHIPSTUDIO_AGENTS_CODEX_EXEC", "1");
        }
    }
}

/// One agent on `on`, muted.
fn parity_agent(h: &H, name: &str, on: On) -> store::Agent {
    on.drive();
    let a = h.agent(name);
    store::update(&a.id, |a| a.engine = on.engine()).unwrap()
}

/// Every feature that landed tonight, the same on each engine:
/// - `show` is served (the engine reaches it through its own MCP config),
///   is kept as one message with blocks, the receipt reaches the engine,
///   and what the engine writes after an asking `show` goes in "What it
///   did", whatever its streaming events are;
/// - a command asks through the same card and runs on Allow, or, on an
///   engine that can't ask, the app says so rather than pretending;
/// - a result card is kept;
/// - the turn's tokens are counted (never a price it didn't report);
/// - the usage tools answer;
/// - two conversations each resume their own session.
async fn parity(h: &H, on: On) -> Check {
    let name = match on {
        On::Claude => "ParityClaude",
        On::CodexApp => "ParityCodexApp",
        On::CodexExec => "ParityCodexExec",
        On::OpenCode => "ParityOpenCode",
    };
    let a = parity_agent(h, name, on);
    let home = store::agent_home(&a.id).unwrap();
    let step = |what: &str, e: String| format!("{on:?} {what}: {e}");

    // 1. Blocks, and the words after the question.
    h.send(
        &a.id,
        &fake(json!([
            {"list_tools": true},
            {"say": "What I found:\n\n- Apples are up\n- Mangoes are short"},
            {"tool": "show", "args": blocks_show()},
            {"slow": "I put up a table of prices. Which one do you want? Tap a fruit above.", "every": 0.05}
        ])),
    )
    .await?;
    h.turn(&a.id).await.map_err(|e| step("show", e))?;
    no_errors(&a.id).map_err(|e| step("show", e))?;
    // `show` reached it through its own MCP config.
    let served = h
        .fake_log()
        .into_iter()
        .rev()
        .find_map(|e| e.get("served").cloned())
        .unwrap_or_default();
    ensure(
        served
            .as_array()
            .is_some_and(|t| t.iter().any(|t| t == agents::blocks::TOOL)),
        step("tools", format!("`show` not served: {served}")),
    )?;
    let shown = log(&a.id).iter().filter(|m| m.blocks.is_some()).count();
    ensure(
        shown == 1,
        step("show", format!("{shown} messages with blocks")),
    )?;
    let said = replies(&a.id);
    ensure(
        !said.iter().any(|r| r.contains("Tap a fruit above")),
        step(
            "show",
            format!("the words after it reached the chat: {said:?}"),
        ),
    )?;
    // Its streamed draft was withdrawn, not left under the question.
    let last_draft = h
        .drafts
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(id, _)| *id == a.id)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    ensure(
        !last_draft.contains("Tap a fruit"),
        step("show", format!("its draft stayed: {last_draft:?}")),
    )?;
    // What it wrote before asking is the chat's, whenever the bridge heard
    // the `show` relative to the runner reading those words.
    ensure(
        said.iter().any(|r| r.starts_with("What I found:")),
        step(
            "show",
            format!("the words before it left the chat: {said:?}"),
        ),
    )?;
    let in_timeline = log(&a.id).iter().any(|m| {
        let work = m.work.clone().or_else(|| agents::work::load(&a.id, &m.id));
        format!("{work:?}").contains("Tap a fruit above")
    });
    ensure(
        in_timeline,
        step(
            "show",
            "the words after it aren't in \"What it did\"".into(),
        ),
    )?;
    let told = h.fake_log().iter().any(|e| {
        e["tool"] == agents::blocks::TOOL && e.to_string().contains("stop here and wait for it")
    });
    ensure(
        told,
        step("show", "the receipt never reached the engine".into()),
    )?;
    let usage = store::get(&a.id).unwrap().usage.all_time;
    ensure(
        usage.turns >= 1 && usage.input_tokens + usage.output_tokens > 0,
        step("usage", format!("not counted: {usage:?}")),
    )?;
    ensure(
        on == On::Claude || usage.priced_turns == 0,
        step("usage", format!("a price it never reported: {usage:?}")),
    )?;

    // 2. A command: the same card, or said plainly that it can't ask.
    let info = agents::engine::info(on.engine()).await;
    ensure(
        info.asks == on.asks(),
        step("asks", format!("the app says asks={} for it", info.asks)),
    )?;
    let before = approvals(&a.id).len();
    h.send(
        &a.id,
        &fake(json!([
            {"bash": "python3 -c 'print(6*7)' > parity.txt"},
            {"say": "Ran it."}
        ])),
    )
    .await?;
    if on.asks() {
        let c = card(h, &a.id, before).await.map_err(|e| step("card", e))?;
        ensure(
            c.tool.as_deref() == Some("Bash"),
            step("card", format!("card for {:?}", c.tool)),
        )?;
        answer(h, &a.id, &c, true).await?;
    }
    h.turn(&a.id).await.map_err(|e| step("card", e))?;
    no_errors(&a.id).map_err(|e| step("card", e))?;
    ensure(
        std::fs::read_to_string(home.join("parity.txt"))
            .unwrap_or_default()
            .trim()
            == "42",
        step("card", "the allowed command didn't run".into()),
    )?;
    ensure(
        last_reply(&a.id) == "Ran it.",
        step("card", format!("reply {:?}", last_reply(&a.id))),
    )?;

    // 2b. The independence level decides for it, as for Claude Code
    // (`mcp::decide`): a read at Steady and local work at Bold go through
    // with no card; a push at Bold still asks.
    if on.asks() {
        let quiet_before = approvals(&a.id).len();
        h.send(&a.id, &fake(json!([{"bash": "ls"}, {"say": "Looked."}])))
            .await?;
        h.turn(&a.id).await.map_err(|e| step("steady", e))?;
        ensure(
            approvals(&a.id).len() == quiet_before && last_reply(&a.id) == "Looked.",
            step(
                "steady",
                format!("a read asked: {:?}", approvals(&a.id).last()),
            ),
        )?;
        agents::independence::set_level(agents::independence::Level::GoHard, 0)
            .map_err(|e| e.to_string())?;
        let bold = async {
            h.send(
                &a.id,
                &fake(json!([
                    {"bash": "python3 -c 'print(1)' > bold.txt"},
                    {"bash": "git push origin main"},
                    {"say": "Pushed?"}
                ])),
            )
            .await?;
            let c = card(h, &a.id, quiet_before).await?;
            ensure(
                format!("{:?}", c.input).contains("push origin"),
                format!("the card is for {:?}", c.input),
            )?;
            ensure(home.join("bold.txt").exists(), "local work asked at Bold")?;
            answer(h, &a.id, &c, false).await?;
            h.turn(&a.id).await
        }
        .await;
        agents::independence::set_level(agents::independence::Level::Judgement, 0)
            .map_err(|e| e.to_string())?;
        bold.map_err(|e| step("bold", e))?;
    }

    // 3. A result card, and the usage tools.
    std::fs::write(home.join("report.csv"), "a,b\n1,2\n").unwrap();
    h.send(
        &a.id,
        &fake(json!([
            {"tool": "share_result", "args": {
                "title": "Tiny report",
                "summary": "Two columns, one row.",
                "items": [{"path": "report.csv", "label": "The CSV"}],
                "checked": ["Opened it"],
                "not_verified": ["Nothing else"]}},
            {"tool": "usage_overview"},
            {"say": "Here it is."}
        ])),
    )
    .await?;
    h.turn(&a.id).await.map_err(|e| step("result", e))?;
    no_errors(&a.id).map_err(|e| step("result", e))?;
    let cards = log(&a.id).iter().filter(|m| m.result.is_some()).count();
    ensure(cards == 1, step("result", format!("{cards} result cards")))?;
    let overview = h
        .fake_log()
        .into_iter()
        .rev()
        .find(|e| e["tool"] == "usage_overview")
        .ok_or_else(|| step("usage tools", "usage_overview never called".into()))?;
    ensure(
        overview["reply"]["result"]["isError"] != true,
        step("usage tools", format!("{}", overview["reply"])),
    )?;

    // 4. Several conversations: each its own session, each resumed.
    let s1 = store::get(&a.id)
        .unwrap()
        .session_id
        .ok_or_else(|| step("conversations", "no session".into()))?;
    let first = agents::conversations::list(&a.id)
        .map_err(|e| e.to_string())?
        .current;
    let second = cmd::agents_conversation_new(h.app.clone(), a.id.clone())
        .await
        .map_err(|e| e.to_string())?
        .current;
    h.send_in(
        &a.id,
        &fake(json!([{"say": "two {session} {turn}"}])),
        Some(&second),
    )
    .await?;
    h.turn(&a.id).await.map_err(|e| step("conversations", e))?;
    let s2 = store::get(&a.id).unwrap().session_id.unwrap_or_default();
    ensure(
        s2 != s1 && last_reply(&a.id) == format!("two {s2} 1"),
        step(
            "conversations",
            format!("second: {s2} / {:?}", last_reply(&a.id)),
        ),
    )?;
    h.send_in(
        &a.id,
        &fake(json!([{"say": "one again {session}"}])),
        Some(&first),
    )
    .await?;
    h.turn(&a.id).await.map_err(|e| step("conversations", e))?;
    no_errors(&a.id).map_err(|e| step("conversations", e))?;
    ensure(
        last_reply(&a.id) == format!("one again {s1}"),
        step(
            "conversations",
            format!("first not resumed: {:?}", last_reply(&a.id)),
        ),
    )?;
    on.drive();
    // Codex on app-server reads the plan's limits each turn.
    if on == On::CodexApp {
        let read = agents::quota::load()
            .into_iter()
            .any(|q| q.engine == Engine::Codex && !q.windows.is_empty());
        ensure(
            read,
            step("quota", "the plan's limits were never read".into()),
        )?;
    }
    std::env::set_var("SHIPSTUDIO_AGENTS_CODEX_EXEC", "1");
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
    "failover-acted",
    "crash-twice",
    "stop-card",
    "queue-card",
    "interrupt",
    "codex",
    "opencode",
    "lingering",
    "rounds",
    "garbage",
    "late-allow",
    "queue-conversations",
    "revise",
    "big",
    "delete-mid-turn",
    "conversation-crash",
    "refused-tools",
    "crossover",
    "routines",
    "routine-fails",
    "always-allow",
    "two-cards",
    "login",
    "untrusted-init",
    "brief",
    "blocks",
    "parity-claude",
    "parity-codex-app",
    "parity-codex-exec",
    "parity-opencode",
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
    let codex = bin.join("codex");
    let _ = std::fs::remove_file(&codex);
    std::os::unix::fs::symlink(&script, &codex).unwrap();
    // OpenCode over `opencode acp`, the fake speaking ACP (unless the real
    // one is wanted: `opencode-real`).
    if std::env::var_os("AGENTS_FAKE_REAL_OPENCODE").is_none() {
        let opencode = bin.join("opencode");
        let _ = std::fs::remove_file(&opencode);
        std::os::unix::fs::symlink(&script, &opencode).unwrap();
    }
    // Codex on `exec`, the driver the fake speaks (debug builds read this).
    std::env::set_var("SHIPSTUDIO_AGENTS_CODEX_EXEC", "1");
    std::env::set_var("CODEX_HOME", home.join(".codex"));
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
    let real_home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(r) = &real_home {
        std::env::set_var("AGENTS_FAKE_REAL_HOME", r);
    }
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
    // `AGENTS_REAL_CLAUDE=<path to claude>`: the real engine instead of the
    // fake, for the `real-*` scenarios only (a real model, real usage).
    // It runs with the real HOME (Claude Code's sign-in is found from it);
    // the app's own state, agents and Keychain stay in the throwaway one.
    if let Ok(real) = std::env::var("AGENTS_REAL_CLAUDE") {
        use std::os::unix::fs::PermissionsExt;
        let claude = home.join("fakebin/claude");
        let _ = std::fs::remove_file(&claude);
        let real_home = real_home.clone().expect("HOME");
        std::fs::write(
            &claude,
            format!(
                "#!/bin/sh\nHOME='{}' exec '{real}' \"$@\"\n",
                real_home.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

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
                "failover-acted" => failover_after_acting(&h).await,
                "crash-twice" => crash_twice(&h).await,
                "stop-card" => stop_on_card(&h).await,
                "queue-card" => queue_on_card(&h).await,
                "interrupt" => interrupt(&h).await,
                "codex" => codex(&h).await,
                "opencode" => opencode(&h).await,
                "opencode-real" => opencode_real(&h).await,
                "lingering" => lingering(&h).await,
                "rounds" => rounds(&h).await,
                "garbage" => garbage(&h).await,
                "late-allow" => late_allow(&h).await,
                "queue-conversations" => queue_conversations(&h).await,
                "revise" => revise(&h).await,
                "big" => big(&h).await,
                "delete-mid-turn" => delete_mid_turn(&h).await,
                "conversation-crash" => conversation_crash(&h).await,
                "refused-tools" => refused_tools(&h).await,
                "crossover" => crossover(&h).await,
                "routines" => routines(&h).await,
                "routine-fails" => routine_fails(&h).await,
                "always-allow" => always_allow(&h).await,
                "two-cards" => two_cards(&h).await,
                "login" => login(&h).await,
                "untrusted-init" => untrusted_init(&h).await,
                "blocks" => blocks(&h).await,
                "parity-claude" => parity(&h, On::Claude).await,
                "parity-codex-app" => parity(&h, On::CodexApp).await,
                "parity-codex-exec" => parity(&h, On::CodexExec).await,
                "parity-opencode" => parity(&h, On::OpenCode).await,
                "real-blocks" => real_blocks(&h).await,
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
