/**
 * The living page above the messages (`agents/page.rs`): a one-line bar
 * (fold, title, "Updated 3 min ago · v4", Unpin) and the page's blocks under
 * it, drawn by `Blocks` as any `show`. Tapping the "Updated" line lists the
 * kept versions with what changed; tapping one shows it as it was. The page
 * scrolls inside a band so the chat keeps most of the screen. Nothing when
 * the conversation has no page, the user unpinned it, or the Mac keeps none.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  pageAgo,
  pageBlocks,
  pageChangeLine,
  pageUpdatedLine,
  type AgentMessage,
  type ConversationPage as Page,
  type PageVersion,
} from '@shipstudio/companion-protocol';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { pageVersion, pinPage, setFolded, useConversationPage } from '../lib/page';
import { iconSize, PRESSED, radius, space } from '../lib/theme';
import { Blocks } from './blocks/Blocks';
import { Icon, IconButton, T } from './ui';

/** The most of the screen the open page takes before it scrolls. */
const BAND = 0.42;

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
  const { page, folded } = useConversationPage(agentId, conversation, turn);
  if (!page || !page.pinned || !conversation) return null;
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${pageUpdatedLine(page, now)}. What changed`}
          onPress={() => {
            haptic.select();
            setHistory(!history);
            if (folded) setFolded(page.agentId, page.conversation, false);
          }}
          style={({ pressed }) => pressed && PRESSED}
          testID="page-when"
        >
          <T variant="caption" color={colors.textMuted}>
            {pageUpdatedLine(page, now)}
          </T>
        </Pressable>
        <IconButton
          name="pin.slash"
          label="Unpin the page"
          onPress={unpin}
          size={iconSize.inline}
        />
      </View>
      {!folded && (
        <ScrollView style={{ maxHeight: height * BAND }} nestedScrollEnabled>
          {history && (
            <View style={styles.history} testID="page-history">
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
                    {`v${h.version} · ${pageAgo(h.at, now)}${h.byRoutine ? ' · by a routine' : ''}`}
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
                {`v${older.version}, as it was ${pageAgo(older.at, now)}. Back to v${page.version}`}
              </T>
            </Pressable>
          )}
          {set ? (
            <Blocks message={message} set={set} />
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
