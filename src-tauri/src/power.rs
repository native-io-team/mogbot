//! Low power: on battery, the app's own background polling slows down.
//!
//! The app polls a few things on a timer whatever anyone is doing: the
//! accounts' usage, free disk space, Slack, and (while the phone has the app
//! open) the projects list. None of it is urgent to the second. On battery
//! each of those waits longer ([`every`]); back on mains power they return to
//! their usual pace at the next wait.
//!
//! What this never touches: a turn in progress (its own timers, its output,
//! its approvals), routines and "When…" checks the user timed, replies
//! waiting to be posted to Slack, card expiry, and anything closing an idle
//! dev server or browser (closing those *saves* power, so they keep their
//! pace). Only the [`Poll`] kinds below are stretched.
//!
//! The power source is IOKit's (`IOPSGetProvidingPowerSourceType`), no
//! process spawned, read at most once per [`FRESH_FOR`]. Off macOS, and when
//! IOKit gives no answer, it counts as mains power: nothing changes.
//!
//! **The switch.** "Slow down on battery" (Settings → Agents → On this Mac,
//! or the Chief's `change_app_setting`) is on unless the user turned it off
//! ([`low_power_enabled`], `low_power_on_battery` in the app state). Off,
//! every poll keeps its mains pace on battery too.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A background poll that may slow down on battery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Poll {
    /// Every account's usage limits (`agents/usage_read.rs`).
    UsageRead,
    /// Free disk space (`agents/disk.rs`). Every turn still reads it fresh.
    Disk,
    /// New Slack messages to answer (`agents/slack.rs`).
    Slack,
    /// The projects list while a phone has the app open (`companion/desktop.rs`).
    PhoneProjects,
}

impl Poll {
    pub const ALL: [Poll; 4] = [
        Poll::UsageRead,
        Poll::Disk,
        Poll::Slack,
        Poll::PhoneProjects,
    ];

    /// The usual wait, on mains power.
    pub const fn on_ac(self) -> Duration {
        match self {
            Poll::UsageRead => Duration::from_secs(10 * 60),
            Poll::Disk => Duration::from_secs(2 * 60),
            Poll::Slack => Duration::from_secs(30),
            Poll::PhoneProjects => Duration::from_secs(2),
        }
    }

    /// The wait on battery.
    pub const fn on_battery(self) -> Duration {
        match self {
            Poll::UsageRead => Duration::from_secs(20 * 60),
            Poll::Disk => Duration::from_secs(5 * 60),
            Poll::Slack => Duration::from_secs(90),
            Poll::PhoneProjects => Duration::from_secs(4),
        }
    }
}

/// The policy: how long `kind` waits, given the power source.
pub const fn interval(kind: Poll, on_battery: bool) -> Duration {
    if on_battery {
        kind.on_battery()
    } else {
        kind.on_ac()
    }
}

/// How long `kind` waits now.
pub fn every(kind: Poll) -> Duration {
    interval(kind, slows_down(on_battery(), low_power_enabled()))
}

/// Whether polls stretch: on battery, with the switch on. Pure.
pub const fn slows_down(on_battery: bool, enabled: bool) -> bool {
    on_battery && enabled
}

/// The switch, cached: 0 not read yet, 1 on, 2 off.
static SWITCH: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Whether "Slow down on battery" is on (the default).
pub fn low_power_enabled() -> bool {
    use std::sync::atomic::Ordering;
    match SWITCH.load(Ordering::Relaxed) {
        1 => true,
        2 => false,
        _ => {
            let on = crate::commands::setup::read_app_state()
                .low_power_on_battery
                .unwrap_or(true);
            SWITCH.store(if on { 1 } else { 2 }, Ordering::Relaxed);
            on
        }
    }
}

/// Turn "Slow down on battery" on or off; saved, and in effect at each
/// poll's next wait.
pub fn set_low_power(on: bool) -> Result<(), crate::errors::CommandError> {
    let mut state = crate::commands::setup::read_app_state();
    state.low_power_on_battery = Some(on);
    crate::commands::setup::write_app_state(&state)?;
    SWITCH.store(if on { 1 } else { 2 }, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(on, "[Power] slow down on battery switched");
    Ok(())
}

/// How long until the next whole multiple of `period` on the wall clock.
///
/// The minute loops (routines, "When…" checks, workflows, card expiry) each
/// slept a flat 60 s from whenever they started, so the app woke four times
/// a minute at four unrelated moments. Sleeping to the minute boundary wakes
/// them together: one wake-up a minute, each loop still ticking once a minute.
pub fn until_aligned(period: Duration, now_since_epoch: Duration) -> Duration {
    let p = period.as_millis().max(1);
    let into = now_since_epoch.as_millis() % p;
    Duration::from_millis((p - into) as u64)
}

/// Sleep to the next whole multiple of `period` (see [`until_aligned`]).
pub async fn sleep_aligned(period: Duration) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    tokio::time::sleep(until_aligned(period, now)).await;
}

/// How long a reading of the power source is reused.
pub const FRESH_FOR: Duration = Duration::from_secs(30);

static LAST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

