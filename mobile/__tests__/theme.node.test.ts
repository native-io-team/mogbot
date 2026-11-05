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
  contrast,
  luminance,
  palettes,
  type Palette,
} from '../src/lib/theme';

const COLOUR = /^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\))$/;

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
        expect([role, COLOUR.test(value)]).toEqual([role, true]);
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

describe('colour literals', () => {
  // A hex colour, rgb()/hsl(), or a named white or black. 'transparent' is no colour.
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(|['"](white|black)['"]/;
  /** A literal that isn't a colour drawn by the app: an SF Symbol name or a platform keyword. */
  const ALLOWED = [/indicatorStyle=\{[^}]*\}/, /agentAccent\('white'/, /\* "white"/];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('live only in theme.ts', () => {
    const root = join(__dirname, '..', 'src');
    const found: string[] = [];
    for (const path of files(root)) {
      const rel = relative(root, path);
      if (rel === join('lib', 'theme.ts')) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!LITERAL.test(line)) return;
          if (ALLOWED.some((a) => a.test(line))) return;
          found.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });
});
