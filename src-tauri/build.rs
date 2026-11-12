//! Reads the repo-root `brand.json` (the only place the app's name and
//! identity live) and generates `brand_gen.rs`, which `src/brand.rs` includes.
//! A null link in brand.json becomes `None`, and the feature behind it is off.
//!
//! A build script fails by panicking, so `expect` is the right tool here.
#![allow(clippy::expect_used)]

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    generate_brand();
    let mut attributes = tauri_build::Attributes::new();
    if embed_windows_manifest() {
        // The manifest is linked into every artifact below instead, so
        // tauri-build must not add its own (two manifests fail to link).
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("tauri-build failed");
}

/// tauri-build embeds the app manifest (Common Controls v6) through a resource
/// file that reaches only the app binary. Test executables then load comctl32
/// v5 and exit with STATUS_ENTRYPOINT_NOT_FOUND before any test runs. Linking
/// the manifest with `/MANIFEST:EMBED` covers the app and the tests alike.
fn embed_windows_manifest() -> bool {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os != "windows" || env != "msvc" {
        return false;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}

fn generate_brand() {
    let manifest =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let path = manifest.join("../brand.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(&path).expect("read ../brand.json");
    let brand: serde_json::Value = serde_json::from_str(&text).expect("parse ../brand.json");

    let req = |pointer: &str| -> String {
        brand
            .pointer(pointer)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| panic!("brand.json: {pointer} must be a non-empty string"))
            .to_string()
    };
    let opt = |pointer: &str| -> Option<String> {
        match brand.pointer(pointer) {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(s)) if s.is_empty() => None,
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(other) => panic!("brand.json: {pointer} must be a string or null, got {other}"),
        }
    };

    let mut out = String::new();
    for (name, pointer) in [
        ("NAME", "/name"),
        ("SLUG", "/slug"),
        ("IDENTIFIER", "/identifier"),
        ("URL_SCHEME", "/urlScheme"),
        ("APP_DIR_NAME", "/appDirName"),
        ("COMPANION_SCHEME", "/companion/scheme"),
        ("COMPANION_BUNDLE_ID", "/companion/bundleId"),
    ] {
        let value = req(pointer);
        writeln!(out, "pub const {name}: &str = {value:?};").ok();
    }

    // Remote Access's Tailscale Funnel path. Ship Studio mounts `/shipstudio`
    // on the same `tailscale serve` config, so ours must differ.
    let funnel = format!("/{}", req("/slug"));
    writeln!(out, "pub const FUNNEL_MOUNT_PATH: &str = {funnel:?};").ok();

    let port = brand
        .pointer("/companion/tailnetPort")
        .and_then(|v| v.as_u64())
        .filter(|p| (1..=65535).contains(p))
        .expect("brand.json: companion.tailnetPort must be a port number");
    writeln!(out, "pub const COMPANION_TAILNET_PORT: u16 = {port};").ok();

    // The app's previous identity (`previous` in brand.json, all null for a
    // brand that was never renamed): where `brand_migration` looks for
    // state to carry over on the first launch under the new name.
    writeln!(out, "pub mod previous {{").ok();
    for (name, key) in [
        ("NAME", "name"),
        ("SLUG", "slug"),
        ("IDENTIFIER", "identifier"),
        ("APP_DIR_NAME", "appDirName"),
    ] {
        let value = opt(&format!("/previous/{key}"));
        writeln!(out, "    pub const {name}: Option<&str> = {value:?};").ok();
    }
    writeln!(out, "}}").ok();

    writeln!(out, "pub mod links {{").ok();
    for (name, key) in [
        ("ISSUE_REPO", "issueRepo"),
        ("WEBSITE", "website"),
        ("ERROR_REPORTS", "errorReports"),
        ("RELEASES", "releases"),
        ("UPDATES", "updates"),
        ("TEMPLATE_API", "templateApi"),
        ("STARTER_REPO_BASE", "starterRepoBase"),
        ("COMPANION_SOURCE", "companionSource"),
        ("PUSH_RELAY", "pushRelay"),
        ("RELAY", "relay"),
    ] {
        let value = opt(&format!("/links/{key}"));
        writeln!(out, "    pub const {name}: Option<&str> = {value:?};").ok();
    }
    writeln!(out, "}}").ok();
    // The phone relay (docs/relay.md) is `wss://host`: the Mac and the phone
    // add their own paths to it.
    if let Some(relay) = opt("/links/relay") {
        let host = relay.strip_prefix("wss://").unwrap_or("");
        assert!(
            !host.is_empty() && !host.contains(['/', '?', '#', '@']),
            "brand.json: links.relay must be wss://<host> with no path, got {relay}"
        );
    }

    // The app's Chrome extension (`user_chrome`): its Web Store id once
    // the listing exists. Null keeps it to the unpacked (dev) id only.
    writeln!(out, "pub mod chrome {{").ok();
    let store = opt("/chromeExtension/webStoreId");
    if let Some(id) = &store {
        assert!(
            id.len() == 32 && id.chars().all(|c| ('a'..='p').contains(&c)),
            "brand.json: chromeExtension.webStoreId must be a 32-letter Chrome extension id"
        );
    }
    writeln!(out, "    pub const WEB_STORE_ID: Option<&str> = {store:?};").ok();
    writeln!(out, "}}").ok();

    writeln!(out, "pub mod telemetry {{").ok();
    for (name, key) in [
        ("POSTHOG_KEY", "posthogKey"),
        ("POSTHOG_HOST", "posthogHost"),
        ("SENTRY_DSN", "sentryDsn"),
    ] {
        let value = opt(&format!("/telemetry/{key}"));
        writeln!(out, "    pub const {name}: Option<&str> = {value:?};").ok();
    }
    writeln!(out, "}}").ok();

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    std::fs::write(out_dir.join("brand_gen.rs"), out).expect("write brand_gen.rs");
}
