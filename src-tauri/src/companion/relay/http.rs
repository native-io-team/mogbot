//! HTTP over a relay channel (docs/relay.md, "HTTP over the channel"): what
//! the Tailscale route does in plain HTTP (identity, pair, blobs,
//! attachments), answered by calling this app's own loopback server.
//!
//! The request goes to `127.0.0.1:<port>` exactly as the phone made it, less
//! anything only a proxy may say (the host, hop-by-hop headers, a tailnet
//! login, forwarding headers, the relay's own headers), plus this launch's
//! relay secret. The server then checks the device token as it always does;
//! the secret only stands in for the tailnet login a relayed phone has none of.

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::{header, Request};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::mpsc;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A body is sent in pieces of at most this many bytes (before base64).
pub const CHUNK: usize = 128 * 1024;
/// Requests in flight on one channel.
pub const MAX_IN_FLIGHT: usize = 8;
/// The longest a relayed request runs, end to end (an upload's ten minutes,
/// and a little).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(11 * 60);
/// A request body piece waits this long for the loopback server to take it.
const BODY_STALL: Duration = Duration::from_secs(30);

/// `{"t":"http",…}`.
#[derive(Debug, Deserialize)]
pub struct HttpRequest {
    pub id: u64,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub more: bool,
}

/// `{"t":"httpBody",…}`.
#[derive(Debug, Deserialize)]
pub struct HttpBody {
    pub id: u64,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub more: bool,
}

/// What a phone may not set: the loopback server's own host, anything
/// hop-by-hop, a tailnet login (only `tailscale serve` may say that), and
/// the relay's own headers.
fn dropped(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "upgrade"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "proxy-authorization"
            | "proxy-connection"
            | "content-length"
            | "origin"
            | "forwarded"
    ) || n.starts_with("tailscale-")
        || n.starts_with("x-forwarded-")
        || n == super::SECRET_HEADER.as_str()
        || n == super::SOURCE_HEADER.as_str()
}

/// Paths the loopback server serves over HTTP, nothing else: never the
/// socket (`/v1/ws`), which a channel speaks directly.
fn usable_path(path: &str) -> bool {
    path.starts_with("/v1/")
        && path.len() <= 2048
        && path != "/v1/ws"
        && !path.starts_with("/v1/ws?")
        && path.bytes().all(|b| b.is_ascii_graphic())
}

fn usable_method(m: &str) -> Option<hyper::Method> {
    match m {
        "GET" => Some(hyper::Method::GET),
        "HEAD" => Some(hyper::Method::HEAD),
        "POST" => Some(hyper::Method::POST),
        "PUT" => Some(hyper::Method::PUT),
        _ => None,
    }
}

fn response_frame(id: u64, first: bool, status: u16, headers: &Value, body: &[u8], more: bool) -> String {
    let mut f = Map::new();
    f.insert("t".into(), json!(if first { "httpRes" } else { "httpBody" }));
    f.insert("id".into(), json!(id));
    if first {
        f.insert("status".into(), json!(status));
        f.insert("headers".into(), headers.clone());
    }
    if !body.is_empty() || !first {
        f.insert("body".into(), json!(B64.encode(body)));
    }
    if more || !first {
        f.insert("more".into(), json!(more));
    }
    Value::Object(f).to_string()
}

/// A response with no body, for a request the Mac couldn't make.
fn bare(id: u64, status: u16) -> String {
    response_frame(id, true, status, &json!({}), &[], false)
}

/// A piece of a request body, or its end.
pub enum Piece {
    Data(Bytes),
    End,
}

/// One channel's HTTP: requests in flight and the bodies still arriving.
pub struct Http {
    port: u16,
    source: String,
    /// Bodies still arriving, by request id.
    bodies: HashMap<u64, mpsc::Sender<Piece>>,
    work: tokio::task::JoinSet<()>,
    /// Plaintext frames back to the phone.
    out: mpsc::Sender<String>,
}

impl Http {
    pub fn new(port: u16, ch: u32, out: mpsc::Sender<String>) -> Self {
        Http {
            port,
            source: format!("relay:{ch}"),
            bodies: HashMap::new(),
            work: tokio::task::JoinSet::new(),
            out,
        }
    }

    /// Reap finished requests.
    pub fn reap(&mut self) {
        while self.work.try_join_next().is_some() {}
    }

    /// `{"t":"http"}`: start it.
    pub async fn start(&mut self, req: HttpRequest) {
        self.reap();
        let id = req.id;
        let method = usable_method(&req.method);
        let Some(method) = method.filter(|_| usable_path(&req.path)) else {
            let _ = self.out.send(bare(id, 404)).await;
            return;
        };
        if self.work.len() >= MAX_IN_FLIGHT || self.bodies.contains_key(&id) {
            let _ = self.out.send(bare(id, 429)).await;
            return;
        }
        let first = match req.body.as_deref().map(|b| B64.decode(b)) {
            None => Vec::new(),
            Some(Ok(b)) => b,
            Some(Err(_)) => {
                let _ = self.out.send(bare(id, 400)).await;
                return;
            }
        };
        let body = if req.more {
            let (tx, rx) = mpsc::channel::<Piece>(16);
            if !first.is_empty() {
                let _ = tx.try_send(Piece::Data(Bytes::from(first)));
            }
            self.bodies.insert(id, tx);
            // A body whose channel goes before its last piece is an error, never
            // a shorter file the server takes as whole.
            let stream = futures_util::stream::unfold(Some(rx), |rx| async move {
                let mut rx = rx?;
                match rx.recv().await {
                    Some(Piece::Data(b)) => Some((Ok(Frame::data(b)), Some(rx))),
                    Some(Piece::End) => None,
                    None => Some((Err(std::io::Error::other("the phone went before its body ended")), None)),
                }
            });
            StreamBody::new(stream).boxed_unsync()
        } else {
            Full::new(Bytes::from(first))
                .map_err(|never: Infallible| match never {})
                .boxed_unsync()
        };
        let mut builder = Request::builder()
            .method(method)
            .uri(&req.path)
            .header(header::HOST, format!("127.0.0.1:{}", self.port))
            .header(super::SECRET_HEADER.as_str(), super::secret())
            .header(super::SOURCE_HEADER.as_str(), self.source.as_str());
        for (k, v) in &req.headers {
            if dropped(k) {
                continue;
            }
            builder = builder.header(k.as_str(), v.as_str());
        }
        let Ok(request) = builder.body(body) else {
            self.bodies.remove(&id);
            let _ = self.out.send(bare(id, 400)).await;
            return;
        };
        let (port, out) = (self.port, self.out.clone());
        self.work.spawn(async move {
            match tokio::time::timeout(REQUEST_TIMEOUT, perform(port, id, request, &out)).await {
                Ok(Ok(())) => {}
                Ok(Err(sent_head)) => {
                    if !sent_head {
                        let _ = out.send(bare(id, 502)).await;
                    }
                }
                Err(_) => tracing::warn!("[Relay] a relayed request ran out of time"),
            }
        });
    }

