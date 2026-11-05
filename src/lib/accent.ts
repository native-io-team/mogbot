/**
 * The accent: the one colour in an otherwise monochrome app.
 *
 * The app-wide accent IS the Chief of Staff's colour — there is no separate
 * setting to drift out of sync with it. Settings → Appearance → "Accent
 * colour" edits the Chief's registry colour; this module reads it back and
 * writes it onto `<html>`. Inside another agent's conversation the accent is
 * that agent's colour instead, via a scoped accent (`accentScopeProps`).
 *
 * Only three values are ever written, all as inline custom properties:
 *
 * - `--accent-user`     the colour itself
 * - `--accent-on-user`  ink that reads on it (black or white, by WCAG contrast)
 * - `--accent-user-rgb` an `r, g, b` triplet, only so the plugin-stable
 *                       `--action-rgb` keeps working for `rgba()` tints
 *
 * Everything else is derived in CSS (tokens-semantic.css, "THE ACCENT").
 *
 * @module lib/accent
 */

import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { AGENT_COLORS, type AgentColor } from './agents';
import { useAgentsSelector } from './agentsStore';

/**
 * Hex for each agent colour key. Mirrors `--agents-tint-*` in
 * src/styles/features/agents.css (the avatar tints) and the default in
 * tokens-core.css (`--color-accent-default`); accent.test.ts holds them in sync.
 */
export const ACCENT_PALETTE: Record<AgentColor, string> = {
  white: '#e6e6e6',
  brown: '#b08560',
  red: '#ef5b50',
  orange: '#f07c3c',
  amber: '#e9a83a',
  green: '#3fbf6a',
  teal: '#2fb3a1',
  blue: '#4d8ff5',
  purple: '#9471f5',
  pink: '#e45a9f',
  gray: '#8a8a8a',
};

/** The Chief of Staff's default colour, and so the app's default accent. */
export const DEFAULT_ACCENT: AgentColor = 'white';

/** Display names for the colour keys, for pickers and announcements. */
export const ACCENT_LABELS: Record<AgentColor, string> = {
  white: 'White',
  brown: 'Brown',
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  gray: 'Gray',
};

/** Ink candidates for text on the accent. Dark matches `--color-gray-950`. */
export const ON_ACCENT_DARK = '#141414';
export const ON_ACCENT_LIGHT = '#ffffff';

/** localStorage key for the boot cache read by the inline script in index.html. */
export const ACCENT_CACHE_KEY = 'app.accent';

export type Rgb = readonly [number, number, number];

export interface AccentVars {
  '--accent-user': string;
  '--accent-on-user': string;
  '--accent-user-rgb': string;
}

export const isAccentKey = (value: unknown): value is AgentColor =>
  typeof value === 'string' && (AGENT_COLORS as readonly string[]).includes(value);

/** Hex for a colour key; anything unknown (an old or hand-edited registry) is the default. */
export function accentHex(key: string | null | undefined): string {
  return isAccentKey(key) ? ACCENT_PALETTE[key] : ACCENT_PALETTE[DEFAULT_ACCENT];
}

/** `#rgb` / `#rrggbb` → [r, g, b], or null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const digits =
    m[1].length === 3
      ? m[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1];
  const n = parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** WCAG 2.x relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1 … 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The ink (dark or light) with the higher contrast on `hex`. */
export function pickOnAccent(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return ON_ACCENT_DARK;
  const dark = contrastRatio(rgb, parseHex(ON_ACCENT_DARK)!);
  const light = contrastRatio(rgb, parseHex(ON_ACCENT_LIGHT)!);
  return light > dark ? ON_ACCENT_LIGHT : ON_ACCENT_DARK;
}

/** Linear sRGB-space mix: `t` = 0 is `a`, 1 is `b`. For places CSS color-mix can't reach. */
export function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const k = Math.min(1, Math.max(0, t));
  const at = (i: 0 | 1 | 2) => x[i] + (y[i] - x[i]) * k;
  return toHex([at(0), at(1), at(2)]);
}

/** The three runtime inputs for a colour key. */
export function accentVars(key: string | null | undefined): AccentVars {
  const hex = accentHex(key);
  const [r, g, b] = parseHex(hex)!;
  return {
    '--accent-user': hex,
    '--accent-on-user': pickOnAccent(hex),
    '--accent-user-rgb': `${r}, ${g}, ${b}`,
  };
}

/** Write an accent onto an element (default `<html>`). */
export function applyAccentVars(vars: AccentVars, el: HTMLElement = document.documentElement) {
  for (const name of Object.keys(vars) as (keyof AccentVars)[]) {
    el.style.setProperty(name, vars[name]);
  }
}

/**
 * Remember the app accent for the next boot. index.html applies it from an
 * inline script before the bundle loads, so a window never paints in the
 * default colour and then flips. Storage can be unavailable; that only costs
 * the first frame.
 */
export function cacheAccentVars(vars: AccentVars) {
  try {
    localStorage.setItem(ACCENT_CACHE_KEY, JSON.stringify(vars));
  } catch {
    /* private mode / blocked storage — the registry is the source of truth */
  }
}

/**
 * Props that give an element its own accent: spread onto a container and
 * everything inside it (primary buttons, tints, selection) takes that colour.
 * `data-accent-scope` makes the CSS re-derive the accent roles there.
 */
export function accentScopeProps(key: string | null | undefined): {
  'data-accent-scope': string;
  style: CSSProperties;
} {
  return {
    'data-accent-scope': isAccentKey(key) ? key : DEFAULT_ACCENT,
    style: accentVars(key) as unknown as CSSProperties,
  };
}

/** `accentScopeProps`, memoised on the key. */
export function useAccentScope(key: string | null | undefined) {
  return useMemo(() => accentScopeProps(key), [key]);
}

const selectChiefColor = (s: { agents: { isMain: boolean; color: string }[]; loaded: boolean }) =>
  s.loaded ? (s.agents.find((a) => a.isMain)?.color ?? null) : null;

/**
 * The Chief of Staff's colour key, or null until the registry has loaded (so
 * callers keep whatever the boot cache applied instead of flashing the default).
 */
export function useChiefColor(): string | null {
  return useAgentsSelector(selectChiefColor);
}

/** The app accent as hex, for the few consumers that need a literal colour. */
export function useAppAccentHex(): string {
  const chief = useChiefColor();
  if (chief !== null) return accentHex(chief);
  return readCachedAccent()?.['--accent-user'] ?? accentHex(null);
}

/** The cached app accent, if one was saved and is still well-formed. */
export function readCachedAccent(): AccentVars | null {
  try {
    const raw = localStorage.getItem(ACCENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccentVars>;
    if (typeof parsed['--accent-user'] !== 'string' || !parseHex(parsed['--accent-user'])) {
      return null;
    }
    return parsed as AccentVars;
  } catch {
    return null;
  }
}

/** Keep `<html>`'s accent equal to the Chief of Staff's colour, in every window. */
export function useAppAccent() {
  const chief = useChiefColor();
  useEffect(() => {
    if (chief === null) return;
    const vars = accentVars(chief);
    applyAccentVars(vars);
    cacheAccentVars(vars);
  }, [chief]);
}
