import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { keepReadTo, readTo, type ReadTo } from '../../lib/chatRestore';

/** Chats whose place was put back this launch: once each, then they behave as before. */
const restored = new Set<string>();

/** Tests only: a fresh launch. */
export function resetReadToForTests() {
  restored.clear();
}

interface Options {
  /** The agent's or room's chat. */
  chatKey: string;
  /** Its lines are loaded (an empty chat counts). */
  ready: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  messagesRef: RefObject<HTMLDivElement | null>;
  atBottomRef: { current: boolean };
  setAtBottom: (bottom: boolean) => void;
  /** Where a line is among the loaded items (-1: not loaded). */
  indexOf: (id: string) => number;
  /** The first item in the DOM. */
  startIndex: number;
  /** Mount the lines from `id` on. */
  mountFrom: (id: string) => void;
  /** Something else decides where the chat opens (a search hit). */
  skip?: boolean;
  /** Changes when a new last line arrives. */
  lastKey: string;
}

const LINES = '[data-message-ids]';

/** The line at the top of the view, and how far below the view's top it sits. */
function topLine(scroller: HTMLElement, lines: HTMLElement): ReadTo | null {
  const top = scroller.getBoundingClientRect().top;
  for (const el of lines.querySelectorAll<HTMLElement>(LINES)) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const id = el.dataset.messageIds?.split(' ')[0];
    return id ? { id, offset: rect.top - top } : null;
  }
  return null;
}

/**
 * A chat reopens where it was read to after a restart: the line that was at
 * the top of the view goes back there, once per launch. At the newest line
 * (or with that line gone) it opens at the newest line, as always.
 * `onScrolled` is the chat's scroll handler's: it notes the place, a moment
 * after the scrolling stops.
 */
export function useChatReadTo({
  chatKey,
  ready,
  scrollRef,
  messagesRef,
  atBottomRef,
  setAtBottom,
  indexOf,
  startIndex,
  mountFrom,
  skip,
  lastKey,
}: Options): { onScrolled: () => void } {
  // Until the place is put back, nothing is noted: landing on the newest
  // line first would forget it.
  const pending = useRef<ReadTo | null | undefined>(undefined);
  if (pending.current === undefined && !restored.has(chatKey)) {
    pending.current = readTo(chatKey);
  }
  const settled = useRef(restored.has(chatKey));

  useLayoutEffect(() => {
    if (settled.current || !ready) return;
    const at = pending.current;
    const done = () => {
      settled.current = true;
      pending.current = null;
      restored.add(chatKey);
    };
    if (!at || skip) return done();
    const scroller = scrollRef.current;
    const lines = messagesRef.current;
    if (!scroller || !lines) return;
    const target = lines.querySelector<HTMLElement>(`[data-message-ids~="${CSS.escape(at.id)}"]`);
    if (!target) {
      const index = indexOf(at.id);
      // Loaded but above what's mounted: mount from it, then come back here.
      if (index >= 0 && index < startIndex) return mountFrom(at.id);
      // Gone, or older than what's loaded: the newest line, as always.
      return done();
    }
    const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    atBottomRef.current = false;
    scroller.scrollTop += offset - at.offset;
    setAtBottom(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 1);
    done();
  });

  const note = useCallback(() => {
    const scroller = scrollRef.current;
    const lines = messagesRef.current;
    if (!settled.current || !scroller || !lines) return;
    keepReadTo(chatKey, atBottomRef.current ? null : topLine(scroller, lines));
  }, [chatKey, scrollRef, messagesRef, atBottomRef]);

  // A new last line with the chat following it (you sent something, or a
  // reply came while you were at the bottom): back at the newest line, even
  // though a glide there isn't a scroll the chat notes.
  useEffect(() => {
    if (settled.current && atBottomRef.current) keepReadTo(chatKey, null);
  }, [chatKey, lastKey, atBottomRef]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Leaving the chat (another agent, a project) notes where it was: before
  // its lines leave the page, so in a layout effect's cleanup.
  const noteRef = useRef(note);
  noteRef.current = note;
  useLayoutEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      noteRef.current();
    },
    []
  );
  const onScrolled = useCallback(() => {
    if (!settled.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      note();
    }, 150);
  }, [note]);

  return { onScrolled };
}
