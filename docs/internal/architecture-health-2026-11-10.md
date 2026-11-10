# Architecture health pass, 2026-11-10

Scope: `src-tauri/src/agents/` (not `runner.rs`, being split separately),
`src-tauri/src/companion/`, `src/lib/agents*.ts`, `src/components/agents/`.

## Fixed in this pass

- **Late Allow grants never lapsed** (`agents/mcp.rs`). An Allow on a card
  nobody waited on granted that exact call "once", forever: an unused grant
  sat in a process-wide list and would let the same call through days later,
  and the list only grew. Grants now lapse after an hour (`LATE_GRANT_TTL`)
  and are swept on every lookup. Test: `a_late_allow_nobody_used_lapses`.
- **Desk and phone decorated a chat page separately.** `agents_messages` and
  the companion's `messages` each called the same five `apply` passes (work,
  logins, step-in, admin, remember) in their own copy; adding a sixth to one
  would have left the phone or desk stale. Now one `agents::as_shown`.
- **Dead paste-import path.** `agents_import_paste_prompt` and
  `agents_import_paste_preview` had no caller (the desk imports through
  `import_export.rs`); removed with their TS wrappers, harness fixtures, the
  three protocol methods the Mac never served (`agents.import.pastePrompt`,
  `.pastePreview`, `.paste`), the
  unused `ImportPreview` component and its CSS, and `paste::preview` /
  `PASTE_PROMPT` / the preview types.
- **Dead functions:** `usage_plan::forget_org`, `keys::fresh_colorway`,
  `browser_profiles::in_agents_browser`, `opencode::is_local`,
  `review::is_review` (Rust); `startAgentFresh` (TS; the phone calls the
  command through the router). Every registered Tauri command in these
  domains otherwise has a caller.
- **Launch cost is logged.** `[Startup] setup done` (how long setup held the
  window back) and `[Startup] agents' launch chores done` (the serial chain
  behind it, which ends with turn recovery). Not measured here: running the
  app would touch `~/Library` app data.
- **Two pure-move splits:** `companion/router.rs` (5310 → 3250 lines) and
  `agents/store.rs` (4042 → 2767) moved their test modules to
  `router_tests.rs` / `store_tests.rs`, the `#[path]` convention the
  `agents/` folder already uses. No code changed.

## Still to do, ranked

1. **Login cards read every log in full.** `store::login_cards` reads each
   agent's whole `messages.jsonl` and is called per agent by
   `logins::team`, `access_chain::seen` (every `request_login`) and
   `logins::answer_waiting_with`. Cache it by the same (log, answers) length
   stamp `pending_cards` uses.
2. **`approvals.jsonl` grows forever.** One line per answered card, and
   `apply_answers` parses the whole file into a map for every page holding
   a card. Parse only lines naming the page's request ids, or compact
   answers whose cards are answered in the log.
3. **Launch chores are serial and repeat every launch.** About ten
   `spawn_blocking` steps run one after another before
   `recover_after_restart`; `arrival::upgrade_all` reads every agent's
   `CLAUDE.md` each launch, and `logins::migrate_pending` / `team_setup::
   fold_cards` walk every agent's cards. Gate the once-only migrations
   behind a marker (as `other_app::migrate_names` does) and run the rest
   after recovery. Read the new `[Startup]` lines first.
4. **Rooms show cards without live state.** `rooms.rs` applies only
   `work::apply` to a member's lines, not `agents::as_shown`, so a login
   card's sign-in in progress or a step-in reads as it was written. Check
   it's not intended, then use `as_shown`.
5. **`paste.rs` is half test-only.** `parse` / `for_import` and their
   validation are reached only from their tests now; the live readers are
   `extract_blocks` / `parse_block`. Move the error-wording tests onto
   `import_export.rs` and delete the rest.
6. **Sync file reads on async workers** in `companion/desktop.rs`:
   `create_agent` (`store::list`, `defaults::view`) and
   `set_agent_independence` (`policy::load`, `store::get`). Small reads;
   wrap in `spawn_blocking` if the watchdog ever flags the phone server.
7. **Large files mixing concerns** (after runner): `agents/mcp.rs` 4.7k
   (approval decisions, tool handlers and routine lines), `agents/logins.rs`
   3.4k (flows, the team view, cards, migration), `agents/schedule.rs` 3.2k
   (tests from line 2097: the next pure-move split), `agents/connector.rs`
   3.2k; on the frontend `src/lib/agents.ts` 3k (types, invoke wrappers and
   pure helpers such as the team overview in one file) and
   `AgentChat.tsx` 2.3k.
8. **Exports used only in their own file** (`TEAM_SCHEDULED_MAX`,
   `TEAM_REPLIES_MAX`, `CONNECTOR_PEER`, `plainFileName` in
   `src/lib/agents.ts`). Trivial; drop `export` when touching them.

Looked at and fine: the companion journal (`hub.rs`, capped by entries and
age, superseded events blanked), upload and refusal maps (`blobs.rs`,
`limits.rs`), admin activity (capped at write), message paging (read from
the log's end), pending cards (cached by stamp), the `tokio` mutexes held
across awaits (all deliberate one-at-a-time gates), and every async Tauri
command in `commands/agents*.rs` (blocking work is on `blocking` /
`spawn_blocking` or `tokio::process`).
