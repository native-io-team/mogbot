//! Every admin rule, held by a test (`agents/admin.rs`). Fictional agents
//! and folders only.

use super::*;
use serde_json::json;

fn card(tool: &str, input: Value) -> Approval {
    serde_json::from_value(json!({
        "requestId": "r1", "title": "Run a command", "detail": "x",
        "status": "pending", "tool": tool, "input": input
    }))
    .unwrap()
}

fn bash(command: &str) -> Approval {
    card("Bash", json!({ "command": command }))
}

fn key_card() -> Approval {
    serde_json::from_value(json!({
        "requestId": "k1", "title": "Secure input · kite_key", "detail": "x", "status": "pending",
        "secret": { "name": "kite_key", "purpose": "Read the Kite dashboard", "kind": "api_key", "fields": [], "reference": "" }
    }))
    .unwrap()
}

fn app_question() -> Approval {
    serde_json::from_value(json!({
        "requestId": "q1", "title": "Set up a routine", "detail": "x", "status": "pending"
    }))
    .unwrap()
}

fn agent(id: &str, is_main: bool) -> store::Agent {
    serde_json::from_value(json!({
        "id": id, "name": id, "role": "", "shape": 0, "color": "red",
        "createdAt": 0, "isMain": is_main
    }))
    .unwrap()
}

/* ---------------------------------------------------------------- who */

#[test]
fn the_chief_is_admin_by_default_and_nobody_else_is() {
    let chief = agent("chief", true);
    let other = agent("ledger", false);
    assert!(is_admin(&chief));
    assert!(!is_admin(&other));
    let mut off = chief.clone();
    off.extra.insert(ADMIN_KEY.into(), Value::Bool(false));
    assert!(!is_admin(&off), "the user's off wins over the default");
    let mut on = other.clone();
    on.extra.insert(ADMIN_KEY.into(), Value::Bool(true));
    assert!(is_admin(&on));
}

#[test]
fn admin_powers_are_off_in_a_turn_answering_outside_text() {
    assert!(powers(true, false));
    assert!(!powers(true, true));
    assert!(!powers(false, false));
    assert!(!powers(false, true));
}

#[test]
fn no_agent_tool_can_grant_admin() {
    assert!(tries_to_grant(&json!({ "agent": "Ledger", "admin": true })));
    assert!(tries_to_grant(
        &json!({ "name": "Ledger", "is_admin": true })
    ));
    assert!(tries_to_grant(
        &json!({ "agent": "Ledger", "admin": false })
    ));
    assert!(!tries_to_grant(
        &json!({ "agent": "Ledger", "role": "Books" })
    ));
}

