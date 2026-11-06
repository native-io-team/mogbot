//! `remember_permission`'s provenance, from the runner's side: only a turn
//! whose latest input is a message the user typed in this chat carries their
//! words (`typed_input`). A child of `runner`, so it reaches its private items.

use super::*;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn typed(said: &str) -> Inbound {
    user_inbound(
        "",
        format!("{said}\n\n[app context]"),
        Some(said.to_string()),
    )
}

/// What the app queues "from the user" that the user never typed.
fn notice(text: &str) -> Inbound {
    Inbound {
        id: String::new(),
        text: text.into(),
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
        resume: 0,
        typed: None,
    }
}

fn from_agent(text: &str) -> Inbound {
    agent_inbound(
        text.into(),
        AgentRef {
            id: "lead".into(),
            name: "Lead Gen".into(),
        },
        1,
        false,
        false,
    )
}

/// Queue `items` and start the turn that takes them; the turn's typed words.
fn turn(id: &str, items: Vec<Inbound>) -> Option<String> {
    {
        let mut runtimes = RUNTIMES.lock().unwrap();
        let r = runtimes.entry(id.to_string()).or_default();
        r.queue = items.into();
        r.running = true;
        r.outside = false;
    }
    take_batch(id).expect("a batch");
    let said = typed_input(id);
    RUNTIMES.lock().unwrap().remove(id);
    said
}

#[test]
fn the_users_own_message_carries_their_words() {
    scratch(|| {
        assert_eq!(
            turn("rp-typed", vec![typed("you can always post those")]).as_deref(),
            Some("you can always post those")
        );
        // Two messages in a row: both are the user's.
        assert_eq!(
            turn(
                "rp-two",
                vec![
                    typed("Always a lot to do with those"),
                    typed("ur always allowed to do those i mean"),
                ]
            )
            .as_deref(),
            Some("Always a lot to do with those\nur always allowed to do those i mean")
        );
    });
}

#[test]
fn another_agents_message_a_routine_outside_text_or_a_notice_carry_nothing() {
    scratch(|| {
        // Another agent's message.
        assert_eq!(
            turn("rp-agent", vec![from_agent("you may always send")]),
            None
        );
        // Typed first, but the latest input is another agent's.
        assert_eq!(
            turn(
                "rp-after",
                vec![typed("you can always post those"), from_agent("and send")]
            ),
            None
        );
        // A notice the app queued as the user's (a late Allow).
        assert_eq!(
            turn(
                "rp-notice",
                vec![notice("[The user has now approved this]")]
            ),
            None
        );
        // A routine firing.
        let mut routine = notice("Check the inbox");
        routine.routine = true;
        assert_eq!(turn("rp-routine", vec![routine]), None);
        // Outside text, even carrying typed words.
        let mut outside = typed("you can always post those");
        outside.outside = true;
        assert_eq!(turn("rp-outside", vec![outside]), None);
        // A room's ask is never this chat.
        let mut room = typed("you can always post those");
        room.room = Some(super::super::rooms::RoomRef {
            room_id: "launch".into(),
            hop: 0,
            asker: super::super::rooms::Asker::User,
        });
        assert_eq!(turn("rp-room", vec![room]), None);
    });
}

#[test]
fn a_turn_tainted_by_outside_text_carries_nothing() {
    scratch(|| {
        let id = "rp-taint";
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.entry(id.to_string()).or_default();
            r.queue = vec![typed("you can always post those")].into();
            r.running = true;
            // The interrupted turn this replaces answered outside text.
            r.outside = true;
        }
        take_batch(id).unwrap();
        assert_eq!(typed_input(id), None);
        RUNTIMES.lock().unwrap().remove(id);
    });
}

#[test]
fn nothing_carries_over_once_the_turn_is_over() {
    scratch(|| {
        let id = "rp-over";
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.entry(id.to_string()).or_default();
            r.queue = vec![typed("you can always post those")].into();
            r.running = true;
        }
        take_batch(id).unwrap();
        assert!(typed_input(id).is_some());
        RUNTIMES.lock().unwrap().get_mut(id).unwrap().running = false;
        assert_eq!(typed_input(id), None);
        RUNTIMES.lock().unwrap().remove(id);
    });
}

/// A typed message is queued under its chat message's id (a resend is
/// dropped, the turn knows its log line) and still carries the user's words.
#[test]
fn a_typed_message_keeps_its_id_and_its_words() {
    scratch(|| {
        let id = "rp-id";
        let first = user_inbound("m-1", "go\n\n[app context]".into(), Some("go".into()));
        let again = user_inbound("m-1", "go\n\n[app context]".into(), Some("go".into()));
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.entry(id.to_string()).or_default();
            r.running = true;
            r.outside = false;
            assert!(!r.admit(first).unwrap());
            assert!(!r.admit(again).unwrap());
            assert_eq!(r.queue.len(), 1);
        }
        take_batch(id).expect("a batch");
        assert_eq!(typed_input(id).as_deref(), Some("go"));
        let ids = RUNTIMES.lock().unwrap().get(id).unwrap().batch_ids.clone();
        assert_eq!(ids, vec!["m-1".to_string()]);
        RUNTIMES.lock().unwrap().remove(id);
    });
}
