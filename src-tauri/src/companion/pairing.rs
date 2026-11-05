//! Pairing: a one-time code in a QR code, then a click at the desk.
//!
//! The code is 128 bits, lives five minutes, and is good for one request.
//! Using it doesn't pair anything by itself: the Mac shows who is asking and
//! waits for Allow, so a QR code photographed over a shoulder gets a stranger
//! a "Deny" button, not your agents. Only on Allow is a device token issued,
//! and only its SHA-256 is kept.
//!
//! Wrong codes are limited per source with a growing wait, not counted
//! against the code: 128 bits can't be guessed, so a lockout would only let
//! anyone who can reach the port burn the code the real phone is holding.
//!
//! The desk answers one *request*, by id: a decision made while looking at
//! one phone can't land on another that arrived meanwhile.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

use super::wire::PairDevice;

pub const CODE_TTL_MS: u64 = 5 * 60 * 1000;
/// How long a request waits for Allow or Deny at the Mac.
pub const DECISION_TIMEOUT: Duration = Duration::from_secs(120);
/// Wrong codes a source may try before it has to wait between tries.
pub const FREE_FAILURES: u32 = 3;
/// The wait after the free tries: doubling from this, up to [`MAX_BACKOFF_MS`].
pub const FIRST_BACKOFF_MS: u64 = 1_000;
pub const MAX_BACKOFF_MS: u64 = 5 * 60 * 1000;
/// A wrong code is answered this late, as Remote Access does.
pub const WRONG_CODE_DELAY: Duration = Duration::from_millis(400);
/// Sources remembered for backoff; past it the oldest are forgotten.
const MAX_SOURCES: usize = 1024;

/// 128 bits from the OS RNG, base32 without padding (26 characters).
pub fn new_code() -> String {
    let mut bytes = [0u8; 16];
    // As for remote access tokens: no RNG, no safe code, and a predictable
    // one would be worse than refusing.
    #[allow(clippy::expect_used)]
    getrandom::getrandom(&mut bytes).expect("the OS random number generator is unavailable");
    data_encoding::BASE32_NOPAD.encode(&bytes)
}

/// A device token: 256 bits, hex. Shown nowhere; the phone keeps it in its keychain.
pub fn new_token() -> String {
    crate::remote_access::new_token()
}

/// What the Mac stores in place of a token.
pub fn hash_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    crate::remote_access::server::constant_time_eq(a, b)
}

/// The code's last four characters: shown on both the phone and the desk so
/// the person can see they're answering the code they just scanned.
pub fn code_hint(code: &str) -> String {
    let chars: Vec<char> = code.chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

struct ActiveCode {
    code: String,
    expires_at: u64,
    used: bool,
}

/// What the desk decided about one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Deny,
    /// Allow, revoking the paired phones listed (ids the desk was shown).
    Allow {
        replace: Vec<String>,
    },
}

struct Request {
    id: String,
    device: PairDevice,
    public_key: String,
    requested_at: u64,
    code_hint: String,
    login: Option<String>,
    decide: oneshot::Sender<Decision>,
}

#[derive(Default)]
struct Failures {
    count: u32,
    /// No more tries from this source before this (ms).
    wait_until: u64,
    last: u64,
}

#[derive(Default)]
struct State {
    code: Option<ActiveCode>,
    request: Option<Request>,
    failures: HashMap<String, Failures>,
}

/// The outcome of presenting a code.
#[derive(Debug)]
pub enum Claim {
    /// No such code, or this source is waiting out its backoff. Answered
    /// with a bare 404 after a delay either way.
    NoMatch,
    Expired,
    Used,
    /// Waiting for the desk.
    Waiting(oneshot::Receiver<Decision>),
}

/// The phone waiting at the desk, as the Phone panel shows it.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    /// Passed back with Allow or Deny, so the answer lands on this request.
    pub id: String,
    /// Name and model as the phone gave them, cleaned of invisible and
    /// control characters (`clean_pair_device`).
    pub device: PairDevice,
    pub requested_at: u64,
    /// The last four characters of the code it used.
    pub code_hint: String,
    /// The tailnet user `tailscale serve` named, when it named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// Paired phones with the same name, platform and model: what the desk
    /// offers to replace, never replaces by itself. Filled in by the Phone
    /// panel's status, which has the registry.
    pub replaces: Vec<super::wire::Device>,
}

