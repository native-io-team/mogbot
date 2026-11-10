/**
 * An agent key's geometry and light on the phone (components/AgentKey.tsx),
 * the desk's numbers (`KEY_GEOMETRY` in the shared spec; agent-key.css, the
 * site's keys): every length a multiple of one unit, the key's size over 112,
 * except the small key (36pt and under), which is its own drawing on a 30pt
 * unit: face, skirt, a 3pt depth, a heavier legend, no sublegend or pips.
 * Pure, so a test can hold it to the desk's.
 */

import {
  KEY_GEOMETRY as G,
  KEY_LIT_MIX,
  KEY_PIPS_MIN,
  KEY_SMALL_MAX,
  type KeyState,
} from '@shipstudio/companion-protocol';
import { keyLit, mix, saturate, type KeyColors } from './theme';

export interface KeyGeometry {
  size: number;
  small: boolean;
  /** The skirt's corner and the face's place and corner on it. */
  corner: number;
  insetX: number;
  insetTop: number;
  insetBottom: number;
  faceCorner: number;
  /** The depth under a key at rest: the box is the key plus this. */
  rest: number;
  /** The depth left under a key pressed all the way. */
  floor: number;
  icon: number;
  /** The legend's stroke, on the 24-unit grid. */
  stroke: number;
  ambientY: number;
  ambientBlur: number;
  /** The sublegend and the pips, big keys only. */
  details: boolean;
  sub: { right: number; bottom: number; size: number };
  pips: { bottom: number; width: number; height: number; gap: number; corner: number };
  /** The empty socket: its inset, corner, and the switch stem's cross. */
  socketInset: number;
  socketCorner: number;
  stem: number;
  arm: number;
  stemDrop: number;
}

export function keyGeometry(size: number): KeyGeometry {
  const u = size / G.size;
  const v = size / 30;
  const small = size <= KEY_SMALL_MAX;
  const shared = {
    sub: {
      right: G.sublegend.right * u,
      bottom: G.sublegend.bottom * u,
      size: G.sublegend.size * u,
    },
    pips: {
      bottom: G.pips.bottom * u,
      width: G.pips.width * u,
      height: Math.max(3, G.pips.height * u),
      gap: G.pips.gap * u,
      corner: (G.pips.height / 2) * u,
    },
    socketInset: Math.max(1, 3 * u),
    socketCorner: G.radius * u - 1,
    stem: size * 0.27,
    arm: size * 0.27 * 0.32,
    stemDrop: Math.max(1, 3 * u),
  };
  if (small) {
    return {
      size,
      small,
      corner: G.radius * u,
      insetX: 3 * v,
      insetTop: 1.5 * v,
      insetBottom: 5 * v,
      faceCorner: 4 * v,
      rest: 3 * v,
      floor: Math.max(1, 0.6 * v),
      icon: 15 * v,
      // The desk's md is 2.6; its sm and xs, 2.9.
      stroke: size >= 30 ? 2.6 : 2.9,
      ambientY: 1 * v,
      ambientBlur: 5 * v,
      details: false,
      ...shared,
    };
  }
  return {
    size,
    small,
    corner: G.radius * u,
    insetX: G.face.left * u,
    insetTop: G.face.top * u,
    insetBottom: G.face.bottom * u,
    faceCorner: G.face.radius * u,
    rest: G.depth * u,
    floor: Math.max(1, G.working.floor * u),
    icon: G.icon * u,
    // A header's key strokes a little heavier, as the desk's lg does.
    stroke: size < KEY_PIPS_MIN ? 2.3 : G.stroke,
    ambientY: 6 * u,
    ambientBlur: 13 * u,
    details: size >= KEY_PIPS_MIN,
    ...shared,
  };
}

/** How a state lights the legend: not at all, the warm white (working, live) or the amber of Needs your OK. */
export type KeyLight = 'none' | 'warm' | 'ask';

/**
 * Where a state puts the cap: how far down (negative is up, proud) and how
 * deep its shadow, and how it's lit. Down plus depth is always the rest
 * depth, so a key never moves what's beside it. `pressed`: a finger on it
 * (the row it's in is held), all the way down.
 */
export function keyPose(
  g: KeyGeometry,
  state: KeyState,
  pressed = false
): { down: number; depth: number; light: KeyLight } {
  const u = g.size / G.size;
  const v = g.size / 30;
  const light: KeyLight =
    state === 'needsOk' ? 'ask' : state === 'working' || state === 'live' ? 'warm' : 'none';
  const all = { down: g.rest - g.floor, depth: g.floor };
  if (pressed && state !== 'new') return { ...all, light };
  switch (state) {
    case 'working':
      return { ...all, light };
    case 'needsOk': {
      const up = g.small ? 2 * v : G.needsOk.up * u;
      return { down: -up, depth: g.rest + up, light };
    }
    case 'paused':
      return { down: g.rest / 2, depth: g.rest / 2, light };
    default:
      return { down: 0, depth: g.rest, light };
  }
}

/** A key's colours in a state: its face (deepened in its own hue when lit), skirt, depth and legend. */
export function keyPaint(
  colorway: string,
  paint: KeyColors,
  state: KeyState
): KeyColors & { legendLit: boolean } {
  if (state === 'paused') {
    const keep = G.paused.saturate;
    return {
      face: saturate(paint.face, keep),
      skirt: saturate(paint.skirt, keep),
      depth: saturate(paint.depth, keep),
      legend: saturate(paint.legend, keep),
      legendLit: false,
    };
  }
  const deepen = KEY_LIT_MIX[colorway] ?? 0.42;
  if (state === 'working' || state === 'live') {
    return {
      ...paint,
      face: mix(paint.depth, paint.face, deepen),
      legend: keyLit.legend,
      legendLit: true,
    };
  }
  if (state === 'needsOk') {
    return {
      ...paint,
      face: mix(paint.depth, paint.face, Math.min(1, deepen + G.needsOk.deeper)),
      legend: keyLit.ask,
      legendLit: true,
    };
  }
  return { ...paint, legendLit: false };
}

/** The pulse of a key that needs your OK, and how low it fades: the desk's. */
export const KEY_PULSE_MS = G.needsOk.pulseMs;
export const KEY_PULSE_LOW = G.needsOk.pulseLow;
/** The slow breath of a working key's light. */
export const KEY_BREATHE_MS = G.working.breatheMs;
export const KEY_BREATHE_LOW = 0.5;
