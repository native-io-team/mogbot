/**
 * The composer's "↵ queue · ⌘↵ send now" caption is there to be learned,
 * not to sit there for ever: once you've queued with ↵ and interrupted with
 * ⌘↵ a few times each, it stops showing (Send's tooltip and the field's
 * description still say it). Counted on this Mac only, in `localStorage`;
 * storage that throws or comes back empty just means the caption shows.
 *
 * @module lib/queueHint
 */

const KEY = 'shipstudio.agents.queueHint';

/** Uses of each before the caption steps aside. */
export const QUEUE_HINT_LEARNED_AFTER = 3;

export interface QueueHintUses {
  queued: number;
  now: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function readQueueHintUses(): QueueHintUses {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { queued: 0, now: 0 };
    const parsed = JSON.parse(raw) as Partial<Record<keyof QueueHintUses, unknown>> | null;
    return { queued: count(parsed?.queued), now: count(parsed?.now) };
  } catch {
    return { queued: 0, now: 0 };
  }
}

/** True once both have been used often enough that the caption is noise. */
export function queueHintLearned(uses: QueueHintUses = readQueueHintUses()): boolean {
  return uses.queued >= QUEUE_HINT_LEARNED_AFTER && uses.now >= QUEUE_HINT_LEARNED_AFTER;
}

/** A message sent while the agent works: queued (↵, Send) or interrupting (⌘↵). */
export function noteQueueHintUse(now: boolean): QueueHintUses {
  const uses = readQueueHintUses();
  const next = now ? { ...uses, now: uses.now + 1 } : { ...uses, queued: uses.queued + 1 };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not remembered: the caption keeps showing, which is the safe side.
  }
  return next;
}
