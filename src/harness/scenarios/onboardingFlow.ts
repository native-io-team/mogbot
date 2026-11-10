/**
 * Onboarding, one screen at a time: every screen of the line (Welcome, then
 * the engine's own screens) and every way each check can fail. A scenario
 * opens on its screen the way a relaunch does (the saved step), so each is
 * reachable without clicking through.
 *
 * All names, accounts and addresses here are fictional.
 */

import type { Scenario } from '../types';
import { readySetupItems } from './base';
import { neverAnswers, rejectsWith } from '../reject';
import { FLOW_STORAGE_KEY, type FlowStep } from '../../lib/onboardingFlow';
import type { MockFailure } from '../../lib/installProgress';
import { remoteStatus } from './remote';
import { phoneStatus } from './phone';
import { gateWith } from './agents';
import { PHONE_PAIRING_LINK, PHONE_QR } from '../fixtures/phoneQr';

const at = (step: FlowStep) => ({
  [FLOW_STORAGE_KEY]: JSON.stringify({ v: 1, step, finished: false }),
});

const missing = (id: string, friendlyName: string) => ({
  id,
  friendlyName,
  status: 'not_installed' as const,
});

const FRESH_ITEMS = [
  missing('homebrew', 'Package Manager'),
  missing('node', 'Node.js'),
  missing('git', 'Git'),
  missing('claude', 'Claude Code'),
  missing('claude_auth', 'Claude Account'),
  missing('codex', 'Codex'),
  missing('codex_auth', 'Codex Account'),
];

/** Onboarding opened (launch said not ready), with these items. */
const machine = (items: unknown[], mock = false, mockFailure: MockFailure | null = null) => ({
  quick_setup_check: { allPresent: false, setupCompleteCached: false },
  get_full_setup_status: {
    allReady: false,
    items,
    optionalAuths: { githubAuthenticated: false },
    detectedAgents: [],
  },
  get_onboarding_test_mode: { mock, forceOnboarding: false, mockFailure },
  get_default_agent_id: null,
  set_default_agent_id: null,
  mark_setup_complete: null,
  mock_mark_setup_item_ready: null,
});

/**
 * An install or sign-in still going. The mock action flips the item after
 * a beat; a fixture that answers at once let the capture land after it,
 * on "closed before it finished", which is a different screen.
 */
const STILL_GOING = { mock_mark_setup_item_ready: neverAnswers() };

/** Claude Code installed and signed in, nothing else. */
const ENGINE_READY = machine([
  ...FRESH_ITEMS.filter((i) => i.id !== 'claude' && i.id !== 'claude_auth'),
  ...readySetupItems.filter((i) => i.id === 'claude' || i.id === 'claude_auth'),
]);

/** Claude Code installed, not signed in. */
const CLAUDE_INSTALLED = FRESH_ITEMS.map((i) =>
  i.id === 'claude' ? { ...i, status: 'ready', version: '2.1.0' } : i
);

/** Homebrew there (by the app's check), Node.js and Codex not: Codex's screen is Node.js. */
const HOMEBREW_ONLY = FRESH_ITEMS.map((i) => (i.id === 'homebrew' ? { ...i, status: 'ready' } : i));

const flow = (
  id: string,
  step: FlowStep,
  title: string,
  looksRightWhen: string,
  commands: Record<string, unknown>,
  extra: Partial<Scenario> = {}
): Scenario => ({
  id,
  title: `Onboarding — ${title}`,
  looksRightWhen,
  storage: at(step),
  requires: `[data-flow-step="${step}"]`,
  ...extra,
  commands: { ...ENGINE_READY, ...commands },
});

/**
 * Each way an install or sign-in can fail, played by the mock
 * (`SHIPSTUDIO_FORCE_INSTALL_FAILURE`) through the same parsing as a real
 * run, so the line and the fix are the ones a real failure gets.
 */
