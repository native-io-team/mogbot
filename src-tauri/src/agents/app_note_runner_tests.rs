//! Notes the app queues (child of runner.rs): a late Allow, a card
//! answered, a step-in handed back, a crossover's run again. They start a
//! turn, but the turn is never the user's own request: each consumer of the
//! user-origin signal is checked here against an app note and a typed
//! message, which keeps everything it had.
use super::*;
use crate::agents::independence::Level;
use crate::agents::{approval_claim, mcp};

fn scratch(f: impl FnOnce()) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

fn chief() -> store::Agent {
    store::create(store::NewAgent {
        name: "Chief".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: true,
    })
    .unwrap()
}

fn plain(text: &str, from: From) -> Inbound {
    Inbound {
        id: store::new_id(),
        text: text.into(),
        from,
        reply: false,
        routine: false,
        ticket: None,
        room: None,
        outside: false,
        resume: 0,
        typed: None,
    }
}

/// What `enqueue` queues for the app's own notes.
fn app_note(text: &str) -> Inbound {
    plain(text, From::App)
}

/// What `agents_send` queues when the user types in the chat (desk or phone).
fn typed(text: &str) -> Inbound {
    user_inbound(&store::new_id(), text.into(), Some(text.into()))
}

/// Queue `items` and start the turn that takes them.
fn start(id: &str, items: Vec<Inbound>) -> Batch {
    {
        let mut runtimes = RUNTIMES.lock().unwrap();
        let r = runtimes.entry(id.to_string()).or_default();
        r.queue = items.into();
        r.running = true;
    }
    take_batch(id).expect("a batch")
}

fn done(id: &str) {
    RUNTIMES.lock().unwrap().remove(id);
}

const LATE_ALLOW: &str = "[The user has now approved this, which you asked for earlier: Post to Slack — #general. Carry on with what you were doing.]";
const RESUME: &str = "[Carry on with the other engine: run the turn again.]";
const RELAY: &str =
    "Maya approved this. Post the Slack message under Maya's name, exactly as drafted.";

#[test]
fn an_app_note_is_not_the_user_answering() {
    scratch(|| {
        let id = "app-note-answering";
        start(id, vec![app_note(LATE_ALLOW)]);
        assert!(!answering_user(id));
        done(id);

        start(id, vec![typed("post it")]);
        assert!(answering_user(id));
        done(id);
    });
}

#[test]
fn an_app_note_carries_no_users_words() {
    scratch(|| {
        let id = "app-note-words";
        // "post it to Slack" in an app note never names a service the user asked for.
        start(
            id,
            vec![app_note(
                "[The user said not now to Slack. post it to Slack later]",
            )],
        );
        assert!(users_words(id).is_empty());
        done(id);

        start(id, vec![typed("post it to Slack")]);
        assert_eq!(users_words(id), "post it to Slack");
        done(id);
    });
}

#[test]
fn an_app_note_has_no_typed_words_for_remember_permission() {
    scratch(|| {
        let id = "app-note-typed";
        start(id, vec![app_note(RESUME)]);
        assert_eq!(typed_input(id), None);
        done(id);

        // Behind a typed message, the latest thing is the app's: no words.
        start(id, vec![typed("you can always push"), app_note(LATE_ALLOW)]);
        assert_eq!(typed_input(id), None);
        done(id);

        start(id, vec![typed("you can always push")]);
        assert_eq!(typed_input(id).as_deref(), Some("you can always push"));
        done(id);
    });
}

#[test]
fn go_hard_direct_needs_the_users_own_message() {
    scratch(|| {
        let id = "app-note-direct";
        start(id, vec![app_note(LATE_ALLOW)]);
        assert!(!mcp::owner_direct(Level::GoHard, false, id));
        assert!(!mcp::owner_direct(Level::FullSend, false, id));
        done(id);

        start(id, vec![typed("ship it")]);
        assert!(mcp::owner_direct(Level::GoHard, false, id));
        assert!(!mcp::owner_direct(Level::GoHard, true, id));
        assert!(!mcp::owner_direct(Level::Judgement, false, id));
        done(id);
    });
}

#[test]
fn use_account_asks_on_a_card_after_an_app_note() {
    scratch(|| {
        let id = "app-note-account";
        start(
            id,
            vec![app_note("[Spare capacity — from the app, not the user]")],
        );
        assert!(mcp::use_account_asks(id));
        done(id);

        start(id, vec![typed("use my work account")]);
        assert!(!mcp::use_account_asks(id));
        done(id);
    });
}

