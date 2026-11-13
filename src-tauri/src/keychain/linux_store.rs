//! Which store a Linux build keeps secrets in: the Secret Service (GNOME
//! Keyring, KWallet) where there is one, else the encrypted file
//! ([`super::file_store`]) on a box with none (headless, a container).
//!
//! The choice is made once and written down (`secret-store` in the app's
//! folder), so secrets never end up split across two stores: a desktop whose
//! keyring was slow to start one morning must not start a second, empty
//! store and show every login as gone. So the file is chosen by itself only
//! where no Secret Service can be: no session bus at all (or, in a headless
//! build, a Secret Service that doesn't answer; [`HEADLESS`]). A desktop
//! whose Secret Service doesn't answer gets the error, as before ("errors
//! are not absence"). `<SLUG>_SECRET_STORE=file` or `=secret-service`
//! chooses outright.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use super::file_store::FileStore;
use super::keyring_store::OsStore;
use super::os_store::Blobs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Whether this is a window-less build, which never has a desktop keyring
/// to wait for. This build always has a desk: the file is chosen by itself
/// only with no session bus at all. [`choose`] keeps the rule for both.
const HEADLESS: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    SecretService,
    File,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::SecretService => "secret-service",
            Kind::File => "file",
        }
    }
    fn parse(s: &str) -> Option<Kind> {
        match s.trim() {
            "secret-service" => Some(Kind::SecretService),
            "file" => Some(Kind::File),
            _ => None,
        }
    }
}

/// What asking the Secret Service once said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Answers,
    Unavailable(String),
}

/// The rule, pure: an explicit choice, else the one written down, else the
/// Secret Service when it answers, else the file only where no Secret
/// Service can be. `Ok((kind, record))`: record it when `record`.
pub fn choose(
    explicit: Option<&str>,
    written: Option<&str>,
    headless: bool,
    has_session_bus: bool,
    probe: impl FnOnce() -> Probe,
) -> Result<(Kind, bool), String> {
    if let Some(e) = explicit.filter(|e| !e.trim().is_empty()) {
        return Kind::parse(e)
            .map(|k| (k, true))
            .ok_or_else(|| format!("unknown secret store {e:?} (file or secret-service)"));
    }
    if let Some(k) = written.and_then(Kind::parse) {
        return Ok((k, false));
    }
    if !headless && !has_session_bus {
        return Ok((Kind::File, true));
    }
    match probe() {
        Probe::Answers => Ok((Kind::SecretService, true)),
        Probe::Unavailable(_) if headless => Ok((Kind::File, true)),
        Probe::Unavailable(why) => Err(why),
    }
}

pub enum Chosen {
    SecretService(OsStore),
    File(FileStore),
}

/// The Linux [`Blobs`]: the chosen store, chosen on first use.
pub struct LinuxStore {
    dir: PathBuf,
    // Only a choice is kept: a Secret Service that didn't answer is asked
    // again next time, rather than failing every read until a restart.
    chosen: OnceLock<Chosen>,
}

impl LinuxStore {
    pub fn new(dir: PathBuf) -> Self {
        LinuxStore {
            dir,
            chosen: OnceLock::new(),
        }
    }

    fn chosen(&self) -> Result<&Chosen, String> {
        if let Some(c) = self.chosen.get() {
            return Ok(c);
        }
        let picked = pick(&self.dir)?;
        Ok(self.chosen.get_or_init(|| picked))
    }
}

fn marker(dir: &Path) -> PathBuf {
    dir.join("secret-store")
}

fn has_session_bus() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|v| !v.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR")
            .map(|d| PathBuf::from(d).join("bus"))
            .is_some_and(|p| p.exists())
}

fn probe_secret_service() -> Probe {
    let service = format!("{}-store-probe", crate::brand::SLUG);
    match OsStore.get(&service, "probe") {
        Ok(_) => Probe::Answers,
        Err(e) => Probe::Unavailable(e),
    }
}

