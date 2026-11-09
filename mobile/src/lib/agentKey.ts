/**
 * An agent key's geometry on the phone (components/AgentKey.tsx), the desk's
 * numbers (`KEY_GEOMETRY` in the shared spec; agent-key.css): every length
 * a multiple of one unit, the key's size over 112, except the small key
 * (36pt and under), which is its own drawing on a 30pt unit: face, skirt, a
 * 3pt depth, a heavier legend, no sublegend or pips. Pure, so a test can
 * hold it to the desk's.
 */

import {
  KEY_GEOMETRY as G,
  KEY_PIPS_MIN,
  KEY_SMALL_MAX,
  type KeyState,
} from '@shipstudio/companion-protocol';

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
  icon: number;
  /** The legend's stroke, on the 24-unit grid. */
  stroke: number;
  ambientY: number;
  ambientBlur: number;
  /** The sublegend and the pips, big keys only. */
  details: boolean;
  sub: { right: number; bottom: number; size: number };
  pips: { bottom: number; width: number; height: number; gap: number; corner: number };
  /** The socket a removed cap leaves: the housing and the switch stem's cross. */
  housing: number;
  housingCorner: number;
  stem: number;
  arm: number;
  stemDrop: number;
}

export function keyGeometry(size: number): KeyGeometry {
  const u = size / G.size;
  const v = size / 30;
  const small = size <= KEY_SMALL_MAX;
  const big = {
    sub: {
      right: G.sublegend.right * u,
      bottom: G.sublegend.bottom * u,
      size: G.sublegend.size * u,
    },
    pips: {
      bottom: G.pips.bottom * u,
      width: G.pips.width * u,
      height: G.pips.height * u,
      gap: G.pips.gap * u,
      corner: (G.pips.height / 2) * u,
    },
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
      icon: 15 * v,
      // The desk's md is 2.6; its sm and xs, 2.9.
      stroke: size >= 30 ? 2.6 : 2.9,
      ambientY: 1 * v,
      ambientBlur: 6 * v,
      details: false,
      ...big,
      housing: 16 * v,
      housingCorner: 3.5 * v,
      stem: 10 * v,
      arm: 3 * v,
      stemDrop: 1,
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
    icon: G.icon * u,
    // A header's key strokes a little heavier, as the desk's lg does.
    stroke: size < KEY_PIPS_MIN ? 2.3 : G.stroke,
    ambientY: 6 * u,
    ambientBlur: 16 * u,
    details: size >= KEY_PIPS_MIN,
    ...big,
    housing: 48 * u,
    housingCorner: 9 * u,
    stem: 26 * u,
    arm: 8 * u,
    stemDrop: 2 * u,
  };
}

/**
 * Where a state puts the cap: how far down (negative is up, proud) and how
 * deep its shadow, and how dark a wash on its face. Down plus depth is
 * always the rest depth, so a key never moves what's beside it.
 */
export function keyPose(
  g: KeyGeometry,
  state: KeyState,
  light: boolean
): { down: number; depth: number; shade: number; lit: boolean } {
  const u = g.size / G.size;
  const v = g.size / 30;
  const litShade = light ? G.live.darkenLight : G.live.darken;
  switch (state) {
    case 'working':
      return g.small
        ? { down: 2 * v, depth: 1 * v, shade: G.working.darken, lit: false }
        : {
            down: G.working.down * u,
            depth: G.working.depth * u,
            shade: G.working.darken,
            lit: false,
          };
    case 'live':
      return { down: 0, depth: g.rest, shade: litShade, lit: true };
    case 'needsOk':
      return g.small
        ? { down: -2 * v, depth: 5 * v, shade: litShade, lit: true }
        : { down: -G.needsOk.up * u, depth: G.needsOk.depth * u, shade: litShade, lit: true };
    default:
      return { down: 0, depth: g.rest, shade: 0, lit: false };
  }
}

/** The pulse of a key that needs your OK: one breath of the lit legend, the desk's period. */
export const KEY_PULSE_MS = G.needsOk.pulseMs;
/** How far the lit legend fades at the bottom of a breath. */
export const KEY_PULSE_LOW = 0.6;
