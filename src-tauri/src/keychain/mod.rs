//! The login Keychain, for every secret the app keeps (workspace
//! credentials, agents' secrets, the companion's identity key).
//!
//! Everything below is about macOS. On Windows (Credential Manager) and
//! Linux (the Secret Service) secrets go through [`os_store`] instead, which
//! keeps the same three-way [`Read`] and nothing else of this: those
//! platforms never had legacy items or a previous name. The user-facing name
//! of wherever this build keeps secrets is [`STORE_NAME`].
//!
//! ## Why there are two kinds of item
//!
//! Older builds wrote items with `security add-generic-password`, so each
//! item's access list trusted `/usr/bin/security`: any process running as the
//! user could read every one with `security find-generic-password -w`, and
//! macOS never asked. A signed release now keeps each secret in an item it
//! creates itself through the Security framework, whose default access list
//! trusts this app alone. Those live under the same account and the service
//! name plus [`V2_SUFFIX`], so the two kinds never share a name and one can
//! be written before the other is touched.
//!
//! ## Moving a secret over without ever risking it
//!
//! Data safety comes first, so the move is copy, verify, keep:
//!
//! 1. The new item is written marked [`PENDING`] and read back with the very
//!    query the next launch will use. Only when the bytes match is it marked
//!    [`MOVED`]. A crash or failure anywhere in between leaves the legacy
//!    item untouched, and a pending item never outranks it.
//! 2. The legacy item is **never** deleted in the launch that wrote the new
//!    one. A later launch deletes it only after reading the new item
//!    successfully, and only when the two still hold the same value. (When
//!    the user has since replaced the value, the new item is marked
//!    [`WRITTEN`]: the legacy one holds a superseded secret and goes once the
//!    replacement has been read back in a later launch.)
//! 3. Only printable-ASCII legacy values are moved. `security -w` prints
//!    anything else as hex, so such a value can't be copied faithfully: it is
//!    left exactly where it is.
//! 4. Every step for one item runs under that item's lock, so a read that is
//!    migrating can't race a write of a new value.
//!
//! ## Development builds
//!
//! An ad-hoc signed binary (every `tauri dev` build) has no team ID; its
//! code identity is a hash that changes with each rebuild, so an item it
//! created would prompt on the next build. Those builds, and any build
//! without an Apple-issued signature, never create app-owned items and never
//! migrate or delete legacy ones: they keep the `security` path
//! ([`Mode::Legacy`]). Reads are cached per launch either way, so a prompt,
//! if one ever happens, happens once per item per launch rather than on
//! every git command.
//!
//! ## Carrying secrets over a rename
//!
//! Every service name starts with the brand's slug (`brand::keychain_prefix`,
//! `brand::scoped`), so renaming the app moves every secret's name. A read
//! that finds nothing under the new name looks under the previous one
//! (`brand.json` `previous.slug`, [`previous_service`]) and, when it finds
//! the secret there, writes it under the new name through the usual
//! verified write and returns it. Copy, verify, keep, as above:
//!
//! - The old item is never deleted in the launch that copied it. A later
//!   launch removes it once it has read the new one.
//! - A copy that fails leaves the old item alone, and the value read from it
//!   is still used; the next launch tries again.
//! - A read of the old item that fails (a Keychain prompt denied, a locked
//!   Keychain) is "couldn't check", never "not there", so nothing is lost
//!   and nothing reads as disconnected for good.
//! - Deleting a secret deletes its old-name copy too, or the next read would
//!   carry it back.
//!
//! ## Errors are not absence
//!
//! [`Read`] keeps "there is no such secret" apart from "the Keychain didn't
//! answer" (locked, refused, cancelled). Treating the second as the first
//! shows a connected account as disconnected, and for the companion's
//! identity key would throw away the key every paired phone pinned.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(any(windows, target_os = "linux", test))]
mod keyring_store;
#[cfg(any(windows, target_os = "linux", test))]
mod os_store;

/// Where this build keeps secrets, as copy says it: "the Keychain",
/// "Windows Credential Manager", "your system keyring". A macro too, for
/// `concat!`-built constants.
#[cfg(target_os = "macos")]
macro_rules! store_name {
    () => {
        "the Keychain"
    };
}
#[cfg(windows)]
macro_rules! store_name {
    () => {
        "Windows Credential Manager"
    };
}
#[cfg(target_os = "linux")]
macro_rules! store_name {
    () => {
        "your system keyring"
    };
}
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
macro_rules! store_name {
    () => {
        "a credential store"
    };
}
pub(crate) use store_name;

