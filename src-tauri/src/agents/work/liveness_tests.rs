//! The live step's lifecycle and the stall detector.

use super::super::{begin, live, on_action, on_result, CallResult, LIVE};
use super::*;
use crate::agents::procs::ProcRow;
use crate::agents::work::Slow;
use serde_json::json;

fn agent(name: &str) -> String {
    format!("liveness-{name}-{}", crate::agents::store::new_id())
}

fn bash(id: &str, command: &str) -> super::super::Action {
    let mut a = super::super::describe_tool("Bash", Some(&json!({ "command": command }))).unwrap();
    a.id = Some(id.into());
    a
}

fn row(pid: u32, ppid: u32, cpu: f32, command: &str) -> ProcRow {
    ProcRow {
        pid,
        ppid,
        cpu,
        zombie: false,
        command: command.into(),
    }
}

const CYPRESS: &str = "npm exec cypress run --config baseUrl=http://localhost:3268 --spec cypress/e2e/pages/**/*.cy.ts";

#[test]
fn a_call_is_live_from_the_moment_it_starts() {
    let a = agent("start");
    begin(&a, 1_000);
    set_streams(&a, true);
    let doing = on_action(&a, bash("c1", CYPRESS), 2_000);
    assert_eq!(doing, "Running the Cypress tests");
    let w = live(&a).unwrap();
    let current = w.current.unwrap();
    assert_eq!(current.label, "Running the Cypress tests");
    assert_eq!(current.started_at, 2_000);
    assert_eq!(current.slow, Some(Slow::Tests));
    assert!(current.streams && current.can_stop);
    assert_eq!(w.doing.as_deref(), Some("Running the Cypress tests"));
    // The timeline has the step already, before anything came back.
    assert_eq!(w.steps.last().unwrap().label, "Ran the Cypress tests");
    assert!(w.steps.last().unwrap().ended_at.is_none());
    LIVE.lock().unwrap().remove(&a);
}

#[test]
fn output_streams_into_the_live_step_and_is_kept_when_long() {
    let a = agent("output");
    begin(&a, 0);
    set_streams(&a, true);
    on_action(&a, bash("c1", CYPRESS), 1_000);
    for i in 1..=30 {
        on_output(
            &a,
            "c1",
            &format!("  ✓ page {i} renders (120ms)\n"),
            2_000 + i,
        );
    }
    // Another call's output isn't this one's.
    on_output(&a, "other", "nope\n", 3_000);
    assert!(take_dirty(&a));
    assert!(!take_dirty(&a), "dirty is cleared once taken");
    let current = live(&a).unwrap().current.unwrap();
    assert_eq!(
        current.output.len(),
        crate::agents::work::output::TAIL_LINES
    );
    assert_eq!(
        current.output.last().unwrap(),
        "  ✓ page 30 renders (120ms)"
    );
    assert!(!current.output.iter().any(|l| l.contains("nope")));
    // It comes back after six minutes: the step ends, with its counts and its last lines.
    with_live(&a, |l| {
        l.result_at(
            CallResult {
                id: "c1".into(),
                outcome: super::super::Outcome::Failed,
                output: Some("…\n  ✖  3 of 12 failed (25%)   06:12   45   42   3   -   -\n".into()),
            },
            1_000 + 372_000,
        )
    });
    let w = live(&a).unwrap();
    assert!(w.current.is_none() && w.doing.is_none());
    let step = w.steps.last().unwrap();
    assert_eq!(step.ended_at, Some(373_000));
    assert_eq!(step.summary.as_deref(), Some("42 passed, 3 failed"));
    assert_eq!(step.label, "Tried to run the Cypress tests");
    // What it printed rides on the stored timeline, not on every status.
    assert!(step.output.is_empty());
    let stored = LIVE.lock().unwrap().remove(&a).unwrap();
    let kept = stored.work.steps.last().unwrap();
    assert!(kept.output.iter().any(|l| l.contains("3 of 12 failed")));
}

