//! Conversations in the runner (child of runner.rs): one turn answers in one
//! conversation, and what an interrupted turn left waits for its own.
use super::*;
use crate::agents::conversations::FIRST;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn said(text: &str, conversation: Option<&str>) -> Inbound {
    Inbound {
        id: store::new_id(),
        text: text.into(),
        from: From::User,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
        resume: 0,
        typed: Some(text.into()),
        conversation: conversation.map(str::to_string),
    }
}

fn queue(id: &str, items: Vec<Inbound>) {
    let mut runtimes = RUNTIMES.lock().unwrap();
    let r = runtimes.entry(id.to_string()).or_default();
    r.queue = items.into();
    r.running = true;
}

#[test]
fn a_turn_takes_one_conversation_at_a_time_in_order() {
    scratch(|| {
        let id = "conv-batch";
        queue(
            id,
            vec![
                said("first 1", Some(FIRST)),
                said("first 2", None),
                said("launch 1", Some("c-launch")),
                said("launch 2", Some("c-launch")),
                said("other", Some("c-other")),
                said("first 3", Some(FIRST)),
            ],
        );
        // An inbox from before conversations is the first's.
        let one = take_batch(id).unwrap();
        assert_eq!(one.conversation.as_deref(), Some(FIRST));
        assert!(one.prompt.contains("first 1") && one.prompt.contains("first 2"));
        assert!(!one.prompt.contains("launch"));
        let two = take_batch(id).unwrap();
        assert_eq!(two.conversation.as_deref(), Some("c-launch"));
        assert!(two.prompt.contains("launch 1") && two.prompt.contains("launch 2"));
        assert_eq!(
            RUNTIMES.lock().unwrap()[id].conversation.as_deref(),
            Some("c-launch")
        );
        assert_eq!(
            take_batch(id).unwrap().conversation.as_deref(),
            Some("c-other")
        );
        let last = take_batch(id).unwrap();
        assert!(last.prompt.contains("first 3"));
        assert!(take_batch(id).is_none());
        RUNTIMES.lock().unwrap().remove(id);
    });
}

#[test]
fn an_interruption_is_told_only_in_its_own_conversation() {
    scratch(|| {
        let id = "conv-interrupt";
        queue(id, vec![said("launch ask", Some("c-launch"))]);
        take_batch(id).unwrap();
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.get_mut(id).unwrap();
            r.interrupt = true;
        }
        assert!(take_interrupt(id));
        assert_eq!(
            RUNTIMES.lock().unwrap()[id].interrupted_in.as_deref(),
            Some("conversation:c-launch")
        );
        // A turn in another conversation isn't told; the next in its own is.
        queue(id, vec![said("elsewhere", Some(FIRST))]);
        let other = take_batch(id).unwrap();
        assert!(!other.prompt.contains("launch ask"));
        assert!(RUNTIMES.lock().unwrap()[id].interrupted.is_some());
        queue(id, vec![said("back", Some("c-launch"))]);
        let own = take_batch(id).unwrap();
        assert!(own.prompt.contains("launch ask"), "{}", own.prompt);
        RUNTIMES.lock().unwrap().remove(id);
    });
}

#[test]
fn places_are_rooms_then_conversations_with_the_first_as_none() {
    assert_eq!(place_of(None, None), None);
    assert_eq!(place_of(None, Some(FIRST)), None);
    assert_eq!(place_of(None, Some("c1")), Some("conversation:c1".into()));
    let room = crate::agents::rooms::RoomRef {
        room_id: "r1".into(),
        hop: 0,
        asker: crate::agents::rooms::Asker::User,
    };
    assert_eq!(place_of(Some(&room), Some("c1")), Some("r1".into()));
}

#[test]
fn a_recap_is_read_from_the_loaded_conversation_only() {
    scratch(|| {
        let a = store::create(store::NewAgent {
            name: "Recap".into(),
            role: "r".into(),
            instructions: "i".into(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let c = crate::agents::conversations::create(&a.id).unwrap().current;
        let mut mine = new_message(&a.id, MessageKind::User, "about the launch");
        mine.conversation = Some(c.clone());
        store::append_message(&mine).unwrap();
        let mut other = new_message(&a.id, MessageKind::User, "about taxes");
        other.conversation = Some(FIRST.into());
        store::append_message(&other).unwrap();
        store::update(&a.id, |a| {
            crate::agents::conversations::swap(a, &c);
        })
        .unwrap();
        let prompt = with_recap(&a.id, "go on");
        assert!(prompt.contains("about the launch"), "{prompt}");
        assert!(!prompt.contains("about taxes"), "{prompt}");
    });
}
