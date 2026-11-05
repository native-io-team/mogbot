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
    tauri_build::build()
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
    ] {
        let value = opt(&format!("/links/{key}"));
        writeln!(out, "    pub const {name}: Option<&str> = {value:?};").ok();
    }
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
