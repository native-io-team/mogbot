/**
 * The result card (`share_result`), in the desk's order on the shared card:
 * an icon for what kind of thing was made, the title with its version, what
 * changed since the last one (set off by a rule), the summary, then the work
 * itself full width: the before and after per page (a slider or side by
 * side, `compare`), its files, and its links as one hairline list (a kind
 * tile, the name, the host). Then one Checks box: what it says it checked
 * over what it didn't verify. "Ask for changes" closes the card. A project
 * copy's card is the same card with the copy's note and Discard / Keep
 * changes in its answer row (`copy`), never a second card inside it.
 *
 * Only the newest version of a result is drawn in full; an older one folds
 * to a line. Nothing here fills a list the agent didn't give.
 */

import {
  CHECKED_HEADING,
  CHECKPOINT_LABEL,
  comparePages,
  changesLine,
  consoleLine,
  testHeadline,
  testShots,
  itemName,
  linkHost,
  linkKind,
  listedItems,
  MAC_FEATURES,
  supersededLine,
  type Agent,
  type AgentMessage,
  type LinkKind,
  type ResultCard,
  type ResultItem,
  type ResultRef,
  type TestReport,
} from '@shipstudio/companion-protocol';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { openHere } from '../lib/logins';
import { describeError, watchLive } from '../lib/session';
import { haptic } from '../lib/haptics';
import { makeStyles, useColors } from '../lib/appearance';
import { iconSize, keySize, radius, space, squircle } from '../lib/theme';
import { useApp, useServed } from '../lib/store';
import { Attachments } from './attachments';
import { Compare } from './compare';
import { useCopyParts, type CopyProps } from './copy';
import { Card, Line, offlineNote, TextAction } from './surfaces';
import { Icon, T } from './ui';
import type { SFName } from '../lib/icons';
import { useComputer } from '../lib/computer';

/** The Mac takes `revises` on a send: only then is "Ask for changes" offered. */
export const useCanRevise = () => useServed('agents.send', MAC_FEATURES.reviseResults);

export const refOf = (card: ResultCard): ResultRef => ({
  id: card.id,
  version: card.version,
  title: card.title,
});

/** A test screenshot's width in the strip: a phone-sized page shows whole, caption below. */
const SHOT_WIDTH = 200;

/** The Mac can hand out a link to a card's running site (`agents.watchLive`). */
export const useCanWatch = () => useServed('agents.watchLive');

/**
 * What "Test it" found on the Mac: the outcome in a line, the console's
 * errors, the agent's list of what's broken, and its screenshots as a strip
 * that pages sideways, each captioned with the step it was taken at.
 */
