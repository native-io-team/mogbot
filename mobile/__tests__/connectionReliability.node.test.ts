/**
 * The link after pairing, under the conditions real phones meet
 * (docs/design/connection-reliability-2026-11-10.md): a slow link, the
 * phone's Tailscale on another account, the Mac's Keychain locked, the Mac
 * too busy to answer a send, hours in the background. A fake socket and fake
 * timers, so every wait is exact.
 */

import { type LinkState } from '@shipstudio/companion-protocol';
import { linkBar, MAC_SAID, pill } from '../src/lib/connection';
import { retryWaitMs, unreached } from '../src/lib/outbox';
import {
  BACKGROUND_BACKOFF_MS,
  DirectTransport,
  FOREGROUND_BACKOFF_MS,
  OTHER_ACCOUNT_RETRY_MS,
  PROBE_MS,
  WireFailure,
  connectTimeoutMs,
  probeWaitMs,
  tryBudgetMs,
} from '../src/lib/transport';

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
  prove() {
    this.say({ t: 'identity', serverId: 'mac', hosts: ['mac'], identity: 'x' });
  }
  welcome() {
    this.say({ t: 'welcome', protocol: 2, resume: 'snapshot', methods: [], features: [] });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];
const tick = (ms: number) => jest.advanceTimersByTime(ms);

function make(foreground = true) {
  const states: LinkState[] = [];
  const t = new DirectTransport({
    routes: [{ kind: 'tailscale', url: 'https://mac' }],
    token: 'tok',
    app: { version: '1', runtimeVersion: 'test' },
    getResume: () => undefined,
    foreground,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    pinned: { fingerprint: 'f', serverId: 'mac' },
    challenge: () => 'c',
    probe: () => Promise.resolve(200),
  });
  t.onState((s) => states.push(s));
  return { t, states };
}

/**
 * One handshake over a link with `rtt` ms round trips: TCP, TLS and the
 * upgrade before the socket opens (three), then challenge → identity and
 * hello → welcome (two more).
 */
