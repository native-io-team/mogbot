# Roadmap

Ranked by impact on a knowledge worker × feasibility on our architecture.
Source: a Grok Bot / Replicas / T3 Code gap analysis (Nov 2026), updated by
the audits since, most recently a competitor scan on 2026-11-10. Read
[MISSION.md](MISSION.md) first. We never build our own infrastructure where a
good one exists.

## Next, ranked

1. **Phone in two taps, the rest.** The iPhone app is on a public TestFlight
   beta and Android is in internal testing; the App Store listing is planned
   for 19 November 2026 ([app-store.md](app-store.md)), then Google Play.
   Push through the relay in [push-relay.md](push-relay.md) is built, not
   deployed: until it is, alerts arrive only while the phone app is open.
   Every competitor in the 11-10 scan installs from a store.
2. **Phone: real-device verification.** The share extension, dictation's
   real recognizer, notification click-through, Lock Screen answers, the
   Live Activity, Siri and Shortcuts, Step in from the phone and Android
   hardware have only been tried in tests, the simulator or the web build
   ([mobile.md](mobile.md), "Not built"). Most of it waits on item 1.
3. **Recent features on live accounts.** Built and covered by the
   fake-engine suite, not yet run end to end on real engines or data: rewind
   and fork on a real Codex thread, living pages kept by a routine over days,
   `save_skill` judging real effort, Mail and Messages "When…" sources on a
   real Mail index and `chat.db`, OpenCode beyond its free Zen models
   ([agents.md](agents.md), each section's "Not verified").
4. **"Take over" a browser tab, the rest.** Step in at the desk and from
   the phone are built; neither has been run against a real SSO, passkey or
   CAPTCHA, and a passkey can't be answered from the phone. Codex take-over
   is unverified on a real thread.
5. **Watch claude.ai connectors.** Linear or Gmail set up as claude.ai
   connectors can't be watched by a "When…" check (the sealed call loads
   only apps configured in Claude Code itself), and connector checks are
   not yet verified on a live Linear or Gmail account
   ([agents.md](agents.md), "When… routines").
