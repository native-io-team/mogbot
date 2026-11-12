/**
 * Signing in, in a build with our hosted relay (docs/relay.md, "Accounts"):
 * Settings → Account signed in and signed out, and the phone's setup
 * offering to sign in instead of Tailscale. Every scenario here draws a
 * relay build (`relay: true`); this repo's brand.json has none. The
 * onboarding screen is in `onboardingFlow.ts` (`onboarding-account*`).
 *
 * All names and addresses here are fictional.
 */

import type { Scenario } from '../types';
import { DEFAULTS, ENGINES, overview, TEAM } from './agents';
import { phoneStatus } from './phone';
import { PANEL_FLOW_KEY } from '../../components/phone/PhoneFlow';

const VIEWPORT = { width: 1280, height: 860 };
const ON = { enabled: true, running: true, serve: { state: 'off' } };
const ACCOUNT = { id: 'user_2abc', email: 'sam@example.com' };

const settings = (
  id: string,
  title: string,
  looksRightWhen: string,
  relay: Record<string, unknown>,
  requires: string
): Scenario => ({
  id,
  title,
  looksRightWhen,
  relay: true,
  command: 'settings.page.account',
  requires,
  clipSelector: '.settings-window',
  viewport: VIEWPORT,
  commands: {
    agents_overview: { ...overview(TEAM), engines: ENGINES, defaults: DEFAULTS },
    companion_status: phoneStatus({ ...ON, relay }),
  },
});

export const accountScenarios: Scenario[] = [
  settings(
    'settings-account-signed-in',
    'Settings — Account, signed in',
    'Account first in the section list and held. The page: "Account", its lead, then Your account: "sam@example.com" with "Signed in. Your phone can reach this Mac from anywhere, with no Tailscale." and a neutral "Sign out…" on the right. No accent anywhere on the page.',
    { state: 'connected', account: ACCOUNT },
    '[data-account-sign-out]'
  ),
  settings(
    'settings-account-signed-out',
    'Settings — Account, not signed in',
    'Your account: "Not signed in", one line on what signing in unlocks and one on what works without it, and one "Sign in" button on the right (the page’s one primary action).',
    { state: 'connected', account: null },
    '[data-account-sign-in]'
  ),
  {
    id: 'phone-flow-relay-sign-in',
    title: 'Phone panel — phone access by signing in (a build with the relay)',
    looksRightWhen:
      'The Phone panel’s flow on its phone-access screen: "Sign in so your phone can reach this Mac", one line (anywhere, no Tailscale; this Mac stays on), a quiet note (Google or your email, in your browser; signing in turns on phone access). One big "Sign in", then "Use Tailscale instead" (outline) and "Skip for now".',
    relay: true,
    command: 'companion.devices',
    requires: '[data-phone-flow-step="phoneAccess"] [data-phone-use-tailscale]',
    clipSelector: '.phone-modal',
    storage: { [PANEL_FLOW_KEY]: 'phoneAccess' },
    commands: {
      companion_status: phoneStatus({ relay: { state: 'off', account: null } }),
      companion_tailnet_phones: [],
    },
  },
];
