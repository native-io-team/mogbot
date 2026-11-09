//! One answer per card, with answers racing on real threads. Every agent,
//! card, site and channel here is made up.
use super::*;
use crate::agents::store::{AgentMessage, MessageKind};
use crate::agents::{crossover, handoff, mcp, permissions, plan_grant, runner};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};

/// How many answers race on each card: the desk, the phone, a typed yes,
/// an admin agent, and a few more for luck.
const RACERS: usize = 8;

fn in_scratch(f: impl FnOnce(&str)) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let agent = store::create(store::NewAgent {
        name: "Juniper".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: true,
    })
    .unwrap();
    f(&agent.id);
    store::set_root_for_tests(None);
}

fn post(agent_id: &str, approval: Approval) -> String {
    let id = approval.request_id.clone();
    let mut m = runner::new_message(agent_id, MessageKind::Approval, "");
    m.approval = Some(approval);
    store::append_message(&m).unwrap();
    id
}

fn plain(id: &str) -> Approval {
    mcp::new_card(
        id.into(),
        "Run a command".into(),
        "npm run lint".into(),
        None,
    )
}

fn with(id: &str, field: &str, value: serde_json::Value) -> Approval {
    let mut v = serde_json::to_value(plain(id)).unwrap();
    v[field] = value;
    serde_json::from_value(v).unwrap()
}

fn from_fixture(m: AgentMessage, id: &str) -> Approval {
    let mut a = m.approval.unwrap();
    a.request_id = id.into();
    a
}

/// One card of every kind a person can answer.
fn every_kind() -> Vec<(&'static str, Approval)> {
    use crate::companion::testkit;
    let mut always = plain("k-approval-always");
    always.tool = Some("Bash".into());
    always.input = Some(serde_json::json!({ "command": "npm run lint" }));
    always.always = Some(permissions::Scope {
        kind: permissions::RuleKind::CommandPrefix,
        value: "npm run lint".into(),
        label: "npm run lint".into(),
        said: None,
    });
    let switch = {
        let mut a = crate::agents::usage_tools::switch_card(
            crate::agents::engine::Engine::Claude,
            "acct-2",
            "Side project",
        );
        a.request_id = "k-switch".into();
        a
    };
    vec![
        ("approval", always),
        ("plan", from_fixture(testkit::plan_card(), "k-plan")),
        (
            "secret",
            with(
                "k-secret",
                "secret",
                serde_json::json!({
                    "name": "FICTIONAL_API_KEY", "purpose": "Read the made-up CRM",
                    "kind": "api_key", "fields": [], "reference": ""
                }),
            ),
        ),
        ("login", from_fixture(testkit::login_card(), "k-login")),
        (
            "settings",
            from_fixture(testkit::settings_card(), "k-settings"),
        ),
        (
            "step-in",
            with(
                "k-step-in",
                "stepIn",
                serde_json::json!({
                    "reason": "Solve the puzzle on the sign-in page",
                    "site": "accounts.example.com",
                    "url": "https://accounts.example.com/check", "tab": 2
                }),
            ),
        ),
        ("crossover", {
            let mut a = crossover::card(
                crossover::Ask {
                    from: crate::agents::engine::Engine::Claude,
                    to: crate::agents::engine::Engine::Codex,
                    until: None,
                    resume: true,
                },
                "Juniper",
                1,
                None,
                &chrono::Utc,
                1_762_700_000_000,
            );
            a.request_id = "k-crossover".into();
            a
        }),
        ("routine gate", from_fixture(testkit::gate_card(), "k-gate")),
        ("account switch", switch),
        (
            "slack reply",
            with(
                "k-slack",
                "slackReply",
                serde_json::json!({
                    "channel": "C0FAKE", "threadTs": "1762700000.000100",
                    "place": "#made-up-launch", "text": "Shipping Thursday."
                }),
            ),
        ),
        (
            "browser front",
            with(
                "k-front",
                "front",
                serde_json::json!({ "site": "mail.example.com" }),
            ),
        ),
        (
            "handover",
            with(
                "k-handoff",
                "handoff",
                serde_json::json!({ "source": "Some Other Assistant", "parts": 2 }),
            ),
        ),
        (
            "import consent",
            with(
                "k-connector",
                "connector",
                serde_json::json!({
                    "kind": "consent", "talkId": "t-1", "source": "Some Other Assistant"
                }),
            ),
        ),
    ]
}

