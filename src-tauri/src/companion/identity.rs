//! This Mac's identity, as the phone pins it.
//!
//! A link or QR code is untrusted input: anyone can make one that names
//! "Julian's MacBook Pro" and points at their own server, and a Tailscale
//! Funnel host has a valid `*.ts.net` certificate too. So the Mac has an
//! Ed25519 key of its own (in the login Keychain, `keystore.rs`). The pairing
//! link carries a fingerprint of its public half and the phone pins it.
//!
//! The Mac proves itself first. Before the phone sends a pairing code
//! (`POST /v1/identity`) or a device token (the socket's `challenge` →
//! `identity` frames), the Mac signs a challenge the phone chose together
//! with its server id and the host names it serves itself on. The phone goes
//! on only when the signature is the pinned key's *and* the host it actually
//! reached is one of those names, so a server that relays the Mac's answers
//! from somewhere else gets nothing. The pairing answer signs the same, plus
//! the device it made.
//!
//! The signed messages are spelled out in `pairing.ts` (`macProofMessage`,
//! `pairProofMessage`); both sides must agree byte for byte.

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

    /// A kept key (PKCS#8, base64url), or `None` if it isn't one.
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

    /// The proof the Mac gives first (the `identity` frame and
    /// `POST /v1/identity`), or `None` for no usable challenge.
    pub fn prove_mac(
        &self,
        challenge: &str,
        server_id: &str,
        hosts: &[String],
    ) -> Option<IdentityProof> {
        let challenge = usable_challenge(Some(challenge))?;
        Some(self.prove(&mac_message(challenge, server_id, hosts)))
    }

    /// The answer to `PairRequest.challenge`, or `None` for no usable challenge.
    pub fn prove_pair(
        &self,
        challenge: Option<&str>,
        server_id: &str,
        hosts: &[String],
        device_id: &str,
    ) -> Option<IdentityProof> {
        let challenge = usable_challenge(challenge)?;
        Some(self.prove(&pair_message(challenge, server_id, hosts, device_id)))
    }
}

/// 16 to 64 random bytes, base64url: the only challenges the Mac signs.
pub fn is_usable_challenge(challenge: &str) -> bool {
    usable_challenge(Some(challenge)).is_some()
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

/// A route URL's host as both sides sign it: lowercase, no port, no path
/// (`hostOf` in pairing.ts). `None` for anything that isn't `scheme://host…`.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') || authority.starts_with('[') {
        return None;
    }
    let host = authority.split(':').next()?.to_ascii_lowercase();
    let ok = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
    ok.then_some(host)
}

/// The hosts as one signed line: lowercase, sorted, comma separated (a host
/// name holds neither a comma nor a newline, so it reads only one way).
fn host_line(hosts: &[String]) -> String {
    let mut hosts: Vec<String> = hosts.iter().map(|h| h.to_ascii_lowercase()).collect();
    hosts.sort();
    hosts.join(",")
}

/// `macProofMessage` in pairing.ts.
pub fn mac_message(challenge: &str, server_id: &str, hosts: &[String]) -> String {
    format!(
        "{PAIRING_SCHEME}:identity:v2\n{challenge}\n{server_id}\n{}",
        host_line(hosts)
    )
}

/// `pairProofMessage` in pairing.ts.
pub fn pair_message(challenge: &str, server_id: &str, hosts: &[String], device_id: &str) -> String {
    format!(
        "{PAIRING_SCHEME}:pair:v2\n{challenge}\n{server_id}\n{}\n{device_id}",
        host_line(hosts)
    )
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

    fn hosts(h: &[&str]) -> Vec<String> {
        h.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn proofs_verify_only_for_their_own_message() {
        let (id, _) = Identity::generate().unwrap();
        let mac_hosts = hosts(&["mac.tail1.ts.net"]);
        let mac = id.prove_mac(CHALLENGE, "srv_1", &mac_hosts).unwrap();
        assert!(verify(&mac, &mac_message(CHALLENGE, "srv_1", &mac_hosts)));
        assert!(!verify(&mac, &mac_message(CHALLENGE, "srv_2", &mac_hosts)));
        // The host is part of what's signed: a relay elsewhere can't reuse it.
        assert!(!verify(
            &mac,
            &mac_message(CHALLENGE, "srv_1", &hosts(&["attacker.tail9.ts.net"]))
        ));
        let pair = id
            .prove_pair(Some(CHALLENGE), "srv_1", &mac_hosts, "dev_1")
            .unwrap();
        assert!(verify(
            &pair,
            &pair_message(CHALLENGE, "srv_1", &mac_hosts, "dev_1")
        ));
        assert!(!verify(
            &pair,
            &pair_message(CHALLENGE, "srv_1", &mac_hosts, "dev_2")
        ));
        // A pairing answer can't be replayed as the socket's proof, or the reverse.
        assert!(!verify(&pair, &mac_message(CHALLENGE, "srv_1", &mac_hosts)));
        assert!(!verify(
            &mac,
            &pair_message(CHALLENGE, "srv_1", &mac_hosts, "")
        ));
        // Another Mac's key never matches this one's fingerprint.
        let (other, _) = Identity::generate().unwrap();
        assert_ne!(other.fingerprint(), id.fingerprint());
    }

    #[test]
    fn junk_challenges_get_no_signature() {
        let (id, _) = Identity::generate().unwrap();
        let h = hosts(&["m.ts.net"]);
        assert!(id.prove_pair(None, "s", &h, "d").is_none());
        assert!(id.prove_mac("short", "s", &h).is_none());
        assert!(id.prove_mac(&"A".repeat(200), "s", &h).is_none());
        assert!(id
            .prove_mac("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nX", "s", &h)
            .is_none());
    }

    #[test]
    fn hosts_are_read_the_way_the_phone_reads_them() {
        assert_eq!(
            host_of("https://Mac.Tail1.ts.net:47443/").as_deref(),
            Some("mac.tail1.ts.net")
        );
        assert_eq!(
            host_of("http://localhost:1234").as_deref(),
            Some("localhost")
        );
        assert_eq!(host_of("https://user@mac.ts.net"), None);
        assert_eq!(host_of("mac.ts.net"), None);
    }

    /// The exact bytes pairing.ts signs and checks: a change here must change
    /// both sides.
    #[test]
    fn the_messages_are_the_protocols() {
        assert_eq!(
            mac_message("c", "srv", &hosts(&["B.ts.net", "a.ts.net"])),
            format!("{PAIRING_SCHEME}:identity:v2\nc\nsrv\na.ts.net,b.ts.net")
        );
        assert_eq!(
            pair_message("c", "srv", &hosts(&["a.ts.net"]), "dev"),
            format!("{PAIRING_SCHEME}:pair:v2\nc\nsrv\na.ts.net\ndev")
        );
        // Known vector: fingerprint of 32 zero bytes.
        assert_eq!(fingerprint_of(&[0u8; 32]), "Zmh6rfhivXdsj8GLjp-OIA");
    }
}
