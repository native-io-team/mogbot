/**
 * Usage before the wall, on the phone: "Claude usage 85% · resets Sat" under
 * the agents' title, amber from 90% and at the limit. The desk's line, from
 * the same `agents.quota` reading and the same wording (`useQuotaLines`).
 *
 * Nothing reported, nothing shown: never an estimate.
 */

import type { QuotaLine } from '@shipstudio/companion-protocol';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { T } from './ui';
import { useColors } from '../lib/appearance';
import { space } from '../lib/theme';

export function QuotaLines({ lines, style }: { lines: QuotaLine[]; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  if (lines.length === 0) return null;
  return (
    <View style={[{ gap: space['2xs'] }, style]} accessibilityRole="summary">
      {lines.map((line) => (
        <T
          key={line.engine}
          variant="small"
          color={line.tone === 'calm' ? colors.textMuted : colors.accentWarning}
          accessibilityLabel={`${line.text}. ${line.detail}`}
          numberOfLines={1}
        >
          {line.text}
        </T>
      ))}
    </View>
  );
}
