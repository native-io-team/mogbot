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
        "The build failed on Hero.tsx.",
        "Done. See [the PR](https://github.com/acme/site/pull/4).",
        "- one\n- two",
        "First paragraph.\n\nSecond paragraph.",
        &"x".repeat(MAX_CHARS + 1),
    ] {
        assert!(!foldable(line), "{line}");
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
