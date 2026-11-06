use super::*;

fn site(port: u16) -> Option<Known> {
    match port {
        3400 => Some(Known {
            path: "/Users/test/ShipStudio/bakery".into(),
            project: "/Users/test/ShipStudio/bakery".into(),
            copy: false,
        }),
        3401 => Some(Known {
            path: "/Users/test/ShipStudio/.worktrees/bakery-1".into(),
            project: "/Users/test/ShipStudio/bakery".into(),
            copy: true,
        }),
        _ => None,
    }
}

#[test]
fn a_line_of_before_and_after_links_becomes_two_chips_and_leaves_the_text() {
    let (text, links) = rewrite(
        "Both are up.\n[before](http://localhost:3400) [after](http://localhost:3401)",
        site,
    );
    assert_eq!(text, "Both are up.");
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].label, "before");
    assert_eq!(links[0].port, 3400);
    assert_eq!(
        links[0].path.as_deref(),
        Some("/Users/test/ShipStudio/bakery")
    );
    assert!(!links[0].copy);
    assert_eq!(links[1].label, "after");
    assert!(links[1].copy);
    assert_eq!(
        links[1].project.as_deref(),
        Some("/Users/test/ShipStudio/bakery")
    );
}

#[test]
fn a_link_in_a_sentence_keeps_its_words() {
    let (text, links) = rewrite(
        "The [new pricing page](http://127.0.0.1:3400/pricing) is ready.",
        site,
    );
    assert_eq!(text, "The new pricing page is ready.");
    assert_eq!(links[0].url, "http://127.0.0.1:3400/pricing");
    assert_eq!(links[0].label, "new pricing page");
}

#[test]
fn a_bare_address_reads_as_the_preview_below() {
    let (text, links) = rewrite("It's running at http://localhost:3400.", site);
    assert_eq!(text, "It's running at the preview below.");
    assert_eq!(links[0].url, "http://localhost:3400");
    assert_eq!(links[0].label, "localhost:3400");
}

#[test]
fn an_unknown_server_is_a_link_with_no_folder() {
    let (_, links) = rewrite("See <http://localhost:5173/>", site);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].port, 5173);
    assert_eq!(links[0].path, None);
    assert_eq!(links[0].project, None);
}

#[test]
fn code_and_other_sites_are_left_alone() {
    let text = "Run `npm run dev` then open `http://localhost:3000`.\n```\ncurl http://localhost:3000/api\n```\nDocs: [here](https://example.com/docs)";
    let (out, links) = rewrite(text, site);
    assert_eq!(out, text);
    assert!(links.is_empty());
}

#[test]
fn the_same_address_twice_is_one_chip() {
    let (text, links) = rewrite(
        "Open http://localhost:3400 or [the site](http://localhost:3400).",
        site,
    );
    assert_eq!(links.len(), 1);
    assert_eq!(text, "Open the preview below or the site.");
}

#[test]
fn ports_are_read_without_looking_anything_up() {
    assert_eq!(
        ports_in("[a](http://localhost:3400) and http://0.0.0.0:8080/x"),
        vec![3400, 8080]
    );
    assert!(ports_in("nothing local here: https://example.com").is_empty());
}

#[test]
fn a_folder_inside_a_project_is_that_project() {
    let folders = vec![site(3400).unwrap(), site(3401).unwrap()];
    let k = folder_for("/Users/test/ShipStudio/bakery/apps/web", &folders).unwrap();
    assert_eq!(k.path, "/Users/test/ShipStudio/bakery");
    let k = folder_for("/Users/test/ShipStudio/.worktrees/bakery-1", &folders).unwrap();
    assert!(k.copy);
    assert_eq!(
        folder_for("/Users/test/ShipStudio/bakery-old", &folders),
        None
    );
    assert_eq!(folder_for("/tmp", &folders), None);
}

#[test]
fn a_message_from_an_older_build_reads_without_links() {
    let m: crate::agents::store::AgentMessage = serde_json::from_value(serde_json::json!({
        "id": "m1", "agentId": "a1", "ts": 1, "kind": "agent", "text": "hi"
    }))
    .unwrap();
    assert!(m.local_links.is_empty());
    let out = serde_json::to_value(&m).unwrap();
    assert!(out.get("localLinks").is_none());
}
