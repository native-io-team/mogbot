/**
 * The rows of a conversation. Yours are neutral bubbles on the right; the
 * agent's replies are prose on the left with no bubble (as on the desktop);
 * everything else is a quiet line or a card.
 */

import {
  revisingLabel,
  splitQuotes,
  type Agent,
  type AgentMessage,
} from '@shipstudio/companion-protocol';
import { memo } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import {
  DRIVEN_LINE,
  engineName,
  failureLine,
  folderName,
  formatClock,
  sessionLabel,
} from '../lib/agents';
import { haptic } from '../lib/haptics';
import { discardPending, editPending, resend } from '../lib/session';
import type { PendingSend } from '../lib/sync';
import { alpha, chromeScale, composer, fonts, iconSize, radius, space, type } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Attachments } from './attachments';
import { useReveal } from '../lib/reveal';
import { Markdown } from './Markdown';
import { Icon, useRipple, T } from './ui';
import { Spinner } from './agent';
import { ApprovalCard, ReviewOnMacCard } from './ApprovalCard';
import { PromptCard } from './PromptCard';
import { SecretCard } from './SecretCard';
import { LiveWork, WorkLine } from './work';
import { CopyActions } from './copy';
import { ResultCardView, useCanRevise } from './result';
import { setComposer } from '../lib/drafts';
import { useApp } from '../lib/store';

const enter = FadeInDown.duration(220).springify().damping(18);

export const MessageRow = memo(function MessageRow({
  message,
  agent,
  queued,
  liveCopy,
  newestResult = true,
  onError,
  onLongPress,
}: {
  message: AgentMessage;
  agent: Agent;
  queued: boolean;
  /** The newest change card of the agent's open copy: it offers Keep / Discard. */
  liveCopy?: boolean;
  /** This message carries the newest version of its result card. */
  newestResult?: boolean;
  onError: (text: string) => void;
  /** Copy, Quote, Select Text: words only, so only user and agent messages. */
  onLongPress?: (message: AgentMessage) => void;
}) {
  const styles = useStyles();
  const colors = useColors();
  const hold = onLongPress && message.text.trim() ? () => onLongPress(message) : undefined;
  const canRevise = useCanRevise();
  const askForChanges = canRevise
    ? (ref: { id: string; version: number; title: string }) =>
        setComposer(message.agentId, { revising: ref })
    : undefined;
  if (message.result && (message.kind === 'agent' || message.kind === 'changes')) {
    const copy = liveCopy ? message.changes?.copy : undefined;
    return (
      <View style={styles.agentRow}>
        <ResultCardView
          message={message}
          card={message.result}
          agent={agent}
          newest={newestResult || !!copy}
          onAskForChanges={newestResult ? askForChanges : undefined}
          onError={onError}
        >
          {message.changes && (newestResult || copy) && <SystemLine message={message} />}
          {copy && message.changes && (
            <CopyActions
              agent={agent}
              copy={copy}
              project={message.changes.project}
              leftOut={message.changes.leftOut}
              warning={message.changes.warning}
              onError={onError}
            />
          )}
        </ResultCardView>
        {message.work && <WorkLine message={message} work={message.work} onError={onError} />}
      </View>
    );
  }
  switch (message.kind) {
    case 'user':
      return (
        <View style={styles.userRow}>
          {!!message.attachments?.length && (
            <Attachments
              agentId={message.agentId}
              attachments={message.attachments}
              align="right"
              onError={onError}
            />
          )}
          {!!message.text && (
            <Pressable
              onLongPress={hold}
              delayLongPress={300}
              accessibilityHint={hold ? 'Hold for Copy, Quote and Select Text' : undefined}
              style={({ pressed }) => [styles.userBubble, pressed && styles.held]}
            >
              {message.revises && (
                <View style={[styles.bubbleQuote, { marginBottom: space.xs }]}>
                  <T variant="small" color={colors.textSecondary} numberOfLines={2}>
                    {revisingLabel(message.revises)}
                  </T>
                </View>
              )}
              <Bubble text={message.text} />
            </Pressable>
          )}
          {queued && (
            <T variant="caption" color={colors.textSecondary} style={styles.meta}>
              {agent.takeover
                ? `Queued · ${DRIVEN_LINE}`
                : `Queued · ${agent.name} reads it when this turn ends`}
            </T>
          )}
        </View>
      );
    case 'agent':
      return (
        <Pressable
          onLongPress={hold}
          delayLongPress={300}
          accessibilityHint={hold ? 'Hold for Copy, Quote and Select Text' : undefined}
          style={({ pressed }) => [styles.agentRow, pressed && styles.heldProse]}
        >
          <Prose id={message.id} text={message.text} />
          {!!message.attachments?.length && (
            <Attachments
              agentId={message.agentId}
              attachments={message.attachments}
              onError={onError}
            />
          )}
          {message.stopped && (
            <T variant="caption" color={colors.textSecondary}>
              Stopped
            </T>
          )}
          {message.work && <WorkLine message={message} work={message.work} onError={onError} />}
        </Pressable>
      );
    case 'approval':
      if (message.approval?.secret) {
        return (
          <SecretCard
            message={message}
            approval={message.approval}
            request={message.approval.secret}
            agent={agent}
            onError={onError}
          />
        );
      }
      if (message.approval?.connector?.kind === 'review') {
        return <ReviewOnMacCard approval={message.approval} />;
      }
      if (message.approval?.prompt) {
        return (
          <PromptCard
            message={message}
            approval={message.approval}
            prompt={message.approval.prompt}
            agent={agent}
            onError={onError}
          />
        );
      }
      return message.approval ? (
        <ApprovalCard
          message={message}
          approval={message.approval}
          agent={agent}
          onError={onError}
        />
      ) : null;
    case 'error': {
      const line = (
        <View style={styles.errorRow}>
          <Icon
            name="exclamationmark.circle"
            size={iconSize.inline}
            color={colors.accentErrorLight}
          />
          <T variant="small" color={colors.accentErrorLight} style={{ flex: 1 }}>
            {message.failure
              ? failureLine(message.failure, message.text, engineName(agent))
              : message.text}
          </T>
        </View>
      );
      if (!message.work) return line;
      return (
        <View style={styles.agentRow}>
          {line}
          <WorkLine message={message} work={message.work} onError={onError} />
        </View>
      );
    }
    case 'session':
      return message.session ? <SessionCard message={message} onError={onError} /> : null;
    case 'note':
      // "Started fresh · memory kept": where a new conversation began.
      return message.fresh ? (
        <DaySeparator label={message.text} />
      ) : (
        <SystemLine message={message} />
      );
    default:
      if (liveCopy && message.changes?.copy) {
        return (
          <View style={styles.agentRow}>
            <SystemLine message={message} />
            <CopyActions
              agent={agent}
              copy={message.changes.copy}
              project={message.changes.project}
              leftOut={message.changes.leftOut}
              warning={message.changes.warning}
              onError={onError}
            />
            {message.work && <WorkLine message={message} work={message.work} onError={onError} />}
          </View>
        );
      }
      if (message.work) {
        return (
          <View style={styles.agentRow}>
            <SystemLine message={message} />
            <WorkLine message={message} work={message.work} onError={onError} />
          </View>
        );
      }
      return <SystemLine message={message} />;
  }
});