function installFailures(): Scenario[] {
  const CODEX_NEXT = FRESH_ITEMS.map((i) =>
    i.id === 'homebrew' || i.id === 'node' ? { ...i, status: 'ready' } : i
  );
  const failing = (
    id: string,
    title: string,
    looksRightWhen: string,
    items: unknown[],
    failure: MockFailure,
    card: string,
    open = false
  ) =>
    flow(id, 'engine', title, looksRightWhen, machine(items, true, failure), {
      steps: [
        { click: card },
        { focus: '.flow-check[data-state="fail"]' },
        ...(open ? [{ click: '[data-install-details-toggle]' }] : []),
      ],
      requires: open
        ? '.install-details__panel[data-open="true"]'
        : '[data-flow-step="engine"] .flow-check[data-state="fail"]',
    });
  const claude = '.agent-pick-card';
  const codex = '.agent-pick-card:nth-child(2)';
  return [
    failing(
      'onboarding-install-offline',
      '2a. Install failed: offline',
      '"Install Claude Code", an amber-marked check: "Not done yet. Couldn’t reach the download server." and "Check this Mac is online (open any website), then press Try again.", "Show details" under it, and a big "Try again". Nothing about reopening the app.',
      FRESH_ITEMS,
      'network',
      claude
    ),
    failing(
      'onboarding-install-disk-full',
      '2a. Install failed: disk full',
      '"Not done yet. This Mac is out of disk space." and "Free up at least 1 GB (empty the Bin, or delete large downloads), then press Try again.", then "Show details" and "Try again".',
      FRESH_ITEMS,
      'disk',
      claude
    ),
    failing(
      'onboarding-install-failed-details',
      '2a. Install failed, Show details open',
      'The disk-full failure with "Hide details ⌃" open: a recessed mono panel with what the installer really printed, ending in "…no space left on device". The check above still says the cause in plain words.',
      FRESH_ITEMS,
      'disk',
      claude,
      true
    ),
    failing(
      'onboarding-install-permission',
      '2a. Codex install failed: permission',
      '"Install Codex", "Codex · 1 of 2" (Homebrew and Node.js were already here), "Not done yet. This Mac didn’t let the install write the files it needs." and a fix that names the way out (an administrator, or Claude Code, which needs none), "Show details" and "Try again".',
      CODEX_NEXT,
      'permission',
      codex
    ),
    failing(
      'onboarding-install-not-admin',
      '2a. Homebrew failed: not an administrator',
      '"Get your Mac ready for Codex", "Not done yet. Your Mac account isn’t allowed to install apps." and the fix: an administrator account, or ask whoever manages this Mac (System Settings → Users & Groups).',
      FRESH_ITEMS,
      'admin',
      codex
    ),
    failing(
      'onboarding-install-no-homebrew',
      '2a. Node.js failed: Homebrew missing',
      '"Get your Mac ready for Codex" on its Node.js screen, "Not done yet. Homebrew isn’t on this Mac, and Node.js installs with it." and "Press Try again: it installs Homebrew first." (Try again opens Homebrew’s own screen, then comes back here).',
      HOMEBREW_ONLY,
      'homebrew',
      codex
    ),
    failing(
      'onboarding-signin-failed',
      '2b. Sign-in failed',
      '"Sign in to Claude Code", "Not done yet. The sign-in page was closed before it finished.", the fix naming the Claude Pro or Max plan, "Show details" and "Try again".',
      CLAUDE_INSTALLED,
      'signin',
      claude
    ),
  ];
}

/*
 * The two optional parts after the engine, a screen per step. Each reads
 * only the app's own checks (remote access status, the import's state, phone
 * access status, the tailnet's phones, the phone's request).
 */
