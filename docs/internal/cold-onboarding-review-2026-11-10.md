# Cold onboarding review, 2026-11-10

A first-time-user pass over what someone sees after the two things the owner is
about to send: the Mac DMG and the TestFlight link. The intended journey is the
Mac app, then a Claude Code / Codex / OpenCode account, then Remote Access and an
import from another assistant, then pairing the phone by scanning a code. The bar
is "they can do it easily and are impressed", and "people do not have the desire
or energy to do anything other than look at one thing and make one decision at a
time".

Walked as three people, screens only, without reading the onboarding code or docs
first:

- **(a)** A busy, non-technical founder on a Claude Pro plan who has never heard of Tailscale.
- **(b)** Someone who opens the **phone** app first, without the Mac app.
- **(c)** Someone who skips everything and comes back a day later.

## How it was looked at

- Desk: `pnpm harness` on port 1469 with its own `TMPDIR`, every `onboarding-*`,
  `phone-*`, `agents-first-run*` and `agents-foot-*` scenario, light and dark
  (`scripts/harness-capture.mjs <prefix> --theme light|dark`).
- Phone: `pnpm qa:web --phases demo,fresh,first-run` (the pairing screens, the
  demo, the first-run screens) at 402×874 @3x, light and dark.
- Every screenshot looked at at full size. The web phone build's known artefacts
  (tab bar at the top, Material icons) are not counted.

