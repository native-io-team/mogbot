# Mogbot Development Guidelines

> **Setting this up for a user?** Follow [docs/INSTALL.md](docs/INSTALL.md) step by step: every
> step has a command, a check and what to tell the human. Don't improvise the setup.

> **Start with [docs/MISSION.md](docs/MISSION.md), then [docs/ROADMAP.md](docs/ROADMAP.md).**
> **North star: extremely complex tasks, made extremely easy.** Agents do whatever it takes:
> they find access wherever it exists (connected app / Claude connector → CLIs and files on the
> Mac → the built-in agent browser → the user's Chrome via Claude in Chrome → search, scripts,
> other agents) and ask the user only when every route is exhausted, or before spending, sending
> or publishing as them, pushing, deleting their data, or touching credentials. When they go
> somewhere it is clear where and as whom. Every setting is changeable from chat. Judge every
> change by: does this make a hard task easier, with less of the user's attention?
> Mogbot is the app's name (it lives only in `brand.json`; see "Brand and identity"). It is
> the evolution of Ship Studio: an open-source app for running your own team of AI agents, on
> desktop and phone. Grok Bot's experience, on Claude Code and Codex on your own machine, with
> Ship Studio's project workspace underneath. Not a coding tool. Much of the codebase (and the
> patterns below) is inherited from Ship Studio and still carries its name in identifiers.

## Feature Overview

**Agents come first.** The app opens on Agents, and onboarding ends in a conversation with the
Chief of Staff (see "Agents Flow", [docs/agents.md](docs/agents.md)):

