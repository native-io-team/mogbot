/**
 * One routine's model, in its editor (persona review 2026-11-09, the
 * Saver): an hourly check can wake on a lighter model than the agent's other
 * routines. "Like its other routines" is the agent's routine model
 * (`routineModelOf`); the rest are its engine's own. Applies at once
 * (`agents_schedule_model`), as the Chief's `set_routine_model` does.
 */

import { CheckIcon, ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import {
  modelChoices,
  modelLabel,
  routineModelOf,
  setRoutineModel,
  type Agent,
  type CheckIn,
} from '../../lib/agents';
import { refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

/** The choices for one routine: like its others, its agent's own, or a model. */
export function routineOwnChoices(
  agent: Pick<Agent, 'engine' | 'model' | 'routineModel'>,
  choices: readonly { value: string; label: string; detail?: string }[]
): { value: string; label: string; detail: string | null }[] {
  const others = modelLabel(routineModelOf(agent), choices);
  return [
    { value: '', label: 'Like its other routines', detail: others },
    { value: 'same', label: 'Same as its chats', detail: modelLabel(agent.model, choices) },
    ...choices
      .filter((m) => m.value)
      .map((m) => ({ value: m.value, label: m.label, detail: m.detail ?? null })),
  ];
}

export function AgentRoutineModel({ agent, routine }: { agent: Agent; routine: CheckIn }) {
  const { showToast } = useOptionalToast();
  const engines = useAgentsSelector((s) => s.engines);
  const choices = modelChoices(agent.engine, engines);
  const options = routineOwnChoices(agent, choices);
  const current = routine.model ?? '';
  const shown = options.find((o) => o.value === current) ?? options[0];
  const pick = async (model: string) => {
    if (model === current) return;
    try {
      await setRoutineModel(agent.id, routine.id, model);
      await refreshAgents();
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };
  return (
    <div className="agent-schedule__model">
      {/* "Model", not "Runs on": that's the agent's engine and account, elsewhere. */}
      <span className="agent-schedule__model-label">Model</span>
      <Dropdown
        align="left"
        portal
        menuClassName="agent-model-menu"
        trigger={(p) => (
          <MenuButton
            {...p}
            tabIndex={0}
            expanded={p['aria-expanded']}
            variant="secondary"
            size="compact"
            aria-label={`Model for this routine: ${shown.label}`}
          >
            {shown.value === '' ? `${shown.label} (${shown.detail})` : shown.label}
            <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
          </MenuButton>
        )}
      >
        {options.map((o) => (
          <DropdownItem key={o.value || 'default'} onSelect={() => void pick(o.value)}>
            <span className="agent-model-menu__label">
              {o.label}
              {o.detail && <span className="agent-model-menu__detail">{o.detail}</span>}
            </span>
            <span className="agent-model-menu__check" aria-hidden="true">
              {o.value === current && <CheckIcon size={12} />}
            </span>
          </DropdownItem>
        ))}
      </Dropdown>
    </div>
  );
}
