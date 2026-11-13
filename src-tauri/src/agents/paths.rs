//! Paths as the approval classifier reads them (`autoallow`, `go_hard`,
//! `links`), the same on macOS, Windows and Linux.
//!
//! - **Case.** APFS and NTFS ignore case by default: `~/.SSH/authorized_keys`
//!   is `~/.ssh/authorized_keys`, and `~/Library/launchagents` is where
//!   launchd looks. Every rule that compares a path to a folder goes through
//!   [`under`] / [`same`] / [`name_is`], which fold case there. Found in
//!   review (2026-11-12): at "Bold", `echo k >> ~/.SSH/authorized_keys` and a
//!   plist written to `~/Library/launchagents` ran without a card on a Mac.
//! - **Windows paths.** `C:\…` and `C:/…`; Git Bash's `/c/…` (and
//!   `/cygdrive/c/…`) for the same drive; its `/tmp` for the user's temp
//!   folder; `~\…` for the home. A drive-relative `C:x`, a rooted `\x` with no
//!   drive and a network share (`\\server\share`) can't be placed, so they are
//!   [`Anchor::Unknown`] and the call asks. `canonicalize`'s `\\?\` prefix is
//!   taken off ([`plain`]) so a resolved path still compares with the home.
//!
//! When a path can't be placed, the caller asks.

use std::path::{Path, PathBuf};

/// Whether this system's usual file system ignores case (macOS, Windows).
pub const CASE_INSENSITIVE: bool = cfg!(any(target_os = "macos", windows));

/// Where a path as written starts from.
#[derive(Debug, Clone, PartialEq)]
pub enum Anchor {
    /// An absolute path (Git Bash's forms turned into the drive's).
    Absolute(PathBuf),
    /// Relative to the working folder.
    Relative,
    /// Somewhere that can't be known from here: always a card.
    Unknown,
}

/// How `raw` is anchored on this system. `~` is the caller's ([`home_rest`]).
pub fn anchor(raw: &str) -> Anchor {
    anchor_for(raw, cfg!(windows), &std::env::temp_dir())
}

/// [`anchor`] for a given system, so both are tested everywhere. `temp`:
/// where Git Bash's `/tmp` is (the user's temp folder).
pub fn anchor_for(raw: &str, windows: bool, temp: &Path) -> Anchor {
    if !windows {
        return if raw.starts_with('/') {
            Anchor::Absolute(PathBuf::from(raw))
        } else {
            Anchor::Relative
        };
    }
    let bytes = raw.as_bytes();
    let sep = |b: u8| b == b'/' || b == b'\\';
    // `C:\…`, `C:/…`; `C:` alone or `C:x` is relative to that drive's own
    // current folder, which nothing here knows.
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return if bytes.len() >= 3 && sep(bytes[2]) {
            Anchor::Absolute(drive_path(bytes[0] as char, &raw[3..]))
        } else {
            Anchor::Unknown
        };
    }
    // A network share, `\\?\` and `\\.\` device paths.
    if bytes.len() >= 2 && sep(bytes[0]) && sep(bytes[1]) {
        return Anchor::Unknown;
    }
    if raw.starts_with('\\') {
        return Anchor::Unknown;
    }
    if let Some(rest) = raw.strip_prefix('/') {
        let rest = rest.strip_prefix("cygdrive/").unwrap_or(rest);
        let (top, below) = rest.split_once('/').unwrap_or((rest, ""));
        let mut chars = top.chars();
        if let (Some(d), None) = (chars.next(), chars.next()) {
            if d.is_ascii_alphabetic() {
                return Anchor::Absolute(drive_path(d, below));
            }
        }
        if top == "tmp" {
            return Anchor::Absolute(join_all(temp.to_path_buf(), below));
        }
        // `/dev/null` and the like stay as written (the rules know them);
        // any other `/x` is a Git Bash folder (or a fictional Mac's), kept
        // as written: it is never under the home, so writes there ask.
        return Anchor::Absolute(PathBuf::from(raw));
    }
    Anchor::Relative
}

fn drive_path(drive: char, rest: &str) -> PathBuf {
    join_all(
        PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase())),
        rest,
    )
}

fn join_all(mut base: PathBuf, rest: &str) -> PathBuf {
    for part in rest.split(['/', '\\']).filter(|p| !p.is_empty()) {
        base.push(part);
    }
    base
}

