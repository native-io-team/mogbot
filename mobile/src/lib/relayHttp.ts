/**
 * HTTP over the relay (docs/relay.md, "HTTP over the channel"): what the
 * Tailscale route does in plain HTTP (identity, pairing, blobs, attachments)
 * as `http` / `httpRes` / `httpBody` frames inside the end to end channel.
 *
 * One short-lived `RelaySocket` per request: nothing to multiplex, nothing
 * held open, and a request can never wait on another's bytes. The channel's
 * handshake proves the Mac before the request goes, so even the unauthenticated
 * routes (`/v1/identity`, `/v1/pair`) only ever reach the pinned Mac.
 */

import {
  RELAY_HTTP_CHUNK,
  toBase64Url,
  type RelayHttpBody,
  type RelayHttpRequest,
  type RelayHttpResponse,
} from '@shipstudio/companion-protocol';
import { fromBase64Url } from './identity';
import { RelaySocket, type RelaySocketOptions } from './relaySocket';
import { pairedComputer } from './computer';

/** The relay socket closed before the answer was whole; `code` says why (`RELAY_CLOSE_MAC_OFFLINE`…). */
export class RelayClosed extends Error {
  constructor(readonly code: number) {
    super(`relay closed ${code}`);
  }
}

export type RelayHttpDeps = RelaySocketOptions;

export interface RelayHttpInit {
  method: string;
  /** `/v1/…`, with any query. */
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
  /** Give up when nothing arrives for this long (none by default: pairing waits on the desk). */
  idleMs?: number;
  /** The fraction of the body handed to the socket, 0 to 1. */
  onProgress?: (fraction: number) => void;
}

export interface RelayHttpAnswer {
  status: number;
  /** As the Mac sent them; read with `header`. */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A header by name, whatever its case. */
export const header = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const enc = new TextEncoder();
const dec = new TextDecoder();

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The request's frames: the head with the first piece of body, then the rest. */
export function requestFrames(
  id: number,
  init: RelayHttpInit
): (RelayHttpRequest | RelayHttpBody)[] {
  const body = typeof init.body === 'string' ? enc.encode(init.body) : init.body;
  const head: RelayHttpRequest = {
    t: 'http',
    id,
    method: init.method,
    path: init.path,
    headers: init.headers ?? {},
  };
  if (!body || !body.length) return [head];
  const pieces: Uint8Array[] = [];
  for (let at = 0; at < body.length; at += RELAY_HTTP_CHUNK) {
    pieces.push(body.subarray(at, at + RELAY_HTTP_CHUNK));
  }
  head.body = toBase64Url(pieces[0]);
  if (pieces.length === 1) return [head];
  head.more = true;
  return [
    head,
    ...pieces.slice(1).map(
      (p, i): RelayHttpBody => ({
        t: 'httpBody',
        id,
        body: toBase64Url(p),
        more: i < pieces.length - 2,
      })
    ),
  ];
}

/** One request to the pinned Mac at the relay `url`, on a socket of its own. */
export function relayRequest(
  url: string,
  deps: RelayHttpDeps,
  init: RelayHttpInit
): Promise<RelayHttpAnswer> {
  const comp = pairedComputer();
  return new Promise((resolve, reject) => {
    const id = 1;
    const socket = new RelaySocket(url, deps);
    let status = 0;
    let headers: Record<string, string> = {};
    const parts: Uint8Array[] = [];
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | null = null;

    const end = (error?: unknown, answer?: RelayHttpAnswer) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      init.signal?.removeEventListener('abort', onAbort);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      if (answer) resolve(answer);
      else reject(error);
    };
    const touch = () => {
      if (!init.idleMs) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => end(new Error(`${comp.theCap} stopped answering.`)), init.idleMs);
    };
    const onAbort = () => end(new DOMExceptionLike('Aborted', 'AbortError'));
    if (init.signal?.aborted) return onAbort();
    init.signal?.addEventListener('abort', onAbort);
    touch();

    socket.onopen = () => {
      touch();
      const frames = requestFrames(id, init);
      const total = frames.length;
      frames.forEach((f, i) => {
        socket.send(JSON.stringify(f));
        init.onProgress?.((i + 1) / total);
      });
    };
    socket.onmessage = (ev) => {
      touch();
      let frame: RelayHttpResponse | RelayHttpBody;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!frame || frame.id !== id) return;
      if (frame.t === 'httpRes') {
        status = typeof frame.status === 'number' ? frame.status : 0;
        headers = frame.headers && typeof frame.headers === 'object' ? frame.headers : {};
      } else if (frame.t !== 'httpBody' || !status) {
        return;
      }
      if (typeof frame.body === 'string' && frame.body) {
        const bytes = fromBase64Url(frame.body);
        if (!bytes) return end(new Error(`${comp.theCap}’s answer couldn’t be read.`));
        parts.push(bytes);
      }
      if (!frame.more)
        end(undefined, { status, headers, body: join(parts.length ? parts : [new Uint8Array(0)]) });
    };
    socket.onclose = (ev) => end(new RelayClosed((ev as { code?: number })?.code ?? 1006));
  });
}

/** Relayed requests a phone keeps open at once, beside its chat socket. */
export const RELAY_HTTP_AT_ONCE = 3;
/** Tries for a request the relay turned away as one socket too many (4429). */
const RELAY_BUSY_TRIES = 4;
const RELAY_BUSY_WAIT_MS = 700;

let running = 0;
const queue: (() => void)[] = [];
const slot = () =>
  new Promise<void>((go) => {
    if (running < RELAY_HTTP_AT_ONCE) {
      running++;
      go();
    } else queue.push(go);
  });
const free = () => {
  const next = queue.shift();
  if (next) next();
  else running--;
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `relayRequest`, at most {@link RELAY_HTTP_AT_ONCE} at a time: each is a
 * socket of its own and the relay caps how many one phone holds, so a chat
 * full of pictures used to have most of them turned away (4429) and drawn as
 * empty boxes. One turned away anyway waits and goes again.
 */
export async function queuedRelayRequest(
  url: string,
  deps: RelayHttpDeps,
  init: RelayHttpInit
): Promise<RelayHttpAnswer> {
  await slot();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await relayRequest(url, deps, init);
      } catch (e) {
        const busy = e instanceof RelayClosed && e.code === 4429;
        if (!busy || attempt >= RELAY_BUSY_TRIES || init.signal?.aborted) throw e;
        await pause(RELAY_BUSY_WAIT_MS * attempt);
      }
    }
  } finally {
    free();
  }
}

/** Hermes has no DOMException; an abort still reads as one by its name. */
class DOMExceptionLike extends Error {
  constructor(
    message: string,
    override readonly name: string
  ) {
    super(message);
  }
}

/**
 * Just enough of `fetch` for the pairing flow (`pairFlow.ts`): a path on the
 * pinned Mac, answered over the relay.
 */
export function relayFetch(url: string, deps: RelayHttpDeps) {
  return async (
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
  ) => {
    const res = await relayRequest(url, deps, { ...init, path });
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: async () => JSON.parse(dec.decode(res.body)) as unknown,
      text: async () => dec.decode(res.body),
    };
  };
}
