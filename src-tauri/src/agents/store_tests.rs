#[cfg(unix)]
#[test]
fn agent_folders_and_files_are_owner_only_and_fixed_when_wider() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("agents");
    let home = root.join("a1");
    // What we write is private from the start.
    write_atomic(&root.join("agents.json"), b"{}").unwrap();
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join("agents.json")), 0o600);
    append_line(&home.join("messages.jsonl"), &serde_json::json!({"x": 1})).unwrap();
    assert_eq!(mode(&home), 0o700);
    assert_eq!(mode(&home.join("messages.jsonl")), 0o600);
    // What an older build (or the CLI) left wider is fixed.
    std::fs::write(home.join("CLAUDE.md"), "# a").unwrap();
    std::fs::set_permissions(
        home.join("CLAUDE.md"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    harden_tree(&root, 2);
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&home), 0o700);
    assert_eq!(mode(&home.join("CLAUDE.md")), 0o600);
    // An owner-executable file keeps its x bit; only group/other go.
    std::fs::write(home.join("run.sh"), "#!/bin/sh").unwrap();
    std::fs::set_permissions(home.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    harden_tree(&root, 2);
    assert_eq!(mode(&home.join("run.sh")), 0o700);
}

use super::*;

#[test]
fn a_skill_offer_never_counts_as_waiting_on_the_user() {
    use crate::agents::skills_learn::{card, Skill, SkillCard};
    let line = |approval: Approval| {
        let mut m = crate::agents::runner::new_message("a1", MessageKind::Approval, "");
        m.approval = Some(approval);
        m
    };
    let skill = line(card(SkillCard {
        skill: Skill {
            slug: "export-invoices".into(),
            name: "Export invoices".into(),
            when: "When asked for invoices".into(),
            steps: "1. Export them.".into(),
        },
        removed: 0,
        outside: false,
        replaces: false,
    }));
    let ask = line(crate::agents::mcp::new_card(
        new_id(),
        "Run a command".into(),
        "rm -rf build".into(),
        None,
    ));
    assert_eq!(count_pending(std::slice::from_ref(&skill)), 0);
    assert_eq!(count_pending(&[skill, ask]), 1);
}

#[test]
fn routines_run_on_haiku_only_while_the_agent_is_on_the_default_model() {
    let agent = |model: Option<&str>, routine: Option<&str>| -> Agent {
        let mut a: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "A", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        a.model = model.map(str::to_string);
        a.routine_model = routine.map(str::to_string);
        a
    };
    assert_eq!(agent(None, None).routine_model(), Some("haiku"));
    assert_eq!(agent(Some("opus"), None).routine_model(), Some("opus"));
    assert_eq!(agent(None, Some("same")).routine_model(), None);
    assert_eq!(
        agent(Some("opus"), Some("same")).routine_model(),
        Some("opus")
    );
    assert_eq!(
        agent(Some("opus"), Some("sonnet")).routine_model(),
        Some("sonnet")
    );
    let claude = super::super::engine::Engine::Claude;
    assert_eq!(normalize_routine_model(claude, "").unwrap(), None);
    assert_eq!(
        normalize_routine_model(claude, "same").unwrap().as_deref(),
        Some("same")
    );
    assert!(normalize_routine_model(claude, "--danger").is_err());
    assert!(normalize_routine_model(super::super::engine::Engine::Codex, "haiku").is_err());
}

#[test]
fn a_codex_agents_routines_never_run_on_haiku() {
    let mut a: Agent = serde_json::from_value(serde_json::json!({
        "id": "a", "name": "A", "shape": 0, "color": "red", "createdAt": 0, "engine": "codex"
    }))
    .unwrap();
    assert_eq!(a.routine_model(), None);
    a.model = Some("gpt-5.5".into());
    assert_eq!(a.routine_model(), Some("gpt-5.5"));
    a.routine_model = Some("gpt-5.6-luna".into());
    assert_eq!(a.routine_model(), Some("gpt-5.6-luna"));
    a.switch_engine(super::super::engine::Engine::Claude);
    assert_eq!(a.routine_model, None);
    assert_eq!(a.routine_model(), Some("haiku"));
}

fn with_root<F: FnOnce()>(f: F) {
    let _serial = tests_lock();
    let dir = tempfile::tempdir().unwrap();
    set_root_for_tests(Some(dir.path().to_path_buf()));
    f();
    set_root_for_tests(None);
}

fn new(name: &str) -> NewAgent {
    NewAgent {
        name: name.into(),
        role: "Does things".into(),
        instructions: "Be brief.".into(),
        shape: None,
        color: None,
        is_main: false,
    }
}

#[test]
fn pages_back_through_the_log() {
    with_root(|| {
        let a = create(new("Pager")).unwrap();
        for i in 0..10 {
            append_message(&AgentMessage {
                id: format!("m{i}"),
                agent_id: a.id.clone(),
                ts: i,
                // Session lines page like any other line.
                kind: if i % 3 == 0 {
                    MessageKind::Session
                } else {
                    MessageKind::User
                },
                text: format!("line {i}"),
                peer: None,
                approval: None,
                attachments: Vec::new(),
                check_in: None,
                stopped: false,
                mentions: Vec::new(),
                failure: None,
                changes: None,
                session: (i % 3 == 0).then(|| crate::agents::sessions::SessionMark {
                    project: "/p".into(),
                    event: crate::agents::sessions::SessionEvent::Sent,
                    session_id: Some("s1".into()),
                    tab: Some(1),
                    cli: Some("claude".into()),
                }),
                client_id: None,
                work: None,
                fresh: false,
                result: None,
                revises: None,
                takeover: false,
                room: None,
                decide: Vec::new(),
                local_links: Vec::new(),
                blocks: None,
                remembered: None,
                via: None,
                fix: None,
                conversation: None,
            })
            .unwrap();
        }
        let ids = |v: Vec<AgentMessage>| v.into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids(messages(&a.id, 3).unwrap()), ["m7", "m8", "m9"]);
        assert_eq!(
            ids(messages_page(&a.id, 3, Some("m7"), None).unwrap()),
            ["m4", "m5", "m6"]
        );
        assert_eq!(
            ids(messages_page(&a.id, 2, Some("m1"), None).unwrap()),
            ["m0"]
        );
        // A search hit further back: everything from it to the cursor.
        assert_eq!(
            ids(messages_page(&a.id, 2, Some("m7"), Some(("m2", 100))).unwrap()),
            ["m2", "m3", "m4", "m5", "m6"]
        );
        // A hit inside the page changes nothing; the cap still holds.
        assert_eq!(
            ids(messages_page(&a.id, 3, Some("m7"), Some(("m5", 100))).unwrap()),
            ["m4", "m5", "m6"]
        );
        assert_eq!(
            ids(messages_page(&a.id, 2, None, Some(("m0", 4))).unwrap()),
            ["m6", "m7", "m8", "m9"]
        );
        assert!(messages_page(&a.id, 3, Some("gone"), None)
            .unwrap()
            .is_empty());
    });
}

