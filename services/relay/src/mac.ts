import { DurableObject } from 'cloudflare:workers';
import { newNonce, verifyMacLogin } from './auth';
import type { Env } from './env';
import { LINK_TTL_MS, hashCode, linkError, parseLinkCode, sameHash } from './link';

/** The Mac must answer the challenge within this. */
export const AUTH_TIMEOUT_MS = 10_000;
/**
 * Phone sockets one Mac may have open at once. Each picture or file a phone
 * moves opens a short socket of its own beside its chat socket, so 8 (and 4
 * per address) left a chat with a few images empty boxes.
 */
export const MAX_PHONES = 24;
/** Largest payload either way, not counting the Mac's 4-byte channel header. */
export const MAX_PAYLOAD = 256 * 1024;
/**
 * Phone sockets from one address (a keyed hash of it, from the Worker) to one
 * Mac at once, so a single stranger who knows the fingerprint can't hold all
 * of {@link MAX_PHONES}.
 */
export const MAX_PHONES_PER_ADDRESS = 12;
/**
 * Mac sockets still to answer the challenge. Past this the oldest is closed,
 * never the newcomer: a stranger can't keep the real Mac out by holding a
 * few unanswered sockets open.
 */
export const MAX_PENDING_MACS = 4;

/** The account this Mac is signed in to (docs/relay.md, "Accounts"). */
export type Binding = {
  id: string;
  email: string | null;
  linkedAt: number;
  /** When Clerk last said the account exists (see `checkStillThere`). */
  checkedAt?: number;
};

/** How often a Mac's login re-checks that its account still exists. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

function clerkApi(env: Env): string {
  return (env.CLERK_API_URL?.trim() || 'https://api.clerk.com').replace(/\/$/, '');
}
/** The one link code waiting, by its SHA-256. */
export type PendingLink = { codeHash: string; expiresAt: number };

export const ACCOUNT_KEY = 'account';
export const PENDING_KEY = 'linkPending';

