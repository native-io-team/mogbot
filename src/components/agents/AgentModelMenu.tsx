/**
 * The model an agent runs on, inside the conversation header's … menu (the
 * header itself says who the agent is and what it's doing, not which engine
 * it runs on). Each choice is said by what it's for — "Most capable",
 * "Balanced", "Fastest" — with the engine's own name for it in small text;
 * the change applies from its next turn. The engine is named once, in the
 * heading. Below, when the agent has a routine, what its routines run on: on
 * Claude Code, automatically the fastest while the agent is on the default
 * model, since a routine mostly checks and fires again and again; on Codex,
 * its own model unless the user picks another of Codex's. Between them, how
 * hard it thinks (effort), from its next message too.
 *
 * @module components/agents/AgentModelMenu
 */

import { CheckIcon } from '@/components/icons';
import { DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import {
  EFFORT_CHOICES,
  ENGINE_LABEL,
  modelChoices,
  modelLabel,
  routineModelChoices,
  routineModelOf,
  updateAgent,
  type Agent,
  type UpdateAgentInput,
} from '../../lib/agents';
import { refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { accountsOf } from '../../lib/agentAccounts';
import { useUsageAccounts } from './useUsageAccounts';

/**
 * "Runs on": any account (the default: the team's order, carrying on with
 * the next when one runs out), or one account only. Shown once its engine
 * has more than one; from its next message.
 */
export function AgentAccountItems({
  agent,
  save,
}: {
  agent: Agent;
  save: (change: UpdateAgentInput) => Promise<void>;
}) {
  const { accounts } = useUsageAccounts();
  const mine = accountsOf(accounts ?? [], agent.engine);
  if (mine.length < 2) return null;
  const current = agent.account ?? '';
  const choices = [
    { value: '', label: 'Any account', detail: 'Carries on when one runs out' },
    ...mine.map((a) => ({
      value: a.id,
      label: a.name,
      detail: a.signedIn ? (a.out ? 'Out of usage now' : undefined) : 'Not signed in',
    })),
  ];
  const named = choices.find((c) => c.value === current)?.label ?? 'Any account';
  return (
    <>
      <DropdownDivider />
      <p className="agent-model-menu__heading">Runs on · {named}</p>
      {choices.map((c) => (
        <DropdownItem
          key={c.value || 'any'}
          onSelect={() => c.value !== current && void save({ account: c.value })}
        >
          <span className="agent-model-menu__label">
            {c.label}
            {c.detail && <span className="agent-model-menu__detail">{c.detail}</span>}
          </span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {c.value === current && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
      ))}
    </>
  );
}

export function AgentModelItems({ agent }: { agent: Agent }) {
  const { showToast } = useOptionalToast();
  const engines = useAgentsSelector((s) => s.engines);
  const choices = modelChoices(agent.engine, engines);
  const current = agent.model ?? '';
  const engineName =
    engines.find((e) => e.id === agent.engine)?.label ?? ENGINE_LABEL[agent.engine];
  const routine = agent.routineModel ?? '';
  const effort = agent.effort ?? '';
  const hasRoutine = (agent.checkIns ?? []).some((c) => c.repeat);
  const save = async (change: UpdateAgentInput) => {
    try {
      await updateAgent(agent.id, change);
      await refreshAgents();
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };
  return (
    <>
      <DropdownDivider />
      <p className="agent-model-menu__heading">Model · runs on {engineName}</p>
      {choices.map((m) => (
        <DropdownItem
          key={m.value}
          onSelect={() => m.value !== current && void save({ model: m.value })}
        >
          <span className="agent-model-menu__label">
            {m.label}
            {m.detail && <span className="agent-model-menu__detail">{m.detail}</span>}
          </span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {m.value === current && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
      ))}
      <DropdownDivider />
      <p className="agent-model-menu__heading">Effort · how hard it thinks</p>
      {EFFORT_CHOICES.map((e) => (
        <DropdownItem
          key={e.value || 'default'}
          onSelect={() => e.value !== effort && void save({ effort: e.value })}
        >
          <span className="agent-model-menu__label">{e.label}</span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {e.value === effort && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
      ))}
      <AgentAccountItems agent={agent} save={save} />
      {hasRoutine && (
        <>
          <DropdownDivider />
          <p className="agent-model-menu__heading">
            Routines run on {modelLabel(routineModelOf(agent), choices)}
          </p>
          {routineModelChoices(agent.engine, choices).map((m) => (
            <DropdownItem
              key={m.value}
              onSelect={() => m.value !== routine && void save({ routineModel: m.value })}
            >
              <span className="agent-model-menu__label" title={m.hint ?? undefined}>
                {m.label}
                {m.detail && <span className="agent-model-menu__detail">{m.detail}</span>}
              </span>
              <span className="agent-model-menu__check" aria-hidden="true">
                {m.value === routine && <CheckIcon size={12} />}
              </span>
            </DropdownItem>
          ))}
        </>
      )}
    </>
  );
}
