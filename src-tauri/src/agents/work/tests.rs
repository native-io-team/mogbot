use super::*;
use serde_json::json;

const CLAUDE: &str = include_str!("../testdata/stream-partial.jsonl");
const CODEX_EXEC: &str = include_str!("../testdata/codex-exec.jsonl");
const CODEX_APP: &str = include_str!("../testdata/codex-app-server.jsonl");

fn lines(sample: &str) -> impl Iterator<Item = Value> + '_ {
    sample.lines().filter_map(|l| serde_json::from_str(l).ok())
}

fn message(kind: MessageKind, id: &str) -> AgentMessage {
    let mut m = super::super::runner::new_message("a1", kind, "hi");
    m.id = id.into();
    m
}

fn ours(tool: &str) -> String {
    format!("mcp__{}__{tool}", super::super::prompts::SERVER_KEY)
}

/// The timeline of a usage check or a preview test was a row of "Used a
/// tool": every tool of ours says what it did.
#[test]
fn every_tool_of_ours_has_its_own_words() {
    let names = super::super::usage_tools::TOOLS
        .iter()
        .map(|t| t.name)
        .chain(super::super::preview_test::TOOLS.iter().map(|t| t.name))
        .chain(super::super::admin::TOOLS.iter().map(|t| t.name))
        .chain(super::super::room_tools::TOOLS.iter().map(|t| t.name))
        .chain(super::super::sessions::TOOLS.iter().map(|t| t.name));
    for name in names {
        let label = describe_tool(&ours(name), Some(&json!({})))
            .map(|a| a.label)
            .unwrap_or_default();
        assert_ne!(label, "Used a tool", "{name}");
    }
    let open = describe_tool(&ours("test_open"), Some(&json!({"path": "/pricing"}))).unwrap();
    assert_eq!(open.label, "Opened /pricing in the preview");
}

fn call(name: &str, id: &str, input: Value) -> Action {
    let mut a = describe_tool(name, Some(&input)).unwrap();
    a.id = Some(id.into());
    a
}

fn done(id: &str, outcome: Outcome) -> CallResult {
    CallResult {
        id: id.into(),
        outcome,
        output: None,
    }
}

fn shot(id: &str, project: &str) -> AgentMessage {
    let mut m = message(MessageKind::Session, id);
    m.session = Some(super::super::sessions::SessionMark {
        project: project.into(),
        event: super::super::sessions::SessionEvent::Screenshot,
        session_id: None,
        tab: None,
        cli: None,
    });
    m.attachments = vec![Attachment {
        name: format!("{id}.jpg"),
        path: format!("attachments/{id}/{id}.jpg"),
        mime: "image/jpeg".into(),
        size: 10,
    }];
    m
}

#[test]
fn a_real_claude_turn_has_one_step_per_tool_call_and_its_result() {
    let actions: Vec<Action> = lines(CLAUDE).flat_map(|v| claude_actions(&v)).collect();
    assert_eq!(
        actions.len(),
        1,
        "one Bash call; stream events aren't steps"
    );
    assert_eq!(actions[0].kind, StepKind::Command);
    assert_eq!(actions[0].label, "Printed a message");
    assert_eq!(actions[0].doing, "Printing a message");
    assert_eq!(
        actions[0].id.as_deref(),
        Some("toolu_01Bx3SDHNvfg9pLufm1c4tQQ")
    );
    let results: Vec<CallResult> = lines(CLAUDE).flat_map(|v| claude_results(&v)).collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "toolu_01Bx3SDHNvfg9pLufm1c4tQQ");
    assert_eq!(results[0].outcome, Outcome::Done);
    assert_eq!(results[0].output.as_deref().map(str::trim), Some("hi"));
}

#[test]
fn claude_says_which_calls_failed_and_which_were_refused() {
    let line = json!({
        "type": "user",
        "message": { "content": [
            { "type": "tool_result", "tool_use_id": "a", "is_error": true, "content": "old_string not found" },
            { "type": "tool_result", "tool_use_id": "b", "is_error": true, "content": "no" },
            { "type": "tool_result", "tool_use_id": "c", "is_error": false, "content": "ok" }
        ]},
        "tool_result_meta": [{ "id": "b", "permission_decision": { "decision": "reject" } }]
    });
    assert_eq!(
        claude_results(&line),
        [
            CallResult {
                output: Some("old_string not found".into()),
                ..done("a", Outcome::Failed)
            },
            CallResult {
                output: Some("no".into()),
                ..done("b", Outcome::Declined)
            },
            CallResult {
                output: Some("ok".into()),
                ..done("c", Outcome::Done)
            },
        ]
    );
}

