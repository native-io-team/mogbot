//! Step-in cards: who may ask, what the card and the lines say, the live
//! state laid over a card, and that nothing but the user answers one.

use super::*;
use crate::agent_browser::step_in::{Ended, Held};
use crate::agent_browser::tools::STEP_IN_TOOL;
use crate::agents::browser::Landed;
use crate::agents::browser_gate::{gate_agents_with, Gate, Page};
use crate::agents::expiry::{verdict, Expiry, Moment};
use crate::agents::independence::Level;
use serde_json::json;

fn agent() -> store::Agent {
    serde_json::from_value(json!({
        "id": "si1", "name": "Research", "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap()
}

fn card(request_id: &str) -> store::Approval {
    let mut a = super::super::mcp::new_card(
        request_id.into(),
        card_title("Research", "approve the Okta sign-in"),
        "Its tab on idp.example opens on this Mac.".into(),
        None,
    );
    a.step_in = Some(StepIn {
        reason: "approve the Okta sign-in".into(),
        site: "idp.example".into(),
        url: "https://idp.example/sso".into(),
        page_title: "Sign in".into(),
        tab: 2,
        in_since: None,
        until: None,
    });
    a
}

#[test]
fn never_for_outside_text_and_a_reason_is_required() {
    let ok = json!({ "reason": "  the 6-digit code\nfrom your phone. " });
    assert_eq!(check_ask(&ok, true).unwrap_err(), OUTSIDE);
    assert_eq!(
        check_ask(&ok, false).unwrap(),
        "the 6-digit code from your phone"
    );
    assert!(check_ask(&json!({}), false).is_err());
    assert!(check_ask(&json!({ "reason": "   " }), false).is_err());
    let long = "x".repeat(400);
    assert_eq!(
        check_ask(&json!({ "reason": long }), false)
            .unwrap()
            .chars()
            .count(),
        121
    );
}

/// The browser gate lets the ask through (it's a card, not a page action),
/// but not for outside text or an agent whose browser is off.
#[test]
fn the_gate_lets_the_ask_through_only_where_the_browser_is() {
    let page = Page::default();
    let a = agent();
    for level in [
        Level::Often,
        Level::Judgement,
        Level::GoHard,
        Level::FullSend,
    ] {
        assert_eq!(
            gate_agents_with(
                true,
                level,
                &a,
                STEP_IN_TOOL,
                &json!({ "reason": "x" }),
                false,
                &page
            ),
            Gate::Allow,
            "{level:?}"
        );
    }
    assert!(matches!(
        gate_agents_with(
            true,
            Level::GoHard,
            &a,
            STEP_IN_TOOL,
            &json!({}),
            true,
            &page
        ),
        Gate::Refuse(_)
    ));
    assert!(matches!(
        gate_agents_with(
            false,
            Level::GoHard,
            &a,
            STEP_IN_TOOL,
            &json!({}),
            false,
            &page
        ),
        Gate::Refuse(_)
    ));
    let mut off = agent();
    off.reach.browser_off = true;
    assert!(matches!(
        gate_agents_with(
            true,
            Level::GoHard,
            &off,
            STEP_IN_TOOL,
            &json!({}),
            false,
            &page
        ),
        Gate::Refuse(_)
    ));
}

/// The tool is listed with the browser's own, and its words teach the
/// agent to use it rather than ask for a password.
#[test]
fn the_tool_is_offered_and_says_when_to_use_it() {
    let list = crate::agent_browser::tools::tools_list().to_string();
    assert!(list.contains(&format!("\"name\":\"{STEP_IN_TOOL}\"")));
    let def = crate::agent_browser::tools::TOOLS
        .iter()
        .find(|t| t.name == STEP_IN_TOOL)
        .unwrap();
    for words in [
        "passkey",
        "2FA",
        "CAPTCHA",
        "instead of asking for a password",
        "request_login",
    ] {
        assert!(def.description.contains(words), "{words}");
    }
}

/// Without an app (the live check) or a turn (a take-over), nothing asks.
#[test]
fn nobody_is_asked_without_an_app_or_a_turn() {
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": STEP_IN_TOOL, "arguments": { "reason": "the CAPTCHA" } } });
    let out = tauri::async_runtime::block_on(crate::agent_browser::tools::dispatch(
        None,
        &agent(),
        Some(1),
        &msg,
    ));
    assert_eq!(out["result"]["isError"], json!(true), "{out}");
    assert!(out["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Nobody can be asked"));
}

#[test]
fn the_card_and_its_lines() {
    assert_eq!(
        card_title("Research", "approve the Okta sign-in"),
        "Research needs you in its browser: approve the Okta sign-in"
    );
    let e = |how, after: Option<&str>| Ended {
        held: Held {
            request_id: "r".into(),
            tab: 2,
            target_id: "T".into(),
            since_ms: 0,
            before: Landed {
                url: "https://idp.example/sso".into(),
                title: "Sign in".into(),
            },
        },
        after: after.map(|u| Landed {
            url: u.into(),
            title: String::new(),
        }),
        how,
        minutes: 6,
    };
    assert_eq!(
        line(
            "Research",
            &e(How::HandedBack, Some("https://www.app.example/home"))
        ),
        "You handed Research its browser back after 6 min · app.example"
    );
    assert_eq!(
        line(
            "Research",
            &e(How::TimedOut, Some("https://idp.example/sso"))
        ),
        "Research's browser was handed back by itself after 6 min · idp.example"
    );
    assert_eq!(
        line("Research", &e(How::Closed, None)),
        "The tab closed while you were in Research's browser"
    );
    let n = not_now_note("the CAPTCHA");
    assert!(
        n.contains("not now") && n.contains("Don't ask again"),
        "{n}"
    );
}

/// The live state is laid over a pending card only while the user is in it.
#[test]
fn the_card_says_youre_in_only_while_you_are() {
    let mut m = runner::new_message("si_live", MessageKind::Approval, "");
    m.approval = Some(card("req_live"));
    let mut page = vec![m];
    apply(&mut page);
    assert_eq!(
        page[0]
            .approval
            .as_ref()
            .unwrap()
            .step_in
            .as_ref()
            .unwrap()
            .in_since,
        None
    );
    crate::agent_browser::step_in::hold(
        "si_live",
        Held {
            request_id: "req_live".into(),
            tab: 2,
            target_id: "T".into(),
            since_ms: 1_000,
            before: Landed {
                url: String::new(),
                title: String::new(),
            },
        },
    )
    .unwrap();
    apply(&mut page);
    let s = page[0].approval.as_ref().unwrap().step_in.clone().unwrap();
    assert_eq!(s.in_since, Some(1_000));
    assert_eq!(s.until, Some(1_000 + LIMIT_MS));
    // The live state is never stored: it isn't in the card's JSON unless set.
    let stored = serde_json::to_value(card("x")).unwrap();
    assert!(stored["stepIn"].get("inSince").is_none(), "{stored}");
    // An answered card isn't "in", whatever is held.
    page[0].approval.as_mut().unwrap().status = ApprovalStatus::Allowed;
    apply(&mut page);
    assert_eq!(
        page[0]
            .approval
            .as_ref()
            .unwrap()
            .step_in
            .as_ref()
            .unwrap()
            .in_since,
        None
    );
    crate::agent_browser::step_in::forget("si_live");
}

/// Only the user answers it: an admin is told it's theirs, and the sweep
/// leaves it while they're in the tab (and puts it away like a login card
/// otherwise, never when the asking turn ends).
#[test]
fn only_the_user_answers_it_and_the_sweep_waits() {
    let c = card("req_sweep");
    let (kind, why) = crate::agents::admin::classify(&c, false);
    assert_eq!(kind, crate::agents::admin::Kind::Yours);
    assert!(why.contains("step into"), "{why}");
    assert_eq!(verdict(&c, 0, false, Moment::TurnEnded), None);
    assert_eq!(verdict(&c, 0, false, Moment::Tick), None);
    assert_eq!(
        verdict(&c, 0, false, Moment::Launch),
        Some(Expiry::MaybeLater)
    );
    crate::agent_browser::step_in::hold(
        "si_sweep",
        Held {
            request_id: "req_sweep".into(),
            tab: 2,
            target_id: "T".into(),
            since_ms: 0,
            before: Landed {
                url: String::new(),
                title: String::new(),
            },
        },
    )
    .unwrap();
    assert_eq!(verdict(&c, i64::MAX / 2, false, Moment::Tick), None);
    crate::agent_browser::step_in::forget("si_sweep");
}

/// Review: "Approve it" typed into a chat whose only card was a step-in
/// answered it as a plain Allow: the card closed as allowed with no hold,
/// no window, and the agent never woken. A typed yes leaves it alone.
#[test]
fn review_a_typed_yes_never_answers_a_step_in_card() {
    let c = card("req_typed");
    assert!(crate::agents::typed_answer::the_card(std::slice::from_ref(&c)).is_none());
}

/// Review: after Not now, nothing stopped the agent (or a page steering it)
/// asking again at once, card after card. The same site isn't asked about
/// again for a while; another site can be.
#[test]
fn review_after_not_now_the_same_site_isnt_asked_again_for_a_while() {
    let a = "si_spam";
    let t = 1_000_000;
    assert!(ask_again(a, "idp.example", t).is_ok());
    note_not_now(a, "idp.example", t);
    let why = ask_again(a, "idp.example", t + 60_000).unwrap_err();
    assert!(why.contains("not now"), "{why}");
    assert!(ask_again(a, "other.example", t + 60_000).is_ok());
    assert!(ask_again("someone_else", "idp.example", t + 60_000).is_ok());
    assert!(ask_again(a, "idp.example", t + NOT_NOW_QUIET_MS).is_ok());
}

/// What it did: the step reads as asking, never as using the browser.
#[test]
fn the_timeline_says_it_asked() {
    let a = crate::agents::work::describe_tool(
        &format!("mcp__browser__{STEP_IN_TOOL}"),
        Some(&json!({ "reason": "the CAPTCHA" })),
    )
    .unwrap();
    assert_eq!(a.label, "Asked you to step into its browser");
    assert_eq!(a.kind, crate::agents::work::StepKind::Approval);
}
