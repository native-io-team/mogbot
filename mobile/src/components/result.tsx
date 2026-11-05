/**
 * The result card (`share_result`), on the shared card as the desk draws it:
 * a document icon, the title with its version, what changed since the last
 * one, then the summary, what the agent didn't verify (up front, tinted,
 * only when it said), a before/after pair, its files and links, what it
 * says it checked, and "Ask for changes". A project copy's card is the same
 * card with the copy's note and Discard / Keep changes in its answer row
 * (`copy`), never a second card inside it.
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
  supersededLine,
  type Agent,
  type AgentMessage,
  type ResultCard,
  type ResultItem,
  type ResultRef,
} from '@shipstudio/companion-protocol';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { makeStyles, useColors } from '../lib/appearance';
import { alpha, iconSize, radius, space } from '../lib/theme';
import { useApp, useServed } from '../lib/store';
import { Attachments } from './attachments';
import { useCopyParts, type CopyProps } from './copy';
import { Card, Line, OFFLINE_NOTE, TextAction } from './surfaces';
import { Icon, T } from './ui';

/** The Mac takes `revises` on a send: only then is "Ask for changes" offered. */
export const useCanRevise = () => useServed('agents.send', MAC_FEATURES.reviseResults);

export const refOf = (card: ResultCard): ResultRef => ({
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
  card: ResultCard;
  agentId: string;
  onError: (t: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const pair = beforeAfter(card.items);
  const items = listedItems(card.items);
  const files = items.flatMap((i) => (i.kind === 'file' ? [i.file] : []));
  const links = items.filter((i): i is Extract<ResultItem, { kind: 'link' }> => i.kind === 'link');
  const notVerified = card.notVerified ?? [];
  const checked = card.checked ?? [];
  return (
    <>
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
  copy,
  onError,
}: {
  message: AgentMessage;
  card: ResultCard;
  agent: Agent;
  newest: boolean;
  /** Absent when this Mac can't take a revision. */
  onAskForChanges?: (ref: ResultRef) => void;
  /** Lines that belong to the work (what changed in the copy). */
  children?: ReactNode;
  /** A project copy's part: its note, and Discard / Keep changes. */
  copy?: CopyProps;
  onError: (t: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const parts = useCopyParts(copy ?? null);
  const connected = useApp((s) => s.link.kind === 'connected');
  if (!newest && !opened) {
    return (
      <Line
        icon="doc.text"
        text={supersededLine(card)}
        onPress={() => setOpened(true)}
        pressHint="Shows this earlier version"
      />
    );
  }
  // A text action, as Review changes is: not an answer, so it never sits
  // among them as a button. Beside a copy's answers it takes the line above
  // them, at the start, so Discard / Keep changes keep their full width.
  const ask = newest && onAskForChanges && (
    <View style={parts ? { flexBasis: '100%' } : undefined}>
      <TextAction
        label="Ask for changes"
        disabled={!connected}
        onPress={() => {
          haptic.light();
          onAskForChanges(refOf(card));
        }}
      />
    </View>
  );
  return (
    <Card
      icon="doc.text"
      title={card.title}
      meta={card.version > 1 ? `v${card.version}` : undefined}
      source={changesLine(card) ?? undefined}
      // Offline the answers stay, disabled, with the one note every card uses
      // (a copy's own note already says it).
      note={parts?.note ?? (ask && !connected ? OFFLINE_NOTE : undefined)}
      actions={
        ask || parts ? (
          <>
            {ask}
            {parts?.actions}
          </>
        ) : undefined
      }
      style={!newest && { opacity: 0.85 }}
      accessibilityLabel={`Result: ${card.title}`}
      testID={`result-${message.id}`}
    >
      <Body card={card} agentId={agent.id} onError={onError} />
      {children}
    </Card>
  );
}

const useStyles = makeStyles((colors) => ({
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
}));
