/**
 * Onboarding, one screen at a time: every screen of the line and every way
 * each check can fail. A scenario opens on its screen the way a relaunch
 * does (the saved step), so each is reachable without clicking through.
 *
 * All names, accounts and addresses here are fictional.
 */

import type { Scenario, ScenarioStep } from '../types';
import { readySetupItems } from './base';
import { phoneStatus } from './phone';
import { remoteStatus } from './remote';
import { ANDROID_THIS_MAC, THIS_MAC } from './phoneInstall';
import { PHONE_PAIRING_LINK, PHONE_QR } from '../fixtures/phoneQr';
import { FLOW_STORAGE_KEY, type FlowStep } from '../../lib/onboardingFlow';

const DNS = 'studio-mac.tail1234.ts.net';
const LOGIN = 'sam@example.com';
const MASKED = `https://${DNS}/dashbot/mcp/3f9c••••••••`;
const MIN = 60_000;

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

const TS_ON = { state: 'connected', dnsName: DNS, login: LOGIN };
const PHONE_ON = {
  enabled: true,
  running: true,
  tailscale: TS_ON,
  serve: { state: 'on', url: `https://${DNS}:47443` },
};

const CHECK_AGAIN: ScenarioStep = { click: '[data-flow-check-again]' };

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

const REQUEST = {
  id: 'req_1',
  device: {
    name: 'Sam’s iPhone',
    platform: 'ios',
    model: 'iPhone 16',
    appVersion: '1.0.0',
    build: 'self',
  },
  requestedAt: Date.now() - 5000,
  codeHint: 'X4QK',
  login: LOGIN,
  replaces: [],
};

/** A phone asking; once Allow is pressed, it's paired. */
function pairsOnAllow() {
  let allowed = false;
  return {
    companion_status: () =>
      phoneStatus({
        ...PHONE_ON,
        pairing: allowed
          ? { active: false }
          : { active: true, expiresAt: Date.now() + 4 * MIN, request: REQUEST },
        devices: allowed
          ? [
              {
                id: 'dev_new',
                name: 'Sam’s iPhone',
                platform: 'ios',
                model: 'iPhone 16',
                appVersion: '1.0.0',
                build: 'self',
                pairedAt: Date.now(),
                lastSeenAt: Date.now(),
                lastRoute: 'tailscale',
                connected: true,
              },
            ]
          : [],
      }),
    companion_pair_decide: () => {
      allowed = true;
      return null;
    },
  };
}

