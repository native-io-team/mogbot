/**
 * What a pull to refresh found, said where the spinner was: "✓ Up to date ·
 * just now" for a moment after it worked, then folded away; "Couldn't reach
 * your Mac · Try again" after it didn't, until it's tried again or tapped
 * away. One for every refreshable list, fed by `useRefresh` (lib/refresh).
 *
 * It opens and folds by animating its own height on the UI thread, from a
 * measured inner line, so the list under it slides rather than jumps and the
 * spinner's own spring isn't disturbed.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import type { RefreshOutcome } from '../lib/refresh';
import { duration } from '../lib/theme';
import { Line } from './surfaces';

export function RefreshStatus({
  outcome,
  onRetry,
  onDismiss,
}: {
  outcome: RefreshOutcome;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  // What to show while folding away: the last thing it said, not nothing.
  const [said, setSaid] = useState<Exclude<RefreshOutcome, 'idle'>>('done');
  const open = useSharedValue(0);
  const height = useSharedValue(0);

  useEffect(() => {
    if (outcome === 'done') {
      setSaid('done');
      haptic.light();
    } else if (outcome === 'failed') {
      setSaid('failed');
      haptic.warning();
    }
    open.value = withTiming(outcome === 'idle' ? 0 : 1, { duration: duration.slow });
  }, [outcome, open]);

  const fold = useAnimatedStyle(() => ({
    height: height.value * open.value,
    opacity: open.value,
  }));

  const line =
    said === 'done' ? (
      <Line icon="checkmark" tone="success" lead="Up to date" text="just now" testID="refresh-done" />
    ) : (
      <Line
        icon="exclamationmark.circle"
        tone="warning"
        text="Couldn’t reach your Mac"
        action={{ label: 'Try again', onPress: onRetry }}
        testID="refresh-failed"
      />
    );

  return (
    <Animated.View
      style={[styles.fold, fold]}
      pointerEvents={outcome === 'idle' ? 'none' : 'box-none'}
      accessibilityElementsHidden={outcome === 'idle'}
      importantForAccessibility={outcome === 'idle' ? 'no-hide-descendants' : 'auto'}
      accessibilityLiveRegion="polite"
    >
      <View
        style={styles.measure}
        onLayout={(e) => {
          height.value = e.nativeEvent.layout.height;
        }}
      >
        {said === 'failed' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Hides this"
            onPress={onDismiss}
            disabled={outcome !== 'failed'}
          >
            {line}
          </Pressable>
        ) : (
          line
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fold: { overflow: 'hidden' },
  // Laid out at its natural height whatever the fold's is, so it can be measured.
  measure: { position: 'absolute', top: 0, left: 0, right: 0 },
});
