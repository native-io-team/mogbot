//! Nested hand-offs (child of runner.rs): an answer to a request an agent
//! made while answering someone else reports back up the chain.

use super::*;

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

fn who(a: &store::Agent) -> AgentRef {
    AgentRef {
        id: a.id.clone(),
        name: a.name.clone(),
    }
}

fn says(text: &str, sender: &store::Agent, reply: bool) -> Inbound {
    agent_inbound(text.into(), who(sender), 2, reply, false)
}

fn queue(agent_id: &str, m: Inbound) {
    let mut rt = RUNTIMES.lock().unwrap();
    let r = rt.entry(agent_id.to_string()).or_default();
    r.running = true;
    r.queue.push_back(m);
}

/// Chief → Planner → Copywriter: the copywriter's answer reaches a Planner
/// turn that owes the Chief, so the Chief hears the outcome (it used to be
/// posted in Planner's own chat, and the Chief waited for good).
#[test]
fn an_answer_to_a_request_made_for_someone_else_goes_back_up() {
    scratch(|| {
        let chief = agent("Chief");
        let planner = agent("Planner");
        let copy = agent("Copywriter");

        // Planner is answering the Chief's request when it asks Copywriter.
        queue(&planner.id, says("Draft the launch post", &chief, false));
        take_batch(&planner.id).unwrap();
        note_onward(&planner.id, &copy.id);
        // Its turn ends (its interim words go to the Chief, as before).
        assert_eq!(take_owed(&planner.id).len(), 1);

        // Copywriter's answer arrives in a new Planner turn.
        queue(
            &planner.id,
            says("Reworded in the house voice.", &copy, true),
        );
        let batch = take_batch(&planner.id).unwrap();
        assert!(batch.prompt.contains("goes back to Chief automatically"));
        assert!(!batch.prompt.contains("tell the user"));
        let owed = take_owed(&planner.id);
        assert_eq!(
            owed.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            [chief.id.as_str()]
        );

        // A request Planner sends with nobody waiting on it carries nothing
        // up: the next answer is Planner's to tell the user.
        note_onward(&planner.id, &copy.id);
        queue(&planner.id, says("Here's another.", &copy, true));
        let batch = take_batch(&planner.id).unwrap();
        assert!(batch.prompt.contains("tell the user"));
        assert!(take_owed(&planner.id).is_empty());

        for a in [&chief, &planner, &copy] {
            RUNTIMES.lock().unwrap().remove(&a.id);
        }
    });
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
        conversation: None,
    }
}

/// The worker going idle, as after a turn.
fn finish(agent_id: &str) {
    assert!(finish_if_idle(agent_id).is_some());
}

/// A card that expired in Planner can be raised again when the user asks
/// through the Chief ("try again"): the Chief relaying the user's own words
/// is as good as the user writing to Planner.
#[test]
fn the_chief_relaying_the_users_try_again_lets_an_expired_card_ask_again() {
    scratch(|| {
        let chief = chief();
        let planner = agent("Planner");
        let key = super::super::expiry::ask_key("Post to the feed?", "Fri 10am");
        super::super::expiry::remember(&planner.id, key.clone());

        // The Chief working on its own (another agent's message): no lift.
        queue(&chief.id, says("Status?", &planner, false));
        take_batch(&chief.id).unwrap();
        assert!(!relay_lifts_expired(&chief, &planner.id));
        assert!(super::super::expiry::already_expired(&planner.id, &key));
        finish(&chief.id);

        // A routine of the Chief's isn't the user either.
        let mut routine = user("Morning brief");
        routine.routine = true;
        routine.ticket = Some("t1".into());
        queue(&chief.id, routine);
        take_batch(&chief.id).unwrap();
        assert!(!relay_lifts_expired(&chief, &planner.id));
        finish(&chief.id);

        // A plain agent passing on its user's words has no such say.
        let helper = agent("Helper");
        queue(&helper.id, user("try again"));
        take_batch(&helper.id).unwrap();
        assert!(!relay_lifts_expired(&helper, &planner.id));
        assert!(super::super::expiry::already_expired(&planner.id, &key));

        // The user's own "try again", passed on by the Chief: lifted.
        queue(&chief.id, user("try again"));
        take_batch(&chief.id).unwrap();
        assert!(relay_lifts_expired(&chief, &planner.id));
        assert!(!super::super::expiry::already_expired(&planner.id, &key));

        for a in [&chief, &planner, &helper] {
            RUNTIMES.lock().unwrap().remove(&a.id);
        }
    });
}

/// An agent working for another one raises a card: the Chief's chat, where
/// the user is talking, gets a line naming it (the name links to its chat).
#[test]
fn a_delegated_agents_card_is_pointed_to_where_the_user_is_talking() {
    scratch(|| {
        let chief = chief();
        let planner = agent("Planner");
        queue(&planner.id, says("Schedule the post", &chief, false));
        take_batch(&planner.id).unwrap();
        assert!(delegated(&planner.id));
        assert_eq!(
            card_pointer("Planner", "Post to the feed?"),
            "Planner is waiting on your OK in its chat: Post to the feed"
        );
        finish(&planner.id);
        // Asked by the user in its own chat: the card is where they are.
        queue(&planner.id, user("Schedule it"));
        take_batch(&planner.id).unwrap();
        assert!(!delegated(&planner.id));
        for a in [&chief, &planner] {
            RUNTIMES.lock().unwrap().remove(&a.id);
        }
    });
}

