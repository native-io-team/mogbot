# Persona review: developers and power users, 2026-11-09

Three adversarial readers of `mogbot/foundation` (f2b0ff64d):

- **The CLI engineer.** Lives in Claude Code and Codex in a terminal. Skeptical of wrappers.
  Wants speed, the keyboard, and to see exactly what ran, what changed, on which model and account.
- **The agency owner.** 15+ agents across client projects, with routines, Slack, GitHub and Vercel.
  Wants to see it all at once, act in bulk, and not drown in noise.
- **The security-minded dev.** Tries to get an agent past the approval wall with outside text
  (When… routines, Slack, recipes, imports, this Mac's apps), and checks what leaves the machine.

**How it was looked at.** Code read for every security claim (three read-only audit passes, each
finding then checked by hand before it was fixed or listed). The harness ran on its own port and
`TMPDIR`, but the machine was saturated by parallel builds: the ⌘K `--commands` sweep hit its
2700s cap after 10 commands (all passed) and the scenario captures didn't finish. The keyboard and
palette findings below are from the command registry (`useAgentsCommands.tsx`, `AgentsView.tsx`,
`AgentChat.tsx`, `useAgentKeyShortcuts.ts`), not from screenshots.

**Not checked:** a live turn on either engine; the Tauri build in WKWebView; the phone on a device;
Slack and GitHub against live accounts. Every security finding below is from reading code and from
unit tests, not from an exploit run end to end.

---

## Security findings (first)

### S1. Outside text in a turn's prompt didn't mark the conversation (fixed, high)

**Where.** `runner.rs` (`take_batch` sets `runtime.outside`), `exposure.rs`.

**What was wrong.** A "When…" routine's items (a GitHub issue title, a new file's name), someone
else's Slack message and a tainted agent hop set `runtime.outside` for the turn answering them. That
turn is capped. But the mark that makes later turns ask before sending (`exposure`) was only ever
set by *tool reads*. Routines run in the conversation they were set up in, so the attacker's text
stayed in the engine's context and the user's next turn there, at Bold or Unleashed, sent to the
network and fetched new packages with no card. `exposure.rs`'s own doc names this as the reason the
mark lasts the conversation.

**Fixed.** `exposure::begin_turn(agent, resumes, answering_outside)` marks the conversation when the
turn answers outside text. Test: `exposure::tests::outside_text_in_the_prompt_marks_the_conversation`.

### S2. Replace kept the old agent's trust under foreign instructions (fixed, high)

**Where.** `review::replace_in_place` (connector imports, export files, recipes).

**What was wrong.** Replace cleared rules, project, session, routines and logins, but not the
agent's own policy: an Unleashed level, the browser, exact-text off, the admin role, and live plan
grants all carried over to instructions written by someone else. The Replace card says it resets;
the strongest settings survived.

**Fixed.** `policy::narrow_for_replace` takes back every own setting wider than the team's (level
above the team's, browser on, exact-text off) and the admin role; stricter choices stay.
`plan_grant::drop_holder` ends any yes given to the old instructions. Tests:
`review::tests::replace_takes_back_trust_given_to_the_old_instructions`,
`review::tests::a_stricter_own_level_survives_replace`.

**Still open.** Own scopes (`apps`, `folders`, `projects`) carry over: they can't be ordered
"wider/narrower" than the team's without a rule per field. The Replace card should list them.

### S3. An unreviewed import command was still registered (fixed, medium)

**Where.** `agents_import_paste` (`commands/agents.rs`, `lib.rs`).

**What was wrong.** The old Paste path imported straight away: routines **active**, an agent of the
same name overwritten in place with its rules, level and admin role intact, and `is_main` text
appended to the Chief's instructions. No UI called it; docs said it stayed "for older clients", but
the webview ships with the app, so there are none. Reachable only from webview JS.

**Fixed.** Removed (command, wrapper, fixture, `import_and_notify`). Remote Access's
`import_agents` already stages for review (`connector::stage_one_shot`).

### S4. An admin's resume woke routines an import had paused (fixed, medium)

**Where.** `admin::pause`.

**What was wrong.** Pause stamped `pausedByAdmin` on *every* paused routine, including ones the
user paused and ones an import paused for review. A later resume switched them all on
(`set_paused(false)` also clears `paused_on_import`), so imported routines started without the
user's checklist.

**Fixed.** Only routines that pause switched are stamped (`admin_switches`). Test:
`admin_tests::an_admins_resume_wakes_only_what_an_admin_paused`.

### S5. A second Claude account's token wasn't known to redaction (fixed, medium)

**Where.** `wallet::env_for`.

**What was wrong.** `CLAUDE_CODE_OAUTH_TOKEN` for a non-default account goes into the turn's
environment but was never registered with `secrets::remember_external`. An `env` or a script echoing
it would carry it into `messages.jsonl`, "What it did" and the phone.

**Fixed.** Registered on every `env_for` (the registry dedupes).

**Still open.** The per-turn bridge secret isn't registered either. It dies with the turn, so it's
low, but registering it would cost one line.

### S6. `curl` without a scheme didn't count as an outside read (fixed, medium)

**Where.** `autoallow::outside_simple`.

**What was wrong.** `curl`/`wget` only marked the turn when an argument held `://`. `curl
evil.example/x`, `curl "$URL"`, `curl -K cfg` and `wget -qO- host/x` read the web unmarked.

