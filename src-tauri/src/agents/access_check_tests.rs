use super::*;

// A fictional import: twelve agents from another assistant, forty logins
// between them, over fourteen services.
fn forty() -> LaterBook {
    let services = [
        ("github_token", "Opens PRs"),
        ("figma", "Exports frames"),
        ("gmail_work", "Reads and replies to email"),
        ("google_calendar", "Books meetings"),
        ("slack", "Posts the standup"),
        ("linear", "Files issues"),
        ("notion", "Writes the wiki"),
        ("linkedin", "Screens candidates"),
        ("x_api", "Posts updates"),
        ("vercel", "Checks deploys"),
        ("stripe_key", "Reads invoices"),
        ("bankline", "Downloads statements"),
        ("google_drive", "Files contracts"),
        ("quarry_crm", "Logs calls"),
    ];
    let mut book = LaterBook::default();
    let mut n = 0;
    'outer: for round in 0..4 {
        for (i, (name, purpose)) in services.iter().enumerate() {
            if n == 40 {
                break 'outer;
            }
            let agent = format!("agent-{}", (i + round * 3) % 12);
            let before = book.items.len();
            book.add(later_from(&agent, name, purpose, ""));
            if book.items.len() > before {
                n += 1;
            }
        }
    }
    book
}

fn name(id: &str) -> Option<String> {
    Some(format!("Agent {}", id.trim_start_matches("agent-")))
}

#[test]
fn forty_asks_become_one_row_per_service() {
    let book = forty();
    assert_eq!(book.items.len(), 40);
    let rows = book.groups(&name);
    assert_eq!(rows.len(), 14, "deduped team-wide by service");
    let figma = rows.iter().find(|r| r.key == "figma").unwrap();
    assert!(figma.agents.len() > 1, "several agents, one row");
    assert_eq!(figma.action.as_deref(), Some("Connect Figma"));
    // An app nothing here knows: a key is all there is, and it's said so.
    let bank = rows
        .iter()
        .find(|r| r.service == "other" && r.title == "Bankline")
        .unwrap();
    assert!(bank.key_only);
    // A site with no connector: the browser, not a field.
    let li = rows.iter().find(|r| r.key == "linkedin").unwrap();
    assert_eq!(li.action.as_deref(), Some("Use my browser"));
    assert!(!li.key_only);
}

#[test]
fn what_the_check_reaches_is_resolved_and_only_the_rest_is_left() {
    let mut book = forty();
    let keys: Vec<String> = book.groups(&name).into_iter().map(|g| g.key).collect();
    // The check reached eleven of the fourteen.
    let reached: Vec<Found> = keys
        .iter()
        .filter(|k| !["other:bankline", "other:quarry crm", "stripe"].contains(&k.as_str()))
        .map(|k| Found {
            key: k.clone(),
            via: "your browser, signed in".into(),
        })
        .collect();
    assert_eq!(reached.len(), 11);
    assert_eq!(resolve(&mut book, &reached), 11);
    let open: Vec<LaterGroup> = book
        .groups(&name)
        .into_iter()
        .filter(|g| g.state == LaterState::Open)
        .collect();
    assert_eq!(open.len(), 3, "40 asks → 3 left");
    // Running it again changes nothing, and a row the user decided stays.
    book.states.insert("stripe".into(), LaterState::NotNeeded);
    assert_eq!(resolve(&mut book, &reached), 0);
    assert_eq!(
        resolve(
            &mut book,
            &[Found {
                key: "stripe".into(),
                via: "x".into()
            }]
        ),
        0
    );
    assert_eq!(book.state("stripe"), LaterState::NotNeeded);
    // A finding for something nobody mentioned is ignored.
    assert_eq!(
        resolve(
            &mut book,
            &[Found {
                key: "dropbox".into(),
                via: "x".into()
            }]
        ),
        0
    );
}

