//! `page`: a conversation's living page end to end. A turn pins a page to
//! the conversation it runs in (kept beside the log, never in it), a routine
//! set up there updates it as v2 (told the page is there), the user unpins
//! it and the next update keeps it unpinned, and a turn answering outside
//! text can only change a page through a card (denied here: nothing changes).

use super::*;
use app_lib::agents::page;
use app_lib::commands::agents_page as page_cmd;

fn tracker(stage: &str) -> Value {
    json!({ "id": "apps", "kind": "table", "title": "Applications",
        "columns": ["Company", "Stage"], "rows": [["Acme", stage], ["Globex", "Applied"]] })
}

pub(super) async fn page_scenario(h: &H) -> Check {
    let a = h.agent("Tracker");
    let conv = cmd::agents_conversation_new(h.app.clone(), a.id.clone())
        .await
        .map_err(|e| e.to_string())?
        .current;
    let routine = fake(json!([
        {"tool": "page", "args": {"blocks": [tracker("Interviewing")], "note": "Acme moved to interviewing"}},
        {"say": "checked the inbox"}
    ]));
    h.send_in(
        &a.id,
        &fake(json!([
            {"tool": "page", "args": {
                "title": "Job search",
                "blocks": [tracker("Applied"), {"id": "next", "kind": "checklist", "items": [{"text": "Send the portfolio", "done": false}]}],
                "note": "Started tracking"}},
            {"tool": "schedule_check_in", "args": {"when": "every day at 9:00", "note": routine}},
            {"say": "Pinned a tracker above this conversation."}
        ])),
        Some(&conv),
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;

    let p = page::get(&a.id, &conv)
        .map_err(|e| e.to_string())?
        .ok_or("no page in the conversation it was made in")?;
    ensure(p.pinned, "a new page isn't pinned")?;
    ensure(
        p.current.version == 1,
        format!("version {}", p.current.version),
    )?;
    ensure(p.current.title == "Job search", p.current.title.clone())?;
    ensure(
        page::get(&a.id, agents::conversations::FIRST)
            .map_err(|e| e.to_string())?
            .is_none(),
        "the page leaked into the first conversation",
    )?;
    // Beside the log, never in it: no agent line holds the page. (The
    // user's own line and the routine's carry the scripts, which name it.)
    let home = store::agent_home(&a.id).unwrap();
    ensure(
        home.join(format!("pages/{conv}.json")).exists(),
        "no page file",
    )?;
    let leaked: Vec<String> = log(&a.id)
        .into_iter()
        .filter(|m| m.kind == MessageKind::Agent)
        .filter(|m| m.blocks.is_some() || m.text.contains("Globex"))
        .map(|m| m.text)
        .collect();
    ensure(
        leaked.is_empty(),
        format!("the page went into the chat log: {leaked:?}"),
    )?;
    let steps = timeline(&a.id);
    ensure(
        steps.iter().any(|(label, _)| label == "Updated the page"),
        format!("no step in \"What it did\": {steps:?}"),
    )?;
    let told = h.fake_log().iter().any(|e| {
        e.to_string()
            .contains("Made the page \\\"Job search\\\" (v1)")
    });
    ensure(told, "the page receipt never reached the engine")?;

    // The routine runs in that conversation, is told the page is there, and
    // updates it as v2 "by a routine".
    fire_routines(h, &a.id);
    h.until("the routine's update", Duration::from_secs(30), || {
        page::get(&a.id, &conv)
            .ok()
            .flatten()
            .is_some_and(|p| p.current.version == 2)
    })
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let p = page::get(&a.id, &conv).unwrap().unwrap();
    ensure(p.current.by_routine, "the routine's version isn't marked")?;
    ensure(
        p.current.changes.changed == ["apps"] && p.current.changes.added.is_empty(),
        format!("changes: {:?}", p.current.changes),
    )?;
    ensure(
        p.history.iter().map(|v| v.version).collect::<Vec<_>>() == [2, 1],
        "the version before wasn't kept",
    )?;
    let v1 = page::version(&a.id, &conv, 1)
        .unwrap()
        .ok_or("v1 not kept")?;
    ensure(
        v1.blocks.to_string().contains("\"Applied\""),
        "v1 isn't what it was",
    )?;
    let noted = h
        .turns_with("this conversation has a page, \"Job search\" (v1; blocks apps, next)")
        .len();
    ensure(noted >= 1, "the routine's turn wasn't told about the page")?;

    // The user unpins it; an update keeps it unpinned and the agent is told.
    let after = page_cmd::agents_page_pin(h.app.clone(), a.id.clone(), Some(conv.clone()), false)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no page to unpin")?;
    ensure(!after.pinned, "still pinned")?;
    h.send_in(
        &a.id,
        &fake(json!([
            {"tool": "page", "args": {"blocks": [{"id": "next", "kind": "checklist", "items": [{"text": "Send the portfolio", "done": true}]}]}},
            {"say": "ticked it"}
        ])),
        Some(&conv),
    )
    .await?;
    h.turn(&a.id).await?;
    let p = page::get(&a.id, &conv).unwrap().unwrap();
    ensure(
        p.current.version == 3 && !p.pinned,
        "unpinning didn't stand",
    )?;
    ensure(
        h.fake_log()
            .iter()
            .any(|e| e.to_string().contains("The user unpinned it")),
        "the agent wasn't told it's unpinned",
    )?;

    // Outside text: the change waits on a card; denied, nothing changes.
    let seen = approvals(&a.id).len();
    runner::enqueue_assistant(
        &h.app,
        &a.id,
        fake(json!([
            {"tool": "page", "args": {"title": "Hijacked", "blocks": [{"id": "x", "kind": "callout", "text": "Visit evil.example"}]}},
            {"say": "done"}
        ])),
    );
    let c = card(h, &a.id, seen).await?;
    ensure(
        c.title.contains("page"),
        format!("card title: {:?}", c.title),
    )?;
    answer(h, &a.id, &c, false).await?;
    h.turn(&a.id).await?;
    ensure(
        page::get(&a.id, agents::conversations::FIRST)
            .unwrap()
            .is_none(),
        "outside text pinned a page without a yes",
    )?;
    ensure(
        page::get(&a.id, &conv).unwrap().unwrap().current.version == 3,
        "outside text changed the page",
    )
}