#[test]
fn a_quick_success_keeps_no_output() {
    let a = agent("quick");
    begin(&a, 0);
    on_action(&a, bash("c1", "git status"), 1_000);
    with_live(&a, |l| {
        l.result_at(
            CallResult {
                id: "c1".into(),
                outcome: super::super::Outcome::Done,
                output: Some("clean\n".into()),
            },
            1_500,
        )
    });
    let stored = LIVE.lock().unwrap().remove(&a).unwrap();
    let step = stored.work.steps.last().unwrap();
    assert_eq!(step.ended_at, Some(1_500));
    assert!(step.output.is_empty() && step.summary.is_none());
}

#[test]
fn claude_code_streams_no_output() {
    let a = agent("claude");
    begin(&a, 0);
    set_streams(&a, false);
    on_action(&a, bash("c1", "npm test"), 1);
    let current = live(&a).unwrap().current.unwrap();
    assert!(!current.streams);
    on_result(
        &a,
        CallResult {
            id: "c1".into(),
            outcome: super::super::Outcome::Done,
            output: None,
        },
    );
    assert!(live(&a).unwrap().current.is_none());
    LIVE.lock().unwrap().remove(&a);
}

#[test]
fn stalls_after_three_minutes_or_six_for_a_slow_tool() {
    assert!(!stalled(STALL_MS - 1, 0, false));
    assert!(stalled(STALL_MS, 0, false));
    assert!(!stalled(STALL_MS, 0, true));
    assert!(stalled(STALL_SLOW_MS, 0, true));
}

#[test]
fn heartbeats_are_life_but_not_progress() {
    let a = agent("heartbeat");
    begin(&a, 0);
    on_action(&a, bash("c1", "git fetch origin"), 0);
    // Claude Code's tool_progress every few seconds, nothing else.
    for t in (5_000..=STALL_MS).step_by(5_000) {
        on_sign(&a, t, false);
    }
    let p = pulse(&a, STALL_MS, None, None);
    assert!(p.changed);
    let w = live(&a).unwrap();
    assert_eq!(w.quiet_since, Some(0));
    assert_eq!(w.last_sign_at, Some(STALL_MS));
    // Any real output ends the quiet.
    on_sign(&a, STALL_MS + 1, true);
    assert_eq!(live(&a).unwrap().quiet_since, None);
    assert!(take_dirty(&a));
    LIVE.lock().unwrap().remove(&a);
}

#[test]
fn a_busy_process_is_progress_and_an_idle_one_is_not() {
    let a = agent("cpu");
    begin(&a, 0);
    on_action(&a, bash("c1", CYPRESS), 0);
    let engine = 100;
    let busy = vec![
        row(engine, 1, 0.0, "claude --print"),
        row(
            101,
            engine,
            0.0,
            &format!("/bin/zsh -c -l source snap.sh && eval '{CYPRESS}'"),
        ),
        row(102, 101, 92.0, "node cypress run"),
        // Someone else's npm, not under this engine: never counted.
        row(200, 1, 99.0, CYPRESS),
    ];
    let p = pulse(&a, STALL_SLOW_MS + 1, Some(&busy), Some(engine));
    assert!(p.changed && !p.hung);
    let w = live(&a).unwrap();
    assert_eq!(w.current.as_ref().unwrap().busy, Some(true));
    assert_eq!(
        w.quiet_since, None,
        "a command using the CPU is making progress"
    );
    // Then the same tree goes idle for longer than a slow tool gets.
    let idle: Vec<ProcRow> = busy
        .iter()
        .map(|r| ProcRow {
            cpu: 0.0,
            ..r.clone()
        })
        .collect();
    let later = STALL_SLOW_MS + 1 + STALL_SLOW_MS;
    pulse(&a, later, Some(&idle), Some(engine));
    let w = live(&a).unwrap();
    assert_eq!(w.current.unwrap().busy, Some(false));
    assert_eq!(w.quiet_since, Some(STALL_SLOW_MS + 1));
    LIVE.lock().unwrap().remove(&a);
}

#[test]
fn a_command_that_ended_without_the_engine_noticing_is_hung() {
    let a = agent("hung");
    begin(&a, 0);
    on_action(&a, bash("c1", "npm run build"), 0);
    let engine = 100;
    let running = vec![
        row(engine, 1, 0.0, "codex app-server"),
        row(101, engine, 50.0, "/bin/zsh -lc npm run build"),
    ];
    assert!(!pulse(&a, 10_000, Some(&running), Some(engine)).hung);
    let gone = vec![row(engine, 1, 0.0, "codex app-server")];
    assert!(
        !pulse(&a, 20_000, Some(&gone), Some(engine)).hung,
        "gone, but not for long"
    );
    // Heartbeats don't make it any less hung.
    on_sign(&a, 60_000, false);
    assert!(pulse(&a, 20_000 + GONE_MS, Some(&gone), Some(engine)).hung);
    LIVE.lock().unwrap().remove(&a);
}