/// What a racer did.
#[derive(Debug)]
enum Outcome {
    Won(String),
    Lost(String),
}

/// One answer, the way every path gives one: claim, read, write, and only
/// then the side effects (counted in `acted`; an Always's rule in `rules`).
fn answer(
    agent_id: &str,
    request_id: &str,
    allow: bool,
    always: bool,
    acted: &AtomicUsize,
    rules: &AtomicUsize,
) -> Outcome {
    let word = said(allow, always, None);
    let _claim = match claim(agent_id, request_id, &word) {
        Ok(c) => c,
        Err(e) => return Outcome::Lost(e.to_string()),
    };
    let card = store::find_approval(agent_id, request_id).unwrap().unwrap();
    if card.status != ApprovalStatus::Pending {
        return Outcome::Lost(lost(agent_id, request_id).to_string());
    }
    // The worst order a handler has: act first (post, switch, store a key,
    // keep a rule), write the answer after, with time in between. Only the
    // claim keeps a second answer from acting too.
    acted.fetch_add(1, Ordering::SeqCst);
    if allow && always {
        rules.fetch_add(1, Ordering::SeqCst);
    }
    std::thread::sleep(std::time::Duration::from_millis(5));
    let status = if allow {
        ApprovalStatus::Allowed
    } else {
        ApprovalStatus::Denied
    };
    let written = match (&card.always, allow && always) {
        (Some(scope), true) => store::allow_always(agent_id, request_id, scope),
        _ => store::set_approval_status(agent_id, request_id, status),
    }
    .unwrap();
    assert!(
        written.is_some(),
        "the claim holder's answer is the one written"
    );
    Outcome::Won(word)
}

/// `RACERS` threads answer one card at the same instant, half Allow (some
/// Always) and half Deny.
fn race(agent_id: &str, request_id: &str) -> (Vec<Outcome>, usize, usize) {
    // Always is offered only where the card has a rule to keep.
    let offers_always = store::find_approval(agent_id, request_id)
        .unwrap()
        .unwrap()
        .always
        .is_some();
    let acted = Arc::new(AtomicUsize::new(0));
    let rules = Arc::new(AtomicUsize::new(0));
    let start = Arc::new(Barrier::new(RACERS));
    let handles: Vec<_> = (0..RACERS)
        .map(|i| {
            let (agent_id, request_id) = (agent_id.to_string(), request_id.to_string());
            let (acted, rules, start) = (acted.clone(), rules.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                let always = offers_always && i % 4 == 0;
                answer(&agent_id, &request_id, i % 2 == 0, always, &acted, &rules)
            })
        })
        .collect();
    let outcomes = handles.into_iter().map(|h| h.join().unwrap()).collect();
    (
        outcomes,
        acted.load(Ordering::SeqCst),
        rules.load(Ordering::SeqCst),
    )
}

