/**
 * The team as a board of keys (docs/internal/agent-keys.md): every agent you
 * have, at full size on a plate, in the state it's in, with its name and a
 * line under it: the state's word in its colour (Live green, Working in
 * ink, as on the site; Needs your OK in the status pill the sidebar, the In
 * flight rows and the waiting bar use), then what it's on. Pressing one
 * opens its chat, as its bound key does from anywhere; the empty socket at
 * the end makes a new agent. An agent that joins while the board is up drops
 * into its socket (`seat`).
 *
 * @module components/agents/AgentsBoard
 */

import { useState } from 'react';
import { StatusPill } from '../primitives/StatusPill';
import { Tooltip } from '../primitives/Tooltip';
import {
  KEY_STATE_LABEL,
  keyAccessibleName,
  keyLookFor,
  type KeyState,
} from '../../../packages/companion-protocol/src/agentKeys';
import { previewText } from '../../../packages/companion-protocol/src/preview';
import { workingRowLine } from '../../../packages/companion-protocol/src/work';
import {
  agentKeyState,
  failedTurn,
  failurePill,
  plainActivity,
  type Agent,
} from '../../lib/agents';
import { AgentKey } from './AgentKey';

interface AgentsBoardProps {
  agents: Agent[];
  onOpenAgent: (agentId: string) => void;
  /** The empty socket: make a new agent. Absent, no socket. */
  onNewAgent?: () => void;
  /**
   * `quiet`: the rest of the team under What's in flight's attention
   * sections. Smaller keys, the name and its bound letter only; the line
   * (state and what it last said) shows on hover or focus, never as a wall
   * of cut-short previews.
   */
  variant?: 'full' | 'quiet';
  /** Its name for a screen reader (the section's heading says it on screen). */
  label?: string;
}

/** The quiet key's hover/focus line: the state's word, then what it's on or last said. */
export function boardLine(agent: Agent, state: KeyState): string {
  const word = state === 'idle' ? null : KEY_STATE_LABEL[state];
  const detail = boardDetail(agent, state);
  if (!word) return detail ?? agent.name;
  if (!detail) return word;
  if (detail.startsWith(`${word} `)) return detail;
  if (detail.startsWith('until ')) return `${word} ${detail}`;
  return `${word} · ${detail}`;
}

/** The quiet board's line comes quickly: it is the only place the preview is. */
const QUIET_TOOLTIP_MS = 300;

/** The words after the state: what it's on, or (idle) its last line. */
export function boardDetail(agent: Agent, state: KeyState): string | null {
  switch (state) {
    case 'working':
      return workingRowLine(
        plainActivity(agent.status.activity),
        agent.status.work,
        agent.status.since,
        Date.now()
      ).text;
    case 'live':
      return 'You’re driving it';
    case 'idle':
      return previewText(agent.preview);
    case 'paused': {
      // When it's back, as its sidebar row says it ("until 3:42 AM"): a
      // paused key with no time left you guessing whether to wait.
      const failure = failedTurn(agent);
      const rest = failure?.kind === 'usage_limit' ? failurePill(failure, null).rest : '';
      return rest || null;
    }
    default:
      return null;
  }
}

/**
 * The agents that joined while the board was up (they drop into their
 * socket). Nothing seats on the first render, so opening the board is still.
 * State adjusted during render, React's pattern for deriving from the last
 * props.
 */
function useSeated(ids: string[]): ReadonlySet<string> {
  const key = ids.join(' ');
  const [seen, setSeen] = useState<{ key: string; seated: ReadonlySet<string> }>({
    key,
    seated: new Set(),
  });
  if (seen.key !== key) {
    const before = new Set(seen.key.split(' '));
    const seated = new Set(seen.seated);
    for (const id of ids) if (!before.has(id)) seated.add(id);
    setSeen({ key, seated });
    return seated;
  }
  return seen.seated;
}