function slowHandshake(rtt: number) {
  // The try in flight (a second try may start beside it: `SECOND_TRY_MS`).
  const ws = last();
  tick(3 * rtt);
  if (ws.readyState === 3) return false;
  ws.open();
  tick(rtt);
  if (ws.readyState === 3) return false;
  ws.prove();
  tick(rtt);
  if (ws.readyState === 3) return false;
  ws.welcome();
  return true;
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeSocket.all = [];
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('a slow link (seconds of latency)', () => {
  it.each([2000, 4000, 5000])(
    'connects on the first try with %i ms round trips (the old 8 s gave each try up first)',
    (rtt) => {
      const { t } = make();
      // Opening is three round trips: 12 s at 4 s, past the old 8 s.
      expect(slowHandshake(rtt)).toBe(true);
      expect(t.state.kind).toBe('connected');
      // The first socket is the one kept; a second try started beside it was let go.
      expect(FakeSocket.all.filter((s) => s.readyState !== 3)).toEqual([FakeSocket.all[0]]);
      t.close();
    }
  );

  it('remembers how slow the link was: the next try gets twice as long', () => {
    const { t } = make();
    expect(slowHandshake(4000)).toBe(true);
    // Socket to welcome took 20 s here; a reconnect gets 40 s before opening.
    expect(tryBudgetMs(0, 20_000)).toBe(40_000);
    // The kept socket is the first (the second try beside it was let go).
    FakeSocket.all[0].drop();
    tick(FOREGROUND_BACKOFF_MS[0]);
    expect(FakeSocket.all).toHaveLength(3);
    // Worse now: 30 s to open still isn't given up (a second try races it from 3 s).
    tick(30_000);
    expect(FakeSocket.all[2].readyState).toBe(0);
    expect(last().readyState).toBe(0);
    expect(FakeSocket.all).toHaveLength(4);
    last().open();
    last().prove();
    last().welcome();
    expect(t.state.kind).toBe('connected');
    t.close();
  });

  it('a route that never opens is still given up, and never waits past a minute', () => {
    const { t } = make();
    tick(connectTimeoutMs(0));
    tick(FOREGROUND_BACKOFF_MS[0]);
    // The first try, the second beside it, then the retry.
    expect(FakeSocket.all).toHaveLength(3);
    expect(FakeSocket.all.filter((s) => s.readyState !== 3)).toHaveLength(1);
    expect(tryBudgetMs(0, 10 * 60_000)).toBe(60_000);
    t.close();
  });

  it('coming forward on a slow link waits three round trips for the probe, not 4 s', () => {
    const { t } = make(false);
    last().open();
    last().prove();
    last().welcome();
    // A ping that took 3 s to come back.
    tick(15_000);
    tick(3000);
    last().say({ t: 'pong' });
    expect(t.latencyMs).toBe(3000);
    expect(probeWaitMs(t.latencyMs)).toBe(9000);
    t.setForeground(true);
    tick(PROBE_MS + 2000);
    expect(t.state.kind).toBe('connected');
    last().say({ t: 'pong' });
    expect(FakeSocket.all).toHaveLength(1);
    t.close();
  });

  it('a fast link still notices a dead socket in 4 s', () => {
    expect(probeWaitMs(null)).toBe(PROBE_MS);
    expect(probeWaitMs(80)).toBe(PROBE_MS);
    expect(probeWaitMs(60_000)).toBe(15_000);
  });
});

describe('the Mac answers and turns the phone away for a while', () => {
  const refuse = (reason: string, message = 'x') => {
    last().say({ t: 'refused', reason, message });
    last().drop(1000);
  };

  it('Tailscale on another account: keeps trying, says so, and the fix is not "pair again"', () => {
    const { t } = make();
    last().open();
    last().prove();
    expect(last().sent.find((f) => f.t === 'hello')?.features).toContain('refused.otherAccount');
    refuse('other_account');
    expect(t.state.kind).toBe('connecting');
    expect(t.state).toMatchObject({ macSaid: 'other_account' });
    const s = { link: t.state, phoneOnline: true } as never;
    expect(pill(s).label).toBe('Other Tailscale account');
    const bar = linkBar(s)!;
    expect(bar.title).toBe(MAC_SAID.other_account.title);
    expect(bar.checks.join(' ')).toMatch(/switch to the account/);
    expect(bar.checks.join(' ')).not.toMatch(/pair again/i);
    // Not a refusal for good: it tries again by itself, at a calm pace…
    tick(OTHER_ACCOUNT_RETRY_MS - 1);
    expect(FakeSocket.all).toHaveLength(1);
    tick(1);
    expect(FakeSocket.all).toHaveLength(2);
    // …and at once when the user switches back and returns to the app.
    refuse('other_account');
    t.setForeground(false);
    t.setForeground(true);
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    last().prove();
    last().welcome();
    expect(t.state.kind).toBe('connected');
    expect(linkBar({ link: t.state, phoneOnline: true } as never)).toBeNull();
    t.close();
  });

  it('the Mac’s Keychain locked: says that, keeps trying, clears on the next welcome', () => {
    const { t } = make();
    last().open();
    last().prove();
    last().welcome();
    last().drop();
    tick(FOREGROUND_BACKOFF_MS[0]);
    last().open();
    refuse('unavailable');
    expect(t.state).toMatchObject({ kind: 'reconnecting', macSaid: 'unavailable' });
    const bar = linkBar({ link: t.state, phoneOnline: true } as never)!;
    expect(bar.kind).toBe('unavailable');
    expect(bar.title).toMatch(/Keychain/);
    tick(FOREGROUND_BACKOFF_MS[1]);
    last().open();
    last().prove();
    last().welcome();
    last().drop();
    expect(t.state).not.toHaveProperty('macSaid');
    t.close();
  });
});

describe('hours in the background', () => {
  it('backs off to a minute while away, then tries at once and at the quick pace when opened', () => {
    const { t } = make(false);
    last().open();
    last().prove();
    last().welcome();
    last().drop();
    // Hours of an unreachable Mac in the background: the waits grow to a minute.
    for (const wait of BACKGROUND_BACKOFF_MS) {
      tick(wait);
      last().drop();
    }
    const before = FakeSocket.all.length;
    tick(BACKGROUND_BACKOFF_MS.at(-1)! - 1);
    expect(FakeSocket.all.length).toBe(before);
    // Opened: a try now, then the foreground's 1 s.
    t.setForeground(true);
    expect(FakeSocket.all.length).toBe(before + 1);
    last().drop();
    tick(FOREGROUND_BACKOFF_MS[0]);
    expect(FakeSocket.all.length).toBe(before + 2);
    // And it reads as calm again, not "can't reach", for its first seconds.
    expect(pill({ link: t.state, phoneOnline: true } as never).tone).toBe('busy');
    t.close();
  });
});

describe('a send the Mac may or may not have taken', () => {
  const failure = (error: ConstructorParameters<typeof WireFailure>[0]) => new WireFailure(error);

  it('is tried again (same clientId) when the Mac was too busy to answer, or rate-limited', () => {
    expect(
      unreached(
        failure({
          type: 'Other',
          message: "Your Mac is busy and couldn't answer that in time. Try again in a moment.",
          expected: true,
        })
      )
    ).toBe(true);
    expect(
      unreached(
        failure({ type: 'Other', message: 'This Mac hit a fault answering that. Try again.' })
      )
    ).toBe(true);
    expect(
      unreached(failure({ type: 'Protocol', code: 'rate_limited', message: 'Slow down' }))
    ).toBe(true);
    expect(unreached(failure({ type: 'Timeout', cmd: 'agents.send', secs: 30 }))).toBe(true);
    expect(unreached(failure({ type: 'Protocol', code: 'not_connected', message: '' }))).toBe(true);
  });

  it('a real refusal is still final', () => {
    expect(unreached(failure({ type: 'Protocol', code: 'refused', message: 'no' }))).toBe(false);
    expect(
      unreached(failure({ type: 'Validation', field: 'agentId', reason: 'No such agent' }))
    ).toBe(false);
    expect(unreached(failure({ type: 'Other', message: 'You can attach up to 10 files.' }))).toBe(
      false
    );
    expect(unreached(new Error('x'))).toBe(false);
  });

  it('a request in flight when the Mac restarts fails at once as not connected, never hangs', async () => {
    const { t } = make();
    last().open();
    last().prove();
    last().welcome();
    const sent = t.request('agents.send', { agentId: 'a', text: 'hi', clientId: 'c1' });
    last().drop(1001);
    await expect(sent).rejects.toMatchObject({ error: { code: 'not_connected' } });
    expect(unreached(await sent.catch((e: unknown) => e))).toBe(true);
    t.close();
  });

  it('waits a few seconds, then longer, while the link stays up', () => {
    expect([0, 1, 2, 3, 9].map(retryWaitMs)).toEqual([3000, 8000, 20_000, 30_000, 30_000]);
  });
});
