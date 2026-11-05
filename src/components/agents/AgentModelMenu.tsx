/**
 * The model an agent runs on, inside the conversation header's … menu (the
 * header itself says who the agent is and what it's doing, not which engine
 * it runs on). Each choice is said by what it's for — "Most capable",
 * "Balanced", "Fastest" — with the engine's own name for it in small text;
 * the change applies from its next turn. The engine is named once, in the
 * heading. Below, when the agent has a routine, what its routines run on: on
 * Claude Code, automatically the fastest while the agent is on the default
 * model, since a routine mostly checks and fires again and again; on Codex,
 * its own model unless the user picks another of Codex's.
 *
 * @module components/agents/AgentModelMenu
 */

import { CheckIcon } from '@/components/icons';
import { DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import {
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

export function AgentModelItems({ agent }: { agent: Agent }) {
  const { showToast } = useOptionalToast();
  const engines = useAgentsSelector((s) => s.engines);
  const choices = modelChoices(agent.engine, engines);
  const current = agent.model ?? '';
  const engineName =
    engines.find((e) => e.id === agent.engine)?.label ?? ENGINE_LABEL[agent.engine];
  const routine = agent.routineModel ?? '';
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
