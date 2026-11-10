//! Several conversations with one agent (child of conversations.rs).
use super::*;
use crate::agents::runner;
use crate::agents::store::{AgentMessage, MessageKind, NewAgent};

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str) -> Agent {
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

fn line(agent_id: &str, kind: MessageKind, text: &str, conversation: Option<&str>) -> AgentMessage {
    let mut m = runner::new_message(agent_id, kind, text);
    m.conversation = conversation.map(str::to_string);
    m
}

/// A line as an older build wrote it: no conversation at all.
fn legacy(agent_id: &str, kind: MessageKind, text: &str) -> String {
    let mut v = serde_json::to_value(runner::new_message(agent_id, kind, text)).unwrap();
    v.as_object_mut().unwrap().remove("conversation");
    serde_json::to_string(&v).unwrap()
}

fn texts(page: &[AgentMessage]) -> Vec<&str> {
    page.iter().map(|m| m.text.as_str()).collect()
}

fn fill(used: u64) -> crate::agents::context::ContextFill {
    crate::agents::context::ContextFill {
        used,
        window: 200_000,
        at: 1,
        model: None,
    }
}

#[test]
fn the_existing_chat_is_the_first_conversation_and_nothing_moves() {
    scratch(|| {
        let a = agent("Finance");
        let home = store::agent_home(&a.id).unwrap();
        let log = [
            legacy(&a.id, MessageKind::Agent, "Hi, I'm Finance."),
            legacy(
                &a.id,
                MessageKind::User,
                "> quoted\nSort out the March invoices please",
            ),
            legacy(&a.id, MessageKind::Agent, "On it."),
        ]
        .join("\n")
            + "\n";
        std::fs::write(home.join("messages.jsonl"), &log).unwrap();

        let list = super::list(&a.id).unwrap();
        assert_eq!(list.current, FIRST);
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].id, FIRST);
        assert_eq!(list.items[0].title, "Sort out the March invoices");
        assert!(list.items[0].loaded && list.items[0].current);
        // Reading the list writes nothing; the log is untouched.
        assert!(!home.join("conversations.json").exists());
        assert_eq!(
            std::fs::read_to_string(home.join("messages.jsonl")).unwrap(),
            log
        );
        // Every old line is the first conversation's, in order.
        let page = store::conversation_page(&a.id, FIRST, 50, None, None).unwrap();
        assert_eq!(
            texts(&page),
            vec![
                "Hi, I'm Finance.",
                "> quoted\nSort out the March invoices please",
                "On it."
            ]
        );
    });
}

#[test]
fn each_conversation_reads_only_its_own_lines_and_pages_back() {
    scratch(|| {
        let a = agent("Ops");
        store::append_message(&line(&a.id, MessageKind::User, "first one", Some(FIRST))).unwrap();
        let made = create(&a.id).unwrap();
        let second = made.current.clone();
        assert_ne!(second, FIRST);
        for i in 0..5 {
            store::append_message(&line(
                &a.id,
                MessageKind::User,
                &format!("second {i}"),
                Some(&second),
            ))
            .unwrap();
            store::append_message(&line(
                &a.id,
                MessageKind::Agent,
                &format!("first reply {i}"),
                Some(FIRST),
            ))
            .unwrap();
        }
        let mine = store::conversation_page(&a.id, &second, 3, None, None).unwrap();
        assert_eq!(texts(&mine), vec!["second 2", "second 3", "second 4"]);
        let older = store::conversation_page(&a.id, &second, 3, Some(&mine[0].id), None).unwrap();
        assert_eq!(texts(&older), vec!["second 0", "second 1"]);
        let first = store::conversation_page(&a.id, FIRST, usize::MAX, None, None).unwrap();
        assert_eq!(first.len(), 6);
        assert!(first.iter().all(|m| !m.text.starts_with("second")));
        // The whole log, for an older client that names none: everything.
        assert_eq!(store::messages(&a.id, 100).unwrap().len(), 11);
    });
}

