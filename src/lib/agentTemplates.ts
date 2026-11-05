/**
 * Ready-made agents ("role templates"). The catalogue is the same file the
 * backend reads (`src-tauri/src/agents/templates.json`, see
 * `agents/templates.rs`), imported as-is, so the New agent dialog shows
 * exactly the briefing the Chief's `create_agent` would give one.
 *
 * @module lib/agentTemplates
 */

import catalogue from '../../src-tauri/src/agents/templates.json';
import type { Agent } from './agents';

export interface TemplateStarter {
  label: string;
  /** Sent at once when `send`; otherwise typed into the composer for the user to finish. */
  text: string;
  send: boolean;
}

export interface RoleTemplate {
  id: string;
  /** What the picker calls it ("Research assistant"). */
  title: string;
  /** The agent's name unless the user picks another. */
  name: string;
  role: string;
  color: string;
  /** What it can't work without: `mail` is an email app the user connects. */
  needs: 'mail' | null;
  starters: TemplateStarter[];
  /** The briefing, one line per entry. */
  instructions: string[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = catalogue.templates as RoleTemplate[];

export function findTemplate(id: string | null | undefined): RoleTemplate | null {
  if (!id) return null;
  return ROLE_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function templateInstructions(template: RoleTemplate): string {
  return template.instructions.join('\n');
}

/** The template an agent was made from, if it is one this build knows. */
export function templateOf(agent: Pick<Agent, 'template'>): RoleTemplate | null {
  return findTemplate(agent.template);
}

/**
 * The line under a template that can't work alone, said where it's needed
 * (the New agent dialog, and the agent's first open). Never claims the app is
 * or isn't connected: nothing knows until the engine lists its apps.
 */
export function needsLine(template: RoleTemplate, engine: Agent['engine']): string | null {
  if (template.needs !== 'mail') return null;
  return engine === 'codex'
    ? 'It reads your email through an app you’ve connected in Codex, such as Gmail.'
    : 'It reads your email through an app you connect, such as Gmail.';
}
