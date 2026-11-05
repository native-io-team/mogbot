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
import { colors, space } from '../lib/theme';
import {
  ARM_MS,
  cardStyles,
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
import { Button, choose as actionSheet, T } from './ui';

/**
 * An option that covers more than this one request ("Yes, allow all edits
 * during this session", "…and don't ask again"). The phone can't know its
 * exact reach (that's the session's), so it says only that it is wider.
 */
const BROADER = /\b(all|always|during this session|don.t ask again|for this session)\b/i;
const BROADER_SCOPE = 'Covers more than this one request.';

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
  const [busy, setBusy] = useState<number | null>(null);
  const pending = approval.status === 'pending';
  const armed = useArmed(pending);
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

  const indexed = prompt.options.map((option, index) => ({ option, index }));
  const allow = indexed.find(({ option }) => option.role === 'allow');
  const deny = indexed.find(({ option }) => option.role === 'deny');
  const others = indexed.filter(({ option }) => option.role === 'other');
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
  const fit = useFitDetail(pending);
  const compact = useShortPane();

  return (
    <Animated.View
      layout={LinearTransition.duration(220)}
      onLayout={fit.onCardLayout}
      style={[cardStyles.card, pending && cardStyles.cardPending]}
    >
      {pending && <Eyebrow />}
      <T variant="subhead" color={colors.textWhite} maxFontSizeMultiplier={2}>
        {approval.title}
      </T>
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
          {/* The safe pair first, as on every approval; anything broader comes after it. */}
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
                  variant="primary"
                  busy={busy === allow.index}
                  disabled={off}
                  focusable={armed}
                  accessibilityHint={allow.option.label}
                  onPress={() => void choose(allow.index)}
                  style={{ flex: 1 }}
                />
              )}
              {compact && others.length > 0 && (
                // A short pane: Deny | Allow stay the last line; the rest are one tap away.
                <MoreAnswers
                  disabled={off || !armed}
                  onPress={() =>
                    actionSheet(
                      approval.title,
                      others.map(({ option, index }) => ({
                        label: option.label,
                        run: () => void choose(index),
                      })),
                      others.some(({ option }) => BROADER.test(option.label))
                        ? BROADER_SCOPE
                        : undefined
                    )
                  }
                />
              )}
            </View>
          )}
          {!(compact && (deny || allow)) &&
            others.map(({ option, index }) => {
              const broader = !!(deny || allow) && BROADER.test(option.label);
              return (
                <View key={index} style={{ gap: space.xs }}>
                  <Button
                    title={option.label}
                    lines={3}
                    busy={busy === index}
                    disabled={off}
                    focusable={armed}
                    accessibilityHint={broader ? BROADER_SCOPE : undefined}
                    onPress={() => void choose(index)}
                  />
                  {broader && (
                    <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
                      {BROADER_SCOPE}
                    </T>
                  )}
                </View>
              );
            })}
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
