/**
 * An agent's avatar and its status mark, drawn as the desktop sidebar draws
 * them: a shape and a little face in the agent's colour; one mark for
 * needs-you (amber), waiting on the Mac (grey), working (a spinner), didn't
 * finish (red), usage limit (amber) or unread (a strong dot).
 */

import {
  BLINK_EVERY_MS,
  BLINK_MS,
  BOB_LIFT,
  BOB_MS,
  EYE_LINE,
  FACE_SPECS,
  SHAPE_SPECS,
  blinkPhase,
  faceTransform,
  faceWeights,
  lookFor,
  type Agent,
  type AgentLook,
} from '@shipstudio/companion-protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import Svg, { G, Path } from 'react-native-svg';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { failedTurn, needsYou, waitingForSlot } from '../lib/agents';
import { useApp } from '../lib/store';
import { alpha, avatarSize, iconSize, mix } from '../lib/theme';
import { agentTint } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { Dot } from './ui';

/**
 * Every agent's saved look as one string, so a streaming reply never
 * re-renders an avatar (the same snapshot the desk takes).
 */
const useTeamLooks = () =>
  useApp((s) =>
    (s.overview?.agents ?? [])
      .map((a) => `${a.id}\t${a.isMain ? 1 : 0}\t${a.avatar?.shape ?? ''}\t${a.avatar?.face ?? ''}`)
      .join('\n')
  );

function lookFromTeam(team: string, id: string): AgentLook | null {
  for (const line of team.split('\n')) {
    const [lineId, main, shape, face] = line.split('\t');
    if (lineId !== id) continue;
    return lookFor({
      id,
      isMain: main === '1',
      avatar: { shape: shape as AgentLook['shape'], face: face as AgentLook['face'] },
    });
  }
  return null;
}

/** The look to draw: given, else the registry's for `id`, else one from the name. */
function useLook(id: string | undefined, name: string, given: AgentLook | undefined): AgentLook {
  const team = useTeamLooks();
  return useMemo(
    () => given ?? (id ? lookFromTeam(team, id) : null) ?? lookFor({ id: id ?? `name:${name}` }),
    [given, id, team, name]
  );
}

/**
 * An agent's avatar: a soft shape in a tone of its colour with a minimal face
 * in an ink of the same hue, drawn from the spec the desk draws from
 * (`avatar.ts` in the protocol package; docs/internal/avatars.md). While it
 * works it blinks now and then; when a turn ends it bobs once. Nothing at
 * rest; nothing with Reduce Motion.
 */
export function AgentAvatar({
  name,
  color,
  size = avatarSize.header,
  id,
  look: given,
  working = false,
  selected = false,
}: {
  name: string;
  color: string;
  size?: number;
  /** Its id: the look comes from the registry, or is derived from the id. */
  id?: string;
  /** An explicit look (the picker's preview). */
  look?: AgentLook;
  working?: boolean;
  /** Solid: the agent you're on. */
  selected?: boolean;
}) {
  const colors = useColors();
  const appearance = useAppearance();
  const look = useLook(id, name, given);
  const still = useReducedMotion();
  const tint = agentTint(color, appearance);
  // color-mix(tint 24%, --surface-control) / color-mix(tint 70%, --text-primary)
  const fill = selected ? tint : mix(tint, colors.surfaceControl, 0.24);
  const ink = selected ? colors.surfaceApp : mix(tint, colors.textPrimary, 0.7);
  // Working, the ring is the one line around it: no second edge inside.
  const edge = alpha(tint, selected || working ? 0 : 0.22);
  const blink = useBlink(working && !still, id ?? name);
  const bob = useBob(working, still, size);
  const shape = SHAPE_SPECS[look.shape];
  const weights = faceWeights(size);
  const strokes = FACE_SPECS[look.face];
  const blinks = (s: (typeof strokes)[number]) => s.role === 'eye' || Boolean(s.blinks);
  const stroke = (s: (typeof strokes)[number]) => (
    <Path
      key={s.d}
      d={s.d}
      stroke={ink}
      strokeWidth={s.role === 'eye' ? weights.eye : weights.line}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
  const squash = 0.12;
  return (
    <Animated.View
      style={[{ width: size, height: size }, bob]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      testID="agent-avatar"
    >
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Path d={shape.d} fill={fill} stroke={edge} strokeWidth={32 / size} />
        <G transform={faceTransform(look.shape) || undefined}>
          <G
            transform={
              blink ? `translate(0 ${EYE_LINE * (1 - squash)}) scale(1 ${squash})` : undefined
            }
          >
            {strokes.filter(blinks).map(stroke)}
          </G>
          {strokes.filter((s) => !blinks(s)).map(stroke)}
        </G>
      </Svg>
    </Animated.View>
  );
}

/** True for a blink's length every few seconds while `on`, each agent at its own moment. */
function useBlink(on: boolean, seed: string): boolean {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    if (!on) return;
    let close: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      setShut(true);
      close = setTimeout(() => setShut(false), BLINK_MS);
    };
    const first = setTimeout(
      () => {
        open();
        timer = setInterval(open, BLINK_EVERY_MS);
      },
      (blinkPhase(seed) * BLINK_EVERY_MS) / 4 + BLINK_EVERY_MS / 2
    );
    let timer: ReturnType<typeof setInterval> | undefined;
    return () => {
      clearTimeout(first);
      clearTimeout(close);
      clearInterval(timer);
      setShut(false);
    };
  }, [on, seed]);
  return shut;
}

/** One small lift and settle when `working` goes from true to false: the reply landed. */
function useBob(working: boolean, still: boolean, size: number) {
  const lift = useSharedValue(0);
  const was = useRef(working);
  useEffect(() => {
    const finished = was.current && !working;
    was.current = working;
    if (!finished || still) return;
    lift.set(
      withSequence(
        withTiming(-size * BOB_LIFT, { duration: BOB_MS * 0.4, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: BOB_MS * 0.6, easing: Easing.inOut(Easing.quad) })
      )
    );
  }, [working, still, size, lift]);
  return useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
}

/** One breath of the working ring, ms: slow enough to sit in a list without drawing the eye. */
const RING_BREATH_MS = 1600;

/**
 * A working agent's ring, laid over its avatar (the parent is the avatar's
 * size): its own colour, following its silhouette, breathing slowly
 * (opacity only, never size or position, so nothing in the row moves).
 * Under Reduce Motion it is still.
 */
export function WorkingRing({
  color,
  size = avatarSize.list,
  id,
  name = '',
}: {
  color: string;
  size?: number;
  id?: string;
  name?: string;
}) {
  const styles = useStyles();
  const appearance = useAppearance();
  const look = useLook(id, name, undefined);
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
      style={[styles.ring, { width: ring, height: ring }, ringStyle]}
    >
      <Svg width={ring} height={ring} viewBox="0 0 32 32">
        <Path
          d={SHAPE_SPECS[look.shape].d}
          fill="none"
          stroke={agentTint(color, appearance)}
          strokeWidth={(2 * 32) / ring}
          // The silhouette, drawn RING_GAP outside the avatar's own.
          transform={`translate(16 16) scale(${size / ring + 0.02}) translate(-16 -16)`}
        />
      </Svg>
    </Animated.View>
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
