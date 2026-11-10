/**
 * Settings → Agents → What agents run on: what a new agent starts on when
 * nobody picked, a real setting (`agents_set_defaults`, saved in the app's
 * settings; `agents::defaults`).
 *
 * - **New agents start on**: Claude Code or Codex, only engines `agents::engine`
 *   runs; one that isn't installed and signed in can't be chosen. A choice
 *   that stops being ready (signed out) isn't lost: the control shows where
 *   new agents start meanwhile, as the backend decides it (`startsOn`), and
 *   the line says why; picking that engine makes it the choice. The phone
 *   shows the same.
 * - **A model per installed engine**: "Engine's default" plus only the models
 *   that engine reports (Claude Code's aliases, Codex's own list). An engine
 *   that lists none offers nothing to pick, and says so.
 *
 * Existing agents keep their own engine and model; each is changed in Edit
 * agent. The chat's New agent, the Chief's `create_agent` and the phone all
 * read the same setting.
 *
 * @module components/agents/AgentDefaultsSettings
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { useAgentsSelector, refreshAgents } from '../../lib/agentsStore';
import {
  ENGINE_LABEL,
  MODEL_CHANGE_KEY,
  engineUnavailable,
  modelChoices,
  newAgentModel,
  setNewAgentDefaults,
  startsOnFallback,
  type AgentEngine,
  type EngineInfo,
  type NewAgentDefaultsChange,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { takeSettingsSectionRequest } from '../../lib/settings';

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-description">{description}</span>
      </div>
      {children}
    </div>
  );
}

const engineState = (e: EngineInfo) => {
  const missing = engineUnavailable(e);
  return missing === 'install'
    ? 'not installed'
    : missing === 'sign-in'
      ? 'not signed in'
      : 'ready';
};

const selectEngines = (s: { engines: EngineInfo[] }) => s.engines;

function ModelRow({
  engine,
  engines,
  value,
  onChange,
}: {
  engine: AgentEngine;
  engines: EngineInfo[];
  value: string;
  onChange: (model: string) => void;
}) {
  const choices = modelChoices(engine, engines);
  const name = ENGINE_LABEL[engine];
  // Only "Engine's default": nothing reported, so nothing to pick.
  if (choices.length < 2) {
    return (
      <Row
        label={`Model on ${name}`}
        description={`${name} hasn’t listed its models, so new agents use its default.`}
      />
    );
  }
  const current = choices.find((m) => m.value === value) ?? choices[0];
  return (
    <Row
      label={`Model on ${name}`}
      description={`For new agents on ${name}. Each agent can pick its own in Edit agent.`}
    >
      <Dropdown
        align="right"
        menuClassName="agent-defaults-menu"
        trigger={(props) => (
          <MenuButton
            variant="secondary"
            className="agent-defaults-trigger"
            aria-label={`Model on ${name}: ${current.label}`}
            data-engine={engine}
            expanded={props['aria-expanded']}
            {...props}
          >
            <span className="agent-defaults-trigger__label">{current.label}</span>
            {current.detail && (
              <span className="agent-defaults-trigger__detail">{current.detail}</span>
            )}
            <ChevronIcon
              size={10}
              className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
            />
          </MenuButton>
        )}
      >
        {choices.map((m) => {
          const on = m.value === current.value;
          return (
            <DropdownItem
              key={m.value || 'default'}
              active={on}
              icon={
                // The current one is ticked; the rest keep its place so labels line up.
                <span className="agent-defaults-menu__check" aria-hidden="true">
                  {on && <CheckIcon size={14} />}
                </span>
              }
              onSelect={() => onChange(m.value)}
            >
              <span className="agent-defaults-menu__label">{m.label}</span>
              {m.detail && <span className="agent-defaults-menu__detail">{m.detail}</span>}
            </DropdownItem>
          );
        })}
      </Dropdown>
    </Row>
  );
}

export function AgentDefaultsSettings() {
  const engines = useAgentsSelector(selectEngines);
  const defaults = useAgentsSelector((s) => s.defaults);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ready = engines.length > 0 && defaults !== null;
  // ⌘K "What new agents run on, and their model…": shown, not left below the fold.
  useEffect(() => {
    if (ready && takeSettingsSectionRequest('agent-defaults')) {
      ref.current?.scrollIntoView({ block: 'center' });
    }
  }, [ready]);
  if (!ready) return null;

  const change = async (next: NewAgentDefaultsChange) => {
    setSaving(true);
    try {
      await setNewAgentDefaults(next);
      setProblem(null);
      // The overview carries it (the backend also says so with an event).
      await refreshAgents();
    } catch (error) {
      setProblem(formatCommandError(asCommandError(error)));
    } finally {
      setSaving(false);
    }
  };

  const chosen = defaults.engine;
  const fallback = startsOnFallback(defaults, 'Pick');
  const states = engines
    .map((e) => `${ENGINE_LABEL[e.id] ?? e.label} ${engineState(e)}`)
    .join(' · ');
  const installed = engines.filter((e) => e.installed);

  return (
    <div
      ref={ref}
      className="settings-section agent-defaults-settings"
      aria-busy={saving || undefined}
    >
      <Row label="New agents start on" description={fallback ?? states}>
        <SegmentedControl<AgentEngine>
          aria-label="New agents start on"
          // Where new agents start now, as the phone shows it; on a fallback,
          // picking the shown engine makes it the saved choice.
          value={defaults.startsOn}
          options={engines.map((e) => ({
            value: e.id,
            label: ENGINE_LABEL[e.id] ?? e.label,
            disabled: engineUnavailable(e) !== null,
            title:
              engineUnavailable(e) !== null
                ? `${ENGINE_LABEL[e.id] ?? e.label} is ${engineState(e)}`
                : undefined,
          }))}
          onValueChange={(engine) => {
            if (engine !== chosen) void change({ engine });
          }}
        />
      </Row>
      {installed.map((e) => (
        <ModelRow
          key={e.id}
          engine={e.id}
          engines={engines}
          value={newAgentModel(defaults, e.id, modelChoices(e.id, engines))}
          onChange={(model) => void change({ [MODEL_CHANGE_KEY[e.id]]: model })}
        />
      ))}
      {problem && (
        <span className="agent-defaults-problem" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
