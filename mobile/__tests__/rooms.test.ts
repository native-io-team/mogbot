import type { AgentMessage, RoomView, WelcomeFrame } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import {
  answerers,
  askingNames,
  chatKeysOf,
  EVERYONE,
  foldRoomLines,
  mentionsEveryone,
  roomItems,
  roomKey,
  roomLine,
  workingHere,
  roomsOffered,
  roomSuggestions,
  toLine,
} from '../src/lib/rooms';
import { addPending, applyEvent, confirmSend, emptySync } from '../src/lib/sync';
import { chatItems } from '../src/lib/timeline';
import { agent, msg } from './helpers';

// The Mac's own room and thread, as `cargo test --lib companion::fixtures` serialized them.
const room = real.roomsList[0] as RoomView;
const thread = real.roomsMessages.messages as AgentMessage[];
const finance = agent({ id: 'a1', name: 'Finance', color: 'green' });
const ops = agent({ id: 'a2', name: 'Ops', color: 'blue', isMain: false });
const members = [finance, ops];

const welcome = (features?: string[], methods = ['rooms.list', 'rooms.send']) =>
  ({ methods, ...(features ? { features } : {}) }) as unknown as WelcomeFrame;

describe('rooms are only offered by a Mac that does them', () => {
  it('needs the feature and the methods', () => {
    expect(roomsOffered(welcome(['rooms']))).toBe(true);
    expect(roomsOffered(welcome())).toBe(false);
    expect(roomsOffered(welcome(['results.revise']))).toBe(false);
    expect(roomsOffered(welcome(['rooms'], ['agents.send']))).toBe(false);
    expect(roomsOffered(null)).toBe(false);
  });
});

describe('who answers', () => {
  it('is whoever was named, in the room’s order', () => {
    expect(answerers(room, ['a2', 'a1'], false)).toEqual(['a1', 'a2']);
    expect(answerers(room, ['a2', 'not-a-member'], false)).toEqual(['a2']);
  });

  it('is everyone for @everyone', () => {
    expect(answerers(room, [], true)).toEqual(room.members);
  });

  it('is the lead when nobody is named, and nobody (ask) without one', () => {
    expect(room.lead).toBeUndefined();
    expect(answerers(room, [], false)).toBe('ask');
    expect(answerers({ ...room, lead: 'a2' }, [], false)).toEqual(['a2']);
    // A lead who left the room is no lead.
    expect(answerers({ ...room, lead: 'gone' }, [], false)).toBe('ask');
  });

  it('reads @everyone as a whole word only', () => {
    expect(mentionsEveryone('@everyone status?')).toBe(true);
    expect(mentionsEveryone('hi @Everyone')).toBe(true);
    expect(mentionsEveryone('mail@everyone.com')).toBe(false);
    expect(mentionsEveryone('@everyones')).toBe(false);
  });
});

describe('the composer’s @ menu', () => {
  it('offers the room’s members and everyone, nobody else', () => {
    expect(roomSuggestions(members, '').map((a) => a.name)).toEqual(['Finance', 'Ops', 'everyone']);
    expect(roomSuggestions(members, 'o').map((a) => a.id)).toEqual(['a2']);
    expect(roomSuggestions(members, 'ev')).toEqual([EVERYONE]);
    expect(roomSuggestions(members, null)).toEqual([]);
  });

  it('says who a message was for', () => {
    const asked = [
      { id: 'a1', name: 'Finance' },
      { id: 'a2', name: 'Ops' },
    ];
    expect(toLine(asked.slice(1), 2)).toBe('To Ops');
    expect(toLine(asked, 3)).toBe('To Finance and Ops');
    expect(toLine(asked, 2)).toBe('To everyone');
    expect(toLine([...asked, { id: 'a3', name: 'Chief' }], 3)).toBe('To everyone');
    expect(toLine(undefined, 2)).toBeNull();
  });
});

describe('a room’s lines in the store', () => {
  it('puts a member’s line in the room and its own chat, the room’s own lines in the room only', () => {
    const [yours, reply] = thread;
    expect(chatKeysOf(yours)).toEqual([roomKey(room.id)]);
    expect(chatKeysOf(reply)).toEqual([roomKey(room.id), 'a1']);
    // A line in an agent's own chat is in its conversation's too (lib/conversations).
    expect(chatKeysOf(msg('x', 1))).toEqual(['a', 'a#conversation:first']);
    let s = emptySync();
    s = applyEvent(s, { type: 'agents.message', message: yours });
    s = applyEvent(s, { type: 'agents.message', message: reply });
    expect(s.chats[roomKey(room.id)].messages.map((m) => m.id)).toEqual(['rm1', 'rm2']);
    expect(s.chats.a1.messages.map((m) => m.id)).toEqual(['rm2']);
    expect(s.chats['']).toBeUndefined();
  });

  it('keeps the rooms list from rooms.changed', () => {
    const s = applyEvent(emptySync(), { type: 'rooms.changed', rooms: [room] });
    expect(s.rooms).toEqual([room]);
  });

  it('settles a room send by its clientId, in the room', () => {
    const key = roomKey(room.id);
    let s = addPending(emptySync(), {
      clientId: 'c1',
      agentId: key,
      roomId: room.id,
      text: 'Status?',
      ts: 1,
      failed: false,
      everyone: true,
    });
    const confirmed: AgentMessage = { ...thread[0], id: 'rm9', clientId: 'c1' };
    s = applyEvent(s, { type: 'agents.message', message: confirmed });
    expect(s.pending[key]).toEqual([]);
    // The response after its event changes nothing more.
    const again = confirmSend(s, 'c1', confirmed);
    expect(again.chats[key].messages.filter((m) => m.id === 'rm9')).toHaveLength(1);
  });
});

