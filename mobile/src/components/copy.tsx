/**
 * Keep / Discard for the newest change card of an agent's open copy of its
 * project (`agents/task.rs` on the Mac), on the shared card: a folder, "Changes
 * are ready", "On a copy of acme-site · acme-site itself is unchanged", then
 * Discard (outline) and the neutral Keep changes last, never the agent's
 * colour. Inside a result card (`result.tsx`) the same note and answers join
 * that card instead of nesting a second one (`useCopyParts`).
 *
 * Shown only when the Mac serves `agents.keepCopy` (`welcome.methods`); older
 * Macs leave the card a line. What stopped a Keep comes from the agent's copy
 * (`copy.stuck`), not from this component, so it survives the row remounting.
 *
 * The words stay plain, as the desk's: "a copy of acme-site", "Keep changes",
 * "Discard", "Keep there too". No version (branch) names. Preview and pull
 * requests need the Mac's workspace, so they stay there.
 */

import type { Agent, CopyRef, KeptCopy, LeftOut } from '@shipstudio/companion-protocol';
import { useState, type ReactNode } from 'react';
import { Alert, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import { describeError, discardCopy, keepCopy } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { CARD_TITLE_SCALE, space } from '../lib/theme';
import { useColors } from '../lib/appearance';
import { folderName } from '../lib/agents';
import { drivenLine } from '../lib/bars';
import { Card, OFFLINE_NOTE, useActionShare } from './surfaces';
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
      return withLeftOut(`Kept the changes in ${project}`, kept.leftOut);
    case 'nothing':
      return withLeftOut(`${project} already has these changes`, kept.leftOut);
    case 'conflict':
      return `Some of these changes overlap with edits made in ${project} since (${kept.files
        .slice(0, 3)
        .join(', ')}). Choose which to keep on your Mac, or ask ${agentName} to sort it out.`;
    case 'markers':
      return `Some files still have conflict markers in them (${kept.files
        .slice(0, 3)
        .join(', ')}). Nothing was kept. Finish choosing on your Mac, or ask ${agentName} to.`;
    case 'otherBranch':
      return `${project} has moved on to another version since. Nothing was kept.`;
  }
}

/**
 * Why Keep is asking before it keeps into the version the project is on now,
 * when that isn't the one the changes started from: the desk's words
 * (`otherBranchNote`), with no version names. Exported for tests.
 */
export function otherBranchQuestion(project: string, base: string | undefined): string {
  return base
    ? `${project} has moved on to another version since these changes were started. Keeping them there also brings along anything from the version they started from that it doesn’t have yet.`
    : `${project} has moved on to another version since these changes were started. Keeping them there brings them, and the version they started from, along.`;
}

export interface CopyProps {
  agent: Agent;
  copy: CopyRef;
  /** The project's folder, as the card names it. */
  project: string;
  /** The card's files Keep won't bring over. */
  leftOut?: LeftOut[];
  /** Why the copy's changes couldn't be saved this turn. */
  warning?: string;
  /** What changed ("2 files · +3 −1"), said once, in the card's note. */
  stats?: ReactNode;
  /** Keep / Discard as compact buttons (a Catch up row); full size on a card. */
  size?: 'default' | 'compact';
  onError: (text: string) => void;
}

export interface CopyParts {
  title: string;
  source: string;
  note: ReactNode;
  /** Discard, then Keep changes last. */
  actions: ReactNode;
}

