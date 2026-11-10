/**
 * The review step of "Describe the agent you want" on the phone: what the
 * Mac drafted, laid out to check at a glance. Its briefing in a field you
 * can edit, each routine with a switch (on by default; one the Mac couldn't
 * read is shown with why, and can't be turned on), and the apps it will ask
 * for. Nothing here is made until Create.
 */

import {
  draftAppsLine,
  ROUTINES_MEANS,
  whenLabel,
  routineSteps,
  type AgentDraft,
  type DraftRoutine,
} from '@shipstudio/companion-protocol';
import { StyleSheet, Switch, TextInput, View } from 'react-native';
import { useAccent, useSwitchColors } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { fonts, lineHeight, radius, space, type } from '../lib/theme';
import { T } from './ui';

export function DraftReview({
  draft,
  instructions,
  onInstructions,
  kept,
  onKept,
}: {
  draft: AgentDraft;
  instructions: string;
  onInstructions: (text: string) => void;
  kept: boolean[];
  onKept: (index: number, on: boolean) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const accent = useAccent();
  const appearance = useAppearance();
  const apps = draftAppsLine(draft.apps);
  return (
    <View style={styles.root}>
      <View style={styles.field}>
        <T variant="subhead" color={colors.textPrimary} nativeID="briefing-label">
          What it knows
        </T>
        <TextInput
          multiline
          value={instructions}
          onChangeText={onInstructions}
          style={styles.briefing}
          selectionColor={accent.accent}
          keyboardAppearance={appearance}
          scrollEnabled={false}
          accessibilityLabelledBy="briefing-label"
          accessibilityLabel="What it knows"
        />
      </View>
      {draft.routines.length > 0 && (
        <View style={styles.field}>
          <T variant="subhead" color={colors.textPrimary}>
            Routines
          </T>
          <T variant="small" color={colors.textMuted}>
            {ROUTINES_MEANS}
          </T>
          <View style={styles.group}>
            {draft.routines.map((r, i) => (
              <RoutineRow
                key={`${i}-${r.when}`}
                routine={r}
                on={!r.problem && kept[i] !== false}
                last={i === draft.routines.length - 1}
                onChange={(on) => onKept(i, on)}
              />
            ))}
          </View>
          <T variant="caption" color={colors.textMuted}>
            Routines run while the app is open on your Mac. A step after your OK waits for you on
            a card, here or on the Mac.
          </T>
        </View>
      )}
      {apps && (
        <T variant="caption" color={colors.textSecondary}>
          {apps}
        </T>
      )}
    </View>
  );
}

function RoutineRow({
  routine,
  on,
  last,
  onChange,
}: {
  routine: DraftRoutine;
  on: boolean;
  last: boolean;
  onChange: (on: boolean) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const switchColors = useSwitchColors(on);
  const steps = routineSteps(routine);
  const when = whenLabel(routine.readsAs ?? routine.when);
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <View style={styles.rowText}>
        <T variant="small" color={colors.textStrong}>
          {when}
        </T>
        {steps.length === 1 ? (
          <T variant="caption" color={colors.textSecondary}>
            {routine.note}
          </T>
        ) : (
          steps.map((s) => (
            <View key={s.n} style={styles.step}>
              <T variant="caption" color={colors.textMuted} style={styles.stepNumber}>
                {s.n}
              </T>
              <T variant="caption" color={colors.textSecondary} style={styles.stepText}>
                {s.askFirst ? `After your OK: ${s.text}` : s.text}
              </T>
            </View>
          ))
        )}
        {routine.problem && (
          <T variant="caption" color={colors.accentWarning}>
            {routine.problem}
          </T>
        )}
      </View>
      <Switch
        value={on}
        disabled={!!routine.problem}
        onValueChange={onChange}
        {...switchColors}
        accessibilityLabel={`${when}: ${routine.note}`}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { gap: space.lg },
  field: { gap: space.sm },
  briefing: {
    fontFamily: fonts.regular,
    fontSize: type.small,
    lineHeight: lineHeight(type.small, 1.45),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  group: {
    backgroundColor: colors.surfaceGroup,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    paddingHorizontal: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  rowText: { flex: 1, gap: space.xs },
  step: { flexDirection: 'row', gap: space.sm },
  stepNumber: { minWidth: space.md, fontFamily: fonts.mono },
  stepText: { flex: 1 },
}));
