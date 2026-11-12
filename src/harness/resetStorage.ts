/**
 * Wipe per-viewer browser storage before any app module reads it.
 *
 * Captures share one Chrome profile, so without this a preference written by
 * an earlier capture (dashboard grid/list, onboarding mode, a dismissed
 * banner) silently changes what a later one renders. That makes a run
 * order-dependent, which makes a screenshot unfalsifiable: you cannot tell a
 * regression from a leftover.
 *
 * This module is imported *before* `../App` in `main.tsx` on purpose — ES
 * module side effects run in import order, and the app reads `localStorage`
 * at module scope.
 *
 * A scenario that needs a stored value declares it via `Scenario.storage`,
 * which is seeded here after the wipe.
 */

import { findScenario } from './scenarios';
import { overrideRelayForHarness } from '../lib/brand';

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get('scenario'));

try {
  localStorage.clear();
  sessionStorage.clear();
} catch {
  // Private mode or blocked site data. Nothing to clear, nothing to fix.
}

// A relay build's screens, for a scenario about them. Before any component
// renders: the app reads `relayOn()` only when it draws.
overrideRelayForHarness(scenario.relay === true ? true : null);

// ChiefPhoneOffer's PHONE_OFFER_KEY, written out: importing the component here
// would load app modules (which read storage at module scope) before the wipe.
const PHONE_OFFER_KEY = 'shipstudio.chief.phoneOffer';

// The Chief's phone offer reads as answered unless the scenario is about it
// (`phoneOffer: true`); a scenario's own `storage` still wins.
const seeded: Record<string, string> = {
  ...(scenario.phoneOffer ? {} : { [PHONE_OFFER_KEY]: 'later' }),
  ...scenario.storage,
};

for (const [key, value] of Object.entries(seeded)) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Same as above — a scenario that depends on storage will simply render
    // its default state, and the screenshot shows that honestly.
  }
}

/**
 * `?theme=light|dark|system` forces the colour theme for a capture
 * (`harness-capture.mjs --theme light`). Seeded as the boot cache, so it takes
 * the same path a real launch does; the fake backend's `get_app_theme`
 * answers the same value, so nothing reconciles it away.
 */
export const harnessTheme = (() => {
  const value = params.get('theme');
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
})();

{
  try {
    // Unforced captures stay dark (the base fixture's saved theme), whatever
    // headless Chrome reports for prefers-color-scheme.
    localStorage.setItem('app.theme', harnessTheme ?? 'dark');
  } catch {
    // Storage blocked: the page renders dark, and the capture shows that.
  }
}