export function AgentsBoard({
  agents,
  onOpenAgent,
  onNewAgent,
  variant = 'full',
  label = 'Your team',
}: AgentsBoardProps) {
  const shown = agents.filter((a) => !a.hidden);
  const seated = useSeated(shown.map((a) => a.id));
  if (variant === 'quiet') {
    return (
      <div className="agents-board agents-board--quiet" role="group" aria-label={label}>
        <div className="agents-board__plate">
          {shown.map((agent) => {
            const state = agentKeyState(agent);
            const line = boardLine(agent, state);
            const bound = keyLookFor(agent).boundKey;
            // A state is news (paused until 5:02, you're driving it): said
            // under the name. What it last said is the hover's.
            const news = state === 'paused' || state === 'live' ? boardLine(agent, state) : null;
            return (
              <Tooltip key={agent.id} content={line} delayMs={QUIET_TOOLTIP_MS}>
                <button
                  type="button"
                  className="agents-board__key"
                  data-board-nav=""
                  data-grid=""
                  onClick={() => onOpenAgent(agent.id)}
                  aria-label={line === agent.name ? agent.name : `${agent.name}. ${line}`}
                  aria-keyshortcuts={bound ?? undefined}
                  data-agent-id={agent.id}
                  data-state={state}
                >
                  <span className="agents-board__cap">
                    <AgentKey
                      id={agent.id}
                      name={agent.name}
                      color={agent.color}
                      state={state}
                      size="md"
                      seat={seated.has(agent.id)}
                    />
                  </span>
                  {/* A row's anatomy: the key, then its name with what's news under it. */}
                  <span className="agents-board__label">
                    <span className="agents-board__name">{agent.name}</span>
                    {news && <span className="agents-board__news">{news}</span>}
                  </span>
                  {/* Its bound key, at the row's end: the small key's face has no room for it. */}
                  {bound && (
                    <kbd className="agents-board__bound" aria-hidden="true">
                      {bound}
                    </kbd>
                  )}
                </button>
              </Tooltip>
            );
          })}
          {onNewAgent && (
            <button
              type="button"
              className="agents-board__key"
              data-board-nav=""
              data-grid=""
              onClick={() => onNewAgent()}
              aria-label="New agent"
            >
              <AgentKey name="New agent" state="new" size="md" />
              <span className="agents-board__label">
                <span className="agents-board__name">New agent</span>
              </span>
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <section className="agents-board" aria-label={label}>
      <div className="agents-board__plate">
        {shown.map((agent) => {
          const state = agentKeyState(agent);
          // Idle says no word, only what it last said (the site's board).
          const word = state === 'idle' ? null : KEY_STATE_LABEL[state];
          let detail = boardDetail(agent, state);
          // "Working · Working on the pricing" says it twice: the word leads
          // the line instead ("Working on the pricing").
          // "Paused until 3:42 AM" runs on too: the time finishes the word.
          const runOn = Boolean(
            word && (detail?.startsWith(`${word} `) || detail?.startsWith('until '))
          );
          if (runOn && detail?.startsWith(`${word} `)) detail = detail.slice(word!.length);
          else if (runOn && detail) detail = ` ${detail}`;
          return (
            <button
              key={agent.id}
              type="button"
              className="agents-board__key"
              onClick={() => onOpenAgent(agent.id)}
              aria-label={keyAccessibleName(agent.name, state)}
              data-agent-id={agent.id}
            >
              <AgentKey
                id={agent.id}
                name={agent.name}
                color={agent.color}
                state={state}
                size="xl"
                seat={seated.has(agent.id)}
              />
              <span className="agents-board__name">{agent.name}</span>
              <span className="agents-board__state" data-state={state}>
                {word && state === 'needsOk' ? (
                  <StatusPill tone="waiting" className="agents-board__pill">
                    {word}
                  </StatusPill>
                ) : (
                  word && <b className="agents-board__word">{word}</b>
                )}
                {word && detail && !runOn && state !== 'needsOk' && (
                  <span className="agents-board__sep"> · </span>
                )}
                {detail && <span className="agents-board__detail">{detail}</span>}
              </span>
            </button>
          );
        })}
        {onNewAgent && (
          <button
            type="button"
            className="agents-board__key"
            onClick={() => onNewAgent()}
            aria-label="New agent"
          >
            <AgentKey name="New agent" state="new" size="xl" />
            {/* Just its name: "Empty socket" was the design's word, not the user's. */}
            <span className="agents-board__name">New agent</span>
          </button>
        )}
      </div>
    </section>
  );
}
