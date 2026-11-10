//! Routines in steps, with the user's OK in the middle.
//!
//! "Every Friday at 4pm: draft the weekly report, wait for my OK, then post
//! it to #team." A time routine's `note` is its first step; `then` holds the
//! steps after it, each run in its own turn once the one before it finished
//! without an error. A step marked `ask_first` waits for the user: when the
//! step before it ends, one card goes in the agent's chat, "OK to go on?",
//! showing what that step produced (the agent's last reply) and what comes
//! next, word for word. **Go ahead** runs the next step; **Stop here** ends
//! the run there, recorded in its past runs.
//!
//! The rules it keeps:
//! - **The card is the user's.** It carries no tool call, so no independence
//!   level, rule, admin or plan answers it (`admin::classify_in`,
//!   `mcp::sweepable`), and it doesn't expire after ten minutes: nobody is
//!   waiting on a live turn. It closes only when answered, or when the
//!   routine's next run starts first ("the routine ran again"), so a weekly
//!   report can wait the weekend for its OK.
//! - **One yes, exactly as wide as the card.** Go ahead is the user's yes to
//!   what the card showed, kept the way a typed yes to a listed plan is
//!   (`plan_grant::note_chat_yes`): the next step lists its outward actions
//!   with `ask_plan`, and a plan whose every target and exact text the card
//!   named needs no second card. Anything else still asks, and the floor
//!   (money, credentials, deleting, force pushes…) is never covered.
//! - **No retries past step one.** A temporary failure of the first step is
//!   tried again as any routine's run is (`runs`); a later step that fails
//!   says so once and the run ends, because re-running "post it" on its own
//!   is how a post goes out twice.
//! - **Time routines only.** A "When…" routine carries text from outside;
//!   steps on one would make that text's run longer, not safer.
//! - Its state survives a restart: the open card is in the chat log and
//!   `waiting` on the routine, so Go ahead after a relaunch still works.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::runner;
use super::runs;
use super::schedule::CheckIn;
use super::store::{self, AgentMessage, Approval, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/// Steps after the first. Five in all is a routine; more is a project.
pub const MAX_THEN: usize = 4;
/// One step's words, as a routine's note.
pub const MAX_STEP_CHARS: usize = 600;
/// What the card shows of the step before: the agent's last reply.
pub const MAX_DRAFT_CHARS: usize = 4000;

/// A step after a routine's first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// What to do, written like a routine's note.
    pub text: String,
    /// Wait for the user's OK (a card) before running it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ask_first: bool,
}

/// A run waiting on the user's OK: on the routine, beside its card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    /// The run's row in the routine's history (`runs::Run::at`).
    pub run_at: i64,
    /// The step it waits to run, counting the first as 1.
    pub step: usize,
    /// The card's `request_id`.
    pub request_id: String,
    pub asked_at: i64,
}

/// On an [`Approval`]: "OK to go on?" between two steps of a routine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub check_in_id: String,
    /// The routine, in a few words (its first line).
    pub routine: String,
    /// The step that just ended, counting from 1.
    pub done: usize,
    pub total: usize,
    /// The next step's words, exactly.
    pub next: String,
    pub run_at: i64,
}

/* --------------------------------------------------------------- shape */

/// Steps as typed: trimmed, empty ones dropped, checked. The error is
/// written for whoever typed them.
pub fn check(then: &[Step]) -> Result<Vec<Step>, String> {
    let steps: Vec<Step> = then
        .iter()
        .map(|s| Step {
            text: s.text.trim().to_string(),
            ask_first: s.ask_first,
        })
        .filter(|s| !s.text.is_empty())
        .collect();
    if steps.len() > MAX_THEN {
        return Err(format!(
            "A routine has at most {} steps. Make the rest a routine of its own.",
            MAX_THEN + 1
        ));
    }
    for s in &steps {
        if s.text.chars().count() > MAX_STEP_CHARS {
            return Err(format!("Keep each step under {MAX_STEP_CHARS} characters."));
        }
        if s.text.chars().any(|c| c.is_control() && c != '\n') {
            return Err("A step can't contain control characters.".into());
        }
    }
    Ok(steps)
}

/// The words of step `n` (from 1): the note, or one of `then`.
pub fn step_text(c: &CheckIn, n: usize) -> Option<&str> {
    match n {
        0 => None,
        1 => Some(c.note.as_str()),
        n => c.then.get(n - 2).map(|s| s.text.as_str()),
    }
}

pub fn total(c: &CheckIn) -> usize {
    1 + c.then.len()
}

