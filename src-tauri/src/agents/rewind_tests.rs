//! Rewind, fork and edit (child of rewind.rs).
use super::*;
use crate::agents::conversations::FIRST;
use crate::agents::runner;
use crate::agents::store::NewAgent;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str) -> store::Agent {
    store::create(NewAgent {
        name: name.into(),
        role: "Does things".into(),
        instructions: "Be brief.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

/// Append a line to the agent's log, in `conversation`; its id.
fn say(agent_id: &str, kind: MessageKind, text: &str, conversation: &str) -> String {
    let mut m = runner::new_message(agent_id, kind, text);
    m.conversation = Some(conversation.to_string());
    store::append_message(&m).unwrap();
    m.id
}

fn texts(page: &[AgentMessage]) -> Vec<&str> {
    page.iter().map(|m| m.text.as_str()).collect()
}

fn fork_at(session: &str, at: &str) -> Branch {
    Branch::Fork {
        session: session.into(),
        at: at.into(),
    }
}

fn point(messages: &[&str], before: Branch) -> Point {
    Point {
        ts: 1,
        messages: messages.iter().map(|m| m.to_string()).collect(),
        before,
    }
}

#[test]
fn going_back_before_a_message_is_where_its_turn_started() {
    let points = vec![
        point(&["m1"], Branch::Blank),
        point(&["m2"], fork_at("s1", "e1")),
        point(&["m3", "m4"], fork_at("s1", "e2")),
        point(&["m5"], Branch::Recap),
    ];
    assert_eq!(plan(&points, "m1", Engine::Claude), Branch::Blank);
    assert_eq!(plan(&points, "m2", Engine::Claude), fork_at("s1", "e1"));
    assert_eq!(plan(&points, "m3", Engine::Claude), fork_at("s1", "e2"));
    // Batched behind another message: its turn's start would drop that one too.
    assert_eq!(plan(&points, "m4", Engine::Claude), Branch::Recap);
    assert_eq!(plan(&points, "m5", Engine::Claude), Branch::Recap);
    // Never noted (sent before this build): a recap.
    assert_eq!(plan(&points, "m0", Engine::Claude), Branch::Recap);
    // A Claude Code point means nothing to another engine; blank does.
    assert_eq!(plan(&points, "m2", Engine::Codex), Branch::Recap);
    assert_eq!(plan(&points, "m1", Engine::Codex), Branch::Blank);
}

#[test]
fn the_latest_turn_that_answered_a_message_wins() {
    // A lost session's retry noted the same message again, from a recap.
    let points = vec![
        point(&["m1"], fork_at("s1", "e1")),
        point(&["m1"], Branch::Recap),
    ];
    assert_eq!(plan(&points, "m1", Engine::Claude), Branch::Recap);
}

#[test]
fn a_turn_starts_from_its_session_its_branch_or_nothing() {
    let claude = Engine::Claude;
    assert_eq!(
        start_point(claude, true, "s1", Some("e9".into()), None, false),
        fork_at("s1", "e9")
    );
    // Resumed with no entry to name, or on another engine: a recap.
    assert_eq!(
        start_point(claude, true, "s1", None, None, false),
        Branch::Recap
    );
    assert_eq!(
        start_point(Engine::OpenCode, true, "t1", Some("e9".into()), None, false),
        Branch::Recap
    );
    // A new session: the branch it was forked from, else blank or a recap.
    let fork = fork_at("s0", "e0");
    assert_eq!(
        start_point(claude, false, "s2", None, Some(&fork), false),
        fork
    );
    assert_eq!(
        start_point(claude, false, "s2", None, None, false),
        Branch::Blank
    );
    assert_eq!(
        start_point(claude, false, "s2", None, None, true),
        Branch::Recap
    );
}

#[test]
fn rewinding_folds_what_came_after_and_never_rewrites_the_log() {
    scratch(|| {
        let a = agent("Writer");
        let m1 = say(&a.id, MessageKind::User, "Draft the launch post", FIRST);
        say(&a.id, MessageKind::Agent, "Here's a draft.", FIRST);
        let m2 = say(&a.id, MessageKind::User, "Make it about pricing", FIRST);
        say(
            &a.id,
            MessageKind::Agent,
            "Rewritten around pricing.",
            FIRST,
        );
        note_turn(&a.id, &[m1.clone()], Branch::Blank);
        note_turn(&a.id, std::slice::from_ref(&m2), fork_at("s1", "e1"));
        store::update(&a.id, |x| x.session_id = Some("s2".into())).unwrap();
        let log_before =
            std::fs::read_to_string(store::agent_home(&a.id).unwrap().join("messages.jsonl"))
                .unwrap();

        let done = rewind(&a.id, FIRST, &m2).unwrap();
        // The log is as it was; the line is the command's to record.
        let home = store::agent_home(&a.id).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("messages.jsonl")).unwrap(),
            log_before
        );
        assert!(done.line.text.starts_with("Went back to before “Make it about pricing”. It and the message after it are folded above"), "{}", done.line.text);
        assert!(done.line.text.contains(NOT_UNDONE));
        assert!(!done.line.text.contains(RECAP_CLAUSE));
        assert_eq!(done.line.conversation.as_deref(), Some(FIRST));
        let first = done
            .conversations
            .items
            .iter()
            .find(|c| c.id == FIRST)
            .unwrap();
        assert_eq!(first.rewinds.len(), 1);
        assert_eq!(first.rewinds[0].at, m2);
        assert_eq!(first.rewinds[0].ids.len(), 2);

        // The session went; the branch waits for the next turn.
        assert_eq!(store::get(&a.id).unwrap().session_id, None);
        assert_eq!(
            pending(&a.id, FIRST, false).map(|p| p.branch),
            Some(fork_at("s1", "e1"))
        );
        // The chat still has every line; what a recap reads hasn't the folded ones.
        let page = store::conversation_page(&a.id, FIRST, usize::MAX, None, None).unwrap();
        assert_eq!(page.len(), 4);
        let shown = visible(&a.id, FIRST).unwrap();
        assert_eq!(texts(&shown), ["Draft the launch post", "Here's a draft."]);
        // Once a session is back, the branch is spent.
        assert_eq!(pending(&a.id, FIRST, true), None);
        assert_eq!(pending(&a.id, FIRST, false), None);
    });
}

#[test]
fn a_rewind_with_no_exact_point_says_it_picks_up_from_a_recap() {
    scratch(|| {
        let a = agent("Writer");
        say(&a.id, MessageKind::User, "One", FIRST);
        let m2 = say(&a.id, MessageKind::User, "Two\nmore", FIRST);
        let done = rewind(&a.id, FIRST, &m2).unwrap();
        assert!(done.line.text.contains("“Two”. It is folded above"));
        assert!(done.line.text.ends_with(RECAP_CLAUSE));
        assert_eq!(
            pending(&a.id, FIRST, false).map(|p| p.branch),
            Some(Branch::Recap)
        );
    });
}

#[test]
fn only_the_users_own_visible_messages_can_be_gone_back_to() {
    scratch(|| {
        let a = agent("Writer");
        let m1 = say(&a.id, MessageKind::User, "One", FIRST);
        let r1 = say(&a.id, MessageKind::Agent, "Reply", FIRST);
        let err = rewind(&a.id, FIRST, &r1).unwrap_err().to_string();
        assert!(err.contains("Only your own messages"), "{err}");
        let err = rewind(&a.id, FIRST, "nope").unwrap_err().to_string();
        assert!(err.contains("isn't in this conversation"), "{err}");
        // Folded already: it isn't there to go back to.
        rewind(&a.id, FIRST, &m1).unwrap();
        let err = rewind(&a.id, FIRST, &m1).unwrap_err().to_string();
        assert!(err.contains("isn't in this conversation"), "{err}");
        // In another conversation: not this one's.
        let list = conversations::create(&a.id).unwrap();
        let other = list.current.clone();
        let m3 = say(&a.id, MessageKind::User, "Elsewhere", &other);
        assert!(rewind(&a.id, FIRST, &m3).is_err());
    });
}

#[test]
fn forking_makes_a_conversation_from_what_came_before_and_leaves_the_original() {
    scratch(|| {
        let a = agent("Writer");
        let m1 = say(&a.id, MessageKind::User, "Plan the launch", FIRST);
        say(&a.id, MessageKind::Agent, "Plan v1.", FIRST);
        let m2 = say(&a.id, MessageKind::User, "Now cut the budget", FIRST);
        say(&a.id, MessageKind::Agent, "Budget cut.", FIRST);
        note_turn(&a.id, &[m1.clone()], Branch::Blank);
        note_turn(&a.id, std::slice::from_ref(&m2), fork_at("s1", "e1"));
        store::update(&a.id, |x| x.session_id = Some("s2".into())).unwrap();

        let done = fork(&a.id, FIRST, &m2).unwrap();
        let fork_id = done.conversations.current.clone();
        assert_ne!(fork_id, FIRST);
        let item = done
            .conversations
            .items
            .iter()
            .find(|c| c.id == fork_id)
            .unwrap();
        assert_eq!(item.title, "Fork of Plan the launch");
        let from = item.forked_from.as_ref().unwrap();
        assert_eq!(
            (from.conversation.as_str(), from.message.as_str()),
            (FIRST, m2.as_str())
        );
        assert_eq!(from.title, "Plan the launch");
        assert!(done.line.text.starts_with(
            "Forked from “Plan the launch” before “Now cut the budget”. That one is unchanged."
        ));
        assert_eq!(done.line.conversation.as_deref(), Some(fork_id.as_str()));

        // The fork's chat is the history it was made with, then its own.
        store::append_message(&done.line).unwrap();
        let page = store::conversation_page(&a.id, &fork_id, usize::MAX, None, None).unwrap();
        assert_eq!(texts(&page)[..2], ["Plan the launch", "Plan v1."]);
        assert_eq!(page.len(), 3);
        // Paged too.
        let last_two = store::conversation_page(&a.id, &fork_id, 2, None, None).unwrap();
        assert_eq!(last_two.len(), 2);
        assert_eq!(last_two[0].text, "Plan v1.");

        // The original: its session, its lines, no rewinds.
        assert_eq!(store::get(&a.id).unwrap().session_id.as_deref(), Some("s2"));
        let original = store::conversation_page(&a.id, FIRST, usize::MAX, None, None).unwrap();
        assert_eq!(original.len(), 4);
        assert!(done
            .conversations
            .items
            .iter()
            .find(|c| c.id == FIRST)
            .unwrap()
            .rewinds
            .is_empty());
        // The fork's first turn starts where the original stood before m2.
        assert_eq!(
            pending(&a.id, &fork_id, false).map(|p| p.branch),
            Some(fork_at("s1", "e1"))
        );
        assert_eq!(pending(&a.id, FIRST, false), None);
    });
}

#[test]
fn a_fork_of_a_fork_carries_the_whole_history() {
    scratch(|| {
        let a = agent("Writer");
        say(&a.id, MessageKind::User, "One", FIRST);
        let m2 = say(&a.id, MessageKind::User, "Two", FIRST);
        let f1 = fork(&a.id, FIRST, &m2).unwrap().conversations.current;
        let m3 = say(&a.id, MessageKind::User, "Three", &f1);
        let f2 = fork(&a.id, &f1, &m3).unwrap().conversations.current;
        let page = store::conversation_page(&a.id, &f2, usize::MAX, None, None).unwrap();
        assert_eq!(texts(&page), ["One"]);
        // Rewinding a fork may fold what it inherited.
        let m4 = say(&a.id, MessageKind::User, "Four", &f1);
        let first_line = store::conversation_page(&a.id, &f1, usize::MAX, None, None).unwrap()[0]
            .id
            .clone();
        rewind(&a.id, &f1, &first_line).unwrap();
        let spec = conversations::page_spec(&a.id, &f1);
        assert!(spec.rewound.contains(&m4) && spec.rewound.contains(&first_line));
        // The original never sees any of it.
        assert!(conversations::page_spec(&a.id, FIRST).rewound.is_empty());
    });
}

#[test]
fn a_fork_of_a_session_that_read_outside_content_carries_the_mark() {
    scratch(|| {
        let a = agent("Writer");
        let m1 = say(&a.id, MessageKind::User, "One", FIRST);
        set_pending(
            &a.id,
            FIRST,
            Pending {
                branch: Branch::Blank,
                exposed: true,
            },
        );
        assert!(carries_outside(&a.id, FIRST, false));
        assert!(!carries_outside(&a.id, FIRST, true));
        let _ = m1;
    });
}

#[test]
fn points_are_kept_within_bounds() {
    scratch(|| {
        let a = agent("Writer");
        for i in 0..(MAX_POINTS + MAX_POINTS / 2 + 1) {
            note_turn(&a.id, &[format!("m{i}")], Branch::Blank);
        }
        let kept = points(&a.id);
        assert_eq!(kept.len(), MAX_POINTS);
        assert_eq!(
            kept.last().unwrap().messages,
            [format!("m{}", MAX_POINTS + MAX_POINTS / 2)]
        );
        // A turn that answers nothing isn't noted.
        note_turn(&a.id, &[], Branch::Blank);
        assert_eq!(points(&a.id).len(), MAX_POINTS);
    });
}

#[test]
fn quotes_and_titles_fit() {
    assert_eq!(
        quote("> earlier\n\n  Fix the header  \nthanks"),
        "Fix the header"
    );
    assert_eq!(
        quote("Write a very long message that goes on and on past forty"),
        "Write a very long message that goes on a…"
    );
    assert_eq!(conversations::fork_title(""), "");
    assert_eq!(
        conversations::fork_title("Launch plan"),
        "Fork of Launch plan"
    );
    let long = "x".repeat(70);
    let t = conversations::fork_title(&long);
    assert_eq!(t.chars().count(), conversations::TITLE_CHARS);
    assert!(t.ends_with('…'));
}

#[test]
fn codex_goes_back_by_forking_its_thread_through_the_turn_before() {
    let codex = Branch::CodexFork {
        thread: "t1".into(),
        turn: "u3".into(),
    };
    assert_eq!(
        start_point(Engine::Codex, true, "t1", Some("u3".into()), None, false),
        codex
    );
    // No turn seen in that thread (an exec fallback, an older build): a recap.
    assert_eq!(
        start_point(Engine::Codex, true, "t1", None, None, false),
        Branch::Recap
    );
    let points = vec![point(&["m1"], codex.clone())];
    assert_eq!(plan(&points, "m1", Engine::Codex), codex);
    assert_eq!(plan(&points, "m1", Engine::Claude), Branch::Recap);
    // A fork that fell back starts from a recap, whatever was pending.
    assert_eq!(
        start_point(
            Engine::Claude,
            false,
            "s2",
            None,
            Some(&Branch::Recap),
            true
        ),
        Branch::Recap
    );
}

#[test]
fn codex_turn_ids_are_kept_per_thread_and_a_fallback_keeps_the_mark() {
    scratch(|| {
        let a = agent("Coder");
        assert_eq!(codex_last_turn(&a.id, "t1"), None);
        note_codex_turn(&a.id, "t1", "u1");
        note_codex_turn(&a.id, "t1", "u2");
        note_codex_turn(&a.id, "t2", "v1");
        assert_eq!(codex_last_turn(&a.id, "t1").as_deref(), Some("u2"));
        assert_eq!(codex_last_turn(&a.id, "t2").as_deref(), Some("v1"));

        set_pending(
            &a.id,
            FIRST,
            Pending {
                branch: fork_at("s1", "e1"),
                exposed: true,
            },
        );
        fell_back(&a.id, FIRST);
        let p = pending(&a.id, FIRST, false).unwrap();
        assert_eq!(p.branch, Branch::Recap);
        assert!(p.exposed, "a fallback dropped the outside-content mark");
    });
}
