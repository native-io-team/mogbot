/**
 * One screen of a step-by-step flow (pairing): Back and a progress bar at
 * the top, one question, one line, and the big button at the bottom under
 * the thumb, with at most one quiet way out beneath it. Nothing else
 * competes for the eye: whoever is here should only have to read one thing
 * and make one decision.
 *
 * `DoneLine` is the tick a step shows when this phone has checked it
 * itself, never on someone's word.
 */

import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, IconButton, T } from './ui';
import { iconSize, radius, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

interface Props {
  /** 1-based; `of` past `n` fills the bar (the end). */
  n: number;
  of: number;
  onBack?: () => void;
  /** Above the title: the app's mark on the first screen. */
  mark?: ReactNode;
  /** Above the title, for something said before the question ("Pair again"). */
  notice?: ReactNode;
  title: ReactNode;
  /** Beside the title while something is under way. */
  busy?: ReactNode;
  line?: ReactNode;
  children?: ReactNode;
  /** The big button. */
  primary?: ReactNode;
  /** One quiet way out. */
  secondary?: ReactNode;
  /** Under everything, quieter still (Try the demo). */
  footer?: ReactNode;
  testID?: string;
  /** Changes the screen's entry animation key: each step slides in fresh. */
  stepKey: string;
  /** The end of a flow: everything in the middle of the screen, a moment rather than a form. */
  centered?: boolean;
}

export function StepScreen({
  n,
  of,
  onBack,
  mark,
  notice,
  title,
  busy,
  line,
  children,
  primary,
  secondary,
  footer,
  testID,
  stepKey,
  centered = false,
}: Props) {
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const filled = Math.min(1, Math.max(0, n / of));
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surfaceApp }}
      contentContainerStyle={[
        styles.page,
        { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl },
      ]}
      bounces={false}
      testID={testID}
    >
      <View style={styles.top}>
        <View style={styles.back}>
          {onBack && (
            <IconButton name="chevron.left" label="Back" fallback="‹" onPress={onBack} />
          )}
        </View>
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={n > of ? 'Done' : `Step ${n} of ${of}`}
          accessibilityValue={{ min: 0, max: of, now: Math.min(n, of) }}
          testID="step-progress"
        >
          <View style={[styles.fill, { width: `${filled * 100}%` }]} />
        </View>
        <View style={styles.back} />
      </View>
      <Animated.View
        key={stepKey}
        entering={FadeInDown.duration(280)}
        style={[styles.body, centered && styles.centered]}
      >
        {mark}
        {notice}
        <View style={[styles.titleRow, centered && styles.centeredRow]}>
          {busy}
          <T
            variant="display"
            color={colors.textStrong}
            accessibilityRole="header"
            style={[styles.title, centered && styles.centeredText]}
          >
            {title}
          </T>
        </View>
        {line ? (
          <T color={colors.textSecondary} style={centered && styles.centeredText}>
            {line}
          </T>
        ) : null}
        {children}
      </Animated.View>
      {(primary || secondary || footer) && (
        <View style={styles.actions}>
          {primary}
          {secondary}
          {footer}
        </View>
      )}
    </ScrollView>
  );
}

/** "Done. <line>" with a tick: only for what this phone saw for itself. */
export function DoneLine({ children }: { children: ReactNode }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.done} testID="step-done">
      <Icon name="checkmark" size={iconSize.body} color={colors.accentSuccess} fallback={<T>✓</T>} />
      <T color={colors.textPrimary} style={styles.doneText}>
        <T color={colors.textStrong} style={styles.doneWord}>
          Done.
        </T>{' '}
        {children}
      </T>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { paddingHorizontal: space.xl, gap: space['2xl'], flexGrow: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  back: { width: iconSize.hero, alignItems: 'flex-start' },
  track: {
    flex: 1,
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  fill: { height: space.xs, borderRadius: radius.pill, backgroundColor: colors.textStrong },
  body: { gap: space.md, flexGrow: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  centeredRow: { justifyContent: 'center' },
  centeredText: { textAlign: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title: { flexShrink: 1 },
  actions: { gap: space.sm },
  done: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.control,
    backgroundColor: colors.surfacePanel,
  },
  doneText: { flex: 1 },
  doneWord: { fontWeight: '600' },
}));
