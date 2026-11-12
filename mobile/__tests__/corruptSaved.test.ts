/**
 * What the phone keeps (its pairing, the forget queue, the offline copy)
 * and what a Mac of another version sends (the overview, rooms, projects)
 * can be damaged or of another shape. None of it may take the app down:
 * a damaged pairing is removed and the phone asks to pair again; anything
 * else is made safe to draw, or left as it was.
 */

import type { AgentsOverview, CompanionEvent } from '@shipstudio/companion-protocol';
import { fromCache } from '../src/lib/cache';
import { readForgets } from '../src/lib/forgets';
import { asCredentials, readCredentials } from '../src/lib/pairing';
import { applyEvent, emptySync } from '../src/lib/sync';
import { asOverview, asProjects, asRooms } from '../src/lib/wellFormed';
import { agent } from './helpers';

const good = {
  serverId: 'srv_1',
  name: 'Julian’s Mac',
  routes: [{ kind: 'tailscale', url: 'https://mac.tail1.ts.net:47443' }],
  deviceId: 'dev_1',
  token: 'tok',
  secretKey: 'sk',
  pairedAt: 1,
  fingerprint: 'fp',
};

describe('the saved pairing', () => {
  it('reads a good one, and nothing as nothing', () => {
    expect(readCredentials(JSON.stringify(good))).toEqual({ kind: 'paired', credentials: good });
    expect(readCredentials(null)).toEqual({ kind: 'none' });
    expect(readCredentials('')).toEqual({ kind: 'none' });
  });

  it('calls anything unreadable damaged, never throws', () => {
    for (const raw of [
      '{"serverId":',
      'not json',
      'null',
      '[]',
      '42',
      '"a string"',
      JSON.stringify({ ...good, token: 7 }),
      JSON.stringify({ ...good, serverId: '' }),
      JSON.stringify({ ...good, routes: 'https://mac' }),
      JSON.stringify({ ...good, routes: [null, 3] }),
      JSON.stringify({ ...good, fingerprint: {} }),
    ]) {
      expect(readCredentials(raw)).toEqual({ kind: 'damaged' });
    }
  });

  it('fills what it can do without and drops routes that aren’t', () => {
    const c = asCredentials({
      ...good,
      name: 5,
      pairedAt: 'x',
      secretKey: undefined,
      routes: [null, ...good.routes, { kind: 'tailscale' }],
    });
    expect(c).toMatchObject({
      name: 'Your computer',
      pairedAt: 0,
      secretKey: '',
      routes: good.routes,
    });
  });
});

describe('the forget queue', () => {
  it('starts empty from what isn’t a list, and says it was damaged', () => {
    expect(readForgets('{oops', asCredentials)).toEqual({ list: [], damaged: true });
    expect(readForgets('{"a":1}', asCredentials)).toEqual({ list: [], damaged: true });
    expect(readForgets(null, asCredentials)).toEqual({ list: [], damaged: false });
  });

  it('keeps the readable entries and drops the rest', () => {
    const raw = JSON.stringify([good, { serverId: 'x' }, 'junk']);
    expect(readForgets(raw, asCredentials)).toEqual({ list: [good], damaged: true });
    expect(readForgets(JSON.stringify([good]), asCredentials)).toEqual({
      list: [good],
      damaged: false,
    });
  });
});

