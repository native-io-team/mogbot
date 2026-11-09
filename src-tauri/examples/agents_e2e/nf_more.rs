//! More of the features that had only unit tests, live on Haiku (part of
//! `newfeat`; run one with `scripts/agents-e2e.sh nf-slack`):
//!
//! - `nf-turn-end`: a turn that launches a background helper (Claude Code's
//!   Agent tool) and ends its first `result` early stays open until the
//!   helper reports, then the reply arrives, with no "without a reply" line;
//!   and a turn that ends with no text gets the "Finished without a reply" line
//! - `nf-step-in`: an agent in its own browser (a real Chrome on the scratch
//!   HOME's profile, closed at the end) calls `ask_user_to_step_in` on a
//!   local page; the test answers Step in, moves the page as a person would
//!   (to an address carrying a code and a token), then Hand back, through
//!   the UI's own commands. The resume note has only scheme, host and path,
//!   and the agent's next turn reads it
//! - `nf-account-pin`: this Mac's own sign-in plus a fake added account
//!   (a token that works nowhere) marked out until a known reset: an agent
//!   set to the out account stops with the Note and never runs; one on Any
//!   account runs on this Mac's own sign-in
//! - `nf-slack`: a fake Slack Web API served on 127.0.0.1: the owner's
//!   "dashbot: what's 2+2" starts a turn and the reply card carries the
//!   exact words, which Allow posts; another person's message, with others
//!   not let in, starts nothing
//! - `nf-crossover`: every Claude Code account marked out and a fake Codex
//!   account "signed in" (an `auth.json` nothing can use): the turn never
//!   runs, the crossover card appears, and Wait leaves it on its line
//!
//! Every child keeps Keychain items in memory (`keychain::use_memory_for_e2e`),
//! so nothing here reaches the owner's Keychain.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::agents::engine::Engine;
use app_lib::agents::{runner, slack, slack_api, store, wallet};
use app_lib::commands::agents as cmd;
use store::{ApprovalStatus, MessageKind};
use tauri::Listener;

use super::{ensure, of_kind, H};

type Detail = Result<String, String>;

/* ------------------------------------------------------- a tiny server */

/// One request: (method path, form body).
type Handler = dyn Fn(&str, &HashMap<String, String>) -> (&'static str, String) + Send + Sync;

/// A loopback HTTP server, one thread per connection, `Connection: close`.
fn serve(handler: Arc<Handler>) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = handler.clone();
            std::thread::spawn(move || {
                let _ = answer(stream, &*handler);
            });
        }
    });
    port
}

fn answer(stream: std::net::TcpStream, handler: &Handler) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let (kind, text) = handler(&path, &form);
    let mut out = stream;
    write!(
        out,
        "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )?;
    out.flush()
}

/* -------------------------------------------------------------- helpers */

fn notes(id: &str) -> Vec<String> {
    of_kind(id, MessageKind::Note)
        .into_iter()
        .map(|m| m.text)
        .collect()
}

fn replies(id: &str) -> Vec<String> {
    of_kind(id, MessageKind::Agent)
        .into_iter()
        .map(|m| m.text)
        .collect()
}

fn turns(id: &str) -> u64 {
    store::get(id)
        .map(|a| a.usage.all_time.turns as u64)
        .unwrap_or(0)
}

/// Every transcript line under the scratch HOME that holds `needle`.
fn transcript_lines(home: &Path, needle: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![home.join(".claude").join("projects")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(s) = std::fs::read_to_string(&p) {
                out.extend(s.lines().filter(|l| l.contains(needle)).map(String::from));
            }
        }
    }
    out
}

/// The text from `start` to the next `]`, wherever it is in `line`.
fn snippet(line: &str, start: &str) -> Option<String> {
    let at = line.find(start)?;
    let rest = &line[at..];
    let end = rest.find(']').map_or(rest.len(), |i| i + 1);
    Some(rest[..end].to_string())
}

