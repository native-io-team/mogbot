/**
 * The body of a "Do these under your name?" card (`ask_plan`): every action
 * the agent will take as you, numbered, with where it happens, and why. The
 * card around it is the ordinary request card: one Allow covers each listed
 * action (for an hour, and for any agent it hands the work to).
 */

import type { PlanCard } from '@shipstudio/companion-protocol';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { space } from '../lib/theme';
import { T } from './ui';

export function PlanList({ plan }: { plan: PlanCard }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.plan} testID="plan-list">
      {plan.actions.map((a, i) => (
        // The number hangs in its own column, as in a reply's list: where it
        // happens and what it says sit under the action, not under "1.".
        <View key={`${i}-${a.summary}`} style={styles.action}>
          <T color={colors.textMuted} style={styles.number}>{`${i + 1}.`}</T>
          <View style={styles.body}>
            <T color={colors.textBody}>{a.summary}</T>
            <T variant="small" color={colors.textMuted}>
              {a.target}
            </T>
            {!!a.text && (
              <T variant="small" color={colors.textBody}>
                {`“${a.text}”`}
              </T>
            )}
          </View>
        </View>
      ))}
      {!!plan.why && (
        <T variant="small" color={colors.textMuted}>
          {`Why: ${plan.why}`}
        </T>
      )}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  plan: { gap: space.md },
  action: { flexDirection: 'row', gap: space.sm },
  // Wide enough for "10." so a long plan's numbers line up with its first.
  number: { minWidth: space.lg + space['2xs'], fontVariant: ['tabular-nums'] as const },
  body: { flex: 1, gap: space['2xs'] },
}));
