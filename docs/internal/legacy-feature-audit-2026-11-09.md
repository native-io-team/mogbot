# Legacy feature audit, 2026-11-09

What Mogbot still carries from Ship Studio, measured against [MISSION.md](../MISSION.md):
agents first, not a coding tool. Nothing here has been removed; this is the list to decide from.
Workflows and the Inbox were removed in the same change that wrote this (see CLAUDE.md,
"Workflows and the Inbox (removed)").

## How this was measured

- **Size**: files and lines matched by path under `src/`, `src-tauri/src/` and `mobile/src/`
  (components, libs, hooks, Rust commands, CSS, tests). Approximate: a shared helper may be
  counted under one feature, and a feature's harness scenarios are mostly not counted.
- **Agents use it**: a grep of `src-tauri/src/agents/`, `agent_bridge.rs`, `commands/agents*.rs`,
  `companion/`, `src/components/agents/` and `mobile/src/` for the feature's Rust module path
  (`crate::commands::<name>`) and its key identifiers. "No" means nothing in the agents engine,
  the agents UI or the phone calls into it. It does not mean an agent can't do the same job
  with its own shell and file tools (it usually can).
- **Reachable from Agents mode**: whether the feature is on screen or in ⌘K while Agents is
  showing. Almost everything below is `when: 'project'` in the palette or lives in the
  workspace, so it is reachable only after switching to Projects and opening a project.
- **Not measured**: real usage. Telemetry is off (`brand.json` `telemetry` is null), so there is
  no evidence either way of what anyone clicks. Every "unused" below is structural.

## Ranked: remove first

| # | Feature | Size (files / LOC) | Agents use it | Reachable from Agents | Risk of removal | Recommendation |
|---|---|---|---|---|---|---|
| 1 | Spotify widget | 5 / ~1,660 | No | No | Low | **Remove** |
| 2 | Issue reporting / support | 12 / ~4,870 | No | No (off: `issueRepo` null) | Low | **Remove** |
| 3 | Shopify theme tools | 9 / ~1,000 | No | No | Low | **Remove** |
| 4 | Education overlay | 3 / ~560 | No | No | Low | **Remove** |
| 5 | Health tab (dependency audit) | 7 / ~1,900 | No | No | Low | **Remove** |
| 6 | Languages (i18n) | 5 / ~3,150 | No | No | Low | **Remove** |
| 7 | Breakpoint canvas | 7 / ~3,050 | No | No | Low–medium | **Remove** |
| 8 | Assets panel | 5 / ~2,300 | No | No | Low–medium | **Remove** |
| 9 | Snapshots / rewind | ~6 / ~1,000 | No | No | Medium | **Remove** (worktrees do this for agents) |
| 10 | Visual editor | ~150 / ~60,000 | No (but see below) | No | High | **Remove the editor, keep `inspectStore` + bridge** — its own pass |
| 11 | Community templates gallery | ~4 / ~650 | No | No (off: `templateApi` null) | Low | **Remove the gallery**; keep the starter templates |
| 12 | Changelog (Ship Studio's) | ~3 / ~500 | No | No (emptied) | Low | **Remove the component**; keep the updater |
| 13 | Site migration | 11 / ~3,330 (+ skill, scripts) | Indirectly (skill) | Palette `home` | Medium | **Move behind Projects / fold into a recipe** |
| 14 | Team (multiplayer) panel | 48 / ~15,000 | Partly (trailers, bridge tools) | No | High | **Keep the records, trim the UI later** |
| 15 | Mobile app preview / simulator mirror | 9 / ~5,500 | Indirectly | No | High | **Keep behind Projects** |
| 16 | Conflict resolution UI | 7 / ~2,530 | No | No | Medium | **Keep behind Projects** |
| 17 | Code mode | ~10 / ~2,500 | No | No | Medium | **Keep behind Projects** |
| 18 | Hosting status | 30 / ~9,800 | Yes (via Remote Access) | No | High | **Keep** |
| 19 | IDE integration + screenshots | 7 / ~3,700 | Yes (`dev_server_listening`) | No | Medium | **Keep** |
| 20 | Skills & MCP modals | 18 / ~5,380 | Yes (`commands::mcp`) | No | High | **Keep** |
| 21 | Remote Access | 19 / ~11,300 | Yes, heavily | Sidebar while on | Very high | **Keep** |
| — | Env editor, monorepo, attached libraries, static server | ~15 / ~4,100 | Partly | No | Medium | **Keep** (project plumbing) |

## Each feature

### 1. Spotify widget — remove

- **What**: a now-playing widget in the workspace sidebar, driving Spotify.app through
  AppleScript (`commands/spotify.rs`, `SpotifyWidget.tsx`, `spotify-widget.css`).
- **Agents**: none. The only mention in the agents engine is a doc comment in
  `agents/mac_apps_os.rs` citing it as a precedent for the Automation prompt.
- **Reachable**: only in a project's sidebar, and only while Spotify runs.
- **Risk**: low. It asks for an Apple Events permission the app otherwise needs only for
  agents' Mac apps; removing it is one less TCC prompt to explain.

### 2. Issue reporting / support — remove

- **What**: bug-report and feature-request modals that file GitHub issues to Ship Studio's
  repo (`IssueReportModals.tsx`, 1,709 lines; `issue_reports.rs`; `autoReports`, drafts, CSS
  878 lines; `useIssueReportCommands`).
- **Agents**: none.
- **Reachable**: no. `brand.json` `links.issueRepo` is null, so the feature is already hidden.
- **Risk**: low. If Mogbot later wants a "send feedback" path, it is better as a card an agent
  writes than a 1,700-line form.

### 3. Shopify theme tools — remove

- **What**: Shopify theme detection, store picker and "push theme / build section" commands
  (`components/shopify/`, `commands/shopify.rs`, `lib/shopify.ts`, `useShopifyCommands`).
- **Agents**: none. An agent with the Shopify CLI does this from its own shell.
- **Reachable**: only in a project detected as a Shopify theme.
- **Risk**: low.

### 4. Education overlay — remove

- **What**: a coach-mark overlay explaining Ship Studio's workspace (`EducationOverlay.tsx`,
  `educationContent.ts`, `education-mode.css`; `mode.education.toggle` in ⌘K).
