/**
 * An agent's status mark beside its key (components/AgentKey.tsx): one mark
 * for needs-you (amber), waiting on the Mac (grey), working (a spinner),
 * didn't finish (red), usage limit (amber) or unread (a strong dot); and the
 * spinner every loading indicator uses.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { failedTurn, needsYou, waitingForSlot } from '../lib/agents';
import { iconSize } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { useMoving } from '../lib/moving';
import { Dot } from './ui';

/**
 * `live` false: the Mac isn't answering, so this is only the last thing it
 * said. Marks go grey and nothing turns: a spinner would claim work we can't
 * see.
 */
export function StatusMark({
  agent,
  live = true,
  onMac = false,
}: {
  agent: Agent;
  live?: boolean;
  /** All it waits on is answered on the Mac (`waitingOnMac`): not amber, nothing to do here. */
  onMac?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const failure = failedTurn(agent);
  if (!live) {
    if (agent.status.state === 'working') return <View style={styles.wasWorking} />;
    if (needsYou(agent) || failure || agent.unread > 0) return <Dot color={colors.textMuted} />;
    return null;
  }
  if (onMac) return <Dot color={colors.textSecondary} />;
  if (needsYou(agent)) return <Dot color={colors.accentWarning} glow />;
  // Queued for a slot: a still ring, since nothing is running yet.
  if (waitingForSlot(agent)) {
    return (
      <View
        accessibilityLabel="Waiting for a free slot"
        style={[styles.wasWorking, styles.queued]}
      />
    );
  }
  if (agent.status.state === 'working') return <Spinner label="Working" />;
  if (failure) {
    return (
      <Dot color={failure.kind === 'usage_limit' ? colors.accentWarning : colors.accentError} />
    );
  }
  if (agent.unread > 0) return <Dot color={colors.textStrong} />;
  return null;
}

/**
 * A small arc that turns: the working state, quiet enough to sit in a list,
 * and every loading indicator. Silent to VoiceOver unless given a `label`:
 * only an agent's status says "Working"; a page loading says nothing.
 */
export function Spinner({
  size = iconSize.inline,
  color,
  label,
}: {
  size?: (typeof iconSize)[keyof typeof iconSize];
  color?: string;
  label?: string;
}) {
  const colors = useColors();
  color ??= colors.textSecondary;
  const turn = useSharedValue(0);
  // In the background or on a screen not showing, it holds where it is.
  const moving = useMoving(false);
  useEffect(() => {
    if (!moving) return;
    turn.set(withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1));
    return () => cancelAnimation(turn);
  }, [turn, moving]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View
      accessible={!!label}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'auto' : 'no-hide-descendants'}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: colors.surfaceSelected,
          borderTopColor: color,
        },
        style,
      ]}
    />
  );
}

const useStyles = makeStyles((colors) => ({
  // A still ring: "it was working when we last heard".
  wasWorking: {
    width: iconSize.inline,
    height: iconSize.inline,
    borderRadius: iconSize.inline / 2,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
  },
  queued: { borderColor: colors.textSecondary, borderStyle: 'dashed' },
}));