/// What follows `~/` (or, on Windows, `~\`); `None` when `raw` isn't that.
pub fn home_rest(raw: &str) -> Option<&str> {
    raw.strip_prefix("~/")
        .or_else(|| cfg!(windows).then(|| raw.strip_prefix("~\\")).flatten())
}

/// `p` with Windows' `\\?\` prefix taken off where it can be (identity
/// elsewhere): what `canonicalize` gives back compares with the home again.
pub fn plain(p: PathBuf) -> PathBuf {
    if cfg!(windows) {
        dunce::simplified(&p).to_path_buf()
    } else {
        p
    }
}

fn fold(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

/// `p` is `base` or inside it, ignoring case where the file system does.
pub fn under(p: &Path, base: &Path) -> bool {
    if !CASE_INSENSITIVE {
        return p.starts_with(base);
    }
    let mut p = p.components();
    for b in base.components() {
        match p.next() {
            Some(c) if fold(Path::new(c.as_os_str())) == fold(Path::new(b.as_os_str())) => {}
            _ => return false,
        }
    }
    true
}

/// The same path, ignoring case where the file system does.
pub fn same(a: &Path, b: &Path) -> bool {
    under(a, b) && under(b, a)
}

/// A file or folder name equal to `want`, ignoring case where the file
/// system does.
pub fn name_is(name: &std::ffi::OsStr, want: &str) -> bool {
    match name.to_str() {
        Some(n) if CASE_INSENSITIVE => n.to_lowercase() == want.to_lowercase(),
        Some(n) => n == want,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(raw: &str) -> Anchor {
        anchor_for(raw, true, Path::new(r"C:\Users\sam\AppData\Local\Temp"))
    }

    fn shown(a: Anchor) -> String {
        match a {
            // Built on another system, a drive path may join with `/`.
            Anchor::Absolute(p) => p.to_string_lossy().replace('\\', "/").replace("//", "/"),
            Anchor::Relative => "relative".into(),
            Anchor::Unknown => "unknown".into(),
        }
    }

    #[test]
    fn windows_paths_are_placed_or_ask() {
        for (raw, want) in [
            (r"C:\Users\sam\x.txt", "C:/Users/sam/x.txt"),
            ("c:/Users/sam/x.txt", "C:/Users/sam/x.txt"),
            ("/c/Users/sam/.ssh/id_rsa", "C:/Users/sam/.ssh/id_rsa"),
            ("/cygdrive/d/work", "D:/work"),
            ("/c", "C:/"),
            (
                "/tmp/build.log",
                "C:/Users/sam/AppData/Local/Temp/build.log",
            ),
            ("/dev/null", "/dev/null"),
            ("/usr/bin/git", "/usr/bin/git"),
            ("src/main.rs", "relative"),
            (r"src\main.rs", "relative"),
            ("C:", "unknown"),
            ("C:x.txt", "unknown"),
            (r"\\server\share\x", "unknown"),
            (r"\\?\C:\x", "unknown"),
            ("//server/share", "unknown"),
            (r"\Windows\x", "unknown"),
        ] {
            assert_eq!(shown(win(raw)), want, "{raw}");
        }
    }

    #[test]
    fn unix_paths_are_as_written() {
        let t = Path::new("/tmp");
        assert_eq!(
            anchor_for("/c/x", false, t),
            Anchor::Absolute("/c/x".into())
        );
        assert_eq!(anchor_for("C:/x", false, t), Anchor::Relative);
        assert_eq!(anchor_for("x", false, t), Anchor::Relative);
    }

    #[test]
    fn case_is_folded_only_where_the_file_system_ignores_it() {
        let home = Path::new("/Users/sam");
        assert!(under(Path::new("/Users/sam/.ssh/id"), &home.join(".ssh")));
        assert!(!under(Path::new("/Users/samuel"), home));
        assert!(!under(Path::new("/Users"), home));
        let upper = Path::new("/Users/sam/.SSH/authorized_keys");
        assert_eq!(under(upper, &home.join(".ssh")), CASE_INSENSITIVE);
        assert_eq!(same(Path::new("/users/SAM"), home), CASE_INSENSITIVE);
        assert_eq!(
            name_is(std::ffi::OsStr::new(".GIT"), ".git"),
            CASE_INSENSITIVE
        );
        assert!(name_is(std::ffi::OsStr::new(".git"), ".git"));
    }
}
