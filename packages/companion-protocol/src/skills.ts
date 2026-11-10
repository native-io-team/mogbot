/**
 * "Save what it learns" and "What it knows how to do" (`agents/skills_learn.rs`),
 * worded once for the desk and the phone.
 *
 * After a hard task an agent may save how it did it as a skill (a name,
 * when to use it, the steps). Per agent: Automatically, Ask me (the
 * default) or Off. Ask me puts one card in the chat, Save / Not now; a
 * turn that read outside text always asks.
 */

/** Stored on the agent (`learnSkills`); absent means `ask`. */
export type LearnSkills = 'auto' | 'ask' | 'off';

/** One saved skill, as `agents.skills` lists it. */
export interface Skill {
  /** Its folder's name (lowercase words and hyphens): what edit and remove name. */
  slug: string;
  name: string;
  /** When to use it, one sentence. */
  when: string;
  /** The steps that worked. */
  steps: string;
}

/** `agents.skills`: the setting and the skills. */
export interface SkillsView {
  agentId: string;
  setting: LearnSkills;
  skills: Skill[];
}

/** On an approval card (`approval.skill`): the skill exactly as it would be saved. */
export interface SkillCard extends Skill {
  /** Personal details and secrets taken out of it. */
  removed?: number;
  /** It came from a turn that read outside content: it asks whatever the setting. */
  outside?: boolean;
  /** It has a skill by this name already, which this replaces. */
  replaces?: boolean;
}

export const LEARN_SKILLS_LABEL = 'Save what it learns';
export const SKILLS_TITLE = 'What it knows how to do';
export const SKILL_SAVE = 'Save';
export const SKILL_NOT_NOW = 'Not now';

/** The three choices, in the order they're offered. */
export const LEARN_SKILLS_CHOICES: { value: LearnSkills; label: string; detail: string }[] = [
  {
    value: 'auto',
    label: 'Automatically',
    detail: 'After a hard task it saves how it did it, with a line in the chat.',
  },
  {
    value: 'ask',
    label: 'Ask me',
    detail: 'After a hard task it offers to save how it did it, on a card.',
  },
  { value: 'off', label: 'Off', detail: 'It doesn’t save what it learns.' },
];

export function learnSkillsOf(agent: { learnSkills?: LearnSkills }): LearnSkills {
  return agent.learnSkills ?? 'ask';
}

export function learnSkillsLabel(value: LearnSkills): string {
  return LEARN_SKILLS_CHOICES.find((c) => c.value === value)?.label ?? 'Ask me';
}

/** The line under the list: what it does now, and that outside text always asks. */
export function learnSkillsDetail(value: LearnSkills): string {
  const own = LEARN_SKILLS_CHOICES.find((c) => c.value === value)?.detail ?? '';
  return value === 'off' ? own : `${own} Anything that read outside content asks first.`;
}

/** "Nothing saved yet": the empty list, by setting. */
export function noSkillsLine(name: string, value: LearnSkills): string {
  return value === 'off'
    ? `${name} doesn’t save what it learns.`
    : `Nothing yet. When ${name} finishes a hard task it can save how it did it here.`;
}

/** The card's receipt once answered. */
export function skillOutcome(status: string): string | null {
  if (status === 'allowed') return 'Saved · under What it knows how to do';
  if (status === 'denied') return 'Not now · nothing was saved';
  return null;
}

/** The card's small print: what was removed, and outside content. */
export function skillCardNote(card: SkillCard): string | null {
  const parts: string[] = [];
  if (card.replaces) parts.push('Replaces the skill it has by this name.');
  if (card.removed) {
    parts.push(
      card.removed === 1
        ? '1 personal detail or secret removed.'
        : `${card.removed} personal details or secrets removed.`
    );
  }
  if (card.outside) {
    parts.push('It read outside content in this conversation: check nothing in it came from there.');
  }
  return parts.length ? parts.join(' ') : null;
}
