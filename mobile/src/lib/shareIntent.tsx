/**
 * The share sheet's way in: when a build carries expo-share-intent's native
 * extension (docs/mobile.md, "Send to agent…"), what was shared opens the
 * "Send to agent…" sheet.
 *
 * Whether the extension is in this build is the app config's
 * `extra.shareExtension`, set only when `SHIPSTUDIO_SHARE_EXTENSION=1` was
 * there at prebuild (`app.config.ts`). Not the native module: autolinking
 * links that into every dev and release build, extension or not. Without the
 * flag nothing here loads expo-share-intent at all, so its hook never runs,
 * never refreshes on foreground and never reads an intent another app sent.
 *
 * What was shared waits in memory (`stashShare`); the route carries only its
 * one-time key, so a `share?` link can't hand the screen files.
 */

import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import type { useShareIntent as UseShareIntent } from 'expo-share-intent';
import { fromShareIntent, isEmptyShare, stashShare } from './share';
import { useApp } from './store';

/** Whether this build was made with the share extension (`extra.shareExtension`). */
export function shareExtensionBuilt(
  extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra
): boolean {
  return extra?.shareExtension === true;
}

/** Only required in a build with the extension, so the rest never load it. */
function loadHook(): typeof UseShareIntent | null {
  if (!shareExtensionBuilt()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('expo-share-intent') as typeof import('expo-share-intent')).useShareIntent;
  } catch {
    return null;
  }
}

const useShareIntentHook = loadHook();

export function ShareIntentBridge() {
  return useShareIntentHook ? <Bridge useShareIntent={useShareIntentHook} /> : null;
}

function Bridge({ useShareIntent }: { useShareIntent: typeof UseShareIntent }) {
  const router = useRouter();
  const paired = useApp((s) => !!s.credentials);
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    // A share you haven't sent anywhere yet survives switching apps.
    resetOnBackground: false,
  });

  useEffect(() => {
    // Unpaired, there's no agent to send it to: the pair screen comes first.
    if (!hasShareIntent || !paired) return;
    const payload = fromShareIntent(shareIntent);
    resetShareIntent();
    if (!isEmptyShare(payload)) {
      router.push({ pathname: '/share', params: { k: stashShare(payload) } });
    }
    // Once per share: the intent is cleared above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent, paired]);

  return null;
}
