import { describe, expect, it } from 'vitest';
import {
  addressLine,
  addressed,
  askedLine,
  defaultRoomName,
  roomActivity,
  roomIdOf,
  roomKey,
  type Room,
} from './agentRooms';
import { tintMentionsIn } from '../components/agents/AgentMentions';
import { buildChatItems, type Agent, type AgentMessage } from './agents';

const agent = (id: string, name: string, over: Partial<Agent> = {}) =>
  ({
    id,
    name,
    color: 'blue',
    status: { state: 'idle', activity: null, since: null },
    ...over,
  }) as Agent;

const fin = agent('fin', 'Finance');
const ops = agent('ops', 'Ops');
const opsLead = agent('opsl', 'Ops Lead');
const members = [fin, ops, opsLead];

const room = (over: Partial<Room> = {}): Room => ({
  id: 'r',
  name: 'Month end',
  members: members.map((m) => m.id),
  muted: false,
  createdAt: 0,
  lastActivityAt: 0,
  unread: 0,
  turnsUsed: 0,
  turnCap: 8,
  waiting: [],
  ...over,
});

describe('who a room message is for', () => {
  it('names the mentioned members, longest name first, in the room’s order', () => {
    expect(addressed('@Ops Lead and @Finance, thoughts?', members)).toEqual({
      kind: 'named',
      ids: ['fin', 'opsl'],
    });
    expect(addressed('@ops?', members)).toEqual({ kind: 'named', ids: ['ops'] });
  });

  it('@everyone wins over names', () => {
    expect(addressed('@Finance and @everyone', members)).toEqual({ kind: 'everyone' });
  });

  it('@everyone means everyone even beside an agent named that before it was reserved', () => {
    const named = agent('ev', 'everyone');
    expect(addressed('@everyone wrap up', [fin, named])).toEqual({ kind: 'everyone' });
  });

  it('falls back to the lead, and asks when there is none', () => {
    expect(addressed('Anything overdue?', members, 'fin')).toEqual({ kind: 'lead', id: 'fin' });
    expect(addressed('Anything overdue?', members)).toEqual({ kind: 'ask' });
    // A lead who left the room isn't asked.
    expect(addressed('Anything overdue?', members, 'gone')).toEqual({ kind: 'ask' });
    // An email address isn't a mention.
    expect(addressed('mail ops@example.com', members)).toEqual({ kind: 'ask' });
  });

  it('says who will answer before you send', () => {
    expect(addressLine({ kind: 'named', ids: ['fin', 'ops'] }, members)).toBe('To Finance and Ops');
    expect(addressLine({ kind: 'everyone' }, members)).toBe('To everyone · 3 replies');
    expect(addressLine({ kind: 'lead', id: 'fin' }, members)).toBe(
      'To Finance · @ someone else, or @everyone'
    );
    expect(addressLine({ kind: 'ask' }, members)).toBeNull();
  });
});

describe('a room’s activity', () => {
  it('counts only members answering in this room as working here', () => {
    const busy = [
      agent('fin', 'Finance', {
        status: { state: 'working', activity: 'x', since: 1, room: 'r' },
      }),
      agent('ops', 'Ops', { status: { state: 'working', activity: 'x', since: 1 } }),
      opsLead,
    ];
    const { working, waiting } = roomActivity(room({ waiting: ['ops'] }), busy);
    expect(working.map((a) => a.id)).toEqual(['fin']);
    // Busy in its own chat, asked here: it'll reply after.
    expect(waiting.map((a) => a.id)).toEqual(['ops']);
  });

  it('keeps rooms apart from agent ids in the selection', () => {
    expect(roomIdOf(roomKey('abc'))).toBe('abc');
    expect(roomIdOf('fin')).toBeNull();
    expect(roomIdOf(null)).toBeNull();
  });
});

