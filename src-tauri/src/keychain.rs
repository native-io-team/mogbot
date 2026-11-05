//! The app's secrets in the macOS keychain: workspace account tokens
//! (`commands::accounts`) and agents' secrets (`agents::secrets`).
//!
//! Items are written with `SecItemAdd` from this process, so the keychain
//! records *this app* as the only application trusted to read them without
//! asking. Items the app used to write through the `security` CLI trusted
//! `/usr/bin/security` instead, which meant any process running as the user
//! could read every secret silently with `security find-generic-password -w`.
//!
//! Migration is transparent: an item is found by its attributes alone (which
//! never asks the user), and one without our [`MARKER`] comment is an old CLI
//! item. It is read the old way, deleted, and added again the new way; if
//! the new add fails the value is put back exactly as it was, so a failed
//! migration never loses a secret.
//!
//! In an unsigned or ad-hoc-signed dev build the trusted application is the
//! binary's hash, so a rebuilt dev binary is asked once ("Always Allow")
//! per item. A signed release keeps its designated requirement across
//! updates and is never asked.

/// The comment every item written the new way carries.
pub const MARKER: &str = "dashbot-v2";

#[cfg(target_os = "macos")]
// Only for the local `security` tool (old items): synchronous callers, no
// network, answers in milliseconds.
#[allow(clippy::disallowed_methods)]
mod imp {
    use super::MARKER;
    use core_foundation::data::CFData;
    use security_framework::item::{
        ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, Limit, Location, SearchResult,
    };
    use security_framework::os::macos::keychain::SecKeychain;
    use std::path::PathBuf;

    const NOT_FOUND: i32 = -25300;

    /// Which keychain: the user's default, or a file (tests use their own).
    #[derive(Clone, Default)]
    pub struct Vault {
        pub file: Option<PathBuf>,
    }

    /// What is stored under (service, account), as far as attributes say.
    #[derive(Debug, PartialEq)]
    pub enum Found {
        Missing,
        Ours,
        Legacy,
    }

    impl Vault {
        fn keychain(&self) -> Result<Option<SecKeychain>, String> {
            match &self.file {
                Some(p) => SecKeychain::open(p).map(Some).map_err(|e| e.to_string()),
                None => Ok(None),
            }
        }

        fn search(&self, service: &str, account: &str) -> Result<ItemSearchOptions, String> {
            let mut s = ItemSearchOptions::new();
            s.class(ItemClass::generic_password())
                .service(service)
                .account(account)
                .limit(Limit::Max(1));
            if let Some(k) = self.keychain()? {
                s.keychains(&[k]);
            }
            Ok(s)
        }

        /// Attributes only: never puts up a keychain prompt.
        pub fn find(&self, service: &str, account: &str) -> Result<Found, String> {
            let mut s = self.search(service, account)?;
            s.load_attributes(true);
            match s.search() {
                Ok(items) => Ok(match items.first().and_then(SearchResult::simplify_dict) {
                    None => Found::Missing,
                    Some(attrs) if attrs.get("icmt").map(String::as_str) == Some(MARKER) => {
                        Found::Ours
                    }
                    Some(_) => Found::Legacy,
                }),
                Err(e) if e.code() == NOT_FOUND => Ok(Found::Missing),
                Err(e) => Err(e.to_string()),
            }
        }

        fn read_ours(&self, service: &str, account: &str) -> Option<String> {
            let mut s = self.search(service, account).ok()?;
            s.load_data(true);
            let items = s.search().ok()?;
            match items.into_iter().next()? {
                SearchResult::Data(bytes) => String::from_utf8(bytes).ok(),
                _ => None,
            }
        }

        fn add_ours(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            let mut add = ItemAddOptions::new(ItemAddValue::Data {
                class: ItemClass::generic_password(),
                data: CFData::from_buffer(value.as_bytes()),
            });
            add.set_service(service)
                .set_account_name(account)
                .set_label(service)
                .set_comment(MARKER);
            if let Some(k) = self.keychain()? {
                add.set_location(Location::FileKeychain(k));
            }
            add.add().map_err(|e| e.to_string())
        }

