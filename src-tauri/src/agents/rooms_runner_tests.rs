//! Rooms in the runner (child of runner.rs): a turn answers in one place,
//! and a room's Stop leaves the agent's own chat alone.
use super::*;
use crate::agents::rooms::RoomRef;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn direct(text: &str) -> Inbound {
    Inbound {
        id: store::new_id(),
        text: text.into(),
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
    }
}

fn in_room(room: &str, text: &str, hop: u8, from_name: &str) -> Inbound {
    Inbound {
        room: Some(RoomRef {
            room_id: room.into(),
            hop,
            from_name: from_name.into(),
        }),
        ..direct(text)
    }
}

fn queue(id: &str, items: Vec<Inbound>) {
    let mut runtimes = RUNTIMES.lock().unwrap();
    let r = runtimes.entry(id.to_string()).or_default();
    r.queue = items.into();
    r.running = true;
}

#[test]
fn a_turn_takes_one_place_at_a_time_in_order() {
    scratch(|| {
        let id = "rm-batch";
        queue(
            id,
            vec![
                direct("own 1"),
                direct("own 2"),
                in_room("launch", "room 1", 0, ""),
                in_room("launch", "room 2", 2, "Ops"),
                in_room("other", "elsewhere", 0, ""),
                direct("own 3"),
            ],
        );
        // The agent's own chat first, both lines as one turn, and no room.
        let first = take_batch(id).unwrap();
        assert!(first.room.is_none());
        assert!(first.prompt.contains("own 1") && first.prompt.contains("own 2"));
        assert!(!first.prompt.contains("room 1"));
        assert!(turn_room(id).is_none());
        // Then the room: one turn for both asks, at the deepest hop.
        let second = take_batch(id).unwrap();
        let room = second.room.expect("a room turn");
        assert_eq!(room.room.room_id, "launch");
        assert_eq!(room.room.hop, 2);
        assert_eq!(
            room.asked,
            vec![
                (String::new(), "room 1".to_string()),
                ("Ops".to_string(), "room 2".to_string())
            ]
        );
        assert_eq!(turn_room(id).unwrap().room_id, "launch");
        // A room ask owes no agent an answer (it's answered in the room).
        assert!(RUNTIMES.lock().unwrap().get(id).unwrap().owed.is_empty());
        // Another room is another turn; then the agent's own chat again.
        assert_eq!(take_batch(id).unwrap().room.unwrap().room.room_id, "other");
        let last = take_batch(id).unwrap();
        assert!(last.room.is_none() && last.prompt.contains("own 3"));
        assert!(take_batch(id).is_none());
        RUNTIMES.lock().unwrap().remove(id);
    });
}

#[test]
fn stopping_a_room_drops_only_what_was_asked_there() {
    scratch(|| {
        let id = "rm-stop";
        queue(
            id,
            vec![
                in_room("launch", "room ask", 0, ""),
                direct("my own question"),
                in_room("other", "elsewhere", 0, ""),
            ],
        );
        assert!(queued_for_room(id, "launch"));
        assert!(stop_in_room(id, "launch"));
        assert!(!queued_for_room(id, "launch"));
        assert!(queued_for_room(id, "other"));
        let left: Vec<String> = RUNTIMES.lock().unwrap()[id]
            .queue
            .iter()
            .map(|m| m.text.clone())
            .collect();
        assert_eq!(left, vec!["my own question", "elsewhere"]);
        // A turn answering in the room is told to stop; one elsewhere is not.
        let cancel = Arc::new(Notify::new());
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.get_mut(id).unwrap();
            r.cancel = Some(cancel.clone());
            r.room = Some(RoomRef {
                room_id: "other".into(),
                hop: 0,
                from_name: String::new(),
            });
        }
        assert!(!stop_in_room(id, "launch"), "nothing of launch's left");
        assert!(stop_in_room(id, "other"));
        assert!(
            !RUNTIMES.lock().unwrap()[id].interrupt,
            "a stop, not an interruption"
        );
        RUNTIMES.lock().unwrap().remove(id);
    });
}

#[test]
fn only_what_a_turn_says_belongs_to_its_room() {
    for kind in [
        MessageKind::Agent,
        MessageKind::Approval,
        MessageKind::Error,
        MessageKind::Note,
        MessageKind::SentToAgent,
        MessageKind::Changes,
        MessageKind::Session,
    ] {
        assert!(said_in_turn(kind), "{kind:?}");
    }
    // The user's own line, another agent's request, a check-in firing: they
    // land in the agent's own chat even while it answers in a room.
    for kind in [
        MessageKind::User,
        MessageKind::FromAgent,
        MessageKind::CheckIn,
    ] {
        assert!(!said_in_turn(kind), "{kind:?}");
    }
}

#[test]
fn a_status_says_which_room_its_turn_is_in_and_idle_says_none() {
    scratch(|| {
        let id = "rm-status";
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.entry(id.to_string()).or_default();
            r.room = Some(RoomRef {
                room_id: "launch".into(),
                hop: 0,
                from_name: String::new(),
            });
        }
        let mut working = Status::working("Thinking".into());
        with_work(id, &mut working);
        assert_eq!(working.room.as_deref(), Some("launch"));
        let mut idle = Status::idle();
        with_work(id, &mut idle);
        assert_eq!(idle.room, None);
        // The worker going idle forgets the room.
        RUNTIMES.lock().unwrap().get_mut(id).unwrap().running = true;
        assert!(finish_if_idle(id).is_some());
        assert!(turn_room(id).is_none());
        RUNTIMES.lock().unwrap().remove(id);
    });
}

#[test]
fn an_inbox_written_before_rooms_still_reads() {
    let old = r#"{"id":"a","text":"hi","from":"User","reply":false,"routine":false}"#;
    let inbound: Inbound = serde_json::from_str(old).unwrap();
    assert!(inbound.room.is_none());
    let saved = serde_json::to_string(&in_room("launch", "x", 1, "Ops")).unwrap();
    let back: Inbound = serde_json::from_str(&saved).unwrap();
    assert_eq!(back.room.unwrap().from_name, "Ops");
}
