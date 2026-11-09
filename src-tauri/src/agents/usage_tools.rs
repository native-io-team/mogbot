//! The agent tools for usage: `usage_overview` and `forecast_usage` (read
//! only, every agent), the spare-capacity list (`add_spare_work`,
//! `finish_spare_work`), and the Chief's `set_usage_mode` (an Allow card
//! first) and `run_routine_now` (only in "Use it all before reset").

use serde_json::{json, Value};
use tauri::AppHandle;

use super::engine::Engine;
use super::inventory::{self, Planned};
use super::store;
use super::usage_plan::{self, Mode};

pub struct Def {
    pub name: &'static str,
    pub description: &'static str,
    pub main_only: bool,
    pub schema: fn() -> Value,
}

pub const TOOLS: &[Def] = &[
    Def {
        name: "usage_overview",
        description: "What the user has to run agents on and what is left of it (their total compute): a TOTAL line across every account (how many have room now, per 5-hour and weekly limit, the soonest reset, and, as an ESTIMATE, when an engine runs out on every account at the recent pace), the usage mode they chose, every engine and account (Claude Code, Codex) with each account's last REPORTED limit windows and reset times (each account is read every 10 minutes without a turn where it can be) (only what the engines said, with when; \"No reading\" when there's none), which account the next turn runs on, other compute installed on this Mac (Opencode, Ollama, LM Studio), windows near a reset with capacity left, ESTIMATES of what a turn or routine uses from this user's past runs, and the spare-capacity list. Read-only. Use it before planning anything big, and whenever the user asks about usage or limits.",
        main_only: false,
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Def {
        name: "forecast_usage",
        description: "Estimate what planned work will use, from this user's own past runs: a number of turns for some agents (a fan-out, a pipeline), or runs of a routine. Answers tokens per engine, the account it would run on, and, once this Mac has learned it, the share of that account's limit windows. An estimate, never a reading: say it as one (\"likely about…\"). Read-only.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "agents": { "type": "array", "items": { "type": "string" }, "description": "Agents (names or ids) that would take turns. An agent with too little history is estimated from the average turn on its engine." },
                "turns_each": { "type": "integer", "description": "Turns each of those agents would take. Default 1." },
                "routine": { "type": "string", "description": "A routine's id (from usage_overview or list_check_ins)." },
                "runs": { "type": "integer", "description": "Runs of that routine. Default 1." }
            }
        }),
    },
    Def {
        name: "add_spare_work",
        description: "Add something to the spare-capacity list: work the user wants done \"sometime\", when there's capacity that would otherwise expire (research to do one day, a TODO, a cleanup). In \"Use it all before reset\" mode the Chief of Staff starts these when a limit is near its reset with capacity left. Only add what the user asked for, or a follow-up of work they asked for. Never anything that sends, spends, pushes or changes what other people see.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What to do, specific enough to act on with no other context." },
                "agent": { "type": "string", "description": "Optional: the agent who should do it (name or id)." }
            },
            "required": ["task"]
        }),
    },
    Def {
        name: "finish_spare_work",
        description: "Mark an item of the spare-capacity list started (`done: false`, when you hand it to an agent or begin it) or take it off the list (`done: true`, when it's finished or no longer wanted).",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "done": { "type": "boolean" }
            },
            "required": ["id", "done"]
        }),
    },
    Def {
        name: "set_usage_mode",
        description: "Change how the user's usage limits are used, when they ask: `normal` (never slow down for limits), `save` (Save my limits: ask before heavy work, send light work to lighter models or engines) or `use_it_all` (Use it all before reset: their standing OK to spend capacity that would otherwise expire on the spare-capacity list). Spending more is a card first; save, or normal from use_it_all, applies at once with a line.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": { "mode": { "type": "string", "enum": ["normal", "save", "use_it_all"] } },
            "required": ["mode"]
        }),
    },
    Def {
        name: "use_account",
        description: "Switch which account turns run on, when the user asks (\"use my personal Claude plan\"): puts the account they name first for its engine, so every agent's next turn starts on it. When it reaches its limit, turns move to the next account as before. `account` is its name as usage_overview lists it, or its id. Only signed-in accounts; adding one, renaming or reordering is manage_account.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "account": { "type": "string", "description": "The account's name (\"Personal Account\", \"This Mac\") or id." },
                "engine": { "type": "string", "enum": ["claude", "codex"], "description": "Which engine's account, when the name is on both." }
            },
            "required": ["account"]
        }),
    },
    Def {
        name: "set_engine_fallback",
        description: "Change what happens when every account of an engine is out of usage, when the user asks (\"carry on with Codex when Claude runs out\", \"just wait for the reset\"): `carry` moves agents' turns to the other engine until it has room again (never for an agent set to one account), `wait` waits for the reset, `ask` asks the user first with a card. `engine` is the one that runs out. `carry` is a card first; wait and ask apply at once with a line.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "engine": { "type": "string", "enum": ["claude", "codex"], "description": "The engine whose accounts run out." },
                "mode": { "type": "string", "enum": ["ask", "carry", "wait"] }
            },
            "required": ["engine", "mode"]
        }),
    },
    Def {
        name: "run_routine_now",
        description: "Run one of the user's routines now, without moving its next time: only in \"Use it all before reset\" mode, to use capacity that would otherwise expire. Its usual approvals still apply.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "description": "The agent the routine belongs to (name or id)." },
                "id": { "type": "string", "description": "The routine's id." }
            },
            "required": ["agent", "id"]
        }),
    },
];

