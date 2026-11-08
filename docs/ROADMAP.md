# Roadmap

Ranked by impact on a knowledge worker × feasibility on our architecture.
Source: a Grok Bot / Replicas / T3 Code gap analysis (Nov 2026), updated by
the audits since. Read [MISSION.md](MISSION.md) first. We never build our own
infrastructure where a good one exists.

## Next, ranked

1. **Phone in two taps.** TestFlight / App Store and push via Expo's push
   service; building with Xcode becomes the advanced path. **Needs the
   owner**: TestFlight needs the owner's Apple developer account, and
   approval to publish. Until then the install cards say "Not available
   yet" (see [mobile.md](mobile.md)). The store build, a demo for App
   Review, the review notes, listing drafts and the owner's remaining steps
   are ready in [app-store.md](app-store.md).
2. **Phone: real-device verification.** The share extension, dictation's
   real recognizer, notification click-through and Android hardware have
   only been tried in tests or the simulator ([mobile.md](mobile.md), "Not
   built").
3. **"Take over" a browser tab.** Driving the agent's own session in a
   terminal is done; stepping into the Chrome tab it drives is not. Codex
   take-over is unverified on a real thread.
4. **Watch claude.ai connectors.** Linear or Gmail set up as claude.ai
   connectors can't be watched by a "When…" check (the sealed call loads
   only apps configured in Claude Code itself), and connector checks are
   not yet verified on a live Linear or Gmail account
   ([agents.md](agents.md), "When… routines").
5. **Usage wallets.** Several Claude Code and Codex accounts in Settings →
   Agents, in priority order; when one hits its usage limit the turn
   switches to the next and carries on, with a line saying so, and ends
   honestly when every account is out. In progress.
6. **Results, the rest.** A PR straight from a non-copy result, and
   recordings.

Small wins: save-as-skill, sections in the agent list, duplicate agent,
reply to a single message.

## Done

- **Describe the agent you want** — one prompt drafts the whole agent (name,
  colour, briefing, routines read by the app's grammar, apps it will need) for
  one review before Create; desk, phone and the Chief
  ([agents.md](agents.md), "Describe the agent you want"). Not yet tried on a
  live engine.
- **Routines in steps, with your OK in the middle** — "draft, wait for my OK,
  post": an "OK to go on?" card shows what step 1 made and step 2's words; Go
  ahead is a yes exactly as wide as the card (`ask_plan` covers what it
  named); desk and phone editors ([agents.md](agents.md), "Routines in
  steps"). Not yet run end to end on a live engine.

- **Defaults for new agents** — Settings → Agents sets the engine (Claude
  Code or Codex, only when ready) and a model per engine, from only the
  models each engine lists; the New agent dialog, the Chief's
  `create_agent` and the phone's New agent start there, existing agents
  don't change; the phone reads and sets it (`agents.setDefaults`, audited);
  ⌘K "Engine and model for new agents…" ([agents.md](agents.md), "Defaults
  for new agents"). Not yet tried on a live Codex account's model list.
- **Rooms** — group conversations with 2–6 agents: @one, @everyone, or the
  room's lead; agents bring each other in with @Name, at most 8 agent turns
  per message; cards, timelines and results inline under the agent; on the
  phone for apps that say they show rooms ([agents.md](agents.md), "Rooms").
- **A first run that lands one real win** — the Chief's starters summarise a
  picked document or research a question (staged, sent by the user);
  ready-made agents (Research assistant, Inbox triage, Weekly review) from the
  Chief, New agent, ⌘K and the phone; Inbox's "Connect an app" only where it
  is needed ([agents.md](agents.md), "A first real result"). Not yet tried on
  live turns per template.

- **Result cards you can review and send back** — one card per piece of
  work (files, links, before/after, "It says it checked", what wasn't
  verified); Ask for changes makes a new version; desk and phone
  ([agents.md](agents.md), "Result cards").
- **A copy of the project per task** — a project-bound agent works in its own
  worktree on its own branch; Keep changes / Review changes / Preview /
  Discard, and ⋯ → Open a pull request ([agents.md](agents.md), "A copy of
  the project per task").
- **Take over** — step into an agent's own session in a terminal, then Hand
  back, from the menu, the working line and ⌘K; the phone shows it
  ([agents.md](agents.md), "Take over").
- **"When…" routines** — GitHub mentions and assignments, new files in a
  folder, Linear and free-form connector checks; sealed, capped, and asking
  before they change the team. The desktop schedules with the phone's
  routine picker; the phone shows "When…" routines read-only.
- **Import** — from Ship Studio on this Mac, and a sealed connector interview
  ending on one review card.
- **Nothing goes silent** — panics, stops, restarts and cut-off turns end in
  a line that says so, and delegators are told.
- **Security, first pass** — one strict sanitizer with images as links, a
  navigation guard and an open allowlist; the phone's Mac-proves-first
  pairing with a pinned identity in the Keychain, always confirmed on the
  desk, and DoS limits.
- **Coherence** — Line / Card / Bar, neutral affirmatives and one
  vocabulary, on desktop and phone; Settings → Agents as the first tab.

- **Usage before the wall** — cost per agent and per routine this week, and
  the plan's usage ("Claude usage 85% · resets Sat", amber from 90%) only as
  Claude Code / Codex report it, on desktop and phone. Codex's plan reading is
  unverified on a signed-in account ([agents.md](agents.md)).
- **"What it did" timeline under each reply** — folded summary, observed
  steps and outcomes, screenshots, live while working, on desktop and phone.
  ("Take over" split out above.)
- **Start fresh, keep memory**, plus an honest context meter (only what the
  engine reports).
- **A phone that can start things** — new agents, a routine picker,
  dictation, "Send to agent…". The share extension and dictation's real
  recognizer are not yet verified on a device ([mobile.md](mobile.md), "Not built").
- **Light mode** — System / Light / Dark on desktop and phone, through
  semantic tokens, with a neutral focus ring.
- **Agents first** — launch and onboarding land on the Chief of Staff;
  onboarding asks only for an engine (Claude Code or Codex).
- **Codex as an engine**, per agent.
- **Own identity** — `brand.json`, this app's own state beside Ship
  Studio's, Ship Studio's endpoints off; monochrome with the Chief's colour
  as the accent, scoped per agent.
