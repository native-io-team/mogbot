//! What the app calls the computer it runs on, the same rule as
//! `packages/companion-protocol/src/computer.ts`: "Mac" on macOS, "PC" on
//! Windows (its own name for itself), "computer" elsewhere. Copy and agent
//! briefings use these, never a literal "this Mac", unless they name something
//! only a Mac has (the Keychain, macOS notifications, the Calendar app).

use serde::{Deserialize, Serialize};

/// Sent to the phone in `MacStatus.computer`, so it can say "your PC".
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ComputerKind {
    Mac,
    Pc,
    Computer,
}

/// This build's kind. Tests use the Mac's words on every OS, so the many
/// copy assertions written against "this Mac" hold on Linux and Windows CI;
/// the other words are tested through [`localize_with`] below.
#[cfg(any(target_os = "macos", test))]
pub const HOST: ComputerKind = ComputerKind::Mac;
#[cfg(all(target_os = "windows", not(test)))]
pub const HOST: ComputerKind = ComputerKind::Pc;
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
pub const HOST: ComputerKind = ComputerKind::Computer;

/// Declares the computer's words as `&'static str` constants for this build,
/// so they work inside `concat!`-built prompts through `computer_words!`.
macro_rules! words {
    ($noun:literal) => {
        /// "Mac" / "PC" / "computer".
        pub const NOUN: &str = $noun;
        /// "this Mac" / "this PC" / "this computer".
        pub const THIS: &str = concat!("this ", $noun);
        /// "This Mac" (start of a sentence).
        pub const THIS_CAP: &str = concat!("This ", $noun);
        /// "your Mac" / "your PC" / "your computer".
        pub const YOUR: &str = concat!("your ", $noun);
        /// "Your Mac" (start of a sentence).
        pub const YOUR_CAP: &str = concat!("Your ", $noun);
        /// "the Mac" / "the PC" / "the computer".
        pub const THE: &str = concat!("the ", $noun);
    };
}

/// The noun as a literal, for `concat!`-built constants:
/// `concat!("Gone from this ", computer::noun!(), ".")`.
#[cfg(any(target_os = "macos", test))]
macro_rules! noun {
    () => {
        "Mac"
    };
}
#[cfg(all(target_os = "windows", not(test)))]
macro_rules! noun {
    () => {
        "PC"
    };
}
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
macro_rules! noun {
    () => {
        "computer"
    };
}
pub(crate) use noun;

#[cfg(any(target_os = "macos", test))]
words!("Mac");
#[cfg(all(target_os = "windows", not(test)))]
words!("PC");
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
words!("computer");

/// Puts this build's words into prose written with "this Mac" / "your Mac" /
/// "the Mac", for text too long or too dynamic for constants (agent
/// briefings, tool descriptions, the app's own chat lines). On a Mac it
/// returns the text unchanged. Idempotent.
pub fn localize(text: &str) -> std::borrow::Cow<'_, str> {
    localize_with(text, NOUN)
}

/// The words that come before "Mac" when it means the computer the app runs
/// on. "a Mac" is left alone on purpose: it names the kind of computer a
/// Mac-only thing needs ("This only works on a Mac", "needs a Mac with Xcode").
const LEADS: [&str; 9] = [
    "this ", "This ", "your ", "Your ", "the ", "The ", "their ", "own ", "user's ",
];

/// [`localize`] for a given noun, so it can be tested off a Mac. Only whole
/// phrases are replaced: "this Mac's" becomes "this PC's", while "macOS",
/// "MacBook", "a Mac" and a bare "Mac" stay as written.
pub fn localize_with<'a>(text: &'a str, noun: &str) -> std::borrow::Cow<'a, str> {
    if noun == "Mac" || !text.contains(" Mac") {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 16);
    let mut rest = text;
    while let Some(at) = rest.find("Mac") {
        let (before, after) = rest.split_at(at);
        let tail = &after[3..];
        let whole = !tail.chars().next().is_some_and(|c| c.is_alphanumeric());
        let lead = LEADS.iter().find(|l| {
            before.ends_with(*l)
                && !before[..before.len() - l.len()]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric())
        });
        out.push_str(before);
        if whole && lead.is_some() {
            out.push_str(noun);
        } else {
            out.push_str("Mac");
        }
        rest = tail;
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// [`localize`] over every string in a JSON value (tool lists, card and
/// tool-result payloads), except under the keys in `skip`: values that must
/// stay exactly as given, such as a tool call's `input`. A no-op on a Mac.
pub fn localize_json(value: &mut serde_json::Value, skip: &[&str]) {
    if NOUN == "Mac" {
        return;
    }
    localize_json_with(value, skip, NOUN);
}

fn localize_json_with(value: &mut serde_json::Value, skip: &[&str], noun: &str) {
    use serde_json::Value;
    match value {
        Value::String(s) => {
            if let std::borrow::Cow::Owned(o) = localize_with(s, noun) {
                *s = o;
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| localize_json_with(v, skip, noun)),
        Value::Object(map) => map
            .iter_mut()
            .filter(|(k, _)| !skip.contains(&k.as_str()))
            .for_each(|(_, v)| localize_json_with(v, skip, noun)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_match_the_host() {
        assert_eq!(THIS, format!("this {NOUN}"));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(HOST, ComputerKind::Mac);
            assert_eq!(localize("Runs on this Mac."), "Runs on this Mac.");
        }
    }

    #[test]
    fn localize_names_a_pc_and_a_computer() {
        let text = "Runs on this Mac. Your Mac's Keychain. At the Mac, on their Mac, \
                    the user's own Mac. This only works on a Mac, a MacBook, macOS, via Mac.";
        assert_eq!(
            localize_with(text, "PC"),
            "Runs on this PC. Your PC's Keychain. At the PC, on their PC, \
             the user's own PC. This only works on a Mac, a MacBook, macOS, via Mac."
        );
        assert_eq!(
            localize_with("Keep this Mac awake", "computer"),
            "Keep this computer awake"
        );
        // Already localized text stays as it is.
        assert_eq!(localize_with("this PC", "PC"), "this PC");
        assert_eq!(localize_with("Breathe Mac", "PC"), "Breathe Mac");
    }

    #[test]
    fn localize_json_skips_exact_values() {
        let mut v = serde_json::json!({
            "title": "Sign in on this Mac",
            "input": { "command": "echo this Mac" },
            "options": [{ "detail": "Opens in this Mac's browser." }]
        });
        localize_json_with(&mut v, &["input"], "PC");
        assert_eq!(v["title"], "Sign in on this PC");
        assert_eq!(v["input"]["command"], "echo this Mac");
        assert_eq!(v["options"][0]["detail"], "Opens in this PC's browser.");
    }

    #[test]
    fn kind_is_sent_lowercase() {
        assert_eq!(serde_json::to_string(&ComputerKind::Pc).unwrap(), "\"pc\"");
    }
}
