/**
 * What the phone's login card and "What your team needs" share beyond the
 * sign-in itself: the "Not needed" receipt with its Undo (the desk's
 * `agents/declined.rs`; turned back on later from "What it can reach"), and
 * the re-check when the app comes back while claude.ai is being connected
 * here, so the card turns ✓ without the user saying anything.
 */

import type { DeclineReceipt } from '@shipstudio/companion-protocol';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { haptic } from '../lib/haptics';
import { loginsRecheck, loginsUndecline } from '../lib/logins';
import { describeError } from '../lib/session';
import { useServed } from '../lib/store';
import { Line } from './surfaces';

/** How long the receipt's Undo stays. */
export const UNDO_MS = 8000;

/** The last "Not needed" receipt, cleared after `UNDO_MS`. */
export function useDeclineReceipt() {
  const [receipt, setReceipt] = useState<DeclineReceipt | null>(null);
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => setReceipt(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [receipt]);
  return [receipt, setReceipt] as const;
}

/** "Not connecting Acme Bank. No agent will ask for it again. · Undo" */
export function DeclineReceiptLine({
  receipt,
  onDone,
  onError,
}: {
  receipt: DeclineReceipt;
  onDone: () => void;
  onError: (text: string) => void;
}) {
  return (
    <Line
      icon="checkmark"
      text={receipt.line}
      testID="decline-receipt"
      action={{
        label: 'Undo',
        onPress: () =>
          void loginsUndecline(receipt.keys).then(
            () => {
              haptic.select();
              onDone();
            },
            (e) => onError(describeError(e))
          ),
      }}
    />
  );
}

/** While something waits on claude.ai here, coming back to the app has the Mac check at once. */
export function useRecheckWhenBack(enabled: boolean) {
  const served = useServed('agents.loginsRecheck');
  useEffect(() => {
    if (!enabled || !served) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void loginsRecheck().catch(() => undefined);
    });
    return () => sub.remove();
  }, [enabled, served]);
}
