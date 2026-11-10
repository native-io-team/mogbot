//! A conversation's automatic title, from the first thing the user said in
//! it: short, sentence case, the ask rather than the pleasantries around it.
//!
//! Deterministic and local (no model call): the same words always give the
//! same title, on the Mac and, for a Mac that sent an older title, on the
//! phone and desktop (`conversationAutoTitle` in the companion protocol,
//! held to the same cases in `conversation-title-cases.json`).
//!
//! It is also idempotent, so a title written by an older build (the whole
//! first line, clipped at 60 with "…") is tidied on read by running it
//! through again; a title the user typed is never touched.

/// Longest automatic title, in characters. Clipped at a word, no "…".
pub const AUTO_TITLE_CHARS: usize = 40;

/// Openers that aren't the ask, lowercased, longest first where one starts
/// another. Removed from the front, repeatedly.
const LEADING: &[&str] = &[
    "i would like you to",
    "i'd like you to",
    "i want you to",
    "i need you to",
    "go ahead and",
    "quick question",
    "hey there",
    "could you please",
    "can you please",
    "would you please",
    "could you",
    "can you",
    "would you",
    "will you",
    "can u",
    "let's",
    "lets",
    "please",
    "pls",
    "plz",
    "hey",
    "hi",
    "hello",
    "okay",
    "ok",
    "so",
    "um",
    "uh",
    "alright",
    "yo",
];

/// Closers that aren't the ask, lowercased.
const TRAILING: &[&str] = &["thank you", "thanks", "please", "pls", "for me"];

/// Words a clipped title must not end on (compared as written: "A" in
/// "plan A" stays).
const DANGLING: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "to", "of", "with", "for", "in", "on", "at", "so",
    "that", "my", "your", "our", "is", "are", "from", "by", "as", "into", "about",
];

/// Ordinary words that a capital mid-sentence only makes odd ("I Kind of
/// like…"). Names are left as written: only these are lowered.
const COMMON: &[&str] = &[
    "a", "about", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at", "be",
    "because", "before", "but", "by", "can", "check", "could", "do", "does", "draft", "each",
    "every", "find", "fix", "for", "from", "get", "give", "go", "has", "have", "help", "her",
    "him", "his", "how", "if", "in", "into", "is", "it", "its", "just", "keep", "kind", "know",
    "let", "like", "look", "make", "me", "more", "most", "my", "new", "next", "no", "not", "now",
    "of", "on", "one", "or", "our", "out", "plan", "please", "put", "really", "see", "send", "set",
    "should", "so", "some", "sort", "start", "still", "than", "that", "the", "their", "them",
    "then", "there", "these", "they", "think", "this", "those", "to", "too", "try", "up", "us",
    "use", "want", "was", "we", "week", "what", "when", "where", "which", "while", "who", "why",
    "will", "with", "would", "write", "you", "your",
];

/// The title for a conversation whose first user message is `text`. Empty
/// when there is nothing to name it by.
pub fn auto_title(text: &str) -> String {
    let line = first_line(text);
    let line = strip_markdown(&line);
    let line = strip_quotes(&line);
    let line: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    // A title clipped by an older build ends "…"; the cut is redone here.
    let line = line.trim_end_matches(['…', '.']).trim().to_string();
    let line = strip_leading(&line);
    let line = first_sentence(&line);
    let line = strip_leading(&line);
    let line = strip_trailing(&line);
    let line = clip(&line);
    sentence_case(&strip_trailing(&line))
}

/// What they wrote, not what they quoted (`> …`) or fenced, unless that is
/// all there is.
fn first_line(text: &str) -> String {
    let mut fenced = false;
    let mut own = None;
    for l in text.lines().map(str::trim) {
        if l.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced || l.is_empty() || l.starts_with('>') {
            continue;
        }
        own = Some(l);
        break;
    }
    own.map(str::to_string).unwrap_or_else(|| {
        text.lines()
            .map(|l| l.trim_start_matches('>').trim())
            .find(|l| !l.is_empty() && !l.starts_with("```"))
            .unwrap_or("")
            .to_string()
    })
}

