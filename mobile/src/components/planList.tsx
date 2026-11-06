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
        <View key={`${i}-${a.summary}`} style={styles.action}>
          <T color={colors.textBody}>{`${i + 1}. ${a.summary}`}</T>
          <T variant="small" color={colors.textMuted}>
            {a.target}
          </T>
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
  plan: { gap: space.sm },
  action: { gap: space.xs },
}));
