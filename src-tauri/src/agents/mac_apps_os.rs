//! The operating-system side of this Mac's apps (`mac_apps`): one trait,
//! [`MacOs`], so everything above it is tested with a fake and no test ever
//! touches the user's real Calendar, Contacts, Notes or Messages.
//!
//! The real implementation ([`System`]) runs in a child process, never in
//! the app's own:
//!
//! - **Calendar, Reminders, Contacts**: JavaScript for Automation through
//!   `osascript`, calling EventKit and the Contacts framework directly (the
//!   ObjC bridge), so recurring events are expanded and the apps themselves
//!   aren't launched. macOS attributes the child's request to this app (its
//!   responsible process), so the prompt and the switch are this app's, under
//!   System Settings → Privacy & Security → Calendars / Reminders / Contacts.
//! - **Notes, sending a message**: the apps' own scripting (Apple Events), the
//!   same way the Spotify widget works: the Automation prompt, once per app.
//! - **Reading messages**: `~/Library/Messages/chat.db`, read-only through
//!   `sqlite3`. macOS keeps that file behind Full Disk Access, which no prompt
//!   can give: the user turns it on in System Settings, and the line says so.
//!
//! A script never has the user's words spliced into it: its input is one
//! JSON object in an environment variable ([`ARGS_ENV`]), read by the
//! script, and its answer is one JSON object on stdout. A crash, a hang or an
//! exception in a framework stays in the child, which is killed at its
//! timeout.

use async_trait::async_trait;
use serde_json::Value;

use super::App;

/// The environment variable a script reads its input from.
pub const ARGS_ENV: &str = "MAC_APP_ARGS";

/// What a tool asks the OS to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    CalendarEvents,
    CalendarCreate,
    RemindersList,
    RemindersAdd,
    RemindersComplete,
    ContactsSearch,
    NotesSearch,
    NotesRead,
    NotesCreate,
    MessagesRecent,
    MessagesSearch,
    MessagesSend,
}

impl OpKind {
    pub fn app(self) -> App {
        use OpKind::*;
        match self {
            CalendarEvents | CalendarCreate => App::Calendar,
            RemindersList | RemindersAdd | RemindersComplete => App::Reminders,
            ContactsSearch => App::Contacts,
            NotesSearch | NotesRead | NotesCreate => App::Notes,
            MessagesRecent | MessagesSearch | MessagesSend => App::Messages,
        }
    }
}

/// One call: what, and its checked input (the shape each script reads).
#[derive(Debug, Clone, PartialEq)]
pub struct Op {
    pub kind: OpKind,
    pub args: Value,
}

/// Why the OS didn't do it.
#[derive(Debug, Clone, PartialEq)]
pub enum OsError {
    /// macOS hasn't asked the user yet: ask (`request_access`), then retry.
    NotAsked,
    /// The user (or an earlier answer) said no in System Settings.
    Denied,
    /// A profile or Screen Time keeps it off; the user can't change it here.
    Restricted,
    /// Messages' history is behind Full Disk Access.
    FullDiskAccess,
    /// Something named doesn't exist (a calendar, a list, a note).
    NotFound(String),
    Failed(String),
    /// Not a Mac.
    Unsupported,
}

#[async_trait]
pub trait MacOs: Send + Sync {
    /// Do it. `Err(NotAsked)` when macOS hasn't asked the user about the app.
    async fn run(&self, op: &Op) -> Result<Value, OsError>;
    /// Show macOS's own permission prompt for `app` and wait for the answer.
    /// `Ok` when it was allowed (or there's nothing to ask ahead of use).
    async fn request_access(&self, app: App) -> Result<(), OsError>;
}

/// The real thing, on this Mac.
pub struct System;

/// The OS layer every call uses.
pub fn system() -> &'static dyn MacOs {
    &System
}

/// A script's answer, `{"ok": true, "data": …}` or `{"ok": false, "error": …}`,
/// as a result. Errors the scripts raise on purpose start with a marker:
/// `ACCESS:<status>`, `NOTFOUND:<what>`, `FAILED:<why>`. An Apple Event the
/// user hasn't allowed fails with -1743. Pure.
pub fn parse_answer(stdout: &str, stderr: &str) -> Result<Value, OsError> {
    let v: Value = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(_) => return Err(classify(stderr.trim())),
    };
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(v.get("data").cloned().unwrap_or(Value::Null));
    }
    let error = v.get("error").and_then(Value::as_str).unwrap_or("");
    Err(classify(error))
}

