/**
 * "Already have agents in another assistant?" — asked once, at the top of
 * the phone's home, for an install that never answered it. The answer is
 * the Mac's (`agents.overview`'s `importChoice`, set with
 * `agents.setImportChoice`), so the desk and the phone stop asking
 * together. Afterwards import lives in the home's ⋯ menu.
 *
 * A Mac that doesn't send `importChoice`, or doesn't serve the setter,
 * never asks.
 */

import { useRouter } from 'expo-router';
import { IMPORT_CHOICE_BRING, IMPORT_CHOICE_NOTE, IMPORT_CHOICE_TITLE } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Card, ACTION } from './surfaces';
import { Button } from './ui';
import { call, describeError } from '../lib/session';
import { asOverview } from '../lib/wellFormed';
import { setApp, useApp } from '../lib/store';
import { haptic } from '../lib/haptics';
import { asksImportChoice } from '../lib/importChoice';

export function ImportChoiceCard() {
  const router = useRouter();
  const asks = useApp((s) => asksImportChoice(s.overview, s.welcome));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asks) return null;

  const decline = () => {
    setBusy(true);
    haptic.light();
    call('agents.setImportChoice', { choice: 'declined' })
      .then(() => call('agents.overview', {}))
      .then((raw) => {
        const overview = asOverview(raw);
        if (overview) setApp({ overview });
      })
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card
      icon="square.and.arrow.down"
      title={IMPORT_CHOICE_TITLE}
      note={error ?? IMPORT_CHOICE_NOTE}
      testID="import-choice-card"
      actions={
        <>
          <Button
            title="Start fresh"
            variant="outline"
            busy={busy}
            disabled={busy}
            onPress={decline}
            style={ACTION}
          />
          <Button
            title={IMPORT_CHOICE_BRING}
            variant="answer"
            disabled={busy}
            onPress={() => router.push('/import')}
            style={ACTION}
          />
        </>
      }
    />
  );
}