/// Claude Code rejects a Claude in Chrome call "by config" when no extension
/// is connected: the step failed, nobody said no.
#[test]
fn chrome_not_being_connected_is_a_failure_not_a_refusal() {
    let line = json!({
        "type": "user",
        "message": { "content": [
            { "type": "tool_result", "tool_use_id": "a", "is_error": true,
              "content": "Browser extension is not connected. Please ensure the extension is running." }
        ]},
        "tool_result_meta": [{ "id": "a", "permission_decision": { "decision": "reject" } }]
    });
    assert_eq!(claude_results(&line)[0].outcome, Outcome::Failed);
}

#[test]
fn a_real_codex_exec_turn_maps_onto_the_same_steps() {
    let mut live = Live::default();
    let mut labels = Vec::new();
    for v in lines(CODEX_EXEC) {
        for step in super::super::codex::steps(&v) {
            match step {
                super::super::stream::Step::Action(a) => {
                    labels.push(a.label.clone());
                    live.action(a, 1);
                }
                super::super::stream::Step::Result(r) => live.result(r),
                _ => {}
            }
        }
    }
    assert_eq!(labels, ["Wrote note.txt", "Checked on the team"]);
    // Started and completed are one step, not two, and both came back fine.
    assert_eq!(live.work.step_count, 2);
    assert!(live.work.steps.iter().all(|s| s.outcome.is_none()));
    assert!(live.calls.values().all(|c| c.settled));
}

#[test]
fn a_real_codex_app_server_turn_maps_onto_the_same_steps() {
    let mut conversation = super::super::codex_app::Conversation::new(
        None,
        std::path::Path::new("/h/a"),
        None,
        "",
        "run it",
        false,
    )
    .0;
    let mut live = Live::default();
    for value in lines(CODEX_APP) {
        for out in conversation.on_message(&value) {
            match out {
                super::super::codex_app::Out::Step(super::super::stream::Step::Action(a)) => {
                    live.action(a, 1)
                }
                super::super::codex_app::Out::Step(super::super::stream::Step::Result(r)) => {
                    live.result(r)
                }
                _ => {}
            }
        }
    }
    assert_eq!(live.work.step_count, 1);
    assert_eq!(live.work.steps[0].label, "Wrote ss-probe-esc.txt");
    assert!(live.calls.values().all(|c| c.settled));
}

#[test]
fn codex_says_what_became_of_an_item() {
    use super::super::codex::steps;
    use super::super::stream::Step;
    let item = |status: &str| {
        json!({ "type": "item.completed", "item": {
            "id": "i1", "type": "command_execution", "command": "rm -rf build",
            "exit_code": 0, "status": status
        }})
    };
    let result = |v: Value| {
        steps(&v).into_iter().find_map(|s| match s {
            Step::Result(r) => Some(r.outcome),
            _ => None,
        })
    };
    assert_eq!(result(item("declined")), Some(Outcome::Declined));
    assert_eq!(result(item("failed")), Some(Outcome::Failed));
    assert_eq!(result(item("completed")), Some(Outcome::Done));
    // Ran, but exited non-zero: it failed.
    let mut nonzero = item("completed");
    nonzero["item"]["exit_code"] = json!(1);
    assert_eq!(result(nonzero), Some(Outcome::Failed));
    // A file change arrives complete: its step and its outcome together.
    let change = json!({ "type": "item.completed", "item": {
        "id": "f1", "type": "file_change", "status": "failed",
        "changes": [{ "path": "/p/App.tsx", "kind": "update" }]
    }});
    let mut live = Live::default();
    for s in steps(&change) {
        match s {
            Step::Action(a) => live.action(a, 1),
            Step::Result(r) => live.result(r),
            _ => {}
        }
    }
    assert_eq!(live.work.steps[0].label, "Tried to edit App.tsx");
    assert_eq!(live.work.file_count, 0, "a failed edit edited nothing");
}

