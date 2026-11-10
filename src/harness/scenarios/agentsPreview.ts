/**
 * Preview beside the chat, and "Test it" (`components/agents/AgentPreviewPane`,
 * `agents/preview_test.rs`): Acme Site's copy card opens a pane with the copy
 * running in it (a fictional site the harness serves on its port + 1), the
 * pane while the site is starting, a test under way with its steps and
 * screenshots beside the frame, and the card after the report (v2, broken).
 * Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { rejectsWith } from '../reject';
import { HARNESS_ROOT } from './base';
import { workspaceCommands } from './workspace';
import {
  AGENTS_TAB,
  CHAT_COLUMN,
  MIN,
  TEAM,
  messagesFor,
  msg,
  now,
  overview,
  status,
} from './agents';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;
const COPY = {
  id: 'copy_pricing',
  path: `${HARNESS_ROOT}/.worktrees/acme-marketing/acme-site-pricing-cards-9f2c`,
  branch: 'acme-site/pricing-cards-9f2c',
};

const shot = (dir: string, name: string) => ({
  name,
  path: `attachments/${dir}/${name}`,
  mime: 'image/jpeg',
  size: 20_000,
});
const BEFORE = shot('m-res1', 'before.jpg');
const AFTER = shot('m-res1', 'after.jpg');

const FILES = [
  { path: 'src/components/PricingTable.tsx', status: 'modified', added: 38, removed: 12 },
  { path: 'src/styles/pricing.css', status: 'modified', added: 21, removed: 4 },
  { path: 'src/components/PricingCard.tsx', status: 'added', added: 64 },
];

const RESULT = {
  id: 'res-pricing',
  version: 1,
  title: 'Pricing cards on mobile',
  summary:
    'The three plans now stack below 640px, and the “Most popular” badge sits beside the plan name instead of over the price.',
  items: [
    { kind: 'file', file: BEFORE, role: 'before' },
    { kind: 'file', file: AFTER, role: 'after' },
  ],
  checked: ['pnpm build passes'],
  notVerified: ['Safari on a real iPhone'],
};

const CHANGES = {
  project: ACME_PATH,
  from: 'base-tree',
  to: 'copy-tree',
  files: FILES,
  fileCount: FILES.length,
  added: 123,
  removed: 16,
  copy: COPY,
};

const STEPS = [
  { kind: 'open', label: 'Opened /', ok: true, ts: now - 3 * MIN },
  { kind: 'console', label: 'Checked the console: no errors', ok: true, ts: now - 3 * MIN + 4_000 },
  { kind: 'click', label: 'Clicked “See pricing”', ok: true, ts: now - 3 * MIN + 9_000 },
  {
    kind: 'shot',
    label: 'Pricing page',
    ok: true,
    ts: now - 3 * MIN + 14_000,
    shot: shot('m-att1', 'Pricing on mobile.jpg'),
  },
  { kind: 'viewport', label: 'Switched to phone width', ok: true, ts: now - 2 * MIN },
  { kind: 'click', label: 'Clicked “Sign up”', ok: true, ts: now - 2 * MIN + 6_000 },
  { kind: 'note', label: 'Sign up opens a page that doesn’t exist', ok: false, ts: now - MIN },
  {
    kind: 'shot',
    label: 'Sign up page',
    ok: true,
    ts: now - MIN + 5_000,
    shot: shot('m-att1', 'Footer links.jpg'),
  },
];

const REPORT = {
  outcome: 'broken',
  summary:
    'The cards stack properly at phone width and every plan reads well. Both “Sign up” buttons go to /signup, which isn’t there yet.',
  broken: [
    '“Sign up” on Starter and Team opens /signup, which shows “This page doesn’t exist yet”',
  ],
  consoleErrors: ['GET http://localhost:3104/signup 404 (Not Found)'],
  steps: STEPS,
  onCopy: true,
};

const COPY_CARD = msg('changes', `Changed ${FILES.length} files in a copy of acme-marketing`, 24, {
  agentId: 'acme',
  id: 'res-copy',
  attachments: [BEFORE, AFTER],
  result: RESULT,
  changes: CHANGES,
});

const BASE_CHAT = [
  msg('user', 'The pricing cards overlap on mobile. Can you fix it and show me?', 30, {
    agentId: 'acme',
  }),
  msg('agent', 'Fixed, with a before and after from the phone preview.', 24, { agentId: 'acme' }),
  COPY_CARD,
];

const TESTING_CHAT = [...BASE_CHAT, msg('user', 'Test it in the preview', 4, { agentId: 'acme' })];

const TESTED_CHAT = [
  ...TESTING_CHAT,
  msg('changes', REPORT.summary, 0.5, {
    agentId: 'acme',
    id: 'run-pricing',
    attachments: STEPS.flatMap((s) => (s.shot ? [s.shot] : [])),
    result: {
      ...RESULT,
      version: 2,
      changes: 'Tested it in the preview: 1 thing is broken',
      test: REPORT,
    },
    changes: CHANGES,
  }),
  msg('agent', 'Tested it: the pricing cards are right, but Sign up goes nowhere yet.', 0.4, {
    agentId: 'acme',
  }),
];

const team = (acmeState: 'idle' | 'working') =>
  overview(
    TEAM.map((a) =>
      a.id === 'acme'
        ? {
            ...a,
            project: ACME_PATH,
            status: status(acmeState, acmeState === 'working' ? 'Testing in the preview' : null),
            copy: {
              ...COPY,
              project: ACME_PATH,
              base: 'a1b2c3',
              baseBranch: 'main',
              createdAt: now - 30 * MIN,
              deps: true,
            },
          }
        : a
    )
  );

/** The site the harness serves for this, one port above its own. */
const sitePort = () => Number(window.location.port || 1425) + 1;

