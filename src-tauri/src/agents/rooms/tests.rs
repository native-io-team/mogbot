//! Rooms: the registry, who answers, what members are shown, and the caps.
use super::*;
use crate::agents::store::{self, ApprovalStatus, NewAgent};

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    rounds().clear();
    f();
    rounds().clear();
    store::set_root_for_tests(None);
}

fn agent(name: &str, is_main: bool) -> store::Agent {
    store::create(NewAgent {
        name: name.into(),
        role: format!("{name}'s work"),
        instructions: String::new(),
        shape: None,
        color: None,
        is_main,
    })
    .unwrap()
}

fn said_in(room: &str, agent_id: &str, kind: MessageKind, text: &str) -> AgentMessage {
    let mut m = runner::new_message(agent_id, kind, text);
    m.room = Some(room.into());
    m
}

#[test]
fn a_room_has_two_to_six_real_agents_and_the_chief_leads_when_it_is_in() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        // Too few, and a duplicate doesn't count twice.
        assert!(create(None, std::slice::from_ref(&fin.id)).is_err());
        assert!(create(None, &[fin.id.clone(), fin.id.clone()]).is_err());
        assert!(create(None, &[fin.id.clone(), "nobody".into()]).is_err());
        let room = create(None, &[fin.id.clone(), ops.id.clone()]).unwrap();
        assert_eq!(room.name, "Finance & Ops");
        assert_eq!(room.lead, None, "no Chief: nobody leads, the user is asked");
        let room = create(Some("  Launch  "), &[chief.id.clone(), fin.id.clone()]).unwrap();
        assert_eq!(room.name, "Launch");
        assert_eq!(room.lead.as_deref(), Some(chief.id.as_str()));
        // Seven is too many.
        let mut many = vec![chief.id.clone(), fin.id.clone(), ops.id.clone()];
        for n in 0..4 {
            many.push(agent(&format!("Helper {n}"), false).id);
        }
        assert!(create(None, &many).is_err());
        assert!(create(None, &many[..6]).is_ok());
        assert_eq!(list().unwrap().len(), 3);
    });
}

#[test]
fn routing_names_everyone_or_the_lead_and_otherwise_asks() {
    let room = Room {
        id: "r".into(),
        name: "R".into(),
        members: vec!["a".into(), "b".into(), "c".into()],
        lead: None,
        muted: false,
        created_at: 0,
        last_activity_at: 0,
        preview: None,
        unread: 0,
        extra: Default::default(),
    };
    // Named members, in the room's order; a stranger is ignored.
    assert_eq!(
        resolve(&room, &["c".into(), "zed".into(), "a".into()], false),
        Ok(vec!["a".to_string(), "c".to_string()])
    );
    assert_eq!(
        resolve(&room, &[], true),
        Ok(vec!["a".to_string(), "b".to_string(), "c".to_string()])
    );
    // Nobody named, no lead: the user is asked who should answer.
    assert_eq!(resolve(&room, &[], false), Err(WhoShouldAnswer));
    assert_eq!(resolve(&room, &["zed".into()], false), Err(WhoShouldAnswer));
    let led = Room {
        lead: Some("b".into()),
        ..room.clone()
    };
    assert_eq!(resolve(&led, &[], false), Ok(vec!["b".to_string()]));
    // A named member beats the lead.
    assert_eq!(
        resolve(&led, &["c".into()], false),
        Ok(vec!["c".to_string()])
    );
    // A lead who left isn't asked.
    let gone = Room {
        lead: Some("x".into()),
        ..room
    };
    assert_eq!(resolve(&gone, &[], false), Err(WhoShouldAnswer));
}

#[test]
fn a_reply_brings_in_the_members_it_mentions_and_nobody_else() {
    let members = vec![
        AgentRef {
            id: "o".into(),
            name: "Ops".into(),
        },
        AgentRef {
            id: "ol".into(),
            name: "Ops Lead".into(),
        },
        AgentRef {
            id: "f".into(),
            name: "Finance".into(),
        },
        AgentRef {
            id: "d".into(),
            name: "Design".into(),
        },
    ];
    let by = |text: &str| mentioned_in(text, &members, "f");
    assert_eq!(by("@ops can you check?"), vec!["o"]);
    // The longer name wins, and an email address is not a mention.
    assert_eq!(by("Over to @Ops Lead."), vec!["ol"]);
    assert!(by("mail ops@example.com").is_empty());
    // Not a prefix of a longer word, not the author, each once, room order.
    assert!(by("@Opsy and @Designer").is_empty());
    assert!(by("I (@Finance) will do it").is_empty());
    assert_eq!(by("@Design, then @Ops, then @design again"), vec!["o", "d"]);
    assert!(
        by("@everyone thoughts?").is_empty(),
        "agents can't fan out to everyone"
    );
}

