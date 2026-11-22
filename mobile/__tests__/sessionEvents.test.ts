/**
 * The real session with a transport driven by hand: an event it can't apply
 * never fails a request it has nothing to do with, a reconnect, or the app;
 * and leaving the front (Android stops JavaScript timers there) leaves
 * nothing waiting for one.
 */

import type { CompanionEvent, Cursor, WelcomeFrame } from '@shipstudio/companion-protocol';
import * as Notifications from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';
import { msg } from './helpers';

interface Fake {
  opts: { getResume: () => Cursor | undefined };
  event: (e: CompanionEvent, c?: Cursor) => void;
  welcomed: (w: WelcomeFrame) => void;
  state: { kind: string };
  answer: (v: unknown) => void;
  asked: string[];
}
const mockMade: Fake[] = [];
jest.mock('../src/lib/transport', () => {
  const real = jest.requireActual<typeof import('../src/lib/transport')>('../src/lib/transport');
  class DirectTransport {
    state = { kind: 'connected' };
    event: unknown;
    welcomed: unknown;
    answer: unknown;
    opts: unknown;
    constructor(given: unknown) {
      this.opts = given;
      mockMade.push(this as never);
    }
    onState(l: (s: unknown) => void) {
      l(this.state);
    }
    onRefused() {}
    onWelcome(l: unknown) {
      this.welcomed = l;
    }
    onEvent(l: unknown) {
      this.event = l;
    }
    asked: string[] = [];
    request(method: string) {
      this.asked.push(method);
      return new Promise((r) => (this.answer = r));
    }
    setForeground() {}
    setRoutes() {}
    noteTiming() {}
    retryNow() {}
    close() {}
  }
  return { ...real, DirectTransport };
});
const mockRecord = jest.fn((_: unknown) => Promise.resolve());
jest.mock('../src/lib/crash', () => ({
  recordCrash: (e: unknown) => mockRecord(e),
  sendCrashes: () => Promise.resolve(0),
}));
jest.mock('../src/lib/pairing', () => ({
  ...jest.requireActual<object>('../src/lib/pairing'),
  saveCredentials: () => Promise.resolve(),
  usableRoutes: (r: unknown) => r,
  appInfo: () => ({ version: '1', name: 'x' }),
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: () => () => {} },
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('id')),
  getPresentedNotificationsAsync: jest.fn(() => Promise.resolve([])),
  dismissNotificationAsync: jest.fn(() => Promise.resolve()),
  setBadgeCountAsync: jest.fn(() => Promise.resolve()),
}));

import { formatDate } from '../src/lib/agents';
import { adopt, call, watchLifecycle } from '../src/lib/session';
import { getApp, setApp } from '../src/lib/store';

const at = (seq: number): Cursor => ({ epoch: 'e', seq });
const line = (id: string, ts: number) =>
  ({ type: 'agents.message', message: msg(id, ts) }) as CompanionEvent;
const bad = () =>
  ({
    type: 'agents.registry',
    get overview() {
      throw new Error('bad event');
    },
  }) as unknown as CompanionEvent;
const ids = () => (getApp().chats.a?.messages ?? []).map((m) => m.id);

let appState: ((s: AppStateStatus) => void) | null = null;
function go(s: AppStateStatus) {
  Object.defineProperty(AppState, 'currentState', { value: s, configurable: true });
  appState?.(s);
}
let stop: () => void;
let mac: Fake;

