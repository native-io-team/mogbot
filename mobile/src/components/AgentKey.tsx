/**
 * An agent's key (docs/internal/agent-keys.md): a keycap in its colourway
 * with one legend on its face, the keyboard key it's bound to as a small
 * sublegend and its independence as pips on the front edge (big keys only).
 * The desk's `AgentKey` and the site's keys, drawn with Views and
 * react-native-svg: the skirt lit from above, the inset face, a solid
 * hard-edged depth under them, one soft ambient shadow; the legend from the
 * icon registry shared with the desk (`agentKeyIcons.ts`).
 *
 * States (`keyPose`, `keyPaint`): working is pressed, warm-lit and breathing,
 * its light spilling under it in its own colour; live is lit and still;
 * Needs your OK, the loudest, sits proud with an amber legend and spill,
 * pulsing; paused is drained of colour, faded and sunk; new is an empty
 * socket that fades in. `pressed` (the row it's in is held) sends it down.
 *
 * Cheap by design: no timers; only opacity animates, on the UI thread, and
 * only on a working key or one that needs your OK, still with Reduce Motion,
 * in the background and on a screen that isn't showing.
 */

import {
  KEY_ICON_GRID,
  KEY_PIP_COUNT,
  KEY_GEOMETRY,
  colorwayOf,
  iconDrawing,
  keyLookFor,
  pipsFor,
  type AgentIndependence,
  type KeyState,
} from '@shipstudio/companion-protocol';
import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { useAppearance } from '../lib/appearance';
import {
  KEY_BREATHE_LOW,
  KEY_BREATHE_MS,
  KEY_PULSE_LOW,
  KEY_PULSE_MS,
  keyGeometry,
  keyPaint,
  keyPose,
  type KeyGeometry,
  type KeyLight,
} from '../lib/agentKey';
import { useMoving } from '../lib/moving';
import { useApp } from '../lib/store';
import {
  fonts,
  keyColorways,
  keyLit,
  keyNeutrals,
  keySize,
  mix,
  type KeyColors,
} from '../lib/theme';

/**
 * Every agent's key and independence as one string, so a streaming reply
 * (which updates the store every few frames) never re-renders a key.
 */
const useTeamKeys = () =>
  useApp(
    (s) =>
      `${s.overview?.independence ?? ''}\n` +
      (s.overview?.agents ?? [])
        .map((a) => {
          const k = keyLookFor(a);
          return `${a.id}\t${k.colorway}\t${k.icon}\t${k.boundKey ?? ''}\t${a.independence ?? ''}`;
        })
        .join('\n')
  );

function keyFromTeam(team: string, id: string) {
  const [teamLevel, ...lines] = team.split('\n');
  for (const line of lines) {
    const [lineId, colorway, icon, boundKey, level] = line.split('\t');
    if (lineId !== id) continue;
    return {
      colorway,
      icon,
      boundKey: boundKey || null,
      level: ((level || teamLevel) as AgentIndependence) || null,
    };
  }
  return null;
}

export interface AgentKeyProps {
  /** Its id: what isn't given comes from the registry. */
  id?: string;
  /** Seeds a key for an agent that isn't in the registry (a draft, a preview). */
  name?: string;
  role?: string;
  /** An old avatar colour key: its nearest colourway, when none is given. */
  color?: string;
  isMain?: boolean;
  colorway?: string;
  icon?: string;
  /** The sublegend (big keys only); `null` shows none. */
  boundKey?: string | null;
  size?: number;
  state?: KeyState;
  /** Its independence, for the pips (big keys only); defaults to the registry's. */
  level?: AgentIndependence | null;
  /** A finger on what it's in: the cap goes all the way down. */
  pressed?: boolean;
}

