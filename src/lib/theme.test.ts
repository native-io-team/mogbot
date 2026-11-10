import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetThemeForTests,
  getResolvedTheme,
  initTheme,
  isThemePreference,
  resolveTheme,
  THEME_CACHE_KEY,
} from './theme';
import {
  AA_TEXT,
  accentVars,
  accentHex,
  ACCENT_SHADE_VARS,
  contrastRatio,
  LIGHT_THEME_WHITE,
  mixHex,
  mixOklchWithNeutral,
  parseHex,
  relativeLuminance,
} from './accent';
import { AGENT_COLORS } from './agents';
import { COLORWAYS as KEY_COLORWAYS } from '../../packages/companion-protocol/src/agentKeys';

const AGENT_COLORS_FOR_TESTS = [...AGENT_COLORS];
import { terminalTheme } from '../components/terminal/terminalTheme';

const css = (path: string) => readFileSync(resolve('src/styles/global', path), 'utf8');

// ---------------------------------------------------------------------------
// A tiny resolver for the token files: enough to turn a semantic role into the
// hex it paints in each theme, so contrast can be checked against the real
// stylesheet rather than a copy of its values.
// ---------------------------------------------------------------------------

type Decls = Map<string, string>;

/** Every `--name: value;` inside blocks whose selector matches `selector`. */
function declarations(source: string, selector: (s: string) => boolean): Decls {
  const out: Decls = new Map();
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@supports[^{]*\{[\s\S]*?\}\s*\}/g, '');
  for (const [, sel, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector(sel.trim())) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(name, value.trim().replace(/\s+/g, ' '));
    }
  }
  return out;
}

const isRoot = (s: string) => s === ':root' || /^:root,\s*\[data-accent-scope\]$/.test(s);
const isLight = (s: string) => s === ":root[data-theme='light']";

const core = declarations(css('tokens-core.css'), isRoot);
const semanticSource = css('tokens-semantic.css');
const semanticDark = declarations(semanticSource, isRoot);
const semanticLight = declarations(semanticSource, isLight);

function tokens(theme: 'dark' | 'light'): Decls {
  return new Map([...core, ...semanticDark, ...(theme === 'light' ? semanticLight : [])]);
}

function resolveHex(name: string, theme: 'dark' | 'light'): string {
  const all = tokens(theme);
  let value = all.get(name);
  for (let i = 0; i < 10 && value; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = all.get(ref[1]);
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} (${theme}) does not resolve to a hex colour: ${value}`);
  }
  return value.toLowerCase();
}

const ratio = (fg: string, bg: string, theme: 'dark' | 'light') =>
  contrastRatio(parseHex(resolveHex(fg, theme))!, parseHex(resolveHex(bg, theme))!);

// ---------------------------------------------------------------------------

describe('theme preference', () => {
  afterEach(() => {
    __resetThemeForTests();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('resolves System against the OS appearance, and Light / Dark as themselves', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('only accepts the three preferences', () => {
    expect(['system', 'light', 'dark'].every(isThemePreference)).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  it('applies the cached preference to <html> on init', () => {
    localStorage.setItem(THEME_CACHE_KEY, 'light');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(getResolvedTheme()).toBe('light');
  });
});

describe('boot script (index.html)', () => {
  const html = readFileSync(resolve('index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((body) => body.includes('app.theme'))!;

  function boot(cached: string | null, systemDark: boolean) {
    const el = document.createElement('html');
    if (cached === null) localStorage.removeItem(THEME_CACHE_KEY);
    else localStorage.setItem(THEME_CACHE_KEY, cached);
    const win = { matchMedia: vi.fn(() => ({ matches: systemDark })) };
    // Runs index.html's own boot script: testing that exact code is the point.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('document', 'window', 'localStorage', script) as (
      d: { documentElement: HTMLElement },
      w: typeof win,
      s: Storage
    ) => void;
    run({ documentElement: el }, win, localStorage);
    return el;
  }

  afterEach(() => localStorage.clear());

  it('applies the saved theme before the bundle loads', () => {
    expect(boot('light', true).getAttribute('data-theme')).toBe('light');
    expect(boot('dark', false).getAttribute('data-theme')).toBe('dark');
    expect(boot('light', true).style.colorScheme).toBe('light');
  });

  it('follows the system for System, a missing cache, or a corrupt one', () => {
    expect(boot('system', false).getAttribute('data-theme')).toBe('light');
    expect(boot(null, true).getAttribute('data-theme')).toBe('dark');
    expect(boot('url(evil)', false).getAttribute('data-theme')).toBe('light');
  });

  it('reads the key theme.ts writes, and picks the accent cache for that theme', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_CACHE_KEY}')`);
    expect(html).toContain("'app.accent.light'");
  });
});

