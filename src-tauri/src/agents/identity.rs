//! Who an account is signed in as, read from the engine's own files.
//!
//! Only what the engine itself wrote down; nothing is guessed. A missing
//! file, a file that isn't JSON or a field that isn't there means no email
//! (or no plan), and Settings then says only "Signed in".
//!
//! - Claude Code keeps the signed-in account in its settings file
//!   (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`) under
//!   `oauthAccount`: `emailAddress` and, when it fetched one,
//!   `planDisplayName`. An API-key login has no `oauthAccount`.
//! - Codex keeps its ChatGPT sign-in in `<CODEX_HOME>/auth.json`; the
//!   `tokens.id_token` OpenAI issued carries `email` and, under
//!   `https://api.openai.com/auth`, `chatgpt_plan_type`. Codex can also keep
//!   its credentials in the Keychain instead, and then there is nothing to
//!   read here. The token is only decoded for those two fields; it is never
//!   stored, logged or sent anywhere.
//!
//! Read on every Settings listing, so a new sign-in shows on the next one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use base64::Engine as _;
use serde_json::Value;

/// What an engine's own files say about a sign-in.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Identity {
    pub email: Option<String>,
    pub plan: Option<String>,
    /// Which account this is, as the engine's own file names it: Claude
    /// Code's `oauthAccount.accountUuid` / `organizationUuid`, Codex's
    /// token's user and ChatGPT account. Never shown; only compared, so two
    /// sign-ins of one account are known to be one (`inventory::same_as`).
    pub org: Option<String>,
    /// The organization's name, as the engine recorded it ("Northwind").
    pub org_name: Option<String>,
}

/// A non-empty string field, trimmed.
fn text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// An email as written, only when it looks like one.
fn email(v: Option<&Value>) -> Option<String> {
    text(v).filter(|s| s.contains('@') && !s.contains(char::is_whitespace))
}

/// The one part of `.claude.json` read here. The file also holds every
/// project's history (hundreds of KB): deserialized into this, the rest is
/// skipped without being built into a tree.
#[derive(serde::Deserialize)]
struct ClaudeSettings {
    #[serde(rename = "oauthAccount", default)]
    oauth_account: Option<Value>,
}

/// Claude Code's settings file (`.claude.json`) contents.
pub fn claude(raw: &str) -> Identity {
    let Ok(root) = serde_json::from_str::<ClaudeSettings>(raw) else {
        return Identity::default();
    };
    let Some(account) = root.oauth_account.filter(|a| a.is_object()) else {
        return Identity::default();
    };
    Identity {
        email: email(account.get("emailAddress")),
        plan: text(account.get("planDisplayName")),
        org: text(account.get("organizationUuid")).map(|o| format!("claude-org:{o}")),
        org_name: text(account.get("organizationName")),
    }
}

/// Codex's `auth.json` contents.
pub fn codex(raw: &str) -> Identity {
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return Identity::default();
    };
    let Some(token) = root.pointer("/tokens/id_token").and_then(Value::as_str) else {
        return Identity::default();
    };
    let Some(claims) = jwt_claims(token) else {
        return Identity::default();
    };
    let auth = claims.get("https://api.openai.com/auth");
    // One person in one ChatGPT workspace is one pool of limits: the same
    // user in a team workspace and a personal one are two.
    let org = match (
        text(auth.and_then(|a| a.get("chatgpt_account_id"))),
        text(
            auth.and_then(|a| a.get("chatgpt_user_id"))
                .or_else(|| claims.get("sub")),
        ),
    ) {
        (Some(account), Some(user)) => Some(format!("chatgpt:{account}:{user}")),
        _ => None,
    };
    Identity {
        email: email(claims.get("email")),
        plan: text(auth.and_then(|a| a.get("chatgpt_plan_type"))),
        org,
        org_name: None,
    }
}

/// The payload of a JWT, decoded but not verified: it is only read for
/// what to show, never trusted for anything.
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?.trim_end_matches('=');
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
}

/// Read `path` and parse it with `parse`; nothing when it can't be read.
///
/// The answer is kept until the file changes (its modified time or size):
/// the agents list asks once per agent on every refresh, and parsing a
/// large `.claude.json` each time was most of the app's own CPU.
pub fn read(path: Option<&Path>, parse: fn(&str) -> Identity) -> Identity {
    let Some(path) = path else {
        return Identity::default();
    };
    let Ok(meta) = std::fs::metadata(path) else {
        return Identity::default();
    };
    let stamp = meta
        .modified()
        .ok()
        .map(|at| (at, meta.len(), parse as usize));
    if let Some(stamp) = stamp {
        if let Some((kept_stamp, who)) = kept().get(path) {
            if *kept_stamp == stamp {
                return who.clone();
            }
        }
    }
    let who = std::fs::read_to_string(path)
        .map(|raw| parse(&raw))
        .unwrap_or_default();
    if let Some(stamp) = stamp {
        kept().insert(path.to_path_buf(), (stamp, who.clone()));
    }
    who
}

