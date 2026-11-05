/**
 * Keep / Discard under the newest change card of an agent's open copy of
 * its project (`agents/task.rs` on the Mac), in the card recipe every
 * answerable thing in the chat shares: Keep is the neutral answer (as Allow
 * is), never the agent's colour; Discard is outlined. Shown only when the Mac
 * serves `agents.keepCopy` (`welcome.methods`); older Macs leave the card a
 * line. What stopped a Keep comes from the agent's copy (`copy.stuck`), not
 * from this component, so it survives the row remounting.
 *
 * The words stay plain: "a copy of acme-site", "Keep changes", "Discard".
 * Preview and pull requests need the Mac's workspace, so they stay there.
 */

import type { Agent, CopyRef, KeptCopy, LeftOut } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { describeError, discardCopy, keepCopy } from '../lib/session';
import { useApp } from '../lib/store';
import { CARD_TITLE_SCALE } from '../lib/theme';
import { useColors } from '../lib/appearance';
import { folderName } from '../lib/agents';
import { useCardStyles } from './ApprovalCard';
import { Button, T } from './ui';

/**
 * What Keep leaves behind, in the Mac's words (`task::left_out_line`).
 * Exported for tests.
 */
export function leftOutLine(items: LeftOut[] | undefined): string | null {
  if (!items?.length) return null;
  const why = {
    secrets: 'looks like secrets',
    dependencies: 'dependencies',
    tooLarge: 'over 5 MB',
  };
  const parts: string[] = [];
  const skipped = items.filter((l) => l.why !== 'ignored').slice(0, 5);
  if (skipped.length) {
    parts.push(
      `Not included: ${skipped.map((l) => `${l.path} (${why[l.why as keyof typeof why]})`).join(', ')}`
    );
  }
  const ignored = items.filter((l) => l.why === 'ignored').slice(0, 5);
  if (ignored.length) {
    parts.push(`changed ${ignored.map((l) => l.path).join(', ')} — not included (git ignores it)`);
  }
  return parts.join(' · ');
}

/** What Keep's answer says, in the chat's words. Exported for tests. */
export function keptLine(project: string, agentName: string, kept: KeptCopy): string {
  const withLeftOut = (line: string, left?: LeftOut[]) => {
    const more = leftOutLine(left);
    return more ? `${line} · ${more}` : line;
  };
  switch (kept.outcome) {
    case 'kept':
      return withLeftOut(`Kept the changes in ${project} (${kept.branch})`, kept.leftOut);
    case 'nothing':
      return withLeftOut(`${project} already has these changes`, kept.leftOut);
    case 'conflict':
      return `Some of these changes overlap with edits made in ${project} since (${kept.files
        .slice(0, 3)
        .join(', ')}). Choose which to keep on the Mac, or ask ${agentName} to sort it out.`;
    case 'markers':
      return `Some files still have conflict markers in them (${kept.files
        .slice(0, 3)
        .join(', ')}). Nothing was kept. Finish choosing on the Mac, or ask ${agentName} to.`;
    case 'otherBranch':
      return `${project} is on ${kept.current} now${
        kept.base ? `, not ${kept.base}` : ''
      }. Nothing was kept.`;
  }
}

/** The confirmation before keeping into another branch. Exported for tests. */
export function otherBranchQuestion(
  project: string,
  current: string,
  base: string | undefined
): string {
  return base
    ? `${project} is on ${current} now, but these changes were made from ${base}. Keeping them in ${current} also brings along whatever ${base} has that ${current} doesn't.`
    : `${project} is on ${current} now, but these changes weren't made from a branch. Keeping them in ${current} brings them, and the version they started from, into ${current}.`;
}

export function CopyActions({
  agent,
  copy,
  project: projectPath,
  leftOut,
  warning,
  onError,
}: {
  agent: Agent;
  copy: CopyRef;
  /** The project's folder, as the card names it. */
  project: string;
  /** The card's files Keep won't bring over. */
  leftOut?: LeftOut[];
  /** Why the copy's changes couldn't be saved this turn. */
  warning?: string;
  onError: (text: string) => void;
}) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const served = useApp((s) => !!s.welcome?.methods.includes('agents.keepCopy'));
  const connected = useApp((s) => s.link.kind === 'connected');
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === projectPath)?.name ?? folderName(projectPath)
  );
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null);
  if (!served) return null;
  const working = agent.status.state !== 'idle';
  // What stopped the last Keep lives on the Mac (the agent's copy), so it
  // survives this row remounting; a Keep that went through clears the copy,
  // and the Mac's note in the chat says what it did.
  const stuck = agent.copy?.id === copy.id ? agent.copy.stuck : undefined;
  const off = !connected || working || busy !== null;

  // The haptic says what the Mac did, so it waits for the Mac.
  const keep = (into?: string) => {
    setBusy('keep');
    keepCopy(agent.id, copy.id, into)
      .then((kept) => {
        if (kept.outcome === 'kept' || kept.outcome === 'nothing') haptic.success();
        else haptic.warning();
      })
      .catch((e: unknown) => {
        haptic.error();
        onError(describeError(e));
      })
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
              .then(() => haptic.success())
              .catch((e: unknown) => {
                haptic.error();
                onError(describeError(e));
              })
              .finally(() => setBusy(null));
          },
        },
      ]
    );

  // On another branch now: the button names it, under a line naming both,
  // so pressing it is the explicit choice.
  const into = stuck?.outcome === 'otherBranch' ? stuck.current : undefined;
  const title = working
    ? 'Changes so far'
    : stuck
      ? stuck.outcome === 'otherBranch'
        ? `Keep into ${stuck.current}?`
        : 'Not kept yet'
      : 'Changes are ready';
  const note = stuck
    ? stuck.outcome === 'otherBranch'
      ? otherBranchQuestion(project, stuck.current, stuck.base)
      : keptLine(project, agent.name, stuck)
    : null;

  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.head}>
        <T variant="headline" color={colors.textStrong} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {title}
        </T>
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {working
            ? `${agent.name} is working on a copy of ${project}`
            : `On a copy of ${project} · ${project} itself is unchanged`}
        </T>
      </View>
      {note ? (
        <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {note}
        </T>
      ) : null}
      {warning ? (
        <T variant="small" color={colors.accentWarning} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {warning}
        </T>
      ) : null}
      {leftOutLine(leftOut) ? (
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {leftOutLine(leftOut)}
        </T>
      ) : null}
      {!connected && (
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          Keep or discard these once your Mac is back.
        </T>
      )}
      <View style={cardStyles.actions}>
        <Button
          title="Discard"
          variant="outline"
          busy={busy === 'discard'}
          disabled={off}
          onPress={discard}
          style={{ flex: 1 }}
        />
        <Button
          title={into ? `Keep into ${into}` : 'Keep changes'}
          variant="answer"
          busy={busy === 'keep'}
          disabled={off}
          onPress={() => keep(into)}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}