fn classify(error: &str) -> OsError {
    let marked = |m: &str| {
        error
            .find(m)
            .map(|i| error[i + m.len()..].trim().to_string())
    };
    if let Some(status) = marked("ACCESS:") {
        return match status.split_whitespace().next().unwrap_or("") {
            "not_asked" => OsError::NotAsked,
            "restricted" => OsError::Restricted,
            _ => OsError::Denied,
        };
    }
    if let Some(what) = marked("NOTFOUND:") {
        return OsError::NotFound(what);
    }
    if error.contains("-1743") || error.contains("Not authorized to send Apple events") {
        return OsError::Denied;
    }
    if let Some(why) = marked("FAILED:") {
        return OsError::Failed(why);
    }
    let first = error.lines().next().unwrap_or("").trim();
    OsError::Failed(if first.is_empty() {
        "no answer".to_string()
    } else {
        first.chars().take(300).collect()
    })
}

/* ------------------------------------------------------------ scripts */

/// Shared by every script: its input, ObjC values as JSON, a run loop to
/// wait on a framework's callback, and the one answer.
const PRELUDE: &str = r#"
ObjC.import('Foundation');
function input() {
  const raw = $.NSProcessInfo.processInfo.environment.objectForKey('MAC_APP_ARGS');
  return raw.isNil() ? {} : JSON.parse(ObjC.unwrap(raw));
}
function str(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try { if (v.isNil()) return null; } catch (e) {}
  const u = ObjC.unwrap(v);
  return (u === undefined || u === null) ? null : String(u);
}
function ms(d) {
  if (!d) return null;
  try { if (d.isNil()) return null; } catch (e) { return null; }
  return Math.round(d.timeIntervalSince1970 * 1000);
}
function nsdate(n) { return $.NSDate.dateWithTimeIntervalSince1970(n / 1000); }
function spin(done, secs) {
  const end = Date.now() + secs * 1000;
  while (!done() && Date.now() < end) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
}
function run() {
  try { return JSON.stringify({ ok: true, data: main(input()) }); }
  catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
}
"#;

/// EventKit: 0 events, 1 reminders. Status 3 is full access, 4 add-only.
const EVENTKIT: &str = r#"
ObjC.import('EventKit');
function access(type) {
  const s = $.EKEventStore.authorizationStatusForEntityType(type);
  if (s === 0) throw new Error('ACCESS:not_asked');
  if (s === 1) throw new Error('ACCESS:restricted');
  if (s === 2 || s === 4) throw new Error('ACCESS:denied');
}
function calendarsNamed(store, type, name) {
  const all = store.calendarsForEntityType(type);
  const found = $.NSMutableArray.array;
  for (let i = 0; i < all.count; i++) {
    const c = all.objectAtIndex(i);
    if ((str(c.title) || '').toLowerCase() === name.toLowerCase()) found.addObject(c);
  }
  return found;
}
"#;

const CALENDAR_EVENTS: &str = r#"
function main(a) {
  access(0);
  const store = $.EKEventStore.alloc.init;
  let cals = null;
  if (a.calendar) {
    cals = calendarsNamed(store, 0, a.calendar);
    if (cals.count === 0) throw new Error('NOTFOUND:calendar');
  }
  const pred = store.predicateForEventsWithStartDateEndDateCalendars(nsdate(a.from), nsdate(a.to), cals);
  const evs = store.eventsMatchingPredicate(pred);
  const q = (a.query || '').toLowerCase();
  const list = [];
  for (let i = 0; i < evs.count; i++) {
    const e = evs.objectAtIndex(i);
    const title = str(e.title) || '';
    const location = str(e.location);
    const notes = str(e.notes);
    if (q && !(title + ' ' + (location || '') + ' ' + (notes || '')).toLowerCase().includes(q)) continue;
    list.push({
      id: str(e.eventIdentifier), title: title, start: ms(e.startDate), end: ms(e.endDate),
      allDay: !!e.isAllDay, calendar: str(e.calendar.title), location: location,
      notes: notes ? notes.slice(0, 500) : null
    });
  }
  list.sort(function (x, y) { return x.start - y.start; });
  return list.slice(0, a.limit);
}
"#;