describe('an agent’s own chat', () => {
  const line = (id: string, over: Partial<AgentMessage>): AgentMessage => ({
    id,
    agentId: 'fin',
    ts: 1000 + Number(id.replace(/\D/g, '')),
    kind: 'agent',
    text: id,
    ...over,
  });

  it('folds a run of room lines into one item, but never a card waiting on you', () => {
    const items = buildChatItems([
      line('m1', { kind: 'user' }),
      line('m2', { room: 'r' }),
      line('m3', { room: 'r' }),
      line('m4', {
        room: 'r',
        kind: 'approval',
        approval: { requestId: 'q', title: 'Run', detail: 'ls', status: 'pending' },
      }),
      line('m5', { room: 'other' }),
      line('m6', {}),
    ]);
    const kinds = items.filter((i) => i.type !== 'day').map((i) => i.type);
    expect(kinds).toEqual(['message', 'room', 'message', 'room', 'message']);
    const first = items.find((i) => i.type === 'room');
    expect(first?.type === 'room' && first.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('keeps its open copy’s card, and lines from a room that is gone, in full', () => {
    const items = buildChatItems(
      [
        line('m1', { room: 'r' }),
        line('m2', { room: 'r', kind: 'changes' }),
        line('m3', { room: 'gone' }),
      ],
      { unfolded: 'm2', folds: (id) => id !== 'gone' }
    );
    const shape = items
      .filter((i) => i.type !== 'day')
      .map((i) => (i.type === 'message' ? i.message.id : i.type));
    expect(shape).toEqual(['room', 'm2', 'm3']);
  });
});

describe('who it was for, under your message', () => {
  const ref = (id: string, name: string) => ({ id, name });
  it('says everyone when every member was asked, whatever the room’s size', () => {
    expect(askedLine([ref('a', 'Finance'), ref('b', 'Ops')], ['a', 'b'])).toBe('To everyone');
    expect(
      askedLine([ref('a', 'A'), ref('b', 'B'), ref('c', 'C'), ref('d', 'D')], ['a', 'b', 'c', 'd'])
    ).toBe('To everyone');
  });
  it('names who was asked otherwise', () => {
    expect(askedLine([ref('a', 'Finance'), ref('b', 'Ops')], ['a', 'b', 'c'])).toBe(
      'To Finance and Ops'
    );
    expect(askedLine([ref('a', 'Finance')], ['a'])).toBe('To Finance');
  });
});

describe('a room’s name before it has one', () => {
  it('lists up to three, then stays short', () => {
    expect(defaultRoomName(['Finance', 'Ops'])).toBe('Finance & Ops');
    expect(defaultRoomName(['Chief of Staff', 'Finance', 'Ops'])).toBe(
      'Chief of Staff, Finance & Ops'
    );
    expect(
      defaultRoomName(['Chief of Staff', 'Acme Site', 'Finance', 'Lead Gen', 'Hiring', 'Social'])
    ).toBe('Chief of Staff & 5 others');
  });
});

describe('a member’s @mentions in its reply', () => {
  const members = [
    { id: 'fin', name: 'Finance', color: 'orange' },
    { id: 'acme', name: 'Acme Site', color: 'green' },
    { id: 'acme2', name: 'Acme', color: 'blue' },
  ];
  const tint = (html: string) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    tintMentionsIn(root, members);
    return [...root.querySelectorAll('.agent-mention')].map(
      (el) => `${el.textContent}:${el.getAttribute('data-color')}`
    );
  };
  it('tints whole member names, longest first', () => {
    expect(tint('<p>@Finance can you check? Then @acme site ships.</p>')).toEqual([
      '@Finance:orange',
      '@acme site:green',
    ]);
  });
  it('leaves emails, partial names, links and code alone', () => {
    expect(tint('<p>mail ops@Finance.com or @Financed</p>')).toEqual([]);
    expect(tint('<p><a href="#">@Finance</a> <code>@Finance</code></p>')).toEqual([]);
  });
});
