//! `<binary> mcp user-chrome`: the user's Chrome as a stdio MCP server, for
//! a `claude` in the user's own Terminal on any account. Registered once at
//! user scope (`sessions::register_command`), it relays each message to the
//! app's bridge at `/mcp/user-chrome` with the Terminal secret.
//!
//! It reads the bridge's port and the secret ([`super::sessions::endpoint_path`])
//! on every message, so it keeps working across app restarts. While the app
//! is closed it still answers `initialize` and `tools/list` itself (the
//! tools stay listed), and every tool call says the app isn't open. Inside
//! a project tab the app started it uses that tab's own secret
//! ([`super::sessions::TOKEN_ENV`]).
//!
//! Messages are newline-delimited JSON-RPC on stdin and stdout; nothing
//! else is ever written to stdout.

use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::time::Duration;

use super::sessions::{self, Endpoint};

/// Started as the launcher: run it, and exit with its code.
pub fn from_argv() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).take(2).collect();
    if args.len() != 2 || args[0] != "mcp" || args[1] != "user-chrome" {
        return None;
    }
    let path = sessions::endpoint_path();
    let own = std::env::var(sessions::TOKEN_ENV)
        .ok()
        .filter(|t| t.len() == 64);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    Some(serve(
        stdin.lock(),
        stdout.lock(),
        || sessions::read_endpoint_at(&path),
        own,
        &Http,
    ))
}

/// How a message reaches the bridge.
pub trait Bridge {
    /// POST `body` to `/mcp/user-chrome` on `port` with `secret`.
    fn post(&self, port: u16, secret: &str, body: &[u8]) -> Result<Reply, Down>;
}

/// The bridge's answer.
#[derive(Debug, PartialEq)]
pub enum Reply {
    /// A JSON-RPC response.
    Json(Value),
    /// Accepted with no body (a notification).
    Empty,
    /// Not found: Your Chrome is off, or the secret isn't live.
    Refused,
}

/// Nobody answered on the port: the app isn't running.
#[derive(Debug, PartialEq)]
pub struct Down;

/// Relay `input` to the bridge until it ends. `endpoint`: read before each
/// message. `own`: a project tab's secret, used instead of the Terminal's.
pub fn serve<R: BufRead, W: Write>(
    input: R,
    mut out: W,
    endpoint: impl Fn() -> Option<Endpoint>,
    own: Option<String>,
    bridge: &dyn Bridge,
) -> i32 {
    for line in input.lines() {
        let Ok(line) = line else {
            return 1;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(answer) = answer(line, &endpoint, own.as_deref(), bridge) else {
            continue;
        };
        if writeln!(out, "{answer}").and_then(|_| out.flush()).is_err() {
            return 1;
        }
    }
    0
}

/// The reply to one line, if it wants one.
pub fn answer(
    line: &str,
    endpoint: &impl Fn() -> Option<Endpoint>,
    own: Option<&str>,
    bridge: &dyn Bridge,
) -> Option<Value> {
    let message: Value = match serde_json::from_str(line) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            return Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }),
            )
        }
    };
    let id = message.get("id").cloned().filter(|v| !v.is_null());
    let reached = endpoint().map(|e| {
        let secret = own.map(str::to_string).unwrap_or(e.token);
        bridge.post(e.port, &secret, line.as_bytes())
    });
    let id = id?;
    match reached {
        Some(Ok(Reply::Json(v))) => Some(v),
        Some(Ok(Reply::Refused)) => Some(local(&message, id, &off_line())),
        Some(Ok(Reply::Empty)) => Some(local(&message, id, "The app didn't answer that.")),
        Some(Err(Down)) | None => Some(local(&message, id, &closed_line())),
    }
}

/// What the launcher answers itself when the app can't: the handshake and
/// the tool list (so the tools stay listed), and `why` for anything else.
pub fn local(message: &Value, id: Value, why: &str) -> Value {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    match method {
        "initialize" => ok(super::tools::session_initialize_result(
            message.get("params"),
        )),
        "ping" => ok(json!({})),
        "tools/list" => ok(super::tools::tools_list()),
        "tools/call" => {
            ok(json!({ "content": [{ "type": "text", "text": why }], "isError": true }))
        }
        other => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {other}") } })
        }
    }
}

/// The app isn't running.
pub fn closed_line() -> String {
    format!(
        "{} isn't open, so the user's Chrome can't be reached. Ask the user to open {}, then try again.",
        crate::brand::NAME,
        crate::brand::NAME
    )
}

/// The app is running but won't answer: Your Chrome is off.
pub fn off_line() -> String {
    format!(
        "Your Chrome is off in {} (Settings → Chrome). Ask the user to turn it on, then try again.",
        crate::brand::NAME
    )
}

/// The bridge over plain HTTP/1.1 on loopback.
pub struct Http;

/// How long one message may take: a call can wait on the user's card.
const WAIT: Duration = Duration::from_secs(15 * 60);

impl Bridge for Http {
    fn post(&self, port: u16, secret: &str, body: &[u8]) -> Result<Reply, Down> {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3))
            .map_err(|_| Down)?;
        let _ = s.set_read_timeout(Some(WAIT));
        let head = format!(
            "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {secret}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            super::tools::PATH,
            body.len()
        );
        s.write_all(head.as_bytes()).map_err(|_| Down)?;
        s.write_all(body).map_err(|_| Down)?;
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).map_err(|_| Down)?;
        parse_reply(&raw).ok_or(Down)
    }
}

/// An HTTP response from the bridge, as a [`Reply`]. Pure.
pub fn parse_reply(raw: &[u8]) -> Option<Reply> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    match status {
        200 => serde_json::from_slice(body).ok().map(Reply::Json),
        202 => Some(Reply::Empty),
        _ => Some(Reply::Refused),
    }
}

#[cfg(test)]
#[path = "launcher_tests.rs"]
mod tests;