#[test]
fn a_zombie_counts_as_gone_and_a_process_never_found_is_never_hung() {
    let a = agent("zombie");
    begin(&a, 0);
    on_action(&a, bash("c1", "npm run build"), 0);
    let engine = 100;
    let mut zombie = row(101, engine, 0.0, "/bin/zsh -lc npm run build");
    zombie.zombie = true;
    // Never seen alive: no claim it ended (the needle may simply not match).
    assert!(
        !pulse(
            &a,
            GONE_MS * 3,
            Some(&[row(engine, 1, 0.0, "x"), zombie.clone()]),
            Some(engine)
        )
        .hung
    );
    pulse(
        &a,
        GONE_MS * 3 + 1,
        Some(&[
            row(engine, 1, 0.0, "x"),
            ProcRow {
                zombie: false,
                ..zombie.clone()
            },
        ]),
        Some(engine),
    );
    pulse(
        &a,
        GONE_MS * 3 + 2,
        Some(&[row(engine, 1, 0.0, "x"), zombie.clone()]),
        Some(engine),
    );
    assert!(
        pulse(
            &a,
            GONE_MS * 4 + 2,
            Some(&[row(engine, 1, 0.0, "x"), zombie]),
            Some(engine)
        )
        .hung
    );
    LIVE.lock().unwrap().remove(&a);
}

#[test]
fn needles_stop_where_a_shell_would_rewrite() {
    assert_eq!(needle("npm test").as_deref(), Some("npm test"));
    assert_eq!(
        needle("git commit -m \"x\"").as_deref(),
        Some("git commit -m")
    );
    assert_eq!(needle("ls $HOME"), None, "too little left to match on");
    assert_eq!(
        needle(CYPRESS).unwrap().chars().count(),
        40,
        "capped, so a wrapped command line still contains it"
    );
}

#[test]
fn step_roots_are_the_outermost() {
    let rows = vec![
        row(100, 1, 0.0, "claude"),
        row(101, 100, 0.0, "zsh -c npm test"),
        row(102, 101, 0.0, "npm test"),
        row(103, 102, 0.0, "node jest"),
    ];
    let procs = step_procs(&rows, 100, "npm test");
    let roots: Vec<u32> = step_roots(&procs).iter().map(|r| r.pid).collect();
    assert_eq!(roots, [101]);
    assert_eq!(procs.len(), 3);
}

#[test]
fn check_on_it_says_what_it_found() {
    let step = |procs| CheckStep {
        doing: "Running the Cypress tests".into(),
        command: true,
        seen_proc: true,
        procs,
    };
    let view = |s| {
        Some(CheckView {
            last_progress: 0,
            step: s,
        })
    };
    assert_eq!(
        check_line(
            "Claude Code",
            1,
            true,
            view(Some(step(Some(Procs {
                alive: true,
                busy: true
            }))))
        ),
        "Still going: running the Cypress tests is using the CPU right now."
    );
    assert!(check_line(
        "Claude Code",
        300_000,
        true,
        view(Some(step(Some(Procs {
            alive: true,
            busy: false
        }))))
    )
    .contains("isn't using the CPU, and its last progress was 5 min ago"));
    assert_eq!(
        check_line(
            "Codex",
            1,
            true,
            view(Some(step(Some(Procs {
                alive: false,
                busy: false
            }))))
        ),
        "Its command has ended, but Codex hasn't moved on yet."
    );
    assert_eq!(
        check_line("Claude Code", 4_000, true, view(None)),
        "Claude Code is running. Its last progress was 4s ago."
    );
    assert!(check_line("Claude Code", 1, false, view(None)).contains("isn't running any more"));
    assert_eq!(
        check_line("Claude Code", 1, true, None),
        "It isn't working on anything right now."
    );
}
