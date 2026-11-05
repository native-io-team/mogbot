/**
 * Pairing over the wire, with everything the phone itself supplies passed in
 * (the device, randomness, `fetch`), so the tests run the real flow under
 * Node against the mock Mac and a relay. `pairing.ts` wraps it with Expo's.
 *
 * The order is the point: the Mac proves who it is (`POST /v1/identity`)
 * before the pairing code goes anywhere, and the answer that carries the
 * device token is checked the same way before it's kept.
 */

import {
  HTTP,
  SUPPORTED,
  type IdentityResponse,
  type PairRequest,
  type PairResponse,
  type PairingLink,
  type Route,
} from '@shipstudio/companion-protocol';
import { checkMac, checkPairAnswer, newChallenge, UPDATE_MAC } from './identity';

export type PairFailure =
  | { kind: 'lan_only' }
  /** The server couldn't prove it's the Mac the link named: nothing was sent to it. */
  | { kind: 'not_your_mac' }
  | { kind: 'tailscale_off' }
  | { kind: 'mac_unreachable' }
  | {
      kind: 'refused';
      reason: Extract<PairResponse, { ok: false }>['reason'] | 'unavailable';
      message: string;
    }
  | { kind: 'expired' }
  | { kind: 'other'; message: string };

export class PairError extends Error {
  constructor(readonly failure: PairFailure) {
    super(failure.kind);
  }
}

/** What pairing gives back, before the phone adds its own name and secret. */
export interface Paired {
  serverId: string;
  deviceId: string;
  token: string;
  /** The one route that answered: the only one kept. */
  route: Route;
  fingerprint: string;
}

export interface PairDeps {
  fetch: typeof fetch;
  random: (n: number) => Uint8Array;
  device: PairRequest['device'];
  publicKey: string;
  signal?: AbortSignal;
  /** Why a route didn't answer (the phone asks the OS; tests say "unreachable"). */
  diagnose?: (url: string) => Promise<PairFailure>;
}

const post = (deps: PairDeps, url: string, body: unknown) =>
  deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: deps.signal,
  });

/**
 * Ask the Mac at `route` to prove it's the one the link named. Throws a
 * `PairError` for anything but yes; the pairing code hasn't left the phone.
 */
export async function proveMac(link: PairingLink, route: Route, deps: PairDeps): Promise<void> {
  const base = route.url.replace(/\/$/, '');
  const challenge = newChallenge(deps.random);
  let res: Response;
  try {
    res = await post(deps, base + HTTP.identity, { protocol: SUPPORTED, challenge });
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    throw new PairError((await deps.diagnose?.(route.url)) ?? { kind: 'mac_unreachable' });
  }
  // Every Mac that can prove itself has this route; a bare 404 is one that can't.
  if (res.status === 404) {
    throw new PairError({ kind: 'refused', reason: 'update_mac', message: UPDATE_MAC });
  }
  if (!res.ok) throw new PairError({ kind: 'other', message: `The Mac answered ${res.status}.` });
  const answer = (await res.json().catch(() => null)) as IdentityResponse | null;
  if (answer && answer.ok === false) {
    throw new PairError({ kind: 'refused', reason: answer.reason, message: answer.message });
  }
  const pinned = { fingerprint: link.fingerprint, serverId: link.serverId };
  if (!answer || checkMac(answer, pinned, challenge, route.url) !== 'ok') {
    throw new PairError({ kind: 'not_your_mac' });
  }
}

/**
 * Pair from `link` over its one Tailscale route: the Mac proves itself,
 * then the code goes, then the answer is checked before its token is kept.
 * The request stays open while someone at the desk decides (up to 120 s).
 */
export async function pairWith(link: PairingLink, deps: PairDeps): Promise<Paired> {
  const route = link.routes.find((r) => r.kind === 'tailscale');
  if (!route) throw new PairError({ kind: 'lan_only' });
  await proveMac(link, route, deps);

  const challenge = newChallenge(deps.random);
  const body: PairRequest = {
    code: link.code,
    device: deps.device,
    protocol: SUPPORTED,
    publicKey: deps.publicKey,
    challenge,
  };
  let res: Response;
  try {
    res = await post(deps, route.url.replace(/\/$/, '') + HTTP.pair, body);
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    throw new PairError((await deps.diagnose?.(route.url)) ?? { kind: 'mac_unreachable' });
  }
  // A wrong, used or expired code is a bare 404 (the Mac says nothing more).
  if (res.status === 404) throw new PairError({ kind: 'expired' });
  if (!res.ok) throw new PairError({ kind: 'other', message: `The Mac answered ${res.status}.` });
  const answer = (await res.json()) as PairResponse;
  if (!answer.ok) {
    throw new PairError({ kind: 'refused', reason: answer.reason, message: answer.message });
  }
  // A token from anyone but the key the link named, for this host, is
  // thrown away, not kept.
  const pinned = { fingerprint: link.fingerprint, serverId: link.serverId };
  if (!checkPairAnswer(answer, pinned, challenge, route.url)) {
    throw new PairError({ kind: 'not_your_mac' });
  }
  return {
    serverId: answer.serverId,
    deviceId: answer.deviceId,
    token: answer.token,
    route: { kind: route.kind, url: route.url },
    fingerprint: link.fingerprint,
  };
}
