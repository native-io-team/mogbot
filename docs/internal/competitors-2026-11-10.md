# Competitor scan, 2026-11-10

What OpenBot, Grok Bot, Meta Muse and Reason Machines shipped or announced from about
2026-10-27 to 2026-11-10, plus one close competitor the earlier notes missed (Orca), checked
against this repo. Read after [competitors-2026-11-09.md](competitors-2026-11-09.md) and
[competitors-2026-11.md](competitors-2026-11.md); nothing here repeats them unless it changed.

**Evidence marks** (as in the 11-09 note). **[V]** the vendor's own page, changelog or repo.
**[C]** press or a changelog aggregator. **[U]** a user's own words. Nothing was installed or
used hands-on. Long pages were read through a summarising fetch: re-open the link before quoting.

**Repo checks** were made against `mogbot` at `7c5ac2b56` (2026-11-10): `src-tauri/src/agents/`,
`mobile/src/`, `src/components/agents/`, `docs/agents.md`, `docs/mobile.md`, `docs/ROADMAP.md`.
"Have it" means the code and its doc section exist; several of these are built but not yet tried
on a real device or live account, which the docs say themselves.

Since the 11-09 note, much of its top 15 has landed here: several conversations per agent
(`conversations.rs`), recipes (`recipe.rs`), export-file import for Grok Bot / OpenBot / Hermes /
OpenClaw (`import_export.rs`), "Where did my usage go" (`usage_story.rs`), Mac apps as one-Allow
tools (`mac_apps.rs`: Calendar, Reminders, Contacts, Notes, Messages), the morning brief
(`brief.rs`), rooms of several agents (`rooms.rs`), the other engine on a limit (`crossover.rs`),
voice messages, Listen, Siri and a Live Activity on the phone (`docs/mobile.md`).

---

## 1. What shipped, product by product

### OpenBot (Nightly Labs): 18 releases in 14 days (0.52.0 Oct 27 → 0.66.0 Nov 9) [V: [changelog](https://openbot.run/changelog)]

