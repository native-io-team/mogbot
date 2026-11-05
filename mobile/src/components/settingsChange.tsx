/**
 * The body of a "Change … settings?" card (`propose_settings_change`): who,
 * and what changes, in plain words; why; and that a rule is words, not
 * something the app stops. The card around it is the ordinary request card,
 * so Allow applies it and Deny applies nothing.
 */

import { RULES_NOTE, type SettingsProposal } from '@shipstudio/companion-protocol';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { fonts, space } from '../lib/theme';
import { T } from './ui';

export function SettingsChange({ proposal }: { proposal: SettingsProposal }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.change} testID="settings-change">
      {proposal.groups.map((g) => (
        <View key={g.who} style={styles.group}>
          <T color={colors.textPrimary} style={{ fontFamily: fonts.medium }}>
            {g.who}
          </T>
          {g.changes.map((c) => (
            <T key={c} color={colors.textBody}>
              {`• ${c}`}
            </T>
          ))}
        </View>
      ))}
      {!!proposal.why && (
        <T variant="small" color={colors.textMuted}>
          {`Why: ${proposal.why}`}
        </T>
      )}
      {proposal.hasRules && (
        <T variant="small" color={colors.textMuted}>
          {RULES_NOTE}
        </T>
      )}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  change: { gap: space.sm },
  group: { gap: space.xs },
}));
