/**
 * Pictures over the relay (docs/relay.md): an image view can't fetch through
 * the end to end channel, so `session.attachmentSource` downloads each to a
 * file first and the views that drew it waiting draw it once it's there.
 * This is that file list and the redraw. Kept by what the picture is, so it's
 * fetched once; a failed one is tried again after the next welcome.
 */

import { useSyncExternalStore } from 'react';

/** File URI by picture, or null for one that couldn't be fetched. */
const kept = new Map<string, string | null>();
/** When each picture last failed: it's tried again once this long has passed. */
const failedAt = new Map<string, number>();
export const RELAY_IMAGE_RETRY_MS = 15_000;
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * The picture's file URI (a string), null if it couldn't be fetched, or
 * undefined while it comes: `fetch` runs once per key until it settles.
 */
export function relayImage(key: string, fetch: () => Promise<string>): string | null | undefined {
  if (kept.has(key)) {
    const v = kept.get(key);
    if (v !== null || Date.now() - (failedAt.get(key) ?? 0) < RELAY_IMAGE_RETRY_MS) return v;
    kept.delete(key);
  }
  if (!waiting.has(key)) {
    waiting.add(key);
    fetch().then(
      (uri) => {
        waiting.delete(key);
        failedAt.delete(key);
        kept.set(key, uri);
        changed();
      },
      () => {
        waiting.delete(key);
        failedAt.set(key, Date.now());
        kept.set(key, null);
        changed();
        // Drawn as a box until then; a redraw after the wait tries it again.
        setTimeout(changed, RELAY_IMAGE_RETRY_MS);
      }
    );
  }
  return undefined;
}

/** Forget the pictures that couldn't be fetched, so a new link tries them again. */
export function retryRelayImages() {
  let any = false;
  for (const [k, v] of kept) if (v == null && kept.delete(k)) any = true;
  if (any) changed();
}

/**
 * Re-renders the caller when a picture fetched over the relay arrives. Call
 * it in any component that draws `attachmentSource`; on Tailscale it never fires.
 */
export const useAttachmentSources = () => useSyncExternalStore(subscribe, () => version);
