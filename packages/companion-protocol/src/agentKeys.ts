/**
 * Agent keys: every agent is a keycap (docs/internal/agent-keys.md). A
 * colourway, a legend (an icon) and the keyboard key it's bound to, shown in
 * one of six physical states, with its independence as pips on the front
 * edge. The one spec the desk's `AgentKey` and the phone draw from, so the
 * same agent is the same key everywhere.
 *
 * The data (colourways, icon ids, the old colours' nearest colourway, the
 * name heuristics and the key alphabet) is `agent-keys.json`, which the Mac
 * reads too (`agents::keys`), so a migration on the Mac and a fallback here
 * land on the same key. The drawings are `agentKeyIcons.ts`.
 *
 * The registry stores ids (`colorway`, `icon`, `boundKey`), never colours.
 * An agent from a Mac that doesn't send them yet is drawn from what it has:
 * its old colour's nearest colourway, an icon read from its name and role.
 */

import data from './agent-keys.json';
import { KEY_ICON_DRAWINGS, type KeyIconDrawing } from './agentKeyIcons';
import { isPackIconId, packDrawing, packIconName } from './agentKeyPack';
import type { AgentIndependence } from './model';

export { KEY_ICON_DRAWINGS, KEY_ICON_GRID, type KeyIconDrawing } from './agentKeyIcons';
export {
  PACK_INFO,
  PACK_PREFIX,
  isPackIconId,
  loadAllPackDrawings,
  loadPackIndex,
  packDrawingsVersion,
  packIconName,
  subscribePackDrawings,
} from './agentKeyPack';

export interface Colorway {
  id: string;
  /** What the picker calls it. */
  name: string;
  /** The top face, the skirt round it and the hard depth shadow: three shades of one hue. */
  face: string;
  skirt: string;
  depth: string;
  /** The legend's ink: at least 4.5:1 on the face. */
  legend: string;
  /** A pale face: lit, it darkens more so the lit legend reads (`LIVE_DARKEN`). */
  light: boolean;
  /** The old avatar colour key nearest it, written beside it for older clients. */
  legacy: string;
}

export const COLORWAYS: readonly Colorway[] = data.colorways;
export const COLORWAY_IDS: readonly string[] = COLORWAYS.map((c) => c.id);
export type ColorwayId = string;

/** The featured legends, in picker order; `aka` are other names a search finds one by. */
export const KEY_ICONS: readonly { id: string; name: string; aka?: string[] }[] = data.icons;
export const KEY_ICON_IDS: readonly string[] = KEY_ICONS.map((i) => i.id);

/**
 * The Chief's legend (the app's mark) and colourway (Graphite, the app
 * icon's), and the legend an agent gets when nothing in its name says otherwise.
 */
export const CHIEF_ICON: string = data.chiefIcon;
export const CHIEF_COLORWAY: string = data.chiefColorway;
export const DEFAULT_ICON: string = data.defaultIcon;

/** Every key an agent can be bound to: letters, then digits. No modifiers. */
export const KEY_CHARS: string = data.keyChars;

/** The old avatar colours, each to its nearest colourway. */
export const LEGACY_COLORWAYS: Readonly<Record<string, string>> = data.legacyColors;

/** Words in a name or role, each rule in order: the first that matches picks the icon. */
export const ICON_RULES: readonly { icon: string; words: string[] }[] = data.iconRules;

/** The six states a key shows (docs/internal/agent-keys.md, "States"). */
export const KEY_STATES = ['idle', 'working', 'live', 'needsOk', 'paused', 'new'] as const;
export type KeyState = (typeof KEY_STATES)[number];

/** The words beside a key, where there's room. */
export const KEY_STATE_LABEL: Record<KeyState, string> = {
  idle: 'Idle',
  working: 'Working',
  live: 'Live',
  needsOk: 'Needs your OK',
  paused: 'Paused',
  new: 'New agent',
};

/**
 * What a screen reader calls a key: its agent's name, then its state when the
 * state is news ("Finance, needs your OK"). Idle says nothing more; a key with
 * no agent yet is "New agent". Desk and phone both, so the two never disagree.
 */
