//! A command's output, as far as the timeline shows it: the last lines (for
//! "Show output"), cleaned, and the pass/fail counts a test runner printed.
//!
//! Output is the one place a step shows text the agent didn't choose, so
//! every line goes through the same wall a label does — the Keychain's
//! values, then the scrubber, then a length limit — after terminal escapes
//! and control characters are stripped. Only the tail is ever kept.

use std::sync::LazyLock;

use regex::Regex;

/// Lines shown under a live step's "Show output".
pub const TAIL_LINES: usize = 20;
/// Longest line kept, in characters.
pub const LINE_CHARS: usize = 160;
/// Raw output held for a running call (its newest part), before it's cut into lines.
const BUFFER_BYTES: usize = 16 * 1024;

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    // CSI sequences, OSC sequences (titles, links), and lone two-byte escapes.
    Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
        .unwrap()
});

/// One line as shown: escapes and controls gone, a progress bar's redraws
/// (`\r`) reduced to what it says last, then redacted, scrubbed and clipped.
pub fn clean_line(raw: &str) -> String {
    let no_escapes = ANSI.replace_all(raw, "");
    let last = no_escapes
        .rsplit('\r')
        .find(|s| !s.trim().is_empty())
        .unwrap_or("");
    let plain: String = last
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    let redacted = super::super::secrets::redact(plain.trim_end());
    super::clip(&super::scrub(&redacted), LINE_CHARS)
}

/// The last `n` non-blank lines of some output, cleaned.
pub fn tail(text: &str, n: usize) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .rev()
        .map(clean_line)
        .filter(|l| !l.trim().is_empty())
        .take(n)
        .collect();
    lines.reverse();
    lines
}

/// Output arriving in pieces (Codex's `outputDelta`): only its newest part
/// is held, and it is cut into lines when shown.
#[derive(Debug, Default, Clone)]
pub struct Buffer {
    text: String,
}

impl Buffer {
    pub fn push(&mut self, delta: &str) {
        self.text.push_str(delta);
        if self.text.len() > BUFFER_BYTES {
            let mut cut = self.text.len() - BUFFER_BYTES;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            // Start on a whole line where there is one.
            let from = self.text[cut..].find('\n').map_or(cut, |i| cut + i + 1);
            self.text.drain(..from);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }

    pub fn lines(&self) -> Vec<String> {
        tail(&self.text, TAIL_LINES)
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

static COUNT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(\d{1,6})\s+(passed|passing|failed|failing|skipped|pending)\b").unwrap()
});
/// Cypress's run table: "✖  3 of 12 failed (25%)  06:12  45  42  3  -  -"
/// (tests, passing, failing, pending, skipped) or "✔  All specs passed!  …".
static CYPRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:All specs passed!|\d+ of \d+ failed \(\d+%\))\s+(?:\d+:\d+(?::\d+)?|\d+ms|[\d.]+s)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)",
    )
    .unwrap()
});
/// cargo's "test result: FAILED. 42 passed; 3 failed; 0 ignored", once per test binary.
static CARGO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"test result: \w+\. (\d+) passed; (\d+) failed").unwrap());

/// What a test run says it came to: "42 passed, 3 failed". Only counts the
/// runner printed; `None` when it printed none we can read.
pub fn test_summary(text: &str) -> Option<String> {
    let clean: Vec<String> = text
        .lines()
        .rev()
        .take(120)
        .map(|l| ANSI.replace_all(l, "").into_owned())
        .collect();
    let num = |s: &str| s.parse::<u64>().ok();
    // Cypress's table, newest first.
    for line in &clean {
        if let Some(c) = CYPRESS.captures(line) {
            let passed = num(&c[2]).unwrap_or(0);
            let failed = num(&c[3]).unwrap_or(0);
            return Some(words(Some(passed), Some(failed)));
        }
    }
    // cargo: every binary's line, summed.
    let cargo: Vec<(u64, u64)> = clean
        .iter()
        .filter_map(|l| {
            let c = CARGO.captures(l)?;
            Some((num(&c[1])?, num(&c[2])?))
        })
        .collect();
    if !cargo.is_empty() {
        let (p, f) = cargo.iter().fold((0, 0), |(p, f), (a, b)| (p + a, f + b));
        return Some(words(Some(p), Some(f)));
    }
    // Jest, Vitest, Playwright, pytest, Mocha: the newest count of each kind.
    let mut passed = None;
    let mut failed = None;
    for line in &clean {
        for c in COUNT.captures_iter(line) {
            let n = num(&c[1]);
            match c[2].to_ascii_lowercase().as_str() {
                "passed" | "passing" if passed.is_none() => passed = n,
                "failed" | "failing" if failed.is_none() => failed = n,
                _ => {}
            }
        }
        if passed.is_some() && failed.is_some() {
            break;
        }
    }
    (passed.is_some() || failed.is_some()).then(|| words(passed, failed))
}

