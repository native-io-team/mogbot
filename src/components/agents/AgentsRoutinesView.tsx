/**
 * Routines: every agent's routines in one list (the sidebar's Routines row,
 * ⌘K "Routines"), for someone running fifteen agents across clients. One
 * row each: whose it is (its key), what it does, how it runs in words, when
 * it runs next, how its last run went, and on/off.
 *
 * "Pause all" and "Resume all" ask first. Resume all wakes only what Pause
 * all paused (`agents/routines_bulk.rs`): never a routine you paused by hand
 * or one an import paused for your review.
 *
 * Every figure is the Mac's (each agent's `checkIns`); nothing is estimated.
 *
 * @module components/agents/AgentsRoutinesView
 */

import { useEffect, useState } from 'react';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Spinner } from '../primitives/Spinner';
import { AgentKey } from './AgentKey';
import { AgentsPageHeader, type AgentsPageCompact } from './AgentsPageHeader';
import { Toggle } from './AgentSettingsRows';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAgentsSelector } from '../../lib/agentsStore';
import { pauseCheckIn, type Agent } from '../../lib/agents';
import { askToChangeRoutine } from '../../lib/routineHandoff';
import {
  pauseAllRoutines,
  ROUTINES_ID,
  pausedLine,
  resumeAllRoutines,
  resumedLine,
  routineCounts,
  routineCountLine,
  routineLine,
  routineRows,
} from '../../lib/agentDesk';

export type BulkAsk = 'pause' | 'resume';

const selectAgents = (s: { agents: Agent[] }) => s.agents;

export function AgentsRoutinesView({
  onOpenAgent,
  ask,
  onAsked,
  compact,
}: {
  onOpenAgent: (agentId: string) => void;
  compact?: AgentsPageCompact;
  /** ⌘K "Pause all routines…" / "Resume all routines…": open on that question. */
  ask?: BulkAsk | null;
  onAsked?: () => void;
}) {
  const agents = useAgentsSelector(selectAgents);
  const { showToast } = useOptionalToast();
  const [confirming, setConfirming] = useState<BulkAsk | null>(ask ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!ask) return;
    setConfirming(ask);
    onAsked?.();
  }, [ask, onAsked]);
  const rows = routineRows(agents);
  const counts = routineCounts(agents);
  const fail = (e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error');

  const bulk = async (which: BulkAsk) => {
    setBusy(which);
    try {
      const n = which === 'pause' ? await pauseAllRoutines() : await resumeAllRoutines();
      showToast(which === 'pause' ? pausedLine(n) : resumedLine(n), 'success');
      setConfirming(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (agentId: string, id: string, on: boolean) => {
    setBusy(`${agentId}:${id}`);
    try {
      await pauseCheckIn(agentId, id, !on);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="agent-chat agents-team agents-routines" aria-label="Routines">
      <AgentsPageHeader
        name="Routines"
        icon="lucide:calendar-clock"
        pageId={ROUTINES_ID}
        compact={compact}
        onOpenAgent={onOpenAgent}
      />
      <div className="agent-chat__scroll" tabIndex={0} role="region" aria-label="Every routine">
        <div className="agents-team__column">
          <div className="agents-routines__bar">
            <p className="agents-routines__count">{routineCountLine(rows)}</p>
            {rows.length > 0 && !confirming && (
              <span className="agents-routines__bulk">
                <Button
                  variant="secondary"
                  onClick={() => setConfirming('resume')}
                  disabled={counts.paused === 0}
                >
                  Resume all…
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConfirming('pause')}
                  disabled={counts.on === 0}
                >
                  Pause all…
                </Button>
              </span>
            )}
          </div>
          {confirming && (
            <div className="agents-routines__confirm" role="alertdialog" aria-label="Confirm">
              <p className="agents-routines__confirm-text">
                {confirming === 'pause'
                  ? `Pause all ${counts.on} running routines? Nothing runs until you resume them.`
                  : 'Resume the routines “Pause all” paused? Ones you paused yourself, or an import paused for your review, stay off.'}
              </p>
              <span className="agents-routines__bulk">
                <Button variant="secondary" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  variant="strong"
                  autoFocus
                  disabled={busy !== null}
                  leftIcon={busy === confirming ? <Spinner size="sm" /> : undefined}
                  onClick={() => void bulk(confirming)}
                >
                  {confirming === 'pause' ? 'Pause all' : 'Resume all'}
                </Button>
              </span>
            </div>
          )}
          {rows.length === 0 ? (
            <p className="agents-team__empty">
              Ask any agent to do something on a schedule (“every weekday at 9, check…”) and it
              shows here.
            </p>
          ) : (
            <ul className="agents-routines__list">
              {rows.map(({ agent, routine }) => {
                const on = !routine.paused;
                return (
                  <li
                    key={`${agent.id}:${routine.id}`}
                    className="agents-routines__row"
                    data-paused={routine.paused || undefined}
                  >
                    <AgentKey id={agent.id} name={agent.name} color={agent.color} size="sm" />
                    <span className="agents-routines__text">
                      <span className="agents-routines__what">
                        <TextButton
                          tabIndex={0}
                          className="agents-routines__agent"
                          onClick={() => onOpenAgent(agent.id)}
                        >
                          {agent.name}
                        </TextButton>
                        <span className="agents-routines__note" title={routine.note}>
                          {routine.note}
                        </span>
                      </span>
                      <span className="agents-routines__when">{routineLine(routine)}</span>
                    </span>
                    {/* Its own editor, in its agent's chat: the same one as there. */}
                    <TextButton
                      tabIndex={0}
                      className="agents-routines__change"
                      aria-label={`Change ${agent.name}’s routine: ${routine.note}`}
                      onClick={() => {
                        askToChangeRoutine(agent.id, routine.id);
                        onOpenAgent(agent.id);
                      }}
                    >
                      Change
                    </TextButton>
                    <Toggle
                      on={on}
                      label={`${on ? 'Pause' : 'Resume'} ${agent.name}’s routine: ${routine.note}`}
                      onChange={(value) => void toggle(agent.id, routine.id, value)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
