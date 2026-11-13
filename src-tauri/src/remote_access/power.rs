//! Keeping the Mac reachable: awake, awake with the lid shut, and back after a
//! restart — plus reading whether it is on mains power.
//!
//! Remote access is only as good as the machine being on. Everything here is
//! about the ways it stops being on, each handled at the level macOS actually
//! allows:
//!
//! - **Idle sleep** — `caffeinate -i -s -m -w <our pid>`. No privileges, and it
//!   dies with us, so a crash can never leave the Mac unable to sleep. `-s`
//!   only has effect on mains power; on battery the Mac can still sleep when
//!   the lid closes, which is why being plugged in is a checklist item.
//! - **Lid closed** — no assertion survives closing the lid on a laptop without
//!   an external display. `pmset -a disablesleep 1` does, but it needs an
//!   admin password and outlives us, so it is opt-in, read back from `pmset`
//!   rather than remembered, and offered for undo on every launch it is
//!   still set.
//! - **Off the Mac** — Windows holds the same idle-sleep assertion with
//!   `SetThreadExecutionState` on a thread of ours (released when it ends or
//!   the process does); Linux with `systemd-inhibit` when it is installed,
//!   running `tail --pid=<our pid>` so the lock dies with us. Without
//!   `systemd-inhibit` the row isn't offered ([`keep_awake_available`]).
//!   Lid-closed mode stays macOS only.
//! - **Restart** — an entry that reopens the app at login (`login_item`: a
//!   LaunchAgent, the Run key on Windows, XDG autostart on Linux). macOS still
//!   needs someone to log in after a restart when FileVault is on; nothing an
//!   app does gets around that, and the UI says so instead of implying it.

use crate::errors::CommandError;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    /// Whether this machine has a battery at all (desktops don't).
    pub has_battery: bool,
    /// Drawing from mains power. `None` when `pmset` couldn't be read.
    pub on_ac: Option<bool>,
    pub battery_percent: Option<u8>,
    pub charging: Option<bool>,
}

/// Parse `pmset -g batt`. Example output:
///
/// ```text
/// Now drawing from 'Battery Power'
///  -InternalBattery-0 (id=4653155)    87%; discharging; 6:12 remaining present: true
/// ```
pub fn parse_pmset_batt(output: &str) -> PowerStatus {
    let mut status = PowerStatus::default();
    if output.contains("'AC Power'") {
        status.on_ac = Some(true);
    } else if output.contains("'Battery Power'") {
        status.on_ac = Some(false);
    }
    if let Some(line) = output.lines().find(|l| l.contains("InternalBattery")) {
        status.has_battery = true;
        status.battery_percent = line
            .split_whitespace()
            .find_map(|w| w.strip_suffix("%;").and_then(|n| n.parse().ok()));
        // "charged" means full on AC — not draining, which is what matters.
        status.charging = if line.contains("discharging") {
            Some(false)
        } else if line.contains("charging") || line.contains("charged") {
            Some(true)
        } else {
            None
        };
    }
    status
}

/// Parse `pmset -g` for the global SleepDisabled flag. macOS only prints the
/// line while it is set, so a readable report without it means "off".
pub fn parse_sleep_disabled(output: &str) -> Option<bool> {
    let flag = output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next() == Some("SleepDisabled")).then(|| parts.next() == Some("1"))
    });
    match flag {
        Some(v) => Some(v),
        None if output.contains("System-wide power settings") => Some(false),
        None => None,
    }
}