/// Status activities seen for each agent, in order.
fn watch_status(h: &H) -> Arc<Mutex<Vec<(String, String, String)>>> {
    let seen: Arc<Mutex<Vec<(String, String, String)>>> = Default::default();
    let s = seen.clone();
    h.app.listen_any(runner::EVENT_STATUS, move |e| {
        if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
            s.lock().unwrap().push((
                v["agentId"].as_str().unwrap_or("").to_string(),
                v["status"]["state"].as_str().unwrap_or("").to_string(),
                v["status"]["activity"].as_str().unwrap_or("").to_string(),
            ));
        }
    });
    seen
}

/// A Claude Code account added to the wallet with a token that works
/// nowhere, kept in this process's memory Keychain only.
fn fake_claude_account(name: &str) -> Result<wallet::Account, String> {
    let a = wallet::add(Engine::Claude, name).map_err(|e| e.to_string())?;
    let service = format!("{}{}", app_lib::brand::keychain_prefix("account"), a.id);
    app_lib::keychain::write(
        &service,
        "claude_oauth_token",
        "sk-ant-oat01-e2e-fake-token-that-works-nowhere-000000000000",
    )?;
    ensure(
        app_lib::commands::accounts::claude_token_for(&a.id).is_some(),
        "the fake account's token isn't readable",
    )?;
    Ok(a)
}

/* ------------------------------------------------------------ turn end */

