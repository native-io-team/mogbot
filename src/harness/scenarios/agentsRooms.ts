/**
 * Rooms (`agents/rooms.rs`, components/agents/RoomChat.tsx): group
 * conversations with two to six agents. A thread where three agents answer
 * @everyone and hand off to each other, an approval card inside it, the
 * "Who should answer?" ask, the mention menu with @everyone, the New room
 * dialog, and the one line a member's own chat shows for its room replies.
 * Also the states that are slow to reach for real: an empty room, one left
 * with too few members, stopped replies, a dozen rooms, the members editor
 * with six agents, the room's menu, and a room's card in What's in flight.
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
const openRoomMenu = { click: '.agent-room .agent-chat__menu button' };

/** No Chief, nothing said yet. */
const EMPTY_ROOM = room({
  id: 'empty',
  name: 'Weekly review',
  members: ['chief', 'finance', 'leadgen', 'hiring'],
  lead: 'chief',
  preview: undefined,
});

/** Its other members were deleted: one left. */
const SOLO_ROOM = room({
  id: 'solo',
  name: 'Month end',
  members: ['finance'],
  preview: 'Finance: Both invoices are chased.',
});

const SOLO_THREAD = [
  msg('user', 'Can you chase Northwind?', 10, {
    agentId: '',
    room: 'solo',
    mentions: [{ id: 'finance', name: 'Finance' }],
  }),
  msg('agent', 'Chased. Northwind says Friday.', 8, { agentId: 'finance', room: 'solo' }),
];

/** A round that was stopped: the room's own note, a member's, and the cap. */
const STOPPED_THREAD = [
  THREAD[0],
  msg('agent', 'On track. Acme is finishing the table.', 9, inRoom('chief')),
  msg('note', 'Finance was stopped before answering.', 8, inRoom('')),
  msg('note', 'Acme Site stopped before finishing its reply.', 7, inRoom('acme')),
  msg('note', 'Nobody else will be asked: this message reached 8 replies.', 6, inRoom('')),
];

const MANY_NAMES = [
  'Pricing launch',
  'Month end',
  'Hiring loop Q4',
  'Board deck',
  'Acme relaunch',
  'Social calendar',
  'Investor update',
  'Support triage',
  'Native release 42',
  'Ops weekly',
  'Legal review',
  'Partnerships',
];
const MANY_SETS = [
  ['chief', 'acme', 'finance', 'social'],
  ['finance', 'leadgen'],
  ['chief', 'hiring'],
  ['chief', 'finance', 'acme', 'social', 'leadgen', 'hiring'],
  ['acme', 'social'],
  ['social', 'chief', 'leadgen'],
];
const MANY_ROOMS = MANY_NAMES.map((name, i) => {
  const members = MANY_SETS[i % MANY_SETS.length];
  return room({
    id: i === 0 ? LAUNCH : `r${i}`,
    name,
    members,
    lead: members.includes('chief') ? 'chief' : undefined,
    preview: 'Finance: Both invoices are chased and the board deck numbers are in.',
    unread: i % 3 === 0 && i > 0 ? 2 : 0,
    muted: i === 4,
    lastActivityAt: now - i * 60 * MIN,
  });
});

/** Acme waiting on a card raised in the room; its own recent lines don't hold it. */
const APPROVAL_TEAM = () =>
  team({
    ...IDLE,
    acme: {
      status: { ...status('waiting', 'Waiting for your OK'), room: LAUNCH },
      pendingApprovals: 1,
    },
  });

