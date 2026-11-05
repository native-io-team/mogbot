# Roadmap

Ranked by impact on a knowledge worker × feasibility on our architecture.
Source: a Grok Bot / Replicas / T3 Code gap analysis (Nov 2026). Read
[MISSION.md](MISSION.md) first. We never build our own infrastructure where a
good one exists.

1. **Phone in two taps.** TestFlight / App Store and push via Expo's push
   service; building with Xcode becomes the advanced path. (Needs the owner's
   Apple account and approval to publish.)
2. **Result cards you can review and send back.** One card for changes,
   files and screenshots: preview, before/after, sources, what wasn't
   verified, then Open PR (approval-gated) / Ask for changes / Open.
3. **"When…" routines.** Event-started work (a Linear issue assigned, a
   GitHub mention) via polling routines through the user's own connectors —
   no hosted webhooks.
4. **"What it did" timeline under each reply.** Folded summary, expandable
   steps with screenshots, live while working, with Take over. Our answer to
   Agent Computer and to "silent bots".
5. **Usage before the wall.** Measured cost per agent and routine; quota
   only if the CLI reports it — never estimated.
6. **A git worktree per task** for project-bound agents: no trampling, and
   every task becomes a branch you can PR, merge or discard.
7. **Start fresh, keep memory**, plus a context meter.
8. **A first run that lands one real win.** Role templates, inline connect,
   "drop a document" first task.
9. **A phone that can start things.** Create agents and routines, dictation,
   a "Send to agent…" share extension.
10. **Rooms.** Group chats with 2–6 agents, @one or @everyone.

Small wins: save-as-skill, sections in the agent list, duplicate agent,
reply to a single message.

Then: light mode (desktop + mobile), in progress after the accent system.
