/**
 * Marks an element `data-offscreen` while none of it is in view, so its CSS
 * loops can hold still (`[data-offscreen] * { animation-play-state: paused }`).
 * One IntersectionObserver for every element watched, app-wide: a sidebar of
 * working loaders scrolled out of sight costs nothing.
 *
 * @module lib/offscreen
 */

const changed = new WeakMap<Element, (offscreen: boolean) => void>();
let observer: IntersectionObserver | null = null;

/** Watch `el`; `onChange` hears each flip. Returns the unwatch. */
export function watchOffscreen(el: Element, onChange?: (offscreen: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) e.target.removeAttribute('data-offscreen');
      else e.target.setAttribute('data-offscreen', '');
      changed.get(e.target)?.(!e.isIntersecting);
    }
  });
  if (onChange) changed.set(el, onChange);
  observer.observe(el);
  return () => {
    observer?.unobserve(el);
    changed.delete(el);
  };
}
