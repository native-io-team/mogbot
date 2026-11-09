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

- **Fewer questions before the Chief.** Accounts and Independence could move
  out of onboarding into the Chief's first replies ("want a second account so
  nothing stops?"), getting closer to OpenBot's four moves. That changes the
  flow's shape, so it is a product call.
- **Independence Skip vs Continue.** Skip leaves the level unset rather than
  saving the default; if that difference doesn't matter to the user, one button
  is clearer.
- **The phone's pre-scan ticks** read as verified; a neutral bullet would be
  honest.

## Screenshots

Before and after, light and dark (harness at 1440×900 @2x; phone at 402×874
@3x), in the session scratchpad: `before-dark/`, `before-light/`,
`after-dark/`, `after-light/`, `phone-before/`, `phone-after/`.
