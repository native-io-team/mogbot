# Competitors and adjacent products, November 2026

Research note, 2026-11-08. Read-only desk research; no product was installed or used.

**How to read the evidence marks**

- **[V]** read on the vendor's own page or docs during this research (still the vendor speaking, so it shows what they offer, not how well it works).
- **[C]** claimed: found only on third-party blogs, directories, SEO or affiliate pages, or marketing numbers we could not check.
- Pricing figures disagree across sources everywhere below. Treat every number as stale until read off the vendor's pricing page.
- Nothing here was tried hands-on. "Users praise" means what reviews and posts say, and the review base for most of these is thin (days to weeks of posts, some written by competitors).
- Several pages were summarised by a fetch tool, not read in full. Re-open the primary link before quoting.

---

## 1. The field, product by product

### Grok Bot (xAI / SpaceXAI), launched 2026-08-11 [C for date; docs V]
- **Positioning:** persistent, named agents ("Bots") with durable memory, files and browser sessions; "always-on AI teammates". [V docs]
- **Praised [C, thin]:** near-effortless setup, no workflow builder to draw; bots hand work to each other out of the box; clean, simple presentation (one Reddit user); voice notes and voice calls start work. Praise base is first-week posts only.
- **Onboarding:** download/sign in; iOS GitHub login was broken for at least one user. [C]
- **Accounts/usage:** paid only, no free tier or trial; weekly allowance, overage at raw token cost; no spend cap at launch; "always-on agents use a LOT of tokens". Lower-tier Cursor customers were locked out in launch week. [C, eesel.ai, who is a competitor]
- **Approvals/safety [V, docs.x.ai approvals page]:** consequential actions (sending, publishing, purchases, deletions, permission changes, production changes, accepting legal terms) show a card with the operation and inputs: **Allow once / Always allow (saves a rule) / Deny**. **Auto Review** (on by default) is a review model that checks each action before it runs. Custom Rules in plain language, "Allow automatically" or "Ask first", up to 20 each, 1,000 chars each, "Ask first" wins. Cards from chat wait indefinitely; from routines or inbound messages they expire after 30 min. Docs say plainly that bots are **not** a permission boundary: all of a user's bots share one cloud computer, files, browser sessions and CLI credentials. Local-computer access is per desktop: Ask every time / Always allow / Never allow.
- **Secrets:** Vault, then a connected password manager, then a Secure Form; secret values kept out of the model; per-payment approval option for saved cards. [V]
- **Takeover:** the user can take over the cloud computer for SSO, passkeys, CAPTCHAs, bank verification, then tell the bot to continue. [V]
- **Phone:** iPhone (iOS 18+) at launch; Android and iPad came later or were absent. Personal rules sync across desktop and phone. A third-party piece says it reached iPad in September. [V/C]
- **Reach:** desktop, mobile, Slack, X. Bots can have their own email address. [C; the overview page did not confirm it]
- **Pricing:** not on the docs pages we read. Bundled with xAI/SpaceXAI paid plans. [unverified]
- **Design:** chat-first, team-messenger metaphor; minimal controls. [C]
- **Critique worth keeping:** a third-party review says Auto Review does not cover every side effect and there is no org-level lock. [C, Arcade.dev, who sells a competing safety layer]

### Reason Machines, "Reason" (reasonmachines.com)
- **Positioning:** "the world's most effective agent"; "maximize your AI usage for minimal spend". A coding agent plus harness that produces pull requests. [V]
- **Features [V]:** Mac app where teammates and agents share one view, and Claude Code, Codex and Cursor run beside Reason; agents sidebar with progress per session; an API to start sessions from scripts/CI/your own product and poll or stream results; Slack (@Reason in a thread returns a PR, deck or answer).
- **Claimed [C]:** import a Claude Code, Codex, OpenCode or Devin session and continue it; switch to the next subscription when one hits its rate limit; Reason Agent 1.1 (Oct 2026) 65.1 on a "Coding Agent Index" vs Codex 62.5 and 22% lower cost per solved task. The homepage's own numbers (59.1 vs 58.2 Codex, 55.0 Pi, 50.0 Cognition) are vendor-reported. No independent benchmark, no Hacker News thread, no hands-on review found.
- **Pricing/approvals/phone:** none stated on the page. Trust center linked. No phone app mentioned.
- **Design:** calm, white, cool greys, near-black pills, name plus one truncated line per row (our own brand note says the same; see `brand-direction.md`).
- **Read:** a coding agent that borrows the "many harnesses in one app" shell. Closest on layout, furthest on audience: it is for engineers.