fn pick(dir: &Path) -> Result<Chosen, String> {
    let env = format!(
        "{}_SECRET_STORE",
        crate::brand::SLUG.to_ascii_uppercase().replace('-', "_")
    );
    let explicit = std::env::var(&env).ok();
    let written = std::fs::read_to_string(marker(dir)).ok();
    let (kind, record) = choose(
        explicit.as_deref(),
        written.as_deref(),
        HEADLESS,
        has_session_bus(),
        probe_secret_service,
    )?;
    if record && written.as_deref().and_then(Kind::parse) != Some(kind) {
        let _ = std::fs::create_dir_all(dir);
        if let Err(e) = std::fs::write(marker(dir), kind.word()) {
            tracing::warn!("[Keychain] couldn't note the secret store: {e}");
        }
    }
    tracing::info!(store = kind.word(), "[Keychain] secret store");
    Ok(match kind {
        Kind::SecretService => Chosen::SecretService(OsStore),
        Kind::File => Chosen::File(FileStore::in_dir(dir)),
    })
}

impl Blobs for LinuxStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        match self.chosen()? {
            Chosen::SecretService(s) => s.get(service, account),
            Chosen::File(f) => f.get(service, account),
        }
    }
    fn put(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
        match self.chosen()? {
            Chosen::SecretService(s) => s.put(service, account, value),
            Chosen::File(f) => f.put(service, account, value),
        }
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match self.chosen()? {
            Chosen::SecretService(s) => s.delete(service, account),
            Chosen::File(f) => f.delete(service, account),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never() -> Probe {
        panic!("the Secret Service mustn't be asked")
    }

    #[test]
    fn an_explicit_choice_wins_and_is_recorded() {
        assert_eq!(
            choose(Some("file"), Some("secret-service"), false, true, never),
            Ok((Kind::File, true))
        );
        assert_eq!(
            choose(Some("secret-service"), None, true, false, never),
            Ok((Kind::SecretService, true))
        );
        assert!(choose(Some("plaintext"), None, true, true, never).is_err());
    }

    #[test]
    fn the_written_choice_sticks_whatever_answers_now() {
        // Written down as the Secret Service: a keyring that's down today is
        // an error later, never a quiet switch to an empty file.
        assert_eq!(
            choose(None, Some("secret-service\n"), true, false, never),
            Ok((Kind::SecretService, false))
        );
        assert_eq!(
            choose(None, Some("file"), false, true, never),
            Ok((Kind::File, false))
        );
    }

    #[test]
    fn a_desktop_with_a_keyring_uses_it() {
        assert_eq!(
            choose(None, None, false, true, || Probe::Answers),
            Ok((Kind::SecretService, true))
        );
        assert_eq!(
            choose(None, None, true, true, || Probe::Answers),
            Ok((Kind::SecretService, true))
        );
    }

    #[test]
    fn a_desktop_whose_keyring_is_down_gets_the_error_not_a_new_store() {
        assert_eq!(
            choose(None, None, false, true, || Probe::Unavailable(
                "locked".into()
            )),
            Err("locked".into())
        );
    }

    #[test]
    fn a_box_with_no_secret_service_uses_the_file() {
        // The headless build: whatever the bus says.
        assert_eq!(
            choose(None, None, true, true, || Probe::Unavailable("no".into())),
            Ok((Kind::File, true))
        );
        assert_eq!(
            choose(None, None, true, false, || Probe::Unavailable("no".into())),
            Ok((Kind::File, true))
        );
        // No session bus at all: nothing to ask.
        assert_eq!(
            choose(None, None, false, false, never),
            Ok((Kind::File, true))
        );
    }

    #[test]
    fn the_file_store_is_used_end_to_end_when_written_down() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(marker(dir.path()), "file").unwrap();
        let s = LinuxStore::new(dir.path().to_path_buf());
        // The env var could override; the test process doesn't set it.
        s.put("svc", "a", b"v").unwrap();
        assert_eq!(s.get("svc", "a"), Ok(Some(b"v".to_vec())));
        assert!(dir.path().join("secrets.enc").exists());
    }
}