#[test]
fn a_line_that_does_not_say_goes_to_the_loaded_conversation() {
    scratch(|| {
        let a = agent("Writer");
        let second = create(&a.id).unwrap().current;
        // Nothing loaded yet: the first.
        store::append_message(&line(&a.id, MessageKind::Note, "before", None)).unwrap();
        store::update(&a.id, |a| {
            swap(a, &second);
        })
        .unwrap();
        store::append_message(&line(&a.id, MessageKind::Note, "after", None)).unwrap();
        let all = store::messages(&a.id, 10).unwrap();
        assert_eq!(all[0].conversation.as_deref(), Some(FIRST));
        assert_eq!(all[1].conversation.as_deref(), Some(second.as_str()));
        // The user's own message says where it was sent, wherever the agent is.
        store::append_message(&line(&a.id, MessageKind::User, "mine", Some(FIRST))).unwrap();
        assert_eq!(
            store::messages(&a.id, 1).unwrap()[0]
                .conversation
                .as_deref(),
            Some(FIRST)
        );
    });
}

#[test]
fn a_swap_parks_one_session_and_loads_the_other() {
    let mut a = scratch_agent();
    a.session_id = Some("s-first".into());
    a.context = Some(fill(150_000));
    a.away = Some(crate::agents::crossover::Away {
        engine: crate::agents::engine::Engine::Codex,
        session_id: Some("away-first".into()),
        since: 1,
        until: None,
        fresh: false,
    });

    assert!(swap(&mut a, "c2"));
    assert_eq!(loaded(&a), "c2");
    // A conversation that never ran starts a session of its own, no recap.
    assert_eq!(a.session_id, None);
    assert!(!a.new_engine);
    assert_eq!(a.context, None);
    assert_eq!(a.away.as_ref().unwrap().session_id, None);
    assert!(!swap(&mut a, "c2"), "already loaded");

    a.session_id = Some("s-c2".into());
    a.context = Some(fill(9_000));
    assert!(swap(&mut a, FIRST));
    assert_eq!(a.session_id.as_deref(), Some("s-first"));
    assert_eq!(a.context.as_ref().unwrap().used, 150_000);
    assert_eq!(
        a.away.as_ref().unwrap().session_id.as_deref(),
        Some("away-first")
    );
    assert_eq!(a.conversations.loaded, None, "the first is the default");
    let parked = &a.conversations.parked;
    assert_eq!(parked.len(), 1);
    assert_eq!(parked[0].id, "c2");
    assert_eq!(parked[0].session_id.as_deref(), Some("s-c2"));
}

#[test]
fn moving_engine_or_model_leaves_no_parked_session_behind() {
    let mut a = scratch_agent();
    a.session_id = Some("s-first".into());
    swap(&mut a, "c2");
    a.session_id = Some("s-c2".into());
    a.context = Some(fill(1));
    swap(&mut a, "c3");
    // c3 never ran: nothing parked for it once it is left.
    swap(&mut a, FIRST);
    a.set_model(Some("opus".into()));
    assert!(a.conversations.parked.iter().all(|p| p.context.is_none()));
    a.switch_engine(crate::agents::engine::Engine::Codex);
    let c2 = a
        .conversations
        .parked
        .iter()
        .find(|p| p.id == "c2")
        .unwrap();
    assert_eq!(c2.session_id, None);
    assert!(c2.new_engine, "it is handed its own chat as a recap");
    // Loading it carries the recap flag to the turn.
    swap(&mut a, "c2");
    assert!(a.new_engine);
}

fn scratch_agent() -> Agent {
    let raw = serde_json::json!({
        "id": "a1", "name": "A", "shape": 0, "color": "blue", "createdAt": 1
    });
    serde_json::from_value(raw).unwrap()
}

#[test]
fn new_conversation_reuses_an_empty_one_and_is_capped() {
    scratch(|| {
        let a = agent("Scout");
        let one = create(&a.id).unwrap();
        let again = create(&a.id).unwrap();
        assert_eq!(one.current, again.current, "two empty ones help no one");
        assert_eq!(again.items.len(), 2);
        // Once something is said in it, the next one is new.
        let said = line(
            &a.id,
            MessageKind::User,
            "Find me flights",
            Some(&one.current),
        );
        store::append_message(&said).unwrap();
        assert!(touch(&said, Some("Find me flights")));
        let two = create(&a.id).unwrap();
        assert_ne!(two.current, one.current);
        assert_eq!(two.items.len(), 3);
        assert!(two.items.iter().any(|i| i.id == two.current && i.current));
        // A conversation from the first's chat isn't "empty" by having no title.
        select(&a.id, FIRST).unwrap();
        assert_ne!(create(&a.id).unwrap().current, FIRST);
    });
}