const target = (running: boolean) => () => ({
  agentId: 'acme',
  messageId: 'res-copy',
  path: COPY.path,
  project: ACME_PATH,
  copy: true,
  port: sitePort(),
  running,
  title: 'Pricing cards on mobile',
});

const RUN = {
  id: 'run-pricing',
  agentId: 'acme',
  messageId: 'res-copy',
  path: COPY.path,
  project: ACME_PATH,
  copy: true,
  title: 'Pricing cards on mobile',
  startedAt: now - 4 * MIN,
  state: 'running',
  steps: STEPS,
};

const pane = (chat: unknown[], over: Record<string, unknown> = {}) => ({
  agents_overview: team('idle'),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'acme' ? chat : messagesFor(args),
  agents_preview_target: target(true),
  agents_preview_attach: null,
  agents_preview_test_state: null,
  agents_preview_test_start: RUN,
  agents_preview_test_stop: true,
  // No proxy here: the frame loads the fictional site directly.
  start_preview_proxy: rejectsWith('The harness has no preview proxy.'),
  list_pages: [
    { route: '/', file_path: 'src/app/page.tsx' },
    { route: '/pricing', file_path: 'src/app/pricing/page.tsx' },
  ],
  probe_preview_status: 200,
  ...over,
});

/** The copy's dev server starts, then exits with a compile error (the PTY stub). */
const STOPS = { 'harness:pty-exit': '1' };

/** The pane on a copy whose server stopped by itself, and where its fix stands. */
const stoppedPane = (phase: 'fixing' | 'ask' | null, over: Record<string, unknown> = {}) =>
  pane(BASE_CHAT, {
    agents_preview_target: target(false),
    agents_dev_server_exited: null,
    // What starting it asks for, as a workspace open does (`./workspace`).
    find_and_reserve_port: workspaceCommands.find_and_reserve_port,
    get_workspace_subpath: workspaceCommands.get_workspace_subpath,
    detect_project_type_command: workspaceCommands.detect_project_type_command,
    get_force_static_serve: workspaceCommands.get_force_static_serve,
    check_dependencies_installed: workspaceCommands.check_dependencies_installed,
    get_dev_server_consent: workspaceCommands.get_dev_server_consent,
    detect_package_manager: workspaceCommands.detect_package_manager,
    plan_pending_install_scripts: workspaceCommands.plan_pending_install_scripts,
    read_project_file: workspaceCommands.read_project_file,
    get_system_env: workspaceCommands.get_system_env,
    agents_preview_fix_state: () =>
      phase && {
        path: COPY.path,
        agentId: 'acme',
        agentName: 'Acme Site',
        phase,
        reason: 'a compile error',
        at: Date.now(),
      },
    ...over,
  });

const OPEN_ACME = { click: '[data-agent-id="acme"]' };
const PRESS_PREVIEW = { click: '.agent-changes button', text: 'Preview' };
/** Wait for the site's first page to load in the frame (a step waits; `requires` doesn't). */
const SITE_LOADED = { hover: '.agent-preview__iframe[data-loaded]' };

