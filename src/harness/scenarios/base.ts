/**
 * The default backend every scenario starts from: a healthy, fully set-up
 * machine with a couple of projects. Scenarios override only the commands
 * they are actually about, so a hosting scenario doesn't have to restate
 * what onboarding returns.
 *
 * Every shape here is copied from the real type declarations in `src/lib`
 * (and, for hosting, from `src-tauri/src/commands/hosting/model.rs`), not
 * invented — a fixture that drifts from the real response teaches the agent
 * the wrong thing.
 */

import { PHONE_QR } from '../fixtures/phoneQr';
import { remoteBrief, remoteStatus } from './remote';
import { phoneStatus } from './phone';
import type { CommandMap } from '../types';
import { BALANCED_TEAM, BALANCED_VIEW } from '../fixtures/policy';
import { onItsOwnFor, TEAM_ON_ITS_OWN } from '../fixtures/onItsOwn';
import { recipePreviewFor } from '../fixtures/recipe';
import { onlyFirst } from '../fixtures/conversations';

export const HARNESS_ROOT = '/Users/harness/ShipStudio';

/** `prompts::CHIEF_GREETING`, verbatim: what a new Chief's chat opens on. */
export const CHIEF_GREETING_TEXT =
  "Hi, I'm your Chief of Staff. " +
  "Tell me what's on your plate this week and I'll put a team of agents on it. " +
  'They keep working on a schedule or when something happens, and bring the results back to you. ' +
  'Anything that sends, spends or changes what others see waits for your OK.';

/** The greeting as `agents_messages` returns it. */
export const chiefGreeting = (agentId: string, ts = 1_790_000_000_000) => ({
  id: 'greeting',
  agentId,
  ts,
  kind: 'agent' as const,
  text: CHIEF_GREETING_TEXT,
});

/**
 * `DashboardProject` (see `src/lib/project.ts`) — every field the real command
 * returns, so the dashboard renders its full card rather than a card with
 * silently-missing metadata.
 */
export const dashboardProject = (name: string, over: Partial<Record<string, unknown>> = {}) => ({
  name,
  path: `${HARNESS_ROOT}/${name}`,
  thumbnail: null,
  last_opened: Date.now() - 3_600_000,
  git_branch: 'main',
  uncommitted_count: 0,
  auto_accept_mode: false,
  hide_main_branch_warning: false,
  is_external: false,
  workspace_subpath: null,
  worktree_count: 0,
  ...over,
});

export const projects = [
  dashboardProject('acme-marketing', { uncommitted_count: 3, git_branch: 'feat/pricing-page' }),
  dashboardProject('portfolio-site', { last_opened: Date.now() - 86_400_000 }),
  dashboardProject('docs-astro', { worktree_count: 2 }),
];

const setupItem = (id: string, friendlyName: string, version?: string, username?: string) => ({
  id,
  friendlyName,
  status: 'ready' as const,
  ...(version ? { version } : {}),
  ...(username ? { username } : {}),
});

export const readySetupItems = [
  setupItem('homebrew', 'Homebrew', '4.3.0'),
  setupItem('node', 'Node.js', 'v22.11.0'),
  setupItem('git', 'Git', '2.50.1'),
  setupItem('gh', 'GitHub CLI', '2.95.0'),
  setupItem('gh_auth', 'GitHub Account', undefined, 'harness-user'),
  setupItem('claude', 'Claude Code', '2.1.0'),
  setupItem('claude_auth', 'Claude Account', undefined, 'harness-user'),
  setupItem('vercel', 'Vercel CLI', '54.21.1'),
  setupItem('vercel_auth', 'Vercel Account', undefined, 'harness-user'),
];

/** A well-formed "this commit deploys nowhere" answer — the honest default. */
export const unlinkedHostingStatus = {
  commit: {
    sha: '9f3c1ab7d2e40518c6b9a7f0d4e2c8b1a5f60937',
    short_sha: '9f3c1ab',
    subject: 'Tighten the empty-state copy',
    branch: 'main',
    has_upstream: true,
  },
  providers: [],
  detected: [],
};

