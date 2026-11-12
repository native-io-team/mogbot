import { FINGERPRINT_RE, toB64url } from './auth';
import { verifyClerkToken } from './clerk';
import { accountsOn, type Env } from './env';
import { linkError, linkPage, parseLinkCode } from './link';

export { MacRelay } from './mac';

const ROUTE = /^\/v1\/(mac|phone)\/([^/]+)$/;
/** A `/v1/link` body is a code and a session token: nothing near this. */
const MAX_LINK_BODY = 16 * 1024;

async function limited(request: Request, env: Env): Promise<boolean> {
  if (!env.RATE_LIMITER) return false;
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key: address });
  return !success;
}

/**
 * The Durable Object is told the role, whether accounts are on and, for a
 * phone, a keyed hash of its address (`from`, to cap phones per address);
 * never the address itself.
 */
function inner(
  role: string,
  fingerprint: string,
  env: Env,
  init: RequestInit = {},
  from?: string
): Request {
  const q = new URLSearchParams();
  if (accountsOn(env)) q.set('accounts', '1');
  if (from) q.set('from', from);
  const qs = q.toString();
  return new Request(`https://relay/${role}/${fingerprint}${qs ? `?${qs}` : ''}`, init);
}

/** 16 bytes of SHA-256 over the Mac's fingerprint and the client's address: the same phone, the same tag, per Mac. */
async function addressTag(request: Request, fingerprint: string): Promise<string | undefined> {
  const address = request.headers.get('cf-connecting-ip');
  if (!address) return undefined;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`relay-from:v1\n${fingerprint}\n${address}`)
  );
  return toB64url(new Uint8Array(digest).subarray(0, 16));
}

/** The body as text, or null past `max` bytes (read no further than that). */
async function textUpTo(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function link(request: Request, env: Env): Promise<Response> {
  if (!accountsOn(env)) return linkError('accounts_off', 404);
  if (await limited(request, env)) return linkError('slow_down', 429);
  const text = await textUpTo(request, MAX_LINK_BODY);
  if (text === null) return linkError('bad_request', 413);
  let body: { code?: unknown; token?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return linkError('bad_request', 400);
  }
  if (!body || typeof body !== 'object') return linkError('bad_request', 400);
  const parsed = parseLinkCode(body.code);
  if (!parsed) return linkError('code_invalid', 400);
  const verified = await verifyClerkToken(body.token, {
    jwksUrl: env.CLERK_JWKS_URL!.trim(),
    issuer: env.CLERK_ISSUER?.trim() || undefined,
    authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
  if (!verified.ok) {
    return linkError(verified.reason, verified.reason === 'keys_unavailable' ? 503 : 401);
  }
  const stub = env.MAC.get(env.MAC.idFromName(parsed.fingerprint));
  return stub.fetch(
    inner('link', parsed.fingerprint, env, {
      method: 'POST',
      body: JSON.stringify({
        code: body.code,
        account: { id: verified.userId, email: verified.email },
      }),
    })
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response('ok');
    }
    if (url.pathname === '/link' && request.method === 'GET') {
      return linkPage(url, env.CLERK_PUBLISHABLE_KEY, accountsOn(env));
    }
    if (url.pathname === '/v1/link') {
      if (request.method !== 'POST') return new Response('not found', { status: 404 });
      return link(request, env);
    }
    const route = ROUTE.exec(url.pathname);
    if (!route || request.method !== 'GET') return new Response('not found', { status: 404 });
    const fingerprint = route[2];
    if (!FINGERPRINT_RE.test(fingerprint)) return new Response('bad fingerprint', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket only', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    if (await limited(request, env)) return new Response('slow down', { status: 429 });
    const stub = env.MAC.get(env.MAC.idFromName(fingerprint));
    const from = route[1] === 'phone' ? await addressTag(request, fingerprint) : undefined;
    return stub.fetch(
      inner(route[1], fingerprint, env, { headers: { Upgrade: 'websocket' } }, from)
    );
  },
} satisfies ExportedHandler<Env>;
