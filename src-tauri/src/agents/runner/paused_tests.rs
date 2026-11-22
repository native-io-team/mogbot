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

/// Resume's step under the lock, on `rt`: the queue it leaves, in order.
fn release_into(rt: &mut HashMap<String, Runtime>, id: &str, paused: bool) -> Vec<String> {
    let fill: HashMap<String, String> = held_all(id)
        .into_iter()
        .filter(|m| m.room.is_none() && m.conversation.is_none())
        .map(|m| (m.id, "c1".to_string()))
        .collect();
    release_locked(rt, id, paused, &fill);
    rt.get(id)
        .map(|r| r.queue.iter().map(|m| m.id.clone()).collect())
        .unwrap_or_default()
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
    // Resume appends them to the queue and saves it before forgetting them.
    let mut rt = HashMap::new();
    assert_eq!(release_into(&mut rt, "p2", false), ["u1", "a1", "room1"]);
    assert!(store::agent_home("p2").unwrap().join("inbox.json").exists());
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
    let mut rt: HashMap<String, Runtime> = HashMap::new();
    rt.entry("p5".into())
        .or_default()
        .queue
        .push_back(queued("now", From::User, false));
    assert_eq!(release_into(&mut rt, "p5", false), ["now", "old", "later"]);
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
    let mut inbox = vec![
        queued("u1", From::User, false),
        queued("u2", From::User, false),
    ];
    assert!(recovery::reconcile_held("p8", true, &mut inbox)
        .0
        .is_empty());
    assert_eq!(
        inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["u2"]
    );
    assert_eq!(held_ids("p8"), ["u1"]);
    // Not paused (a Resume that didn't finish): the inbox copy runs, and
    // what was held but never requeued joins it, once.
    hold_all("p8", vec![queued("u3", From::User, false)]);
    let mut inbox = vec![queued("u1", From::User, false)];
    let (forget_after, _) = recovery::reconcile_held("p8", false, &mut inbox);
    assert_eq!(
        inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["u1", "u3"]
    );
    // Still held until the merged queue is on disk: the caller forgets then.
    assert_eq!(held_ids("p8"), ["u1", "u3"]);
    forget("p8", &forget_after);
    assert!(held_ids("p8").is_empty());
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
    assert!(
        !on_disk.contains("\"rt\""),
        "a refused routine doesn't come back at launch"
    );
    RUNTIMES.lock().unwrap().remove("p11");
    with_held("p11", std::mem::take);
    UNSAVED.lock().unwrap().clear();
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
        admit_or_hold(
            &mut runtimes,
            "p14",
            true,
            queued("a1", agent("Mail"), false)
        ),
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
        admit_or_hold(
            &mut runtimes,
            "p14",
            false,
            queued("a2", agent("Mail"), false)
        ),
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
    assert!(recovery::reconcile_held("p15", true, &mut inbox)
        .0
        .is_empty());
    assert_eq!(
        inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["u1"]
    );
    assert_eq!(held_ids("p15"), ["a1"]);
    with_held("p15", std::mem::take);
    store::set_root_for_tests(None);
}

#[test]
fn holding_the_same_message_twice_keeps_one_copy() {
    // The pause's hold and a Resume whose queue write failed can both offer
    // the same id: the held list (its count, `on_the_way`, a restart's read
    // of held.json) must carry it once. `Runtime::admit` also dedupes at
    // release, but only against the queue; this is the held list's own rule.
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p20").unwrap()).unwrap();
    assert!(hold_all("p20", vec![queued("u1", From::User, false)]));
    assert!(hold_all(
        "p20",
        vec![
            queued("u1", From::User, false),
            queued("u2", From::User, false)
        ]
    ));
    assert_eq!(held_ids("p20"), ["u1", "u2"]);
    assert_eq!(held_count("p20"), 2);
    store::set_root_for_tests(None);
}

#[test]
fn a_message_held_twice_runs_once_on_resume() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p3").unwrap()).unwrap();
    // A held copy a failed Resume left, and the same message held again.
    with_held("p3", |h| {
        h.push(queued("u1", From::User, false));
        h.push(queued("u1", From::User, false));
        h.push(queued("u2", From::User, false));
    });
    let mut rt = HashMap::new();
    assert_eq!(release_into(&mut rt, "p3", false), ["u1", "u2"]);
    assert!(held_ids("p3").is_empty(), "every copy is cleared with it");
    store::set_root_for_tests(None);
}

#[test]
fn two_resumes_run_a_message_once_even_after_the_worker_took_it() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p12").unwrap()).unwrap();
    hold_all("p12", vec![queued("u1", agent("Mail"), false)]);
    let mut rt = HashMap::new();
    assert_eq!(release_into(&mut rt, "p12", false), ["u1"]);
    // The worker takes it off the queue; a second Resume (double tap, the
    // phone, an admin) finds nothing held, so it is not queued again.
    rt.get_mut("p12").unwrap().queue.clear();
    assert!(release_into(&mut rt, "p12", false).is_empty());
    store::set_root_for_tests(None);
}