const MIN_MS = 60_000;
const TS = {
  state: 'connected',
  dnsName: 'studio-mac.tail1234.ts.net',
  login: 'julian@example.com',
};
const REMOTE_ON = {
  enabled: true,
  serverRunning: true,
  tailscale: TS,
  funnelOn: true,
  linkMasked: 'https://studio-mac.tail1234.ts.net/mogbot/••••••••',
  reachability: { state: 'reachable' },
};
const remote = (over: Record<string, unknown> = {}) => ({
  get_remote_access_status: remoteStatus(over),
  set_remote_access_enabled: remoteStatus({ ...REMOTE_ON, reachability: null }),
  republish_remote_link: remoteStatus(over),
  copy_remote_link: null,
});
const PHONE_ON = {
  enabled: true,
  running: true,
  serve: { state: 'on', url: 'https://studio-mac.tail1234.ts.net:47443' },
};
const phone = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  companion_status: phoneStatus({ tailscale: TS, ...over }),
  companion_tailnet_phones: [],
  companion_retry_tailscale: phoneStatus({ tailscale: TS, ...over }),
  companion_set_enabled: phoneStatus({ tailscale: TS, ...PHONE_ON }),
  companion_pair_start: {
    link: PHONE_PAIRING_LINK,
    qr: PHONE_QR,
    expiresAt: Date.now() + 5 * MIN_MS,
  },
  companion_pair_decide: null,
  ...extra,
});
const REQUEST = {
  id: 'pr_1',
  device: {
    name: 'Sam’s iPhone',
    platform: 'ios',
    model: 'iPhone 16 Pro',
    appVersion: '1.0.0',
    build: 'official',
  },
  requestedAt: Date.now() - 20_000,
  codeHint: '5D2Q',
  login: 'julian@example.com',
  replaces: [],
};