const CALENDAR_CREATE: &str = r#"
function main(a) {
  access(0);
  const store = $.EKEventStore.alloc.init;
  let cal = store.defaultCalendarForNewEvents;
  if (a.calendar) {
    const c = calendarsNamed(store, 0, a.calendar);
    if (c.count === 0) throw new Error('NOTFOUND:calendar');
    cal = c.objectAtIndex(0);
  }
  if (!cal || cal.isNil()) throw new Error('NOTFOUND:calendar');
  const e = $.EKEvent.eventWithEventStore(store);
  e.setTitle(a.title);
  e.setStartDate(nsdate(a.start));
  e.setEndDate(nsdate(a.end));
  e.setAllDay(!!a.allDay);
  e.setCalendar(cal);
  if (a.location) e.setLocation(a.location);
  if (a.notes) e.setNotes(a.notes);
  const err = Ref();
  if (!store.saveEventSpanCommitError(e, 0, true, err)) {
    throw new Error('FAILED:' + (str(err[0] && err[0].localizedDescription) || 'not saved'));
  }
  return { id: str(e.eventIdentifier), calendar: str(cal.title) };
}
"#;

const REMINDERS_LIST: &str = r#"
function main(a) {
  access(1);
  const store = $.EKEventStore.alloc.init;
  let cals = null;
  if (a.list) {
    cals = calendarsNamed(store, 1, a.list);
    if (cals.count === 0) throw new Error('NOTFOUND:list');
  }
  const pred = a.includeCompleted
    ? store.predicateForRemindersInCalendars(cals)
    : store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars(null, null, cals);
  let got = null;
  store.fetchRemindersMatchingPredicateCompletion(pred, function (rs) { got = rs; });
  spin(function () { return got !== null; }, 20);
  if (got === null) throw new Error('FAILED:Reminders did not answer');
  const list = [];
  const n = got.isNil() ? 0 : got.count;
  for (let i = 0; i < n; i++) {
    const r = got.objectAtIndex(i);
    const dc = r.dueDateComponents;
    let due = null;
    if (dc && !dc.isNil()) due = ms($.NSCalendar.currentCalendar.dateFromComponents(dc));
    const notes = str(r.notes);
    list.push({
      id: str(r.calendarItemIdentifier), title: str(r.title) || '', due: due,
      list: str(r.calendar.title), completed: !!r.isCompleted,
      notes: notes ? notes.slice(0, 300) : null
    });
  }
  list.sort(function (x, y) { return (x.due || 8e15) - (y.due || 8e15); });
  return list.slice(0, a.limit);
}
"#;

const REMINDERS_ADD: &str = r#"
function main(a) {
  access(1);
  const store = $.EKEventStore.alloc.init;
  let cal = store.defaultCalendarForNewReminders;
  if (a.list) {
    const c = calendarsNamed(store, 1, a.list);
    if (c.count === 0) throw new Error('NOTFOUND:list');
    cal = c.objectAtIndex(0);
  }
  if (!cal || cal.isNil()) throw new Error('NOTFOUND:list');
  const r = $.EKReminder.reminderWithEventStore(store);
  r.setTitle(a.title);
  r.setCalendar(cal);
  if (a.notes) r.setNotes(a.notes);
  if (a.due) {
    // Year, month, day (4 | 8 | 16), plus hour and minute (32 | 64) when timed.
    const units = a.dueHasTime ? 124 : 28;
    r.setDueDateComponents($.NSCalendar.currentCalendar.componentsFromDate(units, nsdate(a.due)));
  }
  const err = Ref();
  if (!store.saveReminderCommitError(r, true, err)) {
    throw new Error('FAILED:' + (str(err[0] && err[0].localizedDescription) || 'not saved'));
  }
  return { id: str(r.calendarItemIdentifier), list: str(cal.title) };
}
"#;

