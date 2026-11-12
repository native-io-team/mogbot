import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { toB64url } from '../src/auth';
import { frontendApiOf } from '../src/link';
import { PENDING_KEY, type MacRelay, type PendingLink } from '../src/mac';
import { type Client, type Mac, loginMac, newMacKey, open, openPhone } from './helpers';

const ISSUER = 'https://clerk.example.test';
const ORIGIN = 'https://relay.test';
// pk_test_ + base64("clerk.example.test$")
const PUBLISHABLE_KEY = `pk_test_${btoa('clerk.example.test$')}`;

type Signer = { kid: string; key: CryptoKey; jwk: JsonWebKey };

async function newSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { kid, key: pair.privateKey, jwk };
}

function b64json(v: unknown): string {
  return toB64url(new TextEncoder().encode(JSON.stringify(v)));
}

async function token(
  signer: Signer,
  claims: Record<string, unknown> = {},
  kid = signer.kid
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    sub: 'user_123',
    email: 'me@example.com',
    iss: ISSUER,
    azp: ORIGIN,
    iat: now,
    nbf: now - 10,
    exp: now + 60,
    ...claims,
  };
  const signed = `${b64json({ alg: 'RS256', kid, typ: 'JWT' })}.${b64json(body)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signer.key,
    new TextEncoder().encode(signed)
  );
  return `${signed}.${toB64url(new Uint8Array(sig))}`;
}

let jwksCounter = 0;
let signer: Signer;
/** The fake Clerk Backend API: each user's status, and what was asked. */
let clerkUsers: Map<string, number>;
let clerkCalls: string[];
let accountsEnv: Env;

beforeEach(async () => {
  signer = await newSigner('key-1');
  clerkUsers = new Map([['user_123', 200]]);
  clerkCalls = [];
  // A fresh JWKS address per test, so the in-memory key cache never carries over.
  const jwksUrl = `${ISSUER}/.well-known/jwks-${++jwksCounter}.json`;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === jwksUrl) {
      return Response.json({ keys: [{ ...signer.jwk, kid: signer.kid, use: 'sig', alg: 'RS256' }] });
    }
    const user = /^https:\/\/clerk-api\.test\/v1\/users\/(.+)$/.exec(url)?.[1];
    if (user !== undefined) {
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      const auth = new Headers(input instanceof Request ? input.headers : init?.headers).get('authorization');
      clerkCalls.push(`${method} ${user}`);
      if (auth !== 'Bearer sk_test_fake') return new Response('no', { status: 401 });
      const status = clerkUsers.get(user) ?? 404;
      if (method === 'DELETE' && status === 200) clerkUsers.set(user, 404);
      return new Response(status === 200 ? '{}' : 'not found', { status });
    }
    return realFetch(input, init);
  });
  accountsEnv = {
    MAC: env.MAC,
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    CLERK_JWKS_URL: jwksUrl,
    CLERK_ISSUER: ISSUER,
    CLERK_AUTHORIZED_PARTIES: `https://other.test, ${ORIGIN}`,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function newCode(mac: Mac): string {
  return `${mac.fingerprint}.${toB64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function stubOf(mac: Mac) {
  return env.MAC.get(env.MAC.idFromName(mac.fingerprint));
}

async function pending(mac: Mac): Promise<PendingLink | undefined> {
  return runInDurableObject(stubOf(mac), (_: MacRelay, state) =>
    state.storage.get<PendingLink>(PENDING_KEY)
  );
}

/** Sends linkStart and waits until the Durable Object has stored it. */
async function startLink(mac: Mac, macWs: Client, code = newCode(mac)): Promise<string> {
  const before = (await pending(mac))?.codeHash;
  macWs.ws.send(JSON.stringify({ t: 'linkStart', code }));
  for (let i = 0; i < 50; i++) {
    const p = await pending(mac);
    if (p && p.codeHash !== before) return code;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('linkStart never stored');
}

async function postLink(body: unknown, e: Env = accountsEnv): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}/v1/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    e
  );
}

/** Logs a Mac in with accounts on and links it to `user_123`. */
async function linkedMac(): Promise<{ mac: Mac; macWs: Client }> {
  const mac = await newMacKey();
  const macWs = await loginMac(mac, accountsEnv);
  const code = await startLink(mac, macWs);
  const res = await postLink({ code, token: await token(signer) });
  expect(await res.json()).toEqual({ ok: true });
  expect(await macWs.json()).toEqual({
    t: 'account',
    account: { id: 'user_123', email: 'me@example.com' },
  });
  return { mac, macWs };
}

describe('linking', () => {
  it('links a Mac, tells it, and ready carries the account next time', async () => {
    const { mac, macWs } = await linkedMac();
    // The code is gone: single use.
    expect(await pending(mac)).toBeUndefined();
    macWs.ws.close(1000);
    await loginMac(mac, accountsEnv, { id: 'user_123', email: 'me@example.com' });
    // Ready carries it with accounts off too.
    await loginMac(mac, undefined, { id: 'user_123', email: 'me@example.com' });
  });

  it('stores only the hash of the code, for 10 minutes', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    const p = (await pending(mac))!;
    expect(JSON.stringify(p)).not.toContain(code.split('.')[1]);
    expect(p.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(p.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it('gives a null email when the token has no email claim', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    const res = await postLink({ code, token: await token(signer, { email: undefined }) });
    expect(res.status).toBe(200);
    expect(await macWs.json()).toEqual({ t: 'account', account: { id: 'user_123', email: null } });
  });

  it('refuses a used code', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    expect((await postLink({ code, token: await token(signer) })).status).toBe(200);
    const again = await postLink({ code, token: await token(signer) });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ ok: false, reason: 'code_unknown' });
  });

  it('refuses a wrong code, and one replaced by a newer code', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const first = await startLink(mac, macWs);
    const wrong = await postLink({ code: newCode(mac), token: await token(signer) });
    expect(await wrong.json()).toMatchObject({ ok: false, reason: 'code_unknown' });
    await startLink(mac, macWs);
    const replaced = await postLink({ code: first, token: await token(signer) });
    expect(await replaced.json()).toMatchObject({ ok: false, reason: 'code_unknown' });
    expect(await macWs.silent()).toBe(true);
  });

  it('refuses an expired code', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    await runInDurableObject(stubOf(mac), async (_: MacRelay, state) => {
      const p = (await state.storage.get<PendingLink>(PENDING_KEY))!;
      await state.storage.put(PENDING_KEY, { ...p, expiresAt: Date.now() - 1 });
    });
    const res = await postLink({ code, token: await token(signer) });
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, reason: 'code_expired' });
    expect(body.message).toMatch(/expired/);
    expect(await pending(mac)).toBeUndefined();
  });

  it('ignores a malformed linkStart, or one for another Mac', async () => {
    const mac = await newMacKey();
    const other = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    macWs.ws.send(JSON.stringify({ t: 'linkStart', code: 'nope' }));
    macWs.ws.send(JSON.stringify({ t: 'linkStart', code: newCode(other) }));
    macWs.ws.send(JSON.stringify({ t: 'linkStart', code: `${mac.fingerprint}.${'A'.repeat(42)}` }));
    expect(await macWs.silent()).toBe(true);
    expect(await pending(mac)).toBeUndefined();
  });

  it('refuses malformed requests', async () => {
    const mac = await newMacKey();
    const t = await token(signer);
    expect((await postLink('not json')).status).toBe(400);
    for (const code of [
      undefined,
      mac.fingerprint,
      `${mac.fingerprint}.${'A'.repeat(42)}`,
      `${'!'.repeat(22)}.${'A'.repeat(43)}`,
      `${mac.fingerprint}.${'A'.repeat(43)}.x`,
    ]) {
      const res = await postLink({ code, token: t });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, reason: 'code_invalid' });
    }
    // GET isn't a route.
    expect((await worker.fetch(new Request(`${ORIGIN}/v1/link`), accountsEnv)).status).toBe(404);
  });

  it('lets exactly one of two requests racing with one code link', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    const [a, b] = await Promise.all([
      postLink({ code, token: await token(signer, { sub: 'user_a' }) }),
      postLink({ code, token: await token(signer, { sub: 'user_b' }) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect((await macWs.json()).t).toBe('account');
    expect(await macWs.silent()).toBe(true);
  });

  it('refuses a body over 16 KiB without reading it all', async () => {
    const res = await postLink(JSON.stringify({ code: 'x', token: 'y'.repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it('is off when no JWKS is configured', async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/link`, {
      method: 'POST',
      body: JSON.stringify({ code: 'x', token: 'y' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'accounts_off' });
  });
});

