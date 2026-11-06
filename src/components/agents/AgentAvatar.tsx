/**
 * An agent's avatar: one soft shape in a tone of its colour, with a minimal
 * face in an ink of the same hue (docs/internal/avatars.md). Drawn from the
 * spec the phone draws from (`packages/companion-protocol/src/avatar.ts`),
 * so the geometry, the stroke weights per size and the motion are one thing.
 *
 * The one SVG here is the design system's marked dynamic exception
 * (`data-dynamic-svg="agent-avatar"`): it's assembled from data at runtime,
 * not static artwork, which is what `src/assets/graphics/` holds.
 *
 * Motion is small and only means something: while it works, a blink now and
 * then (never a ring around it: the owner ruled that out; the row's live
 * step text says the rest); when a turn ends, one bob. Nothing at rest;
 * nothing at all with Reduce Motion.
 *
 * @module components/agents/AgentAvatar
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  BOB_MS,
  FACE_SPECS,
  SHAPE_SPECS,
  blinkPhase,
  faceTransform,
  faceWeights,
  lookFor,
  type AgentLook,
} from '../../../packages/companion-protocol/src/avatar';
import { getAgentsSnapshot, subscribeAgents } from '../../lib/agentsStore';

/**
 * "Chief of Staff" → "CS", "Finance" → "FI", "Acme Site" → "AS". A number
 * keeps its digits ("Agent 3" → "A3", "Agent 12" → "12"), so a numbered run
 * of agents doesn't collapse onto one badge. (Rooms still use initials.)
 */
export function agentInitials(name: string): string {
  // Only letters and digits make initials: "Finance (from Grok)" is
  // "Finance", never "F(". A trailing aside in brackets is dropped.
  const words = name
    .replace(/\s*[([{].*$/u, '')
    .trim()
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(
      (w) => /[A-Za-z0-9]/.test(w) && !['of', 'the', 'and', 'for', '&'].includes(w.toLowerCase())
    );
  const number = words.length >= 2 ? words[words.length - 1] : '';
  if (/^\d+$/.test(number)) {
    return number.length >= 2 ? number.slice(-2) : (words[0][0] + number).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name.trim();
  return word.slice(0, 2).toUpperCase();
}

/** The first letter and the next consonant: "Client Sites QA" → "CL". */
function consonantInitials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const next = letters.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? letters[1] ?? '';
  return (letters[0] + next).toUpperCase();
}

/**
 * Initials that don't collide with an agent listed before this one
 * (`names`, in creation order, the Chief first): "Chief of Staff" keeps "CS"
 * and "Client Sites QA" becomes "CL". A name not in the list (one being
 * typed) gives way to all of them.
 */
export function distinctInitials(name: string, names: string[]): string {
  const own = agentInitials(name);
  const index = names.indexOf(name);
  const before = index === -1 ? names : names.slice(0, index);
  return before.some((n) => n !== name && agentInitials(n) === own) ? consonantInitials(name) : own;
}

/**
 * Every agent's saved look, as one string, so a streaming reply (which
 * updates the store every few frames) never re-renders an avatar.
 */
const teamLooks = () =>
  getAgentsSnapshot()
    .agents.map(
      (a) => `${a.id}\t${a.isMain ? 1 : 0}\t${a.avatar?.shape ?? ''}\t${a.avatar?.face ?? ''}`
    )
    .join('\n');

function lookFromTeam(team: string, id: string): AgentLook | null {
  for (const line of team.split('\n')) {
    const [lineId, main, shape, face] = line.split('\t');
    if (lineId !== id) continue;
    return lookFor({
      id,
      isMain: main === '1',
      avatar: { shape: shape as AgentLook['shape'], face: face as AgentLook['face'] },
    });
  }
  return null;
}

/** Each size step's width, for the stroke weights (the CSS owns the box). */
const SIZE_PX = { xs: 16, mini: 18, row: 24, field: 24, md: 40, hero: 46, xl: 96 } as const;
export type AgentAvatarSize = keyof typeof SIZE_PX;

interface AgentAvatarProps {
  /** Seeds the look of an agent that isn't in the registry (an import preview). */
  name: string;
  color: string;
  /** Its id: the look comes from the registry, or is derived from the id. */
  id?: string;
  /** An explicit look (the picker's preview, a proposed change). */
  look?: AgentLook;
  /**
   * `xs` sits in a line of text (16px), `mini` leads a menu item or a
   * mention (18px), `row` is the sidebar's
   * (a project badge's size, 24px), `field` sits beside a text field, `hero`
   * heads an empty chat (`md` is 40px), `xl` is the picker's preview (96px).
   */
  size?: AgentAvatarSize;
  /** Solid, for the agent you're looking at (like the current project's badge). */
  selected?: boolean;
  /** Mid-turn: blinks now and then (no ring around it). */
  working?: boolean;
  className?: string;
}

export function AgentAvatar({
  name,
  color,
  id,
  look: given,
  size = 'row',
  selected = false,
  working = false,
  className,
}: AgentAvatarProps) {
  const team = useSyncExternalStore(subscribeAgents, teamLooks);
  const look = useMemo(
    () => given ?? (id ? lookFromTeam(team, id) : null) ?? lookFor({ id: id ?? `name:${name}` }),
    [given, id, team, name]
  );
  const bob = useBobOnFinish(working);
  const shape = SHAPE_SPECS[look.shape];
  const weights = faceWeights(SIZE_PX[size]);
  const strokes = FACE_SPECS[look.face];
  const width = (role: 'eye' | 'line') => (role === 'eye' ? weights.eye : weights.line);
  const blinks = (s: (typeof strokes)[number]) => s.role === 'eye' || Boolean(s.blinks);
  return (
    <span
      className={`agent-avatar agent-avatar--${size}${selected ? ' agent-avatar--selected' : ''}${
        working ? ' agent-avatar--working' : ''
      }${bob ? ' agent-avatar--bob' : ''}${className ? ` ${className}` : ''}`}
      data-color={color}
      data-shape={look.shape}
      data-face={look.face}
      data-blink={blinkPhase(id ?? name)}
      aria-hidden
    >
      <svg
        data-dynamic-svg="agent-avatar"
        className="agent-avatar__art"
        viewBox="0 0 32 32"
        focusable="false"
      >
        <path className="agent-avatar__shape" d={shape.d} />
        <g className="agent-avatar__face" transform={faceTransform(look.shape) || undefined}>
          <g className="agent-avatar__eyes">
            {strokes.filter(blinks).map((s) => (
              <path key={s.d} d={s.d} strokeWidth={width(s.role)} />
            ))}
          </g>
          {strokes
            .filter((s) => !blinks(s))
            .map((s) => (
              <path key={s.d} d={s.d} strokeWidth={width(s.role)} />
            ))}
        </g>
      </svg>
    </span>
  );
}

/**
 * True for one bob after `working` goes from true to false: the reply landed.
 * Noticed while rendering (the previous value kept in state), cleared by a
 * timer once the bob has played.
 */
function useBobOnFinish(working: boolean): boolean {
  const [was, setWas] = useState(working);
  const [bob, setBob] = useState(false);
  if (was !== working) {
    setWas(working);
    if (was && !working) setBob(true);
  }
  useEffect(() => {
    if (!bob) return;
    const t = window.setTimeout(() => setBob(false), BOB_MS);
    return () => window.clearTimeout(t);
  }, [bob]);
  return bob;
}