export const agentsRoomsScenarios: Scenario[] = [
  {
    id: 'agents-room-thread',
    title: 'Rooms — four agents in one thread, @everyone and a hand-off',
    looksRightWhen:
      'Sidebar: right after the agents (above “Hidden”), a quiet “Rooms” label and two rows, each with its own outlined badge of the room’s initials (“PL”, “ME”), the open one selected; Pricing launch is one line, Month end shows its unread preview and dot. Header: three member badges and “+1”, “Pricing launch” and a muted “Chief of Staff, Acme Site, Finance and Social Posts · Chief of Staff answers unless you @ someone”, no agent colour on the header or the send button (neutral). Your two messages are right-aligned bubbles with a muted “To everyone” / “To Acme Site” under each. Each agent’s run opens with its mini badge and name in its own colour (Acme green, Finance orange, Social red, Chief neutral), then its prose. Acme’s first reply has the folded “Worked … · 3 steps” line and its @Finance tinted. Lead Gen is not in the room and appears nowhere.',
    requires: '.agent-room .agent-room__speaker-name',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH)],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-working',
    title: 'Rooms — two members replying at once, one waiting',
    looksRightWhen:
      'Same thread. Under the last message, at the thread’s usual gap, Finance and Social Posts each have their name in their colour over one set of typing dots and what they’re doing (“Reading invoices.csv”, “Thinking”), no ⋯ beside them; then a quiet centred “Chief of Staff will reply after what it’s doing now”, then a muted “3 of 8 replies for this message”. The sidebar row says “2 are replying…” with the loader. With nothing typed the composer’s send button is a Stop square; a paperclip and a mic sit in the composer as in a 1:1 chat.',
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
      'The mention menu above the composer lists only the four members (Chief of Staff, Acme Site, Finance, Social Posts) and “Everyone · All 4 in this room” with a group glyph (no initials), nobody else on the team. The foot line under the field is empty until a name is picked.',
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
    id: 'agents-room-empty',
    title: 'Rooms — a new room with nothing said yet',
    looksRightWhen:
      'Weekly review open, empty. Header and body agree: three member badges and “+1”. The body says “Talk to everyone here at once. Chief of Staff answers unless you @ someone; @everyone asks all 4.”, then “Each agent keeps its own memory, and remembers what it says here in its own chat too.”, then @Chief of Staff · @Finance · @Lead Gen · @Hiring · @everyone chips. In the sidebar the row is one line with an outlined “WR” badge.',
    requires: '.agent-room__empty',
    openSelector: AGENTS_TAB,
    steps: [openRoom('empty')],
    commands: roomCommands(THREAD, team(IDLE), [EMPTY_ROOM, OPS_ROOM]),
  },
  {
    id: 'agents-room-too-few',
    title: 'Rooms — only one member left',
    looksRightWhen:
      'Month end with just Finance. Above the composer a bar with a group icon (no bullet dot): “Only Finance is left in this room” / “A room needs two members. Add someone, or delete it.” with Delete room and Add members (neutral). The composer’s placeholder is “Message Finance”. Your message says “To Finance” under it.',
    requires: '[data-testid="room-too-few"]',
    openSelector: AGENTS_TAB,
    steps: [openRoom('solo')],
    commands: {
      ...roomCommands(THREAD, team(IDLE), [SOLO_ROOM]),
      agents_room_messages: () => SOLO_THREAD,
    },
  },
  {
    id: 'agents-room-stopped',
    title: 'Rooms — replies stopped part-way, drawn one way',
    looksRightWhen:
      'After the Chief’s reply, three quiet centred lines in the same style: “Finance was stopped before answering.”, “Acme Site stopped before finishing its reply.” (each name in its own colour, no speaker header repeating it), and “Nobody else will be asked: this message reached 8 replies.”. Your @everyone message says “To everyone”.',
    requires: '.agent-room__member-note',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH)],
    commands: roomCommands(STOPPED_THREAD),
  },
  {
    id: 'agents-rooms-many',
    title: 'Rooms — a dozen rooms in the sidebar',
    looksRightWhen:
      'The Rooms section sits right after the agents, above “Hidden”. Each room is its own outlined initials badge (PL, ME, HL, BD, AR, SC, IU…), so Pricing launch and Investor update (same members) still look different. Rooms with nothing unread are one line; those with unread (Board deck, Native release 42, Partnerships) show one line of preview and a dot. Acme relaunch has the muted bell. New room under New agent is the same left-aligned row with its icon in the badge column.',
    requires: '.agents-list__row--room',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH)],
    commands: roomCommands(THREAD, team(IDLE), MANY_ROOMS),
  },
  {
    id: 'agents-room-menu',
    title: 'Rooms — the room’s ⋯ menu while members are replying',
    looksRightWhen:
      'The header’s ⋯ menu is open: Members and name…, Mute, Stop replies here, a divider, then Delete room… in danger red. Behind it the working rows and the Stop button in the composer.',
    requires: '.agent-model-menu [role="menuitem"]',
    openSelector: AGENTS_TAB,
    steps: [openRoom(LAUNCH), openRoomMenu],
    commands: roomCommands(
      THREAD,
      team({
        ...IDLE,
        finance: { status: { ...status('working', 'Reading invoices.csv'), room: LAUNCH } },
      })
    ),
  },
  {
    id: 'agents-room-members',
    title: 'Rooms — Members and name, six agents in',
    looksRightWhen:
      'The “Members and name” dialog over Pricing launch with Lead Gen and Hiring also ticked: “Members · 6 of 6”, the rest of the team disabled. “When nobody is mentioned” is one menu button reading “Chief of Staff” (not a segmented row wrapping onto two lines). The intro line has readable leading. Name field shows “Pricing launch”.',
    requires: '.agent-room-editor__lead-select',
    openSelector: AGENTS_TAB,
    steps: [
      openRoom(LAUNCH),
      openRoomMenu,
      { click: '.ss-dropdown__item', text: 'Members and name' },
      { click: '.agent-room-editor__members li:nth-child(5) .checkbox__input' },
      { click: '.agent-room-editor__members li:nth-child(6) .checkbox__input' },
    ],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-room-new-six',
    title: 'Rooms — New room with six members: the default name stays short',
    looksRightWhen:
      'New room with six agents ticked: the Name placeholder reads “Chief of Staff & 5 others”, not every name in a sentence; the lead is one menu button.',
    requires: '.agent-room-editor__lead-select',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '.agents-list__new-room' },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        click: `.agent-room-editor__members li:nth-child(${n}) .checkbox__input`,
      })),
    ],
    commands: roomCommands(THREAD),
  },
  {
    id: 'agents-team-room-approval',
    title: 'Rooms — What’s in flight answers a room’s card in place',
    looksRightWhen:
      'What’s in flight, Needs your OK: Acme Site’s row says “in Pricing launch” after its name and “Needs your OK”, with its Allow / Deny card for “Push to GitHub” under it (compact, answerable here). Recent replies credit room replies “in Pricing launch”; clicking one opens the room, not Acme’s own chat.',
    requires: '.agents-team .agent-approval',
    openSelector: AGENTS_TAB,
    steps: [{ click: '.agents-list__needs-you' }],
    commands: {
      ...roomCommands([...THREAD, APPROVAL], APPROVAL_TEAM()),
      // Acme's own recent lines (the overview's fixture) don't hold the card:
      // it comes from the room's thread.
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_OWN : messagesFor(args),
    },
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
