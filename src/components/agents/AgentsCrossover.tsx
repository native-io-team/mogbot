/**
 * Settings → Accounts & usage, "When every Claude Code account is out" (and
 * the mirror for Codex): Ask first (the default), Carry on with the other
 * engine, or Wait for the refill (`agents/crossover.rs`). Shown only when
 * both engines are installed and each has an account signed in, since
 * otherwise there is nothing to carry on with (round 4: "When every Codex
 * account is out" was offered with no Codex account). While agents are carrying on elsewhere, one Line says so: "Claude
 * Code out · on Codex until 4:00 PM".
 *
 * @module components/agents/AgentsCrossover
 */

import { useEffect } from 'react';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import type { AgentEngine } from '../../lib/agents';
import { getCrossover, onUsagePlanChanged, setCrossover } from '../../lib/agentsUsage';
import {
  awayLine,
  awayStateOf,
  crossoverDetail,
  crossoverHeading,
  crossoverOptions,
  type CrossoverMode,
  type CrossoverView,
} from '../../../packages/companion-protocol/src/crossover';

export function AgentsCrossover({
  installed,
  signedIn,
  now,
}: {
  installed: AgentEngine[];
  /** Engines with at least one account signed in. */
  signedIn: AgentEngine[];
  now: number;
}) {
  const { showToast } = useOptionalToast();
  const state = useAsyncState<CrossoverView>(getCrossover, { immediate: true });
  const { execute, setData } = state;
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void onUsagePlanChanged(() => void execute().catch(() => undefined))
      .then((fn) => (gone ? fn() : (off = fn)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [execute]);
  const view = state.data;
  const both = (list: AgentEngine[]) => list.includes('claude') && list.includes('codex');
  if (!view || !both(installed) || !both(signedIn)) return null;
  const choose = async (engine: AgentEngine, mode: CrossoverMode) => {
    try {
      setData(await setCrossover(engine, mode));
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    }
  };
  return (
    <>
      {(['claude', 'codex'] as const).map((engine) => {
        // Who is carrying on elsewhere, as the Mac said with the choice.
        const away = awayStateOf(
          engine,
          view.away.map((a) => ({
            engine: a.home,
            away: { engine: a.on, since: 0, until: a.until },
          })),
          now
        );
        return (
          <div className="agents-usage__block" key={engine} data-crossover={engine}>
            <span className="agents-usage__heading">{crossoverHeading(engine)}</span>
            <SegmentedControl
              aria-label={crossoverHeading(engine)}
              value={view[engine]}
              size="default"
              options={crossoverOptions(engine)}
              onValueChange={(m) => void choose(engine, m)}
            />
            <span className="agents-usage__muted">{crossoverDetail(engine, view[engine])}</span>
            {away && (
              <span className="agents-usage__state" role="status" data-tone="warning">
                {awayLine(away, now)}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