/// What the Phone panel shows about pairing right now.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// A code is out and can still be used.
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// A phone used the code and is waiting for Allow or Deny.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestView>,
}

#[derive(Default)]
pub struct Pairing {
    state: Mutex<State>,
}

impl Pairing {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Issue a new code, replacing any earlier one. A request still waiting
    /// on the old code is denied: the person at the Mac started over.
    pub fn start(&self, now_ms: u64) -> (String, u64) {
        let code = new_code();
        let expires_at = now_ms + CODE_TTL_MS;
        let mut s = self.state();
        if let Some(r) = s.request.take() {
            let _ = r.decide.send(Decision::Deny);
        }
        s.failures.clear();
        s.code = Some(ActiveCode {
            code: code.clone(),
            expires_at,
            used: false,
        });
        (code, expires_at)
    }

    /// Withdraw the code and deny anything waiting on it.
    pub fn cancel(&self) {
        let mut s = self.state();
        s.code = None;
        if let Some(r) = s.request.take() {
            let _ = r.decide.send(Decision::Deny);
        }
    }

    /// `source` presents `given`. Compared in constant time. A source that
    /// keeps getting it wrong waits longer and longer between tries; the
    /// code itself is never burnt by somebody else's guesses.
    pub fn claim(
        &self,
        given: &str,
        device: PairDevice,
        public_key: String,
        source: &str,
        login: Option<String>,
        now_ms: u64,
    ) -> Claim {
        let mut s = self.state();
        if s.failures
            .get(source)
            .is_some_and(|f| now_ms < f.wait_until)
        {
            return Claim::NoMatch;
        }
        let matches = s
            .code
            .as_ref()
            .is_some_and(|a| constant_time_eq(given.trim().as_bytes(), a.code.as_bytes()));
        if !matches {
            note_failure(&mut s.failures, source, now_ms);
            return Claim::NoMatch;
        }
        let Some(active) = s.code.as_mut() else {
            return Claim::NoMatch;
        };
        if active.used {
            return Claim::Used;
        }
        if now_ms > active.expires_at {
            s.code = None;
            return Claim::Expired;
        }
        active.used = true;
        let hint = code_hint(&active.code);
        let (tx, rx) = oneshot::channel();
        let request = Request {
            id: format!("pr_{}", uuid::Uuid::new_v4().simple()),
            device: super::clean_pair_device(&device),
            public_key,
            requested_at: now_ms,
            code_hint: hint,
            login,
            decide: tx,
        };
        if let Some(earlier) = s.request.replace(request) {
            let _ = earlier.decide.send(Decision::Deny);
        }
        Claim::Waiting(rx)
    }

    /// Allow or Deny at the desk, for the request with `request_id`.
    /// Returns the device that was waiting, with its public key, when that
    /// request is still the one waiting and still listening; `None` when
    /// it's gone or another one has taken its place.
    pub fn decide(&self, request_id: &str, decision: Decision) -> Option<(PairDevice, String)> {
        let mut s = self.state();
        if s.request.as_ref().map(|r| r.id.as_str()) != Some(request_id) {
            return None;
        }
        // The code stays, marked used, so a second scan hears "already used".
        let request = s.request.take()?;
        let device = request.device.clone();
        let key = request.public_key.clone();
        request.decide.send(decision).ok().map(|_| (device, key))
    }

    /// The phone gave up waiting (timeout or disconnect).
    pub fn abandon(&self) {
        let mut s = self.state();
        if s.request.as_ref().is_some_and(|r| r.decide.is_closed()) {
            s.request = None;
        }
    }