#[test]
fn the_agents_own_browser_is_told_apart_from_the_users_chrome() {
    let d = |name: &str, input: Value| describe_tool(name, Some(&input)).unwrap();
    let open = d(
        "mcp__browser__open",
        json!({"url": "https://www.example.com/a?token=x"}),
    );
    assert_eq!(open.label, "Used its own browser · example.com");
    assert_eq!(open.doing, "Using its own browser · example.com");
    assert_eq!(open.kind, StepKind::Web);
    let shot = d("mcp__browser__screenshot", json!({}));
    assert_eq!(shot.kind, StepKind::Screenshot);
    assert_eq!(shot.label, "Used its own browser");
    // The user's Chrome still reads as before, never as its own browser.
    let chrome = d(
        "mcp__claude-in-chrome__navigate",
        json!({"url": "https://example.com/"}),
    );
    assert!(
        !chrome.label.contains("its own browser"),
        "{}",
        chrome.label
    );

    // A step that names no site: the page that agent's browser is on.
    let agent = "own_browser_site";
    super::super::browser_gate::note_agents_page(agent, |p| {
        p.url = Some("https://news.example.org/today".into());
    });
    begin(agent, 0);
    let doing = on_action(agent, d("mcp__browser__read_page", json!({})), 1);
    assert_eq!(doing, "Using its own browser · news.example.org");
    let steps = live(agent).unwrap().steps;
    assert_eq!(steps[0].label, "Used its own browser · news.example.org");
    forget_agent(agent);
}

#[test]
fn tool_calls_read_as_plain_past_tense_words() {
    let d = |name: &str, input: Value| describe_tool(name, Some(&input)).unwrap().label;
    assert_eq!(
        d("Read", json!({"file_path": "/a/src/Hero.tsx"})),
        "Read Hero.tsx"
    );
    assert_eq!(
        d("WebSearch", json!({"query": "best espresso"})),
        "Searched the web for “best espresso”"
    );
    assert_eq!(
        d(
            "WebFetch",
            json!({"url": "https://www.acme.com/careers?ref=x"})
        ),
        "Browsed acme.com"
    );
    assert_eq!(
        d("Bash", json!({"command": "npm test -- PricingTable\nmore"})),
        "Ran the tests"
    );
    assert_eq!(
        d("Bash", json!({"command": "cd /p && npm run build"})),
        "Built the project"
    );
    assert_eq!(
        d("Bash", json!({"command": "FOO=1 git push origin main"})),
        "Pushed changes"
    );
    assert_eq!(
        d("Bash", json!({"command": "/usr/bin/curl -s https://x.io"})),
        "Fetched x.io"
    );
    // The Chief reading the team was a row of "Used a tool".
    assert_eq!(
        d(&ours("read_agent"), json!({"agent": "Finance"})),
        "Caught up on Finance's chat"
    );
    assert_eq!(d(&ours("request_login"), json!({})), "Asked you to sign in");
    assert_eq!(
        d(&ours("pause_agent"), json!({"agent": "Finance"})),
        "Paused Finance"
    );
    assert_eq!(
        d(&ours("message_agent"), json!({"agent": "Acme Site"})),
        "Messaged Acme Site"
    );
    assert_eq!(
        d(&ours("share_file"), json!({"path": "/x/report.pdf"})),
        "Shared a file"
    );
    assert_eq!(
        d(
            &ours("share_result"),
            json!({"title": "Secret plan", "summary": "x"})
        ),
        "Put together its result"
    );
    assert_eq!(
        d(&ours("schedule_check_in"), json!({})),
        "Scheduled a routine"
    );
    assert_eq!(d(&ours("something_new"), json!({})), "Used a tool");
    assert_eq!(
        d(
            "mcp__claude-in-chrome__navigate",
            json!({"url": "https://acme.com/a"})
        ),
        "Browsed acme.com"
    );
    assert_eq!(
        d("mcp__claude-in-chrome__computer", json!({})),
        "Worked in Chrome"
    );
    assert_eq!(
        d(
            "mcp__claude_ai_Google_Drive__search_files",
            json!({"query": "q3"})
        ),
        "Searched Google Drive"
    );
    assert_eq!(
        d("mcp__claude_ai_Gmail__send_email", json!({})),
        "Sent from Gmail"
    );
    assert_eq!(d("mcp__linear__frobnicate", json!({})), "Used Linear");
    assert_eq!(d("SomeNewBuiltin", json!({})), "Used a tool");
    // The engine's own bookkeeping isn't work.
    for hidden in ["ToolSearch", "Skill", "BashOutput", "ExitPlanMode"] {
        assert!(
            describe_tool(hidden, Some(&json!({}))).is_none(),
            "{hidden}"
        );
    }
    let edit = describe_tool("Edit", Some(&json!({"file_path": "/p/App.tsx"}))).unwrap();
    assert_eq!(
        (edit.label.as_str(), edit.doing.as_str(), edit.ask.as_str()),
        ("Edited App.tsx", "Editing App.tsx", "edit App.tsx")
    );
    assert_eq!(edit.files, ["/p/App.tsx"]);
}

