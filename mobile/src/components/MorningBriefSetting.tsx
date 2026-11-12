/**
 * Settings → Morning brief: read with `agents.morningBrief` and set with
 * `agents.setMorningBrief` (audited on the Mac). One row: its time, or
 * "Off"; tapping it offers the common mornings and Off. Other times, posting
 * on quiet days and the user's own checks are the Chief's
 * (`set_morning_brief`), or the desk's. A Mac that doesn't serve it shows
 * nothing; one that reads but can't set shows the row, not tappable.
 */

import {
  BRIEF_DETAIL,
  BRIEF_TIMES,
  BRIEF_TITLE,
  briefLabel,
  type MorningBrief,
} from '@shipstudio/companion-protocol';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { choose } from './menu';
import { Row, Section, tap } from './ui';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { useComputer } from '../lib/computer';

export function MorningBriefSetting() {
  const comp = useComputer();
  const canRead = useServed('agents.morningBrief');
  const canSet = useServed('agents.setMorningBrief');
  // `undefined` until the Mac answers: nothing is shown that wasn't read.
  const [brief, setBrief] = useState<MorningBrief | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const connected = useApp((s) => s.link.kind === 'connected');

  const read = useCallback(() => {
    if (!canRead || !connected) return;
    call('agents.morningBrief', {}).then(
      (r) => setBrief(r),
      () => {}
    );
  }, [canRead, connected]);
  useEffect(() => {
    read();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && read());
    return () => sub.remove();
  }, [read]);

  if (!canRead || brief === undefined) return null;

  const set = async (on: boolean, at: number) => {
    if (busy || (on === brief.on && at === brief.at)) return;
    setBusy(true);
    try {
      const r = await call('agents.setMorningBrief', { on, at, always: brief.always });
      haptic.select();
      setBrief(r);
    } catch (e) {
      haptic.error();
      Alert.alert('Couldn’t change the morning brief', describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = () => {
    tap();
    choose(
      BRIEF_TITLE,
      [
        ...BRIEF_TIMES.map((at) => ({
          label: briefLabel({ on: true, at }),
          run: () => void set(true, at),
        })),
        ...(brief.on
          ? [{ label: 'Turn off', destructive: true, run: () => void set(false, brief.at) }]
          : []),
      ],
      `Other times: ask your Chief of Staff, or set it on ${comp.your}.`
    );
  };

  return (
    <Section title={BRIEF_TITLE} footer={BRIEF_DETAIL}>
      <Row
        label={BRIEF_TITLE}
        value={briefLabel(brief)}
        onPress={canSet ? pick : undefined}
        disabled={canSet && busy}
        last
      />
    </Section>
  );
}
