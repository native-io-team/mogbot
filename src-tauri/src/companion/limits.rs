//! What keeps one caller from taking the server (or the Mac) down for
//! everyone: connection and per-source caps, who a request came from, the
//! browser and Host checks, and failed-connection audit lines folded into
//! one a minute per source.
//!
//! The listener is on loopback and every tailnet request arrives through
//! `tailscaled`, so the peer address is always 127.0.0.1. Who a request is
//! *from* comes from the headers `tailscale serve` sets
//! (`Tailscale-User-Login`, `X-Forwarded-For`). A local process can forge
//! those, which only moves it to another per-source bucket: the global caps
//! hold whatever it claims.

use hyper::{header, HeaderMap};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

/// Connections open at once, of any kind. Far above what one phone needs
/// (tailscaled keeps a few to us, plus the sockets), far below the 256 file
/// descriptors macOS gives an app by default, which PTYs, git and the
/// agents share.
pub const MAX_CONNECTIONS: usize = 64;
/// Requests in flight from one source (an open WebSocket counts as one).
pub const MAX_PER_SOURCE: usize = 32;
/// Uploads in flight from one device.
pub const MAX_UPLOADS_PER_DEVICE: usize = 3;
/// Thumbnails being decoded at once, across every phone.
pub const MAX_THUMBNAILS_AT_ONCE: usize = 2;
/// `agents.memorySuggest` runs at once (each starts a model process).
pub const MAX_SUGGESTS_AT_ONCE: usize = 2;
/// Sources remembered for folding failed-connection lines; past it, the
/// rest share one bucket so the map can't be grown without bound.
const MAX_REFUSAL_SOURCES: usize = 256;
const MINUTE_MS: u64 = 60_000;

/// In-flight counts per key, each capped.
#[derive(Default)]
pub struct Counter {
    counts: Arc<Mutex<HashMap<String, usize>>>,
}

/// One unit of a [`Counter`], given back on drop.
pub struct Slot {
    counts: Arc<Mutex<HashMap<String, usize>>>,
    key: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = counts.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

impl Counter {
    /// A slot for `key` while it has fewer than `cap` out.
    pub fn try_take(&self, key: &str, cap: usize) -> Option<Slot> {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        let n = counts.entry(key.to_string()).or_insert(0);
        if *n >= cap {
            return None;
        }
        *n += 1;
        Some(Slot {
            counts: self.counts.clone(),
            key: key.to_string(),
        })
    }

    pub fn in_flight(&self, key: &str) -> usize {
        let counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        counts.get(key).copied().unwrap_or(0)
    }
}

/// Who sent a request: the tailnet user if `tailscale serve` named one, else
/// the tailnet address it forwarded for, else the peer itself.
pub fn source_of(peer: Option<SocketAddr>, headers: &HeaderMap) -> String {
    if let Some(login) = tailnet_login(headers) {
        return format!("user:{login}");
    }
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 64);
    match (forwarded, peer) {
        (Some(ip), _) => format!("ip:{ip}"),
        (None, Some(peer)) => format!("ip:{}", peer.ip()),
        (None, None) => "unknown".into(),
    }
}

/// `Tailscale-User-Login`, which `tailscale serve` sets for a request from a
/// user's device (not a tagged one), cleaned to one short line.
pub fn tailnet_login(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("tailscale-user-login")?.to_str().ok()?.trim();
    let ok = !raw.is_empty() && raw.len() <= 128 && raw.chars().all(|c| c.is_ascii_graphic());
    ok.then(|| raw.to_string())
}

/// The host part of a `Host` header (or an origin's authority), lowercased,
/// without the port.
fn host_only(authority: &str) -> String {
    let a = authority.trim().to_ascii_lowercase();
    if let Some(rest) = a.strip_prefix('[') {
        // [::1]:port
        return rest.split(']').next().unwrap_or("").to_string();
    }
    a.rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map(|(h, _)| h.to_string())
        .unwrap_or(a)
}

/// The names this server answers to: the Mac's tailnet name (anything under
/// `.ts.net`, which only `tailscale serve` can bring here) or loopback. Any
/// other Host is a page in a browser that pointed its own domain at
/// 127.0.0.1 (DNS rebinding), and is refused.
pub fn host_allowed(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let h = host_only(host);
    let label_ok = |l: &str| {
        !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    let tailnet = h
        .strip_suffix(".ts.net")
        .is_some_and(|rest| rest.split('.').all(label_ok));
    tailnet || h == "localhost" || h == "127.0.0.1" || h == "::1"
}

/// Browsers send `Origin` on every WebSocket and on cross-site POSTs; the
/// app's own WebSocket (React Native's, on both platforms) sends the
/// server's own origin, and its `fetch` none. So a request may carry no
/// Origin, or one naming the very host it was sent to. Anything else (a web
/// page, `null` from a sandboxed frame or a file) is refused.
pub fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(origin) = origin.to_str().ok() else {
        return false;
    };
    let Some(authority) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = authority.trim_end_matches('/').to_ascii_lowercase();
    let same = |name: header::HeaderName| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|h| h.trim().eq_ignore_ascii_case(&authority))
    };
    // `tailscale serve` keeps the Host; X-Forwarded-Host covers a proxy
    // that doesn't. A browser can't set either on a WebSocket.
    same(header::HOST) || same(header::HeaderName::from_static("x-forwarded-host"))
}

/// Failed connections, written to the audit log once per source per
/// minute: the first as it happens, the rest as a count when the minute is
/// over. Thousands of bad hellos then cost a line a minute, not a line
/// each, and can't roll the record of what a real token did out of the log.
#[derive(Default)]
pub struct RefusalLog {
    windows: Mutex<HashMap<String, Window>>,
}