#[test]
fn pages_read_from_the_end_carry_their_answers() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        // Long enough to span several read chunks; every 50th line a card.
        let filler = "x".repeat(300);
        for i in 0..2000 {
            let mut line = note(&a.id, &format!("{i} {filler}"));
            line.id = format!("m{i}");
            if i % 50 == 0 {
                line.kind = MessageKind::Approval;
                line.approval = Some(Approval {
                    request_id: format!("r{i}"),
                    title: "Run a command".into(),
                    detail: "ls".into(),
                    status: ApprovalStatus::Pending,
                    tool: None,
                    input: None,
                    always: None,
                    always_allowed: false,
                    summary: None,
                    note: None,
                    prompt: None,
                    choice: None,
                    secret: None,
                    connector: None,
                    login: None,
                    set_aside: None,
                    expiry: None,
                    from_outside: None,
                    front: None,
                    settings: None,
                    plan: None,
                    handoff: None,
                    gate: None,
                    step_in: None,
                    crossover: None,
                    account_switch: None,
                    skill: None,
                    slack_reply: None,
                    risk: None,
                });
            }
            append_message(&line).unwrap();
        }
        set_approval_status(&a.id, "r100", ApprovalStatus::Allowed)
            .unwrap()
            .unwrap();
        deny_with_note(&a.id, "r150", "use the staging bucket")
            .unwrap()
            .unwrap();
        set_approval_status(&a.id, "r1950", ApprovalStatus::Denied)
            .unwrap()
            .unwrap();

        let full = messages(&a.id, usize::MAX).unwrap();
        assert_eq!(full.len(), 2000);
        let ids = |v: &[AgentMessage]| v.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
        let status = |v: &[AgentMessage], rid: &str| {
            v.iter()
                .filter_map(|m| m.approval.as_ref())
                .find(|c| c.request_id == rid)
                .map(|c| (c.status, c.note.clone()))
        };

        // The newest page: the answer is applied.
        let newest = messages(&a.id, 60).unwrap();
        assert_eq!(ids(&newest), ids(&full[1940..]));
        assert_eq!(
            status(&newest, "r1950"),
            Some((ApprovalStatus::Denied, None))
        );

        // Paged far back from the end: same lines a full read gives, answers applied.
        let page = messages_page(&a.id, 80, Some("m180"), None).unwrap();
        assert_eq!(ids(&page), ids(&full[100..180]));
        assert_eq!(status(&page, "r100"), Some((ApprovalStatus::Allowed, None)));
        assert_eq!(
            status(&page, "r150"),
            Some((
                ApprovalStatus::Denied,
                Some("use the staging bucket".into())
            ))
        );
        assert_eq!(status(&page, "r50"), None);
        assert_eq!(
            page.iter().find(|m| m.id == "m100"),
            full.iter().find(|m| m.id == "m100")
        );

        // Reaching back to a search hit, capped.
        let reach = messages_page(&a.id, 10, Some("m1990"), Some(("m150", 5000))).unwrap();
        assert_eq!(ids(&reach), ids(&full[150..1990]));
        assert_eq!(
            status(&reach, "r150"),
            Some((
                ApprovalStatus::Denied,
                Some("use the staging bucket".into())
            ))
        );
        let capped = messages_page(&a.id, 10, Some("m1990"), Some(("m150", 300))).unwrap();
        assert_eq!(ids(&capped), ids(&full[1690..1990]));
    });
}

#[test]
fn creates_lists_and_finds_by_name_case_insensitively() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        assert_eq!(list().unwrap().len(), 1);
        assert_eq!(find("finance").unwrap().unwrap().id, a.id);
        assert_eq!(find(&a.id).unwrap().unwrap().name, "Finance");
        assert!(find("Nobody").unwrap().is_none());
    });
}

#[test]
fn refuses_duplicate_names_and_a_second_main() {
    with_root(|| {
        create(new("Finance")).unwrap();
        assert!(create(new("FINANCE")).is_err());
        let mut main = new("Chief of Staff");
        main.is_main = true;
        create(main).unwrap();
        let mut again = new("Other Chief");
        again.is_main = true;
        assert!(create(again).is_err());
    });
}

#[test]
fn the_main_agent_cannot_be_deleted() {
    with_root(|| {
        let mut main = new("Chief of Staff");
        main.is_main = true;
        let chief = create(main).unwrap();
        assert!(delete(&chief.id).is_err());
        let other = create(new("Finance")).unwrap();
        delete(&other.id).unwrap();
        assert!(!agents_root().unwrap().join(&other.id).exists());
    });
}