#[test]
fn resume_pause_resume_keeps_one_copy_of_each() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p9").unwrap()).unwrap();
    hold_all(
        "p9",
        vec![
            queued("a1", agent("Mail"), false),
            queued("a2", agent("Mail"), false),
        ],
    );
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        release_into(&mut runtimes, "p9", false);
        assert_eq!(runtimes.get("p9").unwrap().queue.len(), 2);
    }
    assert!(held_ids("p9").is_empty());
    pause_queue("p9");
    assert_eq!(held_ids("p9"), ["a1", "a2"]);
    assert!(RUNTIMES.lock().unwrap().get("p9").unwrap().queue.is_empty());
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(release_into(&mut runtimes, "p9", false), ["a1", "a2"]);
    }
    assert!(held_ids("p9").is_empty());
    RUNTIMES.lock().unwrap().remove("p9");
    store::set_root_for_tests(None);
}

#[test]
fn a_resume_that_left_the_agent_paused_releases_nothing() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    std::fs::create_dir_all(store::agent_home("p13").unwrap()).unwrap();
    hold_all("p13", vec![queued("a1", agent("Mail"), false)]);
    let mut rt = HashMap::new();
    assert!(release_into(&mut rt, "p13", true).is_empty());
    assert_eq!(held_ids("p13"), ["a1"]);
    assert_eq!(release_into(&mut rt, "p13", false), ["a1"]);
    assert!(held_ids("p13").is_empty());
    store::set_root_for_tests(None);
}

#[test]
fn a_resume_whose_queue_write_fails_keeps_them_held() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let dir = store::agent_home("p16").unwrap();
    std::fs::create_dir_all(dir.join("inbox.json")).unwrap();
    hold_all("p16", vec![queued("a1", agent("Mail"), false)]);
    // The real registry, so the worker's own take_batch runs against it.
    release_into(
        &mut RUNTIMES.lock().unwrap_or_else(|e| e.into_inner()),
        "p16",
        false,
    );
    assert_eq!(
        held_ids("p16"),
        ["a1"],
        "the queue didn't save: not forgotten"
    );
    // The message does run: the worker takes it from the queue, and only then
    // is the held copy (a crash backup until now) let go, so a second Resume
    // or a relaunch can't run it twice.
    let batch = drain::take_batch("p16").expect("queued, so it runs");
    assert!(batch.prompt.contains("hello"));
    assert!(
        held_ids("p16").is_empty(),
        "taken by the turn: no spare copy"
    );
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("p16");
    store::set_root_for_tests(None);
}

#[test]
fn a_room_ask_another_agent_brought_in_is_held_not_run() {
    let mut m = in_room(queued("r1", From::User, false));
    assert_eq!(fate(&m), Fate::Run, "the user's own room ask runs");
    m.room.as_mut().unwrap().asker = super::super::rooms::Asker::Agent {
        name: "Scout".into(),
    };
    assert_eq!(fate(&m), Fate::Hold);
}

#[test]
fn a_damaged_held_file_is_set_aside_not_read_as_empty() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let dir = store::agent_home("p17").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("held.json"), b"{ not json").unwrap();
    assert_eq!(held_count("p17"), 0);
    hold_all("p17", vec![queued("a1", agent("Mail"), false)]);
    let kept = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
    assert!(kept, "the damaged file is still there, set aside");
    with_held("p17", std::mem::take);
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
    assert!(
        !set_paused.contains("runner::stop("),
        "a pause is not a plain Stop"
    );
    assert!(set_paused.contains("runner::release_held("));
}

#[test]
fn push_decides_paused_under_the_lock_and_looks_again_after_holding() {
    let inbox = include_str!("inbox.rs");
    let push = body(inbox, "pub(super) fn push(", "/// What came of a message");
    let lock = push.find("RUNTIMES.lock()").expect("push takes the lock");
    let read = push.find("a.paused").expect("push reads paused");
    let door = push
        .find("admit_or_hold(")
        .expect("push goes through the door helper");
    assert!(
        lock < read && read < door,
        "paused is read under the lock, then decided"
    );
    assert!(
        push.contains("after_hold("),
        "a held message is looked at again"
    );
    assert!(push.contains("paused::gate("));
}

#[test]
fn the_gate_looks_again_after_it_holds() {
    let paused = include_str!("paused.rs");
    let gate = body(paused, "pub(super) fn gate(", "pub(super) enum Decision");
    assert!(gate.contains("after_hold("));
}

#[test]
fn a_message_held_just_as_the_agent_resumes_is_released_by_the_look_after() {
    let _serial = store::tests_lock();
    let home = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(home.path().to_path_buf()));
    let a = store::create(store::NewAgent {
        name: "Looker".into(),
        role: "Does things".into(),
        instructions: "Be brief.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    store::update(&a.id, |a| a.paused = true).unwrap();
    hold_all(&a.id, vec![queued("a1", agent("Mail"), false)]);
    // Still paused: the look after releases nothing.
    assert!(!release_step(&a.id));
    assert_eq!(held_ids(&a.id), ["a1"]);
    // Resumed between the decision and the hold: the look after runs it.
    store::update(&a.id, |a| a.paused = false).unwrap();
    assert!(release_step(&a.id), "a worker must start");
    assert!(held_ids(&a.id).is_empty());
    let queued_ids: Vec<String> = RUNTIMES
        .lock()
        .unwrap()
        .get(&a.id)
        .map(|r| r.queue.iter().map(|m| m.id.clone()).collect())
        .unwrap_or_default();
    assert_eq!(queued_ids, ["a1"]);
    RUNTIMES.lock().unwrap().remove(&a.id);
    store::set_root_for_tests(None);
}