#[test]
fn the_first_message_names_it_until_the_user_does() {
    scratch(|| {
        let a = agent("Namer");
        let c = create(&a.id).unwrap().current;
        let hello = line(&a.id, MessageKind::Agent, "Hello", Some(&c));
        assert!(
            !touch(&hello, Some("Hello")),
            "only the user's words name it"
        );
        let ask = line(
            &a.id,
            MessageKind::User,
            "Can you draft the quarterly investor update for the board, with the numbers from March",
            Some(&c),
        );
        assert!(touch(&ask, None));
        let list = super::list(&a.id).unwrap();
        let item = list.items.iter().find(|i| i.id == c).unwrap();
        assert_eq!(item.title, "Draft the quarterly investor update");
        assert!(item.title.chars().count() <= TITLE_CHARS);
        assert!(!touch(
            &line(&a.id, MessageKind::User, "and more", Some(&c)),
            None
        ));

        let renamed = rename(&a.id, &c, "  Investor   update ").unwrap();
        let item = renamed.items.iter().find(|i| i.id == c).unwrap();
        assert_eq!((item.title.as_str(), item.named), ("Investor update", true));
        assert!(rename(&a.id, &c, &"x".repeat(TITLE_CHARS + 1)).is_err());
        assert!(rename(&a.id, "nope", "Hi").is_err());
        // Cleared, the first conversation is named by its first message again.
        store::append_message(&line(&a.id, MessageKind::User, "Old ask", Some(FIRST))).unwrap();
        rename(&a.id, FIRST, "Mine").unwrap();
        let back = rename(&a.id, FIRST, "").unwrap();
        let first = back.items.iter().find(|i| i.id == FIRST).unwrap();
        assert_eq!((first.title.as_str(), first.named), ("Old ask", false));
    });
}

#[test]
fn select_moves_where_the_user_is_and_refuses_what_is_gone() {
    scratch(|| {
        let a = agent("Picker");
        let c = create(&a.id).unwrap().current;
        assert_eq!(current(&a.id), c);
        select(&a.id, FIRST).unwrap();
        assert_eq!(current(&a.id), FIRST);
        assert!(select(&a.id, "gone").is_err());
        assert!(exists(&a.id, &c) && exists(&a.id, FIRST) && !exists(&a.id, "gone"));
    });
}

#[test]
fn cards_say_which_conversation_waits_on_the_user() {
    scratch(|| {
        let a = agent("Asker");
        let c = create(&a.id).unwrap().current;
        let mut card = line(&a.id, MessageKind::Approval, "", Some(&c));
        card.approval = Some(serde_json::from_value(serde_json::json!({
            "requestId": "r1", "tool": "Bash", "title": "Run a script", "detail": "", "status": "pending"
        }))
        .unwrap());
        store::append_message(&card).unwrap();
        let list = super::list(&a.id).unwrap();
        let waiting: Vec<(String, u32)> = list
            .items
            .iter()
            .map(|i| (i.id.clone(), i.waiting))
            .collect();
        assert!(waiting.contains(&(c.clone(), 1)));
        assert!(waiting.contains(&(FIRST.to_string(), 0)));
    });
}

#[test]
fn a_routine_runs_where_it_was_set_up() {
    scratch(|| {
        let a = agent("Routines");
        // With only the first conversation, nothing is written for it.
        note_routine(&a.id, "r-old");
        assert!(!store::agent_home(&a.id)
            .unwrap()
            .join("conversations.json")
            .exists());
        assert_eq!(routine_in(&a.id, "r-old"), FIRST);
        let c = create(&a.id).unwrap().current;
        store::update(&a.id, |a| {
            a.check_ins.push(
                serde_json::from_value(serde_json::json!({
                    "id": "r-new", "note": "Check mail", "nextAt": 1, "createdAt": 1
                }))
                .unwrap(),
            );
        })
        .unwrap();
        note_routine(&a.id, "r-new");
        assert_eq!(routine_in(&a.id, "r-new"), c);
        assert_eq!(routine_in(&a.id, "unknown"), FIRST);
        let list = super::list(&a.id).unwrap();
        assert_eq!(list.routines.get("r-new"), Some(&c));
    });
}