        fn delete_ours(&self, service: &str, account: &str) -> Result<(), String> {
            let s = self.search(service, account)?;
            match s.delete() {
                Ok(()) => Ok(()),
                Err(e) if e.code() == NOT_FOUND => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }

        fn cli(&self, args: &[&str]) -> std::process::Command {
            let mut cmd = crate::utils::create_command("security");
            cmd.args(args);
            if let Some(p) = &self.file {
                cmd.arg(p);
            }
            cmd
        }

        /// The old way: `security` reads an item it created without asking.
        fn read_legacy(&self, service: &str, account: &str) -> Option<String> {
            let out = self
                .cli(&["find-generic-password", "-a", account, "-s", service, "-w"])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!value.is_empty()).then_some(value)
        }

        fn delete_legacy(&self, service: &str, account: &str) -> bool {
            self.cli(&["delete-generic-password", "-a", account, "-s", service])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }

        /// Only for undoing a failed migration (and tests): the value goes
        /// on stdin, never argv. A trailing keychain path after a bare `-w`
        /// would be read as the password (and the item land in the login
        /// keychain), so a file keychain — tests only, throwaway values —
        /// takes `-w <value>` before the path.
        pub fn write_legacy(&self, service: &str, account: &str, value: &str) -> bool {
            use std::io::Write;
            if self.file.is_some() {
                return self
                    .cli(&[
                        "add-generic-password",
                        "-U",
                        "-a",
                        account,
                        "-s",
                        service,
                        "-w",
                        value,
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success());
            }
            let Ok(mut child) = self
                .cli(&[
                    "add-generic-password",
                    "-U",
                    "-a",
                    account,
                    "-s",
                    service,
                    "-w",
                ])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            else {
                return false;
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(format!("{value}\n{value}\n").as_bytes());
            }
            child.wait().is_ok_and(|s| s.success())
        }

        pub fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            match self.find(service, account)? {
                Found::Missing => {}
                Found::Ours => self.delete_ours(service, account)?,
                Found::Legacy => {
                    if !self.delete_legacy(service, account) {
                        return Err("couldn't replace the old keychain item".into());
                    }
                }
            }
            self.add_ours(service, account, value)
        }

        pub fn read(&self, service: &str, account: &str) -> Option<String> {
            match self.find(service, account).ok()? {
                Found::Missing => None,
                Found::Ours => self.read_ours(service, account).filter(|v| !v.is_empty()),
                Found::Legacy => {
                    let value = self.read_legacy(service, account)?;
                    self.migrate(service, account, &value);
                    Some(value)
                }
            }
        }

        /// Old item → new item. The value is already in hand; if the new add
        /// fails it is written back the old way.
        fn migrate(&self, service: &str, account: &str, value: &str) {
            if !self.delete_legacy(service, account) {
                tracing::warn!(%service, "[Keychain] couldn't remove an old item; left as it was");
                return;
            }
            match self.add_ours(service, account, value) {
                Ok(()) => {
                    tracing::info!(%service, "[Keychain] migrated an item to app-only access")
                }
                Err(e) => {
                    let restored = self.write_legacy(service, account, value);
                    tracing::warn!(%service, error = %e, restored, "[Keychain] migration failed; old item restored");
                }
            }
        }

