# Persona review: usage limits and account stacking, 2026-11-09

An adversarial read of `mogbot/foundation` (f2b0ff64) on one area only: usage limits, the modes,
the spare-capacity list, failover and crossover, and stacking accounts. Four personas, each walked
through the real UI and the code paths. Another agent is redesigning the sidebar usage row and the
Limits view (pace markers); recommendations for its files are marked **[redesign]**. Fixes here stay
out of `AccountSwitcher.tsx`, `AgentsUsageView.tsx`, `UsageStack.tsx`, `usage-view.css` and
`usageGlance.ts`.

**How it was looked at.**

- Desk: `pnpm harness` on port 2237 with its own `TMPDIR`; `usage-*` (one, three, one-out,
  near-empty, reset-soon, unknown, same-account, where-did-it-go, each with its sidebar row),
  `agents-crossover-*`, `agents-runs-on`, `agents-chat-usage*`, `agents-team-spare-capacity`.
- Phone: `pnpm qa:web --phases usage-accounts` (two-claude, one-read), dark.
- Code: `wallet.rs` (choose, failover, mark-out), `runner.rs` (`run_on_engine`,
  `crossover_situation`), `usage_plan.rs` (spare, nudge), `usage_tools.rs` (`nudge`, `spend_now`),
  `inventory.rs` (`same_as`, `build`), `compute.rs`, `usage_read.rs`, `commands/accounts.rs`
  (the add-account sign-in), `follow_up.rs`, `prompts::usage_section`.

**Not checked:** a live exhausted account, a live failover or crossover, the Tauri build, a
signed-in Codex account, a real Team/Enterprise seat, and whether a setup token's answer carries
`anthropic-organization-id` at all (still unobserved; see Stacker bug 2).

---

## Bugs found and fixed here

