/**
 * Phone access (the mobile companion) — off, each Tailscale problem, on with
 * paired phones, a code on screen, a phone waiting for Allow, and removing a
 * phone.
 */

import type { Scenario } from '../types';
import { PHONE_PAIRING_LINK, PHONE_QR } from '../fixtures/phoneQr';

const DNS = 'studio-mac.tail1234.ts.net';
const MIN = 60_000;

/** The panel's whole input. Every scenario overrides only what it is about. */
export function phoneStatus(over: Record<string, unknown> = {}) {
  return {
    enabled: false,
    running: false,
    serve: { state: 'off' },
    tailscale: { state: 'connected', dnsName: DNS },
    devices: [],
    pairing: { active: false },
    activity: {},
    methods: [
      'agents.send',
      'agents.answerApproval',
      'agents.stop',
      'agents.interrupt',
      'agents.files',
      'agents.fetchPath',
      'agents.search',
      'agents.schedule.create',
      'projects.list',
      'sessions.read',
    ],
    push: { available: false, enabled: false },
    ...over,
  };
}

const ON = {
  enabled: true,
  running: true,
  serve: { state: 'on', url: `https://${DNS}:47443` },
};

const devices = [
  {
    id: 'dev_1',
    name: 'Sam’s iPhone',
    platform: 'ios',
    model: 'iPhone 16 Pro',
    appVersion: '1.0.0',
    build: 'official',
    pairedAt: Date.now() - 3 * 24 * 60 * MIN,
    lastSeenAt: Date.now() - 10_000,
    lastRoute: 'tailscale',
    connected: true,
  },
  {
    id: 'dev_2',
    name: 'Pixel 9',
    platform: 'android',
    model: 'Pixel 9',
    appVersion: '0.9.2',
    build: 'self',
    pairedAt: Date.now() - 20 * 24 * 60 * MIN,
    lastSeenAt: Date.now() - 2 * 60 * MIN,
    lastRoute: 'tailscale',
    connected: false,
  },
];

const phone = (
  id: string,
  title: string,
  looksRightWhen: string,
  status: Record<string, unknown>,
  extra: Partial<Scenario> = {}
): Scenario => ({
  id,
  title,
  looksRightWhen,
  command: 'companion.devices',
  requires: '.phone-modal',
  clipSelector: '.phone-modal',
  ...extra,
  commands: {
    companion_status: phoneStatus(status),
    ...(extra.commands ?? {}),
  },
});

