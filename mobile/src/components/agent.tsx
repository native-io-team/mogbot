/**
 * An agent's avatar and its status mark, drawn as the desktop sidebar draws
 * them: a key cap in the agent's colour with a face on its top; one mark for
 * needs-you (amber), waiting on the Mac (grey), working (a spinner), didn't
 * finish (red), usage limit (amber) or unread (a strong dot).
 */

import {
  AVATAR_MOTION,
  DEBOSS_DEPTH,
  FACE_SPECS,
  KEY,
  LIT_MIN_PX,
  MONOGRAM,
  MOUTH_MIN_PX,
  SHAPE_PATHS,
  SMALL_MOTION,
  TOP_TRANSFORM,
  avatarPaint,
  eyeAt,
  faceWeight,
  idlePhase,
  isPressed,
  lookFor,
  monogramLetter,
  rimBlur,
  type Agent,
  type AgentLook,
  type AvatarMood,
  type AvatarPaint,
  type FaceKey,
  type ValueKey,
} from '@shipstudio/companion-protocol';
import { useIsFocused } from 'expo-router';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import Svg, {
  Defs,
  Ellipse,
  FeComposite,
  FeFlood,
  FeGaussianBlur,
  FeMerge,
  FeMergeNode,
  FeOffset,
  Filter,
  G,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { failedTurn, needsYou, waitingForSlot } from '../lib/agents';
import { useApp } from '../lib/store';
import { alpha, avatarSize, fonts, iconSize, keyLight } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { Dot } from './ui';

/**
 * Every agent's saved look as one string, so a streaming reply never
 * re-renders an avatar (the same snapshot the desk takes).
 */
const useTeamLooks = () =>
  useApp((s) =>
    (s.overview?.agents ?? [])
      .map(
        (a) =>
          `${a.id}\t${a.isMain ? 1 : 0}\t${a.avatar?.shape ?? ''}\t${a.avatar?.face ?? ''}\t${
            a.avatar?.finish ?? ''
          }`
      )
      .join('\n')
  );

function lookFromTeam(team: string, id: string): Required<AgentLook> | null {
  for (const line of team.split('\n')) {
    const [lineId, main, shape, face, finish] = line.split('\t');
    if (lineId !== id) continue;
    return lookFor({ id, isMain: main === '1', avatar: { shape, face, finish } });
  }
  return null;
}

/** The look to draw: given, else the registry's for `id`, else one from the name. */
function useLook(
  id: string | undefined,
  name: string,
  given: AgentLook | undefined
): Required<AgentLook> {
  const team = useTeamLooks();
  return useMemo(
    () =>
      given
        ? lookFor({ id: id ?? `name:${name}`, avatar: given })
        : ((id ? lookFromTeam(team, id) : null) ?? lookFor({ id: id ?? `name:${name}` })),
    [given, id, team, name]
  );
}

/**
 * An agent's avatar: a key cap from the spec the desk draws from (`avatar.ts`
 * in the protocol package; docs/internal/avatars.md). Below 24px, flat.
 * It moves to say what the agent is doing, on the UI thread (Reanimated):
 * drifts when idle, looks around while it works, looks out at you when it
 * needs you, presses once when it's done, looks down when it failed. The
 * eyes never close and nothing rings it. Still with Reduce Motion, while the
 * app is in the background and on a screen that isn't showing.
 */
export function AgentAvatar({
  name,
  color,
  size = avatarSize.header,
  id,
  look: given,
  mood: givenMood,
  working = false,
  selected = false,
  still = false,
}: {
  name: string;
  color: string;
  size?: number;
  /** Its id: the look comes from the registry, or is derived from the id. */
  id?: string;
  /** An explicit look (the picker's preview). */
  look?: AgentLook;
  /** What it's doing (`agentMood`). Done is noticed here: working, then idle. */
  mood?: AvatarMood;
  /** Shorthand for `mood="working"`. */
  working?: boolean;
  /** Solid: the agent you're on. */
  selected?: boolean;
  /** Holds still whatever it's doing: a choice in the look picker. */
  still?: boolean;
}) {
  const colors = useColors();
  const appearance = useAppearance();
  const look = useLook(id, name, given);
  const paint = avatarPaint(color, appearance, selected);
  const lit = size >= LIT_MIN_PX;
  const cap = lit && look.finish === 'keycap';
  const shape = SHAPE_PATHS[look.shape];
  const rim = cap ? KEY.capRim : KEY.embossRim(size);
  const top = cap ? TOP_TRANSFORM : undefined;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ink = paint.ink ?? colors.surfaceApp;
  const moving = useMoving(still);
  const mood = useMood(givenMood ?? (working ? 'working' : 'idle'));
  const motion = useMotion(moving ? mood : null, size, cap, lit, id);
  return (
    <View
      style={{ width: size, height: size }}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      testID="agent-avatar"
    >
      {cap && (
        <Layer size={size}>
          <Defs>
            <Filter id={`${uid}s`} x="-20%" y="-20%" width="140%" height="150%">
              <FeGaussianBlur stdDeviation={KEY.shadow.blur} />
            </Filter>
          </Defs>
          <Path
            d={shape}
            transform={`translate(0 ${KEY.shadow.dy})`}
            fill={keyLight.shade}
            opacity={paint.shadow}
            filter={`url(#${uid}s)`}
          />
          <Path d={shape} fill={paint.side} />
        </Layer>
      )}
      <Animated.View style={[StyleSheet.absoluteFill, motion.press]}>
        <Layer size={size}>
          {lit ? (
            <>
              <Defs>
                <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={paint.topHigh} />
                  <Stop offset="1" stopColor={paint.topLow} />
                </LinearGradient>
                <RimFilter id={`${uid}r`} depth={rim} paint={paint} />
              </Defs>
              <G transform={top}>
                <Path d={shape} fill={`url(#${uid}g)`} filter={`url(#${uid}r)`} />
              </G>
            </>
          ) : (
            <Path d={shape} fill={paint.fill} />
          )}
        </Layer>
        {lit && mood === 'working' && moving && (
          <Animated.View style={[StyleSheet.absoluteFill, motion.glow]}>
            <Layer size={size}>
              <Defs>
                <RimFilter id={`${uid}w`} depth={rim} paint={paint} lightOnly />
              </Defs>
              <G transform={top}>
                <Path d={shape} fill={keyLight.shade} filter={`url(#${uid}w)`} />
              </G>
            </Layer>
          </Animated.View>
        )}
        <Animated.View style={[StyleSheet.absoluteFill, motion.face]}>
          <Layer size={size}>
            <G transform={top}>
              <Face look={look} name={name} px={size} paint={paint} ink={ink} selected={selected} />
            </G>
          </Layer>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** One layer of the drawing, on the 32-unit grid. */
function Layer({ size, children }: { size: number; children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" style={StyleSheet.absoluteFill}>
      {children}
    </Svg>
  );
}

/**
 * Light on the top rim and shade on the bottom one, inside the shape only
 * (the desk's `RimFilter`, primitive for primitive).
 */
function RimFilter({
  id,
  depth,
  paint,
  lightOnly = false,
}: {
  id: string;
  depth: number;
  paint: AvatarPaint;
  lightOnly?: boolean;
}) {
  const blur = rimBlur(depth);
  return (
    <Filter id={id} x="-10%" y="-10%" width="120%" height="120%">
      <FeOffset in="SourceAlpha" dy={depth} result="dn" />
      <FeComposite in="SourceAlpha" in2="dn" operator="out" result="top" />
      <FeGaussianBlur in="top" stdDeviation={blur.light} result="topb" />
      <FeFlood floodColor={keyLight.light} floodOpacity={paint.rimLight} result="hlc" />
      <FeComposite in="hlc" in2="topb" operator="in" result="hl" />
      {lightOnly ? (
        <FeComposite in="hl" in2="SourceAlpha" operator="in" />
      ) : (
        <>
          <FeOffset in="SourceAlpha" dy={-depth} result="up" />
          <FeComposite in="SourceAlpha" in2="up" operator="out" result="bot" />
          <FeGaussianBlur in="bot" stdDeviation={blur.shade} result="botb" />
          <FeFlood floodColor={keyLight.shade} floodOpacity={paint.rimShade} result="shc" />
          <FeComposite in="shc" in2="botb" operator="in" result="sh" />
          <FeMerge result="all">
            <FeMergeNode in="SourceGraphic" />
            <FeMergeNode in="hl" />
            <FeMergeNode in="sh" />
          </FeMerge>
          <FeComposite in="all" in2="SourceAlpha" operator="in" />
        </>
      )}
    </Filter>
  );
}

/** The face on the top: drawn on in the ink, or pressed in as wells with a light lip. */
function Face({
  look,
  name,
  px,
  paint,
  ink,
  selected,
}: {
  look: Required<AgentLook>;
  name: string;
  px: number;
  paint: AvatarPaint;
  ink: string;
  selected: boolean;
}) {
  const spec = FACE_SPECS[look.face];
  const pressed = isPressed(look.face, px, selected);
  const fill = pressed ? paint.well : ink;
  const lip = alpha(keyLight.light, paint.lip);
  const d = pressed ? DEBOSS_DEPTH : 0;
  if (spec.monogram) {
    const letter = monogramLetter(name);
    const text = (c: string, dy: number) => (
      <SvgText
        x={MONOGRAM.x}
        y={MONOGRAM.y + dy}
        textAnchor="middle"
        fontFamily={fonts.semibold}
        fontSize={MONOGRAM.size}
        fill={c}
      >
        {letter}
      </SvgText>
    );
    return (
      <>
        {d > 0 && text(lip, d)}
        {text(fill, 0)}
      </>
    );
  }
  const w = faceWeight(px);
  const eyes = spec.eyes.map((e) => eyeAt(e, px));
  const mouth = spec.mouth && px > MOUTH_MIN_PX ? spec.mouth : null;
  const stroke = (path: string, c: string, dy: number) => (
    <Path
      d={path}
      transform={dy ? `translate(0 ${dy})` : undefined}
      fill="none"
      stroke={c}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
  return (
    <>
      {eyes.map((e) => (
        <G key={e.cx}>
          {d > 0 && <Ellipse cx={e.cx} cy={e.cy + d} rx={e.rx} ry={e.ry} fill={lip} />}
          <Ellipse cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill={fill} />
        </G>
      ))}
      {mouth && d > 0 && stroke(mouth, lip, d)}
      {mouth && stroke(mouth, fill, 0)}
    </>
  );
}

/** False with Reduce Motion, in the background, on a screen that isn't showing, or `still`. */
function useMoving(still: boolean): boolean {
  const reduced = useReducedMotion();
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  let focused = true;
  try {
    // Outside a navigator (a test, a preview), there's no screen to leave and
    // the hook throws. It's called on every render all the same: the try only
    // catches that throw (`@react-navigation/native`'s context isn't ours to import).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    focused = useIsFocused();
  } catch {
    focused = true;
  }
  return !still && !reduced && active && focused;
}

/** The mood given, except that working then idle is done, for one press. */
function useMood(mood: AvatarMood): AvatarMood {
  const [state, setState] = useState({ was: mood, done: false });
  if (state.was !== mood) {
    setState({ was: mood, done: state.was === 'working' && mood === 'idle' });
  }
  useEffect(() => {
    if (!state.done) return;
    const t = setTimeout(() => setState((s) => ({ ...s, done: false })), AVATAR_MOTION.done.ms);
    return () => clearTimeout(t);
  }, [state.done]);
  return state.done ? 'done' : mood;
}

const ease = Easing.inOut(Easing.quad);

/** Keyframes as a Reanimated sequence: one timing per segment, `pick` choosing the value. */
function sequence<K extends FaceKey | ValueKey>(
  keys: readonly K[],
  ms: number,
  pick: (k: K) => number,
  scale: number
) {
  const steps = keys
    .slice(1)
    .map((k, i) =>
      withTiming(pick(k) * scale, { duration: (k[0] - keys[i][0]) * ms, easing: ease })
    );
  return withSequence(...steps);
}

/**
 * The mood's motion, on the UI thread: the face (in the top's units, a
 * little on a flat key), the press and the breathing light. `null`: hold
 * still, at rest.
 */
function useMotion(
  mood: AvatarMood | null,
  size: number,
  cap: boolean,
  lit: boolean,
  id: string | undefined
) {
  const fx = useSharedValue(0);
  const fy = useSharedValue(0);
  const press = useSharedValue(0);
  const glow = useSharedValue(0);
  const phase = useMemo(() => (id ? idlePhase(id) : 0), [id]);
  useEffect(() => {
    const all: SharedValue<number>[] = [fx, fy, press, glow];
    if (!mood) {
      // Setting a value stops whatever animation it had.
      all.forEach((v) => v.set(0));
      return;
    }
    all.forEach((v) => cancelAnimation(v));
    // Grid units to points: the face moves inside the top (drawn at 0.9 on a cap).
    const unit = size / 32;
    const faceUnit = unit * (cap ? KEY.top.scale : 1) * (lit ? 1 : SMALL_MOTION);
    const m = AVATAR_MOTION[mood];
    const run = <K extends FaceKey | ValueKey>(
      v: SharedValue<number>,
      keys: readonly K[] | undefined,
      pick: (k: K) => number,
      scale: number,
      hold: boolean
    ) => {
      if (!keys) {
        // A mood that doesn't move this part lets it settle where it rests.
        if (!hold) v.set(withTiming(0, { duration: m.ms / 2, easing: ease }));
        return;
      }
      const seq = sequence(keys, m.ms, pick, scale);
      if (!m.loop) v.set(seq);
      else if (mood === 'idle')
        // Twelve in a list never drift in step: each waits its own beat first.
        v.set(withDelay(phase % (m.ms / 3), withRepeat(seq, -1)));
      else v.set(withRepeat(seq, -1));
    };
    run(fx, m.face, (k) => k[1], faceUnit, false);
    run(fy, m.face, (k) => k[2], faceUnit, false);
    run(press, lit ? m.press : undefined, (k) => k[1], unit, false);
    run(glow, lit ? m.glow : undefined, (k) => k[1], 1, false);
    return () => all.forEach((v) => cancelAnimation(v));
  }, [mood, size, cap, lit, phase, fx, fy, press, glow]);
  return {
    face: useAnimatedStyle(() => ({
      transform: [{ translateX: fx.value }, { translateY: fy.value }],
    })),
    press: useAnimatedStyle(() => ({ transform: [{ translateY: press.value }] })),
    glow: useAnimatedStyle(() => ({ opacity: glow.value })),
  };
}

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