#[test]
fn no_label_carries_a_tool_or_server_id() {
    for (name, input) in [
        ("mcp__claude-in-chrome__navigate", json!({})),
        ("mcp__claude_ai_Google_Drive__fetch", json!({})),
        ("mcp__sentry__get_issue_details", json!({})),
        ("Glob", json!({"pattern": "**/*.tsx"})),
    ] {
        let a = describe_tool(name, Some(&input)).unwrap();
        for text in [&a.label, &a.doing, &a.ask] {
            assert!(
                !text.contains("__") && !text.contains("claude") && !text.contains('_'),
                "{text}"
            );
        }
    }
}

/// Every credential shape the review found leaking, through every path a
/// label takes: the label itself, the live status, and the file on disk.
#[test]
fn credentials_never_reach_a_label_a_turn_file_or_a_status() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let nasty: [(&str, &str); 10] = [
        (
            "git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        ),
        (
            "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        ),
        (
            "curl -H 'X-Api-Key: abcd1234efgh' https://api.x.io",
            "abcd1234efgh",
        ),
        (
            "curl -H \"Authorization:Bearer abc123zz\" https://x.io",
            "abc123zz",
        ),
        ("mysql -u root -phunter2", "hunter2"),
        ("sshpass -p hunter2 ssh me@host", "hunter2"),
        ("redis-cli -a mypassword123 ping", "mypassword123"),
        (
            "curl -d '{\"password\":\"hunter2\"}' https://x.io",
            "hunter2",
        ),
        (
            "curl 'https://acct.blob.core.windows.net/c/b?sv=2020-08-04&sig=abcDEF%2B123xyz'",
            "abcDEF%2B123xyz",
        ),
        (
            "echo 0123456789abcdef0123456789abcdef0123456789abcdef",
            "0123456789abcdef0123456789abcdef0123456789abcdef",
        ),
    ];
    for (n, (cmd, secret)) in nasty.iter().enumerate() {
        let agent = format!("nasty-{n}");
        begin(&agent, 0);
        let mut doing = Vec::new();
        doing.push(on_action(
            &agent,
            call("Bash", "c", json!({"command": cmd})),
            1,
        ));
        doing.push(on_action(
            &agent,
            call("Grep", "g", json!({"pattern": cmd})),
            1,
        ));
        doing.push(on_action(
            &agent,
            call("WebSearch", "w", json!({"query": cmd})),
            1,
        ));
        doing.push(on_action(
            &agent,
            call("Task", "t", json!({"description": cmd})),
            1,
        ));
        let url = format!("https://me:{cmd}@acme.com/?token={cmd}");
        doing.push(on_action(
            &agent,
            call("WebFetch", "f", json!({"url": url})),
            1,
        ));
        let mail = json!({"to": cmd, "body": cmd});
        doing.push(on_action(
            &agent,
            call("mcp__claude_ai_Gmail__send_email", "m", mail),
            1,
        ));
        let edit = json!({"file_path": "/p/App.tsx", "old_string": cmd});
        doing.push(on_action(&agent, call("Edit", "e", edit), 1));
        on_result(&agent, done("c", Outcome::Failed));
        on_declined(&agent, "g");
        let status = serde_json::to_string(&live(&agent).unwrap()).unwrap();
        with_live(&agent, |l| {
            l.anchor = Some(message(MessageKind::Agent, "r1"))
        });
        let taken = LIVE.lock().unwrap().remove(&agent).unwrap();
        let (anchor, work) = settle(taken, 2).unwrap();
        std::fs::create_dir_all(store::agent_home(&agent).unwrap()).unwrap();
        save(&agent, &anchor.id, &work).unwrap();
        let file = std::fs::read_to_string(path_for(&agent, &anchor.id).unwrap()).unwrap();
        assert_eq!(work.step_count, 7);
        for text in [status.as_str(), file.as_str()]
            .into_iter()
            .chain(doing.iter().map(String::as_str))
        {
            assert!(!text.contains(secret), "{secret} leaked from {cmd}: {text}");
        }
        // Defence in depth: the scrubber alone catches each shape too.
        let scrubbed = scrub(&format!("Ran {cmd}"));
        assert!(
            !scrubbed.contains(secret),
            "scrub let {secret} through: {scrubbed}"
        );
    }
    store::set_root_for_tests(None);
}

#[test]
fn scrubbing_comes_before_clipping() {
    // A token long enough to be cut must still be blanked whole.
    let q = format!("needle {}", "0123456789abcdef".repeat(6));
    let a = describe_tool("Grep", Some(&json!({"pattern": q}))).unwrap();
    assert!(!a.label.contains("0123456789abcdef"), "{}", a.label);
    assert_eq!(clean(&a.label), "Searched for “needle …”");
}

#[test]
fn the_scrubber_keeps_ordinary_words() {
    for (raw, want) in [
        (
            "Ran STRIPE_KEY=sk_live_abcdefghijklmnop npm run x",
            "Ran STRIPE_KEY=… npm run x",
        ),
        (
            "Ran curl -H Authorization: Bearer abc.def.ghi https://x.io",
            "Ran curl -H Authorization: Bearer … https://x.io",
        ),
        (
            "Ran git clone https://me:hunter2@github.com/a/b",
            "Ran git clone https://…@github.com/a/b",
        ),
        ("Ran deploy --token abcd", "Ran deploy --token …"),
        ("Ran echo ghp_0123456789abcdefABCDEF", "Ran echo …"),
        (
            "Browsed https://x.io/?api_key=123",
            "Browsed https://x.io/?api_key=…",
        ),
        (
            "Ran npm test -- src/App.test.tsx",
            "Ran npm test -- src/App.test.tsx",
        ),
        (
            "Asked you for a password or key",
            "Asked you for a password or key",
        ),
        ("Scheduled a routine", "Scheduled a routine"),
    ] {
        assert_eq!(scrub(raw), want, "{raw}");
    }
}

#[test]
fn a_declined_call_says_so_and_a_failed_one_says_it_tried() {
    let mut live = Live::default();
    live.action(call("Bash", "rm", json!({"command": "rm -rf build"})), 1);
    live.action(call("Edit", "e1", json!({"file_path": "/p/App.tsx"})), 2);
    live.action(call("Edit", "e2", json!({"file_path": "/p/Hero.tsx"})), 3);
    live.action(call("Write", "w1", json!({"file_path": "/p/New.tsx"})), 4);
    // Declined on the card, then its error comes back: still declined.
    let mut card = message(MessageKind::Approval, "card-rm");
    card.approval = Some(super::super::mcp::new_card(
        "card-rm".into(),
        "Run a command".into(),
        "rm -rf build".into(),
        None,
    ));
    live.message(&card);
    live.answer("card-rm", ApprovalStatus::Denied);
    live.result(done("rm", Outcome::Declined));
    live.result(done("rm", Outcome::Failed));
    live.result(done("e1", Outcome::Failed));
    live.result(done("e2", Outcome::Done));
    let labels: Vec<(&str, Option<StepOutcome>)> = live
        .work
        .steps
        .iter()
        .map(|s| (s.label.as_str(), s.outcome))
        .collect();
    assert_eq!(
        labels,
        [
            (
                "Asked to delete build — you declined",
                Some(StepOutcome::Declined)
            ),
            ("Tried to edit App.tsx", Some(StepOutcome::Failed)),
            ("Edited Hero.tsx", None),
            ("Wrote New.tsx", None),
            ("You declined: Run a command", Some(StepOutcome::Declined)),
        ]
    );
    // Only the edit that came back counts; the write hasn't come back yet.
    assert_eq!(
        (live.work.file_count, live.work.files.clone()),
        (1, vec!["Hero.tsx".to_string()])
    );
}

#[test]
fn an_edit_to_the_same_file_twice_is_one_file() {
    let mut live = Live::default();
    for i in 0..3 {
        let id = format!("e{i}");
        live.action(call("Edit", &id, json!({"file_path": "/p/App.tsx"})), 0);
        live.result(done(&id, Outcome::Done));
    }
    assert_eq!((live.work.step_count, live.work.file_count), (3, 1));
    assert_eq!(live.work.files, ["App.tsx"]);
}

#[test]
fn an_approval_step_says_what_the_user_answered() {
    let card = |id: &str, title: &str| {
        let mut m = message(MessageKind::Approval, id);
        m.approval = Some(super::super::mcp::new_card(
            id.into(),
            title.into(),
            "d".into(),
            None,
        ));
        m
    };
    let mut live = Live::default();
    live.message(&card("r1", "Run a command"));
    live.message(&card("r2", "Send an email · Gmail"));
    live.message(&card("r3", "Push acme"));
    live.answer("r1", ApprovalStatus::Allowed);
    live.answer("r2", ApprovalStatus::Denied);
    live.answer("nope", ApprovalStatus::Allowed);
    let labels: Vec<(&str, Option<StepOutcome>)> = live
        .work
        .steps
        .iter()
        .map(|s| (s.label.as_str(), s.outcome))
        .collect();
    assert_eq!(
        labels,
        [
            ("You allowed: Run a command", None),
            (
                "You declined: Send an email · Gmail",
                Some(StepOutcome::Declined)
            ),
            ("Asked for your OK: Push acme", None),
        ]
    );
}

#[test]
fn a_turn_is_bounded() {
    let mut live = Live::default();
    for n in 0..(MAX_STEPS + 15) {
        let id = format!("e{n}");
        let mut a = call("Edit", &id, json!({"file_path": format!("/p/f{n}.ts")}));
        a.label = "x".repeat(500);
        live.action(a, n as i64);
        live.result(done(&id, Outcome::Done));
    }
    assert_eq!(live.work.step_count as usize, MAX_STEPS + 15);
    assert_eq!(live.work.steps.len(), MAX_STEPS);
    assert_eq!(live.work.steps[0].at, 15, "the newest are kept");
    assert!(live
        .work
        .steps
        .iter()
        .all(|s| s.label.chars().count() <= LABEL_CHARS));
    assert_eq!(live.work.file_count as usize, MAX_STEPS + 15);
    assert_eq!(live.work.files.len(), MAX_FILES);
}

#[test]
fn a_screenshot_lands_on_the_call_that_took_it() {
    let mut live = Live::default();
    let take = |id: &str, project: &str| {
        call(&ours("preview_screenshot"), id, json!({"project": project}))
    };
    // Two in parallel, then something unrelated in a project.
    live.action(take("sa", "/p/alpha"), 1);
    live.action(take("sb", "/p/beta"), 2);
    live.action(
        call(&ours("push"), "push", json!({"project": "/p/alpha"})),
        3,
    );
    live.message(&shot("b-desktop", "/p/beta"));
    live.message(&shot("a-desktop", "/p/alpha"));
    live.message(&shot("a-phone", "/p/alpha")); // the phone-sized one of the same call
    let images: Vec<(&str, Option<&str>)> = live
        .work
        .steps
        .iter()
        .map(|s| (s.label.as_str(), s.image.as_ref().map(|i| i.name.as_str())))
        .collect();
    assert_eq!(
        images,
        [
            ("Took a screenshot of alpha", Some("a-desktop.jpg")),
            ("Took a screenshot of beta", Some("b-desktop.jpg")),
            ("Pushed alpha", None),
        ]
    );
    // One no call explains (a session's reply came with it) is its own step.
    live.result(done("sa", Outcome::Done));
    live.message(&shot("later", "/p/alpha"));
    assert_eq!(live.work.step_count, 4);
    assert_eq!(live.work.steps[3].label, "Took a screenshot of alpha");
}

#[test]
fn only_what_the_turn_said_is_an_anchor() {
    let mut live = Live::default();
    live.action(call("Read", "r", json!({"file_path": "/a.ts"})), 1);
    live.message(&message(MessageKind::Agent, "reply"));
    // Someone else's line written into this chat mid-turn, or a divider.
    live.message(&message(MessageKind::Note, "audit"));
    let mut fresh = message(MessageKind::Note, "fresh");
    fresh.fresh = true;
    live.message(&fresh);
    live.message(&message(MessageKind::User, "u1"));
    let (anchor, work) = settle(live, 9).unwrap();
    assert_eq!(anchor.id, "reply");
    assert_eq!(work.ended_at, Some(9));
    assert!(work.doing.is_none());
}

#[test]
fn a_result_card_is_where_the_turn_ends() {
    // Its own message is a reply: the timeline hangs under it.
    let mut live = Live::default();
    live.action(call("Read", "r", json!({"file_path": "/a.ts"})), 1);
    live.message(&message(MessageKind::Agent, "reply"));
    live.message(&message(MessageKind::Agent, "result"));
    assert_eq!(settle(live, 9).unwrap().0.id, "result");

    // Riding on the change card, the change card is the result; a plain
    // change card never is.
    let mut live = Live::default();
    live.action(call("Read", "r", json!({"file_path": "/a.ts"})), 1);
    live.message(&message(MessageKind::Agent, "reply"));
    live.message(&message(MessageKind::Changes, "plain-changes"));
    assert_eq!(settle(live, 9).unwrap().0.id, "reply");
    let mut live = Live::default();
    live.action(call("Read", "r", json!({"file_path": "/a.ts"})), 1);
    live.message(&message(MessageKind::Agent, "reply"));
    let mut card = message(MessageKind::Agent, "staged");
    card.result = Some(super::super::results::ResultCard {
        id: "r1".into(),
        version: 1,
        title: "t".into(),
        summary: "s".into(),
        items: Vec::new(),
        checked: Vec::new(),
        not_verified: Vec::new(),
        changes: None,
        project: None,
        test: None,
        checkpoint: false,
    });
    let merged = super::super::results::ride_on(message(MessageKind::Changes, "c"), card);
    assert_eq!(
        (merged.id.as_str(), merged.kind),
        ("staged", MessageKind::Changes)
    );
    live.message(&merged);
    assert_eq!(settle(live, 9).unwrap().0.id, "staged");
}

#[test]
fn the_live_status_carries_what_is_running_only_while_it_runs() {
    let agent = "live-doing";
    begin(agent, 0);
    on_action(agent, call("Bash", "t", json!({"command": "npm test"})), 1);
    let w = live(agent).unwrap();
    assert_eq!(w.doing.as_deref(), Some("Running the tests"));
    assert!(w.files.is_empty());
    on_result(agent, done("t", Outcome::Done));
    assert_eq!(
        live(agent).unwrap().doing,
        None,
        "came back: the working line isn't it any more"
    );
    forget_agent(agent);
    assert!(live(agent).is_none());
}

#[test]
fn a_turn_without_steps_keeps_nothing() {
    let mut live = Live::default();
    live.message(&message(MessageKind::Agent, "r1"));
    assert!(settle(live, 1).is_none());
}

#[test]
fn kept_on_disk_beside_the_log_never_in_it() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let agent_id = "a1";
    std::fs::create_dir_all(store::agent_home(agent_id).unwrap()).unwrap();
    let work = TurnWork {
        started_at: 1,
        ended_at: Some(2),
        step_count: 1,
        steps: vec![WorkStep {
            at: 1,
            kind: StepKind::Read,
            label: "Read a.ts".into(),
            outcome: Some(StepOutcome::Failed),
            image: None,
            ..WorkStep::blank()
        }],
        ..TurnWork::default()
    };
    let id = store::new_id();
    save(agent_id, &id, &work).unwrap();
    assert_eq!(load(agent_id, &id), Some(work.clone()));
    let mut fresh = message(MessageKind::Note, &id);
    fresh.fresh = true;
    let mut page = vec![
        message(MessageKind::Agent, &id),
        message(MessageKind::User, "u"),
        fresh,
    ];
    apply(agent_id, &mut page);
    assert_eq!(page[0].work.as_ref(), Some(&work));
    assert!(page[1].work.is_none());
    assert!(page[2].work.is_none(), "a divider never carries a timeline");
    // Never a path out of the home.
    assert!(path_for(agent_id, "../x").is_none());
    store::set_root_for_tests(None);
}

