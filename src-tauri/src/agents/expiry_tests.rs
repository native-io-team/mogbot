use super::*;
use crate::agents::store::{ApprovalStatus, MessageKind, NewAgent};
use serde_json::json;

fn with_root<F: FnOnce()>(f: F) {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    store::set_root_for_tests(None);
}

// A fictional agent.
fn agent() -> store::Agent {
    store::create(NewAgent {
        name: "Researcher".into(),
        role: "Looks things up".into(),
        instructions: "Be brief.".into(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap()
}

fn bash_card(id: &str, command: &str) -> Approval {
    let input = json!({ "command": command });
    super::super::mcp::new_card(
        id.into(),
        "Run a command".into(),
        command.into(),
        Some(("Bash", &input)),
    )
}

fn post(agent_id: &str, approval: Approval, ts: i64) {
    let mut m = super::super::runner::new_message(agent_id, MessageKind::Approval, "");
    m.ts = ts;
    m.approval = Some(approval);
    store::append_message(&m).unwrap();
    store::refresh_pending(agent_id);
}

fn status(agent_id: &str, rid: &str) -> (ApprovalStatus, Option<Expiry>) {
    let a = store::find_approval(agent_id, rid).unwrap().unwrap();
    (a.status, a.expiry)
}

const MIN: i64 = 60_000;

#[test]
fn a_card_whose_turn_ended_closes_at_once_as_moved_on() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        post(&a.id, bash_card("r1", "npm test"), now);
        assert_eq!(store::get(&a.id).unwrap().pending_approvals, 1);
        let changed = sweep_store(&a.id, Moment::TurnEnded, now, &|_| true);
        assert_eq!(changed.len(), 1);
        assert_eq!(
            status(&a.id, "r1"),
            (ApprovalStatus::Expired, Some(Expiry::MovedOn))
        );
        // Badges count only pending cards: an expired one is not among them.
        assert_eq!(store::get(&a.id).unwrap().pending_approvals, 0);
        assert!(store::pending_approvals(&a.id).unwrap().is_empty());
    });
}

#[test]
fn a_card_still_blocking_a_turn_waits_then_expires_as_no_answer() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        post(&a.id, bash_card("r1", "npm test"), now - 2 * MIN);
        // Still waited on, within the timeout: left alone.
        assert!(sweep_store(&a.id, Moment::Tick, now, &|_| true).is_empty());
        assert_eq!(status(&a.id, "r1").0, ApprovalStatus::Pending);
        // Past the timeout: closed, and remembered for this task.
        let later = now + (CARD_EXPIRY_SECS as i64) * 1000;
        assert_eq!(sweep_store(&a.id, Moment::Tick, later, &|_| true).len(), 1);
        assert_eq!(
            status(&a.id, "r1"),
            (ApprovalStatus::Expired, Some(Expiry::NoAnswer))
        );
        let input = json!({ "command": "npm test" });
        assert!(already_expired(&a.id, &tool_key("Bash", &input)));
    });
}

#[test]
fn a_card_nobody_waits_on_closes_on_the_next_look() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        post(&a.id, bash_card("r1", "ls"), now);
        sweep_store(&a.id, Moment::Tick, now, &|_| false);
        assert_eq!(
            status(&a.id, "r1"),
            (ApprovalStatus::Expired, Some(Expiry::MovedOn))
        );
    });
}

#[test]
fn sign_ins_and_secrets_become_maybe_later_and_are_not_asked_again() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        let request = super::super::secrets::build_request(
            &a,
            "STRIPE_KEY",
            "To read last month's invoices",
            "api_key",
            &[],
        )
        .unwrap();
        let mut card = super::super::mcp::new_card(
            "s1".into(),
            "Secure input · STRIPE_KEY".into(),
            request.purpose.clone(),
            None,
        );
        let name = request.name.clone();
        card.secret = Some(request);
        post(&a.id, card, now);
        // A turn ending doesn't close it: a secure input blocks nothing.
        sweep_store(&a.id, Moment::TurnEnded, now, &|_| false);
        assert_eq!(status(&a.id, "s1").0, ApprovalStatus::Pending);
        let later = now + (CARD_EXPIRY_SECS as i64) * 1000 + 1;
        sweep_store(&a.id, Moment::Tick, later, &|_| false);
        assert_eq!(
            status(&a.id, "s1"),
            (ApprovalStatus::Expired, Some(Expiry::MaybeLater))
        );
        assert!(already_expired(&a.id, &secret_key(&name)));
        // The user writes: a new task, it may ask again.
        new_task(&a.id);
        assert!(!already_expired(&a.id, &secret_key(&name)));
    });
}