struct Window {
    started: u64,
    /// Failures after the first, not yet written.
    more: u64,
    what: String,
}

/// An audit line to write: (detail, source).
pub type Line = String;

impl RefusalLog {
    /// Note one failure. Returns the lines to write now: a count for a
    /// minute that ended, and this failure if it starts a new minute.
    pub fn note(&self, source: &str, what: &str, now: u64) -> Vec<Line> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let mut lines = Vec::new();
        let key = if windows.contains_key(source) || windows.len() < MAX_REFUSAL_SOURCES {
            source.to_string()
        } else {
            "other sources".to_string()
        };
        match windows.get_mut(&key) {
            Some(w) if now.saturating_sub(w.started) < MINUTE_MS => {
                w.more += 1;
                return lines;
            }
            Some(w) => {
                if w.more > 0 {
                    lines.push(count_line(w.more, &w.what, &key));
                }
            }
            None => {}
        }
        windows.insert(
            key.clone(),
            Window {
                started: now,
                more: 0,
                what: what.to_string(),
            },
        );
        lines.push(format!("{what} ({key})"));
        lines
    }

    /// Counts for every minute that has ended; called on a timer so the
    /// last burst is written even if nothing follows it.
    pub fn flush(&self, now: u64) -> Vec<Line> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let mut lines = Vec::new();
        windows.retain(|key, w| {
            if now.saturating_sub(w.started) < MINUTE_MS {
                return true;
            }
            if w.more > 0 {
                lines.push(count_line(w.more, &w.what, key));
            }
            false
        });
        lines
    }
}

fn count_line(n: u64, what: &str, source: &str) -> Line {
    format!("{n} more failed connections from {source} in the last minute (first: {what})")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn counters_cap_and_give_back() {
        let c = Counter::default();
        let a = c.try_take("x", 2).unwrap();
        let _b = c.try_take("x", 2).unwrap();
        assert!(c.try_take("x", 2).is_none());
        assert!(c.try_take("y", 2).is_some(), "per key");
        drop(a);
        assert_eq!(c.in_flight("x"), 1);
        assert!(c.try_take("x", 2).is_some());
    }

    #[test]
    fn a_source_is_the_tailnet_user_then_the_forwarded_address() {
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        assert_eq!(
            source_of(Some(peer), &headers(&[("tailscale-user-login", "j@x.com")])),
            "user:j@x.com"
        );
        assert_eq!(
            source_of(
                Some(peer),
                &headers(&[("x-forwarded-for", "100.64.0.7, 10.0.0.1")])
            ),
            "ip:100.64.0.7"
        );
        assert_eq!(source_of(Some(peer), &HeaderMap::new()), "ip:127.0.0.1");
    }

    #[test]
    fn only_the_tailnet_name_or_loopback_is_a_host() {
        let ok = |h: &str| host_allowed(&headers(&[("host", h)]));
        assert!(ok("julians-mbp.tail1234.ts.net:47443"));
        assert!(ok("127.0.0.1:1801"));
        assert!(ok("localhost"));
        assert!(ok("[::1]:1801"));
        assert!(!ok("attacker.example:1801"), "DNS rebinding");
        assert!(!ok("ts.net.attacker.example"));
        assert!(!ok("evil_.ts.net"));
        assert!(!host_allowed(&HeaderMap::new()), "no Host at all");
    }

    #[test]
    fn browsers_are_refused_and_the_app_is_not() {
        let host = ("host", "mac.tail1.ts.net:47443");
        assert!(origin_allowed(&headers(&[host])), "fetch sends none");
        assert!(
            origin_allowed(&headers(&[
                host,
                ("origin", "https://mac.tail1.ts.net:47443")
            ])),
            "React Native's WebSocket sends the server's own origin"
        );
        assert!(!origin_allowed(&headers(&[
            host,
            ("origin", "https://evil.example")
        ])));
        assert!(!origin_allowed(&headers(&[host, ("origin", "null")])));
        assert!(!origin_allowed(&headers(&[
            host,
            ("origin", "https://evil.tail9.ts.net")
        ])));
        let local = ("host", "127.0.0.1:1801");
        assert!(!origin_allowed(&headers(&[
            local,
            ("origin", "http://localhost:3000")
        ])));
        assert!(origin_allowed(&headers(&[
            local,
            ("origin", "https://mac.tail1.ts.net:47443"),
            ("x-forwarded-host", "mac.tail1.ts.net:47443"),
        ])));
    }

    #[test]
    fn failures_are_one_line_a_minute_per_source() {
        let log = RefusalLog::default();
        let first = log.note("ip:1", "an unknown device tried to connect", 0);
        assert_eq!(first.len(), 1);
        for t in 1..500 {
            assert!(log
                .note("ip:1", "an unknown device tried to connect", t)
                .is_empty());
        }
        assert_eq!(log.note("ip:2", "x", 10).len(), 1, "per source");
        assert!(log.flush(30_000).is_empty(), "the minute isn't over");
        let flushed = log.flush(60_001);
        assert_eq!(flushed.len(), 1);
        assert!(flushed[0].starts_with("499 more failed connections from ip:1"));
        // A new minute starts with a line of its own.
        assert_eq!(log.note("ip:1", "x", 60_002).len(), 1);
    }

    #[test]
    fn a_flood_of_sources_shares_one_bucket() {
        let log = RefusalLog::default();
        let mut lines = 0;
        for i in 0..10_000 {
            lines += log.note(&format!("ip:{i}"), "x", 0).len();
        }
        assert_eq!(lines, MAX_REFUSAL_SOURCES + 1);
    }
}
