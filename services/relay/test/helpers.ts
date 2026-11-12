import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { fingerprintOf, macLoginMessage, toB64url } from '../src/auth';

type Msg = string | ArrayBuffer;

/** A client socket with its messages queued, so a test can await the next one. */
export class Client {
  private queue: Msg[] = [];
  private waiters: ((m: Msg) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    // Binary arrives as ArrayBuffer, as the phone and Mac ask for.
    (ws as { binaryType: string }).binaryType = 'arraybuffer';
    ws.accept();
    ws.addEventListener('message', (e) => {
      const data = e.data as Msg;
      const w = this.waiters.shift();
      if (w) w(data);
      else this.queue.push(data);
    });
    this.closed = new Promise((resolve) =>
      ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
    );
  }

  next(ms = 2000): Promise<Msg> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (m: Msg) => {
        clearTimeout(t);
        resolve(m);
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('no message'));
      }, ms);
      this.waiters.push(waiter);
    });
  }

  async json(): Promise<Record<string, unknown>> {
    const m = await this.next();
    if (typeof m !== 'string') throw new Error('expected text');
    return JSON.parse(m);
  }

  async bytes(): Promise<Uint8Array> {
    const m = await this.next();
    if (typeof m === 'string') throw new Error(`expected binary, got ${m}`);
    return new Uint8Array(m);
  }

  /** Resolves true if nothing arrives within `ms`. */
  async silent(ms = 150): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }
}

let ipCounter = 0;
/** Opens a socket through the deployed config, or through the Worker with `withEnv` (accounts on). */
export async function open(path: string, withEnv?: Env): Promise<Client> {
  const req = new Request(`https://relay.test${path}`, {
    headers: { Upgrade: 'websocket', 'cf-connecting-ip': `203.0.113.${++ipCounter % 250}` },
  });
  const res = withEnv ? await worker.fetch(req, withEnv) : await SELF.fetch(req);
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

export type Mac = { fingerprint: string; publicKey: string; key: CryptoKey };

export async function newMacKey(): Promise<Mac> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { fingerprint: await fingerprintOf(raw), publicKey: toB64url(raw), key: pair.privateKey };
}

export async function sign(mac: Mac, nonce: string, fingerprint = mac.fingerprint): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    mac.key,
    new TextEncoder().encode(macLoginMessage(nonce, fingerprint))
  );
  return toB64url(new Uint8Array(sig));
}

/** Connects and logs in a Mac; returns its socket after `ready`. */
export async function loginMac(
  mac: Mac,
  withEnv?: Env,
  account: unknown = null
): Promise<Client> {
  const ws = await open(`/v1/mac/${mac.fingerprint}`, withEnv);
  const challenge = await ws.json();
  expect(challenge.t).toBe('challenge');
  ws.ws.send(
    JSON.stringify({
      t: 'auth',
      v: 1,
      publicKey: mac.publicKey,
      signature: await sign(mac, challenge.nonce as string),
    })
  );
  expect(await ws.json()).toEqual({ t: 'ready', account });
  return ws;
}

/** Connects a phone and returns it with the channel the Mac was told about. */
export async function openPhone(
  mac: Mac,
  macWs: Client,
  withEnv?: Env
): Promise<{ phone: Client; ch: number }> {
  const phone = await open(`/v1/phone/${mac.fingerprint}`, withEnv);
  const opened = await macWs.json();
  expect(opened.t).toBe('open');
  return { phone, ch: opened.ch as number };
}

export function framed(ch: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, ch);
  out.set(payload, 4);
  return out;
}
