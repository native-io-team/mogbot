import { describe, expect, it } from 'vitest';
import cases from './agent-key-cases.json';
import {
  CHIEF_COLORWAY,
  CHIEF_ICON,
  COLORWAYS,
  KEY_ICON_DRAWINGS,
  KEY_ICON_IDS,
  KEY_PIPS,
  boundKeyFor,
  colorwayForColor,
  freshColorway,
  iconFor,
  keyAccessibleName,
  keyLookFor,
  keyStateOf,
  normalizeBoundKey,
  pipsFor,
} from './agentKeys';

/** WCAG relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('colourways', () => {
  it('are the fourteen of the spec, each a legend that reads on its face', () => {
    expect(COLORWAYS.map((c) => c.id)).toEqual([
      'blue',
      'orange',
      'putty',
      'teal',
      'graphite',
      'mustard',
      'pink',
      'sage',
      'brick',
      'plum',
      'navy',
      'forest',
      'sky',
      'lilac',
    ]);
    // The pale faces are marked light (a lit legend needs the deeper wash).
    expect(COLORWAYS.filter((c) => c.light).map((c) => c.id)).toEqual([
      'putty',
      'mustard',
      'pink',
      'sage',
      'sky',
      'lilac',
    ]);
    for (const c of COLORWAYS) {
      expect(contrast(c.legend, c.face), c.id).toBeGreaterThanOrEqual(4.5);
      // Three shades of one hue, darkening face → skirt → depth.
      expect(luminance(c.face)).toBeGreaterThan(luminance(c.skirt));
      expect(luminance(c.skirt)).toBeGreaterThan(luminance(c.depth));
    }
  });

  it('take an old colour to its nearest, as the Mac does', () => {
    for (const { color, colorway } of cases.colors) {
      expect(colorwayForColor(color), color).toBe(colorway);
    }
  });

  it('hand a new agent the one fewest wear', () => {
    expect(freshColorway([])).toBe('blue');
    expect(freshColorway(['blue', 'orange'])).toBe('putty');
    expect(freshColorway(COLORWAYS.map((c) => c.id).concat('blue'))).toBe('orange');
  });
});

describe('icons', () => {
  it('every icon has a drawing, and every drawing an icon', () => {
    expect(Object.keys(KEY_ICON_DRAWINGS).sort()).toEqual([...KEY_ICON_IDS].sort());
    expect(KEY_ICON_IDS.length).toBeGreaterThanOrEqual(20);
  });

  it('are legends: straight lines only horizontal, vertical or 45°, on the 24 grid', () => {
    for (const [id, drawing] of Object.entries(KEY_ICON_DRAWINGS)) {
      // The app's mark is the one filled legend, and keeps its curves (below).
      if (drawing.fill) continue;
      for (const d of drawing.paths) {
        expect(d, id).toMatch(/^[MHVLZ0-9. ]+$/);
        // Walk the path and check each segment's angle.
        const tokens = d.match(/[MHVLZ]|[\d.]+/g) ?? [];
        let x = 0;
        let y = 0;
        let sx = 0;
        let sy = 0;
        let cmd = '';
        for (let i = 0; i < tokens.length; ) {
          const t = tokens[i];
          if (/[MHVLZ]/.test(t)) {
            cmd = t;
            i++;
            if (cmd === 'Z') {
              const ok = x === sx || y === sy || Math.abs(x - sx) === Math.abs(y - sy);
              expect(ok, `${id}: close`).toBe(true);
              x = sx;
              y = sy;
            }
            continue;
          }
          const n = Number(t);
          let nx = x;
          let ny = y;
          if (cmd === 'H') nx = n;
          else if (cmd === 'V') ny = n;
          else {
            nx = n;
            ny = Number(tokens[i + 1]);
            i++;
          }
          i++;
          if (cmd === 'M') {
            sx = nx;
            sy = ny;
          } else if (cmd === 'L') {
            expect(
              Math.abs(nx - x) === Math.abs(ny - y) || nx === x || ny === y,
              `${id}: ${d}`
            ).toBe(true);
          }
          x = nx;
          y = ny;
          expect(x >= 0 && x <= 24 && y >= 0 && y <= 24, id).toBe(true);
        }
      }
    }
  });

  it("only the app's mark is filled: first in the row, on the grid, the Chief's", () => {
    const filled = Object.entries(KEY_ICON_DRAWINGS).filter(([, d]) => d.fill);
    expect(filled.map(([id]) => id)).toEqual(['mogbot']);
    expect(KEY_ICON_IDS[0]).toBe('mogbot');
    expect(CHIEF_ICON).toBe('mogbot');
    expect(CHIEF_COLORWAY).toBe('graphite');
    const mark = KEY_ICON_DRAWINGS.mogbot;
    expect(mark.circles).toBeUndefined();
    for (const d of mark.paths) {
      for (const n of d.match(/-?[\d.]+/g) ?? []) {
        expect(Number(n)).toBeGreaterThanOrEqual(0);
        expect(Number(n)).toBeLessThanOrEqual(24);
      }
      // The dome and its two eyes: three closed shapes.
      expect(d.match(/Z/g)).toHaveLength(3);
    }
  });

  it('read from a name or role, as the Mac does', () => {
    for (const c of cases.icons) {
      expect(iconFor(c.name, c.role, c.isMain), c.name).toBe(c.icon);
    }
  });
});

describe('bound keys', () => {
  it('take the first free letter of the name, then any other', () => {
    for (const c of cases.boundKeys) {
      expect(boundKeyFor(c.name, [...c.taken]), c.name).toBe(c.key);
    }
    expect(boundKeyFor('X', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))).toBeNull();
  });

  it('are one letter or digit, upper-cased', () => {
    expect(normalizeBoundKey('f')).toBe('F');
    expect(normalizeBoundKey('7')).toBe('7');
    expect(normalizeBoundKey('/')).toBeNull();
    expect(normalizeBoundKey('ab')).toBeNull();
    expect(normalizeBoundKey(undefined)).toBeNull();
  });
});

describe('an agent from an older Mac', () => {
  it('is drawn from its colour, name and role', () => {
    expect(keyLookFor({ name: 'Finance', color: 'amber' })).toEqual({
      colorway: 'mustard',
      icon: 'money',
      boundKey: null,
    });
    expect(
      keyLookFor({ name: 'Finance', color: 'amber', colorway: 'teal', icon: 'chat', boundKey: 'q' })
    ).toEqual({ colorway: 'teal', icon: 'chat', boundKey: 'Q' });
    expect(keyLookFor({ name: 'X', colorway: 'chrome', icon: 'unicorn' }).icon).toBe('grid');
    // A pack icon is kept as chosen (which exist is the Mac's to say).
    expect(keyLookFor({ name: 'X', icon: 'lucide:wallet' }).icon).toBe('lucide:wallet');
    expect(keyLookFor({ name: 'X', icon: 'lucide:Wallet!' }).icon).toBe('grid');
  });
});

describe('states and pips', () => {
  it('rank needs-your-OK over paused over working over live', () => {
    expect(keyStateOf({})).toBe('idle');
    expect(keyStateOf({ working: true, needsOk: true })).toBe('needsOk');
    expect(keyStateOf({ working: true, paused: true })).toBe('paused');
    expect(keyStateOf({ working: true, live: true })).toBe('working');
    expect(keyStateOf({ live: true })).toBe('live');
  });

  it('light one pip per independence stop', () => {
    expect(KEY_PIPS).toEqual({ often: 1, judgement: 2, go_hard: 3, full_send: 4 });
    expect(pipsFor('go_hard')).toBe(3);
    expect(pipsFor(undefined)).toBe(0);
  });
});

describe('keyAccessibleName', () => {
  it('names the agent, then the state when it is news', () => {
    expect(keyAccessibleName('Finance', 'needsOk')).toBe('Finance, needs your OK');
    expect(keyAccessibleName('Finance', 'working')).toBe('Finance, working');
    expect(keyAccessibleName('Finance', 'paused')).toBe('Finance, paused');
    expect(keyAccessibleName('Finance', 'idle')).toBe('Finance');
    expect(keyAccessibleName('Finance')).toBe('Finance');
  });
  it('a key with no agent yet is a new agent', () => {
    expect(keyAccessibleName('', 'new')).toBe('New agent');
    expect(keyAccessibleName(undefined)).toBe('New agent');
  });
});
