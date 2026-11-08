import { describe, expect, it } from 'vitest';
import {
  AVATAR_FACES,
  AVATAR_MOTION,
  AVATAR_SHAPES,
  AVATAR_TONES,
  CHIEF_LOOK,
  FACE_NAMES,
  FACE_REACH,
  FACE_SPECS,
  FINISH_NAMES,
  KEY,
  LEGACY_FACES,
  LEGACY_SHAPES,
  MONOGRAM,
  SHAPE_AREA,
  SHAPE_NAMES,
  SHAPE_PATHS,
  SHAPE_POINTS,
  SMALL_MOTION,
  LIT_MIN_PX,
  TYPING_KEY,
  TYPING_KEY_UNITS,
  TYPING_KEY_VIEWBOX,
  avatarPaint,
  typingKeyPaint,
  defaultLook,
  describeLook,
  eyeAt,
  faceWeight,
  freeLook,
  lookFor,
  moodOf,
  type AvatarTheme,
} from './avatar';

describe('lookFor', () => {
  it('derives the same look from an id as the Mac does (avatar_tests.rs holds this table)', () => {
    const table: [string, string, string][] = [
      ['hiring', 'hexagon', 'dots'],
      ['finance', 'circle', 'dots'],
      ['a1b2c3', 'hexagon', 'dots'],
      ['acme', 'diamond', 'dots'],
      ['leadgen', 'circle', 'dots'],
      ['social', 'diamond', 'dots'],
      ['é-agent', 'hexagon', 'dots'],
    ];
    for (const [id, shape, face] of table) {
      expect(defaultLook(id)).toEqual({ shape, face });
    }
  });

  it('gives the Chief its own default, and nobody else a squircle by default', () => {
    expect(lookFor({ id: 'chief-id', isMain: true })).toEqual({ ...CHIEF_LOOK, finish: 'keycap' });
    expect(CHIEF_LOOK.shape).toBe('squircle');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const look = defaultLook(`agent-${i}`);
      expect(look.shape).not.toBe(CHIEF_LOOK.shape);
      expect(look.face).toBe('dots');
      seen.add(look.shape);
    }
    // Every other shape is handed out.
    expect(seen.size).toBe(AVATAR_SHAPES.length - 1);
  });

  it('keeps a saved choice field by field, and falls back on a key it does not draw', () => {
    expect(
      lookFor({ id: 'hiring', avatar: { shape: 'diamond', face: 'monogram', finish: 'embossed' } })
    ).toEqual({ shape: 'diamond', face: 'monogram', finish: 'embossed' });
    const odd = lookFor({ id: 'hiring', avatar: { shape: 'star', face: 'newer', finish: 'gold' } });
    expect(odd).toEqual({ ...defaultLook('hiring'), finish: 'keycap' });
    // A key that only looks like one (an Object prototype name) isn't one.
    expect(lookFor({ id: 'hiring', avatar: { shape: 'constructor' } }).shape).toBe(
      defaultLook('hiring').shape
    );
  });
});

describe('migration from the previous system', () => {
  it('moves every old shape to its nearest, and every old face to the nearest option', () => {
    expect(LEGACY_SHAPES).toEqual({
      rounded: 'squircle',
      pill: 'circle',
      drop: 'circle',
      cookie: 'circle',
      arch: 'squircle',
    });
    // Old keys that still exist keep their meaning.
    expect(lookFor({ id: 'x', avatar: { shape: 'circle' } }).shape).toBe('circle');
    expect(lookFor({ id: 'x', avatar: { shape: 'hexagon' } }).shape).toBe('hexagon');
    expect(lookFor({ id: 'x', avatar: { shape: 'squircle' } }).shape).toBe('squircle');
    // A face with a mouth keeps a mouth; one with only eyes keeps only eyes.
    for (const [old, now] of Object.entries(LEGACY_FACES)) {
      const hadMouth = !['quiet', 'content'].includes(old);
      expect(now).toBe(hadMouth ? 'smile' : 'dots');
    }
    // The ten old faces, all of them.
    expect(Object.keys(LEGACY_FACES)).toHaveLength(10);
    expect(lookFor({ id: 'x', avatar: { shape: 'drop', face: 'wink' } })).toEqual({
      shape: 'circle',
      face: 'smile',
      finish: 'keycap',
    });
    // Deterministic: the same stored look, the same answer, every time.
    const once = lookFor({ id: 'x', avatar: { shape: 'arch', face: 'quiet' } });
    expect(lookFor({ id: 'x', avatar: { shape: 'arch', face: 'quiet' } })).toEqual(once);
    expect(once).toEqual({ shape: 'squircle', face: 'dots', finish: 'keycap' });
  });
});