describe('light token completeness', () => {
  // Roles that are deliberately the same in both themes: they draw on the
  // user's page, are fixed brand/traffic hues, or are ink on a coloured fill.
  const THEME_INVARIANT = new Set([
    '--surface-canvas',
    '--accent-overlay',
    '--accent-overlay-ink',
    '--page-scrim',
    '--page-scrim-strong',
    '--mask-opaque',
    // The rgba() fallback of an accent tint: follows the accent, not the theme.
    '--accent-active-soft',
    '--accent-warning-light',
    '--shadow-source-control-attention',
    // Accent inputs live in their own light block (checked below).
    '--accent-user',
    '--accent-on-user',
    '--accent-user-rgb',
    '--accent-user-hover',
    '--accent-user-strong',
    '--accent-user-start',
    '--accent-user-end',
    '--accent-user-side',
  ]);
  const colourBearing = (value: string) =>
    /#[0-9a-f]{3,8}\b|rgba?\(|var\(--color-|^\d{1,3}, \d{1,3}, \d{1,3}$/i.test(value);

  it('gives every colour-bearing semantic role a light value', () => {
    const missing = [...semanticDark]
      // The macOS traffic-light hues are the same in both themes.
      .filter(([name]) => !name.endsWith('-traffic'))
      .filter(([name, value]) => colourBearing(value) && !THEME_INVARIANT.has(name))
      .filter(([name]) => !semanticLight.has(name))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('only overrides roles that exist (no typos creating new tokens)', () => {
    const unknown = [...semanticLight.keys()].filter((name) => !semanticDark.has(name));
    expect(unknown).toEqual([]);
  });

  it('keeps every RGB triplet equal to its solid colour in light', () => {
    for (const [triplet, solid] of [
      ['--accent-success-rgb', '--accent-success'],
      ['--accent-warning-rgb', '--accent-warning'],
      ['--accent-error-rgb', '--accent-error'],
      ['--accent-error-light-rgb', '--accent-error-light'],
      ['--accent-error-deep-rgb', '--accent-error-deep'],
    ]) {
      const rgb = parseHex(resolveHex(solid, 'light'))!.join(', ');
      expect(semanticLight.get(triplet), triplet).toBe(rgb);
    }
  });

  it('defaults the light accent inputs to accentVars("white", "light")', () => {
    const lightWhite = accentVars('white', 'light');
    for (const name of ['--accent-user', ...ACCENT_SHADE_VARS, '--accent-user-side'] as const) {
      expect(resolveHex(name, 'light'), name).toBe(lightWhite[name]);
    }
  });
});

describe('contrast (WCAG AA) in both themes', () => {
  const themes = ['dark', 'light'] as const;
  const surfaces = ['--surface-app', '--surface-panel', '--surface-control'];

  it.each(themes)('primary text clears AA on every surface (%s)', (theme) => {
    for (const bg of [...surfaces, '--surface-control-hover', '--surface-selected']) {
      expect(ratio('--text-primary', bg, theme), bg).toBeGreaterThanOrEqual(AA_TEXT);
      expect(ratio('--text-white', bg, theme), bg).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(themes)('secondary text clears AA on app, panel and controls (%s)', (theme) => {
    for (const bg of [...surfaces, '--surface-control-hover']) {
      expect(ratio('--text-secondary', bg, theme), bg).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(themes)('muted text clears AA on app, panel and card surfaces (%s)', (theme) => {
    for (const bg of ['--surface-app', '--surface-panel', '--surface-control']) {
      expect(ratio('--text-muted', bg, theme), bg).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('muted and quiet text clear AA on every light surface they sit on', () => {
    const lightSurfaces = [
      '--surface-app',
      '--surface-panel',
      '--surface-control',
      '--surface-control-hover',
      '--surface-selected',
      '--surface-selected-strong',
    ];
    for (const fg of ['--text-muted', '--text-quiet']) {
      for (const bg of lightSurfaces) {
        expect(ratio(fg, bg, 'light'), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps secondary, quiet and muted distinct steps in light', () => {
    const lum = (name: string) => relativeLuminance(parseHex(resolveHex(name, 'light'))!);
    expect(lum('--text-secondary')).toBeLessThan(lum('--text-quiet'));
    expect(lum('--text-quiet')).toBeLessThan(lum('--text-muted'));
  });

  it('keeps secondary, quiet and muted distinct steps in dark', () => {
    const lum = (name: string) => relativeLuminance(parseHex(resolveHex(name, 'dark'))!);
    expect(lum('--text-secondary')).toBeGreaterThan(lum('--text-quiet'));
    expect(lum('--text-quiet')).toBeGreaterThan(lum('--text-muted'));
  });

  it.each(themes)('muted text stays readable (≥ 3:1) on app and panel (%s)', (theme) => {
    for (const bg of ['--surface-app', '--surface-panel']) {
      expect(ratio('--text-muted', bg, theme), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(themes)('status colours read as text on the panel (%s)', (theme) => {
    for (const fg of ['--accent-success', '--accent-warning', '--accent-error', '--status-info']) {
      expect(ratio(fg, '--surface-panel', theme), fg).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(themes)('status words read on a selected row (%s)', (theme) => {
    // "Live" in the sidebar sits on the selected fill when its agent is open.
    for (const fg of ['--text-success', '--text-warning', '--text-error', '--text-info']) {
      for (const bg of ['--surface-panel', '--surface-selected']) {
        expect(ratio(fg, bg, theme), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it.each(themes)('syntax roles read on the control surface (%s)', (theme) => {
    for (const fg of [
      '--syntax-property',
      '--syntax-variable',
      '--syntax-class',
      '--syntax-tag',
      '--syntax-function',
      '--syntax-keyword',
    ]) {
      expect(ratio(fg, '--surface-control', theme), fg).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(themes)('the strong (Allow) fill carries its ink (%s)', (theme) => {
    expect(ratio('--text-on-inverse', '--surface-inverse', theme)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio('--text-on-inverse', '--surface-inverse-hover', theme)).toBeGreaterThanOrEqual(
      AA_TEXT
    );
  });

  it.each(themes)('keeps the neutral focus ring at ≥ 3:1 on every surface (%s)', (theme) => {
    // --accent-focus is --text-primary at --focus-ring-strength over whatever it sits on.
    const strength =
      parseFloat(
        (theme === 'light' && semanticLight.get('--focus-ring-strength')) ||
          semanticDark.get('--focus-ring-strength')!
      ) / 100;
    expect(strength).toBeLessThanOrEqual(0.6);
    const ring = resolveHex('--text-primary', theme);
    for (const bg of [...surfaces, '--surface-control-hover', '--surface-selected']) {
      const surface = resolveHex(bg, theme);
      const blended = mixHex(surface, ring, strength);
      expect(contrastRatio(parseHex(blended)!, parseHex(surface)!), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps checkbox edges at ≥ 3:1 on every light surface', () => {
    for (const bg of [...surfaces, '--surface-control-hover', '--surface-selected']) {
      expect(ratio('--border-control', bg, 'light'), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it('builds the focus ring from text, not from a hue or the accent', () => {
    expect(semanticDark.get('--accent-focus')).toBe('var(--text-primary)');
    expect(semanticLight.has('--accent-focus')).toBe(false);
    expect(semanticSource).toMatch(
      /--accent-focus:\s*color-mix\(in srgb, var\(--text-primary\) var\(--focus-ring-strength\), transparent\)/
    );
    expect(semanticDark.get('--focus-ring-offset')).toBe('var(--stroke-2)');
    expect(semanticDark.get('--focus-ring-width')).toBe('var(--stroke-1-5)');
  });

  it('makes the strong (Allow) fill near-black with white ink on light', () => {
    expect(resolveHex('--surface-inverse', 'light')).toBe('#1c1c1c');
    expect(resolveHex('--text-on-inverse', 'light')).toBe('#ffffff');
  });
});

describe('the accent on each theme', () => {
  it('maps the white accent to near-black on light, and nothing else', () => {
    expect(accentHex('white', 'light')).toBe(LIGHT_THEME_WHITE);
    expect(accentHex('white', 'dark')).toBe('#e6e6e6');
    for (const key of AGENT_COLORS_FOR_TESTS.filter((k) => k !== 'white')) {
      expect(accentHex(key, 'light'), key).toBe(accentHex(key, 'dark'));
    }
    expect(accentVars('white', 'light')['--accent-on-user']).toBe('#ffffff');
  });

  it.each(['dark', 'light'] as const)('keeps accent ink at AA on every fill (%s)', (theme) => {
    for (const key of AGENT_COLORS_FOR_TESTS) {
      const vars = accentVars(key, theme);
      const ink = parseHex(vars['--accent-on-user'])!;
      for (const fill of ['--accent-user', ...ACCENT_SHADE_VARS] as const) {
        expect(contrastRatio(parseHex(vars[fill])!, ink), `${key} ${fill}`).toBeGreaterThanOrEqual(
          AA_TEXT
        );
      }
    }
  });

  it.each(['dark', 'light'] as const)(
    'keeps accent-coloured text (--accent-text) at AA on the panel (%s)',
    (theme) => {
      const panel = parseHex(resolveHex('--surface-panel', theme))!;
      const text = resolveHex('--text-primary', theme);
      for (const key of AGENT_COLORS_FOR_TESTS) {
        const share = parseFloat(tokens(theme).get('--accent-text-share')!) / 100;
        const mixed = mixOklchWithNeutral(accentHex(key, theme), text, share);
        expect(contrastRatio(parseHex(mixed)!, panel), key).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  );

  it('keeps the light white accent distinct from the light surfaces', () => {
    const accent = parseHex(accentHex('white', 'light'))!;
    for (const bg of ['--surface-app', '--surface-panel']) {
      expect(contrastRatio(accent, parseHex(resolveHex(bg, 'light'))!)).toBeGreaterThan(10);
    }
  });
});

describe('terminal palette', () => {
  it('matches the app surface in each theme', () => {
    expect(terminalTheme('normal', 'dark').background).toBe(resolveHex('--surface-app', 'dark'));
    expect(terminalTheme('normal', 'light').background).toBe(resolveHex('--surface-app', 'light'));
  });

  it('keeps the foreground and ANSI colours readable on the light background', () => {
    const t = terminalTheme('normal', 'light');
    const bg = parseHex(t.background!)!;
    for (const key of [
      'foreground',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
    ] as const) {
      expect(contrastRatio(parseHex(t[key]!)!, bg), key).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('component roles on fixed hues and light surfaces', () => {
  const componentSource = css('tokens-components.css');
  const componentDark = declarations(componentSource, isRoot);
  const componentLight = declarations(componentSource, isLight);
  const resolveComponent = (name: string, theme: 'dark' | 'light') => {
    const value = (theme === 'light' && componentLight.get(name)) || componentDark.get(name) || '';
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) throw new Error(`${name} (${theme}) is not a plain var(): ${value}`);
    return resolveHex(ref[1], theme);
  };
  const contrast = (a: string, b: string) => contrastRatio(parseHex(a)!, parseHex(b)!);

  it.each(['dark', 'light'] as const)(
    'ink on the property and variable fills clears AA (%s)',
    (theme) => {
      // Hover fills are a step lighter and only under the pointer: blue-600
      // carries white at 4.4:1 (as the cascade chips always have), so they get
      // a floor just under AA rather than none.
      for (const [fg, bg, floor] of [
        ['--property-surface-text', '--property-surface', AA_TEXT],
        ['--property-surface-text', '--property-surface-hover', 4.3],
        ['--button-variable-text', '--button-variable-surface', AA_TEXT],
        ['--button-variable-text', '--button-variable-hover', 4.3],
      ] as const) {
        expect(
          contrast(resolveComponent(fg, theme), resolveComponent(bg, theme)),
          `${fg} on ${bg}`
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  );

  it.each(['dark', 'light'] as const)(
    'an off switch reads as off: its ring at 3:1, a knob lighter than its track (%s)',
    (theme) => {
      for (const bg of ['--surface-app', '--surface-panel', '--surface-control']) {
        expect(
          contrast(resolveComponent('--switch-off-track-border', theme), resolveHex(bg, theme)),
          `ring on ${bg}`
        ).toBeGreaterThanOrEqual(3);
      }
      const knob = parseHex(resolveComponent('--switch-off-knob', theme))!;
      const track = parseHex(resolveComponent('--switch-off-track', theme))!;
      expect(relativeLuminance(knob)).toBeGreaterThan(relativeLuminance(track));
    }
  );

  it('the dark segmented key stands out from its tray: rim at 3:1, its words at AA', () => {
    const tray = resolveComponent('--tabs-tray-surface', 'dark');
    expect(contrast(resolveComponent('--tabs-key-rim', 'dark'), tray)).toBeGreaterThanOrEqual(3);
    // The key's face (the gradient's top stop) carries the chosen tab's words.
    expect(
      contrast(resolveHex('--text-primary', 'dark'), resolveHex('--color-gray-700', 'dark'))
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('media text and the warning hover read on light surfaces', () => {
    for (const fg of ['--media-text', '--button-warning-text-hover']) {
      for (const bg of ['--surface-app', '--surface-panel', '--surface-control']) {
        expect(
          contrast(resolveComponent(fg, 'light'), resolveHex(bg, 'light')),
          `${fg} on ${bg}`
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });
});

describe('scrims', () => {
  const alphaOf = (value: string | undefined) =>
    Number(/rgba\(0, 0, 0, ([\d.]+)\)/.exec(value ?? '')?.[1]);
  const steps = ['30', '40', '50', '60', '70', '80'].map((n) => `--overlay-${n}`);

  it.each(['dark', 'light'] as const)('the overlay ramp only ever gets darker (%s)', (theme) => {
    const decls = theme === 'light' ? semanticLight : semanticDark;
    const alphas = steps.map((name) => alphaOf(decls.get(name)));
    alphas.forEach((a, i) => {
      expect(a, steps[i]).not.toBeNaN();
      if (i > 0) expect(a, steps[i]).toBeGreaterThan(alphas[i - 1]);
    });
  });

  it('dims a light window under a dialog without blacking it out', () => {
    const modal = alphaOf(semanticLight.get('--scrim-modal'));
    expect(modal).toBeGreaterThan(alphaOf(semanticLight.get('--overlay-80')));
    expect(modal).toBeLessThanOrEqual(0.32);
  });
});

describe('a speaker’s name in its agent’s colour', () => {
  // `.agent-room__speaker-name`: the tint mixed toward the text colour. The
  // share is read from the stylesheet, so the test holds what is drawn.
  const rooms = readFileSync(resolve('src/styles/features/agents-rooms.css'), 'utf8');
  const agents = readFileSync(resolve('src/styles/features/agents.css'), 'utf8');
  const share = (theme: 'dark' | 'light') => {
    const name = theme === 'light' ? '--agents-name-tint-light' : '--agents-name-tint';
    const m = new RegExp(`${name}:\\s*(\\d+)%`).exec(rooms);
    if (!m) throw new Error(`${name} is not set in agents-rooms.css`);
    return Number(m[1]) / 100;
  };
  const tintOf = (key: string, theme: 'dark' | 'light') => {
    const light = /:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(agents)?.[1] ?? '';
    const own =
      theme === 'light'
        ? new RegExp(`--agents-tint-${key}:\\s*(#[0-9a-f]{6})`, 'i').exec(light)
        : null;
    const base = new RegExp(`--agents-tint-${key}:\\s*(#[0-9a-f]{6})`, 'i').exec(agents);
    return (own?.[1] ?? base![1]).toLowerCase();
  };

  it.each(['dark', 'light'] as const)('clears AA on the app and a panel (%s)', (theme) => {
    const text = resolveHex('--text-primary', theme);
    for (const key of [...AGENT_COLORS]) {
      const ink = mixHex(tintOf(key, theme), text, 1 - share(theme));
      for (const bg of ['--surface-app', '--surface-panel']) {
        const r = contrastRatio(parseHex(ink)!, parseHex(resolveHex(bg, theme))!);
        expect([key, bg, r >= AA_TEXT]).toEqual([key, bg, true]);
      }
    }
  });

  // A name or @mention takes its key's colourway (`--agents-ink-*`) wherever
  // the colourway is known; each must clear AA the same way.
  const inkOf = (id: string, theme: 'dark' | 'light') => {
    const light = /:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(agents)?.[1] ?? '';
    const re = new RegExp(`--agents-ink-${id}:\\s*(#[0-9a-f]{6})`, 'i');
    const own = theme === 'light' ? re.exec(light) : null;
    const base = re.exec(agents);
    expect(base, `--agents-ink-${id}`).toBeTruthy();
    return (own?.[1] ?? base![1]).toLowerCase();
  };

  it.each(['dark', 'light'] as const)('every colourway clears AA too (%s)', (theme) => {
    const text = resolveHex('--text-primary', theme);
    for (const { id } of KEY_COLORWAYS) {
      expect(agents).toContain(
        `[data-colorway='${id}'] {\n  --agents-tint: var(--agents-ink-${id});`
      );
      const ink = mixHex(inkOf(id, theme), text, 1 - share(theme));
      for (const bg of ['--surface-app', '--surface-panel']) {
        const r = contrastRatio(parseHex(ink)!, parseHex(resolveHex(bg, theme))!);
        expect([id, bg, r >= AA_TEXT]).toEqual([id, bg, true]);
      }
    }
  });
});

describe('status pills', () => {
  const componentSource = css('tokens-components.css');
  const components = declarations(componentSource, isRoot);
  const ref = (name: string) => {
    const m = /^var\((--[\w-]+)\)$/.exec(components.get(name) ?? '');
    if (!m) throw new Error(`${name} is not a plain var()`);
    return m[1];
  };
  const tones = ['running', 'waiting', 'failed', 'done', 'out', 'idle'] as const;
  const wash = parseFloat(components.get('--status-pill-wash') ?? '') / 100;
  const surfaces = [
    '--surface-app',
    '--surface-panel',
    '--surface-control',
    '--surface-control-hover',
    '--surface-selected',
  ];

  it('takes its hues from status roles, never the accent', () => {
    for (const tone of tones) {
      expect(ref(`--status-pill-${tone}`), tone).not.toMatch(/accent-(active|user)/);
    }
    // Amber is "needs you", only: out of usage resets by itself.
    expect(ref('--status-pill-waiting')).toBe('--accent-warning');
    expect(ref('--status-pill-out')).not.toBe('--accent-warning');
    expect(wash).toBeGreaterThan(0);
    expect(wash).toBeLessThanOrEqual(0.2);
  });

  it.each(['dark', 'light'] as const)('keeps its words at AA on every surface (%s)', (theme) => {
    const text = resolveHex(ref('--status-pill-text'), theme);
    for (const tone of tones) {
      const hue = resolveHex(ref(`--status-pill-${tone}`), theme);
      for (const bg of surfaces) {
        const fill = mixHex(resolveHex(bg, theme), hue, wash);
        const r = contrastRatio(parseHex(text)!, parseHex(fill)!);
        expect([tone, bg, r >= AA_TEXT]).toEqual([tone, bg, true]);
      }
    }
  });

  it.each(['dark', 'light'] as const)(
    'gives each coloured dot 3:1 against its wash (%s)',
    (theme) => {
      for (const tone of ['running', 'waiting', 'failed', 'done'] as const) {
        const hue = resolveHex(ref(`--status-pill-${tone}`), theme);
        for (const bg of ['--surface-app', '--surface-panel']) {
          const fill = mixHex(resolveHex(bg, theme), hue, wash);
          const r = contrastRatio(parseHex(hue)!, parseHex(fill)!);
          expect([tone, bg, r >= 3]).toEqual([tone, bg, true]);
        }
      }
    }
  );
});
