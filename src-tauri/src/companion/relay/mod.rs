//! The phone relay (docs/relay.md): a second way in beside Tailscale, for
//! phones without it.
//!
//! While the phone server is on and a relay is configured (`links.relay` in
//! brand.json, or the `<SLUG>_RELAY_URL` variable), the Mac keeps one
//! WebSocket to `<relay>/v1/mac/<fingerprint>`, signed in with its identity
//! key (`client`). Each phone that reaches the relay for this fingerprint
//! becomes a channel on it, end-to-end encrypted to the Mac (`crypto`).
//! Inside a channel the phone speaks the companion protocol unchanged, served
//! in-process by `server::serve_socket_as` (`channel`), or HTTP, which the Mac
//! answers by calling its own loopback server (`http`).
//!
//! The relay never sees a token or a message. A relayed HTTP request reaches
//! the loopback server with a per-launch secret header that stands in for
//! the tailnet login a relayed phone doesn't have; the device token is
//! checked exactly as over Tailscale.

mod channel;
pub mod client;
pub mod crypto;
mod http;

use hyper::HeaderMap;
use serde::Serialize;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::{mpsc, oneshot};

use super::wire::{Route, RouteKind};

/// The variable that overrides `links.relay` (a local relay, the tests):
/// `MOGBOT_RELAY_URL` for this brand. An empty value turns the relay off.
pub static RELAY_URL_VAR: LazyLock<String> =
    LazyLock::new(|| format!("{}_RELAY_URL", crate::brand::SLUG.to_ascii_uppercase()));

/// The header a relayed HTTP request carries to the loopback server.
pub static SECRET_HEADER: LazyLock<String> =
    LazyLock::new(|| format!("x-{}-relay", crate::brand::SLUG));
/// And the channel it came on, as its per-source key (`relay:<ch>`). Read
/// only when the secret matched.
pub static SOURCE_HEADER: LazyLock<String> =
    LazyLock::new(|| format!("x-{}-relay-source", crate::brand::SLUG));

/// 32 random bytes per launch, never written anywhere.
static SECRET: LazyLock<String> = LazyLock::new(|| {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        // No randomness: no secret anyone could match (the header is
        // compared only against a non-empty value).
        return String::new();
    }
    hex::encode(bytes)
});

pub(crate) fn secret() -> &'static str {
    SECRET.as_str()
}

/// The request came through a relay channel of this app: its secret header
/// is this launch's, compared in constant time. Anything else (a header a
/// tailnet device set, a local process guessing) is an ordinary request.
pub fn secret_ok(headers: &HeaderMap) -> bool {
    let want = secret();
    if want.is_empty() {
        return false;
    }
    let Some(got) = headers.get(SECRET_HEADER.as_str()) else {
        return false;
    };
    super::pairing::constant_time_eq(got.as_bytes(), want.as_bytes())
}

/// The per-source key of a relayed request (only after [`secret_ok`]).
pub fn source_of(headers: &HeaderMap) -> String {
    headers
        .get(SOURCE_HEADER.as_str())
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.starts_with("relay:") && v.len() <= 32)
        .map(str::to_string)
        .unwrap_or_else(|| "relay:?".into())
}

/// The relay this build talks to: `wss://host` (no path), or for a local
/// relay `ws://127.0.0.1:port` / `ws://localhost:port`. `None`: Tailscale only.
pub fn relay_url() -> Option<String> {
    let raw = match std::env::var(RELAY_URL_VAR.as_str()) {
        Ok(v) => v,
        Err(_) => crate::brand::links::RELAY?.to_string(),
    };
    usable_url(&raw)
}

fn usable_url(raw: &str) -> Option<String> {
    let url = raw.trim().trim_end_matches('/');
    let (secure, rest) = if let Some(rest) = url.strip_prefix("wss://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("ws://") {
        (false, rest)
    } else {
        return None;
    };
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) || rest.contains(char::is_whitespace)
    {
        return None;
    }
    let host = super::identity::host_of(url)?;
    // Plain ws:// only to this Mac itself: a relay anywhere else is wss.
    if !secure && host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    // As the phone checks it (`isRelayUrl`): a URL's scheme and host are
    // lowercase once parsed.
    Some(url.to_ascii_lowercase())
}

/// Where the Mac signs in.
pub fn mac_url(base: &str, fingerprint: &str) -> String {
    format!("{base}/v1/mac/{fingerprint}")
}

/// Where a phone reaches this Mac.
pub fn phone_url(base: &str, fingerprint: &str) -> String {
    format!("{base}/v1/phone/{fingerprint}")
}

