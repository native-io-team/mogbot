/**
 * A socket to the Mac through the relay (docs/relay.md), shaped like the
 * WebSocket `DirectTransport` already drives: it opens only once the Mac has
 * answered the handshake signed by the pinned key, then carries text both
 * ways sealed end to end. The relay sees bytes it can't read.
 *
 * Its own close codes say what happened before it opened, so the transport
 * can say it plainly: the relay's `RELAY_CLOSE_MAC_OFFLINE` ("Your Mac is
 * offline or asleep"), and `RELAY_NOT_YOUR_MAC` when whatever answered
 * couldn't sign for the pinned key ("This isn't your Mac"). Those two never
 * travel on the wire; they're this phone's.
 *
 * Pure TypeScript with the socket constructor and the random source passed
 * in, so the tests run it under Node against the mock relay.
 */

import {
  RELAY_CLOSE_MAC_OFFLINE,
  RELAY_CLOSE_SIGN_IN_NEEDED,
  RELAY_PING_MS,
} from '@shipstudio/companion-protocol';
import { guarded, reportFault } from './fault';
import { finishHandshake, startHandshake, type Channel } from './relayCrypto';

/** Whatever answered at the relay couldn't prove it's the pinned Mac. */
export const RELAY_NOT_YOUR_MAC = 4801;
/** A sealed frame didn't open (tampered, replayed, out of order): the channel is done. */
export const RELAY_BROKEN = 4802;

