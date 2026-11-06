/**
 * An agent's avatar: one soft shape, a minimal face, its colour. The one
 * spec both clients draw from — the desk's `AgentAvatar` (an SVG in the
 * webview) and the phone's (react-native-svg) — so the same agent is the
 * same little character everywhere. Design and the directions considered:
 * docs/internal/avatars.md.
 *
 * Geometry lives on a 32-unit grid. Shapes fill it (optically balanced, so
 * a circle and a square read the same size); a face is two open eyes and at
 * most one mouth, every one of them a round-capped stroke at one weight in
 * one ink, set on a shared grid and moved to each shape's optical centre.
 * The weight is a fixed fraction of the avatar with a device-pixel floor
 * (`faceWeight`), so 24px and 96px are the same drawing and 16px still reads.
 *
 * What the registry stores is keys (`AgentLook`), never paths, so a drawing
 * can be refined without touching anyone's saved choice. Keys are append-only.
 */

export const AVATAR_SHAPES = [
  'circle',
  'rounded',
  'squircle',
  'hexagon',
  'pill',
  'drop',
  'cookie',
  'arch',
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_FACES = [
  'calm',
  'cheerful',
  'curious',
  'focused',
  'sleepy',
  'wink',
  'determined',
  'quiet',
  'content',
  'bright',
] as const;
export type AvatarFace = (typeof AVATAR_FACES)[number];

/** What an agent chose (the registry's `avatar`). Absent: `lookFor` derives one from its id. */
export interface AgentLook {
  shape: AvatarShape;
  face: AvatarFace;
}

/** The words the picker and the settings card use. */
export const SHAPE_NAMES: Record<AvatarShape, string> = {
  circle: 'Circle',
  rounded: 'Rounded square',
  squircle: 'Squircle',
  hexagon: 'Hexagon',
  pill: 'Pill',
  drop: 'Drop',
  cookie: 'Cookie',
  arch: 'Arch',
};

export const FACE_NAMES: Record<AvatarFace, string> = {
  calm: 'Calm',
  cheerful: 'Cheerful',
  curious: 'Curious',
  focused: 'Focused',
  sleepy: 'Sleepy',
  wink: 'Wink',
  determined: 'Determined',
  quiet: 'Quiet',
  content: 'Content',
  bright: 'Bright',
};

/** The Chief of Staff's own default: the only squircle nobody chose. */
export const CHIEF_LOOK: AgentLook = { shape: 'squircle', face: 'calm' };

export const isAvatarShape = (v: unknown): v is AvatarShape =>
  typeof v === 'string' && (AVATAR_SHAPES as readonly string[]).includes(v);
export const isAvatarFace = (v: unknown): v is AvatarFace =>
  typeof v === 'string' && (AVATAR_FACES as readonly string[]).includes(v);

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
 * The look an agent wears: its own choice, else one derived from its id
 * (so an agent made before avatars never changes from one launch to the
 * next). The Chief's default is its own; nobody else's default is a
 * squircle, so its silhouette stays its until someone picks one.
 */
export function lookFor(agent: {
  id: string;
  isMain?: boolean;
  avatar?: Partial<AgentLook> | null;
}): AgentLook {
  const chosen = agent.avatar;
  const fallback = defaultLook(agent.id, Boolean(agent.isMain));
  return {
    shape: isAvatarShape(chosen?.shape) ? chosen.shape : fallback.shape,
    face: isAvatarFace(chosen?.face) ? chosen.face : fallback.face,
  };
}

/**
 * Faces a default may land on. A wink and a sleepy face are a personality
 * someone picks, not one handed out: three winks in a sidebar read as a gag.
 */
export const DEFAULT_FACES = AVATAR_FACES.filter((f) => f !== 'wink' && f !== 'sleepy');

export function defaultLook(id: string, isMain = false): AgentLook {
  if (isMain) return CHIEF_LOOK;
  const h = hash(id);
  const shapes = AVATAR_SHAPES.filter((s) => s !== CHIEF_LOOK.shape);
  return {
    shape: shapes[h % shapes.length],
    face: DEFAULT_FACES[(h >>> 8) % DEFAULT_FACES.length],
  };
}

/**
 * A look for a new agent: a shape nobody wears yet if there is one (the
 * Chief's left alone), then a face nobody wears with it. `seed` picks among
 * the free ones, so two new agents in a row don't come out alike.
 */
export function freeLook(taken: AgentLook[], seed = ''): AgentLook {
  const h = hash(seed || String(taken.length));
  const shapes = AVATAR_SHAPES.filter((s) => s !== CHIEF_LOOK.shape);
  const freeShapes = shapes.filter((s) => !taken.some((t) => t.shape === s));
  const shapePool = freeShapes.length ? freeShapes : shapes;
  const shape = shapePool[h % shapePool.length];
  const usedFaces = taken.filter((t) => t.shape === shape).map((t) => t.face);
  const freeFaces = DEFAULT_FACES.filter((f) => !usedFaces.includes(f));
  const facePool = freeFaces.length ? freeFaces : DEFAULT_FACES;
  return { shape, face: facePool[(h >>> 8) % facePool.length] };
}

/** "a hexagon with a curious face", for a settings card and the agent's own note. */
export function describeLook(look: Partial<AgentLook>): string {
  const shape = look.shape && SHAPE_NAMES[look.shape].toLowerCase();
  const face = look.face && FACE_NAMES[look.face].toLowerCase();
  if (shape && face) return `${article(shape)} ${shape} with a ${face} face`;
  if (shape) return `${article(shape)} ${shape}`;
  if (face) return `a ${face} face`;
  return '';
}

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

// ------------------------------------------------------------------ geometry

/** The grid every path is drawn on. */
export const AVATAR_GRID = 32;
const C = AVATAR_GRID / 2;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A regular polygon with soft corners: each corner a quadratic through the vertex. */
function softPolygon(sides: number, radius: number, rotate: number, soften: number): string {
  const pts = Array.from({ length: sides }, (_, i) => {
    const a = rotate + (i * 2 * Math.PI) / sides;
    return [C + radius * Math.cos(a), C + radius * Math.sin(a)] as const;
  });
  const lerp = (a: readonly [number, number], b: readonly [number, number], t: number) =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
  let d = '';
  pts.forEach((p, i) => {
    const prev = pts[(i - 1 + sides) % sides];
    const next = pts[(i + 1) % sides];
    const a = lerp(p, prev, soften);
    const b = lerp(p, next, soften);
    d += `${i === 0 ? 'M' : 'L'}${r2(a[0])} ${r2(a[1])}Q${r2(p[0])} ${r2(p[1])} ${r2(b[0])} ${r2(b[1])}`;
  });
  return `${d}Z`;
}

/** A circle with gentle scallops (`lobes` of them), sampled finely enough to stay smooth at 96px. */
function scalloped(lobes: number, radius: number, depth: number): string {
  const steps = 144;
  let d = '';
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI - Math.PI / 2;
    const r = radius + depth * Math.cos(lobes * a);
    d += `${i === 0 ? 'M' : 'L'}${r2(C + r * Math.cos(a))} ${r2(C + r * Math.sin(a))}`;
  }
  return `${d}Z`;
}

