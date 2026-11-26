//! Who may be on the link, and how each side proves it.
//!
//! - **Chrome** starts the native host only for an extension id named in the
//!   host's manifest (`allowed_origins`), and passes that origin as the
//!   host's first argument. The host checks it again ([`extension_allowed`]).
//! - **The app and the host** each prove they hold the link's token without
//!   sending it: HMAC-SHA256 over both sides' fresh nonces, with a label per
//!   direction so one side's proof can't be replayed as the other's. The app
//!   proves itself first, so a process squatting on the socket learns
//!   nothing and gets no relay.
//! - **The token** is 32 random bytes in a 0600 file inside a 0700 folder of
//!   the app's own, rewritten each time the link starts. The extension never
//!   holds it. Other processes running as the same user could read it;
//!   that is the same boundary the rest of the app keeps (its Keychain items,
//!   its agent bridge token), and is said so in the design doc. On Windows
//!   the folder is in the user's own `%LOCALAPPDATA%`, whose inherited ACL
//!   admits only that user, SYSTEM and Administrators (no mode bits to set).

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::path::{Path, PathBuf};

type HmacSha256 = Hmac<Sha256>;

/// The extension's id while it is loaded unpacked (dev, and before the Web
/// Store listing exists): fixed by the public key in its manifest (`key`).
/// `install_tests.rs` derives it from the manifest, so they can't drift.
pub const DEV_EXTENSION_ID: &str = "acpipahophpoekcmokoejnkooedofagk";

/// The ids Chrome may start the host for: the dev id, and the Web Store
/// listing's once `brand.json` names one.
pub fn extension_ids() -> Vec<String> {
    let mut ids = vec![DEV_EXTENSION_ID.to_string()];
    if let Some(store) = crate::brand::chrome::WEB_STORE_ID {
        if store != DEV_EXTENSION_ID {
            ids.push(store.to_string());
        }
    }
    ids
}

/// `chrome-extension://<id>/` for each id.
pub fn origins() -> Vec<String> {
    extension_ids()
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect()
}

/// The origin Chrome passed is one of ours.
pub fn extension_allowed(origin: &str) -> bool {
    origins().iter().any(|o| o == origin.trim())
}

/// The folder the link lives in: the socket and the token.
///
/// A debug build (`pnpm tauri dev`) shares the installed app's data folder,
/// so it gets a link of its own, `chrome-link-dev`: one that held the
/// installed app's socket left the agents without the user's Chrome.
pub fn link_dir() -> PathBuf {
    link_dir_for(
        std::env::var_os(DIR_ENV),
        &crate::brand::app_support_dir(),
        cfg!(debug_assertions),
    )
}

/// [`link_dir`], pure. `env`: [`DIR_ENV`]'s value, honoured only when
/// `debug`.
pub fn link_dir_for(env: Option<std::ffi::OsString>, app_support: &Path, debug: bool) -> PathBuf {
    if !debug {
        return app_support.join(LINK_DIR_NAME);
    }
    match env.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => app_support.join(DEV_LINK_DIR_NAME),
    }
}

/// The installed app's link folder, in its data folder.
pub const LINK_DIR_NAME: &str = "chrome-link";
/// A debug build's, beside it: never the installed app's.
pub const DEV_LINK_DIR_NAME: &str = "chrome-link-dev";

/// Debug builds only: run the link somewhere else (the end-to-end check runs
/// it in a scratch folder, never the app's own). Release builds ignore it,
/// so nothing in Chrome's environment can point a real host elsewhere.
pub const DIR_ENV: &str = "MOGBOT_CHROME_LINK_DIR";

pub fn socket_path(dir: &Path) -> PathBuf {
    dir.join("link.sock")
}

/// Windows: the link's named pipe for `dir`. Pipe names are one namespace
/// for the whole PC, so the name carries a hash of the link's folder (which
/// is under this user's profile, and is what the debug-only [`DIR_ENV`]
/// moves): one name per user and folder, the same for the app and the host,
/// with nothing personal in it. The pipe's DACL and the token are what keep
/// it the user's; the name only keeps users apart. Pure.
pub fn pipe_name(dir: &Path) -> String {
    use sha2::Digest as _;
    let key = dir.to_string_lossy().to_lowercase();
    let h = hex::encode(Sha256::digest(key.as_bytes()));
    format!(r"\\.\pipe\{}-chrome-link-{}", crate::brand::SLUG, &h[..16])
}

