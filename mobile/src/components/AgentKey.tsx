/**
 * An agent's key (docs/internal/agent-keys.md): a keycap in its colourway
 * with one legend on its face, the keyboard key it's bound to as a small
 * sublegend and its independence as pips on the front edge (big keys only).
 * The desk's `AgentKey`, drawn with Views: the skirt, the inset face and a
 * solid hard-edged depth under them, one soft ambient shadow; the legend is
 * react-native-svg, from the icon registry shared with the desk
 * (`agentKeyIcons.ts`).
 *
 * States are physical (`keyPose`): pressed while it works, the legend lit
 * while it's live, lit and proud and slowly pulsing while it needs your OK,
 * a socket with the cap off when it's paused or new. Cheap by design: no
 * timers, and the only animation is the pulse, mounted only on a key that
 * needs your OK and still with Reduce Motion, in the background and on a
 * screen that isn't showing.
 */

import {
  KEY_ICON_GRID,
  KEY_PIP_COUNT,
  colorwayOf,
  iconDrawing,
  keyLookFor,
  pipsFor,
  type AgentIndependence,
  type KeyState,
} from '@shipstudio/companion-protocol';
import { useEffect, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useAppearance } from '../lib/appearance';
import {
  KEY_PULSE_LOW,
  KEY_PULSE_MS,
  keyGeometry,
  keyPose,
  type KeyGeometry,
} from '../lib/agentKey';
import { useMoving } from '../lib/moving';
import { useApp } from '../lib/store';
import { fonts, keyColorways, keyLit, keyNeutrals, keySize, type KeyColors } from '../lib/theme';

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
  const paint = keyColorways[way.id] ?? keyColorways.blue;
  const g = keyGeometry(size);
  const neutrals = keyNeutrals[appearance];
  const box = { width: size, height: size + g.rest };
  if (state === 'new') {
    // Not a socket: a dashed outline where a key will go, with a plus. It's
    // an action, so it never reads as a paused agent's empty socket.
    const line = Math.max(1.5, g.arm / 2.5);
    return (
      <View
        style={box}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        testID="agent-key"
      >
        <View
          testID="agent-key-new"
          style={{
            position: 'absolute',
            top: g.rest,
            width: size,
            height: size,
            borderRadius: g.corner,
            borderWidth: Math.max(1.5, size / 56),
            borderStyle: 'dashed',
            borderColor: neutrals.newRim,
            backgroundColor: neutrals.newFill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <View style={{ width: size * 0.32, height: size * 0.32 }}>
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: (size * 0.32 - line) / 2,
                height: line,
                borderRadius: 1,
                backgroundColor: neutrals.newPlus,
              }}
            />
            <View
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: (size * 0.32 - line) / 2,
                width: line,
                borderRadius: 1,
                backgroundColor: neutrals.newPlus,
              }}
            />
          </View>
        </View>
      </View>
    );
  }
  if (state === 'paused') {
    return (
      <View
        style={box}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        testID="agent-key"
      >
        <View
          testID={`agent-key-socket-${state}`}
          style={{
            position: 'absolute',
            top: g.rest,
            width: size,
            height: size,
            borderRadius: g.corner,
            backgroundColor: neutrals.socket,
            borderWidth: 1,
            borderColor: neutrals.socketRim,
            borderTopWidth: Math.max(1, g.rest / 2),
            borderTopColor: neutrals.socketShade,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <View
            style={{
              width: g.housing,
              height: g.housing,
              borderRadius: g.housingCorner,
              // The agent's own darkest shade: its socket, never an Add button.
              backgroundColor: paint.depth,
              borderTopWidth: Math.max(1, g.stemDrop),
              borderTopColor: neutrals.housingShade,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Stem g={g} fill={paint.face} shadow={paint.skirt} />
          </View>
        </View>
      </View>
    );
  }
  const pose = keyPose(g, state, way.light);
  const pips = g.details ? pipsFor(look.level) : 0;
  const legend = <Legend icon={look.icon} g={g} paint={paint} lit={pose.lit} />;
  return (
    <View
      style={box}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      testID="agent-key"
    >
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
        }}
      >
        <View
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
          <View style={[styles.shine, { backgroundColor: keyLit.shine }]} />
          {pose.shade > 0 && (
            <View
              testID="agent-key-shade"
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: keyLit.shade, opacity: pose.shade },
              ]}
            />
          )}
          {state === 'needsOk' ? <Pulse>{legend}</Pulse> : legend}
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
                color: pose.lit ? keyLit.legend : paint.legend,
                opacity: pose.lit ? 0.95 : 0.72,
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
                  backgroundColor: i < pips ? paint.legend : paint.depth,
                  opacity: i < pips ? 0.9 : 1,
                }}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** The legend: one icon, centred; lit, warm white with a tight glow round the icon only. */
function Legend({
  icon,
  g,
  paint,
  lit,
}: {
  icon: string;
  g: KeyGeometry;
  paint: KeyColors;
  lit: boolean;
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
  return (
    <Svg
      width={g.icon}
      height={g.icon}
      viewBox={`0 0 ${KEY_ICON_GRID} ${KEY_ICON_GRID}`}
      testID={lit ? 'agent-key-legend-lit' : 'agent-key-legend'}
      style={styles.legend}
    >
      {lit && strokes(keyLit.glow, g.stroke * (g.small ? 1.6 : 1.7), g.small ? 0.3 : 0.45)}
      {strokes(lit ? keyLit.legend : paint.legend, g.stroke)}
    </Svg>
  );
}

/** The slow breath of a key that needs your OK, on the UI thread; still when nothing should move. */
function Pulse({ children }: { children: ReactNode }) {
  const moving = useMoving(false);
  const glow = useSharedValue(1);
  useEffect(() => {
    if (!moving) {
      cancelAnimation(glow);
      glow.set(1);
      return;
    }
    glow.set(
      withRepeat(
        withTiming(KEY_PULSE_LOW, {
          duration: KEY_PULSE_MS / 2,
          easing: Easing.inOut(Easing.quad),
        }),
        -1,
        true
      )
    );
    return () => cancelAnimation(glow);
  }, [glow, moving]);
  const style = useAnimatedStyle(() => ({ opacity: glow.value }));
  return (
    <Animated.View testID="agent-key-pulse" style={style}>
      {children}
    </Animated.View>
  );
}

/** The switch stem left when the cap is off: a cross with a hard drop under it. */
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
  pips: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center' },
});