const REMINDERS_COMPLETE: &str = r#"
function main(a) {
  access(1);
  const store = $.EKEventStore.alloc.init;
  const r = store.calendarItemWithIdentifier(a.id);
  if (!r || r.isNil() || !r.isKindOfClass($.EKReminder)) throw new Error('NOTFOUND:reminder');
  r.setCompleted(true);
  const err = Ref();
  if (!store.saveReminderCommitError(r, true, err)) {
    throw new Error('FAILED:' + (str(err[0] && err[0].localizedDescription) || 'not saved'));
  }
  return { id: a.id, title: str(r.title) };
}
"#;

const CONTACTS_SEARCH: &str = r#"
ObjC.import('Contacts');
function main(a) {
  const s = $.CNContactStore.authorizationStatusForEntityType(0);
  if (s === 0) throw new Error('ACCESS:not_asked');
  if (s === 1) throw new Error('ACCESS:restricted');
  if (s === 2) throw new Error('ACCESS:denied');
  const cs = $.CNContactStore.alloc.init;
  const keys = $(['identifier', 'givenName', 'familyName', 'organizationName', 'jobTitle', 'emailAddresses', 'phoneNumbers']);
  const q = a.query;
  let pred;
  if (q.indexOf('@') >= 0) pred = $.CNContact.predicateForContactsMatchingEmailAddress(q);
  else if (/^[+\d][\d\s().-]{4,}$/.test(q)) pred = $.CNContact.predicateForContactsMatchingPhoneNumber($.CNPhoneNumber.phoneNumberWithStringValue(q));
  else pred = $.CNContact.predicateForContactsMatchingName(q);
  const err = Ref();
  const found = cs.unifiedContactsMatchingPredicateKeysToFetchError(pred, keys, err);
  if (!found || found.isNil()) throw new Error('FAILED:' + (str(err[0] && err[0].localizedDescription) || 'no answer'));
  const list = [];
  for (let i = 0; i < found.count && list.length < a.limit; i++) {
    const c = found.objectAtIndex(i);
    const emails = [];
    for (let j = 0; j < c.emailAddresses.count; j++) emails.push(str(c.emailAddresses.objectAtIndex(j).value));
    const phones = [];
    for (let j = 0; j < c.phoneNumbers.count; j++) phones.push(str(c.phoneNumbers.objectAtIndex(j).value.stringValue));
    list.push({
      id: str(c.identifier),
      name: [str(c.givenName), str(c.familyName)].filter(function (x) { return x; }).join(' '),
      organization: str(c.organizationName), jobTitle: str(c.jobTitle),
      emails: emails.filter(function (x) { return x; }), phones: phones.filter(function (x) { return x; })
    });
  }
  return list;
}
"#;

/// Notes: the app's own scripting (Automation).
const NOTES_SEARCH: &str = r#"
function main(a) {
  const Notes = Application('Notes');
  const q = a.query;
  const found = Notes.notes.whose({ _or: [{ name: { _contains: q } }, { plaintext: { _contains: q } }] });
  const ids = found.id();
  const list = [];
  for (let i = 0; i < ids.length && list.length < a.limit; i++) {
    const n = Notes.notes.byId(ids[i]);
    const text = n.plaintext() || '';
    let folder = null;
    try { folder = n.container().name(); } catch (e) {}
    list.push({
      id: ids[i], name: n.name(), folder: folder,
      modified: n.modificationDate().getTime(), snippet: text.slice(0, 240)
    });
  }
  return list;
}
"#;

const NOTES_READ: &str = r#"
function main(a) {
  const Notes = Application('Notes');
  const n = Notes.notes.byId(a.id);
  let name;
  try { name = n.name(); } catch (e) { throw new Error('NOTFOUND:note'); }
  return { id: a.id, name: name, modified: n.modificationDate().getTime(), body: n.plaintext() || '' };
}
"#;

const NOTES_CREATE: &str = r#"
function main(a) {
  const Notes = Application('Notes');
  let folder;
  if (a.folder) {
    const f = Notes.folders.whose({ name: a.folder });
    if (f.length === 0) throw new Error('NOTFOUND:folder');
    folder = f[0];
  } else {
    folder = Notes.defaultAccount.defaultFolder;
  }
  const n = Notes.Note({ body: a.html });
  folder.notes.push(n);
  return { id: n.id(), name: n.name() };
}
"#;

