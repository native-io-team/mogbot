//! Your words: the names and terms dictation should get right, and the fixes
//! you've made to what it wrote.
//!
//! - A list you can see and edit (Settings → Agents → Dictation): typed in, or
//!   **learned**: when you change a dictated word before sending ("mog about"
//!   → "Mogbot") and make the same fix a second time, the word joins the list
//!   on its own, with Undo. A word you removed is never learned again.
//! - Both go to Whisper's prompt (your words first, then the app's name, then
//!   the team's names) and to the names pass, which also gets your past fixes
//!   ("mog about → Mogbot") so it can correct the sound-alikes Whisper still
//!   writes.
//!
//! Kept in one file in the app's own folder (`dictation-words.json`); nothing
//! here leaves the computer except what the names pass already sends.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// The most words kept (a list longer than this stops helping Whisper).
pub const MAX_WORDS: usize = 200;
/// The most fixes remembered for the names pass.
pub const MAX_FIXES: usize = 40;
/// How many times the same fix is made before its word is learned.
pub const LEARN_AFTER: u32 = 2;
/// A fix is at most this many words on either side; more is a rewrite.
const MAX_SPAN: usize = 3;
/// Messages longer than this many words aren't compared.
const MAX_TOKENS: usize = 600;
const MAX_WORD_CHARS: usize = 64;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub word: String,
    /// Learned from your fixes rather than typed in.
    #[serde(default)]
    pub learned: bool,
    /// Unix seconds.
    #[serde(default)]
    pub added: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    /// What dictation wrote.
    pub heard: String,
    /// What you changed it to.
    pub fixed: String,
    pub count: u32,
    /// Unix seconds, the last time it was made.
    #[serde(default)]
    pub last: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub words: Vec<Word>,
    #[serde(default)]
    pub fixes: Vec<Fix>,
    /// Words you removed: never learned again.
    #[serde(default)]
    pub removed: Vec<String>,
}