describe('the room’s list', () => {
  it('names each member over its first line in a run, and never over yours or the room’s notes', () => {
    const items = roomItems(room.id, members, thread, [], {}, thread[4].ts + 1000);
    const lines = items.filter((i) => i.kind === 'message');
    const speaker = Object.fromEntries(lines.map((i) => [i.key, i.speaker]));
    expect(speaker).toEqual({ rm1: false, rm2: true, rm3: true, rm4: false, rm5: false });
  });

  it('shows each member replying here (its draft, or its working line), and nobody replying elsewhere', () => {
    const here = {
      ...ops,
      status: { state: 'working' as const, activity: 'Thinking', since: 1, room: room.id },
    };
    const elsewhere = {
      ...finance,
      status: { state: 'working' as const, activity: 'Thinking', since: 1, room: 'other' },
    };
    let items = roomItems(room.id, [elsewhere, here], thread, [], {});
    expect(items[0]).toMatchObject({ kind: 'working', agentId: 'a2' });
    expect(items.some((i) => i.kind === 'working' && i.agentId === 'a1')).toBe(false);
    items = roomItems(room.id, [elsewhere, here], thread, [], { a2: { id: 'd1', text: 'Fil' } });
    expect(items[0]).toMatchObject({ kind: 'draft', agentId: 'a2', text: 'Fil' });
  });

  it('says what the room’s row says: a card first, then who is replying, then the newest line', () => {
    expect(roomLine(room, members, thread)).toBe('Needs your OK');
    const answered = thread.map((m) =>
      m.approval ? { ...m, approval: { ...m.approval, status: 'allowed' as const } } : m
    );
    expect(roomLine(room, members, answered)).toBe('Ops: Filed.');
    const busy = [
      { ...ops, status: { state: 'working' as const, activity: null, since: 1, room: room.id } },
    ];
    expect(roomLine(room, busy, answered)).toBe('Ops is replying');
  });

  it('a member stopped on a card in this room needs you, before anyone replying, card loaded or not', () => {
    const waiting = {
      ...ops,
      status: { state: 'waiting' as const, activity: null, since: 1, room: room.id },
    };
    const working = {
      ...finance,
      status: { state: 'working' as const, activity: null, since: 1, room: room.id },
    };
    expect(roomLine(room, [working, waiting], undefined)).toBe('Needs your OK');
    expect(workingHere([working, waiting], room.id).map((a) => a.id)).toEqual([working.id]);
    // Waiting in another room or its own chat: not this room's.
    const away = { ...waiting, status: { ...waiting.status, room: 'other' } };
    expect(roomLine(room, [away], [])).not.toBe('Needs your OK');
  });

  it('names who is waiting beside the pill: stopped here, or a card still open in the thread', () => {
    const waiting = {
      ...ops,
      status: { state: 'waiting' as const, activity: null, since: 1, room: room.id },
    };
    expect(askingNames(room, [finance, waiting], undefined)).toBe(ops.name);
    // The card is loaded but the member's status hasn't caught up.
    expect(askingNames(room, [finance, ops], thread)).toBe(ops.name);
    const away = { ...waiting, status: { ...waiting.status, room: 'other' } };
    expect(askingNames(room, [away], [])).toBe('');
  });
});

describe('an agent’s own chat', () => {
  it('folds what it said in a room into one line, leaving a card waiting on you whole', () => {
    const own = [
      msg('d1', 1),
      { ...thread[1], agentId: 'a', ts: 2 },
      { ...thread[3], agentId: 'a', ts: 3 },
      { ...thread[2], agentId: 'a', ts: 4 },
      msg('d2', 5),
    ];
    const folded = foldRoomLines(own);
    expect(folded.map((r) => ('count' in r ? `room×${r.count}` : r.id))).toEqual([
      'd1',
      'room×2',
      'rm3',
      'd2',
    ]);
    const items = chatItems(agent({ id: 'a' }), own, [], undefined, 10_000);
    expect(items.filter((i) => i.kind === 'room')).toHaveLength(1);
  });

  it('streams a room reply in the room, not here', () => {
    const busy = agent({
      id: 'a',
      status: { state: 'working', activity: 'Thinking', since: 1, room: room.id },
    });
    const items = chatItems(busy, [msg('d1', 1)], [], { id: 'r', text: 'Hel' });
    expect(items[0].kind).toBe('working');
  });
});