/// The same place, said of this computer: "this Mac's Keychain",
/// "Windows Credential Manager on this PC", "this computer's system keyring".
#[cfg(target_os = "macos")]
macro_rules! this_store {
    () => {
        "this Mac's Keychain"
    };
}
#[cfg(windows)]
macro_rules! this_store {
    () => {
        "Windows Credential Manager on this PC"
    };
}
#[cfg(not(any(target_os = "macos", windows)))]
macro_rules! this_store {
    () => {
        "this computer's system keyring"
    };
}

/// What to try when the store didn't answer, as a sentence's start (no full
/// stop): "Unlock the Keychain (or check Keychain Access)".
#[cfg(target_os = "macos")]
macro_rules! unlock_hint {
    () => {
        "Unlock the Keychain (or check Keychain Access)"
    };
}
#[cfg(windows)]
macro_rules! unlock_hint {
    () => {
        "Make sure you're signed in to Windows as yourself"
    };
}
#[cfg(not(any(target_os = "macos", windows)))]
macro_rules! unlock_hint {
    () => {
        "Unlock your system keyring (GNOME Keyring or KWallet)"
    };
}
pub(crate) use unlock_hint;

/// Where to look when the store can't keep a secret, as a whole sentence.
#[cfg(target_os = "macos")]
macro_rules! store_check {
    () => {
        "Check Keychain Access on the Mac."
    };
}
#[cfg(windows)]
macro_rules! store_check {
    () => {
        "Check Windows Credential Manager on the PC."
    };
}
#[cfg(not(any(target_os = "macos", windows)))]
macro_rules! store_check {
    () => {
        "Check that your system keyring (GNOME Keyring or KWallet) is running and unlocked."
    };
}
pub(crate) use store_check;

pub const STORE_NAME: &str = store_name!();
pub const THIS_STORE: &str = this_store!();

/// Whether this build has somewhere to keep secrets at all.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows, target_os = "linux"));

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// Appended to the service name for app-owned items. `#` appears in no
/// account, agent or companion id (they are alphanumeric and `-`), so no
/// legacy service can ever end with it.
pub const V2_SUFFIX: &str = "#v2";
/// Comment on an app-owned item whose contents haven't been verified yet.
pub const PENDING: &str = "app-owned v2 pending";
/// Comment on an app-owned item verified to hold a moved legacy value.
pub const MOVED: &str = "app-owned v2 moved";
/// Comment on an app-owned item verified to hold a value written by the app.
pub const WRITTEN: &str = "app-owned v2";
/// Comment on items an unmerged earlier build created under the legacy name
/// through the framework. Read with the framework (never `security -w`, which
/// would prompt) and otherwise treated as legacy.
pub const V1_MARK: &str = "app-owned v1";

fn is_v2_comment(comment: Option<&str>) -> bool {
    comment.is_some_and(|c| c.starts_with("app-owned v2"))
}

/// What a read found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    Found(String),
    /// Definitely no such secret.
    NotFound,
    /// The Keychain didn't answer: "couldn't check", never "not connected".
    Error(String),
}

impl Read {
    pub fn found(self) -> Option<String> {
        match self {
            Read::Found(v) => Some(v),
            _ => None,
        }
    }
}

/// Whether this binary may own items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Signed by an Apple-issued certificate: app-owned items, migration.
    Owned,
    /// Debug or ad-hoc signed: `security` only, nothing moved or deleted.
    Legacy,
}

/// An item's attributes, read without its secret (no prompt, ever).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attrs {
    pub comment: Option<String>,
}

