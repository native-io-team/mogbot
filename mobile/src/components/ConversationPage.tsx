/**
 * The living page above the messages (`agents/page.rs`): a bar (fold,
 * title, Unpin) with "Updated 3 min ago by Log the day’s card spend" on a
 * line of its own under the title (402pt has no room for both on one), and
 * the page's blocks under it, drawn by `Blocks` as any `show`. Tapping the
 * "Updated" line lists the
 * kept versions with what changed; tapping one shows it as it was. The page
 * scrolls inside a band capped at the smaller of 40% of the screen and 320pt,
 * and on a phone-height screen it starts folded to its bar until the user
 * opens it, so the chat keeps the screen. It is furniture, not a reply: a
 * tinted band whose tiles lie flat (`FlatBlocks`), as on the desk. Unpinned,
 * one quiet line with Pin brings it back. Nothing when the conversation has
 * no page or the Mac keeps none.
 */

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  pageAgo,
  pageByLine,
  pageBlocks,
  pageChangeLine,
  pageKeptByLine,
  pageOlderLine,
  pageUpdatedLine,
  pageVersionName,
  PAGE_BACK_TO_LATEST,
  type AgentMessage,
  type ConversationPage as Page,
  type PageVersion,
} from '@shipstudio/companion-protocol';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { useNow } from '../lib/moving';
import { pageVersion, pinPage, setFolded, useConversationPage } from '../lib/page';
import { iconSize, PRESSED, radius, space } from '../lib/theme';
import { Blocks } from './blocks/Blocks';
import { FlatBlocks } from './blocks/BlockParts';
import { Icon, IconButton, T } from './ui';

/** The most of the screen the open page takes before it scrolls, and its cap in points. */
const BAND = 0.4;
const BAND_MAX = 320;
/** Below this height (every phone), a page starts folded until the user opens it. */
const OPEN_FROM = 1000;

export function ConversationPage({
  agentId,
  conversation,
  turn,
  side,
  onError,
}: {
  agentId: string;
  conversation: string | undefined;
  /** Changes when the agent's turn moves on: the page is read again. */
  turn: string;
  side: { left: number; right: number };
  onError: (message: string) => void;
}) {
  const { page, folded: chosen } = useConversationPage(agentId, conversation, turn);
  const { height } = useWindowDimensions();
  const folded = chosen ?? height < OPEN_FROM;
  if (!page || !conversation) return null;
  if (!page.pinned) return <PinBack page={page} side={side} onError={onError} />;
  return (
    <PageBand
      key={`${agentId}#${conversation}`}
      page={page}
      folded={folded}
      side={side}
      onError={onError}
    />
  );
}

/**
 * An unpinned page, as one quiet line with Pin: the desk has it among the
 * chat header's actions, which the phone's header has no room for. Without
 * it, a page unpinned here could only come back from the desk.
 */
