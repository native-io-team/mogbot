# The first five minutes with the Chief, 2026-11-10

A walk of what a new user meets once onboarding hands over: the Chief's stored greeting, the
starters under it, the first message and the first seconds after Send, the first replies, and the
cards around them. Bar: impressed, obviously useful, nothing invented.

**How it was looked at.** `pnpm harness` on port 1477 with its own `TMPDIR`, both themes,
`agents-first-*` (12 scenarios before, 15 after). The fake-engine suite
(`scripts/agents-fake-e2e.sh`) for the turn path, with a new `first-run` scenario. The Chief's
system prompt (`prompts.rs`: `CHIEF`, `CHIEF_INSTRUCTIONS`) and `create_agent`'s description read
in full.

**Not checked.** What a real model says on its first turn: the fake runs a script, so the new
`first-run` scenario proves the path (draft card, routine, first run, result card), not the
Chief's judgement. `agents_fake real-chief` with `AGENTS_REAL_CLAUDE` would show it; not run
(real usage). The phone app (only its chip list and QA caption changed). WKWebView.

## What was wrong

1. **The chips led to a slow or absent first result.** "Sort my inbox, draft replies" needs an
   email app connected before anything comes back, so a third of the first screen started with a
   sign-in. There was no "make me an agent" way in, though making agents is the product, and
   nothing personal.
2. **The first seconds after Send showed nothing.** The Chief's status went to working only once
   its engine was spawned. Measured on the fake engine: 0.56, 0.64 and 1.1 s after Send, with a
   first-launch run over 1.5 s; for a bound agent, its project copy comes first. And when the
   status did arrive with no step yet, the chat's working line drew a pressed key with no words
   (the sidebar row and the phone said "Thinking"; the desk's chat didn't).
3. **Skipping the import card stuck it at the top of the chat, and hid the phone for good.**
   The most common first run is to ignore "Already have agents in another assistant?" and type.
   The answer stayed `undecided`, so the card moved above the greeting for every later visit,
   and the phone offer, which waits for that question to be settled, never came.
4. **The draft-first reply was prose.** The prompt asked for a draft "in one reply … ending
   'Make it?'": a paragraph to read and a yes to type, where a card and one tap say it better.
5. **A one-off left nothing running.** After a researched answer the Chief had no nudge to turn
   it into a routine, which is the thing a chat assistant can't do.

## What changed

- **Four chips, none needing setup** (`packages/companion-protocol/src/chiefIdeas.ts`):
  Brief me every morning, **Make me an agent** (new), Research it and write it up, Plan a trip.
  Every morning, an agent of your own, work written up, something personal. The inbox idea stays
  in More ideas…. "Make me an agent" types a brief that asks for the draft first, a yes before
  anything is made, then the first run now. Tests in `ChiefIdeas.test.tsx` hold the order, that
  no chip needs a connection or folder, and the draft-first wording. The phone shares the list.
- **Working from the moment the turn is taken** (`runner/drain.rs`): the status goes to working
  as soon as the batch is taken, before the copy, account and engine are ready (not for a room's
  turn, which says so in its room). Fake engine after: 177, 133, 32 ms after Send.
- **"Thinking" before the first step** (`AgentWorkingIndicator.tsx`, `NO_STEP_YET`): the chat's
  line says what the sidebar row already said; `bare` keeps it wordless during an import, where
  the bar above the composer speaks. Tests in `AgentWork.test.tsx`.
- **Going past the import question settles it** (`import_choice::Choice::Skipped`,
  `skip_if_undecided`, called from `runner::record` on the user's message to the Chief): the
  card at the top of the chat and the phone's home stop asking, without recording a "no" they
  never said; an import later still makes it `imported`. Older builds read the new word as
  undecided (the lenient reader). So the phone offer comes after the first result, and the order
  of offers is: the import card under the greeting until they speak or answer, then, once
  something came back, the phone card. Never two at once. Test in `import_choice.rs`.
- **The draft is one card** (`prompts.rs` `CHIEF`; `create_agent`'s description in `mcp.rs`):
  one `show` with `facts` (name, role, each routine with its time, the apps), the briefing as its
  text, and `choices` "Make it?" with Make it / Change something. Within the Chief's budget.
- **A one-off offers a routine** (`CHIEF_INSTRUCTIONS`; the old text added to
  `PAST_CHIEF_INSTRUCTIONS`, so an unedited Chief is upgraded): once a one-off worth having again
  is handed back, one line offering it as a routine, with a time.
- **Fake-engine `first-run`** (`src-tauri/examples/agents_fake/first_run.rs`, first in the
  default run): the chat opens on `CHIEF_GREETING`; the "Make me an agent" brief sent with the
  import question open; working within 750 ms with no reply yet; the question now `skipped`; the
  reply one `show` of facts and choices with no agent made; "Make it" makes AI News with its one
  routine and a first task that ends on a result card in its own chat.
- **Harness:** `agents-first-run-sent` (a second after Send: "Thinking"),
  `agents-first-run-draft` (the draft card), `agents-first-win-make-agent` (the chip's brief),
  `agents-first-result-phone-offer-skipped-import`; the inbox chip scenario went with the chip.

Left as it was, on purpose: **the greeting**. It says the one thing a chat assistant can't (the
team keeps working on a schedule or a trigger and brings results back) and that anything
outward waits for an OK; with four concrete chips under it, a longer greeting would only push
them down.

## Before / after

Session scratchpad `fcm/before/{dark,light}/` and `fcm/after/{dark,light}/`:
`agents-first-run.png` (three chips, inbox among them → four, none needing setup),
`agents-first-run-sent.png` (new; before the fix it was a key with no words),
`agents-first-run-draft.png`, `agents-first-result-phone-offer-skipped-import.png` (new).

## Verified

`pnpm test:run`, `pnpm typecheck`, `pnpm check:patterns`, `cargo test --lib agents::`, the full
fake-engine suite (46/47 in one run: `opencode` failed once with "the reply never streamed as a
draft" in 1.5 s under load, then passed 4 of 4 alone and after `interrupt codex codex-app`).

## Left, ranked

1. **Run `real-chief` with the "Make me an agent" brief** to see whether a real Chief draws the
   draft as a card and runs the first task on yes. The fake proves only the plumbing.
2. **An optimistic working line on the desk** for the remaining tens of milliseconds between
   Send and the status event. Small now; would matter on a slow Mac. (The phone's line already
   says "Thinking" with no step, `mobile/src/lib/agents.ts` `workingLine`, and gains the earlier
   status from the same Mac change.)
