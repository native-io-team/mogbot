import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_COLORS } from './agents';
import {
  AA_TEXT,
  ACCENT_CACHE_KEY,
  ACCENT_SHADE_VARS,
  ACCENT_VAR_NAMES,
  accentVarsForHex,
  isValidAccentVar,
  shadeOklch,
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

  it('keeps the ink at AA on every fill it sits on (base, hover, busy, both gradient stops)', () => {
    for (const key of AGENT_COLORS) {
      const vars = accentVars(key);
      const ink = parseHex(vars['--accent-on-user'])!;
      for (const name of ['--accent-user', ...ACCENT_SHADE_VARS] as const) {
        const ratio = contrastRatio(parseHex(vars[name])!, ink);
        expect(ratio, `${key} ${name} ${vars[name]}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps hover and busy visibly different from the base colour', () => {
    for (const key of AGENT_COLORS) {
      const vars = accentVars(key);
      for (const name of ['--accent-user-hover', '--accent-user-strong'] as const) {
        expect(vars[name], `${key} ${name}`).not.toBe(vars['--accent-user']);
      }
    }
  });

  it('shades in OKLCH toward black and white', () => {
    expect(shadeOklch('#808080', 'black', 1)).toBe('#000000');
    expect(shadeOklch('#808080', 'white', 1)).toBe('#ffffff');
    expect(shadeOklch('#4d8ff5', 'black', 0)).toBe('#4d8ff5');
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
    expect(accentVars('blue')).toMatchObject({
      '--accent-user': '#4d8ff5',
      '--accent-on-user': ON_ACCENT_DARK,
      '--accent-user-rgb': '77, 143, 245',
    });
    for (const name of ACCENT_VAR_NAMES) {
      expect(isValidAccentVar(name, accentVars('blue')[name]), name).toBe(true);
    }
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

  it('rejects a cache with any malformed value, not only the colour', () => {
    const good = accentVars('blue');
    for (const [name, bad] of [
      ['--accent-on-user', 'red; background: url(x)'],
      ['--accent-user-rgb', '1,2,3,4'],
      ['--accent-user-hover', 'expression(1)'],
    ] as const) {
      localStorage.setItem(ACCENT_CACHE_KEY, JSON.stringify({ ...good, [name]: bad }));
      expect(readCachedAccent(), name).toBeNull();
    }
    // An entry from an older build, without the shades, is not half-applied.
    localStorage.setItem(
      ACCENT_CACHE_KEY,
      JSON.stringify({ '--accent-user': good['--accent-user'], '--accent-on-user': ON_ACCENT_DARK })
    );
    expect(readCachedAccent()).toBeNull();
  });

  it('boot script validates every var the same way readCachedAccent does', () => {
    const html = readFileSync(resolve('index.html'), 'utf8');
    const script = /<script>([\s\S]*?app\.accent[\s\S]*?)<\/script>/.exec(html)![1];
    const run = (cached: unknown) => {
      const el = document.createElement('html');
      localStorage.setItem(ACCENT_CACHE_KEY, JSON.stringify(cached));
      // Runs index.html's own boot script: testing that exact code is the point.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const boot = new Function('document', script) as (doc: {
        documentElement: HTMLElement;
      }) => void;
      boot({ documentElement: el });
      return el.style;
    };
    const good = accentVars('red');
    const applied = run(good);
    for (const name of ACCENT_VAR_NAMES) {
      expect(applied.getPropertyValue(name), name).toBe(good[name]);
    }
    expect(run({ ...good, '--accent-on-user': 'nope' }).getPropertyValue('--accent-user')).toBe('');
    expect(run({ ...good, '--accent-evil': '#000000' }).getPropertyValue('--accent-evil')).toBe('');
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

  it('defaults the CSS inputs to the white accent and its shades', () => {
    const core = css('global/tokens-core.css');
    const white = accentVarsForHex(ACCENT_PALETTE.white);
    for (const [suffix, name] of [
      ['hover', '--accent-user-hover'],
      ['strong', '--accent-user-strong'],
      ['start', '--accent-user-start'],
      ['end', '--accent-user-end'],
    ] as const) {
      const m = new RegExp(`--color-accent-default-${suffix}:\\s*(#[0-9a-f]{6})`, 'i').exec(core);
      expect(m?.[1].toLowerCase(), suffix).toBe(white[name]);
    }
  });

  it('never derives the primary button or its shades with color-mix()', () => {
    // Without color-mix() support the declaration is dropped: the button lost
    // its fill while keeping a dark label. The shades come precomputed.
    const components = css('global/tokens-components.css');
    for (const role of ['start', 'mid', 'end', 'busy']) {
      const m = new RegExp(`--button-primary-${role}:([^;]+);`).exec(components);
      expect(m?.[1], role).not.toMatch(/color-mix/);
    }
    const semantic = css('global/tokens-semantic.css').replace(/@supports[\s\S]*?\n}\n/g, '');
    for (const role of ['--accent-active', '--accent-active-hover', '--accent-active-strong']) {
      const m = new RegExp(`${role}:([^;]+);`).exec(semantic);
      expect(m?.[1], role).not.toMatch(/color-mix/);
    }
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