- **Agents**: none. Its copy explains a coding tool's workspace, which is the opposite of the
  onboarding Mogbot has (a conversation with the Chief).
- **Risk**: low; check `data-education-id` attributes left on workspace buttons.

### 5. Health tab — remove

- **What**: a dependency audit and diagnostics panel in Code mode (`commands/health/`,
  `HealthTabPanel.tsx`, `lib/health.ts`, `health-tab.css`).
- **Agents**: none. "Audit my dependencies" is a one-line ask to an agent, which can also fix
  what it finds.
- **Risk**: low.

### 6. Languages (i18n) — remove

- **What**: a modal that rewrites `locales` / `defaultLocale` in Next.js, Astro or next-intl
  configs by string surgery, plus a preview locale switcher and translation prompt builders
  (`commands/i18n.rs`, `lib/i18n.ts`, `PreviewLocaleSwitcher`).
- **Agents**: none. Every path in it already ends by handing the user a prompt to paste into an
  agent; Mogbot's agents can take that request directly.
- **Risk**: low. The locale switcher in the preview toolbar goes with it.

### 7. Breakpoint canvas — remove

- **What**: "Every breakpoint" in the preview: every device width at once, with an injected
  script that fakes the viewport (`PreviewCanvas.tsx`, `useCanvasCamera.ts`, `previewCanvas.ts`,
  `preview-canvas.css`, `docs/breakpoint-canvas.md`).
- **Agents**: none. Agents take screenshots at chosen widths through the preview bridge and
  Remote Access's `shots.rs`, which don't use it.
- **Risk**: low–medium. It is threaded through `Preview.tsx` and the editor frame binding
  (`usePreviewEditorFrame`); remove with the visual editor or straight after.

### 8. Assets panel — remove

- **What**: a dockable panel listing and uploading files under `/public` (`AssetsPanel.tsx`,
  `commands/assets.rs`, `lib/assets.ts`, `assets-panel.css`).
- **Agents**: none. Agents read and write the project's files directly.
- **Risk**: low–medium: it is one of the workspace's dockable panels, so `PANEL_META` /
  `DEFAULT_LAYOUT` and saved layouts need the id dropped (`normalizeLayout` should tolerate a
  missing panel; check).

### 9. Snapshots / rewind — remove

- **What**: undo / redo of a workspace terminal agent's file edits: a watcher snapshots the
  working tree with `git stash create` after each burst of changes, kept in memory per project
  (`commands/snapshots.rs`, `useSnapshots.ts`, `lib/snapshots.ts`, `lib/backups.ts`;
  `modal.backups` in ⌘K).
