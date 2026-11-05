/**
 * The result card (`share_result`), as the desk draws it: title, summary,
 * what the agent didn't verify (up front, tinted, only when it said), a
 * before/after pair, its files and links, what it checked, and "Ask for
 * changes". A project copy's card is the same card with Keep / Discard
 * inside it (passed in as `children`).
 *
 * Only the newest version of a result is drawn in full; an older one folds
 * to a line. Nothing here fills a list the agent didn't give.
 */

import {
  beforeAfter,
  CHECKED_HEADING,
  changesLine,
  itemName,
  listedItems,
  MAC_FEATURES,
  revisingLabel,
  supersededLine,
  type Agent,
  type AgentMessage,
  type ResultCard as Card,
  type ResultItem,
  type ResultRef,
} from '@shipstudio/companion-protocol';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { makeStyles, useColors } from '../lib/appearance';
import { alpha, iconSize, radius, space } from '../lib/theme';
import { useApp } from '../lib/store';
import { Attachments } from './attachments';
import { useCardStyles } from './ApprovalCard';
import { Button, Icon, T } from './ui';

/** The Mac takes `revises` on a send: only then is "Ask for changes" offered. */
export const useCanRevise = () =>
  useApp(
    (s) =>
      !!s.welcome?.methods.includes('agents.send') &&
      !!s.welcome?.features?.includes(MAC_FEATURES.reviseResults)
  );

export const refOf = (card: Card): ResultRef => ({
  id: card.id,
  version: card.version,
  title: card.title,
});

/** Only plain web links open; anything else is shown, not followed. */
const safeLink = (url: string) => /^https?:\/\//i.test(url);

function LinkRow({ item }: { item: Extract<ResultItem, { kind: 'link' }> }) {
  const colors = useColors();
  const styles = useStyles();
  const name = itemName(item);
  let host = item.url;
  try {
    host = new URL(item.url).host;
  } catch {
    // shown as written
  }
  const safe = safeLink(item.url);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${name}`}
      accessibilityHint={host}
      disabled={!safe}
      onPress={() => {
        haptic.light();
        void Linking.openURL(item.url);
      }}
      style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }]}
    >
      <Icon name="globe" size={iconSize.body} color={colors.textMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1}>{name}</T>
        {host !== name && (
          <T variant="caption" color={colors.textMuted} numberOfLines={1}>
            {host}
          </T>
        )}
      </View>
      {safe && <Icon name="arrow.up.right" size={iconSize.inline} color={colors.textMuted} />}
    </Pressable>
  );
}

function Body({
  card,
  agentId,
  onError,
}: {
  card: Card;
  agentId: string;
  onError: (t: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const pair = beforeAfter(card.items);
  const items = listedItems(card.items);
  const files = items.flatMap((i) => (i.kind === 'file' ? [i.file] : []));
  const links = items.filter((i): i is Extract<ResultItem, { kind: 'link' }> => i.kind === 'link');
  const changes = changesLine(card);
  const notVerified = card.notVerified ?? [];
  const checked = card.checked ?? [];
  return (
    <>
      {changes && (
        <T variant="small" color={colors.textSecondary}>
          {changes}
        </T>
      )}
      {!!card.summary && <T color={colors.textBody}>{card.summary}</T>}
      {notVerified.length > 0 && (
        <View
          style={styles.unverified}
          accessibilityLabel={`Not verified: ${notVerified.join('. ')}`}
        >
          <View style={styles.row}>
            <Icon
              name="exclamationmark.triangle"
              size={iconSize.inline}
              color={colors.accentWarning}
            />
            <T variant="small" style={styles.strong}>
              Not verified
            </T>
          </View>
          {notVerified.map((line, i) => (
            <T key={`${i}:${line}`} variant="small" color={colors.textBody}>
              • {line}
            </T>
          ))}
        </View>
      )}
      {pair && (
        <View style={styles.pair}>
          {(['before', 'after'] as const).map((side) => (
            <View key={side} style={{ flex: 1, gap: space.xs }}>
              <Attachments
                agentId={agentId}
                attachments={[pair[side]]}
                width={150}
                onError={onError}
              />
              <T variant="caption" color={colors.textMuted}>
                {side === 'before' ? 'Before' : 'After'}
              </T>
            </View>
          ))}
        </View>
      )}
      {files.length > 0 && <Attachments agentId={agentId} attachments={files} onError={onError} />}
      {links.map((l, i) => (
        <LinkRow key={`${i}:${l.url}`} item={l} />
      ))}
      {checked.length > 0 && (
        <View style={{ gap: space['2xs'] }}>
          {/* The agent's claims: attributed, with a neutral bullet, not a tick. */}
          <T variant="caption" color={colors.textMuted}>
            {CHECKED_HEADING}
          </T>
          {checked.map((line, i) => (
            <T key={`${i}:${line}`} variant="small" color={colors.textSecondary}>
              • {line}
            </T>
          ))}
        </View>
      )}
    </>
  );
}

export function ResultCardView({
  message,
  card,
  agent,
  newest,
  onAskForChanges,
  children,
  onError,
}: {
  message: AgentMessage;
  card: Card;
  agent: Agent;
  newest: boolean;
  /** Absent when this Mac can't take a revision. */
  onAskForChanges?: (ref: ResultRef) => void;
  /** A project copy's part (Keep / Discard). */
  children?: ReactNode;
  onError: (t: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const [opened, setOpened] = useState(false);
  if (!newest && !opened) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Shows this earlier version"
        onPress={() => setOpened(true)}
        style={styles.past}
      >
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
        <T variant="small" color={colors.textMuted} numberOfLines={1} style={{ flexShrink: 1 }}>
          {supersededLine(card)}
        </T>
      </Pressable>
    );
  }
  return (
    <View
      style={[cardStyles.card, !newest && { opacity: 0.85 }]}
      accessibilityLabel={`Result: ${card.title}`}
      testID={`result-${message.id}`}
    >
      <View style={styles.head}>
        <T variant="headline" style={{ flex: 1 }}>
          {card.title}
        </T>
        {card.version > 1 && (
          <View style={styles.version}>
            <T variant="caption" color={colors.textSecondary}>
              v{card.version}
            </T>
          </View>
        )}
      </View>
      <Body card={card} agentId={agent.id} onError={onError} />
      {children}
      {newest && onAskForChanges && (
        <Button
          title="Ask for changes"
          variant="secondary"
          size="compact"
          icon="bubble.left"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => {
            haptic.light();
            onAskForChanges(refOf(card));
          }}
        />
      )}
    </View>
  );
}

/** Above the composer: what the message being written asks to change. */
export function RevisingChip({
  revising,
  onRemove,
}: {
  revising: ResultRef;
  onRemove: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.chip}>
      <Icon name="bubble.left" size={iconSize.inline} color={colors.textMuted} />
      <T variant="small" color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
        {revisingLabel(revising)}
      </T>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Don't ask for changes"
        hitSlop={16}
        onPress={onRemove}
      >
        <Icon name="xmark" size={iconSize.inline} color={colors.textMuted} fallback={<T>×</T>} />
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  version: {
    paddingHorizontal: space.tight,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  strong: { fontWeight: '600' as const, color: colors.textPrimary },
  unverified: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.inner,
    backgroundColor: alpha(colors.accentWarning, 0.14),
  },
  pair: { flexDirection: 'row', gap: space.sm },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
  },
  past: { flexDirection: 'row', alignItems: 'center', gap: space.tight, paddingVertical: space.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    paddingVertical: space.xs,
    paddingLeft: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.textMuted,
  },
}));