export const agentsPreviewScenarios: Scenario[] = [
  {
    id: 'agents-preview-open',
    title: 'Agents — Preview on a copy card opens the site beside the chat',
    looksRightWhen:
      'The chat stays on the left (narrower), and a pane fills the right: a header with a globe, “Pricing cards on mobile” over a muted “A copy of acme-marketing”, then a neutral “Test it” button (play icon, not the agent’s colour), a ghost “Open in workspace” and an ×. Under it a toolbar: a Back arrow (disabled), the address “/” in a mono field, Reload, and a four-way width control (full / laptop / tablet / phone). The frame shows the fictional Acme Marketing home page (“Campaigns that ship on Monday…”). No steps column yet. The chat’s card is unchanged.',
    requires: '.agent-preview__iframe[data-loaded]',
    openSelector: AGENTS_TAB,
    steps: [OPEN_ACME, PRESS_PREVIEW, SITE_LOADED],
    commands: pane(BASE_CHAT),
  },
  {
    id: 'agents-column-preview',
    title: 'Agents — preview open: the narrower chat keeps one column',
    looksRightWhen:
      'With the site open beside it, the chat’s header content, its messages and its composer still share one left edge and one right edge; the header’s controls fold to icons for the narrower column rather than crowd it.',
    viewport: { width: 1280, height: 800 },
    requires: '.agent-preview__iframe[data-loaded]',
    sameColumn: CHAT_COLUMN,
    openSelector: AGENTS_TAB,
    steps: [OPEN_ACME, PRESS_PREVIEW, SITE_LOADED],
    commands: pane(BASE_CHAT),
  },
  {
    id: 'agents-preview-starting',
    title: 'Agents — the preview while the copy’s site starts',
    looksRightWhen:
      'The same pane, but instead of a frame a calm centred state: a small spinner and “Starting acme-marketing…”. No error, no progress bar, no port numbers. “Test it” is there but disabled.',
    requires: '.agent-preview[data-state="starting"]',
    openSelector: AGENTS_TAB,
    steps: [OPEN_ACME, PRESS_PREVIEW],
    commands: pane(BASE_CHAT, {
      agents_preview_target: target(false),
      // The port is still being reserved: the pane stays on "Starting…".
      find_and_reserve_port: () => new Promise(() => undefined),
    }),
  },
  {
    id: 'agents-preview-testing',
    title: 'Agents — Test it under way, each step beside the frame',
    looksRightWhen:
      'The pane with the site in it, and a steps column on its right headed by a spinner and “Testing…”: “Opened /”, “Checked the console: no errors”, “Clicked “See pricing””, “Pricing page” with a screenshot thumbnail, “Switched to phone width”, “Clicked “Sign up””, then “Sign up opens a page that doesn’t exist” marked with a red error glyph (the only red), and “Sign up page” with its thumbnail. Plain words throughout, no tool names or selectors. The header shows “Stop test” (outlined) instead of Test it. The chat on the left ends on your “Test it in the preview” message.',
    requires: '.agent-preview__iframe[data-loaded]',
    openSelector: AGENTS_TAB,
    steps: [OPEN_ACME, PRESS_PREVIEW, SITE_LOADED],
    commands: pane(TESTING_CHAT, {
      agents_overview: team('working'),
      agents_preview_test_state: RUN,
    }),
  },
  {
    id: 'agents-preview-stopped-workspace',
    title: 'Agents — the site stopped and no agent owns it: the workspace line (as before)',
    looksRightWhen:
      'The pane with no frame: a warning glyph and “The site stopped running. The workspace shows why and can start it again.” over an outlined “Open in workspace”. No agent named, no spinner. This is what every stopped preview showed before agents fixed their own.',
    requires: '.agent-preview__status:not([data-stopped]) .button',
    openSelector: AGENTS_TAB,
    storage: STOPS,
    steps: [
      OPEN_ACME,
      PRESS_PREVIEW,
      { hover: '.agent-preview__status:not([data-stopped]) .button' },
    ],
    commands: stoppedPane(null),
  },
  {
    id: 'agents-preview-stopped-fixing',
    title: 'Agents — the site stopped and Acme Site is fixing it',
    looksRightWhen:
      'The pane with no frame: a small spinner, “Acme Site is fixing it…”, and under it, muted and smaller, “The site stopped: a compile error.” Then only a quiet text link “Open in workspace” (no outlined button, no “Ask” button). Acme Site shows as working in the sidebar. Nothing red.',
    requires: '[data-stopped="fixing"]',
    openSelector: AGENTS_TAB,
    storage: STOPS,
    steps: [OPEN_ACME, PRESS_PREVIEW, { hover: '[data-stopped="fixing"]' }],
    commands: stoppedPane('fixing', { agents_overview: team('working') }),
  },
  {
    id: 'agents-preview-stopped-ask',
    title: 'Agents — the site stopped and nobody was woken: Ask Acme Site to fix it',
    looksRightWhen:
      'The pane with no frame: a warning glyph, “The site stopped: a compile error.”, a neutral filled “Ask Acme Site to fix it” button (not the agent’s colour), and under it a quiet text link “Open in workspace”. No spinner.',
    requires: '[data-stopped="ask"]',
    openSelector: AGENTS_TAB,
    storage: STOPS,
    steps: [OPEN_ACME, PRESS_PREVIEW, { hover: '[data-stopped="ask"]' }],
    commands: stoppedPane('ask'),
  },
  {
    id: 'agents-preview-reported',
    title: 'Agents — the card after the test: a new version with the report',
    looksRightWhen:
      'Acme Site’s chat: the first card folded to “Pricing cards on mobile · v1 · earlier version”; your “Test it in the preview”; then the card again with a “v2” badge and “Changes since v1: Tested it in the preview: 1 thing is broken”. Inside it, an outlined section headed by a warning glyph “Tested in the preview: broken”, the agent’s two-sentence summary, a tinted list with the one broken thing (Sign up → /signup), a muted “1 console error on the page” with the 404 line in mono, a row of two screenshot thumbnails captioned “Pricing page” and “Sign up page”, and a quiet “What it did · 8 steps” toggle. The copy’s Keep changes / Review / Preview / Discard are still on this newest card. No pane open.',
    requires: '.agent-test-report[data-outcome="broken"]',
    openSelector: AGENTS_TAB,
    steps: [OPEN_ACME],
    commands: pane(TESTED_CHAT),
  },
];
