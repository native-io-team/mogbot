use super::*;

#[test]
fn progress_lines_can_fold_and_content_cannot() {
    for line in [
        "Starting previews…",
        "Let me check they rendered.",
        "Screenshots are done.",
        "Sending you the images now",
    ] {
        assert!(foldable(line), "{line}");
    }
    for line in [
        "Which page should I start with?",
        "Waiting on you: allow the push on the card.",
        "The build failed on Hero.tsx, so you'll need to rerun it once the key is back.",
        "Deploying needs your word.",
        "Done. See [the PR](https://github.com/acme/site/pull/4).",
        "```\nnpm test\n```",
        "- one\n- two",
        "First paragraph.\n\nSecond paragraph.",
        &"x".repeat(MAX_CHARS + 1),
    ] {
        assert!(!foldable(line), "{line}");
    }
}

/// Observed (2026-11-08), fictionalised: a debugging turn wrote a line before
/// each step, naming files in inline code, running long, and mentioning the
/// error it chased. Each reached the chat as its own message.
#[test]
fn debugging_steps_with_inline_code_and_setbacks_fold() {
    for line in [
        "The handler looks clean, so I'll check the failing test in `orders.test.ts`, which also fails on main.",
        "That failure is a date-dependent assertion, not the real error. The server hides the message, so I'll trace `Orders.save`.",
        "No production credentials are on this Mac, so I can't read the logs. I'll read the code paths that only run when rows are added.",
        "Found it. `totals()` reads the whole events table, and `snapshot` calls it once per day for up to a month, so one refresh with a week-old row does about eight full scans. Checking how the earlier fix tested read counts, so I can test mine the same way:",
        "Running the typecheck and the order tests:",
    ] {
        assert!(line.chars().count() <= MAX_CHARS, "{line}");
        assert!(foldable(line), "{line}");
    }
}

/// The owner's real turn, fictionalised: four progress lines between tool
/// calls, then the final reply. Only the final reply reaches the chat.
#[test]
fn consecutive_narration_folds_into_the_timeline_and_the_final_reply_stays() {
    let mut n = Narration::default();
    let mut fates: Vec<Fate> = Vec::new();
    for line in [
        "Starting previews…",
        "Let me check they rendered…",
        "Screenshots are done.",
        "Sending you the images now",
    ] {
        let (before, held) = n.reply(Some(format!("d-{line}")), line);
        fates.extend(before);
        assert!(held);
        fates.extend(n.work()); // a tool call follows
    }
    let final_reply = "Here's the new hero on all three pages. The headline is bigger and the button moved up.\n\nThe pricing page needed a second pass.";
    let (before, held) = n.reply(None, final_reply);
    fates.extend(before);
    assert!(!held, "a long reply is recorded as it always was");
    fates.extend(n.end(true));
    assert_eq!(fates.len(), 4);
    assert!(fates.iter().all(|f| matches!(f, Fate::Fold(_))));
    match &fates[0] {
        Fate::Fold(h) => assert_eq!(h.draft_id.as_deref(), Some("d-Starting previews…")),
        Fate::Keep(_) => unreachable!(),
    }
}

#[test]
fn a_line_followed_by_another_line_folds() {
    let mut n = Narration::default();
    n.reply(None, "Starting previews…");
    let (before, held) = n.reply(None, "Done: both pages updated.");
    assert!(matches!(before, Some(Fate::Fold(_))));
    assert!(held);
    assert!(matches!(n.end(true), Some(Fate::Keep(h)) if h.text == "Done: both pages updated."));
}

#[test]
fn a_short_line_the_turn_ends_on_is_its_reply() {
    let mut n = Narration::default();
    let (_, held) = n.reply(Some("d1".into()), "Done, it's live.");
    assert!(held);
    match n.end(false) {
        Some(Fate::Keep(h)) => {
            assert_eq!(h.text, "Done, it's live.");
            assert_eq!(h.draft_id.as_deref(), Some("d1"));
        }
        other => panic!("{other:?}"),
    }
    assert!(!n.holding());
}

#[test]
fn a_turn_that_only_narrated_still_says_its_last_line() {
    let mut n = Narration::default();
    n.reply(None, "Checking the deploy now.");
    assert!(matches!(n.work(), Some(Fate::Fold(_))));
    // Nothing else was said: the last folded line is the reply after all.
    match n.end(false) {
        Some(Fate::Keep(h)) => assert_eq!(h.text, "Checking the deploy now."),
        other => panic!("{other:?}"),
    }
    // A turn that said something else ends with nothing more.
    let mut n = Narration::default();
    n.reply(None, "Checking the deploy now.");
    n.work();
    assert_eq!(n.end(true), None);
}

#[test]
fn a_note_is_one_line() {
    assert_eq!(note_label("Starting\n  previews…"), "Starting previews…");
}