/// Whether the Mac is running on its battery now (cached for [`FRESH_FOR`]).
pub fn on_battery() -> bool {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, battery)) = *last {
        if at.elapsed() < FRESH_FOR {
            return battery;
        }
    }
    let battery = read_source() == Some(Source::Battery);
    if last.is_some_and(|(_, was)| was != battery) {
        tracing::info!(
            "[Power] {}: background polling {}",
            if battery {
                "on battery"
            } else {
                "on mains power"
            },
            if battery {
                "slows down"
            } else {
                "back to normal"
            }
        );
    }
    *last = Some((Instant::now(), battery));
    battery
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Ac,
    Battery,
    Ups,
}

/// IOKit's name for the providing source (`kIOPMACPowerKey` and friends).
pub fn source_from_name(name: &str) -> Option<Source> {
    match name {
        "AC Power" => Some(Source::Ac),
        "Battery Power" => Some(Source::Battery),
        "UPS Power" => Some(Source::Ups),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn read_source() -> Option<Source> {
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
    }

    // SAFETY: the snapshot is a +1 reference we release; the returned string
    // follows the Get rule (owned by the snapshot), so it is retained by
    // `wrap_under_get_rule` and read before the snapshot goes.
    unsafe {
        let snapshot = IOPSCopyPowerSourcesInfo();
        if snapshot.is_null() {
            return None;
        }
        let name = IOPSGetProvidingPowerSourceType(snapshot);
        let source = if name.is_null() {
            None
        } else {
            source_from_name(&CFString::wrap_under_get_rule(name).to_string())
        };
        CFRelease(snapshot);
        source
    }
}

#[cfg(not(target_os = "macos"))]
fn read_source() -> Option<Source> {
    None
}

/// Tests only: pretend the power source was just read as this.
#[cfg(test)]
pub fn set_for_tests(battery: bool) {
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), battery));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_off_keeps_the_mains_pace_on_battery() {
        assert!(slows_down(true, true));
        assert!(!slows_down(true, false));
        assert!(!slows_down(false, true));
        assert_eq!(
            interval(Poll::Slack, slows_down(true, false)),
            Poll::Slack.on_ac()
        );
    }

    #[test]
    fn on_mains_power_nothing_changes() {
        assert_eq!(interval(Poll::UsageRead, false), Duration::from_secs(600));
        assert_eq!(interval(Poll::Disk, false), Duration::from_secs(120));
        assert_eq!(interval(Poll::Slack, false), Duration::from_secs(30));
        assert_eq!(interval(Poll::PhoneProjects, false), Duration::from_secs(2));
        // The modules' own constants are these values.
        assert_eq!(crate::agents::usage_read::EVERY, Poll::UsageRead.on_ac());
        assert_eq!(crate::agents::disk::EVERY, Poll::Disk.on_ac());
    }

    #[test]
    fn on_battery_every_poll_waits_longer_within_its_bounds() {
        for kind in Poll::ALL {
            assert!(interval(kind, true) > interval(kind, false), "{kind:?}");
            // Never more than a few times slower: still a background check.
            assert!(
                interval(kind, true) <= interval(kind, false) * 3,
                "{kind:?}"
            );
        }
        let slack = interval(Poll::Slack, true);
        assert!(slack >= Duration::from_secs(60) && slack <= Duration::from_secs(120));
        let disk = interval(Poll::Disk, true);
        assert!(disk >= Duration::from_secs(120) && disk <= Duration::from_secs(5 * 60));
        assert_eq!(
            interval(Poll::UsageRead, true),
            Duration::from_secs(20 * 60)
        );
    }

    #[test]
    fn minute_loops_wake_together_on_the_boundary() {
        let m = Duration::from_secs(60);
        assert_eq!(until_aligned(m, Duration::from_millis(120_000)), m);
        assert_eq!(
            until_aligned(m, Duration::from_millis(120_001)),
            Duration::from_millis(59_999)
        );
        assert_eq!(
            until_aligned(m, Duration::from_millis(179_999)),
            Duration::from_millis(1)
        );
        // Never zero (no busy loop), never more than a period.
        for ms in [0u64, 1, 59_999, 60_000, 61_234, 3_599_999] {
            let d = until_aligned(m, Duration::from_millis(ms));
            assert!(d > Duration::ZERO && d <= m, "{ms}: {d:?}");
        }
    }

    #[test]
    fn reads_iokits_names_and_nothing_else() {
        assert_eq!(source_from_name("AC Power"), Some(Source::Ac));
        assert_eq!(source_from_name("Battery Power"), Some(Source::Battery));
        assert_eq!(source_from_name("UPS Power"), Some(Source::Ups));
        assert_eq!(source_from_name(""), None);
        assert_eq!(source_from_name("battery"), None);
    }

    #[test]
    fn every_follows_the_cached_source() {
        set_for_tests(true);
        assert_eq!(every(Poll::Slack), Poll::Slack.on_battery());
        set_for_tests(false);
        assert_eq!(every(Poll::Slack), Poll::Slack.on_ac());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_answers() {
        // A laptop says AC or Battery; a desktop AC. Never a crash.
        let s = read_source();
        assert!(s.is_none() || matches!(s, Some(Source::Ac | Source::Battery | Source::Ups)));
    }
}