describe('freeLook', () => {
  it('starts a new agent on a shape nobody wears, never the Chief’s', () => {
    const taken = [
      { shape: 'circle' as const, face: 'dots' as const },
      { shape: 'hexagon' as const, face: 'dots' as const },
    ];
    expect(freeLook(taken, 'x')).toEqual({ shape: 'diamond', face: 'dots' });
    expect(freeLook([], 'y').shape).not.toBe('squircle');
  });
});

describe('describeLook', () => {
  it('says it the way the settings card (and the Mac) does', () => {
    expect(describeLook({ shape: 'hexagon', face: 'dots' })).toBe('a hexagon with dot eyes');
    expect(describeLook({ shape: 'circle', face: 'smile' })).toBe('a circle with eyes and a mouth');
    expect(describeLook({ shape: 'diamond', finish: 'embossed' })).toBe('an embossed diamond');
    expect(describeLook({ face: 'monogram' })).toBe('a monogram');
    expect(describeLook({ finish: 'embossed' })).toBe('an embossed key');
    for (const s of AVATAR_SHAPES) expect(SHAPE_NAMES[s]).toBeTruthy();
    for (const f of AVATAR_FACES) expect(FACE_NAMES[f]).toBeTruthy();
    expect(FINISH_NAMES.keycap).toBe('Key cap');
  });
});

// ------------------------------------------------------------------ geometry

type Pt = [number, number];

function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDistance(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))
    );
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/** Room left between `p` and the edge, minus `r` (negative: it crosses). */
const clearance = (p: Pt, r: number, poly: Pt[]) =>
  inside(p, poly) ? edgeDistance(p, poly) - r : -1;

/** Points on a quadratic `M x y Q cx cy x y` mouth. */
function mouthPoints(d: string): Pt[] {
  const [x0, y0, cx, cy, x1, y1] = d.match(/-?[\d.]+/g)!.map(Number);
  return Array.from({ length: 11 }, (_, i) => {
    const t = i / 10;
    return [
      (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1,
      (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1,
    ] as Pt;
  });
}

describe('the drawing', () => {
  it('draws four even shapes: one area, inside the grid with room for the shadow', () => {
    for (const s of AVATAR_SHAPES) {
      const pts = SHAPE_POINTS[s];
      let a = 0;
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
      });
      expect(Math.abs(a / 2) / SHAPE_AREA).toBeCloseTo(1, 2);
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThan(0.5);
        expect(x).toBeLessThan(31.5);
        expect(y).toBeGreaterThan(0.5);
        // The shadow sits KEY.shadow.dy below; its blur may reach the edge, not past it.
        expect(y + KEY.shadow.dy).toBeLessThan(32);
      }
      expect(SHAPE_PATHS[s]).toMatch(/^M[\d.]+ [\d.]+L/);
      expect(SHAPE_PATHS[s]).not.toMatch(/NaN/);
    }
  });

  it('keeps every feature off the edge of its shape, wherever the motion takes it', () => {
    // The face lives in the top's own coordinates, the same shape as the
    // silhouette, so the shape's outline is the edge to keep clear of. The
    // worst case: the largest eyes (16px, where they grow to stay visible),
    // moved as far as any mood moves them, with a unit to spare.
    const SPARE = 1;
    for (const shape of AVATAR_SHAPES) {
      const poly = SHAPE_POINTS[shape];
      for (const face of AVATAR_FACES) {
        const spec = FACE_SPECS[face];
        for (const [px, reach] of [
          [16, FACE_REACH * SMALL_MOTION],
          [24, FACE_REACH],
          [96, FACE_REACH],
        ] as const) {
          const features: [Pt, number][] = [];
          if (spec.monogram) {
            // A capital at 15 units: about 10.5 tall, 10 wide at its widest (W, M).
            const top = MONOGRAM.y - MONOGRAM.size * 0.72;
            for (const [x, y] of [
              [MONOGRAM.x - 5, top],
              [MONOGRAM.x + 5, top],
              [MONOGRAM.x - 5, MONOGRAM.y],
              [MONOGRAM.x + 5, MONOGRAM.y],
            ] as Pt[]) {
              features.push([[x, y], 0]);
            }
          } else {
            for (const e of spec.eyes.map((eye) => eyeAt(eye, px))) {
              features.push([[e.cx, e.cy], Math.max(e.rx, e.ry)]);
            }
            if (spec.mouth && px > 18) {
              for (const p of mouthPoints(spec.mouth)) features.push([p, faceWeight(px) / 2]);
            }
          }
          for (const [p, r] of features) {
            const room = clearance(p, r + reach, poly);
            expect(room, `${shape} ${face} ${px}px at ${p.join(',')}`).toBeGreaterThan(SPARE);
          }
        }
      }
    }
  });

  it('never closes an eye: every face has two open ovals, taller than wide', () => {
    for (const f of AVATAR_FACES) {
      const { eyes } = FACE_SPECS[f];
      expect(eyes).toHaveLength(2);
      for (const e of eyes) expect(e.ry).toBeGreaterThan(e.rx);
    }
  });

  it('keeps small features visible: eyes never under 2.2 device px, the mouth line never under 1.5', () => {
    for (const px of [16, 18, 24, 48, 96]) {
      const e = eyeAt(FACE_SPECS.dots.eyes[0], px);
      expect((e.rx * 2 * px) / 32).toBeGreaterThanOrEqual(2.19);
      expect((faceWeight(px) * px) / 32).toBeGreaterThanOrEqual(1.49);
    }
    // Above the floor, the weight is the same fraction of the avatar.
    expect(faceWeight(48)).toBe(faceWeight(96));
  });
});

