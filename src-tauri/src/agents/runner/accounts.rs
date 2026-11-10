//! Which account and engine a turn runs on: failing over between accounts, crossing over to the other engine (or asking first), and what the turn did on the way.

use super::*;

/// Run one turn: on its own engine's accounts ([`run_on_engine`]), or, when
/// every one of them is out, on the other engine's, as the user chose
/// (`agents::crossover`): carrying on there, asking first with a card, or
/// waiting for the reset. Never for an agent set to one account, never
/// without a line saying so; back on its own engine once that has room.
pub(super) async fn run_on_accounts(
    app: &AppHandle,
    agent_id: &str,
    prompt: &str,
    routine: bool,
    resumes: u8,
) -> Result<Ended, CommandError> {
    use super::crossover::{self, Route};
    let agent = store::get(agent_id)?;
    let home = agent.engine;
    let now = store::now_ms();
    let s = crossover_situation(&agent, resumes > 0, now).await;
    if s.home_room {
        crossover::outage_over(home);
        close_crossover_card(app, home);
    }
    let mut first = prompt.to_string();
    match crossover::before_turn(s) {
        Route::Carry => return carry_on(app, agent_id, prompt, routine, resumes).await,
        Route::Return => first = go_back(app, agent_id, prompt),
        _ => {}
    }
    let result = run_on_engine(app, agent_id, &first, routine, resumes, home).await;
    let Err(err) = &result else { return result };
    // Every account it may use is out (the wallet's line, or a lone
    // account's own usage limit): perhaps the other engine carries on.
    let all_out = super::wallet::peek_all_out(agent_id)
        || super::failure::describe_now(home, &err.to_string()).1.kind
            == super::failure::FailureKind::UsageLimit;
    if !all_out || QUITTING.load(Ordering::SeqCst) {
        return result;
    }
    let agent = store::get(agent_id)?;
    let now = store::now_ms();
    let acted = resumes > 0 || took_action(agent_id);
    let s = crossover_situation(&agent, acted, now).await;
    match crossover::after_out(s) {
        Route::Carry => {
            // Carrying on says so itself: not the usage-limit line as well.
            let _ = super::wallet::take_all_out(agent_id);
            carry_on(app, agent_id, prompt, routine, resumes).await
        }
        Route::Held => {
            let _ = super::wallet::take_all_out(agent_id);
            Err(CommandError::expected(crossover::held_line(
                home,
                crossover::other(home),
            )))
        }
        Route::Ask { resume } => {
            ask_to_carry_on(app, &agent, resume, now).await;
            result
        }
        _ => result,
    }
}

/// What deciding where a turn runs reads (`crossover::Situation`). The
/// other engine is only looked at when its own has no room, or it is away.
pub(super) async fn crossover_situation(
    agent: &store::Agent,
    acted: bool,
    now: i64,
) -> super::crossover::Situation {
    use super::crossover;
    use super::wallet;
    let home = agent.engine;
    let mine = wallet::for_agent(wallet::candidates(home).await, agent.account.as_deref());
    let signed_in: Vec<&wallet::Candidate> = mine.iter().filter(|c| c.signed_in).collect();
    // Out of usage, not signed out: a signed-out engine says so itself.
    let home_room = signed_in.is_empty() || signed_in.iter().any(|c| c.account.out(now).is_none());
    let away = agent.away.is_some();
    let other_room = if home_room && !away {
        false
    } else {
        let to = crossover::other(home);
        super::engine::binary(to).await.is_some()
            && wallet::candidates(to)
                .await
                .iter()
                .any(|c| c.signed_in && c.account.out(now).is_none())
    };
    crossover::Situation {
        pinned: agent.account.is_some(),
        quiet: super::tidy::is_quiet(&agent.id),
        away,
        home_room,
        other_room,
        mode: crossover::mode(home),
        once: crossover::once(home, now),
        asking: !home_room && crossover::still_asking(home),
        acted,
    }
}

