/**
 * Opening a backlog without holding the thread (`relaySocket.ts`): in slices
 * with a turn for taps between them, in order, nothing lost or opened twice
 * by an error, a drop in the middle of a replay, or the app being put away
 * (where Android fires no timers).
 */

import { setFaultReporter } from '../src/lib/fault';
import { RelaySocket, SLICE_MS, setAway } from '../src/lib/relaySocket';
import { random } from './helpers';
import { relayMac } from './relayMac';

/** What opening one frame costs here. */
const COST = 3;
const faults: unknown[] = [];
/** The time, moved by what opening costs and by waiting. */
let clock = 0;
const wait = (ms: number) => {
  clock += ms;
  jest.advanceTimersByTime(ms);
};

function connect(mac: ReturnType<typeof relayMac>, session = true) {
  const got: string[] = [];
  const closed: number[] = [];
  const socket = new RelaySocket('wss://relay/v1/phone/x', {
    fingerprint: mac.fingerprint,
    random,
    session,
    WebSocketImpl: mac.WebSocketImpl,
  });
  socket.onmessage = (ev) => {
    got.push(String(ev.data));
    clock += COST;
  };
  socket.onclose = (ev) => closed.push((ev as { code: number }).code);
  mac.socket.open();
  return { socket, got, closed };
}
const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `f${from + i}`);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['Date'] });
  clock = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  faults.length = 0;
  setFaultReporter((e) => faults.push(e));
});
afterEach(() => {
  setAway(false);
  jest.restoreAllMocks();
  jest.useRealTimers();
});
/** One turn of the thread: the next timer due (a slice), not the one it sets. */
const turn = () => jest.advanceTimersToNextTimer();

describe('slices', () => {
  it('opens about SLICE_MS of frames, then lets a tap through, in order to the end', () => {
    const mac = relayMac();
    const { got } = connect(mac);
    const each = Math.ceil(SLICE_MS / COST);
    names(10).forEach(mac.frame);
    expect(got).toEqual(names(each));
    turn();
    expect(got).toEqual(names(2 * each));
    // A frame arriving meanwhile goes behind the ones waiting.
    mac.frame('late');
    expect(got).toHaveLength(2 * each);
    for (let i = 0; i < 10; i++) turn();
    expect(got).toEqual([...names(10), 'late']);
    expect(mac.acks).toEqual([8]);
  });

  it('a lone frame is opened as it comes', () => {
    const mac = relayMac();
    const { got } = connect(mac);
    mac.frame('one');
    expect(got).toEqual(['one']);
    expect(jest.getTimerCount()).toBeLessThanOrEqual(1); // the keep-alive
  });

  it('what handling one throws is reported, and no frame is opened twice or left', () => {
    const mac = relayMac();
    const { socket, got, closed } = connect(mac);
    const take = socket.onmessage!;
    socket.onmessage = (ev) => {
      take(ev);
      if (ev.data === 'f1' || ev.data === 'f5') throw new Error(`on ${ev.data}`);
    };
    expect(() => names(12).forEach(mac.frame)).not.toThrow();
    for (let i = 0; i < 10; i++) expect(turn).not.toThrow();
    expect(got).toEqual(names(12));
    expect(faults.map((e) => (e as Error).message)).toEqual(['on f1', 'on f5']);
    expect(closed).toEqual([]);
  });
});

describe('a drop with frames waiting', () => {
  it('mid-replay: the close opens nothing itself, the rest follow in slices, and it resumes after the last', () => {
    const mac = relayMac();
    const { got, closed } = connect(mac);
    names(200).forEach(mac.frame);
    const before = got.length;
    const at = Date.now();
    mac.socket.drop();
    expect(got).toHaveLength(before);
    expect(Date.now() - at).toBe(0);
    let longest = 0;
    while (got.length < 200) {
      const from = Date.now();
      const had = got.length;
      turn();
      longest = Math.max(longest, Date.now() - from);
      expect(got.length).toBeGreaterThan(had);
    }
    expect(longest).toBeLessThanOrEqual(SLICE_MS + COST);
    expect(got).toEqual(names(200));
    // Back a second later, asking for what comes after the last one opened.
    wait(1000);
    mac.socket.open();
    expect(mac.resumes).toEqual([{ rx: 200 }]);
    mac.frame('f200');
    for (let i = 0; i < 3; i++) turn();
    expect(got).toEqual(names(201));
    expect(closed).toEqual([]);
  });

  it('without a session (a download): everything that came is handed over, then the close', () => {
    const mac = relayMac({ sessions: false });
    const { got, closed } = connect(mac, false);
    names(20).forEach(mac.frame);
    mac.socket.drop(1000);
    expect(closed).toEqual([]);
    for (let i = 0; i < 20; i++) turn();
    expect(got).toEqual(names(20));
    expect(closed).toEqual([1000]);
  });

  it('closed by the phone, nothing more is opened', () => {
    const mac = relayMac();
    const { socket, got } = connect(mac);
    names(20).forEach(mac.frame);
    const had = got.length;
    socket.close();
    for (let i = 0; i < 20; i++) turn();
    expect(got).toHaveLength(had);
  });
});