export const phoneScenarios: Scenario[] = [
  phone(
    'phone-off',
    'Phone — off, nothing paired: install comes first',
    'Titled “Your phone”. One line on what the phone is for, then three short numbered steps: ' +
      '“Get the app” with a primary “Get the app…” and a secondary “I already have it”; ' +
      '“Tailscale, on this Mac and your phone” saying a scan never gets here without it, a green ' +
      'tick on “This Mac: set up.”, and “Your phone: Install Tailscale on your phone and sign in ' +
      'as julian@example.com.” with “App Store ↗” and “Google Play ↗” links; and a muted “Pair”. ' +
      'No Xcode, Apple ID, cable or USB debugging on this screen, no “Turn on phone access” ' +
      'button and no QR.',
    { tailscale: { state: 'connected', dnsName: DNS, login: 'julian@example.com' } }
  ),
  phone(
    'phone-install-tailscale',
    'Phone — on, but Tailscale isn’t installed',
    'A quiet panel titled "Install Tailscale" with Turn off on the right, one paragraph on why, ' +
      'and "Get Tailscale" plus "Try again". "Paired phones" below says none are paired yet.',
    { enabled: true, running: true, tailscale: { state: 'notInstalled' } }
  ),
  phone(
    'phone-approve-https',
    'Phone — Tailscale needs HTTPS certificates switched on',
    '"Switch on HTTPS in Tailscale", one sentence on why, "Open Tailscale" and ' +
      '"I’ve switched it on".',
    {
      enabled: true,
      running: true,
      serve: { state: 'needsApproval', url: 'https://login.tailscale.com/f/serve?node=n1' },
    }
  ),
  phone(
    'phone-failed',
    'Phone — Tailscale refused, with its own words',
    'The title says Tailscale didn’t start phone access, Tailscale’s message in red wraps ' +
      'inside the panel, and "Try again" is offered.',
    {
      enabled: true,
      running: true,
      serve: {
        state: 'failed',
        detail: 'error: failed to serve: listener already exists for port 47443',
      },
    }
  ),
  phone(
    'phone-ready',
    'Phone — on, two phones paired',
    'Green bar "Phone access is on" (the address is its tooltip) and Turn off. A "Pair a ' +
      'phone" card with an icon tile and "Show code". Paired phones: the iPhone with a green ' +
      'tile, a green dot and "Connected now"; the Pixel "Last seen 2 h ago over Tailscale" and ' +
      '"built on this Mac". Each row has a quiet Remove and its last action ("Sent a message · 3 min ' +
      'ago"). Below, "What a paired phone can do": green-ticked abilities on the left, the ' +
      "things it can't do (push, edit code, type into sessions or terminals) muted on the right. " +
      'No Notifications section: this build has no push service, so it is not offered.',
    {
      ...ON,
      devices,
      activity: {
        dev_1: {
          tool: 'agents.send',
          detail: 'fix the header',
          ok: true,
          atMs: Date.now() - 3 * MIN,
        },
        dev_2: {
          tool: 'agents.answerApproval',
          detail: 'allow',
          ok: true,
          atMs: Date.now() - 2 * 60 * MIN,
        },
      },
    }
  ),
  phone(
    'phone-code',
    'Phone — a pairing code on screen',
    'A crisp black-on-white QR code on the left (it scans to a shipstudio-companion:// link), ' +
      'four numbered steps on the right, the first in bold: “Install Tailscale on your phone and ' +
      'sign in as julian@example.com.”, why, and “App Store ↗” / “Google Play ↗” links under it. ' +
      'Then open the app, tap Scan the code, then Pair, and Allow here. "Works once, for 5:00" (or just under) and ' +
      '"Copy link instead" / "Cancel". No “A device reached this Mac” line yet.',
    {
      ...ON,
      tailscale: { state: 'connected', dnsName: DNS, login: 'julian@example.com' },
      devices: [devices[1]],
      pairing: { active: true, expiresAt: Date.now() + 5 * MIN },
    },
    {
      // "Pair a phone" in Cmd+K opens the panel straight onto a code.
      command: 'companion.pair',
      commands: {
        companion_pair_start: {
          link: PHONE_PAIRING_LINK,
          qr: PHONE_QR,
          expiresAt: Date.now() + 5 * MIN,
        },
      },
    }
  ),
  phone(
    'phone-code-reached',
    'Phone — a code on screen, and a device has reached this Mac',
    'As phone-code, but Tailscale reports no account for this Mac, so the first step says ' +
      '“sign in with the same account as this Mac” (no address invented). Under the steps, a ' +
      'quiet line with a small spinner: “A device reached this Mac at <time>. Waiting for it to ' +
      'send the code…”. Neutral, not green or amber.',
    {
      ...ON,
      devices: [devices[1]],
      pairing: {
        active: true,
        expiresAt: Date.now() + 5 * MIN,
        reachedAt: Date.now() - 4_000,
      },
    },
    {
      command: 'companion.pair',
      commands: {
        companion_pair_start: {
          link: PHONE_PAIRING_LINK,
          qr: PHONE_QR,
          expiresAt: Date.now() + 5 * MIN,
        },
      },
    }
  ),
  phone(
    'phone-confirm',
    'Phone — a phone used the code and waits for Allow',
    'Centred in an amber-edged card: a phone tile, "Allow Sam’s iPhone to use your agents?" ' +
      'with the name in bold, "iPhone 16 Pro · app 1.0.0", "Asked at <time> · code ending 5D2Q · ' +
      'julian@example.com", an amber warning to only allow a phone you’re holding showing the same ' +
      'code ending, and Deny / Allow with Allow primary.',
    {
      ...ON,
      pairing: {
        active: false,
        request: {
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
        },
      },
    }
  ),
  phone(
    'phone-confirm-replace',
    'Phone — a phone that looks like one already paired asks',
    'As phone-confirm, plus a second amber line: "A phone called Sam’s iPhone is already paired ' +
      '(since <date>). If this is that phone again, replace it…". Three answers: Deny, "Allow, keep ' +
      'both" and a primary "Allow and replace". Nothing is replaced without that click.',
    {
      ...ON,
      devices,
      pairing: {
        active: false,
        request: {
          id: 'pr_2',
          device: {
            name: 'Sam’s iPhone',
            platform: 'ios',
            model: 'iPhone 16 Pro',
            appVersion: '1.0.1',
            build: 'official',
          },
          requestedAt: Date.now() - 5_000,
          codeHint: 'K7Q2',
          replaces: [devices[0]],
        },
      },
    }
  ),
  phone(
    'phone-remove-confirm',
    'Phone — confirming Remove on a paired phone',
    'The iPhone’s row reads "Remove Sam’s iPhone?" with what that means, and Keep / a red ' +
      'Remove. The other row is unchanged.',
    { ...ON, devices },
    {
      // Steps run before a scenario's command, so this one opens the panel
      // the way a person does: Settings, then Phone.
      command: undefined,
      openSelector: '[data-settings-menu-trigger]',
      steps: [
        { click: '[data-settings-nav="phone"]' },
        { click: 'button[data-settings-open="phone"]' },
        { click: '.phone-device .phone-device__actions button' },
      ],
      // Read by Settings on the way through.
      commands: { get_terminal_gpu_enabled: true },
    }
  ),
  phone(
    'phone-push',
    'Phone — notifications through the push service',
    'Below the paired phones, a "Notifications" section with a ticked checkbox "Phone ' +
      'notifications", a muted line saying only a generic alert ' +
      'is sent with no message, agent name or project, and one saying it needs the official app.',
    { ...ON, devices, push: { available: true, enabled: true } },
    { commands: { companion_set_push: phoneStatus({ ...ON, devices }) } }
  ),
  phone(
    'phone-off-paired',
    'Phone — off, with phones still paired',
    'The intro and "Turn on phone access", then the two paired phones (neither connected) and a ' +
      'footnote that they stay paired and reconnect when it’s back on.',
    {
      devices: devices.map((d) => ({ ...d, connected: false })),
    }
  ),
];