/// When the first of the agent's own accounts is back, as reported, and
/// how many of them are signed in.
pub(super) async fn back_at(agent: &store::Agent, now: i64) -> (Option<i64>, usize) {
    use super::wallet;
    let mine = wallet::for_agent(
        wallet::candidates(agent.engine).await,
        agent.account.as_deref(),
    );
    let signed_in: Vec<&wallet::Candidate> = mine.iter().filter(|c| c.signed_in).collect();
    let at = signed_in
        .iter()
        .filter_map(|c| c.account.out(now).flatten())
        .min();
    (at, signed_in.len())
}

/// Run this turn on the other engine, the agent's own being out: the first
/// time with one quiet line, and in a new session there with the app's own
/// recap (engines can't open each other's sessions); after that, in that
/// session. Its instructions and memory are the one CLAUDE.md, before and
/// after (`crossover::sync_instructions`).
pub(super) async fn carry_on(
    app: &AppHandle,
    agent_id: &str,
    prompt: &str,
    routine: bool,
    resumes: u8,
) -> Result<Ended, CommandError> {
    use super::crossover::{self, Away};
    let agent = store::get(agent_id)?;
    let home = agent.engine;
    let to = crossover::other(home);
    let now = store::now_ms();
    let (until, _) = back_at(&agent, now).await;
    let arriving = agent.away.as_ref().is_none_or(|a| a.engine != to);
    store::update(agent_id, |a| match a.away.as_mut() {
        Some(away) if away.engine == to => away.until = until.or(away.until),
        _ => {
            a.away = Some(Away {
                engine: to,
                session_id: None,
                since: now,
                until,
                fresh: false,
            })
        }
    })?;
    if arriving {
        let reach = crossover_reach(&agent, to);
        let line = crossover::carried_line(home, to, until, reach.as_deref(), &chrono::Local, now);
        let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
        let _ = app.emit(EVENT_REGISTRY, ());
        let _ = app.emit(EVENT_USAGE_PLAN, ());
        tracing::info!(
            "[Agents] {agent_id}: every {} account is out; carrying on with {}",
            home.label(),
            to.label()
        );
    }
    let home_dir = store::agent_home(agent_id)?;
    crossover::sync_instructions(&home_dir);
    let away = store::get(agent_id)?.away;
    let fresh_there = away
        .as_ref()
        .is_none_or(|a| a.session_id.is_none() && !a.fresh);
    let prompt = if fresh_there && resumes == 0 {
        with_recap_as(agent_id, &crossover::carry_header(home, to), None, prompt)
    } else {
        prompt.to_string()
    };
    let result = run_on_engine(app, agent_id, &prompt, routine, resumes, to).await;
    // Memory it saved there is kept, wherever Codex put it.
    if crossover::sync_instructions(&home_dir) {
        tracing::info!("[Agents] kept memory {agent_id} saved on {}", to.label());
    }
    result
}

/// Its own engine has room again: back to it, with one line, and (when it
/// has its own conversation to resume) told what was said meanwhile.
pub(super) fn go_back(app: &AppHandle, agent_id: &str, prompt: &str) -> String {
    use super::crossover;
    let Ok(agent) = store::get(agent_id) else {
        return prompt.to_string();
    };
    let Some(away) = agent.away.clone() else {
        return prompt.to_string();
    };
    store::update(agent_id, |a| a.away = None).or_log("an agent's return from away");
    if let Ok(home_dir) = store::agent_home(agent_id) {
        crossover::sync_instructions(&home_dir);
    }
    let line = crossover::back_line(agent.engine);
    let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
    let _ = app.emit(EVENT_REGISTRY, ());
    let _ = app.emit(EVENT_USAGE_PLAN, ());
    // Started fresh meanwhile, or never had one: nothing missed to tell.
    if agent.session_id.is_none() || away.fresh {
        return prompt.to_string();
    }
    with_recap_as(
        agent_id,
        &crossover::back_header(agent.engine, away.engine),
        Some(away.since),
        prompt,
    )
}

