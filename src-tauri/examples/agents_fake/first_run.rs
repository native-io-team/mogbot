//! `first-run`: the first minutes with the Chief of Staff, as a new user
//! meets them. The chat opens on the stored greeting (no turn ran for it).
//! The user taps "Make me an agent" and sends it with the import question
//! unanswered: the Chief is working within a moment (what the working line
//! is drawn from), the import question counts as gone past (`skipped`), and
//! the reply is one `show` card, a draft with "Make it?", with nothing made.
//! "Make it" creates the agent with its routine and its first task, which
//! ends on a result card in the new agent's chat.
//!
//! What the Chief says is the fake's script, so this checks the path its
//! words travel (cards, blocks, routines, the first run), not the model.

use super::*;
use agents::import_choice::{self, Choice};

/// How soon after Send the Chief must be shown working: the working line
/// ("Thinking") is drawn from this status.
const WORKING_WITHIN: Duration = Duration::from_millis(750);

fn draft_show() -> Value {
    json!({
        "text": "Here's the agent I'd make. It reads the AI news each weekday morning and sends you the three things worth knowing.",
        "blocks": [
            {"kind": "facts", "title": "AI News", "items": [
                {"label": "Job", "value": "The AI news worth knowing, in three points"},
                {"label": "Runs", "value": "Weekdays at 8am, the first one now"},
                {"label": "Needs", "value": "Nothing to connect"}
            ]},
            {"kind": "choices", "question": "Make it?",
             "options": ["Make it", "Change something"]}
        ]
    })
}

pub(super) async fn first_run(h: &H) -> Check {
    let chief = h.chief();
    // The suite shares one HOME: other scenarios may have talked to the
    // Chief already. What a new install has is the greeting, first.
    let first = log(&chief.id).into_iter().next().ok_or("an empty Chief chat")?;
    ensure(
        first.kind == MessageKind::Agent && first.text == agents::prompts::CHIEF_GREETING,
        format!("the chat doesn't open on the greeting: {:?}", first.text),
    )?;
    let before = log(&chief.id).len();
    let replies_before = replies(&chief.id).len();
    import_choice::set(Choice::Undecided, store::now_ms()).map_err(|e| e.to_string())?;
    let team_before = store::list().unwrap_or_default().len();

    // The chip's brief, finished by the user, then the fake's draft.
    let brief = format!(
        "Make me an agent that keeps working on its own. Draft it first (its name, what it does, when it runs and what it needs), make it only when I say yes, then do its first run now. It should: send me the AI news every weekday at 8am {}",
        fake(json!([
            {"sleep": 0.6},
            {"tool": "show", "args": draft_show()}
        ]))
    );
    let sent = Instant::now();
    h.send(&chief.id, &brief).await?;
    let _ = h
        .until("the Chief to be working", Duration::from_secs(15), || {
            runner::status_of(&chief.id).state == "working"
        })
        .await;
    let working_after = sent.elapsed();
    println!("      working {}ms after Send", working_after.as_millis());
    ensure(
        working_after <= WORKING_WITHIN,
        format!("working only {}ms after Send", working_after.as_millis()),
    )?;
    ensure(
        replies(&chief.id).len() == replies_before,
        "a reply arrived before the working line could show",
    )?;
    ensure(
        import_choice::choice() == Choice::Skipped,
        format!(
            "sending past the import question left it {:?}",
            import_choice::choice()
        ),
    )?;
    h.turn(&chief.id).await?;
    no_errors(&chief.id)?;

    let draft = log(&chief.id)
        .into_iter()
        .skip(before)
        .find(|m| m.blocks.is_some())
        .ok_or("the draft came back without a card")?;
    let items = draft.blocks.clone().unwrap()["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let kinds: Vec<&str> = items.iter().filter_map(|b| b["kind"].as_str()).collect();
    ensure(kinds == ["facts", "choices"], format!("draft kinds: {kinds:?}"))?;
    ensure(
        store::list().unwrap_or_default().len() == team_before,
        "an agent was made before the user said yes",
    )?;

    // "Make it": one create_agent with its routine and its first run.
    let first_task = fake(json!([
        {"write": "ai-news.md", "text": "# AI news\n\n1. One\n2. Two\n3. Three\n"},
        {"tool": "share_result", "args": {
            "title": "AI news, today",
            "summary": "The three things worth knowing this morning.",
            "items": [{"path": "ai-news.md", "label": "Today's brief"}],
            "checked": ["Each item links to its source"],
            "not_verified": ["Prices and dates are as the sources give them"]}},
        {"say": "Here's today's."}
    ]));
    let routine_note = fake(json!([{"say": "the morning brief"}]));
    h.send(
        &chief.id,
        &format!(
            "Make it {}",
            fake(json!([
                {"tool": "create_agent", "args": {
                    "name": "AI News",
                    "role": "Sends the AI news worth knowing every weekday morning.",
                    "instructions": "Read the AI news each weekday morning and send the three things worth knowing, with links.",
                    "routines": [{"when": "every weekday at 8:00", "note": routine_note}],
                    "first_task": first_task}},
                {"say": "Made AI News. Its first brief is on its way; after that, every weekday at 8am while this Mac is awake."}
            ]))
        ),
    )
    .await?;
    h.turn(&chief.id).await?;
    no_errors(&chief.id)?;
    let made = store::list()
        .unwrap_or_default()
        .into_iter()
        .find(|a| a.name == "AI News")
        .ok_or_else(|| {
            format!(
                "AI News wasn't made: {:?}",
                h.fake_log()
                    .into_iter()
                    .filter(|e| e["tool"] == "create_agent")
                    .map(|e| e["reply"].to_string())
                    .collect::<Vec<_>>()
            )
        })?;
    ensure(
        made.check_ins.len() == 1,
        format!("{} routines on AI News", made.check_ins.len()),
    )?;
    h.until("AI News's first result", Duration::from_secs(40), || {
        log(&made.id).iter().any(|m| m.result.is_some())
    })
    .await?;
    h.turn(&made.id).await?;
    no_errors(&made.id)?;
    let card = log(&made.id)
        .into_iter()
        .find_map(|m| m.result)
        .ok_or("no result card")?;
    let v = serde_json::to_value(&card).unwrap().to_string();
    ensure(
        v.contains("AI news, today") && v.contains("ai-news.md"),
        format!("card: {v}"),
    )
}
