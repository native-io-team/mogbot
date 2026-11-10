use super::*;

fn scope(root: &str) -> Scope {
    Scope {
        writable: vec![PathBuf::from(root)],
        read_only: vec![PathBuf::from(format!("{root}/kept"))],
    }
}

fn convo(session: Option<&str>) -> (Conversation, Value) {
    Conversation::new(
        session,
        Path::new("/h/agent"),
        "hello",
        &[McpServer {
            name: "app".into(),
            url: "http://127.0.0.1:1/mcp/agent".into(),
        }],
        "s3cret",
        scope("/h/agent"),
    )
}

fn sent(out: &[Out]) -> Vec<Value> {
    out.iter()
        .filter_map(|o| match o {
            Out::Send(v) => Some(v.clone()),
            _ => None,
        })
        .collect()
}

fn steps(out: &[Out]) -> Vec<Step> {
    out.iter()
        .filter_map(|o| match o {
            Out::Step(s) => Some(s.clone()),
            _ => None,
        })
        .collect()
}

fn update(session: &str, update: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": session, "update": update } })
}

/// Through initialize and session/new, to the first prompt.
fn started() -> Conversation {
    let (mut c, first) = convo(None);
    assert_eq!(first["method"], "initialize");
    let out =
        c.on_message(&json!({ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": 1 } }));
    assert_eq!(sent(&out)[0]["method"], "session/new");
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 2, "result": {
        "sessionId": "ses_1",
        "configOptions": [{ "id": "model", "currentValue": "opencode/big-pickle" }],
    }}));
    let st = steps(&out);
    assert!(st.contains(&Step::Session("ses_1".into())));
    assert!(st.contains(&Step::Model("opencode/big-pickle".into())));
    let prompt = &sent(&out)[0];
    assert_eq!(prompt["method"], "session/prompt");
    assert_eq!(prompt["params"]["prompt"][0]["text"], "hello");
    c
}

#[test]
fn the_secret_goes_over_stdin_in_session_new_and_never_in_the_config() {
    let (mut c, _) = convo(None);
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    let new = &sent(&out)[0];
    assert_eq!(new["params"]["mcpServers"][0]["name"], "app");
    assert_eq!(
        new["params"]["mcpServers"][0]["headers"][0]["value"],
        "Bearer s3cret"
    );
    let config = config(
        Some("ollama/llama3.2"),
        &[PathBuf::from("/t/p.md")],
        &["linear".into()],
    );
    assert!(!config.contains("s3cret"));
    assert!(args().iter().all(|a| !a.contains("s3cret")));
    let config: Value = serde_json::from_str(&config).unwrap();
    assert_eq!(config["model"], "ollama/llama3.2");
    assert_eq!(config["share"], "disabled");
    assert_eq!(config["instructions"][0], "/t/p.md");
}

#[test]
fn everything_that_acts_asks_and_git_folders_are_denied_in_the_config() {
    let p = permissions(&["linear".into()]);
    assert_eq!(p["*"], "ask");
    for asked in ["bash", "webfetch", "websearch", "external_directory"] {
        assert_eq!(p[asked], "ask", "{asked}");
    }
    assert_eq!(p["edit"]["*"], "ask");
    assert_eq!(p["edit"]["**/.git/**"], "deny");
    assert_eq!(p["edit"]["**/.shipstudio/**"], "deny");
    assert_eq!(p["task"], "deny");
    assert_eq!(p["read"], "allow");
    // Our own tools and the given servers decide their own calls.
    assert_eq!(p["app_*"], "allow");
    assert_eq!(p["linear_*"], "allow");
    // The `build` agent carries the same rules, so a user's own can't loosen them.
    let config: Value = serde_json::from_str(&config(None, &[], &[])).unwrap();
    assert_eq!(config["agent"]["build"]["permission"]["bash"], "ask");
    assert_eq!(config["default_agent"], "build");
    assert!(env(String::new())
        .iter()
        .any(|(k, v)| *k == "OPENCODE_DISABLE_PROJECT_CONFIG" && v == "1"));
}