/// Messages: sending is the app's own scripting (Automation). A chat by its
/// id (from `messages_recent`), else a person by phone number or email on
/// iMessage. Recent macOS calls the services "accounts"; older, "services".
const MESSAGES_SEND: &str = r#"
function main(a) {
  const M = Application('Messages');
  let to;
  if (a.chat) {
    to = M.chats.byId(a.chat);
  } else {
    let acct;
    try { acct = M.accounts.whose({ serviceType: 'iMessage' })[0]; acct.id(); }
    catch (e) { acct = M.services.whose({ serviceType: 'iMessage' })[0]; }
    to = acct.participants.byName(a.to);
  }
  M.send(a.text, { to: to });
  return { sent: true };
}
"#;

/// The macOS permission prompt for an EventKit or Contacts app, waiting
/// (here, in the child) until the user answers or two minutes pass.
const REQUEST_EVENTKIT: &str = r#"
function main(a) {
  const type = a.type;
  const store = $.EKEventStore.alloc.init;
  let answered = false;
  const done = function (granted, error) { answered = true; };
  if (type === 0 && store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) {
    store.requestFullAccessToEventsWithCompletion(done);
  } else if (type === 1 && store.respondsToSelector('requestFullAccessToRemindersWithCompletion:')) {
    store.requestFullAccessToRemindersWithCompletion(done);
  } else {
    store.requestAccessToEntityTypeCompletion(type, done);
  }
  spin(function () { return answered || $.EKEventStore.authorizationStatusForEntityType(type) !== 0; }, 120);
  return { status: $.EKEventStore.authorizationStatusForEntityType(type) };
}
"#;

const REQUEST_CONTACTS: &str = r#"
ObjC.import('Contacts');
function main(a) {
  const cs = $.CNContactStore.alloc.init;
  let answered = false;
  cs.requestAccessForEntityTypeCompletionHandler(0, function (granted, error) { answered = true; });
  spin(function () { return answered || $.CNContactStore.authorizationStatusForEntityType(0) !== 0; }, 120);
  return { status: $.CNContactStore.authorizationStatusForEntityType(0) };
}
"#;

/// The whole script for `kind` (chat.db reads have none: they're SQL).
pub fn script(kind: OpKind) -> Option<String> {
    use OpKind::*;
    let (framework, body) = match kind {
        CalendarEvents => (EVENTKIT, CALENDAR_EVENTS),
        CalendarCreate => (EVENTKIT, CALENDAR_CREATE),
        RemindersList => (EVENTKIT, REMINDERS_LIST),
        RemindersAdd => (EVENTKIT, REMINDERS_ADD),
        RemindersComplete => (EVENTKIT, REMINDERS_COMPLETE),
        ContactsSearch => ("", CONTACTS_SEARCH),
        NotesSearch => ("", NOTES_SEARCH),
        NotesRead => ("", NOTES_READ),
        NotesCreate => ("", NOTES_CREATE),
        MessagesSend => ("", MESSAGES_SEND),
        MessagesRecent | MessagesSearch => return None,
    };
    Some(format!("{PRELUDE}{framework}{body}"))
}

/// The permission prompt's script for `app`, when macOS has one to show
/// ahead of use. Notes and Messages ask on first use (Automation), and
/// Full Disk Access has no prompt at all.
pub fn request_script(app: App) -> Option<(String, Value)> {
    match app {
        App::Calendar => Some((
            format!("{PRELUDE}{EVENTKIT}{REQUEST_EVENTKIT}"),
            serde_json::json!({ "type": 0 }),
        )),
        App::Reminders => Some((
            format!("{PRELUDE}{EVENTKIT}{REQUEST_EVENTKIT}"),
            serde_json::json!({ "type": 1 }),
        )),
        App::Contacts => Some((
            format!("{PRELUDE}{REQUEST_CONTACTS}"),
            serde_json::json!({}),
        )),
        App::Notes | App::Messages => None,
    }
}

/// What a status number from a prompt script means. EventKit: 3 full
/// access; Contacts: 3 authorized, 4 limited. Pure.
pub fn status_result(app: App, status: i64) -> Result<(), OsError> {
    match (app, status) {
        (_, 3) => Ok(()),
        (App::Contacts, 4) => Ok(()),
        (_, 0) => Err(OsError::Denied),
        (_, 1) => Err(OsError::Restricted),
        _ => Err(OsError::Denied),
    }
}