function optionalParts(): Scenario[] {
  return [
    flow(
      'onboarding-agents-ask',
      'agentsAsk',
      '3. Bring your agents?',
      'The bar on its third part, "Your agents". "Bring your agents from another assistant?", one line (Grok, ChatGPT, Claude… carry on here; nothing created until you say so), a big "Bring my agents" (focused) and a quiet "Not now". Back.',
      {}
    ),
    flow(
      'onboarding-agents-tailscale',
      'agentsTailscale',
      '3a. Tailscale on this Mac (missing)',
      '"Turn on Tailscale on this Mac", one line, an amber "Not done yet. Tailscale isn’t on this Mac yet." with its fix (install, sign in, Allow the VPN configuration) and Check again; a big "Get Tailscale for Mac ↗" and "Skip for now". The third segment part-filled.',
      remote({ tailscale: { state: 'notInstalled' } })
    ),
    flow(
      'onboarding-agents-tailscale-done',
      'agentsTailscale',
      '3a. Tailscale on this Mac (done)',
      'The same screen with a green-ticked "Done. Tailscale is on, signed in as julian@example.com." and a big Continue.',
      remote({ tailscale: TS })
    ),
    flow(
      'onboarding-agents-link',
      'agentsLink',
      '3b. Turn on remote access',
      '"Turn on remote access", one line (it lets your assistant reach your agents; the Mac stays awake, keep it plugged in), a big "Turn it on", Skip for now.',
      remote({ tailscale: TS })
    ),
    flow(
      'onboarding-agents-link-funnel',
      'agentsLink',
      '3b. The link needs Funnel switched on',
      'An amber "Not done yet. Tailscale needs your OK to let your assistant in." with the fix (turn on Funnel on the Tailscale page), "Open the Tailscale page ↗" (which takes focus, so Enter opens it and never skips) and Check again. No big button.',
      remote({
        tailscale: TS,
        enabled: true,
        serverRunning: true,
        funnelApprovalUrl: 'https://login.tailscale.com/f/funnel?node=n1',
      })
    ),
    flow(
      'onboarding-agents-link-live',
      'agentsLink',
      '3b. The link is live',
      'A green-ticked "Done. Remote access is on." and a big Continue.',
      remote(REMOTE_ON)
    ),
    flow(
      'onboarding-agents-connect',
      'agentsConnect',
      '3c. Add the link to your assistant',
      '"Add the link to your assistant", one line (a custom connector, maybe called MCP, named Mogbot; then ask what your agents are doing), a big "Copy the link", a muted line that the link is a secret, Skip for now.',
      remote(REMOTE_ON)
    ),
    flow(
      'onboarding-agents-connect-waiting',
      'agentsConnect',
      '3c. Copied, waiting for the assistant',
      'After Copy the link: the button reads "Copied. Copy again" and a "Waiting for your assistant to connect…" line with a spinner.',
      remote(REMOTE_ON),
      { steps: [{ click: '[data-flow-primary]' }], requires: '.flow-check[data-state="checking"]' }
    ),
    flow(
      'onboarding-agents-start',
      'agentsStart',
      '3d. Start the import',
      '"Start the import", one line (one import may begin; you see the plan before anything is created), a big "Start the import", Skip for now.',
      {
        ...remote({ ...REMOTE_ON, everConnected: true }),
        agents_import_talk: gateWith(null),
        agents_import_prompt:
          'Hi! I’m moving my agents to Mogbot. Please call import_conversation and tell it about each agent you run for me…',
        agents_import_talk_arm: gateWith(null, true),
      }
    ),
    flow(
      'onboarding-agents-started',
      'agentsStart',
      '3d. The assistant asked to start',
      '"Grok is ready to bring your agents", one line (OK it in the Chief of Staff’s chat next, choose which come over), a green-ticked "Done. Grok is asking to start the import." and a big Continue; no message box, and no title promising one.',
      {
        ...remote({ ...REMOTE_ON, everConnected: true }),
        agents_import_talk: gateWith({ state: 'awaiting_consent' }),
        agents_import_prompt: 'Hi!',
      }
    ),
    flow(
      'onboarding-phone-ask',
      'phoneAsk',
      '4. Use your agents from your phone?',
      'The bar on "Your phone". "Use your agents from your phone?", one line (chat, answer and approve; only to this Mac, through Tailscale on both; about five minutes), a big "Set up my phone" and a quiet "Not now".',
      {}
    ),
    flow(
      'onboarding-phone-app',
      'phoneGetApp',
      '4a. Get the app',
      '"Get Mogbot on your phone", one line (a free beta on TestFlight; point the iPhone\u2019s camera at the code), the TestFlight link\u2019s QR code, a big "Get it on TestFlight ↗", an outlined "I have it", Skip for now. No tick.',
      phone()
    ),
    flow(
      'onboarding-phone-mac-tailscale',
      'phoneMacTailscale',
      '4b. Tailscale on this Mac (done)',
      '"Turn on Tailscale on this Mac" with a green-ticked "Done. Tailscale is on, signed in as julian@example.com." and a big Continue.',
      phone()
    ),
    flow(
      'onboarding-phone-phone-tailscale',
      'phonePhoneTailscale',
      '4c. Tailscale on your phone, same account',
      '"Turn on Tailscale on your phone", the line naming julian@example.com and the VPN prompt, "Looking for your phone on your Tailscale…", App Store ↗ / Google Play ↗, a big "I did it".',
      phone()
    ),
    flow(
      'onboarding-phone-phone-tailscale-done',
      'phonePhoneTailscale',
      '4c. A phone on your Tailscale',
      'A green-ticked "Done. Sam’s iPhone is on your Tailscale." and a big Continue.',
      phone({}, { companion_tailnet_phones: [{ name: 'Sam’s iPhone', os: 'ios', online: true }] })
    ),
    flow(
      'onboarding-phone-access',
      'phoneAccess',
      '4d. Turn on phone access',
      '"Turn on phone access", one line (this Mac has to stay on), a big "Turn on phone access".',
      phone()
    ),
    flow(
      'onboarding-phone-scan',
      'phoneScan',
      '4e. The code, big and alone',
      'The title is the phone’s own words, "On your phone, open Mogbot and tap Scan the code", then the QR large on white paper in a soft card, "Works once, for 5:00" under it, Skip for now. Nothing else on the screen.',
      phone({ ...PHONE_ON, pairing: { active: true, expiresAt: Date.now() + 5 * MIN_MS } })
    ),
    flow(
      'onboarding-phone-allow',
      'phoneScan',
      '4f. Allow the phone that used it',
      '"Allow Sam’s iPhone?", one line (only the phone in your hand, code ending 5D2Q), the device line, a big neutral Allow (never the accent) and a quiet Deny.',
      phone({ ...PHONE_ON, pairing: { active: false, request: REQUEST } }),
      { requires: '[data-flow-step="phoneAllow"]' }
    ),
    flow(
      'onboarding-phone-paired',
      'phoneScan',
      '4g. Paired',
      'After Allow: a large green-ringed tick that springs in, "Paired", "Sam’s iPhone can reach your agents now. Try it…", and a big "Go to your Chief of Staff". No Back.',
      phone({ ...PHONE_ON, pairing: { active: false, request: REQUEST } }),
      {
        steps: [{ click: '[data-flow-step="phoneAllow"] [data-flow-primary]' }],
        requires: '[data-flow-step="phonePaired"]',
      }
    ),
  ];
}

