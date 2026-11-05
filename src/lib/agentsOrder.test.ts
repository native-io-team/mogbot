import { describe, expect, it } from 'vitest';
import type { Agent } from './agents';
import { sortByAttention, stableOrder } from './agentsOrder';

const a = (id: string, over: Partial<Agent> & { state?: string } = {}): Agent => {
  const { state = 'idle', ...rest } = over;
  return {
    id,
    name: id,
    pinned: false,
    hidden: false,
    pendingApprovals: 0,
    lastActivityAt: 0,
    status: { state },
    ...rest,
  } as unknown as Agent;
};

const ids = (list: Agent[]) => list.map((x) => x.id);

describe('sortByAttention', () => {
  it('waiting on you, then working, then recent activity', () => {
    const team = [
      a('recent', { lastActivityAt: 90 }),
      a('older', { lastActivityAt: 10 }),
      a('working', { state: 'working', lastActivityAt: 5 }),
      a('card', { pendingApprovals: 2, lastActivityAt: 1 }),
      a('waiting', { state: 'waiting', lastActivityAt: 2 }),
    ];
    expect(ids(sortByAttention(team))).toEqual(['waiting', 'card', 'working', 'recent', 'older']);
  });

  it('keeps pinned agents on top, sorted the same way among themselves', () => {
    const team = [
      a('needs', { pendingApprovals: 1, lastActivityAt: 50 }),
      a('pinIdle', { pinned: true, lastActivityAt: 99 }),
      a('pinWorking', { pinned: true, state: 'working', lastActivityAt: 1 }),
    ];
    expect(ids(sortByAttention(team))).toEqual(['pinWorking', 'pinIdle', 'needs']);
  });

  it('counts a failed turn as needing you, but not a usage limit', () => {
    const team = [
      a('limit', { failure: { kind: 'usage_limit' }, lastActivityAt: 9 } as Partial<Agent>),
      a('failed', { failure: { kind: 'other' }, lastActivityAt: 1 } as Partial<Agent>),
      a('fresh', { lastActivityAt: 5 }),
    ];
    expect(ids(sortByAttention(team))).toEqual(['failed', 'limit', 'fresh']);
  });

  it('breaks ties by id, so equal agents never swap', () => {
    expect(ids(sortByAttention([a('b'), a('a'), a('c')]))).toEqual(['a', 'b', 'c']);
  });
});

describe('stableOrder', () => {
  const team = [
    a('x', { lastActivityAt: 3 }),
    a('y', { lastActivityAt: 2 }),
    a('z', { lastActivityAt: 1 }),
  ];

  it('sorts when settled, or the first time', () => {
    expect(stableOrder([], team, false)).toEqual(['x', 'y', 'z']);
    expect(stableOrder(['z', 'y', 'x'], team, true)).toEqual(['x', 'y', 'z']);
  });

  it('holds the order while in use, even when an agent starts waiting on you', () => {
    const next = [team[0], team[1], a('z', { pendingApprovals: 1, lastActivityAt: 1 })];
    expect(stableOrder(['x', 'y', 'z'], next, false)).toEqual(['x', 'y', 'z']);
    expect(stableOrder(['x', 'y', 'z'], next, true)).toEqual(['z', 'x', 'y']);
  });

  it('while in use, drops agents that are gone and adds new ones at the end', () => {
    const next = [team[0], team[2], a('new', { lastActivityAt: 99 })];
    expect(stableOrder(['x', 'y', 'z'], next, false)).toEqual(['x', 'z', 'new']);
  });
});
