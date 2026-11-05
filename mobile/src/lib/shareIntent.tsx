/**
 * The share sheet's way in: when a build carries expo-share-intent's native
 * extension (docs/mobile.md, "Send to agent…"), what was shared opens the
 * "Send to agent…" sheet. Expo Go has no such extension, and there this
 * renders nothing at all: the hook is told it's disabled, so it never calls
 * a native module that isn't there.
 */

import { requireOptionalNativeModule } from 'expo';
import { useRouter } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';
import { useEffect } from 'react';
import { fromShareIntent, isEmptyShare, toParams } from './share';
import { useApp } from './store';

/** Whether this build has the share extension's native half. */
export const shareExtensionBuilt = () => !!requireOptionalNativeModule('ExpoShareIntentModule');

export function ShareIntentBridge() {
  const router = useRouter();
  const paired = useApp((s) => !!s.credentials);
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    disabled: !shareExtensionBuilt(),
    // A share you haven't sent anywhere yet survives switching apps.
    resetOnBackground: false,
  });

  useEffect(() => {
    // Unpaired, there's no agent to send it to: the pair screen comes first.
    if (!hasShareIntent || !paired) return;
    const payload = fromShareIntent(shareIntent);
    resetShareIntent();
    if (!isEmptyShare(payload)) router.push({ pathname: '/share', params: toParams(payload) });
    // Once per share: the intent is cleared above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent, paired]);

  return null;
}