pub fn find(name: &str) -> Option<&'static Def> {
    TOOLS.iter().find(|t| t.name == name)
}

pub fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

pub fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn count(args: &Value, key: &str) -> u32 {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 500) as u32)
        .unwrap_or(1)
}

/// Read every account again first (when that hasn't run in two minutes), so
/// "how much do I have left?" is answered from what each one says now. At
/// most ~20 seconds; past that, what is known.
pub async fn overview(app: &AppHandle) -> Value {
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        super::usage_read::refresh_if_stale(app),
    )
    .await;
    let inv = inventory::read().await;
    let mut out = inventory::overview_text(&inv, &chrono::Local);
    // When every account of an engine is out: what the user chose.
    let agents = store::list().unwrap_or_default();
    if let Some(line) = super::crossover::overview_line(&super::crossover::view(&agents)) {
        out.push_str("\n\n");
        out.push_str(&line);
    }
    text(out)
}

/// The card the user OKs before `set_engine_fallback` changes their choice.
pub fn fallback_card(engine: Engine, mode: super::crossover::Mode) -> (String, String) {
    use super::crossover::{other, Mode as M};
    let (from, to) = (engine.label(), other(engine).label());
    let title = match mode {
        M::Carry => format!("Carry on with {to} whenever every {from} account is out?"),
        M::Wait => format!("Wait for the reset whenever every {from} account is out?"),
        M::Ask => format!("Ask you first whenever every {from} account is out?"),
    };
    let detail = match mode {
        M::Carry => format!("Agents' turns move to {to} until {from} has room again, then go back, with one line in the chat each way. Never for an agent set to one account."),
        M::Wait => format!("Agents stop on the usage-limit line until a {from} account resets."),
        M::Ask => format!("The first time it happens, one card asks whether to carry on with {to}."),
    };
    (title, detail)
}

pub fn set_fallback(app: &AppHandle, engine: Engine, mode: super::crossover::Mode) -> Value {
    match super::crossover::set_mode(engine, mode) {
        Ok(()) => {
            let _ = tauri::Emitter::emit(app, super::runner::EVENT_USAGE_PLAN, ());
            let (title, _) = fallback_card(engine, mode);
            text(format!(
                "Done: {}",
                title.trim_end_matches('?').to_lowercase()
            ))
        }
        Err(e) => error(e.to_string()),
    }
}

