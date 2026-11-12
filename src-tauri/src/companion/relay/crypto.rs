//! The phone ↔ Mac channel over the relay, end to end (docs/relay.md, "The
//! encrypted channel"), and the Mac's login to the relay.
//!
//! The phone opens with an X25519 key; the Mac answers with its own and
//! signs the transcript with its identity key, which the phone pinned at
//! pairing. Both derive one key per direction with HKDF-SHA256 and seal
//! every later payload with ChaCha20-Poly1305 under a counter nonce. The
//! relay sees only these bytes. `relayVectors.json` holds the exact bytes
//! both sides must produce.

use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

use super::super::identity::Identity;
use super::super::wire::PAIRING_SCHEME;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The only channel version.
pub const VERSION: u32 = 1;
/// The Poly1305 tag after every ciphertext.
pub const TAG_LEN: usize = 16;

/// What the Mac signs to take its slot at the relay.
pub fn login_message(nonce: &str, fingerprint: &str) -> String {
    format!("{PAIRING_SCHEME}:relay-mac:v1\n{nonce}\n{fingerprint}")
}

/// What the Mac signs for one channel: both ephemeral keys as sent, and the
/// fingerprint the phone pinned.
pub fn transcript(phone_e: &str, mac_e: &str, fingerprint: &str) -> String {
    format!("{PAIRING_SCHEME}:relay:v1\n{phone_e}\n{mac_e}\n{fingerprint}")
}

/// The relay's challenge, signed only when it is what the spec says it is
/// (32 random bytes, base64url).
pub fn usable_nonce(nonce: &str) -> bool {
    nonce.len() == 43 && B64.decode(nonce).is_ok_and(|b| b.len() == 32)
}

/// `{"t":"auth",…}`, the Mac's answer to the relay's challenge, or `None`
/// for a challenge it won't sign.
pub fn login_auth(identity: &Identity, nonce: &str) -> Option<String> {
    if !usable_nonce(nonce) {
        return None;
    }
    let proof = identity.prove_relay(&login_message(nonce, &identity.fingerprint()));
    serde_json::to_string(&serde_json::json!({
        "t": "auth",
        "v": VERSION,
        "publicKey": proof.public_key,
        "signature": proof.signature,
    }))
    .ok()
}

/// The phone's first payload.
#[derive(Debug, Serialize, Deserialize)]
pub struct PhoneHello {
    pub v: u32,
    pub e: String,
}

/// The Mac's answer. Field order is the wire's (`v`, `e`, `publicKey`,
/// `signature`), which the test vectors hold byte for byte.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacAnswer {
    pub v: u32,
    pub e: String,
    pub public_key: String,
    pub signature: String,
}

/// One direction's key and counter.
pub struct Direction {
    key: LessSafeKey,
    counter: u64,
}

impl Direction {
    fn new(key: &[u8; 32]) -> Option<Self> {
        let key = UnboundKey::new(&CHACHA20_POLY1305, key).ok()?;
        Some(Direction {
            key: LessSafeKey::new(key),
            counter: 0,
        })
    }

    /// The next nonce: 4 zero bytes, then the counter big-endian. `None`
    /// once the counter would wrap: the channel must close.
    fn next_nonce(&mut self) -> Option<Nonce> {
        if self.counter == u64::MAX {
            return None;
        }
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&self.counter.to_be_bytes());
        self.counter += 1;
        Some(Nonce::assume_unique_for_key(n))
    }

    /// Ciphertext ‖ tag, or `None` when this direction is spent.
    pub fn seal(&mut self, plain: &[u8]) -> Option<Vec<u8>> {
        let nonce = self.next_nonce()?;
        let mut buf = plain.to_vec();
        self.key
            .seal_in_place_append_tag(nonce, Aad::empty(), &mut buf)
            .ok()?;
        Some(buf)
    }

    /// The plaintext, or `None` for anything that doesn't open in order:
    /// the channel must close.
    pub fn open(&mut self, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < TAG_LEN {
            return None;
        }
        let nonce = self.next_nonce()?;
        let mut buf = sealed.to_vec();
        let plain = self.key.open_in_place(nonce, Aad::empty(), &mut buf).ok()?;
        Some(plain.to_vec())
    }
}

/// Both directions' keys (`phoneToMac`, `macToPhone`).
pub struct Keys {
    pub phone_to_mac: [u8; 32],
    pub mac_to_phone: [u8; 32],
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// `okm = HKDF-SHA256(shared, salt = SHA-256(transcript), info = "<scheme> relay v1", 64)`.
pub fn derive(shared: &[u8; 32], transcript: &str) -> Option<Keys> {
    let salt_bytes = Sha256::digest(transcript.as_bytes());
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt_bytes);
    let prk = salt.extract(shared);
    let info = format!("{PAIRING_SCHEME} relay v1");
    let info = [info.as_bytes()];
    let okm = prk.expand(&info, Len(64)).ok()?;
    let mut out = [0u8; 64];
    okm.fill(&mut out).ok()?;
    let mut keys = Keys {
        phone_to_mac: [0; 32],
        mac_to_phone: [0; 32],
    };
    keys.phone_to_mac.copy_from_slice(&out[..32]);
    keys.mac_to_phone.copy_from_slice(&out[32..]);
    Some(keys)
}

