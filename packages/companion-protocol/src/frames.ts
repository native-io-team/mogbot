/**
 * What goes over the WebSocket (`GET /v1/ws`): JSON text frames, one object each.
 *
 * Order on connect: the phone sends `hello`; the Mac answers `welcome` (or
 * `refused` and closes); then replayed or snapshot events, `sync.caughtUp`,
 * and live traffic. Responses and events share the socket, so an event caused
 * by a request is never overtaken by that request's response.
 */

import type { CompanionEvent } from './events';
import type { MethodName, Params, Result } from './methods';
import type { IdentityProof } from './pairing';
import type { ProtocolRange } from './version';

/**
 * A position in the Mac's event journal. `epoch` changes whenever the journal
 * starts over (the app restarted), so a cursor from before can't be mistaken
 * for one from now.
 */
export interface Cursor {
  epoch: string;
  seq: number;
}

// ---- Errors -----------------------------------------------------------------

/** `src-tauri/src/errors.rs::CommandError`, as src/lib/errors.ts mirrors it. */
export type CommandError =
  | { type: 'Timeout'; cmd: string; secs: number }
  | { type: 'Process'; cmd: string; exit_code: number; stderr: string }
  | { type: 'Validation'; field: string; reason: string }
  | { type: 'NotAuthenticated'; service: string }
  | { type: 'Io'; message: string }
  | { type: 'MergeConflict'; pr_number: number; stderr: string }
  | { type: 'Other'; message: string; expected?: boolean };

/** Failures of the companion itself, before or around a command. */
export interface ProtocolError {
  type: 'Protocol';
  code:
    | 'unknown_method'
    | 'bad_params'
    | 'rate_limited'
    | 'too_large'
    /** Remote Access's text rules said no; `message` says why, for the user. */
    | 'refused'
    | 'not_connected';
  message: string;
}

export type WireError = CommandError | ProtocolError;

// ---- Phone → Mac ------------------------------------------------------------

export interface HelloFrame {
  t: 'hello';
  protocol: ProtocolRange;
  /** The device token from pairing. Sent here, never in the URL, so no log ever holds it. */
  token: string;
  app: {
    version: string;
    /** expo-updates update id, when running an OTA update. */
    updateId?: string;
    /** The native binary's `runtimeVersion`: which OTA updates it can take. */
    runtimeVersion: string;
  };
  /** The last cursor the phone fully applied. Absent on a first connect. */
  resume?: Cursor;
  /** The phone is in the foreground (only then does it count as "showing" an agent). */
  foreground: boolean;
  /**
   * What this app can show beyond the protocol version, so the Mac sends it
   * only what it will use. An older app sends none. See `FEATURES`.
   */
  features?: Feature[];
  /**
   * 32 random bytes, base64url, fresh for this connection: the Mac signs it
   * in `welcome.identity`, so the phone knows it reached the Mac it pinned.
   */
  challenge?: string;
}

/** Optional things an app can say it shows (`hello.features`). */
export const FEATURES = {
  /** The steps of a turn still running, on `agents.status` (`status.work`). */
  liveWork: 'work.live',
} as const;
export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export interface RequestFrame<M extends MethodName = MethodName> {
  t: 'req';
  /** Unique per connection; echoed on the response. */
  id: number;
  method: M;
  params: Params<M>;
}

/** The app moved between foreground and background. */
export interface PresenceFrame {
  t: 'presence';
  foreground: boolean;
}

export interface PingFrame {
  t: 'ping';
}

export type ClientFrame = HelloFrame | RequestFrame | PresenceFrame | PingFrame;

// ---- Mac → phone ------------------------------------------------------------

export interface WelcomeFrame {
  t: 'welcome';
  /** The version both sides speak, from `negotiate`. */
  protocol: number;
  server: { id: string; name: string; appVersion: string };
  deviceId: string;
  /**
   * `replay`: the events after `hello.resume` follow, then `sync.caughtUp`.
   * `snapshot`: the cursor was unknown or too old; a `sync.snapshot` event
   * follows, then `sync.caughtUp`. Cached messages must be re-fetched.
   */
  resume: 'replay' | 'snapshot';
  /** Methods this Mac supports, so a newer app can hide what an older Mac lacks. */
  methods: MethodName[];
  /**
   * The Mac's IANA zone ("America/New_York"): routine times are its wall
   * clock, so the phone shows them in it. Absent from older Macs and when
   * the Mac can't say. A Mac that sends it keeps a check-in's schedule when
   * `agents.schedule.update` has an empty `when` (a note-only edit).
   */
  timeZone?: string;
  /**
   * The Mac's signature over `hello.challenge` (`welcomeProofMessage`). The
   * phone checks it against the key it pinned at pairing before it trusts
   * anything on this socket, and sends secrets only on one that passed.
   */
  identity?: IdentityProof;
}

export interface RefusedFrame {
  t: 'refused';
  reason:
    | 'unauthorized'
    | 'revoked'
    /** The phone is older than the Mac supports: update the app. */
    | 'update_app'
    /** The Mac is older than the phone supports: update Ship Studio. */
    | 'update_mac'
    | 'too_many_connections'
    /**
     * Never sent by a Mac: the phone's own, when the server's `welcome`
     * isn't signed by the identity it pinned at pairing.
     */
    | 'not_your_mac';
  message: string;
}

export type ResponseFrame<M extends MethodName = MethodName> =
  | { t: 'res'; id: number; ok: true; result: Result<M> }
  | { t: 'res'; id: number; ok: false; error: WireError };

/**
 * One event. `seq` is present on journaled events: the phone stores
 * `{epoch, seq}` as its cursor once the event is applied. Ephemeral events
 * (drafts, alerts) have none and are never replayed.
 */
export interface EventFrame {
  t: 'evt';
  seq?: number;
  event: CompanionEvent;
}

/**
 * The answer to a `ping`, and also the Mac's heartbeat: sent unprompted every
 * `HEARTBEAT_MS` (alongside a WebSocket-level ping, which JS can't see), so
 * an idle link still hears from the Mac.
 */
export interface PongFrame {
  t: 'pong';
}

export type ServerFrame = WelcomeFrame | RefusedFrame | ResponseFrame | EventFrame | PongFrame;

/** The Mac sends a heartbeat `pong` every 15 s; no frame for this long means the link is dead. */
export const HEARTBEAT_MS = 15_000;
export const DEAD_AFTER_MS = 40_000;
