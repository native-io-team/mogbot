/**
 * The model an agent runs on, in the conversation header's own Model menu
 * (settings, kept out of the … menu, which holds actions only). Each choice is said by what it's for — "Most capable",
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

import { CheckIcon, ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
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
import { accountLabel } from '../../../packages/companion-protocol/src/accountSwitcher';
import {
  RUNS_ON_ANY,
  RUNS_ON_ANY_DETAIL,
  runsOnDetail,
} from '../../../packages/companion-protocol/src/cardWords';

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
    // Worded once with the phone's Runs on (`cardWords`).
    { value: '', label: RUNS_ON_ANY, detail: RUNS_ON_ANY_DETAIL },
    ...mine.map((a) => ({
      value: a.id,
      label: accountLabel(a),
      detail: runsOnDetail(a),
    })),
  ];
  const named = choices.find((c) => c.value === current)?.label ?? RUNS_ON_ANY;
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
          {/* The heading names the section the way the two above do; what
              Automatic or Same comes to sits beside it, as the engine's
              names sit beside the models ("Automatic  Fastest"), so the
              heading never names one choice while another is ticked. */}
          <p className="agent-model-menu__heading">Routines · the model they wake on</p>
          {routineModelChoices(agent.engine, choices).map((m) => {
            const resolved =
              m.value === '' || m.value === 'same'
                ? modelLabel(routineModelOf({ ...agent, routineModel: m.value }), choices)
                : null;
            const detail = m.detail ?? resolved;
            return (
              <DropdownItem
                key={m.value}
                onSelect={() => m.value !== routine && void save({ routineModel: m.value })}
              >
                <span className="agent-model-menu__label" title={m.hint ?? undefined}>
                  {m.label}
                  {detail && <span className="agent-model-menu__detail">{detail}</span>}
                </span>
                <span className="agent-model-menu__check" aria-hidden="true">
                  {m.value === routine && <CheckIcon size={12} />}
                </span>
              </DropdownItem>
            );
          })}
        </>
      )}
    </>
  );
}

/**
 * "Model ⌄" in the conversation header: the model, effort, account and what
 * routines run on, as one menu of its own. A word, not an icon, so it says
 * what it is; the current choice is in its tooltip and checked inside.
 */
export function AgentModelMenu({ agent }: { agent: Agent }) {
  const engines = useAgentsSelector((s) => s.engines);
  const current = modelLabel(agent.model ?? '', modelChoices(agent.engine, engines));
  return (
    <Dropdown
      align="right"
      portal
      menuClassName="agent-model-menu"
      className="agent-chat__model"
      // Nothing looks chosen until you choose: the check marks what's current.
      quietOpen
      trigger={(p) => (
        <MenuButton
          {...p}
          tabIndex={0}
          expanded={p['aria-expanded']}
          variant="ghost"
          size="compact"
          title={`Model: ${current}`}
          aria-label={`Model for ${agent.name}: ${current}`}
        >
          Model
          <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
        </MenuButton>
      )}
    >
      <AgentModelItems agent={agent} />
    </Dropdown>
  );
}
