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
   */
  | { kind: 'connecting'; attempt: number; since?: number }
  | { kind: 'connected'; route: RouteKind | 'relay'; since: number }
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
