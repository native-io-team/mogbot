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
    Some(url.to_string())
}

/// Where the Mac signs in.
pub fn mac_url(base: &str, fingerprint: &str) -> String {
    format!("{base}/v1/mac/{fingerprint}")
}

/// Where a phone reaches this Mac.
pub fn phone_url(base: &str, fingerprint: &str) -> String {
    format!("{base}/v1/phone/{fingerprint}")
}

/// What the desk and the routes read: whether the Mac's relay link is up.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    /// A relay is configured for this build (`links.relay` or the variable).
    pub configured: bool,
    /// Signed in at the relay right now: phones can reach this Mac through it.
    pub connected: bool,
    /// The relay's host (lowercase, no port), while connected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Default)]
struct Up {
    /// `<relay>/v1/phone/<fingerprint>`.
    phone_url: String,
    host: String,
}

/// One relay link's state. The app has one ([`LINK`]); a test makes its own.
#[derive(Debug, Default)]
pub struct Link {
    up: Mutex<Option<Up>>,
}

impl Link {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Up>> {
        self.up.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True when this changed it.
    fn set_up(&self, base: &str, fingerprint: &str) -> bool {
        let Some(host) = super::identity::host_of(base) else {
            return false;
        };
        let mut up = self.lock();
        let was = up.is_some();
        *up = Some(Up {
            phone_url: phone_url(base, fingerprint),
            host,
        });
        !was
    }

    /// True when this changed it.
    fn set_down(&self) -> bool {
        self.lock().take().is_some()
    }

    pub fn status(&self) -> RelayStatus {
        let up = self.lock();
        RelayStatus {
            configured: relay_url().is_some(),
            connected: up.is_some(),
            host: up.as_ref().map(|u| u.host.clone()),
        }
    }

    /// The relay route, while the link is up.
    pub fn route(&self) -> Option<Route> {
        self.lock().as_ref().map(|u| Route {
            kind: RouteKind::Relay,
            url: u.phone_url.clone(),
            pin: None,
        })
    }

    /// The relay's host, signed among the Mac's hosts while the link is up.
    pub fn host(&self) -> Option<String> {
        self.lock().as_ref().map(|u| u.host.clone())
    }
}

/// The app's relay link.
pub static LINK: LazyLock<Arc<Link>> = LazyLock::new(|| Arc::new(Link::default()));

/// [`Link::status`] of the app's link.
pub fn status() -> RelayStatus {
    LINK.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_bare_relay_address_is_used() {
        assert_eq!(
            usable_url("wss://relay.example.com/").as_deref(),
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
    fn the_link_offers_its_route_and_host_only_while_up() {
        let link = Link::default();
        assert!(link.route().is_none() && link.host().is_none());
        assert!(link.set_up("wss://Relay.Example.com", "fp"));
        let route = link.route().unwrap();
        assert_eq!(route.kind, RouteKind::Relay);
        assert_eq!(route.url, "wss://Relay.Example.com/v1/phone/fp");
        assert_eq!(link.host().as_deref(), Some("relay.example.com"));
        assert!(link.status().connected);
        assert!(link.set_down());
        assert!(!link.status().connected && link.route().is_none());
    }
}
