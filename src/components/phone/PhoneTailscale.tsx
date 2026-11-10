/**
 * Tailscale on the phone: the step people miss. The phone reaches this Mac
 * only through it, signed in to the same account, and without it a scan
 * ends on a phone waiting for a Mac that never hears from it. Said with the
 * account this Mac is signed in as when Tailscale reports one, and with
 * Tailscale's own store links.
 *
 * @module components/phone/PhoneTailscale
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { TextButton } from '../primitives/TextButton';
import { ExternalLinkIcon } from '@/components/icons';
import { TAILSCALE_ANDROID_URL, TAILSCALE_IOS_URL } from '../../lib/companion';
import { PHONE_APP_ON_ANDROID } from '../../lib/phoneApp';

const STORES = {
  ios: { label: 'App Store', where: 'the App Store', url: TAILSCALE_IOS_URL },
  android: { label: 'Google Play', where: 'Google Play', url: TAILSCALE_ANDROID_URL },
} as const;

/**
 * Tailscale's store page for one platform, or for every platform the phone
 * app exists on (just the App Store while it's iPhone only).
 */
export function TailscaleStoreLinks({ platform }: { platform?: 'ios' | 'android' }) {
  const stores = platform
    ? [STORES[platform]]
    : PHONE_APP_ON_ANDROID
      ? [STORES.ios, STORES.android]
      : [STORES.ios];
  return (
    <span className="phone-tailscale__links">
      {stores.map((s) => (
        <TextButton
          key={s.url}
          rightIcon={<ExternalLinkIcon size={12} />}
          onClick={() => void openUrl(s.url)}
        >
          {platform ? `Get Tailscale on ${s.where}` : s.label}
        </TextButton>
      ))}
    </span>
  );
}