pub fn token_path(dir: &Path) -> PathBuf {
    dir.join("token")
}

/// A Unix socket's path must fit `sockaddr_un` (104 bytes on macOS, with
/// its terminator).
pub const MAX_SOCKET_PATH: usize = 103;

/// Make the link's folder (0700). Writes nothing in it.
pub fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Make the folder (0700) and a fresh token (0600). Returns the token.
/// Only once this copy of the app holds the link (`start_at`): the token
/// is the one the socket's owner checks, and rewriting it under another
/// copy's live socket locks every host out of that copy.
pub fn fresh_token(dir: &Path) -> std::io::Result<String> {
    let token = random_hex(32);
    write_token(dir, &token)?;
    Ok(token)
}

/// Write `token` as the link's token (0600, atomically), in a 0700 folder.
/// The self-heal (`heal`) puts the token this copy proves with back when
/// something else rewrote the file.
pub fn write_token(dir: &Path, token: &str) -> std::io::Result<()> {
    prepare_dir(dir)?;
    let path = token_path(dir);
    let tmp = dir.join(".token.tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        let mut f = opts.open(&tmp)?;
        f.write_all(token.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// The token, as the host reads it. Refuses a token file anyone else could
/// read or write: then it isn't the app's.
pub fn read_token(dir: &Path) -> std::io::Result<String> {
    let path = token_path(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(&path)?;
        if m.mode() & 0o077 != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the link's token can be read by others",
            ));
        }
        // SAFETY: getuid has no preconditions.
        let me = unsafe { libc::getuid() };
        if m.uid() != me {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the link's token isn't this user's",
            ));
        }
    }
    let t = std::fs::read_to_string(path)?;
    let t = t.trim().to_string();
    if t.len() < 32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the link's token is malformed",
        ));
    }
    Ok(t)
}

/// `n` random bytes, as hex.
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    // No randomness means no secret worth having: stop rather than make a
    // guessable token or nonce.
    if getrandom::getrandom(&mut b).is_err() {
        std::process::abort();
    }
    hex::encode(b)
}

/// A fresh nonce for one handshake.
pub fn nonce() -> String {
    random_hex(16)
}

const APP_LABEL: &[u8] = b"mogbot-chrome-link/app/v1";
const HOST_LABEL: &[u8] = b"mogbot-chrome-link/host/v1";

fn mac(token: &str, label: &[u8], first: &str, second: &str) -> HmacSha256 {
    // HMAC takes a key of any length; `new_from_slice` can't fail for it.
    let Ok(mut m) = HmacSha256::new_from_slice(token.as_bytes()) else {
        std::process::abort();
    };
    m.update(label);
    m.update(&[0]);
    m.update(first.as_bytes());
    m.update(&[0]);
    m.update(second.as_bytes());
    m
}

/// The app's proof: over the host's nonce, then its own.
pub fn app_proof(token: &str, host_nonce: &str, app_nonce: &str) -> String {
    hex::encode(
        mac(token, APP_LABEL, host_nonce, app_nonce)
            .finalize()
            .into_bytes(),
    )
}

/// The host's proof: over the app's nonce, then its own.
pub fn host_proof(token: &str, app_nonce: &str, host_nonce: &str) -> String {
    hex::encode(
        mac(token, HOST_LABEL, app_nonce, host_nonce)
            .finalize()
            .into_bytes(),
    )
}

fn verify(m: HmacSha256, proof: &str) -> bool {
    match hex::decode(proof.trim()) {
        Ok(bytes) => m.verify_slice(&bytes).is_ok(),
        Err(_) => false,
    }
}

/// Check the app's proof, in constant time.
pub fn check_app(token: &str, host_nonce: &str, app_nonce: &str, proof: &str) -> bool {
    verify(mac(token, APP_LABEL, host_nonce, app_nonce), proof)
}

/// Check the host's proof, in constant time.
pub fn check_host(token: &str, app_nonce: &str, host_nonce: &str, proof: &str) -> bool {
    verify(mac(token, HOST_LABEL, app_nonce, host_nonce), proof)
}

