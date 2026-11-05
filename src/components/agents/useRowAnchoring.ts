/**
 * Keep what you're reading still while lines above it change height.
 *
 * Chat lines out of view are skipped (`content-visibility: auto`,
 * features/agents-chat-history.css) and stand in at an estimated height until
 * they're first drawn. Scrolling up draws them just above the viewport, and
 * each one's real height pushes everything below it down. Chromium corrects
 * for that itself (scroll anchoring); WebKit has no scroll anchoring, so
 * without this the conversation would jump on every line as you scroll up.
 *
 * Only where the browser can't anchor: elsewhere it does nothing, and the
 * browser's own correction is not doubled.
 *
 * @module components/agents/useRowAnchoring
 */

import { useEffect, type RefObject } from 'react';

export const browserAnchorsScroll = (): boolean =>
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('overflow-anchor', 'auto');

/**
 * Watch the rows of `contentRef` (its children, as they come and go) and, when
 * one wholly above the scroller's top edge changes height, move the scroll by
 * the same amount.
 */
export function useRowAnchoring(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  enabled = !browserAnchorsScroll()
): void {
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !scroller || !content || typeof ResizeObserver === 'undefined') return;
    const heights = new WeakMap<Element, number>();
    const resizes = new ResizeObserver((entries) => {
      const top = scroller.getBoundingClientRect().top;
      let shift = 0;
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        const before = heights.get(entry.target);
        heights.set(entry.target, height);
        // The first report is where it starts, not a change.
        if (before === undefined || before === height) continue;
        // Above the viewport: its bottom (at the new height) is above the top edge.
        if (entry.target.getBoundingClientRect().bottom <= top) shift += height - before;
      }
      if (shift !== 0) scroller.scrollTop += shift;
    });
    for (const row of content.children) resizes.observe(row);
    const rows = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) resizes.observe(node);
        });
      }
    });
    rows.observe(content, { childList: true });
    return () => {
      rows.disconnect();
      resizes.disconnect();
    };
  }, [scrollRef, contentRef, enabled]);
}