#[test]
fn a_reply_streams_as_a_draft_and_the_turn_ends_with_its_tokens() {
    let mut c = started();
    let chunk = |t: &str| {
        update(
            "ses_1",
            json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": { "type": "text", "text": t } }),
        )
    };
    let out = c.on_message(&chunk("Hel"));
    assert_eq!(out[0], Out::DraftOpen);
    assert_eq!(out[1], Out::DraftDelta("Hel".into()));
    c.on_message(&chunk("lo"));
    let out = c.on_message(&update(
        "ses_1",
        json!({ "sessionUpdate": "usage_update", "used": 15160, "size": 200000 }),
    ));
    assert!(
        matches!(steps(&out)[0], Step::Context(ref f) if f.used == 15160 && f.window == 200000)
    );
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 3, "result": {
        "stopReason": "end_turn",
        "usage": { "inputTokens": 85, "outputTokens": 11, "thoughtTokens": 4, "cachedReadTokens": 15744 },
    }}));
    let st = steps(&out);
    assert_eq!(st[0], Step::Reply("Hello".into()));
    let Step::Usage(u) = &st[1] else {
        panic!("{st:?}")
    };
    assert_eq!(
        (u.input_tokens, u.output_tokens, u.cache_read_tokens),
        (85, 15, 15744)
    );
    assert_eq!(u.cost_usd, 0.0, "OpenCode's estimate isn't a bill");
    assert!(st.contains(&Step::Done));
    assert!(out.contains(&Out::Close));
    assert!(c.over());
}

#[test]
fn a_loaded_conversation_replays_its_history_and_none_of_it_is_this_turn() {
    let (mut c, _) = convo(Some("ses_old"));
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    assert_eq!(sent(&out)[0]["method"], "session/load");
    assert_eq!(sent(&out)[0]["params"]["sessionId"], "ses_old");
    let replay = c.on_message(&update(
        "ses_old",
        json!({ "sessionUpdate": "agent_message_chunk", "messageId": "old", "content": { "type": "text", "text": "said before" } }),
    ));
    assert!(replay.is_empty());
    let out =
        c.on_message(&json!({ "jsonrpc": "2.0", "id": 2, "result": { "configOptions": [] } }));
    assert!(steps(&out).contains(&Step::Session("ses_old".into())));
    assert_eq!(sent(&out)[0]["method"], "session/prompt");
}

#[test]
fn a_conversation_it_cant_load_is_said_as_a_lost_session() {
    let (mut c, _) = convo(Some("ses_gone"));
    c.on_message(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 2, "error": { "code": -32603, "message": "Internal error: OpenCode service failure" } }));
    let st = steps(&out);
    assert!(matches!(&st[0], Step::Failed(m) if m.to_lowercase().contains("session not found")));
    assert!(c.over());
}

#[test]
fn tool_calls_read_as_claude_codes_on_the_timeline() {
    let mut c = started();
    c.on_message(&update(
        "ses_1",
        json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "bash", "kind": "execute", "status": "pending", "rawInput": {} }),
    ));
    let out = c.on_message(&update(
        "ses_1",
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "ls", "status": "in_progress", "rawInput": { "command": "ls" },
                "content": [{ "type": "content", "content": { "type": "text", "text": "a\n" } }] }),
    ));
    let st = steps(&out);
    let Step::Action(a) = &st[0] else {
        panic!("{st:?}")
    };
    assert_eq!(a.id.as_deref(), Some("t1"));
    assert_eq!(a.command.as_deref(), Some("ls"));
    assert_eq!(
        st[1],
        Step::Output {
            id: "t1".into(),
            text: "a\n".into()
        }
    );
    // Output arrives whole each time: only what's new goes on.
    let out = c.on_message(&update(
        "ses_1",
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress", "rawInput": { "command": "ls" },
                "content": [{ "type": "content", "content": { "type": "text", "text": "a\nb\n" } }] }),
    ));
    assert_eq!(
        steps(&out),
        vec![Step::Output {
            id: "t1".into(),
            text: "b\n".into()
        }]
    );
    let out = c.on_message(&update(
        "ses_1",
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                "rawOutput": { "output": "a\nb\n", "metadata": { "exit": 1 } } }),
    ));
    let Step::Result(r) = &steps(&out)[0] else {
        panic!()
    };
    assert_eq!(r.outcome, crate::agents::work::Outcome::Failed);
    assert_eq!(
        c.take_calls(),
        vec![("Bash".to_string(), json!({ "command": "ls" }))]
    );
}

