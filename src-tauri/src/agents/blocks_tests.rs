use super::*;
use serde_json::json;

fn one(block: Value) -> Result<BlockSet, String> {
    parse(&json!({ "blocks": [block] }))
}

fn stored(set: &BlockSet) -> Value {
    serde_json::to_value(set).unwrap()
}

#[test]
fn a_line_chart_is_kept_with_a_summary_and_versioned() {
    let set = parse(&json!({
        "text": "Signups are up.",
        "blocks": [{
            "kind": "chart", "chart": "line", "title": "Signups",
            "labels": ["Mon", "Tue", "Wed"],
            "series": [{ "name": "Signups", "values": [160, null, 12500] }]
        }]
    }))
    .unwrap();
    let v = stored(&set);
    assert_eq!(v["v"], 1);
    assert_eq!(v["intro"], "Signups are up.");
    assert_eq!(v["items"][0]["kind"], "chart");
    assert_eq!(v["items"][0]["chart"], "line");
    assert_eq!(v["items"][0]["series"][0]["values"][1], Value::Null);
    let summary = v["items"][0]["summary"].as_str().unwrap();
    assert!(
        summary.starts_with("Signups (line chart, Mon to Wed)"),
        "{summary}"
    );
    assert!(summary.contains("160 → 12.5K"), "{summary}");
    let text = message_text(&set);
    assert!(text.starts_with("Signups are up.\n\nSignups (line chart"));
    assert!(v.get("fromOutside").is_none());
}

#[test]
fn what_is_stored_reads_back_the_same() {
    let set = parse(&json!({ "blocks": [
        { "kind": "table", "columns": ["Name", { "label": "Revenue", "prefix": "$" }], "rows": [["Acme", 1200.5], ["Globex", null]] },
        { "kind": "metrics", "items": [{ "label": "MRR", "value": 42000, "prefix": "$", "delta": -3.5, "suffix": "", "good": "up", "trend": [1, 2, 3] }] },
        { "kind": "form", "fields": [{ "label": "Launch date", "type": "date", "required": true }, { "label": "Plan", "type": "choice", "options": ["Pro", "Team"] }] },
        { "kind": "steps", "items": [{ "title": "Build", "status": "done" }, { "title": "Ship" }] },
        { "kind": "callout", "tone": "warning", "text": "Prices change Monday." }
    ]}))
    .unwrap();
    let v = stored(&set);
    let back: BlockSet = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(back, set);
    // Filled in: a numeric column, form ids and button, replies, statuses.
    assert_eq!(v["items"][0]["columns"][1]["numeric"], true);
    assert!(v["items"][0]["columns"][0].get("numeric").is_none());
    assert_eq!(v["items"][2]["fields"][0]["id"], "launch_date");
    assert_eq!(v["items"][2]["fields"][0]["type"], "date");
    assert_eq!(v["items"][2]["submit"], "Send");
    assert_eq!(v["items"][3]["items"][1]["status"], "todo");
    let choices = one(json!({ "kind": "choices", "options": ["Yes", { "label": "Not now", "reply": "Not now, thanks." }] })).unwrap();
    let c = stored(&choices);
    assert_eq!(c["items"][0]["options"][0]["reply"], "Yes");
    assert_eq!(c["items"][0]["options"][1]["reply"], "Not now, thanks.");
}

#[test]
fn unknown_kinds_and_missing_kinds_are_refused_with_the_list() {
    let e = one(json!({ "kind": "map", "places": [] })).unwrap_err();
    assert!(
        e.contains("no \"map\" block") && e.contains("chart, table"),
        "{e}"
    );
    let e = one(json!({ "type": "chart" })).unwrap_err();
    assert!(e.contains("has no `kind`"), "{e}");
    let e = parse(&json!({ "blocks": [] })).unwrap_err();
    assert!(e.contains("empty"), "{e}");
    let e = parse(&json!({ "text": "hi" })).unwrap_err();
    assert!(e.contains("`blocks` is required"), "{e}");
}

