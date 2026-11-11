//! Pages that refuse the automated window, told apart from ordinary ones.
//!
//! A browser driven over CDP tells every page `navigator.webdriver = true`
//! (docs/design/agent-browser.md, "Not getting blocked"). Some sites
//! answer that with a page of their own instead of the sign-in. We never
//! hide the flag; we recognise the page and hand the person a plain Chrome
//! window (no automation attached) for that one sign-in (`plain`).
//!
//! Pure: what a tab shows (URL, title, the page's text) in, a verdict out.

/// Why a page won't go on in the automated window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Google's "This browser or app may not be secure" / "Couldn't sign you
    /// in": its sign-in won't take an automated browser at all.
    GoogleSignin,
    /// Google Search's "unusual traffic" page.
    GoogleSearch,
}

impl Refused {
    /// What the person reads.
    pub fn reason(self) -> &'static str {
        match self {
            Refused::GoogleSignin => {
                "Google won't sign in to a browser the app is driving, so this one sign-in happens in a plain Chrome window."
            }
            Refused::GoogleSearch => {
                "Google Search refuses browsers the app drives. Agents use their engine's own web search instead."
            }
        }
    }

    /// The person can finish it in a plain window (rather than "use another way").
    pub fn needs_plain_window(self) -> bool {
        matches!(self, Refused::GoogleSignin)
    }
}

fn host_path(url: &str) -> Option<(String, String)> {
    let u = url::Url::parse(url.trim()).ok()?;
    Some((
        u.host_str()?.to_ascii_lowercase(),
        u.path().to_ascii_lowercase(),
    ))
}

/// Google's own words for a refused sign-in, in English. Apostrophes are
/// matched both ways (Google uses ’).
const GOOGLE_SIGNIN_WORDS: &[&str] = &[
    "this browser or app may not be secure",
    "couldn't sign you in",
    "couldn’t sign you in",
    "try using a different browser",
];

/// What a tab showing `url`, titled `title`, with `text` on it, refuses.
pub fn refuses(url: &str, title: &str, text: &str) -> Option<Refused> {
    let (host, path) = host_path(url)?;
    let text = text.to_ascii_lowercase();
    let title = title.to_ascii_lowercase();
    if host == "accounts.google.com" {
        if path.contains("/signin/rejected") || path.contains("/v3/signin/rejected") {
            return Some(Refused::GoogleSignin);
        }
        if GOOGLE_SIGNIN_WORDS
            .iter()
            .any(|w| text.contains(w) || title.contains(w))
        {
            return Some(Refused::GoogleSignin);
        }
    }
    let google = host == "google.com" || host.ends_with(".google.com");
    if google
        && (path.starts_with("/sorry/")
            || text.contains("our systems have detected unusual traffic"))
    {
        return Some(Refused::GoogleSearch);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_refusing_the_sign_in_is_seen() {
        assert_eq!(
            refuses(
                "https://accounts.google.com/v3/signin/rejected?continue=x",
                "Sign in - Google Accounts",
                ""
            ),
            Some(Refused::GoogleSignin)
        );
        assert_eq!(
            refuses(
                "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn",
                "Sign in - Google Accounts",
                "Couldn’t sign you in\nThis browser or app may not be secure. Learn more\nTry using a different browser."
            ),
            Some(Refused::GoogleSignin)
        );
        assert!(Refused::GoogleSignin.needs_plain_window());
    }

    #[test]
    fn an_ordinary_sign_in_page_is_not_a_refusal() {
        for (url, text) in [
            (
                "https://accounts.google.com/v3/signin/identifier",
                "Sign in\nUse your Google Account\nEmail or phone\nForgot email?",
            ),
            ("https://github.com/login", "Sign in to GitHub"),
            ("https://example.com/", "Example Domain"),
            (
                "https://www.wikipedia.org/",
                "Wikipedia The Free Encyclopedia",
            ),
        ] {
            assert_eq!(refuses(url, "", text), None, "{url}");
        }
    }

    #[test]
    fn a_lookalike_host_is_not_google() {
        assert_eq!(
            refuses(
                "https://accounts.google.com.evil.test/",
                "",
                "This browser or app may not be secure"
            ),
            None
        );
    }

    #[test]
    fn google_search_blocking_is_its_own_thing() {
        let r = refuses("https://www.google.com/sorry/index?continue=x", "", "");
        assert_eq!(r, Some(Refused::GoogleSearch));
        assert!(!Refused::GoogleSearch.needs_plain_window());
    }
}