        pub fn delete(&self, service: &str, account: &str) {
            match self.find(service, account) {
                Ok(Found::Ours) => {
                    let _ = self.delete_ours(service, account);
                }
                Ok(Found::Legacy) => {
                    let _ = self.delete_legacy(service, account);
                }
                _ => {}
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{Found, Vault};

/// Store `value` under (`service`, `account`) in the default keychain,
/// readable without asking by this app only.
#[cfg(target_os = "macos")]
pub fn write(service: &str, account: &str, value: &str) -> Result<(), String> {
    Vault::default().write(service, account, value)
}

#[cfg(target_os = "macos")]
pub fn read(service: &str, account: &str) -> Option<String> {
    Vault::default().read(service, account)
}

#[cfg(target_os = "macos")]
pub fn delete(service: &str, account: &str) {
    Vault::default().delete(service, account)
}

#[cfg(all(test, target_os = "macos"))]
#[allow(clippy::disallowed_methods)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway keychain file: never the user's own.
    struct TempKeychain {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
    }

    impl TempKeychain {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("test.keychain-db");
            let ok = Command::new("security")
                .args(["create-keychain", "-p", "pw"])
                .arg(&path)
                .status()
                .unwrap()
                .success();
            assert!(ok, "create-keychain");
            // No auto-lock during the test.
            let _ = Command::new("security")
                .arg("set-keychain-settings")
                .arg(&path)
                .status();
            Self { _dir: dir, path }
        }

        fn vault(&self) -> Vault {
            Vault {
                file: Some(self.path.clone()),
            }
        }

        /// The trusted-application list of every item, as `security` prints it.
        fn acl_dump(&self) -> String {
            let out = Command::new("security")
                .args(["dump-keychain", "-a"])
                .arg(&self.path)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
    }

    impl Drop for TempKeychain {
        fn drop(&mut self) {
            let _ = Command::new("security")
                .arg("delete-keychain")
                .arg(&self.path)
                .status();
        }
    }

    #[test]
    fn writes_read_back_overwrite_and_delete_in_a_temp_keychain() {
        let kc = TempKeychain::new();
        let v = kc.vault();
        assert_eq!(v.find("svc", "acct").unwrap(), Found::Missing);
        v.write("svc", "acct", "s3cret value").unwrap();
        assert_eq!(v.find("svc", "acct").unwrap(), Found::Ours);
        assert_eq!(v.read("svc", "acct").as_deref(), Some("s3cret value"));
        v.write("svc", "acct", "second").unwrap();
        assert_eq!(v.read("svc", "acct").as_deref(), Some("second"));
        v.delete("svc", "acct");
        assert_eq!(v.find("svc", "acct").unwrap(), Found::Missing);
        assert_eq!(v.read("svc", "acct"), None);
    }

    #[test]
    fn a_new_item_trusts_this_process_not_the_security_tool() {
        let kc = TempKeychain::new();
        kc.vault().write("svc-acl", "acct", "x").unwrap();
        let dump = kc.acl_dump();
        let me = std::env::current_exe().unwrap();
        let me = me.to_string_lossy();
        assert!(dump.contains(MARKER), "marker comment missing:\n{dump}");
        assert!(
            dump.contains(me.as_ref()),
            "this binary isn't trusted:\n{dump}"
        );
        assert!(
            !dump.contains("/usr/bin/security"),
            "the security CLI is trusted:\n{dump}"
        );
    }

    #[test]
    fn an_old_cli_item_is_migrated_on_first_read() {
        let kc = TempKeychain::new();
        let v = kc.vault();
        assert!(v.write_legacy("svc-old", "acct", "legacy value"));
        assert!(kc.acl_dump().contains("/usr/bin/security"));
        assert_eq!(v.find("svc-old", "acct").unwrap(), Found::Legacy);

        assert_eq!(v.read("svc-old", "acct").as_deref(), Some("legacy value"));
        assert_eq!(v.find("svc-old", "acct").unwrap(), Found::Ours);
        assert_eq!(v.read("svc-old", "acct").as_deref(), Some("legacy value"));
        assert!(!kc.acl_dump().contains("/usr/bin/security"));
    }

    #[test]
    fn writing_over_an_old_item_replaces_it() {
        let kc = TempKeychain::new();
        let v = kc.vault();
        assert!(v.write_legacy("svc-w", "acct", "old"));
        v.write("svc-w", "acct", "new").unwrap();
        assert_eq!(v.find("svc-w", "acct").unwrap(), Found::Ours);
        assert_eq!(v.read("svc-w", "acct").as_deref(), Some("new"));
    }

    /// The real default keychain, with one temporary item of our own that is
    /// deleted again. Ignored by default (needs a logged-in GUI session);
    /// run with `cargo test --lib keychain -- --ignored`.
    #[test]
    #[ignore]
    fn round_trip_in_the_login_keychain_with_a_temporary_item() {
        let service = format!(
            "{}-keychain-selftest-{}",
            crate::brand::SLUG,
            std::process::id()
        );
        write(&service, "probe", "temporary").unwrap();
        assert_eq!(read(&service, "probe").as_deref(), Some("temporary"));
        delete(&service, "probe");
        assert_eq!(read(&service, "probe"), None);
    }
}
