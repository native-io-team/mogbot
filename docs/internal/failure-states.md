# When things go wrong

What the user is told for each failure, where, and the one fix. The rule: one
plain sentence saying what happened and the fix, a button that does it, in the
right place (a chat line, a bar, Needs you), with no stack traces, no raw
error codes, no blame and no duplicate alerts. Desk and phone use the same
words: the sentence is the Mac's (`agents/failure.rs`), everything said about
it (row line, pill, button) is `packages/companion-protocol/src/failures.ts`.

Audit of 2026-11-09. "Fixed" marks what this pass changed; the rest was
already right or is listed under "Still open".

| State | Where it shows | Words | Fix action | Test |
|---|---|---|---|---|
| Engine binary missing or moved (fixed) | Chat error card (desk and phone); row pill "Not installed"; Needs you | "Claude Code isn't on this Mac any more, or the app can't find it. Install it again, then send this again." Before: "Couldn't start Claude Code: No such file or directory (os error 2)" | Desk: **Install Claude Code** (opens engine setup at the install step), Retry. Phone: note "Install Claude Code on your Mac, then send it again." + Connection details | `failure.rs` `the_network_the_provider_and_a_missing_engine_are_said_plainly`; `AgentChatItems.test.tsx` "offers Install"; harness `agents-failure-engine-missing`; qa:web `probe-failure-gone` |
| Engine signed out mid-day | Chat error card; row pill "Signed out · Claude Code"; Needs you; phone Connection pill | "Claude Code is signed out." | Desk: **Sign in to Claude Code**. Phone: "Sign in to Claude Code on your Mac, then send it again." + Connection details | `failure.rs` `codex_says_its_own_failures…`; harness `agents-error`; qa:web `probe-failure-signed-out` |
| All accounts out of usage | Quiet chat line (not red, not Needs you); row pill "Out of usage until …" | "All 2 Claude Code accounts have reached their usage limit. The first is back at 3:00 PM." | Desk: **Retry at 3:00 PM**, Try anyway, Add another account. Phone: the line only | `wallet.rs` `the_all_out_line_reads_as_the_usage_limit`; harness `agents-usage-limit` |
| One account's token revoked | Chat error card | "Claude Code is signed out." | Sign in to Claude Code | Still open (see below) |
| Network down at turn start / mid-turn (fixed) | Chat error card; row "… couldn't reach Anthropic over the network · didn't finish" | "Claude Code couldn't reach Anthropic over the network. Retry once this Mac is back online." Before: "fetch failed: getaddrinfo ENOTFOUND api.anthropic.com" | Desk and phone (fixed: the phone had none): **Retry**. A routine retries by itself (still `is_temporary`) | `failure.rs` (as above); harness `agents-failure-offline`; qa:web `probe-failure-offline` |
| Provider overloaded / 5xx (fixed) | Chat error card | "Anthropic's servers are overloaded right now, so Claude Code stopped. Retry in a few minutes." / "OpenAI is temporarily unavailable (a problem on their side), so Codex stopped. …" Before: raw `API Error: 529 {"type":"error",…}` | Retry; routines retry | `failure.rs` (as above) |
| Anything else unnamed (fixed) | Chat error card | "Claude Code stopped with an error it didn't explain. Retry; if it happens again, start a fresh conversation." The raw output goes to the log. Before: stderr as-is | Retry | `failure.rs` `raw_output_never_reaches_the_chat_but_a_sentence_does` |
| Engine died twice in one turn (fixed) | Chat error card, Interrupted | "Interrupted: Claude Code stopped unexpectedly again, so this turn stopped part-way. Continue picks it up where it was." Before: "… again (Killed: 9) …" | **Continue** | `resume_runner_tests.rs` `an_engine_that_dies_is_picked_up_once_and_only_when_it_can_be` |
| Connector call, network down (fixed) | Agent's turn prompt / relay answer (the agent says it) | "… couldn't be reached this turn: its sign-in server didn't answer (this Mac may be offline). Don't ask for a sign-in…" Before: called an expired sign-in, so the agent raised a pointless login card | None needed: it works again once online | `connections.rs` `an_offline_refresh_is_not_called_an_expired_sign_in` |
| Mac asleep / app closed (phone) | Phone pill and bar; Connection screen | "Reconnecting…", "Can't reach Mac"; "Waiting for the app on your Mac" when it said it was quitting; Connection lists likely causes (asleep on battery, Tailscale off) | Open Tailscale; Try again | qa:web `offline-*`, `reconnecting-*` |
| Tailscale off | Phone Connection screen | "Tailscale may be off on this phone or on the Mac" | **Open Tailscale** | qa:web `offline-connection` |
| Paired phone revoked (fixed) | Phone Agents tab, pill, Connection screen | "Not paired any more"; "Your agents are still on <Mac>. Pair again to see them here." Before, Connection showed the Mac's raw refusal and offered Open Tailscale, which can't help | **Pair again** (Agents tab and, fixed, Connection) | qa:web `probe-revoked-connection` |
| Disk full, agent home writes fail (fixed) | Any agents command error; a turn's failure line, or an alert if the line itself can't be written | "This Mac is out of disk space, so the app couldn't save that. Free up some space (Settings → Agents shows the largest agent folders), then try again." Before: "I/O error: No space left on device (os error 28)", and a turn's error line was lost silently | Settings → Agents → Free up space | `agents/mod.rs` `a_full_disk_is_said_with_its_fix_never_the_os_error` |
| Disk low (fixed) | Quiet note in the Chief's chat; one alert at the floor | "This Mac is nearly out of disk space: 3.2 GB free. Agents now ask before installing packages or cloning. Settings → Agents shows the largest agent folders." | **Free up space** button on the note (new `NoteFix::Disk`) | `chrome_health.rs` `the_button_matches_the_note` (wire value); harness `agents-probe-disk-line` |
| Corrupted settings file | Chief's chat note | "<What> couldn't be read, so it starts fresh. The damaged copy is kept beside it as <file>." | None needed | `survive_tests.rs` |
| Connector OAuth expired | The agent's login card when it needs the app; Apps shows "Needs sign-in" | "Needs signing in again" | **Sign in again** (Apps), or the login card | `logins.rs`, `connections.rs` |
| Chrome extension disconnected (fixed) | Quiet note, once per outage | "Chrome isn't reachable: Claude's extension isn't answering and Your Chrome isn't connected. Open Chrome and Your Chrome reconnects by itself…" | **Check Your Chrome** (fixed: it said "Set up Your Chrome", contradicting the note) | `chrome_health.rs` `the_button_matches_the_note`; harness `agents-probe-chrome-down-*` |
| Routine fails 3 times in a row (fixed) | "When…" routine: note in its chat; time routine: alert on first and last failure | "“Triage mentions” paused itself after 3 runs in a row didn't finish: Claude Code is signed out. Resume it from the schedule when it's fixed." Before: "paused itself. Paused after …" | Resume from the schedule | `watch_tests.rs` `a_routine_that_paused_itself_says_so_once` |
| Remote Access funnel down | Sidebar indicator; Remote access modal | "Remote access stopped · Your assistant can't reach this computer. Open Remote access to restart it." | Open Remote access | Still open (see below) |
| Approval card expired while away | The card itself, redrawn as expired | The card's own expired state; the agent is told | None needed | `expiry_tests.rs` |
| App updated / restarted while a turn ran | Chat error card, Interrupted; or a quiet "Picked up after the app restarted" | "Interrupted: the app closed while this agent was working, so the turn stopped part-way. Continue picks it up where it was." | **Continue** (fixed: in What's in flight it resent the original request, which could do the work twice) | `resume_runner_tests.rs`; harness `agents-failure-interrupted`, `agents-team-failure-kinds`; qa:web `probe-restarted` |

## Still open

- **One account of several revoked.** The account isn't marked signed out, so
  the next turn picks it again; the line doesn't name the account. Needs a
  per-account sign-out in `wallet` and a switch like the usage-limit one.
- **Remote Access funnel drops later in the day.** The watchdog stops once
  the link is reachable, so nothing notices it going down; the setup steps
  also show Tailscale's raw text.
- **"When…" check errors** (a gh stderr line, a model check's own text) still
  reach the pause note verbatim.
- **Connector sign-in expired** raises no note of its own until an agent
  needs that app.
- **Phone usage-limit line** offers no Retry at the reset (the desk does).
