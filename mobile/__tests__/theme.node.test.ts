/**
 * The palettes, held to what theme.ts promises: both appearances complete,
 * words that pass WCAG AA where they're read, accents that stay accents on
 * white, and no colour drawn anywhere but from theme.ts.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  agentTints,
  APPEARANCES,
  avatarSize,
  contrast,
  iconSize,
  luminance,
  palettes,
  radius,
  speakerInk,
  type Palette,
} from '../src/lib/theme';

const COLOUR = /^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\))$/;

/** Roles that may be no colour at all: a line light leaves out because its fill carries it. */
const MAY_BE_CLEAR = new Set<string>(['cardBorder', 'composerBorder']);

/** The surfaces words are read on: the app (chats, lists) and a panel (cards, sheets). */
const READ_ON = ['surfaceApp', 'surfacePanel'] as const;

/** Every role that carries words, not decoration. `textFaint` is decoration only. */
const WORDS = [
  'textStrong',
  'textBody',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'accentSuccess',
  'accentWarning',
  'accentError',
  'accentErrorLight',
  'accentFocus',
  'accentNeutral',
  'diffAdd',
  'diffDel',
] as const satisfies readonly (keyof Palette)[];

describe('palettes', () => {
  it('give both appearances every role, each a colour', () => {
    const keys = Object.keys(palettes.dark).sort();
    expect(Object.keys(palettes.light).sort()).toEqual(keys);
    for (const appearance of APPEARANCES) {
      for (const [role, value] of Object.entries(
        palettes[appearance] as unknown as Record<string, string>
      )) {
        const ok = COLOUR.test(value) || (MAY_BE_CLEAR.has(role) && value === 'transparent');
        expect([role, ok]).toEqual([role, true]);
      }
    }
  });

  it('draw every agent colour in both appearances', () => {
    expect(Object.keys(agentTints.light).sort()).toEqual(Object.keys(agentTints.dark).sort());
    for (const appearance of APPEARANCES) {
      for (const hex of Object.values(agentTints[appearance])) expect(hex).toMatch(COLOUR);
    }
  });

  it('are drawn for their appearance, not inverted: light surfaces are light', () => {
    for (const role of ['surfaceApp', 'surfacePanel', 'surfaceControl'] as const) {
      expect(luminance(palettes.light[role])).toBeGreaterThan(0.8);
      expect(luminance(palettes.dark[role])).toBeLessThan(0.05);
    }
    // Layering recesses in light (each step darker) and lifts in dark (each step lighter).
    const steps = ['surfaceApp', 'surfacePanel', 'surfaceControl', 'surfaceSelected'] as const;
    for (let i = 1; i < steps.length; i++) {
      expect(luminance(palettes.light[steps[i]])).toBeLessThan(
        luminance(palettes.light[steps[i - 1]])
      );
      expect(luminance(palettes.dark[steps[i]])).toBeGreaterThan(
        luminance(palettes.dark[steps[i - 1]])
      );
    }
  });

  it.each(APPEARANCES)('pass AA (4.5:1) for words on the app and a panel (%s)', (appearance) => {
    const c = palettes[appearance];
    for (const fg of WORDS) {
      for (const bg of READ_ON) {
        expect([fg, bg, contrast(c[fg], c[bg]) >= 4.5]).toEqual([fg, bg, true]);
      }
    }
  });

  it.each(APPEARANCES)(
    'pass AA for the quietest words where they sit on a fill: placeholders, metadata (%s)',
    (appearance) => {
      const c = palettes[appearance];
      // Placeholders sit in fields; metadata sits on controls and groups.
      for (const bg of ['surfaceControl', 'composerFill', 'inputFill', 'surfaceGroup'] as const) {
        expect([bg, contrast(c.textMuted, c[bg]) >= 4.5]).toEqual([bg, true]);
      }
      // What you type and what you read in a field.
      for (const bg of ['composerFill', 'inputFill', 'surfaceBubble'] as const) {
        expect([bg, contrast(c.textBody, c[bg]) >= 7]).toEqual([bg, true]);
      }
    }
  );

  it.each(APPEARANCES)('name borders by how much they show (%s)', (appearance) => {
    const c = palettes[appearance];
    const on = c.surfacePanel;
    // Default is the divider; subtle shows less; strong (interactive outlines) shows most.
    expect(contrast(c.borderDefault, on)).toBeGreaterThan(contrast(c.borderSubtle, on));
    expect(contrast(c.borderStrong, on)).toBeGreaterThan(contrast(c.borderDefault, on));
  });

  it.each(APPEARANCES)('pass AA for every agent colour as words (%s)', (appearance) => {
    const c = palettes[appearance];
    for (const [key, hex] of Object.entries(agentTints[appearance])) {
      for (const bg of READ_ON) {
        expect([key, bg, contrast(hex, c[bg]) >= 4.5]).toEqual([key, bg, true]);
      }
    }
  });

  it.each(APPEARANCES)('pass AA for words on a warning fill (%s)', (appearance) => {
    const c = palettes[appearance];
    expect(contrast(c.onWarning, c.accentWarning)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(APPEARANCES)(
    'make a selected chip or segment plain at a glance, and its words readable (%s)',
    (appearance) => {
      const c = palettes[appearance];
      expect(contrast(c.onSelectedFill, c.selectedFill)).toBeGreaterThanOrEqual(7);
      // Against the unselected ones beside it (a grey step on grey was 1.15:1).
      expect(contrast(c.selectedFill, c.surfaceControl)).toBeGreaterThanOrEqual(3);
      expect(contrast(c.selectedFill, c.surfacePanel)).toBeGreaterThanOrEqual(3);
    }
  );

  it('keep words on media white, over a dark scrim, in both appearances', () => {
    for (const appearance of APPEARANCES) {
      const c = palettes[appearance];
      expect(c.onMedia).toBe(palettes.dark.onMedia);
      expect(contrast(c.onMedia, c.black)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('light accents', () => {
  const c = palettes.light;

  it('make the neutral accent ink, not white: a white Chief on a white app would vanish', () => {
    expect(contrast(c.accentNeutral, c.surfaceApp)).toBeGreaterThanOrEqual(7);
    expect(luminance(c.accentNeutral)).toBeLessThan(0.05);
  });

  it('carry white ink on every agent colour as a fill', () => {
    for (const hex of Object.values(agentTints.light)) {
      expect(contrast(hex, c.inkLight)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keep each agent colour its own hue, deeper than dark’s', () => {
    for (const [key, hex] of Object.entries(agentTints.light)) {
      expect([key, luminance(hex) < luminance(agentTints.dark[key])]).toEqual([key, true]);
    }
  });

  it('keep the semantic colours apart from the neutral accent', () => {
    for (const role of ['accentSuccess', 'accentWarning', 'accentError'] as const) {
      expect(c[role]).not.toBe(c.accentNeutral);
    }
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const SRC = join(__dirname, '..', 'src');

/** Every line of every source file but theme.ts, with where it is. */
function sourceLines(): { at: string; line: string }[] {
  return files(SRC).flatMap((path) => {
    const rel = relative(SRC, path);
    if (rel === join('lib', 'theme.ts')) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line, i) => ({ at: `${rel}:${i + 1}`, line }));
  });
}

describe('colour literals', () => {
  // A hex colour, rgb()/hsl(), a platform colour, or a named colour in quotes.
  // 'transparent' is no colour.
  const NAMED =
    'white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia|tomato|crimson|coral|salmon|indigo|violet|beige|ivory|khaki|lavender|plum|tan|wheat|azure|lightgray|darkgray';
  const LITERAL = new RegExp(
    `#[0-9a-f]{3,8}\\b|\\b(rgba?|hsla?)\\(|\\b(PlatformColor|DynamicColorIOS)\\b|['"](${NAMED})['"]`,
    'gi'
  );
  /**
   * What looks like a colour and isn't one the app draws: the scroll
   * indicator's style keyword, an agent's colour key, a comment naming one.
   * Each is cut out of the line and the rest is still checked.
   */
  const ALLOWED = [
    /indicatorStyle=\{[^}]*\}/g,
    /agentAccent\('white'/g,
    /\* "white"/g,
    /color === 'white'/g,
  ];

  it('live only in theme.ts', () => {
    const found: string[] = [];
    for (const { at, line } of sourceLines()) {
      const rest = ALLOWED.reduce((l, a) => l.replace(a, ''), line);
      for (const m of rest.matchAll(LITERAL)) found.push(`${at}: ${m[0]} in ${line.trim()}`);
    }
    expect(found).toEqual([]);
  });
});

describe('the scale', () => {
  it('draws every corner from radius, a circle or a squircle', () => {
    // `borderRadius: radius.card`, `borderTopLeftRadius: radius.sheet`, a
    // circle (`size / 2`), or `squircle(size)`. Never a number, never
    // `radius.lg + 8`: a corner that isn't on the scale is a typo in the system.
    const CORNER = /\b(border\w*Radius|sheetCornerRadius)\s*[:=]\s*([^,}\n]+)/g;
    const OK = [
      new RegExp(`^radius\\.(${Object.keys(radius).join('|')})$`),
      /^[\w.]+ \/ 2$/,
      /^squircle\([\w.]+\)$/,
      /^composer\.(corner|fieldCorner)$/,
    ];
    const found: string[] = [];
    for (const { at, line } of sourceLines()) {
      for (const m of line.matchAll(CORNER)) {
        const value = m[2].trim();
        if (!OK.some((ok) => ok.test(value))) found.push(`${at}: ${m[0].trim()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('sizes every icon, spinner, avatar and dot from the theme', () => {
    // A literal size on any of them (`size={13}`) is off the scale.
    const LITERAL_SIZE = /\bsize=\{\s*\d/g;
    const found: string[] = [];
    for (const { at, line } of sourceLines()) {
      for (const m of line.matchAll(LITERAL_SIZE)) found.push(`${at}: ${m[0]} in ${line.trim()}`);
    }
    expect(found).toEqual([]);
  });

  it('keeps every type size on the type scale', () => {
    const LITERAL_FONT = /\bfontSize:\s*\d/g;
    const found: string[] = [];
    for (const { at, line } of sourceLines()) {
      for (const m of line.matchAll(LITERAL_FONT)) found.push(`${at}: ${m[0]} in ${line.trim()}`);
    }
    expect(found).toEqual([]);
  });

  it('has the four icon sizes and one exception, and the avatar sizes, as the spec sets them', () => {
    expect(iconSize).toEqual({ micro: 10, inline: 12, body: 16, button: 20, hero: 28 });
    expect(avatarSize).toEqual({ line: 16, group: 24, header: 28, list: 48, sheet: 56 });
    // A well's corner is tighter than its card's, so the two read as nested.
    expect(radius.inner).toBeLessThan(radius.card);
  });
});

describe('a speaker’s name in its agent’s colour', () => {
  it.each(APPEARANCES)('clears AA on the app and a panel for every agent colour (%s)', (a) => {
    const c = palettes[a];
    for (const [key, tint] of Object.entries(agentTints[a])) {
      for (const bg of READ_ON) {
        const ink = speakerInk(tint, c.textPrimary, c[bg]);
        expect([key, bg, contrast(ink, c[bg]) >= 4.5]).toEqual([key, bg, true]);
      }
    }
  });

  it('falls back toward the text colour when the raw tint is too pale', () => {
    const ink = speakerInk('#fff2a0', '#111111', '#ffffff');
    expect(contrast(ink, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
