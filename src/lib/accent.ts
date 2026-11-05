/**
 * The accent: the one colour in an otherwise monochrome app.
 *
 * The app-wide accent IS the Chief of Staff's colour — there is no separate
 * setting to drift out of sync with it. Settings → Appearance → "Accent
 * colour" edits the Chief's registry colour; this module reads it back and
 * writes it onto `<html>`. Inside another agent's conversation the accent is
 * that agent's colour instead, via a scoped accent (`accentScopeProps`).
 *
 * The colour and everything derived from it are computed HERE and written as
 * inline custom properties, as finished hex values:
 *
 * - `--accent-user`        the colour itself
 * - `--accent-on-user`     ink that reads on it (black or white, by WCAG contrast)
 * - `--accent-user-rgb`    an `r, g, b` triplet, only so the plugin-stable
 *                          `--action-rgb` keeps working for `rgba()` tints
 * - `--accent-user-hover`  hover fill
 * - `--accent-user-strong` pressed / busy fill
 * - `--accent-user-start`  the primary gradient's lower stop
 * - `--accent-user-end`    the primary gradient's lighter (hover) stop
 *
 * Why not derive the shades with CSS `color-mix()`? Two reasons. A WebView
 * without `color-mix()` (Safari 15, which macOS 12 can still ship) drops the
 * whole declaration, so a primary button lost its fill while keeping its dark
 * label — invisible text. And the ink has to be checked against every fill it
 * sits on, not just the base colour, which needs the actual colours: each
 * shade here is pulled the other way (lighter instead of darker) whenever the
 * usual direction would take it under WCAG AA against the ink.
 *
 * Only theme-relative tints (an accent mixed with a surface or text token)
 * stay in CSS, behind `@supports (color: color-mix(...))` with a plain
 * fallback (tokens-semantic.css, "THE ACCENT").
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
  '--accent-user-hover': string;
  '--accent-user-strong': string;
  '--accent-user-start': string;
  '--accent-user-end': string;
}

/** The precomputed shades, each a `#rrggbb` hex. */
export const ACCENT_SHADE_VARS = [
  '--accent-user-hover',
  '--accent-user-strong',
  '--accent-user-start',
  '--accent-user-end',
] as const;

/** Every var accentVars writes, in the order the boot script validates them. */
export const ACCENT_VAR_NAMES = [
  '--accent-user',
  '--accent-on-user',
  '--accent-user-rgb',
  ...ACCENT_SHADE_VARS,
] as const;

/** WCAG AA for normal-size text. Every fill the accent ink sits on must clear it. */
export const AA_TEXT = 4.5;

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

// --- OKLab / OKLCH, so the shades match what `color-mix(in oklch, …)` produced.

type Lab = readonly [number, number, number];

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, c * 255));
};

function rgbToOklab([r, g, b]: Rgb): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * `color-mix(in oklch, hex p, black|white)` with p = 1 - amount. Black and
 * white have no hue, so the hue is kept and lightness/chroma interpolate —
 * which in OKLab is a straight scale of a and b.
 */
export function shadeOklch(hex: string, toward: 'black' | 'white', amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const k = 1 - Math.min(1, Math.max(0, amount));
  const [L, a, b] = rgbToOklab(rgb);
  const target = toward === 'black' ? 0 : 1;
  return toHex(oklabToRgb([L * k + target * (1 - k), a * k, b * k]));
}

/**
 * A shade of `hex` that keeps `ink` at WCAG AA.
 *
 * Moves `toward` by `amount`, clamped to the most it can move before the ink
 * drops under AA (dark ink on a darkened mid-tone accent is the case that
 * bites). If the clamp leaves less than `minShare` of the requested step —
 * too little to see — it moves the other way by the full amount instead, so a
 * hover or busy fill stays visibly different without the label fading.
 */
export function inkSafeShade(
  hex: string,
  ink: string,
  toward: 'black' | 'white',
  amount: number,
  minShare = 0.5,
): string {
  const inkRgb = parseHex(ink)!;
  const passes = (t: number) =>
    contrastRatio(parseHex(shadeOklch(hex, toward, t))!, inkRgb) >= AA_TEXT;
  if (passes(amount)) return shadeOklch(hex, toward, amount);
  let lo = 0;
  let hi = amount;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mid)) lo = mid;
    else hi = mid;
  }
  if (lo >= amount * minShare) return shadeOklch(hex, toward, lo);
  const other = shadeOklch(hex, toward === 'black' ? 'white' : 'black', amount);
  return contrastRatio(parseHex(other)!, inkRgb) >= AA_TEXT ? other : shadeOklch(hex, toward, lo);
}

/** The runtime inputs for a colour key: the colour, its ink, and its shades. */
export function accentVars(key: string | null | undefined): AccentVars {
  return accentVarsForHex(accentHex(key));
}

/** `accentVars` for a literal colour (tests and the CSS defaults use it). */
export function accentVarsForHex(hex: string): AccentVars {
  const [r, g, b] = parseHex(hex)!;
  const ink = pickOnAccent(hex);
  return {
    '--accent-user': hex,
    '--accent-on-user': ink,
    '--accent-user-rgb': `${r}, ${g}, ${b}`,
    // The amounts are the ones the CSS used to mix with; small on purpose — a
    // deep gradient on a white accent reads as grey and dirty rather than lit.
    '--accent-user-hover': inkSafeShade(hex, ink, 'black', 0.12),
    '--accent-user-strong': inkSafeShade(hex, ink, 'black', 0.28),
    '--accent-user-start': inkSafeShade(hex, ink, 'black', 0.1, 0),
    '--accent-user-end': inkSafeShade(hex, ink, 'white', 0.08),
  };
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const RGB_TRIPLET = /^\d{1,3}, \d{1,3}, \d{1,3}$/;

/** The same per-var validation the inline boot script in index.html applies. */
export function isValidAccentVar(name: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (name === '--accent-user-rgb') return RGB_TRIPLET.test(value);
  return (ACCENT_VAR_NAMES as readonly string[]).includes(name) && HEX6.test(value);
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

/**
 * The cached app accent, if one was saved and every value in it is
 * well-formed (same rules as the boot script). An entry from an older build
 * that lacks the shades is ignored rather than half-applied.
 */
export function readCachedAccent(): AccentVars | null {
  try {
    const raw = localStorage.getItem(ACCENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    for (const name of ACCENT_VAR_NAMES) {
      if (!isValidAccentVar(name, parsed[name])) return null;
    }
    return parsed as unknown as AccentVars;
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