#[test]
fn old_timelines_are_pruned_but_the_first_pages_keep_theirs() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let agent_id = "busy";
    std::fs::create_dir_all(store::agent_home(agent_id).unwrap()).unwrap();
    let work = TurnWork {
        step_count: 1,
        ..TurnWork::default()
    };
    let total = KEEP_TURNS + 20;
    let now = std::time::SystemTime::now();
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for i in 0..total {
        let id = format!("m{i:04}");
        save(agent_id, &id, &work).unwrap();
        // m0000 is the oldest; each a day newer than the last.
        let when = now - day * (total - i) as u32;
        let file = std::fs::File::options()
            .write(true)
            .open(path_for(agent_id, &id).unwrap())
            .unwrap();
        file.set_modified(when).unwrap();
    }
    prune_at(agent_id, now);
    let left = std::fs::read_dir(turns_dir(agent_id).unwrap())
        .unwrap()
        .count();
    // Past the newest KEEP_RECENT, nothing older than KEEP_DAYS stays.
    assert_eq!(left, KEEP_RECENT);
    assert!(load(agent_id, &format!("m{:04}", total - 1)).is_some());
    assert!(load(agent_id, "m0000").is_none());

    // A quiet agent: old, but few, so all of them stay.
    let quiet = "quiet";
    std::fs::create_dir_all(store::agent_home(quiet).unwrap()).unwrap();
    for i in 0..10 {
        let id = format!("q{i}");
        save(quiet, &id, &work).unwrap();
        let file = std::fs::File::options()
            .write(true)
            .open(path_for(quiet, &id).unwrap())
            .unwrap();
        file.set_modified(now - day * 400).unwrap();
    }
    prune_at(quiet, now);
    assert_eq!(
        std::fs::read_dir(turns_dir(quiet).unwrap())
            .unwrap()
            .count(),
        10
    );
    store::set_root_for_tests(None);
}

