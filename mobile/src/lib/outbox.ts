/**
 * Sends written while the Mac couldn't be reached. They go out by
 * themselves when it answers, but only for a short while: a message
 * arriving hours after it was written, with no one watching, is worse than
 * one that waits for you to press Send. Past the window a waiting send
 * becomes "Not sent · Send" and stays yours to send or discard.
 *
 * Flushing is safe to repeat: each send carries its `clientId`, and the Mac
 * returns the original message for one it has already seen.
 */

import type { PendingSend, SyncState } from './sync';
import { WireFailure } from './transport';

/** How long a send waits for the Mac on its own. */
export const OUTBOX_WAIT_MS = 10 * 60_000;

/** Which waiting sends to send now, and which have waited too long. */
export function outboxPlan(
  pending: SyncState['pending'],
  now: number
): { flush: PendingSend[]; expire: PendingSend[] } {
  const flush: PendingSend[] = [];
  const expire: PendingSend[] = [];
  for (const list of Object.values(pending)) {
    for (const p of list) {
      if (!p.waiting) continue;
      (now - p.ts < OUTBOX_WAIT_MS ? flush : expire).push(p);
    }
  }
  // Oldest first, so a chat's sends arrive in the order they were written.
  flush.sort((a, b) => a.ts - b.ts);
  return { flush, expire };
}

/**
 * Send what waited, oldest first. A send that still didn't reach the Mac
 * (it timed out again) holds back the rest of its chat until the next
 * flush, so a later message never arrives before an earlier one; other
 * chats carry on. Stops when the link goes.
 */
export async function sendInOrder(
  flush: PendingSend[],
  resend: (p: PendingSend) => Promise<unknown>,
  connected: () => boolean,
  stillWaiting: (p: PendingSend) => boolean
): Promise<void> {
  const held = new Set<string>();
  for (const p of flush) {
    if (!connected()) break;
    if (held.has(p.agentId)) continue;
    await resend(p).catch(() => {});
    if (stillWaiting(p)) held.add(p.agentId);
  }
}

/**
 * The Mac's own words when it couldn't finish answering in time, or its
 * worker fell over (`server.rs`: `BUSY`, and the two lines beside it). The
 * work carries on past its deadline there, so the send may well have
 * landed: it's no refusal, and "Not sent" would be wrong, and an edited
 * resend (a new `clientId`) a duplicate.
 */
const MAC_DIDNT_FINISH =
  /^(Your (Mac|PC|computer) is busy|This (Mac|PC|computer) stopped answering|This (Mac|PC|computer) hit a fault)/;

/**
 * The send may not have reached the Mac (no link, no answer in time, the
 * Mac too busy to finish answering, or rate-limited before it looked):
 * worth sending again with the same `clientId`, which the Mac answers with
 * the original if it did land. A refusal is final.
 */
export function unreached(error: unknown): boolean {
  if (!(error instanceof WireFailure)) return false;
  const e = error.error;
  if (e.type === 'Timeout') return true;
  if (e.type === 'Protocol') return e.code === 'not_connected' || e.code === 'rate_limited';
  return e.type === 'Other' && MAC_DIDNT_FINISH.test(e.message);
}

/**
 * Waits before a send the Mac didn't answer is tried again while the link
 * stays up (a reconnect sends it at once instead). Before these, a send that
 * timed out on a live link waited for the next reconnect, which on a good
 * link might be hours.
 */
export const RETRY_WAITING_MS = [3000, 8000, 20_000, 30_000];
export const retryWaitMs = (tries: number) =>
  RETRY_WAITING_MS[Math.min(tries, RETRY_WAITING_MS.length - 1)];

/**
 * Pending sends restored from disk after a restart. One that was in flight
 * when the app died may or may not have reached the Mac; it waits, and the
 * `clientId` makes sending it again harmless.
 */
export function restorePending(pending: SyncState['pending']): SyncState['pending'] {
  return Object.fromEntries(
    Object.entries(pending).map(([id, list]) => [
      id,
      list.map((p) => (p.failed || p.waiting ? p : { ...p, waiting: true })),
    ])
  );
}
