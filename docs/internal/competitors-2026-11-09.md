# Competitor teardown, 2026-11-09

A fresh pass on top of [competitors-2026-11.md](competitors-2026-11.md) (2026-11-08). That note
covers the field's positioning; this one covers **what changed since**, **how each first run
works step by step**, and **what to build next**. Nothing below repeats the older note unless a
fact changed.

**Evidence marks.** **[V]** read on the vendor's own page, docs, changelog or repo during this
pass. **[C]** third-party (press, blogs, forums). **[U]** a user's own words (forum post, GitHub
issue, review). Nothing was installed or used hands-on; screen counts come from vendor docs, so
"time to first useful result" is an estimate from those steps, not a measurement. Several pages
were read through a summarising fetch; re-open the link before quoting.

---

## 0. What changed in the field since 2026-11-08's note

- **Meta Muse** (launched 2026-09-08) is a real consumer competitor, not a name clash: one
  personal agent per user on a Meta cloud VM, iOS / Android / web, free tier plus $20 / $100.
  Mac app control, an agent email address and a video avatar were announced 2026-09-23.
  [C: [Wikipedia](https://en.wikipedia.org/wiki/Muse_(AI_agent)),
  [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)]
  Meta also ships **Muse Code**, a CLI coding agent (beta 2026-08-05), which OpenBot already
  lists as a provider. [C: [Trending Topics](https://www.trendingtopics.eu/meta-launches-muse-code-to-rival-claude-code-and-openais-codex/); V: openbot.run]
- **OpenAI Dots** (DevDay, 2026-09-29): always-on agents in ChatGPT, each on its own cloud
  computer; one dot per Pro/Business user; a new $500 Pro tier.
  [C: [SiliconANGLE](https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/),
  [eesel](https://www.eesel.ai/blog/openai-dots)]
- **Claude Duet** (research preview, 2026-10-21): Anthropic's proactive agent app on iOS /
  Android / web, its own cloud computer, a morning brief, "waits for your ok when it matters";
  waitlist, US Pro/Max/Ultra, shares the plan's limits. Cowork also moved into every chat
  (2026-09-16). [V: [claude.com/product/claude-duet](https://claude.com/product/claude-duet),
  [release notes](https://support.claude.com/en/articles/12138966-release-notes)]
- **Grok Bot**: phone app control (Calendar, Reminders, Contacts, Location, Home; iMessage not
  included) from 2026-10-22; Android and iPad live; and a **usage-meter crisis on
  2026-11-01**, with meters jumping 32→67% overnight, routines failing with "no Grok Bot usage
  available", and Musk saying serving cost was "unsustainably high". Limits were then reset for
  everyone. [V: [docs.x.ai mobile](https://docs.x.ai/grok-bot/mobile); C: [iPhone in Canada](https://www.iphoneincanada.ca/2026/10/23/grok-bot-phone-apps-ios-android/),
  [TeslaNorth](https://teslanorth.com/2026/11/01/elon-musk-grok-bot-cost-usage-limits/);
  U: [Cursor forum thread](https://forum.cursor.com/t/grok-bot-weekly-usage-meter-flips-between-77-and-100-in-real-time/176909?page=4)]
- **OpenBot** ships almost daily (0.63 → 0.66 between 2026-11-06 and 11-09): pick the provider
  account per agent, Grok Bot and Hermes export import (up to 200,000 files), a new agent
  opening with its own welcome and three suggested first tasks, a Permissions page, read-aloud
  voices, a headless server / Docker / VPS install. 6.7k stars. [V: [changelog](https://openbot.run/changelog),
  [repo](https://github.com/nightly-labs/openbot)]
- **Reason Machines**: Reason 1.1 (2026-10-10), "Aspen" (2026-11-05), and a **plugin inside
  Grok Bot** (`@reason`) that continues on your other connected accounts when Grok Bot's limit
  hits. [V: [reasonmachines.com](https://reasonmachines.com), [/grokbot](https://reasonmachines.com/grokbot)]
- **Switching tools are now a category.** Hermes Agent has `hermes migrate grok-bot` (paste a
  prompt into each Bot, it writes JSON, import it) and `migrate openbot`; OpenBot imports Grok
  Bot exports; Claire Vo moved nine bots from OpenClaw to Grok Bot with an export script.
  [C: [AI Success Lab](https://aisuccesslabjuliangoldie.com/blog/migrate-grok-bot-to-hermes/),
  [Lenny's](https://lennysnewsletter.com/p/grok-bot-vs-openclaw-how-i-replaced)]

---

## 1. Product by product

### OpenBot (Nightly Labs) — closest in shape
- **Onboarding [V]:** download (Mac / Windows / Linux, also server, Docker, Nix) → explicit
  first-launch consent → connect a provider (reuses the CLI's existing login; can download the
  CLI for you) → describe the agent in one prompt → review sections, save → send work. **About 5
  screens**, plus the new per-agent welcome with 3 suggested tasks (0.66.0). Accounts optional
  (email code).
- **Creating an agent [V]:** prompt-driven on desk and phone, editable instructions, avatar,
  section review before save. Same idea as our "Describe the agent you want".
- **Approvals [V]:** agents run with `danger-full-access` and `approvalPolicy: never` after the
  first-launch consent; README calls full access "an explicit current product decision, not a
  security boundary". A "Workspace only" and an "Ask first" mode exist; approval is otherwise a
  workflow step. 0.64 added approval per remote-desktop session.
- **Phone [V]:** App Store and Google Play; QR pairing; WebRTC through their signalling server
  with a TURN relay fallback (Cloudflare holds accounts, not chats).
- **Multi-account [V]:** several provider accounts; pick one per agent (0.63); backup provider
  on limit or outage.
- **Pricing [V]:** free for personal use; PolyForm Noncommercial, so a paid licence for work
  (Starter 1 user, Team 2–10); OpenBot for Teams managed servers.
- **Design [C/U]:** dark, team-chat; users file polish bugs (iPhone bubbles with black text on
  colour, reversed bubble colours vs desktop; unread badge not clearing; a running workflow step
  with no Stop). [U: GitHub issues filed 2026-11-09]
- **What users ask for [U, GitHub issues 2026-11-09]:** review long approvals on the phone;
  read the provider's plan usage from an agent; parallel threads with one agent; separate
  browser profiles per agent; Apple apps on a paired iPhone; start a routine from an inbound
  email address; delete retired agents; turn memory saving off per agent; a bot's own voice.
  Bugs: agents vanishing from the list, voice replying twice, Composio confirmations
  auto-declined.

### Grok Bot (xAI / Cursor) — the UX benchmark
- **Onboarding [V, [get started](https://docs.x.ai/grok-bot/get-started)]:** download →
  Sign in (finishes in the browser; a plan check with eight paths to access) → short intro →
  the app **creates a Bot named "Grok Bot" and opens its chat** → starter prompts ("Morning
  briefing", "Travel coordinator") → ask to repeat it, and it becomes a routine. **About 3
  screens to a first chat**, gated by a paid plan. Phone: install, sign in, first-run tour, pick
  a first Bot, wait for the computer.
- **Creating an agent:** + / ⌘N, name it, Create; a lead Bot helps. Optional "teach" by
  recording your screen up to 10 minutes. Templates are "a recipe, not a clone"; a marketplace
  lists creators' bots (Import Bot, Alfred). [V: [x.ai guides](https://x.ai/bot/guides/getting-started); C: [zenaegis](https://zenaegis.com/grok-bot-review/)]
- **Approvals:** card with Allow once / Always allow / Deny, Auto Review model, plain-language
  rules (old note). Phone app access: per app Allow, "Grok Bot needs permission" card in chat. [V]
- **Phone [V]:** voice chat, dictation, voice memos, Live Activities, Action Button starts a
  voice chat, Siri Shortcuts (List Bots, Send Message, Start Dictation, Start Voice Chat),
  share sheet, watch and take over the cloud computer, routines with next run and history,
  per-Bot mute, search across messages/bots/files/routines, a per-Bot Library of pages and files.
- **Pricing [C]:** Premium $30, Super $100, Ultra $200 (X Subscription) or Cursor plans; trial
  credit for 7 days; no spend cap.
- **Praise [C/U]:** "relatively easy" creation, Bot-to-Bot handoff, great phone app, approval
  cards "the most flexible" of three tested. Claire Vo runs nine bots and "killed every
  OpenClaw I had". [C: zenaegis, Lenny's]
- **Complaints [C/U]:** claims work it didn't do ("said it checked" documents it hadn't);
  shared computer and logins across all Bots; usage opaque, then the 2026-11-01 meter jump with
  support quoting 3–4 days for human review; silent bots after resets
  ([forum](https://forum.cursor.com/t/grok-bot-reset-completed-all-bots-still-silent/172290));
  fragmented, clipped writing style.

### Meta Muse — the simplest consumer first run
- **Onboarding [C, [Clear Mud](https://www.clearmud.ai/blog/my-first-impressions-on-muse-ai-by-meta-does-it-earn-a-spot)]:**
  sign in with Meta → name your agent (it suggests a nickname) → chat. **3 moves.** A mascot
  walks you through; "no intimidating blank page". Settings (avatar, routines) are changed by
  asking, not by forms. Model-training data use is **on by default**. [C: neoteo]
- **Approvals [C]:** every send and purchase asks; **pending approvals in one feed** rather than
  per chat; checkout pauses for final OK. Read vs write per service ("Sentinel").
- **Phone:** iOS / Android / web first; Mac control announced. Avatar animates while it works.
- **Pricing [C]:** free; $20 (≈500M tokens/week) and $100 (≈3B).
- **Complaints [C]:** repeatedly nags to connect bank, email, passport details; can't turn
  memory off; simple tasks fail (logo, app build); Amazon blocked it (2026-09-21); shared chats
  discoverable via DNS, feature pulled (Oct). Animated avatar "overdone".

### Reason Machines — engineers, usage arbitrage
- Every CTA goes to /login; no stated onboarding, approvals, phone or prices. [V]
- New: a Grok Bot plugin, cloud machines per session, PRs only, **continues on your other
  accounts when Grok Bot's limit hits**, a session API. Calm white design (old note). [V]
- Read: it is selling "your usage runs out, we keep going". That is exactly our wallets story,
  and they are marketing it now.

### Claude Duet / Cowork / Dispatch (Anthropic)
- **Duet onboarding [V]:** waitlist; then "no prompts or setup", text or voice, one thread.
  Morning brief; a "Pulse" dashboard refreshed at 5:30 AM before the brief; drafts replies to
  approve; 6,000+ connectors; its own cloud computer; never sees passwords. Shares the plan's
  limits, and background checks count. Limitations stated: may misjudge urgency or miss things
  between check-ins.
- **Cowork in every chat (2026-09-16)**, memory across chat and cloud Cowork (2026-08-25). [V]
- Read: the model vendor now has a proactive agent on the phone with no setup. Our gap against
  it is setup; our edge is a team of named agents, Codex too, your Mac, and visible limits.

### OpenAI Dots
- **Setup [C, [eesel](https://www.eesel.ai/blog/openai-dots)]:** create from ChatGPT desktop or
  web only (not mobile); gradual rollout; connect apps once for ChatGPT, Work and Codex; local
  computer off by default.
- **Approvals [C]:** **Custom Rules per action with four outcomes: act without asking, act if
  pre-approved, ask first, hand off to you**; a fixed floor (passwords, money); approve a
  specific purchase in advance; Auto-review checks emails and file changes; **idle "proactive
  research" is read-only, enforced in code**; approving one message is not ongoing permission.
- **Phone:** you can call your dot; texting beta (US Pro). One dot per user at launch.
- **Complaints [C/U, HN via eesel]:** price; an agent used more GitHub token scope than meant;
  can't see or edit individual memories; unclear line between Dots, Codex and ChatGPT Work.

### Also in view
- **OpenAI Codex app**: merged into the ChatGPT desktop app (2026-07-09); the phone is a remote
  for a Mac running it, free tiers included. [C: [Engadget](https://www.engadget.com/2173235/openai-brings-its-codex-coding-app-to-mobile/), [Wikipedia](https://en.wikipedia.org/wiki/OpenAI_Codex_(AI_agent))]
- **Manus My Computer**: local folders only where approved; every terminal command asks, with
  per-action or always allow. No new release found since March. [C: [Impress Watch via search](https://forest.watch.impress.co.jp/docs/news/2093920.html)]
- **Lindy**: free plan dropped (Sept); credits burn "3–4x faster than estimated"; Trustpilot
  1.7 on billing. [C: [computertech](https://computertech.co/lindy-ai-review), [prospeo](https://prospeo.io/s/lindy-pricing-reviews-pros-and-cons)]
- **OpenClaw / Hermes Agent**: self-hosted, chat-app front doors; OpenClaw's skill marketplace
  had 341 malicious skills of 2,857 audited; both say the OS is the only boundary. Hermes's
  migrate commands are the switching path into it. [C: [Cisco](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare), [context.dev](https://www.context.dev/blog/openclaw-vs-hermes-agent)]

### First run, side by side (from docs; not timed)

| Product | Moves to a first message an agent acts on | Gate | First thing you see |
|---|---|---|---|
| Muse | 3 (sign in, name it, chat) | Meta account | Mascot, nickname, chat |
| Grok Bot | ~3 (download, sign in in browser, intro) | $30+/mo plan | A Bot already made, starter prompts |
| Claude Duet | ~2 after the waitlist | Pro/Max/Ultra, US, waitlist | One thread, morning brief |
| OpenBot | ~5 (download, consent, provider, describe, save) | Claude/Codex plan or free OpenCode | Your described agent, 3 suggested tasks |
| Dots | desktop only, rollout of days | $100+/mo | One dot |
| **Mogbot** | **6–8** (Welcome, Engine, install/sign-in screens, Accounts, Independence, Phone or skip, Ready) | Claude Code or Codex plan | Chief's stored greeting, 3 starters |

---

## 2. Where each beats us, where we beat them

| | They beat us | We beat them |
|---|---|---|
| **Grok Bot** | Store apps on 3 platforms + voice, Shortcuts, Live Activities; phone app control; first Bot made for you; templates and marketplace; runs with the laptop shut; Windows/Linux | Model choice (Claude Code / Codex per agent); limits shown honestly, across several accounts (their 11-01 meter crisis); a hard floor that never auto-approves; per-agent isolation (their Bots share one computer and logins); "It says it checked" / what wasn't verified (their #1 complaint is claimed-but-not-done) |
| **OpenBot** | Store apps; 3 desktop OSes + headless/Docker; Grok Bot / Hermes import from an export file; per-agent welcome with 3 tasks; daily releases; voice read-aloud; many providers | Safety (they run `danger-full-access`, no per-action asks); MIT-style open use vs PolyForm Noncommercial; no relay we run (they need their signalling/TURN); result cards, worktree per task, review flow; usage awareness |
| **Muse** | 3-move onboarding, nickname first; one approvals feed; settings by asking; free tier; avatar that shows work | Your machine and data (Muse trains on chats by default); a team, not one agent; memory you can read and edit (CLAUDE.md); best-in-class models |
| **Claude Duet** | Zero setup; first-party trust; morning brief + pre-built dashboard; 6,000 connectors; phone store app | Named team with delegation; Codex as well; several accounts and limits in view; your Mac, files and Chrome; no waitlist |
| **Dots** | Four-outcome rules per action; read-only idle research enforced in code; call your agent | Price (theirs $100–$500/mo); multiple agents now (they ship one); runs on your accounts |
| **Reason** | Cloud sessions in parallel; an API; marketing "keep going when the limit hits" | For everyone, not only engineers; phone; approvals; your own Mac |
| **Codex app / Manus / Lindy** | Store phone remote (Codex); Windows (Codex, Manus) | Team of agents, cards, usage honesty (Lindy/Manus credit surprises) |

---

## 3. The 15 most valuable things to build or change, ranked

Ranked by how much each makes Mogbot clearly the smoothest and most usable, per unit of effort,
against the evidence above. Size: **S** under a week, **M** 1–3 weeks, **L** over a month or
needs the owner. "Touches" names where it lands; confirm against code before building.

1. **Cut onboarding to three screens: Welcome → Engine → the Chief.**
   - *What:* if a signed-in Claude Code or Codex is found, Engine is one confirm. Accounts,
     Independence and Phone leave onboarding and become the Chief's first three cards in chat
     ("Want a second account so nothing stops?", the four-stop level picker, "Put me on your
     phone?"), each skippable by just typing. Name your Chief on the welcome screen (Muse's
     nickname-first).
   - *Why:* we take 6–8 moves; Muse takes 3, Grok ~3, Duet ~2. Our own
     [first-run-review.md](first-run-review.md) already flags "Fewer questions before the Chief"
     as an open product call.
   - *Who:* Muse, Grok Bot, Duet. *Size:* M. *Touches:* `src/lib/onboardingFlow.ts`,
     `components/setup/flow/`, `AccountsStep.tsx`, `SimpleSteps.tsx`, `agents::ensure_main` /
     `CHIEF_GREETING`, a new chat card set (`agents/policy_card.rs` pattern), phone parity.

2. **Phone from the store, paired in one scan.** (ROADMAP #1, still first among the hard ones.)
   - *Why:* every competitor in this note is on the App Store, and OpenBot, Grok, Muse and Duet
     are on Google Play too. Our guided Xcode build is the single biggest drop-off.
   - *Who:* all. *Size:* L (owner's Apple account). *Touches:* `mobile/`, `docs/app-store.md`,
     `companion/`, onboarding phone screens.

3. **Every agent opens with its own welcome and three tasks it can do right now, one of which
   finishes in under two minutes.**
   - *What:* on Create (and for the Chief), the agent writes a stored welcome tailored to its
     briefing plus three one-tap tasks chosen from what it can already reach (a connector, a
     folder, a CLI found by the access chain), not generic chips. The Chief's first suggestion
     is a morning brief built from what is reachable.
   - *Why:* OpenBot shipped exactly this on 2026-11-09; Grok opens with starter prompts and a
     ready Bot; Duet leads with the morning brief. Our starters are fixed chips and the new
     agent opens empty.
   - *Size:* S. *Touches:* `agents/draft.rs` (add `welcome` + `first_tasks` to the sealed draft),
     `agentsFirstWin.ts`, `chiefIdeas.ts`, mobile new-agent screen.

4. **Import from Grok Bot, OpenClaw, Hermes and OpenBot without Remote Access.**
   - *What:* two routes beside today's interview: drop an export file/folder (Grok Bot export,
     OpenClaw workspace, Hermes JSON, OpenBot `~/OpenBot/Agents`), or copy one prompt into each
     Bot that makes it write a JSON we read. Same sealed review card at the end.
   - *Why:* today importing needs Remote Access, Tailscale Funnel and a connector (three
     screens and a Tailscale permission). OpenBot and Hermes both import Grok Bot exports now,
     and Grok Bot's 2026-11-01 usage crisis is pushing people to switch this month.
   - *Who:* OpenBot (0.64–0.66), Hermes (`migrate grok-bot`). *Size:* M. *Touches:*
     `agents/review.rs`, `agents/interview.rs` (sealed parsing), `agents/other_app.rs` pattern,
     `ImportSteps.tsx`, the Ready screen's "Bring your agents".

5. **"Where did my usage go": attribute every change in the meter.**
   - *What:* each 10-minute usage reading is diffed and split across turns and routines that ran
     in that window ("+12% since 9 pm: Inbox triage ×3, 8%; not explained by any run here, 4%").
     A jump nobody here explains says so plainly (other apps on the account).
   - *Why:* Grok Bot's loudest complaint this month is a meter that jumped with "no recorded bot
     activity explaining the increase" and no way to verify charges. OpenBot users ask for an
     agent tool that reads plan usage. We already read limits; attribution makes it a
     trust feature nobody has.
   - *Size:* S–M. *Touches:* `agents/usage_read.rs`, `agents/usage.rs`, `agents/compute.rs`,
     Settings → Agents → Usage, phone usage view.

6. **Approve from the lock screen, and read the whole request first.**
   - *What:* actionable notifications (Allow / Deny on the notification for cards whose whole
     content fits; "Review" for the rest), and a full-screen card on the phone for long
     requests (diffs, email bodies, plan lists). One "Needs you" feed as the phone's first tab.
   - *Why:* Muse's single approvals feed is its most praised safety detail; Grok sends approval
     notifications; OpenBot users filed "review long approval requests on the phone" today.
     Approvals are our wall, so the phone has to make them fast.
   - *Size:* M (after #2 for real push). *Touches:* `mobile/` card views,
     `companion/` push, `agents/answer_gate.rs` (one answer per card still holds).

7. **One readable rule list per agent with four outcomes.**
   - *What:* "What <Agent> does without asking" shows Always-allow rules, rules said in chat and
     the level's defaults as plain sentences, each set to **Do it / Do it if I pre-approved /
     Ask me / Hand it to me**; editable on desk and phone and by asking the Chief. The floor
     shows as locked lines.
   - *Why:* Dots ships exactly these four outcomes with a fixed floor; Grok has plain-language
     rules. Ours exist (`permissions.rs`, `remember.rs`, levels) but in three places, so users
     can't see what they've granted.
   - *Size:* M. *Touches:* `agents/permissions.rs`, `agents/remember.rs`, `agents/autoallow.rs`,
     agent editor, mobile agent settings.

8. **This Mac's own apps as one-Allow tools: Calendar, Reminders, Contacts, Notes, Messages,
   Home.**
   - *What:* bridge tools over EventKit / Contacts / Shortcuts / Messages on the Mac, each
     switched on by one "Allow <Agent> to use Calendar" card. Sending a message always asks.
   - *Why:* Grok shipped phone-app control on 2026-10-22 and explicitly **cannot do iMessage**;
     OpenBot users are asking for Apple apps. We run on the Mac that already has all of them
     signed in, which is the access chain's second rung.
   - *Size:* M. *Touches:* new `agents/mac_apps.rs` behind the bridge, `request_login`-style
     card, `go_hard` floor (sending), docs/agents.md "Logins".

9. **Voice: talk to the Chief and hear it back.**
   - *What:* a live voice chat with any agent on the phone, voice-memo replies, an iPhone
     Action Button / Siri Shortcut "Tell <agent>…", and a Live Activity while a turn runs.
   - *Why:* Grok's phone docs list all four; Dots lets you call it; Duet takes voice; OpenBot
     added read-aloud voices (0.65). We have dictation only.
   - *Size:* M–L. *Touches:* `mobile/`, `companion/` (audio stays Mac-side or on-device).

10. **Watch and step in to an agent's browser from the phone.** (ROADMAP #3.)
    - *Why:* Grok's phone lets you watch the computer and take over for passwords, 2FA and
      CAPTCHAs; Muse shows its browser live. Ours says "Step in on your Mac", which strands a
      hard task when you're away.
    - *Size:* M–L. *Touches:* `agent_browser/`, `agents/takeover.rs`, `companion/` (screencast
      over the tailnet), `mobile/`.

11. **A morning brief that's ready before you wake, built from read-only checks.**
    - *What:* the Chief runs sealed read-only checks overnight (inbox, calendar, GitHub, usage),
      prepares a one-screen brief and posts it at the user's time, with one-tap actions that
      become cards. Idle research is read-only by construction (`watch_seal`).
    - *Why:* Duet's headline feature (Pulse refreshed at 5:30 before the brief); Dots' idle
      research is read-only in code; Grok's first starter is "Morning briefing". We have a
      starter and routines but no default, prepared brief.
    - *Size:* M. *Touches:* `agents/schedule.rs`, `agents/watch_seal.rs`, `agents/templates.rs`,
      `agents/notify.rs`, a brief card in `components/agents/`.

12. **Several threads with one agent.**
    - *What:* "New thread" beside Start fresh, sharing memory; the sidebar shows an agent's open
      threads; replies land in the thread that asked.
    - *Why:* Dispatch's most cited limit is one thread; OpenBot users filed "isolated threads
      for multiple conversations with the same bot" and "return replies to the topic that sent
      the request" today; Grok has threaded replies.
    - *Size:* M. *Touches:* `messages.jsonl` layout, `agents/runner.rs` (session per thread),
      `components/agents/` sidebar, mobile chat list.

13. **Share an agent as a recipe.**
    - *What:* export an agent's briefing, routines and apps-it-needs (never memory, secrets or
      rules) as a file or link; importing it lands on the same review card as Describe the
      agent you want.
    - *Why:* Grok templates ("a recipe, not a clone") and marketplace; OpenBot's marketplace
      catalog. For an open-source app, recipes are how users bring each other in.
    - *Size:* S–M. *Touches:* `agents/draft.rs` review path, `agents/review.rs`, ⌘K, mobile.

14. **Run on an always-on host: a spare Mac or a Linux box, paired from the phone.**
    - *Why:* every new entrant (Grok, Dots, Duet, Muse) runs with the laptop shut; OpenBot
      ships a headless server, Docker and a VPS guide (2026-10-30). MISSION says nothing may
      block a headless host, and the paid tier depends on it.
    - *Size:* L. *Touches:* a headless mode around `agents/runner.rs` and `agents/schedule.rs`,
      `companion/` pairing to a non-desk host, Keychain alternatives off macOS.

15. **Teach by showing.**
    - *What:* record yourself doing a task once (screen + narration, up to 10 minutes); the
      agent drafts a routine or skill from it for one review.
    - *Why:* Grok Bot's teach-by-demonstration is the lowest-effort way to hand over a task that
      has no API; it turns "how do I explain this?" into one recording.
    - *Size:* L. *Touches:* new capture on desk, a sealed draft call like `agents/draft.rs`,
      save-as-skill (ROADMAP "small wins").

**Not on the list, on purpose:** more providers (Gemini, Grok, Muse Code, local models; OpenBot
lists them, our line is the best two engines); multiplayer channels (outside the single-
professional mission until hosting exists); a marketplace of third-party skills (OpenClaw's 341
malicious skills is the cautionary tale); Windows and Linux desktop apps (real gap against
Grok, OpenBot, Codex, Manus, but #14 covers the always-on half and Windows is a separate bet).

**Copy to lean on now, from this month's evidence:** "See where your usage went" (Grok's
11-01 meter); "Each agent has its own browser and logins" (Grok's shared computer); "It tells
you what it didn't check" (Grok's claimed-but-not-done reviews); "Asks before anything you'd
regret" (OpenBot's `danger-full-access`).

---

## 4. What is and isn't verified here

- **Read on vendor pages:** openbot.run (home, changelog Nov 6–9), the nightly-labs/openbot
  README and live issue list (via `gh`), docs.x.ai Grok Bot get-started and mobile, x.ai guides
  hub, reasonmachines.com and /grokbot, claude.com Duet page, Claude release notes.
- **Third-party only:** everything on Muse (no Meta page read), Dots, Codex app, Manus, Lindy,
  OpenClaw/Hermes, Grok pricing and reviews, the 11-01 usage crisis beyond the forum posts.
- **Not checked:** any product hands-on, so screen counts are from docs and times are not
  measured; OpenBot's September–October changelog detail; Grok Bot's export format (what
  OpenBot and Hermes read). Whether our phone already has actionable notifications (#6) and
  what of #12 exists beyond Start fresh were not checked in code.
- **Source bias:** eesel.ai (Grok Bot and Dots reviews) sells a competing product; Clear Mud
  compares against its own preferences; several Lindy/Muse pages are affiliate content.
