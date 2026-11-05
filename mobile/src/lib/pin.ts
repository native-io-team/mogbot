/**
 * Checking a `welcome` against the identity this phone pinned at pairing.
 * Pure, so the rule is tested on its own and against the mock Mac.
 */

import { welcomeProofMessage, type WelcomeFrame } from '@shipstudio/companion-protocol';
import { proves, provenFingerprint } from './identity';

export interface WelcomeCheck {
  /** `ok`: signed by the pinned key. `unproven`: nothing pinned and nothing signed. */
  verdict: 'ok' | 'unproven' | 'mismatch';
  /** A key to pin now (paired before identity keys, first signed welcome). */
  pin?: string;
}

/**
 * - Pinned, and the welcome is signed by that key for this Mac and device:
 *   `ok`. Signed by any other key, or not signed at all: `mismatch`, for
 *   good. A Mac that has been set up again has a new key and needs pairing
 *   again, which is the price of a server that only *says* it's your Mac
 *   getting nowhere.
 * - Nothing pinned (paired by an app before identity keys): a signed welcome
 *   is pinned from then on; an unsigned one is let through `unproven`, and
 *   secrets aren't sent on it.
 */
export function checkWelcome(
  pinned: { fingerprint?: string; serverId: string; deviceId: string },
  welcome: WelcomeFrame,
  challenge: string
): WelcomeCheck {
  if (welcome.server.id !== pinned.serverId || welcome.deviceId !== pinned.deviceId) {
    return { verdict: pinned.fingerprint ? 'mismatch' : 'unproven' };
  }
  const message = welcomeProofMessage(challenge, pinned.serverId, pinned.deviceId);
  if (pinned.fingerprint) {
    return {
      verdict:
        challenge && proves(welcome.identity, message, pinned.fingerprint) ? 'ok' : 'mismatch',
    };
  }
  const learned = challenge ? provenFingerprint(welcome.identity, message) : null;
  return learned ? { verdict: 'ok', pin: learned } : { verdict: 'unproven' };
}
