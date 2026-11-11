/**
 * Moving the window by its top edge, on every screen.
 *
 * On macOS the window draws its own title bar (`TitleBarStyle::Overlay`), so
 * nothing native is there to grab: the page has to ask Tauri to start the
 * drag. Screens used to wire this up one by one, and Agents (where the app
 * opens) never did, so the window could only be resized. Now one listener
 * does it for every window:
 *
 * - anything inside an element marked `data-window-drag` (headers, sidebar
 *   top rows), and, on macOS, anywhere in the strip the title bar would
 *   occupy ([`TITLEBAR_STRIP_PX`]), starts a drag;
 * - a double click there zooms, like a native title bar;
 * - controls never do: buttons, links, fields, menus, tabs, sliders, the
 *   terminal, frames, and anything marked `data-no-window-drag`.
 *
 * Windows and Linux keep their native title bar, so only marked zones drag
 * there. A handler that already started a drag (`preventDefault`) wins.
 *
 * @module lib/windowDrag
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

/** The traffic lights' title bar height (lib.rs `traffic_light_position`). */
export const TITLEBAR_STRIP_PX = 46;

/** What a press on must never move the window. */
export const NO_DRAG_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  'iframe',
  'video',
  '[contenteditable]:not([contenteditable="false"])',
  '[draggable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="dialog"]',
  '.xterm',
  '[data-no-window-drag]',
].join(', ');

export interface DragPress {
  button: number;
  clientY: number;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Should this press on `target` move the window? Pure, for tests. */
export function shouldDragWindow(
  target: Element | null,
  press: DragPress,
  topStrip: boolean
): boolean {
  if (!target || press.button !== 0 || press.defaultPrevented) return false;
  if (press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return false;
  if (target.closest(NO_DRAG_SELECTOR)) return false;
  if (target.closest('[data-window-drag]')) return true;
  return topStrip && press.clientY >= 0 && press.clientY < TITLEBAR_STRIP_PX;
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let installed = false;

/** Listen once per window. A no-op outside the app (the harness, tests). */
export function installWindowDrag(): void {
  if (installed || !inTauri()) return;
  installed = true;
  const topStrip = isMac();
  const targetOf = (e: Event) => (e.target instanceof Element ? e.target : null);

  document.addEventListener('mousedown', (e) => {
    if (e.detail > 1) return; // the second press of a double click zooms instead
    if (!shouldDragWindow(targetOf(e), e, topStrip)) return;
    e.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch(() => undefined);
  });

  document.addEventListener('dblclick', (e) => {
    if (!shouldDragWindow(targetOf(e), { ...pressOf(e), defaultPrevented: false }, topStrip))
      return;
    const win = getCurrentWindow();
    void win
      .isMaximized()
      .then((max) => (max ? win.unmaximize() : win.maximize()))
      .catch(() => undefined);
  });
}

function pressOf(e: MouseEvent): DragPress {
  return {
    button: e.button,
    clientY: e.clientY,
    defaultPrevented: e.defaultPrevented,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
  };
}
