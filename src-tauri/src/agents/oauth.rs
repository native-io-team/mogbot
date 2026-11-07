//! Signing in to a remote MCP server ourselves, the way the MCP
//! authorization spec describes, so the token is created and kept on this
//! Mac (`agents/connections.rs`) rather than inside one engine's config.
//!
//! 1. **Discover.** An unauthenticated `initialize` to the server is
//!    answered 401 with `WWW-Authenticate: Bearer resource_metadata="…"`
//!    (RFC 9728); that document names the authorization server, whose own
//!    metadata (RFC 8414, or OpenID discovery) names its endpoints. When the
//!    header is missing, the well-known paths are tried in the spec's order.
//! 2. **Register.** Dynamic client registration (RFC 7591), a public client
//!    with our loopback redirect. A server without a `registration_endpoint`
//!    can't be signed in to this way, and the card says so instead (Slack,
//!    Google, GitHub: each wants an app registered with it in advance).
//! 3. **Authorize** in this Mac's browser: authorization code with PKCE
//!    (S256), a random `state`, and the server as `resource` (RFC 8707).
//!    The redirect lands on a one-shot listener on 127.0.0.1 (RFC 8252),
//!    which only accepts its own `state` and closes after one answer.
//! 4. **Exchange** the code for tokens, stored in the Keychain.
//!
//! Observed 2026-11 (unauthenticated metadata only, nothing registered):
//! Linear, Notion, Figma, Stripe, Vercel and Sentry advertise registration
//! and S256; Slack, Google (Gmail/Calendar/Drive) and GitHub don't
//! register clients. Never signed in end to end from this build: see docs/agents.md.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::connections::Tokens;
use crate::errors::CommandError;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a browser sign-in may take before it's given up.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(format!(
            "{}/{}",
            crate::brand::NAME,
            env!("CARGO_PKG_VERSION")
        ))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .unwrap_or_default()
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ServerMeta {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Discovered {
    pub meta: ServerMeta,
    /// What the protected resource says it accepts (may be empty).
    pub scopes: Vec<String>,
}

/// `resource_metadata="…"` from a `WWW-Authenticate` header.
pub fn resource_metadata_url(header: &str) -> Option<String> {
    let at = header.find("resource_metadata=")? + "resource_metadata=".len();
    let rest = &header[at..];
    let value = if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split('"').next()?
    } else {
        rest.split([',', ' ']).next()?
    };
    (value.starts_with("https://")).then(|| value.to_string())
}

/// Where to look for the authorization server's metadata, in the spec's order.
pub fn metadata_candidates(issuer: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(issuer) else {
        return Vec::new();
    };
    let origin = u.origin().ascii_serialization();
    let path = u.path().trim_end_matches('/');
    let mut out = vec![
        format!("{origin}/.well-known/oauth-authorization-server{path}"),
        format!("{origin}/.well-known/openid-configuration{path}"),
    ];
    if !path.is_empty() {
        out.push(format!("{origin}{path}/.well-known/openid-configuration"));
    }
    out
}

fn protected_candidates(server: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(server) else {
        return Vec::new();
    };
    let origin = u.origin().ascii_serialization();
    let path = u.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    out.push(format!("{origin}/.well-known/oauth-protected-resource"));
    out
}

