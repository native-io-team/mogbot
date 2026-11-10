//! Whether Chrome will let the user add the app's extension, read from what
//! Chrome itself keeps on this Mac, so Settings can say "this profile is
//! managed by your work" before the user goes looking for a greyed-out
//! Developer mode switch.
//!
//! Observed (the owner): a work Chrome profile managed by Google Admin had
//! Developer mode and Load unpacked turned off, so the extension couldn't be
//! added there at all, and nothing in the app said why.
//!
//! Two places Chrome takes policy from:
//!
//! - **This Mac** (MDM): `/Library/Managed Preferences/com.google.Chrome.plist`
//!   and the per-user copy beside it. Read with `plutil`; every profile on
//!   this Mac gets it, so a new profile doesn't help. [`blocks`] reads the
//!   policies that stop an unpacked extension or its native host.
//! - **A profile** (a Google Workspace account signed in to that profile,
//!   policy set in Google Admin): kept as `<profile>/Policy/User Policy`, a
//!   signed protobuf this module doesn't parse. Its presence says the profile
//!   is managed; which policies it sets is not read, so the app says
//!   "managed by your work" and what to do, not which switch is off.
//!   `Local State`'s profile list gives each profile's name, its account's
//!   domain and whether the user accepted management there.
//!
//! A personal profile (no work account signed in) isn't managed by anyone,
//! and the native host's manifest is shared by every profile in Chrome's
//! user data folder, so loading the extension there is all it takes.
//! Nothing here writes anywhere.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One Chrome profile, as Chrome lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Its folder under Chrome's user data ("Default", "Profile 2").
    pub dir: String,
    /// The name Chrome shows for it.
    pub name: String,
    /// The signed-in account's Google Workspace domain, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// An organisation's policy applies to this profile.
    pub managed: bool,
    /// The profile Chrome opened last (where "Open Chrome's extensions" lands).
    pub last_used: bool,
}

/// What this Mac's own Chrome policy stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Block {
    /// Developer mode is off (so no Load unpacked).
    DeveloperMode,
    /// Installing the extension is blocked.
    Install,
    /// The native host the extension talks to is blocked.
    NativeHost,
}

/// Everything Settings → Chrome says about management.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Management {
    /// What this Mac's Chrome policy (MDM) blocks, for every profile.
    pub machine: Vec<Block>,
    pub profiles: Vec<Profile>,
}

impl Management {
    /// Some profile isn't managed: the extension can be added there.
    pub fn personal_profile(&self) -> Option<&Profile> {
        self.profiles
            .iter()
            .filter(|p| !p.managed)
            .max_by_key(|p| p.last_used)
    }
}

/* ------------------------------------------------------- this Mac's policy */

fn list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn int(v: &Value, key: &str) -> Option<i64> {
    let x = v.get(key)?;
    x.as_i64().or_else(|| x.as_bool().map(i64::from))
}

