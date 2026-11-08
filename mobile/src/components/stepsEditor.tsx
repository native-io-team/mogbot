/**
 * "Then…": the steps after a routine's first, on the phone's routine sheet
 * (`agents/routine_steps.rs`). Each is a line of what to do and one switch,
 * "Your OK first", which makes the routine stop there and ask on a card,
 * showing what the step before produced. A new step asks first by default:
 * the usual reason for a second step is sending what the first one drafted.
 */

import { MAX_THEN, type RoutineStep } from '@shipstudio/companion-protocol';
import { StyleSheet, Switch, TextInput, View } from 'react-native';
import { useAccent, useSwitchColors } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { fonts, lineHeight, radius, space, type } from '../lib/theme';
import { TextAction } from './surfaces';
import { IconButton, T } from './ui';

export function StepsEditor({
  steps,
  onChange,
}: {
  steps: RoutineStep[];
  onChange: (steps: RoutineStep[]) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const set = (i: number, patch: Partial<RoutineStep>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <View style={styles.root}>
      {steps.map((s, i) => (
        <StepRow
          key={i}
          n={i + 2}
          step={s}
          onText={(text) => set(i, { text })}
          onAsk={(askFirst) => set(i, { askFirst })}
          onRemove={() => onChange(steps.filter((_, j) => j !== i))}
        />
      ))}
      {steps.length < MAX_THEN && (
        <View style={styles.add}>
          <TextAction
            label={steps.length === 0 ? 'Then…' : 'Add a step'}
            hint="Another step after this one, run when the one before finishes"
            onPress={() => onChange([...steps, { text: '', askFirst: true }])}
          />
          {steps.length === 0 && (
            <T variant="caption" color={colors.textMuted} style={styles.addHint}>
              Draft first, then post once you OK it.
            </T>
          )}
        </View>
      )}
    </View>
  );
}

function StepRow({
  n,
  step,
  onText,
  onAsk,
  onRemove,
}: {
  n: number;
  step: RoutineStep;
  onText: (text: string) => void;
  onAsk: (on: boolean) => void;
  onRemove: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const accent = useAccent();
  const appearance = useAppearance();
  const on = Boolean(step.askFirst);
  const switchColors = useSwitchColors(on);
  return (
    <View style={styles.step}>
      <View style={styles.head}>
        <T variant="caption" color={colors.textMuted} style={styles.number}>
          {n}
        </T>
        <TextInput
          value={step.text}
          onChangeText={(t) => onText(t.replace(/\n/g, ' '))}
          placeholder="Post it to #team on Slack"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          selectionColor={accent.accent}
          keyboardAppearance={appearance}
          multiline
          submitBehavior="blurAndSubmit"
          accessibilityLabel={`Step ${n}`}
        />
        <IconButton name="xmark" label={`Remove step ${n}`} onPress={onRemove} />
      </View>
      <View style={styles.ask}>
        <T variant="small" color={colors.textSecondary} style={styles.askLabel}>
          Your OK first
        </T>
        <Switch
          value={on}
          onValueChange={onAsk}
          {...switchColors}
          accessibilityLabel={`Step ${n}: wait for your OK first`}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { gap: space.sm },
  step: {
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceGroup,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  number: { minWidth: space.lg, textAlign: 'center', fontFamily: fonts.mono },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    minHeight: 44,
  },
  ask: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.lg + space.sm,
  },
  askLabel: { flex: 1 },
  add: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  addHint: { flex: 1 },
}));