    /// Whether a code is out, and who is waiting at the desk.
    pub fn view(&self, now_ms: u64) -> PairingView {
        let s = self.state();
        let code = s
            .code
            .as_ref()
            .filter(|c| !c.used && now_ms <= c.expires_at);
        PairingView {
            active: code.is_some(),
            expires_at: code.map(|c| c.expires_at),
            request: s
                .request
                .as_ref()
                .filter(|r| !r.decide.is_closed())
                .map(|r| RequestView {
                    id: r.id.clone(),
                    device: r.device.clone(),
                    requested_at: r.requested_at,
                    code_hint: r.code_hint.clone(),
                    login: r.login.clone(),
                    replaces: Vec::new(),
                }),
        }
    }
}

fn note_failure(all: &mut HashMap<String, Failures>, source: &str, now_ms: u64) {
    if all.len() >= MAX_SOURCES && !all.contains_key(source) {
        // Forget the source that has been quiet longest.
        if let Some(oldest) = all
            .iter()
            .min_by_key(|(_, f)| f.last)
            .map(|(k, _)| k.clone())
        {
            all.remove(&oldest);
        }
    }
    let f = all.entry(source.to_string()).or_default();
    f.count += 1;
    f.last = now_ms;
    if f.count > FREE_FAILURES {
        let doublings = (f.count - FREE_FAILURES - 1).min(20);
        let wait = FIRST_BACKOFF_MS
            .saturating_mul(1u64 << doublings)
            .min(MAX_BACKOFF_MS);
        f.wait_until = now_ms + wait;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::wire::{BuildKind, DevicePlatform};

    fn phone() -> PairDevice {
        PairDevice {
            name: "Julian’s iPhone".into(),
            platform: DevicePlatform::Ios,
            model: Some("iPhone 16".into()),
            app_version: "1.0.0".into(),
            build: BuildKind::Official,
        }
    }

    const SRC: &str = "ip:100.64.0.2";

    fn claim(p: &Pairing, code: &str, now: u64) -> Claim {
        p.claim(code, phone(), "pk".into(), SRC, None, now)
    }

    fn request_id(p: &Pairing) -> String {
        p.view(0).request.expect("a request waiting").id
    }

    #[test]
    fn codes_are_128_bit_base32() {
        let a = new_code();
        assert_eq!(a.len(), 26);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)));
        assert_ne!(a, new_code());
        assert_eq!(code_hint("ABCDEFGH"), "EFGH");
        assert_eq!(code_hint("AB"), "AB");
    }

    #[test]
    fn tokens_are_stored_as_sha256_only() {
        let token = new_token();
        assert_eq!(token.len(), 64);
        let hash = hash_token(&token);
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, token);
        assert_eq!(hash, hash_token(&token), "deterministic");
        assert_ne!(hash, hash_token(&new_token()));
        // A known vector, so the scheme can't drift silently.
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn a_code_works_once_and_only_after_allow() {
        let p = Pairing::default();
        let (code, expires) = p.start(1_000);
        assert_eq!(expires, 1_000 + CODE_TTL_MS);
        let Claim::Waiting(rx) = claim(&p, &code, 2_000) else {
            panic!("expected to wait for the desk")
        };
        assert!(matches!(claim(&p, &code, 2_001), Claim::Used));
        let view = p.view(2_002);
        assert!(!view.active, "a used code isn't offered again");
        let req = view.request.unwrap();
        assert_eq!(req.device.name, "Julian’s iPhone");
        assert_eq!(req.code_hint, code_hint(&code));
        assert_eq!(req.requested_at, 2_000);
        let (device, key) = p
            .decide(&req.id, Decision::Allow { replace: vec![] })
            .unwrap();
        assert_eq!(device.name, "Julian’s iPhone");
        assert_eq!(key, "pk");
        assert_eq!(rx.await.unwrap(), Decision::Allow { replace: vec![] });
        assert!(matches!(claim(&p, &code, 2_003), Claim::Used));
    }

    #[tokio::test]
    async fn deny_and_cancel_say_no() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let Claim::Waiting(rx) = claim(&p, &code, 1) else {
            panic!()
        };
        assert!(p.decide(&request_id(&p), Decision::Deny).is_some());
        assert_eq!(rx.await.unwrap(), Decision::Deny);

        let (code, _) = p.start(0);
        let Claim::Waiting(rx) = claim(&p, &code, 1) else {
            panic!()
        };
        p.cancel();
        assert_eq!(rx.await.unwrap(), Decision::Deny);
    }

    #[tokio::test]
    async fn an_answer_lands_only_on_the_request_it_was_given_for() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let Claim::Waiting(_rx) = claim(&p, &code, 1) else {
            panic!()
        };
        let shown = request_id(&p);
        // A new code (and so a new request) arrives before the click lands.
        let (code2, _) = p.start(2);
        let Claim::Waiting(rx2) = claim(&p, &code2, 3) else {
            panic!()
        };
        assert!(
            p.decide(&shown, Decision::Allow { replace: vec![] })
                .is_none(),
            "Allow for the request on screen doesn't allow a different one"
        );
        assert!(p.view(4).request.is_some(), "the new one still waits");
        drop(rx2);
    }

    #[test]
    fn codes_expire_after_five_minutes() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        assert!(!p.view(CODE_TTL_MS + 1).active);
        assert!(matches!(claim(&p, &code, CODE_TTL_MS + 1), Claim::Expired));
    }

    #[test]
    fn wrong_guesses_slow_their_source_and_never_burn_the_code() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let wrong = "WRONGWRONGWRONGWRONGWRONGW";
        for i in 0..50 {
            assert!(matches!(
                p.claim(wrong, phone(), String::new(), "ip:attacker", None, i),
                Claim::NoMatch
            ));
        }
        // The guesser now waits, even with the right code.
        assert!(matches!(
            p.claim(&code, phone(), String::new(), "ip:attacker", None, 60),
            Claim::NoMatch
        ));
        // The real phone, from its own address, still gets in.
        assert!(matches!(
            p.claim(&code, phone(), String::new(), SRC, None, 61),
            Claim::Waiting(_)
        ));
    }

    #[test]
    fn the_wait_doubles_after_the_free_tries() {
        let mut f = HashMap::new();
        for _ in 0..FREE_FAILURES {
            note_failure(&mut f, "s", 0);
        }
        assert_eq!(f["s"].wait_until, 0, "free tries");
        note_failure(&mut f, "s", 0);
        assert_eq!(f["s"].wait_until, FIRST_BACKOFF_MS);
        note_failure(&mut f, "s", 0);
        assert_eq!(f["s"].wait_until, FIRST_BACKOFF_MS * 2);
        for _ in 0..40 {
            note_failure(&mut f, "s", 0);
        }
        assert_eq!(f["s"].wait_until, MAX_BACKOFF_MS);
        for i in 0..(MAX_SOURCES + 10) {
            note_failure(&mut f, &format!("x{i}"), i as u64 + 1);
        }
        assert!(f.len() <= MAX_SOURCES, "bounded");
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let p = Pairing::default();
        let (old, _) = p.start(0);
        let (new, _) = p.start(0);
        assert!(matches!(claim(&p, &old, 1), Claim::NoMatch));
        assert!(matches!(claim(&p, &new, 1), Claim::Waiting(_)));
    }

    #[test]
    fn a_phone_that_stopped_waiting_isnt_shown() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let Claim::Waiting(rx) = claim(&p, &code, 1) else {
            panic!()
        };
        let id = p.view(1).request.unwrap().id;
        drop(rx);
        assert!(p.view(2).request.is_none());
        assert!(
            p.decide(&id, Decision::Allow { replace: vec![] }).is_none(),
            "nobody to allow"
        );
    }

    #[test]
    fn the_desk_sees_a_cleaned_name() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let mut d = phone();
        d.name = "Julian’s iPhone\u{202E}\u{200B}".into();
        let _rx = p.claim(&code, d, String::new(), SRC, Some("j@x.com".into()), 1);
        let req = p.view(1).request.unwrap();
        assert_eq!(req.device.name, "Julian’s iPhone");
        assert_eq!(req.login.as_deref(), Some("j@x.com"));
    }
}
