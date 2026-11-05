/**
 * The rows of a conversation. Yours are neutral bubbles on the right; the
 * agent's replies are prose on the left with no bubble (as on the desktop);
 * everything else is a Line or a Card (`surfaces.tsx`): one quiet centred
 * sentence for what happened, one card anatomy for what wants a decision or
 * holds a result.
 */

import {
  revisingLabel,
  splitQuotes,
  type Agent,
  type AgentMessage,
  type ResultRef,
} from '@shipstudio/companion-protocol';
import { memo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { engineName, failureLine, folderName, formatClock } from '../lib/agents';
import { drivenWait } from '../lib/bars';
import { haptic } from '../lib/haptics';
import { canCall, discardPending, editPending, resend } from '../lib/session';
import type { PendingSend } from '../lib/sync';
import {
  avatarSize,
  composer,
  fonts,
  iconSize,
  lineHeight,
  space,
  type,
  PRESSED,
} from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Attachments } from './attachments';
import { useReveal } from '../lib/reveal';
import { Markdown } from './Markdown';
import { Card, Line, TextAction } from './surfaces';
import { Button, Icon, T } from './ui';
import { AgentAvatar } from './agent';
import { TypingDots } from './TypingDots';
import {
  ApprovalCard,
  DecideCards,
  PhoneReviewCard,
  PlaybackCard,
  ReviewOnMacCard,
} from './ApprovalCard';
import { PromptCard } from './PromptCard';
import { SecretCard } from './SecretCard';
import { LoginCard } from './LoginCard';
import { servesLogins } from '../lib/logins';
import { useTaskName } from './session';
import { LiveWork, WorkLine } from './work';
import { CopyCard } from './copy';
import { ResultCardView, useCanRevise } from './result';
import { setComposer } from '../lib/drafts';
import { getApp, useApp, useServed } from '../lib/store';

const enter = FadeInDown.duration(220).springify().damping(18);

