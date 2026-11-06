import { applyEvent, emptySync } from '../src/lib/sync';
import { shareStructure } from '../src/lib/structure';

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  status: { state: 'idle' },
  tags: ['a', 'b'],
  ...extra,
});

describe('shareStructure', () => {
  it('keeps the previous object where nothing changed', () => {
    const prev = { agents: [agent('a'), agent('b')], engineReady: true };
    const next = JSON.parse(JSON.stringify(prev));
    expect(shareStructure(prev, next)).toBe(prev);
  });

  it('keeps unchanged agents when one of them changed', () => {
    const prev = { agents: [agent('a'), agent('b'), agent('c')] };
    const next = JSON.parse(JSON.stringify(prev));
    next.agents[1].status = { state: 'working' };
    const out = shareStructure(prev, next);
    expect(out).not.toBe(prev);
    expect(out.agents[0]).toBe(prev.agents[0]);
    expect(out.agents[1]).not.toBe(prev.agents[1]);
    expect(out.agents[1].status.state).toBe('working');
    expect(out.agents[2]).toBe(prev.agents[2]);
  });

  it('matches by id when the list is re-ordered', () => {
    const prev = { agents: [agent('a'), agent('b')] };
    const next = { agents: [agent('b'), agent('a')] };
    const out = shareStructure(prev, next);
    expect(out.agents.map((a) => a.id)).toEqual(['b', 'a']);
    expect(out.agents[0]).toBe(prev.agents[1]);
    expect(out.agents[1]).toBe(prev.agents[0]);
  });

  it('takes what is new: added and removed agents, changed shapes, nulls', () => {
    expect(shareStructure(null, { a: 1 })).toEqual({ a: 1 });
    expect(shareStructure({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(shareStructure({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(shareStructure([agent('a')], [])).toEqual([]);
    expect(shareStructure({ a: [1] }, { a: null })).toEqual({ a: null });
  });
});

describe('the registry event', () => {
  it('leaves an agent row its identity when another agent changed', () => {
    const overview = (state: string) =>
      ({ agents: [agent('a'), agent('b', { status: { state } })], engineReady: true }) as never;
    let s = applyEvent(emptySync(), { type: 'agents.registry', overview: overview('idle') });
    const before = s.overview;
    s = applyEvent(s, { type: 'agents.registry', overview: overview('working') });
    expect(s.overview!.agents[0]).toBe(before!.agents[0]);
    expect(s.overview!.agents[1]).not.toBe(before!.agents[1]);
    const again = applyEvent(s, { type: 'agents.registry', overview: overview('working') });
    expect(again.overview).toBe(s.overview);
  });
});
