//! "When an email arrives…" and "When a text arrives…": two "When…" sources
//! read from this Mac's own Mail and Messages, with no account to connect
//! and nothing reachable from outside.
//!
//! - **Mail**: Mail's own index of what it has downloaded
//!   (`~/Library/Mail/V*/MailData/Envelope Index`), read-only through
//!   `sqlite3`: the newest messages in any account's inbox, optionally from
//!   a sender (part of the address or name) and with some words (in the
//!   subject or Mail's preview of the body).
//! - **Messages**: `~/Library/Messages/chat.db`, read-only, as the Messages
//!   tools read it (`mac_apps_os`): the newest iMessages and SMS the user
//!   received (not sent, not reactions), optionally from one phone number
//!   or email.
//!
//! Both are free (no model call) and polled like a folder; `watch` does the
//! rest: the first check is a baseline, nothing fires twice (each message is
//! remembered by an id that survives Mail rebuilding its index), one firing
//! at a time, failures back off and pause it. Both folders are behind
//! **Full Disk Access**, which no prompt can give: [`access`] says whether
//! it's on, in words naming the switch, and the composers show that with a
//! button to the pane and check again until it is.
//!
//! Every message is outside text: it reaches the agent only inside the
//! wake's `<external_items>` envelope, on a turn answering outside text
//! (`runner::enqueue_from_outside_in`), which can't change the team or its
//! own memory without a card and whose sends and replies always ask
//! (`independence::for_turn`, `mac_apps::step`). Nothing here sends.
//!
//! Tests never touch the user's real Mail or Messages: the readers take the
//! database's path, and the tests build their own.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::watch::Event;

/// The newest messages read per check. A check every few minutes never
/// sees this many arrive in between; the seen list keeps 300.
pub const WINDOW: u32 = 100;
/// A sender or words, at most.
pub const MAX_FILTER_CHARS: usize = 200;
/// The pane Full Disk Access is switched on in.
pub const FULL_DISK_ACCESS_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const SQLITE_TIMEOUT_SECS: u64 = 30;

/// Which of this Mac's apps a source reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacApp {
    Mail,
    Messages,
}

impl MacApp {
    fn title(self) -> &'static str {
        match self {
            MacApp::Mail => "Mail",
            MacApp::Messages => "Messages",
        }
    }
}

/// Whether the app can read it now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessState {
    Ok,
    /// Full Disk Access is off for this app.
    FullDiskAccess,
    /// The app has never been set up on this Mac (no mail account, Messages unused).
    NotSetUp,
    /// Not a Mac.
    Unsupported,
}

/// [`AccessState`] in the composer's words, with the pane to open when there's one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub state: AccessState,
    /// What's wrong and what to do, in one line; absent when it's fine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<String>,
    /// The System Settings pane that fixes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<String>,
}

/// The words for `state` in `app`. Pure.
pub fn access_of(app: MacApp, state: AccessState) -> Access {
    let (words, settings) = match state {
        AccessState::Ok => (None, None),
        AccessState::FullDiskAccess => (
            Some(full_disk_access_words(app)),
            Some(FULL_DISK_ACCESS_PANE.to_string()),
        ),
        AccessState::NotSetUp => (
            Some(match app {
                MacApp::Mail => {
                    "Mail isn't set up on this Mac: add an account in Mail first.".to_string()
                }
                MacApp::Messages => {
                    "Messages hasn't been used on this Mac: sign in to Messages first.".to_string()
                }
            }),
            None,
        ),
        AccessState::Unsupported => (
            Some(format!("{} can only be read on a Mac.", app.title())),
            None,
        ),
    };
    Access {
        state,
        words,
        settings,
    }
}

/// Which permission, and the exact switch. Pure.
pub fn full_disk_access_words(app: MacApp) -> String {
    format!(
        "Reading {} needs Full Disk Access: System Settings → Privacy & Security → Full Disk Access, then turn on {}.",
        app.title(),
        crate::brand::NAME
    )
}

/// Mail's index under `home`: the newest `Library/Mail/V<n>` that has one.
pub fn mail_index_in(home: &Path) -> Option<PathBuf> {
    let mail = home.join("Library/Mail");
    let mut versions: Vec<(u32, PathBuf)> = std::fs::read_dir(&mail)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n: u32 = name.strip_prefix('V')?.parse().ok()?;
            let index = e.path().join("MailData/Envelope Index");
            index.is_file().then_some((n, index))
        })
        .collect();
    versions.sort_by_key(|(n, _)| *n);
    versions.pop().map(|(_, p)| p)
}

/// Whether `app`'s data under `home` can be read. A folder macOS keeps
/// behind Full Disk Access can't even be listed. Reads only the folder.
pub fn access_in(app: MacApp, home: &Path) -> AccessState {
    let folder = home.join(match app {
        MacApp::Mail => "Library/Mail",
        MacApp::Messages => "Library/Messages",
    });
    match std::fs::read_dir(&folder) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AccessState::NotSetUp,
        Err(_) => AccessState::FullDiskAccess,
        Ok(_) => {
            let there = match app {
                MacApp::Mail => mail_index_in(home).is_some(),
                MacApp::Messages => folder.join("chat.db").is_file(),
            };
            if there {
                AccessState::Ok
            } else {
                AccessState::NotSetUp
            }
        }
    }
}