#[test]
fn html_is_refused_anywhere_but_code() {
    for block in [
        json!({ "kind": "callout", "text": "<b>Careful</b>" }),
        json!({ "kind": "facts", "items": [{ "label": "Owner", "value": "<img src=x onerror=alert(1)>" }] }),
        json!({ "kind": "chart", "chart": "bar", "labels": ["<script>"], "series": [{ "name": "a", "values": [1] }] }),
        json!({ "kind": "choices", "options": ["Yes", "<a href=x>No</a>"] }),
        json!({ "kind": "callout", "title": "</div>", "text": "x" }),
        json!({ "kind": "callout", "text": "x", "summary": "<!-- hi -->" }),
    ] {
        let e = one(block.clone()).unwrap_err();
        assert!(e.contains("no HTML"), "{block}: {e}");
    }
    // A lone "<" is fine, and code is shown verbatim.
    assert!(one(json!({ "kind": "callout", "text": "Latency < 200 ms, 3 <3" })).is_ok());
    assert!(
        one(json!({ "kind": "code", "language": "html", "code": "<div class=\"x\"></div>" }))
            .is_ok()
    );
}

#[test]
fn oversize_data_is_refused() {
    let many: Vec<i32> = (0..121).collect();
    let labels: Vec<String> = many.iter().map(|i| i.to_string()).collect();
    let e = one(json!({ "kind": "chart", "chart": "line", "labels": labels, "series": [{ "name": "a", "values": many }] })).unwrap_err();
    assert!(e.contains("too many"), "{e}");
    let bars: Vec<i32> = (0..41).collect();
    let bl: Vec<String> = bars.iter().map(|i| i.to_string()).collect();
    assert!(one(json!({ "kind": "chart", "chart": "bar", "labels": bl, "series": [{ "name": "a", "values": bars }] })).is_err());
    let rows: Vec<Value> = (0..201).map(|i| json!([i])).collect();
    let e = one(json!({ "kind": "table", "columns": ["n"], "rows": rows })).unwrap_err();
    assert!(e.contains("at most 200"), "{e}");
    let series: Vec<Value> = (0..9)
        .map(|i| json!({ "name": format!("s{i}"), "values": [1] }))
        .collect();
    assert!(
        one(json!({ "kind": "chart", "chart": "line", "labels": ["a"], "series": series }))
            .is_err()
    );
    let nine: Vec<Value> = (0..9)
        .map(|_| json!({ "kind": "callout", "text": "x" }))
        .collect();
    assert!(parse(&json!({ "blocks": nine }))
        .unwrap_err()
        .contains("at most 8"));
    let huge = "x".repeat(20_001);
    assert!(one(json!({ "kind": "code", "code": huge })).is_err());
    // Under each limit, but over the message's size.
    let wide = "y".repeat(19_000);
    let five: Vec<Value> = (0..6)
        .map(|_| json!({ "kind": "code", "code": wide }))
        .collect();
    let e = parse(&json!({ "blocks": five })).unwrap_err();
    assert!(e.contains("KB"), "{e}");
}

#[test]
fn a_chart_lines_up_its_values_with_its_labels() {
    let e = one(json!({ "kind": "chart", "chart": "line", "labels": ["a", "b"], "series": [{ "name": "x", "values": [1, 2, 3] }] })).unwrap_err();
    assert!(e.contains("one label per value"), "{e}");
    let e = one(json!({ "kind": "chart", "chart": "line", "labels": ["a", "b"], "series": [{ "name": "x", "values": [1, 2] }, { "name": "y", "values": [1] }] })).unwrap_err();
    assert!(e.contains("use null for a gap"), "{e}");
    let e = one(json!({ "kind": "chart", "chart": "line", "labels": ["a"], "series": [{ "name": "", "values": [1] }, { "name": "y", "values": [1] }] })).unwrap_err();
    assert!(e.contains("needs a `name`"), "{e}");
    let e = one(json!({ "kind": "chart", "chart": "pie", "labels": ["a", "b"], "series": [{ "name": "x", "values": [1, -2] }] })).unwrap_err();
    assert!(e.contains("negative"), "{e}");
    let e = one(json!({ "kind": "chart", "chart": "pie", "labels": ["a"], "series": [{ "name": "x", "values": [1] }, { "name": "y", "values": [1] }] })).unwrap_err();
    assert!(e.contains("one series"), "{e}");
    let e = one(json!({ "kind": "chart", "chart": "line", "labels": ["a"], "series": [{ "name": "x", "values": ["lots"] }] })).unwrap_err();
    assert!(e.contains("blocks[0] (chart)"), "{e}");
    // `values` alone is one series; a sparkline needs no labels.
    let set = one(
        json!({ "kind": "chart", "chart": "donut", "labels": ["Ads", "Search"], "values": [3, 7] }),
    )
    .unwrap();
    assert_eq!(
        stored(&set)["items"][0]["series"][0]["values"],
        json!([3.0, 7.0])
    );
    assert!(stored(&set)["items"][0].get("values").is_none());
    assert!(one(json!({ "kind": "chart", "chart": "sparkline", "values": [1, 3, 2] })).is_ok());
    // `stacked` only means something for bars and areas.
    let set = one(json!({ "kind": "chart", "chart": "line", "stacked": true, "labels": ["a"], "series": [{ "name": "x", "values": [1] }] })).unwrap();
    assert!(stored(&set)["items"][0].get("stacked").is_none());
}