/// The relay's sign-in page for one linking code (docs/relay.md,
/// "Accounts"): `https://<relay host>/link?code=…`, or plain `http` for a
/// local relay.
pub fn link_page_url(base: &str, code: &str) -> String {
    let web = match base.strip_prefix("wss://") {
        Some(rest) => format!("https://{rest}"),
        None => format!("http://{}", base.strip_prefix("ws://").unwrap_or(base)),
    };
    format!("{web}/link?code={code}")
}

/// Whether the Mac is signed in at the relay.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RelayState {
    /// No relay in this build, or phone access is off.
    #[default]
    Off,
    /// Trying to reach the relay and sign in (or waiting to try again).
    Connecting,
    /// Signed in at the relay right now.
    Connected,
}

/// The account this Mac's key is linked to at the relay, as the relay said
/// it (`ready` / `account` frames). The Mac keeps no account token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    /// The relay's word for it; `null` when the account has none it shares.
    pub email: Option<String>,
}

/// The relay's `account` value: an object with an `id`, or anything else
/// (`null`, absent, junk) for none.
pub fn parse_account(v: &serde_json::Value) -> Option<Account> {
    let clean = |s: &str, max: usize| -> Option<String> {
        let s = s.trim();
        (!s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)).then(|| s.to_string())
    };
    let id = clean(v.get("id")?.as_str()?, 128)?;
    let email = v
        .get("email")
        .and_then(serde_json::Value::as_str)
        .and_then(|e| clean(e, 320));
    Some(Account { id, email })
}

/// What the desk reads (`PhoneStatus.relay`).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub state: RelayState,
    /// Linked account, or `null`. Kept from the last time the relay said,
    /// through a reconnect; gone once the relay is off.
    pub account: Option<Account>,
}

/// What the desk asks the signed-in socket to say.
#[derive(Debug)]
pub(crate) enum Command {
    /// `{"t":"linkStart","code":…}`; the answer says it was sent.
    LinkStart(String, oneshot::Sender<bool>),
    /// `{"t":"unlink"}`.
    Unlink(oneshot::Sender<bool>),
    /// `{"t":"deleteAccount"}`; answered by the relay's `accountDeleted`
    /// once the account is gone at the sign-in service (or why it isn't).
    DeleteAccount(oneshot::Sender<Result<(), String>>),
}

#[derive(Debug)]
struct Up {
    base: String,
    fingerprint: String,
    /// `<relay>/v1/phone/<fingerprint>`.
    phone_url: String,
    host: String,
    commands: mpsc::Sender<Command>,
}

#[derive(Debug, Default)]
struct Inner {
    /// The client is running (connecting or connected).
    running: bool,
    up: Option<Up>,
    account: Option<Account>,
}

/// One relay link's state. The app has one ([`LINK`]); a test makes its own.
#[derive(Debug, Default)]
pub struct Link {
    inner: Mutex<Inner>,
}

/// How long the desk waits for the socket to take a command.
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

const NOT_CONNECTED: &str =
    "This Mac isn't connected to the relay right now. Check the internet connection and try again in a moment.";

impl Link {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The client started: connecting.
    pub(crate) fn set_running(&self) {
        self.lock().running = true;
    }

    /// The client stopped: nothing is known about the relay any more.
    /// True when this changed what the desk shows.
    pub(crate) fn set_off(&self) -> bool {
        let mut inner = self.lock();
        let changed = inner.running || inner.up.is_some() || inner.account.is_some();
        *inner = Inner::default();
        changed
    }

    /// Signed in, with the account the relay named. True when this changed it.
    pub(crate) fn set_up(
        &self,
        base: &str,
        fingerprint: &str,
        account: Option<Account>,
        commands: mpsc::Sender<Command>,
    ) -> bool {
        let Some(host) = super::identity::host_of(base) else {
            return false;
        };
        let mut inner = self.lock();
        let changed = inner.up.is_none() || inner.account != account;
        inner.running = true;
        inner.up = Some(Up {
            base: base.to_string(),
            fingerprint: fingerprint.to_string(),
            phone_url: phone_url(base, fingerprint),
            host,
            commands,
        });
        inner.account = account;
        changed
    }

    /// The socket went; the client tries again. True when this changed it.
    pub(crate) fn set_down(&self) -> bool {
        self.lock().up.take().is_some()
    }

    /// The relay said the account changed. True when it did.
    pub(crate) fn set_account(&self, account: Option<Account>) -> bool {
        let mut inner = self.lock();
        if inner.account == account {
            return false;
        }
        inner.account = account;
        true
    }

