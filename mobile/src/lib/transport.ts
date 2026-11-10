/**
 * `DirectTransport`: one WebSocket to the Mac over a route (docs/mobile.md,
 * "Transport"). Screens never see the socket; they see `Transport`.
 *
 * Pure TypeScript with the socket constructor injected, so the integration
 * test drives this exact class against the mock server under Node.
 */

import {
  CLOSE_MAC_CLOSING,
  DEAD_AFTER_MS,
  FEATURES,
  HEARTBEAT_MS,
  HTTP,
  MAX_ATTACHMENT_BYTES,
  SUPPORTED,
  type BlobRef,
  type ClientFrame,
  type CompanionEvent,
  type Cursor,
  type HelloFrame,
  type IdentityFrame,
  type LinkState,
  type MacSaid,
  type MethodName,
  type Params,
  type RefusedFrame,
  type Result,
  type Route,
  type ServerFrame,
  type Transport,
  type WelcomeFrame,
  type WireError,
} from '@shipstudio/companion-protocol';
import { checkMac, MAC_RESET, NOT_YOUR_MAC, UPDATE_MAC, type Pinned } from './identity';

/**
 * Where a frame this phone couldn't handle is reported (the session sends it
 * to the crash log). A throw out of a socket callback is fatal in a release
 * build, so a frame from a Mac of another version, or a listener that trips
 * on one, is reported and skipped, never let through.
 */
let reportFault: (error: unknown) => void = () => {};
export function setTransportFaultReporter(report: (error: unknown) => void) {
  reportFault = report;
}

/** Call each listener; one that throws is reported and the rest still run. */
function each<A extends unknown[]>(listeners: Set<(...a: A) => void>, ...args: A) {
  for (const l of listeners) {
    try {
      l(...args);
    } catch (e) {
      try {
        reportFault(e);
      } catch {
        // Reporting is best effort.
      }
    }
  }
}

/** A request that failed, carrying the Mac's (or our) structured error. */
export class WireFailure extends Error {
  constructor(readonly error: WireError) {
    super('message' in error ? error.message : error.type);
  }
}

const notConnected = () =>
  new WireFailure({
    type: 'Protocol',
    code: 'not_connected',
    message: 'Not connected to your Mac right now.',
  });

const MB = 1024 * 1024;

/** An HTTP status from a file route, as the sentence the user sees. */
function httpFailure(status: number, name?: string): WireFailure {
  const protocol = (code: 'too_large' | 'refused' | 'bad_params', message: string) =>
    new WireFailure({ type: 'Protocol', code, message });
  if (status === 413) {
    return protocol(
      'too_large',
      `${name ?? 'That file'} is too big. Files can be up to ${MAX_ATTACHMENT_BYTES / MB} MB.`
    );
  }
  if (status === 401) return protocol('refused', 'Your Mac didn’t accept this phone. Pair again.');
  if (status === 404) return protocol('bad_params', 'That file isn’t on your Mac any more.');
  return new WireFailure({ type: 'Other', message: `Your Mac answered ${status}.` });
}

export interface DirectTransportOptions {
  /** Tried in order, starting from the one that last worked. */
  routes: Route[];
  token: string;
  app: HelloFrame['app'];
  /** The last cursor the store fully applied; sent as `hello.resume`. */
  getResume: () => Cursor | undefined;
  foreground: boolean;
  WebSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
  /** File bytes over HTTP (`files.ts` on the phone; `fetch` and `fs` in tests). */
  http?: HttpAdapter;
  /**
   * The Mac this phone pinned at pairing. Each connection's first frame is
   * a fresh `challenge`; the token goes only after the Mac's `identity`
   * answer checks out against this (`checkMac`), for the host this socket
   * actually reached. Anything else ends the link for good.
   */
  pinned: Pinned;
  /** A fresh challenge for each connection (32 random bytes, base64url). */
  challenge: () => string;
  /**
   * Asked once when a socket closes before the Mac says anything: a Mac
   * from before protocol 2 closes on the challenge without a word. Resolves
   * the HTTP status of `POST /v1/identity` (404 there means that Mac), or
   * rejects when the request itself fails. Defaults to `fetch`.
   */
  probe?: (url: string) => Promise<number>;
}

