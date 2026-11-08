use super::*;
use serde_json::json;

fn result() -> Value {
    json!({"type": "result", "subtype": "success", "is_error": false, "result": ""})
}

fn text(t: &str) -> Value {
    json!({"type": "assistant", "parent_tool_use_id": null,
        "message": {"model": "claude-test", "content": [{"type": "text", "text": t}]}})
}

fn tool_use(id: &str, name: &str) -> Value {
    json!({"type": "assistant", "parent_tool_use_id": null,
    "message": {"model": "claude-test", "content": [
        {"type": "tool_use", "id": id, "name": name, "input": {"description": "Check the pricing page"}}
    ]}})
}

fn tool_result(id: &str, content: Value) -> Value {
    json!({"type": "user", "parent_tool_use_id": null,
    "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": id, "content": content}
    ]}})
}

fn helper_launched(tool: &str, agent: &str) -> Value {
    tool_result(
        tool,
        json!([{"type": "text", "text": format!(
            "Async agent launched successfully. (internal)\nagentId: {agent} (internal ID - do not mention to user.)\nThe agent is working in the background.\noutput_file: /tmp/example/tasks/{agent}.output"
        )}]),
    )
}

fn notification(ids: &[&str], status: &str) -> Value {
    let tasks: String = ids
        .iter()
        .map(|id| format!("<task-id>{id}</task-id>\n"))
        .collect();
    json!({"type": "user", "message": {"role": "user", "content": format!(
        "<task-notification>\n{tasks}<status>{status}</status>\n<summary>Agent \"Check the pricing page\" finished</summary>\n</task-notification>"
    )}})
}

fn feed(end: &mut TurnEnd, lines: &[Value]) {
    for line in lines {
        end.on_line(line);
        if line.get("type").and_then(Value::as_str) == Some("result") {
            end.on_done();
        }
    }
}

#[test]
fn a_result_with_nothing_after_it_ends_the_turn() {
    let mut end = TurnEnd::default();
    feed(&mut end, &[text("Done: the page is live."), result()]);
    assert!(end.over());
    assert_eq!(end.grace(), AFTER_RESULT);
    assert_eq!(end.waiting_on(), 0);
}

/// The observed failure: resumed, Claude Code answers the queued "helpers
/// stopped" notification with a result of its own, then works on the user's
/// message. A tool call that runs for seconds after that must not end it.
#[test]
fn work_after_an_early_result_reopens_the_turn_until_the_next_result() {
    let mut end = TurnEnd::default();
    feed(&mut end, &[notification(&["a1"], "stopped"), result()]);
    assert!(end.over(), "the first result looks like an end");

    // The model starts on the user's message: the turn is open again.
    assert!(end.on_line(&json!({"type": "stream_event", "event": {"type": "message_start"}})));
    assert!(!end.over());
    // A long tool call: nothing streams for a while, and nothing ends it.
    end.on_line(&tool_use("t1", "Bash"));
    assert!(!end.over());
    end.on_line(&tool_result("t1", json!("ok")));
    end.on_line(&text("Rebuilt the section."));
    assert!(!end.over());

    end.on_line(&result());
    end.on_done();
    assert!(end.over());
}

#[test]
fn a_system_line_or_progress_tick_after_the_final_result_does_not_reopen_it() {
    let mut end = TurnEnd::default();
    feed(&mut end, &[text("Started the dev server."), result()]);
    assert!(!end.on_line(&json!({"type": "system", "subtype": "status"})));
    assert!(!end.on_line(&json!({"type": "tool_progress", "tool_use_id": "t9"})));
    assert!(end.over());
}

