//! # HTML Injection Utilities
//!
//! Functions for injecting scripts and error overlays into HTML responses.
//! Used by the preview proxy to add navigation tracking and error display.

use super::{
    COMMENTS_SCRIPT, NAV_SCRIPT, RELOAD_SUPPRESS, SCROLLBAR_STYLE, SCROLL_RESTORE, SELECT_SCRIPT,
};

/// Inject the navigation tracking script + the (inert until activated) visual-
/// editor selection layer into an HTML response body, plus the scrollbar-hiding
/// style and the scroll-position restorer.
///
/// The scripts go at the *end* of `<head>` (latest, so they see the final DOM);
/// the scrollbar style + scroll-restore go at the *start* of `<head>` (earliest:
/// the site's own scrollbar styling overrides ours, and the scroll-restore must
/// run before first paint to avoid a visible jump — see those consts).
pub fn inject_nav_script(html: &[u8]) -> Vec<u8> {
    let with_scripts = inject_into_html(
        html,
        &format!("{NAV_SCRIPT}{SELECT_SCRIPT}{COMMENTS_SCRIPT}"),
    );
    inject_at_head_start(
        &with_scripts,
        &format!("{SCROLLBAR_STYLE}{RELOAD_SUPPRESS}{SCROLL_RESTORE}"),
    )
}

/// Insert a snippet immediately *after* the opening `<head>` tag (falling back to
/// after `<html>`, then the document start). Unlike `inject_into_html` (which
/// lands at the end of `<head>`), this places the snippet *before* the site's own
/// stylesheets in cascade order — use it for low-priority defaults a site should
/// be able to override.
pub fn inject_at_head_start(html: &[u8], snippet: &str) -> Vec<u8> {
    let body = String::from_utf8_lossy(html);

    // After the opening `<head …>` tag (covers `<head>` and `<head class="…">`).
    if let Some(head) = body.find("<head") {
        if let Some(gt) = body[head..].find('>') {
            return splice_at(html, head + gt + 1, snippet);
        }
    }

    // Fallback: after the opening `<html …>` tag.
    if let Some(htmltag) = body.find("<html") {
        if let Some(gt) = body[htmltag..].find('>') {
            return splice_at(html, htmltag + gt + 1, snippet);
        }
    }

    // Final fallback: prepend to the document.
    let mut result = Vec::with_capacity(html.len() + snippet.len());
    result.extend_from_slice(snippet.as_bytes());
    result.extend_from_slice(html);
    result
}

/// Splice `snippet` into `html` at byte offset `pos`.
fn splice_at(html: &[u8], pos: usize, snippet: &str) -> Vec<u8> {
    let mut result = Vec::with_capacity(html.len() + snippet.len());
    result.extend_from_slice(&html[..pos]);
    result.extend_from_slice(snippet.as_bytes());
    result.extend_from_slice(&html[pos..]);
    result
}

/// Inject an arbitrary HTML/CSS/JS snippet into an HTML document.
/// Tries before </head>, then </body>, then appends to end.
pub fn inject_into_html(html: &[u8], snippet: &str) -> Vec<u8> {
    let body = String::from_utf8_lossy(html);

    // Try to inject before </head> (earliest execution)
    if let Some(pos) = body.find("</head>") {
        let byte_pos = body[..pos].len();
        let mut result = Vec::with_capacity(html.len() + snippet.len());
        result.extend_from_slice(&html[..byte_pos]);
        result.extend_from_slice(snippet.as_bytes());
        result.extend_from_slice(&html[byte_pos..]);
        return result;
    }

    // Fallback: before </body>
    if let Some(pos) = body.find("</body>") {
        let byte_pos = body[..pos].len();
        let mut result = Vec::with_capacity(html.len() + snippet.len());
        result.extend_from_slice(&html[..byte_pos]);
        result.extend_from_slice(snippet.as_bytes());
        result.extend_from_slice(&html[byte_pos..]);
        return result;
    }

    // Final fallback: append to end
    let mut result = html.to_vec();
    result.extend_from_slice(snippet.as_bytes());
    result
}