/// One pointer per wait: a card joining others still waiting adds no line,
/// and a new wait soon after the last pointer adds none either.
#[test]
fn one_pointer_stands_for_an_agents_cards_while_they_wait() {
    let now = 1_800_000_000_000;
    assert!(pointer_due(1, None, now));
    // Another card of its own is still open: the last line still says so.
    assert!(!pointer_due(2, None, now));
    assert!(!pointer_due(3, Some(now - POINTER_QUIET_MS * 4), now));
    // Its earlier cards answered, but the last line was minutes ago.
    assert!(!pointer_due(1, Some(now - 60_000), now));
    assert!(pointer_due(1, Some(now - POINTER_QUIET_MS), now));
}

/// Only a turn answering nothing but scheduled runs may end with no post.
#[test]
fn only_a_check_in_alone_may_finish_with_nothing_new() {
    scratch(|| {
        let sweeper = agent("Sweeper");
        let mut fired = user("[Scheduled check-in you set: sweep the inbox]");
        fired.routine = true;
        fired.ticket = Some("t-sweep".into());
        queue(&sweeper.id, fired.clone());
        take_batch(&sweeper.id).unwrap();
        assert!(quiet_check_in(&sweeper.id));
        finish(&sweeper.id);
        take_tickets(&sweeper.id);

        // The user wrote too: their message gets an answer.
        queue(&sweeper.id, fired);
        queue(&sweeper.id, user("anything from the bank?"));
        take_batch(&sweeper.id).unwrap();
        assert!(!quiet_check_in(&sweeper.id));
        RUNTIMES.lock().unwrap().remove(&sweeper.id);
    });
}

/// An answer to this agent's own message, owing nobody, may end with no
/// post; one carrying an outcome up the chain, or batched with the user's
/// words, a request or a routine, may not.
#[test]
fn only_answers_owing_nobody_may_finish_with_nothing_new() {
    scratch(|| {
        let chief = agent("Chief");
        let ops = agent("Ops");
        let helper = agent("Helper");

        // Ops sent the Chief a report; two acknowledgements come back.
        queue(&ops.id, says("Noted, nothing to patch.", &chief, true));
        queue(&ops.id, says("Helper confirmed it too.", &chief, true));
        let batch = take_batch(&ops.id).unwrap();
        assert!(batch.prompt.contains("[nothing new]"));
        assert!(quiet_answer(&ops.id));
        assert!(!quiet_check_in(&ops.id), "not a check-in");
        finish(&ops.id);

        // With the user's own words: they get an answer.
        queue(&ops.id, says("Noted.", &chief, true));
        queue(&ops.id, user("anything else?"));
        take_batch(&ops.id).unwrap();
        assert!(!quiet_answer(&ops.id));
        finish(&ops.id);

        // A request from another agent is owed a reply.
        queue(&ops.id, says("Check the Node versions.", &chief, false));
        take_batch(&ops.id).unwrap();
        assert!(!quiet_answer(&ops.id));
        take_owed(&ops.id);
        finish(&ops.id);

        // An answer to a request made for the Chief carries its outcome up.
        queue(&ops.id, says("Check the Node versions.", &chief, false));
        take_batch(&ops.id).unwrap();
        note_onward(&ops.id, &helper.id);
        take_owed(&ops.id);
        finish(&ops.id);
        queue(&ops.id, says("All on 22.x.", &helper, true));
        let batch = take_batch(&ops.id).unwrap();
        assert!(!batch.prompt.contains("[nothing new]"));
        assert!(!quiet_answer(&ops.id));
        RUNTIMES.lock().unwrap().remove(&ops.id);
    });
}

/// Three deep: each level is noted as it asks, so the outcome climbs.
#[test]
fn a_three_level_chain_reports_all_the_way_up() {
    scratch(|| {
        let chief = agent("Chief");
        let a = agent("Alpha");
        let b = agent("Bravo");
        let c = agent("Charlie");

        queue(&a.id, says("go", &chief, false));
        take_batch(&a.id).unwrap();
        note_onward(&a.id, &b.id);
        take_owed(&a.id);

        queue(&b.id, says("go", &a, false));
        take_batch(&b.id).unwrap();
        note_onward(&b.id, &c.id);
        take_owed(&b.id);

        // Charlie answers Bravo: Bravo now owes Alpha.
        queue(&b.id, says("done", &c, true));
        take_batch(&b.id).unwrap();
        assert_eq!(take_owed(&b.id)[0].id, a.id);
        // Bravo's outcome answers Alpha: Alpha now owes the Chief.
        queue(&a.id, says("done", &b, true));
        take_batch(&a.id).unwrap();
        assert_eq!(take_owed(&a.id)[0].id, chief.id);

        for x in [&chief, &a, &b, &c] {
            RUNTIMES.lock().unwrap().remove(&x.id);
        }
    });
}
