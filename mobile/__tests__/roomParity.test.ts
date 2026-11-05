/**
 * A room on the phone says and offers what the desk's does: a member's open
 * copy keeps Keep / Discard, who answers is worded the desk's way, a member's
 * @mention of another is found by whole name, and the room never claims its
 * agents see only what's said there.
 */

import type { AgentMessage } from '@shipstudio/companion-protocol';
import {
  addressLine,
  foldRoomLines,
  liveCopyCards,
  ROOM_INTRO,
  splitMentions,
} from '../src/lib/rooms';
import { agent } from './helpers';

const finance = agent({ id: 'a1', name: 'Finance', color: 'green' });
const ops = agent({ id: 'a2', name: 'Ops', color: 'blue', isMain: false });
const members = [finance, ops];

const copyCard = (id: string, agentId: string, copyId: string): AgentMessage =>
  ({
    id,
    agentId,
    room: 'r',
    ts: 1,
    kind: 'changes',
    text: '',
    changes: { project: '/p', files: [], fileCount: 1, added: 1, removed: 0, copy: { id: copyId } },
  }) as unknown as AgentMessage;

describe('room parity with the desk', () => {
  it('gives each member’s open copy its newest card here, and nobody else’s', () => {
    const withCopy = { ...finance, copy: { id: 'c1' } } as never;
    const lines = [
      copyCard('m1', 'a1', 'c1'),
      copyCard('m2', 'a1', 'c1'),
      copyCard('m3', 'a2', 'c9'),
    ];
    expect([...liveCopyCards([withCopy, ops], lines)]).toEqual(['m2']);
  });

  it('keeps the open copy’s card whole in the agent’s own chat', () => {
    const folded = foldRoomLines([copyCard('m1', 'a1', 'c1')], 'c1');
    expect(folded).toHaveLength(1);
    expect('count' in folded[0]).toBe(false);
    expect('count' in foldRoomLines([copyCard('m1', 'a1', 'c1')])[0]).toBe(true);
  });

  it('says who will answer in the desk’s words', () => {
    const r = { members: ['a1', 'a2'], lead: 'a1' };
    expect(addressLine(r, members, [], false)).toBe('To Finance · @ someone else, or @everyone');
    expect(addressLine(r, members, ['a2'], false)).toBe('To Ops');
    expect(addressLine(r, members, ['a1', 'a2'], false)).toBe('To Finance and Ops');
    expect(addressLine(r, members, [], true)).toBe('To everyone · 2 replies');
    expect(addressLine({ members: ['a1', 'a2'] }, members, [], false)).toBe(
      'Who should answer? @ someone'
    );
  });

  it('finds a member’s @mention by whole name, never inside an address or a longer word', () => {
    expect(splitMentions('@Ops can you file it?', ['Ops', 'Finance'])).toEqual([
      { text: '@Ops', name: 'Ops' },
      { text: ' can you file it?' },
    ]);
    expect(splitMentions('mail ops@Ops.com or @Opsy', ['Ops'])).toEqual([
      { text: 'mail ops@Ops.com or @Opsy' },
    ]);
    expect(splitMentions('ask @Chief of Staff', ['Chief', 'Chief of Staff'])[1]).toEqual({
      text: '@Chief of Staff',
      name: 'Chief of Staff',
    });
  });

  it('never says a room’s agents see only the room', () => {
    expect(ROOM_INTRO).not.toMatch(/only what/);
    expect(ROOM_INTRO).toMatch(/remembers its own chat/);
    expect(ROOM_INTRO).toMatch(/posted for everyone/);
  });
});
