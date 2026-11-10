# Phone regression sweep, 2026-11-10

A sweep of the companion app on `mogbot/foundation` (1ce92c25d) after the night's phone work: the
usage glance and Usage screens, Catch up's Recently, the connection bar, first run and the Chief's
ideas, result cards, blocks and the morning brief, request sharing (`reads.ts`), step in from the
phone, the badge, rooms, and agent creation with the routine picker. The question was where those
changes clash with each other.

**How it was looked at.** `cd mobile && pnpm qa:web --web-port 8211 --mock-port 47611 --cdp-port
9811`, light and dark, every default phase plus `link-down` and `net` (601 shots, 2525 s). Every
`report.md` failure was re-run on its own, and the screens the night touched were read as contact
sheets. The fixes were re-shot with the affected phases (`live`, `first-run`, `usage-accounts`,
`probe`, `link-down`) and then the whole default run again, light and dark: 621 shots, 2 failing,
both the torture chat in #13 (`torture-events` light, `torture-reconnect` dark; each passed in the
other theme or the other run).

**Not checked:** a device or simulator (no safe areas, no iOS large titles, a JS tab bar); iOS
Dynamic Type itself (react-native-web reports `fontScale` 1, so "Largest" here is the app's own
Settings → Text size); VoiceOver; the desk.

Ranked worst first. "Fixed here" items have a commit on this branch; the rest are left, with
whose they are.

---

## 1. The crossover card's answers hung off the card and cut its paragraph (fixed here)

**Where.** `probe-crossover`, both themes. `mobile/src/components/ApprovalCard.tsx`
(`cardStyles.answers`).

Wait, Just this time and Always each take a row (`ACTION_ROW`, `flexBasis: '100%'`). Their
container had `flexGrow: 1` and no width, so it was sized to its content: three full-width buttons
side by side, wider than the card. Right-aligned in `CardActions`, it ran past the card's left
edge, and the card, now taller than the pane, fitted its paragraph into a clipped scroll cut
through mid-line. The container is now the card's width (`width: '100%'`), which every other
answer row already filled by growing.

## 2. Rooms disappeared from Agents while the Mac was away (fixed here)

**Where.** `link-down-agents`, `offline-*-agents`. `mobile/src/app/(tabs)/agents/index.tsx`.

Rooms were drawn only when the live `welcome` frame offered them, so the moment the link dropped
(or on a cold start offline) the list lost its Rooms section and its "Agents" label, while the
agents above stayed as last seen. Offline it now shows the saved rooms, which are only ever kept
from a Mac that offered them; a connected Mac still decides as before.

## 3. Directions to a setting that moved (fixed here)

**Where.** `probe-crossover` ("Change it in Settings → Agents → Usage"), the Always button's
VoiceOver hint, Settings → Usage's footnote, and the Chief's "isn't signed in" tool error.
`src-tauri/src/agents/crossover.rs:430`, `src-tauri/src/agents/usage_tools.rs:517`,
`mobile/src/components/ApprovalCard.tsx`, `mobile/src/app/settings.tsx:54`.

Settings became a window of pages yesterday; the crossover choice and the accounts are on
**Settings → Accounts & usage**. Those four now say so. ("Agents → Usage", the Usage view from the
sidebar, still exists and is left where it is said.) Code comments, `docs/agents.md` and the
desk's CSS headers still name the old path; not user-facing, left.

## 4. Usage: two group labels sat inset from everything around them (fixed here)

**Where.** `usage-plan-controls`, `probe-usage-largest`. `mobile/src/components/usagePlanControls.tsx`.

"How agents use your limits" and "Spare-capacity list" used `SectionTitle`, whose left inset is for
a label over a grouped card. Here nothing under them is in a card, so they sat 16pt in from the
choice, the text under it and the "Claude Code" / "Codex" labels above. Its bottom margin also
stacked on the wrap's gap, so label-to-control was twice line-to-line. Both are now flush with
the gap alone.

## 5. qa:web: 25 of 601 shots failed, all from the script falling behind (fixed here)

**Where.** `mobile/scripts/qa-web.mjs`.

None was the app breaking:

- Section labels went to sentence case (e2723ead8); `scrollToText('CLAUDE CODE ACCOUNTS')`,
  `'RUNS ON'`, `'WHAT IT CAN REACH'`, `'WHAT IT CAN DO'` and `'CODEX ACCOUNTS'` never matched.
  It now matches any case (10 shots each theme).
- `/needs` was replaced by Catch up (f8630b0de) and is an Unmatched Route; the two probe shots
  now open `/catch-up` (4 shots).
- "What can Finance do on its own?" is "Finance's independence", and the agent sheet's "How much
  it does on its own" choice sheet is the Independence slider (f6bb91255). Readies and checks
  renamed; the shot of the removed choice sheet is gone, the row shot scrolls to the slider.
- The first-run phase runs after phases that opened the Chief's chat on the same mock Mac, so the
  saved copy brought those lines back and the Chief's three ideas (only on an empty chat) never
  showed. The phase now drops the offline copy before the app loads (a script on the next
  document; the open app rewrites its copy as it unloads).

