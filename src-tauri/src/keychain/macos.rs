//! The real [`Store`]: the Security framework for app-owned items, the
//! `security` tool for legacy ones (which trust it, so it never prompts).

use super::{Attrs, Store};
use crate::utils::create_command;
use security_framework::item::{
    update_item, ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, ItemUpdateOptions,
    ItemUpdateValue, Limit, SearchResult,
};

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
/// `security` exits 44 for "no such item".
const CLI_NOT_FOUND: i32 = 44;

pub struct MacStore;

fn query(service: &str, account: &str) -> ItemSearchOptions {
    let mut q = ItemSearchOptions::new();
    q.class(ItemClass::generic_password())
        .service(service)
        .account(account);
    q
}

fn describe(e: &security_framework::base::Error) -> String {
    format!("the Keychain refused ({e}, {})", e.code())
}

/// Signed by an Apple-issued certificate (Developer ID, Apple Development,
/// App Store): such a signature carries a team ID, so the code identity an
/// item's access list records survives an update. Ad-hoc signed builds fail
/// this, and their identity changes with every rebuild.
pub fn signed_by_apple() -> bool {
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
    let Ok(req) = "anchor apple generic".parse::<SecRequirement>() else {
        return false;
    };
    SecCode::for_self(Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &req))
        .is_ok()
}

// `security` is a local tool that answers at once (a legacy item trusts it,
// so it never shows a prompt), called from code that isn't async.
#[allow(clippy::disallowed_methods)]
impl Store for MacStore {
    fn find(&self, service: &str, account: &str) -> Result<Option<Attrs>, String> {
        let mut q = query(service, account);
        q.load_attributes(true).limit(Limit::Max(1));
        match q.search() {
            Ok(results) => Ok(results.first().map(|r| Attrs {
                comment: r
                    .simplify_dict()
                    .and_then(|d| d.get("icmt").cloned())
                    .filter(|c| !c.is_empty()),
            })),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(describe(&e)),
        }
    }

    fn framework_get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        let mut q = query(service, account);
        q.load_data(true).limit(Limit::Max(1));
        match q.search() {
            Ok(results) => Ok(results.into_iter().find_map(|r| match r {
                SearchResult::Data(d) => Some(d),
                _ => None,
            })),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(describe(&e)),
        }
    }

    fn framework_put(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
        comment: &str,
    ) -> Result<(), String> {
        let mut add = ItemAddOptions::new(ItemAddValue::Data {
            class: ItemClass::generic_password(),
            data: core_foundation::data::CFData::from_buffer(value),
        });
        add.set_service(service)
            .set_account_name(account)
            .set_comment(comment);
        match add.add() {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_DUPLICATE_ITEM => {
                let mut update = ItemUpdateOptions::new();
                update
                    .set_value(ItemUpdateValue::Data(
                        core_foundation::data::CFData::from_buffer(value),
                    ))
                    .set_comment(comment);
                update_item(&query(service, account), &update).map_err(|e| describe(&e))
            }
            Err(e) => Err(describe(&e)),
        }
    }

    fn framework_delete(&self, service: &str, account: &str) -> Result<(), String> {
        match query(service, account).delete() {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }

    fn cli_get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let output = create_command("security")
            .args(["find-generic-password", "-a", account, "-s", service, "-w"])
            .output()
            .map_err(|e| format!("couldn't run security: {e}"))?;
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok((!value.is_empty()).then_some(value));
        }
        match output.status.code() {
            Some(CLI_NOT_FOUND) => Ok(None),
            code => Err(format!(
                "the Keychain refused (security exited {})",
                code.map_or("by signal".to_string(), |c| c.to_string())
            )),
        }
    }

    fn cli_put(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        use std::io::Write;
        use std::process::Stdio;
        // The secret goes on stdin, never argv (visible to every user via
        // `ps`). With `-w` last and no value, `security` asks for it and a
        // confirmation, so it is sent twice; values are a single line.
        let mut child = create_command("security")
            .args([
                "add-generic-password",
                "-U",
                "-a",
                account,
                "-s",
                service,
                "-w",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("couldn't run security: {e}"))?;
        let wrote = child
            .stdin
            .take()
            .ok_or_else(|| "no stdin handle".to_string())
            .and_then(|mut s| {
                s.write_all(format!("{value}\n{value}\n").as_bytes())
                    .map_err(|e| e.to_string())
            });
        let status = child.wait().map_err(|e| e.to_string())?;
        wrote?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("security exited {:?}", status.code()))
        }
    }

    fn cli_delete(&self, service: &str, account: &str) -> Result<(), String> {
        let status = create_command("security")
            .args(["delete-generic-password", "-a", account, "-s", service])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("couldn't run security: {e}"))?;
        match status.code() {
            Some(0) | Some(CLI_NOT_FOUND) => Ok(()),
            code => Err(format!("security exited {code:?}")),
        }
    }
}

/// Against the real login Keychain, with throwaway items only (their own
/// service name, deleted at the end). Never `security -w` on an app-owned
/// item: that is exactly the prompt this design avoids. Run by hand:
/// `cargo test --lib keychain_live -- --ignored`.
#[cfg(test)]
mod keychain_live_tests {
    use super::super::{Mode, Read, Vault, MOVED, V2_SUFFIX, WRITTEN};
    use super::*;

    #[test]
    #[ignore = "touches the real keychain (temporary items it creates and deletes)"]
    fn keychain_live_copy_verify_keep() {
        let service = format!(
            "{}selftest-{}",
            crate::brand::keychain_prefix("account"),
            uuid::Uuid::new_v4().simple()
        );
        let v2 = format!("{service}{V2_SUFFIX}");
        let key = "SELFTEST";
        let store = MacStore;

        // An item made the old way is moved, and kept this launch.
        store.cli_put(&service, key, "legacy-value").unwrap();
        let one = Vault::new(MacStore, Mode::Owned);
        assert_eq!(one.read(&service, key), Read::Found("legacy-value".into()));
        assert_eq!(
            store
                .find(&v2, key)
                .unwrap()
                .and_then(|a| a.comment)
                .as_deref(),
            Some(MOVED)
        );
        assert!(store.find(&service, key).unwrap().is_some());

        // A later launch removes the original.
        let two = Vault::new(MacStore, Mode::Owned);
        assert_eq!(two.read(&service, key), Read::Found("legacy-value".into()));
        assert!(store.find(&service, key).unwrap().is_none());

        // Writes replace the copy in place.
        two.write(&service, key, "two").unwrap();
        assert_eq!(
            store
                .find(&v2, key)
                .unwrap()
                .and_then(|a| a.comment)
                .as_deref(),
            Some(WRITTEN)
        );
        let three = Vault::new(MacStore, Mode::Owned);
        assert_eq!(three.read(&service, key), Read::Found("two".into()));

        three.delete(&service, key).unwrap();
        assert!(store.find(&v2, key).unwrap().is_none());
        assert!(store.find(&service, key).unwrap().is_none());
        assert_eq!(three.read(&service, key), Read::NotFound);
    }
}