/** Your words, with any quoted passages set off above them. */
function Bubble({ text }: { text: string }) {
  const colors = useColors();
  const styles = useStyles();
  const parts = splitQuotes(text);
  if (parts.length === 1 && parts[0].kind === 'text') {
    return (
      <T color={colors.textBody} style={styles.bubbleText}>
        {text}
      </T>
    );
  }
  return (
    <View style={{ gap: space.xs }}>
      {parts.map((p, i) =>
        p.kind === 'quote' ? (
          <View key={i} style={styles.bubbleQuote}>
            <T variant="small" color={colors.textSecondary} numberOfLines={4}>
              {p.text}
            </T>
          </View>
        ) : (
          <T key={i} color={colors.textBody} style={styles.bubbleText}>
            {p.text}
          </T>
        )
      )}
    </View>
  );
}

/** "Today 2:40 PM", centred: where the day changes or the talk picks up after a pause. */
export function DaySeparator({ label }: { label: string }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.day} accessibilityRole="header">
      <T
        variant="caption"
        color={colors.textMuted}
        maxFontSizeMultiplier={chromeScale}
        style={styles.dayText}
      >
        {label}
      </T>
    </View>
  );
}

/**
 * What an agent did in a project's session, as the desktop shows it: a line
 * for "started" and "sent", a card with the session's reply, and preview
 * screenshots inline. A session that still exists opens read-only.
 */