export const onboardingFlowScenarios: Scenario[] = [
  {
    id: 'onboarding-fresh',
    title: 'Onboarding — 1. Welcome',
    looksRightWhen:
      'Full screen, no Back. The progress bar at the top: three thin segments, the first bright, "Welcome" under it. A large "Your own team of AI agents", one sentence on what it is, a quiet "About five minutes", and one big "Get started" with a visible focus ring (Enter starts).',
    requires: '[data-flow-step="welcome"]',
    commands: machine(FRESH_ITEMS, true),
  },
  flow(
    'onboarding-engine-pick',
    'engine',
    '2. Pick Claude Code or Codex',
    'Back on the left, the second of three segments lit, "Your AI". "Which AI should your agents run on?", one line, then the two engine cards (Claude Code recommended and focused, so Enter picks it; Codex), each ending "Install & sign in →".',
    machine(FRESH_ITEMS, true)
  ),
  flow(
    'onboarding-codex-prereqs',
    'engine',
    '2a. Codex on a bare Mac: get the Mac ready first',
    'After choosing Codex: "Get your Mac ready for Codex", one line naming Homebrew and Node.js (a few minutes, maybe the Mac password), "Codex · 1 of 4", the steps "Getting ready to install Homebrew…" (spinner) then "Downloading and installing Homebrew" and "Checking it works" dimmed, and a bordered box: "Homebrew’s installer needs your Mac password", a hint saying what Homebrew is and that the password goes straight to the installer and isn’t kept, a masked field (focused) and a neutral "Continue". "Show details" and a quiet "Cancel" at the foot. No terminal window.',
    { ...machine(FRESH_ITEMS, true), ...STILL_GOING },
    {
      steps: [
        { click: '.agent-pick-card:nth-child(2)' },
        { focus: '[data-install-ask="password"] input' },
      ],
      requires: '[data-install-ask="password"]',
    }
  ),
  flow(
    'onboarding-engine-install',
    'engine',
    '2a. Install Claude Code: downloading',
    'One screen, no terminal window: "Install Claude Code", one line (it downloads and installs, a minute or two), "Claude Code · 1 of 2", then a bordered list of three steps: "Downloading Claude Code…" with a spinner, "Installing" and "Checking it works" dimmed with a dot. Under it "Show details ⌄" on the left, a quiet "Cancel" on the right. No big button and no Back while it runs.',
    { ...machine(FRESH_ITEMS, true), ...STILL_GOING },
    { steps: [{ click: '.agent-pick-card' }], requires: '[data-install-phase="download"]' }
  ),
  flow(
    'onboarding-engine-installing',
    'engine',
    '2a. Install Claude Code: installing',
    'The same screen a moment later: "Downloading Claude Code" ticked green, "Installing…" with the spinner, "Checking it works" still dimmed. Moved on by the installer’s own "Setting up Claude Code" line, not a timer.',
    { ...machine(FRESH_ITEMS, true), ...STILL_GOING },
    {
      steps: [{ click: '.agent-pick-card' }, { focus: '[data-install-phase="install"]' }],
      requires: '[data-install-phase="install"]',
    }
  ),
  flow(
    'onboarding-engine-checking',
    'engine',
    '2a. Install Claude Code: the app checks it works',
    'The installer has exited: both earlier steps ticked, "Checking it works…" with the spinner, and no Cancel (the app’s own check is running, nothing to stop).',
    { ...machine(FRESH_ITEMS, true), ...STILL_GOING },
    {
      steps: [{ click: '.agent-pick-card' }, { focus: '[data-install-phase="check"]' }],
      requires: '[data-install-phase="check"]',
    }
  ),
  flow(
    'onboarding-engine-details',
    'engine',
    '2a. Install Claude Code: Show details open',
    'The downloading screen with "Hide details ⌃" open: a recessed, rounded panel under it in the mono font with the real lines so far ("Downloading the Claude Code installer…", the progress bar), readable in this theme. The steps above are unchanged.',
    { ...machine(FRESH_ITEMS, true), ...STILL_GOING },
    {
      steps: [
        { click: '.agent-pick-card' },
        { focus: '[data-install-phase="install"]' },
        { click: '[data-install-details-toggle]' },
      ],
      requires: '.install-details__panel[data-open="true"]',
    }
  ),
  flow(
    'onboarding-engine-closed',
    'engine',
    '2a. Install cancelled before it finished',
    '"Install Claude Code", then a bordered check with an amber mark: "Not done yet. The install was closed before it finished." and nothing under it (no line repeating the button), the box as tight at the bottom as at the top, a "Show details" for what it printed, and a big "Try again".',
    machine(FRESH_ITEMS, true),
    {
      steps: [
        { click: '.agent-pick-card' },
        { click: '[data-install-cancel]' },
        { focus: '.flow-check[data-state="fail"]' },
      ],
      requires: '[data-flow-step="engine"] .flow-check[data-state="fail"]',
    }
  ),
  ...installFailures(),
  flow(
    'onboarding-engine-failed',
    'engine',
    '2a. Install failed: Not done yet',
    'A failure the app’s status reported (no run here to show): "Install Claude Code", then a bordered check with an amber mark: "Not done yet. Couldn’t reach the download server.", "Check this Mac is online (open any website), then press Try again.", no "Show details" (nothing was printed here), and the big button says "Try again".',
    machine(
      FRESH_ITEMS.map((i) =>
        i.id === 'claude'
          ? {
              ...i,
              status: 'error',
              errorMessage: 'Couldn’t reach the download server (network timeout).',
            }
          : i
      ),
      true
    ),
    {
      steps: [{ click: '.agent-pick-card' }],
      requires: '[data-flow-step="engine"] .flow-check[data-state="fail"]',
    }
  ),
  flow(
    'onboarding-engine-signin',
    'engine',
    '2b. Sign in to Claude Code',
    'Installed already, so the screen is the sign-in: "Sign in to Claude Code", one line (sign-in opens in your browser; this screen notices when you’re done), "Claude Code · 2 of 2", the steps "Opening sign-in in your browser" ticked, "Waiting for you to sign in…" with a spinner, "Checking you’re signed in" dimmed, then "No sign-in page, or closed it by mistake?" beside "Open the sign-in page again ↗".',
    { ...machine(CLAUDE_INSTALLED, true), ...STILL_GOING },
    {
      steps: [{ click: '.agent-pick-card' }, { focus: '[data-install-phase="browser"]' }],
      requires: '[data-install-open-signin]',
    }
  ),
  flow(
    'onboarding-engine-connected',
    'engine',
    '2. Engine already set up: Done',
    '"Claude Code is connected", a green-ticked "Done. Claude Code is installed and signed in.", a big "Continue" (focused: Enter goes on) and a quiet "Use a different one". The bar has five parts: Your AI is current, then Your agents, Your phone and Your Chief of Staff.',
    {}
  ),
  flow(
    'onboarding-engine-pick-small',
    'engine',
    '2. Pick an engine, in a small window',
    'At 800×600 the same screen fits without a horizontal scroll: Back, the bar, the question and both engine cards (side by side or stacked), each card’s “Install & sign in →” reachable.',
    machine(FRESH_ITEMS, true),
    { viewport: { width: 800, height: 600 } }
  ),
  flow(
    'onboarding-status-failed',
    'engine',
    '2. This Mac couldn’t be checked',
    'The engine choice as usual, and pinned at the foot the same check every screen uses: an amber mark, "Not done yet. Couldn’t check this Mac." and one "Check again" (no red box, no "Try again" said twice). Nothing else blocks; the cards still work.',
    { get_full_setup_status: rejectsWith('network unreachable') }
  ),
  ...optionalParts(),
];