/**
 * Moves file bytes, which never go over the socket. Both resolve for any HTTP
 * status (the transport turns a status into an error); they reject only when
 * the request itself fails.
 */
export interface HttpAdapter {
  /** PUT a local file as the raw body. */
  upload(
    url: string,
    uri: string,
    headers: Record<string, string>,
    onProgress?: (fraction: number) => void
  ): Promise<{ status: number; body: string }>;
  /** GET into a local file kept under `key` (cached: attachments never change). */
  download(
    url: string,
    headers: Record<string, string>,
    key: string
  ): Promise<{ status: number; uri: string }>;
}

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Waits between tries. With the app in front someone is looking, and the Mac
 * is usually back within seconds (its app restarting for an update), so the
 * wait never passes 5 s. In the background iOS barely runs the app anyway;
 * the radio isn't kept busy for nobody.
 */
export const FOREGROUND_BACKOFF_MS = [1000, 2000, 4000, 5000];
export const BACKGROUND_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

/**
 * A try that hasn't been welcomed in this long is stuck (a route that drops
 * packets rather than refusing, like a home address from a cellular network,
 * waits out the OS's own timeout of a minute or more): give it up and try
 * the next route. Grows with each failed try, for a slow first path over Tailscale.
 *
 * The first try gets 16 s: opening a socket is three round trips (TCP, TLS,
 * the upgrade), and on a link with 4–5 s round trips (one bar of signal, a
 * relayed Tailscale path) 8 s gave every first try up just before it opened.
 */
export const connectTimeoutMs = (attempt: number) => 16_000 + 4000 * Math.min(attempt, 3);

/**
 * The longest any one try is given, however slow the link has shown itself
 * to be: past this a try is stuck, not slow.
 */
export const MAX_TRY_MS = 60_000;

/**
 * How long a try may take before it's given up, by the attempt and by how
 * slow this link has been. `handshakeMs` is the last try that made it, from
 * opening the socket to the Mac's welcome: on a link with seconds of latency
 * (a weak cellular signal, a relayed Tailscale path) a handshake is a few
 * round trips and can take longer than the fixed timeout, and giving it up
 * there started the same slow handshake again, forever.
 */
export const tryBudgetMs = (attempt: number, handshakeMs = 0) =>
  Math.min(MAX_TRY_MS, Math.max(connectTimeoutMs(attempt), 2 * handshakeMs));

/**
 * When the app comes forward, or the network changes, on a socket that
 * looks open: the Mac must answer a ping this quickly, or it's taken as gone
 * (a socket iOS suspended in the background often is), not after 40 s.
 */
export const PROBE_MS = 4000;

/**
 * The probe's wait on this link: `PROBE_MS`, or three of its measured round
 * trips when those are slower (up to 15 s), so a link with seconds of
 * latency isn't torn down for being slow and then made to handshake again.
 */
export const probeWaitMs = (latencyMs: number | null) =>
  Math.max(PROBE_MS, Math.min(15_000, 3 * (latencyMs ?? 0)));

/**
 * A refusal the Mac may lift by itself, or the user can fix without pairing
 * again: the phone keeps trying, and says what the Mac said
 * (`LinkState.macSaid`) instead of "can't reach".
 */
const PASSING_REFUSALS = new Set<string>(['too_many_connections', 'unavailable', 'other_account']);
const passing = (reason: RefusedFrame['reason']): reason is MacSaid => PASSING_REFUSALS.has(reason);

/**
 * After the Mac said this phone's Tailscale is on another account, tries
 * wait at least this long: switching accounts is something the user does,
 * and coming back to the app (or the network changing as Tailscale
 * reconnects) tries at once anyway.
 */
export const OTHER_ACCOUNT_RETRY_MS = 15_000;

/** `retryNow` leaves a try this young alone, so a burst of triggers doesn't churn sockets. */
const FRESH_TRY_MS = 1500;

