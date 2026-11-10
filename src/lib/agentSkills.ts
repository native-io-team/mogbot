/**
 * Skills an agent saved after a hard task (`agents/skills_learn.rs`): its
 * "Save new skills" setting and "Skills". The words
 * are shared with the phone (`companion-protocol/src/skills.ts`).
 *
 * @module lib/agentSkills
 */

import { invoke } from '@tauri-apps/api/core';
import type { Skill, SkillsView } from '../../packages/companion-protocol/src/skills';

export * from '../../packages/companion-protocol/src/skills';

/** Emitted with the agent's id whenever its skills change. */
export const SKILLS_CHANGED_EVENT = 'agents-skills-changed';

export const agentSkills = (agentId: string) => invoke<SkillsView>('agents_skills', { agentId });

export const editAgentSkill = (
  agentId: string,
  slug: string,
  edit: { name: string; when: string; steps: string }
) => invoke<Skill>('agents_skill_edit', { agentId, slug, ...edit });

export const removeAgentSkill = (agentId: string, slug: string) =>
  invoke<void>('agents_skill_remove', { agentId, slug });
