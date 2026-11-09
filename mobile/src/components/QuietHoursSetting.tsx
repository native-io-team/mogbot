/**
 * Settings → Quiet hours: the team's window, read with `agents.quietHours`
 * and set with `agents.setQuietHours` (audited on the Mac). One row: what is
 * set ("22:00–07:00" or "Off"); tapping it offers the common nights and Off.
 * Other times are the Chief's (`set_quiet_hours`), or the desk's. A Mac that
 * doesn't serve it shows nothing; one that reads but can't set shows the row,
 * not tappable.
 */

import {
  QUIET_DETAIL,
  QUIET_PRESETS,
  QUIET_TITLE,
  quietLabel,
  type QuietWindow,
} from '@shipstudio/companion-protocol';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { choose } from './menu';
import { Row, Section, tap } from './ui';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';

const same = (a: QuietWindow | null, b: QuietWindow | null) =>
  a === b || (!!a && !!b && a.start === b.start && a.end === b.end);

export function QuietHoursSetting() {
  const canRead = useServed('agents.quietHours');
  const canSet = useServed('agents.setQuietHours');
  // `undefined` until the Mac answers: nothing is shown that wasn't read.
  const [quiet, setQuiet] = useState<QuietWindow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Read again once connected: Settings can open before the link is up.
  const connected = useApp((s) => s.link.kind === 'connected');

  const read = useCallback(() => {
    if (!canRead || !connected) return;
    call('agents.quietHours', {}).then(
      (r) => setQuiet(r.window),
      () => {}
    );
  }, [canRead, connected]);
  useEffect(() => {
    read();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && read());
    return () => sub.remove();
  }, [read]);

  if (!canRead || quiet === undefined) return null;

  const set = async (next: QuietWindow | null) => {
    if (busy || same(next, quiet)) return;
    setBusy(true);
    try {
      const r = await call('agents.setQuietHours', { window: next });
      haptic.select();
      setQuiet(r.window);
    } catch (e) {
      haptic.error();
      Alert.alert('Couldn’t change quiet hours', describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = () => {
    tap();
    choose(
      QUIET_TITLE,
      [
        ...QUIET_PRESETS.map((w) => ({ label: quietLabel(w), run: () => void set(w) })),
        ...(quiet ? [{ label: 'Turn off', destructive: true, run: () => void set(null) }] : []),
      ],
      'Other times: ask your Chief of Staff, or set them on your Mac.'
    );
  };

  return (
    <Section title={QUIET_TITLE} footer={QUIET_DETAIL}>
      <Row
        label={QUIET_TITLE}
        value={quietLabel(quiet)}
        onPress={canSet ? pick : undefined}
        disabled={canSet && busy}
        last
      />
    </Section>
  );
}