export interface RelaySocketOptions {
  /** The pinned Mac's fingerprint: only its signature opens the channel. */
  fingerprint: string;
  random: (n: number) => Uint8Array;
  WebSocketImpl?: typeof WebSocket;
  /** Keep-alive to the relay; `RELAY_PING_MS` by default. */
  pingMs?: number;
  /**
   * Keep the session when this socket dies: reconnect behind the same
   * RelaySocket and pick up where it left off (docs/relay.md, "Sessions").
   * For the companion protocol's socket; HTTP's one-shot sockets leave it off.
   */
  session?: boolean;
  /** How long a dropped session keeps trying; 120 s by default. */
  graceMs?: number;
  /** Timers, for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** What a dropped session waits between tries, then keeps at the last. */
const RETRY_MS = [1000, 2000, 4000, 8000];
/** A try that hasn't opened by then is given up and redone. */
const TRY_MS = 8000;
/** Unacked frames kept for the Mac (it keeps the same). */
const MAX_FRAMES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const ACK_EVERY = 8;
/**
 * How long opening frames may hold the thread before taps get a turn.
 * Opening one is JavaScript on the thread that answers touches, and a phone
 * coming back is sent hundreds at once: done in one go they froze the app.
 */
export const SLICE_MS = 8;

/**
 * The app is in the background, where Android fires no timers
 * (`JavaTimerManager.onHostPause`) while sockets still deliver: a frame left
 * for the next slice would sit unopened and unacked, the Mac giving the
 * session up at 256 of them, and an alert in it unposted. So nothing waits
 * for a slice then, and what was waiting is opened as the app leaves.
 */
let away = false;
/** Sockets with frames waiting for their slice. */
const behind = new Set<{ catchUp(): void }>();

export function setAway(next: boolean) {
  away = next;
  if (away) for (const socket of [...behind]) socket.catchUp();
}
export const isAway = () => away;

/** What a socket's `data` holds, as bytes, whichever realm made it. Null for text. */
function asBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string' || data == null) return null;
  const tag = Object.prototype.toString.call(data);
  if (tag === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  if (ArrayBuffer.isView(data)) {
    const v = data;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  // Node's `ws` may hand a list of fragments.
  if (Array.isArray(data)) {
    const parts = data.map(asBytes).filter((p): p is Uint8Array => !!p);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  return null;
}

type Inner = {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export class RelaySocket {
  /** 0 until the Mac proved itself, 1 open, 3 closed (as WebSocket's). */
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private inner!: Inner;
  private mine: ReturnType<typeof startHandshake> | null = null;
  private channel: Channel | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;

  // The session (docs/relay.md, "Sessions"), once the Mac's first frame named it.
  private sid: string | null = null;
  private resumeKey: Uint8Array | null = null;
  /** The Mac's answer carried `"s":1` and its `sess` frame hasn't come yet. */
  private awaitSess = false;
  private tx = 0;
  private rx = 0;
  private k = 0;
  private sinceAck = 0;
  private unacked: { n: number; text: string }[] = [];
  private bytes = 0;
  // Reconnecting.
  private droppedAt = 0;
  private attempts = 0;
  private retry: unknown = null;
  private tryTimer: unknown = null;
  /** Frames of this channel not opened yet, oldest first, and their turn. */
  private inbox: Uint8Array[] = [];
  private pump: ReturnType<typeof setTimeout> | null = null;
  private spent = 0;
  private idleSince = 0;
  private taking = false;
  /** The socket closed with frames still waiting: how, for when they're through. */
  private ended: { code: number; reason: string } | null = null;

  constructor(
    private readonly url: string,
    private readonly opts: RelaySocketOptions
  ) {
    this.connect();
  }

  private timer(fn: () => void, ms: number): unknown {
    return (this.opts.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  private untimer(t: unknown) {
    if (t == null) return;
    (this.opts.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);
  }

  private connect() {
    const opts = this.opts;
    const Impl = opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.url) as unknown as Inner;
    ws.binaryType = 'arraybuffer';
    this.inner = ws;
    this.channel = null;
    this.awaitSess = false;
    this.dropInbox();
    const mine = (): boolean => ws === this.inner && !this.done;
    ws.onopen = () => {
      if (!mine()) return;
      // Nothing about the phone goes: a fresh key, for this socket only.
      const resume =
        this.sid && this.resumeKey
          ? { sid: this.sid, rx: this.rx, k: ++this.k, key: this.resumeKey }
          : undefined;
      this.mine = startHandshake(opts.random, opts.session ? { resume } : undefined);
      try {
        ws.send(this.mine.hello);
      } catch {
        return this.lost(1006, '');
      }
      this.pingTimer = setInterval(() => {
        try {
          if (ws.readyState === 1) ws.send('ping');
        } catch {
          // the close that follows says so
        }
      }, opts.pingMs ?? RELAY_PING_MS);
    };
    ws.onmessage = (ev) => {
      if (!mine()) return;
      // Text is the relay's own (`pong`); the Mac only ever sends bytes.
      const bytes = asBytes(ev.data);
      if (!bytes) return;
      if (!this.channel) {
        const channel = this.mine && finishHandshake(bytes, this.mine, opts.fingerprint);
        this.mine = null;
        if (!channel) return this.fail(RELAY_NOT_YOUR_MAC, 'not_your_mac');
        this.channel = channel;
        if (opts.session && channel.sessions) {
          this.awaitSess = true;
          return;
        }
        // A Mac without sessions: the old behaviour, and a drop ends it.
        this.sid = null;
        this.opened();
        return;
      }
      this.arrived(bytes);
    };
    ws.onerror = (ev) => {
      if (mine() && this.readyState !== 1) this.onerror?.(ev);
    };
    ws.onclose = (ev) => {
      if (ws !== this.inner) return;
      const ended = { code: ev?.code ?? 1006, reason: ev?.reason ?? '' };
      // What came before the close counts, and is opened in slices like the
      // rest: the close waits for it. Dropping it would cost a long replay
      // its progress (the Mac ends a session that's too far behind, and the
      // next one starts from what was opened).
      if (this.inbox.length) this.ended = ended;
      else this.lost(ended.code, ended.reason);
    };
    this.untimer(this.tryTimer);
    this.tryTimer = this.sid
      ? this.timer(() => {
          // A try that never opened: drop it and go again.
          if (ws === this.inner && !this.done && (!this.channel || this.awaitSess)) {
            this.dropInner(ws);
            this.lost(1006, 'try_timeout');
          }
        }, TRY_MS)
      : null;
  }

  /** A sealed frame: opened now, or behind the ones already waiting. */
  private arrived(bytes: Uint8Array) {
    this.inbox.push(bytes);
    if (this.pump || this.taking) return;
    // Frames right behind one another share a slice; after a pause it starts over.
    if (Date.now() - this.idleSince > SLICE_MS * 2) this.spent = 0;
    this.take(SLICE_MS - this.spent);
  }

  /** Opens what waits, for about `ms`; the rest after the thread has had a turn. */
  private take(ms: number) {
    if (this.taking) return;
    if (this.pump) clearTimeout(this.pump);
    this.pump = null;
    this.taking = true;
    const from = Date.now();
    try {
      while (this.inbox.length && (away || Date.now() - from < ms)) {
        // Off the list before it's opened: opening one moves the channel's
        // counter, so one left there would never open again.
        const bytes = this.inbox.shift()!;
        const channel = this.channel;
        if (!channel || this.done) return;
        const text = channel.receive.open(bytes);
        if (text == null) return guarded(() => this.fail(RELAY_BROKEN, 'channel_broken'));
        try {
          this.got(text);
        } catch (e) {
          // From a timer it would end the app; the frames behind it still count.
          reportFault(e);
        }
        // What it carried closed this, or started another channel.
        if (this.done || this.channel !== channel) return;
      }
    } finally {
      this.taking = false;
    }
    this.idleSince = Date.now();
    this.spent += this.idleSince - from;
    if (this.inbox.length) {
      behind.add(this);
      this.pump = setTimeout(() => {
        this.pump = null;
        this.spent = 0;
        this.take(SLICE_MS);
      }, 0);
      return;
    }
    behind.delete(this);
    const ended = this.ended;
    this.ended = null;
    // From a timer, or as the app leaves with more to put away: what hears of it may not end either.
    if (ended) guarded(() => this.lost(ended.code, ended.reason));
  }

  /** The app is leaving the front: everything waiting, now (`setAway`). */
  catchUp() {
    this.take(SLICE_MS);
  }

  private dropInbox() {
    if (this.pump) clearTimeout(this.pump);
    this.pump = null;
    this.inbox = [];
    this.spent = 0;
    this.ended = null;
    behind.delete(this);
  }

  private opened() {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** A plaintext from the Mac. */
  private got(text: string) {
    if (!this.awaitSess && !this.sid) return void this.onmessage?.({ data: text });
    let f: {
      t?: unknown;
      sid?: unknown;
      resumed?: unknown;
      rx?: unknown;
      n?: unknown;
      a?: unknown;
      d?: unknown;
    };
    try {
      f = JSON.parse(text) as typeof f;
    } catch {
      return void this.onmessage?.({ data: text });
    }
    if (this.awaitSess) {
      this.awaitSess = false;
      if (f.t !== 'sess' || typeof f.sid !== 'string')
        return this.fail(RELAY_BROKEN, 'channel_broken');
      const channel = this.channel!;
      if (this.sid) {
        // Back on a new socket: the Mac must say it is the same session.
        if (f.sid !== this.sid || f.resumed !== true || typeof f.rx !== 'number') {
          return this.finish(1006, 'session_lost');
        }
        this.acked(f.rx);
        this.resumeKey = channel.resumeKey;
        this.attempts = 0;
        // The grace is for each drop (docs/relay.md, "Sessions", 7), not from the first.
        this.droppedAt = 0;
        this.untimer(this.tryTimer);
        this.tryTimer = null;
        for (const m of this.unacked) this.inner.send(channel.send.seal(this.frame(m.n, m.text)));
      } else {
        this.sid = f.sid;
        this.resumeKey = channel.resumeKey;
        this.opened();
      }
      return;
    }
    if (typeof f.a === 'number') this.acked(f.a);
    if (f.t === 'a') return;
    if (f.t === 'q' && typeof f.n === 'number' && typeof f.d === 'string') {
      if (f.n <= this.rx) return;
      if (f.n !== this.rx + 1) return this.fail(RELAY_BROKEN, 'channel_broken');
      this.rx = f.n;
      if (++this.sinceAck >= ACK_EVERY) {
        this.sinceAck = 0;
        this.sealNow(JSON.stringify({ t: 'a', a: this.rx }));
      }
      this.onmessage?.({ data: f.d });
      return;
    }
    // HTTP's own frames, and anything not numbered.
    this.onmessage?.({ data: text });
  }

  private frame(n: number, text: string) {
    return JSON.stringify({ t: 'q', n, a: this.rx, d: text });
  }

  private acked(a: number) {
    while (this.unacked.length && this.unacked[0].n <= a) {
      this.bytes -= this.unacked[0].text.length;
      this.unacked.shift();
    }
  }

  private sealNow(text: string) {
    if (!this.channel || this.awaitSess || this.inner.readyState !== 1) return;
    try {
      this.inner.send(this.channel.send.seal(text));
    } catch {
      // the close that follows says so
    }
  }

  /** Sealed for the Mac. Before the channel opens nothing is sent. */
  send(text: string) {
    if (this.readyState !== 1) return;
    if (!this.sid || text.startsWith('{"t":"http')) {
      if (this.channel && !this.awaitSess) this.sealNow(text);
      return;
    }
    if (this.unacked.length >= MAX_FRAMES || this.bytes + text.length > MAX_BYTES) {
      return this.fail(RELAY_BROKEN, 'too_far_behind');
    }
    const n = ++this.tx;
    this.unacked.push({ n, text });
    this.bytes += text.length;
    // While reconnecting it waits here, and goes first once the Mac has the session back.
    this.sealNow(this.frame(n, text));
  }

  close(code = 1000, reason = '') {
    this.fail(code, reason);
  }

  /**
   * The network changed or the app came forward: a session waiting out its
   * backoff tries now (the old socket is already closed, so the worker's
   * per-address limit isn't touched). One try at a time.
   */
  nudge() {
    if (this.done || this.retry == null) return;
    this.untimer(this.retry);
    this.retry = null;
    this.attempts = 0;
    this.connect();
  }

  private dropInner(ws: Inner) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    // Not null: node's `ws` throws an error event nobody listens to.
    ws.onerror = () => {};
    try {
      ws.close(1000);
    } catch {
      // still opening (node's ws throws) or already closed
    }
  }

  /** The socket went. A session in progress tries again; anything else is over. */
  private lost(code: number, reason: string) {
    if (this.done) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.mine = null;
    this.channel = null;
    this.dropInbox();
    this.untimer(this.tryTimer);
    this.tryTimer = null;
    // The relay's own answers (the Mac is away, signed out) are the news, not a blip.
    const answered = code === RELAY_CLOSE_MAC_OFFLINE || code === RELAY_CLOSE_SIGN_IN_NEEDED;
    if (!this.sid || this.readyState !== 1 || answered) return this.finish(code, reason);
    if (!this.droppedAt) this.droppedAt = Date.now();
    if (Date.now() - this.droppedAt > (this.opts.graceMs ?? 120_000))
      return this.finish(code, reason);
    this.dropInner(this.inner);
    const wait = RETRY_MS[Math.min(this.attempts++, RETRY_MS.length - 1)];
    this.retry = this.timer(() => {
      this.retry = null;
      if (!this.done) this.connect();
    }, wait);
  }

  /** Ends it here, and says so with `code` (not whatever the relay says next). */
  private fail(code: number, reason = '') {
    if (this.done) return;
    this.dropInner(this.inner);
    this.finish(code, reason);
  }

  private finish(code: number, reason: string) {
    if (this.done) return;
    this.done = true;
    this.readyState = 3;
    this.dropInbox();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.untimer(this.retry);
    this.untimer(this.tryTimer);
    this.retry = this.tryTimer = null;
    this.mine = null;
    this.channel = null;
    this.onclose?.({ code, reason });
  }
}