- **Agents**: none. A Mogbot agent bound to a project works in its own git worktree, and
  Discard on its card is the rewind.
- **Risk**: medium. It is the only undo for an agent run by hand in a workspace terminal (Take
  over, or a plain agent tab). The list is in memory, so nothing on disk needs keeping.

### 10. Visual editor — remove the editor, keep what agents read

- **What**: point-and-click editing of the preview: the CSS cascade panel, class bar, colour
  picker, variables, spacing, element tree, insert menu, HTML editor, and the Rust that writes
  edits back to source (`components/edit/`, ~95 files; `commands/edit*.rs`,
  `css_rule_mutations.rs`, `custom_classes.rs`, ~19,000 lines of Rust; many `lib/css*` modules).
  By far the largest inherited feature: roughly 60,000 lines including tests.
- **Agents**: the editor itself, no. But `lib/inspectStore.ts` (263 lines) and the preview's
  select script feed `lib/agentBridge.ts`, which is how a workspace agent reads the preview's
  console, network and DOM. Those must stay.
- **Reachable**: only in a project's workspace.
- **Risk**: high, by size and coupling (Preview, the dock, the palette, harness scenarios, the
  design-system registry). Worth its own branch with the UI harness run before and after.
- **Recommendation**: remove in a dedicated pass, after the low-risk items above, keeping
  `inspectStore`, the bridge and screenshots.

### 11. Community templates gallery — remove the gallery

- **What**: a gallery of community starter templates fetched from `links.templateApi`
  (`TemplateGallery.tsx`, `TemplateCard.tsx`, `fetch_community_templates`).
- **Agents**: no. `project_create` uses the bundled starters (`commands/projects/templates.rs`),
  not the gallery; keep those.
- **Reachable**: no. `templateApi` is null, so the gallery is already off.

### 12. Ship Studio's changelog — remove the component

- **What**: the dashboard's "What's New" (`dashboard/Changelog.tsx`), emptied because
  `links.updates` is null. The updater plumbing (`UpdateBanner`, `lib/updater.ts`) is worth
  keeping for when Mogbot has a feed.

### 13. Site migration — move behind Projects, or fold into a recipe

- **What**: New Project → From a URL; a panel showing the agent's phases and a fidelity
  matrix, plus measuring scripts written into the project and the `site-to-code` skill
  (`components/migration/`, `commands/migration.rs`, `lib/migration.ts`).
- **Agents**: indirectly. The bundled skill teaches any agent the method, and the brief is
  started in a workspace terminal through `lib/promptHandoff.ts` (the queue that outlived the
  Inbox). Mogbot's agents don't call `commands::migration`.