/// Attempt to extract a human-readable error message from an HTML error response.
/// Tries multiple strategies for different frameworks (Next.js, Vite, generic).
pub fn extract_error_message(html: &str) -> String {
    // Strategy 1: Next.js __NEXT_DATA__ JSON with error info
    if let Some(start) = html.find("__NEXT_DATA__") {
        if let Some(json_start) = html[start..].find('>') {
            let after_tag = start + json_start + 1;
            if let Some(json_end) = html[after_tag..].find("</script>") {
                let json_str = &html[after_tag..after_tag + json_end];
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(msg) = val.pointer("/err/message").and_then(|v| v.as_str()) {
                        return msg.to_string();
                    }
                    if let Some(msg) = val
                        .pointer("/props/pageProps/error/message")
                        .and_then(|v| v.as_str())
                    {
                        return msg.to_string();
                    }
                }
            }
        }
    }

    // Strategy 2: Error in <pre> tag (common in many frameworks)
    if let Some(pre_start) = html.find("<pre>") {
        let content_start = pre_start + 5;
        if let Some(pre_end) = html[content_start..].find("</pre>") {
            let content = &html[content_start..content_start + pre_end];
            let cleaned = content
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .replace("&quot;", "\"");
            if !cleaned.trim().is_empty() {
                // On a character boundary: byte 2000 can fall inside a
                // non-ASCII character in a build error, and slicing there panics.
                let mut cut = cleaned.len().min(2000);
                while !cleaned.is_char_boundary(cut) {
                    cut -= 1;
                }
                let truncated = &cleaned[..cut];
                return truncated.trim().to_string();
            }
        }
    }

    // Strategy 3: Error in <h1> or <h2> tags
    for tag in &["<h1>", "<h2>"] {
        if let Some(start) = html.find(tag) {
            let content_start = start + tag.len();
            let close_tag = tag.replace('<', "</");
            if let Some(end) = html[content_start..].find(&close_tag) {
                let text = &html[content_start..content_start + end];
                let clean_text = strip_html_tags(text);
                if !clean_text.trim().is_empty() && clean_text.len() < 500 {
                    return clean_text.trim().to_string();
                }
            }
        }
    }

    // Strategy 4: <title> tag containing error keywords
    if let Some(start) = html.find("<title>") {
        let content_start = start + 7;
        if let Some(end) = html[content_start..].find("</title>") {
            let title = &html[content_start..content_start + end];
            if !title.trim().is_empty()
                && title.len() < 200
                && (title.contains("Error") || title.contains("error") || title.contains("500"))
            {
                return title.trim().to_string();
            }
        }
    }

    // Fallback
    "The dev server returned an error. The full log is in the dev server panel.".to_string()
}

/// Strip HTML tags from a string, leaving only text content.
pub fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(ch);
        }
    }
    result
}