/// What the agent would have had on its own engine that the other lacks
/// (`crossover::reach_line`): Claude in Chrome and claude.ai connectors.
pub(super) fn crossover_reach(agent: &store::Agent, to: Engine) -> Option<String> {
    use super::connections::Kind;
    let outside = from_outside(&agent.id);
    let there = super::crossover::as_on(agent.clone(), to);
    let lost_chrome = super::browser::claude_in_chrome_for_turn(agent, outside)
        && !crate::user_chrome::for_turn(agent, outside);
    let user_chrome = crate::user_chrome::for_turn(&there, outside);
    let all = super::connections::list().unwrap_or_default();
    let granted: Vec<&super::connections::Connection> = all
        .iter()
        .filter(|c| c.grant_for(&agent.id).is_some())
        .collect();
    let connectors: Vec<String> = if agent.engine == Engine::Claude {
        granted
            .iter()
            .filter(|c| matches!(c.kind, Kind::ClaudeAi { .. }))
            .map(|c| c.title.clone())
            .collect()
    } else {
        Vec::new()
    };
    let connections = granted
        .iter()
        .any(|c| !matches!(c.kind, Kind::ClaudeAi { .. }));
    super::crossover::reach_line(to, lost_chrome, &connectors, user_chrome, connections)
}

/// "Carry on with Codex until then?": one card, in this agent's chat, for
/// the engine's outage; nobody else is asked while it is open.
pub(super) async fn ask_to_carry_on(app: &AppHandle, agent: &store::Agent, resume: bool, now: i64) {
    use super::crossover;
    let home = agent.engine;
    let to = crossover::other(home);
    let (until, count) = back_at(agent, now).await;
    let ask = crossover::Ask {
        from: home,
        to,
        until,
        resume,
    };
    let reach = crossover_reach(agent, to);
    let approval = crossover::card(
        ask,
        &agent.name,
        count,
        reach.as_deref(),
        &chrono::Local,
        now,
    );
    let request_id = approval.request_id.clone();
    let mut message = new_message(&agent.id, MessageKind::Approval, "");
    message.approval = Some(approval);
    if let Err(e) = record_own(app, message) {
        tracing::warn!(
            "[Agents] couldn't ask about carrying on with {}: {e}",
            to.label()
        );
        return;
    }
    let _ = crossover::set_asking(
        home,
        crossover::Asking {
            agent_id: agent.id.clone(),
            request_id,
            at: now,
        },
    );
    store::refresh_pending(&agent.id);
    notify::refresh_badge(app);
}

/// The engine has room again: a card still asking about its outage closes.
pub(super) fn close_crossover_card(app: &AppHandle, home: Engine) {
    let Some(asking) = super::crossover::asking(home) else {
        return;
    };
    super::crossover::clear_asking(&asking.request_id);
    let why = format!("{} has room again, so this closed.", home.label());
    if let Ok(Some(m)) = store::set_aside(&asking.agent_id, &asking.request_id, &why) {
        let _ = app.emit(EVENT_MESSAGE, &m);
    }
    store::refresh_pending(&asking.agent_id);
}

/// "Carry on with Codex until then?" answered, on the desk, the phone or by
/// a typed yes: Always (the team's setting), Just this time (this outage),
/// or Wait. A yes to a turn that hadn't started runs it again there.
pub fn answer_crossover(
    app: &AppHandle,
    agent_id: &str,
    approval: &store::Approval,
    allow: bool,
    always: bool,
) -> Result<(), CommandError> {
    use super::crossover;
    // Only the answer that closes the card sets anything or runs the turn.
    let settled = crossover::settle(agent_id, approval, allow, always, store::now_ms())?;
    let _ = app.emit(EVENT_MESSAGE, &settled.message);
    if let (true, Some(ask)) = (settled.resume, approval.crossover.as_ref()) {
        enqueue(app, agent_id, crossover::resume_prompt(ask.from), From::App);
    }
    store::refresh_pending(agent_id);
    let _ = app.emit(EVENT_REGISTRY, ());
    let _ = app.emit(EVENT_USAGE_PLAN, ());
    notify::refresh_badge(app);
    Ok(())
}