    pub fn status(&self) -> RelayStatus {
        let inner = self.lock();
        let state = match (&inner.up, inner.running) {
            (Some(_), _) => RelayState::Connected,
            (None, true) => RelayState::Connecting,
            (None, false) => RelayState::Off,
        };
        RelayStatus {
            state,
            account: inner.account.clone(),
        }
    }

    /// Signed in at the relay with an account: phones can come this way
    /// (the relay refuses phones for a Mac with no account, 4402).
    pub fn usable(&self) -> bool {
        let inner = self.lock();
        inner.up.is_some() && inner.account.is_some()
    }

    /// The relay route, while the link is up and an account is linked.
    pub fn route(&self) -> Option<Route> {
        let inner = self.lock();
        inner.account.as_ref()?;
        inner.up.as_ref().map(|u| Route {
            kind: RouteKind::Relay,
            url: u.phone_url.clone(),
            pin: None,
        })
    }

    /// The relay's host, signed among the Mac's hosts while the link is up.
    pub fn host(&self) -> Option<String> {
        self.lock().up.as_ref().map(|u| u.host.clone())
    }

    async fn command(
        &self,
        make: impl FnOnce(oneshot::Sender<bool>) -> Command,
    ) -> Result<String, &'static str> {
        let (tx, base) = {
            let inner = self.lock();
            let up = inner.up.as_ref().ok_or(NOT_CONNECTED)?;
            (up.commands.clone(), up.base.clone())
        };
        let (ack_tx, ack) = oneshot::channel();
        tx.send(make(ack_tx)).await.map_err(|_| NOT_CONNECTED)?;
        match tokio::time::timeout(COMMAND_TIMEOUT, ack).await {
            Ok(Ok(true)) => Ok(base),
            _ => Err(NOT_CONNECTED),
        }
    }

    /// Start linking this Mac to an account: a fresh one-time code goes to
    /// the relay on the signed-in socket, and the page to sign in on comes
    /// back for the browser.
    pub async fn link_start(&self) -> Result<String, &'static str> {
        let fingerprint = {
            let inner = self.lock();
            inner.up.as_ref().ok_or(NOT_CONNECTED)?.fingerprint.clone()
        };
        let code = new_link_code(&fingerprint)
            .ok_or("This Mac couldn't make a sign-in code. Try again.")?;
        let base = self
            .command(|ack| Command::LinkStart(code.clone(), ack))
            .await?;
        Ok(link_page_url(&base, &code))
    }

    /// Unlink this Mac from its account at the relay.
    pub async fn unlink(&self) -> Result<(), &'static str> {
        self.command(Command::Unlink).await?;
        Ok(())
    }

    /// Delete the account this Mac is signed in to: the relay removes it at
    /// the sign-in service (email and id) and unlinks this Mac. Other Macs
    /// on the same account are unlinked the next time they connect.
    pub async fn delete_account(&self) -> Result<(), String> {
        let tx = {
            let inner = self.lock();
            let up = inner.up.as_ref().ok_or_else(|| NOT_CONNECTED.to_string())?;
            if inner.account.is_none() {
                return Err("This Mac isn't signed in.".into());
            }
            up.commands.clone()
        };
        let (done_tx, done) = oneshot::channel();
        tx.send(Command::DeleteAccount(done_tx))
            .await
            .map_err(|_| NOT_CONNECTED.to_string())?;
        match tokio::time::timeout(DELETE_TIMEOUT, done).await {
            Ok(Ok(result)) => result,
            _ => Err("The sign-in service didn't answer. Your account is still there; try again.".into()),
        }
    }
}

/// How long deleting an account may take at the relay and Clerk.
const DELETE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// A linking code, as the relay reads it (`services/relay/src/link.ts`):
/// `<fingerprint>.<32 random bytes, base64url>`. The fingerprint finds this
/// Mac's slot (it is no secret: it's in every pairing code); the random half
/// is the secret, single use, ten minutes.
fn new_link_code(fingerprint: &str) -> Option<String> {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok()?;
    let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    Some(format!("{fingerprint}.{secret}"))
}

/// The app's relay link.
pub static LINK: LazyLock<Arc<Link>> = LazyLock::new(|| Arc::new(Link::default()));

/// [`Link::status`] of the app's link.
pub fn status() -> RelayStatus {
    LINK.status()
}

/// [`Link::link_start`] on the app's link: the sign-in page's address.
pub async fn link_start() -> Result<String, &'static str> {
    LINK.link_start().await
}