/// Shared overlay panel builder. `title` is the header line next to the status
/// badge, `intro` is an optional pre-escaped explanatory paragraph rendered
/// above the monospace message block, `message` is the raw error/reason string
/// (escaped here, and wired to the Copy / Send-to-Claude buttons), and `hint`
/// is the muted footer line inside the body.
fn build_overlay_panel(
    status_code: u16,
    title: &str,
    intro: Option<&str>,
    message: &str,
    hint: &str,
) -> String {
    let escaped_message = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('\n', "<br>");

    // Embed the message as a JSON string literal (valid JS), then escape `<`
    // so a payload containing `</script>` or `<!--` can't terminate the
    // script element — the HTML parser ends script data on `</script>`
    // regardless of JS string boundaries.
    let js_escaped = serde_json::to_string(message)
        .unwrap_or_else(|_| String::from("\"\""))
        .replace('<', "\\u003c");

    let intro_html = intro
        .map(|i| format!(r#"<div class="__ss-err-intro">{i}</div>"#))
        .unwrap_or_default();

    format!(
        r#"<style>
body{{display:block!important;visibility:visible!important;opacity:1!important}}
.__ss-err-overlay{{--e-app:#f4f2ee;--e-panel:#fdfcfa;--e-recessed:#f4f2ee;--e-border:#e9e6e0;--e-text:#1c1c1c;--e-text2:#55524b;--e-muted:#6b675f;--e-ctl:#fdfcfa;--e-ctl-hover:#e9e6e0;--e-ctl-border:#dad6ce;--e-strong:#1c1c1c;--e-strong-hover:#403d39;--e-on-strong:#fff;--e-err:#cf222e;--e-err-tint:rgba(207,34,46,.1)}}
@media (prefers-color-scheme:dark){{.__ss-err-overlay{{--e-app:#151413;--e-panel:#1c1b19;--e-recessed:#151413;--e-border:#31302d;--e-text:#d6d2ca;--e-text2:#a29d95;--e-muted:#8a857e;--e-ctl:#292725;--e-ctl-hover:#31302d;--e-ctl-border:#4f4c48;--e-strong:#f4f2ee;--e-strong-hover:#fff;--e-on-strong:#151413;--e-err:#f47067;--e-err-tint:rgba(244,71,71,.14)}}}}
.__ss-err-overlay{{position:fixed;inset:0;z-index:2147483647;background:var(--e-app);font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;color:var(--e-text);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;-webkit-font-smoothing:antialiased}}
.__ss-err-overlay *{{box-sizing:border-box}}
.__ss-err-panel{{max-width:640px;width:100%;background:var(--e-panel);border:1px solid var(--e-border);border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.08)}}
.__ss-err-header{{display:flex;align-items:center;gap:10px;padding:16px 20px 0}}
.__ss-err-badge{{display:inline-flex;align-items:center;gap:5px;background:var(--e-err-tint);color:var(--e-err);font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;font-variant-numeric:tabular-nums}}
.__ss-err-badge::before{{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}}
.__ss-err-title{{font-size:14px;font-weight:600;color:var(--e-text)}}
.__ss-err-body{{padding:14px 20px 4px;max-height:60vh;overflow-y:auto}}
.__ss-err-intro{{font-size:13px;line-height:1.55;color:var(--e-text2);margin-bottom:12px}}
.__ss-err-intro code{{font-family:'SF Mono',Monaco,'JetBrains Mono',monospace;font-size:12px}}
.__ss-err-msg{{font-family:'SF Mono',Monaco,'JetBrains Mono',monospace;font-size:12px;line-height:1.6;color:var(--e-text);white-space:pre-wrap;word-break:break-word;background:var(--e-recessed);padding:12px 14px;border-radius:8px;border:1px solid var(--e-border)}}
.__ss-err-hint{{margin-top:10px;font-size:12px;color:var(--e-muted)}}
.__ss-err-footer{{display:flex;gap:8px;padding:14px 20px 16px;justify-content:flex-end}}
.__ss-err-btn{{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--e-ctl-border);background:var(--e-ctl);color:var(--e-text);font:500 12px/1 inherit;font-family:inherit;cursor:pointer;transition:background .12s}}
.__ss-err-btn:hover{{background:var(--e-ctl-hover)}}
.__ss-err-btn:focus-visible{{outline:1.5px solid var(--e-text);outline-offset:2px}}
.__ss-err-btn--primary{{background:var(--e-strong);border-color:var(--e-strong);color:var(--e-on-strong)}}
.__ss-err-btn--primary:hover{{background:var(--e-strong-hover)}}
</style>
<div class="__ss-err-overlay"><div class="__ss-err-panel" role="alert">
<div class="__ss-err-header"><span class="__ss-err-badge">{status_code}</span><span class="__ss-err-title">{title}</span></div>
<div class="__ss-err-body">{intro_html}<div class="__ss-err-msg">{escaped_message}</div><div class="__ss-err-hint">{hint}</div></div>
<div class="__ss-err-footer"><button class="__ss-err-btn" id="__ss-err-copy">Copy error</button><button class="__ss-err-btn __ss-err-btn--primary" id="__ss-err-send">Send to agent</button></div>
</div></div>
<script>(function(){{
var msg={js_escaped};
window.parent.postMessage({{type:'shipstudio:error',status:{status_code},message:msg}},'*');
document.getElementById('__ss-err-copy').onclick=function(){{
window.parent.postMessage({{type:'shipstudio:copy-error',message:msg}},'*');
var b=this;b.textContent='Copied';setTimeout(function(){{b.textContent='Copy error'}},1500)
}};
document.getElementById('__ss-err-send').onclick=function(){{
window.parent.postMessage({{type:'shipstudio:send-error-to-claude',message:msg}},'*')
}})()</script>"#,
    )
}

/// Build a self-contained error overlay (HTML/CSS/JS) for 5xx responses.
/// Forces body visible (overrides Next.js FOUC prevention), shows a styled error panel,
/// and sends a postMessage to the parent so the app can log the error.
pub fn build_error_overlay(status_code: u16, error_message: &str) -> String {
    build_overlay_panel(
        status_code,
        "The dev server returned an error",
        None,
        error_message,
        "The full log is in the dev server panel.",
    )
}

/// Explanation shown on the auth-redirect-loop interstitial. Pre-escaped HTML.
const AUTH_REDIRECT_INTRO: &str = "The dev server is running, but this page's auth middleware \
kept redirecting the preview until it gave up. Embedded previews (like any cross-site iframe) \
block third-party auth cookies, so the sign-in handshake can never finish. Clerk \
<b>development keys</b> are the most common cause &mdash; they bounce the first visit through \
<code>&lt;your-app&gt;.clerk.accounts.dev</code> to set a handshake cookie. To fix it, scope \
<code>clerkMiddleware</code> (or your auth middleware) to only the routes that need protection, \
or use a production Clerk instance. The site itself is fine &mdash; it loads normally in a \
regular browser tab, where the cookie is first-party.";

/// Build a complete standalone HTML page shown instead of forwarding an
/// auth-handshake redirect that would loop the preview iframe until WebKit
/// aborts it (issue #179). Served with a 200 status so WebKit actually renders
/// it. Includes the nav script so the parent's blank-pane watchdog sees the
/// page as alive and the Copy / Send-to-Claude buttons keep working.
pub fn build_auth_redirect_interstitial(status_code: u16, reason: &str) -> String {
    let overlay = build_overlay_panel(
        status_code,
        "This page couldn't load in the preview — it redirected too many times.",
        Some(AUTH_REDIRECT_INTRO),
        reason,
        "Open the site in a normal browser tab and it will load fine.",
    );
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Preview blocked: redirect loop</title></head><body>{overlay}{NAV_SCRIPT}</body></html>"
    )
}

/// Inject error overlay + nav script into an HTML response with a 5xx status.
pub fn inject_error_into_html(html: &[u8], status_code: u16) -> Vec<u8> {
    let body_str = String::from_utf8_lossy(html);
    let error_message = extract_error_message(&body_str);
    let overlay = build_error_overlay(status_code, &error_message);
    let injection = format!("{overlay}{NAV_SCRIPT}");
    inject_into_html(html, &injection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_non_ascii_build_error_is_cut_on_a_character() {
        // 1999 ASCII bytes, then "é" straddling byte 2000.
        let html = format!("<pre>{}é and more</pre>", "x".repeat(1999));
        let msg = extract_error_message(&html);
        assert_eq!(msg.len(), 1999);
    }

    #[test]
    fn test_inject_before_head() {
        let html = b"<html><head><title>Test</title></head><body>Hello</body></html>";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        // Both scripts land before </head>, nav first.
        assert!(result_str.contains(&format!(
            "{NAV_SCRIPT}{SELECT_SCRIPT}{COMMENTS_SCRIPT}</head>"
        )));
    }

    #[test]
    fn test_inject_before_body_fallback() {
        let html = b"<html><body>Hello</body></html>";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains(&format!(
            "{NAV_SCRIPT}{SELECT_SCRIPT}{COMMENTS_SCRIPT}</body>"
        )));
    }

    #[test]
    fn test_inject_append_fallback() {
        let html = b"<html>Hello";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.ends_with(COMMENTS_SCRIPT));
        assert!(result_str.contains("ss:select"));
    }

    #[test]
    fn select_script_supports_live_style_patch() {
        // The selection script previews a freshly-typed class (no compiled CSS yet)
        // via an injected, breakpoint-aware stylesheet keyed to a marker attribute —
        // base rules bare, variants wrapped in @media so they only show at width.
        // Guards the include_str! script content.
        assert!(SELECT_SCRIPT.contains("ss:mutate"));
        assert!(SELECT_SCRIPT.contains("d.rules"));
        assert!(SELECT_SCRIPT.contains("data-ss-sel"));
        assert!(SELECT_SCRIPT.contains("@media (min-width:"));
        assert!(SELECT_SCRIPT.contains("ss-preview"));
    }

    #[test]
    fn canvas_holds_every_frame_still_and_backgrounds_the_idle_ones() {
        // Two separate treatments, and keeping them separate is the point.
        // Holding still rides on `ss:canvas`, so EVERY frame gets it — a frame
        // here is a whole page, and one exempted frame animating forever
        // doubled the preview's idle CPU. Background-tab semantics ride on
        // `ss:passive`, so only frames nobody is working in get them.
        assert!(SELECT_SCRIPT.contains("ssHoldStill(true)"));
        assert!(SELECT_SCRIPT.contains("ss-still-style"));
        assert!(SELECT_SCRIPT.contains("animation-iteration-count:1!important"));
        assert!(SELECT_SCRIPT.contains("ss:passive'){ssBackground("));
        assert!(SELECT_SCRIPT.contains("visibilityState"));
        assert!(SELECT_SCRIPT.contains("ssRafHeld"));
        // A committed page height is never committed twice: that is the
        // feedback loop the agreement rule cannot see.
        assert!(SELECT_SCRIPT.contains("ssPageCommitted"));
        assert!(SELECT_SCRIPT.contains("ssPageLocked"));
        // ...and the ratchet, which never repeats a value at all, so the
        // visited list is blind to it. Cause and backstop both.
        assert!(SELECT_SCRIPT.contains("position:relative!important"));
        assert!(SELECT_SCRIPT.contains("ratchet"));
        // The settle observer must not be able to feed itself.
        assert!(SELECT_SCRIPT.contains("if(pin.textContent!==css)"));
    }

    #[test]
    fn scrollbar_style_lands_at_head_start_before_site_styles() {
        // The scrollbar-hiding style must come *before* the site's own <link>/<style>
        // so a site that styles its scrollbars overrides us (no hijack).
        let html =
            b"<html><head><link rel=\"stylesheet\" href=\"site.css\"></head><body>Hi</body></html>";
        let result = inject_nav_script(html);
        let s = String::from_utf8(result).unwrap();
        let style_pos = s
            .find("ss-hide-scrollbars")
            .expect("scrollbar style injected");
        let site_css_pos = s.find("site.css").expect("site css present");
        assert!(
            style_pos < site_css_pos,
            "scrollbar style must precede the site's stylesheet so the site can override it"
        );
        // And it must sit right after the opening <head>, ahead of the site link.
        assert!(s.contains("<head><style id=\"ss-hide-scrollbars\""));
        // Defensive: never use display:none or !important (that would hijack sites).
        let style = &s[style_pos..site_css_pos];
        assert!(!style.contains("display:none"));
        assert!(!style.contains("!important"));
    }

    #[test]
    fn inject_at_head_start_handles_attributed_head_and_fallbacks() {
        // <head> with attributes.
        let with_attrs =
            inject_at_head_start(b"<html><head class=\"x\"><title>T</title></head>", "S");
        assert!(String::from_utf8(with_attrs)
            .unwrap()
            .contains("<head class=\"x\">S<title>"));
        // No <head>: falls back to after <html>.
        let no_head = inject_at_head_start(b"<html><body>Hi</body></html>", "S");
        assert!(String::from_utf8(no_head)
            .unwrap()
            .starts_with("<html>S<body>"));
        // No <head> or <html>: prepends.
        let bare = inject_at_head_start(b"Hello", "S");
        assert_eq!(String::from_utf8(bare).unwrap(), "SHello");
    }

    #[test]
    fn test_extract_error_from_next_data() {
        let html = r#"<html><head></head><body><script id="__NEXT_DATA__" type="application/json">{"err":{"message":"Module not found: Can't resolve 'missing-pkg'"}}</script></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Module not found"));
    }

    #[test]
    fn test_extract_error_from_pre_tag() {
        let html = r#"<html><body><pre>Error: Cannot find module 'react'</pre></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Cannot find module 'react'"));
    }

    #[test]
    fn test_extract_error_from_h1() {
        let html = r#"<html><body><h1>Internal Server Error</h1><p>Something went wrong</p></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Internal Server Error"));
    }

    #[test]
    fn test_extract_error_from_title() {
        let html =
            r#"<html><head><title>500 Internal Server Error</title></head><body></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("500 Internal Server Error"));
    }

    #[test]
    fn test_extract_error_fallback() {
        let html = r#"<html><body></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("dev server panel"));
    }

    #[test]
    fn test_strip_html_tags() {
        assert_eq!(strip_html_tags("<b>hello</b> world"), "hello world");
        assert_eq!(strip_html_tags("no tags"), "no tags");
        assert_eq!(strip_html_tags("<a href='x'>link</a>"), "link");
    }

    #[test]
    fn test_error_overlay_contains_status() {
        let html = b"<html><head></head><body>error</body></html>";
        let result = inject_error_into_html(html, 500);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains("500"));
        assert!(result_str.contains("__ss-err-overlay"));
        assert!(result_str.contains("display:block!important"));
    }

    #[test]
    fn test_error_overlay_preserves_nav_script() {
        let html = b"<html><head></head><body>error</body></html>";
        let result = inject_error_into_html(html, 502);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains("shipstudio:navigate"));
        assert!(result_str.contains("shipstudio:error"));
    }

    #[test]
    fn test_error_message_escaping() {
        let overlay = build_error_overlay(500, "Module '<Foo>' not found & \"bar\"");
        assert!(overlay.contains("&lt;Foo&gt;"));
        assert!(overlay.contains("&amp;"));
        assert!(overlay.contains("&quot;bar&quot;"));
    }

    #[test]
    fn test_overlay_script_payload_cannot_break_out() {
        // A message containing `</script>` must not terminate the overlay's
        // script element — the HTML parser ends script data on `</script>`
        // regardless of JS string boundaries.
        let payload = "boom </script><script>alert(1)</script><!-- `${x}`";
        let overlay = build_error_overlay(500, payload);
        assert!(!overlay.contains("</script><script>alert(1)"));
        assert!(!overlay.contains("<!--"));
        // The message is embedded as a JSON string literal with `<` escaped —
        // still the exact payload after JS parsing, but inert to the HTML parser.
        assert!(overlay.contains(
            "var msg=\"boom \\u003c/script>\\u003cscript>alert(1)\\u003c/script>\\u003c!-- `${x}`\";"
        ));
        // Exactly one real script element: ours.
        assert_eq!(overlay.matches("</script>").count(), 1);
    }

    #[test]
    fn test_error_overlay_keeps_dev_server_title_and_no_intro() {
        // The generalized panel builder must not change the 5xx overlay.
        let overlay = build_error_overlay(500, "boom");
        assert!(overlay.contains("The dev server returned an error"));
        assert!(!overlay.contains(r#"<div class="__ss-err-intro">"#));
        // The app's own look: light and dark, no Claude-orange, a neutral answer.
        assert!(overlay.contains("prefers-color-scheme:dark"));
        assert!(!overlay.contains("D97757"));
        assert!(overlay.contains("Send to agent"));
        assert!(!overlay.contains("Send to Claude"));
    }

    #[test]
    fn test_auth_redirect_interstitial_contents() {
        let reason = "HTTP 307 redirect to https://foo.clerk.accounts.dev/v1/handshake";
        let page = build_auth_redirect_interstitial(307, reason);

        // Standalone document with the redirect status in the badge.
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains(r#"<span class="__ss-err-badge">307</span>"#));

        // Names the failure and the Clerk-specific cause + fixes.
        assert!(page.contains("redirected too many times"));
        assert!(page.contains("clerkMiddleware"));
        assert!(page.contains("clerk.accounts.dev"));
        assert!(page.contains("normal browser tab"));

        // Raw reason lands in the copyable monospace block.
        assert!(page.contains("__ss-err-msg"));
        assert!(page.contains("HTTP 307 redirect to https://foo.clerk.accounts.dev/v1/handshake"));

        // Copy / Send-to-Claude buttons keep working.
        assert!(page.contains("__ss-err-copy"));
        assert!(page.contains("__ss-err-send"));
        assert!(page.contains("shipstudio:copy-error"));
        assert!(page.contains("shipstudio:send-error-to-claude"));

        // The nav script rides along so the blank-pane watchdog sees the
        // interstitial as a live page (and the app can log the error).
        assert!(page.contains("shipstudio:alive"));
        assert!(page.contains("shipstudio:navigate"));
        assert!(page.contains("shipstudio:error"));
    }

    #[test]
    fn injected_scripts_contain_no_opening_head_or_html_tag() {
        // `inject_at_head_start` scans the WHOLE response for the first `<head`,
        // so a literal opening tag anywhere in an injected script — a comment
        // included — makes the proxy splice its head-start snippet into the
        // middle of that script instead of into the page.
        for (name, script) in [("NAV_SCRIPT", NAV_SCRIPT), ("SELECT_SCRIPT", SELECT_SCRIPT)] {
            assert!(
                !script.contains("<head"),
                "{name} contains a literal `<head`"
            );
            assert!(
                !script.contains("<html"),
                "{name} contains a literal `<html`"
            );
        }
    }

    #[test]
    fn nav_script_posts_alive_on_parse() {
        // Part of the blank-pane watchdog contract: every injected page proves
        // life immediately on parse, independent of navigation semantics.
        assert!(NAV_SCRIPT.contains("shipstudio:alive"));
        assert!(NAV_SCRIPT.contains("shipstudio:navigate"));
    }

    #[test]
    fn nav_script_reports_query_and_hash() {
        // The preview's URL editor round-trips `?query#hash`; a refresh rebuilds
        // the frame from what this reports, so dropping them loses the user's URL.
        assert!(NAV_SCRIPT.contains("search:location.search"));
        assert!(NAV_SCRIPT.contains("hash:location.hash"));
    }
}
