/**
 * The app's real transport against the mock Mac, under what real links do:
 * seconds of latency each way, the Mac answering a send as busy after doing
 * it, and Tailscale on the phone switched to another account and back.
 * Nothing may be lost, doubled, or left waiting.
 */

import type { CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until, provenBy } from './helpers';
import { unreached } from '../src/lib/outbox';
import { applyEvent, emptySync, type SyncState } from '../src/lib/sync';
import { DirectTransport } from '../src/lib/transport';

jest.setTimeout(60_000);

/** One way, in ms: a 4 s round trip, as on one bar of signal or a relayed path. */
const ONE_WAY = 2000;

/**
 * A real socket with `ONE_WAY` added to every frame in each direction, and
 * three of them to opening (TCP, TLS and the upgrade are round trips).
 * Frames keep their order: every one waits the same.
 */
class SlowSocket {
  static opened = 0;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private inner: WebSocket;
  constructor(url: string) {
    SlowSocket.opened++;
    this.inner = new WebSocket(url);
    this.inner.onopen = () =>
      setTimeout(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.onopen?.({});
      }, 3 * ONE_WAY);
    this.inner.onmessage = (ev) => setTimeout(() => this.onmessage?.({ data: ev.data }), ONE_WAY);
    this.inner.onclose = (ev) =>
      setTimeout(() => {
        this.readyState = 3;
        this.onclose?.({ code: ev.code });
      }, ONE_WAY);
    this.inner.onerror = () => {};
  }
  send(data: string) {
    setTimeout(() => {
      if (this.inner.readyState === 1) this.inner.send(data);
    }, ONE_WAY);
  }
  close() {
    this.readyState = 3;
    this.inner.close();
  }
}

describe('the transport against the mock Mac on hard links', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 15 });
  let url = '';
  const open: DirectTransport[] = [];

  beforeAll(async () => {
    url = await mock.listen();
  });

  afterAll(async () => {
    open.forEach((t) => t.close());
    await mock.close();
  });

  function connect(WebSocketImpl: unknown) {
    const { token } = mock.issueToken();
    let state: SyncState = emptySync();
    let caughtUp = 0;
    const t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: WebSocketImpl as typeof globalThis.WebSocket,
      requestTimeoutMs: 30_000,
      ...provenBy(mock),
    });
    t.onEvent((event: CompanionEvent, cursor?: Cursor) => {
      state = applyEvent(state, event, cursor);
      if (event.type === 'sync.caughtUp') caughtUp++;
    });
    open.push(t);
    return { t, caughtUp: () => caughtUp };
  }

  const copies = (agentId: string, text: string) =>
    mock.messages(agentId).filter((m) => m.kind === 'user' && m.text === text).length;

  it('connects on its first socket over 4 s round trips, and a send lands once', async () => {
    const started = Date.now();
    const { t, caughtUp } = connect(SlowSocket);
    // Opening (6 s) and the two round trips after (8 s): 14 s, past the old 8 s a try had.
    await until(() => caughtUp() === 1, 30_000);
    // The first socket, plus at most the second try started beside it (`SECOND_TRY_MS`), dropped once the first opened.
    expect(SlowSocket.opened).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(20_000);
    await t.request('agents.send', {
      agentId: 'site',
      text: 'over a slow link',
      clientId: 'slow-1',
    });
    expect(copies('site', 'over a slow link')).toBe(1);
  });

  it('a send the Mac did but answered as busy goes again by its clientId, and lands once', async () => {
    const { t, caughtUp } = connect(WebSocket);
    await until(() => caughtUp() === 1);
    mock.answerSendsBusy(1);
    const params = { agentId: 'site', text: 'busy Mac', clientId: 'busy-1' };
    const first = await t.request('agents.send', params).catch((e: unknown) => e);
    // Not "Not sent": the phone keeps it waiting and tries again.
    expect(unreached(first)).toBe(true);
    expect(copies('site', 'busy Mac')).toBe(1);
    const again = await t.request('agents.send', params);
    expect(again.text).toBe('busy Mac');
    expect(copies('site', 'busy Mac')).toBe(1);
  });

  it('Tailscale on another account keeps trying, and is back by itself when switched back', async () => {
    const { t, caughtUp } = connect(WebSocket);
    await until(() => caughtUp() === 1);
    mock.switchTailnetAccount(true);
    await until(() => 'macSaid' in t.state && t.state.macSaid === 'other_account');
    expect(t.state.kind).toBe('reconnecting');
    expect(t.refusal?.reason).toBe('other_account');
    mock.switchTailnetAccount(false);
    // The user comes back to the app from Tailscale's.
    t.setForeground(false);
    t.setForeground(true);
    await until(() => caughtUp() === 2);
    expect(t.state.kind).toBe('connected');
    expect(t.welcome?.resume).toBe('replay');
  });
});
