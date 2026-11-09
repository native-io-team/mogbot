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
    interval(kind, on_battery())
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