export const MessageRow = memo(function MessageRow({
  message,
  agent,
  queued,
  liveCopy,
  newestResult = true,
  latestFailure = false,
  onAskForChanges,
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
  /** The failure that ended the agent's last turn, nothing since. */
  latestFailure?: boolean;
  /**
   * Where "Ask for changes" goes. By default the request is staged in the
   * agent's own composer, which is this chat; a room passes its own (the
   * member's chat opens with it staged, since a room message can't revise).
   */
  onAskForChanges?: (agentId: string, ref: ResultRef) => void;
  onError: (text: string) => void;
  /** Copy, Quote, Select Text: words only, so only user and agent messages. */
  onLongPress?: (message: AgentMessage) => void;
}) {
  const styles = useStyles();
  const colors = useColors();
  const hold = onLongPress && message.text.trim() ? () => onLongPress(message) : undefined;
  const canRevise = useCanRevise();
  const askForChanges = canRevise
    ? (ref: ResultRef) =>
        onAskForChanges
          ? onAskForChanges(message.agentId, ref)
          : setComposer(message.agentId, { revising: ref })
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
          copy={
            copy && message.changes
              ? {
                  agent,
                  copy,
                  project: message.changes.project,
                  leftOut: message.changes.leftOut,
                  warning: message.changes.warning,
                  stats: <ChangeStats message={message} />,
                  onError,
                }
              : undefined
          }
          onError={onError}
        >
          {message.changes && !copy && newestResult && <SystemLine message={message} />}
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
              // A room's own line has no agent: its files are in every
              // member's home, so the member drawing it serves them.
              agentId={message.agentId || agent.id}
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
                ? `Queued · ${drivenWait(agent.name)}`
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
          {!!message.decide?.length && <DecideCards message={message} onError={onError} />}
          {!!message.attachments?.length && (
            <Attachments
              agentId={message.agentId}
              attachments={message.attachments}
              onError={onError}
            />
          )}
          {message.work && <WorkLine message={message} work={message.work} onError={onError} />}
          {/* A stopped turn ends in a Line, as every turn that didn't finish does. */}
          {message.stopped && <Line text="Stopped" />}
        </Pressable>
      );
    case 'approval':
      // A login card, from a Mac that serves its methods. (One that doesn't
      // never sends `login`; if it did, the plain card's Allow starts its
      // first way in on the Mac.)
      if (message.approval?.login && servesLogins(getApp().welcome)) {
        return (
          <LoginCard
            message={message}
            approval={message.approval}
            login={message.approval.login}
            agent={agent}
            onError={onError}
          />
        );
      }
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
      if (message.approval?.connector?.kind === 'playback') {
        return <PlaybackCard message={message} approval={message.approval} onError={onError} />;
      }
      if (message.approval?.connector?.kind === 'review') {
        return canCall('agents.import.review') ? (
          <PhoneReviewCard message={message} approval={message.approval} onError={onError} />
        ) : (
          <ReviewOnMacCard approval={message.approval} />
        );
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
      // A usage limit isn't an error (it resets by itself): a line. A real
      // failure is a card, with the error mark.
      const limited = message.failure?.kind === 'usage_limit';
      const words = message.failure
        ? failureLine(message.failure, message.text, engineName(agent))
        : message.text;
      const row = limited ? (
        <Line text={words} icon="clock" />
      ) : (
        <FailureCard message={message} agent={agent} title={words} latest={latestFailure} />
      );
      if (!message.work) return row;
      return (
        <View style={styles.agentRow}>
          {row}
          <WorkLine message={message} work={message.work} onError={onError} />
        </View>
      );
    }
    case 'session':
      return message.session ? <SessionCard message={message} onError={onError} /> : null;
    case 'note':
      // "Started fresh · memory kept", a take-over that closed: something that happened.
      return <Line text={message.text} />;
    case 'sent_to_agent':
    case 'from_agent':
      if (message.peer) return <PeerRow message={message} />;
      return <SystemLine message={message} />;
    case 'check_in':
      if (!message.work) return <Line text={checkInText(message)} />;
      return (
        <View style={styles.agentRow}>
          <Line text={checkInText(message)} />
          <WorkLine message={message} work={message.work} onError={onError} />
        </View>
      );
    default:
      if (liveCopy && message.changes?.copy) {
        return (
          <View style={styles.agentRow}>
            <CopyCard
              agent={agent}
              copy={message.changes.copy}
              project={message.changes.project}
              leftOut={message.changes.leftOut}
              warning={message.changes.warning}
              stats={<ChangeStats message={message} />}
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

/** "Today 2:40 PM": where the day changes or the talk picks up after a pause. A Line. */
export function DaySeparator({ label }: { label: string }) {
  return <Line text={label} header />;
}

/**
 * What an agent did in one of a project's tasks, as the desktop shows it: a
 * line for "started" and "sent", a card with the task's reply, and preview
 * screenshots inline. A task that still exists opens read-only.
 */
function SessionCard({
  message,
  onError,
}: {
  message: AgentMessage;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const router = useRouter();
  const mark = message.session!;
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === mark.project)?.name ?? folderName(mark.project)
  );
  const tab = useTaskName(mark.sessionId);
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
      <Line
        icon="terminal"
        text={
          mark.event === 'started' ? `Started a task in ${project}` : `Sent to a task in ${project}`
        }
        onPress={open}
        pressHint={open ? 'Opens the task' : undefined}
      />
    );
  }

  const reply = mark.event === 'reply';
  return (
    <Card
      icon={reply ? 'terminal' : 'photo'}
      // What it is in the title, where in the source: the same as every card.
      title={reply ? tab : message.text || 'Preview'}
      meta={formatClock(message.ts)}
      source={`In ${project}`}
      actions={open && <Button title={`Open in ${project}`} variant="outline" onPress={open} />}
    >
      {reply ? (
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
    </Card>
  );
}

/** A routine's line: what found it (a "When…" routine), or that it ran by hand. */
function checkInText(message: AgentMessage): string {
  const c = message.checkIn;
  const what = c?.manual ? 'Ran now' : c?.found ? `Routine · ${c.found}` : 'Routine';
  return `${what} · ${message.text}`;
}

/** What changed, in a line of its own: "Changed 2 files in acme-site · +3 −1", opening the diff. */
function SystemLine({ message }: { message: AgentMessage }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  // The Mac's last answer while it's away: offline it stays, disabled.
  const canDiff = useServed('agents.changeDiff');
  const online = useApp((s) => !!s.welcome);
  const changes = message.kind === 'changes' ? message.changes : undefined;
  const text = changes
    ? `Changed ${changes.fileCount} file${changes.fileCount === 1 ? '' : 's'} in ${
        changes.copy ? 'a copy of ' : ''
      }${changes.project.split('/').pop()}`
    : message.kind === 'sent_to_agent' && message.peer
      ? `To ${message.peer.name}: ${message.text}`
      : message.kind === 'from_agent' && message.peer
        ? `From ${message.peer.name}: ${message.text}`
        : message.text;
  const opens = !!changes && canDiff && online;
  // No clock of its own: the chat's time lines say when (and the long-press menu, exactly).
  return (
    <Line
      icon={changes ? 'doc.text' : undefined}
      text={text}
      trail={
        changes && (
          <>
            {' · '}
            <T variant="caption" color={colors.diffAdd} style={styles.count}>
              +{changes.added}
            </T>{' '}
            <T variant="caption" color={colors.diffDel} style={styles.count}>
              −{changes.removed}
            </T>
          </>
        )
      }
      onPress={
        opens
          ? () =>
              router.push({
                pathname: '/diff',
                params: { agentId: message.agentId, messageId: message.id },
              })
          : undefined
      }
      pressHint={opens ? 'Shows what changed in each file' : undefined}
    />
  );
}

/**
 * What changed, inside a copy's card (its note), so the card and a line above
 * it don't say the same thing twice: "2 files · +3 −1", and Review changes.
 */
export function ChangeStats({ message }: { message: AgentMessage }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  // The Mac's last answer while it's away: offline it stays, disabled.
  const canDiff = useServed('agents.changeDiff');
  const online = useApp((s) => !!s.welcome);
  const changes = message.changes;
  if (!changes) return null;
  return (
    <View style={styles.stats}>
      <T variant="caption" color={colors.textMuted} style={{ flexShrink: 1 }}>
        {`${changes.fileCount} file${changes.fileCount === 1 ? '' : 's'} · `}
        <T variant="caption" color={colors.diffAdd} style={styles.count}>
          +{changes.added}
        </T>{' '}
        <T variant="caption" color={colors.diffDel} style={styles.count}>
          −{changes.removed}
        </T>
      </T>
      {canDiff && (
        <TextAction
          label="Review changes"
          disabled={!online}
          onPress={() =>
            router.push({
              pathname: '/diff',
              params: { agentId: message.agentId, messageId: message.id },
            })
          }
        />
      )}
    </View>
  );
}

/**
 * A real failure, on the card anatomy: what happened, what it ran on and
 * where, the Mac's own words when they say more, and what to do about it.
 */
function FailureCard({
  message,
  agent,
  title,
  latest,
}: {
  message: AgentMessage;
  agent: Agent;
  title: string;
  /** The agent's last turn: only then is "send a message" the way forward. */
  latest: boolean;
}) {
  const colors = useColors();
  const router = useRouter();
  const signedOut = message.failure?.kind === 'signed_out';
  const engine = engineName(agent);
  const project = agent.project ? folderName(agent.project) : null;
  // The Mac's words, when they say more than the title already does.
  const said = message.text.trim();
  const more = !!said && !title.includes(said.replace(/[.:!?]+$/, ''));
  return (
    <Card
      icon="exclamationmark.circle"
      tone="error"
      title={title}
      meta={formatClock(message.ts)}
      // The message doesn't record what it ran on, and the agent may have
      // switched engines since: only where, which doesn't change.
      source={project ? `In ${project}` : undefined}
      note={
        !latest
          ? undefined
          : signedOut
            ? `Sign in to ${engine} on your Mac, then send it again.`
            : 'Send a message to try again.'
      }
      actions={
        signedOut ? (
          <Button
            title="Connection details"
            variant="outline"
            onPress={() => router.push('/connection')}
          />
        ) : undefined
      }
    >
      {!signedOut && more && (
        <T variant="small" color={colors.textSecondary} numberOfLines={6}>
          {said}
        </T>
      )}
    </Card>
  );
}

/**
 * One agent writing to another: set off from the conversation (the other
 * agent's face, "To Ops" / "From Ops", the words under a rule), so it never
 * reads as part of a reply to you. Long briefs fold to four lines.
 */
function PeerRow({ message }: { message: AgentMessage }) {
  const colors = useColors();
  const styles = useStyles();
  const peer = message.peer!;
  const color = useApp(
    (s) => s.overview?.agents.find((a) => a.id === peer.id)?.color ?? colors.textMuted
  );
  const [open, setOpen] = useState(false);
  const to = message.kind === 'sent_to_agent';
  const label = `${to ? 'To' : 'From'} ${peer.name}`;
  const long = message.text.length > 220 || message.text.split('\n').length > 4;
  return (
    <Pressable
      disabled={!long}
      onPress={() => setOpen((o) => !o)}
      accessibilityRole={long ? 'button' : 'text'}
      accessibilityLabel={`${label}: ${message.text}`}
      accessibilityState={long ? { expanded: open } : undefined}
      style={({ pressed }) => [styles.peer, pressed && PRESSED]}
      testID="peer-row"
    >
      <AgentAvatar name={peer.name} color={color} size={avatarSize.group} />
      <View style={styles.peerBody}>
        <View style={styles.peerHead}>
          <Icon
            name={to ? 'arrow.turn.up.right' : 'arrow.turn.down.left'}
            size={iconSize.inline}
            color={colors.textMuted}
          />
          <T variant="caption" color={colors.textSecondary} style={{ fontFamily: fonts.medium }}>
            {label}
          </T>
        </View>
        <T
          variant="small"
          color={colors.textSecondary}
          numberOfLines={open || !long ? undefined : 4}
        >
          {message.text}
        </T>
        {long && (
          <T variant="caption" color={colors.textMuted}>
            {open ? 'Show less' : 'Show all'}
          </T>
        )}
      </View>
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
            <TextAction
              label="Edit"
              onPress={() => {
                haptic.light();
                editPending(pending);
              }}
            />
          ) : (
            pending.failed && (
              <TextAction
                label="Send"
                onPress={() => {
                  haptic.light();
                  void resend(pending).catch(() => {});
                }}
              />
            )
          )}
          <TextAction
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
        {/* No words (mid-import, when the bar says it): the dots speak. */}
        <TypingDots label={label ? undefined : 'Working'} />
        {!!label && (
          <T variant="small" color={colors.textSecondary} numberOfLines={1}>
            {label}
          </T>
        )}
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
  // The reading size (17) on a 24 line, a little tighter than a reply's so a
  // short bubble stays a pill; 14×10 inside, the composer's 18 corner that
  // stays 18 however many lines, and never wider than 80% of the column.
  userBubble: {
    maxWidth: '80%',
    backgroundColor: colors.surfaceBubble,
    borderRadius: composer.corner,
    paddingHorizontal: space.md + space['2xs'],
    paddingVertical: space.sm + space['2xs'],
  },
  bubbleText: { fontSize: type.read, lineHeight: lineHeight(type.read, 1.4) },
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
  count: { fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.md },
  peer: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  peerBody: {
    flex: 1,
    gap: space['2xs'],
    paddingLeft: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderDefault,
  },
  peerHead: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  working: { gap: space.sm, paddingVertical: space.xs },
  workingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    // One line tall with or without words, so the row never jumps.
    minHeight: lineHeight(type.small),
  },
}));