#[test]
fn an_older_build_reads_a_message_carrying_work() {
    // What a newer build would send: an unknown step kind still reads.
    let raw = r#"{"startedAt":1,"stepCount":1,"steps":[{"at":1,"kind":"teleport","label":"x"}]}"#;
    let work: TurnWork = serde_json::from_str(raw).unwrap();
    assert_eq!(work.steps[0].kind, StepKind::Tool);
    assert_eq!(work.steps[0].outcome, None);
}

#[test]
fn a_call_refused_without_your_answer_never_says_you_declined() {
    // Real timelines: "Asked for your OK: Run a command" (never answered;
    // the card was set aside) beside "Asked to run ls — you declined".
    let mut live = Live::default();
    let mut card = message(MessageKind::Approval, "c1");
    card.approval = Some(super::super::mcp::new_card(
        "c1".into(),
        "Run a command".into(),
        "ls".into(),
        None,
    ));
    live.action(call("Bash", "ls", json!({"command": "ls /tmp/plan"})), 1);
    live.message(&card);
    live.result(done("ls", Outcome::Declined));
    let labels: Vec<&str> = live.work.steps.iter().map(|s| s.label.as_str()).collect();
    assert_eq!(labels.len(), 2);
    assert!(labels[0].ends_with("— it wasn't allowed"), "{labels:?}");
    assert!(!labels[0].contains("you declined"), "{labels:?}");
    assert_eq!(labels[1], "Asked for your OK: Run a command");
}