/// Whether this app can read `app` on this Mac now.
pub fn access(app: MacApp) -> Access {
    if !cfg!(target_os = "macos") {
        return access_of(app, AccessState::Unsupported);
    }
    let state = match dirs::home_dir() {
        Some(home) => access_in(app, &home),
        None => AccessState::NotSetUp,
    };
    access_of(app, state)
}

/* ------------------------------------------------------------ filters */

fn fold(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// A text's sender is `from`: the same email, or the same phone number
/// however it's written ("+1 (555) 123-4567" is "5551234567"), compared on
/// its last ten digits. Pure.
pub fn same_handle(sender: &str, from: &str) -> bool {
    let (sender, from) = (sender.trim(), from.trim());
    if from.contains('@') || sender.contains('@') {
        return sender.eq_ignore_ascii_case(from);
    }
    let (a, b) = (digits(sender), digits(from));
    if a.len() < 5 || b.len() < 5 {
        return false;
    }
    let tail = |d: &str| d[d.len().saturating_sub(10)..].to_string();
    tail(&a) == tail(&b)
}

/// A mail's sender matches `from`: part of its address or name. Pure.
pub fn mail_from_matches(address: &str, name: &str, from: &str) -> bool {
    let from = fold(from);
    from.is_empty() || fold(address).contains(&from) || fold(name).contains(&from)
}

/// A mail has `words` in its subject or preview. Pure.
pub fn mail_words_match(subject: &str, summary: &str, words: &str) -> bool {
    let words = fold(words);
    words.is_empty() || fold(subject).contains(&words) || fold(summary).contains(&words)
}

/* ------------------------------------------------------------ Mail */

/// The newest messages in every account's inbox, newest first. `summary`:
/// with Mail's preview of each (an older index has no such table). Pure.
pub fn mail_sql(summary: bool) -> String {
    let (col, join) = if summary {
        (
            ", su.summary AS summary",
            " LEFT JOIN summaries su ON su.ROWID = m.summary",
        )
    } else {
        ("", "")
    };
    format!(
        "SELECT a.address AS address, a.comment AS name, s.subject AS subject, \
         m.date_received AS date{col} \
         FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox \
         LEFT JOIN addresses a ON a.ROWID = m.sender \
         LEFT JOIN subjects s ON s.ROWID = m.subject{join} \
         WHERE m.deleted = 0 AND (lower(mb.url) LIKE '%/inbox' OR lower(mb.url) LIKE '%/inbox/') \
         ORDER BY m.date_received DESC LIMIT {WINDOW};"
    )
}

fn str_of<'a>(r: &'a Value, k: &str) -> &'a str {
    r.get(k).and_then(Value::as_str).unwrap_or("").trim()
}

fn short(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    text.chars()
        .take(max - 1)
        .collect::<String>()
        .trim_end()
        .to_string()
        + "…"
}

fn hash_id(prefix: &str, parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(parts.join("\n"));
    let hex: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    format!("{prefix}:{hex}")
}

/// `sqlite3 -json` rows of [`mail_sql`] as events, kept when they match
/// `from` and `words`. Each is known by its sender, subject and time, so
/// Mail rebuilding its index (new row ids) doesn't fire them again. Pure.
pub fn mail_events(rows: &Value, from: &str, words: &str) -> Vec<Event> {
    rows.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let (address, name) = (str_of(r, "address"), str_of(r, "name"));
            let (subject, summary) = (str_of(r, "subject"), str_of(r, "summary"));
            if !mail_from_matches(address, name, from) || !mail_words_match(subject, summary, words)
            {
                return None;
            }
            let date = r.get("date").and_then(Value::as_i64).unwrap_or(0);
            let who = match (name.is_empty(), address.is_empty()) {
                (false, false) => format!("{name} <{address}>"),
                (true, false) => address.to_string(),
                (false, true) => name.to_string(),
                (true, true) => "an unknown sender".to_string(),
            };
            let mut detail = format!("From {who}");
            if !summary.is_empty() {
                detail.push_str(" · ");
                detail.push_str(&short(summary, 400));
            }
            Some(Event {
                id: hash_id(
                    "mail",
                    &[&address.to_lowercase(), subject, &date.to_string()],
                ),
                title: if subject.is_empty() {
                    "(no subject)".to_string()
                } else {
                    short(subject, 200)
                },
                detail: Some(detail),
                url: None,
            })
        })
        .collect()
}

/* ------------------------------------------------------------ Messages */

/// The newest messages the user received, newest first: not their own,
/// not reactions (tapbacks). Pure.
pub fn texts_sql() -> String {
    format!(
        "SELECT m.guid AS guid, m.text AS text, hex(m.attributedBody) AS body, m.date AS date, \
         h.id AS sender, c.display_name AS chat_name \
         FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id \
         LEFT JOIN chat_message_join j ON j.message_id = m.ROWID \
         LEFT JOIN chat c ON c.ROWID = j.chat_id \
         WHERE m.is_from_me = 0 AND COALESCE(m.associated_message_type, 0) = 0 \
         ORDER BY m.date DESC LIMIT {WINDOW};"
    )
}