/** A rectangle with each corner its own radius (tl, tr, br, bl). */
function roundedRect(x: number, y: number, w: number, h: number, r: number[]): string {
  // Indexed, not destructured: the phone's Babel would need a runtime helper for it.
  const tl = r[0];
  const tr = r[1];
  const br = r[2];
  const bl = r[3];
  return [
    `M${x + tl} ${y}`,
    `H${x + w - tr}`,
    `A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}`,
    `V${y + h - br}`,
    `A${br} ${br} 0 0 1 ${x + w - br} ${y + h}`,
    `H${x + bl}`,
    `A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}`,
    `V${y + tl}`,
    `A${tl} ${tl} 0 0 1 ${x + tl} ${y}`,
    'Z',
  ].join('');
}

interface ShapeSpec {
  /** The silhouette, filled. */
  d: string;
  /**
   * Where the face sits, relative to the grid's centre, and how big: the
   * shape's optical centre (an arch's weight is low, a drop's leans away
   * from its point) and how much room it leaves (a pill is narrow).
   */
  face: { dx: number; dy: number; scale: number };
}

export const SHAPE_SPECS: Record<AvatarShape, ShapeSpec> = {
  circle: { d: `M16 1A15 15 0 1 1 15.99 1Z`, face: { dx: 0, dy: 0, scale: 1 } },
  rounded: {
    d: roundedRect(2.25, 2.25, 27.5, 27.5, [8, 8, 8, 8]),
    face: { dx: 0, dy: 0, scale: 1 },
  },
  squircle: {
    d: 'M16 1.5C27.6 1.5 30.5 4.4 30.5 16S27.6 30.5 16 30.5 1.5 27.6 1.5 16 4.4 1.5 16 1.5Z',
    face: { dx: 0, dy: 0, scale: 1 },
  },
  hexagon: { d: softPolygon(6, 15.6, -Math.PI / 2, 0.24), face: { dx: 0, dy: 0.2, scale: 0.94 } },
  pill: {
    d: roundedRect(4.75, 1, 22.5, 30, [11.25, 11.25, 11.25, 11.25]),
    face: { dx: 0, dy: 0, scale: 0.9 },
  },
  drop: {
    d: roundedRect(2.25, 2.25, 27.5, 27.5, [13.75, 3.5, 13.75, 13.75]),
    face: { dx: -0.5, dy: 0.5, scale: 1 },
  },
  cookie: { d: scalloped(8, 14.3, 0.7), face: { dx: 0, dy: 0, scale: 0.96 } },
  arch: { d: roundedRect(3, 1.5, 26, 29, [13, 13, 4.5, 4.5]), face: { dx: 0, dy: 1, scale: 0.96 } },
};