#[test]
fn rewriting_instructions_keeps_memory() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        let home = agent_home(&a.id).unwrap();
        let path = home.join("CLAUDE.md");
        let with_memory =
            std::fs::read_to_string(&path).unwrap() + "- Julian's accountant is Sam.\n";
        std::fs::write(&path, with_memory).unwrap();
        write_instructions(&home, &a, "New rules.").unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("New rules."));
        assert!(!after.contains("Be brief."));
        assert!(after.contains("Julian's accountant is Sam."));
        assert_eq!(read_instructions(&a.id).unwrap(), "New rules.");
    });
}

#[test]
fn a_fresh_start_leaves_the_conversation_and_keeps_the_rest() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        assert!(
            !a.has_conversation(),
            "nothing to leave before its first turn"
        );
        let fill = super::super::context::ContextFill {
            used: 9,
            window: 10,
            at: 1,
            model: None,
        };
        let before = update(&a.id, |a| {
            a.session_id = Some("s1".into());
            a.context = Some(fill.clone());
            a.model = Some("opus".into());
        })
        .unwrap();
        assert!(before.has_conversation());
        let home = agent_home(&a.id).unwrap();
        let claude_md = std::fs::read_to_string(home.join("CLAUDE.md")).unwrap();

        let after = update(&a.id, Agent::start_fresh).unwrap();
        assert_eq!(
            (after.session_id.clone(), after.context.clone()),
            (None, None)
        );
        assert!(!after.new_engine, "a fresh start is handed no recap");
        assert_eq!(after.model.as_deref(), Some("opus"));
        assert_eq!(after.engine, before.engine);
        assert_eq!(
            std::fs::read_to_string(home.join("CLAUDE.md")).unwrap(),
            claude_md,
            "instructions and memory are untouched"
        );
        assert!(!after.has_conversation());

        // After an engine switch it skips the recap the switch would hand over.
        let mut switched = after.clone();
        switched.context = Some(fill);
        switched.switch_engine(super::super::engine::Engine::Codex);
        assert!(switched.context.is_none() && switched.has_conversation());
        switched.start_fresh();
        assert!(!switched.has_conversation());

        // A new model has a different window: the old reading goes.
        let mut a = before.clone();
        a.set_model(Some("opus".into()));
        assert!(a.context.is_some(), "the same model keeps it");
        a.set_model(Some("haiku".into()));
        assert!(a.context.is_none());
    });
}

#[test]
fn approvals_resolve_once_and_stale_ones_expire() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        let pending = |rid: &str, ts: i64| AgentMessage {
            id: new_id(),
            agent_id: a.id.clone(),
            ts,
            kind: MessageKind::Approval,
            text: String::new(),
            peer: None,
            approval: Some(Approval {
                request_id: rid.into(),
                title: "Run a command".into(),
                detail: "ls".into(),
                status: ApprovalStatus::Pending,
                tool: None,
                input: None,
                always: None,
                always_allowed: false,
                summary: None,
                note: None,
                prompt: None,
                choice: None,
                secret: None,
                connector: None,
                login: None,
                set_aside: None,
                expiry: None,
                from_outside: None,
                front: None,
                settings: None,
                plan: None,
                handoff: None,
                gate: None,
                step_in: None,
                crossover: None,
                account_switch: None,
                skill: None,
                slack_reply: None,
                risk: None,
            }),
            attachments: Vec::new(),
            check_in: None,
            stopped: false,
            mentions: Vec::new(),
            failure: None,
            changes: None,
            session: None,
            client_id: None,
            work: None,
            fresh: false,
            result: None,
            revises: None,
            takeover: false,
            room: None,
            decide: Vec::new(),
            local_links: Vec::new(),
            blocks: None,
            remembered: None,
            via: None,
            fix: None,
            conversation: None,
        };
        let days = (crate::agents::expiry::CARD_STAYS_SECS as i64) * 1000;
        append_message(&pending("r1", now_ms())).unwrap();
        append_message(&pending("r2", now_ms() - days)).unwrap();
        // Unanswered and young: it waits through a restart for the user.
        append_message(&pending("r3", now_ms())).unwrap();
        assert!(set_approval_status(&a.id, "r1", ApprovalStatus::Allowed)
            .unwrap()
            .is_some());
        // A second answer to the same card changes nothing.
        assert!(set_approval_status(&a.id, "r1", ApprovalStatus::Denied)
            .unwrap()
            .is_none());
        expire_stale_approvals();
        let log = messages(&a.id, 10).unwrap();
        assert_eq!(
            log[0].approval.as_ref().unwrap().status,
            ApprovalStatus::Allowed
        );
        assert_eq!(
            log[1].approval.as_ref().unwrap().status,
            ApprovalStatus::Expired
        );
        assert_eq!(
            log[2].approval.as_ref().unwrap().status,
            ApprovalStatus::Pending
        );
    });
}

fn note(agent_id: &str, text: &str) -> AgentMessage {
    AgentMessage {
        id: new_id(),
        agent_id: agent_id.into(),
        ts: now_ms(),
        kind: MessageKind::Note,
        text: text.into(),
        peer: None,
        approval: None,
        attachments: Vec::new(),
        check_in: None,
        stopped: false,
        mentions: Vec::new(),
        changes: None,
        failure: None,
        session: None,
        client_id: None,
        work: None,
        fresh: false,
        result: None,
        revises: None,
        takeover: false,
        room: None,
        decide: Vec::new(),
        local_links: Vec::new(),
        blocks: None,
        remembered: None,
        via: None,
        fix: None,
        conversation: None,
    }
}

#[test]
fn a_torn_last_line_doesnt_swallow_the_next_message() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        append_message(&note(&a.id, "one")).unwrap();
        let path = log_path(&a.id).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(br#"{"id":"torn","kind":"us"#).unwrap();
        append_message(&note(&a.id, "two")).unwrap();
        let texts: Vec<String> = messages(&a.id, 10)
            .unwrap()
            .into_iter()
            .map(|m| m.text)
            .collect();
        assert_eq!(texts, ["one", "two"]);
    });
}