/// Run one turn on `engine`'s accounts (`agents::wallet`): on the first
/// one that can, and when it ends on the usage limit, again on the next, with
/// a quiet line saying so. With one account this is exactly [`run_turn`].
/// On the agent's own engine its "Runs on" pin holds; on the other engine
/// (carrying on, `crossover`) any of that engine's accounts.
pub(super) async fn run_on_engine(
    app: &AppHandle,
    agent_id: &str,
    prompt: &str,
    routine: bool,
    mut resumes: u8,
    engine: Engine,
) -> Result<Ended, CommandError> {
    use super::wallet::{self, Choice};
    let agent = store::get(agent_id)?;
    // "Runs on" one account: only that one, never another (`wallet::for_agent`).
    let pin = agent.account.clone().filter(|_| engine == agent.engine);
    let pinned = pin.as_deref();
    let mine = move || async move { wallet::for_agent(wallet::candidates(engine).await, pinned) };
    let mut tried: Vec<String> = Vec::new();
    let mut prompt = prompt.to_string();
    // A pick-up carries on in the conversation it was cut off in, or not at
    // all: a fresh session would see only the chat, and do it all again.
    let mut picking_up = resumes > 0;
    // Any try of this turn, on any account, that ran a tool.
    clear_acted(agent_id);
    loop {
        let now = store::now_ms();
        let candidates = mine().await;
        let account = match wallet::choose(&candidates, &tried, now) {
            Choice::Run(account) => account,
            Choice::AllOut { earliest, count } => {
                let line = wallet::all_out_line(engine, count, earliest, &chrono::Local, now);
                wallet::set_all_out(agent_id, line.clone(), earliest);
                return Err(CommandError::expected(line));
            }
        };
        // Set to one account, or with only one signed in, that is out until a
        // reset it reported: the turn ends now, on the usage-limit line (and
        // the Note), rather than spend a refused try on it
        // (`wallet::pinned_and_out`). A routine that ends so waits for the
        // reset (`runs::settle`).
        let lone = candidates.iter().filter(|c| c.signed_in).count() <= 1;
        if let Some(back) = wallet::pinned_and_out(pin.is_some() || lone, &account, &tried, now) {
            let others = wallet::candidates(engine).await;
            if pin.is_some() && wallet::can_switch(&others, std::slice::from_ref(&account.id), now)
            {
                let line = pinned_out_line(&agent.name, &account.name);
                let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
            }
            let line = wallet::pinned_out_until_line(&account.name, back, &chrono::Local, now);
            wallet::set_all_out(agent_id, line.clone(), Some(back));
            return Err(CommandError::expected(line));
        }
        // Held for the try: removing the account waits for it to end. Gone
        // from the list since it was chosen: another one.
        let Some(_in_use) = wallet::hold(&account, agent_id) else {
            tried.push(account.id.clone());
            continue;
        };
        // Another account than its last turn's: the chat says so, quietly.
        if let Some(prev) = wallet::ran_on(agent_id, &account) {
            let from = candidates
                .iter()
                .find(|c| c.account.id == prev)
                .map(|c| &c.account);
            let line = wallet::switch_line(&account, from, &chrono::Local, now);
            let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
            if engine == Engine::Claude {
                // What this account lacks that the last had (`account_reach`):
                // compared when this turn's engine lists its connectors, and
                // the servers that need a sign-in on it, asked of it now.
                if let Ok(agent) = store::get(agent_id) {
                    if let Some(caps) = agent.capabilities {
                        switched_from(agent_id, &wallet::line_name(&account.name), caps);
                    }
                }
                if !account.is_this_mac() {
                    check_sign_ins(app, agent_id, &account);
                }
            }
        }
        // A switched try whose last attempt already acted resumes that
        // attempt's conversation or doesn't run: a fresh start there would
        // see only the chat, not what its tools did, and do it all again.
        let switched_after_acting = !tried.is_empty() && took_action(agent_id);
        // "What it did" says which account ran it (its model, once the engine says).
        super::work::on_ran_on(agent_id, engine.label(), &wallet::line_name(&account.name));
        let result = run_turn(
            app,
            agent_id,
            &prompt,
            routine,
            !switched_after_acting && !picking_up,
            &account,
        )
        .await;
        if let Ok(Ended::Died(detail)) = &result {
            // The app is going: the mark stays as it is, for the next launch.
            // The app's own tidy isn't carried on either: it says it didn't
            // finish, and tries again at the next turn's end.
            if QUITTING.load(Ordering::SeqCst) || super::tidy::is_quiet(agent_id) {
                return result;
            }
            let Some(next) = next_pickup(resumes) else {
                set_cut_off(agent_id);
                return Err(CommandError::expected(died_again_line(engine, detail)));
            };
            resumes = next;
            picking_up = true;
            update_mark(agent_id, |m| m.resumes = next);
            tracing::warn!("[Agents] {agent_id}'s engine stopped mid-turn; picking it up");
            let line = format!("Picked up after {} stopped unexpectedly", engine.label());
            let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
            prompt = prompts::carry_on(&format!("{} stopped unexpectedly", engine.label()));
            continue;
        }
        let Err(err) = &result else { return result };
        if picking_up && is_missing_session(&err.to_string()) {
            set_cut_off(agent_id);
            return Err(CommandError::expected(SESSION_GONE_LINE));
        }
        if switched_after_acting && is_missing_session(&err.to_string()) {
            return Err(CommandError::expected(not_carried_line(
                &wallet::line_name(&account.name),
            )));
        }
        let (_, failure) = super::failure::describe_now(engine, &err.to_string());
        if failure.kind != super::failure::FailureKind::UsageLimit {
            return result;
        }
        let now = store::now_ms();
        wallet::mark_out_with_twins(engine, &account.id, failure.resets_at, now);
        tried.push(account.id.clone());
        let candidates = mine().await;
        let signed_in = candidates.iter().filter(|c| c.signed_in).count();
        // Set to one account, and another has room: say once how to let it.
        if pin.is_some() && candidates.len() == 1 {
            let others = wallet::candidates(engine).await;
            if wallet::can_switch(&others, &tried, now) {
                let line = pinned_out_line(&agent.name, &account.name);
                let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
            }
        }
        if !wallet::can_switch(&candidates, &tried, now) {
            if signed_in >= 2 {
                if let Choice::AllOut { earliest, count } = wallet::choose(&candidates, &tried, now)
                {
                    let line = wallet::all_out_line(engine, count, earliest, &chrono::Local, now);
                    wallet::set_all_out(agent_id, line.clone(), earliest);
                    return Err(CommandError::expected(line));
                }
            }
            return result;
        }
        tracing::info!("[Agents] {agent_id}'s account is out of usage; trying the next");
        prompt = wallet::continue_prompt(&prompt);
    }
}

