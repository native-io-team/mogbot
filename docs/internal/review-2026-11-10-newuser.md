# New-user walk-through, 2026-11-10

One read of `mogbot/foundation` (e88e85d36) as someone who has never seen the app and only heard
"it's like Grok Bot, but on Claude Code on your own Mac". Not technical, has a Claude Pro plan,
owns an iPhone. Five things, in order:

1. Set it up and say hello to the Chief.
2. Make an agent that sends a daily summary of something.
3. Ask an agent to research something and get a result back.
4. Approve something from the phone.
5. Find out how much usage is left.

**How it was looked at.** Desk: `pnpm harness` on port 1461 with its own `TMPDIR`, the scenarios
on that path (`onboarding-*`, `agents-first-*`, `agents-new*`, `agents-scheduled`,
`agents-team-setup-routines`, `agents-result-*`, `agents-approval`, `phone-*`, `phone-install-*`,
`usage-*`, `settings-agents-usage*`, `agents-chat-usage`) captured light and dark at 1440×813.
Phone: `pnpm qa:web --web-port 8161 --mock-port 47561 --cdp-port 9761`, the pairing screens, the
demo, catch-up, the approval card and the usage sheet, light and dark. Shots are in the session
scratchpad (`newuser/desk-light`, `desk-dark`, `phone`, and `after-*` for the fixes).

**Not checked.** The Tauri build in WKWebView; a real install or sign-in; a real phone (qa:web is
react-native-web, so the tab bar sitting over the demo banner on `demo-agents` is the web
artifact docs/mobile.md lists, not reported); what the Chief actually says back (the harness has
no model turns, so "does the Chief offer weekly updates after research" is the brief's wording,
not an observed reply).

## What went fine

Worth saying, because most of the path is good. Onboarding is two clicks and says what each
step does ("A window opens here … nothing shows as you type"); a closed install says so and
offers Try again. The Chief's greeting says in one sentence what it does and what waits for an OK.
The starters type a whole brief with the blank at the end ("Fill in the end, then send"). The
result card answers "did it actually check?" better than anything I've used. The approval card
shows To, Subject and Body before Allow. The Usage page leads with the one number I came for
("53% left this week").

## The ten worst moments, worst first

Each: the scenario, file:line, what happened to me, the fix. Five are fixed here (marked), each
its own commit.

### 1. "How much do I have left?" — the first figure says 90% used (fixed)

**Where.** `agents-chat-usage` (desk ring popover), qa:web `usage-sheet` (phone).
`packages/companion-protocol/src/usageSheet.ts:83` (`contextMeter`),
`src/components/agents/AgentUsageRing.tsx:101`, `mobile/src/app/usage.tsx:132`.

