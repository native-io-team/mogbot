/**
 * The seam between the screens and the link.
 *
 * The app's screens talk to a `Transport`, never to a socket. `DirectTransport`
 * carries the same frames over each route: a Tailscale socket and HTTP, or the
 * relay's socket end to end encrypted to the Mac's pinned key, with HTTP as
 * frames inside it (docs/relay.md). Nothing above this interface changes.
 */

import type { CompanionEvent } from './events';
import type { Cursor } from './frames';
import type { MethodName, Params, Result, BlobRef } from './methods';
import type { RouteKind } from './model';

/** A passing refusal (`LinkState.macSaid`). */
export type MacSaid = 'too_many_connections' | 'unavailable' | 'other_account';

/**
 * What the relay answered for the Mac (`LinkState.relaySaid`, docs/relay.md):
 * `mac_offline`, it isn't connected to the relay (close 4404); `sign_in_needed`,
 * it's connected but signed out, so the relay won't carry phones to it (4402).
 */
export type RelaySaid = 'mac_offline' | 'sign_in_needed';

export type LinkState =
  /**
   * Trying routes in order. `since`: when this spell of trying began (or the
   * app last came forward during it), so a short one reads as calm.
   * `appStuck`: as for `reconnecting`.
   */
  | {
      kind: 'connecting';
      attempt: number;
      since?: number;
      appStuck?: boolean;
      /** As for `reconnecting`. */
      macSaid?: MacSaid;
      /** As for `reconnecting`. */
      relaySaid?: RelaySaid;
    }
  /**
   * `stuck`: since when a request went unanswered though the Mac's heartbeat
   * still arrives. Its connection is fine; the app on it isn't answering.
   */
  | { kind: 'connected'; route: RouteKind; since: number; stuck?: number }
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
      /**
       * In this spell the Mac answered and turned the phone away for a
       * reason that passes, or that the user fixes without pairing again
       * (`RefusedFrame.reason`): the phone keeps trying and says this,
       * never "can't reach".
       */
      macSaid?: MacSaid;
      /**
       * The relay's last answer in this spell (`RelaySaid`): the Mac isn't
       * connected to it (asleep, off the internet, the app closed), or isn't
       * signed in. Known, not guessed: said as that, never Tailscale advice.
       */
      relaySaid?: RelaySaid;
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
  /**
   * A local file URI for a blob or attachment, downloaded (and cached) on
   * demand. `width` asks for an image attachment's thumbnail (`?w=`).
   */
  download(
    source: { blobId: string } | { agentId: string; path: string },
    width?: number
  ): Promise<string>;
  setForeground(foreground: boolean): void;
  close(): void;
}
