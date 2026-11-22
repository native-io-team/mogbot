use super::*;

fn msg(from: From, routine: bool, outside: bool) -> Inbound {
    Inbound {
        id: "m1".into(),
        text: "hello".into(),
        from,
        reply: false,
        routine,
        ticket: None,
        room: None,
        outside,
        resume: 0,
        typed: None,
        conversation: None,
    }
}

fn agent(name: &str) -> From {
    From::Agent {
        sender: AgentRef {
            id: name.to_lowercase(),
            name: name.into(),
        },
        hop: 1,
    }
}

#[test]
fn a_paused_agent_takes_the_users_words_and_the_apps_notes() {
    assert_eq!(fate(&msg(From::User, false, false)), Fate::Run);
    assert_eq!(fate(&msg(From::App, false, false)), Fate::Run);
}

#[test]
fn what_other_agents_send_is_held_for_resume() {
    assert_eq!(fate(&msg(agent("Mail"), false, false)), Fate::Hold);
    // An answer another agent gives is theirs too.
    let mut answer = msg(agent("Mail"), false, false);
    answer.reply = true;
    assert_eq!(fate(&answer), Fate::Hold);
}

#[test]
fn outside_text_is_held_not_run() {
    assert_eq!(fate(&msg(From::User, false, true)), Fate::Hold);
}

#[test]
fn a_routine_or_when_firing_is_refused_not_queued() {
    assert_eq!(fate(&msg(From::User, true, false)), Fate::Refuse);
    assert_eq!(fate(&msg(From::User, true, true)), Fate::Refuse);
    assert_eq!(fate(&msg(agent("Mail"), true, false)), Fate::Refuse);
}

#[test]
fn held_messages_survive_a_restart_and_come_back_in_order() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p1").unwrap()).unwrap();
    with_held("p1", |h| {
        let mut a = msg(agent("Mail"), false, false);
        a.id = "a".into();
        let mut b = msg(agent("Scout"), false, false);
        b.id = "b".into();
        h.extend([a, b]);
    });
    assert!(store::agent_home("p1").unwrap().join("held.json").exists());
    // A fresh process reads the file: drop the in-memory copy.
    HELD.lock().unwrap().as_mut().unwrap().remove("p1");
    assert_eq!(held_count("p1"), 2);
    let ids: Vec<String> = with_held("p1", |h| {
        std::mem::take(h).into_iter().map(|m| m.id).collect()
    });
    assert_eq!(ids, ["a", "b"]);
    assert!(
        !store::agent_home("p1").unwrap().join("held.json").exists(),
        "nothing held: no file"
    );
    store::set_root_for_tests(None);
}

fn queued(id: &str, from: From, routine: bool) -> Inbound {
    let mut m = msg(from, routine, false);
    m.id = id.into();
    m
}

fn in_room(mut m: Inbound) -> Inbound {
    m.room = Some(super::super::rooms::RoomRef {
        room_id: "room1".into(),
        hop: 1,
        asker: super::super::rooms::Asker::User,
    });
    m
}

#[test]
fn pausing_keeps_what_waited_in_the_queue_in_order_and_refuses_routines() {
    let (kept, refused) = split_queue(vec![
        queued("u1", From::User, false),
        queued("a1", agent("Mail"), false),
        queued("r1", From::User, true),
        in_room(queued("room1", agent("Scout"), false)),
        queued("u2", From::User, false),
    ]);
    let ids = |v: &[Inbound]| v.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&kept), ["u1", "a1", "room1", "u2"]);
    assert_eq!(ids(&refused), ["r1"]);
}

#[test]
fn a_pause_holds_the_queue_on_disk_and_resume_runs_it_once_in_order() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p2").unwrap()).unwrap();
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let r = runtimes.entry("p2".into()).or_default();
        r.queue.extend([
            queued("u1", From::User, false),
            queued("a1", agent("Mail"), false),
            queued("r1", From::User, true),
            in_room(queued("room1", agent("Scout"), false)),
        ]);
    }
    let (stopped, refused) = pause_queue("p2");
    assert!(!stopped, "nothing was running");
    assert_eq!(refused.len(), 1);
    assert!(refused[0].routine);
    // The queue is empty (nothing runs twice) and the held ones are on disk.
    assert!(RUNTIMES.lock().unwrap().get("p2").unwrap().queue.is_empty());
    assert_eq!(held_count("p2"), 3);
    assert!(store::agent_home("p2").unwrap().join("held.json").exists());
    // Restart between the pause and Resume: the file is read back, in order.
    HELD.lock().unwrap().as_mut().unwrap().remove("p2");
    assert_eq!(held_count("p2"), 3);
    let ids: Vec<String> = with_held("p2", |h| h.iter().map(|m| m.id.clone()).collect());
    assert_eq!(ids, ["u1", "a1", "room1"]);
    // Resume takes them once: a second Resume has nothing left to run.
    let taken = with_held("p2", std::mem::take);
    assert_eq!(taken.len(), 3);
    assert_eq!(held_count("p2"), 0);
    assert!(!store::agent_home("p2").unwrap().join("held.json").exists());
    store::set_root_for_tests(None);
}

#[test]
fn what_is_said_after_the_pause_follows_the_gate_and_runs_ahead_of_the_held() {
    // The user's words run at once (Fate::Run), so they go to the queue
    // while earlier held messages wait for Resume: on Resume the held ones
    // run after it. Another agent's message after the pause is held behind
    // the ones already held.
    assert_eq!(fate(&msg(From::User, false, false)), Fate::Run);
    assert_eq!(fate(&msg(agent("Mail"), false, false)), Fate::Hold);
}
