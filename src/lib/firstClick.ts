/**
 * Was this click the one that brought the window forward?
 *
 * Every window accepts the first mouse (`accept_first_mouse` in Rust), so a
 * click on an unfocused window both focuses it and acts, like Slack or Linear.
 * That's right for almost everything, and wrong for an answer that can't be
 * taken back: a click meant only to bring the app forward must never Allow a
 * card or Keep a copy that happened to be under the cursor.
 *
 * A focus click is a pointer that went down while the window was in the
 * background (it blurred and hasn't come back), or within [`FOCUS_GRACE_MS`]
 * of it coming forward. Guarded buttons ignore it, say so
 * ([`FOCUS_CLICK_NOTE`]), and the next click acts.
 *
 * Only the window's own blur and focus events count. `document.hasFocus()`
 * used to decide it too, and in the app's webview it answers false now and
 * then with the window plainly in front (after a native menu, the title bar,
 * a sheet), which silently ate clicks on Keep changes and Allow.
 *
 * @module lib/firstClick
 */

export const FOCUS_GRACE_MS = 250;

/** What a guarded button says when it let a click go by. */
export const FOCUS_CLICK_NOTE = 'That click brought the window forward. Click again.';

let focusedAt = Number.NEGATIVE_INFINITY;
let inBackground = false;
let lastPointerWasFocusClick = false;
let installed = false;

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('blur', () => {
    inBackground = true;
  });
  window.addEventListener('focus', () => {
    inBackground = false;
    focusedAt = performance.now();
  });
  window.addEventListener(
    'pointerdown',
    () => {
      lastPointerWasFocusClick = inBackground || performance.now() - focusedAt < FOCUS_GRACE_MS;
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
  inBackground = false;
  lastPointerWasFocusClick = false;
}
