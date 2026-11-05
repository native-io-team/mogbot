/**
 * The waveform in the field while it listens: your voice, as bars that scroll
 * in from the right and settle to dots when you're quiet.
 *
 * Everything moves on the UI thread. The JS thread only writes the level the
 * recognizer reports into `level` (a shared value, so nothing re-renders);
 * one frame callback eases it, pushes it into the history every
 * `WAVE_SAMPLE_MS` and slides the strip by the fraction of a bar since the
 * last push, so the scroll is continuous at the display's rate however the
 * volume events arrive. The rightmost bar is the live level, so the bars
 * answer your voice in the same frame. Heights are a scale, not a layout.
 *
 * Under Reduce Motion nothing scrolls: a thin meter fills with the level,
 * eased slowly both ways. The numbers are in `lib/waveform.ts`; the geometry
 * in `theme.waveform`.
 */

import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useColors } from '../lib/appearance';
import { waveform } from '../lib/theme';
import {
  ATTACK_MS,
  CALM_MS,
  RELEASE_MS,
  WAVE_SAMPLE_MS,
  barHeight,
  barOpacity,
  easeLevel,
  pushLevel,
} from '../lib/waveform';

const PITCH = waveform.bar + waveform.gap;
export const WAVEFORM_WIDTH = waveform.bars * PITCH;
/** One more than shows: the live bar sliding in at the right. */
const INDEXES = Array.from({ length: waveform.bars + 1 }, (_, i) => i);

export function Waveform({
  level,
  height,
  color,
}: {
  /** 0..1, written by the JS thread. */
  level: SharedValue<number>;
  height: number;
  color?: string;
}) {
  const colors = useColors();
  const still = useReducedMotion();
  const tint = color ?? colors.textPrimary;
  return (
    <View
      // The field says it's listening; the bars are decoration.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      testID="dictation-waveform"
      style={{ width: WAVEFORM_WIDTH, height, overflow: 'hidden', justifyContent: 'center' }}
    >
      {still ? (
        <Meter level={level} color={tint} track={colors.surfaceSelected} />
      ) : (
        <Bars level={level} height={height} color={tint} />
      )}
    </View>
  );
}

function Bars({
  level,
  height,
  color,
}: {
  level: SharedValue<number>;
  height: number;
  color: string;
}) {
  const live = useSharedValue(0);
  const history = useSharedValue<number[]>(new Array(waveform.bars).fill(0));
  const since = useSharedValue(0);
  const progress = useSharedValue(0);
  useFrameCallback((frame) => {
    'worklet';
    const dt = frame.timeSincePreviousFrame ?? 16;
    const now = easeLevel(live.get(), level.get(), dt, ATTACK_MS, RELEASE_MS);
    live.set(now);
    let t = since.get() + dt;
    if (t >= WAVE_SAMPLE_MS) {
      // One push however long the frame was: a stall skips, it doesn't race to catch up.
      t %= WAVE_SAMPLE_MS;
      history.set(pushLevel(history.get(), now));
    }
    since.set(t);
    progress.set(t / WAVE_SAMPLE_MS);
  });
  const top = (height - waveform.max) / 2;
  return (
    <>
      {INDEXES.map((i) => (
        <Bar
          key={i}
          index={i}
          live={live}
          history={history}
          progress={progress}
          color={color}
          top={top}
        />
      ))}
    </>
  );
}

function Bar({
  index,
  live,
  history,
  progress,
  color,
  top,
}: {
  index: number;
  live: SharedValue<number>;
  history: SharedValue<number[]>;
  progress: SharedValue<number>;
  color: string;
  top: number;
}) {
  const style = useAnimatedStyle(() => {
    const value = index === waveform.bars ? live.get() : (history.get()[index] ?? 0);
    const x = (index - progress.get()) * PITCH;
    return {
      opacity: barOpacity(x, waveform.fade),
      transform: [
        { translateX: x },
        { scaleY: barHeight(value, waveform.min, waveform.max) / waveform.max },
      ],
    };
  });
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 0,
          top,
          width: waveform.bar,
          height: waveform.max,
          borderRadius: waveform.bar / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

/** Reduce Motion: a meter that fills with the level, and nothing that travels. */
function Meter({
  level,
  color,
  track,
}: {
  level: SharedValue<number>;
  color: string;
  track: string;
}) {
  const shown = useSharedValue(0);
  useFrameCallback((frame) => {
    'worklet';
    shown.set(
      easeLevel(shown.get(), level.get(), frame.timeSincePreviousFrame ?? 16, CALM_MS, CALM_MS)
    );
  });
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: shown.get() }] }));
  return (
    <View
      style={{
        height: waveform.min,
        borderRadius: waveform.min / 2,
        backgroundColor: track,
        overflow: 'hidden',
      }}
    >
      <Animated.View
        style={[
          {
            height: waveform.min,
            width: WAVEFORM_WIDTH,
            backgroundColor: color,
            transformOrigin: 'left',
          },
          fill,
        ]}
      />
    </View>
  );
}
