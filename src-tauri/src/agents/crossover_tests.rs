use super::*;
use crate::agents::runner;
use crate::agents::store::{self, MessageKind};
use chrono::{TimeZone, Utc};

fn bare_agent(name: &str) -> store::Agent {
    serde_json::from_value(serde_json::json!({
        "id": "riley", "name": name, "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap()
}

fn now() -> i64 {
    Utc.with_ymd_and_hms(2026, 11, 9, 13, 0, 0)
        .unwrap()
        .timestamp_millis()
}

fn four_pm() -> i64 {
    Utc.with_ymd_and_hms(2026, 11, 9, 16, 0, 0)
        .unwrap()
        .timestamp_millis()
}

/// Every Claude Code account is out, Codex has room, nothing chosen yet.
fn out() -> Situation {
    Situation {
        other_room: true,
        ..Situation::default()
    }
}

#[test]
fn a_turn_starts_on_its_own_engine_while_it_has_room() {
    let room = Situation {
        home_room: true,
        other_room: true,
        mode: Mode::Carry,
        ..Situation::default()
    };
    assert_eq!(before_turn(room), Route::Home);
    // Away, and its own engine has room again: back, with a recap.
    assert_eq!(before_turn(Situation { away: true, ..room }), Route::Return);
}

#[test]
fn carrying_on_is_what_the_user_chose_and_never_silent_asking_waits_for_the_turn() {
    // Ask first (the default): the turn tries its own engine; asking comes
    // when it ends on the limit (it may have room after all).
    assert_eq!(before_turn(out()), Route::Home);
    assert_eq!(after_out(out()), Route::Ask { resume: true });
    // One card at a time: another agent's turn waits while it's open.
    assert_eq!(
        after_out(Situation {
            asking: true,
            ..out()
        }),
        Route::Wait
    );
    // Carry on, or "Just this time": straight to the other engine.
    let carry = Situation {
        mode: Mode::Carry,
        ..out()
    };
    assert_eq!(before_turn(carry), Route::Carry);
    assert_eq!(after_out(carry), Route::Carry);
    let once = Situation {
        once: true,
        ..out()
    };
    assert_eq!(before_turn(once), Route::Carry);
    assert_eq!(after_out(once), Route::Carry);
    // Wait for the reset: never.
    let wait = Situation {
        mode: Mode::Wait,
        ..out()
    };
    assert_eq!(before_turn(wait), Route::Home);
    assert_eq!(after_out(wait), Route::Wait);
    // Already away and still out: it stays there, whatever is open.
    assert_eq!(
        before_turn(Situation {
            away: true,
            mode: Mode::Wait,
            ..out()
        }),
        Route::Carry
    );
}

#[test]
fn never_for_an_agent_set_to_one_account_the_apps_own_turn_or_without_room_there() {
    for s in [
        Situation {
            pinned: true,
            mode: Mode::Carry,
            ..out()
        },
        Situation {
            quiet: true,
            mode: Mode::Carry,
            ..out()
        },
        Situation {
            other_room: false,
            mode: Mode::Carry,
            ..out()
        },
    ] {
        assert_eq!(after_out(s), Route::Wait, "{s:?}");
        assert_ne!(before_turn(s), Route::Carry, "{s:?}");
    }
    // Pinned while away: back to its own engine at once.
    assert_eq!(
        before_turn(Situation {
            pinned: true,
            away: true,
            ..out()
        }),
        Route::Return
    );
}

#[test]
fn a_try_that_already_acted_is_never_started_again_in_a_fresh_session() {
    let acted = Situation {
        acted: true,
        mode: Mode::Carry,
        ..out()
    };
    assert_eq!(before_turn(acted), Route::Home);
    assert_eq!(after_out(acted), Route::Held);
    // Asked, a yes then doesn't run it again: the user sends what's left.
    assert_eq!(
        after_out(Situation {
            acted: true,
            ..out()
        }),
        Route::Ask { resume: false }
    );
    let line = held_line(Engine::Claude, Engine::Codex);
    assert!(line.contains("could do it twice"), "{line}");
    assert!(line.contains("it runs on Codex"), "{line}");
}

#[test]
fn the_lines_say_where_it_went_until_when_and_what_stays_behind() {
    let tz = Utc;
    assert_eq!(
        carried_line(
            Engine::Claude,
            Engine::Codex,
            Some(four_pm()),
            None,
            &tz,
            now()
        ),
        "Carried on with Codex (Claude Code is out until 4:00 PM)."
    );
    assert_eq!(
        carried_line(Engine::Claude, Engine::Codex, None, None, &tz, now()),
        "Carried on with Codex (Claude Code is out of usage)."
    );
    // A reset already past isn't named.
    assert!(!carried_line(
        Engine::Claude,
        Engine::Codex,
        Some(now() - 1),
        None,
        &tz,
        now()
    )
    .contains("until"));
    assert_eq!(
        back_line(Engine::Claude),
        "Back on Claude Code: it has room again."
    );

    // Claude in Chrome and claude.ai connectors stay with Claude Code.
    let reach = reach_line(Engine::Codex, true, &["Gmail".into()], true, false).unwrap();
    assert_eq!(
        reach,
        "Claude in Chrome and the claude.ai connector Gmail stay with Claude Code; on Codex it uses your Chrome through the app's own extension."
    );
    let reach = reach_line(
        Engine::Codex,
        false,
        &["Gmail".into(), "Drive".into()],
        false,
        true,
    )
    .unwrap();
    assert!(reach.contains("(Gmail and Drive)"), "{reach}");
    assert!(reach.ends_with("it uses your connections here."), "{reach}");
    assert!(reach_line(Engine::Codex, true, &[], false, false)
        .unwrap()
        .contains("goes without them"));
    // Nothing lost, or going to Claude Code: nothing said.
    assert_eq!(reach_line(Engine::Codex, false, &[], true, true), None);
    assert_eq!(
        reach_line(Engine::Claude, true, &["Gmail".into()], false, false),
        None
    );
    let with = carried_line(
        Engine::Claude,
        Engine::Codex,
        Some(four_pm()),
        Some("Claude in Chrome stays with Claude Code."),
        &tz,
        now(),
    );
    assert!(
        with.ends_with("PM). Claude in Chrome stays with Claude Code."),
        "{with}"
    );
}

#[test]
fn the_card_asks_once_in_plain_words_with_three_answers() {
    let tz = Utc;
    let ask = Ask {
        from: Engine::Claude,
        to: Engine::Codex,
        until: Some(four_pm()),
        resume: true,
    };
    assert_eq!(
        card_title(&ask, 2, &tz, now()),
        "All your Claude Code accounts are out until 4:00 PM. Carry on with Codex until then?"
    );
    assert_eq!(
        card_title(&ask, 1, &tz, now()),
        "Your Claude Code account is out until 4:00 PM. Carry on with Codex until then?"
    );
    let unknown = Ask {
        until: None,
        ..ask.clone()
    };
    assert!(card_title(&unknown, 2, &tz, now()).ends_with("Carry on with Codex until it's back?"));
    let card = card(ask.clone(), "Riley", 2, None, &tz, now());
    assert_eq!(card.crossover.as_ref(), Some(&ask));
    assert!(
        card.tool.is_none(),
        "no tool call: only the user answers it"
    );
    let summary = card.summary.unwrap();
    assert!(
        summary.contains("Riley starts there from your chat and its memory"),
        "{summary}"
    );
    assert!(summary.contains("goes back to it"), "{summary}");
    assert!(!summary.contains("isn't started again"));
    let held = card_detail(
        &Ask {
            resume: false,
            ..ask
        },
        "Riley",
        None,
    );
    assert!(held.contains("isn't started again"), "{held}");

    assert_eq!(answer_of(true, true), Answer::Always);
    assert_eq!(answer_of(true, false), Answer::JustThisTime);
    assert_eq!(answer_of(false, true), Answer::Wait);
    assert_eq!(answer_word(Answer::JustThisTime), "Just this time");
}

#[test]
fn the_other_engine_sees_the_same_agent_without_its_own_engines_session() {
    let mut agent = bare_agent("Riley");
    agent.engine = Engine::Claude;
    agent.session_id = Some("claude-1".into());
    agent.model = Some("opus".into());
    agent.effort = Some("max".into());
    agent.account = Some("work".into());
    agent.away = Some(Away {
        engine: Engine::Codex,
        session_id: None,
        since: 1,
        until: None,
        fresh: false,
    });
    let there = as_on(agent.clone(), Engine::Codex);
    assert_eq!(there.engine, Engine::Codex);
    assert_eq!(
        (there.session_id, there.model, there.effort, there.account),
        (None, None, None, None)
    );
    assert!(!there.new_engine);
    assert_eq!(as_on(agent.clone(), Engine::Claude), agent);

    // Codex's session is kept beside the agent's own, never over it.
    save_session(&mut agent, Engine::Codex, "thread-1".into());
    assert_eq!(agent.session_id.as_deref(), Some("claude-1"));
    assert_eq!(
        session_on(&agent, Engine::Codex).as_deref(),
        Some("thread-1")
    );
    assert_eq!(
        as_on(agent.clone(), Engine::Codex).session_id.as_deref(),
        Some("thread-1")
    );
    drop_session(&mut agent, Engine::Codex);
    assert_eq!(session_on(&agent, Engine::Codex), None);
    assert_eq!(agent.session_id.as_deref(), Some("claude-1"));

    // Start fresh: fresh there too, no recap; moving engine ends it.
    save_session(&mut agent, Engine::Codex, "thread-2".into());
    agent.start_fresh();
    let away = agent.away.clone().unwrap();
    assert_eq!((away.session_id, away.fresh), (None, true));
    agent.switch_engine(Engine::Codex);
    assert_eq!(agent.away, None);
}

fn in_scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn said(agent_id: &str, kind: MessageKind, text: &str, ts: i64) {
    let mut m = runner::new_message(agent_id, kind, text);
    m.ts = ts;
    store::append_message(&m).unwrap();
}

#[test]
fn the_conversation_is_carried_over_by_recap_and_told_on_the_way_back() {
    in_scratch(|| {
        let a = store::create(store::NewAgent {
            name: "Riley".into(),
            role: String::new(),
            instructions: "Be brief.".into(),
            shape: None,
            avatar: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        said(&a.id, MessageKind::User, "Draft the launch post", 1_000);
        said(&a.id, MessageKind::Agent, "Here's a first draft.", 2_000);
        said(
            &a.id,
            MessageKind::Note,
            "Carried on with Codex (Claude Code is out of usage).",
            3_000,
        );
        said(&a.id, MessageKind::User, "Make it shorter", 3_100);
        said(&a.id, MessageKind::Agent, "Shorter version done.", 4_000);

        // Over to Codex: everything visible, under the carry header.
        let carried = runner::with_recap_as(
            &a.id,
            &carry_header(Engine::Claude, Engine::Codex),
            None,
            "Now add a title",
        );
        assert!(
            carried.starts_with("[This conversation started on Claude Code."),
            "{carried}"
        );
        assert!(carried.contains("User: Draft the launch post"), "{carried}");
        assert!(carried.contains("You: Shorter version done."), "{carried}");
        assert!(carried.contains("CLAUDE.md"), "{carried}");
        assert!(
            carried.ends_with("[New message]\n\nNow add a title"),
            "{carried}"
        );
        assert!(
            !carried.contains("Carried on with"),
            "the app's own lines aren't conversation"
        );

        // Back on Claude Code: only what it missed.
        let back = runner::with_recap_as(
            &a.id,
            &back_header(Engine::Claude, Engine::Codex),
            Some(3_000),
            "Publish it",
        );
        assert!(
            back.starts_with("[While every Claude Code account was out of usage"),
            "{back}"
        );
        assert!(back.contains("User: Make it shorter"), "{back}");
        assert!(
            !back.contains("Draft the launch post"),
            "its own session has that: {back}"
        );
        assert!(back.ends_with("Publish it"));
        // Nothing said meanwhile: the message alone.
        assert_eq!(
            runner::with_recap_as(
                &a.id,
                &back_header(Engine::Claude, Engine::Codex),
                Some(9_000),
                "Hi"
            ),
            "Hi"
        );
    });
}

#[test]
fn the_choice_and_this_outages_yes_are_kept_and_the_yes_ends_with_the_outage() {
    in_scratch(|| {
        assert_eq!(mode(Engine::Claude), Mode::Ask, "ask first by default");
        set_mode(Engine::Claude, Mode::Carry).unwrap();
        assert_eq!(mode(Engine::Claude), Mode::Carry);
        assert_eq!(mode(Engine::Codex), Mode::Ask, "each engine its own");

        let t = now();
        assert!(!once(Engine::Codex, t));
        grant_once(Engine::Codex, t).unwrap();
        assert!(once(Engine::Codex, t + 1000));
        assert!(!once(Engine::Codex, t + ONCE_MAX_MS), "never past a week");
        outage_over(Engine::Codex);
        assert!(!once(Engine::Codex, t + 1000), "the next outage asks again");

        set_asking(
            Engine::Claude,
            Asking {
                agent_id: "a".into(),
                request_id: "r1".into(),
                at: t,
            },
        )
        .unwrap();
        assert_eq!(asking(Engine::Claude).unwrap().request_id, "r1");
        // Its card isn't in any chat: not asking any more.
        assert!(!still_asking(Engine::Claude));
        assert_eq!(asking(Engine::Claude), None);

        assert_eq!(Mode::parse("carry_on").unwrap(), Mode::Carry);
        assert!(Mode::parse("sometimes").is_err());
    });
}

#[test]
fn one_set_of_instructions_and_memory_and_memory_saved_on_codex_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    std::fs::write(
        home.join("CLAUDE.md"),
        "# Riley\n\nBe brief.\n\n## Memory\n\nThings worth remembering between conversations. Keep this short and current.\n\n- The launch is on Friday\n",
    )
    .unwrap();
    // No AGENTS.md: it becomes a link to CLAUDE.md, so Codex reads the same.
    assert!(!sync_instructions(home));
    assert_eq!(
        std::fs::read_link(home.join("AGENTS.md")).unwrap(),
        Path::new("CLAUDE.md")
    );
    assert_eq!(
        std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
        std::fs::read_to_string(home.join("CLAUDE.md")).unwrap()
    );
    // Written through the link: one file, nothing to fold.
    assert!(!sync_instructions(home));

    // Codex wrote a file of its own: what CLAUDE.md lacks is kept in memory.
    std::fs::remove_file(home.join("AGENTS.md")).unwrap();
    std::fs::write(
        home.join("AGENTS.md"),
        "# Notes\n\n- The launch is on Friday\n- Sam prefers short posts\n",
    )
    .unwrap();
    assert!(sync_instructions(home));
    let claude = std::fs::read_to_string(home.join("CLAUDE.md")).unwrap();
    assert!(claude.contains("### Saved on Codex"), "{claude}");
    assert!(claude.contains("- Sam prefers short posts"), "{claude}");
    assert_eq!(
        claude.matches("The launch is on Friday").count(),
        1,
        "{claude}"
    );
    assert!(
        claude.starts_with("# Riley\n\nBe brief."),
        "instructions untouched: {claude}"
    );
    assert!(std::fs::symlink_metadata(home.join("AGENTS.md"))
        .unwrap()
        .file_type()
        .is_symlink());
    let entries = crate::agents::memory::entries(&claude);
    assert!(entries
        .iter()
        .any(|e| e.text == "Sam prefers short posts" && e.group.as_deref() == Some(FOLDED_GROUP)));

    assert_eq!(
        new_lines("- a\n- B", "# h\n\n* b\n- c\n- c\n"),
        vec!["c".to_string()]
    );
}

#[test]
fn the_overview_says_what_was_chosen_and_who_is_away() {
    let mut agent = bare_agent("Riley");
    agent.away = Some(Away {
        engine: Engine::Codex,
        session_id: None,
        since: 1,
        until: Some(5),
        fresh: false,
    });
    let v = View {
        claude: Mode::Carry,
        codex: Mode::Ask,
        away: view_away(&[agent]),
    };
    let line = overview_line(&v).unwrap();
    assert!(
        line.contains("When every Claude Code account is out: carry on with Codex."),
        "{line}"
    );
    assert!(
        line.contains("ask first before carrying on with Claude Code"),
        "{line}"
    );
    assert!(
        line.contains("Riley is carrying on with Codex while Claude Code is out."),
        "{line}"
    );
}
