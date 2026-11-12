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

/// The only request headers a phone's request carries to the loopback
/// server: what the app's HTTP calls set (the device token, a file's type
/// and name, a range) and nothing else. An allow-list, so nothing only a
/// proxy may say (`Host`, `Tailscale-User-Login`, `X-Forwarded-*`, the
/// relay's own secret and source) and no header the server learns to trust
/// later can ever come from a phone.
fn allowed(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "content-type"
            | "accept"
            | "range"
            | "if-range"
            | "if-none-match"
            | "if-modified-since"
            | "x-name"
    )
}

/// Paths the loopback server serves over HTTP, nothing else: never the
/// socket (`/v1/ws`), which a channel speaks directly.
fn usable_path(path: &str) -> bool {
    let route = path.split_once('?').map_or(path, |(p, _)| p);
    path.starts_with("/v1/")
        && path.len() <= 2048
        && route != "/v1/ws"
        && path.bytes().all(|b| b.is_ascii_graphic() && b != b'\\' && b != b'#')
        // No dot segments, plain or encoded: the server refuses them too,
        // and a path the phone never sends needn't reach it.
        && !route.split('/').any(|seg| {
            let seg = seg.to_ascii_lowercase().replace("%2e", ".");
            seg == "." || seg == ".."
        })
        && !route.to_ascii_lowercase().contains("%2f")
        && !route.to_ascii_lowercase().contains("%5c")
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

fn response_frame(
    id: u64,
    first: bool,
    status: u16,
    headers: &Value,
    body: &[u8],
    more: bool,
) -> String {
    let mut f = Map::new();
    f.insert(
        "t".into(),
        json!(if first { "httpRes" } else { "httpBody" }),
    );
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

    /// Reap finished requests, and the bodies nobody reads any more.
    pub fn reap(&mut self) {
        while self.work.try_join_next().is_some() {}
        self.bodies.retain(|_, tx| !tx.is_closed());
    }

    /// Requests still running or still sending their bodies.
    pub fn in_flight(&mut self) -> usize {
        self.reap();
        self.work.len() + self.bodies.len()
    }

    /// `{"t":"http"}`: start it. A request the Mac won't make is answered at
    /// once, by the frame this returns, which the caller seals itself: the
    /// channel's own loop drains `out`, so waiting on it here could wait forever.
    #[must_use]
    pub fn start(&mut self, req: HttpRequest) -> Option<String> {
        self.reap();
        let id = req.id;
        let method = usable_method(&req.method);
        let Some(method) = method.filter(|_| usable_path(&req.path)) else {
            return Some(bare(id, 404));
        };
        if self.work.len() >= MAX_IN_FLIGHT || self.bodies.contains_key(&id) {
            return Some(bare(id, 429));
        }
        let first = match req.body.as_deref().map(|b| B64.decode(b)) {
            None => Vec::new(),
            Some(Ok(b)) => b,
            Some(Err(_)) => return Some(bare(id, 400)),
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
                    None => Some((
                        Err(std::io::Error::other(
                            "the phone went before its body ended",
                        )),
                        None,
                    )),
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
            if !allowed(k) {
                continue;
            }
            builder = builder.header(k.as_str(), v.as_str());
        }
        let Ok(request) = builder.body(body) else {
            self.bodies.remove(&id);
            return Some(bare(id, 400));
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
        None
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
        if matches!(
            n,
            "connection" | "keep-alive" | "transfer-encoding" | "upgrade"
        ) {
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
            "tailscale-user-name",
            "X-Forwarded-For",
            "X-Forwarded-Host",
            "X-Real-IP",
            "Forwarded",
            "Origin",
            "Cookie",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            super::super::SECRET_HEADER.as_str(),
            super::super::SOURCE_HEADER.as_str(),
            &super::super::SECRET_HEADER.to_ascii_uppercase(),
        ] {
            assert!(!allowed(h), "{h}");
        }
        for h in ["Authorization", "X-Name", "Content-Type", "range"] {
            assert!(allowed(h), "{h}");
        }
    }

    #[tokio::test]
    async fn a_relayed_request_carries_only_allowed_headers_and_the_bridges_own() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // A loopback "server" that records the request head it got.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (head_tx, head_rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut got = Vec::new();
            while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = s.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            let _ = head_tx.send(String::from_utf8_lossy(&got).to_string());
            let _ = s
                .write_all(b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\n")
                .await;
        });
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let mut http = Http::new(port, 9, out_tx);
        let mut headers = HashMap::new();
        for (k, v) in [
            ("Authorization", "Bearer t"),
            ("Host", "evil.example"),
            ("Tailscale-User-Login", "someone@x.com"),
            ("X-Forwarded-For", "1.2.3.4"),
            (super::super::SECRET_HEADER.as_str(), "guess"),
            (super::super::SOURCE_HEADER.as_str(), "relay:1"),
            ("X-Anything", "x"),
        ] {
            headers.insert(k.to_string(), v.to_string());
        }
        let req = HttpRequest {
            id: 1,
            method: "GET".into(),
            path: "/v1/identity".into(),
            headers,
            body: None,
            more: false,
        };
        assert!(http.start(req).is_none());
        let head = head_rx.await.unwrap().to_ascii_lowercase();
        assert!(head.contains("authorization: bearer t"), "{head}");
        assert!(head.contains("host: 127.0.0.1:"), "{head}");
        assert!(
            head.contains(&format!(
                "{}: relay:9",
                super::super::SOURCE_HEADER.as_str()
            )),
            "{head}"
        );
        let secret = format!(
            "{}: {}",
            super::super::SECRET_HEADER.as_str(),
            super::super::secret()
        );
        assert!(head.contains(&secret), "{head}");
        for bad in [
            "evil.example",
            "someone@x.com",
            "1.2.3.4",
            "guess",
            "x-anything",
            "relay:1\r",
        ] {
            assert!(!head.contains(bad), "{bad} reached the server: {head}");
        }
        let res: Value = serde_json::from_str(&out_rx.recv().await.unwrap()).unwrap();
        assert_eq!(res["status"], 204);
    }

    #[tokio::test]
    async fn a_refused_request_is_answered_without_waiting_on_a_full_queue() {
        // The queue back to the phone is full and nobody drains it (the
        // channel's loop is the one calling): the answer still comes back.
        let (out_tx, _out_rx) = mpsc::channel(1);
        out_tx.try_send("filler".to_string()).unwrap();
        let mut http = Http::new(1, 1, out_tx);
        let req = |path: &str| HttpRequest {
            id: 5,
            method: "GET".into(),
            path: path.into(),
            headers: HashMap::new(),
            body: None,
            more: false,
        };
        let answer =
            tokio::time::timeout(Duration::from_secs(1), async { http.start(req("/v1/ws")) })
                .await
                .expect("no wait")
                .expect("an answer");
        let v: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(v["status"], 404);
    }

    #[test]
    fn only_the_servers_http_paths_go_through() {
        assert!(usable_path("/v1/identity"));
        assert!(usable_path("/v1/blobs/abc?w=100"));
        assert!(!usable_path("/v1/ws"));
        assert!(!usable_path("/"));
        assert!(!usable_path("/v1/a b"));
        assert!(!usable_path("http://elsewhere/v1/identity"));
        assert!(!usable_path("/v1/ws?x=1"));
        for traversal in [
            "/v1/agents/../identity",
            "/v1/agents/a/attachments/../../x",
            "/v1/agents/%2e%2e/attachments/x",
            "/v1/agents/a/attachments/%2E%2e/x",
            "/v1/agents/a/attachments/.",
            "/v1/agents/a%2fb/attachments/x",
            "/v1/agents/a\\b",
            "/v1/blobs/x#y",
        ] {
            assert!(!usable_path(traversal), "{traversal}");
        }
        // A dot inside a name, or a query that mentions one, is fine.
        assert!(usable_path(
            "/v1/agents/a/attachments/m1/photo.v2.png?w=300"
        ));
        assert!(usable_method("DELETE").is_none());
    }

    #[test]
    fn frames_say_more_only_when_more_follows() {
        let h = json!({ "content-type": "text/plain" });
        let one: Value =
            serde_json::from_str(&response_frame(3, true, 200, &h, b"hi", false)).unwrap();
        assert_eq!(
            one,
            json!({ "t": "httpRes", "id": 3, "status": 200, "headers": h, "body": "aGk" })
        );
        let empty: Value = serde_json::from_str(&bare(4, 502)).unwrap();
        assert_eq!(
            empty,
            json!({ "t": "httpRes", "id": 4, "status": 502, "headers": {} })
        );
        let next: Value =
            serde_json::from_str(&response_frame(3, false, 200, &h, b"", false)).unwrap();
        assert_eq!(
            next,
            json!({ "t": "httpBody", "id": 3, "body": "", "more": false })
        );
    }
}