/** `agents_import_*_preview` with nothing read yet (`import_export::Preview`). */
export const EMPTY_EXPORT_PREVIEW = {
  source: '',
  format: '',
  verified: true,
  agents: [] as unknown[],
  main: null as string | null,
  about: [] as [string, number][],
  problems: [] as string[],
  refused: [] as string[],
  gaps: [] as string[],
  followUp: null as string | null,
  masked: 0,
  read: [] as string[],
  skipped: [] as string[],
};

export const baseCommands: CommandMap = {
  // ---- boot gates -------------------------------------------------------
  quick_setup_check: { allPresent: true, setupCompleteCached: true },
  get_full_setup_status: {
    allReady: true,
    items: readySetupItems,
    optionalAuths: { githubAuthenticated: true },
    detectedAgents: ['claude-code'],
  },
  get_onboarding_test_mode: { mock: false, forceOnboarding: false },
  get_default_agent_id: 'claude-code',
  get_reserved_port_for_window: null,
  get_shipstudio_dir: HARNESS_ROOT,
  get_log_path: '/Users/harness/Library/Logs/ShipStudio',
  log_frontend_event: null,
  // Each view names its window (hooks/useNativeMenu).
  set_window_title: null,
  // File → New Window returns the new window's label (`window-<ms>`).
  open_new_window: 'window-1731250000000',

  // ---- dashboard --------------------------------------------------------
  get_dashboard_projects: projects,
  list_projects: projects,
  list_folders: [],
  list_pinned_projects: [],
  get_keep_dev_servers_running: true,
  get_agents_fix_previews: true,
  get_low_power_on_battery: true,
  set_low_power_on_battery: null,
  // Quiet hours on, 22:00–07:00, so Settings shows the times.
  agents_quiet_hours: { start: 22 * 60, end: 7 * 60 },
  agents_set_quiet_hours: null,
  // The morning brief as it starts: on, 08:00, nothing on a quiet day.
  agents_morning_brief: { on: true, at: 8 * 60, always: false },
  agents_set_morning_brief: (args: Record<string, unknown>) => ({
    on: args.on,
    at: args.at,
    always: args.always,
    checks: args.checks ?? [],
  }),
  agents_preview_fix_state: null,
  agents_dev_server_exited: null,
  get_compact_workspace_toolbar_enabled: false,
  // Both default-on in the product, so captures show what people actually see.
  get_element_breadcrumb_enabled: true,
  get_commit_attribution_enabled: true,
  get_team_sharing_enabled: true,
  get_analytics_enabled: true,
  get_automatic_report_status: {
    enabled: false,
    configured: false,
    reason: 'development_build',
    receipts: [],
  },
  get_issue_report_context: {
    appVersion: '1.4.0',
    operatingSystem: 'macOS',
    architecture: 'aarch64',
    defaultAgent: 'Claude Code',
  },
  // The harness's `?theme=` param overrides this (fakeBackend.ts).
  get_app_theme: 'dark',
  set_app_theme: null,
  // `null` is the real third state here: never asked. The toggle then reflects
  // default-on, and the explainer runs before the first capture.
  get_thumbnails_enabled: null,
  get_projects_root: `${HARNESS_ROOT}`,
  is_custom_projects_root: false,
  check_ide_availability: { vscode: true, cursor: false },

  // ---- workspaces (accounts) --------------------------------------------
  list_accounts: [
    {
      id: 'default',
      name: 'Default',
      color: '#6b7280',
      isDefault: true,
      createdAt: 1_750_000_000_000,
      projectsRoot: null,
    },
  ],
  get_active_account_id: 'default',

  // ---- CLI status --------------------------------------------------------
  check_github_cli_status: { installed: true, authenticated: true },
  check_claude_cli_status: { installed: true, version: '2.1.0' },

  // ---- agents -------------------------------------------------------------
  // Base layer: the nav badge subscribes to the agents store on every screen.
  agents_busy: 0,
  // A project window's sidebar lists only the agents bound to folders.
  agents_with_projects: [],
  agents_overview: {
    engineReady: true,
    agents: [
      {
        id: 'chief',
        name: 'Chief of Staff',
        role: 'Runs the other agents and keeps track of what’s in flight.',
        shape: 5,
        color: 'white',
        // What `ensure_main` gives a new Chief: the app's mark on Graphite.
        colorway: 'graphite',
        icon: 'mogbot',
        isMain: true,
        pinned: false,
        hidden: false,
        sessionId: null,
        createdAt: 1_790_000_000_000,
        lastActivityAt: 1_790_000_000_000,
        preview: null,
        unread: 0,
        pendingApprovals: 0,
        model: null,
        muted: false,
        engine: 'claude',
        status: { state: 'idle', activity: null, since: null },
      },
    ],
    engines: [
      {
        id: 'claude',
        label: 'Claude Code',
        installed: true,
        signedIn: true,
        models: [
          { value: 'opus', label: 'Opus' },
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'haiku', label: 'Haiku' },
        ],
      },
    ],
    // What a fresh install's overview carries (`agents::defaults::view_of`):
    // nothing chosen, so new agents start on the ready engine at its default.
    // Without it Settings → Agents drew no "What agents run on" section, and
    // ⌘K "What new agents run on…" landed on the top of the page.
    defaults: {
      engine: null,
      models: { claude: null, codex: null, opencode: null },
      startsOn: 'claude',
      model: null,
    },
  },
  // A new Chief opens on its stored greeting (`agents::ensure_main`).
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'chief' ? [chiefGreeting('chief')] : [],
  agents_search: [],
  // Every agent has its one conversation until it's given another.
  agents_conversations: onlyFirst,
  agents_conversation_select: onlyFirst,
  // No conversation has a living page until an agent pins one (`agents/page.rs`).
  agents_page: null,
  // The palette sweep now starts in Agents, where ⌘K → Apps opens this.
  agents_apps_list: { connected: [] },
  agents_app_connections: { apps: [], connections: [], flows: [] },
  // The "When…" composer's apps: ours first (`agents::connections`).
  agents_connections: [],
  // Edit agent's "What it can reach", and ⌘K → "Set up logins for agents…".
  agents_reach: {
    connections: [],
    browser: { on: true, sites: [], helperInstalled: true },
    secrets: [],
    blockedApps: [],
  },
  agents_logins_team: { needs: [], done: 0, total: 0 },
  agents_logins_declined: [],
  // Settings → Agents, "Disk space": plenty free, no large home (hidden).
  agents_disk_overview: {
    freeBytes: 210_000_000_000,
    level: 'fine',
    lowBytes: 15_000_000_000,
    floorBytes: 5_000_000_000,
    homes: [],
  },
  agents_disk_free_up: { bytes: 0, removed: 0, kept: 0, busy: false },
  agents_logins_recheck: null,
  agents_login_reopen: null,
  agents_logins_undecline: 0,
  agents_login_not_needed: {
    keys: ['gmail'],
    line: 'Not connecting Gmail. No agent will ask for it again.',
    closed: 1,
  },
  agents_logins_not_needed: {
    keys: ['linkedin'],
    line: 'Not connecting LinkedIn. No agent will ask for it again.',
    closed: 1,
  },
  // Edit agent's "What it can do", and Settings → Independence → What agents can
  // do (`agents/policy.rs`): a Balanced team, as `fixtures.gen.ts` has it.
  agents_policy: (args: Record<string, unknown>) => ({
    ...BALANCED_VIEW,
    agentId: typeof args.agentId === 'string' ? args.agentId : '',
  }),
  agents_policy_team: BALANCED_TEAM,
  agents_policy_set: null,
  // Edit agent's "Skills" (`agents/skills_learn.rs`): Ask me, none yet.
  agents_skills: (args: Record<string, unknown>) => ({
    agentId: typeof args.agentId === 'string' ? args.agentId : '',
    setting: 'ask',
    skills: [],
  }),
  agents_skill_edit: (args: Record<string, unknown>) => ({
    slug: args.slug,
    name: args.name,
    when: args.when,
    steps: args.steps,
  }),
  agents_skill_remove: null,
  // "What can it do on its own?" (`agents/on_its_own.rs`). Narrowing answers
  // the same view without the item it took away.
  agents_on_its_own: onItsOwnFor,
  agents_on_its_own_team: TEAM_ON_ITS_OWN,
  agents_on_its_own_narrow: (args: Record<string, unknown>) => {
    const view = onItsOwnFor(args);
    const taken = JSON.stringify(args.narrow);
    return {
      ...view,
      items: view.items.filter((i) => !i.narrow.some((n) => JSON.stringify(n) === taken)),
    };
  },
  agents_usage: {
    week: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      pricedTurns: 0,
      durationMs: 0,
    },
    allTime: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      pricedTurns: 0,
      durationMs: 0,
    },
  },
  // No engine has reported its plan: no usage line anywhere (agents::quota).
  agents_quota: [],
  // ⌘K "Open logs": Finder opens the folder; the app says so in a toast.
  agents_open_logs: '/Users/sam/Library/Logs/Mogbot',
  // Usage wallets (agents::wallet::AccountView): only this Mac's own sign-ins,
  // unnamed, so each is shown as who it is signed in as (or as this Mac's
  // own when its engine doesn't record who).
  agents_accounts: [
    {
      id: 'default',
      engine: 'claude',
      name: 'sam@example.com',
      named: false,
      email: 'sam@example.com',
      thisMac: true,
      signedIn: true,
      out: false,
    },
    {
      id: 'default',
      engine: 'codex',
      name: 'Signed in on this Mac',
      named: false,
      thisMac: true,
      signedIn: true,
      out: false,
    },
  ],
  // The capacity inventory (agents::inventory::Inventory): Normal, this Mac's
  // own sign-ins with no reading yet, no history to estimate from, nothing else
  // installed, and an empty spare-capacity list.
  agents_usage_overview: {
    mode: 'normal',
    engines: [
      {
        id: 'claude',
        label: 'Claude Code',
        installed: true,
        signedIn: true,
        agents: 1,
        nextAccount: 'This Mac',
        allOut: false,
      },
      {
        id: 'codex',
        label: 'Codex',
        installed: true,
        signedIn: true,
        agents: 0,
        nextAccount: 'This Mac',
        allOut: false,
      },
    ],
    accounts: [
      {
        engine: 'claude',
        id: 'default',
        name: 'This Mac',
        thisMac: true,
        signedIn: true,
        out: false,
        next: true,
        windows: [],
        learned: [],
      },
      {
        engine: 'codex',
        id: 'default',
        name: 'This Mac',
        thisMac: true,
        signedIn: true,
        out: false,
        next: true,
        windows: [],
        learned: [],
      },
    ],
    local: [],
    spare: [],
    backlog: [],
    agents: [],
    routines: [],
    now: 0,
  },
  agents_set_usage_mode: null,
  // When every account of an engine is out (`agents::crossover::View`):
  // never chosen (ask first), nobody carrying on elsewhere.
  agents_crossover: { claude: 'ask', codex: 'ask', away: [] },
  agents_set_crossover: (args: Record<string, unknown>) => ({
    claude: args.engine === 'claude' ? args.mode : 'ask',
    codex: args.engine === 'codex' ? args.mode : 'ask',
    away: [],
  }),
  // How much agents do on their own (`agents::independence`): never chosen.
  agents_independence: 'judgement',
  agents_set_independence: (args: Record<string, unknown>) => args.level,
  agents_set_import_choice: (args: Record<string, unknown>) => args.choice,
  // Admins (`agents::admin`): nothing done yet, nobody deleted.
  agents_set_admin: (args: Record<string, unknown>) => ({ id: args.agentId, admin: args.admin }),
  agents_admin_activity: [],
  agents_recently_deleted: [],
  agents_restore: null,
  agents_spare_add: { id: 'h1', text: 'x', addedBy: 'you', addedAt: 0, state: 'waiting' },
  agents_spare_remove: null,
  agents_focus: null,
  agents_phone_signin_status: null,
  agents_phone_signin_stop: null,
  // The agents' own browser: on, Chrome here, the phone's Google sign-in
  // permissions not yet given (`AgentsBrowserSettings`).
  // Claude in Chrome (`agentBrowser.ts`): off, as it ships; Claude Code is
  // signed in and nothing else is done yet.
  agents_browser_status: {
    enabled: false,
    ready: false,
    account: 'robin@example.com',
    browsers: 0,
    codexAgents: 0,
    steps: [
      {
        id: 'claude_code',
        done: true,
        title: 'Claude Code, signed in with your Claude account',
        detail: 'Signed in (robin@example.com).',
      },
      {
        id: 'extension',
        done: false,
        title: 'Add Claude in Chrome to Chrome',
        detail:
          'Anthropic’s extension. It lets your agents use the sites you’re signed in to, as you; it never sees your passwords.',
      },
    ],
  },
  // "Check what your team can reach" (`access_check::run`): no setup list
  // with anything open, so it reached nothing, as the backend answers then.
  agents_access_check: 0,
  // "Your Chrome" (`AgentsUserChromeSettings`): off, as it ships.
  agents_user_chrome_status: {
    supported: true,
    enabled: false,
    listening: false,
    error: null,
    chromeInstalled: true,
    host: 'missing',
    steps: {
      chrome: true,
      host: false,
      files: false,
      developerMode: null,
      loadedIn: null,
      turnedOff: false,
      otherFolder: false,
      connected: false,
    },
    extensionDir: null,
    extensionVersion: '0.1.0',
    webStoreUrl: null,
    extensionId: 'acpipahophpoekcmokoejnkooedofagk',
    browsers: [],
    updateNeeded: false,
    management: { machine: [], profiles: [] },
    route: { route: 'none', why: 'not_set_up' },
  },
  agents_user_chrome_set_enabled: {
    supported: true,
    enabled: true,
    listening: true,
    error: null,
    chromeInstalled: true,
    host: 'current',
    steps: {
      chrome: true,
      host: true,
      files: true,
      developerMode: null,
      loadedIn: null,
      turnedOff: false,
      otherFolder: false,
      connected: false,
    },
    extensionDir: '/Users/you/Library/Application Support/App/chrome-extension',
    extensionVersion: '0.1.0',
    webStoreUrl: null,
    extensionId: 'acpipahophpoekcmokoejnkooedofagk',
    browsers: [],
    updateNeeded: false,
    management: { machine: [], profiles: [] },
    route: { route: 'none', why: 'your_chrome_not_connected' },
  },
  // "Slack" (`AgentsSlackSettings`): not connected, as it ships.
  agents_slack_status: {
    connected: false,
    enabled: false,
    needsSignIn: false,
    conversations: [],
    trigger: 'mogbot:',
    defaultTrigger: 'mogbot:',
    othersCanStart: false,
    waiting: 0,
    setupUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
  },
  agents_slack_conversations: [],
  agents_slack_check_now: {
    connected: false,
    enabled: false,
    needsSignIn: false,
    conversations: [],
    trigger: 'mogbot:',
    defaultTrigger: 'mogbot:',
    othersCanStart: false,
    waiting: 0,
    setupUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
  },
  agents_user_chrome_show_extension: null,
  agents_user_chrome_open_extensions_page: null,
  agents_user_chrome_add_from_store: null,
  agents_agent_browser_status: {
    compiled: true,
    enabled: true,
    chromeInstalled: true,
    running: false,
    permissions: { screenRecording: false, accessibility: false },
  },
  agents_agent_browser_set_enabled: {
    compiled: true,
    enabled: false,
    chromeInstalled: true,
    running: false,
    permissions: { screenRecording: false, accessibility: false },
  },
  agents_agent_browser_permission: {
    compiled: true,
    enabled: true,
    chromeInstalled: true,
    running: false,
    permissions: { screenRecording: true, accessibility: false },
  },
  // Rooms: none until someone makes one (`./agentsRooms`).
  agents_rooms: [],
  agents_room_focus: null,
  agents_mark_unread: null,
  // From import::import_prompt in src-tauri/src/agents/import.rs, for a Chief called Chief of Staff.
  agents_import_prompt:
    "Move my agents to the app I just connected you to. Use its import_conversation tool to talk to my Chief of Staff there, and answer its questions about each agent you run for me until it says the import is ready for me to review. Don't send passwords, API keys or card numbers: the app asks me for those itself.",
  // connector::Gate: nothing armed, no import going.
  agents_import_talk: { armed: false, talk: null },
  // team_setup::view(): no import to finish setting up (`./agentsTeamSetup`).
  agents_team_setup: null,
  agents_team_setup_step: null,
  agents_team_setup_routine: null,
  agents_team_setup_dismiss: null,
  agents_team_setup_reopen: null,
  agents_import_talk_arm: { armed: true, talk: null },
  agents_import_talk_stop: false,
  // review::Applied for one new agent.
  agents_import_review_apply: {
    agents: ['Finance'],
    replaced: [],
    skipped: [],
    chiefNotes: false,
    routinesRefused: [],
  },

  // Copied from PROMPT in src-tauri/src/agents/import_export.rs.
  agents_import_export_prompt:
    'I\'m moving to a new app on my computer and I want to bring everything you do for me. Please give me a complete copy: every agent, bot or persona you run for me (including the main one that manages the others), and everything you know about me that they need.\n\nReply with ```json code blocks in exactly this shape:\n\n{\n  "source": "your product\'s name, e.g. Grok Bot",\n  "part": 1,\n  "parts": 1,\n  "agents": [\n    {\n      "name": "the agent\'s name",\n      "role": "one line: what it does",\n      "is_main": false,\n      "instructions": "its full instructions or system prompt, word for word",\n      "memory": ["everything it remembers that it still needs, one fact each"],\n      "routines": [{ "when": "every weekday at 9am", "what": "what it does then" }],\n      "watches": [{ "when": "an invoice email arrives", "what": "what it does then" }],\n      "apps": [{ "name": "Gmail", "purpose": "what it uses it for" }],\n      "logins": [{ "name": "Stripe", "purpose": "reads invoices", "kind": "api_key" }],\n      "preferences": ["how I like this agent\'s work done, one each"],\n      "context": ["people, projects and facts it works with, one each"]\n    }\n  ],\n  "about_me": {\n    "people": ["everyone you know about: name, who they are to me, what\'s open with them"],\n    "tasks": ["every ongoing task or project: where it stands, the next step, deadlines"],\n    "preferences": ["every standing rule or preference I gave you, word for word"],\n    "accounts": ["every account, app and tool you use for me, by name, and what for"],\n    "personal": ["saved facts: family, home, vehicles, money, dates that matter"],\n    "threads": ["conversations still open: what was asked, what you promised, what\'s waiting"]\n  },\n  "complete": false\n}\n\nRules:\n- Include every agent, each in full. Copy instructions and memory word for word: don\'t summarize or shorten. Long is fine.\n- Set "is_main": true on the one that manages the others (at most one).\n- "routines": everything it does on a schedule, with the exact time ("every monday at 8:30am", "every 2 hours", "every month on the 1st at 9am"). "watches": everything it does when something happens. Use [] for none, so I know there are none.\n- Fill every list in "about_me", or [] if there\'s truly nothing.\n- Never include passwords, API keys, tokens or card numbers: name the login in "logins" instead, and write [removed] where one appeared in any text.\n- Valid JSON only: straight double quotes, \\n for line breaks inside text, no comments, no trailing commas.\n- If it\'s long, split it into parts ("part": 1, "parts": 3, ...), each a whole ```json block in the same shape, never splitting one agent. Send the next part when I say "continue".\n- Set "complete": true in the last part only when nothing at all is left out.',
  agents_import_text_preview: EMPTY_EXPORT_PREVIEW,
  agents_import_file_preview: EMPTY_EXPORT_PREVIEW,
  agents_import_text_review: { chiefId: 'chief', requestId: 'export-review', agents: 0 },
  agents_import_file_review: { chiefId: 'chief', requestId: 'export-review', agents: 0 },
  // Share an agent as a recipe (`agents/recipe.rs`).
  agents_recipe_preview: recipePreviewFor,
  agents_recipe_save: null,
  // The other app isn't on this machine: its tab and palette command stay hidden.
  agents_other_app_preview: null,
  agents_other_app_exists: false,
  agents_other_app_import: {
    created: [],
    updated: [],
    skipped: [],
    routinesSet: [],
    routinesRefused: [],
    appName: 'Ship Studio',
    already: [],
    routinesPaused: 0,
    messages: 0,
    secretsLeft: [],
    rulesKept: [],
    rulesLeft: [],
    filesSkipped: [],
  },

  // ---- surfaces reachable from anywhere -----------------------------------
  // These live in the base layer, not the workspace layer: Help, Skills, MCP
  // and friends open from the dashboard as well as from inside a project, and
  // a fixture that only exists in one context white-screens the other.
  get_shell_path: '/bin/zsh',
  resolve_cli_path: { path: '/opt/homebrew/bin/gh', dir: '/opt/homebrew/bin' },
  // ---- feature surfaces ---------------------------------------------------
  // Empty collections are a real backend answer ("nothing configured yet"),
  // not invented data — the distinction the harness cares about is between
  // "a state we chose" and "a value we made up". A scenario that needs these
  // populated overrides them explicitly.
  get_backups: [],
  get_css_variables: [],
  get_conflict_info: [],
  list_attached_libraries: [],
  // Remote access off on a machine without Tailscale — the first-run state.
  get_remote_access_status: remoteStatus(),
  get_remote_access_brief: remoteBrief(),
  get_remote_audit: [],
  // Phone access off, nothing paired: the first-run state.
  companion_status: phoneStatus(),
  // Onboarding's phone checks: no phone on the tailnet yet; a store link's
  // QR code drawn from a fixed module matrix (the pairing fixture's).
  companion_tailnet_phones: [],
  companion_link_qr: PHONE_QR,
  // "Keep this Mac awake" (Agents): supported, not held — remote access is off.
  get_stay_on: {
    supported: true,
    keepAwake: false,
    keepRunning: false,
    openAtLogin: false,
    openAtLoginAvailable: true,
  },
  set_stay_on: {
    supported: true,
    keepAwake: true,
    keepRunning: false,
    openAtLogin: false,
    openAtLoginAvailable: true,
  },
  close_to_background: false,
  // Settings → General's GPU row; the modal was never captured before.
  get_terminal_gpu_enabled: true,
  // The quit guard: nothing working, so ⌘Q asks the plain question.
  agents_quit_check: { working: [], waiting: [], scheduled: [] },
  agents_keep_running_in_background: null,
  // Settings → General: menu-bar icon and quick message, following Keep running (off).
  agents_desktop_settings: {
    supported: true,
    menuBarIcon: false,
    quickEntry: false,
    shortcut: 'Alt+Space',
    shortcutLabel: '⌥Space',
  },
  list_claude_skills: [],
  list_env_files: [],
  list_mcp_servers: [],
  get_shopify_store: null,
  // False = this project isn't linked to Vercel, matching the unlinked default
  // the rest of these fixtures describe.
  has_vercel_config: false,
  get_default_base_branch: 'main',
  get_branch_prefix_preference: false,
  get_i18n_status: {
    framework: 'nextjs-app',
    supported: true,
    unsupported_reason: null,
    configured: false,
    locales: [],
    default_locale: null,
    config_file: null,
    parse_warning: null,
    agent_setup_available: true,
  },

  // ---- side-effecting commands -------------------------------------------
  // Answered inertly so a capture run can invoke them safely. Nothing here
  // touches the machine — the whole IPC layer is fake — but they are grouped
  // separately so it stays obvious which commands would do something real.
  open_in_ide: null,
  open_in_finder: null,
  pull_and_merge: null,
  clear_project_cache: null,
  unregister_external_pty: null,
  pty_session_detach: null,
  register_external_project: null,
  set_compact_workspace_toolbar_enabled: null,
  fetch_community_templates: '[]',
  // Keep public issue submission inert in the general harness. A scenario
  // that explicitly wants to capture a result supplies its own fixture.
  submit_github_issue: () => {
    throw new Error('Public GitHub issue submission is disabled in the harness.');
  },
  // Both `Result<(), CommandError>` on the Rust side, so `null` over IPC.
  // Reached only by the palette sweep — `devserver.stop` and
  // `preview.toggleElementBreadcrumb` are the two commands nothing else
  // invokes, so they were the last two captures still badged incomplete.
  stop_static_server: null,
  set_element_breadcrumb_enabled: null,
  // `Result<(), CommandError>`; leaving Preview now tears down the project's
  // preview proxy along with its dev server.
  stop_preview_proxy: null,

  // ---- agents -------------------------------------------------------------
  get_agents_status: [
    {
      // The backend's agent id (`setup/agents.rs`), not the engine id 'claude'.
      id: 'claude-code',
      displayName: 'Claude Code',
      binaryName: 'claude',
      installed: true,
      version: '2.1.0',
      authed: true,
      authEmail: 'harness@example.com',
      needsReconnect: false,
      isDefault: true,
      installSupported: true,
      uninstallSupported: true,
    },
    {
      id: 'codex',
      displayName: 'Codex',
      binaryName: 'codex',
      installed: false,
      version: null,
      authed: false,
      authEmail: null,
      needsReconnect: false,
      isDefault: false,
      installSupported: true,
      uninstallSupported: true,
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      binaryName: 'opencode',
      installed: false,
      version: null,
      authed: false,
      authEmail: null,
      needsReconnect: false,
      isDefault: false,
      installSupported: true,
      uninstallSupported: true,
    },
  ],

  // ---- dashboard chrome toggles -------------------------------------------
  get_slack_cta_hidden: false,
  get_spotify_widget_enabled: false,
  get_filed_project_paths: [],
  get_github_username: 'harness-user',

  // ---- telemetry ----------------------------------------------------------
  // Swallowed deliberately: the harness must never emit real analytics.
  track_event: null,
  identify_user: null,

  // ---- workspace credentials ----------------------------------------------
  get_account_credential_status: {
    claudeAuthEmail: 'harness@example.com',
    codexAuthEmail: null,
    opencodeAuthEmail: null,
    githubAuthEmail: 'harness@example.com',
    vercelUsername: null,
    hasAnthropicBaseUrl: false,
    hasVercelToken: false,
    hasCloudflareApiToken: false,
    hasNetlifyAuthToken: false,
    hasGitName: true,
    hasGitEmail: true,
    keychainUnavailable: false,
  },

  // ---- git --------------------------------------------------------------
  get_current_branch: 'main',
  git_is_repository: true,
  check_git_has_changes: false,
  list_branches: [
    {
      name: 'main',
      is_current: true,
      is_remote: false,
      is_default: true,
      last_commit_date: Date.now(),
      last_commit_author: 'Harness User',
      ahead_of_main: 0,
      behind_main: 0,
    },
  ],

  // ---- hosting ----------------------------------------------------------
  get_hosting_status: unlinkedHostingStatus,
  detect_hosting_links: [],
};