- **Reachable**: ⌘K `migration.import` is `when: 'home'`, so it shows in Agents mode's palette.
- **Risk**: medium. It is the inherited feature closest to the north star ("an extremely complex
  task, made easy"), so the decision is about shape, not value: a Chief recipe ("rebuild this
  site") that creates a bound agent with the skill and returns result cards would replace the
  bespoke panel. Until then, keep it as is.

### 14. Team (multiplayer) panel — keep the records, trim the UI later

- **What**: a "vision prototype" of multiplayer: an activity feed, people, presence and canvas
  comments read from git history, PRs and `.shipstudio-team/` records (`components/team/`,
  `components/comments/`, `commands/team/`, `lib/team*.ts`; ~15,000 lines).
- **Agents**: partly. `agents/task.rs` writes commits through `commands::team::with_trailers`
  (the `Made-With` trailer), and `agent_bridge.rs` exposes the team tools to workspace agents.
  The `.shipstudio-team/` format is shared with Ship Studio.
- **Risk**: high for the records and trailers; low for the panels themselves.
- **Recommendation**: keep `commands/team` (trailers, records, bridge); consider removing the
  Team panel and comments UI once nobody relies on them.

### 15. Mobile app preview / simulator mirror — keep behind Projects

- **What**: build and mirror Expo / React Native / Flutter apps in the iOS simulator
  (`commands/mobile.rs` 3,410 lines, `DeviceMirror.tsx`, `androidMirror.ts`).
- **Agents**: indirectly, and load-bearing: `commands/companion_install.rs` (building the
  user's own phone companion app) imports `commands::mobile`, and `commands/projects/sessions.rs`
  tears it down. `project_tools.rs` tells agents a native app "runs in the iOS simulator from
  the project's workspace".
- **Risk**: high. Removing it would break the phone self-build. Keep.

### 16. Conflict resolution UI — keep behind Projects

- **What**: a visual ours/theirs merge-conflict resolver (`commands/conflicts.rs`,
  `lib/conflicts.ts`, `branches/Conflict*`).
- **Agents**: no. An agent's Keep changes can still conflict, and this is the user's way out
  without a terminal. Keep until agents resolve conflicts on a card.

### 17. Code mode — keep behind Projects

- **What**: in-app file browsing and editing (`components/code/`, `commands/code.rs`).
- **Agents**: no, but it is how a user looks at what an agent changed without an IDE.
- **Recommendation**: keep; drop the Health tab inside it (item 5).

### 18. Hosting status — keep

- **What**: "did the pushed commit deploy?" for Vercel, Cloudflare Pages and Netlify
  (`commands/hosting/`, `components/hosting/`, `lib/hosting*.ts`).
- **Agents**: yes, through Remote Access: `remote_access/deploy.rs` imports
  `commands::hosting` so an outside assistant can ask about a deploy.
- **Recommendation**: keep; a later step is giving Mogbot's own agents a read-only tool on it.

### 19. IDE integration and screenshots — keep

- **What**: Open in Finder / VS Code / Cursor, plus the headless screenshot and thumbnail
  machinery (`commands/ide/`).
- **Agents**: yes. `agents/project_tools.rs` calls `commands::ide::dev_server_listening`; the
  screenshot code serves project thumbnails. The IDE openers are a few dozen lines.

### 20. Skills & MCP modals — keep

- **What**: install agent skills and MCP servers per project (`components/extensions/`,
  `commands/mcp.rs`, `commands/skills/`).
- **Agents**: yes. `agents/apps.rs` builds agents' apps on `commands::mcp`, and the bundled
  skills (`team`, `brand-guidelines`, `site-to-code`) install from `commands/skills/bundled.rs`.

### 21. Remote Access vs the phone companion — keep both

- **What**: an MCP server over the user's Tailscale Funnel so another assistant (Grok, Claude,
  ChatGPT) can drive Mogbot's agents (`remote_access/`, `components/remote/`).
- **Overlap**: the companion app answers "my agents from my phone"; Remote Access answers "my
  agents from another assistant". The docs already say so.
- **Agents**: heavily. `agents/sessions.rs`, `decisions.rs`, `project_tools.rs`, `connector.rs`
  (Import), `policy_card.rs` (keep this Mac awake), `takeover.rs` and others import
  `remote_access::tools`, `agent_state`, `power` and its audit log. The shared tool layer is the
  agents' layer, not a separate feature.
- **Risk**: very high. Keep. If anything, rename the shared modules out of `remote_access::` so
  the dependency reads honestly.

## Suggested order

1. One low-risk branch: Spotify, issue reporting, Shopify, education overlay, Health tab,
   Languages, the templates gallery and Ship Studio's changelog (items 1–6, 11, 12). About
   14,000 lines, no agent dependency, mostly self-contained.
2. Breakpoint canvas and Assets panel (7–8): touch the preview and the dock; run the UI harness.
3. Snapshots (9): decide first whether a workspace terminal agent still needs undo.
4. Visual editor (10) on its own branch, keeping `inspectStore`, the bridge and screenshots.
5. Decide site migration's shape (13) and the Team UI (14) with the owner.

## A gap Workflows left

Workflows ran a **read-only** agent in a project on a schedule or on push/PR, and filed
**deduplicated findings** (fingerprinted, with a recurrence count) to one list. Agents' routines
cover the schedule, "When…" routines cover GitHub events, and result cards cover the report. Not
covered:

- **On push / on PR opened** triggers from the app's own Push and Submit for Review buttons.
  "When…" routines watch GitHub mentions and assignments, not the user's own pushes.
- **Enforced read-only**: a workflow ran under `--permission-mode plan` / `--sandbox read-only`.
  A routine runs at the agent's independence level, so a "just look" routine relies on its
  briefing plus the approval wall, not on the engine refusing writes.
- **Dedup across runs**: a routine that finds the same problem every night reports it every
  night; nothing folds repeats into one item with a count.

Not rebuilt here, by instruction. Noted so the owner can decide whether routines need any of it.
