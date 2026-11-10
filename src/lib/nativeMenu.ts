/**
 * The macOS menu bar, from the page's side (`src-tauri/src/app_menu.rs`).
 *
 * - A menu choice arrives as one `menu://action` event, sent to the focused
 *   window only, with the item's id as its payload. {@link onMenuAction}
 *   listens for this window alone: a plain `listen` would also hear choices
 *   meant for another window.
 * - On macOS the menu owns its keys ({@link menuOwnsShortcuts}): a page key
 *   handler for one of them steps aside, so the press acts once and still
 *   works with the preview's iframe focused. In a browser (the UI harness)
 *   and on other platforms the page keeps its own handlers.
 * - The page says where this window is ({@link reportMenuContext}) so items
 *   that don't apply are greyed out and ⌘1…⌘9 carry names.
 *
 * The full key map is docs/keyboard-shortcuts.md.
 *
 * @module lib/nativeMenu
 */

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isMac } from './setup';
import { logger } from './logger';

export const MENU_ACTION_EVENT = 'menu://action';

/** True where the native menu bar answers its own keys: the macOS app. */
export function menuOwnsShortcuts(): boolean {
  return isMac() && isTauri();
}

/** Handlers in this window, for {@link runMenuAction}. */
const local = new Set<(action: string) => void>();

/**
 * Do what a menu item does, from the page (the palette's twin of an item):
 * the same handlers hear it, on every platform and in the harness.
 */
export function runMenuAction(action: string): void {
  for (const handler of [...local]) handler(action);
}

/**
 * Hear this window's menu choices (and {@link runMenuAction}). Returns an
 * unsubscribe that is safe to call before the listener has finished
 * registering.
 */
export function onMenuAction(handler: (action: string) => void): () => void {
  local.add(handler);
  let off: (() => void) | null = null;
  let done = false;
  let label = 'main';
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    // No window (a unit test without mocks): the default is fine.
  }
  void listen<string>(MENU_ACTION_EVENT, (event) => handler(event.payload), {
    target: { kind: 'WebviewWindow', label },
  })
    .then((fn) => {
      if (done) fn();
      else off = fn;
    })
    .catch((err: unknown) => logger.warn('[nativeMenu] listen failed', { error: String(err) }));
  return () => {
    local.delete(handler);
    done = true;
    off?.();
  };
}

/** `go_to_3` → 3 for prefix `go_to`; null for anything else. */
export function menuNumber(action: string, prefix: string): number | null {
  if (!action.startsWith(`${prefix}_`)) return null;
  const n = Number(action.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : null;
}

export interface MenuContext {
  /** `agents`, `projects`, `workspace`, or `other` (onboarding, loading). */
  view: string;
  /** A web preview is showing (Capture / Crop Preview). */
  preview: boolean;
  /** An agent's chat is open (New Conversation). */
  conversation: boolean;
  /** What ⌘1…⌘9 open, in order. */
  goTo: string[];
}

let context: MenuContext = { view: 'other', preview: false, conversation: false, goTo: [] };
let sent = '';
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  // The menu bar is about the focused window; one behind it keeps what it
  // would say for when it comes forward (`resendMenuContext`).
  if (typeof document !== 'undefined' && !document.hasFocus()) return;
  const body = JSON.stringify(context);
  if (body === sent) return;
  sent = body;
  invoke('set_menu_context', { context }).catch((err: unknown) =>
    logger.warn('[nativeMenu] set_menu_context failed', { error: String(err) })
  );
}

/**
 * Tell the menu bar about this window (merged with what other parts said).
 * Sent at most once a frame, and only when something changed.
 */
export function reportMenuContext(part: Partial<MenuContext>): void {
  if (!menuOwnsShortcuts()) return;
  context = { ...context, ...part };
  if (timer === null) timer = setTimeout(flush, 16);
}

/** This window came forward: the menu bar is about it again. */
export function resendMenuContext(): void {
  if (!menuOwnsShortcuts()) return;
  sent = '';
  if (timer === null) timer = setTimeout(flush, 16);
}