#[test]
fn only_the_user_switch_sets_admin_and_a_revoke_holds_at_once() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let made = store::create(store::NewAgent {
        name: "Ledger".into(),
        role: "Books".into(),
        instructions: "Keep the books.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    assert!(!is_admin(&store::get(&made.id).unwrap()));
    set_admin(&made.id, true).unwrap();
    let admin = store::get(&made.id).unwrap();
    assert!(is_admin(&admin));
    let local = bash("ls ~/Kite");
    assert!(judge(
        &admin.id,
        is_admin(&admin),
        false,
        "other",
        &local,
        false,
        Answer::Allow
    )
    .is_ok());
    // Revoked: the very next call is refused.
    set_admin(&made.id, false).unwrap();
    let revoked = store::get(&made.id).unwrap();
    let refused = judge(
        &revoked.id,
        is_admin(&revoked),
        false,
        "other",
        &local,
        false,
        Answer::Allow,
    );
    assert!(refused.unwrap_err().contains("Only an admin"));
    store::set_root_for_tests(None);
}

/* ------------------------------------------------------- what's local */

#[test]
fn reading_and_making_new_things_on_this_mac_is_local() {
    for command in [
        "ls -la ~/Downloads/KiteExport",
        "cat notes.txt",
        "git status",
        "git log --oneline",
        "mkdir drafts",
        "grep -r invoice .",
    ] {
        assert_eq!(classify(&bash(command), false).0, Kind::Local, "{command}");
    }
    assert_eq!(
        classify(
            &card("Read", json!({ "file_path": "/Users/sam/Kite/a.txt" })),
            false
        )
        .0,
        Kind::Local
    );
}

#[test]
fn anything_reaching_people_money_code_or_keys_is_the_users() {
    let yours = [
        bash("git push origin main"),
        bash("gh pr create --fill"),
        bash("curl -X POST https://pay.example.test/charge"),
        bash("rm -rf ~/Kite"),
        bash("npm publish"),
        bash("ls && curl https://x.example.test"),
        bash("cat ~/.ssh/id_ed25519"),
        bash("cat .env"),
        bash("sudo ls"),
        bash("security find-generic-password -s kite"),
        bash("node build.js"),
        card(
            "mcp__gmail__send_email",
            json!({ "to": "dana@example.test" }),
        ),
        card("mcp__stripe__create_payment", json!({ "amount": 10 })),
        card("mcp__slack__post_message", json!({ "text": "hi" })),
        card("WebFetch", json!({ "url": "https://example.test" })),
        card("WebSearch", json!({ "query": "kite" })),
        card("Edit", json!({ "file_path": "/Users/sam/Kite/plan.md" })),
        card("Write", json!({ "file_path": "/etc/hosts" })),
        card(
            "Read",
            json!({ "file_path": "/Users/sam/.aws/credentials" }),
        ),
        app_question(),
    ];
    for c in &yours {
        assert_eq!(
            classify(c, false).0,
            Kind::Yours,
            "{:?} {:?}",
            c.tool,
            c.input
        );
    }
}

#[test]
fn keys_and_logins_can_only_be_put_away() {
    assert_eq!(classify(&key_card(), false).0, Kind::Login);
}

#[test]
fn a_request_from_tainted_work_is_always_the_users() {
    assert_eq!(classify(&bash("ls"), true).0, Kind::Yours);
}

#[test]
fn with_its_context_local_work_is_exactly_what_go_hard_answers() {
    let home = std::path::PathBuf::from("/Users/sam");
    let own = home.join("Library/Application Support/Dashbot/agents/ledger");
    let ctx = crate::agents::autoallow::Ctx {
        home: home.clone(),
        own_home: own.clone(),
        cwd: own.clone(),
        scratch: vec![own.clone()],
        app_data: vec![home.join("Library/Application Support/Dashbot")],
    };
    let local = |c: &Approval| classify_in(c, false, Some(&ctx)).0;
    assert_eq!(local(&bash("ls -la ~/Downloads/KiteExport")), Kind::Local);
    assert_eq!(local(&bash("mkdir ~/Kite/drafts")), Kind::Local);
    for c in [
        bash("git push origin main"),
        bash("curl -d x=1 https://hooks.example.test"),
        bash("rm -rf ~/Kite"),
        bash("cat ~/.ssh/id_ed25519"),
        card(
            "mcp__gmail__send_email",
            json!({ "to": "dana@example.test" }),
        ),
        card("mcp__stripe__create_payment", json!({ "amount": 10 })),
    ] {
        assert_eq!(local(&c), Kind::Yours, "{:?}", c.input);
    }
    // A card raised while its agent answered outside text stays the user's.
    let mut tainted = bash("ls ~/Kite");
    tainted.from_outside = Some(true);
    assert_eq!(local(&tainted), Kind::Yours);
    assert!(judge_in(
        "chief",
        true,
        false,
        "ledger",
        &tainted,
        false,
        Some(&ctx),
        Answer::Allow
    )
    .is_err());
}

/* -------------------------------------------------------------- judge */

#[test]
fn an_admin_answers_local_work_and_puts_logins_away() {
    let j = |c: &Approval, a| judge("chief", true, false, "ledger", c, false, a);
    assert_eq!(j(&bash("ls ~/Kite"), Answer::Allow), Ok(Kind::Local));
    assert_eq!(j(&bash("ls ~/Kite"), Answer::Deny), Ok(Kind::Local));
    assert_eq!(j(&key_card(), Answer::NotNeeded), Ok(Kind::Login));
    assert_eq!(j(&key_card(), Answer::MaybeLater), Ok(Kind::Login));
    assert!(j(&key_card(), Answer::Allow).unwrap_err().contains("login"));
    assert!(j(&bash("ls"), Answer::NotNeeded)
        .unwrap_err()
        .contains("for logins"));
}

#[test]
fn an_admin_can_never_approve_sending_spending_pushing_or_sharing() {
    for c in [
        bash("git push"),
        card("mcp__gmail__send_email", json!({})),
        card("mcp__stripe__create_charge", json!({})),
        card("mcp__drive__share_file", json!({})),
    ] {
        for a in [
            Answer::Allow,
            Answer::Deny,
            Answer::NotNeeded,
            Answer::MaybeLater,
        ] {
            let refused = judge("chief", true, false, "ledger", &c, false, a).unwrap_err();
            assert!(
                refused.contains("Only the user can decide") || refused.contains("bring_to_user"),
                "{refused}"
            );
        }
    }
}

#[test]
fn an_admin_cant_answer_its_own_requests() {
    let refused = judge(
        "chief",
        true,
        false,
        "chief",
        &bash("ls"),
        false,
        Answer::Allow,
    )
    .unwrap_err();
    assert!(refused.contains("your own request"));
}

#[test]
fn not_admin_or_outside_text_answers_nothing() {
    let c = bash("ls");
    assert!(
        judge("ledger", false, false, "kite", &c, false, Answer::Allow)
            .unwrap_err()
            .contains("Only an admin")
    );
    assert!(judge("chief", true, true, "kite", &c, false, Answer::Allow)
        .unwrap_err()
        .contains("outside"));
}

#[test]
fn an_answered_card_isnt_answered_again() {
    let mut c = bash("ls");
    c.status = ApprovalStatus::Allowed;
    assert!(
        judge("chief", true, false, "ledger", &c, false, Answer::Allow)
            .unwrap_err()
            .contains("already")
    );
}

/* -------------------------------------------------------- plain words */

#[test]
fn a_command_reads_as_what_it_does_and_why() {
    let input = json!({ "command": "ls -la ~/Downloads/KiteExport", "description": "To see if the download finished." });
    assert_eq!(
        summary_for("Bash", &input, None).unwrap(),
        "Look inside your KiteExport folder — to see if the download finished"
    );
    assert_eq!(
        command_summary("cd ~/Kite && ls"),
        "Look inside your Kite folder"
    );
    assert_eq!(
        command_summary("git push origin main"),
        "Push code to the project's online copy"
    );
    assert_eq!(
        command_summary("rm -rf build"),
        "Delete the build folder and everything in it"
    );
    assert_eq!(
        command_summary("npm test && npm run build"),
        "Run the tests, then 1 more step"
    );
    assert_eq!(
        command_summary("cat ~/Kite/notes.txt | head -5"),
        "Read notes.txt in your Kite folder"
    );
    assert_eq!(
        command_summary("grep -r 'invoice' ~/Kite"),
        "Search your Kite folder for “invoice”"
    );
    assert_eq!(
        command_summary("curl -d x=1 https://hooks.example.test/a"),
        "Send data to hooks.example.test"
    );
    assert_eq!(
        command_summary("frobnicate --all"),
        "Run the “frobnicate” command"
    );
}

#[test]
fn other_tools_read_plainly_too() {
    assert_eq!(
        summary_for("Write", &json!({ "file_path": "~/Kite/plan.md" }), None).unwrap(),
        "Create plan.md in your Kite folder"
    );
    assert_eq!(
        summary_for(
            "WebFetch",
            &json!({ "url": "https://docs.example.test/a" }),
            Some("Check the API")
        )
        .unwrap(),
        "Open a page on docs.example.test — check the API"
    );
    assert_eq!(
        summary_for("mcp__gmail__send_email", &json!({}), None).unwrap(),
        "Send an email · Gmail"
    );
    assert_eq!(summary_for("SomethingNew", &json!({}), None), None);
}

#[test]
fn old_cards_get_their_line_when_read_and_login_cards_dont() {
    let mut old = bash("ls ~/Kite");
    assert!(old.summary.is_none());
    fill_summary(&mut old);
    assert_eq!(old.summary.as_deref(), Some("Look inside your Kite folder"));
    // A line already there is kept.
    let mut push = bash("git push");
    push.summary = Some("Push main to GitHub".into());
    fill_summary(&mut push);
    assert_eq!(push.summary.as_deref(), Some("Push main to GitHub"));
    let mut key = key_card();
    fill_summary(&mut key);
    assert!(key.summary.is_none());
}

/* --------------------------------------------------------------- audit */

#[test]
fn every_answer_leaves_a_line_in_both_chats() {
    let (theirs, mine) = answer_lines(
        "Chief of Staff",
        "Ledger",
        &bash("ls ~/Kite"),
        Answer::Allow,
        None,
    );
    assert_eq!(
        theirs,
        "Chief of Staff allowed: look inside your Kite folder"
    );
    assert_eq!(mine, "Allowed for Ledger: look inside your Kite folder");
    let (theirs, _) = answer_lines(
        "Chief of Staff",
        "Ledger",
        &bash("ls"),
        Answer::Deny,
        Some("Use the shared folder"),
    );
    assert!(theirs.ends_with("· “Use the shared folder”"));
    let (theirs, mine) = answer_lines(
        "Chief of Staff",
        "Ledger",
        &key_card(),
        Answer::NotNeeded,
        None,
    );
    assert_eq!(theirs, "Chief of Staff marked not needed: kite_key");
    assert_eq!(mine, "Marked not needed for Ledger: kite_key");
}

#[test]
fn admin_activity_is_kept_newest_first() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let who = AgentRef {
        id: "chief".into(),
        name: "Chief of Staff".into(),
    };
    for i in 0..3 {
        log_activity(&Activity {
            ts: i,
            admin: who.clone(),
            target: None,
            action: format!("did {i}"),
        });
    }
    let read = activity(2);
    assert_eq!(
        read.iter().map(|a| a.action.as_str()).collect::<Vec<_>>(),
        vec!["did 2", "did 1"]
    );
    store::set_root_for_tests(None);
}