/// What `policy` (Chrome's policy names, as in chrome://policy) blocks for
/// an extension with one of `ids` and a native host named `host`. Pure.
pub fn blocks(policy: &Value, ids: &[String], host: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let ours = |l: &[String]| l.iter().any(|x| ids.iter().any(|id| id == x));
    // Developer mode: its own policy (Chrome 128+), else DevTools being
    // disallowed (2), which turns it off too.
    let dev = match int(policy, "ExtensionDeveloperModeSettings") {
        Some(v) => v == 1,
        None => int(policy, "DeveloperToolsAvailability") == Some(2),
    };
    if dev {
        out.push(Block::DeveloperMode);
    }
    // Installing: a blocklist naming "*" or us, unless the allowlist names us;
    // ExtensionSettings' "*" blocked unless ours is allowed; allowed types
    // without plain extensions.
    let blocklist = list(policy, "ExtensionInstallBlocklist");
    let allowlist = list(policy, "ExtensionInstallAllowlist");
    let settings = policy.get("ExtensionSettings");
    let mode = |key: &str| -> Option<String> {
        settings?
            .get(key)?
            .get("installation_mode")?
            .as_str()
            .map(str::to_string)
    };
    let ours_mode = ids.iter().find_map(|id| mode(id));
    let ours_allowed = ours(&allowlist)
        || matches!(
            ours_mode.as_deref(),
            Some("allowed" | "force_installed" | "normal_installed")
        );
    let by_list = (blocklist.iter().any(|x| x == "*") || ours(&blocklist)) && !ours_allowed;
    let by_settings = (mode("*").as_deref() == Some("blocked") && !ours_allowed)
        || ours_mode.as_deref() == Some("blocked")
        || ours_mode.as_deref() == Some("removed");
    let types = policy.get("ExtensionAllowedTypes").is_some()
        && !list(policy, "ExtensionAllowedTypes")
            .iter()
            .any(|t| t == "extension");
    if by_list || by_settings || types {
        out.push(Block::Install);
    }
    // The host: user-level hosts off (ours is user-level), or a blocklist
    // naming "*" or ours without the allowlist naming it.
    let user_level_off = matches!(int(policy, "NativeMessagingUserLevelHosts"), Some(0));
    let nm_block = list(policy, "NativeMessagingBlocklist");
    let nm_allow = list(policy, "NativeMessagingAllowlist");
    let nm_blocked =
        (nm_block.iter().any(|x| x == "*" || x == host)) && !nm_allow.iter().any(|x| x == host);
    if user_level_off || nm_blocked {
        out.push(Block::NativeHost);
    }
    out
}

/// This Mac's Chrome policy files (MDM): the machine's and this user's.
pub fn machine_policy_files() -> Vec<PathBuf> {
    let root = Path::new("/Library/Managed Preferences");
    let mut out = vec![root.join("com.google.Chrome.plist")];
    if let Some(user) = dirs::home_dir().and_then(|h| h.file_name().map(|n| n.to_owned())) {
        out.push(root.join(user).join("com.google.Chrome.plist"));
    }
    out
}

/// A policy plist as JSON, through `plutil` (managed plists are binary).
fn read_plist(path: &Path) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    let out = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(path)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| serde_json::from_slice(&out.stdout).ok())
        .flatten()
}

/// What this Mac's Chrome policy blocks, read now.
pub fn machine_blocks() -> Vec<Block> {
    let ids = super::auth::extension_ids();
    let host = super::install::host_name();
    let mut out: Vec<Block> = Vec::new();
    for p in machine_policy_files() {
        if let Some(v) = read_plist(&p) {
            for b in blocks(&v, &ids, &host) {
                if !out.contains(&b) {
                    out.push(b);
                }
            }
        }
    }
    out
}

/* ------------------------------------------------------------ profiles */

/// A Workspace domain, not Chrome's "none" markers. Pure.
fn domain(raw: Option<&str>) -> Option<String> {
    let d = raw?.trim();
    (!d.is_empty() && !matches!(d, "NO_HOSTED_DOMAIN" | "NO_DOMAIN")).then(|| d.to_string())
}

/// The profiles in `local_state` (Chrome's `Local State` file), each marked
/// managed when `has_user_policy(dir)` (its `Policy/User Policy` file exists)
/// or the user accepted its account's management. Sorted as Chrome would
/// list them: the last used first, then by name. Pure.
pub fn profiles_from(local_state: &Value, has_user_policy: impl Fn(&str) -> bool) -> Vec<Profile> {
    let last = local_state
        .pointer("/profile/last_used")
        .and_then(Value::as_str)
        .unwrap_or("Default");
    let Some(cache) = local_state
        .pointer("/profile/info_cache")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut out: Vec<Profile> = cache
        .iter()
        .filter(|(dir, _)| valid_dir(dir))
        .map(|(dir, info)| {
            let accepted = info
                .get("user_accepted_account_management")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Profile {
                dir: dir.clone(),
                name: info
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or(dir)
                    .to_string(),
                domain: domain(info.get("hosted_domain").and_then(Value::as_str)),
                managed: accepted || has_user_policy(dir),
                last_used: dir == last,
            }
        })
        .collect();
    out.sort_by(|a, b| b.last_used.cmp(&a.last_used).then(a.name.cmp(&b.name)));
    out
}

