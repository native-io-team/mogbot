//! One yes for the whole plan, against a fictional repo: what a grant
//! covers (and for whom), what it never covers, when it ends, and that only
//! the user's own yes makes one.

use super::*;
use serde_json::json;

/// A fictional checkout of `julian-fictional/shippy` and the agent's home.
struct Mac {
    _dir: tempfile::TempDir,
    ctx: Ctx,
}

fn mac() -> Mac {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let repo = home.join("Projects/shippy");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::write(
        repo.join(".git/config"),
        "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:julian-fictional/shippy.git\n",
    )
    .unwrap();
    std::fs::create_dir_all(repo.join(".vercel")).unwrap();
    std::fs::write(
        repo.join(".vercel/project.json"),
        r#"{"projectId":"prj_fictional","orgId":"team_x","projectName":"shippy"}"#,
    )
    .unwrap();
    let own = home.join("agents/builder");
    std::fs::create_dir_all(&own).unwrap();
    let ctx = Ctx {
        home: home.clone(),
        own_home: own.clone(),
        cwd: repo,
        scratch: vec![own],
        ..Default::default()
    };
    Mac { _dir: dir, ctx }
}

fn action(kind: Kind, target: &str, summary: &str) -> PlanAction {
    PlanAction {
        kind,
        target: target.into(),
        summary: summary.into(),
    }
}

/// The owner's real plan: redeploy production, one issue and two comments.
fn owners_plan() -> Plan {
    Plan {
        actions: vec![
            action(
                Kind::Deploy,
                "shippy",
                "Redeploy shippy's production on Vercel",
            ),
            action(
                Kind::Issue,
                "julian-fictional/shippy",
                "Open the issue about the build",
            ),
            action(Kind::Comment, "julian-fictional/shippy", "Comment on #12"),
            action(Kind::Comment, "julian-fictional/shippy", "Comment on #14"),
        ],
        why: Some("Fix the broken deploy".into()),
    }
}

fn bash(command: &str) -> Value {
    json!({ "command": command, "description": "x" })
}

const NOW: i64 = 1_800_000_000_000;

fn covers_at(holder: &str, level: Level, mac: &Mac, tool: &str, input: &Value, now: i64) -> bool {
    let turn = Turn {
        holder,
        ctx: &mac.ctx,
        level,
        exposed: false,
        browser: None,
        now,
    };
    cover(tool, input, &turn).is_some()
}

fn covers(holder: &str, level: Level, mac: &Mac, command: &str) -> bool {
    covers_at(holder, level, mac, "Bash", &bash(command), NOW)
}

#[test]
fn a_grant_covers_each_listed_action_once_and_nothing_more() {
    let m = mac();
    let id = "plan-test-listed";
    grant(id, &owners_plan(), NOW);
    for level in [Level::GoHard] {
        assert!(covers(
            id,
            level,
            &m,
            "vercel redeploy https://shippy-abc123-team.vercel.app --prod"
        ));
        assert!(covers(
            id,
            level,
            &m,
            "gh issue create --title 'Build broken' --body 'x'"
        ));
        assert!(covers(
            id,
            level,
            &m,
            "gh issue comment 12 --body 'Fixed in main'"
        ));
        assert!(covers(
            id,
            level,
            &m,
            "gh issue comment 14 -R julian-fictional/shippy --body 'Same'"
        ));
        // Two comments were listed: a third isn't.
        assert!(!covers(
            id,
            level,
            &m,
            "gh issue comment 15 --body 'And this'"
        ));
        // The same call again (a retry) still is.
        assert!(covers(
            id,
            level,
            &m,
            "gh issue comment 12 --body 'Fixed in main'"
        ));
    }
}

