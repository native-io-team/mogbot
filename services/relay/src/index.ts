import { FINGERPRINT_RE } from './auth';
import type { Env } from './env';

export { MacRelay } from './mac';

const ROUTE = /^\/v1\/(mac|phone)\/([^/]+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response('ok');
    }
    const route = ROUTE.exec(url.pathname);
    if (!route || request.method !== 'GET') return new Response('not found', { status: 404 });
    const fingerprint = route[2];
    if (!FINGERPRINT_RE.test(fingerprint)) return new Response('bad fingerprint', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket only', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    if (env.RATE_LIMITER) {
      const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: address });
      if (!success) return new Response('slow down', { status: 429 });
    }
    // The address stops here: the Durable Object is told only the role.
    const stub = env.MAC.get(env.MAC.idFromName(fingerprint));
    const inner = new Request(`https://relay/${route[1]}/${fingerprint}`, {
      headers: { Upgrade: 'websocket' },
    });
    return stub.fetch(inner);
  },
} satisfies ExportedHandler<Env>;
