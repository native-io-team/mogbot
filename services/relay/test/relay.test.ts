import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import {
  PAIRING_SCHEME,
  fingerprintOf,
  macLoginMessage,
  toB64url,
  verifyMacLogin,
} from '../src/auth';
import { MAX_PAYLOAD, MAX_PHONES, type MacRelay } from '../src/mac';
import { PAIRING_SCHEME as BRAND_SCHEME } from '../../../packages/companion-protocol/src/brand.gen';
import vectors from '../../../packages/companion-protocol/src/relayVectors.json';

type Msg = string | ArrayBuffer;

/** A client socket with its messages queued, so a test can await the next one. */
class Client {
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
async function open(path: string): Promise<Client> {
  const res = await SELF.fetch(`https://relay.test${path}`, {
    headers: { Upgrade: 'websocket', 'cf-connecting-ip': `203.0.113.${++ipCounter % 250}` },
  });
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

type Mac = { fingerprint: string; publicKey: string; key: CryptoKey };

async function newMacKey(): Promise<Mac> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { fingerprint: await fingerprintOf(raw), publicKey: toB64url(raw), key: pair.privateKey };
}

async function sign(mac: Mac, nonce: string, fingerprint = mac.fingerprint): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    mac.key,
    new TextEncoder().encode(macLoginMessage(nonce, fingerprint))
  );
  return toB64url(new Uint8Array(sig));
}

/** Connects and logs in a Mac; returns its socket after `ready`. */
async function loginMac(mac: Mac): Promise<Client> {
  const ws = await open(`/v1/mac/${mac.fingerprint}`);
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
  expect(await ws.json()).toEqual({ t: 'ready' });
  return ws;
}

/** Connects a phone and returns it with the channel the Mac was told about. */
async function openPhone(mac: Mac, macWs: Client): Promise<{ phone: Client; ch: number }> {
  const phone = await open(`/v1/phone/${mac.fingerprint}`);
  const opened = await macWs.json();
  expect(opened.t).toBe('open');
  return { phone, ch: opened.ch as number };
}

function framed(ch: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, ch);
  out.set(payload, 4);
  return out;
}

describe('routes', () => {
  it('answers health and refuses the rest', async () => {
    expect(await (await SELF.fetch('https://relay.test/')).text()).toBe('ok');
    expect((await SELF.fetch('https://relay.test/health')).status).toBe(200);
    expect((await SELF.fetch('https://relay.test/v2/mac/x')).status).toBe(404);
    expect((await SELF.fetch('https://relay.test/v1/mac/short')).status).toBe(400);
    expect(
      (await SELF.fetch('https://relay.test/v1/phone/' + 'a'.repeat(21) + '!')).status
    ).toBe(400);
    // Right shape but not a WebSocket upgrade.
    expect((await SELF.fetch('https://relay.test/v1/mac/' + 'a'.repeat(22))).status).toBe(
      426
    );
  });

  it('rate limits new connections when a limiter is bound', async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await worker.fetch(
      new Request('https://relay.test/v1/phone/' + 'a'.repeat(22), {
        headers: { Upgrade: 'websocket' },
      }),
      { MAC: env.MAC, RATE_LIMITER: limiter }
    );
    expect(res.status).toBe(429);
  });
});