describe('the overview, rooms and projects', () => {
  it('make an overview safe: agents not a list, bad rows, odd fields', () => {
    expect(asOverview(null)).toBeNull();
    expect(asOverview([])).toBeNull();
    expect(asOverview({ agents: 'nope' })?.agents).toEqual([]);
    const o = asOverview({
      agents: [
        null,
        { name: 'no id' },
        { id: 'a1', name: 3, unread: 'x', status: 'busy', checkIns: {}, failure: 'x' },
      ],
      engines: 'x',
    })!;
    expect(o.engines).toEqual([]);
    expect(o.agents).toHaveLength(1);
    const a = o.agents[0];
    expect(a).toMatchObject({ id: 'a1', name: '3', unread: 0, isMain: false, preview: null });
    expect(a.status).toEqual({ state: 'idle', activity: null, since: null });
    expect(a.checkIns).toBeUndefined();
    expect(a.failure).toBeUndefined();
  });

  it('keep a good overview as it was', () => {
    const real: AgentsOverview = { agents: [agent()], engineReady: true, engines: [] };
    expect(asOverview(real)).toEqual(real);
  });

  it('make rooms and projects safe', () => {
    expect(asRooms('x')).toBeNull();
    expect(asRooms([null, { id: 'r1', members: 'a', waiting: [1, 'a2'] }])).toEqual([
      expect.objectContaining({ id: 'r1', name: 'Room', members: [], waiting: ['a2'], unread: 0 }),
    ]);
    expect(asProjects({})).toBeNull();
    const [p] = asProjects([
      { name: 'no path' },
      {
        path: '/x/site',
        sessions: [null, { sessionId: 's1', question: { question: 'Go?', options: 'x' } }, {}],
      },
    ])!;
    expect(p).toMatchObject({ path: '/x/site', name: 'site', dirtyFiles: 0 });
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0]).toMatchObject({ sessionId: 's1', state: 'exited', tab: 0 });
    expect(p.sessions[0].question?.options).toEqual([]);
  });
});

describe('events of the wrong shape', () => {
  const ev = (e: unknown) => e as CompanionEvent;

  it('agents.status survives an overview whose agents aren’t a list', () => {
    const s = { ...emptySync(), overview: { agents: null } as unknown as AgentsOverview };
    const status = { state: 'working', activity: null, since: 1 };
    expect(() => applyEvent(s, ev({ type: 'agents.status', agentId: 'a1', status }))).not.toThrow();
    expect(applyEvent(s, ev({ type: 'agents.status', agentId: 'a1', status }))).toBe(s);
  });

  it('agents.status with a broken status marks the agent idle', () => {
    const s = {
      ...emptySync(),
      overview: { agents: [agent({ id: 'a1' })], engineReady: true, engines: [] },
    };
    const next = applyEvent(s, ev({ type: 'agents.status', agentId: 'a1', status: 'x' }));
    expect(next.overview!.agents[0].status.state).toBe('idle');
  });

  it('an unreadable overview, rooms list or project keeps what is shown', () => {
    const overview: AgentsOverview = { agents: [agent()], engineReady: true, engines: [] };
    const s = { ...emptySync(), overview, rooms: [], projects: [] };
    expect(applyEvent(s, ev({ type: 'agents.registry', overview: 'x' })).overview).toBe(overview);
    expect(applyEvent(s, ev({ type: 'rooms.changed', rooms: {} })).rooms).toEqual([]);
    expect(applyEvent(s, ev({ type: 'projects.changed', project: null })).projects).toEqual([]);
    const snap = applyEvent(
      s,
      ev({
        type: 'sync.snapshot',
        overview: { agents: 'x' },
        projects: 'x',
        status: null,
        cursor: { epoch: 'e', seq: 1 },
      })
    );
    expect(snap.overview!.agents).toEqual([]);
    expect(snap.projects).toEqual([]);
  });
});

it('an offline copy of another shape is made safe', () => {
  const back = fromCache({
    v: 1,
    savedAt: 0,
    overview: { agents: { a: 1 } },
    mac: null,
    projects: 'x',
    rooms: [{ id: 'r1' }],
    cursor: null,
    syncedAt: null,
    chats: { a1: { messages: [null, { id: 'm1' }], more: false, loaded: true } },
  } as never)!;
  expect(back.overview!.agents).toEqual([]);
  expect(back.projects).toBeNull();
  expect(back.rooms).toHaveLength(1);
  expect(back.chats!.a1.messages.map((m) => m.id)).toEqual(['m1']);
});
