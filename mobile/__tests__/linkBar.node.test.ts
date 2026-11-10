/**
 * The connection bar's words (`linkBar`) and the transport's two signs that
 * the app on the Mac is stuck rather than the Mac out of reach: a request
 * that times out while the heartbeat still comes, and a socket that opens
 * and says nothing. A fake socket and fake timers, as in reconnect.node.test.
 */

import type { LinkState } from '@shipstudio/companion-protocol';
import { CALM_MS, linkBar, pill, STUCK_CHECKS } from '../src/lib/connection';
import { DirectTransport, connectTimeoutMs } from '../src/lib/transport';

jest.mock('../src/lib/identity', () => ({
  ...jest.requireActual<object>('../src/lib/identity'),
  checkMac: () => 'ok',
}));

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  welcome() {
    this.open();
    this.say({ t: 'identity', serverId: 'mac', hosts: ['mac'], identity: 'x' });
    this.say({ t: 'welcome', protocol: 2, resume: 'snapshot', methods: [], features: [] });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

function make() {
  const t = new DirectTransport({
    routes: [{ kind: 'tailscale' as const, url: 'https://mac' }],
    token: 'tok',
    app: { version: '1', runtimeVersion: 'test' },
    getResume: () => undefined,
    foreground: true,
    requestTimeoutMs: 5000,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    pinned: { fingerprint: 'f', serverId: 'mac' },
    challenge: () => 'c',
    probe: () => Promise.resolve(200),
  });
  return t;
}

const bar = (link: LinkState, now: number, extra: object = {}) =>
  linkBar({ link, phoneOnline: true, syncedAt: 0, ...extra } as never, now);

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeSocket.all = [];
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the connection bar', () => {
  const now = 1_000_000;

  it('says nothing while connected and answering, or for a refusal (its card says it)', () => {
    expect(bar({ kind: 'connected', route: 'tailscale', since: 0 }, now)).toBeNull();
    expect(bar({ kind: 'refused', reason: 'revoked' }, now)).toBeNull();
  });

  it('reconnecting is calm, says when it last heard, and that the list is the saved copy', () => {
    const b = bar(
      { kind: 'reconnecting', lastSeenAt: now - 3000, nextTryAt: now + 1000, since: now - 3000 },
      now
    );
    expect(b).toMatchObject({
      kind: 'connecting',
      tone: 'busy',
      title: 'Reconnecting to your Mac…',
    });
    expect(b?.detail).toMatch(/^Last heard from it .* · showing what was saved$/);
  });

  it('still reconnecting a minute in: calm words, with when it last heard', () => {
    const b = bar(
      {
        kind: 'reconnecting',
        lastSeenAt: now - 60_000,
        nextTryAt: now + 1000,
        since: now - 60_000,
      },
      now
    );
    expect(b).toMatchObject({ kind: 'connecting', title: 'Reconnecting to your Mac…' });
    expect(b?.detail).toMatch(/1 min ago/);
  });

  it('down for a while, nothing answered: can’t reach it, the likely causes, none of them your fault', () => {
    const b = bar(
      {
        kind: 'reconnecting',
        lastSeenAt: now - 3 * 60_000,
        nextTryAt: now + 1000,
        since: now - 3 * 60_000,
      },
      now
    );
    expect(b).toMatchObject({
      kind: 'unreachable',
      tone: 'problem',
      title: 'Can’t reach your Mac',
    });
    expect(b?.checks.join(' ')).toMatch(/asleep or shut/);
    expect(b?.checks.join(' ')).toMatch(/Tailscale may be off/);
    expect(b?.checks.join(' ')).not.toMatch(/you (forgot|didn’t|did not)/i);
  });

  it('something answered but the app didn’t: the app isn’t responding, restart it', () => {
    const b = bar(
      {
        kind: 'reconnecting',
        lastSeenAt: now - CALM_MS - 5000,
        nextTryAt: now + 1000,
        since: now - CALM_MS - 5000,
        appStuck: true,
      },
      now
    );
    expect(b).toMatchObject({ kind: 'stuck', title: 'The app on your Mac isn’t responding' });
    expect(b?.detail).toMatch(/^Your Mac is reachable/);
    expect(b?.checks).toEqual(STUCK_CHECKS);
  });

  it('connected with a request unanswered: stuck, and the pill agrees', () => {
    const link: LinkState = {
      kind: 'connected',
      route: 'tailscale',
      since: 0,
      stuck: now - 40_000,
    };
    expect(bar(link, now)).toMatchObject({ kind: 'stuck', tone: 'problem' });
    expect(pill({ link, phoneOnline: true } as never, now)).toEqual({
      tone: 'problem',
      label: 'Mac not responding',
    });
  });

  it('this phone offline is said as this phone’s, not the Mac’s', () => {
    const b = bar({ kind: 'connecting', attempt: 3, since: now - 60_000 }, now, {
      phoneOnline: false,
    });
    expect(b).toMatchObject({ kind: 'offline', title: 'This phone is offline' });
  });

  it('the Mac’s app closing reads as waiting for it', () => {
    const b = bar(
      {
        kind: 'reconnecting',
        lastSeenAt: now - 20_000,
        nextTryAt: now + 1000,
        since: now - 20_000,
        macClosing: true,
      },
      now
    );
    expect(b).toMatchObject({ kind: 'closing', title: 'Waiting for the app on your Mac' });
  });
});

describe('telling a stuck app from a Mac out of reach', () => {
  it('a request that times out while the heartbeat still comes marks the link stuck, and an answer clears it', async () => {
    const t = make();
    last().welcome();
    const slow = t.request('agents.overview' as never, {} as never).catch(() => 'timed out');
    jest.advanceTimersByTime(4000);
    last().say({ t: 'pong' });
    jest.advanceTimersByTime(1500);
    await expect(slow).resolves.toBe('timed out');
    expect(t.state.kind).toBe('connected');
    expect(t.state).toHaveProperty('stuck');
    const next = t.request('agents.overview' as never, {} as never);
    const reqs = last().sent.filter((f) => f.t === 'req') as unknown as { id: number }[];
    last().say({ t: 'res', id: reqs[reqs.length - 1].id, ok: true, result: {} });
    await next;
    expect(t.state).not.toHaveProperty('stuck');
    t.close();
  });

  it('a socket that opens and stays silent reconnects as the app stuck; one that never opens doesn’t', () => {
    const t = make();
    last().welcome();
    last().drop();
    expect(t.state).toMatchObject({ kind: 'reconnecting' });
    expect(t.state).not.toHaveProperty('appStuck');
    // The next try: taken, then nothing.
    jest.advanceTimersByTime(1100);
    last().open();
    jest.advanceTimersByTime(connectTimeoutMs(1) + 100);
    expect(t.state).toMatchObject({ kind: 'reconnecting', appStuck: true });
    t.close();
  });
});