#[test]
fn every_kind_of_card_takes_exactly_one_of_many_racing_answers() {
    in_scratch(|agent| {
        for (kind, card) in every_kind() {
            let id = post(agent, card);
            let (outcomes, acted, rules) = race(agent, &id);
            assert_eq!(acted, 1, "{kind}: exactly one answer acted");
            let winner: Vec<&String> = outcomes
                .iter()
                .filter_map(|o| match o {
                    Outcome::Won(w) => Some(w),
                    Outcome::Lost(_) => None,
                })
                .collect();
            assert_eq!(winner.len(), 1, "{kind}: {outcomes:?}");
            let won = winner[0].clone();
            let after = store::find_approval(agent, &id).unwrap().unwrap();
            assert_ne!(after.status, ApprovalStatus::Pending, "{kind}");
            // The card says what won, and an Always rule only came with it.
            assert_eq!(answered_word(&after), won, "{kind}");
            assert_eq!(rules, usize::from(won == "Always allowed"), "{kind}: {won}");
            for o in &outcomes {
                if let Outcome::Lost(why) = o {
                    assert!(why.starts_with("Already answered: "), "{kind}: {why}");
                }
            }
            // Whoever comes later is told the answer that won.
            let late = claim(agent, &id, "Denied").unwrap_err().to_string();
            assert_eq!(late, format!("Already answered: {won}."), "{kind}");
        }
    });
}

#[test]
fn a_loser_while_the_winner_is_still_acting_is_told_what_it_is_answering() {
    in_scratch(|agent| {
        let id = post(agent, plain("r-1"));
        let held = claim(agent, &id, "Allowed").unwrap();
        assert!(in_flight(&id));
        let err = claim(agent, &id, "Denied").unwrap_err().to_string();
        assert_eq!(err, "Already answered: Allowed.");
        assert!(try_claim(agent, &id, "Allowed").is_none());
        drop(held);
        assert!(!in_flight(&id));
    });
}

/// A key that has to be typed, an account that's gone: the answer is
/// refused, nothing is written, and the card is open for the next one.
#[test]
fn a_refused_answer_leaves_the_card_open() {
    in_scratch(|agent| {
        let id = post(agent, plain("r-2"));
        {
            let _c = claim(agent, &id, "Allowed").unwrap();
            // ...refused: dropped without writing.
        }
        let again = claim(agent, &id, "Denied").unwrap();
        assert!(
            store::set_approval_status(agent, &id, ApprovalStatus::Denied)
                .unwrap()
                .is_some()
        );
        drop(again);
        assert_eq!(
            claim(agent, &id, "Allowed").unwrap_err().to_string(),
            "Already answered: Denied."
        );
    });
}

/// The wait on a card running out as the user answers it: the answer
/// stands, not the expiry.
#[test]
fn expiry_never_closes_a_card_being_answered() {
    in_scratch(|agent| {
        let id = post(agent, plain("r-3"));
        let held = claim(agent, &id, "Allowed").unwrap();
        assert!(
            store::expire_card(agent, &id, crate::agents::expiry::Expiry::NoAnswer)
                .unwrap()
                .is_none()
        );
        assert!(
            store::set_approval_status(agent, &id, ApprovalStatus::Allowed)
                .unwrap()
                .is_some()
        );
        drop(held);
        let card = store::find_approval(agent, &id).unwrap().unwrap();
        assert_eq!(card.status, ApprovalStatus::Allowed);
    });
}

