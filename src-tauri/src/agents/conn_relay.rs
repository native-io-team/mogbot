//! The connection relay: how a turn reaches an app it was granted on a
//! login card without ever holding the app's token.
//!
//! A turn's connection servers point at the agent bridge
//! (`http://127.0.0.1:<port>/mcp/conn/<serverKey>`), authenticated by the
//! turn's own bridge secret, which is revoked when the turn ends
//! (`agents::reach`). The bridge checks the caller's grant, takes a fresh
//! access token from the Keychain (`connections::relay_target`) and forwards
//! the request to the app's MCP server with it. The token stays in this
//! process: not in the turn's config file, its environment, or anything the
//! agent's own commands can read. A leaked bridge secret is good only for
//! the rest of one turn, on this Mac, through these checks.
//!
//! The relay is also where a grant is enforced, whatever the engine: a
//! read-only grant refuses a call that isn't a read, and a call that isn't
//! a plain read (or any call in a turn answering outside text) must have
//! been allowed by `mcp::decide` (the engine's approval) or it is put on a
//! card here. So a Codex `exec` turn, which has no approval channel, can't
//! write through a connection unasked.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::{HeaderMap, Method, Response, StatusCode};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::connections::{self, RelayCall};

type Body = BoxBody<Bytes, hyper::Error>;

/// A tool call through an app can take a while (a search, an export).
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Request headers passed on. Never `Authorization` (ours is the bridge
/// secret; the app's token is added here) and never cookies.
const PASS_REQUEST: &[&str] = &[
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
];
/// Response headers passed back. Never `www-authenticate`: the engine must
/// not start a sign-in of its own against the relay.
const PASS_RESPONSE: &[&str] = &["content-type", "mcp-session-id", "cache-control"];

fn full(data: impl Into<Bytes>) -> Body {
    Full::new(data.into())
        .map_err(|never| match never {})
        .boxed()
}

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(full(text))
        .unwrap()
}

/// A tool call's refusal as its result, so the agent reads why.
fn refused(id: &Value, why: &str) -> Response<Body> {
    let v = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "content": [{ "type": "text", "text": why }], "isError": true },
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(full(v.to_string()))
        .unwrap()
}

fn rpc_error(id: &Value, message: &str) -> Response<Body> {
    let v = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(full(v.to_string()))
        .unwrap()
}

/// A body fed by a channel: the app's answer streamed back (SSE included).
struct ChannelBody {
    rx: tokio::sync::mpsc::Receiver<Result<hyper::body::Frame<Bytes>, hyper::Error>>,
}

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, hyper::Error>>> {
        self.rx.poll_recv(cx)
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        // A redirect could carry the token somewhere else: none are followed.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

/// One request from `agent_id`'s turn for its connection `key`.
pub async fn relay(
    app: &AppHandle,
    agent_id: &str,
    turn: Option<u64>,
    key: &str,
    method: &Method,
    headers: &HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let upstream_method = match *method {
        Method::POST => reqwest::Method::POST,
        Method::DELETE => reqwest::Method::DELETE,
        // No server-initiated stream through the relay.
        _ => return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
    };
    let message: Option<Value> = if *method == Method::POST {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) if v.is_object() => Some(v),
            // One message per request: a batch could hide a call.
            _ => return plain(StatusCode::BAD_REQUEST, "One JSON-RPC message per request"),
        }
    } else {
        None
    };
    let id = message
        .as_ref()
        .and_then(|m| m.get("id").cloned())
        .unwrap_or(Value::Null);
    let target = match connections::relay_target(agent_id, key).await {
        Ok(t) => t,
        Err(why) => {
            return if message.is_some() {
                rpc_error(&id, why)
            } else {
                plain(StatusCode::NOT_FOUND, "Not found")
            }
        }
    };
    // The grant, enforced here for every engine.
    if let Some(m) = &message {
        if m.get("method").and_then(Value::as_str) == Some("tools/call") {
            let params = m.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let input = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let outside = super::runner::from_outside(agent_id);
            match connections::relay_check(agent_id, &target, name, outside, turn.is_none()) {
                RelayCall::Pass => {}
                RelayCall::Refuse(why) => return refused(&id, &why),
                RelayCall::Decide => {
                    let tool = format!("mcp__{key}__{name}");
                    if let Err(why) = super::mcp::decide_relayed(app, agent_id, &tool, &input).await
                    {
                        return refused(&id, &why);
                    }
                }
            }
            // Mail, chat, other people's documents: the rest of the turn
            // asks (`exposure`).
            super::exposure::mark_read(agent_id, &format!("mcp__{key}__{name}"));
        }
    }
    let mut req = client()
        .request(upstream_method, &target.url)
        .bearer_auth(&target.token)
        .body(body);
    for name in PASS_REQUEST {
        if let Some(v) = headers.get(*name).and_then(|v| v.to_str().ok()) {
            req = req.header(*name, v);
        }
    }
    let mut upstream = match req.send().await {
        Ok(r) => r,
        Err(_) => {
            return if message.is_some() {
                rpc_error(&id, "Couldn't reach the app. Check this Mac is online.")
            } else {
                plain(StatusCode::BAD_GATEWAY, "Couldn't reach the app")
            }
        }
    };
    let status = upstream.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        connections::rejected(&target.connection_id);
        return if message.is_some() {
            rpc_error(
                &id,
                "The app refused this sign-in. Ask with request_login to connect it again.",
            )
        } else {
            plain(StatusCode::BAD_GATEWAY, "Sign-in refused")
        };
    }
    let mut builder = Response::builder().status(status.as_u16());
    for name in PASS_RESPONSE {
        if let Some(v) = upstream.headers().get(*name).and_then(|v| v.to_str().ok()) {
            builder = builder.header(*name, v);
        }
    }
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move {
        while let Ok(Some(chunk)) = upstream.chunk().await {
            if tx.send(Ok(hyper::body::Frame::data(chunk))).await.is_err() {
                return; // the engine went away
            }
        }
    });
    builder
        .body(ChannelBody { rx }.boxed())
        .unwrap_or_else(|_| plain(StatusCode::BAD_GATEWAY, "Bad answer from the app"))
}