describe('the grace', () => {
  const back = (mac: ReturnType<typeof relayMac>) => {
    wait(1000);
    mac.socket.open();
  };

  it('is for each drop: one long after the first still resumes', () => {
    const mac = relayMac();
    const { got, closed } = connect(mac);
    mac.socket.drop();
    back(mac);
    wait(130_000);
    mac.socket.drop();
    expect(closed).toEqual([]);
    back(mac);
    expect(mac.resumes).toHaveLength(2);
    mac.frame('f0');
    expect(got).toEqual(['f0']);
  });

  it('still ends a session that could not come back in it', () => {
    const mac = relayMac();
    const { closed } = connect(mac);
    mac.socket.drop();
    for (let i = 0; i < 400 && !closed.length; i++) {
      wait(1000);
      if (mac.socket.readyState === 0) mac.socket.drop();
    }
    expect(closed).toEqual([1006]);
    expect(clock - 1_000_000).toBeGreaterThan(120_000);
    expect(clock - 1_000_000).toBeLessThan(150_000);
  });
});

describe('what hears of a close throws', () => {
  const throwing = (end: (mac: ReturnType<typeof relayMac>) => void) => {
    const mac = relayMac({ sessions: false });
    const { socket, got } = connect(mac, false);
    socket.onclose = () => {
      throw new Error('onclose');
    };
    names(20).forEach(mac.frame);
    end(mac);
    return got;
  };

  it('from the slice that ends it: reported, and goes no further', () => {
    const got = throwing((mac) => mac.socket.drop(1000));
    for (let i = 0; i < 20; i++) expect(turn).not.toThrow();
    expect(got).toEqual(names(20));
    expect(faults.map((e) => (e as Error).message)).toEqual(['onclose']);
  });

  it('as the app leaves: the other sockets are opened too', () => {
    throwing((mac) => mac.socket.drop(1000));
    const other = relayMac();
    const { got } = connect(other);
    names(20).forEach(other.frame);
    expect(() => setAway(true)).not.toThrow();
    expect(got).toEqual(names(20));
    expect(faults.map((e) => (e as Error).message)).toEqual(['onclose']);
  });

  it('a frame that won’t open, behind others: reported too', () => {
    const got = throwing((mac) => mac.socket.say(new Uint8Array(40)));
    for (let i = 0; i < 20; i++) expect(turn).not.toThrow();
    expect(got).toEqual(names(20));
    expect(faults.map((e) => (e as Error).message)).toEqual(['onclose']);
  });
});

describe('in the background, where no timer fires', () => {
  it('what waited is opened and acked as the app leaves, and what comes after as it comes', () => {
    const mac = relayMac();
    const { got } = connect(mac);
    names(20).forEach(mac.frame);
    expect(got.length).toBeLessThan(20);
    setAway(true);
    expect(got).toEqual(names(20));
    names(300, 20).forEach(mac.frame);
    expect(got).toEqual(names(320));
    // The Mac gives a session up at 256 unacked.
    expect(mac.unacked).toBeLessThan(8);
  });

  it('a close behind waiting frames still comes through', () => {
    const mac = relayMac({ sessions: false });
    const { got, closed } = connect(mac, false);
    names(20).forEach(mac.frame);
    mac.socket.drop(1000);
    setAway(true);
    expect(got).toEqual(names(20));
    expect(closed).toEqual([1000]);
  });

  it('back in front, slices again', () => {
    const mac = relayMac();
    const { got } = connect(mac);
    setAway(true);
    setAway(false);
    wait(1000);
    names(20).forEach(mac.frame);
    expect(got.length).toBeLessThan(20);
  });
});
