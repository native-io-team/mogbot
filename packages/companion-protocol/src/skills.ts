/**
 * "Save new skills" and "Skills" (`agents/skills_learn.rs`),
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

export const LEARN_SKILLS_LABEL = 'Save new skills';
export const SKILLS_TITLE = 'Skills';
export const SKILL_SAVE = 'Save';
export const SKILL_NOT_NOW = 'Not now';
/**
 * Under a pending skill card, desk and phone: what saving does for you, where
 * it goes, and that it's an offer, not a gate.
 */
export const SKILL_OFFER_NOTE =
  'Saved, it does this the same way next time, without you explaining it again. It’s kept under Skills in this agent’s settings. Nothing is waiting on your answer.';

/** Words after "the user" that end in s but aren't its verb. */
const NOT_VERBS = new Set(['this', 'his', 'its', 'as', 'us', 'plus', 'thus', 'always', 'perhaps']);

/** "the user asks" → "you ask": the verb after "the user", made to agree with "you". */
function verbForYou(verb: string): string {
  const lower = verb.toLowerCase();
  const fixed: Record<string, string> = {
    is: 'are',
    has: 'have',
    was: 'were',
    does: 'do',
    goes: 'go',
  };
  if (fixed[lower]) return fixed[lower];
  if (NOT_VERBS.has(lower)) return verb;
  if (/(sh|ch|x|ss|z)es$/.test(lower)) return verb.slice(0, -2);
  if (/[^aeiou]ies$/.test(lower)) return `${verb.slice(0, -3)}y`;
  if (/[^s]s$/.test(lower)) return verb.slice(0, -1);
  return verb;
}

/**
 * A skill's "when", said to you. The agent writes it for itself ("When the
 * user asks to reconcile…"); on a card or in the list you read "When you
 * ask to reconcile…". Display only: the saved skill keeps the agent's words.
 */
export function skillWhenLine(when: string): string {
  // "The user…" opening a sentence stays capitalised.
  const as = (m: string, out: string) => (m[0] === 'T' ? out[0].toUpperCase() + out.slice(1) : out);
  return when
    .replace(/\bthe user[’']s\b/gi, (m) => as(m, 'your'))
    .replace(
      /\bthe user (?:(always|often|usually|just|then|also) )?(\w+)/gi,
      (m, adverb: string | undefined, verb: string) =>
        as(m, `you ${adverb ? `${adverb} ` : ''}${verbForYou(verb)}`)
    )
    .replace(/\bthe user\b/gi, (m) => as(m, 'you'));
}

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
  { value: 'off', label: 'Off', detail: 'It doesn’t save new skills.' },
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
    ? `${name} doesn’t save new skills.`
    : `Nothing yet. When ${name} finishes a hard task it can save how it did it here.`;
}

/** The card's receipt once answered. */
export function skillOutcome(status: string): string | null {
  if (status === 'allowed') return 'Saved · under Skills';
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
