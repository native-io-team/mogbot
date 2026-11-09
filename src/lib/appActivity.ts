/**
 * Whether anyone can see this window, and whether it is the one in front.
 *
 * Two states, one source, so every timer and animation asks the same question:
 *
 * - **hidden**: minimised, on another Space, closed to the menu bar, or fully
 *   covered (WebKit reports occlusion as `visibilityState === 'hidden'`).
 *   Nothing on screen can change, so polling for the screen stops
 *   (`usePolling`) and every loop holds still.
 * - **background**: visible, but another app (or another of our windows) has
 *   focus. The window still updates (someone may be watching it on a second
 *   screen), but purely decorative motion holds still: the working line's
 *   shimmer.
 *
 * Mirrored onto the root element as `data-app-hidden` and `data-app-background`
 * so the CSS can pause loops without any JavaScript per element.
 *
 * Focus moving into one of our own iframes (the preview) blurs the window but
 * the document keeps focus, so that is not "background".
 *
 * @module lib/appActivity
 */

export interface AppActivity {
  hidden: boolean;
  background: boolean;
}

let state: AppActivity = { hidden: false, background: false };
const listeners = new Set<(s: AppActivity) => void>();
let installed = false;

function set(next: AppActivity): void {
  if (next.hidden === state.hidden && next.background === state.background) return;
  state = next;
  const root = document.documentElement;
  root.toggleAttribute('data-app-hidden', next.hidden);
  root.toggleAttribute('data-app-background', next.background || next.hidden);
  for (const l of [...listeners]) l(state);
}

function install(): void {
  if (installed || typeof document === 'undefined' || typeof window === 'undefined') return;
  installed = true;
  const hidden = () => document.visibilityState === 'hidden';
  // Background only on a blur we saw: at launch `hasFocus()` can be false
  // before the window is shown, and a headless page never has focus.
  let blurred = false;
  const update = () => set({ hidden: hidden(), background: blurred });
  document.addEventListener('visibilitychange', update);
  window.addEventListener('focus', () => {
    blurred = false;
    update();
  });
  window.addEventListener('blur', () => {
    // After the event: focus going into one of our iframes keeps the document's.
    setTimeout(() => {
      blurred = !document.hasFocus();
      update();
    }, 0);
  });
  update();
}

// Installed on import (main.tsx imports this first).
install();

/** The state now. */
export function appActivity(): AppActivity {
  install();
  return state;
}

/** True while nothing should move: hidden, or decorative motion in the background. */
export function appQuiet(): boolean {
  const s = appActivity();
  return s.hidden || s.background;
}

/** Told on every change; returns the unsubscribe. */
export function onAppActivity(fn: (s: AppActivity) => void): () => void {
  install();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: forget subscribers (the window listeners stay, installed once). */
export function resetAppActivityForTests(): void {
  listeners.clear();
}