/// The planned work, from the tool's arguments: each agent's own history,
/// or its engine's average turn when it has too little.
pub fn planned(
    inv: &inventory::Inventory,
    agents: &[store::Agent],
    args: &Value,
) -> Result<Vec<Planned>, String> {
    let turns = count(args, "turns_each");
    let mut out = Vec::new();
    let names: Vec<&str> = args
        .get("agents")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for name in names {
        let wanted = name.trim();
        let Some(agent) = agents
            .iter()
            .find(|a| a.id == wanted || a.name.eq_ignore_ascii_case(wanted))
        else {
            return Err(format!("There's no agent called {wanted}."));
        };
        let own = inv
            .agents
            .iter()
            .find(|a| a.id == agent.id)
            .and_then(|a| a.per_turn.clone());
        let pooled = || {
            inv.engines
                .iter()
                .find(|e| e.id == agent.engine)
                .and_then(|e| e.per_turn.clone())
        };
        let plural = if turns == 1 { "" } else { "s" };
        let (per_run, label) = match own {
            Some(r) => (Some(r), format!("{}: {turns} turn{plural}", agent.name)),
            None => (
                pooled(),
                format!(
                    "{}: {turns} turn{plural} (as an average {} turn)",
                    agent.name,
                    agent.engine.label()
                ),
            ),
        };
        out.push(Planned {
            engine: agent.engine,
            label,
            per_run,
            runs: turns,
        });
    }
    if let Some(id) = arg(args, "routine") {
        let Some(r) = inv.routines.iter().find(|r| r.id == id) else {
            return Err(format!("There's no routine with id {id}."));
        };
        let engine = agents
            .iter()
            .find(|a| a.id == r.agent_id)
            .map(|a| a.engine)
            .unwrap_or(Engine::Claude);
        let runs = count(args, "runs");
        let unit = if r.when { "check" } else { "run" };
        out.push(Planned {
            engine,
            label: format!(
                "routine “{}”: {runs} {unit}{}",
                r.what,
                if runs == 1 { "" } else { "s" }
            ),
            per_run: r.per_run.clone(),
            runs,
        });
    }
    if out.is_empty() {
        return Err("Name `agents` (with `turns_each`) or a `routine` (with `runs`).".into());
    }
    Ok(out)
}

pub async fn forecast(args: &Value) -> Value {
    let inv = inventory::read().await;
    let agents = store::list().unwrap_or_default();
    let planned = match planned(&inv, &agents, args) {
        Ok(p) => p,
        Err(e) => return error(e),
    };
    let (_, samples) = tokio::task::spawn_blocking(usage_plan::readings)
        .await
        .unwrap_or_default();
    let forecasts = inventory::forecast(&inv, &samples, &planned);
    text(inventory::forecast_text(&inv, &forecasts, &chrono::Local))
}

pub fn add(caller: &store::Agent, args: &Value) -> Value {
    let Some(task) = arg(args, "task") else {
        return error("`task` is required.");
    };
    let agent_id = match arg(args, "agent") {
        None => None,
        Some(name) => match store::find(name) {
            Ok(Some(a)) => Some(a.id),
            _ => return error(format!("There's no agent called {name}.")),
        },
    };
    match usage_plan::add_item(task, agent_id, &caller.name, store::now_ms()) {
        Ok(item) => text(format!(
            "Added to the spare-capacity list (id {}). It runs when a limit is near its reset with capacity left, if the user has chosen “Use it all before reset”; otherwise it waits.",
            item.id
        )),
        Err(e) => error(e.to_string()),
    }
}

pub fn finish(args: &Value) -> Value {
    let Some(id) = arg(args, "id") else {
        return error("`id` is required.");
    };
    let done = args.get("done").and_then(Value::as_bool).unwrap_or(true);
    match usage_plan::settle_item(id, done, store::now_ms()) {
        Ok(item) if done => text(format!("Took “{}” off the list.", item.text)),
        Ok(item) => text(format!("Marked “{}” started.", item.text)),
        Err(e) => error(e.to_string()),
    }
}

/// The card for a mode change: what it means, in the user's words.
pub fn mode_card(mode: Mode) -> (String, String) {
    let detail = match mode {
        Mode::Normal => "Agents never slow down or hold back because of your limits. Before something big they say what it will likely use, then carry on.",
        Mode::Save => "Agents ask you before heavy work and send light work to lighter models or engines.",
        Mode::UseItAll => "Your standing OK: when a limit is near its reset with capacity left, the Chief of Staff starts work from your spare-capacity list, or brings a routine forward, to use what would otherwise expire. Anything that sends, spends or changes what others see still waits for your Allow.",
    };
    (
        format!("Set usage to “{}”?", mode.label()),
        detail.to_string(),
    )
}

/// Whether moving from `from` to `to` only holds agents back: "Save my
/// limits" from anything, or "Normal" from "Use it all". Applied with a
/// line; anything that spends more is a card. Pure.
pub fn mode_lowers(from: Mode, to: Mode) -> bool {
    from != to && (to == Mode::Save || (to == Mode::Normal && from == Mode::UseItAll))
}