fn ask(c: &mut Conversation, call: &str, kind: &str, input: Value) -> Asked {
    let out = c.on_message(
        &json!({ "jsonrpc": "2.0", "id": 0, "method": "session/request_permission", "params": {
            "sessionId": "ses_1",
            "toolCall": { "toolCallId": call, "kind": kind, "rawInput": input },
            "options": [],
        }}),
    );
    match &out[0] {
        Out::AskOpenCode(a) => a.what.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn every_ask_becomes_the_decision_a_claude_code_call_gets() {
    let mut c = started();
    assert_eq!(
        ask(&mut c, "x", "execute", json!({ "command": "rm -rf /" })),
        Asked::Decide {
            tool: "Bash".into(),
            input: json!({ "command": "rm -rf /" })
        }
    );
    // An edit where it may write goes through, as acceptEdits does.
    assert_eq!(
        ask(
            &mut c,
            "x",
            "edit",
            json!({ "filepath": "/h/agent/notes.md", "diff": "" })
        ),
        Asked::Allow
    );
    // Git's and the app's folders, and what its settings keep, are refused.
    assert!(matches!(
        ask(
            &mut c,
            "x",
            "edit",
            json!({ "filepath": "/h/agent/sub/.git/hooks/pre-commit", "diff": "" })
        ),
        Asked::Refuse(_)
    ));
    assert!(matches!(
        ask(
            &mut c,
            "x",
            "edit",
            json!({ "filepath": "/h/agent/../agent/kept/a.txt", "diff": "" })
        ),
        Asked::Refuse(_)
    ));
    // Elsewhere asks like Claude Code's edit outside its folders.
    assert_eq!(
        ask(
            &mut c,
            "x",
            "edit",
            json!({ "filepath": "/etc/hosts", "diff": "" })
        ),
        Asked::Decide {
            tool: "Edit".into(),
            input: json!({ "file_path": "/etc/hosts" })
        }
    );
    // A folder outside its own: a read the rules decide.
    assert_eq!(
        ask(
            &mut c,
            "x",
            "other",
            json!({ "filepath": "/etc/hosts", "parentDir": "/etc" })
        ),
        Asked::Decide {
            tool: "Read".into(),
            input: json!({ "file_path": "/etc/hosts" })
        }
    );
    assert_eq!(
        ask(
            &mut c,
            "x",
            "fetch",
            json!({ "url": "https://example.com" })
        ),
        Asked::Decide {
            tool: "WebFetch".into(),
            input: json!({ "url": "https://example.com" })
        }
    );
    // A user's own MCP tool, named as Claude Code names it.
    c.on_message(&update(
        "ses_1",
        json!({ "sessionUpdate": "tool_call", "toolCallId": "m1", "title": "app_send_message", "kind": "other", "status": "pending", "rawInput": {} }),
    ));
    assert_eq!(
        ask(&mut c, "m1", "other", json!({ "text": "yo" })),
        Asked::Decide {
            tool: "mcp__app__send_message".into(),
            input: json!({ "text": "yo" })
        }
    );
    // Nothing it can name: refused, never allowed blind.
    assert!(matches!(
        ask(&mut c, "?", "other", json!({})),
        Asked::Refuse(_)
    ));
}

#[test]
fn what_a_rejected_call_is_told_goes_as_the_next_prompt() {
    let mut c = started();
    c.gate()
        .reject(c.round(), "[Note from the app: the user said no]".into());
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 3, "result": { "stopReason": "end_turn", "usage": { "inputTokens": 5 } } }));
    let next = sent(&out);
    assert_eq!(next[0]["method"], "session/prompt");
    assert_eq!(next[0]["id"], 4);
    assert!(next[0]["params"]["prompt"][0]["text"]
        .as_str()
        .unwrap()
        .contains("said no"));
    assert!(!c.over());
    // A later ask in the new round isn't refused by the old one's reject.
    assert!(!c.gate().rejected(c.round()));
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 4, "result": { "stopReason": "end_turn", "usage": { "inputTokens": 2 } } }));
    let Step::Usage(u) = &steps(&out)[0] else {
        panic!()
    };
    assert_eq!(
        (u.turns, u.input_tokens),
        (1, 7),
        "one turn, both rounds' tokens"
    );
    assert!(c.over());
}

#[test]
fn stop_cancels_and_a_cancelled_turn_never_follows_up() {
    let mut c = started();
    let cancel = c.interrupt().unwrap();
    assert_eq!(cancel["method"], "session/cancel");
    assert!(cancel.get("id").is_none(), "a notification");
    c.gate().reject(c.round(), "[Note]".into());
    let out = c.on_message(
        &json!({ "jsonrpc": "2.0", "id": 3, "result": { "stopReason": "cancelled", "usage": {} } }),
    );
    assert!(sent(&out).is_empty());
    assert!(c.over());
    assert!(c.interrupt().is_none());
}

#[test]
fn requests_it_makes_of_a_client_are_refused() {
    let mut c = started();
    let out = c.on_message(&json!({ "jsonrpc": "2.0", "id": 9, "method": "fs/write_text_file", "params": { "path": "/x", "content": "y" } }));
    assert_eq!(sent(&out)[0]["error"]["code"], -32601);
}

