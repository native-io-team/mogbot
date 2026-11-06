//! What each agent may do: upgrade, inheritance, presets, enforcement per
//! dimension, and proposals that only the user applies. Fixtures are
//! fictional (Hiring, Sales, "client-site").

use super::*;
use crate::agents::policy_card::{self as card, Proposal};
use serde_json::json;

fn agent(id: &str, name: &str) -> Agent {
    serde_json::from_value(json!({
        "id": id, "name": name, "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap()
}

fn chief() -> Agent {
    let mut a = agent("chief", "Chief of Staff");
    a.is_main = true;
    a
}

fn places() -> Places {
    Places {
        root: Some(PathBuf::from("/u/Projects")),
        external: vec![PathBuf::from("/x/outside-app")],
    }
}

fn work_dirs() -> Vec<String> {
    vec!["/u/Projects".into(), "/x/outside-app".into()]
}

const CLIENT: &str = "/u/Projects/client-site";
const MARKETING: &str = "/u/Projects/marketing-site";

fn eff_of(team: &Team, o: &Overrides, a: &Agent) -> Effective {
    resolve_with(team, o, a.is_main, Level::Judgement)
}

fn balanced() -> Effective {
    eff_of(
        &Preset::Balanced.team(),
        &Overrides::default(),
        &agent("h", "Hiring"),
    )
}

/* ------------------------------------------------------------ upgrade */

#[test]
fn the_upgrade_is_exactly_what_the_app_did_before() {
    let mut direct = agent("d", "Direct");
    direct.work_directly = true;
    direct.project = Some(CLIENT.into());
    let mut no_browser = agent("n", "No Browser");
    no_browser.reach.browser_off = true;
    let plain = agent("p", "Plain");
    let saved = migrate(&[direct.clone(), no_browser.clone(), plain.clone()]);

    // Balanced is the old behaviour: every project, own copy, the others directly.
    assert_eq!(saved.team, Preset::Balanced.team());
    assert_eq!(saved.team.projects.how, How::Copy);
    assert_eq!(saved.team.projects.elsewhere, Elsewhere::Change);
    assert!(saved.team.browser);
    assert_eq!(saved.team.apps.mode, AppsMode::All);
    assert!(!saved.agents.contains_key("p"), "nothing of its own");

    let d = resolve(&saved, &direct, Level::Judgement);
    assert_eq!(d.projects.how, How::Direct, "work directly kept");
    let n = resolve(&saved, &no_browser, Level::Judgement);
    assert!(!n.browser, "a removed browser stays removed");

    // Nothing wider than before: an unbound agent gets the same folders.
    let p = resolve(&saved, &plain, Level::Judgement);
    let dirs = turn_dirs(&p, &plain, &places(), work_dirs(), false);
    assert_eq!(dirs.add_dirs, work_dirs());
    assert!(dirs.claude_deny.is_empty());
}

#[test]
fn the_first_load_writes_access_json_from_the_registry_once() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let a = store::create(store::NewAgent {
        name: "Hiring".into(),
        role: "Recruiting".into(),
        instructions: "Be kind.".into(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    store::update(&a.id, |x| x.reach.browser_off = true).unwrap();
    let first = load();
    assert!(dir.path().join(FILE).exists());
    assert_eq!(first.agents[&a.id].browser, Some(false));
    // Changing the registry later doesn't re-run the upgrade.
    store::update(&a.id, |x| x.reach.browser_off = false).unwrap();
    assert_eq!(load().agents[&a.id].browser, Some(false));
    // An unreadable file is kept aside and today's behaviour used.
    std::fs::write(dir.path().join(FILE), "{not json").unwrap();
    let again = load();
    assert_eq!(again.team, Preset::Balanced.team());
    assert!(dir.path().join("access.json.unreadable").exists());
    store::set_root_for_tests(None);
}

/* --------------------------------------------------------- inheritance */

#[test]
fn agents_inherit_the_team_until_they_have_their_own() {
    let mut saved = migrate(&[]);
    let hiring = agent("h", "Hiring");
    let sales = agent("s", "Sales");
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "s".into(),
        },
        &Change {
            browser: Some(true),
            add_rules: vec!["Only touch the marketing site".into()],
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    // Same as the team's browser: not stored as its own.
    assert_eq!(saved.agents["s"].browser, None);
    apply(
        &mut saved,
        &Target::Team { everyone: false },
        &Change {
            browser: Some(false),
            add_rules: vec!["Never email clients".into()],
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    let h = resolve(&saved, &hiring, Level::Judgement);
    let s = resolve(&saved, &sales, Level::Judgement);
    assert!(!h.browser && !s.browser, "both follow the team");
    assert_eq!(h.rules().collect::<Vec<_>>(), vec!["Never email clients"]);
    assert_eq!(
        s.rules().collect::<Vec<_>>(),
        vec!["Never email clients", "Only touch the marketing site"],
        "rules add up: the team's, then its own"
    );
    // Its own value wins over the team's.
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            browser: Some(true),
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    assert!(resolve(&saved, &hiring, Level::Judgement).browser);
    assert_eq!(
        resolve(&saved, &hiring, Level::Judgement).own,
        vec!["browser"]
    );
    // Independence: the team's from independence.json unless its own.
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            independence: Some("often".into()),
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    assert_eq!(
        resolve(&saved, &hiring, Level::GoHard).independence,
        Level::Often
    );
    assert_eq!(
        resolve(&saved, &sales, Level::GoHard).independence,
        Level::GoHard
    );
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            independence: Some("team".into()),
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    assert_eq!(
        resolve(&saved, &hiring, Level::GoHard).independence,
        Level::GoHard
    );
    // Admin: the Chief by default.
    assert!(resolve(&saved, &chief(), Level::Judgement).admin);
    assert!(!h.admin);
}

#[test]
fn the_team_rule_isnt_removed_from_one_agent() {
    let mut saved = migrate(&[]);
    saved.team.rules.push("Never email clients".into());
    let err = apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            remove_rules: vec!["never email clients".into()],
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap_err();
    assert!(err.contains("the team's"));
}

/* ------------------------------------------------------------- presets */

#[test]
fn presets_reset_everyone_and_make_one_like_another() {
    let mut saved = migrate(&[]);
    let hiring = agent("h", "Hiring");
    let sales = agent("s", "Sales");
    // Sales locked down, Hiring an admin with its own browser.
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "s".into(),
        },
        &Change {
            preset: Some(Preset::Locked),
            add_rules: vec!["Ask before posting".into()],
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            admin: Some(true),
            browser: Some(false),
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    let s = resolve(&saved, &sales, Level::Judgement);
    assert_eq!(Preset::matching(&s), Some(Preset::Locked));
    assert_eq!(s.apps.mode, AppsMode::None);
    assert!(!s.browser);
    assert_eq!(s.independence, Level::Often);

    // Make Hiring like Sales: Sales's settings (and rules), Hiring's admin role.
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            like: Some("s".into()),
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    let h = resolve(&saved, &hiring, Level::Judgement);
    assert_eq!(Preset::matching(&h), Some(Preset::Locked));
    assert!(h.admin, "admin isn't copied away");
    assert_eq!(h.own_rules, vec!["Ask before posting"]);

    // Reset everyone to "I trust my agents".
    let level = apply(
        &mut saved,
        &Target::Team { everyone: true },
        &Change {
            preset: Some(Preset::Trusted),
            ..Default::default()
        },
        Level::Judgement,
    )
    .unwrap();
    assert_eq!(
        level,
        Some(Level::GoHard),
        "the team's level is returned to write"
    );
    for a in [&hiring, &sales] {
        let e = resolve(&saved, a, Level::GoHard);
        assert_eq!(Preset::matching(&e), Some(Preset::Trusted), "{}", a.name);
        assert!(e.own_rules.is_empty());
    }
    assert!(
        resolve(&saved, &hiring, Level::GoHard).admin,
        "admin kept through a reset"
    );

    // "Everyone" with one field resets just that field.
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "s".into(),
        },
        &Change {
            browser: Some(false),
            apps: Some(AppsMode::None),
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    apply(
        &mut saved,
        &Target::Team { everyone: true },
        &Change {
            browser: Some(true),
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    let s = resolve(&saved, &sales, Level::GoHard);
    assert!(s.browser);
    assert_eq!(
        s.apps.mode,
        AppsMode::None,
        "its other settings stay its own"
    );

    // Same as the team: everything of its own goes but the admin role.
    apply(
        &mut saved,
        &Target::Agent {
            agent_id: "h".into(),
        },
        &Change {
            same_as_team: true,
            ..Default::default()
        },
        Level::GoHard,
    )
    .unwrap();
    assert_eq!(
        saved.agents["h"],
        Overrides {
            admin: Some(true),
            ..Default::default()
        }
    );
}

#[test]
fn reset_and_set_write_through_and_keep_the_mirrors_in_step() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let a = store::create(store::NewAgent {
        name: "Hiring".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let agents = store::list().unwrap();
    set(
        &Target::Team { everyone: true },
        &Change {
            preset: Some(Preset::Locked),
            ..Default::default()
        },
        &agents,
    )
    .unwrap();
    let after = store::get(&a.id).unwrap();
    assert!(after.reach.browser_off, "browser mirror");
    assert!(after.work_directly, "not in a copy: read-only");
    assert_eq!(super::super::independence::level(), Level::Often);
    set(
        &Target::Team { everyone: true },
        &Change {
            preset: Some(Preset::Balanced),
            ..Default::default()
        },
        &agents,
    )
    .unwrap();
    let after = store::get(&a.id).unwrap();
    assert!(!after.reach.browser_off);
    assert!(!after.work_directly);
    set_browser(&a.id, false).unwrap();
    assert!(store::get(&a.id).unwrap().reach.browser_off);
    assert_eq!(load().agents[&a.id].browser, Some(false));
    set_direct(&a.id, true).unwrap();
    assert!(store::get(&a.id).unwrap().work_directly);
    assert_eq!(
        load().agents[&a.id].projects.as_ref().unwrap().how,
        How::Direct
    );
    // Admin is the Admin role's own switch on the agent: handed over, not kept here.
    set(
        &Target::Agent {
            agent_id: a.id.clone(),
        },
        &Change {
            admin: Some(true),
            ..Default::default()
        },
        &store::list().unwrap(),
    )
    .unwrap();
    assert!(super::super::admin::is_admin(&store::get(&a.id).unwrap()));
    assert!(load().agents.get(&a.id).is_none_or(|o| o.admin.is_none()));
    store::set_root_for_tests(None);
}

/* --------------------------------------------------------- enforcement */

#[test]
fn projects_decide_the_folders_a_turn_may_write() {
    let mut hiring = agent("h", "Hiring");
    hiring.project = Some(CLIENT.into());
    let team = Preset::Balanced.team();

    // Listed: only those, never the whole projects folder.
    let listed = Overrides {
        projects: Some(Projects {
            scope: Scope::Listed,
            listed: vec![CLIENT.into(), MARKETING.into()],
            how: How::Copy,
            elsewhere: Elsewhere::Change,
        }),
        ..Default::default()
    };
    let e = eff_of(&team, &listed, &hiring);
    let d = turn_dirs(&e, &hiring, &places(), work_dirs(), true);
    assert_eq!(
        d.add_dirs,
        vec![MARKETING.to_string()],
        "its own original is read in place; the other listed one changes"
    );
    assert_eq!(d.claude_deny, vec![format!("Edit(/{CLIENT}/**)")]);

    // None: no projects at all, and a bound one can't run.
    let none = Overrides {
        projects: Some(Projects {
            scope: Scope::None,
            ..team.projects.clone()
        }),
        ..Default::default()
    };
    let e = eff_of(&team, &none, &hiring);
    assert!(turn_dirs(&e, &hiring, &places(), work_dirs(), false)
        .add_dirs
        .is_empty());
    assert!(own_refusal(&e, &hiring).unwrap().contains("client-site"));

    // Read-only in its own: its working folder can't be edited (Claude) or written (Codex).
    let ro = Overrides {
        projects: Some(Projects {
            how: How::ReadOnly,
            ..team.projects.clone()
        }),
        ..Default::default()
    };
    let e = eff_of(&team, &ro, &hiring);
    let d = turn_dirs(&e, &hiring, &places(), work_dirs(), false);
    assert_eq!(d.claude_deny, vec![format!("Edit(/{CLIENT}/**)")]);
    assert_eq!(d.read_only, vec![PathBuf::from(CLIENT)]);

    // Directly: nothing kept back.
    let direct = Overrides {
        projects: Some(Projects {
            how: How::Direct,
            ..team.projects.clone()
        }),
        ..Default::default()
    };
    let d = turn_dirs(
        &eff_of(&team, &direct, &hiring),
        &hiring,
        &places(),
        work_dirs(),
        false,
    );
    assert!(d.claude_deny.is_empty() && d.read_only.is_empty());
    assert_eq!(d.add_dirs, work_dirs());

    // Read elsewhere: the projects folder isn't writable; folders it may change are.
    let read = Overrides {
        projects: Some(Projects {
            elsewhere: Elsewhere::Read,
            ..team.projects.clone()
        }),
        folders: Some(vec![
            Folder {
                path: "/u/me/Invoices".into(),
                write: true,
            },
            Folder {
                path: "/u/me/Docs".into(),
                write: false,
            },
        ]),
        ..Default::default()
    };
    let d = turn_dirs(
        &eff_of(&team, &read, &hiring),
        &hiring,
        &places(),
        work_dirs(),
        true,
    );
    assert_eq!(d.add_dirs, vec!["/u/me/Invoices".to_string()]);
}

#[test]
fn the_broker_refuses_projects_and_folders_outside_the_policy() {
    let hiring = agent("h", "Hiring");
    let team = Preset::Balanced.team();
    let o = Overrides {
        projects: Some(Projects {
            scope: Scope::Listed,
            listed: vec![MARKETING.into()],
            how: How::Copy,
            elsewhere: Elsewhere::Read,
        }),
        folders: Some(vec![
            Folder {
                path: "/u/me/Docs".into(),
                write: false,
            },
            Folder {
                path: "/u/me/Invoices".into(),
                write: true,
            },
        ]),
        ..Default::default()
    };
    let e = eff_of(&team, &o, &hiring);
    let v = |tool: &str, path: &str| {
        verdict(&e, &hiring, &places(), tool, &json!({ "file_path": path }))
    };
    assert!(
        matches!(v("Read", "/u/Projects/client-site/index.html"), Some(Verdict::Deny(m)) if m.contains("client-site") && m.contains("propose_settings_change"))
    );
    assert_eq!(
        v("Read", "/u/Projects/marketing-site/index.html"),
        Some(Verdict::Allow)
    );
    assert!(
        matches!(v("Edit", "/u/Projects/marketing-site/index.html"), Some(Verdict::Deny(m)) if m.contains("read"))
    );
    assert!(matches!(
        v("Write", "/x/outside-app/a.txt"),
        Some(Verdict::Deny(_))
    ));
    // A copy of a project it may not use is that project.
    assert!(matches!(
        v("Read", "/u/Projects/.worktrees/client-site/h-x/a"),
        Some(Verdict::Deny(_))
    ));
    assert_eq!(v("Grep", "/u/me/Docs/notes.md"), Some(Verdict::Allow));
    assert!(matches!(
        v("Edit", "/u/me/Docs/notes.md"),
        Some(Verdict::Deny(_))
    ));
    assert_eq!(
        v("Write", "/u/me/Invoices/q3.csv"),
        None,
        "writable: the usual rules"
    );
    assert_eq!(v("Read", "/etc/hosts"), None, "elsewhere: the usual card");
    assert_eq!(
        v("Bash", "/u/Projects/client-site"),
        None,
        "commands ask on cards as before"
    );
    // Its own copy is never asked about.
    let mut bound = hiring.clone();
    bound.copy = Some(serde_json::from_value(json!({
        "project": MARKETING, "path": "/u/Projects/.worktrees/marketing-site/h-1", "branch": "hiring/x-1",
        "id": "c1", "base": "abc", "createdAt": 0
    })).unwrap());
    assert_eq!(
        verdict(
            &e,
            &bound,
            &places(),
            "Edit",
            &json!({ "file_path": "/u/Projects/.worktrees/marketing-site/h-1/a" })
        ),
        None
    );
}

#[test]
fn apps_and_the_browser_are_refused_at_the_broker() {
    let hiring = agent("h", "Hiring");
    let team = Preset::Balanced.team();
    let only = Overrides {
        apps: Some(Apps {
            mode: AppsMode::Only,
            only: vec!["Linear".into()],
        }),
        browser: Some(false),
        ..Default::default()
    };
    let e = eff_of(&team, &only, &hiring);
    let v = |tool: &str| verdict(&e, &hiring, &places(), tool, &json!({}));
    assert!(
        matches!(v("mcp__claude_ai_Gmail__send"), Some(Verdict::Deny(m)) if m.contains("Gmail"))
    );
    assert_eq!(
        v("mcp__linear__create_issue"),
        None,
        "allowed: still asks on its card as before"
    );
    assert!(
        matches!(v("mcp__claude-in-chrome__navigate"), Some(Verdict::Deny(m)) if m.contains("browser"))
    );
    assert_eq!(
        v(&format!(
            "mcp__{}__list_agents",
            super::super::prompts::SERVER_KEY
        )),
        None,
        "its own tools are never kept from it"
    );
    assert!(app_allowed(&e.apps, &["claude.ai Linear"]));
    assert!(!app_allowed(
        &Apps {
            mode: AppsMode::None,
            only: vec![]
        },
        &["linear"]
    ));
    assert!(app_allowed(&Preset::Trusted.team().apps, &["anything"]));
}

#[test]
fn the_relay_follows_the_policy() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    assert!(connection_allowed("h", "gmail", "Gmail"));
    modify(|s| {
        s.agents.insert(
            "h".into(),
            Overrides {
                apps: Some(Apps {
                    mode: AppsMode::Only,
                    only: vec!["linear".into()],
                }),
                ..Default::default()
            },
        );
        Ok(())
    })
    .unwrap();
    assert!(!connection_allowed("h", "gmail", "Gmail"));
    assert!(connection_allowed("h", "linear", "Linear"));
    assert!(
        connection_allowed("other", "gmail", "Gmail"),
        "others keep the team's"
    );
    store::set_root_for_tests(None);
}

#[test]
fn project_tools_refuse_what_it_may_only_look_at() {
    let mut hiring = agent("h", "Hiring");
    hiring.project = Some(MARKETING.into());
    let team = Preset::Balanced.team();
    let o = Overrides {
        projects: Some(Projects {
            scope: Scope::Listed,
            listed: vec![MARKETING.into()],
            how: How::Copy,
            elsewhere: Elsewhere::Read,
        }),
        ..Default::default()
    };
    let e = eff_of(&team, &o, &hiring);
    assert!(
        session_refusal(&e, &hiring, "session_message", Some(CLIENT))
            .unwrap()
            .contains("client-site")
    );
    assert!(
        session_refusal(&e, &hiring, "git_status", Some(CLIENT)).is_some(),
        "off: nothing at all"
    );
    assert!(session_refusal(&e, &hiring, "push", Some(MARKETING))
        .unwrap()
        .contains("your own copy"));
    assert_eq!(
        session_refusal(&e, &hiring, "preview_screenshot", Some(MARKETING)),
        None
    );
    assert!(session_refusal(&e, &hiring, "project_create", None).is_some());
    let b = balanced();
    assert_eq!(
        session_refusal(&b, &agent("x", "X"), "push", Some(CLIENT)),
        None,
        "Balanced: as before"
    );
    assert_eq!(
        session_refusal(&b, &agent("x", "X"), "project_create", None),
        None
    );
}

#[test]
fn rules_and_the_way_to_change_them_are_in_the_prompt() {
    let hiring = agent("h", "Hiring");
    let mut team = Preset::Balanced.team();
    team.rules.push("Never email clients".into());
    let o = Overrides {
        rules: vec!["Only touch the marketing site".into()],
        ..Default::default()
    };
    let e = eff_of(&team, &o, &hiring);
    let p = prompt_section(&e, &hiring);
    assert!(p.contains("- Never email clients\n- Only touch the marketing site"));
    assert!(p.contains("propose_settings_change"));
    assert!(p.contains("Never tell them to go to Settings"));
    assert!(p.contains("for yourself only"));
    assert!(
        prompt_section(&eff_of(&team, &Overrides::default(), &chief()), &chief())
            .contains("As an admin")
    );
    // Fixed per policy: the prompt cache holds.
    assert_eq!(p, prompt_section(&e, &hiring));
    assert!(!p.chars().any(|c| c.is_ascii_digit()));
}

#[test]
fn lines_say_which_the_app_enforces() {
    let lines = describe(&balanced(), None);
    let by: Vec<(&str, &str)> = lines.iter().map(|l| (l.key, l.enforced)).collect();
    assert!(by.contains(&("projects", "app")));
    assert!(by.contains(&("browser", "app")));
    assert!(by.contains(&("rules", "prompt")));
    assert!(by.contains(&("independence", "prompt")));
    assert!(lines.iter().all(|l| l.team));
}

#[test]
fn folders_are_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let ok = clean_folder(&tmp.path().to_string_lossy()).unwrap();
    assert!(Path::new(&ok).is_dir());
    assert!(clean_folder("/").is_err());
    assert!(clean_folder("/System/Library").is_err());
    assert!(clean_folder("relative/path").is_err());
    assert!(clean_folder("/no/such/folder/anywhere").is_err());
}

/* ------------------------------------------------------------ proposals */

fn hiring_bound() -> Agent {
    let mut h = agent("h", "Hiring");
    h.project = Some(CLIENT.into());
    h
}

fn listed_marketing(saved: &mut Saved) {
    saved.agents.insert(
        "h".into(),
        Overrides {
            projects: Some(Projects {
                scope: Scope::Listed,
                listed: vec![MARKETING.into()],
                how: How::Copy,
                elsewhere: Elsewhere::Change,
            }),
            ..Default::default()
        },
    );
}

#[test]
fn a_proposal_says_the_change_in_plain_words() {
    let mut saved = migrate(&[]);
    listed_marketing(&mut saved);
    let mut hiring = agent("h", "Hiring");
    hiring.project = Some(MARKETING.into());
    let agents = vec![chief(), hiring.clone()];
    let p: Proposal = card::build(
        &chief(),
        true,
        vec![Target::Agent {
            agent_id: "h".into(),
        }],
        Change {
            add_projects: vec![CLIENT.into()],
            browser: Some(false),
            ..Default::default()
        },
        Some("The user wants Hiring on the client's site".into()),
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert_eq!(
        card::summary(&p.groups),
        "Hiring: Can now work in client-site (its own copy). Can no longer use your browser."
    );
    assert_eq!(
        card::title(&p.targets, &agents),
        "Change Hiring's settings?"
    );
    assert_eq!(p.version, saved.version);
}

#[test]
fn only_admins_propose_for_others_and_nobody_proposes_their_own_admin() {
    let saved = migrate(&[]);
    let hiring = agent("h", "Hiring");
    let sales = agent("s", "Sales");
    let agents = vec![chief(), hiring.clone(), sales.clone()];
    let off = Change {
        browser: Some(false),
        ..Default::default()
    };
    let b = |caller: &Agent, admin: bool, t: Vec<Target>, c: Change| {
        card::build(caller, admin, t, c, None, &saved, &agents, Level::Judgement)
    };
    // For itself: fine.
    assert!(b(
        &hiring,
        false,
        vec![Target::Agent {
            agent_id: "h".into()
        }],
        off.clone()
    )
    .is_ok());
    // For another agent, or the team: admins only.
    assert!(b(
        &hiring,
        false,
        vec![Target::Agent {
            agent_id: "s".into()
        }],
        off.clone()
    )
    .unwrap_err()
    .contains("admin"));
    assert!(b(
        &hiring,
        false,
        vec![Target::Team { everyone: true }],
        off.clone()
    )
    .is_err());
    assert!(b(
        &chief(),
        true,
        vec![Target::Agent {
            agent_id: "s".into()
        }],
        off.clone()
    )
    .is_ok());
    // Its own admin role isn't its to propose.
    assert!(b(
        &hiring,
        false,
        vec![Target::Agent {
            agent_id: "h".into()
        }],
        Change {
            admin: Some(true),
            ..Default::default()
        }
    )
    .is_err());
    // Nothing would change: no card.
    assert!(b(
        &hiring,
        false,
        vec![Target::Agent {
            agent_id: "h".into()
        }],
        Change {
            browser: Some(true),
            ..Default::default()
        }
    )
    .unwrap_err()
    .contains("already"));
    // Targets: names, "team", "everyone"; not mixed.
    assert_eq!(
        card::parse_targets(&hiring, &[]).unwrap(),
        vec![Target::Agent {
            agent_id: "h".into()
        }]
    );
    assert_eq!(
        card::parse_targets(&hiring, &["everyone".into()]).unwrap(),
        vec![Target::Team { everyone: true }]
    );
}

#[test]
fn outside_text_never_proposes() {
    assert!(card::outside_refusal(true).unwrap().contains("outside"));
    assert_eq!(card::outside_refusal(false), None);
}

#[test]
fn a_change_that_strands_work_is_refused_first() {
    let mut saved = migrate(&[]);
    let mut hiring = hiring_bound();
    hiring.copy = Some(serde_json::from_value(json!({
        "project": CLIENT, "path": "/u/Projects/.worktrees/client-site/h-1", "branch": "hiring/x-1",
        "id": "c1", "base": "abc", "createdAt": 0
    })).unwrap());
    let agents = vec![chief(), hiring.clone()];
    let err = card::build(
        &chief(),
        true,
        vec![Target::Agent {
            agent_id: "h".into(),
        }],
        Change {
            how: Some(How::Direct),
            ..Default::default()
        },
        None,
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap_err();
    assert!(err.contains("Keep or discard"));
    hiring.copy = None;
    let agents = vec![chief(), hiring.clone()];
    listed_marketing(&mut saved);
    let mut h2 = hiring.clone();
    h2.project = Some(MARKETING.into());
    let err = card::build(
        &chief(),
        true,
        vec![Target::Agent {
            agent_id: "h".into(),
        }],
        Change {
            remove_projects: vec![MARKETING.into()],
            ..Default::default()
        },
        None,
        &saved,
        &[chief(), h2],
        Level::Judgement,
    )
    .unwrap_err();
    assert!(err.contains("marketing-site"));
    let _ = agents;
}

#[test]
fn a_reset_card_groups_agents_changed_the_same_way() {
    let mut saved = migrate(&[]);
    let mut sales = agent("s", "Sales");
    sales.project = None;
    saved.agents.insert(
        "s".into(),
        Overrides {
            browser: Some(false),
            ..Default::default()
        },
    );
    let agents = vec![chief(), agent("h", "Hiring"), sales];
    let p = card::build(
        &chief(),
        true,
        vec![Target::Team { everyone: true }],
        Change {
            preset: Some(Preset::Locked),
            ..Default::default()
        },
        None,
        &saved,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    let s = card::summary(&p.groups);
    assert!(s.starts_with("Chief of Staff and Hiring: "), "{s}");
    assert!(s.contains("Can no longer use your browser"));
    assert!(
        s.contains("\nSales: "),
        "Sales had no browser already: its own line: {s}"
    );
    assert!(s.contains("Independence: Check with me often (was Use good judgement)"));
}

#[test]
fn nothing_changes_until_the_user_allows_and_a_stale_card_applies_nothing() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let main = super::super::ensure_main().unwrap();
    let hiring = store::create(store::NewAgent {
        name: "Hiring".into(),
        role: String::new(),
        instructions: String::new(),
        shape: None,
        avatar: None,
        color: None,
        is_main: false,
    })
    .unwrap();
    let before = load();
    let agents = store::list().unwrap();
    let p = card::build(
        &main,
        true,
        vec![Target::Agent {
            agent_id: hiring.id.clone(),
        }],
        Change {
            browser: Some(false),
            add_rules: vec!["Never email clients".into()],
            ..Default::default()
        },
        None,
        &before,
        &agents,
        Level::Judgement,
    )
    .unwrap();
    assert!(p.has_rules);
    // Proposing wrote nothing.
    assert_eq!(load(), before);
    assert!(effective(&hiring).browser);
    // Allow applies exactly that.
    card::apply_proposal(&p).unwrap();
    let h = effective(&store::get(&hiring.id).unwrap());
    assert!(!h.browser);
    assert_eq!(h.own_rules, vec!["Never email clients"]);
    assert!(store::get(&hiring.id).unwrap().reach.browser_off);
    // The same card again: the settings moved on since, so nothing.
    let err = card::apply_proposal(&p).unwrap_err();
    assert!(err.contains("changed after"));
    store::set_root_for_tests(None);
}

#[test]
fn changes_parse_from_the_tool() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let c = rt
        .block_on(card::parse_change(&json!({
            "preset": "locked",
            "browser": true,
            "independence": "go_hard",
            "apps": { "mode": "only", "add": ["Linear"] },
            "rules": { "add": ["Never email clients"] }
        })))
        .unwrap();
    assert_eq!(c.preset, Some(Preset::Locked));
    assert_eq!(c.browser, Some(true));
    assert_eq!(c.apps, Some(AppsMode::Only));
    assert_eq!(c.add_apps, vec!["Linear"]);
    assert!(rt.block_on(card::parse_change(&json!({}))).is_err());
    assert!(rt
        .block_on(card::parse_change(&json!({ "independence": "yolo" })))
        .is_err());
    assert!(rt
        .block_on(card::parse_change(
            &json!({ "projects": { "how": "sideways" } })
        ))
        .is_err());
    assert!(rt
        .block_on(card::parse_change(
            &json!({ "folders": { "add": [{ "path": "/" }] } })
        ))
        .is_err());
}

#[test]
fn an_agents_own_level_and_the_outside_cap() {
    let _serial = store::tests_lock();
    let dir = tempfile::tempdir().unwrap();
    store::set_root_for_tests(Some(dir.path().to_path_buf()));
    let h = agent("h", "Hiring");
    modify(|s| {
        s.agents.insert(
            "h".into(),
            Overrides {
                independence: Some(Level::GoHard),
                ..Default::default()
            },
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(independence_for(&h, false), Level::GoHard);
    assert_eq!(
        independence_for(&h, true),
        Level::Judgement,
        "outside text never goes hard"
    );
    assert_eq!(
        independence_for(&agent("s", "Sales"), false),
        Level::Judgement
    );
    store::set_root_for_tests(None);
}

/// "Its own copy" says where it works by default; at "Go hard" it never
/// stops an edit in its own project or a worktree of it. Read only, and
/// "Use good judgement", stay as they were. (Fictional folders.)
#[test]
fn working_in_a_copy_never_stops_an_edit_at_go_hard() {
    let _serial = super::super::store::tests_lock();
    let root = tempfile::tempdir().unwrap();
    super::super::store::set_root_for_tests(Some(root.path().to_path_buf()));
    let mut ms = agent("ms", "Memberstack");
    ms.project = Some(MARKETING.into());
    let team = Preset::Balanced.team();
    let e = eff_of(&team, &Overrides::default(), &ms);
    let edit = |path: &str| verdict(&e, &ms, &places(), "Edit", &json!({ "file_path": path }));
    let in_place = format!("{MARKETING}/src/index.html");
    let worktree = format!("{MARKETING}/.claude/worktrees/agent-a1/src/index.html");
    super::super::independence::set_level(Level::Judgement, 1).unwrap();
    assert!(matches!(edit(&in_place), Some(Verdict::Deny(_))));
    super::super::independence::set_level(Level::GoHard, 2).unwrap();
    assert_eq!(edit(&in_place), None, "the usual rules at Go hard");
    assert_eq!(edit(&worktree), None, "the usual rules at Go hard");
    // Read only is read only, whatever the level.
    let locked = Overrides {
        projects: Some(Projects {
            scope: Scope::All,
            listed: Vec::new(),
            how: How::ReadOnly,
            elsewhere: Elsewhere::Change,
        }),
        ..Default::default()
    };
    let e = eff_of(&team, &locked, &ms);
    assert!(matches!(
        verdict(
            &e,
            &ms,
            &places(),
            "Edit",
            &json!({ "file_path": in_place })
        ),
        Some(Verdict::Deny(_))
    ));
    super::super::store::set_root_for_tests(None);
}