/// A nonce is 16-64 hex characters: anything else is refused before use.
pub fn nonce_ok(n: &str) -> bool {
    (32..=128).contains(&n.len()) && n.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_side_checks_the_others_proof() {
        let t = random_hex(32);
        let (h, a) = (nonce(), nonce());
        assert!(check_app(&t, &h, &a, &app_proof(&t, &h, &a)));
        assert!(check_host(&t, &a, &h, &host_proof(&t, &a, &h)));
    }

    #[test]
    fn proofs_dont_carry_over() {
        let t = random_hex(32);
        let (h, a) = (nonce(), nonce());
        // The app's proof replayed as the host's (same nonces) fails.
        assert!(!check_host(&t, &a, &h, &app_proof(&t, &h, &a)));
        assert!(!check_host(&t, &h, &a, &app_proof(&t, &h, &a)));
        // Another token, or other nonces, fail.
        assert!(!check_app(&random_hex(32), &h, &a, &app_proof(&t, &h, &a)));
        assert!(!check_app(&t, &nonce(), &a, &app_proof(&t, &h, &a)));
        assert!(!check_app(&t, &h, &a, "not hex"));
        assert!(!check_app(&t, &h, &a, ""));
    }

    #[test]
    fn nonces_are_checked_for_shape() {
        assert!(nonce_ok(&nonce()));
        assert!(!nonce_ok("abc"));
        assert!(!nonce_ok(&"z".repeat(32)));
        assert!(!nonce_ok(&"a".repeat(200)));
    }

    #[test]
    fn only_our_extension() {
        assert!(extension_allowed(&format!(
            "chrome-extension://{DEV_EXTENSION_ID}/"
        )));
        assert!(!extension_allowed(
            "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"
        ));
        assert!(!extension_allowed(&format!(
            "chrome-extension://{DEV_EXTENSION_ID}"
        )));
        assert!(!extension_allowed(""));
    }

    #[test]
    fn the_pipe_name_is_per_folder_and_names_no_one() {
        let a = pipe_name(Path::new(r"C:\Users\ann\AppData\Local\App\chrome-link"));
        let b = pipe_name(Path::new(r"C:\Users\bob\AppData\Local\App\chrome-link"));
        assert!(a.starts_with(r"\\.\pipe\"));
        assert_ne!(a, b);
        assert!(!a.contains("ann"));
        // Windows paths aren't case-sensitive: the same folder, the same pipe.
        assert_eq!(
            a,
            pipe_name(Path::new(r"c:\users\ANN\appdata\local\app\chrome-link"))
        );
    }

    #[test]
    fn a_debug_build_never_runs_the_installed_apps_link() {
        let support = Path::new("/Users/ann/Library/Application Support/App");
        // The installed app (release): its own folder, whatever the environment says.
        assert_eq!(
            link_dir_for(Some("/tmp/elsewhere".into()), support, false),
            support.join("chrome-link")
        );
        assert_eq!(
            link_dir_for(None, support, false),
            support.join("chrome-link")
        );
        // A debug build beside it: a folder of its own by default…
        let dev = link_dir_for(None, support, true);
        assert_eq!(dev, support.join("chrome-link-dev"));
        assert_ne!(dev, link_dir_for(None, support, false));
        assert_eq!(link_dir_for(Some("".into()), support, true), dev);
        // …or the one the environment names.
        assert_eq!(
            link_dir_for(Some("/tmp/scratch-link".into()), support, true),
            PathBuf::from("/tmp/scratch-link")
        );
        // The running test binary is a debug build: never the installed folder.
        assert_ne!(
            link_dir(),
            crate::brand::app_support_dir().join(LINK_DIR_NAME)
        );
    }

    #[test]
    fn token_file_is_private_and_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("link");
        let a = fresh_token(&d).unwrap();
        assert_eq!(read_token(&d).unwrap(), a);
        let b = fresh_token(&d).unwrap();
        assert_ne!(a, b);
        assert_eq!(read_token(&d).unwrap(), b);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(token_path(&d))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            let mode = std::fs::metadata(&d).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
            std::fs::set_permissions(token_path(&d), std::fs::Permissions::from_mode(0o644))
                .unwrap();
            assert!(read_token(&d).is_err());
        }
    }
}