#[test]
fn a_grant_goes_with_the_work_to_the_agent_it_is_handed_to() {
    let m = mac();
    let (chief, builder, stranger) = ("plan-test-chief", "plan-test-builder", "plan-test-stranger");
    grant(chief, &owners_plan(), NOW);
    assert!(!covers(
        builder,
        Level::GoHard,
        &m,
        "gh issue create --title x --body y"
    ));
    assert!(carry(chief, builder, NOW));
    assert!(covers(
        builder,
        Level::FullSend,
        &m,
        "gh issue create --title x --body y"
    ));
    // …and from it, to the next in the chain.
    assert!(carry(builder, "plan-test-tester", NOW));
    assert!(covers(
        "plan-test-tester",
        Level::GoHard,
        &m,
        "gh issue comment 12 --body ok"
    ));
    // Nobody else holds it.
    assert!(!covers(
        stranger,
        Level::GoHard,
        &m,
        "gh issue comment 14 --body ok"
    ));
}

#[test]
fn what_is_not_listed_is_not_covered() {
    let m = mac();
    let id = "plan-test-unlisted";
    grant(
        id,
        &Plan {
            actions: vec![action(
                Kind::Issue,
                "julian-fictional/shippy",
                "Open an issue",
            )],
            why: None,
        },
        NOW,
    );
    // Another repo, another kind.
    assert!(!covers(
        id,
        Level::GoHard,
        &m,
        "gh issue create -R someone-else/repo --title x --body y"
    ));
    assert!(!covers(id, Level::GoHard, &m, "git push origin main"));
    assert!(!covers(id, Level::GoHard, &m, "vercel --prod"));
    assert!(!covers(id, Level::GoHard, &m, "gh pr merge 3"));
    // A connector on another repo, and one that isn't a write.
    let other = json!({ "owner": "someone-else", "repo": "repo", "title": "x" });
    assert!(!covers_at(
        id,
        Level::GoHard,
        &m,
        "mcp__github__create_issue",
        &other,
        NOW
    ));
    let ours = json!({ "owner": "julian-fictional", "repo": "shippy", "title": "x" });
    assert!(covers_at(
        id,
        Level::GoHard,
        &m,
        "mcp__github__create_issue",
        &ours,
        NOW
    ));
}

#[test]
fn production_deploys_and_pushes_to_main_are_coverable() {
    let m = mac();
    let id = "plan-test-prod";
    grant(
        id,
        &Plan {
            actions: vec![
                action(
                    Kind::Push,
                    "julian-fictional/shippy",
                    "Push the fix to main",
                ),
                action(Kind::Deploy, "shippy", "Deploy to production"),
                action(Kind::PullRequest, "shippy", "Open the PR"),
            ],
            why: None,
        },
        NOW,
    );
    assert!(covers(id, Level::FullSend, &m, "git push origin main"));
    assert!(covers(id, Level::FullSend, &m, "vercel --prod --yes"));
    assert!(covers(
        id,
        Level::GoHard,
        &m,
        "gh pr create --title Fix --body Body"
    ));
}

#[test]
fn the_floor_is_never_covered() {
    let m = mac();
    let id = "plan-test-floor";
    let everything = Plan {
        actions: [
            Kind::Push,
            Kind::Deploy,
            Kind::Request,
            Kind::Github,
            Kind::Issue,
            Kind::Send,
            Kind::Publish,
        ]
        .iter()
        .flat_map(|k| {
            [
                "julian-fictional/shippy",
                "shippy",
                "api.stripe.com",
                "example.com",
            ]
            .map(|t| action(*k, t, "x"))
        })
        .collect(),
        why: None,
    };
    grant(id, &everything, NOW);
    for command in [
        "sudo git push origin main",
        "git push --force origin main",
        "git push origin :old-branch",
        "git push origin main && sudo rm -rf /Library/Fictional",
        // (the fictional home is in a temporary folder, where deleting is local work)
        "git push origin main; rm -rf /Users/Shared/fictional-docs",
        "curl -X POST https://api.stripe.com/v1/charges -d amount=100",
        "stripe charges create --live --amount 100",
        "gh secret set TOKEN --body x",
        "gh api -X DELETE repos/julian-fictional/shippy/issues/comments/1",
        "gh api repos/julian-fictional/shippy/actions/secrets/X -X PUT -f v=1",
        "gh repo delete julian-fictional/shippy --yes",
        "gh issue delete 12",
        "vercel env add SECRET production",
        "vercel rm shippy --yes",
        "security add-generic-password -s x -w y && git push",
        "launchctl load ~/Library/LaunchAgents/x.plist && git push",
        "npm unpublish shippy",
        "git push origin main > ~/.zshrc",
    ] {
        for level in [Level::GoHard, Level::FullSend, Level::Judgement] {
            assert!(!covers(id, level, &m, command), "{command} at {level:?}");
        }
    }
    for tool in [
        "mcp__stripe__create_payment",
        "mcp__github__delete_file",
        "mcp__github__create_or_update_secret",
        "mcp__slack__remove_member",
        "mcp__vercel__delete_project",
        "mcp__supabase__execute_sql",
    ] {
        let input = json!({ "owner": "julian-fictional", "repo": "shippy", "project": "shippy" });
        assert!(
            !covers_at(id, Level::FullSend, &m, tool, &input, NOW),
            "{tool}"
        );
    }
}

