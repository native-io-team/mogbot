//! The labels-only guard in the runner (`share_text`): a finished turn that
//! was asked for text and sent only labelled files leaves its next turn in
//! the agent's own chat a quiet note, and the note is read once.

use super::*;
use crate::agents::attachments::Attachment;
use crate::agents::share_text;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str) -> store::Agent {
    store::create(store::NewAgent {
        name: name.into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn user(text: &str) -> Inbound {
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

fn shared(agent_id: &str, text: &str) -> AgentMessage {
    let mut m = new_message(agent_id, MessageKind::Agent, text);
    m.attachments = vec![Attachment {
        name: "post-1.png".into(),
        path: "attachments/m1/post-1.png".into(),
        mime: "image/png".into(),
        size: 10,
    }];
    m
}

fn queue(agent_id: &str, text: &str) -> Batch {
    {
        let mut rt = RUNTIMES.lock().unwrap();
        let r = rt.entry(agent_id.to_string()).or_default();
        r.running = true;
        r.queue.push_back(user(text));
    }
    let batch = take_batch(agent_id).expect("a batch");
    clear_mark(agent_id);
    batch
}

#[test]
fn a_labels_only_reply_to_asking_for_text_tells_the_next_turn_once() {
    scratch(|| {
        let a = agent("Social");
        let asked = queue(&a.id, "FULL TEXT THEN IMAGE POST BY POST");
        assert_eq!(asked.user_said, "FULL TEXT THEN IMAGE POST BY POST");
        let since = store::now_ms();
        store::append_message(&shared(&a.id, "1 of 6 · Fri 10am")).unwrap();
        store::append_message(&shared(&a.id, "2 of 6 · Sat 9am")).unwrap();
        leave_labels_only_note(&a.id, &asked.user_said, since);
        // The worker going idle doesn't lose it: the next message reads it.
        assert!(finish_if_idle(&a.id).is_some());
        let next = queue(&a.id, "Where da text");
        assert!(
            next.prompt.starts_with(share_text::LABELS_ONLY_NOTE),
            "{}",
            next.prompt
        );
        assert!(next.prompt.ends_with("Where da text"));
        // Read once.
        assert_eq!(queue(&a.id, "thanks").prompt, "thanks");
        RUNTIMES.lock().unwrap().remove(&a.id);
    });
}

#[test]
fn a_file_with_its_full_text_leaves_no_note() {
    scratch(|| {
        let a = agent("Social");
        let since = store::now_ms();
        let text = share_text::message_text(
            "1 of 6",
            "Fresh sourdough at 7 every morning. Come early, it goes fast.",
        );
        store::append_message(&shared(&a.id, &text)).unwrap();
        leave_labels_only_note(&a.id, "full text then image", since);
        assert_eq!(queue(&a.id, "great").prompt, "great");
        RUNTIMES.lock().unwrap().remove(&a.id);
    });
}
