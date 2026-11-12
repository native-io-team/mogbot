/**
 * Agent keys (docs/design/agent-keys.md): the team as a board of keys in
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
      'What’s in flight ordered by attention (docs/design/in-flight-board-2026-11-10.md): Needs you · 1 leads with Lead Gen’s row (its key proud with an amber legend and spill, the loudest key) and its card; Working now has Acme Site and Research pressed and lit warm, each with Stop; Paused has Native App, drained grey and sunk; then Everyone else as a quiet well of small keys, each named with its bound letter at the top right (Hiring says “Live · You’re driving it” under its name), and the dashed New agent key. Readable in both themes; keys keep their colours.',
    requires: '.agents-team .agent-key[data-state="needsOk"]',
    command: 'agents.team',
    viewport: { width: 1440, height: 1000 },
    commands,
  },
  {
    id: 'agents-keys-sidebar',
    title: 'Agents — small keys in the sidebar, the Chief’s chat open',
    looksRightWhen:
      'Twelve sidebar rows, each led by a 30px key in its colourway with one legend: the app’s mark (the filled “M”) on Graphite for the Chief, money for Finance, people for Hiring, megaphone for Social Posts, shield for Security & DevOps, an inbox for Inbox. Working rows are pressed and warm-lit; Lead Gen’s key sits proud with an amber legend and spill (the loudest); Native App’s key is drained grey and sunk; Hiring’s row says “Live” in green. Every key still reads as a key at this size. The chat header shows the Chief’s 44px key.',
    openSelector: AGENTS_TAB,
    requires: '.agents-list__row .agent-key[data-icon="mogbot"]',
    commands,
  },
  {
    id: 'agents-keys-picker',
    title: 'Agents — a new agent’s key: colourway, legend and shortcut key',
    looksRightWhen:
      'New agent. Under the name, the key at 112px on a quiet band (its legend read from the name as you type, the first free letter as its sublegend), then Colour (fourteen small keys), Icon (a search box, the category filters, “2,052 icons” and the grid: the featured legends first as small keys in the chosen colourway, the app’s filled mark leading, then the pack), and Shortcut key: a field showing the letter, with the line “Press <letter> anywhere outside a text box to open this agent.” The pick sits pressed down with a small neutral check on its corner, never a box round it and never the accent; the rest are slightly quieter.',
    requires: '.agent-sheet__key .agent-key--xl',
    steps: [
      { click: '.agents-list__new' },
      // New agent opens describe-first; the form (and its key) is hidden by
      // the stylesheet until "fill it in yourself", so a step into it would
      // still "find" its control.
      { click: '.agent-editor__fill-in' },
      { fill: '.agent-sheet__field[aria-label="Agent name"]', value: 'Bookings' },
    { click: '.agent-sheet__key' },
    ],
    commands,
  },
  {
    id: 'agents-keys-picker-edit',
    title: 'Agents — editing an agent’s key: the pick among the colourways and icons',
    looksRightWhen:
      'Edit agent with its look open. In Colour and Icon the picked key sits pressed down, its own colour lit softly under it, with a small neutral check disc on its top-right corner (never a box round it, never the accent); the other keys are slightly quieter. Readable in both themes.',
    openSelector: AGENTS_TAB,
    requires: '.agent-sheet__key .agent-key--xl',
    steps: [
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-sheet__key' },
    ],
    clipSelector: '.agent-look',
    commands: { ...commands, agents_instructions: 'Keep the team moving.' },
  },
  {
    id: 'agents-keys-icon-search',
    title: 'Agents — searching every icon for “money”',
    looksRightWhen:
      'New agent, the key picker open, “money” typed into the icon search. Under it the categories as a strip that fits the dialog (All, Featured, People, Finance, Mail, Time & calendar, then More holding the rest), nothing cut at the edge, the line “N for “money””, then the matches as small keys in the chosen colourway: our Money legend first, then Lucide’s banknote, coins, currency, wallet, dollar sign… drawn in the same uniform stroke as the featured legends, round-capped. The key at 112px above wears whatever is picked. Readable in both themes.',
    requires: '.agent-icons .agent-look__choice[data-value="lucide:banknote"]',
    steps: [
      { click: '.agents-list__new' },
      { click: '.agent-editor__fill-in' },
      { fill: '.agent-sheet__field[aria-label="Agent name"]', value: 'Bookkeeper' },
      { click: '.agent-sheet__key' },
      { fill: '.agent-icons input', value: 'money' },
      { click: '.agent-icons .agent-look__choice[data-value="lucide:wallet"]' },
    ],
    commands,
  },
  {
    id: 'agents-keys-colourways',
    title: 'Agents — the fourteen colourways on a new agent',
    looksRightWhen:
      'New agent, the key picker open: Colour shows fourteen small keys: the eight from before, then Brick, Plum, Navy, Forest, Sky and Lilac, which differ in lightness as well as hue (Navy and Forest deep, Sky and Lilac pale). Each legend reads on its face. Navy is picked: the 112px key is navy with a warm off-white legend.',
    requires: '.agent-sheet__key .agent-key[data-colorway="navy"]',
    steps: [
      { click: '.agents-list__new' },
      { click: '.agent-editor__fill-in' },
      { fill: '.agent-sheet__field[aria-label="Agent name"]', value: 'Ledger' },
      { click: '.agent-sheet__key' },
      { click: '.agent-look__choice[data-value="navy"]' },
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
      { click: '.agent-editor__fill-in' },
      { click: '.agent-sheet__key' },
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
