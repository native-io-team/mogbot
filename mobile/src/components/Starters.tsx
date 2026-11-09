/**
 * A new agent's first open, as on the desk (`AgentStarters.tsx`): under its
 * welcome, the three tasks the Mac chose from what it can already reach
 * (`agents/starters.rs`). One tap sends the words as your message; the Mac
 * drops them once you've said anything.
 */

import { StyleSheet, View } from 'react-native';
import type { AgentStarter } from '@shipstudio/companion-protocol';
import { Button } from './ui';
import { space } from '../lib/theme';

export function Starters({
  starters,
  onSend,
}: {
  starters: readonly AgentStarter[];
  onSend: (text: string) => void;
}) {
  return (
    <View style={styles.row} testID="first-open-starters">
      {starters.map((s) => (
        <Button
          key={s.text}
          title={s.text}
          variant="outline"
          size="compact"
          lines={2}
          onPress={() => onSend(s.text)}
          testID={s.connect ? 'starter-connect' : 'starter'}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
});
