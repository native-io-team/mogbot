use super::*;

fn typed(id: &str, text: &str, conversation: &str) -> Inbound {
    let mut m = user_inbound(id, text.to_string(), Some(text.to_string()));
    m.conversation = Some(conversation.to_string());
    m
}

/// A turn answering the user in conversation "c1", with its way in open.
fn turn(agent: &str) -> tokio::sync::mpsc::UnboundedReceiver<Handed> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let r = runtimes.entry(agent.to_string()).or_default();
    r.running = true;
    r.user_asked = true;
    r.conversation = Some("c1".into());
    r.typed = Some("fix the tests".into());
    r.user_text = "fix the tests".into();
    drop(runtimes);
    open(agent).expect("a turn answering the user takes messages")
}

fn push_into(agent: &str, m: Inbound) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let r = runtimes.get_mut(agent).unwrap();
    let handed = offer(r, &m);
    r.queue.push_back(m);
    handed
}

fn queue_ids(agent: &str) -> Vec<String> {
    RUNTIMES
        .lock()
        .unwrap()
        .get(agent)
        .unwrap()
        .queue
        .iter()
        .map(|m| m.id.clone())
        .collect()
}

fn forget(agent: &str) {
    RUNTIMES.lock().unwrap().remove(agent);
}

#[test]
fn a_typed_message_goes_into_the_turn_and_leaves_the_queue_once_read() {
    let agent = "steer-read";
    let mut rx = turn(agent);
    assert!(push_into(agent, typed("m2", "also check the docs", "c1")));
    assert_eq!(rx.try_recv().unwrap().text, "also check the docs");
    assert_eq!(seen(agent), (vec!["m2".to_string()], vec![]));
    // Not read yet: the turn's result doesn't let the engine go.
    assert!(!close_if_idle(agent));
    assert!(heard(agent, "m2"));
    assert_eq!(seen(agent), (vec![], vec!["m2".to_string()]));
    {
        let runtimes = RUNTIMES.lock().unwrap();
        let r = runtimes.get(agent).unwrap();
        assert_eq!(
            r.typed.as_deref(),
            Some("fix the tests\nalso check the docs")
        );
        assert!(r.batch_ids.contains(&"m2".to_string()));
    }
    assert!(close_if_idle(agent));
    assert!(queue_ids(agent).is_empty(), "read mid-turn: not run again");
    forget(agent);
}

#[test]
fn one_never_read_stays_queued_for_the_next_turn() {
    let agent = "steer-unread";
    let _rx = turn(agent);
    assert!(push_into(agent, typed("m2", "and the README", "c1")));
    close(agent);
    assert_eq!(queue_ids(agent), vec!["m2".to_string()]);
    assert_eq!(seen(agent), (vec![], vec![]));
    // The way in is shut: the next message only queues.
    assert!(!push_into(agent, typed("m3", "thanks", "c1")));
    forget(agent);
}

#[test]
fn only_the_users_typed_words_in_the_same_conversation_go_in() {
    let agent = "steer-who";
    let _rx = turn(agent);
    assert!(!push_into(agent, typed("o1", "elsewhere", "c2")));
    let mut button = typed("o2", "Use it", "c1");
    button.typed = None;
    assert!(!push_into(agent, button));
    let mut outside = typed("o3", "mail", "c1");
    outside.outside = true;
    assert!(!push_into(agent, outside));
    let mut from_agent = typed("o4", "done", "c1");
    from_agent.from = From::App;
    assert!(!push_into(agent, from_agent));
    assert_eq!(seen(agent), (vec![], vec![]));
    forget(agent);
}

#[test]
fn a_turn_not_answering_the_user_takes_nothing_mid_turn() {
    for (agent, set) in [
        (
            "steer-routine",
            (|r: &mut Runtime| r.user_asked = false) as fn(&mut Runtime),
        ),
        ("steer-outside", |r: &mut Runtime| r.outside = true),
    ] {
        {
            let mut runtimes = RUNTIMES.lock().unwrap();
            let r = runtimes.entry(agent.to_string()).or_default();
            r.running = true;
            r.user_asked = true;
            set(r);
        }
        assert!(open(agent).is_none(), "{agent}");
        forget(agent);
    }
}

#[test]
fn claude_says_which_message_it_read() {
    let started = serde_json::json!({
        "type": "command_lifecycle", "command_uuid": "m2", "state": "started"
    });
    assert_eq!(claude_read(&started), Some("m2"));
    let queued = serde_json::json!({
        "type": "command_lifecycle", "command_uuid": "m2", "state": "queued"
    });
    assert_eq!(claude_read(&queued), None);
    let line: serde_json::Value = serde_json::from_str(&claude_line("hi", Some("m2"))).unwrap();
    assert_eq!(line["uuid"], "m2");
    assert_eq!(line["message"]["content"], "hi");
    let first: serde_json::Value = serde_json::from_str(&claude_line("go", None)).unwrap();
    assert!(first.get("uuid").is_none());
}

/// A pause while a turn answers the user: what the engine already read is
/// not kept for Resume (it would run twice), what was handed but not read
/// is, and a read that comes after the pause takes its message back out.
#[test]
fn a_pause_keeps_what_the_engine_has_not_read_and_never_what_it_has() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let agent = "steer-pause";
    std::fs::create_dir_all(store::agent_home(agent).unwrap()).unwrap();
    let mut rx = turn(agent);
    assert!(push_into(agent, typed("read", "first", "c1")));
    assert!(push_into(agent, typed("handed", "second", "c1")));
    assert!(push_into(agent, typed("late", "third", "c1")));
    let _ = (rx.try_recv(), rx.try_recv(), rx.try_recv());
    assert!(heard(agent, "read"));
    let (stopped, _) = control::pause_queue(agent);
    let _ = stopped;
    let held = || paused::held_ids(agent);
    assert_eq!(held(), ["handed", "late"], "the read one is not kept");
    assert!(queue_ids(agent).is_empty());
    // The engine reads one more before the turn ends: it is part of the
    // turn, so it comes out of what Resume runs.
    assert!(heard(agent, "late"));
    assert_eq!(held(), ["handed"]);
    close(agent);
    assert_eq!(held(), ["handed"], "handed, never read: still held");
    paused::drop_held(agent, "handed");
    forget(agent);
    store::set_root_for_tests(None);
}