beforeEach(async () => {
  jest.useFakeTimers();
  mockRecord.mockClear();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
    appState = fn as typeof appState;
    return { remove: () => {} } as never;
  });
  go('active');
  await adopt({
    serverId: 's',
    name: 'Mac',
    routes: [{ kind: 'relay', url: 'wss://relay' }],
    deviceId: 'd',
    token: 't',
    secretKey: '',
    pairedAt: 1,
    fingerprint: 'f',
  });
  stop = watchLifecycle();
  mac = mockMade.at(-1)!;
  setApp({ cursor: at(0), chats: {} });
  mac.welcomed({ t: 'welcome', methods: [], features: ['alerts'] } as unknown as WelcomeFrame);
});
afterEach(() => {
  go('active');
  stop();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const caughtUp = (n: number) =>
  mac.event({ type: 'sync.caughtUp', cursor: at(n) } as CompanionEvent);

describe('the app coming forward', () => {
  it('writes dates again: the phone’s language may have changed while it was away', () => {
    const [then, now] = [new Date(2026, 10, 4).getTime(), new Date(2026, 10, 22).getTime()];
    const words = formatDate(then, now);
    jest.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('4 nov.');
    go('background');
    expect(formatDate(then, now)).toBe(words);
    go('active');
    expect(formatDate(then, now)).toBe('4 nov.');
  });
});

describe('an event it can’t apply', () => {
  it('never fails the request whose answer comes next', async () => {
    caughtUp(0);
    const asked = call('agents.create' as never, {} as never);
    await Promise.resolve();
    mac.event(line('m1', 1), at(1));
    mac.event(bad(), at(2));
    mac.event(line('m3', 3), at(3));
    mac.answer({ ok: 1 });
    await expect(asked).resolves.toEqual({ ok: 1 });
    expect(ids()).toEqual(['m1', 'm3']);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('never fails a reconnect: it asks for the replay from before it', () => {
    caughtUp(0);
    mac.event(line('m1', 1), at(1));
    mac.event(line('m2', 2), at(2));
    mac.event(bad(), at(3));
    mac.event(line('m4', 4), at(4));
    expect(mac.opts.getResume()).toEqual(at(2));
    expect(ids()).toEqual(['m1', 'm2', 'm4']);
  });

  it('failing on its replay too, the team is read again once caught up', async () => {
    const round = () => {
      mac.welcomed({ t: 'welcome', methods: [], features: ['alerts'] } as unknown as WelcomeFrame);
      mac.event(bad(), at(1));
      mac.event(line('m2', 2), at(2));
      mac.opts.getResume();
      const before = mac.asked.includes('agents.overview');
      caughtUp(2);
      return before;
    };
    round();
    await Promise.resolve();
    expect(getApp().cursor).toEqual(at(0));
    expect(mac.asked).not.toContain('agents.overview');
    // Not while it is still catching up: what follows would put older news over it.
    expect(round()).toBe(false);
    await Promise.resolve();
    expect(getApp().cursor).toEqual(at(2));
    expect(mac.asked.filter((m) => m === 'agents.overview')).toHaveLength(1);
    expect(mockRecord).toHaveBeenCalledTimes(2);
  });

  it('a status with no routes to learn costs nothing else', () => {
    mac.event({ type: 'system.status', status: null } as unknown as CompanionEvent, at(1));
    mac.event(line('m2', 2), at(2));
    expect(() => caughtUp(2)).not.toThrow();
    expect(ids()).toEqual(['m2']);
    expect(getApp().cursor).toEqual(at(2));
  });

  it('an alert it can’t read is reported, not an unhandled rejection', async () => {
    caughtUp(0);
    mac.event({ type: 'alert', alert: null } as unknown as CompanionEvent);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
});

describe('put away, with no timer firing', () => {
  it('what waits for the beat is applied as it leaves, and what comes after at once', () => {
    caughtUp(0);
    mac.event(line('m1', 1), at(1));
    mac.event(line('m2', 2), at(2));
    go('background');
    expect(ids()).toEqual(['m1', 'm2']);
    mac.event(line('m3', 3), at(3));
    mac.event(line('m4', 4), at(4));
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('an alert behind other events posts, caught up or not', async () => {
    go('background');
    mac.event(line('m1', 1), at(1));
    mac.event({
      type: 'alert',
      alert: { agentId: 'a', messageId: 'm1', title: 'A', body: 'Done', kind: 'reply' },
    } as CompanionEvent);
    await Promise.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});
