/**
 * Runs `onSized` once the element has a layout box (width and height above
 * zero), and returns a cleanup that stops waiting.
 *
 * A pane that's kept mounted but hidden (display: none) has no box, and it can
 * stay that way for as long as it's hidden. Polling every frame until then
 * forced a layout on every frame of the app for as long as it took, so the
 * wait is a ResizeObserver instead: it reports only when the box changes.
 * Engines without ResizeObserver fall back to polling.
 *
 * @module lib/whenSized
 */

export function whenSized(el: Element, onSized: () => void): () => void {
  const isSized = () => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  if (isSized()) {
    onSized();
    return () => {};
  }
  if (typeof ResizeObserver === 'undefined') {
    let frame = 0;
    const poll = () => {
      frame = 0;
      if (isSized()) onSized();
      else frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }
  const observer = new ResizeObserver(() => {
    if (!isSized()) return;
    observer.disconnect();
    onSized();
  });
  observer.observe(el);
  return () => observer.disconnect();
}
