/** A batch leaves the state exactly as the same events one by one. */
import type {
  AgentMessage,
  AgentsOverview,
  CompanionEvent,
  Cursor,
} from '@shipstudio/companion-protocol';
import {
  applyEvent,
  applyEvents,
  applySafely,
  emptySync,
  type Arrived,
  type HeldCursor,
  type SyncState,
} from '../src/lib/sync';

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  role: '',
  color: 'blue',
  status: { state: 'idle', activity: null, since: null },
  pendingApprovals: 0,
  unread: 0,
  lastActivityAt: 1,
  checkIns: [],
  ...over,
});
const overview = (...agents: unknown[]) => ({ agents, engines: [] }) as unknown as AgentsOverview;
const msg = (id: string, agentId: string, ts: number, text = id, extra = {}) =>
  ({ id, agentId, ts, kind: 'agent', text, ...extra }) as AgentMessage;

const start = (): SyncState => ({
  ...emptySync(),
  overview: overview(agent('a'), agent('b')),
  cursor: { epoch: 'e', seq: 5 },
  chats: {
    a: { messages: [msg('a1', 'a', 10), msg('a2', 'a', 20)], more: true, loaded: true },
  },
  seqs: { a1: 3, a2: 5 },
  drafts: { b: { id: 'b9', text: 'half' } },
  pending: {
    a: [{ clientId: 'c1', agentId: 'a', text: 'hi', ts: 1, failed: false }],
  },
});

const oneByOne = (s: SyncState, list: Arrived[]) =>
  list.reduce((st, x) => applyEvent(st, x.event, x.cursor), s);

const at = (seq: number): Cursor => ({ epoch: 'e', seq });
const e = (event: unknown, seq?: number): Arrived => ({
  event: event as CompanionEvent,
  ...(seq ? { cursor: at(seq) } : {}),
});

describe('applyEvents', () => {
  it('is what applying them in turn gives', () => {
    const list = [
      e({ type: 'agents.message', message: msg('a3', 'a', 30) }, 6),
      e(
        {
          type: 'agents.status',
          agentId: 'a',
          status: { state: 'working', activity: 'x', since: 1 },
        },
        7
      ),
      e({ type: 'agents.message', message: msg('b9', 'b', 31, 'done') }, 8),
      // An edited line, a moved one, one older than what is held, and your own.
      e({ type: 'agents.message', message: msg('a3', 'a', 30, 'edited') }, 9),
      e({ type: 'agents.message', message: msg('a1', 'a', 35, 'moved') }, 10),
      e({ type: 'agents.message', message: msg('a2', 'a', 20, 'stale') }, 4),
      e(
        {
          type: 'agents.message',
          message: { ...msg('u1', 'a', 40, 'hi'), kind: 'user', clientId: 'c1' },
        },
        11
      ),
      e({ type: 'agents.draft', agentId: 'b', id: 'b10', from: 0, text: 'Hel' }),
      e({ type: 'agents.draft', agentId: 'b', id: 'b10', from: 3, text: 'lo' }),
      e({ type: 'agents.message', message: msg('b10', 'b', 50, 'Hello') }, 12),
      e({ type: 'agents.draft', agentId: 'b', id: 'b10', from: 0, text: 'late' }),
      e({ type: 'projects.changed', project: { path: '/p', name: 'p', sessions: [] } }, 13),
      e({ type: 'agents.message', message: 'not a message' }, 14),
      e({ type: 'agents.message', message: msg('n1', 'new', 1) }, 15),
    ];
    const a = applyEvents(start(), list);
    const b = oneByOne(start(), list);
    expect(a).toEqual(b);
    expect(a.cursor).toEqual(at(15));
    expect(a.chats.a.messages.map((m) => m.text)).toEqual(['a2', 'edited', 'moved', 'hi']);
    expect(a.pending.a).toEqual([]);
    expect(a.drafts).toEqual({});
  });

  it('holds across a snapshot in the middle', () => {
    const list = [
      e({ type: 'agents.message', message: msg('a3', 'a', 30) }, 6),
      e({
        type: 'sync.snapshot',
        cursor: { epoch: 'f', seq: 1 },
        overview: overview(agent('a')),
        status: {},
        projects: [],
      }),
      {
        event: { type: 'agents.message', message: msg('a4', 'a', 40) } as CompanionEvent,
        cursor: { epoch: 'f', seq: 2 },
      },
    ];
    expect(applyEvents(start(), list)).toEqual(oneByOne(start(), list));
  });

  it('many random batches come out the same', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    for (let round = 0; round < 60; round++) {
      const list: Arrived[] = [];
      for (let i = 0; i < 40; i++) {
        const id = ['a', 'b', 'c'][rnd(3)];
        list.push(
          rnd(4) === 0
            ? e(
                {
                  type: 'agents.status',
                  agentId: id,
                  status: { state: 'working', activity: `${i}`, since: i },
                },
                6 + i
              )
            : e(
                {
                  type: 'agents.message',
                  message: msg(`${id}${rnd(12)}`, id, 10 + rnd(30), `t${i}`),
                },
                rnd(5) ? 6 + i : 1 + rnd(5)
              )
        );
      }
      const a = applyEvents(start(), list);
      const b = oneByOne(start(), list);
      // The cursor within a batch is the last event's either way; the rows are what matter.
      expect({ ...a, cursor: null }).toEqual({ ...b, cursor: null });
    }
  });

  it('an untouched chat and an unchanged agent keep their objects', () => {
    const s = {
      ...start(),
      chats: { ...start().chats, z: { messages: [], more: false, loaded: true } },
    };
    const out = applyEvents(s, [
      e({ type: 'agents.message', message: msg('a3', 'a', 30) }, 6),
      e({ type: 'agents.message', message: msg('a4', 'a', 31) }, 7),
    ]);
    expect(out.chats.z).toBe(s.chats.z);
    expect(out.overview).toBe(s.overview);
  });
});