/**
 * A face's strokes. Every feature, eyes and mouth alike, is one round-capped
 * line at the one face weight (`faceWeight`): a dot eye is a very short
 * vertical stroke (so it reads as a soft, slightly tall dot), a tall eye a
 * longer one, a mouth a line or a shallow curve. Eyes are always open: no
 * lids, no winks, no blink (the owner's call: a closed-eye face looks
 * horrible at this size).
 */
export interface FaceStroke {
  d: string;
  role: 'eye' | 'mouth';
}

// The face grid, before a shape moves and sizes it (`SHAPE_SPECS[].face`).
// Eyes 8.5 apart on a line a touch below the middle, the mouth 4.75 under them:
// low-set features read friendlier, and the face's own centre (between the
// eye line and the mouth) lands on the shape's optical centre plus a little.
const EL = 11.75;
const ER = 20.25;
const EY = 15;
const MY = 19.75;
/** A glance moves both eyes this far (grid units). */
const GLANCE = 0.9;

/** A round eye: a 1-unit stroke, so it's a soft oval a little taller than wide. */
const dot = (x: number, y = EY): FaceStroke => ({
  d: `M${r2(x)} ${r2(y - 0.5)}v1`,
  role: 'eye',
});
/** A tall eye: the same weight, 2.4 units long. */
const tall = (x: number, y = EY): FaceStroke => ({
  d: `M${r2(x)} ${r2(y - 1.2)}v2.4`,
  role: 'eye',
});
/** A smile `w` wide whose curve dips `dip` below its ends. */
const smile = (w: number, dip: number, x = 16, y = MY): FaceStroke => ({
  d: `M${r2(x - w / 2)} ${r2(y - dip / 2)}q${r2(w / 2)} ${r2(dip * 2)} ${w} 0`,
  role: 'mouth',
});
const flat = (w: number, x = 16, y = MY): FaceStroke => ({
  d: `M${r2(x - w / 2)} ${r2(y)}h${w}`,
  role: 'mouth',
});
/** A smile lifted at one end only. */
const smirk = (w: number, x = 16, y = MY): FaceStroke => ({
  d: `M${r2(x - w / 2)} ${r2(y + w * 0.04)}q${r2(w * 0.5)} ${r2(w * 0.26)} ${w} ${r2(-w * 0.16)}`,
  role: 'mouth',
});

export const FACE_SPECS: Record<AvatarFace, FaceStroke[]> = {
  calm: [dot(EL), dot(ER), smile(4, 0.9)],
  cheerful: [dot(EL), dot(ER), smile(5.6, 1.5)],
  curious: [
    dot(EL + GLANCE, EY - GLANCE * 0.6),
    dot(ER + GLANCE, EY - GLANCE * 0.6),
    flat(2.4, 16 + GLANCE),
  ],
  focused: [dot(EL), dot(ER), flat(3.4)],
  // Gaze down and features low: unhurried, not asleep.
  sleepy: [dot(EL, EY + 0.9), dot(ER, EY + 0.9), flat(2.2, 16, MY + 0.5)],
  // The cheek of a wink without closing an eye: a sideways glance and a smirk.
  wink: [dot(EL - GLANCE, EY), dot(ER - GLANCE, EY), smirk(4.2, 16 - 0.3)],
  determined: [tall(EL), tall(ER), flat(4.4)],
  quiet: [tall(EL, EY + 0.75), tall(ER, EY + 0.75)],
  content: [dot(EL, EY + 0.75), dot(ER, EY + 0.75)],
  bright: [tall(EL), tall(ER), smile(4.8, 1.3)],
};

/**
 * The one stroke weight, in grid units, for an avatar `px` wide: the same
 * fraction of the avatar at every size (so 24px and 96px are the same
 * drawing), with a floor of `MIN_FACE_PX` device pixels below about 23px,
 * where a proportional stroke would go faint. Eyes and mouth share it.
 */
export const FACE_WEIGHT = 2.1;
export const MIN_FACE_PX = 1.6;
export function faceWeight(px: number): number {
  return r2(Math.max(FACE_WEIGHT, (MIN_FACE_PX * AVATAR_GRID) / px));
}

/**
 * The stroke width to draw a face with on `shape`, compensating the face
 * group's scale so a pill's narrower face keeps exactly the same line as a
 * circle's.
 */
export function faceStrokeWidth(px: number, shape: AvatarShape): number {
  return r2(faceWeight(px) / SHAPE_SPECS[shape].face.scale);
}

/** The face group's transform for a shape: its optical centre and room. */
export function faceTransform(shape: AvatarShape): string {
  const { dx, dy, scale } = SHAPE_SPECS[shape].face;
  if (dx === 0 && dy === 0 && scale === 1) return '';
  return `translate(${r2(C + dx)} ${r2(C + dy)}) scale(${scale}) translate(${-C} ${-C})`;
}

/**
 * The look's motion, same on both clients: when a turn ends, one bob.
 * Nothing else ever moves, and never the eyes; nothing with Reduce Motion.
 */
export const BOB_MS = 520;
/** How far a bob lifts, as a fraction of the avatar's size. */
export const BOB_LIFT = 0.08;
