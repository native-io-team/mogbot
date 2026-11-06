/**
 * An agent's avatar: one soft shape, a minimal face, its colour. The one
 * spec both clients draw from — the desk's `AgentAvatar` (an SVG in the
 * webview) and the phone's (react-native-svg) — so the same agent is the
 * same little character everywhere. Design and the directions considered:
 * docs/internal/avatars.md.
 *
 * Geometry lives on a 32-unit grid. Shapes fill it (optically balanced, so
 * a circle and a square read the same size); a face is a few round-capped
 * strokes in one ink, about a third of the width, sitting just below the
 * middle. Stroke weights step up as the avatar gets smaller (`faceWeights`),
 * which is what keeps two dots and a line legible at 16px without making
 * them clumsy at 96px.
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
 * A face's strokes. `eye` strokes are the eyes (dots and short bars drawn
 * as zero- or short-length round-capped lines, so a dot is exactly as wide
 * as the eye weight) and are what blinks; `line` strokes are everything
 * else: closed-eye arcs, mouths.
 */
export interface FaceStroke {
  d: string;
  role: 'eye' | 'line';
  /** Part of the eyes (blinks with them), even when drawn as a line. */
  blinks?: boolean;
}

// Eyes 7 units apart on a line just above the middle; the mouth 5 below them.
const EL = 12.5;
const ER = 19.5;
const EY = 14.75;
/** Where the eyes sit (grid units): a blink squashes them toward this line. */
export const EYE_LINE = EY;
const MY = 19.75;

const dot = (x: number, y = EY): FaceStroke => ({ d: `M${x} ${y}h0`, role: 'eye' });
const bar = (x: number, y = EY): FaceStroke => ({ d: `M${x} ${y - 1.1}v2.2`, role: 'eye' });
const dash = (x: number, y = EY + 0.3): FaceStroke => ({
  d: `M${x - 1.1} ${y}h2.2`,
  role: 'line',
  blinks: true,
});
/** ∩: eyes closed, smiling. */
const happyLid = (x: number, y = EY + 0.6): FaceStroke => ({
  d: `M${x - 1.6} ${y}q1.6 -2 3.2 0`,
  role: 'line',
  blinks: true,
});
/** ∪: eyes closed, at rest. */
const restLid = (x: number, y = EY - 0.2): FaceStroke => ({
  d: `M${x - 1.6} ${y}q1.6 1.7 3.2 0`,
  role: 'line',
  blinks: true,
});
const smile = (w = 4, y = MY - 0.4, lift = 1.5): FaceStroke => ({
  d: `M${16 - w / 2} ${y}q${w / 2} ${lift} ${w} 0`,
  role: 'line',
});
const flat = (w = 3, y = MY, x = 16): FaceStroke => ({
  d: `M${x - w / 2} ${y}h${w}`,
  role: 'line',
});

export const FACE_SPECS: Record<AvatarFace, FaceStroke[]> = {
  calm: [dot(EL), dot(ER), smile(3.6)],
  cheerful: [happyLid(EL), happyLid(ER), smile(5, MY - 0.6, 2.1)],
  curious: [dot(EL + 0.8, EY - 0.5), dot(ER + 0.8, EY - 0.5), flat(2.2, MY, 17.2)],
  focused: [dash(EL), dash(ER), flat(3)],
  sleepy: [restLid(EL), restLid(ER), flat(2, MY + 0.3)],
  wink: [dot(EL), happyLid(ER), smile(3.6)],
  determined: [bar(EL), bar(ER), flat(4)],
  quiet: [bar(EL, EY + 1), bar(ER, EY + 1)],
  content: [dot(EL, EY + 1), dot(ER, EY + 1)],
  bright: [bar(EL), bar(ER), smile(4.4, MY - 0.5, 1.9)],
};

/**
 * Stroke weights in grid units for an avatar `px` wide. A 16px avatar's
 * strokes are proportionally ~60% heavier than a 96px one's: drawn at one
 * weight, a face is either a smudge small or spindly big.
 */
export function faceWeights(px: number): { eye: number; line: number } {
  if (px <= 20) return { eye: 3.4, line: 2.3 };
  if (px <= 32) return { eye: 3.1, line: 2 };
  if (px <= 56) return { eye: 2.8, line: 1.75 };
  return { eye: 2.4, line: 1.45 };
}

/** The face group's transform for a shape: its optical centre and room. */
export function faceTransform(shape: AvatarShape): string {
  const { dx, dy, scale } = SHAPE_SPECS[shape].face;
  if (dx === 0 && dy === 0 && scale === 1) return '';
  return `translate(${r2(C + dx)} ${r2(C + dy)}) scale(${scale}) translate(${-C} ${-C})`;
}

/**
 * The look's motion, same on both clients: while working, a blink every
 * `BLINK_EVERY_MS` (offset per agent so a sidebar never blinks in unison);
 * when a turn ends, one bob. Nothing while idle; nothing with Reduce Motion.
 */
export const BLINK_EVERY_MS = 4800;
export const BLINK_MS = 160;
export const BOB_MS = 520;
/** How far a bob lifts, as a fraction of the avatar's size. */
export const BOB_LIFT = 0.08;
/** 0–3: which quarter of the blink cycle this agent blinks in. */
export const blinkPhase = (id: string) => hash(id) % 4;