#[test]
fn hand_offs_stop_at_the_turn_cap_and_the_hop_cap_and_say_so_once() {
    scratch(|| {
        start_round("room", 6);
        assert_eq!(turns_used("room"), 6);
        assert!(admit_followup("room", 1).is_ok());
        assert!(admit_followup("room", 2).is_ok());
        assert_eq!(turns_used("room"), TURN_CAP);
        assert_eq!(admit_followup("room", 3), Err((Held::TurnCap, true)));
        assert_eq!(
            admit_followup("room", 3),
            Err((Held::TurnCap, false)),
            "said once"
        );
        // A new user message is a new round.
        start_round("room", 1);
        assert!(admit_followup("room", 1).is_ok());
        assert_eq!(
            admit_followup("room", MAX_HOPS + 1),
            Err((Held::HopCap, true))
        );
        assert!(
            admit_followup("room", MAX_HOPS).is_ok(),
            "the last hop allowed"
        );
        // Rooms count separately.
        start_round("other", 2);
        assert_eq!(turns_used("other"), 2);
        assert_eq!(turns_used("room"), 3);
    });
}

#[test]
fn the_thread_reads_back_with_each_members_card_answers() {
    scratch(|| {
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        let room = create(None, &[fin.id.clone(), ops.id.clone()]).unwrap();
        let mut user = runner::new_message("", MessageKind::User, "Close the month?");
        user.room = Some(room.id.clone());
        append(&room.id, &user).unwrap();
        let mut card = said_in(&room.id, &fin.id, MessageKind::Approval, "");
        card.approval = Some(store::Approval {
            request_id: "req-1".into(),
            title: "Run a command".into(),
            detail: "ledger close".into(),
            status: ApprovalStatus::Pending,
            tool: None,
            input: None,
            always: None,
            always_allowed: false,
            note: None,
            prompt: None,
            choice: None,
            secret: None,
            connector: None,
            summary: None,
        });
        // The member's own log has the card, the room a copy.
        store::append_message(&card).unwrap();
        append(&room.id, &card).unwrap();
        append(
            &room.id,
            &said_in(&room.id, &ops.id, MessageKind::Agent, "On it"),
        )
        .unwrap();
        store::set_approval_status(&fin.id, "req-1", ApprovalStatus::Allowed).unwrap();
        let page = messages_page(&room.id, 50, None).unwrap();
        assert_eq!(page.len(), 3);
        assert_eq!(
            page[1].approval.as_ref().unwrap().status,
            ApprovalStatus::Allowed,
            "answered in Finance's home, shown answered in the room"
        );
        // Paging back from the newest line.
        let older = messages_page(&room.id, 1, Some(&page[2].id)).unwrap();
        assert_eq!(older.len(), 1);
        assert_eq!(older[0].id, page[1].id);
        // A deleted room refuses new lines rather than bringing its folder back.
        delete(&room.id).unwrap();
        assert!(append(&room.id, &user).is_err());
        assert!(!room_dir(&room.id).unwrap().exists());
    });
}

#[test]
fn a_member_is_told_who_is_here_and_how_much_of_the_room_it_sees() {
    scratch(|| {
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        let room = create(Some("Month end"), &[fin.id.clone(), ops.id.clone()]).unwrap();
        for i in 0..30 {
            let mut m = runner::new_message("", MessageKind::User, format!("question {i}"));
            m.room = Some(room.id.clone());
            append(&room.id, &m).unwrap();
            append(
                &room.id,
                &said_in(
                    &room.id,
                    &ops.id,
                    MessageKind::Agent,
                    &format!("answer {i}"),
                ),
            )
            .unwrap();
        }
        let rr = RoomRef {
            room_id: room.id.clone(),
            hop: 0,
            from_name: String::new(),
        };
        let p = prompt(&fin.id, &rr, &[(String::new(), "question 29".into())]).unwrap();
        assert!(p.contains("Room \"Month end\""), "{p}");
        assert!(p.contains("Ops and you, Finance"), "{p}");
        assert!(
            p.contains("the newest 20 of the 60 messages"),
            "honest about the window: {p}"
        );
        assert!(p.contains("Ops: answer 29"));
        assert!(!p.contains("question 9\n"), "older lines are not shown");
        assert!(p.contains("The user asked you: question 29"));
        assert!(p.contains("write @Name"));
        // Brought in by a member.
        let p = prompt(&fin.id, &rr, &[("Ops".into(), "@Finance numbers?".into())]).unwrap();
        assert!(p.contains("Ops brought you in: @Finance numbers?"));
        // A long line is clipped, the whole stays bounded.
        let long = "x".repeat(5000);
        append(
            &room.id,
            &said_in(&room.id, &ops.id, MessageKind::Agent, &long),
        )
        .unwrap();
        let p = prompt(&fin.id, &rr, &[]).unwrap();
        assert!(p.contains("… [cut]"));
        assert!(
            p.chars().count() < CONTEXT_CHARS + 2000,
            "{}",
            p.chars().count()
        );
        // Not a member (any more): no turn.
        let other = agent("Design", false);
        assert!(prompt(&other.id, &rr, &[]).is_none());
        delete(&room.id).unwrap();
        assert!(
            prompt(&fin.id, &rr, &[]).is_none(),
            "a deleted room asks nobody"
        );
    });
}

