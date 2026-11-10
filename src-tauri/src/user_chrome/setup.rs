//! What Chrome itself says about each step of adding the extension, so every
//! step in Settings → Chrome ticks Done from a real check rather than a
//! "press here when you're done":
//!
//! - **Developer mode** is on in a profile: `extensions.ui.developer_mode`.
//! - **The extension is in Chrome**, and on or off:
//!   `extensions.settings.<our id>`, with `disable_reasons` (a list since
//!   Chrome ~130; a number before) and the old `state` (0 = off).
//!
//! Both live in the profile's `Secure Preferences` on macOS (checked on
//! Chrome 157 with a scratch `--user-data-dir`: Load unpacked over CDP, then
//! `developerPrivate.updateProfileConfiguration`, then
//! `management.setEnabled(false)` gave `disable_reasons: [1]`); older
//! builds kept some of it in `Preferences`, so both are read. Chrome writes
//! them about ten seconds after a change while it runs (observed: not at
//! 5 s, there by 12 s), so a tick can lag a few seconds behind the click.
//!
//! Read only, never written: these files are Chrome's, and the app never
//! changes a profile.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// Whether the app's extension is in a profile.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InChrome {
    #[default]
    Absent,
    /// Added and turned on.
    On,
    /// Added, but turned off in Chrome's extensions page.
    Off,
}

/// One profile's setup, as Chrome recorded it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProfileSetup {
    pub developer_mode: bool,
    pub extension: InChrome,
    /// The folder it was loaded from, for an unpacked one.
    pub path: Option<String>,
}

/// Off by Chrome's record: any disable reason, or the old `state` 0.
fn disabled(entry: &Value) -> bool {
    let reasons = match entry.get("disable_reasons") {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Number(n)) => n.as_u64().is_some_and(|n| n != 0),
        _ => false,
    };
    reasons || entry.get("state").and_then(Value::as_i64) == Some(0)
}

