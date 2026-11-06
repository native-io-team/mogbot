//! What the plain-window sign-in needs from macOS: the two permissions
//! (Screen Recording, Accessibility), finding a process's window, a picture
//! of that one window, and input posted to it, as Screen Sharing does.
//!
//! - **Pictures**: `/usr/sbin/screencapture -l <window>`, the system's own
//!   window capture (ScreenCaptureKit underneath on macOS 14+). It captures
//!   one window, not the screen, and needs Screen Recording for this app.
//! - **Input**: CGEvents. A tap is a mouse down and up at the window's
//!   point on screen, after the window's app is brought to the front;
//!   typing is a keyboard event carrying the text (never a key code per
//!   letter, so the keyboard layout doesn't matter). Needs Accessibility.
//!   Mouse events go to the whole screen, so a tap or scroll is posted only
//!   when its point is inside the picture and, with the app in front, the
//!   window on top there is the sign-in window ([`lands_in`]).
//!
//! Nothing here is used unless both permissions are granted, and nothing is
//! kept: a capture is read and deleted at once.

use std::path::Path;

/// The permissions a plain-window sign-in from the phone needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub screen_recording: bool,
    pub accessibility: bool,
}

impl Permissions {
    pub fn all(self) -> bool {
        self.screen_recording && self.accessibility
    }
}

/// Where System Settings shows each one.
pub const SCREEN_RECORDING_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
pub const ACCESSIBILITY_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// A window on screen, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A key the phone may press, as macOS key codes.
pub fn key_code(key: super::keys::Key) -> u16 {
    use super::keys::Key;
    match key {
        Key::Enter => 36,
        Key::Tab => 48,
        Key::Backspace => 51,
        Key::Delete => 117,
        Key::Escape => 53,
        Key::Space => 49,
        Key::ArrowUp => 126,
        Key::ArrowDown => 125,
        Key::ArrowLeft => 123,
        Key::ArrowRight => 124,
        Key::PageUp => 116,
        Key::PageDown => 121,
        Key::Home => 115,
        Key::End => 119,
    }
}

/// A point in a picture of `w` (`frame` pixels wide and high) on screen.
/// Pure.
pub fn frame_to_screen(w: &WindowInfo, frame: (u32, u32), x: f64, y: f64) -> (f64, f64) {
    let fx = if frame.0 > 0 {
        w.width / frame.0 as f64
    } else {
        1.0
    };
    let fy = if frame.1 > 0 {
        w.height / frame.1 as f64
    } else {
        1.0
    };
    (w.x + x * fx, w.y + y * fy)
}

/// A point the phone gave is inside the picture it was shown (`frame`
/// pixels). Anything else is refused, never clamped onto the edge. Pure.
pub fn in_frame(frame: (u32, u32), x: f64, y: f64) -> bool {
    x.is_finite()
        && y.is_finite()
        && x >= 0.0
        && y >= 0.0
        && x < f64::from(frame.0)
        && y < f64::from(frame.1)
}

/// A point on screen inside `w`. Pure.
pub fn inside(w: &WindowInfo, x: f64, y: f64) -> bool {
    x >= w.x && y >= w.y && x < w.x + w.width && y < w.y + w.height
}

/// Who owns the window on top at a point on screen, from the windows
/// front to back (their owner's pid and bounds). Pure.
pub fn on_top_at(windows: &[(u32, WindowInfo)], x: f64, y: f64) -> Option<u32> {
    windows
        .iter()
        .find(|(_, w)| inside(w, x, y))
        .map(|(pid, _)| *pid)
}

/// Why a tap or a scroll wasn't posted: the input goes to the whole screen,
/// so only when the sign-in window is what's there.
pub const COVERED: &str = "Something on the Mac is covering the sign-in window, so the tap wasn't sent. Move it out of the way at the Mac, or sign in there.";

