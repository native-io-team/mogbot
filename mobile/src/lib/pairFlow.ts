/**
 * Pairing over the wire, with everything the phone itself supplies passed in
 * (the device, randomness, `fetch`), so the tests run the real flow under
 * Node against the mock Mac and a relay. `pairing.ts` wraps it with Expo's.
 *
 * The order is the point: the Mac proves who it is (`POST /v1/identity`)
 * before the pairing code goes anywhere, and the answer that carries the
 * device token is checked the same way before it's kept.
 *
 * Each step says when it starts (`onStep`), so the screen tells the truth:
 * "Reaching your Mac" while the identity request is out, and "Allow on your
 * Mac" only once the Mac has proved itself and the code has gone. Neither
 * request can hang: the identity one gets seconds, the pairing one the
 * desk's two minutes and a little more.
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
  /**
   * The code went and the Mac had it, but no answer came back inside the
   * desk's window. Whether someone clicked Allow is unknown here.
   */
  | { kind: 'no_answer' }
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

/**
 * Where pairing has got to, as it starts each step:
 * - `reaching`: asking the Mac to prove itself; nothing secret has gone.
 * - `asking`: the Mac proved itself and the code is on its way; the desk
 *   now shows Allow / Deny.
 */
export type PairStep = 'reaching' | 'asking';

/**
 * The identity answer is near-instant on a direct path, but a first request
 * over a DERP relay (or while the phone's Tailscale wakes up on demand) can
 * take seconds: each try gets this long, and a try that times out gets one
 * more on a fresh connection before the phone says the Mac is unreachable.
 */
export const IDENTITY_TIMEOUT_MS = 12_000;
export const IDENTITY_TRIES = 2;
/** The desk's 120 s (`pairing::DECISION_TIMEOUT`), and room for its answer to arrive. */
export const PAIR_TIMEOUT_MS = 135_000;

export interface PairDeps {
  fetch: typeof fetch;
  random: (n: number) => Uint8Array;
  device: PairRequest['device'];
  publicKey: string;
  signal?: AbortSignal;
  /** Why a route didn't answer (the phone asks the OS; tests say "unreachable"). */
  diagnose?: (url: string) => Promise<PairFailure>;
  onStep?: (step: PairStep) => void;
  /** Overrides for the tests. */
  identityTimeoutMs?: number;
  pairTimeoutMs?: number;
}

/**
 * An abort signal that fires when the caller's does or after `ms`, and says
 * which. By hand: Hermes has neither `AbortSignal.any` nor `.timeout`.
 */
function within(outer: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

const post = (deps: PairDeps, url: string, body: unknown, signal: AbortSignal) =>
  deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

const unreachable = async (deps: PairDeps, route: Route) =>
  new PairError((await deps.diagnose?.(route.url)) ?? { kind: 'mac_unreachable' });

/**
 * Ask the Mac at `route` to prove it's the one the link named. Throws a
 * `PairError` for anything but yes; the pairing code hasn't left the phone.
 * No answer within `IDENTITY_TIMEOUT_MS` is the same as no route: diagnosed.
 */
export async function proveMac(link: PairingLink, route: Route, deps: PairDeps): Promise<void> {
  const base = route.url.replace(/\/$/, '');
  const challenge = newChallenge(deps.random);
  let res!: Response;
  let answer: IdentityResponse | null = null;
  for (let attempt = 1; ; attempt++) {
    const clock = within(deps.signal, deps.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS);
    try {
      res = await post(
        deps,
        base + HTTP.identity,
        { protocol: SUPPORTED, challenge },
        clock.signal
      );
      answer = res.ok ? ((await res.json().catch(() => null)) as IdentityResponse | null) : null;
      break;
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      // Slow is not gone: a timed-out try gets one more. A fast failure
      // (no such host, refused) is an answer already.
      if (clock.timedOut() && attempt < IDENTITY_TRIES) continue;
      throw await unreachable(deps, route);
    } finally {
      clock.done();
    }
  }
  // Every Mac that can prove itself has this route; a bare 404 is one that can't.
  if (res.status === 404) {
    throw new PairError({ kind: 'refused', reason: 'update_mac', message: UPDATE_MAC });
  }
  if (!res.ok) throw new PairError({ kind: 'other', message: `The Mac answered ${res.status}.` });
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
 * The request stays open while someone at the desk decides (up to 120 s),
 * and is given up a little after that, so it can never wait forever.
 */
export async function pairWith(link: PairingLink, deps: PairDeps): Promise<Paired> {
  const route = link.routes.find((r) => r.kind === 'tailscale');
  if (!route) throw new PairError({ kind: 'lan_only' });
  deps.onStep?.('reaching');
  await proveMac(link, route, deps);

  const challenge = newChallenge(deps.random);
  const body: PairRequest = {
    code: link.code,
    device: deps.device,
    protocol: SUPPORTED,
    publicKey: deps.publicKey,
    challenge,
  };
  const clock = within(deps.signal, deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS);
  let res: Response;
  let answer: PairResponse | null;
  try {
    const sent = post(deps, route.url.replace(/\/$/, '') + HTTP.pair, body, clock.signal);
    // Only now is the Mac asking: the code is on its way to a proven Mac.
    deps.onStep?.('asking');
    res = await sent;
    answer = res.ok ? ((await res.json().catch(() => null)) as PairResponse | null) : null;
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    // The code went: past the desk's window, say that, not "unreachable".
    if (clock.timedOut()) throw new PairError({ kind: 'no_answer' });
    throw await unreachable(deps, route);
  } finally {
    clock.done();
  }
  // A wrong, used or expired code is a bare 404 (the Mac says nothing more).
  if (res.status === 404) throw new PairError({ kind: 'expired' });
  if (!res.ok) throw new PairError({ kind: 'other', message: `The Mac answered ${res.status}.` });
  if (!answer)
    throw new PairError({ kind: 'other', message: 'The Mac’s answer couldn’t be read.' });
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
