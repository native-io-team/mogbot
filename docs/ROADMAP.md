# Roadmap

Ranked by impact on a knowledge worker × feasibility on our architecture.
Source: a Grok Bot / Replicas / T3 Code gap analysis (Nov 2026), updated by
the audits since. Read [MISSION.md](MISSION.md) first. We never build our own
infrastructure where a good one exists.

## Next, ranked

1. **Phone in two taps.** TestFlight / App Store and push via Expo's push
   service; building with Xcode becomes the advanced path. **Needs the
   owner**: an Apple developer account, and approval to publish. Until then
   the install cards say "Not available yet" (see [mobile.md](mobile.md)).
2. **Result cards you can review and send back.** One card for changes,
   files and screenshots: preview, before/after, sources, what wasn't
   verified, then Open PR (approval-gated) / Ask for changes / Open. Raised
   again by the audits: today work comes back as prose plus a timeline,
   not as something reviewable. *In progress*: `share_result` cards with
   versions and Ask for changes on desk and phone
   ([agents.md](agents.md), "Result cards"); a PR from a non-copy result
   and recordings are not built.
3. **A git worktree per task** for project-bound agents: no trampling, and
   every task becomes a branch you can PR, merge or discard. *In progress.*
4. **"Take over" a browser tab.** Driving the agent's own session in a
   terminal is built ([agents.md](agents.md), "Take over"); stepping into the
   Chrome tab it drives is not. Codex take-over is unverified on a real thread.
5. **"When…" routines.** Event-started work via polling checks through the
   user's own `gh`, folders and connectors — no hosted webhooks. *In
   progress*: GitHub mentions/assignments, new files, Linear and free-form
   connector checks are built ([agents.md](agents.md), "When… routines");
   connector checks are not yet verified on a live account, and the phone
   shows them read-only.
6. **A first run that lands one real win.** Role templates, inline connect,
   "drop a document" first task.
7. **Import the team from Ship Studio on this Mac** (read-only), so moving
   over is one step. *In progress.*
8. **Rooms.** Group chats with 2–6 agents, @one or @everyone.

Small wins: save-as-skill, sections in the agent list, duplicate agent,
reply to a single message.

## Done

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