/// The setup in `docs` (a profile's `Secure Preferences`, then its
/// `Preferences`), for the extension ids `ids`. Pure.
pub fn from_prefs(docs: &[Value], ids: &[String]) -> ProfileSetup {
    let developer_mode = docs.iter().any(|d| {
        d.pointer("/extensions/ui/developer_mode")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let entry = docs.iter().find_map(|d| {
        let settings = d.pointer("/extensions/settings")?.as_object()?;
        ids.iter()
            .find_map(|id| settings.get(id))
            .filter(|e| e.is_object())
    });
    let (extension, path) = match entry {
        None => (InChrome::Absent, None),
        Some(e) => (
            if disabled(e) {
                InChrome::Off
            } else {
                InChrome::On
            },
            e.get("path").and_then(Value::as_str).map(str::to_string),
        ),
    };
    ProfileSetup {
        developer_mode,
        extension,
        path,
    }
}

/// The setup of the profile in `profile_dir`, read now. Nothing readable is
/// the same as nothing done.
pub fn read(profile_dir: &Path, ids: &[String]) -> ProfileSetup {
    let docs: Vec<Value> = ["Secure Preferences", "Preferences"]
        .iter()
        .filter_map(|f| std::fs::read(profile_dir.join(f)).ok())
        .filter_map(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .collect();
    from_prefs(&docs, ids)
}

/* ----------------------------------------------------------- the steps */

/// Where each step of setting Your Chrome up stands, every one read back
/// from the Mac or from Chrome, in the order the user does them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Steps {
    /// Google Chrome is installed.
    pub chrome: bool,
    /// Chrome can start the host (the manifest names a binary that's there).
    pub host: bool,
    /// The extension's files are in the folder Load unpacked takes.
    pub files: bool,
    /// The name of a profile with Developer mode on (one that isn't managed
    /// first, the one Chrome opened last first), if any.
    pub developer_mode: Option<String>,
    /// The name of the profile the extension is in, if any.
    pub loaded_in: Option<String>,
    /// It's in Chrome but turned off there.
    pub turned_off: bool,
    /// It was loaded from another folder than the app's (still works: the
    /// id comes from the manifest's key, but an update to the app's copy
    /// doesn't reach it).
    pub other_folder: bool,
    /// A Chrome profile is connected to the app right now.
    pub connected: bool,
}

/// The steps, from what was read. `profiles`: each profile with its setup,
/// Chrome's order (last used first). `staged`: the app's folder. Pure.
pub fn steps(
    chrome: bool,
    host: bool,
    staged: Option<&str>,
    profiles: &[(super::managed::Profile, ProfileSetup)],
    connected: bool,
) -> Steps {
    let pick = |want: &dyn Fn(&ProfileSetup) -> bool| {
        profiles
            .iter()
            .filter(|(_, s)| want(s))
            .min_by_key(|(p, _)| (p.managed, !p.last_used))
    };
    let developer_mode = pick(&|s| s.developer_mode).map(|(p, _)| p.name.clone());
    // Turned on beats turned off: a copy that's on somewhere is the one.
    let loaded =
        pick(&|s| s.extension == InChrome::On).or_else(|| pick(&|s| s.extension == InChrome::Off));
    let same = |a: &str, b: &str| {
        let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
        a.trim_end_matches('/') == b.trim_end_matches('/') || canon(a) == canon(b)
    };
    Steps {
        chrome,
        host,
        files: staged.is_some(),
        developer_mode,
        loaded_in: loaded.map(|(p, _)| p.name.clone()),
        turned_off: loaded.is_some_and(|(_, s)| s.extension == InChrome::Off),
        other_folder: match (loaded.and_then(|(_, s)| s.path.as_deref()), staged) {
            (Some(from), Some(staged)) => !same(from, staged),
            _ => false,
        },
        connected,
    }
}

#[cfg(test)]
mod tests {
    use super::super::managed::Profile;
    use super::*;
    use serde_json::json;

    const ID: &str = super::super::auth::DEV_EXTENSION_ID;

    fn ids() -> Vec<String> {
        vec![ID.to_string()]
    }

    /// The shape Chrome 157 wrote into `Secure Preferences` (trimmed).
    fn secure(dev: bool, reasons: Value) -> Value {
        json!({
            "extensions": {
                "settings": {
                    "ahfgeienlihckogmohjhadlkjgocpleb": { "location": 5, "disable_reasons": [] },
                    ID: {
                        "disable_reasons": reasons,
                        "from_webstore": false,
                        "location": 4,
                        "path": "/Users/u/Library/Application Support/Mogbot/chrome-extension",
                    }
                },
                "ui": { "developer_mode": dev }
            },
            "protection": { "macs": { "extensions": { "ui": { "developer_mode": "B800E9" } } } }
        })
    }

    #[test]
    fn reads_what_chrome_wrote() {
        let s = from_prefs(&[secure(true, json!([]))], &ids());
        assert!(s.developer_mode);
        assert_eq!(s.extension, InChrome::On);
        assert_eq!(
            s.path.as_deref(),
            Some("/Users/u/Library/Application Support/Mogbot/chrome-extension")
        );
        let off = from_prefs(&[secure(true, json!([1]))], &ids());
        assert_eq!(off.extension, InChrome::Off);
        // Older Chrome: a number, or `state`.
        assert_eq!(
            from_prefs(&[secure(false, json!(1))], &ids()).extension,
            InChrome::Off
        );
        let old = json!({ "extensions": { "settings": { ID: { "state": 0 } } } });
        assert_eq!(from_prefs(&[old], &ids()).extension, InChrome::Off);
        let old_on = json!({ "extensions": { "settings": { ID: { "state": 1 } } } });
        assert_eq!(from_prefs(&[old_on], &ids()).extension, InChrome::On);
    }

    #[test]
    fn nothing_there_is_nothing_done() {
        assert_eq!(from_prefs(&[], &ids()), ProfileSetup::default());
        let fresh = json!({ "extensions": { "settings": {} } });
        let s = from_prefs(&[fresh], &ids());
        assert!(!s.developer_mode);
        assert_eq!(s.extension, InChrome::Absent);
        // Another extension, or the HMAC string Chrome keeps beside the
        // value, isn't ours or a yes.
        let other = json!({ "extensions": { "settings": { "x": { "path": "/a" } }, "ui": { "developer_mode": "B800" } } });
        let s = from_prefs(&[other], &ids());
        assert!(!s.developer_mode);
        assert_eq!(s.extension, InChrome::Absent);
    }

    #[test]
    fn either_file_counts() {
        let dev_only = json!({ "extensions": { "ui": { "developer_mode": true } } });
        let ext_only = json!({ "extensions": { "settings": { ID: { "path": "/p" } } } });
        let s = from_prefs(&[ext_only, dev_only], &ids());
        assert!(s.developer_mode);
        assert_eq!(s.extension, InChrome::On);
    }

    #[test]
    fn reads_a_profile_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), &ids()), ProfileSetup::default());
        std::fs::write(
            dir.path().join("Secure Preferences"),
            serde_json::to_vec(&secure(true, json!([]))).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.path().join("Preferences"), b"not json").unwrap();
        let s = read(dir.path(), &ids());
        assert!(s.developer_mode);
        assert_eq!(s.extension, InChrome::On);
    }

    fn prof(name: &str, managed: bool, last_used: bool) -> Profile {
        Profile {
            dir: name.into(),
            name: name.into(),
            managed,
            last_used,
            ..Default::default()
        }
    }

    #[test]
    fn steps_name_the_profile_and_prefer_a_personal_one() {
        let staged = "/s/chrome-extension";
        let nothing = steps(true, true, Some(staged), &[], false);
        assert!(nothing.files && nothing.host && nothing.chrome);
        assert_eq!(nothing.developer_mode, None);
        assert_eq!(nothing.loaded_in, None);

        let dev = ProfileSetup {
            developer_mode: true,
            ..Default::default()
        };
        let loaded = ProfileSetup {
            developer_mode: true,
            extension: InChrome::On,
            path: Some(format!("{staged}/")),
        };
        let both = [
            (prof("Work", true, true), dev.clone()),
            (prof("Personal", false, false), loaded.clone()),
        ];
        let s = steps(true, true, Some(staged), &both, false);
        assert_eq!(s.developer_mode.as_deref(), Some("Personal"));
        assert_eq!(s.loaded_in.as_deref(), Some("Personal"));
        assert!(!s.turned_off && !s.other_folder);

        let off = [(
            prof("Personal", false, true),
            ProfileSetup {
                extension: InChrome::Off,
                ..loaded.clone()
            },
        )];
        let s = steps(true, true, Some(staged), &off, false);
        assert!(s.turned_off);
        assert_eq!(s.loaded_in.as_deref(), Some("Personal"));

        let elsewhere = [(
            prof("Personal", false, true),
            ProfileSetup {
                path: Some("/Users/u/checkout/chrome-extension/extension".into()),
                ..loaded
            },
        )];
        assert!(steps(true, true, Some(staged), &elsewhere, true).other_folder);
    }

    #[test]
    fn the_wire_words_are_stable() {
        let s = Steps {
            developer_mode: Some("Personal".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(s).unwrap();
        for k in [
            "chrome",
            "host",
            "files",
            "developerMode",
            "loadedIn",
            "turnedOff",
            "otherFolder",
            "connected",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(serde_json::to_value(InChrome::Off).unwrap(), "off");
    }
}