#[test]
fn answering_a_card_appends_and_never_rewrites_the_log() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        append_message(&note(&a.id, "before")).unwrap();
        let mut card = note(&a.id, "");
        card.kind = MessageKind::Approval;
        card.approval = Some(Approval {
            request_id: "r9".into(),
            title: "Run a command".into(),
            detail: "ls".into(),
            status: ApprovalStatus::Pending,
            tool: Some("Bash".into()),
            input: None,
            always: None,
            always_allowed: false,
            summary: None,
            note: None,
            prompt: None,
            choice: None,
            secret: None,
            connector: None,
            login: None,
            set_aside: None,
            expiry: None,
            from_outside: None,
            front: None,
            settings: None,
            plan: None,
            handoff: None,
            gate: None,
            step_in: None,
            crossover: None,
            account_switch: None,
            skill: None,
            slack_reply: None,
            risk: None,
        });
        append_message(&card).unwrap();
        let raw = std::fs::read(log_path(&a.id).unwrap()).unwrap();
        let answered = deny_with_note(&a.id, "r9", "not now").unwrap().unwrap();
        assert_eq!(
            answered.approval.as_ref().unwrap().status,
            ApprovalStatus::Denied
        );
        assert_eq!(std::fs::read(log_path(&a.id).unwrap()).unwrap(), raw);
        let found = find_approval(&a.id, "r9").unwrap().unwrap();
        assert_eq!(found.note.as_deref(), Some("not now"));
        assert!(pending_approvals(&a.id).unwrap().is_empty());
        assert_eq!(get(&a.id).unwrap().pending_approvals, 0);
        let shown = messages(&a.id, 1).unwrap();
        assert_eq!(
            shown[0].approval.as_ref().unwrap().status,
            ApprovalStatus::Denied
        );
    });
}

#[test]
fn a_long_log_is_read_from_its_end() {
    with_root(|| {
        let a = create(new("Finance")).unwrap();
        // Long enough to span several read chunks.
        let filler = "x".repeat(3000);
        for i in 0..400 {
            append_message(&note(&a.id, &format!("{i} {filler}"))).unwrap();
        }
        let last: Vec<String> = messages(&a.id, 3)
            .unwrap()
            .into_iter()
            .map(|m| m.text.split(' ').next().unwrap().to_string())
            .collect();
        assert_eq!(last, ["397", "398", "399"]);
        assert_eq!(messages(&a.id, 1000).unwrap().len(), 400);
        assert_eq!(messages(&a.id, usize::MAX).unwrap().len(), 400);
    });
}

/* ---------------------------------------------- backwards compatibility */

// Data users already have on disk must load in every future release.
// The fixtures are frozen: never edit them to make a test pass; add new
// ones for new formats.
const COMPAT_REGISTRY: &str = include_str!("testdata/compat/agents.json");
const COMPAT_LOG: &str = include_str!("testdata/compat/messages.jsonl");
const CHIEF: &str = "c0ffee00-0000-4000-8000-000000000001";

/// Every key of `old` is in `new` with a value that covers it (an
/// absent key may come back as its default; a null may be left out).
fn covers(new: Option<&serde_json::Value>, old: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (new, old) {
        (None, Value::Null) => true,
        (Some(Value::Object(n)), Value::Object(o)) => o.iter().all(|(k, v)| covers(n.get(k), v)),
        (Some(Value::Array(n)), Value::Array(o)) => {
            n.len() == o.len() && n.iter().zip(o).all(|(n, o)| covers(Some(n), o))
        }
        (Some(n), o) => n == o,
        (None, _) => false,
    }
}

fn registry_on_disk() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(registry_path().unwrap()).unwrap()).unwrap()
}

#[test]
fn registries_from_every_release_load_and_survive_a_write() {
    with_root(|| {
        std::fs::create_dir_all(agents_root().unwrap()).unwrap();
        std::fs::write(registry_path().unwrap(), COMPAT_REGISTRY).unwrap();
        let agents = list().unwrap();
        let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Chief of Staff", "Builder", "Finance", "Scout"]);
        let chief = &agents[0];
        assert!(chief.is_main && chief.pinned);
        assert_eq!(chief.check_ins.len(), 3);
        assert_eq!(chief.permissions.len(), 4);
        assert_eq!(chief.usage.all_time.turns, 41);
        assert_eq!(chief.usage.days.len(), 1);
        assert_eq!(chief.model.as_deref(), Some("opus"));
        assert!(chief.failure.as_ref().unwrap().resets_at.is_some());
        assert_eq!(
            agents[1].project.as_deref(),
            Some("/Users/someone/ShipStudio/site")
        );
        // The oldest shape: only the original fields.
        let scout = &agents[3];
        assert!(scout.role.is_empty() && !scout.pinned && scout.check_ins.is_empty());

        // A write (any update) keeps everything that was there.
        update(&agents[3].id, |a| a.unread = 1).unwrap();
        let old: serde_json::Value = serde_json::from_str(COMPAT_REGISTRY).unwrap();
        let mut new = registry_on_disk();
        new["agents"][3]["unread"] = serde_json::json!(0);
        assert!(covers(Some(&new), &old), "a write dropped data:\n{new:#}");
    });
}