async fn get_json(http: &reqwest::Client, url: &str) -> Option<Value> {
    let r = http
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

fn https_only(url: &str) -> Result<(), CommandError> {
    if url.starts_with("https://") {
        Ok(())
    } else {
        Err(CommandError::expected(format!(
            "The sign-in server isn't HTTPS ({url}), so it isn't used."
        )))
    }
}

pub async fn discover(server_url: &str) -> Result<Discovered, CommandError> {
    https_only(server_url)?;
    let http = client();
    let probe = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":crate::brand::NAME,"version":env!("CARGO_PKG_VERSION")}}});
    let header = http
        .post(server_url)
        .header("accept", "application/json, text/event-stream")
        .json(&probe)
        .send()
        .await
        .ok()
        .and_then(|r| {
            r.headers()
                .get("www-authenticate")
                .and_then(|h| h.to_str().ok())
                .map(str::to_string)
        });
    let mut candidates: Vec<String> = header
        .as_deref()
        .and_then(resource_metadata_url)
        .into_iter()
        .collect();
    candidates.extend(protected_candidates(server_url));
    let mut resource = None;
    for c in &candidates {
        if let Some(v) = get_json(&http, c).await {
            resource = Some(v);
            break;
        }
    }
    let unreachable = || {
        CommandError::expected(
            "Couldn't reach that app's sign-in. Check this Mac is online and try again.",
        )
    };
    let resource = resource.ok_or_else(unreachable)?;
    let issuer = resource
        .get("authorization_servers")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .ok_or_else(unreachable)?
        .to_string();
    https_only(&issuer)?;
    let scopes = resource
        .get("scopes_supported")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    for c in metadata_candidates(&issuer) {
        if let Some(v) = get_json(&http, &c).await {
            if let Ok(meta) = serde_json::from_value::<ServerMeta>(v) {
                https_only(&meta.authorization_endpoint)?;
                https_only(&meta.token_endpoint)?;
                return Ok(Discovered { meta, scopes });
            }
        }
    }
    Err(unreachable())
}

/* ----------------------------------------------------------------- PKCE */

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("the OS random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()))
}

/* ------------------------------------------------------------- register */

#[derive(Debug, Clone)]
pub struct Client {
    pub client_id: String,
    pub client_secret: Option<String>,
}

async fn register(meta: &ServerMeta, redirect: &str) -> Result<Client, CommandError> {
    let endpoint = meta.registration_endpoint.as_deref().ok_or_else(|| {
        CommandError::expected("This app doesn't let new apps register to sign in, so it can't be connected from here.")
    })?;
    https_only(endpoint)?;
    let body = serde_json::json!({
        "client_name": crate::brand::NAME,
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let r = client()
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            CommandError::expected("Couldn't register with that app's sign-in. Try again.")
        })?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or_default();
    let id = v
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|_| status.is_success());
    match id {
        Some(id) => Ok(Client {
            client_id: id.to_string(),
            client_secret: v
                .get("client_secret")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        None => Err(CommandError::expected(
            "That app refused to register this one for sign-in.",
        )),
    }
}

/* ------------------------------------------------------------- callback */

/// The parts of the redirect we care about.
#[derive(Debug, PartialEq)]
pub enum Callback {
    Code {
        code: String,
        state: String,
    },
    Error {
        error: String,
        state: Option<String>,
    },
    /// Something else asked the listener (a favicon): ignored.
    Other,
}

pub fn parse_callback(request_line: &str) -> Callback {
    let target = request_line.split_whitespace().nth(1).unwrap_or("");
    let Ok(u) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Other;
    };
    if u.path() != "/callback" {
        return Callback::Other;
    }
    let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
    match (q.get("code"), q.get("state"), q.get("error")) {
        (Some(code), Some(state), _) => Callback::Code {
            code: code.clone(),
            state: state.clone(),
        },
        (_, state, Some(error)) => Callback::Error {
            error: error.clone(),
            state: state.cloned(),
        },
        _ => Callback::Other,
    }
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font:16px -apple-system,system-ui;margin:4em auto;max-width:28em;color:#333\"><h2>You're signed in</h2><p>You can close this tab. The app on this Mac has it from here.</p>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Not signed in</title><body style=\"font:16px -apple-system,system-ui;margin:4em auto;max-width:28em;color:#333\"><h2>Not signed in</h2><p>You can close this tab and try again from the card.</p>";

async fn reply(stream: &mut tokio::net::TcpStream, page: &str) {
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait for the browser to come back with our `state`. Anything else that
/// knocks is answered and ignored.
async fn wait_for_code(
    listener: tokio::net::TcpListener,
    state: &str,
) -> Result<String, CommandError> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(super::err_io)?;
        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let line = text.lines().next().unwrap_or("");
        match parse_callback(line) {
            Callback::Code { code, state: s } if s == state => {
                reply(&mut stream, DONE_PAGE).await;
                return Ok(code);
            }
            Callback::Error {
                error,
                state: Some(s),
            } if s == state => {
                reply(&mut stream, FAILED_PAGE).await;
                return Err(if error == "access_denied" {
                    CommandError::expected("Sign-in was declined in the browser.")
                } else {
                    CommandError::expected(format!("The app's sign-in said: {error}."))
                });
            }
            _ => {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await;
            }
        }
    }
}

/* ---------------------------------------------------------------- tokens */

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    id_token: Option<String>,
}