/* ------------------------------------------------------------ chat.db */

/// Messages' history, as Messages itself keeps it.
pub fn chat_db() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join("Library/Messages/chat.db"))
}

/// A string as an SQLite literal: quotes doubled, NULs dropped. SQLite has
/// no backslash escapes, so this is the whole job. Pure.
pub fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\0', "").replace('\'', "''"))
}

/// A `LIKE … ESCAPE '\'` pattern that matches `s` anywhere. Pure.
pub fn like_anywhere(s: &str) -> String {
    let mut out = String::from("%");
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    sql_str(&out)
}

const MESSAGE_COLUMNS: &str = "c.guid AS chat, c.display_name AS name, c.chat_identifier AS ident, \
     m.ROWID AS id, m.is_from_me AS me, m.text AS text, hex(m.attributedBody) AS body, h.id AS sender";

/// The query for recent threads (no `chat`: each conversation's latest
/// message) or one conversation's latest messages, or a search. Pure.
pub fn messages_sql(kind: OpKind, args: &Value) -> String {
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .min(200);
    let joins = "FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID \
                 JOIN chat c ON c.ROWID = j.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id";
    let chat = args
        .get("chat")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    match (kind, chat) {
        (OpKind::MessagesSearch, _) => {
            let q = args.get("query").and_then(Value::as_str).unwrap_or("");
            format!(
                "SELECT {MESSAGE_COLUMNS}, m.date AS date {joins} \
                 WHERE (m.text LIKE {like} ESCAPE '\\' OR instr(m.attributedBody, CAST({lit} AS BLOB)) > 0) \
                 ORDER BY m.date DESC LIMIT {limit};",
                like = like_anywhere(q),
                lit = sql_str(q),
            )
        }
        (_, Some(chat)) => {
            let lit = sql_str(chat);
            format!(
                "SELECT {MESSAGE_COLUMNS}, m.date AS date {joins} \
                 WHERE c.guid = {lit} OR c.chat_identifier = {lit} OR c.display_name = {lit} \
                 ORDER BY m.date DESC LIMIT {limit};"
            )
        }
        // SQLite takes the other columns from the row MAX() picked.
        _ => format!(
            "SELECT {MESSAGE_COLUMNS}, MAX(m.date) AS date {joins} \
             GROUP BY c.ROWID ORDER BY date DESC LIMIT {limit};"
        ),
    }
}

/// Messages' dates: nanoseconds (or, in old databases, seconds) since
/// 2001-01-01. Unix milliseconds. Pure.
pub fn apple_date_ms(raw: i64) -> i64 {
    const EPOCH_2001_MS: i64 = 978_307_200_000;
    if raw.abs() > 1_000_000_000_000 {
        raw / 1_000_000 + EPOCH_2001_MS
    } else {
        raw * 1000 + EPOCH_2001_MS
    }
}

/// The text of a message whose `text` column is empty: newer macOS keeps it
/// only in `attributedBody`, an archived NSAttributedString (typedstream).
/// The string follows the `NSString` class name, after a `+` and a length
/// (one byte, or `0x81` + two bytes, or `0x82` + four, little-endian). Pure.
pub fn attributed_text(hex_body: &str) -> Option<String> {
    let bytes = hex::decode(hex_body.trim()).ok()?;
    let at = bytes.windows(8).position(|w| w == b"NSString")? + 8;
    let plus = at + bytes.get(at..at + 16)?.iter().position(|b| *b == b'+')?;
    let (len, start) = match *bytes.get(plus + 1)? {
        0x81 => {
            let b = bytes.get(plus + 2..plus + 4)?;
            (u16::from_le_bytes([b[0], b[1]]) as usize, plus + 4)
        }
        0x82 => {
            let b = bytes.get(plus + 2..plus + 6)?;
            (
                u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize,
                plus + 6,
            )
        }
        n if n < 0x80 => (n as usize, plus + 2),
        _ => return None,
    };
    let text = bytes.get(start..start + len)?;
    let s = String::from_utf8_lossy(text).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// `sqlite3 -json` rows as the tools' messages. Pure.
pub fn message_rows(rows: &Value) -> Value {
    let rows = rows.as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let s = |k: &str| r.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
            let text = s("text")
                .map(str::to_string)
                .or_else(|| s("body").and_then(attributed_text));
            serde_json::json!({
                "chat": s("chat"),
                "name": s("name").or(s("ident")),
                "fromMe": r.get("me").and_then(Value::as_i64) == Some(1),
                "sender": s("sender"),
                "date": r.get("date").and_then(Value::as_i64).map(apple_date_ms),
                "text": text,
            })
        })
        .collect();
    Value::Array(out)
}