**What happened.** Step 5. The obvious place is the little gauge in the chat header (on the phone,
the ring beside the agent's name). It opens a sheet titled **Usage**, and the first thing on it is
"Conversation length · Acme Site's conversation · **90% used**" in warning orange. I read that as
"I've used 90% of my allowance" and was about to stop. The real answer ("40% left across 2 Max
accounts") is the next block down. The desk's own context meter calls the same number "% full"
(`src/lib/agents.ts:2279`), so the two screens also disagreed.

**Fixed.** The context figure says "**90% full**" on desk and phone (shared module), so a
conversation filling up never reads as usage running out. The desk popover's "Next reset:" also
became "Next refill:", the Usage page's word. Test: `mobile/__tests__/usageSheet.node.test.ts`.

### 2. A one-off research question quietly became a weekly job (fixed)

**Where.** `agents-first-win-research`; the Chief's "Research it and write it up" chip, desk and
phone. `packages/companion-protocol/src/chiefIdeas.ts:109`.

**What happened.** Step 3. I clicked the chip, typed my topic and sent. The brief it had typed
for me ended "Then every week, look for new sources, update the draft and tell me what changed."
I wanted one answer. I'd have found out a week later that something was running on my limits.

**Fixed.** The brief now asks the Chief to offer it: "When it's done, ask me whether I want it
kept up to date each week." The gallery line says the same.

### 3. Getting the phone app opened on a dead end (fixed)

**Where.** `phone-install-choose`. `src/components/phone/PhoneInstall.tsx:100` (`RouteChoice`).

**What happened.** Step 4. "Get the phone app" → Install…: the first card is **TestFlight — Not
available yet**. The only route that works was under a link called "Install it yourself
(advanced)". I'm not advanced; I nearly closed it.

**Fixed.** With no official build, "Build it on this Mac" leads, unfolded and not called
advanced, then Tailscale, and the TestFlight card goes last, dashed. With an official build the
screen is unchanged.

### 4. "Install Tailscale … Turn off" (fixed)

**Where.** `phone-install-tailscale`. `src/components/phone/PhoneModal.tsx:455`, `:555`.

**What happened.** Step 4. The phone panel's first state is a box titled "Install Tailscale" with
**Turn off** in its corner and **Try again** under it. Turn off *what* — Tailscale? I haven't
installed it. Try again — I haven't tried anything.

**Fixed.** In a setup step it says "Turn off phone access"; the green "Phone access is on" bar
keeps "Turn off". While a step waits on me the button is "Check again"; only a real failure says
"Try again".

### 5. Schedule, scheduled, routine, Routines: one idea, four words (fixed)

**Where.** `agents-new-agent-first-open`, `agents-scheduled`.
`src/components/agents/AgentSchedulePopover.tsx:179`, `:194`.

**What happened.** Step 2. The sidebar says **Routines**. In the agent's chat the header says
**Schedule** (or "3 scheduled"), the popover is titled **New routine**, its button is
**Schedule**, and the chat line says **Scheduled · late**. I looked for "Routines" in the agent
and didn't see it.

**Fixed.** The header says "Routines", or "3 routines". The popover's verb button and the chat
line are left (a verb and a past event read fine).

### 6. My daily summary only runs while the app is open, and nobody told me

**Where.** `agents-first-win-morning-brief`, `agents-scheduled`, `agents-team-setup-routines`.
`packages/companion-protocol/src/chiefIdeas.ts:50` (the brief),
`src/components/agents/AgentSchedulePopover.tsx:336`, `:408` (the footnote).

**What happened.** Step 2. "Brief me every morning" promises "Every weekday at 8am". Nothing on
that path says it only runs while this app is open and the Mac awake. The one place that does is
the small print at the foot of the routine picker, which I never opened because the Chief made the
routine for me. I'd close the laptop at night and wonder why nothing came.

**Fix.** When the Chief confirms a new time routine, its card or line ends with the same sentence
and the "Keep this Mac awake" link the picker has (one shared string). Not done here: it belongs
in the routine-created line in Rust and the result card, not in a starter.

### 7. Two words for the same moment: "refill" and "reset"

**Where.** `usage-one`, `usage-sheet` (phone), `settings-agents-usage`.
`packages/companion-protocol/src/usage.ts:39` ("Use it all before reset"),
`packages/companion-protocol/src/usageGlance.ts:944` ("… days before reset"),
`mobile/src/components/usageStack.tsx:215` ("Next refill in …").

**What happened.** Step 5. The hero says "Next refill in 4d 1h"; the sidebar "Refills in 4d 1h";
the mode below it "Use it all before **reset**"; the phone sheet "Next refill … Runs out in about
an hour, 3 days before **reset** … resets in 40 min" on one screen. I wondered whether a refill
and a reset were different events.

**Fix.** Pick "refill" for the user's words (it's the hero's and every chip's) and rename the
remaining strings in the shared module (`usage.ts`, `usageGlance.ts`, `crossover.ts`,
`schedule.ts`, `sameAccount.ts`, `accountSwitcher.ts`), with their tests. Only the popover's line
is done here; the rest is a copy pass across the shared package, too wide for tonight next to the
other agents on the phone screens.

### 8. "New room" appears with no explanation

**Where.** `agents-new-agent-first-open` onwards. `src/components/agents/AgentsSidebar.tsx:465`.

**What happened.** The moment I had a second agent, "New room" appeared under "New agent". Grok
Bot has no rooms; nothing says what one is.

**Fix.** A tooltip and a one-line lead in the room editor: "Talk to several agents at once." Or
hold the entry until the Chief suggests a room.

### 9. The Usage page speaks in its own jargon and repeats itself

**Where.** `usage-one`, `usage-unknown`. `src/components/agents/AgentsUsageView.tsx:620-621`,
`src/components/agents/AgentsUsage.tsx:134`, `src/components/agents/UsageStack.tsx:179`.

**What happened.** With one account the page title is "Usage", the hero's eyebrow is "Usage" again,
and the account's name and "53% left · 4d 1h" appear in the hero and again in the row below.
"Spare-capacity list" means nothing to me. "Account 3 · Not signed in" has no button; I don't know
whether to do something.

**Fix.** With one account, drop the eyebrow and the hero's per-account line (the row says it).
Rename the list "Ideas for leftover usage". Give a "Not signed in" row a "Sign in" button that
starts the same flow as "Add a Claude Code account".

### 10. The phone says "Settings → Phone → Show code"; the desk calls it "Your phone"

**Where.** qa:web `pair-scan`; desk `phone-ready`. `mobile/src/lib/pairing.ts:25`,
`src/components/phone/PhoneModal.tsx:250`, `src/components/agents/AgentsSidebar.tsx` ("Get the
phone app").

**What happened.** Step 4. The phone told me to open Settings → Phone. On the desk I'd come in from
"Get the phone app" in the sidebar, which opened a window titled "Your phone" with no Settings in
sight. It's the same panel, but nothing on screen says so. Also on that panel: "PAIRED PHONES" and
"WHAT A PAIRED PHONE CAN DO" are the only all-caps headings I met.

**Fix.** Title the panel "Phone" (the Settings section's name) wherever it opens, and make the
phone's line "On your Mac: Phone (in Settings, or Get the phone app in the sidebar) → Show code".
Sentence-case the two headings.

## Also noticed, smaller

- `onboarding-engine-install` / `-signin`: while installing or waiting for sign-in there's no Back
  and no "the browser didn't open" link. A closed window is handled; a browser that never came
  forward isn't, until the check times out.
- `agents-new-agent-first-open`: the Inbox agent's greeting says "I go through your mail each
  morning", but the header shows no routine. Either the greeting promises less or the routine is
  made with the agent.
- `agents-new`: "start from Research, Inbox or Weekly Review": one of three is title case.
- `ChiefPhoneOffer.tsx:35`: "setting it up takes ten minutes to an hour" is honest, and it is the
  sentence that made me decide not to do it today. Saying what it needs (a cable and Xcode) would
  let people decide faster.
- Phone `catchup-approval` vs desk `agents-approval`: different fixtures, so not compared; worth a
  scenario with the same request on both.