| # | Persona | Bug | Fix | Test |
|---|---|---|---|---|
| 1 | Maximizer, Adversary | A 5-hour window near its reset was "spare" even when the same account's week was nearly or wholly used up. "Use it all" then woke the Chief to spend the 5-hour room, which spends the *week*: exactly the capacity that doesn't expire soon. | `usage_plan::spare` keeps a window only when the account's other plan windows (5-hour, weekly; per-model ones like Opus excluded) each have ≥ 25% left and aren't limited (`others_can_take_it`). | `a_window_is_not_spare_when_another_limit_on_the_account_has_less_left` |
| 2 | Adversary | An account that can't run offered spare capacity from its last reading: out until a reset, signed out since, or a second sign-in of an account already listed (the same window offered twice). | `inventory::build` builds spare windows only from accounts signed in, not out, and not `same_as`. | `an_account_that_cant_run_offers_no_spare_capacity` |
| 3 | Stacker | The duplicate-account trap in failover: when This Mac's account hit its limit, failover switched to "Personal Account" (the same account signed in a second time), posted "Switched to Personal Account", and spent a refused try on it. The background read marking one out didn't mark its twin either, so the sidebar called the twin "Next". | `wallet::mark_out_with_twins` / `reported_out_with_twins` mark every known sign-in of the same account (`twins_in`, the Usage view's own `inventory::same_as` rule: same org, not a seat plan, never guessed). Used by failover, the mid-turn `rate_limit_event` and the background read. | `a_second_sign_in_of_an_account_is_out_with_it` |
| 4 | Stacker | Adding an account never said that the browser decides who signs in. The email field reads like it picks the account; it is a label. That is how the owner got two entries for one gmail account while you@work.example was never added. | `AccountSignIn` says, before the terminal starts: the browser signs in as whoever claude.ai (or ChatGPT) is signed in as there; sign out or switch first, or open the link in a private window (`SIGN_IN_BROWSER_NOTE`, `lib/agentAccounts.ts`). | `AccountSignIn.test.tsx` |
| 5 | Stacker | A duplicate was only noticed at the first usage read (up to 30 minutes later for a setup token), never at sign-in, though the sign-in already makes a one-token request. | `claude_token_check` (was `claude_token_is_rejected`) keeps the `anthropic-organization-id` header when the answer carries one and records it right after the token is stored, so "Same account as …" can show at once. Unverified: the header has not yet been observed on a setup token's answer. | none (network) |
| 6 | Maximizer, Adversary | "Give agents something to do" pressed twice (or while "Use it all" was already starting the window) queued the same list for the Chief twice, so items were handed out twice. | `spend_now` answers "… is already starting your spare-capacity list for this limit." when the Chief was woken for that window and hasn't finished (`usage_plan::already_starting`). | `a_second_press_while_the_chief_starts_the_window_is_not_a_second_start` |

---

## (a) The Saver: one Claude Pro account, keeps hitting the 5-hour wall

**Journey.** Opens the sidebar row: "Room to work" and one segment. Clicks it: the Usage view, the
mode control right under the hero ("Normal / Save my limits / Use it all before reset") with one
line for the selected mode. Picks Save my limits. Opens "Where did my usage go" and sees which
agent and routine moved the meter. Pauses a routine from its editor. Sets an agent's model from
its … menu. Hits the wall: the chat says "Claude Code is out of usage until 4:00 PM", Retry at
4:00 PM; a routine that failed on the limit retries at the reset (5-hour only; a weekly reset
isn't waited for).

| | Rating |
|---|---|
| Finds "Save my limits" | 4: one click from the row, on the view's first screen |
| Understands what it does | 2: one line; nothing says it is *instructions to agents*, not a throttle |
| Sees what burns usage | 4: "Where did my usage go" per rise, by agent and routine |
| Caps or pauses an expensive routine | 2: pause yes, a cap no |
| Cheaper models per agent / routine | 2: per agent yes, per routine no |
| Warned before the wall | 2: amber at 90%, a pace line, but no notification |
| Doesn't lose work at the wall | 4: ends on a line with Retry at; routine retries at a 5-hour reset |

**Findings.**

1. "Save my limits" changes no mechanism except follow-ups (`follow_up.rs` asks instead of
   scheduling one) and the Chief's `forecast_usage` `ask_first`. Routines still fire on schedule
   at 95% used; a fan-out with no forecast asks only if the agent remembers to forecast.
2. No per-routine model. A Saver's biggest lever (run the hourly inbox check on Haiku) isn't there.
3. No warning that reaches them away from the window: nothing fires at 90% or when the pace line
   says "runs out before reset".
4. With one account that is out, every routine due fires a turn that is refused at once (cheap,
   but a failed run each time in its history).

**Recommendations, ranked.**

1. In Save, routines due while the account in use is past 90% of a window (or out) wait for that
   window's reset, one Note per routine, instead of running; manual runs still run.
2. A model per routine (defaults to the agent's), picked in the routine editor, desk and phone.
3. One notification (desk and phone) the first time per window the account in use crosses 90%, or
   when the pace estimate says it runs out more than an hour before reset, with "Switch to Save my
   limits" when not already on it.
4. **[redesign]** Under "Save my limits", say what it does in two short lines: "Agents ask before
   heavy work and send light work to lighter models. Routines still run on time." (Change the
   second line if recommendation 1 lands.)
5. A per-routine weekly token cap ("pause it after 2M tokens this week"), from the routine's
   "Where did my usage go" row.

## (b) The Maximizer: two Max accounts and ChatGPT Pro, wants nothing left at reset

**Journey.** Adds both Max accounts and a Codex account (one click each from the view). Picks
"Use it all before reset". The `usage-reset-soon` sheet: "62% of sam@example.com's week resets in
9 h", the first items of the list and "Give agents something to do". Adds items at the bottom of
the view or tells any agent "sometime, when there's spare capacity" (`add_spare_work`). On the
phone, the Usage sheet is read-only: the list, the mode and "Give agents something to do" aren't
there, so adding from the phone means asking the Chief in chat. The hero shows each account's
tighter limit as one segment; failover and crossover are explained under the keys.

| | Rating |
|---|---|
| "Use it all" queues useful work | 3: it does, once per window, for the account in use only (and before fix 1 it could burn the week) |
| How much will expire, and when | 2: one sentence for the account in use; nothing across accounts |
| Adding to the spare list | 3: desk yes, phone only via chat |
| Failover mid-turn | 4: carries the session, one Note; unverified live |
| Crossover to Codex | 4: Ask first / Carry on / Wait, one card; unverified live |
| Total stacked capacity and pace | 3: segments per account, no total figure or stacked pace |

**Findings.**

1. Spare capacity on the accounts *after* the one in use is never spent: `should_nudge` only takes
   `next`. With two Max accounts in order, the second one's weekly room expires untouched every
   week unless the user reorders. (Kept by design: "spare capacity on another account wouldn't be
   what the work spends". But a turn can be *sent* there with "Use this one now".)
2. The nudge says the window's own figure ("62% left"); after fix 1 it is offered only when the
   other window has ≥ 25% left, but the sentence can still promise more than the week can take.
3. The phone can't change the mode, add to the list or press "Give agents something to do".

**Recommendations, ranked.**

1. "Use it all" spends expiring room on any account: when a window on a later account is spare and
   the one in use isn't near its reset, the Chief's wake runs the list *on that account* (a
   per-turn account override, like Runs on but for that one wake), so the second Max's week isn't
   wasted.
2. **[redesign]** One line in the hero: "About 40% of a week expires unused Thu 6 PM at this pace"
   (an estimate, labelled), summing the spare windows across accounts; the pace markers make it
   visual.
3. Phone: the mode control (behind the card it already needs on desk via `set_usage_mode`), "Add
   to the spare list" and "Give agents something to do" on the Usage sheet. Needs
   `agents.usage.setMode`, `agents.spare.add`, `agents.spare.spendNow` in the protocol.
4. **[redesign]** The nudge names the room the account can actually take: the smaller of the
   window's room and the week's, not the window's figure alone.
5. **[redesign]** A total across accounts per engine ("Claude: 2 accounts · 140% of a week left"),
   or an explicit "together" bar, with Codex on its own line.

## (c) The Stacker: personal + work + a friend's seat, keeps adding

**Journey.** Adds "Work" from the Usage view: types you@work.example, the browser opens
already signed in to the personal gmail claude.ai, the code is pasted, and the key says
"you@work.example", the email typed. Before fix 4 nothing warned; now the sign-in says the
browser decides. Reorders by drag (keyboard too), renames from …, removes (waits for a running
turn). Pins an agent with "Runs on". The `usage-same-account` scenario names the duplicate well
("Same account as sam@example.com", an amber fix line, "Sign in with another account"). On the
phone, Codex's account is numbered "1" right under three Claude accounts numbered 1–3, with no
engine shown, so it reads as a second first account.

| | Rating |
|---|---|
| Add / remove / reorder / rename | 4 |
| The duplicate-account trap | 2 → 3 with fixes 3–5 (still depends on an org header that may never come for setup tokens) |
| Team / Enterprise seats | 3: seats are never called duplicates; nothing shows "seat of Acme" |
| Signed out / expired | 4: "Not signed in" with the one fix and a Sign in button |
| Codex workspaces | 3: identity by `chatgpt_account_id` + user; unverified against a signed-in account |
| Which account each agent runs on, pinning | 4: chat chip, Runs on with "· only" |

**Findings.**

1. The typed email is shown as who the account *is*, beside emails the engines' own files report.
   When they differ (the owner's case), the key is wrong in exactly the way that hides the trap.
2. For a setup-token account the only identity signal is the org header, still unobserved on a
   setup token. If it never comes, duplicates are never detected. The figures moving in lockstep
   was the owner's real evidence, and the rule "never guessed from figures" leaves it unused.
3. Phone list numbering restarts per engine without saying which engine.

**Recommendations, ranked.**

1. **[redesign]** Mark a typed email as a label, not an identity: "you@work.example (you typed
   this)" until the engine reports who it is, and never show it as the plan line's who.
2. Lockstep as a *question*, not a verdict: when two accounts' weekly readings share the same reset
   to the second and move together across 3+ readings with no turn on one of them, show "These
   may be the same account" with the same fix line, worded as a possibility. It never changes the
   totals or failover (the "never guessed" rule holds for counting).
3. At sign-in, if the org header names an organization already in the list (fix 5), say so in the
   sign-in modal itself before closing: "This signed in as the same account as sam@example.com.
   Sign out of claude.ai and Start over?"
4. Phone: label the engine on the numbered list ("Claude 1–3", "Codex 1"), or one heading per
   engine, matching the desk keys.
5. **[redesign]** Show a seat's organization on its key ("Acme · Team seat") so two seats of one
   org read as two people, not a duplicate.

## (d) The Adversary: making the numbers lie or the app overspend

| Probe | Result |
|---|---|
| Stale reading | Holds: age said past 6 h; windows past reset dropped (`quota::shown`) |
| Unknown reading as room | Holds: "No reading yet", dashed slot, never counted as room (`compute::room`) |
| Reset already passed | Holds: `Account::out` and `quota::shown` both drop it |
| Spare from an account that can't run | **Bug 2, fixed** |
| 5-hour spare spending the week | **Bug 1, fixed** |
| Routine storm while all accounts out | Holds with 2+ accounts (`choose` returns AllOut, no try); with one account each due routine spends one refused try (see Saver 4) |
| Many agents in "Use it all" | Holds: one wake per window instance, recorded before waking, 30-min slack on drift; only the Chief is woken |
| Double "Give agents something to do" | **Bug 6, fixed** |
| Failover loop between two exhausted accounts | Holds: an account is never tried twice in a turn, `MAX_SWITCHES` 4, unknown-reset outs last an hour |
| Failover onto the same account twice | **Bug 3, fixed** |
| Crossover ping-pong | Holds: crossover only when home has no room; back only when home has room |

**Recommendations, ranked.**

1. With one account out until a known reset, skip the try (as `pinned_and_out` already does for a
   pinned agent) and mark the routine's run "waiting for the reset" instead of failed.
2. `reported_out` keeps an account out until the reported reset even if a later read shows room
   (an upgraded plan, extra usage bought). A fresh read with room should clear a limit hit whose
   reset is still ahead.
3. The mid-turn `reported_out_with_twins` reads identities (files and the Keychain email) on the
   turn's stream loop. It runs only on a used-up reading, so it is rare; if it ever shows in a
   profile, move it to `spawn_blocking`.