#[test]
fn models_are_listed_as_opencode_lists_them_and_only_loopback_ones_are_local() {
    let listed = r#"opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "api": { "id": "big-pickle", "url": "https://opencode.ai/zen/v1" }
}
ollama/llama3.2
{
  "id": "llama3.2",
  "api": { "id": "llama3.2", "url": "" },
  "name": "Llama 3.2",
  "providerID": "ollama"
}
lmstudio/qwen
{
  "name": "Qwen",
  "api": { "url": "http://127.0.0.1:1234/v1" }
}
--evil/model
{}
"#;
    let config = r#"{ "provider": { "ollama": { "options": { "baseURL": "http://localhost:11434/v1" } } } }"#;
    let models = parse_models(listed, config);
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        ["opencode/big-pickle", "ollama/llama3.2", "lmstudio/qwen"]
    );
    assert_eq!(
        models.iter().map(|m| m.local).collect::<Vec<_>>(),
        [false, true, true]
    );
    assert_eq!(label(&models[0]), "Big Pickle · opencode");
    assert_eq!(label(&models[1]), "Llama 3.2 · on this Mac");
    assert!(is_loopback_url("http://[::1]:8080/v1"));
    assert!(!is_loopback_url("https://localhost.example.com/v1"));
    assert!(!is_loopback_url("not a url"));
}

#[test]
fn instructions_are_the_prompt_then_the_folders_own_file() {
    let dir = tempfile::tempdir().unwrap();
    let prompt = dir.path().join("p.md");
    assert_eq!(instruction_files(&prompt, dir.path()), vec![prompt.clone()]);
    std::fs::write(dir.path().join("CLAUDE.md"), "memory").unwrap();
    assert_eq!(
        instruction_files(&prompt, dir.path()),
        vec![prompt.clone(), dir.path().join("CLAUDE.md")]
    );
    std::fs::write(dir.path().join("AGENTS.md"), "rules").unwrap();
    assert_eq!(
        instruction_files(&prompt, dir.path())[1],
        dir.path().join("AGENTS.md")
    );
}

/// OpenCode 1.18.29's own output for a turn (`testdata/opencode-acp.jsonl`):
/// what it says becomes the same steps a Claude Code turn gives.
#[test]
fn a_real_turn_reads_as_a_session_a_step_an_ask_a_reply_and_its_tokens() {
    let raw = include_str!("testdata/opencode-acp.jsonl");
    let (mut c, _) = Conversation::new(None, Path::new("/w"), "x", &[], "s", scope("/w"));
    let mut outs = Vec::new();
    for line in raw.lines() {
        let value: Value = serde_json::from_str(line).unwrap();
        if value.get("sent").is_some() {
            continue;
        }
        outs.extend(c.on_message(&value));
    }
    let st = steps(&outs);
    assert!(matches!(&st[0], Step::Session(s) if s.starts_with("ses_")));
    assert!(st
        .iter()
        .any(|s| matches!(s, Step::Action(a) if a.command.as_deref() == Some("echo hi"))));
    assert!(outs.iter().any(|o| matches!(o, Out::AskOpenCode(a)
        if a.what == Asked::Decide { tool: "Bash".into(), input: json!({ "command": "echo hi" }) })));
    assert!(st
        .iter()
        .any(|s| matches!(s, Step::Result(r) if r.outcome == crate::agents::work::Outcome::Done)));
    assert!(st
        .iter()
        .any(|s| matches!(s, Step::Reply(t) if !t.is_empty())));
    assert!(st
        .iter()
        .any(|s| matches!(s, Step::Context(f) if f.used == 15197)));
    assert!(st
        .iter()
        .any(|s| matches!(s, Step::Usage(u) if u.input_tokens == 93 && u.output_tokens == 31)));
    assert_eq!(st.last(), Some(&Step::Done));
    assert!(c.over());
}

#[test]
fn mcp_names_split_on_the_longest_server_it_has() {
    let servers = vec!["my_db".to_string(), "my".to_string()];
    assert_eq!(
        as_claude("my_db_query", &json!({}), &servers).0,
        "mcp__my_db__query"
    );
    assert_eq!(as_claude("my_x", &json!({}), &servers).0, "mcp__my__x");
    assert_eq!(
        as_claude("app_create_agent", &json!({}), &servers).0,
        "mcp__app__create_agent"
    );
    assert_eq!(
        as_claude("bash", &json!({ "command": "ls" }), &[]).1,
        json!({ "command": "ls" })
    );
}
