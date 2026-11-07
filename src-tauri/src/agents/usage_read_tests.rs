//! Reading accounts without a turn. No test calls a real endpoint: Claude's
//! usage answer is served by a loopback stand-in, and Codex is a script
//! that answers like its app-server.

use super::*;
use crate::agents::store;

const NOW: i64 = 1_793_998_000_000;

fn this_mac(engine: Engine) -> Account {
    Account {
        id: wallet::THIS_MAC.into(),
        engine,
        name: "This Mac".into(),
        added_at: 0,
        limit: None,
    }
}

/* ------------------------------------------------------------ Claude */

#[test]
fn claude_codes_keychain_item_is_named_as_claude_code_names_it() {
    assert_eq!(claude_service(None), "Claude Code-credentials");
    // sha256("/Users/someone/.dashbot/accounts/abc/claude") starts c5533c0f.
    let dir = Path::new("/Users/someone/.dashbot/accounts/abc/claude");
    assert_eq!(
        claude_service(Some(dir)),
        "Claude Code-credentials-c5533c0f"
    );
}

#[test]
fn credentials_are_read_only_from_a_claude_ai_sign_in_and_never_printed() {
    // The shape of Claude Code's real item (values made up).
    let raw = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET","refreshToken":"sk-ant-ort01-OTHER","expiresAt":1794000000000,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}"#;
    let login = parse_claude_credentials(raw).unwrap();
    assert_eq!(login.expires_at, Some(1_794_000_000_000));
    assert_eq!(login.plan.as_deref(), Some("max"));
    let shown = format!("{login:?}");
    assert!(!shown.contains("SECRET") && shown.contains("<redacted>"));
    // The same item holding only MCP sign-ins (as on this Mac's other user): none.
    assert!(parse_claude_credentials(r#"{"mcpOAuth":{"x":{"accessToken":"t"}}}"#).is_none());
    assert!(parse_claude_credentials("not json").is_none());
    assert!(parse_claude_credentials(r#"{"claudeAiOauth":{"accessToken":""}}"#).is_none());
}

#[test]
fn reads_claudes_real_usage_answer() {
    // A real answer from a Max sign-in, trimmed after `limits`.
    let body = include_str!("testdata/claude-oauth-usage.json");
    let Answer::Read(q) = claude_answer(200, body, Some("max".into()), NOW) else {
        panic!("expected a reading");
    };
    assert_eq!(q.engine, Engine::Claude);
    assert_eq!(q.plan.as_deref(), Some("max"));
    let kinds: Vec<&str> = q.windows.iter().map(|w| w.kind.as_str()).collect();
    // Windows that are `null` (Opus, Sonnet here) aren't readings.
    assert_eq!(kinds, ["five_hour", "seven_day"]);
    let five = &q.windows[0];
    assert_eq!(five.used_percent, Some(7.0));
    // 2026-11-07T00:29:59.975226Z
    assert_eq!(five.resets_at, Some(1_794_011_399_975));
    assert!(!five.limited);
    assert_eq!(five.observed_at, NOW);
    assert_eq!(q.windows[1].used_percent, Some(65.0));
}

#[test]
fn a_used_up_window_is_limited_and_nothing_named_is_no_plan() {
    let body = r#"{"five_hour":{"utilization":100.0,"resets_at":"2026-11-07T00:30:00Z"},"seven_day":null}"#;
    let Answer::Read(q) = claude_answer(200, body, None, NOW) else {
        panic!()
    };
    assert!(q.windows[0].limited);
    assert_eq!(
        super::super::quota::limited_until(&[q], Engine::Claude, NOW),
        Some(1_794_011_400_000)
    );
    assert_eq!(
        claude_answer(200, r#"{"five_hour":null,"seven_day":null}"#, None, NOW),
        Answer::NoPlan
    );
    assert!(matches!(
        claude_answer(200, "<html>", None, NOW),
        Answer::Failed(_)
    ));
}

#[test]
fn refusals_say_why_and_never_count_as_readings() {
    // The real refusal of a `claude setup-token` token.
    let scope = r#"{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile","details":{"required_scopes":["user:profile"],"error_code":"oauth_scope_insufficient"}}}"#;
    assert_eq!(
        claude_answer(403, scope, None, NOW),
        Answer::CantRead(NO_SCOPE.into())
    );
    assert!(matches!(
        claude_answer(401, "", None, NOW),
        Answer::CantRead(_)
    ));
    assert!(matches!(
        claude_answer(403, "{}", None, NOW),
        Answer::CantRead(_)
    ));
    assert!(matches!(
        claude_answer(429, "", None, NOW),
        Answer::Failed(_)
    ));
    assert!(matches!(
        claude_answer(503, "", None, NOW),
        Answer::Failed(_)
    ));
}

/// A loopback stand-in for the usage endpoint: answers one request with
/// `status` and `body`, and hands back the request it got.
async fn stand_in(
    status: u16,
    extra: &str,
    body: &str,
) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
    let reply = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{extra}connection: close\r\n\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap();
        sock.write_all(reply.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&buf[..n]).to_string()
    });
    (url, task)
}

#[tokio::test]
async fn the_request_carries_the_token_as_a_header_only() {
    let body = include_str!("testdata/claude-oauth-usage.json");
    let (url, request) = stand_in(200, "", body).await;
    let (status, got) = claude_get(&url, "tok-123").await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(got, body);
    let request = request.await.unwrap().to_lowercase();
    assert!(request.starts_with("get /api/oauth/usage http/1.1"));
    assert!(request.contains("authorization: bearer tok-123"));
    assert!(request.contains("anthropic-beta: oauth-2025-04-20"));
}

#[tokio::test]
async fn a_redirect_is_not_followed_with_the_token() {
    let (url, request) = stand_in(302, "location: http://127.0.0.1:9/steal\r\n", "").await;
    let (status, _) = claude_get(&url, "tok-123").await.unwrap();
    assert_eq!(status, 302, "answered as is, never followed");
    let _ = request.await;
    assert!(matches!(
        claude_answer(status, "", None, NOW),
        Answer::Failed(_)
    ));
}

#[tokio::test]
async fn an_unreachable_endpoint_fails_without_echoing_anything() {
    // Nothing listens on port 9 here.
    let err = claude_get("http://127.0.0.1:9/api/oauth/usage", "tok-123")
        .await
        .unwrap_err();
    assert!(!err.contains("tok-123") && !err.contains("127.0.0.1"));
}

/* ------------------------------------------------------------- Codex */

#[test]
fn codex_is_asked_only_for_its_limits() {
    let lines = codex_requests();
    let methods: Vec<&str> = lines.iter().filter_map(|l| l["method"].as_str()).collect();
    assert_eq!(
        methods,
        ["initialize", "initialized", "account/rateLimits/read"]
    );
    // Never a thread or a turn.
    assert!(!methods
        .iter()
        .any(|m| m.starts_with("thread/") || m.starts_with("turn/")));
}

#[test]
fn reads_codexs_answers() {
    // Real lines from 0.166, signed out.
    assert_eq!(
        codex_answer(
            r#"{"error":{"code":-32600,"message":"codex account authentication required to read rate limits"},"id":2}"#,
            NOW
        ),
        Some(Answer::CantRead("Not signed in".into()))
    );
    assert_eq!(
        codex_answer(
            r#"{"id":1,"result":{"userAgent":"x","codexHome":"/Users/x/.codex"}}"#,
            NOW
        ),
        None
    );
    assert_eq!(
        codex_answer(
            r#"{"method":"remoteControl/status/changed","params":{}}"#,
            NOW
        ),
        None
    );
    // The schema's shape, with figures.
    let read = r#"{"id":2,"result":{"rateLimits":{"limitId":"codex","planType":"plus","primary":{"usedPercent":40,"windowDurationMins":300,"resetsAt":1794063600},"secondary":{"usedPercent":12,"windowDurationMins":10080,"resetsAt":1794500000}}}}"#;
    let Some(Answer::Read(q)) = codex_answer(read, NOW) else {
        panic!()
    };
    assert_eq!(q.plan.as_deref(), Some("plus"));
    assert_eq!(q.windows.len(), 2);
    assert_eq!(q.windows[0].used_percent, Some(40.0));
    // An API-key login: no windows.
    assert_eq!(
        codex_answer(
            r#"{"id":2,"result":{"rateLimits":{"limitId":"codex"}}}"#,
            NOW
        ),
        Some(Answer::NoPlan)
    );
    assert!(matches!(
        codex_answer(r#"{"id":2,"error":{"message":"unknown method"}}"#, NOW),
        Some(Answer::Failed(_))
    ));
}

#[cfg(unix)]
fn fake_codex(dir: &Path, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("codex");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_is_spoken_to_and_left() {
    let dir = tempfile::tempdir().unwrap();
    // Answers once it has read all three lines, then lingers like the real one.
    let bin = fake_codex(
        dir.path(),
        r#"[ "$1" = "app-server" ] || exit 3
read a; read b; read c
case "$c" in *account/rateLimits/read*) ;; *) exit 4 ;; esac
echo '{"id":1,"result":{}}'
echo '{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":91,"windowDurationMins":300,"resetsAt":1794063600}}}}'
sleep 30"#,
    );
    let started = std::time::Instant::now();
    let answer = read_codex(&bin, &this_mac(Engine::Codex), NOW).await;
    let Answer::Read(q) = answer else {
        panic!("{answer:?}")
    };
    assert_eq!(q.windows[0].used_percent, Some(91.0));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "not left waiting"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_codex_that_closes_without_answering_fails() {
    let dir = tempfile::tempdir().unwrap();
    let bin = fake_codex(dir.path(), "exit 0");
    assert!(matches!(
        read_codex(&bin, &this_mac(Engine::Codex), NOW).await,
        Answer::Failed(_)
    ));
}

/* ---------------------------------------------------------- recording */

#[test]
fn a_reading_is_the_accounts_own_and_a_refusal_keeps_what_was_read() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let mac = this_mac(Engine::Claude);
    let body = include_str!("testdata/claude-oauth-usage.json");
    let Answer::Read(q) = claude_answer(200, body, None, NOW) else {
        panic!()
    };
    assert!(record(&mac, Answer::Read(q), 1, NOW));
    let (readings, samples) = usage_plan::readings();
    assert_eq!(readings["claude:default"].windows.len(), 2);
    assert_eq!(
        samples["claude:default"].len(),
        2,
        "a sample per window, for its pace"
    );
    // The lone account's reading is the engine's picture too.
    assert_eq!(super::super::quota::load()[0].windows.len(), 2);
    assert_eq!(
        usage_plan::checks()["claude:default"].outcome,
        CheckOutcome::Read
    );

    // Later it can't be read: said so, and the reading stays.
    assert!(record(
        &mac,
        Answer::CantRead("Not signed in".into()),
        1,
        NOW + 1
    ));
    assert!(
        !record(&mac, Answer::CantRead("Not signed in".into()), 1, NOW + 2),
        "no news"
    );
    let (readings, _) = usage_plan::readings();
    assert_eq!(readings["claude:default"].windows.len(), 2);
    let check = &usage_plan::checks()["claude:default"];
    assert_eq!(check.outcome, CheckOutcome::CantRead);
    assert_eq!(check.why.as_deref(), Some("Not signed in"));
    store::set_root_for_tests(None);
}

#[test]
fn another_accounts_reading_never_becomes_the_engines() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let work = Account {
        id: "w1".into(),
        ..this_mac(Engine::Claude)
    };
    let body = r#"{"five_hour":{"utilization":50.0,"resets_at":"2026-11-07T00:30:00Z"}}"#;
    let Answer::Read(q) = claude_answer(200, body, None, NOW) else {
        panic!()
    };
    // Two accounts, and none recorded as the engine's: Work's stays its own.
    record(&work, Answer::Read(q), 2, NOW);
    assert!(super::super::quota::load().is_empty());
    assert_eq!(
        usage_plan::readings().0["claude:w1"].windows[0].used_percent,
        Some(50.0)
    );
    store::set_root_for_tests(None);
}

#[test]
fn a_scope_refusal_is_asked_again_only_now_and_then() {
    let refused = |at| Check {
        at,
        outcome: CheckOutcome::CantRead,
        why: Some(NO_SCOPE.into()),
        via: None,
    };
    assert!(skip(Some(&refused(NOW - 60_000)), NOW));
    assert!(!skip(Some(&refused(NOW - 7 * 60 * 60 * 1000)), NOW));
    let other = Check {
        why: Some("Not signed in".into()),
        ..refused(NOW)
    };
    assert!(!skip(Some(&other), NOW));
    assert!(!skip(None, NOW));
}

/* ------------------------------------------- a setup token, by headers */

fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn a_setup_token_is_read_from_its_rate_limit_headers() {
    // The header names a real setup-token answer carried (429, at its weekly
    // limit); the values are made up.
    let at_limit = h(&[
        ("anthropic-ratelimit-unified-7d-utilization", "1.0"),
        ("anthropic-ratelimit-unified-7d-reset", "1794200000"),
        ("anthropic-ratelimit-unified-7d-status", "rejected"),
        ("anthropic-ratelimit-unified-status", "rejected"),
    ]);
    let Answer::ReadHeaders(q) = claude_headers_answer(429, &at_limit, NOW) else {
        panic!("a 429 with headers is a reading");
    };
    assert_eq!(q.windows.len(), 1);
    let w = &q.windows[0];
    assert_eq!(w.kind, "seven_day");
    assert_eq!(w.used_percent, Some(100.0));
    assert_eq!(w.resets_at, Some(1_794_200_000_000));
    assert!(w.limited);

    let allowed = h(&[
        ("anthropic-ratelimit-unified-5h-utilization", "0.07"),
        ("anthropic-ratelimit-unified-5h-reset", "1794010000"),
        ("anthropic-ratelimit-unified-5h-status", "allowed"),
        ("anthropic-ratelimit-unified-7d-utilization", "0.5"),
        ("anthropic-ratelimit-unified-7d-reset", "1794200000"),
        ("anthropic-ratelimit-unified-7d-status", "allowed_warning"),
    ]);
    let Answer::ReadHeaders(q) = claude_headers_answer(200, &allowed, NOW) else {
        panic!("a reading");
    };
    let kinds: Vec<&str> = q.windows.iter().map(|w| w.kind.as_str()).collect();
    assert_eq!(kinds, ["five_hour", "seven_day"]);
    assert!((q.windows[0].used_percent.unwrap() - 7.0).abs() < 1e-9);
    assert!(q.windows.iter().all(|w| !w.limited));
}

#[test]
fn a_header_read_without_headers_says_why() {
    assert_eq!(
        claude_headers_answer(403, &[], NOW),
        Answer::CantRead(NO_SCOPE.into())
    );
    assert!(matches!(
        claude_headers_answer(401, &[], NOW),
        Answer::CantRead(_)
    ));
    assert!(matches!(
        claude_headers_answer(429, &[], NOW),
        Answer::Failed(_)
    ));
    // A figure that isn't one is no reading.
    let junk = h(&[("anthropic-ratelimit-unified-7d-utilization", "lots")]);
    assert!(matches!(
        claude_headers_answer(200, &junk, NOW),
        Answer::Failed(_)
    ));
}

#[test]
fn a_header_reading_is_marked_and_asked_again_only_every_half_hour() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let personal = Account {
        id: "p1".into(),
        engine: Engine::Claude,
        name: "Personal".into(),
        added_at: 0,
        limit: None,
    };
    let headers = h(&[
        ("anthropic-ratelimit-unified-7d-utilization", "0.25"),
        ("anthropic-ratelimit-unified-7d-reset", "1794200000"),
    ]);
    let answer = claude_headers_answer(200, &headers, NOW);
    assert!(record(&personal, answer, 2, NOW));
    let check = usage_plan::checks()["claude:p1"].clone();
    assert_eq!(check.outcome, CheckOutcome::Read);
    assert_eq!(check.via, Some(CheckVia::Headers));
    assert_eq!(
        usage_plan::readings().0["claude:p1"].windows[0].used_percent,
        Some(25.0)
    );
    assert!(skip(Some(&check), NOW + 10 * 60 * 1000));
    assert!(!skip(Some(&check), NOW + 31 * 60 * 1000));
    // An ordinary reading is asked again every time.
    let plain = Check { via: None, ..check };
    assert!(!skip(Some(&plain), NOW + 60_000));
    store::set_root_for_tests(None);
}
