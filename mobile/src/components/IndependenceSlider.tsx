/**
 * How much agents do on their own, as the desk draws it: a four-stop slider
 * from "Asks a lot" (Careful) to "Just does it" (Unleashed), the chosen
 * stop's one line under it. Worded by the protocol's `independence.ts`.
 *
 * VoiceOver reads it as one adjustable control: swipe up or down to move a
 * stop, the value being the stop's name and its line. A drag previews the
 * stop under the finger and commits once, on release; a tap on a stop or
 * its name commits at once. Neutral throughout, never the accent.
 */

import {
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_ENDS,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_TITLE,
  independenceStep,
  independenceValueText,
  type AgentIndependence,
} from '@shipstudio/companion-protocol';
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { PRESSED, chromeScale, fonts, levelSlider, space } from '../lib/theme';
import { T } from './ui';

const LAST = INDEPENDENCE_LEVELS.length - 1;

export function IndependenceSlider({
  value,
  onChange,
  disabled = false,
}: {
  value: AgentIndependence;
  onChange: (level: AgentIndependence) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  // The stop under a drag, until it is let go.
  const [dragging, setDragging] = useState<AgentIndependence | null>(null);
  const shown = dragging ?? value;
  const index = INDEPENDENCE_LEVELS.indexOf(shown);

  const live = useRef({ value, disabled, onChange, width });
  live.current = { value, disabled, onChange, width };

  const commit = (level: AgentIndependence) => {
    const { value: now, disabled: off, onChange: change } = live.current;
    if (!off && level !== now) change(level);
  };

  /** The stop nearest `x` along the rail (inset by half a thumb each side). */
  const stopAt = (x: number): AgentIndependence => {
    const rail = live.current.width - levelSlider.thumb;
    if (rail <= 0) return live.current.value;
    const f = Math.min(1, Math.max(0, (x - levelSlider.thumb / 2) / rail));
    return INDEPENDENCE_LEVELS[Math.round(f * LAST)];
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !live.current.disabled,
        // Sideways is the slider's; up and down stay the screen's scroll.
        onMoveShouldSetPanResponder: (_, g) =>
          !live.current.disabled && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => setDragging(stopAt(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setDragging(stopAt(e.nativeEvent.locationX)),
        onPanResponderRelease: (e) => {
          const level = stopAt(e.nativeEvent.locationX);
          setDragging(null);
          commit(level);
        },
        onPanResponderTerminate: () => setDragging(null),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const rail = Math.max(0, width - levelSlider.thumb);
  const x = (i: number) => levelSlider.thumb / 2 + (rail * i) / LAST;
  // Each stop's name in a box a third of the rail wide, centred on its dot;
  // the ends hug the edges.
  const box = rail / LAST;

  return (
    <View style={[styles.wrap, disabled && styles.off]}>
      <View style={styles.ends} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
          {INDEPENDENCE_ENDS.low}
        </T>
        <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
          {INDEPENDENCE_ENDS.high}
        </T>
      </View>
      <View
        {...pan.panHandlers}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={styles.row}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={INDEPENDENCE_TITLE}
        accessibilityValue={{ min: 0, max: LAST, now: index, text: independenceValueText(shown) }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const step = e.nativeEvent.actionName === 'increment' ? 1 : -1;
          commit(independenceStep(live.current.value, step));
        }}
        testID="independence-slider"
      >
        {width > 0 && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={[styles.track, { left: x(0), width: rail }]} />
            <View style={[styles.fill, { left: x(0), width: x(index) - x(0) }]} />
            {INDEPENDENCE_LEVELS.map((level, i) => (
              <View
                key={level}
                style={[
                  styles.tick,
                  { left: x(i) - levelSlider.tick / 2 },
                  i <= index && styles.tickReached,
                ]}
              />
            ))}
            <View style={[styles.thumb, { left: x(index) - levelSlider.thumb / 2 }]} />
          </View>
        )}
      </View>
      <View
        style={styles.stops}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {width > 0 &&
          INDEPENDENCE_LEVELS.map((level, i) => {
            const first = i === 0;
            const end = i === LAST;
            const left = first ? 0 : end ? width - box : x(i) - box / 2;
            const on = level === shown;
            return (
              <Pressable
                key={level}
                disabled={disabled}
                onPress={() => commit(level)}
                // The slider above is the one element; its stops are touch only.
                accessible={false}
                hitSlop={space.sm}
                style={[styles.stop, { left, width: box }]}
                testID={`independence-stop-${level}`}
              >
                <T
                  variant="caption"
                  color={on ? colors.textStrong : colors.textMuted}
                  style={[
                    { textAlign: first ? 'left' : end ? 'right' : 'center' },
                    on && styles.stopOn,
                  ]}
                  maxFontSizeMultiplier={chromeScale}
                  numberOfLines={1}
                >
                  {INDEPENDENCE_LABEL[level]}
                </T>
              </Pressable>
            );
          })}
      </View>
      <T variant="body" color={colors.textPrimary} style={styles.detail}>
        {INDEPENDENCE_DETAIL[shown]}
      </T>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  off: PRESSED,
  ends: { flexDirection: 'row', justifyContent: 'space-between' },
  row: { height: levelSlider.row, justifyContent: 'center' },
  track: {
    position: 'absolute',
    top: (levelSlider.row - levelSlider.track) / 2,
    height: levelSlider.track,
    borderRadius: levelSlider.track / 2,
    backgroundColor: colors.borderDefault,
  },
  fill: {
    position: 'absolute',
    top: (levelSlider.row - levelSlider.track) / 2,
    height: levelSlider.track,
    borderRadius: levelSlider.track / 2,
    backgroundColor: colors.textSecondary,
  },
  tick: {
    position: 'absolute',
    top: (levelSlider.row - levelSlider.tick) / 2,
    width: levelSlider.tick,
    height: levelSlider.tick,
    borderRadius: levelSlider.tick / 2,
    backgroundColor: colors.borderStrong,
  },
  tickReached: { backgroundColor: colors.textSecondary },
  thumb: {
    position: 'absolute',
    top: (levelSlider.row - levelSlider.thumb) / 2,
    width: levelSlider.thumb,
    height: levelSlider.thumb,
    borderRadius: levelSlider.thumb / 2,
    backgroundColor: colors.selectedFill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.surfaceGroup,
  },
  stops: { height: space.xl, position: 'relative' },
  stop: { position: 'absolute', top: 0 },
  stopOn: { fontFamily: fonts.medium },
  detail: { marginTop: space.xs },
}));
