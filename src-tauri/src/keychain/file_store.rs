//! Secrets on a box with no Secret Service (a headless Linux server, a
//! container): one encrypted file, behind the same [`Blobs`] as the system
//! stores, so [`super::os_store::Plain`]'s policy (errors are not absence,
//! every write read back) holds unchanged.
//!
//! - **The file** (`secrets.enc`, 0600, in the app's owner-only folder) is
//!   one ChaCha20-Poly1305 sealed JSON map of (service, account) → value. A
//!   write seals a fresh copy with a new nonce and renames it into place,
//!   so the file is never half written.
//! - **The key** is derived (HKDF-SHA256) from a machine secret: 32 random
//!   bytes in `secrets.key` (0600) beside it, made on the first write, or a
//!   file the service is handed (`$CREDENTIALS_DIRECTORY/<slug>-secret-key`,
//!   systemd's `LoadCredential=`, or `<SLUG>_SECRET_KEY_FILE`, a Docker
//!   secret), so the key need not sit beside the store.
//! - **Errors are not absence.** No store file is "nothing stored". A store
//!   whose key is gone, a key that doesn't open it, or a file that isn't a
//!   store is an error, and never overwritten: a write then fails too, so
//!   nothing a user kept is ever replaced by an empty store.
//!
//! What it protects against: other users (file modes), and a copy or backup
//! of the store without its key. What it can't: anyone who can read files as
//! this user, which is also true of an unlocked keyring.

// Only Linux uses it in the app; every platform tests it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use super::os_store::Blobs;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The first bytes of a store file, and what the seal covers besides the map.
const MAGIC: &[u8] = b"MBSECRETS1\n";
const KEY_LEN: usize = 32;
const INFO: &[u8] = b"secrets.enc v1";

pub struct FileStore {
    store: PathBuf,
    /// Where the machine secret is read from, and (when it's ours) made.
    key: KeySource,
    lock: Mutex<()>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum KeySource {
    /// Ours, beside the store: made on the first write.
    Beside(PathBuf),
    /// Handed to the service (systemd credential, Docker secret): only read.
    Given(PathBuf),
}

type Map = BTreeMap<String, String>;

fn item_key(service: &str, account: &str) -> String {
    // NUL is in no service or account name.
    format!("{service}\0{account}")
}

impl FileStore {
    pub fn new(store: PathBuf, key: KeySource) -> Self {
        FileStore {
            store,
            key,
            lock: Mutex::new(()),
        }
    }

    /// The app's own: `secrets.enc` in `dir`, its key as [`key_source`] says.
    pub fn in_dir(dir: &Path) -> Self {
        Self::new(dir.join("secrets.enc"), key_source(dir))
    }

    pub fn path(&self) -> &Path {
        &self.store
    }

    fn read_key(&self, create: bool) -> Result<Option<[u8; KEY_LEN]>, String> {
        let (path, ours) = match &self.key {
            KeySource::Beside(p) => (p, true),
            KeySource::Given(p) => (p, false),
        };
        match std::fs::read(path) {
            Ok(bytes) => derive(&bytes).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && ours && create => {
                let mut secret = [0u8; KEY_LEN];
                getrandom::getrandom(&mut secret)
                    .map_err(|e| format!("couldn't make the secrets key ({e})"))?;
                write_owner_only(path, &secret)?;
                // Read back what landed, so a key we couldn't keep is never used.
                let kept = std::fs::read(path)
                    .map_err(|e| format!("couldn't read the secrets key back ({e})"))?;
                if kept != secret {
                    return Err("the secrets key didn't read back the same".into());
                }
                derive(&secret).map(Some)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("couldn't read the secrets key ({e})")),
        }
    }

    /// The map, or `None` when there is no store file at all.
    fn load(&self) -> Result<Option<Map>, String> {
        let sealed = match std::fs::read(&self.store) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("couldn't read the secrets file ({e})")),
        };
        let Some(key) = self.read_key(false)? else {
            return Err("the secrets file is here but its key is gone".into());
        };
        open(&key, &sealed).map(Some)
    }

    fn save(&self, map: &Map) -> Result<(), String> {
        let key = self
            .read_key(true)?
            .ok_or_else(|| "the secrets key isn't there".to_string())?;
        let sealed = seal(&key, map)?;
        let dir = self
            .store
            .parent()
            .ok_or_else(|| "the secrets file has no folder".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make the folder ({e})"))?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)
            .map_err(|e| format!("couldn't write the secrets file ({e})"))?;
        // NamedTempFile is created 0600 on Unix.
        tmp.write_all(&sealed)
            .and_then(|()| tmp.as_file().sync_all())
            .map_err(|e| format!("couldn't write the secrets file ({e})"))?;
        tmp.persist(&self.store)
            .map_err(|e| format!("couldn't write the secrets file ({})", e.error))?;
        Ok(())
    }

    fn change(&self, f: impl FnOnce(&mut Map) -> bool) -> Result<(), String> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.load()?.unwrap_or_default();
        if f(&mut map) {
            self.save(&map)?;
        }
        Ok(())
    }
}