/// Agents whose turn just switched account: (the account's name, what the
/// last turn's engine listed), compared with this turn's own listing.
pub(super) static SWITCHED: LazyLock<
    Mutex<std::collections::HashMap<String, (String, super::capabilities::Capabilities)>>,
> = LazyLock::new(Default::default);

pub(super) fn switched_from(
    agent_id: &str,
    account: &str,
    caps: super::capabilities::Capabilities,
) {
    SWITCHED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), (account.to_string(), caps));
}

/// This turn's engine listed what it has: after a switch, one quiet line
/// naming what the last account had and this one doesn't (`account_reach`).
pub(super) fn compare_after_switch(
    app: &AppHandle,
    agent_id: &str,
    now: &super::capabilities::Capabilities,
) {
    let Some((account, before)) = SWITCHED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id)
    else {
        return;
    };
    let chrome = store::get(agent_id)
        .map(|a| super::browser::for_turn(&a, false))
        .unwrap_or(false);
    if let Some(line) = super::account_reach::lost_line(&account, &before, now, chrome) {
        let _ = record_in_turn(app, new_message(agent_id, MessageKind::Note, line));
    }
}

/// (account id, line) already said: a missing sign-in is said once per run
/// of the app, not on every switch.
pub(super) static SIGN_INS_SAID: LazyLock<Mutex<std::collections::HashSet<(String, String)>>> =
    LazyLock::new(Default::default);

