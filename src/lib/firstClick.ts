/**
 * Was this click the one that brought the window forward?
 *
 * Every window accepts the first mouse (`accept_first_mouse` in Rust), so a
 * click on an unfocused window both focuses it and acts, like Slack or Linear.
 * That's right for almost everything, and wrong for an answer that can't be
 * taken back: a click meant only to bring the app forward must never Allow a
 * card or Keep a copy that happened to be under the cursor.
 *
 * The pointer that went down within [`FOCUS_GRACE_MS`] of the window gaining
 * focus, or while the document didn't have it, is a focus click. Guarded
 * buttons ignore it; the next click acts.
 *
 * @module lib/firstClick
 */

export const FOCUS_GRACE_MS = 250;

let focusedAt = Number.NEGATIVE_INFINITY;
let lastPointerWasFocusClick = false;
let installed = false;

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('focus', () => {
    focusedAt = performance.now();
  });
  window.addEventListener(
    'pointerdown',
    () => {
      const hadFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      lastPointerWasFocusClick = !hadFocus || performance.now() - focusedAt < FOCUS_GRACE_MS;
    },
    { capture: true }
  );
}

install();

/**
 * True when `event` is a pointer click that only brought the window forward.
 * Keyboard activations (`detail === 0`) never are.
 */
export function isFocusClick(event: { detail: number }): boolean {
  return event.detail !== 0 && lastPointerWasFocusClick;
}

/** Tests only. */
export function __resetFirstClick() {
  focusedAt = Number.NEGATIVE_INFINITY;
  lastPointerWasFocusClick = false;
}
