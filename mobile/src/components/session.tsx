/**
 * A project session's state as one short line, the way Remote Access reads
 * it off the screen: working (with the spinner's own words), waiting on a
 * decision, finished, or ended.
 */

import type { SessionSummary } from '@shipstudio/companion-protocol';
import { StyleSheet, View } from 'react-native';
import { taskName } from '../lib/agents';
import { plainActivity } from '../lib/taskScreen';
import { useApp } from '../lib/store';
import { iconSize, space } from '../lib/theme';
import { useColors } from '../lib/appearance';
import { Spinner } from './agent';
import { Dot, T } from './ui';

/** A task by what it was asked, from the chats that started it (one rule: `taskName`). */
export const useTaskName = (sessionId: string | undefined) =>
  useApp((s) => taskName(sessionId, s.chats));

export function sessionStateText(s: SessionSummary): string {
  switch (s.state) {
    case 'working': {
      // The spinner's words without its timer ("Checking the hero at 390px").
      const doing = s.activity ? plainActivity(s.activity) : '';
      return doing && doing.toLowerCase() !== 'working' ? `Working · ${doing}` : 'Working';
    }
    case 'needs_decision':
      return s.question?.question ?? 'Needs your OK';
    case 'finished':
      return 'Finished · ready for a message';
    case 'exited':
      return 'Ended';
  }
}

export function SessionState({ session }: { session: SessionSummary }) {
  const colors = useColors();
  const tone =
    session.state === 'needs_decision'
      ? colors.accentWarning
      : session.state === 'working'
        ? colors.textSecondary
        : colors.textMuted;
  return (
    <View style={styles.row}>
      <View style={styles.mark}>
        {session.state === 'working' ? (
          <Spinner size={iconSize.inline} />
        ) : session.state === 'needs_decision' ? (
          <Dot color={colors.accentWarning} glow />
        ) : (
          <Dot color={session.state === 'finished' ? colors.accentSuccess : colors.textMuted} />
        )}
      </View>
      <T variant="small" color={tone} numberOfLines={1} style={{ flex: 1 }}>
        {sessionStateText(session)}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: { width: 12, alignItems: 'center' },
});
