import { DurableObject } from 'cloudflare:workers';
import { newNonce, verifyMacLogin } from './auth';
import type { Env } from './env';

/** The Mac must answer the challenge within this. */
export const AUTH_TIMEOUT_MS = 10_000;
/** Phone sockets one Mac may have open at once. */
export const MAX_PHONES = 8;
/** Largest payload either way, not counting the Mac's 4-byte channel header. */
export const MAX_PAYLOAD = 256 * 1024;

type MacState = {
  role: 'mac';
  fingerprint: string;
  nonce: string;
  deadline: number;
  authed: boolean;
  /** Closed because a newer Mac socket logged in: its phones aren't this socket's to close. */
  replaced?: boolean;
};

type PhoneState = {
  role: 'phone';
  ch: number;
  /** The Mac already knows this channel is gone (it asked, or was told). */
  notified?: boolean;
};

type State = MacState | PhoneState;

const OPEN = 1;
const CHANNEL_KEY = 'lastChannel';

/**
 * One per Mac (named by its key's fingerprint). Holds the Mac's socket and its
 * phones' sockets and moves opaque bytes between them. All state lives in the
 * sockets' tags and attachments (and the channel counter in storage), so the
 * object can hibernate between messages.
 */
export class MacRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const [, role, fingerprint] = new URL(request.url).pathname.split('/');
    if (role === 'mac') return this.acceptMac(fingerprint);
    if (role === 'phone') return this.acceptPhone();
    return new Response('not found', { status: 404 });
  }

  private async acceptMac(fingerprint: string): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['mac']);
    const state: MacState = {
      role: 'mac',
      fingerprint,
      nonce: newNonce(),
      deadline: Date.now() + AUTH_TIMEOUT_MS,
      authed: false,
    };
    server.serializeAttachment(state);
    server.send(JSON.stringify({ t: 'challenge', nonce: state.nonce }));
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > state.deadline) await this.ctx.storage.setAlarm(state.deadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptPhone(): Promise<Response> {
    if (!this.currentMac()) return refuse(4404, 'mac_offline');
    if (this.openPhones().length >= MAX_PHONES) return refuse(4429, 'too_many_phones');
    const ch = await this.nextChannel();
    // The Mac may have gone while the counter was read.
    const mac = this.currentMac();
    if (!mac) return refuse(4404, 'mac_offline');
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['phone', channelTag(ch)]);
    server.serializeAttachment({ role: 'phone', ch } satisfies PhoneState);
    mac.send(JSON.stringify({ t: 'open', ch }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = stateOf(ws);
    if (!state) return;
    if (state.role === 'phone') return this.fromPhone(ws, state, message);
    if (!state.authed) return this.login(ws, state, message);
    return this.fromMac(message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.gone(ws);
    closeQuietly(ws, code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws);
    closeQuietly(ws, 1011);
  }

  /** Closes every Mac socket that hasn't logged in by its deadline. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets('mac')) {
      const state = stateOf(ws);
      if (state?.role !== 'mac' || state.authed) continue;
      if (state.deadline <= now) closeQuietly(ws, 4401, 'auth_timeout');
      else next = next === null ? state.deadline : Math.min(next, state.deadline);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  private async login(ws: WebSocket, state: MacState, message: string | ArrayBuffer) {
    if (Date.now() > state.deadline) return closeQuietly(ws, 4401, 'auth_timeout');
    const frame = typeof message === 'string' ? parseJson(message) : null;
    if (frame?.t !== 'auth' || frame.v !== 1) return closeQuietly(ws, 4401, 'unauthorized');
    const ok = await verifyMacLogin(
      state.fingerprint,
      state.nonce,
      frame.publicKey,
      frame.signature
    );
    if (!ok || ws.readyState !== OPEN) return closeQuietly(ws, 4401, 'unauthorized');
    // No await from here on, so two Macs logging in at once still leave exactly one.
    for (const other of this.ctx.getWebSockets('mac')) {
      const o = stateOf(other);
      if (other === ws || o?.role !== 'mac' || !o.authed || o.replaced) continue;
      other.serializeAttachment({ ...o, replaced: true } satisfies MacState);
      closeQuietly(other, 4409, 'replaced');
    }
    // The old Mac's channels mean nothing to the new one: those phones reconnect.
    this.closeAllPhones();
    ws.serializeAttachment({ ...state, authed: true } satisfies MacState);
    ws.send(JSON.stringify({ t: 'ready' }));
  }

  private fromMac(message: string | ArrayBuffer) {
    if (typeof message === 'string') {
      const frame = parseJson(message);
      if (frame?.t === 'close' && isChannel(frame.ch)) {
        const phone = this.phone(frame.ch);
        if (phone) this.closePhone(phone, 1000, 'closed');
      }
      return;
    }
    if (message.byteLength < 4) return;
    const ch = new DataView(message).getUint32(0);
    const phone = this.phone(ch);
    if (!phone) {
      this.currentMac()?.send(JSON.stringify({ t: 'close', ch }));
      return;
    }
    if (message.byteLength - 4 > MAX_PAYLOAD) {
      this.closePhone(phone, 1009, 'too_big');
      this.currentMac()?.send(JSON.stringify({ t: 'close', ch }));
      return;
    }
    phone.send(message.slice(4));
  }

  private fromPhone(ws: WebSocket, state: PhoneState, message: string | ArrayBuffer) {
    // Text other than `ping` (answered without waking) carries nothing for the Mac.
    if (typeof message === 'string') return;
    const mac = this.currentMac();
    if (!mac) return this.closePhone(ws, 4404, 'mac_offline');
    if (message.byteLength > MAX_PAYLOAD) {
      this.closePhone(ws, 1009, 'too_big');
      mac.send(JSON.stringify({ t: 'close', ch: state.ch }));
      return;
    }
    const framed = new Uint8Array(4 + message.byteLength);
    new DataView(framed.buffer).setUint32(0, state.ch);
    framed.set(new Uint8Array(message), 4);
    mac.send(framed);
  }

  /** A socket closed or failed from its own side. */
  private gone(ws: WebSocket) {
    const state = stateOf(ws);
    if (!state) return;
    if (state.role === 'phone') {
      if (state.notified) return;
      ws.serializeAttachment({ ...state, notified: true } satisfies PhoneState);
      this.currentMac()?.send(JSON.stringify({ t: 'close', ch: state.ch }));
      return;
    }
    if (state.authed && !state.replaced && !this.currentMac(ws)) this.closeAllPhones();
  }

  /** The logged-in Mac socket, if any (ignoring `except`, which is going). */
  private currentMac(except?: WebSocket): WebSocket | undefined {
    return this.ctx.getWebSockets('mac').find((ws) => {
      if (ws === except || ws.readyState !== OPEN) return false;
      const s = stateOf(ws);
      return s?.role === 'mac' && s.authed && !s.replaced;
    });
  }

  private openPhones(): WebSocket[] {
    return this.ctx.getWebSockets('phone').filter((ws) => {
      const s = stateOf(ws);
      return ws.readyState === OPEN && s?.role === 'phone' && !s.notified;
    });
  }

  private phone(ch: number): WebSocket | undefined {
    return this.ctx.getWebSockets(channelTag(ch)).find((ws) => ws.readyState === OPEN);
  }

  /** Closes a phone the relay or the Mac chose to close; the Mac isn't told again. */
  private closePhone(ws: WebSocket, code: number, reason: string) {
    const state = stateOf(ws);
    if (state?.role === 'phone') ws.serializeAttachment({ ...state, notified: true });
    closeQuietly(ws, code, reason);
  }

  private closeAllPhones() {
    for (const ws of this.openPhones()) this.closePhone(ws, 4404, 'mac_offline');
  }

  /** Channel ids increase for the object's lifetime (u32, wrapping past 0xffffffff to 1). */
  private async nextChannel(): Promise<number> {
    const last = (await this.ctx.storage.get<number>(CHANNEL_KEY)) ?? 0;
    let ch = last >= 0xffffffff ? 1 : last + 1;
    while (this.phone(ch)) ch = ch >= 0xffffffff ? 1 : ch + 1;
    await this.ctx.storage.put(CHANNEL_KEY, ch);
    return ch;
  }
}

/** Accepts and closes at once, so the phone gets a reason instead of a failed upgrade. */
function refuse(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

function channelTag(ch: number): string {
  return `ch:${ch}`;
}

function isChannel(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

function stateOf(ws: WebSocket): State | null {
  return (ws.deserializeAttachment() as State | null) ?? null;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function closeQuietly(ws: WebSocket, code: number, reason?: string) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}