export class DirectTransport implements Transport {
  private ws: SocketLike | null = null;
  private routeIndex = 0;
  private attempt = 0;
  private everConnected = false;
  private closed = false;
  private refused = false;
  private ready = false;
  private epoch: string | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the socket in flight was opened (epoch ms). */
  private triedAt = 0;
  /** When this spell of trying began; reset when the app comes forward. 0 while connected. */
  private troubleSince = 0;
  /** The Mac's app said goodbye as it closed; cleared on the next welcome. */
  private macClosing = false;
  private pingSentAt = 0;
  private eventListeners = new Set<(e: CompanionEvent, c?: Cursor) => void>();
  private stateListeners = new Set<(s: LinkState) => void>();
  private welcomeListeners = new Set<(w: WelcomeFrame) => void>();
  private refusedListeners = new Set<(r: RefusedFrame) => void>();
  private foreground: boolean;

  state: LinkState = { kind: 'connecting', attempt: 0 };
  /** The last frame from the Mac (epoch ms), 0 before the first. */
  lastSeenAt = 0;
  /** Round trip of the last ping, for the Connection screen. */
  latencyMs: number | null = null;
  welcome: WelcomeFrame | null = null;
  refusal: RefusedFrame | null = null;
  /**
   * The Mac proved itself on this socket (`identity`, before the token
   * went). Secrets go only while this is true (`secrets.ts`).
   */
  identityVerified = false;
  private challenge = '';
  /** This socket opened and the Mac hasn't said anything on it yet. */
  private silent = false;
  /** This try's socket opened: something at the Mac's address took it. */
  private opened = false;
  /** Since when a request went unanswered with the heartbeat still coming. */
  private stuckSince = 0;
  /** In this spell of trouble, the app was seen stuck (`LinkState.appStuck`). */
  private appStuck = false;
  /** An old-Mac probe already ran (once per transport is plenty). */
  private probed = false;
  /** The last try that made it: socket opened to welcome (ms). 0 before one. */
  private handshakeMs = 0;
  /** In this spell of trouble, what the Mac said as it turned the phone away. */
  private macSaid: MacSaid | undefined;

  constructor(private readonly opts: DirectTransportOptions) {
    this.foreground = opts.foreground;
    if (!opts.routes.length) throw new Error('No route to the Mac');
    this.connect();
  }

  get route(): Route {
    return this.opts.routes[this.routeIndex];
  }