describe('applySafely', () => {
  /** An event the code trips on. */
  const bad = (seq?: number) =>
    e(
      {
        type: 'agents.registry',
        get overview() {
          throw new Error(`bad ${seq}`);
        },
      },
      seq
    );
  const line = (n: number) => e({ type: 'agents.message', message: msg(`m${n}`, 'a', 100 + n) }, n);
  const run = (list: Arrived[], s = start(), held: HeldCursor | null = null) => {
    const reported: string[] = [];
    const out = applySafely(s, list, held, (x) => reported.push((x as Error).message));
    return { ...out, reported, ids: out.state.chats.a.messages.map((m) => m.id) };
  };

  it('nothing wrong: exactly what applyEvents gives', () => {
    const list = [line(6), line(7), line(8)];
    const out = run(list);
    expect(out.state).toEqual(applyEvents(start(), list));
    expect(out.held).toBeNull();
    expect(out.reported).toEqual([]);
  });

  it('skips and reports only the bad one, and the cursor stays before it', () => {
    const out = run([line(6), line(7), bad(8), line(9), line(10)]);
    expect(out.ids).toEqual(['a1', 'a2', 'm6', 'm7', 'm9', 'm10']);
    expect(out.reported).toEqual(['bad 8']);
    expect(out.state.cursor).toEqual(at(7));
  });

  it('1,180 lines missed with two bad ones among them: 1,178 land, each bad one reported once', () => {
    const list = Array.from({ length: 1180 }, (_, i) => line(6 + i));
    list[400] = bad(406);
    list[900] = bad(906);
    const out = run(list);
    expect(out.ids).toHaveLength(2 + 1178);
    expect(out.reported).toEqual(['bad 406', 'bad 906']);
    expect(out.state.cursor).toEqual(at(405));
  });

  it('keeps it there over the batches after, caught up included, until a snapshot', () => {
    const first = run([bad(6), line(7)]);
    expect(first.state.cursor).toEqual(at(5));
    const next = run(
      [line(8), e({ type: 'sync.caughtUp', cursor: at(8) })],
      first.state,
      first.held
    );
    expect(next.state.cursor).toEqual(at(5));
    expect(next.ids).toContain('m8');
    const whole = run(
      [
        e({
          type: 'sync.snapshot',
          cursor: at(20),
          overview: overview(agent('a')),
          status: {},
          projects: [],
        }),
        line(21),
      ],
      next.state,
      next.held
    );
    expect(whole.held).toBeNull();
    expect(whole.state.cursor).toEqual(at(21));
  });

  it('replayed from there, nothing doubles', () => {
    const first = run([line(6), bad(7), line(8)]);
    const again = run([line(7), line(8)], first.state);
    expect(again.ids).toEqual(['a1', 'a2', 'm6', 'm7', 'm8']);
    expect(again.state.cursor).toEqual(at(8));
  });

  it('one that moves no cursor (a draft, an alert) holds nothing', () => {
    const out = run([line(6), bad(), line(7)]);
    expect(out.state.cursor).toEqual(at(7));
    expect(out.held).toBeNull();
  });

  it('a snapshot that can’t be applied is never passed, even into its new epoch', () => {
    const out = run([
      e({
        type: 'sync.snapshot',
        get overview() {
          throw new Error('bad snapshot');
        },
      }),
      {
        event: { type: 'agents.message', message: msg('x', 'a', 200) } as CompanionEvent,
        cursor: { epoch: 'f', seq: 3 },
      },
    ]);
    expect(out.reported).toEqual(['bad snapshot']);
    expect(out.state.cursor).toEqual(at(5));
    expect(out.ids).toContain('x');
  });
});
