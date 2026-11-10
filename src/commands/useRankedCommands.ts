import { useMemo, useSyncExternalStore } from 'react';
import { getSnapshot, subscribe } from './registry';
import { scoreMatch } from './score';
import { frecencyBoost } from './frecency';
import { matchesContext, type Command, type PaletteCtx } from './types';

export interface RankedCommand extends Command {
  _score: number;
  /** How often and how lately it was run from the palette; 0 if never. */
  _frecency: number;
}

export interface RankedResult {
  /** Ordinary results, best first. */
  ranked: RankedCommand[];
  /** Commands offered only when nothing matches (`Command.fallback`). */
  fallbacks: Command[];
}

/**
 * Pulls all commands currently in the registry, gates by context, applies
 * fuzzy score + frecency weighting, and returns them ranked.
 *
 * Empty query ⇒ frecency-only order. Non-empty query ⇒ score * (1 + small
 * frecency bonus) so frecency tilts ties without dominating a good match.
 */
export function useRankedCommands(ctx: PaletteCtx, query: string): RankedResult {
  const all = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => rankCommands(all, ctx, query), [all, ctx, query]);
}

/** The ranking itself, pure, so it can be tested and timed without React. */
export function rankCommands(all: Command[], ctx: PaletteCtx, query: string): RankedResult {
  const q = query.trim();
  const ranked: RankedCommand[] = [];
  const fallbacks: Command[] = [];
  for (const cmd of all) {
    if (!matchesContext(cmd.when, ctx)) continue;
    if (cmd.fallback) {
      fallbacks.push(cmd);
      continue;
    }
    const matchScore = scoreMatch(q, cmd.title, cmd.keywords);
    if (matchScore === 0) continue;
    const frec = frecencyBoost(cmd.id);
    // Empty query: pure frecency order. Non-empty: score dominates;
    // frecency is a soft tiebreaker.
    const composite = q ? matchScore * (1 + frec * 0.1) : frec;
    ranked.push({ ...cmd, _score: composite, _frecency: frec });
  }
  // Sort purely by score — no alpha tiebreaker, so equal-score commands
  // preserve the insertion order their factory chose (pinned-first,
  // last-opened-desc, etc.). JS Array.prototype.sort is stable.
  ranked.sort((a, b) => b._score - a._score);
  return { ranked, fallbacks };
}