#[test]
fn an_app_note_cannot_back_a_relayed_approval() {
    scratch(|| {
        let id = "app-note-claim";
        start(id, vec![app_note(LATE_ALLOW)]);
        assert_eq!(
            approval_claim::check(id, RELAY, store::now_ms()),
            Some(approval_claim::UNBACKED)
        );
        done(id);

        start(id, vec![typed("yes post it")]);
        assert_eq!(approval_claim::check(id, RELAY, store::now_ms()), None);
        done(id);
    });
}

#[test]
fn the_chief_relaying_an_app_note_lifts_nothing() {
    scratch(|| {
        let chief = chief();
        let target = "app-note-target";
        let key = super::super::expiry::ask_key("Post to the feed?", "Fri 10am");
        super::super::expiry::remember(target, key.clone());

        start(&chief.id, vec![app_note(RESUME)]);
        assert!(!relay_lifts_expired(&chief, target));
        assert!(super::super::expiry::already_expired(target, &key));
        assert!(RELAYED.lock().unwrap().get(target).is_none());
        done(&chief.id);

        start(&chief.id, vec![typed("try again")]);
        assert!(relay_lifts_expired(&chief, target));
        assert!(!super::super::expiry::already_expired(target, &key));
        RELAYED.lock().unwrap().remove(target);
        done(&chief.id);
    });
}

#[test]
fn an_app_note_is_not_the_users_ask_for_text() {
    scratch(|| {
        let id = "app-note-said";
        let batch = start(id, vec![app_note("[Paste the text here]")]);
        assert!(batch.user_said.is_empty());
        done(id);

        let batch = start(id, vec![typed("paste the text here")]);
        assert_eq!(batch.user_said, "paste the text here");
        done(id);
    });
}

/// It still runs like the user's turn otherwise: it owes no agent and the
/// hop chain starts over, and its words reach the prompt as written.
#[test]
fn an_app_note_still_runs_and_starts_the_chain_over() {
    scratch(|| {
        let id = "app-note-chain";
        let from_agent = agent_inbound(
            "Draft it".into(),
            AgentRef {
                id: "other".into(),
                name: "Other".into(),
            },
            4,
            false,
            false,
        );
        let batch = start(id, vec![from_agent, app_note(LATE_ALLOW)]);
        assert!(batch.prompt.contains(LATE_ALLOW));
        assert_eq!(next_hop(id), Some(1));
        assert!(!delegated(id), "no card pointer: nobody delegated it");
        done(id);
    });
}

/// A check-in batched with an app note isn't a quiet one: the note is answered.
#[test]
fn a_check_in_with_an_app_note_is_not_quiet() {
    scratch(|| {
        let id = "app-note-quiet";
        let mut fired = plain("[Scheduled check-in]", From::User);
        fired.routine = true;
        fired.ticket = Some("t-app-note".into());
        start(id, vec![fired.clone()]);
        assert!(quiet_check_in(id));
        done(id);

        start(id, vec![fired, app_note(LATE_ALLOW)]);
        assert!(!quiet_check_in(id));
        done(id);
    });
}

/// A pick-up with nothing taken is the app's, never the user's.
#[test]
fn a_bare_pick_up_is_the_apps() {
    let out = resume_inbounds(&[], 1, "[Carry on]".into());
    assert!(matches!(out[0].from, From::App));
}

/// An app note on disk reads back as one (an inbox written before `App`
/// existed still reads its `User` entries).
#[test]
fn an_app_note_survives_the_inbox() {
    let raw = serde_json::to_string(&vec![app_note("x"), typed("y")]).unwrap();
    let back: Vec<Inbound> = serde_json::from_str(&raw).unwrap();
    assert!(matches!(back[0].from, From::App));
    assert!(matches!(back[1].from, From::User));
    assert_eq!(back[1].typed.as_deref(), Some("y"));
}

/// Every note the app queues through `enqueue` is `From::App`: only
/// `enqueue_user` (and the scheduled, room and outside wakes, whose own
/// flags say what they are) queue `From::User`, all in the runner.
#[test]
fn nothing_outside_the_runner_enqueues_as_the_user() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = Vec::new();
    for dir in ["agents", "commands", "companion", "remote_access"] {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".rs") || name.ends_with("tests.rs") || name == "runner.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if text.contains("From::User") {
                found.push(name);
            }
        }
    }
    assert!(
        found.is_empty(),
        "app notes queued as the user in {found:?}"
    );
}
