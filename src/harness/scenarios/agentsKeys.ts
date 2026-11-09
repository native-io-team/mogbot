/**
 * Agent keys (docs/internal/agent-keys.md): the team as a board of keys in
 * What's in flight, the sidebar's small keys in every state, the chat
 * header's key, the editor's pickers (colourway, legend, press-to-bind), a
 * bind refused because another agent has the key, and a key changed from
 * chat. Fictional team. Capture each with `--theme light` too.
 */

import { boundKeyFor, freshColorway } from '../../../packages/companion-protocol/src/agentKeys';
import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, agent, messagesFor, msg, overview, status } from './agents';

const MIN = 60_000;

/** Twelve, everyone shown, in every state a key has; each given its key as the Mac would. */
const BASE = [
  ...TEAM.map((a) => {
    if (a.id === 'clients') return { ...a, hidden: false };
    // Cut off by a usage limit: paused, its cap off until the reset.
    if (a.id === 'native') {
      return { ...a, failure: { kind: 'usage_limit' as const, resetsAt: Date.now() + 90 * MIN } };
    }
    // You're driving its session: live, its legend lit.
    if (a.id === 'hiring') {
      return {
        ...a,
        takeover: {
          since: Date.now() - 6 * MIN,
          ptySession: 'takeover-hiring',
          cli: 'claude-code',
        },
      };
    }
    return a;
  }),
  agent('travel', 'Travel', {
    color: 'blue',
    minutesAgo: 60 * 30,
    role: 'Plans trips and keeps bookings straight.',
    preview: 'Your Lisbon hotel is confirmed for the 14th.',
  }),
  agent('research', 'Research', {
    color: 'purple',
    minutesAgo: 60 * 6,
    role: 'Reads so you don’t have to.',
    status: status('working', 'Reading three pricing pages'),
    preview: 'Two of the five competitors changed pricing this month.',
  }),
  agent('inbox', 'Inbox', {
    color: 'brown',
    minutesAgo: 60 * 8,
    role: 'Triage email.',
    preview: 'Nine new, two worth your time.',
  }),
  agent('security', 'Security & DevOps', {
    color: 'gray',
    minutesAgo: 60 * 96,
    role: 'Watches uptime, backups and the deploy keys.',
    preview: 'Backups ran; nothing failed overnight.',
  }),
];

/** Keys as `agents::keys::fill` gives them: the Chief first, then in team order. */
const TWELVE = (() => {
  const taken: string[] = [];
  const worn: string[] = [];
  const order = [...BASE].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  const keys = new Map<string, string>();
  for (const a of order) {
    const k = boundKeyFor(a.name, taken) ?? '';
    taken.push(k);
    keys.set(a.id, k);
  }
  return BASE.map((a) => {
    // A couple chose their own colourway and legend; the rest wear what their colour and name give.
    const own =
      a.id === 'travel'
        ? { colorway: freshColorway(worn), icon: 'calendar' }
        : a.id === 'leadgen'
          ? { colorway: 'sage', icon: 'send' }
          : {};
    return { ...a, ...own, boundKey: keys.get(a.id) };
  });
})();

// The team at Steady (two pips); Finance set to Bold, Lead Gen to Unleashed.
const TEAM_KEYS = TWELVE.map((a) =>
  a.id === 'finance'
    ? { ...a, independence: 'go_hard' }
    : a.id === 'leadgen'
      ? { ...a, independence: 'full_send' }
      : a
);

const commands = {
  agents_overview: { ...overview(TEAM_KEYS), independence: 'judgement' },
  agents_messages: messagesFor,
};

/** A key asked for in chat: the Chief changes it at once, no card. */
const keyChat = (args: Record<string, unknown>) =>
  args.agentId === 'chief'
    ? [
        msg('user', 'Make Hiring teal with the people icon, and put it on H.', 2),
        msg('agent', 'Done: Hiring is now Teal, with the People legend, on key H.', 1),
      ]
    : messagesFor(args);

export const agentsKeysScenarios: Scenario[] = [
  {
    id: 'agents-keys-board',
    title: 'Agents — the team as a board of keys (What’s in flight)',
    looksRightWhen:
      'What’s in flight opens on a warm plate of full-size keys, one per agent, its name and its state in words under it, then an empty socket “New agent · Add one”. Each key: a darker skirt, a lighter inset face, a hard depth shadow, one legend centred, its bound letter small at the bottom right, independence pips on the front edge. Acme Site and Research are pressed (Working); Lead Gen sits proud and lit (Needs your OK, its state in amber); Hiring is lit (Live: you’re driving it); Native App is a socket with a cross-shaped stem in its colour (Paused). No glows round any key, no badge dots. Readable in both themes; keys keep their colours.',
    requires: '.agents-board .agent-key[data-state="needsOk"]',
    command: 'agents.team',
    viewport: { width: 1440, height: 1000 },
    commands,
  },
  {
    id: 'agents-keys-sidebar',
    title: 'Agents — small keys in the sidebar, the Chief’s chat open',
    looksRightWhen:
      'Twelve sidebar rows, each led by a 30px key in its colourway with one legend: a star for the Chief, money for Finance, people for Hiring, megaphone for Social Posts, shield for Security & DevOps, an inbox for Inbox. Working rows are pressed; Lead Gen’s key sits proud and lit; Native App shows an empty socket with its stem. Every key still reads as a key at this size. The chat header shows the Chief’s 44px key.',
    openSelector: AGENTS_TAB,
    requires: '.agents-list__row .agent-key[data-icon="star"]',
    commands,
  },
  {
    id: 'agents-keys-picker',
    title: 'Agents — a new agent’s key: colourway, legend and shortcut key',
    looksRightWhen:
      'New agent. Under the name, the key at 112px on a quiet band (its legend read from the name as you type, the first free letter as its sublegend), then Colour (eight small keys), Icon (every legend as a small key in the chosen colourway), and Shortcut key: a field showing the letter, with the line “Press <letter> anywhere outside a text box to open this agent.” The pick is a neutral ring, never the accent.',
    requires: '.agent-look__preview .agent-key--xl',
    steps: [
      { click: '.agents-list__new' },
      { fill: '.agent-editor__identity input', value: 'Bookings' },
    ],
    commands,
  },
  {
    id: 'agents-keys-bind-taken',
    title: 'Agents — binding a key another agent has is refused',
    looksRightWhen:
      'New agent, the key picker open. The shortcut field was pressed and F typed: the field still says the key it had, and the line under it reads “F is already Finance’s key. Pick another, or change theirs first.” Nothing else changed.',
    requires: '.agent-look__bind-field',
    steps: [
      { click: '.agents-list__new' },
      { focus: '.agent-look__bind-field' },
      { key: 'Enter' },
      { key: 'f' },
    ],
    commands,
  },
  {
    id: 'agents-keys-chat',
    title: 'Agents — “Make Hiring teal… put it on H” from chat',
    looksRightWhen:
      'The Chief’s chat: the request, then a one-line reply saying it’s done. No card: a key isn’t a setting. In the sidebar Hiring’s key is teal with the people legend.',
    openSelector: AGENTS_TAB,
    requires: '.agents-list__row .agent-key[data-colorway="teal"][data-icon="people"]',
    commands: {
      agents_overview: overview(
        TWELVE.map((a) =>
          a.id === 'hiring' ? { ...a, colorway: 'teal', icon: 'people', boundKey: 'H' } : a
        )
      ),
      agents_messages: keyChat,
    },
  },
];
