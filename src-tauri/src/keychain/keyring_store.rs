//! The real [`Blobs`] on Windows and Linux, through the `keyring` crate.
//!
//! - **Windows:** a generic credential in Windows Credential Manager, its
//!   target name `<service>/<account>` ([`target_name`]), persisted with the
//!   user's profile. Like any generic credential it is readable by programs
//!   running as this Windows user; it is not readable by other users.
//! - **Linux:** an item in the Secret Service's default collection (GNOME
//!   Keyring, KWallet), with the attributes `service` and `username` set to
//!   the service and account. With no Secret Service on the session bus (a
//!   headless box, WSL, a minimal desktop) every call is an error, never
//!   "not there".
//!
//! Values are stored as UTF-8 bytes (`set_secret`), not as `keyring`'s
//! UTF-16 password, so a Windows credential holds the full [`MAX_BLOB`].

// On macOS only its tests use it.
#![cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]

use super::os_store::Blobs;

/// The most one item holds: a Windows generic credential's blob limit
/// (`CRED_MAX_CREDENTIAL_BLOB_SIZE`). The Secret Service has none to speak of.
pub const MAX_BLOB: Option<usize> = if cfg!(windows) { Some(2560) } else { None };

/// The Windows Credential Manager target name for (`service`, `account`):
/// what the Credential Manager lists and what a lookup matches on.
pub fn target_name(service: &str, account: &str) -> String {
    format!("{service}/{account}")
}

pub struct OsStore;

fn entry(service: &str, account: &str) -> Result<keyring::Entry, keyring::Error> {
    #[cfg(windows)]
    {
        keyring::Entry::new_with_target(&target_name(service, account), service, account)
    }
    #[cfg(not(windows))]
    {
        keyring::Entry::new(service, account)
    }
}

/// `keyring`'s answer as a [`Blobs`] answer: only `NoEntry` is "not there".
pub fn map_get(r: Result<Vec<u8>, keyring::Error>) -> Result<Option<Vec<u8>>, String> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(describe(&e)),
    }
}

/// A delete of something that isn't there succeeded.
pub fn map_delete(r: Result<(), keyring::Error>) -> Result<(), String> {
    match r {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(describe(&e)),
    }
}

pub fn describe(e: &keyring::Error) -> String {
    let store = super::STORE_NAME;
    match e {
        keyring::Error::NoStorageAccess(inner) => format!("{store} isn't available ({inner})"),
        keyring::Error::PlatformFailure(inner) => format!("{store} refused ({inner})"),
        keyring::Error::Ambiguous(_) => {
            format!("{store} holds more than one item for this secret")
        }
        other => format!("{store} refused ({other})"),
    }
}

impl Blobs for OsStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        map_get(entry(service, account).and_then(|e| e.get_secret()))
    }

    fn put(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
        entry(service, account)
            .and_then(|e| e.set_secret(value))
            .map_err(|e| describe(&e))
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        map_delete(entry(service, account).and_then(|e| e.delete_credential()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_target_name_is_service_slash_account() {
        assert_eq!(
            target_name("mogbot-account-1234", "VERCEL_TOKEN"),
            "mogbot-account-1234/VERCEL_TOKEN"
        );
        assert_eq!(
            target_name("mogbot-account-1234", "VERCEL_TOKEN#2"),
            "mogbot-account-1234/VERCEL_TOKEN#2"
        );
    }

    #[test]
    fn only_no_entry_means_not_there() {
        assert_eq!(map_get(Ok(b"v".to_vec())), Ok(Some(b"v".to_vec())));
        assert_eq!(map_get(Err(keyring::Error::NoEntry)), Ok(None));
        let unavailable = keyring::Error::NoStorageAccess("no session bus".into());
        let refused = keyring::Error::PlatformFailure("ERROR_ACCESS_DENIED".into());
        for e in [
            unavailable,
            refused,
            keyring::Error::BadEncoding(vec![0xff]),
            keyring::Error::TooLong("secret".into(), 2560),
        ] {
            let got = map_get(Err(e));
            assert!(got.is_err(), "an error is never absence: {got:?}");
            assert!(got.unwrap_err().contains(super::super::STORE_NAME));
        }
        assert_eq!(map_delete(Err(keyring::Error::NoEntry)), Ok(()));
        assert!(map_delete(Err(keyring::Error::PlatformFailure("x".into()))).is_err());
    }
}