/// A mouse event at `(x, y)` on screen lands in `pid`'s `window`: the point
/// is in that window, and no other app's window is above it there. Pure.
pub fn lands_in(
    pid: u32,
    window: &WindowInfo,
    front_to_back: &[(u32, WindowInfo)],
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !inside(window, x, y) || on_top_at(front_to_back, x, y) != Some(pid) {
        return Err(COVERED.into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    type CGEventRef = *mut c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            kind: u32,
            at: CGPoint,
            button: u32,
        ) -> CGEventRef;
        fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> CGEventRef;
        fn CGEventKeyboardSetUnicodeString(event: CGEventRef, len: usize, text: *const u16);
        fn CGEventCreateScrollWheelEvent2(
            source: *const c_void,
            units: u32,
            count: u32,
            wheel1: i32,
            wheel2: i32,
            wheel3: i32,
        ) -> CGEventRef;
        fn CGEventPost(tap: u32, event: CGEventRef);
        fn CGEventPostToPid(pid: i32, event: CGEventRef);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP: u32 = 16;
    const HID_TAP: u32 = 0;
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const MOVED: u32 = 5;
    const PIXEL_UNITS: u32 = 0;

    pub fn permissions() -> Permissions {
        // SAFETY: plain queries with no arguments.
        unsafe {
            Permissions {
                screen_recording: CGPreflightScreenCaptureAccess(),
                accessibility: AXIsProcessTrusted(),
            }
        }
    }

    /// Ask for Screen Recording: macOS shows its own prompt once, then
    /// only System Settings can change it.
    pub fn request_screen_recording() -> bool {
        // SAFETY: as above.
        unsafe { CGRequestScreenCaptureAccess() }
    }

    fn num(d: &CFDictionary<CFString, CFType>, k: &str) -> Option<f64> {
        d.find(CFString::new(k))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_f64())
    }

    /// `pid`'s largest normal window on screen.
    pub fn window_of(pid: u32) -> Option<WindowInfo> {
        let mut best: Option<WindowInfo> = None;
        for (owner, layer, w) in on_screen() {
            if owner != pid || layer != 0 {
                continue;
            }
            if w.width * w.height > best.map(|b| b.width * b.height).unwrap_or(0.0) {
                best = Some(w);
            }
        }
        best
    }

    /// Every visible window on screen, front to back: its owner's pid, its
    /// layer and its bounds. Fully transparent ones are left out.
    fn on_screen() -> Vec<(u32, i64, WindowInfo)> {
        // SAFETY: a Copy-rule CF object, released by CFArray's drop.
        let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) };
        if raw.is_null() {
            return Vec::new();
        }
        let list: CFArray<CFDictionary<CFString, CFType>> =
            unsafe { CFArray::wrap_under_create_rule(raw) };
        let mut out = Vec::new();
        for d in list.iter() {
            let (Some(owner), Some(layer)) =
                (num(&d, "kCGWindowOwnerPID"), num(&d, "kCGWindowLayer"))
            else {
                continue;
            };
            if num(&d, "kCGWindowAlpha") == Some(0.0) {
                continue;
            }
            let Some(id) = num(&d, "kCGWindowNumber") else {
                continue;
            };
            let Some(b) = d
                .find(CFString::new("kCGWindowBounds"))
                .and_then(|v| v.downcast::<CFDictionary>())
            else {
                continue;
            };
            // SAFETY: the bounds dictionary's keys and values are CF types.
            let b: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
            let w = WindowInfo {
                id: id as u32,
                x: num(&b, "X").unwrap_or(0.0),
                y: num(&b, "Y").unwrap_or(0.0),
                width: num(&b, "Width").unwrap_or(0.0),
                height: num(&b, "Height").unwrap_or(0.0),
            };
            out.push((owner as u32, layer as i64, w));
        }
        out
    }

    /// A mouse event here goes to the whole screen: posted only when it
    /// lands in `pid`'s `window`, checked after the app came to the front.
    fn check_lands(pid: u32, window: &WindowInfo, x: f64, y: f64) -> Result<(), String> {
        let windows: Vec<(u32, WindowInfo)> =
            on_screen().into_iter().map(|(p, _, w)| (p, w)).collect();
        lands_in(pid, window, &windows, x, y)
    }

    /// A JPEG of one window, at most `max_width` wide.
    pub fn capture(window: u32, dir: &Path, max_width: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let file = dir.join(format!("w-{}.png", uuid::Uuid::new_v4().simple()));
        let mut child = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-x", "-o", "-t", "png"])
            .arg(format!("-l{window}"))
            .arg(&file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        // A capture takes a fraction of a second; one that hangs is killed.
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let ok = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s.success(),
                Ok(None) if std::time::Instant::now() < end => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        let read = std::fs::read(&file);
        let _ = std::fs::remove_file(&file);
        if !ok {
            return Err("The window couldn't be captured.".into());
        }
        let img = image::load_from_memory(&read.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let img = if img.width() > max_width {
            img.resize(max_width, u32::MAX, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let rgb = img.to_rgb8();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 60)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;
        Ok((out, rgb.width(), rgb.height()))
    }

    /// Bring `pid`'s app to the front, so a click lands in its window.
    pub fn activate(pid: u32) {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        // SAFETY: NSRunningApplication's class methods, on a pid we started.
        unsafe {
            let app: *mut AnyObject = msg_send![
                class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: pid as i32
            ];
            if !app.is_null() {
                // NSApplicationActivateIgnoringOtherApps
                let _: bool = msg_send![app, activateWithOptions: 2usize];
            }
        }
    }

    fn post(event: CGEventRef, pid: Option<u32>) {
        if event.is_null() {
            return;
        }
        // SAFETY: a CGEvent we created, released once posted.
        unsafe {
            match pid {
                Some(p) => CGEventPostToPid(p as i32, event),
                None => CGEventPost(HID_TAP, event),
            }
            CFRelease(event);
        }
    }

    pub fn click(pid: u32, window: &WindowInfo, x: f64, y: f64) -> Result<(), String> {
        activate(pid);
        std::thread::sleep(std::time::Duration::from_millis(60));
        check_lands(pid, window, x, y)?;
        let at = CGPoint { x, y };
        for kind in [MOVED, LEFT_DOWN, LEFT_UP] {
            // SAFETY: creating a mouse event with no source.
            post(
                unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, at, 0) },
                None,
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(())
    }

    pub fn type_text(pid: u32, text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        for chunk in units.chunks(16) {
            for down in [true, false] {
                // SAFETY: a keyboard event carrying the chunk.
                let e = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, down) };
                if !e.is_null() {
                    unsafe { CGEventKeyboardSetUnicodeString(e, chunk.len(), chunk.as_ptr()) };
                }
                post(e, Some(pid));
            }
        }
    }

    pub fn key(pid: u32, code: u16) {
        for down in [true, false] {
            // SAFETY: a plain key event.
            post(
                unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) },
                Some(pid),
            );
        }
    }

    pub fn scroll(pid: u32, window: &WindowInfo, x: f64, y: f64, dy: i32) -> Result<(), String> {
        activate(pid);
        std::thread::sleep(std::time::Duration::from_millis(60));
        check_lands(pid, window, x, y)?;
        let at = CGPoint { x, y };
        post(
            unsafe { CGEventCreateMouseEvent(std::ptr::null(), MOVED, at, 0) },
            None,
        );
        // SAFETY: a pixel-unit scroll event.
        post(
            unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null(), PIXEL_UNITS, 1, -dy, 0, 0) },
            None,
        );
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    pub fn permissions() -> Permissions {
        Permissions {
            screen_recording: false,
            accessibility: false,
        }
    }
    pub fn request_screen_recording() -> bool {
        false
    }
    pub fn window_of(_pid: u32) -> Option<WindowInfo> {
        None
    }
    pub fn capture(_w: u32, _d: &Path, _m: u32) -> Result<(Vec<u8>, u32, u32), String> {
        Err("Only on macOS.".into())
    }
    pub fn click(_pid: u32, _w: &WindowInfo, _x: f64, _y: f64) -> Result<(), String> {
        Err("Only on macOS.".into())
    }
    pub fn type_text(_pid: u32, _t: &str) {}
    pub fn key(_pid: u32, _c: u16) {}
    pub fn scroll(_pid: u32, _w: &WindowInfo, _x: f64, _y: f64, _dy: i32) -> Result<(), String> {
        Err("Only on macOS.".into())
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_in_the_picture_is_that_point_on_screen() {
        let w = WindowInfo {
            id: 1,
            x: 80.0,
            y: 60.0,
            width: 1100.0,
            height: 820.0,
        };
        // Captured at 2x, scaled to 550 wide: a picture half the window's points.
        assert_eq!(
            frame_to_screen(&w, (550, 410), 275.0, 205.0),
            (630.0, 470.0)
        );
        assert_eq!(frame_to_screen(&w, (550, 410), 0.0, 0.0), (80.0, 60.0));
    }

    #[test]
    fn taps_land_only_on_the_sign_in_window() {
        let ours = WindowInfo {
            id: 1,
            x: 100.0,
            y: 100.0,
            width: 800.0,
            height: 600.0,
        };
        let cover = WindowInfo {
            id: 2,
            x: 500.0,
            y: 300.0,
            width: 300.0,
            height: 200.0,
        };
        let pid = 42;
        // Another app's window above part of it, front to back.
        let windows = [(7, cover), (pid, ours)];
        assert!(lands_in(pid, &ours, &windows, 200.0, 200.0).is_ok());
        assert_eq!(
            lands_in(pid, &ours, &windows, 600.0, 400.0),
            Err(COVERED.to_string())
        );
        // Outside the window, even where nothing else is.
        assert!(lands_in(pid, &ours, &windows, 50.0, 50.0).is_err());
        assert!(lands_in(pid, &ours, &[(pid, ours)], 950.0, 200.0).is_err());
        // The window isn't on screen at all.
        assert!(lands_in(pid, &ours, &[], 200.0, 200.0).is_err());
    }

    #[test]
    fn points_off_the_picture_are_refused_not_clamped() {
        let frame = (550, 410);
        assert!(in_frame(frame, 0.0, 0.0));
        assert!(in_frame(frame, 549.0, 409.0));
        for (x, y) in [
            (-1.0, 10.0),
            (10.0, -1.0),
            (550.0, 10.0),
            (10.0, 410.0),
            (1e9, 1e9),
            (f64::NAN, 10.0),
            (f64::INFINITY, 10.0),
        ] {
            assert!(!in_frame(frame, x, y), "{x},{y}");
        }
        // No picture yet: nothing is in it.
        assert!(!in_frame((0, 0), 0.0, 0.0));
    }

    #[test]
    fn keys_have_mac_codes() {
        use super::super::keys::Key;
        assert_eq!(key_code(Key::Enter), 36);
        assert_eq!(key_code(Key::Tab), 48);
    }
}