/// The email in an OpenID `id_token`, read without checking its signature:
/// it only *names* the account for the user, it decides nothing.
pub fn id_token_email(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email").and_then(Value::as_str).map(str::to_string)
}

async fn token_request(
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<TokenResponse, reqwest::StatusCode> {
    let r = client()
        .post(endpoint)
        .header("accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|_| reqwest::StatusCode::SERVICE_UNAVAILABLE)?;
    let status = r.status();
    if !status.is_success() {
        return Err(status);
    }
    r.json().await.map_err(|_| reqwest::StatusCode::BAD_GATEWAY)
}

fn expires_at(expires_in: Option<i64>) -> Option<i64> {
    expires_in.map(|s| super::store::now_ms() + s.max(0) * 1000)
}

#[derive(Debug, PartialEq)]
pub enum RefreshError {
    /// The server said no: the user has to sign in again.
    Refused,
    /// Offline or the server's down: try again next turn.
    Unreachable,
}

pub async fn refresh(t: &Tokens) -> Result<Tokens, RefreshError> {
    let Some(refresh) = t.refresh_token.as_deref() else {
        return Err(RefreshError::Refused);
    };
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", t.client_id.as_str()),
        ("resource", t.resource.as_str()),
    ];
    if let Some(secret) = t.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    match token_request(&t.token_endpoint, &form).await {
        Ok(r) => Ok(Tokens {
            access_token: r.access_token,
            refresh_token: r.refresh_token.or_else(|| t.refresh_token.clone()),
            expires_at: expires_at(r.expires_in),
            ..t.clone()
        }),
        Err(s) if s.is_client_error() => Err(RefreshError::Refused),
        Err(_) => Err(RefreshError::Unreachable),
    }
}

/* ----------------------------------------------------------------- flow */

/// A sign-in with its authorization URL ready, for one redirect: the
/// verifier and `state` stay here, on this Mac, whoever opens the URL.
pub struct Prepared {
    pub url: String,
    pub(crate) state: String,
    verifier: String,
    pub(crate) redirect: String,
    client: Client,
    meta: ServerMeta,
    resource: String,
}

impl std::fmt::Debug for Prepared {
    // Never the verifier.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared")
            .field("redirect", &self.redirect)
            .field("resource", &self.resource)
            .finish_non_exhaustive()
    }
}

/// Discovery, registration with `redirect`, PKCE and the authorization URL.
pub async fn prepare(server_url: &str, redirect: &str) -> Result<Prepared, CommandError> {
    let found = discover(server_url).await?;
    // A server that doesn't say it supports S256 is refused (the MCP
    // authorization spec: clients MUST refuse when it's absent).
    if !found
        .meta
        .code_challenge_methods_supported
        .iter()
        .any(|m| m == "S256")
    {
        return Err(CommandError::expected(
            "That app's sign-in doesn't support a safe browser sign-in (PKCE), so it isn't used.",
        ));
    }
    url::Url::parse(&found.meta.authorization_endpoint)
        .map_err(|_| CommandError::expected("That app's sign-in address isn't valid."))?;
    let client = register(&found.meta, redirect).await?;
    authorize_url(found, client, server_url, redirect)
}

fn authorize_url(
    found: Discovered,
    client: Client,
    server_url: &str,
    redirect: &str,
) -> Result<Prepared, CommandError> {
    let verifier = random_b64(48);
    let state = random_b64(24);
    let mut url = url::Url::parse(&found.meta.authorization_endpoint)
        .map_err(|_| CommandError::expected("That app's sign-in address isn't valid."))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", redirect)
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", server_url);
        if !found.scopes.is_empty() {
            q.append_pair("scope", &found.scopes.join(" "));
        }
    }
    Ok(Prepared {
        url: url.to_string(),
        state,
        verifier,
        redirect: redirect.to_string(),
        client,
        meta: found.meta,
        resource: server_url.to_string(),
    })
}