/// The primitive operations, so the policy above is testable without the
/// real Keychain. `Ok(None)` always means "no such item"; `Err` means the
/// Keychain didn't answer.
pub trait Store: Send + Sync {
    /// Attributes only: never reads the secret, so never prompts.
    fn find(&self, service: &str, account: &str) -> Result<Option<Attrs>, String>;
    /// The secret through the Security framework.
    fn framework_get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String>;
    /// Create the item, or replace its data and comment if it exists.
    fn framework_put(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
        comment: &str,
    ) -> Result<(), String>;
    fn framework_delete(&self, service: &str, account: &str) -> Result<(), String>;
    /// `security find-generic-password -w` (trimmed).
    fn cli_get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    /// `security add-generic-password -U`, value on stdin.
    fn cli_put(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    /// `security delete-generic-password`.
    fn cli_delete(&self, service: &str, account: &str) -> Result<(), String>;
}

type ItemKey = (String, String);

#[derive(Default)]
struct LaunchState {
    /// Successful reads (and our own writes) this launch.
    cache: HashMap<ItemKey, String>,
    /// Items whose app-owned copy this launch wrote: their legacy item must
    /// survive at least until a later launch has read the copy back.
    written_this_launch: HashSet<ItemKey>,
    /// Items whose legacy cleanup has already been considered this launch.
    cleanup_checked: HashSet<ItemKey>,
    /// Items under the previous name this launch copied to the new one:
    /// they stay until a later launch has read the copy.
    renamed_this_launch: HashSet<ItemKey>,
    /// Items under the previous name whose removal was considered this launch.
    rename_cleanup_checked: HashSet<ItemKey>,
}

/// The policy over a [`Store`]. One per process ("launch").
pub struct Vault<S: Store> {
    store: S,
    mode: Mode,
    state: Mutex<LaunchState>,
    locks: Mutex<HashMap<ItemKey, Arc<Mutex<()>>>>,
}

fn v2(service: &str) -> String {
    format!("{service}{V2_SUFFIX}")
}

fn is_printable_ascii(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| (0x20..0x7f).contains(&b))
}

