/**
 * How a chat follows the conversation, as Grok's and iMessage's do:
 *
 * - At the newest line it's **pinned**: your message lands at the bottom and
 *   a reply grows up from the composer, its newest words always in view.
 * - Scroll back to read and it lets go: nothing moves under you (the list
 *   holds the rows on screen, `HOLD`), and a "↓ New" pill says when
 *   something arrived below. Come back to the end, by hand or the pill, and
 *   it's pinned again.
 * - Only your own finger lets go. The keyboard opening or closing, a card
 *   folding open, a page of older messages arriving: none of them unpin, so
 *   none of them can leave you stranded above the newest line.
 *
 * The list is inverted (offset 0 is the newest end), and with the keyboard
 * up the end moves to `-inset` (react-native-keyboard-controller lifts the
 * content with a top inset). Every distance here is from that end, so
 * "scroll to the newest" means the same with the keyboard up or down; the
 * old `scrollToOffset(0)` left the newest lines behind the keyboard.
 *
 * Pure, so the rules are tested without a screen (`__tests__/follow.test.ts`).
 */

/** Within this of the end still counts as at it (a finger's rest, an inset's rounding). */
export const AT_END = 32;

/** Scrolled back further than this, the pill offers the way down even with nothing new. */
export const FAR = 360;

export interface Follow {
  /** At the newest line: what arrives is followed. */
  pinned: boolean;
  /** The newest row's signature when you let go; anything else since is new. */
  leftAt: string | null;
}

export const FOLLOWING: Follow = { pinned: true, leftAt: null };

/** How far back from the newest end the list is, keyboard or not. */
export const fromEnd = (offsetY: number, insetTop: number) => Math.max(0, offsetY + insetTop);

/** The offset that shows the newest line, keyboard or not. */
export const endOffset = (insetTop: number) => -insetTop;

/**
 * What the newest row is and how far it has got: a reply being written
 * changes it as it grows, so "New" shows for more words, not only a new row.
 */
export function newestSignature(
  item: { key: string; kind: string; text?: string; label?: string } | undefined
): string | null {
  if (!item) return null;
  if (item.kind === 'draft') return `${item.key}:${item.text?.length ?? 0}`;
  if (item.kind === 'working') return `${item.key}:${item.label ?? ''}`;
  return item.key;
}

/**
 * After a scroll. `byUser` is whether a finger is on the list or its fling
 * is still running: only that lets go. Reaching the end, however it got
 * there, pins again.
 */
export function scrolled(
  state: Follow,
  distance: number,
  newest: string | null,
  byUser: boolean
): Follow {
  if (distance <= AT_END) return state.pinned ? state : FOLLOWING;
  if (!state.pinned || !byUser) return state;
  return { pinned: false, leftAt: newest };
}

/** Sent, or the pill tapped: back to the newest line and following it. */
export const toEnd = (): Follow => FOLLOWING;

export type Pill = { says: 'urgent' | 'new' | null } | null;

/**
 * The pill over the composer. Pinned, none: you're looking at the newest.
 * Let go, it says "Needs your OK" for a card waiting below, "New" when
 * anything arrived since you left, and is a bare arrow once you're far back.
 */
export function pillFor(
  state: Follow,
  distance: number,
  newest: string | null,
  urgent: boolean
): Pill {
  if (state.pinned) return null;
  if (urgent) return { says: 'urgent' };
  if (state.leftAt !== null && newest !== state.leftAt) return { says: 'new' };
  return distance > FAR ? { says: null } : null;
}

/**
 * `maintainVisibleContentPosition` for the list. Pinned, none: the inverted
 * list keeps offset 0 at the newest line, so a growing reply pushes upward
 * and stays in view. Let go, the rows on screen hold still while anything
 * newer grows or arrives below them (index 1 and up: the newest row may be
 * the one growing).
 */
export const HOLD = { minIndexForVisible: 1 } as const;
export const holdFor = (state: Follow) => (state.pinned ? undefined : HOLD);

/**
 * A new card that asks (an approval, a question) landed: whether to bring
 * its answers into view. Only when you're at or near the newest line (within
 * `FAR`), so a card never yanks you away from something you scrolled back to
 * read; and only for a card that wasn't there before, so it happens once.
 * `before` is undefined until the chat has loaded: a card already waiting
 * when you open the chat isn't "new" (opening lands on the newest anyway).
 */
export function revealsCard(
  before: string | null | undefined,
  now: string | null,
  distance: number
): boolean {
  if (!now || before === undefined || now === before) return false;
  return distance <= FAR;
}
