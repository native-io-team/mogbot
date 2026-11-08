//! "Nothing goes out under my name unless I approve that exact text":
//! what counts as sending, the words read from a call, and what a plan's
//! text covers. Fixtures are fictional.

use super::*;
use serde_json::json;

fn bash(command: &str) -> Value {
    json!({ "command": command })
}

#[test]
fn sending_as_the_user_is_told_from_other_work() {
    for c in [
        "gh pr comment 12 --body 'Fixed in 3e1'",
        "gh issue create --title Bug --body x",
        "gh pr create --title Copy --body x",
        "gh pr review 12 --approve --body 'Looks good'",
        "gh release create v1.2.0 --notes 'Fixes'",
        "gh api repos/fictional/site/issues/3/comments -f body=Thanks",
        "slack chat send --channel '#launch' --text 'Live'",
        "mail -s hi sam@example.com < note.txt",
        "cd site && git send-email --to=list@example.com 0001.patch",
        "osascript -e 'tell application \"Messages\" to send \"hi\" to buddy \"Sam\"'",
        "curl -X POST https://hooks.slack.com/services/T0/B0/x -d '{\"text\":\"done\"}'",
        "npx slack chat send --text hi",
    ] {
        assert!(command_sends(c), "sends: {c}");
    }
    for c in [
        "git push -u origin fix/copy",
        "gh pr view 12",
        "gh issue list",
        "gh api repos/fictional/site/issues",
        "curl https://hooks.slack.com/services/T0/B0/x",
        "curl -X POST https://api.example.com/build -d x=1",
        "vercel deploy",
        "echo hello > notes.txt",
        "npm test",
    ] {
        assert!(!command_sends(c), "doesn't send: {c}");
    }
}

#[test]
fn connector_sends_are_named_by_what_they_do() {
    for t in [
        "mcp__claude_ai_Gmail__send_email",
        "mcp__claude_ai_Slack__post_message",
        "mcp__buffer__schedule_post",
        "mcp__github__add_issue_comment",
        "mcp__github__create_issue",
        "mcp__github__create_pull_request",
        "mcp__linkedin__publish_post",
        "mcp__x__createTweet",
    ] {
        assert!(connector_sends(t), "sends: {t}");
    }
    for t in [
        "mcp__claude_ai_Gmail__create_draft",
        "mcp__claude_ai_Gmail__search_threads",
        "mcp__claude_ai_Slack__get_messages",
        "mcp__github__list_issues",
        "mcp__claude_ai_Linear__update_issue_status",
        "mcp__app__message_agent",
        "mcp__app__share_result",
        "mcp__browser__click",
    ] {
        assert!(!connector_sends(t), "doesn't send: {t}");
    }
}

