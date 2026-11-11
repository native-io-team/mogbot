/**
 * An agent's key (docs/design/agent-keys.md): a keycap in its colourway
 * with one legend on its face, the keyboard key it's bound to as a small
 * sublegend, and its independence as pips on the front edge. Pure CSS shapes
 * (agent-key.css, the approved reference's geometry); the legend is the one
 * SVG here, the design system's marked dynamic exception
 * (`data-dynamic-svg="agent-key"`), drawn from the icon registry shared with
 * the phone (`packages/companion-protocol/src/agentKeyIcons.ts`).
 *
 * Cheap by design: no timers and no per-key JS. A state is a data attribute
 * and the motion is CSS (the site's keys): a working key breathes, a key that
 * needs your OK pulses, a new socket fades in, a key just seated drops in
 * (`seat`); all still with Reduce Motion or in a hidden window. A key inside
 * something clickable lifts on hover and goes down on press; `data-hit` (set
 * by the bound-key shortcut, `pressAgentKeys`) presses it for a beat.
 *
 * @module components/agents/AgentKey
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { watchOffscreen } from '../../lib/offscreen';
import {
  KEY_ICON_GRID,
  KEY_PIP_COUNT,
  colorwayOf,
  keyLookFor,
  legendDrawing,
  packDrawingsVersion,
  pipsFor,
  subscribePackDrawings,
  type AgentKeyLook,
  type KeyState,
} from '../../../packages/companion-protocol/src/agentKeys';
import type { AgentIndependence } from '../../../packages/companion-protocol/src/model';
import { getAgentsSnapshot, subscribeAgents } from '../../lib/agentsStore';

/** `xl` the picker's preview and the board (112px), `lg` a header (44), `md` a list row (30), `sm` a menu item or mention (20), `xs` a line of text (16). */
export type AgentKeySize = 'xl' | 'lg' | 'md' | 'sm' | 'xs';

/** Sizes that show the sublegend and pips. */
const BIG: ReadonlySet<AgentKeySize> = new Set(['xl']);
/** The small drawing (a list key and under): agent-key.css's md, sm and xs. */
const SMALL: ReadonlySet<AgentKeySize> = new Set(['md', 'sm', 'xs']);

/**
 * Every agent's key and independence as one string, so a streaming reply
 * (which updates the store every few frames) never re-renders a key.
 */
const teamKeys = () => {
  const s = getAgentsSnapshot();
  // Every key on screen asks on every store change (a streamed word is one):
  // worked out again only when the agents or the team's level changed.
  if (s.agents === teamCache.agents && s.independence === teamCache.independence) {
    return teamCache.keys;
  }
  const keys =
    `${s.independence ?? ''}\n` +
    s.agents
      .map((a) => {
        const k = keyLookFor(a);
        return `${a.id}\t${k.colorway}\t${k.icon}\t${k.boundKey ?? ''}\t${a.independence ?? ''}`;
      })
      .join('\n');
  teamCache = { agents: s.agents, independence: s.independence, keys };
  return keys;
};
let teamCache: {
  agents: unknown;
  independence: unknown;
  keys: string;
} = { agents: null, independence: undefined, keys: '' };

function keyFromTeam(
  team: string,
  id: string
): (AgentKeyLook & { level: AgentIndependence | null }) | null {
  const [teamLevel, ...lines] = team.split('\n');
  for (const line of lines) {
    const [lineId, colorway, icon, boundKey, level] = line.split('\t');
    if (lineId !== id) continue;
    return {
      colorway,
      icon,
      boundKey: boundKey || null,
      level: ((level || teamLevel) as AgentIndependence) || null,
    };
  }
  return null;
}

export interface AgentKeyProps {
  /** Its id: what isn't given comes from the registry. */
  id?: string;
  /** Seeds a key for an agent that isn't in the registry (an import preview, the editor's draft). */
  name?: string;
  role?: string;
  /** An old avatar colour key: its nearest colourway, when none is given. */
  color?: string;
  colorway?: string;
  icon?: string;
  /** The sublegend (big keys only); `null` shows none. */
  boundKey?: string | null;
  size?: AgentKeySize;
  state?: KeyState;
  /** Its independence, for the pips (big keys only); defaults to the registry's. */
  level?: AgentIndependence | null;
  /** Just seated (a new agent on the board): the cap drops into its socket once. */
  seat?: boolean;
  className?: string;
}

