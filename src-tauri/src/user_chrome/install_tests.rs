use super::*;
use std::path::Path;

fn extension_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../chrome-extension/extension")
}

#[test]
fn host_name_is_one_chrome_accepts() {
    let n = host_name();
    assert!(n.ends_with(".chrome_link"));
    assert!(n
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_'));
    assert!(!n.starts_with('.') && !n.contains(".."));
}

#[test]
fn the_manifest_names_this_binary_and_only_our_extension() {
    let m = host_manifest(Path::new("/Applications/X.app/Contents/MacOS/x"));
    assert_eq!(m["name"], host_name());
    assert_eq!(m["type"], "stdio");
    assert_eq!(m["path"], "/Applications/X.app/Contents/MacOS/x");
    let origins: Vec<&str> = m["allowed_origins"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(origins.contains(&format!("chrome-extension://{}/", auth::DEV_EXTENSION_ID).as_str()));
    assert!(origins
        .iter()
        .all(|o| o.starts_with("chrome-extension://") && o.ends_with('/')));
    assert!(!origins.iter().any(|o| o.contains('*')));
}

#[test]
fn install_reads_back_and_notices_a_moved_app() {
    let udd = tempfile::tempdir().unwrap();
    let exe = Path::new("/tmp/one");
    assert_eq!(host_state(udd.path(), exe), HostState::Missing);
    let p = install_host(udd.path(), exe).unwrap();
    assert!(p.starts_with(udd.path().join("NativeMessagingHosts")));
    assert_eq!(host_state(udd.path(), exe), HostState::Current);
    assert_eq!(
        host_state(udd.path(), Path::new("/tmp/two")),
        HostState::Stale
    );
    remove_host(udd.path());
    assert_eq!(host_state(udd.path(), exe), HostState::Missing);
}

#[test]
fn the_dev_id_is_the_one_the_manifest_key_gives() {
    let raw = std::fs::read(extension_dir().join("manifest.json")).unwrap();
    let m: Value = serde_json::from_slice(&raw).unwrap();
    let key = m["key"].as_str().expect("the dev manifest carries its key");
    assert_eq!(id_from_key(key).unwrap(), auth::DEV_EXTENSION_ID);
    assert_eq!(m["manifest_version"], 3);
    // Only what it needs: no <all_urls> host permission outside debugger,
    // no cookies, no webRequest, no history.
    let perms: Vec<&str> = m["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    for p in [
        "nativeMessaging",
        "debugger",
        "tabs",
        "tabGroups",
        "storage",
        "alarms",
    ] {
        assert!(perms.contains(&p), "{p} missing");
    }
    for p in [
        "cookies",
        "webRequest",
        "history",
        "downloads",
        "management",
        "scripting",
    ] {
        assert!(!perms.contains(&p), "{p} isn't needed");
    }
    assert!(m.get("host_permissions").is_none());
    assert!(m.get("content_scripts").is_none());
}

#[test]
fn staging_copies_the_extension_and_nothing_else() {
    let src = tempfile::tempdir().unwrap();
    std::fs::write(src.path().join("manifest.json"), r#"{"version":"1.2.3"}"#).unwrap();
    std::fs::create_dir(src.path().join("src")).unwrap();
    std::fs::write(src.path().join("src/a.js"), "x").unwrap();
    std::fs::write(src.path().join(".DS_Store"), "x").unwrap();
    std::fs::write(src.path().join("notes.md"), "x").unwrap();
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("ext");
    stage_extension(src.path(), &dest).unwrap();
    assert!(dest.join("src/a.js").is_file());
    assert!(!dest.join(".DS_Store").exists());
    assert!(!dest.join("notes.md").exists());
    assert_eq!(extension_version(&dest).as_deref(), Some("1.2.3"));
    // Again, over the top.
    stage_extension(src.path(), &dest).unwrap();
    assert!(dest.join("manifest.json").is_file());
}

#[test]
fn the_real_extension_stages_whole() {
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("ext");
    stage_extension(&extension_dir(), &dest).unwrap();
    for f in [
        "manifest.json",
        "src/service_worker.js",
        "src/protocol.js",
        "src/cdp.js",
        "src/tabs.js",
        "src/link.js",
        "popup.html",
        "icons/icon-128.png",
    ] {
        assert!(dest.join(f).is_file(), "{f} wasn't staged");
    }
}

#[test]
fn external_extensions_point_at_the_web_store_only() {
    let udd = tempfile::tempdir().unwrap();
    let p = write_external_extension(udd.path(), auth::DEV_EXTENSION_ID).unwrap();
    assert!(p.ends_with(format!(
        "External Extensions/{}.json",
        auth::DEV_EXTENSION_ID
    )));
    let v: Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    assert_eq!(v, json!({ "external_update_url": WEB_STORE_UPDATE_URL }));
}

#[test]
fn the_extensions_page_opens_as_a_new_chrome_tab() {
    // A tab Chrome makes itself, never a launch argument (ignored for
    // chrome:// pages), and only in Google Chrome.
    assert!(OPEN_EXTENSIONS_SCRIPT.starts_with("tell application \"Google Chrome\""));
    assert!(OPEN_EXTENSIONS_SCRIPT
        .contains("make new tab with properties {URL:\"chrome://extensions/\"}"));
    assert!(OPEN_EXTENSIONS_SCRIPT.contains("if (count of windows) is 0 then"));
    assert_eq!(OPEN_EXTENSIONS_SCRIPT.matches("chrome://").count(), 2);
}
