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
    // Resume requeues them while they are still on disk, then forgets them:
    // a crash in the middle repeats a message, never loses one.
    let mut run = Vec::new();
    release_with("p2", |m| {
        assert!(
            store::agent_home("p2").unwrap().join("held.json").exists(),
            "still held while it is requeued"
        );
        run.push(m.id);
    });
    assert_eq!(run, ["u1", "a1", "room1"]);
    // A second Resume has nothing left to run.
    let mut again = 0;
    release_with("p2", |_| again += 1);
    assert_eq!(again, 0);
    assert_eq!(held_count("p2"), 0);
    assert!(!store::agent_home("p2").unwrap().join("held.json").exists());
    store::set_root_for_tests(None);
}

#[test]
fn what_is_said_after_the_pause_runs_ahead_of_the_held_and_resume_runs_them_after() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p5").unwrap()).unwrap();
    hold_all("p5", vec![queued("old", agent("Mail"), false)]);
    // The real gate, after the pause: the user's words go to the queue at
    // once, another agent's are held behind the older one.
    assert!(matches!(
        decide("p5", true, queued("now", From::User, false)),
        Decision::Queue(_)
    ));
    assert!(matches!(
        decide("p5", true, queued("later", agent("Scout"), false)),
        Decision::Held
    ));
    assert!(matches!(
        decide("p5", true, queued("rt", From::User, true)),
        Decision::Refused(_)
    ));
    assert_eq!(held_ids("p5"), ["old", "later"]);
    // Resume: the held ones come in the order they were held, after "now".
    let mut queue = vec!["now".to_string()];
    release_with("p5", |m| queue.push(m.id));
    assert_eq!(queue, ["now", "old", "later"]);
    assert!(held_ids("p5").is_empty());
    store::set_root_for_tests(None);
}

#[test]
fn a_hold_that_could_not_be_saved_keeps_the_words_on_disk_and_in_memory_once() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let dir = store::agent_home("p6").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    // held.json is a folder: the write can't land.
    std::fs::create_dir_all(dir.join("held.json")).unwrap();
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let r = runtimes.entry("p6".into()).or_default();
        r.queue.push_back(queued("u1", From::User, false));
        save_inbox("p6", &r.queue);
    }
    assert!(dir.join("inbox.json").exists());
    pause_queue("p6");
    assert!(
        dir.join("inbox.json").exists(),
        "the words stay on disk when the hold didn't save"
    );
    // In process the words are held once: the queue's memory copy is gone,
    // so Resume runs the held one; the inbox file is only for a restart,
    // where it runs once (held.json was never written) or is dropped as a
    // duplicate (it was, by the retry): see `reconcile_held`.
    assert_eq!(held_ids("p6"), ["u1"]);
    RUNTIMES.lock().unwrap().remove("p6");
    with_held("p6", std::mem::take);
    UNSAVED.lock().unwrap().clear();
    store::set_root_for_tests(None);
}

#[test]
fn a_delete_takes_what_was_held_and_a_rooms_stop_takes_its_asks() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p7").unwrap()).unwrap();
    hold_all(
        "p7",
        vec![
            queued("a1", agent("Mail"), false),
            in_room(queued("room1", agent("Scout"), false)),
        ],
    );
    // A plain Stop leaves them for Resume.
    let (_, dropped) = stop_queue("p7", false);
    assert!(dropped.is_empty());
    assert_eq!(held_ids("p7"), ["a1", "room1"]);
    // The room's Stop takes its own ask only.
    assert!(stop_in_room("p7", "room1"));
    assert_eq!(held_ids("p7"), ["a1"]);
    // A delete takes the rest, so the asker is told.
    let (_, dropped) = stop_queue("p7", true);
    assert_eq!(dropped.len(), 1);
    assert_eq!(dropped[0].id, "a1");
    assert!(held_ids("p7").is_empty());
    RUNTIMES.lock().unwrap().remove("p7");
    store::set_root_for_tests(None);
}