/// The carry-on card through its real answer: Always on the desk and Wait
/// on the phone at once set the team's choice once, from the winner only.
#[test]
fn crossover_racing_always_and_wait_sets_only_the_winners_choice() {
    in_scratch(|agent| {
        let (_, card) = every_kind()
            .into_iter()
            .find(|(k, _)| *k == "crossover")
            .unwrap();
        let id = post(agent, card.clone());
        let resumed = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(RACERS));
        let won: Vec<Option<bool>> = (0..RACERS)
            .map(|i| {
                let (agent, id, card) = (agent.to_string(), id.clone(), card.clone());
                let (resumed, start) = (resumed.clone(), start.clone());
                std::thread::spawn(move || {
                    let allow = i % 2 == 0;
                    start.wait();
                    let _c = claim(&agent, &id, &said(allow, true, None)).ok()?;
                    let s =
                        crossover::settle(&agent, &card, allow, true, 1_762_700_000_000).ok()?;
                    if s.resume {
                        resumed.fetch_add(1, Ordering::SeqCst);
                    }
                    Some(allow)
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        let winners: Vec<bool> = won.into_iter().flatten().collect();
        assert_eq!(winners.len(), 1);
        let allowed = winners[0];
        let mode = crossover::mode(crate::agents::engine::Engine::Claude);
        if allowed {
            assert_eq!(mode, crossover::Mode::Carry);
            assert_eq!(
                resumed.load(Ordering::SeqCst),
                1,
                "the turn runs again once"
            );
        } else {
            assert_ne!(
                mode,
                crossover::Mode::Carry,
                "Always after Wait never sticks"
            );
            assert_eq!(resumed.load(Ordering::SeqCst), 0);
        }
    });
}

/// "Do these under your name?": a plan is granted only by an Allow that
/// closed the card, never by one that lost to a Deny.
#[test]
fn a_plan_is_granted_only_by_the_allow_that_won() {
    in_scratch(|agent| {
        let (_, card) = every_kind()
            .into_iter()
            .find(|(k, _)| *k == "plan")
            .unwrap();
        let plan = card.plan.clone().unwrap();
        let id = post(agent, card);
        let start = Arc::new(Barrier::new(RACERS));
        let now = 1_762_700_000_000;
        let handles: Vec<_> = (0..RACERS)
            .map(|i| {
                let (agent, id, plan) = (agent.to_string(), id.clone(), plan.clone());
                let start = start.clone();
                std::thread::spawn(move || {
                    let allow = i % 2 == 1;
                    start.wait();
                    let _c = claim(&agent, &id, &said(allow, false, None)).ok()?;
                    let status = if allow {
                        ApprovalStatus::Allowed
                    } else {
                        ApprovalStatus::Denied
                    };
                    store::set_approval_status(&agent, &id, status).ok()??;
                    if allow {
                        plan_grant::grant(&agent, &plan, now);
                    }
                    Some(allow)
                })
            })
            .collect();
        let winners: Vec<bool> = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(plan_grant::holds(agent, now), winners[0]);
    });
}

/// The handover card through its real answer: Save to memory and Ignore at
/// once queue the Chief's turn at most once.
#[test]
fn a_handover_saves_to_memory_at_most_once() {
    in_scratch(|agent| {
        let (_, card) = every_kind()
            .into_iter()
            .find(|(k, _)| *k == "handover")
            .unwrap();
        let id = post(agent, card.clone());
        let start = Arc::new(Barrier::new(RACERS));
        let handles: Vec<_> = (0..RACERS)
            .map(|i| {
                let (agent, id, card) = (agent.to_string(), id.clone(), card.clone());
                let start = start.clone();
                std::thread::spawn(move || {
                    let allow = i % 3 != 0;
                    start.wait();
                    let _c = claim(&agent, &id, &said(allow, false, None)).ok()?;
                    let (_, turn) = handoff::answer(&agent, &card, allow).ok()?;
                    Some(turn.is_some())
                })
            })
            .collect();
        let winners: Vec<bool> = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(winners.len(), 1, "one answer, one turn at most");
    });
}

#[test]
fn the_winning_answer_reads_in_plain_words() {
    let mut a = plain("w");
    a.status = ApprovalStatus::Allowed;
    assert_eq!(answered_word(&a), "Allowed");
    a.always_allowed = true;
    assert_eq!(answered_word(&a), "Always allowed");
    a.status = ApprovalStatus::Denied;
    a.always_allowed = false;
    a.note = Some("use the staging bucket".into());
    assert_eq!(answered_word(&a), "Denied (\"use the staging bucket\")");
    a.choice = Some("Just this time".into());
    assert_eq!(answered_word(&a), "Just this time");
    assert_eq!(said(true, true, None), "Always allowed");
    assert_eq!(said(false, true, None), "Denied");
    assert_eq!(said(true, false, Some("Wait")), "Wait");
}