#[test]
fn a_helper_launched_in_the_background_holds_the_turn_until_it_reports_back() {
    let mut end = TurnEnd::default();
    feed(
        &mut end,
        &[
            tool_use("t1", "Agent"),
            helper_launched("t1", "aexample01"),
            tool_use("t2", "Agent"),
            helper_launched("t2", "aexample02"),
            text("Two reviewers are running; I'll report when they're back."),
            result(),
        ],
    );
    assert!(end.over());
    assert_eq!(end.waiting_on(), 2);
    assert_eq!(
        end.grace(),
        HELPER_WAIT,
        "waits for them, not the usual moment"
    );

    // The first reports back: Claude Code starts another round.
    assert!(end.on_line(&notification(&["aexample01"], "completed")));
    assert_eq!(end.waiting_on(), 1);
    feed(&mut end, &[text("The first review is back."), result()]);
    assert_eq!(end.grace(), HELPER_WAIT);

    // The system event form counts too.
    end.on_line(&json!({"type": "system", "subtype": "task_notification", "task_id": "aexample02", "status": "completed"}));
    assert_eq!(end.waiting_on(), 0);
    feed(&mut end, &[text("Both reviews are back."), result()]);
    assert!(end.over());
    assert_eq!(end.grace(), AFTER_RESULT);
}

#[test]
fn one_notification_can_report_several_helpers() {
    let mut end = TurnEnd::default();
    feed(
        &mut end,
        &[
            helper_launched("t1", "aexample01"),
            helper_launched("t2", "aexample02"),
        ],
    );
    end.on_line(&notification(&["aexample01", "aexample02"], "stopped"));
    assert_eq!(end.waiting_on(), 0);
}

#[test]
fn a_foreground_tool_result_is_not_a_helper() {
    let mut end = TurnEnd::default();
    feed(
        &mut end,
        &[
            tool_use("t1", "Agent"),
            tool_result(
                "t1",
                json!([{"type": "text", "text": "The pricing page says $20."}]),
            ),
            tool_use("t2", "Bash"),
            tool_result(
                "t2",
                json!("Command running in background with ID: bexample"),
            ),
        ],
    );
    assert_eq!(end.waiting_on(), 0);
}

#[test]
fn a_silent_turn_always_gets_one_line() {
    let quiet = Left {
        silent: true,
        helpers: 0,
    };
    let line = closing_line(quiet, false).expect("never silent");
    assert!(line.starts_with("Finished without a reply"));
    // It left a card or an error instead: that is its word.
    assert_eq!(closing_line(quiet, true), None);
    // It replied, and left nothing behind: nothing to add.
    assert_eq!(closing_line(Left::default(), false), None);
}

#[test]
fn helpers_that_stopped_with_the_turn_are_said_whether_or_not_it_replied() {
    let lost = Left {
        silent: true,
        helpers: 2,
    };
    let line = closing_line(lost, false).unwrap();
    assert!(line.starts_with("Finished without a reply."));
    assert!(line.contains("The 2 helpers it started in the background stopped with it"));

    let replied = Left {
        silent: false,
        helpers: 1,
    };
    let line = closing_line(replied, false).unwrap();
    assert!(line.starts_with("The helper it started in the background stopped with it"));
    assert!(
        closing_line(replied, true).is_some(),
        "a card doesn't say it"
    );

    assert_eq!(stopped_helpers_line(0), None);
    assert!(stopped_helpers_line(3).unwrap().contains("The 3 helpers"));
}

#[test]
fn what_a_turn_left_is_taken_once() {
    leave("turn-end-test-agent", Left::default());
    assert_eq!(
        take("turn-end-test-agent"),
        None,
        "nothing to say, nothing kept"
    );
    let left = Left {
        silent: true,
        helpers: 0,
    };
    leave("turn-end-test-agent", left);
    assert_eq!(take("turn-end-test-agent"), Some(left));
    assert_eq!(take("turn-end-test-agent"), None);
}

#[test]
fn the_waiting_line_counts_helpers() {
    assert_eq!(
        waiting_line(1),
        "Waiting for the helper it started to report back"
    );
    assert_eq!(
        waiting_line(4),
        "Waiting for the 4 helpers it started to report back"
    );
}
