/**
 * Agent avatars (docs/internal/avatars.md): a sidebar of twelve agents in
 * their defaults and a few chosen looks, the Chief's chat header, the look
 * picker in the editor, and the settings card a look change from chat makes.
 * Add `&avatarDirection=solid|outline` to see a direction that wasn't chosen.
 * Fictional team.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, agent, messagesFor, msg, overview, status } from './agents';

/** The team, everyone shown, plus four more: twelve rows. */
const TWELVE = [
  ...TEAM.map((a) => {
    if (a.id === 'clients') return { ...a, hidden: false };
    // Two chose their own; the rest wear what their id gives them.
    if (a.id === 'hiring') return { ...a, avatar: { shape: 'hexagon', face: 'curious' } };
    if (a.id === 'social') return { ...a, avatar: { shape: 'drop', face: 'wink' } };
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
  agent('support', 'Support', {
    color: 'gray',
    minutesAgo: 60 * 96,
    role: 'Answers the help inbox from the docs.',
    preview: 'Drafted replies to four tickets.',
  }),
];

const SUMMARY = 'Hiring: Now a hexagon with a curious face.';

const lookChat = (args: Record<string, unknown>) =>
  args.agentId === 'chief'
    ? [
        msg('user', 'Give Hiring a hexagon with a curious face.', 2),
        msg('agent', 'Put it on a card for you.', 1),
        msg('approval', '', 1, {
          agentId: 'chief',
          approval: {
            requestId: 'look-1',
            title: 'Change Hiring’s settings?',
            detail: `${SUMMARY}\n\nWhy: You asked for it`,
            summary: SUMMARY,
            status: 'pending',
            settings: {
              targets: [{ kind: 'agent', agentId: 'hiring' }],
              change: {},
              version: 0,
              groups: [
                {
                  who: 'Hiring',
                  agentIds: ['hiring'],
                  changes: ['Now a hexagon with a curious face'],
                },
              ],
              why: 'You asked for it',
              look: { shape: 'hexagon', face: 'curious' },
            },
          },
        }),
      ]
    : messagesFor(args);

/** Hiring before it chose: its default, so the card shows a change. */
const BEFORE = TWELVE.map((a) => (a.id === 'hiring' ? { ...a, avatar: undefined } : a));

export const agentsAvatarsScenarios: Scenario[] = [
  {
    id: 'agents-avatars',
    title: 'Agents — avatars: a sidebar of twelve, the Chief’s chat open',
    looksRightWhen:
      'Twelve sidebar rows, each a soft shape in a tone of the agent’s colour with a small two-dot face in an ink of the same hue: no two neighbours alike, nothing neon, the Chief a squircle with a calm face, solid as the open agent. Acme Site and Research are working: a thin ring of their colour follows their silhouette. Hiring is a hexagon with a curious face (glancing right). The chat header shows the Chief’s avatar at the same weight as the row’s.',
    openSelector: AGENTS_TAB,
    requires: '.agents-list__row .agent-avatar[data-shape="hexagon"]',
    commands: {
      agents_overview: overview(TWELVE),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-avatars-picker',
    title: 'Agents — a new agent’s look: shape, face and colour',
    looksRightWhen:
      'New agent. The avatar beside Name has been clicked: under it, the avatar at 96px on a quiet band, then Shape (eight small avatars, the current one ringed in a neutral grey), Face (ten), Color (eleven swatches). The new agent starts on a shape nobody else wears; the Chief’s squircle isn’t offered as a default. Nothing in accent.',
    requires: '.agent-look__preview .agent-avatar--xl',
    steps: [{ click: '.agents-list__new' }, { click: '.agent-editor__look-toggle' }],
    commands: {
      agents_overview: overview(TWELVE),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-avatars-card',
    title: 'Agents — “Give Hiring a hexagon with a curious face” from chat',
    looksRightWhen:
      'The Chief’s chat: the request, a one-line reply, then the ordinary “Change Hiring’s settings?” card: Hiring shown as it would look (a pink hexagon, curious face) beside its name, “Now a hexagon with a curious face”, Why. Allow is neutral, Deny beside it. In the sidebar Hiring still wears its old look until Allow.',
    openSelector: AGENTS_TAB,
    requires: '.agent-settings-change__who .agent-avatar[data-shape="hexagon"]',
    commands: {
      agents_overview: overview(BEFORE),
      agents_messages: lookChat,
    },
  },
];