/** The copy's part of a card: its words, its note, its answers. Null when the Mac can't keep. */
export function useCopyParts(props: CopyProps | null): CopyParts | null {
  const colors = useColors();
  // The Mac's last answer while it's away: offline, Keep / Discard stay, disabled.
  const served = useServed('agents.keepCopy');
  const connected = useApp((s) => s.link.kind === 'connected');
  const projectPath = props?.project ?? '';
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === projectPath)?.name ?? folderName(projectPath)
  );
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null);
  // One at a time: two taps in one frame both see the render before `busy`.
  const once = useInFlight();
  // Sized for the longer Keep label, so the pair never cuts it at a large text size.
  const share = useActionShare(['Discard', 'Keep there too']);
  if (!props || !served) return null;
  const { agent, copy, leftOut, warning, stats, size, onError } = props;
  const working = agent.status.state !== 'idle';
  // Driven by hand on the Mac: the copy may be mid-edit in the terminal, and
  // the Mac refuses Keep and Discard until it's handed back.
  const driven = Boolean(agent.takeover);
  // What stopped the last Keep lives on the Mac (the agent's copy), so it
  // survives this row remounting; a Keep that went through clears the copy,
  // and the Mac's note in the chat says what it did.
  const stuck = agent.copy?.id === copy.id ? agent.copy.stuck : undefined;
  const off = !connected || working || driven || busy !== null;

  // The haptic says what the Mac did, so it waits for the Mac.
  const keep = (into?: string) =>
    once(async () => {
      setBusy('keep');
      try {
        const kept = await keepCopy(agent.id, copy.id, into);
        if (kept.outcome === 'kept' || kept.outcome === 'nothing') haptic.success();
        else haptic.warning();
      } catch (e) {
        haptic.error();
        onError(describeError(e));
      } finally {
        setBusy(null);
      }
    });

  const discard = () =>
    Alert.alert(
      'Discard these changes?',
      `The copy and everything in it go; ${project} stays as it is.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () =>
            void once(async () => {
              setBusy('discard');
              try {
                await discardCopy(agent.id, copy.id);
                haptic.success();
              } catch (e) {
                haptic.error();
                onError(describeError(e));
              } finally {
                setBusy(null);
              }
            }),
        },
      ]
    );

  // On another version now: the question names no versions, and pressing
  // "Keep there too" is the explicit choice.
  const into = stuck?.outcome === 'otherBranch' ? stuck.current : undefined;
  const title = working
    ? 'Changes so far'
    : stuck
      ? stuck.outcome === 'otherBranch'
        ? 'Keep there too?'
        : 'Not kept yet'
      : 'Changes are ready';
  const said = stuck
    ? stuck.outcome === 'otherBranch'
      ? otherBranchQuestion(project, stuck.base)
      : keptLine(project, agent.name, stuck)
    : null;
  const left = leftOutLine(leftOut);
  const wait = driven
    ? `${drivenLine(agent.name)}: hand it back first.`
    : !connected
      ? OFFLINE_NOTE
      : null;

  const muted = (text: string) => (
    <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
      {text}
    </T>
  );
  const note =
    stats || said || warning || left || wait ? (
      <View style={{ gap: space.xs }}>
        {stats}
        {said && (
          <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
            {said}
          </T>
        )}
        {warning ? (
          <T variant="small" color={colors.accentWarning} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
            {warning}
          </T>
        ) : null}
        {left && muted(left)}
        {wait && muted(wait)}
      </View>
    ) : null;

  return {
    title,
    source: working
      ? `${agent.name} is working on a copy of ${project}`
      : `On a copy of ${project} · ${project} itself is unchanged`,
    note,
    actions: (
      <>
        <Button
          title="Discard"
          variant="outline"
          size={size}
          busy={busy === 'discard'}
          disabled={off}
          onPress={discard}
          style={size === 'compact' ? undefined : share}
        />
        <Button
          title={into ? 'Keep there too' : 'Keep changes'}
          variant="answer"
          size={size}
          busy={busy === 'keep'}
          disabled={off}
          onPress={() => void keep(into)}
          style={size === 'compact' ? undefined : share}
        />
      </>
    ),
  };
}

/** A copy's card on its own, when the turn didn't share a result. */
export function CopyCard(props: CopyProps) {
  const parts = useCopyParts(props);
  if (!parts) return null;
  return (
    <Card
      icon="folder.fill"
      title={parts.title}
      source={parts.source}
      note={parts.note}
      actions={parts.actions}
    />
  );
}