// --------------------------------------------------------------------- colour

function hexToOklab(hex: string): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function luminance(hex: string): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the palette', () => {
  const hues = Object.keys(AVATAR_TONES).filter((k) => AVATAR_TONES[k].maxChroma === undefined);
  const themes: AvatarTheme[] = ['dark', 'light'];

  it('paints every hue at one lightness per role and theme (equal OKLCH)', () => {
    for (const theme of themes) {
      for (const role of ['fill', 'side', 'ink', 'well', 'topHigh', 'topLow'] as const) {
        const ls = hues.map((h) => hexToOklab(avatarPaint(h, theme)[role]!)[0]);
        expect(Math.max(...ls) - Math.min(...ls), `${theme} ${role}`).toBeLessThan(0.006);
      }
      const solids = hues.map((h) => hexToOklab(avatarPaint(h, theme, true).fill)[0]);
      expect(Math.max(...solids) - Math.min(...solids)).toBeLessThan(0.006);
    }
  });

  it('keeps every face legible on its key, in both themes', () => {
    for (const theme of themes) {
      for (const color of Object.keys(AVATAR_TONES)) {
        const p = avatarPaint(color, theme);
        expect(contrast(p.ink!, p.fill), `${theme} ${color}`).toBeGreaterThan(3.5);
        // The side is a step darker than the top, so the key reads raised.
        expect(luminance(p.side)).toBeLessThan(luminance(p.topLow));
      }
    }
  });

  it('falls back to gray for a colour it does not know', () => {
    expect(avatarPaint('neon', 'dark')).toEqual(avatarPaint('gray', 'dark'));
  });
});