/// Where this box's key comes from: a credential handed to the service when
/// there is one, else ours beside the store.
pub fn key_source(dir: &Path) -> KeySource {
    key_source_from(
        dir,
        std::env::var_os("CREDENTIALS_DIRECTORY").map(PathBuf::from),
        std::env::var_os(format!(
            "{}_SECRET_KEY_FILE",
            crate::brand::SLUG.to_ascii_uppercase().replace('-', "_")
        ))
        .map(PathBuf::from),
    )
}

fn key_source_from(dir: &Path, credentials: Option<PathBuf>, given: Option<PathBuf>) -> KeySource {
    if let Some(p) = given.filter(|p| !p.as_os_str().is_empty()) {
        return KeySource::Given(p);
    }
    if let Some(p) = credentials
        .map(|d| d.join(format!("{}-secret-key", crate::brand::SLUG)))
        .filter(|p| p.is_file())
    {
        return KeySource::Given(p);
    }
    KeySource::Beside(dir.join("secrets.key"))
}

fn derive(secret: &[u8]) -> Result<[u8; KEY_LEN], String> {
    // A handed-in key may be text (a Docker secret made with `openssl rand
    // -hex 32`): its bytes are the input either way, and too little is refused.
    let secret = trim_ascii(secret);
    if secret.len() < 16 {
        return Err("the secrets key is too short (at least 16 bytes)".into());
    }
    let salt = ring::hkdf::Salt::new(ring::hkdf::HKDF_SHA256, MAGIC);
    let prk = salt.extract(secret);
    let okm = prk
        .expand(&[INFO], ring::hkdf::HKDF_SHA256)
        .map_err(|_| "couldn't derive the secrets key".to_string())?;
    let mut key = [0u8; KEY_LEN];
    okm.fill(&mut key)
        .map_err(|_| "couldn't derive the secrets key".to_string())?;
    Ok(key)
}

fn trim_ascii(b: &[u8]) -> &[u8] {
    let start = b
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(b.len());
    let end = b
        .iter()
        .rposition(|c| !c.is_ascii_whitespace())
        .map_or(start, |i| i + 1);
    &b[start..end]
}

fn aead(key: &[u8; KEY_LEN]) -> Result<LessSafeKey, String> {
    UnboundKey::new(&CHACHA20_POLY1305, key)
        .map(LessSafeKey::new)
        .map_err(|_| "couldn't use the secrets key".to_string())
}

/// `MAGIC ‖ nonce ‖ sealed(json)`, the magic also bound in as associated data.
fn seal(key: &[u8; KEY_LEN], map: &Map) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("couldn't make a nonce ({e})"))?;
    let mut data = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    aead(key)?
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(MAGIC),
            &mut data,
        )
        .map_err(|_| "couldn't seal the secrets file".to_string())?;
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&data);
    Ok(out)
}

fn open(key: &[u8; KEY_LEN], sealed: &[u8]) -> Result<Map, String> {
    let rest = sealed
        .strip_prefix(MAGIC)
        .ok_or_else(|| "the secrets file isn't one this app wrote".to_string())?;
    if rest.len() < NONCE_LEN {
        return Err("the secrets file is cut short".into());
    }
    let (nonce, body) = rest.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce)
        .map_err(|_| "the secrets file is cut short".to_string())?;
    let mut body = body.to_vec();
    let plain = aead(key)?
        .open_in_place(nonce, Aad::from(MAGIC), &mut body)
        .map_err(|_| "the secrets key doesn't open the secrets file".to_string())?;
    serde_json::from_slice(plain).map_err(|_| "the secrets file can't be read".to_string())
}

#[cfg(unix)]
fn write_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make the folder ({e})"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("couldn't make the secrets key ({e})"))?;
    f.write_all(bytes)
        .and_then(|()| f.sync_all())
        .map_err(|e| format!("couldn't make the secrets key ({e})"))
}

#[cfg(not(unix))]
fn write_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("couldn't make the secrets key ({e})"))
}