#[test]
fn deleting_an_agent_takes_it_out_of_its_rooms_and_deleting_a_room_keeps_its_agents() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        let room = create(None, &[chief.id.clone(), fin.id.clone(), ops.id.clone()]).unwrap();
        let led = change(
            &room.id,
            RoomChange {
                lead: Some(Some(fin.id.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(led.lead.as_deref(), Some(fin.id.as_str()));
        store::delete(&fin.id).unwrap();
        let after = get(&room.id).unwrap();
        assert_eq!(after.members, vec![chief.id.clone(), ops.id.clone()]);
        assert_eq!(after.lead, None, "its lead left with it");
        delete(&room.id).unwrap();
        assert!(store::get(&chief.id).is_ok() && store::get(&ops.id).is_ok());
        assert!(get(&room.id).is_err());
    });
}

#[test]
fn settings_keep_the_lead_in_the_room_and_mute_clears_the_count() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        let room = create(None, &[fin.id.clone(), ops.id.clone()]).unwrap();
        // A lead must be a member.
        assert!(change(
            &room.id,
            RoomChange {
                lead: Some(Some(chief.id.clone())),
                ..Default::default()
            }
        )
        .is_err());
        // Adding the Chief to a room without a lead makes it the lead.
        let more = change(
            &room.id,
            RoomChange {
                members: Some(vec![fin.id.clone(), ops.id.clone(), chief.id.clone()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(more.lead.as_deref(), Some(chief.id.as_str()));
        update(&room.id, |r| r.unread = 4).unwrap();
        let muted = change(
            &room.id,
            RoomChange {
                muted: Some(true),
                name: Some("Ops room".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(muted.muted);
        assert_eq!(muted.unread, 0);
        assert_eq!(muted.name, "Ops room");
        assert!(
            change(
                &room.id,
                RoomChange {
                    members: Some(vec![fin.id.clone()]),
                    ..Default::default()
                }
            )
            .is_err(),
            "never below two"
        );
    });
}

#[test]
fn the_registry_keeps_what_a_newer_build_wrote() {
    scratch(|| {
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        let room = create(None, &[fin.id.clone(), ops.id.clone()]).unwrap();
        let path = rooms_root().unwrap().join("rooms.json");
        let mut raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        raw["rooms"][0]["topic"] = "from the future".into();
        raw["rooms"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id": 7}));
        raw["layout"] = "grid".into();
        std::fs::write(&path, raw.to_string()).unwrap();
        mark_read(&room.id).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["rooms"][0]["topic"], "from the future");
        assert_eq!(raw["rooms"][1]["id"], 7);
        assert_eq!(raw["layout"], "grid");
        assert_eq!(list().unwrap().len(), 1);
    });
}

#[test]
fn search_finds_a_room_line_once_in_its_room() {
    scratch(|| {
        let fin = agent("Finance", false);
        let ops = agent("Ops", false);
        let room = create(Some("Month end"), &[fin.id.clone(), ops.id.clone()]).unwrap();
        let mut user = runner::new_message("", MessageKind::User, "where is the invoice ledger");
        user.room = Some(room.id.clone());
        append(&room.id, &user).unwrap();
        // Finance's reply: in its own log (tagged) and copied into the room.
        let reply = said_in(
            &room.id,
            &fin.id,
            MessageKind::Agent,
            "The invoice ledger is closed",
        );
        store::append_message(&reply).unwrap();
        append(&room.id, &reply).unwrap();
        // And something Finance said in its own chat.
        store::append_message(&runner::new_message(
            &fin.id,
            MessageKind::Agent,
            "invoice sent",
        ))
        .unwrap();
        let hits = crate::agents::search::search("invoice").unwrap();
        assert_eq!(hits.len(), 3, "{hits:?}");
        let in_room: Vec<_> = hits.iter().filter(|h| h.room_id.is_some()).collect();
        assert_eq!(in_room.len(), 2);
        assert!(in_room
            .iter()
            .all(|h| h.room_name.as_deref() == Some("Month end")));
        let theirs = in_room.iter().find(|h| h.agent_id == fin.id).unwrap();
        assert_eq!(theirs.agent_name, "Finance");
        let users = in_room.iter().find(|h| h.agent_id.is_empty()).unwrap();
        assert_eq!(users.kind, MessageKind::User);
        let own = hits.iter().find(|h| h.room_id.is_none()).unwrap();
        assert_eq!(own.snippet, "invoice sent");
    });
}
