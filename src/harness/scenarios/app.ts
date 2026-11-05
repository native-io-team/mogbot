/**
 * Whole-app scenarios: the states a reviewer most often needs to *see* and
 * which are otherwise expensive to reach (a fresh machine, an empty account,
 * a wedged setup check).
 */

import type { Scenario } from '../types';
import { projects, readySetupItems } from './base';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

const notInstalled = (id: string, friendlyName: string) => ({
  id,
  friendlyName,
  status: 'not_installed' as const,
});

/** A machine with nothing on it. */
const ONBOARDING_FRESH = {
  quick_setup_check: { allPresent: false, setupCompleteCached: false },
  get_full_setup_status: {
    allReady: false,
    items: [
      notInstalled('homebrew', 'Package Manager'),
      notInstalled('node', 'Node.js'),
      notInstalled('git', 'Git'),
      notInstalled('gh', 'GitHub CLI'),
      notInstalled('gh_auth', 'GitHub Account'),
      notInstalled('claude', 'Claude Code'),
      notInstalled('claude_auth', 'Claude Account'),
      notInstalled('codex', 'Codex'),
      notInstalled('codex_auth', 'Codex Account'),
    ],
    optionalAuths: { githubAuthenticated: false },
    detectedAgents: [],
  },
  get_onboarding_test_mode: { mock: true, forceOnboarding: false },
  get_default_agent_id: null,
};

/** Claude Code installed and signed in; no project tools at all. */
const ENGINE_ONLY_ITEMS = [
  ...ONBOARDING_FRESH.get_full_setup_status.items.filter(
    (i) => i.id !== 'claude' && i.id !== 'claude_auth'
  ),
  ...readySetupItems.filter((i) => i.id === 'claude' || i.id === 'claude_auth'),
];

/** Onboarding on a machine where only an engine is set up: straight to the hand-off. */
const ONBOARDING_ENGINE_ONLY = {
  quick_setup_check: { allPresent: false, setupCompleteCached: false },
  get_full_setup_status: {
    // The engine has just turned ready inside onboarding (the launch check said
    // not ready, so onboarding is what opened); its own check then finds it.
    allReady: false,
    items: ENGINE_ONLY_ITEMS,
    optionalAuths: { githubAuthenticated: false },
    detectedAgents: ['claude-code'],
  },
  get_onboarding_test_mode: { mock: false, forceOnboarding: false },
  get_default_agent_id: 'claude-code',
  set_default_agent_id: null,
  mark_setup_complete: null,
};

/** Set up (an engine), but none of what a project needs. */
const PROJECT_TOOLS_MISSING = {
  get_full_setup_status: {
    allReady: true,
    items: ENGINE_ONLY_ITEMS,
    optionalAuths: { githubAuthenticated: false },
    detectedAgents: ['claude-code'],
  },
  ensure_agent_workdir: '/Users/harness/ShipStudio',
};

