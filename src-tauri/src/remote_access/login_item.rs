//! Open at login: the one entry that starts the app when the user logs in,
//! in whatever form this OS reads.
//!
//! - **macOS**: a LaunchAgent, `~/Library/LaunchAgents/<identifier>.reopen-at-login.plist`,
//!   running `open -g` on the installed `.app`.
//! - **Windows**: a string value named after the app in
//!   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, holding the
//!   quoted path of the app's own `.exe`. No shortcut, no COM, nothing in
//!   HKLM; Task Manager's Startup apps lists it and can switch it off too.
//! - **Linux**: an XDG autostart entry, `$XDG_CONFIG_HOME/autostart/<identifier>.desktop`
//!   (`~/.config` when unset), whose `Exec` is the AppImage the user
//!   downloaded (`$APPIMAGE`; the running exe is inside a temporary mount)
//!   or else the installed binary.
//!
//! Each is named from `brand.json`, so this app and Ship Studio never touch
//! each other's. Turning it off removes the entry. It is offered only when
//! the app runs from an install: a dev build has nothing worth reopening
//! ([`target`]). Each is read back from the entry itself, never remembered.

use crate::errors::CommandError;
use std::path::{Path, PathBuf};

/// `<identifier>.reopen-at-login`, the LaunchAgent's label. Ship Studio's is
/// `studio.ship.reopen-at-login`; sharing it would let either app's toggle
/// rewrite or delete the other's.
pub fn launch_agent_label() -> String {
    format!("{}.reopen-at-login", crate::brand::IDENTIFIER)
}

#[cfg(target_os = "macos")]
fn launch_agent_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{}.plist", launch_agent_label()))
}

/// The `.app` bundle we are running from. `None` in a dev build, where there
/// is no bundle to reopen and the toggle is shown as unavailable.
pub fn app_bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(|p| p.to_path_buf())
}

pub fn launch_agent_plist(bundle: &Path) -> String {
    let bundle = bundle
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>{bundle}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        label = launch_agent_label()
    )
}

// ============================================================================
// What to start
// ============================================================================

/// Is `exe` a cargo build output (`…/target/debug/…`, `…/target/release/…`,
/// `…/target/<triple>/release/…`)? That is a dev build: reopening it at
/// login would start a stale copy of someone's working tree.
fn is_cargo_build(exe: &Path) -> bool {
    let parts: Vec<String> = exe
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    parts.iter().position(|p| p == "target").is_some_and(|i| {
        parts[i + 1..]
            .iter()
            .any(|p| p == "debug" || p == "release")
    })
}

/// What the entry starts on Windows and Linux: the AppImage when there is
/// one (`appimage`, from `$APPIMAGE`), else `exe`. `None` for a dev build.
pub fn launch_target(exe: &Path, appimage: Option<&str>) -> Option<PathBuf> {
    if let Some(img) = appimage.map(str::trim).filter(|s| !s.is_empty()) {
        let img = PathBuf::from(img);
        if img.is_absolute() {
            return Some(img);
        }
    }
    (!is_cargo_build(exe)).then(|| exe.to_path_buf())
}

/// This process's [`launch_target`].
pub fn target() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return app_bundle_path();
    }
    let exe = std::env::current_exe().ok()?;
    let appimage = if cfg!(target_os = "linux") {
        std::env::var("APPIMAGE").ok()
    } else {
        None
    };
    launch_target(&exe, appimage.as_deref())
}

/// Offered on this OS from this install.
pub fn available() -> bool {
    target().is_some()
}

// ============================================================================
// Windows: the Run key
// ============================================================================

pub const WINDOWS_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The Run value's data: the exe's path, quoted (a path with spaces would
/// otherwise be split at the first one). A Windows path can't hold `"`.
pub fn windows_run_command(exe: &str) -> String {
    format!("\"{exe}\"")
}

// ============================================================================
// Linux: an XDG autostart entry
// ============================================================================

/// `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart`. The spec says a
/// relative `XDG_CONFIG_HOME` is invalid and ignored.
pub fn xdg_autostart_dir(home: &Path, xdg_config_home: Option<&str>) -> PathBuf {
    let base = xdg_config_home
        .filter(|s| !s.is_empty() && Path::new(s).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    base.join("autostart")
}

pub fn desktop_file_name(identifier: &str) -> String {
    format!("{identifier}.desktop")
}

/// One `Exec` argument, quoted the way the Desktop Entry spec wants: inside
/// double quotes `"`, `` ` ``, `$` and `\` take a backslash, `%` doubles,
/// and then the value itself escapes its backslashes once more (a string
/// value's own `\\`). Control characters can't be written at all.
pub fn desktop_exec_arg(path: &str) -> Option<String> {
    if path.chars().any(char::is_control) {
        return None;
    }
    let mut quoted = String::from("\"");
    for c in path.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    Some(quoted.replace('\\', "\\\\"))
}

/// The autostart entry for `target`. `None` for a path that can't be written.
pub fn desktop_entry(name: &str, target: &Path) -> Option<String> {
    let exec = desktop_exec_arg(&target.to_string_lossy())?;
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    Some(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={name}\n\
         Exec={exec}\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n"
    ))
}

#[cfg(target_os = "linux")]
fn linux_entry_path_for(identifier: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    Some(xdg_autostart_dir(&home, xdg.as_deref()).join(desktop_file_name(identifier)))
}

// ============================================================================
// On / off, read back
// ============================================================================

#[cfg_attr(windows, allow(dead_code))]
fn no_home() -> CommandError {
    CommandError::expected("Could not find your home folder.")
}

pub fn active() -> bool {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().is_some_and(|h| launch_agent_path(&h).exists())
    }
    #[cfg(windows)]
    {
        use crate::user_chrome::win::{get_string, Root};
        get_string(Root::User, WINDOWS_RUN_KEY, Some(crate::brand::NAME)).is_some()
    }
    #[cfg(target_os = "linux")]
    {
        linux_entry_path_for(crate::brand::IDENTIFIER).is_some_and(|p| p.exists())
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        false
    }
}