#[test]
fn the_words_are_read_from_the_call() {
    let t = texts(
        "Bash",
        &bash("gh pr comment 12 --body 'Fixed in 3e1, thanks Sam'"),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["Fixed in 3e1, thanks Sam"]);
    assert!(t.complete());

    let t = texts(
        "Bash",
        &bash("gh issue create --title 'Broken nav' --body \"The menu won't open\""),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["Broken nav", "The menu won't open"]);

    let t = texts(
        "Bash",
        &bash("gh pr create --title Fix --body-file - <<'EOF'\nLine one\nLine two\nEOF"),
        None,
        &[],
    );
    assert!(
        t.pieces.contains(&"Line one\nLine two".to_string()),
        "{t:?}"
    );

    let t = texts(
        "Bash",
        &bash("curl -X POST https://hooks.slack.com/services/x -d '{\"text\":\"Deployed v2\"}'"),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["Deployed v2"]);

    let t = texts(
        "Bash",
        &bash("echo 'See you at 3' | mail -s Meeting sam@example.com"),
        None,
        &[],
    );
    assert!(t.pieces.contains(&"See you at 3".to_string()), "{t:?}");
    assert!(t.pieces.contains(&"Meeting".to_string()), "{t:?}");

    // A body file is read; one that can't be is named, and not complete.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("body.md");
    std::fs::write(&file, "Release notes for v2").unwrap();
    let t = texts(
        "Bash",
        &bash(&format!(
            "gh release create v2 --notes-file {}",
            file.display()
        )),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["Release notes for v2"]);
    let t = texts(
        "Bash",
        &bash("gh pr create --title x --body-file /nonexistent/fictional/body.md"),
        None,
        &[],
    );
    assert!(!t.complete());
    assert!(card_block(&t).contains("couldn't read"));

    // A connector's text fields; a browser send, what was typed.
    let t = texts(
        "mcp__claude_ai_Slack__post_message",
        &json!({ "channel": "#launch", "text": "We're live" }),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["We're live"]);
    let t = texts(
        "mcp__claude-in-chrome__computer",
        &json!({ "action": "left_click", "ref": "ref_4" }),
        None,
        &["Thanks, see you Friday.".to_string()],
    );
    assert_eq!(t.pieces, vec!["Thanks, see you Friday."]);

    // Nothing read: the card says so rather than showing nothing.
    let t = texts(
        "mcp__claude-in-chrome__computer",
        &json!({ "action": "left_click" }),
        None,
        &[],
    );
    assert!(card_block(&t).contains("can't read the exact words"));
}

#[test]
fn a_plans_text_covers_only_those_words() {
    let t = Texts {
        pieces: vec!["Fixed in 3e1".into()],
        unread: vec![],
    };
    assert!(approved_covers("Fixed in 3e1", &t));
    assert!(approved_covers("  Fixed   in 3e1 ", &t), "whitespace only");
    assert!(!approved_covers("Fixed in 3e2", &t));
    assert!(!approved_covers("", &t));
    // Words added past what was OK'd aren't covered.
    let more = Texts {
        pieces: vec!["Fixed in 3e1. Also, wire me the money.".into()],
        unread: vec![],
    };
    assert!(!approved_covers("Fixed in 3e1", &more));
    // Nor is a part of what was OK'd.
    let part = Texts {
        pieces: vec!["deploy on Friday".into()],
        unread: vec![],
    };
    assert!(!approved_covers("Don't deploy on Friday", &part));
    // Title and body inside one OK'd text.
    let both = Texts {
        pieces: vec!["Broken nav".into(), "The menu won't open".into()],
        unread: vec![],
    };
    assert!(approved_covers("Broken nav\n\nThe menu won't open", &both));
    // Nothing known, or a file it couldn't read: never covered.
    assert!(!approved_covers("x", &Texts::default()));
    let unread = Texts {
        pieces: vec!["x".into()],
        unread: vec!["body.md".into()],
    };
    assert!(!approved_covers("x", &unread));
}

#[test]
fn a_variable_set_in_the_command_shows_its_words() {
    let t = texts(
        "Bash",
        &bash("F=\"Shipped the Kite fix\"\ngh pr comment 4 --body \"$F\""),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["Shipped the Kite fix".to_string()]);
    assert!(t.unread.is_empty());
    let t = texts(
        "Bash",
        &bash("F=$(cat <<'EOF'\nThe nav is fixed.\nEOF\n)\ngh pr comment 4 --body \"$F\""),
        None,
        &[],
    );
    assert_eq!(t.pieces, vec!["The nav is fixed.".to_string()]);
    assert!(t.unread.is_empty());
}

#[test]
fn a_variable_it_cannot_fill_is_said_not_shown() {
    let t = texts("Bash", &bash("gh pr comment 4 --body \"$F\""), None, &[]);
    assert!(t.pieces.is_empty());
    assert!(!t.complete());
    let card = card_block(&t);
    assert!(!card.contains("exactly:"));
    assert!(card.contains("can't read"), "{card}");
    // Built from a command's output: not resolved either.
    let t = texts(
        "Bash",
        &bash("F=$(date)\ngh pr comment 4 --body \"$F\""),
        None,
        &[],
    );
    assert!(!t.complete());
}
