# First-run review, 2026-11-09

An adversarial walk through the first ten minutes, as someone non-technical and
impatient who pays for Claude and has never heard of the app. Desk: the UI
harness (every `onboarding-*` scenario, `onboarding-end-to-agents`, the Chief's
greeting and starters, New agent, the first approval and result cards, the
independence slider and level picker, the phone pairing screens). Phone:
`qa:web`, the pre-pair welcome, pairing and the demo. Both themes.

Not checked: the real app in WKWebView, a real install or sign-in, a real
phone, the Rust side (no Rust was touched), and whether anything here moves
real behaviour; it is copy, emphasis and layout only.

## Against how the others describe their first run

From `competitors-2026-11.md` (vendor pages, not hands-on):

- **OpenBot**: download, connect a provider, describe the agent you want in one
  prompt, review, save, send work. Four moves to first work.
- **Claude Cowork / Dispatch**: you already have the app and the plan; the
  phone is one thread through Anthropic's cloud. Zero setup to first work.
- **Reason**: a Mac app for engineers; nothing stated about onboarding.

Ours, to a first message: Welcome, Engine (install + sign-in), Accounts,
Independence, Phone (or skip), Ready. Five questions before the Chief, which is
fine only if each one is obviously skippable and the obvious answer is the big
button. Before this pass, two of them (Accounts, Ready) made the *unusual*
answer the big one, and the first screen after onboarding read as a coding
tool, which is the opposite of OpenBot's "describe what you want" and Cowork's
"it just works".

## Everything that tripped me, in the order I met it

| # | Where | What a first-timer hits | Kind |
| - | - | - | - |
| 1 | Accounts | The big button is "Add a Claude Code account" right after signing in; Skip is small. Most people have one account, so the default path is the small link | wrong emphasis, extra click |
| 2 | Accounts | "this Mac's own sign-in" | jargon (kept: the account switcher on desk and phone uses the same words, `accountSwitcher.ts`) |
| 3 | Independence | "Continue" and "Skip" do the same thing for the preselected default | redundant (not changed: Skip deliberately leaves the level unset) |
| 4 | Independence | Steady: "asks before running changes" | unclear (not changed: level text is part of the security description) |
| 5 | Phone intro | "over your own Tailscale" with no word on what Tailscale is | jargon |
| 6 | Phone | "Skip for now" here, "Skip phone setup" on every other phone screen | inconsistent word |
| 7 | Tailscale on this Mac | Arrives showing an amber "Not done yet" before you did anything | alarming (not changed: the flow's rule is that every check says Done or Not done yet) |
| 8 | Phone app | "Get the Mogbot app", "Build the Mogbot app" | name prominent (kept: it is the home-screen name you have to find) |
| 9 | Phone app, build | The embedded build panel is 520px inside a 720px column, so the agent's card wraps one word per line | broken layout |
| 10 | Phone app, build | No Back at the top (every other screen has one); the inner back link says "Routes" | dead end, jargon |
| 11 | Phone app, build | Xcode, CocoaPods, Command Line Tools, "Release build… bundler" | developer jargon (not changed: it is the guided build until TestFlight exists) |
| 12 | Scan this code | Says "tap Pair, then point the camera"; the phone's button says "Scan the code", and "Pair" comes after the scan | wrong word, dead end |
| 13 | Scan this code | Step 1 is "Install Tailscale on your phone…", which the two screens before just did and checked | repeated step |
| 14 | Ready | "Bring my agents" is the big solid button, "Start fresh" the outline. Someone new has nothing to bring, and the big button leads into Remote access, Tailscale Funnel and a connector | wrong emphasis, detour |
| 15 | Remote access | "It turns on by itself", then "Not done yet. Funnel is off…" | contradiction, jargon |
| 16 | Chief's greeting | Starters "Ship fixes while I sleep…" (GitHub issues), "Turn client briefs into sites…"; the first screen reads as a coding tool. This was fixed on 2026-11-05 (`55037bfa`) and undone by a merge (`2e4394b1`) | regression |
| 17 | Chief's greeting | Starters end in "…" and read as cut off | minor (kept: the "…" means it types, it doesn't send) |
| 18 | Sidebar | "All quiet" above the only agent | unclear (not changed) |
| 19 | New agent | Placeholders are the same colour as typed text, so the dialog looks filled in and the disabled "Draft it" looks broken | looks pre-filled |
| 20 | New agent | Describe-and-draft and the full form on one screen, plus "Or start from" | busy (not changed) |
| 21 | Phone, pair | "Settings → Phone → Pair a phone" on the Mac. There is no Settings → Phone; it is Settings → Agents → Phone | dead end |
| 22 | Phone, before scan | The Tailscale checklist is ticked before anything is checked | looks verified (not changed: icon-only; worth a later pass) |
| 23 | Phone, demo | The floating tab bar sits over the "This is the demo" card and the title | web artifact per docs/mobile.md; not verified on a device |

