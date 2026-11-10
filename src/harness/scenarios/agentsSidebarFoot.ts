/**
 * The Agents sidebar's foot, whole: usage first (said as what is used, its
 * bar filling with use), then New agent · New room, then Routines with the
 * phone, remote and Settings beside it. Light use, heavy use, out, no phone,
 * a phone paired, remote on, and a narrow sidebar. Built on the Agents team
 * fixture (`./agents`); every name and address is fictional.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, now, overview } from './agents';
import { phoneStatus } from './phone';
import { remoteBrief } from './remote';

const H = 3_600_000;

const ACCOUNT = {
  id: 'default',
  engine: 'claude',
  name: 'sam@example.com',
  named: false,
  thisMac: true,
  signedIn: true,
  email: 'sam@example.com',
  plan: 'Max',
  out: false,
};

function inventory(used: number, out = false) {
  return {
    mode: 'normal',
    engines: [
      {
        id: 'claude',
        label: 'Claude Code',
        installed: true,
        signedIn: true,
        agents: TEAM.length,
        nextAccount: 'sam@example.com',
        allOut: out,
      },
    ],
    accounts: [
      {
        engine: 'claude',
        id: 'default',
        name: 'sam@example.com',
        thisMac: true,
        signedIn: true,
        out,
        next: true,
        windows: [
          {
            kind: 'seven_day',
            usedPercent: used,
            resetsAt: now + 146 * H,
            limited: out,
            observedAt: now - 8 * 60_000,
          },
        ],
        learned: [],
        ...(out ? { outUntil: now + 146 * H } : {}),
      },
    ],
    local: [],
    spare: [],
    backlog: [],
    agents: [],
    routines: [],
    now,
  };
}

const PAIRED = phoneStatus({
  enabled: true,
  running: true,
  serve: { state: 'on', url: 'https://mac.example.ts.net:47443' },
  devices: [
    {
      id: 'dev_1',
      name: 'Sam’s iPhone',
      platform: 'ios',
      model: 'iPhone 16 Pro',
      appVersion: '1.0.0',
      build: 'official',
      pairedAt: now - 3 * 24 * H,
      lastSeenAt: now - 3 * H,
      lastRoute: 'tailscale',
      connected: false,
    },
  ],
});

const REMOTE_ON = remoteBrief({
  enabled: true,
  serverRunning: true,
  activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
});

function foot(
  id: string,
  title: string,
  looksRightWhen: string,
  {
    used = 8,
    out = false,
    phone = PAIRED,
    remote = remoteBrief(),
    extra = {},
  }: {
    used?: number;
    out?: boolean;
    phone?: unknown;
    remote?: unknown;
    extra?: Partial<Scenario>;
  } = {}
): Scenario {
  return {
    id,
    title,
    looksRightWhen,
    openSelector: AGENTS_TAB,
    requires: '[data-testid="account-switcher"]',
    clipSelector: '.workspace-sidebar',
    viewport: { width: 1100, height: 720 },
    ...extra,
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_accounts: [{ ...ACCOUNT, out }],
      agents_usage_overview: inventory(used, out),
      companion_status: phone,
      get_remote_access_brief: remote,
      ...(extra.commands ?? {}),
    },
  };
}

const BASE =
  'The foot, top to bottom: Usage as two lines (“N% used · refills in 6d”, then a thin bar ' +
  'that fills with use), then one row “New agent” | “New room”, then one row with Routines ' +
  'and, at its end, small icon buttons for the phone (and remote, when on) and Settings. ' +
  'Nothing wraps, nothing accent-coloured.';

export const agentsSidebarFootScenarios: Scenario[] = [
  foot(
    'agents-foot-low',
    'Agents sidebar foot — light use (8% used), a phone paired',
    `${BASE} “8% used · refills in 6d”, a short fill in ordinary ink; the phone icon with no dot (seen 3 h ago, its tooltip).`
  ),
  foot(
    'agents-foot-high',
    'Agents sidebar foot — heavy use (86% used)',
    `${BASE} “86% used · refills in 6d” in the warning role and a long amber fill.`,
    { used: 86 }
  ),
  foot(
    'agents-foot-out',
    'Agents sidebar foot — out of usage',
    `${BASE} “Out of usage · refills …”, the bar full, error-free (status, not accent).`,
    { used: 100, out: true }
  ),
  foot(
    'agents-foot-no-phone',
    'Agents sidebar foot — no phone paired',
    `${BASE} No phone yet: the phone row keeps its own label (the pairing call to action) under the actions; Settings stays an icon.`,
    { phone: phoneStatus() }
  ),
  foot(
    'agents-foot-remote-on',
    'Agents sidebar foot — remote access on',
    `${BASE} A globe icon with a green dot beside the phone icon and Settings.`,
    { remote: REMOTE_ON }
  ),
  foot(
    'agents-foot-narrow',
    'Agents sidebar foot — the sidebar at its narrowest',
    `${BASE} At 150px everything still fits on its row; long words ellipsise, never wrap.`,
    {
      remote: REMOTE_ON,
      extra: {
        steps: [
          { focus: '[aria-label="Resize Project Sidebar"]' },
          ...Array.from({ length: 12 }, () => ({ key: 'ArrowLeft' })),
        ],
      },
    }
  ),
  foot(
    'agents-foot-collapsed',
    'Agents sidebar foot — the sidebar collapsed to its rail',
    'The rail keeps one icon per row, usage first: the usage icon, New agent, New room, Routines, the phone, the globe, then Settings. Each has its name as a tooltip.',
    { remote: REMOTE_ON, extra: { steps: [{ click: '[aria-label="Hide sidebar"]' }] } }
  ),
];