#[test]
fn a_form_never_asks_for_a_secret() {
    for label in [
        "Password",
        "API key",
        "Your Stripe secret key",
        "GitHub token",
        "Card number",
        "CVV",
        "2FA code",
        "PIN",
    ] {
        let e = one(json!({ "kind": "form", "fields": [{ "label": label }] })).unwrap_err();
        assert!(e.contains("request_secret"), "{label}: {e}");
    }
    // Words that only contain those letters are fine.
    for label in [
        "Spinach preference",
        "Tokyo office",
        "Pinned post",
        "Secretary's name",
    ] {
        assert!(
            one(json!({ "kind": "form", "fields": [{ "label": label }] })).is_ok(),
            "{label}"
        );
    }
    let e = one(json!({ "kind": "form", "fields": [{ "label": "Plan", "type": "choice", "options": ["Pro"] }] })).unwrap_err();
    assert!(e.contains("at least 2"), "{e}");
    let e = one(json!({ "kind": "form", "fields": [{ "id": "a", "label": "A" }, { "id": "a", "label": "B" }] })).unwrap_err();
    assert!(e.contains("same") || e.contains("two fields"), "{e}");
}

#[test]
fn links_are_http_with_no_credentials_and_show_their_domain() {
    let set = one(json!({ "kind": "links", "items": [{ "url": "https://www.example.com/a?b=1" }, { "url": "http://docs.rs/serde", "label": "Serde docs" }] })).unwrap();
    let v = stored(&set);
    assert_eq!(v["items"][0]["items"][0]["domain"], "example.com");
    assert_eq!(v["items"][0]["items"][0]["label"], "example.com");
    assert_eq!(v["items"][0]["items"][1]["label"], "Serde docs");
    for bad in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://user:pw@evil.com/",
        "data:text/html,hi",
        "https://",
        "https://a b.com",
    ] {
        assert!(
            one(json!({ "kind": "links", "items": [{ "url": bad }] })).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn a_comparison_has_two_or_three_options_and_a_reply_each() {
    let set = one(json!({ "kind": "comparison", "options": [
        { "name": "Vercel", "pros": ["Fast"], "cons": ["Cost"], "recommended": true },
        { "name": "Netlify", "pros": [], "cons": [], "reply": "Netlify please" }
    ]}))
    .unwrap();
    let v = stored(&set);
    assert_eq!(
        v["items"][0]["options"][0]["reply"],
        "Let's go with Vercel."
    );
    assert_eq!(v["items"][0]["options"][1]["reply"], "Netlify please");
    assert!(v["items"][0]["summary"]
        .as_str()
        .unwrap()
        .contains("Vercel (recommended)"));
    assert!(one(json!({ "kind": "comparison", "options": [{ "name": "A" }] })).is_err());
    assert!(one(json!({ "kind": "comparison", "options": [{ "name": "A", "recommended": true }, { "name": "B", "recommended": true }] })).is_err());
    let four: Vec<Value> = (0..4).map(|i| json!({ "name": format!("O{i}") })).collect();
    assert!(one(json!({ "kind": "comparison", "options": four })).is_err());
}

#[test]
fn tables_pad_short_rows_and_refuse_long_ones() {
    let set =
        one(json!({ "kind": "table", "columns": ["a", "b"], "rows": [[1], ["x", ""]] })).unwrap();
    let v = stored(&set);
    assert_eq!(v["items"][0]["rows"][0], json!([1.0, null]));
    assert_eq!(v["items"][0]["rows"][1], json!(["x", null]));
    // Mixed: not numeric.
    assert!(v["items"][0]["columns"][0].get("numeric").is_none());
    let e = one(json!({ "kind": "table", "columns": ["a"], "rows": [[1, 2]] })).unwrap_err();
    assert!(e.contains("2 cells but there are 1 columns"), "{e}");
}

#[test]
fn images_name_a_path_and_their_file_is_attached_later() {
    let mut set =
        one(json!({ "kind": "image", "path": "chart.png", "caption": "The funnel" })).unwrap();
    assert_eq!(image_paths(&set), vec![(0, "chart.png".to_string())]);
    // The path is never stored: only the copied file.
    assert!(stored(&set)["items"][0].get("path").is_none());
    attach(
        &mut set,
        0,
        super::super::attachments::Attachment {
            name: "chart.png".into(),
            path: "attachments/m1/chart.png".into(),
            mime: "image/png".into(),
            size: 10,
        },
    );
    let v = stored(&set);
    assert_eq!(v["items"][0]["file"]["path"], "attachments/m1/chart.png");
    assert_eq!(v["items"][0]["summary"], "Image: The funnel (chart.png)");
    let five: Vec<Value> = (0..5)
        .map(|i| json!({ "kind": "image", "path": format!("{i}.png") }))
        .collect();
    assert!(parse(&json!({ "blocks": five }))
        .unwrap_err()
        .contains("at most 4"));
}

#[test]
fn the_agent_is_told_to_wait_after_asking_and_the_outside_mark_is_kept() {
    let mut set =
        one(json!({ "kind": "choices", "question": "Ship it?", "options": ["Yes", "No"] }))
            .unwrap();
    assert!(receipt(&set).contains("stop here and wait"));
    set.from_outside = true;
    assert_eq!(stored(&set)["fromOutside"], true);
    assert!(receipt(&set).contains("composer"));
    let quiet = one(json!({ "kind": "callout", "text": "All good" })).unwrap();
    assert!(!receipt(&quiet).contains("wait"));
}

#[test]
fn numbers_read_as_people_write_them() {
    assert_eq!(number(1284.0), "1,284");
    assert_eq!(number(12_900.0), "12.9K");
    assert_eq!(number(4_200_000.0), "4.2M");
    assert_eq!(number(3.5), "3.5");
    assert_eq!(number(0.125), "0.125");
    assert_eq!(number(-2500.0), "-2,500");
    assert_eq!(number(100_000.0), "100K");
}

#[test]
fn every_kind_has_a_summary() {
    let all = parse(&json!({ "blocks": [
        { "kind": "facts", "items": [{ "label": "Owner", "value": 3 }] },
        { "kind": "checklist", "items": [{ "text": "Domain", "done": true }, { "text": "DNS" }] },
        { "kind": "links", "items": [{ "url": "https://a.com" }] },
        { "kind": "code", "language": "diff", "code": "- a\n+ b" },
        { "kind": "form", "title": "Event", "fields": [{ "label": "Where" }] },
        { "kind": "metrics", "items": [{ "label": "Users", "value": "1.2K", "delta": "+4%", "vs": "vs May" }] },
        { "kind": "chart", "chart": "pie", "labels": ["a", "b"], "series": [{ "name": "x", "values": [1, 3] }] },
        { "kind": "steps", "items": [{ "title": "Plan", "status": "current" }] }
    ]}))
    .unwrap();
    let text = message_text(&all);
    for want in [
        "- Owner: 3",
        "- [x] Domain",
        "- [ ] DNS",
        "- https://a.com",
        "```diff\n- a\n+ b\n```",
        "Event — please reply with:\n- Where (optional)",
        "- Users: 1.2K (+4% vs May)",
        "- b: 3",
        "1. Plan (in progress)",
    ] {
        assert!(text.contains(want), "missing {want:?} in\n{text}");
    }
    // The agent's own summary wins.
    let own = one(json!({ "kind": "callout", "text": "x", "summary": "Mine." })).unwrap();
    assert_eq!(own.items[0].summary, "Mine.");
}

#[test]
fn a_block_from_a_newer_build_does_not_break_reading_the_message() {
    // Messages keep blocks as JSON: a kind this build doesn't know is just data.
    let raw = json!({
        "id": "m1", "agentId": "a1", "ts": 1, "kind": "agent", "text": "fallback",
        "blocks": { "v": 2, "items": [{ "kind": "hologram", "summary": "x" }] }
    });
    let m: super::super::store::AgentMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(m.text, "fallback");
    assert!(m.blocks.is_some());
}

#[test]
fn the_tool_is_described_with_every_kind() {
    for kind in KINDS {
        assert!(
            DESCRIPTION.contains(&format!("- {kind}:")),
            "{kind} missing from the description"
        );
    }
    let enums = schema()["properties"]["blocks"]["items"]["properties"]["kind"]["enum"].clone();
    assert_eq!(enums.as_array().unwrap().len(), KINDS.len());
}

#[test]
fn one_question_per_message() {
    let e = parse(&json!({ "blocks": [
        { "kind": "choices", "options": ["a", "b"] },
        { "kind": "form", "fields": [{ "label": "Name" }] }
    ]}))
    .unwrap_err();
    assert!(e.contains("One question per message"), "{e}");
}

/// Every engine's event for a `show` call reads as one (`is_call`), and
/// nothing else does: the runner folds the words after it only once it has
/// read that call, whichever engine wrote them.
#[test]
fn a_show_call_is_recognised_from_every_engines_events() {
    use super::super::codex_app::{self, Out};
    use super::super::opencode;
    use super::super::stream::{claude_steps, Step};
    use super::super::work::Action;
    let args =
        json!({ "blocks": [{ "kind": "choices", "question": "Which?", "options": ["A", "B"] }] });
    let actions = |steps: Vec<Step>| -> Vec<Action> {
        steps
            .into_iter()
            .filter_map(|s| match s {
                Step::Action(a) => Some(a),
                _ => None,
            })
            .collect()
    };
    let from_out = |out: Vec<Out>| -> Vec<Action> {
        actions(
            out.into_iter()
                .filter_map(|o| match o {
                    Out::Step(s) => Some(s),
                    _ => None,
                })
                .collect(),
        )
    };

    // Claude Code: an assistant tool_use.
    let claude = actions(claude_steps(
        &json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t1", "name": "mcp__app__show", "input": args }
        ]}}),
        0,
    ));
    // Codex on exec: the item as it starts.
    let exec = actions(super::super::codex::steps(
        &json!({ "type": "item.started", "item": {
            "id": "i1", "type": "mcp_tool_call", "server": "app", "tool": "show",
            "arguments": args, "status": "in_progress"
        }}),
    ));
    // Codex on app-server.
    let (mut app, _) =
        codex_app::Conversation::new(None, std::path::Path::new("/h/a"), None, "", "go", true);
    app.on_message(&json!({ "id": 2, "result": { "thread": { "id": "t1" } } }));
    app.on_message(&json!({ "id": 3, "result": { "turn": { "id": "u1" } } }));
    let app_server = from_out(
        app.on_message(&json!({ "method": "item/started", "params": {
            "threadId": "t1", "turnId": "u1",
            "item": { "id": "i1", "type": "mcpToolCall", "server": "app", "tool": "show",
                      "arguments": args, "status": "inProgress" }
        }})),
    );
    // OpenCode: `app_show`, named by its first update, whole once it runs.
    let (mut oc, _) = opencode::Conversation::new(
        None,
        std::path::Path::new("/h/agent"),
        "go",
        &[opencode::McpServer {
            name: "app".into(),
            url: "http://127.0.0.1:1/mcp/agent".into(),
        }],
        "s",
        opencode::Scope {
            writable: vec!["/h/agent".into()],
            read_only: Vec::new(),
        },
    );
    oc.on_message(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    oc.on_message(&json!({ "jsonrpc": "2.0", "id": 2, "result": { "sessionId": "ses_1" } }));
    let update = |u: Value| {
        json!({ "jsonrpc": "2.0", "method": "session/update",
                "params": { "sessionId": "ses_1", "update": u } })
    };
    let mut open_code = from_out(oc.on_message(&update(json!({
        "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "app_show",
        "kind": "other", "status": "pending", "rawInput": {}
    }))));
    open_code.extend(from_out(oc.on_message(&update(json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "c1", "title": "app_show",
        "kind": "other", "status": "in_progress", "rawInput": args
    })))));

    for (engine, got) in [
        ("Claude Code", claude),
        ("Codex exec", exec),
        ("Codex app-server", app_server),
        ("OpenCode", open_code),
    ] {
        assert_eq!(got.len(), 1, "{engine}: {got:?}");
        assert!(is_call(&got[0]), "{engine}: {:?}", got[0].exact);
    }

    // Anything else isn't: another of the app's tools, a command naming it.
    let other = actions(claude_steps(
        &json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t2", "name": "mcp__app__share_result", "input": {} },
            { "type": "tool_use", "id": "t3", "name": "Bash",
              "input": { "command": "echo mcp__app__show" } }
        ]}}),
        0,
    ));
    assert_eq!(other.len(), 2);
    assert!(other.iter().all(|a| !is_call(a)), "{other:?}");
}
