/**
 * Keep / Discard under the newest change card of an agent's open copy of
 * its project (`agents/task.rs` on the Mac). Shown only when the Mac serves
 * `agents.keepCopy` (`welcome.methods`); older Macs leave the card a line.
 *
 * The words stay plain: "a copy of acme-site", "Keep changes", "Discard".
 * Preview and pull requests need the Mac's workspace, so they stay there.
 */

import type { Agent, CopyRef, KeptCopy } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { describeError, discardCopy, keepCopy } from '../lib/session';
import { useApp } from '../lib/store';
import { space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Button, T } from './ui';

/** What Keep's answer says, in the chat's words. Exported for tests. */
export function keptLine(project: string, agentName: string, kept: KeptCopy): string {
  switch (kept.outcome) {
    case 'kept':
      return `Kept the changes in ${project}`;
    case 'nothing':
      return `${project} already has these changes`;
    case 'conflict':
      return `Some of these changes overlap with edits made in ${project} since (${kept.files
        .slice(0, 3)
        .join(', ')}). Choose which to keep on the Mac, or ask ${agentName} to sort it out.`;
  }
}

export function CopyActions({
  agent,
  copy,
  project,
  onError,
}: {
  agent: Agent;
  copy: CopyRef;
  project: string;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const served = useApp((s) => !!s.welcome?.methods.includes('agents.keepCopy'));
  const connected = useApp((s) => s.link.kind === 'connected');
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (!served) return null;
  const working = agent.status.state !== 'idle';

  const keep = () => {
    haptic.light();
    setBusy('keep');
    keepCopy(agent.id, copy.id)
      .then((kept) => setSaid(keptLine(project, agent.name, kept)))
      .catch((e: unknown) => onError(describeError(e)))
      .finally(() => setBusy(null));
  };

  const discard = () =>
    Alert.alert(
      'Discard these changes?',
      `The copy and everything in it go; ${project} stays as it is.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            setBusy('discard');
            discardCopy(agent.id, copy.id)
              .catch((e: unknown) => onError(describeError(e)))
              .finally(() => setBusy(null));
          },
        },
      ]
    );

  return (
    <View style={styles.wrap}>
      <T variant="small" color={colors.textMuted}>
        {said ??
          (working
            ? `${agent.name} is working on a copy of ${project}`
            : `Changes are ready · on a copy of ${project}`)}
      </T>
      <View style={styles.actions}>
        <Button
          title="Keep changes"
          variant="primary"
          size="compact"
          busy={busy === 'keep'}
          disabled={!connected || working || busy !== null}
          onPress={keep}
        />
        <Button
          title="Discard"
          variant="ghost"
          size="compact"
          busy={busy === 'discard'}
          disabled={!connected || working || busy !== null}
          onPress={discard}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles(() => ({
  wrap: { gap: space.xs },
  actions: { flexDirection: 'row', gap: space.sm },
}));