#[test]
fn recovery_sorts_out_a_message_both_held_and_in_the_inbox() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p8").unwrap()).unwrap();
    // Paused: the held copy runs on Resume, the inbox copy doesn't start.
    hold_all("p8", vec![queued("u1", From::User, false)]);
    let mut inbox = vec![queued("u1", From::User, false), queued("u2", From::User, false)];
    assert!(recovery::reconcile_held("p8", true, &mut inbox).is_empty());
    assert_eq!(inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["u2"]);
    assert_eq!(held_ids("p8"), ["u1"]);
    // Not paused (a Resume that didn't finish): the inbox copy runs, and
    // what was held but never requeued joins it, once.
    hold_all("p8", vec![queued("u3", From::User, false)]);
    let mut inbox = vec![queued("u1", From::User, false)];
    let forget_after = recovery::reconcile_held("p8", false, &mut inbox);
    assert_eq!(inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["u1", "u3"]);
    // Still held until the merged queue is on disk: the caller forgets then.
    assert_eq!(held_ids("p8"), ["u1", "u3"]);
    forget("p8", &forget_after);
    assert!(held_ids("p8").is_empty());
    store::set_root_for_tests(None);
}
#[test]
fn a_message_held_twice_runs_once_on_resume() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p3").unwrap()).unwrap();
    hold_all("p3", vec![queued("u1", From::User, false)]);
    hold_all(
        "p3",
        vec![queued("u1", From::User, false), queued("u2", From::User, false)],
    );
    // Not deduplicated when held (see `hold_all`), but Resume runs u1 once.
    let mut run = Vec::new();
    release_with("p3", |m| run.push(m.id));
    assert_eq!(run, ["u1", "u2"]);
    // As many copies are forgotten as were held: nothing runs again later.
    assert!(held_ids("p3").is_empty());
    with_held("p3", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn a_held_message_is_on_its_way_and_owed_and_waiting_in_its_room() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p4").unwrap()).unwrap();
    hold_all(
        "p4",
        vec![
            queued("a1", agent("Mail"), false),
            in_room(queued("room1", agent("Scout"), false)),
        ],
    );
    // Not left out of a fresh session's recap: it runs on Resume.
    assert!(on_the_way("p4").contains("a1"));
    // Mail asked p4: p4 owes Mail an answer although it hasn't started.
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        runtimes.entry("p4".into()).or_default();
        assert_eq!(owes_reply(&runtimes, "mail").as_deref(), Some("p4"));
    }
    assert!(queued_for_room("p4", "room1"));
    RUNTIMES.lock().unwrap().remove("p4");
    with_held("p4", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn a_resume_whose_requeue_holds_it_again_loses_nothing() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p9").unwrap()).unwrap();
    hold_all("p9", vec![queued("u1", agent("Mail"), false), queued("u2", agent("Mail"), false)]);
    // The agent is paused again (or never left it): requeue goes through the
    // gate, which holds another agent's message a second time (the user's own
    // words would pass it).
    release_with("p9", |m| {
        let _ = decide("p9", true, m);
    });
    assert_eq!(held_ids("p9"), ["u1", "u2"], "one copy of each stays held");
    // A pause that lands mid-release holds the queue's copy too.
    release_with("p9", |m| {
        hold_all("p9", vec![m]);
    });
    assert_eq!(held_ids("p9"), ["u1", "u2"]);
    with_held("p9", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn a_failed_hold_write_keeps_the_words_in_memory_and_retries() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let dir = store::agent_home("p10").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(dir.join("held.json")).unwrap();
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let r = runtimes.entry("p10".into()).or_default();
        r.queue.push_back(queued("u1", From::User, false));
        save_inbox("p10", &r.queue);
    }
    pause_queue("p10");
    // The next push saves the (now empty) queue over inbox.json.
    {
        let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        save_inbox("p10", &runtimes.get("p10").unwrap().queue);
    }
    assert!(!dir.join("inbox.json").exists());
    assert_eq!(held_ids("p10"), ["u1"], "memory still has the words");
    // The disk is fine again: the next touch writes it.
    std::fs::remove_dir_all(dir.join("held.json")).unwrap();
    assert_eq!(held_ids("p10"), ["u1"]);
    assert!(dir.join("held.json").is_file());
    RUNTIMES.lock().unwrap().remove("p10");
    with_held("p10", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn a_paused_agent_with_only_a_held_file_is_found_after_a_restart() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let new = |name: &str| {
        store::create(store::NewAgent {
            name: name.into(),
            role: "Does things".into(),
            instructions: "Be brief.".into(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap()
    };
    let asker = new("Asker");
    let held = new("Holder");
    store::update(&held.id, |a| a.paused = true).unwrap();
    let ask = |id: &str| {
        let mut m = in_room(queued(id, From::App, false));
        m.from = From::Agent {
            sender: AgentRef {
                id: asker.id.clone(),
                name: "Asker".into(),
            },
            hop: 1,
        };
        m
    };
    hold_all(&held.id, vec![ask("r1")]);
    // A restart: held.json is on disk, no runtime, nothing in memory.
    HELD.lock().unwrap().as_mut().unwrap().remove(&held.id);
    RUNTIMES.lock().unwrap().remove(&held.id);
    assert!(queued_for_room(&held.id, "room1"));
    assert_eq!(
        owes_reply(&HashMap::new(), &asker.id).as_deref(),
        Some(held.id.as_str())
    );
    assert!(stop_in_room(&held.id, "room1"), "the room's Stop takes it");
    assert!(held_ids(&held.id).is_empty());
    assert!(!queued_for_room(&held.id, "room1"));
    store::set_root_for_tests(None);
}

#[test]
fn a_failed_hold_leaves_only_the_kept_words_in_the_inbox_file() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let dir = store::agent_home("p11").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(dir.join("held.json")).unwrap();
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let r = runtimes.entry("p11".into()).or_default();
        r.queue.push_back(queued("u1", From::User, false));
        r.queue.push_back(queued("rt", From::User, true));
        save_inbox("p11", &r.queue);
    }
    pause_queue("p11");
    let on_disk = std::fs::read_to_string(dir.join("inbox.json")).unwrap();
    assert!(on_disk.contains("u1"), "the kept words survive a quit");
    assert!(!on_disk.contains("\"rt\""), "a refused routine doesn't come back at launch");
    RUNTIMES.lock().unwrap().remove("p11");
    with_held("p11", std::mem::take);
    UNSAVED.lock().unwrap().clear();
    store::set_root_for_tests(None);
}

#[test]
fn two_copies_in_the_snapshot_and_one_held_mid_release_leave_exactly_one() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p12").unwrap()).unwrap();
    hold_all("p12", vec![queued("u1", agent("Mail"), false)]);
    hold_all("p12", vec![queued("u1", agent("Mail"), false)]);
    release_with("p12", |m| {
        // A pause lands while it is released: the same message is held again.
        hold_all("p12", vec![m]);
    });
    assert_eq!(held_ids("p12"), ["u1"]);
    with_held("p12", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn a_resume_that_left_the_agent_paused_releases_nothing() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p13").unwrap()).unwrap();
    hold_all("p13", vec![queued("a1", agent("Mail"), false)]);
    let mut run = 0;
    assert!(!release_if_resumed("p13", true, |_| run += 1));
    assert_eq!(run, 0);
    assert_eq!(held_ids("p13"), ["a1"]);
    assert!(release_if_resumed("p13", false, |_| run += 1));
    assert_eq!(run, 1);
    assert!(held_ids("p13").is_empty());
    store::set_root_for_tests(None);
}

#[test]
fn a_message_that_gets_past_the_gate_just_before_a_pause_is_held_at_the_door() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p14").unwrap()).unwrap();
    let mut runtimes: HashMap<String, Runtime> = HashMap::new();
    // Paused by now: another agent's words are held, not queued; a routine
    // is refused; the user's own words go in.
    assert!(matches!(
        admit_or_hold(&mut runtimes, "p14", true, queued("a1", agent("Mail"), false)),
        Entry::Held
    ));
    assert!(matches!(
        admit_or_hold(&mut runtimes, "p14", true, queued("rt", From::User, true)),
        Entry::Refused(_)
    ));
    assert!(runtimes.get("p14").is_none_or(|r| r.queue.is_empty()));
    assert!(matches!(
        admit_or_hold(&mut runtimes, "p14", true, queued("u1", From::User, false)),
        Entry::Admitted(Ok(_))
    ));
    assert_eq!(held_ids("p14"), ["a1"]);
    // Not paused: it queues.
    assert!(matches!(
        admit_or_hold(&mut runtimes, "p14", false, queued("a2", agent("Mail"), false)),
        Entry::Admitted(Ok(_))
    ));
    with_held("p14", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn after_a_failed_save_and_a_relaunch_a_paused_agent_holds_what_it_would_have_held() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p15").unwrap()).unwrap();
    let mut inbox = vec![
        queued("a1", agent("Mail"), false),
        queued("rt", From::User, true),
        queued("u1", From::User, false),
    ];
    assert!(recovery::reconcile_held("p15", true, &mut inbox).is_empty());
    assert_eq!(inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["u1"]);
    assert_eq!(held_ids("p15"), ["a1"]);
    with_held("p15", std::mem::take);
    store::set_root_for_tests(None);
}

/// The three call sites that need a live `AppHandle` (so no test can run
/// them) are held by reading their own source: each must still make the
/// decision the helpers are tested for. Put the old code back and these go
/// red. The helpers' behaviour is proven by the tests above.
fn body<'a>(src: &'a str, from: &str, to: &str) -> &'a str {
    let a = src.find(from).unwrap_or_else(|| panic!("{from} moved"));
    let b = src[a..].find(to).unwrap_or_else(|| panic!("{to} moved")) + a;
    &src[a..b]
}