describe('session tokens', () => {
  async function refused(t: string, reason = 'token_invalid') {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    const res = await postLink({ code, token: t });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, reason });
    // Nothing bound, and the code still works.
    expect(await macWs.silent()).toBe(true);
    expect(await pending(mac)).toBeDefined();
  }

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused(await token(signer, { exp: now - 120 }), 'token_expired');
  });

  it('allows 60 s of clock skew', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    const now = Math.floor(Date.now() / 1000);
    const t = await token(signer, { exp: now - 30, nbf: now + 30 });
    expect((await postLink({ code, token: t })).status).toBe(200);
  });

  it('refuses a token not valid yet', async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused(await token(signer, { nbf: now + 120, exp: now + 300 }));
  });

  it('refuses an unknown kid', async () => {
    await refused(await token(signer, {}, 'key-2'));
  });

  it('refuses a signature by another key under the right kid', async () => {
    const impostor = await newSigner('key-1');
    await refused(await token(impostor));
  });

  it('refuses the wrong issuer', async () => {
    await refused(await token(signer, { iss: 'https://evil.test' }));
  });

  it('refuses an unlisted authorized party, or none', async () => {
    await refused(await token(signer, { azp: 'https://evil.test' }));
    await refused(await token(signer, { azp: undefined }));
  });

  it('refuses a token without a subject, or not a JWT', async () => {
    await refused(await token(signer, { sub: undefined }));
    await refused('not.a.jwt');
    await refused('');
  });

  it('says so when the keys can’t be fetched', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const code = await startLink(mac, macWs);
    const down = { ...accountsEnv, CLERK_JWKS_URL: `${ISSUER}/down-${++jwksCounter}.json` };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
    const res = await postLink({ code, token: await token(signer) }, down);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'keys_unavailable' });
  });
});