/// What happens after step `done` ended well.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// That was the last step.
    Done,
    /// Run step `n` now.
    Run(usize),
    /// Ask the user before step `n`.
    Ask(usize),
}

pub fn next(c: &CheckIn, done: usize) -> Next {
    let n = done + 1;
    match c.then.get(n.wrapping_sub(2)) {
        _ if n < 2 => Next::Done,
        None => Next::Done,
        Some(s) if s.ask_first => Next::Ask(n),
        Some(_) => Next::Run(n),
    }
}

/// "Weekly report", from a note's first line.
pub fn routine_name(note: &str) -> String {
    let first = note.lines().next().unwrap_or("").trim();
    let mut name: String = first.chars().take(48).collect();
    if name.chars().count() < note.trim().chars().count() {
        name = name.trim_end().to_string() + "…";
    }
    name
}

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars()
        .take(max - 1)
        .collect::<String>()
        .trim_end()
        .to_string()
        + "…"
}

/* -------------------------------------------------------------- prompts */

/// Added to the first step's wake when there are more: do only this one.
pub fn first_step_context(c: &CheckIn) -> String {
    if c.then.is_empty() {
        return String::new();
    }
    let n = total(c);
    let second = &c.then[0];
    let waits = if second.ask_first {
        ", and it waits for the user's OK, which the app asks them for when you finish"
    } else {
        ", which the app starts as soon as you finish"
    };
    format!(
        "\n\n[This routine has {n} steps. This run is step 1 of {n}: the note above. Do only step 1 now. Step 2 is “{}”{waits}: don't do step 2 or anything after it in this turn. End with what step 1 produced, in full, ready for the user to check (a draft goes in your reply, not only in a file).]",
        second.text
    )
}

/// The wake for step `n` (2 and on).
pub fn step_prompt(c: &CheckIn, n: usize, approved: bool, now_text: &str) -> String {
    let total = total(c);
    let text = step_text(c, n).unwrap_or("");
    let how = if approved {
        format!("which the user OK'd just now after step {}", n - 1)
    } else {
        format!("which follows step {}", n - 1)
    };
    let after = match next(c, n) {
        Next::Done => String::new(),
        Next::Run(m) | Next::Ask(m) => format!(
            " Do only this step; step {m} (“{}”) comes after it.",
            step_text(c, m).unwrap_or("")
        ),
    };
    let grant = if approved {
        " For anything outward this step does under the user's name (posting, sending, publishing), list it once with ask_plan: their OK covered exactly what their card showed (this step's words and what step 1 produced), so a plan naming those same places and words needs no second card. Anything else still asks."
    } else {
        ""
    };
    format!(
        "[Routine “{}”, step {n} of {total}, {how}: {text}]\n\n[It's now {now_text}. What the earlier steps produced is in this conversation, just above.{after}{grant} Then tell the user in a few lines what you did.]",
        routine_name(&c.note)
    )
}

/* ----------------------------------------------------------------- card */

/// "OK to go on?" after step `done`, showing what it produced.
pub fn card(c: &CheckIn, done: usize, produced: &str, run_at: i64) -> Approval {
    let total = total(c);
    let next_step = done + 1;
    let next_text = step_text(c, next_step).unwrap_or("").to_string();
    let produced = cut(produced, MAX_DRAFT_CHARS);
    let detail = if produced.is_empty() {
        format!("Step {done} left no reply to show.")
    } else {
        produced
    };
    let mut approval = super::mcp::new_card(store::new_id(), "OK to go on?".into(), detail, None);
    approval.summary = Some(format!(
        "“{}” · step {done} of {total} is done. Next, step {next_step}: {next_text}",
        routine_name(&c.note)
    ));
    approval.gate = Some(Gate {
        check_in_id: c.id.clone(),
        routine: routine_name(&c.note),
        done,
        total,
        next: next_text,
        run_at,
    });
    // Go ahead runs the routine's next step, which asks for itself.
    approval.risk = Some(store::Risk::Low);
    approval
}

/// What Go ahead says yes to, kept like a typed yes (`plan_grant`).
pub fn approved_text(a: &Approval) -> String {
    format!("{}\n\n{}", a.summary.as_deref().unwrap_or(""), a.detail)
}

/// The agent's newest reply since `since`: what the step produced.
pub fn produced(log: &[AgentMessage], since: i64) -> String {
    log.iter()
        .rev()
        .take_while(|m| m.ts >= since)
        .find(|m| m.kind == MessageKind::Agent && !m.text.trim().is_empty())
        .map(|m| m.text.clone())
        .unwrap_or_default()
}

/* ------------------------------------------------------------ running */

