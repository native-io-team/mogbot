//! Secrets never leave in an address.
//!
//! Before a network request goes through without a card (a `curl` / `wget`
//! GET, `gh api`, `git fetch <url>`, WebFetch or WebSearch, the browser
//! opening a page), `autoallow` and `browser_gate` ask here whether the
//! address, its query or its headers carry something that looks like a
//! secret. If so, it asks on a card instead: a fetch that goes through on its
//! own is exactly how text an agent read could carry a key off this Mac.
//!
//! What counts ([`carries_secret`], [`header_carries_secret`]):
//! - a value the app keeps in the Keychain (an agent's secrets, a
//!   connection's tokens; `secrets::known_values`) or one in this process's
//!   environment under a secret-looking name, as written or percent-encoded;
//! - anything shaped like a credential (`ghp_…`, `github_pat_…`, `sk-…`,
//!   `xoxb-…`, `AKIA…`, a JWT, a PEM block…);
//! - a password in the address (`https://user:pass@host`), or a query
//!   parameter named like one (`token=`, `api_key=`, `sig=`…) with a value;
//! - a header named like a credential (`Authorization`, `Cookie`,
//!   `X-Api-Key`…) with a value written out.
//!
//! False positives cost one card; a miss costs a key.

/// The secret values this Mac's agents could put in an address.
pub fn known() -> Vec<String> {
    let mut out = super::secrets::known_values();
    for (name, value) in std::env::vars() {
        if secret_name(&name) && value.len() >= 8 && !value.starts_with('/') {
            out.push(value);
        }
    }
    out.retain(|v| v.chars().count() >= 8);
    out
}

/// A name a credential goes by (`GITHUB_TOKEN`, `api_key`, `X-Auth`).
pub fn secret_name(name: &str) -> bool {
    let n: String = name
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    const EXACT: &[&str] = &[
        "key",
        "sig",
        "sid",
        "pwd",
        "auth",
        "jwt",
        "bearer",
        "cookie",
        "session",
        "signature",
        "passwd",
        "password",
        "credential",
        "credentials",
        "authorization",
    ];
    const PARTS: &[&str] = &[
        "token",
        "secret",
        "apikey",
        "password",
        "passwd",
        "credential",
        "accesskey",
        "privatekey",
        "sessionid",
        "authorization",
        "cookie",
    ];
    EXACT.contains(&n.as_str())
        || PARTS.iter().any(|p| n.contains(p))
        || n.ends_with("key") && n.len() > 3 && !n.ends_with("monkey")
        || n.starts_with("auth")
        || n.ends_with("auth")
}

/// Text that holds a known secret or something shaped like one.
pub fn holds_secret(text: &str, known: &[String]) -> bool {
    if text.is_empty() {
        return false;
    }
    known.iter().any(|v| {
        !v.is_empty()
            && (text.contains(v.as_str()) || text.contains(urlencoding::encode(v).as_ref()))
    }) || token_shaped(text)
}

/// An address (or a search query) that would carry a secret off this Mac.
pub fn carries_secret(address: &str, known: &[String]) -> bool {
    if holds_secret(address, known) {
        return true;
    }
    let Ok(url) = url::Url::parse(address.trim()) else {
        return false;
    };
    if url.password().is_some_and(|p| !p.is_empty()) || token_shaped(url.username()) {
        return true;
    }
    url.query_pairs()
        .any(|(name, value)| secret_name(&name) && value.trim().chars().count() >= 6)
}

/// A request header (`Name: value`) that sends a credential.
pub fn header_carries_secret(header: &str, known: &[String]) -> bool {
    if holds_secret(header, known) {
        return true;
    }
    let (name, value) = header.split_once(':').unwrap_or((header, ""));
    secret_name(name.trim()) && !value.trim().is_empty()
}