export const onboardingFlowScenarios: Scenario[] = [
  {
    id: 'onboarding-fresh',
    title: 'Onboarding — 1. Welcome',
    looksRightWhen:
      'Full screen, no Back. The progress bar at the top: five thin segments, the first bright, "Welcome" under it. A large "Your own team of AI agents", one sentence on what it is, a quiet "About five minutes, or fifteen with your phone", and one big "Get started".',
    requires: '[data-flow-step="welcome"]',
    commands: machine(FRESH_ITEMS, true),
  },
  flow(
    'onboarding-engine-pick',
    'engine',
    '2. Pick Claude Code or Codex',
    'Back on the left, the second segment lit, "Your AI". "Which AI should your agents run on?", one line, then the two engine cards (Claude Code recommended, Codex), each ending "Install & sign in →".',
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
    '"Claude Code is connected", a green-ticked "Done. Claude Code is installed and signed in.", a big Continue and a quiet "Use a different one".',
    {}
  ),
  flow(
    'onboarding-accounts',
    'accounts',
    '2b. Add another account? (optional)',
    'Still the second segment, “Your AI”. “Add another account?”, one line on why (“When one account runs out of usage, agents carry on with the next, so nothing stops.”) and that it is optional. One Line: a check, “sam@example.com”, muted “Claude Code · this Mac’s own sign-in”. A big “Add a Claude Code account”, a quiet “Or a Codex account” under it, and a quiet Skip. Never “This Mac” as a name.',
    {
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
          signedIn: false,
          out: false,
        },
      ],
    },
    { requires: '[data-flow-step="accounts"] .flow-accounts__row' }
  ),
  flow(
    'onboarding-accounts-added',
    'accounts',
    '2b. Another account added',
    'Two Lines, each ticked: “sam@example.com” (Claude Code · this Mac’s own sign-in) and “Work” (Claude Code · signed in). The big button is now Continue; quiet “Add another Claude Code account” and “Add a Codex account” under the list. No Skip.',
    {
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
          id: 'a1work',
          engine: 'claude',
          name: 'Work',
          named: true,
          email: 'sam@northwind.example',
          thisMac: false,
          signedIn: true,
          out: false,
        },
      ],
    },
    { requires: '[data-flow-step="accounts"] .flow-accounts__row + .flow-accounts__row' }
  ),
  flow(
    'onboarding-independence',
    'independence',
    '3. How much agents do on their own',
    'The third segment lit. The question, one line that it applies to every agent, then the four-stop slider: “Asks a lot” and “Just does it” at its ends, stops Careful, Steady, Bold, Unleashed under the track with Steady chosen (neutral thumb, never the accent), Steady’s one line, the always-asks line, a big Continue and a quiet Skip.',
    {},
    {
      requires:
        '[data-flow-step="independence"] .independence-slider[data-level="judgement"] [role="slider"]',
    }
  ),
  flow(
    'onboarding-phone-intro',
    'phone',
    '4. Your phone?',
    'The fourth segment lit, "Your phone". "Use your agents from your phone?", one line (Tailscale, about ten minutes), a big "Set up my phone" and a quiet "Skip for now".',
    {}
  ),
  flow(
    'onboarding-tailscale-mac-missing',
    'tailscaleMac',
    '4a. Tailscale on this Mac: not installed',
    '"Your phone · 1 of 4" under the bar. "Get Tailscale on this Mac". An amber check: "Not done yet. Tailscale isn’t installed on this Mac.", the fix, a "Download Tailscale ↗" button and "Check again". A big "Get Tailscale ↗" and a quiet "Skip phone setup".',
    { companion_status: phoneStatus({ tailscale: { state: 'notInstalled' } }) }
  ),
  flow(
    'onboarding-tailscale-mac-signed-out',
    'tailscaleMac',
    '4a. Tailscale on this Mac: signed out, after Check again',
    'The check says "Not done yet. Tailscale is installed but not signed in, or switched off." with the menu-bar fix, and under it "Checked at <time>" — pressing Check again visibly answered.',
    { companion_status: phoneStatus({ tailscale: { state: 'needsLogin' } }) },
    { steps: [CHECK_AGAIN], requires: '.flow-check__when' }
  ),
  flow(
    'onboarding-tailscale-mac-done',
    'tailscaleMac',
    '4a. Tailscale on this Mac: Done',
    'A green-ticked "Done. Tailscale is on, signed in as sam@example.com." and a big Continue (it was already done on arrival, so it waits).',
    { companion_status: phoneStatus({ tailscale: TS_ON }) }
  ),
  flow(
    'onboarding-tailscale-phone-none',
    'tailscalePhone',
    '4b. Tailscale on your phone: no phone yet',
    '"Your phone · 2 of 4". "Get Tailscale on your phone", the line names sam@example.com. A QR code on the left (light paper in both themes); on the right an amber "Not done yet. No phone is on your Tailscale yet." with the exact fix and Check again, then "Android? Get it on Google Play ↗".',
    { companion_status: phoneStatus({ tailscale: TS_ON }), companion_tailnet_phones: [] }
  ),
  flow(
    'onboarding-tailscale-phone-off',
    'tailscalePhone',
    '4b. Tailscale on your phone: signed in, switched off',
    'The check names the phone: "Not done yet. Sam’s iPhone is signed in, but Tailscale is switched off on it." and "Open Tailscale on your phone and turn the switch on."',
    {
      companion_status: phoneStatus({ tailscale: TS_ON }),
      companion_tailnet_phones: [{ name: 'Sam’s iPhone', os: 'ios', online: false }],
    }
  ),
  flow(
    'onboarding-tailscale-phone-done',
    'tailscalePhone',
    '4b. Tailscale on your phone: Done',
    'Green-ticked "Done. Sam’s iPhone is on your Tailscale." and a big Continue.',
    {
      companion_status: phoneStatus({ tailscale: TS_ON }),
      companion_tailnet_phones: [{ name: 'Sam’s iPhone', os: 'ios', online: true }],
    }
  ),
  flow(
    'onboarding-phone-app',
    'phoneApp',
    '4c. Get the phone app',
    '"Your phone · 3 of 4". "Get the Dashbot app on your phone", one line that this Mac builds it (no App Store yet), two big answers "iPhone" and "Android", and a quiet "I already have the app".',
    {}
  ),
  flow(
    'onboarding-phone-app-build',
    'phoneApp',
    '4c. Build the app on this Mac',
    'After choosing iPhone: the guided build embedded in a panel — the checklist decided by the app’s own checks (Xcode, the iPhone, the Apple ID) beside the agent’s start card. "Skip phone setup" below.',
    {
      companion_status: phoneStatus({ tailscale: TS_ON }),
      companion_install_ios_status: THIS_MAC,
      companion_install_android_status: ANDROID_THIS_MAC,
    },
    { steps: [{ click: '[data-flow-primary]' }], requires: '.flow-embed' }
  ),
  flow(
    'onboarding-phone-pair-https',
    'phonePair',
    '4d. Pair: HTTPS certificates off, after Check again',
    '"Your phone · 4 of 4". "Turning on phone access". No code — instead an amber check: "Not done yet. HTTPS certificates are off in your Tailscale account.", the fix ("…click Enable HTTPS, then come back and check again"), an "Open Tailscale admin ↗" button, "Check again", and "Checked at <time>". Never a silent reload.',
    {
      companion_status: phoneStatus({
        ...PHONE_ON,
        serve: { state: 'needsApproval', url: 'https://login.tailscale.com/f/serve?node=n1' },
      }),
      companion_retry_tailscale: phoneStatus({
        ...PHONE_ON,
        serve: { state: 'needsApproval', url: 'https://login.tailscale.com/f/serve?node=n1' },
      }),
    },
    { steps: [CHECK_AGAIN], requires: '.flow-check__when' }
  ),
  flow(
    'onboarding-phone-pair-code',
    'phonePair',
    '4d. Pair: scan this code',
    'The pairing QR code with its four short steps and the countdown, "Copy link instead" and Cancel. A quiet "Skip phone setup" below.',
    {
      companion_status: phoneStatus(PHONE_ON),
      companion_pair_start: {
        link: PHONE_PAIRING_LINK,
        qr: PHONE_QR,
        expiresAt: Date.now() + 5 * MIN,
      },
    },
    { requires: '[data-testid="phone-pair-code"]' }
  ),
  flow(
    'onboarding-phone-pair-allow',
    'phonePair',
    '4d. Pair: allow your phone',
    '"Allow your phone", one line, then the confirm card: "Allow Sam’s iPhone to use your agents?", the code ending, the warning, Deny and a neutral (never accent) Allow.',
    {
      companion_status: phoneStatus({
        ...PHONE_ON,
        pairing: {
          active: true,
          expiresAt: Date.now() + 4 * MIN,
          request: {
            id: 'req_1',
            device: {
              name: 'Sam’s iPhone',
              platform: 'ios',
              model: 'iPhone 16',
              appVersion: '1.0.0',
              build: 'self',
            },
            requestedAt: Date.now() - 5000,
            codeHint: 'X4QK',
            login: LOGIN,
            replaces: [],
          },
        },
      }),
    },
    { requires: '.phone-confirm' }
  ),
  flow(
    'onboarding-phone-pair-done',
    'phonePair',
    '4d. Pair: done, and on to Ready by itself',
    'After Allow: the screen says "Done. Paired with Sam’s iPhone." and a beat later moved on by itself to the last step, "You’re ready", with the fifth segment lit.',
    {
      ...pairsOnAllow(),
    },
    {
      steps: [{ click: '[data-allow]' }],
      requires: '.flow-check[data-state="pass"], [data-flow-step="ready"]',
    }
  ),
  flow(
    'onboarding-handoff',
    'ready',
    '5. You’re ready: import or start fresh',
    'The last segment lit, "Ready". The Chief’s badge, "You’re ready", one line naming Claude Code and asking whether to bring agents from Grok, ChatGPT or another assistant, then two big neutral answers: "Bring my agents" and "Start fresh". No accent.',
    {}
  ),
  flow(
    'onboarding-import-remote-funnel',
    'importRemote',
    '5a. Remote access: Funnel off',
    '"Ready · 1 of 3". "Turn on Remote access". An amber "Not done yet. Funnel is off for this Mac in your Tailscale account.", the fix, "Open Tailscale ↗", Check again. A quiet "Start fresh instead".',
    {
      get_remote_access_status: remoteStatus({
        enabled: true,
        serverRunning: true,
        tailscale: TS_ON,
        funnelApprovalUrl: 'https://login.tailscale.com/f/funnel?node=n1',
      }),
    }
  ),
  flow(
    'onboarding-import-remote-publishing',
    'importRemote',
    '5a. Remote access: publishing the link',
    'A spinner check: "Publishing the link. The first time this can take a few minutes." No error.',
    {
      get_remote_access_status: remoteStatus({
        enabled: true,
        serverRunning: true,
        tailscale: TS_ON,
        funnelOn: true,
        linkMasked: MASKED,
        publish: { sinceMs: Date.now() - MIN, autoRetried: false, gaveUp: false },
      }),
    }
  ),
  flow(
    'onboarding-import-remote-done',
    'importRemote',
    '5a. Remote access: Done',
    'Green-ticked "Done. Remote access is on, and the internet can reach this Mac." and a big Continue.',
    {
      get_remote_access_status: remoteStatus({
        enabled: true,
        serverRunning: true,
        tailscale: TS_ON,
        funnelOn: true,
        linkMasked: MASKED,
        reachability: { state: 'reachable' },
      }),
    }
  ),
  flow(
    'onboarding-import-connect',
    'importConnect',
    '5b. Add the link to your assistant',
    '"Ready · 2 of 3". "Add the link to your assistant", one line (a custom connector named Dashbot), a note that the link is a key and never shown, a spinner "Waiting for you to copy the link…", and a big "Copy link".',
    {
      get_remote_access_status: remoteStatus({
        enabled: true,
        tailscale: TS_ON,
        funnelOn: true,
        linkMasked: MASKED,
        reachability: { state: 'reachable' },
      }),
      copy_remote_link: null,
    }
  ),
  flow(
    'onboarding-import-connect-waiting',
    'importConnect',
    '5b. Link copied, assistant not connected yet',
    'After Copy link: the button reads "Copied — copy again" (secondary), and the check says "Not done yet. Your assistant hasn’t connected yet." with the connector fix and Check again.',
    {
      get_remote_access_status: remoteStatus({
        enabled: true,
        tailscale: TS_ON,
        funnelOn: true,
        linkMasked: MASKED,
        reachability: { state: 'reachable' },
      }),
      copy_remote_link: null,
    },
    {
      steps: [{ click: '[data-flow-primary]' }],
      requires: '.flow-check[data-state="fail"]',
    }
  ),
  flow(
    'onboarding-import-start',
    'importStart',
    '5c. Send your assistant this message',
    '"Ready · 3 of 3". "Send your assistant this message", the message in its card with a Copy button, a spinner "Waiting for you to copy the message…", and "Start fresh instead".',
    {}
  ),
  flow(
    'onboarding-import-start-done',
    'importStart',
    '5c. The assistant is talking to the Chief',
    '"Your agents are on their way", one line that the Chief asks first, a green-ticked "Done. Grok is talking to your Chief of Staff." and a big "Open your Chief of Staff".',
    {
      agents_import_talk: {
        armed: false,
        talk: {
          id: 't1',
          source: 'Grok',
          chiefId: 'chief',
          state: 'awaiting_consent',
          staged: [],
          imported: [],
          conversations: 0,
        },
      },
    }
  ),
];
