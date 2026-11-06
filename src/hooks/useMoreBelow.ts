import { useCallback, useEffect, useRef } from 'react';

/**
 * Marks a scroll box with `data-more-below` while real content is hidden
 * under its bottom edge, so CSS can fade that edge only then.
 *
 * The box's bottom padding doesn't count: a list that only hides its own
 * padding has nothing below it, and fading its last rows there made them look
 * disabled. Returns a callback ref.
 */
export function moreBelow(el: HTMLElement): boolean {
  const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight > pad + 1;
}

export function useMoreBelow<T extends HTMLElement>(): (el: T | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.toggleAttribute('data-more-below', moreBelow(el));
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(el);
    const mutate = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    mutate?.observe(el, { childList: true, subtree: true });
    cleanup.current = () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', update);
      resize?.disconnect();
      mutate?.disconnect();
    };
  }, []);
}
