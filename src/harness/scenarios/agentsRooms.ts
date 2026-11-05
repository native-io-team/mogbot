/**
 * Rooms (`agents/rooms.rs`, components/agents/RoomChat.tsx): group
 * conversations with two to six agents. A thread where three agents answer
 * @everyone and hand off to each other, an approval card inside it, the
 * "Who should answer?" ask, the mention menu with @everyone, the New room
 * dialog, and the one line a member's own chat shows for its room replies.
 * Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const LAUNCH = 'launch';
const OPS = 'ops';

const room = (over: Record<string, unknown>) => ({
  muted: false,
  createdAt: now - 3 * 24 * 60 * MIN,
  lastActivityAt: now - 2 * MIN,
  unread: 0,
  turnsUsed: 0,
  turnCap: 8,
  waiting: [],
  ...over,
});

const LAUNCH_ROOM = room({
  id: LAUNCH,
  name: 'Pricing launch',
  members: ['chief', 'acme', 'finance', 'social'],
  lead: 'chief',
  preview: 'Acme Site: The new table is on staging.',
  turnsUsed: 3,
});

/** No Chief, so no lead: a message naming nobody asks who should answer. */
const OPS_ROOM = room({
  id: OPS,
  name: 'Month end',
  members: ['finance', 'leadgen'],
  lastActivityAt: now - 3 * 60 * MIN,
  preview: 'Finance: Both invoices are chased.',
  unread: 1,
});

const inRoom = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  room: LAUNCH,
  ...over,
});

const WORK = (startMin: number, endMin: number, labels: [string, string][]) => ({
  startedAt: now - startMin * MIN,
  endedAt: now - endMin * MIN,
  stepCount: labels.length,
  fileCount: 0,
  files: [],
  steps: labels.map(([kind, label], i) => ({ at: now - startMin * MIN + i * 20_000, kind, label })),
});

const THREAD = [
  msg(
    'user',
    '@everyone the new annual pricing goes live Thursday. What do each of you need from me before then?',
    14,
    inRoom('', {
      mentions: [
        { id: 'chief', name: 'Chief of Staff' },
        { id: 'acme', name: 'Acme Site' },
        { id: 'finance', name: 'Finance' },
        { id: 'social', name: 'Social Posts' },
      ],
    })
  ),
  msg(
    'agent',
    'I’ll keep the plan in one place and chase anything that slips. The one thing I need from you is a yes on the Thursday 10am time, so everyone works back from it.',
    13,
    inRoom('chief')
  ),
  msg(
    'agent',
    'The table is built on staging with annual first. I need the final prices: are we still at $24 and $49 a seat? @Finance can you confirm what the invoices will say?',
    12,
    inRoom('acme', {
      work: WORK(14, 12, [
        ['read', 'Read PricingTable.tsx'],
        ['edit', 'Edited PricingTable.tsx'],
        ['command', 'Ran pnpm build'],
      ]),
    })
  ),
  msg(
    'agent',
    'Invoices will say $24 and $49 per seat, billed yearly, with the 20% annual discount shown as its own line. Existing monthly customers keep their price until renewal.',
    10,
    inRoom('finance')
  ),
  msg(
    'agent',
    'I’ve drafted three posts for launch morning. I won’t publish anything; they’re waiting for you to read.',
    9,
    inRoom('social')
  ),
  msg(
    'user',
    'Yes to Thursday 10am. @Acme Site ship it to staging so I can look.',
    4,
    inRoom('', {
      mentions: [{ id: 'acme', name: 'Acme Site' }],
    })
  ),
  msg(
    'agent',
    'The new table is on staging. I changed the copy on the toggle to “Billed yearly” to match Finance’s invoices.',
    2,
    inRoom('acme')
  ),
];

const APPROVAL = msg('approval', '', 1, {
  ...inRoom('acme'),
  approval: {
    requestId: 'room-push',
    title: 'Push to GitHub',
    detail: 'git push origin pricing-annual',
    status: 'pending',
    tool: 'Bash',
    input: { command: 'git push origin pricing-annual' },
  },
});

const team = (patch: Record<string, Record<string, unknown>> = {}) =>
  overview(TEAM.map((a) => (patch[a.id] ? { ...a, ...patch[a.id] } : a)));

const IDLE = {
  acme: { status: status('idle') },
  leadgen: { status: status('idle') },
};

const roomCommands = (
  thread: unknown[],
  agents = team(IDLE),
  rooms: unknown[] = [LAUNCH_ROOM, OPS_ROOM]
) => ({
  agents_overview: agents,
  agents_rooms: rooms,
  agents_room_focus: null,
  agents_room_messages: (args: Record<string, unknown>) =>
    args.roomId === LAUNCH ? thread : args.roomId === OPS ? OPS_THREAD : [],
  agents_room_send: (args: Record<string, unknown>) => ({
    message: msg('user', String(args.text), 0, { agentId: '', room: args.roomId, ts: Date.now() }),
    asked: [],
  }),
  agents_room_create: (args: Record<string, unknown>) =>
    room({
      id: 'new',
      name: typeof args.name === 'string' ? args.name : 'New room',
      members: args.members,
    }),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'acme' ? ACME_OWN : messagesFor(args),
});

const OPS_THREAD = [
  msg('user', 'Can you two make sure Northwind and Globex get chased this week?', 200, {
    agentId: '',
    room: OPS,
    mentions: [
      { id: 'finance', name: 'Finance' },
      { id: 'leadgen', name: 'Lead Gen' },
    ],
  }),
  msg('agent', 'Both invoices are chased. Northwind says Friday.', 180, {
    agentId: 'finance',
    room: OPS,
  }),
];