### OpenBot (Nightly Labs, openbot.run)
- **Positioning:** "one persistent workspace" for a team of AI agents on your computer; closest match to Mogbot's description. [V]
- **Features [V]:** each agent has a name, instructions and workspace; agents message each other, hand off tasks and share files; **Workflows** chain agents, models and approval steps; multiplayer channels with teammates; an agent can switch provider without losing workspace or conversation; built-in browser; iPhone and Android apps connect to your computer; queue of messages while an agent is busy.
- **Providers:** Codex and Claude Code via the user's plans; page also lists Gemini and Grok; directories add OpenCode, Cursor, Cline, Ollama/LM Studio. [V partial, rest C]
- **Onboarding:** download, connect a provider, describe the agent you want in one prompt, review the instructions, save, send work. [V] (This is our "Describe the agent you want".)
- **Usage/limits:** at a plan limit or provider outage an agent moves to a backup model on another provider, with a note in chat. [V]
- **Safety:** the page says agents can read and change files, run commands, use the network and control the browser "without asking each time", and advises trusted tasks and backups. Approval is only a workflow step type. Third-party guides recommend a spare machine or VM. [V/C] This is the clearest contrast with us.
- **Pricing:** free for personal use; a licence needed for commercial use (price not shown); a paid Teams offering with managed servers. [V]
- **Design:** dark, team-chat style, sticker-style avatars (our brand note). No independent review found.

### Claude (Anthropic): Cowork, Dispatch, scheduled tasks, Claude Code routines
- **Positioning:** desktop agent for knowledge work (Cowork) and for code (Claude Code), with a phone way in. [V support article for Dispatch]
- **Dispatch [V]:** message from the phone; the work happens on your desktop with local files, connectors and plugins; one persistent thread; routes code to Claude Code and knowledge work to Cowork; push notification when it needs your go-ahead. Needs the desktop app open and the Mac awake (a Keep Awake toggle exists [C]); Pro/Max/Ultra only; **one thread only, no multiple threads**; in limited beta and "isn't open to new users".
- **Scheduled tasks [C]:** arrived 2026-02-25; run only while the machine is awake and the app is open. Cloud "routines" run on Anthropic's infrastructure and do not need the Mac. [C]
- **Praised [C]:** the first-party feel, using the plan you already pay for, results waiting on both devices.
- **Pricing:** inside the Claude plan. **Safety:** per-capability permissions; the article itself warns Claude "can't be fully trusted by default". **Design:** not assessed.
- **Read:** the biggest overlap and the biggest threat, since it is the same idea from the model vendor. Its gaps are one thread, no named agents with memory, Claude only, beta access.

### ChatGPT agent, Scheduled Tasks, Codex, ChatGPT Work (OpenAI)
- **Verified-ish [C, help-centre snippets]:** Operator was folded into ChatGPT agent; **Scheduled Tasks** (announced 2026-06-17/18) replaced Pulse and lives in the sidebar on web and mobile; Codex arrived in the ChatGPT mobile app as a preview in May with a Remote tab to see desktop Codex tasks; "ChatGPT Work" (July, [C]) runs long deliverable jobs on Codex.
- **Praised [C]:** one scheduled-tasks hub, reminders and briefings that arrive on the phone without setup.
- **Limits/pricing:** by ChatGPT plan; details conflict by source. Tier lists (Go/Plus/Pro) are unresolved.
- **Read:** strong phone and scheduling, but a single assistant, not a team of named agents, and not on the user's own accounts.

### Manus (Meta deal status disputed) 
- **Positioning:** general-purpose autonomous agent; **My Computer** desktop app (macOS and Windows, mid-March 2026) lets it read/edit local files and launch apps through the terminal. [C: many outlets, consistent on the date]
- **Pricing [C, conflicting]:** credit-based; free daily credits; paid roughly $20 / $40 / $200 monthly (other sources say $39 and $199). Credits per task vary widely and are unpredictable (estimates of 50 to 1,000 per task are unverified).
- **Praised [C]:** most accessible general agent (one review 8/10). **Complaints [C]:** roughly 10% failure on complex tasks, crashes under load.
- **Ownership [C, conflicting]:** Meta announced a ~$2B deal in Dec 2025; later reports say it was blocked or unwound. Do not state ownership in any copy.