/// `sqlite3 -json` rows of [`texts_sql`] as events, kept when they're from
/// `from` (any sender when empty). Known by Messages' own id. Pure.
pub fn text_events(rows: &Value, from: &str) -> Vec<Event> {
    let mut out: Vec<Event> = Vec::new();
    for r in rows.as_array().map(Vec::as_slice).unwrap_or_default() {
        let guid = str_of(r, "guid");
        let sender = str_of(r, "sender");
        if guid.is_empty() || (!from.trim().is_empty() && !same_handle(sender, from)) {
            continue;
        }
        let id = format!("text:{guid}");
        // A message in two chats is joined twice: once is enough.
        if out.iter().any(|e| e.id == id) {
            continue;
        }
        let text = Some(str_of(r, "text"))
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .or_else(|| super::mac_apps::os::attributed_text(str_of(r, "body")));
        let who = if sender.is_empty() {
            "an unknown sender".to_string()
        } else {
            super::mac_apps::display_handle(sender)
        };
        let chat = str_of(r, "chat_name");
        let title = if chat.is_empty() {
            format!("Text from {who}")
        } else {
            format!("Text from {who} in “{}”", short(chat, 80))
        };
        out.push(Event {
            id,
            title,
            detail: Some(match text {
                Some(t) => short(&t, 500),
                None => "No text in it (an attachment, a sticker or similar).".to_string(),
            }),
            url: None,
        });
    }
    out
}

/* ------------------------------------------------------------ reading */

/// Why `sqlite3` couldn't read: Full Disk Access, or its own first line. Pure.
pub fn sqlite_error(app: MacApp, stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("authorization denied")
        || lower.contains("unable to open")
        || lower.contains("operation not permitted")
    {
        return full_disk_access_words(app);
    }
    let first = stderr.lines().next().unwrap_or("").trim();
    format!(
        "Couldn't read {}: {}",
        app.title(),
        if first.is_empty() {
            "sqlite3 failed"
        } else {
            first
        }
    )
}

/// Run `sql` read-only on `db`; its rows (`[]` for none).
async fn query(app: MacApp, db: &Path, sql: &str) -> Result<Value, String> {
    let mut cmd = crate::utils::create_command("/usr/bin/sqlite3");
    cmd.arg("-readonly").arg("-json").arg(db).arg(sql);
    let label = format!("sqlite3 ({})", app.title());
    let out = crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        label,
        SQLITE_TIMEOUT_SECS,
    )
    .await
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(sqlite_error(app, &String::from_utf8_lossy(&out.stderr)));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Couldn't read {}: {e}", app.title()))
}

/// The newest inbox mail in the index at `db`, as events matching `from` and `words`.
pub async fn read_mail_at(db: &Path, from: &str, words: &str) -> Result<Vec<Event>, String> {
    let rows = match query(MacApp::Mail, db, &mail_sql(true)).await {
        // An index without previews: read it without them.
        Err(e) if e.contains("no such") => query(MacApp::Mail, db, &mail_sql(false)).await?,
        other => other?,
    };
    Ok(mail_events(&rows, from, words))
}

/// The newest texts received in the database at `db`, as events from `from`.
pub async fn read_texts_at(db: &Path, from: &str) -> Result<Vec<Event>, String> {
    let rows = query(MacApp::Messages, db, &texts_sql()).await?;
    Ok(text_events(&rows, from))
}

/// The failure for an app that can't be read now, in its words.
fn unreadable(app: MacApp, state: AccessState) -> String {
    access_of(app, state)
        .words
        .unwrap_or_else(|| format!("Couldn't read {}.", app.title()))
}

/// This Mac's Mail, for a check.
pub async fn read_mail(from: &str, words: &str) -> Result<Vec<Event>, String> {
    let a = access(MacApp::Mail);
    if a.state != AccessState::Ok {
        return Err(unreadable(MacApp::Mail, a.state));
    }
    let home = dirs::home_dir().ok_or("No home folder.")?;
    let db = mail_index_in(&home).ok_or_else(|| unreadable(MacApp::Mail, AccessState::NotSetUp))?;
    read_mail_at(&db, from, words).await
}

/// This Mac's Messages, for a check.
pub async fn read_texts(from: &str) -> Result<Vec<Event>, String> {
    let a = access(MacApp::Messages);
    if a.state != AccessState::Ok {
        return Err(unreadable(MacApp::Messages, a.state));
    }
    let db = super::mac_apps::os::chat_db().ok_or("No home folder.")?;
    read_texts_at(&db, from).await
}

/// Both apps' access, for the composers (`watch_options`, the desk command).
#[derive(Debug, Clone, Serialize)]
pub struct MacAccess {
    pub mail: Access,
    pub messages: Access,
}

pub fn mac_access() -> MacAccess {
    MacAccess {
        mail: access(MacApp::Mail),
        messages: access(MacApp::Messages),
    }
}

#[cfg(test)]
#[path = "watch_mac_tests.rs"]
mod tests;