async fn pmset(args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new("/usr/bin/pmset");
    cmd.args(args);
    let output = crate::external_command::run_with_timeout(cmd, "pmset", 5)
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// One `/sys/class/power_supply` entry: `(type, online, capacity, status)`.
pub type Supply = (String, Option<String>, Option<String>, Option<String>);

/// Read `/sys/class/power_supply` entries: each a `(type, online, capacity,
/// status)` from that supply's files. Mains (`Mains`/`USB` with `online`)
/// says whether it is plugged in; a `Battery` gives the rest.
pub fn parse_power_supplies(supplies: &[Supply]) -> PowerStatus {
    let mut status = PowerStatus::default();
    let mut mains_seen = false;
    let mut mains_online = false;
    for (kind, online, capacity, state) in supplies {
        match kind.trim() {
            "Mains" | "USB" | "USB_C" | "USB_PD" => {
                if let Some(online) = online.as_deref() {
                    mains_seen = true;
                    mains_online |= online.trim() == "1";
                }
            }
            "Battery" if !status.has_battery => {
                status.has_battery = true;
                status.battery_percent = capacity
                    .as_deref()
                    .and_then(|c| c.trim().parse::<u8>().ok())
                    .map(|p| p.min(100));
                status.charging = match state.as_deref().map(str::trim) {
                    Some("Discharging") => Some(false),
                    Some("Charging") | Some("Full") | Some("Not charging") => Some(true),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    status.on_ac = if mains_seen {
        Some(mains_online)
    } else if status.has_battery {
        // No mains supply listed: the battery's own state is the only word.
        status.charging
    } else {
        None
    };
    status
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_linux_power() -> PowerStatus {
    let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else {
        return PowerStatus::default();
    };
    let read = |dir: &std::path::Path, name: &str| std::fs::read_to_string(dir.join(name)).ok();
    let supplies: Vec<_> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let kind = read(&dir, "type")?;
            Some((
                kind,
                read(&dir, "online"),
                read(&dir, "capacity"),
                read(&dir, "status"),
            ))
        })
        .collect();
    parse_power_supplies(&supplies)
}

#[cfg(windows)]
fn read_windows_power() -> PowerStatus {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    // SAFETY: SYSTEM_POWER_STATUS is plain data the call fills in.
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
        return PowerStatus::default();
    }
    windows_power_status(s.ACLineStatus, s.BatteryFlag, s.BatteryLifePercent)
}

/// `SYSTEM_POWER_STATUS`'s fields, read: ACLineStatus 0 off / 1 on / 255
/// unknown; BatteryFlag 128 "no battery", 255 unknown, 8 charging;
/// BatteryLifePercent 0–100 or 255 unknown.
pub fn windows_power_status(ac_line: u8, battery_flag: u8, percent: u8) -> PowerStatus {
    let on_ac = match ac_line {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    let has_battery = battery_flag != 255 && battery_flag & 128 == 0;
    PowerStatus {
        has_battery,
        on_ac,
        battery_percent: (has_battery && percent <= 100).then_some(percent),
        charging: if !has_battery {
            None
        } else if battery_flag & 8 != 0 || on_ac == Some(true) {
            Some(true)
        } else if on_ac == Some(false) {
            Some(false)
        } else {
            None
        },
    }
}

pub async fn read_power() -> PowerStatus {
    #[cfg(windows)]
    return read_windows_power();
    #[cfg(all(unix, not(target_os = "macos")))]
    return tokio::task::spawn_blocking(read_linux_power)
        .await
        .unwrap_or_default();
    #[allow(unreachable_code)]
    pmset(&["-g", "batt"])
        .await
        .map(|out| parse_pmset_batt(&out))
        .unwrap_or_default()
}

/// Is lid-closed mode on right now? Read from the system every time — the
/// flag outlives this process, so remembering it would go stale.
pub async fn lid_closed_mode_active() -> Option<bool> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    pmset(&["-g"])
        .await
        .and_then(|out| parse_sleep_disabled(&out))
}

/// Turn lid-closed mode on or off. Shows the macOS admin password dialog.
pub async fn set_lid_closed_mode(enabled: bool) -> Result<(), CommandError> {
    if !cfg!(target_os = "macos") {
        return Err(CommandError::expected(
            "Keeping the computer awake with the lid closed is only available on macOS.",
        ));
    }
    let value = if enabled { "1" } else { "0" };
    let script = format!(
        "do shell script \"/usr/bin/pmset -a disablesleep {value}\" with administrator privileges"
    );
    let mut cmd = tokio::process::Command::new("/usr/bin/osascript");
    cmd.args(["-e", &script]);
    // Long timeout: a person is typing a password.
    let output = crate::external_command::run_with_timeout(cmd, "osascript pmset", 180).await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // -128 is "User canceled." — a choice, not a failure.
    if stderr.contains("-128") {
        return Err(CommandError::expected("Cancelled — nothing was changed."));
    }
    Err(CommandError::expected(format!(
        "macOS refused the change: {}",
        stderr.trim()
    )))
}

// ============================================================================
// Idle-sleep assertion
// ============================================================================

/// What holds the machine awake: `caffeinate` (macOS) or `systemd-inhibit`
/// (Linux) as a child process, or a thread of ours holding
/// `SetThreadExecutionState` (Windows).
enum Holder {
    #[cfg(unix)]
    Process(std::process::Child),
    #[cfg(windows)]
    Thread(WinHold),
}

impl Holder {
    fn alive(&mut self) -> bool {
        match self {
            #[cfg(unix)]
            Holder::Process(child) => matches!(child.try_wait(), Ok(None)),
            #[cfg(windows)]
            Holder::Thread(hold) => !hold.thread.is_finished(),
        }
    }

    fn release(self) {
        match self {
            #[cfg(unix)]
            Holder::Process(mut child) => {
                // systemd-inhibit runs `tail` in its own group: stop both.
                #[cfg(all(unix, not(target_os = "macos")))]
                // SAFETY: plain signal to the process group we created.
                unsafe {
                    libc::killpg(child.id() as libc::pid_t, libc::SIGTERM);
                }
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(windows)]
            Holder::Thread(hold) => {
                drop(hold.stop);
                let _ = hold.thread.join();
            }
        }
    }
}

#[cfg(windows)]
struct WinHold {
    /// Dropping it ends the thread, which clears its execution state.
    stop: std::sync::mpsc::Sender<()>,
    thread: std::thread::JoinHandle<()>,
}

static CAFFEINATE: LazyLock<Mutex<Option<Holder>>> = LazyLock::new(|| Mutex::new(None));

/// Whether this machine can be held awake at all: always on macOS and
/// Windows; on Linux only with `systemd-inhibit` installed.
pub fn keep_awake_available() -> bool {
    #[cfg(all(unix, not(target_os = "macos")))]
    return systemd_inhibit().is_some();
    #[allow(unreachable_code)]
    true
}

#[cfg(all(unix, not(target_os = "macos")))]
fn systemd_inhibit() -> Option<std::path::PathBuf> {
    which::which("systemd-inhibit").ok().or_else(|| {
        ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"]
            .into_iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.is_file())
    })
}

#[cfg(target_os = "macos")]
fn spawn_holder() -> Result<Holder, CommandError> {
    // -i idle sleep, -s system sleep (mains only), -m disk sleep. The display
    // is allowed to sleep: nobody is looking at it. -w ties the assertion to
    // our pid, so it is released even if we crash.
    let child = crate::utils::create_command("/usr/bin/caffeinate")
        .args(["-i", "-s", "-m", "-w", &std::process::id().to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| CommandError::from(format!("Could not start caffeinate: {e}")))?;
    Ok(Holder::Process(child))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_holder() -> Result<Holder, CommandError> {
    use std::os::unix::process::CommandExt;
    let bin = systemd_inhibit().ok_or_else(|| {
        CommandError::expected("Keeping this computer awake needs systemd-inhibit.")
    })?;
    // The lock lasts while `tail` runs, and `tail --pid` ends when we do, so
    // a crash can't leave the machine unable to sleep. The display may sleep.
    let child = std::process::Command::new(bin)
        .args([
            "--what=idle:sleep",
            &format!("--who={}", crate::brand::NAME),
            "--why=Agents and remote access are running",
            "--mode=block",
            "tail",
            &format!("--pid={}", std::process::id()),
            "-f",
            "/dev/null",
        ])
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| CommandError::from(format!("Could not start systemd-inhibit: {e}")))?;
    Ok(Holder::Process(child))
}

#[cfg(windows)]
fn spawn_holder() -> Result<Holder, CommandError> {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let (stop, stopped) = std::sync::mpsc::channel::<()>();
    let (started, result) = std::sync::mpsc::channel::<bool>();
    // The execution state belongs to the thread that set it, so one thread
    // holds it until told to stop (or the process ends). The display may
    // still sleep: no ES_DISPLAY_REQUIRED.
    let thread = std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            // SAFETY: plain Win32 call with flag constants.
            let ok = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
            let _ = started.send(ok);
            if ok {
                let _ = stopped.recv();
                // SAFETY: as above; clears what this thread set.
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            }
        })
        .map_err(|e| CommandError::from(format!("Could not start keep-awake: {e}")))?;
    if result.recv().unwrap_or(false) {
        Ok(Holder::Thread(WinHold { stop, thread }))
    } else {
        let _ = thread.join();
        Err(CommandError::from(
            "Windows refused to keep this PC awake.".to_string(),
        ))
    }
}

/// Hold the machine awake until [`stop_keep_awake`] or until this process
/// exits. Does nothing where it can't be done ([`keep_awake_available`]).
pub fn start_keep_awake() -> Result<(), CommandError> {
    if !keep_awake_available() {
        return Ok(());
    }
    let mut guard = CAFFEINATE
        .lock()
        .map_err(|e| format!("keep-awake lock poisoned: {e}"))?;
    if let Some(holder) = guard.as_mut() {
        if holder.alive() {
            return Ok(());
        }
    }
    let holder = spawn_holder()?;
    tracing::info!("[Remote] Keeping the computer awake");
    if let Some(old) = guard.replace(holder) {
        old.release();
    }
    Ok(())
}

pub fn stop_keep_awake() {
    let holder = CAFFEINATE.lock().ok().and_then(|mut g| g.take());
    if let Some(holder) = holder {
        holder.release();
        tracing::info!("[Remote] Released the keep-awake assertion");
    }
}

/// The user asked for the Mac to stay awake on its own account ("Keep this
/// Mac awake" in Agents), apart from remote access. Remote access turning off
/// must not release an assertion the user asked for separately.
static KEEP_AWAKE_ASKED: AtomicBool = AtomicBool::new(false);

/// Hold or release the assertion for the user's own preference. Releasing
/// leaves it held while remote access is on, which needs it as well.
pub fn set_keep_awake_asked(asked: bool, remote_on: bool) -> Result<(), CommandError> {
    KEEP_AWAKE_ASKED.store(asked, Ordering::SeqCst);
    if asked {
        start_keep_awake()
    } else {
        if !remote_on && !phone_holds_awake() {
            stop_keep_awake();
        }
        Ok(())
    }
}

pub fn keep_awake_asked() -> bool {
    KEEP_AWAKE_ASKED.load(Ordering::SeqCst)
}

/// A paired phone is reaching this Mac (`companion::desktop`): it holds the
/// Mac awake too, since a Mac that idles to sleep is a phone that can't reach
/// it until someone wakes it. `caffeinate -s` holds system sleep on mains only.
static PHONE_HOLDS: AtomicBool = AtomicBool::new(false);

/// Hold or release the assertion for the phone. Releasing leaves it held for
/// the user's own preference or remote access.
pub fn set_keep_awake_for_phone(holds: bool, remote_on: bool) -> Result<(), CommandError> {
    if PHONE_HOLDS.swap(holds, Ordering::SeqCst) == holds && (!holds || keep_awake_active()) {
        return Ok(());
    }
    if holds {
        start_keep_awake()
    } else {
        if !remote_on && !keep_awake_asked() {
            stop_keep_awake();
        }
        Ok(())
    }
}

pub fn phone_holds_awake() -> bool {
    PHONE_HOLDS.load(Ordering::SeqCst)
}

pub fn keep_awake_active() -> bool {
    CAFFEINATE
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().map(Holder::alive))
        .unwrap_or(false)
}

