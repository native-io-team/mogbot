/**
 * Switching what an agent runs on from its message card's engine chip: pure,
 * so it is tested. The choices are the desk's (Settings → Agents): only
 * engines the Mac reports as installed and signed in, only the models the
 * engine itself lists, "Engine's default" always (`lib/newAgentDefaults.ts`).
 * The Mac does the switch with `agents.update` (`MAC_FEATURES.engine`): a new
 * engine starts a new session and carries the conversation over as a recap.
 */

import type { Agent, AgentEngine, EngineInfo } from '@shipstudio/companion-protocol';
import { engineChoices, modelOptions, type ModelOption } from './newAgentDefaults';

export interface ModelRow extends ModelOption {
  /** It is what the agent runs on now. */
  current: boolean;
}

/** An engine other than the agent's own that is installed and signed in. */
export interface OtherEngine {
  id: AgentEngine;
  label: string;
}

/** Why the picker can't be used right now, or null when it can. */
export function engineLocked(agent: Pick<Agent, 'status' | 'takeover'>): string | null {
  if (agent.takeover) return 'Switch engines after you hand it back';
  if (agent.status.state !== 'idle') return 'Switch engines when this turn ends';
  return null;
}

/** The agent's own engine's models, the one it runs on marked. */
export function currentModels(
  agent: Pick<Agent, 'engine' | 'model'>,
  engines: EngineInfo[]
): ModelRow[] {
  const run = agent.model ?? '';
  return modelOptions(agent.engine, engines).map((m) => ({ ...m, current: m.value === run }));
}

/** The other engines it can move to: ready ones only. */
export function otherEngines(
  agent: Pick<Agent, 'engine'>,
  engines: EngineInfo[]
): OtherEngine[] {
  return engineChoices(engines)
    .filter((c) => c.ready && c.id !== agent.engine)
    .map(({ id, label }) => ({ id, label }));
}

/** Whether the chip opens anything: another model of its engine, or another ready engine. */
export const canSwitch = (agent: Pick<Agent, 'engine'>, engines: EngineInfo[]) =>
  otherEngines(agent, engines).length > 0 ||
  modelOptions(agent.engine, engines).length > 1;

/** What a model row says, "Balanced · Sonnet" as the desk's list does. */
export const modelRowLabel = (m: ModelOption) => (m.detail ? `${m.label} · ${m.detail}` : m.label);

/**
 * The one line after a switch. A new engine carries the conversation over
 * (the Mac gives it a recap); a model change on the same engine continues it.
 */
export function switchedLine(engine: string, model: string | null, newEngine: boolean): string {
  const on = model ? `${engine} · ${model}` : engine;
  return newEngine ? `Now on ${on}. It has the conversation so far.` : `Now on ${on}.`;
}
