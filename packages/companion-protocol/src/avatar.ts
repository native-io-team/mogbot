/**
 * An agent's avatar: a key cap. One of four even shapes (one construction,
 * one area, so none reads bigger), raised like a key on a keyboard: a darker
 * side, a lit top set up off it, and a soft shadow under the lot. A face sits
 * on the top: dot eyes, eyes and a mouth, a debossed face, or a monogram.
 * Below 24px the key goes flat. The one spec both clients draw from: the
 * desk's `AgentAvatar` (an SVG in the webview) and the phone's
 * (react-native-svg), so the same agent is the same key everywhere. The
 * design, why it won and the motion rules: docs/internal/avatars.md.
 *
 * Geometry lives on a 32-unit grid. Colour is equal OKLCH per theme: every
 * hue at one lightness and one chroma per role, so no agent pops and none
 * sinks. What the registry stores is keys (`AgentLook`), never paths or
 * colours, so a drawing can be refined without touching anyone's choice.
 * Keys from the previous system migrate to the nearest one here
 * (`LEGACY_SHAPES`, `LEGACY_FACES`), the same way on the Mac.
 */

export const AVATAR_SHAPES = ['circle', 'squircle', 'diamond', 'hexagon'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_FACES = ['dots', 'smile', 'debossed', 'monogram'] as const;
export type AvatarFace = (typeof AVATAR_FACES)[number];

/** How the key is made: raised (the default) or pressed soft into the surface. */
export const AVATAR_FINISHES = ['keycap', 'embossed'] as const;
export type AvatarFinish = (typeof AVATAR_FINISHES)[number];

/** What an agent chose (the registry's `avatar`). Absent: `lookFor` derives one from its id. */
export interface AgentLook {
  shape: AvatarShape;
  face: AvatarFace;
  /** Absent: a key cap. */
  finish?: AvatarFinish;
}

/** The words the picker and the settings card use. */
export const SHAPE_NAMES: Record<AvatarShape, string> = {
  circle: 'Circle',
  squircle: 'Squircle',
  diamond: 'Diamond',
  hexagon: 'Hexagon',
};

export const FACE_NAMES: Record<AvatarFace, string> = {
  dots: 'Dot eyes',
  smile: 'Eyes and mouth',
  debossed: 'Debossed',
  monogram: 'Monogram',
};

export const FINISH_NAMES: Record<AvatarFinish, string> = {
  keycap: 'Key cap',
  embossed: 'Embossed',
};

/**
 * The face every default wears: dot eyes. Two dots read at 16px (nothing is
 * dropped, unlike a mouth), they move the most legibly when the face looks
 * around, and they stay out of the way in a list of twelve.
 */
export const DEFAULT_FACE: AvatarFace = 'dots';

/** The Chief of Staff's own default: the only squircle nobody chose. */
export const CHIEF_LOOK: AgentLook = { shape: 'squircle', face: DEFAULT_FACE };

/**
 * The previous system's keys, each to its nearest here. A shape goes to the
 * silhouette it most resembles; a face with a mouth keeps a mouth, one
 * without keeps just its eyes. Parsed by `avatar_tests.rs`: one `key: 'value',`
 * per line.
 */
export const LEGACY_SHAPES: Record<string, AvatarShape> = {
  rounded: 'squircle',
  pill: 'circle',
  drop: 'circle',
  cookie: 'circle',
  arch: 'squircle',
};
export const LEGACY_FACES: Record<string, AvatarFace> = {
  calm: 'smile',
  cheerful: 'smile',
  curious: 'smile',
  focused: 'smile',
  sleepy: 'smile',
  wink: 'smile',
  determined: 'smile',
  bright: 'smile',
  quiet: 'dots',
  content: 'dots',
};

export const isAvatarShape = (v: unknown): v is AvatarShape =>
  typeof v === 'string' && (AVATAR_SHAPES as readonly string[]).includes(v);
export const isAvatarFace = (v: unknown): v is AvatarFace =>
  typeof v === 'string' && (AVATAR_FACES as readonly string[]).includes(v);
export const isAvatarFinish = (v: unknown): v is AvatarFinish =>
  typeof v === 'string' && (AVATAR_FINISHES as readonly string[]).includes(v);

const own = (map: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** A stored shape key, migrated: this system's, the nearest for an old one, else nothing. */
export function shapeKey(v: unknown): AvatarShape | undefined {
  if (isAvatarShape(v)) return v;
  return typeof v === 'string' ? (own(LEGACY_SHAPES, v) as AvatarShape | undefined) : undefined;
}
export function faceKey(v: unknown): AvatarFace | undefined {
  if (isAvatarFace(v)) return v;
  return typeof v === 'string' ? (own(LEGACY_FACES, v) as AvatarFace | undefined) : undefined;
}

/** FNV-1a: a stable 32-bit hash of the id, the same on every client. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The look an agent wears: its own choice (migrated if it was made under the
 * previous system), else one derived from its id, field by field. Always
 * says its finish.
 */
export function lookFor(agent: {
  id: string;
  isMain?: boolean;
  avatar?: { shape?: unknown; face?: unknown; finish?: unknown } | null;
}): Required<AgentLook> {
  const chosen = agent.avatar;
  const fallback = defaultLook(agent.id, Boolean(agent.isMain));
  return {
    shape: shapeKey(chosen?.shape) ?? fallback.shape,
    face: faceKey(chosen?.face) ?? fallback.face,
    finish: isAvatarFinish(chosen?.finish) ? chosen.finish : 'keycap',
  };
}

/** Shapes a default may land on: every one but the Chief's. */
const DEFAULT_SHAPES = AVATAR_SHAPES.filter((s) => s !== CHIEF_LOOK.shape);

export function defaultLook(id: string, isMain = false): AgentLook {
  if (isMain) return CHIEF_LOOK;
  return { shape: DEFAULT_SHAPES[hash(id) % DEFAULT_SHAPES.length], face: DEFAULT_FACE };
}

/**
 * A look for a new agent: a shape nobody wears yet if there is one (the
 * Chief's left alone), the default face. `seed` picks among the free shapes,
 * so two new agents in a row don't come out alike.
 */
export function freeLook(taken: AgentLook[], seed = ''): AgentLook {
  const h = hash(seed || String(taken.length));
  const free = DEFAULT_SHAPES.filter((s) => !taken.some((t) => t.shape === s));
  const pool = free.length ? free : DEFAULT_SHAPES;
  return { shape: pool[h % pool.length], face: DEFAULT_FACE };
}

const FACE_PHRASES: Record<AvatarFace, string> = {
  dots: 'dot eyes',
  smile: 'eyes and a mouth',
  debossed: 'a debossed face',
  monogram: 'a monogram',
};

/**
 * "a hexagon with dot eyes", "an embossed circle", for a settings card and
 * the agent's own note (`AgentLook::describe` on the Mac says it the same).
 */
export function describeLook(look: Partial<AgentLook>): string {
  const finish = look.finish === 'embossed' ? 'embossed ' : '';
  const shape = look.shape && SHAPE_NAMES[look.shape].toLowerCase();
  const face = look.face && FACE_PHRASES[look.face];
  const thing = shape ? `${finish}${shape}` : finish ? 'embossed key' : '';
  if (thing && face) return `${article(thing)} ${thing} with ${face}`;
  if (thing) return `${article(thing)} ${thing}`;
  if (face) return face;
  return '';
}

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

// ------------------------------------------------------------------ geometry

/** The grid every path is drawn on. */
export const AVATAR_GRID = 32;
const C = AVATAR_GRID / 2;
const r2 = (n: number) => Math.round(n * 100) / 100;

type Pt = [number, number];

/** A superellipse of exponent `n`, unit size, turned by `rot`. */
function superPts(n: number, rot: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 160; i++) {
    const a = (i / 160) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = Math.sign(s) * Math.abs(s) ** (2 / n);
    out.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

/** A hexagon, point up, each corner a quadratic through the vertex. */
function softHexPts(soften: number): Pt[] {
  const v: Pt[] = Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return [Math.cos(a), Math.sin(a)];
  });
  const lerp = (a: Pt, b: Pt, t: number): Pt => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const out: Pt[] = [];
  v.forEach((p, i) => {
    const a = lerp(p, v[(i + 5) % 6], soften);
    const b = lerp(p, v[(i + 1) % 6], soften);
    for (let j = 0; j <= 20; j++) {
      const t = j / 20;
      out.push([
        (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * p[0] + t * t * b[0],
        (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * p[1] + t * t * b[1],
      ]);
    }
  });
  return out;
}

function area(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** One area for every shape: a 13.9-unit circle's. */
export const SHAPE_AREA = Math.PI * 13.9 * 13.9;
function even(pts: Pt[]): Pt[] {
  const k = Math.sqrt(SHAPE_AREA / area(pts));
  return pts.map((p) => [r2(C + p[0] * k), r2(C + p[1] * k)] as Pt);
}
const toPath = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') + 'Z';

/** Each shape's outline, as points (for tests) and as a path. */
export const SHAPE_POINTS: Record<AvatarShape, Pt[]> = {
  circle: even(superPts(2, 0)),
  squircle: even(superPts(4.4, 0)),
  diamond: even(superPts(3, Math.PI / 4)),
  hexagon: even(softHexPts(0.32)),
};
export const SHAPE_PATHS: Record<AvatarShape, string> = {
  circle: toPath(SHAPE_POINTS.circle),
  squircle: toPath(SHAPE_POINTS.squircle),
  diamond: toPath(SHAPE_POINTS.diamond),
  hexagon: toPath(SHAPE_POINTS.hexagon),
};

/**
 * The key's construction. At `LIT_MIN_PX` and up: a shadow (the shape,
 * dropped and blurred), the side (the shape, darker) and the top (the shape
 * scaled to `top.scale` about `top`, a little above centre, so the side
 * shows along the bottom), lit by `capRim`. Below it, flat: one shape, no
 * light. An embossed finish has no side and no shadow; its whole shape is
 * the top, lit by a deeper rim.
 */
export const LIT_MIN_PX = 24;
export const KEY = {
  top: { x: 16, y: 15.1, scale: 0.9 },
  shadow: { dy: 1.1, blur: 0.9 },
  /** The rim light's offset on a key cap's top. */
  capRim: 0.7,
  /** An embossed shape's, by size: deeper when small, so it still reads. */
  embossRim: (px: number) => (px >= 40 ? 0.9 : 1.2),
  /** The top's gradient: this much lighter at the top, darker at the bottom. */
  gradient: 0.035,
} as const;

/** The top's transform, for an SVG `transform` attribute. */
export const TOP_TRANSFORM = `translate(${KEY.top.x} ${KEY.top.y}) scale(${KEY.top.scale}) translate(${-C} ${-C})`;

/** The rim light's blur for a rim of `depth`: light spreads wider than shade. */
export const rimBlur = (depth: number) => ({ light: r2(depth * 0.8), shade: r2(depth * 0.9) });

// ---------------------------------------------------------------------- faces

/** An eye: a filled oval. */
export interface Eye {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface FaceSpec {
  eyes: [Eye, Eye];
  /** A round-capped stroke, dropped at `MOUTH_MIN_PX` and below. */
  mouth?: string;
  /**
   * Pressed into the top when the key is lit (and not selected): each feature
   * a well in a darker tone with a light lip `DEBOSS_DEPTH` under it, rather
   * than ink laid on top.
   */
  pressed?: boolean;
  /** The agent's initial instead of eyes (`MONOGRAM`). */
  monogram?: boolean;
}

const EX = 12.3;
const EX2 = 19.7;
const EY = 14.6;
const pair = (y: number, rx: number, ry: number): [Eye, Eye] => [
  { cx: EX, cy: y, rx, ry },
  { cx: EX2, cy: y, rx, ry },
];

export const FACE_SPECS: Record<AvatarFace, FaceSpec> = {
  dots: { eyes: pair(EY + 0.6, 1.6, 2.1) },
  smile: { eyes: pair(EY, 1.5, 2), mouth: 'M14 19.7Q16 21.2 18 19.7' },
  debossed: { eyes: pair(EY, 1.65, 2.15), mouth: 'M13.8 19.7Q16 21.3 18.2 19.7', pressed: true },
  monogram: { eyes: pair(EY, 1.65, 2.15), monogram: true, pressed: true },
};

export const MOUTH_MIN_PX = 18;
export const DEBOSS_DEPTH = 0.7;
/** The monogram's letter: one capital, centred on the top. */
export const MONOGRAM = { x: 16, y: 21.4, size: 15, weight: '600' } as const;

export const monogramLetter = (name: string) => (name.trim()[0] ?? 'A').toUpperCase();

/** Grid units for `devicePx` device pixels at an avatar `px` wide. */
const units = (px: number, devicePx: number) => (devicePx * AVATAR_GRID) / px;

/** The mouth's weight: 6.25% of the avatar, never under 1.5 device pixels. */
export function faceWeight(px: number): number {
  return r2(Math.max(2, units(px, 1.5)));
}

/** An eye drawn at `px`: never smaller than 2.2 device pixels across. */
export function eyeAt(eye: Eye, px: number): Eye {
  const k = Math.max(1, units(px, 2.2) / (eye.rx * 2));
  return { cx: eye.cx, cy: eye.cy, rx: r2(eye.rx * k), ry: r2(eye.ry * k) };
}

/** True when the face is pressed in rather than drawn on. */
export const isPressed = (face: AvatarFace, px: number, selected: boolean) =>
  Boolean(FACE_SPECS[face].pressed) && px >= LIT_MIN_PX && !selected;

// --------------------------------------------------------------------- colour

export type AvatarTheme = 'dark' | 'light';

/**
 * Each colour key's hue (OKLCH degrees). Lightness and chroma are the role's,
 * the same for every hue. The neutrals take the role's lightness with little
 * or no chroma; white sits a step lighter than the rest so it stays apart
 * from gray, with a dark ink where it gets pale.
 */
interface Tone {
  hue: number;
  /** A ceiling on chroma (the neutrals). */
  maxChroma?: number;
  /** A shift on every lightness but the ink's, per theme. */
  lift?: Record<AvatarTheme, number>;
  /** Selected (solid): a shift on its lightness, per theme. */
  solidLift?: Record<AvatarTheme, number>;
  /** The ink is the light theme's (dark) in the dark theme too. */
  darkInk?: boolean;
}

export const AVATAR_TONES: Record<string, Tone> = {
  red: { hue: 25 },
  orange: { hue: 55 },
  amber: { hue: 84 },
  green: { hue: 150 },
  teal: { hue: 190 },
  blue: { hue: 262 },
  purple: { hue: 300 },
  pink: { hue: 350 },
  brown: { hue: 60, maxChroma: 0.045 },
  gray: { hue: 260, maxChroma: 0.018 },
  white: {
    hue: 0,
    maxChroma: 0,
    lift: { dark: 0.2, light: 0.11 },
    // On light, white is the theme's strongest neutral: near black, as the accent is.
    solidLift: { dark: 0.2, light: -0.45 },
    darkInk: true,
  },
};

/** The roles, per theme: [lightness, chroma]. */
export const AVATAR_ROLES = {
  /** The key's top, mid-gradient (and a flat key's whole fill). */
  clay: { dark: [0.53, 0.09], light: [0.86, 0.07] },
  /** The side: the clay, darker. */
  side: { dark: [0.4, 0.09], light: [0.74, 0.07] },
  /** The face. */
  ink: { dark: [0.95, 0.04], light: [0.36, 0.1] },
  /** A pressed feature's well. */
  well: { dark: [0.27, 0.06], light: [0.58, 0.09] },
  /** Selected: the colour itself. */
  solid: { dark: [0.74, 0.12], light: [0.7, 0.13] },
  solidSide: { dark: [0.6, 0.12], light: [0.56, 0.12] },
} as const satisfies Record<string, Record<AvatarTheme, readonly [number, number]>>;

/** Light and shade, as white and black at these opacities. */
export const AVATAR_LIGHT = {
  /** The rim light on the top edge, and the shade on the bottom one. */
  rimLight: { dark: 0.32, light: 0.75 },
  rimShade: { dark: 0.4, light: 0.16 },
  shadow: { dark: 0.55, light: 0.2 },
  /** A pressed feature's lip. */
  lip: { dark: 0.22, light: 0.95 },
} as const;

/** What to paint one key with. Colours are sRGB hex; light and shade are opacities. */
export interface AvatarPaint {
  /** A flat key's fill; the top's mid tone. */
  fill: string;
  topHigh: string;
  topLow: string;
  side: string;
  /** The face's ink. Selected: none, so the client uses its canvas colour. */
  ink: string | null;
  well: string;
  rimLight: number;
  rimShade: number;
  shadow: number;
  lip: number;
}

export function avatarPaint(color: string, theme: AvatarTheme, selected = false): AvatarPaint {
  const tone = AVATAR_TONES[color] ?? AVATAR_TONES.gray;
  const lift = tone.lift?.[theme] ?? 0;
  const at = (role: keyof typeof AVATAR_ROLES, dl = lift, inkTheme = theme) => {
    const lc = AVATAR_ROLES[role][inkTheme];
    const l = lc[0];
    const c = lc[1];
    return oklchHex(l + dl, Math.min(c, tone.maxChroma ?? c), tone.hue);
  };
  const solidLift = tone.solidLift?.[theme] ?? lift;
  const solid = at('solid', solidLift);
  return {
    fill: selected ? solid : at('clay'),
    topHigh: selected ? solid : at('clay', lift + KEY.gradient),
    topLow: selected ? solid : at('clay', lift - KEY.gradient),
    side: selected ? at('solidSide', solidLift) : at('side'),
    ink: selected ? null : at('ink', 0, tone.darkInk ? 'light' : theme),
    well: at('well'),
    rimLight: AVATAR_LIGHT.rimLight[theme],
    rimShade: AVATAR_LIGHT.rimShade[theme],
    shadow: AVATAR_LIGHT.shadow[theme],
    lip: AVATAR_LIGHT.lip[theme],
  };
}

// ------------------------------------------------------------ the typing key

/**
 * While an agent works, its avatar is a key being typed on
 * (docs/internal/avatars.md, "On a key"): the avatar itself, bigger, raised
 * in the site's key language. The shape's own silhouette is the top, lit
 * along its upper edge and shaded along its lower one; the same silhouette
 * set down by `travel`, darker, is the side under it; a soft drop sits
 * under that. A press moves the top (and the face on it) down into the
 * side, so the side shrinks to nothing at the bottom of a tap, and the drop
 * tightens; then it springs back up.
 *
 * Sizes are px; both clients draw the same box: `size` wide (the steps'
 * icon column, so the live line and the finished one share a grid) and
 * `size + travel` tall. The drawing is on the avatar's 32-unit grid, with
 * `TYPING_KEY_UNITS.travel` more units under it for the side.
 */
export const TYPING_KEY = {
  size: 24,
  /** The side showing under the top at rest, and how far a full press goes. */
  travel: 3,
  /** The drop's opacity at the bottom of a press (1 at rest): it tightens under the key. */
  pressedDrop: 0.45,
  /**
   * The rhythm: a tap, a lighter second tap, then a rest, like a key being
   * typed on. [time 0–1, depth 0–1 of `travel`]; a quick press, then a
   * small rebound above rest as it springs back. Segments ease in and out.
   */
  ms: 2400,
  press: [
    [0, 0],
    [0.04, 1],
    [0.12, -0.15],
    [0.18, 0],
    [0.26, 0.75],
    [0.33, -0.1],
    [0.38, 0],
    [1, 0],
  ] as readonly ValueKey[],
} as const;

/** The key's drawing, in the avatar's grid units. */
export const TYPING_KEY_UNITS = {
  /** The side's depth under the top. */
  travel: (TYPING_KEY.travel * AVATAR_GRID) / TYPING_KEY.size,
  /** The drop: the shape set down this far past the side, and blurred. */
  drop: { dy: 1.6, blur: 1.4 },
  /** The hairline round the top and the side: a stroke under the fill, so half of it shows. */
  ring: 1.2,
} as const;

/** The box the drawing is on: the grid, and the side under it. */
export const TYPING_KEY_VIEWBOX = `0 0 ${AVATAR_GRID} ${AVATAR_GRID + TYPING_KEY_UNITS.travel}`;

/** The key's roles, per theme: [lightness, chroma] at the agent's hue. */
export const TYPING_KEY_ROLES = {
  /** The top, mid-gradient: the agent's own colour, a pastel like the site's faces. */
  top: { dark: [0.74, 0.11], light: [0.82, 0.09] },
  /** The side under it, a step darker, so the key reads raised. */
  side: { dark: [0.55, 0.1], light: [0.66, 0.1] },
  /** The face, drawn dark on the top in both themes (the site's faces). */
  ink: { dark: [0.27, 0.05], light: [0.27, 0.05] },
  /** A pressed-in feature's well. */
  well: { dark: [0.52, 0.1], light: [0.6, 0.1] },
} as const satisfies Record<string, Record<AvatarTheme, readonly [number, number]>>;

/**
 * Each neutral's lift over the roles: white is the site's white key (a near
 * white top on a light-gray side), a step apart from gray.
 */
const TYPING_KEY_LIFT: Record<string, Record<AvatarTheme, number>> = {
  white: { dark: 0.2, light: 0.155 },
};

/** The key's light, as white and black at these opacities. */
export const TYPING_KEY_LIGHT = {
  rimLight: { dark: 0.45, light: 0.85 },
  rimShade: { dark: 0.22, light: 0.12 },
  /** The drop under the key at rest. */
  shadow: { dark: 0.6, light: 0.22 },
  /** The hairline round the top. */
  ring: { dark: 0.45, light: 0.08 },
  lip: { dark: 0.35, light: 0.7 },
} as const;

/** What to paint an agent's key with: an avatar's paint, plus its ring. */
export interface TypingKeyPaint extends AvatarPaint {
  ink: string;
  ring: number;
}

/** What to paint an agent's typing key with (sRGB hex; light and shade as opacities). */
export function typingKeyPaint(color: string, theme: AvatarTheme): TypingKeyPaint {
  const tone = AVATAR_TONES[color] ?? AVATAR_TONES.gray;
  const lift = TYPING_KEY_LIFT[color]?.[theme] ?? 0;
  const at = (role: keyof typeof TYPING_KEY_ROLES, dl: number) => {
    // Indexed, not destructured: the phone's Babel would need a runtime helper.
    const lc = TYPING_KEY_ROLES[role][theme];
    return oklchHex(lc[0] + dl, Math.min(lc[1], tone.maxChroma ?? lc[1]), tone.hue);
  };
  return {
    fill: at('top', lift),
    topHigh: at('top', lift + 0.045),
    topLow: at('top', lift - 0.03),
    side: at('side', lift),
    ink: at('ink', 0),
    well: at('well', lift),
    rimLight: TYPING_KEY_LIGHT.rimLight[theme],
    rimShade: TYPING_KEY_LIGHT.rimShade[theme],
    shadow: TYPING_KEY_LIGHT.shadow[theme],
    lip: TYPING_KEY_LIGHT.lip[theme],
    ring: TYPING_KEY_LIGHT.ring[theme],
  };
}

/** OKLab → linear sRGB, then gamma. */
function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * An OKLCH colour as sRGB hex. Out of gamut, chroma comes down until it fits:
 * lightness and hue are what "equal OKLCH" promises, so they never move.
 */
export function oklchHex(l: number, c: number, h: number): string {
  let rgb = oklchToRgb(l, c, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb(l, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgb(l, lo, h);
  }
  const gamma = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return `#${rgb
    .map((v) =>
      Math.round(gamma(v) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

// --------------------------------------------------------------------- motion

/**
 * What the avatar shows about its agent. Idle: the face drifts a little and
 * now and then glances aside. Working: it looks around (left, up, back) and
 * the top's rim light breathes faintly. Needs you: it looks out at you and
 * holds, after one press of the key. Done: one press and bounce, then idle.
 * Failed: one look down to the side, held. The eyes never close; nothing
 * rings it. Below `LIT_MIN_PX`, only the face moves, by `SMALL_MOTION`.
 */
export const AVATAR_MOODS = ['idle', 'working', 'needs', 'done', 'failed'] as const;
export type AvatarMood = (typeof AVATAR_MOODS)[number];

/** A keyframe: [time 0–1, x, y] in the top's grid units. */
export type FaceKey = readonly [number, number, number];
/** A keyframe: [time 0–1, value]. */
export type ValueKey = readonly [number, number];

export interface MoodMotion {
  ms: number;
  /** Loops for as long as the mood lasts; otherwise plays once and holds its end. */
  loop: boolean;
  face?: readonly FaceKey[];
  /** The top pressed down (grid units). */
  press?: readonly ValueKey[];
  /** An extra rim light on the top, as an opacity. */
  glow?: readonly ValueKey[];
}

/**
 * The motion, the same on both clients (agents-avatar.css holds these as
 * keyframes; a test checks them against this). Segments ease in and out.
 */
export const AVATAR_MOTION: Record<AvatarMood, MoodMotion> = {
  idle: {
    ms: 16000,
    loop: true,
    face: [
      [0, 0, 0],
      [0.22, 0.5, -0.3],
      [0.45, -0.4, 0.25],
      [0.62, 0, 0],
      [0.68, 1.3, -0.2],
      [0.8, 1.3, -0.2],
      [0.86, 0, 0],
      [1, 0, 0],
    ],
  },
  working: {
    ms: 4800,
    loop: true,
    face: [
      [0, 0, 0],
      [0.12, -1.4, 0],
      [0.34, -1.4, 0],
      [0.46, 0, -1.2],
      [0.66, 0, -1.2],
      [0.78, 0, 0],
      [1, 0, 0],
    ],
    glow: [
      [0, 0],
      [0.5, 0.6],
      [1, 0],
    ],
  },
  needs: {
    ms: 420,
    loop: false,
    face: [
      [0, 0, 0],
      [1, 0, -0.35],
    ],
    press: [
      [0, 0],
      [0.4, 0.7],
      [1, 0],
    ],
  },
  done: {
    ms: 560,
    loop: false,
    press: [
      [0, 0],
      [0.35, 0.8],
      [0.7, -0.25],
      [1, 0],
    ],
  },
  failed: {
    ms: 700,
    loop: false,
    face: [
      [0, 0, 0],
      [1, -1.1, 1],
    ],
  },
};

/** Below `LIT_MIN_PX`, the face moves this fraction as far, and nothing else moves. */
export const SMALL_MOTION = 0.4;

/** The furthest any mood moves the face, for the edge-clearance test. */
// Indexed and reduced, not destructured or spread: the phone's Babel would need a runtime helper.
export const FACE_REACH = Object.values(AVATAR_MOTION).reduce(
  (far, m) => (m.face ?? []).reduce((f, k) => Math.max(f, Math.hypot(k[1], k[2])), far),
  0
);

/**
 * A mood from what a row already knows. Needs you outranks working (a turn
 * waiting on a card is both); a failure shows only once nothing else does.
 */
export function moodOf(state: {
  needsYou: boolean;
  working: boolean;
  failed: boolean;
}): Exclude<AvatarMood, 'done'> {
  if (state.needsYou) return 'needs';
  if (state.working) return 'working';
  if (state.failed) return 'failed';
  return 'idle';
}

/**
 * Where an avatar starts in its idle loop (ms into it), so a sidebar of
 * twelve never drifts in step.
 */
export const idlePhase = (id: string) => hash(id) % AVATAR_MOTION.idle.ms;
