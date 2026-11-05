import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_COLORS } from './agents';
import {
  ACCENT_CACHE_KEY,
  ACCENT_PALETTE,
  ON_ACCENT_DARK,
  ON_ACCENT_LIGHT,
  accentHex,
  accentScopeProps,
  accentVars,
  applyAccentVars,
  cacheAccentVars,
  contrastRatio,
  mixHex,
  parseHex,
  pickOnAccent,
  readCachedAccent,
  relativeLuminance,
} from './accent';

const css = (path: string) => readFileSync(resolve('src/styles', path), 'utf8');

describe('colour maths', () => {
  it('parses short and long hex, and rejects anything else', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#4D8FF5')).toEqual([77, 143, 245]);
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
  });

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([10, 10, 10], [10, 10, 10])).toBe(1);
  });

  it('picks dark ink on light accents and light ink on dark ones', () => {
    expect(pickOnAccent('#e6e6e6')).toBe(ON_ACCENT_DARK);
    expect(pickOnAccent('#ffeb3b')).toBe(ON_ACCENT_DARK);
    expect(pickOnAccent('#1e3a8a')).toBe(ON_ACCENT_LIGHT);
    expect(pickOnAccent('#000000')).toBe(ON_ACCENT_LIGHT);
  });

  it('gives every palette colour ink that passes WCAG AA for UI text', () => {
    for (const key of AGENT_COLORS) {
      const hex = ACCENT_PALETTE[key];
      const ratio = contrastRatio(parseHex(hex)!, parseHex(pickOnAccent(hex))!);
      expect(ratio, key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('mixes in sRGB, clamped', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff');
  });
});

describe('derivation', () => {
  it('maps colour keys to the three runtime inputs', () => {
    expect(accentVars('blue')).toEqual({
      '--accent-user': '#4d8ff5',
      '--accent-on-user': ON_ACCENT_DARK,
      '--accent-user-rgb': '77, 143, 245',
    });
  });

  it('treats an unknown or missing key as the default (white)', () => {
    expect(accentHex('chartreuse')).toBe(ACCENT_PALETTE.white);
    expect(accentHex(null)).toBe(ACCENT_PALETTE.white);
  });

  it('scopes an accent with the data attribute the CSS re-derives on', () => {
    const props = accentScopeProps('red');
    expect(props['data-accent-scope']).toBe('red');
    expect(props.style).toMatchObject({ '--accent-user': ACCENT_PALETTE.red });
    expect(accentScopeProps('nonsense')['data-accent-scope']).toBe('white');
  });

  it('writes the inputs onto an element', () => {
    const el = document.createElement('div');
    applyAccentVars(accentVars('teal'), el);
    expect(el.style.getPropertyValue('--accent-user')).toBe(ACCENT_PALETTE.teal);
    expect(el.style.getPropertyValue('--accent-user-rgb')).toBe('47, 179, 161');
  });
});

describe('boot cache', () => {
  afterEach(() => localStorage.clear());

  it('round-trips, and ignores a malformed entry', () => {
    cacheAccentVars(accentVars('pink'));
    expect(readCachedAccent()?.['--accent-user']).toBe(ACCENT_PALETTE.pink);
    localStorage.setItem(ACCENT_CACHE_KEY, '{"--accent-user":"url(evil)"}');
    expect(readCachedAccent()).toBeNull();
    localStorage.setItem(ACCENT_CACHE_KEY, 'not json');
    expect(readCachedAccent()).toBeNull();
  });

  it('uses the key index.html reads before the bundle loads', () => {
    const html = readFileSync(resolve('index.html'), 'utf8');
    expect(html).toContain(`localStorage.getItem('${ACCENT_CACHE_KEY}')`);
  });
});

describe('kept in sync with the stylesheets', () => {
  it('matches the agent avatar tints in agents.css', () => {
    const source = css('features/agents.css');
    for (const key of AGENT_COLORS) {
      const m = new RegExp(`--agents-tint-${key}:\\s*(#[0-9a-f]{6})`, 'i').exec(source);
      expect(m?.[1].toLowerCase(), key).toBe(ACCENT_PALETTE[key]);
    }
  });

  it('matches the default accent in tokens-core.css', () => {
    const m = /--color-accent-default:\s*(#[0-9a-f]{6})/i.exec(css('global/tokens-core.css'));
    expect(m?.[1].toLowerCase()).toBe(ACCENT_PALETTE.white);
  });

  it('re-derives every accent role on [data-accent-scope], not only :root', () => {
    // A role derived only at :root is inherited as a finished colour, so a
    // scoped accent would silently not reach it.
    for (const file of ['global/tokens-semantic.css', 'global/tokens-components.css']) {
      const source = css(file).replace(/\/\*[\s\S]*?\*\//g, '');
      const blocks = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      for (const [, selector, body] of blocks) {
        const derived = body
          .split(';')
          .filter((d) => /^\s*--[\w-]+\s*:/.test(d) && /var\(--accent-(active|user)\b/.test(d));
        if (derived.length === 0) continue;
        expect(selector, `${file}: ${derived[0].trim()}`).toContain('[data-accent-scope]');
      }
    }
  });
});