fn path() -> PathBuf {
    crate::brand::app_support_dir().join("dictation-words.json")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_from(path: &std::path::Path) -> Store {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_to(path: &std::path::Path, store: &Store) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Read, change and write the file, one change at a time.
fn change<T>(f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = path();
    let mut store = load_from(&p);
    let out = f(&mut store);
    save_to(&p, &store)?;
    Ok(out)
}

pub fn load() -> Store {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_from(&path())
}

fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// A word as it's kept: spaces folded, quotes and end punctuation off.
pub fn tidy_word(word: &str) -> Option<String> {
    let w = word.split_whitespace().collect::<Vec<_>>().join(" ");
    let w = w
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '+' && c != '#' && c != '@')
        .to_string();
    (!w.is_empty() && w.chars().count() <= MAX_WORD_CHARS).then_some(w)
}

impl Store {
    pub fn has(&self, word: &str) -> bool {
        self.words.iter().any(|w| same(&w.word, word))
    }

    /// Add a word you typed. A word you'd removed can be typed back in.
    pub fn add(&mut self, word: &str, learned: bool) -> Option<String> {
        let word = tidy_word(word)?;
        if self.has(&word) {
            return None;
        }
        if !learned {
            self.removed.retain(|r| !same(r, &word));
        }
        self.words.insert(
            0,
            Word {
                word: word.clone(),
                learned,
                added: now(),
            },
        );
        self.words.truncate(MAX_WORDS);
        Some(word)
    }

    pub fn remove(&mut self, word: &str) {
        let before = self.words.len();
        self.words.retain(|w| !same(&w.word, word));
        if self.words.len() != before && !self.removed.iter().any(|r| same(r, word)) {
            self.removed.push(word.trim().to_string());
        }
        self.fixes.retain(|f| !same(&f.fixed, word));
    }

    /// Note one fix; the word it fixed to, when that makes it learned now.
    pub fn note_fix(&mut self, heard: &str, fixed: &str) -> Option<String> {
        let at = now();
        match self
            .fixes
            .iter_mut()
            .find(|f| same(&f.heard, heard) && f.fixed == fixed)
        {
            Some(f) => {
                f.count += 1;
                f.last = at;
            }
            None => self.fixes.push(Fix {
                heard: heard.to_string(),
                fixed: fixed.to_string(),
                count: 1,
                last: at,
            }),
        }
        self.fixes.sort_by(|a, b| b.last.cmp(&a.last));
        self.fixes.truncate(MAX_FIXES);
        // The same word fixed to twice, from any mishearing ("mog about",
        // "Mogol" → Mogbot).
        let times: u32 = self
            .fixes
            .iter()
            .filter(|f| f.fixed == fixed)
            .map(|f| f.count)
            .sum();
        if times < LEARN_AFTER || self.has(fixed) || self.removed.iter().any(|r| same(r, fixed)) {
            return None;
        }
        self.add(fixed, true)
    }

    /// Your words for Whisper and the names pass: typed ones first, then
    /// learned, newest first.
    pub fn list(&self) -> Vec<String> {
        let typed = self.words.iter().filter(|w| !w.learned);
        let learned = self.words.iter().filter(|w| w.learned);
        typed.chain(learned).map(|w| w.word.clone()).collect()
    }

    /// "mog about → Mogbot" lines for the names pass, most recent first.
    pub fn fix_lines(&self) -> Vec<String> {
        self.fixes
            .iter()
            .map(|f| format!("{} → {}", f.heard, f.fixed))
            .collect()
    }
}

/// Your words, then the app's own name, then `names` (the team's), each once.
pub fn with_yours(store: &Store, names: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let all = store
        .list()
        .into_iter()
        .chain(std::iter::once(crate::brand::NAME.to_string()))
        .chain(names);
    for name in all {
        let name = name.trim().to_string();
        if !name.is_empty() && !out.iter().any(|o| same(o, &name)) {
            out.push(name);
        }
    }
    out
}

/// A word with the punctuation around it off, for comparing.
fn bare(token: &str) -> &str {
    token.trim_matches(|c: char| !c.is_alphanumeric())
}

/// The words you changed in what dictation wrote before sending it: each
/// place where one to three of its words became one to three others. Words
/// you only added or deleted (typing more, cutting a bit) aren't fixes, nor
/// is punctuation, nor capitalising the first word of a sentence. A fix must
/// look like a name or a term: a capital letter or a digit in it.
pub fn fixes_between(dictated: &str, sent: &str) -> Vec<(String, String)> {
    let a: Vec<&str> = dictated.split_whitespace().take(MAX_TOKENS).collect();
    let b: Vec<&str> = sent.split_whitespace().take(MAX_TOKENS).collect();
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let (n, m) = (a.len(), b.len());
    let eq = |i: usize, j: usize| bare(a[i]) == bare(b[j]);
    // Longest common subsequence, from the end.
    let mut lcs = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if eq(i, j) {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    // Walk it, collecting the runs that differ.
    let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && eq(i, j) {
            i += 1;
            j += 1;
            continue;
        }
        let (si, sj) = (i, j);
        while (i < n || j < m) && !(i < n && j < m && eq(i, j)) {
            if j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
                i += 1;
            } else {
                j += 1;
            }
        }
        hunks.push((si, i, sj, j));
    }
    let mut out = Vec::new();
    for (si, ei, sj, ej) in hunks {
        let (heard, fixed) = (&a[si..ei], &b[sj..ej]);
        if heard.is_empty() || fixed.is_empty() || heard.len() > MAX_SPAN || fixed.len() > MAX_SPAN
        {
            continue;
        }
        let heard_s = heard.iter().map(|t| bare(t)).collect::<Vec<_>>().join(" ");
        let fixed_s = fixed.iter().map(|t| bare(t)).collect::<Vec<_>>().join(" ");
        let fixed_s = fixed_s.trim().to_string();
        if heard_s.trim().is_empty() || fixed_s.is_empty() || heard_s == fixed_s {
            continue;
        }
        if !fixed_s
            .chars()
            .any(|c| c.is_uppercase() || c.is_ascii_digit())
        {
            continue;
        }
        // "the" → "The" at the start of a sentence is grammar, not a name.
        let sentence_start = sj == 0 || b[sj - 1].ends_with(['.', '!', '?', ':']);
        if heard_s.to_lowercase() == fixed_s.to_lowercase() && sentence_start {
            continue;
        }
        if fixed_s.chars().count() > MAX_WORD_CHARS {
            continue;
        }
        out.push((heard_s, fixed_s));
    }
    out
}

/// Learn from a dictated message as sent: note each fix, and return the
/// words that became yours because of it.
pub fn learn(dictated: &str, sent: &str) -> Vec<String> {
    let fixes = fixes_between(dictated, sent);
    if fixes.is_empty() {
        return Vec::new();
    }
    change(|store| {
        fixes
            .iter()
            .filter_map(|(heard, fixed)| store.note_fix(heard, fixed))
            .collect::<Vec<_>>()
    })
    .map_err(|error| tracing::warn!(%error, "[Dictation] couldn't keep a fix"))
    .unwrap_or_default()
}

pub fn add(word: &str) -> Result<Store, String> {
    change(|store| {
        store.add(word, false);
        store.clone()
    })
}

pub fn remove(word: &str) -> Result<Store, String> {
    change(|store| {
        store.remove(word);
        store.clone()
    })
}

