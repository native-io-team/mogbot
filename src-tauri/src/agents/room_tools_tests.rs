//! The Chief's room tools: who may call them, when the user is asked first,
//! and the room limits they keep.
use super::*;
use crate::agents::store::NewAgent;

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn agent(name: &str, is_main: bool) -> store::Agent {
    store::create(NewAgent {
        name: name.into(),
        role: format!("{name}'s work"),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main,
    })
    .unwrap()
}

fn launch_args() -> Value {
    json!({
        "name": "Launch",
        "members": ["Chief of Staff", "Strategist", "writer", "Builder"],
        "purpose": "Ship the\nlaunch on Thursday"
    })
}

#[test]
fn only_the_chief_is_served_or_allowed_the_room_tools() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        let fin = agent("Finance", false);
        let _ops = agent("Ops", false);
        let served = crate::agents::mcp::tool_names(&chief);
        for t in ["create_room", "add_to_room", "remove_from_room"] {
            assert!(served.contains(&t.to_string()), "{t}");
            assert!(crate::agents::mcp::needs_card_in_routine_turn(t), "{t}");
        }
        let theirs = crate::agents::mcp::tool_names(&fin);
        assert!(!theirs.iter().any(|t| t.contains("room")), "{theirs:?}");
        // Called anyway, by name: refused, outside text or not.
        let args = json!({ "name": "R", "members": ["Finance", "Ops"], "purpose": "x" });
        for outside in [false, true] {
            let err = gate(&fin, outside, "create_room", &args).unwrap_err();
            assert!(err.contains("Only the Chief of Staff"), "{err}");
        }
        assert!(rooms::list().unwrap().is_empty());
    });
}

#[test]
fn the_chief_makes_a_room_with_its_lead_purpose_and_maker() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        for n in ["Strategist", "Writer", "Builder"] {
            agent(n, false);
        }
        let Gate::Go(plan) = gate(&chief, false, "create_room", &launch_args()).unwrap() else {
            panic!("no card outside a turn answering outside text");
        };
        let Plan::Create {
            name,
            members,
            lead,
            purpose,
        } = &plan
        else {
            panic!("{plan:?}");
        };
        assert_eq!(name, "Launch");
        assert_eq!(members.len(), 4);
        // The Chief is in it, so it leads; the purpose is one line.
        assert_eq!(
            lead.as_ref().map(|l| l.id.as_str()),
            Some(chief.id.as_str())
        );
        assert_eq!(purpose.as_deref(), Some("Ship the launch on Thursday"));
        // What `apply` does with it, minus the AppHandle.
        let room = rooms::create_with(
            Some(name),
            &ids(members),
            &Made {
                lead: lead.as_ref().map(|l| l.id.clone()),
                purpose: purpose.clone(),
                by: Some(chief.id.clone()),
            },
        )
        .unwrap();
        let saved = rooms::get(&room.id).unwrap();
        assert_eq!(saved.created_by.as_deref(), Some(chief.id.as_str()));
        assert_eq!(
            saved.purpose.as_deref(),
            Some("Ship the launch on Thursday")
        );
        // A second room by the same name is refused, so a retry doesn't double it.
        let err = gate(&chief, false, "create_room", &launch_args()).unwrap_err();
        assert!(err.contains("already a room called Launch"), "{err}");
    });
}

