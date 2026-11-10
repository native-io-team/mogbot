# New-user walk-through, second pass, 2026-11-10

A second read of `mogbot/foundation` (ffadb72f7) as a non-technical newcomer, after the first
pass (`review-2026-11-10-newuser.md`) and the features that landed since: living pages, skills,
rewind and fork, Mail and Messages "When…" routines, "When…" from the phone, step in, the
friendly installer, Projects cards with agents, the menu bar and notifications. Six things, in
order:

1. Set it up and say hello to the Chief.
2. Make an agent that tracks something over time (job applications) and see whether its living
   page and a routine make sense together.
3. Have it do a hard task and decide whether to save the skill.
4. Undo a wrong turn, finding Rewind / Fork without being told.
5. Set up "when an email from my boss arrives, tell me" and grant the access it needs.
6. Approve something from the phone and look at Catch up.

**How it was looked at.** Desk: `pnpm harness` on port 1471 with its own `TMPDIR`, light and
dark at 1440×900, the scenarios on that path (`onboarding-*`, `launch-returning`,
`agents-first-run*`, `agents-first-win-*`, `agents-new*`, `agents-describe*`, `agents-page*`,
`agents-schedule*`, `agents-scheduled`, `agents-skill-*`, `agents-editor-skills`,
`agents-go-back-*`, `agents-when-*`, `agents-apps*`, `agents-approval`, `agents-step-in-*`,
`agents-mac-apps-*`, `projects-agents-*`, `agents-plan-card*`, `agents-steps-*`). Phone:
`pnpm qa:web --web-port 8331 --mock-port 47731 --cdp-port 9931`, light and dark (catch-up,
catchup-approval, page-*, goback-*, chat-skill-card, agent-sheet-skills, schedule-*,
schedule-when-*, new-agent*). Shots are in the session scratchpad under `newuser3/`
(`desk-light`, `desk-dark`, `phone`, and `after-*` for the fixes).

**Not checked.** The Tauri build in WKWebView; a real Full Disk Access grant; a real phone
(qa:web is react-native-web); what the agents actually say (no model turns in either harness),
so whether a job-tracking agent *chooses* to pin a page is read from its brief and the tool's
description, not observed; whether the Mac pushes a notification for a skill offer (item 9).

## What went fine

Onboarding is still two clicks and plain ("You don't need to know how to code"). The living page
is the right idea and looks it: a tinted band of flat tiles above the chat, with a history that
says "by Log the day's card spend" for each version. The rewind confirm says exactly what it
does and doesn't undo ("Files it changed and anything it sent aren't undone"). The step-in card
says the agent never sees what you type. The "Allow Hiring to use your Messages?" card shows the
exact text and number before Allow.

## The ten worst moments, worst first

Each: the scenario, file:line (as of the fixes), what happened to me, the fix. The top five are
fixed here, each its own commit.

### 1. On the phone, a skill offer asks me to "Deny" or "Allow" (fixed)

**Where.** qa:web `catchup-approval`. `mobile/src/lib/catchUp.ts:200` (`askAction`).

**What happened.** Step 6. Catch up, card 5 of 12: "Save “Reconcile Stripe payouts” as a
skill?" with **Deny** and **Allow** under it. Allow what? On the desk, and in the same card in
its chat on the phone, the buttons are **Not now** and **Save**. Catch up's one-at-a-time bar
gives the gate and the hand-off their own words but not this one.

**Fixed.** `askAction` answers a skill offer with `SKILL_SAVE` / `SKILL_NOT_NOW`, the card's own
words. Test: `mobile/__tests__/catchUp.test.ts`.

### 2. I couldn't find how to undo a wrong turn (fixed)