| What | When | Mogbot | Matters for "hard tasks, easy"? |
|---|---|---|---|
| iPhone app on the App Store | 0.52.0, Oct 27 | **Lacks** (self-build only; ROADMAP #1, needs the owner) | High: the phone is the product |
| Several threads per agent, running at once; rename, archive, search | 0.52.0 | **Have** (`conversations.rs`; one turn at a time per agent) | Done |
| Background memory saving with a review cadence; 256 memories per agent | 0.53.2 | **Partial** (agent maintains `## Memory` in its own turns; no background pass) | Low |
| Several agents answer one channel request; `@everyone` | 0.55.0 | **Have** (`rooms.rs`) | Done |
| Import guides for Grok Bot and Hermes | 0.55.0 | **Have** (`import_export.rs`) | Done |
| Branch a conversation into a new thread; Cancel task | 0.57.0 | **Lacks** | Medium |
| Agent's `AGENTS.md` shown in settings; **Undo** when the agent changes its own instructions | 0.57.0 | **Partial** (instructions and memory shown and editable desk and phone; no undo of an agent's own edit found) | Low–medium |
| GitHub events start workflows; outputs comment/label/assign | 0.58.0 | **Have** for mentions/assignments ("When…" routines); no outputs-as-config | Done enough |
| Webhook routines (Standard Webhooks) | 0.59.0 | **Lacks, by design** (nothing of ours is reachable from the internet) | Low |
| Agents ask you to add a login, card or address to the Vault; Link card payments | 0.59.0 | **Partial** (masked secret cards into the Keychain; money always asks; no stored cards/addresses) | Low now |
| Discord / Slack / Telegram / WhatsApp start workflows and get results; agents send files there | 0.59–0.62 | **Partial** (Slack only, `slack.rs`) | Medium |
| Agents create, change and run workflows; deleting one asks even at full access | 0.61.0 | **Have** (routines set from chat behind cards) | Done |
| Each routine runs in its own thread | 0.61.0 | Not checked whether ours do | Low |
| Codex live voice (two-way) | 0.61.0 | **Partial** (Talk on the phone, 11-10: a hands-free listen → send → read-aloud loop on the phone's own recognizer and voice, half duplex, not yet tried on a device) | Medium |
| Usage-limit chip in the model picker; Kimi/OpenCode limits | 0.60–0.58 | **Have** (usage on sidebar, phone, per account) | Done |
| Audit log, company sign-in (OIDC) for servers | 0.60.0 | Out of scope (single professional) | — |
| Per-profile browser proxies; use your own computer as a profile's proxy | 0.62.0 | **Lacks**; per-agent browser profiles exist (`browser_profiles.rs`) | Low |
| Claude agents **no longer load your `~/.claude` setup** by default ("Use my Claude Code setup" to opt back in) | 0.64.0 | Ours load the user's `~/.claude/CLAUDE.md` into every turn (docs/agents.md line ~425) | Watch: a choice, not a gap |
| Side panel for agent-made pages; a **Library** page; multi-select | 0.65–0.66 | **Partial** (result cards, files back, blocks; no per-agent library of pages that stays current) | High (see gap 3) |
| **Skill learning**: Automatic / Ask first / Off | 0.66.0 | **Lacks** (save-as-skill is a ROADMAP "small win", not built) | High (see gap 2) |
| Agents file bug reports and feature requests on GitHub | 0.66.0 | Not found | Low |
| Agents watch videos; Eleven v4 / xAI voices | 0.65–0.66 | **Lacks** | Low |

Read: OpenBot is now shipping the team-chat substrate (channels, threads, vault, chat-app front
doors) faster than anyone; its weak spot is still safety (full access by default, noted 11-09).

### Grok Bot (xAI / Cursor)

- **Calls businesses for you** (US numbers; announced by Musk on X Oct 25, live from about
  Nov 3): the Bot dials from a temporary number, navigates the menu, shows a live transcript,
  relays questions you answer in a box, pauses for approval before accepting terms; you are the
  "caller of record" and calls (hold time included) spend weekly usage.
  [C: [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/grok-bot-calls-customer-service-but-humans-remain-on-the-hook/),
  [ALM Corp](https://almcorp.com/news/grok-bot-calls-businesses-for-users/)]
  **Mogbot: lacks.** Matters medium-high: "sort out my internet bill" is exactly a hard task
  people hate, but it needs a telephony provider we would not build.
- **Shopping and subscriptions** (v0.78.1, Oct 27): product cards and carousels, orders you
  approve, order tracking, Shop Pay in the Vault, templates that cancel free trials before
  billing and find unused subscriptions; Bots start cloud agents in named custom modes.
  [C: [gradually.ai changelog mirror](https://www.gradually.ai/en/changelogs/grok-bot/)]
  A Nov 2–3 demo added team-bot sign-in, sharing and discovery, Slack connector requests and
  Vault contacts. [C: [TechFlow](https://www.techflowpost.com/en-US/newsletter/142625)]
  **Mogbot: partial** (the browser can shop; every buy asks, by design; no product cards or
  order tracking). Low priority for us.
- **The usage crisis continued**: Musk on Nov 1, "unsustainably high relative to revenue"; a
  Cursor forum thread on slow chat and lost messages (Nov 6); Musk promised overnight fixes
  (Nov 8–9) without announcing higher limits or a reset; a user says a $200 plan lasted 14 hours.
  [C: [FourWeekMBA](https://fourweekmba.com/ai-musk-promises-overnight-grok-bot-fix-after-usage-complaints/);
  U: quoted there] **Mogbot: have** the answer (several accounts, crossover, "Where did my usage
  go", honest meters). This is still the best moment to say so.
- An unverified aggregator mention of a "Meetings" feature that appeared and was pulled; not
  confirmed anywhere. [C, unverified]

### Meta Muse

- **Muse Voice** (Nov 5): video chat with your agent and give it commands by voice; rollout
  appears US-first. [C: [TechCrunch](https://techcrunch.com/2026/11/06/meta-introduces-spaces-a-new-way-to-collaborate-with-your-muse-agent/)]
  **Mogbot: partial** (Talk: a hands-free loop on the phone, voice only, no video; not yet on a device).
- **Spaces** (Nov 6): a topic conversation in the sidebar (trip, wedding, gift tracker) where
  you describe an idea and Muse builds a tracker, planner or board, connected to apps and
  **updated in the background** (price changes, concert dates, savings).
  [C: [TechCrunch](https://techcrunch.com/2026/11/06/meta-introduces-spaces-a-new-way-to-collaborate-with-your-muse-agent/)]
  **Mogbot: partial** (conversations, routines and result cards exist; nothing persistent that a
  routine keeps current).
- **Apple Watch app** (Nov 9): text, dictate or call the agent; a complication.
  [C: [MacRumors](https://www.macrumors.com/2026/11/09/meta-muse-apple-watch/)] **Mogbot: lacks.**
- Muse Ember (cheap 1M-context model, Nov 9) and a Mexico launch (Nov 6). Not product gaps for us.
  [C: [TechCrunch](https://techcrunch.com/2026/11/09/meta-releases-muse-ember-a-new-lightweight-model-for-agent-execution/)]

### Reason Machines

- Site lists a blog post "**Aspen**: scaling agentic commits beyond what Git was built for"
  (2026-11-05) and customer posts dated Nov 2 and Nov 4; Slack `@Reason` returns a PR, deck or
  answer; a session API; benchmark claims vs Codex. Still no pricing, phone app or approvals on
  the page. [V: [reasonmachines.com](https://reasonmachines.com)] I could not open the Aspen
  post itself or find coverage of it; "Reason Network" (agents talk to each other directly)
  dates from Oct 16. [C: [magica](https://magica.com/news/reason-machines-reason-network-agent-communication)]
  Nothing new here changes our priorities; they remain engineers-only.

### New close competitor: Orca (stablyai/orca) — not in the earlier notes

MIT, **~120,900 GitHub stars**, desktop on macOS / Windows / Linux, **phone on iOS and Android**,
and a headless remote runtime; releases almost daily (1.4.244 Oct 29 → 1.4.255 Nov 9).
[V: [repo](https://github.com/stablyai/orca), release notes via `gh release view`]
A coding tool by audience, but the shape is ours: a coordinator agent splitting work across
worker agents in their own worktrees, automations, usage & accounts, a phone app. In the window:

| What | When | Mogbot |
|---|---|---|
| Orchestrator V3 (coordinator + workers, nested workers, quieter worker notifications) | 1.4.246, 1.4.251 | **Have** the idea (Chief delegates, 6-hop cap); not a split-and-merge of one task |
| Continue on another account or harness at a usage limit; **resume a chat automatically when its limit resets** | 1.4.246–247 | **Have** (wallets, crossover, "Retry at" check-in at the reset) |
| Phone Home: Feed / Usage / Automations; run automations from the phone; Light/Dark | 1.4.246, .249 | **Have** |
| Phone: browse commits, diffs, read and add PR review comments | 1.4.247 | **Partial** (diff view on the phone; no PR review comments) |
| **Rewind to an earlier message, fork a finished reply, continue a stopped reply** (desk and phone) | 1.4.251–252 | **Lacks** (gap 5) |
| Chat turns list changed files and line counts; PR cards per opened PR | 1.4.250, .252 | **Have** (result cards, "What it did") |
| Browser password manager, encrypted with OS storage | 1.4.250 | Ours never holds passwords, by design |
| Background computer use on Mac (Chrome, Blender) while you keep the mouse | 1.4.245 | Not checked |

Also seen, smaller (all open source, Mac + iPhone, coding-first; star counts and dates from their
pages, no release dates shown): **Superagent** (MIT; a paired phone can deny but not approve)
[V: [repo](https://github.com/pungme/superagent-desktop)], **Ateam** (GPL; Allow / Always / Deny
cards, agents on a Linux box over Tailscale, "Ateam Go" on the App Store)
[V: [repo](https://github.com/clawnify/ateam)], **Diri** (AGPL; agents start other agents,
scheduled runs that wake the Mac, reads summaries aloud) [V: [diri.sh](https://diri.sh/)].
The field of "your agents, your Mac, your phone" apps is now crowded at the coding end; none of
these targets non-developers, which is still our room.

---

## 2. Top 5 gaps worth building next, ranked

Ranked by how much each makes a hard task easier with less of the user's attention, against this
fortnight's evidence. Size: **S** under a week, **M** 1–3 weeks, **L** more or needs the owner.
"Touches" is a starting point; confirm in code before building.

1. **The phone from the App Store (and Play), paired in one scan.** Still first. In two weeks
   OpenBot put its iPhone app on the App Store (Oct 27), Orca shipped iOS and Android builds every
   few days, Ateam's phone app is in the store, and Muse added the Apple Watch. Every competitor
   in this note is installed from a store; ours is built with Xcode. Everything else on the phone
   (Live Activity, Siri, share extension, actionable notifications) is unverified until a store
   build reaches a real phone, so this unblocks the rest. The store build, review notes and
   listing are ready (`docs/app-store.md`); what remains is the owner's Apple account and approval
   to publish. *Who:* OpenBot, Orca, Ateam, Muse, Grok. *Size:* L, owner-gated.
   *Touches:* `mobile/`, `docs/app-store.md`, `companion/` push.

2. **Agents that learn a skill from a hard task they finished.** After a turn that took many steps
   (a new site's export flow, a filing routine, a report format), the agent offers one card:
   "Save how I did this as a skill?" with the steps written as a `SKILL.md` it drafts in a sealed
   call; Allow saves it to the agent's home (or the team's), and next time the same request is one
   sentence. Per agent: **Automatically / Ask me / Off**, defaulting to Ask, changeable in chat.
   A saved skill shows in "What it can reach" and travels in recipes by name. OpenBot shipped
   exactly this (0.66.0, Nov 9); Grok's "teach" and Hermes's skill loop do the same job. It is the
   most direct form of "complex made easy": the second time costs nothing. ROADMAP already lists
   save-as-skill as a small win. *Size:* M. *Touches:* a new `agents/skills_learn.rs` beside
   `draft.rs` (sealed draft), `turn_end.rs` (when to offer), `recipe.rs`, agent editor and
   `mobile/src/app/instructions.tsx`.

3. **A living page per conversation: a tracker the agent keeps current.** "Plan the offsite",
   "watch these five competitors", "track the house sale": the conversation gets one page
   (a table, checklist or board, rendered through `blocks.rs`'s sanitised blocks) pinned above the
   chat on desk and phone, and the agent's routines update it in place, with a line in "What it
   did" each time it changes and the old version one tap back. Muse's Spaces (Nov 6) is exactly
   this for consumers; OpenBot added a side panel for agent-made pages and a Library (0.65–0.66);
   Grok has Pages. Ours are point-in-time result cards, so long-running work has no one place to
   look. The pieces exist (conversations, routines, blocks, results' versions); this joins them.
   *Size:* M. *Touches:* `conversations.rs` (a page per conversation), `blocks.rs`, `results.rs`
   versioning, `schedule.rs`, `components/agents/` chat header, `mobile/src/components/ChatView.tsx`.

4. **"When an email or text arrives…" from this Mac's own Mail and Messages.** "When an invoice
   email arrives, file it" and "when my landlord texts, tell me and draft a reply" are the
   routines people ask for first, and today they need a Gmail connection or a model-call check.
   Mail and Messages on this Mac already hold both, signed in and synced: a free, local "When…"
   source (Mail's envelope index and `chat.db`, read-only, as `mac_apps.rs` reads Messages now)
   that fires once per new message, with the message passed in as **outside text** (sealed, as
   today's connector checks are). Grok Bot has email triggers; OpenBot added Discord, Slack,
   Telegram, WhatsApp and webhook triggers in this window (0.58–0.62). We can't take webhooks,
   but the Mac is the one place that can watch mail and iMessage with no account at all, which
   is our access chain's second rung. *Size:* M. *Touches:* `watch.rs` (two new sources),
   `watch_options.rs`, `mac_apps_os.rs`, `exposure.rs` (mail is already outside content),
   routine editor desk and phone, docs/agents.md "When… routines".

5. **Rewind, fork and edit-and-resend.** On any of the user's messages: **Edit and resend** (the
   conversation continues from there; what came after stays readable, folded); on any reply:
   **Try another way** (forks into a new conversation with the same memory, the original kept).
   Orca shipped rewind, fork and continue-a-stopped-reply on desk and phone (1.4.251–252, Nov 6–7);
   OpenBot branches a conversation into a thread (0.57.0). On a long, hard task the wrong turn
   is common, and today the only ways out are "no, do X instead" (which keeps the mistake in
   context) or Start fresh (which loses the work). Claude Code can fork a session (`--resume` with
   `--fork-session`); whether Codex's app-server can fork a thread was not checked, and where it
   can't, a fork starts a new session with the app's recap (as crossover does). Mostly UI and log
   bookkeeping. Must say honestly that work already done outside the chat (files written,
   messages sent) is not undone. *Size:* S–M. *Touches:* `conversations.rs`, `sessions.rs`,
   `engine.rs` / `codex_app.rs`, `messages.jsonl` tagging, chat bubbles desk and phone.

**Close behind, not in the five:**
- **Live voice and the Watch** (Muse Voice and Watch, OpenBot's Codex live voice, Grok's voice
  chat). We have voice messages and Listen; a live conversation and a Watch app are easier with
  a store build first (gap 1). *M–L.*
- **Calling a business for you** (Grok, Nov 3). High value for exactly the chores people hate,
  but it needs a telephony and speech provider on the user's own account (and the user as
  caller of record); worth a spike only after the above. *L.*
- **An always-on host** (Orca's headless runtime, OpenBot's servers, Ateam's Linux box): still
  item 14 from 11-09; MISSION requires nothing block it. *L.*
- **More chat front doors** (Telegram, WhatsApp, Discord), after Slack proves out.

**Not a gap, a decision to watch:** OpenBot stopped loading the user's `~/.claude` setup into
agents by default (0.64.0). Ours load `~/.claude/CLAUDE.md` on every turn. That is useful (the
user's standing instructions apply) but means one personal file shapes every agent; worth a
one-line mention in the agent's "What it can reach" rather than a change.

---

## 3. What is and isn't verified

- **Read on vendor pages or repos:** openbot.run changelog (0.52.0–0.66.0; long page read in
  three summarised slices, 0.52–0.57 and 0.58–0.62 as condensed lists), reasonmachines.com home,
  Orca's repo and its release notes 1.4.244–1.4.255 (via `gh`), Superagent and Ateam repos,
  diri.sh.
- **Third-party only:** everything on Grok Bot in this window (x.ai/bot/changelog returned 403;
  the changelog detail is from the gradually.ai mirror, which said its last successful fetch was
  over 48 hours old), all Muse items (TechCrunch, MacRumors; no Meta page read), Reason Network.
- **Couldn't verify:** Reason's "Aspen" post contents; the Grok "Meetings" feature; whether Grok
  Bot's Nov 8–9 fixes changed limits; Muse Voice's availability and pricing; star counts or
  release dates for Superagent, Ateam and Diri beyond their pages. No X/Twitter posts were read
  directly; X items are as quoted by the press.
- **Not checked:** Claude Duet, OpenAI Dots and the Codex app in this window; OpenBot's pricing
  page changes; whether our routines run in their own conversation; whether our desk takes
  background computer use as Orca does. "Mogbot has it" means code and docs exist, not that it
  was run for this note; several such features are documented as not yet tried on a device or a
  live account.
- **Source bias:** gradually.ai is an aggregator; ALM Corp and PYMNTS are commentary; star counts
  move daily.
