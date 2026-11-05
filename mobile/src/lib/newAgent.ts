/**
 * A new agent from the phone, the parts that are pure: a name to start from
 * when you only said what it should do, the colour the desk would give it,
 * and the words handed to the Chief of Staff when you'd rather it set one up.
 *
 * Nothing here is sent unseen: the suggested name is the field's placeholder
 * and the Create button's words, so what you create is what you read.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { agentColorKeys } from './theme';

/** `store::COLORS`, in the desk's order. */
export const AGENT_COLORS: readonly string[] = agentColorKeys.all;

/** The desk's own limits (`store::validate_name`, the router's role cap). */
export const MAX_NAME = 40;
export const MAX_ROLE = 500;

/**
 * The first colour nobody wears yet, leaving white and gray for you to pick:
 * the desk's `freeColor` and the router's `free_color`. Purple when all are taken.
 */
export function freeColor(taken: string[]): string {
  const left: readonly string[] = agentColorKeys.pickedOnly;
  return (
    AGENT_COLORS.find((c) => !left.includes(c) && !taken.includes(c)) ?? agentColorKeys.fallback
  );
}

/** Words that say how, not what: never a name on their own. */
const FILLER = new Set(
  (
    'a an the my our your me us i you it its this that these those and or but of to for on in at ' +
    'by with from into about over under up down out off all any every each some what which who ' +
    'when where how is are be keep keeps help helps make makes do does get gets give gives take ' +
    'takes watch watches check checks track tracks manage manages handle handles look looks ' +
    'draft drafts write writes send sends find finds tell tells let lets stay stays run runs ' +
    'just only also really things thing stuff matters matter daily weekly morning evening day ' +
    'week new please can could should would will'
  ).split(' ')
);

/**
 * A name from what it should do, for when you give none: its first word that
 * says what it's about, capitalised ("Keeps my inbox down to what matters" →
 * "Inbox"), made unique against the team ("Inbox 2"). Null when nothing in it
 * would make a name; the field then asks for one.
 */
export function suggestAgentName(role: string, taken: string[]): string | null {
  const word = role
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((w) => w.replace(/^['’-]+|['’-]+$/g, ''))
    .find((w) => w.length > 1 && !FILLER.has(w.toLowerCase()) && !/^\d+$/.test(w));
  if (!word) return null;
  const base = (word[0].toUpperCase() + word.slice(1)).slice(0, MAX_NAME - 3);
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

/**
 * What goes into the Chief's composer for "Ask your Chief of Staff": a
 * request in your words, left for you to read and send.
 */
export function chiefRequest(role: string, name: string): string {
  const what = role
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
  const called = name.trim() ? ` called ${name.trim()}` : '';
  if (!what) return `Can you set up a new agent${called} for me?`;
  // Your words as you wrote them, whatever their grammar ("Keeps my inbox…", "Draft my day").
  return `Can you set up a new agent${called}? What it’s for: ${what}.`;
}

/** The Chief of Staff, if the Mac has said who it is. */
export const chiefOf = (agents: Agent[] | undefined) => agents?.find((a) => a.isMain);