/* ------------------------------------------------------------ the real one */

#[cfg(target_os = "macos")]
mod real {
    use super::*;
    use crate::external_command::run_with_timeout;
    use crate::utils::create_command;

    /// A script runs at most this long (a prompt waits longer).
    const TIMEOUT_SECS: u64 = 60;
    const PROMPT_TIMEOUT_SECS: u64 = 150;

    pub async fn jxa(script: &str, args: &Value, timeout: u64) -> Result<Value, OsError> {
        let mut cmd = create_command("/usr/bin/osascript");
        cmd.args(["-l", "JavaScript", "-e", script]);
        cmd.env(ARGS_ENV, args.to_string());
        let out = run_with_timeout(
            tokio::process::Command::from(cmd),
            "osascript (this Mac's apps)",
            timeout,
        )
        .await
        .map_err(|e| OsError::Failed(e.to_string()))?;
        parse_answer(
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
        )
    }

    pub async fn sqlite(kind: OpKind, args: &Value) -> Result<Value, OsError> {
        let db = chat_db().ok_or_else(|| OsError::Failed("no home folder".into()))?;
        if !db.exists() {
            // Behind Full Disk Access the folder itself can't be listed.
            let listable = db.parent().is_some_and(|p| std::fs::read_dir(p).is_ok());
            return Err(if listable {
                OsError::NotFound("Messages hasn't been used on this Mac".into())
            } else {
                OsError::FullDiskAccess
            });
        }
        let mut cmd = create_command("/usr/bin/sqlite3");
        cmd.arg("-readonly")
            .arg("-json")
            .arg(&db)
            .arg(messages_sql(kind, args));
        let out = run_with_timeout(tokio::process::Command::from(cmd), "sqlite3 chat.db", 30)
            .await
            .map_err(|e| OsError::Failed(e.to_string()))?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            let lower = stderr.to_ascii_lowercase();
            if lower.contains("authorization denied")
                || lower.contains("unable to open")
                || lower.contains("operation not permitted")
            {
                return Err(OsError::FullDiskAccess);
            }
            return Err(OsError::Failed(
                stderr.lines().next().unwrap_or("").to_string(),
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        // No rows: sqlite3 prints nothing at all.
        let rows: Value = if stdout.trim().is_empty() {
            Value::Array(Vec::new())
        } else {
            serde_json::from_str(stdout.trim()).map_err(|e| OsError::Failed(e.to_string()))?
        };
        Ok(message_rows(&rows))
    }

    pub async fn request(app: App) -> Result<(), OsError> {
        let Some((script, args)) = request_script(app) else {
            return Ok(());
        };
        let v = jxa(&script, &args, PROMPT_TIMEOUT_SECS).await?;
        let status = v.get("status").and_then(Value::as_i64).unwrap_or(2);
        status_result(app, status)
    }

    pub const RUN_TIMEOUT: u64 = TIMEOUT_SECS;
}

#[async_trait]
impl MacOs for System {
    #[cfg(target_os = "macos")]
    async fn run(&self, op: &Op) -> Result<Value, OsError> {
        match op.kind {
            OpKind::MessagesRecent | OpKind::MessagesSearch => {
                real::sqlite(op.kind, &op.args).await
            }
            kind => {
                let script = script(kind).ok_or(OsError::Unsupported)?;
                real::jxa(&script, &op.args, real::RUN_TIMEOUT).await
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    async fn run(&self, _op: &Op) -> Result<Value, OsError> {
        Err(OsError::Unsupported)
    }

    #[cfg(target_os = "macos")]
    async fn request_access(&self, app: App) -> Result<(), OsError> {
        real::request(app).await
    }

    #[cfg(not(target_os = "macos"))]
    async fn request_access(&self, _app: App) -> Result<(), OsError> {
        Err(OsError::Unsupported)
    }
}
