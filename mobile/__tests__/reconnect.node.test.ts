/**
 * Reconnecting is quick and calm: with the app in front the waits never pass
 * 5 s, a try stuck on a dead route is given up, coming forward or a network
 * change tries at once, and the Mac's app saying goodbye reads as waiting.
 * A fake socket and fake timers, so every wait is exact.
 */

import { CLOSE_MAC_CLOSING, type LinkState } from '@shipstudio/companion-protocol';
import { pill, CALM_MS } from '../src/lib/connection';
import {
  BACKGROUND_BACKOFF_MS,
  DirectTransport,
  FOREGROUND_BACKOFF_MS,
  PROBE_MS,
  connectTimeoutMs,
} from '../src/lib/transport';

// The Mac's proof is tested on its own (identity.node.test.ts); here it always checks out.
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
  // ---- the Mac's side ----
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Open, prove, welcome: a live link. */
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

function make(foreground = true, routes = [{ kind: 'tailscale' as const, url: 'https://mac' }]) {
  const states: LinkState[] = [];
  const t = new DirectTransport({
    routes,
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

/** Every wait between tries, until `n` sockets have been made. */
function waits(n: number): number[] {
  const out: number[] = [];
  while (FakeSocket.all.length < n) {
    const before = FakeSocket.all.length;
    last().drop();
    const at = Date.now();
    while (FakeSocket.all.length === before) jest.advanceTimersByTime(10);
    out.push(Date.now() - at);
  }
  return out;
}

const pillFor = (link: LinkState, now: number) => pill({ link, phoneOnline: true } as never, now);

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
  FakeSocket.all = [];
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('reconnecting', () => {
  it('waits 1, 2, 4, then at most 5 s between tries with the app in front', () => {
    const { t } = make(true);
    last().welcome();
    expect(t.state.kind).toBe('connected');
    const got = waits(8);
    expect(got.map((ms) => Math.round(ms / 100) * 100)).toEqual([
      1000, 2000, 4000, 5000, 5000, 5000, 5000,
    ]);
    expect(Math.max(...FOREGROUND_BACKOFF_MS)).toBe(5000);
    t.close();
  });

  it('backs off further in the background, to spare the battery', () => {
    const { t } = make(false);
    last().welcome();
    const got = waits(6);
    expect(got.map((ms) => Math.round(ms / 1000) * 1000)).toEqual(BACKGROUND_BACKOFF_MS);
    t.close();
  });

  it('tries at once when the app comes forward, instead of waiting out a long wait', () => {
    const { t } = make(false);
    last().welcome();
    waits(5); // now waiting 30 s
    const before = FakeSocket.all.length;
    last().drop();
    jest.advanceTimersByTime(100);
    expect(FakeSocket.all.length).toBe(before);
    t.setForeground(true);
    expect(FakeSocket.all.length).toBe(before + 1);
    t.close();
  });

  it('a network change tries at once, but a try that just started is left alone', () => {
    const { t } = make(true);
    last().welcome();
    last().drop();
    jest.advanceTimersByTime(1000); // the retry is in flight
    const n = FakeSocket.all.length;
    t.retryNow();
    expect(FakeSocket.all.length).toBe(n); // too young to give up
    jest.advanceTimersByTime(2000);
    t.retryNow();
    expect(FakeSocket.all.length).toBe(n + 1); // stuck: start over
    t.close();
  });

  it('gives up a try stuck on a dead route and moves to the next one', () => {
    const { t } = make(true, [
      { kind: 'tailscale', url: 'https://mac' },
      { kind: 'lan', url: 'http://192.168.1.2:1' } as never,
    ]);
    expect(last().url).toContain('mac');
    // The first route never answers (packets dropped, no refusal).
    jest.advanceTimersByTime(connectTimeoutMs(0) - 1);
    // The try and the second one beside it, both on the same route.
    expect(FakeSocket.all.length).toBe(2);
    expect(FakeSocket.all[1].url).toContain('mac');
    jest.advanceTimersByTime(1);
    jest.advanceTimersByTime(FOREGROUND_BACKOFF_MS[0]);
    expect(FakeSocket.all.length).toBe(3);
    expect(last().url).toContain('192.168.1.2');
    t.close();
  });

  it('after a working route drops, tries that same route first', () => {
    const { t } = make(true, [
      { kind: 'tailscale', url: 'https://mac' },
      { kind: 'lan', url: 'http://192.168.1.2:1' } as never,
    ]);
    last().welcome();
    last().drop();
    jest.advanceTimersByTime(FOREGROUND_BACKOFF_MS[0]);
    expect(last().url).toContain('wss://mac');
    t.close();
  });

  it('coming forward on a socket that died in the background notices in seconds', () => {
    const { t } = make(false);
    last().welcome();
    t.setForeground(true);
    expect(last().sent.at(-1)).toEqual({ t: 'ping' });
    jest.advanceTimersByTime(PROBE_MS);
    expect(t.state.kind).toBe('reconnecting');
    t.close();
  });

  it('a socket that answers the probe stays up', () => {
    const { t } = make(false);
    last().welcome();
    t.setForeground(true);
    jest.advanceTimersByTime(PROBE_MS - 100);
    last().say({ t: 'pong' });
    jest.advanceTimersByTime(PROBE_MS * 2);
    expect(t.state.kind).toBe('connected');
    t.close();
  });

  it('says "Reconnecting…" for the first 15 s, then when it last heard, then that it can’t reach the Mac', () => {
    const { t } = make(true);
    last().welcome();
    const seen = Date.now();
    last().drop();
    const start = Date.now();
    expect(pillFor(t.state, start)).toEqual({ tone: 'busy', label: 'Reconnecting…' });
    waits(FakeSocket.all.length + 3);
    expect(t.state).toMatchObject({ kind: 'reconnecting', since: start });
    expect(pillFor(t.state, start + CALM_MS - 1).label).toBe('Reconnecting…');
    expect(pillFor(t.state, start + CALM_MS).label).toMatch(/^Reconnecting · last seen/);
    expect(pillFor(t.state, seen + 2 * 60_000 + 1)).toEqual({
      tone: 'problem',
      label: 'Can’t reach Mac',
    });
    t.close();
  });

  it('reads as calm again for 15 s when the app comes forward mid-outage', () => {
    const { t } = make(true);
    last().welcome();
    t.setForeground(false);
    last().drop();
    jest.advanceTimersByTime(10 * 60_000);
    expect(pillFor(t.state, Date.now())).toEqual({ tone: 'problem', label: 'Can’t reach Mac' });
    t.setForeground(true);
    expect(pillFor(t.state, Date.now())).toEqual({ tone: 'busy', label: 'Reconnecting…' });
    expect(pillFor(t.state, Date.now() + CALM_MS + 1)).toEqual({
      tone: 'problem',
      label: 'Can’t reach Mac',
    });
    t.close();
  });

  it('a cold start reads "Connecting…" for 15 s, not "Can’t reach" after three quick tries', () => {
    const { t } = make(true);
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      last().drop();
      jest.advanceTimersByTime(4000);
    }
    expect(t.state).toMatchObject({ kind: 'connecting', since: start });
    expect(pillFor(t.state, Date.now())).toEqual({ tone: 'busy', label: 'Connecting…' });
    expect(pillFor(t.state, start + CALM_MS)).toEqual({
      tone: 'problem',
      label: 'Can’t reach Mac',
    });
    t.close();
  });

  it('the Mac’s app saying goodbye reads as waiting for it, and clears on the next welcome', () => {
    const { t } = make(true);
    last().welcome();
    last().drop(CLOSE_MAC_CLOSING);
    expect(t.state).toMatchObject({ kind: 'reconnecting', macClosing: true });
    jest.advanceTimersByTime(60_000);
    expect(pillFor(t.state, Date.now())).toEqual({
      tone: 'busy',
      label: 'Waiting for the app on your Mac',
    });
    t.retryNow();
    last().welcome();
    expect(t.state.kind).toBe('connected');
    last().drop();
    expect(t.state).not.toHaveProperty('macClosing');
    t.close();
  });
});
