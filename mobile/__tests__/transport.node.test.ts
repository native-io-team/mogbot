/**
 * The app's real transport and sync rules against the mock Mac: a streamed
 * turn, an approval, and a socket dropped mid-turn, an app restart on the Mac,
 * and a retried send. Nothing may be missed or doubled.
 */

import type { CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until, provenBy } from './helpers';
import { applyEvent, emptySync, mergePage, type SyncState } from '../src/lib/sync';
import { DirectTransport } from '../src/lib/transport';

jest.setTimeout(20_000);

describe('DirectTransport against the mock Mac', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 15 });
  let url = '';
  let transport: DirectTransport;
  let state: SyncState;
  let caughtUp = 0;
  const events: CompanionEvent[] = [];

  beforeAll(async () => {
    url = await mock.listen();
    const { token } = mock.issueToken();
    state = emptySync();
    transport = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    transport.onEvent((event: CompanionEvent, cursor?: Cursor) => {
      events.push(event);
      state = applyEvent(state, event, cursor);
      if (event.type === 'sync.caughtUp') caughtUp++;
    });
  });

  afterAll(async () => {
    transport.close();
    await mock.close();
  });

  const chat = (id: string) => state.chats[id]?.messages ?? [];
  const ids = (id: string) => chat(id).map((m) => m.id);
  const unique = (list: string[]) => new Set(list).size === list.length;

  it('connects with a snapshot on a cold start', async () => {
    await until(() => caughtUp === 1);
    expect(transport.welcome?.resume).toBe('snapshot');
    expect(state.overview?.agents.length).toBeGreaterThan(0);
    expect(state.cursor?.epoch).toBeTruthy();
  });

  it('pages history with `before` and reports when there is no more', async () => {
    const latest = await transport.request('agents.messages', { agentId: 'chief', limit: 50 });
    state = mergePage(state, 'chief', latest, false);
    expect(chat('chief')).toHaveLength(50);
    let more = latest.more;
    while (more) {
      const page = await transport.request('agents.messages', {
        agentId: 'chief',
        limit: 50,
        before: chat('chief')[0].id,
      });
      state = mergePage(state, 'chief', page, true);
      more = page.more;
    }
    expect(chat('chief')).toHaveLength(mock.messages('chief').length);
    expect(unique(ids('chief'))).toBe(true);
  });

  it('streams a reply through drafts that survive a dropped socket mid-turn', async () => {
    state = mergePage(
      state,
      'site',
      await transport.request('agents.messages', { agentId: 'site' }),
      false
    );
    const sent = await transport.request('agents.send', {
      agentId: 'site',
      text: 'Tighten the hero copy',
      clientId: 'c-1',
    });
    await until(() => (state.drafts.site?.text.length ?? 0) > 40);
    mock.dropAll();
    await until(() => transport.state.kind === 'reconnecting');
    await until(() => transport.state.kind === 'connected');
    expect(transport.welcome?.resume).toBe('replay');
    await until(() => state.overview?.agents.find((a) => a.id === 'site')?.status.state === 'idle');
    const truth = mock.messages('site').map((m) => m.id);
    expect(ids('site')).toEqual(truth); // nothing missed, nothing doubled
    expect(state.drafts.site).toBeUndefined();
    expect(chat('site').at(-1)?.text).toBe(mock.messages('site').at(-1)?.text);

    // A send retried with the same clientId returns the original.
    const again = await transport.request('agents.send', {
      agentId: 'site',
      text: 'Tighten the hero copy',
      clientId: 'c-1',
    });
    expect(again.id).toBe(sent.id);
    expect(
      mock.messages('site').filter((m) => m.kind === 'user' && m.text === 'Tighten the hero copy')
    ).toHaveLength(1);
  });

  it('answers an approval and upserts the card in place', async () => {
    await transport.request('agents.send', { agentId: 'qa', text: 'Deploy it', clientId: 'c-2' });
    await until(() => chat('qa').some((m) => m.approval?.status === 'pending'));
    const card = chat('qa').find((m) => m.approval)!;
    await transport.request('agents.answerApproval', {
      agentId: 'qa',
      requestId: card.approval!.requestId,
      allow: true,
      always: true,
    });
    await until(() => state.overview?.agents.find((a) => a.id === 'qa')?.status.state === 'idle');
    const cards = chat('qa').filter((m) => m.id === card.id);
    expect(cards).toHaveLength(1);
    expect(cards[0].approval?.status).toBe('allowed');
    expect(cards[0].approval?.alwaysAllowed).toBe(true);
  });

  it('falls back to a snapshot after the Mac restarts, then re-fetches', async () => {
    mock.restartJournal();
    mock.dropAll();
    const before = caughtUp;
    await until(() => caughtUp > before);
    expect(transport.welcome?.resume).toBe('snapshot');
    expect(state.chats.site.loaded).toBe(false);
    const page = await transport.request('agents.messages', { agentId: 'site', limit: 50 });
    state = mergePage(state, 'site', page, false);
    expect(ids('site')).toEqual(mock.messages('site').map((m) => m.id));
  });

  it('is refused for good once the device is removed', async () => {
    await transport.request('devices.unpairSelf', {});
    await until(() => transport.state.kind === 'refused');
    expect(transport.state).toEqual({ kind: 'refused', reason: 'revoked' });
  });
});

