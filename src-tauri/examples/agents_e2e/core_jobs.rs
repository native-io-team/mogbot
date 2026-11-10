//! The core jobs, end to end, at the independence levels people pick
//! (`scripts/agents-e2e.sh core`, or one `core-…` scenario). Each is one or
//! two small Haiku turns:
//!
//! - `core-delegate`: at Go hard the Chief creates an agent and delegates a
//!   file write in its home; no cards anywhere
//! - `core-chain`: a local command chain (mkdir, write, ls, a for-loop, a log
//!   in the temporary folder) at Go hard; zero cards, receipts instead
//! - `core-often`: the same chain at "Check with me often"; cards appear
//! - `core-push`: `git push` to a local bare remote at Go hard; a card (denied)
//! - `core-result`: `share_result` with a file; a result card in the chat
//! - `core-kill`: the engine killed mid-turn; the turn ends in a line saying
//!   so, and the next message gets a reply
//! - `core-search`: WebSearch at Go hard; no card

use std::time::Duration;

use app_lib::agents::independence::{self, Level};
use app_lib::agents::{procs, runner, store};
use app_lib::commands::agents as cmd;
use store::MessageKind;

use super::{approvals, ensure, last_reply, log, no_errors, of_kind, Check, H};

pub const ALL: [&str; 7] = [
    "core-delegate",
    "core-chain",
    "core-often",
    "core-push",
    "core-result",
    "core-kill",
    "core-search",
];

pub async fn run(h: &H, name: &str) -> Check {
    match name {
        "core-delegate" => delegate(h).await,
        "core-chain" => chain(h, Level::GoHard).await,
        "core-often" => chain(h, Level::Often).await,
        "core-push" => push(h).await,
        "core-result" => result(h).await,
        "core-kill" => kill(h).await,
        "core-search" => search(h).await,
        other => Err(format!("unknown scenario {other}")),
    }
}

fn level(l: Level) {
    independence::set_level(l, 0).expect("set the level");
}

fn cards_everywhere() -> Vec<(String, store::Approval)> {
    store::list()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|a| {
            approvals(&a.id)
                .into_iter()
                .map(move |c| (a.name.clone(), c))
        })
        .collect()
}

/// Every reply's "What it did", as one string to search.
fn timeline(id: &str) -> String {
    of_kind(id, MessageKind::Agent)
        .iter()
        .filter_map(|m| app_lib::agents::work::load(id, &m.id))
        .map(|w| format!("{w:?}"))
        .collect()
}

/// (a) The Chief creates an agent and delegates a tiny task, at Go hard.
async fn delegate(h: &H) -> Check {
    level(Level::GoHard);
    let chief = h.chief();
    // Agents the Chief makes start on the saved defaults: Haiku, like ours.
    app_lib::agents::defaults::set(app_lib::agents::defaults::Change {
        engine: Some("claude".into()),
        claude_model: Some("haiku".into()),
        codex_model: None,
        opencode_model: None,
    })
    .await
    .map_err(|e| format!("defaults: {e}"))?;
    let before = cards_everywhere().len();
    h.send(
        &chief.id,
        "Create an agent named Filer (role: writes small files). Then use message_agent to ask Filer: \"Write a file named hello.txt in your own folder containing exactly HELLO-E2E, then reply to Chief of Staff with message_agent saying done.\" When Filer says done, tell me in one line.",
    )
    .await?;
    h.until("Filer to exist", Duration::from_secs(150), || {
        store::find("Filer").ok().flatten().is_some()
    })
    .await?;
    let filer = store::find("Filer").unwrap().unwrap();
    h.idle(
        &[&chief.id, &filer.id],
        Duration::from_secs(5),
        Duration::from_secs(300),
    )
    .await?;
    let filer = store::get(&filer.id).unwrap();
    let file = store::agent_home(&filer.id).unwrap().join("hello.txt");
    let wrote = std::fs::read_to_string(&file).unwrap_or_default();
    ensure(
        wrote.trim() == "HELLO-E2E",
        format!("hello.txt in Filer's home: {wrote:?}"),
    )?;
    ensure(
        filer.model.as_deref() == Some("haiku"),
        format!("Filer runs on {:?}, not the default", filer.model),
    )?;
    let cards: Vec<_> = cards_everywhere().into_iter().skip(before).collect();
    ensure(cards.is_empty(), format!("cards at Go hard: {cards:?}"))?;
    ensure(
        of_kind(&chief.id, MessageKind::FromAgent)
            .iter()
            .any(|m| m.peer.as_ref().is_some_and(|p| p.id == filer.id)),
        "Filer's done never reached the Chief",
    )?;
    no_errors(&chief.id)?;
    no_errors(&filer.id)
}