/// Whether a crossover choice only spends less: waiting, or asking first,
/// never moves turns to the other engine on its own. Pure.
pub fn fallback_lowers(_from: super::crossover::Mode, to: super::crossover::Mode) -> bool {
    to != super::crossover::Mode::Carry
}

/// The audit for a usage setting that applied: one quiet line in the
/// caller's chat with what the tool answered, and the log.
pub fn note_change(app: &AppHandle, caller: &store::Agent, done: &Value) {
    if done.get("isError").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(said) = done["content"][0]["text"].as_str() else {
        return;
    };
    tracing::info!(agent = %caller.id, said, "[Agents] usage setting changed from chat");
    let _ = super::runner::record(
        app,
        super::runner::new_message(&caller.id, store::MessageKind::Note, said.to_string()),
    );
}

pub fn set_mode(app: &AppHandle, mode: Mode) -> Value {
    match usage_plan::set_mode(mode, store::now_ms()) {
        Ok(()) => {
            let _ = tauri::Emitter::emit(app, super::runner::EVENT_USAGE_PLAN, ());
            text(format!("Usage is now “{}”.", mode.label()))
        }
        Err(e) => error(e.to_string()),
    }
}

/// The account the user named, among `accounts` (every engine's, in
/// order): its id or its name (any case, or the one name containing it).
/// Observed (2026-11-08): asked to "switch to my personal Claude plan", the
/// Chief said nothing it had could change the account, twice.
pub fn pick_account(
    accounts: &[super::wallet::Account],
    named: &str,
    engine: Option<Engine>,
) -> Result<super::wallet::Account, String> {
    let want = named.trim().to_lowercase();
    let mine: Vec<&super::wallet::Account> = accounts
        .iter()
        .filter(|a| engine.is_none_or(|e| a.engine == e))
        .collect();
    let exact: Vec<&&super::wallet::Account> = mine
        .iter()
        .filter(|a| {
            a.id == named.trim()
                || a.name.to_lowercase() == want
                // "This Mac" still names this Mac's own sign-in, however it is shown.
                || (a.is_this_mac() && want == super::wallet::DEFAULT_NAME.to_lowercase())
        })
        .collect();
    let found: Vec<&&super::wallet::Account> = if exact.is_empty() && !want.is_empty() {
        mine.iter()
            .filter(|a| a.name.to_lowercase().contains(&want))
            .collect()
    } else {
        exact
    };
    let names = || {
        mine.iter()
            .map(|a| format!("“{}” ({})", a.name, a.engine.label()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    match found.as_slice() {
        [one] => Ok((**one).clone()),
        [] => Err(format!(
            "There's no account called “{}”. The accounts are: {}.",
            named.trim(),
            names()
        )),
        _ => Err(format!(
            "More than one account matches “{}”: {}. Say which, with `engine` or the full name.",
            named.trim(),
            names()
        )),
    }
}

/// The engine's account ids with `first` moved to the front.
pub fn order_with_first(accounts: &[super::wallet::Account], first: &str) -> Vec<String> {
    std::iter::once(first.to_string())
        .chain(
            accounts
                .iter()
                .map(|a| a.id.clone())
                .filter(|id| id != first),
        )
        .collect()
}

/// `use_account`: put the named account first for its engine. Only a
/// signed-in one: a turn on an account it can't use would just fail over.
pub async fn use_account(app: &AppHandle, args: &Value) -> Value {
    let account = match named_account(args).await {
        Ok(a) => a,
        Err(e) => return error(e),
    };
    match switch_now(app, account.engine, &account.id) {
        Ok(()) => text(format!(
            "{} turns now start on “{}”. If it reaches its limit they move to the next account, as before.",
            account.engine.label(),
            account.name
        )),
        Err(e) => error(e.to_string()),
    }
}

/// The signed-in account `args` names, by the names the user sees (an
/// unnamed sign-in shows as its email).
async fn named_account(args: &Value) -> Result<super::wallet::Account, String> {
    let Some(named) = arg(args, "account") else {
        return Err("`account` is required: its name as usage_overview lists it.".into());
    };
    let engine = arg(args, "engine")
        .map(Engine::parse)
        .transpose()
        .map_err(|e| e.to_string())?;
    let shown: Vec<super::wallet::Account> = super::wallet::list()
        .into_iter()
        .map(|a| super::wallet::labelled(a, true))
        .collect();
    let account = pick_account(&shown, named, engine)?;
    if !super::wallet::signed_in(&account).await {
        return Err(format!(
            "“{}” isn't signed in on this Mac. Ask the user to sign it in under Settings → Agents → Usage; nothing changed.",
            account.name
        ));
    }
    Ok(account)
}

/// The same as the desk's and the phone's "Use this one now".
fn switch_now(
    app: &AppHandle,
    engine: Engine,
    id: &str,
) -> Result<(), crate::errors::CommandError> {
    super::wallet::use_first(engine, id)?;
    let _ = tauri::Emitter::emit(app, "agents-accounts-changed", ());
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_USAGE_PLAN, ());
    Ok(())
}

/* ------------------------------------------------ the switch on a card */

/// A switch the user OKs on a card (`use_account` from a check-in, a
/// routine or another agent's message). Observed: the card blocked a 3 a.m.
/// check-in for four minutes, expired unanswered, and the Chief told the
/// owner to make the switch in Settings himself. Now nothing waits on it: it
/// stays in the chat until answered, and Allow makes the switch.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSwitch {
    pub engine: Engine,
    pub id: String,
    pub name: String,
}

/// The card for a switch. Pure.
pub fn switch_card(engine: Engine, id: &str, name: &str) -> store::Approval {
    let mut card = super::mcp::new_card(
        store::new_id(),
        format!("Run turns on “{name}” first?"),
        format!(
            "Every agent's next {} turn starts on it; when it reaches its limit, turns move to the next account as before.",
            engine.label()
        ),
        None,
    );
    card.account_switch = Some(AccountSwitch {
        engine,
        id: id.to_string(),
        name: name.to_string(),
    });
    card
}

/// What the agent is told once the card is up (or already was). Pure.
pub fn switch_asked(name: &str, already: bool) -> String {
    let lead = if already {
        format!("The card asking to run turns on “{name}” is still open in your chat.")
    } else {
        format!("Nothing changed yet: the user has a card in your chat, “Run turns on “{name}” first?”.")
    };
    format!("{lead} It stays until they answer, and their Allow makes the switch. Say in one line that it's waiting for their OK there. Don't ask again, and don't send them to Settings.")
}

/// `use_account` when the turn isn't the user's own message: one standing
/// card, never a wait.
pub async fn ask_to_switch(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let account = match named_account(args).await {
        Ok(a) => a,
        Err(e) => return error(e),
    };
    let open = store::pending_approvals(&caller.id).unwrap_or_default();
    if open.iter().any(|a| {
        a.account_switch
            .as_ref()
            .is_some_and(|s| s.engine == account.engine && s.id == account.id)
    }) {
        return text(switch_asked(&account.name, true));
    }
    let mut message = super::runner::new_message(&caller.id, store::MessageKind::Approval, "");
    message.approval = Some(switch_card(account.engine, &account.id, &account.name));
    if let Err(e) = super::runner::record_own(app, message) {
        return error(e.to_string());
    }
    store::refresh_pending(&caller.id);
    super::notify::refresh_badge(app);
    text(switch_asked(&account.name, false))
}

/// The switch card answered (desk, phone or a typed yes): Allow makes it.
pub fn answer_switch(
    app: &AppHandle,
    agent_id: &str,
    approval: &store::Approval,
    allow: bool,
) -> Result<(), crate::errors::CommandError> {
    use crate::errors::CommandError;
    let Some(s) = approval.account_switch.clone() else {
        return Err(CommandError::expected("That isn't a card about accounts."));
    };
    if allow {
        switch_now(app, s.engine, &s.id).map_err(|_| {
            CommandError::expected(format!(
                "“{}” isn't in your accounts any more, so nothing changed.",
                s.name
            ))
        })?;
    }
    let status = if allow {
        store::ApprovalStatus::Allowed
    } else {
        store::ApprovalStatus::Denied
    };
    if let Some(m) = store::set_approval_status(agent_id, &approval.request_id, status)? {
        let _ = tauri::Emitter::emit(app, super::runner::EVENT_MESSAGE, &m);
    }
    if allow {
        let line = format!("{} turns now start on “{}”.", s.engine.label(), s.name);
        let _ = super::runner::record_own(
            app,
            super::runner::new_message(agent_id, store::MessageKind::Note, line),
        );
    }
    store::refresh_pending(agent_id);
    let _ = tauri::Emitter::emit(app, super::runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    Ok(())
}

pub fn run_routine(app: &AppHandle, args: &Value) -> Value {
    if usage_plan::mode().0 != Mode::UseItAll {
        return error("Only in “Use it all before reset”. Otherwise ask the user to press Run now on the routine.");
    }
    let (Some(who), Some(id)) = (arg(args, "agent"), arg(args, "id")) else {
        return error("`agent` and `id` are required.");
    };
    let agent = match store::find(who) {
        Ok(Some(a)) => a,
        _ => return error(format!("There's no agent called {who}.")),
    };
    match super::schedule::run_now(app, &agent.id, id) {
        Ok(()) => text(format!(
            "Started {}'s routine now; its next time is unchanged.",
            agent.name
        )),
        Err(e) => error(e.to_string()),
    }
}

/* ------------------------------------------------------------- the nudge */

/// From the check-in tick: look for a spare window at most every few
/// minutes (reading the inventory checks sign-ins and this Mac's compute).
pub fn maybe_nudge(app: &AppHandle) {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|at| at.elapsed() < Duration::from_secs(180)) {
            return;
        }
        *last = Some(Instant::now());
    }
    // Only "Use it all" ever wakes anyone: skip the inventory otherwise.
    if usage_plan::mode().0 != Mode::UseItAll {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { nudge(&app).await });
}