/** Acme Site's own chat: its room replies fold into lines that open the room. */
const ACME_OWN = [
  msg('user', 'How is the pricing table looking on mobile?', 60, { agentId: 'acme' }),
  msg('agent', 'Stacked cards on narrow screens now; the toggle sits above them.', 58, {
    agentId: 'acme',
  }),
  ...THREAD.filter((m) => (m as { agentId: string }).agentId === 'acme'),
];

const openRoom = (id: string) => ({ click: `[data-agent-id="room:${id}"]` });

export const agentsRoomsScenarios: Scenario[] = [
  {
    id: 'agents-room-thread',
    title: 'Rooms — four agents in one thread, @everyone and a hand-off',
    looksRightWhen:
      'Sidebar: under the agents, a quiet “Rooms” label and two rows with stacked avatars (three badges and “+1” for Pricing launch), the open one selected. Header: the stacked badges, “Pricing launch” and a muted “Chief of Staff, Acme Site, Finance and Social Posts · Chief of Staff answers unless you @ someone”, no agent colour on the header or the send button (neutral). Your two messages are right-aligned bubbles with a muted “To …” under each. Each agent’s run opens with its mini badge and name in its own colour (Acme green, Finance orange, Social red, Chief neutral), then its prose. Acme’s first reply has the folded “Worked … · 3 steps” line and its @Finance tinted. Lead Gen is not in the room and appears nowhere.',
    requires: '.agent-room .agent-room__speaker-name',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH)],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-working',
    title: 'Rooms — two members replying at once, one waiting',
    looksRightWhen:
      'Same thread. Under the last message, Finance and Social Posts each have their name in their colour over the typing dots and what they’re doing (“Reading invoices.csv”, “Thinking”); then a quiet centred “Chief of Staff will reply after what it’s doing now”, then a muted “3 of 8 replies for this message”. The sidebar row says “2 are replying…” with the loader.',
    requires: '.agent-room__working .agent-working',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH)],
    commands: roomCommands(
      THREAD,
      team({
        ...IDLE,
        finance: { status: { ...status('working', 'Reading invoices.csv'), room: LAUNCH } },
        social: { status: { ...status('working', 'Thinking'), room: LAUNCH } },
      }),
      [{ ...LAUNCH_ROOM, waiting: ['chief'] }, OPS_ROOM]
    ),
  },
  {
    id: 'agents-room-approval',
    title: 'Rooms — an approval card inside the room, under the agent asking',
    looksRightWhen:
      'The thread ends with Acme Site’s name (green) over its Allow / Deny card: “Push to GitHub”, the command `git push origin pricing-annual`, Deny then Allow on the right (Allow the neutral strong button, never green). The sidebar row reads “Acme Site needs your OK” with the amber dot; Acme’s own row says “Needs your OK”.',
    requires: '.agent-room .agent-approval',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH)],
    commands: roomCommands(
      [...THREAD, APPROVAL],
      team({
        ...IDLE,
        acme: {
          status: { ...status('waiting', 'Waiting for your OK'), room: LAUNCH },
          pendingApprovals: 1,
        },
      })
    ),
  },
  {
    id: 'agents-room-who',
    title: 'Rooms — no lead and nobody mentioned: “Who should answer?”',
    looksRightWhen:
      'Month end (Finance and Lead Gen, no Chief). The typed message names nobody, so instead of sending, a quiet box above the composer asks “Who should answer?” with Finance and Lead Gen (each with its badge), Everyone, and Cancel. The message is still in the field.',
    requires: '.agent-room__ask',
    openSelector: AGENTS_TAB,
    steps: [
      openRoom(OPS),
      { fill: '.agent-composer__input', value: 'Anything still overdue?' },
      { click: '.agent-composer__send' },
    ],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-mention',
    title: 'Rooms — @ offers the room’s members and @everyone',
    looksRightWhen:
      'The mention menu above the composer lists only the four members (Chief of Staff, Acme Site, Finance, Social Posts) and “everyone · All 4 in this room”, nobody else on the team. The foot line under the field is empty until a name is picked.',
    requires: '.agent-room .agent-mention-menu',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH), { fill: '.agent-composer__input', value: '@' }],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-to',
    title: 'Rooms — the foot line says who will answer before you send',
    looksRightWhen:
      'In Pricing launch with “@Finance @Social Posts can you two line up the launch email?” typed: the composer’s foot line reads “To Finance and Social Posts”. Nothing else changes.',
    requires: '.agent-room__address',
    openSelector: AGENTS_TAB,
    steps: [
      openRoom(LAUNCH),
      {
        fill: '.agent-composer__input',
        value: '@Finance @Social Posts can you two line up the launch email?',
      },
    ],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-new',
    title: 'Rooms — New room: pick two to six agents',
    looksRightWhen:
      'A dialog titled “New room”: one line saying what a room is, a Name field whose placeholder is the members’ names (“Chief of Staff & Finance” once those two are ticked), “Members · 2 of 6”, the team as a list of rows with a checkbox, badge, name and muted role, then “When nobody is mentioned” with Ask me · Chief of Staff · Finance (Chief of Staff selected). Cancel and Create room right-aligned.',
    requires: '.agent-room-editor__members',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '.agents-list__new-room' },
      { click: '.agent-room-editor__members li:nth-child(1) .checkbox__input' },
      { click: '.agent-room-editor__members li:nth-child(4) .checkbox__input' },
    ],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-fold',
    title: 'Rooms — a member’s own chat folds what it said in a room',
    looksRightWhen:
      'Acme Site’s own chat: its own exchange about mobile, then one quiet centred line “2 replies in Pricing launch” with the room’s name as a link (an icon before it), not the room’s messages in full.',
    requires: '.agent-room-fold',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: roomCommands(THREAD),
  },
];