fn public_from_b64(e: &str) -> Option<PublicKey> {
    let bytes: [u8; 32] = B64.decode(e).ok()?.try_into().ok()?;
    Some(PublicKey::from(bytes))
}

/// `X25519(secret, other)`, refusing a low-order key (an all-zero secret
/// anyone could compute).
fn agree(secret: &StaticSecret, other: &PublicKey) -> Option<[u8; 32]> {
    let shared = secret.diffie_hellman(other);
    shared.was_contributory().then(|| *shared.as_bytes())
}

/// The Mac's end of an open channel.
pub struct MacChannel {
    /// Payloads from the phone.
    pub incoming: Direction,
    /// Payloads to the phone.
    pub outgoing: Direction,
}

/// The Mac's answer to a phone's hello (its first payload), with a fresh
/// ephemeral `secret`. `None` for a hello that isn't one: the channel closes.
pub fn mac_answer(
    identity: &Identity,
    secret: StaticSecret,
    hello: &[u8],
) -> Option<(Vec<u8>, MacChannel)> {
    let hello: PhoneHello = serde_json::from_slice(hello).ok()?;
    if hello.v != VERSION {
        return None;
    }
    let phone_e = public_from_b64(&hello.e)?;
    let mac_e = B64.encode(PublicKey::from(&secret).as_bytes());
    let fingerprint = identity.fingerprint();
    let transcript = transcript(&hello.e, &mac_e, &fingerprint);
    let shared = agree(&secret, &phone_e)?;
    let keys = derive(&shared, &transcript)?;
    let proof = identity.prove_relay(&transcript);
    let answer = MacAnswer {
        v: VERSION,
        e: mac_e,
        public_key: proof.public_key,
        signature: proof.signature,
    };
    let channel = MacChannel {
        incoming: Direction::new(&keys.phone_to_mac)?,
        outgoing: Direction::new(&keys.mac_to_phone)?,
    };
    Some((serde_json::to_vec(&answer).ok()?, channel))
}

/// A fresh ephemeral secret from the OS.
pub fn fresh_secret() -> Option<StaticSecret> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(StaticSecret::from(bytes))
}

