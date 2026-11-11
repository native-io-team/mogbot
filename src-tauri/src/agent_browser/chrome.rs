//! Finding the user's installed Google Chrome and the exact command line the
//! agent browser starts it with.
//!
//! The command line is the whole "don't look like a bot" story, so it is one
//! pure function ([`args`]) with a test that holds it: the real Chrome
//! binary, a profile folder of our own, a CDP pipe rather than a port, and
//! none of the switches automation frameworks add (`--enable-automation`,
//! `--headless`, `--disable-blink-features=…`, `--remote-debugging-port`).
//! See docs/design/agent-browser.md, "Not getting blocked".

use std::path::{Path, PathBuf};

/// Where Google Chrome lives on macOS, stable channel first. Chromium,
/// Chrome for Testing and Canary are deliberately not here: sign-in pages
/// treat them differently and the user doesn't keep their logins there.
#[cfg(target_os = "macos")]
const CANDIDATES: &[&str] = &["Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];

#[cfg(not(target_os = "macos"))]
const CANDIDATES: &[&str] = &[];

/// The installed Google Chrome, if there is one: `/Applications` first,
/// then `~/Applications`.
pub fn find_chrome() -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home));
    }
    roots
        .iter()
        .flat_map(|root| CANDIDATES.iter().map(move |c| root.join(c)))
        .find(|p| p.is_file())
}

/// Where the window goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Window {
    /// A normal window on screen (one-time sign-in done at the Mac).
    OnScreen { width: u32, height: u32 },
    /// A real, headed window placed far off every display, so nothing
    /// appears on the user's screen while agents work. Still a normal
    /// Chrome window as far as any page can tell. macOS keeps 40 px of a
    /// window on a display, so in practice this is a corner showing.
    OffScreen { width: u32, height: u32 },
    /// Parked in the bottom-right corner of the main display: macOS keeps
    /// its top-left corner showing, it's in the Dock, and it keeps painting
    /// (docs/design/agent-browser.md, "Hiding the window").
    Parked { width: u32, height: u32 },
}

/// Where a parked window is asked to go. macOS moves it back until a
/// corner of it is on a display; asked for this, that's the bottom right.
pub const PARK_AT: (i64, i64) = (20_000, 20_000);

/// What a launch needs.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    /// The agent browser's own profile folder. Never the user's own Chrome
    /// profile: Chrome 136+ refuses remote debugging on the default data
    /// dir anyway, and the two must stay apart (docs, "Security model").
    pub user_data_dir: PathBuf,
    pub window: Window,
    /// Mute every tab. On for the prototype; a product toggle later.
    pub mute: bool,
}

/// The switches, in order. Held by `args_are_a_normal_browser`.
pub fn args(spec: &LaunchSpec) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", spec.user_data_dir.display()),
        // CDP over fds 3 (in) and 4 (out): no TCP port any local process
        // could connect to, and it dies with the process that holds it.
        "--remote-debugging-pipe".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        // A window that is off screen or behind others still paints, so the
        // phone's live view keeps getting frames and timers keep running.
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-background-timer-throttling".to_string(),
    ];
    if spec.mute {
        a.push("--mute-audio".to_string());
    }
    let (x, y, w, h) = match spec.window {
        Window::OnScreen { width, height } => (80, 80, width, height),
        // Far beyond any display arrangement macOS allows.
        Window::OffScreen { width, height } => (-32000, -32000, width, height),
        Window::Parked { width, height } => (PARK_AT.0, PARK_AT.1, width, height),
    };
    a.push(format!("--window-position={x},{y}"));
    a.push(format!("--window-size={w},{h}"));
    a.push("about:blank".to_string());
    a
}

/// The command line for a sign-in the person does by hand, when a site
/// refuses the automated window: the same profile, **no debugging switch at
/// all** (so nothing automates it and the page sees an ordinary Chrome), on
/// screen, at `url`. Held by `plain_args_have_no_automation`.
pub fn plain_args(user_data_dir: &Path, url: &str, mute: bool) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", user_data_dir.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        // Its own window, not a tab in some other one.
        "--new-window".to_string(),
        "--window-position=80,60".to_string(),
        "--window-size=1100,820".to_string(),
    ];
    if mute {
        a.push("--mute-audio".to_string());
    }
    a.push(url.to_string());
    a
}

/// Whether a profile folder is one we may launch with remote debugging: it
/// must be ours (inside `allowed_root`), never a Chrome profile the user
/// browses with.
pub fn profile_is_ours(dir: &Path, allowed_root: &Path) -> bool {
    let user_chrome = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support/Google/Chrome"));
    let inside = dir.starts_with(allowed_root);
    let theirs = user_chrome.is_some_and(|c| dir.starts_with(&c));
    inside && !theirs && !dir.components().any(|c| c.as_os_str() == "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(window: Window) -> LaunchSpec {
        LaunchSpec {
            user_data_dir: PathBuf::from("/tmp/x/profile"),
            window,
            mute: true,
        }
    }

    #[test]
    fn args_are_a_normal_browser() {
        let a = args(&spec(Window::OffScreen {
            width: 1280,
            height: 800,
        }));
        for banned in [
            "--enable-automation",
            "--headless",
            "--remote-debugging-port",
            "--disable-blink-features",
            "--user-agent",
            "--disable-web-security",
            "--no-sandbox",
        ] {
            assert!(
                !a.iter().any(|s| s.starts_with(banned)),
                "{banned} must never be passed"
            );
        }
        assert!(a.contains(&"--remote-debugging-pipe".to_string()));
        assert_eq!(a[0], "--user-data-dir=/tmp/x/profile");
        assert!(a.contains(&"--window-position=-32000,-32000".to_string()));
    }

    #[test]
    fn plain_args_have_no_automation() {
        let a = plain_args(
            Path::new("/tmp/x/Agents"),
            "https://accounts.google.com/",
            true,
        );
        for banned in [
            "--remote-debugging",
            "--enable-automation",
            "--headless",
            "--disable-blink-features",
            "--user-agent",
            "--no-sandbox",
        ] {
            assert!(!a.iter().any(|s| s.starts_with(banned)), "{banned}");
        }
        assert_eq!(a[0], "--user-data-dir=/tmp/x/Agents");
        assert_eq!(a.last().unwrap(), "https://accounts.google.com/");
        assert!(a.contains(&"--mute-audio".to_string()));
    }

    #[test]
    fn parked_goes_to_the_corner() {
        let a = args(&spec(Window::Parked {
            width: 1200,
            height: 860,
        }));
        assert!(a.contains(&"--window-position=20000,20000".to_string()));
        assert!(a.contains(&"--mute-audio".to_string()));
    }

    #[test]
    fn on_screen_is_on_screen() {
        let a = args(&spec(Window::OnScreen {
            width: 900,
            height: 700,
        }));
        assert!(a.contains(&"--window-position=80,80".to_string()));
        assert!(a.contains(&"--window-size=900,700".to_string()));
    }

    #[test]
    fn only_our_own_profiles() {
        let root = Path::new("/data/agent-browser");
        assert!(profile_is_ours(
            Path::new("/data/agent-browser/default"),
            root
        ));
        assert!(!profile_is_ours(Path::new("/data/other"), root));
        assert!(!profile_is_ours(
            Path::new("/data/agent-browser/../x"),
            root
        ));
        if let Some(h) = std::env::var_os("HOME") {
            let theirs = PathBuf::from(h).join("Library/Application Support/Google/Chrome/Default");
            assert!(!profile_is_ours(&theirs, &theirs));
        }
    }
}
