//! Where the app's webviews may navigate.
//!
//! The app window shows text written by agents and outside assistants. A link
//! in it, a form, or anything else that navigates the window would replace the
//! app with someone else's page inside our own chrome. This guard runs on every
//! navigation in every webview:
//!
//! - the app's own origins (the dev server in development, `tauri://localhost`
//!   / `https://tauri.localhost`, the asset and IPC protocols) are allowed;
//! - loopback http(s) on any port is allowed — that is the preview (the dev
//!   server and its proxy), which the app shows in an iframe;
//! - `about:`, `blob:` and `data:` are allowed for frames (WebKit already
//!   refuses a top-level `data:` navigation);
//! - `mailto:` / `tel:` are handed to the system and cancelled here;
//! - every other scheme (`file:`, `javascript:`, app-launching custom schemes,
//!   …) is denied.
//!
//! Web links (`http(s)` to anywhere else) are the hard case. On Windows the
//! handler sees top-level navigations only, so they open in the system browser
//! and the app stays put. On macOS and Linux the same handler also fires for
//! **every iframe** — including what the user's own site embeds in the preview
//! (a YouTube player, a Stripe form, an auth redirect) — and the URL alone
//! cannot say which frame asked. Opening those externally would spray browser
//! tabs and break the preview, so there they are allowed, and the top-level
//! case is closed in the frontend instead: `lib/navigationGuard.ts` sends any
//! web link clicked in the app to the browser and refuses cross-origin form
//! posts, and `lib/safeHtml.ts` keeps forms, meta refreshes and scripts out of
//! rendered text altogether.

use tauri::{plugin::TauriPlugin, Manager, Runtime, Url};

#[derive(Debug, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    /// Hand the URL to the system (browser, mail client) and cancel.
    OpenExternally,
    Deny,
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_loopback(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
    )
}

/// The app's own origins, besides the dev server.
fn is_app_origin(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        // macOS / Linux custom protocols: tauri://localhost, asset://localhost,
        // ipc://localhost.
        "tauri" | "asset" | "ipc" => host == "localhost",
        // Windows / Android serve the same protocols as http(s)://<name>.localhost.
        "http" | "https" => matches!(
            host,
            "tauri.localhost" | "asset.localhost" | "ipc.localhost"
        ),
        _ => false,
    }
}

/// Decide one navigation. `dev_url` is the configured dev server, if any;
/// `top_level_only` says whether this platform's handler fires for top-level
/// navigations only (Windows), so a web link can safely go to the browser.
pub fn decide(url: &Url, dev_url: Option<&Url>, top_level_only: bool) -> NavDecision {
    if dev_url.is_some_and(|dev| same_origin(url, dev)) || is_app_origin(url) {
        return NavDecision::Allow;
    }
    match url.scheme() {
        "http" | "https" if is_loopback(url) => NavDecision::Allow,
        "http" | "https" if top_level_only => NavDecision::OpenExternally,
        "http" | "https" => NavDecision::Allow,
        "about" | "blob" | "data" => NavDecision::Allow,
        "mailto" | "tel" => NavDecision::OpenExternally,
        _ => NavDecision::Deny,
    }
}

/// What the log says about a navigation: its scheme and host, never its
/// path, query or fragment, where a signed link, an OAuth code or a `mailto:`
/// address would sit.
fn log_target(url: &Url) -> String {
    match url.host_str() {
        Some(host) => format!("{}://{host}", url.scheme()),
        None => format!("{}:", url.scheme()),
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = webview.config().build.dev_url.clone();
            match decide(url, dev_url.as_ref(), cfg!(windows)) {
                NavDecision::Allow => true,
                NavDecision::OpenExternally => {
                    tracing::info!(
                        to = %log_target(url),
                        "Navigation sent to the system instead of the app"
                    );
                    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
                        tracing::warn!(%error, "Could not open a link externally");
                    }
                    false
                }
                NavDecision::Deny => {
                    tracing::warn!(scheme = url.scheme(), "Navigation denied");
                    false
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn dev() -> Url {
        u("http://127.0.0.1:1420")
    }

    #[test]
    fn the_log_names_only_scheme_and_host() {
        assert_eq!(
            log_target(&u("https://example.test/cb?code=fictional-oauth-code#t=1")),
            "https://example.test"
        );
        assert_eq!(
            log_target(&u("https://user:pw@example.test:8443/x?sig=abc")),
            "https://example.test"
        );
        assert_eq!(
            log_target(&u("mailto:someone@example.test?subject=x")),
            "mailto:"
        );
    }

    #[test]
    fn app_origins_are_allowed_everywhere() {
        for url in [
            "http://127.0.0.1:1420/src/main.tsx",
            "tauri://localhost/index.html",
            "https://tauri.localhost/",
            "http://tauri.localhost/",
            "asset://localhost/%2FUsers%2Fme%2Fa.png",
            "http://asset.localhost/x",
            "ipc://localhost/plugin",
        ] {
            assert_eq!(
                decide(&u(url), Some(&dev()), true),
                NavDecision::Allow,
                "{url}"
            );
            assert_eq!(
                decide(&u(url), Some(&dev()), false),
                NavDecision::Allow,
                "{url}"
            );
        }
    }

    #[test]
    fn loopback_previews_are_allowed() {
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1:51234/a?b",
            "https://localhost:8443",
        ] {
            assert_eq!(
                decide(&u(url), Some(&dev()), true),
                NavDecision::Allow,
                "{url}"
            );
        }
    }

    #[test]
    fn web_links_leave_the_app_where_the_handler_is_top_level_only() {
        let evil = u("https://evil.example/login");
        assert_eq!(
            decide(&evil, Some(&dev()), true),
            NavDecision::OpenExternally
        );
        // Where iframes reach the handler too, the preview's own embeds must load.
        assert_eq!(decide(&evil, Some(&dev()), false), NavDecision::Allow);
    }

    #[test]
    fn lookalike_hosts_are_not_the_app() {
        for url in [
            "https://tauri.localhost.evil.example/",
            "https://evil.example/tauri.localhost",
            "http://localhost.evil.example:3000/",
        ] {
            assert_eq!(
                decide(&u(url), Some(&dev()), true),
                NavDecision::OpenExternally,
                "{url}"
            );
        }
        assert_eq!(
            decide(&u("tauri://evil.example/"), Some(&dev()), true),
            NavDecision::Deny
        );
    }

    #[test]
    fn other_schemes_are_denied_or_handed_off() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vscode://file/x",
            "ftp://example.com/",
            "x-apple.systempreferences:com.apple.preference",
        ] {
            assert_eq!(
                decide(&u(url), Some(&dev()), false),
                NavDecision::Deny,
                "{url}"
            );
        }
        assert_eq!(
            decide(&u("mailto:a@b.c"), None, false),
            NavDecision::OpenExternally
        );
        assert_eq!(decide(&u("about:blank"), None, false), NavDecision::Allow);
        assert_eq!(decide(&u("about:srcdoc"), None, true), NavDecision::Allow);
    }

    #[test]
    fn a_production_build_has_no_dev_server() {
        assert_eq!(
            decide(&u("http://127.0.0.1:1420/"), None, true),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&u("tauri://localhost/"), None, true),
            NavDecision::Allow
        );
    }
}