describe('gating phones', () => {
  it('closes 4402 sign_in_needed before the Mac is linked, then lets phones in', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    const early = await open(`/v1/phone/${mac.fingerprint}`, accountsEnv);
    expect(await early.closed).toEqual({ code: 4402, reason: 'sign_in_needed' });
    expect(await macWs.silent()).toBe(true);

    const code = await startLink(mac, macWs);
    await postLink({ code, token: await token(signer) });
    expect((await macWs.json()).t).toBe('account');
    const { phone } = await openPhone(mac, macWs, accountsEnv);
    phone.ws.send(new Uint8Array([1]));
    expect((await macWs.bytes()).length).toBe(5);
  });

  it('says offline before sign-in: no Mac means 4404', async () => {
    const mac = await newMacKey();
    const phone = await open(`/v1/phone/${mac.fingerprint}`, accountsEnv);
    expect(await phone.closed).toEqual({ code: 4404, reason: 'mac_offline' });
  });

  it('lets every phone in with accounts off', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac);
    await openPhone(mac, macWs);
  });

  it('unlink drops the account, tells the Mac and closes its phones 4402', async () => {
    const { mac, macWs } = await linkedMac();
    const a = await openPhone(mac, macWs, accountsEnv);
    const b = await openPhone(mac, macWs, accountsEnv);
    macWs.ws.send(JSON.stringify({ t: 'unlink' }));
    expect(await macWs.json()).toEqual({ t: 'account', account: null });
    expect(await a.phone.closed).toEqual({ code: 4402, reason: 'sign_in_needed' });
    expect(await b.phone.closed).toEqual({ code: 4402, reason: 'sign_in_needed' });
    const closes = [await macWs.json(), await macWs.json()];
    expect(closes).toEqual([
      { t: 'close', ch: a.ch },
      { t: 'close', ch: b.ch },
    ]);
    const late = await open(`/v1/phone/${mac.fingerprint}`, accountsEnv);
    expect((await late.closed).code).toBe(4402);
    macWs.ws.close(1000);
    await loginMac(mac, accountsEnv, null);
  });
});

