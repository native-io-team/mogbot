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

import { RELAY_PING_MS } from '@shipstudio/companion-protocol';
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
}

/** What a socket's `data` holds, as bytes, whichever realm made it. Null for text. */
function asBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string' || data == null) return null;
  const tag = Object.prototype.toString.call(data);
  if (tag === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
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

  private readonly inner: Inner;
  private mine: ReturnType<typeof startHandshake> | null = null;
  private channel: Channel | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;

  constructor(url: string, opts: RelaySocketOptions) {
    const Impl = opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url) as unknown as Inner;
    ws.binaryType = 'arraybuffer';
    this.inner = ws;
    ws.onopen = () => {
      // Nothing about the phone goes: a fresh key, for this socket only.
      this.mine = startHandshake(opts.random);
      try {
        ws.send(this.mine.hello);
      } catch {
        return this.fail(1006);
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
      if (this.done) return;
      // Text is the relay's own (`pong`); the Mac only ever sends bytes.
      const bytes = asBytes(ev.data);
      if (!bytes) return;
      if (!this.channel) {
        const channel = this.mine && finishHandshake(bytes, this.mine, opts.fingerprint);
        this.mine = null;
        if (!channel) return this.fail(RELAY_NOT_YOUR_MAC, 'not_your_mac');
        this.channel = channel;
        this.readyState = 1;
        this.onopen?.({});
        return;
      }
      const text = this.channel.receive.open(bytes);
      if (text == null) return this.fail(RELAY_BROKEN, 'channel_broken');
      this.onmessage?.({ data: text });
    };
    ws.onerror = (ev) => {
      if (!this.done) this.onerror?.(ev);
    };
    ws.onclose = (ev) => this.finish(ev?.code ?? 1006, ev?.reason ?? '');
  }

  /** Sealed for the Mac. Before the channel opens nothing is sent. */
  send(text: string) {
    if (this.readyState !== 1 || !this.channel) return;
    this.inner.send(this.channel.send.seal(text));
  }

  close(code = 1000, reason = '') {
    this.fail(code, reason);
  }

  /** Ends it here, and says so with `code` (not whatever the relay says next). */
  private fail(code: number, reason = '') {
    if (this.done) return;
    const ws = this.inner;
    ws.onopen = ws.onmessage = ws.onclose = null;
    // Not null: node's `ws` throws an error event nobody listens to.
    ws.onerror = () => {};
    try {
      ws.close(1000);
    } catch {
      // still opening (node's ws throws) or already closed
    }
    this.finish(code, reason);
  }

  private finish(code: number, reason: string) {
    if (this.done) return;
    this.done = true;
    this.readyState = 3;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.mine = null;
    this.channel = null;
    this.onclose?.({ code, reason });
  }
}