/// A sign-in in this Mac's browser, its redirect on a loopback listener.
pub struct Pending {
    pub url: String,
    listener: tokio::net::TcpListener,
    prepared: Prepared,
}

/// Everything up to the browser: the loopback listener, then [`prepare`].
pub async fn begin(server_url: &str) -> Result<Pending, CommandError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(super::err_io)?;
    let port = listener.local_addr().map_err(super::err_io)?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let prepared = prepare(server_url, &redirect).await?;
    Ok(Pending {
        url: prepared.url.clone(),
        listener,
        prepared,
    })
}

/// What a finished sign-in gives: the tokens, and the account's email when
/// the server said it.
pub struct Finished {
    pub tokens: Tokens,
    pub email: Option<String>,
}

impl Pending {
    pub async fn finish(self) -> Result<Finished, CommandError> {
        let code = tokio::time::timeout(
            SIGN_IN_TIMEOUT,
            wait_for_code(self.listener, &self.prepared.state),
        )
        .await
        .map_err(|_| {
            CommandError::expected("Sign-in took too long, so it was stopped. Try again.")
        })??;
        self.prepared.exchange(&code).await
    }
}

impl Prepared {
    /// The code for tokens, with the verifier only this Mac has.
    pub async fn exchange(self, code: &str) -> Result<Finished, CommandError> {
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", self.redirect.as_str()),
            ("client_id", self.client.client_id.as_str()),
            ("code_verifier", self.verifier.as_str()),
            ("resource", self.resource.as_str()),
        ];
        if let Some(secret) = self.client.client_secret.as_deref() {
            form.push(("client_secret", secret));
        }
        let r = token_request(&self.meta.token_endpoint, &form)
            .await
            .map_err(|_| CommandError::expected("The app didn't accept the sign-in. Try again."))?;
        let email = r.id_token.as_deref().and_then(id_token_email);
        Ok(Finished {
            tokens: Tokens {
                access_token: r.access_token,
                refresh_token: r.refresh_token,
                expires_at: expires_at(r.expires_in),
                token_endpoint: self.meta.token_endpoint,
                client_id: self.client.client_id,
                client_secret: self.client.client_secret,
                resource: self.resource,
            },
            email,
        })
    }
}