#[test]
fn a_grant_ends_after_an_hour() {
    let m = mac();
    let id = "plan-test-expires";
    grant(id, &owners_plan(), NOW);
    let later = NOW + LIFETIME_MS + 1;
    assert!(!holds(id, later));
    assert!(!covers_at(
        id,
        Level::GoHard,
        &m,
        "Bash",
        &bash("gh issue create --title x --body y"),
        later
    ));
    assert!(covers_at(
        id,
        Level::GoHard,
        &m,
        "Bash",
        &bash("gh issue create --title x --body y"),
        NOW + 60_000
    ));
}

#[test]
fn the_lower_levels_cover_only_what_was_listed() {
    let m = mac();
    let id = "plan-test-judgement";
    grant(
        id,
        &Plan {
            actions: vec![
                action(Kind::Push, "shippy", "Push the fix"),
                action(Kind::Push, "shippy", "Push the fix (again)"),
            ],
            why: None,
        },
        NOW,
    );
    let repo = m.ctx.cwd.display().to_string();
    assert!(covers(
        id,
        Level::Judgement,
        &m,
        &format!("cd {repo} && git push origin fix")
    ));
    // Something else on the line isn't the plan: at "Use good judgement" it asks…
    assert!(!covers(
        id,
        Level::Judgement,
        &m,
        "npm install left-pad && git push origin fix"
    ));
    assert!(!covers(
        id,
        Level::Often,
        &m,
        "npm install left-pad && git push origin fix"
    ));
    // …while at "Go hard" the rest is judged by Go hard (an install runs).
    assert!(covers(
        id,
        Level::GoHard,
        &m,
        "npm install left-pad && git push origin fix"
    ));
}

#[test]
fn a_turn_that_read_outside_content_covers_only_what_was_listed() {
    let m = mac();
    let id = "plan-test-exposed";
    grant(
        id,
        &Plan {
            actions: vec![action(Kind::Push, "shippy", "Push the fix")],
            why: None,
        },
        NOW,
    );
    let turn = Turn {
        holder: id,
        ctx: &m.ctx,
        level: Level::FullSend,
        exposed: true,
        browser: None,
        now: NOW,
    };
    assert!(cover(
        "Bash",
        &bash("scp notes.txt elsewhere.example:/tmp && git push"),
        &turn
    )
    .is_none());
    assert!(cover("Bash", &bash("git push origin fix"), &turn).is_some());
}

#[test]
fn browser_steps_are_matched_on_the_site() {
    let m = mac();
    let id = "plan-test-browser";
    grant(
        id,
        &Plan {
            actions: vec![action(Kind::Post, "x.com", "Post the launch thread")],
            why: None,
        },
        NOW,
    );
    let at = |browser: Option<(&'static str, String)>| {
        let turn = Turn {
            holder: id,
            ctx: &m.ctx,
            level: Level::GoHard,
            exposed: false,
            browser,
            now: NOW,
        };
        cover("mcp__claude-in-chrome__computer", &json!({}), &turn).is_some()
    };
    assert!(!at(Some(("posted", "linkedin.com".into()))));
    assert!(
        !at(None),
        "a step the plan can't cover (a payment, a script)"
    );
    assert!(at(Some(("posted", "x.com".into()))));
}