#[test]
fn launch_sweeps_old_state_and_keeps_answered_cards() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        // State an older build left: a permission card kept "answerable"
        // across restarts, and one answered.
        post(
            &a.id,
            bash_card("old", "rm -rf build"),
            now - 3 * 24 * 60 * MIN,
        );
        post(&a.id, bash_card("done", "ls"), now - MIN);
        store::set_approval_status(&a.id, "done", ApprovalStatus::Allowed).unwrap();
        store::expire_stale_approvals();
        assert_eq!(
            status(&a.id, "old"),
            (ApprovalStatus::Expired, Some(Expiry::MovedOn))
        );
        assert_eq!(status(&a.id, "done"), (ApprovalStatus::Allowed, None));
        assert_eq!(store::get(&a.id).unwrap().pending_approvals, 0);
    });
}

#[test]
fn the_same_ask_has_one_key_however_it_is_worded_around() {
    let a = bash_card("r1", "npm test");
    let mut b = bash_card("r2", "npm test");
    b.detail = "npm test\n\nTo check the build".into();
    assert_eq!(key_for(&a), key_for(&b));
    assert_ne!(key_for(&a), key_for(&bash_card("r3", "npm run build")));
}

#[test]
fn verdicts() {
    let card = bash_card("r1", "ls");
    let over = (CARD_EXPIRY_SECS as i64) * 1000;
    assert_eq!(verdict(&card, 0, true, Moment::Tick), None);
    assert_eq!(
        verdict(&card, over, true, Moment::Tick),
        Some(Expiry::NoAnswer)
    );
    assert_eq!(
        verdict(&card, 0, true, Moment::Launch),
        Some(Expiry::MovedOn)
    );
    assert_eq!(
        verdict(&card, 0, true, Moment::TurnEnded),
        Some(Expiry::MovedOn)
    );
}

/// The two shapes of the pending "Run a command" cards in a real chat from
/// before "Go hard" (values fictional): a plain one, and one raised while
/// answering outside text. Both close at launch as "moved on".
#[test]
fn run_a_command_cards_from_before_go_hard_expire_at_launch() {
    for raw in [
        json!({
            "requestId": "r-old-1", "status": "pending", "title": "Run a command",
            "detail": "npm run dev", "tool": "Bash",
            "input": { "command": "npm run dev", "description": "to preview the site" }
        }),
        json!({
            "requestId": "r-old-2", "status": "pending", "title": "Run a command",
            "detail": "ls ~/Downloads", "tool": "Bash", "fromOutside": true,
            "summary": "List the downloads folder",
            "input": { "command": "ls ~/Downloads" }
        }),
    ] {
        let a: Approval = serde_json::from_value(raw).unwrap();
        assert_eq!(
            verdict(&a, 10 * 24 * 3_600_000, false, Moment::Launch),
            Some(Expiry::MovedOn)
        );
    }
}

/// What an import left in a real team (names fictional): old-style secure
/// inputs (`quiet`, before sign-in cards), Grok-era commands and a web
/// search, all still "pending". At launch every one closes, the young
/// secure inputs too, and nothing counts as needing the user any more.
#[test]
fn an_imports_leftover_cards_all_close_at_launch() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        let old_secret: Approval = serde_json::from_value(json!({
            "requestId": "s-old",
            "title": "Secure input · fictional_workspace",
            "detail": "Company syncs",
            "status": "pending",
            "secret": {
                "fields": [{ "env": "FICTIONAL_WORKSPACE", "label": "Value" }],
                "kind": "other",
                "name": "fictional_workspace",
                "purpose": "Company syncs",
                "quiet": true,
                "reference": "secret:researcher/fictional_workspace"
            }
        }))
        .unwrap();
        post(&a.id, old_secret, now - MIN);
        post(
            &a.id,
            bash_card("grok", "cd /workspace/fictional-outreach 2>&1 && ls -la"),
            now - MIN,
        );
        let search: Approval = serde_json::from_value(json!({
            "requestId": "web",
            "title": "Search the web",
            "detail": "fictional rates 2026",
            "status": "pending",
            "tool": "WebSearch",
            "input": { "mode": "standard", "query": "fictional rates 2026" },
            "always": { "kind": "tool", "label": "web searches", "value": "WebSearch" }
        }))
        .unwrap();
        post(&a.id, search, now - MIN);
        assert_eq!(store::get(&a.id).unwrap().pending_approvals, 3);
        store::expire_stale_approvals();
        assert_eq!(
            status(&a.id, "s-old"),
            (ApprovalStatus::Expired, Some(Expiry::MaybeLater))
        );
        assert_eq!(
            status(&a.id, "grok"),
            (ApprovalStatus::Expired, Some(Expiry::MovedOn))
        );
        assert_eq!(
            status(&a.id, "web"),
            (ApprovalStatus::Expired, Some(Expiry::MovedOn))
        );
        assert_eq!(store::get(&a.id).unwrap().pending_approvals, 0);
        assert!(store::pending_approvals(&a.id).unwrap().is_empty());
    });
}

