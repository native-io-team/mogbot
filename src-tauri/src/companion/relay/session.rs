//! A phone's session over the relay: what survives its socket dying
//! (docs/relay.md, "Sessions").
//!
//! The phone's socket going used to end its channel, and with it the Mac's
//! handler for that phone and every frame not yet acked. Here the protocol
//! frames are numbered and kept until the phone says it has them
//! ([`Session`]); a channel that ends unannounced hands its handler and
//! that state to a registry for [`GRACE`] ([`park`]); the same phone's next
//! socket, which proves it holds the session's resume key, takes them back
//! ([`claim`]). Everything is plaintext above the cipher, re-sealed under the
//! new channel's keys, so no nonce is ever reused.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::crypto::{resume_mac_ok, ResumeProof};

/// How long a parked session waits for its phone.
pub const GRACE: Duration = if cfg!(test) {
    Duration::from_secs(3)
} else {
    Duration::from_secs(120)
};
/// What either side keeps unacked before the session is given up.
pub const MAX_FRAMES: usize = 256;
pub const MAX_BYTES: usize = 4 * 1024 * 1024;
/// A frame taken is acked on our next frame, or alone after this many.
const ACK_EVERY: u32 = 8;
/// How long a returning phone waits for its dead-but-unnoticed channel to let go.
const YIELD_WAIT: Duration = Duration::from_secs(2);

/// The numbered frames of one session, both ways.
pub struct Session {
    pub sid: String,
    /// The current channel's resume key, and the one before (an answer may have been lost).
    pub key: [u8; 32],
    pub prev_key: Option<[u8; 32]>,
    last_k: u64,
    /// Last sequence sent / taken.
    tx: u64,
    rx: u64,
    unacked: VecDeque<(u64, String)>,
    bytes: usize,
    since_ack: u32,
}

/// What an incoming sealed protocol plaintext was.
#[derive(Debug, PartialEq, Eq)]
pub enum Taken {
    /// A protocol frame for the handler, and whether an ack is due.
    Frame(String, bool),
    /// An ack, or a repeat: nothing to deliver.
    Nothing,
    /// A hole, or something that isn't a session frame: end the session.
    Broken,
}

