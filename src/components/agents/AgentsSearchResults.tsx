/**
 * Search results across every agent's conversation, shown in the sidebar in
 * place of the agent list while there's a query. Grouped by agent, newest
 * first; clicking a hit opens that chat and flashes the line.
 *
 * Agents whose name matches come first, as one row each: with twenty agents,
 * typing part of a name is how you get to one, and the conversations it
 * finds (every line that mentions "store") are a different question.
 *
 * @module components/agents/AgentsSearchResults
 */

import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  formatHitTime,
  groupHits,
  highlightRuns,
  hitSpeaker,
  searchAgents,
  snippetAround,
  type SearchHit,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { AgentAvatar } from './AgentAvatar';
import { useAgentsSelector } from '../../lib/agentsStore';
import type { Agent } from '../../lib/agents';

/** Wait this long after the last keystroke before scanning. */
const DEBOUNCE_MS = 140;

interface Results {
  query: string;
  hits: SearchHit[];
  error: string | null;
}

/** Hits for `query`, debounced; `null` until the first answer for it arrives. */
function useSearch(query: string): Results | null {
  const [results, setResults] = useState<Results | null>(null);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      searchAgents(query)
        .then((hits) => live && setResults({ query, hits, error: null }))
        .catch(
          (err) =>
            live && setResults({ query, hits: [], error: formatCommandError(asCommandError(err)) })
        );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  return results;
}

/** Up/Down moves between hits; Up from the first goes back to the field. */
export function moveHitFocus(
  e: KeyboardEvent<HTMLElement>,
  field: RefObject<HTMLInputElement | null>
) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  // The sidebar's field and its results live in different parts of the
  // sidebar; there is only ever one result list on screen.
  const hits = Array.from(document.querySelectorAll<HTMLElement>('.agents-search__hit'));
  if (hits.length === 0) return;
  e.preventDefault();
  const index = hits.indexOf(document.activeElement as HTMLElement);
  const next = index + (e.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) field.current?.focus();
  else hits[Math.min(next, hits.length - 1)].focus();
}

interface AgentsSearchResultsProps {
  query: string;
  field: RefObject<HTMLInputElement | null>;
  onOpen: (hit: SearchHit) => void;
  /** The hit last opened: marked like the current row, so ↓ and Enter walk on from it. */
  currentId?: string | null;
  /** Opens an agent whose name matched; without it, name matches aren't listed. */
  onOpenAgent?: (agentId: string) => void;
}

/** Agents whose name holds every word of the query, in the list's own order. */
export function nameMatches(agents: Agent[], query: string): Agent[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return agents.filter((a) => {
    const name = a.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

export function AgentsSearchResults({
  query,
  field,
  onOpen,
  currentId,
  onOpenAgent,
}: AgentsSearchResultsProps) {
  const trimmed = query.trim();
  const results = useSearch(trimmed);
  const allAgents = useAgentsSelector((s) => s.agents);
  const named = onOpenAgent ? nameMatches(allAgents, trimmed).filter((a) => !a.hidden) : [];
  const names =
    named.length > 0 ? (
      <div className="agents-search__group" role="listitem" aria-label="Agents">
        {named.map((agent) => (
          <button
            key={agent.id}
            type="button"
            tabIndex={0}
            className="agents-search__hit agents-search__name-hit"
            onClick={() => onOpenAgent?.(agent.id)}
          >
            <AgentAvatar id={agent.id} name={agent.name} color={agent.color} />
            <span className="agents-search__agent-name">
              {highlightRuns(agent.name, trimmed).map((run, i) =>
                run.match ? <mark key={i}>{run.text}</mark> : run.text
              )}
            </span>
          </button>
        ))}
      </div>
    ) : null;
  // Keep showing the last answer while the next one is on its way.
  if (!results) return names && <div className="agents-search">{names}</div>;
  if (results.error) return <p className="agents-search__note">{results.error}</p>;
  if (results.hits.length === 0 && !names) {
    return results.query === trimmed ? (
      <p className="agents-search__note">Nothing matches “{trimmed}”.</p>
    ) : null;
  }
  return (
    <div
      className="agents-search"
      role="list"
      aria-label="Search results"
      aria-busy={results.query !== trimmed || undefined}
      onKeyDown={(e) => moveHitFocus(e, field)}
    >
      {names}
      {groupHits(results.hits).map(({ agentId, hits }) => (
        <div key={agentId} className="agents-search__group" role="listitem">
          <div className="agents-search__agent">
            <AgentAvatar id={agentId} name={hits[0].agentName} color={hits[0].agentColor} />
            <span className="agents-search__agent-name">{hits[0].agentName}</span>
          </div>
          {hits.map((hit) => {
            const speaker = hitSpeaker(hit);
            return (
              <button
                key={hit.messageId}
                type="button"
                tabIndex={0}
                className={`agents-search__hit${hit.messageId === currentId ? ' is-current' : ''}`}
                aria-current={hit.messageId === currentId || undefined}
                onClick={() => onOpen(hit)}
              >
                <span className="agents-search__snippet">
                  {speaker && <span className="agents-search__speaker">{speaker}: </span>}
                  {highlightRuns(snippetAround(hit.snippet, results.query), results.query).map(
                    (run, i) => (run.match ? <mark key={i}>{run.text}</mark> : run.text)
                  )}
                </span>
                <span className="agents-search__time">{formatHitTime(hit.ts)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