**Where.** `agents-go-back-menu`, `agents-fresh-menu`. `src/components/agents/AgentGoBack.tsx:78`
(the hover "…"), `src/components/agents/AgentActions.tsx:64` (the header's … menu).

**What happened.** Step 4. The agent went the wrong way. I looked at its reply (nothing there),
then at the chat header's … menu: Edit agent, Independence, Schedule, Files, Pin, Mute, Take
over, New conversation. No undo. Rewind and Fork live on a "…" that appears only when hovering
*my own* message, on a right-click of it, and in ⌘K. I'd have started a new conversation and
lost the thread.

**Fixed.** The header's … menu has "Go back to an earlier message…" (beside New conversation,
only when there's a message of yours to go back to), which opens the same picker as ⌘K: each
message with Edit, Fork and Rewind. Test: `AgentActions.test.tsx`; docs/agents.md, "Rewind,
fork and edit".

### 3. "When…" opens on GitHub, and Gmail isn't on the list (fixed)

**Where.** `agents-when-routines`; qa:web `schedule-when`.
`packages/companion-protocol/src/whenComposer.ts:56` (`whenSources`),
`src/components/agents/AgentWhenRoutine.tsx:89`, `mobile/src/components/whenComposer.tsx:79`.

**What happened.** Step 5. New routine → When…: the first three choices, the first one already
picked, are "Someone mentions you on GitHub", "An issue or PR is assigned to you" and "A Linear
issue is assigned to you". I don't know what any of those are. Email is fifth, and it says
"in Mail": my boss writes to my Gmail, in the browser. Nothing says that Gmail is "Something
else…", the last row.

**Fixed.** Mail, Messages, a folder and Something else… come first, GitHub and Linear after; a
new routine starts on Mail (`DEFAULT_WHEN_KIND`), and Something else… reads "You say what, in
one app like Gmail". Same list on desk and phone. Tests: `whenComposer.test.ts`,
`AgentWhenRoutine.test.tsx`, `mobile/__tests__/whenComposer.test.tsx`; harness scenarios
updated.

### 4. The skill card didn't tell me what a skill is or where it goes (fixed)

**Where.** `agents-skill-card`, qa:web `chat-skill-card`, `catchup-approval`.
`packages/companion-protocol/src/skills.ts:50` (`SKILL_OFFER_NOTE`),
`src/components/agents/AgentSkills.tsx:96`, `mobile/src/components/skills.tsx:53`.

**What happened.** Step 3. "Save “Reconcile Stripe payouts” as a skill?", then "When the user
asks to reconcile…" (the user? that's me), the steps, and "Nothing waits on it. Saved, it's
listed under Skills." What does saving get me? Where is Skills? "Nothing waits on it" read like
"nothing happens".

**Fixed.** The note says what it's for and where it lives: "Saved, it does this the same way
next time, without you explaining it again. It's kept under Skills in this agent's settings.
Nothing is waiting on your answer." The "when" line is said to you on the card and in the
Skills list, desk and phone (`skillWhenLine`: "When you ask to reconcile…"), display only; the
saved skill keeps the agent's words. Tests: `skills.test.ts`, `mobile/__tests__/skillCard.test.tsx`.

### 5. "Check again" before I'd checked anything, and the reason below the form (fixed)

**Where.** `agents-when-mail-access`; qa:web `schedule-when-text-access`.
`src/components/agents/AgentWhenRoutine.tsx:245`, `mobile/src/components/whenComposer.tsx:235`.

**What happened.** Step 5, granting access. After picking Mail: two buttons, **Check again**
then **Open Full Disk Access**, and only further down, under the interval and the What field,
the sentence saying why ("Reading Mail needs Full Disk Access…"). On the phone, just a lone
**Check again** with the reason at the very bottom. The same "Try again before trying" the first
pass fixed on the phone panel.

**Fixed.** The Mac's words sit directly above the buttons, setting first: "Reading Mail needs
Full Disk Access…", then **Open Full Disk Access**, **Check again**. Said once; the readback
under the form no longer repeats it. Same on the phone. Tests updated on both.

### 6. The page and the routine that keeps it don't mention each other (fixed)

**Where.** `agents-page`, `agents-scheduled`; qa:web `page-chat`.
`packages/companion-protocol/src/page.ts:88` (`pageUpdatedLine`),
`src/components/agents/ConversationPage.tsx:212`, `src/components/agents/AgentSchedulePopover.tsx:288`.

**What happened.** Step 2. The header says "3 routines"; the page says "Updated 3 min ago · v4".
Which routine updates the page, and when? Only the history popover says ("by Log the day's card
spend"). The other way round, the New routine picker doesn't say it runs in this conversation
and so can keep its page current; I'd have guessed a routine is separate from the chat. "v4" is
a developer's word.

**Fix.** When the newest version was a routine's, the bar says "Updated 3 min ago by Log the
day's card spend" (`pageByLine`), version number kept for the history only; and in a
conversation with a page, the routine picker's footnote adds "Runs here, so it can keep “November
budget” up to date". Not done: the phone's bar shares the row with the title at 402pt and
needs a second line, which wants a design pass.

### 7. "Help me apply for jobs" makes a trail of cards, not a tracker (fixed)

**Where.** `agents-first-run` → More ideas…; `packages/companion-protocol/src/chiefIdeas.ts:74`.

**What happened.** Step 2. The closest starter is "Help me apply for jobs": every weekday a
scout and a writer "send me one card with the openings and the letters". Nothing keeps a list of
where each application stands, which is what I wanted to track. The living page is exactly that,
but no starter asks for one, and whether an agent pins one is left to the model.

**Fix.** End the brief with "Keep a page above our chat of every application and where it
stands, and update it each morning." Worth a "Track something for me" starter, too.

### 8. The New agent review speaks engine (fixed)

**Where.** `agents-describe-drafted`. `src/lib/agents.ts:1162` (`engineProtections`).

**What happened.** Step 2. Before Create: "Claude Code enforces: file edits go ahead in its
project and its own folder; everything else is decided by its independence." I can't act on any
of that, and "its independence" isn't explained on this screen.

**Fix.** Move the line under Advanced (it's for people who chose an engine on purpose) and say
it as "It can change files only in its own folder. Anything else asks you first, unless you let
it do more (Independence)."

### 9. A skill offer counts as something that needs me (fixed)

**Where.** qa:web `catchup-approval` ("5 of 12"), `catch-up`. `mobile/src/lib/needsYou.ts`,
`mobile/src/lib/actionable.ts:174` (`categoryOf`).

**What happened.** Step 6. The card says nothing is waiting on it, but Catch up counts it among
the 12 things I have to get through, and if the Mac pushes it, a skill offer's lock-screen
buttons would fall into the plain Allow / Deny category (not verified that it's pushed).

**Fix.** Put skill offers after everything that blocks an agent, uncounted ("and 1 offer"), and
give them a Save / Not now notification category or none.

### 10. The "When…" cost line talks tokens in a code box (fixed)

**Where.** `agents-when-approval`. `src-tauri/src/agents/mcp.rs:1015`; the harness fixture
(`src/harness/scenarios/agents.ts:1836`) still shows the older "one short Claude Code call on
Haiku" text.

**What happened.** Step 5, when the agent offered to watch Gmail itself: "Checks on this Mac this
week averaged 2k tokens each, so up to about 48k tokens a day", in monospace. On a Pro plan I
don't know what 48k tokens is against my limit.

**Fix.** On a plan, say it against the plan ("about 1% of a week's usage a day") when the
usage read gives a weekly figure, else "a little of your usage"; render the card's detail as
prose. Refresh the fixture from `watch_card`.

## Also noticed, smaller

- Phone section labels are capitals ("HOW OFTEN", "WHAT", "WHEN THIS HAPPENS", "CHECK EVERY");
  the desk's are sentence case for the same composer.
- The conversation switcher in the chat header is a speech-bubble icon with a chevron and no
  words until there's a second conversation; it's where Fork's new conversation lands, so it's
  worth a label ("1 conversation").
- "Then…" beside the routine's What field (desk and phone) doesn't say what it adds until you
  read the small print ("Draft first, then post once you OK it").
- On the phone, the page's unpin glyph is a crossed-out pin; the desk's is a plain pin.
- New agent's links are "Research, Inbox or Weekly Review": one title-case of three, as noted in
  the first pass.