impl Blobs for FileStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self
            .load()?
            .and_then(|m| m.get(&item_key(service, account)).cloned())
            .map(String::into_bytes))
    }

    fn put(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
        let value = String::from_utf8(value.to_vec())
            .map_err(|_| "only text is kept in the secrets file".to_string())?;
        self.change(|m| {
            m.insert(item_key(service, account), value);
            true
        })
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        self.change(|m| m.remove(&item_key(service, account)).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::super::os_store::Plain;
    use super::super::Read;
    use super::*;

    fn store_in(dir: &Path) -> FileStore {
        FileStore::new(
            dir.join("secrets.enc"),
            KeySource::Beside(dir.join("secrets.key")),
        )
    }

    #[test]
    fn a_secret_survives_a_restart_and_is_not_on_disk_in_the_clear() {
        let dir = tempfile::tempdir().unwrap();
        let plain = Plain::new(store_in(dir.path()), None);
        assert_eq!(plain.read("mogbot-connection-x", "token"), Read::NotFound);
        plain
            .write("mogbot-connection-x", "token", "sk-live-very-secret")
            .unwrap();
        // A new launch: a fresh store over the same files.
        let next = Plain::new(store_in(dir.path()), None);
        assert_eq!(
            next.read("mogbot-connection-x", "token"),
            Read::Found("sk-live-very-secret".into())
        );
        let on_disk = std::fs::read(dir.path().join("secrets.enc")).unwrap();
        let text = String::from_utf8_lossy(&on_disk);
        assert!(!text.contains("sk-live-very-secret"));
        assert!(
            !text.contains("mogbot-connection-x"),
            "names are sealed too"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_store_and_its_key_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(dir.path());
        s.put("svc", "a", b"v").unwrap();
        for name in ["secrets.enc", "secrets.key"] {
            let mode = std::fs::metadata(dir.path().join(name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{name}");
        }
    }

    #[test]
    fn a_read_before_anything_is_kept_makes_no_key() {
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(dir.path());
        assert_eq!(s.get("svc", "a"), Ok(None));
        assert!(!dir.path().join("secrets.key").exists());
        s.delete("svc", "a").unwrap();
        assert!(!dir.path().join("secrets.enc").exists());
    }

    #[test]
    fn a_lost_or_wrong_key_is_an_error_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        store_in(dir.path()).put("svc", "a", b"keep me").unwrap();
        let before = std::fs::read(dir.path().join("secrets.enc")).unwrap();

        // The key is gone: couldn't check, and a write mustn't start afresh.
        std::fs::rename(dir.path().join("secrets.key"), dir.path().join("moved")).unwrap();
        let s = store_in(dir.path());
        assert!(s.get("svc", "a").is_err());
        assert!(s.put("svc", "b", b"new").is_err());
        assert!(matches!(
            Plain::new(store_in(dir.path()), None).read("svc", "a"),
            Read::Error(_)
        ));

        // Another box's key: the same.
        std::fs::write(dir.path().join("secrets.key"), [7u8; 32]).unwrap();
        let s = store_in(dir.path());
        assert!(s.get("svc", "a").unwrap_err().contains("doesn't open"));
        assert!(s.put("svc", "b", b"new").is_err());
        assert_eq!(
            std::fs::read(dir.path().join("secrets.enc")).unwrap(),
            before
        );

        // The right key back: everything is there.
        std::fs::rename(dir.path().join("moved"), dir.path().join("secrets.key")).unwrap();
        assert_eq!(
            store_in(dir.path()).get("svc", "a"),
            Ok(Some(b"keep me".to_vec()))
        );
    }

    #[test]
    fn a_tampered_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(dir.path());
        s.put("svc", "a", b"v").unwrap();
        let path = dir.path().join("secrets.enc");
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        assert!(s.get("svc", "a").is_err());
        std::fs::write(&path, b"not a store").unwrap();
        assert!(s.get("svc", "a").unwrap_err().contains("isn't one"));
    }

    #[test]
    fn items_are_kept_apart_and_deleted_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(dir.path());
        s.put("svc", "a", b"1").unwrap();
        s.put("svc", "b", b"2").unwrap();
        s.put("other", "a", b"3").unwrap();
        s.delete("svc", "a").unwrap();
        assert_eq!(s.get("svc", "a"), Ok(None));
        assert_eq!(s.get("svc", "b"), Ok(Some(b"2".to_vec())));
        assert_eq!(s.get("other", "a"), Ok(Some(b"3".to_vec())));
    }

    #[test]
    fn a_given_key_is_used_and_never_made() {
        let dir = tempfile::tempdir().unwrap();
        let given = dir.path().join("given");
        let s = FileStore::new(
            dir.path().join("secrets.enc"),
            KeySource::Given(given.clone()),
        );
        assert!(s.put("svc", "a", b"v").is_err(), "no key handed in yet");
        assert!(!given.exists());
        // A Docker secret as hex text, with its trailing newline.
        std::fs::write(&given, format!("{}\n", "ab".repeat(32))).unwrap();
        s.put("svc", "a", b"v").unwrap();
        assert_eq!(s.get("svc", "a"), Ok(Some(b"v".to_vec())));
        std::fs::write(&given, "short").unwrap();
        assert!(s.get("svc", "a").unwrap_err().contains("too short"));
    }

    #[test]
    fn a_handed_in_key_outranks_ours() {
        let dir = tempfile::tempdir().unwrap();
        let creds = tempfile::tempdir().unwrap();
        let ours = KeySource::Beside(dir.path().join("secrets.key"));
        assert_eq!(key_source_from(dir.path(), None, None), ours);
        // A credentials folder without our credential in it changes nothing.
        assert_eq!(
            key_source_from(dir.path(), Some(creds.path().to_path_buf()), None),
            ours
        );
        let cred = creds
            .path()
            .join(format!("{}-secret-key", crate::brand::SLUG));
        std::fs::write(&cred, [1u8; 32]).unwrap();
        assert_eq!(
            key_source_from(dir.path(), Some(creds.path().to_path_buf()), None),
            KeySource::Given(cred)
        );
        let file = dir.path().join("docker-secret");
        assert_eq!(
            key_source_from(
                dir.path(),
                Some(creds.path().to_path_buf()),
                Some(file.clone())
            ),
            KeySource::Given(file)
        );
    }
}