type Stamp = (std::time::SystemTime, u64, usize);

fn kept() -> std::sync::MutexGuard<'static, HashMap<PathBuf, (Stamp, Identity)>> {
    static KEPT: LazyLock<Mutex<HashMap<PathBuf, (Stamp, Identity)>>> =
        LazyLock::new(Default::default);
    KEPT.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &str) -> String {
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            enc.encode(r#"{"alg":"none"}"#),
            enc.encode(claims)
        )
    }

    #[test]
    fn claude_reads_the_signed_in_email_and_plan() {
        let raw = r#"{"numStartups":3,"oauthAccount":{"accountUuid":"x","emailAddress":"sam@example.com","organizationUuid":"org-1","organizationName":"Example","billingType":"stripe_subscription","planDisplayName":"Max"},"projects":{}}"#;
        assert_eq!(
            claude(raw),
            Identity {
                email: Some("sam@example.com".into()),
                plan: Some("Max".into()),
                org: Some("claude-org:org-1".into()),
                org_name: Some("Example".into()),
            }
        );
    }

    #[test]
    fn claude_without_a_sign_in_says_nothing() {
        // API-key login, signed out, or older file: no oauthAccount.
        assert_eq!(claude(r#"{"projects":{}}"#), Identity::default());
        assert_eq!(claude(r#"{"oauthAccount":null}"#), Identity::default());
        // No email, or not an email: none is invented.
        assert_eq!(
            claude(r#"{"oauthAccount":{"emailAddress":""}}"#),
            Identity::default()
        );
        assert_eq!(
            claude(r#"{"oauthAccount":{"emailAddress":"not an email"}}"#).email,
            None
        );
        // An older file with no plan name: email only, no plan.
        assert_eq!(
            claude(r#"{"oauthAccount":{"emailAddress":"sam@example.com"}}"#),
            Identity {
                email: Some("sam@example.com".into()),
                ..Identity::default()
            }
        );
        assert_eq!(claude("not json"), Identity::default());
        assert_eq!(claude(""), Identity::default());
    }

    #[test]
    fn codex_reads_its_id_token() {
        let token = jwt(
            r#"{"email":"sam@example.org","sub":"u-1","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"ws-1"}}"#,
        );
        let raw = format!(r#"{{"OPENAI_API_KEY":null,"tokens":{{"id_token":"{token}"}}}}"#);
        assert_eq!(
            codex(&raw),
            Identity {
                email: Some("sam@example.org".into()),
                plan: Some("plus".into()),
                org: Some("chatgpt:ws-1:u-1".into()),
                org_name: None,
            }
        );
    }

    #[test]
    fn codex_without_a_chatgpt_sign_in_says_nothing() {
        assert_eq!(codex(r#"{"OPENAI_API_KEY":"sk-x"}"#), Identity::default());
        assert_eq!(
            codex(r#"{"tokens":{"id_token":"garbage"}}"#),
            Identity::default()
        );
        let token = jwt(r#"{"sub":"x"}"#);
        assert_eq!(
            codex(&format!(r#"{{"tokens":{{"id_token":"{token}"}}}}"#)),
            Identity::default()
        );
        assert_eq!(codex("{"), Identity::default());
    }

    #[test]
    fn a_kept_answer_follows_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".claude.json");
        std::fs::write(
            &file,
            r#"{"oauthAccount":{"emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            read(Some(&file), claude).email.as_deref(),
            Some("a@example.com")
        );
        assert_eq!(
            read(Some(&file), claude).email.as_deref(),
            Some("a@example.com")
        );
        // Signed in as someone else: the next read says so.
        std::fs::write(
            &file,
            r#"{"oauthAccount":{"emailAddress":"bee@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            read(Some(&file), claude).email.as_deref(),
            Some("bee@example.com")
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(read(Some(&file), claude), Identity::default());
    }

    #[test]
    fn a_missing_file_is_no_identity() {
        let gone = std::env::temp_dir().join("no-such-dir-identity/.claude.json");
        assert_eq!(read(Some(&gone), claude), Identity::default());
        assert_eq!(read(None, claude), Identity::default());
    }
}
