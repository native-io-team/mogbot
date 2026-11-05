/**
 * The queue of Macs forgotten offline: one entry per pairing (Mac and
 * device), so forgetting an old pairing never touches a newer one with the
 * same Mac, and an entry stops once the Mac is shown not to be that Mac.
 */

import { forgetSettledBy, withForget, withoutForget } from '../src/lib/forgets';

const old = { serverId: 'srv_1', deviceId: 'dev_old', token: 'old' };
const fresh = { serverId: 'srv_1', deviceId: 'dev_new', token: 'new' };

it('keeps each pairing of the same Mac apart', () => {
  // Forgotten offline, paired again, forgotten again: both are owed a revoke.
  const list = withForget(withForget([], old), fresh);
  expect(list.map((x) => x.deviceId)).toEqual(['dev_old', 'dev_new']);
  // Queuing one twice keeps it once.
  expect(withForget(list, old).map((x) => x.deviceId)).toEqual(['dev_new', 'dev_old']);
  // Finishing the old one leaves the new one queued.
  expect(withoutForget(list, old)).toEqual([fresh]);
});

it('settles on a refusal that ends it, and tries again on one that may pass', () => {
  for (const r of ['revoked', 'unauthorized', 'not_your_mac', 'mac_reset'] as const) {
    expect(forgetSettledBy(r)).toBe(true);
  }
  for (const r of ['update_app', 'update_mac', 'too_many_connections', 'unavailable'] as const) {
    expect(forgetSettledBy(r)).toBe(false);
  }
});