describe('Mac login', () => {
  it('takes its scheme from brand.json', () => {
    expect(PAIRING_SCHEME).toBe(BRAND_SCHEME);
  });

  it('matches the shared test vector', async () => {
    const v = vectors.macLogin;
    expect(macLoginMessage(v.nonce, vectors.fingerprint)).toBe(v.message);
    expect(await verifyMacLogin(vectors.fingerprint, v.nonce, v.publicKey, v.signature)).toBe(true);
    // Any change breaks it.
    expect(
      await verifyMacLogin(vectors.fingerprint, v.nonce.replace('B', 'C'), v.publicKey, v.signature)
    ).toBe(false);
    expect(await verifyMacLogin('A'.repeat(22), v.nonce, v.publicKey, v.signature)).toBe(false);
  });

  it('logs in with a good signature', async () => {
    const mac = await newMacKey();
    const ws = await loginMac(mac);
    ws.ws.close(1000);
  });

  it('gives each socket its own 32-byte nonce', async () => {
    const mac = await newMacKey();
    const a = await (await open(`/v1/mac/${mac.fingerprint}`)).json();
    const b = await (await open(`/v1/mac/${mac.fingerprint}`)).json();
    expect(a.nonce).not.toBe(b.nonce);
    expect((a.nonce as string).length).toBe(43);
  });

  it('closes 4401 on a bad signature', async () => {
    const mac = await newMacKey();
    const ws = await open(`/v1/mac/${mac.fingerprint}`);
    const { nonce } = await ws.json();
    const signature = await sign(mac, (nonce as string).split('').reverse().join(''));
    ws.ws.send(JSON.stringify({ t: 'auth', v: 1, publicKey: mac.publicKey, signature }));
    expect((await ws.closed).code).toBe(4401);
  });

  it("closes 4401 on another Mac's key", async () => {
    const mac = await newMacKey();
    const other = await newMacKey();
    const ws = await open(`/v1/mac/${mac.fingerprint}`);
    const { nonce } = await ws.json();
    // A valid signature, but by a key whose fingerprint isn't this slot's.
    const signature = await sign(other, nonce as string, mac.fingerprint);
    ws.ws.send(JSON.stringify({ t: 'auth', v: 1, publicKey: other.publicKey, signature }));
    expect((await ws.closed).code).toBe(4401);
  });

  it('closes 4401 on anything but an auth frame', async () => {
    const mac = await newMacKey();
    const ws = await open(`/v1/mac/${mac.fingerprint}`);
    await ws.json();
    ws.ws.send('not json');
    expect((await ws.closed).code).toBe(4401);
  });

  it('closes 4401 when auth never arrives', async () => {
    const mac = await newMacKey();
    const ws = await open(`/v1/mac/${mac.fingerprint}`);
    await ws.json();
    const stub = env.MAC.get(env.MAC.idFromName(mac.fingerprint));
    // Pull the deadline in rather than wait 10 s.
    await runInDurableObject(stub, (_: MacRelay, state) => {
      for (const s of state.getWebSockets('mac')) {
        s.serializeAttachment({ ...(s.deserializeAttachment() as object), deadline: 0 });
      }
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await ws.closed).toEqual({ code: 4401, reason: 'auth_timeout' });
  });

  it('answers ping with pong', async () => {
    const mac = await newMacKey();
    const ws = await loginMac(mac);
    ws.ws.send('ping');
    expect(await ws.next()).toBe('pong');
  });

  it('a newer Mac replaces the older one (4409) and its phones reconnect', async () => {
    const mac = await newMacKey();
    const first = await loginMac(mac);
    const { phone } = await openPhone(mac, first);
    const second = await loginMac(mac);
    expect((await first.closed).code).toBe(4409);
    expect(await phone.closed).toEqual({ code: 4404, reason: 'mac_offline' });
    // The new Mac isn't told about the old one's channels, and it carries on.
    expect(await second.silent()).toBe(true);
    const again = await openPhone(mac, second);
    again.phone.ws.send(new Uint8Array([9]));
    expect(Array.from(await second.bytes())).toEqual(Array.from(framed(again.ch, new Uint8Array([9]))));
  });
});

describe('phones', () => {
  it('closes 4404 mac_offline when the Mac isn’t there', async () => {
    const mac = await newMacKey();
    const phone = await open(`/v1/phone/${mac.fingerprint}`);
    expect(await phone.closed).toEqual({ code: 4404, reason: 'mac_offline' });
  });

  it('closes 4404 when only an unauthenticated Mac is there', async () => {
    const mac = await newMacKey();
    const pending = await open(`/v1/mac/${mac.fingerprint}`);
    await pending.json();
    const phone = await open(`/v1/phone/${mac.fingerprint}`);
    expect((await phone.closed).code).toBe(4404);
  });

  it('carries bytes both ways with channel headers', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const a = await openPhone(mac, macWs);
    const b = await openPhone(mac, macWs);
    expect(b.ch).toBeGreaterThan(a.ch);

    a.phone.ws.send(new Uint8Array([1, 2, 3]));
    expect(Array.from(await macWs.bytes())).toEqual(Array.from(framed(a.ch, new Uint8Array([1, 2, 3]))));
    b.phone.ws.send(new Uint8Array([4]));
    expect(Array.from(await macWs.bytes())).toEqual(Array.from(framed(b.ch, new Uint8Array([4]))));

    macWs.ws.send(framed(b.ch, new Uint8Array([7, 8])));
    expect(Array.from(await b.phone.bytes())).toEqual([7, 8]);
    macWs.ws.send(framed(a.ch, new Uint8Array([])));
    expect(Array.from(await a.phone.bytes())).toEqual([]);
    expect(await b.phone.silent()).toBe(true);
  });

  it('ignores text from phones and non-JSON text from the Mac', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const { phone, ch } = await openPhone(mac, macWs);
    phone.ws.send('hello');
    macWs.ws.send('{not json');
    macWs.ws.send(JSON.stringify({ t: 'something' }));
    expect(await macWs.silent()).toBe(true);
    phone.ws.send('ping');
    expect(await phone.next()).toBe('pong');
    macWs.ws.send(framed(ch, new Uint8Array([5])));
    expect(Array.from(await phone.bytes())).toEqual([5]);
  });

  it('tells the Mac when a phone goes', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const { phone, ch } = await openPhone(mac, macWs);
    phone.ws.close(1000, 'bye');
    expect(await macWs.json()).toEqual({ t: 'close', ch });
  });

  it('closes a phone 1000 when the Mac says so, without echoing', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const { phone, ch } = await openPhone(mac, macWs);
    macWs.ws.send(JSON.stringify({ t: 'close', ch }));
    expect((await phone.closed).code).toBe(1000);
    expect(await macWs.silent()).toBe(true);
  });

  it('closes every phone 4404 when the Mac goes', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const a = await openPhone(mac, macWs);
    const b = await openPhone(mac, macWs);
    macWs.ws.close(1000);
    expect(await a.phone.closed).toEqual({ code: 4404, reason: 'mac_offline' });
    expect(await b.phone.closed).toEqual({ code: 4404, reason: 'mac_offline' });
  });

  it(`allows ${MAX_PHONES} phones per Mac, then 4429`, async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const phones = [];
    for (let i = 0; i < MAX_PHONES; i++) phones.push(await openPhone(mac, macWs));
    const extra = await open(`/v1/phone/${mac.fingerprint}`);
    expect((await extra.closed).code).toBe(4429);
    expect(await macWs.silent()).toBe(true);
    // A slot frees when one goes.
    phones[0].phone.ws.close(1000);
    expect(await macWs.json()).toEqual({ t: 'close', ch: phones[0].ch });
    await openPhone(mac, macWs);
  });

  it('closes 1009 on a payload over 256 KiB', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const { phone, ch } = await openPhone(mac, macWs);
    phone.ws.send(new Uint8Array(MAX_PAYLOAD + 1));
    expect((await phone.closed).code).toBe(1009);
    expect(await macWs.json()).toEqual({ t: 'close', ch });
  });

  it('passes a payload of exactly 256 KiB', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    const { phone, ch } = await openPhone(mac, macWs);
    phone.ws.send(new Uint8Array(MAX_PAYLOAD));
    expect((await macWs.bytes()).length).toBe(MAX_PAYLOAD + 4);
    macWs.ws.send(framed(ch, new Uint8Array(MAX_PAYLOAD + 1)));
    expect((await phone.closed).code).toBe(1009);
    expect(await macWs.json()).toEqual({ t: 'close', ch });
  });
});