/// (a) A background helper keeps the turn open until it reports; (b) a turn
/// with no words ends on "Finished without a reply".
pub async fn turn_end(h: &H) -> Detail {
    // Helpers on Haiku too, whatever the Agent tool picks.
    std::env::set_var("CLAUDE_CODE_SUBAGENT_MODEL", "haiku");
    let seen = watch_status(h);
    let a = h.agent(
        "Dispatch",
        "Hands work to helpers",
        "When the user says exactly `delegate`: call your Agent tool once, with subagent_type \"general-purpose\", model \"haiku\", description \"Say the code\", and prompt \"Reply with exactly HELPER-CODE-7731 and nothing else. Use no tools.\" Don't wait for it and don't read its output file: right after launching it, end your turn with the single line: Helper started. When its result reaches you later, reply with exactly: FINAL <the code it said>. Use no other tools.",
    );
    h.send(&a.id, "delegate").await?;
    h.idle(&[&a.id], Duration::from_secs(3), Duration::from_secs(240))
        .await?;
    let said = replies(&a.id);
    let waited = seen.lock().unwrap().iter().any(|(id, state, act)| {
        id == &a.id && state == "working" && act.contains("to report back")
    });
    let launched = !transcript_lines(&h.home, "Async agent launched").is_empty();
    ensure(
        launched,
        format!("Haiku launched no background helper; it said {said:?}"),
    )?;
    // Claude Code 2.1.319 here sends the first round's `result` only once
    // the helper has reported (observed with `--print`), so the "Waiting for
    // the helper" line shows only when a result does come first; what must
    // hold either way is that the helper's answer lands in the same turn.
    ensure(
        transcript_lines(&h.home, "<task-notification>")
            .iter()
            .any(|l| l.contains("completed")),
        "the helper never reported back",
    )?;
    ensure(
        said.iter().any(|t| t.contains("HELPER-CODE-7731")),
        format!("the helper's answer never reached the chat: {said:?}"),
    )?;
    let n = notes(&a.id);
    ensure(
        !n.iter()
            .any(|t| t.contains("Finished without a reply") || t.contains("stopped with it")),
        format!("a closing line on a turn that answered: {n:?}"),
    )?;
    ensure(turns(&a.id) == 1, format!("{} turns", turns(&a.id)))?;
    super::no_errors(&a.id)?;
    let first = format!(
        "helper reported in the same turn ({} bubble(s), last {:?}; waiting line {})",
        said.len(),
        said.last().unwrap(),
        if waited {
            "shown"
        } else {
            "not needed: no early result"
        }
    );

    // (a2) The observed failure: a helper still out when the turn is
    // stopped; the next turn resumes on Claude Code's queued "your helper
    // was stopped" notification, which it may answer with a `result` of its
    // own before the user's message. The turn must carry on to the reply.
    app_lib::agents::independence::set_level(app_lib::agents::independence::Level::GoHard, 0)
        .map_err(|e| e.to_string())?;
    let s = h.agent(
        "Slowpoke",
        "Hands slow work to helpers",
        "When the user says exactly `slow`: call your Agent tool once, with subagent_type \"general-purpose\", model \"haiku\", description \"Wait a while\", and prompt \"Run this exact Bash command in the foreground and wait for it: perl -e 'sleep 90'. Then reply with exactly SLOW-DONE.\" Right after launching it, end your turn with the single line: Helper started.\nA helper started this way runs that command as asked: it is a deliberate wait.",
    );
    let launches_before = transcript_lines(&h.home, "Async agent launched").len();
    h.send(&s.id, "slow").await?;
    h.until("the slow helper", Duration::from_secs(120), || {
        transcript_lines(&h.home, "Async agent launched").len() > launches_before
    })
    .await?;
    tokio::time::sleep(Duration::from_secs(4)).await;
    runner::stop(&h.app, &s.id);
    h.turn(&s.id).await?;
    let stopped = notes(&s.id);
    let told = stopped
        .iter()
        .any(|t| t.contains("started in the background") && t.contains("stopped too"));
    let mark = seen.lock().unwrap().len();
    h.send(&s.id, "Reply with exactly SECOND-OK.").await?;
    h.idle(&[&s.id], Duration::from_secs(3), Duration::from_secs(180))
        .await?;
    let said = replies(&s.id);
    ensure(
        said.last().is_some_and(|t| t.contains("SECOND-OK")),
        format!("the turn after the stop didn't reach the user's message: {said:?}"),
    )?;
    let n = notes(&s.id);
    ensure(
        !n.iter().any(|t| t.starts_with("Finished without a reply")),
        format!("the resumed turn ended blank: {n:?}"),
    )?;
    let reopened = {
        let seen = seen.lock().unwrap();
        let mine: Vec<&str> = seen[mark..]
            .iter()
            .filter(|(id, _, _)| id == &s.id)
            .map(|(_, st, _)| st.as_str())
            .collect();
        mine.windows(2).any(|w| w[0] == "idle" && w[1] == "working")
    };
    super::no_errors(&s.id)?;
    let second = format!(
        "after a stop: {} the stopped helper; next turn replied {:?} ({})",
        if told { "told" } else { "NOT told about" },
        said.last().unwrap(),
        if reopened {
            "reopened after an early result"
        } else {
            "no early result this time"
        }
    );
    ensure(
        told,
        format!("no line about the stopped helper: {stopped:?}"),
    )?;

    // (b) Nothing said.
    // A model can't be made to say nothing: the app's own prompt asks for a
    // reply, and Haiku gave one on all of four tries (2026-11-09), so the
    // silent half usually reports itself skipped (it is unit-tested,
    // `turn_end_tests`). What it does check every time: a turn that spoke
    // gets no closing line.
    let mut tries = Vec::new();
    let mut silent = None;
    const TRIES: u32 = 1;
    for i in 1..=TRIES {
        let m = h.agent(
            &format!("Mute{i}"),
            "Reads quietly",
            "When the user says exactly `ping`: call your Read tool on ./CLAUDE.md. That is all. When the tool result comes back, stop at once with an empty response: output no characters at all, not before the tool call and not after it. This checks that a silent finish is handled; any text, even one word, spoils it.",
        );
        h.send(&m.id, "ping").await?;
        h.turn(&m.id).await?;
        let said = replies(&m.id);
        if said.is_empty() {
            silent = Some(m);
            break;
        }
        // It spoke: no closing line may be added to a turn that answered.
        let n = notes(&m.id);
        ensure(
            !n.iter().any(|t| t.starts_with("Finished without a reply")),
            format!("a closing line on a turn that spoke: {n:?}"),
        )?;
        tries.push(said.join(" / "));
    }
    let Some(m) = silent else {
        return Ok(format!(
            "{first}; {second}; silent half SKIPPED (Haiku spoke: {tries:?}; no closing line added)"
        ));
    };
    let n = notes(&m.id);
    let line = n
        .iter()
        .find(|t| t.starts_with("Finished without a reply"))
        .cloned()
        .ok_or_else(|| format!("no closing line; notes: {n:?}"))?;
    ensure(
        n.iter()
            .filter(|t| t.starts_with("Finished without a reply"))
            .count()
            == 1,
        format!("the line twice: {n:?}"),
    )?;
    super::no_errors(&m.id)?;
    Ok(format!("{first}; {second}; silent: {line:?}"))
}