Not checked: a real Tauri build, a real iPhone or TestFlight build, real Tailscale
(the Funnel approval page's own wording), any real assistant's connector screen.

## Scores, before

1 = would give up, 5 = impressed. "One decision" = could I act on the screen
without having to make a second choice or look something up.

### Desk onboarding

| Screen | What I think it wants | One decision? | Words I didn't know | Looks | Score |
| --- | --- | --- | --- | --- | --- |
| Welcome | Press Get started | Yes | "C" on the key cap | Clean | 4 |
| Which AI | Pick the plan I pay for | Yes | — | Card and its inner button are two targets | 4 |
| Install / Installing / Checking | Wait | Yes | "1 of 2" (of what?) | Clean | 4 |
| Sign in | Sign in in the browser | Yes | — | Code paste box is busy but optional | 4 |
| Failures (offline, disk, admin, sign-in closed) | Fix the one thing, Try again | Yes | — | Honest and calm | 4 |
| Codex prerequisites | Type my Mac password | Yes | Homebrew, Node.js (explained) | Password field has no label inside | 3 |
| Connected | Continue | Yes | — | Clean | 4 |
| Bring your agents? | Yes or not now | Yes | — | Clean | 4 |
| Tailscale on this Mac | Install Tailscale | Mostly | VPN configuration | Amber "Not done yet" before I've done anything | 3 |
| **"Turn on the private link"** | Press "Turn on remote access" | Yes, but | Title and button name two different things | — | 3 |
| **Funnel switch off** | ??? | **No** | **Funnel**; "Open Tailscale" (where's the switch?) | **Focus ring on Skip for now: Enter skips the step** | 1 |
| Add the link to your assistant | Copy, paste into my assistant | No: where in my assistant? | custom connector, MCP | "Copied. Copy again" is awkward | 2 |
| **Start the import** | Press Start | Yes, but the line is circular | "Start lets one import begin" | — | 2 |
| **Grok asking to start** | Continue | Yes | — | **Title "Send your assistant this message", no message on screen** | 2 |
| Use agents from your phone? | Set up my phone | Yes | — | Clean | 4 |
| Get the app on your phone | I have it | Yes | — | Clean | 4 |
| Tailscale on your phone | Install it, I did it | Mostly | — | App Store bordered, Google Play not; Android link for an iPhone-only TestFlight | 3 |
| Turn on phone access | Press it | Yes | Third "turn on" in a row | Clean | 3 |
| **Scan** | Scan with the phone | **No: the phone has no "Scan the code" button** | — | **Focus ring on Skip for now** | 2 |
| Allow <phone>? | Allow | Yes | — | Clean | 4 |
| Paired | Go to the Chief | Yes | — | Clean | 4 |

### Desk after onboarding

| Screen | Notes | Score |
| --- | --- | --- |
| Chief's first chat | Greeting, three starters, More ideas | 4 |
| Import card under the greeting | Clear, one choice | 4 |
| **Sidebar foot** | "New agent" icon and label ~11px right of Usage, Pair your phone and Routines; with New room beside it, both halves centred (stacked when narrow: both off every row) | 2 |
| Phone panel (later, from the sidebar) | Same steps in a modal. "Back" has no arrow, unlike onboarding; "Build it on this Mac…" sits above the big button | 3 |

### Phone

| Screen | What I think it wants | One decision? | Words | Looks | Score |
| --- | --- | --- | --- | --- | --- |
| Do you have it on your Mac? | Yes / Not yet / Try the demo | Yes | — | Clean | 4 |
| Get it on your Mac first | Send myself the link | Yes | github.com/…/releases (a developer page) | URL breaks mid-word | 3 |
| Tailscale on this phone | It's on | Yes | **Tailscale, never said what it is when installed** | Clean | 3 |
| **Same Tailscale account on both** | Press "Same account" | **No: I can't know yet. The screen itself says the Mac shows which one later** | — | — | 1 |
| On your Mac, click "Pair your phone" | "I see the code" | Yes | — | The Mac's QR says "tap Scan the code"; this button says something else | 2 |
| Reaching <Mac> | Wait | Yes | **localhost:61660** | Spinner centred on a two-line title; **bar jumps up** (no Back) | 2 |
| Can't reach <Mac> | Check, Try again | Mostly | — | A third bullet that isn't a check ("This phone is paired: not yet") | 3 |
| Pair with <Mac>? | Pair | Yes | "at localhost:47569" | Captured dark in the light run (QA artefact, below) | 3 |
| Click Allow on your Mac | Click Allow on the Mac | Yes | — | Bar jumps up | 3 |
| Paired | Wait | Yes | — | Clean | 4 |
| Demo (persona b) | Look around, Pair your Mac | Yes | — | Good. Settings says notifications need "the official build", true only of a self-built copy | 4 |

### By person

- **(a) Founder on Pro.** Sails through the engine. Stalls at Remote Access: three
  names for one thing (private link / remote access / phone access), then "Funnel"
  with no idea where the switch is, then "add a custom connector (MCP)" with no
  hint where. Pressing Enter on the Funnel screen would have skipped the step.
- **(b) Phone first.** The first screen says the Mac comes first, which is right.
  Then a screen that asks them to confirm "Same account" before anything could
  show which account, and a button ("I see the code") that doesn't match what the
  Mac tells them to tap ("Scan the code").
- **(c) Skips everything, back a day later.** Lands on the Chief with the import
  card and "Pair your phone" in the foot: fine. The Phone panel re-walks the same
  steps; "Skip for now" inside a closable modal is redundant but harmless.

## The 10 worst, ranked

1. **The Mac says "tap Scan the code"; the phone had no such button** (it said "I see the code"). Cross-device instruction pointing at nothing. *Fixed.*
2. **Enter skips.** On the Funnel and Scan screens the only button in the actions row is "Skip for now", so it took focus: Enter, the habit every other screen teaches, skipped the step. *Fixed.*
3. **"Same Tailscale account on both"** is a screen whose only answer ("Same account") nobody can give honestly yet; the screen says so itself. One more decision for nothing. *Fixed: folded into the Tailscale screen.*
4. **Funnel: "One switch in Tailscale is off: Funnel."** Jargon, and "Open Tailscale" suggests the app when it opens an approval page. *Fixed copy; still says "Funnel" once because that's the word on Tailscale's page.*
5. **One idea, three names**: "Turn on the private link" (title), "Turn on remote access" (button), "The private link is live" (done). *Fixed: Remote access throughout this screen.*
6. **"Send your assistant this message" with no message on screen** once the assistant has asked to start. *Fixed.*
7. **"Start lets one import begin. Then you send…"** circular, says nothing about why Start exists. *Fixed.*
8. **Sidebar foot misaligned**: New agent / New room a column of their own between rows that share one. *Fixed.*
9. **Phone pairing: bar jumps and spinner floats**: the bar moves up on Reaching / Allow (no Back), and the spinner centres on a two-line title. Plus "localhost:61660" in the Reaching line. *Fixed.*
10. **"Add the link to your assistant" doesn't say where** in Claude / ChatGPT / Grok the custom connector lives. *Left* (see below).

Also seen, smaller: the Phone panel's "Back" had no arrow (*fixed*); `pair-confirm-light` was captured in dark because the demo's shots leave the last theme on (*fixed in qa-web*).

## What changed

- `src/components/setup/flow/FlowParts.tsx` — `FLOW_FOCUS_TARGET`: after the big button and the engine cards, a failed check's fix button (`data-flow-fix`), then any action **except** `data-flow-skip`. Skip never takes focus on its own.
- `src/components/setup/flow/AgentsFlow.tsx` — "Turn on remote access" title, "Turn it on" button, "Done. Remote access is on."; Funnel: "Tailscale needs your OK to let your assistant in." / "Open the Tailscale page, turn on Funnel there, then come back. This screen notices by itself." / "Open the Tailscale page"; Start: "Your assistant can only start an import after you press Start. Then you send it one message, and you choose what comes over before anything is created."; once started: "<Source> is ready to bring your agents" with "Next, your Chief of Staff asks you to OK it in its chat…" and "Done. <Source> is asking to start the import."
- `packages/companion-protocol/src/pairWords.ts` — `SEE_THE_CODE` and `SAME_ACCOUNT_TITLE` gone; `SAME_ACCOUNT_LINE` ("Sign in with the same account as your Mac."); `SCAN_THE_CODE` documented as the phone's camera button.
- `mobile/src/lib/pairSteps.ts`, `mobile/src/app/pair.tsx` — intro is `mac → tailscale → code` (bar of 6, was 7). The Tailscale screen always says what Tailscale is and to use the Mac's account. The code screen's button is "Scan the code", its line "Already looking at a code on your Mac? Scan it now…". A phone saved on the retired `account` step resumes at `code`. Reaching drops the address.
- `mobile/src/components/StepScreen.tsx` — the top row is `MIN_TAP` tall with or without Back (the bar stays put); the busy spinner sits in a box one title-line tall at the top of the title.
- `src/components/phone/PhoneFlow.tsx` — the Phone panel's Back has its arrow.
- `src/components/agents/AgentsSidebar.tsx`, `src/styles/features/agents.css` — New agent / New room use `FooterRowIcon` (14px in the Button's icon slot) and the foot rows' own icon box (`padding-inline-start: 0`, the badge-wide icon padding from `sidebar-footer.css`), and side by side or stacked they start on that column instead of centring.
- Harness captions (`src/harness/scenarios/onboardingFlow.ts`), qa-web steps and captions, the pairing test and the vocabulary snapshot follow.

Tests: `pnpm test:run` (4814 passed), `pnpm typecheck`, `pnpm check:patterns` (after `pnpm tokens:inventory`), mobile `npx jest` (1164 passed, vocabulary snapshot updated) and `npx tsc --noEmit`.

## Scores, after

Re-captured the same scenarios (desk light for every prefix, dark for `onboarding-*`; phone light and dark). Only screens that changed are listed.

| Screen | Before | After | Why |
| --- | --- | --- | --- |
| Desk: Turn on remote access | 3 | 4 | One name on the title, the button ("Turn it on") and the tick ("Done. Remote access is on.") |
| Desk: Funnel switch off | 1 | 3 | Says what's needed in plain words, the button says it opens a page, and **"Open the Tailscale page" takes focus**, so Enter goes on instead of skipping. Still a trip to a web page I can't preview |
| Desk: Start the import | 2 | 4 | Says why Start exists, then what happens |
| Desk: assistant asking to start | 2 | 4 | "Grok is ready to bring your agents", with what happens next; no promise of a message that isn't there |
| Desk: Scan | 2 | 4 | The phone now has the button it names; nothing focused, so Enter can't skip |
| Desk: sidebar foot | 2 | 4 | Usage, New agent, New room, Pair your phone and Routines share one icon column and one label column, wide and narrow |
| Desk: Phone panel | 3 | 3.5 | Back has its arrow |
| Phone: Tailscale on this phone | 3 | 4 | Says what Tailscale is every time, and to use the Mac's account |
| Phone: Same account | 1 | — | Gone; one screen and one unanswerable decision fewer (6 steps, was 7) |
| Phone: click Pair your phone | 2 | 4 | Big button "Scan the code", the Mac's words; the line tells someone already looking at the code to scan it |
| Phone: Reaching <Mac> | 2 | 3.5 | No localhost address; spinner on the title's first line; the bar stays where it was |
| Phone: Click Allow on your Mac | 3 | 3.5 | The bar stays put |
| Phone: Pair with <Mac>? | 3 | 3 | Now captured in the right theme; still shows "at <host>" in small type (kept: it's what tells you which Mac) |

Overall, the journey for person (a): about 2.5 → 3.5. The engine half was already a 4; Remote Access is the part that still costs attention (see "Left").

## Left, and why

- **Where the custom connector lives in each assistant.** The fix is one line per assistant ("In Claude: Settings → Connectors → Add custom connector"), but each path has to be checked against the live product, and Grok's I couldn't confirm. Inventing menu paths breaks "never assume data".
- **Three "turn on" steps for the phone** (Tailscale on the Mac, phone access, Tailscale on the phone). "Turn on phone access" could happen on "Set up my phone" without its own screen, but it is the Mac staying reachable and awake, which is a real consent; that's the owner's call.
- **Amber "Not done yet" on arrival** at Tailscale on this Mac, before the person has done anything. Every check is meant to say Done or Not done yet; a neutral "not yet" for a check that hasn't been attempted would be a design-system change.
- **The phone's "Get it on your Mac" sends a github.com/…/releases page.** That's `brand.json`'s link; a plain download page would read better to persona (a).
- **"Google Play" on the desk's phone-Tailscale step** while the only phone build is TestFlight. Harmless, slightly noisy.
- **Phone panel's "Build it on this Mac…"** above the big button, shown when the build can do it. Fine for the owner, odd for a DMG user who got a TestFlight link.
- **Demo Settings: "Needs the official build"** reads as wrong to a TestFlight user; on the web build it can't be checked what TestFlight shows.
- **`CLAUDE.md`'s phone pairing line** still describes the old "same account on both" step and "I see the code". Left for the owner (agents don't edit CLAUDE.md on their own).
