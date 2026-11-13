//! Publishing the remote server through Tailscale Funnel.
//!
//! Funnel gives this Mac a stable public HTTPS address on the user's *own*
//! tailnet (`https://<machine>.<tailnet>.ts.net`). Traffic goes from the
//! chat service straight to Tailscale's edge and on to this machine; it never
//! passes through anything this app runs, and the address belongs to the
//! user's Tailscale account, not to us.
//!
//! The server is mounted at [`MOUNT_PATH`] rather than the root, so turning
//! remote access on or off never touches anything else the user serves.
//!
//! Everything reported here is read back from the `tailscale` CLI. A Funnel
//! is "on" only when `tailscale funnel status --json` shows our mount
//! proxying to our port with funnel allowed — never because a command we
//! ran exited zero.

use crate::errors::CommandError;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// Ours, from brand.json — Ship Studio mounts `/shipstudio` on the same
/// `tailscale serve` config, and each must leave the other's alone.
pub const MOUNT_PATH: &str = crate::brand::FUNNEL_MOUNT_PATH;

/// Where the CLI lives. The Mac App Store / standalone app ships it inside
/// the bundle; Homebrew and the open-source build put it on PATH.
fn candidate_binaries() -> Vec<std::path::PathBuf> {
    let mut out = vec![
        std::path::PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
        std::path::PathBuf::from("/opt/homebrew/bin/tailscale"),
        std::path::PathBuf::from("/usr/local/bin/tailscale"),
    ];
    if let Ok(found) = which::which("tailscale") {
        out.insert(0, found);
    }
    out
}

pub fn find_binary() -> Option<std::path::PathBuf> {
    candidate_binaries().into_iter().find(|p| p.is_file())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum TailscaleState {
    /// No CLI found anywhere we look.
    NotInstalled,
    /// Installed, but the daemon isn't running or isn't logged in.
    NeedsLogin,
    /// Logged in. `dns_name` is this machine's tailnet name; `login` the
    /// account it's signed in as (`User[Self.UserID].LoginName`), when
    /// Tailscale names a person: a tagged machine has none.
    Connected {
        dns_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        login: Option<String>,
    },
    /// The CLI answered with something we could not read.
    Unknown { detail: String },
}

/// A command for the CLI at `bin`. The standalone Tailscale.app binary is
/// both the GUI and the CLI, and decides which from the environment: from a
/// terminal it's the CLI, but spawned by a GUI app (the installed app, not
/// `tauri dev`) it tries to start a second GUI, prints "The Tailscale GUI
/// failed to start" and exits zero. `TAILSCALE_BE_CLI` forces the CLI.
fn cli_command(bin: std::path::PathBuf) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.env("TAILSCALE_BE_CLI", "1");
    cmd
}

async fn run_cli(args: &[&str], timeout_secs: u64) -> Result<std::process::Output, CommandError> {
    let bin = find_binary().ok_or_else(|| CommandError::expected("Tailscale isn't installed."))?;
    let mut cmd = cli_command(bin);
    cmd.args(args);
    crate::external_command::run_with_timeout(cmd, "tailscale", timeout_secs).await
}

/// The account this machine is signed in as, from `tailscale status --json`:
/// `User[<Self.UserID>].LoginName`. `None` for a tagged machine (owned by
/// its tags, not a person) or when the field isn't there: never guessed.
fn self_login(json: &Value) -> Option<String> {
    let tagged = json
        .pointer("/Self/Tags")
        .and_then(Value::as_array)
        .is_some_and(|t| !t.is_empty());
    if tagged {
        return None;
    }
    let key = match json.pointer("/Self/UserID")? {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let login = json
        .get("User")?
        .get(&key)?
        .get("LoginName")?
        .as_str()?
        .trim();
    (!login.is_empty() && login != "tagged-devices").then(|| login.to_string())
}

/// Read `BackendState`, `Self.DNSName` and the signed-in account out of
/// `tailscale status --json`.
pub fn parse_status(json: &Value) -> TailscaleState {
    let backend = json
        .get("BackendState")
        .and_then(Value::as_str)
        .unwrap_or("");
    if backend != "Running" {
        return TailscaleState::NeedsLogin;
    }
    match json
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|n| n.trim_end_matches('.'))
    {
        Some(name) if !name.is_empty() => TailscaleState::Connected {
            dns_name: name.to_string(),
            login: self_login(json),
        },
        _ => TailscaleState::Unknown {
            detail: "Tailscale is running but didn't report this machine's name.".to_string(),
        },
    }
}

pub async fn status() -> TailscaleState {
    status_with_backend().await.0
}

/// The app's own word for "the Tailscale app isn't running at all" (the CLI
/// couldn't reach its daemon), alongside Tailscale's `BackendState` words.
pub const BACKEND_NOT_RUNNING: &str = "NotRunning";

/// [`status`], plus Tailscale's `BackendState` when it gave one. `Stopped`
/// (switched off in the menu bar), `NeedsLogin` (signed out) and
/// [`BACKEND_NOT_RUNNING`] all read as [`TailscaleState::NeedsLogin`], but
/// each has a different fix, so the Remote access status says which.
pub async fn status_with_backend() -> (TailscaleState, Option<String>) {
    if find_binary().is_none() {
        return (TailscaleState::NotInstalled, None);
    }
    let output = match run_cli(&["status", "--json"], 8).await {
        Ok(o) => o,
        Err(e) => {
            return (
                TailscaleState::Unknown {
                    detail: e.to_string(),
                },
                None,
            )
        }
    };
    // `status` exits non-zero when logged out but still prints JSON.
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(json) => (
            parse_status(&json),
            json.get("BackendState")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        Err(_) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            if stderr.contains("failed to connect") || stderr.contains("is tailscaled running") {
                (
                    TailscaleState::NeedsLogin,
                    Some(BACKEND_NOT_RUNNING.to_string()),
                )
            } else if stderr.contains("not running") || stderr.contains("logged out") {
                (TailscaleState::NeedsLogin, None)
            } else {
                // Never an empty reason: some failures only print to stdout.
                let said = if stderr.trim().is_empty() {
                    String::from_utf8_lossy(&output.stdout).trim().to_string()
                } else {
                    stderr.trim().to_string()
                };
                (
                    TailscaleState::Unknown {
                        detail: if said.is_empty() {
                            "Tailscale gave no answer.".to_string()
                        } else {
                            said
                        },
                    },
                    None,
                )
            }
        }
    }
}

