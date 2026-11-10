/**
 * An agent's key (docs/internal/agent-keys.md): a keycap in its colourway
 * with one legend on its face, the keyboard key it's bound to as a small
 * sublegend, and its independence as pips on the front edge. Pure CSS shapes
 * (agent-key.css, the approved reference's geometry); the legend is the one
 * SVG here, the design system's marked dynamic exception
 * (`data-dynamic-svg="agent-key"`), drawn from the icon registry shared with
 * the phone (`packages/companion-protocol/src/agentKeyIcons.ts`).
 *
 * Cheap by design: no timers and no per-key JS. A state is a data attribute;
 * the only animation is the slow pulse of "Needs your OK", in CSS, off with
 * Reduce Motion.
 *
 * @module components/agents/AgentKey
 */

import { useMemo, useSyncExternalStore } from 'react';
import {
  KEY_ICON_GRID,
  KEY_PIP_COUNT,
  colorwayOf,
  iconDrawing,
  keyLookFor,
  pipsFor,
  type AgentKeyLook,
  type KeyState,
} from '../../../packages/companion-protocol/src/agentKeys';
import type { AgentIndependence } from '../../../packages/companion-protocol/src/model';
import { getAgentsSnapshot, subscribeAgents } from '../../lib/agentsStore';

/** `xl` the picker's preview and the board (112px), `lg` a header (44), `md` a list row (30), `sm` a menu item or mention (20), `xs` a line of text (16). */
export type AgentKeySize = 'xl' | 'lg' | 'md' | 'sm' | 'xs';

/** Sizes that show the sublegend and pips. */
const BIG: ReadonlySet<AgentKeySize> = new Set(['xl']);

/**
 * Every agent's key and independence as one string, so a streaming reply
 * (which updates the store every few frames) never re-renders a key.
 */
const teamKeys = () => {
  const s = getAgentsSnapshot();
  return (
    `${s.independence ?? ''}\n` +
    s.agents
      .map((a) => {
        const k = keyLookFor(a);
        return `${a.id}\t${k.colorway}\t${k.icon}\t${k.boundKey ?? ''}\t${a.independence ?? ''}`;
      })
      .join('\n')
  );
};

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
  const socket = state === 'paused';
  const pips = pipsFor(look.level);
  const drawing = iconDrawing(look.icon);
  return (
    <span
      className={`agent-key agent-key--${size}${className ? ` ${className}` : ''}`}
      data-colorway={way.id}
      data-icon={look.icon}
      data-light={way.light || undefined}
      data-state={state}
      aria-hidden
    >
      {state === 'new' ? (
        // Not a socket: an outline where a key will go, with a plus. It's an
        // action, so it must never read as a paused agent's empty socket.
        <span className="agent-key__plus" />
      ) : socket ? (
        <span className="agent-key__housing">
          <span className="agent-key__stem" />
        </span>
      ) : (
        <>
          <span className="agent-key__face">
            <svg
              data-dynamic-svg="agent-key"
              className="agent-key__legend"
              viewBox={`0 0 ${KEY_ICON_GRID} ${KEY_ICON_GRID}`}
              focusable="false"
            >
              {drawing.paths.map((d) => (
                <path key={d} d={d} />
              ))}
              {drawing.circles?.map(([cx, cy, r]) => (
                <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} />
              ))}
            </svg>
            {big && look.boundKey && <span className="agent-key__sub">{look.boundKey}</span>}
          </span>
          {big && pips > 0 && (
            <span className="agent-key__pips">
              {Array.from({ length: KEY_PIP_COUNT }, (_, i) => (
                <i key={i} className="agent-key__pip" data-on={i < pips || undefined} />
              ))}
            </span>
          )}
        </>
      )}
    </span>
  );
}