export function TestPart({
  report,
  agentId,
  onError,
}: {
  report: TestReport;
  agentId: string;
  onError: (t: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const shots = testShots(report);
  const broken = report.broken ?? [];
  const errors = consoleLine(report);
  return (
    <View
      style={{ gap: space.sm }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      testID="result-test"
    >
      <View style={styles.row}>
        {report.outcome === 'broken' && (
          <Icon
            name="exclamationmark.triangle"
            size={iconSize.inline}
            color={colors.accentWarning}
          />
        )}
        <T variant="small" style={styles.strong}>
          {testHeadline(report)}
        </T>
      </View>
      {!!report.summary && (
        <T variant="small" color={colors.textBody}>
          {report.summary}
        </T>
      )}
      {broken.map((line, i) => (
        <T key={`${i}:${line}`} variant="small" color={colors.textBody}>
          • {line}
        </T>
      ))}
      {errors && (
        <T variant="caption" color={colors.textMuted}>
          {errors}
        </T>
      )}
      {shots.length > 0 && width > 0 && (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          accessibilityLabel={`${shots.length} screenshots from the test`}
          testID="result-test-strip"
          style={{ width }}
        >
          {shots.map(({ shot, label }, i) => (
            <View key={`${i}:${shot.path}`} style={{ width, gap: space.xs }}>
              <Attachments
                agentId={agentId}
                attachments={[shot]}
                width={Math.min(width, SHOT_WIDTH)}
                onError={onError}
              />
              <T variant="caption" color={colors.textMuted} numberOfLines={2}>
                {`${i + 1} of ${shots.length} · ${label}`}
              </T>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** Only plain web links open; anything else is shown, not followed. */
const safeLink = (url: string) => /^https?:\/\//i.test(url);

/** A host line under a title that is already that address says nothing new. */
const repeatsHost = (host: string, name: string) => {
  const bare = name.replace(/^www\./i, '').toLowerCase();
  const h = host.toLowerCase();
  return bare === h || bare.startsWith(`${h}/`);
};

const LINK_ICON: Record<LinkKind, SFName> = {
  local: 'desktopcomputer',
  repo: 'chevron.left.forwardslash.chevron.right',
  doc: 'doc.text',
  web: 'globe',
};

function LinkRow({ item, first }: { item: Extract<ResultItem, { kind: 'link' }>; first: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const name = itemName(item);
  const host = linkHost(item.url);
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
      style={({ pressed }) => [styles.link, !first && styles.divided, pressed && { opacity: 0.6 }]}
    >
      <View style={styles.tile}>
        <Icon
          name={LINK_ICON[linkKind(item.url)]}
          size={iconSize.inline}
          color={colors.textSecondary}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1}>{name}</T>
        {!repeatsHost(host, name) && (
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
  const pages = comparePages(card.items);
  const items = listedItems(card.items);
  const files = items.flatMap((i) => (i.kind === 'file' ? [i.file] : []));
  const links = items.filter((i): i is Extract<ResultItem, { kind: 'link' }> => i.kind === 'link');
  const notVerified = card.notVerified ?? [];
  const checked = card.checked ?? [];
  const changes = card.version > 1 ? card.changes?.trim() : undefined;
  return (
    <>
      {/* What changed since the version before: the agent's line, by a rule.
          A test's own section says how it went, so it isn't repeated here. */}
      {!!changes && !card.test && (
        <View style={styles.changes} accessibilityLabel={changesLine(card) ?? undefined}>
          <T variant="caption" color={colors.textMuted}>
            {`Changes since v${card.version - 1}`}
          </T>
          <T variant="small" color={colors.textSecondary}>
            {changes}
          </T>
        </View>
      )}
      {!!card.summary && <T color={colors.textBody}>{card.summary}</T>}
      {pages.length > 0 && <Compare agentId={agentId} pages={pages} />}
      {files.length > 0 && <Attachments agentId={agentId} attachments={files} onError={onError} />}
      {links.length > 0 && (
        <View style={styles.list}>
          {links.map((l, i) => (
            <LinkRow key={`${i}:${l.url}`} item={l} first={i === 0} />
          ))}
        </View>
      )}
      {(checked.length > 0 || notVerified.length > 0) && (
        <View style={styles.checks}>
          {checked.length > 0 && (
            <View style={styles.checkPart}>
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
          {notVerified.length > 0 && (
            <View
              style={[styles.checkPart, checked.length > 0 && styles.divided]}
              accessibilityLabel={`Not verified: ${notVerified.join('. ')}`}
            >
              <View style={styles.row}>
                {/* What wasn't checked is normal and expected: a quiet question,
                    as on the desk, never the warning triangle (real danger only). */}
                <Icon name="questionmark.circle" size={iconSize.inline} color={colors.textMuted} />
                <T variant="small" style={styles.unverifiedTitle}>
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
  const comp = useComputer();
  const [opened, setOpened] = useState(false);
  const parts = useCopyParts(copy ?? null);
  const connected = useApp((s) => s.link.kind === 'connected');
  const canWatch = useCanWatch();
  const [opening, setOpening] = useState(false);
  const styles = useStyles();
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
    <TextAction
      label="Ask for changes"
      disabled={!connected}
      onPress={() => {
        haptic.light();
        onAskForChanges(refOf(card));
      }}
    />
  );
  // The running site, read-only, over this Mac's own tailnet: a way to look,
  // not an answer, so a text action like Ask for changes.
  const watch = newest && canWatch && Boolean(card.project || copy) && (
    <TextAction
      label={opening ? 'Opening…' : 'Watch live'}
      hint={`Opens the site running on ${comp.your}, read-only`}
      disabled={!connected || opening}
      onPress={() => {
        haptic.light();
        setOpening(true);
        watchLive(agent.id, message.id)
          .then((link) => openHere(link.url))
          .catch((e: unknown) => onError(describeError(e)))
          .finally(() => setOpening(false));
      }}
    />
  );
  return (
    <Card
      icon="doc.text"
      // No glide: its pictures arrive while it's drawn (docs/mobile.md).
      glide={false}
      title={card.title}
      meta={
        [card.checkpoint ? CHECKPOINT_LABEL : null, card.version > 1 ? `v${card.version}` : null]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      // Offline the answers stay, disabled, with the one note every card uses
      // (a copy's own note already says it).
      note={parts?.note ?? (ask && !connected ? offlineNote() : undefined)}
      actions={
        ask || watch || parts ? (
          <>
            {/* Beside a copy's answers the text actions share one line above
                them (each on a line of its own read as a list, not actions). */}
            {parts && (watch || ask) ? (
              <View style={styles.textActions}>
                {watch}
                {ask}
              </View>
            ) : watch && ask ? (
              // Two words side by side keep their 44pt targets apart.
              <View style={styles.textPair}>
                {watch}
                {ask}
              </View>
            ) : (
              <>
                {watch}
                {ask}
              </>
            )}
            {parts?.actions}
          </>
        ) : undefined
      }
      style={!newest && { opacity: 0.85 }}
      accessibilityLabel={`Result: ${card.title}`}
      testID={`result-${message.id}`}
    >
      <Body card={card} agentId={agent.id} onError={onError} />
      {card.test && <TestPart report={card.test} agentId={agent.id} onError={onError} />}
      {children}
    </Card>
  );
}

const useStyles = makeStyles((colors) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  textActions: {
    flexBasis: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    // Each text action reaches `space.sm` past its words: less than twice
    // that and Watch live's target ran into Ask for changes'.
    gap: space.lg,
  },
  textPair: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  strong: { fontWeight: '600' as const, color: colors.textPrimary },
  // One box for both lists, split by a hairline: the claims, then the caveats.
  checks: {
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    overflow: 'hidden',
  },
  checkPart: { gap: space.xs, padding: space.md },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
  },
  unverifiedTitle: { fontWeight: '600' as const, color: colors.textSecondary },
  changes: {
    gap: space['2xs'],
    paddingLeft: space.md,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderLeftColor: colors.borderStrong,
  },
  // Links as one list, a hairline between rows, each a 44pt target or more.
  list: {
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    overflow: 'hidden',
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: keySize.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  tile: {
    width: iconSize.hero,
    height: iconSize.hero,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: squircle(iconSize.hero),
    backgroundColor: colors.surfaceControl,
  },
}));