#[test]
fn an_older_build_keeps_what_a_newer_one_wrote() {
    with_root(|| {
        let mut future: serde_json::Value = serde_json::from_str(COMPAT_REGISTRY).unwrap();
        future["formatVersion"] = serde_json::json!(9);
        future["agents"][0]["voice"] = serde_json::json!({ "name": "Ava", "speed": 1.1 });
        future["agents"][0]["checkIns"][0]["quietHours"] = serde_json::json!([22, 7]);
        future["agents"][0]["permissions"][0]["expiresAt"] = serde_json::json!(1799999999999i64);
        // A whole entry this build can't read (a repeat it has no word for).
        let mut newer = future["agents"][3].clone();
        newer["id"] = serde_json::json!("c0ffee00-0000-4000-8000-000000000005");
        newer["name"] = serde_json::json!("Yearly");
        newer["checkIns"] = serde_json::json!([{ "id": "x", "note": "n", "repeat": { "kind": "yearly", "month": 3, "day": 1 }, "nextAt": 1, "createdAt": 1 }]);
        future["agents"].as_array_mut().unwrap().push(newer);
        std::fs::create_dir_all(agents_root().unwrap()).unwrap();
        std::fs::write(registry_path().unwrap(), future.to_string()).unwrap();

        assert_eq!(list().unwrap().len(), 4, "the unreadable entry is hidden");
        update(CHIEF, |a| a.unread = 7).unwrap();
        let chief = get(CHIEF).unwrap();
        assert_eq!(chief.extra["voice"]["name"], "Ava");
        let mut on_disk = registry_on_disk();
        on_disk["agents"][0]["unread"] = future["agents"][0]["unread"].clone();
        assert!(
            covers(Some(&on_disk), &future),
            "a write dropped newer data:\n{on_disk:#}"
        );
        // Nothing was treated as damage.
        let aside = std::fs::read_dir(agents_root().unwrap())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
        assert!(!aside);
    });
}

/// Every kind of chat line, so a new kind can't ship without a fixture:
/// this match stops compiling until it is listed (and added to the log).
fn fixture_line_for(kind: MessageKind) -> &'static str {
    match kind {
        MessageKind::User => "m01",
        MessageKind::SentToAgent => "m02",
        MessageKind::FromAgent => "m03",
        MessageKind::Agent => "m04",
        MessageKind::Approval => "m05",
        MessageKind::Note => "m09",
        MessageKind::CheckIn => "m13",
        MessageKind::Changes => "m14",
        MessageKind::Error => "m16",
        MessageKind::Session => "s01",
    }
}

#[test]
fn chat_logs_from_every_release_load_in_full() {
    with_root(|| {
        std::fs::create_dir_all(agents_root().unwrap()).unwrap();
        std::fs::write(registry_path().unwrap(), COMPAT_REGISTRY).unwrap();
        let home = agent_home(CHIEF).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        // Plus lines a newer build might write: a kind and a field this one doesn't know.
        let future_kind = r#"{"id":"m21","agentId":"c0ffee00-0000-4000-8000-000000000001","ts":1762200000021,"kind":"voice_memo","text":"hi"}"#;
        let future_field = r#"{"id":"m22","agentId":"c0ffee00-0000-4000-8000-000000000001","ts":1762200000022,"kind":"agent","text":"ok","reactions":["👍"]}"#;
        let raw = format!("{COMPAT_LOG}{future_kind}\n{future_field}\n");
        std::fs::write(home.join("messages.jsonl"), &raw).unwrap();

        let log = messages(CHIEF, usize::MAX).unwrap();
        let ids: Vec<&str> = log.iter().map(|m| m.id.as_str()).collect();
        let expected: Vec<String> = (1..=20)
            .map(|n| format!("m{n:02}"))
            .chain((1..=4).map(|n| format!("s{n:02}")))
            .chain((1..=4).map(|n| format!("p{n:02}")))
            .chain((1..=3).map(|n| format!("r{n:02}")))
            .chain(["o01".into()])
            .chain(["m22".into()])
            .collect();
        assert_eq!(ids, expected, "a line was dropped");
        for kind in [
            MessageKind::User,
            MessageKind::Agent,
            MessageKind::SentToAgent,
            MessageKind::FromAgent,
            MessageKind::Approval,
            MessageKind::Error,
            MessageKind::CheckIn,
            MessageKind::Note,
            MessageKind::Changes,
            MessageKind::Session,
        ] {
            let id = fixture_line_for(kind);
            assert!(log.iter().any(|m| m.id == id && m.kind == kind), "{kind:?}");
        }
        let status = |rid: &str| {
            log.iter()
                .filter_map(|m| m.approval.as_ref())
                .find(|a| a.request_id == rid)
                .unwrap()
                .status
        };
        assert_eq!(status("req-pending"), ApprovalStatus::Pending);
        assert_eq!(status("req-allowed"), ApprovalStatus::Allowed);
        assert_eq!(status("req-denied"), ApprovalStatus::Denied);
        assert_eq!(status("req-expired"), ApprovalStatus::Expired);
        let by_id = |id: &str| log.iter().find(|m| m.id == id).unwrap();
        assert_eq!(by_id("m01").attachments.len(), 1);
        assert_eq!(by_id("m01").mentions.len(), 1);
        assert_eq!(by_id("m04").attachments[0].name, "october.csv");
        assert!(by_id("m11").stopped);
        assert!(by_id("m13").check_in.as_ref().unwrap().late);
        assert_eq!(by_id("m14").changes.as_ref().unwrap().files.len(), 3);
        assert!(by_id("m15").changes.as_ref().unwrap().branch.is_none());
        assert!(by_id("m16").failure.as_ref().unwrap().resets_at.is_some());
        assert!(by_id("m18").failure.is_none());
        use super::super::sessions::SessionEvent;
        let event = |id: &str| by_id(id).session.as_ref().unwrap().event;
        assert_eq!(event("s01"), SessionEvent::Started);
        assert_eq!(event("s02"), SessionEvent::Sent);
        assert_eq!(event("s03"), SessionEvent::Reply);
        assert_eq!(event("s04"), SessionEvent::Screenshot);
        assert_eq!(by_id("s01").session.as_ref().unwrap().tab, Some(1));
        assert_eq!(by_id("s04").attachments.len(), 1);
        // Secure input cards (`request_secret`) and a session's question.
        let card = |id: &str| by_id(id).approval.as_ref().unwrap();
        let saved = card("p01").secret.as_ref().unwrap();
        assert_eq!(saved.fields[0].env, "STRIPE");
        assert_eq!(card("p02").secret.as_ref().unwrap().fields.len(), 2);
        assert_eq!(
            card("p02").note.as_deref(),
            Some("Use the CSV export instead")
        );
        let trust = card("p03").prompt.as_ref().unwrap();
        assert_eq!(trust.kind, super::super::decisions::PromptKind::Trust);
        assert_eq!(trust.chats.len(), 2);
        assert_eq!(card("p03").choice.as_deref(), Some("Yes, proceed"));
        assert_eq!(status("req-prompt-expired"), ApprovalStatus::Expired);
        assert_eq!(card("p04").prompt.as_ref().unwrap().options.len(), 3);
        // Result cards (`share_result`) and "Ask for changes".
        use super::super::results::{ResultItem, ShotRole};
        let first = by_id("r01").result.as_ref().unwrap();
        assert_eq!((first.version, first.items.len()), (1, 2));
        assert!(matches!(first.items[1], ResultItem::Link { .. }));
        assert_eq!(first.not_verified.len(), 1);
        assert_eq!(by_id("r02").revises.as_ref().unwrap().id, "res-oct");
        let second = by_id("r03").result.as_ref().unwrap();
        assert_eq!(by_id("r03").kind, MessageKind::Changes);
        assert_eq!(
            second.changes.as_deref(),
            Some("EUR invoices use the October 31 rate")
        );
        assert!(matches!(
            second.items[0],
            ResultItem::File {
                role: Some(ShotRole::After),
                ..
            }
        ));
        // A line said in a room keeps the room it was said in.
        assert_eq!(
            by_id("o01").room.as_deref(),
            Some("f00dface000040008000000000000001")
        );
        assert_eq!(messages(CHIEF, 3).unwrap().len(), 3);

        // Answering a card and appending leave every existing line as it was.
        set_approval_status(CHIEF, "req-pending", ApprovalStatus::Allowed)
            .unwrap()
            .unwrap();
        append_message(&note(CHIEF, "after")).unwrap();
        let now = std::fs::read_to_string(home.join("messages.jsonl")).unwrap();
        assert!(now.starts_with(&raw), "the log was rewritten");
        assert_eq!(get(CHIEF).unwrap().pending_approvals, 0);
    });
}