type MacState = {
  role: 'mac';
  fingerprint: string;
  /** The Worker has accounts on, so unlinking signs this Mac's phones out. */
  accounts?: boolean;
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
 * sockets' tags and attachments (and, in storage, the channel counter, the
 * Mac's account binding and its one pending link code), so the object can
 * hibernate between messages.
 */
export class MacRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, role, fingerprint] = url.pathname.split('/');
    const accounts = url.searchParams.get('accounts') === '1';
    if (role === 'mac') return this.acceptMac(fingerprint, accounts);
    if (role === 'phone') return this.acceptPhone(accounts, url.searchParams.get('from') ?? '');
    if (role === 'link' && request.method === 'POST') return this.completeLink(request);
    return new Response('not found', { status: 404 });
  }

  private async acceptMac(fingerprint: string, accounts: boolean): Promise<Response> {
    // Strangers' unanswered sockets: the oldest goes, so the newest (perhaps
    // the real Mac) always gets its challenge.
    const pending: { ws: WebSocket; deadline: number }[] = [];
    for (const ws of this.ctx.getWebSockets('mac')) {
      const s = stateOf(ws);
      if (ws.readyState === OPEN && s?.role === 'mac' && !s.authed) {
        pending.push({ ws, deadline: s.deadline });
      }
    }
    pending.sort((a, b) => a.deadline - b.deadline);
    for (const { ws } of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_MACS + 1))) {
      closeQuietly(ws, 4401, 'superseded');
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['mac']);
    const state: MacState = {
      role: 'mac',
      fingerprint,
      nonce: newNonce(),
      deadline: Date.now() + AUTH_TIMEOUT_MS,
      authed: false,
      accounts,
    };
    server.serializeAttachment(state);
    server.send(JSON.stringify({ t: 'challenge', nonce: state.nonce }));
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > state.deadline) await this.ctx.storage.setAlarm(state.deadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptPhone(accounts: boolean, from: string): Promise<Response> {
    if (!this.currentMac()) return refuse(4404, 'mac_offline');
    // Offline wins: a phone is told its Mac needs to sign in only when the Mac is there.
    if (accounts && !(await this.binding())) return refuse(4402, 'sign_in_needed');
    const phones = this.openPhones();
    if (phones.length >= MAX_PHONES) return refuse(4429, 'too_many_phones');
    const fromTag = /^[A-Za-z0-9_-]{1,32}$/.test(from) ? `from:${from}` : null;
    if (fromTag) {
      const same = this.ctx.getWebSockets(fromTag).filter((ws) => phones.includes(ws));
      if (same.length >= MAX_PHONES_PER_ADDRESS) return refuse(4429, 'too_many_phones');
    }
    const ch = await this.nextChannel();
    // The Mac may have gone while the counter was read.
    const mac = this.currentMac();
    if (!mac) return refuse(4404, 'mac_offline');
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['phone', channelTag(ch), ...(fromTag ? [fromTag] : [])]);
    server.serializeAttachment({ role: 'phone', ch } satisfies PhoneState);
    mac.send(JSON.stringify({ t: 'open', ch }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = stateOf(ws);
    if (!state) return;
    if (state.role === 'phone') return this.fromPhone(ws, state, message);
    if (!state.authed) return this.login(ws, state, message);
    return this.fromMac(state, message);
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
    const account = publicAccount(await this.checkStillThere(await this.binding()));
    if (ws.readyState !== OPEN) return;
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
    ws.send(JSON.stringify({ t: 'ready', account }));
  }

  private async fromMac(state: MacState, message: string | ArrayBuffer) {
    if (typeof message === 'string') {
      const frame = parseJson(message);
      if (frame?.t === 'close' && isChannel(frame.ch)) {
        const phone = this.phone(frame.ch);
        if (phone) this.closePhone(phone, 1000, 'closed');
      } else if (frame?.t === 'linkStart') {
        await this.startLink(state, frame.code);
      } else if (frame?.t === 'unlink') {
        await this.unlink(state);
      } else if (frame?.t === 'deleteAccount') {
        await this.deleteAccount(state);
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

  private async binding(): Promise<Binding | undefined> {
    return this.ctx.storage.get<Binding>(ACCOUNT_KEY);
  }

  /** Stores a new link code (by its hash), replacing any older one. Malformed or foreign codes are ignored. */
  private async startLink(state: MacState, code: unknown) {
    if (parseLinkCode(code)?.fingerprint !== state.fingerprint) return;
    const pending: PendingLink = {
      codeHash: await hashCode(code as string),
      expiresAt: Date.now() + LINK_TTL_MS,
    };
    await this.ctx.storage.put(PENDING_KEY, pending);
  }

  private async unlink(state: MacState) {
    await this.ctx.storage.delete([ACCOUNT_KEY, PENDING_KEY]);
    const mac = this.currentMac();
    mac?.send(JSON.stringify({ t: 'account', account: null }));
    if (!state.accounts) return;
    for (const ws of this.openPhones()) {
      const s = stateOf(ws);
      this.closePhone(ws, 4402, 'sign_in_needed');
      // Its channel table stays exact: each phone that went is closed as usual.
      if (s?.role === 'phone') mac?.send(JSON.stringify({ t: 'close', ch: s.ch }));
    }
  }

  /**
   * "Delete my account": the account goes at Clerk (its email and id), then
   * this Mac is unlinked as on sign-out. Other Macs on the account notice on
   * their next login ({@link checkStillThere}). Already gone at Clerk counts
   * as done.
   */
  private async deleteAccount(state: MacState) {
    const answer = (v: Record<string, unknown>) =>
      this.currentMac()?.send(JSON.stringify({ t: 'accountDeleted', ...v }));
    const binding = await this.binding();
    if (!binding) return answer({ ok: false, error: 'not_signed_in' });
    const key = this.env.CLERK_SECRET_KEY?.trim();
    if (!key) return answer({ ok: false, error: 'unavailable' });
    let status = 0;
    try {
      const res = await fetch(`${clerkApi(this.env)}/v1/users/${encodeURIComponent(binding.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${key}` },
      });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status !== 200 && status !== 404) return answer({ ok: false, error: 'clerk_failed' });
    await this.unlink(state);
    answer({ ok: true });
  }

  /**
   * On a Mac's login with an account: once a day, ask Clerk whether the
   * account still exists, so one deleted from another Mac leaves no email
   * here. Only a clear 404 unlinks; any other answer keeps it.
   */
  private async checkStillThere(binding: Binding | undefined): Promise<Binding | undefined> {
    const key = this.env.CLERK_SECRET_KEY?.trim();
    if (!binding || !key) return binding;
    const now = Date.now();
    if (binding.checkedAt && now - binding.checkedAt < CHECK_EVERY_MS) return binding;
    try {
      const res = await fetch(`${clerkApi(this.env)}/v1/users/${encodeURIComponent(binding.id)}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (res.status === 404) {
        await this.ctx.storage.delete([ACCOUNT_KEY, PENDING_KEY]);
        return undefined;
      }
      if (res.ok) {
        const next = { ...binding, checkedAt: now };
        await this.ctx.storage.put(ACCOUNT_KEY, next);
        return next;
      }
    } catch {
      // Unreachable: keep the account; the next login asks again.
    }
    return binding;
  }

  /** From the Worker, after it verified the Clerk token: the code must be this Mac's pending one. */
  private async completeLink(request: Request): Promise<Response> {
    let body: { code?: unknown; account?: { id?: unknown; email?: unknown } };
    try {
      body = await request.json();
    } catch {
      return linkError('bad_request', 400);
    }
    const id = body.account?.id;
    const email = body.account?.email;
    if (typeof body.code !== 'string' || typeof id !== 'string') {
      return linkError('bad_request', 400);
    }
    // Hashed before the read: from the read to the writes below there is no
    // await but storage's own, so two requests with one code can't both pass.
    const hash = await hashCode(body.code);
    const pending = await this.ctx.storage.get<PendingLink>(PENDING_KEY);
    if (!pending || !sameHash(hash, pending.codeHash)) {
      return linkError('code_unknown', 404);
    }
    if (Date.now() > pending.expiresAt) {
      await this.ctx.storage.delete(PENDING_KEY);
      return linkError('code_expired', 410);
    }
    const binding: Binding = {
      id,
      email: typeof email === 'string' ? email : null,
      linkedAt: Date.now(),
    };
    // Single use: the code goes as the binding lands (issued together, so one atomic write).
    await Promise.all([
      this.ctx.storage.delete(PENDING_KEY),
      this.ctx.storage.put(ACCOUNT_KEY, binding),
    ]);
    this.currentMac()?.send(JSON.stringify({ t: 'account', account: publicAccount(binding) }));
    return Response.json({ ok: true });
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

/** What the Mac is told: the account without when it was linked. */
function publicAccount(b: Binding | undefined): { id: string; email: string | null } | null {
  return b ? { id: b.id, email: b.email } : null;
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