/// A phone on this Mac's tailnet, signed in as the same person: what
/// onboarding's "Get Tailscale on your phone" step waits for.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TailnetPhone {
    /// The phone's name as Tailscale shows it ("Sam’s iPhone").
    pub name: String,
    /// `ios` or `android`.
    pub os: String,
    /// Tailscale is switched on on it right now.
    pub online: bool,
}

/// The phones in `tailscale status --json`'s `Peer` map that belong to the
/// account this Mac is signed in as (`UserID` equal to `Self.UserID`). A
/// tagged Mac has no person to match, so it reports none: never guessed.
pub fn parse_phones(json: &Value) -> Vec<TailnetPhone> {
    let id = |v: Option<&Value>| match v {
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let Some(me) = id(json.pointer("/Self/UserID")) else {
        return Vec::new();
    };
    let tagged = json
        .pointer("/Self/Tags")
        .and_then(Value::as_array)
        .is_some_and(|t| !t.is_empty());
    if tagged {
        return Vec::new();
    }
    let Some(peers) = json.get("Peer").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut phones: Vec<TailnetPhone> = peers
        .values()
        .filter(|p| id(p.get("UserID")).as_deref() == Some(me.as_str()))
        .filter_map(|p| {
            let os = match p
                .get("OS")
                .and_then(Value::as_str)?
                .to_ascii_lowercase()
                .as_str()
            {
                "ios" => "ios",
                "android" => "android",
                _ => return None,
            };
            let name = p
                .get("HostName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())?;
            Some(TailnetPhone {
                name: name.to_string(),
                os: os.to_string(),
                online: p.get("Online").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    // Online first, then by name, so the line that names one is stable.
    phones.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.cmp(&b.name)));
    phones
}

/// This account's phones on the tailnet; empty when Tailscale can't say.
pub async fn phones() -> Vec<TailnetPhone> {
    if find_binary().is_none() {
        return Vec::new();
    }
    match run_cli(&["status", "--json"], 8).await {
        Ok(output) => serde_json::from_slice::<Value>(&output.stdout)
            .map(|json| parse_phones(&json))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Is our mount funnelled to `port` on `dns_name`, per `tailscale funnel
/// status --json`? The serve config shape is:
///
/// ```json
/// { "Web": { "host.ts.net:443": { "Handlers": { "/<slug>": { "Proxy": "http://127.0.0.1:4321" } } } },
///   "AllowFunnel": { "host.ts.net:443": true } }
/// ```
pub fn funnel_routes_to(config: &Value, dns_name: &str, port: u16) -> bool {
    funnel_port_of(config, dns_name, port).is_some()
}

/// The public ports Tailscale Funnel allows, in the order we try them.
pub const FUNNEL_PORTS: [u16; 3] = [443, 8443, 10000];

fn funnel_allowed(config: &Value, host_port: &str) -> bool {
    config
        .get("AllowFunnel")
        .and_then(|a| a.get(host_port))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Which public port carries our mount, funnelled, to loopback `port`.
pub fn funnel_port_of(config: &Value, dns_name: &str, port: u16) -> Option<u16> {
    FUNNEL_PORTS.into_iter().find(|p| {
        let host_port = format!("{dns_name}:{p}");
        let proxy = config
            .get("Web")
            .and_then(|w| w.get(&host_port))
            .and_then(|h| h.pointer("/Handlers"))
            .and_then(|h| h.get(MOUNT_PATH))
            .and_then(|h| h.get("Proxy"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('/');
        funnel_allowed(config, &host_port)
            && (proxy == format!("http://127.0.0.1:{port}")
                || proxy == format!("http://localhost:{port}"))
    })
}

/// The public port our mount can go on without publishing anything else.
///
/// Funnel is switched on per host *and port*, never per path: turning it on
/// for our `/<slug>` on 443 makes every other handler on 443 public too. So
/// a port where the user already serves something **tailnet only** (say
/// `tailscale serve 3000`, which lands on `/` at 443) is never used: we move
/// to the next port Funnel allows. A port that is already funnelled (Ship
/// Studio's mount, or the user's own public site) adds no exposure, and a
/// port that already carries our mount is ours. A raw TCP forward on a port
/// leaves no room for a web handler. `None`: every Funnel port is taken.
pub fn choose_funnel_port(config: &Value, dns_name: &str) -> Option<u16> {
    FUNNEL_PORTS.into_iter().find(|p| {
        let host_port = format!("{dns_name}:{p}");
        let tcp = config.get("TCP").and_then(|t| t.get(p.to_string()));
        if tcp.is_some_and(|t| t.get("TCPForward").is_some()) {
            return false;
        }
        let handlers = config
            .get("Web")
            .and_then(|w| w.get(&host_port))
            .and_then(|h| h.get("Handlers"))
            .and_then(Value::as_object);
        match handlers {
            None => true,
            Some(h) if h.is_empty() => true,
            Some(h) if h.keys().all(|k| k == MOUNT_PATH) => true,
            Some(_) => funnel_allowed(config, &host_port),
        }
    })
}

/// The public port the link is on: 443 unless [`choose_funnel_port`] had to
/// move it. Kept from the last read-back of the Funnel config.
static PUBLIC_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(443);

fn set_public_port(p: u16) {
    PUBLIC_PORT.store(p, std::sync::atomic::Ordering::Relaxed);
}

/// `machine.tailnet.ts.net`, with `:<port>` when the link isn't on 443.
pub fn public_authority(dns_name: &str) -> String {
    authority_for(
        dns_name,
        PUBLIC_PORT.load(std::sync::atomic::Ordering::Relaxed),
    )
}

pub fn authority_for(dns_name: &str, port: u16) -> String {
    if port == 443 {
        dns_name.to_string()
    } else {
        format!("{dns_name}:{port}")
    }
}

async fn funnel_config() -> Option<Value> {
    let output = run_cli(&["funnel", "status", "--json"], 8).await.ok()?;
    serde_json::from_slice::<Value>(&output.stdout).ok()
}

pub async fn funnel_active(dns_name: &str, port: u16) -> bool {
    let Some(config) = funnel_config().await else {
        return false;
    };
    match funnel_port_of(&config, dns_name, port) {
        Some(p) => {
            set_public_port(p);
            true
        }
        None => false,
    }
}

/// Every port that has our mount on it, whatever it proxies to.
fn ports_with_our_mount(config: &Value, dns_name: &str) -> Vec<u16> {
    FUNNEL_PORTS
        .into_iter()
        .filter(|p| {
            config
                .get("Web")
                .and_then(|w| w.get(format!("{dns_name}:{p}")))
                .and_then(|h| h.get("Handlers"))
                .and_then(|h| h.get(MOUNT_PATH))
                .is_some()
        })
        .collect()
}

/// What stopped the Funnel, in a shape the UI turns into one line and one
/// fix (`lib/remoteAccess.ts`, `remoteProblem`). Read from the CLI's own
/// words, which is all Tailscale gives us.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FunnelProblem {
    /// The tailnet has HTTPS certificates off (DNS page in the admin
    /// console); Funnel needs them.
    HttpsOff,
    /// The tailnet's access controls don't give this Mac the `funnel`
    /// attribute (no approval link was offered, so an admin has to add it).
    FunnelNotAllowed,
    /// The `funnel` attribute exists but doesn't allow the port.
    PortNotAllowed,
    /// Something of the user's is served tailnet-only on every Funnel port;
    /// turning ours on would make it public, so we didn't.
    PortsInUse,
    /// Tailscale didn't answer in time.
    TimedOut,
    /// Signed out, switched off, or the Tailscale app isn't running.
    NotConnected,
    /// Anything else: the CLI's words are in `funnelError`.
    Other,
}

/// What [`enable_funnel`] says when every Funnel port is in use.
pub const PORTS_IN_USE_DETAIL: &str = concat!(
    "Every port Funnel allows (443, 8443, 10000) already serves something else on this ",
    crate::computer::noun!(),
    ", privately. Turning the link on would make that public too."
);

/// Sort the CLI's failure text (or ours) into a [`FunnelProblem`]. Matches
/// the messages in Tailscale's `cmd/tailscale/cli` and `ipn` packages.
pub fn classify_funnel_failure(detail: &str) -> FunnelProblem {
    let d = detail.to_lowercase();
    if detail == PORTS_IN_USE_DETAIL {
        FunnelProblem::PortsInUse
    } else if d.contains("https must be enabled")
        || d.contains("https cert")
        || d.contains("https is not enabled")
        || d.contains("serve is not enabled")
        || d.contains("tailscale.com/s/https")
    {
        FunnelProblem::HttpsOff
    } else if d.contains("allowed ports") || d.contains("not in the node's allowed") {
        FunnelProblem::PortNotAllowed
    } else if d.contains("node attribute not set")
        || d.contains("s/no-funnel")
        || d.contains("funnel not available")
        || d.contains("funnel is not enabled")
    {
        FunnelProblem::FunnelNotAllowed
    } else if d.contains("didn't answer within") || d.contains("timed out") {
        FunnelProblem::TimedOut
    } else if d.contains("sign in to tailscale")
        || d.contains("logged out")
        || d.contains("needslogin")
        || d.contains("failed to connect to local tailscale")
        || d.contains("tailscale is stopped")
        || d.contains("isn't installed")
    {
        FunnelProblem::NotConnected
    } else {
        FunnelProblem::Other
    }
}

/// Which switch an approval link turns on: `https` (certificates, which
/// Tailscale's CLI calls "Serve") or `funnel`.
pub fn approval_kind(url: &str) -> &'static str {
    if url.contains("/f/serve") || url.contains("/f/https") {
        "https"
    } else {
        "funnel"
    }
}

/// What happened when we asked for a Funnel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum FunnelOutcome {
    On,
    /// The tailnet hasn't allowed Funnel (or HTTPS certificates) yet. The CLI
    /// prints a login.tailscale.com link where the owner switches it on.
    NeedsApproval {
        url: String,
    },
    Failed {
        detail: String,
    },
}

/// Find the first `https://login.tailscale.com/...` link in CLI output.
pub fn approval_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|w| w.starts_with("https://login.tailscale.com/"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

/// Turn the Funnel on for our mount. A link that needs approval is
/// returned with the CLI that printed it already dropped (killed); see
/// [`enable_funnel_waiting`] to keep it waiting for the approval instead.
pub async fn enable_funnel(port: u16) -> FunnelOutcome {
    enable_funnel_waiting(port).await.0
}

/// Turn the Funnel on for our mount, and when Tailscale wants an approval
/// first, hand back the CLI that is waiting for it ([`PendingApproval`]).
///
/// Not run through `run_with_timeout`: when Funnel needs approval the CLI
/// prints the approval link and then *waits* for it, so the useful output
/// arrives before the command ends — and a timeout that discards captured
/// output would throw away the one thing we need. This reads both streams as
/// they arrive and stops as soon as it sees the link, the process exits, or
/// the deadline passes.
///
/// Tailscale's `enableFeatureInteractive` (cmd/tailscale/cli) prints the
/// link, then blocks on the IPN bus until the node has the capability and
/// prints "Success." (no timeout of its own), but only when the control
/// server says it is worth waiting (`ShouldWait`); otherwise it exits. So a
/// CLI kept alive finishes the Funnel by itself the moment the user presses
/// Approve on Tailscale's page, and one that exited is simply asked again.
pub async fn enable_funnel_waiting(port: u16) -> (FunnelOutcome, Option<PendingApproval>) {
    let target = format!("http://127.0.0.1:{port}");
    let set_path = format!("--set-path={MOUNT_PATH}");
    // Which public port: never one where something private would go public
    // with us (`choose_funnel_port`). Unreadable config: 443, as before.
    let public = match (funnel_config().await, status().await) {
        (Some(config), TailscaleState::Connected { dns_name, .. }) => {
            match choose_funnel_port(&config, &dns_name) {
                Some(p) => p,
                None => {
                    return (
                        FunnelOutcome::Failed {
                            detail: PORTS_IN_USE_DETAIL.to_string(),
                        },
                        None,
                    )
                }
            }
        }
        _ => 443,
    };
    let https = format!("--https={public}");
    let (outcome, pending) =
        run_until_settled(&["funnel", "--bg", &https, &set_path, &target]).await;
    if outcome == FunnelOutcome::On {
        set_public_port(public);
    }
    (
        outcome,
        pending.map(|cli| PendingApproval {
            cli,
            public_port: public,
        }),
    )
}

/// A `tailscale funnel` that printed an approval link and may still be
/// waiting for it. Dropping it kills the CLI.
pub struct PendingApproval {
    cli: RunningCli,
    public_port: u16,
}

impl PendingApproval {
    /// The approval link it printed.
    pub fn url(&self) -> &str {
        &self.cli.url
    }

    /// The CLI already exited (Tailscale said not to wait): nothing will
    /// finish by itself, so it has to be asked again.
    pub fn exited(&self) -> bool {
        self.cli.exited
    }

    /// Wait (up to `max`) for the CLI to finish: `On` once the user
    /// approved, `NeedsApproval` with a second link (and the CLI still
    /// waiting on that one), or `Failed`.
    pub async fn wait(mut self, max: Duration) -> (FunnelOutcome, Option<PendingApproval>) {
        if self.cli.exited {
            let url = self.cli.url.clone();
            return (FunnelOutcome::NeedsApproval { url }, None);
        }
        // Only what it prints from here on: the first link is already known.
        self.cli.captured.clear();
        let deadline = tokio::time::Instant::now() + max;
        let waited = "Tailscale is still waiting for the approval.";
        match pump(&mut self.cli, deadline, waited).await {
            Pumped::Approval(url) => {
                self.cli.url = url.clone();
                self.cli.captured.clear();
                (FunnelOutcome::NeedsApproval { url }, Some(self))
            }
            // Exited zero with nothing after the link: Tailscale didn't wait
            // (`ShouldWait` false, it calls `os.Exit(0)` right after the
            // link), so nothing was approved yet. A real approval prints
            // "Success." first.
            Pumped::Settled(FunnelOutcome::On) if self.cli.captured.trim().is_empty() => {
                let url = self.cli.url.clone();
                (FunnelOutcome::NeedsApproval { url }, None)
            }
            Pumped::Settled(outcome) => {
                if outcome == FunnelOutcome::On {
                    set_public_port(self.public_port);
                }
                (outcome, None)
            }
        }
    }
}

/// A spawned CLI and what it has printed so far.
struct RunningCli {
    child: tokio::process::Child,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    captured: String,
    /// The last approval link seen (empty until one is).
    url: String,
    exited: bool,
}

enum Pumped {
    /// An approval link appeared in the output (the CLI may still be waiting).
    Approval(String),
    Settled(FunnelOutcome),
}

/// Read the CLI's output until an approval link appears, it exits, or the
/// deadline passes.
async fn pump(
    cli: &mut RunningCli,
    deadline: tokio::time::Instant,
    timeout_detail: &str,
) -> Pumped {
    let mut out_buf = [0u8; 2048];
    let mut err_buf = [0u8; 2048];
    loop {
        if let Some(url) = approval_url(&cli.captured) {
            return Pumped::Approval(url);
        }
        tokio::select! {
            n = async { match cli.stdout.as_mut() { Some(s) => s.read(&mut out_buf).await, None => std::future::pending().await } } => {
                match n { Ok(0) | Err(_) => cli.stdout = None, Ok(n) => cli.captured.push_str(&String::from_utf8_lossy(&out_buf[..n])) }
            }
            n = async { match cli.stderr.as_mut() { Some(s) => s.read(&mut err_buf).await, None => std::future::pending().await } } => {
                match n { Ok(0) | Err(_) => cli.stderr = None, Ok(n) => cli.captured.push_str(&String::from_utf8_lossy(&err_buf[..n])) }
            }
            status = cli.child.wait(), if cli.stdout.is_none() && cli.stderr.is_none() => {
                cli.exited = true;
                if let Some(url) = approval_url(&cli.captured) {
                    return Pumped::Approval(url);
                }
                return Pumped::Settled(match status {
                    Ok(s) if s.success() => FunnelOutcome::On,
                    _ => FunnelOutcome::Failed { detail: cli.captured.trim().to_string() },
                });
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Pumped::Settled(FunnelOutcome::Failed {
                    detail: if cli.captured.trim().is_empty() {
                        timeout_detail.to_string()
                    } else {
                        cli.captured.trim().to_string()
                    },
                });
            }
        }
    }
}

/// Run a `serve`/`funnel` command that may stop to print an approval link
/// and wait (see [`enable_funnel_waiting`]). On an approval link the CLI is
/// handed back still running, so the caller can keep it waiting or drop it.
async fn run_until_settled(args: &[&str]) -> (FunnelOutcome, Option<RunningCli>) {
    let Some(bin) = find_binary() else {
        return (
            FunnelOutcome::Failed {
                detail: "Tailscale isn't installed.".to_string(),
            },
            None,
        );
    };
    let mut cmd = cli_command(bin);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return (
                FunnelOutcome::Failed {
                    detail: format!("Could not run tailscale: {e}"),
                },
                None,
            )
        }
    };
    let mut cli = RunningCli {
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
        child,
        captured: String::new(),
        url: String::new(),
        exited: false,
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    match pump(
        &mut cli,
        deadline,
        "Tailscale didn't answer within 20 seconds.",
    )
    .await
    {
        Pumped::Approval(url) => {
            cli.url = url.clone();
            (FunnelOutcome::NeedsApproval { url }, Some(cli))
        }
        Pumped::Settled(outcome) => (outcome, None),
    }
}

/// The mount this app used under its previous name (`brand.json`
/// `previous.slug`), when that differs from today's.
pub fn previous_mount_path() -> Option<String> {
    crate::brand::previous::SLUG
        .map(|slug| format!("/{slug}"))
        .filter(|p| p != MOUNT_PATH && p != "/shipstudio")
}

/// Does the Funnel config have the previous name's mount at all?
pub fn has_mount(config: &Value, path: &str) -> bool {
    config
        .get("Web")
        .and_then(Value::as_object)
        .is_some_and(|hosts| {
            hosts
                .values()
                .any(|h| h.pointer("/Handlers").and_then(|hs| hs.get(path)).is_some())
        })
}

/// Remove the mount the app published under its previous name, if it is
/// still there: it is ours, and nothing answers on it any more. Anything
/// else the user serves is left alone. Best effort.
pub async fn remove_previous_mount() {
    let Some(path) = previous_mount_path() else {
        return;
    };
    let Ok(output) = run_cli(&["funnel", "status", "--json"], 8).await else {
        return;
    };
    let present = serde_json::from_slice::<Value>(&output.stdout)
        .map(|config| has_mount(&config, &path))
        .unwrap_or(false);
    if !present {
        return;
    }
    let set_path = format!("--set-path={path}");
    match run_cli(&["funnel", "--https=443", &set_path, "off"], 10).await {
        Ok(o) if o.status.success() => {
            tracing::info!(
                path,
                "[Remote] removed the Funnel mount from the app's previous name"
            );
        }
        Ok(o) => tracing::warn!(
            path,
            stderr = %String::from_utf8_lossy(&o.stderr).trim(),
            "[Remote] couldn't remove the previous name's Funnel mount"
        ),
        Err(e) => {
            tracing::warn!(path, error = %e, "[Remote] couldn't remove the previous name's Funnel mount")
        }
    }
}

/// Remove our mount from the Funnel. Leaves anything else the user serves.
pub async fn disable_funnel() -> Result<(), CommandError> {
    // Wherever our mount is (443, or the port `choose_funnel_port` moved it
    // to); 443 when the config can't be read, as before.
    let ports = match (funnel_config().await, status().await) {
        (Some(config), TailscaleState::Connected { dns_name, .. }) => {
            ports_with_our_mount(&config, &dns_name)
        }
        _ => vec![443],
    };
    let mut result = Ok(());
    for p in ports {
        if let Err(e) = disable_funnel_on(p).await {
            result = Err(e);
        }
    }
    set_public_port(443);
    result
}

async fn disable_funnel_on(public: u16) -> Result<(), CommandError> {
    let set_path = format!("--set-path={MOUNT_PATH}");
    let https = format!("--https={public}");
    let output = run_cli(&["funnel", &https, &set_path, "off"], 10).await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Already off is the outcome we wanted.
    if stderr.contains("not found") || stderr.contains("does not exist") {
        return Ok(());
    }
    Err(CommandError::expected(format!(
        "Tailscale couldn't turn the link off: {}",
        stderr.trim()
    )))
}

// ============================================================================
// Serve on the tailnet only (the mobile companion)
// ============================================================================
//
// The companion is published with `tailscale serve` on its own HTTPS port,
// tailnet only. It never touches the Funnel's port or mount, and only ever
// edits its own port's handler.

/// Is `https_port` on `dns_name` served to our loopback `port`, and *not*
/// funnelled? The serve config shape is:
///
/// ```json
/// { "TCP": { "47443": { "HTTPS": true } },
///   "Web": { "host.ts.net:47443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4321" } } } } }
/// ```
pub fn serve_routes_to(config: &Value, dns_name: &str, https_port: u16, port: u16) -> bool {
    let host_port = format!("{dns_name}:{https_port}");
    let funnelled = config
        .get("AllowFunnel")
        .and_then(|a| a.get(&host_port))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let proxy = config
        .get("Web")
        .and_then(|w| w.get(&host_port))
        .and_then(|h| h.get("Handlers"))
        .and_then(|h| h.get("/"))
        .and_then(|h| h.get("Proxy"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/');
    !funnelled
        && (proxy == format!("http://127.0.0.1:{port}")
            || proxy == format!("http://localhost:{port}"))
}

/// Read back whether our serve handler is in place.
pub async fn serve_active(dns_name: &str, https_port: u16, port: u16) -> bool {
    let Ok(output) = run_cli(&["serve", "status", "--json"], 8).await else {
        return false;
    };
    serde_json::from_slice::<Value>(&output.stdout)
        .map(|config| serve_routes_to(&config, dns_name, https_port, port))
        .unwrap_or(false)
}

/// Serve loopback `port` on the tailnet at `https://<machine>.ts.net:<https_port>`.
/// Verified by reading the config back, never by the exit code alone.
pub async fn enable_serve(https_port: u16, port: u16, dns_name: &str) -> FunnelOutcome {
    let https = format!("--https={https_port}");
    let target = format!("http://127.0.0.1:{port}");
    // Phone access asks again from its own Check again; the CLI isn't kept.
    let (outcome, _) = run_until_settled(&["serve", "--bg", &https, &target]).await;
    if outcome == FunnelOutcome::On && !serve_active(dns_name, https_port, port).await {
        return FunnelOutcome::Failed {
            detail: "Tailscale accepted the command but isn't serving the port.".to_string(),
        };
    }
    outcome
}

/// Remove our port's handler. Anything else served is left alone.
pub async fn disable_serve(https_port: u16) -> Result<(), CommandError> {
    let https = format!("--https={https_port}");
    let output = run_cli(&["serve", &https, "off"], 10).await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("not found")
        || stderr.contains("does not exist")
        || stderr.contains("not serving")
    {
        return Ok(());
    }
    Err(CommandError::expected(format!(
        "Tailscale couldn't stop serving the phone port: {}",
        stderr.trim()
    )))
}

// ============================================================================
// Is it reachable from the internet?
// ============================================================================
//
// "Funnel on" in the serve config is not the same as "reachable". The first
// time Funnel is enabled, Tailscale still has to publish the machine's name in
// public DNS, and until it does the link resolves nowhere outside the tailnet
// — while on this Mac MagicDNS resolves it fine, so a local request proves
// nothing. A user who pasted the link into Grok Bot during that window got
// "this address is only reachable inside your tailnet" while we said "Live".
//
// So: look the name up the way the internet does (DNS-over-HTTPS to a public
// resolver), then send one authenticated ping to that public address. Only an
// answer from our own server counts. The probe carries a per-run header so it
// is never mistaken for an assistant connecting.

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum Reachability {
    /// A request through the public internet reached this server.
    Reachable,
    /// Public DNS doesn't know the name yet — normal for a few minutes after
    /// Funnel is first turned on.
    NoPublicDns,
    /// The name resolves but the request didn't get through.
    Unreachable { detail: String },
}

const DOH_URL: &str = "https://cloudflare-dns.com/dns-query";

/// Pull the A records out of a DNS-over-HTTPS JSON answer.
pub fn parse_doh_answer(json: &Value) -> Vec<std::net::Ipv4Addr> {
    json.get("Answer")
        .and_then(Value::as_array)
        .map(|answers| {
            answers
                .iter()
                .filter(|a| a.get("type").and_then(Value::as_u64) == Some(1))
                .filter_map(|a| a.get("data").and_then(Value::as_str)?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

async fn public_ipv4(dns_name: &str) -> Result<Vec<std::net::Ipv4Addr>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let json: Value = client
        .get(DOH_URL)
        .query(&[("name", dns_name), ("type", "A")])
        .header("accept", "application/dns-json")
        .send()
        .await
        .map_err(|e| format!("public DNS lookup failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("public DNS lookup failed: {e}"))?;
    Ok(parse_doh_answer(&json))
}

static REACHABILITY_CACHE: std::sync::LazyLock<
    std::sync::Mutex<Option<(String, std::time::Instant, Reachability)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Probe the public path, at most every 30 s once reachable (10 s while not),
/// since the modal polls every 5 s.
pub async fn public_reachability(dns_name: &str, token: &str) -> Reachability {
    if let Ok(cache) = REACHABILITY_CACHE.lock() {
        if let Some((name, at, result)) = cache.as_ref() {
            let ttl = if *result == Reachability::Reachable {
                30
            } else {
                10
            };
            if name == dns_name && at.elapsed() < Duration::from_secs(ttl) {
                return result.clone();
            }
        }
    }
    let result = probe(dns_name, token).await;
    if let Ok(mut cache) = REACHABILITY_CACHE.lock() {
        *cache = Some((
            dns_name.to_string(),
            std::time::Instant::now(),
            result.clone(),
        ));
    }
    result
}

/// Forget the last probe — after the link is replaced or Funnel re-enabled.
pub fn forget_reachability() {
    if let Ok(mut cache) = REACHABILITY_CACHE.lock() {
        *cache = None;
    }
}

async fn probe(dns_name: &str, token: &str) -> Reachability {
    let ips = match public_ipv4(dns_name).await {
        Ok(ips) if ips.is_empty() => return Reachability::NoPublicDns,
        Ok(ips) => ips,
        Err(detail) => return Reachability::Unreachable { detail },
    };
    let public = PUBLIC_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let addr = std::net::SocketAddr::from((ips[0], public));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .resolve(dns_name, addr)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Reachability::Unreachable {
                detail: e.to_string(),
            }
        }
    };
    let url = format!(
        "https://{}{MOUNT_PATH}/mcp/{token}",
        authority_for(dns_name, public)
    );
    let response = client
        .post(url)
        .header(
            super::server::PROBE_HEADER,
            super::server::PROBE_ID.as_str(),
        )
        .json(&serde_json::json!({ "jsonrpc": "2.0", "id": 0, "method": "ping" }))
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) if v.get("result").is_some() => Reachability::Reachable,
            _ => Reachability::Unreachable {
                detail: "Something answered at this address, but not this app.".into(),
            },
        },
        Ok(r) => Reachability::Unreachable {
            detail: format!("The public address answered {}.", r.status()),
        },
        // `without_url`: reqwest's message otherwise includes the URL, which
        // contains the connector token — and this text is shown in the UI.
        Err(e) => Reachability::Unreachable {
            detail: format!("Couldn't reach the public address: {}", e.without_url()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_records_from_a_doh_answer() {
        let answer = json!({
            "Status": 0,
            "Answer": [
                { "name": "m.t.ts.net", "type": 5, "data": "alias.example." },
                { "name": "m.t.ts.net", "type": 1, "data": "203.0.113.7" }
            ]
        });
        assert_eq!(
            parse_doh_answer(&answer),
            vec!["203.0.113.7".parse::<std::net::Ipv4Addr>().unwrap()]
        );
        // NXDOMAIN: no Answer at all — the state a fresh Funnel is in.
        assert!(parse_doh_answer(&json!({ "Status": 3 })).is_empty());
    }
    use serde_json::json;

    #[test]
    fn phones_are_this_accounts_ios_and_android_peers() {
        let status = json!({
            "Self": { "UserID": 7, "DNSName": "mac.t.ts.net." },
            "Peer": {
                "a": { "HostName": "Sam’s iPhone", "OS": "iOS", "Online": false, "UserID": 7 },
                "b": { "HostName": "pixel", "OS": "android", "Online": true, "UserID": 7 },
                "c": { "HostName": "work-laptop", "OS": "macOS", "Online": true, "UserID": 7 },
                "d": { "HostName": "someone-elses", "OS": "iOS", "Online": true, "UserID": 9 },
                "e": { "HostName": "", "OS": "iOS", "Online": true, "UserID": 7 }
            }
        });
        assert_eq!(
            parse_phones(&status),
            vec![
                TailnetPhone {
                    name: "pixel".into(),
                    os: "android".into(),
                    online: true
                },
                TailnetPhone {
                    name: "Sam’s iPhone".into(),
                    os: "ios".into(),
                    online: false
                },
            ]
        );
        // No peers, no person (a tagged Mac), or no Self: nothing, never a guess.
        assert!(parse_phones(&json!({ "Self": { "UserID": 7 } })).is_empty());
        let mut tagged = status.clone();
        tagged["Self"]["Tags"] = json!(["tag:server"]);
        assert!(parse_phones(&tagged).is_empty());
        assert!(parse_phones(&json!({ "Peer": status["Peer"] })).is_empty());
    }

    #[test]
    fn running_with_a_name_is_connected() {
        let s = parse_status(&json!({
            "BackendState": "Running",
            "Self": { "DNSName": "studio-mac.tail1234.ts.net." }
        }));
        assert_eq!(
            s,
            TailscaleState::Connected {
                dns_name: "studio-mac.tail1234.ts.net".to_string(),
                login: None,
            }
        );
    }

    /// Against this Mac's real Tailscale, with PATH cut down to what a GUI
    /// launch gets (no `/usr/local/bin`, no Homebrew): the app bundle's CLI
    /// must still be found, and a signed-in Mac must name its account.
    #[tokio::test]
    #[ignore = "reads this Mac's real Tailscale (read-only `status --json`)"]
    async fn reads_this_macs_account_without_tailscale_on_path() {
        std::env::set_var("PATH", "/usr/bin:/bin");
        let s = status().await;
        println!("{s:?}");
        assert!(
            matches!(s, TailscaleState::Connected { login: Some(ref l), .. } if l.contains('@')),
            "{s:?}"
        );
    }

    #[test]
    fn names_the_account_only_when_tailscale_does() {
        let s = parse_status(&json!({
            "BackendState": "Running",
            "Self": { "DNSName": "studio-mac.tail1234.ts.net.", "UserID": 1234 },
            "User": { "1234": { "LoginName": "julian@example.com" } }
        }));
        assert!(matches!(
            s,
            TailscaleState::Connected { login: Some(ref l), .. } if l == "julian@example.com"
        ));
        // A tagged machine belongs to its tags: no person to sign in as.
        let tagged = parse_status(&json!({
            "BackendState": "Running",
            "Self": { "DNSName": "m.t.ts.net.", "UserID": 9, "Tags": ["tag:server"] },
            "User": { "9": { "LoginName": "tagged-devices" } }
        }));
        assert!(matches!(
            tagged,
            TailscaleState::Connected { login: None, .. }
        ));
        // An id with no user entry: unknown, not guessed.
        let missing = parse_status(&json!({
            "BackendState": "Running",
            "Self": { "DNSName": "m.t.ts.net.", "UserID": 1 },
            "User": {}
        }));
        assert!(matches!(
            missing,
            TailscaleState::Connected { login: None, .. }
        ));
    }

    #[test]
    fn anything_but_running_needs_login() {
        for state in ["NeedsLogin", "Stopped", "Starting", "NoState"] {
            assert_eq!(
                parse_status(&json!({ "BackendState": state })),
                TailscaleState::NeedsLogin
            );
        }
    }

    #[test]
    fn running_without_a_name_is_not_claimed_as_connected() {
        assert!(matches!(
            parse_status(&json!({ "BackendState": "Running", "Self": {} })),
            TailscaleState::Unknown { .. }
        ));
    }

    #[test]
    fn the_previous_names_mount_is_found_and_is_never_ours_or_ship_studios() {
        let config = serde_json::json!({
            "Web": { "m.t.ts.net:443": { "Handlers": {
                "/oldbot": { "Proxy": "http://127.0.0.1:4321" },
                "/shipstudio": { "Proxy": "http://127.0.0.1:9" }
            } } }
        });
        assert!(has_mount(&config, "/oldbot"));
        assert!(!has_mount(&config, "/elsewhere"));
        assert!(!has_mount(&serde_json::json!({}), "/oldbot"));
        if let Some(prev) = previous_mount_path() {
            assert_ne!(prev, MOUNT_PATH);
            assert_ne!(prev, "/shipstudio");
        }
    }

    #[test]
    fn funnel_is_on_only_when_our_mount_routes_to_our_port() {
        let host = "m.t.ts.net";
        let config = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { MOUNT_PATH: { "Proxy": "http://127.0.0.1:4321" } } } },
            "AllowFunnel": { "m.t.ts.net:443": true }
        });
        assert!(funnel_routes_to(&config, host, 4321));
        assert!(!funnel_routes_to(&config, host, 9999), "wrong port");

        let served_not_funnelled = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { MOUNT_PATH: { "Proxy": "http://127.0.0.1:4321" } } } }
        });
        assert!(!funnel_routes_to(&served_not_funnelled, host, 4321));

        let someone_elses_root = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4321" } } } },
            "AllowFunnel": { "m.t.ts.net:443": true }
        });
        assert!(!funnel_routes_to(&someone_elses_root, host, 4321));
        assert!(!funnel_routes_to(&json!({}), host, 4321));

        // Ship Studio's own mount on the same Funnel isn't ours: with only it,
        // ours is off (so setup turns ours on); with both, ours is on.
        if MOUNT_PATH != "/shipstudio" {
            let only_theirs = json!({
                "Web": { "m.t.ts.net:443": { "Handlers": { "/shipstudio": { "Proxy": "http://127.0.0.1:4321" } } } },
                "AllowFunnel": { "m.t.ts.net:443": true }
            });
            assert!(!funnel_routes_to(&only_theirs, host, 4321));
            let both = json!({
                "Web": { "m.t.ts.net:443": { "Handlers": {
                    "/shipstudio": { "Proxy": "http://127.0.0.1:5555" },
                    MOUNT_PATH: { "Proxy": "http://127.0.0.1:4321" }
                } } },
                "AllowFunnel": { "m.t.ts.net:443": true }
            });
            assert!(funnel_routes_to(&both, host, 4321));
        }
    }

    #[test]
    fn serve_is_on_only_for_our_port_and_never_funnelled() {
        let dns = "mac.tail1.ts.net";
        let config = json!({
            "TCP": { "47443": { "HTTPS": true }, "443": { "HTTPS": true } },
            "Web": {
                "mac.tail1.ts.net:47443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:5000" } } },
                "mac.tail1.ts.net:443": { "Handlers": { MOUNT_PATH: { "Proxy": "http://127.0.0.1:6000" } } }
            },
            "AllowFunnel": { "mac.tail1.ts.net:443": true }
        });
        assert!(serve_routes_to(&config, dns, 47443, 5000));
        assert!(!serve_routes_to(&config, dns, 47443, 5001), "another port");
        assert!(
            !serve_routes_to(&config, dns, 443, 6000),
            "the Funnel's mount isn't ours"
        );
        let mut funnelled = config.clone();
        funnelled["AllowFunnel"]["mac.tail1.ts.net:47443"] = json!(true);
        assert!(
            !serve_routes_to(&funnelled, dns, 47443, 5000),
            "a funnelled port is never reported as the tailnet-only route"
        );
        assert!(!serve_routes_to(&json!({}), dns, 47443, 5000));
    }

    #[test]
    fn serializes_the_shape_the_frontend_reads() {
        let s = TailscaleState::Connected {
            dns_name: "m.t.ts.net".into(),
            login: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({ "state": "connected", "dnsName": "m.t.ts.net" })
        );
        assert_eq!(
            serde_json::to_value(TailscaleState::NotInstalled).unwrap(),
            json!({ "state": "notInstalled" })
        );
    }

    /// The CLI's own words (cmd/tailscale/cli and ipn), each to one cause.
    #[test]
    fn funnel_failures_sort_into_one_cause_each() {
        use FunnelProblem as P;
        for (said, cause) in [
            (
                "Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https.",
                P::HttpsOff,
            ),
            (
                "error: HTTPS cert support is not enabled/configured for your tailnet.",
                P::HttpsOff,
            ),
            ("Serve is not enabled on your tailnet.", P::HttpsOff),
            (
                "Funnel not available; \"funnel\" node attribute not set. See https://tailscale.com/s/no-funnel.",
                P::FunnelNotAllowed,
            ),
            (
                "Funnel not available; \"443\" is not in the node's allowed ports.",
                P::PortNotAllowed,
            ),
            ("Tailscale didn't answer within 20 seconds.", P::TimedOut),
            ("Sign in to Tailscale first.", P::NotConnected),
            (
                "failed to connect to local Tailscale daemon for /localapi/v0/status",
                P::NotConnected,
            ),
            (PORTS_IN_USE_DETAIL, P::PortsInUse),
            ("something nobody has seen", P::Other),
        ] {
            assert_eq!(classify_funnel_failure(said), cause, "{said}");
        }
        assert_eq!(
            approval_kind("https://login.tailscale.com/f/serve?node=abc"),
            "https"
        );
        assert_eq!(
            approval_kind("https://login.tailscale.com/f/funnel?node=abc"),
            "funnel"
        );
        assert_eq!(
            serde_json::to_value(P::HttpsOff).unwrap(),
            json!({ "kind": "httpsOff" })
        );
    }

    /// Funnel is per host and port, never per path: our mount on a port
    /// where something is served tailnet-only would publish that too.
    #[test]
    fn never_publishes_what_the_user_serves_privately() {
        let dns = "m.t.ts.net";
        // Nothing served: 443.
        assert_eq!(choose_funnel_port(&json!({}), dns), Some(443));
        // `tailscale serve 3000` (tailnet only, `/` on 443): move to 8443.
        let private_root = json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": { "m.t.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } }
        });
        assert_eq!(choose_funnel_port(&private_root, dns), Some(8443));
        // Already public there (Ship Studio's mount, the user's own site):
        // adding ours exposes nothing new.
        let mut public_root = private_root.clone();
        public_root["AllowFunnel"] = json!({ "m.t.ts.net:443": true });
        assert_eq!(choose_funnel_port(&public_root, dns), Some(443));
        // Ours already there: same port.
        let ours = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { MOUNT_PATH: { "Proxy": "http://127.0.0.1:9" } } } }
        });
        assert_eq!(choose_funnel_port(&ours, dns), Some(443));
        // A raw TCP forward on 443 and private sites on the other two: none.
        let full = json!({
            "TCP": { "443": { "TCPForward": "127.0.0.1:22" } },
            "Web": {
                "m.t.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:1" } } },
                "m.t.ts.net:10000": { "Handlers": { "/x": { "Proxy": "http://127.0.0.1:2" } } }
            }
        });
        assert_eq!(choose_funnel_port(&full, dns), None);
        assert_eq!(
            classify_funnel_failure(PORTS_IN_USE_DETAIL),
            FunnelProblem::PortsInUse
        );

        // Read back on whichever port it landed.
        let on_8443 = json!({
            "Web": { "m.t.ts.net:8443": { "Handlers": { MOUNT_PATH: { "Proxy": "http://127.0.0.1:4321" } } } },
            "AllowFunnel": { "m.t.ts.net:8443": true }
        });
        assert_eq!(funnel_port_of(&on_8443, dns, 4321), Some(8443));
        assert!(funnel_routes_to(&on_8443, dns, 4321));
        assert_eq!(ports_with_our_mount(&on_8443, dns), vec![8443]);
        assert_eq!(authority_for(dns, 8443), "m.t.ts.net:8443");
        assert_eq!(authority_for(dns, 443), "m.t.ts.net");
    }

    #[test]
    fn finds_the_approval_link() {
        let out = "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc123\n\n";
        assert_eq!(
            approval_url(out).as_deref(),
            Some("https://login.tailscale.com/f/funnel?node=abc123")
        );
        assert_eq!(
            approval_url(&format!(
                "Available on the internet: https://m.t.ts.net{MOUNT_PATH}"
            )),
            None
        );
    }

    /// A stand-in for `tailscale funnel` that prints its approval link, then
    /// whatever `then` prints, as the real CLI does while it waits.
    fn fake_cli(then: &str) -> RunningCli {
        let script = format!(
            "echo 'Funnel is not enabled on your tailnet.'; echo 'To enable, visit:'; \
             echo '   https://login.tailscale.com/f/funnel?node=n1'; {then}"
        );
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        RunningCli {
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            child,
            captured: String::new(),
            url: String::new(),
            exited: false,
        }
    }

    async fn first_link(cli: &mut RunningCli) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        match pump(cli, deadline, "timed out").await {
            Pumped::Approval(url) => url,
            Pumped::Settled(o) => panic!("expected an approval link, got {o:?}"),
        }
    }

    /// The CLI kept waiting finishes the Funnel by itself once approved: the
    /// user never comes back to press anything.
    // Unix only: the stand-in tailscale CLI is run with /bin/sh.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_kept_cli_finishes_by_itself_once_approved() {
        let mut cli = fake_cli("sleep 0.3; echo 'Success.'");
        let url = first_link(&mut cli).await;
        assert_eq!(url, "https://login.tailscale.com/f/funnel?node=n1");
        cli.url = url;
        let pending = PendingApproval {
            cli,
            public_port: 443,
        };
        assert!(!pending.exited());
        let (outcome, next) = pending.wait(Duration::from_secs(5)).await;
        assert_eq!(outcome, FunnelOutcome::On);
        assert!(next.is_none());
    }

    /// A second approval (HTTPS, then Funnel) comes back as its own link,
    /// with the CLI still waiting on it; a refusal is a failure, not a wait.
    // Unix only: the stand-in tailscale CLI is run with /bin/sh.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_link_or_a_refusal_is_reported() {
        let mut cli = fake_cli(
            "sleep 0.2; echo '   https://login.tailscale.com/f/serve?node=n1'; sleep 0.2; echo 'Success.'",
        );
        cli.url = first_link(&mut cli).await;
        let (outcome, next) = PendingApproval {
            cli,
            public_port: 443,
        }
        .wait(Duration::from_secs(5))
        .await;
        assert_eq!(
            outcome,
            FunnelOutcome::NeedsApproval {
                url: "https://login.tailscale.com/f/serve?node=n1".into()
            }
        );
        let (outcome, _) = next.unwrap().wait(Duration::from_secs(5)).await;
        assert_eq!(outcome, FunnelOutcome::On);

        let mut cli = fake_cli("echo 'access denied' >&2; exit 1");
        cli.url = first_link(&mut cli).await;
        let (outcome, _) = PendingApproval {
            cli,
            public_port: 443,
        }
        .wait(Duration::from_secs(5))
        .await;
        assert!(
            matches!(outcome, FunnelOutcome::Failed { .. }),
            "{outcome:?}"
        );
    }

    /// Tailscale's CLI exits instead of waiting when the server says not to
    /// (exit 0 right after the link): nothing was approved, so it is asked
    /// again rather than taken for a yes.
    // Unix only: the stand-in tailscale CLI is run with /bin/sh.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cli_that_did_not_wait_is_not_a_yes() {
        let mut cli = fake_cli("exit 0");
        cli.url = first_link(&mut cli).await;
        let (outcome, next) = PendingApproval {
            cli,
            public_port: 443,
        }
        .wait(Duration::from_secs(5))
        .await;
        assert_eq!(
            outcome,
            FunnelOutcome::NeedsApproval {
                url: "https://login.tailscale.com/f/funnel?node=n1".into()
            }
        );
        assert!(next.is_none(), "nothing left to wait on: ask again");
    }
}