// ============================================================================
// Reopen after restart
// ============================================================================
//
// The entry itself, per OS, is `login_item`.

pub use super::login_item::{app_bundle_path, launch_agent_plist};

pub fn open_at_login_active() -> bool {
    super::login_item::active()
}

pub fn set_open_at_login(enabled: bool) -> Result<(), CommandError> {
    super::login_item::set(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_laptop_on_battery() {
        let out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 6:12 remaining present: true\n";
        assert_eq!(
            parse_pmset_batt(out),
            PowerStatus {
                has_battery: true,
                on_ac: Some(false),
                battery_percent: Some(87),
                charging: Some(false),
            }
        );
    }

    #[test]
    fn parses_a_laptop_charging() {
        let out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t42%; charging; 1:02 remaining present: true\n";
        let s = parse_pmset_batt(out);
        assert_eq!(s.on_ac, Some(true));
        assert_eq!(s.battery_percent, Some(42));
        assert_eq!(s.charging, Some(true));
    }

    #[test]
    fn full_on_ac_counts_as_not_draining() {
        let out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
        assert_eq!(parse_pmset_batt(out).charging, Some(true));
    }

    #[test]
    fn a_desktop_has_no_battery() {
        let s = parse_pmset_batt("Now drawing from 'AC Power'\n");
        assert!(!s.has_battery);
        assert_eq!(s.on_ac, Some(true));
        assert_eq!(s.battery_percent, None);
    }

    #[test]
    fn unreadable_output_claims_nothing() {
        assert_eq!(parse_pmset_batt(""), PowerStatus::default());
    }

    #[test]
    fn reads_sleep_disabled() {
        let on = "System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1\n";
        let off = "System-wide power settings:\n SleepDisabled\t\t0\n";
        assert_eq!(parse_sleep_disabled(on), Some(true));
        assert_eq!(parse_sleep_disabled(off), Some(false));
        // Real output on a Mac where it's off: the section is there, the line isn't.
        let absent = "System-wide power settings:\nCurrently in use:\n standby              1\n";
        assert_eq!(parse_sleep_disabled(absent), Some(false));
        assert_eq!(parse_sleep_disabled(""), None);
    }

    fn supply(
        kind: &str,
        online: Option<&str>,
        cap: Option<&str>,
        st: Option<&str>,
    ) -> (String, Option<String>, Option<String>, Option<String>) {
        (
            kind.into(),
            online.map(Into::into),
            cap.map(Into::into),
            st.map(Into::into),
        )
    }

    #[test]
    fn reads_a_linux_laptop() {
        let on_battery = parse_power_supplies(&[
            supply("Mains\n", Some("0\n"), None, None),
            supply("Battery\n", None, Some("64\n"), Some("Discharging\n")),
        ]);
        assert_eq!(
            on_battery,
            PowerStatus {
                has_battery: true,
                on_ac: Some(false),
                battery_percent: Some(64),
                charging: Some(false),
            }
        );
        let plugged = parse_power_supplies(&[
            supply("Battery", None, Some("100"), Some("Full")),
            supply("Mains", Some("1"), None, None),
        ]);
        assert_eq!(plugged.on_ac, Some(true));
        assert_eq!(plugged.charging, Some(true));
    }

    #[test]
    fn a_linux_desktop_claims_only_what_it_lists() {
        let desktop = parse_power_supplies(&[supply("Mains", Some("1"), None, None)]);
        assert!(!desktop.has_battery);
        assert_eq!(desktop.on_ac, Some(true));
        assert_eq!(parse_power_supplies(&[]), PowerStatus::default());
    }

    #[test]
    fn reads_windows_power_status() {
        // Laptop on battery, 55%.
        let s = windows_power_status(0, 1, 55);
        assert_eq!(
            s,
            PowerStatus {
                has_battery: true,
                on_ac: Some(false),
                battery_percent: Some(55),
                charging: Some(false),
            }
        );
        // Charging flag.
        assert_eq!(windows_power_status(1, 8, 40).charging, Some(true));
        // Desktop: "no system battery".
        let desktop = windows_power_status(1, 128, 255);
        assert!(!desktop.has_battery);
        assert_eq!(desktop.battery_percent, None);
        assert_eq!(desktop.on_ac, Some(true));
        // Unknown everything claims nothing.
        assert_eq!(windows_power_status(255, 255, 255), PowerStatus::default());
    }

    #[test]
    fn plist_escapes_the_bundle_path() {
        let plist = launch_agent_plist(std::path::Path::new("/Applications/A&B.app"));
        assert!(plist.contains("<string>/Applications/A&amp;B.app</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }
}