**Fixed.** `curl_reads_outside`: with no full address, only a target naming this Mac is local;
flags alone (`--version`) read nothing. Tests in `exposure::tests`.

### S7. Reads that still don't mark (open, a decision)

- `gh pr view N` (body), `gh pr diff`, `gh issue list`, `gh search`, `gh release view`,
  `gh repo view`, `gh run view --log`, and `gh api …/pulls|contents`. A fork PR's body or diff is
  the classic injection vector. `gh pr view` was deliberately left unmarked (`exposure.rs` test)
  because most PRs are the owner's own. **My read:** mark `gh pr view|diff` and `gh run view --log`
  when the PR's author isn't the signed-in user; the cost at Bold is small (pushes already ask).
- Any other fetcher: `python3 -c urllib…`, `node -e fetch`, `xh`/`http`, `git fetch` + `git log`,
  `sqlite3 ~/Library/Messages/chat.db` (reading Messages around the app's own Messages tool,
  which does mark). A denylist can't close this; treating unknown network-capable programs as
  outside would.
- Browser `javascript_tool` returning `innerText` from a tab the user already had open (a
  `navigate` marks; reading an existing tab may not). Suspected, not verified.

### S8. Smaller

- `MIN_REDACT` is 6: a short PIN entered on a secret card isn't redacted.
- `navigation_guard.rs` logs the full URL of a navigation sent to the browser (a signed query or an
  OAuth code would land in the log).
- `store::prepend_log_block` (Ship Studio import) writes the other app's lines without redaction.
- Ship Studio import keeps `extra["admin"]` and the project binding (`other_app::adopt`). The user's
  own other app, so low, but the preview doesn't say "arrives as an admin".
- The Remote Access token is a 0600 JSON file, not the Keychain, which the security model's wording
  implies.

### Confirmed holding

Keychain writes take the secret on stdin (`keychain/macos.rs`); bridge secrets never on argv
(`reach.rs` 0600 config, Codex `bearer_token_env_var`); a source-scan test fails any
`#[tracing::instrument]` leaving a secret-named argument unskipped (`commands/mod.rs`); connection
tokens only in the relay (`conn_relay.rs`, drops incoming `Authorization`, no redirects); Slack
"own" is the user id, bots and app posts skipped; this Mac's apps mark every read; Codex tool calls
are observed like Claude's; recipes can only lower a new agent's level; imported routines arrive
paused; no import grants a login.

---

## Top 10 for these personas (ranked)

1. **Say which account and model ran each turn.** The CLI user's first question. Today the timeline
   and result card don't say; Usage aggregates by agent. Read the engine's own init event (model) and
   the wallet's chosen account, and put "Claude Max · Opus" on the folded "What it did" header.
   Never inferred: absent when the engine didn't say.
2. **"Show exact command" on a step, desk only.** "What it did" deliberately shows only "Ran git
   push", never arguments. Safe, but a senior engineer can't trust what they can't see. Behind a
   disclosure, through `secrets::redact` + `scrub`, never on the phone or in notifications.
3. **Show what it was told.** The appended system prompt (`prompts.rs`, policy section, outside
   note) is invisible; only the user-written instructions are editable. A read-only "Briefing this
   turn" view would answer "why did it do that" without reading Rust.
4. **Mark fork PR reads (S7).** The one remaining injection vector a GitHub-heavy agency hits daily.
5. **Bulk actions for 15+ agents.** No multi-select; pausing every routine before a client freeze
   means opening each agent. A "Pause all routines" palette command and a routines overview across
   agents (next run, last result, cost) are the agency owner's main screen.
6. **Group by client/project.** Rooms are conversations, not folders; the sidebar is flat (pin,
   mute, hide). A project-bound agent could group under its project automatically.
7. **Palette coverage for the copy-per-task flow.** Keep changes / Review changes / Discard live
   only on the card. "Review {agent}'s changes" and "Keep" in ⌘K, with the diff stat in the title.
8. **Stop and "next needing you" are there (⌘J, Stop {name}); Allow/Deny the top card have no
   key.** `agents.allowTop`/`denyTop` exist in ⌘K only; a CLI user expects y/n. A one-key Allow is
   a real risk (a reflex yes on a card not read), so: keys only while that card has focus in the
   open chat, never from the sidebar or the palette's first result.
9. **Log file reachability.** `~/Library/Logs/<app>/` holds the truth for "why did that turn die";
   no palette command opens it or copies the last turn's log lines.
10. **Engine parity statement.** Codex runs everything Claude Code does here, but the "Take over"
    terminal, `--resume` vs app-server, and which features need Claude (Chrome) are spread across
    agents.md. One table in Settings → Agents would stop the "is this a Claude-only wrapper"
    objection.

**What would make them switch.** Not the chat: they already have one. Routines with honest
outcomes, the approval wall that holds under outside text (now tighter), a copy per task with
Keep/Discard, and the phone for approvals. What would stop them: not seeing the exact command,
model and account. Items 1–3 are the gap.

---

## Fixed in this pass

S1–S6 above, each with a test. Docs: `agents.md` no longer says the paste command stays.

## Checks run

`cargo test` (agents and full crate), `pnpm test:run`, `npx tsc --noEmit`, `pnpm check:patterns`,
`pnpm docs:check`, all passing (cargo: 3820 passed). Harness palette sweep on port 2137: partial,
see above.