impl<S: Store> Vault<S> {
    pub fn new(store: S, mode: Mode) -> Self {
        Vault {
            store,
            mode,
            state: Mutex::default(),
            locks: Mutex::default(),
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    fn item_lock(&self, service: &str, account: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks
            .entry((service.to_string(), account.to_string()))
            .or_default()
            .clone()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, LaunchState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn remember(&self, key: &ItemKey, value: &str) {
        self.state().cache.insert(key.clone(), value.to_string());
    }

    pub fn read(&self, service: &str, account: &str) -> Read {
        let lock = self.item_lock(service, account);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let key: ItemKey = (service.to_string(), account.to_string());
        if let Some(v) = self.state().cache.get(&key) {
            return Read::Found(v.clone());
        }
        let read = match self.mode {
            Mode::Legacy => self.read_legacy_mode(service, account),
            Mode::Owned => self.read_owned_mode(service, account, &key),
        };
        if let Read::Found(v) = &read {
            self.remember(&key, v);
        }
        read
    }

    fn read_legacy_mode(&self, service: &str, account: &str) -> Read {
        match self.legacy_read(service, account, false) {
            Read::NotFound => match self.store.find(&v2(service), account) {
                Ok(Some(_)) => Read::Error(
                    "this secret was saved by a signed build of the app; a development build \
                     can't read it without a Keychain prompt"
                        .into(),
                ),
                Ok(None) => Read::NotFound,
                Err(e) => Read::Error(e),
            },
            other => other,
        }
    }

    fn read_owned_mode(&self, service: &str, account: &str, key: &ItemKey) -> Read {
        let v2_name = v2(service);
        let attrs = match self.store.find(&v2_name, account) {
            Ok(a) => a,
            Err(e) => return Read::Error(e),
        };
        let mut pending: Option<String> = None;
        if let Some(attrs) = attrs {
            let value = match self.store.framework_get(&v2_name, account) {
                Ok(Some(bytes)) => match String::from_utf8(bytes) {
                    Ok(v) => v,
                    Err(_) => return Read::Error("the stored value isn't text".into()),
                },
                // Gone between the two queries: fall through to legacy.
                Ok(None) => String::new(),
                Err(e) => return Read::Error(e),
            };
            if !value.is_empty() {
                if attrs.comment.as_deref() == Some(PENDING) {
                    // Unverified: the legacy item, if any, outranks it.
                    pending = Some(value);
                } else {
                    self.maybe_clean_legacy(
                        service,
                        account,
                        key,
                        &value,
                        attrs.comment.as_deref(),
                    );
                    return Read::Found(value);
                }
            }
        }
        match self.legacy_read(service, account, true) {
            Read::Found(v) => {
                if is_printable_ascii(&v) {
                    if let Err(e) = self.copy_verified(service, account, &v, MOVED) {
                        tracing::warn!(service, error = %e, "[Keychain] couldn't move a legacy item; it stays where it is");
                    } else {
                        self.state().written_this_launch.insert(key.clone());
                    }
                }
                Read::Found(v)
            }
            Read::NotFound => match pending {
                // The only copy there is: use it, and finish verifying it.
                Some(v) => {
                    if self.copy_verified(service, account, &v, WRITTEN).is_ok() {
                        self.state().written_this_launch.insert(key.clone());
                    }
                    Read::Found(v)
                }
                None => Read::NotFound,
            },
            Read::Error(e) => match pending {
                Some(v) => Read::Found(v),
                None => Read::Error(e),
            },
        }
    }

    /// The legacy item under the plain service name. `framework_ok`: a V1
    /// item may be read through the framework (only in [`Mode::Owned`]; in a
    /// development build that read would prompt).
    fn legacy_read(&self, service: &str, account: &str, framework_ok: bool) -> Read {
        let attrs = match self.store.find(service, account) {
            Ok(None) => return Read::NotFound,
            Ok(Some(a)) => a,
            Err(e) => return Read::Error(e),
        };
        match attrs.comment.as_deref() {
            Some(c) if is_v2_comment(Some(c)) => {
                Read::Error("an app-owned item is under a legacy name".into())
            }
            Some(V1_MARK) if !framework_ok => Read::Error(
                "this secret was saved by another build of the app; reading it here would prompt"
                    .into(),
            ),
            Some(V1_MARK) => match self.store.framework_get(service, account) {
                Ok(Some(bytes)) => match String::from_utf8(bytes) {
                    Ok(v) if !v.is_empty() => Read::Found(v),
                    Ok(_) => Read::NotFound,
                    Err(_) => Read::Error("the stored value isn't text".into()),
                },
                Ok(None) => Read::NotFound,
                Err(e) => Read::Error(e),
            },
            _ => match self.store.cli_get(service, account) {
                Ok(Some(v)) if !v.is_empty() => Read::Found(v),
                Ok(_) => Read::NotFound,
                Err(e) => Read::Error(e),
            },
        }
    }

    /// Write the app-owned copy marked pending, read it back with the same
    /// query a later launch uses, and only on a byte-for-byte match mark it
    /// `final_mark`. Never touches the legacy item.
    fn copy_verified(
        &self,
        service: &str,
        account: &str,
        value: &str,
        final_mark: &str,
    ) -> Result<(), String> {
        let name = v2(service);
        self.store
            .framework_put(&name, account, value.as_bytes(), PENDING)?;
        match self.store.framework_get(&name, account) {
            Ok(Some(bytes)) if bytes == value.as_bytes() => {}
            Ok(_) => {
                // A copy that doesn't read back right must not outlive this
                // call (it's still pending, so it can't outrank legacy, but
                // there's no reason to keep it).
                let _ = self.store.framework_delete(&name, account);
                return Err("the copy didn't read back the same".into());
            }
            Err(e) => return Err(e),
        }
        self.store
            .framework_put(&name, account, value.as_bytes(), final_mark)
    }

    /// In a launch after the one that wrote the app-owned copy, and having
    /// just read that copy successfully: delete the legacy item, if it holds
    /// the same value (or, for a value the user rewrote, a superseded one).
    fn maybe_clean_legacy(
        &self,
        service: &str,
        account: &str,
        key: &ItemKey,
        v2_value: &str,
        v2_comment: Option<&str>,
    ) {
        {
            let mut st = self.state();
            if st.written_this_launch.contains(key) || !st.cleanup_checked.insert(key.clone()) {
                return;
            }
        }
        let rewritten = v2_comment == Some(WRITTEN);
        if !rewritten && v2_comment != Some(MOVED) {
            return;
        }
        match self.legacy_read(service, account, true) {
            Read::Found(old) if old == v2_value || rewritten => {
                if let Err(e) = self.legacy_delete(service, account) {
                    tracing::warn!(service, error = %e, "[Keychain] couldn't remove a moved legacy item");
                }
            }
            Read::Found(_) => {
                tracing::warn!(
                    service,
                    "[Keychain] legacy item differs from the app-owned copy; keeping both"
                );
            }
            Read::NotFound | Read::Error(_) => {}
        }
    }

    /// Delete the legacy item, identified by an attributes-only query, and
    /// never an app-owned v2 one.
    fn legacy_delete(&self, service: &str, account: &str) -> Result<(), String> {
        match self.store.find(service, account)? {
            None => Ok(()),
            Some(a) if is_v2_comment(a.comment.as_deref()) => {
                Err("refusing to delete an app-owned item".into())
            }
            Some(a) if a.comment.as_deref() == Some(V1_MARK) => {
                self.store.framework_delete(service, account)
            }
            Some(_) => self.store.cli_delete(service, account),
        }
    }

    pub fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let carry = self.carry_lock(service, account);
        let _carrying = carry.lock().unwrap_or_else(|e| e.into_inner());
        self.write_unlocked(service, account, value)
    }

    fn write_unlocked(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let lock = self.item_lock(service, account);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let key: ItemKey = (service.to_string(), account.to_string());
        // Whatever happens next, a cached value may no longer be right.
        self.state().cache.remove(&key);
        match self.mode {
            Mode::Owned => {
                self.copy_verified(service, account, value, WRITTEN)?;
                self.state().written_this_launch.insert(key.clone());
            }
            Mode::Legacy => {
                if let Ok(Some(a)) = self.store.find(service, account) {
                    if a.comment.is_some_and(|c| c.starts_with("app-owned")) {
                        return Err(
                            "this secret belongs to another build of the app; a development \
                             build can't replace it without a Keychain prompt"
                                .into(),
                        );
                    }
                }
                self.store.cli_put(service, account, value)?;
                match self.store.cli_get(service, account) {
                    Ok(Some(v)) if v == value => {}
                    Ok(_) => return Err("the value didn't read back the same".into()),
                    Err(e) => return Err(e),
                }
            }
        }
        self.remember(&key, value);
        Ok(())
    }

    /// Remove the secret: the user asked for it gone, so both kinds go (in a
    /// development build, only the legacy one: touching an app-owned item
    /// from there could prompt).
    pub fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let carry = self.carry_lock(service, account);
        let _carrying = carry.lock().unwrap_or_else(|e| e.into_inner());
        self.delete_unlocked(service, account)
    }

    fn delete_unlocked(&self, service: &str, account: &str) -> Result<(), String> {
        let lock = self.item_lock(service, account);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let key: ItemKey = (service.to_string(), account.to_string());
        self.state().cache.remove(&key);
        let mut first_err = None;
        if self.mode == Mode::Owned {
            if let Err(e) = self.store.framework_delete(&v2(service), account) {
                first_err.get_or_insert(e);
            }
        }
        if let Err(e) = self.legacy_delete(service, account) {
            first_err.get_or_insert(e);
        }
        first_err.map_or(Ok(()), Err)
    }

    /// Whether any item, of either kind, is under `service`. Attributes only:
    /// never prompts.
    fn exists(&self, service: &str, account: &str) -> Result<bool, String> {
        Ok(self.store.find(service, account)?.is_some()
            || self.store.find(&v2(service), account)?.is_some())
    }

    /// [`Vault::read`], for a secret that may still be under the app's
    /// previous name (`old_service`, the same item under the old brand
    /// prefix). See "Carrying secrets over a rename" above.
    pub fn read_carrying(&self, service: &str, account: &str, old_service: Option<&str>) -> Read {
        let Some(old) = old_service.filter(|o| *o != service) else {
            return self.read(service, account);
        };
        let carry = self.carry_lock(service, account);
        let _carrying = carry.lock().unwrap_or_else(|e| e.into_inner());
        let old_key: ItemKey = (old.to_string(), account.to_string());
        match self.read(service, account) {
            Read::Found(v) => {
                self.maybe_clean_renamed(service, account, &old_key);
                Read::Found(v)
            }
            Read::Error(e) => Read::Error(e),
            Read::NotFound => match self.read(old, account) {
                Read::Found(v) => {
                    match self.write_unlocked(service, account, &v) {
                        Ok(()) => {
                            self.state().renamed_this_launch.insert(old_key);
                            tracing::info!(
                                service,
                                "[Keychain] carried a secret over from the previous name"
                            );
                        }
                        Err(e) => {
                            tracing::warn!(service, error = %e, "[Keychain] couldn't carry a secret over from the previous name; it stays where it is");
                        }
                    }
                    Read::Found(v)
                }
                other => other,
            },
        }
    }

    /// In a launch after the one that copied a secret to its new name, and
    /// having just read the new one: the item under the previous name goes.
    fn maybe_clean_renamed(&self, service: &str, account: &str, old_key: &ItemKey) {
        {
            let mut st = self.state();
            if st.renamed_this_launch.contains(old_key)
                || !st.rename_cleanup_checked.insert(old_key.clone())
            {
                return;
            }
        }
        match self.exists(&old_key.0, account) {
            Ok(true) => {
                if let Err(e) = self.delete_unlocked(&old_key.0, account) {
                    tracing::warn!(service, error = %e, "[Keychain] couldn't remove a secret's copy under the previous name");
                }
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(service, error = %e, "[Keychain] couldn't check for a copy under the previous name");
            }
        }
    }

    /// [`Vault::delete`] of a secret and of its copy under the previous name,
    /// which would otherwise be carried back on the next read.
    pub fn delete_carrying(
        &self,
        service: &str,
        account: &str,
        old_service: Option<&str>,
    ) -> Result<(), String> {
        let carry = self.carry_lock(service, account);
        let _carrying = carry.lock().unwrap_or_else(|e| e.into_inner());
        let new = self.delete_unlocked(service, account);
        let old = match old_service.filter(|o| *o != service) {
            Some(old) => self.delete_unlocked(old, account),
            None => Ok(()),
        };
        new.and(old)
    }

    fn carry_lock(&self, service: &str, account: &str) -> Arc<Mutex<()>> {
        self.item_lock(&format!("{service}\u{0}carry"), account)
    }
}

/// The name `service` had under the app's previous brand: the same name with
/// the previous slug in front (`<slug>-account-x` → `<previous slug>-account-x`).
/// `None` without a previous name, or for a service that isn't ours.
pub fn previous_service(service: &str) -> Option<String> {
    previous_service_for(service, crate::brand::SLUG, crate::brand::previous::SLUG)
}

fn previous_service_for(service: &str, slug: &str, previous: Option<&str>) -> Option<String> {
    let previous = previous.filter(|p| !p.is_empty() && *p != slug)?;
    let rest = service.strip_prefix(slug)?.strip_prefix('-')?;
    Some(format!("{previous}-{rest}"))
}

/* ------------------------------------------------------------- process */

#[cfg(target_os = "macos")]
static VAULT: std::sync::LazyLock<Vault<macos::MacStore>> = std::sync::LazyLock::new(|| {
    let mode = if !cfg!(debug_assertions) && macos::signed_by_apple() {
        Mode::Owned
    } else {
        Mode::Legacy
    };
    tracing::info!(?mode, "[Keychain] storage mode");
    Vault::new(macos::MacStore, mode)
});

/// The live end-to-end example's stand-in: once [`use_memory_for_e2e`] is
/// called, this process keeps every item in memory and never reads or
/// writes the login Keychain. Its HOME is a scratch folder whose Keychains
/// link to the owner's (Claude Code signs in from there), so without this an
/// account, a Slack token or a secret it makes would land in the owner's.
static MEMORY: std::sync::OnceLock<Mutex<HashMap<(String, String), String>>> =
    std::sync::OnceLock::new();

/// Keep every Keychain item of this process in memory from now on, for
/// good. Only the live example calls this (`examples/agents_e2e`).
#[doc(hidden)]
pub fn use_memory_for_e2e() {
    MEMORY.get_or_init(Default::default);
}

fn memory() -> Option<std::sync::MutexGuard<'static, HashMap<(String, String), String>>> {
    MEMORY
        .get()
        .map(|m| m.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Windows Credential Manager / the Secret Service. No rename carry-over:
/// these platforms never kept a secret under a previous name.
#[cfg(any(windows, target_os = "linux"))]
static PLAIN: std::sync::LazyLock<os_store::Plain<keyring_store::OsStore>> =
    std::sync::LazyLock::new(|| {
        os_store::Plain::new(keyring_store::OsStore, keyring_store::MAX_BLOB)
    });

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn unsupported() -> String {
    "there's nowhere to keep secrets on this platform".into()
}

pub fn read(service: &str, account: &str) -> Read {
    if let Some(m) = memory() {
        return match m.get(&(service.to_string(), account.to_string())) {
            Some(v) => Read::Found(v.clone()),
            None => Read::NotFound,
        };
    }
    #[cfg(target_os = "macos")]
    {
        VAULT.read_carrying(service, account, previous_service(service).as_deref())
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        PLAIN.read(service, account)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Read::Error(unsupported())
    }
}

pub fn write(service: &str, account: &str, value: &str) -> Result<(), String> {
    if let Some(mut m) = memory() {
        m.insert(
            (service.to_string(), account.to_string()),
            value.to_string(),
        );
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        VAULT.write(service, account, value)
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        PLAIN.write(service, account, value)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = value;
        Err(unsupported())
    }
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    if let Some(mut m) = memory() {
        m.remove(&(service.to_string(), account.to_string()));
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        VAULT.delete_carrying(service, account, previous_service(service).as_deref())
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        PLAIN.delete(service, account)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Err(unsupported())
    }
}

#[cfg(target_os = "macos")]
pub fn mode() -> Mode {
    VAULT.mode()
}

#[cfg(test)]
mod tests;