- **Chief of Staff** - Exists from first launch and speaks first (a stored greeting, no model turn). It creates, briefs, delegates to, keeps track of and deletes the other agents; you can talk only to it
- **Named agents** - Persistent, each with its own colour, instructions, memory it maintains, routines and check-ins, apps, and optionally a bound project. Each runs on **Claude Code or Codex** (chosen per agent) on this Mac, on the user's own accounts
- **Describe the agent you want** - New agent (desk and phone) and the Chief draft a whole agent from one prompt (`agents/draft.rs`, a sealed no-tools call): name, briefing, routines read by the app's own grammar, apps it will need; one review, then Create
- **Approvals** - Anything consequential (spending, sending, changing what others see) arrives as an Allow / Deny card; secrets go into a masked card and the Keychain, never the chat
- **Logins** - An agent that needs an account raises one login card (`request_login`): Connect (its own OAuth, token in this Mac's Keychain; or a claude.ai connector; or `gh`), else Use my browser (Claude in Chrome, every send asks), else an API key; never a password. Givable entirely from the phone (a provider's sign-in sheet whose code is relayed to the Mac, GitHub's device code, claude.ai there), the token always in the Mac's Keychain; per-agent grants, "What it can reach" on each agent, and "What your team needs" groups every ask by service (see docs/agents.md, "Logins")
- **Result cards** - A finished piece of work comes back as one card (`share_result`): files and links, before/after, "It says it checked" and what wasn't verified, in the agent's own words. **Ask for changes** makes a new version
- **A copy per task** - A project-bound agent works in its own git worktree, never the user's folder; its card offers Keep changes / Review changes / Preview / Discard
- **Take over** - Step into an agent's own engine session in a terminal and drive it by hand, then Hand back
- **"What it did"** - A folded timeline under each reply: observed steps and honest outcomes in plain labels, screenshots, live while the turn runs
- **Several conversations, one memory** - Each agent has a list of conversations (the chat header's switcher, desk and phone; search, rename, New conversation), each its own engine session and chat, all sharing its memory; one turn at a time per agent, each in its own conversation (`agents/conversations.rs`). Plus a context meter showing only what the engine reported
- **Usage before the wall** - Cost per agent and per routine this week (tokens, not list-price dollars, on Pro/Max), and the plan's usage only when the engine reports it
- **Usage awareness** - Every account's limits are read without a turn every 10 minutes (`agents/usage_read.rs`) and shown as total compute across accounts (room now, soonest reset, a labelled run-out estimate; `agents/compute.rs`); agents read them, other compute on this Mac, and *labelled* estimates from past runs (`usage_overview`, `forecast_usage`); the user picks Normal, Save my limits or Use it all before reset, which spends expiring capacity on a spare-capacity list. The sidebar's usage row (one line and the stack of accounts as a segmented meter) opens the Usage view: each account a key in order (drag to reorder), a nudge to use capacity about to reset, a second sign-in of the same account counted once (`inventory::same_as`), and "Where did my usage go" from this Mac's own turn records, saying so when nothing here explains a rise (`agents/usage_story.rs`; see docs/agents.md, "Usage awareness", "Usage wallets")
- **Routines** - On a schedule (one picker on desk and phone), or **"When…"** something happens: GitHub mentions/assignments, new files in a folder, or a connector check that runs sealed (read-only tools, no shell or files), with caps and an approval before it changes the team. A time routine can run **in steps** (`agents/routine_steps.rs`): a step marked "your OK first" waits on an "OK to go on?" card showing what the step before made; Go ahead is a yes exactly as wide as that card
- **Nothing goes silent** - A panicked, stopped or cut-off turn always ends in a line saying so, and delegators are told
- **Slack** - Start an agent from a Slack message (`mogbot:` …) and get the answer in the thread, polled from this Mac with the user's own Slack app's token (Keychain); only the user's own messages are instructions, anyone else's is sealed outside text, and every reply waits on a "Reply in Slack?" card with the exact words unless Unleashed + the user's own message + no outside text + exact-text off (`agents/slack.rs`; docs/agents.md, "Slack")
- **Phone** - The companion app (`mobile/`, [docs/mobile.md](docs/mobile.md)) is the primary way in away from the desk: chats, approvals, result cards, the timeline, and starting things (new agents, routines, dictation, Send to agent). It pairs by QR and talks to this Mac over the user's own Tailscale
- **Import** - From Ship Studio on this Mac (a preview, then a copy), or from Grok Bot or any other assistant over Remote Access: a sealed interview that ends on one review card in the Chief's chat; or, with no Remote Access, an export file or folder (Grok Bot, OpenBot, OpenClaw, Hermes) or a reply pasted back, parsed by plain code and ending on the same review card (`agents/import_export.rs`)
- **Settings** - A window of its own (`dashboard/SettingsModal.tsx`, a window-sized `ModalFrame`): a section list down the left (Agents, Independence, Accounts & usage, Phone, Notifications, Chrome, Apps, then Projects, Appearance, Advanced; `lib/settingsPages.ts`), one page at a time, each reachable from ⌘K ("Settings → Phone"), from a chat note's button and from the Chief (`open_settings`); Esc goes back. **Independence** is one idea with one name and one control, the four-stop slider, everywhere
- **One look** - Every non-message surface is a Line, a Card or a Bar; affirmative answers are neutral, never accent; one word per idea (see [docs/agents.md](docs/agents.md), "Lines, cards and bars"), on desk and phone

**Projects underneath.** When work becomes a site or an app it lives in the workspace inherited from Ship Studio, which agents create, run sessions in and push from (with approval):

- **Project Management** - Templates (web + mobile starters), GitHub import, external local folders, dashboard folders
- **Agent terminals** - Claude Code, Codex or Opencode in multi-tab, side-by-side panes; terminal sessions stay hot when switching projects
- **Flexible Panels** - Every panel can be docked anywhere in the rail, floated, or moved across the preview; remembered per project (see `docs/flexible-panels.md`)
- **Live Preview** - Responsive breakpoints, zoom, fullscreen, locale switcher, and the breakpoint canvas showing every breakpoint at once (see `docs/breakpoint-canvas.md`)
- **Visual Editing** - Point-and-click edit mode with a pinnable editor panel and an element tree
- **Mobile App Preview** - Build and mirror Expo / React Native / Flutter apps on the iOS simulator
- **Git** - Branches, PRs with generated titles/descriptions, visual merge-conflict resolution, snapshots (rewind)
- **Hosting Status** - Whether *the pushed commit* deployed on Vercel, Cloudflare Pages or Netlify, with the build error when it didn't (see "Hosting Flow")
- **Site Migration** - Rebuild a live URL here, measured page by page against the original (see `docs/site-migration.md`)
- **Workflows & Inbox** - Scheduled read-only agent runs that file findings (see `docs/workflows-inbox.md`)
- **Assets, Skills & MCP, IDE integration** - As in Ship Studio (the plugin system was removed; a Ship Studio project's `.shipstudio/plugins/` folder is left on disk and ignored)

**Across both:** the Cmd+K palette (every feature registers there), light and dark themes on desktop and phone, multi-window, and **Remote Access** — driving your agents from another MCP-capable assistant (Grok, Claude, ChatGPT…) over your own Tailscale Funnel (see "Remote Access Flow"). For the phone, the answer is the companion app; Remote Access answers a different question. Updates, telemetry, issue reporting and the template catalogue are off until `brand.json` names an endpoint for them.

**Compatible with Ship Studio, both directions:** the `~/ShipStudio` projects folder and the in-project `.shipstudio/` format are shared, so either app opens the other's projects; app state is this app's own, so both run side by side.

## Core Principles

### Never Assume Data
- **Only display data that is reliably known** - never construct, guess, or infer values
- If data isn't available, either:
  1. Don't show that field at all
  2. Show a clear "unknown" or neutral state
  3. Redesign the UI to not need that data
- Example: Don't construct URLs like `https://{project-name}.vercel.app` - only show URLs that were explicitly returned from an API or saved from a real operation
- This prevents confusing users with incorrect information

### Data Storage
- Project metadata is stored in `.shipstudio/project.json` within each project
- This file stores: last_opened timestamp, and the project's hosting link (provider, project id, scope)
- Schema v4 replaced the old `publish` block (staging/production URL + state + timestamp). It carried
  no commit SHA, provider or deployment id, so it could not say *which* push it described — and it was
  written from assumption rather than from a provider's answer. Deployment state is not cached in the
  repo at all now; it is fetched per commit into a short-lived in-memory cache
- Provider links are read from the CLIs' own files (`.vercel/project.json`, `.netlify/state.json`) or
  set explicitly by the user; a link is never inferred from a folder merely existing
- Only trust data that was explicitly saved - don't infer state from file existence alone

### Brand and identity (`brand.json`)
- The app's name, slug, bundle id, URL schemes, app-support folder name and every external link
  live only in the repo-root `brand.json`. Frontend: `src/lib/brand.ts`. Rust: `src-tauri/build.rs`
  generates `src-tauri/src/brand.rs`'s constants (`brand::NAME`, `brand::app_support_dir()`,
  `brand::logs_dir()`, `brand::keychain_prefix()`, `brand::scoped()`, `brand::links::*`). Never
  hardcode the name; never make it prominent in the UI
- Every link is nullable. Null turns the feature off and the UI hides it (issue reporting,
  template gallery, community CTAs, updates, version rewind, phone install, PR footer,
  telemetry). Telemetry keys/DSN are compile-time: null means nothing is sent
- **Renaming** (`previous` in `brand.json`: the name, slug, identifier and appDirName before the
  last rename; Mogbot was Dashbot). On first launch under the new name
  `brand_migration::run_at_startup` (first thing in `lib.rs`, before logging) moves the old
  app-support, log, `~/.<slug>` and webview folders and the reopen-at-login item, leaves links at
  the old app-support and `~/.<slug>` paths, rewrites old absolute paths in `agents/*.json` and
  agents' `CLAUDE.md`, and writes a marker; never while the old app runs, never over a non-empty
  new folder. Keychain items are carried on first read (`keychain`, "Carrying secrets over a
  rename"); the old Funnel mount, Chrome host manifest, bundled-skill copies, preview MCP name and
  Slack trigger are each handled where they live. Rename by changing `brand.json` and moving the
  old values into `previous`; never hardcode an old name
- **Ours** (derived from the brand, so this app and Ship Studio run side by side): app-support dir
  (app state, pins, agents, companion build, remote access, bridge token), logs, keychain
  prefixes, `~/.<slug>/` account homes, deep-link + pairing schemes, companion tailnet port,
  Funnel mount path, the preview MCP server name, bundled skill folder names, the reopen-at-login
  LaunchAgent label (`<identifier>.reopen-at-login`), the phone self-build ids
  (`<companion.bundleId>.<hex>` / `.self`), temp names
- **Shared compat** (deliberately unchanged, so the two apps open each other's projects):
  `~/ShipStudio`, in-project `.shipstudio/`, `.shipstudio-team/` + the `shipstudio-team`
  branch, the commit-guidance marker, the `Made-With` trailer *key* (its value names only the
  agent, never the app). Ship Studio's plugins are not loaded here: its in-project
  `.shipstudio/plugins/` folders are ignored, never read or deleted
- **Shared state files** in `~/ShipStudio/.shipstudio/`, read and written by both apps:
  - `folders.json`, `external-projects.json`, `attached-libraries.json` — one dashboard
    organisation, whichever app you open
  - `workflows-state.json` — run history, inbox, and the `last_run_at` both schedulers decide from.
    Giving each app its own copy made every armed workflow run twice, and Mogbot's first launch
    fire every daily workflow Ship Studio had already run. Mogbot additionally takes a per-slot
    claim (`workflow-claims/`, atomic create, stale after 30 min) before a scheduled run; Ship
    Studio doesn't, so a slot it is mid-way through can still be started here before it records
    the run (`commands/workflows/slot_claim.rs`)
  - **Read-modify-write risk:** each app serialises its own writes with an in-process lock only.
    Two apps writing the same file at the same moment can drop one write (a folder move, a run's
    findings). Writes are atomic renames, so the file is never corrupt, just occasionally stale.
    Don't add a new shared file without accepting that, or adding a cross-process lock
- **Read-only from Ship Studio:** with no projects folder set here, the Default workspace starts
  at the folder Ship Studio's Default workspace uses (read from its `app_state.json`, never
  written; `utils::ship_studio_projects_root`). Agents → Import → "From Ship Studio" copies its
  agents in (`agents/other_app.rs`, `OTHER_APP_NAME` is the one place the UI gets its name):
  read-only on its side, secrets never copied, routines arrive paused (see docs/agents.md)
- **Each other's agents:** both apps' preview MCP servers are registered in shared agent configs.
  Agents we spawn are told to ignore Ship Studio's (`preview_isolation.rs`: Claude
  `--disallowedTools=mcp__shipstudio-preview`; Codex `-c mcp_servers.shipstudio-preview.enabled=false`
  only when it's configured). Its registration is never removed. Bundled skills: when Ship
  Studio's `shipstudio-<name>` copy is installed, ours isn't
- Files that can't import brand.json carry checked copies: `pnpm check:brand` (CI) verifies
  tauri.conf.json / Cargo.toml / package.json identity (and that `plugins.updater` exists exactly
  when `links.updates` is set), the phone build's `COMPANION_BUNDLE_ID` handoff, and regenerates
  `packages/companion-protocol/src/brand.gen.ts` and `index.html` with `--write`

## Security model

The short version; each line links where the detail and the threat model live. Don't weaken any of
these without updating that doc.

- **Logins never carry a password.** Tokens only in the Keychain (`<slug>-connection-<id>`), reaching a turn through its 0600 config file or its environment, never argv, a log or the phone; the phone may run a provider's sign-in sheet but gets only the URL and a one-time code, relayed once to the Mac that holds the PKCE verifier (`agents/login_relay.rs`); read grants refuse writes and full grants ask for every write ([docs/agents.md](docs/agents.md), "Logins", "Threat model additions")
- **Approvals are the wall.** An admin agent can answer only another agent's *local* requests (`admin::classify`, tested), never its own, never in a turn answering outside text. Agents run in `acceptEdits`; everything else goes through the
  approval broker (`agents/broker.rs`), which trusts only a live turn's `?turn=` id and stops a turn
  that reports `bypassPermissions` ([docs/agents.md](docs/agents.md), "Approvals"). Every card
  answer, from any device or path, first takes the card's claim (`agents/answer_gate.rs`): exactly
  one answer acts, the rest get "Already answered: <winner>" ("One answer per card"). The only
  cards answered for the user are ones their independence level covers (a four-stop slider shown as
  Careful, Steady, Bold, Unleashed; stored as `often`, `judgement`, `go_hard`, `full_send`, which
  never change; `mcp::decide`, for
  Claude Code and Codex alike; each agent's own level, else the team's, `policy::chosen_level`;
  raising one from chat is a card, lowering applies with a line; outside text stays capped;
  the Chief offers a change once a day per agent when the user sounds fed up, `agents/level_hint.rs`): reads at "Steady" (`agents/autoallow.rs`, an
  allow-list), and at "Bold" everything except a short ask list (`agents/go_hard.rs`): pushing,
  `gh` writes, publishing, production deploys, sending mail/messages, live payments, network writes
  off this Mac, `sudo`, `rm -r` outside projects/agent homes/temp, credentials, shell profiles,
  launch agents and system tools; in the browser, the final send click, uploads and scripts that
  submit or post. At "Unleashed" (`go_hard::full_send_program`, never for outside text) sending and
  posting what the user asked for runs too, and only money, credentials, deleting for good, pushing
  to production or a protected branch, and system persistence ask. A turn answering outside text at "Bold" also asks for any network write and for
  packages fetched by name. Each
  auto-answer leaves a line in "What it did" ("How much agents do on their own"). One Allow on
  an `ask_plan` card (or the user's typed yes to a plan just listed) covers exactly the listed
  actions, by kind and target, for an hour, for that agent and those it delegates to; never
  the floor (money, credentials, `sudo`, deletes, force pushes, system persistence) or outside
  text (`agents/plan_grant.rs`; docs/agents.md, "One yes for the whole plan"). Secrets go
  into the Keychain through a masked card, never the chat ("Secrets"). "You can always do those" in chat becomes a rule only through `remember_permission` (`agents/remember.rs`): a live turn whose latest input the user typed in that chat, the scope of a card it showed, and never Bold's floor (`go_hard::floor`) ("Said in chat")
- **"Bold" hardening.** No request goes through on its own with a secret in its address, query
  or headers (`agents/egress.rs`). After a turn reads outside content (web pages and search
  results, issue/PR comments, mail and chat through connections, other sites in the browser),
  network writes to another host and packages new to the project ask for the rest of that
  conversation, since what it read stays in the engine's context on the next turn
  (`agents/exposure.rs`, `agents/installs.rs`; a new package is remembered once allowed). Network
  reads, `gh` reads, local work and scripts (renders, headless Chrome on `file://`), builds,
  project installs, dev servers and here-document scripts carry on without a card
  (`go_hard_hardening_tests.rs`)
- **Your Chrome through our own extension** (`user_chrome/`, off by default): a Unix socket, never a port; the native host is the app's own binary and only our extension id starts it; app and host prove a per-launch token to each other; the extension relays only the page logic's CDP methods and expressions, in tabs the agent opened; `browser_gate` decides every call as for Claude in Chrome, any engine ([docs/internal/own-browser-layer.md](docs/internal/own-browser-layer.md))
- **Agents never hold an app's token.** A connection made on a login card is reached through the
  bridge's relay (`agents/conn_relay.rs`), which adds the Keychain token and enforces the grant
  for every engine ([docs/agents.md](docs/agents.md), "Grants, read vs send, and turns")
- **Just try, then one ask.** `request_login` runs the access chain first (a connection, this
  Mac's sign-in, the user's browser), dedupes asks team-wide and allows one at a time; imports ask
  for nothing up front ([docs/agents.md](docs/agents.md), "Just try first", "Checking what your
  team can already reach")
- **The browser is the user.** Claude in Chrome only after the guided setup verified it, per
  agent, never for outside-text turns; reads on the agent's own sites are free, anything else asks
  ([docs/agents.md](docs/agents.md), "Your browser")
- **Outside text is sealed.** Connector imports and "When…" checks run in a sealed headless call
  (no shell, no files, no web; read-only app tools only), and a turn answering outside text can't
  write its own memory or change the team without a card ([docs/agents.md](docs/agents.md),
  "When… routines"; [docs/remote-access.md](docs/remote-access.md), "Importing agents as a
  conversation")
- **The webview never loads untrusted content.** One strict sanitizer for agent and Inbox HTML,
  images shown as link chips, a navigation guard, preview text reaching an agent only through a
  confirmed chip, an open allowlist for agent files (see "What stands in for a CSP" below)
- **The phone pairs to *your* Mac.** The Mac proves its pinned Ed25519 identity (Keychain) before
  the phone sends any secret; every pairing is confirmed on the desk; tokens are stored hashed;
  per-device and per-source limits bound what a stranger can cost
  ([docs/mobile.md](docs/mobile.md), "Pairing", "Auth, revocation and audit")
- **Remote Access** is a separate server from the agent bridge (which is loopback only): masked
  token copied from Rust, text only to agent tabs, push behind a PIN the assistant never sees,
  everything audited ([docs/remote-access.md](docs/remote-access.md), "Security")
- **Hardening on foundation:** per-turn bridge secrets never on argv (`agents/reach.rs`), agent
  writes to `.git` / `.shipstudio` denied, consent before installing or running a project's own
  scripts (fingerprinted; installs use `--ignore-scripts` until approved), Keychain items copied to
  app-owned `#v2` entries and verified before a legacy one is removed

## Architecture

### Backend (Rust/Tauri)
- Commands are organized in `src-tauri/src/commands/` by domain (git, vercel, github, etc.)
- Command registration is in `src-tauri/src/lib.rs`
- Commands validate paths to ensure they're within `~/ShipStudio` directory
- Git operations use the `git` CLI with TTL-based caching (`src-tauri/src/cache.rs`)
- Vercel operations use the `vercel` CLI
- Structured logging via `tracing` crate, logs stored at `~/Library/Logs/<appDirName>/` (from `brand.json`)

#### Command Modules
Command modules in `src-tauri/src/commands/`. Domains with submodules are directories:
- `git/` - Git operations (branches, status, stash, sync) with TTL caching
- `health/` - Project health checks (dependency audit, diagnostics)
- `hosting/` - Native hosting status: per-provider adapters (Vercel, Cloudflare Pages, Netlify) over one provider-agnostic model, plus credential discovery, commit lookup and build logs
- `ide/` - VS Code/Cursor launch, preview screenshots
- `projects/` - Project CRUD: detection, metadata, dev-server config, pins, sessions, templates, UI state, window registry
- `pty/` - Pseudo-terminal spawn/stream for the embedded agent terminals
- `workflows/` - Workflows & Inbox: workflow markdown files, headless runs, filed findings, and the bundled agent skill (see `docs/workflows-inbox.md`)
- `setup/` - First-run onboarding: install, auth, status checks, mock/force modes
- `skills/` - Agent skill search and install

Single-file domains:
- `agent_bridge.rs` - Commands for the agent preview bridge (the loopback MCP server in `src-tauri/src/agent_bridge.rs` that lets the workspace agent read the preview's console/network/DOM, navigate it, and take screenshots)
- `agents.rs` - Agents mode commands (overview, messages, send, create/update/delete, approvals, focus). The engine is `src-tauri/src/agents/`
- `agents_usage.rs` - Settings → Accounts & usage: the capacity inventory, the usage mode and the spare-capacity list
- `ai.rs` - AI-powered PR title/description generation via the agent CLI
- `analytics.rs` - PostHog event tracking (API key stays in Rust; see `docs/analytics.md`)
- `assets.rs` - Assets panel file management (configurable root, default `/public`)
- `attached_libraries.rs` - Shared libraries registry (per-workspace local folders surfaced to agent sessions via the agent's additional-dir flag, e.g. Claude Code `--add-dir`)
- `claude.rs` - Claude Code binary detection and version checking
- `companion.rs` - The Phone panel's commands (on/off, pairing code + QR, Allow/Deny, revoke). The mobile companion server itself is `src-tauri/src/companion/` (see `docs/mobile.md`)
- `code.rs` - Code mode (in-app file browsing/editing)
- `conflicts.rs` - Merge conflict detection, parsing, and resolution
- `edit.rs` - Visual editor backend (mutations, committing edits back to source)
- `env.rs` - Environment variable management
- `external_projects.rs` - Registry for projects outside `~/ShipStudio`
- `folders.rs` - Dashboard project folders
- `github.rs` - GitHub CLI integration (auth status, push, remote management)
- `i18n.rs` - Multilingual config management (Next.js Pages i18n, Astro i18n, next-intl routing.ts) via conservative string surgery — fails with Validation errors instead of guessing
- `mcp.rs` - MCP server configuration for agents
- `migration.rs` - Site migration: scaffolds a project to have a live URL rebuilt into it, writes the measuring tools into `.shipstudio/fidelity/`, and reads back the agent's status and its comparisons (see "Site Migration Flow")
- `mobile.rs` - Native mobile app preview (Expo / React Native / Flutter): simulator boot, build, launch, mirror
- `monorepo.rs` - Workspace detection for pnpm/yarn/npm monorepos
- `proxy.rs` - Preview proxy control (the proxy itself lives in `src-tauri/src/proxy/`)
- `pty_session.rs` - Long-lived backend-owned PTY sessions (e.g. mobile builds)
- `publishing.rs` - Pushing the current branch to origin, and the git-push error taxonomy
- `pull_requests.rs` - PR listing and creation via `gh` CLI
- `remote_access.rs` - The Remote access modal's commands (status, enable, projects, push PIN, copy link from Rust, audit). The server itself is `src-tauri/src/remote_access/`
- `settings.rs` - App-level settings persistence
- `snapshots.rs` - Project snapshots / backups (rewind)
- `static_server.rs` - Static file server for plain HTML projects
- `support.rs` - In-app support requests
- `templates.rs` - Project template export/extraction
- `window.rs` - Window management helpers

### AI Features
- PR title/description generation using Claude CLI (`src-tauri/src/commands/ai.rs`)
- Frontend wrapper in `src/lib/ai.ts`
- Uses `find_claude_binary()` to locate Claude Code installation
- Gathers git diff, commit messages, branch name, and diff stats as context
- Implements 40KB max diff limit with intelligent truncation at newline boundaries
- Prompts Claude to respond in structured format (`TITLE:` / `DESCRIPTION:`)

### Frontend (React/TypeScript)
- Components are in `src/components/`
- Lib functions (Tauri invoke wrappers) are in `src/lib/`
- Main app state is managed in `src/App.tsx`
- Polling uses exponential backoff (`src/lib/polling.ts`)
- Structured logging via `src/lib/logger.ts`

#### Components Structure
`src/components/` is organized by domain — new components go in the matching folder:
- `dashboard/` - Home screen: project list/grid/cards, folders, create/import flows, settings, changelog
- `workspace/` - Workspace shell: WorkspaceView, header/sidebar, modals wrapper, the panel rail (`WorkspaceDock`, `WorkspaceLayoutMenu`), compact mode, assets panel
- `terminal/` - Agent/build terminals, dev-server logs/status, dev command modal
- `preview/` - Live preview, browser tools, device mirror (mobile), locale switcher, screenshots
- `branches/` - Git/branch UI: branches/PR tabs, conflict resolution, diff, publish controls, GitHub button
- `code/` - Code mode: viewer, file tree, code tab, health panel
- `hosting/` - The Push popover's Hosting section: the fixed-geometry row, the address rows, the connect and link-picker flows, and the Deployments panel
- `extensions/` - Agent extensions: the Skills and MCP modals and their shared layout parts
- `workflows/` - Workflows list, row, editor, template picker, run history
- `inbox/` - Findings list and the report reader
- `agents/` - Agents mode: the full-window chat (sidebar, conversation, approval cards, avatar, create/edit and import dialogs)
- `migration/` - Site migration: the URL tab in New Project, the phase rail, the four-part status, the fidelity matrix and the comparison viewer
- `remote/` - Remote access: the modal (five-step setup, then the live view) and the sidebar indicator
- `shopify/` - Shopify theme setup and store modal
- `primitives/`, `icons/`, `setup/`, `edit/`, `support/`, `CommandPalette/`, `import-project/` - pre-existing groups
- Root holds only cross-cutting files: ErrorBoundary, UpdateBanner, EducationOverlay, ConnectOverlay, AppGlobalModals, HelpModal

Shared icons are imported from `@/components/icons`, never from an internal icon module or a raw
SVG asset. Static inline SVG is prohibited in feature components; use the shared icon modules or
`src/assets/graphics/` for feature artwork. The marked dynamic exceptions, `BranchGraph.tsx` and
`AgentAvatar.tsx` (drawn from the avatar spec shared with the phone), are the only inline SVG. See [Icons and SVG graphics](docs/design-system.md#icons-and-svg-graphics).

When a request adds an icon to a feature, always follow
[Importing a new icon](docs/design-system.md#importing-a-new-icon): process files from the temporary
`src/assets/icons/import/` inbox, convert UI artwork colours to `currentColor` without changing
transparency, move the finished asset to its owned location, register a semantic `createIcon`
export in the correct category, consume it through `@/components/icons`, and validate it.

#### Frontend Libraries
Key modules in `src/lib/` (not exhaustive — `ls src/lib` for the full list):
- `agents-management.ts` / `agent.ts` - Agent CLI detection, install state, default-agent selection
- `agents.ts` / `agentsStore.ts` - Agents: types mirroring `src-tauri/src/agents/`, invoke wrappers, chat grouping, and the event-driven store
- `agentBridge.ts` - Frontend half of the agent preview bridge: executes forwarded MCP tool calls against the inspect store / preview and registers the server with the agent CLI
- `ai.ts` - AI generation wrapper for PR descriptions
- `analytics.ts` - PostHog event wrapper (every event documented in `docs/analytics.md`)
- `assets.ts` - Asset management (list, upload, delete; configurable assets root)
- `attached-libraries.ts` - Shared libraries (list/add/remove, scoped to the active workspace; `attachedLibraryDirs` feeds the terminal's `--add-dir` wiring)
- `backups.ts` / `snapshots.ts` - Snapshot create/restore (rewind)
- `branches.ts` - Branch operations and PR status management
- `claude.ts` - Claude Code detection and availability checking
- `conflicts.ts` - Conflict resolution operations
- `edit.ts` / `editControls.ts` / `inspectStore.ts` - Visual editor state and iframe protocol
- `errors.ts` - TypeScript mirror of `CommandError` + `asCommandError`/`formatCommandError` helpers
- `external-projects.ts` / `folders.ts` / `pins.ts` - Dashboard organization (external repos, folders, pinned rail)
- `fonts.ts` - Font loading utilities for the terminal
- `git.ts` - Git operations wrapper (status, commits, branches)
- `github.ts` - GitHub operations (auth, push, clone) and publishing flow
- `hosting.ts` / `hostingCopy.ts` - Hosting: the TS mirror of the Rust model, the invoke wrappers, the `deriveSectionState` reducer, and every user-facing string in the section (written to fit a 184px column — see the Hosting Flow)
- `i18n.ts` - Multilingual support: status/config wrappers, full-ISO language search, locale path helpers for the preview switcher, and agent prompt builders (translate, App Router next-intl setup, removal cleanup)
- `logger.ts` - Structured frontend logging
- `mcp.ts` / `skills.ts` - Agent extensions (MCP servers and skills)
- `migration.ts` - Site migration: the phase/status model the panel renders, the fidelity types mirroring the capture script's report, and the prompts handed to the agent at creation and on resume
- `remoteAccess.ts` - Remote access: TS mirror of the status, the stay-on checklist, setup steps, live state and audit wording
- `mobile.ts` / `androidMirror.ts` - Mobile app preview and device mirror
- `workspaceLayout.ts` / `workspaceLayoutStore.ts` / `dockDrag.ts` - Flexible panels: the layout model and its pure moves, the per-project + default persistence, and the pointer-to-drop-target maths — see `docs/flexible-panels.md`
- `previewCanvas.ts` - Breakpoint-canvas geometry and zoom maths (layout, fit scale, device heights, mount window, pointer anchoring) — see `docs/breakpoint-canvas.md`
- `polling.ts` - Exponential backoff utilities for async operations
- `project.ts` - Project metadata and file operations
- `workflows.ts` / `workflowsStore.ts` / `workflowHandoff.ts` / `workflowTemplates.ts` - Workflows & Inbox: types mirroring the Rust shapes, the store over the Tauri commands, the queue that carries a finding's prompt into a workspace terminal, and the template library the new-workflow picker is built from
- `projectSessions.ts` / `sessionRegistry.ts` / `ptySession.ts` - Hot project sessions (backend authority + frontend mirror)
- `setup.ts` - Setup wizard step definitions and integration status
- `terminalLinks.ts` - Clickable URLs in terminals (web-links addon)
- `updater.ts` - Auto-update functionality and version checking

## Testing

### Looking at the UI (do this before guessing)

You can see this app. `pnpm harness` boots the **real** frontend in a browser
against a fixture backend, and `scripts/harness-capture.mjs` screenshots any
state — no Tauri build, no particular machine state, no third-party accounts.

```bash
pnpm harness &                          # 127.0.0.1:1425
pnpm harness:capture                    # ~70 PNGs + harness/shots/report.md
```

Use it whenever the question is "what does this look like", "did my change
render", or "what happens with an empty/failed/expired state" — those are
answerable directly instead of by reading components and inferring.

Two sources of coverage:

- **Scenarios** (`src/harness/scenarios/`) — states that are slow to reach for
  real: empty account, fresh machine, 24 projects, failed deploy, expired
  token, merge conflicts. Each says what to check.
- **Palette sweep** (`--commands`) — every command in the Cmd+K registry, one
  page load each. Because every feature must register there (see "New feature →
  contribute commands"), new features get coverage automatically.

**The rule:** a Tauri command with no fixture is never given a plausible
default — it is recorded, badged, and fails the run. A screenshot from a
scenario with unmocked commands is *incomplete* and is not evidence. Add the
fixture, copying the shape from the `invoke<...>` type at the real call site
including its casing.

It cannot tell you anything about Rust, and it runs in Chrome rather than
WKWebView. Full guide: [docs/ui-harness.md](docs/ui-harness.md).

**Several harnesses at once** (other worktrees, other agents): never assume
1425 is yours. Give each its own port *and* its own `TMPDIR` (the capture
script's Chrome profile lives there), the same in both shells:

```bash
export SHIPSTUDIO_HARNESS_PORT=1437 TMPDIR=$(mktemp -d)
pnpm harness &
node scripts/harness-capture.mjs <scenario>
```

### Phone screens without a simulator

`cd mobile && pnpm qa:web` renders the companion app with react-native-web
against the mock Mac and captures a fixed list of phone screens, light and dark,
at 402×874 @3x into `mobile/qa-shots/` with a `report.md` (console errors and
text cut off, per shot). It pairs through the real confirm screen and reaches
offline, "This isn't your Mac" and the bar fold by restarting the mock. Ports:
`--web-port 8098 --mock-port 47498 --cdp-port 9681`; `--only <prefix>`,
`--themes dark`, `--out <dir>`. The web stand-ins for native modules are swapped
in on the web platform only. Tab-bar position, safe areas, Material icons and
grey images are web artifacts: see docs/mobile.md, "Phone screens without a
simulator", for the full list.

### Frontend Tests (Vitest + React Testing Library)
```bash
pnpm test:run     # Run all tests once
pnpm test         # Watch mode
pnpm test:ui      # Run with Vitest UI
```

Tests are in `src/**/*.test.{ts,tsx}`. Uses official `@tauri-apps/api/mocks` for mocking Tauri IPC.

### Backend Tests (Rust)
```bash
cd src-tauri && cargo test
```

**In a worktree** (`.claude/worktrees/<name>`), build against the shared target dir so each
worktree doesn't compile the crate from scratch: set `CARGO_TARGET_DIR` to the main checkout's
`.claude/cargo-shared` (absolute path) for every cargo and `pnpm tauri` command.

Unit tests are colocated in source files using `#[cfg(test)]` modules.

### Onboarding / Setup Testing

Onboarding is critical — it's the first thing every new user sees, and it ends in a conversation with the Chief of Staff.

**What it asks for: one engine Agents can run on** (Claude Code or Codex), installed and signed in. Nothing else. `OnboardingRouter` → `AgentOnboardingScreen` (`src/components/setup/agent-led/`):

One straight line of one-question screens (`lib/onboardingFlow.ts`, `components/setup/flow/`): a progress bar, Back, one big button, one sentence each. The step is saved (`shipstudio.onboarding.flow`), and a launch with an unfinished onboarding reopens it (`postSetupViewFor`).

1. **Welcome** — one line on what this is.
2. **Engine** — Claude Code or Codex (only engines `agents::engine` can run are offered), then each install / sign-in its own screen (Codex first gets the package manager and Node.js); each starts on its own and ticks from the app's checks. Once it passes, the app lands on the Chief's greeting (`CHIEF_GREETING`, written by `agents::ensure_main`; no model turn runs until the user replies).

Two clicks from launch to the Chief (Get started, an engine card) when nothing needs installing. Everything else is asked at its moment, in the app, each skippable (`lib/onboardingFlow.ts` lists them): bringing agents from another assistant is one card under the Chief's greeting (`ImportChoiceCard`; the answer is the Mac's, `agents::import_choice`, so the phone stops asking too); the phone is a card in the Chief's chat once the first thing asked for is back (`ChiefPhoneOffer`, which opens the Phone panel) and "Get the phone app" at the sidebar's foot; another account is offered on the usage-limit line the moment one runs out; independence keeps its default (asks before anything risky), the Chief offers a change when the user sounds fed up (`agents/level_hint.rs`), and Settings → Agents has the slider. A launch saved on one of the screens older builds had (accounts, independence, phone, ready, import) counts as finished.

Keyboard: whenever nothing has focus, the screen's big button (or the recommended engine card) takes it, so Enter always goes on (`FLOW_FOCUS_TARGET`).

Every check says **Done** when it passes (and moves on by itself if it passed on that screen) or **Not done yet** with the one fix; a window closed before it finished (a cancelled install or sign-in) says so too. Never a silent screen.

The app verifies; nothing self-certifies: an engine counts when `get_full_setup_status` says it is installed and signed in. Backend `allReady` means exactly that (`has_agents_engine` in `commands/setup/status.rs`), and the background check after launch only logs — it never sends a user back to onboarding.

**Project tools are asked for in context.** Only Node and Git (plus Homebrew/winget to install them) are *required*, and only when work becomes a project. The GitHub CLI and sign-in are offered alongside as optional, with "Continue without" (remembered). Creating or importing one goes through `useGatedProjectStarts` (`src/lib/projectTools.ts`); a passing check is cached for the session, and the clicked button shows a spinner while the first one runs. If anything is missing, the Project tools dialog (`ProjectToolsModal`) lists it in plain words and runs the guided phase: the user's own agent installs the tools in a terminal (`buildGuidedSetupPrompt`) while the checklist ticks green from the app's own checks, then the project flow carries on. The same rule holds in Rust: the agent and Remote Access `create_project` tools check Node/Git first (`missing_project_tools`), answer the Chief with "ask the user to set up project tools", and emit `project-tools-needed`, which opens the dialog. Hosting stays in a project's Push popover.

Someone whose only agent CLI is one Agents can't run (Opencode, Cursor, "Other") counts as set up (`brought_own_agent`), rather than being looped through onboarding: `postSetupViewFor` lands them on their projects, and Agents shows a "no engine" panel offering Claude Code or Codex.

The classic step-by-step wizard and its "Try classic onboarding" toggle were removed: it gated the app on developer tools onboarding no longer asks for.

#### Looking at it

- `pnpm harness` scenarios: every screen and failure state is an `onboarding-*` scenario (`src/harness/scenarios/onboardingFlow.ts`; `onboarding-fresh` is the welcome, `onboarding-engine-connected` the last screen, `onboarding-end-to-agents` the engine → Agents, `onboarding-status-failed` a check that couldn't run), `agents-first-run-import-choice` and `agents-first-result-phone-offer` (the questions that left onboarding), `launch-returning` (launch lands on Agents), `project-tools` and `project-tools-running`.
- `SHIPSTUDIO_FORCE_SETUP=fresh pnpm tauri dev` — mock backend; install/connect buttons flip mock state after a visible beat, and the Project tools dialog plays the scripted `DemoAgentTerminal`. Nothing touches the host machine. Also `auth-only` (engines installed, none signed in). Note that `both-agents`, `codex-only` and `almost-done` have a ready engine, so mock `allReady` is true and launch **skips onboarding entirely** (straight to Agents); use them to look at the post-setup app, not the hand-off.
- `SHIPSTUDIO_FORCE_ONBOARDING=1 pnpm tauri dev` — real checks, onboarding forced open, the pick phase always shown even on a set-up machine; `mark_setup_complete` is in-memory only.

#### Testing on a Fresh Machine (Real End-to-End)

The gold standard: no env vars, a machine with nothing installed. `scripts/onboarding-vm.sh` wraps it with [Tart](https://github.com/cirruslabs/tart) (setup in the script header; use the `macos-sequoia-vanilla` image — *base* ships with Homebrew and ruins the test):

```bash
./scripts/onboarding-vm.sh fresh   # build DMG if needed, boot a pristine VM with it mounted
./scripts/onboarding-vm.sh reset   # throw the used VM away; next fresh starts clean
```

VM login is admin/admin; the DMG appears under "My Shared Files → dmg". Locally-built DMGs aren't notarized — right-click → Open.

**Checklist:**

- [ ] Claude Code card: installs via terminal, sign-in completes, hand-off screen names it
- [ ] Codex card on a bare machine: package manager and Node.js install first, then Codex, then sign-in
- [ ] Signed in, it lands on Agents with the Chief's greeting, starters and the one import card; the Chief runs on the engine chosen
- [ ] After the first reply to something you asked, the phone card appears once; Set up my phone pairs (each phone step ticks Done by itself; HTTPS certificates off says Not done yet with the admin page)
- [ ] Quit mid-way (e.g. on the sign-in) and relaunch: it reopens on that screen
- [ ] Re-launch lands on Agents, not onboarding (setup_complete persisted)
- [ ] New project: the Project tools dialog lists what's missing, the agent installs it, the checklist turns green, the new-project flow opens
- [ ] A project window (opened from a project) still goes straight to the workspace

Key files: `src/components/setup/agent-led/AgentOnboardingScreen.tsx`, `src/components/setup/ProjectToolsModal.tsx`, `src/lib/agentOnboarding.ts`, `src/lib/projectTools.ts`, `src-tauri/src/commands/setup/` (checks, mock/force modes).

## Common Patterns

### Publishing Flow
1. User clicks Push in `PublishBranchDropdown`
2. `publish_branch` commits any pending changes and pushes the **current** branch to origin
3. Whatever the project's host does next is the host's business — we push, we don't deploy

That last point is the change: publishing used to push `HEAD:staging` or `HEAD:main` and then
record `{ url, state, publishedAt }` into `.shipstudio/project.json`. The state was assumed rather
than observed (a literal `"QUEUED"`), the URL was empty or assembled from the project name, and
nothing invalidated it. Deployment truth is now *asked for*, per commit, by the Hosting Flow below.

### Hosting Flow

Answers one question: **did the commit I just pushed actually deploy?**

1. `get_hosting_status` resolves the pushed commit (`origin/<branch>`), reads the project's link
   (`.vercel/project.json`, `.netlify/state.json`, or one the user picked), and asks that provider
   for a deployment **matching that SHA** — never "the most recent deployment", which answers a
   different question and is what the old plugin did
2. Credentials come from the keychain first, then the provider CLI's own login file. A rejected
   token (401 **or** 403) is `Auth::Rejected` and renders as a broken connection — never as healthy,
   and never as data
3. `deriveSectionState` (`src/lib/hosting.ts`) folds auth, link, transport and timing into exactly
   one state. Order encodes the honesty rules: nothing pushed beats everything; auth problems beat
   data; a missing deployment is only ever "not found", never "failed"
4. The row prints the provider's own status word (`status_label`) verbatim — "Ready", "Uploading",
   "Pending review" — so this and the provider's dashboard never disagree. We own the sentence
   around those words, not the words
5. Copy is written to fit: the row's two upper lines get a 184px ellipsised column with no tooltip,
   so anything longer than ~32 characters belongs on the third line, which wraps. A unit test holds
   every string to that budget and the UI harness reports anything that still overflows
6. A failure fetches its own build log and shows the error line, which is the thing people open the
   dashboard for

Verified against live accounts for all three providers, with what is observed versus assumed
recorded in [docs/internal/hosting-provider-matrix.md](docs/internal/hosting-provider-matrix.md).

### Pull Request Flow
1. User clicks "Submit for Review" on a branch
2. SubmitReviewModal opens; the merge target defaults to the project's configured default base branch (falling back to main/master)
3. On submit the modal runs the whole flow itself: commits pending changes (a failed commit aborts with a humanized error — never a PR that silently lacks the user's latest work), generates the title/description via the agent CLI when available (branch-name title as fallback), then creates the PR
4. Backend gathers git context (diff, commits, branch name) and calls Claude CLI for the summary
5. PR is created via `gh pr create`; git/GitHub failures surface through `humanizeGitError` (src/lib/errors.ts) with the branch names filled in

### Workflows Flow

1. A workflow is a markdown file at `<project>/.shipstudio/workflows/<slug>.md` — frontmatter plus an instruction body. The form in `WorkflowEditorModal` and the user's own agent (via the bundled `<slug>-workflows` skill) write the *same* artifact; there is no API in front of it
2. Running one shells out to the user's agent CLI headless in the project dir. Read-only is enforced by the CLI (`--permission-mode plan` / `--sandbox read-only`), not merely requested — never weaken this without changing the UI copy that claims it
3. Findings come back as the last fenced ```json block in the reply, are deduped by fingerprint, and are filed to `~/ShipStudio/.shipstudio/workflows-state.json` — shared with Ship Studio (see "Brand and identity"), **never** into the project repo
4. Scheduling is one tokio tick (`workflow_scheduler.rs`), at most one run per tick, never catching up on a backlog. Nothing fires while the app is closed and every UI string says so
5. In the Inbox, "Fix in \<project\>" queues the suggested prompt (`lib/workflowHandoff.ts`), opens the workspace, and `useWorkflowHandoff` types it once a terminal exists

Full design: [docs/workflows-inbox.md](docs/workflows-inbox.md).

### Site Migration Flow

Answers one question the old `webflow-to-code` plugin never asked: **does the
rebuild still look like the site?**

1. New Project → **From a URL**. One input, whatever the site was built with.
   `init_migration` scaffolds `.shipstudio/`: the opening status, and the two
   measuring tools embedded with `include_str!` and written into the project,
   because the agent works there and cannot reach this repo
2. The agent is handed a brief (`buildMigrationPrompt`) naming the site, the
   tools, the dev server URL this project actually serves on, and the exact
   shape of `migration.json` — a real run invented three shapes when the schema
   was only described, and each one broke the panel
3. The method lives in the `shipstudio-site-to-code` skill: survey, settle the
   decisions in one batch, extract the design system from *computed* values,
   then one verified page before the rest. Tokens before pages is what makes
   the work converge; one verified page is what stops a bad structural decision
   being made twelve times
4. `site-fidelity.mjs` scores the pixel match at chosen widths. The score for a
   page is its **worst breakpoint, never a mean** — an average is precisely the
   statistic that hides a broken phone layout, and it caught one in four
   separate trial runs
5. `site-structure.mjs` says *what* differs, by reading both pages' computed
   styles. The score is a good regression signal and a poor diagnostic: one
   container 60px narrow shifts every image and lights up a tenth of the page
   while naming none of it
6. The panel reads the agent's own status file and its comparisons, and shows
   what is done, being done, not done, and waiting on the user — in that fixed
   order, present even when empty. **Resume** hands an interrupted migration
   back to a fresh agent and refreshes its tooling on the way

Full design, the trial results, and the bugs each rule came from:
[docs/site-migration.md](docs/site-migration.md).

### Remote Access Flow

Answers: **can I keep my agents going from my phone, and pick up exactly where they left off?**

1. An MCP server (`src-tauri/src/remote_access/`) binds loopback and is published by Tailscale Funnel on the user's *own* account at `/<slug>` (from `brand.json`; Ship Studio's is `/shipstudio`, so both can be on) — nothing passes through infrastructure we run. It is a separate server from the agent bridge, which must never be internet-reachable
2. Tools act on the *existing* agent tabs (backend PTY sessions, rendered through `vt100`) — not a parallel shell — so the conversation is waiting when the user is back. New work starts via `remote-start-agent` → `startInBackground` (spawn-with-prompt, never paste; the same command builder as a mounted tab, adopted by the project's tabs without switching the window). Screenshots are headless Playwright against the running dev server. Agent tools wait and answer `STATUS:` (read off the screen by `agent_state.rs`) … `NEXT:` (the step the assistant must take), so the assistant reports results instead of stopping at "sent"
3. The computer must stay on, and the UI says so first: keep-awake (`caffeinate -w`), opt-in lid-closed mode (`pmset disablesleep`), reopen-at-login, quit warning, and a sidebar indicator that turns amber on battery
4. Security rules — don't weaken without updating docs/remote-access.md: the token never enters the webview (masked; copied from Rust); text goes only to agent tabs, never shells, with `!`, non-allowlisted `/` commands and control characters refused; opening prompts can't start with `-` (`agentPromptArgs`); pushing needs a PIN the assistant never sees, with a lockout; every action is audited
5. Setup is complete when an assistant has *actually connected* (`ever_connected`), not when a link exists

Full design, the threat model, and what is and isn't verified: [docs/remote-access.md](docs/remote-access.md).

### Agents Flow

Answers: **can I run my work through a team of agents, the way I do in Grok Bot, but on the best model on my own machine?**

1. Agents is the primary view (`AppView` `'agents'`): launch and the end of onboarding land there (`postSetupViewFor` in `useAppSetup.ts`; a project window still opens its workspace), and Projects is the sidebar toggle or ⌘K. The Chief of Staff exists from first open (`ensure_main`) and its chat opens on a stored greeting (`CHIEF_GREETING`). The bell beside the sidebar toggle opens What's in flight, with how many agents need you; the Phone row at the foot of the sidebar is the companion app (remote access shows there only while on)
2. An agent is a registry entry plus a home folder: `CLAUDE.md` (instructions + a `## Memory` section it maintains) and `messages.jsonl` (what the user was shown). The chat log is ours, never reconstructed from Claude's transcript
3. Each turn is one engine process in the agent's home — `claude --print --resume`, or Codex on its app-server (`exec` as the fallback), chosen per agent (`agents/engine.rs`) — with the agent tools on the agent bridge at `/mcp/agent`, the caller named only by a per-turn bearer secret that never touches argv (`agents/reach.rs`). Turns may not write any `.git` or `.shipstudio` folder (deny rules / a Codex permissions profile). Text blocks become bubbles; tool calls update the "working" line and become the observed steps of the "what it did" timeline (`agents/work.rs`), stored beside the log, never in it. No process per idle agent
4. `message_agent` is asynchronous and capped at 6 agent-to-agent hops per user message. Creating and changing agents is Chief-only. **Admins** (`agents/admin.rs`; a per-agent switch only the user sets, on for the Chief by default) answer other agents' local work, put logins away, pause/resume them, change their routines and soft-delete them (Recently deleted, 30 days); never spending, sending, publishing, pushing, sharing or keys, which come to the user in one `bring_to_user` message. Off in any turn answering outside text; every action audited in both chats and Settings → Agents → Admin activity
5. Approvals: `acceptEdits` plus `--permission-prompt-tool` → an Allow / Deny card. Claude Code's ~60s MCP timeout is raised with `MCP_TOOL_TIMEOUT`, or a waiting card times out as "the tool is hanging"; never remove it
6. Import: from Ship Studio on this Mac (`agents/other_app.rs`, a read-only preview then a copy), or over Remote Access's `import_conversation` (`agents/connector.rs`): consent card, a sealed interview (`agents/interview.rs`), then one review card (`agents/review.rs`). Nothing becomes an agent until the user imports it; the main one merges into the Chief
7. Conversations (`agents/conversations.rs`): each its own session and chat, memory shared; the one `messages.jsonl` tags every line with its conversation (untagged = the first, so nothing migrates), sessions swap between turns, and New conversation (`agents_conversation_new`, also what Start fresh does now) never waits on a turn; the context meter shows only a reading the engine reported (`agents/context.rs`). Every turn has the engine's own compaction on and tuned, and past 70% the app tidies between turns: memory first, then compact (or start fresh where it can't), one quiet line (`agents/tidy.rs`; docs/agents.md, "Keeping context healthy")
8. Deliverables end on one result card (`agents/results.rs`, `share_result`): only files that resolve inside the home or a project, secret files refused, lists refused rather than trimmed, checks headed "It says it checked". Ask for changes revises it (v2, with what changed)
9. A bound agent's turn runs in its own copy (`agents/task.rs`: a locked worktree under `<projects root>/.worktrees/`, its own branch and dev port). Keep only into the branch it came from; a copy left unchanged is removed
10. Take over (`agents/takeover.rs`) claims the agent under the inbox lock: no turn starts, queued messages wait, routines due are skipped and recorded, until Hand back
11. Routines (`agents/schedule.rs`) and "When…" routines (`agents/watch.rs`, sealed by `agents/watch_seal.rs`): polling checks from this Mac, no webhooks; first check is a baseline, nothing fires twice, one firing at a time. A turn answering outside text can't write its own `CLAUDE.md` and needs a card to change the team
12. Usage (`agents/usage.rs`, `agents/quota.rs`): only what the engines report, never estimated; no reading, no line. Forecasts (`agents/forecast.rs`) are estimates from past runs, always labelled so and absent with too little history; the inventory, modes and spare-capacity list are `agents/inventory.rs` and `agents/usage_plan.rs`, the tools `agents/usage_tools.rs`
13. The phone drives the same commands through the companion server (`src-tauri/src/companion/`): chats, approval and result cards, the timeline and starting things all work there (see docs/mobile.md)

Full design and limits: [docs/agents.md](docs/agents.md).

### Breakpoint Canvas Flow

1. "Every breakpoint" is the last option in the preview toolbar's viewport control — the same segmented control as the devices — or Cmd+K → "Show every breakpoint". A pane too narrow for the icon strip gets the same list from the overflow button beside refresh
2. Each frame shows its page IN FULL at its own device width. That should be impossible — an iframe's height is the viewport it reports — so the injected script makes the page believe it is on that device instead: viewport units rewritten, root height pinned (percentage chains), and `window.innerHeight` answered with the device (JS-driven sizing, which is otherwise a runaway)
3. Exactly one frame is active: interactive, editor-bound, inspected, and what screenshots crop to. `usePreviewEditorFrame` re-binds the editor hooks by changing the ref's object identity. What the others give up is only editability — **every** frame on a canvas holds still (`ss:canvas`), because a frame here is a whole page and an animation anywhere in it repaints the lot, forever; exempting the active frame alone doubled the preview's idle CPU on a real page. A frame nobody is in is additionally told it is a background tab (`ss:passive`): `hidden` is reported and its rAF clock suspended
4. Wheel and gesture events that land on a frame never reach the app — the injected script forwards zoom gestures up with their coordinates, and hands up any wheel the page has no scroll left to spend so it pans the canvas
5. The canvas itself does not scroll. A gesture moves a **camera** (`useCanvasCamera`) which writes one composited transform per animation frame and tells React only once the gesture settles; a native scroll container put position in `scrollLeft` and forced a full layout of four live pages on every event of a pinch. Frames are `scrolling="no"` — a frame's scrollbar is subtracted from the width its media queries are evaluated at, which flipped the 1024px frame below its own breakpoint and made it measure thousands of pixels too tall
6. Everything the canvas adds is off until `ss:canvas` arrives, so the ordinary single-frame preview costs exactly what it did before
7. Full design, including the measured performance numbers and the known limits: [docs/breakpoint-canvas.md](docs/breakpoint-canvas.md)

### Languages (Multilingual / i18n) Flow
1. Cmd+K → "Languages" opens `LanguagesModal` (`useModal('i18n')`)
2. `get_i18n_status` detects the framework path: Next.js Pages Router (built-in `i18n` in next.config), Astro (`i18n` in astro.config), or App Router via next-intl (`src/i18n/routing.ts`); App Router without next-intl gets a guided one-time agent setup
3. `set_i18n_config` surgically rewrites only the `locales` array and `defaultLocale` string (sibling keys preserved); unparseable/wrapped configs and non-string locale entries fail with a `Validation` error and the UI offers an AI fallback — config is never guessed at or destroyed
4. Every agent interaction (translate, setup, removal cleanup) goes through a prompt-review step: the user sees the exact prompt, then copies it or pastes it into the terminal (nothing runs until they press Enter)
5. The preview toolbar shows a locale switcher (`PreviewLocaleSwitcher`) when 2+ locales are configured; page selection preserves the active language
6. Removal only edits config — translated files stay on disk (and Astro keeps serving locale folders), so the UI warns and offers an AI cleanup prompt

### Conflict Resolution
- Conflicts detected via `git diff --name-only --diff-filter=U`
- ConflictedFile struct contains parsed conflict blocks with context lines
- User resolves conflicts in UI by choosing "ours" or "theirs" for each block
- Resolution written back to file, then auto-staged when all conflicts resolved
- Complete merge commits with message "Resolved merge conflicts via Ship Studio"

### Integration Status
- GitHub: Check via `gh auth status`
- Vercel: Check via `vercel whoami`
- Claude: Check via `claude --version`

## How to Do Things in Ship Studio

These are the canonical patterns. Follow them — a DX refactor established primitives so the same logic isn't re-invented in every component. New code that bypasses these patterns will get flagged in review.

### New modal → use `<ModalFrame>` from `src/components/primitives/ModalFrame.tsx`

Don't hand-roll overlay divs, ESC handling, or close buttons.

```tsx
// ❌ Don't
<div className="my-modal-overlay" onClick={onClose}>
  <div className="my-modal-content" onClick={(e) => e.stopPropagation()}>
    <h3>Title</h3>
    <button onClick={onClose}>×</button>
    ...
  </div>
</div>

// ✅ Do
import { ModalFrame } from './primitives/ModalFrame';

<ModalFrame isOpen={isOpen} onClose={onClose} title="Title">
  {/* body */}
</ModalFrame>
```

For toggling state, pair with `useModalState()` from `src/hooks/useModalState.ts`.

### Loading spinner → use `<Spinner>` from `src/components/primitives/Spinner.tsx`

Don't hand-roll `border-top-color` + `animation: spin` divs — there used to be 16 per-feature copies.

```tsx
import { Spinner } from './primitives/Spinner';

<Spinner size="sm" />                                  {/* 14px — inline, inside buttons */}
<Spinner />                                            {/* 20px — default */}
<Spinner size="lg" style={{ color: 'var(--accent-active)' }} /> {/* 32px — section loading */}
```

The arc uses `currentColor` — set `color` on the spinner or let it inherit (inside a primary button it takes the accent's ink).

### New button → use the semantic button family from `src/components/primitives/`

Don't invent per-domain button classes (`foo-btn`, `xyz-action`, etc.) — they fragment the design system.

```tsx
// ❌ Don't
<button className="publish-btn primary" onClick={...}>Publish</button>

// ✅ Do
import { Button } from './primitives/Button';

<Button variant="primary" onClick={...}>Publish</Button>
```

`Button.tsx` is the component/API source of truth; the `base.css` `.button*` rules are its
token-driven implementation. Do not style an internal action by applying `.button` classes to a
raw element.

Variants: `default | primary | secondary | danger | ghost | warning | variable`. The default is
the neutral solid Figma button; `secondary` is the neutral outline treatment. Sizes:
`default | compact | large`; omitted `size` means the 30px `default`, while `compact` is reserved
for dense rows, toolbars, and tight popovers. Buttons hug their contents by default; use
`width="fill"` for full-width (`block` remains a backwards-compatible alias).

Choose by behavior: `Button` for actions, `IconButton` for icon-only actions, `ToggleButton` for
boolean state, `MenuButton` for dropdown triggers, and `SplitButton` for an action/menu pair. They
share the same appearance, variant, size, width, and token-driven states. Use `TextButton` for an
inline action in prose or metadata; it delegates button semantics and focus behavior to `Button`
but deliberately has no control surface, fixed height, radius, or shadow. Use `Tabs` for tab
navigation rather than hand-rolling `role="tab"` buttons, and `SegmentedControl` for mutually
exclusive filters or settings that update a value in place.

Use `PropertyField` for interactive values in the visual/CSS editors rather than treating them as
actions. Its `value` and `select` variants stay neutral. The `variable` variant uses the shared
purple variable tokens. Inherited/modified state is communicated by the accompanying label, not by
recoloring the field.

**When a raw `<button>` is fine** (don't force these into the button family):

- Geometry controls such as canvas handles, timeline points, and colour swatches
- Internals of another primitive where that primitive owns the interaction
- Large selection surfaces/cards with richer content than a normal label and icon
- Special equal-choice controls such as the conflict yours/theirs pair — changing their hierarchy is a design decision, not a cleanup

Everything else that's a standalone action button (CTA, submit, cancel, delete, confirm) uses `<Button variant>`.

### New workspace panel → give it a `dockSlotId` and let the rail place it

Don't position a panel yourself, and don't add a `grid-template-columns` rule
for it. Panels are placed by the workspace rail (`WorkspaceDock`), which the
user can rearrange per project.

```tsx
// ❌ Don't — a fixed column, in a fixed order, that nobody can move
<div className="preview-container--my-panel-pinned">…</div>

// ✅ Do
import { DockablePanel } from '../primitives/DockablePanel';
import { usePanelDockBinding } from '../../contexts/PanelDockContext';

const dock = usePanelDockBinding('myPanel');   // add the id to PANEL_META first
<DockablePanel dock={dock} docked={isDocked(layout, 'myPanel')} visible={isOpen} …>
```

Add the panel to `PANEL_META` and `DEFAULT_LAYOUT` in
[src/lib/workspaceLayout.ts](src/lib/workspaceLayout.ts); `normalizeLayout`
inserts it into every already-saved layout at that position. The rail then owns
its column, its width, its resize handle, and the header drag that moves it —
the panel owns only whether it is open and what it shows. Full design:
[docs/flexible-panels.md](docs/flexible-panels.md).

### Async state in components → use `useAsyncState` or `useInvoke`

Don't hand-roll `isLoading` + `error` + `data` state triples; they forget the mount guard, forget the `finally`, and drift.

```tsx
// ❌ Don't
const [data, setData] = useState(null);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const load = async () => {
  setIsLoading(true);
  try { setData(await invoke('cmd', {...})); } catch (e) { setError(String(e)); } finally { setIsLoading(false); }
};

// ✅ Do
import { useInvoke } from '../hooks/useInvoke';
const { data, isLoading, error, execute } = useInvoke<ResultType>('cmd');
// call execute({ args }) when ready
```

For non-Tauri promises use `useAsyncState(fn)` directly.

### Calling Tauri commands → prefer `useInvoke` in components

Reserve raw `invoke` calls for `src/lib/*.ts` wrappers. Components should call the wrapper functions (which can internally use `invoke` directly), and when the component needs loading/error state, they should use `useInvoke`.

### Copy-to-clipboard → use `useCopyToClipboard`

Don't call `navigator.clipboard.writeText` directly in components.

```tsx
// ✅ Do
const { copy, isCopied } = useCopyToClipboard({ onCopy: () => showToast('Copied', 'success') });
<button onClick={() => copy(text)}>{isCopied ? 'Copied!' : 'Copy'}</button>
```

### Polling → use `usePolling(fn, { intervalMs, enabled })`

Don't use raw `setInterval` in components — you'll forget the cleanup and you'll skip backoff on error.

```tsx
// ✅ Do
usePolling(async () => refreshStatus(path), { intervalMs: 3000, enabled: isFocused });
```

### CSS values → always use design tokens

Full token + primitive reference: [docs/design-system.md](docs/design-system.md)

Token import order is defined by [src/styles/global/token-manifest.json](src/styles/global/token-manifest.json). Definitions are split across core, semantic, component, and compatibility token files under `src/styles/global/`. Never use raw hex colors, raw spacing px, raw z-index numbers, or raw durations in consuming stylesheets.

```css
/* ❌ Don't */
.thing {
  color: #f59e0b;
  padding: 12px 16px;
  border-radius: 8px;
  z-index: 1000;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  transition: background 0.15s ease;
}

/* ✅ Do */
.thing {
  color: var(--accent-warning);
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-md);
  z-index: var(--z-modal-overlay);
  box-shadow: var(--shadow-md);
  transition: background var(--transition-interaction);
}
```

Need a value that doesn't exist yet? Add it to the correct layer named by the token manifest: reusable literals in `tokens-core.css`, product intent in `tokens-semantic.css`, and owner-specific contracts in `tokens-components.css`. `tokens-compatibility.css` holds only frozen legacy literals awaiting migration; never add to it.

**Raw color literals fail CI** (`pnpm check:patterns`). The rules:

- Colors used in 2+ files or belonging to a semantic family (status, info, purple, ANSI) → define a core color primitive and expose it through a semantic role. Alpha tints use the RGB-triplet companions; white tints and black scrims use the existing semantic overlay roles.
- Intentional one-off colors (brand hues, feature-specific accents) → a file-local token in a `:root` block at the top of that feature's CSS file, prefixed with the feature name (`--dm-failed-red`, `--setup-wizard-green`).
- A raw value that genuinely must stay (e.g. backgrounds matching xterm's theme) → tag the line with a `/* css-ok: reason */` comment.
- Font sizes use the type scale (`--font-size-xs` … `--font-size-3xl`). Off-scale sizes (15px, 17px…) are migration debt — round to the nearest token when touching that code.
- `@keyframes` names are **global** in CSS. Shared keyframes (`spin`, `fadeIn`, `skeleton-pulse`) live in base.css only; feature-specific ones must be feature-prefixed. Duplicates fail CI (a duplicate silently overrides every consumer app-wide based on import order).
- `var(--something)` referencing a token that's defined nowhere fails CI — an undefined var makes the declaration invalid and the style silently doesn't apply.

### Colour, theme and name → monochrome, both themes, name-free

Full model: [The accent](docs/design-system.md#the-accent) and [Themes](docs/design-system.md#themes-light-and-dark).

- **The accent is the Chief of Staff's colour**, scoped per agent (`useAccentScope`; `AccentScope` for portals). It means primary action, selection and "this is on" — **never status**. Running, success and info have their own roles (`--status-running`, `--accent-success`, `--status-info`); the Chief's colour may be red, amber or green.
- **Answers are neutral, never accent.** Allow on an approval, secret or prompt card is `variant="strong"`, never `primary` (`approvalNeutral.test.tsx`). Danger is told apart by an icon as well as hue.
- **Focus is neutral**: `--focus-ring`, never a hue or the accent.
- **Both themes, desktop and phone.** Semantic roles only, so light and dark both work; nothing assumes dark. `theme.test.ts` holds every role's light value and its contrast.
- **No literal colours or sizes in mobile.** Colours, radii, icon/avatar sizes and type sizes come from `mobile/src/lib/theme.ts`; scan tests in `mobile/__tests__/theme.node.test.ts` fail any literal.
- **The product name comes only from `brand.json`** (`BRAND.name` in TS, `brand::NAME` in Rust), and only where macOS or a connector needs a name. Copy says "the app", "here" or "this Mac". `scripts/check-brand-copy.mjs` (run by `pnpm check:patterns`) fails on the old name in `src/` copy and on brand-named files; `pnpm check:brand` checks the identity copies.
- **Tabs vs segmented**: underline `Tabs` for sections, segmented tabs in small dialogs, `SegmentedControl` for a value that changes in place — see [the rule](docs/design-system.md#underline-tabs-segmented-tabs-or-a-segmented-control).

### New CSS file → mind the folder structure

CSS lives under this folder structure:

```
src/styles/
├── global/      token layers and manifest, base rules, typography, shared keyframes
├── features/    branches/, dashboard/, publish/, workspace/, …
├── modes/       compact-mode, education-mode, code-mode
└── components/  modal, command-palette
```

Don't dump new files into `src/styles/` root unless they're genuinely cross-cutting.

### New Rust Tauri command → follow the four rules

1. **Return `Result<T, CommandError>`** — see [src-tauri/src/errors.rs](src-tauri/src/errors.rs). Don't return `Result<T, String>`; the frontend can't discriminate error variants.
2. **Validate paths** with `validate_project_path()` from `utils.rs` on any user-supplied filesystem path. Path traversal is a real threat model.
3. **Shell out via `run_with_timeout`** from [src-tauri/src/external_command.rs](src-tauri/src/external_command.rs) — gives you timeouts, structured stderr capture, and extended-PATH spawning for free.
4. **Add `#[tracing::instrument]`** to every command function — even trivial ones. Observability is cheaper than forensics.

### Modal state → use `ModalContext`

Don't add new `show*`/`open*`/`close*` triples to `App.tsx` or `useWorkspaceModals`. Use `useModal('myModalId')` from the `ModalContext` (see [src/contexts/ModalContext.tsx](src/contexts/ModalContext.tsx)); modals read their own open state rather than being passed `isOpen` props.

### New feature → contribute commands via `useCommands`

Every user-facing feature MUST expose its primary actions through the Cmd+K palette. The palette is a contract, not a screen — it's how users discover and invoke features without hunting toolbars.

Commands live next to the handlers that implement them. The pattern is always:

```tsx
// src/commands/useBranchCommands.tsx (or inline in the feature hook)
import { useCommands } from '../commands/useCommands';

export function useBranchCommands({ currentBranch, switchBranch, hasConflicts }: Params) {
  useCommands(
    () => [
      {
        id: 'branches.switch',                      // domain.verb, globally unique
        title: 'Switch branch…',
        icon: <BranchIcon size={14} />,
        category: 'branch',                         // drives tab + grouping
        when: 'project',                            // or (ctx) => boolean
        keywords: ['checkout', 'change'],
        run: () => switchBranch(),
      },
      {
        id: 'branches.resolveConflicts',
        title: 'Resolve merge conflicts',
        category: 'branch',
        when: ({ kind }) => kind === 'project' && hasConflicts,
        run: () => openConflictModal(),
      },
    ],
    [switchBranch, hasConflicts],
  );
}
```

**The six rules:**

1. **`id` is namespaced and globally unique** — format `domain.verb` (e.g. `branches.switch`, `devserver.restart`, `modal.env`). Collisions silently overwrite.
2. **`when` is static or a predicate** — `'home' | 'project'` for the common case, or `(ctx) => boolean` for stateful gating. Evaluated fresh at palette open / state change; never a stale snapshot.
3. **`run` surfaces failures via toast** — silent failures kill palette trust. If a command can fail, `try/catch` and call `showToast(err, 'error')`. Don't assume backend rejections will bubble anywhere visible.
4. **Opening a modal goes through `useOpenModal()`** — from `contexts/ModalContext.tsx`. It returns a stable `(id) => void`. Never reach around to a setter.
5. **Destructive actions need confirmation** — route through the existing confirm-modal pattern. The palette is low-friction by design; guardrails belong on the handler side.
6. **Deps array controls re-registration** — treat it exactly like `useEffect`'s. Missing a dep → stale closure. Too many deps → the bucket rebuilds constantly (no harm, but wasteful).

**Where to put it:**

- For a feature with ≤ 3 commands → call `useCommands` at the bottom of the feature's hook (if it's `.tsx`) or a sibling `useXxxCommands.tsx`.
- For simple modal-opener commands → batch them in `src/commands/useAppCommands.tsx` (already exists).
- For cross-cutting commands (e.g. "Check for updates") → `useAppCommands.tsx`.

**Out of scope for the palette** (don't register these):

- One-shot deep settings (e.g. "Toggle Slack CTA visibility") — leave inside their settings modal.
- Buttons whose label depends heavily on state and where the user is already looking at it (e.g. per-row delete buttons in a list).
- Anything that'd need more than two UI prompts after triggering — build a dedicated flow instead.

See `src/commands/` for the infra (registry, scorer, frecency, `useCommands`) and `src/commands/useAppCommands.tsx` for a canonical example.

**A second reason to follow this rule:** the UI harness sweeps the palette
registry to screenshot every feature (`node scripts/harness-capture.mjs
--commands`). A feature that registers its commands gets visual coverage for
free; one that doesn't is invisible to review. See
[docs/ui-harness.md](docs/ui-harness.md).

---

## Patterns That Are "Out"

These patterns existed in the pre-refactor codebase and are deliberately
avoided now. New code that re-introduces any of them will get caught by
CI (`pnpm check:patterns`, `pnpm check:loc`) and/or a reviewer.

- **Hand-rolled modal overlays** — use `<ModalFrame>`. Re-implementing ESC / click-outside / z-index fights is how accessibility regressions creep back in.
- **Per-domain button classes** (`publish-btn primary`, `rewind-btn`, `xyz-submit`) — use `<Button variant="…">`. Fragmented button CSS is how the design system dies.
- **`isLoading`/`error`/`data` state triples in components** — use `useAsyncState` or `useInvoke`. Hand-rolled triples forget mount guards, forget `finally`, and drift.
- **`onToast?:` prop chains** — use `useOptionalToast()` from `contexts/ToastContext`. Prop drilling for cross-cutting UI.
- **`show*` / `open*` / `close*` state in App.tsx** — use `useModal('id')` from `contexts/ModalContext`. Modals read their own state.
- **Raw `navigator.clipboard.writeText` in components** — use `useCopyToClipboard`. Centralizes error handling and the "copied!" flag.
- **Raw `setInterval` polling** — use `usePolling`. Handles backoff on error and teardown.
- **`Result<T, String>` on `#[tauri::command]` entry points** — use `Result<T, CommandError>` from `src-tauri/src/errors.rs`. String errors can't be discriminated by the frontend.
- **Bare `.output().await` on network CLI calls** — use `run_with_timeout` from `src-tauri/src/external_command.rs`. Unbounded CLI calls can hang the UI forever.
- **A panel that positions itself** — a `position: fixed` panel with its own drag, or a `grid-template-columns` rule naming panels in a fixed order. Three optional side panels needed eight of those rules plus seven toolbar overrides, and that set of selectors *was* the layout, which is why nothing could be rearranged. Use `DockablePanel` with a `dockSlotId`.
- **Raw hex colors, raw px spacing, raw z-index numbers in CSS** — use the manifest-ordered token layers under `src/styles/global/`. Adding a new value? Add it to the correct layer first.

## Known Gotchas

### CSP Must Be Null for Terminal Fonts
The Content Security Policy in `src-tauri/tauri.conf.json` MUST be set to `null`.

**Why:** xterm.js dynamically injects `<style>` elements for font rendering. Even with `style-src 'unsafe-inline'` in the CSP, WebKit/Tauri blocks these styles in production builds. This causes the terminal to fall back to system fonts instead of JetBrains Mono Nerd Font.

**If you change CSP:** Always test terminal font rendering in a production build (`pnpm tauri build`), not just dev mode. Dev mode works fine but production builds will break.

**What stands in for a CSP.** With no CSP, nothing stops the webview loading a remote image or
following a link, so untrusted text never gets the chance:
- HTML from agents, outside assistants and workflows goes only through `sanitizeMessageHtml`
  (`src/lib/safeHtml.ts`): a prose-only tag allowlist, no `style`, no forms/media/svg/iframes, and
  every image rendered as an "Image from example.com" link chip, never loaded.
- The preview iframe can only *ask* to send text to an agent; the user confirms it in an app chip
  (`src/lib/previewErrorToAgent.ts`), and every paste into xterm strips ESC and C0/C1 controls.
- `src-tauri/src/navigation_guard.rs` denies non-web schemes and `src/lib/navigationGuard.ts` sends
  every unhandled link to the browser. On macOS the Rust handler also fires for the preview's
  iframes and cannot tell them apart, so it must keep allowing web URLs — don't "tighten" it
  without breaking every embed in a user's site.

A CSP that keeps `style-src`/`font-src` open for xterm but restricts `img-src`, `connect-src`,
`frame-src` and `form-action` would be a real second wall; it has not been tried because it can only
be verified in a production build.

## Releasing New Versions

Use `scripts/release.sh` to automate the release process. The script bumps the version in all 3 files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`), updates `Cargo.lock`, commits, and tags.

```bash
# Patch bump with release notes (most common)
./scripts/release.sh -n "**Fixed bug X** - Description"

# Minor or major bump
./scripts/release.sh minor -n "**New feature** - Description"

# Then push to trigger CI
git push origin main && git push origin vX.Y.Z
```

The `-n` flag automatically adds notes to `RELEASE_NOTES.md`. Without `-n`, you must update `RELEASE_NOTES.md` manually before running the script.

No update feed is configured yet (`links.updates` in `brand.json` is null, so the updater is off and the Ship Studio changelog is emptied); the steps below are inherited and apply once there is one.

**IMPORTANT:** Also update the changelog data in `src/components/dashboard/Changelog.tsx` before each release — it displays "What's New" on the dashboard sidebar.

For Windows builds, tag with a `-win` suffix (e.g. `v0.5.0-win`) — this triggers a separate workflow independent from the macOS pipeline.

See `RELEASING.md` for the full process: secrets, two-repo strategy, auto-update flow, troubleshooting, and Windows release details.