/// Wake the Chief to use a spare window, in "Use it all before reset"
/// (`usage_plan::should_nudge`). Run from the check-in tick.
pub async fn nudge(app: &AppHandle) {
    let inv = inventory::read().await;
    let waiting: Vec<&usage_plan::SpareItem> = inv
        .backlog
        .iter()
        .filter(|i| i.state == usage_plan::ItemState::Waiting)
        .collect();
    let Some(chief) = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main))
    else {
        return;
    };
    let busy = super::runner::is_working(&chief.id)
        || super::runner::queued(&chief.id)
        || super::runner::driven(&chief.id);
    let nudged = usage_plan::nudged();
    let Some(spare) =
        usage_plan::should_nudge(inv.mode, &inv.spare, waiting.len(), busy, &nudged).cloned()
    else {
        return;
    };
    if usage_plan::mark_nudged(usage_plan::spare_key(&spare)).is_err() {
        // Not recorded: waking it now could wake it every tick.
        return;
    }
    wake_for_spare(app, &inv, &chief, &spare, &waiting, false);
}

/// The user pressed "Give agents something to do" by a window near its
/// reset with room left (the Usage view): the Chief starts the
/// spare-capacity list on it now, whatever the mode. Their press is the OK
/// for this window, as "Use it all before reset" is a standing one; it
/// changes no approval. Answers the line to show.
pub async fn spend_now(app: &AppHandle) -> Result<String, crate::errors::CommandError> {
    let inv = inventory::read().await;
    let waiting: Vec<&usage_plan::SpareItem> = inv
        .backlog
        .iter()
        .filter(|i| i.state == usage_plan::ItemState::Waiting)
        .collect();
    if waiting.is_empty() {
        return Err(super::err_invalid(
            "backlog",
            "Your spare-capacity list is empty. Add something to it first.",
        ));
    }
    let now = inv.now;
    let Some(spare) = inv
        .spare
        .iter()
        .find(|s| s.next && s.resets_at > now)
        .cloned()
    else {
        return Err(super::err_invalid(
            "spare",
            "No limit is about to reset with room left on the account agents use next.",
        ));
    };
    let chief = store::list()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.is_main))
        .ok_or_else(|| super::err_invalid("chief", "There's no Chief of Staff to start it."))?;
    // Recorded, so "Use it all" doesn't wake it a second time for this window.
    let _ = usage_plan::mark_nudged(usage_plan::spare_key(&spare));
    wake_for_spare(app, &inv, &chief, &spare, &waiting, true);
    Ok(format!(
        "{} is starting your spare-capacity list ({} waiting).",
        chief.name,
        waiting.len()
    ))
}