#[test]
fn an_answer_goes_back_to_the_conversation_that_asked() {
    scratch(|| {
        let asker = agent("Chief");
        let helper = agent("Helper");
        let c = create(&asker.id).unwrap().current;
        store::update(&asker.id, |a| {
            swap(a, &c);
        })
        .unwrap();
        note_asked(&asker.id, &helper.id);
        // The asker moves on to another conversation meanwhile.
        store::update(&asker.id, |a| {
            swap(a, FIRST);
        })
        .unwrap();
        assert_eq!(asked_in(&asker.id, &helper.id), Some(c.clone()));
        assert_eq!(asked_in(&helper.id, &asker.id), None);
        // Kept on disk, not in memory: an answer after a restart still goes back.
        let raw = std::fs::read_to_string(
            store::agent_home(&asker.id)
                .unwrap()
                .join("conversations.json"),
        )
        .unwrap();
        let saved: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(saved["asked"][&helper.id]["conversation"], c.as_str());
        // Asked again from the first: the latest ask wins.
        note_asked(&asker.id, &helper.id);
        assert_eq!(asked_in(&asker.id, &helper.id).as_deref(), Some(FIRST));
    });
}

#[test]
fn what_was_asked_stays_small() {
    scratch(|| {
        let asker = agent("Busy");
        for i in 0..(MAX_ASKED + 10) {
            note_asked(&asker.id, &format!("helper-{i}"));
        }
        let raw = std::fs::read_to_string(
            store::agent_home(&asker.id)
                .unwrap()
                .join("conversations.json"),
        )
        .unwrap();
        let saved: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(saved["asked"].as_object().unwrap().len(), MAX_ASKED);
        // The newest are kept.
        let last = format!("helper-{}", MAX_ASKED + 9);
        assert_eq!(asked_in(&asker.id, &last).as_deref(), Some(FIRST));
    });
}

#[test]
fn a_routine_can_be_moved_to_another_conversation() {
    scratch(|| {
        let a = agent("Mover");
        let c = create(&a.id).unwrap().current;
        store::update(&a.id, |a| {
            a.check_ins.push(
                serde_json::from_value(serde_json::json!({
                    "id": "r1", "note": "Check mail", "nextAt": 1, "createdAt": 1
                }))
                .unwrap(),
            );
        })
        .unwrap();
        assert_eq!(routine_in(&a.id, "r1"), FIRST);
        let moved = move_routine(&a.id, "r1", &c).unwrap();
        assert_eq!(moved.routines.get("r1"), Some(&c));
        assert_eq!(routine_in(&a.id, "r1"), c);
        let back = move_routine(&a.id, "r1", FIRST).unwrap();
        assert!(back.routines.get("r1").is_none());
        assert_eq!(routine_in(&a.id, "r1"), FIRST);
        assert!(move_routine(&a.id, "r1", "gone").is_err());
        assert!(move_routine(&a.id, "nope", &c).is_err());
    });
}

#[test]
fn titles_are_one_clean_line() {
    assert_eq!(title_from("  hello\n\nworld"), "Hello");
    assert_eq!(title_from("> a quote\n> more"), "A quote");
    assert_eq!(title_from("> a quote\nmy words"), "My words");
    assert_eq!(title_from("tabs\tand   spaces"), "Tabs and spaces");
    assert_eq!(title_from(""), "");
    let t = title_from(&"word ".repeat(30));
    assert!(t.chars().count() <= TITLE_CHARS && !t.ends_with('…'));
}

#[test]
fn an_older_builds_automatic_title_is_tidied_on_read_and_a_typed_one_kept() {
    scratch(|| {
        let a = agent("Tidy");
        let c = create(&a.id).unwrap().current;
        // As an older build wrote them: the raw first line, clipped with "…".
        let path = store::agent_home(&a.id).unwrap().join("conversations.json");
        let mut raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for item in raw["items"].as_array_mut().unwrap() {
            if item["id"] == c.as_str() {
                item["title"] = "I Kind of like B with a hint of A. L…".into();
            } else {
                item["title"] = "can you keep MY name.".into();
                item["named"] = true.into();
            }
        }
        std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();

        let list = super::list(&a.id).unwrap();
        let title = |id: &str| {
            list.items
                .iter()
                .find(|i| i.id == id)
                .unwrap()
                .title
                .clone()
        };
        assert_eq!(title(&c), "I kind of like B with a hint of A");
        assert_eq!(title(FIRST), "can you keep MY name.");
    });
}