export const appScenarios: Scenario[] = [
  {
    id: 'dashboard',
    startOn: 'projects',
    requires: '.project-card',
    title: 'Dashboard — the normal case',
    looksRightWhen:
      'Projects render as cards with readable names, consistent spacing, and no placeholder or "undefined" text anywhere.',
    commands: {},
  },
  {
    id: 'dashboard-settings-menu',
    startOn: 'projects',
    title: 'Dashboard — Preferences menu',
    looksRightWhen:
      "The Preferences row opens a compact menu with App Settings, Report Bug, Feature Request, and What's New; the bug row uses the shared BugReportIcon.",
    openSelector: '[data-education-id="settings-button"]',
    requires: '.ss-dropdown__menu.settings-menu',
    clipSelector: '.ss-dropdown__menu.settings-menu',
    commands: {},
  },
  {
    id: 'workspace-settings-menu',
    title: 'Workspace — Settings menu',
    looksRightWhen:
      "The bottom-left Settings & Help control opens the same compact menu with App Settings, Report Bug, Feature Request, and What's New; the bug row uses the shared BugReportIcon.",
    project: WORKSPACE_PROJECT,
    openSelector: '[aria-label="Settings & Help"]',
    requires: '.ss-dropdown__menu.settings-menu',
    clipSelector: '.ss-dropdown__menu.settings-menu',
    commands: { ...workspaceCommands },
  },
  {
    id: 'dashboard-cards-collapsed',
    startOn: 'projects',
    requires: '.dashboard-disclosure',
    title: 'Dashboard — the card stack folded away',
    looksRightWhen:
      'Workspace accounts, Preferences and Tools on this Mac read as three identical summary ' +
      'rows: same height, same padding, each with its chevron pointing down at the same x. ' +
      'No card has a gap below its heading where a body used to be, and the headings are as ' +
      'bright as every other heading on the page.',
    // All three shut, which is the state that shows whether they actually
    // match. Nobody has to scroll to compare them.
    storage: {
      'shipstudio.dashboard.workspaceAccountsExpanded': '0',
      'shipstudio.dashboard.preferencesExpanded': '0',
      'shipstudio.dashboard.machineToolsExpanded': '0',
    },
    commands: {},
  },
  {
    id: 'dashboard-empty',
    startOn: 'projects',
    // Without this the scenario photographed the three projects from the base
    // fixture: the dashboard reads `get_dashboard_projects`, and only the two
    // commands beside it were being emptied. `requires` now names the CTA, so
    // a fixture that fails to empty the list fails the run instead of quietly
    // certifying a populated grid as the empty state.
    requires: '.empty-state-action',
    title: 'Dashboard — no projects yet',
    looksRightWhen:
      'A deliberate empty state with a clear primary action, not a blank panel or a stuck spinner.',
    commands: {
      get_dashboard_projects: [],
      list_projects: [],
      get_projects: [],
      get_pinned_projects: [],
    },
  },
  {
    id: 'dashboard-many',
    startOn: 'projects',
    // `.project-card` alone was satisfied by the base fixture's three cards, so
    // this claimed to hold at 24 while photographing 3. Requiring the tenth
    // card means the crowd has to actually be there.
    requires: '.project-card:nth-of-type(10)',
    title: 'Dashboard — a crowded account',
    looksRightWhen:
      'Layout holds at 24 projects: no overflow past the container, no clipped names, scrolling works.',
    commands: {
      get_dashboard_projects: Array.from({ length: 24 }, (_, i) => ({
        name: `project-${String(i + 1).padStart(2, '0')}`,
        path: `/Users/harness/ShipStudio/project-${i + 1}`,
        thumbnail: null,
      })),
      list_projects: Array.from({ length: 24 }, (_, i) => ({
        name: `project-${String(i + 1).padStart(2, '0')}`,
        path: `/Users/harness/ShipStudio/project-${i + 1}`,
        thumbnail: null,
      })),
      get_projects: Array.from({ length: 24 }, (_, i) => ({
        name: `project-${String(i + 1).padStart(2, '0')}`,
        path: `/Users/harness/ShipStudio/project-${i + 1}`,
        thumbnail: null,
      })),
    },
  },
  {
    id: 'dashboard-long-names',
    startOn: 'projects',
    requires: '.project-card',
    title: 'Dashboard — hostile project names',
    looksRightWhen:
      'Very long and non-Latin names truncate cleanly instead of breaking the card grid.',
    commands: {
      get_dashboard_projects: [
        {
          name: 'a-deliberately-extremely-long-project-name-that-should-truncate-rather-than-overflow',
          path: '/Users/harness/ShipStudio/long',
          thumbnail: null,
        },
        { name: '日本語のプロジェクト名', path: '/Users/harness/ShipStudio/jp', thumbnail: null },
        { name: 'emoji-🚀-project', path: '/Users/harness/ShipStudio/emoji', thumbnail: null },
        ...projects,
      ],
      list_projects: [
        {
          name: 'a-deliberately-extremely-long-project-name-that-should-truncate-rather-than-overflow',
          path: '/Users/harness/ShipStudio/long',
          thumbnail: null,
        },
        { name: '日本語のプロジェクト名', path: '/Users/harness/ShipStudio/jp', thumbnail: null },
        { name: 'emoji-🚀-project', path: '/Users/harness/ShipStudio/emoji', thumbnail: null },
        ...projects,
      ],
    },
  },
  {
    id: 'dashboard-calendar',
    startOn: 'projects',
    title: 'Dashboard — with the GitHub contributions calendar',
    looksRightWhen:
      'The calendar sits in the dashboard without pushing anything off-screen. Note: it fetches GitHub directly, so under the hermetic capture run it renders its failed/empty state and may differ between runs.',
    commands: { get_calendar_hidden: false },
  },
  {
    id: 'onboarding-fresh',
    title: 'Onboarding — nothing installed',
    looksRightWhen:
      'No product wordmark. “Your own team of AI agents”, three numbered lines on how it works (talk to your Chief of Staff; it puts agents together; risky things wait for your Allow), one line that agents run on this computer with your own AI account, and two cards only — Claude Code (“Claude, by Anthropic”) and Codex (“GPT, by OpenAI”) — each “Not installed”. No developer tools, no hosting, no classic-onboarding toggle.',
    requires: '.agent-pick-grid',
    commands: ONBOARDING_FRESH,
  },
  {
    id: 'onboarding-codex-prereqs',
    title: 'Onboarding — Codex on a bare machine',
    looksRightWhen:
      'Codex’s setup: a line saying Codex needs the package manager and Node.js first, then four rows in order (Package Manager, Node.js, Codex, Codex Account), the first one starting by itself and the rest waiting their turn. “← Choose a different one” above.',
    openSelector: '.agent-pick-card:nth-child(2)',
    requires: '.agent-setup-detail',
    commands: { ...ONBOARDING_FRESH, mock_mark_setup_item_ready: null },
  },
  {
    id: 'onboarding-auth-only',
    title: 'Onboarding — installed but signed out',
    looksRightWhen:
      'Both cards read “Sign-in needed”; nothing else (developer tools, hosting) is asked about.',
    requires: '.agent-pick-grid',
    commands: {
      quick_setup_check: { allPresent: true, setupCompleteCached: false },
      get_full_setup_status: {
        allReady: false,
        items: [
          ...readySetupItems.map((i) =>
            i.id.endsWith('_auth')
              ? { ...i, status: 'not_authenticated' as const, username: undefined }
              : i
          ),
          { id: 'codex', friendlyName: 'Codex', status: 'ready' as const, version: '0.166.0' },
          { id: 'codex_auth', friendlyName: 'Codex Account', status: 'not_authenticated' as const },
        ],
        optionalAuths: { githubAuthenticated: false },
        detectedAgents: [],
      },
      get_onboarding_test_mode: { mock: true, forceOnboarding: false },
    },
  },
  {
    id: 'onboarding-handoff',
    title: 'Onboarding — the end: hand-off to the Chief of Staff',
    looksRightWhen:
      'Claude Code was already set up on this machine, and nothing else was (no Node, no Git): onboarding goes straight to the hand-off. The Chief’s badge, “You’re all set”, “Claude Code is connected. Your Chief of Staff is waiting for you.” and one button, “Meet your Chief of Staff”. No rocket, no “dev environment”.',
    requires: '.celebration-screen',
    commands: ONBOARDING_ENGINE_ONLY,
  },
  {
    id: 'onboarding-end-to-agents',
    title: 'Onboarding — after the hand-off, Agents with the Chief',
    looksRightWhen:
      'Agents mode, not the projects dashboard: the Chief of Staff selected in the sidebar, its chat open on the greeting, with the three starters under it and the composer ready.',
    steps: [{ click: '.celebration-btn' }],
    requires: '.agents-mode .agent-chat__messages > .agent-chat__starters',
    commands: ONBOARDING_ENGINE_ONLY,
  },
  {
    id: 'launch-returning',
    title: 'Launch — a returning user lands on Agents',
    looksRightWhen:
      'Setup done before: the app opens on Agents with the Chief of Staff’s conversation, not on the projects dashboard. The sidebar top row is the toggle and a bell (What’s in flight); its foot has the Phone row (“Put it on your phone”) and no Remote access row. Projects is one click away in the toggle.',
    requires: '.agents-mode .agent-chat',
    commands: {},
  },
  {
    id: 'project-tools',
    title: 'Projects — the first new project asks for its tools',
    looksRightWhen:
      'Only Claude Code was set up, so New project opens “Before your first project”: one line on why, a plain list of what’s missing (a package manager, Node.js, Git, GitHub’s tool, a GitHub sign-in, each said in plain words), a line that Claude Code installs them and this computer checks each one, and Not now / Set them up.',
    startOn: 'projects',
    openSelector: '[data-education-id="new-project-button"]',
    requires: '.project-tools-modal .project-tools__list',
    commands: PROJECT_TOOLS_MISSING,
  },
  {
    id: 'project-tools-running',
    title: 'Projects — the agent installs the project tools',
    looksRightWhen:
      'After Set them up: the dialog widens; the scripted agent session on the left, the checklist on the right (Claude Code ready, the tools still pending), saying the app checks each one itself.',
    startOn: 'projects',
    openSelector: '[data-education-id="new-project-button"]',
    steps: [{ click: '.project-tools__actions .button:last-child' }],
    requires: '.project-tools-modal.is-running .agent-guided-phase',
    commands: {
      ...PROJECT_TOOLS_MISSING,
      get_onboarding_test_mode: { mock: true, forceOnboarding: false },
    },
  },
];
