//! Where the Mac's identity key lives: the login Keychain, not
//! `companion.json`.
//!
//! In the JSON it was readable by any process running as this user (the
//! agents the app runs among them), copied in plain text by Time Machine,
//! and lost whenever an older build rewrote the file without the field. The
//! Keychain keeps it out of all three. Through the `security` tool, as the
//! other Keychain items here are (`commands::accounts`).
//!
//! The one distinction that matters is "there is no key" (make one) versus
//! "the Keychain didn't answer" (locked, refused): treating the second as
//! the first would throw away the key every paired phone pinned.

use crate::errors::CommandError;

pub trait KeyStore: Send + Sync {
    /// `Ok(None)` only when there is definitely no key.
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, pkcs8_b64: &str) -> Result<(), String>;
}

/// The login Keychain, under one generic password item.
pub struct Keychain {
    service: String,
    account: String,
}

impl Keychain {
    /// The app's own item.
    pub fn app() -> Self {
        Self::named(
            format!("{}identity", crate::brand::keychain_prefix("companion")),
            "identity-key".into(),
        )
    }

    /// Any item (tests make a throwaway one).
    pub fn named(service: String, account: String) -> Self {
        Keychain { service, account }
    }

    /// Remove the item (tests clean up after themselves).
    pub fn delete(&self) {
        crate::commands::accounts::keychain_delete(&self.service, &self.account);
    }
}

/// `security find-generic-password` exits 44 for "no such item".
const ERR_SEC_ITEM_NOT_FOUND: i32 = 44;

impl KeyStore for Keychain {
    // A local tool that answers at once, read once per launch, from code
    // that isn't async; the same call `commands::accounts::keychain_read` makes.
    #[allow(clippy::disallowed_methods)]
    fn load(&self) -> Result<Option<String>, String> {
        if !cfg!(target_os = "macos") {
            return Err("there's no Keychain on this platform".into());
        }
        let output = crate::utils::create_command("security")
            .args([
                "find-generic-password",
                "-a",
                &self.account,
                "-s",
                &self.service,
                "-w",
            ])
            .output()
            .map_err(|e| format!("couldn't run security: {e}"))?;
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok((!value.is_empty()).then_some(value));
        }
        match output.status.code() {
            Some(ERR_SEC_ITEM_NOT_FOUND) => Ok(None),
            code => Err(format!(
                "the Keychain refused (security exited {})",
                code.map_or("by signal".to_string(), |c| c.to_string())
            )),
        }
    }

    fn save(&self, pkcs8_b64: &str) -> Result<(), String> {
        crate::commands::accounts::keychain_write(&self.service, &self.account, pkcs8_b64)
            .map_err(|e: CommandError| e.to_string())
    }
}

/// In memory, for tests: a key, and switches to make it fail.
#[cfg(test)]
#[derive(Default)]
pub struct Memory {
    pub key: std::sync::Mutex<Option<String>>,
    pub fail_load: std::sync::atomic::AtomicBool,
    pub fail_save: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl KeyStore for std::sync::Arc<Memory> {
    fn load(&self) -> Result<Option<String>, String> {
        use std::sync::atomic::Ordering;
        if self.fail_load.load(Ordering::SeqCst) {
            return Err("locked".into());
        }
        Ok(self.key.lock().unwrap().clone())
    }

    fn save(&self, pkcs8_b64: &str) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        if self.fail_save.load(Ordering::SeqCst) {
            return Err("refused".into());
        }
        *self.key.lock().unwrap() = Some(pkcs8_b64.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the real login Keychain, with a throwaway item made and then
    /// deleted here. Ignored by default: it touches the Keychain.
    /// `cargo test --lib companion::keystore -- --ignored`
    #[test]
    #[ignore = "uses the real login Keychain (a temporary item it deletes)"]
    fn the_keychain_tells_missing_from_kept() {
        let store = Keychain::named(
            format!(
                "{}test-{}",
                crate::brand::keychain_prefix("companion"),
                uuid::Uuid::new_v4().simple()
            ),
            "identity-key".into(),
        );
        assert_eq!(store.load(), Ok(None), "nothing there yet");
        let (_, doc) = super::super::identity::Identity::generate().unwrap();
        store.save(&doc).unwrap();
        assert_eq!(store.load(), Ok(Some(doc.clone())));
        store.delete();
        assert_eq!(store.load(), Ok(None), "and gone again");
    }
}