export function AgentKey({
  id,
  name = '',
  role,
  color,
  isMain,
  colorway,
  icon,
  boundKey,
  size = keySize.md,
  state = 'idle',
  level,
  pressed = false,
}: AgentKeyProps) {
  const appearance = useAppearance();
  const team = useTeamKeys();
  const look = useMemo(() => {
    const saved = id ? keyFromTeam(team, id) : null;
    const fallback = keyLookFor({ name, role, color, isMain });
    return {
      colorway: colorway ?? saved?.colorway ?? fallback.colorway,
      icon: icon ?? saved?.icon ?? fallback.icon,
      boundKey: boundKey !== undefined ? boundKey : (saved?.boundKey ?? null),
      level: level !== undefined ? level : (saved?.level ?? null),
    };
  }, [team, id, name, role, color, isMain, colorway, icon, boundKey, level]);
  const way = colorwayOf(look.colorway);
  const base = keyColorways[way.id] ?? keyColorways.blue;
  const g = keyGeometry(size);
  const neutrals = keyNeutrals[appearance];
  const box = { width: size, height: size + g.rest };
  if (state === 'new') return <Socket g={g} box={box} />;
  const paint = keyPaint(way.id, base, state);
  const pose = keyPose(g, state, pressed);
  const pips = g.details ? pipsFor(look.level) : 0;
  const paused = state === 'paused';
  const legend = (
    <Legend icon={look.icon} g={g} ink={paint.legend} light={pose.light} dim={paused} />
  );
  return (
    <View
      style={box}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      testID="agent-key"
    >
      {pose.light !== 'none' && state !== 'live' ? (
        <Breathing kind={pose.light === 'ask' ? 'pulse' : 'breathe'} fill>
          <Spill g={g} color={spillColor(pose.light, base)} opacity={neutrals.spill} />
        </Breathing>
      ) : (
        state === 'live' && (
          <Spill g={g} color={spillColor('warm', base)} opacity={neutrals.spill} />
        )
      )}
      <View style={[StyleSheet.absoluteFill, paused && { opacity: neutrals.pausedOpacity }]}>
        {/* The depth: the cap's own shape, solid, set down under it; the soft ambient under that. */}
        <View
          testID="agent-key-depth"
          style={{
            position: 'absolute',
            top: pose.down + pose.depth,
            width: size,
            height: size,
            borderRadius: g.corner,
            backgroundColor: paint.depth,
            shadowColor: neutrals.ambient,
            shadowOpacity: neutrals.ambientOpacity,
            shadowRadius: g.ambientBlur / 2,
            shadowOffset: { width: 0, height: g.ambientY },
          }}
        />
        <View
          testID={`agent-key-cap-${state}`}
          style={{
            position: 'absolute',
            top: pose.down,
            width: size,
            height: size,
            borderRadius: g.corner,
            backgroundColor: paint.skirt,
            overflow: 'hidden',
          }}
        >
          {/* Lit from above: lighter at the top, a touch darker at its foot. */}
          <Wash width={size} height={size} corner={g.corner} top={0.12} bottom={0.1} at={0.4} />
          <View
            testID="agent-key-face"
            style={{
              position: 'absolute',
              top: g.insetTop,
              left: g.insetX,
              right: g.insetX,
              bottom: g.insetBottom,
              borderRadius: g.faceCorner,
              backgroundColor: paint.face,
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Wash
              width={size - 2 * g.insetX}
              height={size - g.insetTop - g.insetBottom}
              corner={g.faceCorner}
              top={0.1}
              bottom={0.03}
              at={0.55}
            />
            <View style={[styles.shine, { backgroundColor: keyLit.shine }]} />
            {state === 'working' && (
              <Breathing kind="breathe" fill>
                <FaceGlow g={g} color={keyLit.breath} opacity={0.33} />
              </Breathing>
            )}
            {state === 'needsOk' && <FaceGlow g={g} color={keyLit.askFace} opacity={0.38} />}
            {state === 'needsOk' ? <Breathing kind="pulse">{legend}</Breathing> : legend}
            {g.details && look.boundKey && (
              <Text
                testID="agent-key-sub"
                allowFontScaling={false}
                style={{
                  position: 'absolute',
                  right: g.sub.right,
                  bottom: g.sub.bottom,
                  fontFamily: fonts.mono,
                  fontSize: g.sub.size,
                  lineHeight: g.sub.size,
                  color: paint.legend,
                  opacity: paint.legendLit ? 0.8 : 0.6,
                }}
              >
                {look.boundKey}
              </Text>
            )}
          </View>
          {pips > 0 && (
            <View style={[styles.pips, { bottom: g.pips.bottom, gap: g.pips.gap }]}>
              {Array.from({ length: KEY_PIP_COUNT }, (_, i) => (
                <View
                  key={i}
                  testID={i < pips ? 'agent-key-pip-on' : 'agent-key-pip'}
                  style={{
                    width: g.pips.width,
                    height: g.pips.height,
                    borderRadius: g.pips.height / 2,
                    backgroundColor:
                      i < pips
                        ? mix(keyLit.white, paint.face, 0.6)
                        : mix(keyLit.black, paint.skirt, 0.22),
                  }}
                />
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

/** The spill's colour: the key's own face warmed (working, live), or amber (needs your OK). */
function spillColor(light: KeyLight, paint: KeyColors): string {
  return light === 'ask' ? keyLit.askSpill : mix(paint.face, keyLit.spillWarm, 0.75);
}

/** A vertical light-to-shade wash over a cap or face: white at the top, clear at `at`, black at the foot. */
function Wash({
  width,
  height,
  corner,
  top,
  bottom,
  at,
}: {
  width: number;
  height: number;
  corner: number;
  top: number;
  bottom: number;
  at: number;
}) {
  const gid = `w${useId().replace(/:/g, '')}`;
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={keyLit.white} stopOpacity={top} />
          <Stop offset={at} stopColor={keyLit.white} stopOpacity={0} />
          <Stop offset={at} stopColor={keyLit.black} stopOpacity={0} />
          <Stop offset="1" stopColor={keyLit.black} stopOpacity={bottom} />
        </LinearGradient>
      </Defs>
      <Rect width={width} height={height} rx={corner} fill={`url(#${gid})`} />
    </Svg>
  );
}

/** Light spilling onto what the key sits on: a soft radial wider than the key, behind it. */
function Spill({ g, color, opacity }: { g: KeyGeometry; color: string; opacity: number }) {
  const gid = `s${useId().replace(/:/g, '')}`;
  const w = g.size * 1.7;
  const h = g.size * 1.85;
  return (
    <Svg
      testID="agent-key-spill"
      width={w}
      height={h}
      pointerEvents="none"
      style={{ position: 'absolute', left: -g.size * 0.35, top: -g.size * 0.35 }}
    >
      <Defs>
        <RadialGradient id={gid} cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="0.55" stopColor={color} stopOpacity={opacity * 0.55} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={w} height={h} fill={`url(#${gid})`} />
    </Svg>
  );
}

/** Light inside the face: the breath of a working key, the amber of one that needs you. */
function FaceGlow({ g, color, opacity }: { g: KeyGeometry; color: string; opacity: number }) {
  const gid = `f${useId().replace(/:/g, '')}`;
  const w = g.size - 2 * g.insetX;
  const h = g.size - g.insetTop - g.insetBottom;
  return (
    <Svg width={w} height={h} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id={gid} cx="50%" cy="48%" rx="60%" ry="60%">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={w} height={h} fill={`url(#${gid})`} />
    </Svg>
  );
}

/** The legend: one icon, centred; lit, it shines with a glow round the icon only. */
function Legend({
  icon,
  g,
  ink,
  light,
  dim,
}: {
  icon: string;
  g: KeyGeometry;
  ink: string;
  light: KeyLight;
  dim: boolean;
}) {
  const drawing = iconDrawing(icon);
  const strokes = (stroke: string, width: number, opacity = 1) => (
    <>
      {drawing.paths.map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={width}
          strokeOpacity={opacity}
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      ))}
      {drawing.circles?.map(([cx, cy, r]) => (
        <Circle
          key={`${cx},${cy}`}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={width}
          strokeOpacity={opacity}
        />
      ))}
    </>
  );
  const lit = light !== 'none';
  const glow = light === 'ask' ? keyLit.askGlow : keyLit.glow;
  // Two soft rings of glow under the stroke: wide and faint, then tight.
  const wide = light === 'ask' ? 3.4 : 2.6;
  return (
    <Svg
      width={g.icon}
      height={g.icon}
      viewBox={`0 0 ${KEY_ICON_GRID} ${KEY_ICON_GRID}`}
      testID={
        lit
          ? light === 'ask'
            ? 'agent-key-legend-ask'
            : 'agent-key-legend-lit'
          : 'agent-key-legend'
      }
      style={[styles.legend, dim && { opacity: KEY_GEOMETRY.paused.legendOpacity }]}
    >
      {lit && strokes(glow, g.stroke * wide, light === 'ask' ? 0.32 : 0.22)}
      {lit && strokes(glow, g.stroke * 1.7, light === 'ask' ? 0.55 : 0.4)}
      {strokes(ink, g.stroke)}
    </Svg>
  );
}

/**
 * The one loop a key may run, opacity only, on the UI thread: a working
 * key's slow breath, or the pulse of one that needs your OK. Still (and at
 * full strength) with Reduce Motion, in the background, off screen.
 */
function Breathing({
  kind,
  fill,
  children,
}: {
  kind: 'breathe' | 'pulse';
  fill?: boolean;
  children: ReactNode;
}) {
  const moving = useMoving(false);
  const glow = useSharedValue(1);
  useEffect(() => {
    if (!moving) {
      cancelAnimation(glow);
      glow.set(1);
      return;
    }
    const low = kind === 'pulse' ? KEY_PULSE_LOW : KEY_BREATHE_LOW;
    const period = kind === 'pulse' ? KEY_PULSE_MS : KEY_BREATHE_MS;
    glow.set(
      withRepeat(
        withTiming(low, { duration: period / 2, easing: Easing.inOut(Easing.quad) }),
        -1,
        true
      )
    );
    return () => cancelAnimation(glow);
  }, [glow, moving, kind]);
  const style = useAnimatedStyle(() => ({ opacity: glow.value }));
  return (
    <Animated.View
      testID={kind === 'pulse' ? 'agent-key-pulse' : 'agent-key-breath'}
      pointerEvents="none"
      style={[fill ? StyleSheet.absoluteFill : styles.overflow, style]}
    >
      {children}
    </Animated.View>
  );
}

/** An empty socket, waiting for a key: recessed, a neutral switch stem, fading in once. */
function Socket({ g, box }: { g: KeyGeometry; box: { width: number; height: number } }) {
  const appearance = useAppearance();
  const n = keyNeutrals[appearance];
  const moving = useMoving(false);
  const gid = `k${useId().replace(/:/g, '')}`;
  const w = g.size - 2 * g.socketInset;
  const h = g.size - g.socketInset + g.rest / 2;
  return (
    <Animated.View
      style={box}
      entering={moving ? FadeIn.duration(500) : undefined}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      testID="agent-key"
    >
      <View
        testID="agent-key-socket-new"
        style={{
          position: 'absolute',
          top: g.socketInset,
          left: g.socketInset,
          width: w,
          height: h,
          borderRadius: g.socketCorner,
          overflow: 'hidden',
          borderBottomWidth: 1,
          borderBottomColor: n.socketRim,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Svg width={w} height={h} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={n.socketTop} />
              <Stop offset="1" stopColor={n.socketBottom} />
            </LinearGradient>
          </Defs>
          <Rect width={w} height={h} rx={g.socketCorner} fill={`url(#${gid})`} />
        </Svg>
        {/* The shadow its walls cast, along the top. */}
        <View
          style={[
            styles.socketShade,
            { height: Math.max(2, g.rest / 2), backgroundColor: n.socketShade },
          ]}
        />
        <Stem g={g} fill={n.stem} shadow={n.stemDepth} />
      </View>
    </Animated.View>
  );
}

/** The switch stem in an empty socket: a cross with a hard drop under it. */
function Stem({ g, fill, shadow }: { g: KeyGeometry; fill: string; shadow: string }) {
  const bar = (color: string, dy: number) => (
    <>
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: (g.stem - g.arm) / 2 + dy,
          height: g.arm,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: dy,
          bottom: -dy,
          left: (g.stem - g.arm) / 2,
          width: g.arm,
          backgroundColor: color,
        }}
      />
    </>
  );
  return (
    <View testID="agent-key-stem" style={{ width: g.stem, height: g.stem }}>
      {bar(shadow, g.stemDrop)}
      {bar(fill, 0)}
    </View>
  );
}

const styles = StyleSheet.create({
  shine: { position: 'absolute', top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth },
  legend: { overflow: 'visible' },
  overflow: { overflow: 'visible' },
  pips: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center' },
  socketShade: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0.6 },
});