/// [`Link::unlink`] on the app's link.
pub async fn unlink() -> Result<(), &'static str> {
    LINK.unlink().await
}

/// [`Link::delete_account`] on the app's link.
pub async fn delete_account() -> Result<(), String> {
    LINK.delete_account().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_bare_relay_address_is_used() {
        assert_eq!(
            usable_url("wss://Relay.Example.com/").as_deref(),
            Some("wss://relay.example.com")
        );
        assert_eq!(
            usable_url("ws://127.0.0.1:8787").as_deref(),
            Some("ws://127.0.0.1:8787")
        );
        for bad in [
            "",
            "https://relay.example.com",
            "wss://relay.example.com/v1",
            "wss://user@relay.example.com",
            "ws://relay.example.com",
            "wss://",
        ] {
            assert_eq!(usable_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_secret_header_must_be_this_launchs() {
        let mut h = HeaderMap::new();
        assert!(!secret_ok(&h));
        h.insert(SECRET_HEADER.as_str(), "nope".parse().unwrap());
        assert!(!secret_ok(&h));
        h.insert(SECRET_HEADER.as_str(), secret().parse().unwrap());
        assert!(secret_ok(&h));
        assert_eq!(secret().len(), 64);
    }

    #[test]
    fn the_link_page_is_the_relays_own_web_address() {
        assert_eq!(
            link_page_url("wss://relay.example.com", "abc"),
            "https://relay.example.com/link?code=abc"
        );
        assert_eq!(
            link_page_url("ws://127.0.0.1:8787", "abc"),
            "http://127.0.0.1:8787/link?code=abc"
        );
        let code = new_link_code("ajgD1fBZkCocba-8m6Rykg").unwrap();
        let (fp, secret) = code.split_once('.').unwrap();
        assert_eq!(fp, "ajgD1fBZkCocba-8m6Rykg");
        assert_eq!(secret.len(), 43);
    }

    #[test]
    fn an_account_is_an_id_or_nothing() {
        use serde_json::json;
        assert_eq!(
            parse_account(&json!({ "id": "user_1", "email": "j@x.com" })),
            Some(Account {
                id: "user_1".into(),
                email: Some("j@x.com".into())
            })
        );
        assert_eq!(
            parse_account(&json!({ "id": "user_1", "email": null }))
                .unwrap()
                .email,
            None
        );
        assert_eq!(parse_account(&json!(null)), None);
        assert_eq!(parse_account(&json!({ "email": "j@x.com" })), None);
        assert_eq!(parse_account(&json!({ "id": "" })), None);
        assert_eq!(parse_account(&json!({ "id": "a\nb" })), None);
    }

    #[test]
    fn the_route_needs_the_link_up_and_an_account() {
        let link = Link::default();
        let (tx, _rx) = mpsc::channel(1);
        assert_eq!(link.status().state, RelayState::Off);
        link.set_running();
        assert_eq!(link.status().state, RelayState::Connecting);
        assert!(link.route().is_none() && link.host().is_none());

        assert!(link.set_up("wss://relay.example.com", "fp", None, tx.clone()));
        assert_eq!(link.status().state, RelayState::Connected);
        assert_eq!(link.host().as_deref(), Some("relay.example.com"));
        assert!(
            link.route().is_none(),
            "no account: the relay turns phones away"
        );
        assert!(!link.usable());

        let account = Account {
            id: "user_1".into(),
            email: Some("j@x.com".into()),
        };
        assert!(link.set_account(Some(account.clone())));
        assert!(!link.set_account(Some(account.clone())));
        let route = link.route().unwrap();
        assert_eq!(route.kind, RouteKind::Relay);
        assert_eq!(route.url, "wss://relay.example.com/v1/phone/fp");
        assert!(link.usable());

        // Down: no route, the account kept through the reconnect.
        assert!(link.set_down());
        let s = link.status();
        assert_eq!(s.state, RelayState::Connecting);
        assert_eq!(s.account, Some(account));
        assert!(link.route().is_none() && link.host().is_none());

        assert!(link.set_off());
        assert_eq!(link.status(), RelayStatus::default());
    }

    #[test]
    fn the_desk_reads_state_and_account() {
        let s = RelayStatus {
            state: RelayState::Connected,
            account: Some(Account {
                id: "user_1".into(),
                email: Some("j@x.com".into()),
            }),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "state": "connected", "account": { "id": "user_1", "email": "j@x.com" } })
        );
        assert_eq!(
            serde_json::to_value(RelayStatus::default()).unwrap(),
            serde_json::json!({ "state": "off", "account": null })
        );
    }
}