### Lindy
- **Positioning:** no-code AI employees for business workflows (email, calendar, CRM, calls). [C]
- **Approvals:** human-in-the-loop review before outputs go live is a feature. [C]
- **Pricing [C, conflicting]:** credit plans from about $30 to $200 per seat; overages opt-in at 2x; nothing rolls over; phone numbers and call minutes are extras. Trustpilot reportedly dominated by billing surprises (single source, 1.7/5; other sites show 4.8/5 from small samples).
- **Lesson:** credit billing that surprises people is the main complaint in this category.

### Relevance AI
- **Positioning:** "AI workforce" builder for business teams. Approvals, scheduling and version control are stated features. [C]
- **Pricing [C]:** the page may now show Enterprise only, "talk to sales"; older listings show a free tier and ~$50 Pro. Usage is Actions plus Vendor Credits; advice online is to plan for 5 to 10 times the first estimate.
- **Read:** an enterprise builder. Not a competitor for the individual professional, but it shows what buyers expect: approvals, versions, audit.

### Devin (Cognition) and Cursor background agents
- **Devin [C]:** entry plan about $20/month plus about $2.25 per ACU (roughly 15 minutes of active work); team pricing changed in 2026 and older figures are outdated. Delivers PRs from a cloud sandbox. Poke is reported (single source, unverified) to have been acquired by Cognition in July 2026.
- **Cursor background agents [C]:** isolated remote environments, up to 8 in parallel, started from Slack, Linear, GitHub or the editor; you can check in, send follow-ups and take over; usage-based on top of $20 / $60 / $200 plans.
- **No mobile story found for either.** Both are for engineers.

### Poke (The Interaction Company)
- **Positioning:** an assistant you text, over iMessage, SMS, WhatsApp, Telegram. Launched March 2026; reported as the first AI agent approved for Apple's Messages for Business on 2026-06-04. [C, several outlets]
- **Praised [C]:** proactivity, zero install, "as easy as sending a text". **Complaints [C]:** occasional bugs, integration lag, inconsistent pricing.
- **Pricing [C]:** freemium; upgrades negotiated in conversation; Apple reportedly charges a per-user fee.
- **Lesson:** entry through the app people already open all day.

### Conductor (Melty Labs), plus Skwad, vibespace, Agent Deck
- **Conductor [C, many blogs; vendor compare pages seen in search]:** Mac app; many Claude Code (and Codex) sessions, each in its own git worktree; per-workspace diff, checks and PR flow; "who is working, what needs attention"; free, uses your own subscription or API key. A cloud version and an iOS app are mentioned by some sources. Claims about Cursor/OpenCode support conflict across sources.
- **Skwad, vibespace, Agent Deck [C, small projects]:** terminals-in-a-grid with an MCP server so agents find each other; vibespace has a lead agent that assembles a team in containers.
- **Read:** strong at reviewing code from several agents, all for developers. Our "Review changes" must hold up against Conductor's diff-and-checks flow.

---

## 2. Patterns across the field

