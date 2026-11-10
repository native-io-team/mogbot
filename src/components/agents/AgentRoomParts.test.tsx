import { describe, expect, it } from 'vitest';
import type { Agent } from '../../lib/agents';
import type { Room } from '../../lib/agentRooms';
import { roomSubtitle } from './AgentRoomParts';

const room = {
  id: 'r1',
  name: 'Launch',
  members: ['a', 'b'],
  unread: 0,
  waiting: [],
} as unknown as Room;
const member = (id: string, name: string, over: Partial<Agent> = {}) =>
  ({ id, name, status: { state: 'idle' }, pendingApprovals: 0, ...over }) as Agent;

describe('a room row’s line', () => {
  it('names who is waiting on you beside the pill, not in an amber sentence', () => {
    const waiting = member('a', 'Acme Site', {
      status: { state: 'waiting', room: 'r1' },
      pendingApprovals: 1,
    } as Partial<Agent>);
    expect(roomSubtitle(room, [waiting, member('b', 'Finance')])).toEqual({
      text: 'Needs your OK',
      state: 'waiting',
      asking: 'Acme Site',
    });
  });

  it('does not count a member waiting somewhere else', () => {
    const elsewhere = member('a', 'Acme Site', {
      status: { state: 'waiting', room: 'other' },
      pendingApprovals: 1,
    } as Partial<Agent>);
    expect(roomSubtitle(room, [elsewhere]).asking).toBeUndefined();
  });
});