#[test]
fn only_the_users_own_yes_to_the_plan_just_listed_makes_a_grant() {
    let id = "plan-test-chat-yes";
    let plan = owners_plan();
    // No yes at all: a card.
    assert!(!take_chat_yes(id, &plan, NOW));
    // The user typed "YES" to the plan the Chief listed.
    assert!(super::super::typed_answer::approves("YES"));
    let reply = "Here's the plan: redeploy shippy's production on Vercel, then open one issue on julian-fictional/shippy and comment on #12 and #14. OK?";
    note_chat_yes(id, reply, NOW);
    // A plan naming somewhere the reply didn't: not what they said yes to.
    let other = Plan {
        actions: vec![action(Kind::Push, "someone-else/other-repo", "Push")],
        why: None,
    };
    assert!(!take_chat_yes(id, &other, NOW + 1_000));
    assert!(take_chat_yes(id, &plan, NOW + 1_000));
    // Used once.
    assert!(!take_chat_yes(id, &plan, NOW + 2_000));
    // A stale yes isn't one.
    note_chat_yes(id, reply, NOW);
    assert!(!take_chat_yes(id, &plan, NOW + CHAT_YES_MS + 1));
}

#[test]
fn the_reply_a_yes_answers_is_the_one_just_before_it() {
    use super::super::store::AgentMessage;
    let msg = |kind: MessageKind, text: &str| -> AgentMessage {
        let mut m = runner::new_message("a", kind, text);
        m.text = text.into();
        m
    };
    let log = vec![
        msg(MessageKind::User, "fix the deploy"),
        msg(MessageKind::Agent, "Plan: redeploy shippy, then an issue."),
        msg(MessageKind::Note, "Checked"),
        msg(MessageKind::User, "YES"),
    ];
    assert_eq!(
        last_reply(&log).as_deref(),
        Some("Plan: redeploy shippy, then an issue.")
    );
    // Two user messages in a row: the yes answers nothing the agent listed.
    let log = vec![
        msg(MessageKind::Agent, "Plan: redeploy shippy."),
        msg(MessageKind::User, "hmm"),
        msg(MessageKind::User, "YES"),
    ];
    assert_eq!(last_reply(&log), None);
}

#[test]
fn the_tool_refuses_what_a_plan_cant_hold() {
    assert!(parse(&json!({ "actions": [] })).is_err());
    assert!(parse(
        &json!({ "actions": [{ "kind": "pay", "target": "stripe", "summary": "Pay" }] })
    )
    .is_err());
    assert!(
        parse(&json!({ "actions": [{ "kind": "push", "target": "", "summary": "Push" }] }))
            .is_err()
    );
    let plan = parse(&json!({
        "actions": [
            { "kind": "deploy", "target": "shippy", "summary": "Redeploy production" },
            { "kind": "comment", "target": "julian-fictional/shippy", "summary": "Comment on #12" }
        ],
        "why": "Fix the deploy"
    }))
    .unwrap();
    assert_eq!(numbered(&plan), "1. Redeploy production\n2. Comment on #12");
}

#[test]
fn calls_are_read_as_what_they_do() {
    let m = mac();
    let kinds = |c: &str| call_for_tests("Bash", &bash(c), &m.ctx);
    assert_eq!(kinds("git push origin main"), vec![Some(Kind::Push)]);
    assert_eq!(
        kinds("gh pr create --title x --body y"),
        vec![Some(Kind::PullRequest)]
    );
    assert_eq!(
        kinds("gh api repos/o/r/issues/3/comments -f body=x"),
        vec![Some(Kind::Comment)]
    );
    assert_eq!(kinds("npm test"), vec![None]);
    assert_eq!(
        call_for_tests("mcp__github__add_issue_comment", &json!({}), &m.ctx),
        vec![Some(Kind::Comment)]
    );
    assert_eq!(
        call_for_tests("mcp__slack__slack_post_message", &json!({}), &m.ctx),
        vec![Some(Kind::Post)]
    );
    assert_eq!(
        call_for_tests("mcp__github__get_issue", &json!({}), &m.ctx),
        vec![None]
    );
}