export function AgentKey({
  id,
  name = '',
  role,
  color,
  colorway,
  icon,
  boundKey,
  size = 'md',
  state = 'idle',
  level,
  seat,
  className,
}: AgentKeyProps) {
  const team = useSyncExternalStore(subscribeAgents, teamKeys);
  const look = useMemo(() => {
    const saved = id ? keyFromTeam(team, id) : null;
    const fallback = keyLookFor({ name, role, color });
    return {
      colorway: colorway ?? saved?.colorway ?? fallback.colorway,
      icon: icon ?? saved?.icon ?? fallback.icon,
      boundKey: boundKey !== undefined ? boundKey : (saved?.boundKey ?? null),
      level: level !== undefined ? level : (saved?.level ?? null),
    };
  }, [team, id, name, role, color, colorway, icon, boundKey, level]);
  const way = colorwayOf(look.colorway);
  const big = BIG.has(size);
  const socket = state === 'new';
  const pips = pipsFor(look.level);
  // A pack icon's drawing arrives with its file (agentKeyPack.ts): until
  // then the face is blank, and the version bump re-draws it.
  useSyncExternalStore(subscribePackDrawings, packDrawingsVersion);
  const drawing = legendDrawing(look.icon);
  // A key that breathes or pulses holds still while it is scrolled out of
  // sight (a working agent far down the sidebar): its loops cost a frame each.
  const ref = useRef<HTMLSpanElement>(null);
  const loops = state === 'working' || state === 'needsOk';
  useEffect(() => {
    const el = ref.current;
    if (!loops || !el) return;
    const unwatch = watchOffscreen(el);
    return () => {
      unwatch();
      el.removeAttribute('data-offscreen');
    };
  }, [loops]);
  return (
    <span
      ref={ref}
      className={`agent-key agent-key--${size}${className ? ` ${className}` : ''}`}
      data-colorway={way.id}
      data-icon={look.icon}
      data-light={way.light || undefined}
      data-state={state}
      data-agent-id={id}
      data-seat={seat || undefined}
      aria-hidden
    >
      {socket ? (
        <span className="agent-key__socket">
          <span className="agent-key__stem" />
        </span>
      ) : (
        <span className="agent-key__cap">
          <span className="agent-key__face">
            {/* Working: the glow breathes as two lit copies of the legend
                under it, fading into each other (agent-key.css, "Working"). */}
            {state === 'working' && (
              <>
                {legend(drawing, 'low')}
                {legend(drawing, 'high')}
              </>
            )}
            {/* Needs your OK at list size: a dark keyline under the legend
                that parts the amber from the face (agent-key.css). */}
            {state === 'needsOk' && SMALL.has(size) && legend(drawing, 'keyline')}
            {legend(drawing)}
            {big && look.boundKey && <span className="agent-key__sub">{look.boundKey}</span>}
          </span>
          {big && pips > 0 && (
            <span className="agent-key__pips">
              {Array.from({ length: KEY_PIP_COUNT }, (_, i) => (
                <i key={i} className="agent-key__pip" data-on={i < pips || undefined} />
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The icon on the face; with `under`, a copy drawn under it: one of a working
 * key's lit copies (`low`, `high`), or a small Needs-your-OK key's keyline.
 */
function legend(drawing: ReturnType<typeof legendDrawing>, under?: 'low' | 'high' | 'keyline') {
  const extra = under === 'keyline' ? ' agent-key__keyline' : under ? ' agent-key__glow' : '';
  return (
    <svg
      data-dynamic-svg="agent-key"
      className={`agent-key__legend${extra}`}
      data-glow={under === 'keyline' ? undefined : under}
      data-round={drawing?.round || undefined}
      data-fill={drawing?.fill || undefined}
      viewBox={`0 0 ${KEY_ICON_GRID} ${KEY_ICON_GRID}`}
      focusable="false"
    >
      {drawing?.paths.map((d, i) => (
        <path key={`${i}:${d}`} d={d} fillRule={drawing.fill ? 'evenodd' : undefined} />
      ))}
      {drawing?.circles?.map(([cx, cy, r], i) => (
        <circle key={`${i}:${cx},${cy}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}