/// A profile folder name Chrome made, safe to pass as `--profile-directory`:
/// no path separators, no leading dash, nothing odd. Pure.
pub fn valid_dir(dir: &str) -> bool {
    !dir.is_empty()
        && dir.len() <= 64
        && !dir.starts_with('-')
        && !dir.starts_with('.')
        && dir
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_')
}

/// The profiles in Chrome's user data folder `udd`, read now.
pub fn profiles(udd: &Path) -> Vec<Profile> {
    let Some(state) = std::fs::read(udd.join("Local State"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
    else {
        return Vec::new();
    };
    profiles_from(&state, |dir| {
        udd.join(dir).join("Policy").join("User Policy").is_file()
    })
}

/// Everything, read now from this Mac.
pub fn read() -> Management {
    Management {
        machine: machine_blocks(),
        profiles: super::install::chrome_user_data_dir()
            .map(|udd| profiles(&udd))
            .unwrap_or_default(),
    }
}

/* ------------------------------------------------------- a new profile */

/// The base name of the profile folder the app makes for agents' browsing.
pub const NEW_PROFILE_DIR: &str = "Agents";

/// The folder for a new personal profile: "Agents", or the first
/// "Agents N" not already a profile. An existing "Agents" that isn't managed
/// is reused (the user opened it before). Pure.
pub fn new_profile_dir(existing: &[Profile]) -> String {
    let taken = |d: &str| existing.iter().find(|p| p.dir == d);
    for n in 1..100 {
        let dir = if n == 1 {
            NEW_PROFILE_DIR.to_string()
        } else {
            format!("{NEW_PROFILE_DIR} {n}")
        };
        match taken(&dir) {
            None => return dir,
            Some(p) if !p.managed => return dir,
            Some(_) => {}
        }
    }
    format!("{NEW_PROFILE_DIR} {}", super::auth::random_hex(4))
}

/// `open`'s arguments to show Chrome in profile `dir` (Chrome makes the
/// profile when the folder doesn't exist yet). `-n` hands the arguments to
/// the running Chrome, which opens a window for that profile.
pub fn open_profile_args(dir: &str) -> Vec<String> {
    vec![
        "-na".into(),
        "Google Chrome".into(),
        "--args".into(),
        format!("--profile-directory={dir}"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids() -> Vec<String> {
        vec!["ourid".to_string()]
    }

    #[test]
    fn nothing_set_blocks_nothing() {
        assert!(blocks(&json!({}), &ids(), "host").is_empty());
    }

    #[test]
    fn developer_mode_off_by_its_own_policy_or_by_devtools() {
        let b = |v| blocks(&v, &ids(), "host");
        assert_eq!(
            b(json!({ "ExtensionDeveloperModeSettings": 1 })),
            vec![Block::DeveloperMode]
        );
        assert_eq!(
            b(json!({ "DeveloperToolsAvailability": 2 })),
            vec![Block::DeveloperMode]
        );
        // Its own policy wins over DevTools.
        assert!(
            b(json!({ "ExtensionDeveloperModeSettings": 0, "DeveloperToolsAvailability": 2 }))
                .is_empty()
        );
        assert!(b(json!({ "DeveloperToolsAvailability": 1 })).is_empty());
    }

    #[test]
    fn install_blocked_unless_ours_is_allowed() {
        let b = |v| blocks(&v, &ids(), "host");
        assert_eq!(
            b(json!({ "ExtensionInstallBlocklist": ["*"] })),
            vec![Block::Install]
        );
        assert!(b(
            json!({ "ExtensionInstallBlocklist": ["*"], "ExtensionInstallAllowlist": ["ourid"] })
        )
        .is_empty());
        assert_eq!(
            b(json!({ "ExtensionSettings": { "*": { "installation_mode": "blocked" } } })),
            vec![Block::Install]
        );
        assert!(b(json!({ "ExtensionSettings": {
            "*": { "installation_mode": "blocked" },
            "ourid": { "installation_mode": "allowed" }
        } }))
        .is_empty());
        assert_eq!(
            b(json!({ "ExtensionAllowedTypes": ["theme"] })),
            vec![Block::Install]
        );
        assert!(b(json!({ "ExtensionAllowedTypes": ["extension"] })).is_empty());
    }

    #[test]
    fn the_native_host_blocked() {
        let b = |v| blocks(&v, &ids(), "com.app.chrome_link");
        assert_eq!(
            b(json!({ "NativeMessagingUserLevelHosts": false })),
            vec![Block::NativeHost]
        );
        assert_eq!(
            b(json!({ "NativeMessagingBlocklist": ["*"] })),
            vec![Block::NativeHost]
        );
        assert!(b(json!({
            "NativeMessagingBlocklist": ["*"],
            "NativeMessagingAllowlist": ["com.app.chrome_link"]
        }))
        .is_empty());
    }

    fn local_state() -> Value {
        json!({ "profile": {
            "last_used": "Profile 1",
            "info_cache": {
                "Default": { "name": "Personal", "hosted_domain": "NO_HOSTED_DOMAIN" },
                "Profile 1": { "name": "Work", "hosted_domain": "example.com",
                               "user_accepted_account_management": true },
                "Profile 2": { "name": "Side", "hosted_domain": "side.dev" },
                "../evil": { "name": "Nope" }
            }
        }})
    }

    #[test]
    fn profiles_are_read_from_local_state() {
        let p = profiles_from(&local_state(), |dir| dir == "Profile 2");
        let dirs: Vec<&str> = p.iter().map(|p| p.dir.as_str()).collect();
        assert_eq!(
            dirs,
            ["Profile 1", "Default", "Profile 2"],
            "last used first, then by name; bad folder names dropped"
        );
        assert!(p[0].managed && p[0].last_used);
        assert_eq!(p[0].domain.as_deref(), Some("example.com"));
        assert!(!p[1].managed);
        assert_eq!(
            p[1].domain, None,
            "Chrome's no-domain marker isn't a domain"
        );
        assert!(p[2].managed, "a User Policy file marks it managed");
        let m = Management {
            machine: vec![],
            profiles: p,
        };
        assert_eq!(
            m.personal_profile().map(|p| p.dir.as_str()),
            Some("Default")
        );
    }

    #[test]
    fn a_missing_or_odd_local_state_is_no_profiles() {
        assert!(profiles_from(&json!({}), |_| false).is_empty());
        assert!(profiles_from(&json!({ "profile": { "info_cache": [] } }), |_| false).is_empty());
    }

    #[test]
    fn profile_folders_are_safe_to_pass_to_chrome() {
        assert!(valid_dir("Default"));
        assert!(valid_dir("Profile 12"));
        assert!(valid_dir("Agents 2"));
        for bad in [
            "",
            "-x",
            "../a",
            "a/b",
            ".hidden",
            "a\nb",
            "--user-data-dir=/tmp",
        ] {
            assert!(!valid_dir(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_new_profile_never_lands_on_a_managed_one() {
        let prof = |dir: &str, managed| Profile {
            dir: dir.into(),
            name: dir.into(),
            domain: None,
            managed,
            last_used: false,
        };
        assert_eq!(new_profile_dir(&[]), "Agents");
        assert_eq!(
            new_profile_dir(&[prof("Agents", false)]),
            "Agents",
            "reused"
        );
        assert_eq!(new_profile_dir(&[prof("Agents", true)]), "Agents 2");
        assert_eq!(
            open_profile_args("Agents 2"),
            [
                "-na",
                "Google Chrome",
                "--args",
                "--profile-directory=Agents 2"
            ]
        );
    }
}