function PinBack({
  page,
  side,
  onError,
}: {
  page: Page;
  side: { left: number; right: number };
  onError: (message: string) => void;
}) {
  const styles = useStyles();
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Pin the page “${page.title}”`}
      onPress={() => {
        haptic.light();
        pinPage(page.agentId, page.conversation, true).catch((e: unknown) =>
          onError(String(e instanceof Error ? e.message : e))
        );
      }}
      style={({ pressed }) => [
        styles.band,
        styles.bar,
        { paddingLeft: space.lg + side.left, paddingRight: space.lg + side.right },
        pressed && PRESSED,
      ]}
      testID="page-pin-back"
    >
      <Icon name="pin" size={iconSize.inline} color={colors.textMuted} />
      <T variant="caption" color={colors.textMuted} numberOfLines={1} style={styles.pinTitle}>
        {`Page: ${page.title}`}
      </T>
      <T variant="caption" color={colors.textSecondary}>
        Pin
      </T>
    </Pressable>
  );
}

function PageBand({
  page,
  folded,
  side,
  onError,
}: {
  page: Page;
  folded: boolean;
  side: { left: number; right: number };
  onError: (message: string) => void;
}) {
  const styles = useStyles();
  const colors = useColors();
  const { height } = useWindowDimensions();
  const [history, setHistory] = useState(false);
  // An older version opened, for the version the page was on then: a new
  // version arriving shows the page as it is now.
  const [opened, setOpened] = useState<{ v: PageVersion; on: number } | null>(null);
  const older = opened?.on === page.version ? opened.v : null;
  const setOlder = (v: PageVersion | null) => setOpened(v ? { v, on: page.version } : null);
  // "Updated 4 min ago": a minute's clock, only while the chat shows.
  const now = useNow(60_000);

  const shown: PageVersion = older ?? page;
  const set = useMemo(() => pageBlocks(shown), [shown]);
  // `Blocks` reads a message: the page as one, never answered (nothing on it asks).
  const message = useMemo(
    () =>
      ({
        id: `page:${page.conversation}:v${shown.version}`,
        agentId: page.agentId,
        ts: shown.at,
        kind: 'agent',
        text: '',
      }) as AgentMessage,
    [page.agentId, page.conversation, shown.version, shown.at]
  );
  const open = (version: number) => {
    haptic.select();
    if (version === page.version) return setOlder(null);
    pageVersion(page.agentId, page.conversation, version)
      .then((v) => (v ? setOlder(v) : onError('That version is no longer kept.')))
      .catch((e: unknown) => onError(String(e instanceof Error ? e.message : e)));
  };
  const unpin = () => {
    haptic.light();
    pinPage(page.agentId, page.conversation, false).catch((e: unknown) =>
      onError(String(e instanceof Error ? e.message : e))
    );
  };

  return (
    <View
      style={[
        styles.band,
        { paddingLeft: space.lg + side.left, paddingRight: space.lg + side.right },
      ]}
      testID="conversation-page"
      accessibilityLabel={`Page: ${page.title}`}
    >
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !folded }}
          accessibilityLabel={`${page.title}. ${folded ? 'Show the page' : 'Fold the page'}`}
          onPress={() => {
            haptic.select();
            setFolded(page.agentId, page.conversation, !folded);
          }}
          style={({ pressed }) => [styles.toggle, pressed && PRESSED]}
          testID="page-toggle"
        >
          <Icon
            name={folded ? 'chevron.right' : 'chevron.down'}
            size={iconSize.inline}
            color={colors.textMuted}
          />
          <T variant="subhead" numberOfLines={1} style={styles.title}>
            {page.title}
          </T>
        </Pressable>
        <IconButton
          name="pin.slash"
          label="Unpin the page"
          onPress={unpin}
          size={iconSize.inline}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${pageUpdatedLine(page, now)}. What changed`}
        onPress={() => {
          haptic.select();
          setHistory(!history);
          if (folded) setFolded(page.agentId, page.conversation, false);
        }}
        style={({ pressed }) => [styles.when, pressed && PRESSED]}
        testID="page-when"
      >
        <T variant="caption" color={colors.textMuted} numberOfLines={1}>
          {pageUpdatedLine(page, now)}
        </T>
      </Pressable>
      {!folded && (
        <ScrollView style={{ maxHeight: Math.min(height * BAND, BAND_MAX) }} nestedScrollEnabled>
          {history && (
            <View style={styles.history} testID="page-history">
              {!!pageKeptByLine(page) && (
                <T variant="caption" color={colors.textSecondary} style={styles.kept}>
                  {pageKeptByLine(page)}
                </T>
              )}
              {page.history.map((h, i) => (
                <Pressable
                  key={h.version}
                  accessibilityRole="button"
                  accessibilityState={{ selected: h.version === shown.version }}
                  onPress={() => open(h.version)}
                  style={({ pressed }) => [
                    styles.version,
                    h.version === shown.version && { backgroundColor: colors.surfaceControl },
                    pressed && PRESSED,
                  ]}
                >
                  <T variant="caption" color={colors.textMuted}>
                    {`${pageVersionName(h.version)} · ${pageAgo(h.at, now)}${pageByLine(h) ? ` · ${pageByLine(h)}` : ''}`}
                  </T>
                  <T variant="small" color={colors.textSecondary}>
                    {(h.version === 1 && !page.history[i + 1]
                      ? 'Made the page'
                      : pageChangeLine(h.changes, page.blocks) || 'Updated') +
                      (h.note ? ` — ${h.note}` : '')}
                  </T>
                </Pressable>
              ))}
            </View>
          )}
          {older && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setOlder(null)}
              style={({ pressed }) => [styles.older, pressed && PRESSED]}
              testID="page-older"
            >
              <T variant="small" color={colors.textMuted}>
                {`${pageOlderLine(older, now)} ${PAGE_BACK_TO_LATEST}`}
              </T>
            </Pressable>
          )}
          {set ? (
            <FlatBlocks.Provider value>
              <Blocks message={message} set={set} />
            </FlatBlocks.Provider>
          ) : (
            <T variant="small" color={colors.textMuted}>
              This version can’t be shown in this version of the app.
            </T>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  band: {
    paddingTop: space.xs,
    paddingBottom: space.sm,
    // A step off the chat behind it, toward the ink in light and the light in dark.
    backgroundColor: colors.surfacePanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  toggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minWidth: 0,
  },
  title: { flexShrink: 1 },
  // Under the title, past the chevron, so it reads as the title's second line.
  when: { paddingLeft: iconSize.inline + space.xs, paddingBottom: space['2xs'] },
  kept: { paddingHorizontal: space.sm, paddingBottom: space['2xs'] },
  pinTitle: { flex: 1, minWidth: 0 },
  history: {
    gap: space['2xs'],
    marginBottom: space.sm,
  },
  version: {
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.inner,
  },
  older: { marginBottom: space.sm },
}));
