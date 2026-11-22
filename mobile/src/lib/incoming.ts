/**
 * What the Mac says, on its way into the store: kept for the next update
 * (`eventBatch.ts`), applied (`sync.ts`), and what each event sets off before
 * and after, in order.
 *
 * Batches are applied from timers, from a request's answer and as a link
 * reconnects, and none of those may fail because of what an event holds. So
 * nothing here throws: one event that can't be applied is reported and
 * skipped, the rest of its batch applies, and the cursor stays before it
 * until the Mac next replays or sends the whole (`applySafely`).
 *
 * That replay is its one retry. Failing again it is passed, and what it would
 * have brought is read another way (`passed`): the Mac cuts a replay it isn't
 * acked for (docs/relay.md, "Sessions"), so a cursor kept before it for good
 * would start every one over at the same place and never be caught up.
 */

import type { AgentMessage, CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { createEventBatch, type EventBatchOptions } from './eventBatch';
import { guarded, reportFault } from './fault';
import { applySafely, unloadChats, type Arrived, type HeldCursor, type SyncState } from './sync';
import { asMessage } from './wellFormed';

export interface IncomingDeps {
  get: () => SyncState;
  set: (s: SyncState) => void;
  /** A message about to be stored (so "new" is knowable): told, alerted. Each runs whatever the others do. */
  notices: ((m: AgentMessage) => void)[];
  /** A snapshot is about to be stored. */
  snapshot: () => void;
  /** An event failed on its replay too, and the cursor went past it: read what it was about. */
  passed: (event: CompanionEvent) => void;
  /** What an event sets off once it is stored. */
  after: (event: CompanionEvent) => void;
}

export interface Incoming {
  event: (event: CompanionEvent, cursor?: Cursor) => void;
  /** Connected: what the Mac replays is kept until it says it's all there. */
  welcome: () => void;
  /** Applies what's waiting, now. Never throws. */
  flush: () => void;
  /** Another Mac. */
  clear: () => void;
}

export function createIncoming(deps: IncomingDeps, opts: EventBatchOptions = {}): Incoming {
  /** Where the cursor stays after an event that couldn't be applied. */
  let held: HeldCursor | null = null;
  /** How often each event of this epoch failed, by seq: kept over reconnects. */
  let tries = new Map<number, number>();
  let triesEpoch: string | null = null;

  function failed(error: unknown, { cursor }: Arrived): boolean {
    // Moves no cursor: the Mac never replays it.
    if (!cursor) {
      reportFault(error);
      return false;
    }
    if (triesEpoch !== cursor.epoch) {
      triesEpoch = cursor.epoch;
      tries = new Map();
    }
    const n = (tries.get(cursor.seq) ?? 0) + 1;
    tries.set(cursor.seq, n);
    if (n <= 2) reportFault(error);
    return n > 1;
  }

  function apply(arrived: Arrived[]) {
    // Of one line's copies only the newest is news: the ones it replaced within
    // this batch were never on screen.
    const newest = new Map<string, Arrived>();
    for (const one of arrived) {
      if (one.event.type === 'agents.message') newest.set(one.event.message?.id, one);
    }
    for (const one of arrived) {
      const { event } = one;
      if (event.type === 'agents.message' && newest.get(event.message?.id) === one) {
        guarded(() => {
          const m = asMessage(event.message);
          if (m) for (const notice of deps.notices) guarded(() => notice(m));
        });
      }
      if (event.type === 'sync.snapshot') guarded(deps.snapshot);
    }
    const passed: CompanionEvent[] = [];
    const applied = applySafely(deps.get(), arrived, held, (error, one) => {
      const pass = failed(error, one);
      if (pass) passed.push(one.event);
      return pass;
    });
    held = applied.held;
    let { state } = applied;
    for (const event of passed) {
      guarded(() => {
        const m = event.type === 'agents.message' ? asMessage(event.message) : null;
        if (m) state = unloadChats(state, m);
      });
    }
    // Something drawn from the store may throw here: the events are in it all the same.
    guarded(() => deps.set(state));
    for (const event of passed) guarded(() => deps.passed(event));
    for (const { event } of arrived) guarded(() => deps.after(event));
  }

  const batch = createEventBatch<Arrived>(apply, { onError: reportFault, ...opts });

  return {
    event(event, cursor) {
      batch.add({ event, cursor });
      // A snapshot is the whole screen, and "caught up" ends the wait for it.
      // An alert is never replayed, so it doesn't wait: a phone put away in
      // the meantime would post it late, or never. It goes behind what came
      // before it (its card, its agent).
      if (event.type === 'sync.caughtUp') batch.release();
      else if (event.type === 'sync.snapshot' || event.type === 'alert') batch.flush();
    },
    welcome() {
      batch.hold();
      // The Mac replays from the cursor, so from the event it stayed before.
      held = null;
    },
    flush: () => batch.flush(),
    clear() {
      batch.clear();
      held = null;
      tries = new Map();
    },
  };
}
