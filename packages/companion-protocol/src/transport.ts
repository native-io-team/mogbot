/**
 * The seam the future relay plugs into.
 *
 * The app's screens talk to a `Transport`, never to a socket. Today there is
 * one implementation, `DirectTransport` (WebSocket + HTTP to a route); a relay
 * becomes a second one carrying the same frames, end-to-end encrypted with the
 * keys exchanged at pairing. Nothing above this interface changes.
 */

import type { CompanionEvent } from './events';
import type { Cursor } from './frames';
import type { MethodName, Params, Result, BlobRef } from './methods';
import type { RouteKind } from './model';

export type LinkState =
  /**
   * Trying routes in order. `since`: when this spell of trying began (or the
   * app last came forward during it), so a short one reads as calm.
   * `appStuck`: as for `reconnecting`.
   */
  | { kind: 'connecting'; attempt: number; since?: number; appStuck?: boolean }
  /**
   * `stuck`: since when a request went unanswered though the Mac's heartbeat
   * still arrives. Its connection is fine; the app on it isn't answering.
   */
  | { kind: 'connected'; route: RouteKind | 'relay'; since: number; stuck?: number }
  /**
   * Was connected; retrying with backoff. `lastSeenAt` is the last frame from
   * the Mac; `since` as for `connecting`. `macClosing`: the Mac's app said
   * goodbye as it closed (a quit, an update's restart), so it may well be back.
   */
  | {
      kind: 'reconnecting';
      lastSeenAt: number;
      nextTryAt: number;
      since?: number;
      macClosing?: boolean;
      /**
       * In this spell, something at the Mac's address took the connection but
       * the app on it didn't answer (a request timed out with the heartbeat
       * still coming, or a socket opened and stayed silent): the Mac is on and
       * reachable, the app is stuck. Absent when nothing answered at all.
       */
      appStuck?: boolean;
    }
  /** The Mac said no for good: re-pair (revoked) or update a side. */
  | {
      kind: 'refused';
      reason:
        | 'revoked'
        | 'unauthorized'
        | 'update_app'
        | 'update_mac'
        | 'not_your_mac'
        | 'mac_reset'
        | 'pair_again';
    };

export interface Transport {
  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  /** Every event in order. Returns an unsubscribe. */
  onEvent(listener: (event: CompanionEvent, cursor?: Cursor) => void): () => void;
  onState(listener: (state: LinkState) => void): () => void;
  /** `PUT /v1/blobs`. `onProgress` gets the fraction sent, 0 to 1. */
  upload(
    file: { uri: string; name: string; mime: string },
    onProgress?: (fraction: number) => void
  ): Promise<BlobRef>;
  /** A local file URI for a blob or attachment, downloaded (and cached) on demand. */
  download(source: { blobId: string } | { agentId: string; path: string }): Promise<string>;
  setForeground(foreground: boolean): void;
  close(): void;
}