fn wake_for_spare(
    app: &AppHandle,
    inv: &inventory::Inventory,
    chief: &store::Agent,
    spare: &usage_plan::Spare,
    waiting: &[&usage_plan::SpareItem],
    pressed: bool,
) {
    let tz = chrono::Local;
    let window = inventory::window_name(&spare.kind, spare.window_minutes);
    let reset = super::failure::clock_phrase(&tz, spare.resets_at, inv.now);
    let read = super::failure::clock_phrase(&tz, spare.observed_at, inv.now);
    let note = format!(
        "{} “{}”: the {window} limit resets {reset} and was {}% used when last reported. Using it on your spare-capacity list ({} waiting).",
        spare.engine.label(),
        spare.account_name,
        spare.used_percent.floor(),
        waiting.len()
    );
    let items: Vec<String> = waiting
        .iter()
        .map(|i| {
            let who = i
                .agent_id
                .as_ref()
                .and_then(|id| inv.agents.iter().find(|a| &a.id == id))
                .map(|a| format!(" (for {})", a.name))
                .unwrap_or_default();
            format!("- [{}] {}{who}", i.id, i.text)
        })
        .collect();
    let why = if pressed {
        "The user pressed “Give agents something to do” for this window in Usage: their OK to use capacity that would otherwise expire, for this window."
    } else {
        "The user chose “Use it all before reset”: their standing OK to use capacity that would otherwise expire."
    };
    let prompt = format!(
        "[Spare capacity — from the app, not the user]\n\n{why} {} account “{}”: the {window} limit resets {reset} and was {}% used when reported {read}.\n\nWaiting on the spare-capacity list:\n{}\n\nStart what fits before the reset: hand each item to the agent it names, or whose role fits, with message_agent (on {} if there's a choice), or do it yourself, and mark each started with finish_spare_work. You may also bring a routine forward with run_routine_now. Nothing that sends, spends, pushes or changes what other people see without the user's usual Allow. Then tell the user in one line what you started and which account it runs on.",
        spare.engine.label(),
        spare.account_name,
        spare.used_percent.floor(),
        items.join("\n"),
        spare.engine.label(),
    );
    let line = super::runner::new_message(&chief.id, store::MessageKind::Note, note);
    let _ = super::runner::record(app, line);
    super::runner::enqueue(app, &chief.id, prompt, super::runner::From::App);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::forecast::PerRun;
    use crate::agents::inventory::{AgentLine, EngineLine, Inventory};

    fn per(tokens: u64) -> PerRun {
        PerRun {
            estimate: true,
            tokens,
            low: tokens,
            high: tokens,
            runs: 9,
            days: 2,
        }
    }

    fn agent(id: &str, name: &str) -> store::Agent {
        serde_json::from_value(json!({
            "id": id, "name": name, "role": "", "shape": 0, "color": "blue",
            "createdAt": 0, "lastActivityAt": 0
        }))
        .unwrap()
    }

    fn inv() -> Inventory {
        Inventory {
            mode: Mode::Normal,
            mode_set_at: None,
            engines: vec![EngineLine {
                id: Engine::Claude,
                label: "Claude Code",
                installed: true,
                signed_in: true,
                agents: 2,
                next_account: None,
                all_out: false,
                per_turn: Some(per(1_000)),
            }],
            accounts: vec![],
            local: vec![],
            spare: vec![],
            backlog: vec![],
            agents: vec![AgentLine {
                id: "a".into(),
                name: "Research".into(),
                engine: Engine::Claude,
                model: None,
                is_main: false,
                per_turn: Some(per(5_000)),
            }],
            routines: vec![],
            totals: crate::agents::compute::totals(&[], 0),
            now: 0,
        }
    }

    #[test]
    fn a_new_agent_is_estimated_as_an_average_turn_and_says_so() {
        let agents = [agent("a", "Research"), agent("b", "Newbie")];
        let p = planned(
            &inv(),
            &agents,
            &json!({ "agents": ["research", "Newbie"], "turns_each": 3 }),
        )
        .unwrap();
        assert_eq!(p[0].per_run.as_ref().unwrap().tokens, 5_000);
        assert_eq!(p[0].runs, 3);
        assert_eq!(p[1].per_run.as_ref().unwrap().tokens, 1_000);
        assert!(p[1].label.contains("as an average Claude Code turn"));
        assert!(planned(&inv(), &agents, &json!({ "agents": ["Ghost"] })).is_err());
        assert!(planned(&inv(), &agents, &json!({})).is_err());
    }

    /// "Switch to my personal Claude plan": the account is found by its
    /// name and put first; nothing else moves.
    #[test]
    fn use_account_finds_the_named_account_and_puts_it_first() {
        use crate::agents::wallet::Account;
        let acct = |id: &str, engine: Engine, name: &str| Account {
            id: id.into(),
            engine,
            name: name.into(),
            added_at: 0,
            limit: None,
        };
        let all = vec![
            acct("default", Engine::Claude, "This Mac"),
            acct("a1", Engine::Claude, "Personal Account"),
            acct("a2", Engine::Claude, "Work Account"),
            acct("default", Engine::Codex, "This Mac"),
        ];
        let picked = pick_account(&all, "personal", None).unwrap();
        assert_eq!(picked.id, "a1");
        assert_eq!(pick_account(&all, "Work Account", None).unwrap().id, "a2");
        assert_eq!(
            pick_account(&all, "a2", Some(Engine::Claude)).unwrap().id,
            "a2"
        );
        // On both engines: say which.
        assert!(pick_account(&all, "This Mac", None)
            .unwrap_err()
            .contains("More than one"));
        assert_eq!(
            pick_account(&all, "this mac", Some(Engine::Codex))
                .unwrap()
                .engine,
            Engine::Codex
        );
        // "account" matches all of Claude Code's added ones.
        assert!(pick_account(&all, "account", Some(Engine::Claude)).is_err());
        let none = pick_account(&all, "Family", None).unwrap_err();
        assert!(none.contains("“Personal Account” (Claude Code)"), "{none}");
        let claude: Vec<Account> = all[..3].to_vec();
        assert_eq!(order_with_first(&claude, "a2"), ["a2", "default", "a1"]);
        assert_eq!(
            order_with_first(&claude, "default"),
            ["default", "a1", "a2"]
        );
    }

    /// A switch asked for from a check-in: a card nothing waits on, which
    /// no sweep closes, and the agent is told not to send the user to
    /// Settings or ask again.
    #[test]
    fn a_switch_on_a_card_waits_for_the_user_not_the_turn() {
        use crate::agents::expiry::{verdict, Moment};
        let card = switch_card(Engine::Claude, "a1", "Personal Account");
        assert_eq!(card.title, "Run turns on “Personal Account” first?");
        assert!(card.detail.contains("Claude Code turn"), "{}", card.detail);
        assert_eq!(
            card.account_switch,
            Some(AccountSwitch {
                engine: Engine::Claude,
                id: "a1".into(),
                name: "Personal Account".into(),
            })
        );
        assert!(card.tool.is_none(), "never tied to a tool call");
        let day = 24 * 60 * 60 * 1000;
        for moment in [Moment::Launch, Moment::TurnEnded, Moment::Tick] {
            assert_eq!(verdict(&card, day, false, moment), None, "{moment:?}");
        }
        // The same JSON the phone and the desk read.
        let json = serde_json::to_value(&card).unwrap();
        assert_eq!(json["accountSwitch"]["engine"], "claude");
        assert_eq!(json["accountSwitch"]["name"], "Personal Account");
        for already in [false, true] {
            let told = switch_asked("Personal Account", already);
            assert!(told.contains("Personal Account"));
            assert!(told.contains("Don't ask again"));
            assert!(told.contains("don't send them to Settings"));
        }
        assert!(switch_asked("Personal Account", false).starts_with("Nothing changed yet"));
    }

    #[test]
    fn every_tool_is_read_only_or_guarded() {
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            [
                "usage_overview",
                "forecast_usage",
                "add_spare_work",
                "finish_spare_work",
                "set_usage_mode",
                "use_account",
                "set_engine_fallback",
                "run_routine_now"
            ]
        );
        // What changes the user's setting or runs work is the Chief's alone.
        for t in TOOLS {
            assert_eq!(
                t.main_only,
                matches!(
                    t.name,
                    "set_usage_mode" | "use_account" | "set_engine_fallback" | "run_routine_now"
                ),
                "{}",
                t.name
            );
        }
        let (title, detail) = mode_card(Mode::UseItAll);
        assert!(title.contains("Use it all before reset"));
        assert!(detail.contains("still waits for your Allow"));
    }
}