1. **The phone is table stakes and the install is easy for them.** Dispatch, ChatGPT, Grok and Poke arrive through an app store or a messaging app. Ours needs TestFlight or a guided build (ROADMAP #1, owner-blocked).
2. **Always-on without your computer is the second big divider.** Grok (cloud computer), Claude cloud routines, Cursor, Devin and Conductor Cloud run when the laptop is shut. Dispatch and our own app do not.
3. **Safety is split into two camps.** Grok built a model reviewer plus plain-language rules plus a card with Always allow. OpenBot says "no per-action prompts". We sit in a third place, deterministic levels with a hard floor, which is stricter than both and has no natural-language rule box.
4. **Usage surprises are the loudest complaint** (Grok no cap, Lindy credits, Manus credits, Relevance 5 to 10x). Nobody shows the user their own limits across several accounts the way we do.
5. **Failover across providers is becoming expected** (OpenBot verified, Reason claimed).
6. **Messaging-app entry** (Slack for Reason, Cursor, Grok; iMessage for Poke).

---

## 3. Ranked gap list for Mogbot

Ranked by how much each closes "extremely complex tasks, made extremely easy" per unit of the user's attention. Effort: S under a week, M one to three weeks, L over a month or needs the owner. "Land" paths are best guesses from `CLAUDE.md` and `docs/agents.md` headings plus a directory listing; confirm before building.

| # | Gap | Who has it | Why it matters | Effort | Where it lands |
|---|---|---|---|---|---|
| 1 | **Phone installs in two taps** (store build + push). | Claude, ChatGPT, Grok, Poke [V/C] | The phone is how people supervise hard work away from the desk. If it takes a build, most people never get there. Already ROADMAP #1. | L (owner's Apple account) | `mobile/`, `docs/app-store.md`, push via `src-tauri/src/companion/` |
| 2 | **Keep working when the Mac is shut / headless host.** | Grok cloud computer [V], Claude cloud routines [C], Cursor, Devin | Long jobs and routines stop at the lid. Sleep handling exists (docs "When the Mac sleeps…") but it is a mitigation. MISSION already says "nothing should block a future headless host". | L | new host mode around `agents/runner.rs`, `agents/schedule.rs`; paid hosted tier per MISSION |
| 3 | **Plain-language rules plus a model reviewer for the grey zone** (Auto Review; "Allow automatically" / "Ask first" rules, with Ask-first winning). | Grok [V] | Our levels are fixed lists. A user can't say "always let it reply to my sister, never touch anything in Legal" without a chat to `remember_permission`. A visible, editable rule list makes the safety model legible and fast. Keep the floor non-overridable. | M | `agents/autoallow.rs`, `agents/remember.rs`, `agents/policy_card.rs`, rule list in Settings → Agents; phone parity |
| 4 | **"Always allow" on the card itself, with the saved rule shown.** (Check first whether our card already offers it; not verified here.) | Grok [V] | Fewer repeat asks is the cheapest attention win. Must stay neutral (answers are never accent) and obey `go_hard::floor`. | S | `components/agents/AgentCard.tsx`, `agents/remember.rs` |
| 5 | **Take over the agent's browser for SSO, passkeys, CAPTCHAs, bank checks, then hand back.** | Grok [V] | Logins are the usual place hard tasks die. ROADMAP #3 already lists this. | M | `agent_browser/`, `agents/takeover.rs`, `agents/browser.rs`; phone view |
| 6 | **Messaging entry: start and answer agents from Slack, iMessage or Telegram.** | Reason, Cursor, Grok (Slack) [V/C]; Poke (iMessage etc.) [C] | Work comes up in a thread, not in our app. Our Remote Access MCP serves other assistants, but there is no chat-app front door for humans or teammates. | M (Slack) to L (iMessage needs Apple approval) | new module beside `src-tauri/src/remote_access/`; inbound text must be treated as outside text (`agents/watch_seal.rs` rules) |
| 7 | **Cross-engine failover when an account is exhausted** (Claude to Codex and back, with a line saying so). | OpenBot [V], Reason [C] | Our wallets are same-engine accounts and still in progress (ROADMAP #5). A turn that stops at a limit is a hard task made hard. Needs a rule for what carries over (memory file, not the engine session). | M | `agents/wallet.rs`, `agents/engine.rs`, `agents/runner.rs`; "Nothing goes silent" copy |
| 8 | **Import an existing Claude Code or Codex session into an agent.** | Reason [C] | People arrive with work in flight in terminals. We import from Ship Studio and other assistants, not from engine sessions. | M | `agents/import.rs`, `agents/other_app.rs`; read session files read-only |
| 9 | **Proactive morning brief / "what's worth your attention" without being asked.** | Poke [C], ChatGPT Scheduled Tasks [C] | Turns a team into something that works while you do not, with one tap to act. We have routines but not a default, opinionated brief. | S to M | `agents/templates.rs` (ready-made agent), `agents/schedule.rs`, `agents/notify.rs` |
| 10 | **One place for every routine across all agents, with next/last run and pause.** (Check "What's in flight" and Settings; may already be close.) | ChatGPT Scheduled tab [C] | Scale of trust: users can't hand over more until they can see all of it at once. | S | `components/agents/`, `agents/schedule.rs`; palette entry |
| 11 | **Start work from scripts and CI: a small documented HTTP API or CLI.** | Reason API [V] | Lets a power user wire agents into their own tools. Our Remote Access is MCP, not a plain API. | M | `src-tauri/src/remote_access/`, `companion/`; keep the PIN and audit rules |
| 12 | **Code review that matches Conductor: diff, checks and PR in one card for a project copy.** | Conductor [C] | Our "Review changes" and "Open a pull request" exist; the gap is polish (checks status, per-file diff, one-click PR). Matters for the "reviewable, not a claim" bar in MISSION. | M | `agents/task.rs`, `agents/results.rs`, `agents/preview_test.rs`, `components/branches/` |
| 13 | **Voice: voice notes and a live call that starts work.** | Grok [C] | Dictation exists on the phone; a voice reply or call is a lower-attention way to brief a team. | M | `mobile/`, `companion/` |
| 14 | **A hard spend or usage cap per agent or routine that stops runs.** | none do it well; Grok has none [C] | Not a competitor feature but the category's loudest pain. We show usage; a stop line would be a trust win. | S to M | `agents/usage.rs`, `agents/quota.rs`, `agents/usage_plan.rs` |
| 15 | **Teammates sharing agents (multiplayer).** | OpenBot channels [V], Grok shared bots [V] | Real demand but outside the single-professional mission and it would weaken the "your accounts, your Mac" story. Rank low until the hosted tier exists. | L | `agents/rooms.rs`, `companion/` |

Deliberately not on the list: more providers (Gemini, Grok, local models). OpenBot lists them, but our line is "the best agents there are" on Claude Code and Codex. Revisit only if one of them clearly passes on quality.

### Top five to start with
1. Phone in two taps (#1), because every other advantage needs the phone to be reachable.
2. Rules and an always-allow card (#3, #4), cheapest way to cut asks without loosening the floor.
3. Take over the browser (#5), removes the most common stall.
4. Cross-engine failover (#7), makes the usage story complete.
5. Messaging entry, Slack first (#6), meets work where it starts.

(#2 matters as much as any of these but is a product decision about the hosted tier.)

---

## 4. Five things we do that nobody else shows (lean into these in copy)

"Nobody else" is judged from public pages and reviews. Absence of a mention is not proof; soften in copy to "most" if challenged.

1. **A ladder of independence with a floor that never moves.** Careful / Steady / Bold / Unleashed, each defined by an explicit list, with money, credentials, deleting for good, production pushes and system persistence always asking, and a one-time "yes for the whole plan" that covers exactly the listed actions. Grok has a reviewer model and rules; OpenBot has none. Line: "Pick how much they do on their own. Money and passwords always ask."
2. **Your own accounts, several at once, with the limits in view.** Usage is read every 10 minutes across accounts, shown as room now and soonest reset, with labelled estimates, and a mode that spends expiring capacity before reset. No competitor shows this; the rest bill credits or hide limits. Line: "See what you have left before you hit the wall."
3. **Results that say what wasn't checked.** A result card lists files and links, before/after, "It says it checked", and what was not verified, and asking for changes makes a version two. Others report "done". Line: "Ask for a fix. Get it back checked."
4. **Logins without passwords, and agents that try every route first.** Connection, then this Mac's sign-in, then your Chrome through our own extension (a socket, not a port, every send asks), then an API key; secrets only through a masked card into the Keychain. Competitors offer a vault (Grok) but not this chain, and OpenBot offers none. Line: "They find a way in. You only get asked when they can't."
5. **Nothing leaves your machine except through you: phone paired to your Mac over your own Tailscale.** The Mac proves its pinned identity before the phone sends a secret; no relay we run. Claude's Dispatch and Grok's phone apps go through the vendor's cloud. Line: "Your phone talks to your Mac. Not to us."

Honorable mentions: "Nothing goes silent" (every stopped or cut-off turn ends in a line saying so); both Claude Code and Codex per agent; agents that are told to ignore Ship Studio's tools so two apps coexist.

---

## 5. What is and isn't verified in this note

- **Read on vendor pages:** reasonmachines.com home; openbot.run home; docs.x.ai Grok Bot approvals page and overview; Anthropic's Dispatch support article (via fetch summaries).
- **Everything else is third-party** (blogs, directories, search snippets), including all pricing, all benchmark figures, Manus ownership, Poke/Cognition, Lindy ratings, Conductor feature lists, ChatGPT tier availability.
- **Not checked at all:** actual quality of any competitor's agents, onboarding by use, real phone behaviour, anything behind a login, the contents of our own code beyond directory names and docs headings (the "where it lands" column is a guess, and gaps #4 and #10 may be partly closed already).
- **Source-bias flags:** eesel.ai (competitor) wrote the most-cited Grok Bot review; Arcade.dev sells a competing safety layer; many Lindy, Relevance and Manus pages are affiliate content.