    /// `{"t":"httpBody"}`: the next piece of a request's body.
    pub async fn body(&mut self, piece: HttpBody) {
        let Some(tx) = self.bodies.get(&piece.id) else {
            return;
        };
        let bytes = match piece.body.as_deref().map(|b| B64.decode(b)) {
            None => Vec::new(),
            Some(Ok(b)) => b,
            Some(Err(_)) => {
                // A body that doesn't decode ends short; the server says so.
                self.bodies.remove(&piece.id);
                return;
            }
        };
        if !bytes.is_empty()
            && tx
                .send_timeout(Piece::Data(Bytes::from(bytes)), BODY_STALL)
                .await
                .is_err()
        {
            // The server stopped reading (it answered early): let it go.
            self.bodies.remove(&piece.id);
            return;
        }
        if !piece.more {
            if let Some(tx) = self.bodies.remove(&piece.id) {
                let _ = tx.send_timeout(Piece::End, BODY_STALL).await;
            }
        }
    }
}

/// Make the request on loopback and send the response back in pieces.
/// `Err(true)` once the head went out (nothing more can be said), `Err(false)`
/// before it.
async fn perform(
    port: u16,
    id: u64,
    request: Request<http_body_util::combinators::UnsyncBoxBody<Bytes, std::io::Error>>,
    out: &mpsc::Sender<String>,
) -> Result<(), bool> {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|_| false)?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| false)?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let response = sender.send_request(request).await.map_err(|e| {
        tracing::debug!("[Relay] loopback request failed: {e}");
        false
    })?;
    let status = response.status().as_u16();
    let mut headers = Map::new();
    for (name, value) in response.headers() {
        let n = name.as_str();
        if matches!(n, "connection" | "keep-alive" | "transfer-encoding" | "upgrade") {
            continue;
        }
        let Ok(v) = value.to_str() else { continue };
        match headers.get_mut(n) {
            Some(Value::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(v);
            }
            _ => {
                headers.insert(n.to_string(), json!(v));
            }
        }
    }
    let headers = Value::Object(headers);
    let mut body = response.into_body();
    let mut buf: Vec<u8> = Vec::new();
    let mut first = true;
    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    buf.extend_from_slice(&data);
                }
                // Keep one byte past a whole piece, so `more` is known.
                while buf.len() > CHUNK {
                    let rest = buf.split_off(CHUNK);
                    let piece = std::mem::replace(&mut buf, rest);
                    if out
                        .send(response_frame(id, first, status, &headers, &piece, true))
                        .await
                        .is_err()
                    {
                        return Err(!first);
                    }
                    first = false;
                }
            }
            Some(Err(_)) => break,
            None => break,
        }
    }
    out.send(response_frame(id, first, status, &headers, &buf, false))
        .await
        .map_err(|_| !first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_cant_say_what_only_the_proxy_says() {
        for h in [
            "Host",
            "Tailscale-User-Login",
            "X-Forwarded-For",
            "Content-Length",
            super::super::SECRET_HEADER.as_str(),
            super::super::SOURCE_HEADER.as_str(),
        ] {
            assert!(dropped(h), "{h}");
        }
        assert!(!dropped("Authorization"));
        assert!(!dropped("X-Name"));
        assert!(!dropped("Content-Type"));
    }

    #[test]
    fn only_the_servers_http_paths_go_through() {
        assert!(usable_path("/v1/identity"));
        assert!(usable_path("/v1/blobs/abc?w=100"));
        assert!(!usable_path("/v1/ws"));
        assert!(!usable_path("/"));
        assert!(!usable_path("/v1/a b"));
        assert!(!usable_path("http://elsewhere/v1/identity"));
        assert!(usable_method("DELETE").is_none());
    }

    #[test]
    fn frames_say_more_only_when_more_follows() {
        let h = json!({ "content-type": "text/plain" });
        let one: Value = serde_json::from_str(&response_frame(3, true, 200, &h, b"hi", false)).unwrap();
        assert_eq!(one, json!({ "t": "httpRes", "id": 3, "status": 200, "headers": h, "body": "aGk" }));
        let empty: Value = serde_json::from_str(&bare(4, 502)).unwrap();
        assert_eq!(empty, json!({ "t": "httpRes", "id": 4, "status": 502, "headers": {} }));
        let next: Value = serde_json::from_str(&response_frame(3, false, 200, &h, b"", false)).unwrap();
        assert_eq!(next, json!({ "t": "httpBody", "id": 3, "body": "", "more": false }));
    }
}
