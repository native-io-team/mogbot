/**
 * The conversation column's width: Narrow (default), Medium or Wide.
 *
 * Like the theme (lib/theme.ts) it is one attribute, `data-chat-width` on
 * `<html>`, and the stylesheets do the rest: agents.css sets the column's
 * width per value, and agents-chat.css drops the agent's reply bubble when
 * the column is wider than Narrow (a tinted block 1400px wide reads as a
 * panel, not a message). Narrow is the original 720px column, unchanged.
 *
 * Persistence is the app settings file (`get_chat_width` / `set_chat_width`
 * in settings.rs). The last choice is also cached in localStorage so the
 * attribute is set before the first render, and its `storage` event is how
 * other windows follow a change made in one of them.
 *
 * @module lib/chatWidth
 */

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type ChatWidth = 'narrow' | 'medium' | 'wide';

export const CHAT_WIDTHS: readonly ChatWidth[] = ['narrow', 'medium', 'wide'];

export const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  narrow: 'Narrow',
  medium: 'Medium',
  wide: 'Wide',
};

/** localStorage key for the cache read before the first render. */
export const CHAT_WIDTH_CACHE_KEY = 'app.chatWidth';

export const isChatWidth = (value: unknown): value is ChatWidth =>
  typeof value === 'string' && (CHAT_WIDTHS as readonly string[]).includes(value);

let width: ChatWidth = 'narrow';
let initialized = false;
const listeners = new Set<() => void>();

function readCached(): ChatWidth {
  try {
    const raw = localStorage.getItem(CHAT_WIDTH_CACHE_KEY);
    return isChatWidth(raw) ? raw : 'narrow';
  } catch {
    return 'narrow';
  }
}

function apply(next: ChatWidth, cache = true) {
  const changed = next !== width;
  width = next;
  document.documentElement.setAttribute('data-chat-width', next);
  if (cache) {
    try {
      localStorage.setItem(CHAT_WIDTH_CACHE_KEY, next);
    } catch {
      /* blocked storage: only the next launch's first frame is narrow */
    }
  }
  if (changed) for (const listener of listeners) listener();
}

export function getChatWidth(): ChatWidth {
  return width;
}

export function subscribeChatWidth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Apply the cached width, follow other windows, then reconcile with the
 * saved setting. Idempotent.
 */
export function initChatWidth() {
  if (initialized) return;
  initialized = true;
  apply(readCached(), false);
  window.addEventListener('storage', (event) => {
    if (event.key === CHAT_WIDTH_CACHE_KEY && isChatWidth(event.newValue)) {
      apply(event.newValue, false);
    }
  });
  void invoke<string>('get_chat_width')
    .then((saved) => {
      if (isChatWidth(saved)) apply(saved);
    })
    .catch(() => {
      /* settings unavailable: the cached width stands */
    });
}

/** Choose a width: applies at once, then saves it. Rejects if saving failed. */
export async function setChatWidth(next: ChatWidth): Promise<void> {
  const previous = width;
  apply(next);
  try {
    await invoke('set_chat_width', { width: next });
  } catch (error) {
    apply(previous);
    throw error;
  }
}

/** The chosen width, re-rendering when it changes. */
export function useChatWidth(): ChatWidth {
  return useSyncExternalStore(subscribeChatWidth, getChatWidth, getChatWidth);
}

/** Test-only: forget module state. */
export function __resetChatWidthForTests() {
  initialized = false;
  width = 'narrow';
  listeners.clear();
  document.documentElement.removeAttribute('data-chat-width');
}