fn not_installed() -> CommandError {
    CommandError::expected(
        "This build isn't running from an installed app, so there is nothing to reopen.",
    )
}

pub fn set(enabled: bool) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let path = launch_agent_path(&dirs::home_dir().ok_or_else(no_home)?);
        if !enabled {
            if path.exists() {
                std::fs::remove_file(&path)?;
            }
            return Ok(());
        }
        let bundle = app_bundle_path().ok_or_else(not_installed)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, launch_agent_plist(&bundle))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        use crate::user_chrome::win::{delete_value, set_string, Root};
        if !enabled {
            delete_value(Root::User, WINDOWS_RUN_KEY, crate::brand::NAME)?;
            return Ok(());
        }
        let exe = target().ok_or_else(not_installed)?;
        set_string(
            Root::User,
            WINDOWS_RUN_KEY,
            Some(crate::brand::NAME),
            &windows_run_command(&exe.to_string_lossy()),
        )?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let path = linux_entry_path_for(crate::brand::IDENTIFIER).ok_or_else(no_home)?;
        if !enabled {
            if path.exists() {
                std::fs::remove_file(&path)?;
            }
            return Ok(());
        }
        let exe = target().ok_or_else(not_installed)?;
        let body = desktop_entry(crate::brand::NAME, &exe).ok_or_else(|| {
            CommandError::expected("The app's path has characters a login item can't hold.")
        })?;
        Ok(write_linux_entry(&path, &body)?)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = (enabled, no_home);
        Err(CommandError::expected(
            "Opening at login isn't available on this computer.",
        ))
    }
}

/// Write the entry by rename, so a half-written file is never read at login.
#[cfg(any(target_os = "linux", test))]
fn write_linux_entry(path: &Path, body: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("desktop.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ============================================================================
// After a rename (`brand.json`'s `previous`)
// ============================================================================

/// Linux: move the old name's autostart entry in `dir` to the new name,
/// pointing at `target` when there is one (else its own `Exec`, kept). The old
/// file goes once the new one is written. `Ok(false)`: nothing to move.
#[cfg(any(target_os = "linux", test))]
pub fn carry_linux_entry(
    dir: &Path,
    old_identifier: &str,
    new_identifier: &str,
    name: &str,
    target: Option<&Path>,
) -> Result<bool, String> {
    let old = dir.join(desktop_file_name(old_identifier));
    let Ok(text) = std::fs::read_to_string(&old) else {
        return Ok(false);
    };
    let new = dir.join(desktop_file_name(new_identifier));
    if !new.exists() {
        let body = match target.and_then(|t| desktop_entry(name, t)) {
            Some(b) => b,
            None => text,
        };
        write_linux_entry(&new, &body).map_err(|e| format!("{}: {e}", new.display()))?;
    }
    std::fs::remove_file(&old).map_err(|e| format!("{}: {e}", old.display()))?;
    Ok(true)
}

/// Windows and Linux's share of the rename migration (macOS's is in
/// `brand_migration`, with the LaunchAgent): the old name's entry becomes
/// this name's. Safe to repeat; returns lines for the log.
pub fn carry_over_previous() -> Vec<String> {
    #[cfg_attr(not(any(windows, target_os = "linux")), allow(unused_mut))]
    let mut log = Vec::new();
    #[cfg(target_os = "linux")]
    if let (Some(old_id), Some(home)) = (crate::brand::previous::IDENTIFIER, dirs::home_dir()) {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let dir = xdg_autostart_dir(&home, xdg.as_deref());
        match carry_linux_entry(
            &dir,
            old_id,
            crate::brand::IDENTIFIER,
            crate::brand::NAME,
            target().as_deref(),
        ) {
            Ok(true) => log.push("[Rename] moved the open-at-login entry".into()),
            Ok(false) => {}
            Err(e) => log.push(format!("[Rename] the open-at-login entry: {e}")),
        }
    }
    #[cfg(windows)]
    if let Some(old_name) = crate::brand::previous::NAME {
        use crate::user_chrome::win::{delete_value, get_string, set_string, Root};
        if let Some(old) = get_string(Root::User, WINDOWS_RUN_KEY, Some(old_name)) {
            let new = target()
                .map(|t| windows_run_command(&t.to_string_lossy()))
                .unwrap_or(old);
            let moved = set_string(Root::User, WINDOWS_RUN_KEY, Some(crate::brand::NAME), &new)
                .and_then(|()| delete_value(Root::User, WINDOWS_RUN_KEY, old_name));
            match moved {
                Ok(()) => log.push("[Rename] moved the open-at-login entry".into()),
                Err(e) => log.push(format!("[Rename] the open-at-login entry: {e}")),
            }
        }
    }
    log
}

#[cfg(test)]
#[path = "login_item_tests.rs"]
mod tests;