/* ------------------------------------------------------------- batches */

#[test]
fn only_other_agents_waiting_cards_go_to_the_user_once_each() {
    let ledger = agent("ledger", false);
    let chief = agent("chief", true);
    let mut answered = bash("git push");
    answered.request_id = "done".into();
    answered.status = ApprovalStatus::Denied;
    let mut send = card("mcp__gmail__send_email", json!({}));
    send.request_id = "send".into();
    let items = pick(
        "chief",
        vec![
            (ledger.clone(), send.clone()),
            (ledger.clone(), send.clone()),
            (ledger.clone(), answered),
            (chief.clone(), bash("git push")),
        ],
    );
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].agent_id, "ledger");
    assert_eq!(
        items[0].approval.summary.as_deref(),
        Some("Send an email · Gmail")
    );
    assert_eq!(decide_text(3, None), "3 things only you can decide:");
    assert_eq!(
        decide_text(1, Some("Handled the rest.")),
        "Handled the rest.\n\n1 thing only you can decide:"
    );
}

/* --------------------------------------------------------- soft delete */

#[test]
fn a_deleted_agent_waits_thirty_days_and_comes_back_whole() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let made = store::create(store::NewAgent {
        name: "Kite Watch".into(),
        role: "Watches the kite shop".into(),
        instructions: "Watch it.".into(),
        shape: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let home = store::agent_home(&made.id).unwrap();
    std::fs::write(home.join("CLAUDE.md"), "memory").unwrap();
    let by = AgentRef {
        id: "chief".into(),
        name: "Chief of Staff".into(),
    };
    store::soft_delete(&made.id, Some(by)).unwrap();
    assert!(store::get(&made.id).is_err(), "off the team");
    assert!(!home.exists());
    let listed = recently_deleted();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Kite Watch");
    assert_eq!(
        listed[0].restorable_until - listed[0].deleted_at,
        30 * 24 * 60 * 60 * 1000
    );
    let back = store::restore(&made.id).unwrap();
    assert_eq!(back.role, "Watches the kite shop");
    assert_eq!(
        std::fs::read_to_string(home.join("CLAUDE.md")).unwrap(),
        "memory"
    );
    assert!(recently_deleted().is_empty());
    // Past thirty days it's purged, and can't be restored.
    store::soft_delete(&made.id, None).unwrap();
    assert!(store::take_expired(store::now_ms()).is_empty(), "not yet");
    let later = store::now_ms() + 31 * 24 * 60 * 60 * 1000;
    assert_eq!(store::take_expired(later).len(), 1);
    assert!(store::restore(&made.id).is_err());
    store::set_root_for_tests(None);
}

#[test]
fn the_chief_cant_be_soft_deleted() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let chief = store::create(store::NewAgent {
        name: "Chief of Staff".into(),
        role: "Runs the team".into(),
        instructions: "Run it.".into(),
        shape: None,
        color: None,
        is_main: true,
    })
    .unwrap();
    assert!(store::soft_delete(&chief.id, None).is_err());
    store::set_root_for_tests(None);
}

#[test]
fn an_existing_chief_is_told_once_and_a_new_one_never() {
    let _serial = store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(root.path().to_path_buf()));
    let chief = store::create(store::NewAgent {
        name: "Chief of Staff".into(),
        role: "Runs the team".into(),
        instructions: "Run it.".into(),
        shape: None,
        color: None,
        is_main: true,
    })
    .unwrap();
    assert!(note_upgrade(&chief));
    assert!(!note_upgrade(&store::get(&chief.id).unwrap()), "once");
    let said = store::messages(&chief.id, 10).unwrap();
    assert_eq!(said.iter().filter(|m| m.text == UPGRADE_LINE).count(), 1);
    // A fresh install: the Chief made by this build is marked at once.
    let other = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(other.path().to_path_buf()));
    let fresh = store::create(store::NewAgent {
        name: "Chief Two".into(),
        role: "x".into(),
        instructions: "x".into(),
        shape: None,
        color: None,
        is_main: true,
    })
    .unwrap();
    mark_noted(&fresh.id);
    assert!(!note_upgrade(&store::get(&fresh.id).unwrap()));
    store::set_root_for_tests(None);
}