Added at Largest, for tonight's cards: the crossover card, the step-in card, Agents with the usage
glance, and Usage.

## 6. Catch up said RECENTLY in capitals (fixed here)

**Where.** `catch-up-p2`, `probe-catch-up`. `mobile/src/app/(tabs)/catch-up/index.tsx:262`.

Every other group label on the phone went to sentence case last night; this one was upper-cased in
code. Now "Recently" / "Since you last caught up".

## 7. Account names cut at large text (fixed here)

**Where.** `probe-usage-largest`. `mobile/src/components/usageStack.tsx` (the total card's rows and
the account cards).

Beside "59% left" and a refill chip, "sam@example.com" was cut to "sam@example…" at Largest. The
name may take two lines before an ellipsis; at the default size nothing changes.

---

## Left, and whose they are

### 8. "Refill" and "reset" on the same screen (a decision)

The Usage headline says "Next refill in 2h 0m", the account page "Refills 5:59 AM" and "before it
refills". In the same sheet: "Runs out in about an hour, 3 days before reset"
(`companion-protocol/usageGlance.ts:944`), "62% of sam@example.com's 5-hour limit resets in 40
min" (the nudge), "(work@example.com, resets Mondays 11 AM)" (the previous-account note), each
limit's "Resets at 3:20 PM" (`usageSheet.ts` `resetsLine`, also the desk popover), Settings →
Usage's "Claude 5-hour limit resets 3:28 AM", the plan controls' "about to reset with room left",
and the morning brief's "Soonest reset". The mode is named "Use it all before reset" in
CLAUDE.md and on the desk.

My read: keep "reset" only inside the mode's name and say "refill" wherever a time or countdown is
shown, since that's the word the headline and the account pages already teach. It touches shared
strings the desk draws too (`usageGlance.ts`, `usageSheet.ts`, `saver.rs`, `brief.rs`), so it is
the owner's call, not a regression fix.

### 9. A drafted routine reads "at 08:00", the routine editor "at 9:00 AM" (a decision)

`new-agent-drafted`: "Every weekday at 08:00" (`whenLabel`, `companion-protocol/steps.ts`, the
Mac grammar's 24-hour words, kept on purpose by `steps.test.ts`), one screen before the routine
editor says "Every weekday at 9:00 AM". Same on the desk's draft review. Worth converting the
clock in `whenLabel` to the 12-hour form the rest of the app shows, if 24-hour wasn't a choice.

### 10. For the agent polishing chat, settings, projects and search

- **Said twice when the Mac's app is stuck** (`link-stuck-chat`): the chat's empty state "The app
  on your Mac isn't responding" sits directly above the connection bar saying the same sentence.
  One of them should go (the bar is on every tab now, d9e4b17d5).
- **A wrapped Line loses its icon** (`setup-in-timeline`, `import-live`): "✓ Allowed · Here's
  what your 2 agents will do for you" wraps to two centred lines with the tick left behind at the
  far left and the chevron at the far right.
- **"Opencode · installed"** on Settings → Usage, where last night's work spells it OpenCode. The
  name comes from the desk (`src-tauri/src/agent.rs:120`).
- The Usage account page's Tokens tab: "Used by these agents this week" wraps beside the
  Limits/Tokens control while the Limits tab's title is one word, so the page jumps when you switch
  (`usage-account-tokens`).

### 11. For the agent adding When… routines (schedule sheet)

`schedule`, `schedule-steps`: the sheet's labels are still capitals ("HOW OFTEN", "WHAT", "PAST
RUNS"; `mobile/src/app/schedule.tsx:225`, `:500`, with `letterSpacing` in `label` and `heading`)
while every other phone screen and the new-agent sheet ("Colour", "Icon", "Key") went to sentence
case. Left for them, since they are in that file.

### 12. Small, left

- The spare-capacity field's placeholder is cut at Largest ("Something to do with spare ro").
- Every tab screen's first ~100pt sits under qa:web's tab-bar pill (a web artifact), so the usage
  glance and Projects' "No projects on … yet" can't be judged from these shots; check them on a
  simulator.

### 13. `torture-events`: an overtaken line drawn above the line written after it (not new)

In the torture chat, after a burst and two lines arriving out of order, the agent's burst lines
and "Written second" are drawn far above their slots and the slots are blank. It reproduces with
`mobile/src`, `mobile/dev` and the protocol checked out at b51df1831 (Nov 9, 09:59) and with
130b947bc's chat changes reverted, so none of last night's work caused it. The sort in
`sync.ts` (`upsert`, `upsertAll`) is right, which points at react-native-web's inverted list with
rows rising in (`Arrive`); not checked on a device, where it matters. It is also flaky: the
second full run failed it in light only, and `torture-reconnect` once in dark ("Plan for the
week?" not in the chat after the Mac restarted), which passed in the first run.

---

## Requests (`--phases net`)

Cold start 9 requests (5 `agents.messages`, one each of accounts, rooms, team setup, usage plan),
nothing while idle for 10 s, 2 on a tab round, 10 opening three chats (6 of them `agents.focus`),
9 on reconnect. No earlier run is recorded to compare against; the numbers are in
`net.json` of the run for the next sweep.
