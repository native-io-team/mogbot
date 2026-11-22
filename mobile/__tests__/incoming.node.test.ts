/**
 * What the Mac says, into the store (`incoming.ts`): nothing an event holds,
 * a notice does or a screen throws gets out, or costs any other event; and
 * an alert is never left waiting for a timer.
 */

import type { AgentMessage, CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { setFaultReporter } from '../src/lib/fault';
import { createIncoming, type IncomingDeps } from '../src/lib/incoming';
import { RelaySocket, isAway, setAway } from '../src/lib/relaySocket';
import { emptySync, type SyncState } from '../src/lib/sync';
import { msg, random } from './helpers';
import { relayMac } from './relayMac';

const faults: string[] = [];
const at = (seq: number): Cursor => ({ epoch: 'e', seq });
const line = (id: string, ts: number) =>
  ({ type: 'agents.message', message: msg(id, ts) }) as CompanionEvent;
const alert = (messageId = 'x') =>
  ({
    type: 'alert',
    alert: { agentId: 'a', messageId, title: 't', body: 'b', kind: 'reply' },
  }) as CompanionEvent;
const caughtUp = (seq: number) => ({ type: 'sync.caughtUp', cursor: at(seq) }) as CompanionEvent;
const bad = () =>
  ({
    type: 'agents.registry',
    get overview() {
      throw new Error('bad event');
    },
  }) as unknown as CompanionEvent;

function setup(over: Partial<IncomingDeps> = {}) {
  const box = { state: { ...emptySync(), cursor: at(0) } as SyncState, sets: 0 };
  const log: string[] = [];
  const incoming = createIncoming(
    {
      get: () => box.state,
      set: (s) => {
        box.state = s;
        box.sets++;
      },
      notices: [(m) => log.push(`notice ${m.id}`)],
      snapshot: () => {},
      passed: (e) => log.push(`passed ${e.type}`),
      after: (e) => log.push(`after ${e.type}`),
      ...over,
    },
    { away: isAway }
  );
  const ids = () => (box.state.chats.a?.messages ?? []).map((m: AgentMessage) => m.id);
  return { box, log, incoming, ids };
}

beforeEach(() => {
  jest.useFakeTimers();
  faults.length = 0;
  setFaultReporter((e) => faults.push((e as Error).message));
});
afterEach(() => {
  setAway(false);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('an error', () => {
  it('in one event: the others of its batch land, from the beat, with the cursor before it', () => {
    const { box, incoming, ids } = setup();
    incoming.event(line('m1', 1), at(1));
    incoming.event(line('m2', 2), at(2));
    incoming.event(bad(), at(3));
    incoming.event(line('m4', 4), at(4));
    expect(() => jest.advanceTimersByTime(90)).not.toThrow();
    expect(ids()).toEqual(['m1', 'm2', 'm4']);
    expect(faults).toEqual(['bad event']);
    expect(box.state.cursor).toEqual(at(2));
    // Live goes on, and still doesn't pass it.
    jest.advanceTimersByTime(1000);
    incoming.event(line('m5', 5), at(5));
    expect(ids()).toContain('m5');
    expect(box.state.cursor).toEqual(at(2));
  });

  it('reconnected, the Mac replays from there and the cursor moves on', () => {
    const { box, incoming, ids } = setup();
    incoming.event(line('m1', 1), at(1));
    incoming.event(bad(), at(2));
    incoming.event(line('m3', 3), at(3));
    incoming.flush();
    expect(box.state.cursor).toEqual(at(1));
    incoming.welcome();
    incoming.event(line('m2', 2), at(2));
    incoming.event(line('m3', 3), at(3));
    incoming.event(caughtUp(3));
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
    expect(box.state.cursor).toEqual(at(3));
  });

  it('in an event that fails on its replay too: passed, reported twice at most, what it was about read again', () => {
    const { box, incoming, ids, log } = setup();
    const round = () => {
      incoming.welcome();
      incoming.event(line('m1', 1), at(1));
      incoming.event(bad(), at(2));
      incoming.event(line('m3', 3), at(3));
      incoming.event(caughtUp(3));
    };
    round();
    expect(box.state.cursor).toEqual(at(1));
    expect(log).not.toContain('passed agents.registry');
    round();
    expect(box.state.cursor).toEqual(at(3));
    expect(log.filter((l) => l.startsWith('passed'))).toEqual(['passed agents.registry']);
    round();
    expect(faults).toEqual(['bad event', 'bad event']);
    expect(ids()).toEqual(['m1', 'm3']);
    // Another Mac’s events are counted from the start.
    incoming.clear();
    box.state = { ...box.state, cursor: at(0) };
    incoming.welcome();
    incoming.event(bad(), at(2));
    incoming.event(caughtUp(2));
    expect(box.state.cursor).toEqual(at(0));
  });

  it('in a message, twice: its chat is read again', () => {
    const { box, incoming } = setup();
    incoming.event(line('m1', 1), at(1));
    incoming.flush();
    const chats = box.state.chats;
    const loaded = { a: { ...chats.a, loaded: true }, b: { ...chats.a, loaded: true } };
    box.state = { ...box.state, chats: loaded };
    // Trips the store, not the reading of it.
    const tripped = () => {
      const seqs = box.state.seqs;
      box.state = {
        ...box.state,
        seqs: new Proxy(seqs, {
          get: (t, k) => {
            if (k === 'm2') throw new Error('m2');
            return t[k as string];
          },
        }),
      };
      incoming.welcome();
      incoming.event(line('m2', 2), at(2));
      incoming.flush();
    };
    tripped();
    expect(box.state.chats.a.loaded).toBe(true);
    tripped();
    expect(box.state.cursor).toEqual(at(2));
    expect(box.state.chats.a.loaded).toBe(false);
    expect(box.state.chats.b.loaded).toBe(true);
  });

  it('in a replay the Mac cuts off every 256 frames: still caught up, all 600 in order', () => {
    const { box, incoming, ids } = setup();
    const journal: [CompanionEvent, Cursor][] = [[bad(), at(1)]];
    for (let i = 2; i <= 601; i++) journal.push([line(`m${i}`, i), at(i)]);
    let rounds = 0;
    let done = false;
    while (!done && rounds < 12) {
      rounds++;
      incoming.flush();
      const from = box.state.cursor!.seq;
      incoming.welcome();
      const rest = journal.slice(from);
      for (const [event, cursor] of rest.slice(0, 256)) incoming.event(event, cursor);
      if (rest.length <= 256) {
        incoming.event(caughtUp(601));
        done = true;
      }
    }
    expect(done).toBe(true);
    expect(rounds).toBe(4);
    expect(ids()).toEqual(journal.slice(1).map((_, i) => `m${i + 2}`));
    expect(box.state.cursor).toEqual(at(601));
    expect(faults).toHaveLength(2);
  });

  it('several, each new one found in a later round: still caught up', () => {
    const { box, incoming, ids } = setup();
    const trips = new Set([1, 100, 300, 301, 520, 601]);
    const journal: [CompanionEvent, Cursor][] = [];
    for (let i = 1; i <= 601; i++) journal.push([trips.has(i) ? bad() : line(`m${i}`, i), at(i)]);
    let done = false;
    for (let rounds = 0; !done && rounds < 12; rounds++) {
      incoming.flush();
      const rest = journal.slice(box.state.cursor!.seq);
      incoming.welcome();
      for (const [event, cursor] of rest.slice(0, 256)) incoming.event(event, cursor);
      // Caught up counts once nothing is held: the next replay is empty.
      if (rest.length <= 256) {
        incoming.event(caughtUp(601));
        done = box.state.cursor!.seq === 601;
      }
    }
    expect(done).toBe(true);
    expect(ids()).toHaveLength(601 - trips.size);
    expect(faults).toHaveLength(2 * trips.size);
  });

  it('while catching up: the hold’s own timer, caught up and a flush never throw', () => {
    const { incoming, ids } = setup();
    incoming.welcome();
    incoming.event(bad(), at(1));
    incoming.event(line('m2', 2), at(2));
    expect(() => jest.advanceTimersByTime(1500)).not.toThrow();
    incoming.event(bad(), at(3));
    incoming.event(line('m4', 4), at(4));
    expect(() => incoming.flush()).not.toThrow();
    incoming.event(bad(), at(5));
    expect(() => incoming.event(caughtUp(6))).not.toThrow();
    expect(ids()).toEqual(['m2', 'm4']);
    expect(faults).toHaveLength(3);
  });

  it('in a notice: the other notices, the line and the rest of the batch carry on', () => {
    const heard: string[] = [];
    const { incoming, ids } = setup({
      notices: [
        (m) => {
          if (m.id === 'm2') throw new Error('notice');
        },
        (m) => heard.push(m.id),
      ],
    });
    incoming.welcome();
    ['m1', 'm2', 'm3'].forEach((id, i) => incoming.event(line(id, i), at(i + 1)));
    incoming.event(caughtUp(3));
    expect(heard).toEqual(['m1', 'm2', 'm3']);
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
    expect(faults).toEqual(['notice']);
  });

  it('in an alert, or anything set off after: the next events’ still happen', () => {
    const seen: string[] = [];
    const { incoming } = setup({
      after: (e) => {
        seen.push(e.type);
        if (e.type === 'alert' || e.type === 'system.status') throw new Error(e.type);
      },
    });
    incoming.welcome();
    expect(() => incoming.event(alert())).not.toThrow();
    // One batch: what "caught up" sets off comes after the one that throws.
    incoming.event({ type: 'system.status', status: {} } as CompanionEvent, at(1));
    incoming.event(line('m2', 1), at(2));
    incoming.event(caughtUp(2));
    expect(seen).toEqual(['alert', 'system.status', 'agents.message', 'sync.caughtUp']);
    expect(faults).toEqual(['alert', 'system.status']);
  });

  it('in a screen as the store changes: reported, applied once, what follows still happens', () => {
    const { box, incoming, log } = setup();
    const boom = createIncoming(
      {
        get: () => box.state,
        set: (s) => {
          box.state = s;
          box.sets++;
          throw new Error('Maximum update depth exceeded');
        },
        notices: [],
        snapshot: () => {},
        passed: () => {},
        after: (e) => log.push(`after ${e.type}`),
      },
      {}
    );
    void incoming;
    boom.welcome();
    boom.event({ type: 'agents.draft', agentId: 'a', id: 'd', from: 0, text: 'Hel' } as never);
    boom.event({ type: 'agents.draft', agentId: 'a', id: 'd', from: 3, text: 'lo' } as never);
    boom.event(caughtUp(1));
    expect(box.state.drafts.a).toEqual({ id: 'd', text: 'Hello' });
    expect(box.sets).toBe(1);
    expect(faults).toEqual(['Maximum update depth exceeded']);
    expect(log).toContain('after sync.caughtUp');
  });
});

describe('an alert', () => {
  it('posts at once, behind what came before it, on the beat and while catching up', () => {
    const { incoming, log } = setup();
    incoming.event(line('m1', 1), at(1));
    incoming.event(line('m2', 2), at(2));
    incoming.event(alert('m2'));
    expect(log.slice(-3)).toEqual(['notice m2', 'after agents.message', 'after alert']);
    incoming.welcome();
    incoming.event(line('m3', 3), at(3));
    incoming.event(alert('m3'));
    expect(log.slice(-3)).toEqual(['notice m3', 'after agents.message', 'after alert']);
    // Still catching up: what follows waits for caught up.
    incoming.event(line('m4', 4), at(4));
    expect(log).not.toContain('notice m4');
    incoming.event(caughtUp(4));
    expect(log).toContain('notice m4');
  });

  it('with timers that never fire: two frames then an alert are opened, acked and posted', () => {
    const mac = relayMac();
    const { incoming, log, ids } = setup();
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const socket = new RelaySocket('wss://relay/v1/phone/x', {
      fingerprint: mac.fingerprint,
      random,
      session: true,
      WebSocketImpl: mac.WebSocketImpl,
    });
    let seq = 0;
    socket.onmessage = (ev) => {
      // Every frame fills its slice, so the next waits for a timer.
      clock += 20;
      const event = JSON.parse(String(ev.data)) as CompanionEvent;
      incoming.event(event, event.type === 'alert' ? undefined : at(++seq));
    };
    mac.socket.open();
    const say = (e: CompanionEvent) => mac.frame(JSON.stringify(e));
    // In front, up to the moment Android stops the timers.
    for (let i = 0; i < 6; i++) say(line(`w${i}`, i));
    expect(ids().length).toBeLessThan(6);
    setAway(true);
    expect(ids()).toHaveLength(6);
    // And after.
    say(line('m1', 10));
    say(line('m2', 11));
    say(alert('m2'));
    expect(ids().slice(-2)).toEqual(['m1', 'm2']);
    expect(log.at(-1)).toBe('after alert');
    expect(mac.acks).toEqual([8]);
    expect(mac.unacked).toBe(1);
  });
});
