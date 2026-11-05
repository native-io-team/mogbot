/**
 * An agent's badge and its status mark, drawn as the desktop sidebar draws
 * them: initials on a tile tinted with the agent's colour; one mark for
 * needs-you (amber), waiting on the Mac (grey), working (a spinner), didn't
 * finish (red), usage limit (amber) or unread (a strong dot).
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { distinctInitials, failedTurn, needsYou, teamNames, waitingForSlot } from '../lib/agents';
import { useApp } from '../lib/store';
import { avatarSize, fonts, iconSize, mix, squircle } from '../lib/theme';
import { agentTint } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { Dot, T } from './ui';

/** A string snapshot, so a streaming reply never re-renders a badge. */
const useTeamNames = () =>
  useApp((s) => (s.overview ? teamNames(s.overview.agents).join('\n') : ''));

export function AgentAvatar({
  name,
  color,
  size = avatarSize.header,
}: {
  name: string;
  color: string;
  size?: (typeof avatarSize)[keyof typeof avatarSize];
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const names = useTeamNames();
  const tint = agentTint(color, appearance);
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: squircle(size),
          // color-mix(tint 24%, --surface-control) / color-mix(tint 70%, --text-primary)
          backgroundColor: mix(tint, colors.surfaceControl, 0.24),
        },
      ]}
      accessible={false}
    >
      <T
        // Sized to the tile, not to Dynamic Type: the tile doesn't grow, so the
        // letters can't either (they were clipped out of it at AX sizes).
        allowFontScaling={false}
        style={{
          fontFamily: fonts.semibold,
          fontSize: Math.round(size * 0.36),
          lineHeight: Math.round(size * 0.48),
          textAlign: 'center',
          includeFontPadding: false,
        }}
        color={mix(tint, colors.textPrimary, 0.7)}
      >
        {distinctInitials(name, names ? names.split('\n') : [])}
      </T>
    </View>
  );
}

/** One breath of the working ring, ms: slow enough to sit in a list without drawing the eye. */
const RING_BREATH_MS = 1600;

/**
 * A working agent's ring, laid over its avatar (the parent is the tile's
 * size): its own colour, breathing slowly (opacity only, never size or
 * position, so nothing in the row moves). Under Reduce Motion it is still.
 */
export function WorkingRing({
  color,
  size = avatarSize.list,
}: {
  color: string;
  size?: (typeof avatarSize)[keyof typeof avatarSize];
}) {
  const styles = useStyles();
  const appearance = useAppearance();
  const still = useReducedMotion();
  const breath = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    breath.set(
      withRepeat(
        withTiming(1, { duration: RING_BREATH_MS, easing: Easing.inOut(Easing.sin) }),
        -1,
        true
      )
    );
    return () => cancelAnimation(breath);
  }, [breath, still]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: still ? 0.7 : 0.35 + breath.value * 0.55,
  }));
  const ring = size + RING_GAP * 2;
  return (
    <Animated.View
      testID="working-ring"
      pointerEvents="none"
      style={[
        styles.ring,
        {
          width: ring,
          height: ring,
          borderRadius: squircle(ring),
          borderColor: agentTint(color, appearance),
        },
        ringStyle,
      ]}
    />
  );
}

/** How far the working ring sits outside the tile. */
const RING_GAP = 3;

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
  useEffect(() => {
    turn.set(withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1));
    return () => cancelAnimation(turn);
  }, [turn]);
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
  avatar: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: -RING_GAP, left: -RING_GAP, borderWidth: 2 },
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