#[test]
fn a_torn_registry_comes_back_from_its_copy_and_is_kept_aside() {
    with_root(|| {
        create(new("Finance")).unwrap();
        create(new("Travel")).unwrap();
        let path = registry_path().unwrap();
        let raw = std::fs::read(&path).unwrap();
        std::fs::write(&path, &raw[..raw.len() / 2]).unwrap();
        assert_eq!(list().unwrap().len(), 2);
        let aside = std::fs::read_dir(agents_root().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("agents.json.corrupt-")
            })
            .count();
        assert_eq!(aside, 1);
        // Repaired on disk: the next read neither recovers nor copies again.
        assert_eq!(list().unwrap().len(), 2);
    });
}

#[test]
fn one_bad_entry_doesnt_hide_the_rest() {
    with_root(|| {
        create(new("Finance")).unwrap();
        create(new("Travel")).unwrap();
        let path = registry_path().unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        value["agents"][0]["shape"] = serde_json::json!("not a number");
        std::fs::write(&path, value.to_string()).unwrap();
        std::fs::remove_file(path.with_extension("json.bak")).unwrap();
        let names: Vec<String> = list().unwrap().into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Travel"]);
    });
}

#[test]
fn an_unrecoverable_registry_is_an_error_not_an_empty_list() {
    with_root(|| {
        let finance = create(new("Finance")).unwrap();
        let path = registry_path().unwrap();
        std::fs::write(&path, b"{\"agents\": [").unwrap();
        std::fs::remove_file(path.with_extension("json.bak")).unwrap();
        // No folder to rebuild from either.
        std::fs::remove_dir_all(agent_home(&finance.id).unwrap()).unwrap();
        assert!(list().is_err());
        assert!(
            create(new("Travel")).is_err(),
            "must not overwrite what it couldn't read"
        );
    });
}

#[test]
fn a_damaged_registry_with_no_copy_is_rebuilt_from_the_agents_folders() {
    with_root(|| {
        let _ = crate::agents::survive::take_pending();
        let chief = create(NewAgent {
            is_main: true,
            ..new(crate::agents::prompts::CHIEF_NAME)
        })
        .unwrap();
        let finance = create(new("Finance")).unwrap();
        let path = registry_path().unwrap();
        std::fs::write(&path, b"{\"agents\": [").unwrap();
        std::fs::remove_file(path.with_extension("json.bak")).unwrap();
        // A folder that isn't an agent's is left alone.
        std::fs::create_dir_all(agents_root().unwrap().join("stray")).unwrap();
        let finance_md = std::fs::read(agent_home(&finance.id).unwrap().join("CLAUDE.md")).unwrap();

        let back = list().unwrap();
        let mut names: Vec<&str> = back.iter().map(|a| a.name.as_str()).collect();
        names.sort();
        assert_eq!(names, [crate::agents::prompts::CHIEF_NAME, "Finance"]);
        let rebuilt_chief = back.iter().find(|a| a.is_main).unwrap();
        assert_eq!(rebuilt_chief.id, chief.id);
        let rebuilt_finance = back.iter().find(|a| a.id == finance.id).unwrap();
        assert_eq!(rebuilt_finance.role, "Does things");
        assert!(!rebuilt_finance.is_main);
        // The folder itself is untouched.
        assert_eq!(
            std::fs::read(agent_home(&finance.id).unwrap().join("CLAUDE.md")).unwrap(),
            finance_md
        );
        // The damaged list is kept, the Chief told once.
        let kept: Vec<_> = std::fs::read_dir(agents_root().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("agents.json.corrupt-")
            })
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"{\"agents\": [");
        let rebuilt = |lines: Vec<String>| -> Vec<String> {
            lines
                .into_iter()
                .filter(|l| l.contains("rebuilt from the agents' folders"))
                .collect()
        };
        let lines = rebuilt(crate::agents::survive::take_pending());
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("2 agents back"), "{}", lines[0]);
        // Repaired on disk: the next read neither rebuilds nor says it again.
        assert_eq!(list().unwrap().len(), 2);
        assert!(rebuilt(crate::agents::survive::take_pending()).is_empty());
    });
}

