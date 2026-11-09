import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  __resetAgentsStore,
  getAgentsSnapshot,
  loadMessages,
  loadOlderMessages,
  MESSAGE_PAGE,
  refreshAgents,
  sameJson,
  updateDraft,
  upsertMessage,
} from './agentsStore';
import type { AgentMessage } from './agents';

const reply = (id: string, text: string): AgentMessage => ({
  id,
  agentId: 'a',
  ts: 2,
  kind: 'agent',
  text,
});

describe('streaming drafts', () => {
  afterEach(() => __resetAgentsStore());

  it('grows a draft and keeps the time it started', () => {
    updateDraft('a', 'd1', 'Hel');
    const started = getAgentsSnapshot().drafts.a.ts;
    updateDraft('a', 'd1', 'Hello there');
    expect(getAgentsSnapshot().drafts.a).toMatchObject({
      id: 'd1',
      text: 'Hello there',
      ts: started,
    });
  });

  it('the finished message replaces its draft, even in a chat that is not open', () => {
    updateDraft('a', 'd1', 'Hello');
    upsertMessage(reply('d1', 'Hello there.'));
    expect(getAgentsSnapshot().drafts.a).toBeUndefined();
  });

  it('empty text withdraws that draft (narration folded into the timeline), never another', () => {
    updateDraft('a', 'd1', 'Starting the previews now');
    updateDraft('a', 'other', '');
    expect(getAgentsSnapshot().drafts.a?.id).toBe('d1');
    updateDraft('a', 'd1', '');
    expect(getAgentsSnapshot().drafts.a).toBeUndefined();
    // A withdrawal for a draft never seen leaves no empty bubble behind.
    updateDraft('a', 'd3', '');
    expect(getAgentsSnapshot().drafts.a).toBeUndefined();
  });

  it('a different message leaves the draft alone', () => {
    updateDraft('a', 'd2', 'Next');
    upsertMessage(reply('d1', 'Earlier.'));
    expect(getAgentsSnapshot().drafts.a?.id).toBe('d2');
  });
});

describe('paged history', () => {
  afterEach(() => __resetAgentsStore());

  /** A log of `n` lines served the way `agents_messages` pages it. */
  const serve = (n: number) => {
    const log = Array.from({ length: n }, (_, i) => reply(`m${i}`, `line ${i}`));
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd !== 'agents_messages') return null;
      const { limit, before, through } = args as {
        limit: number;
        before?: string;
        through?: string;
      };
      calls.push(args);
      const end = before ? log.findIndex((m) => m.id === before) : log.length;
      let start = Math.max(0, end - limit);
      const at = through ? log.findIndex((m) => m.id === through) : -1;
      if (at >= 0 && at < start) start = at;
      return log.slice(start, end);
    });
    return calls;
  };
  const ids = () => getAgentsSnapshot().messages.a.map((m) => m.id);

  it('opens on the newest page and loads older ones above it', async () => {
    serve(MESSAGE_PAGE * 2 + 10);
    await loadMessages('a');
    expect(ids()).toHaveLength(MESSAGE_PAGE);
    expect(getAgentsSnapshot().older.a).toBe(true);
    await loadOlderMessages('a');
    expect(ids()).toHaveLength(MESSAGE_PAGE * 2);
    await loadOlderMessages('a');
    expect(ids()[0]).toBe('m0');
    expect(getAgentsSnapshot().older.a).toBe(false);
  });

  it('a search hit loads back to its line in one request, however often it is asked', async () => {
    const calls = serve(MESSAGE_PAGE * 3);
    await loadMessages('a');
    await Promise.all([loadOlderMessages('a', 'm5'), loadOlderMessages('a', 'm5')]);
    expect(ids()[0]).toBe('m5');
    expect(calls).toHaveLength(2);
  });

  it('pages a 5,000-line chat back to its first line, every line once and in order', async () => {
    const calls = serve(5000);
    await loadMessages('a');
    // A line arriving while you read back stays at the foot, not inside a page.
    upsertMessage({ ...reply('live', 'new'), ts: 3 });
    while (getAgentsSnapshot().older.a) await loadOlderMessages('a');
    const got = ids();
    expect(got).toHaveLength(5001);
    expect(got.slice(0, 5000)).toEqual(Array.from({ length: 5000 }, (_, i) => `m${i}`));
    expect(got[5000]).toBe('live');
    // One page per request, newest first: never the whole log at once.
    expect(calls).toHaveLength(Math.ceil(5000 / MESSAGE_PAGE));
    expect(calls.every((c) => (c as { limit: number }).limit === MESSAGE_PAGE)).toBe(true);
  });
});

describe('sameJson', () => {
  it('agrees with comparing JSON.stringify', () => {
    const cases: [unknown, unknown][] = [
      [
        { a: 1, b: [1, { c: 'x' }] },
        { a: 1, b: [1, { c: 'x' }] },
      ],
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [{ a: 1, b: undefined }, { a: 1 }],
      [
        [1, undefined],
        [1, null],
      ],
      [{ a: NaN }, { a: null }],
      [{ a: [1, 2] }, { a: [1, 2, 3] }],
      [{ a: { b: 1 } }, { a: { b: '1' } }],
      [null, {}],
      [[], {}],
    ];
    for (const [a, b] of cases) {
      expect(sameJson(a, b)).toBe(JSON.stringify(a) === JSON.stringify(b));
    }
  });
});

describe('overlapping overview reads', () => {
  afterEach(() => __resetAgentsStore());

  const overview = (name: string) => ({
    agents: [{ id: 'a', name }],
    engineReady: true,
    engines: [],
  });

  it('an older read answering last never puts its older list back', async () => {
    const answers: ((v: unknown) => void)[] = [];
    mockIPC((cmd) => (cmd === 'agents_overview' ? new Promise((r) => answers.push(r)) : null));
    const first = refreshAgents();
    const second = refreshAgents();
    await new Promise((r) => setTimeout(r, 0));
    answers[1](overview('Renamed'));
    await second;
    answers[0](overview('Old name'));
    await first;
    expect(getAgentsSnapshot().agents[0]?.name).toBe('Renamed');
  });

  it('an older read failing after a newer one answered leaves no error', async () => {
    const calls: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    mockIPC((cmd) =>
      cmd === 'agents_overview'
        ? new Promise((resolve, reject) => calls.push({ resolve, reject }))
        : null
    );
    const first = refreshAgents();
    const second = refreshAgents();
    await new Promise((r) => setTimeout(r, 0));
    calls[1].resolve(overview('Fine'));
    await second;
    calls[0].reject('gone');
    await first;
    expect(getAgentsSnapshot().error).toBeNull();
  });
});