describe('the typing key', () => {
  const themes: AvatarTheme[] = ['dark', 'light'];
  /** Where the working line sits: the app's surface (`--surface-app`; the phone's `surfaceApp`). */
  const surface: Record<AvatarTheme, string> = { dark: '#141414', light: '#ffffff' };

  it('keeps the face legible on the key, every colour, both themes', () => {
    for (const theme of themes) {
      for (const color of Object.keys(AVATAR_TONES)) {
        const k = typingKeyPaint(color, theme);
        expect(contrast(k.ink, k.topLow), `${theme} ${color}`).toBeGreaterThan(4);
        expect(contrast(k.ink, k.topHigh), `${theme} ${color}`).toBeGreaterThan(4);
      }
    }
  });

  it('reads raised and stands off the page, every colour, both themes', () => {
    for (const theme of themes) {
      for (const color of Object.keys(AVATAR_TONES)) {
        const k = typingKeyPaint(color, theme);
        // A side a step darker than the top, a top lit from above.
        expect(contrast(k.side, k.topLow), `${theme} ${color}`).toBeGreaterThan(1.3);
        expect(luminance(k.side)).toBeLessThan(luminance(k.topLow));
        expect(luminance(k.topLow)).toBeLessThan(luminance(k.topHigh));
        // The key (its side at least: a white top on a white page is the
        // site's white key, set off by its side, ring and drop) is clear of the page.
        const off = Math.max(contrast(k.side, surface[theme]), contrast(k.fill, surface[theme]));
        expect(off, `${theme} ${color}`).toBeGreaterThan(1.5);
      }
    }
  });

  it('paints every hue at one lightness (equal OKLCH)', () => {
    const hues = Object.keys(AVATAR_TONES).filter((k) => AVATAR_TONES[k].maxChroma === undefined);
    for (const theme of themes) {
      for (const role of ['topHigh', 'topLow', 'side', 'ink'] as const) {
        const ls = hues.map((h) => hexToOklab(typingKeyPaint(h, theme)[role])[0]);
        expect(Math.max(...ls) - Math.min(...ls), `${theme} ${role}`).toBeLessThan(0.006);
      }
    }
  });

  it('is the steps’ column wide, travels a few px, and fits its drawing', () => {
    expect(TYPING_KEY.size).toBeGreaterThanOrEqual(LIT_MIN_PX);
    expect(TYPING_KEY.travel).toBeGreaterThanOrEqual(2);
    expect(TYPING_KEY.travel).toBeLessThanOrEqual(4);
    expect(TYPING_KEY_UNITS.travel).toBeCloseTo((TYPING_KEY.travel / TYPING_KEY.size) * 32, 6);
    expect(TYPING_KEY_VIEWBOX).toBe(`0 0 32 ${32 + TYPING_KEY_UNITS.travel}`);
    // The side, set down by the travel, stays inside the box.
    for (const shape of AVATAR_SHAPES) {
      const bottom = Math.max(...SHAPE_POINTS[shape].map((p) => p[1]));
      expect(bottom + TYPING_KEY_UNITS.travel, shape).toBeLessThanOrEqual(
        32 + TYPING_KEY_UNITS.travel
      );
    }
    expect(TYPING_KEY.pressedDrop).toBeGreaterThan(0);
    expect(TYPING_KEY.pressedDrop).toBeLessThan(1);
  });

  it('presses within its travel, in a calm rhythm', () => {
    const press = TYPING_KEY.press;
    expect(press[0]).toEqual([0, 0]);
    expect(press[press.length - 1]).toEqual([1, 0]);
    for (let i = 1; i < press.length; i++) expect(press[i][0]).toBeGreaterThan(press[i - 1][0]);
    for (const [, d] of press) expect(Math.abs(d)).toBeLessThanOrEqual(1);
    // A full press reaches the bottom: the side is gone for a moment.
    expect(Math.max(...press.map((k) => k[1]))).toBe(1);
    // Most of the loop is rest: a calm rhythm, not a buzz.
    expect(press[press.length - 2][0]).toBeLessThan(0.5);
  });
});

// --------------------------------------------------------------------- motion

describe('the motion', () => {
  it('moves only a little, and starts and ends every loop at rest', () => {
    expect(FACE_REACH).toBeLessThan(1.6);
    for (const [mood, m] of Object.entries(AVATAR_MOTION)) {
      for (const keys of [m.face, m.press, m.glow]) {
        if (!keys) continue;
        expect(keys[0][0]).toBe(0);
        expect(keys[keys.length - 1][0]).toBe(1);
        const times = keys.map((k) => k[0]);
        expect([...times].sort((a, b) => a - b)).toEqual(times);
        if (m.loop) expect(keys[0].slice(1)).toEqual(keys[keys.length - 1].slice(1));
      }
      // A press always comes back up.
      if (m.press) expect(m.press[m.press.length - 1][1], mood).toBe(0);
    }
    // Faint: the breathing light never reaches full strength.
    expect(Math.max(...AVATAR_MOTION.working.glow!.map((k) => k[1]))).toBeLessThanOrEqual(0.6);
  });

  it('picks a mood from what a row knows: needs you first, then working, then failed', () => {
    expect(moodOf({ needsYou: true, working: true, failed: false })).toBe('needs');
    expect(moodOf({ needsYou: false, working: true, failed: true })).toBe('working');
    expect(moodOf({ needsYou: false, working: false, failed: true })).toBe('failed');
    expect(moodOf({ needsYou: false, working: false, failed: false })).toBe('idle');
  });
});