#[test]
fn a_page_can_leave_steps_out_and_say_so() {
    let step = WorkStep {
        at: 1,
        kind: StepKind::Read,
        label: "Read a.ts".into(),
        ..WorkStep::blank()
    };
    let work = TurnWork {
        started_at: 1,
        ended_at: Some(2),
        step_count: 3,
        steps: vec![step.clone(), step],
        files: vec!["a.ts".into()],
        file_count: 1,
        ..TurnWork::default()
    };
    let mut with = message(MessageKind::Agent, "m1");
    with.work = Some(work.clone());
    let mut empty = message(MessageKind::Agent, "m2");
    empty.work = Some(TurnWork::default());
    let mut page = vec![with, empty, message(MessageKind::User, "u")];
    omit_steps(&mut page);
    let folded = page[0].work.as_ref().unwrap();
    assert!(folded.steps.is_empty() && folded.steps_omitted);
    assert_eq!(
        (
            folded.step_count,
            folded.file_count,
            &folded.files,
            folded.ended_at
        ),
        (3, 1, &work.files, Some(2))
    );
    // Nothing to leave out: nothing is said to be missing.
    assert!(!page[1].work.as_ref().unwrap().steps_omitted);
    assert!(page[2].work.is_none());

    // The wire form says the same, and an unasked-for page never carries it.
    let value = serde_json::to_value(&page[0]).unwrap();
    assert_eq!(value["work"]["stepsOmitted"], serde_json::json!(true));
    assert!(serde_json::to_value(&work)
        .unwrap()
        .get("stepsOmitted")
        .is_none());
    let mut json_page = vec![serde_json::to_value({
        let mut m = message(MessageKind::Agent, "m1");
        m.work = Some(work.clone());
        m
    })
    .unwrap()];
    omit_steps_json(&mut json_page);
    assert_eq!(json_page[0]["work"], value["work"]);
}

