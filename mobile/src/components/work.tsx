/**
 * What a turn did, under the message it ended on: one quiet line that opens
 * into the steps, as on the desktop (`AgentWork.tsx`). Only what the Mac
 * recorded; a message without `work` (or from an older Mac) shows nothing.
 */

import type { AgentMessage, TurnWork } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import { colors, space } from '../lib/theme';
import { earlierSteps, stepOffset, stepSymbol, workSummary } from '../lib/work';
import { Attachments } from './attachments';
import { Icon, T } from './ui';

export function WorkLine({
  message,
  work,
  onError,
}: {
  message: AgentMessage;
  work: TurnWork;
  onError: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (work.stepCount === 0) return null;
  const earlier = earlierSteps(work);
  const files = work.files ?? [];
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => {
          haptic.select();
          setOpen((o) => !o);
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.head}
      >
        <Icon name={open ? 'chevron.down' : 'chevron.right'} size={10} color={colors.textMuted} />
        <T variant="caption" color={colors.textMuted}>
          {workSummary(work)}
        </T>
      </Pressable>
      {open && (
        <Animated.View entering={FadeIn.duration(180)} style={styles.steps}>
          {earlier > 0 && (
            <T variant="caption" color={colors.textMuted} style={styles.indent}>
              {earlier === 1 ? '1 earlier step' : `${earlier} earlier steps`}
            </T>
          )}
          {work.steps.map((step, i) => (
            <View key={`${step.at}-${i}`} style={styles.stepBlock}>
              <View style={styles.step}>
                <View style={styles.icon}>
                  <Icon name={stepSymbol(step.kind)} size={11} color={colors.textMuted} />
                </View>
                <T
                  variant="caption"
                  color={colors.textSecondary}
                  numberOfLines={1}
                  style={styles.label}
                >
                  {step.label}
                </T>
                <T variant="caption" color={colors.textMuted} style={styles.time}>
                  {stepOffset(step, work.startedAt)}
                </T>
              </View>
              {step.image && (
                <View style={styles.indent}>
                  <Attachments
                    agentId={message.agentId}
                    attachments={[step.image]}
                    onError={onError}
                  />
                </View>
              )}
            </View>
          ))}
          {files.length > 0 && (
            <T variant="caption" color={colors.textMuted} style={styles.indent}>
              Edited {files.join(', ')}
              {work.fileCount > files.length ? ` and ${work.fileCount - files.length} more` : ''}
            </T>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const ICON = 16;

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start' },
  steps: { gap: space.sm },
  stepBlock: { gap: space.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  icon: { width: ICON, alignItems: 'center' },
  label: { flex: 1 },
  time: { fontVariant: ['tabular-nums'] },
  indent: { paddingLeft: ICON + space.sm },
});