/// Step `n`'s ticket and wake, recorded on the run's row.
fn run_step(
    app: &AppHandle,
    agent_id: &str,
    c: &CheckIn,
    n: usize,
    run_at: i64,
    approved: bool,
) -> Result<(), CommandError> {
    let now = store::now_ms();
    let prompt = step_prompt(
        c,
        n,
        approved,
        &super::schedule::format_time(&chrono::Local, now),
    );
    store::update(agent_id, |a| {
        if let Some(x) = a.check_ins.iter_mut().find(|x| x.id == c.id) {
            x.waiting = None;
            runs::record(
                &mut x.runs,
                runs::Run {
                    at: run_at,
                    outcome: runs::Outcome::Running,
                    attempt: 1,
                    detail: None,
                    retry_at: None,
                    sign_in: Vec::new(),
                    manual: false,
                    step: n as u32,
                },
            );
        }
    })?;
    let ticket = store::new_id();
    runs::issue(runs::Ticket {
        id: ticket.clone(),
        agent_id: agent_id.to_string(),
        prompt: prompt.clone(),
        check_ins: vec![c.clone()],
        fired_at: now,
        attempt: 1,
        first_failed_at: None,
        due_at: now,
        manual: false,
        step: n,
        row_at: run_at,
    });
    let mut line = runner::new_message(
        agent_id,
        MessageKind::Note,
        format!(
            "Step {n} of {} · {}",
            total(c),
            cut(step_text(c, n).unwrap_or(""), 80)
        ),
    );
    if approved {
        runner::approve_ticket(&ticket);
    }
    let conversation = super::conversations::routine_in(agent_id, &c.id);
    line.conversation = Some(conversation.clone());
    runner::enqueue_scheduled_in(
        app,
        agent_id,
        prompt,
        c.repeat.is_some(),
        ticket,
        Some(conversation),
    );
    runner::record(app, line).map(|_| ())
}

/// Step `done` of a run ended without an error: run the next, ask about it,
/// or (`None`) the run is over. Returns the outcome its history row takes.
pub fn after_step(
    app: &AppHandle,
    agent_id: &str,
    c: &CheckIn,
    done: usize,
    run_at: i64,
    since: i64,
) -> Option<runs::Outcome> {
    match next(c, done) {
        Next::Done => None,
        Next::Run(n) => match run_step(app, agent_id, c, n, run_at, false) {
            Ok(()) => Some(runs::Outcome::Running),
            Err(e) => {
                tracing::warn!(error = %e, "couldn't start a routine's next step");
                None
            }
        },
        Next::Ask(_) => {
            let log = store::messages(agent_id, 40).unwrap_or_default();
            let approval = card(c, done, &produced(&log, since), run_at);
            let request_id = approval.request_id.clone();
            let mut message = runner::new_message(agent_id, MessageKind::Approval, "");
            message.approval = Some(approval);
            if let Err(e) = runner::record_own(app, message) {
                tracing::warn!(error = %e, "couldn't post a routine's OK card");
                return None;
            }
            let now = store::now_ms();
            let _ = store::update(agent_id, |a| {
                if let Some(x) = a.check_ins.iter_mut().find(|x| x.id == c.id) {
                    x.waiting = Some(Waiting {
                        run_at,
                        step: done + 1,
                        request_id: request_id.clone(),
                        asked_at: now,
                    });
                }
            });
            store::refresh_pending(agent_id);
            super::notify::refresh_badge(app);
            Some(runs::Outcome::Waiting)
        }
    }
}

/// The routine fires again with a card still open: that card closes, and
/// its run is recorded as never answered. Only if it is still waiting: a Go
/// ahead that took the run first ([`settle`]) keeps it.
pub fn superseded(app: &AppHandle, agent_id: &str, check_in_id: &str) {
    let Some(w) = close_waiting(agent_id, check_in_id) else {
        return;
    };
    if let Ok(Some(m)) = store::set_aside(
        agent_id,
        &w.request_id,
        "The routine ran again before you answered, so this one closed.",
    ) {
        use tauri::Emitter;
        let _ = app.emit(runner::EVENT_MESSAGE, &m);
    }
    store::refresh_pending(agent_id);
}

/// Takes the run waiting on `check_in_id` for its next run, under the
/// registry lock: its row ends as never answered and nothing is waiting any
/// more. `None` when nothing was (a Go ahead took it first).
pub fn close_waiting(agent_id: &str, check_in_id: &str) -> Option<Waiting> {
    let mut taken = None;
    store::update(agent_id, |a| {
        if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == check_in_id) {
            if let Some(w) = c.waiting.take() {
                end_row(c, w.run_at, w.step - 1, "Not answered before its next run.");
                taken = Some(w);
            }
        }
    })
    .ok()?;
    taken
}

