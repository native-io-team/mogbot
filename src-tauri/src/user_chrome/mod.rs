//! "Your Chrome": agents use the user's own Chrome, where they're signed in,
//! through the app's own extension — on any engine and any account, Claude
//! Code and Codex alike, with no Claude in Chrome and no claude.ai account.
//!
//! ```text
//!  agent turn ──MCP──▶ agent bridge /mcp/user-chrome ──▶ tools (gate, refs)
//!                                                         │ PageCdp over the link
//!  Chrome ◀─chrome.debugger── extension ◀─native msg─▶ host ◀─unix socket─▶ link
//! ```
//!
//! - [`protocol`]: the typed, versioned messages. [`frame`]: Chrome's native
//!   messaging frames. [`auth`]: the token, the proofs, our extension ids.
//! - [`link`]: the app's socket, the handshake, one connection per Chrome
//!   profile, blocking calls. [`host`]: the native host (this app's binary,
//!   started by Chrome). [`install`]: where Chrome looks for each piece.
//! - [`tools`]: the `user_chrome` MCP server on the agent bridge, with the
//!   agents' browser's tool names and the same page logic
//!   (`agent_browser::page`). What asks is `agents::browser_gate`, the same
//!   rules as Claude in Chrome.
//! - [`settings`]: Settings → Agents → "Your Chrome", **off** by default.
//! - [`managed`]: whether Chrome's policy (this Mac's, or a work profile's)
//!   keeps the extension out, and the personal profile to use instead.
//! - Which way agents use, Your Chrome or Claude in Chrome, and why:
//!   `agents::chrome_route` (Your Chrome whenever it's connected).
//!
//! Design, threat model and what's verified: docs/design/own-browser-layer.md.

pub mod auth;
pub mod frame;
#[cfg(any(unix, windows))]
pub mod host;
/// No native host elsewhere ([`SUPPORTED`]).
#[cfg(not(any(unix, windows)))]
pub mod host {
    /// Never started by Chrome here.
    pub fn from_argv() -> Option<i32> {
        None
    }
}
pub mod install;
pub mod link;
pub mod managed;
pub mod protocol;
pub mod settings;
pub mod setup;
pub mod tools;
#[cfg(windows)]
pub mod win;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The link runs here: a Unix socket (macOS, Linux) or a named pipe
/// (Windows), and the native host Chrome starts.
pub const SUPPORTED: bool = cfg!(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "windows"
));

static REGISTRY: OnceLock<Arc<link::Registry>> = OnceLock::new();

/// Every live extension connection.
pub fn registry() -> Arc<link::Registry> {
    REGISTRY
        .get_or_init(|| {
            let r = link::Registry::new();
            r.set_hook(tools::on_event);
            r
        })
        .clone()
}

/// The listening link, while it is on.
pub struct Running {
    task: tokio::task::JoinHandle<()>,
    socket: PathBuf,
}

impl Running {
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Stop listening and close every connection.
    pub fn stop(self, registry: &link::Registry, reason: &str) {
        self.task.abort();
        registry.close_all(reason);
        // A pipe goes with its last handle; a socket's file stays behind.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Start the link in `dir` with a fresh token. Must run inside the async
/// runtime.
pub async fn start_at(dir: &Path, registry: Arc<link::Registry>) -> std::io::Result<Running> {
    #[cfg(any(unix, windows))]
    {
        let token = auth::fresh_token(dir)?;
        let (listener, socket) = link::bind(dir)?;
        let task = tokio::spawn(link::serve(listener, token, registry));
        Ok(Running { task, socket })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (dir, registry);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "the Chrome link needs a Unix socket or a named pipe",
        ))
    }
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// The link is listening.
pub fn listening() -> bool {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// Turn the link on, if the switch is: listen, and make sure Chrome can
/// find the host and the extension's files are staged. Called at launch
/// and when the switch is turned on.
pub async fn start() {
    if !settings::enabled() {
        return;
    }
    // Every start (and every switch on): the host names this binary, which
    // moves when the app does, and the staged extension is this build's.
    if let Err(e) = prepare_install() {
        tracing::warn!(error = %e, "[UserChrome] couldn't set up the host or the extension's files");
    }
    if listening() {
        return;
    }
    let outcome = start_at(&auth::link_dir(), registry()).await;
    let mut err = LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner());
    match outcome {
        Ok(r) => {
            tracing::info!(socket = %r.socket.display(), "[UserChrome] listening");
            *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
            *err = None;
        }
        Err(e) => {
            tracing::warn!(error = %e, "[UserChrome] the link didn't start");
            *err = Some(e.to_string());
        }
    }
}

/// Turn the link off (the switch off, or the app quitting).
pub fn stop(reason: &str) {
    if let Some(r) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take() {
        r.stop(&registry(), reason);
    }
    tools::forget_all();
}

/// The host manifest in the user's Chrome names this binary, and the
/// extension's files are staged (only once the user turned it on).
fn prepare_install() -> std::io::Result<()> {
    if let Some(exe) = install::this_exe() {
        // A copy of the binary when this one sits where Chrome can't start
        // it without a prompt (a development build under ~/Desktop, macOS).
        install::prepare_host_everywhere(&exe)?;
    }
    if let Some(src) = install::extension_source() {
        let dest = install::staged_extension_dir();
        // By content, not version: an extension changed without a version
        // bump still reaches the folder Chrome loads.
        if install::needs_staging(&src, &dest) {
            install::stage_extension(&src, &dest)?;
        }
    }
    Ok(())
}

/// Whether a turn of `agent` gets the user's Chrome through the extension:
/// the switch, a Chrome answering right now, the agent's own browser grant
/// and settings, and never for outside text.
pub fn for_turn(agent: &crate::agents::store::Agent, outside: bool) -> bool {
    let enabled = settings::enabled();
    let connected = enabled && connected();
    connected
        && allowed(
            enabled,
            connected,
            crate::agents::policy::effective(agent).browser,
            agent,
            outside,
        )
}

/// A Chrome is connected to the app's link right now.
pub fn connected() -> bool {
    !registry().conns().is_empty()
}

/// [`for_turn`], pure. `policy_browser`: the agent's settings let it use
/// the user's browser.
pub fn allowed(
    enabled: bool,
    connected: bool,
    policy_browser: bool,
    agent: &crate::agents::store::Agent,
    outside: bool,
) -> bool {
    enabled && connected && policy_browser && !outside && !agent.reach.browser_off
}

/* ------------------------------------------------------------- status */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    pub profile_id: String,
    pub label: String,
    pub extension_version: String,
    pub connected_at: i64,
}

