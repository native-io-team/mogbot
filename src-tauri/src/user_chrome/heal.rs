//! The link's self-heal: while "Your Chrome" is on, a release build checks
//! every [`HEAL_EVERY`] that what Chrome and the host read still points at
//! this copy, and puts back what doesn't:
//!
//! - **The host manifest** names this app's binary. Another copy (a
//!   development build from before it had a link of its own) rewrote it to
//!   name itself, so Chrome started that copy's host.
//! - **The token file** holds the token this copy's link checks. A copy that
//!   wrote its own locked every new host out.
//! - **The socket** is the one this copy bound. One that was removed (or
//!   replaced) reaches nobody, or someone else: this copy binds it again,
//!   keeping the same token and every Chrome already connected.
//!
//! Each fix is logged. Debug builds never run it: they have a link of their
//! own (`auth::link_dir`) and must never take the installed app's back.

use super::{auth, install, link, Running};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How often the self-heal looks.
pub const HEAL_EVERY: Duration = Duration::from_secs(60);

/// Only release builds heal: a debug build's link is its own.
pub const HEALS: bool = !cfg!(debug_assertions);

/// What one look put back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fix {
    /// The host manifest named another binary (or was gone).
    Manifest,
    /// The token file didn't hold this copy's token.
    Token,
    /// The socket file was gone or someone else's: bound again.
    Socket,
}

/// The socket file at `path`, by device and inode; `None` when there's no
/// socket there (and on Windows, whose pipe has no file).
pub fn socket_id(path: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let m = std::fs::symlink_metadata(path).ok()?;
        m.file_type().is_socket().then(|| (m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

impl Running {
    /// The token file in `dir` holds this copy's token.
    pub fn token_ok(&self, dir: &Path) -> bool {
        auth::read_token(dir).is_ok_and(|t| t == self.token)
    }

    /// The socket file is still the one this copy bound. A pipe (Windows)
    /// can't be swapped under its owner, so it always is.
    pub fn socket_ok(&self) -> bool {
        if cfg!(unix) {
            self.socket_id.is_some() && socket_id(&self.socket) == self.socket_id
        } else {
            true
        }
    }
}

/// Put the link in `dir` back the way `running` holds it: re-bind a socket
/// that was removed or replaced (same token; connections already made keep
/// going), then write the token back if the file doesn't hold it. Must run
/// inside the async runtime. Returns what it fixed.
pub fn heal_link(
    dir: &Path,
    running: &mut Running,
    registry: Arc<link::Registry>,
) -> std::io::Result<Vec<Fix>> {
    let mut fixed = Vec::new();
    if !running.socket_ok() {
        rebind(dir, running, registry)?;
        fixed.push(Fix::Socket);
    }
    if !running.token_ok(dir) {
        auth::write_token(dir, &running.token)?;
        fixed.push(Fix::Token);
    }
    Ok(fixed)
}

/// Bind the socket again, in place of whatever is at its path now. Only the
/// accept loop is replaced: each connection runs on its own task, so a
/// Chrome already linked stays linked.
#[cfg(unix)]
fn rebind(dir: &Path, running: &mut Running, registry: Arc<link::Registry>) -> std::io::Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let path = auth::socket_path(dir);
    // Ours was removed and another took its place: this copy is the one
    // switched on, so it takes the path back. Never anything but a socket.
    if let Ok(m) = std::fs::symlink_metadata(&path) {
        if m.file_type().is_socket() {
            std::fs::remove_file(&path)?;
        }
    }
    auth::prepare_dir(dir)?;
    let (listener, socket) = link::bind(dir)?;
    running.task.abort();
    running.socket_id = socket_id(&socket);
    running.socket = socket;
    running.task = tokio::spawn(link::serve(listener, running.token.clone(), registry));
    Ok(())
}

#[cfg(not(unix))]
fn rebind(
    _dir: &Path,
    _running: &mut Running,
    _registry: Arc<link::Registry>,
) -> std::io::Result<()> {
    Ok(())
}

/// The host manifest in `user_data_dir` names `exe` (or the copy Chrome is
/// told to start); rewrite it when it doesn't. `true` when it rewrote it.
pub fn heal_manifest_at(user_data_dir: &Path, exe: &Path) -> std::io::Result<bool> {
    if install::host_state_for_app(user_data_dir, exe) == install::HostState::Current {
        return Ok(false);
    }
    install::prepare_host(user_data_dir, exe)?;
    Ok(true)
}

/// [`heal_manifest_at`] where this OS's Chrome looks, and every other
/// browser's place with it.
fn heal_manifest(exe: &Path) -> std::io::Result<bool> {
    if install::host_state_here(exe) == install::HostState::Current {
        return Ok(false);
    }
    install::prepare_host_everywhere(exe)?;
    Ok(true)
}

static WATCHING: AtomicBool = AtomicBool::new(false);

/// Start the self-heal, once, in a release build. It stops when the switch
/// goes off (and starts again with the next [`super::start`]).
pub fn watch() {
    if !HEALS || WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(HEAL_EVERY).await;
            if !super::settings::enabled() {
                break;
            }
            once().await;
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

/// One look, under the start lock so it never races a start or the retry.
async fn once() {
    let _one = super::STARTING.lock().await;
    if !super::settings::enabled() {
        return;
    }
    if let Some(exe) = install::this_exe() {
        match heal_manifest(&exe) {
            Ok(true) => tracing::warn!(
                exe = %exe.display(),
                "[UserChrome] self-heal: the host manifest didn't name this app; rewrote it"
            ),
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(error = %e, "[UserChrome] self-heal: couldn't rewrite the host manifest")
            }
        }
    }
    // Not listening is the retry's job (`super::start`), not this one's.
    let dir = auth::link_dir();
    let mut running = super::RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(r) = running.as_mut() else {
        return;
    };
    match heal_link(&dir, r, super::registry()) {
        Ok(fixed) if fixed.is_empty() => {}
        Ok(fixed) => tracing::warn!(
            ?fixed,
            socket = %r.socket.display(),
            "[UserChrome] self-heal: the link had been changed under this app; put it back"
        ),
        Err(e) => tracing::warn!(error = %e, "[UserChrome] self-heal: couldn't put the link back"),
    }
}