fn words(passed: Option<u64>, failed: Option<u64>) -> String {
    match (passed, failed) {
        (Some(p), Some(f)) if f > 0 => format!("{p} passed, {f} failed"),
        (Some(p), _) => format!("{p} passed"),
        (None, Some(f)) => format!("{f} failed"),
        (None, None) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_lose_escapes_controls_and_redraws() {
        assert_eq!(clean_line("\x1b[32m✓\x1b[0m renders"), "✓ renders");
        assert_eq!(clean_line("10%\r50%\r100% done"), "100% done");
        assert_eq!(clean_line("\x1b]8;;https://x\x07link\x1b]8;;\x07"), "link");
        assert_eq!(clean_line("a\u{7}b"), "ab");
    }

    #[test]
    fn lines_are_scrubbed_before_they_are_clipped() {
        let line = format!("token=ghp_{}", "a1".repeat(100));
        let cleaned = clean_line(&line);
        assert!(!cleaned.contains("a1a1"), "{cleaned}");
        assert!(cleaned.chars().count() <= LINE_CHARS);
    }

    #[test]
    fn the_tail_is_the_last_non_blank_lines() {
        let text = (1..=30)
            .map(|i| format!("line {i}\n\n"))
            .collect::<String>();
        let t = tail(&text, 3);
        assert_eq!(t, ["line 28", "line 29", "line 30"]);
    }

    #[test]
    fn a_buffer_keeps_only_its_newest_part() {
        let mut b = Buffer::default();
        for i in 0..5000 {
            b.push(&format!("output line {i}\n"));
        }
        assert!(b.text().len() <= BUFFER_BYTES);
        assert_eq!(b.lines().last().unwrap(), "output line 4999");
        assert!(b.text().starts_with("output line"));
    }

    #[test]
    fn test_runners_summaries_are_read() {
        let cases = [
            ("Tests:       3 failed, 42 passed, 45 total\nTime: 4s", "42 passed, 3 failed"),
            (" Test Files  1 failed | 9 passed (10)\n      Tests  3 failed | 42 passed (45)", "42 passed, 3 failed"),
            ("  3 failed\n    [chromium] › a.spec.ts:3:1 › x\n  42 passed (1.2m)", "42 passed, 3 failed"),
            ("===== 3 failed, 42 passed in 12.30s =====", "42 passed, 3 failed"),
            ("  42 passing (2s)\n  3 failing\n\n  1) thing", "42 passed, 3 failed"),
            ("Tests:       45 passed, 45 total", "45 passed"),
            (
                "    ✖  3 of 12 failed (25%)                06:12       45       42        3        -        -",
                "42 passed, 3 failed",
            ),
            (
                "    ✔  All specs passed!                   02:01       12       12        -        -        -",
                "12 passed",
            ),
            (
                "test result: ok. 40 passed; 0 failed; 0 ignored\ntest result: FAILED. 2 passed; 3 failed; 0 ignored",
                "42 passed, 3 failed",
            ),
        ];
        for (output, want) in cases {
            assert_eq!(test_summary(output).as_deref(), Some(want), "{output}");
        }
        assert_eq!(test_summary("Compiled successfully"), None);
    }
}
