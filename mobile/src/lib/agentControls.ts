/**
 * The composer's chip and the Agent controls sheet it opens, pure so they're
 * tested (components/Composer.tsx and app/controls.tsx draw them).
 *
 * The chip says what matters about the next message: the model ("Opus 5.5")
 * and, when one is set, how hard it thinks ("· High"). Only what the Mac
 * said: the version comes from the engine's own id for the model of its last
 * request (`context.model`, e.g. `claude-opus-5-5`), never from a table here;
 * without one it is the name the engine lists the model under ("Opus"), and
 * with no model at all, the engine ("Claude Code").
 */

import {
  AGENT_EFFORTS,
  type Agent,
  type AgentEffort,
  type EngineInfo,
} from '@shipstudio/companion-protocol';
import { ENGINE_DEFAULT } from './newAgentDefaults';

const ENGINE_NAME = { claude: 'Claude Code', codex: 'Codex' } as const;

export const EFFORT_LABEL: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** What each level means, under its row. */
export const EFFORT_DETAIL: Record<AgentEffort, string> = {
  low: 'Quicker replies, fewer tokens',
  medium: 'A balance of the two',
  high: 'Thinks longest, uses the most tokens',
};

const FAMILY = /^(opus|sonnet|haiku)$/;
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * A Claude model id as Claude names it: `claude-opus-5-5` → "Opus 5.5",
 * `claude-sonnet-4-20250514` → "Sonnet 4", `claude-3-5-haiku-20241022` →
 * "Haiku 3.5". Null for anything else: it is never guessed at.
 */
export function claudeModelName(id: string): { family: string; name: string } | null {
  const bare = id.replace(/\[[^\]]*\]$/, '');
  const now = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare);
  if (now) {
    const [, family, major, minor] = now;
    return { family, name: `${cap(family)} ${minor ? `${major}.${minor}` : major}` };
  }
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(bare);
  if (old) {
    const [, major, minor, family] = old;
    return { family, name: `${cap(family)} ${minor ? `${major}.${minor}` : major}` };
  }
  return null;
}

/**
 * The model's short name, or null when nothing says which model it is (on
 * the engine's default, before a turn has reported one).
 */
export function modelShortName(
  agent: Pick<Agent, 'engine' | 'model' | 'context'>,
  engines: EngineInfo[] | undefined
): string | null {
  const listed = engines?.find((e) => e.id === agent.engine)?.models ?? [];
  const reported = agent.context?.model;
  if (agent.engine === 'claude' && reported) {
    const read = claudeModelName(reported);
    // A reading from another family than the one chosen is from before the
    // switch reached a turn: the choice wins.
    const chosen = agent.model && FAMILY.test(agent.model) ? agent.model : null;
    if (read && (!chosen || chosen === read.family)) return read.name;
  }
  if (agent.engine === 'codex' && reported && (!agent.model || agent.model === reported)) {
    return listed.find((m) => m.value === reported)?.label ?? reported;
  }
  if (agent.model) return listed.find((m) => m.value === agent.model)?.label ?? agent.model;
  return null;
}

export interface ChipLabel {
  /** The model's short name, or the engine's when nothing names a model. */
  main: string;
  /** The effort, muted after a dot; null on the engine's default. */
  effort: string | null;
  /** Read aloud. */
  says: string;
}

export function chipLabel(
  agent: Pick<Agent, 'engine' | 'model' | 'context' | 'effort'>,
  engines: EngineInfo[] | undefined
): ChipLabel {
  const engine = ENGINE_NAME[agent.engine] ?? agent.engine;
  const model = modelShortName(agent, engines);
  const effort = agent.effort && AGENT_EFFORTS.includes(agent.effort) ? EFFORT_LABEL[agent.effort] : null;
  const main = model ?? engine;
  const says = [
    model ? `${model} on ${engine}` : `${engine}, its default model`,
    effort && `${effort} effort`,
  ]
    .filter(Boolean)
    .join(', ');
  return { main, effort, says: `Runs on ${says}` };
}

/** The effort rows: the engine's default, then the three levels. */
export const effortRows = (): { value: AgentEffort | ''; label: string; detail?: string }[] => [
  { value: '', label: ENGINE_DEFAULT },
  ...AGENT_EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e], detail: EFFORT_DETAIL[e] })),
];

/**
 * Why the model and effort can't change right now, or null when they can. A
 * turn running keeps the ones it started on; the level can still change (it
 * applies at the turn's next step).
 */
export function controlsLocked(agent: Pick<Agent, 'status' | 'takeover'>): string | null {
  if (agent.takeover) return 'You’re driving it on the Mac. Change these after you hand it back.';
  if (agent.status.state !== 'idle') return 'Change the model and effort when this turn ends.';
  return null;
}