/// Settings → Agents → "Your Chrome", every line read back from the Mac.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub listening: bool,
    /// Why the link isn't listening while switched on.
    pub error: Option<String>,
    /// Chrome is installed on this Mac.
    pub chrome_installed: bool,
    pub host: install::HostState,
    /// Where each step of setting it up stands, read from the Mac and from
    /// Chrome's own records (`setup`).
    pub steps: setup::Steps,
    /// The folder to choose in Chrome's "Load unpacked".
    pub extension_dir: Option<String>,
    pub extension_version: Option<String>,
    /// The Web Store listing, once there is one.
    pub web_store_url: Option<String>,
    pub extension_id: String,
    pub browsers: Vec<Browser>,
    /// A connected extension is older than the one this app ships.
    pub update_needed: bool,
    /// Chrome's policy and profiles: what keeps the extension out, and
    /// which profile is personal.
    pub management: managed::Management,
    /// The way agents reach the user's Chrome right now, and why
    /// (`agents::chrome_route::team`).
    pub route: crate::agents::chrome_route::Now,
}

pub fn status() -> Status {
    let enabled = settings::enabled();
    let staged = install::staged_extension_dir();
    let staged_ok = staged.join("manifest.json").is_file();
    let shipped = install::extension_source().and_then(|s| install::extension_version(&s));
    let browsers: Vec<Browser> = registry()
        .conns()
        .iter()
        .map(|c| Browser {
            profile_id: c.profile_id.clone(),
            label: c.profile_label.clone(),
            extension_version: c.extension_version.clone(),
            connected_at: c.connected_at_ms,
        })
        .collect();
    let update_needed = shipped
        .as_deref()
        .is_some_and(|s| browsers.iter().any(|b| older(&b.extension_version, s)));
    let udd = install::chrome_user_data_dir();
    let host = match install::this_exe() {
        Some(exe) => install::host_state_here(&exe),
        None => install::HostState::Missing,
    };
    let chrome_installed = install::chrome_installed();
    let management = managed::read();
    let extension_dir = staged_ok.then(|| staged.to_string_lossy().into_owned());
    // Each profile's Developer mode and whether the extension is in it, as
    // Chrome recorded them (`setup`), so every step ticks from a real check.
    let ids = auth::extension_ids();
    let profiles: Vec<(managed::Profile, setup::ProfileSetup)> = management
        .profiles
        .iter()
        .map(|p| {
            let s = udd
                .as_ref()
                .map(|u| setup::read(&u.join(&p.dir), &ids))
                .unwrap_or_default();
            (p.clone(), s)
        })
        .collect();
    let steps = setup::steps(
        chrome_installed,
        host == install::HostState::Current,
        extension_dir.as_deref(),
        &profiles,
        !browsers.is_empty(),
    );
    Status {
        supported: SUPPORTED,
        enabled,
        listening: listening(),
        error: LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        chrome_installed,
        host,
        steps,
        extension_dir,
        extension_version: shipped,
        web_store_url: install::web_store_url(),
        extension_id: crate::brand::chrome::WEB_STORE_ID
            .unwrap_or(auth::DEV_EXTENSION_ID)
            .to_string(),
        browsers,
        update_needed,
        management,
        route: crate::agents::chrome_route::team(),
    }
}

/// `a` is an older dotted version than `b`.
pub fn older(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a) < parse(b)
}

/// Turn the switch on or off, and the link with it.
pub async fn set_enabled(on: bool) -> Result<Status, crate::errors::CommandError> {
    settings::set_enabled(on)?;
    if on {
        start().await;
    } else {
        stop("off");
    }
    Ok(status())
}

#[cfg(all(test, unix))]
#[path = "tests.rs"]
mod tests;