/// A young secure input an agent asks for now still waits for its answer;
/// an import's old-style one closes on any look.
#[test]
fn only_old_style_secure_inputs_close_young() {
    let mut card = bash_card("s", "x");
    card.tool = None;
    card.input = None;
    card.secret = Some(
        serde_json::from_value(json!({
            "fields": [], "kind": "other", "name": "n", "purpose": "p", "reference": "r"
        }))
        .unwrap(),
    );
    assert_eq!(verdict(&card, 0, false, Moment::Tick), None);
    assert_eq!(verdict(&card, 0, false, Moment::Launch), None);
    card.secret.as_mut().unwrap().quiet = true;
    for moment in [Moment::Tick, Moment::Launch, Moment::TurnEnded] {
        assert_eq!(verdict(&card, 0, false, moment), Some(Expiry::MaybeLater));
    }
}

/// "Change Memberstack's settings?" waits for the user: its turn ending,
/// a launch or a long wait never close it (the owner typed "Approve it"
/// after the Chief's turn had ended and found it expired).
#[test]
fn a_settings_card_waits_for_the_user() {
    let mut card = super::super::mcp::new_card(
        "s1".into(),
        "Change Memberstack's settings?".into(),
        "Independence: Go hard".into(),
        None,
    );
    card.settings = Some(super::super::policy_card::Proposal {
        targets: Vec::new(),
        change: Default::default(),
        version: 1,
        groups: Vec::new(),
        why: None,
        has_rules: false,
        mac: None,
        grants: Vec::new(),
    });
    let over = (CARD_EXPIRY_SECS as i64) * 1000 * 100;
    for moment in [Moment::TurnEnded, Moment::Launch, Moment::Tick] {
        for waited_on in [false, true] {
            assert_eq!(verdict(&card, over, waited_on, moment), None, "{moment:?}");
        }
    }
}

/// "Do these under your name?" is often the user's own ask, typed from the
/// phone just before it went away: it stays up through its turn ending,
/// any number of looks and a restart, until they answer it.
#[test]
fn a_plan_card_stays_up_until_it_is_answered() {
    with_root(|| {
        let a = agent();
        let now = store::now_ms();
        let plan = crate::agents::plan_grant::parse(&json!({
            "actions": [
                { "kind": "pull_request", "target": "acme/site", "summary": "Open the pricing PR" }
            ]
        }))
        .unwrap();
        let mut card = super::super::mcp::new_card(
            "p1".into(),
            crate::agents::plan_grant::TITLE.into(),
            crate::agents::plan_grant::card_detail(&plan),
            None,
        );
        card.plan = Some(plan);
        assert!(stays_open(&card));
        post(&a.id, card, now);
        let much_later = now + 10 * (CARD_EXPIRY_SECS as i64) * 1000;
        for moment in [Moment::TurnEnded, Moment::Tick, Moment::Launch] {
            assert!(sweep_store(&a.id, moment, much_later, &|_| false).is_empty());
        }
        assert_eq!(status(&a.id, "p1"), (ApprovalStatus::Pending, None));
        assert_eq!(store::get(&a.id).unwrap().pending_approvals, 1);
        // Nothing about it is remembered as expired: asking again is allowed.
        let key = key_for(&store::find_approval(&a.id, "p1").unwrap().unwrap());
        assert!(!already_expired(&a.id, &key));
        // The same plan asked again while it's up finds it (no second card).
        assert!(super::super::mcp::open_card_for(&a.id, &key));
        assert!(!super::super::mcp::open_card_for(
            &a.id,
            "ask:another plan\n1. x"
        ));
        // An ordinary card beside it still closes.
        post(&a.id, bash_card("r1", "npm test"), now);
        assert_eq!(
            sweep_store(&a.id, Moment::TurnEnded, now, &|_| true).len(),
            1
        );
    });
}
