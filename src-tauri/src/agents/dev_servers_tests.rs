use super::*;

fn server(port: u16, cwd: &str) -> Server {
    Server {
        agent_id: "a1".into(),
        root: 100,
        command: "npm run dev".into(),
        port,
        cwd: cwd.into(),
        last_watched: 0,
    }
}

fn row(pid: u32, ppid: u32, command: &str) -> ProcRow {
    ProcRow {
        pid,
        ppid,
        cpu: 0.0,
        zombie: false,
        command: command.into(),
    }
}

#[test]
fn nobody_looking_and_nothing_shown_stops_at_the_turns_end() {
    let s = server(3400, "/Users/test/ShipStudio/bakery");
    assert!(!keep_at_turn_end(&s, &Shown::default(), false));
}

#[test]
fn a_server_the_turn_showed_or_someone_watches_is_kept() {
    let s = server(3400, "/Users/test/ShipStudio/bakery/apps/web");
    // Linked in a reply.
    let mut shown = Shown::default();
    shown.ports.insert(3400);
    assert!(keep_at_turn_end(&s, &shown, false));
    // Its project named on the card.
    let shown = Shown {
        paths: vec!["/Users/test/ShipStudio/bakery".into()],
        ..Shown::default()
    };
    assert!(keep_at_turn_end(&s, &shown, false));
    // A sibling folder isn't the same project.
    let shown = Shown {
        paths: vec!["/Users/test/ShipStudio/bake".into()],
        ..Shown::default()
    };
    assert!(!keep_at_turn_end(&s, &shown, false));
    // Watched.
    assert!(keep_at_turn_end(&s, &Shown::default(), true));
}

#[test]
fn watched_means_a_pane_on_its_folder_or_a_recent_phone() {
    let s = server(3400, "/Users/test/ShipStudio/bakery");
    let now = 10 * 60_000;
    assert!(is_watched(
        &s,
        &["/Users/test/ShipStudio/bakery".into()],
        None,
        now
    ));
    assert!(!is_watched(
        &s,
        &["/Users/test/ShipStudio/other".into()],
        None,
        now
    ));
    assert!(is_watched(&s, &[], Some(now - 30_000), now));
    assert!(!is_watched(&s, &[], Some(now - 5 * 60_000), now));
}

#[test]
fn idle_for_ten_minutes_is_due_to_stop() {
    assert!(!idle_due(0, IDLE_MS - 1));
    assert!(idle_due(0, IDLE_MS));
}

#[test]
fn listeners_are_read_from_lsof() {
    let raw = "p501\nn*:3400\nn[::1]:3400\np777\nn127.0.0.1:5173\n";
    assert_eq!(parse_listeners(raw), vec![(501, 3400), (777, 5173)]);
    assert!(parse_listeners("").is_empty());
}

#[test]
fn group_members_leave_out_the_leader() {
    let raw = "  10    10\n  11    10\n  12    99\n  13    10\n";
    assert_eq!(parse_group(raw, 10), vec![11, 13]);
}

#[test]
fn a_server_is_stopped_from_the_top_process_that_was_the_turns() {
    // claude(1) → sh(2) → npm(3) → node(4, listening)
    let rows = vec![
        row(1, 0, "claude"),
        row(2, 1, "sh"),
        row(3, 2, "npm run dev"),
        row(4, 3, "node next dev"),
    ];
    let ours: HashSet<u32> = [2, 3, 4].into_iter().collect();
    assert_eq!(root_of(&rows, 4, &ours), 2);
    // Orphaned (its shell gone): the server's own top.
    let rows = vec![row(3, 1, "npm run dev"), row(4, 3, "node next dev")];
    let ours: HashSet<u32> = [3, 4].into_iter().collect();
    assert_eq!(root_of(&rows, 4, &ours), 3);
}

#[test]
fn a_kept_server_answers_for_its_folder_only() {
    {
        let mut s = state();
        s.servers.retain(|k| k.port != 4999);
        s.servers
            .push(server(4999, "/Users/test/ShipStudio/kept-site/web"));
    }
    assert!(serves("/Users/test/ShipStudio/kept-site", 4999));
    assert!(!serves("/Users/test/ShipStudio/kept-site", 4998));
    assert!(!serves("/Users/test/ShipStudio/other", 4999));
    assert_eq!(
        path_on(4999).as_deref(),
        Some("/Users/test/ShipStudio/kept-site/web")
    );
    state().servers.retain(|k| k.port != 4999);
}

#[test]
fn what_runs_under_the_engine_is_noted_per_turn() {
    let rows = vec![
        row(50, 1, "claude"),
        row(51, 50, "sh -c npm run dev"),
        row(60, 1, "someone else's server"),
    ];
    begin("a-noted");
    note_tree("a-noted", &rows, 50);
    let seen = state().seen.get("a-noted").cloned().unwrap_or_default();
    assert!(seen.contains_key(&51));
    assert!(!seen.contains_key(&60));
    begin("a-noted");
    assert!(state().seen.get("a-noted").is_none());
}
