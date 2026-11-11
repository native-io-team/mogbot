//! Where the running app lives, and moving it into Applications.
//!
//! People open the app straight from the downloaded disk image and never drag
//! it across. It runs, but an update can't replace it: the disk image is
//! read-only ("Read-only file system (os error 30)"), and macOS's App
//! Translocation runs a quarantined copy from a read-only spot too. The
//! update banner asks here first and offers one click that copies the app to
//! /Applications (or ~/Applications when that isn't writable), puts any older
//! copy there in the Trash, and reopens it from its new home.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Where {
    /// /Applications or ~/Applications: updates work.
    Applications,
    /// Opened from the downloaded disk image (read-only).
    DiskImage,
    /// macOS runs a quarantined copy from a randomised read-only path.
    Translocated,
    /// Somewhere else that can be written (a dev build, a folder).
    Elsewhere,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLocation {
    pub place: Where,
    /// True when an update can't be put in place where it runs now.
    pub needs_move: bool,
}

/// The `.app` bundle the running binary lives in.
fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

fn read_only(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid NUL-terminated path, `st` a writable struct.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return false;
        }
        (st.f_flag & libc::ST_RDONLY) != 0
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// Pure: decide from the bundle's path (and whether its volume is read-only).
pub fn classify(bundle: &Path, home: Option<&Path>, ro: bool) -> Where {
    let s = bundle.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        return Where::Translocated;
    }
    if bundle.starts_with("/Applications")
        || home.is_some_and(|h| bundle.starts_with(h.join("Applications")))
    {
        return Where::Applications;
    }
    if s.starts_with("/Volumes/") && ro {
        return Where::DiskImage;
    }
    Where::Elsewhere
}

fn locate() -> AppLocation {
    let Some(bundle) = bundle_path() else {
        return AppLocation {
            place: Where::Elsewhere,
            needs_move: false,
        };
    };
    let home = dirs::home_dir();
    let place = classify(&bundle, home.as_deref(), read_only(&bundle));
    AppLocation {
        place,
        needs_move: matches!(place, Where::DiskImage | Where::Translocated),
    }
}

#[tauri::command]
#[tracing::instrument]
pub fn app_location() -> AppLocation {
    locate()
}

fn writable_dir(dir: &Path) -> bool {
    let probe = dir.join(format!(".{}-write-probe", crate::brand::SLUG));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Copy the running app into Applications and reopen it from there.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn move_to_applications(app: AppHandle) -> Result<String, CommandError> {
    let bundle = bundle_path()
        .ok_or_else(|| CommandError::expected("Couldn't find where the app is running from."))?;
    let name = bundle
        .file_name()
        .ok_or_else(|| CommandError::expected("Couldn't read the app's name."))?
        .to_owned();
    let home = dirs::home_dir();
    let dest_dir = if writable_dir(Path::new("/Applications")) {
        PathBuf::from("/Applications")
    } else {
        let d = home
            .as_ref()
            .ok_or_else(|| CommandError::expected("Couldn't find your home folder."))?
            .join("Applications");
        std::fs::create_dir_all(&d)
            .map_err(|e| CommandError::expected(format!("Couldn't make ~/Applications ({e}).")))?;
        d
    };
    let dest = dest_dir.join(&name);
    let staging = dest_dir.join(format!(".{}.moving", name.to_string_lossy()));
    let _ = std::fs::remove_dir_all(&staging);

    let out = std::process::Command::new("/usr/bin/ditto")
        .arg(&bundle)
        .arg(&staging)
        .output()
        .map_err(|e| CommandError::expected(format!("Couldn't copy the app ({e}).")))?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(CommandError::expected(format!(
            "Couldn't copy the app: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    // An older copy already there goes to the Trash, never deleted outright.
    if dest.exists() {
        let trash = home
            .as_ref()
            .map(|h| h.join(".Trash"))
            .ok_or_else(|| CommandError::expected("Couldn't find the Trash."))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let to = trash.join(format!("{stem} (older {stamp}).app"));
        std::fs::rename(&dest, &to).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            CommandError::expected(format!(
                "Couldn't move the older copy in Applications to the Trash ({e}). Quit it if it's open and try again."
            ))
        })?;
    }
    std::fs::rename(&staging, &dest)
        .map_err(|e| CommandError::expected(format!("Couldn't put the app in place ({e}).")))?;

    tracing::info!(to = %dest.display(), "moved the app into Applications; reopening");
    std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&dest)
        .spawn()
        .map_err(|e| CommandError::expected(format!("Couldn't open the moved app ({e}).")))?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        handle.exit(0);
    });
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_the_app_runs_from() {
        let home = Path::new("/Users/sam");
        let c = |p: &str, ro| classify(Path::new(p), Some(home), ro);
        assert_eq!(c("/Applications/Mogbot.app", false), Where::Applications);
        assert_eq!(
            c("/Users/sam/Applications/Mogbot.app", false),
            Where::Applications
        );
        assert_eq!(c("/Volumes/Mogbot/Mogbot.app", true), Where::DiskImage);
        // A writable external drive is fine to update in place.
        assert_eq!(c("/Volumes/Work/Mogbot.app", false), Where::Elsewhere);
        assert_eq!(
            c(
                "/private/var/folders/x/T/AppTranslocation/ABC/d/Mogbot.app",
                true
            ),
            Where::Translocated
        );
        assert_eq!(
            c("/Users/sam/Downloads/Mogbot.app", false),
            Where::Elsewhere
        );
    }
}