/// `use_account` from a check-in only raises a card; the timeline must not
/// say the account was switched.
#[test]
fn a_settings_call_that_only_asked_says_it_asked() {
    let said = |tool: &str, outcome: Outcome, out: &str| {
        let mut live = Live::default();
        live.action(call(&ours(tool), "c", json!({})), 1);
        live.result(CallResult {
            id: "c".into(),
            outcome,
            output: Some(out.into()),
        });
        let s = &live.work.steps[0];
        (s.label.clone(), s.outcome)
    };
    assert_eq!(
        said(
            "use_account",
            Outcome::Done,
            "Claude Code turns now start on “Work”."
        ),
        ("Switched the account turns run on".into(), None)
    );
    assert_eq!(
        said(
            "use_account",
            Outcome::Done,
            &super::super::usage_tools::switch_asked("Work", false)
        ),
        (
            "Asked you to switch the account turns run on — waiting for your OK".into(),
            None
        )
    );
    assert_eq!(
        said(
            "set_usage_mode",
            Outcome::Failed,
            "The user said no. Don't change it."
        ),
        (
            "Asked to change how your limits are used — you said no".into(),
            Some(StepOutcome::Declined)
        )
    );
    assert_eq!(
        said("use_account", Outcome::Failed, "“Work” isn't signed in"),
        (
            "Tried to switch the account turns run on".into(),
            Some(StepOutcome::Failed)
        )
    );
}