export function keyAccessibleName(
  name: string | null | undefined,
  state?: KeyState | null
): string {
  const who = name?.trim();
  if (!who) return KEY_STATE_LABEL.new;
  if (!state || state === 'idle') return who;
  const said = KEY_STATE_LABEL[state];
  return `${who}, ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
}

/** Pips lit on the front edge for each independence level: Careful 1 … Unleashed 4. */
export const KEY_PIPS: Record<AgentIndependence, number> = data.pips as Record<
  AgentIndependence,
  number
>;
export const KEY_PIP_COUNT = 4;

export const isColorway = (v: unknown): v is string =>
  typeof v === 'string' && COLORWAY_IDS.includes(v);
/** A featured legend, or a pack id (`lucide:wallet`; which exist is the Mac's to say). */
export const isKeyIcon = (v: unknown): v is string =>
  (typeof v === 'string' && KEY_ICON_IDS.includes(v)) || isPackIconId(v);

export function colorwayOf(id: string | null | undefined): Colorway {
  return COLORWAYS.find((c) => c.id === id) ?? COLORWAYS[0];
}

export function iconDrawing(id: string | null | undefined): KeyIconDrawing {
  return legendDrawing(id) ?? KEY_ICON_DRAWINGS[DEFAULT_ICON];
}

/**
 * What a key prints: a featured legend, a pack icon once its drawings file
 * has arrived (`null` until then, which starts loading it; a client re-draws
 * on `subscribePackDrawings`), else the default legend.
 */
export function legendDrawing(id: string | null | undefined): KeyIconDrawing | null {
  const own = KEY_ICON_DRAWINGS[id ?? ''];
  if (own) return own;
  if (isPackIconId(id)) {
    const d = packDrawing(id);
    if (d === undefined) return null;
    if (d) return d;
  }
  return KEY_ICON_DRAWINGS[DEFAULT_ICON];
}

export const iconName = (id: string) =>
  KEY_ICONS.find((i) => i.id === id)?.name ?? (isPackIconId(id) ? packIconName(id) : id);
export const colorwayName = (id: string) => COLORWAYS.find((c) => c.id === id)?.name ?? id;

/** The nearest colourway to an old avatar colour key (blue for one it doesn't know). */
export function colorwayForColor(color: string | null | undefined): string {
  const key = (color ?? '').trim().toLowerCase();
  if (isColorway(key)) return key;
  return Object.prototype.hasOwnProperty.call(LEGACY_COLORWAYS, key)
    ? LEGACY_COLORWAYS[key]
    : COLORWAYS[0].id;
}

/** The old colour key written beside a colourway, so a client that only knows colours stays close. */
export const legacyColorFor = (colorway: string) => colorwayOf(colorway).legacy;

/** The lower-case words of a name or role: "Security & DevOps" → security, devops. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * An icon read from what the agent is called and what it's for: the name
 * first, then the role, each against the rules in order. The Chief's is the
 * app's mark. Matches `agents::keys::icon_for` exactly (agentKeys.test.ts and
 * keys_tests.rs hold the same table).
 */
export function iconFor(name: string, role = '', isMain = false): string {
  if (isMain) return CHIEF_ICON;
  for (const text of [name, role]) {
    const ws = words(text);
    for (const rule of ICON_RULES) {
      if (ws.some((w) => rule.words.includes(w))) return rule.icon;
    }
  }
  return DEFAULT_ICON;
}

/** One typed key as a bound key: a letter or digit, upper-case; anything else is none. */
export function normalizeBoundKey(key: string | null | undefined): string | null {
  const k = (key ?? '').trim().toUpperCase();
  return k.length === 1 && KEY_CHARS.includes(k) ? k : null;
}

/**
 * The first key free for an agent called `name`: its letters in order (the
 * first letter first), then every other key. `null` only when all 36 are
 * taken.
 */
export function boundKeyFor(name: string, taken: Iterable<string>): string | null {
  const used = new Set([...taken].map((k) => k.toUpperCase()));
  const own = [...name.toUpperCase()].filter((c) => KEY_CHARS.includes(c));
  for (const c of [...own, ...KEY_CHARS]) if (!used.has(c)) return c;
  return null;
}

/** The colourway nobody (or fewest) on the team wears yet, in palette order. */
export function freshColorway(worn: Iterable<string>): string {
  const counts = new Map(COLORWAY_IDS.map((id) => [id, 0]));
  for (const w of worn) if (counts.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  let best = COLORWAY_IDS[0];
  for (const id of COLORWAY_IDS) if ((counts.get(id) ?? 0) < (counts.get(best) ?? 0)) best = id;
  return best;
}

/**
 * A colourway for a key with `icon` that no one on the team wears with that
 * icon (`keys::distinct_colorway`): `preferred` when it's free, else the
 * fewest-worn free one; `preferred` when every colourway is taken.
 */
export function distinctColorway(
  preferred: string,
  icon: string,
  team: readonly (readonly [colorway: string, icon: string])[]
): string {
  const clash = (c: string) => team.some(([w, i]) => w === c && i === icon);
  if (!clash(preferred)) return preferred;
  const free = COLORWAY_IDS.filter((id) => !clash(id));
  if (free.length === 0) return preferred;
  const worn = (id: string) => team.filter(([w]) => w === id).length;
  return free.reduce((best, id) => (worn(id) < worn(best) ? id : best), free[0]);
}

/** What an agent is drawn as. */
export interface AgentKeyLook {
  colorway: string;
  icon: string;
  /** Absent when the Mac didn't send one (an older Mac). */
  boundKey: string | null;
}

/**
 * An agent's key: what it chose, else what an older Mac's fields say (its
 * colour's nearest colourway, an icon from its name and role).
 */
export function keyLookFor(agent: {
  name: string;
  role?: string;
  color?: string | null;
  isMain?: boolean;
  colorway?: string | null;
  icon?: string | null;
  boundKey?: string | null;
}): AgentKeyLook {
  return {
    colorway: isColorway(agent.colorway) ? agent.colorway : colorwayForColor(agent.color),
    icon: isKeyIcon(agent.icon)
      ? agent.icon
      : iconFor(agent.name, agent.role ?? '', Boolean(agent.isMain)),
    boundKey: normalizeBoundKey(agent.boundKey),
  };
}

/**
 * The state a key shows. Needs your OK outranks everything (a turn waiting
 * on a card is also working); a paused agent shows its socket; working is
 * pressed; live (you're driving its session) is lit.
 */
export function keyStateOf(s: {
  needsOk?: boolean;
  paused?: boolean;
  working?: boolean;
  live?: boolean;
}): KeyState {
  if (s.needsOk) return 'needsOk';
  if (s.paused) return 'paused';
  if (s.working) return 'working';
  if (s.live) return 'live';
  return 'idle';
}

export const pipsFor = (level: AgentIndependence | null | undefined): number =>
  level ? (KEY_PIPS[level] ?? 0) : 0;

/**
 * Geometry at 112px (the reference size), in px; every size scales it by
 * `size / 112`, except the small key (`KEY_SMALL`), which is its own.
 */
export const KEY_GEOMETRY = {
  size: 112,
  radius: 16,
  face: { left: 10, right: 10, top: 5, bottom: 17, radius: 11 },
  depth: 8,
  icon: 40,
  stroke: 2,
  /** The bound key, clear of the face's rounded corner: as far from the right as the bottom, optically. */
  sublegend: { right: 9, bottom: 8, size: 11 },
  pips: { bottom: 6, width: 8, height: 3.5, gap: 4 },
  /** Pressed all the way: the depth left under it (the site's working key). */
  working: { floor: 1.5, breatheMs: 2400 },
  /** Lit (working, live): the legend's warm white. */
  live: { legend: '#FFE9B4' },
  /** The loudest state: proud, the legend amber-gold, pulsing; never below `pulseLow`. */
  needsOk: { up: 5, depth: 13, pulseMs: 1600, pulseLow: 0.6, legend: '#FFC94A', deeper: 0.14 },
  /** Paused: the cap drained of colour, faded, sunk halfway. */
  paused: { saturate: 0.12, legendOpacity: 0.55 },
} as const;

/**
 * How far a lit face deepens toward its own depth shade (the site's
 * `--lit-mix`): more on a pale face so the lit legend reads.
 */
export const KEY_LIT_MIX: Readonly<Record<string, number>> = {
  blue: 0.42,
  orange: 0.3,
  putty: 0.62,
  teal: 0.48,
  graphite: 0.3,
  mustard: 0.48,
  pink: 0.58,
  sage: 0.48,
  brick: 0.3,
  plum: 0.3,
  navy: 0.3,
  forest: 0.3,
  sky: 0.55,
  lilac: 0.58,
};

/** At or below this size a key drops its sublegend and pips and thickens its legend. */
export const KEY_SMALL_MAX = 36;
/** At or above this size a key shows its pips. */
export const KEY_PIPS_MIN = 64;