#[test]
fn a_turn_answering_outside_text_asks_first_and_only_about_a_room_that_can_be_made() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        for n in ["Strategist", "Writer", "Builder"] {
            agent(n, false);
        }
        let mut args = launch_args();
        args["lead"] = json!("Builder");
        let Gate::Ask { title, detail, .. } = gate(&chief, true, "create_room", &args).unwrap()
        else {
            panic!("outside text: the user is asked");
        };
        assert_eq!(title, "Make a room: Launch");
        assert!(
            detail.contains("With Chief of Staff, Strategist, Writer & Builder"),
            "{detail}"
        );
        assert!(
            detail.contains("Builder answers unless you @ someone"),
            "{detail}"
        );
        assert!(
            detail.contains("For: Ship the launch on Thursday"),
            "{detail}"
        );
        assert!(detail.contains("came from outside this app"), "{detail}");
        // A call that would fail fails before any card.
        for bad in [
            json!({ "name": "Solo", "members": ["Writer"], "purpose": "x" }),
            json!({ "name": "Ghost", "members": ["Writer", "Nobody"], "purpose": "x" }),
            json!({ "name": "Led", "members": ["Writer", "Builder"], "lead": "Strategist", "purpose": "x" }),
            json!({ "name": "Long", "members": ["Writer", "Builder"], "purpose": "x".repeat(301) }),
        ] {
            assert!(gate(&chief, true, "create_room", &bad).is_err(), "{bad}");
        }
        // Add and remove ask too.
        let room = rooms::create(
            Some("Pair"),
            &[
                store::find("Writer").unwrap().unwrap().id,
                store::find("Builder").unwrap().unwrap().id,
            ],
        )
        .unwrap();
        let add = json!({ "room": "pair", "agent": "Strategist" });
        assert!(matches!(
            gate(&chief, true, "add_to_room", &add),
            Ok(Gate::Ask { .. })
        ));
        assert!(matches!(
            gate(&chief, false, "add_to_room", &add),
            Ok(Gate::Go(Plan::Add { .. }))
        ));
        // The plan is re-checked after the card: a room changed meanwhile isn't touched.
        let Ok(Gate::Ask { plan: shown, .. }) = gate(&chief, true, "add_to_room", &add) else {
            unreachable!()
        };
        rooms::delete(&room.id).unwrap();
        assert!(plan_again("add_to_room", &add, &shown).is_err());
    });
}

#[test]
fn rooms_keep_two_to_six_members() {
    scratch(|| {
        let chief = agent("Chief of Staff", true);
        let helpers: Vec<store::Agent> = (0..6).map(|n| agent(&format!("H{n}"), false)).collect();
        // Seven is too many, one too few.
        let seven: Vec<&str> = std::iter::once("Chief of Staff")
            .chain(helpers.iter().map(|h| h.name.as_str()))
            .collect();
        let err = gate(
            &chief,
            false,
            "create_room",
            &json!({ "name": "Big", "members": seven, "purpose": "x" }),
        )
        .unwrap_err();
        assert!(err.contains("up to six"), "{err}");
        let full = rooms::create(Some("Full"), &ids(&helpers)).unwrap();
        let err = gate(
            &chief,
            false,
            "add_to_room",
            &json!({ "room": "Full", "agent": "Chief of Staff" }),
        )
        .unwrap_err();
        assert!(err.contains("up to six"), "{err}");
        let pair = rooms::create(Some("Pair"), &ids(&helpers[..2])).unwrap();
        let err = gate(
            &chief,
            false,
            "remove_from_room",
            &json!({ "room": pair.id, "agent": "H0" }),
        )
        .unwrap_err();
        assert!(err.contains("at least two"), "{err}");
        // Already in, not in.
        let err = gate(
            &chief,
            false,
            "add_to_room",
            &json!({ "room": "Pair", "agent": "H1" }),
        )
        .unwrap_err();
        assert!(err.contains("already in Pair"), "{err}");
        let err = gate(
            &chief,
            false,
            "remove_from_room",
            &json!({ "room": "Pair", "agent": "H5" }),
        )
        .unwrap_err();
        assert!(err.contains("isn't in Pair"), "{err}");
        // A full room can lose one.
        assert!(matches!(
            gate(
                &chief,
                false,
                "remove_from_room",
                &json!({ "room": full.id, "agent": "H5" })
            ),
            Ok(Gate::Go(Plan::Remove { .. }))
        ));
    });
}
