//! Secrets on Windows and Linux: one item per secret in the system's own
//! store (Windows Credential Manager, the Secret Service), through
//! [`super::keyring_store`]. The policy lives here, over [`Blobs`], so it is
//! tested on any platform.
//!
//! None of the macOS machinery applies: there were never legacy items, a
//! development build or a previous name on these platforms, so every secret
//! starts fresh under its own name.
//!
//! - **Errors are not absence**, as on macOS: `Ok(None)` from the store is the
//!   only "not there"; anything else (no Secret Service running, a locked
//!   collection, a logon session without a vault) is [`Read::Error`].
//! - **A write is read back** before it counts, and the value cached for the
//!   launch only then.
//! - **Long values are split.** A Windows generic credential holds at most
//!   2,560 bytes, and an OAuth token set can be longer. Such a value is kept
//!   as parts under `<account>#1`, `#2`… (`#` is in no account name) and a
//!   small manifest under the account itself, written last, so a read never
//!   sees a manifest whose parts aren't there yet. A value that happens to
//!   start like a manifest is split too, so it is never misread as one.

// On macOS only its tests use it.
#![cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]

use super::Read;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The primitive operations of a platform store, by (service, account).
pub trait Blobs: Send + Sync {
    /// `Ok(None)` only when there is definitely no such item.
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String>;
    /// Create the item, or replace its value.
    fn put(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String>;
    /// Remove the item; one that isn't there is `Ok`.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

/// The start of a manifest: no text secret begins with a NUL.
const MANIFEST: &[u8] = b"\0parts:";

fn part_account(account: &str, i: usize) -> String {
    format!("{account}#{i}")
}

fn manifest(parts: usize) -> Vec<u8> {
    let mut m = MANIFEST.to_vec();
    m.extend_from_slice(parts.to_string().as_bytes());
    m
}

/// How many parts a stored value names, when it is a manifest.
fn manifest_parts(stored: &[u8]) -> Option<usize> {
    let n = std::str::from_utf8(stored.strip_prefix(MANIFEST)?).ok()?;
    n.parse().ok().filter(|n| *n > 0)
}

/// The value in pieces no longer than `max_blob`.
fn split(value: &[u8], max_blob: Option<usize>) -> Vec<&[u8]> {
    match max_blob {
        Some(max) if value.len() > max => value.chunks(max.max(1)).collect(),
        _ => vec![value],
    }
}

type ItemKey = (String, String);

/// The policy over a [`Blobs`]. One per process.
pub struct Plain<B: Blobs> {
    blobs: B,
    /// The largest value one item holds (`None`: no limit worth splitting at).
    max_blob: Option<usize>,
    /// Successful reads and verified writes this launch.
    cache: Mutex<HashMap<ItemKey, String>>,
    locks: Mutex<HashMap<ItemKey, Arc<Mutex<()>>>>,
}

impl<B: Blobs> Plain<B> {
    pub fn new(blobs: B, max_blob: Option<usize>) -> Self {
        Plain {
            blobs,
            max_blob,
            cache: Mutex::default(),
            locks: Mutex::default(),
        }
    }

    fn item_lock(&self, service: &str, account: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks
            .entry((service.to_string(), account.to_string()))
            .or_default()
            .clone()
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, HashMap<ItemKey, String>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn read(&self, service: &str, account: &str) -> Read {
        let lock = self.item_lock(service, account);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let key = (service.to_string(), account.to_string());
        if let Some(v) = self.cache().get(&key) {
            return Read::Found(v.clone());
        }
        let read = self.read_stored(service, account);
        if let Read::Found(v) = &read {
            self.cache().insert(key, v.clone());
        }
        read
    }

    fn read_stored(&self, service: &str, account: &str) -> Read {
        let stored = match self.blobs.get(service, account) {
            Ok(Some(b)) => b,
            Ok(None) => return Read::NotFound,
            Err(e) => return Read::Error(e),
        };
        let bytes = match manifest_parts(&stored) {
            None => stored,
            Some(n) => {
                let mut all = Vec::new();
                for i in 1..=n {
                    match self.blobs.get(service, &part_account(account, i)) {
                        Ok(Some(p)) => all.extend_from_slice(&p),
                        // Never "not there": the manifest says it is.
                        Ok(None) => return Read::Error("part of this secret is missing".into()),
                        Err(e) => return Read::Error(e),
                    }
                }
                all
            }
        };
        match String::from_utf8(bytes) {
            Ok(v) if v.is_empty() => Read::NotFound,
            Ok(v) => Read::Found(v),
            Err(_) => Read::Error("the stored value isn't text".into()),
        }
    }

    /// How many parts the item under (`service`, `account`) has now (0 for a
    /// single value or none).
    fn stored_parts(&self, service: &str, account: &str) -> Result<usize, String> {
        Ok(self
            .blobs
            .get(service, account)?
            .as_deref()
            .and_then(manifest_parts)
            .unwrap_or(0))
    }

    pub fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let lock = self.item_lock(service, account);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let key = (service.to_string(), account.to_string());
        self.cache().remove(&key);
        let old_parts = self.stored_parts(service, account)?;
        let parts = split(value.as_bytes(), self.max_blob);
        let new_parts = if parts.len() == 1 && !value.as_bytes().starts_with(MANIFEST) {
            self.blobs.put(service, account, value.as_bytes())?;
            0
        } else {
            for (i, part) in parts.iter().enumerate() {
                self.blobs
                    .put(service, &part_account(account, i + 1), part)?;
            }
            self.blobs.put(service, account, &manifest(parts.len()))?;
            parts.len()
        };
        match self.read_stored(service, account) {
            Read::Found(v) if v == value => {}
            Read::Error(e) => return Err(e),
            _ => return Err("the value didn't read back the same".into()),
        }
        // Parts a longer earlier value left behind.
        for i in new_parts + 1..=old_parts {
            if let Err(e) = self.blobs.delete(service, &part_account(account, i)) {
                tracing::warn!(service, error = %e, "[Keychain] couldn't remove a stale part");
            }
        }
        self.cache().insert(key, value.to_string());
        Ok(())
    }

    /// Remove the secret and every part of it. The first failure is
    /// returned, after trying the rest.
    pub fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let lock = self.item_lock(service, account);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        self.cache()
            .remove(&(service.to_string(), account.to_string()));
        let mut first_err = None;
        match self.stored_parts(service, account) {
            Ok(n) => {
                for i in 1..=n {
                    if let Err(e) = self.blobs.delete(service, &part_account(account, i)) {
                        first_err.get_or_insert(e);
                    }
                }
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
        if let Err(e) = self.blobs.delete(service, account) {
            first_err.get_or_insert(e);
        }
        first_err.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<ItemKey, Vec<u8>>>,
        unavailable: AtomicBool,
        max: Option<usize>,
    }

    impl Fake {
        fn len(&self) -> usize {
            self.items.lock().unwrap().len()
        }
        fn check(&self) -> Result<(), String> {
            if self.unavailable.load(Ordering::SeqCst) {
                Err("no Secret Service is running".into())
            } else {
                Ok(())
            }
        }
    }

    impl Blobs for Arc<Fake> {
        fn get(&self, s: &str, a: &str) -> Result<Option<Vec<u8>>, String> {
            self.check()?;
            Ok(self
                .items
                .lock()
                .unwrap()
                .get(&(s.into(), a.into()))
                .cloned())
        }
        fn put(&self, s: &str, a: &str, v: &[u8]) -> Result<(), String> {
            self.check()?;
            if self.max.is_some_and(|m| v.len() > m) {
                return Err("too long".into());
            }
            self.items
                .lock()
                .unwrap()
                .insert((s.into(), a.into()), v.to_vec());
            Ok(())
        }
        fn delete(&self, s: &str, a: &str) -> Result<(), String> {
            self.check()?;
            self.items.lock().unwrap().remove(&(s.into(), a.into()));
            Ok(())
        }
    }

    fn store(max: Option<usize>) -> (Arc<Fake>, Plain<Arc<Fake>>) {
        let fake = Arc::new(Fake {
            max,
            ..Default::default()
        });
        (fake.clone(), Plain::new(fake, max))
    }

    #[test]
    fn found_missing_and_unavailable_are_three_answers() {
        let (fake, plain) = store(None);
        assert_eq!(plain.read("svc", "KEY"), Read::NotFound);
        plain.write("svc", "KEY", "secret").unwrap();
        assert_eq!(plain.read("svc", "KEY"), Read::Found("secret".into()));
        // A new launch with the store gone: couldn't check, never "not there".
        fake.unavailable.store(true, Ordering::SeqCst);
        let next = Plain::new(fake.clone(), None);
        assert!(matches!(next.read("svc", "KEY"), Read::Error(_)));
        assert!(matches!(next.read("svc", "OTHER"), Read::Error(_)));
        assert!(next.write("svc", "KEY", "x").is_err());
    }

    #[test]
    fn a_long_value_is_split_and_read_back_whole() {
        let (fake, plain) = store(Some(10));
        let long = "abcdefghij".repeat(3) + "xyz";
        plain.write("svc", "TOKEN", &long).unwrap();
        assert_eq!(fake.len(), 5, "a manifest and four parts");
        let next = Plain::new(fake.clone(), Some(10));
        assert_eq!(next.read("svc", "TOKEN"), Read::Found(long));
        // Shorter again: one item, the old parts gone.
        next.write("svc", "TOKEN", "short").unwrap();
        assert_eq!(fake.len(), 1);
        assert_eq!(
            Plain::new(fake.clone(), Some(10)).read("svc", "TOKEN"),
            Read::Found("short".into())
        );
    }

    #[test]
    fn a_missing_part_is_an_error_not_absence() {
        let (fake, plain) = store(Some(10));
        plain.write("svc", "K", "1234567890abc").unwrap();
        fake.items
            .lock()
            .unwrap()
            .remove(&("svc".into(), "K#2".into()));
        assert!(matches!(
            Plain::new(fake, Some(10)).read("svc", "K"),
            Read::Error(_)
        ));
    }

    #[test]
    fn delete_removes_every_part() {
        let (fake, plain) = store(Some(10));
        plain.write("svc", "K", &"123456789".repeat(3)).unwrap();
        plain.write("svc", "OTHER", "keep").unwrap();
        plain.delete("svc", "K").unwrap();
        assert_eq!(fake.len(), 1);
        assert_eq!(plain.read("svc", "K"), Read::NotFound);
        // Deleting what isn't there is fine.
        plain.delete("svc", "K").unwrap();
    }

    #[test]
    fn a_value_shaped_like_a_manifest_is_never_misread() {
        let (fake, plain) = store(None);
        let odd = "\0parts:2";
        plain.write("svc", "K", odd).unwrap();
        assert_eq!(
            Plain::new(fake, None).read("svc", "K"),
            Read::Found(odd.into())
        );
    }

    #[test]
    fn multibyte_text_split_mid_character_reads_back() {
        // The 10-byte cut falls inside the key emoji.
        let (fake, plain) = store(Some(10));
        let text = "ключ-🔑-clé";
        plain.write("svc", "K", text).unwrap();
        assert_eq!(
            Plain::new(fake, Some(10)).read("svc", "K"),
            Read::Found(text.into())
        );
    }

    #[test]
    fn an_empty_value_reads_as_nothing_stored() {
        let (fake, _) = store(None);
        fake.items
            .lock()
            .unwrap()
            .insert(("svc".into(), "K".into()), Vec::new());
        assert_eq!(Plain::new(fake, None).read("svc", "K"), Read::NotFound);
    }
}
