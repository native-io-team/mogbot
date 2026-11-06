//! A sign-in in a plain window: the Agents profile in an ordinary Chrome,
//! started with **no debugging switch at all**, for a site that refuses a
//! browser the app drives (Google: "This browser or app may not be
//! secure"). Nothing automates it, so the page sees what any Chrome shows.
//!
//! - The agents' Chrome is closed first (one profile, one Chrome), and kept
//!   closed while this is open ([`super::service::PLAIN_HOLD`]): every agent's
//!   browser call is refused meanwhile with a line saying why.
//! - It opens as an app window (`--app=<url>`): the page and a title bar, no
//!   address bar or tabs, so a phone driving it can't wander off to type an
//!   address.
//! - **From the phone** it is seen and driven through macOS, as Screen
//!   Sharing does (`macos`: one window's picture, input posted to it), which
//!   needs Screen Recording and Accessibility for this app. Without them the
//!   phone is told plainly that this one sign-in happens at the Mac.
//! - **At the desk** the person signs in in the window itself.
//! - When it's over the window's Chrome is asked to quit (SIGTERM, which
//!   Chrome treats as a normal quit and saves the profile), the hold is
//!   released, and the agents' Chrome, started again on the same profile,
//!   finds the new cookies.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use super::macos::{self, WindowInfo};
use super::service::{self, PLAIN_HOLD};

/// One plain Chrome on the Agents profile.
pub struct Plain {
    child: Child,
    window: Option<WindowInfo>,
    /// The last picture's size, for mapping taps.
    frame: (u32, u32),
    scratch: PathBuf,
}

/// Why the phone can't drive it.
pub const AT_THE_MAC: &str = "Google needs one sign-in at the Mac: it won't sign in to a browser the app drives, and showing a plain window on your phone needs Screen Recording and Accessibility for this app, which aren't on. Sign in at the Mac once (the card there opens the window), or turn both on in System Settings → Privacy & Security, then try again from here.";

impl Plain {
    /// Close the agents' Chrome and open the profile plainly at `url`.
    pub fn open(url: &str) -> Result<Plain, String> {
        let chrome =
            super::chrome::find_chrome().ok_or("Google Chrome isn't installed on this Mac.")?;
        let profile = service::profile_dir();
        if !super::chrome::profile_is_ours(&profile, &service::profile_root()) {
            return Err("That profile isn't the app's own.".into());
        }
        if PLAIN_HOLD.swap(true, Ordering::SeqCst) {
            return Err(super::BUSY_PLAIN.into());
        }
        service::shutdown();
        // Chrome's lock on the profile goes when it exits; wait for it so the
        // plain one doesn't hand its window to a Chrome still quitting.
        let lock = profile.join("SingletonLock");
        let end = Instant::now() + Duration::from_secs(8);
        while lock.symlink_metadata().is_ok() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut args = super::chrome::plain_args(&profile, url, true);
        // An app window: the page, no address bar.
        if let Some(last) = args.last_mut() {
            *last = format!("--app={url}");
        }
        let child = Command::new(&chrome)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                PLAIN_HOLD.store(false, Ordering::SeqCst);
                format!("Chrome didn't start: {e}")
            })?;
        let scratch = service::profile_root().join("captures");
        let _ = std::fs::create_dir_all(&scratch);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o700));
        }
        tracing::info!("[AgentBrowser] plain window for a sign-in");
        Ok(Plain {
            child,
            window: None,
            frame: (0, 0),
            scratch,
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The person quit it (⌘Q) or it crashed.
    pub fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    fn window(&mut self) -> Option<WindowInfo> {
        // Found again each time: the person may move or resize it.
        let w = macos::window_of(self.pid()).or(self.window);
        self.window = w;
        w
    }

    /// One picture of the window, for the phone.
    pub fn frame(&mut self, max_width: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let w = self
            .window()
            .ok_or("The sign-in window isn't on screen yet. Unlock your Mac if it's locked.")?;
        let (jpeg, fw, fh) = macos::capture(w.id, &self.scratch, max_width)?;
        self.frame = (fw, fh);
        Ok((jpeg, fw, fh))
    }

    pub fn tap(&mut self, x: f64, y: f64) -> Result<(), String> {
        let w = self.window().ok_or("The sign-in window isn't on screen.")?;
        let (sx, sy) = macos::frame_to_screen(&w, self.frame, x, y);
        macos::click(self.pid(), sx, sy);
        Ok(())
    }

    pub fn type_text(&mut self, text: &str) {
        macos::type_text(self.pid(), text);
    }

    pub fn key(&mut self, key: super::keys::Key) {
        macos::key(self.pid(), macos::key_code(key));
    }

    pub fn scroll(&mut self, x: f64, y: f64, dy: i32) -> Result<(), String> {
        let w = self.window().ok_or("The sign-in window isn't on screen.")?;
        let (sx, sy) = macos::frame_to_screen(&w, self.frame, x, y);
        macos::scroll(self.pid(), sx, sy, dy);
        Ok(())
    }

    /// Quit it the way a person would, then let the agents' Chrome back.
    pub fn close(self) {}

    fn quit(&mut self) {
        #[cfg(unix)]
        {
            // SAFETY: signalling the child we started.
            unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        }
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if !matches!(self.child.try_wait(), Ok(None)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.scratch);
        PLAIN_HOLD.store(false, Ordering::SeqCst);
        tracing::info!("[AgentBrowser] plain window closed");
    }
}

impl Drop for Plain {
    fn drop(&mut self) {
        self.quit();
    }
}

/// The phone may drive a plain window: both permissions are on.
pub fn phone_can_drive() -> bool {
    macos::permissions().all()
}