/// What the phone dictated last, per chat, so the message it sends can teach
/// a fix (the phone's composer is its own; the Mac sees both ends).
static PHONE_LAST: Mutex<Vec<(String, String, std::time::Instant)>> = Mutex::new(Vec::new());
/// A dictation older than this when its message is sent isn't compared.
const PHONE_WINDOW: std::time::Duration = std::time::Duration::from_secs(15 * 60);

pub fn phone_dictated(chat: &str, text: &str) {
    if let Ok(mut list) = PHONE_LAST.lock() {
        list.retain(|(c, _, at)| c != chat && at.elapsed() < PHONE_WINDOW);
        list.push((
            chat.to_string(),
            text.to_string(),
            std::time::Instant::now(),
        ));
    }
}

/// The phone sent `sent` to `chat`: learn from it if it was dictated there.
pub fn phone_sent(chat: &str, sent: &str) {
    let dictated = PHONE_LAST.lock().ok().and_then(|mut list| {
        let at = list.iter().position(|(c, _, _)| c == chat)?;
        let (_, text, when) = list.remove(at);
        (when.elapsed() < PHONE_WINDOW).then_some(text)
    });
    if let Some(dictated) = dictated {
        let sent = sent.to_string();
        std::thread::spawn(move || {
            let learned = learn(&dictated, &sent);
            if !learned.is_empty() {
                tracing::info!(count = learned.len(), "[Dictation] learned from the phone");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn a_misheard_name_fixed_is_a_fix() {
        assert_eq!(
            fixes_between("ask mog about to ship it", "ask Mogbot to ship it"),
            pairs(&[("mog about", "Mogbot")])
        );
        assert_eq!(
            fixes_between(
                "tell Mogol the phone build is out.",
                "tell Mogbot the phone build is out."
            ),
            pairs(&[("Mogol", "Mogbot")])
        );
        assert_eq!(
            fixes_between("the lobeva site", "the Lobeva site"),
            pairs(&[("lobeva", "Lobeva")])
        );
    }

    #[test]
    fn typing_more_or_cutting_is_not_a_fix() {
        assert!(fixes_between("ship it", "OK so ship it now please").is_empty());
        assert!(fixes_between("ship it now please", "ship it").is_empty());
        assert!(fixes_between("ship it", "ship it.").is_empty());
        assert!(fixes_between("the build is out", "The build is out").is_empty());
        // A rewrite isn't a fix either.
        assert!(fixes_between(
            "can you send the thing over",
            "Please Email Julian The Report We Discussed"
        )
        .is_empty());
        // Ordinary words swapped aren't names.
        assert!(fixes_between("send it today", "post it today").is_empty());
    }

    #[test]
    fn typed_text_before_the_dictation_is_left_alone() {
        assert_eq!(
            fixes_between("ask mog about to check", "Quick one: ask Mogbot to check"),
            pairs(&[("mog about", "Mogbot")])
        );
    }

    #[test]
    fn the_second_time_teaches_the_word() {
        let mut s = Store::default();
        assert_eq!(s.note_fix("mog about", "Mogbot"), None);
        assert_eq!(s.note_fix("Mogol", "Mogbot").as_deref(), Some("Mogbot"));
        assert!(s.words[0].learned);
        // Already yours: nothing new to say.
        assert_eq!(s.note_fix("mog about", "Mogbot"), None);
        assert_eq!(s.fix_lines()[0], "mog about → Mogbot");
    }

    #[test]
    fn a_word_you_removed_is_not_learned_again() {
        let mut s = Store::default();
        s.note_fix("a", "Lobeva");
        s.note_fix("a", "Lobeva");
        assert!(s.has("Lobeva"));
        s.remove("Lobeva");
        assert!(!s.has("Lobeva"));
        s.note_fix("b", "Lobeva");
        s.note_fix("b", "Lobeva");
        assert!(!s.has("Lobeva"));
        // Typed back in, it's yours again.
        assert_eq!(s.add("Lobeva", false).as_deref(), Some("Lobeva"));
        assert!(s.removed.is_empty());
    }

    #[test]
    fn your_words_come_first_then_the_app_then_the_team() {
        let mut s = Store::default();
        s.add("Native", false);
        s.note_fix("x", "Lobeva");
        s.note_fix("x", "Lobeva");
        s.add("  \"Ship Studio.\" ", false);
        let all = with_yours(&s, vec!["chief of staff".into(), "native".into()]);
        assert_eq!(
            all,
            vec![
                "Ship Studio".to_string(),
                "Native".into(),
                "Lobeva".into(),
                crate::brand::NAME.into(),
                "chief of staff".into(),
            ]
        );
    }

    #[test]
    fn the_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("w.json");
        let mut s = Store::default();
        s.add("Mogbot", false);
        s.note_fix("mog about", "Mogbot");
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
        assert_eq!(
            load_from(&dir.path().join("missing.json")),
            Store::default()
        );
    }
}