describe('deleting the account', () => {
  it('deletes it at Clerk, unlinks this Mac and closes its phones', async () => {
    const { mac, macWs } = await linkedMac();
    const a = await openPhone(mac, macWs, accountsEnv);
    macWs.ws.send(JSON.stringify({ t: 'deleteAccount' }));
    expect(await macWs.json()).toEqual({ t: 'account', account: null });
    expect(await a.phone.closed).toEqual({ code: 4402, reason: 'sign_in_needed' });
    expect(await macWs.json()).toEqual({ t: 'close', ch: a.ch });
    expect(await macWs.json()).toEqual({ t: 'accountDeleted', ok: true });
    expect(clerkCalls).toContain('DELETE user_123');
    expect(clerkUsers.get('user_123')).toBe(404);
    macWs.ws.close(1000);
    await loginMac(mac, accountsEnv, null);
  });

  it('keeps everything when Clerk refuses, and says so', async () => {
    const { mac, macWs } = await linkedMac();
    clerkUsers.set('user_123', 500);
    macWs.ws.send(JSON.stringify({ t: 'deleteAccount' }));
    expect(await macWs.json()).toEqual({ t: 'accountDeleted', ok: false, error: 'clerk_failed' });
    macWs.ws.close(1000);
    clerkUsers.set('user_123', 200);
    await loginMac(mac, accountsEnv, { id: 'user_123', email: 'me@example.com' });
  });

  it('says not signed in with no account', async () => {
    const mac = await newMacKey();
    const macWs = await loginMac(mac, accountsEnv);
    macWs.ws.send(JSON.stringify({ t: 'deleteAccount' }));
    expect(await macWs.json()).toEqual({ t: 'accountDeleted', ok: false, error: 'not_signed_in' });
    expect(clerkCalls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  });

  it('another Mac on a deleted account is unlinked at its next login', async () => {
    const { mac, macWs } = await linkedMac();
    macWs.ws.close(1000);
    // Deleted from another Mac; this binding was never checked, so this login asks.
    clerkUsers.set('user_123', 404);
    await loginMac(mac, accountsEnv, null);
  });

  it('checks at most once a day, and keeps the account when Clerk is down', async () => {
    const { mac, macWs } = await linkedMac();
    macWs.ws.close(1000);
    clerkUsers.set('user_123', 503);
    const again = await loginMac(mac, accountsEnv, { id: 'user_123', email: 'me@example.com' });
    again.ws.close(1000);
    clerkUsers.set('user_123', 200);
    const third = await loginMac(mac, accountsEnv, { id: 'user_123', email: 'me@example.com' });
    third.ws.close(1000);
    const gets = clerkCalls.filter((c) => c === 'GET user_123').length;
    clerkUsers.set('user_123', 404);
    // Checked fine just now: no ask for a day, so the account stays.
    await loginMac(mac, accountsEnv, { id: 'user_123', email: 'me@example.com' });
    expect(clerkCalls.filter((c) => c === 'GET user_123').length).toBe(gets);
  });
});

describe('the /link page', () => {
  async function page(path: string, e: Env = accountsEnv): Promise<{ res: Response; html: string }> {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`), e);
    return { res, html: await res.text() };
  }

  it('loads Clerk from its own frontend API with the publishable key', async () => {
    const mac = await newMacKey();
    const { res, html } = await page(`/link?code=${newCode(mac)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(frontendApiOf(PUBLISHABLE_KEY)).toBe('clerk.example.test');
    expect(html).toContain(
      'src="https://clerk.example.test/npm/@clerk/clerk-js@6/dist/clerk.browser.js"'
    );
    expect(html).toContain(`data-clerk-publishable-key="${PUBLISHABLE_KEY}"`);
    expect(html).toContain('mountSignIn');
    expect(html).toContain("'/v1/link'");
    expect(html).toContain('prefers-color-scheme:dark');
    // The page reads the code from its address; it isn't echoed into the HTML.
    expect(html).not.toContain(mac.fingerprint);
    // Signed in already, it still asks before linking (a link someone sent can't link on its own).
    expect(html).toContain('id="confirm" hidden');
    expect(html).toContain("if (Clerk.isSignedIn) return ask();");
    expect(html).not.toContain('if (Clerk.isSignedIn) return link();');
    // The code leaves the address for the tab's own storage before any redirect.
    expect(html).toContain('sessionStorage');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('serves the page with no code, for a sign-in coming back from Google', async () => {
    const { html } = await page('/link');
    expect(html).toContain('clerk.browser.js');
  });

  it('says a bad code isn’t valid', async () => {
    const { html } = await page('/link?code=nope');
    expect(html).toContain('This link isn’t valid');
    expect(html).not.toContain('clerk.browser.js');
  });

  it('says accounts aren’t set up without a key or a JWKS', async () => {
    const mac = await newMacKey();
    for (const e of [
      { ...accountsEnv, CLERK_PUBLISHABLE_KEY: '' },
      { ...accountsEnv, CLERK_PUBLISHABLE_KEY: 'pk_test_garbage' },
      { ...accountsEnv, CLERK_JWKS_URL: '' },
    ]) {
      const { html } = await page(`/link?code=${newCode(mac)}`, e);
      expect(html).toContain('Accounts aren’t set up');
      expect(html).not.toContain('clerk.browser.js');
    }
    const res = await SELF.fetch(`${ORIGIN}/link?code=${newCode(mac)}`);
    expect(await res.text()).toContain('Accounts aren’t set up');
  });
});