/// Headings, list markers, emphasis, code ticks and links, as plain words.
fn strip_markdown(line: &str) -> String {
    let mut s = line.trim_start_matches('#').trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = s.strip_prefix(marker) {
            s = rest;
        }
    }
    // "1. " / "2) "
    let digits = s.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &s[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            s = r;
        }
    }
    // [text](url) → text
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        match after.find("](") {
            Some(close) if after[close + 2..].contains(')') => {
                let end = close + 2 + after[close + 2..].find(')').unwrap_or(0);
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str(&rest[..open + 1]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.replace("**", "")
        .replace("__", "")
        .replace("~~", "")
        .chars()
        .filter(|c| !matches!(c, '`' | '*'))
        .collect()
}

/// Quotation marks around words, never an apostrophe inside one ("don’t").
fn strip_quotes(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    for (i, &c) in chars.iter().enumerate() {
        let prev = i.checked_sub(1).map(|j| chars[j]);
        let next = chars.get(i + 1).copied();
        let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
        let drop = match c {
            '"' | '“' | '”' | '«' | '»' | '‘' => true,
            // An apostrophe sits between letters; a quote does not.
            '\'' | '’' => !(word(prev) && word(next)),
            _ => false,
        };
        if !drop {
            out.push(c);
        }
    }
    out
}

/// `line` without the openers in [`LEADING`], and the punctuation after them.
fn strip_leading(line: &str) -> String {
    let mut s = line.trim().to_string();
    loop {
        let lower = s.to_lowercase().replace('’', "'");
        let hit = LEADING.iter().find(|p| {
            lower.starts_with(*p)
                && lower[p.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_alphanumeric() && c != '\'')
        });
        let Some(p) = hit else { break };
        // Openers are ASCII, so their length in the original is the same
        // (a typographic apostrophe is three bytes: count chars instead).
        let n = p.chars().count();
        let rest: String = s.chars().skip(n).collect();
        let rest = rest.trim_start_matches(|c: char| c == ',' || c == '!' || c == ':' || c == '-');
        let rest = rest.trim().to_string();
        if rest.is_empty() {
            break;
        }
        s = rest;
    }
    s
}

/// The first sentence with something in it.
fn first_sentence(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut start = 0;
    for i in 0..chars.len() {
        let end = matches!(chars[i], '.' | '?' | '!' | ';')
            && chars.get(i + 1).is_some_and(|c| c.is_whitespace());
        if end {
            let sentence: String = chars[start..i].iter().collect();
            let sentence = sentence.trim();
            // "Ok." or "Hi!" alone is no sentence to name it by.
            if !strip_leading(sentence).is_empty() && !is_only_filler(sentence) {
                return sentence.to_string();
            }
            start = i + 1;
        }
    }
    chars[start..].iter().collect::<String>().trim().to_string()
}

fn is_only_filler(s: &str) -> bool {
    let lower = s.to_lowercase();
    let lower = lower.trim_matches(|c: char| !c.is_alphanumeric());
    LEADING.contains(&lower) || TRAILING.contains(&lower)
}

/// Without closing pleasantries, trailing punctuation or a dangling word.
fn strip_trailing(line: &str) -> String {
    let mut s = line.trim().to_string();
    loop {
        let before = s.clone();
        s = s
            .trim_end_matches(|c: char| ".,;:!?…-–—".contains(c) || c.is_whitespace())
            .to_string();
        let lower = s.to_lowercase();
        for t in TRAILING {
            if lower.ends_with(t) && lower.len() > t.len() {
                let cut = s.chars().count() - t.chars().count();
                let head: String = s.chars().take(cut).collect();
                if head.ends_with(|c: char| !c.is_alphanumeric()) {
                    s = head.trim_end().to_string();
                    break;
                }
            }
        }
        if let Some((head, last)) = s.rsplit_once(' ') {
            if DANGLING.contains(&last) {
                s = head.to_string();
            }
        }
        if s == before {
            return s;
        }
    }
}

/// At most [`AUTO_TITLE_CHARS`], cut at a word.
fn clip(line: &str) -> String {
    if line.chars().count() <= AUTO_TITLE_CHARS {
        return line.to_string();
    }
    let cut: String = line.chars().take(AUTO_TITLE_CHARS + 1).collect();
    match cut.rfind(' ') {
        Some(at) if at > 0 => cut[..at].to_string(),
        _ => line.chars().take(AUTO_TITLE_CHARS).collect(),
    }
}

/// First letter up; a shouted line lowered; ordinary words capitalised
/// mid-sentence lowered. Names, "I" and acronyms keep their capitals.
fn sentence_case(line: &str) -> String {
    let letters: Vec<char> = line.chars().filter(|c| c.is_alphabetic()).collect();
    let shouted = letters.len() >= 4 && letters.iter().all(|c| c.is_uppercase());
    let words: Vec<String> = line
        .split(' ')
        .enumerate()
        .map(|(i, w)| {
            if shouted {
                return w.to_lowercase();
            }
            let mut cs = w.chars();
            let Some(first) = cs.next() else {
                return String::new();
            };
            let rest: String = cs.collect();
            let capitalised = first.is_uppercase()
                && !rest.is_empty()
                && rest.chars().all(|c| !c.is_alphabetic() || c.is_lowercase());
            let bare = w
                .to_lowercase()
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_string();
            if i > 0 && capitalised && COMMON.contains(&bare.as_str()) {
                w.to_lowercase()
            } else {
                w.to_string()
            }
        })
        .collect();
    let joined = words.join(" ");
    let mut cs = joined.chars();
    match cs.next() {
        Some(first) => first.to_uppercase().collect::<String>() + cs.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        text: String,
        title: String,
    }

    #[derive(serde::Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }

    /// The cases the TS copy (`conversationAutoTitle`) is held to as well.
    #[test]
    fn titles_match_the_shared_cases() {
        let cases: Cases = serde_json::from_str(include_str!(
            "../../../packages/companion-protocol/src/conversation-title-cases.json"
        ))
        .unwrap();
        for case in cases.cases {
            assert_eq!(auto_title(&case.text), case.title, "from {:?}", case.text);
            // Idempotent: a stored title tidies to itself.
            assert_eq!(
                auto_title(&case.title),
                case.title,
                "again {:?}",
                case.title
            );
            assert!(case.title.chars().count() <= AUTO_TITLE_CHARS);
        }
    }

    #[test]
    fn long_words_and_long_lines_stay_in_bounds() {
        let t = auto_title(&"word ".repeat(30));
        assert!(t.chars().count() <= AUTO_TITLE_CHARS && !t.ends_with('…'));
        let t = auto_title(&"x".repeat(100));
        assert_eq!(t.chars().count(), AUTO_TITLE_CHARS);
    }
}
