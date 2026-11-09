/**
 * The colour theme: System (default), Light or Dark.
 *
 * The theme is one attribute — `data-theme="light" | "dark"` on `<html>` —
 * and the stylesheets do the rest: `:root[data-theme='light']` in
 * tokens-semantic.css overrides the semantic roles, and components only ever
 * read those roles. Nothing else in the app switches on the theme except the
 * few things CSS can't reach (the xterm palette, the accent's precomputed
 * shades, the contribution calendar), which subscribe here.
 *
 * Persistence is the app settings file (`get_app_theme` / `set_app_theme` in
 * settings.rs). The last resolved preference is also cached in localStorage so
 * the inline boot script in index.html can set the attribute before the first
 * paint — a light window never flashes dark. That cache is shared by every
 * window (one origin), and its `storage` event is how the other windows follow
 * a change made in one of them.
 *
 * "System" follows `prefers-color-scheme`, live: WKWebView reports the window's
 * effective appearance, which tracks macOS unless the window was given an
 * explicit one (settings.rs only does that for Light / Dark).
 *
 * @module lib/theme
 */

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** localStorage key for the boot cache read by the inline script in index.html. */
export const THEME_CACHE_KEY = 'app.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);

/** What a preference paints, given whether the system is currently dark. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ?? true;
  } catch {
    return true;
  }
}

function readCachedPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function cachePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_CACHE_KEY, preference);
  } catch {
    /* blocked storage — only costs the next boot's first frame */
  }
}

let preference: ThemePreference = 'system';
let systemDark = true;
let resolved: ResolvedTheme = 'dark';
const listeners = new Set<() => void>();

/** The theme currently painted. Safe to call at module scope and in tests. */
export function getResolvedTheme(): ResolvedTheme {
  if (!initialized && typeof document !== 'undefined') {
    // Before initTheme, the boot script's attribute is the truth.
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
  }
  return resolved;
}

export function getThemePreference(): ThemePreference {
  return preference;
}

/** Put a resolved theme on `<html>`. Also sets `color-scheme` for native form controls. */
export function applyResolvedTheme(
  theme: ResolvedTheme,
  el: HTMLElement = document.documentElement
) {
  el.setAttribute('data-theme', theme);
  el.style.colorScheme = theme;
}

function recompute() {
  const next = resolveTheme(preference, systemDark);
  if (next === resolved && document.documentElement.getAttribute('data-theme') === next) return;
  resolved = next;
  applyResolvedTheme(next);
  for (const listener of listeners) listener();
}

function setPreferenceLocal(next: ThemePreference) {
  const changed = next !== preference;
  preference = next;
  cachePreference(next);
  recompute();
  if (changed) for (const listener of listeners) listener();
}

/** Subscribe to theme changes (preference or resolved). Returns an unsubscribe. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let initialized = false;

/**
 * Start following the theme: read the boot cache (already applied by
 * index.html), listen to the system appearance and to other windows, then
 * reconcile with the saved setting. Idempotent.
 */
export function initTheme() {
  if (initialized) return;
  initialized = true;
  preference = readCachedPreference();
  systemDark = systemPrefersDark();
  resolved = resolveTheme(preference, systemDark);
  applyResolvedTheme(resolved);

  try {
    const media = window.matchMedia?.(DARK_QUERY);
    media?.addEventListener?.('change', (event) => {
      systemDark = event.matches;
      recompute();
    });
  } catch {
    /* no matchMedia: System stays on its first answer */
  }

  window.addEventListener('storage', (event) => {
    if (event.key === THEME_CACHE_KEY && isThemePreference(event.newValue)) {
      preference = event.newValue;
      recompute();
      for (const listener of listeners) listener();
    }
  });

  // The Chief changed it from chat (`change_app_setting`).
  try {
    void listen<string>('app-theme-changed', (event) => {
      if (isThemePreference(event.payload) && event.payload !== preference) {
        setPreferenceLocal(event.payload);
      }
    }).catch(() => {});
  } catch {
    /* no event bridge (tests, the harness): Settings still works */
  }

  void invoke<string>('get_app_theme')
    .then((saved) => {
      if (isThemePreference(saved) && saved !== preference) setPreferenceLocal(saved);
    })
    .catch(() => {
      /* settings unavailable: the cached preference stands */
    });
}

/** Choose a theme: repaints at once, then persists it. Rejects if saving failed. */
export async function setThemePreference(next: ThemePreference): Promise<void> {
  const previous = preference;
  setPreferenceLocal(next);
  try {
    await invoke('set_app_theme', { theme: next });
  } catch (error) {
    setPreferenceLocal(previous);
    throw error;
  }
}

/** The theme currently painted, re-rendering when it changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, getResolvedTheme, getResolvedTheme);
}

/** The saved preference (System / Light / Dark), re-rendering when it changes. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference);
}

/** Test-only: forget module state. */
export function __resetThemeForTests() {
  initialized = false;
  preference = 'system';
  systemDark = true;
  resolved = 'dark';
  listeners.clear();
}