6. **The Watch.** Voice messages, Listen and Talk (a hands-free spoken
   conversation with an agent, [mobile.md](mobile.md)) exist on the phone;
   Talk is not yet tried on a real phone. An Apple Watch app (Muse and Grok
   have one; OpenBot doesn't, checked 12 Nov 2026) is easier once item 1 lands.
7. **More chat front doors.** Telegram, WhatsApp or Discord, once Slack has
   proved out.
8. **Results, the rest.** A PR straight from a non-copy result, and
   recordings.
9. **An always-on host.** Agents stop when the Mac sleeps. A Mac mini or a
   cloud Mac works today; anything more must not block the Mac-only path
   (MISSION).
10. **Calling a business for you.** Needs a telephony and speech provider on
    the user's own account; a spike only after the above.

Small wins: duplicate an agent; reply to a single message.

## Done

### 2026-11-11

- **The iPhone app on a public TestFlight beta** — the desk's phone setup
  offers it first (a code to scan, then "I already have the app"); building
  with Xcode is for development builds only.
- **Bringing agents over as a chat with the Chief** — under its greeting
  "Already have agents somewhere else?"; picking the assistant is the yes,
  and the Chief walks Remote Access one message at a time, each with one
  button (`agents/guide.rs`). Onboarding itself asks only for the engine.

### 2026-11-09 to 11-10

- **A living page per conversation** — one page pinned above the chat, desk
  and phone, that the agent and its routines keep current (`page`); every
  version kept with what changed; outside text changes it only through a card
  ([agents.md](agents.md), "A living page per conversation").
- **Rewind, fork and edit** — on your own message: Edit and resend, Fork from
  here, Rewind to here, desk and phone; nothing deleted, and the engine
  resumes at that point where it can (Claude Code forks its session, Codex
  its thread, else a recap) ([agents.md](agents.md), "Rewind, fork and edit").
- **Agents learn skills** — after a task the app saw take real effort, an
  agent can save how it did it (`save_skill`): per agent Automatically / Ask
  me / Off, a Save / Not now card, scrubbed, listed as "Skills" on desk and
  phone, carried in recipes ([agents.md](agents.md), "Skills").
- **"When an email or text arrives…"** — Mail and Messages on this Mac as free
  "When…" sources, read-only, needing Full Disk Access, each message passed in
  as outside text ([agents.md](agents.md), "When… routines").
- **"When…" routines from the phone** — set up and changed there, with the
  desk's composer words and rules.
- **Step in from the phone** — the agent's held browser tab shown and driven
  on the phone; Hand back from either device.
- **Blocks** — agents answer with charts, tables, tiles, choices and short
  forms (`show`), data only and checked on the Mac, drawn alike on desk and
  phone; the morning brief as blocks ([agents.md](agents.md), "Blocks").
- **Morning brief** — once a day the Chief posts what the team did, what
  waits and what runs today, composed from the app's own records with no
  model turn.
- **OpenCode as a third engine** — over ACP, every ask through the same
  broker, its own config unable to loosen a turn; in onboarding, the app and
  the phone ([agents.md](agents.md), "OpenCode").
- **Onboarding installs like a Mac installer** — plain steps read from the
  real installer's output, passwords and codes in their own fields, each
  failure with its one fix.
- **Menu bar, Dock menu and shortcuts** that follow where you are
  ([keyboard-shortcuts.md](keyboard-shortcuts.md)).
- **Notifications** — desk notifications and the Dock badge, the same
  alerts to a connected phone, an approval never held by burst caps or quiet
  hours; Settings → Notifications says what notifies where.
- **The app can't go quiet** — readers never wait on the registry's writer,
  phone requests bounded and answering "busy", a watchdog for the phone
  server and the bridge.
- **Security review 2026-11-10** — file calls through symlinks judged where
  they land, for every engine; forms in blocks refuse secrets and one-time
  codes.
- **Usage, one story** — one home (Settings → Accounts & usage), the total
  first, one word ("refill") for when a limit comes back, "Ideas for leftover
  usage" for the spare-capacity list, "Where it went"; wallets of several
  accounts per engine, and carrying on with the other engine when every
  account is out ([agents.md](agents.md), "Usage wallets", "Usage
  awareness").
- **Settings as a window** with a section list, each page reachable from ⌘K
  and from chat.
- **Projects show their agents** on each card and row; the workspace's
  terminal panel is "Session".
- **Agent keys** — every agent a keycap with a colourway, an icon and a
  keyboard key, desk and phone.
- **Several conversations per agent**, one memory; **rooms** of 2–6 agents;
  **recipes** to share an agent; **import from an export file** (Grok Bot,
  OpenBot, OpenClaw, Hermes) or a pasted reply; **this Mac's apps**
  (Calendar, Reminders, Contacts, Notes, Messages) with one Allow per app;
  optional agent groups in the sidebar.
- **Phone**: Catch up, voice messages, Listen, Siri and Shortcuts, a Live
  Activity (opt-in builds), Allow / Deny from the Lock Screen.
- **Workflows and the Inbox removed** — routines and "When…" routines do
  that job; Ship Studio's files are left untouched.

### Before

- **Step in to an agent's browser** — an agent that hits a wall only a
  person can pass in its own browser (SSO, "verify it's you", a passkey, a
  2FA code, a CAPTCHA) calls `ask_user_to_step_in` instead of failing or
  asking for a password; one card, **Step in** brings that tab's real
  Chrome window forward, and Hand back wakes the agent with where the page
  ended up ([agents.md](agents.md), "Step in"). Not yet run on a live engine
  or a real sign-in.
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
  Code, Codex or OpenCode, only when ready) and a model per engine, from only
  the models each engine lists; the New agent dialog, the Chief's
  `create_agent` and the phone's New agent start there, existing agents
  don't change ([agents.md](agents.md), "Defaults for new agents"). Not yet
  tried on a live Codex account's model list.
- **Rooms** — group conversations with 2–6 agents: @one, @everyone, or the
  room's lead; agents bring each other in with @Name, at most 8 agent turns
  per message; cards, timelines and results inline under the agent; on the
  phone too ([agents.md](agents.md), "Rooms").
- **A first run that lands one real win** — the Chief's starters summarise a
  picked document or research a question (staged, sent by the user);
  ready-made agents (Research assistant, Inbox triage, Weekly review) from the
  Chief, New agent, ⌘K and the phone ([agents.md](agents.md), "A first real
  result"). Not yet tried on live turns per template.
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
  before they change the team.
- **Import** — from Ship Studio on this Mac, and a sealed connector interview
  ending on one review card.
- **Nothing goes silent** — panics, stops, restarts and cut-off turns end in
  a line that says so, and delegators are told.
- **Security, first pass** — one strict sanitizer with images as links, a
  navigation guard and an open allowlist; the phone's Mac-proves-first
  pairing with a pinned identity in the Keychain, always confirmed on the
  desk, and DoS limits.
- **Coherence** — Line / Card / Bar, neutral affirmatives and one
  vocabulary, on desktop and phone.
- **Usage before the wall** — cost per agent and per routine this week, and
  the plan's usage ("Claude usage 85% · refills Thu", amber from 90%) only as
  the engine reports it, on desktop and phone. Codex's plan reading is
  unverified on a signed-in account ([agents.md](agents.md)).
- **"What it did" timeline under each reply** — folded summary, observed
  steps and outcomes, screenshots, live while working, on desktop and phone.
- **Start fresh, keep memory**, plus an honest context meter (only what the
  engine reports).
- **A phone that can start things** — new agents, a routine picker,
  dictation, "Send to agent…". The share extension and dictation's real
  recognizer are not yet verified on a device ([mobile.md](mobile.md), "Not built").
- **Light mode** — System / Light / Dark on desktop and phone, through
  semantic tokens, with a neutral focus ring.
- **Agents first** — launch and onboarding land on the Chief of Staff;
  onboarding asks only for an engine.
- **Codex as an engine**, per agent.
- **Own identity** — `brand.json`, this app's own state beside Ship
  Studio's, Ship Studio's endpoints off; monochrome with the Chief's colour
  as the accent, scoped per agent.
