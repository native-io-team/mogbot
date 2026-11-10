/**
 * The Chief's first open, as on the desk (`ChiefStarters` in
 * `AgentChat.tsx`): under its stored greeting, the same four ideas
 * (`CHIEF_CHIPS`, shared in the protocol package). A tap types the idea's
 * whole brief into the composer for you to finish; nothing is sent until you
 * press Send. They go once you've said anything.
 */

import {
  CHIEF_CHIPS,
  ideaRepeats,
  ROUTINES_NEED_THE_MAC,
  type ChiefIdea,
} from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useColors } from '../lib/appearance';
import { space } from '../lib/theme';
import { Button, T } from './ui';

export function ChiefStarters({ onPick }: { onPick: (idea: ChiefIdea) => void }) {
  const colors = useColors();
  // One that sets up a routine says, once picked, where routines run.
  const [picked, setPicked] = useState<ChiefIdea | null>(null);
  return (
    <View style={styles.row} testID="chief-starters">
      {CHIEF_CHIPS.map((idea) => (
        <Button
          key={idea.id}
          title={idea.label}
          variant="outline"
          size="compact"
          lines={2}
          accessibilityHint="Types this into the message box for you to finish"
          onPress={() => {
            setPicked(idea);
            onPick(idea);
          }}
          testID={`chief-idea-${idea.id}`}
        />
      ))}
      {picked && ideaRepeats(picked) && (
        <T variant="caption" color={colors.textMuted} style={styles.note}>
          {ROUTINES_NEED_THE_MAC}
        </T>
      )}
    </View>
  );
}

/** The greeting is all there is: nobody has said anything yet. */
export function chiefGreetingOnly(
  agent: { isMain?: boolean; status: { state: string } },
  messages: readonly { kind: string }[]
): boolean {
  return (
    !!agent.isMain &&
    agent.status.state === 'idle' &&
    messages.length > 0 &&
    messages.every((m) => m.kind === 'agent')
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
  note: { flexBasis: '100%' },
});