## The ten fixed

1. **Ready: Start fresh is the big answer** (#14). Swapped emphasis and order;
   the line now asks "Already running agents in Grok, ChatGPT or another
   assistant? You can bring your agents from there first."
   `SimpleSteps.tsx`.
2. **Starters for people who don't code** (#16). Restored the 2026-11-05 chips
   (Brief me every morning, Run an inbox triage crew, Run my launch as a team)
   and their harness scenarios exactly as `55037bfa` left them; docs/agents.md
   already described them. `chiefIdeas.ts`, `agentsFirstWin.ts`, test.
3. **Placeholders look like placeholders** (#19). `.ss-text-field::placeholder`
   goes from `--text-secondary` (the unfocused value colour) to `--text-muted`.
   Global to the text-field primitive. `text-field.css`.
4. **Accounts: Continue is the big button** (#1). Adding an account is a quiet
   line per installed engine under the list; no Skip needed. `AccountsStep.tsx`.
5. **The build panel gets its column** (#9). `.flow-embed.phone-modal` takes
   the full width instead of the Phone panel's 520px. `onboarding-flow.css`.
6. **Back on the build screen** (#10). The top Back returns to the iPhone /
   Android choice; the inner link says "Other ways" rather than "Routes".
   `PhoneSteps.tsx`, `PhoneInstall.tsx`.
7. **The phone's own words on the pairing code** (#12). "Tap Scan the code,
   then point the camera… Tap Pair, then allow the phone here." `PhonePairing.tsx`,
   `PhoneSteps.tsx`.
8. **No repeated Tailscale step in onboarding** (#13). `PairCode` takes
   `tailscaleChecked`; onboarding passes it (the screens before checked it), the
   Phone panel still shows the step.
9. **The phone names a place that exists** (#21). Every "Settings → Phone" on
   the phone is now "Settings → Agents → Phone"; "onboarding screen" is
   "setup screen". Vocabulary snapshot updated on purpose.
10. **Tailscale and Funnel said plainly** (#5, #6, #15). Phone intro: "through
    Tailscale, a free app that links your own devices privately"; its skip says
    "Skip phone setup" like the rest. Remote access: "This screen turns it on;
    Tailscale may ask you to allow it once", and the check says "Tailscale
    needs your OK before the link can reach this Mac", naming Funnel as
    Tailscale's word for it. `PhoneSteps.tsx`, `ImportSteps.tsx`,
    `onboardingFlow.ts`.

## Worth deciding, not done here

- **Fewer questions before the Chief.** Done in the follow-up below.
- **Independence Skip vs Continue.** Moot: the screen is gone.
- **The phone's pre-scan ticks** read as verified; a neutral bullet would be
  honest.

## Screenshots

Before and after, light and dark (harness at 1440×900 @2x; phone at 402×874
@3x), in the session scratchpad: `before-dark/`, `before-light/`,
`after-dark/`, `after-light/`, `phone-before/`, `phone-after/`.

## Follow-up, same day: two screens to the Chief

Following the competitor teardown (`competitors-2026-11-09.md`, recommendation
1), onboarding is now Welcome and the engine, then the Chief's chat. Counted
in the harness on a Mac with nothing installed, choosing Claude Code:

| | Screens before the Chief | Clicks before the Chief |
| - | - | - |
| Before | 8 (Welcome, pick, install, sign in, Accounts, Independence, Phone, Ready) | 6 (+ the terminal) |
| After | 4 (Welcome, pick, install, sign in) | 2 (+ the terminal) |

With the engine already set up: 6 screens and 6 clicks before, 2 and 2 after.
From the Chief's greeting to a first brief is the same as before: a starter,
the one blank, Send.

Each question that left has a moment instead, and each is skippable:

- **Bring your agents?** One card under the greeting and starters
  (`ImportChoiceCard`, now after them on a first run, so the Chief speaks
  first). Its three onboarding screens are gone; the card's Bring my agents
  opens the same import.
- **Your phone.** A card in the Chief's chat once the first thing asked for
  has come back (`ChiefPhoneOffer`): Set up my phone opens the Phone panel,
  Not now puts it away. Never with a phone paired or the import question
  open. "Get the phone app" at the sidebar's foot is unchanged.
- **Another account.** "Add another account" on the usage-limit line, the
  moment one runs out (opens the account row's add).
- **Independence.** The default (Steady, asks before anything risky) holds;
  the Chief already offers a change when the user sounds fed up
  (`level_hint.rs`), and Settings → Agents has the slider.

Also: the screen's big button (or the recommended engine card) takes focus
whenever nothing has it, so Enter always goes on and Tab starts there; the
engine card's focus ring is the app's neutral one, not the browser's blue; a
cancelled install or sign-in says "Not done yet. Sign-in was closed before
it finished." instead of going quiet. A launch saved on one of the removed
screens counts as finished.

Not checked: a real install or sign-in, WKWebView, the phone's own import
card wording, and whether the phone card's timing feels right on a real
first run (it keys off the first reply, not a result card).

## Second pass, 2026-11-10: the engine screens and the first reply

Walked again in the harness, light and dark, Welcome to the first result.
Fixed:

- **The install and sign-in screens were never actually looked at running.**
  The harness's mock action answered at once, so `onboarding-engine-install`,
  `-signin` and `-codex-prereqs` captured "Not done yet. … closed before it
  finished" instead of the spinner. They now hold the action open
  (`neverAnswers`), and the closed state has its own scenario,
  `onboarding-engine-closed`.
- **No line repeating the button.** A cancelled install said "Press Try
  again." over a Try again button; it now says only what happened. A
  cancelled sign-in keeps the one useful line ("Already signed in in the
  browser? This screen notices in a moment."). `CheckResult.fix` is optional.
- **The check box was taller at the bottom than the top**: an empty actions
  row still took its gap. It renders only with an action in it.
- **"Couldn't check this Mac" was the one red box in onboarding**, and said
  Try again twice (sentence and button). It is now the same check every
  screen uses: "Not done yet. Couldn't check this Mac." and Check again.
- **A grey strip across the top in light.** The fixed top band was filled
  with the app surface over the lit mat; it is transparent now.
- **"It installs in a window here"** with no window yet: "A window opens
  here and installs it."
- **The phone card no longer interrupts the Chief's question.** After a
  first reply ending "…Want me to?", the card sat between the question and
  the answer the user was about to type. `reachedFirstResult` now waits for
  a reply that doesn't end on a question, unless it brought a result card.

Not changed, worth deciding:

- The import card's bright button is "Bring my agents", while the 2026-11-09
  pass made "Start fresh" the big answer on the old Ready screen.
- First-run chrome: Usage and Routines each appear twice (header and
  sidebar), and the sidebar says "Usage · Not read yet" before anything has
  run.
- A starter fills the composer ending "My topics:" with Send live, so an
  empty blank can be sent.
- Installing still shows a raw terminal to someone non-technical.

Not checked: a real install or sign-in, WKWebView, the phone.