/* ------------------------------------------------------------- step in */

const CODE: &str = "482913";
const FRAGMENT: &str = "tok-e2e-frag";

/// An agent asks the user to step into its browser; Step in, the page moves,
/// Hand back; the resume note says only where, and the agent reads it.
pub async fn step_in(h: &H) -> Detail {
    if app_lib::agent_browser::chrome::find_chrome().is_none() {
        return Ok("SKIPPED: Google Chrome isn't installed".into());
    }
    let port = serve(Arc::new(|path: &str, _: &HashMap<String, String>| {
        let body = if path.starts_with("/verify") {
            "<!doctype html><title>Verify it's you</title><h1>Verify it's you</h1><p>A person must approve this sign-in with their passkey. This step can't be done by software.</p>"
        } else {
            "<!doctype html><title>Signed in</title><h1>You're signed in</h1>"
        };
        ("text/html; charset=utf-8", body.to_string())
    }));
    let start = format!("http://127.0.0.1:{port}/verify");
    let a = h.agent(
        "Opener",
        "Works in its browser",
        "When the user gives you an address: open it in your browser with your browser tools, read it, and if it needs a person to verify (a passkey, a code, \"verify it's you\"), call ask_user_to_step_in with reason \"approve the sign-in\", then stop with one short line. When you're woken after the user handed the browser back, use no tools: reply with exactly BACK AT followed by the address you were told the page is at now.",
    );
    let result = step_in_inner(h, &a, port, &start).await;
    // The scratch profile's Chrome closes whatever happened.
    tokio::task::spawn_blocking(app_lib::agent_browser::service::shutdown)
        .await
        .ok();
    result
}

