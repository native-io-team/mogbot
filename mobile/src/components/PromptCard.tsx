/**
 * A question a project session is waiting on (folder trust, a permission
 * prompt, a menu), in the session's own words with every option it offers.
 * Answering sends that option's keys to the session through the same
 * `agents.answerApproval` the desk calls, and resolves the card in every
 * chat it sits in. Inert for a beat after it lands, like every card.
 */

import type { Agent, AgentMessage, Approval, SessionPrompt } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { cardOutcome, folderName } from '../lib/agents';
import { diffLineKind } from '../lib/diff';
import { haptic } from '../lib/haptics';
import { answerApproval, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { space } from '../lib/theme';
import { useColors } from '../lib/appearance';
import {
  ARM_MS,
  useCardStyles,
  Command,
  Eyebrow,
  FittedDetail,
  MoreAnswers,
  useArmed,
  useFitDetail,
  useShortPane,
} from './ApprovalCard';
import { DiffLines } from './diff';
import { tabName } from './session';
import { choose as actionSheet } from './menu';
import { Button, T } from './ui';
import { moreMessage, promptAnswers } from '../lib/answers';

export function PromptCard({
  message,
  approval,
  prompt,
  agent,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  prompt: SessionPrompt;
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

  const choose = async (index: number) => {
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
  };

  const { deny, allow, more, listed } = promptAnswers(prompt);
  const owner = prompt.owner.name === agent.name ? 'Its' : `${prompt.owner.name}’s`;
  // The tab as its own engine names it ("Codex 2"), when the Mac's project
  // list says which engine; the prompt itself doesn't carry it.
  const session = useApp((s) =>
    s.projects?.flatMap((p) => p.sessions).find((x) => x.sessionId === prompt.sessionId)
  );
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === prompt.project)?.name ?? folderName(prompt.project)
  );
  const tab = tabName({ cli: session?.cli, tab: prompt.tab });
  const lines = approval.detail ? approval.detail.split('\n') : [];
  const isDiff = lines.some((l) => {
    const kind = diffLineKind(l);
    return kind === 'add' || kind === 'del';
  });

  return (
    <Animated.View
      layout={LinearTransition.duration(220)}
      onLayout={fit.onCardLayout}
      style={[cardStyles.card, pending && cardStyles.cardPending]}
    >
      {!fit.pinned && (
        // The pin above the chat shows the question while this can't fit whole.
        <View onLayout={fit.onHeadLayout} style={{ gap: space.md }}>
          {pending && <Eyebrow />}
          <T variant="subhead" color={colors.textStrong} maxFontSizeMultiplier={2}>
            {approval.title}
          </T>
        </View>
      )}
      <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
        {owner} work in {project} · {tab}
      </T>
      {/* Folder trust is the Mac's explanation, not the session's text: prose. */}
      {!!approval.detail && (
        <FittedDetail fit={fit}>
          {prompt.kind === 'trust' ? (
            <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
              {approval.detail}
            </T>
          ) : isDiff ? (
            <DiffLines lines={lines} label="The change it’s asking about" />
          ) : (
            <Command text={approval.detail} lines={12} />
          )}
        </FittedDetail>
      )}
      {pending && !connected && (
        <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
          Answer it once your Mac is back. It stays open until then.
        </T>
      )}
      {pending ? (
        <Animated.View
          entering={FadeIn.duration(ARM_MS)}
          exiting={FadeOut.duration(120)}
          pointerEvents={armed ? 'auto' : 'none'}
          accessibilityElementsHidden={!armed}
          importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
          style={{ gap: space.sm }}
        >
          {/* The safe pair, and only it, under the thumb; everything else behind ⋯. */}
          {(deny || allow) && (
            <View style={cardStyles.actions}>
              {deny && (
                <Button
                  title="Deny"
                  busy={busy === deny.index}
                  disabled={off}
                  focusable={armed}
                  accessibilityHint={deny.option.label}
                  onPress={() => void choose(deny.index)}
                  style={{ flex: 1 }}
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
                  style={{ flex: 1 }}
                />
              )}
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
            </View>
          )}
          {/* A plain menu (no Deny | Allow): every option, as the session lists them. */}
          {listed.map(({ option, index }) => (
            <Button
              key={index}
              title={option.label}
              lines={3}
              busy={busy === index}
              disabled={off}
              focusable={armed}
              onPress={() => void choose(index)}
            />
          ))}
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(200).delay(100)}>
          <T
            variant="small"
            color={approval.status === 'allowed' ? colors.accentSuccess : colors.textSecondary}
          >
            {cardOutcome(approval)}
          </T>
        </Animated.View>
      )}
    </Animated.View>
  );
}
