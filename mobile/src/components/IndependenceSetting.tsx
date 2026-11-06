/**
 * Settings → How much agents do on their own: the same four choices as the
 * desk's Settings → Agents, worded by the protocol's `independence.ts`. Read
 * from the overview (`independence`), written with `agents.setIndependence`,
 * which the Mac audits. A Mac that doesn't send it shows nothing; one that
 * doesn't serve the write shows the choice, not offered.
 */

import {
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_QUESTION,
  INDEPENDENCE_STILL_ASKS,
  type AgentIndependence,
} from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Icon, Row, Section, tap } from './ui';
import { useAccent } from '../lib/accent';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { iconSize } from '../lib/theme';

export function IndependenceSetting() {
  const accent = useAccent();
  const level = useApp((s) => s.overview?.independence ?? null);
  const canSet = useServed('agents.setIndependence');
  const [busy, setBusy] = useState(false);
  if (!level) return null;

  const change = async (next: AgentIndependence) => {
    if (busy) return;
    tap();
    setBusy(true);
    try {
      // The overview follows as an event; nothing to merge here.
      await call('agents.setIndependence', { level: next });
    } catch (e) {
      haptic.error();
      Alert.alert('Couldn’t change it', describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={INDEPENDENCE_QUESTION} footer={INDEPENDENCE_STILL_ASKS[level]}>
      {INDEPENDENCE_LEVELS.map((l, i) => {
        const on = l === level;
        return (
          <Row
            key={l}
            label={INDEPENDENCE_LABEL[l]}
            detail={INDEPENDENCE_DETAIL[l]}
            selected={on}
            onPress={canSet && !on ? () => void change(l) : undefined}
            trailing={
              on ? (
                <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
              ) : (
                <View style={styles.check} />
              )
            }
            last={i === INDEPENDENCE_LEVELS.length - 1}
          />
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  check: { width: iconSize.body },
});