async fn step_in_inner(h: &H, a: &store::Agent, port: u16, start: &str) -> Detail {
    h.send(&a.id, &format!("Open {start} and do what it needs."))
        .await?;
    h.until("the step-in card", Duration::from_secs(150), || {
        store::pending_approvals(&a.id)
            .unwrap_or_default()
            .iter()
            .any(|c| c.step_in.is_some())
    })
    .await
    .map_err(|e| format!("{e}; it said {:?}", replies(&a.id)))?;
    h.turn(&a.id).await?;
    let card = store::pending_approvals(&a.id)
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.step_in.is_some())
        .ok_or("the card went")?;
    let s = card.step_in.clone().unwrap();
    ensure(
        s.url.starts_with(start) && s.site == "127.0.0.1",
        format!("the card is for {:?} on {:?}", s.url, s.site),
    )?;

    // Step in, as the desk's button does.
    cmd::agents_step_in(h.app.clone(), a.id.clone(), card.request_id.clone())
        .await
        .map_err(|e| format!("Step in: {e}"))?;
    ensure(
        app_lib::agent_browser::step_in::held(&a.id).is_some(),
        "the tab isn't held after Step in",
    )?;
    // What the person does there: the page moves on, its address carrying a
    // one-time code and a token.
    let done = format!("http://127.0.0.1:{port}/done?code={CODE}#{FRAGMENT}");
    let (agent, tab_id, to) = (a.id.clone(), s.tab, done.clone());
    tokio::task::spawn_blocking(move || {
        let svc = app_lib::agent_browser::service::running().ok_or("Chrome went")?;
        let tab = svc.tab_for(&agent, Some(tab_id))?;
        svc.navigate(&tab, &to)?;
        svc.settle(&tab, Duration::from_secs(5));
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    let turns_before = turns(&a.id);
    cmd::agents_step_in_hand_back(h.app.clone(), a.id.clone(), card.request_id.clone())
        .await
        .map_err(|e| format!("Hand back: {e}"))?;
    h.until("the woken turn", Duration::from_secs(30), || {
        runner::in_turn(&a.id) || turns(&a.id) > turns_before
    })
    .await?;
    h.turn(&a.id).await?;

    let closed = store::find_approval(&a.id, &card.request_id)
        .map_err(|e| e.to_string())?
        .ok_or("the card is gone")?;
    ensure(
        closed.status == ApprovalStatus::Allowed,
        format!("the card is {:?}", closed.status),
    )?;
    let n = notes(&a.id);
    ensure(
        n.iter()
            .any(|t| t.starts_with("You handed Opener its browser back")),
        format!("no hand-back line: {n:?}"),
    )?;
    let head = "[The user stepped into your browser";
    let lines = transcript_lines(&h.home, head);
    let note = lines
        .iter()
        .find_map(|l| snippet(l, head))
        .ok_or("the resume note never reached the agent's turn")?;
    let path_only = format!("http://127.0.0.1:{port}/done");
    ensure(
        note.contains(&format!("Now: {path_only}.")),
        format!("the note doesn't say where the page is: {note}"),
    )?;
    ensure(
        !note.contains(CODE)
            && !note.contains(FRAGMENT)
            && !note.contains('?')
            && !note.contains("Signed in"),
        format!("the note carries more than scheme, host and path: {note}"),
    )?;
    // Nowhere in what the agent was given (its own reading aside, it was told to use no tools).
    ensure(
        transcript_lines(&h.home, CODE)
            .iter()
            .all(|l| !l.contains(head)),
        "the code reached the note",
    )?;
    // What it wrote (the chat shows a loopback address as "the preview
    // below", `local_links`).
    let said = replies(&a.id);
    let wrote = transcript_lines(&h.home, "BACK AT");
    ensure(
        said.last().is_some_and(|t| t.starts_with("BACK AT"))
            && wrote
                .iter()
                .any(|l| l.contains(&format!("BACK AT {path_only}"))),
        format!("the next turn didn't read the note: {said:?}"),
    )?;
    super::no_errors(&a.id)?;
    Ok(format!("note: {note}; reply: {:?}", said.last().unwrap()))
}

/* --------------------------------------------------------- account pin */

/// Set to an account that's out: the Note, no turn. Any account: This Mac.
pub async fn account_pin(h: &H) -> Detail {
    let spare = fake_claude_account("Spare")?;
    let now = store::now_ms();
    wallet::mark_out(Engine::Claude, &spare.id, Some(now + 2 * 3_600_000), now);
    let pinned = h.agent(
        "Pinned",
        "Runs on one account",
        "Keep every reply to one short line. Don't use tools.",
    );
    store::update(&pinned.id, |a| a.account = Some(spare.id.clone())).map_err(|e| e.to_string())?;
    let free = h.agent(
        "Free",
        "Runs on any account",
        "Keep every reply to one short line. Don't use tools.",
    );

    h.send(&pinned.id, "Reply with exactly PIN-OK.").await?;
    h.turn(&pinned.id).await?;
    let n = notes(&pinned.id);
    ensure(
        n.iter().any(|t| {
            t.starts_with("Pinned runs only on Spare, which is out of usage")
                && t.contains("Any account")
        }),
        format!("no Note on how to let it use another account: {n:?}"),
    )?;
    let errors = of_kind(&pinned.id, MessageKind::Error);
    ensure(
        errors.len() == 1,
        format!(
            "error lines: {:?}",
            errors.iter().map(|m| &m.text).collect::<Vec<_>>()
        ),
    )?;
    let e = &errors[0];
    ensure(
        e.text
            .starts_with("Spare has reached its usage limit. It's back")
            && e.failure.as_ref().is_some_and(|f| {
                f.kind == app_lib::agents::failure::FailureKind::UsageLimit && f.resets_at.is_some()
            }),
        format!(
            "the line isn't the usage limit with its reset: {:?} {:?}",
            e.text, e.failure
        ),
    )?;
    ensure(
        replies(&pinned.id).is_empty() && turns(&pinned.id) == 0,
        format!("a turn ran on the out account: {:?}", replies(&pinned.id)),
    )?;
    ensure(
        store::get(&pinned.id).unwrap().away.is_none()
            && store::pending_approvals(&pinned.id)
                .unwrap_or_default()
                .is_empty(),
        "a pinned agent was offered the other engine",
    )?;

    h.send(&free.id, "Reply with exactly FREE-OK.").await?;
    h.turn(&free.id).await?;
    let said = replies(&free.id);
    ensure(
        said.iter().any(|t| t.contains("FREE-OK")),
        format!("the free agent said {said:?}"),
    )?;
    let on = wallet::last_on(&free.id, Engine::Claude).ok_or("no account recorded")?;
    ensure(
        on.is_this_mac(),
        format!("it ran on {} ({})", on.name, on.id),
    )?;
    let n = notes(&free.id);
    ensure(
        !n.iter().any(|t| t.starts_with("Switched")),
        format!("it switched: {n:?}"),
    )?;
    super::no_errors(&free.id)?;
    Ok(format!("pinned: {:?}; free ran on this Mac", e.text))
}

/* ---------------------------------------------------------------- slack */

const ME: &str = "U0ROBIN";
const SAM: &str = "U0SAM";
const SELF_DM: &str = "D0SELF";
const LAUNCH: &str = "C0LAUNCH";

#[derive(Default)]
struct FakeSlack {
    history: HashMap<String, Vec<Value>>,
    posted: Vec<HashMap<String, String>>,
    calls: Vec<String>,
}

/// A message from the owner starts a turn and its reply goes on a card with
/// the exact words; someone else's starts nothing.
pub async fn slack_scenario(h: &H) -> Detail {
    let state: Arc<Mutex<FakeSlack>> = Default::default();
    let s = state.clone();
    let port = serve(Arc::new(
        move |path: &str, form: &HashMap<String, String>| {
            let method = path.trim_start_matches("/api/").to_string();
            let mut st = s.lock().unwrap();
            st.calls.push(method.clone());
            let channel = form.get("channel").cloned().unwrap_or_default();
            let v = match method.as_str() {
                "auth.test" => {
                    json!({"ok": true, "user_id": ME, "user": "robin", "team_id": "T0NW", "team": "Northwind"})
                }
                "conversations.history" => {
                    let mut all = st.history.get(&channel).cloned().unwrap_or_default();
                    all.reverse();
                    json!({"ok": true, "messages": all})
                }
                "conversations.replies" => json!({"ok": true, "messages": []}),
                "users.info" => {
                    let name = if form.get("user").map(String::as_str) == Some(SAM) {
                        "Sam"
                    } else {
                        "Robin"
                    };
                    json!({"ok": true, "user": {"name": name.to_lowercase(), "profile": {"display_name": name}}})
                }
                "chat.postMessage" => {
                    st.posted.push(form.clone());
                    json!({"ok": true, "ts": "1999999999.000100"})
                }
                _ => json!({"ok": false, "error": "unknown_method"}),
            };
            ("application/json", v.to_string())
        },
    ));
    slack_api::use_fake_for_e2e(&format!("http://127.0.0.1:{port}/api/"))?;
    app_lib::keychain::write(
        &app_lib::brand::scoped("slack"),
        "user-token",
        "xoxp-e2e-fake-token-0000000000000000",
    )?;
    let a = h.agent(
        "Slacker",
        "Answers from Slack",
        "Answer in one short line, with no tools.",
    );
    slack::change(|s| {
        s.account = Some(slack::Account {
            user_id: ME.into(),
            user: "robin".into(),
            team_id: "T0NW".into(),
            team: "Northwind".into(),
            connected_at: store::now_ms(),
        });
        s.enabled = true;
        s.agent_id = Some(a.id.clone());
        s.conversations = vec![
            slack::Conversation {
                id: SELF_DM.into(),
                kind: "self".into(),
                name: "Your own DM".into(),
            },
            slack::Conversation {
                id: LAUNCH.into(),
                kind: "channel".into(),
                name: "#launch".into(),
            },
        ];
    })
    .map_err(|e| e.to_string())?;
    // The baseline: nothing yet, so nothing already there ever counts.
    slack::pass(&h.app, true).await;
    ensure(
        slack::load().cursors.len() == 2,
        format!("no baseline: {:?}", state.lock().unwrap().calls),
    )?;
    let trigger = slack::default_trigger();
    let t_own = slack::now_ts(store::now_ms() + 2_000);
    let t_sam = slack::now_ts(store::now_ms() + 3_000);
    {
        let mut st = state.lock().unwrap();
        st.history.entry(SELF_DM.into()).or_default().push(
            json!({"type": "message", "ts": t_own, "user": ME, "text": format!("{trigger} what's 2+2")}),
        );
        st.history.entry(LAUNCH.into()).or_default().push(
            json!({"type": "message", "ts": t_sam, "user": SAM, "text": format!("<@{ME}> {trigger} what's 3+3")}),
        );
    }
    tokio::time::sleep(Duration::from_secs(4)).await;
    slack::pass(&h.app, true).await;
    let users = of_kind(&a.id, MessageKind::User);
    ensure(
        users.len() == 1
            && users[0].text == "what's 2+2"
            && users[0].via.as_ref().is_some_and(|v| v.source == "slack"),
        format!(
            "the chat lines from Slack: {:?}",
            users.iter().map(|m| &m.text).collect::<Vec<_>>()
        ),
    )?;
    h.until("the Slack turn", Duration::from_secs(30), || {
        runner::in_turn(&a.id) || turns(&a.id) > 0
    })
    .await?;
    h.turn(&a.id).await?;
    let reply = replies(&a.id)
        .last()
        .cloned()
        .ok_or("the agent didn't reply")?;
    // The loop's next passes put it on a card.
    let mut card = None;
    for _ in 0..20 {
        slack::pass(&h.app, false).await;
        card = store::pending_approvals(&a.id)
            .unwrap_or_default()
            .into_iter()
            .find(|c| c.slack_reply.is_some());
        if card.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let card = card.ok_or_else(|| format!("no reply card; notes {:?}", notes(&a.id)))?;
    let r = card.slack_reply.clone().unwrap();
    ensure(
        r.text == reply.trim() && card.detail == r.text,
        format!("the card's words {:?} aren't the reply {:?}", r.text, reply),
    )?;
    ensure(
        r.text.contains('4'),
        format!("2+2 came back as {:?}", r.text),
    )?;
    ensure(
        r.channel == SELF_DM && r.thread_ts == t_own,
        format!("the card would post to {} / {}", r.channel, r.thread_ts),
    )?;
    ensure(
        state.lock().unwrap().posted.is_empty(),
        "posted before the card was answered",
    )?;
    cmd::agents_answer_approval(
        h.app.clone(),
        a.id.clone(),
        card.request_id.clone(),
        true,
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("Allow: {e}"))?;
    h.until("the post", Duration::from_secs(20), || {
        !state.lock().unwrap().posted.is_empty()
    })
    .await?;
    let post = state.lock().unwrap().posted[0].clone();
    ensure(
        post.get("text") == Some(&r.text)
            && post.get("channel").map(String::as_str) == Some(SELF_DM)
            && post.get("thread_ts") == Some(&t_own),
        format!("posted {post:?}"),
    )?;
    // Sam's ask: nothing started, no line, nothing waiting.
    for _ in 0..2 {
        slack::pass(&h.app, true).await;
    }
    let n = notes(&a.id);
    ensure(
        !n.iter().any(|t| t.contains("asked in Slack")) && turns(&a.id) == 1,
        format!("someone else's message started something: {n:?}"),
    )?;
    ensure(
        slack::load().pending.is_empty(),
        format!("still waiting: {:?}", slack::load().pending),
    )?;
    ensure(
        state.lock().unwrap().posted.len() == 1,
        "posted more than once",
    )?;
    super::no_errors(&a.id)?;
    Ok(format!("card and post: {:?}", r.text))
}

/* ------------------------------------------------------------ crossover */

/// Every Claude Code account out, Codex "has room": the card; Wait leaves
/// the turn on its line and nothing runs.
pub async fn crossover(h: &H) -> Detail {
    if app_lib::agents::engine::binary(Engine::Codex)
        .await
        .is_none()
    {
        return Ok("SKIPPED: no codex binary on this Mac".into());
    }
    let spare = fake_claude_account("Spare")?;
    let now = store::now_ms();
    let back = now + 3 * 3_600_000;
    wallet::mark_out(Engine::Claude, wallet::THIS_MAC, Some(back), now);
    wallet::mark_out(Engine::Claude, &spare.id, Some(back + 60_000), now);
    // A Codex account "signed in" by a file nothing can use: the decision
    // reads only that it's there. Nothing runs on it.
    let codex = wallet::add(Engine::Codex, "Codex spare").map_err(|e| e.to_string())?;
    let dir = app_lib::commands::accounts::codex_home_dir(&codex.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("auth.json"), "{}").map_err(|e| e.to_string())?;
    let a = h.agent(
        "Relay",
        "Keeps going",
        "Keep every reply to one short line. Don't use tools.",
    );
    h.send(&a.id, "Reply with exactly RELAY-OK.").await?;
    h.until("the crossover card", Duration::from_secs(60), || {
        store::pending_approvals(&a.id)
            .unwrap_or_default()
            .iter()
            .any(|c| c.crossover.is_some())
    })
    .await
    .map_err(|e| {
        format!(
            "{e}; errors {:?}, notes {:?}",
            of_kind(&a.id, MessageKind::Error)
                .iter()
                .map(|m| &m.text)
                .collect::<Vec<_>>(),
            notes(&a.id)
        )
    })?;
    h.turn(&a.id).await?;
    let card = store::pending_approvals(&a.id)
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.crossover.is_some())
        .unwrap();
    let ask = card.crossover.clone().unwrap();
    ensure(
        ask.from == Engine::Claude && ask.to == Engine::Codex && ask.resume,
        format!("the card asks {ask:?}"),
    )?;
    ensure(
        card.title.contains("Carry on with Codex"),
        format!("title {:?}", card.title),
    )?;
    let errors: Vec<String> = of_kind(&a.id, MessageKind::Error)
        .into_iter()
        .map(|m| m.text)
        .collect();
    ensure(
        errors.len() == 1
            && errors[0].starts_with("Both Claude Code accounts have reached their usage limit"),
        format!("the turn's line: {errors:?}"),
    )?;
    ensure(turns(&a.id) == 0, "a turn ran on an out account")?;

    // Wait.
    cmd::agents_answer_approval(
        h.app.clone(),
        a.id.clone(),
        card.request_id.clone(),
        false,
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("Wait: {e}"))?;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let closed = store::find_approval(&a.id, &card.request_id)
        .map_err(|e| e.to_string())?
        .ok_or("the card is gone")?;
    ensure(
        closed.status == ApprovalStatus::Denied,
        format!("the card is {:?}", closed.status),
    )?;
    let agent = store::get(&a.id).map_err(|e| e.to_string())?;
    ensure(
        agent.away.is_none() && !runner::in_turn(&a.id) && turns(&a.id) == 0,
        "Wait carried on anyway",
    )?;
    let n = notes(&a.id);
    ensure(
        !n.iter().any(|t| t.contains("Carried on with Codex")),
        format!("carried on: {n:?}"),
    )?;
    ensure(
        app_lib::agents::crossover::mode(Engine::Claude) != app_lib::agents::crossover::Mode::Carry
            && !app_lib::agents::crossover::once(Engine::Claude, store::now_ms()),
        "Wait set carrying on",
    )?;
    ensure(
        of_kind(&a.id, MessageKind::Error).len() == 1,
        "Wait added another line",
    )?;
    Ok(format!("card: {:?}; Wait kept it on its line", card.title))
}