/// Ask Claude Code, as `account`, which of the user's servers need a
/// sign-in there, in the background (it health-checks each server), and say
/// so in the chat once. Read-only.
pub(super) fn check_sign_ins(app: &AppHandle, agent_id: &str, account: &super::wallet::Account) {
    let (app, agent_id, account) = (app.clone(), agent_id.to_string(), account.clone());
    tauri::async_runtime::spawn(async move {
        let env = super::wallet::env_for(&account);
        let config = super::wallet::folder(&account).join(".claude.json");
        let apps = match super::apps::list_as(&env, &config).await {
            Ok(apps) => apps,
            Err(e) => {
                tracing::info!(account = %account.id, "[Agents] couldn't list an account's MCP servers: {e}");
                return;
            }
        };
        let name = store::get(&agent_id).map(|a| a.name).unwrap_or_default();
        let Some(line) = super::account_reach::needs_auth_line(&account.name, &name, &apps) else {
            return;
        };
        let fresh = SIGN_INS_SAID
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((account.id.clone(), line.clone()));
        if fresh {
            let _ = record(&app, new_message(&agent_id, MessageKind::Note, line));
        }
    });
}

/// Agents whose turn ran a tool in any of its tries (`run_on_accounts`).
pub(super) static ACTED: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(Default::default);

pub(super) fn note_acted(agent_id: &str) {
    ACTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string());
}

pub(super) fn took_action(agent_id: &str) -> bool {
    ACTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(agent_id)
}

/// Agents whose live turn has asked the user with blocks (`show` with a
/// choice, comparison or form). Observed live (Claude Code, 2026-11-10):
/// told to stop, the model still wrote "Tap a fruit above" or "I put up a
/// table with…" under the question, a second bubble saying it again. Once
/// asked, the turn's further words go in "What it did" and the question
/// stays the chat's last word.
pub(super) static BLOCKS_ASKED: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(Default::default);

pub fn note_blocks_asked(agent_id: &str) {
    BLOCKS_ASKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string());
}

pub(super) fn blocks_asked(agent_id: &str) -> bool {
    BLOCKS_ASKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(agent_id)
}

pub(super) fn clear_blocks_asked(agent_id: &str) {
    BLOCKS_ASKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

pub(super) fn clear_acted(agent_id: &str) {
    ACTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

/// A switch whose conversation couldn't be brought to the next account,
/// after the last one had already done part of the work. Not said with the
/// usage-limit words: it isn't one, and mustn't mark this account out.
/// An agent set to run on one account that is out, while another has room.
pub(crate) fn pinned_out_line(agent: &str, account: &str) -> String {
    format!(
        "{agent} runs only on {}, which is out of usage. To carry on with another account, set Runs on to Any account in its … menu.",
        super::wallet::line_name(account)
    )
}

pub(super) fn not_carried_line(to: &str) -> String {
    format!("Stopped instead of switching to {to}: this conversation couldn't be brought over to it, and part of the work had already run, so starting again could do it twice. Check what was done, then send what's left.")
}