#[test]
fn set_paused_pauses_with_the_queue_kept_never_the_plain_stop() {
    let admin = include_str!("../admin.rs");
    let set_paused = body(admin, "pub fn set_paused(", "\nfn pause(");
    assert!(set_paused.contains("pause_action(on, saved)"));
    assert!(set_paused.contains("runner::stop_for_pause("));
    assert!(!set_paused.contains("runner::stop("), "a pause is not a plain Stop");
    assert!(set_paused.contains("runner::release_held("));
}

#[test]
fn push_decides_paused_under_the_lock_and_looks_again_after_holding() {
    let inbox = include_str!("inbox.rs");
    let push = body(inbox, "pub(super) fn push(", "/// What came of a message");
    let lock = push.find("RUNTIMES.lock()").expect("push takes the lock");
    let read = push.find("a.paused").expect("push reads paused");
    let door = push.find("admit_or_hold(").expect("push goes through the door helper");
    assert!(lock < read && read < door, "paused is read under the lock, then decided");
    assert!(push.contains("after_hold("), "a held message is looked at again");
    assert!(push.contains("paused::gate("));
}

#[test]
fn the_gate_looks_again_after_it_holds() {
    let paused = include_str!("paused.rs");
    let gate = body(paused, "pub(super) fn gate(", "pub(super) enum Decision");
    assert!(gate.contains("Decision::Held => {\n            after_hold("));
}