describe('DirectTransport when the Mac moves', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
  afterAll(() => mock.close());

  it('stops trying a dead address and connects on the new one at once', async () => {
    const url = await mock.listen();
    const { token } = mock.issueToken();
    const t = new DirectTransport({
      // Nothing listens here: the old address after a rename.
      routes: [{ kind: 'tailscale', url: 'ws://127.0.0.1:9/v1/ws' }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    try {
      // Let the first try be refused (node's ws throws on closing a socket mid-open; React Native's doesn't).
      await new Promise((r) => setTimeout(r, 300));
      t.setRoutes([{ kind: 'tailscale', url }]);
      await until(() => t.state.kind === 'connected');
      expect(t.route.url).toBe(url);
    } finally {
      t.close();
    }
  });
});

describe('DirectTransport coming back from the background', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
  afterAll(() => mock.close());

  it('opens a new socket at once after a long time away, and keeps a trail of why', async () => {
    const url = await mock.listen();
    const { token } = mock.issueToken();
    const t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    const realNow = Date.now;
    try {
      await until(() => t.state.kind === 'connected');
      t.setForeground(false);
      // A minute away: iOS would have suspended the app by now.
      const back = realNow() + 60_000;
      Date.now = () => back;
      const startedAt = realNow();
      t.setForeground(true);
      expect(t.state.kind).toBe('reconnecting');
      Date.now = realNow;
      await until(() => t.state.kind === 'connected');
      // No 4 s probe wait or backoff first.
      expect(realNow() - startedAt).toBeLessThan(3000);
      const trail = t.recentTrail().map((e) => e.what);
      expect(trail).toContain('background');
      expect(trail.some((w) => w.startsWith('fresh socket after 60s away'))).toBe(true);
      expect(trail.filter((w) => w.startsWith('welcome via tailscale')).length).toBe(2);
    } finally {
      Date.now = realNow;
      t.close();
    }
  });
});

describe('DirectTransport when the first try goes nowhere', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
  afterAll(() => mock.close());

  it('gets through on a second try a few seconds in, not after the first one times out', async () => {
    const url = await mock.listen();
    const { token } = mock.issueToken();
    let made = 0;
    // The first socket is one whose packets go nowhere (Tailscale on the
    // phone still waking): it never opens, closes or errors.
    class FirstGoesNowhere {
      constructor(u: string) {
        made++;
        if (made === 1) {
          return {
            readyState: 0,
            send() {},
            close() {},
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
          } as unknown as FirstGoesNowhere;
        }
        return new WebSocket(u) as unknown as FirstGoesNowhere;
      }
    }
    const started = Date.now();
    const t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: FirstGoesNowhere as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    try {
      await until(() => t.state.kind === 'connected', 10_000);
      expect(made).toBe(2);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      t.close();
    }
  });
});