#[test]
fn imported_logins_map_onto_services() {
    let l = later_from(
        "a",
        "gmail_work",
        "Reads email and sends replies",
        "password",
    );
    assert_eq!(l.service, "gmail");
    assert_eq!(l.title, "Gmail");
    assert!(l.writes);
    let k = later_from("a", "quarry_crm", "Logs calls", "api_key");
    assert_eq!(k.service, "other");
    assert_eq!(key_of(&k.service, &k.title), "other:quarry crm");
}

#[test]
fn claude_codes_apps_count_by_their_names_there() {
    let apps = vec![
        "claude.ai gmail".to_string(),
        "figma".to_string(),
        "sanity".to_string(),
    ];
    assert_eq!(app_for("gmail", &apps).as_deref(), Some("claude.ai gmail"));
    assert_eq!(app_for("figma", &apps).as_deref(), Some("figma"));
    assert_eq!(app_for("slack", &apps), None);
    assert_eq!(app_for("other", &apps), None);
}

#[test]
fn progress_reads_as_one_calm_line() {
    let mut v = CheckView {
        running: true,
        total: 14,
        ..Default::default()
    };
    assert_eq!(progress_line(&v), "Checking 14 services…");
    v.checked.push(Checked {
        title: "Figma".into(),
        reached: true,
    });
    v.checked.push(Checked {
        title: "Bankline".into(),
        reached: false,
    });
    assert_eq!(
        progress_line(&v),
        "Checking 14 services… Figma ✓ Bankline –"
    );
    assert_eq!(
        receipt("Figma", "your browser, signed in on www.figma.com"),
        "Figma: your browser, signed in on www.figma.com"
    );
}

fn env(project: &str, vars: &[&str]) -> ProjectEnv {
    ProjectEnv {
        project: project.into(),
        vars: vars.iter().map(|v| v.to_string()).collect(),
    }
}

#[test]
fn a_key_already_in_a_projects_env_counts_as_reached() {
    let names = vec!["tenspeed_supabase".to_string()];
    let envs = [
        env("memberstack-site", &["SUPABASE_URL"]),
        env("tenspeed", &["NEXT_PUBLIC_SUPABASE_URL", "OTHER"]),
    ];
    assert_eq!(
        env_hit("Tenspeed supabase", &names, &envs).as_deref(),
        Some("in tenspeed’s .env on this Mac (NEXT_PUBLIC_SUPABASE_URL)")
    );
    // A project named for it with nothing that names the service: not it.
    assert_eq!(
        env_hit("Tenspeed supabase", &names, &[env("tenspeed", &["PORT"])]),
        None
    );
    // Another project's Supabase isn't Tenspeed's.
    assert_eq!(
        env_hit(
            "Tenspeed supabase",
            &names,
            &[env("simmer", &["SUPABASE_URL"])]
        ),
        None
    );
    // The agent's own project: any word will do.
    assert!(env_hit(
        "Simmer anthropic key",
        &[],
        &[env("@recipes", &["ANTHROPIC_API_KEY"])]
    )
    .is_some());
    // Generic words never match on their own.
    assert_eq!(
        key_words("Spanish brain app passcode", &[]),
        vec!["spanish", "brain"]
    );
}

#[test]
fn keys_nothing_reached_wait_until_a_task_needs_them() {
    let mut book = LaterBook::default();
    book.add(later_from(
        "a",
        "tenspeed_supabase",
        "reads rows",
        "api_key",
    ));
    book.add(later_from("a", "figma", "exports", ""));
    let all = |id: &str| Some(id.to_string());
    assert_eq!(defer_key_only(&mut book, &all), 1);
    assert_eq!(
        book.state("other:tenspeed supabase"),
        LaterState::WhenNeeded
    );
    assert_eq!(
        book.state("figma"),
        LaterState::Open,
        "a sign-in is still offered"
    );
    // The user's own answer is never overwritten.
    book.states
        .insert("other:tenspeed supabase".into(), LaterState::NotNeeded);
    assert_eq!(defer_key_only(&mut book, &all), 0);
}
