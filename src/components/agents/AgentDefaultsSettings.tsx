/**
 * Settings → Agents → Engines and models: what a new agent starts on when
 * nobody picked, a real setting (`agents_set_defaults`, saved in the app's
 * settings; `agents::defaults`).
 *
 * - **New agents start on**: Claude Code or Codex, only engines `agents::engine`
 *   runs; one that isn't installed and signed in can't be chosen. A choice
 *   that stops being ready (signed out) isn't lost: the line says where new
 *   agents start meanwhile, as the backend decides it (`startsOn`).
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
import { ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { useAgentsSelector, refreshAgents } from '../../lib/agentsStore';
import {
  ENGINE_LABEL,
  engineUnavailable,
  modelChoices,
  newAgentModel,
  setNewAgentDefaults,
  type AgentEngine,
  type EngineInfo,
  type NewAgentDefaultsChange,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { takeSettingsSectionRequest } from '../../lib/settings';

/** The model choice that passes no model: whatever the engine itself defaults to. */
export const ENGINE_DEFAULT_LABEL = 'Engine’s default';

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

/** The engine's models as Settings names them: "Engine's default", then its own. */
function choicesFor(engine: AgentEngine, engines: EngineInfo[]) {
  return modelChoices(engine, engines).map((m) =>
    m.value === '' ? { ...m, label: ENGINE_DEFAULT_LABEL, detail: undefined } : m
  );
}

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
  const choices = choicesFor(engine, engines);
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
        {choices.map((m) => (
          <DropdownItem
            key={m.value || 'default'}
            active={m.value === current.value}
            onSelect={() => onChange(m.value)}
          >
            <span className="agent-defaults-menu__label">{m.label}</span>
            {m.detail && <span className="agent-defaults-menu__detail">{m.detail}</span>}
          </DropdownItem>
        ))}
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
  // ⌘K "Engine and model for new agents…": shown, not left below the fold.
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
  const fallback = chosen !== null && chosen !== defaults.startsOn;
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
      <Row
        label="New agents start on"
        description={
          fallback
            ? `${ENGINE_LABEL[chosen]} isn’t ready, so new agents start on ${ENGINE_LABEL[defaults.startsOn]} for now.`
            : states
        }
      >
        <SegmentedControl<AgentEngine>
          aria-label="New agents start on"
          value={chosen ?? defaults.startsOn}
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
          value={newAgentModel(defaults, e.id, choicesFor(e.id, engines))}
          onChange={(model) =>
            void change(e.id === 'claude' ? { claudeModel: model } : { codexModel: model })
          }
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
