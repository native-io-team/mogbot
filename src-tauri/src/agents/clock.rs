//! Clock times as the user reads them: "9:00 AM" or "09:00", whichever this
//! Mac is set to (System Settings → General → Date & Time → 24-hour time, or
//! the region's default). Every time of day the app writes for a person goes
//! through here, so a routine's "every weekday at …", the brief and a usage
//! line never disagree with each other or with the desk.
//!
//! The schedule grammar reads both ("9am", "9:00 AM", "09:00"), so text
//! written here also round-trips when an agent quotes it back.

#[cfg(not(test))]
use std::sync::Mutex;
#[cfg(not(test))]
use std::time::{Duration, Instant};

/// How long a reading of the preference is trusted. Flipping the switch in
/// System Settings shows within a minute, without a call per line.
#[cfg(not(test))]
const FRESH_FOR: Duration = Duration::from_secs(60);

#[cfg(not(test))]
static CACHED: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

#[cfg(test)]
thread_local! {
    static TEST_HOUR24: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Tests read 12-hour unless they say otherwise, whatever the machine is set
/// to; `test_hour24(true)` switches this thread.
#[cfg(test)]
pub fn test_hour24(on: bool) {
    TEST_HOUR24.with(|c| c.set(on));
}

/// True when this Mac shows a 24-hour clock.
pub fn hour24() -> bool {
    #[cfg(test)]
    {
        TEST_HOUR24.with(|c| c.get())
    }
    #[cfg(not(test))]
    {
        let mut slot = CACHED.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, v)) = *slot {
            if at.elapsed() < FRESH_FOR {
                return v;
            }
        }
        let v = system_hour24().unwrap_or(false);
        *slot = Some((Instant::now(), v));
        v
    }
}

/// "9:00 AM" / "09:00".
pub fn hm(hour: u32, minute: u32) -> String {
    hm_as(hour24(), hour, minute)
}

/// `hm` with the preference given.
pub fn hm_as(hour24: bool, hour: u32, minute: u32) -> String {
    let (hour, minute) = (hour % 24, minute % 60);
    if hour24 {
        return format!("{hour:02}:{minute:02}");
    }
    let (h, half) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{h}:{minute:02} {half}")
}

/// `hm` for a chrono time.
pub fn of<T: chrono::Timelike>(t: &T) -> String {
    hm(t.hour(), t.minute())
}

/// Whether a date-format pattern uses a 24-hour field (`H`, `k`) outside
/// quoted literals.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pattern_is_24(pattern: &str) -> bool {
    let mut quoted = false;
    for c in pattern.chars() {
        match c {
            '\'' => quoted = !quoted,
            'H' | 'k' if !quoted => return true,
            'h' | 'K' if !quoted => return false,
            _ => {}
        }
    }
    false
}

#[cfg_attr(test, allow(dead_code))]
/// The short time format of the current locale, with the user's override
/// (CFDateFormatter applies `AppleICUForce24HourTime` / `…12HourTime`).
#[cfg(target_os = "macos")]
fn system_hour24() -> Option<bool> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFLocaleCopyCurrent() -> *const c_void;
        fn CFDateFormatterCreate(
            alloc: *const c_void,
            locale: *const c_void,
            date_style: isize,
            time_style: isize,
        ) -> *const c_void;
        fn CFDateFormatterGetFormat(formatter: *const c_void) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }
    const NO_STYLE: isize = 0;
    const SHORT_STYLE: isize = 1;

    // SAFETY: Create/Copy results are released once here; the format string
    // follows the get rule and is retained by `wrap_under_get_rule` before
    // the formatter that owns it is released.
    unsafe {
        let locale = CFLocaleCopyCurrent();
        if locale.is_null() {
            return None;
        }
        let formatter = CFDateFormatterCreate(std::ptr::null(), locale, NO_STYLE, SHORT_STYLE);
        CFRelease(locale);
        if formatter.is_null() {
            return None;
        }
        let raw = CFDateFormatterGetFormat(formatter);
        let pattern = (!raw.is_null()).then(|| CFString::wrap_under_get_rule(raw).to_string());
        CFRelease(formatter);
        pattern.map(|p| pattern_is_24(&p))
    }
}

#[cfg(not(target_os = "macos"))]
fn system_hour24() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twelve_hour_reads_like_the_desk() {
        assert_eq!(hm_as(false, 9, 0), "9:00 AM");
        assert_eq!(hm_as(false, 0, 5), "12:05 AM");
        assert_eq!(hm_as(false, 12, 0), "12:00 PM");
        assert_eq!(hm_as(false, 17, 30), "5:30 PM");
        assert_eq!(hm_as(false, 23, 59), "11:59 PM");
    }

    #[test]
    fn twenty_four_hour_pads() {
        assert_eq!(hm_as(true, 9, 0), "09:00");
        assert_eq!(hm_as(true, 0, 5), "00:05");
        assert_eq!(hm_as(true, 17, 30), "17:30");
    }

    #[test]
    fn the_preference_follows_the_switch() {
        test_hour24(true);
        assert_eq!(hm(7, 30), "07:30");
        test_hour24(false);
        assert_eq!(hm(7, 30), "7:30 AM");
    }

    #[test]
    fn reads_the_locale_pattern() {
        assert!(!pattern_is_24("h:mm a"));
        assert!(pattern_is_24("HH:mm"));
        assert!(pattern_is_24("H.mm"));
        assert!(!pattern_is_24("a h:mm"));
        assert!(!pattern_is_24("'Hour' h:mm a"));
        assert!(pattern_is_24("k:mm"));
    }
}