function SessionCard({
  message,
  onError,
}: {
  message: AgentMessage;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const mark = message.session!;
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === mark.project)?.name ?? folderName(mark.project)
  );
  const tab = sessionLabel(mark);
  const open = mark.sessionId
    ? () => {
        router.push({
          pathname: '/session/[id]',
          params: {
            id: mark.sessionId!,
            project,
            tab,
            ...(mark.event === 'reply' ? { reply: message.text } : {}),
          },
        });
      }
    : undefined;

  if (mark.event === 'started' || mark.event === 'sent') {
    return (
      <Pressable
        disabled={!open}
        onPress={open}
        accessibilityRole={open ? 'button' : undefined}
        hitSlop={{ top: 10, bottom: 10 }}
        style={({ pressed }) => [styles.sessionLine, pressed && { opacity: 0.6 }]}
      >
        <Icon name="terminal" size={iconSize.inline} color={colors.textMuted} />
        <T variant="small" color={colors.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
          {mark.event === 'started'
            ? `Started a task in ${project}`
            : `Sent to ${project} · ${tab}`}
        </T>
        {open && <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />}
      </Pressable>
    );
  }

  return (
    <View style={styles.sessionCard}>
      <View style={styles.sessionHead}>
        <Icon
          name={mark.event === 'reply' ? 'terminal' : 'photo'}
          size={iconSize.inline}
          color={colors.textMuted}
        />
        <T variant="caption" color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
          {mark.event === 'reply'
            ? `${project} · ${tab}`
            : `${project} · ${message.text || 'Preview'}`}
        </T>
        <T variant="caption" color={colors.textMuted}>
          {formatClock(message.ts)}
        </T>
      </View>
      {mark.event === 'reply' ? (
        <T color={colors.textBody} numberOfLines={8}>
          {message.text}
        </T>
      ) : (
        message.attachments && (
          <Attachments
            agentId={message.agentId}
            attachments={message.attachments}
            width={176}
            onError={onError}
          />
        )
      )}
      {open && (
        <Pressable
          onPress={open}
          hitSlop={12}
          style={styles.sessionOpen}
          accessibilityRole="button"
        >
          <T variant="small" color={colors.textStrong} style={{ fontFamily: fonts.medium }}>
            Open task
          </T>
          <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

/** Notes, check-ins, delegation and session lines: one muted line each. A change opens its diff. */
function SystemLine({ message }: { message: AgentMessage }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const canDiff = useApp((s) => !!s.welcome?.methods.includes('agents.changeDiff'));
  const changes = message.kind === 'changes' ? message.changes : undefined;
  const text = changes
    ? `Changed ${changes.fileCount} file${changes.fileCount === 1 ? '' : 's'} in ${
        changes.copy ? 'a copy of ' : ''
      }${changes.project.split('/').pop()}`
    : message.kind === 'sent_to_agent' && message.peer
      ? `To ${message.peer.name}: ${message.text}`
      : message.kind === 'from_agent' && message.peer
        ? `From ${message.peer.name}: ${message.text}`
        : message.kind === 'check_in'
          ? `${message.checkIn?.manual ? 'Ran now' : 'Routine'} · ${message.text}`
          : message.text;
  const opens = !!changes && canDiff;
  // No clock of its own: the chat's time lines say when (and the long-press menu, exactly).
  const line = (
    <View style={styles.systemRow}>
      {changes && <Icon name="doc.text" size={iconSize.inline} color={colors.textMuted} />}
      <T variant="small" color={colors.textSecondary} numberOfLines={4} style={{ flexShrink: 1 }}>
        {text}
        {changes && (
          <>
            {' · '}
            <T variant="small" color={colors.diffAdd} style={styles.count}>
              +{changes.added}
            </T>{' '}
            <T variant="small" color={colors.diffDel} style={styles.count}>
              −{changes.removed}
            </T>
          </>
        )}
      </T>
      {opens && <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />}
    </View>
  );
  if (!opens) return line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Shows what changed in each file"
      onPress={() =>
        router.push({
          pathname: '/diff',
          params: { agentId: message.agentId, messageId: message.id },
        })
      }
      hitSlop={{ top: 12, bottom: 12 }}
      style={({ pressed }) => [styles.systemTap, pressed && { opacity: 0.6 }]}
    >
      {line}
    </Pressable>
  );
}

export function PendingRow({ pending }: { pending: PendingSend }) {
  const colors = useColors();
  const styles = useStyles();
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const dim = pending.failed || pending.waiting;
  return (
    <Animated.View entering={enter} style={styles.userRow}>
      {!!pending.attachments?.length && (
        <View style={dim && { opacity: 0.6 }}>
          <Attachments
            agentId={pending.agentId}
            align="right"
            attachments={pending.attachments.map((a) => ({ ...a, path: '', localUri: a.uri }))}
          />
        </View>
      )}
      {!!pending.text && (
        <View style={[styles.userBubble, dim && { opacity: 0.6 }]}>
          <Bubble text={pending.text} />
        </View>
      )}
      {pending.refused && !!pending.reason && (
        // Why the Mac said no, where it happened, not only in a passing toast.
        <T variant="caption" color={colors.textSecondary} style={styles.refusedReason}>
          {pending.reason}
        </T>
      )}
      {pending.failed || pending.waiting ? (
        <View style={styles.failedLine}>
          <T
            variant="caption"
            color={pending.failed ? colors.accentErrorLight : colors.textSecondary}
            style={{ flexShrink: 1 }}
          >
            {pending.failed ? 'Not sent' : `Waiting for ${macName}`}
          </T>
          {pending.refused ? (
            // A refusal is final: sending it again is refused again. Edit puts it back.
            <LineButton
              label="Edit"
              onPress={() => {
                haptic.light();
                editPending(pending);
              }}
            />
          ) : (
            pending.failed && (
              <LineButton
                label="Send"
                onPress={() => {
                  haptic.light();
                  void resend(pending).catch(() => {});
                }}
              />
            )
          )}
          <LineButton
            label="Discard"
            muted
            onPress={() => discardPending(pending.agentId, pending.clientId)}
          />
        </View>
      ) : (
        <T variant="caption" color={colors.textSecondary} style={styles.meta}>
          Sending…
        </T>
      )}
    </Animated.View>
  );
}

/** A word you can tap in a status line: small to see, 44pt to hit. */
function LineButton({
  label,
  onPress,
  muted,
}: {
  label: string;
  onPress: () => void;
  muted?: boolean;
}) {
  const colors = useColors();
  const ripple = useRipple();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      android_ripple={{ ...ripple, borderless: true }}
      onPress={onPress}
    >
      <T variant="caption" color={muted ? colors.textSecondary : colors.textStrong}>
        {label}
      </T>
    </Pressable>
  );
}

/** A reply being written: revealed at the display's own pace (`useReveal`). */
export function DraftRow({
  id,
  text,
  onHeight,
}: {
  id: string;
  text: string;
  onHeight?: (height: number) => void;
}) {
  const styles = useStyles();
  return (
    <View
      style={styles.agentRow}
      onLayout={onHeight && ((e: LayoutChangeEvent) => onHeight(e.nativeEvent.layout.height))}
    >
      <Prose id={id} text={text} streaming />
    </View>
  );
}

/**
 * An agent's words. While they're still being revealed (streaming, or the
 * finished message catching up with where its draft had got to) they go
 * through the streaming renderer; once caught up, the plain one.
 */
function Prose({ id, text, streaming = false }: { id: string; text: string; streaming?: boolean }) {
  const shown = useReveal(id, text, streaming);
  return shown.length < text.length || streaming ? (
    <Markdown text={shown} streaming />
  ) : (
    <Markdown text={text} />
  );
}

/** The working row, and under it the turn's steps so far, folded (`LiveWork`). */
export function WorkingRow({
  label,
  agent,
  onError,
}: {
  label: string;
  agent?: Agent;
  onError?: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Animated.View entering={FadeIn.duration(250)} style={styles.working}>
      <View style={styles.workingRow}>
        <Spinner />
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          {label}
        </T>
      </View>
      {agent && (
        <LiveWork
          agentId={agent.id}
          work={agent.status.work}
          activity={agent.status.activity}
          onError={onError ?? (() => {})}
        />
      )}
    </Animated.View>
  );
}

const useStyles = makeStyles((colors) => ({
  userRow: { alignItems: 'flex-end', gap: space.xs },
  // iMessage's proportions: 16 on a 20 line, 12×8 inside, an 18 corner that
  // stays 18 however many lines, and never wider than 78% of the column.
  userBubble: {
    maxWidth: '78%',
    backgroundColor: colors.surfaceBubble,
    borderRadius: composer.corner,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  bubbleText: { fontSize: type.body, lineHeight: composer.line },
  held: { backgroundColor: colors.surfaceControlHover },
  heldProse: { opacity: 0.7 },
  bubbleQuote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.textMuted,
    paddingLeft: space.sm,
  },
  meta: { marginRight: space.xs },
  refusedReason: { maxWidth: '78%', marginRight: space.xs, textAlign: 'right' },
  failedLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginRight: space.xs,
  },
  agentRow: { gap: space.sm },
  day: { alignItems: 'center', paddingVertical: space.xs },
  dayText: { letterSpacing: 0.2 },
  errorRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    padding: space.md,
    borderRadius: radius.inner,
    backgroundColor: alpha(colors.accentError, 0.08),
  },
  systemRow: {
    flexDirection: 'row',
    gap: space.tight,
    alignItems: 'center',
  },
  systemTap: { alignSelf: 'flex-start', paddingVertical: space.xs },
  count: { fontVariant: ['tabular-nums'] },
  working: { gap: space.sm, paddingVertical: space.xs },
  workingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  sessionLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    alignSelf: 'flex-start',
    paddingVertical: space['2xs'],
  },
  sessionCard: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  sessionHead: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  sessionOpen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    marginTop: space.xs,
  },
}));