const CHAIN: &str = "mkdir -p work/logs && printf 'alpha\\n' > work/a.txt && ls work && for i in 1 2 3; do echo \"line $i\" >> work/n.txt; done && echo chain-ok > \"${TMPDIR:-/tmp}/mogbot-e2e-chain.log\" && cat work/n.txt";

/// (b) and (c) A local command chain: none of it asks at Go hard; at "Check
/// with me often" it does (each card is allowed, so it still finishes).
async fn chain(h: &H, l: Level) -> Check {
    level(l);
    let name = if l == Level::GoHard {
        "Chainer"
    } else {
        "Careful"
    };
    let a = h.agent(
        name,
        "Runs commands",
        "When asked to run a command, run it exactly as written with one Bash call, in your own folder, and reply with only its output.",
    );
    h.send(
        &a.id,
        &format!("I've read the plan and I confirm it: go ahead now. Run: {CHAIN}"),
    )
    .await?;
    let start = std::time::Instant::now();
    // Allow whatever asks (at Often), until the turn is over.
    while runner::in_turn(&a.id) {
        for c in approvals(&a.id)
            .into_iter()
            .filter(|c| c.status == store::ApprovalStatus::Pending)
        {
            let _ = cmd::agents_answer_approval(
                h.app.clone(),
                a.id.clone(),
                c.request_id,
                true,
                None,
                None,
                None,
            )
            .await;
        }
        if start.elapsed() > Duration::from_secs(240) {
            return Err("the turn never finished".into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    h.turn(&a.id).await?;
    let home = store::agent_home(&a.id).unwrap();
    let lines = std::fs::read_to_string(home.join("work/n.txt")).unwrap_or_default();
    ensure(
        lines.starts_with("line 1\nline 2\nline 3") && home.join("work/a.txt").exists(),
        format!(
            "the chain didn't run: n.txt {lines:?}; reply {:?}",
            last_reply(&a.id)
        ),
    )?;
    let cards = approvals(&a.id);
    if l == Level::GoHard {
        ensure(
            cards.is_empty(),
            format!(
                "cards at Go hard: {:?}",
                cards.iter().map(|c| &c.detail).collect::<Vec<_>>()
            ),
        )?;
        // The call the level answered leaves its receipt in "What it did".
        ensure(
            timeline(&a.id).contains("Allowed automatically — Go hard"),
            format!("no receipt step: {}", timeline(&a.id)),
        )?;
    } else {
        ensure(!cards.is_empty(), "no card at Check with me often")?;
    }
    no_errors(&a.id)
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// (d) `git push` is on Go hard's ask list: a card, even to a local remote.
async fn push(h: &H) -> Check {
    level(Level::GoHard);
    let a = h.agent(
        "Pusher",
        "Runs commands",
        "When asked to run a command, run it exactly as written with one Bash call and reply with only its output.",
    );
    let home = store::agent_home(&a.id).unwrap();
    let bare = h.home.join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare", "-q"]);
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "e2e\n").unwrap();
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=e2e",
            "-c",
            "user.email=e2e@example.com",
            "commit",
            "-qm",
            "first",
        ],
    );
    git(&repo, &["remote", "add", "origin", &bare.to_string_lossy()]);
    h.send(&a.id, "Run: cd repo && git push origin main")
        .await?;
    let c = super::card(h, &a.id, 0).await?;
    ensure(
        c.tool.as_deref() == Some("Bash") && c.detail.contains("push"),
        format!("card for {:?}: {:?}", c.tool, c.detail),
    )?;
    cmd::agents_answer_approval(
        h.app.clone(),
        a.id.clone(),
        c.request_id,
        false,
        None,
        Some("Not now. Reply with just: not pushed".into()),
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    // It may try again another way; every try asks, and is denied.
    let start = std::time::Instant::now();
    while runner::in_turn(&a.id) {
        for c in approvals(&a.id)
            .into_iter()
            .filter(|c| c.status == store::ApprovalStatus::Pending)
        {
            let _ = cmd::agents_answer_approval(
                h.app.clone(),
                a.id.clone(),
                c.request_id,
                false,
                None,
                None,
                None,
            )
            .await;
        }
        if start.elapsed() > Duration::from_secs(180) {
            return Err("the turn never finished".into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    h.turn(&a.id).await?;
    let pushed = std::process::Command::new("git")
        .args([
            "--git-dir",
            &bare.to_string_lossy(),
            "rev-parse",
            "--verify",
            "-q",
            "main",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ensure(!pushed, "the push went through without an Allow")?;
    no_errors(&a.id)
}

/// (e) `share_result` with a file: one result card naming it.
async fn result(h: &H) -> Check {
    level(Level::GoHard);
    let a = h.agent("Reporter", "Writes short reports", "");
    h.send(
        &a.id,
        "Write a file named report.md in your own folder containing the single line: E2E report. Then call share_result with title \"E2E report\", a one-line summary, and report.md as its file. Then stop.",
    )
    .await?;
    h.turn(&a.id).await?;
    let cards: Vec<_> = log(&a.id).into_iter().filter_map(|m| m.result).collect();
    ensure(cards.len() == 1, format!("{} result cards", cards.len()))?;
    let card = &cards[0];
    let files: Vec<String> = card
        .items
        .iter()
        .filter_map(|i| match i {
            app_lib::agents::results::ResultItem::File { file, .. } => Some(file.name.clone()),
            _ => None,
        })
        .collect();
    ensure(
        files.iter().any(|p| p.ends_with("report.md")),
        format!("the card's files: {files:?}"),
    )?;
    ensure(card.version == 1, format!("version {}", card.version))?;
    ensure(approvals(&a.id).is_empty(), "a card for writing a file")?;
    no_errors(&a.id)
}

/// (f) The engine dies mid-turn: the turn ends in a line saying so (never
/// silence), and the agent answers the next message.
async fn kill(h: &H) -> Check {
    level(Level::GoHard);
    let a = h.agent("Storyteller", "Writes long things", "");
    h.send(
        &a.id,
        "Write a 500-word story about a lighthouse. No preamble.",
    )
    .await?;
    h.until("a draft", Duration::from_secs(120), || {
        h.drafting(&a.id, 60)
    })
    .await?;
    let pid = procs::pid_of(&a.id).ok_or("no engine process registered")?;
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status();
    h.turn(&a.id).await?;
    let tail: Vec<_> = log(&a.id).into_iter().rev().take(3).collect();
    let said = tail.iter().any(|m| {
        matches!(m.kind, MessageKind::Error | MessageKind::Note)
            || (m.kind == MessageKind::Agent && m.stopped)
    });
    ensure(
        said,
        format!(
            "the killed turn ended silently: {:?}",
            tail.iter()
                .map(|m| (m.kind, m.text.clone()))
                .collect::<Vec<_>>()
        ),
    )?;
    if let Some(e) = tail.iter().find(|m| m.kind == MessageKind::Error) {
        super::human(&e.text)?;
    }
    h.send(&a.id, "Reply with just: back").await?;
    h.turn(&a.id).await?;
    ensure(
        last_reply(&a.id).to_lowercase().contains("back"),
        format!("no reply after the kill: {:?}", last_reply(&a.id)),
    )
}

/// (g) WebSearch at Go hard runs without a card.
async fn search(h: &H) -> Check {
    level(Level::GoHard);
    let a = h.agent("Searcher", "Looks things up", "");
    h.send(
        &a.id,
        "Use the WebSearch tool once to search for: Rust programming language. Reply with the title of one result, in one line.",
    )
    .await?;
    h.turn(&a.id).await?;
    let cards = approvals(&a.id);
    ensure(
        cards.is_empty(),
        format!(
            "cards at Go hard: {:?}",
            cards
                .iter()
                .map(|c| (&c.tool, &c.detail))
                .collect::<Vec<_>>()
        ),
    )?;
    let searched = timeline(&a.id);
    ensure(
        searched.contains("Searched the web")
            && searched.contains("Allowed automatically — Go hard"),
        format!("no search step: reply {:?}", last_reply(&a.id)),
    )?;
    no_errors(&a.id)
}
