/**
 * A question a project's task is waiting on (folder trust, a permission
 * prompt, a menu), in its own words with every option it offers, on the
 * shared card: icon and title, "Acme Site · in acme-site", then ⋯ · Deny ·
 * Allow with the neutral Allow last.
 * Answering sends that option's keys to the session through the same
 * `agents.answerApproval` the desk calls, and resolves the card in every
 * chat it sits in. Inert for a beat after it lands, like every card.
 */

import type { Agent, AgentMessage, Approval, SessionPrompt } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { cardOutcome, folderName } from '../lib/agents';
import { diffLineKind } from '../lib/diff';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import { answerApproval, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { CARD_TITLE_SCALE, space } from '../lib/theme';
import { useColors } from '../lib/appearance';
import {
  ARM_MS,
  useCardStyles,
  Command,
  FittedDetail,
  MoreAnswers,
  Receipt,
  useArmed,
  useFitDetail,
  useShortPane,
} from './ApprovalCard';
import { DiffLines } from './diff';
import { choose as actionSheet } from './menu';
import { ACTION, ACTION_ROW, Card, OFFLINE_NOTE } from './surfaces';
import { Button, T } from './ui';
import { moreMessage, promptAnswers } from '../lib/answers';

export function PromptCard({
  message,
  approval,
  prompt,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  prompt: SessionPrompt;
  /** The chat it sits in; the card names the task's own agent, whichever chat this is. */
  agent: Agent;
  onError: (text: string) => void;
}) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const [busy, setBusy] = useState<number | null>(null);
  const pending = approval.status === 'pending';
  const fit = useFitDetail(pending, message.id);
  const compact = useShortPane();
  const armed = useArmed(pending, `${compact}:${fit.pinned}`);
  const connected = useApp((s) => s.link.kind === 'connected');
  const off = busy !== null || !connected;
  const once = useInFlight();

  const choose = (index: number) =>
    once(async () => {
      if (!armed) return;
      const option = prompt.options[index];
      setBusy(index);
      try {
        await answerApproval(
          message.agentId,
          approval.requestId,
          option.role !== 'deny',
          false,
          undefined,
          index
        );
        if (option.role === 'deny') haptic.warning();
        else haptic.success();
      } catch (error) {
        haptic.error();
        onError(describeError(error));
      } finally {
        setBusy(null);
      }
    });

  const { deny, allow, more, listed } = promptAnswers(prompt);
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === prompt.project)?.name ?? folderName(prompt.project)
  );
  // Whose task, and where, as the desk says it: "Acme Site · in acme-site".
  // Never the tab's engine and number.
  const where = `${prompt.owner.name} · in ${project}`;
  const lines = approval.detail ? approval.detail.split('\n') : [];
  const isDiff = lines.some((l) => {
    const kind = diffLineKind(l);
    return kind === 'add' || kind === 'del';
  });

  const detail =
    !!approval.detail &&
    (prompt.kind === 'trust' ? (
      <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
        {approval.detail}
      </T>
    ) : isDiff ? (
      <DiffLines lines={lines} label="The change it’s asking about" />
    ) : (
      <Command text={approval.detail} lines={12} />
    ));

  if (!pending) {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={cardOutcome(approval)}>
        <T variant="caption" color={colors.textMuted}>
          {where}
        </T>
        {detail}
      </Receipt>
    );
  }

  return (
    <Card
      icon={
        prompt.kind === 'trust'
          ? 'folder.fill'
          : prompt.kind === 'permission'
            ? 'checkmark.shield'
            : 'bubble.left'
      }
      title={approval.title}
      source={where}
      // The pin above the chat shows the question while this can't fit whole.
      hideHead={fit.pinned}
      onLayout={fit.onCardLayout}
      onHeadLayout={fit.onHeadLayout}
      note={!connected ? OFFLINE_NOTE : undefined}
      actions={
        <Animated.View
          entering={FadeIn.duration(ARM_MS)}
          exiting={FadeOut.duration(120)}
          pointerEvents={armed ? 'auto' : 'none'}
          accessibilityElementsHidden={!armed}
          importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
          style={cardStyles.choices}
        >
          {/* A plain menu (no Deny | Allow): every option, as the task lists them. */}
          {listed.map(({ option, index }) => (
            <Button
              key={index}
              title={option.label}
              variant="outline"
              lines={3}
              busy={busy === index}
              disabled={off}
              focusable={armed}
              onPress={() => void choose(index)}
              // A choice in a menu reads left-aligned, not as a centred button that wrapped.
              style={[ACTION_ROW, { justifyContent: 'flex-start', paddingHorizontal: space.lg }]}
            />
          ))}
          {/* The safe pair, and only it, under the thumb; everything else behind ⋯. */}
          {(deny || allow) && (
            <Animated.View style={cardStyles.answers}>
              {more.length > 0 && (
                <MoreAnswers
                  disabled={off || !armed}
                  onPress={() =>
                    actionSheet(
                      approval.title,
                      more.map(({ option, index }) => ({
                        label: option.label,
                        run: () => void choose(index),
                      })),
                      moreMessage(more)
                    )
                  }
                />
              )}
              {deny && (
                <Button
                  title="Deny"
                  variant="outline"
                  busy={busy === deny.index}
                  disabled={off}
                  focusable={armed}
                  accessibilityHint={deny.option.label}
                  onPress={() => void choose(deny.index)}
                  style={ACTION}
                />
              )}
              {allow && (
                <Button
                  title="Allow"
                  variant="answer"
                  busy={busy === allow.index}
                  disabled={off}
                  focusable={armed}
                  accessibilityHint={allow.option.label}
                  onPress={() => void choose(allow.index)}
                  style={ACTION}
                />
              )}
            </Animated.View>
          )}
        </Animated.View>
      }
    >
      {/* Folder trust is the Mac's explanation, not the task's text: prose. */}
      {detail && <FittedDetail fit={fit}>{detail}</FittedDetail>}
    </Card>
  );
}