/// Answers a gate card against the routine as it is now, and takes the
/// waiting run in the same step, under the registry lock: of a Go ahead and
/// the routine's next run ([`close_waiting`]), exactly one gets it, so a
/// stale card never starts a step alongside the new run. Stop here ends the
/// row too.
pub fn settle(agent_id: &str, a: &Approval, allow: bool) -> Result<Answer, CommandError> {
    let mut decided = Err(CommandError::expected("That routine has moved on."));
    store::update(agent_id, |agent| {
        decided = decide(agent, a, allow);
        let Ok(answer) = &decided else {
            return;
        };
        let id = a
            .gate
            .as_ref()
            .map(|g| g.check_in_id.as_str())
            .unwrap_or("");
        if let Some(c) = agent.check_ins.iter_mut().find(|c| c.id == id) {
            c.waiting = None;
            if let Answer::Stop(_, run_at, done) = answer {
                end_row(
                    c,
                    *run_at,
                    *done,
                    &format!("You stopped it after step {done}."),
                );
            }
        }
    })?;
    decided
}

/// Its row ends at step `done`, declined with `why`.
fn end_row(c: &mut CheckIn, run_at: i64, done: usize, why: &str) {
    let row = runs::Run {
        at: run_at,
        outcome: runs::Outcome::Declined,
        attempt: 1,
        detail: Some(why.to_string()),
        retry_at: None,
        sign_in: Vec::new(),
        manual: false,
        step: done as u32,
    };
    runs::record(&mut c.runs, row);
}

/// What answering a gate card decides, before anything runs. Pure apart
/// from reading the routine.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// Run step `n` of this routine (as it is now).
    Go(Box<CheckIn>, usize, i64),
    /// Stop: record it.
    Stop(String, i64, usize),
}

/// Check a gate card against the routine it belongs to.
pub fn decide(agent: &store::Agent, a: &Approval, allow: bool) -> Result<Answer, CommandError> {
    let Some(g) = &a.gate else {
        return Err(CommandError::expected("That isn't a routine's card."));
    };
    let c = agent
        .check_ins
        .iter()
        .find(|c| c.id == g.check_in_id)
        .ok_or_else(|| CommandError::expected("That routine no longer exists."))?;
    let waiting = c
        .waiting
        .as_ref()
        .filter(|w| w.request_id == a.request_id)
        .ok_or_else(|| CommandError::expected("That routine has moved on."))?;
    if !allow {
        return Ok(Answer::Stop(c.id.clone(), waiting.run_at, g.done));
    }
    // Its steps were edited while it waited: run what the card showed or nothing.
    if step_text(c, waiting.step) != Some(g.next.as_str()) {
        return Err(CommandError::expected(
            "That routine's steps changed since this card was posted. Run it again to use the new ones.",
        ));
    }
    Ok(Answer::Go(
        Box::new(c.clone()),
        waiting.step,
        waiting.run_at,
    ))
}

/// Go ahead or Stop here, from the desk, the phone or Catch up.
pub fn answer_card(
    app: &AppHandle,
    agent_id: &str,
    a: &Approval,
    allow: bool,
) -> Result<(), CommandError> {
    use tauri::Emitter;
    let (status, word) = if allow {
        (ApprovalStatus::Allowed, "Going ahead")
    } else {
        (ApprovalStatus::Denied, "Stopped here")
    };
    // Takes the waiting run first: a refused answer leaves the card open,
    // and one the next run already closed starts nothing.
    let decision = settle(agent_id, a, allow)?;
    if let Some(updated) = store::answer_prompt(agent_id, &a.request_id, status, word)? {
        let _ = app.emit(runner::EVENT_MESSAGE, &updated);
    }
    match decision {
        Answer::Go(c, n, run_at) => {
            super::plan_grant::note_chat_yes(agent_id, &approved_text(a), store::now_ms());
            run_step(app, agent_id, &c, n, run_at, true)?;
        }
        Answer::Stop(_, _, done) => {
            let name = a
                .gate
                .as_ref()
                .map(|g| g.routine.clone())
                .unwrap_or_default();
            let line = runner::new_message(
                agent_id,
                MessageKind::Note,
                format!("Stopped “{name}” after step {done} · you said no"),
            );
            let _ = runner::record(app, line);
        }
    }
    store::refresh_pending(agent_id);
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    Ok(())
}

#[cfg(test)]
#[path = "routine_steps_tests.rs"]
mod tests;