/// What lived only in the list can't be read back from a folder, and a
/// folder anyone can write must not decide it: a rebuild starts every
/// agent with less room, never more. The user had taken the Chief's
/// admin away and Finance's browser; neither comes back on its own, and
/// no agent (a folder dressed as the Chief included) is an admin.
#[test]
fn a_rebuild_never_gives_back_room_the_user_took_away() {
    with_root(|| {
        let _ = crate::agents::survive::take_pending();
        let chief = create(NewAgent {
            is_main: true,
            ..new(crate::agents::prompts::CHIEF_NAME)
        })
        .unwrap();
        crate::agents::admin::set_admin(&chief.id, false).unwrap();
        let finance = create(new("Finance")).unwrap();
        update(&finance.id, |a| a.reach.browser_off = true).unwrap();
        let path = registry_path().unwrap();
        std::fs::write(&path, b"{\"agents\": [").unwrap();
        std::fs::remove_file(path.with_extension("json.bak")).unwrap();

        let back = list().unwrap();
        let rebuilt_chief = back.iter().find(|a| a.id == chief.id).unwrap();
        assert!(rebuilt_chief.is_main);
        assert!(
            !crate::agents::admin::is_admin(rebuilt_chief),
            "the Chief's admin came back on"
        );
        let rebuilt_finance = back.iter().find(|a| a.id == finance.id).unwrap();
        assert!(
            rebuilt_finance.reach.browser_off,
            "Finance's browser came back"
        );
        assert!(back.iter().all(|a| !crate::agents::admin::is_admin(a)));
        let lines = crate::agents::survive::take_pending();
        assert!(
            lines
                .iter()
                .any(|l| l.contains("browser") && l.contains("admin")),
            "{lines:?}"
        );
    });
}

/// What the user narrowed lives only in the list; the file beside each
/// agent brings it back on a rebuild: apps kept from it, muted, Runs only
/// on one account. Taking a limit off updates the file too.
#[test]
fn a_rebuild_restores_what_the_user_narrowed() {
    with_root(|| {
        let _ = crate::agents::survive::take_pending();
        let chief = create(NewAgent {
            is_main: true,
            ..new(crate::agents::prompts::CHIEF_NAME)
        })
        .unwrap();
        let outreach = create(new("Outreach")).unwrap();
        update(&outreach.id, |a| {
            a.reach.blocked_apps = vec!["claude.ai Gmail".into(), "Linear".into()];
            a.muted = true;
            a.account = Some("work-account".into());
        })
        .unwrap();
        // A limit taken off again is off in the file too.
        update(&chief.id, |a| a.muted = true).unwrap();
        update(&chief.id, |a| a.muted = false).unwrap();
        let home = agent_home(&outreach.id).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(home.join(limits::FILE)).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }

        let path = registry_path().unwrap();
        std::fs::write(&path, b"{\"agents\": [").unwrap();
        std::fs::remove_file(path.with_extension("json.bak")).unwrap();

        let back = list().unwrap();
        let o = back.iter().find(|a| a.id == outreach.id).unwrap();
        assert_eq!(o.reach.blocked_apps, ["claude.ai Gmail", "Linear"]);
        assert!(o.muted);
        assert_eq!(o.account.as_deref(), Some("work-account"));
        assert!(o.reach.browser_off);
        let c = back.iter().find(|a| a.id == chief.id).unwrap();
        assert!(!c.muted);
        assert!(!crate::agents::admin::is_admin(c));
        let _ = crate::agents::survive::take_pending();
    });
}

/// A folder is anyone's to write: a file there that says "browser on",
/// "admin", "not muted" or no apps kept gives nothing back, and one that
/// isn't a limits file is ignored whole.
#[test]
fn a_limits_file_never_widens_a_rebuild() {
    with_root(|| {
        let _ = crate::agents::survive::take_pending();
        let chief = create(NewAgent {
            is_main: true,
            ..new(crate::agents::prompts::CHIEF_NAME)
        })
        .unwrap();
        let other = create(new("Finance")).unwrap();
        let path = registry_path().unwrap();
        std::fs::write(&path, b"{\"agents\": [").unwrap();
        std::fs::remove_file(path.with_extension("json.bak")).unwrap();
        let chief_home = agent_home(&chief.id).unwrap();
        std::fs::write(
                chief_home.join(limits::FILE),
                br#"{"browserOff": false, "adminOff": false, "muted": false, "blockedApps": [], "admin": true}"#,
            )
            .unwrap();
        let other_home = agent_home(&other.id).unwrap();
        std::fs::write(other_home.join(limits::FILE), b"not json").unwrap();

        let back = list().unwrap();
        let c = back.iter().find(|a| a.id == chief.id).unwrap();
        assert!(c.reach.browser_off);
        assert!(!crate::agents::admin::is_admin(c));
        assert!(back.iter().all(|a| !crate::agents::admin::is_admin(a)));
        let f = back.iter().find(|a| a.id == other.id).unwrap();
        assert!(f.reach.blocked_apps.is_empty() && !f.muted && f.reach.browser_off);
        let _ = crate::agents::survive::take_pending();
    });
}

