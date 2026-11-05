/**
 * What new agents start on, as Settings shows it: the Mac's own setting
 * (`agents.overview`'s `defaults`), changed with `agents.setDefaults` on a
 * Mac that serves it. Mirrors the desk's Settings → Agents: only engines the
 * Mac runs, only models an engine itself lists, "Engine's default" always.
 */

import type {
  AgentEngine,
  EngineInfo,
  NewAgentDefaults,
  NewAgentDefaultsChange,
} from '@shipstudio/companion-protocol';

export const ENGINE_DEFAULT = 'Engine’s default';

const ENGINE_NAME: Record<AgentEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Claude Code's aliases said by what they're for, as on the desk. */
const CLAUDE_PURPOSE: Record<string, string> = {
  opus: 'Most capable',
  sonnet: 'Balanced',
  haiku: 'Fastest',
};

export interface EngineChoice {
  id: AgentEngine;
  label: string;
  /** Installed and signed in: only then can new agents start on it. */
  ready: boolean;
  /** Why it can't be picked, when it can't. */
  why: string | null;
}

export const engineChoices = (engines: EngineInfo[]): EngineChoice[] =>
  engines.map((e) => ({
    id: e.id,
    label: ENGINE_NAME[e.id] ?? e.label,
    ready: e.installed && e.signedIn,
    why: !e.installed ? 'Not installed' : !e.signedIn ? 'Not signed in' : null,
  }));

export interface ModelOption {
  /** '' is the engine's own default (no model passed). */
  value: string;
  label: string;
  detail?: string;
}

/** "Engine's default", then exactly the models the engine listed. */
export function modelOptions(engine: AgentEngine, engines: EngineInfo[]): ModelOption[] {
  const listed = engines.find((e) => e.id === engine)?.models ?? [];
  return [
    { value: '', label: ENGINE_DEFAULT },
    ...listed.map((m) =>
      engine === 'claude' && CLAUDE_PURPOSE[m.value]
        ? { value: m.value, label: CLAUDE_PURPOSE[m.value], detail: m.label }
        : { value: m.value, label: m.label }
    ),
  ];
}

/** The model chosen for `engine`, or '' (its default). */
export const chosenModel = (defaults: NewAgentDefaults, engine: AgentEngine) =>
  defaults.models[engine] ?? '';

/** The footer under "New agents": where they start, and why when it isn't the choice. */
export function startsOnLine(defaults: NewAgentDefaults): string {
  const on = ENGINE_NAME[defaults.startsOn];
  if (defaults.engine && defaults.engine !== defaults.startsOn) {
    return `${ENGINE_NAME[defaults.engine]} isn’t ready, so new agents start on ${on} for now. Agents you already have keep theirs.`;
  }
  return 'For new agents only: agents you already have keep theirs.';
}

/** The change a tap on a model row makes. */
export const modelChange = (engine: AgentEngine, value: string): NewAgentDefaultsChange =>
  engine === 'claude' ? { claudeModel: value } : { codexModel: value };