impl Session {
    pub fn new(key: [u8; 32]) -> Option<Self> {
        let mut raw = [0u8; 16];
        getrandom::getrandom(&mut raw).ok()?;
        Some(Session {
            sid: base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, raw),
            key,
            prev_key: None,
            last_k: 0,
            tx: 0,
            rx: 0,
            unacked: VecDeque::new(),
            bytes: 0,
            since_ack: 0,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn rx(&self) -> u64 {
        self.rx
    }

    fn frame(&self, n: u64, text: &str) -> String {
        json!({ "t": "q", "n": n, "a": self.rx, "d": text }).to_string()
    }

    /// Whether another frame can be numbered now: fewer than [`MAX_FRAMES`]
    /// and fewer than [`MAX_BYTES`] unacked. The channel listens to its
    /// handler only while this holds, so acks pace a long replay.
    pub fn has_room(&self) -> bool {
        self.unacked.len() < MAX_FRAMES && self.bytes < MAX_BYTES
    }

    /// Anything sent that the phone hasn't acked (an ack would free room).
    pub fn has_unacked(&self) -> bool {
        !self.unacked.is_empty()
    }

    /// Number and keep `text`; the frame to seal. `None`: too much is
    /// unacked and the session is over.
    pub fn wrap(&mut self, text: &str) -> Option<String> {
        if self.unacked.len() >= MAX_FRAMES || self.bytes + text.len() > MAX_BYTES {
            return None;
        }
        self.tx += 1;
        self.unacked.push_back((self.tx, text.to_string()));
        self.bytes += text.len();
        self.since_ack = 0;
        Some(self.frame(self.tx, text))
    }

    /// The phone has taken everything up to `a`.
    pub fn acked(&mut self, a: u64) {
        while let Some((n, text)) = self.unacked.front() {
            if *n > a {
                break;
            }
            self.bytes -= text.len();
            self.unacked.pop_front();
        }
    }

    /// An incoming plaintext on a session channel.
    pub fn take(&mut self, plain: &str) -> Taken {
        let Ok(v) = serde_json::from_str::<Value>(plain) else {
            return Taken::Broken;
        };
        if let Some(a) = v.get("a").and_then(Value::as_u64) {
            self.acked(a);
        }
        match v.get("t").and_then(Value::as_str) {
            Some("a") => Taken::Nothing,
            Some("q") => {
                let (Some(n), Some(d)) = (
                    v.get("n").and_then(Value::as_u64),
                    v.get("d").and_then(Value::as_str),
                ) else {
                    return Taken::Broken;
                };
                if n <= self.rx {
                    return Taken::Nothing;
                }
                if n != self.rx + 1 {
                    return Taken::Broken;
                }
                self.rx = n;
                self.since_ack += 1;
                let due = self.since_ack >= ACK_EVERY;
                if due {
                    self.since_ack = 0;
                }
                Taken::Frame(d.to_string(), due)
            }
            _ => Taken::Broken,
        }
    }

    /// The standalone ack.
    pub fn ack(&self) -> String {
        json!({ "t": "a", "a": self.rx }).to_string()
    }

    /// What goes first on a channel: this session's id, and whether it is the old one.
    pub fn sess(&self, resumed: bool) -> String {
        if resumed {
            json!({ "t": "sess", "sid": self.sid, "resumed": true, "rx": self.rx }).to_string()
        } else {
            json!({ "t": "sess", "sid": self.sid, "resumed": false }).to_string()
        }
    }

    /// Frames after `after` (the phone's `rx`), as fresh frames with their old numbers.
    pub fn replay(&mut self, after: u64) -> Vec<String> {
        self.acked(after);
        self.unacked
            .iter()
            .map(|(n, t)| self.frame(*n, t))
            .collect()
    }

    /// Whether `proof` is this session's phone, and not an old attempt replayed.
    fn accepts(&self, e: &str, proof: &ResumeProof) -> bool {
        proof_ok(&self.key, self.prev_key, self.last_k, e, proof)
    }

    /// The new channel's key replaces the current one.
    pub fn rekey(&mut self, key: [u8; 32], k: u64) {
        self.prev_key = Some(std::mem::replace(&mut self.key, key));
        self.last_k = k;
    }
}

fn proof_ok(
    key: &[u8; 32],
    prev: Option<[u8; 32]>,
    last_k: u64,
    e: &str,
    proof: &ResumeProof,
) -> bool {
    proof.k > last_k
        && (resume_mac_ok(key, e, proof) || prev.is_some_and(|k| resume_mac_ok(&k, e, proof)))
}

/// A live channel: how to tell it to let go, and what proves its phone is back.
struct Live {
    yield_tx: mpsc::Sender<()>,
    key: [u8; 32],
    prev: Option<[u8; 32]>,
    last_k: u64,
}

/// A channel's handler and state while its phone is away.
pub struct Parked {
    pub session: Session,
    pub to_handler: Option<mpsc::Sender<Message>>,
    pub from_handler: mpsc::Receiver<Message>,
    pub authed: bool,
    generation: u64,
}

struct Registry {
    parked: HashMap<String, Parked>,
    /// Live session channels, told to let go when the phone is back already.
    live: HashMap<String, Live>,
    next: u64,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(|| {
        Mutex::new(Registry {
            parked: HashMap::new(),
            live: HashMap::new(),
            next: 0,
        })
    })
}

/// A channel serving this session: the receiver says "the phone is back
/// on a new socket, park now".
pub fn go_live(session: &Session) -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel(1);
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .insert(
            session.sid.clone(),
            Live {
                yield_tx: tx,
                key: session.key,
                prev: session.prev_key,
                last_k: session.last_k,
            },
        );
    rx
}

/// This channel ended without parking.
pub fn forget(sid: &str) {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .remove(sid);
}

/// Keep the session for [`GRACE`].
pub fn park(
    session: Session,
    to_handler: Option<mpsc::Sender<Message>>,
    from_handler: mpsc::Receiver<Message>,
    authed: bool,
) {
    let sid = session.sid.clone();
    let generation = {
        let mut r = registry().lock().unwrap_or_else(|e| e.into_inner());
        r.live.remove(&sid);
        r.next += 1;
        let generation = r.next;
        r.parked.insert(
            sid.clone(),
            Parked {
                session,
                to_handler,
                from_handler,
                authed,
                generation,
            },
        );
        generation
    };
    tracing::info!("[Relay] a phone's session is waiting for it to come back");
    tokio::spawn(async move {
        tokio::time::sleep(GRACE).await;
        let mut r = registry().lock().unwrap_or_else(|e| e.into_inner());
        if r.parked
            .get(&sid)
            .is_some_and(|p| p.generation == generation)
        {
            r.parked.remove(&sid);
            tracing::info!("[Relay] a phone's session expired");
        }
    });
}

/// The session `proof` names, if it's parked and the proof is good. A
/// session whose old channel is still up is asked to let go first.
pub async fn claim(e: &str, proof: &ResumeProof) -> Option<Parked> {
    let deadline = tokio::time::Instant::now() + YIELD_WAIT;
    let mut asked = false;
    loop {
        {
            let mut r = registry().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(p) = r.parked.get(&proof.sid) {
                if !p.session.accepts(e, proof) {
                    return None;
                }
                return r.parked.remove(&proof.sid);
            }
            if !asked {
                if let Some(l) = r.live.get(&proof.sid) {
                    // Only a phone that proves it holds the session moves its channel.
                    if !proof_ok(&l.key, l.prev, l.last_k, e, proof) {
                        return None;
                    }
                    let _ = l.yield_tx.try_send(());
                    asked = true;
                }
            }
        }
        if !asked || tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Session, Session) {
        (
            Session::new([1; 32]).unwrap(),
            Session::new([1; 32]).unwrap(),
        )
    }

    #[test]
    fn frames_are_numbered_acked_and_replayed() {
        let (mut mac, mut phone) = pair();
        let a = mac.wrap("one").unwrap();
        let b = mac.wrap("two").unwrap();
        assert_eq!(phone.take(&a), Taken::Frame("one".into(), false));
        // A repeat is dropped, not delivered twice.
        assert_eq!(phone.take(&a), Taken::Nothing);
        assert_eq!(phone.take(&b), Taken::Frame("two".into(), false));
        // The phone says it took 1; the Mac keeps only 2 to replay.
        let replay = mac.replay(1);
        assert_eq!(replay.len(), 1);
        assert_eq!(phone.rx(), 2);
        // The frame replayed after a drop keeps its number: a phone that took it is unmoved.
        assert_eq!(phone.take(&replay[0]), Taken::Nothing);
    }

    #[test]
    fn a_hole_ends_the_session() {
        let (mut mac, mut phone) = pair();
        let _lost = mac.wrap("one").unwrap();
        let two = mac.wrap("two").unwrap();
        assert_eq!(phone.take(&two), Taken::Broken);
        assert_eq!(phone.take("not json"), Taken::Broken);
        assert_eq!(phone.take(r#"{"t":"zz"}"#), Taken::Broken);
    }

    #[test]
    fn an_ack_is_due_every_eighth_frame_and_acks_free_the_buffer() {
        let (mut mac, mut phone) = pair();
        let mut due = 0;
        for i in 0..16 {
            let f = mac.wrap(&format!("f{i}")).unwrap();
            if let Taken::Frame(_, true) = phone.take(&f) {
                due += 1;
                mac.take(&phone.ack());
            }
        }
        assert_eq!(due, 2);
        assert!(mac.unacked.is_empty());
        assert_eq!(mac.bytes, 0);
    }

    #[test]
    fn what_is_unacked_is_bounded() {
        let mut mac = Session::new([1; 32]).unwrap();
        for _ in 0..MAX_FRAMES {
            assert!(mac.wrap("x").is_some());
        }
        assert!(mac.wrap("x").is_none());
        let mut big = Session::new([1; 32]).unwrap();
        assert!(big.wrap(&"y".repeat(MAX_BYTES)).is_some());
        assert!(big.wrap("z").is_none());
    }

    #[test]
    fn a_resume_needs_the_key_and_a_newer_counter() {
        let mut s = Session::new([7; 32]).unwrap();
        let e = "phone-e";
        let good = ResumeProof {
            sid: s.sid.clone(),
            rx: 0,
            k: 1,
            mac: super::super::crypto::resume_mac(&[7; 32], e, &s.sid, 0, 1),
        };
        assert!(s.accepts(e, &good));
        // Another hello's proof, another key, a stale counter: all refused.
        assert!(!s.accepts("other-e", &good));
        let wrong = ResumeProof {
            mac: super::super::crypto::resume_mac(&[8; 32], e, &s.sid, 0, 1),
            ..good.clone()
        };
        assert!(!s.accepts(e, &wrong));
        s.rekey([9; 32], 1);
        assert!(!s.accepts(e, &good));
        // The previous key still works for a newer counter (a lost answer).
        let again = ResumeProof {
            k: 2,
            mac: super::super::crypto::resume_mac(&[7; 32], e, &s.sid, 0, 2),
            ..good
        };
        assert!(s.accepts(e, &again));
    }
}