/// The phone's side, as `mobile/src/lib/relayCrypto.ts` does it: for the
/// tests, which play a phone against the real Mac code.
#[cfg(test)]
pub mod phone {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ED25519};

    pub fn hello(secret: &StaticSecret) -> String {
        let e = B64.encode(PublicKey::from(secret).as_bytes());
        format!("{{\"v\":1,\"e\":\"{e}\"}}")
    }

    /// The phone's directions (`outgoing` = phoneToMac), once the answer
    /// checks out against the pinned fingerprint.
    pub fn finish(secret: &StaticSecret, answer: &[u8], pinned: &str) -> Option<MacChannel> {
        let answer: MacAnswer = serde_json::from_slice(answer).ok()?;
        let key = B64.decode(&answer.public_key).ok()?;
        if super::super::super::identity::fingerprint_of(&key) != pinned {
            return None;
        }
        let phone_e = B64.encode(PublicKey::from(secret).as_bytes());
        let t = transcript(&phone_e, &answer.e, pinned);
        let sig = B64.decode(&answer.signature).ok()?;
        UnparsedPublicKey::new(&ED25519, &key)
            .verify(t.as_bytes(), &sig)
            .ok()?;
        let shared = agree(secret, &public_from_b64(&answer.e)?)?;
        let keys = derive(&shared, &t)?;
        Some(MacChannel {
            incoming: Direction::new(&keys.mac_to_phone)?,
            outgoing: Direction::new(&keys.phone_to_mac)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/companion-protocol/src/relayVectors.json"
        ))
        .unwrap()
    }

    fn filled(v: &Value, key: &str) -> [u8; 32] {
        [v[key].as_u64().unwrap() as u8; 32]
    }

    fn s<'a>(v: &'a Value, key: &str) -> &'a str {
        v[key].as_str().unwrap()
    }

    #[test]
    fn the_handshake_matches_the_vectors_byte_for_byte() {
        let v = vectors();
        let identity = Identity::from_seed(&filled(&v, "macIdentitySeedFill"));
        assert_eq!(identity.fingerprint(), s(&v, "fingerprint"));

        let phone_secret = StaticSecret::from(filled(&v, "phoneSecretFill"));
        let hello = phone::hello(&phone_secret);
        assert_eq!(hello, s(&v, "phoneHello"));

        let mac_secret = StaticSecret::from(filled(&v, "macSecretFill"));
        let (answer, mut mac) = mac_answer(&identity, mac_secret, hello.as_bytes()).unwrap();
        assert_eq!(String::from_utf8(answer.clone()).unwrap(), s(&v, "macAnswer"));

        let parsed: MacAnswer = serde_json::from_slice(&answer).unwrap();
        let t = transcript(
            &serde_json::from_str::<PhoneHello>(&hello).unwrap().e,
            &parsed.e,
            &identity.fingerprint(),
        );
        assert_eq!(t, s(&v, "transcript"));
        let shared = agree(
            &StaticSecret::from(filled(&v, "macSecretFill")),
            &public_from_b64(&serde_json::from_str::<PhoneHello>(&hello).unwrap().e).unwrap(),
        )
        .unwrap();
        let keys = derive(&shared, &t).unwrap();
        assert_eq!(B64.encode(keys.phone_to_mac), s(&v, "phoneToMacKey"));
        assert_eq!(B64.encode(keys.mac_to_phone), s(&v, "macToPhoneKey"));

        // The phone's half agrees, and its frames are the vectors'.
        let mut ph = phone::finish(&phone_secret, &answer, s(&v, "fingerprint")).unwrap();
        for f in v["phoneFrames"].as_array().unwrap() {
            let sealed = ph.outgoing.seal(s(f, "plain").as_bytes()).unwrap();
            assert_eq!(B64.encode(&sealed), s(f, "sealed"));
            let plain = mac.incoming.open(&sealed).unwrap();
            assert_eq!(plain, s(f, "plain").as_bytes());
        }
        for f in v["macFrames"].as_array().unwrap() {
            let sealed = mac.outgoing.seal(s(f, "plain").as_bytes()).unwrap();
            assert_eq!(B64.encode(&sealed), s(f, "sealed"));
            assert_eq!(ph.incoming.open(&sealed).unwrap(), s(f, "plain").as_bytes());
        }
    }

    #[test]
    fn the_mac_login_matches_the_vectors() {
        let v = vectors();
        let identity = Identity::from_seed(&filled(&v, "macIdentitySeedFill"));
        let login = &v["macLogin"];
        let nonce = s(login, "nonce");
        assert_eq!(
            login_message(nonce, &identity.fingerprint()),
            s(login, "message")
        );
        let auth: Value = serde_json::from_str(&login_auth(&identity, nonce).unwrap()).unwrap();
        assert_eq!(auth["t"], "auth");
        assert_eq!(auth["v"], 1);
        assert_eq!(auth["publicKey"], s(login, "publicKey"));
        assert_eq!(auth["signature"], s(login, "signature"));
        // Nothing but 32 bytes of challenge is signed.
        assert!(login_auth(&identity, "short").is_none());
        assert!(login_auth(&identity, &"A".repeat(43 + 1)).is_none());
    }

    #[test]
    fn a_tampered_reordered_or_foreign_frame_never_opens() {
        let v = vectors();
        let identity = Identity::from_seed(&filled(&v, "macIdentitySeedFill"));
        let phone_secret = StaticSecret::from([9u8; 32]);
        let hello = phone::hello(&phone_secret);
        let (answer, mut mac) =
            mac_answer(&identity, fresh_secret().unwrap(), hello.as_bytes()).unwrap();
        let mut ph = phone::finish(&phone_secret, &answer, &identity.fingerprint()).unwrap();
        let first = ph.outgoing.seal(b"one").unwrap();
        let second = ph.outgoing.seal(b"two").unwrap();
        // Out of order: the counter says no.
        assert!(mac.incoming.open(&second).is_none());

        let (answer, mut mac) =
            mac_answer(&identity, fresh_secret().unwrap(), hello.as_bytes()).unwrap();
        assert!(
            mac.incoming.open(&first).is_none(),
            "another channel's keys"
        );
        let mut ph = phone::finish(&phone_secret, &answer, &identity.fingerprint()).unwrap();
        let mut sealed = ph.outgoing.seal(b"hello").unwrap();
        sealed[0] ^= 1;
        assert!(mac.incoming.open(&sealed).is_none());

        // The phone refuses an answer for a key it didn't pin.
        let other = Identity::from_seed(&[7u8; 32]);
        let (answer, _) = mac_answer(&other, fresh_secret().unwrap(), hello.as_bytes()).unwrap();
        assert!(phone::finish(&phone_secret, &answer, &identity.fingerprint()).is_none());
    }

    #[test]
    fn a_hello_that_isnt_one_gets_no_answer() {
        let identity = Identity::from_seed(&[2u8; 32]);
        for junk in [
            &b"{}"[..],
            b"{\"v\":2,\"e\":\"pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk\"}",
            b"{\"v\":1,\"e\":\"short\"}",
            // The all-zero point: no contribution from the phone.
            b"{\"v\":1,\"e\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}",
            b"not json",
        ] {
            assert!(mac_answer(&identity, fresh_secret().unwrap(), junk).is_none());
        }
    }

    #[test]
    fn a_spent_counter_closes_rather_than_reusing_a_nonce() {
        let mut d = Direction::new(&[1u8; 32]).unwrap();
        d.counter = u64::MAX - 1;
        assert!(d.seal(b"last").is_some());
        assert!(d.seal(b"one too many").is_none());
    }
}
