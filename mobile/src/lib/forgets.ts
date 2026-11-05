/**
 * The queue of Macs forgotten while they couldn't be reached
 * (`session.finishForgets`), as pure rules so they're tested on their own.
 *
 * An entry is one pairing: a Mac *and* the device id it gave this phone.
 * Pairing the same Mac again makes a new device with a new token, so an old
 * entry is never the current pairing, and finishing it never touches that.
 */

import type { RefusedFrame } from '@shipstudio/companion-protocol';

export interface ForgetEntry {
  serverId: string;
  deviceId: string;
}

const same = (a: ForgetEntry, b: ForgetEntry) =>
  a.serverId === b.serverId && a.deviceId === b.deviceId;

/** The queue with `c` in it once. */
export const withForget = <T extends ForgetEntry>(list: T[], c: T): T[] => [
  ...list.filter((x) => !same(x, c)),
  c,
];

/** The queue without `c`. */
export const withoutForget = <T extends ForgetEntry>(list: T[], c: ForgetEntry): T[] =>
  list.filter((x) => !same(x, c));

/**
 * Whether a refusal settles a queued forget. The token is already gone
 * (`revoked`, `unauthorized`), or the server isn't the Mac that pairing was
 * with (`not_your_mac`, `mac_reset`, which also means the Mac started over
 * and removed every phone): asking again on every launch would only keep
 * offering the old token to whoever answers. Anything else is worth another
 * try later.
 */
export const forgetSettledBy = (reason: RefusedFrame['reason']): boolean =>
  reason === 'revoked' ||
  reason === 'unauthorized' ||
  reason === 'not_your_mac' ||
  reason === 'mac_reset';