/// A redirect the phone's sign-in sheet came back with, read against the
/// one this Mac registered: same scheme, host and path, or it's [`Callback::Other`].
pub fn parse_redirect(url: &str, expected: &str) -> Callback {
    let (Ok(got), Ok(want)) = (url::Url::parse(url), url::Url::parse(expected)) else {
        return Callback::Other;
    };
    if got.scheme() != want.scheme()
        || got.host_str() != want.host_str()
        || got.path().trim_end_matches('/') != want.path().trim_end_matches('/')
    {
        return Callback::Other;
    }
    let q: std::collections::HashMap<String, String> = got.query_pairs().into_owned().collect();
    match (q.get("code"), q.get("state"), q.get("error")) {
        (Some(code), Some(state), _) => Callback::Code {
            code: code.clone(),
            state: state.clone(),
        },
        (_, state, Some(error)) => Callback::Error {
            error: error.clone(),
            state: state.cloned(),
        },
        _ => Callback::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_resource_metadata_from_the_challenge() {
        // As Linear and Figma send it (observed 2026-11).
        assert_eq!(
            resource_metadata_url(r#"Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write""#).as_deref(),
            Some("https://mcp.linear.app/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(
            resource_metadata_url(r#"Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect""#).as_deref(),
            Some("https://mcp.figma.com/.well-known/oauth-protected-resource")
        );
        // Never anything but HTTPS.
        assert!(
            resource_metadata_url(r#"Bearer resource_metadata="http://evil.test/x""#).is_none()
        );
        assert!(resource_metadata_url("Bearer").is_none());
    }

    #[test]
    fn metadata_is_looked_for_in_the_specs_order() {
        assert_eq!(
            metadata_candidates("https://access.stripe.com/mcp"),
            vec![
                "https://access.stripe.com/.well-known/oauth-authorization-server/mcp",
                "https://access.stripe.com/.well-known/openid-configuration/mcp",
                "https://access.stripe.com/mcp/.well-known/openid-configuration",
            ]
        );
        assert_eq!(
            metadata_candidates("https://mcp.linear.app"),
            vec![
                "https://mcp.linear.app/.well-known/oauth-authorization-server",
                "https://mcp.linear.app/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn pkce_is_s256_of_the_verifier() {
        // The same as Python's hashlib + urlsafe base64, unpadded.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk"),
            "bwWFMyPfdG9qreDhH2lmftFx_dFeLDalzcT1gb_j68g"
        );
        assert_ne!(random_b64(32), random_b64(32));
    }

    #[test]
    fn the_callback_is_accepted_only_on_its_path() {
        assert_eq!(
            parse_callback("GET /callback?code=abc&state=xyz HTTP/1.1"),
            Callback::Code {
                code: "abc".into(),
                state: "xyz".into()
            }
        );
        assert_eq!(
            parse_callback("GET /callback?error=access_denied&state=xyz HTTP/1.1"),
            Callback::Error {
                error: "access_denied".into(),
                state: Some("xyz".into())
            }
        );
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1"), Callback::Other);
        assert_eq!(
            parse_callback("GET /other?code=abc&state=xyz HTTP/1.1"),
            Callback::Other
        );
    }

    #[tokio::test]
    async fn the_listener_ignores_a_wrong_state_and_takes_the_right_one() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { wait_for_code(listener, "good").await });
        let send = |path: &'static str| async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nhost: x\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out).await;
            out
        };
        assert!(send("/callback?code=stolen&state=bad")
            .await
            .contains("404"));
        assert!(send("/callback?code=real&state=good")
            .await
            .contains("signed in"));
        assert_eq!(waiting.await.unwrap().unwrap(), "real");
    }

    #[test]
    fn a_phone_redirect_is_read_only_against_the_registered_one() {
        let want = "dashbot-companion://oauth";
        assert_eq!(
            parse_redirect("dashbot-companion://oauth?code=c1&state=s1", want),
            Callback::Code {
                code: "c1".into(),
                state: "s1".into()
            }
        );
        assert_eq!(
            parse_redirect(
                "dashbot-companion://oauth?error=access_denied&state=s1",
                want
            ),
            Callback::Error {
                error: "access_denied".into(),
                state: Some("s1".into())
            }
        );
        // Another scheme, host or path is never read for a code.
        for other in [
            "https://evil.test/oauth?code=c1&state=s1",
            "dashbot-companion://pair?code=c1&state=s1",
            "dashbot-companion://oauth/elsewhere?code=c1&state=s1",
            "other-app://oauth?code=c1&state=s1",
            "not a url",
        ] {
            assert_eq!(parse_redirect(other, want), Callback::Other, "{other}");
        }
    }

    #[test]
    fn the_authorization_url_carries_the_challenge_never_the_verifier() {
        let found = Discovered {
            meta: ServerMeta {
                authorization_endpoint: "https://auth.example.com/authorize".into(),
                token_endpoint: "https://auth.example.com/token".into(),
                registration_endpoint: None,
                code_challenge_methods_supported: vec!["S256".into()],
                scopes_supported: vec![],
            },
            scopes: vec!["read".into()],
        };
        let client = Client {
            client_id: "cid".into(),
            client_secret: None,
        };
        let p = authorize_url(
            found,
            client,
            "https://mcp.example.com",
            "dashbot-companion://oauth",
        )
        .unwrap();
        assert!(!p.url.contains(&p.verifier));
        assert!(p.url.contains(&challenge(&p.verifier)));
        assert!(p
            .url
            .contains("redirect_uri=dashbot-companion%3A%2F%2Foauth"));
        assert!(p.url.contains(&format!("state={}", p.state)));
        assert!(!format!("{p:?}").contains(&p.verifier));
    }

    #[test]
    fn an_id_tokens_email_names_the_account() {
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"email":"sam@acme.com"}"#);
        assert_eq!(
            id_token_email(&format!("x.{payload}.y")).as_deref(),
            Some("sam@acme.com")
        );
        assert!(id_token_email("garbage").is_none());
    }
}
