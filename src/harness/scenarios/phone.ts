/**
 * Phone access (the mobile companion) — off, each Tailscale problem, on with
 * paired phones, a code on screen, a phone waiting for Allow, and removing a
 * phone.
 */

import type { Scenario } from '../types';
import { PHONE_PAIRING_LINK, PHONE_QR } from '../fixtures/phoneQr';
import { PANEL_FLOW_KEY } from '../../components/phone/PhoneFlow';

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
    relay: { state: 'off', account: null },
    ...over,
  };
}

const ON = {
  enabled: true,
  running: true,
  serve: { state: 'on', url: `https://${DNS}:47443` },
};

export const PHONE_DEVICES = [
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

const devices = PHONE_DEVICES;

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

/** The Phone panel's flow, opened on one screen (no phone paired yet). */
const at = (step: string) => ({ [PANEL_FLOW_KEY]: step });
const LOGIN = { state: 'connected', dnsName: DNS, login: 'julian@example.com' };
const CODE = {
  companion_pair_start: { link: PHONE_PAIRING_LINK, qr: PHONE_QR, expiresAt: Date.now() + 5 * MIN },
};
const flowStep = (
  id: string,
  step: string,
  title: string,
  looksRightWhen: string,
  status: Record<string, unknown>,
  extra: Partial<Scenario> = {}
) =>
  phone(id, title, looksRightWhen, status, {
    storage: at(step),
    ...extra,
    requires: `[data-phone-flow-step="${extra.requires ?? step}"]`,
    commands: { companion_tailnet_phones: [], ...CODE, ...(extra.commands ?? {}) },
  });

export const phoneScenarios: Scenario[] = [
  flowStep(
    'phone-off',
    'phoneGetApp',
    'Phone — nothing paired yet: 1. Get the app',
    'Titled “Phone”. One screen, not a list: Back hidden, a thin bar at 1 of 7, “Get Mogbot on your phone”, one line (“Don’t have it yet?”, then point the camera to download the TestFlight beta), the QR code on white paper with a muted line under it saying it only downloads the app and isn’t the pairing code, a big “Get it on TestFlight ↗”, an outlined “I already have the app” and a quiet “Skip for now”. No tick.',
    { tailscale: LOGIN }
  ),
  flowStep(
    'phone-flow-mac-tailscale',
    'phoneMacTailscale',
    'Phone — 2. Tailscale on this Mac, done',
    'Back, the bar at 2 of 7, “Turn on Tailscale on this Mac”, one line, a green-ticked “Done. Tailscale is on, signed in as julian@example.com.”, a big Continue and Skip for now.',
    { tailscale: LOGIN }
  ),
  flowStep(
    'phone-install-tailscale',
    'phoneMacTailscale',
    'Phone — 2. Tailscale missing on this Mac',
    '“Turn on Tailscale on this Mac”, an amber “Not done yet. Tailscale isn’t on this Mac yet.” with the fix (install, sign in, Allow the VPN configuration) and Check again; a big “Get Tailscale for Mac ↗”.',
    { tailscale: { state: 'notInstalled' } }
  ),
  flowStep(
    'phone-flow-phone-tailscale',
    'phonePhoneTailscale',
    'Phone — 3. Tailscale on your phone, same account',
    '“Turn on Tailscale on your phone”, the line naming julian@example.com (the Mac’s account), the VPN prompt and that this Mac sees the phone a few seconds after it says Connected, “Looking for your phone on your Tailscale…” with a spinner, a quiet “Not working?”, App Store ↗ only (no Google Play: the phone app is iPhone only), a big “I did it”.',
    { tailscale: LOGIN }
  ),
  flowStep(
    'phone-flow-phone-tailscale-trouble',
    'phonePhoneTailscale',
    'Phone — 3. Tailscale on your phone, “Not working?” open',
    'Under the looking line, a numbered list, each item a bold lead then muted detail: Same account on both (naming julian@example.com, Sign in with Apple/Google/email are separate accounts), Switched on, On on this Mac too, Switch it off and on, Look for it in Tailscale (Machines), The same Wi-Fi isn’t needed.',
    { tailscale: LOGIN },
    { afterCommand: [{ click: '[data-testid="tailnet-not-working"]' }] }
  ),
  flowStep(
    'phone-flow-access',
    'phoneAccess',
    'Phone — 4. Turn on phone access',
    '“Turn on phone access”, one line (this Mac has to stay on), a big “Turn on phone access”, Skip for now.',
    { tailscale: LOGIN }
  ),
  flowStep(
    'phone-approve-https',
    'phoneAccess',
    'Phone — 4. Tailscale needs HTTPS switched on',
    'An amber “Not done yet. One switch in Tailscale is off: HTTPS certificates.” with why, “Open Tailscale ↗” and Check again; no big button.',
    {
      enabled: true,
      running: true,
      tailscale: LOGIN,
      serve: { state: 'needsApproval', url: 'https://login.tailscale.com/f/serve?node=n1' },
    }
  ),
  flowStep(
    'phone-failed',
    'phoneAccess',
    'Phone — 4. Tailscale refused, in its own words',
    'An amber “Not done yet. Tailscale didn’t start phone access.” with Tailscale’s message wrapping inside the check, and Check again.',
    {
      enabled: true,
      running: true,
      tailscale: LOGIN,
      serve: {
        state: 'failed',
        detail: 'error: failed to serve: listener already exists for port 47443',
      },
    }
  ),
  flowStep(
    'phone-first-code',
    'phoneScan',
    'Phone — 5. The code, big and alone',
    'Bar at 5 of 7. One line as the title, “On your phone, open Mogbot and tap Scan the code”, then the QR large and alone on light paper, “Works once, for 5:00” (or just under) under it, and Skip for now. Nothing else.',
    { ...ON, tailscale: LOGIN, pairing: { active: true, expiresAt: Date.now() + 5 * MIN } }
  ),
  flowStep(
    'phone-confirm',
    'phoneScan',
    'Phone — 6. A phone used the code: Allow',
    '“Allow Sam’s iPhone?”, one line (only the phone in your hand, code ending 5D2Q; it can read and send to every agent), “iPhone 16 Pro · app 1.0.0 · asked at <time> · julian@example.com”, a big neutral Allow (not the accent) and a quiet Deny.',
    {
      ...ON,
      tailscale: LOGIN,
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
    },
    { requires: 'phoneAllow' }
  ),
  flowStep(
    'phone-flow-paired',
    'phoneScan',
    'Phone — 7. Paired: you’re all set',
    'After Allow: this Mac and the phone as two tiles joined by a green line, a green tick landing on it; “You’re all set”, “Sam’s iPhone is paired with this Mac. Your agents go where you go.”, a quiet card of three lines (message any agent, approvals from the Lock Screen, a ping when one needs you), one big button. No Back.',
    {
      ...ON,
      tailscale: LOGIN,
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
    },
    {
      requires: 'phonePaired',
      commands: { companion_pair_decide: null },
      afterCommand: [{ click: '[data-phone-flow-step="phoneAllow"] [data-flow-primary]' }],
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
    'A crisp black-on-white QR code on the left (it scans to this app’s pairing link), ' +
      'four numbered steps on the right, the first in bold: “Install Tailscale on your phone and ' +
      'sign in as julian@example.com.”, why, and an “App Store ↗” link (no Google Play while the phone app is iPhone only) under it. ' +
      'Then open the app, tap Scan the code, then Pair, and Allow here. "Works once, for 5:00" (or just under) and ' +
      '"Copy link instead" / "Cancel". No “A device reached this Mac” line yet.',
    {
      ...ON,
      tailscale: { state: 'connected', dnsName: DNS, login: 'julian@example.com' },
      devices: [devices[1]],
      pairing: { active: true, expiresAt: Date.now() + 5 * MIN },
    },
    {
      // "Pair your phone" in Cmd+K opens the panel straight onto a code.
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
