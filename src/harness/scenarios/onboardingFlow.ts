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
import { rejectsWith } from '../reject';
import { FLOW_STORAGE_KEY, type FlowStep } from '../../lib/onboardingFlow';

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
const machine = (items: unknown[], mock = false) => ({
  quick_setup_check: { allPresent: false, setupCompleteCached: false },
  get_full_setup_status: {
    allReady: false,
    items,
    optionalAuths: { githubAuthenticated: false },
    detectedAgents: [],
  },
  get_onboarding_test_mode: { mock, forceOnboarding: false },
  get_default_agent_id: null,
  set_default_agent_id: null,
  mark_setup_complete: null,
  mock_mark_setup_item_ready: null,
});

/** Claude Code installed and signed in, nothing else. */
const ENGINE_READY = machine([
  ...FRESH_ITEMS.filter((i) => i.id !== 'claude' && i.id !== 'claude_auth'),
  ...readySetupItems.filter((i) => i.id === 'claude' || i.id === 'claude_auth'),
]);

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
    'After choosing Codex: "Get your Mac ready for Codex", one line (a few minutes, maybe the Mac password), "Codex · 1 of 4", and a spinner check saying "Installing…".',
    machine(FRESH_ITEMS, true),
    {
      steps: [{ click: '.agent-pick-card:nth-child(2)' }],
      requires: '[data-flow-step="engine"] .flow-check',
    }
  ),
  flow(
    'onboarding-engine-install',
    'engine',
    '2a. Install Claude Code, running',
    'One screen: "Install Claude Code", one line about the password, "Claude Code · 1 of 2", and a check line with a spinner saying "Installing…". No list of other steps.',
    machine(FRESH_ITEMS, true),
    { steps: [{ click: '.agent-pick-card' }], requires: '[data-flow-step="engine"] .flow-check' }
  ),
  flow(
    'onboarding-engine-failed',
    'engine',
    '2a. Install failed: Not done yet',
    '"Install Claude Code", then a bordered check with an amber mark: "Not done yet. Couldn’t reach the download server…", the fix in a line, and the big button now says "Try again".',
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
    'Installed already, so the screen is the sign-in: "Sign in to Claude Code", one line that the browser opens, "Claude Code · 2 of 2", and the check "Waiting for you to finish signing in…".',
    machine(
      FRESH_ITEMS.map((i) => (i.id === 'claude' ? { ...i, status: 'ready', version: '2.1.0' } : i)),
      true
    ),
    { steps: [{ click: '.agent-pick-card' }], requires: '[data-flow-step="engine"] .flow-check' }
  ),
  flow(
    'onboarding-engine-connected',
    'engine',
    '2. Engine already set up: Done',
    '"Claude Code is connected", a green-ticked "Done. Claude Code is installed and signed in.", a big "Meet your Chief of Staff" (focused: Enter goes on) and a quiet "Use a different one". The third segment, "Your Chief of Staff", is next.',
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
    'The engine choice as usual, and pinned at the foot a notice: "Couldn’t check this Mac. Try again." with a Try again button. Nothing else blocks; the cards still work.',
    { get_full_setup_status: rejectsWith('network unreachable') }
  ),
];
