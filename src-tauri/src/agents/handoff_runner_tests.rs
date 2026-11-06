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