  // ---- Transport ------------------------------------------------------------

  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.ready || !this.ws) return Promise.reject(notConnected());
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const secs = (this.opts.requestTimeoutMs ?? 30_000) / 1000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.noAnswer();
        reject(new WireFailure({ type: 'Timeout', cmd: method, secs }));
      }, secs * 1000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: 'req', id, method, params });
    });
  }

  onEvent(listener: (event: CompanionEvent, cursor?: Cursor) => void) {
    this.eventListeners.add(listener);
    return () => void this.eventListeners.delete(listener);
  }

  onState(listener: (state: LinkState) => void) {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  onWelcome(listener: (welcome: WelcomeFrame) => void) {
    this.welcomeListeners.add(listener);
    return () => void this.welcomeListeners.delete(listener);
  }

  onRefused(listener: (refused: RefusedFrame) => void) {
    this.refusedListeners.add(listener);
    return () => void this.refusedListeners.delete(listener);
  }

  /** The route in use, without a trailing slash: the base for the HTTP routes. */
  get baseUrl(): string {
    return this.route.url.replace(/\/$/, '');
  }

  /** What every HTTP route needs. Images pass it as their source's headers. */
  get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}` };
  }

  /** A chat attachment's URL; `width` asks the Mac for a JPEG thumbnail. */
  attachmentUrl(agentId: string, path: string, width?: number): string {
    return this.baseUrl + HTTP.attachment(agentId, path) + (width ? `?w=${Math.round(width)}` : '');
  }

  async upload(
    file: { uri: string; name: string; mime: string },
    onProgress?: (fraction: number) => void
  ): Promise<BlobRef> {
    const http = this.http();
    const res = await http
      .upload(
        this.baseUrl + HTTP.uploadBlob,
        file.uri,
        {
          ...this.authHeaders,
          'Content-Type': file.mime || 'application/octet-stream',
          'X-Name': encodeURIComponent(file.name),
        },
        onProgress
      )
      .catch(() => Promise.reject(notConnected()));
    if (res.status === 200) return JSON.parse(res.body) as BlobRef;
    throw httpFailure(res.status, file.name);
  }

  async download(source: { blobId: string } | { agentId: string; path: string }): Promise<string> {
    const http = this.http();
    const [url, key] =
      'blobId' in source
        ? [this.baseUrl + HTTP.blob(source.blobId), `blob/${source.blobId}`]
        : [
            this.attachmentUrl(source.agentId, source.path),
            `attachment/${source.agentId}/${source.path}`,
          ];
    const res = await http
      .download(url, this.authHeaders, key)
      .catch(() => Promise.reject(notConnected()));
    if (res.status === 200) return res.uri;
    throw httpFailure(res.status);
  }

  private http(): HttpAdapter {
    if (!this.opts.http) throw new Error('No HTTP adapter');
    if (!this.ready) throw notConnected();
    return this.opts.http;
  }

  setForeground(foreground: boolean) {
    const cameForward = foreground && !this.foreground;
    this.foreground = foreground;
    if (this.ready) {
      this.send({ t: 'presence', foreground });
      // A socket that sat in the background may be dead without knowing it.
      if (cameForward) this.probe();
    } else if (foreground) {
      // Someone is looking now: the calm moment starts over, and so do the tries.
      if (cameForward && this.troubleSince) {
        this.troubleSince = Date.now();
        if (this.state.kind === 'reconnecting' || this.state.kind === 'connecting') {
          this.setState({ ...this.state, since: this.troubleSince });
        }
      }
      this.retryNow();
    }
  }

  /**
   * Make sure of the link now (the network changed, the app came forward, or
   * the user asked): an open socket must answer a ping within `PROBE_MS`;
   * otherwise try again at once, instead of waiting out a backoff or a try
   * stuck on a dead route.
   */
  retryNow() {
    if (this.closed || this.refused) return;
    if (this.ready) return this.probe();
    if (this.ws) {
      if (Date.now() - this.triedAt < FRESH_TRY_MS) return;
      // The try in flight is stuck on its route: the next one goes elsewhere.
      this.routeIndex = (this.routeIndex + 1) % this.opts.routes.length;
    }
    this.teardown();
    this.attempt = 0;
    this.connect();
  }

  /**
   * A request timed out. With the Mac's heartbeat still arriving, the link is
   * fine and the app on the Mac isn't answering: say so (`connected.stuck`).
   */
  private noAnswer() {
    if (!this.ready || this.state.kind !== 'connected') return;
    if (Date.now() - this.lastSeenAt > HEARTBEAT_MS + 5000) return;
    if (!this.stuckSince) this.stuckSince = Date.now();
    this.appStuck = true;
    this.setState({ ...this.state, stuck: this.stuckSince });
  }

  private probe() {
    if (!this.ready) return;
    this.pingSentAt = Date.now();
    this.send({ t: 'ping' });
    // Any frame re-arms the full wait (`onmessage`).
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => this.lost(), probeWaitMs(this.latencyMs));
  }

  close() {
    this.closed = true;
    this.teardown();
    this.eventListeners.clear();
    this.stateListeners.clear();
  }

  // ---- The socket -----------------------------------------------------------

  private connect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.troubleSince) this.troubleSince = Date.now();
    if (!this.everConnected) {
      this.setState({
        kind: 'connecting',
        attempt: this.attempt,
        since: this.troubleSince,
        ...(this.appStuck ? { appStuck: true } : {}),
        ...(this.macSaid ? { macSaid: this.macSaid } : {}),
      });
    }
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const url = this.route.url.replace(/^http/, 'ws').replace(/\/$/, '') + HTTP.ws;
    const ws = new Impl(url) as unknown as SocketLike;
    this.ws = ws;
    this.triedAt = Date.now();
    this.armConnectTimer(ws, tryBudgetMs(this.attempt, this.handshakeMs));
    this.opened = false;
    ws.onopen = () => {
      this.opened = true;
      // The route works: the rest of the handshake is two more round
      // trips, so it's given time by how long opening took, not cut off
      // by a timeout meant for a route that never answers.
      const took = Date.now() - this.triedAt;
      this.armConnectTimer(
        ws,
        Math.min(MAX_TRY_MS, Math.max(tryBudgetMs(this.attempt, this.handshakeMs), 3 * took))
      );
      this.armDeadTimer();
      // Nothing private until the Mac proves itself: just a challenge.
      this.challenge = this.opts.challenge();
      this.silent = true;
      this.send({ t: 'challenge', protocol: SUPPORTED, challenge: this.challenge });
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.silent = false;
      this.lastSeenAt = Date.now();
      this.armDeadTimer();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      // Not a frame at all (`null`, a number, a list): nothing to do with it.
      if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return;
      try {
        this.handle(frame);
      } catch (e) {
        reportFault(e);
      }
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      // The Mac's app closing says so; anything else (a drop, a refusal) doesn't.
      if (this.ready && (ev as { code?: number } | null)?.code === CLOSE_MAC_CLOSING) {
        this.macClosing = true;
      }
      this.lost();
    };
  }

  private armConnectTimer(ws: SocketLike, ms: number) {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (ws === this.ws && !this.ready) this.lost();
    }, ms);
  }

  /** Stop for good with a refusal of the phone's own: nothing more is said to this server. */
  private refuseLocally(reason: 'not_your_mac' | 'mac_reset' | 'update_mac', message: string) {
    const refusal: RefusedFrame = { t: 'refused', reason, message };
    this.refusal = refusal;
    this.refused = true;
    this.teardown();
    this.setState({ kind: 'refused', reason });
    this.refusedListeners.forEach((l) => l(refusal));
  }

  /** The Mac's proof: only if it checks out does the token go. */
  private onIdentity(frame: IdentityFrame) {
    if (this.identityVerified) return;
    const verdict = checkMac(frame, this.opts.pinned, this.challenge, this.route.url);
    if (verdict !== 'ok') {
      this.refuseLocally(verdict, verdict === 'mac_reset' ? MAC_RESET : NOT_YOUR_MAC);
      return;
    }
    this.identityVerified = true;
    const resume = this.opts.getResume();
    this.send({
      t: 'hello',
      protocol: SUPPORTED,
      token: this.opts.token,
      app: this.opts.app,
      ...(resume ? { resume } : {}),
      foreground: this.foreground,
      features: [FEATURES.liveWork, FEATURES.rooms, FEATURES.alerts, FEATURES.otherAccount],
    });
  }

  private handle(frame: ServerFrame) {
    // Before the Mac has proved itself, only its proof means anything, or a
    // refusal that can come first (versions, a locked Keychain). "Removed"
    // and "not paired" from a server that hasn't proved it's the Mac would
    // be a stranger talking this phone into forgetting its Mac.
    if (!this.identityVerified) {
      const early =
        frame.t === 'identity' ||
        (frame.t === 'refused' && frame.reason !== 'revoked' && frame.reason !== 'unauthorized');
      if (!early) return;
    }
    switch (frame.t) {
      case 'identity':
        this.onIdentity(frame);
        return;
      case 'welcome': {
        this.ready = true;
        this.everConnected = true;
        this.attempt = 0;
        this.troubleSince = 0;
        this.macClosing = false;
        this.appStuck = false;
        this.stuckSince = 0;
        this.macSaid = undefined;
        this.handshakeMs = Date.now() - this.triedAt;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.welcome = frame;
        if (frame.resume === 'replay') this.epoch = this.opts.getResume()?.epoch ?? this.epoch;
        this.startPings();
        this.setState({ kind: 'connected', route: this.route.kind, since: Date.now() });
        each(this.welcomeListeners, frame);
        return;
      }
      case 'refused': {
        this.refusal = frame;
        each(this.refusedListeners, frame);
        // Close follows; retry with backoff, saying what the Mac said.
        if (passing(frame.reason)) {
          this.macSaid = frame.reason;
          return;
        }
        this.refused = true;
        this.setState({ kind: 'refused', reason: frame.reason });
        this.teardown();
        return;
      }
      case 'res': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        // An answer: whatever held the app up has let go.
        if (this.stuckSince && this.state.kind === 'connected') {
          this.stuckSince = 0;
          this.appStuck = false;
          const { stuck: _done, ...state } = this.state;
          this.setState(state);
        }
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new WireFailure(frame.error));
        return;
      }
      case 'evt': {
        const { event } = frame;
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
        if (event.type === 'sync.snapshot' || event.type === 'sync.caughtUp') {
          this.epoch = event.cursor.epoch;
        }
        const cursor =
          frame.seq != null && this.epoch ? { epoch: this.epoch, seq: frame.seq } : undefined;
        each(this.eventListeners, event, cursor);
        return;
      }
      case 'pong':
        // The Mac also sends pongs unprompted, as its heartbeat; only an
        // answer to our own ping says anything about latency.
        if (this.pingSentAt) this.latencyMs = Date.now() - this.pingSentAt;
        this.pingSentAt = 0;
        return;
    }
  }

  /** The socket closed or went silent: fail what's in flight and retry with backoff. */
  private lost() {
    const unanswered = this.silent;
    const wasReady = this.ready;
    // Took the connection and said nothing: the Mac is there, its app isn't answering.
    if (this.opened && unanswered) this.appStuck = true;
    this.stuckSince = 0;
    this.teardown();
    if (this.closed || this.refused) return;
    if (unanswered && !this.probed) void this.probeOldMac(this.route.url);
    // A route that failed before ever answering hands over to the next one;
    // one that was working is tried again first (the Mac restarting is still there).
    if (!wasReady) this.routeIndex = (this.routeIndex + 1) % this.opts.routes.length;
    if (!this.troubleSince) this.troubleSince = Date.now();
    const schedule = this.foreground ? FOREGROUND_BACKOFF_MS : BACKGROUND_BACKOFF_MS;
    const base = schedule[Math.min(this.attempt, schedule.length - 1)];
    const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
    const delay =
      this.macSaid === 'other_account' ? Math.max(jittered, OTHER_ACCOUNT_RETRY_MS) : jittered;
    this.attempt++;
    this.setState(
      this.everConnected
        ? {
            kind: 'reconnecting',
            lastSeenAt: this.lastSeenAt,
            nextTryAt: Date.now() + delay,
            since: this.troubleSince,
            ...(this.macClosing ? { macClosing: true } : {}),
            ...(this.appStuck && !this.macClosing ? { appStuck: true } : {}),
            ...(this.macSaid ? { macSaid: this.macSaid } : {}),
          }
        : {
            kind: 'connecting',
            attempt: this.attempt,
            since: this.troubleSince,
            ...(this.appStuck ? { appStuck: true } : {}),
            ...(this.macSaid ? { macSaid: this.macSaid } : {}),
          }
    );
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * A socket that opened and closed without a word: a Mac from before
   * protocol 2 does that to a challenge. It has no `/v1/identity` either,
   * so a 404 there says which, and the user hears to update the Mac rather
   * than watching it reconnect forever.
   */
  private async probeOldMac(url: string) {
    this.probed = true;
    const probe =
      this.opts.probe ??
      ((u: string) =>
        fetch(u.replace(/\/$/, '') + HTTP.identity, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocol: SUPPORTED, challenge: this.opts.challenge() }),
        }).then((r) => r.status));
    const status = await probe(url).catch(() => null);
    if (status === 404 && !this.closed && !this.refused && !this.ready) {
      this.refuseLocally('update_mac', UPDATE_MAC);
    }
  }

  private teardown() {
    this.ready = false;
    this.identityVerified = false;
    this.silent = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pingTimer = this.deadTimer = this.retryTimer = this.connectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(notConnected());
    }
    this.pending.clear();
  }

  /**
   * The Mac sends a heartbeat pong every HEARTBEAT_MS; the phone pings too,
   * to measure the round trip. Any frame proves the link, and silence for
   * DEAD_AFTER_MS means sleep or a Wi-Fi handoff, which TCP would take
   * minutes to notice: reconnect and resume from the cursor.
   */
  private startPings() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.pingSentAt = Date.now();
      this.send({ t: 'ping' });
    }, HEARTBEAT_MS);
  }

  private armDeadTimer() {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => this.lost(), DEAD_AFTER_MS);
  }

  private send(frame: ClientFrame) {
    // OPEN is 1 for every WebSocket implementation.
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private setState(state: LinkState) {
    this.state = state;
    this.stateListeners.forEach((l) => l(state));
  }
}