/// A Runs on pin for another engine means nothing to the engine it was
/// rebuilt on; it isn't applied.
#[test]
fn a_runs_on_pin_comes_back_only_on_its_own_engine() {
    with_root(|| {
        let mut agent = create(new("Finance")).unwrap();
        let other = match agent.engine {
            crate::agents::engine::Engine::Codex => crate::agents::engine::Engine::Claude,
            _ => crate::agents::engine::Engine::Codex,
        };
        let pin = |engine| limits::Limits {
            runs_on: Some(limits::RunsOn {
                engine,
                account: "elsewhere".into(),
            }),
            ..Default::default()
        };
        limits::restore(&mut agent, &pin(other));
        assert_eq!(agent.account, None);
        let own = agent.engine;
        limits::restore(&mut agent, &pin(own));
        assert_eq!(agent.account.as_deref(), Some("elsewhere"));
    });
}

#[test]
fn a_rebuild_keeps_two_folders_with_one_name_apart() {
    with_root(|| {
        let root = agents_root().unwrap();
        for id in ["aaa1", "bbb2"] {
            std::fs::create_dir_all(root.join(id)).unwrap();
            std::fs::write(
                root.join(id).join("CLAUDE.md"),
                "# Finance\n\n## Instructions\n\nBe brief.\n",
            )
            .unwrap();
        }
        std::fs::create_dir_all(root.join("ccc3")).unwrap();
        std::fs::write(root.join("ccc3").join("CLAUDE.md"), "no heading").unwrap();
        std::fs::write(registry_path().unwrap(), b"\0\0\0").unwrap();
        let mut names: Vec<String> = list().unwrap().into_iter().map(|a| a.name).collect();
        names.sort();
        assert_eq!(names, ["Finance", "Finance 2"]);
        assert!(list()
            .unwrap()
            .iter()
            .all(|a| a.role.is_empty() && !a.is_main));
        let _ = crate::agents::survive::take_pending();
    });
}

#[test]
fn a_repeat_read_is_served_from_the_cache_until_the_file_changes() {
    with_root(|| {
        create(new("Finance")).unwrap();
        assert_eq!(list().unwrap().len(), 1);
        let path = registry_path().unwrap();
        let stamp = FileStamp::of(&path).unwrap();
        {
            let cache = REGISTRY_CACHE.lock().unwrap();
            let (cached_path, cached_stamp, _) = cache.as_ref().expect("a read is cached");
            assert_eq!((cached_path, cached_stamp), (&path, &stamp));
        }
        // A write drops it, and the next read sees the write.
        create(new("Travel")).unwrap();
        assert_eq!(list().unwrap().len(), 2);
        // Somebody else rewriting the file in place, to the same length.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Travel"));
        std::fs::write(&path, text.replace("Travel", "Travle")).unwrap();
        let names: Vec<String> = list().unwrap().into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Finance", "Travle"]);
    });
}

#[test]
fn models_are_the_cli_aliases_only() {
    assert_eq!(normalize_model(" ").unwrap(), None);
    assert_eq!(normalize_model(" opus ").unwrap().as_deref(), Some("opus"));
    assert!(normalize_model("haiku").is_ok());
    assert!(normalize_model("gpt-5").is_err());
    assert!(normalize_model("--dangerously-skip-permissions").is_err());
    assert!(normalize_model("opus; rm -rf").is_err());
}

#[test]
fn efforts_are_the_three_both_engines_take() {
    assert_eq!(normalize_effort("").unwrap(), None);
    assert_eq!(normalize_effort(" High ").unwrap().as_deref(), Some("high"));
    assert_eq!(normalize_effort("low").unwrap().as_deref(), Some("low"));
    for refused in ["max", "minimal", "--model", "high\"; x=1"] {
        assert!(normalize_effort(refused).is_err(), "{refused}");
    }
}

#[test]
fn effort_is_left_out_of_the_registry_until_set() {
    let mut a: Agent = serde_json::from_value(serde_json::json!({
        "id": "a", "name": "A", "shape": 0, "color": "blue", "createdAt": 0
    }))
    .unwrap();
    assert!(serde_json::to_value(&a).unwrap().get("effort").is_none());
    a.effort = Some("high".into());
    assert_eq!(serde_json::to_value(&a).unwrap()["effort"], "high");
}

#[test]
fn rejects_path_like_ids() {
    assert!(agent_home("../etc").is_err());
    assert!(agent_home("").is_err());
}

/// The Chief's old names reach it only when addressed (a message, a
/// read) and only while no agent has that exact name; everywhere else
/// a name is a name, so "Chief" and "Chief of Staff" stay creatable.
#[test]
fn the_chiefs_old_names_reach_it_only_where_no_agent_has_them() {
    with_root(|| {
        let mut main = new("Dash");
        main.is_main = true;
        let chief = create(main).unwrap();
        assert!(find("Chief of Staff").unwrap().is_none());
        assert_eq!(
            find_addressed("Chief of Staff").unwrap().unwrap().id,
            chief.id
        );
        let other = create(new("Chief")).unwrap();
        assert_eq!(find("chief").unwrap().unwrap().id, other.id);
        assert_eq!(find_addressed("chief").unwrap().unwrap().id, other.id);
        assert_eq!(find_addressed("the Chief").unwrap().unwrap().id, chief.id);
        assert!(create(new("Chief of Staff")).is_ok());
        assert_ne!(
            find_addressed("Chief of Staff").unwrap().unwrap().id,
            chief.id
        );
    });
}

#[test]
fn the_chiefs_old_names_still_mean_the_chief() {
    for name in ["Chief of Staff", "chief", "the Chief", "  CHIEF OF STAFF "] {
        assert!(super::chief_alias(name), "{name}");
    }
    for name in ["Chef", "Finance", "Chief Marketing", "Dash"] {
        assert!(!super::chief_alias(name), "{name}");
    }
}
