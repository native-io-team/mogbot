/**
 * Keep React from listening for `animationiteration`.
 *
 * React delegates every event it supports from each root (and portal)
 * container, `animationiteration` included, whether or not any component has
 * an `onAnimationIteration`. A browser can only hand an infinite CSS animation
 * to the compositor if nobody needs to hear each iteration: with a listener
 * anywhere in the document, Chrome ticks every running animation on the main
 * thread, every frame, and recalculates the style of each one. Measured in the
 * harness, six working agents' loaders (150 pulsing pixels) then cost about
 * 10% of the main thread with nothing else happening; without the listener,
 * nothing (docs/ui-harness.md, "Measuring performance").
 *
 * No component here uses `onAnimationIteration`, so the delegated listener
 * only ever cost. A React `onAnimationIteration` prop would silently never
 * fire (this includes plugins, which render with the app's React); the test
 * file scans src/ for one and fails if it appears. This drops React's registration of it, and only React's:
 * a container React has claimed carries its `_reactListening…` marker before
 * it adds its listeners, and every other `addEventListener` call goes through
 * untouched. A component that needs an iteration event should add its own
 * native listener to its element, which still works.
 *
 * Imported for its effect, before any React root is created.
 *
 * @module lib/noAnimationIterationListeners
 */

const ITERATION_EVENTS = new Set([
  'animationiteration',
  'webkitAnimationIteration',
  'MSAnimationIteration',
]);

/**
 * React marks a container it is about to listen on with `_reactListening<random>`
 * (react-dom's `listenToAllSupportedEvents`). That is a react-dom internal: if a
 * React upgrade renames it or sets it later, this matches nothing and the
 * patch quietly does nothing — the animations cost main-thread time again, but
 * nothing breaks. `noAnimationIterationListeners.test.ts` renders a real root
 * and fails loudly when that happens, so the regression is seen, not shipped.
 *
 * Only elements: React also marks the document (for `selectionchange`), and a
 * library's own document-level iteration listener must not be dropped.
 */
export function isReactContainer(target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Object.keys(target).some((key) => key.startsWith('_reactListening'));
}

const PATCHED = Symbol.for('shipstudio.noAnimationIterationListeners');

export function installNoAnimationIterationListeners(): void {
  if (typeof EventTarget === 'undefined') return;
  const proto = EventTarget.prototype as EventTarget & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the caller's `this` below
  const add = proto.addEventListener;
  proto.addEventListener = function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (ITERATION_EVENTS.has(type) && isReactContainer(this)) return;
    Reflect.apply(add, this, [type, listener, options]);
  };
  proto[PATCHED] = true;
}

installNoAnimationIterationListeners();