/// Something shaped like a credential, anywhere in `text`.
pub fn token_shaped(text: &str) -> bool {
    if text.contains("-----BEGIN") {
        return true;
    }
    const PREFIXES: &[&str] = &[
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "glpat-",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxs-",
        "xoxe-",
        "xapp-",
        "sk-",
        "sk_live_",
        "sk_test_",
        "rk_live_",
        "rk_test_",
        "whsec_",
        "npm_",
        "pypi-",
        "shpat_",
        "shpss_",
        "shpca_",
        "hf_",
        "dop_v1_",
        "AKIA",
        "ASIA",
        "AIza",
        "ya29.",
    ];
    let runs = text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')));
    for run in runs {
        for p in PREFIXES {
            if let Some(rest) = run.strip_prefix(p) {
                let body = rest.chars().filter(|c| c.is_ascii_alphanumeric()).count();
                if body >= 16 {
                    return true;
                }
            }
        }
        // A JWT: three base64url parts, the first a JSON header.
        let parts: Vec<&str> = run.split('.').collect();
        if parts.len() == 3 && parts[0].starts_with("eyJ") && parts.iter().all(|p| p.len() >= 10) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &str = "fictional-saved-value-123";

    fn known() -> Vec<String> {
        vec![KNOWN.to_string()]
    }

    #[test]
    fn ordinary_addresses_carry_nothing() {
        for url in [
            "https://example.test/",
            "https://example.test/docs/page?id=42&lang=en",
            "https://api.example.test/repos/FictionalOrg/site/pulls?state=open&per_page=50",
            "https://docs.example.test/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
            "https://example.test/search?q=how+to+bake+bread",
            "fictional payroll rates 2026",
        ] {
            assert!(!carries_secret(url, &known()), "{url}");
        }
    }

    #[test]
    fn secrets_in_an_address_are_caught() {
        let encoded = format!(
            "https://collect.example.test/?d={}",
            urlencoding::encode(&format!("{KNOWN} x"))
        );
        for url in [
            format!("https://collect.example.test/?d={KNOWN}"),
            format!("https://collect.example.test/{KNOWN}/x"),
            encoded,
            "https://collect.example.test/?x=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123".into(),
            "https://collect.example.test/?x=sk-fictionalAbCdEf0123456789xyz".into(),
            "https://collect.example.test/xoxb-1234567890-ABCDEFGHIJKLMNOP".into(),
            "https://collect.example.test/?access_token=abcdef123456".into(),
            "https://collect.example.test/?api_key=abcdef123456".into(),
            "https://collect.example.test/?sig=abcdef123456".into(),
            "https://user:hunter2-fictional@collect.example.test/".into(),
            "https://collect.example.test/?t=eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4".into(),
            "https://collect.example.test/?k=AKIAABCDEFGHIJKLMNOP".into(),
        ] {
            assert!(carries_secret(&url, &known()), "{url}");
        }
    }

    #[test]
    fn credential_headers_are_caught() {
        for h in [
            "Authorization: Bearer abc",
            "authorization: token x",
            "Cookie: session=1",
            "X-Api-Key: 1234",
            "X-Fictional-Token: abc",
            &format!("X-Note: {KNOWN}"),
        ] {
            assert!(header_carries_secret(h, &known()), "{h}");
        }
        for h in [
            "Accept: application/json",
            "User-Agent: fictional/1.0",
            "Accept-Language: en",
            "X-GitHub-Api-Version: 2022-11-28",
        ] {
            assert!(!header_carries_secret(h, &known()), "{h}");
        }
    }

    #[test]
    fn names_that_look_like_credentials() {
        for n in [
            "GITHUB_TOKEN",
            "api_key",
            "STRIPE_SECRET_KEY",
            "X-Auth",
            "password",
        ] {
            assert!(secret_name(n), "{n}");
        }
        for n in ["PATH", "LANG", "q", "id", "monkey", "page", "lang"] {
            assert!(!secret_name(n), "{n}");
        }
    }
}
