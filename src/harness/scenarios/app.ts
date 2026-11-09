/**
 * Whole-app scenarios: the states a reviewer most often needs to *see* and
 * which are otherwise expensive to reach (a fresh machine, an empty account,
 * a wedged setup check).
 */

import type { Scenario } from '../types';
import { projects, readySetupItems } from './base';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';
import { messagesFor, overview } from './agents';
import { neverAnswers } from '../reject';
import { FLOW_STORAGE_KEY } from '../../lib/onboardingFlow';

/** Answers like a real backend: after a beat, not in the same tick. */
const afterABeat =
  <T>(value: T, ms = 120) =>
  () =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

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

/** Node and Git are here; only GitHub (optional) isn't. */
const PROJECT_TOOLS_GITHUB_ONLY = {
  ...PROJECT_TOOLS_MISSING,
  get_full_setup_status: {
    ...PROJECT_TOOLS_MISSING.get_full_setup_status,
    items: ENGINE_ONLY_ITEMS.map((i) =>
      i.id === 'gh' || i.id === 'gh_auth' ? i : { ...i, status: 'ready' as const }
    ),
  },
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
    title: 'Dashboard — Settings & Help',
    looksRightWhen:
      'With feedback and release notes switched off by brand.json, the row opens Settings directly; there is no menu of one item. With them on, it opens a compact menu instead.',
    openSelector: '[data-education-id="settings-button"]',
    requires: '.settings-window',
    commands: {},
  },
  {
    id: 'workspace-settings-menu',
    title: 'Workspace — Settings & Help',
    looksRightWhen:
      'The bottom-left Settings control opens Settings directly while feedback and release notes are switched off by brand.json.',
    project: WORKSPACE_PROJECT,
    openSelector: '[aria-label="Settings & Help"]',
    requires: '.settings-window',
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
    id: 'dashboard-loading',
    startOn: 'projects',
    requires: '.project-list-loading',
    title: 'Dashboard — still scanning, accounts still checking',
    looksRightWhen:
      'The projects heading has no count beside "Loading projects…" (a stale count would contradict ' +
      'it). Accounts shows one quiet "Checking sign-ins…" line, never an Engines or Services ' +
      'heading with nothing under it, and no second spinner in its header.',
    commands: {
      get_dashboard_projects: neverAnswers(),
      list_projects: neverAnswers(),
      get_agents_status: neverAnswers(),
      get_account_credential_status: neverAnswers(),
    },
  },
  {
    id: 'dashboard-accounts-checking',
    startOn: 'projects',
    requires: '.agents-panel-loading',
    clipSelector: '.agents-panel',
    title: 'Dashboard — engines known, GitHub and Vercel still checking',
    looksRightWhen:
      'Engines lists its rows; Services shows one "Checking GitHub and Vercel…" line in place of ' +
      'its rows rather than two rows reading "Checking…" beside Connect buttons that may be wrong.',
    commands: { get_account_credential_status: neverAnswers() },
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
    id: 'onboarding-auth-only',
    title: 'Onboarding — installed but signed out',
    looksRightWhen:
      'Both cards end “Sign in →”; nothing else (developer tools, hosting) is asked about.',
    requires: '.agent-pick-grid',
    storage: { [FLOW_STORAGE_KEY]: JSON.stringify({ v: 1, step: 'engine', finished: false }) },
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
    id: 'onboarding-end-to-agents',
    title: 'Onboarding — after the engine, straight to the Chief',
    looksRightWhen:
      'After “Meet your Chief of Staff” on the engine screen (the last onboarding screen): Agents mode, not the projects dashboard: the Chief of Staff selected in the sidebar, its chat open on the greeting, with the three starters and More ideas… under it and the composer ready. No phone, account or independence questions came first.',
    storage: { [FLOW_STORAGE_KEY]: JSON.stringify({ v: 1, step: 'engine', finished: false }) },
    steps: [{ click: '[data-flow-primary]' }],
    requires: '.agents-mode .agent-chat__messages > .agent-chat__starters',
    commands: ONBOARDING_ENGINE_ONLY,
  },
  {
    id: 'launch-returning',
    title: 'Launch — a returning user lands on Agents',
    looksRightWhen:
      'A real returning user, with a team and history: the app opens on Agents with the Chief of Staff’s ongoing conversation (not the first-run greeting), the team listed in the sidebar, not on the projects dashboard. The sidebar top row is the toggle and an activity icon (What’s in flight); New agent / Import agents start on the rows’ left edge. Projects is one click away in the toggle.',
    requires: '.agents-mode .agent-chat .agent-chat__messages',
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-switch',
    title: 'Agents | Projects — switching with a project open and a real backend’s latency',
    looksRightWhen:
      'Opens on Agents. Each command answers after a beat, as a real backend does, and a dev server is running for this window. The Agents | Projects switch moves on the first click every time: Projects returns to the open project’s workspace, Agents stays on Agents (it never bounces back to the workspace), and the selected segment always matches the screen.',
    requires: '.agents-mode .agent-chat',
    commands: {
      ...workspaceCommands,
      agents_overview: overview(),
      agents_messages: messagesFor,
      // A dev server is running for this window, so the backend reports its
      // reserved port, as it does after any project has been opened.
      get_reserved_port_for_window: 3000,
      ensure_external_project_registered: afterABeat(null),
      get_workspace_subpath: afterABeat('.'),
      get_auto_accept_mode: afterABeat(false),
    },
  },
  {
    id: 'project-tools',
    title: 'Projects — the first new project asks for its tools',
    looksRightWhen:
      'Only Claude Code was set up, so New project opens “Set up project tools”: one line on why, a plain list of only what’s required (a package manager, Node.js, Git, in plain words), an “Also connect GitHub — Optional” checkbox with a one-line reason, a line that Claude Code installs them and this computer checks each one, and Cancel / Set them up. The New project button showed a spinner while the check ran.',
    startOn: 'projects',
    openSelector: '[data-education-id="new-project-button"]',
    requires: '.project-tools-modal .project-tools__list',
    commands: PROJECT_TOOLS_MISSING,
  },
  {
    id: 'project-tools-github-only',
    title: 'Projects — only GitHub (optional) is missing',
    looksRightWhen:
      'Node and Git are here, so New project asks only “Connect GitHub?”: a line saying everything a project needs is here and GitHub is optional, with “Continue without” and “Connect GitHub”.',
    startOn: 'projects',
    openSelector: '[data-education-id="new-project-button"]',
    requires: '.project-tools-modal .project-tools__actions',
    commands: PROJECT_TOOLS_GITHUB_ONLY,
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
