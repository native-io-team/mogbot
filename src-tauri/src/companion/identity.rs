//! This Mac's identity, as the phone pins it.
//!
//! A link or QR code is untrusted input: anyone can make one that names
//! "Julian's MacBook Pro" and points at their own server, and a Tailscale
//! Funnel host has a valid `*.ts.net` certificate too. So the Mac has an
//! Ed25519 key of its own (kept in `companion.json`, 0600). The pairing link
//! carries a fingerprint of its public half; the phone pins that fingerprint,
//! and every pairing answer and every `welcome` signs a fresh challenge the
//! phone chose. A server that can't sign for the pinned key isn't this Mac,
//! whatever its name, host or certificate, and the phone stops there.
//!
//! The signed messages are spelled out in `pairing.ts`
//! (`pairProofMessage`, `welcomeProofMessage`); both sides must agree byte
//! for byte.

use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::Serialize;

use super::wire::PAIRING_SCHEME;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A challenge is 16 to 64 random bytes, base64url: anything else gets no
/// signature rather than a signature over something the phone didn't choose.
const MIN_CHALLENGE: usize = 22;
const MAX_CHALLENGE: usize = 86;

/// A signature over a challenge, with the key that made it (`IdentityProof`
/// in frames.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProof {
    /// The Ed25519 public key, base64url (32 bytes).
    pub public_key: String,
    /// Its signature over the proof message, base64url (64 bytes).
    pub signature: String,
}

pub struct Identity {
    key: Ed25519KeyPair,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("fingerprint", &self.fingerprint())
            .finish()
    }
}

impl Identity {
    /// A new key, and its PKCS#8 document (base64url) to keep.
    pub fn generate() -> Option<(Identity, String)> {
        let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).ok()?;
        let key = Ed25519KeyPair::from_pkcs8(doc.as_ref()).ok()?;
        Some((Identity { key }, B64.encode(doc.as_ref())))
    }

    /// The key kept in `companion.json`, or `None` if it isn't one.
    pub fn from_stored(pkcs8_b64: &str) -> Option<Identity> {
        let bytes = B64.decode(pkcs8_b64.trim()).ok()?;
        Ed25519KeyPair::from_pkcs8_maybe_unchecked(&bytes)
            .ok()
            .map(|key| Identity { key })
    }

    pub fn public_key(&self) -> String {
        B64.encode(self.key.public_key().as_ref())
    }

    /// What the pairing link carries: [`fingerprint_of`] this public key.
    pub fn fingerprint(&self) -> String {
        fingerprint_of(self.key.public_key().as_ref())
    }

    fn prove(&self, message: &str) -> IdentityProof {
        IdentityProof {
            public_key: self.public_key(),
            signature: B64.encode(self.key.sign(message.as_bytes()).as_ref()),
        }
    }

    /// The answer to `PairRequest.challenge`, or `None` for no usable challenge.
    pub fn prove_pair(&self, challenge: Option<&str>, server_id: &str) -> Option<IdentityProof> {
        let challenge = usable_challenge(challenge)?;
        Some(self.prove(&pair_message(challenge, server_id)))
    }

    /// The answer to `hello.challenge`, or `None` for no usable challenge.
    pub fn prove_welcome(
        &self,
        challenge: Option<&str>,
        server_id: &str,
        device_id: &str,
    ) -> Option<IdentityProof> {
        let challenge = usable_challenge(challenge)?;
        Some(self.prove(&welcome_message(challenge, server_id, device_id)))
    }
}

fn usable_challenge(challenge: Option<&str>) -> Option<&str> {
    let c = challenge?;
    let ok = (MIN_CHALLENGE..=MAX_CHALLENGE).contains(&c.len())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then_some(c)
}

/// The first 16 bytes of SHA-256 over the raw public key, base64url (22
/// characters): short enough for the QR code, far past forging.
pub fn fingerprint_of(public_key: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    B64.encode(&Sha256::digest(public_key)[..16])
}

/// `pairProofMessage` in pairing.ts.
pub fn pair_message(challenge: &str, server_id: &str) -> String {
    format!("{PAIRING_SCHEME}:pair:v1\n{challenge}\n{server_id}")
}

/// `welcomeProofMessage` in pairing.ts.
pub fn welcome_message(challenge: &str, server_id: &str, device_id: &str) -> String {
    format!("{PAIRING_SCHEME}:welcome:v1\n{challenge}\n{server_id}\n{device_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ED25519};

    fn verify(proof: &IdentityProof, message: &str) -> bool {
        let key = B64.decode(&proof.public_key).unwrap();
        let sig = B64.decode(&proof.signature).unwrap();
        UnparsedPublicKey::new(&ED25519, key)
            .verify(message.as_bytes(), &sig)
            .is_ok()
    }

    const CHALLENGE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn a_stored_key_comes_back_as_the_same_identity() {
        let (id, stored) = Identity::generate().unwrap();
        let again = Identity::from_stored(&stored).unwrap();
        assert_eq!(id.public_key(), again.public_key());
        assert_eq!(id.fingerprint(), again.fingerprint());
        assert_eq!(id.fingerprint().len(), 22);
        assert!(Identity::from_stored("not a key").is_none());
    }

    #[test]
    fn proofs_verify_only_for_their_own_message() {
        let (id, _) = Identity::generate().unwrap();
        let pair = id.prove_pair(Some(CHALLENGE), "srv_1").unwrap();
        assert!(verify(&pair, &pair_message(CHALLENGE, "srv_1")));
        assert!(!verify(&pair, &pair_message(CHALLENGE, "srv_2")));
        // A pairing answer can't be replayed as a welcome, or the reverse.
        assert!(!verify(
            &pair,
            &welcome_message(CHALLENGE, "srv_1", "dev_1")
        ));
        let welcome = id.prove_welcome(Some(CHALLENGE), "srv_1", "dev_1").unwrap();
        assert!(verify(
            &welcome,
            &welcome_message(CHALLENGE, "srv_1", "dev_1")
        ));
        assert!(!verify(
            &welcome,
            &welcome_message(CHALLENGE, "srv_1", "dev_2")
        ));
        // Another Mac's key never matches this one's fingerprint.
        let (other, _) = Identity::generate().unwrap();
        assert_ne!(other.fingerprint(), id.fingerprint());
    }

    #[test]
    fn junk_challenges_get_no_signature() {
        let (id, _) = Identity::generate().unwrap();
        assert!(id.prove_pair(None, "s").is_none());
        assert!(id.prove_pair(Some("short"), "s").is_none());
        assert!(id.prove_pair(Some(&"A".repeat(200)), "s").is_none());
        assert!(id
            .prove_pair(Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nX"), "s")
            .is_none());
    }

    /// The exact bytes pairing.ts signs and checks: a change here must change
    /// both sides.
    #[test]
    fn the_messages_are_the_protocols() {
        assert_eq!(
            pair_message("c", "srv"),
            format!("{PAIRING_SCHEME}:pair:v1\nc\nsrv")
        );
        assert_eq!(
            welcome_message("c", "srv", "dev"),
            format!("{PAIRING_SCHEME}:welcome:v1\nc\nsrv\ndev")
        );
        // Known vector: fingerprint of 32 zero bytes.
        assert_eq!(fingerprint_of(&[0u8; 32]), "Zmh6rfhivXdsj8GLjp-OIA");
    }
}
