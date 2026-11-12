import { FINGERPRINT_RE } from './auth';
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

/** The Durable Object is told the role and whether accounts are on; never the address. */
function inner(role: string, fingerprint: string, env: Env, init: RequestInit = {}): Request {
  const accounts = accountsOn(env) ? '?accounts=1' : '';
  return new Request(`https://relay/${role}/${fingerprint}${accounts}`, init);
}

async function link(request: Request, env: Env): Promise<Response> {
  if (!accountsOn(env)) return linkError('accounts_off', 404);
  if (await limited(request, env)) return linkError('slow_down', 429);
  const text = await request.text();
  if (text.length > MAX_LINK_BODY) return linkError('bad_request', 413);
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
    return stub.fetch(inner(route[1], fingerprint, env, { headers: { Upgrade: 'websocket' } }));
  },
} satisfies ExportedHandler<Env>;
